import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../core.js";
import { MemoryRunStore } from "../store.js";
import { MemoryChatStore } from "../chat-store.js";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { seedStrutDomain } from "./schema-seed.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { messageText, preview, projectAll, projectChats, projectRun, projectRunEvents, projectRunOnce, projectRuns, runRef, spawnedRunIds } from "./projector.js";
import { runStep } from "../run-step.js";
import { buildRegistry, coreRegistry } from "../steps/registry.js";
import { createStrut } from "../createStrut.js";
import { runWorkflow } from "../runner.js";

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

  it("stamps an agent's thread: the id from its config, the turn from its output", () => {
    const agent = (i: number, id: string, input: Record<string, unknown>, end: Partial<RunEvent>): RunEvent[] => [
      ev(i, "step.start", `${WF}/${id}`, { stepType: "agent", input: { prompt: "go", ...input } }),
      ev(i + 1, end.error ? "step.error" : "step.end", `${WF}/${id}`, { stepType: "agent", ...end }),
    ];
    const p = projectRunEvents(
      WF,
      RUN,
      [
        ev(0, "run.start", WF),
        ...agent(1, "committed", { session: "t-1/review" }, { output: { result: "ok", session: { id: "t-1/review", turn: 0, offset: 0 } } }),
        // A failed turn committed nothing: it belongs to the thread, without a number.
        ...agent(3, "failed", { session: "t-1/review" }, { error: { message: "session_busy: …" } }),
        ...agent(5, "one-shot", {}, { output: { result: "ok" } }),
        // `"{{ input.session }}/review"` with no session: the step refused it.
        ...agent(7, "refused", { session: "/review" }, { error: { message: "agent: session …" } }),
      ],
      null,
    )!;
    assert.deepEqual(
      p.sessions.map((s) => [s.data["path"], s.data["session_id"], s.data["session_turn"]]),
      [
        [`${WF}/committed`, "t-1/review", 0],
        [`${WF}/failed`, "t-1/review", undefined],
        [`${WF}/one-shot`, undefined, undefined],
        [`${WF}/refused`, undefined, undefined],
      ],
    );
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

  it("a thread is queryable across runs: which nodes each turn of a session touched", async () => {
    for (const [r, name] of [[CONCEPT_A, "a"], [CONCEPT_B, "b"]]) {
      await backend.bolt.run(`CREATE (:Concept:Node:Data_Bank:Domain_general {ref_id: $r, node_key: $k, namespace: "default", name: $n})`, { r, k: `concept-${name}`, n: name });
    }
    // One run per turn; a third run whose agent took no session.
    const turnRun = (runId: string, session: { id: string; turn: number } | null, touched: string): RunEvent[] =>
      [
        ev(0, "run.start", WF),
        ev(1, "step.start", `${WF}/plan`, { stepType: "agent", input: { prompt: "go", ...(session ? { session: session.id } : {}) } }),
        ev(2, "step.start", `${WF}/plan/001-get`, { stepType: "tool:graph/graph-get", input: {} }),
        ev(3, "step.end", `${WF}/plan/001-get`, { stepType: "tool:graph/graph-get", output: {}, nodes: [{ ref_id: touched }] }),
        ev(4, "step.end", `${WF}/plan`, { stepType: "agent", output: { result: "ok", ...(session ? { session: { ...session, offset: 0 } } : {}) } }),
        ev(5, "run.end", WF),
      ].map((e) => ({ ...e, runId }));
    const runs: Array<[string, RunEvent[]]> = [
      ["1788307097001", turnRun("1788307097001", { id: "thread-1", turn: 0 }, CONCEPT_A)],
      ["1788307097002", turnRun("1788307097002", { id: "thread-1", turn: 1 }, CONCEPT_B)],
      ["1788307097003", turnRun("1788307097003", null, CONCEPT_A)],
    ];
    for (const [runId, events] of runs) for (const e of events) await store.append(WF, runId, e);

    const report = await projectRuns(backend, store, { workflows: [WF] });
    assert.deepEqual([report.runs, report.sessions, report.accessed], [3, 3, 3]);
    const thread = await backend.bolt.run(
      `MATCH (s:StrutAgentSession {session_id: $id})<-[:IN_SESSION]-(:StrutToolCall)-[:ACCESSED]->(c:Concept)
       RETURN s.session_turn AS turn, s.run_id AS run, c.name AS concept ORDER BY turn`,
      { id: "thread-1" },
    );
    assert.deepEqual(thread, [
      { turn: 0, run: "1788307097001", concept: "a" },
      { turn: 1, run: "1788307097002", concept: "b" },
    ]);
    const oneShot = await backend.bolt.run(`MATCH (s:StrutAgentSession {run_id: "1788307097003"}) RETURN s.session_id AS id, s.session_turn AS turn`);
    assert.deepEqual(oneShot, [{ id: null, turn: null }]);
  });

  it("createStrut projects every top-level run when it ends — claims or not, success or error; never a check run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-project-"));
    const yaml = (name: string, step: string) => `name: ${name}\nsteps:\n${step}`;
    await ws.publishWorkflowByContent("greets", yaml("greets", `  - id: hi\n    type: log\n    config: { message: "hi" }\n`));
    await ws.publishWorkflowByContent("fails", yaml("fails", `  - id: x\n    type: exec\n    config: { cmd: bash, args: ["-c", "exit 3"] }\n`));
    const runs = () => backend.bolt.run(`MATCH (r:StrutRun) OPTIONAL MATCH (r)-[:EXECUTED]->(v:StrutWorkflowVersion) RETURN r.workflow_name AS wf, r.run_status AS status, v.name AS executed ORDER BY wf`);
    try {
      for (const claims of [false, true]) {
        await backend.bolt.run(`MATCH (r:StrutRun) DETACH DELETE r`);
        const strut = await createStrut({ workspace: ws, store, registry: coreRegistry(), dataDir, claims, serveUi: false, enableChat: false, stt: false, scheduler: false });
        const ok = await strut.run("greets", {});
        const bad = await strut.run("fails", {});
        assert.deepEqual([ok.status, bad.status], ["success", "error"]);
        // The projection is detached from the run; joining it is how a caller waits.
        await projectRunOnce(backend, store, "greets", ok.runId);
        await projectRunOnce(backend, store, "fails", bad.runId);
        assert.deepEqual(
          await runs(),
          [
            { wf: "fails", status: "error", executed: "fails" },
            { wf: "greets", status: "success", executed: "greets" },
          ],
          `claims: ${claims}`,
        );

        // A check run (the verify pass's own) is not a run of the deployment's.
        const check = await runWorkflow(await ws.getWorkflow("greets"), {}, coreRegistry(), { store, services: strut.services, origin: "verify" });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(check.status, "success");
        assert.equal((await runs()).length, 2);
        await strut.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("GET /graph/nodes/:ref_id: a node as the graph holds it now; 404 when it is gone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-node-"));
    const strut = await createStrut({ workspace: ws, store, registry: coreRegistry(), dataDir, serveUi: false, enableChat: false, stt: false, scheduler: false });
    try {
      const wfRef = (await backend.bolt.run(`MATCH (w:StrutWorkflow {name: $n}) RETURN w.ref_id AS r`, { n: WF }))[0]!["r"] as string;
      const res = await strut.app.request(`/graph/nodes/${wfRef}`);
      assert.equal(res.status, 200);
      const node = (await res.json()) as { ref_id: string; node_type: string; name: string; properties: Record<string, unknown> };
      assert.deepEqual([node.ref_id, node.node_type, node.name, node.properties["name"]], [wfRef, "StrutWorkflow", WF, WF]);
      assert.ok(!Object.keys(node.properties).some((k) => /embedding|vector/i.test(k)), "no vectors in a response");
      assert.equal((await strut.app.request("/graph/nodes/not-a-node")).status, 404);
    } finally {
      await strut.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("projectRunOnce: two callers on one run share one projection", async () => {
    for (const e of sampleEvents("h")) await store.append(WF, RUN, e);
    const [a, b] = [projectRunOnce(backend, store, WF, RUN), projectRunOnce(backend, store, WF, RUN)];
    assert.equal(a, b);
    assert.ok(await a);
    const again = projectRunOnce(backend, store, WF, RUN);
    assert.notEqual(again, a, "settled: the next caller projects again");
    assert.equal(await again, await a, "onto the same node");
    assert.equal(await count("StrutRun"), 1);
  });

  it("runRef: the projection in flight, else the settled node the graph holds, else a projection", async () => {
    // A projection reads the run's log; finding the node does not.
    let reads = 0;
    const counting = Object.assign(Object.create(store) as MemoryRunStore, {
      getRunEvents: (wf: string, id: string) => (reads++, store.getRunEvents(wf, id)),
    });
    const events = sampleEvents("h");
    for (const e of events.slice(0, 7)) await store.append(WF, RUN, e); // in flight: no terminal event

    const first = await runRef(backend, counting, WF, RUN);
    assert.ok(first);
    assert.equal(reads, 1, "nothing in the graph: projected");
    assert.equal(await runRef(backend, counting, WF, RUN), first);
    assert.equal(reads, 2, "a stale node is not the run's record: projected again");

    for (const e of events.slice(7)) await store.append(WF, RUN, e);
    const hook = projectRunOnce(backend, counting, WF, RUN); // what the run-end hook does
    assert.equal(await runRef(backend, counting, WF, RUN), first, "joins the projection in flight");
    await hook;
    assert.equal(reads, 3);
    assert.equal(await runRef(backend, counting, WF, RUN), first, "found, not projected");
    assert.equal(reads, 3);

    assert.equal(await runRef(backend, counting, "another-workflow", RUN), null, "a node of another workflow's run is not this run's");
    assert.equal(await runRef(backend, counting, WF, "nope"), null);
    assert.equal(await count("StrutRun"), 1);
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
    await chats.setMeta("c1", { createdBy: "evanfeenstra-s8fhs8efhs8ehf" });
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
    const [chatNode] = await backend.bolt.run(`MATCH (c:StrutChat) RETURN c.created_by AS created_by`);
    assert.equal(chatNode!["created_by"], "evanfeenstra-s8fhs8efhs8ehf", "who started the chat is projected whole");
    assert.equal(await count("StrutTurn"), 2);
    assert.equal(await edges("IN_CHAT"), 2);
  });
});
