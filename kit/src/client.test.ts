import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appOfToken, createBridgeClient, StrutError, unwrapToolResult, STEP_RUN_TOOL, type ToolResult } from "./client.js";

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
  it("knows which app it is from the identity — a workspace app, or a job's app — and nothing from anything else", () => {
    const call = { callServerTool: async () => ({ content: [] }) };
    assert.deepEqual(createBridgeClient(call, "app:bench@v2.abc").app, { name: "bench", version: "v2" });
    assert.deepEqual(createBridgeClient(call, "job:a%2Fb/apps/tracker.abc").app, { job: "a/b", path: "apps/tracker" });
    assert.deepEqual(appOfToken("job:j1/apps/v1.2."), { job: "j1", path: "apps/v1.2" }, "unsigned, a dot in the path");
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
