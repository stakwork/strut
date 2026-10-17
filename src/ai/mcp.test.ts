import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { defineStep } from "../core.js";
import { createRegistry } from "../steps/registry.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { buildTools } from "./tools.js";
import type { AiDeps } from "./prompts.js";
import { MCP_DETACH_HINT, PROMPT_NAME, builderInstructions, builderServer, mcpToolsFrom } from "./mcp.js";

// The builder over MCP (src/ai/mcp.ts): the SDK's Client against the SDK's
// Server over an in-memory pair — the whole protocol, no HTTP. What crosses
// is exactly what `POST /mcp` serves (createStrut.test.ts drives that over
// HTTP, with the file token).

const shout = defineStep({
  type: "shout",
  description: "Upper-cases text",
  input: z.object({ text: z.string() }),
  output: z.string(),
  async run(cfg) {
    return cfg.text.toUpperCase();
  },
});

/** Long enough to outlive a short detach window. */
const slow = defineStep({
  type: "slow",
  input: z.object({ ms: z.number() }),
  output: z.any(),
  async run(cfg) {
    await new Promise((r) => setTimeout(r, cfg.ms));
    return { slept: cfg.ms };
  },
});

const YAML = (name: string, step = "shout", config = 'text: "{{ input.text }}"') => `name: ${name}
steps:
  - id: s
    type: ${step}
    config:
      ${config}
`;

