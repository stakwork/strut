/**
 * The chat VIEW an external agent reads (the assistant MCP door's
 * `read_workflow_builder_chat`, and what `ask_workflow_builder` returns for
 * the turn it waited on) — the chat twin of src/run-view.ts.
 *
 * `messages.jsonl` is the model's own view of the conversation: every tool
 * call with its arguments and its result, as the model read them. A caller
 * outside strut wants none of that. It wants what it said, what the builder
 * answered, and what the builder DID — the workflows it published, the runs
 * it launched and their deliverables, the schedules it set, the question it
 * is waiting on. So the stored messages are folded into TURNS: a turn is one
 * message of the caller's and everything the builder did until the next
 * one; a server notice that woke the builder (a run finishing, a verify
 * verdict, a restart) starts a turn of its own, named by its first line.
 * The effects (`did`) are folded from the tool calls by tool NAME — a small
 * table over the builder tools' own result shapes (ai/tools.ts), never
 * inferred from prose.
 *
 * `since` is a cursor into the message log (the `cursor` of the previous
 * read), the chat's `?skip=N`; `limit` keeps the newest turns; `detail`
 * adds the tool calls (previews, or whole); a char budget cuts the text,
 * then the oldest turns, and says so in `hint`. Pure; tested.
 */
import type { StoredMessage } from "./chat-store.js";
import { NOTIFICATION_PREFIX, RESTART_PREFIX } from "./ai/notifier.js";
import { VERIFY_NOTIFICATION_PREFIX } from "./ledger.js";
import { COMPACTION_PREFIX } from "./compaction.js";
import { ATTACHMENT_PREFIX } from "./ai/attachments.js";

export type ChatDetail = "effects" | "tools" | "full";

export interface ChatViewOptions {
  /** Message index to read from — the `cursor` of the previous read. */
  since?: number;
  /** At most this many turns, the newest kept. */
  limit?: number;
  /** `effects` (default): text + `did`. `tools`: + each tool call with
   *  previews. `full`: + each call's whole input and result. */
  detail?: ChatDetail;
  /** The result's char budget (its JSON). */
  maxChars?: number;
}

export const DEFAULT_CHAT_VIEW_MAX_CHARS = 20_000;
export const DEFAULT_CHAT_VIEW_LIMIT = 20;

export interface DidWorkflow {
  name: string;
  version?: string;
  action: "created" | "edited" | "activated";
  ui?: string;
}
export interface DidStep {
  name: string;
  version?: string;
  action: "created" | "edited" | "activated";
}
export interface DidRun {
  workflow: string;
  runId: string;
  /** `success | error | cancelled`, or `running` when the run detached. */
  status: string;
  error?: string;
  /** The run's declared deliverables as the tool result carried them (links
   *  are absolute with their read token on a chat started over MCP). */
  artifacts?: unknown[];
  ui?: string;
}
export interface DidAutomation {
  workflow: string;
  id?: string;
  summary?: string;
  next?: string;
  action: "set" | "deleted";
}

/** What a turn changed, by kind. Every field absent when nothing of its kind happened. */
export interface Did {
  workflows?: DidWorkflow[];
  steps?: DidStep[];
  runs?: DidRun[];
  automations?: DidAutomation[];
}

export interface ToolCallView {
  name: string;
  input?: unknown;
  result?: unknown;
  isError?: true;
}

/** A question the builder asked in this turn (`ask_user` / `request_secret`).
 *  Whether it is still open is the chat's meta (`question` on the ask result). */
export interface AskedView {
  mode: "form" | "url";
  message: string;
  /** form: the fields asked for. */
  fields?: string[];
  /** url: the secret's NAME. */
  name?: string;
}

export interface ChatTurnView {
  /** Index of the message that started the turn (a `since` for a later read). */
  at: number;
  /** What the caller said. */
  you?: string;
  /** What woke the builder instead: the first line of each server notice. */
  notices?: string[];
  /** The builder's final text for the turn. */
  text?: string;
  did?: Did;
  /** How many tools the builder called. */
  toolCalls?: number;
  /** `detail: "tools" | "full"`: the calls, in order. */
  tools?: ToolCallView[];
  asked?: AskedView;
  /** The turn compacted the chat's history (plans/compaction.md). */
  compacted?: true;
}

export interface ChatView {
  turns: ChatTurnView[];
  /** The message log's length: pass as `since` to read only what follows. */
  cursor: number;
  /** Turns left out: over `limit`, or cut to the budget. */
  omitted?: number;
  hint?: string;
}

const SERVER_NOTICES = [NOTIFICATION_PREFIX, VERIFY_NOTIFICATION_PREFIX, RESTART_PREFIX];
const PREVIEW_CHARS = 300;
const TEXT_CUT_CHARS = 1_500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** A user message's text: a string, or its text parts joined — an
 *  attachment's announcing line kept (its name and type), the file itself
 *  (an image, a PDF) left out. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (isRecord(p) && p["type"] === "text" && typeof p["text"] === "string" ? p["text"] : ""))
    .filter(Boolean)
    .join("\n");
}

