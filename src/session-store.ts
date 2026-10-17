/**
 * Agent sessions (plans/agent-sessions.md) — the threads an `agent` step
 * with `session` set continues. One append-only thread per id, the chat
 * store's shape:
 *
 *   sessions/<encodeURIComponent(id)>/
 *     system.md       — the system prompt, written by turn 0, never rewritten
 *     messages.jsonl  — append-only ModelMessages, as sent and generated
 *     turns.jsonl     — one line per SUCCESSFUL turn: the commit record
 *
 * A turn line is the commit: message lines past the last committed turn (a
 * crash between the two appends) are ignored on load and dropped before the
 * next append. They were never replayed to a model.
 *
 * The run log holds each TURN (`step.end.messages`); this store holds the
 * thread. There is no meta file: a session's summary is its first and last
 * turn lines.
 */

import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredMessage } from "./chat-store.js";

// ── ids ────────────────────────────────────────────────────────────────────

/** Longest id. With every other character a slash the encoded directory
 *  name is still under a filesystem's 255. */
export const SESSION_ID_MAX = 120;

const SEGMENT_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Why `id` is not a usable session (or workdir) name — `null` when it is.
 *  `/`-separated segments, each starting and ending with a letter or digit.
 *  Strict on purpose: a multi-segment template renders a missing value as
 *  "", so `"{{ input.session }}/review"` without a session is `/review` —
 *  which, accepted, would be one thread shared by every run that forgot to
 *  pass an id. */
export function idProblem(id: unknown): string | null {
  if (typeof id !== "string" || !id) return "is empty";
  if (id.length > SESSION_ID_MAX) return `is longer than ${SESSION_ID_MAX} characters`;
  for (const seg of id.split("/")) {
    if (!seg) return "has an empty segment — is a template value missing?";
    if (!SEGMENT_RE.test(seg)) {
      return `has an invalid segment "${seg}" (letters, digits, ". _ -" inside; a letter or digit at each end) — is a template value missing?`;
    }
  }
  return null;
}

/** The one directory (or file stem) an id is stored under: flat, so
 *  `abc/review` is a sibling of `abc`, never its child. */
export function encodeId(id: string): string {
  return encodeURIComponent(id);
}

// ── records ────────────────────────────────────────────────────────────────

/** What the step knows about a turn; the store adds where it sits. */
export interface NewTurn {
  /** The run-store key of the run that made the turn. */
  workflow: string;
  runId: string;
  /** The step's event path in that run. */
  path: string;
  actor?: string;
  principal?: string;
  /** The job the run was launched under (plans/jobs.md §1): which job the
   *  turn was made under, so a thread is found from its job whatever its
   *  id (plans/job-index.md §4). Records, ties nothing. */
  job?: string;
  provider: string;
  /** Canonical `provider/id`. */
  model: string;
  /** The turn went through an LLM gateway (`ResolvedModel.routed`). */
  routed: boolean;
  usage?: unknown;
  cost?: number;
  /** The context after the turn's last model call. */
  context?: { used: number; limit: number };
  /** Where the NEXT turn's replay begins: an absolute index into
   *  `messages.jsonl`, set by a turn that compacted the thread
   *  (plans/compaction.md) to the index of its `[compaction]` message.
   *  Absent → inherited from the previous line (0 at first); every stored
   *  line states it. Offsets stay absolute: the whole thread is still there. */
  replayFrom?: number;
}

export interface SessionTurn extends NewTurn {
  /** 0-based. */
  turn: number;
  at: string;
  /** Messages in the thread before this turn… */
  offset: number;
  /** …and how many this turn appended. */
  count: number;
}

export interface Session {
  id: string;
  system: string;
  messages: StoredMessage[];
  turns: SessionTurn[];
  /** The last turn's `replayFrom`: where the next turn starts replaying. */
  replayFrom: number;
}

