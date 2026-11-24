/**
 * The job INDEX (plans/job-index.md §2–§3): a job read back as one view —
 * its record (`jobs.ts`: title, who started it, one line per run, holds,
 * repositories), its runs' status from the run store, its threads from the
 * session store, its files, and its CURRENT deliverables folded from its
 * runs' outputs. The record stays the store of record; this is the read
 * side, one policy layer behind both doors: `GET /jobs[/:id]` and the
 * `job/list` / `job/get` / `job/read` steps an agent is granted. Every read
 * works on the filesystem backend with no graph at all; the graph's
 * `StrutJob` node (projector.ts) is built from `get`.
 *
 * The fold is where "the same `id` on a later run is a newer version of
 * the same thing" (plans/jobs.md §3) becomes real: the job's top-level
 * successful runs, newest first, the first occurrence of each id winning,
 * resolved to links the way a run's own `…/artifacts` are. Nothing is
 * stored; a file a later turn overwrote serves the later bytes behind the
 * same link. A child run's artifacts are never folded — a turn names what
 * it wants shown. A turn that ran on a peer (the `builder`'s `remote`
 * branch) folds its deliverables tagged with that peer, as they came: never
 * a link here, never `not found` (artifact-refs.ts).
 */

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { RunArchiveError } from "./run-archive.js";
import type { RunStore } from "./store.js";
import type { SessionInfo, SessionStore } from "./session-store.js";
import { idProblem, sessionInfo } from "./session-store.js";
import { artifactEntriesOf, artifactKind, resolveArtifactRefs, type ArtifactRef } from "./artifact-refs.js";
import { jobBudgetOf, jobFilePath, jobHolder, jobRoot, jobsByUse, jobSpentUsd, listJobFiles, noteJobSessions, readJobRecord, turnOf, type JobBudget, type JobHold, type JobRecord, type JobRun } from "./jobs.js";
import { foldJobThreads, type JobThread, type ThreadRun } from "./job-threads.js";
import { searchWorkflows } from "./search.js";

export interface JobIndexDeps {
  dataDir: string;
  /** Summaries for the run list and the artifact fold; logs for the threads. */
  store: Pick<RunStore, "getRunSummary" | "getRunEvents">;
  /** `turns` reads a job's threads (`JobRecord.sessions`) — their turn
   *  lines, the context after each turn — for the view and the thread fold.
   *  `list` is read once per server, to fill in the records from before
   *  `sessions` was kept (`sessionsIndexed`). */
  sessions?: Pick<SessionStore, "list" | "turns">;
  /** Whether a run is executing in this process (a run controller). A run
   *  with no summary that is not is `stale` — cut off by a restart and not
   *  resumed. Absent, such a run reads `running`. */
  isLive?: (workflow: string, runId: string) => boolean;
  /** Which run holds a thread now (`SessionsCapability.holder`), for `busy`. */
  sessionHolder?: (id: string) => unknown;
  /** A workflow the meta surface may not read the runs of (`Flow.sealed`,
   *  src/sealed.ts): its runs are listed with their status and nothing
   *  more, and their artifacts are not folded — `job/get` is that surface
   *  from inside a run. */
  sealed?: (workflow: string) => Promise<boolean>;
  /** A published app's version — the active one, or the one named — with
   *  its build, for a `{ kind: "app", app: <name> }` deliverable (the
   *  builder's); null for no such app. Absent, such an entry is an error. */
  appVersion?: (name: string, version?: string) => Promise<{ version: string; hash?: string; builtAt?: string } | null>;
}

