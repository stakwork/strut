import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { defineStep, type StepContext } from "./core.js";
import { fileToken } from "./auth.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import type { StrutCapabilities } from "./capabilities.js";
import { trimOutput } from "./ai/assistant-tools.js";

// The ASSISTANT MCP door (`POST /mcp`, src/ai/assistant-tools.ts) over a real
// listener with the SDK's client, the builder's model stood in for by a
// scripted Anthropic endpoint: a caller talks to the workflow builder, reads
// the chat back as turns with what the builder DID, finds the chat again,
// runs the workflow it built, and reads the run with its big output held
// back and its deliverables as shareable links.

const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "STRUT_API_KEY", "STRUT_PEER_KEY"] as const;
const KEY = "assistant-key";
const BIG = "x".repeat(3000);

const writer = defineStep({
  type: "writer",
  input: z.object({ name: z.string(), text: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    await ctx.services.artifacts.write(ctx.runId, cfg.name, cfg.text);
    return { wrote: cfg.name };
  },
});
const YAML = `name: deliver
steps:
  - id: w
    type: writer
    config: { name: plan.md, text: "# plan" }
  - id: result
    type: pack
    config:
      text: wrote the plan
      blob: "${BIG}"
      artifacts: [{ id: plan, title: Plan, path: plan.md }]
`;

type Reply = { tool: { name: string; input: unknown }; delayMs?: number } | { text: string; delayMs?: number };

/** A scripted Anthropic Messages endpoint: each request gets the next reply
 *  — one tool call, or text — and after the script, text. Records bodies. */
async function scriptedProvider(script: Reply[]) {
  let calls = 0;
  const bodies: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    const reply = script[calls++] ?? { text: "done" };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", {
      message: { id: `m${calls}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    });
    if ("tool" in reply) {
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${calls}`, name: reply.tool.name, input: {} } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.input) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    ev("message_stop", {});
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, calls: () => calls, bodies, close: () => server.close() };
}

