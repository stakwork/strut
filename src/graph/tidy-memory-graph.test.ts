/**
 * The graph janitor end to end (plans/graph-step7-peel-interface.md): a
 * whole strut on a Ladybug graph with Peel's host config — the note's
 * `graphReaders` — runs the shipped `tidy-memory` with a stand-in model.
 * It reads graph/duplicates as a job, merges the pair it offers, is stamped
 * "janitor", and stops at the day's cap.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LadybugBackend } from "./backend.js";
import { mergeNodes } from "./merge.js";
import { parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { SYSTEM_DIR, SYSTEM_WRITER, shippedVersionLabel } from "../system-workflows.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

/** The note's lists (plans/graph-step7-peel-interface.md §1). */
const PEEL_READERS = parseGraphReaders({
  assistant: { workflows: ["orchestrator", "peel-automation-run"], namespaces: ["private", "shared"] },
  jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
  apps: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  peers: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  builder: { namespaces: ["*"] },
  ui: { namespaces: ["*"] },
});

const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
const start = sse({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
});
const toolUse = (id: string, name: string, input: unknown) =>
  start +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse({ type: "message_stop" });
const text = (t: string) =>
  start +
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse({ type: "message_stop" });

describe("tidy-memory on the graph, under Peel's reader lists (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let dir = "";
  let provider: http.Server;
  let strut: Strut | undefined;
  /** What each tool answered the model, by tool name. */
  let results: Array<{ name: string; content: string }> = [];
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    // The stand-in model: list the duplicates, merge the first pair (the
    // second name into the first), then say what it did.
    let n = 0;
    const named = new Map<string, string>();
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
        const done = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Array<Record<string, any>>;
        for (const c of done) if (c["type"] === "tool_use") named.set(c["id"], c["name"]);
        const answers = done.filter((c) => c["type"] === "tool_result").map((c) => ({
          name: named.get(c["tool_use_id"]) ?? "?",
          content: typeof c["content"] === "string" ? c["content"] : JSON.stringify(c["content"]),
        }));
        results = answers;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (!answers.length) return res.end(toolUse(`toolu_${++n}`, "graph_duplicates", {}));
        if (answers.length === 1) {
          const pairs = JSON.parse(answers[0]!.content.match(/\[.*\]/s)?.[0] ?? "[]") as Array<{ a: { ref_id: string }; b: { ref_id: string } }>;
          if (!pairs.length) return res.end(text("Nothing to merge"));
          return res.end(toolUse(`toolu_${++n}`, "graph_merge", { keep: pairs[0]!.b.ref_id, duplicate: pairs[0]!.a.ref_id }));
        }
        res.end(text("Merged one pair."));
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
    b = (await lb.open()) as LadybugBackend;
  });
  after(async () => {
    provider.close();
    await lb.close(b);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  beforeEach(async () => {
    await lb.clear(b);
    dir = join(tmpdir(), `strut-tidy-graph-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      graph: b,
      store: new MemoryRunStore(),
      serveUi: false, enableChat: false, scheduler: false, stt: false,
      job: false, orchestrator: false, builder: false, concepts: false,
      graphReaders: PEEL_READERS,
    });
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
  });
  afterEach(async () => {
    await strut?.close();
    strut = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the shipped workflow to its end: its summary. */
  async function tidy(): Promise<Record<string, any>> {
    const res = await strut!.app.request("/workflows/tidy-memory/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 202, await res.clone().text());
    const { runId } = (await res.json()) as { runId: string };
    for (let i = 0; i < 1500; i++) {
      const s = (await (await strut!.app.request(`/workflows/tidy-memory/runs/${runId}`)).json()) as Record<string, any>;
      if (s["status"] && s["status"] !== "running" && !s["partial"]) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("tidy-memory never finished");
  }

  it("finds the pair through graph/duplicates as a job, merges it, stamped janitor", async () => {
    const meta = (await strut!.workspace.getWorkflowMetadata("tidy-memory"))!;
    const yaml = await readFile(join(SYSTEM_DIR, "tidy-memory", "workflow.yaml"), "utf-8");
    assert.equal(meta.active, shippedVersionLabel(yaml), "the shipped version");
    const [, kate, katie] = (await b.nodes.writeMany([
      { type: "Person", data: { name: "Alex Rivera", is_owner: true } },
      { type: "Person", data: { name: "Kate" } },
      { type: "Person", data: { name: "Katie Moss" } },
    ])).map((r) => r.ref_id);

    const run = await tidy();
    assert.equal(run["status"], "success", JSON.stringify(run));
    assert.deepEqual(results.map((r) => r.name), ["graph_duplicates", "graph_merge"]);
    assert.doesNotMatch(results[0]!.content, /REFUSED/, results[0]!.content);
    assert.match(results[1]!.content, /"status":\s*"Success"/, results[1]!.content);
    const merges = await b.query("MATCH (m:Node {node_type: 'Merge'}) RETURN m.kept_ref_id AS keep, m.duplicate_ref_id AS dup, m.created_by AS by");
    assert.equal(merges.length, 1);
    assert.deepEqual([merges[0]!["keep"], merges[0]!["dup"]].sort(), [kate, katie].sort(), "Kate and Katie Moss, the pair offered");
    assert.equal(merges[0]!["by"], SYSTEM_WRITER);
  });

  it("stops at the day's cap: the eleventh merge is refused", async () => {
    const people = Array.from({ length: 11 }, (_, i) => [`Ann${String.fromCharCode(97 + i)} Lee`, `Ann${String.fromCharCode(97 + i)}`]);
    await b.nodes.write({ type: "Person", data: { name: "Alex Rivera", is_owner: true } });
    const ids = (await b.nodes.writeMany(people.flat().map((name) => ({ type: "Person", data: { name } })))).map((r) => r.ref_id);
    // Ten merges the janitor already made today.
    for (let i = 0; i < 10; i++) await mergeNodes(b, { keep: ids[2 * i]!, duplicate: ids[2 * i + 1]!, by: SYSTEM_WRITER });

    const run = await tidy();
    assert.equal(run["status"], "success", JSON.stringify(run));
    assert.deepEqual(results.map((r) => r.name), ["graph_duplicates", "graph_merge"]);
    assert.match(results[1]!.content, /already merged 10 pairs in the last 24 hours/, results[1]!.content);
    assert.equal(Number((await b.query("MATCH (m:Node {node_type: 'Merge'}) RETURN count(m) AS n"))[0]?.["n"]), 10);
  });
});
