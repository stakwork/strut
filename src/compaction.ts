/**
 * Compaction — a boundary in an append-only history (plans/compaction.md).
 *
 * Neither the builder chat nor the `agent` step edits what a model has seen:
 * history only grows, so the prompt cache holds and the thinking blocks
 * bound to the prefix stay valid. When the model's window fills, a
 * compaction APPENDS one user message — `[compaction] …`, the model's own
 * summary of everything so far — and records where it sits (`replayFrom`).
 * Every request after that replays from the boundary: a new prefix once,
 * then append-only again. Nothing is edited or deleted; the read endpoints
 * keep serving the whole history.
 *
 * The summary is written by the same model under the SAME request prefix:
 * its system prompt, its tool definitions (without their `execute`, so a
 * stray call cannot run) and its provider options. A thinking block is
 * bound to system + tools + the messages before it, and tools head the cache
 * prefix, so a summarizer that dropped the tools would fail the
 * preserved-thinking check on the blocks it replays and miss the whole
 * cache. `toolChoice: "none"` is not used: the bundled Anthropic provider
 * answers it by sending no tools at all, and a changed `tool_choice`
 * invalidates the messages cache. The prompt's closing sentence does that
 * work, and a summary that ended in a tool call is treated as none.
 *
 * Nothing here imports `ai` — a peer dependency, lazy everywhere — the
 * caller hands in `streamText`.
 */

import { addUsage, emptyUsage, usageFromResult, type TokenUsage } from "./pricing.js";

/** `STRUT_COMPACT_AT`: the share of the model's window past which a
 *  conversation is compacted. `1` disables compaction. */
export const COMPACT_AT_DEFAULT = 0.9;

/** The summarizer's output cap. */
export const SUMMARY_MAX_TOKENS = 8_000;

/** What a step's results must leave room for above the mark: the summary
 *  (`SUMMARY_MAX_TOKENS`) plus one ordinary generation. A tool call is
 *  hundreds of tokens; a big file `create`, a few thousand. */
export const RESERVE_TOKENS = 12_000;

/** A result cap never goes below this: a cap of 0 would mean "no cap" to
 *  the surfaces, and a smaller one is no use to the model. */
export const MIN_RESULT_CHARS = 2_000;

export const COMPACTION_PREFIX = "[compaction]";

/** The mark from the environment: `STRUT_COMPACT_AT`, default 0.9; `1` (or
 *  more) disables. A value that is not a positive number is the default. */
export function compactAtFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["STRUT_COMPACT_AT"];
  if (raw === undefined || raw.trim() === "") return COMPACT_AT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return COMPACT_AT_DEFAULT;
  return Math.min(n, 1);
}

/** Is the conversation past the mark? Never when compaction is off. */
export function overMark(context: { used: number; limit: number }, at: number): boolean {
  return at < 1 && context.limit > 0 && context.used > at * context.limit;
}

/** How many chars one tool result may add: the room above the mark, less
 *  the reserve, at two chars per token (the dense case: code, JSON, logs).
 *  1M at 0.9 → 176k; 200k at 0.9 → 16k; 200k at 0.8 → 56k. */
export function headroomChars(limit: number, at: number): number {
  return Math.max(0, (Math.round((1 - at) * limit) - RESERVE_TOKENS) * 2);
}

/** The cap a surface applies to one tool result: its own ceiling
 *  (`surfaceCap`; `0` = none) bounded by the window's headroom. With
 *  compaction off the surface's ceiling stands alone. */
export function resultCapChars(surfaceCap: number, limit: number, at: number): number {
  if (at >= 1) return surfaceCap;
  const headroom = Math.max(MIN_RESULT_CHARS, headroomChars(limit, at));
  return surfaceCap > 0 ? Math.min(surfaceCap, headroom) : headroom;
}

// ── the summary ────────────────────────────────────────────────────────────

/** What the builder's summary must keep: strut's objects. */
export const CHAT_RETAIN =
  "the workflows and steps published, by name and version; the runs launched, by id, with their status and what they returned; " +
  "the claims left pending and their checks; what the user asked for, in their words";

/** What an agent's summary must keep: the working directory and the files. */
export const AGENT_RETAIN =
  "the working directory and the files read, created or changed, by path; the commands run and what they returned that still matters; " +
  "what was verified and what was not";

/** The one instruction appended to the conversation for the summarizer. The
 *  last sentence is load-bearing: the request still carries the tools. */
