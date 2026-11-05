/**
 * Conversations (plans/jamie-app.md §2): the assistant's chats as a person
 * reads them — a list, and each one's TURNS — kept by strut, so a host (Hive,
 * Peel) and strut's own app read the same thing.
 *
 * A conversation is an agent SESSION whose turns are runs of a conversation
 * workflow: one with `params.wake` (the seeded `orchestrator`). Its turns are
 * not the session's model transcript but its RUNS, each read back from its
 * log: the person's words (`input.prompt`) or a wake, the reply (`text`,
 * `ask`, the artifacts resolved), the proposals it made, the jobs it started.
 *
 * Several people may share one (ruled 2026-11-04): it is listed for everyone
 * who took a turn in it (the launch's actor, else its principal), for the
 * actor its id is under (`<actor>/…`), and for whoever opened it while it was
 * SHARED — a flag that makes it readable to any actor on this strut. Taking a
 * turn makes you a participant.
 *
 * Kept as files under `<dataDir>/conversations/`, on every backend:
 *
 *   sessions/<encoded id>.json  — the record: title, shared, its viewers, its
 *                                 turns (run id, workflow, who, when, status)
 *   viewers/<encoded actor>.json — one person's list: a row per conversation
 *                                 (the record's facts, copied) and their own
 *                                 archived + seen
 *   built.json                  — the stamp of the one-off build below
 *
 * Written when a turn LAUNCHES and when it ENDS (createStrut's launcher), so
 * a turn that failed — which commits nothing to the session — still shows,
 * with its error. A session from before the index is built from its turn
 * lines (`SessionStore.turns`): one by one when it is read, and all of them
 * once, at the first list. Never from the runs.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRef } from "./artifact-refs.js";
import type { Scope } from "./auth.js";
import type { Flow, RunAttachment, RunEvent, RunSummary, WakeMark } from "./core.js";
import { withLock } from "./jobs.js";
import { briefOf, listProposals, proposalsRoot, type ProposalBrief } from "./proposals.js";
import { APP_NAMESPACE, PEER_NAMESPACE, encodeId, idProblem, type SessionStore, type SessionTurn } from "./session-store.js";
import type { RunStore } from "./store.js";
import { replyOf } from "./wake.js";

/** A title, at most. */
export const TITLE_MAX = 80;
/** A rename, at most. */
const RENAME_MAX = 200;
export const CONVERSATION_LIST_DEFAULT = 50;
export const CONVERSATION_LIST_MAX = 200;
export const CONVERSATION_TURNS_DEFAULT = 20;
export const CONVERSATION_TURNS_MAX = 100;
/** `get { wait }`, at most — `run/get`'s. */
export const CONVERSATION_WAIT_MAX_MS = 55_000;
/** Settled turns kept read, per process. */
const TURN_CACHE_MAX = 2_000;
/** The file of the viewer with no actor (a strut with none keeps one list
 *  for everyone): `encodeURIComponent` never writes an `@`. */
const NO_ACTOR_FILE = "@none";

// ── pure ───────────────────────────────────────────────────────────────────

/** A conversation workflow: one with `params.wake`, which the wake reads
 *  too (src/wake.ts). */
export function isConversationFlow(flow: Pick<Flow, "params"> | null | undefined): boolean {
  return typeof flow?.params?.["wake"] === "string";
}

/** Where a conversation never lives: a plain peer's relays (`peer/…`) and an
 *  app's own threads (`app/…`, until the first-party tier, §3). */
export function outsideConversations(id: string): boolean {
  return id.startsWith(PEER_NAMESPACE) || id.startsWith(APP_NAMESPACE);
}

/** The title a first message gives: Hive's leading `@<workspace>` line
 *  (`orchestratorPrompt`) left out, whitespace as one space, cut. */
