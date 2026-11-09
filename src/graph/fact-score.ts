/**
 * How far to trust a fact now, worked out on read from its evidence: never
 * stored, never written back, no sweep job. Time lowers trust; it never ends
 * a fact (plans/memory-truth-layer.md).
 *
 * One slot is a subject and an edge type: every edge of it, current and
 * ended. An edge's evidence is its claim's `Evidence` rows
 * (`ladybug/fact-claims.ts`): each mention, with who said it, when, and for
 * or against. An edge written before claims has none, and is read from its
 * `sources` and `last_confirmed_at` instead. For each edge:
 *
 *   - belief: who backed it, each distinct sayer once (the user, the subject
 *     about themself, someone else), so repeating a fact adds nothing;
 *   - currency: how long since it was last backed, against how fast the
 *     edge type changes (its `volatility`); a fresh mention restarts it;
 *   - refuted: the newest word on it is the user saying it is false;
 *   - rival: on a one-value slot, an ended edge replaced by someone believed
 *     less stays in the running;
 *   - a message read again: an edge whose only messages already backed an
 *     ended edge to the same value is not new evidence;
 *
 * Checks that look for the evidence a fact should keep producing come next
 * (plans/memory-checks.md); this rule reads what people said.
 *
 * From those, `status` (what the evidence says) and `stance` (what to do
 * with it): `state` it, `cite` its source, or `ask` before using it. Pure:
 * no graph access. `ladybug/reader.ts` gathers the slots.
 */

export const VOLATILITIES = ["static", "stable", "evolving", "volatile"] as const;
export type Volatility = (typeof VOLATILITIES)[number];
export const isVolatility = (v: unknown): v is Volatility => typeof v === "string" && (VOLATILITIES as readonly string[]).includes(v);

/** Days for an unbacked fact's currency to halve; `static` never does. A
 *  first guess per class, not fitted: an edge type without a volatility is
 *  `stable`. */
export const HALF_LIFE_DAYS: Readonly<Record<Volatility, number>> = { static: Infinity, stable: 3 * 365, evolving: 365, volatile: 60 };

export type SayerKind = "owner" | "self" | "other" | "check";
/** How far one sayer of each kind is believed. Fixed, not learned. A check
 *  (plans/memory-checks.md) is weaker than a person: what it finds only fits
 *  the fact, it does not state it. */
export const TRUST: Readonly<Record<SayerKind, number>> = { owner: 0.95, self: 0.9, other: 0.7, check: 0.6 };
/** How much each sayer after the first adds (under 1: sayers are not fully independent). */
const GAMMA = 0.5;
/** Days of no decay after a mention, and the floor currency stops at. */
const GRACE_DAYS = 14;
const FLOOR = 0.05;
/** The best value's share below which it is not clearly ahead. */
export const CLEAR_SHARE = 0.6;
/** Currency below which a fact is `stale`; below `ASK_BELOW`, probably out of date. */
export const STALE_BELOW = 0.6;
export const ASK_BELOW = 0.25;
const DAY = 86_400_000;

/** What the evidence says about a fact. */
export type FactStatus = "supported" | "disputed" | "stale" | "hearsay" | "unknown" | "refuted";
/** What an agent should do with it: say it, say it with its source, or check first. */
export type FactStance = "state" | "cite" | "ask";

/** One piece of a claim's evidence. */
export interface EvidenceIn {
  id: string;
  /** The Person who said it; none, the user. */
  said_by?: string;
  /** Epoch ms. */
  observed_at: number;
  /** Above 0 backs it, below 0 says it is false (from a check: the
   *  expected evidence is missing). */
  strength: number;
  /** The check step that observed it (`observed` evidence); absent for something someone said. */
  check?: string;
}

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
  /** Its claim's evidence; absent for an edge written before claims. */
  evidence?: EvidenceIn[];
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
  /** The Persons among the sources and evidence (ref_id → person). */
  people: ReadonlyMap<string, Person>;
  /** The user, when the graph has one: who said a fact no Person backs. */
  user?: { ref_id: string; name?: string };
  now: number;
}

