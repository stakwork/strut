/**
 * The `git+` package SOURCE (plans/marketplace.md §5, plans/app-repos.md §2,
 * §4.7): `git+<repo url>[@<ref>][#<path>]` — a repository whose tree (at its
 * root, or under `#path`) is a package. The repo URL is anything
 * `git/checkout` takes (`parseRepo`: http(s) or `file://`, no credentials in
 * it); `<ref>` is a branch, a tag or a commit (the remote's default branch
 * when left out); `#path` is the folder that holds `strut.yaml`.
 *
 * Read through `git/checkout`'s own machinery: the credential-free bare
 * cache under `<dataDir>/repos/`, its per-cache lock, and the token only in
 * the child env behind the inline credential helper (src/steps/lib/git/
 * _shared.ts). The tree at the resolved commit is written out through a
 * throwaway index outside the cache (`read-tree` + `checkout-index`), so the
 * cache gains no worktree and no index, then read and hashed like any
 * package by the cache. The repository's ACL is the access control: a
 * private repo needs a token that can read it — the one for its host, in
 * the secret that serves the host (src/git-hosts.ts: `GITHUB_TOKEN` for
 * github.com, a package's `provides.git` for another), never a value in
 * the ref, and never a secret the caller names.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { shellCapability, type ShellCapability } from "../capabilities.js";
import { strutGitSecret, tokenHost, type GitSecretOf } from "../git-hosts.js";
import { cachePath, commitOf, fetchCache, git, parseRepo, remoteDefaultBranch, SHA_RE, withLock, type GitAuth, type RepoRef } from "../steps/lib/git/_shared.js";
import { MANIFEST_FILE } from "./format.js";

/** What a door says to a `tokenSecret` (gone 2026-11-20): no caller names
 *  the secret a repository is read with any more. */
export const TOKEN_SECRET_GONE =
  "tokenSecret is gone: a git+ ref is read with the run's token for its host — the secret that serves the host (GITHUB_TOKEN for github.com; a package's provides.git for another), its person's own first";

export interface GitPackageRef {
  /** The ref as written: what an install records and an update re-resolves. */
  ref: string;
  repo: RepoRef;
  /** A branch, tag or commit; absent: the remote's default branch. */
  rev?: string;
  /** The folder holding `strut.yaml`, `/`-separated; absent: the root. */
  path?: string;
}

const REV_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** `git+…` → its parts, or why it is not one. */
export function parseGitRef(ref: string): GitPackageRef | string {
  if (!ref.startsWith("git+")) return `${ref}: a git ref starts with git+`;
  const body = ref.slice("git+".length);
  const hash = body.indexOf("#");
  const beforeHash = hash < 0 ? body : body.slice(0, hash);
  const rawPath = hash < 0 ? undefined : body.slice(hash + 1);
  // The ref follows the last `@` past the scheme; a URL with credentials in
  // it (`user@host`) is refused by parseRepo anyway.
  const schemeEnd = beforeHash.indexOf("://");
  const at = beforeHash.lastIndexOf("@");
  const hasRev = at > schemeEnd + 2;
  const url = hasRev ? beforeHash.slice(0, at) : beforeHash;
  const rev = hasRev ? beforeHash.slice(at + 1) : undefined;
  let repo: RepoRef;
  try {
    repo = parseRepo(url);
  } catch (err) {
    return `${ref}: ${(err instanceof Error ? err.message : String(err)).replace(/^git: /, "")}`;
  }
  if (rev !== undefined) {
    if (!rev) return `${ref}: nothing after @ — name a branch, tag or commit, or leave @ out for the default branch`;
    if (!REV_RE.test(rev) || rev.includes("..") || rev.includes("//") || rev.endsWith("/") || rev.endsWith(".lock")) {
      return `${ref}: "${rev}" is not a branch, tag or commit name`;
    }
  }
  let path: string | undefined;
  if (rawPath !== undefined) {
    const segs = rawPath.split("/").filter(Boolean);
    if (!segs.length) return `${ref}: nothing after # — name the folder that holds ${MANIFEST_FILE}, or leave # out for the repository's root`;
    for (const s of segs) {
      if (!PATH_SEGMENT_RE.test(s) || s === "..") return `${ref}: "${rawPath}" is not a folder in the repository (letters, digits and . _ - in /-separated segments)`;
    }
    path = segs.join("/");
  }
  return { ref, repo, ...(rev ? { rev } : {}), ...(path ? { path } : {}) };
}

