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
 * a record with runs. The read side — the index — is `job-index.ts`. Two
 * small indexes beside the records (`.used`, `.sweep`) keep the sweep and
 * the listing from reading every record on the server.
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
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { postCallback } from "./callback.js";
import { roomsFor } from "./rooms.js";
import type { McpServer, StartedBy, StepContext, StepRegistry } from "./core.js";
import type { ShellCapability } from "./capabilities.js";
import { isAncestorRun } from "./run-control.js";
import { encodeId, idProblem, type SessionStore } from "./session-store.js";
import type { JobIndex } from "./job-index.js";
import type { LedgerClaim } from "./ledger.js";
import { writeNewFile, type Attachment } from "./ai/attachments.js";
import { bootEnv } from "./env.js";
import { withLock } from "./lock.js";
import { LiveFeed, type FeedRead } from "./live-feed.js";

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
  /** The agent threads with a turn under the job (a session turn's `job`),
   *  by session id, first seen first: written when such a turn commits
   *  (`recordingJobSessions`), so reading the job never lists every
   *  session on the server. A record from before it was kept is filled in
   *  once, by the job index's one pass over the session store. */
  sessions?: string[];
  /** The automatic fixes strut sent for a pull request the job delivered
   *  whose checks failed (plans/pr-checks.md), by the pull request's URL:
   *  the last one's, taken before its turn launches, `runId` once it has.
   *  Absent until one. */
  prFixes?: Record<string, PrFix>;
  /** What steps of the job's turns asked strut to look at again until it
   *  settles, then send the job one turn (plans/job-follow-ups.md). Absent
   *  when none is pending. */
  followUps?: FollowUp[];
  /** The job's BUDGET in dollars (stadeum plans/experiments.md, "A budget on
   *  a job"): a cap on the model calls of the job and every run under it.
   *  A person's yes to the spending — set by `PUT /jobs/:id/budget` or by
   *  `job/start` / `job/continue` naming one, never by the job's own agent.
   *  Kept at the gateway (src/mothership.ts: a link of the job's own above
   *  each run's) and by strut, which starts no more runs under the job once
   *  its recorded spend reaches it (`jobBudgetProblem`). Absent: no budget. */
  budgetUsd?: number;
  /** What the job has SPENT on model calls, by run id, in dollars (each
   *  run's `totals.cost`, aieo's list prices), written when the run settles
   *  (`recordJobRunCost`); a resumed run's entry is overwritten with its
   *  whole cost so far. Every top-level run that spends this job's budget
   *  (`RunOptions.budgetJob`): the job's own, a check of it, and a run of
   *  ANOTHER job it started — a trial's sample, whose own record is deleted
   *  once it is judged. A child's cost is in the parent that waited on it,
   *  so it has no entry. Kept with or without a budget, so one set later
   *  counts what was spent before. */
  spent?: Record<string, number>;
}

/** A pull request's automatic fixes (`JobRecord.prFixes`): when the last
 *  was sent, its run, and how many in all (absent: one, a mark from before
 *  the count). */
export interface PrFix {
  at: string;
  runId?: string;
  count?: number;
}

/** A step's ask to look again later (`JobRecord.followUps`,
 *  src/follow-ups.ts): kept until its one turn is sent. */
export interface FollowUp {
  /** The asker's name for it: the same id again replaces it. */
  id: string;
  /** The step strut runs again, and its input. It has settled when its
   *  output says `settled: true`. */
  look: { type: string; input: unknown };
  everyMs: number;
  /** When it was asked for, and when strut stops looking. */
  at: string;
  until: string;
  /** The run that asked: the person a look runs as, and the conversation
   *  the turn's end wakes — read by strut from its `run.start`. */
  by: { runId: string; actor?: string; principal?: string; conversation?: string; model?: string };
  /** The turn's prompt, once it settled or timed out: sent when no run of
   *  the job is in flight. */
  ready?: string;
}

/** What a step asks for (`JobsCapability.followUp`). */
export interface FollowUpAsk {
  job: string;
  /** The run asking (`ctx.runId`), one of the job's: the look runs as its
   *  person, and the turn's end wakes its conversation. */
  runId: string;
  /** The same id again replaces the earlier one. Default: the look's type. */
  id?: string;
  look: { type: string; input?: unknown };
  /** How often to look: 30 to 3600 seconds, default 60. */
  everySeconds?: number;
  /** When to stop looking and send the job a turn saying so: 1 to 1440
   *  minutes, default 60. */
  limitMinutes?: number;
}

/** One run of a job, as the runner records it at `run.start`. A child run
 *  (one `meta/run-workflow` launched from a turn) names its parent, so a
 *  reader can tell a turn from what the turn ran. */
export interface JobRun {
  workflow: string;
  runId: string;
  at: string;
  parentRunId?: string;
  /** The turn that started this run through `job/start` / `job/continue`
   *  (`RunEvent.startedBy`): which conversation the job belongs to. */
  startedBy?: StartedBy;
}

