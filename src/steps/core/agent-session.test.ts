import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, flow, messagesOf, step, withStop } from "../../core.js";
import { RunController } from "../../run-control.js";
import { runWorkflow } from "../../runner.js";
import { MemorySessionStore, sessionsCapability, type NewTurn, type SessionsCapability } from "../../session-store.js";
import { MemoryRunStore } from "../../store.js";
import { createRegistry } from "../registry.js";
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
const call = (id: string, name: string, input: unknown): Reply => ({ tool: [id, name, input] });
const systemOf = (body: any): string => (body.system as any[]).map((b) => b.text).join("");
const textOf = (m: any): string => JSON.stringify(m.content);

// Tool-steps for `agentTools`: one that ends the turn (a device that has not
// answered), one that does not — its output's `stop` field is a field, not
// the marker.
const askMac = defineStep({
  type: "dev/ask-mac",
  description: "Ask the Mac.",
  input: z.object({ kind: z.string() }),
  output: z.any(),
  async run() {
    return withStop({ status: "pending" });
  },
});
const recall = defineStep({
  type: "dev/recall",
  description: "Recall a fact.",
  input: z.object({ q: z.string() }),
  output: z.any(),
  async run({ q }) {
    return { facts: [`${q}: 12 May`], stop: true };
  },
});
const registry = { "dev/ask-mac": askMac, "dev/recall": recall };

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
        finalAnswer: "Report.", toolFilter: ["bash"], reasoning: "provider-default", ...cfg,
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

  it("a turn a force-cancel abandoned lets go of the session when its run ends; the next turn starts", async () => {
    let reached!: () => void;
    const inTool = new Promise<void>((r) => (reached = r));
    const hang = defineStep({
      type: "dev/hang",
      description: "Wait.",
      input: z.object({}),
      output: z.any(),
      run: () => (reached(), new Promise(() => {})), // never returns
    });
    const s = await serve([call("toolu_1", "dev_hang", {}), answer("toolu_2", "after")]);
    try {
      const wf = flow("wf", {
        input: z.any(),
        steps: [
          step("work", "agent", {
            cwd, system: "sys", prompt: "look around", model: "claude-sonnet-4-5", finalAnswer: "Report.",
            toolFilter: ["none"], agentTools: ["dev/hang"], reasoning: "provider-default", session: "abc",
          }),
        ],
      });
      const controller = new RunController("r1", "wf");
      const running = runWorkflow(wf, {}, await createRegistry([hang]), {
        runId: "r1", store: new MemoryRunStore(), controller, services: { sessions },
      });
      await inTool;
      assert.deepEqual(sessions.holder("abc"), { runId: "r1", path: "wf/work" });
      controller.force();
      assert.equal((await running).status, "cancelled");
      assert.equal(sessions.holder("abc"), undefined);
      // The abandoned turn committed nothing: the next one is turn 0.
      assert.equal((await run({ session: "abc", prompt: "two" }, { runId: "r2" })).session.turn, 0);
    } finally {
      s.close();
    }
  });

  it("an abandoned turn that wakes after its run let go of the session commits nothing", async () => {
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    let reached!: () => void;
    const inTool = new Promise<void>((r) => (reached = r));
    const wait = defineStep({
      type: "dev/wait",
      description: "Wait.",
      input: z.object({}),
      output: z.any(),
      async run() {
        reached();
        await gate;
        return { ok: true };
      },
    });
    const s = await serve([call("toolu_1", "dev_wait", {}), answer("toolu_2", "after"), answer("toolu_3", "stale")]);
    const disposers: Array<() => unknown> = [];
    try {
      const abandoned = run(
        { session: "abc", toolFilter: ["none"], agentTools: ["dev/wait"] },
        { runId: "r1", registry: { "dev/wait": wait }, onRunEnd: (fn: () => unknown) => void disposers.push(fn) },
      );
      await inTool;
      // What the runner does once a force-cancel has finalized r1.
      for (const dispose of disposers) await dispose();
      assert.equal(sessions.holder("abc"), undefined);
      assert.equal((await run({ session: "abc", prompt: "two" }, { runId: "r2" })).result, "after");

      letGo();
      await assert.rejects(abandoned, /session_released: session "abc" was let go when run r1 ended/);
      assert.deepEqual((await store.load("abc"))!.turns.map((t) => t.runId), ["r2"]);
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

  it("a thread may change provider: the next turn replays it on the new one", async () => {
    const s = await serve([answer("toolu_1", "carried on")]);
    try {
      await store.appendTurn("switch", {
        system: "sys",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: [{ type: "reasoning", text: "openai's thinking" }, { type: "text", text: "done" }] },
        ],
        record: { workflow: "wf", runId: "r0", path: "wf/work", provider: "openai", model: "openai/x", routed: false },
      });
      const out = await run({ session: "switch" });
      assert.equal(out.result, "carried on");
      const sent = JSON.stringify(s.bodies[0].messages);
      assert.ok(sent.includes("earlier") && sent.includes("done"));
      assert.ok(!sent.includes("openai's thinking"), "thinking another provider wrote, without its signature, is not sent");
      const thread = await store.load("switch");
      assert.deepEqual(thread!.turns.map((t) => t.provider), ["openai", "anthropic"]);
    } finally {
      s.close();
    }
  });

  it("session_mismatch: the routing is the first turn's, and another provider's server-run tool calls stay with it", async () => {
    const s = await serve([answer("toolu_1", "past it")]);
    try {
      await seed("routed", { routed: true });
      await assert.rejects(run({ session: "routed" }), /session_mismatch: session "routed" began through the gateway; this turn goes direct/);
      assert.equal(sessions.holder("routed"), undefined);

      const native = {
        system: "sys",
        messages: [
          { role: "user", content: "search" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "ws_1", toolName: "web_search", input: { query: "q" }, providerExecuted: true },
              { type: "tool-result", toolCallId: "ws_1", toolName: "web_search", output: { type: "json", value: [] } },
            ],
          },
        ],
        record: { workflow: "wf", runId: "r0", path: "wf/work", provider: "openai" as const, model: "openai/x", routed: false },
      };
      await store.appendTurn("native", native);
      await assert.rejects(
        run({ session: "native" }),
        /session_mismatch: session "native" holds openai's own server-run tool calls \(turn 0\), which anthropic cannot read/,
      );
      assert.equal(s.calls(), 0);
      assert.equal(sessions.holder("native"), undefined);

      // A compaction left them behind the replay boundary: never sent again.
      await store.appendTurn("compacted", native);
      await store.appendTurn("compacted", {
        system: "sys",
        messages: [{ role: "user", content: "[compaction] it searched" }],
        record: { workflow: "wf", runId: "r1", path: "wf/work", provider: "openai", model: "openai/x", routed: false, replayFrom: 2 },
      });
      assert.equal((await run({ session: "compacted" })).result, "past it");
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

  it("reasoning defaults to medium, and the loop, the summarizer and the forced answer all send it", async () => {
    // `reasoning: undefined` drops the helper's pin, so the schema's default applies.
    const current = { model: "claude-sonnet-5-5", reasoning: undefined };
    // A compacting run (loop → summarizer → loop), then a capped one (loop → forced answer).
    for (const [replies, cfg] of [
      [[bash("toolu_1", "echo one", 950_000), summary("HANDOFF: echoed one."), answer("toolu_2", "done")], {}],
      [[bash("toolu_1", "echo one"), text("one, in the end")], { maxSteps: 1 }],
    ] as const) {
      const s = await serve([...replies]);
      try {
        await run({ ...current, ...cfg });
        assert.equal(s.calls(), replies.length);
        for (const body of s.bodies) {
          assert.equal(body.output_config?.effort, "medium", JSON.stringify(body.output_config));
          assert.equal(body.thinking?.type, "adaptive");
        }
      } finally {
        s.close();
      }
    }
  });

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

  // ── a tool that ends the turn ────────────────────────────────────────────

  it("a tool output marked withStop ends the turn after that round: one answer turn with inert tools, no nudge", async () => {
    const s = await serve([call("toolu_1", "dev_ask_mac", { kind: "chats.unseen" }), text("Waiting for your Mac.")]);
    const events: any[] = [];
    try {
      const out = await run(
        { session: "abc", toolFilter: ["none"], agentTools: ["dev/ask-mac"] },
        { registry, emit: async (e: any) => void events.push(e) },
      );
      assert.equal(out.result, "Waiting for your Mac.");
      assert.deepEqual(out.stopped, { tool: "dev_ask_mac" });
      assert.equal(s.calls(), 2, "the loop stopped; nothing was nudged");
      const [loop, answerTurn] = s.bodies;
      // The answer turn is the loop's own prefix (tools inert), then the stop prompt.
      assert.deepEqual(answerTurn.tools, loop.tools);
      assert.deepEqual(answerTurn.system, loop.system);
      const last = JSON.stringify((answerTurn.messages as any[]).at(-1));
      assert.ok(last.includes("toolu_1") && last.includes("ended this turn") && last.includes("do NOT call any tools"));
      assert.ok(last.includes("pending"), "the tool's result is in");
      assert.ok(!last.includes("\"stop\"") && !last.includes("_stop"), "the marker is not in what the model sees");
      // The tool ran once and shows as a run event; the thread is committed.
      assert.deepEqual(events.filter((e) => e.type === "step.start").map((e) => e.stepType), ["tool:dev_ask_mac"]);
      assert.equal((await store.load("abc"))!.turns.length, 1);
    } finally {
      s.close();
    }
  });

  it("after a stop, a tool the model calls anyway runs nothing; plain-text mode answers the same way", async () => {
    let ran = 0;
    const counted = { ...askMac, async run() { ran++; return withStop({ status: "pending" }); } };
    const s = await serve([
      call("toolu_1", "dev_ask_mac", { kind: "chats.unseen" }),
      call("toolu_2", "dev_ask_mac", { kind: "chats.unseen" }),
      call("toolu_3", "dev_ask_mac", { kind: "chats.list" }),
      text("Still waiting."),
    ]);
    try {
      const cfg = { toolFilter: ["none"], agentTools: ["dev/ask-mac"] };
      const ctx = { registry: { "dev/ask-mac": counted } };
      const out = await run(cfg, ctx);
      assert.equal(s.calls(), 2);
      assert.equal(ran, 1, "the call in the answer turn never executed");
      assert.equal(out.result, "");
      // Plain-text mode (no finalAnswer, no schema).
      const plain = await run({ ...cfg, finalAnswer: undefined }, ctx);
      assert.equal(plain.result, "Still waiting.");
      assert.deepEqual(plain.stopped, { tool: "dev_ask_mac" });
      assert.equal(s.calls(), 4);
    } finally {
      s.close();
    }
  });

  it("a stop inside the premature-stop nudge ends that loop too", async () => {
    const s = await serve([text("Let me check your chats."), call("toolu_2", "dev_ask_mac", { kind: "chats.unseen" }), text("Waiting for your Mac.")]);
    try {
      const out = await run({ toolFilter: ["none"], agentTools: ["dev/ask-mac"] }, { registry });
      assert.equal(s.calls(), 3, "the nudge's loop stopped at the stop; the answer turn followed");
      assert.equal(out.result, "Waiting for your Mac.");
      assert.deepEqual(out.stopped, { tool: "dev_ask_mac" });
      assert.ok(JSON.stringify((s.bodies[2].messages as any[]).at(-1)).includes("ended this turn"));
    } finally {
      s.close();
    }
  });

  it("an unmarked output leaves the loop alone, a `stop: true` field of its own included", async () => {
    const s = await serve([call("toolu_1", "dev_recall", { q: "Kate" }), answer("toolu_2", "12 May")]);
    try {
      const out = await run({ toolFilter: ["none"], agentTools: ["dev/recall"] }, { registry });
      assert.equal(out.result, "12 May");
      assert.ok(!("stopped" in out));
      assert.equal(s.calls(), 2);
    } finally {
      s.close();
    }
  });

  // ── retain (compaction) ──────────────────────────────────────────────────

  it("retain replaces what the summary is told to keep", async () => {
    const s = await serve([bash("toolu_1", "echo one", 950_000), summary("HANDOFF."), answer("toolu_2", "done")]);
    try {
      const retain = "the chats read, by chat id; message uuids and View links, word for word";
      await run({ prompt: "catch me up", retain });
      const instruction = textOf((s.bodies[1].messages as any[]).at(-1));
      assert.ok(instruction.includes(retain));
      assert.ok(!instruction.includes("the commands run"), "not the default's");
      // Without it, the default.
      const s2 = await serve([bash("toolu_1", "echo one", 950_000), summary("HANDOFF."), answer("toolu_2", "done")]);
      try {
        await run({ prompt: "catch me up" });
        assert.ok(textOf((s2.bodies[1].messages as any[]).at(-1)).includes("the commands run"));
      } finally {
        s2.close();
      }
    } finally {
      s.close();
    }
  });

  // ── no built-ins ─────────────────────────────────────────────────────────

  it("toolFilter: ['none'] needs neither git nor rg: an agent with only agentTools runs on an empty PATH", async () => {
    const s = await serve([call("toolu_1", "dev_recall", { q: "Kate" }), answer("toolu_2", "12 May")]);
    const path = process.env["PATH"];
    const empty = mkdtempSync(join(tmpdir(), "strut-nopath-"));
    process.env["PATH"] = empty;
    try {
      const out = await run({ session: "abc", toolFilter: ["none"], agentTools: ["dev/recall"] }, { registry });
      assert.equal(out.result, "12 May");
      assert.deepEqual((s.bodies[0].tools as any[]).map((t) => t.name).sort(), ["dev_recall", "final_answer"]);
    } finally {
      process.env["PATH"] = path;
      rmSync(empty, { recursive: true, force: true });
      s.close();
    }
  });
  // ── proposals (plans/proposals.md) ───────────────────────────────────────

  it("a tool in `approve` records a proposal instead of running; the next turn of the thread is told the decision once", async () => {
    const { proposalsCapability, decideProposal, proposalsRoot, listProposals, PROPOSAL_RESULT_PREFIX } = await import("../../proposals.js");
    const ran: unknown[] = [];
    const write = defineStep({
      type: "dev/write",
      description: "Write a thing. Details follow.",
      input: z.object({ name: z.string() }),
      output: z.any(),
      async run(cfg) {
        ran.push(cfg);
        return { wrote: cfg.name };
      },
    });
    const reg = { ...registry, "dev/write": write };
    const proposals = proposalsCapability(cwd);
    const services = { sessions, proposals };
    const s = await serve([call("toolu_1", "dev_write", { name: "x", rationale: "it is missing" }), answer("toolu_2", "proposed it")]);
    try {
      const out = await run({ session: "abc", toolFilter: ["none"], agentTools: ["dev/write"], approve: ["dev/write"] }, { registry: reg, services, job: "j1" });
      assert.equal(out.result, "proposed it");
      assert.deepEqual(ran, [], "the gated step did not run");
      const tool = (s.bodies[0].tools as any[]).find((t) => t.name === "dev_write");
      assert.ok(tool.description.includes("PROPOSED, not run"));
      assert.ok("rationale" in tool.input_schema.properties);
      const [rec] = await listProposals(proposalsRoot(cwd));
      assert.ok(rec);
      assert.deepEqual(rec!.input, { name: "x" });
      assert.equal(rec!.rationale, "it is missing");
      assert.deepEqual([rec!.by.session, rec!.by.job, rec!.by.runId], ["abc", "j1", "r1"]);
      // The model read the pending result, nothing more.
      const seen = textOf((s.bodies[1].messages as any[]).at(-1));
      assert.ok(/status[^a-z]{0,6}pending/.test(seen) && seen.includes(rec!.id), seen);
    } finally {
      s.close();
    }

    const decided = await decideProposal(proposalsRoot(cwd), (await listProposals(proposalsRoot(cwd)))[0]!.id, { action: "accept", by: "bob" }, { registry: reg, services });
    assert.equal((decided.body as any).status, "applied");
    assert.deepEqual(ran, [{ name: "x" }]);

    // The next turn opens with the decision, before the prompt; the one after does not repeat it.
    const s2 = await serve([answer("toolu_3", "noted"), answer("toolu_4", "again")]);
    try {
      await run({ session: "abc", toolFilter: ["none"], agentTools: ["dev/write"], approve: ["dev/write"], prompt: "and now?" }, { registry: reg, services, runId: "r2" });
      const told = (s2.bodies[0].messages as any[]).at(-1);
      assert.equal(told.role, "user");
      const text = textOf(told);
      assert.ok(text.includes(`${PROPOSAL_RESULT_PREFIX} `) && text.includes(` applied · dev/write \\"Write a thing.\\"`), text);
      assert.ok(text.indexOf(PROPOSAL_RESULT_PREFIX) < text.indexOf("and now?"));
      await run({ session: "abc", toolFilter: ["none"], agentTools: ["dev/write"], approve: ["dev/write"], prompt: "later" }, { registry: reg, services, runId: "r3" });
      assert.ok(!textOf((s2.bodies[1].messages as any[]).at(-1)).includes(PROPOSAL_RESULT_PREFIX));
    } finally {
      s2.close();
    }
  });
});
