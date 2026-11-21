/**
 * Shared helpers for the `git/*` lib steps (plans/code-change.md §3.3).
 *
 * Every git invocation goes through `ctx.services.shell` — recordable, and
 * the child env is scrubbed by construction. The one credential a step may
 * hold — the run's token for the repository's host (`gitAuth`: the secret
 * that serves the host, src/git-hosts.ts) — reaches git in exactly one way:
 * the child env (`STRUT_GIT_TOKEN`), read by an inline `credential.helper`
 * that is passed with `-c` and answers only for that host
 * (`STRUT_GIT_HOST`), so a redirect to another host gets nothing. It is
 * never an argument, never in a URL, never in a repository's config. And
 * git gets no credential but the run's, token or not: the helper list is
 * RESET on every command, and git reads none of the machine's own — no
 * keychain, no `~/.gitconfig`, `~/.netrc` or askpass, no ssh key
 * (`credentialArgs`, `gitEnv`). With no token a private repository fails;
 * the machine's user never stands in. A checkout carries no credential
 * either: an agent's `bash` in it cannot push, whatever it tries.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StepContext } from "../../../core.js";
import { withLock } from "../../../jobs.js";
import { gitTokens, gitVia, shellCapability, type HttpCapability, type SecretsCapability, type ShellCapability, type ShellResult, type StrutCapabilities } from "../../../capabilities.js";
import { tokenHost } from "../../../git-hosts.js";

// One writer per cache: the same in-process lock the job directory uses
// (jobs.ts) — two runs of one repository fetch and add worktrees one after
// the other, never interleaved.
export { withLock };

export type GitCtx = StepContext<StrutCapabilities>;

/** The child-env variables the inline credential helper reads: the token,
 *  and the one host it answers for. */
export const TOKEN_ENV = "STRUT_GIT_TOKEN";
export const HOST_ENV = "STRUT_GIT_HOST";

/** A token and the host it serves: what git is handed for one remote. */
export interface GitAuth {
  token: string;
  /** As `tokenHost` gives it: lowercase, with `:port` when not the default. */
  host: string;
  /** Read through a package step's view: the run's own shell and http, the
   *  only doors the token goes through — never a shell or http the step put
   *  in the ctx it called a git step with (src/packages/fence.ts). */
  shell?: ShellCapability;
  http?: HttpCapability;
}

/** The run's credential for the repository at `url`: the token for its
 *  host (`secrets.git`, src/git-hosts.ts), or undefined — a host no secret
 *  serves, a URL a token may not go to, or no value. Read through
 *  `gitTokens`, so it is the run's even when a package's step calls. */
export async function gitAuth(secrets: SecretsCapability | undefined, url: string): Promise<GitAuth | undefined> {
  const host = tokenHost(url);
  if (!host || !secrets) return undefined;
  const token = await gitTokens(secrets)(url);
  if (!token) return undefined;
  const via = gitVia(secrets);
  return { token, host, ...(via?.shell ? { shell: via.shell } : {}), ...(via?.http ? { http: via.http } : {}) };
}

/** `gitAuth` from a step's ctx. */
export const gitAuthOf = (ctx: GitCtx, url: string): Promise<GitAuth | undefined> =>
  gitAuth((ctx.services as Partial<StrutCapabilities> | undefined)?.secrets, url);

// ── the repository ────────────────────────────────────────────────────────

