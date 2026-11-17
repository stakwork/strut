// Brainstorms on the board: a question asked about a card, the options under
// it, and the questions an option leads to. Built from typed nodes and the
// edges among them, like the plan (./plan.ts); which types and edges those
// are is data. Pure.
import { goalOf, isLive, type Plan, type RawEdge, type RawNode } from "./plan";

export interface BrainstormRoles {
  question: string;
  option: string;
  /** question → the card it is about. */
  about: string;
  /** question → its options, and option → the questions it leads to. */
  leads: string;
}

/** The brainstorm trees Hive and the canvas write. */
export const HIVE_BRAINSTORM: BrainstormRoles = { question: "Question", option: "Option", about: "ABOUT", leads: "PARENT_OF" };

type By = "person" | "agent" | null;

export interface Ask {
  id: string;
  text: string;
  /** Still waiting on a choice. */
  open: boolean;
  by: By;
  /** The job that wrote it, when the graph says. */
  job: string | null;
  at: number;
  /** The plan card it is about; null when that card is not on the board. */
  about: string | null;
  options: string[];
  /** Asked about a card, not led to by an option. */
  root: boolean;
}

export interface Choice {
  id: string;
  text: string;
  state: "open" | "chosen" | "rejected";
  by: By;
  /** The questions choosing this leads to. */
  asks: string[];
}

export interface Brainstorms {
  asks: Record<string, Ask>;
  choices: Record<string, Choice>;
  /** A plan card's root questions, the open ones first, then the newest. */
  byCard: Record<string, string[]>;
}

const byOf = (p: Record<string, unknown>): By => {
  const who = String(p["made_by"] ?? p["created_by_kind"] ?? "").toLowerCase();
  return ["model", "jamie", "strut", "agent"].includes(who) ? "agent" : ["user", "person", "human"].includes(who) ? "person" : null;
};
const textOf = (n: RawNode): string => {
  const t = n.properties?.["text"];
  return ((typeof t === "string" && t) || n.name || n.ref_id.slice(0, 8)).trim();
};
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function buildBrainstorms(questions: RawNode[], options: RawNode[], edges: RawEdge[], plan: Plan, roles: BrainstormRoles = HIVE_BRAINSTORM): Brainstorms {
  const asks: Record<string, Ask> = {};
  const choices: Record<string, Choice> = {};
  for (const n of questions) {
    const p = n.properties ?? {};
    if (!isLive(p) || asks[n.ref_id]) continue;
    asks[n.ref_id] = { id: n.ref_id, text: textOf(n), open: p["state"] !== "decided", by: byOf(p), job: typeof p["job"] === "string" && p["job"] ? p["job"] : null, at: num(p["date_added_to_graph"]), about: null, options: [], root: true };
  }
  for (const n of options) {
    const p = n.properties ?? {};
    if (!isLive(p) || choices[n.ref_id]) continue;
    const s = p["state"];
    choices[n.ref_id] = { id: n.ref_id, text: textOf(n), state: s === "chosen" ? "chosen" : s === "rejected" ? "rejected" : "open", by: byOf(p), asks: [] };
  }
  for (const e of edges) {
    const q = asks[e.source];
    if (q && e.edge_type === roles.about && plan.cards[e.target] && !q.about) q.about = e.target;
    else if (q && e.edge_type === roles.leads && choices[e.target] && !q.options.includes(e.target)) q.options.push(e.target);
    else if (choices[e.source] && e.edge_type === roles.leads && asks[e.target]) {
      asks[e.target]!.root = false;
      if (!choices[e.source]!.asks.includes(e.target)) choices[e.source]!.asks.push(e.target);
    }
  }
  // Once a question is decided, what was not chosen was passed over.
  for (const q of Object.values(asks)) {
    if (q.open || !q.options.some((o) => choices[o]!.state === "chosen")) continue;
    for (const o of q.options) if (choices[o]!.state === "open") choices[o]!.state = "rejected";
  }
  const byCard: Record<string, string[]> = {};
  for (const q of Object.values(asks)) if (q.root && q.about) (byCard[q.about] ??= []).push(q.id);
  const order = (a: string, b: string) => Number(asks[b]!.open) - Number(asks[a]!.open) || asks[b]!.at - asks[a]!.at || asks[a]!.text.localeCompare(asks[b]!.text);
  for (const id of Object.keys(byCard)) byCard[id]!.sort(order);
  return { asks, choices, byCard };
}

/** Every root question about a goal or anything under it, the open ones first. */
export function asksIn(plan: Plan, b: Brainstorms, goal: string): string[] {
  const out: string[] = [];
  for (const [card, ids] of Object.entries(b.byCard)) if (goalOf(plan, card) === goal) out.push(...ids);
  return out.sort((x, y) => Number(b.asks[y]!.open) - Number(b.asks[x]!.open) || b.asks[y]!.at - b.asks[x]!.at || b.asks[x]!.text.localeCompare(b.asks[y]!.text));
}

/** How many open root questions each goal holds. */
export function openByGoal(plan: Plan, b: Brainstorms): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [card, ids] of Object.entries(b.byCard)) {
    const g = goalOf(plan, card);
    const n = ids.filter((id) => b.asks[id]!.open).length;
    if (g && n) out[g] = (out[g] ?? 0) + n;
  }
  return out;
}

/** The jobs that wrote a card's questions: what ties a running job to a card today. */
export function jobsByCard(b: Brainstorms): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of Object.values(b.asks)) {
    if (!q.job || !q.about) continue;
    const list = (out[q.about] ??= []);
    if (!list.includes(q.job)) list.push(q.job);
  }
  return out;
}
