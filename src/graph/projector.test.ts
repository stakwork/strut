import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "../core.js";
import { MemoryRunStore } from "../store.js";
import { MemoryChatStore } from "../chat-store.js";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { seedStrutDomain } from "./schema-seed.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { messageText, preview, projectAll, projectChats, projectRun, projectRunEvents, projectRuns, spawnedRunIds } from "./projector.js";
import { runStep } from "../run-step.js";
import { buildRegistry } from "../steps/registry.js";

const cfg = testGraphConfig();
let backend: GraphBackend;

const WF = "harvey-deliver";
const RUN = "1788307097627";
const T0 = Date.parse("2026-09-01T20:00:00Z");
const CONCEPT_A = "11111111-1111-4111-8111-111111111111";
const CONCEPT_B = "22222222-2222-4222-8222-222222222222";
const ts = (i: number) => new Date(T0 + i * 1000).toISOString();
const ev = (i: number, type: RunEvent["type"], path: string, extra: Partial<RunEvent> = {}): RunEvent => ({
  ts: ts(i),
  runId: RUN,
  path,
  type,
  ...extra,
});

/** A run with one agent step that made two tool calls, then finished. */
function sampleEvents(workflowHash: string): RunEvent[] {
  return [
    ev(0, "run.start", WF, { input: { q: "deliver" }, workflowHash, params: { model: "m" } }),
    ev(1, "step.start", `${WF}/plan`, { stepType: "agent", input: { prompt: "Plan the delivery", model: "claude" } }),
    ev(2, "step.start", `${WF}/plan/001-search`, { stepType: "tool:graph/graph-search", input: { query: "docs" } }),
    ev(3, "step.end", `${WF}/plan/001-search`, {
      stepType: "tool:graph/graph-search",
      output: { hits: 3 },
      durationMs: 800,
      // Provenance marker lifted by wrapToolsWithEmit: two concepts, one
      // repeated, one ref this graph will not hold.
      nodes: [{ ref_id: CONCEPT_A, node_type: "Concept" }, { ref_id: CONCEPT_B }, { ref_id: CONCEPT_A }, { ref_id: "not-in-this-graph" }],
    }),
    ev(4, "step.start", `${WF}/plan/002-read`, { stepType: "tool:read", input: { id: "x" } }),
    ev(5, "step.error", `${WF}/plan/002-read`, { stepType: "tool:read", error: { message: "not found" }, durationMs: 10 }),
    ev(6, "step.end", `${WF}/plan`, { stepType: "agent", output: "Plan: ship it", durationMs: 5000 }),
    ev(7, "step.start", `${WF}/ship`, { stepType: "log" }),
    ev(8, "step.end", `${WF}/ship`, { stepType: "log", output: "shipped" }),
    ev(9, "run.end", WF, { output: { delivered: 60 } }),
  ];
}