/**
 * The job-shaped workflows strut ships — the ones a job's TURNS may run
 * (plans/builder-job.md §2): `job` (code and research: a working directory,
 * repositories, the shell) and `builder` (a workflow build: the authoring
 * twins, no shell). What `job/start`'s `workflow` offers, what the launcher
 * reads, what `turnOf` recognizes as a turn. Closed on purpose: a job never
 * runs an arbitrary workflow as a turn — that is meta/run-workflow's, from
 * inside one.
 */
export const JOB_WORKFLOWS = ["job", "builder"] as const;
export type JobWorkflow = (typeof JOB_WORKFLOWS)[number];

/** The KIND a build is (plans/one-job-agent.md §1): the page under `Job`
 *  that holds what is built here. A job of this kind builds a workflow or
 *  an app with the job's own tools; `builder` is the door for a build on
 *  another server. Never a page under it: a kind's page is cut in the
 *  prompt, and the job opens the one under it in full. */
export const BUILD_KIND = "Workflow Builder";

/** The job's newest TURN: its newest run with no parent that ran one of
 *  `JOB_WORKFLOWS` — so, the workflow the job IS. What `job/continue`
 *  launches (a builder job stays a builder job) and what `GET /jobs/:id`
 *  reports as `workflow`. A run of any other workflow under the job (a
 *  captcha round, a check) is not a turn. Undefined before the first. */
export function turnOf(runs: readonly JobRun[] | undefined): JobRun | undefined {
  for (let i = (runs?.length ?? 0) - 1; i >= 0; i--) {
    const r = runs![i]!;
    if (!r.parentRunId && (JOB_WORKFLOWS as readonly string[]).includes(r.workflow)) return r;
  }
  return undefined;
}

// ── the budget (stadeum plans/experiments.md, "A budget on a job") ────────

/** What a job has spent on model calls, in dollars: the sum of its `spent`
 *  ledger. `except` leaves one run out (the run asking, whose own spend its
 *  gateway link already counts). An estimate at list prices, as each run's
 *  own `totals.cost` is; the gateway keeps the bill. */
export function jobSpentUsd(rec: Pick<JobRecord, "spent"> | null | undefined, except?: string): number {
  let spent = 0;
  for (const [runId, cost] of Object.entries(rec?.spent ?? {})) if (runId !== except && typeof cost === "number") spent += cost;
  return spent;
}

/** A job's budget and what it has spent, or undefined with none. */
export interface JobBudget {
  usd: number;
  spentUsd: number;
  /** What is left, never below 0. */
  leftUsd: number;
}

export function jobBudgetOf(rec: Pick<JobRecord, "budgetUsd" | "spent"> | null | undefined, except?: string): JobBudget | undefined {
  if (typeof rec?.budgetUsd !== "number") return undefined;
  const spentUsd = jobSpentUsd(rec, except);
  return { usd: rec.budgetUsd, spentUsd, leftUsd: Math.max(0, rec.budgetUsd - spentUsd) };
}

/** Dollars, the way a person reads them: `$0.42`, `$64`, `$100.50`. */
export function usd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The refusal for a job whose budget is spent: it opens
 *  `job_budget_spent:`, what every door refusing such a job says, and is the
 *  fixed line the person is told. */
export function budgetSpentMessage(job: string, b: Pick<JobBudget, "usd" | "spentUsd">): string {
  return `job_budget_spent: job "${job}" has spent ${usd(b.spentUsd)} of its ${usd(b.usd)} budget, so nothing more runs under it — a person raises the budget to go on`;
}

/** Why no more may start under the job — its budget is spent — or
 *  undefined (`budgetSpentMessage`). */
export function jobBudgetProblem(job: string, rec: Pick<JobRecord, "budgetUsd" | "spent"> | null | undefined, except?: string): string | undefined {
  const b = jobBudgetOf(rec, except);
  return b && b.leftUsd <= 0 ? budgetSpentMessage(job, b) : undefined;
}

/** A budget as given: a positive, finite number of dollars, or null to
 *  remove it. Anything else is an error, never a fallback — a budget read
 *  as "none" by way of a typo would spend without a cap. */
