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
 * reach of an agent working inside: the job's title and who started it,
 * one line per run launched under it (plans/job-index.md §1 — the runner
 * appends it at `run.start` through `ctx.services.jobs.recordRun`), when
 * it was last used, and which of its subdirectories are git worktrees. The
 * sweep (`sweepJobs`) reads it to remove the REPOSITORIES of an idle job —
 * re-checkout-able, and big — and keep its FILES; a job directory with
 * nothing left is removed, and so is the record unless it holds the job's
 * history (runs or holds). `DELETE /jobs/:id` (`deleteJob`) is the only
 * other thing that removes a job's files, and the only thing that removes
 * a record with runs. The read side — the index — is `job-index.ts`.
 *
 * A job also keeps HOLDS (§6): what a tool claimed that must outlive the
 * run — a pod — recorded through `ctx.services.jobs.hold` with the step
 * that lets it go. The sweep and the delete run those release steps first;
 * a hold that will not release stays on the record for the next attempt.
 *
 * A job can tell its host what changed AS it changes (plans/live-artifacts.md):
 * a host that launched it with `jobCallback` gets a `job.update` POST when a
 * hold is taken or let go, when a check writes evidence, and when a step
 * calls `ctx.services.jobs.notify` (a screenshot, a walkthrough's frame).
 * The URL is kept apart from the record (`setJobCallback`), so nothing that
 * serves the record can serve it.
 *
 * One run at a time per job (`holdJob`, `job_busy:`): two runs in one
 * directory would edit the same files. A child run the holder launches
 * (`meta/run-workflow`, under its controller) is the same turn and shares
 * it. In-process, like every strut lock — strut is single-process by
 * design; a crash drops every hold.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { postCallback } from "./callback.js";
import type { StepContext, StepRegistry } from "./core.js";
import type { ShellCapability } from "./capabilities.js";
import { isAncestorRun } from "./run-control.js";
import { encodeId, idProblem } from "./session-store.js";
import type { JobIndex } from "./job-index.js";
import type { LedgerClaim } from "./ledger.js";

export interface JobRecord {
  name: string;
  /** The host's name for the job (`POST …/run { job, title }`): the latest
   *  launch that carried one. Absent until a launch names it. */
  title?: string;
  /** The actor of the first run recorded under the job. Recorded, never checked. */
  createdBy?: string;
  /** Every actor that launched a run under the job, first seen first —
   *  `createdBy` is the head. Recorded, never checked: `GET /jobs?mine=1`
   *  filters a listing by it, nothing gates on it. */
  actors?: string[];
  /** When the record was first written. */
  createdAt?: string;
  usedAt: string;
  /** Working copy dir → the cache it is a worktree of, and the ref it was
   *  created at (`git/checkout`). */
  repos: Record<string, { cache: string; ref: string }>;
  /** What the job keeps alive beyond a run (§6). Absent when nothing is held. */
  holds?: JobHold[];
  /** Every run launched under the job, oldest first (plans/job-index.md §1).
   *  Absent until the first. */
  runs?: JobRun[];
}

/** One run of a job, as the runner records it at `run.start`. A child run
 *  (one `meta/run-workflow` launched from a turn) names its parent, so a
 *  reader can tell a turn from what the turn ran. */
export interface JobRun {
  workflow: string;
  runId: string;
  at: string;
  parentRunId?: string;
}

/**
 * Something a job keeps alive beyond a run (plans/jobs.md §6): a pod, later
 * a browser or a VM. Recorded by the tool that claimed it, through
 * `ctx.services.jobs.hold`, with the way to let it go — a registry step and
 * its input — which strut runs when the job is deleted or swept. Strut
 * knows nothing about pods; it knows a hold has a release.
 */
export interface JobHold {
  /** The resource's own id (a pod id). One hold per id: a re-claim replaces. */
  id: string;
  /** What it is, in the tool's words ("pod"). Passed through, never read. */
  kind: string;
  since: string;
  /** The step that lets it go, with its input: a bare type (the active
   *  version), run under a minimal context — `services`, `registry`, `job`,
   *  no run. */
  release: { type: string; input: unknown };
  note?: string;
  /** Where to find it, when it has an address (a pod's frontend). What a
   *  job check reads as `{{ input.urls.<kind> }}` (job-index.ts `urls`;
   *  plans/job-claims.md §3) — so a check survives a dropped and
   *  re-claimed pod without an edit. Passed through, never read here. */
  url?: string;
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

/** Every write to a record: under its lock, the record (created now when
 *  there is none), `edit` applied, `usedAt` stamped — a write is a use. */
async function updateJobRecord(root: string, name: string, edit: (rec: JobRecord) => void): Promise<JobRecord> {
  return withLock(`${root}.json`, async () => {
    const now = new Date().toISOString();
    const rec = (await readJobRecord(root)) ?? { name, createdAt: now, usedAt: now, repos: {} };
    edit(rec);
    rec.usedAt = now;
    await writeJobRecord(root, rec);
    return rec;
  });
}

/** Stamp a job as used now, adding `repo` when given. Returns the record. */
export async function touchJob(
  root: string,
  name: string,
  repo?: { dir: string; cache: string; ref: string },
): Promise<JobRecord> {
  return updateJobRecord(root, name, (rec) => {
    if (repo) rec.repos[repo.dir] = { cache: repo.cache, ref: repo.ref };
  });
}

// ── live updates (plans/live-artifacts.md) ────────────────────────────────

/** What a job tells its host as it happens — a notification, never the
 *  record: each one points at something that has a home already (a job
 *  file, a hold, a piece of evidence), which the host re-reads when it
 *  missed one. `kind` and `state` are passed through; strut reads neither. */
export interface JobUpdate {
  event: "job.update";
  job: string;
  /** When strut made the change. */
  at: string;
  /** The run that made it, when one did. */
  runId?: string;
  /** "walkthrough" | "image" | "pod" | "evidence" | "verify" | … */
  kind: string;
  /** The thing's link: a job file (`jobFileUrl`, artifact-refs.ts), a hold's `url`. */
  url?: string;
  /** The thing's own id where it has one: a hold's, a piece of evidence's. */
  id?: string;
  title?: string;
  /** "recording" | "done" | "stopped" | "held" | "released" | "supported" | … */
  state?: string;
  /** Small and kind-specific: `{ frames: 3 }`, `{ claim, check }`. */
  detail?: Record<string, unknown>;
}

export type JobUpdateInput = Omit<JobUpdate, "event" | "job" | "at">;

/** Where a job's callback URL is kept: `jobs/.callbacks/<encoded id>.json`,
 *  apart from the record, so nothing that serves the record can serve the
 *  host's credential. A job id starts with a letter or a digit, so
 *  `.callbacks` is never a job's, and the listings (which read `*.json`
 *  beside the directories) never see it. */
function callbackFile(root: string): string {
  return join(dirname(root), ".callbacks", `${basename(root)}.json`);
}

/** Record (or, with `null`, clear) the URL a job's updates are POSTed to —
 *  `POST …/run { job, jobCallback }`, the latest launch that carries one
 *  winning. Owner-only, like the other files holding a credential. */
export async function setJobCallback(root: string, url: string | null): Promise<void> {
  const file = callbackFile(root);
  if (url === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ url }), { mode: 0o600 });
}

