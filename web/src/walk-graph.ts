// Fold graph_walk's progress (plans/walk-chat-demo.md §3) into the graph the
// chat draws. The tool yields one hop event per progress output — a
// `walk:hop` step.start (what the hop discovered, each candidate with the edge
// it arrived by) and a step.end (the verdicts) — then a final `done` result.
// Pure: the view re-folds a prefix of the outputs to play the walk back.

export interface WalkVia {
  from: string;
  edge_type: string;
  direction: "forward" | "reverse";
  properties?: Record<string, unknown>;
}

export type WalkNodeState = "discovered" | "kept" | "dropped";

export interface WalkNode {
  id: string;
  type: string;
  name: string;
  state: WalkNodeState;
  relevance?: number;
  /** The hop that discovered it (0 = a seed). */
  hop: number;
  via?: WalkVia;
  /** Evidence only: the verdict it carries. */
  verdict?: "supports" | "refutes";
  /** Evidence folded into this one (same claim, same verdict, other runs). */
  mergedCount: number;
  merged: string[];
  /** From the final result — kept nodes only. */
  properties?: Record<string, unknown>;
}

export interface WalkEdge {
  source: string;
  target: string;
  type: string;
}

export interface WalkState {
  /** Insertion order; never reordered (a re-sorted node list re-scatters a force layout). */
  nodes: Map<string, WalkNode>;
  edges: WalkEdge[];
  /** The node whose neighbors the latest hop judged. */
  current?: string;
  /** The node the latest hop chose to expand next. */
  next?: string;
  hop: number;
  sufficient?: number;
  done: boolean;
  stopped?: string;
  error?: string;
}

type Brief = { ref_id: string; node_type: string; name: string };
type HopCandidate = Brief & { via?: WalkVia; merged_into?: string };
type HopEvent = {
  type: "step.start" | "step.end" | "step.error";
  iteration: number;
  input?: { hop: number; expanded: Brief | null; candidates: HopCandidate[] };
  output?: { verdicts: Array<{ ref_id: string; relevance: number; kept: boolean }>; next?: Brief; sufficient: number };
  error?: { message: string };
};
export type WalkProgress =
  | { status: "walking"; event: HopEvent }
  | { status: "done"; stopped: string; nodes: Array<Brief & { properties?: Record<string, unknown> }> };

/** Supporting/refuting Evidence: the arriving `EVIDENCED_BY.strength` when
 *  there is one, else the label the walk gives it ("refutes (-1): …"). */
export function verdictOf(c: { node_type: string; name: string; via?: WalkVia }): WalkNode["verdict"] {
  if (c.node_type !== "Evidence") return undefined;
  const s = c.via?.properties?.["strength"];
  if (typeof s === "number" && s !== 0) return s < 0 ? "refutes" : "supports";
  if (c.name.startsWith("refutes")) return "refutes";
  if (c.name.startsWith("supports")) return "supports";
  return undefined;
}

export function emptyWalk(): WalkState {
  return { nodes: new Map(), edges: [], hop: 0, done: false };
}

export function foldWalk(outputs: readonly unknown[]): WalkState {
  const s = emptyWalk();
  for (const o of outputs) applyWalk(s, o as WalkProgress);
  return s;
}

/** Number of hop events in a progress list (the unit the view plays back by). */
export const hopEvents = (outputs: readonly unknown[]) => outputs.filter((o) => (o as WalkProgress)?.status === "walking").length;

function applyWalk(s: WalkState, p: WalkProgress): void {
  if (!p || typeof p !== "object") return;
  if (p.status === "done") {
    s.done = true;
    s.stopped = p.stopped;
    s.current = undefined;
    s.next = undefined;
    for (const n of p.nodes ?? []) {
      const node = s.nodes.get(n.ref_id);
      if (node && n.properties) node.properties = n.properties;
    }
    return;
  }
  const e = p.event;
  if (!e) return;
  s.hop = e.iteration;
  if (e.type === "step.start" && e.input) {
    s.current = e.input.expanded?.ref_id;
    s.next = undefined;
    for (const c of e.input.candidates ?? []) {
      if (c.merged_into) {
        const g = s.nodes.get(c.merged_into);
        if (g) {
          g.mergedCount++;
          g.merged.push(c.name);
        }
        continue;
      }
      if (s.nodes.has(c.ref_id)) continue;
      s.nodes.set(c.ref_id, {
        id: c.ref_id,
        type: c.node_type,
        name: c.name,
        state: "discovered",
        hop: e.iteration,
        ...(c.via ? { via: c.via } : {}),
        ...(verdictOf(c) ? { verdict: verdictOf(c) } : {}),
        mergedCount: 0,
        merged: [],
      });
      if (c.via && s.nodes.has(c.via.from)) s.edges.push({ source: c.via.from, target: c.ref_id, type: c.via.edge_type });
    }
  } else if (e.type === "step.end" && e.output) {
    for (const v of e.output.verdicts ?? []) {
      const n = s.nodes.get(v.ref_id);
      if (!n || n.state !== "discovered") continue; // a merged member's verdict is its group's
      n.relevance = v.relevance;
      n.state = v.kept ? "kept" : "dropped";
    }
    s.next = e.output.next?.ref_id;
    s.sufficient = e.output.sufficient;
  } else if (e.type === "step.error") {
    s.error = e.error?.message ?? "walk failed";
  }
}

/** Header line: `hop 6 · 14 kept · walking…` while it plays, `hop 11 · 18 kept` once done. */
export function walkSummary(s: WalkState, live: boolean): string {
  const kept = [...s.nodes.values()].filter((n) => n.state === "kept").length;
  const tail = s.error ? `error: ${s.error}` : s.done ? "" : live ? "walking…" : "interrupted";
  return `hop ${s.hop + 1} · ${kept} kept${tail ? ` · ${tail}` : ""}`;
}
