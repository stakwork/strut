/**
 * How far to trust a fact now, worked out on read from what its edges
 * already hold: never stored, never written back,
 * no sweep job. Time lowers trust; it never ends a fact.
 *
 * One slot is a subject and an edge type: every edge of it, current and
 * ended. For each edge:
 *
 *   - belief: who said it, each distinct sayer once (the user, the subject
 *     about themself, someone else), so repeating a fact adds nothing;
 *   - currency: how long since it was last confirmed, against how fast the
 *     edge type changes (its `volatility`); a fresh mention restarts it;
 *   - rival: on a one-value slot, an ended edge replaced by someone believed
 *     less stays in the running;
 *   - a message read again: an edge whose only messages already backed an
 *     ended edge to the same value is not new evidence;
 *   - hedge: the best value is not clearly ahead, so the reader should say
 *     who said it and when, and check.
 *
 * And, when the edge type `depends_on` another (a gym on where someone
 * lives), a change there since the edge was last confirmed halves its score.
 * Pure: no graph access. `ladybug/reader.ts` gathers the slots.
 */

export const VOLATILITIES = ["static", "stable", "evolving", "volatile"] as const;
export type Volatility = (typeof VOLATILITIES)[number];
export const isVolatility = (v: unknown): v is Volatility => typeof v === "string" && (VOLATILITIES as readonly string[]).includes(v);

/** Days for an unconfirmed fact's currency to halve; `static` never does.
 *  A first guess per class, not fitted: an edge type without a volatility
 *  is `stable`. */
export const HALF_LIFE_DAYS: Readonly<Record<Volatility, number>> = { static: Infinity, stable: 3 * 365, evolving: 365, volatile: 60 };

export type SayerKind = "owner" | "self" | "other";
/** How far one sayer of each kind is believed. Fixed, not learned. */
export const TRUST: Readonly<Record<SayerKind, number>> = { owner: 0.95, self: 0.9, other: 0.7 };
/** How much each sayer after the first adds (under 1: sayers are not fully independent). */
const GAMMA = 0.5;
/** Days of no decay after a confirmation, and the floor currency stops at. */
const GRACE_DAYS = 14;
const FLOOR = 0.05;
/** Below this the best value is not clearly ahead: hedge. */
export const HEDGE_BELOW = 0.6;
/** What a change in a slot an edge type depends on leaves of its score. */
const PARENT_CHANGED = 0.5;
const DAY = 86_400_000;

/** An edge of a slot, as the graph holds it (epoch ms). */
export interface SlotEdge {
  ref_id: string;
  target: string;
  sources: string[];
  valid_at: number | null;
  expired_at: number | null;
  superseded_by: string | null;
  last_confirmed_at: number | null;
  created_at: number | null;
}

/** A Person among the graph's nodes: its name, and whether it is the user. */
export interface Person {
  name?: string;
  owner: boolean;
}

export interface Sayer {
  ref_id?: string;
  name?: string;
  kind: SayerKind;
}

export interface SlotInput {
  /** The slot's subject: a sayer who is the subject said it about themself. */
  subject: string;
  edges: SlotEdge[];
  /** `cardinality: one`: one value at a time, so values compete. */
  one: boolean;
  volatility?: Volatility;
  /** The slots of the edge types this one depends on, for the same subject. */
  parents?: SlotEdge[][];
  /** The Persons among the edges' sources (ref_id → person). */
  people: ReadonlyMap<string, Person>;
  /** The user, when the graph has one: who said a fact no Person is a source of. */
  user?: { ref_id: string; name?: string };
  now: number;
}

