/**
 * A WORK (plans/concept-evals.md, rulings 5 and 9): a root run and every run
 * it caused, whatever its workflows were. One person's message to the
 * orchestrator is the usual root: the turn, the jobs it started, the turns
 * that reported on those jobs, the jobs those started, and on. A claim on a
 * Concept is judged against the whole work once, when all of it is done.
 *
 * One run CAUSES another three ways, each recorded on the caused run's
 * `run.start`:
 *   - `parentRunId`: a child run it waited on (`meta/run-workflow`, an
 *     in-process launch with a parent);
 *   - `startedBy.runId`: a job a turn started (`job/start`, `job/continue`);
 *   - `wake.runId` (and `wake.also`): a turn strut ran to report on a job
 *     that ended (src/wake.ts).
 * Nothing else is a cause: a run `run/launch` starts (a page's, a person's
 * act), an automation's fire and a host's launch are roots of their own; a
 * peer's run (`strut/run-workflow`, a wake from another strut) is another
 * strut's.
 *
 * The record: when a caused run starts, one line naming it is appended to a
 * file per cause, `<dataDir>/works/<cause runId>.jsonl` (`recordCaused`), so
 * the work under a root is a walk down those files (`membersOf`), and a
 * run's root a walk up its `run.start` causes (`rootsOf`). Nothing lives
 * in memory: whether a work is done is read from the stores each time one
 * of its runs ends (`workDone`), so a restart loses nothing.
 *
 * Done: every run in it ended (a summary that is not `waiting`), and no
 * wake is still on its way for a job in it (the session's wake file holds
 * it queued, or names it in a wake turn that has not ended). A child run is
 * not asked: its parent waited on it, so the parent's end covers it.
 */
import { appendFile, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { RunEvent, RunSummary } from "./core.js";
import { JOB_WORKFLOWS } from "./jobs.js";
import { encodeId } from "./session-store.js";
import type { RunStore } from "./store.js";
import { wakeFilePath, type WakeFile } from "./wake.js";

export interface RunRef {
  workflow: string;
  runId: string;
}

/** The folder under the data directory the causes are kept in. */
export const WORKS_DIR = "works";

const TERMINAL = new Set(["success", "error", "cancelled"]);

const causesFile = (dataDir: string, runId: string) => join(dataDir, WORKS_DIR, `${encodeId(runId)}.jsonl`);

/** The runs on THIS strut that caused the run whose `run.start` this is, by
 *  id: its parent, the turn that started it, the job run(s) it woke on. A
 *  wake on another strut's job names none. Pure. */
export function causesOf(start: Pick<RunEvent, "parentRunId" | "startedBy" | "wake">): string[] {
  const out = new Set<string>();
  if (start.parentRunId) out.add(start.parentRunId);
  if (start.startedBy?.runId) out.add(start.startedBy.runId);
  if (start.wake) for (const m of [start.wake, ...(start.wake.also ?? [])]) if (!m.peer) out.add(m.runId);
  return [...out];
}

/** Record a caused run under each of its causes: one line per cause file.
 *  Called with every `run.start`; a run nothing caused writes nothing. */
export async function recordCaused(dataDir: string, workflow: string, start: RunEvent): Promise<void> {
  const causes = causesOf(start);
  if (!causes.length) return;
  const line = JSON.stringify({ workflow, runId: start.runId }) + "\n";
  await mkdir(join(dataDir, WORKS_DIR), { recursive: true });
  for (const cause of causes) await appendFile(causesFile(dataDir, cause), line, "utf-8");
}

/** The runs a run caused, as recorded; none when it caused none. */
export async function causedBy(dataDir: string, runId: string): Promise<RunRef[]> {
  let raw: string;
  try {
    raw = await readFile(causesFile(dataDir, runId), "utf-8");
  } catch {
    return [];
  }
  const out: RunRef[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as Partial<RunRef>;
      if (typeof r.workflow === "string" && typeof r.runId === "string") out.push({ workflow: r.workflow, runId: r.runId });
    } catch {
      // a torn line (a crash mid-append): the next run's line still reads
    }
  }
  return out;
}

type Starts = Pick<RunStore, "getRunStart">;

/** A job run's `run.start`, by id alone: a wake names the job run, not its
 *  workflow, and only a job-shaped workflow's end wakes (src/wake.ts). */
async function jobRunStart(store: Starts, runId: string): Promise<{ ref: RunRef; start: RunEvent } | null> {
  for (const workflow of JOB_WORKFLOWS) {
    const start = await store.getRunStart(workflow, runId).catch(() => null);
    if (start) return { ref: { workflow, runId }, start };
  }
  return null;
}

