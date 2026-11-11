import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LAUNCH_TIMEOUT_MS, appOfToken, createBridgeClient, StrutError, unwrapToolResult, STEP_RUN_TOOL, type ToolResult } from "./client.js";

describe("unwrapToolResult", () => {
  it("prefers structuredContent", () => {
    assert.deepEqual(unwrapToolResult("x", { content: [{ type: "text", text: "{\"a\":1}" }], structuredContent: { a: 2 } }), { a: 2 });
  });
  it("parses the text part as JSON, or returns it as text", () => {
    assert.deepEqual(unwrapToolResult("x", { content: [{ type: "text", text: "[1,2]" }] }), [1, 2]);
    assert.equal(unwrapToolResult("x", { content: [{ type: "text", text: "plain" }] }), "plain");
    assert.equal(unwrapToolResult("x", { content: [] }), undefined);
  });
  it("throws a StrutError on isError, with the door's { error } message", () => {
    assert.throws(
      () => unwrapToolResult("run/list", { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not granted: run/list" }) }] }),
      (e: unknown) => e instanceof StrutError && e.message === "not granted: run/list" && e.type === "run/list",
    );
    assert.throws(() => unwrapToolResult("x", { isError: true, content: [{ type: "text", text: "boom" }] }), /boom/);
    assert.throws(() => unwrapToolResult("x", { isError: true, content: [] }), /x failed/);
  });
});

describe("createBridgeClient", () => {
  it("calls step_run with type, config, input and the token as `app`", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const client = createBridgeClient(
      { callServerTool: async (p) => { calls.push(p); return { structuredContent: { ok: true } } as ToolResult; } },
      "tok-1",
    );
    assert.deepEqual(await client.run("run/list", { workflow: "wf" }, { q: 1 }), { ok: true });
    assert.deepEqual(calls, [{ name: STEP_RUN_TOOL, arguments: { type: "run/list", config: { workflow: "wf" }, input: { q: 1 }, app: "tok-1" } }]);
  });
  it("run/launch waits long — a priced public launch returns once the host was paid — and nothing else changes its timeout", async () => {
    const options: unknown[] = [];
    const client = createBridgeClient({ callServerTool: async (_p, o) => { options.push(o); return { structuredContent: { runId: "1" } } as ToolResult; } }, "tok");
    await client.run("run/launch", { workflow: "wf" });
    await client.run("run/get", { workflow: "wf", runId: "1" });
    assert.deepEqual(options, [{ timeout: LAUNCH_TIMEOUT_MS }, undefined]);
    assert.ok(LAUNCH_TIMEOUT_MS > 10 * 60_000, "longer than an invoice lasts");
  });
  it("knows which app it is from the identity — a workspace app at a version — and nothing from anything else", () => {
    const call = { callServerTool: async () => ({ content: [] }) };
    assert.deepEqual(createBridgeClient(call, "app:bench@v2.abc").app, { name: "bench", version: "v2" });
    assert.equal(appOfToken("job:a%2Fb/apps/tracker.abc"), undefined, "a job's app is retired");
    assert.equal(createBridgeClient(call, undefined).app, undefined);
    assert.equal(appOfToken("tok-1"), undefined);
  });
  it("omits what was not given, the token included", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const client = createBridgeClient({ callServerTool: async (p) => { calls.push(p); return { content: [] }; } }, undefined);
    await client.run("app/report-error");
    assert.deepEqual(calls[0]!.arguments, { type: "app/report-error" });
  });
});