/** One row of `GET /jobs`. */
export interface JobListing {
  job: string;
  title?: string;
  createdBy?: string;
  /** Everyone who launched a run under the job, first seen first. */
  actors?: string[];
  createdAt?: string;
  usedAt: string;
  /** The run holding the directory now. */
  busy?: string;
  /** The workflow the job's newest TURN ran — `job` or `builder`
   *  (`turnOf`, `JOB_WORKFLOWS`): what the job is, what `job/continue`
   *  launches next. Absent before the first turn. */
  workflow?: string;
  runs: number;
  holds: number;
  /** What the job's model calls cost so far, in dollars (`jobSpentUsd`: its
   *  `spent` ledger, every run that spends its budget). Absent before a run
   *  that called a model settled. */
  spentUsd?: number;
  /** The job's budget (src/jobs.ts `budgetUsd`): its cap in dollars, what
   *  it has spent and what is left. Absent with none. */
  budget?: JobBudget;
}

export interface JobRunView extends JobRun {
  /** From the run's summary; without one, `running` while it executes and
   *  `stale` when a restart cut it off and it was not resumed. */
  status: "running" | "success" | "error" | "cancelled" | "waiting" | "stale";
  durationMs?: number;
  error?: string;
  /** A sealed workflow's run: nothing of it is read past its status. */
  sealed?: true;
}

/** One current deliverable: a resolved ref, and the run that last reported it. */
export interface JobArtifact extends ArtifactRef {
  runId: string;
  /** Relative to the job's directory, as declared — what `job/read` takes.
   *  With `peer`: relative to that peer's `job` directory, unread here. */
  path?: string;
}

/** `GET /jobs/:id`. */
export interface JobView extends Omit<JobListing, "runs" | "holds"> {
  holds: JobHold[];
  /** The address of what the job holds, by kind: the first hold of each
   *  kind that has a `url` (`{ pod: "https://…" }`), then each hold's named
   *  `links` by name (`{ pod, admin }`). A job with two pods names them by
   *  id in `holds`. */
  urls: Record<string, string>;
  /** The repositories checked out into the directory, relative to it. */
  repos: string[];
  /** Every file in the directory, repositories skipped. */
  files: string[];
  /** Newest first. */
  runs: JobRunView[];
  /** The threads made under the job (a turn line's `job`), or named after
   *  it — the job id, or `<job>/…` — for threads committed before the line
   *  carried the field. Read from the record's `sessions`, newest first. */
  sessions: Array<SessionInfo & { busy?: true }>;
  /** The current deliverables (the fold). */
  artifacts: JobArtifact[];
  /** The latest reply: `output.text` of the newest successful top-level
   *  run, when its output carries one. */
  text?: string;
  /** The job's agent threads (plans/jobs-sidebar.md §1, `src/job-threads.ts`):
   *  every agent execution in its runs' logs grouped by session, each turn
   *  with its run, usage, cost, tool calls and the artifacts that run
   *  declared, and under it what it spawned. Chronological. Absent when
   *  not asked for (`threads: false`). */
  threads?: JobThread[];
  /** Runs past `limit` (newest first) that the thread fold left out. */
  omittedRuns?: number;
}

export interface GetJobOptions {
  /** Fold the threads (default true). */
  threads?: boolean;
  /** Include each turn's touched graph nodes (default: a count only). */
  nodes?: boolean;
  /** How many runs, newest first, the thread fold reads (default 100). */
  limit?: number;
}

/** The thread fold reads this many runs unless told otherwise. */
export const THREADS_RUN_LIMIT = 100;

/** One file of a job's directory, for the agent's door (`job/read`). */
export interface JobFile {
  path: string;
  /** The renderer kind, by extension (`artifactKind`). */
  kind: string;
  /** A text file's content, cut to the cap keeping head and tail. */
  text?: string;
  truncated?: true;
  /** An image, for a caller that can show one (`withMedia`). */
  image?: { mediaType: string; data: Uint8Array };
  /** Why neither: a binary kind this door does not read. */
  error?: string;
}

