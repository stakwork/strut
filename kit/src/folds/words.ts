/** WORDS (plans/i18n.md): the languages strut's own worker-facing screens
 *  speak, and numbers, sats and times as a locale writes them. A screen's
 *  words are an object per language — `{ en, es }`, the English one the type
 *  every other must match, so a missing or misshaped message fails tsc — whose
 *  messages are strings or functions (a function owns its word order and its
 *  plurals). `useWords(words)` picks the page's (`@strut/kit`), a host's own
 *  page `words[langOf(locale)]`. Pure: `Intl` alone. */

/** The languages strut writes its worker-facing screens in. */
export const LANGS = ["en", "es"] as const;
export type Lang = (typeof LANGS)[number];

/** A screen's words: English always, the other languages it has. */
export type Words<W> = { en: W } & Partial<Record<Lang, W>>;

/** The language of a locale (BCP 47) when strut speaks it, else English:
 *  `es-MX` → `es`, `pt-BR` → `en`. */
export function langOf(locale?: string | null): Lang {
  const lang = (locale ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return (LANGS as readonly string[]).includes(lang) ? (lang as Lang) : "en";
}

/** A screen's words in a locale's language, English when it has none there. */
export function wordsFor<W>(words: Words<W>, locale?: string | null): W {
  return words[langOf(locale)] ?? words.en;
}

/** Numbers, sats and times as one locale writes them. */
export interface Formats {
  locale: string;
  /** A whole number grouped as the locale groups it: `1,234` (en, es-MX), `12.345` (es). */
  number(n: number): string;
  /** msat as whole sats: `1,234 sats`, `1 sat` (the rest of a sat dropped). */
  sats(msat: number): string;
  /** An amount as currency in the locale's style: `$12.50`. `currency` is an
   *  ISO 4217 code, USD by default (and for a code `Intl` refuses). */
  fiat(amount: number, currency?: string): string;
  /** How long ago: `now`, `5 min. ago` / `hace 5 min`, `3 hr. ago`, or the day. */
  ago(ms: number, now?: number): string;
  /** How long until: `in 5 min.` / `dentro de 5 min`, `in 3 hr.`, or the day. */
  until(ms: number, now?: number): string;
  /** A day, short: `Nov 20` / `20 nov`. */
  day(ms: number): string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A locale's formats; an unknown or empty tag writes as English. */
export function formats(locale?: string | null): Formats {
  const tag = supported(locale);
  const num = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const rel = new Intl.RelativeTimeFormat(tag, { numeric: "auto", style: "short" });
  const day = (ms: number) => new Date(ms).toLocaleDateString(tag, { month: "short", day: "numeric" });
  return {
    locale: tag,
    number: (n) => num.format(n),
    sats: (msat) => {
      const n = Math.floor(msat / 1000);
      return `${num.format(n)} ${n === 1 ? "sat" : "sats"}`;
    },
    fiat: (amount, currency) => {
      const code = currency?.trim().toUpperCase() || "USD";
      try {
        return amount.toLocaleString(tag, { style: "currency", currency: code });
      } catch {
        return amount.toLocaleString(tag, { style: "currency", currency: "USD" });
      }
    },
    ago: (ms, now = Date.now()) => {
      const d = Math.max(0, now - ms);
      if (d < MINUTE) return rel.format(0, "second");
      if (d < HOUR) return rel.format(-Math.floor(d / MINUTE), "minute");
      if (d < DAY) return rel.format(-Math.floor(d / HOUR), "hour");
      return day(ms);
    },
    until: (ms, now = Date.now()) => {
      const d = ms - now;
      if (d < HOUR) return rel.format(Math.max(1, Math.ceil(d / MINUTE)), "minute");
      if (d < DAY) return rel.format(Math.ceil(d / HOUR), "hour");
      return day(ms);
    },
    day,
  };
}

/** The tag as `Intl` takes it, or English for one it refuses. */
function supported(locale?: string | null): string {
  const tag = (locale ?? "").trim().replace(/_/g, "-");
  if (!tag) return "en-US";
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}