/** Why `ref` is not a branch a subscription can follow — a `git+` ref
 *  (`parseGitRef`) that names no full commit sha, which does not move — or
 *  nothing. A tag is only told from a branch after a fetch. */
export function branchRefProblem(ref: unknown): string | undefined {
  if (typeof ref !== "string") return "ref is git+https://host/org/repo[@<branch>][#<folder>]";
  const parsed = parseGitRef(ref);
  if (typeof parsed === "string") return `ref ${parsed}`;
  if (parsed.rev && /^[0-9a-f]{40}$/i.test(parsed.rev)) return `ref ${ref}: names a commit, which does not move — a subscription follows a branch`;
  return undefined;
}

/** The repository folder a `git+` ref reads, whatever its branch:
 *  `<host>/<owner>/<name>#<folder>`, lowercased. One package's identity
 *  across branches (a bundle lists one once; its part's id is made of it). */
export function refSource(parsed: GitPackageRef): string {
  return `${parsed.repo.host}/${parsed.repo.owner}/${parsed.repo.name}#${parsed.path ?? ""}`.toLowerCase();
}

/** The host a `git+` ref's token would be sent to (`github.com`);
 *  undefined for a repository no token may go to (`file://`, plain http to
 *  another machine), or a ref that is not one. */
export function gitHostOfRef(ref: string): string | undefined {
  const parsed = ref.startsWith("git+") ? parseGitRef(ref) : undefined;
  if (!parsed || typeof parsed === "string") return undefined;
  return tokenHost(parsed.repo.url);
}

export interface GitSourceOptions {
  /** Where `repos/` (the bare caches git/checkout keeps) lives. */
  dataDir: string;
  shell?: ShellCapability;
  /** Which secret serves the repository's host (src/git-hosts.ts): the
   *  box's map; default strut's own. */
  gitSecret?: GitSecretOf;
  /** Reads that secret as the caller may: the installer's view, a
   *  subscriber's own value, the deployment's. Absent: no token. */
  secret?(name: string): Promise<string | undefined>;
  /** A person's own machine (`STRUT_GIT_LOCAL`): with no token for the
   *  repository's host, git keeps this machine's own credentials. */
  gitLocal?: boolean;
  /** The ref must name a branch (a subscription follows one): a tag or a
   *  commit is refused. */
  branch?: boolean;
  timeoutMs?: number;
}

export interface GitFetched {
  ref: GitPackageRef;
  /** The commit the ref points at after the fetch. */
  commit: string;
  cacheDir: string;
}

/** Fetch the repository into its bare cache and resolve the ref to a
 *  commit. Under the cache's lock; `then` runs inside it with the result,
 *  so a reader of the commit's tree sees the cache as the fetch left it. */
export async function fetchGitRef<T>(ref: string, opts: GitSourceOptions, then: (got: GitFetched) => Promise<T>): Promise<T> {
  const parsed = parseGitRef(ref);
  if (typeof parsed === "string") throw new Error(`package_source_invalid: ${parsed}`);
  const shell = opts.shell ?? shellCapability();
  const cacheDir = cachePath(opts.dataDir, parsed.repo);
  // The token for the repository's host, from the secret that serves it.
  const host = tokenHost(parsed.repo.url);
  const secret = (opts.gitSecret ?? strutGitSecret)(parsed.repo.url);
  const token = secret ? (await opts.secret?.(secret)) || undefined : undefined;
  const auth: GitAuth | undefined = token && host ? { token, host } : undefined;
  const o = { ...(auth ? { auth } : opts.gitLocal ? { machine: true } : {}), timeoutMs: opts.timeoutMs ?? 600_000 };
  const masked = <E>(fn: () => Promise<E>) => maskToken(fn, token);
  return masked(() =>
    withLock(cacheDir, async () => {
      try {
        await fetchCache(shell, cacheDir, parsed.repo.url, o);
      } catch (err) {
        throw fetchError(ref, parsed.repo.url, err, { ...(auth ? { auth } : {}), ...(secret ? { secret } : {}) });
      }
      const rev = parsed.rev ?? (await remoteDefaultBranch(shell, cacheDir, o));
      if (!rev) throw new Error(`package_ref_not_found: ${ref}: ${parsed.repo.url} has no default branch — name a branch, tag or commit after @`);
      // The remote's branch first, then a tag, then a commit — never a
      // branch an agent made in the cache's working copies.
      const names = [`refs/remotes/origin/${rev}`, ...(opts.branch ? [] : [`refs/tags/${rev}`, ...(SHA_RE.test(rev) ? [rev] : [])])];
      let commit = await commitOf(shell, cacheDir, names, o);
      if (!commit && opts.branch) throw new Error(`package_ref_not_found: ${ref}: no branch "${rev}" in ${parsed.repo.url} — a subscription follows a branch, not a tag or a commit`);
      if (!commit && SHA_RE.test(rev) && rev.length === 40) {
        // A commit on no branch or tag: GitHub serves reachable shas.
        await git(shell, ["fetch", "--quiet", "origin", rev], { cwd: cacheDir, ...o });
        commit = await commitOf(shell, cacheDir, [rev], o);
      }
      if (!commit) throw new Error(`package_ref_not_found: ${ref}: no branch, tag or commit "${rev}" in ${parsed.repo.url}`);
      return then({ ref: parsed, commit, cacheDir });
    }),
  );
}

