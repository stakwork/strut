// The gallery's multi-agent run, for AgentTrace: shaped after a real
// 94-minute run of a benchmark workflow (five agent steps, two of them a
// foreach's iterations started in the same millisecond beside a third, a
// sequential writer and reviewer, parallel tool calls, sub-agents, the graph
// read and written) with the gallery's own research content. Built by code:
// each agent's calls laid out in time, the events interleaved as the log
// interleaves them, and each agent's transcript — the reasoning before its
// calls — answered by `run/transcript` once the agent has ended.
import type { RunEvent } from "@strut/kit";
import { REF, WORKFLOW } from "./runs";

export const TRACE_RUN_ID = "1790000000700";
/** The same run, its log revealed a little more at every read: a run in flight. */
export const TRACE_LIVE_RUN_ID = "1790000000701";

/** The nodes the run writes (fixtures/graph.ts holds them too). */
export const FINDING = {
  bp: "f1000000-0000-4000-8000-000000000021",
  af: "f2000000-0000-4000-8000-000000000022",
  dose: "f3000000-0000-4000-8000-000000000023",
} as const;

const T0 = Date.UTC(2026, 9, 21, 3, 21, 39);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

type Node = { ref_id: string; node_type: string; name: string };
interface Call {
  tool: string;
  input: unknown;
  output?: string;
  nodes?: Node[];
  /** How long it ran, s. */
  d?: number;
  /** The thinking before it, s (default 5). */
  gap?: number;
  /** Started with the call before it (parallel tool calls). */
  par?: boolean;
  error?: string;
  /** The reasoning the transcript holds before it. */
  think?: string;
  sub?: { prompt: string; calls: Call[]; answer: string };
}

const concept = (ref: string, name: string): Node => ({ ref_id: ref, node_type: "Concept", name });
const usage = (input: number, cached: number, output: number) => ({ inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: Math.round(cached / 12), outputTokens: output, totalTokens: input + cached + Math.round(cached / 12) + output });

const search = (q: string, hits = "[…]", extra: Partial<Call> = {}): Call => ({ tool: "graph_graph_search", input: { q, limit: 20 }, output: hits, d: 0.2, ...extra });
const get = (ref: string, name: string, extra: Partial<Call> = {}): Call => ({
  tool: "graph_graph_get", input: { ref_id: ref, children: "PARENT_OF" }, output: JSON.stringify({ ref_id: ref, node_type: "Concept", name }), nodes: [concept(ref, name)], d: 0.1, ...extra,
});
const bash = (command: string, output: string, extra: Partial<Call> = {}): Call => ({ tool: "bash", input: { command }, output, d: 0.1, ...extra });
const ontology: Call = { tool: "graph_get_ontology", input: { include_edges: false }, output: '{"domains":["content","entity","epistemic","general"],"node_types":{…}}', d: 0.1 };
const typeOf = (type: string, par = false): Call => ({ tool: "graph_get_ontology_type", input: { type }, output: `{"attributes":{"summary":"?string","source_ref":"string"}}`, d: 0.05, par, gap: par ? 0 : 3 });
const write = (name: string, ref: string, think?: string): Call => ({
  tool: "graph_create_batch_triplet",
  input: { triplets: [{ source_type: "Finding", source_data: { name }, edge_type: "ABOUT", target_ref_id: REF.arrhythmia }] },
  output: '{"succeeded":1,"failed":0}',
  nodes: [{ ref_id: ref, node_type: "Finding", name }],
  d: 0.4,
  ...(think ? { think } : {}),
});
const edit = (path: string, d = 0.01): Call => ({ tool: "str_replace_based_edit_tool", input: { command: "view", path }, output: `1: # ${path}\n2: …`, d });

interface Agent {
  path: string;
  start: number;
  prompt: string;
  model: string;
  calls: Call[];
  answer: string;
  /** Model calls, tokens, cost. */
  spent: { modelCalls: number; usage: ReturnType<typeof usage>; cost: number };
}

