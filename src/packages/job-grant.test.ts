/**
 * A package's `job:` grant (plans/followed-repos.md §3): `strut.yaml` names
 * steps of the package the `job` workflow's agent may call. `readPackage`
 * resolves them over the package's own steps and refuses anything else
 * (src/packages/format.ts); the `job` seed grants what every installed
 * package names, again after every package write (src/job-seed.ts,
 * createStrut's `oneAtATime`) — a person's install and uninstall, and a
 * `git+` subscription's sync, which grants nothing while it waits for a
 * secret.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { createStrut, type Strut } from "../createStrut.js";
import { registerModelWrapper } from "../extensions.js";
import { JOB_WORKFLOW } from "../job-seed.js";
import { jobRoot } from "../jobs.js";
import { mockModel, type MockTurn } from "../privacy/testing/mock-model.js";
import { expandAgentTools } from "../steps/core/agent.js";
import { MemoryRunStore } from "../store.js";
import { serveGit, type GitServer } from "../test-util/git-remote.js";
import { WorkspaceManager } from "../workspace.js";
import { readPackage } from "./format.js";
import type { SyncOutcome } from "./subscriptions.js";

const KEY = "job-grant-api-key";
const auth = { authorization: `Bearer ${KEY}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

const STEP = (type: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, description: "A pod tool", input: z.object({}), output: z.any(), async run() { return "ok"; } });\n`;
/** A step that reads a secret, as pods' steps read PODS_TOKEN. */
const KEYED_STEP = (type: string, secret: string) =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}), output: z.any(), async run(_cfg, ctx) { return (await ctx.services.secrets.get(${JSON.stringify(secret)})) ? "keyed" : "none"; } });\n`;

/** A package of three steps and a helper, granting what `job` says. */
const POD = (pkg: string, job: string): Record<string, string> => ({
  "strut.yaml": `package: ${pkg}\nversion: 0.1.0\n${job}`,
  "steps/claim.ts": STEP(`${pkg}/claim`),
  "steps/workspace.ts": STEP(`${pkg}/workspace`),
  "steps/git/push.ts": STEP(`${pkg}/git/push`),
  "steps/_shared.ts": "export const shared = 1;\n",
});

/** A package of one step, `look`, granting what `job` says — strut's steps among it. */
const CODE = (pkg: string, job: string, manifest = ""): Record<string, string> => ({
  "strut.yaml": `package: ${pkg}\nversion: 0.1.0\n${manifest}${job}`,
  "steps/look.ts": STEP(`${pkg}/look`),
});

let root: string;
async function writeTree(files: Record<string, string>, name = crypto.randomUUID()): Promise<string> {
  const dir = join(root, "src", name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

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
    mediaWorkflows: false,
    orchestrator: false,
    builder: false,
    views: false,
    concepts: false,
    stt: false,
    subscriptionPoll: false,
    ...extra,
  });

/** The active `job` workflow's text, and its params. */
async function jobOf(ws: WorkspaceManager): Promise<{ text: string; tools: string[]; approve: string[] }> {
  const meta = await ws.getWorkflowMetadata(JOB_WORKFLOW);
  const text = await ws.getWorkflowSource(JOB_WORKFLOW, meta!.active);
  const { tools, approve } = (yaml.load(text) as { params: { tools: string[]; approve: string[] } }).params;
  return { text, tools, approve };
}

const install = async (strut: Strut, dir: string) => {
  const res = await strut.app.request("/packages/install", json({ ref: `file:${dir}` }));
  assert.equal(res.status, 201, await res.clone().text());
};
const uninstall = async (strut: Strut, pkg: string) => {
  const res = await strut.app.request(`/packages/${pkg}`, { method: "DELETE", headers: auth });
  assert.equal(res.status, 200, await res.clone().text());
};

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "job-grant-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-job-grant-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("strut.yaml's job: key (readPackage)", () => {
  it("resolves names and globs over the package's own steps, helpers left out: full types, deduplicated and sorted", async () => {
    const named = await readPackage(await writeTree(POD("acme/pods", "job:\n  tools: [workspace, claim, 'git/*', claim]\n  approve: [workspace]\n")));
    assert.deepEqual(named.job, { tools: ["acme/pods/claim", "acme/pods/git/push", "acme/pods/workspace"], approve: ["acme/pods/workspace"] });
    const all = await readPackage(await writeTree(POD("acme/pods", "job:\n  tools: ['*']\n")));
    assert.deepEqual(all.job, { tools: ["acme/pods/claim", "acme/pods/git/push", "acme/pods/workspace"], approve: [] }, "`*` is every step, never the `_` helper");
    assert.equal((await readPackage(await writeTree(POD("acme/pods", "")))).job, undefined, "no key, no grant");
  });

  it("reads a name it does not ship as strut's step: its own first, globs over its own alone", async () => {
    const mixed = await readPackage(await writeTree(POD("acme/pods", "job:\n  tools: [claim, git/push, github/create-pr, graph/graph-get]\n  approve: [github/create-pr]\n")));
    // `git/push` is the package's own (steps/git/push.ts), as any bare name in a package is.
    assert.deepEqual(mixed.job, { tools: ["acme/pods/claim", "acme/pods/git/push", "github/create-pr", "graph/graph-get"], approve: ["github/create-pr"] });
    // A package that ships no git/push names strut's.
    const strut = await readPackage(await writeTree({ "strut.yaml": "package: acme/code\nversion: 0.1.0\njob:\n  tools: [look, git/push]\n  approve: [git/push]\n", "steps/look.ts": STEP("acme/code/look") }));
    assert.deepEqual(strut.job, { tools: ["acme/code/look", "git/push"], approve: ["git/push"] });
    // A glob never reaches strut's steps: `*` is the package's own, as it always was.
    assert.deepEqual((await readPackage(await writeTree({ "strut.yaml": "package: acme/code\nversion: 0.1.0\njob:\n  tools: ['*']\n", "steps/look.ts": STEP("acme/code/look") }))).job, { tools: ["acme/code/look"], approve: [] });
  });

  it("refuses another package's step, its own by full type, a helper, a glob that matches none of its steps, a bad name, and an approve name outside tools", async () => {
    const refused = async (job: string, pattern: RegExp) => {
      await assert.rejects(readPackage(await writeTree(POD("acme/pods", job))), pattern);
    };
    await refused("job:\n  tools: [acme/linear/fetch]\n", /^Error: bad_package: strut\.yaml: job\.tools: "acme\/linear\/fetch" is another package's step, or this one's by its full type/);
    await refused("job:\n  tools: [acme/pods/claim]\n", /job\.tools: "acme\/pods\/claim" is another package's step, or this one's by its full type/);
    await refused("job:\n  tools: [_shared]\n", /job\.tools: "_shared" is a helper \(a `_` file\), not a step/);
    await refused("job:\n  tools: ['nope/*']\n", /job\.tools: "nope\/\*" matches no step of the package — a glob is over the package's own steps/);
    await refused("job:\n  tools: ['git/push@v2']\n", /job\.tools: "git\/push@v2" is not a step's name/);
    await refused("job:\n  tools: [claim]\n  approve: [workspace]\n", /job\.approve: acme\/pods\/workspace is not among job\.tools/);
    await refused("job:\n  tools: [claim]\n  approve: [github/create-pr]\n", /job\.approve: github\/create-pr is not among job\.tools/);
    await refused("job:\n  tools: []\n", /job\.tools: job\.tools names at least one step/);
    await refused("job:\n  tools: [claim]\n  system: hi\n", /strut\.yaml: job: Unrecognized key/);
  });
});

describe("the job seed grants what installed packages name", () => {
  let ws: WorkspaceManager;
  let strut: Strut;
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "box"));
    strut = await boot(ws);
  });
  afterEach(async () => {
    await strut.close();
  });

  it("an install puts the package's steps on the job agent, the approve ones gated; an uninstall takes them away", async () => {
    const before = await jobOf(ws);
    await install(strut, await writeTree(POD("acme/pods", "job:\n  tools: ['*']\n  approve: [workspace]\n")));

    const granted = await jobOf(ws);
    const pods = ["acme/pods/claim", "acme/pods/git/push", "acme/pods/workspace"];
    assert.deepEqual(granted.tools, [...before.tools, ...pods], "after strut's own, sorted");
    assert.deepEqual(granted.approve, [...before.approve, "acme/pods/workspace"]);
    // The job agent lists them: the grant resolves against the registry the install loaded them into.
    const listed = expandAgentTools(granted.tools, strut.getRegistry());
    for (const t of pods) assert.ok(listed.includes(t) && strut.getRegistry()[t], `the job agent lists ${t}`);
    assert.equal((await ws.getWorkflowMetadata(JOB_WORKFLOW))!.versions[(await ws.getWorkflowMetadata(JOB_WORKFLOW))!.active]!.source, "seed");

    // The same digest again: nothing new to grant, nothing published.
    const versions = Object.keys((await ws.getWorkflowMetadata(JOB_WORKFLOW))!.versions).length;
    await install(strut, await writeTree(POD("acme/pods", "job:\n  tools: ['*']\n  approve: [workspace]\n")));
    assert.equal(Object.keys((await ws.getWorkflowMetadata(JOB_WORKFLOW))!.versions).length, versions);

    await uninstall(strut, "acme/pods");
    assert.equal((await jobOf(ws)).text, before.text, "the grant goes with the package: the text before it, active again");
  });

  it("an uninstall that keeps a fork grants nothing: what stays is this box's own", async () => {
    const before = await jobOf(ws);
    await install(strut, await writeTree(POD("acme/pods", "job:\n  tools: [claim, workspace]\n")));
    // An edited step stays granted while its package is here (another
    // package's install seeds again).
    await ws.publishStep("acme/pods/claim", STEP("acme/pods/claim").replace("A pod tool", "Mine"));
    await install(strut, await writeTree(POD("zeta/vms", "job:\n  tools: [claim]\n")));
    assert.deepEqual((await jobOf(ws)).tools.slice(before.tools.length), ["acme/pods/claim", "acme/pods/workspace", "zeta/vms/claim"]);

    await uninstall(strut, "acme/pods");
    assert.ok(await ws.getStepMetadata("acme/pods/claim"), "the fork is kept");
    assert.deepEqual((await jobOf(ws)).tools.slice(before.tools.length), ["zeta/vms/claim"]);
  });

  it("the same text whichever order two packages install in", async () => {
    const a = await writeTree(POD("acme/pods", "job:\n  tools: [claim]\n  approve: [claim]\n"));
    const b = await writeTree(POD("zeta/vms", "job:\n  tools: ['git/*', workspace]\n"));
    await install(strut, b);
    await install(strut, a);
    const first = await jobOf(ws);
    assert.deepEqual(first.tools.slice(-3), ["acme/pods/claim", "zeta/vms/git/push", "zeta/vms/workspace"]);

    const ws2 = new WorkspaceManager(join(root, "box2"));
    const other = await boot(ws2);
    try {
      await install(other, a);
      await install(other, b);
      assert.equal((await jobOf(ws2)).text, first.text);
    } finally {
      await other.close();
    }
  });

  it("grants strut's steps a package names, asking first where it says; two packages grant one step once, and one's uninstall keeps the other's", async () => {
    const before = await jobOf(ws);
    for (const t of ["git/push", "github/create-pr"]) assert.ok(!before.tools.includes(t), `strut's own template does not grant ${t}`);

    await install(strut, await writeTree(CODE("acme/code", "job:\n  tools: [look, git/push]\n")));
    let job = await jobOf(ws);
    assert.deepEqual(job.tools.slice(before.tools.length), ["acme/code/look", "git/push"]);
    assert.deepEqual(job.approve, before.approve);
    const listed = expandAgentTools(job.tools, strut.getRegistry());
    assert.ok(listed.includes("git/push") && listed.includes("acme/code/look"), "the job agent lists them");

    // A second package grants git/push too, asking first, and strut's pull-request step.
    await install(strut, await writeTree(CODE("zeta/forge", "job:\n  tools: [git/push, github/create-pr]\n  approve: [git/push, github/create-pr]\n")));
    job = await jobOf(ws);
    assert.deepEqual(job.tools.slice(before.tools.length), ["acme/code/look", "git/push", "github/create-pr"], "one git/push");
    assert.deepEqual(job.approve.slice(before.approve.length), ["git/push", "github/create-pr"], "asks first when any grant says so");

    await uninstall(strut, "zeta/forge");
    job = await jobOf(ws);
    assert.deepEqual(job.tools.slice(before.tools.length), ["acme/code/look", "git/push"], "acme/code's grant of git/push stays");
    assert.deepEqual(job.approve, before.approve, "and no longer asks first");
    await uninstall(strut, "acme/code");
    assert.equal((await jobOf(ws)).text, before.text, "the grant goes with the package");
  });

  it("refuses at install a step strut keeps from what a package grants, saying why, and grants nothing", async () => {
    const before = await jobOf(ws);
    // A workspace's own step is not strut's.
    await ws.publishStep("team/tool", STEP("team/tool"));
    const refused = async (job: string, pattern: RegExp) => {
      const res = await strut.app.request("/packages/install", json({ ref: `file:${await writeTree(CODE("acme/code", job))}` }));
      const body = (await res.json()) as { error: string };
      assert.equal(res.status, 400, body.error);
      assert.match(body.error, pattern);
    };
    await refused("job:\n  tools: [look, meta/publish-workflow]\n", /^bad_package: strut\.yaml: job\.tools: meta\/publish-workflow is sealed \(the meta surface and the graders\)/);
    await refused("job:\n  tools: [exec]\n", /job\.tools: exec takes a secret's name in its config \(secretsEnv\): the model calling it would choose which secret it reads/);
    await refused("job:\n  tools: [human]\n", /job\.tools: human does not say what it does \(effect: read or write\)/);
    await refused("job:\n  tools: [git/fly]\n", /job\.tools: strut has no step git\/fly here — a package for a newer strut\?/);
    await refused("job:\n  tools: [team/tool]\n", /job\.tools: team\/tool is not one of strut's own steps/);
    // `approve` is within `tools`, so the same names are held there.
    await refused("job:\n  tools: [look, exec]\n  approve: [exec]\n", /job\.tools: exec takes a secret's name/);
    assert.equal((await jobOf(ws)).text, before.text);
    const listed = (await (await strut.app.request("/packages", { headers: auth })).json()) as { packages: Array<{ package: string }> };
    assert.deepEqual(listed.packages.map((p) => p.package), [], "nothing installed");
  });

  it("`job: false` seeds nothing, a package's grant included", async () => {
    const ws3 = new WorkspaceManager(join(root, "box3"));
    const off = await boot(ws3, { job: false });
    try {
      await install(off, await writeTree(POD("acme/pods", "job:\n  tools: ['*']\n")));
      assert.equal(await ws3.getWorkflowMetadata(JOB_WORKFLOW), null);
    } finally {
      await off.close();
    }
  });
});

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("a git+ subscription's package grants once it is in", () => {
  it("waits for its secret with no grant; the sync that installs it grants; the one that takes it out takes the grant", async () => {
    const repo = join(root, "pods");
    const files: Record<string, string> = {
      "package/strut.yaml": "package: stadeum/pods\nversion: 0.1.0\njob:\n  tools: [claim, workspace]\n  approve: [workspace]\nrequires:\n  secrets: [PODS_TOKEN]\n",
      "package/steps/claim.ts": KEYED_STEP("stadeum/pods/claim", "PODS_TOKEN"),
      "package/steps/workspace.ts": KEYED_STEP("stadeum/pods/workspace", "PODS_TOKEN"),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, rel)), { recursive: true });
      await writeFile(join(repo, rel), text);
    }
    git(repo, "-c", "init.defaultBranch=stable", "init", "--quiet");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "pods");

    const ws = new WorkspaceManager(join(root, "box"));
    const strut = await boot(ws, { dataDir: join(root, "data") });
    try {
      const before = await jobOf(ws);
      const put = await strut.app.request("/packages/subscriptions/pods", json({ ref: `git+${pathToFileURL(repo).href}@stable#package` }, "PUT"));
      assert.equal(put.status, 200, await put.clone().text());
      const sync = async (): Promise<SyncOutcome> => {
        const res = await strut.app.request("/packages/subscriptions/pods/sync", { method: "POST", headers: auth });
        return (await res.json()) as SyncOutcome;
      };

      let out = await sync();
      assert.deepEqual([out.status, out.waiting], ["waiting", { secrets: ["PODS_TOKEN"] }], out.error);
      assert.equal((await jobOf(ws)).text, before.text, "waiting: no grant");

      assert.equal((await strut.app.request("/secrets/PODS_TOKEN", json({ value: "tok" }, "PUT"))).status, 200);
      out = await sync();
      assert.equal(out.status, "applied", out.error);
      const granted = await jobOf(ws);
      assert.deepEqual(granted.tools.slice(-2), ["stadeum/pods/claim", "stadeum/pods/workspace"]);
      assert.equal(granted.approve.at(-1), "stadeum/pods/workspace");
      assert.ok(expandAgentTools(granted.tools, strut.getRegistry()).includes("stadeum/pods/claim"));

      // A release that names strut's git/push too, asking first: the sync that applies it grants it.
      await writeFile(join(repo, "package/strut.yaml"), files["package/strut.yaml"]!.replace("version: 0.1.0", "version: 0.2.0").replace("[claim, workspace]\n  approve: [workspace]", "[claim, workspace, git/push]\n  approve: [workspace, git/push]"));
      git(repo, "commit", "--quiet", "-am", "pods 0.2.0");
      out = await sync();
      assert.equal(out.status, "applied", out.error);
      const released = await jobOf(ws);
      assert.deepEqual(released.tools.slice(before.tools.length), ["git/push", "stadeum/pods/claim", "stadeum/pods/workspace"]);
      assert.deepEqual(released.approve.slice(before.approve.length), ["git/push", "stadeum/pods/workspace"]);

      assert.equal((await strut.app.request("/secrets/PODS_TOKEN", { method: "DELETE", headers: auth })).status, 200);
      out = await sync();
      assert.equal(out.status, "waiting", out.error);
      assert.equal((await jobOf(ws)).text, before.text, "taken out: the grant goes too");
    } finally {
      await strut.close();
    }
  });
});