export function titleOf(prompt: unknown, max = TITLE_MAX): string {
  if (typeof prompt !== "string") return "";
  const text = prompt.replace(/^\s*@\S+[ \t]*\r?\n/, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A job a turn started or continued. */
export interface TurnJob {
  job: string;
  runId: string;
  /** The job-shaped workflow, when the turn started a new job. */
  workflow?: string;
}

/** `job/start` / `job/continue` as an event names them: an agent's tool call
 *  (`tool:job_start`), or a step. The kit's `assistantJobs` reads the same. */
const JOB_TOOL = /^(tool:)?job[_/](start|continue)$/;

/** A tool call's logged `output` or `input`: the JSON text the model was
 *  handed, an object only when a caller wrote one. */
function objectOf(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** The jobs a turn's log shows it started or continued. */
export function turnJobs(events: readonly RunEvent[]): TurnJob[] {
  const starts = new Map<string, RunEvent>();
  for (const e of events) if (e.type === "step.start" && e.path) starts.set(e.path, e);
  const out: TurnJob[] = [];
  for (const e of events) {
    const tool = e.type === "step.end" ? JOB_TOOL.exec(String(e["stepType"] ?? "")) : null;
    if (!tool) continue;
    const o = objectOf(e["output"]);
    if (typeof o?.["job"] !== "string" || typeof o["runId"] !== "string") continue;
    const started = tool[2] === "start" ? (objectOf(starts.get(e.path ?? "")?.["input"])?.["workflow"] ?? "job") : undefined;
    out.push({ job: o["job"], runId: o["runId"], ...(typeof started === "string" ? { workflow: started } : {}) });
  }
  return out;
}

// ── records ────────────────────────────────────────────────────────────────

/** One turn as the record keeps it: which run, and how it went. */
export interface ConversationRun {
  runId: string;
  workflow: string;
  /** When it launched (a turn from before the index: when it committed). */
  at: string;
  /** Who took it: the launch's actor, else its principal. */
  by?: string;
  /** Strut ran it because a job ended (src/wake.ts). */
  wake?: true;
  /** How it ended. Absent while in flight — or when the process died with
   *  it; a read asks the run. */
  status?: string;
}

export interface ConversationRecord {
  id: string;
  title: string;
  /** The title is a person's, not the first message's. */
  renamed?: true;
  createdAt: string;
  updatedAt: string;
  /** Bumped by every write: what `get { wait }` waits on. */
  rev: number;
  /** Readable to any actor on this strut, before their first turn. */
  shared?: true;
  /** The conversation it was forked from. */
  forkedFrom?: string;
  /** Everyone it is listed for (`""`: no actor). */
  viewers: string[];
  /** Oldest first. */
  turns: ConversationRun[];
}

/** One person's row for a conversation: the record's facts and their own
 *  archived + seen. */
export interface ConversationEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** The last turn's status, once it ended. */
  status?: string;
  shared?: true;
  forkedFrom?: string;
  archived?: true;
  /** When this viewer last read it. */
  seenAt?: string;
}

/** A row of `conversation/list`. */
export interface ConversationListItem extends ConversationEntry {
  /** Something happened since `seenAt`. */
  unread: boolean;
  /** A turn of it is in flight in this process. */
  running?: true;
}

/** One turn as a person reads it. */
export interface ConversationTurn {
  /** 0-based, oldest first: `before` takes it. */
  turn: number;
  runId: string;
  workflow: string;
  at: string;
  by?: string;
  /** The run's status once it settled; while not, its live state
   *  (`running`, `paused`), `stale` when no process runs it. */
  status: string;
  /** The person's words. Absent on a wake. */
  prompt?: string;
  /** A WAKE: the job run(s) it woke on (`run.start.wake`; `true` when the
   *  log has no mark). */
  wake?: WakeMark | true;
  /** The files the person attached. */
  attachments?: Array<Pick<RunAttachment, "name" | "mediaType" | "size">>;
  text?: string;
  ask?: string;
  artifacts?: ArtifactRef[];
  error?: string;
  proposals: ProposalBrief[];
  jobs: TurnJob[];
}

export interface ConversationView {
  conversation: ConversationListItem;
  /** Who took a turn in it. */
  participants: string[];
  /** Newest first. */
  turns: ConversationTurn[];
  /** Pass as `before` for the older turns; absent at the first. */
  next?: number;
  /** Pass as `since` with `wait` to hold until the next change. */
  rev: number;
}

/** Who is asking. */
export interface ConversationViewer {
  /** Absent: no actor (a strut with none keeps one list for everyone). */
  actor?: string;
  /** The deployment's credential with no actor named: reads any
   *  conversation (it reads every run's log anyway). */
  all?: true;
  /** A person's token (`peer:person`): proposals as it sees them in a list
   *  (`visibleTo`), and a fork's id must be its own. */
  person?: true;
}

export interface ConversationListQuery {
  /** Every word in the title. */
  q?: string;
  /** The archived ones alone (default: the rest). */
  archived?: boolean;
  limit?: number;
  /** The `next` of the page before. */
  before?: string;
}

export interface ConversationGetQuery {
  session: string;
  limit?: number;
  /** Turns before this turn number (`next`). */
  before?: number;
  /** Hold up to this many ms until the conversation changes past `since`. */
  wait?: number;
  /** The `rev` the caller has; default the one it has now. */
  since?: number;
}

export interface ConversationUpdate {
  session: string;
  /** A new title; `""` gives back the first message's. */
  title?: string;
  /** This viewer's. */
  archived?: boolean;
  /** This viewer read it now. */
  seen?: boolean;
  /** Readable to any actor on this strut. */
  shared?: boolean;
}

export interface ConversationsCapability {
  list(q: ConversationListQuery, by: ConversationViewer): Promise<{ conversations: ConversationListItem[]; next?: string }>;
  /** `null`: no such conversation, or not the viewer's to read. */
  get(q: ConversationGetQuery, by: ConversationViewer): Promise<ConversationView | null>;
  update(q: ConversationUpdate, by: ConversationViewer): Promise<ConversationListItem>;
  /** A new session with the source's messages, so the agent remembers. */
  fork(q: { session: string; id?: string }, by: ConversationViewer): Promise<ConversationListItem>;
}

export interface Conversations extends ConversationsCapability {
  /** A turn launched on `id` (createStrut's launcher). */
  launched(id: string, turn: { runId: string; workflow: string; actor?: string; principal?: string; wake?: boolean; prompt?: unknown }): Promise<void>;
  /** …and ended. */
  ended(id: string, runId: string, status: string): Promise<void>;
  /** The record on file, or null: never built here, so a session that is
   *  no conversation costs a file read (the graph projection's reader). */
  record(id: string): Promise<ConversationRecord | null>;
  /** May `actor` take a turn in `id`, a session that is not under their own
   *  id (plans/jamie-app.md §2.2)? `true` when it is a conversation they
   *  took a turn in, or a shared one; `false` when it is a conversation
   *  they may not continue; `null` when it is no conversation (never one,
   *  or outside the index: `peer/…`, `app/…`). Built from the session the
   *  first time, as a read is. */
  mayContinue(id: string, actor: string): Promise<boolean | null>;
}

export interface ConversationsDeps {
  dataDir: string;
  store: RunStore;
  sessions: SessionStore;
  getWorkflow(name: string): Promise<Flow>;
  /** A turn of `id` is in flight in this process. */
  running(id: string): boolean;
  /** A live run's state (`running`, `paused`), else undefined. */
  liveState(workflow: string, runId: string): string | undefined;
  artifactRefs(runId: string, output: unknown, job: string | undefined): Promise<ArtifactRef[] | undefined>;
}

// ── files ──────────────────────────────────────────────────────────────────

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Whole, through a temp file and a rename. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

const keyOf = (by: ConversationViewer) => by.actor ?? "";
const isOwn = (id: string, actor: string | undefined) => !!actor && (id === actor || id.startsWith(`${actor}/`));
/** The actor an id is under (`<actor>/…`): listed for them. */
const ownerOf = (id: string) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : undefined);

function factsOf(rec: ConversationRecord): Omit<ConversationEntry, "archived" | "seenAt"> {
  const last = rec.turns[rec.turns.length - 1];
  return {
    id: rec.id,
    title: rec.title,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    turns: rec.turns.length,
    ...(last?.status ? { status: last.status } : {}),
    ...(rec.shared ? { shared: true as const } : {}),
    ...(rec.forkedFrom ? { forkedFrom: rec.forkedFrom } : {}),
  };
}

const recordFileIn = (dataDir: string, id: string) => join(dataDir, "conversations", "sessions", `${encodeId(id)}.json`);

/** The index's records alone, read from `dataDir` and never built: what
 *  the graph projection reads, for a caller without the index (the
 *  `graph/project` step). A session that is no conversation costs a file
 *  read. */
export function conversationRecords(dataDir: string): Pick<Conversations, "record"> {
  return { record: (id) => (idProblem(id) ? Promise.resolve(null) : readJson<ConversationRecord>(recordFileIn(dataDir, id))) };
}

// ── the index ──────────────────────────────────────────────────────────────

export function createConversations(deps: ConversationsDeps): Conversations {
  const root = join(deps.dataDir, "conversations");
  const recordFile = (id: string) => recordFileIn(deps.dataDir, id);
  const viewerFile = (key: string) => join(root, "viewers", `${key ? encodeId(key) : NO_ACTOR_FILE}.json`);
  const builtFile = join(root, "built.json");
  /** The rev of each record written in this process: `wait` polls it. */
  const revs = new Map<string, number>();
  /** Settled turns, read once: a settled run never changes. Proposals are
   *  read each time (a person decides them later). */
  const settled = new Map<string, Omit<ConversationTurn, "turn" | "proposals">>();

  const readRecord = (id: string) => readJson<ConversationRecord>(recordFile(id));

  /** Is `workflow` a conversation workflow? Asked per build. */
  const conversationFlow = async (name: string, cache: Map<string, boolean>): Promise<boolean> => {
    let yes = cache.get(name);
    if (yes === undefined) {
      yes = isConversationFlow(await deps.getWorkflow(name).catch(() => null));
      cache.set(name, yes);
    }
    return yes;
  };

  /** A turn's first message (`input.prompt`), from its run. */
  const firstPrompt = async (t: Pick<SessionTurn, "workflow" | "runId"> | undefined): Promise<unknown> => {
    if (!t) return undefined;
    const summary = await deps.store.getRunSummary(t.workflow, t.runId).catch(() => null);
    if (summary) return (summary.input as Record<string, unknown> | undefined)?.["prompt"];
    const start = (await deps.store.getRunEvents(t.workflow, t.runId).catch(() => [])).find((e) => e.type === "run.start");
    return (start?.["input"] as Record<string, unknown> | undefined)?.["prompt"];
  };

  /** A record for a session from before the index, from its turn lines —
   *  `null` when it has none, or is not a conversation. */
  const buildRecord = async (id: string, cache = new Map<string, boolean>()): Promise<ConversationRecord | null> => {
    if (idProblem(id) || outsideConversations(id)) return null;
    const lines = await deps.sessions.turns(id).catch(() => []);
    let conversation = false;
    for (const w of new Set(lines.map((t) => t.workflow))) if (await conversationFlow(w, cache)) conversation = true;
    if (!lines.length || !conversation) return null;
    const turns: ConversationRun[] = [];
    for (const t of lines) {
      if (turns.some((r) => r.runId === t.runId)) continue;
      const by = t.actor ?? t.principal;
      turns.push({ runId: t.runId, workflow: t.workflow, at: t.at, ...(by ? { by } : {}), ...(t.wake ? { wake: true as const } : {}), status: "success" });
    }
    const owner = ownerOf(id);
    return {
      id,
      title: titleOf(await firstPrompt(lines.find((t) => !t.wake))),
      createdAt: lines[0]!.at,
      updatedAt: lines[lines.length - 1]!.at,
      rev: 1,
      viewers: [...new Set([...turns.map((t) => t.by ?? ""), ...(owner ? [owner] : [])])],
      turns,
    };
  };

  /** Copy the record's facts onto each viewer's row; `seen` marks the
   *  given viewers as having read it now (a turn they launched, a build of
   *  history they had). */
  const refreshViewers = async (rec: ConversationRecord, seen: readonly string[] = []) => {
    const facts = factsOf(rec);
    for (const v of rec.viewers) {
      await withLock(viewerFile(v), async () => {
        const idx = (await readJson<{ conversations: Record<string, ConversationEntry> }>(viewerFile(v))) ?? { conversations: {} };
        const prev = idx.conversations[rec.id];
        idx.conversations[rec.id] = {
          ...facts,
          ...(prev?.archived ? { archived: true as const } : {}),
          ...(seen.includes(v) ? { seenAt: new Date().toISOString() } : prev?.seenAt ? { seenAt: prev.seenAt } : {}),
        };
        await writeJson(viewerFile(v), idx);
      });
    }
  };

  /** Change a conversation's record under its lock: read it (or build it
   *  from the session), edit, write, copy to the viewers. `edit` returns
   *  false to write nothing. */
  const mutate = (
    id: string,
    edit: (rec: ConversationRecord | null) => ConversationRecord | null | false,
    seen: (rec: ConversationRecord) => readonly string[] = () => [],
  ): Promise<ConversationRecord | null> =>
    withLock(recordFile(id), async () => {
      const prev = (await readRecord(id)) ?? (await buildRecord(id));
      const rec = edit(prev ? structuredClone(prev) : null);
      if (rec === false || rec === null) return prev;
      rec.rev = (prev?.rev ?? 0) + 1;
      await writeJson(recordFile(id), rec);
      revs.set(id, rec.rev);
      await refreshViewers(rec, seen(rec));
      return rec;
    });

  /** The record of a session from before the index, built once (under its
   *  lock, as a write: two readers build it once). Its viewers have read
   *  its history. */
  const buildOnce = (id: string, cache?: Map<string, boolean>): Promise<ConversationRecord | null> =>
    withLock(recordFile(id), async () => {
      const again = await readRecord(id);
      if (again) return again;
      const built = await buildRecord(id, cache);
      if (!built) return null;
      await writeJson(recordFile(id), built);
      revs.set(id, built.rev);
      await refreshViewers(built, built.viewers);
      return built;
    });

  /** The record, built from the session the first time it is read. */
  const recordOf = async (id: string): Promise<ConversationRecord | null> =>
    (await readRecord(id)) ?? (idProblem(id) || outsideConversations(id) ? null : buildOnce(id));

  /** Every session from before the index, once: what the first list needs
   *  (a viewer's row is written only when their conversation is). */
  let building: Promise<void> | undefined;
  const ensureBuilt = () =>
    (building ??= (async () => {
      if (await readJson(builtFile)) return;
      const cache = new Map<string, boolean>();
      for (const info of await deps.sessions.list().catch(() => [])) {
        if (!outsideConversations(info.id) && !(await readRecord(info.id))) await buildOnce(info.id, cache);
      }
      await writeJson(builtFile, { at: new Date().toISOString() });
    })().catch((err) => {
      building = undefined;
      throw err;
    }));

  const canRead = (rec: ConversationRecord, by: ConversationViewer) =>
    !!by.all || rec.viewers.includes(keyOf(by)) || !!rec.shared || isOwn(rec.id, by.actor);

  /** The viewer's row; adds them as a viewer first when they are not one
   *  (a shared conversation they opened, their own id). */
  const entryOf = async (rec: ConversationRecord, by: ConversationViewer): Promise<ConversationListItem> => {
    const key = keyOf(by);
    if (!rec.viewers.includes(key) && !by.all) {
      rec = (await mutate(rec.id, (r) => (r && !r.viewers.includes(key) ? { ...r, viewers: [...r.viewers, key] } : false))) ?? rec;
    }
    const idx = await readJson<{ conversations: Record<string, ConversationEntry> }>(viewerFile(key));
    return itemOf(idx?.conversations[rec.id] ?? factsOf(rec));
  };

  const itemOf = (e: ConversationEntry): ConversationListItem => ({
    ...e,
    unread: !e.seenAt || e.seenAt < e.updatedAt,
    ...(deps.running(e.id) ? { running: true as const } : {}),
  });

  /** One turn, read from its run. */
  const readTurn = async (t: ConversationRun): Promise<Omit<ConversationTurn, "turn" | "proposals">> => {
    const key = `${t.workflow}/${t.runId}`;
    const hit = settled.get(key);
    if (hit) return hit;
    const [summary, events] = await Promise.all([
      deps.store.getRunSummary(t.workflow, t.runId).catch(() => null) as Promise<RunSummary | null>,
      deps.store.getRunEvents(t.workflow, t.runId).catch(() => [] as RunEvent[]),
    ]);
    const start = events.find((e) => e.type === "run.start");
    // The run's end as its log says it: written before the summary (the
    // index records a turn's end from this event, before `finalize`).
    const terminal = events.find((e) => e.type === "run.end" || e.type === "run.error" || e.type === "run.cancelled");
    const ended = summary?.status ?? (terminal ? (terminal.type === "run.end" ? "success" : terminal.type === "run.error" ? "error" : "cancelled") : undefined);
    const output = summary ? summary.output : terminal?.type === "run.end" ? terminal["output"] : undefined;
    const error = summary?.error?.message ?? (terminal?.["error"] as { message?: string } | undefined)?.message;
    const input = (summary?.input ?? start?.["input"]) as Record<string, unknown> | undefined;
    const mark = start?.["wake"] as WakeMark | undefined;
    const attachments = (start?.["attachments"] as RunAttachment[] | undefined)?.map((a) => ({ name: a.name, mediaType: a.mediaType, size: a.size }));
    const reply = ended ? replyOf(output) : {};
    const job = summary?.job ?? (start?.["job"] as string | undefined);
    const artifacts = ended === "success" ? await deps.artifactRefs(t.runId, output, job).catch(() => undefined) : undefined;
    const turn: Omit<ConversationTurn, "turn" | "proposals"> = {
      runId: t.runId,
      workflow: t.workflow,
      at: t.at,
      ...(t.by ? { by: t.by } : {}),
      status: ended ?? deps.liveState(t.workflow, t.runId) ?? t.status ?? "stale",
      ...(t.wake || mark ? { wake: mark ?? (true as const) } : typeof input?.["prompt"] === "string" ? { prompt: input["prompt"] } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...reply,
      ...(artifacts?.length ? { artifacts } : {}),
      ...(error ? { error } : {}),
      jobs: turnJobs(events),
    };
    if (ended) {
      if (settled.size >= TURN_CACHE_MAX) settled.delete(settled.keys().next().value!);
      settled.set(key, turn);
    }
    return turn;
  };

  const notFound = (id: string) => new Error(`No conversation "${id}" (or not yours to read)`);

  return {
    async mayContinue(id, actor) {
      const rec = await recordOf(id);
      if (!rec) return null;
      return !!rec.shared || rec.turns.some((t) => t.by === actor);
    },
    async launched(id, t) {
      const by = t.actor ?? t.principal;
      await mutate(
        id,
        (rec) => {
          if (rec?.turns.some((r) => r.runId === t.runId)) return false; // a resume
          const now = new Date().toISOString();
          const owner = ownerOf(id);
          const next: ConversationRecord = rec ?? { id, title: "", createdAt: now, updatedAt: now, rev: 0, viewers: owner ? [owner] : [], turns: [] };
          next.turns.push({ runId: t.runId, workflow: t.workflow, at: now, ...(by ? { by } : {}), ...(t.wake ? { wake: true as const } : {}) });
          next.updatedAt = now;
          if (!next.title && !next.renamed && !t.wake) next.title = titleOf(t.prompt);
          if (!next.viewers.includes(by ?? "")) next.viewers.push(by ?? "");
          return next;
        },
        // Who wrote it has read it; the reply is what is new to them.
        () => (t.wake ? [] : [by ?? ""]),
      );
    },

    async ended(id, runId, status) {
      await mutate(id, (rec) => {
        const turn = rec?.turns.find((r) => r.runId === runId);
        if (!rec || !turn) return false;
        turn.status = status;
        rec.updatedAt = new Date().toISOString();
        return rec;
      });
    },

    record: conversationRecords(deps.dataDir).record,

    async list(q, by) {
      await ensureBuilt();
      const idx = await readJson<{ conversations: Record<string, ConversationEntry> }>(viewerFile(keyOf(by)));
      const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const cursor = (e: ConversationEntry) => `${e.updatedAt}|${e.id}`;
      const rows = Object.values(idx?.conversations ?? {})
        .filter((e) => (q.archived ? e.archived : !e.archived))
        .filter((e) => words.every((w) => e.title.toLowerCase().includes(w)))
        .sort((a, b) => cursor(b).localeCompare(cursor(a)))
        .filter((e) => !q.before || cursor(e) < q.before);
      const limit = Math.min(CONVERSATION_LIST_MAX, Math.max(1, q.limit ?? CONVERSATION_LIST_DEFAULT));
      const page = rows.slice(0, limit);
      return { conversations: page.map(itemOf), ...(rows.length > limit ? { next: cursor(page[page.length - 1]!) } : {}) };
    },

    async get(q, by) {
      let rec = await recordOf(q.session);
      if (!rec || !canRead(rec, by)) return null;
      if (q.wait && q.wait > 0) {
        const since = q.since ?? rec.rev;
        const deadline = Date.now() + Math.min(CONVERSATION_WAIT_MAX_MS, q.wait);
        while ((revs.get(q.session) ?? rec.rev) === since && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
        rec = (await readRecord(q.session)) ?? rec;
      }
      const conversation = await entryOf(rec, by);
      const limit = Math.min(CONVERSATION_TURNS_MAX, Math.max(1, q.limit ?? CONVERSATION_TURNS_DEFAULT));
      const end = Math.max(0, Math.min(rec.turns.length, q.before ?? rec.turns.length));
      const start = Math.max(0, end - limit);
      const page = rec.turns.slice(start, end);
      const runIds = new Set(page.map((t) => t.runId));
      // Only this page's runs, and only what the reader may see: decided on
      // the index, so a read never opens another conversation's records.
      const proposals = await listProposals(proposalsRoot(deps.dataDir), {
        runId: [...runIds],
        viewer: { scope: (by.person ? "peer:person" : "full") as Scope, ...(by.actor ? { actor: by.actor } : {}) },
      }).catch(() => []);
      const turns: ConversationTurn[] = [];
      for (let i = page.length - 1; i >= 0; i--) {
        const t = page[i]!;
        const read = await readTurn(t);
        turns.push({ turn: start + i, ...read, proposals: proposals.filter((p) => p.by.runId === t.runId).reverse().map(briefOf) });
      }
      return {
        conversation,
        participants: [...new Set(rec.turns.map((t) => t.by).filter((b): b is string => !!b))],
        turns,
        ...(start > 0 ? { next: start } : {}),
        rev: rec.rev,
      };
    },

    async update(q, by) {
      let rec = await recordOf(q.session);
      if (!rec || !canRead(rec, by)) throw notFound(q.session);
      if (q.title !== undefined || q.shared !== undefined) {
        const title = q.title?.replace(/\s+/g, " ").trim();
        if (title !== undefined && title.length > RENAME_MAX) throw new Error(`a title is at most ${RENAME_MAX} characters`);
        const first = title === "" ? titleOf(await firstPrompt(rec.turns.find((t) => !t.wake))) : undefined;
        rec =
          (await mutate(q.session, (r) => {
            if (!r) return false;
            if (title) Object.assign(r, { title, renamed: true });
            else if (title === "") {
              r.title = first ?? "";
              delete r.renamed;
            }
            if (q.shared === true) r.shared = true;
            if (q.shared === false) delete r.shared;
            return r;
          })) ?? rec;
      }
      const item = await entryOf(rec, by);
      if (q.archived === undefined && q.seen === undefined) return item;
      const key = keyOf(by);
      return withLock(viewerFile(key), async () => {
        const idx = (await readJson<{ conversations: Record<string, ConversationEntry> }>(viewerFile(key))) ?? { conversations: {} };
        const e: ConversationEntry = { ...(idx.conversations[rec!.id] ?? factsOf(rec!)) };
        if (q.archived === true) e.archived = true;
        if (q.archived === false) delete e.archived;
        if (q.seen === true) e.seenAt = new Date().toISOString();
        if (q.seen === false) delete e.seenAt;
        idx.conversations[rec!.id] = e;
        await writeJson(viewerFile(key), idx);
        return itemOf(e);
      });
    },

    async fork(q, by) {
      const src = await recordOf(q.session);
      if (!src || !canRead(src, by)) throw notFound(q.session);
      const mine = by.actor && !idProblem(`${by.actor}/x`) ? `${by.actor}/` : "";
      const id = q.id ?? `${mine}${randomBytes(6).toString("hex")}`;
      const problem = idProblem(id);
      if (problem) throw new Error(`conversation id "${id}" ${problem}`);
      if (outsideConversations(id)) throw new Error(`conversation id "${id}" is in a namespace conversations never use`);
      if (by.person && !isOwn(id, by.actor)) throw new Error(`a person's fork is named under their own id ("${by.actor}/…")`);
      if ((await deps.sessions.turns(id)).length || (await readRecord(id))) throw new Error(`conversation "${id}" already exists`);
      const thread = await deps.sessions.load(q.session);
      if (!thread?.turns.length) throw new Error(`conversation "${q.session}" has no finished turn to fork yet`);
      // The messages copied turn by turn, so each line is the source's: the
      // agent replays the same thread, and the history reads the same runs.
      for (const t of thread.turns) {
        const { turn: _turn, at: _at, offset, count, ...record } = t;
        await deps.sessions.appendTurn(id, { system: thread.system, messages: thread.messages.slice(offset, offset + count), record });
      }
      const key = keyOf(by);
      const now = new Date().toISOString();
      const rec = await mutate(
        id,
        () => ({
          id,
          title: src.title,
          ...(src.renamed ? { renamed: true as const } : {}),
          createdAt: now,
          updatedAt: now,
          rev: 0,
          forkedFrom: src.id,
          viewers: [key],
          turns: src.turns.filter((t) => t.status),
        }),
        () => [key],
      );
      return entryOf(rec!, by);
    },
  };
}
