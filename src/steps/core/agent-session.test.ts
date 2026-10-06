import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagesOf } from "../../core.js";
import { MemorySessionStore, sessionsCapability, type NewTurn, type SessionsCapability } from "../../session-store.js";
import agent from "./agent.js";

// Agent sessions (plans/agent-sessions.md), OFFLINE: a stand-in Anthropic
// endpoint records every request body, so what a turn SENDS is asserted on
// the wire — the thread's prefix has to be there byte for byte.

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const msgStart = (inputTokens = 100) =>
  sse({
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
const toolUse = (id: string, name: string, input: unknown) =>
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
  sse({ type: "message_stop" });
const textBlock = (text: string, stop = "end_turn") =>
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } }) +
  sse({ type: "message_stop" });

/** `input` = the input_tokens the stand-in reports for the request — how a
 *  test puts the conversation over the compaction mark. */
type Reply =
  | { tool: [string, string, unknown]; input?: number }
  | { text: string; stop?: string; input?: number }
  | { status: number }
  | { hold: Promise<void>; then: Reply };
type Server = { bodies: any[]; calls: () => number; close: () => void };

/** Serve `replies` in order, one per request. */
async function serve(replies: Reply[]): Promise<Server> {
  const bodies: any[] = [];
  let call = 0;
  const answer = async (reply: Reply, res: http.ServerResponse): Promise<void> => {
    if ("hold" in reply) {
      await reply.hold;
      return answer(reply.then, res);
    }
    if ("status" in reply) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(msgStart(reply.input));
    res.write("tool" in reply ? toolUse(...reply.tool) : textBlock(reply.text, reply.stop));
    res.end();
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const reply = replies[call++];
      assert.ok(reply, `unexpected request #${call}`);
      void answer(reply, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
  return { bodies, calls: () => call, close: () => server.close() };
}

const bash = (id: string, command: string, input?: number): Reply => ({ tool: [id, "bash", { command }], ...(input ? { input } : {}) });
const answer = (id: string, text: string): Reply => ({ tool: [id, "final_answer", { answer: text }] });
const summary = (text: string, stop?: string): Reply => ({ text, ...(stop ? { stop } : {}) });
const text = (t: string): Reply => ({ text: t });
const systemOf = (body: any): string => (body.system as any[]).map((b) => b.text).join("");
const textOf = (m: any): string => JSON.stringify(m.content);

describe("agent sessions", () => {
  let cwd = "";
  let store: MemorySessionStore;
  let sessions: SessionsCapability;
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_LLM_PROVIDER", "AI_SDK_LOG_WARNINGS", "STRUT_COMPACT_AT"];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "strut-session-"));
    store = new MemorySessionStore();
    sessions = sessionsCapability(store);
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const run = (cfg: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    agent.run(
      (agent.input as any).parse({
        cwd, system: "sys", prompt: "look around", model: "claude-sonnet-4-5",
        finalAnswer: "Report.", toolFilter: ["bash"], ...cfg,
      }),
      {
        runId: "r1", path: "wf/work", scope: {}, input: undefined, emit: async () => {},
        services: { sessions }, registry: {}, ...ctx,
      } as any,
    ) as Promise<any>;

  const seed = (id: string, record: Partial<NewTurn>) =>
    store.appendTurn(id, {
      system: "sys",
      messages: [{ role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "done" }] }],
      record: { workflow: "wf", runId: "r0", path: "wf/work", provider: "anthropic", model: "anthropic/x", routed: false, ...record },
    });

  it("a second run continues the first: its system prompt, its messages byte for byte, then the new prompt", async () => {
    const s = await serve([
      bash("toolu_1", "echo one"),
      answer("toolu_2", "it is slow"),
      answer("toolu_3", "fixed"),
    ]);
    try {
      const first = await run({ session: "abc", system: "you are careful", prompt: "why is login slow?" }, { runId: "r1", principal: "ann" });
      assert.equal(first.result, "it is slow");
      assert.deepEqual(first.session, { id: "abc", turn: 0, offset: 0 });

      const second = await run({ session: "abc", system: "SOMETHING ELSE", prompt: "fix it" }, { runId: "r2", principal: "bob" });
      assert.equal(second.result, "fixed");
      // Turn 0 appended its prompt, the tool call, the tool result, the answer
      // and its result: that is where turn 1 starts.
      const thread = await store.load("abc");
      assert.deepEqual(second.session, { id: "abc", turn: 1, offset: thread!.turns[0]!.count });
      assert.equal(thread!.messages.length, thread!.turns[0]!.count + thread!.turns[1]!.count);

      // On the wire: the frozen system prompt, and turn 0's last request as
      // the unchanged prefix of turn 1's.
      const [, lastOfFirst, firstOfSecond] = s.bodies;
      assert.equal(systemOf(firstOfSecond), "you are careful");
      const prefix = lastOfFirst.messages as unknown[];
      assert.equal(
        JSON.stringify((firstOfSecond.messages as unknown[]).slice(0, prefix.length)),
        JSON.stringify(prefix),
      );
      const sent = JSON.stringify(firstOfSecond.messages);
      assert.ok(sent.includes("why is login slow?") && sent.includes("it is slow") && sent.includes("toolu_1"));
      const last = (firstOfSecond.messages as any[]).at(-1);
      assert.equal(last.role, "user");
      assert.ok(JSON.stringify(last).includes("fix it"));

      // The run log gets the TURN: the system prompt, this prompt, what it generated.
      const turn = messagesOf(second) as any[];
      assert.deepEqual(turn[0], { role: "system", content: "you are careful" });
      assert.ok(JSON.stringify(turn[1]).includes("fix it"));
      assert.ok(!JSON.stringify(turn).includes("why is login slow?"));
      assert.equal(JSON.stringify(turn.slice(1)), JSON.stringify(thread!.messages.slice(thread!.turns[1]!.offset)));

      // Who made each turn is recorded.
      assert.deepEqual(
        thread!.turns.map((t) => [t.turn, t.runId, t.path, t.principal, t.provider, t.routed]),
        [[0, "r1", "wf/work", "ann", "anthropic", false], [1, "r2", "wf/work", "bob", "anthropic", false]],
      );
      assert.ok(thread!.turns[1]!.context!.used > 0);
      assert.equal(sessions.holder("abc"), undefined);
    } finally {
      s.close();
    }
  });

  it("without `session` nothing changes: no thread, no `session` in the output, no capability needed", async () => {
    const s = await serve([answer("toolu_1", "done")]);
    try {
      const out = await run({}, { services: {} });
      assert.equal(out.result, "done");
      assert.ok(!("session" in out));
      assert.deepEqual(await store.list(), []);
      assert.equal(s.bodies[0].messages.length, 1);
      assert.deepEqual((messagesOf(out) as any[])[0], { role: "system", content: "sys" });
    } finally {
      s.close();
    }
  });

  it("a failed turn appends nothing and lets go of the session; the next turn starts from the same thread", async () => {
    const s = await serve([answer("toolu_1", "first"), { status: 400 }, answer("toolu_3", "third")]);
    try {
      await run({ session: "abc", prompt: "one" });
      const before = JSON.stringify(await store.load("abc"));

      await assert.rejects(run({ session: "abc", prompt: "two" }));
      assert.equal(JSON.stringify(await store.load("abc")), before);
      assert.equal(sessions.holder("abc"), undefined);

      const third = await run({ session: "abc", prompt: "three" });
      assert.equal(third.session.turn, 1);
      const sent = JSON.stringify(s.bodies[2].messages);
      assert.ok(sent.includes("one") && sent.includes("three"));
      assert.ok(!sent.includes("two"), "the failed turn left no trace");
    } finally {
      s.close();
    }
  });

  it("a request refused in the MIDDLE of a turn fails it the same way: the thread is untouched, nothing more is asked", async () => {
    const s = await serve([answer("toolu_1", "first"), bash("toolu_2", "echo two"), { status: 400 }, answer("toolu_4", "third")]);
    try {
      await run({ session: "abc", prompt: "one" });
      const before = JSON.stringify(await store.load("abc"));

      // The provider's words — not a nudge, and an answer committed around it.
      await assert.rejects(
        run({ session: "abc", prompt: "two" }),
        /agent failed after 1 step\(s\): no \(HTTP 400: \{"type":"error","error":\{"type":"invalid_request_error","message":"no"\}\}\)/,
      );
      assert.equal(s.calls(), 3);
      assert.equal(JSON.stringify(await store.load("abc")), before);
      assert.equal(sessions.holder("abc"), undefined);

      const third = await run({ session: "abc", prompt: "three" });
      assert.equal(third.session.turn, 1);
      const sent = JSON.stringify(s.bodies[3].messages);
      assert.ok(sent.includes("one") && sent.includes("three"));
      assert.ok(!sent.includes("two"), "the refused turn left no trace");
    } finally {
      s.close();
    }
  });

  it("one turn at a time: a second turn on a held session fails session_busy, before any request", async () => {
    let letGo!: () => void;
    const hold = new Promise<void>((r) => (letGo = r));
    const s = await serve([{ hold, then: answer("toolu_1", "slow one") }, answer("toolu_2", "after")]);
    try {
      const slow = run({ session: "abc" }, { runId: "r1" });
      while (s.calls() < 1) await new Promise((r) => setTimeout(r, 5));
      await assert.rejects(
        run({ session: "abc" }, { runId: "r2" }),
        /session_busy: session "abc" is in use by run r1 \(wf\/work\)/,
      );
      assert.equal(s.calls(), 1);
      // Another session is free.
      letGo();
      assert.equal((await slow).result, "slow one");
      assert.equal((await run({ session: "abc" }, { runId: "r3" })).session.turn, 1);
    } finally {
      s.close();
    }
  });

  it("refuses an id that looks like a missing template value", async () => {
    const s = await serve([]);
    try {
      await assert.rejects(run({ session: "/review" }), /agent: session "\/review" has an empty segment — is a template value missing\?/);
      await assert.rejects(run({ session: "review-" }), /agent: session "review-" has an invalid segment/);
      await assert.rejects(run({ session: "" }), /agent: session "" is empty/);
      assert.equal(s.calls(), 0);
    } finally {
      s.close();
    }
  });

  it("refuses a sub-agent's session, and a bag without the capability", async () => {
    const s = await serve([]);
    try {
      await assert.rejects(run({ session: "abc" }, { agentTool: true }), /a sub-agent .* cannot take a `session`/);
      await assert.rejects(run({ session: "abc" }, { services: {} }), /session requires the sessions capability/);
      assert.equal(s.calls(), 0);
    } finally {
      s.close();
    }
  });

  it("session_mismatch: the provider and the routing are the first turn's", async () => {
    const s = await serve([]);
    try {
      await seed("other-provider", { provider: "openai" });
      await assert.rejects(
        run({ session: "other-provider" }),
        /session_mismatch: session "other-provider" began on openai \(direct\); this turn resolved to anthropic \(direct\)/,
      );
      await seed("routed", { routed: true });
      await assert.rejects(run({ session: "routed" }), /session_mismatch: .* began on anthropic \(through the gateway\)/);
      assert.equal(s.calls(), 0);
      assert.equal(sessions.holder("other-provider"), undefined);
      assert.equal(sessions.holder("routed"), undefined);
    } finally {
      s.close();
    }
  });

  it("session_full: with compaction off, a thread over 90% of the window is refused before any request", async () => {
    process.env["STRUT_COMPACT_AT"] = "1";
    const s = await serve([answer("toolu_1", "fits")]);
    try {
      await seed("full", { context: { used: 990_000, limit: 1_000_000 } });
      await assert.rejects(run({ session: "full" }), /session_full: session "full" holds 990000 tokens/);
      assert.equal(s.calls(), 0);
      assert.equal(sessions.holder("full"), undefined);

      // The window is the RESOLVED model's, not the one on record.
      await seed("roomy", { context: { used: 100_000, limit: 100_000 } });
      assert.equal((await run({ session: "roomy" })).result, "fits");
    } finally {
      s.close();
    }
  });

  // The forced final-answer turn — the loop ended at its step cap without
  // final_answer — is one more request of the SAME conversation. Under
  // Anthropic's preserved thinking a replayed thinking block is bound to
  // system + tools + the messages before it, and the tools head the prompt
  // cache, so the turn sends the loop's own system and tools (inert: their
  // `execute` removed) and only appends to its messages.
  it("the forced final-answer turn carries the loop's own system and tools, and only appends to its messages", async () => {
    const s = await serve([bash("toolu_1", "echo one"), text("one, in the end")]);
    try {
      const out = await run({ session: "abc", system: "you are careful", maxSteps: 1 });
      assert.equal(out.result, "one, in the end");
      assert.equal(s.calls(), 2);
      const [loop, forced] = s.bodies;
      assert.deepEqual(forced.system, loop.system, "the same system prompt");
      assert.deepEqual(forced.tools, loop.tools, "the same tools");
      assert.deepEqual(forced.tool_choice, loop.tool_choice, "the same tool choice — never a forced one");
      assert.deepEqual((forced.tools as any[]).map((t) => t.name).sort(), ["bash", "final_answer"]);
      // Append-only: the loop's request, its tool call, then its result and the
      // forced prompt — one user turn, as the provider renders them.
      const prefix = loop.messages as unknown[];
      assert.equal(JSON.stringify((forced.messages as unknown[]).slice(0, prefix.length)), JSON.stringify(prefix));
      assert.equal(forced.messages.length, prefix.length + 2);
      const last = JSON.stringify((forced.messages as any[]).at(-1));
      assert.ok(last.includes('"role":"user"') && last.includes("toolu_1") && last.includes("do NOT call any tools"));
      // The thread records the forced turn like any other.
      const thread = await store.load("abc");
      assert.ok(JSON.stringify(thread!.messages.at(-2)).includes("do NOT call any tools"));
      assert.ok(JSON.stringify(thread!.messages.at(-1)).includes("one, in the end"));
    } finally {
      s.close();
    }
  });

  it("a tool call in the forced turn runs nothing, answers nothing, and is not committed to the thread", async () => {
    const s = await serve([bash("toolu_1", "echo one"), bash("toolu_2", "echo stray > stray.txt"), answer("toolu_3", "later")]);
    try {
      const out = await run({ session: "abc", maxSteps: 1 });
      assert.equal(s.calls(), 2, "the stray call gets no result — nothing more is asked");
      assert.equal(out.result, "", "nothing to salvage");
      assert.ok(!existsSync(join(cwd, "stray.txt")), "the stripped tool did not execute");
      // The thread holds the loop's turn only: a tool call without its result
      // would fail the thread's next request.
      const thread = await store.load("abc");
      assert.equal((thread!.messages.at(-1) as any).role, "tool");
      assert.ok(!JSON.stringify(thread!.messages).includes("toolu_2"));
      assert.ok(!JSON.stringify(thread!.messages).includes("do NOT call any tools"));
      // And the next turn continues from it.
      assert.equal((await run({ session: "abc" })).result, "later");
      const sent = JSON.stringify(s.bodies[2].messages);
      assert.ok(sent.includes("toolu_1") && !sent.includes("toolu_2"));
    } finally {
      s.close();
    }
  });

  // ── compaction (plans/compaction.md §3) ──────────────────────────────────

  it("compacts between steps: the summarizer sees the loop's prefix, the next request begins at the summary, the record is whole", async () => {
    // The bash step's call reports 950k input tokens of a 1M window: past the
    // mark, with the tool result in, the loop stops and compacts.
    const s = await serve([bash("toolu_1", "echo one", 950_000), summary("HANDOFF: echoed one; answer next."), answer("toolu_2", "done")]);
    const events: any[] = [];
    try {
      const out = await run({ prompt: "echo then answer" }, { emit: async (e: any) => void events.push(e) });
      assert.equal(out.result, "done");
      assert.equal(out.compactions, 1);
      assert.equal(s.calls(), 3);
      const [first, summarizer, after] = s.bodies;

      // The summarizer's request: the same system and tools as the step
      // before it (the prefix the thinking blocks are bound to), no
      // tool_choice, the conversation with the tool result IN, then the
      // instruction.
      assert.equal(systemOf(summarizer), systemOf(first));
      assert.deepEqual(summarizer.tools, first.tools);
      assert.deepEqual(summarizer.tool_choice, first.tool_choice);
      // Tools + system end in a cache breakpoint of their own on every
      // request: the prefix the request after the boundary can read.
      for (const body of [first, summarizer, after]) {
        assert.deepEqual(body.system.at(-1).cache_control, body.cache_control, JSON.stringify(body.system));
      }
      // (The tool result and the instruction are both user turns: one
      // message on the wire, the result first.)
      const msgs = summarizer.messages as any[];
      assert.equal(msgs.length, 3);
      assert.ok(textOf(msgs[0]).includes("echo then answer"));
      assert.equal(msgs[2].role, "user");
      const closing = textOf(msgs[2]);
      assert.ok(closing.includes("tool_result"), "the tool round is closed before the summary");
      assert.ok(closing.indexOf("tool_result") < closing.indexOf("respond with text only."));
      assert.equal(summarizer.max_tokens, 8000);

      // The request after the boundary: the compaction message alone — the
      // summary, the cwd preamble — nothing earlier.
      assert.equal(after.messages.length, 1);
      assert.equal(after.messages[0].role, "user");
      const compaction = textOf(after.messages[0]);
      assert.match(compaction, /\[compaction\] Compacted 3 messages \(~950020 tokens\)/);
      assert.ok(compaction.includes("HANDOFF: echoed one; answer next."));
      assert.ok(!compaction.includes("echo then answer"));

      // The record is whole: the task, the call, the result, the compaction, the answer.
      const turn = messagesOf(out) as any[];
      assert.deepEqual(turn.map((m) => m.role), ["system", "user", "assistant", "tool", "user", "assistant", "tool"]);
      assert.ok(JSON.stringify(turn[1]).includes("echo then answer"));
      assert.ok(JSON.stringify(turn[4]).includes("[compaction]"));

      // One nested event, like a tool call, after the bash call's.
      const paths = events.filter((e) => e.type === "step.start").map((e) => [e.path, e.stepType]);
      assert.deepEqual(paths, [["wf/work/001-bash", "tool:bash"], ["wf/work/002-compaction", "compaction"]]);
      const end = events.find((e) => e.type === "step.end" && e.stepType === "compaction");
      assert.ok(end.output.includes("HANDOFF"));
    } finally {
      s.close();
    }
  });

  it("a thread over the mark is compacted at open: the summary leads the turn, and the next turn replays from it", async () => {
    const s = await serve([summary("HANDOFF: the thread so far."), answer("toolu_1", "went on"), answer("toolu_2", "and again")]);
    try {
      await seed("long", { context: { used: 990_000, limit: 1_000_000 } });
      const out = await run({ session: "long", prompt: "carry on" }, { runId: "r1" });
      assert.equal(out.result, "went on");
      assert.equal(out.compactions, 1);
      assert.deepEqual(out.session, { id: "long", turn: 1, offset: 2 });

      // The summarizer read the thread (and only the thread), under its system prompt.
      const [summarizer, first] = s.bodies;
      assert.equal(systemOf(summarizer), "sys");
      assert.equal(summarizer.messages.length, 3);
      assert.ok(textOf(summarizer.messages[0]).includes("earlier"));
      assert.ok(textOf(summarizer.messages[2]).includes("Do not call any tools"));

      // This turn's first request: the compaction message, then the task
      // (two user turns, one message on the wire); nothing of the thread.
      assert.deepEqual(first.messages.map((m: any) => m.role), ["user"]);
      const opening = textOf(first.messages[0]);
      assert.ok(opening.includes("[compaction] Compacted 2 messages (~990000 tokens)"));
      assert.ok(opening.indexOf("[compaction]") < opening.indexOf("carry on"));
      assert.ok(!opening.includes('"earlier"'), "nothing of the thread");

      // The line records the boundary: the thread's index of the compaction
      // message (the 2 seeded messages come first), and the next turn replays from it.
      const thread = await store.load("long");
      assert.deepEqual(thread!.turns.map((t) => t.replayFrom), [0, 2]);
      // The seeded 2, then this turn: the summary, the task, the call, its result.
      assert.equal(thread!.messages.length, 2 + 4);
      assert.ok(JSON.stringify(thread!.messages[2]).includes("[compaction]"));

      const again = await run({ session: "long", prompt: "once more" }, { runId: "r2" });
      assert.equal(again.result, "and again");
      assert.ok(!("compactions" in again));
      const next = s.bodies[2];
      assert.ok(textOf(next.messages[0]).includes("[compaction]"));
      assert.ok(!JSON.stringify(next.messages).includes('"earlier"'), "nothing of the thread");
      assert.equal(thread!.turns.length + 1, (await store.load("long"))!.turns.length);
      assert.equal((await store.load("long"))!.replayFrom, 2);
    } finally {
      s.close();
    }
  });

  it("a summarizer that fails, or stops short, is a warning: the loop goes on uncompacted and the step succeeds", async () => {
    const s = await serve([
      bash("toolu_1", "echo one", 950_000),
      { status: 400 }, // the summarizer, refused
      bash("toolu_2", "echo two", 960_000),
      summary("cut off mid", "max_tokens"), // the summarizer again, truncated
      answer("toolu_3", "done anyway"),
    ]);
    try {
      const out = await run({ prompt: "keep going" });
      assert.equal(out.result, "done anyway");
      assert.ok(!("compactions" in out));
      assert.equal(s.calls(), 5);
      // Every real request still carried the whole conversation.
      for (const i of [2, 4]) assert.ok(JSON.stringify(s.bodies[i].messages).includes("keep going"), `request #${i + 1}`);
      assert.ok(!JSON.stringify(s.bodies[4].messages).includes("[compaction]"));
    } finally {
      s.close();
    }
  });

  it("a bash result is capped at the window's headroom: 16k chars on a 200k model", async () => {
    const s = await serve([bash("toolu_1", "head -c 40000 /dev/zero | tr '\\0' a"), answer("toolu_2", "saw it")]);
    try {
      const out = await run({ model: "claude-haiku-4-5", prompt: "read a lot" });
      assert.equal(out.result, "saw it");
      const result = textOf(s.bodies[1].messages[2]);
      assert.ok(result.length < 16_000 + 600, `${result.length} chars`);
      assert.ok(result.includes("chars truncated"));
    } finally {
      s.close();
    }
  });
});
