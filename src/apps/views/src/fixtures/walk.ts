// The gallery's walks, for WalkView: a law Concept tree (Law → Corporate /
// M&A → NDA → NDA drafting rules → a tool Concept, "Deviation matrix
// (Google Sheet)", with siblings at every level) walked twice — by a
// `graph/walk` step, its hop events as runWalk emits them, and by an agent
// reading the tree itself with graph_graph_get { children } — and, at NDA,
// the drafting rules and the playbook at once with graph_graph_get_batched —
// its tool calls as the agent step logs them (outputs as 1.5 KB previews,
// the whole results in its transcript).
import type { RunEvent } from "@strut/kit";
import type { GraphNode } from "../lib/graph";

export const WALK_WORKFLOW = "matter-intake";
export const WALK_RUN_ID = "1790000000950";
/** The same run, its log revealed a little more at every read: a walk in flight. */
export const WALK_LIVE_RUN_ID = "1790000000951";
/** The same run in flight, joined mid-walk: its first read already holds three hops. */
export const WALK_JOIN_RUN_ID = "1790000000952";
export const AGENT_WALK_RUN_ID = "1790000000960";
export const AGENT_WALK_PATH = `${WALK_WORKFLOW}/explore`;

const id = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const LAW = {
  law: id(1), corp: id(2), lit: id(3), emp: id(4), ip: id(5), reg: id(6),
  nda: id(7), spa: id(8), loi: id(9), apa: id(10),
  rules: id(11), playbook: id(12), precedents: id(13),
  matrix: id(14), clauses: id(15), redline: id(16), governing: id(17),
} as const;
type Key = keyof typeof LAW;

const TREE: Record<Key, { name: string; description: string; docs?: string; children?: Key[] }> = {
  law: {
    name: "Law",
    description: "The root of the legal tree: every practice area descends from here.",
    docs: "# Law\n\nThe firm's knowledge, by practice area. Open the area a matter belongs to and follow its children down to the house rules for the document in front of you.",
    children: ["corp", "lit", "emp", "ip", "reg"],
  },
  corp: {
    name: "Corporate / M&A",
    description: "Deals: mergers, acquisitions, financings and the agreements around them.",
    docs: "Corporate covers a deal from the first conversation to closing: **NDAs**, letters of intent, purchase agreements, disclosure schedules.",
    children: ["nda", "spa", "loi", "apa"],
  },
  lit: { name: "Litigation", description: "Disputes, from the demand letter to judgment." },
  emp: { name: "Employment", description: "Hiring, contracts, terminations, restrictive covenants." },
  ip: { name: "Intellectual property", description: "Patents, trademarks, copyright and licensing." },
  reg: { name: "Regulatory & compliance", description: "Privacy, sanctions, anti-bribery, sector rules." },
  nda: {
    name: "NDA",
    description: "Non-disclosure agreements, mutual and one-way.",
    docs: "An NDA comes in before any data room opens. Review the counterparty's draft against **NDA drafting rules**; negotiate from the playbook.",
    children: ["rules", "playbook", "precedents"],
  },
  spa: { name: "Share purchase agreement", description: "Buying the shares of a company." },
  loi: { name: "Letter of intent", description: "The deal's headline terms, mostly non-binding." },
  apa: { name: "Asset purchase agreement", description: "Buying a business's assets, not its shares." },
  rules: {
    name: "NDA drafting rules",
    description: "The house position on every NDA clause, and what to do when a draft departs from it.",
    docs: "# NDA drafting rules\n\n- **Term**: 2 years from disclosure; trade secrets for as long as they stay secret.\n- **Residuals**: never accept a residuals clause.\n- **Non-solicit**: 12 months, employees we met through the deal only.\n- **Governing law**: ours, or the governing-law table.\n\nRecord every clause where the draft departs from these in the **Deviation matrix**, one row per clause.",
    children: ["matrix", "clauses", "redline", "governing"],
  },
  playbook: { name: "Negotiation playbook", description: "Fallback positions, in the order to give them up." },
  precedents: { name: "NDA precedents", description: "Signed NDAs, by counterparty and year." },
  matrix: {
    name: "Deviation matrix (Google Sheet)",
    description: "A Google Sheet, one row per clause where the counterparty's draft departs from the house rules.",
    docs: "Make it with `sheets/create-spreadsheet`, then one row per deviation with `sheets/update-values`:\n\n| Clause | Our position | Their text | Risk | Recommendation |\n|---|---|---|---|---|\n\nRisk is low, medium or high; a high-risk row goes to the partner before the redline.",
  },
  clauses: { name: "Clause library", description: "Our standard text for every clause, with a note on each." },
  redline: { name: "Redline conventions", description: "How we mark up a counterparty's draft." },
  governing: { name: "Governing-law table", description: "Which law and courts to accept, by counterparty's country." },
};

