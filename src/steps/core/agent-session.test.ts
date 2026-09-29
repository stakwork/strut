import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

type Reply = { tool: [string, string, unknown] } | { status: number } | { hold: Promise<void>; then: Reply };
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
    res.write(msgStart());
    res.write(toolUse(...reply.tool));
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

const bash = (id: string, command: string): Reply => ({ tool: [id, "bash", { command }] });
const answer = (id: string, text: string): Reply => ({ tool: [id, "final_answer", { answer: text }] });
const systemOf = (body: any): string => (body.system as any[]).map((b) => b.text).join("");

describe("agent sessions", () => {
  let cwd = "";
  let store: MemorySessionStore;
  let sessions: SessionsCapability;
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_LLM_PROVIDER", "AI_SDK_LOG_WARNINGS"];
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

  it("session_full: a thread over 90% of the window is refused before any request", async () => {
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
});
