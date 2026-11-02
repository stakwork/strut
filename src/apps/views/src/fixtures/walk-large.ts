// The gallery's LARGE walk, for WalkView at the scale of a workspace graph:
// a `graph/walk` step over thousands of nodes — 9 hops, about 2,000
// candidates, some names past 120 characters — the shape its events have
// when runWalk walks a real graph. Generated, deterministic.
import type { RunEvent } from "@strut/kit";
import type { GraphNode } from "../lib/graph";
import { WALK_WORKFLOW } from "./walk";

export const BIG_WALK_RUN_ID = "1790000000970";

const HOPS = 9;
const PER_HOP = 222;
const TYPES = ["Concept", "Document", "Clause", "Precedent"] as const;
const AREAS = ["Data protection", "Employment", "Commercial contracts", "Litigation", "Tax", "Real estate", "Competition", "Financial regulation", "Intellectual property", "Corporate governance"];
const TOPICS = ["retention schedule", "notice period", "limitation of liability", "governing law", "assignment", "audit rights", "termination for convenience", "most-favoured nation", "non-solicit", "confidentiality carve-outs", "indemnity cap", "force majeure"];
/** Names a graph really holds: a clause's whole heading, a document's full title. */
const LONG = [
  "Cross-border transfer addendum for processors outside the EEA where the sub-processor's jurisdiction lacks an adequacy decision and no derogation applies",
  "Board resolution approving the restructuring of the European holding companies, including the intra-group loan agreements and the related guarantees (draft 7)",
  "Precedent: settlement of the 2019 supply dispute over late delivery penalties, liquidated damages and the buyer's right to terminate for repeated delay",
  "Standard indemnity for third-party intellectual property claims arising from the customer's modifications, combinations or use outside the documentation",
];

/** A small seeded generator: the same graph every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Big {
  ref_id: string;
  node_type: string;
  name: string;
  relevance: number;
}

const random = rng(970);
const NODES = new Map<string, GraphNode>();
const hops: Array<{ expanded: Big | null; candidates: Big[]; next: Big; sufficient: number }> = [];
let previous: Big | null = null;
for (let hop = 0; hop < HOPS; hop++) {
  const candidates: Big[] = [];
  const pick = Math.floor(random() * PER_HOP);
  for (let i = 0; i < PER_HOP; i++) {
    const n = hop * PER_HOP + i;
    const long = i % 9 === 4 || (hop === 4 && i === pick);
    const name = long ? `${LONG[n % LONG.length]} §${n}` : `${AREAS[n % AREAS.length]} — ${TOPICS[(n * 7) % TOPICS.length]} ${n}`;
    const relevance = i === pick ? 0.9 + random() * 0.09 : random() < 0.015 ? 0.7 + random() * 0.2 : random() * 0.6;
    const node: Big = { ref_id: `bigwalk-${hop}-${String(i).padStart(3, "0")}`, node_type: TYPES[n % TYPES.length]!, name, relevance: Number(relevance.toFixed(2)) };
    candidates.push(node);
    NODES.set(node.ref_id, {
      ref_id: node.ref_id,
      node_type: node.node_type,
      name,
      properties: { name, namespace: "default", description: `One of ${(HOPS * PER_HOP).toLocaleString("en-US")} nodes the large walk met: ${name}.` },
      edges: { PARENT_OF: hop < HOPS - 1 && i === pick ? PER_HOP : 0 },
    });
  }
  const next = candidates[pick]!;
  hops.push({ expanded: previous, candidates, next, sufficient: Number(Math.min(0.95, 0.05 + hop * 0.11).toFixed(2)) });
  previous = next;
}

/** A node of the large walk, as graph-get-batched answers. */
export function bigWalkNode(ref: string): GraphNode | undefined {
  return NODES.get(ref);
}

const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const brief = (n: Big) => ({ ref_id: n.ref_id, node_type: n.node_type, name: n.name });
const THRESHOLD = 0.7;
const GOAL = "Find every rule that bears on a cross-border data transfer in the Acme restructuring, across the whole workspace graph.";

function bigWalkEvents(): RunEvent[] {
  const gather = `${WALK_WORKFLOW}/gather`;
  const out: RunEvent[] = [
    { type: "run.start", path: WALK_WORKFLOW, ts: at(0), runId: BIG_WALK_RUN_ID, workflow: WALK_WORKFLOW, input: { matter: "Acme restructuring" } },
    { type: "step.start", path: gather, stepType: "graph/walk", ts: at(0.2), input: { goal: GOAL, query: "cross-border data transfer", maxHops: 12, maxNodes: 60, threshold: THRESHOLD } },
  ];
  let s = 0.4;
  hops.forEach((h, hop) => {
    const path = `${gather}/${String(hop + 1).padStart(3, "0")}-hop`;
    const candidates = h.candidates.map((c) => ({ ...brief(c), ...(h.expanded ? { via: { from: h.expanded.ref_id, edge_type: "PARENT_OF", direction: "forward" } } : {}) }));
    out.push({ type: "step.start", path, stepType: "walk:hop", iteration: hop, ts: at(s), input: { hop, expanded: h.expanded ? brief(h.expanded) : null, candidates, frontier: [] } });
    const verdicts = h.candidates.map((c) => ({ ref_id: c.ref_id, relevance: c.relevance, kept: c.relevance >= THRESHOLD }));
    out.push({ type: "step.end", path, stepType: "walk:hop", iteration: hop, ts: at(s + 1.2), durationMs: 1200, output: { hop, candidates: candidates.length, verdicts, next: brief(h.next), sufficient: h.sufficient } });
    s += 1.6;
  });
  out.push({ type: "step.end", path: gather, stepType: "graph/walk", ts: at(s), durationMs: (s - 0.2) * 1000, output: { goal: GOAL, nodes: [], hops: [], stopped: "hops" } });
  out.push({ type: "run.end", path: WALK_WORKFLOW, ts: at(s + 0.1), status: "success", durationMs: s * 1000 });
  return out;
}

export const BIG_WALK_EVENTS: RunEvent[] = bigWalkEvents();
