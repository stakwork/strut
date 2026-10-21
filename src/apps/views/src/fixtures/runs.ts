// The gallery's runs: a `research` run whose agent walks a Concept tree,
// writes a node, launches a `summarize` run and reaches a peer, then scores
// two findings in a loop — enough for every run view to have something to
// draw. Shapes are strut's event log (`run/events`).
import type { RunEvent, RunSummary } from "@strut/kit";

export const WORKFLOW = "research";
export const RUN_ID = "1790000000100";
export const CHILD_WORKFLOW = "summarize";
export const CHILD_RUN_ID = "1790000000500";
/** The run's agent step: its transcript is the gallery's TRANSCRIPT. */
export const EXPLORE_PATH = `${WORKFLOW}/explore`;

/** The Concept tree the run walks (fixtures/graph.ts holds the nodes). */
export const REF = {
  medicine: "c0000000-0000-4000-8000-000000000000",
  cardiology: "c1000000-0000-4000-8000-000000000001",
  arrhythmia: "c2000000-0000-4000-8000-000000000002",
  hypertension: "c3000000-0000-4000-8000-000000000003",
  heartFailure: "c4000000-0000-4000-8000-000000000004",
  guideline: "d1000000-0000-4000-8000-000000000011",
  trial: "d2000000-0000-4000-8000-000000000012",
} as const;

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const usage = (input: number, output: number) => ({ inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output, totalTokens: input + output });

/** A step's start and end, `s` seconds into the run for `d` seconds. */
function step(path: string, stepType: string, s: number, d: number, end: Record<string, unknown> = {}, input?: unknown): RunEvent[] {
  return [
    { type: "step.start", path, stepType, ts: at(s), ...(input !== undefined ? { input } : {}) },
    { type: "step.end", path, stepType, ts: at(s + d), durationMs: d * 1000, ...end },
  ];
}

export const RUN_EVENTS: RunEvent[] = [
  { type: "run.start", path: WORKFLOW, ts: at(0), runId: RUN_ID, workflow: WORKFLOW, actor: "ada-7f3c", input: { question: "What drives atrial fibrillation in hypertensive patients?" } },
  ...step(`${WORKFLOW}/plan`, "llm", 0, 6, { output: { plan: "…" }, modelCalls: 1, usage: usage(2400, 610), cost: 0.0164 }),
  { type: "step.start", path: `${WORKFLOW}/explore`, stepType: "agent", ts: at(6) },
  ...step(`${WORKFLOW}/explore/001-graph_graph_search`, "tool:graph/graph-search", 8, 1, {
    nodes: [{ ref_id: REF.arrhythmia, node_type: "Concept" }, { ref_id: REF.hypertension, node_type: "Concept" }, { ref_id: REF.trial, node_type: "Document" }],
  }, { q: "atrial fibrillation hypertension" }),
  ...step(`${WORKFLOW}/explore/002-graph_graph_get`, "tool:graph/graph-get", 10, 1, { nodes: [{ ref_id: REF.arrhythmia, node_type: "Concept", name: "Arrhythmia" }] }, { ref_id: REF.arrhythmia }),
  ...step(`${WORKFLOW}/explore/003-graph_walk`, "tool:graph/walk", 12, 9, {
    nodes: [
      { ref_id: REF.cardiology, node_type: "Concept", name: "Cardiology" },
      { ref_id: REF.hypertension, node_type: "Concept", name: "Hypertension" },
      { ref_id: REF.trial, node_type: "Document", name: "SPRINT-AF trial" },
    ],
    modelCalls: 3, usage: usage(9100, 900), cost: 0.0408,
  }, { ref_id: REF.cardiology, goal: "risk factors for AF" }),
  ...step(`${WORKFLOW}/explore/004-graph_edit_node`, "tool:graph/edit-node", 22, 1, { nodes: [{ ref_id: REF.arrhythmia, node_type: "Concept", name: "Arrhythmia" }] }, { ref_id: REF.arrhythmia }),
  ...step(`${WORKFLOW}/explore/005-meta_run_workflow`, "tool:meta/run-workflow", 24, 14, {
    output: { runId: CHILD_RUN_ID, status: "success", output: { summary: "…" } },
    nodes: [{ ref_id: REF.guideline, node_type: "Document", name: "ESC guideline 2026" }],
    modelCalls: 2, usage: usage(5200, 700), cost: 0.0261,
  }, { name: CHILD_WORKFLOW, input: { ref_id: REF.guideline } }),
  ...step(`${WORKFLOW}/explore/006-strut_run_workflow`, "tool:strut/run-workflow", 39, 5, {
    output: { peer: "acme-lab", workflow: "lookup", runId: "1790000009999", status: "success" },
    nodes: [{ ref_id: "aa000000-0000-4000-8000-0000000000aa", node_type: "Concept", name: "Lab panels", peer: "acme-lab" }],
  }, { peer: "acme-lab", workflow: "lookup" }),
  // The log serves an agent's session as a link (run/transcript reads it).
  { type: "step.end", path: EXPLORE_PATH, stepType: "agent", ts: at(46), durationMs: 40_000, output: { result: "Three findings." }, transcript: `/workflows/${WORKFLOW}/runs/${RUN_ID}/transcripts/${EXPLORE_PATH}`, modelCalls: 9, usage: usage(48_000, 4_200), cost: 0.2072 },
  { type: "step.start", path: `${WORKFLOW}/each`, stepType: "foreach", ts: at(46) },
  ...step(`${WORKFLOW}/each#0/score`, "graph/graph-get", 46, 2, { nodes: [{ ref_id: REF.hypertension, node_type: "Concept", name: "Hypertension" }] }, { ref_id: REF.hypertension }),
  ...step(`${WORKFLOW}/each#1/score`, "graph/graph-get", 48, 2, { nodes: [{ ref_id: REF.heartFailure, node_type: "Concept", name: "Heart failure" }] }, { ref_id: REF.heartFailure }),
  { type: "step.end", path: `${WORKFLOW}/each`, stepType: "foreach", ts: at(50), durationMs: 4000 },
  ...step(`${WORKFLOW}/pack`, "pack", 50, 0.2, { output: { report: "/artifacts/1790000000100/report.md" } }),
  { type: "run.end", path: WORKFLOW, ts: at(50.2), runId: RUN_ID, status: "success", durationMs: 50_200, output: { report: "/artifacts/1790000000100/report.md" } },
];

