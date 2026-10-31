// The gallery's run for a report: what RunTimeline's `tree` and `split` and
// RunHealth draw — a fetch tried again, a gate and the branch it skipped, a
// subflow inside a subflow whose agent calls a sub-agent and goes past two
// failed tool calls, a foreach of three agents run in parallel, a step an
// onError fallback stood in for, and a last step that failed the run.
import type { RunEvent } from "@strut/kit";
import { WORKFLOW } from "./runs";

export const REPORT_RUN_ID = "1790000000800";

const T0 = Date.UTC(2026, 9, 22, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const usage = (input: number, output: number) => ({ inputTokens: input, cacheReadTokens: input * 8, cacheWriteTokens: 0, outputTokens: output, totalTokens: input * 9 + output });
const e = (s: number, type: string, path: string, extra: Partial<RunEvent> = {}): RunEvent => ({ ts: at(s), type, path: `${WORKFLOW}${path ? `/${path}` : ""}`, runId: REPORT_RUN_ID, ...extra });

export const REPORT_EVENTS: RunEvent[] = [
  e(0, "run.start", "", { workflow: WORKFLOW, input: { question: "Which trials changed the blood-pressure target?" } }),
  e(0, "step.start", "fetch", { stepType: "http" }),
  e(4, "step.retry", "fetch", { stepType: "http", iteration: 1 }),
  e(5, "step.start", "fetch", { stepType: "http" }),
  e(6, "step.end", "fetch", { stepType: "http", output: { status: 200 } }),
  e(6, "step.start", "gate", { stepType: "if" }),
  e(6, "step.end", "gate", { stepType: "if", output: false }),
  e(6, "step.skipped", "notify", { stepType: "http" }),
  e(6, "step.start", "sub", { stepType: "subflow" }),
  e(7, "step.start", "sub/inner", { stepType: "subflow" }),
  e(7, "step.start", "sub/inner/explore", { stepType: "agent" }),
  e(9, "step.start", "sub/inner/explore/001-bash", { stepType: "tool:bash" }),
  e(10, "step.error", "sub/inner/explore/001-bash", { stepType: "tool:bash", error: { message: "Command failed (2): grep: trials.csv: No such file" } }),
  e(12, "step.start", "sub/inner/explore/002-agent", { stepType: "tool:agent" }),
  e(14, "step.start", "sub/inner/explore/002-agent/001-graph_graph_search", { stepType: "tool:graph_graph_search" }),
  e(15, "step.end", "sub/inner/explore/002-agent/001-graph_graph_search", { stepType: "tool:graph_graph_search" }),
  e(31, "step.end", "sub/inner/explore/002-agent", { stepType: "tool:agent", modelCalls: 4, usage: usage(3_000, 900), cost: 0.06 }),
  e(32, "step.start", "sub/inner/explore/003-bash", { stepType: "tool:bash" }),
  e(33, "step.error", "sub/inner/explore/003-bash", { stepType: "tool:bash", error: { message: "Command execution failed: Error: Command timed out after 300000ms" } }),
  e(48, "step.end", "sub/inner/explore", { stepType: "agent", output: { result: "Three trials." }, modelCalls: 9, usage: usage(12_000, 2_400), cost: 0.21 }),
  e(48, "step.end", "sub/inner", { stepType: "subflow" }),
  e(48, "step.end", "sub", { stepType: "subflow" }),
  e(48, "step.start", "each", { stepType: "foreach" }),
  ...[0, 1, 2].flatMap((i): RunEvent[] => [
    e(48, "step.start", `each#${i}`, { stepType: "agent", iteration: i }),
    e(50 + i, "step.start", `each#${i}/001-llm`, { stepType: "tool:llm" }),
    e(56 + i, "step.end", `each#${i}/001-llm`, { stepType: "tool:llm", modelCalls: 1, usage: usage(1_500, 300), cost: 0.01 }),
    e(70 + 9 * i, "step.end", `each#${i}`, { stepType: "agent", iteration: i, output: { result: `trial ${i + 1} read` }, modelCalls: 5, usage: usage(6_000 + 2_000 * i, 1_100), cost: 0.08 + 0.02 * i }),
  ]),
  e(88, "step.end", "each", { stepType: "foreach", output: [] }),
  e(88, "step.start", "parse", { stepType: "exec" }),
  e(90, "step.start", "parse/onError", { stepType: "log" }),
  e(90, "step.end", "parse/onError", { stepType: "log", output: "kept the raw text" }),
  e(90, "step.start", "write", { stepType: "llm" }),
  e(101, "step.end", "write", { stepType: "llm", output: { text: "…" }, modelCalls: 1, usage: usage(9_000, 1_800), cost: 0.05 }),
  e(101, "step.start", "publish", { stepType: "http" }),
  e(102, "step.error", "publish", { stepType: "http", error: { message: "POST https://example.org/reports → 403 Forbidden" } }),
  e(102, "run.error", "", { error: { message: "POST https://example.org/reports → 403 Forbidden" } }),
];