const brief = (k: Key) => ({ ref_id: LAW[k], node_type: "Concept", name: TREE[k].name });
const parentOf = (k: Key) => (Object.keys(TREE) as Key[]).find((p) => TREE[p].children?.includes(k));

const NODES = new Map<string, GraphNode>(
  (Object.keys(TREE) as Key[]).map((k) => {
    const t = TREE[k];
    const edges: Record<string, number> = {};
    if (t.children?.length) edges["PARENT_OF"] = t.children.length;
    if (parentOf(k)) edges["<-PARENT_OF"] = 1;
    return [LAW[k], { ref_id: LAW[k], node_type: "Concept", name: t.name, properties: { name: t.name, namespace: "default", description: t.description, ...(t.docs ? { docs: t.docs } : {}) }, edges }];
  }),
);

/** A law Concept, as graph-get-batched answers. */
export function walkNode(ref: string): GraphNode | undefined {
  return NODES.get(ref);
}

const T0 = Date.UTC(2026, 10, 2, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const GOAL = "Review Acme's NDA against our house rules: which rules apply, and where do the deviations go?";

// ── The graph/walk step ────────────────────────────────────────────────

/** Each hop: the node it expanded (none for the seeds), its candidates' relevance, the next, "enough?". */
const HOPS: Array<{ expanded: Key | null; judged: Array<[Key, number]>; next: Key; sufficient: number }> = [
  { expanded: null, judged: [["law", 0.9]], next: "law", sufficient: 0.05 },
  { expanded: "law", judged: [["corp", 0.94], ["lit", 0.12], ["emp", 0.08], ["ip", 0.31], ["reg", 0.22]], next: "corp", sufficient: 0.1 },
  { expanded: "corp", judged: [["nda", 0.96], ["spa", 0.38], ["loi", 0.41], ["apa", 0.19]], next: "nda", sufficient: 0.2 },
  { expanded: "nda", judged: [["rules", 0.93], ["playbook", 0.74], ["precedents", 0.55]], next: "rules", sufficient: 0.35 },
  { expanded: "rules", judged: [["matrix", 0.97], ["clauses", 0.82], ["redline", 0.63], ["governing", 0.58]], next: "matrix", sufficient: 0.88 },
];
const THRESHOLD = 0.7;

function walkEvents(): RunEvent[] {
  const gather = `${WALK_WORKFLOW}/gather`;
  const out: RunEvent[] = [
    { type: "run.start", path: WALK_WORKFLOW, ts: at(0), runId: WALK_RUN_ID, workflow: WALK_WORKFLOW, input: { matter: "Acme / Northwind NDA" } },
    { type: "step.start", path: gather, stepType: "graph/walk", ts: at(0.2), input: { goal: GOAL, start: [LAW.law], edge_type: ["PARENT_OF"], maxHops: 12, maxNodes: 25, threshold: THRESHOLD } },
  ];
  let s = 0.4;
  const kept: Array<ReturnType<typeof brief> & { relevance: number; hop: number }> = [];
  HOPS.forEach((h, hop) => {
    const path = `${gather}/${String(hop + 1).padStart(3, "0")}-hop`;
    const candidates = h.judged.map(([k]) => ({ ...brief(k), ...(h.expanded ? { via: { from: LAW[h.expanded], edge_type: "PARENT_OF", direction: "forward" } } : {}) }));
    out.push({ type: "step.start", path, stepType: "walk:hop", iteration: hop, ts: at(s), input: { hop, expanded: h.expanded ? brief(h.expanded) : null, candidates, frontier: [] } });
    const verdicts = h.judged.map(([k, relevance]) => ({ ref_id: LAW[k], relevance, kept: relevance >= THRESHOLD }));
    for (const [k, relevance] of h.judged) if (relevance >= THRESHOLD) kept.push({ ...brief(k), relevance, hop });
    const record = { hop, ...(h.expanded ? { expanded: brief(h.expanded) } : {}), candidates: h.judged.length, kept: verdicts.filter((v) => v.kept).map((v) => v.ref_id), verdicts, next: brief(h.next), sufficient: h.sufficient };
    out.push({ type: "step.end", path, stepType: "walk:hop", iteration: hop, ts: at(s + 1.1), durationMs: 1100, output: record, nodes: [...(h.expanded ? [brief(h.expanded)] : []), ...verdicts.filter((v) => v.kept).map((v) => ({ ref_id: v.ref_id, node_type: "Concept" }))] });
    s += 1.4;
  });
  out.push({
    type: "step.end", path: gather, stepType: "graph/walk", ts: at(s), durationMs: (s - 0.2) * 1000,
    output: { goal: GOAL, nodes: kept.sort((a, b) => b.relevance - a.relevance).map((k) => ({ ...k, properties: {} })), hops: [], stopped: "sufficient", usage: { inputTokens: 9100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60, totalTokens: 9160 } },
  });
  out.push({ type: "run.end", path: WALK_WORKFLOW, ts: at(s + 0.1), status: "success", durationMs: s * 1000 });
  return out;
}

export const WALK_EVENTS: RunEvent[] = walkEvents();

// ── The agent walking the tree by its own tool calls ───────────────────

/** What the agent step's emit keeps of a tool's result: a 1.5 KB preview. */
const preview = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 1500 ? `${s.slice(0, 1500)}\n[… truncated for event log …]` : s;
};

