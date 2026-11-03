import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePartialJson } from "ai";
import agent, { createReplyTap, streamFailure, REPLY_DELTA_MS } from "./agent.js";

// `stream: true` (plans/private-voice.md §3.4): the reply as `reply.delta`
// run events. OFFLINE: a stand-in Anthropic endpoint streams the model's
// reply in pieces (real aieo + AI SDK path), and the tap is also driven with
// the part sequences other providers produce.

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const msgStart = sse({
  type: "message_start",
  message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
});
const tail = (stop: string) =>
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }) +
  sse({ type: "message_stop" });
/** A tool call whose input JSON arrives in `pieces`. */
const toolPieces = (id: string, name: string, pieces: string[]) =>
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  pieces.map((p) => sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } })).join("") +
  tail("tool_use");
const textPieces = (pieces: string[]) =>
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  pieces.map((t) => sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })).join("") +
  tail("end_turn");

/** A stand-in Anthropic endpoint: request `n` gets `replies[n]` as SSE.
 *  After each `content_block_delta` of reply `n` it waits on `gate(n)`, if
 *  that returns a promise, before it sends the rest. */
async function serve(replies: string[], gate?: (reply: number) => Promise<void> | undefined) {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const reply = n++;
      const parts = replies[reply]!.split("\n\n").filter(Boolean).map((p) => p + "\n\n");
      res.write(msgStart);
      for (const part of parts) {
        res.write(part);
        if (part.startsWith("event: content_block_delta")) await gate?.(reply);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
  return { close: () => server.close() };
}

const isDelta = (e: any) => e.type === "reply.delta";
/** A gate that holds the endpoint until the tap has written one more
 *  `reply.delta` than at its last opening: each piece is then its own event,
 *  whatever the machine's load — the 50 ms batch has passed for every piece
 *  before the next is sent. */
const onePiecePerDelta = (events: any[]) => {
  let seen = 0;
  return async () => {
    for (let i = 0; i < 1000 && events.filter(isDelta).length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    seen = events.filter(isDelta).length;
  };
};

describe("agent step: stream: true", () => {
  let cwd = "";
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AI_SDK_LOG_WARNINGS"];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "strut-stream-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!);
  });

  const schema = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" }, start: { type: "object", properties: { brief: { type: "string" } } } },
  };
  const run = async (cfg: Record<string, unknown>, events: any[] = []) => {
    const out = (await agent.run(
      (agent.input as any).parse({ cwd, system: "s", prompt: "hi", model: "claude-sonnet-4-5", toolFilter: ["none"], reasoning: "provider-default", ...cfg }),
      { runId: "r1", path: "wf/turn", scope: {}, input: undefined, emit: async (e: any) => void events.push(e), services: {}, registry: {} } as any,
    )) as any;
    return { out, deltas: events.filter(isDelta) };
  };

  it("schema mode, Anthropic-style input_json_delta chunks: `text` streams in pieces, once each, before the rest of the object", async () => {
    const json = JSON.stringify({ text: "Looking into it now, one moment.", start: { brief: "find the bug" } });
    const cut = json.indexOf("into");
    const pieces = [json.slice(0, 12), json.slice(12, cut + 2), json.slice(cut + 2, cut + 20), json.slice(cut + 20)];
    const events: any[] = [];
    const s = await serve([toolPieces("toolu_1", "final_answer", pieces)], onePiecePerDelta(events));
    try {
      const { out, deltas } = await run({ schema, stream: true }, events);
      assert.equal(out.object.text, "Looking into it now, one moment.");
      assert.ok(deltas.every((d) => d.path === "wf/turn" && d.call === "toolu_1"));
      // Each piece adds to `text`, so each is one event: the provider streamed
      // the call's input in pieces, and so does the tap.
      assert.deepEqual(deltas.map((d) => d.text), ["Loo", "king in", "to it now, one mom", "ent."], "the pieces add up to the text, and nothing of `start`");
      assert.ok(deltas.every((d) => !d.reset));
    } finally {
      s.close();
    }
  });

  it("text mode: assistant text streams as deltas at the step's path", async () => {
    const events: any[] = [];
    const s = await serve([textPieces(["The ", "answer ", "is ", "42."])], onePiecePerDelta(events));
    try {
      const { out, deltas } = await run({ stream: true }, events);
      assert.equal(out.result, "The answer is 42.");
      assert.deepEqual(deltas.map((d) => d.text), ["The ", "answer ", "is ", "42."]);
      assert.ok(deltas.every((d) => d.call === "text"));
    } finally {
      s.close();
    }
  });

  it("schema mode, the FORCED final-answer turn (no final_answer call, budget spent): its object streams as text-delta JSON, and `text` is tapped under a call of its own", async () => {
    const pieces = ['{"text":"Forced', " reply", ' here."}'];
    const events: any[] = [];
    const gate = onePiecePerDelta(events);
    // Request 1: the loop's one step, prose and no tool call (schema mode
    // never taps it). Request 2: the forced turn, the object as text.
    const s = await serve([textPieces(["Let me think about it."]), textPieces(pieces)], (n) => (n === 1 ? gate() : undefined));
    try {
      const { out, deltas } = await run({ schema, stream: true, maxSteps: 1 }, events);
      assert.equal(out.object.text, "Forced reply here.");
      assert.deepEqual(deltas.map((d) => d.text), ["Forced", " reply", " here."], "the prose before is not the reply");
      assert.equal(new Set(deltas.map((d) => d.call)).size, 1);
      assert.ok(!["text", "toolu_1"].includes(deltas[0].call), deltas[0].call);
      assert.ok(deltas.every((d) => !d.reset), "nothing was said before it");
    } finally {
      s.close();
    }
  });

  it("off by default: no reply.delta in the log", async () => {
    const s = await serve([toolPieces("toolu_1", "final_answer", [JSON.stringify({ text: "hello" })])]);
    try {
      const { out, deltas } = await run({ schema });
      assert.equal(out.object.text, "hello");
      assert.deepEqual(deltas, []);
    } finally {
      s.close();
    }
  });
});