export interface FactTrust {
  evidence: { sayers: Sayer[]; last_confirmed?: number };
  /** 0–1: from who said it. */
  belief: number;
  /** 0–1: from how long since it was last confirmed. */
  currency: number;
  /** Say who said it and when, and check, rather than state it. */
  hedge: boolean;
  /** On a one-value slot, the value it competes with: another current one,
   *  or an ended one replaced by someone believed less. */
  rival?: { ref_id: string; target_ref_id: string; belief: number };
  /** It begins later than now. */
  planned?: true;
  /** Only someone other than the user and the subject said it. */
  hearsay?: true;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const round = (x: number) => Math.round(x * 100) / 100;

/** Who said an edge: each Person among its sources once; none, the user. */
export function sayersOf(e: SlotEdge, s: Pick<SlotInput, "subject" | "people" | "user">): Sayer[] {
  const seen = [...new Set(e.sources.filter((x) => s.people.has(x)))];
  if (!seen.length) return [{ ...(s.user ? { ref_id: s.user.ref_id, ...(s.user.name ? { name: s.user.name } : {}) } : {}), kind: "owner" }];
  return seen.map((ref_id) => {
    const p = s.people.get(ref_id)!;
    return { ref_id, ...(p.name ? { name: p.name } : {}), kind: p.owner ? "owner" : ref_id === s.subject ? "self" : "other" };
  });
}

/** Distinct sayers combined: the most trusted, and each other one adding a little. */
export function combine(kinds: SayerKind[]): number {
  const [first, ...rest] = kinds.map((k) => TRUST[k]).sort((a, b) => b - a);
  if (first === undefined) return 0;
  return sigmoid(logit(first) + GAMMA * rest.reduce((n, t) => n + logit(t), 0));
}

/** The latest evidence for an edge: its last confirmation, else when it began, else when it was written. */
const sinceOf = (e: SlotEdge) => Math.max(e.last_confirmed_at ?? e.created_at ?? 0, e.valid_at ?? 0);

/** 0.5 per half-life since it was last confirmed, after a grace period, down to a floor. */
export function currencyOf(e: SlotEdge, volatility: Volatility | undefined, now: number): number {
  const hl = HALF_LIFE_DAYS[volatility ?? "stable"];
  if (!Number.isFinite(hl)) return 1;
  const days = Math.max(0, (now - sinceOf(e)) / DAY - GRACE_DAYS);
  return Math.max(FLOOR, 0.5 ** (days / hl));
}

/** The sources that are messages (not a Person, not a run). */
const messagesOf = (e: SlotEdge, people: ReadonlyMap<string, Person>) => e.sources.filter((x) => !people.has(x) && !x.startsWith("run:"));

/** Its only messages already backed an ended edge to the same value: read again, not new. */
function rereadOnly(e: SlotEdge, all: SlotEdge[], people: ReadonlyMap<string, Person>): boolean {
  const mine = messagesOf(e, people);
  if (!mine.length) return false;
  return all.some((f) => f.ref_id !== e.ref_id && f.target === e.target && f.expired_at !== null && (f.created_at ?? 0) <= (e.created_at ?? 0) && mine.every((m) => f.sources.includes(m)));
}

/** A slot it depends on took a new value after the edge was last confirmed. */
function parentChanged(e: SlotEdge, parents: SlotEdge[][]): boolean {
  return parents.some((p) => p.some((x) => x.expired_at === null && (x.valid_at ?? x.created_at ?? 0) > sinceOf(e) && p.some((o) => o.superseded_by === x.ref_id)));
}

/** Every edge of the slot, scored (by ref_id). */
export function scoreSlot(s: SlotInput): Map<string, FactTrust> {
  const parents = s.parents ?? [];
  const sayers = new Map(s.edges.map((e) => [e.ref_id, sayersOf(e, s)]));
  const belief = new Map(s.edges.map((e) => [e.ref_id, rereadOnly(e, s.edges, s.people) ? 0 : combine(sayers.get(e.ref_id)!.map((x) => x.kind))]));
  const currency = new Map(s.edges.map((e) => [e.ref_id, currencyOf(e, s.volatility, s.now)]));
  const score = (e: SlotEdge) => belief.get(e.ref_id)! * currency.get(e.ref_id)! * (parentChanged(e, parents) ? PARENT_CHANGED : 1);

  // The values in the running on a one-value slot: the current edges, and an
  // ended one whose replacer was believed less. Each value by its best edge.
  const byId = new Map(s.edges.map((e) => [e.ref_id, e]));
  const running = s.edges.filter((e) => {
    if (e.expired_at === null) return true;
    const by = e.superseded_by ? byId.get(e.superseded_by) : undefined;
    return !!by && belief.get(e.ref_id)! > belief.get(by.ref_id)!;
  });
  const best = new Map<string, SlotEdge>();
  for (const e of running) {
    const had = best.get(e.target);
    if (!had || score(e) > score(had)) best.set(e.target, e);
  }
  const ranked = [...best.values()].filter((e) => score(e) > 0).sort((a, b) => score(b) - score(a));
  const total = ranked.reduce((n, e) => n + score(e), 0);
  const top = ranked[0];
  // The best value's share, with what nothing says left as doubt.
  const share = top ? score(top) / (total + (1 - score(top))) : 0;

  const out = new Map<string, FactTrust>();
  for (const e of s.edges) {
    const who = sayers.get(e.ref_id)!;
    const current = e.expired_at === null;
    const mine = score(e);
    let hedge = false;
    let rival: SlotEdge | undefined;
    if (current) {
      if (s.one) {
        rival = ranked.find((x) => x.target !== e.target);
        hedge = !top || top.target !== e.target || share < HEDGE_BELOW;
      } else hedge = mine < HEDGE_BELOW;
    }
    const last = e.last_confirmed_at ?? e.created_at ?? undefined;
    out.set(e.ref_id, {
      evidence: { sayers: who, ...(last !== undefined ? { last_confirmed: last } : {}) },
      belief: round(belief.get(e.ref_id)!),
      currency: round(currency.get(e.ref_id)!),
      hedge,
      ...(rival && hedge ? { rival: { ref_id: rival.ref_id, target_ref_id: rival.target, belief: round(belief.get(rival.ref_id)!) } } : {}),
      ...(current && e.valid_at !== null && e.valid_at > s.now ? { planned: true as const } : {}),
      ...(who.every((x) => x.kind === "other") ? { hearsay: true as const } : {}),
    });
  }
  return out;
}