export interface SessionInfo {
  id: string;
  turns: number;
  messages: number;
  createdAt: string;
  updatedAt: string;
  /** The principal (else the actor) of turn 0. Recorded, never checked. */
  createdBy?: string;
  /** The distinct jobs its turns were made under, in order of first
   *  appearance. Absent when no turn carried one. */
  jobs?: string[];
  provider: string;
  model: string;
  context?: { used: number; limit: number };
}

export function sessionInfo(id: string, turns: SessionTurn[]): SessionInfo | null {
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (!first || !last) return null;
  const createdBy = first.principal ?? first.actor;
  const jobs = [...new Set(turns.map((t) => t.job).filter((j): j is string => typeof j === "string" && j.length > 0))];
  return {
    id,
    turns: turns.length,
    messages: last.offset + last.count,
    createdAt: first.at,
    updatedAt: last.at,
    ...(createdBy ? { createdBy } : {}),
    ...(jobs.length ? { jobs } : {}),
    provider: first.provider,
    model: last.model,
    ...(last.context ? { context: last.context } : {}),
  };
}

// ── interface ──────────────────────────────────────────────────────────────

export interface SessionStore {
  /** The thread, or `null` when no turn was ever committed under `id`. */
  load(id: string): Promise<Session | null>;
  /** Commit one turn. `system` is stored by turn 0 and ignored after. */
  appendTurn(id: string, turn: { system: string; messages: unknown[]; record: NewTurn }): Promise<SessionTurn>;
  /** Newest first. */
  list(): Promise<SessionInfo[]>;
  delete(id: string): Promise<void>;
}

function checked(id: string): string {
  const problem = idProblem(id);
  if (problem) throw new Error(`Invalid session id "${id}": ${problem}`);
  return id;
}

const newestFirst = (a: SessionInfo, b: SessionInfo) => b.updatedAt.localeCompare(a.updatedAt);

function nextTurn(turns: SessionTurn[], count: number, record: NewTurn): SessionTurn {
  const last = turns[turns.length - 1];
  return {
    turn: turns.length,
    at: new Date().toISOString(),
    offset: last ? last.offset + last.count : 0,
    count,
    ...record,
    // Carried forward, so every line says where the replay begins.
    replayFrom: record.replayFrom ?? last?.replayFrom ?? 0,
  };
}

/** Where a thread's next turn starts replaying: its last line's word. */
export function replayFromOf(turns: SessionTurn[]): number {
  return turns[turns.length - 1]?.replayFrom ?? 0;
}

// ── filesystem ─────────────────────────────────────────────────────────────

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf-8")).split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private root: string) {}

  private dir(id: string): string {
    return join(this.root, "sessions", encodeId(checked(id)));
  }

  private async turns(id: string): Promise<SessionTurn[]> {
    return (await readLines(join(this.dir(id), "turns.jsonl"))).map((l) => JSON.parse(l) as SessionTurn);
  }

  async load(id: string): Promise<Session | null> {
    const turns = await this.turns(id);
    const last = turns[turns.length - 1];
    if (!last) return null;
    const dir = this.dir(id);
    const lines = await readLines(join(dir, "messages.jsonl"));
    return {
      id,
      system: await readFile(join(dir, "system.md"), "utf-8"),
      messages: lines.slice(0, last.offset + last.count).map((l) => JSON.parse(l) as StoredMessage),
      turns,
      replayFrom: replayFromOf(turns),
    };
  }

  async appendTurn(id: string, turn: { system: string; messages: unknown[]; record: NewTurn }): Promise<SessionTurn> {
    const dir = this.dir(id);
    const turns = await this.turns(id);
    const line = nextTurn(turns, turn.messages.length, turn.record);
    await mkdir(dir, { recursive: true });
    if (!turns.length) await writeFile(join(dir, "system.md"), turn.system, "utf-8");
    // Lines a crash left behind an uncommitted turn go first.
    const file = join(dir, "messages.jsonl");
    const lines = await readLines(file);
    if (lines.length > line.offset) await writeFile(file, lines.slice(0, line.offset).join("\n") + "\n", "utf-8");
    if (turn.messages.length) await appendFile(file, jsonl(turn.messages), "utf-8");
    await appendFile(join(dir, "turns.jsonl"), jsonl([line]), "utf-8");
    return line;
  }

  async list(): Promise<SessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(join(this.root, "sessions"));
    } catch {
      return [];
    }
    const out: SessionInfo[] = [];
    for (const name of names) {
      let id: string;
      try {
        id = decodeURIComponent(name);
      } catch {
        continue;
      }
      if (idProblem(id)) continue;
      const info = sessionInfo(id, await this.turns(id));
      if (info) out.push(info);
    }
    return out.sort(newestFirst);
  }

  async delete(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}