/** The runs upstream of a run that is no child: the turn that started it,
 *  the job runs it woke on. */
async function upstreamOf(store: Starts, start: RunEvent): Promise<Array<{ ref: RunRef; start: RunEvent | null }>> {
  const out: Array<{ ref: RunRef; start: RunEvent | null }> = [];
  if (start.startedBy) {
    const ref = { workflow: start.startedBy.workflow, runId: start.startedBy.runId };
    out.push({ ref, start: await store.getRunStart(ref.workflow, ref.runId).catch(() => null) });
  }
  if (start.wake) {
    for (const m of [start.wake, ...(start.wake.also ?? [])]) {
      if (m.peer) continue;
      out.push((await jobRunStart(store, m.runId)) ?? { ref: { workflow: JOB_WORKFLOWS[0], runId: m.runId }, start: null });
    }
  }
  return out;
}

/**
 * The root(s) of the work a run belongs to: its causes followed up until a
 * run nothing on this strut caused. Usually one; a wake turn that reported
 * on jobs of two works belongs to both. A run whose cause is not on file is
 * a root itself. Null for a CHILD run: its parent waited on it, so its
 * parent's end, never its own, is where its work may end.
 */
export async function rootsOf(store: Starts, at: RunRef): Promise<RunRef[] | null> {
  const start = await store.getRunStart(at.workflow, at.runId).catch(() => null);
  if (!start) return [at];
  if (start.parentRunId) return null;
  const roots = new Map<string, RunRef>();
  const seen = new Set<string>();
  const visit = async (ref: RunRef, s: RunEvent): Promise<void> => {
    if (seen.has(ref.runId)) return;
    seen.add(ref.runId);
    const up = await upstreamOf(store, s);
    if (!up.length) roots.set(ref.runId, ref);
    for (const u of up) {
      if (u.start) await visit(u.ref, u.start);
      else roots.set(ref.runId, ref);
    }
  };
  await visit(at, start);
  return [...roots.values()];
}

/** Every run of the work under `root`, the root first: the causes files,
 *  walked down. */
export async function membersOf(dataDir: string, root: RunRef): Promise<RunRef[]> {
  const out: RunRef[] = [root];
  const seen = new Set([root.runId]);
  for (let i = 0; i < out.length; i++) {
    for (const r of await causedBy(dataDir, out[i]!.runId)) {
      if (seen.has(r.runId)) continue;
      seen.add(r.runId);
      out.push(r);
    }
  }
  return out;
}

export interface WorkDoneDeps {
  store: Pick<RunStore, "getRunStart" | "getRunSummary">;
  dataDir: string;
  /** Is the run still in flight in THIS process? A run's end is written
   *  (its summary) before strut has decided whether it wakes a
   *  conversation; a run strut has not let go of yet is not over. */
  isLive?: (workflow: string, runId: string) => boolean;
}

/** Is a wake still on its way for this job run? Its session's wake file
 *  holds it queued, or in a wake turn that has not ended. */
async function wakeOnItsWay(deps: WorkDoneDeps, ref: RunRef, start: RunEvent): Promise<boolean> {
  if (!(JOB_WORKFLOWS as readonly string[]).includes(ref.workflow)) return false;
  const session = start.startedBy?.session ?? start.conversation;
  if (!session) return false;
  let f: WakeFile;
  try {
    f = JSON.parse(await readFile(wakeFilePath(deps.dataDir, session), "utf-8")) as WakeFile;
  } catch {
    return false;
  }
  if ((f.queued ?? []).some((e) => e.runId === ref.runId)) return true;
  if (!f.turn?.ends?.some((e) => e.runId === ref.runId)) return false;
  // The wake turn is launched: once it ended, its own run answers for it.
  const s = await deps.store.getRunSummary(f.turn.workflow, f.turn.runId).catch(() => null);
  return !s || !TERMINAL.has(s.status);
}

/**
 * Is the work done? Every run in it that is no child ended, and nothing more
 * is on its way. `ended` is the run whose end asks: it is over, whatever
 * this process still holds of it. Read from the stores alone (plus what
 * this process is running), so the answer after a restart is the same.
 */
