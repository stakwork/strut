// The gallery's graph: a small Concept tree (PARENT_OF, parent → child) and
// two documents about it, answered the way graph-get-batched,
// graph-neighbors and graph-search answer.
import type { GraphHit, GraphNeighbor, GraphNode } from "../lib/graph";
import { REF } from "./runs";
import { FINDING } from "./trace";

const node = (ref_id: string, node_type: string, name: string, properties: Record<string, unknown>): Omit<GraphNode, "edges"> => ({
  ref_id, node_type, name, properties: { name, namespace: "default", ...properties },
});

const NODES: Array<Omit<GraphNode, "edges">> = [
  node(REF.medicine, "Concept", "Medicine", { description: "The root of the clinical tree.", docs: "# Medicine\n\nEvery clinical Concept descends from here." }),
  node(REF.cardiology, "Concept", "Cardiology", { description: "The heart and its vessels.", docs: "Cardiology covers the **heart**, its rhythm and its vessels.\n\n- arrhythmias\n- hypertension\n- heart failure" }),
  node(REF.arrhythmia, "Concept", "Arrhythmia", { description: "Irregular heart rhythm, atrial fibrillation the most common.", docs: "An arrhythmia is an irregular rhythm. **Atrial fibrillation** (AF) is the most common sustained one; hypertension is its leading modifiable risk factor." }),
  node(REF.hypertension, "Concept", "Hypertension", { description: "Raised arterial blood pressure.", docs: "Sustained blood pressure ≥ 130/80 mmHg. Raises the risk of AF about 1.5-fold." }),
  node(REF.heartFailure, "Concept", "Heart failure", { description: "The heart cannot pump enough to meet the body's needs." }),
  node(REF.guideline, "Document", "ESC guideline 2026", { content: "Rhythm control is preferred early in AF with hypertension…", source_link: "https://example.org/esc-2026" }),
  node(REF.trial, "Document", "SPRINT-AF trial", { content: "Intensive blood-pressure control reduced incident AF by 26%…" }),
  // What AgentTrace's run wrote (fixtures/trace.ts).
  node(FINDING.af, "Finding", "Hypertension raises AF risk ~1.5-fold", { description: "ESC guideline 2026, §3.2 line 41.", source_ref: "esc-guideline-2026.txt:41" }),
  node(FINDING.dose, "Finding", "Early rhythm control preferred when AF and hypertension coexist", { description: "ESC guideline 2026, §5.1." }),
  node(FINDING.bp, "Finding", "Intensive BP control cut incident AF by ~25%", { description: "SPRINT-AF Table 2: 88/4678 vs 118/4683; RRR 25.3% (95% CI 3–43%).", source_ref: "sprint-af-trial.txt:214" }),
];

const EDGES: Array<{ source: string; target: string; edge_type: string }> = [
  { source: REF.medicine, target: REF.cardiology, edge_type: "PARENT_OF" },
  { source: REF.cardiology, target: REF.arrhythmia, edge_type: "PARENT_OF" },
  { source: REF.cardiology, target: REF.hypertension, edge_type: "PARENT_OF" },
  { source: REF.cardiology, target: REF.heartFailure, edge_type: "PARENT_OF" },
  { source: REF.guideline, target: REF.arrhythmia, edge_type: "ABOUT" },
  { source: REF.trial, target: REF.arrhythmia, edge_type: "ABOUT" },
  { source: REF.trial, target: REF.hypertension, edge_type: "ABOUT" },
  { source: FINDING.af, target: REF.arrhythmia, edge_type: "ABOUT" },
  { source: FINDING.dose, target: REF.arrhythmia, edge_type: "ABOUT" },
  { source: FINDING.bp, target: REF.arrhythmia, edge_type: "ABOUT" },
];

function edgesOf(ref: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of EDGES) if (e.source === ref || e.target === ref) out[e.edge_type] = (out[e.edge_type] ?? 0) + 1;
  return out;
}

const byRef = new Map(NODES.map((n) => [n.ref_id, { ...n, edges: edgesOf(n.ref_id) } as GraphNode]));

export function fixtureNode(ref: string): GraphNode | undefined {
  return byRef.get(ref);
}

export function getBatched(refIds: string[]): { requested: number; returned: number; nodes: Array<GraphNode | { ref_id: string; error: string }> } {
  const nodes = refIds.map((r) => byRef.get(r) ?? { ref_id: r, error: `node not found: ${r}` });
  return { requested: refIds.length, returned: nodes.filter((n) => !("error" in n)).length, nodes };
}

export function neighbors(ref: string, edgeTypes?: string[]): GraphNeighbor[] {
  const out: GraphNeighbor[] = [];
  for (const e of EDGES) {
    if (edgeTypes?.length && !edgeTypes.includes(e.edge_type)) continue;
    const forward = e.source === ref;
    if (!forward && e.target !== ref) continue;
    const other = byRef.get(forward ? e.target : e.source);
    if (!other) continue;
    out.push({ ref_id: other.ref_id, node_type: other.node_type, name: other.name, edge_type: e.edge_type, direction: forward ? "forward" : "reverse", edges: other.edges });
  }
  return out;
}

export function search(q: string, type?: string, limit = 10): GraphHit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const types = type?.split(",").map((t) => t.trim()).filter(Boolean);
  return [...byRef.values()]
    .filter((n) => !types?.length || types.includes(n.node_type))
    .filter((n) => {
      const text = `${n.name} ${String(n.properties["description"] ?? "")} ${String(n.properties["content"] ?? "")}`.toLowerCase();
      return words.some((w) => text.includes(w));
    })
    .slice(0, limit)
    .map((n) => ({ ref_id: n.ref_id, node_type: n.node_type, name: n.name, description: String(n.properties["description"] ?? n.properties["content"] ?? ""), edges: n.edges }));
}
