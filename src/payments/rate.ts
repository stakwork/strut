/**
 * The EXCHANGE RATE (plans/paid-runs.md decision 26, §9): what a dollar of
 * credit costs in sats at the moment a buyer is quoted. Real-time and
 * pluggable; mempool.space by default.
 *
 * - The SOURCE answers `{ usdPerBtc, at, source }`. The default reads
 *   `https://mempool.space/api/v1/prices` (`{ time, USD, EUR, … }`, whole
 *   dollars per bitcoin) through strut's own http capability.
 *   `STRUT_RATE_URL` points at any endpoint of that shape (a self-hosted
 *   mempool); `createStrut({ payments: { rate } })` takes a host's function.
 * - `createRate(source)` reads it on demand and keeps a reading for a
 *   minute, so a burst of challenges is one request; concurrent reads
 *   share one request.
 * - NO STALE SALES. With the source down, the last reading serves while it
 *   is under ten minutes old (counted from when strut read it); after that
 *   a read throws `RateUnavailableError` (`rate_unavailable: …`). There is
 *   no fixed fallback. A rate is needed only to sell credit: a caller that
 *   gets the error refuses a priced challenge (503) and nothing else.
 */

import type { HttpCapability } from "../capabilities.js";

/** One reading. `at` is ISO 8601: the source's own time for the figure. */
export interface ExchangeRate {
  usdPerBtc: number;
  at: string;
  /** Where it came from: a host name (`mempool.space`) or a host's label. */
  source: string;
}

/** A source of readings: anything that answers one, or throws. */
export type RateSource = () => Promise<ExchangeRate>;

export const DEFAULT_RATE_URL = "https://mempool.space/api/v1/prices";
/** A reading this young is served without asking the source again. */
export const RATE_FRESH_MS = 60_000;
/** With the source down, a reading this young still serves; older, none does. */
export const RATE_STALE_MS = 10 * 60_000;
/** How long one read of the source may take. */
export const RATE_TIMEOUT_MS = 5_000;

export class RateUnavailableError extends Error {
  readonly code = "rate_unavailable";
  constructor(message: string) {
    super(`rate_unavailable: ${message}`);
    this.name = "RateUnavailableError";
  }
}

export const isRateUnavailable = (err: unknown): err is RateUnavailableError => err instanceof RateUnavailableError;

/** A reading that can price anything: a finite figure above zero and a time. */
export function checkReading(r: unknown, from: string): ExchangeRate {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const usdPerBtc = o["usdPerBtc"];
  if (typeof usdPerBtc !== "number" || !Number.isFinite(usdPerBtc) || usdPerBtc <= 0) {
    throw new Error(`${from} answered no dollars per bitcoin`);
  }
  const at = typeof o["at"] === "string" && !Number.isNaN(Date.parse(o["at"])) ? new Date(o["at"]).toISOString() : null;
  if (!at) throw new Error(`${from} answered no time for its rate`);
  const source = typeof o["source"] === "string" && o["source"].trim() ? o["source"].trim() : from;
  return { usdPerBtc, at, source };
}

/** The source at `url`, read through `http`: an endpoint of mempool's shape,
 *  `{ time: <unix seconds>, USD: <dollars per BTC>, … }`. `source` is the
 *  URL's host. */
export function urlRateSource(url: string, http: HttpCapability, opts: { timeoutMs?: number } = {}): RateSource {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`STRUT_RATE_URL is not a URL: ${JSON.stringify(url.slice(0, 100))}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("STRUT_RATE_URL must be http(s)");
  const host = u.host;
  return async () => {
    const res = await http(u.toString(), { headers: { accept: "application/json" }, timeout: opts.timeoutMs ?? RATE_TIMEOUT_MS });
    if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}`);
    const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
    const time = b["time"];
    if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) throw new Error(`${host} answered no time`);
    return checkReading({ usdPerBtc: b["USD"], at: new Date(time * 1000).toISOString(), source: host }, host);
  };
}

export interface Rate {
  /** The rate now: a reading under a minute old, else a new one, else (the
   *  source down) the last under ten minutes old, else `RateUnavailableError`. */
  read(): Promise<ExchangeRate>;
  /** The last good reading and when strut read it (epoch ms), or null. */
  last(): { rate: ExchangeRate; readAt: number } | null;
}

export function createRate(source: RateSource, opts: { now?: () => number; freshMs?: number; staleMs?: number } = {}): Rate {
  const now = opts.now ?? Date.now;
  const freshMs = opts.freshMs ?? RATE_FRESH_MS;
  const staleMs = opts.staleMs ?? RATE_STALE_MS;
  let last: { rate: ExchangeRate; readAt: number } | null = null;
  let inFlight: Promise<ExchangeRate> | null = null;
  let warned = false;

  const fetchOne = async (): Promise<ExchangeRate> => {
    try {
      const rate = checkReading(await source(), "the rate source");
      last = { rate, readAt: now() };
      warned = false;
      return rate;
    } catch (err) {
      const why = err instanceof Error ? (err.name === "TimeoutError" ? "no answer in time" : err.message) : String(err);
      if (last && now() - last.readAt < staleMs) {
        if (!warned) {
          warned = true;
          console.warn(`[payments] the exchange rate source failed (${why}); serving the reading from ${Math.round((now() - last.readAt) / 1000)} s ago`);
        }
        return last.rate;
      }
      throw new RateUnavailableError(
        last
          ? `the exchange rate source failed (${why}) and the last reading is over ${Math.round(staleMs / 60_000)} minutes old`
          : `the exchange rate source failed (${why}) and there is no reading yet`,
      );
    }
  };

  return {
    read() {
      if (last && now() - last.readAt < freshMs) return Promise.resolve(last.rate);
      inFlight ??= fetchOne().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    last: () => (last ? { rate: { ...last.rate }, readAt: last.readAt } : null),
  };
}

const SATS_PER_BTC = 100_000_000;

/** Whole sats that buy at least `usd` at `rate` (rounded up: a quote never
 *  sells a dollar for less than a dollar). */
export function satsForUsd(usd: number, rate: Pick<ExchangeRate, "usdPerBtc">): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("usd must be a number of dollars, 0 or more");
  // Rounded to a millionth of a sat first, so float noise in an exact
  // quote ($1 at $100 000 = 1000 sats) never adds a sat.
  return Math.ceil(Math.round((usd / rate.usdPerBtc) * SATS_PER_BTC * 1e6) / 1e6);
}

/** What `msat` is worth in dollars at `rate`. */
export function usdForMsat(msat: number, rate: Pick<ExchangeRate, "usdPerBtc">): number {
  return (msat / 1000 / SATS_PER_BTC) * rate.usdPerBtc;
}

/** The source this server reads: a host's function, else `STRUT_RATE_URL`,
 *  else mempool.space. */
export function rateSourceFor(opts: { source?: RateSource; url?: string; http: HttpCapability }): RateSource {
  if (opts.source) return opts.source;
  return urlRateSource(opts.url?.trim() || DEFAULT_RATE_URL, opts.http);
}