/** The job's callback URL, if one is on file. Read synchronously: `notify`
 *  queues in call order, and an update must not be overtaken by a later
 *  one whose read finished first. A few hundred bytes, on a rare event. */
function jobCallbackUrl(root: string): string | undefined {
  try {
    const url = (JSON.parse(readFileSync(callbackFile(root), "utf-8")) as { url?: unknown }).url;
    return typeof url === "string" && url ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A live update that misses its moment is worth little, and the next one
 *  points at the same state: two quick retries, not the run callback's three. */
const LIVE_RETRY_MS = [1_000, 5_000];

/** Per job: the updates waiting to be posted, keyed by the thing they are
 *  about (`kind` + `url` + `id`). A newer update for the same thing
 *  REPLACES the waiting one and moves to the back — the queue holds each
 *  thing's latest state, in the order of the latest changes — so ten frames
 *  recorded while one post is in flight send two. One drain per job: posts
 *  leave in order. */
const outboxes = new Map<string, { pending: Map<string, { url: string; update: JobUpdate }>; draining: boolean }>();

/**
 * Tell the job's host that something changed (plans/live-artifacts.md §2).
 * Fire and forget: never throws, never waits, a no-op when no callback is
 * on file. The URL is read here, at the call, so a sweep that removes the
 * job right after still delivers what it reported on the way out.
 */
export function notifyJob(root: string, job: string, input: JobUpdateInput): void {
  const url = jobCallbackUrl(root);
  if (!url) return;
  let box = outboxes.get(root);
  if (!box) outboxes.set(root, (box = { pending: new Map(), draining: false }));
  const key = `${input.kind}\0${input.url ?? ""}\0${input.id ?? ""}`;
  box.pending.delete(key);
  box.pending.set(key, { url, update: { event: "job.update", job, at: new Date().toISOString(), ...input } });
  if (!box.draining) void drainOutbox(root, box);
}

async function drainOutbox(root: string, box: { pending: Map<string, { url: string; update: JobUpdate }>; draining: boolean }): Promise<void> {
  box.draining = true;
  try {
    for (let next = box.pending.entries().next(); !next.done; next = box.pending.entries().next()) {
      const [key, { url, update }] = next.value;
      box.pending.delete(key);
      await postCallback(url, update, { tag: `[job ${update.job}] callback job.update`, retryDelaysMs: LIVE_RETRY_MS });
    }
  } finally {
    box.draining = false;
    if (outboxes.get(root) === box && box.pending.size === 0) outboxes.delete(root);
  }
}

/** A hold as the update that says it was taken or let go. */
const holdUpdate = (hold: JobHold, state: "held" | "released"): JobUpdateInput => ({
  kind: hold.kind,
  id: hold.id,
  state,
  ...(hold.url ? { url: hold.url } : {}),
});

// ── holds (§6) ────────────────────────────────────────────────────────────

/** `ctx.services.jobs`: the writes to a job's record — its holds, for the
 *  tools that claim and release what outlives a run, and its run lines, for
 *  the runner — and, on a server, the index that reads it all back
 *  (`job-index.ts`; absent on a bare bag, which keeps no stores to read). */
export interface JobsCapability extends Partial<JobIndex> {
  /** Record a hold. The same `id` again replaces the earlier hold. */
  hold(job: string, hold: Omit<JobHold, "since"> & { since?: string }): Promise<void>;
  /** Drop a hold whose resource the caller already let go of — the tool that
   *  released the pod says so. Nothing happens when there is none. */
  release(job: string, id: string): Promise<void>;
  holds(job: string): Promise<JobHold[]>;
  /** One line for a run launched under the job — the runner's call at
   *  `run.start` (plans/job-index.md §1). The launch's `title` names the
   *  job (kept until a later launch carries another); its `actor` joins the
   *  job's `actors` (and is `createdBy` when it is the first). */
  recordRun(job: string, run: Omit<JobRun, "at"> & { title?: string; actor?: string }): Promise<void>;
  /** Tell the job's host that something changed (plans/live-artifacts.md):
   *  a step that wrote a file the person may want to watch — a screenshot,
   *  a walkthrough's frame. Fire and forget: never throws, never waits, a
   *  no-op when the job has no callback. Holds announce themselves. */
  notify?(job: string, update: JobUpdateInput): void;
  /** The job's claims as the ledger reads them (plans/job-claims.md §6) —
   *  set by the server where the claims layer is on, so `GET /jobs/:id`
   *  and `job/get` carry the same `claims`; absent on a filesystem
   *  workspace. Null for a job not on file. */
  claims?(job: string): Promise<LedgerClaim[] | null>;
}

/** The record's own writer, index or not. `index` (a server's stores) adds
 *  `list` / `get` / `read` — what the `/jobs` routes and the `job/*` steps
 *  read through. */
export function jobsCapability(dataDir: string, index?: JobIndex): JobsCapability {
  const rootOf = (job: string) => {
    const problem = idProblem(job);
    if (problem) throw new Error(`jobs: job id "${job}" ${problem}`);
    return jobRoot(dataDir, job);
  };
  return {
    ...index,
    async hold(job, hold) {
      const root = rootOf(job);
      const held: JobHold = { ...hold, since: hold.since ?? new Date().toISOString() };
      await updateJobRecord(root, job, (rec) => {
        rec.holds = [...(rec.holds ?? []).filter((h) => h.id !== hold.id), held];
      });
      notifyJob(root, job, holdUpdate(held, "held"));
    },
    async recordRun(job, { title, actor, ...run }) {
      await updateJobRecord(rootOf(job), job, (rec) => {
        if (title) rec.title = title;
        if (actor) {
          if (!rec.createdBy) rec.createdBy = actor;
          const actors = rec.actors ?? [rec.createdBy];
          rec.actors = actors.includes(actor) ? actors : [...actors, actor];
        }
        rec.runs = [...(rec.runs ?? []), { ...run, at: new Date().toISOString() }];
      });
    },
    async release(job, id) {
      const root = rootOf(job);
      const gone = await withLock(`${root}.json`, async () => {
        const rec = await readJobRecord(root);
        const hold = rec?.holds?.find((h) => h.id === id);
        if (!rec?.holds || !hold) return undefined;
        rec.holds = rec.holds.filter((h) => h.id !== id);
        if (rec.holds.length === 0) delete rec.holds;
        await writeJobRecord(root, rec);
        return hold;
      });
      if (gone) notifyJob(root, job, holdUpdate(gone, "released"));
    },
    async holds(job) {
      return (await readJobRecord(rootOf(job)))?.holds ?? [];
    },
    notify(job, update) {
      if (idProblem(job)) return;
      notifyJob(jobRoot(dataDir, job), job, update);
    },
  };
}

/** How a sweep or a delete lets a hold go. Built by `releaseWith`. */
export type ReleaseFn = (hold: JobHold, job: string) => Promise<void>;

/**
 * The release runner a caller with a registry hands to `sweepJobs` /
 * `deleteJob`: the hold's step — a bare type, the active version — run with
 * its recorded input under a minimal context (no run, no events; the bag,
 * the registry and the job). A step that is not in the registry throws like
 * any other failure, and the hold stays for the next attempt. Undefined
 * without a registry (a bare run): nothing can be released, and jobs with
 * holds are left alone.
 */
export function releaseWith(registry: StepRegistry | undefined, services: unknown): ReleaseFn | undefined {
  if (!registry) return undefined;
  return async (hold, job) => {
    const def = registry[hold.release.type];
    if (!def) throw new Error(`release step "${hold.release.type}" is not in the registry`);
    const ctx: StepContext<unknown> = {
      runId: "jobs",
      path: `jobs/${job}/${hold.id}`,
      scope: {},
      input: hold.release.input,
      emit: async () => {},
      services,
      registry,
      job,
    };
    await def.run(def.input.parse(hold.release.input), ctx);
  };
}

/** Let every hold of a job go through `release`. The ones that fail stay on
 *  the record (warned) for the next attempt; the record is written. */
async function releaseHolds(
  root: string,
  rec: JobRecord,
  release: ReleaseFn,
): Promise<{ released: string[]; failed: Array<{ id: string; error: string }> }> {
  const released: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const hold of rec.holds ?? []) {
    try {
      await release(hold, rec.name);
      released.push(hold.id);
      notifyJob(root, rec.name, holdUpdate(hold, "released"));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[jobs] could not release ${hold.kind} "${hold.id}" of job "${rec.name}":`, error);
      failed.push({ id: hold.id, error });
    }
  }
  if (released.length) {
    rec.holds = (rec.holds ?? []).filter((h) => !released.includes(h.id));
    if (rec.holds.length === 0) delete rec.holds;
    await withLock(`${root}.json`, () => writeJobRecord(root, rec));
  }
  return { released, failed };
}

/** Which run holds each job (by root path). */
const held = new Map<string, string>();

/** Take a job's directory for this RUN, until it ends. The same run may
 *  take it again (`job/dir` and then a checkout, or several checkouts), and
 *  so may a run launched FROM the holder — a child `meta/run-workflow`
 *  started inside the job's turn, whose controller descends from the
 *  holder's (`isAncestorRun`): it shares the directory and registers no
 *  release of its own; the holder's stands. Any other run is `job_busy:`.
 *  Outside the runner (no `ctx.onRunEnd`) nothing is held. */
export function holdJob(ctx: Pick<StepContext<unknown>, "runId" | "onRunEnd" | "control">, root: string, name: string): void {
  const by = held.get(root);
  if (by !== undefined) {
    if (by === ctx.runId || isAncestorRun(ctx.control, by)) return;
    throw new Error(`job_busy: job "${name}" is in use by run ${by}`);
  }
  if (!ctx.onRunEnd) return;
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

export interface SweepOptions {
  now?: number;
  /** How to let a hold go (`releaseWith`). Without it a job with holds is
   *  left alone: only a caller with a registry can release. */
  release?: ReleaseFn;
}

/**
 * The idle sweep: for every job nobody has used for `ttlMs` and nobody
 * holds, let its holds go (§6), remove its repositories and keep its
 * files; a job with nothing left is removed, with its record unless the
 * record is the job's history (it has runs — the index, plans/job-index.md;
 * only `DELETE /jobs/:id` removes that). Run by every
 * `job/dir` and kept checkout, so disk — and a pod — is reclaimed without
 * a timer. Returns the names it touched. Never throws: a job that cannot
 * be swept, and a hold that will not release, are tried again next time.
 */
export async function sweepJobs(shell: ShellCapability, dataDir: string, ttlMs: number, opts: SweepOptions = {}): Promise<string[]> {
  if (!ttlMs) return [];
  const now = opts.now ?? Date.now();
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
      let released = 0;
      if (rec.holds?.length) {
        if (!opts.release) continue;
        released = (await releaseHolds(root, rec, opts.release)).released.length;
      }
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
      if (left.length === 0 && !rec.holds?.length && !rec.runs?.length) {
        await rm(root, { recursive: true, force: true });
        await rm(`${root}.json`, { force: true });
        await setJobCallback(root, null);
        swept.push(rec.name);
      } else if (repos.length || released) {
        await withLock(`${root}.json`, () => writeJobRecord(root, rec));
        swept.push(rec.name);
      }
    } catch (err) {
      console.warn(`[jobs] could not sweep job "${rec.name}":`, (err as Error).message);
    }
  }
  return swept;
}

/**
 * `DELETE /jobs/:id`: let every hold go, remove the repositories, the
 * directory and the record. Runs, chats and sessions are records of their
 * own and are not touched. Refused (`job_busy:`) while a run holds the
 * directory. A hold that will not release keeps the job — the error names
 * it and nothing is removed — so a pod is never forgotten silently; the
 * next call tries again.
 */
export async function deleteJob(
  shell: ShellCapability,
  root: string,
  name: string,
  release: ReleaseFn | undefined,
): Promise<{ released: string[] }> {
  const by = held.get(root);
  if (by !== undefined) throw new Error(`job_busy: job "${name}" is in use by run ${by}`);
  const rec = await readJobRecord(root);
  let released: string[] = [];
  if (rec?.holds?.length) {
    if (!release) throw new Error(`jobs: job "${name}" has holds and no registry to release them with`);
    const r = await releaseHolds(root, rec, release);
    released = r.released;
    if (r.failed.length) {
      throw new Error(
        `jobs: could not release ${r.failed.map((f) => `"${f.id}" (${f.error})`).join(", ")}; job "${name}" is kept`,
      );
    }
  }
  for (const [dir, { cache }] of Object.entries(rec?.repos ?? {})) await removeJobRepo(shell, dir, cache);
  await rm(root, { recursive: true, force: true });
  await rm(`${root}.json`, { force: true });
  await setJobCallback(root, null);
  return { released };
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
