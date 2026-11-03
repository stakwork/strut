// The gallery's LARGE run, for RunGraph at the scale of a workspace graph: a
// matter review that touches about 3,000 nodes — a survey of the law tree, a
// foreach that reads ~290 documents of one practice area per iteration, a
// classify step that reads some again and writes 60 findings, a draft that
// reads them — names past 120 characters among them. Generated,
// deterministic; the fixture client answers its graph reads.
import type { RunEvent } from "@strut/kit";
import type { GraphNeighbor, GraphNode } from "../lib/graph";

export const LARGE_RUN_WORKFLOW = "matter-review";
export const LARGE_RUN_ID = "1790000000980";

const AREAS = [
  "Corporate / M&A", "Data protection", "Employment", "Litigation", "Tax", "Real estate",
  "Competition", "Financial regulation", "Intellectual property", "Insurance", "Energy", "Public procurement",
];
const KINDS = ["board minutes", "side letter", "disclosure schedule", "engagement letter", "audit report", "board pack", "supply agreement", "lease", "licence", "policy"];
const LONG = [
  "Disclosure schedule item on the counterparty's representation about undisclosed liabilities, as amended by the side letter of 3 March and the later waiver",
  "Board resolution approving the restructuring of the European holding companies, including the intra-group loan agreements and the related guarantees",
  "Supply agreement with the principal contract manufacturer, its change-of-control clause, termination rights and the exclusivity carve-outs for the Nordic region",
];
const PER_AREA = 242;
const ITERATIONS = 10;
const FINDINGS = 60;

const id = (kind: string, n: number) => `rl-${kind}-${String(n).padStart(4, "0")}`;
const ROOT = id("concept", 0);
const AREA_IDS = AREAS.map((_, i) => id("concept", i + 1));

const NODES = new Map<string, GraphNode>();
const PARENT = new Map<string, string>();
const put = (ref_id: string, node_type: string, name: string, description: string, parent?: string) => {
  NODES.set(ref_id, { ref_id, node_type, name, properties: { name, namespace: "default", description }, edges: {} });
  if (parent) PARENT.set(ref_id, parent);
};
put(ROOT, "Concept", "Law", "The root of the legal tree.");
AREAS.forEach((name, i) => put(AREA_IDS[i]!, "Concept", name, `The ${name} practice area.`, ROOT));
const docsOf: string[][] = AREAS.map(() => []);
for (let a = 0; a < AREAS.length; a++) {
  for (let i = 0; i < PER_AREA; i++) {
    const n = a * PER_AREA + i;
    const long = i % 11 === 3;
    const name = long ? `${LONG[n % LONG.length]} (${AREAS[a]}, ${n})` : `${AREAS[a]} — ${KINDS[n % KINDS.length]} ${n}`;
    const ref = id("doc", n);
    put(ref, n % 7 === 0 ? "Clause" : "Document", name, `A ${KINDS[n % KINDS.length]} the matter's data room holds.`, AREA_IDS[a]);
    docsOf[a]!.push(ref);
  }
}
const FINDING_IDS = Array.from({ length: FINDINGS }, (_, i) => id("finding", i));
FINDING_IDS.forEach((ref, i) =>
  put(ref, "Finding", i % 6 === 0 ? `Finding ${i}: the change-of-control clause in the principal supply agreement survives the restructuring and needs the counterparty's written consent` : `Finding ${i}: ${KINDS[i % KINDS.length]} needs review`, "A finding the classify step wrote."),
);
// Edge counts, as graph-get-batched answers them.
for (const [child, parent] of PARENT) {
  const c = NODES.get(child)!;
  const p = NODES.get(parent)!;
  c.edges["<-PARENT_OF"] = 1;
  p.edges["PARENT_OF"] = (p.edges["PARENT_OF"] ?? 0) + 1;
}

/** A node of the large run, as graph-get-batched answers. */
export function largeRunNode(ref: string): GraphNode | undefined {
  return NODES.get(ref);
}

/** Its neighbours along PARENT_OF, as graph-neighbors answers; undefined for a ref not of this run. */
export function largeRunNeighbors(ref: string, edgeTypes?: string[]): GraphNeighbor[] | undefined {
  if (!NODES.has(ref)) return undefined;
  if (edgeTypes?.length && !edgeTypes.includes("PARENT_OF")) return [];
  const out: GraphNeighbor[] = [];
  const parent = PARENT.get(ref);
  const brief = (r: string, direction: "forward" | "reverse"): GraphNeighbor => {
    const n = NODES.get(r)!;
    return { ref_id: r, node_type: n.node_type, name: n.name, edge_type: "PARENT_OF", direction, edges: n.edges };
  };
  if (parent) out.push(brief(parent, "reverse"));
  for (const [child, p] of PARENT) if (p === ref) out.push(brief(child, "forward"));
  return out;
}

