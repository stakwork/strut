/**
 * Shared helpers for the `git/*` lib steps (plans/code-change.md §3.3).
 *
 * Every git invocation goes through `ctx.services.shell` — recordable, and
 * the child env is scrubbed by construction. The one credential a step may
 * hold (the token behind `tokenSecret`) reaches git in exactly one way: the
 * child env (`STRUT_GIT_TOKEN`), read by an inline `credential.helper` that
 * is passed with `-c`. It is never an argument, never in a URL, never in a
 * repository's config, and the helper list is RESET first so no system or
 * global helper (a keychain) ever sees it. A checkout therefore carries no
 * credential: an agent's `bash` in it cannot push, whatever it tries.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StepContext } from "../../../core.js";
import { withLock } from "../../../jobs.js";
import { shellCapability, type ShellCapability, type ShellResult, type StrutCapabilities } from "../../../capabilities.js";

// One writer per cache: the same in-process lock the job directory uses
// (jobs.ts) — two runs of one repository fetch and add worktrees one after
// the other, never interleaved.
export { withLock };

export type GitCtx = StepContext<StrutCapabilities>;

/** The child-env variable the inline credential helper reads. */
export const TOKEN_ENV = "STRUT_GIT_TOKEN";

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

/** The inline credential helper: reset the helper list, then one helper that
 *  answers with the token from the child env. `x-access-token` is the
 *  username GitHub accepts for any token. */
export function credentialArgs(token: string | undefined): string[] {
  if (!token) return [];
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=!f() { echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`,
  ];
}

export function gitEnv(token: string | undefined): Record<string, string> {
  // Never a prompt: a private repo with no token fails fast instead of hanging.
  return { GIT_TERMINAL_PROMPT: "0", ...(token ? { [TOKEN_ENV]: token } : {}) };
}

export interface GitOpts {
  cwd: string;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

/** Run one git command. Never throws on a non-zero exit (read `code`). */
export function git(shell: ShellCapability, args: string[], o: GitOpts): Promise<ShellResult> {
  return shell({
    cmd: "git",
    args: [...credentialArgs(o.token), ...args],
    cwd: o.cwd,
    env: gitEnv(o.token),
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

/** The remote's default branch — asked of the remote, so a change on
 *  GitHub is seen; the clone-time HEAD is the fallback. */
export async function remoteDefaultBranch(shell: ShellCapability, cacheDir: string, o: Omit<GitOpts, "cwd">): Promise<string | undefined> {
  const symref = await gitOk(shell, ["ls-remote", "--symref", "origin", "HEAD"], { cwd: cacheDir, ...o });
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1];
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