/**
 * The job agent calls strut's git/push a package granted (stadeum plans/
 * software.md §5, item 16), as a turn's model would — stood in for through
 * strut's hook on every model it builds (src/extensions.ts), from a script.
 * The repository is private, served over http on this machine, recording
 * what each request carried (src/test-util/git-remote.ts).
 */
describe("the job agent pushes with a granted git/push, as the job's person", () => {
  const ADA = "ada-own-SENTINEL-1a2b";
  const BOB = "bob-own-SENTINEL-3c4d";
  const DEPLOYMENT = "deployment-SENTINEL-5e6f";
  const ADA_FORGE = "ada-forge-SENTINEL-7a8b";
  /** The stand-in's turns, set by each test: each one a list of the model's parts. */
  let script: MockTurn[] = [];
  let model: ReturnType<typeof mockModel> | undefined;
  let priv: GitServer;
  let strut: Strut;
  let ws: WorkspaceManager;
  let repos: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["ANTHROPIC_API_KEY"];
    // A key that is no one's: nothing reaches a provider even if the stand-in were skipped.
    process.env["ANTHROPIC_API_KEY"] = "stand-in";
    registerModelWrapper(() => (model = mockModel({ turns: script })));
  });
  after(() => {
    if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = saved;
  });
  beforeEach(async () => {
    // acme/widgets: a private repository, which only ada's own token reaches.
    repos = join(root, "repos");
    const seed = join(root, "seed");
    await mkdir(seed, { recursive: true });
    await writeFile(join(seed, "README.md"), "# widgets\n");
    git(seed, "-c", "init.defaultBranch=main", "init", "--quiet");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "init");
    git(root, "init", "--quiet", "--bare", "-b", "main", join(repos, "acme", "widgets.git"));
    git(seed, "push", "--quiet", join(repos, "acme", "widgets.git"), "main");
    priv = await serveGit(repos, { token: ADA });
    ws = new WorkspaceManager(join(root, "box"));
    strut = await boot(ws, { dataDir: join(root, "data") });
    const put = async (path: string, value: string) => assert.equal((await strut.app.request(path, json({ value }, "PUT"))).status, 200, path);
    // The box's value, bob's and ada's for the repository's host; ada's for another host.
    await put("/secrets/LAB_TOKEN", DEPLOYMENT);
    await put("/actors/bob/secrets/LAB_TOKEN", BOB);
    await put("/actors/ada/secrets/LAB_TOKEN", ADA);
    await put("/actors/ada/secrets/FORGE_TOKEN", ADA_FORGE);
  });
  afterEach(async () => {
    await strut.close();
    await priv.close();
  });

  /** acme/code serves the repository's host with LAB_TOKEN and grants `job`; zeta/forge serves another host. */
  const packages = async (job: string) => {
    await install(strut, await writeTree(CODE("acme/code", job, `requires:\n  optional: [LAB_TOKEN]\nprovides:\n  git:\n    - { host: "${priv.host}", secret: LAB_TOKEN }\n`)));
    await install(strut, await writeTree(CODE("zeta/forge", "", "requires:\n  optional: [FORGE_TOKEN]\nprovides:\n  git:\n    - { host: git.zeta.test, secret: FORGE_TOKEN }\n")));
  };
  const url = () => `${priv.url}/acme/widgets.git`;
  /** ada's job turn: the repository checked out into the job's directory; the
   *  model stages a change with bash, pushes it with git_push and answers. */
  const turn = async (job: string) => {
    const path = join(jobRoot(join(root, "data"), job), "widgets");
    const call = (id: string, toolName: string, input: unknown) => [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }];
    script = [
      call("c1", "bash", { command: "cd widgets && echo 'The button is blue.' >> README.md && git add -A" }),
      call("c2", "git_push", { path, branch: "job/blue", message: "Make the button blue" }),
      call("c3", "final_answer", { text: "Pushed.", artifacts: [] }),
    ];
    return strut.run("job", { prompt: "Make the button blue.", repos: [url()] }, { job, actor: "ada", principal: "ada" });
  };
  /** What the model read back from its git_push call. */
  const pushResult = () => JSON.stringify(model!.prompts.at(-1)!.filter((m) => m.role === "tool").at(-1)?.content ?? null);
  const branches = () => git(join(repos, "acme", "widgets.git"), "for-each-ref", "--format=%(refname:short) %(authorname)", "refs/heads/");

  it("pushes as ada with ada's own token for the repository's host — never bob's, the box's, or her token for another host", async () => {
    await packages("job:\n  tools: [look, git/push]\n");
    const run = await turn("j-ada");
    assert.equal(run.status, "success", JSON.stringify(run.error));
    assert.match(pushResult(), /"branch":"job\/blue"/, pushResult());
    // On the remote, authored by "strut": her token is not GitHub's, so GitHub is never asked who it is.
    assert.deepEqual(branches().split("\n").sort(), ["job/blue strut", "main test"]);
    const pushes = priv.seen.filter((r) => r.path.includes("git-receive-pack"));
    assert.ok(pushes.length > 0 && pushes.some((r) => r.password === ADA), "the push carried ada's token");
    for (const r of priv.seen) assert.ok(r.password === undefined || r.password === ADA, `${r.path} carried ada's token or none`);
  });

  it("asks first when the package approves git/push: the call is ada's proposal, and nothing is pushed", async () => {
    await packages("job:\n  tools: [look, git/push]\n  approve: [git/push]\n");
    const run = await turn("j-ada-asks");
    assert.equal(run.status, "success", JSON.stringify(run.error));
    assert.match(pushResult(), /"status":"pending"/, pushResult());
    assert.equal(branches(), "main test", "nothing pushed");
    assert.ok(priv.seen.every((r) => !r.path.includes("git-receive-pack")));
    const listed = (await (await strut.app.request("/proposals?status=pending", { headers: auth })).json()) as { proposals: Array<{ step: string; by: { actor?: string; job?: string } }> };
    assert.deepEqual(listed.proposals.map((p) => [p.step, p.by.actor, p.by.job]), [["git/push", "ada", "j-ada-asks"]]);
  });
});