export function parseBudgetUsd(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`budget must be a positive number of dollars (or null to remove it), got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Set (or with null remove) a job's budget, under its record's lock: a
 *  use, like any write that names the job. Returns the record. */
export async function setJobBudget(root: string, name: string, usdCap: number | null): Promise<JobRecord> {
  const cap = parseBudgetUsd(usdCap);
  return updateJobRecord(root, name, (rec) => {
    if (cap === null) delete rec.budgetUsd;
    else rec.budgetUsd = cap;
  });
}

/** Write what a run that spends the job's budget cost on its ledger
 *  (`JobRecord.spent`), under the record's lock. Not a use: `usedAt` stays.
 *  The run need not be on the job's list: a trial's sample is another
 *  job's. A resumed run's entry is overwritten with its whole cost so far.
 *  Nothing happens when the job is not on file. */
export async function recordJobRunCost(root: string, runId: string, cost: number): Promise<void> {
  if (!Number.isFinite(cost) || cost < 0) return;
  await withLock(`${root}.json`, async () => {
    const rec = await readJobRecord(root);
    if (!rec || rec.spent?.[runId] === cost) return;
    rec.spent = { ...rec.spent, [runId]: cost };
    await writeJobRecord(root, rec);
  });
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
  /** More addresses on the same thing, by name (a pod's second frontend:
   *  `{ admin: "https://…" }`). Each is the job's `urls.<name>` beside
   *  `urls.<kind>`, and a row of its own on Jamie's job card. Passed
   *  through, never read here. */
  links?: Record<string, string>;
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

/** Whole, through a temp file and a rename: the readers (the index, a
 *  host's GET /jobs/:id) take no lock, and a plain writeFile truncates
 *  first — a read in that moment found no record and showed the job with
 *  no runs. Writers hold the record's lock, so one temp name is enough. */
async function writeJobRecord(root: string, rec: JobRecord): Promise<void> {
  await mkdir(join(root, ".."), { recursive: true });
  await writeFile(`${root}.json.tmp`, JSON.stringify(rec, null, 2), "utf-8");
  await rename(`${root}.json.tmp`, `${root}.json`);
}

/** Add agent threads to a job's record (`JobRecord.sessions`), under its
 *  lock. Not a use: `usedAt` stays. A job with no record gets none — a
 *  thread does not make a job — and an id already there is not written. */
export async function noteJobSessions(root: string, ids: readonly string[]): Promise<void> {
  await withLock(`${root}.json`, async () => {
    const rec = await readJobRecord(root);
    if (!rec) return;
    const have = new Set(rec.sessions ?? []);
    const add = ids.filter((id) => !have.has(id) && have.add(id));
    if (add.length === 0) return;
    rec.sessions = [...(rec.sessions ?? []), ...add];
    await writeJobRecord(root, rec);
  });
}

/** The session store with each committed turn's thread noted on its job's
 *  record (`noteJobSessions`): what the job index lists a job's threads
 *  from. A note that fails is logged; the turn stands. */
export function recordingJobSessions(store: SessionStore, dataDir: string): SessionStore {
  return {
    load: (id) => store.load(id),
    turns: (id) => store.turns(id),
    list: () => store.list(),
    delete: (id) => store.delete(id),
    async appendTurn(id, turn) {
      const line = await store.appendTurn(id, turn);
      const job = turn.record.job;
      if (job && !idProblem(job)) {
        await noteJobSessions(jobRoot(dataDir, job), [id]).catch((err) => console.warn(`[jobs] thread ${id} not noted on job ${job}:`, err));
      }
      return line;
    },
  };
}

/** Every write to a record: under its lock, the record (created now when
 *  there is none), `edit` applied, `usedAt` stamped — a write is a use. */
async function updateJobRecord(root: string, name: string, edit: (rec: JobRecord) => void): Promise<JobRecord> {
  return withLock(`${root}.json`, async () => {
    const now = new Date().toISOString();
    const read = await readJobRecord(root);
    const was = read?.usedAt;
    const rec = read ?? { name, createdAt: now, usedAt: now, repos: {} };
    edit(rec);
    rec.usedAt = now;
    await writeJobRecord(root, rec);
    await indexJob(root, rec, was);
    return rec;
  });
}

/**
 * Change a job's `prFixes` under its record's lock (plans/pr-checks.md):
 * `edit` changes the map in place, and what it returns comes back. Not a
 * use (`usedAt` stays), and no index changes. Undefined, and nothing
 * written, for a job with no record.
 */
export async function editPrFixes<T>(root: string, edit: (fixes: Record<string, PrFix>) => T): Promise<T | undefined> {
  return withLock(`${root}.json`, async () => {
    const rec = await readJobRecord(root);
    if (!rec) return undefined;
    const fixes = { ...rec.prFixes };
    const out = edit(fixes);
    if (Object.keys(fixes).length) rec.prFixes = fixes;
    else delete rec.prFixes;
    await writeJobRecord(root, rec);
    return out;
  });
}

/**
 * Change a job's `followUps` under its record's lock
 * (plans/job-follow-ups.md), `editPrFixes`' twin: `edit` changes the list
 * in place, and what it returns comes back. A job with one is marked in
 * `jobs/.follow-ups/` (marked before the record is written, so a crash
 * leaves at most a mark with nothing behind it, which the next look
 * drops). Not a use. Undefined, and nothing written, for a job with no
 * record.
 */
export async function editFollowUps<T>(root: string, edit: (list: FollowUp[]) => T): Promise<T | undefined> {
  return withLock(`${root}.json`, async () => {
    const rec = await readJobRecord(root);
    if (!rec) return undefined;
    const list = [...(rec.followUps ?? [])];
    const out = edit(list);
    if (list.length) {
      await mkdir(dirname(followUpFile(root)), { recursive: true });
      await writeFile(followUpFile(root), "");
      rec.followUps = list;
    } else delete rec.followUps;
    await writeJobRecord(root, rec);
    if (!list.length) await rm(followUpFile(root), { force: true });
    return out;
  });
}

/** The records of the jobs marked as having a follow-up. A mark whose
 *  record has none, or is gone, is dropped. */
export async function* jobsFollowingUp(dataDir: string): AsyncGenerator<JobRecord> {
  const base = join(dataDir, "jobs");
  for (const mark of await readdir(join(base, FOLLOW_UPS_DIR)).catch(() => [] as string[])) {
    const root = join(base, mark);
    const rec = await readJobRecord(root);
    if (rec?.followUps?.length) yield rec;
    else
      await withLock(`${root}.json`, async () => {
        if (!(await readJobRecord(root))?.followUps?.length) await rm(followUpFile(root), { force: true });
      });
  }
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

// ── the indexes beside the records ────────────────────────────────────────

/*
 * Two indexes beside the records, so neither a turn's sweep nor `GET /jobs`
 * reads every record on the server. A swarm holds 100k jobs after months,
 * and both used to read them all: the sweep on every turn, the listing on
 * every call.
 *
 * - `jobs/.used/<day>/<usedAt ms>-<encoded id>`: an empty file per job, at
 *   its `usedAt`. `jobsByUse` reads it newest first, so a listing stops at
 *   its `limit`.
 * - `jobs/.sweep/<encoded id>`: an empty file per job the sweep has
 *   something to look at (`needsSweep`). The sweep reads those records alone.
 *
 * `updateJobRecord` keeps both under the record's lock: it is every write
 * that makes a record, stamps `usedAt`, or adds a repository or a hold. The
 * sweep and `deleteJob` take a job out with its record. No job id starts
 * with a dot, so neither folder is ever a job's. Records from before the
 * indexes are put in by one pass per data directory (`jobsIndexed`).
 */
const USED_DIR = ".used";
const SWEEP_DIR = ".sweep";
const INDEXED_FILE = ".indexed";
/** The jobs with a follow-up pending (`editFollowUps`): one empty file each. */
const FOLLOW_UPS_DIR = ".follow-ups";
const followUpFile = (root: string): string => join(dirname(root), FOLLOW_UPS_DIR, basename(root));

/** A job's entry in `.used` at `usedAt`. Fixed-width milliseconds, so a
 *  day's names sort by time. */
function usedFile(root: string, usedAt: string): string {
  const ms = Math.max(0, Date.parse(usedAt) || 0);
  return join(dirname(root), USED_DIR, new Date(ms).toISOString().slice(0, 10), `${String(ms).padStart(15, "0")}-${basename(root)}`);
}

const sweepFile = (root: string): string => join(dirname(root), SWEEP_DIR, basename(root));

/** Whether the sweep has anything to look at in a job: repositories to
 *  remove, holds to let go, or (for a record with no runs, which no history
 *  keeps) a directory that may be empty once the job is `idle`. A job the
 *  sweep has seen idle with none of these leaves `.sweep` until a write
 *  puts it back. A record of runs alone is history: the sweep never
 *  changes it. */
function needsSweep(rec: JobRecord, idle: boolean): boolean {
  return Object.keys(rec.repos).length > 0 || !!rec.holds?.length || (!rec.runs?.length && !idle);
}

/** Put a record just written into both indexes. Its entry at `was` (the
 *  `usedAt` before this write) goes after the new one is in, so a listing
 *  never misses the job. */
async function indexJob(root: string, rec: JobRecord, was?: string): Promise<void> {
  const used = usedFile(root, rec.usedAt);
  await mkdir(dirname(used), { recursive: true });
  await writeFile(used, "");
  if (was !== undefined && usedFile(root, was) !== used) await rm(usedFile(root, was), { force: true });
  if (needsSweep(rec, false)) {
    await mkdir(dirname(sweepFile(root)), { recursive: true });
    await writeFile(sweepFile(root), "");
  }
}

/** Take a removed job out of both indexes. */
async function unindexJob(root: string, rec: JobRecord | null): Promise<void> {
  if (rec) await rm(usedFile(root, rec.usedAt), { force: true });
  await rm(sweepFile(root), { force: true });
}

const indexing = new Map<string, Promise<void>>();

/**
 * The one pass that puts the records from before the indexes into them:
 * once per data directory, each record under its lock, stamped in
 * `jobs/.indexed`. The sweep and the listing await it, so the first of them
 * after an upgrade reads every record once, as each of them used to every
 * time. A pass that fails is logged and the next caller tries again. Never
 * throws.
 */
export function jobsIndexed(dataDir: string): Promise<void> {
  const base = resolve(dataDir, "jobs");
  let pass = indexing.get(base);
  if (pass) return pass;
  pass = (async () => {
    if (existsSync(join(base, INDEXED_FILE))) return;
    let files: string[];
    try {
      files = await readdir(base);
    } catch (err) {
      // No jobs yet: every record will be written through `updateJobRecord`.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const root = join(base, file.slice(0, -".json".length));
      await withLock(`${root}.json`, async () => {
        const rec = await readJobRecord(root);
        if (rec) await indexJob(root, rec);
      });
    }
    await writeFile(join(base, INDEXED_FILE), `${new Date().toISOString()}\n`);
  })().catch((err) => {
    indexing.delete(base);
    console.warn("[jobs] the job indexes were not built; the next sweep or listing tries again:", err);
  });
  indexing.set(base, pass);
  return pass;
}

/**
 * The job records newest-used first, read one at a time from `.used`, so a
 * reader that stops at its `limit` reads about what it returns. `keep` (on
 * the job's id) passes a job over before its record is read. A job's newest
 * entry wins; one whose record is gone is passed over.
 */
export async function* jobsByUse(dataDir: string, keep?: (job: string) => boolean): AsyncGenerator<JobRecord> {
  await jobsIndexed(dataDir);
  const base = join(dataDir, "jobs");
  const newestFirst = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  const seen = new Set<string>();
  for (const day of await newestFirst(join(base, USED_DIR))) {
    for (const entry of await newestFirst(join(base, USED_DIR, day))) {
      const file = entry.slice("000000000000000-".length);
      if (seen.has(file)) continue;
      seen.add(file);
      if (keep) {
        let job: string;
        try {
          job = decodeURIComponent(file);
        } catch {
          continue; // not a name strut wrote
        }
        if (!keep(job)) continue;
      }
      const rec = await readJobRecord(join(base, file));
      if (rec) yield rec;
    }
  }
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
 *  winning — or the room they go to (`room:<actor>`, callback.ts).
 *  Owner-only, like the other files holding a credential. */
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

/** One thing a job reports about: a newer update with the same key is its
 *  newer state (the outbox's coalescing, and the feed's). */
const updateKey = (u: Pick<JobUpdate, "kind" | "url" | "id">): string => `${u.kind}\0${u.url ?? ""}\0${u.id ?? ""}`;

/** What a job's feed keeps: the newest state of this many things. */
export const JOB_FEED_MAX = 200;
/** A job's feed nobody touched for this long is let go… */
const JOB_FEED_IDLE_MS = 60 * 60_000;
/** …and at most this many are kept at all, the least recently touched going first. */
const JOB_FEED_JOBS_MAX = 1_000;

/** Per job (by its directory, so two struts in one process never share
 *  one): the updates a READER asks for (plans/live-feeds.md §1) — an app's
 *  page through `job/updates`, `GET /jobs/:id/updates` — whether or not a
 *  host is listening on a callback. */
const jobFeeds = new Map<string, LiveFeed<JobUpdate>>();

function jobFeed(root: string): LiveFeed<JobUpdate> {
  let feed = jobFeeds.get(root);
  if (feed) return feed;
  const now = Date.now();
  for (const [r, f] of jobFeeds) if (now - f.touchedAt > JOB_FEED_IDLE_MS) jobFeeds.delete(r);
  while (jobFeeds.size >= JOB_FEED_JOBS_MAX) {
    let oldest: string | undefined;
    for (const [r, f] of jobFeeds) if (oldest === undefined || f.touchedAt < jobFeeds.get(oldest)!.touchedAt) oldest = r;
    jobFeeds.delete(oldest!);
  }
  jobFeeds.set(root, (feed = new LiveFeed<JobUpdate>({ max: JOB_FEED_MAX, keyOf: updateKey })));
  return feed;
}

/** Let every read waiting on a job of this data directory answer now (the
 *  server closing). */
export function wakeJobFeeds(dataDir: string): void {
  const under = join(resolve(dataDir), "jobs") + sep;
  for (const [root, feed] of jobFeeds) if (resolve(root).startsWith(under)) feed.wakeAll();
}

/** What `job/updates` and `GET /jobs/:id/updates` answer. */
export interface JobUpdatesRead {
  job: string;
  cursor: string;
  reset?: true;
  more?: true;
  updates: JobUpdate[];
}

/** A job's updates after `since` (src/live-feed.ts): the newest state of
 *  each thing that changed, in the order they last changed; with `wait`,
 *  held until something does. */
export async function readJobUpdates(
  root: string,
  job: string,
  o: { since?: string; wait?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<JobUpdatesRead> {
  const read: FeedRead<JobUpdate> = await jobFeed(root).read(o);
  const { items, ...rest } = read;
  return { job, ...rest, updates: items };
}

/**
 * Tell the job's host that something changed (plans/live-artifacts.md §2),
 * and keep it for a reader (plans/live-feeds.md §1). Fire and forget: never
 * throws, never waits. Kept whether or not a callback is on file; POSTed
 * only when one is. The URL is read here, at the call, so a sweep that
 * removes the job right after still delivers what it reported on the way
 * out.
 */
export function notifyJob(root: string, job: string, input: JobUpdateInput): void {
  const update: JobUpdate = { event: "job.update", job, at: new Date().toISOString(), ...input };
  jobFeed(root).push(update);
  const url = jobCallbackUrl(root);
  if (!url) return;
  let box = outboxes.get(root);
  if (!box) outboxes.set(root, (box = { pending: new Map(), draining: false }));
  const key = updateKey(input);
  box.pending.delete(key);
  box.pending.set(key, { url, update });
  if (!box.draining) void drainOutbox(root, box);
}

async function drainOutbox(root: string, box: { pending: Map<string, { url: string; update: JobUpdate }>; draining: boolean }): Promise<void> {
  box.draining = true;
  try {
    for (let next = box.pending.entries().next(); !next.done; next = box.pending.entries().next()) {
      const [key, { url, update }] = next.value;
      box.pending.delete(key);
      await postCallback(url, update, {
        tag: `[job ${update.job}] callback job.update`,
        retryDelaysMs: LIVE_RETRY_MS,
        // A room target (`jobCallback: { room: true }`): the rooms of the
        // strut whose data directory holds the job (`jobRoot`).
        room: (actor, payload) => roomsFor(dirname(dirname(root))).deliver(actor, payload),
      });
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
  /** What a run that spends the job's budget cost, when it settles — the
   *  runner's call (`recordJobRunCost`). */
  recordCost?(job: string, runId: string, cost: number): Promise<void>;
  /** The job's budget and spend (`jobBudgetOf`), or undefined with none —
   *  what the runner reads before a run starts under the job. */
  budget?(job: string): Promise<JobBudget | undefined>;
  /** Set or remove the job's budget (`setJobBudget`): a person's call
   *  (`PUT /jobs/:id/budget`, `job/start` / `job/continue` naming one). */
  setBudget?(job: string, usd: number | null): Promise<JobBudget | undefined>;
  /** Tell the job's host that something changed (plans/live-artifacts.md):
   *  a step that wrote a file the person may want to watch — a screenshot,
   *  a walkthrough's frame. Fire and forget: never throws, never waits.
   *  Kept for a reader (`updates`) and POSTed when the job has a callback.
   *  Holds announce themselves. */
  notify?(job: string, update: JobUpdateInput): void;
  /** The job's updates after `since` (plans/live-feeds.md §1): what
   *  `job/updates` and `GET /jobs/:id/updates` read — the same updates a
   *  host hears on its callback, for a reader that has none (an app's page).
   *  With `wait`, held until something changes. */
  updates?(job: string, o?: { since?: string; wait?: number; limit?: number; signal?: AbortSignal }): Promise<JobUpdatesRead>;
  /** The job's claims as the ledger reads them (plans/job-claims.md §6) —
   *  set by the server where the claims layer is on, so `GET /jobs/:id`
   *  and `job/get` carry the same `claims`; absent on a filesystem
   *  workspace. Null for a job not on file. */
  claims?(job: string): Promise<LedgerClaim[] | null>;
  /** A PERSON verifies the job now, against its newest turn (`POST
   *  /jobs/:id/verify`, plans/job-claims.md §5): `manual` checks fire. With
   *  `detach`, `{ job, started: true }` at once — the verdicts arrive as
   *  `job.update`s (`evidence`, then `verify` done) — else the pass and the
   *  ledger. Null for a job not on file. Set where the claims layer is on. */
  verify?(job: string, o?: { claims?: string[]; detach?: boolean }): Promise<unknown | null>;
  /** A PERSON's verdict on a claim about the job, on one of its turns
   *  (`POST /claims/:id/evidence { job, runId }`): `asserted`, `by:
   *  person` — and how an open slot (an external check waiting on a look)
   *  is answered. Set where the claims layer is on. */
  evidence?(input: { job: string; claim: string; runId: string; supports: boolean; content: string; slot?: string }): Promise<unknown>;
  /** Launch the `job` workflow DETACHED under `job` (`job/start`,
   *  `job/continue`): returns once the run is launched, never waits for
   *  it. The run's `run.end` goes to the launching run's own `callback`
   *  (`from`), so the host that asked for the turn hears the job end; no
   *  callback there, none here. `job_busy:` while a run of the job is in
   *  flight. Set by the server; absent on a bare bag. `workflow` is the
   *  job-shaped workflow the turn runs: the launch's, or the record's for a
   *  continue. */
  launch?(opts: JobLaunch): Promise<{ runId: string; callback: boolean; workflow: string }>;
  /** Look at something again later and wake the job once it settles
   *  (plans/job-follow-ups.md): strut runs `look` every `everySeconds`, as
   *  the person of the run that asks, until its output says `settled:
   *  true` or `limitMinutes` pass, then sends the job ONE turn carrying the
   *  answer, its end waking that run's conversation. For a step whose work
   *  goes on after it returns (a build), so the agent ends its turn instead
   *  of waiting. Set by the server; a package's step holds it to its own
   *  run and its package's own steps. */
  followUp?(ask: FollowUpAsk): Promise<{ id: string; until: string }>;
}

/** What `JobsCapability.launch` takes. */
export interface JobLaunch {
  job: string;
  /** Names the job (`POST …/run { title }`). */
  title?: string;
  /** Which job-shaped workflow runs the turn (`JOB_WORKFLOWS`). `job/start`
   *  names one (`job` by default); `job/continue` leaves it out and the
   *  launcher follows the job's record — the workflow its newest turn ran,
   *  with that turn's `input.peer` carried along — so a builder job on a
   *  peer stays one without the caller remembering where it lives. */
  workflow?: JobWorkflow;
  /** The workflow's input: `prompt`, and `session`, `repos`, `workspace`,
   *  `peer` (a builder job on another strut). */
  input: Record<string, unknown>;
  /** The launching run (`ctx.runId`): whose callback the job's run.end goes
   *  to, and whose `jobCallback` the job inherits (CALLBACKS.md §5). */
  from: string;
  /** Billed like the launching run. */
  actor?: string;
  principal?: string;
  /** The launching run's caller's MCP servers (`ctx.mcp`): the job's agents
   *  reach the same caller. */
  mcp?: McpServer[];
  /** Files for the job's run (`POST …/run { attachments }`'s, read back from
   *  the launching run's artifacts): saved under the job run's artifacts and
   *  put on its agent's prompt. */
  attachments?: Attachment[];
  /** The job's budget in dollars, set on its record before the run
   *  launches (`job/start`, `job/continue` naming one): the person's word,
   *  passed on by their conversation. Absent: the record's stands. */
  budgetUsd?: number;
}

/** The record's own writer, index or not. `index` (a server's stores) adds
 *  `list` / `get` / `read` — what the `/jobs` routes and the `job/*` steps
 *  read through. */
export function jobsCapability(
  dataDir: string,
  index?: JobIndex,
  deps: {
    /** The job's run in flight, for a hold's update: `hold` / `release`
     *  are called by tools with no run in hand, and a host routes an update
     *  by the run that made it (CALLBACKS.md §5). The server knows. */
    runOf?: (job: string) => string | undefined;
  } = {},
): JobsCapability {
  const rootOf = (job: string) => {
    const problem = idProblem(job);
    if (problem) throw new Error(`jobs: job id "${job}" ${problem}`);
    return jobRoot(dataDir, job);
  };
  const withRun = (job: string, update: JobUpdateInput): JobUpdateInput => {
    const runId = deps.runOf?.(job);
    return runId ? { ...update, runId } : update;
  };
  return {
    ...index,
    async hold(job, hold) {
      const root = rootOf(job);
      const held: JobHold = { ...hold, since: hold.since ?? new Date().toISOString() };
      await updateJobRecord(root, job, (rec) => {
        rec.holds = [...(rec.holds ?? []).filter((h) => h.id !== hold.id), held];
      });
      notifyJob(root, job, withRun(job, holdUpdate(held, "held")));
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
    async recordCost(job, runId, cost) {
      await recordJobRunCost(rootOf(job), runId, cost);
    },
    async budget(job) {
      return jobBudgetOf(await readJobRecord(rootOf(job)));
    },
    async setBudget(job, cap) {
      return jobBudgetOf(await setJobBudget(rootOf(job), job, cap));
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
      if (gone) notifyJob(root, job, withRun(job, holdUpdate(gone, "released")));
    },
    async holds(job) {
      return (await readJobRecord(rootOf(job)))?.holds ?? [];
    },
    notify(job, update) {
      if (idProblem(job)) return;
      notifyJob(jobRoot(dataDir, job), job, update);
    },
    updates(job, o) {
      return readJobUpdates(rootOf(job), job, o);
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
    if (held.get(root) !== ctx.runId) return;
    held.delete(root);
    const waiting = letGo.get(root);
    letGo.delete(root);
    for (const told of waiting ?? []) told();
  });
}

/** Who waits for a job's hold to go (`reholdJob`): told the moment it does. */
const letGo = new Map<string, Set<() => void>>();
/** How often a run waiting for a job's hold looks at its own cancel and pause. */
const REHOLD_CHECK_MS = 250;

/** `holdJob` for a run a durable resume carries past the step that took the
 *  hold (`StepDef.onReplay`: a wake, a restart, a person's resume). A park
 *  or the dead process let the hold go, so it is taken again before the
 *  steps it guards. When another run took the job in between, the resumed
 *  run WAITS for that one to let go — live, its cancel and pause looked at
 *  every quarter second, told at once when the hold goes — and never fails
 *  `job_busy:`, which is a fresh launch's answer: a resume is the same run
 *  going on, and a run that waited days for a person must not be lost to a
 *  turn that happened to be running. */
export async function reholdJob(ctx: Pick<StepContext<unknown>, "runId" | "onRunEnd" | "control">, root: string, name: string): Promise<void> {
  if (!ctx.onRunEnd) return;
  let said = false;
  for (;;) {
    const by = held.get(root);
    if (by === undefined || by === ctx.runId || isAncestorRun(ctx.control, by)) return holdJob(ctx, root, name);
    if (!said) {
      console.log(`[jobs] run ${ctx.runId} waits for run ${by} to let go of job "${name}" before it goes on`);
      said = true;
    }
    await new Promise<void>((resolve) => {
      const waiting = letGo.get(root) ?? new Set<() => void>();
      letGo.set(root, waiting);
      const done = () => {
        clearTimeout(timer);
        waiting.delete(done);
        if (!waiting.size && letGo.get(root) === waiting) letGo.delete(root);
        resolve();
      };
      const timer = setTimeout(done, REHOLD_CHECK_MS);
      waiting.add(done);
    });
    // Throws when the run is being cancelled; blocks while it is paused.
    await ctx.control?.checkpoint();
  }
}

/** The run holding a job's directory, if any. */
export function jobHolder(root: string): string | undefined {
  return held.get(root);
}

/** How long a job may sit unused before its repositories are removed
 *  (`STRUT_WORKDIR_TTL_DAYS`, default 7). `0` keeps them forever. */
export function jobTtlMs(): number {
  const raw = bootEnv()["STRUT_WORKDIR_TTL_DAYS"];
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
 * a timer. It reads only the jobs in `.sweep` (`needsSweep`): jobs with
 * repositories or holds, and fresh records with no runs. A job of runs
 * alone, which is most of them, costs a turn nothing. Returns the names it
 * touched. Never throws: a job that cannot be swept, and a hold that will
 * not release, are tried again next time.
 */
export async function sweepJobs(shell: ShellCapability, dataDir: string, ttlMs: number, opts: SweepOptions = {}): Promise<string[]> {
  if (!ttlMs) return [];
  const now = opts.now ?? Date.now();
  const idle = (rec: JobRecord) => now - Date.parse(rec.usedAt) > ttlMs;
  const base = join(dataDir, "jobs");
  await jobsIndexed(dataDir);
  let marks: string[];
  try {
    marks = await readdir(join(base, SWEEP_DIR));
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const mark of marks) {
    const root = join(base, mark);
    if (held.has(root)) continue;
    const rec = await readJobRecord(root);
    if (rec && idle(rec)) {
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
          await unindexJob(root, rec);
          swept.push(rec.name);
        } else if (repos.length || released) {
          await withLock(`${root}.json`, () => writeJobRecord(root, rec));
          swept.push(rec.name);
        }
      } catch (err) {
        console.warn(`[jobs] could not sweep job "${rec.name}":`, (err as Error).message);
        continue;
      }
    }
    // Read again under the lock: a write since may have given it more to sweep.
    await withLock(`${root}.json`, async () => {
      const after = await readJobRecord(root);
      if (!after || !needsSweep(after, idle(after))) await rm(sweepFile(root), { force: true });
    });
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
  await unindexJob(root, rec);
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

/** The folder of a job's directory that uploads go into (plans/apps.md §12). */
export const JOB_UPLOADS_DIR = "uploads";

/** Save a file into a job's `uploads/`, never over one already there (a
 *  taken name is numbered), and stamp the job used — which makes its
 *  record when there is none. Takes no hold: a file may arrive while a run
 *  of the job is in flight. Returns the path relative to the job's
 *  directory, `uploads/<name>`. */
export async function saveJobUpload(root: string, job: string, file: { name: string; bytes: Buffer }): Promise<string> {
  const abs = await writeNewFile(join(root, JOB_UPLOADS_DIR), file.name, file.bytes);
  await touchJob(root, job);
  return relative(root, abs).split(sep).join("/");
}

/** Remove one upload: a file under the job's `uploads/` and nowhere else.
 *  False when there is no such file. */
export async function deleteJobUpload(root: string, job: string, relPath: string): Promise<boolean> {
  const abs = jobFilePath(root, relPath);
  const uploads = join(root, JOB_UPLOADS_DIR);
  if (!abs.startsWith(uploads + sep)) throw new Error(`jobs: only a file under ${JOB_UPLOADS_DIR}/ is an upload: ${relPath}`);
  try {
    await rm(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  await touchJob(root, job);
  return true;
}

/** Relative paths of every file in a job's directory, recursive and sorted,
 *  skipping its repositories (a checkout is not a deliverable, and can be
 *  enormous): the walk never enters one, so a checkout's `node_modules` is
 *  not read on every `GET /jobs/:id`. `[]` for a job with no directory. */
export async function listJobFiles(root: string, rec: JobRecord | null): Promise<string[]> {
  const repoDirs = new Set(Object.keys(rec?.repos ?? {}).map((d) => resolve(d)));
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return; // no directory, or gone mid-walk
      throw err;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!repoDirs.has(resolve(abs))) await walk(abs);
      } else if (e.isFile()) out.push(relative(root, abs));
    }
  };
  await walk(root);
  return out.sort();
}

// ── one writer per key ────────────────────────────────────────────────────

export { withLock };
