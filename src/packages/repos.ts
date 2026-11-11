/**
 * REPOS — a package this strut works ON as a git checkout (plans/app-repos.md
 * §3): the round trip between the workspace, where the builder edits the
 * installed items, and a git repository, where people review and merge.
 *
 *   Open    a KEPT working copy of the repo's branch at
 *           `<dataDir>/packages/work/<publisher>/<name>/` — a worktree of
 *           `git/checkout`'s bare cache, on a branch of its own
 *           (`repo/<publisher>/<name>`) that tracks the remote's — and the
 *           package at its commit installed through the `repo` door.
 *   Create  a package BUILT from bare items (src/packages/build.ts), pushed
 *           as the first commit of an EMPTY remote, then opened. The bare
 *           originals stay; the answer names them, for the person to retire.
 *   Commit  the workspace's EDITS of the package — every item whose active
 *           version is not the one the repo door installed at the commit on
 *           file, and every item deleted here — written into the working
 *           copy (`packageFiles(…, { under })`), committed with the actor's
 *           identity and pushed: a new branch and a pull request, or the
 *           followed branch when asked. Then the commit is applied through
 *           the repo door, which stamps each version with it: no item is a
 *           fork any more.
 *   Pull    the edits committed locally first (nothing is lost, git has both
 *           sides), then git merges the remote's branch. A conflict stops
 *           there, names the files and installs nothing; the person resolves
 *           it in the working copy and pulls again, which concludes the merge.
 *           Otherwise the merged tree is applied through the repo door.
 *
 * Git merges, strut never does: strut writes files and applies trees. The
 * token is read from a named secret (the actor's first) and reaches git only
 * through `_shared.ts`' credential helper; `repos.json` keeps the secret's
 * NAME, and every error this module throws has the token masked out.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { shellCapability, type HttpCapability, type SecretsCapability, type ShellCapability } from "../capabilities.js";
import { cachePath, commitOf, fetchCache, git, gitOk, parseRepo, remoteDefaultBranch, withLock, type RepoRef } from "../steps/lib/git/_shared.js";
import { packagePrefixOf, type VersionSource } from "../workspace.js";
import { packageFiles, type BuildRequest, type WholeDeps } from "./build.js";
import type { CachedPackage, PackageCache } from "./cache.js";
import { PACKAGE_NAME } from "./format.js";
import { DEFAULT_TOKEN_SECRET, exportGitTree, parseGitRef, type GitPackageRef } from "./git-source.js";
import type { InstallResult } from "./install.js";
import { listInstalledPackages } from "./installed.js";

/** The repos on file, beside the package cache: `<dataDir>/packages/repos.json`. */
export const REPOS_FILE = "repos.json";

/** One repo on file. The package name is its id: a prefix holds one package. */
export interface RepoRecord {
  package: string;
  /** The repository, as `git/checkout` takes it (http(s) or `file://`). */
  url: string;
  /** The branch it follows: what Pull merges and a straight Commit pushes to. */
  branch: string;
  /** The folder holding `strut.yaml`; absent: the repository's root. */
  path?: string;
  /** `git+<url>@<branch>[#<path>]`: what each installed version's
   *  `upstream.source.ref` records. */
  ref: string;
  /** The commit last installed, and its package digest (kept in the cache). */
  commit: string;
  digest: string;
  /** The NAME of the secret its token is read from; never a value. */
  tokenSecret?: string;
  openedAt: string;
  by?: string;
  /** Create repo's: the bare items it was built from, offered for retirement. */
  originals?: RepoItem[];
  /** Set when a pull's merge stopped on a conflict: the commit that holds
   *  the workspace's edits. Until the merged tree is applied nothing more is
   *  written from the workspace — the merge supersedes those edits, and a
   *  person may conclude it by hand — and Commit waits for a Pull. */
  merge?: string;
}

export interface RepoItem {
  kind: "workflow" | "step" | "app" | "concept";
  name: string;
}

/** A repo as a person reads it: the record, where its working copy is, what
 *  the workspace changed since the commit installed, and a merge waiting. */
export interface RepoView extends RepoRecord {
  workdir: string;
  forked: RepoItem[];
  deleted: RepoItem[];
  /** Files a pull's merge left in conflict, waiting for the person. */
  conflict?: string[];
}

