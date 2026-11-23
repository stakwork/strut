/**
 * A FORGE'S STEPS, BY HOST (plans/package-seams.md §4): `provides.git`'s
 * `repositories` and `pull_request`, resolved and checked at install, and
 * strut's `git/repositories` and `git/pull-request`, which pick them by host
 * — github.com's own entry with strut's `github/create-pr` — so a caller
 * names no forge.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineStep, flow, step, type AnyStepDef, type StepContext } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { createStrut, type Strut } from "../createStrut.js";
import { forgeStepsOf, gitHostProblems, STRUT_GIT_HOSTS, type GitHost } from "../git-hosts.js";
import pullRequest from "../steps/lib/git/pull-request.js";
import repositories from "../steps/lib/git/repositories.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { readPackage } from "./format.js";
import type { InstalledPackage } from "./installed.js";

const KEY = "forge-key";
let root: string;
async function write(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_PACKAGE_INDEXES", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
  process.env["STRUT_SECRET_KEY"] = "forge-secret";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-forge-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A forge package's `repositories` step: the repositories its token
 *  reaches, and whose token it read (by length, never the value). */
const REPOS = `import { z, defineStep } from "strut";
export default defineStep({
  type: "acme/forge/repositories",
  input: z.object({ host: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const token = await ctx.services.secrets.get("FORGE_TOKEN");
    if (token === "fail") throw new Error("the forge said 500");
    return { repositories: [{ url: "https://" + cfg.host + "/team/app", name: "team/app", private: true, description: "read with a token of " + (token ?? "").length, picked: true, stars: 3 }] };
  },
});
`;
/** Its `pull_request` step, which says what it was handed. */
const PR = `import { z, defineStep } from "strut";
export default defineStep({
  type: "acme/forge/pr",
  input: z.object({ url: z.string(), head: z.string(), base: z.string(), title: z.string(), body: z.string().optional() }),
  output: z.any(),
  async run(cfg) {
    return { url: cfg.url + "/pulls/7", number: 7, created: true, head: cfg.head, base: cfg.base, title: cfg.title, body: cfg.body ?? null };
  },
});
`;
/** A package that calls git/repositories from its own step, declaring no secret. */
const CALLER = {
  "strut.yaml": "package: acme/code\nversion: 0.1.0\n",
  "steps/pick.ts": `import { z, defineStep } from "strut";
export default defineStep({
  type: "acme/code/pick",
  input: z.object({}).passthrough(),
  output: z.any(),
  async run(_cfg, ctx) {
    const r = await ctx.registry["git/repositories"].run({ host: "git.acme.test" }, ctx);
    return { names: r.repositories.map((x) => x.name), hosts: r.hosts };
  },
});
`,
};
const forgeManifest = (git: string) => `package: acme/forge\nversion: 0.1.0\nrequires:\n  optional: [FORGE_TOKEN]\nprovides:\n  git:\n${git}`;
const FORGE = (git = "    - { host: git.acme.test, secret: FORGE_TOKEN, repositories: repositories, pull_request: pr }\n") => ({
  "strut.yaml": forgeManifest(git),
  "steps/repositories.ts": REPOS,
  "steps/pr.ts": PR,
});

