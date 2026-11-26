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

/** Text a person wrote once for several languages: a plain string, or a map
 *  of language → text (`{ en: "Scan book", es: "Escanear libro" }`). */
export type LocalText = string | Partial<Record<string, string>>;

const ES_HINTS = /[áéíóúñ¿¡]|\b(?:de|del|la|el|los|las|una|un|para|con|por|y|foto|fotos|siguiente|página|libro|portada|pendiente|revisión|escanear|enviar|listo)\b/giu;
const EN_HINTS = /\b(?:the|of|to|and|for|with|page|next|photo|scan|book|cover|pending|review|send|done)\b/giu;
const hits = (re: RegExp, t: string) => (t.match(re) ?? []).length;
/** How Spanish (+) or English (-) a text reads, by accents and common words. */
const esLean = (t: string) => hits(ES_HINTS, t) - hits(EN_HINTS, t);

/** The legacy bilingual pattern `English / Español` (either order): exactly
 *  one " / ", both halves words, and one clearly reads Spanish and the other
 *  not. Anything else (a path, "A / B" with no tell-tale words) is not it. */
function splitBilingual(text: string): { en: string; es: string } | undefined {
  const parts = text.split(" / ");
  if (parts.length !== 2) return undefined;
  const [a, b] = [parts[0]!.trim(), parts[1]!.trim()];
  if (!a || !b || !/\p{L}{2}/u.test(a) || !/\p{L}{2}/u.test(b)) return undefined;
  const [la, lb] = [esLean(a), esLean(b)];
  if (la === lb || (la > 0 && lb > 0) || (la <= 0 && lb <= 0)) return undefined;
  return la > lb ? { en: b, es: a } : { en: a, es: b };
}

/** A `LocalText` in a locale's language: a map's entry for it, else its
 *  English one, else its first non-empty one; a plain string as it is — except
 *  the legacy `English / Español` pair, whose half for the language is taken
 *  (the first is English, the second Spanish). Undefined for none. */
export function localText(text: LocalText | null | undefined, locale?: string | null): string | undefined {
  if (text === null || text === undefined) return undefined;
  const lang = langOf(locale);
  if (typeof text === "string") {
    const t = text.trim();
    if (!t) return undefined;
    const pair = splitBilingual(t);
    return pair ? pair[lang] ?? pair.en : t;
  }
  const pick = (v: string | undefined) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return pick(text[lang]) ?? pick(text["en"]) ?? Object.values(text).map(pick).find((v) => v !== undefined);
}

/** Numbers, sats and times as one locale writes them. */
export interface Formats {
  locale: string;
  /** A whole number grouped as the locale groups it: `1,234` (en, es-MX), `12.345` (es). */
  number(n: number): string;
  /** msat as whole sats: `1,234 sats`, `1 sat` (the rest of a sat dropped). */
  sats(msat: number): string;
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
