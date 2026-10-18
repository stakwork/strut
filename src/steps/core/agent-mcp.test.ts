import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../../core.js";
import { standInMcp, type StandInMcp } from "../../test-util/mcp-server.js";
import agent from "./agent.js";

// The caller's MCP servers as an agent's tools (`ctx.mcp`, `mcp: true` by
// default), OFFLINE: a stand-in Anthropic endpoint records what each request
// sends, a stand-in MCP server what the agent called it with.

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const toolUse = (id: string, name: string, input: unknown) =>
  sse({
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
    },
  }) +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
  sse({ type: "message_stop" });

/** Serve one tool call per request, in order. */
async function provider(replies: Array<[string, unknown]>): Promise<{ bodies: any[]; close: () => void }> {
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
  return { bodies, close: () => server.close() };
}

const toolNames = (body: any): string[] => (body.tools as any[]).map((t) => t.name);
/** The tool_result blocks of a request's last message. */
const results = (body: any): any[] => (body.messages.at(-1).content as any[]).filter((b) => b.type === "tool_result");

const TOKEN = "hive-t0ken-1234";

// A registry tool that reports whether the caller's servers reached it.
let seenMcp: unknown[] = [];
const probe = defineStep({
  type: "dev/probe",
  description: "Probe.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    seenMcp.push(ctx.mcp?.map((s) => s.name));
    return { ok: true };
  },
});

describe("agent: the caller's MCP servers", () => {
  let cwd = "";
  let hive: StandInMcp;
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_LLM_PROVIDER", "AI_SDK_LOG_WARNINGS"];
  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "strut-agent-mcp-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    seenMcp = [];
    hive = await standInMcp(
      [
        {
          name: "lookup",
          description: "Look a feature up.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          // A careless server echoes the credential it was sent.
          call: (a) => ({ content: [{ type: "text", text: `feature ${a["id"]} (auth ${TOKEN})` }] }),
        },
        { name: "chart", call: () => ({ content: [{ type: "text", text: "a chart" }, { type: "image", data: "aGk=", mimeType: "image/png" }] }) },
      ],
      { token: TOKEN },
    );
  });
  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await hive.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const run = (cfg: Record<string, unknown>, ctx: Record<string, unknown> = {}) => {
    const events: any[] = [];
    const out = agent.run(
      (agent.input as any).parse({
        cwd, system: "sys", prompt: "look it up", model: "claude-sonnet-4-5",
        finalAnswer: "Report.", toolFilter: ["none"], reasoning: "provider-default", ...cfg,
      }),
      {
        runId: "r1", path: "wf/work", scope: {}, input: undefined, emit: async (e: any) => void events.push(e),
        services: {}, registry: { "dev/probe": probe },
        mcp: [{ name: "hive", url: hive.url, token: TOKEN }],
        ...ctx,
      } as any,
    ) as Promise<any>;
    return { out, events };
  };

  it("its tools are the agent's, called with the caller's token; what comes back is masked of it", async () => {
    const p = await provider([
      ["hive_lookup", { id: "42" }],
      ["final_answer", { answer: "found it" }],
    ]);
    try {
      const { out, events } = run({});
      assert.equal((await out).result, "found it");
      assert.deepEqual(toolNames(p.bodies[0]).filter((n) => n.startsWith("hive_")), ["hive_chart", "hive_lookup"]);
      assert.deepEqual(hive.calls, [{ name: "lookup", args: { id: "42" }, authorization: `Bearer ${TOKEN}` }]);
      const [result] = results(p.bodies[1]);
      assert.ok(JSON.stringify(result).includes("feature 42"));
      assert.ok(!JSON.stringify(p.bodies).includes(TOKEN), "the credential never reaches the model");
      // A run event per call, like any tool, masked too.
      const end = events.find((e) => e.type === "step.end" && e.stepType === "tool:hive_lookup");
      assert.ok(end && end.path === "wf/work/001-hive_lookup", JSON.stringify(events));
      assert.ok(!JSON.stringify(events).includes(TOKEN));
    } finally {
      p.close();
    }
  });

  it("an image a tool returns is shown to the model", async () => {
    const p = await provider([
      ["hive_chart", {}],
      ["final_answer", { answer: "seen" }],
    ]);
    try {
      await run({}).out;
      const [result] = results(p.bodies[1]);
      assert.ok(result.content.some((b: any) => b.type === "image" && b.source?.data === "aGk="), JSON.stringify(result));
    } finally {
      p.close();
    }
  });

  it("its registry tools see the servers; with mcp: false neither the agent nor its tools do", async () => {
    const p = await provider([
      ["dev_probe", {}],
      ["final_answer", { answer: "on" }],
      ["dev_probe", {}],
      ["final_answer", { answer: "off" }],
    ]);
    try {
      await run({ agentTools: ["dev/probe"] }).out;
      await run({ agentTools: ["dev/probe"], mcp: false }).out;
      assert.ok(toolNames(p.bodies[0]).includes("hive_lookup"));
      assert.ok(!toolNames(p.bodies[2]).some((n) => n.startsWith("hive_")));
      assert.deepEqual(seenMcp, [["hive"], undefined]);
    } finally {
      p.close();
    }
  });

  it("a caller's server that is down costs the agent its tools, not the turn", async () => {
    await hive.close();
    const p = await provider([["final_answer", { answer: "without it" }]]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await run({}).out).result, "without it");
      assert.ok(!toolNames(p.bodies[0]).some((n) => n.startsWith("hive_")));
    } finally {
      console.warn = warn;
      p.close();
    }
  });
});