describe("provides.git's forge steps (readPackage)", () => {
  it("resolves each to the package's own step by <name>, else strut's by its type", async () => {
    const info = await readPackage(
      await write(join(root, "a"), FORGE("    - { host: git.acme.test, secret: FORGE_TOKEN, repositories: repositories, pull_request: pr }\n    - { host: github.com, secret: FORGE_TOKEN, pull_request: github/create-pr }\n")),
    );
    assert.deepEqual(info.gitHosts, [
      { host: "git.acme.test", secret: "FORGE_TOKEN", repositories: "acme/forge/repositories", pull_request: "acme/forge/pr" },
      { host: "github.com", secret: "FORGE_TOKEN", pull_request: "github/create-pr" },
    ]);
  });

  it("refuses another package's step, a name that is no step's, a key it does not know", async () => {
    const refusal = async (git: string) => {
      try {
        await readPackage(await write(join(root, crypto.randomUUID()), FORGE(git)));
      } catch (e) {
        return (e as Error).message;
      }
      assert.fail("read");
    };
    assert.match(await refusal("    - { host: git.acme.test, secret: FORGE_TOKEN, repositories: acme/other/repos }\n"), /provides\.git\[0\]\.repositories: "acme\/other\/repos" is another package's step/);
    assert.match(await refusal("    - { host: git.acme.test, secret: FORGE_TOKEN, pull_request: 'no such' }\n"), /provides\.git\[0\]\.pull_request: "no such" is not a step's name/);
    assert.match(await refusal("    - { host: git.acme.test, secret: FORGE_TOKEN, merge: pr }\n"), /Unrecognized key/);
  });
});

describe("the box's forge steps (src/git-hosts.ts)", () => {
  it("github.com's own entry opens a pull request with strut's github/create-pr", () => {
    assert.deepEqual(forgeStepsOf(STRUT_GIT_HOSTS, "github.com"), { pull_request: "github/create-pr" });
  });

  it("a host's steps are the first holder's; two holders that name different steps for one are refused", () => {
    const pkg: GitHost[] = [
      { host: "github.com", secret: "GITHUB_TOKEN", repositories: "acme/gh/repositories", pull_request: "github/create-pr" },
      { host: "git.acme.test", secret: "T", pull_request: "acme/forge/pr" },
    ];
    assert.deepEqual(forgeStepsOf([...STRUT_GIT_HOSTS, ...pkg], "github.com"), { repositories: "acme/gh/repositories", pull_request: "github/create-pr" });
    assert.deepEqual(gitHostProblems([{ by: "strut", git: STRUT_GIT_HOSTS }, { by: "acme/gh", git: pkg }]), [], "the same step is welcome");
    assert.deepEqual(gitHostProblems([{ by: "strut", git: STRUT_GIT_HOSTS }, { by: "acme/gh", git: [{ host: "github.com", secret: "GITHUB_TOKEN", pull_request: "acme/gh/pr" }] }]), [
      "acme/gh names acme/gh/pr as github.com's pull_request step, which strut names github/create-pr: a host has one",
    ]);
  });
});

describe("git/repositories and git/pull-request pick by host", () => {
  const hosts: GitHost[] = [
    ...STRUT_GIT_HOSTS,
    { host: "git.acme.test", secret: "FORGE_TOKEN", repositories: "acme/forge/repositories", pull_request: "acme/forge/pr" },
    { host: "git.bare.test", secret: "BARE_TOKEN" },
  ];
  const called: Array<[string, unknown]> = [];
  const fake = (type: string, answer: (cfg: Record<string, unknown>) => unknown): AnyStepDef =>
    defineStep({
      type,
      input: z.object({}).passthrough(),
      output: z.any(),
      async run(cfg) {
        called.push([type, cfg]);
        return answer(cfg as Record<string, unknown>);
      },
    }) as AnyStepDef;
  const registry = {
    "acme/forge/repositories": fake("acme/forge/repositories", (cfg) => ({ repositories: [{ url: `https://${String(cfg["host"])}/team/app`, name: "team/app" }] })),
    "acme/forge/pr": fake("acme/forge/pr", (cfg) => ({ url: `${String(cfg["url"])}/pulls/1`, number: 1, created: true })),
    "github/create-pr": fake("github/create-pr", (cfg) => ({ url: `${String(cfg["url"])}/pull/9`, number: 9, created: false, headSha: "abc" })),
  };
  const ctxWith = (tokens: Record<string, string>): StepContext<StrutCapabilities> =>
    ({
      runId: "r1",
      path: "t/s",
      scope: {},
      input: {},
      emit: async () => {},
      registry,
      services: {
        gitHosts: { hosts: () => hosts },
        secrets: { get: async () => undefined, git: async (url: string) => tokens[new URL(url).host] },
      },
    }) as unknown as StepContext<StrutCapabilities>;
  beforeEach(() => void called.splice(0));

  it("git/repositories asks each host that names a step and has the person's token; says why for the rest", async () => {
    const out = await repositories.run(repositories.input.parse({}), ctxWith({ "git.acme.test": "t" }));
    assert.deepEqual(out.repositories, [{ url: "https://git.acme.test/team/app", name: "team/app" }]);
    assert.deepEqual(out.hosts.map((h) => [h.host, h.problem?.replace(/:.*/, "")]), [
      ["github.com", "nothing here lists what a token for github.com reaches"],
      ["git.acme.test", undefined],
      ["git.bare.test", "nothing here lists what a token for git.bare.test reaches"],
    ]);
    assert.deepEqual(called, [["acme/forge/repositories", { host: "git.acme.test" }]]);

    const none = await repositories.run(repositories.input.parse({ host: "git.acme.test" }), ctxWith({}));
    assert.deepEqual(none, { repositories: [], hosts: [{ host: "git.acme.test", problem: "no token for git.acme.test: set FORGE_TOKEN, your own or the server's" }] });
    const unknown = await repositories.run(repositories.input.parse({ host: "git.nowhere.test" }), ctxWith({}));
    assert.match(unknown.hosts[0]!.problem!, /serves no git host git\.nowhere\.test/);
  });

  it("git/pull-request calls the URL's host's step with strut's input: github.com's is github/create-pr", async () => {
    const pr = { head: "feature/x", base: "main", title: "T", body: "B" };
    assert.deepEqual(await pullRequest.run(pullRequest.input.parse({ url: "https://git.acme.test/team/app", ...pr }), ctxWith({})), { url: "https://git.acme.test/team/app/pulls/1", number: 1, created: true });
    const gh = await pullRequest.run(pullRequest.input.parse({ url: "https://github.com/acme/app", ...pr }), ctxWith({}));
    assert.deepEqual([gh.url, gh.number, gh.created], ["https://github.com/acme/app/pull/9", 9, false]);
    assert.deepEqual(called, [
      ["acme/forge/pr", { url: "https://git.acme.test/team/app", ...pr }],
      ["github/create-pr", { url: "https://github.com/acme/app", ...pr }],
    ]);
    await assert.rejects(pullRequest.run(pullRequest.input.parse({ url: "https://git.bare.test/a/b", ...pr }), ctxWith({})), /^Error: pr_no_provider: nothing here opens a pull request on git\.bare\.test/);
    await assert.rejects(pullRequest.run(pullRequest.input.parse({ url: "ssh://git@github.com/a/b", ...pr }), ctxWith({})), /^Error: pr_bad_url:/);
  });
});

describe("a forge package on a strut", () => {
  let strut: Strut;
  let store: MemoryRunStore;
  beforeEach(async () => {
    store = new MemoryRunStore();
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "box")),
      store,
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
  });
  afterEach(async () => {
    await strut.close();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await strut.app.request(path, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const install = async (files: Record<string, string>) => call("POST", "/packages/install", { ref: `file:${await write(join(root, "pkgs", crypto.randomUUID()), files)}` });
  const one = (type: string, config: Record<string, unknown>) => flow(`call-${type.replace("/", "-")}`, { input: z.object({}).passthrough(), steps: [step("one", type, config)] });

  it("an install records its steps by their full types; the steps pick them by host, as the run's person", async () => {
    const res = await install(FORGE());
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const listed = ((await call("GET", "/packages")).json.packages as InstalledPackage[]).find((p) => p.package === "acme/forge")!;
    assert.deepEqual(listed.provides?.git, [{ host: "git.acme.test", secret: "FORGE_TOKEN", repositories: "acme/forge/repositories", pull_request: "acme/forge/pr" }]);
    assert.deepEqual(forgeStepsOf((strut.services as StrutCapabilities).gitHosts!.hosts(), "git.acme.test"), { repositories: "acme/forge/repositories", pull_request: "acme/forge/pr" });

    assert.equal((await call("PUT", "/actors/alice/secrets/FORGE_TOKEN", { value: "alice-token" })).status, 200);
    const alice = await strut.run(one("git/repositories", { host: "git.acme.test" }), {}, { actor: "alice" });
    assert.equal(alice.status, "success", JSON.stringify(alice.error));
    assert.deepEqual(alice.output, {
      repositories: [{ url: "https://git.acme.test/team/app", name: "team/app", private: true, description: "read with a token of 11", picked: true, stars: 3 }],
      hosts: [{ host: "git.acme.test" }],
    });
    const bob = await strut.run(one("git/repositories", { host: "git.acme.test" }), {}, { actor: "bob" });
    assert.deepEqual(bob.output, { repositories: [], hosts: [{ host: "git.acme.test", problem: "no token for git.acme.test: set FORGE_TOKEN, your own or the server's" }] });

    // A package's step that calls the seam with its own fenced ctx — a
    // package that declares no secret — still gets what the provider reads
    // behind ITS fence.
    assert.equal((await install(CALLER)).status, 201);
    const viaCaller = await strut.run(one("acme/code/pick", {}), {}, { actor: "alice" });
    assert.equal(viaCaller.status, "success", JSON.stringify(viaCaller.error));
    assert.deepEqual(viaCaller.output, { names: ["team/app"], hosts: [{ host: "git.acme.test" }] });

    const pr = await strut.run(one("git/pull-request", { url: "https://git.acme.test/team/app", head: "feature/x", base: "main", title: "T" }), {}, { actor: "alice" });
    assert.equal(pr.status, "success", JSON.stringify(pr.error));
    assert.deepEqual(pr.output, { url: "https://git.acme.test/team/app/pulls/7", number: 7, created: true, head: "feature/x", base: "main", title: "T", body: null });
  });

  it("refuses a package that names a step neither it nor strut has, or another step for a host strut serves", async () => {
    const missing = await install(FORGE("    - { host: git.acme.test, secret: FORGE_TOKEN, pull_request: gitlab/open-mr }\n"));
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    assert.match(missing.json.error, /provides\.git: git\.acme\.test's pull_request names the step gitlab\/open-mr, which is neither on this strut server nor in the package/);
    const other = await install({
      ...FORGE(),
      "strut.yaml": "package: acme/forge\nversion: 0.1.0\nrequires:\n  optional: [GITHUB_TOKEN]\nprovides:\n  git:\n    - { host: github.com, secret: GITHUB_TOKEN, pull_request: pr }\n",
    });
    assert.equal(other.status, 409, JSON.stringify(other.json));
    assert.match(other.json.error, /acme\/forge names acme\/forge\/pr as github\.com's pull_request step, which strut names github\/create-pr/);
  });
});
