// The Automations editor's form state ⇄ the trigger draft it sends.
//
// The form is a FLAT bag of fields (every repeat type's controls keep their
// value while another type is showing, so switching back loses nothing); the
// trigger is the closed grammar in src/automations.ts. These two pure
// functions are the only place that mapping lives. No calendar math here —
// the server owns that (`POST /automations/preview`).

import type { Day, MonthDay, Trigger, TriggerDraft } from "./api";

export const DAYS: readonly Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABEL: Record<Day, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const WEEKDAYS: readonly Day[] = ["mon", "tue", "wed", "thu", "fri"];

export type Repeat = TriggerDraft["every"];

export interface TriggerForm {
  repeat: Repeat;
  tz: string;
  /** day / week / month: times of day, "HH:MM". */
  at: string[];
  /** week: which days. */
  weekDays: Day[];
  /** month: which kind of day, and its value. */
  monthMode: "day" | "last" | "weekday";
  monthDay: number;
  nth: 1 | 2 | 3 | 4 | "last";
  weekday: Day;
  /** interval: the gap, in the unit the person picked. */
  gap: number;
  gapUnit: "minutes" | "hours";
  /** interval: optional day + time-of-day filters. */
  limitDays: boolean;
  intervalDays: Day[];
  limitHours: boolean;
  between: [string, string];
  /** interval: kept from a stored trigger so an edit does not restart the rhythm. */
  anchor?: string;
  /** once: local "YYYY-MM-DDTHH:MM" — exactly what <input type=datetime-local> yields. */
  onceAt: string;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone the browser knows, with `current` guaranteed present. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return [...new Set([current, browserTimeZone(), "UTC", ...zones])];
}

export function emptyTriggerForm(tz: string = browserTimeZone()): TriggerForm {
  return {
    repeat: "day",
    tz,
    at: ["09:00"],
    weekDays: [...WEEKDAYS],
    monthMode: "day",
    monthDay: 1,
    nth: 1,
    weekday: "mon",
    gap: 1,
    gapUnit: "hours",
    limitDays: false,
    intervalDays: [...WEEKDAYS],
    limitHours: false,
    between: ["09:00", "17:00"],
    onceAt: "",
  };
}

/** A stored trigger → the form showing it. */
export function formFromTrigger(t: Trigger): TriggerForm {
  const form = { ...emptyTriggerForm(t.tz), repeat: t.every };
  switch (t.every) {
    case "interval": {
      const hours = t.minutes % 60 === 0;
      return {
        ...form,
        gap: hours ? t.minutes / 60 : t.minutes,
        gapUnit: hours ? "hours" : "minutes",
        limitDays: !!t.on,
        intervalDays: t.on ?? form.intervalDays,
        limitHours: !!t.between,
        between: t.between ?? form.between,
        ...(t.anchor ? { anchor: t.anchor } : {}),
      };
    }
    case "day":
      return { ...form, at: t.at };
    case "week":
      return { ...form, at: t.at, weekDays: t.on };
    case "month": {
      const day: MonthDay = t.day;
      if (day === "last") return { ...form, at: t.at, monthMode: "last" };
      if (typeof day === "number") return { ...form, at: t.at, monthMode: "day", monthDay: day };
      return { ...form, at: t.at, monthMode: "weekday", nth: day.nth, weekday: day.weekday };
    }
    case "once":
      return { ...form, onceAt: t.at };
  }
}

const canonicalDays = (days: Day[]): Day[] => DAYS.filter((d) => days.includes(d));
const canonicalTimes = (times: string[]): string[] => [...new Set(times.filter(Boolean))].sort();

/** The form → the draft to send, or a plain-language reason it is not ready. */
export function triggerFromForm(f: TriggerForm): { trigger: TriggerDraft } | { problem: string } {
  const at = canonicalTimes(f.at);
  const needsTime = f.repeat === "day" || f.repeat === "week" || f.repeat === "month";
  if (needsTime && at.length === 0) return { problem: "Pick at least one time." };
  switch (f.repeat) {
    case "interval": {
      const minutes = Math.round(f.gap * (f.gapUnit === "hours" ? 60 : 1));
      if (!Number.isFinite(minutes) || minutes < 1) return { problem: "The gap must be at least 1 minute." };
      if (f.limitDays && f.intervalDays.length === 0) return { problem: "Pick at least one day." };
      if (f.limitHours && !(f.between[0] && f.between[1] && f.between[0] < f.between[1])) {
        return { problem: "The time window must start before it ends." };
      }
      return {
        trigger: {
          every: "interval",
          minutes,
          ...(f.anchor ? { anchor: f.anchor } : {}),
          ...(f.limitDays ? { on: canonicalDays(f.intervalDays) } : {}),
          ...(f.limitHours ? { between: f.between } : {}),
          tz: f.tz,
        },
      };
    }
    case "day":
      return { trigger: { every: "day", at, tz: f.tz } };
    case "week":
      if (f.weekDays.length === 0) return { problem: "Pick at least one day." };
      return { trigger: { every: "week", on: canonicalDays(f.weekDays), at, tz: f.tz } };
    case "month": {
      const day: MonthDay = f.monthMode === "last" ? "last" : f.monthMode === "day" ? f.monthDay : { nth: f.nth, weekday: f.weekday };
      if (typeof day === "number" && !(Number.isInteger(day) && day >= 1 && day <= 28)) {
        return { problem: "Pick a day from 1 to 28 — for the end of the month, choose “last day”." };
      }
      return { trigger: { every: "month", day, at, tz: f.tz } };
    }
    case "once":
      if (!f.onceAt) return { problem: "Pick a date and time." };
      return { trigger: { every: "once", at: f.onceAt.slice(0, 16), tz: f.tz } };
  }
}

// ── Input tokens ───────────────────────────────────────────────────────────

/** A value the form treats as a fire-time template rather than a literal. */
export function isTemplate(v: unknown): v is string {
  return typeof v === "string" && v.includes("{{");
}

export const NOW_TOKEN = "{{ now }}";
export const TODAY_TOKEN = "{{ today }}";
/** `{{ last.output.key }}` — bracket form when the key is not an identifier. */
export function lastOutputToken(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `{{ last.output.${key} }}` : `{{ last.output[${JSON.stringify(key)}] }}`;
}

/** Drop empty entries so the server sees omitted keys cleanly. */
export function cleanInput(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== ""));
}

/** "in 3 hours", "tomorrow"-ish relative phrasing for a future ISO instant. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const phrase =
    abs < 60_000 ? "less than a minute" : abs < 3_600_000 ? unit(Math.round(abs / 60_000), "minute") : abs < 86_400_000 ? unit(Math.round(abs / 3_600_000), "hour") : unit(Math.round(abs / 86_400_000), "day");
  return diff >= 0 ? `in ${phrase}` : `${phrase} ago`;
}
