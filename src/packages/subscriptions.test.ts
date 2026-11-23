/**
 * A fleet fed by its central strut (plans/marketplace.md §12.1) — two struts
 * over real HTTP: the CENTRAL publishes a package to a channel and mints a
 * read token; the CHILD subscribes to its key, applies each release through
 * the distro's door, keeps its own forks, and hears the central's ping.
 * Both run behind an API key, so only the token opens the central's
 * catalog to the child, and the ping comes in on the peer key.
 *
 * And a box following a git BRANCH (plans/followed-repos.md §1): a fixture
 * repository on disk (`file://`), its package under `#pkg`, moved by the
 * test's commits and synced by the host alone.
 *
 * And the secrets gate (§2), over both: a package whose required secret is
 * unset waits, with nothing of it here — on a graph, its Concept page
 * neither — and goes in, or out, at the next sync after the secret moves.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager, type WorkspaceStore } from "../workspace.js";
import type { SubscriptionInfo, SyncOutcome } from "./subscriptions.js";

const KEY = "fleet-api-key";
const PEER_KEY = "fleet-peer-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

const STEP = (out: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: "acme/linear/fetch", input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;
const FLOW = (name: string, description = "Fetch the issues") => `name: ${name}\ndescription: ${description}\nsteps:\n  - { id: s, type: acme/linear/fetch }\n`;

/** A step that reads a secret, so a package built with it requires that secret. */
const KEYED_STEP = (type: string, secret: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}), output: z.any(), async run(_cfg, ctx) { return (await ctx.services.secrets.get(${JSON.stringify(secret)})) ? "keyed" : "none"; } });\n`;
const setSecret = (strut: Strut, name: string, value: string | null) =>
  strut.app.request(`/secrets/${name}`, value === null ? { method: "DELETE", headers: auth } : json({ value }, "PUT"));

const boot = (ws: WorkspaceStore, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace: ws,
    store: new MemoryRunStore(),
    serveUi: false,
    scheduler: false,
    enableChat: false,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false, mediaWorkflows: false,
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

  it("holds back a package whose secret is unset, and what requires it; the rest of the channel goes in", async () => {
    // acme/linear's step reads LINEAR_KEY, so its release requires it;
    // acme/digest requires acme/linear; acme/notes needs nothing.
    const publishPkg = async (body: Record<string, unknown>) => {
      const res = await central.app.request("/packages/publish", json({ channel: "stable", ...body }));
      const out = (await res.json()) as { digest: string; manifest?: { requires?: unknown } };
      assert.equal(res.status, 201, JSON.stringify(out));
      return out;
    };
    await centralWs.publishStep("acme/linear/fetch", KEYED_STEP("acme/linear/fetch", "LINEAR_KEY"));
    const linear = await publish("1.0.0", "stable");
    await centralWs.publishWorkflow("acme/notes/daily", "v1", LOG("acme/notes/daily", "notes"));
    await publishPkg({ package: "acme/notes", version: "1.0.0", workflows: ["acme/notes/daily"] });
    await centralWs.publishWorkflow("acme/digest/weekly", "v1", FLOW("acme/digest/weekly"));
    await publishPkg({ package: "acme/digest", version: "1.0.0", workflows: ["acme/digest/weekly"], requires: { packages: [{ package: "acme/linear", digest: linear.digest }] } });
    const here = async () => ({
      linear: !!(await childWs.getWorkflowMetadata("acme/linear/sync")) && !!(await childWs.getStepMetadata("acme/linear/fetch")),
      digest: !!(await childWs.getWorkflowMetadata("acme/digest/weekly")),
      notes: !!(await childWs.getWorkflowMetadata("acme/notes/daily")),
    });

    // LINEAR_KEY unset: acme/linear waits, and acme/digest with it.
    await subscribe({ key, url: centralUrl, channel: "stable", token });
    let out = await child.subscriptions.sync("acme");
    assert.equal(out.status, "waiting", out.error);
    assert.deepEqual(out.waiting, { secrets: ["LINEAR_KEY"] });
    assert.deepEqual(await here(), { linear: false, digest: false, notes: true });
    let s = await state();
    assert.deepEqual(s.waiting, { secrets: ["LINEAR_KEY"] });
    assert.deepEqual(s.applied?.packages.map((p) => p.package), ["acme/notes"]);
    out = await child.subscriptions.sync("acme");
    assert.deepEqual([out.status, out.result], ["waiting", undefined], "nothing new: no install");

    // Set: the next sync brings them in, with no new release.
    assert.equal((await setSecret(child, "LINEAR_KEY", "lin_1")).status, 200);
    out = await child.subscriptions.sync("acme");
    assert.deepEqual([out.status, out.waiting], ["applied", undefined]);
    assert.deepEqual(await here(), { linear: true, digest: true, notes: true });
    assert.equal((await child.run("acme/digest/weekly", {})).output, "keyed");
    s = await state();
    assert.equal(s.waiting, undefined);
    assert.deepEqual(s.applied?.packages.map((p) => p.package).sort(), ["acme/digest", "acme/linear", "acme/notes"]);
    assert.equal((await child.subscriptions.sync("acme")).status, "current");

    // Edited here, then the secret removed: both out, the edit kept, acme/notes stays.
    await childWs.publishWorkflow("acme/linear/report", "v2", FLOW("acme/linear/report", "forked on the child"));
    assert.equal((await setSecret(child, "LINEAR_KEY", null)).status, 200);
    out = await child.subscriptions.sync("acme");
    assert.deepEqual([out.status, out.waiting], ["waiting", { secrets: ["LINEAR_KEY"] }]);
    assert.deepEqual(await here(), { linear: false, digest: false, notes: true });
    assert.equal((await childWs.getWorkflowMetadata("acme/linear/report"))?.active, "v2", "an edit is kept");
    s = await state();
    assert.deepEqual(s.applied?.packages.map((p) => p.package), ["acme/notes"]);
    assert.deepEqual(s.warnings, []);
  });
});

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const LOG = (name: string, message: string) => `name: ${name}\ndescription: Sync the pods\nsteps:\n  - id: say\n    type: log\n    config: { message: ${JSON.stringify(message)} }\n`;

describe("a box following a git branch", () => {
  let root: string;
  let repo: string;
  let ref: string;
  let ws: WorkspaceManager;
  let strut: Strut;

  /** Write `files` into the repository and commit them on `stable`. */
  const commit = async (message: string, files: Record<string, string>): Promise<string> => {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, rel)), { recursive: true });
      await writeFile(join(repo, rel), text);
    }
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  const release = (version: string, message: string) => commit(version, { "pkg/strut.yaml": `package: acme/pods\nversion: ${version}\n`, "pkg/workflows/sync.yaml": LOG("acme/pods/sync", message) });
  const subscribe = (body: Record<string, unknown>, id = "pods") => strut.app.request(`/packages/subscriptions/${id}`, json(body, "PUT"));
  const syncNow = async (id = "pods"): Promise<SyncOutcome> => {
    const res = await strut.app.request(`/packages/subscriptions/${id}/sync`, { method: "POST", headers: auth });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as SyncOutcome;
  };
  const state = async (): Promise<SubscriptionInfo> => {
    const res = await strut.app.request("/packages/subscriptions", { headers: auth });
    return ((await res.json()) as { subscriptions: SubscriptionInfo[] }).subscriptions.find((s) => s.id === "pods")!;
  };
  const active = async () => {
    const wf = await ws.getWorkflowMetadata("acme/pods/sync");
    return { version: wf?.active, commit: wf?.versions[wf.active]?.upstream?.commit, source: wf?.versions[wf.active]?.upstream?.source.ref, versions: Object.keys(wf?.versions ?? {}).length };
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-git-sub-"));
    repo = join(root, "stadeum");
    await mkdir(repo, { recursive: true });
    git(repo, "-c", "init.defaultBranch=main", "init", "--quiet");
    await commit("site", { "README.md": "# stadeum\n" });
    git(repo, "checkout", "--quiet", "-b", "stable");
    ref = `git+${pathToFileURL(repo).href}@stable#pkg`;
    ws = new WorkspaceManager(join(root, "box"));
    strut = await boot(ws);
  });
  afterEach(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
  });

  it("installs a push at the next sync and not before, skips a commit outside its folder, rolls back, and keeps an edit beside the release", async () => {
    const c1 = await release("0.1.0", "one");
    const put = await subscribe({ ref });
    assert.equal(put.status, 200, await put.clone().text());
    const info = (await put.json()) as SubscriptionInfo;
    // A file: repository takes no token: no secret serves it (src/git-hosts.ts).
    assert.deepEqual([info.ref, info.tokenSecret, info.token, info.key], [ref, undefined, undefined, undefined], "no secret's name, and never a token");

    // The PUT starts the first read; a sync after it finds the package in.
    await strut.subscriptions.sync("pods");
    let s = await state();
    assert.equal(s.error, undefined);
    assert.equal(s.applied?.commit, c1);
    assert.equal(s.applied?.seq, undefined, "a branch has no catalog seq");
    assert.deepEqual(s.packages, [{ package: "acme/pods", version: "0.1.0", digest: s.applied?.digest, diverged: [] }]);
    assert.deepEqual(await active(), { version: "v1", commit: c1, source: "subscription:pods", versions: 1 });
    assert.ok(s.checkedAt);

    // A push: nothing moves until the host syncs.
    const c2 = await release("0.2.0", "two");
    assert.equal((await state()).applied?.commit, c1);
    let out = await syncNow();
    assert.deepEqual([out.status, out.from, out.to], ["applied", c1, c2]);
    assert.equal(out.result?.packages[0]?.package, "acme/pods");
    s = await state();
    assert.deepEqual(s.packages.map((p) => p.version), ["0.2.0"]);
    assert.deepEqual(await active(), { version: "v2", commit: c2, source: "subscription:pods", versions: 2 });

    // A commit outside the package's folder: the commit is recorded, nothing installed.
    const c3 = await commit("site only", { "www/index.html": "<p>hi</p>\n" });
    out = await syncNow();
    assert.deepEqual([out.status, out.from, out.to, out.result], ["current", c2, c3, undefined]);
    s = await state();
    assert.equal(s.applied?.commit, c3);
    assert.equal((await active()).versions, 2);
    // An unmoved branch: current, read from nothing new.
    assert.deepEqual([(await syncNow()).status, (await syncNow()).from], ["current", c3]);

    // `stable` moved back: the older commit's package goes in.
    git(repo, "reset", "--quiet", "--hard", c1);
    out = await syncNow();
    assert.deepEqual([out.status, out.from, out.to], ["applied", c3, c1]);
    assert.deepEqual((await state()).packages.map((p) => p.version), ["0.1.0"]);
    assert.deepEqual(await active(), { version: "v1", commit: c1, source: "subscription:pods", versions: 2 });

    // Edited here, then a release: the edit stays active, the release beside it.
    await ws.publishWorkflow("acme/pods/sync", "v3", LOG("acme/pods/sync", "mine"));
    const c4 = await release("0.3.0", "three");
    out = await syncNow();
    assert.deepEqual([out.status, out.to], ["applied", c4]);
    s = await state();
    assert.deepEqual(s.packages, [{ package: "acme/pods", version: "0.3.0", digest: s.applied?.digest, diverged: ["acme/pods/sync"] }]);
    const wf = await ws.getWorkflowMetadata("acme/pods/sync");
    assert.equal(wf?.active, "v3", "the edit stays active");
    assert.equal(Object.values(wf?.versions ?? {}).filter((v) => v.upstream?.commit === c4).length, 1, "the release waits beside it");
  });

  it("keeps what is installed when the remote does not answer, and says why", async () => {
    const c1 = await release("0.1.0", "one");
    await subscribe({ ref });
    await strut.subscriptions.sync("pods");
    await release("0.2.0", "two");
    await rename(repo, `${repo}-gone`);
    const out = await syncNow();
    assert.equal(out.status, "error");
    assert.equal(out.from, c1);
    assert.match(out.error!, /^package_repo_(not_found|unreachable): /);
    let s = await state();
    assert.equal(s.error, out.error);
    assert.deepEqual([s.applied?.commit, s.packages.map((p) => p.version)], [c1, ["0.1.0"]]);
    assert.deepEqual(await active(), { version: "v1", commit: c1, source: "subscription:pods", versions: 1 });

    // Back: the next sync brings the push in and clears the error.
    await rename(`${repo}-gone`, repo);
    assert.equal((await syncNow()).status, "applied");
    s = await state();
    assert.equal(s.error, undefined);
    assert.deepEqual(s.packages.map((p) => p.version), ["0.2.0"]);
  });

  it("a peer's ping leaves it alone; the host's sync by id and the poll read it", async () => {
    const c1 = await release("0.1.0", "one");
    await subscribe({ ref });
    await strut.subscriptions.sync("pods");
    const checked = (await state()).checkedAt;
    const c2 = await release("0.2.0", "two");

    const asPeer = { authorization: `Bearer ${PEER_KEY}`, "content-type": "application/json" };
    assert.equal((await strut.app.request("/packages/subscriptions/sync", { method: "POST", headers: asPeer, body: "{}" })).status, 202);
    assert.deepEqual(await strut.subscriptions.syncAll({ git: false }), [], "the ping's set holds no git+ subscription");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual([(await state()).checkedAt, (await state()).applied?.commit], [checked, c1], "the ping read nothing");
    assert.equal((await strut.app.request("/packages/subscriptions/pods/sync", { method: "POST", headers: asPeer, body: "{}" })).status, 403, "a peer may not sync one by id");
    assert.equal((await strut.app.request("/packages/subscriptions/nope/sync", { method: "POST", headers: auth })).status, 404);

    // The poll reads every subscription, git+ ones included.
    const polled = await strut.subscriptions.syncAll();
    assert.deepEqual(polled.map((o) => [o.id, o.status, o.to]), [["pods", "applied", c2]]);
    const c3 = await release("0.3.0", "three");
    assert.deepEqual([(await syncNow()).status, (await state()).applied?.commit], ["applied", c3]);
  });

  it("takes a branch: refuses a commit at the PUT and a tag at the first sync; a changed ref starts over", async () => {
    const c1 = await release("0.1.0", "one");
    git(repo, "tag", "v1");
    const refused = async (body: Record<string, unknown>, re: RegExp) => {
      const res = await subscribe(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(((await res.json()) as { error: string }).error, re);
    };
    await refused({ ref: `git+${pathToFileURL(repo).href}@${c1}#pkg` }, /^subscription_invalid: ref .*names a commit, which does not move/);
    await refused({ ref, key: "y".repeat(52) }, /not both/);
    await refused({ ref, tokenSecret: "GITHUB_TOKEN" }, /^subscription_invalid: tokenSecret is gone: a git\+ ref is read with the run's token for its host/);
    await refused({ ref: "https://github.com/acme/pods" }, /^subscription_invalid: ref https:\/\/github.com\/acme\/pods: a git ref starts with git\+/);
    await refused({ ref: "git+https://github.com/acme/pods@" }, /nothing after @/);
    await refused({ ref: 3 }, /^subscription_invalid: ref is git\+https:/);

    // A tag names a commit that does not move: the first sync says so.
    assert.equal((await subscribe({ ref: `git+${pathToFileURL(repo).href}@v1#pkg` })).status, 200);
    const tag = await strut.subscriptions.sync("pods");
    assert.equal(tag.status, "error");
    assert.match(tag.error!, /^package_ref_not_found: .*no branch "v1" .*a subscription follows a branch, not a tag or a commit/);
    assert.equal(await ws.getWorkflowMetadata("acme/pods/sync"), null);

    // The branch, then the same again: the state stays.
    assert.equal((await subscribe({ ref })).status, 200);
    await strut.subscriptions.sync("pods");
    assert.equal((await state()).applied?.commit, c1);
    assert.equal((await subscribe({ ref })).status, 200);
    await strut.subscriptions.sync("pods");
    assert.equal((await state()).applied?.commit, c1);

    // Another ref under the same id: its state starts over.
    git(repo, "branch", "canary");
    const canary = ref.replace("@stable", "@canary");
    const moved = (await (await subscribe({ ref: canary })).json()) as SubscriptionInfo;
    assert.deepEqual([moved.ref, moved.applied], [canary, undefined]);
    await strut.subscriptions.sync("pods");
    assert.deepEqual([(await state()).applied?.ref, (await state()).applied?.commit], [canary, c1]);
  });
});