const AGENTS: Agent[] = [
  {
    path: `${WORKFLOW}/plan`,
    start: 0.005,
    model: "claude-opus-5",
    prompt: "You are the PLANNING agent. You get only the question, the deliverable and the workspace's notes — never the sources. Write plan.md: what a complete answer must cover, how a reviewer will check it, and what to read first.",
    calls: [
      { ...ontology, gap: 0.1, think: "I should learn what the graph holds before I search it." },
      search("research question conventions deliverable", "[{\"name\":\"Workflow Builder\",…}]", { par: true }),
      search("cardiology arrhythmia risk factors", "[{\"name\":\"Arrhythmia\",…}]", { gap: 8, think: "Two searches at once: the conventions for a deliverable, and the clinical area itself." }),
      search("hypertension blood pressure targets", "[{\"name\":\"Hypertension\",…}]", { par: true }),
      get(REF.cardiology, "Cardiology", { gap: 6, think: "Cardiology is the parent of both — open it with its children." }),
      get(REF.arrhythmia, "Arrhythmia", { par: true }),
      search("review rubric citation rules", "[]", { gap: 12 }),
      get(REF.hypertension, "Hypertension", { gap: 11, think: "The rubric search found nothing; the Hypertension page says what counts as raised." }),
      bash("cat > plan.md <<'EOF'\n# Plan\n…\nEOF", "", { gap: 240, think: "Enough to write the plan: five points an answer must make, each with the source a reviewer will check it against." }),
    ],
    answer: "# Plan\n1. Define AF and its burden.\n2. Quantify the risk hypertension adds (≈1.5×).\n3. What intensive BP control does to incident AF.\n4. Rhythm vs rate control when both are present.\n5. Cite the guideline and the trial for each claim.",
    spent: { modelCalls: 6, usage: usage(12, 129_579, 21_769), cost: 0.513 },
  },
  {
    path: `${WORKFLOW}/read#0`,
    start: 1.985,
    model: "claude-sonnet-5-5",
    prompt: "You are the READING agent. Read ONE source document (sources/esc-guideline-2026.txt) and write what it says into the graph as Findings about the Concepts it concerns, each with the line it came from.",
    calls: [
      bash("cat -n sources/esc-guideline-2026.txt", "     1\tESC guideline 2026 — atrial fibrillation\n     2\t…", { gap: 1.3, think: "Read the whole source first." }),
      { ...ontology, gap: 1.7 },
      typeOf("Document"), typeOf("Section", true), typeOf("Excerpt", true), typeOf("Finding", true),
      get(REF.arrhythmia, "Arrhythmia", { gap: 9, think: "Findings hang off Concepts: check the AF page's exact name before linking to it." }),
      write("Hypertension raises AF risk ~1.5-fold", FINDING.af, "The first claim, with its line: §3.2, line 41."),
      write("Early rhythm control preferred when AF and hypertension coexist", FINDING.dose),
      { tool: "graph_create_batch_triplet", input: { triplets: [{ source_type: "Excerpt" }] }, d: 0.3, error: "source_data.name is required", gap: 7 },
      { tool: "graph_create_batch_triplet", input: { triplets: [{ source_type: "Excerpt", source_data: { name: "§3.2 line 41" } }] }, output: '{"succeeded":1}', nodes: [{ ref_id: "e1000000-0000-4000-8000-000000000031", node_type: "Excerpt", name: "§3.2 line 41" }], d: 0.3, gap: 4, think: "The batch failed on a missing name — send it again with one." },
      bash("grep -n 'blood pressure' sources/esc-guideline-2026.txt", "41: …blood pressure ≥ 130/80…\n88: …", { gap: 30 }),
      search("existing findings arrhythmia", "[{\"name\":\"Hypertension raises AF risk ~1.5-fold\",…}]", { gap: 20 }),
      { tool: "graph_edit_node", input: { ref_id: REF.arrhythmia, properties: { description: "Irregular heart rhythm; hypertension its leading modifiable risk." } }, output: '{"updated":true}', nodes: [concept(REF.arrhythmia, "Arrhythmia")], d: 0.2, gap: 25, think: "The Arrhythmia page should say hypertension is its leading modifiable risk — the guideline is explicit." },
    ],
    answer: "Read sources/esc-guideline-2026.txt.\n\nWritten: 2 Findings and 1 Excerpt, each ABOUT Arrhythmia; the Arrhythmia page's description updated.",
    spent: { modelCalls: 18, usage: usage(35, 793_087, 27_968), cost: 0.943 },
  },
  {
    path: `${WORKFLOW}/read#1`,
    start: 1.985,
    model: "claude-sonnet-5-5",
    prompt: "You are the READING agent. Read ONE source document (sources/sprint-af-trial.txt) and write what it says into the graph as Findings about the Concepts it concerns, each with the line it came from.",
    calls: [
      bash("wc -l sources/sprint-af-trial.txt", "657 sources/sprint-af-trial.txt", { gap: 1.4 }),
      edit("sources/sprint-af-trial.txt", 0.01),
      { ...ontology, gap: 20 },
      search("trial outcome measures", "[]", { gap: 14 }),
      typeOf("Finding"), typeOf("Measure", true),
      {
        tool: "agent",
        input: { prompt: "Check the trial's figures: recompute the relative risk reduction from the event counts in Table 2 and say whether 26% holds." },
        d: 0,
        gap: 30,
        think: "The 26% is the headline — have a sub-agent recompute it from Table 2 before I write it down.",
        sub: {
          prompt: "Check the trial's figures: recompute the relative risk reduction from the event counts in Table 2 and say whether 26% holds.",
          calls: [
            bash("sed -n '210,240p' sources/sprint-af-trial.txt", "Table 2. Incident AF: intensive 88/4678, standard 118/4683", { gap: 3, think: "Find Table 2." }),
            bash("python3 -c 'print(1 - (88/4678)/(118/4683))'", "0.2534…", { gap: 6, think: "RRR = 1 − (risk intensive / risk standard)." }),
            { tool: "bash", input: { command: "python3 -c 'import scipy'" }, d: 2, gap: 4, error: "ModuleNotFoundError: No module named 'scipy'" },
            bash("python3 -c 'from math import *; print(…)'", "CI 0.03–0.43", { gap: 8, think: "No scipy: compute the interval by hand." }),
          ],
          answer: "Recomputed from Table 2: RRR 25.3% (95% CI 3–43%). The paper rounds it to 26%; it holds.",
        },
      },
      write("Intensive BP control cut incident AF by ~25%", FINDING.bp, "The sub-agent confirms it: 25.3%, rounded to 26% in the paper. Write it as ~25%."),
      get(REF.hypertension, "Hypertension", { gap: 12 }),
      bash("grep -n 'adverse' sources/sprint-af-trial.txt", "301: Serious adverse events…", { gap: 40 }),
      search("hypotension syncope adverse events", "[]", { gap: 22 }),
      edit("sources/sprint-af-trial.txt", 0.02),
      bash("sed -n '300,330p' sources/sprint-af-trial.txt", "300: …", { gap: 60 }),
    ],
    answer: "Read sources/sprint-af-trial.txt.\n\nWritten: 1 Finding ABOUT Arrhythmia (the 25% reduction, checked by a sub-agent against Table 2). Adverse events noted in facts.md, not the graph.",
    spent: { modelCalls: 26, usage: usage(51, 2_686_785, 79_643), cost: 2.67 },
  },
  {
    path: `${WORKFLOW}/write`,
    start: 2877.6,
    model: "claude-opus-5",
    prompt: "You are the WRITER. Phases: plan → retrieve and extend facts.md → draft report.md to plan.md → self-check every claim against the graph.",
    calls: [
      bash("cat plan.md facts.md", "=== PLAN ===\n# Plan\n…", { gap: 3.2, think: "Start from the plan and what the readers left." }),
      bash("ls sources/", "esc-guideline-2026.txt\nsprint-af-trial.txt", { par: true }),
      search("findings arrhythmia hypertension", "[{\"name\":\"Hypertension raises AF risk ~1.5-fold\",…}]", { gap: 18, think: "What did the readers write into the graph?" }),
      get(REF.arrhythmia, "Arrhythmia", { gap: 7 }),
      get(REF.heartFailure, "Heart failure", { par: true }),
      edit("facts.md", 0.02),
      bash("cat > report.md <<'EOF'\n# Atrial fibrillation in hypertension\n…\nEOF", "", { gap: 600, think: "Draft the whole report in one pass, one section per plan point." }),
      {
        tool: "agent",
        input: { prompt: "Check every citation in report.md: each claim's source and line must say what the claim says." },
        d: 0,
        gap: 20,
        think: "A fresh pair of eyes for the citations — a sub-agent that has not seen my reasoning.",
        sub: {
          prompt: "Check every citation in report.md: each claim's source and line must say what the claim says.",
          calls: [
            bash("grep -n '\\[' report.md", "12: …[ESC §3.2]\n19: …[SPRINT-AF T2]", { gap: 4 }),
            { ...get(REF.trial, "SPRINT-AF trial", { gap: 5 }), nodes: [{ ref_id: REF.trial, node_type: "Document", name: "SPRINT-AF trial" }] },
            bash("sed -n '41p' sources/esc-guideline-2026.txt", "41: …blood pressure ≥ 130/80…", { gap: 5 }),
          ],
          answer: "All 6 citations hold. One wording: §3.2 says 'about 1.5-fold', the report says '1.5×' — fine.",
        },
      },
      edit("report.md", 0.02),
      bash("wc -w report.md", "1184 report.md", { gap: 300 }),
    ],
    answer: "## Written\n\n| Path | Words | Plan points |\n|---|---|---|\n| report.md | 1184 | 5 of 5 |\n\nEvery claim cites the guideline or the trial; a sub-agent checked all six citations.",
    spent: { modelCalls: 36, usage: usage(72, 7_805_237, 163_986), cost: 6.64 },
  },
  {
    path: `${WORKFLOW}/review`,
    start: 5511.7,
    model: "claude-sonnet-5-5",
    prompt: "You are the REVIEWER. A grader failed some of the report's checks. For EACH failed check, read the report and the source, and say whether the failure holds or the check itself is wrong.",
    calls: [
      bash("cat score.json", '{"passed":3,"failed":2,…}', { gap: 2 }),
      bash("sed -n '10,30p' report.md", "…", { gap: 6 }),
      get(REF.hypertension, "Hypertension", { gap: 9, think: "Check 4 says the report misstates the threshold; the Hypertension page has it." }),
      bash("grep -n '130/80' report.md sources/*.txt", "report.md:14: …\nsources/esc-guideline-2026.txt:41: …", { gap: 7 }),
      search("blood pressure threshold guideline", "[{\"name\":\"Hypertension\",…}]", { gap: 12 }),
    ],
    answer: '{"reviews":[{"check":4,"holds":false,"why":"The report states 130/80 as the guideline does; the check expected 140/90."},{"check":5,"holds":true}]}',
    spent: { modelCalls: 14, usage: usage(28, 459_441, 9_755), cost: 0.469 },
  },
];

