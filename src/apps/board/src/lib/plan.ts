// The plan a board draws: goals, the groups under each, the work under each
// group. Built from typed graph nodes and the edges among them, with no
// knowledge of which types those are — `Roles` says which type plays which
// part, so the same board reads a product plan, a legal matter or anything
// else shaped goal → group → work. Pure: no React, no client.

export type Role = "goal" | "group" | "work";
/** What a card's status means on the board, whatever the type calls it. */
export type State = "idle" | "prog" | "done" | "block";

/** Which node types play which role, and which edges mean "contains". */
export interface Roles {
  goal: string;
  group: string;
  work: string;
  contains: string[];
  /** Each role's statuses in the type's own words, in the order work moves through them. */
  statuses: Record<Role, string[]>;
  /** The property that holds each role's date to be done by, where it has one. */
  due: Partial<Record<Role, string>>;
  /** How a person adds a card of each role by hand: the property that is its own id, the status it
   *  starts in, the edge from the card that holds it, and the property that keeps that card's id. */
  make: Record<Role, { id: string; status: string; edge?: string; parent?: string }>;
}

/** The plan Hive and the canvas write: an initiative's milestones and their features. */
export const HIVE_PLAN: Roles = {
  goal: "HiveInitiative",
  group: "HiveMilestone",
  work: "InitiativeFeature",
  contains: ["HAS_MILESTONE", "HAS_FEATURE"],
  statuses: { goal: ["DRAFT", "ACTIVE", "COMPLETED"], group: ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"], work: ["BACKLOG", "IN_PROGRESS", "COMPLETED"] },
  due: { goal: "target_date", group: "due_date" },
  make: {
    goal: { id: "initiative_id", status: "DRAFT" },
    group: { id: "milestone_id", status: "NOT_STARTED", edge: "HAS_MILESTONE", parent: "initiative_id" },
    work: { id: "feature_id", status: "BACKLOG", edge: "HAS_FEATURE" },
  },
};

/** What a new card of `role` is written as: its own id, where it starts, and — under a card — that
 *  card's id and its place after the last of its siblings. Pure, so the write itself is two calls. */
export function newCard(roles: Roles, role: Role, title: string, id: string, under?: { card: Card; siblings: Card[] }): Record<string, unknown> {
  const make = roles.make[role];
  const data: Record<string, unknown> = { name: title, [make.id]: id, status: make.status };
  if (!under) return data;
  const parentId = under.card.props[roles.make[under.card.role].id];
  if (make.parent && typeof parentId === "string") data[make.parent] = parentId;
  if (role === "group") data["sequence"] = Math.max(0, ...under.siblings.map((s) => (s.seq === Number.MAX_SAFE_INTEGER ? 0 : s.seq))) + 1;
  return data;
}

export interface RawNode {
  ref_id: string;
  name?: string;
  properties?: Record<string, unknown>;
}
export interface RawEdge {
  source: string;
  target: string;
  edge_type: string;
}

export interface Card {
  id: string;
  role: Role;
  title: string;
  state: State;
  /** The type's own word for its status, lower case ("draft", "in_progress"); "" when it has none. */
  status: string;
  /** Its place among its siblings; cards without one sort after those with. */
  seq: number;
  /** When it was written (epoch ms), 0 when unknown. */
  at: number;
  /** Who wrote it, when the graph says. */
  by: "person" | "agent" | null;
  /** Everything the graph holds on it, as written: what its details show and a person edits. */
  props: Record<string, unknown>;
}

export interface Plan {
  cards: Record<string, Card>;
  /** A card's children, in order. */
  kids: Record<string, string[]>;
  parent: Record<string, string>;
  /** Every goal: the ones in progress first, then the fullest, then the newest. */
  goals: string[];
}

const DONE = new Set(["completed", "complete", "done"]);
const PROG = new Set(["in_progress", "active", "started"]);

/** A status in the type's own words, as the board's four states. `blocked` wins over the status. */
export function stateOf(status: string, blocked = false): State {
  if (blocked || status === "blocked") return "block";
  if (DONE.has(status)) return "done";
  if (PROG.has(status)) return "prog";
  return "idle";
}

/** Soft-deleted nodes stay in the graph; a board never draws them. */
export function isLive(props: Record<string, unknown> | undefined): boolean {
  return !props?.["deleted_at"] && props?.["is_deleted"] !== true;
}

const AGENTS = new Set(["jamie", "strut", "model", "agent"]);
const PEOPLE = new Set(["person", "user", "human"]);

export function cardOf(role: Role, n: RawNode): Card {
  const p = n.properties ?? {};
  const status = typeof p["status"] === "string" ? p["status"].toLowerCase() : "";
  const kind = typeof p["created_by_kind"] === "string" ? p["created_by_kind"].toLowerCase() : "";
  const added = p["date_added_to_graph"];
  return {
    id: n.ref_id,
    role,
    title: (n.name || (typeof p["name"] === "string" ? p["name"] : "") || n.ref_id.slice(0, 8)).trim(),
    state: stateOf(status, p["blocked"] === true),
    status,
    seq: typeof p["sequence"] === "number" ? p["sequence"] : Number.MAX_SAFE_INTEGER,
    at: typeof added === "number" ? added : 0,
    by: AGENTS.has(kind) ? "agent" : PEOPLE.has(kind) ? "person" : null,
    props: p,
  };
}

/** What may sit under what: a goal holds groups (and work with no group), a group holds work. */
const HOLDS: Record<Role, Role[]> = { goal: ["group", "work"], group: ["work"], work: [] };

export function buildPlan(nodes: Record<Role, RawNode[]>, edges: RawEdge[], roles: Roles = HIVE_PLAN): Plan {
  const cards: Record<string, Card> = {};
  for (const role of ["goal", "group", "work"] as const) {
    for (const n of nodes[role] ?? []) if (isLive(n.properties) && !cards[n.ref_id]) cards[n.ref_id] = cardOf(role, n);
  }
  const contains = new Set(roles.contains);
  const kids: Record<string, string[]> = {};
  const parent: Record<string, string> = {};
  for (const e of edges) {
    const a = cards[e.source];
    const b = cards[e.target];
    // The first parent wins: a card is drawn once.
    if (!a || !b || !contains.has(e.edge_type) || !HOLDS[a.role].includes(b.role) || parent[b.id]) continue;
    parent[b.id] = a.id;
    (kids[a.id] ??= []).push(b.id);
  }
  const order = (x: string, y: string) => cards[x]!.seq - cards[y]!.seq || cards[x]!.title.localeCompare(cards[y]!.title);
  for (const id of Object.keys(kids)) kids[id]!.sort(order);
  const goals = Object.values(cards)
    .filter((c) => c.role === "goal")
    .sort((x, y) => Number(y.state === "prog") - Number(x.state === "prog") || (kids[y.id]?.length ?? 0) - (kids[x.id]?.length ?? 0) || y.at - x.at || x.title.localeCompare(y.title))
    .map((c) => c.id);
  return { cards, kids, parent, goals };
}

/** The goal a card belongs to (itself, for a goal); null for a card under no goal. */
export function goalOf(plan: Plan, id: string): string | null {
  let at: string | undefined = id;
  for (let i = 0; at && i < 8; i++) {
    if (plan.cards[at]?.role === "goal") return at;
    at = plan.parent[at];
  }
  return null;
}

/** How much of a card's children is done. */
export function progress(plan: Plan, id: string): { done: number; total: number } {
  const ks = plan.kids[id] ?? [];
  return { done: ks.filter((k) => plan.cards[k]?.state === "done").length, total: ks.length };
}

/** The goals a board opens on: the first few in progress (the fullest first, as `goals` is ordered),
 *  or the first few of all when none is. A handful, so the centre of the map can be read at a glance. */
export function openingGoals(plan: Plan, most = 5): string[] {
  const live = plan.goals.filter((g) => plan.cards[g]!.state === "prog");
  return (live.length ? live : plan.goals).slice(0, most);
}
