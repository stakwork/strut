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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { shellCapability, type ShellCapability, type ShellResult, type StrutCapabilities } from "../../../capabilities.js";

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

/** Where a run's working copies live: `<dataDir>/worktrees/<runId>/`. */
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

// ── one writer per cache ──────────────────────────────────────────────────

const locks = new Map<string, Promise<void>>();

/** Serialize work on one cache dir within this process: two runs of the same
 *  repo fetch and add worktrees one after the other, never interleaved. */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
