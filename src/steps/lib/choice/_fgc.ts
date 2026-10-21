/**
 * Fast / Good / Cheap scoring for brainstorm Options — the PURE half (no graph,
 * no services), shared by the choice/* steps and their tests.
 *
 * Model (mirrors jarvis-backend ontology migration 133):
 *   Option -[RATED_ON {score -1..1}]-> Fast|Good|Cheap   (absolute scores)
 *   HiveInitiative|HiveMilestone|InitiativeFeature -[PRIORITISES {weight 0..1}]-> corner
 *   the NEAREST PRIORITISES wins per corner: feature > milestone > initiative;
 *   no PRIORITISES on the path → weight 0. `good_min` (-1..1, optional) rides on
 *   the PRIORITISES edge to Good; default -0.5.
 *   total = Σ weight × score; an option whose Good score < good_min is excluded
 *   (still listed, flagged). "Only two of three corners > 0.5" is a documented
 *   check surfaced as a warning, NEVER enforced.
 */

export const CORNERS = ["fast", "good", "cheap"] as const;
export type Corner = (typeof CORNERS)[number];
export const SCOPES = ["feature", "milestone", "initiative"] as const; // nearest first
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_GOOD_MIN = -0.5;
export const WARN_ALL_THREE_HIGH = "all_three_above_0.5";

/** Corner node type + the singleton identity (`fast_id: "fast"`, …). */
export const CORNER_NODE: Record<Corner, { type: string; idProp: string; id: string; key: string }> = {
  fast: { type: "Fast", idProp: "fast_id", id: "fast", key: "fast-fast" },
  good: { type: "Good", idProp: "good_id", id: "good", key: "good-good" },
  cheap: { type: "Cheap", idProp: "cheap_id", id: "cheap", key: "cheap-cheap" },
};

export type Weights = Partial<Record<Corner, number>>;
export interface Preset {
  label: string;
  weights: Record<Corner, number>;
  good_min?: number;
}
/** Illustrative stage presets. NEVER applied by default — a caller names one. */
export const PRESETS: Record<string, Preset> = {
  stage1: { label: "prove it", weights: { fast: 1.0, cheap: 1.0, good: 0.3 }, good_min: -0.5 },
  stage2: { label: "reliable", weights: { good: 1.0, fast: 0.6, cheap: 0.4 } },
  stage3: { label: "scale", weights: { good: 1.0, cheap: 0.8, fast: 0.3 } },
};

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** `score` is optional (absent is fine — v1 has no enforcement); present, it is -1..1. */
export function checkScore(v: unknown, what = "score"): string | null {
  if (v === undefined || v === null) return null;
  return inRange(v, -1, 1) ? null : `${what} must be a number in -1..1 (got ${JSON.stringify(v)})`;
}

/** `rated_on` {fast, good, cheap}: each optional, each -1..1, no other keys. */
export function checkRatedOn(r: unknown): string | null {
  if (r === undefined || r === null) return null;
  if (typeof r !== "object" || Array.isArray(r)) return "rated_on must be an object { fast?, good?, cheap? }";
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (!(CORNERS as readonly string[]).includes(k)) return `rated_on has unknown corner "${k}" (use fast, good, cheap)`;
    const e = checkScore(v, `rated_on.${k}`);
    if (e) return e;
  }
  return null;
}

export function checkWeight(v: unknown, what = "weight"): string | null {
  return inRange(v, 0, 1) ? null : `${what} must be a number in 0..1 (got ${JSON.stringify(v)})`;
}
export function checkGoodMin(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return inRange(v, -1, 1) ? null : `good_min must be a number in -1..1 (got ${JSON.stringify(v)})`;
}

/** A scope's priorities: corner → a bare weight, or { weight, good_min? }. */
export type ScopePriorities = Partial<Record<Corner, number | { weight?: number; good_min?: number }>>;
export type Priorities = Partial<Record<Scope, ScopePriorities | null>>;

function edgeOf(p: ScopePriorities | null | undefined, c: Corner): { weight: number; good_min?: number } | null {
  const e = p?.[c];
  if (e === undefined || e === null) return null;
  if (typeof e === "number") return Number.isFinite(e) ? { weight: e } : null;
  return typeof e.weight === "number" && Number.isFinite(e.weight) ? { weight: e.weight, good_min: e.good_min } : null;
}

/** Nearest PRIORITISES wins, per corner. Missing → 0. `good_min` comes from the
 *  nearest PRIORITISES edge to Good that carries one, else `fallbackGoodMin`,
 *  else -0.5. `hasPriorities` is false when no scope names any corner. */
export function resolvePriorities(priorities: Priorities | undefined, fallbackGoodMin?: number) {
  const weights: Record<Corner, number> = { fast: 0, good: 0, cheap: 0 };
  const source: Record<Corner, Scope | null> = { fast: null, good: null, cheap: null };
  let good_min: number | undefined;
  for (const c of CORNERS) {
    for (const s of SCOPES) {
      const e = edgeOf(priorities?.[s], c);
      if (!e) continue;
      weights[c] = e.weight;
      source[c] = s;
      if (c === "good" && typeof e.good_min === "number") good_min = e.good_min;
      break;
    }
  }
  return {
    weights,
    source,
    good_min: good_min ?? fallbackGoodMin ?? DEFAULT_GOOD_MIN,
    hasPriorities: CORNERS.some((c) => source[c] !== null),
  };
}

export interface RecOption {
  id: string;
  rated?: Partial<Record<Corner, number | null>>;
}
export interface RankedOption {
  id: string;
  total: number;
  contributions: Record<Corner, number>;
  excluded: boolean;
  warnings: string[];
}
export interface Recommendation {
  weights: Record<Corner, number>;
  good_min: number;
  ranked: RankedOption[];
  recommended: string | null;
  warnings: string[];
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** Rank options. Included options first by total (stable on ties), then the
 *  excluded ones (Good score < good_min) by total, each flagged. A missing score
 *  contributes 0; a missing Good score is never excluded. */
export function recommend(input: { options: RecOption[]; priorities?: Priorities; good_min?: number }): Recommendation {
  const r = resolvePriorities(input.priorities, input.good_min);
  const rows: RankedOption[] = input.options.map((o) => {
    const contributions = {} as Record<Corner, number>;
    let total = 0;
    for (const c of CORNERS) {
      const s = o.rated?.[c];
      contributions[c] = round(r.weights[c] * (typeof s === "number" ? s : 0));
      total += contributions[c];
    }
    const good = o.rated?.good;
    const warnings = CORNERS.every((c) => (o.rated?.[c] ?? -Infinity) > 0.5) ? [WARN_ALL_THREE_HIGH] : [];
    return { id: o.id, total: round(total), contributions, excluded: typeof good === "number" && good < r.good_min, warnings };
  });
  const byTotal = (a: RankedOption, b: RankedOption) => b.total - a.total;
  const included = rows.filter((x) => !x.excluded).sort(byTotal);
  const excluded = rows.filter((x) => x.excluded).sort(byTotal);
  return {
    weights: r.weights,
    good_min: r.good_min,
    ranked: [...included, ...excluded],
    recommended: included[0]?.id ?? null,
    warnings: rows.some((x) => x.warnings.length) ? [WARN_ALL_THREE_HIGH] : [],
  };
}

/** Effect `against`: ids of Requirements, deduped; blanks dropped. */
export function normalizeAgainst(v: unknown): { ids: string[]; error?: string } {
  if (v === undefined || v === null) return { ids: [] };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { ids: [], error: "against must be a list of Requirement ids" };
  return { ids: [...new Set(v.map((x) => x.trim()).filter(Boolean))] };
}