export interface FactTrust {
  status: FactStatus;
  /** For a current fact; an ended one is history, told as such. */
  stance?: FactStance;
  evidence: {
    sayers: Sayer[];
    last_confirmed?: number;
    /** Each piece, newest first; absent for a fact written before claims. */
    items?: Array<{ sayer: Sayer; observed_at: number; strength: number }>;
  };
  /** 0–1: from who backed it. */
  belief: number;
  /** 0–1: from how long since it was last backed. */
  currency: number;
  /** On a one-value slot, the value it competes with, when that matters. */
  rival?: { ref_id: string; target_ref_id: string; belief: number };
  /** It begins later than now. */
  planned?: true;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const round = (x: number) => Math.round(x * 100) / 100;

const sayerOf = (ref_id: string | undefined, s: Pick<SlotInput, "subject" | "people" | "user">): Sayer => {
  const p = ref_id ? s.people.get(ref_id) : undefined;
  if (!ref_id || !p) return { ...(s.user ? { ref_id: s.user.ref_id, ...(s.user.name ? { name: s.user.name } : {}) } : {}), kind: "owner" };
  return { ref_id, ...(p.name ? { name: p.name } : {}), kind: p.owner ? "owner" : ref_id === s.subject ? "self" : "other" };
};

/** Who or what one piece of evidence came from: a person, or a check by its step. */
const sourceOf = (x: EvidenceIn, s: Pick<SlotInput, "subject" | "people" | "user">): Sayer =>
  x.check ? { name: x.check, kind: "check" } : sayerOf(x.said_by, s);

/** Who backed an edge: each source of its supporting evidence once, or each
 *  Person among its sources; none, the user. */
export function sayersOf(e: SlotEdge, s: Pick<SlotInput, "subject" | "people" | "user">): Sayer[] {
  const who = e.evidence
    ? e.evidence.filter((x) => x.strength > 0).map((x) => sourceOf(x, s))
    : e.sources.filter((x) => s.people.has(x)).map((x) => sayerOf(x, s));
  if (!who.length) return [sayerOf(undefined, s)];
  return [...new Map(who.map((w) => [`${w.kind}|${w.ref_id ?? w.name ?? ""}`, w])).values()];
}

const trustOf = (w: Sayer) => TRUST[w.kind];

/** Trusts combined: the most trusted, and each other one adding a little. */
function combineTrust(trusts: number[]): number {
  const [first, ...rest] = [...trusts].sort((a, b) => b - a);
  if (first === undefined) return 0;
  return sigmoid(logit(first) + GAMMA * rest.reduce((n, t) => n + logit(t), 0));
}

/** Distinct sayers of these kinds, combined. */
export function combine(kinds: SayerKind[]): number {
  return combineTrust(kinds.map((k) => TRUST[k]));
}

/** The latest backing: the newest supporting evidence, else its last
 *  confirmation, else when it was written; never before it began. */
function sinceOf(e: SlotEdge): number {
  const backed = e.evidence?.filter((x) => x.strength > 0).map((x) => x.observed_at);
  const last = backed?.length ? Math.max(...backed) : (e.last_confirmed_at ?? e.created_at ?? 0);
  return Math.max(last, e.valid_at ?? 0);
}

/** 0.5 per half-life since it was last backed, after a grace period, down to a floor. */
export function currencyOf(e: SlotEdge, volatility: Volatility | undefined, now: number): number {
  const hl = HALF_LIFE_DAYS[volatility ?? "stable"];
  if (!Number.isFinite(hl)) return 1;
  const days = Math.max(0, (now - sinceOf(e)) / DAY - GRACE_DAYS);
  return Math.max(FLOOR, 0.5 ** (days / hl));
}

/** The newest pieces (those at the latest time: evidence keeps whole seconds, so several can share it). */
function newestOf(xs: EvidenceIn[] | undefined): EvidenceIn[] {
  const at = Math.max(-Infinity, ...(xs ?? []).map((x) => x.observed_at));
  return (xs ?? []).filter((x) => x.observed_at === at);
}

/** The newest word on it is the user saying it is false; at the same time as support, the refutation wins. */
function refutedBy(e: SlotEdge, s: Pick<SlotInput, "subject" | "people" | "user">): boolean {
  return newestOf(e.evidence?.filter((x) => !x.check)).some((x) => x.strength < 0 && sayerOf(x.said_by, s).kind === "owner");
}

/** Its newest check found the expected evidence missing: weakly against it. */
const quietBy = (e: SlotEdge) => newestOf(e.evidence?.filter((x) => x.check)).some((x) => x.strength < 0);

/** The sources that are messages (not a Person, not a run). */
const messagesOf = (e: SlotEdge, people: ReadonlyMap<string, Person>) => e.sources.filter((x) => !people.has(x) && !x.startsWith("run:"));

/** Its only messages already backed an ended edge to the same value: read again, not new. */
function rereadOnly(e: SlotEdge, all: SlotEdge[], people: ReadonlyMap<string, Person>): boolean {
  const mine = messagesOf(e, people);
  if (!mine.length) return false;
  return all.some((f) => f.ref_id !== e.ref_id && f.target === e.target && f.expired_at !== null && (f.created_at ?? 0) <= (e.created_at ?? 0) && mine.every((m) => f.sources.includes(m)));
}


const STANCE: Readonly<Record<FactStatus, FactStance>> = { supported: "state", disputed: "cite", hearsay: "cite", stale: "cite", unknown: "ask", refuted: "ask" };

/** Every edge of the slot, scored (by ref_id). */
export function scoreSlot(s: SlotInput): Map<string, FactTrust> {
  const sayers = new Map(s.edges.map((e) => [e.ref_id, sayersOf(e, s)]));
  const refuted = new Map(s.edges.map((e) => [e.ref_id, refutedBy(e, s)]));
  const belief = new Map(
    s.edges.map((e) => [e.ref_id, refuted.get(e.ref_id) || rereadOnly(e, s.edges, s.people) ? 0 : combineTrust(sayers.get(e.ref_id)!.map(trustOf))]),
  );
  const currency = new Map(s.edges.map((e) => [e.ref_id, currencyOf(e, s.volatility, s.now)]));
  const score = (e: SlotEdge) => belief.get(e.ref_id)! * currency.get(e.ref_id)!;

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
    const cur = currency.get(e.ref_id)!;
    const rival = s.one ? ranked.find((x) => x.target !== e.target) : undefined;
    const behind = s.one && (!top || top.target !== e.target);
    const contested = s.one && !!rival && share < CLEAR_SHARE;
    const status: FactStatus = refuted.get(e.ref_id)
      ? "refuted"
      : score(e) === 0
        ? "unknown"
        : behind || contested
          ? "disputed"
          : cur < STALE_BELOW || quietBy(e)
            ? "stale"
            : who.every((x) => x.kind === "other")
              ? "hearsay"
              : (s.one ? share : score(e)) < CLEAR_SHARE
                ? "unknown"
                : "supported";
    const current = e.expired_at === null;
    const stance = !current ? undefined : status === "stale" && cur < ASK_BELOW ? "ask" : STANCE[status];
    const items = e.evidence
      ? [...e.evidence].sort((a, b) => b.observed_at - a.observed_at).map((x) => ({ sayer: sourceOf(x, s), observed_at: x.observed_at, strength: x.strength }))
      : undefined;
    out.set(e.ref_id, {
      status,
      ...(stance ? { stance } : {}),
      evidence: { sayers: who, last_confirmed: sinceOf(e) || undefined, ...(items ? { items } : {}) },
      belief: round(belief.get(e.ref_id)!),
      currency: round(cur),
      ...(rival && current && status === "disputed" ? { rival: { ref_id: rival.ref_id, target_ref_id: rival.target, belief: round(belief.get(rival.ref_id)!) } } : {}),
      ...(current && e.valid_at !== null && e.valid_at > s.now ? { planned: true as const } : {}),
    });
  }
  return out;
}