const T0 = Date.UTC(2026, 10, 2, 16, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ref = (r: string) => {
  const n = NODES.get(r)!;
  return { ref_id: r, node_type: n.node_type, name: n.name };
};

function largeRunEvents(): RunEvent[] {
  const wf = LARGE_RUN_WORKFLOW;
  const out: RunEvent[] = [{ type: "run.start", path: wf, ts: at(0), runId: LARGE_RUN_ID, workflow: wf, input: { matter: "Acme restructuring" } }];
  let s = 1;
  const step = (path: string, stepType: string, input: unknown, nodes: string[], seconds = 1) => {
    out.push({ type: "step.start", path, stepType, ts: at(s), input });
    out.push({ type: "step.end", path, stepType, ts: at(s + seconds * 0.8), durationMs: seconds * 800, output: { returned: nodes.length }, nodes: nodes.map(ref) });
    s += seconds;
  };
  // The survey: an agent reading the law tree's top.
  out.push({ type: "step.start", path: `${wf}/survey`, stepType: "agent", ts: at(s), input: { prompt: "Map the practice areas the restructuring touches." } });
  step(`${wf}/survey/001-graph_graph_get`, "tool:graph_graph_get", { node_type: "Concept", name: "Law", children: "PARENT_OF" }, [ROOT]);
  AREA_IDS.forEach((a, i) => step(`${wf}/survey/${String(i + 2).padStart(3, "0")}-graph_graph_get`, "tool:graph_graph_get", { ref_id: a }, [a], 0.5));
  out.push({ type: "step.end", path: `${wf}/survey`, stepType: "agent", ts: at(s), output: { result: "Twelve areas." } });
  // The ingest: one practice area's documents an iteration.
  out.push({ type: "step.start", path: `${wf}/ingest`, stepType: "foreach", ts: at(s), input: AREAS.slice(0, ITERATIONS) });
  for (let k = 0; k < ITERATIONS; k++) step(`${wf}/ingest#${k}/fetch`, "graph/graph-get-batched", { ref_ids: `${PER_AREA} documents of ${AREAS[k]}` }, docsOf[k]!, 3);
  out.push({ type: "step.end", path: `${wf}/ingest`, stepType: "foreach", ts: at(s), output: { iterations: ITERATIONS } });
  // The classify: the rest of the areas, some documents again, and the findings written.
  out.push({ type: "step.start", path: `${wf}/classify`, stepType: "agent", ts: at(s), input: { prompt: "Classify what matters." } });
  step(`${wf}/classify/001-graph_graph_get_batched`, "tool:graph_graph_get_batched", { ref_ids: "areas 11–12" }, [...docsOf[10]!, ...docsOf[11]!], 3);
  step(`${wf}/classify/002-graph_graph_get_batched`, "tool:graph_graph_get_batched", { ref_ids: "a second look" }, docsOf.slice(0, ITERATIONS).flatMap((d) => d.slice(0, 20)), 2);
  FINDING_IDS.forEach((f, i) => step(`${wf}/classify/${String(i + 3).padStart(3, "0")}-graph_create_node`, "tool:graph_create_node", { node_type: "Finding" }, [f], 0.3));
  out.push({ type: "step.end", path: `${wf}/classify`, stepType: "agent", ts: at(s), output: { result: `${FINDINGS} findings.` } });
  // The draft: the findings, read back.
  step(`${wf}/draft`, "graph/graph-get-batched", { ref_ids: "the findings" }, FINDING_IDS.slice(0, 24), 2);
  out.push({ type: "run.end", path: wf, ts: at(s + 0.2), status: "success", durationMs: (s + 0.2) * 1000 });
  return out;
}

export const LARGE_RUN_EVENTS: RunEvent[] = largeRunEvents();

/** What two lenses would highlight: the walk the review took down the tree, and the work products it wrote. */
export const LARGE_RUN_HIGHLIGHTS = {
  walk: [ROOT, AREA_IDS[3]!, ...docsOf[3]!.filter((_, i) => i % 9 === 0)],
  products: FINDING_IDS,
};