describe("projectRunEvents (pure)", () => {
  it("derives run, session, and tool-call nodes with previews and log refs", () => {
    const p = projectRunEvents(WF, RUN, sampleEvents("abc123def456"), null)!;
    assert.equal(p.run.type, "StrutRun");
    assert.equal(p.run.data["run_status"], "success");
    assert.equal(p.run.data["workflow_hash"], "abc123def456");
    assert.equal(p.run.data["params_json"], '{"model":"m"}');
    assert.equal(p.run.data["log_ref"], `${WF}/${RUN}`);
    assert.equal(p.run.data["input_preview"], '{"q":"deliver"}');
    assert.equal(p.workflowHash, "abc123def456");

    assert.equal(p.sessions.length, 1);
    assert.equal(p.sessions[0]!.data["prompt_preview"], "Plan the delivery");
    assert.equal(p.sessions[0]!.data["result_preview"], "Plan: ship it");
    assert.equal(p.sessions[0]!.data["model"], "claude");
    assert.equal(p.sessions[0]!.data["duration_ms"], 5000);

    assert.deepEqual(
      p.toolCalls.map((t) => [t.node.data["seq"], t.node.data["tool_name"], t.node.data["error_message"], t.sessionPath]),
      [
        [1, "graph/graph-search", undefined, `${WF}/plan`],
        [2, "read", "not found", `${WF}/plan`],
      ],
    );
    // Accessed refs come from the end event's `nodes`, deduplicated.
    assert.deepEqual(
      p.toolCalls.map((t) => t.accessed.map((n) => n.ref_id)),
      [[CONCEPT_A, CONCEPT_B, "not-in-this-graph"], []],
    );
    assert.equal(p.toolCalls[0]!.accessed[0]!.node_type, "Concept");
  });

  it("uses the summary when present, and marks a finalize-less log stale", () => {
    const events = sampleEvents("h").slice(0, 3);
    assert.equal(projectRunEvents(WF, RUN, events, null)!.run.data["run_status"], "stale");
    const withSummary = projectRunEvents(WF, RUN, events, {
      runId: RUN,
      workflow: WF,
      startedAt: ts(0),
      finishedAt: ts(9),
      durationMs: 9000,
      status: "error",
      input: {},
      error: { message: "boom" },
    })!;
    assert.equal(withSummary.run.data["run_status"], "error");
    assert.equal(withSummary.run.data["error_message"], "boom");
    assert.equal(withSummary.run.data["summary"], "error: boom");
    assert.equal(projectRunEvents(WF, RUN, [], null), null);
  });

  it("preview caps length; messageText + spawnedRunIds read transcripts", () => {
    assert.equal(preview("x".repeat(600))!.length, 500);
    assert.equal(preview({ a: 1 }), '{"a":1}');
    assert.equal(preview(undefined), undefined);
    assert.equal(messageText([{ type: "text", text: "hi" }, { type: "text", text: "there" }]), "hi\nthere");
    assert.equal(messageText("plain"), "plain");
    assert.deepEqual(
      spawnedRunIds([
        { role: "user", content: "go" },
        { role: "tool", content: [{ type: "tool-result", toolName: "run_workflow", output: { type: "json", value: { runId: "1", status: "success" } } }] },
        { role: "tool", content: [{ type: "tool-result", toolName: "list_runs", output: { runs: [{ runId: "99" }] } }] },
      ]),
      ["1"],
    );
  });
});

