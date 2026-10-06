import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_RETAIN,
  COMPACT_AT_DEFAULT,
  MIN_RESULT_CHARS,
  RESERVE_TOKENS,
  SUMMARY_MAX_TOKENS,
  compactAtFromEnv,
  compactionMessage,
  headroomChars,
  isCompaction,
  overMark,
  parseCompaction,
  resultCapChars,
  stripExecute,
  summarize,
  summarizeInstruction,
} from "./compaction.js";

describe("compaction: the mark", () => {
  it("reads STRUT_COMPACT_AT: default 0.9, ≥ 1 disables, nonsense is the default", () => {
    assert.equal(compactAtFromEnv({}), COMPACT_AT_DEFAULT);
    assert.equal(compactAtFromEnv({ STRUT_COMPACT_AT: "" }), COMPACT_AT_DEFAULT);
    assert.equal(compactAtFromEnv({ STRUT_COMPACT_AT: "0.8" }), 0.8);
    assert.equal(compactAtFromEnv({ STRUT_COMPACT_AT: "1" }), 1);
    assert.equal(compactAtFromEnv({ STRUT_COMPACT_AT: "7" }), 1);
    assert.equal(compactAtFromEnv({ STRUT_COMPACT_AT: "0" }), COMPACT_AT_DEFAULT);
    assert.equal(compactAtFromEnv({ STRUT_COMPACT_AT: "lots" }), COMPACT_AT_DEFAULT);
  });

  it("overMark: past the share of the window, never when disabled", () => {
    assert.equal(overMark({ used: 900_001, limit: 1_000_000 }, 0.9), true);
    assert.equal(overMark({ used: 900_000, limit: 1_000_000 }, 0.9), false);
    assert.equal(overMark({ used: 999_999, limit: 1_000_000 }, 1), false);
    assert.equal(overMark({ used: 5, limit: 0 }, 0.9), false);
  });

  it("headroom: the gap above the mark less the reserve, two chars per token", () => {
    assert.equal(headroomChars(1_000_000, 0.9), (100_000 - RESERVE_TOKENS) * 2);
    assert.equal(headroomChars(1_000_000, 0.9), 176_000);
    assert.equal(headroomChars(200_000, 0.9), 16_000);
    assert.equal(headroomChars(200_000, 0.8), 56_000);
    // A window too small for the reserve has no headroom, never a negative one.
    assert.equal(headroomChars(10_000, 0.9), 0);
  });

  it("resultCapChars: the surface's ceiling bounded by the headroom; the ceiling alone when compaction is off", () => {
    assert.equal(resultCapChars(500_000, 1_000_000, 0.9), 176_000);
    assert.equal(resultCapChars(50_000, 1_000_000, 0.9), 50_000);
    assert.equal(resultCapChars(50_000, 200_000, 0.9), 16_000);
    assert.equal(resultCapChars(500_000, 1_000_000, 1), 500_000);
    // `0` (no ceiling) still gets the window's cap while compaction is on.
    assert.equal(resultCapChars(0, 200_000, 0.9), 16_000);
    assert.equal(resultCapChars(0, 200_000, 1), 0);
    // Never below the floor: a cap of 0 would read as "no cap".
    assert.equal(resultCapChars(500_000, 10_000, 0.9), MIN_RESULT_CHARS);
  });
});

describe("compaction: the message", () => {
  it("round-trips the headline and the summary", () => {
    const text = compactionMessage("Task: build a clip workflow.\n\nDone: v3 published.", { messages: 40, tokens: 612_345.4 });
    assert.ok(isCompaction(text));
    assert.ok(text.startsWith("[compaction] Compacted 40 messages (~612345 tokens)"));
    assert.deepEqual(parseCompaction(text), {
      messages: 40,
      tokens: 612_345,
      summary: "Task: build a clip workflow.\n\nDone: v3 published.",
    });
    assert.equal(parseCompaction("[run-notification] x"), null);
    assert.equal(parseCompaction("[compaction] something else"), null);
  });

  it("the instruction names what to keep and ends by forbidding tool calls", () => {
    const s = summarizeInstruction(AGENT_RETAIN);
    assert.ok(s.includes(AGENT_RETAIN));
    assert.ok(s.endsWith("Do not call any tools while writing this summary; respond with text only."));
  });
});

