import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withAccessedNodes, type AnyStepDef, type RunEvent, type RunSummary } from "../core.js";
import { decideProposal, proposalsCapability, proposalsRoot } from "../proposals.js";
import type { NodeInput } from "./node-writer.js";
import type { EdgeInput } from "./edge-writer.js";
import { NEO4J_DIALECT, neo4jName } from "./neo4j-engine.js";
import { MemoryRunStore } from "../store.js";
import { MemoryChatStore } from "../chat-store.js";
import type { GraphBackend } from "./backend.js";
import { seedStrutDomain } from "./schema-seed.js";
import { edgeCount, nodeCount, rawWrite, seedConceptSchema, testBackends } from "./test-util.js";
import { GraphWorkspaceStore } from "./workspace-store.js";
import {
  conversationNode,
  jobNode,
  messageText,
  preview,
  projectAll,
  projectChat,
  projectChatOnce,
  projectChats,
  projectionsSettled,
  projectProposalOnce,
  projectRun,
  projectRunEvents,
  projectRunOnce,
  projectRuns,
  replyText,
  runRef,
  runsThatRead,
  spawnedRunIds,
  wholeText,
} from "./projector.js";
import { TEXT_MAX_CHARS, WORKFLOW_USAGE_FIELDS } from "./strut-schemas.js";
import type { JobView } from "../job-index.js";
import type { ConversationRecord } from "../conversations.js";
import { runStep } from "../run-step.js";
import { buildRegistry, coreRegistry } from "../steps/registry.js";
import { createStrut } from "../createStrut.js";
import { runWorkflow } from "../runner.js";


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

/** A scheduled run of an app's, launched under another run, whose agent
 *  spent `usage` and went on past a failed tool call, and whose subflow's
 *  child then failed the run. */