describe("projector (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let store: MemoryRunStore;
  let ws: Neo4jWorkspaceStore;

  before(async () => {
    backend = await openGraphBackend(cfg!, { embeddings: false, skipBoot: true });
  });
  after(async () => {
    await backend.close();
  });
  beforeEach(async () => {
    await wipeGraph(backend.bolt);
    await seedStrutDomain(backend.bolt);
    store = new MemoryRunStore();
    ws = new Neo4jWorkspaceStore(backend);
    await ws.publishWorkflow(WF, "v1", { steps: [{ id: "plan", type: "agent", config: {} }] });
  });

  const count = async (label: string) =>
    Number((await backend.bolt.run(`MATCH (n:\`${label}\`) RETURN count(n) AS c`))[0]!["c"]);
  const edges = async (edge: string) =>
    Number((await backend.bolt.run(`MATCH (:Data_Bank)-[r:\`${edge}\`]->(:Data_Bank) RETURN count(r) AS c`))[0]!["c"]);

  it("projects runs into StrutRun / StrutAgentSession / StrutToolCall with IN_RUN, IN_SESSION, EXECUTED edges", async () => {
    const hash = (await ws.getWorkflowHash(WF))!;
    for (const e of sampleEvents(hash)) await store.append(WF, RUN, e);
    await store.finalize(WF, RUN, {
      runId: RUN, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, status: "success", input: { q: "deliver" }, output: { delivered: 60 },
    });

    // Two jarvis-style Concept nodes (no Strut label) the search step reported touching.
    for (const [r, name] of [[CONCEPT_A, "a"], [CONCEPT_B, "b"]]) {
      await backend.bolt.run(`CREATE (:Concept:Node:Data_Bank:Domain_general {ref_id: $r, node_key: $k, namespace: "default", name: $n})`, { r, k: `concept-${name}`, n: name });
    }

    const report = await projectRuns(backend, store, { workflows: [WF] });
    assert.deepEqual(
      [report.runs, report.sessions, report.toolCalls, report.edges, report.accessed, report.unresolved, report.skipped],
      [1, 1, 2, 6, 2, 1, 0],
    );
    assert.equal(await count("StrutRun"), 1);
    assert.equal(await count("StrutAgentSession"), 1);
    assert.equal(await count("StrutToolCall"), 2);
    assert.equal(await edges("IN_RUN"), 1);
    assert.equal(await edges("IN_SESSION"), 2);
    assert.equal(await edges("EXECUTED"), 1);

    const run = (await backend.bolt.run(`MATCH (r:StrutRun) RETURN properties(r) AS p`))[0]!["p"] as Record<string, unknown>;
    assert.equal(run["run_status"], "success");
    assert.equal(run["output_preview"], '{"delivered":60}');
    assert.equal(run["unique_source_id"], `strutrun:${RUN}`);
    assert.equal(run["started_at"], Math.floor(T0 / 1000));
    assert.equal(run["duration_ms"], 9000);

    // "which runs executed this version" is one hop.
    const rows = await backend.bolt.run(
      `MATCH (r:StrutRun)-[:EXECUTED]->(v:StrutWorkflowVersion)<-[:ACTIVE_VERSION]-(w:StrutWorkflow) RETURN w.name AS wf, r.run_id AS run`,
    );
    assert.deepEqual(rows, [{ wf: WF, run: RUN }]);

    // ACCESSED: the search call → each concept it reported (the unknown ref
    // is skipped, never an error); the full provenance chain is queryable.
    assert.equal(await edges("ACCESSED"), 2);
    const touched = await backend.bolt.run(
      `MATCH (r:StrutRun)<-[:IN_RUN]-(:StrutAgentSession)<-[:IN_SESSION]-(t:StrutToolCall)-[:ACCESSED]->(c:Concept) RETURN r.run_id AS run, t.tool_name AS tool, c.name AS concept ORDER BY concept`,
    );
    assert.deepEqual(touched, [
      { run: RUN, tool: "graph/graph-search", concept: "a" },
      { run: RUN, tool: "graph/graph-search", concept: "b" },
    ]);
    // Re-projection does not duplicate the edges.
    await projectRuns(backend, store, { workflows: [WF], skipSettled: false });
    assert.equal(await edges("ACCESSED"), 2);
  });

  it("projectRun: a kept single-step run gets EXECUTED → the StrutStepVersion it actually ran, from run.start.stepHashes", async () => {
    const src = (tag: string) =>
      `import { z, defineStep } from "strut";\nexport default defineStep({ type: "clip/compute-times", description: "${tag}", input: z.any(), output: z.any(), run: async () => ({ tag: "${tag}" }) });\n`;
    await ws.publishStep("clip/compute-times", src("one"), "one");
    const registry = (await buildRegistry(await ws.materializeCustomSteps())).registry;
    const r = await runStep("clip/compute-times", registry, {}, { keep: true }, { store, workspace: ws, claims: null });
    assert.deepEqual([r.status, r.kept], ["success", "step:clip/compute-times"]);
    const v1Hash = (await ws.getActiveStepHashes())["clip/compute-times"]!;
    assert.deepEqual(r.events.find((e) => e.type === "run.start")!.stepHashes, { "clip/compute-times": v1Hash });

    // The step is republished BEFORE the run is projected: the edge must
    // still name v1 — the version recorded at launch — never "whatever is active".
    await ws.publishStep("clip/compute-times", src("two"), "two");
    const runRef = await projectRun(backend, store, r.kept!, r.runId);
    assert.ok(runRef);
    const rows = await backend.bolt.run(
      `MATCH (run:StrutRun {run_id: $id})-[:EXECUTED]->(v:StrutStepVersion) RETURN run.ref_id AS ref, run.workflow_name AS wf, run.log_ref AS log, v.content_hash AS hash, v.description AS d`,
      { id: r.runId },
    );
    assert.deepEqual(rows, [{ ref: runRef, wf: "step:clip/compute-times", log: `step:clip/compute-times/${r.runId}`, hash: v1Hash, d: "one" }]);
    assert.equal(await projectRun(backend, store, r.kept!, r.runId), runRef, "idempotent: same StrutRun, no second edge");
    assert.equal(await edges("EXECUTED"), 1);
    assert.equal(await projectRun(backend, store, r.kept!, "nope"), null);

    // Step runs are invisible to the workflow projection, and a run with no
    // recorded hash gets no EXECUTED edge at all (never a guess).
    assert.equal((await projectRuns(backend, store, { workflows: [WF, "clip/compute-times"] })).runs, 0);
    const blind = await runStep("clip/compute-times", registry, {}, { keep: true }, { store, claims: null });
    await projectRun(backend, store, blind.kept!, blind.runId);
    assert.equal(await edges("EXECUTED"), 1);
  });

  it("is idempotent, skips settled runs, and re-projects an unsettled run once it finalizes", async () => {
    const events = sampleEvents("h");
    for (const e of events.slice(0, 7)) await store.append(WF, RUN, e); // no terminal event yet
    let report = await projectRuns(backend, store, { workflows: [WF] });
    assert.equal(report.runs, 1);
    let run = (await backend.bolt.run(`MATCH (r:StrutRun) RETURN r.run_status AS s, r.ref_id AS id`))[0]!;
    assert.equal(run["s"], "stale");

    // Re-run with nothing new: the stale run is re-read (not settled), same nodes.
    report = await projectRuns(backend, store, { workflows: [WF] });
    assert.equal(report.runs, 1);
    assert.equal(await count("StrutRun"), 1);
    assert.equal(await count("StrutToolCall"), 2);
    assert.equal(await edges("IN_SESSION"), 2);

    for (const e of events.slice(7)) await store.append(WF, RUN, e);
    await store.finalize(WF, RUN, {
      runId: RUN, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, status: "success", input: {},
    });
    report = await projectRuns(backend, store, { workflows: [WF] });
    const after = (await backend.bolt.run(`MATCH (r:StrutRun) RETURN r.run_status AS s, r.ref_id AS id`))[0]!;
    assert.equal(after["s"], "success");
    assert.equal(after["id"], run["id"], "upsert keeps the node identity");

    report = await projectRuns(backend, store, { workflows: [WF] });
    assert.deepEqual([report.runs, report.skipped], [0, 1], "settled runs are skipped");
    report = await projectRuns(backend, store, { workflows: [WF], skipSettled: false });
    assert.deepEqual([report.runs, report.skipped], [1, 0]);
    assert.equal(await count("StrutRun"), 1);
  });

  it("projects chats and turns with IN_CHAT edges and SPAWNED edges to runs the chat launched", async () => {
    for (const e of sampleEvents("h")) await store.append(WF, RUN, e);
    const chats = new MemoryChatStore();
    await chats.createChat({ id: "c1", title: "Deliver", model: "claude" });
    await chats.appendMessages("c1", [
      { role: "user", content: "run the delivery" },
      { role: "assistant", content: [{ type: "tool-call", toolName: "run_workflow", input: { name: WF } }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "run_workflow", output: { type: "json", value: { runId: RUN, status: "success" } } }] },
      { role: "assistant", content: [{ type: "text", text: "Done — 60 delivered." }] },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "Any time." },
    ]);

    const report = await projectAll(backend, { store, chatStore: chats, workflows: [WF] });
    assert.deepEqual([report.runs, report.chats, report.turns], [1, 1, 2]);
    assert.equal(await edges("IN_CHAT"), 2);
    assert.equal(await edges("SPAWNED"), 1);
    const turns = await backend.bolt.run(`MATCH (t:StrutTurn) RETURN t.turn AS n, t.user_text_preview AS u, t.assistant_text_preview AS a ORDER BY n`);
    assert.deepEqual(turns, [
      { n: 0, u: "run the delivery", a: "Done — 60 delivered." },
      { n: 1, u: "thanks", a: "Any time." },
    ]);
    const chain = await backend.bolt.run(`MATCH (c:StrutChat)-[:SPAWNED]->(r:StrutRun)<-[:IN_RUN]-(s:StrutAgentSession)<-[:IN_SESSION]-(t:StrutToolCall) RETURN count(t) AS c`);
    assert.equal(chain[0]!["c"], 2, "chat → run → session → tool call provenance chain");

    // Idempotent.
    await projectChats(backend, chats);
    assert.equal(await count("StrutChat"), 1);
    assert.equal(await count("StrutTurn"), 2);
    assert.equal(await edges("IN_CHAT"), 2);
  });
});
