import {
  mkdir,
  writeFile,
  appendFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tailJsonl } from "./store.js";
import type { ElicitationRecord } from "./ai/elicitation.js";

/**
 * Chat persistence — the server-side store that makes the AI builder a
 * detached "background job" (EVAL_SPEC §8) instead of a connection-bound
 * stream. A chat session is an append-only run with the SAME launch-detached
 * + tail-the-file lifecycle strut uses for workflow runs, PLUS a resumable
 * conversation log so a turn keeps running (and can be re-driven) after the
 * browser closes.
 *
 * Each chat lives in `<workspaceRoot>/chats/<chatId>/` with the deliberate
 * two-file split borrowed from `mcp/src/repo/session.ts`:
 *
 *   meta.json       — { id, title, status, model, createdAt, updatedAt,
 *                       currentTurn }. Cheap listing without parsing the logs.
 *   system.md       — the chat's system prompt, rendered on its first turn and
 *                     replayed verbatim on every later one (the head of the
 *                     cached prefix — see `getSystem`).
 *   messages.jsonl  — append-only conversation (AI SDK ModelMessage objects).
 *                     The REPLAYABLE record: re-fed to the agent on the next
 *                     turn and rendered as the transcript. Whole messages only
 *                     — never deltas (keeps replay clean) — exactly as the
 *                     model saw them (tool results capped where they are
 *                     made: `capToolOutput`).
 *   events.jsonl    — append-only fine-grained stream parts (text deltas, tool
 *                     calls/results, step/turn boundaries). The OBSERVABILITY
 *                     stream the SSE tail follows; never re-sent to the model.
 *                     Tool outputs here are the tools' own, uncapped.
 *
 * A chat is long-lived across many turns; the unit with launch+detach+tail
 * semantics is a TURN. Each turn's events carry `turn: N` and end with a
 * `chat.end`/`chat.error`, so the tail stops at the right boundary even when
 * replaying a multi-turn history (see `tailEvents`).
 */

export type ChatStatus = "live" | "done" | "error";

export interface ChatMeta {
  id: string;
  title?: string;
  status: ChatStatus;
  model?: string;
  createdAt: string;
  updatedAt: string;
  /** Index of the most recently launched turn (0-based). */
  currentTurn: number;
  /** Consecutive notification-triggered (non-human) turns since the last
   *  human message. Incremented by the run notifier, reset to 0 by
   *  `POST /chat`; at `STRUT_CHAT_MAX_AUTO_TURNS` the chat parks (see
   *  `ai/notifier.ts`). */
  autoTurns?: number;
  /** Where a host hears about this chat's turn ends (`POST /chat { callback }`;
   *  see `ai/turn-callback.ts`). On the chat, not the turn: notification-
   *  triggered turns post here too. The URL is a credential — read endpoints
   *  return its origin only. */
  callback?: { url: string };
  /** Who is talking to this chat — the request actor of the latest human
   *  message (plans/mothership-cost-control.md §2). Chat turns, and the runs
   *  the builder launches, are billed to it. */
  actor?: string;
  /** Who started this chat: the actor of the first human message that
   *  carried one, never changed after (the chat twin of a workflow's
   *  `owner`). The history list shows it. */
  createdBy?: string;
  /** The open elicitation — the builder's question awaiting an answer
   *  (plans/elicitation.md; `ai/elicitation.ts`). One per chat, persisted so
   *  it survives a restart. A new ask replaces it; `POST /chat` (a typed
   *  message) and an answer clear it. */
  elicitation?: ElicitationRecord;
  /** How full the model's context window is, as of the chat's last model
   *  call (the flyout's "351k / 1M"). Set at every step end. */
  context?: ChatContext;
  /** Where a turn's replay begins in `messages.jsonl`: the index of the
   *  latest `[compaction]` message (plans/compaction.md §5). Absent → 0.
   *  The whole history stays on disk and the read endpoints serve it. */
  replayFrom?: number;
}

