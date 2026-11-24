import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../core.js";
import { createRegistry } from "../registry.js";
import agent, { CHECKLIST_EVERY, trackChecklist } from "./agent.js";

// The checklist a job's agent keeps for the person watching (trackChecklist,
// docs/agent-step.md): strut's notes in the user's turn, after the message
// and once the agent has gone quiet.

const job = { job: "j1" } as unknown as StepContext;
const plan = [
  { text: "Claim the pod", state: "done" },
  { text: "Wire the stack", state: "doing" },
  { text: "Bake", state: "todo" },
];
const FIRST =
  "[checklist] The person watching this job sees only its card until the turn ends. " +
  "Unless this turn is a single step, set its steps out with job_status (items) before any other tool, " +
  "then send the list again each time a step moves on.";
const listNote = (quiet: number) =>
  `[checklist] ${quiet} tool calls since your last job_status. ` +
  `The person watching sees: done: Claim the pod · doing: Wire the stack · todo: Bake. ` +
  `If a step has moved on, send the whole list again. This note needs no reply.`;
const noneNote = (quiet: number, since: string) =>
  `[checklist] ${quiet} tool calls ${since}, and the person watching sees no checklist. ` +
  `Unless the turn is a single step, send its steps with job_status (items) now. This note needs no reply.`;

function setup() {
  const tools: Record<string, any> = {
    job_status: { execute: async () => ({ sent: true }) },
    bash: { execute: async (i: { n: number }) => `ran ${i.n}` },
    final_answer: { execute: async (i: unknown) => i },
  };
  const checklist = trackChecklist(tools, job)!;
  /** `n` quiet calls; the call counts after which a reminder was due. */
  const quiet = async (n: number) => {
    const due: number[] = [];
    for (let i = 1; i <= n; i++) {
      assert.equal(await tools.bash.execute({ n: i }), `ran ${i}`, "the tool's output is its own");
      if (checklist.due()) due.push(i);
      checklist.take();
    }
    return due;
  };
  return { tools, checklist, quiet };
}

describe("the checklist", () => {
  it("is off without a job, without job/status, and for a sub-agent", () => {
    const tools = () => ({ job_status: { execute: async () => ({}) }, bash: { execute: async () => "" } });
    assert.equal(trackChecklist(tools(), {} as StepContext), undefined, "no job");
    assert.equal(trackChecklist({ bash: { execute: async () => "" } }, job), undefined, "no job/status");
    assert.equal(trackChecklist(tools(), { job: "j1", agentTool: true } as unknown as StepContext), undefined, "a sub-agent");
  });

  it("asks for the steps first, then reminds at 10 quiet calls, 20 and 40; a status call starts over", async () => {
    assert.equal(CHECKLIST_EVERY, 10);
    const { tools, checklist, quiet } = setup();
    assert.equal(checklist.first, FIRST);
    await tools.job_status.execute({ title: "Setting up", items: plan });
    for (let i = 1; i < 10; i++) await tools.bash.execute({ n: i });
    assert.equal(checklist.due(), false);
    await tools.bash.execute({ n: 10 });
    assert.equal(checklist.due(), true);
    assert.equal(checklist.take(), listNote(10));
    assert.equal(checklist.take(), undefined, "once");
    assert.deepEqual((await quiet(40)).map((n) => n + 10), [20, 40]);

    await tools.job_status.execute({ title: "Wiring", items: plan });
    assert.deepEqual(await quiet(10), [10]);
  });

  it("a status call in the same round as the due call cancels the reminder", async () => {
    const { tools, checklist } = setup();
    for (let i = 1; i <= 10; i++) await tools.bash.execute({ n: i });
    await tools.job_status.execute({ title: "Setting up", items: plan });
    assert.equal(checklist.due(), false);
    assert.equal(checklist.take(), undefined);
  });

  it("with no list says the person sees none; a finished list gets nothing; final_answer isn't counted", async () => {
    const none = setup();
    for (let i = 1; i <= 10; i++) await none.tools.bash.execute({ n: i });
    assert.equal(none.checklist.take(), noneNote(10, "into this turn"));

    const titleOnly = setup();
    await titleOnly.tools.job_status.execute({ title: "Looking" });
    for (let i = 1; i <= 10; i++) await titleOnly.tools.bash.execute({ n: i });
    assert.equal(titleOnly.checklist.take(), noneNote(10, "since your last job_status"));

    const done = setup();
    await done.tools.job_status.execute({ title: "Done", items: plan.map((i) => ({ ...i, state: "done" })) });
    assert.deepEqual(await done.quiet(40), []);

    const answering = setup();
    for (let i = 1; i <= 10; i++) await answering.tools.final_answer.execute({ i });
    assert.equal(answering.checklist.due(), false);
  });
});