/** `[attachment] name (type, size) — saved at …` → `name (type, size)`. */
function stripAttachmentPaths(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith(ATTACHMENT_PREFIX) ? line.replace(/ — saved at .*$/, "").replace(`${ATTACHMENT_PREFIX} `, "attached: ") : line))
    .join("\n");
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

/** A stored tool-result `output` ({ type, value }) → the value and whether it was an error. */
function unwrapOutput(output: unknown): { value: unknown; isError: boolean } {
  if (isRecord(output) && typeof output["type"] === "string" && "value" in output) {
    return { value: output["value"], isError: String(output["type"]).startsWith("error") };
  }
  return { value: output, isError: false };
}

function preview(v: unknown, max = PREVIEW_CHARS): unknown {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max)}… [${s.length} chars]` : typeof v === "string" ? v : s;
}

function cutText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [cut, ${text.length} chars]` : text;
}

// ── Effects: tool name → what it did ───────────────────────────────────────

/** Fold one finished tool call onto the turn's `did` / `asked`. The shapes
 *  are the builder tools' own results (ai/tools.ts): `ok: true` + name +
 *  version for a publish, a RunResult (+ links) for run_workflow, the
 *  scheduler's `{ automation, next }` for set_automation. */
function foldEffect(turn: ChatTurnView, name: string, input: unknown, result: unknown): void {
  const inp = isRecord(input) ? input : {};
  const out = isRecord(result) ? result : {};
  const did = (turn.did ??= {});
  const ok = out["ok"] === true;
  switch (name) {
    case "create_workflow":
    case "edit_workflow": {
      if (!ok || out["changed"] === false) return;
      (did.workflows ??= []).push({
        name: str(out["name"]) ?? str(inp["name"]) ?? "?",
        ...(str(out["version"]) ? { version: out["version"] as string } : {}),
        action: name === "create_workflow" ? "created" : "edited",
        ...(str(out["ui"]) ? { ui: out["ui"] as string } : {}),
      });
      return;
    }
    case "set_active_version": {
      if (!ok) return;
      const entry = { name: str(out["name"]) ?? str(inp["name"]) ?? "?", ...(str(out["active"]) ? { version: out["active"] as string } : {}), action: "activated" as const };
      if (out["kind"] === "step") (did.steps ??= []).push(entry);
      else (did.workflows ??= []).push(entry);
      return;
    }
    case "create_step":
    case "edit_step": {
      if (!ok) return;
      (did.steps ??= []).push({
        name: str(out["name"]) ?? str(inp["name"]) ?? "?",
        ...(str(out["version"]) ? { version: out["version"] as string } : {}),
        action: name === "create_step" ? "created" : "edited",
      });
      return;
    }
    case "run_workflow": {
      const runId = str(out["runId"]);
      if (!runId) return;
      const err = out["error"];
      const run: DidRun = {
        workflow: str(out["workflow"]) ?? str(inp["name"]) ?? "?",
        runId,
        status: str(out["status"]) ?? (err ? "error" : "unknown"),
        ...(err ? { error: isRecord(err) ? (str(err["message"]) ?? JSON.stringify(err)) : String(err) } : {}),
        ...(Array.isArray(out["artifacts"]) ? { artifacts: out["artifacts"] as unknown[] } : {}),
        ...(str(out["ui"]) ? { ui: out["ui"] as string } : {}),
      };
      const runs = (did.runs ??= []);
      const i = runs.findIndex((r) => r.runId === runId);
      if (i === -1) runs.push(run);
      else runs[i] = { ...runs[i]!, ...run };
      return;
    }
    case "set_automation": {
      if (!ok) return;
      const a = isRecord(out["automation"]) ? out["automation"] : {};
      const next = Array.isArray(out["next"]) ? out["next"][0] : undefined;
      (did.automations ??= []).push({
        workflow: str(a["workflow"]) ?? str(inp["workflow"]) ?? "?",
        ...(str(a["id"]) ? { id: a["id"] as string } : {}),
        ...(str(a["summary"]) ? { summary: a["summary"] as string } : {}),
        ...(str(next) ? { next: next as string } : {}),
        action: "set",
      });
      return;
    }
    case "delete_automation": {
      if (!ok) return;
      (did.automations ??= []).push({
        workflow: str(inp["workflow"]) ?? "?",
        ...(str(out["id"]) ?? str(inp["id"]) ? { id: (str(out["id"]) ?? str(inp["id"])) as string } : {}),
        action: "deleted",
      });
      return;
    }
    case "ask_user":
    case "request_secret": {
      if (out["status"] !== "asked") return;
      const schema = isRecord(inp["requestedSchema"]) ? inp["requestedSchema"] : undefined;
      const props = schema && isRecord(schema["properties"]) ? Object.keys(schema["properties"]) : undefined;
      turn.asked =
        name === "ask_user"
          ? { mode: "form", message: str(inp["message"]) ?? "", ...(props ? { fields: props } : {}) }
          : { mode: "url", message: str(inp["reason"]) ?? str(inp["message"]) ?? "", ...(str(inp["name"]) ? { name: inp["name"] as string } : {}) };
      return;
    }
    default:
      return;
  }
}

