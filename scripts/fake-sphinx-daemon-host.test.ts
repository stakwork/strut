/**
 * The stand-in Sphinx daemon as strut's HOST (plans/jamie-in-tribes.md §3,
 * §5.1; plans/people-and-hosts.md §2): a person asks strut's own app for a
 * link code, DMs it to the daemon's account, and the daemon hands it to a
 * real strut over HTTP with its host key — the account is that person's from
 * then on, and a turn the daemon launches with it runs as them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createStrut } from "../src/createStrut.js";
import { MemoryRunStore } from "../src/store.js";
import { WorkspaceManager } from "../src/workspace.js";
import { RUN_STEP_FLOW } from "../src/run-step.js";
import type { Conversations } from "../src/conversations.js";
import { setEnv } from "../src/test-util/public-door.js";
import linkCode from "../src/steps/lib/account/link-code.js";
import { startFakeSphinxDaemon, type FakeSphinxDaemon } from "./fake-sphinx-daemon.js";

const KEY = "host-test-key";
const HOST = "host-test-sphinx";
const MESSAGE = "host-test-message";
const json = { "content-type": "application/json" };

describe("the stand-in Sphinx daemon as strut's host", () => {
  let dir: string;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let server: ServerType;
  let daemon: FakeSphinxDaemon;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-host-"));
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_HOST_KEYS: `sphinx:${HOST}`, LIGHTNING_DAEMON_URL: undefined, LIGHTNING_DAEMON_TOKEN: undefined, LIGHTNING_DAEMON_PAY_TOKEN: undefined, LIGHTNING_DAEMON_MESSAGE_TOKEN: undefined, LIGHTNING_NWC_URL: undefined });
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      autoResume: false,
      payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }) },
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    const url = await new Promise<string>((ok) => {
      server = serve({ fetch: strut.app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => ok(`http://127.0.0.1:${info.port}`));
    });
    daemon = await startFakeSphinxDaemon({ port: 0, token: "host-receive", payToken: "host-pay", messageToken: MESSAGE, settleAfterMs: 0, alias: "Acme Support", strutUrl: url, strutHostKey: HOST });
    const wallet = await strut.app.request("/earnings/wallet", { method: "PUT", headers: { authorization: `Bearer ${KEY}`, ...json }, body: JSON.stringify({ provider: "sphinx", url: daemon.url, token: "host-receive", messageToken: MESSAGE }) });
    assert.equal(wallet.status, 200, await wallet.text());
  });
  after(async () => {
    await daemon?.close();
    server?.close();
    await strut?.close?.().catch(() => {});
    restoreEnv?.();
    await rm(dir, { recursive: true, force: true });
  });

  it("GET /me opens to the message token alone: the account's address, key and alias", async () => {
    const me = (await (await fetch(`${daemon.url}/me`, { headers: { authorization: `Bearer ${MESSAGE}` } })).json()) as { address: string; pubkey: string; alias: string };
    assert.match(me.address, new RegExp(`^${me.pubkey}_0[23][0-9a-f]{64}_\\d+$`));
    assert.equal(me.alias, "Acme Support");
    assert.equal((await fetch(`${daemon.url}/me`, { headers: { authorization: "Bearer host-receive" } })).status, 403);
  });

  it("a code shown in strut's app, sent by DM, links the key that sent it; a turn with it then runs as the person", async () => {
    // The Connect panel's call: the code, and the account to send it to (the daemon's `GET /me`).
    const page = { services: strut.services, app: { name: "strut/jamie", version: "v1", firstParty: true }, actor: "ada-1", workflow: RUN_STEP_FLOW };
    const made = (await linkCode.run({}, page as never)) as { code: string; hosts: string[]; to?: { address: string; alias?: string } };
    assert.deepEqual(made.hosts, ["sphinx"]);
    const me = (await (await fetch(`${daemon.url}/me`, { headers: { authorization: `Bearer ${MESSAGE}` } })).json()) as { address: string };
    assert.deepEqual([made.to?.address, made.to?.alias], [me.address, "Acme Support"]);

    // Ada DMs the code from her Sphinx account.
    const ada = `02${"ab".repeat(32)}`;
    const dm = (text: string) => fetch(`${daemon.url}/worker-dm`, { method: "POST", headers: json, body: JSON.stringify({ pubkey: ada, alias: "Ada", text }) }).then((r) => r.json() as Promise<{ link?: { status: number; body: Record<string, unknown> } }>);
    const sent = await dm(`hi, here it is: ${made.code}`);
    assert.equal(sent.link?.status, 200, JSON.stringify(sent.link));
    assert.deepEqual([sent.link?.body["account"], sent.link?.body["actor"], sent.link?.body["name"]], [`sphinx:${ada}`, "ada-1", "Ada"]);
    // The host asks strut who the key is; the account answers the DM.
    const host = { authorization: `Bearer ${HOST}`, ...json };
    const link = (await (await strut.app.request(`/hosts/links/${ada}`, { headers: host })).json()) as { actor: string };
    assert.equal(link.actor, "ada-1");
    const feed = (await (await fetch(`${daemon.url}/dms`, { headers: { authorization: `Bearer ${MESSAGE}` } })).json()) as { dms: Array<{ fromMe: boolean; text: string | null }> };
    assert.equal(feed.dms.filter((d) => d.fromMe).at(-1)?.text, "Linked to your account on this server.");
    // Her name on the account is the one strut shows with none of her own.
    assert.equal(await strut.people.nameOf("ada-1"), "Ada");
    // A code works once.
    const again = await dm(made.code);
    assert.equal(again.link?.status, 404);

    // A turn the host launches with her account runs as her; an unlinked key's is refused.
    await strut.workspace.publishWorkflowByContent("tribe-turn", 'name: tribe-turn\nparams:\n  wake: "{{ ends }}"\nsteps:\n  - id: say\n    type: log\n    config:\n      message: "{{ input.prompt }}"\n');
    const launch = (account: string) =>
      strut.app.request("/workflows/tribe-turn/run", { method: "POST", headers: { ...host, "x-strut-account": account }, body: JSON.stringify({ input: { prompt: "Ada: @jamie hi", session: "host/sphinx/0123456789ab" }, wake: true }) });
    const ok = await launch(`sphinx:${ada}`);
    assert.equal(ok.status, 202, await ok.clone().text());
    const { runId } = (await ok.json()) as { runId: string };
    let start: { origin?: string; host?: string; actor?: string } | undefined;
    for (let i = 0; i < 200 && !start; i++) {
      const events = (await (await strut.app.request(`/workflows/tribe-turn/runs/${runId}/events`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as Array<{ type: string }>;
      start = events.find((e) => e.type === "run.start") as typeof start;
      if (!start) await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual([start?.origin, start?.host, start?.actor], ["host", "sphinx", "ada-1"]);
    const stranger = await launch(`sphinx:03${"cd".repeat(32)}`);
    assert.equal(stranger.status, 403);
    assert.match(((await stranger.json()) as { error: string }).error, /^not_linked: /);
    // The turn ends here, its end written to Ada's list: her row is the
    // last file the end writes. Left in flight, that write raced the temp
    // dir's removal after close (ENOTEMPTY on conversations/viewers).
    const conversations = (strut.services as { conversations: Conversations }).conversations;
    let row: { status?: string } | undefined;
    for (let i = 0; i < 500 && !row?.status; i++) {
      row = (await conversations.list({}, { actor: "ada-1" })).conversations.find((c) => c.id === "host/sphinx/0123456789ab");
      if (!row?.status) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(row?.status, "success");
  });
});