export interface RepoRef {
  /** The URL as git will see it (trimmed, no trailing slash). */
  url: string;
  /** `github.com`, or `local` for a file URL. */
  host: string;
  /** Path segments before the name, joined by `/` (an org, or a file path). */
  owner: string;
  /** The last path segment, `.git` stripped. */
  name: string;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse an http(s) or file repository URL. No credentials in the URL (the
 *  token comes from the secret store), no ssh (a token cannot be used). */
export function parseRepo(raw: string): RepoRef {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`git: repo must be an http(s) URL like https://github.com/owner/repo, got "${raw}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "file:") {
    throw new Error(`git: repo must be an http(s) URL (a token cannot authenticate an ssh remote), got "${raw}"`);
  }
  if (u.username || u.password) {
    throw new Error("git: repo URL must not carry credentials — the token comes from the secret store (tokenSecret)");
  }
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) throw new Error(`git: repo URL needs an owner and a name, got "${raw}"`);
  for (const s of segs) {
    if (!SEGMENT_RE.test(s)) throw new Error(`git: repo URL has an invalid path segment "${s}"`);
  }
  const name = segs[segs.length - 1]!.replace(/\.git$/, "");
  if (!name) throw new Error(`git: repo URL needs a name, got "${raw}"`);
  return {
    url: trimmed,
    host: u.protocol === "file:" ? "local" : u.hostname,
    owner: segs.slice(0, -1).join("/"),
    name,
  };
}

/** The credential-free bare cache for a remote:
 *  `<dataDir>/repos/<host>/<owner>/<name>.git`. */
export function cachePath(dataDir: string, r: RepoRef): string {
  return join(dataDir, "repos", r.host, r.owner, `${r.name}.git`);
}

/** Where a run's working copies live when the bag has no `artifacts`
 *  capability to name the run's own directory: `<dataDir>/worktrees/<runId>/`.
 *  The standard server never gets here — see checkout.ts. */
export function worktreeRoot(dataDir: string, runId: string): string {
  return join(dataDir, "worktrees", runId);
}

// ── the services a git step needs ─────────────────────────────────────────

export function shellOf(ctx: GitCtx): ShellCapability {
  return (ctx.services as Partial<StrutCapabilities> | undefined)?.shell ?? shellCapability();
}

/** The deployment's data dir (`services.dataDir`, set by the standard
 *  server); a bare in-code bag falls back to the OS temp dir. */
export function dataDirOf(ctx: GitCtx): string {
  return (ctx.services as Partial<StrutCapabilities> | undefined)?.dataDir ?? join(tmpdir(), "strut");
}

/** A signal that fires when the run starts cancelling (run control is
 *  cooperative; a subprocess is one unit — same pattern as the exec step).
 *  Call `stop()` when the command is done. */
export function cancelSignal(ctx: GitCtx): { signal: AbortSignal; stop(): void } {
  const ac = new AbortController();
  const control = ctx.control;
  const timer = control
    ? setInterval(() => {
        if (control.state === "cancelling") ac.abort();
      }, 200)
    : undefined;
  return { signal: ac.signal, stop: () => (timer ? clearInterval(timer) : undefined) };
}

// ── running git ───────────────────────────────────────────────────────────

/** The helper git runs for a credential: on `get`, it reads the request's
 *  `host=` line and answers only when that is the token's host (any case),
 *  with the token from the child env. `x-access-token` is the username
 *  GitHub accepts for any token; GitLab and Forgejo take any username with
 *  a token as its password. */
const HELPER =
  '!f() { test "$1" = get || return 0; h=; ' +
  'while IFS= read -r l; do case "$l" in host=*) h="${l#host=}";; esac; done; ' +
  `test "$(printf %s "$h" | tr '[:upper:]' '[:lower:]')" = "$${HOST_ENV}" || return 0; ` +
  `echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;

/** Git's own credentials, every time, token or not: the helper list RESET
 *  (the machine's — macOS's `osxkeychain` in Xcode's system gitconfig, a
 *  `store` or a manager — and one a repository's config names), and no ssh
 *  (a URL rewrite to `git@…` would log in with the machine's key). Then,
 *  with a token, the one helper that answers for its host alone. */
export function credentialArgs(auth: GitAuth | undefined): string[] {
  return ["-c", "credential.helper=", "-c", "protocol.ssh.allow=never", ...(auth ? ["-c", `credential.helper=${HELPER}`] : [])];
}

/** The child env: no credential but the run's. No terminal prompt and no
 *  askpass program (`core.askPass`, `SSH_ASKPASS`), so a private repository
 *  with no token fails fast; no system config, and a HOME with nothing in
 *  it, so no `~/.gitconfig`, `~/.git-credentials` or `~/.netrc` (which git's
 *  curl reads on its own) — the machine's user never stands in for the
 *  run's person. */
export function gitEnv(auth: GitAuth | undefined): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: "/dev/null",
    ...(auth ? { [TOKEN_ENV]: auth.token, [HOST_ENV]: auth.host } : {}),
  };
}

export interface GitOpts {
  cwd: string;
  /** The token for the remote's host and that host (`gitAuth`). */
  auth?: GitAuth;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

/** Run one git command. Never throws on a non-zero exit (read `code`).
 *  With a token, through the shell it was handed with, when it has one. */
export function git(shell: ShellCapability, args: string[], o: GitOpts): Promise<ShellResult> {
  return (o.auth?.shell ?? shell)({
    cmd: "git",
    args: [...credentialArgs(o.auth), ...args],
    cwd: o.cwd,
    env: gitEnv(o.auth),
    timeoutMs: o.timeoutMs ?? 600_000,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.maxOutputChars ? { maxOutputChars: o.maxOutputChars } : {}),
  });
}

/** Run one git command and return its stdout; a non-zero exit throws with
 *  the command's stderr (which never holds the token — it is not in the URL
 *  or the args). */
export async function gitOk(shell: ShellCapability, args: string[], o: GitOpts): Promise<string> {
  const r = await git(shell, args, o);
  if (r.code !== 0) {
    const what = args.find((a) => !a.startsWith("-")) ?? "git";
    const why = r.timedOut ? "timed out" : `exit ${r.code ?? r.signal}`;
    const detail = (r.stderr || r.stdout).trim().slice(-2000);
    throw new Error(`git ${what} ${why}${detail ? `: ${detail}` : ""}`);
  }
  return r.stdout;
}