describe("compaction: the summarizer call", () => {
  /** A stand-in `streamText`: records what it was called with, answers as told. */
  const fake = (reply: { text: string; finishReason?: string; error?: unknown; usage?: unknown }) => {
    const calls: any[] = [];
    const streamText = (opts: any) => {
      calls.push(opts);
      return {
        fullStream: (async function* () {
          if (reply.error !== undefined) yield { type: "error", error: reply.error };
          yield { type: "text-delta", text: reply.text };
        })(),
        text: Promise.resolve(reply.text),
        finishReason: Promise.resolve(reply.finishReason ?? "stop"),
        steps: Promise.resolve([{ usage: reply.usage ?? { inputTokens: 1000, outputTokens: 50 } }]),
      };
    };
    return { calls, streamText };
  };
  const tools = {
    bash: { description: "run", inputSchema: {}, execute: async () => "ran" },
    web_search: { type: "provider", id: "anthropic.web_search" },
  };

  it("sends the same system, tools (without execute) and provider options, the conversation, then the instruction", async () => {
    const { calls, streamText } = fake({ text: "  the handoff  " });
    const got = await summarize({
      streamText: streamText as any,
      model: "M",
      system: "sys",
      tools,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      messages: [{ role: "user", content: "task" }, { role: "assistant", content: "ok" }],
      retain: AGENT_RETAIN,
    });
    assert.equal(got.summary, "the handoff");
    assert.equal(got.finishReason, "stop");
    assert.deepEqual([got.usage.inputTokens, got.usage.outputTokens], [1000, 50]);

    const [opts] = calls;
    assert.equal(opts.model, "M");
    assert.equal(opts.system, "sys");
    assert.deepEqual(opts.providerOptions, { anthropic: { cacheControl: { type: "ephemeral" } } });
    assert.equal(opts.maxOutputTokens, SUMMARY_MAX_TOKENS);
    assert.equal("toolChoice" in opts, false);
    assert.deepEqual(Object.keys(opts.tools), ["bash", "web_search"]);
    assert.equal("execute" in opts.tools.bash, false);
    assert.equal(opts.tools.bash.description, "run");
    assert.deepEqual(opts.tools.web_search, tools.web_search);
    // The caller's tools are untouched.
    assert.equal(typeof tools.bash.execute, "function");
    assert.equal(opts.messages.length, 3);
    assert.equal(opts.messages[2].role, "user");
    assert.ok(opts.messages[2].content.endsWith("respond with text only."));
  });

  it("a call that ended in a tool call, at the cap, or empty is no summary — the usage still counts", async () => {
    for (const reply of [{ text: "", finishReason: "tool-calls" }, { text: "half a sum", finishReason: "length" }, { text: "   " }]) {
      const got = await summarize({ streamText: fake(reply).streamText as any, model: "M", messages: [], retain: "x" });
      assert.equal(got.summary, undefined, JSON.stringify(reply));
      assert.equal(got.usage.inputTokens, 1000);
    }
  });

  it("throws what the stream reported", async () => {
    const { streamText } = fake({ text: "", error: new Error("refused") });
    await assert.rejects(() => summarize({ streamText: streamText as any, model: "M", messages: [], retain: "x" }), /refused/);
  });

  it("stripExecute leaves everything but execute", () => {
    const out = stripExecute({ a: { x: 1, execute: () => 1 }, b: { y: 2 }, c: 3 as unknown });
    assert.deepEqual(out, { a: { x: 1 }, b: { y: 2 }, c: 3 });
  });
});