const json = (r: { content: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

describe("the assistant MCP door (POST /mcp)", () => {
  let tempDir: string;
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    delete process.env["STRUT_PEER_KEY"];
    tempDir = join(tmpdir(), `strut-mcp-assistant-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ask → the builder's reply with what it did; read back as turns; found again; the workflow run and its run read with big fields held back", async () => {
    const fake = await scriptedProvider([
      // Turn 1 (chat A): publish, slowly, then answer.
      { tool: { name: "create_workflow", input: { name: "deliver", yaml: YAML } }, delayMs: 1500 },
      { text: "Published deliver v1: it writes plan.md and declares it as the Plan artifact." },
      // Turn 2 (chat A): a question for the caller.
      { tool: { name: "ask_user", input: { message: "Which repo should it read?", requestedSchema: { type: "object", properties: { repo: { type: "string", title: "Repository" } }, required: ["repo"] } } } },
      // Turn 3 (chat A): the answer taken.
      { text: "Noted: acme/site." },
    ]);
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${fake.port}`;
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(tempDir, "ws")),
      registry: await createRegistry([writer]),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      chatModel: "claude-sonnet-5-5",
    });
    const port = await strut.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const clientFor = async (headers: Record<string, string>) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}`, ...headers } } }));
      return client;
    };
    const client = await clientFor({ "x-strut-actor": "hermes" });
    try {
      // Seven tools, none of the builder's own; short instructions naming the base.
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ["ask_workflow_builder", "get_run", "list_runs", "list_workflow_builder_chats", "list_workflows", "read_workflow_builder_chat", "run_workflow"],
      );
      const instructions = client.getInstructions()!;
      assert.ok(instructions.includes(`${base}/`), instructions);
      assert.ok(instructions.length < 3000, `short: ${instructions.length}`);
      assert.deepEqual(await client.listPrompts().catch((e: Error) => e.message.includes("Method not found") ? "none" : e.message), "none", "no prompt on the assistant set");

      // ask with wait: 0 → the builder is working; read with wait → its reply.
      const started = json(await client.callTool({ name: "ask_workflow_builder", arguments: { message: "Make a workflow called deliver that writes a plan", wait: 0 } }));
      assert.equal(started.status, "working", JSON.stringify(started));
      assert.ok(started.chat && started.turn === 0);
      assert.match(started.hint, /read_workflow_builder_chat/);
      assert.equal(started.ui, `${base}/?chat=${started.chat}`);
      const chat = started.chat as string;

      // A second message while it works is refused with the same guidance.
      const busy = json(await client.callTool({ name: "ask_workflow_builder", arguments: { message: "and also…", chat, wait: 0 } }));
      assert.equal(busy.status, "working");
      assert.match(busy.error, /turn in progress/);

      const read = json(await client.callTool({ name: "read_workflow_builder_chat", arguments: { chat, wait: 20_000 } }));
      assert.equal(read.status, "done", JSON.stringify(read));
      assert.equal(read.settled, true);
      assert.equal(read.turns.length, 1);
      const t1 = read.turns[0];
      assert.equal(t1.you, "Make a workflow called deliver that writes a plan");
      assert.match(t1.text, /^Published deliver v1/);
      assert.equal(t1.toolCalls, 1);
      // What it DID, with the ui link ABSOLUTE: the chat was stamped with the door's base.
      assert.deepEqual(t1.did, { workflows: [{ name: "deliver", version: "v1", action: "created", ui: `${base}/?wf=deliver` }] });
      assert.equal(read.cursor, 4, "user, assistant (call), tool (result), assistant (text)");

      // The chat record carries the base; the UI's read sees the same meta.
      const meta = await fetch(`${base}/chat/${chat}/meta`, { headers: { authorization: `Bearer ${KEY}` } }).then((r) => r.json());
      assert.equal(meta.publicUrl, base);
      assert.equal(meta.createdBy, "hermes");
      assert.equal(meta.title, "Make a workflow called deliver that writes a plan");

      // Turn 2: the builder asks — the call returns `asked` with the question.
      const asked = json(await client.callTool({ name: "ask_workflow_builder", arguments: { message: "Make it read a repo too", chat, wait: 20_000 } }));
      assert.equal(asked.status, "asked", JSON.stringify(asked));
      assert.equal(asked.question.mode, "form");
      assert.equal(asked.question.message, "Which repo should it read?");
      assert.deepEqual(Object.keys(asked.question.requestedSchema.properties), ["repo"]);
      assert.deepEqual(asked.asked, { mode: "form", message: "Which repo should it read?", fields: ["repo"] });
      assert.equal(asked.at, 4, "this turn only");
      assert.equal(asked.turns, undefined, "one turn: lifted, not listed");
      assert.equal(asked.text, undefined);

      // Turn 3: the answer is the next message on the chat.
      const answered = json(await client.callTool({ name: "ask_workflow_builder", arguments: { message: "acme/site", chat, wait: 20_000 } }));
      assert.equal(answered.status, "done");
      assert.equal(answered.text, "Noted: acme/site.");
      assert.equal(answered.question, undefined);

      // Found again — the caller's own, by title words; another actor sees nothing with `mine`.
      const mine = json(await client.callTool({ name: "list_workflow_builder_chats", arguments: { q: "deliver plan" } }));
      assert.equal(mine.total, 1);
      assert.equal(mine.chats[0].chat, chat);
      assert.equal(mine.chats[0].status, "done");
      assert.equal(mine.chats[0].turns, 3);
      assert.equal(mine.chats[0].createdBy, "hermes");
      const other = await clientFor({ "x-strut-actor": "someone-else" });
      try {
        assert.equal(json(await other.callTool({ name: "list_workflow_builder_chats", arguments: {} })).total, 0);
        assert.equal(json(await other.callTool({ name: "list_workflow_builder_chats", arguments: { mine: false } })).total, 1);
      } finally {
        await other.close();
      }

      // The whole chat, with the tool calls previewed.
      const all = json(await client.callTool({ name: "read_workflow_builder_chat", arguments: { chat, detail: "tools" } }));
      assert.equal(all.turns.length, 3);
      assert.equal(all.turns[0].tools[0].name, "create_workflow");
      assert.ok(String(all.turns[0].tools[0].input).includes("chars]"), "the YAML is previewed, not replayed");

      // The workflow it built: listed with its last run once there is one.
      const before = json(await client.callTool({ name: "list_workflows", arguments: {} }));
      const byName = (list: { workflows: Array<Record<string, any>> }, name: string) => list.workflows.find((w) => w["name"] === name)!;
      const deliver = byName(before, "deliver");
      assert.equal(deliver.activeVersion, "v1");
      assert.equal(deliver.lastRun, undefined);
      assert.equal(deliver.ui, `${base}/?wf=deliver`);
      // A seeded workflow with a schedule lists it as a sentence.
      const tidy = byName(before, "tidy-memory");
      assert.equal(tidy.schedules.length, 1);
      assert.equal(typeof tidy.schedules[0].summary, "string");
      assert.equal(tidy.schedules[0].enabled, false);
      assert.deepEqual(json(await client.callTool({ name: "list_workflows", arguments: { query: "deliver" } })).workflows.map((w: { name: string }) => w.name), ["deliver"]);

      // run_workflow: the big field held back, the deliverable a shareable link.
      const run = json(await client.callTool({ name: "run_workflow", arguments: { name: "deliver", input: {} } }));
      assert.equal(run.status, "success", JSON.stringify(run));
      const token = fileToken({ kind: "run", id: run.runId })!;
      assert.deepEqual(run.artifacts, [{ id: "plan", kind: "markdown", title: "Plan", url: `${base}/artifacts/${run.runId}/plan.md?t=${token}` }]);
      assert.equal(run.output.text, "wrote the plan");
      assert.deepEqual(run.output.blob, { $omitted: { chars: 3000, kind: "string", preview: BIG.slice(0, 120) } });
      assert.deepEqual(run.omitted.map((o: { field: string }) => o.field), ["blob"]);
      assert.match(run.hint, /get_run with fields: \["blob"\]/);
      assert.equal((await fetch(run.artifacts[0].url)).status, 200, "the link opens the file by itself");

      // list_runs carries the links; get_run the basics, the field on request, the files.
      const runs = json(await client.callTool({ name: "list_runs", arguments: { workflow: "deliver" } }));
      assert.equal(runs.runs.length, 1);
      assert.equal(runs.runs[0].status, "success");
      assert.equal(runs.runs[0].actor, "hermes");
      assert.equal(runs.runs[0].artifacts[0].url, run.artifacts[0].url);
      assert.equal(json(await client.callTool({ name: "list_runs", arguments: { workflow: "deliver", status: "error" } })).runs.length, 0);
      assert.equal(json(await client.callTool({ name: "list_runs", arguments: { workflow: "deliver", since: new Date(Date.now() + 60_000).toISOString() } })).runs.length, 0);

      const got = json(await client.callTool({ name: "get_run", arguments: { workflow: "deliver", runId: run.runId } }));
      assert.equal(got.status, "success");
      assert.deepEqual(got.output.blob, run.output.blob);
      assert.equal(got.artifacts[0].url, run.artifacts[0].url);
      assert.equal(got.ui, `${base}/?wf=deliver&run=${run.runId}`);
      const whole = json(await client.callTool({ name: "get_run", arguments: { workflow: "deliver", runId: run.runId, fields: ["blob"], files: true } }));
      assert.equal(whole.output.blob, BIG);
      assert.equal(whole.omitted, undefined);
      assert.deepEqual(whole.files, [{ path: "plan.md", url: `${base}/artifacts/${run.runId}/plan.md?t=${token}` }]);
      assert.match(json(await client.callTool({ name: "get_run", arguments: { workflow: "deliver", runId: "1" } })).error, /not found/);

      const after = byName(json(await client.callTool({ name: "list_workflows", arguments: { query: "deliver" } })), "deliver");
      assert.equal(after.lastRun.runId, run.runId);
      assert.equal(after.lastRun.status, "success");

      assert.equal(fake.calls(), 4);
    } finally {
      await client.close();
      await strut.close();
      fake.close();
    }
  });
});

describe("trimOutput", () => {
  it("holds back big top-level fields, names them, and hands a field over whole when asked", () => {
    const out = { small: 1, big: BIG, list: Array.from({ length: 1000 }, (_, i) => i) };
    const t = trimOutput(out);
    assert.equal(t.output && (t.output as any).small, 1);
    assert.deepEqual((t.output as any).big, { $omitted: { chars: 3000, kind: "string", preview: BIG.slice(0, 120) } });
    assert.equal((t.output as any).list.$omitted.kind, "array");
    assert.deepEqual(t.omitted!.map((o) => o.field), ["big", "list"]);
    const w = trimOutput(out, ["big"]);
    assert.equal((w.output as any).big, BIG);
    assert.deepEqual(w.omitted!.map((o) => o.field), ["list"]);
  });
  it("a non-object output is the one field `output`; a small one passes untouched; a whole field over the cap is cut with a note", () => {
    assert.deepEqual(trimOutput("hi"), { output: "hi" });
    assert.deepEqual(trimOutput(undefined), { output: undefined });
    const s = trimOutput(BIG);
    assert.equal((s.output as any).$omitted.chars, 3000);
    assert.equal(s.omitted![0]!.field, "output");
    assert.equal(trimOutput(BIG, ["output"]).output, BIG);
    const huge = trimOutput({ f: "y".repeat(60_000) }, ["f"]);
    assert.match((huge.output as any).f, /\[cut, 60000 chars/);
  });
});
