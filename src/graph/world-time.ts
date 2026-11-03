/**
 * Dates and words as `assert` and the memory steps read them, with no
 * imports, so a step can take them without loading a graph engine.
 */

/** An ISO date as epoch ms; a bare year or year-month means its first day, a time with no offset is UTC.
 *  Undefined when it is not a date, or not one on the calendar. */
export function worldTime(given: string): number | undefined {
  const s = given.trim();
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(s);
  const date = m ? `${m[1]}-${m[2] ?? "01"}-01` : s.length > 10 && !/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(s) ? `${s}Z` : s;
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return undefined;
  // Date.parse rolls 2026-02-30 over to March: the calendar date, read on its
  // own, must come back as given. An offset may move the instant to another day.
  const day = date.slice(0, 10);
  const check = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(check) || new Date(check).toISOString().slice(0, 10) !== day) return undefined;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Folded for matching: accents off, lowercase, one space. */
export function foldText(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
