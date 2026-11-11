/**
 * The dream end to end (plans/dream.md): a whole strut on a Ladybug graph
 * with Peel's reader lists and its `Personal` tree. A person takes two turns
 * with the assistant, the second a correction; the shipped `dream` workflow,
 * with a stand-in model, reads both turns, records the correction as a claim
 * about a page of the tree with the turn as its evidence, stamped "janitor",
 * and marks the turns read. A second dream finds nothing new and still
 * reports the claim. With `review`, a change to a page is a proposal and the
 * page is left as it was.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LadybugBackend } from "./backend.js";
import { parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import { createStrut, type Strut } from "../createStrut.js";
import { ORCHESTRATOR_WORKFLOW } from "../orchestrator-seed.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { SYSTEM_WRITER } from "../system-workflows.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

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

const REPORT = "CLAIMS: Summaries are three lines or fewer — missing — session c-1 turn 1, new\nFACTS: none\nPAGES: none\nLEFT ALONE: none";

describe("the dream on the graph, under Peel's reader lists (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let dir = "";
  let provider: http.Server;
  let strut: Strut | undefined;
  /** What the dream's agent was sent as its prompt, and what each of its tools answered. */
  let prompt = "";
  let results: Array<{ name: string; content: string }> = [];
  /** What the stand-in dream does once it has read the claims and the root: record a claim, or edit the root's page. */
  let third: "claim" | "edit" = "claim";
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    // The stand-in model. The assistant answers every turn "Hello."; the dream
    // lists the claims, reads the tree's root, then does `third`, then reports.
    let n = 0;
    const named = new Map<string, string>();
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as { system?: unknown; messages: Array<{ role: string; content: unknown }> };
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (!JSON.stringify(body.system ?? "").includes("keep a tree of Concept pages in step")) return res.end(toolUse(`toolu_${++n}`, "final_answer", { text: "Hello.", artifacts: [] }));
        const parts = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Array<Record<string, any>>;
        prompt = JSON.stringify(body.messages[0]?.content ?? "");
        for (const c of parts) if (c["type"] === "tool_use") named.set(c["id"], c["name"]);
        results = parts.filter((c) => c["type"] === "tool_result").map((c) => ({
          name: named.get(c["tool_use_id"]) ?? "?",
          content: typeof c["content"] === "string" ? c["content"] : JSON.stringify(c["content"]),
        }));
        if (!results.length) return res.end(toolUse(`toolu_${++n}`, "dream_claims", { root: "Personal" }));
        if (results.length === 1) return res.end(toolUse(`toolu_${++n}`, "graph_graph_get", { node_type: "Concept", name: "Personal" }));
        if (results.length === 2) {
          const root = /\\?"ref_id\\?":\s*\\?"([^"\\]+)/.exec(results[1]!.content)?.[1] ?? "";
          if (third === "edit") return res.end(toolUse(`toolu_${++n}`, "graph_edit_node", { ref_id: root, node_data: { description: "changed by the dream" } }));
          return res.end(toolUse(`toolu_${++n}`, "dream_claim", {
            text: "Summaries are three lines or fewer", title: "Summaries too long", about: root, session: "c-1", turn: 1,
            excerpt: "too long, keep summaries to three lines", why: "the reply ran long", outcome: "missing",
          }));
        }
        res.end(text(REPORT));
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
    prompt = "";
    results = [];
    third = "claim";
    dir = join(tmpdir(), `strut-dream-run-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      graph: b,
      store: new MemoryRunStore(),
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false,
      job: false, builder: false, orchestrator: {}, concepts: { personal: true },
      graphReaders: PEEL_READERS,
    });
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
  });
  afterEach(async () => {
    await strut?.close();
    strut = undefined;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Runs `workflow` to its end: its summary. */
  async function runOf(workflow: string, body: unknown = {}): Promise<Record<string, any>> {
    const res = await strut!.app.request(`/workflows/${workflow}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 202, await res.clone().text());
    const { runId } = (await res.json()) as { runId: string };
    for (let i = 0; i < 1500; i++) {
      const s = (await (await strut!.app.request(`/workflows/${workflow}/runs/${runId}`)).json()) as Record<string, any>;
      if (s["status"] && s["status"] !== "running" && !s["partial"]) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${workflow} never finished`);
  }
  const say = (text: string) => runOf(ORCHESTRATOR_WORKFLOW, { input: { prompt: text, session: "c-1" } });
  const rootPage = async () => (await b.query("MATCH (p:Node {node_type: 'Concept', name: 'Personal'}) RETURN p.ref_id AS ref, p.description AS description"))[0]!;

  it("reads the new turns, records the correction as a claim about a page of the tree, marks them read; the next dream finds nothing new", async () => {
    assert.equal((await say("summarise my notes from Monday"))["status"], "success");
    assert.equal((await say("too long, keep summaries to three lines"))["status"], "success");

    const run = await runOf("dream");
    assert.equal(run["status"], "success", JSON.stringify(run));
    assert.match(prompt, /The tree you tend is the Concept `Personal`/);
    assert.match(prompt, /session c-1 · turn 0 · [^\]]+ · success\]\\n(OPENED: [^\\]*\\n)?PERSON: summarise my notes from Monday\\nASSISTANT: Hello\./, prompt.slice(-700));
    assert.match(prompt, /turn 1 · [^\]]+\]\\n(OPENED: [^\\]*\\n)?PERSON: too long, keep summaries to three lines/);
    assert.deepEqual(results.map((r) => r.name), ["dream_claims", "graph_graph_get", "dream_claim"]);
    assert.doesNotMatch(results.map((r) => r.content).join("\n"), /REFUSED|failed/, JSON.stringify(results));
    const out = run["output"] as Record<string, any>;
    assert.equal(out["text"], REPORT);
    assert.deepEqual([out["turns"], out["root"]], [2, "Personal"]);
    assert.deepEqual(out["claims"].map((c: any) => [c.title, c.text, c.concept, c.corrected, c.kept]), [["Summaries too long", "Summaries are three lines or fewer", "Personal", 1, 0]]);
    const [e] = out["claims"][0].evidence;
    assert.deepEqual([e.source, e.session, e.turn, e.excerpt, e.why, e.outcome, e.denies], ["conversation", "c-1", 1, "too long, keep summaries to three lines", "the reply ran long", "missing", false]);
    assert.equal(e.dream, run["runId"], "the evidence names the dream that found it");
    const [claim] = await b.query("MATCH (c:Node {node_type: 'Claim'}) RETURN c.created_by AS by, c.namespace AS ns");
    assert.deepEqual([claim!["by"], claim!["ns"]], [SYSTEM_WRITER, "private"]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "dream", "personal.json"), "utf-8")).marks, { "c-1": 1 });

    results = [];
    const again = await runOf("dream");
    assert.equal(again["status"], "success", JSON.stringify(again));
    assert.equal(results.length, 0, "no model call: nothing new to read");
    assert.equal(again["output"]["text"], "No new turns since the last dream.");
    assert.equal(again["output"]["turns"], 0);
    assert.equal(again["output"]["claims"].length, 1, "the claim is still reported");
    // Another tree is another input: its dream has its own marks, so it reads the turns, and reports only its own claims.
    const other = await runOf("dream", { input: { root: "Elsewhere" } });
    assert.deepEqual([other["output"]["turns"], other["output"]["root"], other["output"]["claims"]], [2, "Elsewhere", []]);
    assert.match(prompt, /The tree you tend is the Concept `Elsewhere`/);
  });

  it("without review a change to a page applies; with review it is a proposal and the page is left as it was", async () => {
    third = "edit";
    await say("always sign off as Tom");
    const applied = await runOf("dream");
    assert.equal(applied["status"], "success", JSON.stringify(applied));
    assert.equal((await rootPage())["description"], "changed by the dream");

    await b.query("MATCH (p:Node {node_type: 'Concept', name: 'Personal'}) SET p.description = 'as it was'");
    await say("and never use emoji");
    results = [];
    const held = await runOf("dream", { input: { review: true } });
    assert.equal(held["status"], "success", JSON.stringify(held));
    assert.equal(results[2]!.name, "graph_edit_node");
    assert.equal((await rootPage())["description"], "as it was", `not applied: ${results[2]!.content}`);
    const { proposals } = (await (await strut!.app.request("/proposals")).json()) as { proposals: Array<{ step: string; status: string }> };
    assert.deepEqual(proposals.map((p) => [p.step, p.status]), [["graph/edit-node", "pending"]]);
  });
});
