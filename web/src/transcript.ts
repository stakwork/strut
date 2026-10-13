// A transcript — stored AI SDK model messages — folded into what the UI
// renders: user bubbles, assistant text, tool-call chips with their results
// attached by `toolCallId`, server notices, and (for a thread read back from
// a job) the turn boundaries. Shared by the chat flyout (live and replayed)
// and the job timeline's thread view. Pure; tested.
import { isNotice } from "./notice";
import { formatJson } from "./helpers";

/** A tool RESULT paired to its call. `isError` = the tool threw. */
export type ToolResult = { output: unknown; isError: boolean };
/** `progress`: a streaming tool's intermediate outputs (graph_walk's hops). */
export type ToolCall = { name: string; input: any; toolCallId?: string; result?: ToolResult; progress?: unknown[] };
export type ToolGroup = { name: string; calls: ToolCall[] };

export type ChatEntry =
  | { kind: "user"; content: string }
  | { kind: "notice"; content: string }
  | { kind: "text"; content: string }
  | { kind: "tool"; groups: ToolGroup[] }
  /** A boundary the reader should see — a session turn's start. */
  | { kind: "mark"; label: string; detail?: string };

/** Where a mark goes: before the message at index `at`. */
export interface TranscriptMark {
  at: number;
  label: string;
  detail?: string;
}

/** Coalesce consecutive same-name tool calls into groups. */
export function groupCalls(calls: ToolCall[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const tc of calls) {
    const last = groups[groups.length - 1];
    if (last && last.name === tc.name) {
      last.calls.push(tc);
    } else {
      groups.push({ name: tc.name, calls: [tc] });
    }
  }
  return groups;
}

/** Attach a result to the call with the same id, searching tool entries
 *  from the end (the call is almost always in the last one). Returns the
 *  matched call (for callers that need its input) or null. Pure: returns a
 *  new entries array when something changed. */
export function attachResult(
  entries: ChatEntry[],
  toolCallId: string | undefined,
  result: ToolResult,
): { entries: ChatEntry[]; call: ToolCall | null } {
  return updateCall(entries, toolCallId, (c) => ({ ...c, result }));
}

/** Replace the call with this id (searched from the end) by `fn(call)`. */
export function updateCall(
  entries: ChatEntry[],
  toolCallId: string | undefined,
  fn: (c: ToolCall) => ToolCall,
): { entries: ChatEntry[]; call: ToolCall | null } {
  if (!toolCallId) return { entries, call: null };
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== "tool") continue;
    for (let j = 0; j < e.groups.length; j++) {
      const g = e.groups[j]!;
      const k = g.calls.findIndex((c) => c.toolCallId === toolCallId);
      if (k < 0) continue;
      const call = fn(g.calls[k]!);
      const groups = e.groups.slice();
      groups[j] = { ...g, calls: g.calls.map((c, idx) => (idx === k ? call : c)) };
      const next = entries.slice();
      next[i] = { kind: "tool", groups };
      return { entries: next, call };
    }
  }
  return { entries, call: null };
}

/** Unwrap a stored AI SDK tool-result `output` ({ type, value }) into the
 *  plain value + error flag the UI renders. */
export function storedOutputToResult(output: any): ToolResult {
  if (output && typeof output === "object" && typeof output.type === "string" && "value" in output) {
    return { output: output.value, isError: String(output.type).startsWith("error") };
  }
  return { output, isError: false };
}

/** Pull plain text out of an AI SDK message content (string or parts array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

/** Render stored ModelMessages (the transcript) into display entries. Tool
 *  RESULT messages (role "tool") aren't bubbles — each result is attached to
 *  its call (by toolCallId) so the call's chip can disclose it. A system
 *  message renders as nothing (the caller shows it apart, if at all).
 *  `marks` are inserted before the message at their index — a thread's
 *  turn boundaries. */
export function transcriptToEntries(messages: { role: string; content: unknown }[], marks: TranscriptMark[] = []): ChatEntry[] {
  let entries: ChatEntry[] = [];
  const pending = [...marks].sort((a, b) => a.at - b.at);
  for (let i = 0; i < messages.length; i++) {
    while (pending.length && pending[0]!.at <= i) {
      const m = pending.shift()!;
      entries.push({ kind: "mark", label: m.label, ...(m.detail ? { detail: m.detail } : {}) });
    }
    const m = messages[i]!;
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const part of m.content as any[]) {
        if (part?.type !== "tool-result") continue;
        entries = attachResult(entries, part.toolCallId, storedOutputToResult(part.output)).entries;
      }
      continue;
    }
    if (m.role === "user") {
      const text = extractText(m.content);
      if (text) {
        entries.push(
          isNotice(text)
            ? { kind: "notice", content: text }
            : { kind: "user", content: text },
        );
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content) entries.push({ kind: "text", content: m.content });
      } else if (Array.isArray(m.content)) {
        const calls: ToolCall[] = [];
        for (const part of m.content as any[]) {
          if (part?.type === "text" && part.text) {
            entries.push({ kind: "text", content: part.text });
          } else if (part?.type === "tool-call") {
            calls.push({ name: part.toolName, input: part.input, toolCallId: part.toolCallId });
          }
        }
        if (calls.length) entries.push({ kind: "tool", groups: groupCalls(calls) });
      }
    }
  }
  // Marks past the end (an empty turn) still show.
  for (const m of pending) entries.push({ kind: "mark", label: m.label, ...(m.detail ? { detail: m.detail } : {}) });
  return entries;
}

/** Serialize the conversation as markdown — for pasting into an issue or
 *  another chat when debugging. Tool inputs and results are included as JSON
 *  blocks. */
export function transcriptText(entries: ChatEntry[]): string {
  const blocks: string[] = [];
  for (const e of entries) {
    if (e.kind === "user") {
      blocks.push(`### User\n${e.content}`);
    } else if (e.kind === "notice") {
      blocks.push(`### Notice\n${e.content}`);
    } else if (e.kind === "text") {
      blocks.push(`### Assistant\n${e.content}`);
    } else if (e.kind === "mark") {
      blocks.push(`---\n${e.label}${e.detail ? ` · ${e.detail}` : ""}`);
    } else {
      for (const g of e.groups) {
        for (const tc of g.calls) {
          blocks.push(`### Tool call: ${g.name}\n\`\`\`json\n${formatJson(tc.input)}\n\`\`\``);
          if (tc.result) {
            const label = tc.result.isError ? "Tool error" : "Tool result";
            blocks.push(`### ${label}: ${g.name}\n\`\`\`json\n${formatJson(tc.result.output)}\n\`\`\``);
          }
        }
      }
    }
  }
  return blocks.join("\n\n");
}

export type ToolStatus = "pending" | "ok" | "error" | "unknown";

export const STATUS_TITLE: Record<ToolStatus, string> = {
  pending: "Running",
  ok: "Completed",
  error: "Failed",
  unknown: "No result recorded",
};

/** Roll a group's calls up to one status for the chip's dot. A call with no
 *  result is "pending" only while this is the live tail of the chat;
 *  otherwise the result was never recorded (e.g. the turn died). */
export function groupStatus(g: ToolGroup, live: boolean): ToolStatus {
  let status: ToolStatus = "ok";
  for (const c of g.calls) {
    if (!c.result) return live ? "pending" : "unknown";
    if (c.result.isError) status = "error";
  }
  return status;
}