export async function workDone(deps: WorkDoneDeps, members: readonly RunRef[], ended?: RunRef): Promise<{ done: true } | { done: false; why: string }> {
  for (const m of members) {
    const start = await deps.store.getRunStart(m.workflow, m.runId).catch(() => null);
    if (!start) return { done: false, why: `${m.workflow} ${m.runId} has not started` };
    if (start.parentRunId) continue;
    const self = ended && ended.runId === m.runId && ended.workflow === m.workflow;
    if (!self && deps.isLive?.(m.workflow, m.runId)) return { done: false, why: `${m.workflow} ${m.runId} is running` };
    const summary = await deps.store.getRunSummary(m.workflow, m.runId).catch(() => null);
    if (!summary || !TERMINAL.has(summary.status)) return { done: false, why: `${m.workflow} ${m.runId} is ${summary?.status ?? "running"}` };
    if (await wakeOnItsWay(deps, m, start)) return { done: false, why: `a wake is on its way for ${m.workflow} ${m.runId}` };
  }
  return { done: true };
}

// ── The work as a check reads it ───────────────────────────────────────────

export type CauseKind = "child" | "job" | "wake";

export interface WorkRun {
  /** 1-based, in the order the runs started. */
  n: number;
  workflow: string;
  runId: string;
  /** How it came about, by the `n` of the run(s) that caused it: a child
   *  its parent waited on, a job a turn started, a turn reporting on a job.
   *  The root has none. */
  cause?: { kind: CauseKind; of: number[] };
  job?: string;
  status: "success" | "error" | "cancelled";
  /** What it was asked: its input. */
  input: unknown;
  output?: unknown;
  error?: string;
  /** The Concept pages it opened, first opened first. */
  concepts: string[];
  /** Where its files are: a label of `Work.files`. */
  files?: string;
  /** What its output declared it delivered (`artifacts`). */
  delivered?: Array<{ title?: string; kind?: string; path?: string; url?: string; peer?: string }>;
}

export interface Work {
  root: RunRef;
  runs: WorkRun[];
  /** Every page any run opened, first opened first. */
  concepts: string[];
  /** The directories the runs' files are in, by label: a job's directory,
   *  else a run's own artifacts. */
  files: Record<string, string>;
}

/** What a check's input carries of the work (`RunCheckSubject.work`): each
 *  run's place and what it opened, without what it was asked or returned —
 *  those the standard judge reads through the capability. */
export type WorkSubject = Omit<Work, "runs"> & { runs: Array<Omit<WorkRun, "input" | "output" | "error">> };

export function workSubject(w: Work): WorkSubject {
  return { ...w, runs: w.runs.map(({ input: _i, output: _o, error: _e, ...r }) => r) };
}

/** One member as the fold needs it. */
export interface WorkMember {
  ref: RunRef;
  start: RunEvent;
  summary: RunSummary;
  /** The pages it opened (`subjectsOfRun`'s Concept subjects, in order). */
  concepts: string[];
  /** Its files' directory, when it has one with anything in it. */
  dir?: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

function deliveredOf(output: unknown): WorkRun["delivered"] {
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  const list = Array.isArray(o?.["artifacts"]) ? o!["artifacts"] : Array.isArray((o?.["object"] as Record<string, unknown> | undefined)?.["artifacts"]) ? (o!["object"] as Record<string, unknown>)["artifacts"] : undefined;
  if (!Array.isArray(list)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const out = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .slice(0, 50)
    .map((a) => {
      const e = { title: str(a["title"]), kind: str(a["kind"]), path: str(a["path"]), url: str(a["url"]), peer: str(a["peer"]) };
      return Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as NonNullable<WorkRun["delivered"]>[number];
    });
  return out.length ? out : undefined;
}

/** The work, from its members (the root first), in the order they started.
 *  Pure. */
export function foldWork(root: RunRef, members: readonly WorkMember[]): Work {
  const sorted = [...members].sort((a, b) => (a.ref.runId === root.runId ? -1 : b.ref.runId === root.runId ? 1 : a.start.ts.localeCompare(b.start.ts) || a.ref.runId.localeCompare(b.ref.runId)));
  const nOf = new Map(sorted.map((m, i) => [m.ref.runId, i + 1]));
  const files: Record<string, string> = {};
  const labelOf = new Map<string, string>();
  const concepts: string[] = [];
  const runs = sorted.map((m, i): WorkRun => {
    const s = m.start;
    const of = (ids: string[]) => ids.map((id) => nOf.get(id)).filter((n): n is number => n !== undefined);
    const wakes = s.wake ? [s.wake, ...(s.wake.also ?? [])].filter((w) => !w.peer).map((w) => w.runId) : [];
    const cause: WorkRun["cause"] = s.parentRunId && nOf.has(s.parentRunId)
      ? { kind: "child", of: of([s.parentRunId]) }
      : s.startedBy && nOf.has(s.startedBy.runId)
        ? { kind: "job", of: of([s.startedBy.runId]) }
        : of(wakes).length
          ? { kind: "wake", of: of(wakes) }
          : undefined;
    let label: string | undefined;
    if (m.dir) {
      label = labelOf.get(m.dir);
      if (!label) {
        const base = s.job ? `job-${safe(s.job)}` : `run-${safe(m.ref.runId)}`;
        label = base;
        for (let k = 2; files[label]; k++) label = `${base}-${k}`;
        files[label] = m.dir;
        labelOf.set(m.dir, label);
      }
    }
    for (const c of m.concepts) if (!concepts.includes(c)) concepts.push(c);
    const status = m.summary.status as WorkRun["status"];
    const delivered = deliveredOf(m.summary.output);
    return {
      n: i + 1,
      workflow: m.ref.workflow,
      runId: m.ref.runId,
      ...(cause ? { cause } : {}),
      ...(s.job ? { job: s.job } : {}),
      status,
      input: s.input,
      ...(status === "success" && m.summary.output !== undefined ? { output: m.summary.output } : {}),
      ...(status === "error" ? { error: m.summary.error?.message ?? "unknown error" } : {}),
      concepts: m.concepts,
      ...(label ? { files: label } : {}),
      ...(delivered ? { delivered } : {}),
    };
  });
  return { root, runs, concepts, files };
}

// ── Rendering, for a judge ─────────────────────────────────────────────────

const cut = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  return `${s.slice(0, head)}\n[…${s.length - max} characters left out…]\n${s.slice(s.length - (max - head))}`;
};
const show = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : (JSON.stringify(v, null, 2) ?? ""));

