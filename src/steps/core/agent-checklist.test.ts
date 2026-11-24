import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../core.js";
import { createRegistry } from "../registry.js";
import agent, { CHECKLIST_EVERY, wrapToolsWithChecklist } from "./agent.js";

// The checklist reminder (wrapToolsWithChecklist, docs/agent-step.md): on a
// job's turn, a tool's answer reminds the agent of the list the person
// watching sees, once it has gone quiet.

const job = { job: "j1" } as unknown as StepContext;
const plan = [
  { text: "Claim the pod", state: "done" },
  { text: "Wire the stack", state: "doing" },
  { text: "Bake", state: "todo" },
];
const listLine = (quiet: number) =>
  `[checklist] ${quiet} tool calls ago you sent this list, and it is what the person watching sees: ` +
  `done: Claim the pod · doing: Wire the stack · todo: Bake. If a step has moved on, send the whole list again with job_status.`;

function setup(more: Record<string, any> = {}) {
  const tools: Record<string, any> = {
    job_status: { execute: async () => ({ sent: true }) },
    bash: { execute: async (i: { n: number }) => `ran ${i.n}` },
    final_answer: { execute: async (i: unknown) => i },
    ...more,
  };
  wrapToolsWithChecklist(tools, job);
  let id = 0;
  /** One call as the SDK makes it: execute, then what the model reads. */
  const call = async (name: string, input: unknown = {}) => {
    const toolCallId = `c${++id}`;
    const output = await tools[name].execute(input, { toolCallId });
    return { output, shown: await tools[name].toModelOutput({ toolCallId, input, output }), toolCallId };
  };
  return { tools, call };
}

describe("the checklist reminder", () => {
  it("is off without a job, and without job/status", () => {
    const tools: Record<string, any> = { job_status: { execute: async () => ({}) }, bash: { execute: async () => "" } };
    wrapToolsWithChecklist(tools, {} as StepContext);
    assert.equal(tools.bash.toModelOutput, undefined, "no job");
    const bare: Record<string, any> = { bash: { execute: async () => "" } };
    wrapToolsWithChecklist(bare, job);
    assert.equal(bare.bash.toModelOutput, undefined, "no job/status");
  });

  it("reminds at 10 quiet calls, then 20 and 40, and a status call starts over; the tool's own output is untouched", async () => {
    assert.equal(CHECKLIST_EVERY, 10);
    const { tools, call } = setup();
    await call("job_status", { title: "Setting up", items: plan });
    const reminded: number[] = [];
    for (let n = 1; n <= 50; n++) {
      const { output, shown } = await call("bash", { n });
      assert.equal(output, `ran ${n}`);
      if (shown.value !== `ran ${n}`) reminded.push(n);
      if (n === 10) assert.deepEqual(shown, { type: "text", value: `ran 10\n\n${listLine(10)}` });
    }
    assert.deepEqual(reminded, [10, 20, 40]);

    await call("job_status", { title: "Wiring", items: plan });
    const after: number[] = [];
    for (let n = 1; n <= 10; n++) if ((await call("bash", { n })).shown.value !== `ran ${n}`) after.push(n);
    assert.deepEqual(after, [10]);

    // The SDK converts one result more than once: each conversion agrees.
    await call("job_status", { title: "Wiring", items: plan });
    const first = await call("bash", { n: 1 });
    for (let n = 2; n < 10; n++) await call("bash", { n });
    const tenth = await call("bash", { n: 10 });
    assert.equal(tenth.shown.value, `ran 10\n\n${listLine(10)}`);
    assert.deepEqual(await tools.bash.toModelOutput({ toolCallId: tenth.toolCallId, output: tenth.output }), tenth.shown);
    assert.deepEqual(await tools.bash.toModelOutput({ toolCallId: first.toolCallId, output: first.output }), { type: "text", value: "ran 1" });
  });

  it("with no list says the person sees none; a finished list gets nothing", async () => {
    const none = setup();
    let shown: any;
    for (let n = 1; n <= 10; n++) shown = (await none.call("bash", { n })).shown;
    assert.equal(
      shown.value,
      "ran 10\n\n[checklist] The person watching this job sees no checklist for this turn. " +
        "If it has more than one step, send them with job_status (items), then again as each one moves on.",
    );

    const done = setup();
    await done.call("job_status", { title: "Done", items: plan.map((i) => ({ ...i, state: "done" })) });
    for (let n = 1; n <= 20; n++) assert.equal((await done.call("bash", { n })).shown.value, `ran ${n}`);
  });

  it("ends a JSON result and a content result too, and a call that fails passes it to the next", async () => {
    let fail = false;
    const { call } = setup({
      look: { execute: async () => ({ a: 1 }) },
      shot: {
        execute: async () => {
          if (fail) throw new Error("no browser");
          return "png";
        },
        toModelOutput: ({ output }: { output: string }) => ({ type: "content", value: [{ type: "text", text: output }] }),
      },
    });
    await call("job_status", { title: "Setting up", items: plan });
    for (let n = 1; n < 10; n++) await call("bash", { n });
    assert.deepEqual((await call("look")).shown, { type: "text", value: `{"a":1}\n\n${listLine(10)}` });

    for (let n = 11; n < 20; n++) await call("bash", { n });
    assert.deepEqual((await call("shot")).shown, {
      type: "content",
      value: [{ type: "text", text: "png" }, { type: "text", text: listLine(20) }],
    });

    for (let n = 21; n < 40; n++) await call("bash", { n });
    fail = true;
    await assert.rejects(() => call("shot"), /no browser/);
    assert.equal((await call("bash", { n: 41 })).shown.value, `ran 41\n\n${listLine(41)}`);
  });

  it("final_answer is never counted or changed", async () => {
    const { tools } = setup();
    for (let n = 1; n <= 10; n++) await tools.final_answer.execute({ n }, { toolCallId: `f${n}` });
    assert.equal(tools.final_answer.toModelOutput, undefined);
  });
});

describe("the checklist reminder in a turn", () => {
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

  it("the model reads the line after its 10th quiet call, and the person's card got the list", async () => {
    const replies: Array<[string, unknown]> = [
      ["job_status", { title: "Setting up", items: plan }],
      ...Array.from({ length: 10 }, (_, n): [string, unknown] => ["dev_look", { n }]),
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
    const lastResult = (body: any) => JSON.stringify((body.messages.at(-1).content as any[]).find((b) => b.type === "tool_result"));
    assert.equal(bodies.length, 12);
    for (let i = 1; i < 11; i++) assert.ok(!lastResult(bodies[i]).includes("[checklist]"), `request ${i + 1}`);
    assert.ok(lastResult(bodies[11]).includes(JSON.stringify(listLine(10)).slice(1, -1)), lastResult(bodies[11]));
    assert.deepEqual(notes.map((n) => n.detail?.items), [plan]);
  });
});
