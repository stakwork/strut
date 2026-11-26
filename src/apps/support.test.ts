import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { z } from "zod";

import { createStrut, type Strut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { FileRunStore, MemoryRunStore } from "../store.js";
import { appIdentity, signInTicket } from "../auth.js";
import { defineStep, type AppRef, type StepContext } from "../core.js";
import { createRegistry } from "../steps/registry.js";
import { kitForTests } from "../test-util/app-kit.js";
import { publicAppToken, setEnv, sphinxSignIn, stepCall, type Fetch } from "../test-util/public-door.js";
import { STEP_RUN_TOOL } from "./tools.js";
import { WORKERS_APP } from "./workers-seed.js";
import { TASKS_APP } from "./tasks-seed.js";
import { DROPPED_SUPPORT_TABLES, tasksPath } from "../tasks/tasks.js";
import { sphinxCapability } from "../payments/sphinx-dm.js";
import { payoutLine } from "../steps/lib/support/_shared.js";
import { batchWithActor, withActor } from "../steps/lib/sqlite/_shared.js";
import { COUNTS_SQL, CONVERSATION_SQL, LIST_SQL, PAYOUT_LINES_SQL, TAKE_SQL, THREAD_SQL, WELCOME_SQL } from "./workers/src/lib/support.js";
import { startFakeSphinxDaemon, type FakeSphinxDaemon } from "../../scripts/fake-sphinx-daemon.js";

/**
 * SUPPORT AS AN APP (plans/people-and-hosts.md §4, §5): the stand-in daemon
 * pushes each DM record to a real strut over HTTP — `support/receive` on
 * strut/workers's `hosts:` — and the admin's page reads Support's tables with
 * SQL, writes its own columns, and sends through the `support/*` tools.
 * The `sphinx` capability is on an admin page's bag and on a run strut/workers
 * launched (`support-outbox`), and on nothing else.
 */

const KEY = "support-app-key";
const HOST = "support-app-host";
const MESSAGE = "support-app-message";
const json = { "content-type": "application/json" };
const quiet = { serveUi: false, enableChat: false, enableMcp: true, scheduler: false, autoResume: false, wakeDelayMs: 0 } as const;
/** strut/views stays: strut/workers imports its TaskForm. */
const seedsOff = { jamie: false, knowledge: false, earnings: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false } as const;

const key = (n: number) => `0${2 + (n % 2)}${n.toString(16).padStart(2, "0").repeat(32)}`;
const ADA = key(0xa1);
const BO = key(0xb2);
const actorOf = (pubkey: string) => `secp:${pubkey.slice(2)}`;
/** A 1×1 JPEG's first bytes: what the daemon checks a picture by. */
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex").toString("base64");

/** What a run's bag holds: whether it can send as Support. */
const probe = defineStep({
  type: "test/bag",
  input: z.object({}),
  output: z.any(),
  run: async (_cfg, ctx?: StepContext) => ({ sphinx: !!(ctx?.services as Record<string, unknown> | undefined)?.["sphinx"], app: ctx?.app?.name ?? null }),
});

const until = async <T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("Support as an app (plans/people-and-hosts.md §5)", () => {
  let root: string;
  let strut: Strut;
  let server: ServerType;
  let daemon: FakeSphinxDaemon;
  let restoreEnv: () => void;
  let admin: string;
  let other: string;
  const store = new MemoryRunStore();

  before(async () => {
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_HOST_KEYS: `sphinx:${HOST}`, LIGHTNING_DAEMON_URL: undefined, LIGHTNING_DAEMON_TOKEN: undefined, LIGHTNING_DAEMON_PAY_TOKEN: undefined, LIGHTNING_DAEMON_MESSAGE_TOKEN: undefined, LIGHTNING_NWC_URL: undefined });
    root = await mkdtemp(join(tmpdir(), "strut-support-app-"));
    strut = await createStrut({
      ...quiet,
      ...seedsOff,
      workspace: new WorkspaceManager(join(root, "ws")),
      store,
      kit: await kitForTests(),
      registry: await createRegistry([probe]),
      payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }) },
    });
    const url = await new Promise<string>((ok) => {
      server = serve({ fetch: strut.app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => ok(`http://127.0.0.1:${info.port}`));
    });
    daemon = await startFakeSphinxDaemon({ port: 0, token: "support-receive", payToken: "support-pay", messageToken: MESSAGE, settleAfterMs: 0, strutUrl: url, strutHostKey: HOST, pushRetryMs: 50 });
    const wallet = await strut.app.request("/earnings/wallet", { method: "PUT", headers: { authorization: `Bearer ${KEY}`, ...json }, body: JSON.stringify({ provider: "sphinx", url: daemon.url, token: "support-receive", messageToken: MESSAGE }) });
    assert.equal(wallet.status, 200, await wallet.text());
    admin = await signIn("ada-admin");
    other = await signIn("bo-admin");
  });
  after(async () => {
    await daemon?.close();
    server?.close();
    await strut?.close?.().catch(() => {});
    restoreEnv?.();
    await rm(root, { recursive: true, force: true });
  });

  const signIn = async (actor: string) => {
    const res = await strut.app.request("/auth/session", { method: "POST", headers: json, body: JSON.stringify({ ticket: signInTicket(actor, "admin")!.ticket }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  /** strut/workers's page shown to an admin: `{ result }` or `{ error }`. */
  const page = async (type: string, config: Record<string, unknown> = {}, cookie = admin): Promise<{ result?: any; error?: string }> => {
    const res = await strut.app.request("/mcp", {
      method: "POST",
      headers: { "x-strut-ui": "1", cookie, ...json, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app: appIdentity(WORKERS_APP, "v1") } } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(line ? line.slice(6) : text) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
    const value = JSON.parse(msg.result!.content[0]!.text);
    return msg.result!.isError ? { error: value.error ?? JSON.stringify(value) } : { result: value.result ?? value };
  };
  const rows = async (sql: string, params?: Record<string, unknown>, cookie = admin): Promise<any[]> => {
    const r = await page("sqlite/query", { sql, ...(params ? { params } : {}) }, cookie);
    assert.equal(r.error, undefined, r.error);
    return r.result.rows;
  };
  const thread = (pubkey: string) => rows(THREAD_SQL, { pubkey, limit: 500 }).then((r) => r.reverse());
  /** The daemon's call of `support/receive`, as one account. */
  const host = async (records: unknown[], account: string, type = "support/receive") => {
    const res = await strut.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${HOST}`, "x-strut-account": `sphinx:${account}`, ...json, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { app: WORKERS_APP, type, config: { records } } } }),
    });
    const body = (await res.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
    return { status: res.status, value: JSON.parse(body.result?.content[0]?.text ?? "null") };
  };
  const worker = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${daemon.url}${path}`, { method: "POST", headers: json, body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
    const out = (await res.json()) as Record<string, unknown>;
    await daemon.drained();
    return out;
  };
  const feed = async () => ((await (await fetch(`${daemon.url}/dms`, { headers: { authorization: `Bearer ${MESSAGE}` } })).json()) as { dms: Array<Record<string, any>> }).dms;

  it("a worker's message and file reach Support through the daemon's push, the channel says so, and the sender's name is theirs", async () => {
    await worker("/worker-dm", { pubkey: ADA, alias: "Ada", text: "hello, Support" });
    const [c] = await rows(CONVERSATION_SQL, { worker: actorOf(ADA) });
    assert.equal(c.pubkey, ADA);
    assert.equal(c.unread, 1, "her message, not her key exchange");
    assert.deepEqual((await thread(ADA)).map((m) => [m.kind, m.from_me, m.text]), [["contact", 0, null], ["message", 0, "hello, Support"]]);
    assert.equal(await strut.people.nameOf(actorOf(ADA)), "Ada", "x-strut-account-name: the name is hers, kept by the people store");
    // The page reads again on the app's channel.
    const said = await strut.services.channels!.read({ name: WORKERS_APP, version: "v1" }, "support");
    assert.ok(said.messages.some((m) => m.from.code === "support/receive"), JSON.stringify(said.messages));
    // Her key exchange also says `invites`: the daemon marked the invite used before pushing it.
    assert.ok(said.messages.some((m) => m.key === "invites"), "a new contact says invites");

    // A file comes with its bytes, kept in the app's database, read in 3 MB pieces.
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 7);
    await worker("/worker-dm", { pubkey: ADA, file: { name: "scan.pdf", type: "application/pdf", base64: big.toString("base64") } });
    const file = (await thread(ADA)).at(-1);
    assert.deepEqual([file.kind, file.file_name, file.file_size, file.file_state], ["file", "scan.pdf", big.byteLength, "kept"]);
    const first = await page("support/file", { key: file.key });
    assert.equal(first.error, undefined, first.error);
    assert.equal(first.result.next, 3 * 1024 * 1024);
    const second = await page("support/file", { key: file.key, offset: first.result.next });
    assert.ok(Buffer.from(first.result.base64 + second.result.base64, "base64").equals(big));
    // Over 25 MiB: a line saying so, no bytes.
    await worker("/worker-dm", { pubkey: ADA, file: { name: "film.mov", type: "video/quicktime", base64: "AAAA", size: 26 * 1024 * 1024 } });
    assert.equal((await thread(ADA)).at(-1).file_state, "too_large");
  });

  it("an ordinary text DM from a known contact says changed, not invites", async () => {
    const bob = "02" + "b0".repeat(32);
    const at = (key: string) => strut.services.channels!.read({ name: WORKERS_APP, version: "v1" }, "support").then((r) => r.messages.filter((m) => m.key === key).length);
    await host([{ seq: 1, id: "bob-contact", time: "2030-01-01T00:00:00Z", fromMe: false, peer: { pubkey: bob }, kind: "contact" }], bob);
    const before = await at("invites");
    assert.ok(before > 0);
    const chat = await host([{ seq: 2, id: "bob-hi", time: "2030-01-01T00:01:00Z", fromMe: false, peer: { pubkey: bob }, kind: "message", text: "hi" }], bob);
    assert.equal(chat.value.kept, 1);
    assert.equal(await at("invites"), before, "no new invites message for a text DM");
  });

  it("a record kept before changes nothing; another contact's record in the call is skipped, not the call", async () => {
    const before = (await thread(ADA)).length;
    const record = (await feed()).find((d) => d.text === "hello, Support")!;
    const again = await host([record], ADA);
    assert.equal(again.status, 200);
    assert.equal((await thread(ADA)).length, before, "a retry keeps nothing new");
    const theirs = await host([{ ...record, id: "elsewhere", peer: { ...record.peer, pubkey: BO } }], ADA);
    assert.equal(theirs.status, 200);
    assert.equal(theirs.value.kept, 0);
    assert.match(theirs.value.skipped[0].error, /one contact's records a call/);
    // The host may call support/receive alone: never a send.
    const send = await host([], ADA, "support/send");
    assert.equal(send.status, 403);
  });

  it("a reply reaches the daemon and its status comes back; a failed one is sent again under its id", async () => {
    const sent = await page("support/send", { worker: actorOf(ADA), text: "Hi Ada, we're on it" });
    assert.equal(sent.error, undefined, sent.error);
    assert.equal(sent.result.message.status, "sent");
    const out = (await feed()).find((d) => d.fromMe && d.text === "Hi Ada, we're on it")!;
    assert.ok(out?.clientId, "the daemon got it, under strut's id");
    await daemon.drained();
    const kept = (await thread(ADA)).filter((m) => m.text === "Hi Ada, we're on it");
    assert.equal(kept.length, 1, "its record came back onto the same row");
    assert.deepEqual([kept[0].id, kept[0].status, kept[0].by], [out.id, "sent", "ada-admin"]);

    // Still with the LSP: sending, then sent when the daemon says so.
    await fetch(`${daemon.url}/next-dm`, { method: "POST", headers: json, body: JSON.stringify({ state: "pending" }) });
    const pending = await page("support/send", { worker: actorOf(ADA), text: "one moment", replyTo: out.id });
    assert.equal(pending.result.message.status, "sending");
    const clientId = (await feed()).find((d) => d.text === "one moment")!.clientId;
    await fetch(`${daemon.url}/settle/${clientId}`, { method: "POST" });
    await daemon.drained();
    const settled = (await thread(ADA)).find((m) => m.text === "one moment");
    assert.deepEqual([settled.status, settled.reply_to], ["sent", out.id]);

    // Failed: Retry sends it again, and the daemon sends one id once.
    await fetch(`${daemon.url}/next-dm`, { method: "POST", headers: json, body: JSON.stringify({ state: "failed" }) });
    const failed = await page("support/send", { worker: actorOf(ADA), text: "did it go?" });
    assert.equal(failed.result.message.status, "failed");
    const retried = await page("support/send", { worker: actorOf(ADA), retry: failed.result.message.key });
    assert.equal(retried.result.message.status, "sent");
    assert.equal((await feed()).filter((d) => d.text === "did it go?").length, 1);

    // A staff file goes with its bytes, and Support keeps its copy.
    const photo = await page("support/send", { worker: actorOf(ADA), text: "the map", file: { base64: JPEG, type: "image/jpeg", name: "map.jpg" } });
    assert.equal(photo.result.message.status, "sent");
    assert.equal((await page("support/file", { key: photo.result.message.key })).result.base64, JPEG);
    // Nobody Support has not met.
    assert.match((await page("support/send", { worker: actorOf(BO), text: "hi" })).error ?? "", /^no_conversation: /);
  });

  it("the welcome: none until an admin saves one, then each new contact once; an older contact and a cleared welcome get none", async () => {
    await worker("/worker-contact", { pubkey: BO, alias: "Bo" });
    assert.equal((await thread(BO)).filter((m) => m.from_me).length, 0, "no welcome saved yet");
    const saved = await page("sqlite/exec", { sql: WELCOME_SQL, params: { welcome: "Welcome! This is Support." } });
    assert.equal(saved.error, undefined, saved.error);
    const [s1] = await rows("SELECT welcome_since FROM settings");
    assert.ok(s1.welcome_since > 0, "the save turned it on");

    const cy = key(0xc3);
    await worker("/worker-contact", { pubkey: cy, alias: "Cy" });
    const welcome = await until("Cy's welcome", async () => (await thread(cy)).find((m) => m.from_me && m.by === "welcome" && m.status === "sent"));
    assert.equal(welcome.text, "Welcome! This is Support.");
    assert.ok((await rows(CONVERSATION_SQL, { worker: actorOf(cy) }))[0].welcomed_at > 0);
    // The outbox ran for strut/workers, and could send: its bag carries `sphinx`.
    const runs = await store.listRuns("support-outbox");
    assert.ok(runs.length >= 1);
    // Her contact record again (a retry), and Bo writing now: no second welcome, none for Bo.
    await host([(await feed()).find((d) => d.kind === "contact" && d.peer.pubkey === cy)!], cy);
    await worker("/worker-dm", { pubkey: BO, text: "hi" });
    await daemon.drained();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await thread(cy)).filter((m) => m.by === "welcome").length, 1, "each worker at most once");
    assert.equal((await thread(BO)).filter((m) => m.from_me).length, 0, "Bo was a contact before the save (ruling 8)");
    // A key exchange dated before the save is the backlog: none.
    const old = key(0xd4);
    await host([{ seq: 1, id: "old-contact", time: "2020-01-01T00:00:00Z", fromMe: false, peer: { pubkey: old }, kind: "contact" }], old);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await rows(CONVERSATION_SQL, { worker: actorOf(old) }))[0].welcome_due ?? 0, 0);
    assert.equal((await thread(old)).filter((m) => m.from_me).length, 0);

    // Saving again keeps when it was turned on; clearing turns it off.
    await page("sqlite/exec", { sql: WELCOME_SQL, params: { welcome: "Welcome, again." } });
    assert.equal((await rows("SELECT welcome_since FROM settings"))[0].welcome_since, s1.welcome_since);
    await page("sqlite/exec", { sql: WELCOME_SQL, params: { welcome: "" } });
    assert.equal((await rows("SELECT welcome_since FROM settings"))[0].welcome_since, null);
    const ed = key(0xe5);
    await worker("/worker-contact", { pubkey: ed });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await thread(ed)).filter((m) => m.from_me).length, 0);
  });

  it("a worker's first time in Tasks, signed in with Peel: the welcome goes to their address, met there, once; none for a contact, none with no welcome", async () => {
    const req: Fetch = (path, init) => strut.app.request(path, init);
    const view = await strut.app.request("/public-view", { method: "PUT", headers: { authorization: `Bearer ${KEY}`, ...json }, body: JSON.stringify({ apps: [{ name: TASKS_APP }], visitors: { signIn: ["sphinx"] } }) });
    assert.equal(view.status, 200, await view.text());
    const tasks = await publicAppToken(req, TASKS_APP);
    const me = async (token: string) => {
      const r = await stepCall(req, "/public/mcp", "task/me", {}, { authorization: `Bearer ${token}` }, tasks);
      assert.equal(r.error, undefined, r.error);
      return r.result!;
    };
    const keyOf = (address: string) => address.split("_")[0]!;
    const settle = () => new Promise((r) => setTimeout(r, 300));

    // Fay is Support's contact from before the welcome was saved (the welcome test cleared it).
    const fay = await sphinxSignIn(req);
    await worker("/worker-contact", { pubkey: keyOf(fay.address), alias: "Fay" });
    assert.equal((await page("sqlite/exec", { sql: WELCOME_SQL, params: { welcome: "Welcome! This is Support." } })).error, undefined);

    // Dee already had Peel: her invite was ignored, so Support never met her.
    const dee = await sphinxSignIn(req);
    const deeKey = keyOf(dee.address);
    assert.equal((await me(dee.token))["status"], "new");
    const welcome = await until("Dee's welcome", async () => (await thread(deeKey)).find((m) => m.by === "welcome" && m.status === "sent"));
    assert.equal(welcome.text, "Welcome! This is Support.");
    assert.ok((await rows(CONVERSATION_SQL, { worker: dee.actor }))[0].welcomed_at > 0);
    assert.ok((await feed()).some((d) => d.fromMe && d.peer.pubkey === deeKey && d.status === "sent"), "the daemon met her at her address and sent it");
    // Her next visit, and her contact's key exchange arriving after: no second welcome.
    await me(dee.token);
    await worker("/worker-contact", { pubkey: deeKey, alias: "Dee" });
    await settle();
    assert.equal((await thread(deeKey)).filter((m) => m.by === "welcome").length, 1, "each worker at most once");

    // Fay's first time in Tasks: Support has her already (ruling 8), so none.
    await me(fay.token);
    await settle();
    assert.equal((await thread(keyOf(fay.address))).filter((m) => m.from_me).length, 0);

    // No welcome saved: nothing goes.
    await page("sqlite/exec", { sql: WELCOME_SQL, params: { welcome: "" } });
    const eve = await sphinxSignIn(req);
    await me(eve.token);
    await settle();
    assert.equal((await thread(keyOf(eve.address))).length, 0);
  });

  it("delete takes one of Support's messages back on both sides; Support's picture goes through the daemon", async () => {
    const m = await page("support/send", { worker: actorOf(ADA), text: "oops" });
    const gone = await page("support/delete", { key: m.result.message.key });
    assert.equal(gone.error, undefined, gone.error);
    assert.equal(gone.result.message.deleted, 1);
    assert.equal((await feed()).find((d) => d.id === m.result.message.id)?.deleted, true, "the daemon deleted it");
    const hers = (await thread(ADA)).find((x) => !x.from_me && x.kind === "message");
    assert.match((await page("support/delete", { key: hers.key })).error ?? "", /^unknown_message: /, "only Support's own");

    const set = await page("support/set-photo", { photo: { base64: JPEG, type: "image/jpeg" } });
    assert.equal(set.error, undefined, set.error);
    assert.match(set.result.url, /^https:\/\/memes\./);
    const [s] = await rows("SELECT photo, photo_type, photo_url FROM settings");
    assert.deepEqual([s.photo.base64, s.photo_type, s.photo_url], [JPEG, "image/jpeg", set.result.url]);
    assert.equal(((await (await fetch(`${daemon.url}/worker-photo`)).json()) as { img: string }).img, set.result.url);
    await page("support/set-photo", { photo: null });
    assert.equal((await rows("SELECT photo_url FROM settings"))[0].photo_url, null);
  });

  it("the page's own columns: seen, done and taken, with :actor its viewer; the list and the tab's count", async () => {
    const before = (await rows(COUNTS_SQL))[0];
    assert.ok(before.unread > 0 && before.conversations >= 4);
    assert.equal((await page("sqlite/exec", { sql: TAKE_SQL, params: { pubkey: ADA } })).error, undefined);
    assert.equal((await rows(CONVERSATION_SQL, { worker: actorOf(ADA) }))[0].assigned, "me");
    assert.equal((await rows(CONVERSATION_SQL, { worker: actorOf(ADA) }, other))[0].assigned, "other", "another admin sees it taken");
    assert.deepEqual((await rows(LIST_SQL, { filter: "mine" })).map((r) => r.pubkey), [ADA]);
    assert.ok(!(await rows(LIST_SQL, { filter: "unassigned" })).some((r) => r.pubkey === ADA));
    await page("sqlite/exec", { sql: "UPDATE conversations SET status = :status WHERE pubkey = :pubkey", params: { status: "done", pubkey: ADA } });
    assert.ok((await rows(LIST_SQL, { filter: "done" })).some((r) => r.pubkey === ADA));
    // A worker writing again reopens it.
    await worker("/worker-dm", { pubkey: ADA, text: "one more thing" });
    assert.equal((await rows(CONVERSATION_SQL, { worker: actorOf(ADA) }))[0].status, "open");
    // Payout lines are the page's to switch.
    await page("sqlite/exec", { sql: PAYOUT_LINES_SQL, params: { on: false } });
    assert.equal((await rows("SELECT payout_lines FROM settings"))[0].payout_lines, 0);
    await page("sqlite/exec", { sql: PAYOUT_LINES_SQL, params: { on: true } });
    // `:actor` is strut's to bind; a statement naming it takes its values by name.
    assert.deepEqual(withActor("SELECT :actor AS me", undefined, "ada"), { actor: "ada" });
    assert.deepEqual(withActor("SELECT ':actor' AS literal", { x: 1 }, "ada"), { x: 1 }, "not in a string");
    assert.deepEqual(withActor("SELECT :actor", { actor: "forged" }, "ada"), { actor: "ada" });
    assert.throws(() => withActor("SELECT :actor, ?", [1], "ada"), /by name/);
    assert.deepEqual(batchWithActor(["SELECT 1", { sql: "SELECT $actor" }], undefined), ["SELECT 1", { sql: "SELECT $actor", params: { actor: null } }]);
  });

  it("a settled payout's line goes to a worker who is Support's contact, once, while payout lines are on", async () => {
    const db = await strut.services.appDb!.open(WORKERS_APP);
    const sphinx = sphinxCapability({ daemon: async () => ({ url: daemon.url, token: MESSAGE }) });
    await payoutLine(db, sphinx, { key: "payout-1", worker: actorOf(ADA), msat: 1_200_000 });
    await payoutLine(db, sphinx, { key: "payout-1", worker: actorOf(ADA), msat: 1_200_000 });
    const lines = (await thread(ADA)).filter((m) => m.by === "payout");
    assert.deepEqual(lines.map((m) => [m.text, m.status]), [["Paid you 1,200 sats", "sent"]]);
    await payoutLine(db, sphinx, { key: "payout-2", worker: "secp:nobody", msat: 1000 });
    db.prepare("UPDATE settings SET payout_lines = 0").run();
    await payoutLine(db, sphinx, { key: "payout-3", worker: actorOf(ADA), msat: 5000 });
    db.prepare("UPDATE settings SET payout_lines = 1").run();
    assert.equal((await thread(ADA)).filter((m) => m.by === "payout").length, 1);
  });

  it("the sphinx capability: on an admin's page and on a run strut/workers launched; never on the shared bag or another app's run", async () => {
    assert.equal((strut.services as Record<string, unknown>)["sphinx"], undefined, "the shared bag");
    await strut.workspace.publishWorkflowByContent("bag-probe", "name: bag-probe\nsteps:\n  - id: probe\n    type: test/bag\n");
    const ranFor = async (app?: AppRef) => {
      const { runId } = await strut.services.runs!.launch({ workflow: "bag-probe" }, app ? { app } : {});
      const s = await until("the probe's run", async () => {
        const sum = await store.getRunSummary("bag-probe", runId);
        return sum?.status === "success" ? sum : undefined;
      });
      return s.output as { sphinx: boolean };
    };
    assert.equal((await ranFor({ name: WORKERS_APP, version: "v1" })).sphinx, true, "strut/workers's run (support-outbox's place)");
    assert.equal((await ranFor({ name: "strut/views", version: "v1" })).sphinx, false, "strut's own app that is not an admin's");
    assert.equal((await ranFor()).sphinx, false, "a run of no app: a workflow, an agent's tools");
  });
});