/** A step that is not an agent, `s` seconds in for `d`. */
function step(path: string, stepType: string, s: number, d: number, extra: Partial<RunEvent> = {}): RunEvent[] {
  return [
    { type: "step.start", path, stepType, ts: at(s), runId: TRACE_RUN_ID },
    { type: "step.end", path, stepType, ts: at(s + d), runId: TRACE_RUN_ID, durationMs: d * 1000, ...extra },
  ];
}

const transcripts = new Map<string, unknown[]>();

/** One agent's calls as events, from `t`; returns when the last ended. Fills `transcripts[path]`. */
function lay(path: string, prompt: string, calls: Call[], answer: string, t: number, out: RunEvent[], ids: string): number {
  const messages: unknown[] = [{ role: "system", content: "…" }, { role: "user", content: prompt }];
  let clock = t;
  let prev = t;
  calls.forEach((c, i) => {
    const n = String(i + 1).padStart(3, "0");
    const callPath = `${path}/${n}-${c.tool}`;
    const id = `toolu_${ids}${n}`;
    const begin = c.par ? prev : clock + (c.gap ?? 5);
    prev = begin;
    const base = { path: callPath, stepType: `tool:${c.tool}`, toolCallId: id, runId: TRACE_RUN_ID };
    out.push({ type: "step.start", ts: at(begin), ...base, input: c.input });
    messages.push({ role: "assistant", content: [...(c.think ? [{ type: "reasoning", text: c.think }] : []), { type: "tool-call", toolCallId: id, toolName: c.tool, input: c.input }] });
    let end = begin + (c.d ?? 0.2);
    if (c.sub) {
      end = lay(callPath, c.sub.prompt, c.sub.calls, c.sub.answer, begin, out, `${ids}${n}s`) + 4;
      out.push({
        type: "step.end", ts: at(end), ...base, durationMs: (end - begin) * 1000,
        output: JSON.stringify({ result: c.sub.answer, steps: c.sub.calls.length + 1 }),
        modelCalls: c.sub.calls.length + 1, usage: usage(8, 40_000 * c.sub.calls.length, 1_800), cost: 0.06 * c.sub.calls.length,
        transcript: `/workflows/${WORKFLOW}/runs/${TRACE_RUN_ID}/transcripts/${encodeURIComponent(callPath)}`,
      });
    } else if (c.error) {
      out.push({ type: "step.error", ts: at(end), ...base, error: { message: c.error } });
    } else {
      out.push({ type: "step.end", ts: at(end), ...base, durationMs: (end - begin) * 1000, output: c.output ?? "", ...(c.nodes ? { nodes: c.nodes } : {}) });
    }
    messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: c.tool, output: { type: "text", value: c.error ?? c.output ?? "" } }] });
    clock = Math.max(clock, end);
  });
  messages.push({ role: "assistant", content: [{ type: "text", text: answer }] });
  transcripts.set(path, messages);
  return clock;
}