export const CHILD_EVENTS: RunEvent[] = [
  { type: "run.start", path: CHILD_WORKFLOW, ts: at(24), runId: CHILD_RUN_ID, workflow: CHILD_WORKFLOW, parentRunId: RUN_ID },
  { type: "step.start", path: `${CHILD_WORKFLOW}/read`, stepType: "agent", ts: at(24) },
  ...step(`${CHILD_WORKFLOW}/read/001-graph_graph_get`, "tool:graph/graph-get", 25, 1, { nodes: [{ ref_id: REF.guideline, node_type: "Document", name: "ESC guideline 2026" }] }, { ref_id: REF.guideline }),
  ...step(`${CHILD_WORKFLOW}/read/002-graph_graph_get`, "tool:graph/graph-get", 27, 1, { nodes: [{ ref_id: REF.trial, node_type: "Document", name: "SPRINT-AF trial" }] }, { ref_id: REF.trial }),
  { type: "step.end", path: `${CHILD_WORKFLOW}/read`, stepType: "agent", ts: at(37), durationMs: 13_000, modelCalls: 2, usage: usage(5200, 700), cost: 0.0261 },
  { type: "run.end", path: CHILD_WORKFLOW, ts: at(38), runId: CHILD_RUN_ID, status: "success", durationMs: 14_000 },
];

export const RUNS: RunSummary[] = [
  { runId: "1790000000300", workflow: WORKFLOW, status: "running", startedAt: at(3600), actor: "ada-7f3c", origin: "app", app: { name: "acme/bench", version: "v3" } },
  { runId: RUN_ID, workflow: WORKFLOW, status: "success", startedAt: at(0), finishedAt: at(50.2), durationMs: 50_200, actor: "ada-7f3c" },
  { runId: "1789999990000", workflow: WORKFLOW, status: "error", startedAt: at(-7200), finishedAt: at(-7188), durationMs: 12_000, origin: "schedule", automation: { id: "nightly" } },
  { runId: "1789999980000", workflow: WORKFLOW, status: "cancelled", startedAt: at(-9000), finishedAt: at(-8990), durationMs: 10_000, job: "triage-af" },
];

/** `run/workflow` for the research workflow: its `input:` block. */
export const WORKFLOW_INFO = {
  name: WORKFLOW,
  description: "Research a clinical question against the graph and write a report.",
  activeVersion: "v4",
  input: {
    question: { type: "string", description: "The question to research." },
    depth: { type: "number", default: 2, description: "How many hops the walk may take." },
    cite: { type: "boolean", default: true, description: "Cite the documents read." },
    filters: { type: "json", required: false, description: "Node types to keep, as a JSON list." },
  },
  params: { model: "sonnet" },
};