export function summarizeInstruction(retain: string): string {
  return (
    "The conversation above is about to be replaced by your summary of it. A model that sees nothing else — not these messages, " +
    "not its own earlier reasoning — will continue the work from your text alone, so write the handoff it needs:\n" +
    "- the task as it was given (verbatim when short), and the latest request;\n" +
    "- what was decided, and why;\n" +
    `- what was done and where — ${retain};\n` +
    "- what is open, failing or unverified, and the next step;\n" +
    "- any question asked of the user that is still unanswered.\n" +
    "Keep names, ids, paths, versions, numbers and exact wording: they cannot be reconstructed. Be complete on these even at the " +
    'cost of length; condense everything else. No preamble and no "here is a summary" — just the handoff. ' +
    "Do not call any tools while writing this summary; respond with text only."
  );
}

export function summarizeMessage(retain: string): { role: "user"; content: string } {
  return { role: "user", content: summarizeInstruction(retain) };
}

/** The model-facing compaction message: a headline the UI parses
 *  (`web/src/notice.ts`), then the summary. */
export function compactionMessage(summary: string, of: { messages: number; tokens: number }): string {
  return (
    `${COMPACTION_PREFIX} Compacted ${of.messages} messages (~${Math.round(of.tokens)} tokens) into the summary below; ` +
    "nothing earlier is in view — continue from it.\n\n" +
    summary
  );
}

export function isCompaction(text: string): boolean {
  return text.startsWith(COMPACTION_PREFIX);
}

const HEADLINE_RE = /^Compacted (\d+) messages \(~(\d+) tokens\)/;

/** The headline's numbers and the summary, or null for anything else. */
export function parseCompaction(text: string): { messages: number; tokens: number; summary: string } | null {
  if (!isCompaction(text)) return null;
  const body = text.slice(COMPACTION_PREFIX.length).trimStart();
  const nl = body.indexOf("\n");
  const headline = nl === -1 ? body : body.slice(0, nl);
  const m = HEADLINE_RE.exec(headline);
  if (!m) return null;
  return { messages: Number(m[1]), tokens: Number(m[2]), summary: nl === -1 ? "" : body.slice(nl + 1).trim() };
}

// ── the summarizer call ────────────────────────────────────────────────────

/** The tool set with every `execute` removed: the same definitions on the
 *  wire, and a call the model makes anyway runs nothing. */
export function stripExecute<T extends Record<string, unknown>>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (t && typeof t === "object" && "execute" in t) {
      const { execute: _execute, ...rest } = t as Record<string, unknown>;
      out[name] = rest;
    } else {
      out[name] = t;
    }
  }
  return out as T;
}

export interface SummarizeOptions {
  /** The AI SDK's `streamText`, imported by the caller. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamText: (opts: any) => {
    fullStream: AsyncIterable<{ type: string; error?: unknown }>;
    text: PromiseLike<string>;
    finishReason: PromiseLike<string>;
    steps: PromiseLike<unknown[]>;
  };
  model: unknown;
  /** The loop's own system prompt, tools and provider options — the prefix. */
  system?: string;
  tools?: Record<string, unknown>;
  providerOptions?: unknown;
  /** The conversation as the request stands. */
  messages: unknown[];
  retain: string;
  abortSignal?: AbortSignal;
}

export interface SummaryResult {
  /** The summary — undefined when the call did not end with one (a tool
   *  call, a cut-off at the cap or the window, an empty reply). */
  summary: string | undefined;
  finishReason: string;
  /** What the call cost; the caller folds it into its own. */
  usage: TokenUsage;
}

/** One streamed call that writes the summary. Throws what the stream
 *  reported (a refused request, an abort); the caller decides what a failed
 *  compaction means — on both surfaces, a warning. */
export async function summarize(opts: SummarizeOptions): Promise<SummaryResult> {
  const result = opts.streamText({
    model: opts.model,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    ...(opts.tools ? { tools: stripExecute(opts.tools) } : {}),
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    maxOutputTokens: SUMMARY_MAX_TOKENS,
    messages: [...opts.messages, summarizeMessage(opts.retain)],
  });
  // Streamed, like every long generation strut makes: a non-streaming
  // connection shows no bytes until the whole summary is written, and
  // intermediaries sever it as idle. An `error` part is how the SDK reports
  // a refused request or an abort on a stream that then closes normally.
  let failure: unknown;
  try {
    for await (const part of result.fullStream) {
      if (part.type === "error") failure ??= part.error ?? new Error("the stream reported an error");
    }
  } catch (e) {
    failure ??= e ?? new Error("the stream broke");
  }
  if (failure !== undefined) throw failure;
  const steps = await result.steps;
  let usage = emptyUsage();
  for (const s of steps as Array<{ usage?: unknown; providerMetadata?: unknown }>) {
    usage = addUsage(usage, usageFromResult(s?.usage, s?.providerMetadata));
  }
  const finishReason = String(await result.finishReason);
  const text = (await result.text).trim();
  const summary = finishReason === "stop" && text ? text : undefined;
  return { summary, finishReason, usage };
}
