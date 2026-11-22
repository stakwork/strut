/** Sats <-> fiat helpers (node and browser). `perBtc` is fiat per 1 BTC. */
export const FIAT_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

const SATS_PER_BTC = 1e8;

export const satsToFiat = (sats: number, perBtc: number): number => (sats / SATS_PER_BTC) * perBtc;
export const fiatToSats = (amount: number, perBtc: number): number => (amount / perBtc) * SATS_PER_BTC;

/** "$12.34", "¥1,235", "€0.12"; a positive amount under the smallest unit shows "<$0.01". */
export function formatFiat(amount: number, currency: string, locale?: string): string {
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const min = 10 ** -digits;
  if (amount > 0 && amount < min / 2) return `<${fmt.format(min)}`;
  return fmt.format(amount);
}
