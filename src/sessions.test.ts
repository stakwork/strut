import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { defineStep, withStop } from "./core.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { MemoryChatStore } from "./chat-store.js";
import { FileSessionStore, MemorySessionStore } from "./session-store.js";
import { projectRunEvents } from "./graph/projector.js";
import type { RunsCapability } from "./runs.js";

// Agent sessions through a whole strut (plans/agent-sessions.md): runs
// launched over HTTP with the id in `input`, a stand-in Anthropic endpoint
// behind the agent step, and the read routes.

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const finalAnswer = (id: string, answer: string) =>
  sse({
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
    },
  }) +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "final_answer", input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ answer }) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
  sse({ type: "message_stop" });

describe("agent sessions over HTTP", () => {
  let dir = "";
  let provider: http.Server;
  let calls = 0;
  /** Set to hold the provider's next reply until released. */
  let gate: Promise<void> | undefined;
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-sessions-${randomUUID()}`);
    await mkdir(join(dir, "cwd"), { recursive: true });
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    calls = 0;
    gate = undefined;
    provider = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", async () => {
        const n = ++calls;
        await gate;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(finalAnswer(`toolu_${n}`, `answer ${n}`));
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as any).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    provider.close();
    await rm(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const boom = defineStep({
    type: "boom",
    input: z.object({}),
    output: z.any(),
    async run() {
      throw new Error("kaboom");
    },
  });

  const agentStep = (id: string, session: string) => ({
    id,
    type: "agent",
    config: {
      cwd: join(dir, "cwd"),
      system: `you are ${id}`,
      prompt: "{{ input.prompt }}",
      session,
      model: "claude-sonnet-4-5",
      finalAnswer: "Report.",
      toolFilter: ["bash"],
    },
  });

  const boot = async () => {
    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      registry: await createRegistry([boom]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
    });
    await strut.workspace.publishWorkflow("talk", "v1", {
      steps: [
        agentStep("work", "{{ input.session }}"),
        // Its own thread when there is a session, cold when there is none.
        agentStep("review", "{{ input.session ? input.session + '/review' : undefined }}"),
      ],
    });
    await strut.workspace.publishWorkflow("breaks", "v1", {
      steps: [agentStep("work", "{{ input.session }}"), { id: "b", type: "boom", config: {} }],
    });
    const json = async (path: string, init?: RequestInit) => {
      const res = await strut.app.request(path, init);
      return { status: res.status, body: (await res.json()) as any };
    };
    const settle = async (workflow: string, runId: string) => {
      for (let i = 0; i < 400; i++) {
        const summary = await store.getRunSummary(workflow, runId);
        if (summary) return summary;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`run ${runId} never settled`);
    };
    const launch = async (workflow: string, input: unknown) => {
      const res = await json(`/workflows/${workflow}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
      assert.equal(res.status, 202);
      return res.body.runId as string;
    };
    const run = async (workflow: string, input: unknown) => {
      const runId = await launch(workflow, input);
      return { runId, summary: await settle(workflow, runId) };
    };
    const ends = async (workflow: string, runId: string) =>
      (await store.getRunEvents(workflow, runId)).filter((e) => e.type === "step.end" && e.stepType === "agent");
    return { strut, store, json, run, launch, settle, ends };
  };

  it("the sessions default follows the chat store: files beside chats, memory beside memory", async () => {
    const onDisk = await createStrut({
      workspace: new WorkspaceManager(dir), registry: await createRegistry([]), store: new MemoryRunStore(),
      serveUi: false, enableChat: false, scheduler: false,
    });
    assert.ok(onDisk.sessionStore instanceof FileSessionStore);
    const inMemory = await createStrut({
      workspace: new WorkspaceManager(dir), registry: await createRegistry([]), store: new MemoryRunStore(),
      chatStore: new MemoryChatStore(), serveUi: false, enableChat: false, scheduler: false,
    });
    assert.ok(inMemory.sessionStore instanceof MemorySessionStore);
  });

  it("two runs on one session: the log holds each turn, ?full=1 the thread, /sessions the record", async () => {
    const { strut, json, run, ends, store } = await boot();
    const first = await run("talk", { prompt: "why is login slow?", session: "abc" });
    assert.equal(first.summary.status, "success", JSON.stringify(first.summary));
    const second = await run("talk", { prompt: "fix it", session: "abc" });
    assert.equal(second.summary.status, "success", JSON.stringify(second.summary));

    // Each agent continued ITS thread.
    const [work, review] = await ends("talk", second.runId);
    assert.equal((work!.output as any).session.id, "abc");
    assert.equal((work!.output as any).session.turn, 1);
    assert.equal((review!.output as any).session.id, "abc/review");
    assert.equal((review!.output as any).session.turn, 1);

    // What the graph projector makes of that log: each execution stamped
    // with its thread and its turn in it.
    const projected = projectRunEvents("talk", second.runId, await store.getRunEvents("talk", second.runId), second.summary)!;
    assert.deepEqual(
      projected.sessions.map((s) => [s.data["path"], s.data["session_id"], s.data["session_turn"]]),
      [["talk/work", "abc", 1], ["talk/review", "abc/review", 1]],
    );

    // The run log holds the turn…
    const turn = (await json(`/workflows/talk/runs/${second.runId}/transcripts/talk/work`)).body as any[];
    assert.deepEqual(turn[0], { role: "system", content: "you are work" });
    assert.ok(JSON.stringify(turn).includes("fix it"));
    assert.ok(!JSON.stringify(turn).includes("why is login slow?"));

    // …and ?full=1 the thread to that turn, the first run's to its own.
    const full = (await json(`/workflows/talk/runs/${second.runId}/transcripts/talk/work?full=1`)).body as any[];
    assert.deepEqual(full[0], { role: "system", content: "you are work" });
    const text = JSON.stringify(full);
    assert.ok(text.indexOf("why is login slow?") < text.indexOf("fix it"));
    assert.equal(full.filter((m) => m.role === "system").length, 1);
    const firstTurn = (await json(`/workflows/talk/runs/${first.runId}/transcripts/talk/work`)).body as any[];
    assert.deepEqual((await json(`/workflows/talk/runs/${first.runId}/transcripts/talk/work?full=1`)).body, firstTurn);
    assert.deepEqual(full, [...firstTurn, ...turn.slice(1)]);
    // run/transcript (the runs capability, an app's door) serves the same,
    // as it reaches the page: JSON.
    const runs = (strut.services as { runs: RunsCapability }).runs;
    const wire = (v: unknown) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(wire(await runs.transcript({ workflow: "talk", runId: second.runId, path: "talk/work" })), { path: "talk/work", messages: turn });
    assert.deepEqual(wire(await runs.transcript({ workflow: "talk", runId: second.runId, path: "talk/work", full: true })), { path: "talk/work", messages: full, full: true });

    // The record.
    const list = (await json("/sessions")).body.sessions as any[];
    assert.deepEqual(list.map((s) => [s.id, s.turns]).sort(), [["abc", 2], ["abc/review", 2]]);
    const one = (await json("/sessions?id=abc/review")).body;
    assert.equal(one.turns, 2);
    assert.deepEqual(
      one.turnLog.map((t: any) => [t.turn, t.workflow, t.runId, t.path]),
      [[0, "talk", first.runId, "talk/review"], [1, "talk", second.runId, "talk/review"]],
    );
    const thread = (await json("/sessions/messages?id=abc")).body as any[];
    assert.deepEqual(thread, full);

    assert.equal((await json("/sessions?id=nope")).status, 404);
    assert.equal((await json("/sessions/messages?id=nope")).status, 404);
    assert.equal((await json("/sessions?id=/review")).status, 400);
  });

  it("no session in the input: every agent runs cold and nothing is stored", async () => {
    const { json, run, ends, store } = await boot();
    const { runId, summary } = await run("talk", { prompt: "hello" });
    assert.equal(summary.status, "success", JSON.stringify(summary));
    for (const end of await ends("talk", runId)) assert.ok(!("session" in (end.output as object)));
    const projected = projectRunEvents("talk", runId, await store.getRunEvents("talk", runId), summary)!;
    assert.deepEqual(projected.sessions.map((s) => [s.data["session_id"], s.data["session_turn"]]), [[undefined, undefined], [undefined, undefined]]);
    assert.deepEqual((await json("/sessions")).body.sessions, []);
    // ?full=1 on a session-less agent is its transcript, which is already whole.
    const plain = await json(`/workflows/talk/runs/${runId}/transcripts/talk/work`);
    assert.deepEqual((await json(`/workflows/talk/runs/${runId}/transcripts/talk/work?full=1`)).body, plain.body);
  });

  it("DELETE /sessions: 409 while a turn holds it, then gone — and ?full=1 with it", async () => {
    const { strut, json, run, launch, settle } = await boot();
    const first = await run("talk", { prompt: "one", session: "abc" });

    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const before = calls;
    const runId = await launch("talk", { prompt: "two", session: "abc" });
    while (calls === before) await new Promise((r) => setTimeout(r, 5));
    const busy = (await json("/sessions")).body.sessions.find((s: any) => s.id === "abc");
    assert.equal(busy.busy, true);
    const refused = await json("/sessions?id=abc", { method: "DELETE" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, new RegExp(`in use by run ${runId} \\(talk/work\\)`));
    release();
    gate = undefined;
    await settle("talk", runId);

    assert.deepEqual((await json("/sessions?id=abc", { method: "DELETE" })).body, { ok: true });
    assert.equal((await json("/sessions?id=abc")).status, 404);
    assert.equal((await json(`/workflows/talk/runs/${first.runId}/transcripts/talk/work?full=1`)).status, 404);
    const runs = (strut.services as { runs: RunsCapability }).runs;
    await assert.rejects(runs.transcript({ workflow: "talk", runId: first.runId, path: "talk/work", full: true }), /Session "abc" is gone/);
    // The turn itself is still in the run log.
    assert.equal((await json(`/workflows/talk/runs/${first.runId}/transcripts/talk/work`)).status, 200);
  });

  it("a journaled session step is replayed on resume: no model call, no second append", async () => {
    const { strut, json, run, settle, store } = await boot();
    const { runId, summary } = await run("breaks", { prompt: "one", session: "abc" });
    assert.equal(summary.status, "error");
    assert.equal((await strut.sessionStore.load("abc"))!.turns.length, 1);
    const before = calls;

    const resumed = await json(`/workflows/breaks/runs/${runId}/resume`, { method: "POST" });
    assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
    for (let i = 0; i < 400; i++) {
      const events = await store.getRunEvents("breaks", runId);
      if (events.filter((e) => e.type === "run.error").length === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle("breaks", runId);
    const events = await store.getRunEvents("breaks", runId);
    assert.ok(events.some((e) => e.type === "step.replayed" && e.path === "breaks/work"));
    assert.equal(calls, before);
    assert.equal((await strut.sessionStore.load("abc"))!.turns.length, 1);
  });

  it("every read of a thread is behind the key, the turn in the run log included", async () => {
    const { json, run } = await boot();
    const { runId } = await run("talk", { prompt: "one", session: "abc" });
    process.env["STRUT_API_KEY"] = "k3y";
    const auth = { headers: { authorization: "Bearer k3y" } };

    for (const path of ["/sessions", "/sessions?id=abc", "/sessions/messages?id=abc"]) {
      assert.equal((await json(path)).status, 401, path);
      assert.equal((await json(path, auth)).status, 200, path);
    }
    assert.equal((await json("/sessions?id=abc", { method: "DELETE" })).status, 401);
    const transcript = `/workflows/talk/runs/${runId}/transcripts/talk/work`;
    for (const path of [transcript, `${transcript}?full=1`]) {
      assert.equal((await json(path)).status, 401, path);
      assert.equal((await json(path, auth)).status, 200, path);
    }
  });

  it("an injected sessions capability is the consumer's: the routes report 501", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir), registry: await createRegistry([]), store: new MemoryRunStore(),
      services: { sessions: { open: async () => { throw new Error("mine"); }, holder: () => undefined } },
      serveUi: false, enableChat: false, scheduler: false,
    });
    assert.equal((await strut.app.request("/sessions")).status, 501);
    assert.equal((await strut.app.request("/sessions/messages?id=abc")).status, 501);
    assert.equal((await strut.app.request("/sessions?id=abc", { method: "DELETE" })).status, 501);
  });
});