describe("the reply tap", () => {
  const stream = (parts: any[], gapMs = 0) => ({
    stream: (async function* () {
      for (const p of parts) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        yield p;
      }
    })(),
  });
  const tapOf = (mode: "schema" | "text", batchMs?: number) => {
    const events: any[] = [];
    const tap = createReplyTap({ emit: async (e) => void events.push(e), path: "wf/turn", mode, parsePartialJson: parsePartialJson as any, ...(batchMs ? { batchMs } : {}) });
    return { events, tap };
  };
  const delta = (id: string, d: string) => ({ type: "tool-input-delta", id, delta: d });
  const start = (id: string, toolName = "final_answer") => ({ type: "tool-input-start", id, toolName });

  it("OpenAI-compatible / vLLM style: the AI SDK hands `tool_calls[].function.arguments` fragments over as the same tool-input parts, and they stream; a parser that holds the arguments back gives ONE delta", async () => {
    const pieces = ['{"te', 'xt":"Sure, ', "I'll check ", 'that.","start":{"brief":"x"}}'];
    const a = tapOf("schema");
    await streamFailure(stream([start("call_0"), ...pieces.map((p) => delta("call_0", p))]), a.tap);
    assert.equal(a.events.map((e) => e.text).join(""), "Sure, I'll check that.");

    // Arguments held back until complete (some vLLM tool parsers): one lump.
    const b = tapOf("schema");
    await streamFailure(stream([start("call_0"), delta("call_0", pieces.join(""))]), b.tap);
    assert.deepEqual(b.events.map((e) => e.text), ["Sure, I'll check that."]);
  });

  it("only what is new is passed on: escapes and a half-written `text` never repeat or drop characters", async () => {
    const full = JSON.stringify({ text: 'She said "hi"\nthen left — ok' });
    const { events, tap } = tapOf("schema");
    const parts = [start("c")];
    for (let i = 0; i < full.length; i += 3) parts.push(delta("c", full.slice(i, i + 3)));
    await streamFailure(stream(parts), tap);
    assert.equal(events.map((e) => e.text).join(""), 'She said "hi"\nthen left — ok');
  });

  it("a new final_answer call after text was said starts with reset: true; a first call never does", async () => {
    const { events, tap } = tapOf("schema");
    await streamFailure(
      stream([start("a"), delta("a", '{"text":"first'), start("b"), delta("b", '{"text":"second"}')]),
      tap,
    );
    assert.deepEqual(events.map((e) => [e.call, e.text, e.reset ?? false]), [["a", "first", false], ["b", "second", true]]);
  });

  it("other tools' input and model chatter are not the reply (schema mode)", async () => {
    const { events, tap } = tapOf("schema");
    await streamFailure(stream([start("t", "job_start"), delta("t", '{"text":"x"}'), { type: "text-delta", text: "thinking aloud" }]), tap);
    assert.deepEqual(events, []);
  });

  it("batched: deltas inside one batch window share an event, and the stream's end flushes the rest", async () => {
    // A window no test outlives: nothing is written before the stream ends.
    const { events, tap } = tapOf("text", 60_000);
    const parts = Array.from({ length: 10 }, (_, i) => ({ type: "text-delta", text: `w${i} ` }));
    await streamFailure(stream(parts), tap);
    assert.deepEqual(events.map((e) => e.text), [parts.map((p) => p.text).join("")]);
    assert.ok(REPLY_DELTA_MS <= 50, "the default window is short enough to speak from");
  });

  it("a batch is written once its window passes, before the stream ends", async () => {
    const { events, tap } = tapOf("text", 5);
    const parts = (async function* () {
      yield { type: "text-delta", text: "Sure, " };
      // The next piece comes only after the first one is in the log.
      for (let i = 0; i < 1000 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      yield { type: "text-delta", text: "on it." };
    })();
    await streamFailure({ stream: parts }, tap);
    assert.deepEqual(events.map((e) => e.text), ["Sure, ", "on it."]);
  });

  it("the forced answer's object streamed as text (`object()`): its JSON read for `text` under a call of its own, `reset` after an earlier answer was said, and only for that stream", async () => {
    const { events, tap } = tapOf("schema");
    await streamFailure(stream([start("a"), delta("a", '{"text":"first')]), tap);
    tap.object();
    await streamFailure(stream([{ type: "text-delta", text: '{"te' }, { type: "text-delta", text: 'xt":"second"}' }]), tap);
    // The next stream's text is chatter again.
    await streamFailure(stream([{ type: "text-delta", text: '{"text":"stray"}' }]), tap);
    assert.deepEqual(events.map((e) => [e.call, e.text, e.reset ?? false]), [["a", "first", false], ["answer-1", "second", true]]);

    // Text mode has no object to read: its text-delta is the reply already.
    const t = tapOf("text");
    t.tap.object();
    await streamFailure(stream([{ type: "text-delta", text: "plain" }]), t.tap);
    assert.deepEqual(t.events.map((e) => [e.call, e.text]), [["text", "plain"]]);
  });

  it("an error part still flushes what was said", async () => {
    const { events, tap } = tapOf("text");
    const failure = await streamFailure(stream([{ type: "text-delta", text: "half a rep" }, { type: "error", error: new Error("cut") }]), tap);
    assert.equal((failure as Error).message, "cut");
    assert.equal(events.map((e) => e.text).join(""), "half a rep");
  });
});
