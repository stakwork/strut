import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { HttpCapability, StrutCapabilities } from "../../../capabilities.js";
import { CurrencyMissingError, RATE_FRESH_MS, coinbaseRateSource, createRate, urlRateSource, type Rate, type RateSource } from "../../../payments/rate.js";

/**
 * The live BTC price in a fiat currency, for a page or a workflow: reads
 * mempool.space, falls back to Coinbase, keeps a reading a minute per
 * currency (concurrent reads share one request). Over `ctx.services.http`,
 * which a signed-in visitor's call carries too (VISITOR_SERVICES). The
 * caches live on the http capability they read through (a WeakMap), so two
 * servers or tests never share one.
 */

export const BTC_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"] as const;
const SATS_PER_BTC = 1e8;

export interface BtcPrice {
  currency: string;
  perBtc: number;
  at: string;
  source: string;
  cached: boolean;
}

export interface BtcPriceReader {
  read(currency: string): Promise<BtcPrice>;
}

/** A reader over `http`. `now` is for tests. */
export function createBtcPrice(http: HttpCapability, opts: { now?: () => number } = {}): BtcPriceReader {
  const now = opts.now ?? Date.now;
  const rates = new Map<string, { rate: Rate; missing: boolean }>();
  const rateOf = (cur: string) => {
    let e = rates.get(cur);
    if (!e) {
      const entry = { rate: undefined as unknown as Rate, missing: false };
      const sources: RateSource[] = [urlRateSource("https://mempool.space/api/v1/prices", http, { currency: cur }), coinbaseRateSource(http, cur, { now })];
      const source: RateSource = async () => {
        const errs: unknown[] = [];
        for (const s of sources) {
          try {
            return await s();
          } catch (err) {
            errs.push(err);
          }
        }
        entry.missing = errs.every((e) => e instanceof CurrencyMissingError);
        throw new Error(errs.map((e) => (e instanceof Error ? e.message : String(e))).join("; "));
      };
      // staleMs 0: a failing source throws; a minute-old figure is never passed off as live.
      entry.rate = createRate(source, { now, freshMs: RATE_FRESH_MS, staleMs: 0 });
      rates.set(cur, (e = entry));
    }
    return e;
  };
  return {
    async read(currency) {
      const cur = currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) throw new Error(`btc/price: "${currency}" is not a currency code; supported: ${BTC_CURRENCIES.join(", ")}`);
      const e = rateOf(cur);
      const before = e.rate.last()?.readAt;
      try {
        const r = await e.rate.read();
        return { currency: cur, perBtc: r.usdPerBtc, at: r.at, source: r.source, cached: before !== undefined && before === e.rate.last()?.readAt };
      } catch (err) {
        if (e.missing) throw new Error(`btc/price: no source quotes ${cur}; supported: ${BTC_CURRENCIES.join(", ")}`);
        throw new Error(`btc/price: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

const readers = new WeakMap<HttpCapability, BtcPriceReader>();
/** The reader for `http`, made on first use. A test seeds one with its clock. */
export function btcPriceFor(http: HttpCapability, reader?: BtcPriceReader): BtcPriceReader {
  if (reader) readers.set(http, reader);
  let r = readers.get(http);
  if (!r) readers.set(http, (r = createBtcPrice(http)));
  return r;
}

export default defineStep({
  type: "btc/price",
  effect: "read",
  description:
    "The live price of bitcoin in a fiat currency: { currency, perBtc (fiat per 1 BTC), at (ISO time of the figure), source (host), cached, fiat? }. " +
    `currency is case-insensitive (default USD; ${BTC_CURRENCIES.join(" ")} and any other the sources quote); an unknown one is an error naming the supported list. ` +
    "With `sats`, `fiat` is what that many sats are worth. Read from mempool.space, falling back to Coinbase when it fails; a figure is kept 60 s per currency (cached: true). " +
    "A signed-in visitor's page may call it when its app grants it.",
  input: z.object({
    currency: z.string().default("USD").describe("ISO code, case-insensitive"),
    sats: z.number().min(0).optional().describe("an amount in sats to value in `currency`"),
  }),
  output: z.object({
    currency: z.string(),
    perBtc: z.number(),
    at: z.string(),
    source: z.string(),
    cached: z.boolean(),
    fiat: z.number().optional(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const http = ctx?.services?.http;
    if (!http) throw new Error("btc/price requires the http capability (ctx.services.http)");
    const p = await btcPriceFor(http).read(cfg.currency);
    return { ...p, ...(cfg.sats !== undefined ? { fiat: (cfg.sats / SATS_PER_BTC) * p.perBtc } : {}) };
  },
});
