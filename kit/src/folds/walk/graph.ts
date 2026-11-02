/**
 * A walk's hop events (./source.ts) → the GRAPH a force layout draws: every
 * node the walk discovered, in the order it did, with the edge it arrived
 * by, its verdict, and which node is being expanded and which comes next.
 * Pure: a view re-folds a prefix of the hops to play the walk back.
 *
 * Moved from strut's web UI (web/src/walk-graph.ts, plans/walk-chat-demo.md
 * §3), where the chat's `graph_walk` tool streams the same hop events
 * wrapped as progress outputs (`{ status: "walking", event }`, then
 * `{ status: "done", stopped, nodes }`): `foldWalkProgress` reads those.
 */

import type { WalkBrief, WalkHopEvent, WalkVia } from "./source.js";

export type WalkGraphNodeState = "discovered" | "kept" | "dropped";

export interface WalkGraphNode {
  id: string;
  type: string;
  name: string;
  state: WalkGraphNodeState;
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

export interface WalkGraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface WalkGraphState {
  /** Insertion order; never reordered (a re-sorted node list re-scatters a force layout). */
  nodes: Map<string, WalkGraphNode>;
  edges: WalkGraphEdge[];
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

/** The final result of a walk: why it stopped, and the kept nodes with their properties. */
export interface WalkDone {
  stopped: string;
  nodes?: Array<WalkBrief & { properties?: Record<string, unknown> }>;
}

/** The chat tool's progress outputs: one per hop event, then the result. */
export type WalkProgress = { status: "walking"; event: WalkHopEvent } | ({ status: "done" } & WalkDone);

/** Supporting/refuting Evidence: the arriving `EVIDENCED_BY.strength` when
 *  there is one, else the label the walk gives it ("refutes (-1): …"). */
export function verdictOf(c: { node_type: string; name: string; via?: WalkVia }): WalkGraphNode["verdict"] {
  if (c.node_type !== "Evidence") return undefined;
  const s = c.via?.properties?.["strength"];
  if (typeof s === "number" && s !== 0) return s < 0 ? "refutes" : "supports";
  if (c.name.startsWith("refutes")) return "refutes";
  if (c.name.startsWith("supports")) return "supports";
  return undefined;
}

export function emptyWalkGraph(): WalkGraphState {
  return { nodes: new Map(), edges: [], hop: 0, done: false };
}

/** Fold hop events (and, once the walk ended, its result) into the graph. */
export function foldWalkGraph(hops: readonly WalkHopEvent[], done?: WalkDone): WalkGraphState {
  const s = emptyWalkGraph();
  for (const e of hops) applyWalkHop(s, e);
  if (done) applyWalkDone(s, done);
  return s;
}

/** Fold the chat tool's progress outputs, as strut's web UI receives them. */
export function foldWalkProgress(outputs: readonly unknown[]): WalkGraphState {
  const s = emptyWalkGraph();
  for (const o of outputs) {
    const p = o as WalkProgress;
    if (!p || typeof p !== "object") continue;
    if (p.status === "done") applyWalkDone(s, p);
    else if (p.status === "walking" && p.event) applyWalkHop(s, p.event);
  }
  return s;
}

/** Number of hop events in a progress list (the unit a view plays back by). */
export const walkProgressHops = (outputs: readonly unknown[]): number => outputs.filter((o) => (o as WalkProgress)?.status === "walking").length;

export function applyWalkDone(s: WalkGraphState, d: WalkDone): void {
  s.done = true;
  s.stopped = d.stopped;
  s.current = undefined;
  s.next = undefined;
  for (const n of d.nodes ?? []) {
    const node = s.nodes.get(n.ref_id);
    if (node && n.properties) node.properties = n.properties;
  }
}

export function applyWalkHop(s: WalkGraphState, e: WalkHopEvent): void {
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
      const verdict = verdictOf(c);
      s.nodes.set(c.ref_id, {
        id: c.ref_id,
        type: c.node_type,
        name: c.name,
        state: "discovered",
        hop: e.iteration,
        ...(c.via ? { via: c.via } : {}),
        ...(verdict ? { verdict } : {}),
        mergedCount: 0,
        merged: [],
      });
      if (c.via && s.nodes.has(c.via.from)) s.edges.push({ source: c.via.from, target: c.ref_id, type: c.via.edge_type });
    }
  } else if (e.type === "step.end" && e.output) {
    for (const v of e.output.verdicts ?? []) {
      const n = s.nodes.get(v.ref_id);
      if (!n || n.state !== "discovered") continue; // a merged member's verdict is its group's
      if (v.relevance !== undefined) n.relevance = v.relevance;
      n.state = v.kept ? "kept" : "dropped";
    }
    s.next = e.output.next?.ref_id;
    if (e.output.sufficient !== undefined) s.sufficient = e.output.sufficient;
  } else if (e.type === "step.error") {
    s.error = e.error?.message ?? "walk failed";
  }
}

/** Header line: `hop 6 · 14 kept · walking…` while it plays, `hop 11 · 18 kept` once done. */
export function walkSummary(s: WalkGraphState, live: boolean): string {
  const kept = [...s.nodes.values()].filter((n) => n.state === "kept").length;
  const tail = s.error ? `error: ${s.error}` : s.done ? "" : live ? "walking…" : "interrupted";
  return `hop ${s.hop + 1} · ${kept} kept${tail ? ` · ${tail}` : ""}`;
}