// ── The fold ───────────────────────────────────────────────────────────────

/** Every turn from `since` on, uncut: the fold itself. */
export function foldChatTurns(messages: StoredMessage[], since = 0): ChatTurnView[] {
  const turns: ChatTurnView[] = [];
  let turn: ChatTurnView | undefined;
  /** Open tool calls of the current turn, by id. */
  const open = new Map<string, ToolCallView>();
  const start = (at: number): ChatTurnView => {
    turn = { at };
    turns.push(turn);
    open.clear();
    return turn;
  };

  for (let i = Math.max(0, since); i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") {
      const text = userText(m.content);
      if (text.startsWith(COMPACTION_PREFIX)) {
        if (turn) turn.compacted = true;
        continue;
      }
      const notice = SERVER_NOTICES.find((p) => text.startsWith(p));
      if (notice) {
        // Notices queued behind one turn drain into one wake-up turn: consecutive ones share it.
        if (turn && turn.notices && turn.you === undefined && turn.text === undefined && !turn.toolCalls) turn.notices.push(firstLine(text));
        else start(i).notices = [firstLine(text)];
        continue;
      }
      start(i).you = stripAttachmentPaths(text) || (Array.isArray(m.content) && m.content.length ? "(files)" : "");
      continue;
    }
    if (!turn) turn = start(i);
    if (m.role === "assistant") {
      const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
      let text = "";
      for (const p of parts) {
        if (!isRecord(p)) continue;
        if (p["type"] === "text" && typeof p["text"] === "string") text += p["text"];
        else if (p["type"] === "tool-call" && typeof p["toolName"] === "string") {
          const call: ToolCallView = { name: p["toolName"], input: p["input"] };
          turn.toolCalls = (turn.toolCalls ?? 0) + 1;
          (turn.tools ??= []).push(call);
          if (typeof p["toolCallId"] === "string") open.set(p["toolCallId"], call);
        }
      }
      // The turn's text is the LAST assistant text with anything in it.
      if (text.trim()) turn.text = text;
      continue;
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!isRecord(p) || p["type"] !== "tool-result" || typeof p["toolCallId"] !== "string") continue;
        const call = open.get(p["toolCallId"]);
        if (!call) continue;
        const { value, isError } = unwrapOutput(p["output"]);
        call.result = value;
        if (isError) call.isError = true;
        foldEffect(turn, call.name, call.input, value);
      }
    }
  }
  return turns;
}

/** The view: fold, keep the newest `limit` turns, shape them to `detail`,
 *  then fit the budget — the text cut first, then the oldest turns dropped. */
export function buildChatView(messages: StoredMessage[], opts: ChatViewOptions = {}): ChatView {
  const detail = opts.detail ?? "effects";
  const limit = opts.limit ?? DEFAULT_CHAT_VIEW_LIMIT;
  const max = opts.maxChars ?? DEFAULT_CHAT_VIEW_MAX_CHARS;
  const all = foldChatTurns(messages, opts.since);
  let omitted = Math.max(0, all.length - limit);
  let turns = all.slice(omitted).map((t) => shape(t, detail));

  const size = () => JSON.stringify({ turns }).length;
  let cut = false;
  if (size() > max) {
    cut = true;
    turns = turns.map((t) => ({
      ...t,
      ...(t.you ? { you: cutText(t.you, TEXT_CUT_CHARS) } : {}),
      ...(t.text ? { text: cutText(t.text, TEXT_CUT_CHARS) } : {}),
      ...(t.tools && detail === "full" ? { tools: t.tools.map((c) => ({ ...c, input: preview(c.input), result: preview(c.result) })) } : {}),
    }));
  }
  while (turns.length > 1 && size() > max) {
    turns.shift();
    omitted++;
  }
  const cursor = messages.length;
  const hints: string[] = [];
  if (omitted) hints.push(`${omitted} earlier turn${omitted === 1 ? "" : "s"} left out${cut ? " (over the budget)" : ""}: read with since: ${opts.since ?? 0}, limit: ${omitted}${turns[0] ? ` to see up to message ${turns[0].at}` : ""}.`);
  else if (cut) hints.push("Text was cut to fit the budget.");
  if (detail !== "full" && turns.some((t) => t.toolCalls)) hints.push(detail === "effects" ? "detail: \"tools\" lists each tool call." : "detail: \"full\" gives each call's whole input and result.");
  return { turns, cursor, ...(omitted ? { omitted } : {}), ...(hints.length ? { hint: hints.join(" ") } : {}) };
}

function shape(t: ChatTurnView, detail: ChatDetail): ChatTurnView {
  const { tools, ...rest } = t;
  if (detail === "effects" || !tools) return rest;
  if (detail === "full") return { ...rest, tools };
  return { ...rest, tools: tools.map((c) => ({ name: c.name, ...(c.input !== undefined ? { input: preview(c.input, 200) } : {}), ...(c.result !== undefined ? { result: preview(c.result) } : {}), ...(c.isError ? { isError: true as const } : {}) })) };
}