// The shape of Peel's orchestrator (peel docs/agent-on-strut.md §1): one
// DM thread on `session`, its prompt fixed by the first turn, no built-ins,
// registry steps as tools, job's structured reply, and a run.end callback
// per turn. Turn 1 asks a device that has not answered (`withStop`), so
// the turn ends waiting; turn 2 is the answer arriving, in the same thread.
describe("a peel-agent-shaped workflow: two turns in one session", () => {
  let dir = "";
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const servers: http.Server[] = [];

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-peel-agent-${randomUUID()}`);
    await mkdir(join(dir, "cwd"), { recursive: true });
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) s.close();
    await rm(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const listen = async (handler: (body: any) => string | undefined): Promise<string> => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const out = handler(JSON.parse(raw));
        if (out === undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        } else {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(out);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as any).port}`;
  };

  const start = sse({
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
  const toolUse = (id: string, name: string, input: unknown) =>
    start +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });
  const text = (t: string) =>
    start +
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } }) +
    sse({ type: "message_stop" });

  const askMac = defineStep({
    type: "dev/ask-mac",
    description: "Ask the Mac to read your chats.",
    input: z.object({ kind: z.string() }),
    output: z.any(),
    async run({ kind }) {
      return withStop({ request: kind, status: "pending" });
    },
  });
  const remember = defineStep({
    type: "dev/remember",
    description: "Remember a fact.",
    input: z.object({ fact: z.string() }),
    output: z.any(),
    async run() {
      return { ok: true };
    },
  });

  it("turn 1 ends waiting on a tool, turn 2 continues the thread under its first prompt; each run.end reaches the callback", async () => {
    const bodies: any[] = [];
    const replies = [
      toolUse("toolu_1", "dev_ask_mac", { kind: "chats.unseen" }),
      text(JSON.stringify({ text: "Waiting for your Mac.", artifacts: [] })),
      toolUse("toolu_3", "final_answer", { text: "You missed 3 messages from Sam.", artifacts: [] }),
    ];
    process.env["ANTHROPIC_BASE_URL"] = await listen((body) => {
      bodies.push(body);
      const reply = replies[bodies.length - 1];
      assert.ok(reply, `unexpected request #${bodies.length}`);
      return reply;
    });
    const ends: any[] = [];
    const callback = `${await listen((body) => void ends.push(body))}/run-end?sig=s3cret`;

    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      registry: await createRegistry([askMac, remember]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
    });
    await strut.workspace.publishWorkflow("peel-agent", "v1", {
      input: { prompt: { type: "string" }, session: { type: "string" }, context: { type: "json" } },
      params: { system: "prompt v1", tools: ["dev/*"], model: "claude-sonnet-4-5" },
      steps: [
        {
          id: "turn",
          type: "agent",
          config: {
            cwd: join(dir, "cwd"),
            session: "{{ input.session }}",
            system: "{{ params.system }}",
            prompt: "{{ input.context.line }}{{ input.prompt }}",
            toolFilter: ["none"],
            agentTools: "{{ params.tools }}",
            model: "{{ params.model }}",
            cacheTtl: "1h",
            retain: "the chats read, by chat id; message uuids and View links, word for word",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["text", "artifacts"],
              properties: { text: { type: "string" }, artifacts: { type: "array", items: { type: "object" } }, ask: { type: "string" } },
            },
          },
        },
      ],
    });
    const turn = async (prompt: string, params?: Record<string, unknown>) => {
      const res = await strut.app.request("/workflows/peel-agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { prompt, session: "peel/agent-1/dm", context: { line: "Thu 16 Oct 14:02, Europe/London. " } },
          callback: { url: callback },
          ...(params ? { params } : {}),
        }),
      });
      assert.equal(res.status, 202);
      const { runId } = (await res.json()) as any;
      const before = ends.length;
      for (let i = 0; i < 400 && ends.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(ends.length, before + 1, "run.end reached the callback");
      return { runId, end: ends.at(-1) };
    };

    try {
      const first = await turn("what did I miss?");
      assert.equal(first.end.status, "success", JSON.stringify(first.end));
      assert.equal(first.end.runId, first.runId);
      assert.deepEqual(first.end.output.object, { text: "Waiting for your Mac.", artifacts: [] });
      assert.deepEqual(first.end.output.stopped, { tool: "dev_ask_mac" });
      assert.equal(bodies.length, 2, "the stop ended the loop: one answer turn, no more tools");

      // A later prompt is ignored: the thread keeps its first turn's.
      const second = await turn("Your Mac answered: 3 unread from Sam.", { system: "prompt v2" });
      assert.equal(second.end.status, "success", JSON.stringify(second.end));
      assert.deepEqual(second.end.output.object, { text: "You missed 3 messages from Sam.", artifacts: [] });
      assert.ok(!("stopped" in second.end.output));
      assert.deepEqual(second.end.output.session, { id: "peel/agent-1/dm", turn: 1, offset: (await strut.sessionStore.load("peel/agent-1/dm"))!.turns[0]!.count });

      // On the wire: no built-ins, the thread's prompt, the context line,
      // and turn 1 replayed as the unchanged prefix of turn 2.
      const [loop1, answer1, loop2] = bodies;
      assert.deepEqual((loop1.tools as any[]).map((t) => t.name).sort(), ["dev_ask_mac", "dev_remember", "final_answer"]);
      assert.equal((loop1.system as any[]).map((b) => b.text).join(""), "prompt v1");
      assert.equal((loop2.system as any[]).map((b) => b.text).join(""), "prompt v1");
      assert.ok(JSON.stringify(loop1.messages).includes("Thu 16 Oct 14:02, Europe/London. what did I miss?"));
      assert.equal(loop1.cache_control?.ttl, "1h");
      const prefix = answer1.messages as unknown[];
      assert.equal(JSON.stringify((loop2.messages as unknown[]).slice(0, prefix.length)), JSON.stringify(prefix));
      assert.ok(JSON.stringify((loop2.messages as any[]).at(-1)).includes("Your Mac answered"));

      const thread = await strut.sessionStore.load("peel/agent-1/dm");
      assert.deepEqual(thread!.turns.map((t) => [t.turn, t.runId]), [[0, first.runId], [1, second.runId]]);
    } finally {
      await strut.close();
    }
  });
});
