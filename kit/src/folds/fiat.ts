import type { Formats } from "./words.js";

/** The exchange rate `task/me` answers: units of each currency per bitcoin by ISO 4217 code. */
export interface FiatRate {
  perBtc: Record<string, number>;
}

/** What `msat` is worth in `currency` at a `task/me` rate, or undefined
 *  when the rate has no figure for it. */
export function fiatOfMsat(msat: number, rate: FiatRate | undefined, currency = "USD"): number | undefined {
  const perBtc = rate?.perBtc[currency.toUpperCase()];
  return perBtc ? (msat / 1000 / 100_000_000) * perBtc : undefined;
}

/** An amount as currency in a locale's style: `$12.50`. `currency` is an
 *  ISO 4217 code, USD by default (and for a code `Intl` refuses). */
export function fiatText(amount: number, currency?: string, locale?: string): string {
  const style = (code: string) => amount.toLocaleString(locale, { style: "currency", currency: code });
  try {
    return style(currency?.trim().toUpperCase() || "USD");
  } catch {
    return style("USD");
  }
}

/** msat as sats with its fiat beside it: `50 sats (≈ $0.03)`; the sats alone
 *  when the rate has no figure for `currency`. */
export function satsWithFiat(msat: number, rate: FiatRate | undefined, f: Formats, currency?: string): string {
  const value = fiatOfMsat(msat, rate, currency);
  return value === undefined ? f.sats(msat) : `${f.sats(msat)} (≈ ${fiatText(value, currency, f.locale)})`;
}
