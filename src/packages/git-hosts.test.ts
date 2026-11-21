/**
 * The box's git hosts, from what installed packages declare
 * (`provides.git`, src/git-hosts.ts; stadeum plans/software.md §5, item 9),
 * through a booted strut: a run's token for a repository's host, a
 * package's step that may or may not read it, an install that would serve
 * a host with a second secret, and a person's `git+` subscription read
 * with their own token for its host. The repositories are served over http
 * on this machine (src/test-util/git-remote.ts), recording what each
 * request carried.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { serveGit, type GitServer } from "../test-util/git-remote.js";
import { WorkspaceManager } from "../workspace.js";
import type { InstalledPackage } from "./installed.js";
import type { SyncOutcome } from "./subscriptions.js";

const KEY = "git-hosts-key";
const TOKEN = "lab-token-SENTINEL-5e0d";
const DEPLOYMENT = "deployment-lab-SENTINEL-77aa";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function write(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}
/** A string's hash, to tell a token apart without putting it in an output. */
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** A workflow of one step, its repository the run's input. */
const ONE = (name: string, type: string) => `name: ${name}\ninput:\n  repo: { type: string }\nsteps:\n  - id: one\n    type: ${type}\n    config: { repo: "{{ input.repo }}" }\n`;
/** A package's step that calls strut's own git/remote-head with its ctx, and says what it holds. */
const PEEK = `import { z, defineStep } from "strut";
export default defineStep({
  type: "acme/lab/peek",
  input: z.object({ repo: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const head = await ctx.registry["git/remote-head"].run({ repo: cfg.repo, timeoutMs: 30000 }, ctx);
    return { git: typeof ctx.services.secrets.git, head: head.head };
  },
});
`;
/** A package's step that reads the run's token for a repository itself. */
const TOKEN_STEP = `import { z, defineStep } from "strut";
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export default defineStep({
  type: "acme/pods/token",
  input: z.object({ repo: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const mine = await ctx.services.secrets.git(cfg.repo);
    const forge = await ctx.services.secrets.git("https://git.acme.test/team/app");
    const none = await ctx.services.secrets.git("https://git.elsewhere.test/team/app");
    return { mine: mine ? hash(mine) : null, forge: forge ? hash(forge) : null, none: none ?? null };
  },
});
`;

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the box's git hosts, from the packages installed on it", () => {
  let root: string;
  let priv: GitServer;
  let strut: Strut;
  let ws: WorkspaceManager;
  const repo = () => `${priv.url}/acme/widgets.git`;
  let head: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-box-git-"));
    const repos = join(root, "repos");
    // acme/widgets: a private repository; acme/code: a package on a private branch.
    for (const [name, files] of [
      ["widgets", { "README.md": "# widgets\n" }],
      ["code", { "strut.yaml": "package: acme/code\nversion: 0.1.0\n", "workflows/check.yaml": ONE("acme/code/check", "git/remote-head") }],
    ] as const) {
      const seed = await write(join(root, `seed-${name}`), files);
      git(seed, "init", "--quiet", "-b", "main");
      git(seed, "add", "-A");
      git(seed, "commit", "--quiet", "-m", "init");
      if (name === "widgets") head = git(seed, "rev-parse", "HEAD");
      git(root, "init", "--quiet", "--bare", "-b", "main", join(repos, "acme", `${name}.git`));
      git(seed, "push", "--quiet", join(repos, "acme", `${name}.git`), "main");
    }
    priv = await serveGit(repos, { token: TOKEN });
    ws = new WorkspaceManager(join(root, "box"));
    strut = await createStrut({
      workspace: ws,
      store: new MemoryRunStore(),
      dataDir: join(root, "data"),
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
    await ws.publishWorkflow("head", "v1", ONE("head", "git/remote-head"));
  });
  afterEach(async () => {
    await strut.close();
    await priv.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = async (method: string, path: string, body?: unknown, as?: string) => {
    const res = await strut.app.request(path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(as ? { "x-strut-actor": as } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const pkg = (name: string, files: Record<string, string>) => write(join(root, "pkgs", name), files);
  const install = async (dir: string) => call("POST", "/packages/install", { ref: `file:${dir}` });
  /** acme/lab serves the private repositories' host with LAB_TOKEN; acme/forge, git.acme.test with FORGE_TOKEN. */
  const lab = () =>
    pkg("lab", {
      "strut.yaml": `package: acme/lab\nversion: 0.1.0\nrequires:\n  optional: [LAB_TOKEN]\nprovides:\n  git:\n    - { host: "${priv.host}", secret: LAB_TOKEN }\n`,
      "steps/peek.ts": PEEK,
      "workflows/peek.yaml": ONE("acme/lab/peek", "acme/lab/peek"),
    });
  const forge = () =>
    pkg("forge", {
      "strut.yaml": "package: acme/forge\nversion: 0.1.0\nrequires:\n  optional: [FORGE_TOKEN]\nprovides:\n  git:\n    - { host: git.acme.test, secret: FORGE_TOKEN }\n",
      "workflows/noop.yaml": "name: acme/forge/noop\nsteps:\n  - id: say\n    type: log\n    config: { message: forge }\n",
    });

  it("reads the token for a host from what two packages declare, and stops when the package goes", async () => {
    assert.equal((await call("PUT", "/secrets/LAB_TOKEN", { value: TOKEN })).status, 200);
    assert.equal((await call("PUT", "/secrets/FORGE_TOKEN", { value: "forge-SENTINEL" })).status, 200);

    // No package serves the host yet: asked with no token.
    const before = await strut.run("head", { repo: repo() });
    assert.match(before.error?.message ?? "", /^remote_denied: .*no token for its host/);
    assert.ok(priv.seen.every((r) => r.password === undefined));

    for (const dir of [await lab(), await forge()]) assert.equal((await install(dir)).status, 201);
    const listed = ((await call("GET", "/packages")).json.packages as InstalledPackage[]).map((p) => [p.package, p.provides]);
    assert.deepEqual(listed, [
      ["acme/forge", { git: [{ host: "git.acme.test", secret: "FORGE_TOKEN" }] }],
      ["acme/lab", { git: [{ host: priv.host, secret: "LAB_TOKEN" }] }],
    ]);
    const now = await strut.run("head", { repo: repo() });
    assert.equal(now.status, "success", now.error?.message);
    assert.deepEqual(now.output, { branch: "main", head });
    assert.ok(priv.seen.some((r) => r.password === TOKEN));

    // A package's step that said nothing of git: strut's step it calls uses the run's token; the step holds none.
    const peek = await strut.run("acme/lab/peek", { repo: repo() });
    assert.deepEqual(peek.output, { git: "undefined", head });

    // One that says requires.git: the run's token for each host the box serves, and none for another.
    const pods = await pkg("pods", { "strut.yaml": "package: acme/pods\nversion: 0.1.0\nrequires:\n  git: true\n", "steps/token.ts": TOKEN_STEP, "workflows/token.yaml": ONE("acme/pods/token", "acme/pods/token") });
    assert.equal((await install(pods)).status, 201);
    assert.equal(((await call("GET", "/packages")).json.packages as InstalledPackage[]).find((p) => p.package === "acme/pods")?.git, true, "an admin sees it");
    const token = await strut.run("acme/pods/token", { repo: repo() });
    assert.deepEqual(token.output, { mine: hash(TOKEN), forge: hash("forge-SENTINEL"), none: null });

    // The package goes, and with it the host.
    assert.equal((await call("DELETE", "/packages/acme/lab")).status, 200);
    const gone = await strut.run("head", { repo: repo() });
    assert.match(gone.error?.message ?? "", /^remote_denied: .*no token for its host/);
  });

  it("refuses a package that would serve a host with a second secret — github.com's included", async () => {
    assert.equal((await install(await forge())).status, 201);
    const twice = await install(await pkg("forge2", { "strut.yaml": "package: acme/forge2\nversion: 0.1.0\nrequires:\n  optional: [OTHER_TOKEN]\nprovides:\n  git:\n    - { host: git.acme.test, secret: OTHER_TOKEN }\n", "workflows/noop.yaml": "name: acme/forge2/noop\nsteps:\n  - id: say\n    type: log\n    config: { message: x }\n" }));
    assert.equal(twice.status, 409);
    assert.match(twice.json.error, /^package_conflict: acme\/forge2 provides git for git\.acme\.test with OTHER_TOKEN, which acme\/forge serves with FORGE_TOKEN: a host is served by one secret$/);
    const github = await install(await pkg("gh", { "strut.yaml": "package: acme/gh\nversion: 0.1.0\nrequires:\n  optional: [GH_PAT]\nprovides:\n  git:\n    - { host: github.com, secret: GH_PAT }\n", "workflows/noop.yaml": "name: acme/gh/noop\nsteps:\n  - id: say\n    type: log\n    config: { message: x }\n" }));
    assert.match(github.json.error, /^package_conflict: acme\/gh provides git for github\.com with GH_PAT, which strut serves with GITHUB_TOKEN/);
    // The one strut already names is welcome.
    const same = await install(await pkg("github", { "strut.yaml": "package: acme/github\nversion: 0.1.0\nrequires:\n  optional: [GITHUB_TOKEN]\nprovides:\n  git:\n    - { host: github.com, secret: GITHUB_TOKEN }\n", "workflows/noop.yaml": "name: acme/github/noop\nsteps:\n  - id: say\n    type: log\n    config: { message: x }\n" }));
    assert.equal(same.status, 201, same.json.error);
  });

  it("reads a person's git+ subscription with their own token for its host, never the deployment's", async () => {
    assert.equal((await install(await lab())).status, 201);
    assert.equal((await call("PUT", "/secrets/LAB_TOKEN", { value: DEPLOYMENT })).status, 200);
    const ref = `git+${priv.url}/acme/code.git@main`;
    const subscribe = async (as: string): Promise<SyncOutcome> => {
      const put = await call("PUT", "/packages/subscriptions/code", { ref }, as);
      assert.equal(put.status, 200, JSON.stringify(put.json));
      assert.equal(put.json.tokenSecret, "LAB_TOKEN", "the secret that serves its host");
      return (await call("POST", "/packages/subscriptions/code/sync")).json;
    };

    // carol has none of her own: refused, and the deployment's is never sent.
    const carol = await subscribe("carol");
    assert.equal(carol.status, "error");
    assert.match(carol.error!, /this subscription is carol's, and is read with their own LAB_TOKEN alone \(never the deployment's\)/);

    assert.equal((await call("PUT", "/actors/bob/secrets/LAB_TOKEN", { value: TOKEN })).status, 200);
    const bob = await subscribe("bob");
    assert.notEqual(bob.status, "error", bob.error);
    assert.ok(await ws.getWorkflowMetadata("acme/code/check"), "installed");
    assert.ok(priv.seen.some((r) => r.password === TOKEN), "read with bob's own");
    assert.ok(priv.seen.every((r) => r.password !== DEPLOYMENT), "the deployment's never sent");
  });
});