export interface ReposDeps {
  dataDir: string;
  cache: PackageCache;
  /** What `packageFiles(…, { under })` and the installed fold read. */
  files: WholeDeps;
  shell?: ShellCapability;
  /** For the token's GitHub identity (a commit's author). */
  http?: HttpCapability;
  secrets?: SecretsCapability;
  /** Install a tree the cache holds through the `repo` door. */
  install(ref: string, opts: { digest: string; commit: string; actor?: string }): Promise<InstallResult>;
  /** Build a package into the cache (Create repo; src/packages/build.ts). */
  build?(req: BuildRequest): Promise<CachedPackage>;
  /** Remove a bare original (a workflow, step or app). */
  retire?(item: RepoItem): Promise<void>;
  /** Open a pull request on GitHub (default: Octokit, as github/create-pr). */
  pullRequest?(a: { owner: string; repo: string; head: string; base: string; title: string; body?: string }, token: string): Promise<{ url: string; number: number; created: boolean }>;
  now?(): Date;
}

export interface OpenInput {
  url: string;
  /** A branch (default: the remote's default branch). */
  ref?: string;
  path?: string;
  tokenSecret?: string;
  actor?: string;
}

export interface CreateInput extends Omit<BuildRequest, "requires"> {
  url: string;
  /** The branch the first commit makes (default `main`). */
  branch?: string;
  path?: string;
  tokenSecret?: string;
  actor?: string;
}

export interface CommitInput {
  message: string;
  /** Where to push: absent, a new branch; the followed branch, straight to it. */
  branch?: string;
  /** A pull request for a branch that is not the followed one (default true). */
  pr?: boolean;
  actor?: string;
}

/** What a Commit (or its preview) changes in the working copy. */
export interface RepoDiff {
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  stat: string;
  patch: string;
  truncated?: boolean;
}

export interface CommitResult {
  package: string;
  /** False: nothing changed here and nothing waited to be pushed. */
  committed: boolean;
  commit: string;
  branch?: string;
  pushed?: boolean;
  pr?: { url: string; number: number; created: boolean };
  /** Why no pull request was opened for a new branch. */
  prSkipped?: string;
  diff: RepoDiff;
  /** The items that were forks and are now the package's. */
  stamped: RepoItem[];
  install?: InstallResult;
}

export interface PullResult {
  package: string;
  commit: string;
  /** The commit that holds the workspace's edits, made before the merge. */
  local?: string;
  /** Files git could not merge: nothing is installed, the working copy holds the markers. */
  conflict?: string[];
  install?: InstallResult;
}

export interface Repos {
  list(): Promise<RepoView[]>;
  get(pkg: string): Promise<RepoView | undefined>;
  open(input: OpenInput): Promise<RepoView & { install: InstallResult }>;
  create(input: CreateInput): Promise<RepoView & { install: InstallResult; originals: RepoItem[] }>;
  diff(pkg: string): Promise<RepoDiff>;
  commit(pkg: string, input: CommitInput): Promise<CommitResult>;
  pull(pkg: string, opts?: { actor?: string }): Promise<PullResult>;
  retire(pkg: string, items: RepoItem[]): Promise<{ retired: RepoItem[]; failed: Array<RepoItem & { error: string }> }>;
  close(pkg: string): Promise<boolean>;
}

/** The working copy's branch: its own, so no other worktree of the cache
 *  ever holds it, tracking the remote's followed branch. */
const localBranch = (pkg: string) => `repo/${pkg}`;
const PATCH_MAX = 200_000;
const GIT_TIMEOUT = 600_000;
const refusal = (code: string, message: string) => new Error(`${code}: ${message}`);