for (const tb of testBackends()) {
  describe(`a box following a git branch, gated on its secrets (${tb.name})`, { skip: tb.skip }, () => {
    let backend: GraphBackend;
    let root: string;
    let repo: string;
    let ws: GraphWorkspaceStore;
    let strut: Strut;

    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      await seedStrutDomain(backend);
      backend.schemas.invalidate();
    });
    after(async () => {
      await tb.close(backend);
    });
    beforeEach(async () => {
      await tb.clear(backend);
      root = await mkdtemp(join(tmpdir(), "strut-git-gate-"));
      repo = join(root, "stadeum");
      await mkdir(join(repo, "pkg", "workflows"), { recursive: true });
      await mkdir(join(repo, "pkg", "steps"), { recursive: true });
      await mkdir(join(repo, "pkg", "concepts"), { recursive: true });
      await writeFile(join(repo, "pkg", "strut.yaml"), "package: acme/pods\nversion: 0.1.0\nrequires:\n  secrets: [PODS_KEY]\n  optional: [GITHUB_TOKEN]\n");
      await writeFile(join(repo, "pkg", "steps", "claim.ts"), KEYED_STEP("acme/pods/claim", "PODS_KEY"));
      await writeFile(join(repo, "pkg", "workflows", "sync.yaml"), LOG("acme/pods/sync", "one"));
      await writeFile(join(repo, "pkg", "concepts", "Code Change.md"), "---\ndescription: Change a repository's code in a pod\n---\nYou can change code.\n");
      git(repo, "-c", "init.defaultBranch=stable", "init", "--quiet");
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "pods");
      ws = new GraphWorkspaceStore(backend, { materializeDir: join(root, "steps"), appsDir: join(root, "apps") });
      strut = await boot(ws, { dataDir: join(root, "data") });
    });
    afterEach(async () => {
      await strut.close();
      await rm(root, { recursive: true, force: true });
    });

    const page = async (name: string) =>
      ((await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns", name: "$name" })} WHERE ${backend.dialect.live("c")} RETURN ${backend.dialect.project("c", ["ref_id"])} AS p`, { ns: backend.namespace, name }))[0]?.["p"] as { ref_id: string } | undefined) !== undefined;
    const here = async () => ({
      step: !!(await ws.getStepMetadata("acme/pods/claim")),
      workflow: !!(await ws.getWorkflowMetadata("acme/pods/sync")),
      page: await page("Code Change"),
    });
    const state = async (): Promise<SubscriptionInfo> => (await strut.subscriptions.get("pods"))!;

    it("waits with nothing of the package here, goes in once the secret is set, and out (edits kept) once it is removed — with no new commit", async () => {
      const put = await strut.app.request("/packages/subscriptions/pods", json({ ref: `git+${pathToFileURL(repo).href}@stable#pkg` }, "PUT"));
      assert.equal(put.status, 200, await put.clone().text());
      const c1 = git(repo, "rev-parse", "HEAD");

      // PODS_KEY unset: nothing of it is here.
      let out = await strut.subscriptions.sync("pods");
      assert.deepEqual([out.status, out.to, out.waiting, out.result], ["waiting", c1, { secrets: ["PODS_KEY"] }, undefined], out.error);
      assert.deepEqual(await here(), { step: false, workflow: false, page: false });
      let s = await state();
      assert.deepEqual([s.waiting, s.applied?.commit, s.applied?.packages, s.packages], [{ secrets: ["PODS_KEY"] }, c1, [], []]);
      assert.equal((await strut.subscriptions.sync("pods")).status, "waiting");

      // Empty in strut's environment, as compose hands an unset setting: still no value.
      process.env["PODS_KEY"] = "";
      try {
        out = await strut.subscriptions.sync("pods");
        assert.deepEqual([out.status, out.waiting], ["waiting", { secrets: ["PODS_KEY"] }], out.error);
        assert.deepEqual(await here(), { step: false, workflow: false, page: false });
      } finally {
        delete process.env["PODS_KEY"];
      }

      // Set: the next sync installs it, at the same commit.
      assert.equal((await setSecret(strut, "PODS_KEY", "pk_1")).status, 200);
      out = await strut.subscriptions.sync("pods");
      assert.deepEqual([out.status, out.from, out.to, out.waiting], ["applied", c1, c1, undefined], out.error);
      assert.deepEqual(await here(), { step: true, workflow: true, page: true });
      s = await state();
      assert.equal(s.waiting, undefined);
      assert.deepEqual(s.applied?.packages.map((p) => p.package), ["acme/pods"]);
      assert.equal((await strut.subscriptions.sync("pods")).status, "current");

      // Edited here, then the secret removed: out, the edit kept.
      await ws.publishWorkflow("acme/pods/sync", "v2", LOG("acme/pods/sync", "mine"));
      assert.equal((await setSecret(strut, "PODS_KEY", null)).status, 200);
      out = await strut.subscriptions.sync("pods");
      assert.deepEqual([out.status, out.waiting], ["waiting", { secrets: ["PODS_KEY"] }], out.error);
      assert.deepEqual(await here(), { step: false, workflow: true, page: false });
      assert.equal((await ws.getWorkflowMetadata("acme/pods/sync"))?.active, "v2", "the edit is the box's own");
      s = await state();
      assert.deepEqual([s.waiting, s.applied?.packages, s.warnings], [{ secrets: ["PODS_KEY"] }, [], []]);
      assert.deepEqual(s.packages, [{ package: "acme/pods", version: "0.1.0", digest: s.applied?.digest, diverged: ["acme/pods/sync"] }], "what is left of it: the edit");
    });

    it("moved back, then a step edited here: at the older release, its untouched page follows the next one, and goes with the secret", async () => {
      /** Commit a release on `stable`: the step and both pages say which. */
      const release = async (v: string): Promise<string> => {
        await writeFile(join(repo, "pkg", "strut.yaml"), `package: acme/pods\nversion: ${v}\nrequires:\n  secrets: [PODS_KEY]\n`);
        await writeFile(join(repo, "pkg", "steps", "claim.ts"), `${KEYED_STEP("acme/pods/claim", "PODS_KEY")}// ${v}\n`);
        await writeFile(join(repo, "pkg", "concepts", "Code Change.md"), `---\ndescription: Change a repository's code in a pod\n---\nYou can change code (${v}).\n`);
        await writeFile(join(repo, "pkg", "concepts", "Pods.md"), `---\ndescription: Where code runs\n---\nPods (${v}).\n`);
        git(repo, "add", ".");
        git(repo, "commit", "--quiet", "-m", v);
        return git(repo, "rev-parse", "HEAD");
      };
      const docs = async (name: string) =>
        ((await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns", name: "$name" })} WHERE ${backend.dialect.live("c")} RETURN ${backend.dialect.project("c", ["ref_id", "docs"])} AS p`, { ns: backend.namespace, name }))[0]?.["p"] as
          | { ref_id: string; docs: string }
          | undefined);
      const c1 = await release("0.1.0");
      assert.equal((await setSecret(strut, "PODS_KEY", "pk_1")).status, 200);
      assert.equal((await strut.app.request("/packages/subscriptions/pods", json({ ref: `git+${pathToFileURL(repo).href}@stable#pkg` }, "PUT"))).status, 200);
      await strut.subscriptions.sync("pods");
      assert.equal((await state()).applied?.commit, c1);
      await release("0.2.0");
      assert.equal((await strut.subscriptions.sync("pods")).status, "applied");
      assert.match((await docs("Code Change"))!.docs, /\(0\.2\.0\)/);

      // `stable` moved back, then the step edited here and a page edited here.
      git(repo, "reset", "--quiet", "--hard", c1);
      let out = await strut.subscriptions.sync("pods");
      assert.deepEqual([out.status, out.to], ["applied", c1], out.error);
      assert.equal((await ws.getStepMetadata("acme/pods/claim"))?.active, "v1", "made active again, no version written");
      assert.match((await docs("Code Change"))!.docs, /\(0\.1\.0\)/);
      await ws.publishStep("acme/pods/claim", `${KEYED_STEP("acme/pods/claim", "PODS_KEY")}// mine\n`);
      await backend.nodes.update((await docs("Pods"))!.ref_id, { set: { docs: "Edited here." } });
      let s = await state();
      const digest1 = s.applied?.digest;
      assert.deepEqual(s.packages, [{ package: "acme/pods", version: "0.1.0", digest: digest1, diverged: ["acme/pods/claim", "Pods"] }], "at the release moved back to");

      // The next release: the untouched page follows it, the edited one is left, the step waits beside the edit.
      await release("0.3.0");
      out = await strut.subscriptions.sync("pods");
      assert.equal(out.status, "applied", out.error);
      const [p] = out.result!.packages;
      assert.deepEqual(p!.from, { version: "0.1.0", digest: digest1 });
      assert.deepEqual(p!.items.filter((i) => i.kind !== "workflow").map((i) => [i.name, i.status]), [
        ["acme/pods/claim", "diverged"],
        ["Code Change", "updated"],
        ["Pods", "modified"],
      ]);
      assert.match((await docs("Code Change"))!.docs, /\(0\.3\.0\)/);
      assert.equal((await docs("Pods"))!.docs, "Edited here.");
      s = await state();
      assert.deepEqual([s.packages[0]?.version, s.packages[0]?.digest], ["0.3.0", s.applied?.digest]);

      // The secret removed: out, the untouched page with it.
      assert.equal((await setSecret(strut, "PODS_KEY", null)).status, 200);
      assert.equal((await strut.subscriptions.sync("pods")).status, "waiting");
      assert.equal(await docs("Code Change"), undefined, "no page of a package taken out stays live");
    });
  });
}
