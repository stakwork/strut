/**
 * Work nobody launched runs as a PERSON (stadeum plans/software.md §5,
 * item 15; the owner's rule of 2026-11-20: there is no box token, every
 * token is a person's). A run nobody launched acts as the owner of the
 * workflow it runs (`runsAs`, src/workspace.ts) and as nobody else.
 *
 * Over a box following a package's git branch (src/packages/subscriptions.ts)
 * whose package ships a schedule: a subscription a person makes is theirs —
 * what it installs they own, release after release, so its schedule fires as
 * them with their own secret; its branch is read with their own token
 * alone, never the deployment's; one nobody made launches nothing and says
 * so where the admin sees the automation; and an owner an admin gives
 * survives the next release. The fixture repository is on disk (`file://`);
 * a shell in front of git plays a PRIVATE remote, which refuses a fetch that
 * carries no token and records the one it is sent.
 *
 * And a package's step starts a run only as its own run's person
 * (src/packages/fence.ts): whatever it passes, a launch is its run's, and a
 * run for nobody starts none.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageAutomationId } from "../automations.js";
import type { AnyStepDef, StepContext } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { AutomationView } from "../scheduler.js";
import { runProcess, type ProcessRequest, type ProcessResult } from "../shell.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { fenceStep } from "./fence.js";
import type { SubscriptionInfo, SyncOutcome } from "./subscriptions.js";

const KEY = "runs-as-api-key";
const PKG = "acme/code";
const CHECK = `${PKG}/check`;
const INGEST = `${PKG}/ingest`;
const LAUNCH = `${PKG}/launch`;
const CHECK_ID = packageAutomationId(PKG, "check");
/** A workflow of the box's own, owned by someone the package's step is not running for. */
const VICTIM = "payroll";

/** Whom its run acts as and which token it finds: what a scheduled run's person is. */
const REPORT = `import { z, defineStep } from "strut";
export default defineStep({
  type: "${PKG}/report",
  input: z.object({ repo: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    return { repo: cfg.repo, principal: ctx.principal ?? null, token: (await ctx.services.secrets.get("GITHUB_TOKEN")) ?? null };
  },
});
`;

/** A package's step that tries to start runs as someone else. */
const SNEAK = `import { z, defineStep } from "strut";
export default defineStep({
  type: "${PKG}/launch",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    const s = ctx.services;
    const launched = await s.runs.launch({ workflow: "${VICTIM}", input: {} }, { actor: "mallory", principal: "mallory" });
    const nested = await s.authoring.runWorkflow("${VICTIM}", {}, undefined, undefined, { actor: "mallory", principal: "mallory" });
    return { launched: launched.runId, nested: nested.runId, decide: typeof s.proposals.decide, automations: typeof s.automations, trials: typeof s.trials };
  },
});
`;

/** The fixture package at `version`: a schedule on `check`, `extra` workflows beside it. */
const RELEASE = (version: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "pkg/strut.yaml": `package: ${PKG}\nversion: ${version}\nrequires:\n  optional: [GITHUB_TOKEN]\nschedules:\n  - workflow: check\n    trigger: { every: interval, minutes: 15 }\n    input: { repo: hive }\n`,
  "pkg/workflows/check.yaml": `name: ${CHECK}\ndescription: Check the repositories (${version})\nsteps:\n  - { id: report, type: ${PKG}/report, config: { repo: "{{ input.repo }}" } }\n`,
  "pkg/workflows/launch.yaml": `name: ${LAUNCH}\nsteps:\n  - { id: launch, type: ${PKG}/launch }\n`,
  "pkg/steps/report.ts": REPORT,
  "pkg/steps/launch.ts": SNEAK,
  ...extra,
});
const INGEST_FLOW = { "pkg/workflows/ingest.yaml": `name: ${INGEST}\nsteps:\n  - { id: say, type: log, config: { message: ingest } }\n` };

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Everything a step reaches from `root` by its properties: prototypes, own
 *  data properties (getters are not run), a Map's or a Set's entries — each
 *  with the path it was found at. `globalThis` is left out: a step reaches
 *  it anyway, and strut keeps nothing there. */
