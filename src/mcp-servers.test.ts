import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { jsonSchema, tool } from "ai";
import { mediaOf } from "./core.js";
import { connectMcpTools, mcpHeaders, mcpOrigins, mcpResult, mcpToolName, parseMcpServers } from "./mcp-servers.js";
import { registryToolModelOutput } from "./steps/core/agent.js";
import { standInMcp, type StandInMcp } from "./test-util/mcp-server.js";

// The caller's MCP servers (`POST …/run { mcp }`): the launch field's
// validation, what the log may record of it, and the client the agent step
// builds its tools with — against the SDK's own server.

const deps = { tool, jsonSchema, toModelOutput: registryToolModelOutput };
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("parseMcpServers", () => {
  it("keeps readOnly: true, drops false, rejects anything else", () => {
    const [ro, plain] = parseMcpServers([
      { name: "kb", url: "http://127.0.0.1:1/mcp/knowledge", readOnly: true },
      { name: "other", url: "http://127.0.0.1:1/mcp", readOnly: false },
    ])!;
    assert.equal(ro!.readOnly, true);
    assert.equal("readOnly" in plain!, false);
    assert.throws(() => parseMcpServers([{ name: "kb", url: "http://x/", readOnly: "yes" }]), /readOnly must be a boolean/);
  });

  it("absent or null is none; a valid list keeps only the known fields", () => {
    assert.equal(parseMcpServers(undefined), undefined);
    assert.equal(parseMcpServers(null), undefined);
    assert.deepEqual(
      parseMcpServers([
        { name: "hive", url: "https://hive.example/mcp", token: "t0ken-value", toolFilter: ["list_*"], extra: "dropped" },
        { name: "other-1", url: "http://127.0.0.1:9/mcp", headers: { "x-api-key": "k" }, token: "" },
      ]),
      [
        { name: "hive", url: "https://hive.example/mcp", token: "t0ken-value", toolFilter: ["list_*"] },
        { name: "other-1", url: "http://127.0.0.1:9/mcp", headers: { "x-api-key": "k" } },
      ],
    );
  });

  it("refuses what it cannot use, saying which entry", () => {
    const refused = (raw: unknown, re: RegExp) => assert.throws(() => parseMcpServers(raw), re);
    refused({ name: "a", url: "https://a.example" }, /must be an array/);
    refused(Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, url: "https://a.example" })), /at most 10/);
    refused([{ name: "has space", url: "https://a.example" }], /mcp\[0\]\.name/);
    refused([{ name: "a", url: "https://a.example" }, { name: "a", url: "https://b.example" }], /mcp\[1\]\.name "a" is given twice/);
    refused([{ name: "a" }], /mcp\[0\]\.url \(string\) is required/);
    refused([{ name: "a", url: "not a url" }], /not a valid URL/);
    refused([{ name: "a", url: "file:///etc/passwd" }], /must be http\(s\)/);
    refused([{ name: "a", url: "https://a.example", headers: { n: 1 } }], /headers must map names to strings/);
    refused([{ name: "a", url: "https://a.example", toolFilter: "x" }], /toolFilter must be an array/);
  });

  it("the log's record is names and origins only", () => {
    assert.deepEqual(mcpOrigins([{ name: "hive", url: "https://hive.example/mcp?key=s3cret", token: "t0ken-value" }]), [
      { name: "hive", origin: "https://hive.example" },
    ]);
  });

  it("token is the Authorization, whatever case the headers spelled it in", () => {
    assert.deepEqual(mcpHeaders({ name: "a", url: "https://a.example", headers: { authorization: "Basic x", "x-org": "o" }, token: "tok" }), {
      "x-org": "o",
      Authorization: "Bearer tok",
    });
    assert.deepEqual(mcpHeaders({ name: "a", url: "https://a.example", headers: { authorization: "Basic x" } }), { authorization: "Basic x" });
  });

  it("tool names are what a provider accepts", () => {
    assert.equal(mcpToolName("hive", "list.features"), "hive_list_features");
    assert.equal(mcpToolName("hive", "x".repeat(80)).length, 64);
  });
});