describe("the checklist in a turn", () => {
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AI_SDK_LOG_WARNINGS"];
  let saved: Record<string, string | undefined> = {};
  let dir = "";
  beforeEach(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    dir = await mkdtemp(join(tmpdir(), "strut-checklist-"));
  });
  afterEach(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const toolUse = (id: string, name: string, input: unknown) =>
    sse({
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    }) +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });

  const look = defineStep({
    type: "dev/look",
    description: "Look around.",
    input: z.object({ n: z.number() }),
    output: z.any(),
    async run({ n }) {
      return `looked ${n}`;
    },
  });

  /** The final user turn: its tool results, then any note after them. */
  const lastTurn = (body: any) => body.messages.at(-1).content as any[];
  const texts = (blocks: any[]) => (typeof blocks === "string" ? [blocks] : blocks.filter((b) => b.type === "text").map((b) => b.text));
  const withoutCache = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));

  it("the model reads the steps-first note after the message and a reminder after its 10th quiet call; nothing sent earlier changes", async () => {
    const looks = (from: number): Array<[string, unknown]> => Array.from({ length: 10 }, (_, i) => ["dev_look", { n: from + i }]);
    const replies: Array<[string, unknown]> = [
      ...looks(1),
      ["job_status", { title: "Setting up", items: plan }],
      ...looks(11),
      ["final_answer", { answer: "done" }],
    ];
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        const reply = replies[bodies.length - 1];
        assert.ok(reply, `unexpected request #${bodies.length}`);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(toolUse(`toolu_${bodies.length}`, ...reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
    const notes: any[] = [];
    try {
      const out = (await agent.run(
        (agent.input as any).parse({
          cwd: dir, system: "sys", prompt: "go", model: "claude-sonnet-4-5", finalAnswer: "Report.",
          toolFilter: ["none"], reasoning: "provider-default", agentTools: ["job/status", "dev/look"],
        }),
        {
          runId: "r1", path: "job/work", scope: {}, input: undefined, emit: async () => {}, job: "j1",
          services: { jobs: { notify: (_job: string, u: unknown) => void notes.push(u) } },
          registry: await createRegistry([look]),
        } as any,
      )) as { result: string };
      assert.equal(out.result, "done");
    } finally {
      server.close();
    }
    assert.equal(bodies.length, 22);
    // The first request: the message, then the note, in the user's turn.
    assert.deepEqual(texts(bodies[0].messages[0].content), ["go", FIRST]);
    // After the 10th quiet call: its tool result as the tool gave it, then the note.
    const tenth = lastTurn(bodies[10]);
    assert.equal(tenth[0].type, "tool_result");
    assert.ok(!JSON.stringify(tenth[0]).includes("[checklist]"), "the tool result is the tool's own");
    assert.deepEqual(texts(tenth), [noneNote(10, "into this turn")]);
    // Ten quiet calls after the list: the list as the person sees it.
    assert.deepEqual(texts(lastTurn(bodies[21])), [listNote(10)]);
    for (const i of [1, 9, 11, 20]) assert.deepEqual(texts(lastTurn(bodies[i])), [], `request ${i + 1}`);
    // Append-only: each request begins with everything the one before sent.
    for (let i = 1; i < bodies.length; i++) {
      const before = withoutCache(bodies[i - 1].messages);
      assert.deepEqual(withoutCache(bodies[i].messages).slice(0, before.length), before, `request ${i + 1}`);
    }
    assert.deepEqual(notes.map((n) => n.detail?.items), [plan]);
  });
});