const text = (r: { content: unknown }) => ((r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "") as string;
const json = (r: { content: unknown }) => JSON.parse(text(r));

describe("the builder over MCP", () => {
  let tempDir: string;
  let deps: AiDeps;
  const clients: Client[] = [];

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-mcp-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    const registry = await createRegistry([shout, slow]);
    deps = { workspace: new WorkspaceManager(tempDir), registry, store: new MemoryRunStore(), getRegistry: async () => registry };
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A connected SDK client over the builder's server. */
  const connect = async (d: AiDeps = deps) => {
    const server = await builderServer({ deps: d, instructions: builderInstructions("https://strut.test") });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  };

  it("tools/list is every builder tool with an execute, with its description and JSON Schema; instructions are the procedure", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const expected = Object.entries(buildTools(deps))
      .filter(([, t]) => typeof t.execute === "function")
      .map(([n]) => n);
    assert.deepEqual(names.sort(), expected.sort());
    for (const n of ["list_steps", "get_step", "validate_workflow", "create_workflow", "edit_workflow", "run_workflow", "run_step", "list_runs", "get_run", "search_runs"]) {
      assert.ok(names.includes(n), n);
    }
    for (const t of tools) {
      assert.ok(typeof t.description === "string" && t.description.length > 20, `${t.name} has a description`);
      assert.equal(t.inputSchema.type, "object", `${t.name} schema`);
      assert.ok(!("$schema" in t.inputSchema), `${t.name}: no $schema noise`);
    }
    const getRun = tools.find((t) => t.name === "get_run")!;
    const props = getRun.inputSchema.properties as Record<string, { maximum?: number }>;
    assert.equal(props["wait"]?.maximum, 55_000);
    assert.deepEqual(getRun.inputSchema.required, ["name", "runId"]);

    const instructions = client.getInstructions()!;
    assert.ok(instructions.includes("Workflow:\n1. Call list_workflows FIRST"), "the procedure");
    assert.ok(instructions.includes("https://strut.test/"), "the UI");
    assert.ok(instructions.includes("https://strut.test/?secrets=1"), "where a missing credential is added");
    assert.ok(instructions.includes(PROMPT_NAME));
  });

  it("tools/call runs a tool and returns what the chat's model would read — capped where its result is made", async () => {
    const client = await connect();
    // Defaults apply as in the chat (`path` defaults to "steps").
    const listed = await client.callTool({ name: "list_steps", arguments: {} });
    assert.ok(!listed.isError);
    assert.ok(json(listed).entries.includes("core/"), text(listed));
    assert.deepEqual((listed.structuredContent as { entries: string[] }).entries, json(listed).entries, "structuredContent is the same object");

    const capped = await connect({ ...deps, toolResultMaxChars: 300 });
    const step = await capped.callTool({ name: "get_step", arguments: { type: "http" } });
    assert.ok(!step.isError);
    // The cap is per string (capToolOutput): the description is cut, the marker in it.
    assert.ok(text(step).includes("[TRUNCATED:"), "the cap's marker, as the chat reads it");
    const strings: string[] = [];
    JSON.parse(text(step), (_k, v) => (typeof v === "string" && strings.push(v), v));
    assert.ok(strings.every((s) => s.length <= 300), `longest: ${Math.max(...strings.map((s) => s.length))}`);
  });

  it("a generator tool's earlier yields are progress notifications; its last yield is the result", async () => {
    const client = await connect();
    const created = json(await client.callTool({ name: "create_workflow", arguments: { name: "shouter", yaml: YAML("shouter") } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(!("ui" in created), "no ui link without a publicUrl");

    const progress: Array<{ progress: number; message?: string }> = [];
    const run = await client.callTool({ name: "run_workflow", arguments: { name: "shouter", input: { text: "hi" } } }, undefined, {
      onprogress: (p) => void progress.push(p),
    });
    assert.ok(!run.isError, text(run));
    const result = json(run);
    assert.equal(result.status, "success");
    assert.equal(result.output, "HI");
    assert.equal(progress.length, 1, JSON.stringify(progress));
    assert.equal(progress[0]!.progress, 0);
    assert.ok(progress[0]!.message!.includes('"status":"running"'), progress[0]!.message);
    assert.ok(progress[0]!.message!.includes(result.runId));

    // The run is on record, as the chat's would be.
    const read = json(await client.callTool({ name: "get_run", arguments: { name: "shouter", runId: result.runId } }));
    assert.equal(read.status, "success");
  });

  it("a tool's own failure is a result with isError — a missing run, bad arguments — never a protocol error", async () => {
    const client = await connect();
    const missing = await client.callTool({ name: "get_run", arguments: { name: "nope", runId: "1" } });
    assert.equal(missing.isError, true);
    assert.ok(text(missing).includes("not found"), text(missing));

    const bad = await client.callTool({ name: "list_runs", arguments: {} });
    assert.equal(bad.isError, true);
    assert.ok(text(bad).includes("Invalid arguments for list_runs"), text(bad));

    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} });
    assert.equal(unknown.isError, true);
  });

  it("the workflow-builder prompt is the chat's whole system prompt, step catalog included", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map((p) => p.name),
      [PROMPT_NAME],
    );
    const { messages } = await client.getPrompt({ name: PROMPT_NAME });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "user");
    const body = (messages[0]!.content as { type: string; text: string }).text;
    assert.ok(body.startsWith("You are a workflow builder."), body.slice(0, 60));
    assert.ok(body.includes("Available steps:"));
    assert.ok(body.includes("shout"), "the in-code step is in the catalog");
    await assert.rejects(client.getPrompt({ name: "other" }), /Unknown prompt/);
  });

  it("with a public URL: ui deep links, artifact links made absolute, a detached run polled with get_run's wait", async () => {
    const refs = async (runId: string, output: unknown) =>
      (output as { artifacts?: unknown })?.artifacts ? [{ id: "plan", kind: "markdown", title: "Plan", url: `/artifacts/${runId}/plan.md` }] : undefined;
    const client = await connect({
      ...deps,
      publicUrl: "https://strut.test",
      artifactRefs: refs,
      detach: { waitMs: 50, onDetach: () => {}, hint: MCP_DETACH_HINT },
    });
    const { tools } = await client.listTools();
    assert.ok(tools.find((t) => t.name === "run_workflow")!.description!.includes(MCP_DETACH_HINT), "the door's own detach wording");

    const created = json(await client.callTool({ name: "create_workflow", arguments: { name: "deliver", yaml: YAML("deliver", "pack", "artifacts: [{ id: plan, title: Plan, path: plan.md }]") } }));
    assert.equal(created.ui, "https://strut.test/?wf=deliver");
    const edited = json(await client.callTool({ name: "edit_workflow", arguments: { name: "deliver", edits: [{ old: "id: s", new: "id: result" }] } }));
    assert.equal(edited.ui, "https://strut.test/?wf=deliver");

    const run = json(await client.callTool({ name: "run_workflow", arguments: { name: "deliver", input: {} } }));
    assert.equal(run.status, "success", JSON.stringify(run));
    assert.equal(run.ui, `https://strut.test/?wf=deliver&run=${run.runId}`);
    assert.deepEqual(run.artifacts, [{ id: "plan", kind: "markdown", title: "Plan", url: `https://strut.test/artifacts/${run.runId}/plan.md` }]);
    const read = json(await client.callTool({ name: "get_run", arguments: { name: "deliver", runId: run.runId } }));
    assert.equal(read.ui, run.ui);
    assert.deepEqual(read.summary.artifacts, run.artifacts);

    // A run past the window detaches; `wait` holds get_run until it settles.
    await client.callTool({ name: "create_workflow", arguments: { name: "slowly", yaml: YAML("slowly", "slow", "ms: 400") } });
    const t0 = Date.now();
    const stub = json(await client.callTool({ name: "run_workflow", arguments: { name: "slowly", input: {} } }));
    assert.equal(stub.detached, true, JSON.stringify(stub));
    assert.equal(stub.ui, `https://strut.test/?wf=slowly&run=${stub.runId}`);
    assert.ok(stub.note.includes(MCP_DETACH_HINT), stub.note);
    const early = json(await client.callTool({ name: "get_run", arguments: { name: "slowly", runId: stub.runId } }));
    assert.equal(early.status, "running");
    const done = json(await client.callTool({ name: "get_run", arguments: { name: "slowly", runId: stub.runId, wait: 5000 } }));
    assert.equal(done.status, "success", JSON.stringify(done));
    assert.ok(Date.now() - t0 < 4000, "returned as soon as the run settled, not at the deadline");
  });

  it("mcpToolsFrom maps a media result to image content and skips tools without an execute", async () => {
    const tools = mcpToolsFrom({
      shot: tool({
        description: "a picture",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
        toModelOutput: async () => ({ type: "content", value: [{ type: "text", text: "here" }, { type: "media", data: "AAAA", mediaType: "image/png" }] }),
      }),
      provider: tool({ description: "provider-executed", inputSchema: z.object({}) }),
    });
    assert.deepEqual((await tools.list()).map((t) => t.name), ["shot"]);
    const r = await tools.call("shot", {});
    assert.deepEqual(r.content, [
      { type: "text", text: "here" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    assert.ok(!r.isError);
  });
});