/** Tokens the conversation occupies after a model call — that call's input
 *  (cached reads included) plus what it generated, which the next call
 *  carries — against the model's context window (aieo's per-model table). */
export interface ChatContext {
  used: number;
  limit: number;
}

export type ChatEventType =
  | "text-delta"
  | "tool-input"
  | "tool-output"
  | "tool-progress"
  | "step.finish"
  | "chat.compact"
  | "chat.end"
  | "chat.error";

/** A single fine-grained event in a chat turn's observability stream. */
export interface ChatEvent {
  ts: string;
  chatId: string;
  /** Which user turn this event belongs to (0-based). */
  turn: number;
  type: ChatEventType;
  /** text-delta */
  delta?: string;
  /** tool-input / tool-output / tool-progress (a preliminary result — a
   *  streaming tool's intermediate yield; never stored in messages.jsonl) */
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  /** tool-output: the tool threw (output is the error message). */
  isError?: boolean;
  /** chat.error */
  error?: { message: string };
  /** chat.end: the turn was stopped (`POST /chat/:id/cancel`); what streamed
   *  before the stop is in the transcript. */
  stopped?: true;
  /** step.finish: the context after this step (also on `ChatMeta.context`).
   *  chat.compact: the floor the compaction left (the summary's size). */
  context?: ChatContext;
  /** chat.compact: what was folded into the summary, and what writing it cost. */
  compact?: { messages: number; tokens: number; usage?: unknown };
}

/** A stored conversation message. Kept opaque (the AI SDK's `ModelMessage`
 *  shape) — the store only reads/writes JSON lines and never interprets it. */
export interface StoredMessage {
  role: string;
  content: unknown;
}

/** A turn is terminal once its log records a `chat.end` or `chat.error`. */
export function isChatTerminal(e: ChatEvent): boolean {
  return e.type === "chat.end" || e.type === "chat.error";
}

// ── Interface ──────────────────────────────────────────────────────────────

