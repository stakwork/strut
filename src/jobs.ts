/**
 * The job directory (plans/jobs.md §2): `<dataDir>/jobs/<encoded name>/`,
 * ONE kept directory per job — what a session-carrying agent works in
 * across runs, so turn twelve opens the `plan.md` turn three wrote. The
 * `job/dir` step hands it out; `git/checkout { workdir }` checks
 * repositories out INTO it (it is the "kept working copy" of
 * plans/agent-sessions.md §5, widened: a job holds files of its own beside
 * its repositories).
 *
 * The record sits BESIDE the directory (`<encoded name>.json`), outside the
 * reach of an agent working inside: when the job was last used, and which
 * of its subdirectories are git worktrees. The sweep (`sweepJobs`) reads it
 * to remove the REPOSITORIES of an idle job — re-checkout-able, and big —
 * and keep its FILES; a job directory with nothing left is removed with its
 * record. Nothing else ever deletes a job's files (`DELETE /jobs/:id` is
 * later work).
 *
 * One run at a time per job (`holdJob`, `job_busy:`): two runs in one
 * directory would edit the same files. In-process, like every strut lock —
 * strut is single-process by design; a crash drops every hold.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { StepContext } from "./core.js";
import type { ShellCapability } from "./capabilities.js";
import { encodeId } from "./session-store.js";

export interface JobRecord {
  name: string;
  usedAt: string;
  /** Working copy dir → the cache it is a worktree of, and the ref it was
   *  created at (`git/checkout`). */
  repos: Record<string, { cache: string; ref: string }>;
}

/** Where a job's directory lives — the same path for every run that names
 *  the job. Flat: `abc/review` is `abc%2Freview`, a sibling of `abc`. */
export function jobRoot(dataDir: string, name: string): string {
  return join(dataDir, "jobs", encodeId(name));
}

export async function readJobRecord(root: string): Promise<JobRecord | null> {
  try {
    return JSON.parse(await readFile(`${root}.json`, "utf-8")) as JobRecord;
  } catch {
    return null;
  }
}

async function writeJobRecord(root: string, rec: JobRecord): Promise<void> {
  await mkdir(join(root, ".."), { recursive: true });
  await writeFile(`${root}.json`, JSON.stringify(rec, null, 2), "utf-8");
}

/** Stamp a job as used now, adding `repo` when given. Returns the record. */
export async function touchJob(
  root: string,
  name: string,
  repo?: { dir: string; cache: string; ref: string },
): Promise<JobRecord> {
  return withLock(`${root}.json`, async () => {
    const rec = (await readJobRecord(root)) ?? { name, usedAt: "", repos: {} };
    rec.usedAt = new Date().toISOString();
    if (repo) rec.repos[repo.dir] = { cache: repo.cache, ref: repo.ref };
    await writeJobRecord(root, rec);
    return rec;
  });
}

/** Which run holds each job (by root path). */
const held = new Map<string, string>();

/** Take a job's directory for this RUN, until it ends. The same run may
 *  take it again (`job/dir` and then a checkout, or several checkouts).
 *  Outside the runner (no `ctx.onRunEnd`) nothing is held. */
export function holdJob(ctx: Pick<StepContext<unknown>, "runId" | "onRunEnd">, root: string, name: string): void {
  const by = held.get(root);
  if (by !== undefined && by !== ctx.runId) {
    throw new Error(`job_busy: job "${name}" is in use by run ${by}`);
  }
  if (by === ctx.runId || !ctx.onRunEnd) return;
  held.set(root, ctx.runId);
  ctx.onRunEnd(() => {
    if (held.get(root) === ctx.runId) held.delete(root);
  });
}

/** The run holding a job's directory, if any. */
export function jobHolder(root: string): string | undefined {
  return held.get(root);
}

/** How long a job may sit unused before its repositories are removed
 *  (`STRUT_WORKDIR_TTL_DAYS`, default 7). `0` keeps them forever. */
export function jobTtlMs(): number {
  const raw = process.env["STRUT_WORKDIR_TTL_DAYS"];
  const days = raw === undefined || raw === "" ? 7 : Number(raw);
  return Number.isFinite(days) && days > 0 ? days * 86_400_000 : 0;
}

/** Remove one of a job's working copies: the worktree from its cache (when
 *  the cache still exists), then the directory. Under the cache's lock, so
 *  a checkout of the same repository never interleaves. */
export async function removeJobRepo(shell: ShellCapability, dir: string, cache: string): Promise<void> {
  await withLock(cache, async () => {
    if (existsSync(join(cache, "HEAD"))) {
      const git = (args: string[]) =>
        shell({ cmd: "git", args, cwd: cache, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 });
      await git(["worktree", "remove", "--force", "--force", dir]);
      await git(["worktree", "prune"]);
    }
    await rm(dir, { recursive: true, force: true });
  });
}

/**
 * The idle sweep: for every job nobody has used for `ttlMs` and nobody
 * holds, remove its repositories and keep its files; a job with nothing
 * left is removed with its record. Run by every `job/dir` and kept
 * checkout, so disk is reclaimed without a timer. Returns the names it
 * touched. Never throws: a job that cannot be swept is tried again next
 * time.
 */
export async function sweepJobs(shell: ShellCapability, dataDir: string, ttlMs: number, now = Date.now()): Promise<string[]> {
  if (!ttlMs) return [];
  const base = join(dataDir, "jobs");
  let files: string[];
  try {
    files = (await readdir(base)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const file of files) {
    const root = join(base, file.slice(0, -".json".length));
    if (held.has(root)) continue;
    const rec = await readJobRecord(root);
    if (!rec || !(now - Date.parse(rec.usedAt) > ttlMs)) continue;
    const repos = Object.entries(rec.repos);
    try {
      for (const [dir, { cache }] of repos) {
        await removeJobRepo(shell, dir, cache);
        delete rec.repos[dir];
      }
      let left: string[] = [];
      try {
        left = await readdir(root);
      } catch {
        /* the directory is already gone */
      }
      if (left.length === 0) {
        await rm(root, { recursive: true, force: true });
        await rm(`${root}.json`, { force: true });
        swept.push(rec.name);
      } else if (repos.length) {
        await withLock(`${root}.json`, () => writeJobRecord(root, rec));
        swept.push(rec.name);
      }
    } catch (err) {
      console.warn(`[jobs] could not sweep job "${rec.name}":`, (err as Error).message);
    }
  }
  return swept;
}

// ── serving (plans/jobs.md §2.2) ──────────────────────────────────────────

/** Resolve a relative path inside a job's directory, refusing one that
 *  escapes it. */
export function jobFilePath(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`jobs: path escapes the job directory: ${relPath}`);
  }
  return abs;
}

/** Relative paths of every file in a job's directory, recursive and sorted,
 *  skipping its repositories (a checkout is not a deliverable, and can be
 *  enormous). `[]` for a job with no directory. */
export async function listJobFiles(root: string, rec: JobRecord | null): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const repoDirs = Object.keys(rec?.repos ?? {}).map((d) => resolve(d));
  const inRepo = (abs: string) => repoDirs.some((d) => abs === d || abs.startsWith(d + sep));
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((abs) => !inRepo(abs))
    .map((abs) => relative(root, abs))
    .sort();
}

// ── one writer per key ────────────────────────────────────────────────────

const locks = new Map<string, Promise<void>>();

/** Serialize work on one key within this process — a git cache (two runs
 *  of the same repository fetch and add worktrees one after the other), a
 *  job record. */
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