// ── the bare cache ────────────────────────────────────────────────────────

/** Where the cache keeps the remote's branches: `origin/<name>`, as any
 *  clone does. Its own `refs/heads/*` are the branches agents make in its
 *  working copies, which a fetch never touches. */
export const TRACKING = "+refs/heads/*:refs/remotes/origin/*";

/**
 * A cache from before TRACKING mirrored the remote into `refs/heads/*`
 * (`clone --bare`) and fetched with `--prune` into them — so a branch an
 * agent made in a kept working copy was deleted by the next run's fetch,
 * whoever ran it, and that copy's next commit was a root commit holding
 * every file. Moved over once: the mirrored heads go, except one a working
 * copy has checked out, and the fetch tracks the remote from then on.
 */
async function trackRemoteBranches(shell: ShellCapability, cacheDir: string, url: string, o: Omit<GitOpts, "cwd">): Promise<void> {
  const at = { cwd: cacheDir, ...o };
  const spec = await git(shell, ["config", "--get", "remote.origin.fetch"], at);
  if (spec.code === 0 && spec.stdout.trim() === TRACKING) return;
  if ((await git(shell, ["config", "--get", "remote.origin.url"], at)).code !== 0) {
    await gitOk(shell, ["config", "remote.origin.url", url], at); // a cache cut off before its remote was added
  }
  const heads = (await gitOk(shell, ["for-each-ref", "--format=%(refname)", "refs/heads/"], at)).split("\n").filter(Boolean);
  const checkedOut = new Set(
    (await gitOk(shell, ["worktree", "list", "--porcelain"], at))
      .split("\n")
      .filter((l) => l.startsWith("branch "))
      .map((l) => l.slice("branch ".length)),
  );
  const mirrored = heads.filter((h) => !checkedOut.has(h));
  if (mirrored.length) {
    const del = await shell({
      cmd: "git",
      args: ["update-ref", "--stdin"],
      cwd: cacheDir,
      stdin: mirrored.map((h) => `delete ${h}\n`).join(""),
      timeoutMs: o.timeoutMs ?? 60_000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (del.code !== 0) throw new Error(`git update-ref failed: ${(del.stderr || del.stdout).trim().slice(-2000)}`);
  }
  await gitOk(shell, ["config", "remote.origin.fetch", TRACKING], at);
}

/** Make the credential-free bare cache for `url` when it is not there (or
 *  move an old one over), then fetch the remote's branches into `origin/*`
 *  and its tags. `--prune` drops what the remote deleted — under origin/,
 *  never a branch an agent made. Run it under the cache's lock. */
export async function fetchCache(shell: ShellCapability, cacheDir: string, url: string, o: Omit<GitOpts, "cwd">): Promise<void> {
  await mkdir(dirname(cacheDir), { recursive: true });
  if (!existsSync(join(cacheDir, "HEAD"))) {
    await rm(cacheDir, { recursive: true, force: true }); // a half-made cache
    await gitOk(shell, ["init", "--bare", "--quiet", cacheDir], { cwd: dirname(cacheDir), ...o });
    await gitOk(shell, ["remote", "add", "origin", url], { cwd: cacheDir, ...o }); // fetches into TRACKING
  } else {
    await trackRemoteBranches(shell, cacheDir, url, o);
  }
  await gitOk(shell, ["fetch", "--quiet", "--prune", "origin", TRACKING, "+refs/tags/*:refs/tags/*"], { cwd: cacheDir, ...o });
}

/** What `git ls-remote --symref <remote> HEAD` printed: the branch HEAD
 *  names and the commit it points at, each when there. */
export function parseSymref(out: string): { branch?: string; head?: string } {
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1];
  const head = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/m.exec(out)?.[1];
  return { ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
}

/** The remote's default branch — asked of the remote, so a change on
 *  GitHub is seen; the clone-time HEAD is the fallback. */
export async function remoteDefaultBranch(shell: ShellCapability, cacheDir: string, o: Omit<GitOpts, "cwd">): Promise<string | undefined> {
  const { branch } = parseSymref(await gitOk(shell, ["ls-remote", "--symref", "origin", "HEAD"], { cwd: cacheDir, ...o }));
  if (branch) return branch;
  const head = await git(shell, ["symbolic-ref", "--short", "HEAD"], { cwd: cacheDir, ...o });
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined;
}

/** The commit the first of `names` that is one points at, or "". A name
 *  never starts with `-`: the caller's to check, since it is an argument. */
export async function commitOf(shell: ShellCapability, cacheDir: string, names: readonly string[], o: Omit<GitOpts, "cwd">): Promise<string> {
  for (const name of names) {
    const rp = await git(shell, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { cwd: cacheDir, ...o });
    if (rp.code === 0) return rp.stdout.trim();
  }
  return "";
}

/** A commit sha, full or abbreviated: what a ref may be besides a branch or tag. */
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