const CAUSE_WORDS: Record<CauseKind, (of: string) => string> = {
  child: (of) => `a run ${of} launched and waited on`,
  job: (of) => `a job ${of} started`,
  wake: (of) => `a turn reporting on ${of}`,
};

function filesLine(r: WorkRun): string | undefined {
  const delivered = (r.delivered ?? []).map((d) => {
    const where = d.peer ? ` (on @${d.peer}, not readable here)` : d.path && r.files ? ` at ${r.files}/${d.path}` : d.url ? ` at ${d.url}` : "";
    return `${d.title ? `"${d.title}"` : (d.path ?? d.url ?? "an artifact")}${d.kind ? ` (${d.kind})` : ""}${where}`;
  });
  if (!r.files && !delivered.length) return undefined;
  return `ITS FILES: ${r.files ? `${r.files}/` : "none here"}${delivered.length ? ` — it delivered: ${delivered.join("; ")}` : ""}`;
}

/** One run's sections, each part cut to its share of `max`. */
function runSections(r: WorkRun, max: number): string[] {
  const failed = r.status === "error" ? `IT FAILED WITH:\n${cut(r.error ?? "", Math.floor(max * 0.15))}` : r.status === "cancelled" ? "IT WAS CANCELLED." : `WHAT IT RETURNED:\n${cut(show(r.output), Math.floor(max * 0.7)) || "(nothing)"}`;
  const files = filesLine(r);
  return [
    `WHAT IT WAS ASKED:\n${cut(show(r.input), Math.floor(max * 0.25)) || "(nothing)"}`,
    failed,
    `CONCEPT PAGES IT OPENED: ${r.concepts.length ? r.concepts.join(", ") : "none"}`,
    ...(files ? [files] : []),
  ];
}

/**
 * The work as one bounded block of text for a model that judges it, cut in
 * code so a large output never reaches a prompt whole. A work of ONE run
 * reads as `context/run` always rendered a run; a larger one is each run in
 * the order it started, with how it came about, then every page the work
 * opened and the folders its files are in. Pure.
 */
export function renderWork(w: Work, max: number): string {
  if (w.runs.length === 1) return runSections(w.runs[0]!, max).join("\n\n");
  const share = Math.max(1_200, Math.floor((max * 0.92) / w.runs.length));
  const of = (ns: number[]) => ns.map((n) => `RUN ${n}`).join(" and ");
  const parts = [`THE WORK: ${w.runs.length} runs, everything the request in RUN 1 set off, in the order they started.`];
  for (const r of w.runs) {
    const how = r.cause ? CAUSE_WORDS[r.cause.kind](of(r.cause.of)) : "the request that started the work";
    parts.push(`── RUN ${r.n}: ${r.workflow}, ${how}${r.job ? ` (job ${r.job})` : ""}; it ${r.status === "success" ? "succeeded" : r.status === "error" ? "failed" : "was cancelled"}\n${runSections(r, share).join("\n\n")}`);
  }
  parts.push(`CONCEPT PAGES OPENED IN THE WORK: ${w.concepts.length ? w.concepts.join(", ") : "none"}`);
  const labels = Object.keys(w.files);
  parts.push(`FOLDERS OF FILES THE WORK MADE: ${labels.length ? labels.map((l) => `${l}/`).join(", ") : "none"}`);
  return parts.join("\n\n");
}