export interface JobIndex {
  /** Every job, newest-used first, at most `limit`. Records are read
   *  newest first and the reading stops once `limit` rows are found
   *  (`jobsByUse`), so a listing never reads every record on the server;
   *  a filter reads further back to fill it. `q` is the one matcher behind
   *  every search box (src/search.ts): every word must hit the title (the
   *  id without one) or a current artifact's title or summary. With
   *  `limit`, it answers the newest `limit` matches, title hits first.
   *  `workflow` keeps the jobs with a recorded run of that workflow (the
   *  sidebar's filter when one is selected); `actor` the jobs that actor
   *  launched a run of (`GET /jobs?mine=1`); `prefix` the jobs whose id
   *  starts with it (an app's own, `app/<name>/`, plans/apps.md §12),
   *  decided before a record is read. */
  list(opts?: { q?: string; workflow?: string; actor?: string; prefix?: string; limit?: number }): Promise<JobListing[]>;
  /** One job; `null` when there is neither a record nor a directory. */
  get(job: string, opts?: GetJobOptions): Promise<JobView | null>;
  /** The job's runs as its record lists them, newest first — no status,
   *  nothing read past the record: what a claims read needs (the active
   *  turn, whether a run is one of the job's). `null` when `get` is. */
  runs(job: string): Promise<JobRun[] | null>;
  /** One file of a job's directory; `null` when it is not there. */
  read(job: string, path: string, opts?: { maxChars?: number }): Promise<JobFile | null>;
}

/** Marks the one pass that filled `JobRecord.sessions` in (`sessionsIndexed`). */
export const SESSIONS_INDEXED = ".sessions-indexed";

/** The cap on what `read` hands back of a text file. */
export const JOB_READ_MAX_CHARS = 50_000;

const IMAGE_MEDIA: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const BINARY_KINDS = new Set(["image", "video", "audio", "pdf"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `s` within `max` chars: its head and tail, the middle marked. */
export function headTail(s: string, max: number): { text: string; truncated?: true } {
  if (s.length <= max) return { text: s };
  const half = Math.max(0, Math.floor(max / 2));
  return { text: `${s.slice(0, half)}\n[... ${s.length - 2 * half} chars truncated ...]\n${s.slice(s.length - half)}`, truncated: true };
}

/** `urls` (plans/job-claims.md §3): a fold over the holds by kind, the
 *  first with a url winning, then each hold's named `links` by name. A name
 *  never takes a kind's place: `urls.pod` stays the pod's own address. */
export function holdUrls(holds: readonly JobHold[]): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const h of holds) if (h.url && !(h.kind in urls)) urls[h.kind] = h.url;
  for (const h of holds) {
    for (const [name, url] of Object.entries(h.links ?? {})) if (name && typeof url === "string" && url && !(name in urls)) urls[name] = url;
  }
  return urls;
}

/** A record from before `actors` was kept has only its first actor. */
const actorsOf = (rec: JobRecord): string[] => rec.actors ?? (rec.createdBy ? [rec.createdBy] : []);