/** Write the package folder of `got`'s commit (its root, or `#path`) into
 *  `into`, which must not exist. Refuses a commit where that folder is
 *  missing or holds no `strut.yaml`. Call it inside `fetchGitRef`. */
export async function exportGitTree(got: GitFetched, into: string, opts: Pick<GitSourceOptions, "shell" | "timeoutMs">): Promise<void> {
  const shell = opts.shell ?? shellCapability();
  const { ref, commit, cacheDir } = got;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const where = ref.path ? `the folder ${ref.path}` : "the repository's root";
  const tree = ref.path ? `${commit}:${ref.path}` : `${commit}^{tree}`;
  const kind = await shell({ cmd: "git", args: ["cat-file", "-t", tree], cwd: cacheDir, timeoutMs });
  if (kind.code !== 0 || kind.stdout.trim() !== "tree") {
    throw new Error(`package_source_invalid: ${ref.ref}: ${where} is not in ${ref.repo.url} at ${commit}`);
  }
  // A throwaway index outside the cache: the bare repository gains nothing.
  await mkdir(into, { recursive: true });
  const index = `${into}.index-${randomBytes(4).toString("hex")}`;
  const env = { GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: "0" };
  try {
    for (const args of [["read-tree", tree], ["--work-tree", into, "checkout-index", "--all"]]) {
      const r = await shell({ cmd: "git", args, cwd: cacheDir, env, timeoutMs });
      if (r.code !== 0) throw new Error(`package_source_invalid: ${ref.ref}: could not read ${where} at ${commit}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    }
  } finally {
    await rm(index, { force: true });
  }
  if (!existsSync(join(into, MANIFEST_FILE))) {
    throw new Error(`package_source_invalid: ${ref.ref}: ${where} at ${commit} holds no ${MANIFEST_FILE}${ref.path ? "" : " — a package in a folder is named with #<folder> after the ref"}`);
  }
}

/** A failed fetch, named: no such repository, a credential refused, or
 *  one that did not answer. `secret`: the one that serves the host, if any. */
function fetchError(ref: string, url: string, err: unknown, used: { auth?: GitAuth; secret?: string }): Error {
  const detail = err instanceof Error ? err.message : String(err);
  if (/could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[13]|Invalid username or (password|token)/i.test(detail)) {
    const host = tokenHost(url);
    return new Error(
      used.auth
        ? `package_repo_denied: ${ref}: ${url} refused the token in ${used.secret} — it cannot read this repository, or the repository does not exist`
        : used.secret
          ? `package_repo_denied: ${ref}: ${url} asked for credentials — the repository is private or does not exist; set the secret ${used.secret} to a token that can read it`
          : `package_repo_denied: ${ref}: ${url} asked for credentials — the repository is private or does not exist, and no secret serves ${host ?? "it"} here${host ? ": a package declares the one that does (provides.git in its strut.yaml)" : " (a token goes over https alone)"}`,
    );
  }
  if (/repository .* not found|not found|does not appear to be a git repository|does not exist|Could not read from remote/i.test(detail)) {
    return new Error(`package_repo_not_found: ${ref}: no repository at ${url}`);
  }
  return new Error(`package_repo_unreachable: ${ref}: could not fetch ${url}: ${detail.replace(/^git fetch /, "").slice(-500)}`);
}

/** Run `fn`, and take the token out of anything it throws: git never prints
 *  it (it is in no argument or URL), and this keeps it that way. */
async function maskToken<T>(fn: () => Promise<T>, token: string | undefined): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (token && err instanceof Error && err.message.includes(token)) err.message = err.message.split(token).join("***");
    throw err;
  }
}