/** graph/graph-get with `children`, as the step returns it. */
const getResult = (k: Key) => {
  const n = NODES.get(LAW[k])!;
  const kids = (TREE[k].children ?? []).map((c) => ({ ...brief(c), description: TREE[c].description })).sort((a, b) => a.name.localeCompare(b.name));
  return { ref_id: n.ref_id, node_type: n.node_type, name: n.name, properties: n.properties, edges: n.edges, children: kids };
};

/** graph/graph-get-batched, as the step returns it: every node it read. */
const batchedResult = (keys: Key[]) => {
  const nodes = keys.map((k) => NODES.get(LAW[k])!).map((n) => ({ ref_id: n.ref_id, node_type: n.node_type, name: n.name, properties: n.properties, edges: n.edges }));
  return { requested: keys.length, returned: keys.length, truncated: false, omitted_ref_ids: [], nodes };
};

interface AgentCall {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
  nodes?: Array<ReturnType<typeof brief>>;
  think: string;
  /** Seconds after the call before it. */
  gap: number;
}

const AGENT_CALLS: AgentCall[] = [
  { tool: "graph_graph_get", input: { node_type: "Concept", name: "Law", children: "PARENT_OF" }, result: getResult("law"), nodes: [brief("law")], think: "Start at the root of the Concept tree and find the practice area.", gap: 2 },
  { tool: "graph_graph_get", input: { ref_id: LAW.corp, children: "PARENT_OF" }, result: getResult("corp"), nodes: [brief("corp")], think: "An NDA before a deal is Corporate / M&A.", gap: 3 },
  { tool: "graph_graph_get", input: { ref_id: LAW.nda, children: "PARENT_OF" }, result: getResult("nda"), nodes: [brief("nda")], think: "The NDA page, for its rules.", gap: 2.5 },
  { tool: "graph_graph_get_batched", input: { ref_ids: [LAW.rules, LAW.playbook] }, result: batchedResult(["rules", "playbook"]), nodes: [brief("rules"), brief("playbook")], think: "Read the drafting rules and the negotiation playbook side by side.", gap: 3 },
  { tool: "graph_graph_get", input: { ref_id: LAW.rules, children: "PARENT_OF" }, result: getResult("rules"), nodes: [brief("rules")], think: "The drafting rules are the house standard to review against; open what is under them.", gap: 2.5 },
  { tool: "graph_graph_get", input: { ref_id: LAW.matrix }, result: getResult("matrix"), nodes: [brief("matrix")], think: "The rules say to record each deviation in the Deviation matrix — a Google Sheet. Read how it is laid out.", gap: 4 },
  { tool: "sheets_create_spreadsheet", input: { title: "Acme NDA — deviation matrix" }, result: { spreadsheetId: "1x9Acme", url: "https://docs.google.com/spreadsheets/d/1x9Acme" }, think: "Make the sheet the page describes.", gap: 3 },
  { tool: "sheets_update_values", input: { spreadsheetId: "1x9Acme", range: "A1:E4" }, result: { updatedRows: 4 }, think: "One row per deviation: residuals, term, non-solicit.", gap: 6 },
];