export function createJobIndex(deps: JobIndexDeps): JobIndex {
  const rootOf = (job: string) => jobRoot(deps.dataDir, job);

  const listing = (rec: JobRecord): JobListing => {
    const busy = jobHolder(rootOf(rec.name));
    const turn = turnOf(rec.runs);
    const spentUsd = jobSpentUsd(rec);
    const budget = jobBudgetOf(rec);
    return {
      job: rec.name,
      ...(rec.title ? { title: rec.title } : {}),
      ...(rec.createdBy ? { createdBy: rec.createdBy } : {}),
      ...(actorsOf(rec).length ? { actors: actorsOf(rec) } : {}),
      ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
      usedAt: rec.usedAt,
      ...(busy ? { busy } : {}),
      ...(turn ? { workflow: turn.workflow } : {}),
      runs: rec.runs?.length ?? 0,
      holds: rec.holds?.length ?? 0,
      ...(spentUsd > 0 ? { spentUsd } : {}),
      ...(budget ? { budget } : {}),
    };
  };

  /** The job's runs that may be read past their status — asked once per
   *  workflow per read, since a job's hundred turns are one workflow. */
  const readableOnce = (): ((workflow: string) => Promise<boolean>) => {
    const seen = new Map<string, Promise<boolean>>();
    return (workflow) => {
      let readable = seen.get(workflow);
      if (!readable) seen.set(workflow, (readable = (async () => !(await deps.sealed?.(workflow)))()));
      return readable;
    };
  };

  const appsAt = deps.appVersion ? { appVersion: deps.appVersion } : {};

  /** Does a `/jobs/<id>/files/…` link point at a file in `root`? (Any other
   *  url is taken as given.) */
  const existsIn = (root: string) => async (url: string): Promise<boolean> => {
    const m = /^\/jobs\/[^/]+\/files\/(.+)$/.exec(url);
    if (!m) return true;
    try {
      await access(jobFilePath(root, decodeURIComponent(m[1]!)));
      return true;
    } catch {
      return false;
    }
  };


  /** §1 of plans/jobs-sidebar.md: the newest `limit` readable runs, their
   *  logs and resolved deliverables, folded with the sessions' turn lines. */
  const threadsOf = async (
    rec: JobRecord,
    sessions: SessionInfo[],
    opts: GetJobOptions,
    readable: (workflow: string) => Promise<boolean>,
  ): Promise<{ threads: JobThread[]; omittedRuns?: number }> => {
    const lines = [...(rec.runs ?? [])].reverse();
    const limit = opts.limit && opts.limit > 0 ? opts.limit : THREADS_RUN_LIMIT;
    const exists = existsIn(rootOf(rec.name));
    // What the job holds at an address: a deliverable link there is left out.
    const held = async () => (rec.holds ?? []).flatMap((h) => (h.url ? [h.url] : []));
    const runs: ThreadRun[] = [];
    for (const line of lines.slice(0, limit)) {
      if (!(await readable(line.workflow))) continue;
      const summary = await deps.store.getRunSummary(line.workflow, line.runId);
      // An archived log is restored by this read. One the bucket cannot
      // give back reads as an evicted one: the job still opens.
      const events = await deps.store.getRunEvents(line.workflow, line.runId).catch((err) => {
        if (err instanceof RunArchiveError) return [];
        throw err;
      });
      const artifacts = summary?.status === "success" ? await resolveArtifactRefs(summary.output, { runId: line.runId, job: rec.name, exists, held, ...appsAt }) : undefined;
      const stale = !summary && deps.isLive && !deps.isLive(line.workflow, line.runId);
      runs.push({ ...line, summary, ...(stale ? { stale: true as const } : {}), events, ...(artifacts?.length ? { artifacts } : {}) });
    }
    // The turn lines alone: a thread's messages are not what the fold reads.
    const turnLines = (await Promise.all(sessions.map((s) => deps.sessions?.turns(s.id).catch(() => [])))).flatMap((t) => t ?? []);
    const omitted = lines.length - Math.min(lines.length, limit);
    return { threads: foldJobThreads(runs, turnLines, { nodes: !!opts.nodes }), ...(omitted > 0 ? { omittedRuns: omitted } : {}) };
  };

  /** §3: the current deliverables, and the latest reply. */
  const fold = async (rec: JobRecord, readable: (workflow: string) => Promise<boolean>): Promise<{ artifacts: JobArtifact[]; text?: string }> => {
    const seen = new Set<string>();
    const kept: Array<{ raw: Record<string, unknown>; runId: string }> = [];
    let text: string | undefined;
    for (const run of [...(rec.runs ?? [])].reverse()) {
      if (run.parentRunId || !(await readable(run.workflow))) continue;
      const summary = await deps.store.getRunSummary(run.workflow, run.runId);
      if (summary?.status !== "success") continue;
      const output = summary.output;
      if (text === undefined && isRecord(output) && typeof output["text"] === "string") text = output["text"];
      for (const raw of artifactEntriesOf(output) ?? []) {
        if (!isRecord(raw) || typeof raw["id"] !== "string" || typeof raw["title"] !== "string" || seen.has(raw["id"])) continue;
        seen.add(raw["id"]);
        kept.push({ raw, runId: run.runId });
      }
    }
    const exists = existsIn(rootOf(rec.name));
    // What the job holds at an address: a deliverable link there is left out.
    const held = async () => (rec.holds ?? []).flatMap((h) => (h.url ? [h.url] : []));
    const artifacts: JobArtifact[] = [];
    for (const { raw, runId } of kept) {
      const [ref] = (await resolveArtifactRefs({ artifacts: [raw] }, { runId, job: rec.name, exists, held, ...appsAt })) ?? [];
      if (!ref) continue;
      // The file the entry resolved to (a recording's directory resolves to
      // its manifest), relative to the job's directory: what job/read takes.
      const prefix = `/jobs/${encodeURIComponent(rec.name)}/files/`;
      const path = typeof raw["path"] === "string" && ref.url ? (ref.url.startsWith(prefix) ? ref.url.slice(prefix.length) : raw["path"].replace(/^\/+/, "")) : undefined;
      artifacts.push({ ...ref, runId, ...(path ? { path } : {}) });
    }
    return { artifacts, ...(text !== undefined ? { text } : {}) };
  };

  /** The job's record; a directory with no record beside it (the record
   *  was removed by hand) is still a job, with files and nothing else.
   *  `null` for neither. */
  const recordOf = async (job: string): Promise<JobRecord | null> => {
    if (idProblem(job)) return null;
    const root = rootOf(job);
    const rec = await readJobRecord(root);
    if (rec) return rec;
    try {
      await access(root);
      return { name: job, usedAt: "", repos: {} };
    } catch {
      return null;
    }
  };

  /** The job's threads, newest first: the sessions its record lists, each
   *  read on its own — never every session on the server. */
  const sessionsOf = async (rec: JobRecord): Promise<SessionInfo[]> => {
    const store = deps.sessions;
    if (!store || !rec.sessions?.length) return [];
    const infos = await Promise.all(rec.sessions.map(async (id) => sessionInfo(id, await store.turns(id).catch(() => []))));
    return infos.filter((s): s is SessionInfo => s !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  /**
   * `JobRecord.sessions` filled in on the records from before it was kept:
   * ONE pass over the session store per server, the first time a job is
   * read, marked done in `jobs/.sessions-indexed` (no job id starts with a
   * dot). A thread counts as before — a turn line's `job`, or named after
   * the job (`<job>` or `<job>/…`). From then on a commit notes its thread
   * itself (`recordingJobSessions`). A pass that fails is logged and not
   * tried again until a restart: the records keep what they have.
   */
  let indexing: Promise<void> | undefined;
  const sessionsIndexed = (): Promise<void> =>
    (indexing ??= (async () => {
      const store = deps.sessions;
      if (!store) return;
      const base = join(deps.dataDir, "jobs");
      const marker = join(base, SESSIONS_INDEXED);
      try {
        await access(marker);
        return;
      } catch {
        // not yet
      }
      const jobs = new Set<string>();
      for (const f of await readdir(base).catch(() => [] as string[])) {
        if (!f.endsWith(".json")) continue;
        try {
          jobs.add(decodeURIComponent(f.slice(0, -".json".length)));
        } catch {
          // not a name strut wrote
        }
      }
      const byJob = new Map<string, string[]>();
      for (const s of await store.list()) {
        const of = new Set(s.jobs ?? []);
        const segments = s.id.split("/");
        for (let i = 1; i <= segments.length; i++) of.add(segments.slice(0, i).join("/"));
        for (const job of of) if (jobs.has(job)) byJob.set(job, [...(byJob.get(job) ?? []), s.id]);
      }
      // Oldest first, as a commit would have noted them.
      for (const [job, ids] of byJob) await noteJobSessions(rootOf(job), ids.reverse());
      await mkdir(base, { recursive: true });
      await writeFile(marker, `${new Date().toISOString()}\n`, "utf-8");
    })().catch((err) => console.warn("[job-index] threads not indexed — records keep what they have:", err)));

  return {
    // Newest-used first through `jobsByUse`, one record at a time, stopping
    // at `limit`: a listing reads what it returns, plus the jobs its
    // filters pass over on the way.
    async list(opts = {}) {
      const q = opts.q?.trim();
      const readable = readableOnce();
      const found: Array<{ name: string; description?: string; row: JobListing }> = [];
      for await (const rec of jobsByUse(deps.dataDir, opts.prefix ? (job) => job.startsWith(opts.prefix!) : undefined)) {
        if (opts.workflow && !rec.runs?.some((r) => r.workflow === opts.workflow)) continue;
        if (opts.actor && !actorsOf(rec).includes(opts.actor)) continue;
        const entry = { name: rec.title ?? rec.name, row: listing(rec) };
        if (q) {
          const { artifacts } = await fold(rec, readable);
          const description = [rec.name, ...artifacts.map((a) => [a.title, a.summary].filter(Boolean).join(" — "))].join(" ");
          if (!searchWorkflows([{ ...entry, description }], q).length) continue;
          found.push({ ...entry, description });
        } else found.push(entry);
        if (opts.limit && found.length >= opts.limit) break;
      }
      // With `q`, the newest `limit` matches, title hits first.
      return (q ? searchWorkflows(found, q) : found).map((f) => f.row);
    },

    async get(job, opts = {}) {
      await sessionsIndexed();
      const rec = await recordOf(job);
      if (!rec) return null;
      const root = rootOf(job);
      const readable = readableOnce();
      const runs: JobRunView[] = [];
      for (const line of [...(rec.runs ?? [])].reverse()) {
        const summary = await deps.store.getRunSummary(line.workflow, line.runId);
        const view: JobRunView = {
          ...line,
          status: summary?.status ?? (deps.isLive && !deps.isLive(line.workflow, line.runId) ? "stale" : "running"),
        };
        if (!(await readable(line.workflow))) view.sealed = true;
        else {
          if (summary?.durationMs != null) view.durationMs = summary.durationMs;
          if (summary?.error?.message) view.error = summary.error.message;
        }
        runs.push(view);
      }
      const sessions = (await sessionsOf(rec)).map((s) => ({ ...s, ...(deps.sessionHolder?.(s.id) ? { busy: true as const } : {}) }));
      const { runs: _n, holds: _h, ...head } = listing(rec);
      return {
        ...head,
        holds: rec.holds ?? [],
        urls: holdUrls(rec.holds ?? []),
        repos: Object.keys(rec.repos).map((dir) => relative(root, dir)),
        files: await listJobFiles(root, rec),
        runs,
        sessions,
        ...(await fold(rec, readable)),
        ...(opts.threads === false ? {} : await threadsOf(rec, sessions, opts, readable)),
      };
    },

    async runs(job) {
      const rec = await recordOf(job);
      return rec ? [...(rec.runs ?? [])].reverse() : null;
    },

    async read(job, path, opts = {}) {
      if (idProblem(job)) return null;
      const abs = jobFilePath(rootOf(job), path);
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "EISDIR" || err?.code === "ENOTDIR") return null;
        throw err;
      }
      const kind = artifactKind(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const mediaType = IMAGE_MEDIA[ext];
      if (mediaType) return { path, kind, image: { mediaType, data: new Uint8Array(bytes) } };
      if (BINARY_KINDS.has(kind) && ext !== "svg") {
        return { path, kind, error: `a ${kind} file: open it at /jobs/${encodeURIComponent(job)}/files/${path}` };
      }
      return { path, kind, ...headTail(bytes.toString("utf8"), opts.maxChars ?? JOB_READ_MAX_CHARS) };
    },
  };
}
