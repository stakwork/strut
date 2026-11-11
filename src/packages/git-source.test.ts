/**
 * The `git+` package source (src/packages/git-source.ts; plans/
 * marketplace.md §5, plans/app-repos.md §2, §4.7): a fixture repository made
 * with `git init` in a temp dir, resolved by a branch, a tag, a commit and a
 * `#path`, then installed through every door — `POST /packages/install`,
 * `STRUT_PACKAGES` and a `requires.packages` entry — with the commit it
 * resolved recorded on each version's `upstream`; and a served box
 * (`STRUT_SERVE=git+…`, src/packages/serve.ts) following its branch.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess, type ProcessRequest, type ProcessResult } from "../shell.js";
import { cachePath, parseRepo } from "../steps/lib/git/_shared.js";
import type { KitLocation } from "../apps/kit.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { WorkspaceManager, type WorkspaceStore } from "../workspace.js";
import { packageCache, resolvePackage } from "./cache.js";
import { parseGitRef } from "./git-source.js";
import type { InstallResult } from "./install.js";
import type { InstalledPackage } from "./installed.js";
import type { PingOutcome, ServeStatus } from "./serve.js";

const HELLO = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "__fixtures__", "hello");
const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
}

const SCORE = (name: string, message: string) => `name: ${name}\ndescription: Keep the score\nsteps:\n  - id: say\n    type: log\n    config: { message: ${JSON.stringify(message)} }\n`;

let root: string;
/** A repository with the package at its root: `main` holds 1.1.0 over the
 *  tagged 1.0.0 (`v1`); `withApp` adds the hello app as `apps/game`. */
async function landerRepo(withApp = false): Promise<{ dir: string; url: string; v1: string; head: string }> {
  const dir = join(root, `lander-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init", "--quiet");
  await write(dir, {
    "strut.yaml": "package: acme/lander\nversion: 1.0.0\ndescription: Moon lander\n",
    "README.md": "# Moon lander\n",
    "workflows/score.yaml": SCORE("acme/lander/score", "one"),
  });
  if (withApp) await cp(HELLO, join(dir, "apps", "game"), { recursive: true });
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "1.0.0");
  git(dir, "tag", "v1");
  const v1 = git(dir, "rev-parse", "HEAD");
  await write(dir, { "strut.yaml": "package: acme/lander\nversion: 1.1.0\ndescription: Moon lander\n", "workflows/score.yaml": SCORE("acme/lander/score", "two") });
  git(dir, "commit", "--quiet", "-am", "1.1.0");
  return { dir, url: pathToFileURL(dir).href, v1, head: git(dir, "rev-parse", "HEAD") };
}

/** A repository that holds a site and, under `strut/`, a package. */
async function siteRepo(): Promise<{ dir: string; url: string }> {
  const dir = join(root, `site-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init", "--quiet");
  await write(dir, {
    "www/index.html": "<p>hi</p>\n",
    "strut/strut.yaml": "package: acme/site\nversion: 0.1.0\n",
    "strut/workflows/hello.yaml": SCORE("acme/site/hello", "hi"),
  });
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "site");
  return { dir, url: pathToFileURL(dir).href };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-git-source-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a git+ ref", () => {
  it("parses into the repository, the ref and the folder, and refuses what is not one", () => {
    const ok = parseGitRef("git+https://github.com/acme/lander@main#strut/pkg");
    assert.ok(typeof ok !== "string");
    assert.deepEqual([ok.repo.url, ok.rev, ok.path], ["https://github.com/acme/lander", "main", "strut/pkg"]);
    const bare = parseGitRef("git+https://github.com/acme/lander");
    assert.ok(typeof bare !== "string" && bare.rev === undefined && bare.path === undefined);
    const slashed = parseGitRef("git+https://gitlab.com/acme/group/lander.git@release/2026-11");
    assert.ok(typeof slashed !== "string" && slashed.rev === "release/2026-11" && slashed.repo.name === "lander");
    for (const [ref, re] of [
      ["git+https://github.com/acme/lander@", /nothing after @/],
      ["git+https://github.com/acme/lander@-upload-pack=x", /not a branch, tag or commit/],
      ["git+https://github.com/acme/lander@a..b", /not a branch, tag or commit/],
      ["git+https://github.com/acme/lander#../etc", /not a folder in the repository/],
      ["git+https://github.com/acme/lander#", /nothing after #/],
      ["git+https://tok@github.com/acme/lander@main", /must not carry credentials/],
      ["git+ssh://github.com/acme/lander@main", /ssh remote/],
      ["git+https://github.com/lander", /needs an owner and a name/],
    ] as const) {
      const got = parseGitRef(ref);
      assert.equal(typeof got, "string", ref);
      assert.match(got as string, re);
    }
  });
});