function build(): RunEvent[] {
  const out: RunEvent[] = [];
  out.push(...step(`${WORKFLOW}/docs`, "exec", 0.005, 1.89, { output: { code: 0 } }));
  out.push({ type: "step.start", path: `${WORKFLOW}/read`, stepType: "foreach", ts: at(1.984), runId: TRACE_RUN_ID });
  let readEnd = 0;
  AGENTS.forEach((a, i) => {
    out.push({ type: "step.start", path: a.path, stepType: "agent", ts: at(a.start), runId: TRACE_RUN_ID, input: { cwd: `/data/artifacts/${TRACE_RUN_ID}`, prompt: a.prompt, model: a.model } });
    const end = lay(a.path, a.prompt, a.calls, a.answer, a.start, out, String.fromCharCode(97 + i)) + 8;
    if (a.path.includes("/read#")) readEnd = Math.max(readEnd, end);
    out.push({
      type: "step.end", path: a.path, stepType: "agent", ts: at(end), runId: TRACE_RUN_ID, durationMs: (end - a.start) * 1000,
      output: { result: a.answer, steps: a.spent.modelCalls }, ...a.spent,
      transcript: `/workflows/${WORKFLOW}/runs/${TRACE_RUN_ID}/transcripts/${encodeURIComponent(a.path)}`,
    });
  });
  out.push({ type: "step.end", path: `${WORKFLOW}/read`, stepType: "foreach", ts: at(readEnd + 0.1), runId: TRACE_RUN_ID });
  out.push(...step(`${WORKFLOW}/gate`, "if", 2_138, 0, { output: true }));
  out.push(...step(`${WORKFLOW}/score`, "exec", 5_472, 37, { output: { code: 0 } }));
  out.push({ type: "step.skipped", path: `${WORKFLOW}/post`, stepType: "http", ts: at(5_664.5), runId: TRACE_RUN_ID });
  // The log is in time order, the parallel agents' events interleaved.
  out.sort((x, y) => Date.parse(x.ts!) - Date.parse(y.ts!));
  return [
    { type: "run.start", path: WORKFLOW, workflow: WORKFLOW, ts: at(0), runId: TRACE_RUN_ID, input: { question: "What drives atrial fibrillation in hypertensive patients?" } },
    ...out,
    { type: "run.end", path: WORKFLOW, ts: at(5_664.6), runId: TRACE_RUN_ID, status: "success" },
  ];
}

export const TRACE_EVENTS: RunEvent[] = build();

/** An agent's transcript by its step path; the live run's only once its end is in what was revealed. */
export function traceTranscript(path: string, revealed: readonly RunEvent[] = TRACE_EVENTS): unknown[] | undefined {
  const ended = revealed.some((e) => e.path === path && (e.type === "step.end" || e.type === "step.error") && (e.stepType === "agent" || e.stepType === "tool:agent"));
  return ended ? transcripts.get(path) : undefined;
}
