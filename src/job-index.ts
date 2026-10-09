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
 * it wants shown.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RunStore } from "./store.js";
import type { SessionInfo, SessionStore } from "./session-store.js";
import { idProblem } from "./session-store.js";
import { artifactEntriesOf, artifactKind, resolveArtifactRefs, type ArtifactRef } from "./artifact-refs.js";
import { jobFilePath, jobHolder, jobRoot, listJobFiles, readJobRecord, type JobHold, type JobRecord, type JobRun } from "./jobs.js";
import { searchWorkflows } from "./search.js";

export interface JobIndexDeps {
  dataDir: string;
  store: Pick<RunStore, "getRunSummary">;
  sessions?: Pick<SessionStore, "list">;
  /** Which run holds a thread now (`SessionsCapability.holder`), for `busy`. */
  sessionHolder?: (id: string) => unknown;
  /** A workflow the meta surface may not read the runs of (`Flow.sealed`,
   *  src/sealed.ts): its runs are listed with their status and nothing
   *  more, and their artifacts are not folded — `job/get` is that surface
   *  from inside a run. */
  sealed?: (workflow: string) => Promise<boolean>;
}

/** One row of `GET /jobs`. */
export interface JobListing {
  job: string;
  title?: string;
  createdBy?: string;
  createdAt?: string;
  usedAt: string;
  /** The run holding the directory now. */
  busy?: string;
  runs: number;
  holds: number;
}

export interface JobRunView extends JobRun {
  /** From the run's summary; `running` while it has none. */
  status: "running" | "success" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  /** A sealed workflow's run: nothing of it is read past its status. */
  sealed?: true;
}

/** One current deliverable: a resolved ref, and the run that last reported it. */
export interface JobArtifact extends ArtifactRef {
  runId: string;
  /** Relative to the job's directory, as declared — what `job/read` takes. */
  path?: string;
}

/** `GET /jobs/:id`. */
export interface JobView extends Omit<JobListing, "runs" | "holds"> {
  holds: JobHold[];
  /** The repositories checked out into the directory, relative to it. */
  repos: string[];
  /** Every file in the directory, repositories skipped. */
  files: string[];
  /** Newest first. */
  runs: JobRunView[];
  /** The threads made under the job (a turn line's `job`), or named after
   *  it — the job id, or `<job>/…` — for threads committed before the line
   *  carried the field. */
  sessions: Array<SessionInfo & { busy?: true }>;
  /** The current deliverables (the fold). */
  artifacts: JobArtifact[];
  /** The latest reply: `output.text` of the newest successful top-level
   *  run, when its output carries one. */
  text?: string;
}

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
  /** Every job, newest-used first. `q` is the one matcher behind every
   *  search box (src/search.ts): every word must hit the title (the id
   *  without one) or a current artifact's title or summary. */
  list(opts?: { q?: string; limit?: number }): Promise<JobListing[]>;
  /** One job; `null` when there is neither a record nor a directory. */
  get(job: string): Promise<JobView | null>;
  /** One file of a job's directory; `null` when it is not there. */
  read(job: string, path: string, opts?: { maxChars?: number }): Promise<JobFile | null>;
}

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

export function createJobIndex(deps: JobIndexDeps): JobIndex {
  const rootOf = (job: string) => jobRoot(deps.dataDir, job);

  const listing = (rec: JobRecord): JobListing => {
    const busy = jobHolder(rootOf(rec.name));
    return {
      job: rec.name,
      ...(rec.title ? { title: rec.title } : {}),
      ...(rec.createdBy ? { createdBy: rec.createdBy } : {}),
      ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
      usedAt: rec.usedAt,
      ...(busy ? { busy } : {}),
      runs: rec.runs?.length ?? 0,
      holds: rec.holds?.length ?? 0,
    };
  };

  /** The job's runs that may be read past their status. */
  const readable = async (workflow: string) => !(await deps.sealed?.(workflow));

  /** §3: the current deliverables, and the latest reply. */
  const fold = async (rec: JobRecord): Promise<{ artifacts: JobArtifact[]; text?: string }> => {
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
    const root = rootOf(rec.name);
    const exists = async (url: string): Promise<boolean> => {
      const m = /^\/jobs\/[^/]+\/files\/(.+)$/.exec(url);
      if (!m) return true;
      try {
        await access(jobFilePath(root, decodeURIComponent(m[1]!)));
        return true;
      } catch {
        return false;
      }
    };
    const artifacts: JobArtifact[] = [];
    for (const { raw, runId } of kept) {
      const [ref] = (await resolveArtifactRefs({ artifacts: [raw] }, { runId, job: rec.name, exists })) ?? [];
      if (!ref) continue;
      const path = typeof raw["path"] === "string" && ref.url ? raw["path"].replace(/^\/+/, "") : undefined;
      artifacts.push({ ...ref, runId, ...(path ? { path } : {}) });
    }
    return { artifacts, ...(text !== undefined ? { text } : {}) };
  };

  const records = async (): Promise<JobRecord[]> => {
    const base = join(deps.dataDir, "jobs");
    let files: string[];
    try {
      files = (await readdir(base)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const recs = await Promise.all(files.map((f) => readJobRecord(join(base, f.slice(0, -".json".length)))));
    return recs
      .filter((r): r is JobRecord => r !== null)
      .sort((a, b) => (Date.parse(b.usedAt) || 0) - (Date.parse(a.usedAt) || 0));
  };

  return {
    async list(opts = {}) {
      const recs = await records();
      let rows = recs.map(listing);
      if (opts.q?.trim()) {
        const searchable = await Promise.all(
          recs.map(async (rec, i) => {
            const { artifacts } = await fold(rec);
            const description = [rec.name, ...artifacts.map((a) => [a.title, a.summary].filter(Boolean).join(" — "))].join(" ");
            return { name: rec.title ?? rec.name, description, row: rows[i]! };
          }),
        );
        rows = searchWorkflows(searchable, opts.q).map((m) => m.row);
      }
      return opts.limit ? rows.slice(0, opts.limit) : rows;
    },

    async get(job) {
      if (idProblem(job)) return null;
      const root = rootOf(job);
      let rec = await readJobRecord(root);
      if (!rec) {
        // A directory with no record beside it (the record was removed by
        // hand): still a job, with files and nothing else.
        try {
          await access(root);
          rec = { name: job, usedAt: "", repos: {} };
        } catch {
          return null;
        }
      }
      const runs: JobRunView[] = [];
      for (const line of [...(rec.runs ?? [])].reverse()) {
        const summary = await deps.store.getRunSummary(line.workflow, line.runId);
        const view: JobRunView = { ...line, status: summary?.status ?? "running" };
        if (!(await readable(line.workflow))) view.sealed = true;
        else {
          if (summary?.durationMs != null) view.durationMs = summary.durationMs;
          if (summary?.error?.message) view.error = summary.error.message;
        }
        runs.push(view);
      }
      const sessions = ((await deps.sessions?.list()) ?? [])
        .filter((s) => s.jobs?.includes(job) || s.id === job || s.id.startsWith(`${job}/`))
        .map((s) => ({ ...s, ...(deps.sessionHolder?.(s.id) ? { busy: true as const } : {}) }));
      const { runs: _n, holds: _h, ...head } = listing(rec);
      return {
        ...head,
        holds: rec.holds ?? [],
        repos: Object.keys(rec.repos).map((dir) => relative(root, dir)),
        files: await listJobFiles(root, rec),
        runs,
        sessions,
        ...(await fold(rec)),
      };
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
