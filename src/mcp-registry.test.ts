import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { standInMcp, type StandInMcp } from "./test-util/mcp-server.js";
import type { Proposal } from "./proposals.js";
import agent from "./steps/core/agent.js";

// The MCP registry (src/mcp-registry.ts): servers registered once, values
// by secret name, their tools granted as `mcp/<server>/<tool>` and gated
// unless read-only. OFFLINE: a stand-in MCP server and a stand-in Anthropic
// endpoint (agent-mcp.test.ts's shape).

const KEY = "lin-key-1234567";
const ALICE = "alice-key-7654321";

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
const toolSchema = (body: any, name: string) => (body.tools as any[]).find((t) => t.name === name)?.input_schema;
const results = (body: any): any[] => (body.messages.at(-1).content as any[]).filter((b) => b.type === "tool_result");

describe("MCP registry", () => {
  let dir = "";
  let strut: Strut<Record<string, unknown>>;
  let linear: StandInMcp;
  let actor: string | undefined;
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AI_SDK_LOG_WARNINGS"];
  let saved: Record<string, string | undefined> = {};
  const req = (method: string, path: string, body?: unknown) =>
    strut.app.request(path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });

  let savedLocal: string | undefined;
  before(async () => {
    // The stand-ins listen on loopback, which a registration refuses unless opted in.
    savedLocal = process.env["STRUT_MCP_LOCAL"];
    process.env["STRUT_MCP_LOCAL"] = "1";
    dir = await mkdtemp(join(tmpdir(), "strut-mcp-registry-"));
    strut = await createStrut({ workspace: new WorkspaceManager(dir), serveUi: false, enableChat: false, scheduler: false, resolveActor: () => actor });
    linear = await standInMcp(
      [
        { name: "list_issues", description: "List issues.", annotations: { readOnlyHint: true }, call: () => ({ content: [{ type: "text", text: `issues (auth ${KEY})` }] }) },
        {
          name: "create_issue",
          description: "Create an issue.",
          inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          call: (a) => ({ content: [{ type: "text", text: `created ${a["title"]}` }] }),
        },
      ],
      { token: KEY },
    );
  });
  after(async () => {
    if (savedLocal === undefined) delete process.env["STRUT_MCP_LOCAL"];
    else process.env["STRUT_MCP_LOCAL"] = savedLocal;
    await linear.close();
    await strut.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    actor = undefined;
    linear.calls.length = 0;
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("registers by secret NAME: validated, listed, read and removed, never a value", async () => {
    assert.equal((await req("PUT", "/mcp-servers/bad name", { url: linear.url })).status, 400);
    assert.equal((await req("PUT", "/mcp-servers/linear", { url: "ftp://x" })).status, 400);
    assert.equal((await req("PUT", "/mcp-servers/linear", { url: "https://u:p@mcp.example" })).status, 400);
    const valueGiven = await req("PUT", "/mcp-servers/linear", { url: linear.url, token: KEY });
    assert.equal(valueGiven.status, 400);
    assert.match(((await valueGiven.json()) as { error: string }).error, /unknown field "token"/);
    assert.equal((await req("PUT", "/mcp-servers/linear", { url: linear.url, tokenSecret: "not a name" })).status, 400);
    assert.equal((await req("PUT", "/mcp-servers/linear", { url: linear.url, tokenSecret: "STRUT_API_KEY" })).status, 400, "strut's own key never rides out");
    assert.equal((await req("PUT", "/mcp-servers/linear", { url: linear.url, headerSecrets: { "X-Key": "STRUT_SECRET_KEY" } })).status, 400);
    assert.equal((await req("PUT", "/mcp-servers/linear", { url: `${linear.url}?api_key=x` })).status, 400, "no key in a query");
    process.env["STRUT_MCP_LOCAL"] = "0";
    try {
      for (const url of ["http://127.0.0.1:1/mcp", "http://localhost/mcp", "http://169.254.169.254/x", "http://[::1]/mcp"]) {
        assert.equal((await req("PUT", "/mcp-servers/local", { url })).status, 400, url);
      }
    } finally {
      process.env["STRUT_MCP_LOCAL"] = "1";
    }
    assert.equal((await req("GET", "/mcp-servers/constructor")).status, 404, "no prototype keys");
    assert.equal((await req("DELETE", "/mcp-servers/toString")).status, 404);

    const put = await req("PUT", "/mcp-servers/linear", { url: linear.url, tokenSecret: "LINEAR_API_KEY" });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { name: "linear", url: linear.url, tokenSecret: "LINEAR_API_KEY" });
    assert.deepEqual(await (await req("GET", "/mcp-servers")).json(), { servers: [{ name: "linear", url: linear.url, tokenSecret: "LINEAR_API_KEY" }] });
    assert.equal((await req("GET", "/mcp-servers/linear")).status, 200);

    await req("PUT", "/mcp-servers/gone", { url: linear.url });
    assert.equal((await req("DELETE", "/mcp-servers/gone")).status, 200);
    assert.equal((await req("DELETE", "/mcp-servers/gone")).status, 404);
    assert.equal((await req("GET", "/mcp-servers/gone")).status, 404);
  });

  it("the probe lists the tools and which ask first, with the actor's own secret before the deployment's", async () => {
    const missing = (await (await req("POST", "/mcp-servers/linear/test")).json()) as { ok: boolean; error?: string };
    assert.deepEqual(missing, { ok: false, error: 'MCP server "linear": the secret LINEAR_API_KEY is not set' });

    await strut.secretStore.set("LINEAR_API_KEY", KEY);
    const ok = (await (await req("POST", "/mcp-servers/linear/test")).json()) as { ok: boolean; tools: unknown[] };
    assert.deepEqual(ok, {
      ok: true,
      tools: [
        { name: "list_issues", description: "List issues.", readOnly: true, gated: false },
        { name: "create_issue", description: "Create an issue.", readOnly: false, gated: true },
      ],
    });

    // Alice's own key wins over the deployment's: the server refuses it.
    assert.equal((await req("PUT", "/actors/alice/secrets/LINEAR_API_KEY", { value: ALICE })).status, 200);
    actor = "alice";
    const asAlice = (await (await req("POST", "/mcp-servers/linear/test")).json()) as { ok: boolean; error?: string };
    assert.equal(asAlice.ok, false);
    assert.ok(!JSON.stringify(asAlice).includes(ALICE), "the error is masked of the credential");
    await req("DELETE", "/actors/alice/secrets/LINEAR_API_KEY");
  });

  it("a custom step may not take an mcp/ name, and params may not widen an mcp/ grant", async () => {
    const { validateStepName } = await import("./workspace.js");
    assert.throws(() => validateStepName("mcp/linear/create_issue"), /registered MCP server/);
    const { grantWidenedBy } = await import("./closure.js");
    const flow = { steps: [{ id: "a", type: "agent", config: { agentTools: "{{ params.tools }}" } }], params: { tools: ["mcp/linear/list_*"] } } as any;
    assert.equal(grantWidenedBy(flow, { tools: ["mcp/linear/list_issues"] }, strut.getRegistry()), null);
    assert.match(grantWidenedBy(flow, { tools: ["mcp/*"] }, strut.getRegistry()) ?? "", /"mcp\/\*" \(params\.tools\)/);
    assert.match(grantWidenedBy(flow, { tools: ["mcp/linear/create_issue"] }, strut.getRegistry()) ?? "", /create_issue/);
    // An MCP tool the flow gates stays gated: approve may only grow.
    const gated = { steps: [{ id: "a", type: "agent", config: { agentTools: ["mcp/linear/*"], approve: "{{ params.approve }}" } }], params: { approve: ["mcp/linear/create_issue"] } } as any;
    assert.match(grantWidenedBy(gated, { approve: [] }, strut.getRegistry()) ?? "", /"mcp\/linear\/create_issue" taken out of approval/);
    assert.equal(grantWidenedBy(gated, { approve: ["mcp/linear/*"] }, strut.getRegistry()), null, "a covering glob keeps it");
  });

  const runAgent = (cfg: Record<string, unknown>) =>
    agent.run(
      (agent.input as any).parse({ cwd: dir, system: "sys", prompt: "go", model: "claude-sonnet-4-5", finalAnswer: "Report.", toolFilter: ["none"], reasoning: "provider-default", ...cfg }),
      { runId: "r1", path: "wf/work", scope: {}, input: undefined, emit: async () => {}, services: strut.services, registry: strut.getRegistry() } as any,
    ) as Promise<any>;

  it("an agent granted mcp/linear/* gets its tools: a read-only one runs, any other becomes a proposal that decide runs once", async () => {
    await strut.secretStore.set("LINEAR_API_KEY", KEY);
    const p = await provider([
      ["linear_list_issues", {}],
      ["linear_create_issue", { title: "Fix it", rationale: "the person asked" }],
      ["final_answer", { answer: "done" }],
    ]);
    try {
      assert.equal((await runAgent({ agentTools: ["mcp/linear/*"] })).result, "done");
      assert.deepEqual(toolNames(p.bodies[0]).filter((n) => n.startsWith("linear_")), ["linear_create_issue", "linear_list_issues"]);
      assert.ok(toolSchema(p.bodies[0], "linear_create_issue").properties.rationale, "a gated tool asks for a rationale");
      assert.ok(!toolSchema(p.bodies[0], "linear_list_issues").properties?.rationale);
      assert.deepEqual(linear.calls.map((c) => c.name), ["list_issues"], "the write did not run");
      assert.ok(!JSON.stringify(p.bodies).includes(KEY), "the key never reaches the model");
      const [proposed] = results(p.bodies[2]);
      const out = JSON.parse(typeof proposed.content === "string" ? proposed.content : proposed.content[0].text);
      assert.equal(out.status, "pending");
      assert.equal(out.step, "mcp/linear/create_issue");

      const rec = (await (await req("GET", `/proposals/${out.proposal}`)).json()) as Proposal;
      assert.deepEqual(rec.input, { title: "Fix it" });
      assert.equal(rec.rationale, "the person asked");
      const decided = (await (await req("POST", `/proposals/${out.proposal}/decide`, { action: "accept" })).json()) as Proposal;
      assert.equal(decided.status, "applied", JSON.stringify(decided.result));
      assert.equal(decided.result?.output, "created Fix it");
      assert.deepEqual(linear.calls.at(-1), { name: "create_issue", args: { title: "Fix it" }, authorization: `Bearer ${KEY}` });
      assert.equal((await req("POST", `/proposals/${out.proposal}/decide`, { action: "accept" })).status, 409, "once");
    } finally {
      p.close();
    }
  });

  it("an agent without the grant gets none of them; approve: gates a read-only tool; ungated runs a write", async () => {
    await strut.secretStore.set("LINEAR_API_KEY", KEY);
    let p = await provider([["final_answer", { answer: "none" }]]);
    try {
      await runAgent({});
      assert.deepEqual(toolNames(p.bodies[0]).filter((n) => n.startsWith("linear_")), []);
    } finally {
      p.close();
    }

    p = await provider([["final_answer", { answer: "x" }]]);
    try {
      await runAgent({ agentTools: ["mcp/linear/list_issues"], approve: ["mcp/linear/list_issues"] });
      assert.deepEqual(toolNames(p.bodies[0]).filter((n) => n.startsWith("linear_")), ["linear_list_issues"]);
      assert.ok(toolSchema(p.bodies[0], "linear_list_issues").properties.rationale, "approve: gates it whatever the hint");
    } finally {
      p.close();
    }

    await req("PUT", "/mcp-servers/linear", { url: linear.url, tokenSecret: "LINEAR_API_KEY", ungated: ["create_*"] });
    p = await provider([
      ["linear_create_issue", { title: "Now" }],
      ["final_answer", { answer: "made" }],
    ]);
    try {
      await runAgent({ agentTools: ["mcp/*"] });
      assert.deepEqual(linear.calls.map((c) => c.name), ["create_issue"]);
    } finally {
      p.close();
      await req("PUT", "/mcp-servers/linear", { url: linear.url, tokenSecret: "LINEAR_API_KEY" });
    }
  });
});