describe("resolving a git+ ref", () => {
  it("takes a branch, a tag, a commit and the default branch, each by the commit it resolved, and leaves the cache as git/checkout keeps it", async () => {
    const repo = await landerRepo();
    const data = join(root, "data");
    const cache = packageCache(data);
    const main = await resolvePackage(`git+${repo.url}@main`, { cache });
    assert.equal(main.manifest.version, "1.1.0");
    assert.equal(main.commit, repo.head);
    assert.deepEqual(main.source, { ref: `git+${repo.url}@main` });
    assert.deepEqual(main.files, ["README.md", "strut.yaml", "workflows/score.yaml"]);
    assert.equal(main.dir, cache.dirOf(main.digest));

    const tag = await resolvePackage(`git+${repo.url}@v1`, { cache });
    assert.deepEqual([tag.manifest.version, tag.commit], ["1.0.0", repo.v1]);
    const sha = await resolvePackage(`git+${repo.url}@${repo.v1}`, { cache });
    assert.deepEqual([sha.manifest.version, sha.digest], ["1.0.0", tag.digest]);
    const short = await resolvePackage(`git+${repo.url}@${repo.v1.slice(0, 10)}`, { cache });
    assert.equal(short.digest, tag.digest);
    const dflt = await resolvePackage(`git+${repo.url}`, { cache });
    assert.deepEqual([dflt.digest, dflt.commit], [main.digest, repo.head]);

    // git/checkout's bare cache: one per remote, no worktree, no index.
    assert.deepEqual(await readdir(join(data, "repos")), ["local"]);
    const bare = cachePath(data, parseRepo(repo.url));
    assert.ok(existsSync(join(bare, "HEAD")), bare);
    assert.ok(!existsSync(join(bare, "index")), "the export used an index of its own");
    assert.equal(git(bare, "worktree", "list").split("\n").length, 1);
    assert.deepEqual(await readdir(join(data, "packages", ".scratch")), []);

    // A branch moves: the same ref resolves to the new commit.
    await write(repo.dir, { "strut.yaml": "package: acme/lander\nversion: 1.2.0\n" });
    git(repo.dir, "commit", "--quiet", "-am", "1.2.0");
    const moved = await resolvePackage(`git+${repo.url}@main`, { cache });
    assert.equal(moved.manifest.version, "1.2.0");
    assert.equal(moved.commit, git(repo.dir, "rev-parse", "HEAD"));
  });

  it("takes the package from #path, and names what is missing", async () => {
    const site = await siteRepo();
    const cache = packageCache(join(root, "data"));
    const pkg = await resolvePackage(`git+${site.url}@main#strut`, { cache });
    assert.equal(pkg.manifest.package, "acme/site");
    assert.deepEqual(pkg.files, ["strut.yaml", "workflows/hello.yaml"]);

    const refused: Array<[string, RegExp]> = [
      [`git+${site.url}@main`, /package_source_invalid: .*the repository's root at [0-9a-f]{40} holds no strut\.yaml — a package in a folder is named with #<folder>/],
      [`git+${site.url}@main#www`, /package_source_invalid: .*the folder www at [0-9a-f]{40} holds no strut\.yaml$/],
      [`git+${site.url}@main#nope`, /package_source_invalid: .*the folder nope is not in file:.* at [0-9a-f]{40}/],
      [`git+${site.url}@v9#strut`, /package_ref_not_found: .*@v9#strut: no branch, tag or commit "v9" in file:/],
      [`git+${site.url}@${"a".repeat(40)}#strut`, /package_ref_not_found: .*no branch, tag or commit "a{40}"/],
      [`git+${pathToFileURL(join(root, "nothing", "here")).href}@main`, /package_repo_not_found: .*no repository at file:/],
    ];
    for (const [ref, re] of refused) await assert.rejects(resolvePackage(ref, { cache }), re, ref);
    await assert.rejects(
      resolvePackage(`git+${site.url}@main#strut`, { cache, digest: `sha256:${"0".repeat(64)}` }),
      /package_digest_mismatch: expected sha256:0{64}, the tree is sha256:[0-9a-f]{64} \(git\+file:.*@main#strut at [0-9a-f]{40}\)/,
    );
  });

  it("hands the token to git through the child env alone, read from the secret tokenSecret names, and never puts it in an error", async () => {
    const repo = await landerRepo();
    const calls: ProcessRequest[] = [];
    const shell = (req: ProcessRequest) => {
      calls.push(req);
      return runProcess(req);
    };
    const read: string[] = [];
    const secret = async (name: string) => (read.push(name), name === "LANDER_GH" ? "tok-sentinel-123" : undefined);
    const cache = packageCache(join(root, "data"));
    await resolvePackage(`git+${repo.url}@main`, { cache, shell, secret, tokenSecret: "LANDER_GH" });
    assert.deepEqual(read, ["LANDER_GH"]);
    const fetch = calls.find((c) => c.args?.includes("fetch"))!;
    assert.equal(fetch.env?.["STRUT_GIT_TOKEN"], "tok-sentinel-123");
    assert.ok(calls.every((c) => !(c.args ?? []).some((a) => a.includes("tok-sentinel-123"))), "never an argument");

    read.length = 0;
    await resolvePackage(`git+${repo.url}@v1`, { cache, shell, secret });
    assert.deepEqual(read, ["GITHUB_TOKEN"], "the default secret");

    // A remote that echoes what it was sent: the error is masked.
    const leaky = async (req: ProcessRequest): Promise<ProcessResult> =>
      req.args?.includes("fetch") ? { ...(await runProcess({ cmd: "false" })), stderr: "fatal: unable to access: tok-sentinel-123 timed out" } : runProcess(req);
    const err = await resolvePackage(`git+${pathToFileURL(join(root, "elsewhere", "repo")).href}@main`, { cache, shell: leaky, secret, tokenSecret: "LANDER_GH" }).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /^package_repo_unreachable: /);
    assert.ok(!err.message.includes("tok-sentinel-123"), err.message);
  });
});

// ── the doors ───────────────────────────────────────────────────────────────

const boot = (workspace: WorkspaceStore, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace,
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
    jamie: false,
    knowledge: false,
    concepts: false,
    stt: false,
    ...extra,
  });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("installing from git+", () => {
  let kit: KitLocation;
  let saved: string | undefined;
  const struts: Strut[] = [];
  const fresh = async (name: string, extra: Record<string, unknown> = {}) => {
    const s = await boot(new WorkspaceManager(join(root, name)), { kit, ...extra });
    struts.push(s);
    return s;
  };
  const install = async (s: Strut, body: Record<string, unknown>) => {
    const res = await s.app.request("/packages/install", json(body));
    return { status: res.status, body: (await res.json()) as InstallResult & { error?: string } };
  };
  const list = async (s: Strut) => ((await (await s.app.request("/packages")).json()) as { packages: InstalledPackage[] }).packages;
  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    kit = await kitForTests();
  });
  afterEach(async () => {
    for (const s of struts.splice(0)) await s.close?.();
  });
  after(() => {
    if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
  });

  it("POST /packages/install takes a branch: the app builds, and every version records the ref and the commit", async () => {
    const repo = await landerRepo(true);
    const s = await fresh("ws-branch");
    const ref = `git+${repo.url}@main`;
    const r = await install(s, { ref });
    assert.equal(r.status, 201, r.body.error);
    const report = r.body.packages[0]!;
    assert.deepEqual([report.package, report.version, report.source, report.commit], ["acme/lander", "1.1.0", { ref }, repo.head]);
    assert.deepEqual(report.items.map((i) => [i.kind, i.name, i.status]), [
      ["workflow", "acme/lander/score", "installed"],
      ["app", "acme/lander/game", "installed"],
    ]);
    const [pkg] = await list(s);
    assert.deepEqual([pkg!.package, pkg!.source, pkg!.commit, pkg!.digest], ["acme/lander", { ref }, repo.head, r.body.digest]);
    const wf = await s.workspace.getWorkflowMetadata("acme/lander/score");
    assert.deepEqual(wf?.versions[wf.active]?.upstream?.commit, repo.head);
    assert.deepEqual(wf?.versions[wf.active]?.upstream?.source, { ref });
    const app = (await s.workspace.listApps()).find((a) => a.name === "acme/lander/game");
    assert.ok(app, "the app is installed");

    // The door's errors, named; a tokenSecret is a NAME, and only for git+.
    const missing = await install(s, { ref: `git+${repo.url}@nope` });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error!, /package_ref_not_found: .*"nope"/);
    assert.equal((await install(s, { ref, tokenSecret: "ghp-abc" })).status, 400);
    assert.equal((await install(s, { ref: `file:${repo.dir}`, tokenSecret: "GH" })).status, 400);
  });

  it("installs a #path and a tag, and a requires.packages entry whose source is git+", async () => {
    const site = await siteRepo();
    const s = await fresh("ws-path");
    const r = await install(s, { ref: `git+${site.url}@main#strut`, tokenSecret: "SITE_GH" });
    assert.equal(r.status, 201, r.body.error);
    assert.equal(r.body.package, "acme/site");
    assert.ok(await s.workspace.getWorkflowMetadata("acme/site/hello"));

    // A package that requires acme/lander at v1, from its repo.
    const repo = await landerRepo();
    const v1 = await resolvePackage(`git+${repo.url}@v1`, { cache: packageCache(join(root, "elsewhere")) });
    const bundle = join(root, "bundle");
    await write(bundle, {
      "strut.yaml": `package: acme/bundle\nversion: 1.0.0\nrequires:\n  packages:\n    - { package: acme/lander, digest: "${v1.digest}", source: "git+${repo.url}@v1" }\n`,
      "workflows/all.yaml": SCORE("acme/bundle/all", "all"),
    });
    const b = await install(s, { ref: `file:${bundle}` });
    assert.equal(b.status, 201, b.body.error);
    assert.deepEqual(b.body.packages.map((p) => [p.package, p.version, p.source.ref, p.commit]), [
      ["acme/lander", "1.0.0", `git+${repo.url}@v1`, repo.v1],
      ["acme/bundle", "1.0.0", `file:${bundle}`, undefined],
    ]);
    const wf = await s.workspace.getWorkflowMetadata("acme/lander/score");
    assert.equal(wf?.versions[wf.active]?.upstream?.commit, repo.v1);
  });

  it("STRUT_PACKAGES takes git+: installed once, then found by its ref and left alone", async () => {
    const repo = await landerRepo();
    const ref = `git+${repo.url}@main`;
    const ws = new WorkspaceManager(join(root, "ws-boot"));
    process.env["STRUT_PACKAGES"] = JSON.stringify([{ ref, tokenSecret: "LANDER_GH" }]);
    try {
      const first = await boot(ws, { kit });
      const outcomes = await first.packages.booted;
      await first.close();
      assert.deepEqual(outcomes.map((o) => [o.package, o.status, o.version]), [["acme/lander", "installed", "1.1.0"]]);

      // main moves; the next boot installs nothing and updates nothing.
      await write(repo.dir, { "strut.yaml": "package: acme/lander\nversion: 1.2.0\n" });
      git(repo.dir, "commit", "--quiet", "-am", "1.2.0");
      const second = await boot(ws, { kit });
      const again = await second.packages.booted;
      await second.close();
      assert.deepEqual(again.map((o) => [o.package, o.status]), [["acme/lander", "present"]]);
      assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("acme/lander/score"))?.versions ?? {}), ["v1"]);
    } finally {
      delete process.env["STRUT_PACKAGES"];
    }
  });
});