function reachable(root: unknown): Map<unknown, string> {
  const seen = new Map<unknown, string>();
  const queue: Array<[unknown, string]> = [[root, "services"]];
  while (queue.length) {
    const [o, path] = queue.shift()!;
    if (o === null || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) continue;
    if (o === Object.prototype || o === Function.prototype || o === globalThis) continue;
    seen.set(o, path);
    queue.push([Object.getPrototypeOf(o), `${path}.__proto__`]);
    if (o instanceof Map) for (const [k, v] of o) queue.push([k, `${path}<key>`], [v, `${path}.get(${String(k)})`]);
    if (o instanceof Set) for (const v of o) queue.push([v, `${path}<item>`]);
    for (const k of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d && "value" in d) queue.push([d.value, `${path}.${String(k)}`]);
    }
  }
  return seen;
}

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "runs-as-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Where the fixture's package lives: GitHub, whose token is the
 *  person's own GITHUB_TOKEN (strut's own entry, src/git-hosts.ts). */
const REMOTE = "https://github.com/acme/code";

describe("work nobody launched runs as a person", () => {
  let root: string;
  let repo: string;
  let ref: string;
  let ws: WorkspaceManager;
  let store: MemoryRunStore;
  let strut: Strut;
  /** The token each fetch of the repository was sent (undefined: none). */
  let fetched: Array<string | undefined>;

  /** git, with the fixture repository private on "github.com": a fetch
   *  with no token is refused, and the URL reads the local repository. */
  const shell = async (req: ProcessRequest): Promise<ProcessResult> => {
    if (req.cmd !== "git") return runProcess(req);
    if (req.args?.includes("fetch")) {
      const token = req.env?.["STRUT_GIT_TOKEN"];
      fetched.push(token);
      if (!token) return { ...(await runProcess({ cmd: "false" })), code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" };
    }
    return runProcess({ ...req, args: ["-c", `url.${pathToFileURL(repo).href}.insteadOf=${REMOTE}`, ...(req.args ?? [])] });
  };
  const release = (version: string, extra?: Record<string, string>) => {
    return (async () => {
      for (const [rel, text] of Object.entries(RELEASE(version, extra))) {
        await mkdir(dirname(join(repo, rel)), { recursive: true });
        await writeFile(join(repo, rel), text);
      }
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", version);
    })();
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-runs-as-"));
    repo = join(root, "code");
    await mkdir(repo, { recursive: true });
    git(repo, "-c", "init.defaultBranch=stable", "init", "--quiet");
    await release("0.1.0");
    ref = `git+${REMOTE}@stable#pkg`;
    fetched = [];
    ws = new WorkspaceManager(join(root, "box"));
    store = new MemoryRunStore();
    strut = await createStrut({
      workspace: ws,
      store,
      dataDir: join(root, "data"),
      services: { shell },
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      concepts: false,
      stt: false,
      subscriptionPoll: false,
    });
    // A deployment value that happens to be set: no person's work reads it.
    assert.equal((await call("PUT", "/secrets/GITHUB_TOKEN", { value: "deployment-token" })).status, 200);
  });
  afterEach(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A request with the deployment key, made by `as` when given (`x-strut-actor`). */
  const call = async (method: string, path: string, body?: unknown, as?: string) => {
    const res = await strut.app.request(path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(as ? { "x-strut-actor": as } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const ownToken = async (actor: string, value: string) => assert.equal((await call("PUT", `/actors/${actor}/secrets/GITHUB_TOKEN`, { value })).status, 200);
  /** Subscribe (as `as`), then read the branch now: the outcome of a sync after the PUT's own. */
  const subscribe = async (as?: string): Promise<SyncOutcome> => {
    const put = await call("PUT", "/packages/subscriptions/code", { ref }, as);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    return sync();
  };
  const sync = async (): Promise<SyncOutcome> => (await call("POST", "/packages/subscriptions/code/sync")).json;
  const subscription = async (): Promise<SubscriptionInfo> => (await call("GET", "/packages/subscriptions")).json.subscriptions[0];
  const owner = async (workflow: string) => (await ws.getWorkflowMetadata(workflow))?.owner;
  const automation = async (): Promise<AutomationView> => (await call("GET", "/automations")).json.automations.find((a: AutomationView) => a.id === CHECK_ID);
  const finished = async (workflow: string, runId: string) => {
    for (let i = 0; i < 400; i++) {
      const s = await store.getRunSummary(workflow, runId);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`run ${runId} never finished`);
  };
  /** Fire the package's schedule ("Run now", the tick's own path) and wait for its run. */
  const fire = async () => {
    const fired = await call("POST", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}/fire`);
    assert.equal(fired.status, 202, JSON.stringify(fired.json));
    const s = await finished(CHECK, fired.json.runId);
    assert.equal(s.status, "success", s.error);
    const start = (await store.getRunEvents(CHECK, fired.json.runId)).find((e) => e.type === "run.start")!;
    return { output: s.output, principal: start.principal, actor: start.actor };
  };

  it("a subscription a person makes is theirs: they own what it installs, release after release, and its schedule fires as them with their own token", async () => {
    await ownToken("alice", "alice-token");
    const first = await subscribe("alice");
    assert.notEqual(first.status, "error", first.error);
    assert.equal((await subscription()).actor, "alice", "the PUT's actor is on record");
    assert.deepEqual([...new Set(fetched)], ["alice-token"], "the branch read with her own token, every time");
    assert.deepEqual([await owner(CHECK), await owner(LAUNCH)], ["alice", "alice"], "owned as her own install's would be");
    assert.deepEqual([(await automation()).runsAs, (await automation()).nobodyToRunAs], ["alice", undefined]);

    assert.deepEqual(await fire(), { output: { repo: "hive", principal: "alice", token: "alice-token" }, principal: "alice", actor: undefined });

    // A later release: what was hers stays hers, and what it adds is hers.
    await release("0.2.0", INGEST_FLOW);
    const second = await sync();
    assert.equal(second.status, "applied", second.error);
    assert.match((await ws.getWorkflowMetadata(CHECK))!.versions[(await ws.getWorkflowMetadata(CHECK))!.active]!.description ?? "", /0\.2\.0/);
    assert.deepEqual([await owner(CHECK), await owner(INGEST)], ["alice", "alice"]);
    assert.equal((await fire()).principal, "alice");
  });

  it("reads a private branch with the subscriber's own token alone: with none it fails and says so, the deployment's never sent", async () => {
    const out = await subscribe("bob");
    assert.equal(out.status, "error");
    assert.match(
      out.error!,
      /^package_repo_denied: .* asked for credentials .* — this subscription is bob's, and is read with their own GITHUB_TOKEN alone \(never the deployment's\), which they have not set: they set it \(PUT \/actors\/bob\/secrets\/GITHUB_TOKEN\), or a person who has one makes the subscription again \(PUT \/packages\/subscriptions\/code\) and it is theirs$/,
    );
    assert.equal((await subscription()).error, out.error, "said where the subscription is read");
    assert.deepEqual([...new Set(fetched)], [undefined], "no token sent, though the deployment has one");
    assert.equal(await ws.getWorkflowMetadata(CHECK), null, "nothing installed");

    await ownToken("bob", "bob-token");
    fetched = [];
    assert.equal((await sync()).status, "applied");
    assert.deepEqual([...new Set(fetched)], ["bob-token"]);
    assert.equal(await owner(CHECK), "bob");
  });

  it("one nobody made installs what nobody owns: its schedule launches nothing and says why where the admin sees it — and nobody names its person in the body", async () => {
    const named = await call("PUT", "/packages/subscriptions/code", { ref, actor: "alice" });
    assert.equal(named.status, 400);
    assert.match(named.json.error, /^subscription_invalid: a subscription's person is whoever makes the PUT/);

    const out = await subscribe();
    assert.notEqual(out.status, "error", out.error);
    assert.equal((await subscription()).actor, undefined);
    assert.deepEqual([...new Set(fetched)], ["deployment-token"], "nobody's subscription reads with the deployment's, as before");
    assert.equal(await owner(CHECK), undefined);

    const a = await automation();
    assert.equal(a.runsAs, undefined);
    assert.match(a.nobodyToRunAs!, /^nobody to run as: the package acme\/code's schedule "check" runs as the owner of the workflow "acme\/code\/check" .* An admin gives it one \(PUT \/workflows\/acme%2Fcode%2Fcheck\/owner/);
    const refused = await call("POST", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}/fire`);
    assert.deepEqual([refused.status, refused.json.error], [400, a.nobodyToRunAs]);
    assert.deepEqual(await store.listRuns(CHECK), [], "nothing ran as nobody on the deployment's token");
  });

  it("an owner an admin gives survives the next release, and the schedule then runs as them; a new PUT hands the subscription's own read over", async () => {
    await ownToken("alice", "alice-token");
    await ownToken("carol", "carol-token");
    await subscribe("alice");
    const given = await call("PUT", `/workflows/${encodeURIComponent(CHECK)}/owner`, { owner: "carol" });
    assert.equal(given.status, 200, JSON.stringify(given.json));

    await release("0.2.0");
    fetched = [];
    assert.equal((await sync()).status, "applied");
    assert.deepEqual([await owner(CHECK), await owner(LAUNCH)], ["carol", "alice"], "the admin's choice is kept; the rest stays alice's");
    assert.deepEqual([...new Set(fetched)], ["alice-token"], "the subscription is still alice's");
    assert.deepEqual(await fire(), { output: { repo: "hive", principal: "carol", token: "carol-token" }, principal: "carol", actor: undefined });

    // Carol makes the subscription again: it is hers from the next read on.
    assert.equal((await call("PUT", "/packages/subscriptions/code", { ref }, "carol")).status, 200);
    assert.equal((await sync()).status, "current", "the PUT's own read, done");
    await release("0.3.0");
    fetched = [];
    assert.equal((await sync()).status, "applied");
    assert.deepEqual([(await subscription()).actor, [...new Set(fetched)]], ["carol", ["carol-token"]]);
    assert.deepEqual([await owner(CHECK), await owner(LAUNCH)], ["carol", "alice"], "a hand-over moves no workflow: an admin does");
  });

  it("a package's step starts a run only as its own run's person, whomever it names — and a run for nobody starts none", async () => {
    await ownToken("alice", "alice-token");
    await subscribe("alice");
    await ws.publishWorkflow(VICTIM, "v1", `name: ${VICTIM}\nsteps:\n  - { id: s, type: log, config: { message: pay } }\n`);
    await ws.setWorkflowOwner(VICTIM, "bob");

    const ran = await call("POST", `/workflows/${encodeURIComponent(LAUNCH)}/run`, { input: {} }, "alice");
    assert.equal(ran.status, 202, JSON.stringify(ran.json));
    const s = await finished(LAUNCH, ran.json.runId);
    assert.equal(s.status, "success", s.error);
    const out = s.output as { launched: string; nested: string; decide: string; automations: string; trials: string };
    assert.deepEqual([out.decide, out.automations, out.trials], ["undefined", "undefined", "undefined"], "what only a person or the server does is not on its bag");
    for (const runId of [out.launched, out.nested]) {
      await finished(VICTIM, runId);
      const start = (await store.getRunEvents(VICTIM, runId)).find((e) => e.type === "run.start")!;
      assert.deepEqual([start.actor, start.principal], ["alice", "alice"], "its run's person: never mallory, never the workflow's owner");
    }

    // A run for nobody: the launch would be the victim's owner's, so it starts none.
    await ws.setWorkflowOwner(LAUNCH, null);
    const before = (await store.listRuns(VICTIM)).length;
    const nobody = await call("POST", `/workflows/${encodeURIComponent(LAUNCH)}/run`, { input: {} });
    const n = await finished(LAUNCH, nobody.json.runId);
    assert.equal(n.status, "error");
    assert.match(n.error!.message, /run_as_fenced: acme\/code\/launch came from the package acme\/code, whose steps start a run only as their own run's person — and this run acts for nobody/);
    assert.equal((await store.listRuns(VICTIM)).length, before, "nothing ran as bob");
  });

  it("from a package's step, nothing on strut's own bag reaches what the fence holds or takes off", async () => {
    const bag = strut.services as Record<string, unknown>;
    const originals = new Map<unknown, string>([[bag, "the shared bag"]]);
    for (const k of ["runs", "authoring", "jobs", "proposals", "peers", "places", "automations", "trials", "secretBlanks"]) {
      const cap = bag[k] as Record<string, unknown> | undefined;
      if (!cap) continue;
      originals.set(cap, k);
      for (const m of ["launch", "runWorkflow", "resumeRun", "controlRun", "propose", "decide", "fetch", "post", "list", "api", "fill", "trial", "test"]) {
        if (cap[m] && typeof cap[m] === "object") originals.set(cap[m], `${k}.${m}`);
        else if (typeof cap[m] === "function") originals.set(cap[m], `${k}.${m}`);
      }
    }
    assert.deepEqual(
      ["runs", "authoring", "jobs", "proposals", "peers", "places", "automations", "secretBlanks"].filter((k) => !originals.has(bag[k])),
      [],
      "the box's bag has each of them, so the walk below means something",
    );
    let held: unknown;
    const look = { type: `${PKG}/look`, run: async (_cfg: unknown, ctx?: StepContext<any>) => ((held = ctx!.services), null) } as unknown as AnyStepDef;
    await fenceStep(look, { package: PKG, secrets: [] }).run({}, { runId: "r0", path: "s", actor: "alice", principal: "alice", services: bag } as unknown as StepContext<any>);
    const seen = reachable(held);
    assert.ok(seen.size > 100, `walked ${seen.size} objects`);
    const found = [...seen].filter(([o]) => originals.has(o)).map(([o, path]) => `${originals.get(o)} at ${path}`);
    assert.deepEqual(found, []);
  });
});

describe("the fence holds a package's step to its run's person", () => {
  /** A step that hands every launcher a person of its own choosing. */
  const sneak: AnyStepDef = {
    type: `${PKG}/sneak`,
    async run(_cfg: unknown, ctx?: StepContext<any>) {
      const s = ctx!.services as any;
      await s.jobs.launch({ job: "j", input: {}, from: "elsewhere", actor: "mallory", principal: "mallory" });
      await s.proposals.propose({ step: "x", input: {}, title: "t", by: { workflow: "w", runId: "r", path: "p", actor: "mallory", principal: "mallory" } });
      await s.authoring.resumeRun("w", "r", {}, { principal: "mallory" });
      await s.authoring.controlRun("w", "r", "cancel", { principal: "mallory", force: true });
      await s.peers.fetch("hq", "/workflows/w/run", { method: "POST", headers: { "X-Strut-Actor": "mallory", "content-type": "application/json" } });
      await s.places.post({ host: "sphinx", key: "k", text: "t", id: "i", run: "r", workflow: "w" }, "mallory");
      await s.places.list("mallory");
      return null;
    },
  } as unknown as AnyStepDef;
  const fenced = fenceStep(sneak, { package: PKG, secrets: [] });
  const bag = (calls: unknown[][]) => ({
    jobs: { launch: async (o: unknown) => (calls.push(["jobs.launch", o]), { runId: "j1", callback: false, workflow: "job" }) },
    proposals: { propose: async (p: unknown) => (calls.push(["proposals.propose", p]), p), decide: async () => assert.fail("never a step's") },
    authoring: {
      runWorkflow: async () => ({ runId: "n1", status: "success" }),
      resumeRun: async (...a: unknown[]) => (calls.push(["authoring.resumeRun", a[3]]), {}),
      controlRun: async (...a: unknown[]) => (calls.push(["authoring.controlRun", a[3]]), {}),
    },
    peers: { list: async () => [], self: async () => undefined, fetch: async (...a: unknown[]) => (calls.push(["peers.fetch", (a[2] as { headers: unknown }).headers]), new Response("{}")) },
    places: { post: async (_p: unknown, person: unknown) => (calls.push(["places.post", person]), { id: "m" }), list: async (person: unknown) => (calls.push(["places.list", person]), []) },
  });

  it("names the run's own actor and principal on every launcher, whatever the step passed", async () => {
    const calls: unknown[][] = [];
    await fenced.run({}, { runId: "r0", path: "s", actor: "alice", principal: "alice", services: bag(calls) } as unknown as StepContext<any>);
    assert.deepEqual(calls, [
      ["jobs.launch", { job: "j", input: {}, from: "elsewhere", actor: "alice", principal: "alice" }],
      ["proposals.propose", { step: "x", input: {}, title: "t", by: { workflow: "w", runId: "r", path: "p", actor: "alice", principal: "alice" } }],
      ["authoring.resumeRun", { principal: "alice" }],
      ["authoring.controlRun", { force: true, principal: "alice" }],
      ["peers.fetch", { "content-type": "application/json", "x-strut-actor": "alice" }],
      ["places.post", "alice"],
      ["places.list", "alice"],
    ]);
  });

  it("in a run for nobody, starts no job, and names nobody to a peer", async () => {
    const calls: unknown[][] = [];
    await assert.rejects(fenced.run({}, { runId: "r0", path: "s", services: bag(calls) } as unknown as StepContext<any>), /^Error: run_as_fenced: acme\/code\/sneak came from the package acme\/code/);
    assert.deepEqual(calls, []);
    const peers: unknown[][] = [];
    const onlyPeers: AnyStepDef = { type: `${PKG}/peer`, run: async (_c: unknown, ctx?: StepContext<any>) => (ctx!.services as any).peers.fetch("hq", "/x", { headers: { "x-strut-actor": "mallory" } }) } as unknown as AnyStepDef;
    await fenceStep(onlyPeers, { package: PKG, secrets: [] }).run({}, { runId: "r0", path: "s", services: bag(peers) } as unknown as StepContext<any>);
    assert.deepEqual(peers, [["peers.fetch", {}]]);
  });

  it("asks for a follow-up on its own run and job, looking with its package's own steps alone", async () => {
    const asks: unknown[] = [];
    const jobs = { followUp: async (a: unknown) => (asks.push(a), { id: "x", until: "t" }) };
    const asking = (look: string): AnyStepDef =>
      ({
        type: `${PKG}/ask`,
        run: async (_c: unknown, ctx?: StepContext<any>) => (ctx!.services as any).jobs.followUp({ job: "other-job", runId: "other-run", look: { type: look, input: { status: true } } }),
      }) as unknown as AnyStepDef;
    const ctx = { runId: "r0", path: "s", job: "j-1", actor: "alice", principal: "alice", services: { jobs } } as unknown as StepContext<any>;
    await fenceStep(asking(`${PKG}/look`), { package: PKG, secrets: [] }).run({}, ctx);
    assert.deepEqual(asks, [{ job: "j-1", runId: "r0", look: { type: `${PKG}/look`, input: { status: true } } }], "its own run and job, whatever it named");
    await assert.rejects(fenceStep(asking("git/push"), { package: PKG, secrets: [] }).run({}, ctx), /^Error: follow_up_fenced: .* looks? with its own steps, not git\/push/);
    await assert.rejects(fenceStep(asking(`${PKG}/look`), { package: PKG, secrets: [] }).run({}, { ...ctx, job: undefined }), /^Error: follow_up_fenced: .* has no job/);
    assert.equal(asks.length, 1);
  });

  it("holds nothing a step can reach past — a prototype, a property — and leaves what it does not hold working", async () => {
    const calls: unknown[][] = [];
    const as = (who: unknown) => (who as { principal?: string } | undefined)?.principal ?? "nobody";
    const originals = {
      runs: { launch: async (_q: unknown, by: unknown) => (calls.push(["runs.launch", as(by)]), { runId: "l1" }), list: async () => (calls.push(["runs.list"]), []) },
      authoring: {
        runWorkflow: async (...a: unknown[]) => (calls.push(["authoring.runWorkflow", as(a[4])]), { runId: "n1", status: "success" }),
        resumeRun: async (...a: unknown[]) => (calls.push(["authoring.resumeRun", as(a[3])]), {}),
        controlRun: async (...a: unknown[]) => (calls.push(["authoring.controlRun", as(a[3])]), {}),
        listRuns: async () => (calls.push(["authoring.listRuns"]), []),
      },
      jobs: { launch: async (o: unknown) => (calls.push(["jobs.launch", as(o)]), { runId: "j1" }), release: async (job: string) => (calls.push(["jobs.release", job]), undefined) },
      proposals: { propose: async (p: { by: unknown }) => (calls.push(["proposals.propose", as(p.by)]), p), decide: async () => (calls.push(["proposals.decide"]), {}), get: async () => (calls.push(["proposals.get"]), null) },
      peers: { fetch: async (...a: unknown[]) => (calls.push(["peers.fetch", (a[2] as { headers?: Record<string, string> } | undefined)?.headers?.["x-strut-actor"] ?? "nobody"]), new Response("{}")), list: async () => (calls.push(["peers.list"]), []) },
      automations: { api: { fire: async () => (calls.push(["automations.fire"]), {}) } },
      trials: { trial: async () => (calls.push(["trials.trial"]), {}) },
      secretBlanks: { fill: async () => (calls.push(["secretBlanks.fill"]), true) },
    };
    const forged = { actor: "mallory", principal: "mallory" };
    const step: AnyStepDef = {
      type: `${PKG}/past`,
      async run(_cfg: unknown, ctx?: StepContext<any>) {
        const s = ctx!.services as any;
        // The reviewer's way in: each held capability's prototype.
        const through: string[] = [];
        for (const [cap, method] of [["runs", "launch"], ["authoring", "runWorkflow"], ["authoring", "resumeRun"], ["authoring", "controlRun"], ["jobs", "launch"], ["proposals", "propose"], ["proposals", "decide"], ["peers", "fetch"]] as const) {
          if (typeof Object.getPrototypeOf(s[cap])?.[method] === "function") through.push(`${cap}.${method}`);
        }
        // And every function reachable at all, called with a person of its own choosing.
        for (const [fn, path] of reachable(s)) {
          if (typeof fn !== "function") continue;
          const name = path.slice(path.lastIndexOf(".") + 1);
          const args: Record<string, unknown[]> = {
            launch: [{ job: "j", workflow: "w", input: {}, ...forged }, forged],
            runWorkflow: ["w", {}, undefined, undefined, forged],
            resumeRun: ["w", "r", {}, forged],
            controlRun: ["w", "r", "cancel", forged],
            propose: [{ step: "x", input: {}, title: "t", by: { workflow: "w", runId: "r", path: "p", ...forged } }],
            decide: ["p1", { action: "accept", by: "mallory", scope: "full", admin: true }],
            fetch: ["hq", "/workflows/w/run", { headers: { "x-strut-actor": "mallory" } }],
            fire: ["w", "a1"],
            trial: [{ claim: "c", n: 1, by: "mallory" }],
            fill: ["X", "v"],
          };
          if (!Object.hasOwn(args, name)) continue;
          try {
            await (fn as (...a: unknown[]) => unknown)(...args[name]!);
          } catch {
            // refused: what the test wants
          }
        }
        // What the fence does not hold works as before.
        await s.jobs.release("j");
        await s.runs.list({ workflow: "w" });
        await s.authoring.listRuns("w");
        await s.proposals.get("p1");
        await s.peers.list();
        return { through, gone: ["automations", "trials", "secretBlanks"].filter((k) => k in s) };
      },
    } as unknown as AnyStepDef;
    const out = (await fenceStep(step, { package: PKG, secrets: [] }).run({}, { runId: "r0", path: "s", actor: "alice", principal: "alice", services: originals } as unknown as StepContext<any>)) as { through: string[]; gone: string[] };
    assert.deepEqual(out.through, [], "no held capability's prototype holds the original");
    assert.deepEqual(out.gone, [], "what the fence takes off the bag is not on it");
    const persons = calls.filter((c) => c.length === 2 && !["jobs.release"].includes(c[0] as string));
    assert.ok(persons.length >= 6, JSON.stringify(calls));
    assert.deepEqual(persons.filter((c) => c[1] !== "alice"), [], "every launch, resume, proposal and peer request is the run's person's");
    assert.deepEqual(calls.filter((c) => ["proposals.decide", "automations.fire", "trials.trial", "secretBlanks.fill"].includes(c[0] as string)), [], "never decided, fired, trialled or filled");
    for (const kept of ["jobs.release", "runs.list", "authoring.listRuns", "proposals.get", "peers.list"]) assert.ok(calls.some((c) => c[0] === kept), `${kept} still works`);
  });
});
