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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { encodeId } from "../../../session-store.js";
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

// ── kept working copies (plans/agent-sessions.md §5) ──────────────────────

/** Where a KEPT working copy lives: `<dataDir>/workdirs/<encoded name>/`,
 *  the same path on every run that names it. Its record sits BESIDE it
 *  (`<encoded name>.json`), out of the reach of an agent working inside. */
export function workdirRoot(dataDir: string, name: string): string {
  return join(dataDir, "workdirs", encodeId(name));
}

interface WorkdirRecord {
  name: string;
  usedAt: string;
  /** Working copy dir → the cache it is a worktree of, and the ref it was
   *  created at. */
  repos: Record<string, { cache: string; ref: string }>;
}

async function readRecord(root: string): Promise<WorkdirRecord | null> {
  try {
    return JSON.parse(await readFile(`${root}.json`, "utf-8")) as WorkdirRecord;
  } catch {
    return null;
  }
}

/** Stamp a workdir as used now, adding `repo` when given. Returns the record. */
export async function touchWorkdir(
  root: string,
  name: string,
  repo?: { dir: string; cache: string; ref: string },
): Promise<WorkdirRecord> {
  return withLock(`${root}.json`, async () => {
    const rec = (await readRecord(root)) ?? { name, usedAt: "", repos: {} };
    rec.usedAt = new Date().toISOString();
    if (repo) rec.repos[repo.dir] = { cache: repo.cache, ref: repo.ref };
    await mkdir(join(root, ".."), { recursive: true });
    await writeFile(`${root}.json`, JSON.stringify(rec, null, 2), "utf-8");
    return rec;
  });
}

/** The ref a kept working copy was created at, if it is on record. */
export async function workdirRef(root: string, dir: string): Promise<string | undefined> {
  return (await readRecord(root))?.repos[dir]?.ref;
}

/** Which run holds each workdir (by root path). In-process, like the cache
 *  locks: strut is single-process by design. */
const heldWorkdirs = new Map<string, string>();

/** Take a workdir for this RUN, until it ends: two runs in one working copy
 *  would edit the same files. The same run may take it again (one checkout
 *  per repository). Outside the runner (no `ctx.onRunEnd`) nothing is held. */
export function holdWorkdir(ctx: GitCtx, root: string, name: string): void {
  const by = heldWorkdirs.get(root);
  if (by !== undefined && by !== ctx.runId) {
    throw new Error(`workdir_busy: workdir "${name}" is in use by run ${by}`);
  }
  if (by === ctx.runId || !ctx.onRunEnd) return;
  heldWorkdirs.set(root, ctx.runId);
  ctx.onRunEnd(() => {
    if (heldWorkdirs.get(root) === ctx.runId) heldWorkdirs.delete(root);
  });
}

/** How long a kept working copy may sit unused (`STRUT_WORKDIR_TTL_DAYS`,
 *  default 7). `0` keeps them forever. */
export function workdirTtlMs(): number {
  const raw = process.env["STRUT_WORKDIR_TTL_DAYS"];
  const days = raw === undefined || raw === "" ? 7 : Number(raw);
  return Number.isFinite(days) && days > 0 ? days * 86_400_000 : 0;
}

/** Remove the kept working copies nobody has used for `ttlMs` and nobody
 *  holds. Run by every kept checkout, so disk is reclaimed without a timer.
 *  Never throws: a workdir that cannot be removed is tried again next time. */
export async function sweepWorkdirs(shell: ShellCapability, dataDir: string, ttlMs: number, now = Date.now()): Promise<string[]> {
  if (!ttlMs) return [];
  const base = join(dataDir, "workdirs");
  let files: string[];
  try {
    files = (await readdir(base)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const file of files) {
    const root = join(base, file.slice(0, -".json".length));
    if (heldWorkdirs.has(root)) continue;
    const rec = await readRecord(root);
    if (!rec || !(now - Date.parse(rec.usedAt) > ttlMs)) continue;
    try {
      for (const [dir, { cache }] of Object.entries(rec.repos)) {
        await withLock(cache, async () => {
          if (!existsSync(join(cache, "HEAD"))) return;
          await git(shell, ["worktree", "remove", "--force", "--force", dir], { cwd: cache, timeoutMs: 60_000 });
          await git(shell, ["worktree", "prune"], { cwd: cache, timeoutMs: 60_000 });
        });
      }
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.json`, { force: true });
      swept.push(rec.name);
    } catch (err) {
      console.warn(`[git] could not sweep workdir "${rec.name}":`, (err as Error).message);
    }
  }
  return swept;
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