describe("mcpResult", () => {
  it("text joined, Error: first on a failed call, structured content when there is no text, capped", () => {
    assert.equal(mcpResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
    assert.equal(mcpResult({ content: [{ type: "text", text: "no such feature" }], isError: true }), "Error: no such feature");
    assert.equal(mcpResult({ content: [], isError: true }), "Error: the tool reported an error");
    assert.equal(mcpResult({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
    assert.equal(mcpResult({ content: [{ type: "resource_link", uri: "https://x.example/f", name: "f" }] }), "[f](https://x.example/f)");
    const capped = mcpResult(text("x".repeat(500)), 200) as string;
    assert.equal(capped.length, 200);
    assert.match(capped, /TRUNCATED: 500 chars/);
  });

  it("an image rides beside the text as media: the model sees it, the log only the text", () => {
    const out = mcpResult({ content: [{ type: "text", text: "the chart" }, { type: "image", data: "aGk=", mimeType: "image/png" }] });
    assert.deepEqual(out, { text: "the chart" });
    assert.deepEqual(mediaOf(out), [{ mediaType: "image/png", data: "aGk=" }]);
    assert.equal(JSON.stringify(out), '{"text":"the chart"}');
    const shown = registryToolModelOutput(out) as { type: string; value: any[] };
    assert.equal(shown.type, "content");
    assert.equal(shown.value[1].mediaType, "image/png");
  });
});

describe("connectMcpTools", () => {
  const servers: StandInMcp[] = [];
  const serve = async (...args: Parameters<typeof standInMcp>) => {
    const s = await standInMcp(...args);
    servers.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("each server's tools as <server>_<tool>, in name order, filtered, called with the caller's credential", async () => {
    const hive = await serve(
      [
        { name: "list_features", description: "List the features.", call: () => text("f1, f2") },
        { name: "get_feature", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, call: (a) => text(`feature ${a["id"]}`) },
        { name: "delete_feature", call: () => text("gone") },
      ],
      { token: "hive-t0ken" },
    );
    const docs = await serve([{ name: "search", call: () => text("found") }]);
    const mcp = await connectMcpTools(
      [
        { name: "hive", url: hive.url, token: "hive-t0ken", toolFilter: ["get_*", "list_features"] },
        { name: "docs", url: docs.url },
      ],
      deps,
    );
    try {
      assert.deepEqual(Object.keys(mcp.tools), ["docs_search", "hive_get_feature", "hive_list_features"]);
      const get = mcp.tools["hive_get_feature"] as any;
      assert.equal(await get.execute({ id: "42" }, {}), "feature 42");
      assert.deepEqual(hive.calls, [{ name: "get_feature", args: { id: "42" }, authorization: "Bearer hive-t0ken" }]);
      assert.equal((mcp.tools["hive_list_features"] as any).description, "List the features.");
      assert.ok(mcp.secretValues.includes("hive-t0ken"));
    } finally {
      await mcp.close();
      await mcp.close();
    }
  });

  it("a server that refuses the credential or is not there is skipped; the rest still come", async () => {
    const locked = await serve([{ name: "secret", call: () => text("no") }], { token: "right-t0ken" });
    const open = await serve([{ name: "ping", call: () => text("pong") }]);
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      const mcp = await connectMcpTools(
        [
          { name: "locked", url: locked.url, token: "wrong-t0ken" },
          { name: "gone", url: "http://127.0.0.1:1/mcp" },
          { name: "open", url: open.url },
        ],
        deps,
      );
      assert.deepEqual(Object.keys(mcp.tools), ["open_ping"]);
      await mcp.close();
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.filter((w) => /\[mcp\] (locked|gone) \(http:\/\/127\.0\.0\.1:\d+\): skipped/.test(w)).length, 2, warned.join("\n"));
    assert.ok(!warned.join("\n").includes("wrong-t0ken"));
  });

  it("a tool named like one the agent has is skipped; a call that fails comes back as Error: text", async () => {
    const s = await serve([
      { name: "bash", call: () => text("shadow") },
      { name: "boom", call: () => ({ content: [{ type: "text", text: "it broke" }], isError: true }) },
    ]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const mcp = await connectMcpTools([{ name: "srv", url: s.url }], { ...deps, taken: ["srv_bash"] });
      assert.deepEqual(Object.keys(mcp.tools), ["srv_boom"]);
      assert.equal(await (mcp.tools["srv_boom"] as any).execute({}, {}), "Error: it broke");
      await s.close();
      assert.match(await (mcp.tools["srv_boom"] as any).execute({}, {}), /^Error: srv boom failed: /);
      await mcp.close();
    } finally {
      console.warn = warn;
    }
  });
});