// ── The work's files, for a judge ──────────────────────────────────────────

/** The most of a text file one read hands back. */
export const WORK_READ_MAX_CHARS = 30_000;
/** The most entries one folder listing hands back. */
const LIST_MAX = 300;
/** The most bytes read of one file. */
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type WorkFileRead =
  | { path: string; kind: "folder"; entries: string[]; more?: number }
  | { path: string; kind: "text"; text: string; from: number; size: number; next?: number }
  | { path: string; kind: "image"; mediaType: string; size: number; data: Uint8Array }
  | { path: string; kind: "other"; size: number; note: string };

/**
 * What the verify pass puts on the bag of a check over a work
 * (`ctx.services.work`): the work, and a READ of its files. Nothing else
 * sets it, so no input a caller writes can point a read anywhere; a read
 * stays inside one of the work's folders, symbolic links resolved.
 */
export interface WorkCapability {
  readonly work: Work;
  read(path: string, from?: number): Promise<WorkFileRead>;
}

/** A .docx's or .doc's text (attachments.ts's reader). */
async function wordText(bytes: Buffer): Promise<string> {
  const { default: WordExtractor } = await import("word-extractor");
  const doc = await new WordExtractor().extract(bytes);
  return [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()].map((s) => s.trim()).filter(Boolean).join("\n\n");
}

function utf8(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function workCapability(work: Work): WorkCapability {
  const labels = () => Object.keys(work.files);
  return Object.freeze({
    work,
    async read(raw: string, from = 0): Promise<WorkFileRead> {
      const path = (raw ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
      if (!path || path === ".") return { path: "", kind: "folder", entries: labels().map((l) => `${l}/`) };
      const [label, ...rest] = path.split("/");
      const root = work.files[label!];
      if (!root) throw new Error(`"${label}" is not a folder of this work's files: ${labels().map((l) => `${l}/`).join(", ") || "it made none"}`);
      const target = resolve(root, rest.join("/"));
      if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) throw new Error(`"${path}" is outside the work's files`);
      let real: string;
      try {
        real = await realpath(target);
      } catch {
        throw new Error(`no file or folder "${path}"`);
      }
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`"${path}" leads outside the work's files`);
      const st = await stat(real);
      if (st.isDirectory()) {
        const entries = (await readdir(real, { withFileTypes: true }))
          .filter((e) => !e.name.startsWith("."))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return { path, kind: "folder", entries: entries.slice(0, LIST_MAX), ...(entries.length > LIST_MAX ? { more: entries.length - LIST_MAX } : {}) };
      }
      const ext = extname(real).toLowerCase();
      if (IMAGE_TYPES[ext]) {
        if (st.size > IMAGE_MAX_BYTES) return { path, kind: "other", size: st.size, note: "an image too large to show" };
        return { path, kind: "image", mediaType: IMAGE_TYPES[ext]!, size: st.size, data: new Uint8Array(await readFile(real)) };
      }
      if (st.size > FILE_MAX_BYTES) return { path, kind: "other", size: st.size, note: `over ${FILE_MAX_BYTES / 1024 / 1024} MB: not read` };
      const bytes = await readFile(real);
      let text: string | null;
      if (ext === ".docx" || ext === ".doc") {
        try {
          text = await wordText(bytes);
        } catch (err) {
          return { path, kind: "other", size: st.size, note: `could not read it as a Word document (${err instanceof Error ? err.message : String(err)})` };
        }
      } else text = utf8(bytes);
      if (text === null) return { path, kind: "other", size: st.size, note: ext === ".pdf" ? "a PDF: not readable here" : "not text" };
      const start = Math.max(0, Math.min(Math.floor(from), text.length));
      const end = Math.min(text.length, start + WORK_READ_MAX_CHARS);
      return { path, kind: "text", text: text.slice(start, end), from: start, size: text.length, ...(end < text.length ? { next: end } : {}) };
    },
  });
}