function agentEvents(): RunEvent[] {
  const out: RunEvent[] = [
    { type: "run.start", path: WALK_WORKFLOW, ts: at(0), runId: AGENT_WALK_RUN_ID, workflow: WALK_WORKFLOW, input: { matter: "Acme / Northwind NDA" } },
    { type: "step.start", path: AGENT_WALK_PATH, stepType: "agent", ts: at(0.1), input: { prompt: `${GOAL}\nStart at the root of the Concept tree and follow it down; when a page names a tool, use it.`, model: "claude-sonnet-5-5" } },
  ];
  let s = 0.1;
  AGENT_CALLS.forEach((c, i) => {
    s += c.gap;
    const path = `${AGENT_WALK_PATH}/${String(i + 1).padStart(3, "0")}-${c.tool}`;
    const toolCallId = `toolu_walk_${i + 1}`;
    out.push({ type: "step.start", path, stepType: `tool:${c.tool}`, toolCallId, ts: at(s), input: c.input });
    out.push({ type: "step.end", path, stepType: `tool:${c.tool}`, toolCallId, ts: at(s + 0.3), durationMs: 300, output: preview(c.result), ...(c.nodes ? { nodes: c.nodes } : {}) });
  });
  s += 5;
  out.push({ type: "step.end", path: AGENT_WALK_PATH, stepType: "agent", ts: at(s), durationMs: (s - 0.1) * 1000, output: { result: "Three deviations recorded in the deviation matrix: residuals (high), term (medium), non-solicit (low)." }, transcript: `/workflows/${WALK_WORKFLOW}/runs/${AGENT_WALK_RUN_ID}/transcripts/${AGENT_WALK_PATH}` });
  out.push({ type: "run.end", path: WALK_WORKFLOW, ts: at(s + 0.1), status: "success", durationMs: s * 1000 });
  return out;
}

export const AGENT_WALK_EVENTS: RunEvent[] = agentEvents();

/** The agent's transcript, as `run/transcript` serves it: each call, and its whole result. */
export function agentWalkTranscript(): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: GOAL }];
  AGENT_CALLS.forEach((c, i) => {
    const toolCallId = `toolu_walk_${i + 1}`;
    messages.push({ role: "assistant", content: [{ type: "reasoning", text: c.think }, { type: "tool-call", toolCallId, toolName: c.tool, input: c.input }] });
    messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId, toolName: c.tool, output: { type: "json", value: c.result } }] });
  });
  return messages;
}
