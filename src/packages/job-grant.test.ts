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
import { JOB_WORKFLOW } from "../job-seed.js";
import { expandAgentTools } from "../steps/core/agent.js";
import { MemoryRunStore } from "../store.js";
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

  it("refuses a name that matches none of its steps — strut's, another package's, a helper, its own by full type — and an approve name outside tools", async () => {
    const refused = async (job: string, pattern: RegExp) => {
      await assert.rejects(readPackage(await writeTree(POD("acme/pods", job))), pattern);
    };
    await refused("job:\n  tools: [claim, graph/graph-get]\n", /^Error: bad_package: strut\.yaml: job\.tools: "graph\/graph-get" matches no step of the package/);
    await refused("job:\n  tools: [acme/linear/fetch]\n", /job\.tools: "acme\/linear\/fetch" matches no step of the package/);
    await refused("job:\n  tools: [acme/pods/claim]\n", /job\.tools: "acme\/pods\/claim" matches no step/);
    await refused("job:\n  tools: [_shared]\n", /job\.tools: "_shared" matches no step/);
    await refused("job:\n  tools: ['nope/*']\n", /job\.tools: "nope\/\*" matches no step/);
    await refused("job:\n  tools: [claim]\n  approve: [workspace]\n", /job\.approve: acme\/pods\/workspace is not among job\.tools/);
    await refused("job:\n  tools: [claim]\n  approve: [nope]\n", /job\.approve: "nope" matches no step/);
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

      assert.equal((await strut.app.request("/secrets/PODS_TOKEN", { method: "DELETE", headers: auth })).status, 200);
      out = await sync();
      assert.equal(out.status, "waiting", out.error);
      assert.equal((await jobOf(ws)).text, before.text, "taken out: the grant goes too");
    } finally {
      await strut.close();
    }
  });
});