export function createRepos(deps: ReposDeps): Repos {
  const shell = deps.shell ?? shellCapability();
  const file = join(deps.cache.root, REPOS_FILE);
  const workdirOf = (pkg: string) => join(deps.cache.root, "work", ...pkg.split("/"));
  const pkgDirOf = (rec: Pick<RepoRecord, "package" | "path">) => (rec.path ? join(workdirOf(rec.package), ...rec.path.split("/")) : workdirOf(rec.package));
  const pathspec = (rec: Pick<RepoRecord, "path">) => rec.path ?? ".";

  const readAll = async (): Promise<RepoRecord[]> => {
    try {
      return ((JSON.parse(await readFile(file, "utf8")) as { repos?: RepoRecord[] }).repos ?? []).filter((r) => typeof r?.package === "string");
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  };
  const writeAll = async (repos: RepoRecord[]) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify({ repos: repos.sort((a, b) => a.package.localeCompare(b.package)) }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  };
  const record = async (pkg: string): Promise<RepoRecord> => {
    const rec = (await readAll()).find((r) => r.package === pkg);
    if (!rec) throw refusal("package_repo_not_open", `${pkg} is not opened here as a repo (POST /packages/repos)`);
    return rec;
  };
  const save = async (rec: RepoRecord) => writeAll([...(await readAll()).filter((r) => r.package !== rec.package), rec]);

  /** The token for a repo, read as the actor when the deployment keeps
   *  per-actor secrets; undefined for none. */
  const tokenOf = async (secretName: string | undefined, actor: string | undefined): Promise<string | undefined> => {
    const view = actor && deps.secrets?.forPrincipal ? deps.secrets.forPrincipal(actor) : deps.secrets;
    return (await view?.get(secretName ?? DEFAULT_TOKEN_SECRET).catch(() => undefined)) || undefined;
  };
  /** Run `fn` and take the token out of anything it throws. */
  const masked = async <T>(token: string | undefined, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (token && err instanceof Error && err.message.includes(token)) err.message = err.message.split(token).join("***");
      throw err;
    }
  };

  /** Who a commit is by: the token's GitHub identity on github.com (as
   *  git/push), else the actor, at an address that is no one's. */
  const identityOf = async (repo: RepoRef, token: string | undefined, actor: string | undefined): Promise<string[]> => {
    let name = actor || "strut";
    let email = "strut@strut.invalid";
    if (token && repo.host === "github.com" && deps.http) {
      const res = await deps.http("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "strut" },
        timeout: 30_000,
      });
      const user = res.body as { login?: unknown; id?: unknown } | undefined;
      if (res.status === 401 || res.status === 403) throw refusal("no_push_permission", `GitHub rejected the token (HTTP ${res.status})`);
      if (res.ok && typeof user?.login === "string" && typeof user.id === "number") {
        name = user.login;
        email = `${user.id}+${user.login}@users.noreply.github.com`;
      }
    }
    return ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false"];
  };

  const run = (args: string[], cwd: string, token?: string) => git(shell, args, { cwd, timeoutMs: GIT_TIMEOUT, ...(token ? { token } : {}) });
  const ok = (args: string[], cwd: string, token?: string) => gitOk(shell, args, { cwd, timeoutMs: GIT_TIMEOUT, ...(token ? { token } : {}) });
  /** A commit with the message on stdin (a title starting with "-" is no flag). */
  const commitAs = async (cwd: string, identity: string[], message: string, extra: string[] = []) => {
    const r = await shell({ cmd: "git", args: [...identity, "commit", "--quiet", ...extra, "-F", "-"], cwd, stdin: `${message.trim()}\n`, timeoutMs: GIT_TIMEOUT });
    if (r.code !== 0) throw new Error(`git commit failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  };

  const parsedOf = (rec: RepoRecord): GitPackageRef => {
    const parsed = parseGitRef(rec.ref);
    if (typeof parsed === "string") throw refusal("package_source_invalid", parsed);
    return parsed;
  };

  /** The package at `commit` (its folder) into the cache. Inside the cache's lock. */
  const treeOf = async (parsed: GitPackageRef, commit: string, cacheDir: string): Promise<CachedPackage> => {
    const out = join(deps.cache.root, ".scratch", `repo-${randomBytes(8).toString("hex")}`);
    try {
      await exportGitTree({ ref: parsed, commit, cacheDir }, out, { shell });
      return await deps.cache.putDir(out);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };

  /** Files a merge left unmerged. */
  const unmerged = async (work: string): Promise<string[]> => (await ok(["diff", "--name-only", "--diff-filter=U"], work)).split("\n").filter(Boolean);
  const merging = async (work: string): Promise<boolean> => {
    const r = await run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], work);
    return r.code === 0;
  };

  /** What the workspace changed since the commit on file: an item whose
   *  active version the repo door did not write at that commit (a fork, an
   *  older version made active), a Concept edited here or added under the
   *  package's pages; and the items the commit holds that are gone here. */
  const edits = async (rec: RepoRecord): Promise<{ forked: RepoItem[]; deleted: RepoItem[]; baseline: CachedPackage | undefined }> => {
    const { workspace, graph } = deps.files;
    const prefix = `${rec.package}/`;
    const atCommit = (v: { source?: VersionSource; upstream?: { commit?: string } } | undefined) => v?.source === "repo" && v.upstream?.commit === rec.commit;
    const forked: RepoItem[] = [];
    const here = new Set<string>();
    for (const w of await workspace.listWorkflows()) {
      if (!w.name.startsWith(prefix)) continue;
      here.add(`workflow:${w.name}`);
      const meta = await workspace.getWorkflowMetadata(w.name);
      if (!atCommit(meta?.versions[meta.active])) forked.push({ kind: "workflow", name: w.name });
    }
    for (const type of Object.keys(await workspace.getActiveStepHashes())) {
      if (!type.startsWith(prefix)) continue;
      here.add(`step:${type}`);
      const meta = await workspace.getStepMetadata(type);
      if (!atCommit(meta?.versions[meta.active])) forked.push({ kind: "step", name: type });
    }
    for (const a of await workspace.listApps()) {
      if (!a.name.startsWith(prefix)) continue;
      here.add(`app:${a.name}`);
      const rec2 = await workspace.getApp(a.name);
      if (!atCommit(rec2?.versions[rec2.active])) forked.push({ kind: "app", name: a.name });
    }
    if (graph) {
      const pkg = (await listInstalledPackages(deps.files)).find((p) => p.package === rec.package);
      for (const c of pkg?.items.filter((i) => i.kind === "concept") ?? []) {
        here.add(`concept:${c.name}`);
        if (c.modified !== false) forked.push({ kind: "concept", name: c.name });
      }
    }
    const baseline = await deps.cache.get(rec.digest).catch(() => undefined);
    const deleted: RepoItem[] = [];
    for (const i of baseline?.items ?? []) {
      if (i.kind === "type" || (i.kind === "concept" && !graph)) continue;
      if (!here.has(`${i.kind}:${i.name}`)) deleted.push({ kind: i.kind, name: i.name });
    }
    return { forked, deleted, baseline };
  };

  /** Write the workspace's edits into the working copy's package folder:
   *  each edited item's files, an edited app's folder whole, a page under
   *  its key (its old file gone when that was another), and a deleted
   *  item's files removed. Returns what it found. */
  const writeEdits = async (rec: RepoRecord): Promise<{ forked: RepoItem[]; deleted: RepoItem[]; warnings: string[] }> => {
    const found = await edits(rec);
    const dir = pkgDirOf(rec);
    const edited = new Set(found.forked.map((i) => `${i.kind}:${i.name}`));
    const pageFiles = new Map((found.baseline?.items ?? []).filter((i) => i.kind === "concept").map((i) => [i.name, i.path]));
    const remove = async (rel: string) => rm(join(dir, ...rel.split("/")), { recursive: true, force: true });
    const out = edited.size ? await packageFiles(deps.files, { under: rec.package }) : undefined;
    // An edited app is written whole: a file it dropped goes.
    for (const i of found.forked.filter((x) => x.kind === "app")) await remove(`apps/${i.name.slice(rec.package.length + 1)}`);
    for (const [rel, body] of out?.files ?? []) {
      const item = out!.items!.get(rel);
      if (!item || !edited.has(`${item.kind}:${item.name}`)) continue;
      if (item.kind === "concept") {
        const old = pageFiles.get(item.name);
        if (old && old !== rel) await remove(old);
      }
      const to = join(dir, ...rel.split("/"));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, body);
    }
    for (const i of found.deleted) {
      const at = found.baseline!.items.find((x) => x.kind === i.kind && x.name === i.name)!;
      await remove(at.path);
      if (at.claims) await remove(at.claims);
    }
    return { forked: found.forked, deleted: found.deleted, warnings: out?.warnings ?? [] };
  };

  const diffOf = async (work: string, range: string[], spec: string): Promise<RepoDiff> => {
    const names = (await ok(["diff", "--name-status", "--no-renames", ...range, "--", spec], work)).split("\n").filter(Boolean);
    const files = names.map((l) => {
      const [code, ...rest] = l.split("\t");
      return { path: rest.join("\t"), status: (code === "A" ? "added" : code === "D" ? "deleted" : "modified") as RepoDiff["files"][number]["status"] };
    });
    const stat = (await ok(["diff", "--stat", "--no-renames", ...range, "--", spec], work)).trimEnd();
    const full = await ok(["diff", "--no-renames", "--no-color", ...range, "--", spec], work);
    return { files, stat, patch: full.length > PATCH_MAX ? full.slice(0, PATCH_MAX) : full, ...(full.length > PATCH_MAX ? { truncated: true } : {}) };
  };

  const view = async (rec: RepoRecord): Promise<RepoView> => {
    const work = workdirOf(rec.package);
    const { forked, deleted } = await edits(rec);
    const waiting = existsSync(join(work, ".git")) && (await merging(work)) ? await unmerged(work) : undefined;
    return { ...rec, workdir: work, forked, deleted, ...(waiting?.length ? { conflict: waiting } : {}) };
  };

  /** Apply the working copy's HEAD through the repo door and put it on file. */
  const apply = async (rec: RepoRecord, actor: string | undefined): Promise<{ rec: RepoRecord; install: InstallResult }> => {
    const work = workdirOf(rec.package);
    const parsed = parsedOf(rec);
    const cacheDir = cachePath(deps.dataDir, parsed.repo);
    const head = (await ok(["rev-parse", "HEAD"], work)).trim();
    const tree = await withLock(cacheDir, () => treeOf(parsed, head, cacheDir));
    if (tree.manifest.package !== rec.package) {
      throw refusal("package_name_mismatch", `the working copy now holds the package ${tree.manifest.package}, not ${rec.package} — a repo is one package; strut.yaml's package must stay`);
    }
    const install = await deps.install(rec.ref, { digest: tree.digest, commit: head, ...(actor ? { actor } : {}) });
    const { merge: _m, ...kept } = rec;
    const next = { ...kept, commit: head, digest: tree.digest };
    await save(next);
    return { rec: next, install };
  };

  const open = async (input: OpenInput, originals?: RepoItem[]): Promise<RepoView & { install: InstallResult }> => {
    const asked = parseGitRef(`git+${input.url.trim().replace(/\/+$/, "")}${input.ref ? `@${input.ref}` : ""}${input.path ? `#${input.path}` : ""}`);
    if (typeof asked === "string") throw refusal("package_source_invalid", asked);
    const token = await tokenOf(input.tokenSecret, input.actor);
    return masked(token, async () => {
      const cacheDir = cachePath(deps.dataDir, asked.repo);
      const o = { ...(token ? { token } : {}), timeoutMs: GIT_TIMEOUT };
      const { branch, commit, tree } = await withLock(cacheDir, async () => {
        try {
          await fetchCache(shell, cacheDir, asked.repo.url, o);
        } catch (err) {
          throw refusal("package_repo_unreachable", `could not fetch ${asked.repo.url}: ${err instanceof Error ? err.message.slice(-500) : String(err)}`);
        }
        const branch = asked.rev ?? (await remoteDefaultBranch(shell, cacheDir, o));
        if (!branch) throw refusal("package_repo_empty", `${asked.repo.url} has no branch yet — Create repo pushes a package to an empty repository`);
        const commit = await commitOf(shell, cacheDir, [`refs/remotes/origin/${branch}`], o);
        if (!commit) throw refusal("package_repo_branch", `${branch} is not a branch of ${asked.repo.url}: a repo is opened on a branch, which Commit and Pull follow`);
        return { branch, commit, tree: await treeOf(asked, commit, cacheDir) };
      });
      const pkg = tree.manifest.package;
      if ((await readAll()).some((r) => r.package === pkg)) throw refusal("package_repo_open", `${pkg} is opened here already — one repo per package`);
      const ref = `git+${asked.repo.url}@${branch}${asked.path ? `#${asked.path}` : ""}`;
      const work = workdirOf(pkg);
      const local = localBranch(pkg);
      await withLock(cacheDir, async () => {
        // A working copy left by a repo closed or opened halfway goes first.
        await run(["worktree", "remove", "--force", "--force", work], cacheDir);
        await rm(work, { recursive: true, force: true });
        await run(["worktree", "prune"], cacheDir);
        await mkdir(dirname(work), { recursive: true });
        await ok(["worktree", "add", "--quiet", "-B", local, work, commit], cacheDir);
        await ok(["branch", "--quiet", `--set-upstream-to=origin/${branch}`, local], work);
      });
      const rec: RepoRecord = {
        package: pkg,
        url: asked.repo.url,
        branch,
        ...(asked.path ? { path: asked.path } : {}),
        ref,
        commit,
        digest: tree.digest,
        ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}),
        openedAt: (deps.now?.() ?? new Date()).toISOString(),
        ...(input.actor ? { by: input.actor } : {}),
        ...(originals?.length ? { originals } : {}),
      };
      let install: InstallResult;
      try {
        install = await deps.install(ref, { digest: tree.digest, commit, ...(input.actor ? { actor: input.actor } : {}) });
      } catch (err) {
        await removeWorkdir(pkg, cacheDir);
        throw err;
      }
      await save(rec);
      return { ...(await view(rec)), install };
    });
  };

  const removeWorkdir = async (pkg: string, cacheDir: string) => {
    const work = workdirOf(pkg);
    await withLock(cacheDir, async () => {
      if (existsSync(join(cacheDir, "HEAD"))) {
        await run(["worktree", "remove", "--force", "--force", work], cacheDir);
        await run(["worktree", "prune"], cacheDir);
        await run(["branch", "-D", localBranch(pkg)], cacheDir);
      }
      await rm(work, { recursive: true, force: true });
    });
  };

  return {
    async list() {
      return Promise.all((await readAll()).map(view));
    },
    async get(pkg) {
      const rec = (await readAll()).find((r) => r.package === pkg);
      return rec ? view(rec) : undefined;
    },
    open: (input) => open(input),

    async create(input) {
      if (!deps.build) throw refusal("package_unsupported", "this strut server builds no packages");
      if (!PACKAGE_NAME.test(input.package ?? "")) throw refusal("package_build_refused", "a package is named publisher/name: two lowercase segments, [a-z][a-z0-9-]*");
      const repo = parseRepo(input.url);
      const branch = input.branch ?? "main";
      const asked = parseGitRef(`git+${repo.url}@${branch}${input.path ? `#${input.path}` : ""}`);
      if (typeof asked === "string") throw refusal("package_source_invalid", asked);
      if ((await readAll()).some((r) => r.package === input.package)) throw refusal("package_repo_open", `${input.package} is opened here already`);
      const { url: _u, branch: _b, path: _p, tokenSecret: _t, actor: _a, ...req } = input;
      const built = await deps.build(req);
      const token = await tokenOf(input.tokenSecret, input.actor);
      await masked(token, async () => {
        const scratch = join(deps.cache.root, ".scratch", `create-${randomBytes(8).toString("hex")}`);
        await mkdir(scratch, { recursive: true });
        try {
          const remote = await run(["ls-remote", "--heads", "--tags", repo.url], scratch, token);
          if (remote.code !== 0) throw refusal("package_repo_unreachable", `could not reach ${repo.url}: ${(remote.stderr || remote.stdout).trim().slice(-500)}`);
          if (remote.stdout.trim()) throw refusal("package_repo_not_empty", `${repo.url} has commits already — Create repo pushes to an EMPTY repository; open one that holds a package with Open repo`);
          await ok(["init", "--quiet", "-b", branch], scratch);
          const into = input.path ? join(scratch, ...input.path.split("/")) : scratch;
          for (const rel of built.files) {
            const to = join(into, ...rel.split("/"));
            await mkdir(dirname(to), { recursive: true });
            await copyFile(join(built.dir, ...rel.split("/")), to);
          }
          await ok(["add", "-A"], scratch);
          await commitAs(scratch, await identityOf(repo, token, input.actor), `${input.package} ${input.version}\n\nCreated from a strut workspace.`);
          const push = await run(["push", "--quiet", repo.url, `HEAD:refs/heads/${branch}`], scratch, token);
          if (push.code !== 0) throw refusal("push_rejected", `the push to ${repo.url} failed — ${(push.stderr || push.stdout).trim().slice(-500)}`);
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      });
      // The bare items the package was built from: what the person may retire.
      const prefix = `${input.package}/`;
      const originals: RepoItem[] = [];
      for (const i of built.items) {
        if (i.kind !== "workflow" && i.kind !== "step" && i.kind !== "app") continue;
        const bare = i.name.slice(prefix.length);
        const ws = deps.files.workspace;
        const exists = i.kind === "workflow" ? !!(await ws.getWorkflowMetadata(bare)) : i.kind === "step" ? !!(await ws.getStepMetadata(bare)) : !!(await ws.getApp(bare));
        if (exists && !packagePrefixOf(bare)) originals.push({ kind: i.kind, name: bare });
      }
      const opened = await open({ url: repo.url, ref: branch, ...(input.path ? { path: input.path } : {}), ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}), ...(input.actor ? { actor: input.actor } : {}) }, originals);
      return { ...opened, originals };
    },

    async diff(pkg) {
      const rec = await record(pkg);
      const work = workdirOf(pkg);
      const cacheDir = cachePath(deps.dataDir, parsedOf(rec).repo);
      return withLock(cacheDir, async () => {
        if (rec.merge || (await merging(work))) throw refusal("package_repo_merging", `a pull's merge waits in the working copy (${(await unmerged(work)).join(", ") || "resolved"}) — resolve it and Pull`);
        await writeEdits(rec);
        await ok(["add", "-A", "--", pathspec(rec)], work);
        return diffOf(work, ["--cached", "HEAD"], pathspec(rec));
      });
    },

    async commit(pkg, input) {
      const message = input.message?.trim();
      if (!message) throw refusal("package_repo_message", "a commit has a message: what changed");
      const rec = await record(pkg);
      const parsed = parsedOf(rec);
      const work = workdirOf(pkg);
      const cacheDir = cachePath(deps.dataDir, parsed.repo);
      const token = await tokenOf(rec.tokenSecret, input.actor);
      const straight = input.branch === rec.branch;
      return masked(token, async () => {
        const done = await withLock(cacheDir, async () => {
          if (rec.merge || (await merging(work))) throw refusal("package_repo_merging", `a pull's merge waits in the working copy (${(await unmerged(work)).join(", ") || "resolved"}) — resolve it and Pull first`);
          const found = await writeEdits(rec);
          await ok(["add", "-A", "--", pathspec(rec)], work);
          const staged = await run(["diff", "--cached", "--quiet"], work);
          if (staged.code !== 0 && staged.code !== 1) throw new Error(`git diff --cached failed: ${(staged.stderr || staged.stdout).trim().slice(-2000)}`);
          if (staged.code === 1) await commitAs(work, await identityOf(parsed.repo, token, input.actor), message);
          const head = (await ok(["rev-parse", "HEAD"], work)).trim();
          const base = `refs/remotes/origin/${rec.branch}`;
          const ahead = (await run(["merge-base", "--is-ancestor", "HEAD", base], work)).code !== 0;
          const diff = await diffOf(work, [`${base}...HEAD`], pathspec(rec));
          if (!ahead) return { head, diff, found, pushed: false as const };
          const target = straight ? rec.branch : (input.branch ?? `strut/${pkg.split("/")[1]}-${head.slice(0, 8)}`);
          if ((await run(["check-ref-format", "--branch", target], work)).code !== 0) throw refusal("package_repo_branch", `"${target}" is not a valid branch name`);
          const push = await run(["push", "--quiet", "origin", `HEAD:refs/heads/${target}`], work, token);
          if (push.code !== 0) {
            const detail = (push.stderr || push.stdout).trim().slice(-1000);
            if (/\b(401|403)\b|authentication failed|permission .*denied|could not read username/i.test(detail)) throw refusal("no_push_permission", `the push to ${rec.url} was refused — ${detail}`);
            throw refusal(
              "push_rejected",
              `the push to ${target} on ${rec.url} failed${straight && /non-fast-forward|fetch first|rejected/i.test(detail) ? ` — ${rec.branch} moved on the remote: Pull, then Commit again` : ""} — ${detail}`,
            );
          }
          // (git moves origin/<target> with the push: the cache tracks refs/heads/*.)
          return { head, diff, found, pushed: true as const, target };
        });
        if (!done.pushed && done.head === rec.commit) {
          return { package: pkg, committed: false, commit: done.head, diff: done.diff, stamped: [] };
        }
        let pr: CommitResult["pr"];
        let prSkipped: string | undefined;
        if (done.pushed && !straight && input.pr !== false) {
          if (parsed.repo.host !== "github.com") prSkipped = `${rec.url} is not on GitHub: open the pull request there`;
          else if (!token) prSkipped = `no token in ${rec.tokenSecret ?? DEFAULT_TOKEN_SECRET} to open a pull request with`;
          else pr = await (deps.pullRequest ?? githubPullRequest)({ owner: parsed.repo.owner, repo: parsed.repo.name, head: done.target!, base: rec.branch, title: message.split("\n")[0]!, body: message.split("\n").slice(1).join("\n").trim() || `From ${pkg}, committed in strut.` }, token);
        }
        // The commit applied through the repo door: every item stamped with it.
        const { install } = await apply(rec, input.actor);
        return {
          package: pkg,
          committed: true,
          commit: done.head,
          ...(done.pushed ? { branch: done.target, pushed: true } : { pushed: false }),
          ...(pr ? { pr } : {}),
          ...(prSkipped ? { prSkipped } : {}),
          diff: done.diff,
          stamped: done.found.forked,
          install,
        };
      });
    },

    async pull(pkg, opts = {}) {
      const rec = await record(pkg);
      const parsed = parsedOf(rec);
      const work = workdirOf(pkg);
      const cacheDir = cachePath(deps.dataDir, parsed.repo);
      const token = await tokenOf(rec.tokenSecret, opts.actor);
      return masked(token, async () => {
        const step = await withLock(cacheDir, async (): Promise<{ conflict?: string[]; local?: string }> => {
          const identity = await identityOf(parsed.repo, token, opts.actor);
          if (await merging(work)) {
            // A merge a person resolved: concluded, never written over.
            const left = await unmerged(work);
            if (left.length) return { conflict: left };
            await commitAs(work, identity, `Merge ${rec.branch} of ${rec.url}`, ["--no-verify"]);
          }
          // The workspace's edits first, as a commit of their own — unless a
          // merge stopped on them already: then the working copy holds them,
          // and the merge (concluded above, or by hand) is what goes on.
          let local: string | undefined;
          if (!rec.merge) {
            await writeEdits(rec);
            await ok(["add", "-A", "--", pathspec(rec)], work);
            if ((await run(["diff", "--cached", "--quiet"], work)).code === 1) {
              await commitAs(work, identity, `Edits in strut before pulling ${rec.branch}`);
              local = (await ok(["rev-parse", "HEAD"], work)).trim();
            }
          }
          try {
            await fetchCache(shell, cacheDir, rec.url, { ...(token ? { token } : {}), timeoutMs: GIT_TIMEOUT });
          } catch (err) {
            throw refusal("package_repo_unreachable", `could not fetch ${rec.url}: ${err instanceof Error ? err.message.slice(-500) : String(err)}`);
          }
          const merge = await shell({ cmd: "git", args: [...identity, "merge", "--no-edit", `refs/remotes/origin/${rec.branch}`], cwd: work, timeoutMs: GIT_TIMEOUT });
          if (merge.code !== 0) {
            const left = await unmerged(work);
            if (left.length) return { conflict: left, ...(local ? { local } : {}) };
            throw new Error(`git merge failed: ${(merge.stderr || merge.stdout).trim().slice(-2000)}`);
          }
          return local ? { local } : {};
        });
        if (step.conflict) {
          const head = (await ok(["rev-parse", "HEAD"], work)).trim();
          if (!rec.merge) await save({ ...rec, merge: head });
          return { package: pkg, commit: head, conflict: step.conflict, ...(step.local ? { local: step.local } : {}) };
        }
        const { rec: next, install } = await apply(rec, opts.actor);
        return { package: pkg, commit: next.commit, ...(step.local ? { local: step.local } : {}), install };
      });
    },

    async retire(pkg, items) {
      const rec = await record(pkg);
      if (!deps.retire) throw refusal("package_unsupported", "this strut server retires nothing");
      const offered = new Set((rec.originals ?? []).map((i) => `${i.kind}:${i.name}`));
      const retired: RepoItem[] = [];
      const failed: Array<RepoItem & { error: string }> = [];
      for (const item of items) {
        if (!offered.has(`${item.kind}:${item.name}`)) {
          failed.push({ ...item, error: `not one of the items ${pkg} was created from` });
          continue;
        }
        try {
          await deps.retire(item);
          retired.push(item);
        } catch (err) {
          failed.push({ ...item, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const gone = new Set(retired.map((i) => `${i.kind}:${i.name}`));
      const left = (rec.originals ?? []).filter((i) => !gone.has(`${i.kind}:${i.name}`));
      const { originals: _o, ...rest } = rec;
      await save(left.length ? { ...rest, originals: left } : rest);
      return { retired, failed };
    },

    async close(pkg) {
      const rec = (await readAll()).find((r) => r.package === pkg);
      if (!rec) return false;
      await removeWorkdir(pkg, cachePath(deps.dataDir, parsedOf(rec).repo));
      await writeAll((await readAll()).filter((r) => r.package !== pkg));
      return true;
    },
  };
}

/** Open (or find) a pull request with the token, as github/create-pr does. */
async function githubPullRequest(a: { owner: string; repo: string; head: string; base: string; title: string; body?: string }, token: string) {
  const { Octokit } = await import("@octokit/rest");
  const { openPullRequest } = await import("../steps/lib/github/create-pr.js");
  const r = await openPullRequest(new Octokit({ auth: token }) as never, a);
  return { url: r.url, number: r.number, created: r.created };
}