// ── in-memory ──────────────────────────────────────────────────────────────

export class MemorySessionStore implements SessionStore {
  sessions = new Map<string, Session>();

  async load(id: string): Promise<Session | null> {
    const s = this.sessions.get(checked(id));
    // Copies: the caller may hold them across a later append.
    return s ? { ...s, messages: [...s.messages], turns: [...s.turns], replayFrom: replayFromOf(s.turns) } : null;
  }

  async appendTurn(id: string, turn: { system: string; messages: unknown[]; record: NewTurn }): Promise<SessionTurn> {
    const s = this.sessions.get(checked(id)) ?? { id, system: turn.system, messages: [], turns: [], replayFrom: 0 };
    const line = nextTurn(s.turns, turn.messages.length, turn.record);
    // Through JSON, like the file store: what is read back is what a file
    // would hold.
    s.messages.push(...(JSON.parse(JSON.stringify(turn.messages)) as StoredMessage[]));
    s.turns.push(line);
    this.sessions.set(id, s);
    return line;
  }

  async list(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      const info = sessionInfo(s.id, s.turns);
      if (info) out.push(info);
    }
    return out.sort(newestFirst);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(checked(id));
  }
}

// ── the capability ─────────────────────────────────────────────────────────

/** Who has a session open. */
export interface SessionHolder {
  runId: string;
  path: string;
}

/** A session held by one agent step, from `open` to `release`. */
export interface OpenSession {
  id: string;
  /** `null` on turn 0: the step's own `system` starts the thread. */
  system: string | null;
  /** The WHOLE thread; the step replays `messages.slice(replayFrom)`. */
  messages: StoredMessage[];
  turns: SessionTurn[];
  replayFrom: number;
  commit(turn: { system: string; messages: unknown[]; record: NewTurn }): Promise<SessionTurn>;
  release(): void;
}

/**
 * `ctx.services.sessions` — how a step reaches the session store. `open`
 * takes the session's lock and throws `session_busy:` when another step
 * holds it: two turns at once would both read the same thread and
 * interleave their appends. The lock is in-process, like everything that
 * tracks what is running (strut is single-process by design); a crash drops
 * every lock.
 */
export interface SessionsCapability {
  open(id: string, holder: SessionHolder): Promise<OpenSession>;
  /** Who holds `id` right now, if anyone. */
  holder(id: string): SessionHolder | undefined;
}

export function sessionsCapability(store: SessionStore): SessionsCapability {
  const held = new Map<string, SessionHolder>();
  return {
    holder: (id) => held.get(id),
    async open(id, holder) {
      checked(id);
      const by = held.get(id);
      if (by) throw new Error(`session_busy: session "${id}" is in use by run ${by.runId} (${by.path})`);
      held.set(id, holder);
      const release = () => {
        if (held.get(id) === holder) held.delete(id);
      };
      try {
        const s = await store.load(id);
        return {
          id,
          system: s ? s.system : null,
          messages: s ? s.messages : [],
          turns: s ? s.turns : [],
          replayFrom: s ? s.replayFrom : 0,
          commit: (turn) => store.appendTurn(id, turn),
          release,
        };
      } catch (err) {
        release();
        throw err;
      }
    },
  };
}