export interface ChatStore {
  createChat(init: { id: string; title?: string; model?: string }): Promise<ChatMeta>;
  getMeta(chatId: string): Promise<ChatMeta | null>;
  setMeta(chatId: string, patch: Partial<ChatMeta>): Promise<ChatMeta | null>;
  listChats(): Promise<ChatMeta[]>;
  appendMessages(chatId: string, messages: StoredMessage[]): Promise<void>;
  loadMessages(chatId: string): Promise<StoredMessage[]>;
  appendEvent(chatId: string, event: ChatEvent): Promise<void>;
  /** Tail a single turn's events (history → live) until that turn ends. */
  tailEvents(
    chatId: string,
    turn: number,
    opts?: { intervalMs?: number; signal?: AbortSignal },
  ): AsyncGenerator<ChatEvent>;
  /** The chat's system prompt — null until its first turn renders one. Set
   *  once and replayed verbatim: it is the head of the prompt-cache prefix,
   *  so a prompt re-rendered per turn (a new step in the tree, a host
   *  section re-read) would miss the cache for the whole conversation. */
  getSystem(chatId: string): Promise<string | null>;
  setSystem(chatId: string, system: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
}

// ── Tool-result cap (token hygiene for long autonomous loops) ───────────────

/** Default per-string cap on the builder's tool results. Env
 *  `STRUT_CHAT_TOOL_RESULT_MAX_CHARS` overrides it; `0` disables it. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000;

/** Resolve the tool-result cap from the environment (see above). */
export function toolResultMaxCharsFromEnv(): number {
  const raw = process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"];
  if (raw === undefined || raw === "") return DEFAULT_TOOL_RESULT_MAX_CHARS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

/**
 * Cap every long string in a tool result at `maxChars`, marker included: a
 * capped string is never longer than `maxChars`, so capping twice changes
 * nothing. Structure is kept; binary parts (`{ data, mediaType }`) are left
 * whole.
 *
 * The builder's tools apply it where the result is made (`capToolResults`,
 * ai/tools.ts): the model reads the capped result in the turn that ran the
 * tool, `messages.jsonl` records exactly that, and every later turn replays
 * the same bytes. Capping only on replay instead rewrote history one turn
 * later — a prompt-cache miss from that result on (the whole conversation,
 * once it sat beyond the provider's lookback), and on models that bind
 * thinking blocks to the prefix, every later block invalidated.
 */
export function capToolOutput<T>(value: T, maxChars = toolResultMaxCharsFromEnv()): T {
  if (maxChars <= 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return capString(v, maxChars);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      if ("data" in v && typeof (v as { mediaType?: unknown }).mediaType === "string") return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

function capString(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const marker = `\n\n[TRUNCATED: ${s.length} chars, cut to ${maxChars}]`;
  return marker.length < maxChars ? s.slice(0, maxChars - marker.length) + marker : s.slice(0, maxChars);
}

/**
 * The same cap over a stored history's `role: "tool"` messages, on what a
 * turn replays. A no-op on anything recorded since the tools cap at the
 * source; it keeps a history recorded before then (full results on disk) at
 * the size the model has been reading.
 */
export function truncateToolMessages(
  messages: StoredMessage[],
  maxChars = toolResultMaxCharsFromEnv(),
): StoredMessage[] {
  if (maxChars <= 0) return messages;
  return messages.map((m) => (m.role === "tool" ? { ...m, content: capToolOutput(m.content, maxChars) } : m));
}

// ── Filesystem implementation ──────────────────────────────────────────────

export class FileChatStore implements ChatStore {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private chatDir(chatId: string): string {
    return join(this.workspaceRoot, "chats", chatId);
  }

  private metaFile(chatId: string): string {
    return join(this.chatDir(chatId), "meta.json");
  }

  async createChat(init: { id: string; title?: string; model?: string }): Promise<ChatMeta> {
    const now = new Date().toISOString();
    const meta: ChatMeta = {
      id: init.id,
      ...(init.title ? { title: init.title } : {}),
      status: "live",
      ...(init.model ? { model: init.model } : {}),
      createdAt: now,
      updatedAt: now,
      currentTurn: -1,
    };
    await mkdir(this.chatDir(init.id), { recursive: true });
    await writeFile(this.metaFile(init.id), JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  }

  async getMeta(chatId: string): Promise<ChatMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaFile(chatId), "utf-8")) as ChatMeta;
    } catch {
      return null;
    }
  }

  async setMeta(chatId: string, patch: Partial<ChatMeta>): Promise<ChatMeta | null> {
    const current = await this.getMeta(chatId);
    if (!current) return null;
    const next: ChatMeta = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeFile(this.metaFile(chatId), JSON.stringify(next, null, 2), "utf-8");
    return next;
  }

  async listChats(): Promise<ChatMeta[]> {
    const dir = join(this.workspaceRoot, "chats");
    let ids: string[];
    try {
      ids = await readdir(dir);
    } catch {
      return [];
    }
    const metas: ChatMeta[] = [];
    for (const id of ids) {
      const meta = await this.getMeta(id);
      if (meta) metas.push(meta);
    }
    // Newest first by updatedAt.
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendMessages(chatId: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await mkdir(this.chatDir(chatId), { recursive: true });
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await appendFile(join(this.chatDir(chatId), "messages.jsonl"), lines, "utf-8");
  }

  async loadMessages(chatId: string): Promise<StoredMessage[]> {
    try {
      const raw = await readFile(join(this.chatDir(chatId), "messages.jsonl"), "utf-8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as StoredMessage);
    } catch {
      return [];
    }
  }

  async appendEvent(chatId: string, event: ChatEvent): Promise<void> {
    await mkdir(this.chatDir(chatId), { recursive: true });
    await appendFile(
      join(this.chatDir(chatId), "events.jsonl"),
      JSON.stringify(event) + "\n",
      "utf-8",
    );
  }

  async *tailEvents(
    chatId: string,
    turn: number,
    opts: { intervalMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatEvent> {
    const file = join(this.chatDir(chatId), "events.jsonl");
    // Tail the whole file but only stop at THIS turn's terminal, and only
    // surface THIS turn's events — earlier turns' events (and terminals) are
    // replayed-through but filtered out, so a late reattach lands cleanly on
    // the requested turn regardless of how many turns precede it.
    for await (const e of tailJsonl<ChatEvent>(
      file,
      (e) => e.turn === turn && isChatTerminal(e),
      opts,
    )) {
      if (e.turn === turn) yield e;
    }
  }

  async getSystem(chatId: string): Promise<string | null> {
    try {
      return await readFile(join(this.chatDir(chatId), "system.md"), "utf-8");
    } catch {
      return null;
    }
  }

  async setSystem(chatId: string, system: string): Promise<void> {
    await mkdir(this.chatDir(chatId), { recursive: true });
    await writeFile(join(this.chatDir(chatId), "system.md"), system, "utf-8");
  }

  async deleteChat(chatId: string): Promise<void> {
    await rm(this.chatDir(chatId), { recursive: true, force: true });
  }
}

// ── In-memory implementation (for testing) ─────────────────────────────────

export class MemoryChatStore implements ChatStore {
  metas = new Map<string, ChatMeta>();
  messages = new Map<string, StoredMessage[]>();
  events = new Map<string, ChatEvent[]>();
  systems = new Map<string, string>();

  async createChat(init: { id: string; title?: string; model?: string }): Promise<ChatMeta> {
    const now = new Date().toISOString();
    const meta: ChatMeta = {
      id: init.id,
      ...(init.title ? { title: init.title } : {}),
      status: "live",
      ...(init.model ? { model: init.model } : {}),
      createdAt: now,
      updatedAt: now,
      currentTurn: -1,
    };
    this.metas.set(init.id, meta);
    return meta;
  }

  async getMeta(chatId: string): Promise<ChatMeta | null> {
    return this.metas.get(chatId) ?? null;
  }

  async setMeta(chatId: string, patch: Partial<ChatMeta>): Promise<ChatMeta | null> {
    const current = this.metas.get(chatId);
    if (!current) return null;
    const next: ChatMeta = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.metas.set(chatId, next);
    return next;
  }

  async listChats(): Promise<ChatMeta[]> {
    return [...this.metas.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendMessages(chatId: string, messages: StoredMessage[]): Promise<void> {
    const arr = this.messages.get(chatId) ?? [];
    arr.push(...messages);
    this.messages.set(chatId, arr);
  }

  async loadMessages(chatId: string): Promise<StoredMessage[]> {
    // A copy: the caller may append to the store while holding this.
    return [...(this.messages.get(chatId) ?? [])];
  }

  async appendEvent(chatId: string, event: ChatEvent): Promise<void> {
    const arr = this.events.get(chatId) ?? [];
    arr.push(event);
    this.events.set(chatId, arr);
  }

  /** Same contract as the file tail: replay the turn's history, then follow
   *  live appends (index cursor + poll) until the turn's terminal event. */
  async *tailEvents(
    chatId: string,
    turn: number,
    opts: { intervalMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatEvent> {
    const intervalMs = opts.intervalMs ?? 250;
    let cursor = 0;
    while (true) {
      if (opts.signal?.aborted) return;
      const log = this.events.get(chatId) ?? [];
      while (cursor < log.length) {
        const e = log[cursor++]!;
        if (e.turn !== turn) continue;
        yield e;
        if (isChatTerminal(e)) return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async getSystem(chatId: string): Promise<string | null> {
    return this.systems.get(chatId) ?? null;
  }

  async setSystem(chatId: string, system: string): Promise<void> {
    this.systems.set(chatId, system);
  }

  async deleteChat(chatId: string): Promise<void> {
    this.metas.delete(chatId);
    this.messages.delete(chatId);
    this.events.delete(chatId);
    this.systems.delete(chatId);
  }
}

/** Generate a chat ID (timestamp + short random, sortable + collision-safe). */
export function generateChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
