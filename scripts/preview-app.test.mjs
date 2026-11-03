import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CORE_READS, classify, createProxy, grantedWorkflows, stepRunCall } from "./preview-app.mjs";

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`)));
const call = (type, extra = {}) => JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "step_run", arguments: { type, app: "token", ...extra } } });

describe("preview-app: what an app's step_run becomes", () => {
  const allow = new Set([...CORE_READS, "openlaw/runs"]);

  it("keeps the app's own state local, sends a listed read to the live strut, refuses the rest", () => {
    assert.equal(classify("app/state", allow), "local");
    assert.equal(classify("app/report-error", allow), "local");
    assert.equal(classify("run/events", allow), "remote");
    assert.equal(classify("graph/graph-get-batched", allow), "remote");
    assert.equal(classify("openlaw/runs", allow), "remote");
    for (const type of ["run/launch", "run/cancel", "graph/create-node", "graph/query", "graph/walk", "openlaw/task-details", "llm"]) {
      assert.equal(classify(type, allow), "refuse", type);
    }
  });

  it("reads only a single tools/call of step_run", () => {
    assert.deepEqual(stepRunCall(call("run/get", { config: { runId: "r" } })), { id: 7, type: "run/get", config: { runId: "r" }, input: undefined });
    assert.equal(stepRunCall(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })), null);
    assert.equal(stepRunCall(JSON.stringify([JSON.parse(call("run/get"))])), null);
    assert.equal(stepRunCall(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "other", arguments: { type: "run/get" } } })), null);
    assert.equal(stepRunCall("not json"), null);
  });

  it("reads the workflows a manifest grants, flow or block style", () => {
    assert.deepEqual(grantedWorkflows("grants:\n  workflows: [openlaw-run, \"harvey-lab-run\"]\n  steps: []\n"), ["openlaw-run", "harvey-lab-run"]);
    assert.deepEqual(grantedWorkflows("grants:\n  workflows:\n    - score\n    - 'report'\n  steps: []\n"), ["score", "report"]);
    assert.deepEqual(grantedWorkflows("grants:\n  workflows: []\n"), []);
  });
});

describe("preview-app: the proxy", () => {
  const seen = { upstream: [], lab: [] };
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.upstream.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "local" }));
    });
  });
  const lab = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.lab.push({ url: req.url, key: req.headers["x-api-token"], body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url.includes("broken") ? { status: "error", error: { message: "no such run" } } : { status: "success", output: [{ type: "run.start" }] }));
    });
  });
  let proxyUrl;
  let proxy;
  before(async () => {
    const up = await listen(upstream);
    const live = await listen(lab);
    proxy = createProxy({ upstream: up, lab: live, key: "k3y", allow: new Set([...CORE_READS, "custom/broken"]) });
    proxyUrl = await listen(proxy);
  });
  after(() => {
    proxy.close();
    upstream.close();
    lab.close();
  });
  const post = async (body) => (await fetch(`${proxyUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body })).json();

  it("answers a listed read from the live strut, with the key, as a tool result", async () => {
    const out = await post(call("run/events", { config: { workflow: "w", runId: "r" } }));
    assert.deepEqual(out, { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: JSON.stringify([{ type: "run.start" }]) }] } });
    const hit = seen.lab.at(-1);
    assert.equal(hit.url, "/steps/run/events/run");
    assert.equal(hit.key, "k3y");
    assert.deepEqual(hit.body, { config: { workflow: "w", runId: "r" } });
  });

  it("passes a live strut's failure on as the step's error", async () => {
    const out = await post(call("custom/broken"));
    assert.equal(out.result.isError, true);
    assert.deepEqual(JSON.parse(out.result.content[0].text), { error: "no such run" });
  });

  it("refuses a launch without reaching either strut", async () => {
    const before = { lab: seen.lab.length, upstream: seen.upstream.length };
    const out = await post(call("run/launch", { config: { workflow: "w" } }));
    assert.equal(out.result.isError, true);
    assert.match(JSON.parse(out.result.content[0].text).error, /refused in the local preview/);
    assert.equal(seen.lab.length, before.lab);
    assert.equal(seen.upstream.length, before.upstream);
  });

  it("passes the app's own state, the MCP handshake and every other request to the local strut", async () => {
    const before = seen.lab.length;
    assert.deepEqual(await post(call("app/state", { config: { key: "k" } })), { from: "local" });
    assert.deepEqual(await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })), { from: "local" });
    assert.deepEqual(await (await fetch(`${proxyUrl}/apps`)).json(), { from: "local" });
    assert.equal(seen.lab.length, before);
    assert.equal(seen.upstream.at(-1).url, "/apps");
  });
});