function launchedEvents(usage: RunEvent["usage"]): RunEvent[] {
  return [
    ev(0, "run.start", WF, {
      input: {},
      origin: "schedule",
      automation: { id: "auto-1" },
      actor: "alice",
      principal: "bob",
      parentRunId: "1788307090000",
      app: { name: "acme/board", version: "v3" },
    }),
    ev(1, "step.start", `${WF}/plan`, { stepType: "agent", input: { prompt: "go" } }),
    ev(2, "step.start", `${WF}/plan/001-read`, { stepType: "tool:read" }),
    ev(3, "step.error", `${WF}/plan/001-read`, { stepType: "tool:read", error: { message: "HTTP 500" } }),
    ev(4, "step.end", `${WF}/plan`, { stepType: "agent", output: "ok", modelCalls: 3, cost: 0.25, usage }),
    ev(5, "step.start", `${WF}/sub`, { stepType: "subflow" }),
    ev(6, "step.start", `${WF}/sub/fetch`, { stepType: "http" }),
    ev(7, "step.error", `${WF}/sub/fetch`, { stepType: "http", error: { message: "HTTP 500" } }),
    ev(8, "step.error", `${WF}/sub`, { stepType: "subflow", error: { message: "HTTP 500" } }),
    ev(9, "run.error", WF, { error: { message: "HTTP 500" } }),
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

  it("a ref tagged with a peer is another strut's graph's: never accessed here", () => {
    const events: RunEvent[] = [
      ev(0, "run.start", WF, { input: {} }),
      ev(1, "step.start", `${WF}/plan`, { stepType: "agent", input: { prompt: "ask" } }),
      ev(2, "step.start", `${WF}/plan/001-far`, { stepType: "tool:strut/run-workflow", input: { peer: "cloud", workflow: "explore" } }),
      ev(3, "step.end", `${WF}/plan/001-far`, {
        stepType: "tool:strut/run-workflow",
        output: { peer: "cloud", status: "success" },
        nodes: [{ ref_id: CONCEPT_A, node_type: "Concept" }, { ref_id: CONCEPT_B, node_type: "Concept", peer: "cloud" }],
      }),
      ev(4, "step.end", `${WF}/plan`, { stepType: "agent", output: "done" }),
      ev(5, "run.end", WF, { output: "done" }),
    ];
    const p = projectRunEvents(WF, RUN, events, null)!;
    assert.deepEqual(p.toolCalls.map((t) => t.accessed.map((n) => n.ref_id)), [[CONCEPT_A]]);
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

  it("a turn of a thread keeps its words whole: the step's message, the reply's text", () => {
    const said = `Can you check the invoice for Acme? ${"Details follow. ".repeat(60)}The total looks wrong.`;
    const answer = `Checked it. ${"Line by line. ".repeat(60)}The tax was counted twice.`;
    const p = projectRunEvents(
      WF,
      RUN,
      [
        ev(0, "run.start", WF),
        ev(1, "step.start", `${WF}/turn`, {
          stepType: "agent",
          input: { prompt: `Workspaces you can ask: @a, @b. ${said}`, message: said, session: "conv-1" },
        }),
        ev(2, "step.end", `${WF}/turn`, {
          stepType: "agent",
          output: { result: JSON.stringify({ text: answer }), object: { text: answer, artifacts: [] }, session: { id: "conv-1", turn: 3, offset: 0 } },
        }),
        // No `message`: the prompt is what the turn answered.
        ev(3, "step.start", `${WF}/plain`, { stepType: "agent", input: { prompt: said, session: "conv-2" } }),
        ev(4, "step.end", `${WF}/plain`, { stepType: "agent", output: { result: answer, session: { id: "conv-2", turn: 0, offset: 0 } } }),
        // A one-shot agent keeps previews only.
        ev(5, "step.start", `${WF}/janitor`, { stepType: "agent", input: { prompt: said } }),
        ev(6, "step.end", `${WF}/janitor`, { stepType: "agent", output: { result: answer } }),
      ],
      null,
    )!;
    const [turn, plain, oneShot] = p.sessions.map((s) => s.data);
    assert.equal(turn!["message"], said);
    assert.equal(turn!["reply"], answer);
    // The previews read the person's words and the reply, not the wrapper or the JSON.
    assert.equal(turn!["prompt_preview"], preview(said));
    assert.equal(turn!["result_preview"], preview(answer));
    assert.equal(plain!["message"], said);
    assert.equal(plain!["reply"], answer);
    assert.equal(oneShot!["message"], undefined);
    assert.equal(oneShot!["reply"], undefined);
    assert.equal(oneShot!["result_preview"], preview(answer));
  });

  it("wholeText keeps a long text's start and end; replyText reads a reply's text", () => {
    const long = `START ${"x".repeat(TEXT_MAX_CHARS)} END`;
    const kept = wholeText(long)!;
    assert.equal(kept.length, TEXT_MAX_CHARS);
    assert.ok(kept.startsWith("START ") && kept.endsWith(" END") && kept.includes("\n…\n"));
    assert.equal(wholeText("short"), "short");
    assert.equal(wholeText("  "), undefined);
    assert.equal(wholeText({ text: "no" }), undefined);
    assert.equal(replyText("plain"), "plain");
    assert.equal(replyText({ result: "{}", object: { text: "the reply" } }), "the reply");
    assert.equal(replyText({ result: "the result", object: { other: 1 } }), "the result");
    assert.equal(replyText({ steps: 3 }), undefined);
  });

  it("a peer's run opened its threads under peer/ — failed turns included", () => {
    const p = projectRunEvents(
      WF,
      RUN,
      [
        ev(0, "run.start", WF, { origin: "peer" }),
        ev(1, "step.start", `${WF}/ask`, { stepType: "agent", input: { prompt: "go", session: "s1" } }),
        ev(2, "step.end", `${WF}/ask`, { stepType: "agent", output: { result: "ok", session: { id: "peer/s1", turn: 0, offset: 0 } } }),
        ev(3, "step.start", `${WF}/again`, { stepType: "agent", input: { prompt: "go", session: "s1" } }),
        ev(4, "step.error", `${WF}/again`, { stepType: "agent", error: { message: "session_busy: …" } }),
        // A thread named after the run's job, which arrives namespaced:
        // the builder's `session: "{{ input.session || $job }}"`.
        ev(5, "step.start", `${WF}/build`, { stepType: "agent", input: { prompt: "go", session: "peer/j1" } }),
        ev(6, "step.end", `${WF}/build`, { stepType: "agent", output: { result: "ok", session: { id: "peer/j1", turn: 0, offset: 0 } } }),
      ],
      null,
    )!;
    assert.deepEqual(p.sessions.map((s) => [s.data["session_id"], s.data["session_turn"]]), [["peer/s1", 0], ["peer/s1", undefined], ["peer/j1", 0]]);
  });

  it("stamps the run and its sessions with the job, and builds a StrutJob from the index's view (plans/job-index.md §6)", () => {
    const events = sampleEvents("h").map((e) => (e.type === "run.start" ? { ...e, job: "j-1" } : e));
    const p = projectRunEvents(WF, RUN, events, null)!;
    assert.equal(p.job, "j-1");
    assert.equal(p.run.data["job"], "j-1");
    assert.equal(p.sessions[0]!.data["job"], "j-1");
    const bare = projectRunEvents(WF, RUN, sampleEvents("h"), null)!;
    assert.deepEqual([bare.job, "job" in bare.run.data, "job" in bare.sessions[0]!.data], [undefined, false, false]);

    const view: JobView = {
      job: "j-1", title: "Landing page", createdBy: "ann", createdAt: ts(0), usedAt: ts(5),
      holds: [], repos: [], files: ["plan.md"],
      runs: [{ workflow: WF, runId: RUN, at: ts(0), status: "success" }],
      sessions: [],
      artifacts: [
        { id: "plan", kind: "markdown", title: "Plan", summary: "the landing page", url: "/jobs/j-1/files/plan.md", runId: RUN, path: "plan.md" },
        { id: "pod", kind: "url", title: "Pod", url: "https://pod.example/", runId: RUN },
      ],
      text: "drafted",
    };
    assert.deepEqual(jobNode(view), {
      type: "StrutJob",
      data: {
        job_id: "j-1", title: "Landing page", summary: "Plan — the landing page\nPod\ndrafted",
        started_at: ts(0), last_used_at: ts(5), run_count: 1, artifact_count: 2, log_ref: "j-1", unique_source_id: "strutjob:j-1",
      },
      // Who launched it is the core `created_by`, the writer's stamp.
      created_by: "ann",
    });
    // No title: the id names it. No record stamp: the oldest run's time.
    const { title: _t, createdAt: _c, ...nameless } = view;
    assert.deepEqual([jobNode(nameless).data["title"], jobNode(nameless).data["started_at"]], ["j-1", ts(0)]);
  });

  it("an assistant conversation is a StrutChat of kind assistant: its title, last status, turn count, and who first spoke", () => {
    const rec: ConversationRecord = {
      id: "ann/c1", title: "Find the landing page", createdAt: ts(0), updatedAt: ts(9), rev: 4, viewers: ["ann", "bob"],
      turns: [
        { runId: "1", workflow: "orchestrator", at: ts(0), wake: true, status: "success" },
        { runId: "2", workflow: "orchestrator", at: ts(1), by: "ann", status: "success" },
        { runId: "3", workflow: "orchestrator", at: ts(5), by: "bob", status: "error" },
        { runId: "4", workflow: "orchestrator", at: ts(9), by: "ann" },
      ],
    };
    assert.deepEqual(conversationNode(rec), {
      type: "StrutChat",
      data: {
        chat_id: "ann/c1", kind: "assistant", title: "Find the landing page",
        started_at: ts(0), last_active_at: ts(9), turn_count: 4, log_ref: "ann/c1", unique_source_id: "strutchat:ann/c1",
      },
      // A wake turn speaks for nobody: the first person who did.
      created_by: "ann",
    });
    rec.turns[3]!.status = "success";
    assert.equal(conversationNode(rec).data["status"], "success", "the last turn's status, once it ended");
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

  it("records who launched a run and from where, what it spent, and the step that failed it", () => {
    const usage = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 40, totalTokens: 1090 };
    const events = launchedEvents(usage);
    const run = (summary: RunSummary | null) => {
      const data = projectRunEvents(WF, RUN, events, summary)!.run.data;
      const keys = ["origin", "automation_id", "actor", "principal", "parent_run_id", "app", "app_version", "cost_usd", "model_calls", "input_tokens", "output_tokens", "failed_step"];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    };
    assert.deepEqual(run(null), {
      origin: "schedule",
      automation_id: "auto-1",
      actor: "alice",
      principal: "bob",
      parent_run_id: "1788307090000",
      app: "acme/board",
      app_version: "v3",
      // Summed from the log: no summary yet. Input is every token read.
      cost_usd: 0.25,
      model_calls: 3,
      input_tokens: 1050,
      output_tokens: 40,
      // The subflow's child, not the subflow, and never the tool call the agent went on past.
      failed_step: `${WF}/sub/fetch`,
    });

    // The summary's totals win; a run that did not fail names no step, and
    // one that called no model records no spend.
    const totals = { modelCalls: 5, cost: 1, usage: { ...usage, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 } };
    const done = { runId: RUN, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, input: {} };
    assert.deepEqual([run({ ...done, status: "error", totals }).model_calls, run({ ...done, status: "error", totals }).input_tokens], [5, 10]);
    assert.equal(run({ ...done, status: "cancelled", totals }).failed_step, undefined);
    const quiet = projectRunEvents(WF, RUN, sampleEvents("h"), null)!.run.data;
    assert.deepEqual(["cost_usd", "model_calls", "failed_step", "origin", "app"].filter((k) => k in quiet), []);
  });

  it("preview caps length; messageText + spawnedRunIds read transcripts", () => {
    assert.equal(preview("x".repeat(600))!.length, 500);
    assert.equal(preview({ a: 1 }), '{"a":1}');
    assert.equal(preview(undefined), undefined);
    assert.equal(messageText([{ type: "text", text: "hi" }, { type: "text", text: "there" }]), "hi\nthere");
    assert.equal(messageText("plain"), "plain");
    // The model's thinking is not what it said.
    assert.equal(messageText([{ type: "reasoning", text: "let me think" }, { type: "text", text: "the answer" }, { type: "tool-call", toolName: "x" }]), "the answer");
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

for (const tb of testBackends()) describe(`projector on ${tb.name}`, { skip: tb.skip }, () => {
  /** A core property as this engine stores it (Neo4j keeps Jarvis's names). */
  const neo4jOr = (name: string) => (tb.name === "neo4j" ? neo4jName(name) : name);
  const neo = tb.kind === "neo4j";
  const neoOnly = (why: string) => ({ skip: neo ? false : `neo4j only: ${why}` });
  let backend: GraphBackend;
  let store: MemoryRunStore;
  let ws: GraphWorkspaceStore;
  const d = () => backend.dialect;

  before(async () => {
    backend = await tb.open();
  });
  after(async () => {
    await tb.close(backend);
  });
  beforeEach(async () => {
    await tb.wipe(backend);
    await seedStrutDomain(backend);
    store = new MemoryRunStore();
    ws = new GraphWorkspaceStore(backend);
    await ws.publishWorkflow(WF, "v1", { steps: [{ id: "plan", type: "agent", config: {} }] });
  });

  const count = (type: string) => nodeCount(backend, type);
  const edges = (edge: string) => edgeCount(backend, edge);

  it("a file holds the run and its edges alone: agent sessions, tool calls and chats are skipped", { skip: neo && "ladybug only" }, async () => {
    const hash = (await ws.getWorkflowHash(WF))!;
    for (const e of sampleEvents(hash)) await store.append(WF, RUN, e);
    // A conversation's record changes nothing: its turns' sessions are not here.
    const conversations = { record: async (id: string) => ({ id, title: "t", createdAt: ts(0), updatedAt: ts(0), rev: 1, viewers: [], turns: [] }) };
    const report = await projectRuns(backend, store, { workflows: [WF], conversations });
    assert.deepEqual(
      [report.runs, report.sessions, report.toolCalls, report.chats, report.edges, report.accessed, report.unresolved, report.skipped],
      [1, 0, 0, 0, 1, 0, 3, 0],
      "the three refs the tool call reported are not in the file: counted, no edge",
    );
    assert.equal(await count("StrutRun"), 1);
    assert.equal(await edges("EXECUTED"), 1);
    assert.equal(await edgeCount(backend), 3, "VERSION_OF + ACTIVE_VERSION from the publish, EXECUTED from the projection — nothing else");
    const chats = new MemoryChatStore();
    await chats.createChat({ id: "c1", title: "Deliver", model: "claude" });
    await chats.appendMessages("c1", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    assert.deepEqual((await projectChats(backend, chats)).chats, 0);
  });

  it("projects runs into StrutRun / StrutAgentSession / StrutToolCall with IN_RUN, IN_SESSION, EXECUTED edges", neoOnly("agent sessions, tool calls and ACCESSED are not in the file"), async () => {
    const hash = (await ws.getWorkflowHash(WF))!;
    for (const e of sampleEvents(hash)) await store.append(WF, RUN, e);
    await store.finalize(WF, RUN, {
      runId: RUN, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, status: "success", input: { q: "deliver" }, output: { delivered: 60 },
    });

    // Two jarvis-style Concept nodes (no Strut label) the search step reported touching.
    for (const [r, name] of [[CONCEPT_A, "a"], [CONCEPT_B, "b"]]) {
      await rawWrite(backend, `CREATE (:Concept:Node:Data_Bank:Domain_general {ref_id: $r, node_key: $k, namespace: "default", name: $n})`, { r, k: `concept-${name}`, n: name });
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

    const run = (await backend.query(`MATCH (r:StrutRun) RETURN properties(r) AS p`))[0]!["p"] as Record<string, unknown>;
    assert.equal(run["run_status"], "success");
    assert.equal(run["output_preview"], '{"delivered":60}');
    assert.equal(run["unique_source_id"], `strutrun:${RUN}`);
    assert.equal(run["started_at"], Math.floor(T0 / 1000));
    assert.equal(run["duration_ms"], 9000);

    // "which runs executed this version" is one hop.
    const rows = await backend.query(
      `MATCH (r:StrutRun)-[:EXECUTED]->(v:StrutWorkflowVersion)<-[:ACTIVE_VERSION]-(w:StrutWorkflow) RETURN w.name AS wf, r.run_id AS run`,
    );
    assert.deepEqual(rows, [{ wf: WF, run: RUN }]);

    // ACCESSED: the search call → each concept it reported (the unknown ref
    // is skipped, never an error); the full provenance chain is queryable.
    assert.equal(await edges("ACCESSED"), 2);
    const touched = await backend.query(
      `MATCH (r:StrutRun)<-[:IN_RUN]-(:StrutAgentSession)<-[:IN_SESSION]-(t:StrutToolCall)-[:ACCESSED]->(c:Concept) RETURN r.run_id AS run, t.tool_name AS tool, c.name AS concept ORDER BY concept`,
    );
    assert.deepEqual(touched, [
      { run: RUN, tool: "graph/graph-search", concept: "a" },
      { run: RUN, tool: "graph/graph-search", concept: "b" },
    ]);
    // Re-projection does not duplicate the edges.
    await projectRuns(backend, store, { workflows: [WF], skipSettled: false });
    assert.equal(await edges("ACCESSED"), 2);

    // Concept use, read up through the tool call: no run edge on Neo4j.
    assert.deepEqual((await runsThatRead(backend, CONCEPT_A)).map((r) => [r.run_id, r.workflow_name, r.run_status]), [[RUN, WF, "success"]]);
    assert.deepEqual(await runsThatRead(backend, "not-in-this-graph"), []);
    assert.equal((await backend.query(`MATCH (:StrutRun)-[e:ACCESSED]->() RETURN count(e) AS n`))[0]!["n"], 0);
  });

  it("a file records what a run read: StrutRun -ACCESSED-> each node any step reported, in the run's namespace; runsThatRead shows a use only to a reader of all three", { skip: neo && "ladybug only" }, async () => {
    await seedConceptSchema(backend);
    const mine = await backend.nodes.write({ type: "Concept", data: { name: "Cooking" } }, "create");
    const ours = await backend.nodes.write({ type: "Concept", data: { name: "House rules" } }, "create", { namespace: "shared" });
    const hash = (await ws.getWorkflowHash(WF))!;
    const events = sampleEvents(hash).map((e) =>
      e.path === `${WF}/plan/001-search` && e.type === "step.end"
        ? { ...e, nodes: [{ ref_id: mine.ref_id, node_type: "Concept" }, { ref_id: "not-in-this-graph" }, { ref_id: "elsewhere", peer: "box" }] }
        : // A workflow step's own report (context/concept's): the run read it too.
          e.path === `${WF}/ship` && e.type === "step.end"
          ? { ...e, nodes: [{ ref_id: ours.ref_id }, { ref_id: mine.ref_id }] }
          : e,
    );
    for (const e of events) await store.append(WF, RUN, e);
    const report = await projectRuns(backend, store, { workflows: [WF] });
    assert.deepEqual([report.accessed, report.unresolved, report.edges], [2, 1, 3], "two held nodes, one missing ref, the peer's skipped; + EXECUTED");

    const rows = await backend.query(
      `MATCH ${d().node("r", "StrutRun")}-[e:ACCESSED]->(n:Node) RETURN r.namespace AS run_ns, e.namespace AS edge_ns, n.namespace AS node_ns, n.name AS name ORDER BY name`,
    );
    assert.deepEqual(rows, [
      { run_ns: "private", edge_ns: "private", node_ns: "private", name: "Cooking" },
      { run_ns: "private", edge_ns: "private", node_ns: "shared", name: "House rules" },
    ], "the edge is the run's, whatever the node's namespace");
    await projectRuns(backend, store, { workflows: [WF], skipSettled: false });
    assert.equal(await edges("ACCESSED"), 2, "idempotent");

    const runRefId = (await backend.query(`MATCH ${d().node("r", "StrutRun")} RETURN r.ref_id AS r`))[0]!["r"];
    assert.deepEqual(await runsThatRead(backend, mine.ref_id), [{ run_ref_id: runRefId, run_id: RUN, workflow_name: WF, run_status: "success" }]);
    // The shared page was read by a private run: the run's own reader sees
    // the use, a reader of `shared` alone sees neither the run nor the edge.
    assert.deepEqual(await runsThatRead(backend, ours.ref_id), [], "the node is outside the default list");
    assert.equal((await runsThatRead(backend, ours.ref_id, { namespaces: ["private", "shared"] })).length, 1);
    assert.deepEqual(await runsThatRead(backend, ours.ref_id, { namespaces: ["shared"] }), []);
    assert.deepEqual(await runsThatRead(backend, mine.ref_id, { namespaces: ["shared"] }), []);
  });

  it("a thread is queryable across runs: which nodes each turn of a session touched", neoOnly("agent sessions are not in the file"), async () => {
    for (const [r, name] of [[CONCEPT_A, "a"], [CONCEPT_B, "b"]]) {
      await rawWrite(backend, `CREATE (:Concept:Node:Data_Bank:Domain_general {ref_id: $r, node_key: $k, namespace: "default", name: $n})`, { r, k: `concept-${name}`, n: name });
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
    const thread = await backend.query(
      `MATCH (s:StrutAgentSession {session_id: $id})<-[:IN_SESSION]-(:StrutToolCall)-[:ACCESSED]->(c:Concept)
       RETURN s.session_turn AS turn, s.run_id AS run, c.name AS concept ORDER BY turn`,
      { id: "thread-1" },
    );
    assert.deepEqual(thread, [
      { turn: 0, run: "1788307097001", concept: "a" },
      { turn: 1, run: "1788307097002", concept: "b" },
    ]);
    const oneShot = await backend.query(`MATCH (s:StrutAgentSession {run_id: "1788307097003"}) RETURN s.session_id AS id, s.session_turn AS turn`);
    assert.deepEqual(oneShot, [{ id: null, turn: null }]);
  });

  it("a conversation's turns are IN_CHAT one StrutChat of kind assistant, from the index's record; a thread that is no conversation gets none", neoOnly("agent sessions and chats are not in the file"), async () => {
    const turnRun = (runId: string, session: string, turn: number): RunEvent[] =>
      [
        ev(0, "run.start", WF),
        ev(1, "step.start", `${WF}/plan`, { stepType: "agent", input: { prompt: "go", session } }),
        ev(2, "step.end", `${WF}/plan`, { stepType: "agent", output: { result: "ok", session: { id: session, turn, offset: 0 } } }),
        ev(3, "run.end", WF),
      ].map((e) => ({ ...e, runId }));
    // Two turns of a conversation, one of a job's thread (no record).
    const runs: Array<[string, RunEvent[]]> = [
      ["1788307097001", turnRun("1788307097001", "ann/c1", 0)],
      ["1788307097002", turnRun("1788307097002", "ann/c1", 1)],
      ["1788307097003", turnRun("1788307097003", "job-1", 0)],
    ];
    for (const [runId, events] of runs) for (const e of events) await store.append(WF, runId, e);
    const rec: ConversationRecord = {
      id: "ann/c1", title: "Find the landing page", createdAt: ts(0), updatedAt: ts(3), rev: 2, viewers: ["ann"],
      turns: runs.slice(0, 2).map(([runId]) => ({ runId, workflow: WF, at: ts(0), by: "ann", status: "success" })),
    };
    const asked: string[] = [];
    const conversations = { record: async (id: string) => (asked.push(id), id === rec.id ? rec : null) };

    const report = await projectRuns(backend, store, { workflows: [WF], conversations });
    assert.deepEqual([report.runs, report.sessions, report.chats], [3, 3, 2], "the conversation upserted once per turn's run");
    assert.deepEqual(asked.sort(), ["ann/c1", "ann/c1", "job-1"]);
    assert.equal(await count("StrutChat"), 1);
    const chat = await backend.query(
      `MATCH (s:StrutAgentSession)-[:IN_CHAT]->(c:StrutChat {chat_id: "ann/c1"})
       RETURN c.kind AS kind, c.title AS title, c.turn_count AS turns, c.created_by AS by, s.session_turn AS turn ORDER BY turn`,
    );
    assert.deepEqual(chat, [
      { kind: "assistant", title: "Find the landing page", turns: 2, by: "ann", turn: 0 },
      { kind: "assistant", title: "Find the landing page", turns: 2, by: "ann", turn: 1 },
    ]);
    assert.equal((await backend.query(`MATCH (s:StrutAgentSession {session_id: "job-1"})-[:IN_CHAT]->() RETURN count(*) AS c`))[0]!["c"], 0);

    // Idempotent; a rename reaches the node at the next projection.
    rec.title = "Landing page";
    await projectRuns(backend, store, { workflows: [WF], conversations, skipSettled: false });
    assert.deepEqual([await count("StrutChat"), await edges("IN_CHAT")], [1, 2]);
    assert.equal((await backend.query(`MATCH (c:StrutChat) RETURN c.title AS t`))[0]!["t"], "Landing page");
  });

  it("createStrut projects every top-level run when it ends — claims or not, success or error; never a check run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-project-"));
    const yaml = (name: string, step: string) => `name: ${name}\nsteps:\n${step}`;
    await ws.publishWorkflowByContent("greets", yaml("greets", `  - id: hi\n    type: log\n    config: { message: "hi" }\n`));
    await ws.publishWorkflowByContent("fails", yaml("fails", `  - id: x\n    type: exec\n    config: { cmd: bash, args: ["-c", "exit 3"] }\n`));
    // Every run here has its EXECUTED edge, so a plain MATCH says what an OPTIONAL one would (and Ladybug answers it right).
    const runs = async () =>
      (await backend.query(`MATCH ${d().node("r", "StrutRun")}-[:EXECUTED]->${d().node("v", "StrutWorkflowVersion")} RETURN r.workflow_name AS wf, r.run_status AS status, v.name AS executed`)).sort((a, b) =>
        String(a["wf"]).localeCompare(String(b["wf"])),
      );
    try {
      for (const claims of [false, true]) {
        await rawWrite(backend, `MATCH ${d().node("r", "StrutRun")} DETACH DELETE r`);
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

  it("GET /graph/nodes/:ref_id: a node as the graph holds it now; 404 when it is gone", neoOnly("the Ladybug reader lands in slice 3"), async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-node-"));
    const strut = await createStrut({ workspace: ws, store, registry: coreRegistry(), dataDir, serveUi: false, enableChat: false, stt: false, scheduler: false });
    try {
      const wfRef = (await backend.query(`MATCH ${d().node("w", "StrutWorkflow", { name: "$n" })} RETURN w.ref_id AS r`, { n: WF }))[0]!["r"] as string;
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
    const rows = await backend.query(
      `MATCH ${d().node("run", "StrutRun", { run_id: "$id" })}-[:EXECUTED]->${d().node("v", "StrutStepVersion")} RETURN run.ref_id AS ref, run.workflow_name AS wf, run.log_ref AS log, v.content_hash AS hash, v.description AS d`,
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
    let run = (await backend.query(`MATCH ${d().node("r", "StrutRun")} RETURN r.run_status AS s, r.ref_id AS id`))[0]!;
    assert.equal(run["s"], "stale");

    // Re-run with nothing new: the stale run is re-read (not settled), same nodes.
    report = await projectRuns(backend, store, { workflows: [WF] });
    assert.equal(report.runs, 1);
    assert.equal(await count("StrutRun"), 1);
    if (neo) {
      assert.equal(await count("StrutToolCall"), 2);
      assert.equal(await edges("IN_SESSION"), 2);
    }

    for (const e of events.slice(7)) await store.append(WF, RUN, e);
    await store.finalize(WF, RUN, {
      runId: RUN, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, status: "success", input: {},
    });
    report = await projectRuns(backend, store, { workflows: [WF] });
    const after = (await backend.query(`MATCH ${d().node("r", "StrutRun")} RETURN r.run_status AS s, r.ref_id AS id`))[0]!;
    assert.equal(after["s"], "success");
    assert.equal(after["id"], run["id"], "upsert keeps the node identity");

    report = await projectRuns(backend, store, { workflows: [WF] });
    assert.deepEqual([report.runs, report.skipped], [0, 1], "settled runs are skipped");
    report = await projectRuns(backend, store, { workflows: [WF], skipSettled: false });
    assert.deepEqual([report.runs, report.skipped], [1, 0]);
    assert.equal(await count("StrutRun"), 1);
  });

  it("a StrutRun holds who launched it and from where, what it spent, and the step that failed it", async () => {
    const usage = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 40, totalTokens: 1090 };
    for (const e of launchedEvents(usage)) await store.append(WF, RUN, e);
    await store.finalize(WF, RUN, {
      runId: RUN, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, status: "error", input: {},
      error: { message: "HTTP 500" }, totals: { modelCalls: 3, cost: 0.25, usage },
    });
    assert.ok(await projectRun(backend, store, WF, RUN));
    const fields = ["origin", "automation_id", "actor", "principal", "parent_run_id", "app", "app_version", "cost_usd", "model_calls", "input_tokens", "output_tokens", "failed_step"];
    const [row] = await backend.query(`MATCH ${d().node("r", "StrutRun", { run_id: "$id" })} RETURN ${d().project("r", fields)} AS p`, { id: RUN });
    assert.deepEqual(row!["p"], {
      origin: "schedule",
      automation_id: "auto-1",
      actor: "alice",
      principal: "bob",
      parent_run_id: "1788307090000",
      app: "acme/board",
      app_version: "v3",
      cost_usd: 0.25,
      model_calls: 3,
      input_tokens: 1050,
      output_tokens: 40,
      failed_step: `${WF}/sub/fetch`,
    });
  });

  it("a workflow's run counts on its StrutWorkflow: recounted after each run's projection, backfilled by projectRuns, cleared with the workflow", async () => {
    const hash = (await ws.getWorkflowHash(WF))!;
    const now = Date.now();
    const day = 86_400_000;
    const usage = async (name = WF) => {
      const rows = await backend.query(`MATCH ${d().node("w", "StrutWorkflow", { name: "$n" })} WHERE ${d().live("w")} RETURN ${d().project("w", [...WORKFLOW_USAGE_FIELDS])} AS p`, { n: name });
      return Object.fromEntries(Object.entries((rows[0]?.["p"] ?? {}) as Record<string, unknown>).filter(([, v]) => v != null));
    };
    /** A finished run of `WF` started `ago` ms before now, ending `status`. */
    const run = async (id: string, ago: number, status: RunSummary["status"]) => {
      const startedAt = new Date(now - ago).toISOString();
      const workflowHash = (await ws.getWorkflowHash(WF))!;
      await store.append(WF, id, { ts: startedAt, runId: id, path: WF, type: "run.start", input: {}, workflowHash });
      await store.append(WF, id, { ts: startedAt, runId: id, path: WF, type: status === "success" ? "run.end" : status === "error" ? "run.error" : "run.cancelled" });
      await store.finalize(WF, id, { runId: id, workflow: WF, startedAt, finishedAt: startedAt, durationMs: 1, status, input: {} });
      return projectRunOnce(backend, store, WF, id);
    };
    const secs = (ago: number) => Math.floor((now - ago) / 1000);

    assert.deepEqual(await usage(), {}, "no runs, no counts");
    await run("1001", 60 * day, "success");
    await run("1002", 3 * day, "error");
    await run("1003", 2 * day, "cancelled");
    await run("1004", day, "success");
    const expected = { usage_count: 4, usage_count_30d: 3, success_count: 2, error_count: 1, last_run_at: secs(day), last_run_status: "success" };
    assert.deepEqual(await usage(), expected);

    // Recounted, never incremented: projecting a run again changes nothing.
    await projectRunOnce(backend, store, WF, "1002");
    assert.deepEqual(await usage(), expected);

    // A graph projected before the counts existed gets them from a backfill,
    // settled runs and all.
    await backend.nodes.update((await backend.query(`MATCH ${d().node("w", "StrutWorkflow", { name: "$n" })} RETURN w.ref_id AS r`, { n: WF }))[0]!["r"] as string, { remove: [...WORKFLOW_USAGE_FIELDS] });
    assert.deepEqual(await usage(), {});
    const report = await projectRuns(backend, store, { workflows: [WF] });
    assert.deepEqual([report.runs, report.skipped, report.workflowUsage], [0, 4, 1]);
    assert.deepEqual(await usage(), expected);
    // A workflow the graph holds no node of (a filesystem workspace's) is no error.
    assert.equal((await projectRuns(backend, store, { workflows: ["not-here"] })).workflowUsage, 0);

    // Deleted, then published again under the name: a new workflow, none of
    // the old runs counted.
    await ws.deleteWorkflow(WF);
    await ws.publishWorkflow(WF, "v1", { steps: [{ id: "ship", type: "log", config: {} }] });
    assert.notEqual(await ws.getWorkflowHash(WF), hash);
    assert.deepEqual(await usage(), {}, "the node came back; the delete cleared its counts");
    await run("1005", 0, "error");
    assert.deepEqual(await usage(), { usage_count: 1, usage_count_30d: 1, success_count: 0, error_count: 1, last_run_at: secs(0), last_run_status: "error" });
  });

  it("search finds what was said past the first 500 characters: a thread's turn and a chat's", neoOnly("agent sessions and chats are not in the file"), async () => {
    const filler = "Some context first. ".repeat(40);
    const events: RunEvent[] = [
      ev(0, "run.start", WF),
      ev(1, "step.start", `${WF}/turn`, { stepType: "agent", input: { prompt: `Workspaces you can ask: @a. ${filler}zanzibar`, message: `${filler}zanzibar`, session: "conv-1" } }),
      ev(2, "step.end", `${WF}/turn`, { stepType: "agent", output: { result: "{}", object: { text: `${filler}kilimanjaro` }, session: { id: "conv-1", turn: 0, offset: 0 } } }),
      ev(3, "run.end", WF),
    ];
    for (const e of events) await store.append(WF, RUN, e);
    await projectRuns(backend, store, { workflows: [WF] });

    const chats = new MemoryChatStore();
    await chats.createChat({ id: "c1", title: "Notes" });
    await chats.appendMessages("c1", [
      { role: "user", content: `${filler}quixotic` },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking aloud" }, { type: "text", text: "Looking." }, { type: "tool-call", toolName: "list_steps", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "list_steps", output: { type: "json", value: [] } }] },
      { role: "assistant", content: [{ type: "text", text: `${filler}marmalade` }] },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "Any time." },
    ]);
    await projectChats(backend, chats);

    const [turn] = await backend.query(`MATCH (t:StrutTurn {turn: 0}) RETURN t.user_text AS u, t.assistant_text AS a`);
    assert.equal(turn!["u"], `${filler}quixotic`);
    // Every text of the turn's steps, its thinking and the next turn left out.
    assert.equal(turn!["a"], `Looking.\n\n${filler}marmalade`);

    await backend.bolt.run(`CALL db.awaitIndexes(60)`);
    const found = async (q: string) => (await backend.reader.search({ q })).nodes.map((n) => n.node_type);
    assert.deepEqual(await found("zanzibar"), ["StrutAgentSession"]);
    assert.deepEqual(await found("kilimanjaro"), ["StrutAgentSession"]);
    assert.deepEqual(await found("quixotic"), ["StrutTurn"]);
    assert.deepEqual(await found("marmalade"), ["StrutTurn"]);
  });

  it("projects chats and turns with IN_CHAT edges and SPAWNED edges to runs the chat launched", neoOnly("chats and turns are not in the file"), async () => {
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
    const turns = await backend.query(`MATCH (t:StrutTurn) RETURN t.turn AS n, t.user_text_preview AS u, t.assistant_text_preview AS a ORDER BY n`);
    assert.deepEqual(turns, [
      { n: 0, u: "run the delivery", a: "Done — 60 delivered." },
      { n: 1, u: "thanks", a: "Any time." },
    ]);
    const chain = await backend.query(`MATCH (c:StrutChat)-[:SPAWNED]->(r:StrutRun)<-[:IN_RUN]-(s:StrutAgentSession)<-[:IN_SESSION]-(t:StrutToolCall) RETURN count(t) AS c`);
    assert.equal(chain[0]!["c"], 2, "chat → run → session → tool call provenance chain");

    // Idempotent.
    await projectChats(backend, chats);
    assert.equal(await count("StrutChat"), 1);
    const [chatNode] = await backend.query(`MATCH (c:StrutChat) RETURN c.created_by AS created_by, c.kind AS kind`);
    assert.equal(chatNode!["created_by"], "evanfeenstra-s8fhs8efhs8ehf", "who started the chat is projected whole");
    assert.equal(chatNode!["kind"], "builder");
    assert.equal(await count("StrutTurn"), 2);
    assert.equal(await edges("IN_CHAT"), 2);
  });

  it("createStrut projects a builder chat when each of its turns ends", neoOnly("chats and turns are not in the file"), async () => {
    // A stand-in provider that refuses every call (400, never retried): each
    // turn ends at once, as an error, and its user message is on file.
    const dead = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
    });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const env = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
    const saved = env.map((k) => process.env[k]);
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
    const dataDir = await mkdtemp(join(tmpdir(), "strut-project-chat-"));
    const chats = new MemoryChatStore();
    const strut = await createStrut({ workspace: ws, store, chatStore: chats, registry: coreRegistry(), dataDir, claims: false, serveUi: false, stt: false, scheduler: false });
    const turns = () => backend.query(`MATCH (t:StrutTurn)-[:IN_CHAT]->(c:StrutChat) RETURN c.status AS status, t.turn AS turn, t.user_text_preview AS said ORDER BY turn`);
    // The projection follows the turn's end, detached: poll the graph.
    const projected = async (n: number) => {
      for (let i = 0; i < 200 && (await turns()).length < n; i++) await new Promise((r) => setTimeout(r, 25));
      await projectionsSettled(backend);
    };
    try {
      const send = async (body: object) => {
        const res = await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(res.status, 202);
        return ((await res.json()) as { chatId: string }).chatId;
      };
      const chatId = await send({ message: "start", model: "sonnet" });
      await projected(1);
      assert.deepEqual(await turns(), [{ status: "error", turn: 0, said: "start" }]);

      await send({ chatId, message: "again" });
      await projected(2);
      assert.deepEqual(await turns(), [
        { status: "error", turn: 0, said: "start" },
        { status: "error", turn: 1, said: "again" },
      ]);
      assert.equal(await count("StrutChat"), 1);
    } finally {
      await strut.close();
      dead.close();
      env.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("createStrut projects an assistant conversation when each of its turns ends: one StrutChat, every turn's session IN_CHAT it", neoOnly("agent sessions and chats are not in the file"), async () => {
    // The same refusing provider: each turn fails, and still is a turn.
    const dead = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
    });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const env = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
    const saved = env.map((k) => process.env[k]);
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
    const dataDir = await mkdtemp(join(tmpdir(), "strut-project-conversation-"));
    // A conversation workflow is one with `params.wake` (src/conversations.ts).
    await ws.publishWorkflowByContent(
      "assistant",
      `name: assistant\nparams:\n  wake: "A job ended."\nsteps:\n  - id: turn\n    type: agent\n    config:\n      prompt: "{{ input.prompt }}"\n      session: "{{ input.session }}"\n      model: sonnet\n      toolFilter: [none]\n`,
    );
    const strut = await createStrut({ workspace: ws, store, registry: coreRegistry(), dataDir, claims: false, serveUi: false, stt: false, scheduler: false, enableChat: false, job: false, builder: false, orchestrator: false, autoResume: false });
    const chat = () =>
      backend.query(`MATCH (s:StrutAgentSession)-[:IN_CHAT]->(c:StrutChat) RETURN c.kind AS kind, c.title AS title, c.status AS status, c.turn_count AS turns, s.run_id AS run ORDER BY run`);
    const projected = async (n: number) => {
      for (let i = 0; i < 200 && (await chat()).length < n; i++) await new Promise((r) => setTimeout(r, 25));
      await projectionsSettled(backend);
    };
    try {
      const say = async (prompt: string) => {
        const res = await strut.app.request("/workflows/assistant/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: { prompt, session: "ann/c1" } }) });
        assert.equal(res.status, 202);
        return ((await res.json()) as { runId: string }).runId;
      };
      const first = await say("find the landing page");
      await projected(1);
      assert.deepEqual(await chat(), [{ kind: "assistant", title: "find the landing page", status: "error", turns: 1, run: first }]);

      const second = await say("again");
      await projected(2);
      assert.deepEqual(
        (await chat()).map((r) => [r["run"], r["turns"]]),
        [[first, 2], [second, 2]],
      );
      assert.equal(await count("StrutChat"), 1);
    } finally {
      await strut.close();
      dead.close();
      env.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("a chat links a run it launched whose projection is still in flight", neoOnly("chats are not in the file"), async () => {
    for (const e of sampleEvents("h")) await store.append(WF, RUN, e);
    // The run's projection reads its log slowly: a chat projected meanwhile
    // finds no StrutRun unless it waits for it.
    const slow = Object.assign(Object.create(store) as MemoryRunStore, {
      getRunEvents: async (wf: string, id: string) => (await new Promise((r) => setTimeout(r, 300)), store.getRunEvents(wf, id)),
    });
    const chats = new MemoryChatStore();
    await chats.createChat({ id: "c1", title: "Deliver", model: "claude" });
    await chats.appendMessages("c1", [
      { role: "user", content: "run the delivery" },
      { role: "tool", content: [{ type: "tool-result", toolName: "run_workflow", output: { type: "json", value: { runId: RUN, status: "success" } } }] },
    ]);
    const run = projectRunOnce(backend, slow, WF, RUN); // what the run-end hook does
    const report = await projectChat(backend, chats, "c1");
    assert.deepEqual([report.chats, report.turns], [1, 1]);
    assert.equal(await edges("SPAWNED"), 1);
    await run;
    assert.deepEqual((await projectChat(backend, chats, "nope")).chats, 0, "a chat the store does not have writes nothing");
  });

  it("projectChatOnce: a call during a projection queues one more, which later calls join", neoOnly("chats are not in the file"), async () => {
    const chats = new MemoryChatStore();
    await chats.createChat({ id: "c1", title: "Deliver", model: "claude" });
    await chats.appendMessages("c1", [{ role: "user", content: "hi" }]);
    // The first read waits on a gate, so the first projection is running
    // while the next calls arrive.
    let reads = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const counting = Object.assign(Object.create(chats) as MemoryChatStore, {
      loadMessages: async (id: string) => (++reads === 1 && (await gate), chats.loadMessages(id)),
    });
    const a = projectChatOnce(backend, counting, "c1");
    assert.equal(projectChatOnce(backend, counting, "c1"), a, "not started yet: the next call joins it");
    while (reads === 0) await new Promise((r) => setTimeout(r, 5));
    await chats.appendMessages("c1", [{ role: "assistant", content: "hello" }, { role: "user", content: "again" }]);
    const [b, c] = [projectChatOnce(backend, counting, "c1"), projectChatOnce(backend, counting, "c1")];
    assert.notEqual(b, a);
    assert.equal(b, c, "one projection queued behind the running one");
    open();
    await Promise.all([a, b, c]);
    assert.equal(reads, 2);
    assert.equal(await count("StrutTurn"), 2, "the queued projection read the chat as it was then");
    await projectionsSettled(backend);
  });

  it("a run under a job upserts ONE StrutJob from the index, IN_JOB from each run; no index or no record writes nothing (plans/job-index.md §6)", async () => {
    const hash = (await ws.getWorkflowHash(WF))!;
    const RUN2 = "1788307097999";
    const withJob = (runId: string) => sampleEvents(hash).map((e) => ({ ...e, runId, ...(e.type === "run.start" ? { job: "j-g" } : {}) }));
    for (const e of withJob(RUN)) await store.append(WF, RUN, e);
    for (const e of withJob(RUN2)) await store.append(WF, RUN2, e);
    const view = (runs: string[], text: string): JobView => ({
      job: "j-g", title: "Landing page", usedAt: ts(9), holds: [], repos: [], files: [],
      runs: runs.map((r) => ({ workflow: WF, runId: r, at: ts(0), status: "success" as const })),
      sessions: [],
      artifacts: [{ id: "plan", kind: "markdown", title: "Plan", summary: "the landing page", url: "/jobs/j-g/files/plan.md", runId: runs[0]!, path: "plan.md" }],
      text,
    });
    let current: JobView | null = view([RUN2, RUN], "revised");
    const jobs = { get: async (id: string) => (id === "j-g" ? current : null) };

    const report = await projectRuns(backend, store, { workflows: [WF], jobs });
    assert.deepEqual([report.runs, report.jobs], [2, 2]);
    assert.equal(await count("StrutJob"), 1, "one node per job, upserted per run");
    assert.equal(await edges("IN_JOB"), 2);
    const JOB_FIELDS = ["job_id", "title", "summary", "run_count", "artifact_count", "log_ref", "started_at"];
    const [node] = await backend.query(`MATCH ${d().node("j", "StrutJob")} RETURN ${d().project("j", JOB_FIELDS)} AS p`);
    const p = node!["p"] as Record<string, unknown>;
    assert.deepEqual(
      [p["job_id"], p["title"], p["summary"], p["run_count"], p["artifact_count"], p["log_ref"]],
      ["j-g", "Landing page", "Plan — the landing page\nrevised", 2, 1, "j-g"],
    );
    assert.deepEqual(
      (await backend.query(`MATCH ${d().node("r", "StrutRun")}-[:IN_JOB]->${d().node("j", "StrutJob")} RETURN r.run_id AS run, r.job AS job`)).sort((a, b) => String(a["run"]).localeCompare(String(b["run"]))),
      [{ run: RUN, job: "j-g" }, { run: RUN2, job: "j-g" }],
    );
    // A job's id can hold what the sanitizer would strip: the key is exact.
    const [key] = await backend.query(`MATCH ${d().node("j", "StrutJob")} RETURN ${d().project("j", ["key"])} AS p`);
    assert.match(String((key!["p"] as Record<string, unknown>)["key"]), /^strutjob-[0-9a-f]+$/);

    // Without an index nothing is written, and the node stays; a deleted
    // job (no record) likewise.
    assert.equal((await projectRuns(backend, store, { workflows: [WF], skipSettled: false })).jobs, 0);
    current = null;
    assert.equal((await projectRuns(backend, store, { workflows: [WF], skipSettled: false, jobs })).jobs, 0);
    assert.equal(await count("StrutJob"), 1);
    assert.equal(await edges("IN_JOB"), 2, "re-projection does not duplicate the edges");
  });

  // Two turns of job `j-a`: turn 1 declares `plan` and a PR; turn 2 declares
  // `plan` again (newer text), another strut server's file and one that is
  // not there. `views[n]` is the job index's fold after turn n.
  const RUN2 = "1788307097999";
  async function twoTurns(): Promise<JobView[]> {
    const hash = (await ws.getWorkflowHash(WF))!;
    const declared: Record<string, Array<Record<string, unknown>>> = {
      [RUN]: [{ id: "plan", title: "Plan", path: "plan.md" }, { id: "pr", title: "Fix login", url: "https://github.com/o/r/pull/1" }],
      [RUN2]: [{ id: "plan", title: "Plan v2", path: "plan.md" }, { id: "remote", title: "Remote", path: "x.md", peer: "acme" }, { id: "gone", title: "Gone", path: "gone.md" }],
    };
    for (const r of [RUN, RUN2]) {
      for (const e of sampleEvents(hash)) await store.append(WF, r, { ...e, runId: r, ...(e.type === "run.start" ? { job: "j-a" } : {}) });
      await store.finalize(WF, r, { runId: r, workflow: WF, startedAt: ts(0), finishedAt: ts(9), durationMs: 9000, status: "success", input: {}, output: { artifacts: declared[r] }, job: "j-a" });
    }
    const runs = (ids: string[]) => ids.map((r, i) => ({ workflow: WF, runId: r, at: ts(i), status: "success" as const }));
    const base = { job: "j-a", title: "Job", usedAt: ts(9), holds: [], urls: {}, repos: [], files: [], sessions: [] };
    const pr = { id: "pr", kind: "pull-request", label: "PR", title: "Fix login", summary: "fixes the login redirect", url: "https://github.com/o/r/pull/1", runId: RUN };
    return [
      { ...base, runs: runs([RUN]), artifacts: [{ id: "plan", kind: "markdown", title: "Plan", summary: "first draft", url: "/jobs/j-a/files/plan.md", runId: RUN, path: "plan.md" }, pr] },
      {
        ...base, runs: runs([RUN2, RUN]),
        artifacts: [
          { id: "plan", kind: "markdown", title: "Plan v2", summary: "second draft", url: "/jobs/j-a/files/plan.md", runId: RUN2, path: "plan.md" },
          { id: "remote", kind: "markdown", title: "Remote", peer: "acme", job: "peer/j-a", path: "x.md", runId: RUN2 },
          { id: "gone", kind: "markdown", title: "Gone", error: "not found: gone.md", runId: RUN2 },
          pr,
        ],
      },
    ] as JobView[];
  }

  it("job artifacts: one StrutArtifact per (job, id) with its attributes, HAS_ARTIFACT from the job, DELIVERED from each run that declared it; a later turn updates the same node; searchable by kind", async () => {
    const views = await twoTurns();
    let current = views[0]!;
    const jobs = { get: async () => current };
    await projectRun(backend, store, WF, RUN, undefined, jobs);
    assert.equal(await count("StrutArtifact"), 2);
    assert.equal(await edges("HAS_ARTIFACT"), 2);
    assert.equal(await edges("DELIVERED"), 2);

    current = views[1]!;
    await projectRun(backend, store, WF, RUN2, undefined, jobs);
    assert.equal(await count("StrutArtifact"), 2, "same node updated; the peer's and the missing one are not written");
    assert.equal(await edges("HAS_ARTIFACT"), 2);
    assert.equal(await edges("DELIVERED"), 3, "run 2 delivered the new plan; run 1 keeps its edges");

    const FIELDS = ["job_id", "artifact_id", "kind", "title", "summary", "url", "path", "run_id"];
    const rows = await backend.query(`MATCH ${d().node("a", "StrutArtifact", { artifact_id: "$id" })} RETURN ${d().project("a", FIELDS)} AS p`, { id: "plan" });
    assert.deepEqual(rows.map((r) => r["p"]), [{ job_id: "j-a", artifact_id: "plan", kind: "markdown", title: "Plan v2", summary: "second draft", url: "/jobs/j-a/files/plan.md", path: "plan.md", run_id: RUN2 }]);
    const [pr] = await backend.query(`MATCH ${d().node("a", "StrutArtifact", { artifact_id: "$id" })} RETURN a.label AS label, a.kind AS kind`, { id: "pr" });
    assert.deepEqual([pr!["label"], pr!["kind"]], ["PR", "pull-request"]);

    // Walk: job → artifacts, and run → artifacts.
    const viaJob = await backend.query(`MATCH ${d().node("j", "StrutJob")}-[:HAS_ARTIFACT]->${d().node("a", "StrutArtifact")} RETURN a.artifact_id AS id ORDER BY id`);
    assert.deepEqual(viaJob.map((r) => r["id"]), ["plan", "pr"]);
    const viaRun = await backend.query(`MATCH ${d().node("r", "StrutRun", { run_id: "$r" })}-[:DELIVERED]->${d().node("a", "StrutArtifact")} RETURN a.artifact_id AS id ORDER BY id`, { r: RUN2 });
    assert.deepEqual(viaRun.map((r) => r["id"]), ["plan"]);

    // Filter and search by kind.
    const byKind = await backend.query(`MATCH ${d().node("a", "StrutArtifact", { kind: "$k" })} RETURN a.artifact_id AS id`, { k: "pull-request" });
    assert.deepEqual(byKind.map((r) => r["id"]), ["pr"]);
    // `kind` and `label` are part of the search text (what the FTS index and the
    // embedding read), so a kind finds its artifacts by keyword and by meaning.
    const [bank] = await backend.query(`MATCH ${d().node("a", "StrutArtifact", { artifact_id: "$id" })} RETURN a.${neo4jOr("search_text")} AS b`, { id: "pr" });
    // A Ladybug file keeps it on one line: its full-text index splits on spaces alone.
    assert.equal(bank!["b"], neo ? "Fix login\nfixes the login redirect\npull-request\nPR" : "Fix login fixes the login redirect pull-request PR");
    const hit = await backend.reader.search({ q: "login", types: ["StrutArtifact"] });
    assert.deepEqual(hit.nodes.map((n) => n.node_type), ["StrutArtifact"]);
  });

  it("job artifacts, backfilled: projected after both turns, in either order, each run gets the DELIVERED edges its own output declares", async () => {
    const views = await twoTurns();
    const jobs = { get: async () => views[1]! };
    await projectRun(backend, store, WF, RUN2, undefined, jobs);
    await projectRun(backend, store, WF, RUN, undefined, jobs);
    const delivered = async (r: string) =>
      (await backend.query(`MATCH ${d().node("r", "StrutRun", { run_id: "$r" })}-[:DELIVERED]->${d().node("a", "StrutArtifact")} RETURN a.artifact_id AS id ORDER BY id`, { r })).map((x) => x["id"]);
    assert.deepEqual(await delivered(RUN), ["plan", "pr"], "run 1 delivered the first plan, though the node now holds the second");
    assert.deepEqual(await delivered(RUN2), ["plan"]);
  });

  it("job artifacts: `from` is a DERIVED_FROM edge to each node it names that the graph holds; another graph's ref is skipped; a re-projection adds none", async () => {
    await seedConceptSchema(backend);
    const [rule] = await backend.nodes.writeMany([{ type: "Concept", data: { name: "NDA drafting rules", description: "How an NDA is drafted here" } }], "create");
    const elsewhere = "00000000-0000-4000-8000-00000000dead";
    const views = await twoTurns();
    const view = { ...views[0]!, artifacts: views[0]!.artifacts.map((a) => (a.id === "plan" ? { ...a, from: [rule!.ref_id, elsewhere] } : a)) };
    const jobs = { get: async () => view };
    await projectRun(backend, store, WF, RUN, undefined, jobs);
    const derived = async () =>
      (await backend.query(`MATCH ${d().node("a", "StrutArtifact")}-[:DERIVED_FROM]->${d().node("c", "Concept")} RETURN a.artifact_id AS id, c.name AS name`)).map((r) => [r["id"], r["name"]]);
    assert.deepEqual(await derived(), [["plan", "NDA drafting rules"]]);
    assert.equal(await edges("DERIVED_FROM"), 1);
    await projectRun(backend, store, WF, RUN, undefined, jobs);
    assert.equal(await edges("DERIVED_FROM"), 1);
  });

  it("proposals: a StrutProposal per gated call — written when made, IN_RUN once the run is projected, moved by each decision; an applied one is ACCESSED to the nodes it wrote the graph holds", async () => {
    await seedConceptSchema(backend);
    const [rule] = await backend.nodes.writeMany([{ type: "Concept", data: { name: "Rate limits", description: "How the API limits callers" } }], "create");
    const elsewhere = "00000000-0000-4000-8000-00000000dead";
    const dir = await mkdtemp(join(tmpdir(), "strut-project-proposal-"));
    try {
      // What createStrut wires: every change of a record projects it.
      const cap = proposalsCapability(dir, { changed: (p) => void projectProposalOnce(backend, cap, p.id) });
      const by = { workflow: WF, runId: RUN, path: `${WF}/plan/003-graph-create-node`, job: "j-p", session: "alice/1", actor: "alice" };
      const a = await cap.propose({ step: "dev/write", input: { name: "Rate limits" }, rationale: "The API docs say callers are throttled", title: "Write the rate-limit page", by });
      const b = await cap.propose({ step: "dev/write", input: { name: "Retries" }, title: "Write the retry page", by });
      await projectionsSettled(backend);
      assert.equal(await count("StrutProposal"), 2);
      assert.equal(await edges("IN_RUN"), 0, "the run is not in the graph yet");

      // The run ends: its projection links each of its proposals.
      const hash = (await ws.getWorkflowHash(WF))!;
      for (const e of sampleEvents(hash)) await store.append(WF, RUN, e);
      const report = { runs: 0, sessions: 0, toolCalls: 0, chats: 0, turns: 0, edges: 0, accessed: 0, unresolved: 0, skipped: 0, jobs: 0, proposals: 0, workflowUsage: 0 };
      assert.ok(await projectRun(backend, store, WF, RUN, report, undefined, undefined, cap));
      assert.equal(report.proposals, 2);
      const inRun = async () =>
        (await backend.query(`MATCH ${d().node("p", "StrutProposal")}-[:IN_RUN]->${d().node("r", "StrutRun", { run_id: "$r" })} RETURN p.proposal_id AS id ORDER BY id`, { r: RUN })).map((r) => r["id"]);
      assert.deepEqual(await inRun(), [a.id, b.id].sort());

      // A person rejects one and accepts the other; its apply wrote a node
      // this graph holds, one it does not, and one on a peer's graph.
      const step: AnyStepDef = {
        type: "dev/write",
        input: z.object({ name: z.string() }),
        output: z.any(),
        run: async () => withAccessedNodes({ ok: true }, [{ ref_id: rule!.ref_id, node_type: "Concept" }, { ref_id: elsewhere }, { ref_id: "peer-ref", peer: "acme" }]),
      } as AnyStepDef;
      const deps = { registry: { "dev/write": step }, services: {}, changed: (p: { id: string }) => void projectProposalOnce(backend, cap, p.id) };
      assert.equal((await decideProposal(proposalsRoot(dir), b.id, { action: "reject", by: "alice", reason: "not now" }, deps)).status, 200);
      assert.equal((await decideProposal(proposalsRoot(dir), a.id, { action: "accept", by: "alice" }, deps)).status, 200);
      await projectionsSettled(backend);

      const FIELDS = ["proposal_id", "step", "title", "proposal_status", "rationale", "workflow_name", "run_id", "job_id", "session_id", "proposed_by", "decided_by", "reason"];
      const props = async (id: string) =>
        ((await backend.query(`MATCH ${d().node("p", "StrutProposal", { proposal_id: "$id" })} RETURN ${d().project("p", FIELDS)} AS p`, { id }))[0]?.["p"] ?? null) as Record<string, unknown> | null;
      const accepted = await props(a.id);
      assert.deepEqual(
        FIELDS.map((f) => accepted?.[f] ?? null),
        [a.id, "dev/write", "Write the rate-limit page", "applied", "The API docs say callers are throttled", WF, RUN, "j-p", "alice/1", "alice", "alice", null],
      );
      const rejected = await props(b.id);
      assert.deepEqual([rejected?.["proposal_status"], rejected?.["reason"], rejected?.["decided_by"]], ["rejected", "not now", "alice"]);
      assert.equal(await count("StrutProposal"), 2, "each change updated its node");
      const wrote = await backend.query(`MATCH ${d().node("p", "StrutProposal")}-[:ACCESSED]->${d().node("c", "Concept")} RETURN p.proposal_id AS id, c.name AS name`);
      assert.deepEqual(wrote.map((r) => [r["id"], r["name"]]), [[a.id, "Rate limits"]]);
      assert.equal(await edges("ACCESSED"), 1, "the missing ref and the peer's get no edge");

      // Writing them again adds nothing.
      await projectRun(backend, store, WF, RUN, undefined, undefined, undefined, cap);
      await projectProposalOnce(backend, cap, a.id);
      assert.deepEqual([await count("StrutProposal"), (await inRun()).length, await edges("ACCESSED")], [2, 2, 1]);

      // Found by why it was proposed.
      const hit = await backend.reader.search({ q: "throttled", types: ["StrutProposal"] });
      assert.deepEqual(hit.nodes.map((n) => n.node_type), ["StrutProposal"]);
    } finally {
      await projectionsSettled(backend);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("createStrut: a run launched under a job refreshes its StrutJob through the run-end hook — title from the launch, summary from the fold; a plain run touches no job", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-project-job-"));
    await ws.publishWorkflowByContent(
      "deliver",
      "name: deliver\nsteps:\n  - id: result\n    type: pack\n    config:\n      text: \"{{ input.text }}\"\n      artifacts:\n        - { id: \"{{ input.id }}\", title: \"{{ input.title }}\", summary: \"{{ input.summary }}\", content: \"x\" }\n",
    );
    const strut = await createStrut({ workspace: ws, store, registry: coreRegistry(), dataDir, serveUi: false, enableChat: false, stt: false, scheduler: false });
    const jobNodes = () => backend.query(`MATCH ${d().node("j", "StrutJob")} RETURN ${d().project("j", ["job_id", "title", "summary", "run_count", "artifact_count", "started_at"])} AS p`);
    try {
      const first = await strut.run("deliver", { id: "plan", title: "Plan", summary: "the landing page", text: "drafted" }, { job: "j-h", title: "Landing page" });
      assert.equal(first.status, "success");
      await projectRunOnce(backend, store, "deliver", first.runId);
      let [node] = await jobNodes();
      let p = node!["p"] as Record<string, unknown>;
      assert.deepEqual([p["job_id"], p["title"], p["summary"], p["run_count"], p["artifact_count"], typeof p["started_at"]], ["j-h", "Landing page", "Plan — the landing page\ndrafted", 1, 1, "number"]);
      assert.equal(await edges("IN_JOB"), 1);

      // The next turn: a newer deliverable first, the earlier one kept, the title kept.
      const second = await strut.run("deliver", { id: "pod", title: "Pod", summary: "pod-7", text: "booted" }, { job: "j-h" });
      await projectRunOnce(backend, store, "deliver", second.runId);
      assert.equal(await count("StrutJob"), 1);
      [node] = await jobNodes();
      p = node!["p"] as Record<string, unknown>;
      assert.deepEqual([p["title"], p["summary"], p["run_count"], p["artifact_count"]], ["Landing page", "Pod — pod-7\nPlan — the landing page\nbooted", 2, 2]);
      assert.equal(await edges("IN_JOB"), 2);

      const plain = await strut.run("deliver", { id: "x", title: "X", summary: "", text: "" });
      await projectRunOnce(backend, store, "deliver", plain.runId);
      assert.equal(await count("StrutJob"), 1);
      assert.equal(await edges("IN_JOB"), 2);
      const [run] = await backend.query(`MATCH ${d().node("r", "StrutRun", { run_id: "$id" })} RETURN r.job AS job`, { id: plain.runId });
      assert.equal(run!["job"], null);
    } finally {
      await strut.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ── Who sent an orchestrator turn: HiveWorkspaceMember -SENT-> StrutAgentSession ──

describe("orchestrator speaker (SENT edge)", () => {
  const UID = "cmdopiegj0000jo04u4kcc9q6";
  const ACTOR = `pitoi-${UID}`;
  const turnEvents = (start: Partial<RunEvent>, prompt = "hello"): RunEvent[] => [
    ev(0, "run.start", "orchestrator", start),
    ev(1, "step.start", "orchestrator/turn", { stepType: "agent", input: { prompt } }),
    ev(2, "step.end", "orchestrator/turn", { stepType: "agent", output: "ok" }),
    ev(3, "run.end", "orchestrator", {}),
  ];

  it("pure: speaker is the id after the last hyphen of the actor, for the orchestrator turn only", () => {
    const p = projectRunEvents("orchestrator", "1", turnEvents({ actor: ACTOR }), null)!;
    assert.deepEqual(p.speaker, { userId: UID, actor: ACTOR, sessionPath: "orchestrator/turn" });
    // a hyphenated github handle still splits on the LAST hyphen
    assert.equal(projectRunEvents("orchestrator", "1", turnEvents({ actor: `a-b-${UID}` }), null)!.speaker?.userId, UID);
    // a bare id is accepted
    assert.equal(projectRunEvents("orchestrator", "1", turnEvents({ actor: UID }), null)!.speaker?.userId, UID);
    // the summary's actor is the fallback
    const summary = { runId: "1", workflow: "orchestrator", startedAt: ts(0), finishedAt: ts(3), durationMs: 3, status: "success", input: {}, actor: ACTOR } as RunSummary;
    assert.equal(projectRunEvents("orchestrator", "1", turnEvents({}), summary)!.speaker?.userId, UID);
  });

  it("pure: no actor, no hyphen/handle, empty id, non-person launches, other workflows → no speaker", () => {
    for (const start of [{}, { actor: "pitoi" }, { actor: "pitoi-" }, { actor: "-" }, { actor: "   " }, { actor: ACTOR, origin: "schedule" as const }, { actor: ACTOR, origin: "verify" as const }, { actor: ACTOR, origin: "peer" as const }]) {
      assert.equal(projectRunEvents("orchestrator", "1", turnEvents(start), null)!.speaker, undefined, JSON.stringify(start));
    }
    assert.equal(projectRunEvents("orchestrator", "1", turnEvents({ actor: ACTOR, origin: "peer", peerPerson: true }), null)!.speaker?.userId, UID);
    assert.equal(projectRunEvents("some-workflow", "1", turnEvents({ actor: ACTOR }).map((e) => ({ ...e, path: e.path.replace("orchestrator", "some-workflow") })), null)!.speaker, undefined);
    // an orchestrator run without a turn session has nobody to attach to
    assert.equal(projectRunEvents("orchestrator", "1", [ev(0, "run.start", "orchestrator", { actor: ACTOR })], null)!.speaker, undefined);
  });

  it("pure: the prompt never names the speaker", () => {
    const p = projectRunEvents("orchestrator", "1", turnEvents({}, `@someone-${UID} please`), null)!;
    assert.equal(p.speaker, undefined);
    const q = projectRunEvents("orchestrator", "1", turnEvents({ actor: ACTOR }, "@someone-cxxxxxxxxxxxxxxxxxxxxxxxx hi"), null)!;
    assert.equal(q.speaker?.userId, UID);
  });

  // An in-memory backend: members by user_id, edges deduped per (src, type, tgt)
  // like the real edge writer.
  function fake(members: Array<{ ref_id: string; user_id: string }>, opts: { failEdge?: string } = {}) {
    const nodes = new Map<string, NodeInput>();
    const edges = new Map<string, EdgeInput>();
    const memberQueries: unknown[] = [];
    const backend = {
      kind: "ladybug",
      namespace: "default",
      dialect: NEO4J_DIALECT,
      schemaSource: { registry: undefined },
      nodes: {
        async writeMany(ns: NodeInput[]) {
          return ns.map((n) => {
            const key = `${n.type}:${n.data["unique_source_id"]}`;
            nodes.set(key, n);
            return { ref_id: `ref:${key}` };
          });
        },
      },
      edges: {
        async writeMany(es: EdgeInput[]) {
          if (opts.failEdge && es.some((e) => e.edge === opts.failEdge)) throw new Error("no edge schema");
          for (const e of es) edges.set(`${e.source_ref_id}|${e.edge}|${e.target_ref_id}`, e);
          return [];
        },
      },
      async query(cypher: string, params: Record<string, unknown>) {
        if (cypher.includes("HiveWorkspaceMember")) {
          memberQueries.push(params);
          return members.filter((m) => m.user_id === params["uid"]).map((m) => ({ ref_id: m.ref_id }));
        }
        return [];
      },
    } as unknown as GraphBackend;
    return { backend, nodes, edges, memberQueries };
  }
  const sent = (edges: Map<string, EdgeInput>) => [...edges.values()].filter((e) => e.edge === "SENT");
  const seedRun = async (events: RunEvent[]) => {
    const store = new MemoryRunStore();
    for (const e of events) await store.append("orchestrator", "1", e);
    return store;
  };

  it("projectRun: SENT from the existing member to the turn's session; reprojecting adds none and creates no nodes", async () => {
    const f = fake([{ ref_id: "member-1", user_id: UID }, { ref_id: "member-2", user_id: UID }, { ref_id: "other", user_id: "c99999999999999999999999999" }]);
    const store = await seedRun(turnEvents({ actor: ACTOR }, "@someone"));
    const report = { runs: 0, sessions: 0, toolCalls: 0, chats: 0, turns: 0, edges: 0, accessed: 0, unresolved: 0, skipped: 0, jobs: 0, proposals: 0, workflowUsage: 0 };
    await projectRun(f.backend, store, "orchestrator", "1", report);
    const session = "ref:StrutAgentSession:strutagentsession:1:orchestrator/turn";
    assert.deepEqual(sent(f.edges).map((e) => [e.source_ref_id, e.target_ref_id]).sort(), [["member-1", session], ["member-2", session]]);
    const nodesAfter = f.nodes.size;
    await projectRun(f.backend, store, "orchestrator", "1");
    assert.equal(sent(f.edges).length, 2, "no duplicate edge");
    assert.equal(f.nodes.size, nodesAfter, "no node created (member or Person)");
    assert.ok([...f.nodes.values()].every((n) => n.type.startsWith("Strut")));
  });

  it("projectRun: no member found, no actor, bare handle, other workflow → no SENT edge, no extra nodes", async () => {
    for (const [members, start] of [[[], { actor: ACTOR }], [[{ ref_id: "m", user_id: UID }], {}], [[{ ref_id: "m", user_id: UID }], { actor: "pitoi" }]] as const) {
      const f = fake([...members]);
      await projectRun(f.backend, await seedRun(turnEvents(start)), "orchestrator", "1");
      assert.equal(sent(f.edges).length, 0);
      assert.deepEqual([...f.nodes.keys()].map((k) => k.split(":")[0]).sort(), ["StrutAgentSession", "StrutRun"]);
    }
    const f = fake([{ ref_id: "m", user_id: UID }]);
    const events = turnEvents({ actor: ACTOR }).map((e) => ({ ...e, path: e.path.replace("orchestrator", "other") }));
    const store = new MemoryRunStore();
    for (const e of events) await store.append("other", "1", e);
    await projectRun(f.backend, store, "other", "1");
    assert.equal(sent(f.edges).length, 0);
    assert.equal(f.memberQueries.length, 0);
  });

  it("projectRun: a graph that refuses the SENT edge never fails the projection", async () => {
    const f = fake([{ ref_id: "m", user_id: UID }], { failEdge: "SENT" });
    const ref = await projectRun(f.backend, await seedRun(turnEvents({ actor: ACTOR })), "orchestrator", "1");
    assert.ok(ref);
    assert.ok([...f.edges.values()].some((e) => e.edge === "IN_RUN"));
  });
});