describe("Support as first built is dropped at boot, with no copy (ruling 7)", () => {
  it("drops its three tables from the task store's file and deletes <dataDir>/support/", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-support-drop-"));
    const dataDir = join(root, "data");
    try {
      const file = tasksPath(dataDir);
      await mkdir(join(dataDir, "tasks"), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(file);
      for (const t of DROPPED_SUPPORT_TABLES) db.exec(`CREATE TABLE ${t} (x TEXT)`);
      db.close();
      await mkdir(join(dataDir, "support", "files"), { recursive: true });
      await writeFile(join(dataDir, "support", "files", "abc"), "a worker's photo");
      const strut = await createStrut({ ...quiet, ...seedsOff, views: false, workersApp: false, workspace: new WorkspaceManager(join(root, "ws")), store: new FileRunStore(join(root, "runs")), dataDir });
      try {
        await until("<dataDir>/support/ removed", async () => !existsSync(join(dataDir, "support")));
        // The task store opens the file at boot (its sweep); the tables go then.
        await until("the tables dropped", async () => {
          const check = new DatabaseSync(file, { readOnly: true });
          try {
            const left = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'support_%'").all();
            return left.length === 0;
          } finally {
            check.close();
          }
        });
        assert.ok((await readFile(file)).byteLength > 0, "the task store's file stays");
      } finally {
        await strut.close?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
