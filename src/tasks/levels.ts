/**
 * A worker's level (plans/worker-progress.md): XP is their lifetime earnings
 * here in sats (the ledger's `payeeEarned`), and a level is a threshold on it.
 * The first levels come quickly — 1k, 2.5k, 5k sats — then a ladder of round
 * numbers from 10k at Level 4: 12k, 15k, 20k, 25k, 30k, 40k, 50k, 60k, 80k,
 * and ten times as much every ten levels (100k at 14, 1M at 24, 1 BTC at 44).
 * The last level is every bitcoin there will ever be (21 million), out of
 * reach on purpose. Below 1k sats a worker is Level 0. Shown, never used to
 * grant work: who may take which task type stays the grants, tests and
 * standing.
 */

/** The first levels, sats: quick wins before the ladder. */
const FIRST = [1_000, 2_500, 5_000] as const;
/** Where the ladder starts, sats. */
const LADDER_SATS = 10_000;
/** The steps within each ten levels of the ladder, as multiples of where the ten start. */
const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8] as const;
/** Where the last level starts: 21,000,000 BTC in sats. */
export const TOP_SATS = 21_000_000 * 100_000_000;

/** Where each level starts, sats, index = level: 0 for Level 0, the first
 *  levels, the ladder while it stays under TOP_SATS, then TOP_SATS itself as
 *  the last level. */
export const LEVEL_SATS: readonly number[] = Object.freeze(levels());
/** The last level. */
export const TOP_LEVEL = LEVEL_SATS.length - 1;

function levels(): number[] {
  const out: number[] = [0, ...FIRST];
  for (let i = 0; ; i++) {
    const sats = Math.round(LADDER_SATS * STEPS[i % STEPS.length]! * 10 ** Math.floor(i / STEPS.length));
    if (sats >= TOP_SATS) break;
    out.push(sats);
  }
  out.push(TOP_SATS);
  return out;
}

export interface Level {
  level: number;
  /** Where this level starts, sats. */
  fromSats: number;
  /** Where the next starts, sats; absent at the top. */
  toSats?: number;
}

/** The level `sats` of lifetime earnings reach. */
export function levelOf(sats: number): Level {
  const s = Number.isFinite(sats) ? Math.max(0, sats) : 0;
  let level = 0;
  while (level < TOP_LEVEL && LEVEL_SATS[level + 1]! <= s) level++;
  return { level, fromSats: LEVEL_SATS[level]!, ...(level < TOP_LEVEL ? { toSats: LEVEL_SATS[level + 1]! } : {}) };
}