// ── a served box following a branch (plans/app-repos.md §4.3) ──────────────

const KEY = "git-serve-key";
const auth = { authorization: `Bearer ${KEY}` };
const INDEX_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>strut</title>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n`;
const GREET = 'name: acme/moon/greet\ninput:\n  who: { type: string, required: false, default: world }\nsteps:\n  - { id: say, type: log, config: { message: "hi {{ input.who }}" } }\n';
const SERVE = (title: string) => `app: hello\ntitle: ${title}\nrunnable:\n  - { kind: workflow, name: greet }\n`;

describe("a served box following a branch", () => {
  let kit: KitLocation;
  const saved: Record<string, string | undefined> = {};
  let strut: Strut | undefined;
  before(async () => {
    for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_SECRET_KEY"] = "git-serve-secret";
    kit = await kitForTests();
  });
  afterEach(async () => {
    await strut?.close();
    strut = undefined;
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** The moon repo: the hello app, a workflow anyone may run, serve.yaml. */
  async function moonRepo(): Promise<{ dir: string; url: string; commit(files: Record<string, string>, message: string): string }> {
    const dir = join(root, "moon");
    await mkdir(dir, { recursive: true });
    git(dir, "-c", "init.defaultBranch=main", "init", "--quiet");
    await cp(HELLO, join(dir, "apps", "hello"), { recursive: true });
    await write(dir, {
      "apps/hello/app.yaml": "title: Hello\nicon: hand\ngrants:\n  workflows: [greet]\n  steps: []\n",
      "strut.yaml": "package: acme/moon\nversion: 1.0.0\n",
      "workflows/greet.yaml": GREET,
      "serve.yaml": SERVE("Moon one"),
    });
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "one");
    return {
      dir,
      url: pathToFileURL(dir).href,
      commit: (files, message) => {
        for (const [rel, text] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, rel)), { recursive: true });
          writeFileSync(join(dir, rel), text);
        }
        git(dir, "add", ".");
        git(dir, "commit", "--quiet", "-m", message);
        return git(dir, "rev-parse", "HEAD");
      },
    };
  }

  const bootServed = async (ref: string) => {
    await mkdir(join(root, "web"), { recursive: true });
    await writeFile(join(root, "web", "index.html"), INDEX_HTML);
    return boot(new WorkspaceManager(join(root, "ws-served")), { kit, webDist: join(root, "web"), serveUi: true, serve: { ref, tokenSecret: "MOON_GH" }, subscriptionPoll: false, servePoll: false, autoResume: false });
  };
  const status = async (s: Strut) => (await (await s.app.request("/serve", { headers: auth })).json()) as ServeStatus;
  const title = async (s: Strut) => /<title>([^<]*)<\/title>/.exec(await (await s.app.request("/")).text())?.[1];
  /** POST /serve/sync with no credential, as a webhook sends it. */
  const ping = async (s: Strut) => {
    const res = await s.app.request("/serve/sync", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push" }, body: JSON.stringify({ ref: "refs/heads/main" }) });
    return { status: res.status, body: (await res.json()) as PingOutcome & { error?: string } };
  };
  const settled = async (s: Strut, done: (st: ServeStatus) => boolean) => {
    let st = await status(s);
    for (let i = 0; i < 200 && !(done(st) && !st.deploying); i++) {
      await new Promise((r) => setTimeout(r, 50));
      st = await status(s);
    }
    return st;
  };

  it("serves the branch, and a commit plus POST /serve/sync serves the new version — at most one fetch a minute", async () => {
    const repo = await moonRepo();
    const first = git(repo.dir, "rev-parse", "HEAD");
    const ref = `git+${repo.url}@main`;
    strut = await bootServed(ref);
    const boot1 = await strut.serve!.sync();
    assert.notEqual(boot1.status, "error", boot1.error);
    let st = await status(strut);
    assert.equal(st.error, undefined, st.error);
    assert.deepEqual([st.ref, st.tokenSecret, st.serving?.commit, st.serving?.package], [ref, "MOON_GH", first, "acme/moon"]);
    const firstDigest = st.serving?.digest;
    assert.equal(await title(strut), "Moon one");
    const wf = await strut.workspace.getWorkflowMetadata("acme/moon/greet");
    assert.deepEqual([wf?.versions[wf.active]?.source, wf?.versions[wf.active]?.upstream?.commit], ["distro", first]);

    // A push to main, and the webhook.
    const second = repo.commit({ "serve.yaml": SERVE("Moon two"), "workflows/greet.yaml": GREET.replace("hi {{", "hello {{") }, "two");
    const pinged = await ping(strut);
    assert.equal(pinged.status, 202, pinged.body.error);
    assert.equal(pinged.body.status, "syncing");
    st = await settled(strut, (x) => x.serving?.commit === second);
    assert.equal(st.error, undefined, st.error);
    assert.equal(st.serving?.commit, second);
    assert.notEqual(st.serving?.digest, firstDigest);
    assert.equal(await title(strut), "Moon two");
    const upstream = (await strut.workspace.getWorkflowMetadata("acme/moon/greet"))!;
    assert.deepEqual([upstream.active, upstream.versions[upstream.active]?.upstream?.commit], ["v2", second], "the version the deploy wrote records its commit");

    // A second push inside the minute: no fetch now, one when it is up.
    repo.commit({ "serve.yaml": SERVE("Moon three") }, "three");
    const fetchedAt = (await status(strut)).fetchedAt;
    const again = await ping(strut);
    assert.equal(again.body.status, "queued");
    assert.ok(Date.parse(again.body.at) - Date.now() > 50_000, again.body.at);
    assert.deepEqual((await ping(strut)).body, again.body, "one waiting fetch, whatever the pings");
    await new Promise((r) => setTimeout(r, 200));
    st = await status(strut);
    assert.equal(st.fetchedAt, fetchedAt, "nothing fetched inside the minute");
    assert.equal(st.pingAt, again.body.at);
    assert.equal(await title(strut), "Moon two");
  });

  it("a commit that leaves the package's digest as it was deploys nothing; a bad ref is named on GET /serve", async () => {
    const repo = await moonRepo();
    strut = await bootServed(`git+${repo.url}@main`);
    assert.notEqual((await strut.serve!.sync()).status, "error");
    const before = await status(strut);

    // A dotfile is not in the digest: the commit moves, the package does not.
    const ci = repo.commit({ ".github/workflows/deploy.yml": "on: push\n" }, "ci");
    const out = await strut.serve!.sync();
    assert.equal(out.status, "current", out.error);
    const after = await status(strut);
    assert.equal(after.serving?.digest, before.serving?.digest);
    assert.equal(after.serving?.at, before.serving?.at, "nothing deployed");
    assert.equal(after.serving?.commit, ci, "the commit serving is the branch's, the same tree");
    assert.deepEqual(Object.keys((await strut.workspace.getWorkflowMetadata("acme/moon/greet"))?.versions ?? {}), ["v1"]);
    assert.equal((await strut.serve!.sync()).status, "current", "the same commit: nothing read out");

    // A commit that breaks serve.yaml: the previous deploy keeps serving.
    const broken = repo.commit({ "serve.yaml": "app: nope\n" }, "broken");
    assert.equal((await strut.serve!.sync()).status, "error");
    const st = await status(strut);
    assert.match(st.error ?? "", /serve_invalid: serve\.yaml: app: "nope"/);
    assert.equal(st.errorCommit, broken);
    assert.equal(st.serving?.commit, ci);
    assert.equal(await title(strut), "Moon one");
  });

  it("POST /serve/sync is open only on a served box", async () => {
    strut = await boot(new WorkspaceManager(join(root, "ws-plain")), { kit, subscriptionPoll: false, autoResume: false });
    assert.equal((await strut.app.request("/serve/sync", { method: "POST" })).status, 401);
    assert.equal((await strut.app.request("/serve/sync", { method: "POST", headers: auth })).status, 404);
  });
});
