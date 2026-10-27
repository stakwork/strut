/**
 * A fleet fed by its central strut (plans/marketplace.md §12.1) — two struts
 * over real HTTP: the CENTRAL publishes a package to a channel and mints a
 * read token; the CHILD subscribes to its key, applies each release through
 * the distro's door, keeps its own forks, and hears the central's ping.
 * Both run behind an API key, so only the token opens the central's
 * catalog to the child, and the ping comes in on the peer key.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import type { SubscriptionInfo } from "./subscriptions.js";

const KEY = "fleet-api-key";
const PEER_KEY = "fleet-peer-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

const STEP = (out: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: "acme/linear/fetch", input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;
const FLOW = (name: string, description = "Fetch the issues") => `name: ${name}\ndescription: ${description}\nsteps:\n  - { id: s, type: acme/linear/fetch }\n`;

const boot = (ws: WorkspaceManager, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace: ws,
    store: new MemoryRunStore(),
    serveUi: false,
    scheduler: false,
    enableChat: false,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false,
    job: false,
    orchestrator: false,
    builder: false,
    views: false,
    concepts: false,
    stt: false,
    subscriptionPoll: false,
    ...extra,
  });

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_PEER_KEY"] = PEER_KEY;
  process.env["STRUT_SECRET_KEY"] = "fleet-secret";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("a fleet fed by its central strut", () => {
  let root: string;
  let central: Strut;
  let child: Strut;
  let centralWs: WorkspaceManager;
  let childWs: WorkspaceManager;
  let centralUrl: string;
  let key: string;
  let token: string;

  const publish = async (version: string, channel?: string) => {
    const res = await central.app.request("/packages/publish", json({ package: "acme/linear", version, workflows: ["acme/linear/sync", "acme/linear/report"], ...(channel ? { channel } : {}) }));
    const body = (await res.json()) as { digest: string; catalog: { seq: number }; error?: string };
    assert.equal(res.status, 201, JSON.stringify(body));
    return body;
  };
  const moveChannel = async (channel: string, digest: string | null) => {
    const res = await central.app.request(`/packages/channels/${channel}`, json({ package: "acme/linear", digest }, "PUT"));
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { catalog: { seq: number } }).catalog.seq;
  };
  const subscribe = (body: Record<string, unknown>) => child.app.request("/packages/subscriptions/acme", json(body, "PUT"));
  const state = async (): Promise<SubscriptionInfo> => {
    const res = await child.app.request("/packages/subscriptions", { headers: auth });
    return ((await res.json()) as { subscriptions: SubscriptionInfo[] }).subscriptions[0]!;
  };
  /** The ping is detached: wait for the child to reach `seq`. */
  const reached = async (seq: number) => {
    for (let i = 0; i < 100; i++) {
      const s = await state();
      if (s.applied?.seq === seq || (s.error && s.accepted?.seq === seq)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`the child never applied seq ${seq}: ${JSON.stringify(await state())}`);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-fleet-"));
    centralWs = new WorkspaceManager(join(root, "central"));
    childWs = new WorkspaceManager(join(root, "child"));
    child = await boot(childWs);
    const childUrl = `http://127.0.0.1:${await child.listen(0, "127.0.0.1")}`;
    // The central knows the child as a peer (hive's cron), and pings it.
    central = await boot(centralWs, { peers: [{ id: "child", baseUrl: childUrl, token: PEER_KEY }] });
    centralUrl = `http://127.0.0.1:${await central.listen(0, "127.0.0.1")}`;

    await centralWs.publishStep("acme/linear/fetch", STEP("one"));
    await centralWs.publishWorkflow("acme/linear/sync", "v1", FLOW("acme/linear/sync"));
    await centralWs.publishWorkflow("acme/linear/report", "v1", FLOW("acme/linear/report"));
    const res = await central.app.request("/publisher/tokens", json({ subscriber: "child" }));
    assert.equal(res.status, 201, await res.clone().text());
    ({ key, token } = (await res.json()) as { key: string; token: string });
  });
  afterEach(async () => {
    await child.close();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });

  it("follows a channel: installs its release, keeps a fork, takes promotions, a rollback and a removal", async () => {
    const v1 = await publish("1.0.0", "stable");
    const put = await subscribe({ key, url: centralUrl, channel: "stable", token });
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal(((await put.json()) as { token: unknown }).token, true, "the token is never read back");

    // The PUT starts the first read; a sync after it finds the release in.
    const first = await child.subscriptions.sync("acme");
    assert.notEqual(first.status, "error", first.error);
    assert.equal((await child.run("acme/linear/sync", {})).output, "one");
    let s = await state();
    assert.deepEqual(s.applied?.packages, [{ package: "acme/linear", version: "1.0.0", digest: v1.digest }]);
    assert.deepEqual(s.packages, [{ package: "acme/linear", version: "1.0.0", digest: v1.digest, diverged: [] }]);
    assert.equal((await childWs.getWorkflowMetadata("acme/linear/sync"))!.versions["v1"]?.upstream?.source.ref, "subscription:acme");
    assert.equal((await child.subscriptions.sync("acme")).status, "current", "nothing new");

    // A fork on the child, then a release on canary: the child's channel did not move.
    await childWs.publishWorkflow("acme/linear/report", "v2", FLOW("acme/linear/report", "forked on the child"));
    await centralWs.publishStep("acme/linear/fetch", STEP("two"));
    const v2 = await publish("1.1.0", "canary");
    await reached(v2.catalog.seq);
    assert.equal((await child.run("acme/linear/sync", {})).output, "one");

    // Promoted to stable: the ping brings it in, the fork stays active.
    const promoted = await moveChannel("stable", v2.digest);
    s = await reached(promoted);
    assert.equal(s.error, undefined);
    assert.equal((await child.run("acme/linear/sync", {})).output, "two");
    assert.deepEqual(s.packages, [{ package: "acme/linear", version: "1.1.0", digest: v2.digest, diverged: ["acme/linear/report"] }]);
    assert.equal((await childWs.getWorkflowMetadata("acme/linear/report"))?.active, "v2");

    // Rolled back on the central: the child goes back too.
    s = await reached(await moveChannel("stable", v1.digest));
    assert.equal((await child.run("acme/linear/sync", {})).output, "one");
    assert.equal(s.applied?.packages[0]?.digest, v1.digest);

    // Out of the channel: uninstalled, the fork kept.
    s = await reached(await moveChannel("stable", null));
    assert.deepEqual(s.applied?.packages, []);
    assert.equal(await childWs.getWorkflowMetadata("acme/linear/sync"), null);
    assert.equal((await childWs.getWorkflowMetadata("acme/linear/report"))?.active, "v2", "a fork is kept");
  });

  it("reads the catalog only with the token, and the token opens nothing else on the central", async () => {
    const v1 = await publish("1.0.0", "stable");
    assert.equal((await fetch(`${centralUrl}/packages/catalog`)).status, 401);
    assert.equal((await fetch(`${centralUrl}/packages/catalog?t=${token}`)).status, 200);
    assert.equal((await fetch(`${centralUrl}/packages/catalog?t=strut-catalog.forged.x`)).status, 401);
    assert.equal((await fetch(`${centralUrl}/packages/acme/linear/archive?digest=${v1.digest}&t=${token}`)).status, 200);
    assert.equal((await fetch(`${centralUrl}/packages/acme/linear/archive?digest=sha256:${"0".repeat(64)}&t=${token}`)).status, 404);
    assert.equal((await fetch(`${centralUrl}/packages?t=${token}`)).status, 401, "not the installed list");
    assert.equal((await fetch(`${centralUrl}/workflows?t=${token}`)).status, 401, "not a workflow");
    assert.equal((await fetch(`${centralUrl}/workflows/acme%2Flinear%2Fsync/run?t=${token}`, { method: "POST" })).status, 401, "not a launch");

    // A subscription with no token is refused by the central, and says so.
    await subscribe({ key, url: centralUrl, channel: "stable" });
    const refused = await child.subscriptions.sync("acme");
    assert.equal(refused.status, "error");
    assert.match(refused.error!, /^subscription_refused: .* answered 401/);
    assert.equal((await state()).applied, undefined);
  });

  it("refuses a catalog sealed by another key, and an older one served after a newer", async () => {
    await publish("1.0.0", "stable");
    const oldCatalog = Buffer.from(await (await fetch(`${centralUrl}/packages/catalog?t=${token}`)).arrayBuffer());
    await subscribe({ key, url: centralUrl, channel: "stable", token });
    await centralWs.publishStep("acme/linear/fetch", STEP("two"));
    const v2 = await publish("1.1.0", "stable");
    assert.equal((await child.subscriptions.sync("acme")).status, "applied");
    assert.equal((await state()).applied?.seq, v2.catalog.seq);

    // A server that serves the older catalog — a stale mirror, a replay.
    const stale: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(oldCatalog);
    });
    await new Promise<void>((r) => stale.listen(0, "127.0.0.1", r));
    try {
      await subscribe({ key, url: `http://127.0.0.1:${(stale.address() as AddressInfo).port}`, channel: "stable", token });
      const rolled = await child.subscriptions.sync("acme");
      assert.equal(rolled.status, "error");
      assert.match(rolled.error!, /^catalog_rollback: /);
      assert.equal((await state()).applied?.seq, v2.catalog.seq, "the child stays on what it applied");
      assert.equal((await child.run("acme/linear/sync", {})).output, "two");

      // Subscribed to another key, the central's catalog is not its.
      await subscribe({ key: "y".repeat(52), url: centralUrl, channel: "stable", token });
      const other = await child.subscriptions.sync("acme");
      assert.match(other.error!, /^catalog_key: /);
    } finally {
      await new Promise<void>((r) => stale.close(() => r()));
    }
  });

  it("is the operator's to write: a peer may ping, never subscribe", async () => {
    const asPeer = { authorization: `Bearer ${PEER_KEY}`, "content-type": "application/json" };
    assert.equal((await child.app.request("/packages/subscriptions/sync", { method: "POST", headers: asPeer, body: "{}" })).status, 202);
    assert.equal((await child.app.request("/packages/subscriptions/acme", { method: "PUT", headers: asPeer, body: JSON.stringify({ key, url: centralUrl }) })).status, 403);
    assert.equal((await central.app.request("/publisher/tokens", { method: "POST", headers: asPeer, body: JSON.stringify({ subscriber: "x" }) })).status, 403);
    const bad = await subscribe({ key: "not-a-key", url: centralUrl });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /^subscription_invalid: key is the publisher's key/);
  });
});
