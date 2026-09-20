/**
 * Automations — run a workflow on a schedule (plans/automations.md).
 *
 * This file is the PURE half: the record, the closed trigger grammar (no
 * cron, no RRULE — a schedule the grammar cannot express is fixed by adding
 * a shape), `nextFire` (a trigger → its next instant), `describeTrigger`
 * (the human sentence), and the fire-time input scope. One implementation of
 * the calendar math drives the form's preview, the chat tool's result and
 * the scheduler. The policy layer + tick loop live in `scheduler.ts`.
 *
 * An automation is workflow-level METADATA (beside `category`), never part
 * of the versioned YAML: editing or pausing one publishes no version.
 */
import { z } from "zod";
import { exprRoots, resolveConfig, templateExprs } from "./expr.js";

// ── Grammar ────────────────────────────────────────────────────────────────

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

/** `getUTCDay()` index (0 = Sunday) → our day key. */
const DAY_BY_INDEX: readonly Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone a draft without `tz` gets — the server's own. */
export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const hhmm = z.string().regex(HHMM_RE, "must be a 24-hour HH:MM time, e.g. \"09:00\"");
const day = z.enum(DAYS);
const tz = z
  .string()
  .refine(isValidTimeZone, "must be an IANA time zone, e.g. \"America/New_York\"")
  .optional()
  .describe("IANA time zone the times are in, e.g. \"America/New_York\". Omitted = the SERVER's zone — say which zone you assumed.");
const at = z.array(hhmm).min(1).describe("Times of day, 24-hour \"HH:MM\". One fire per time.");
const type = z.literal("schedule").default("schedule");

const monthDay = z.union([
  z.number().int().min(1).max(28),
  z.literal("last"),
  z.object({ nth: z.union([z.number().int().min(1).max(4), z.literal("last")]), weekday: day }),
]);

/** What both doors accept: `tz` and the interval `anchor` may be omitted and
 *  are filled by `normalizeTrigger`. */
export const triggerSchema = z
  .discriminatedUnion("every", [
    z.object({
      type,
      every: z.literal("interval"),
      minutes: z.number().int().min(1).describe("Gap between fires, in minutes (2 hours = 120)."),
      anchor: z.string().optional().describe("ISO instant the rhythm starts from (fires are anchor + k·minutes). Omitted = now."),
      on: z.array(day).min(1).optional().describe("Only fire on these days."),
      between: z.tuple([hhmm, hhmm]).optional().describe("Only fire inside this time-of-day window, inclusive, e.g. [\"09:00\",\"17:00\"]."),
      tz,
    }),
    z.object({ type, every: z.literal("day"), at, tz }),
    z.object({ type, every: z.literal("week"), on: z.array(day).min(1).describe("Days of the week."), at, tz }),
    z.object({
      type,
      every: z.literal("month"),
      day: monthDay.describe("Day of the month 1–28, \"last\" (the last day), or { nth: 1–4 | \"last\", weekday } (e.g. the last Friday). 29–31 do not exist: use \"last\"."),
      at,
      tz,
    }),
    z.object({
      type,
      every: z.literal("once"),
      at: z.string().regex(LOCAL_DATETIME_RE, "must be a local date-time \"YYYY-MM-DDTHH:MM\"").describe("The single local date-time to fire at, \"YYYY-MM-DDTHH:MM\"."),
      tz,
    }),
  ])
  .superRefine((t, ctx) => {
    if (t.every === "interval") {
      if (t.between && t.between[0] >= t.between[1]) {
        ctx.addIssue({ code: "custom", path: ["between"], message: "the window must start before it ends (overnight windows are not supported)" });
      }
      if (t.anchor !== undefined && isNaN(Date.parse(t.anchor))) {
        ctx.addIssue({ code: "custom", path: ["anchor"], message: "must be an ISO date-time" });
      }
    }
    if (t.every === "once") {
      // zod still runs this after a failed regex — that issue already stands.
      const m = LOCAL_DATETIME_RE.exec(t.at);
      if (!m) return;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        ctx.addIssue({ code: "custom", path: ["at"], message: "is not a real calendar date" });
      }
    }
  })
  .describe(
    "WHEN the workflow runs — a closed grammar, never a cron string. Shapes by `every`: " +
      "`interval` { minutes, on?, between? } · `day` { at } · `week` { on, at } · `month` { day, at } · `once` { at }.",
  );

export type TriggerDraft = z.infer<typeof triggerSchema>;
/** A stored trigger: `tz` always present, and `anchor` on an interval. */
export type Trigger = TriggerDraft extends infer T
  ? T extends { every: "interval" }
    ? Omit<T, "tz" | "anchor"> & { tz: string; anchor: string }
    : T extends { every: string }
      ? Omit<T, "tz"> & { tz: string }
      : never
  : never;

export const automationInputSchema = z
  .record(z.string(), z.any())
  .describe(
    "The run's input. Values may be templates over three roots, resolved at each fire: `{{ now }}` (the fire instant, ISO), " +
      "`{{ today }}` (YYYY-MM-DD in the trigger's zone), `{{ last.output.x }}` (output of this automation's latest SUCCESSFUL run — " +
      "the cursor idiom; also last.runId / last.startedAt / last.finishedAt). Before the first success `last.output` is {}, and a key " +
      "resolving to undefined is dropped. Defaults use `||` (`{{ last.output.id || \"0\" }}`); `??` is not supported.",
  );

export const automationDraftSchema = z.object({
  name: z.string().trim().min(1).describe("Short human label, e.g. 'Morning mentions digest'."),
  trigger: triggerSchema,
  input: automationInputSchema.optional(),
  enabled: z.boolean().optional().describe("false = paused. Default true."),
});
export type AutomationDraft = z.infer<typeof automationDraftSchema>;

export const automationPatchSchema = automationDraftSchema.partial();
export type AutomationPatch = z.infer<typeof automationPatchSchema>;

/** The stored record — one entry of `WorkflowMetadata.automations`. */
export interface Automation {
  /** Generated, stable across edits; stamped on the runs it launches. */
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  input: Record<string, unknown>;
}

/** Fill what a draft may omit (zone, interval anchor) and canonicalize the
 *  lists, so equal schedules are stored equal. */
export function normalizeTrigger(draft: TriggerDraft, now: Date, fallbackTz: string = defaultTimeZone()): Trigger {
  const zone = draft.tz ?? fallbackTz;
  const times = (list: string[]) => [...new Set(list)].sort();
  const days = (list: Day[]) => DAYS.filter((d) => list.includes(d));
  switch (draft.every) {
    case "interval": {
      // Default anchor: now, on the minute — so the first fire is one gap away.
      const anchor = draft.anchor ? new Date(draft.anchor) : new Date(Math.floor(now.getTime() / 60_000) * 60_000);
      return {
        type: "schedule",
        every: "interval",
        minutes: draft.minutes,
        anchor: anchor.toISOString(),
        ...(draft.on ? { on: days(draft.on) } : {}),
        ...(draft.between ? { between: draft.between } : {}),
        tz: zone,
      };
    }
    case "day":
      return { type: "schedule", every: "day", at: times(draft.at), tz: zone };
    case "week":
      return { type: "schedule", every: "week", on: days(draft.on), at: times(draft.at), tz: zone };
    case "month":
      return { type: "schedule", every: "month", day: draft.day, at: times(draft.at), tz: zone };
    case "once":
      return { type: "schedule", every: "once", at: draft.at, tz: zone };
  }
}

// ── Time zones (Intl only, no dependency) ──────────────────────────────────

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The wall clock in `zone` at an instant. */
function localParts(ms: number, zone: string): LocalParts & { s: number } {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out["year"]!, mo: out["month"]!, d: out["day"]!, h: out["hour"]!, mi: out["minute"]!, s: out["second"]! };
}

/** Zone offset (local − UTC) in ms at an instant. */
function offsetAt(ms: number, zone: string): number {
  const p = localParts(ms, zone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

const DAY_MS = 86_400_000;

/**
 * A wall-clock time in `zone` → the instant. Tries the offsets on either
 * side of any transition near it: a time that exists once matches one; one
 * that occurs twice (fall back) takes the FIRST; one that does not exist
 * (spring forward) shifts forward by the gap — 02:30 becomes 03:30.
 */
function localToInstant(w: LocalParts, zone: string): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const before = guess - offsetAt(guess - DAY_MS, zone);
  const after = guess - offsetAt(guess + DAY_MS, zone);
  const matches = (ms: number) => {
    const p = localParts(ms, zone);
    return p.y === w.y && p.mo === w.mo && p.d === w.d && p.h === w.h && p.mi === w.mi;
  };
  const valid = [before, after].filter(matches);
  return valid.length > 0 ? Math.min(...valid) : before;
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Calendar date `offset` days after (y, mo, d) — pure calendar arithmetic. */
function addDays(y: number, mo: number, d: number, offset: number): { y: number; mo: number; d: number; day: Day } {
  const dt = new Date(Date.UTC(y, mo - 1, d + offset));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), day: DAY_BY_INDEX[dt.getUTCDay()]! };
}

function parseHHMM(s: string): { h: number; mi: number } {
  const m = HHMM_RE.exec(s)!;
  return { h: Number(m[1]), mi: Number(m[2]) };
}

// ── nextFire ───────────────────────────────────────────────────────────────

/** How far ahead a wall-clock rule is searched — past any month rule's gap. */
const HORIZON_DAYS = 400;

type DateRule = (date: { y: number; mo: number; d: number; day: Day }) => boolean;

function dateRule(t: Exclude<Trigger, { every: "interval" | "once" }>): DateRule {
  if (t.every === "day") return () => true;
  if (t.every === "week") return (date) => t.on.includes(date.day);
  const rule = t.day;
  if (rule === "last") return (date) => date.d === daysInMonth(date.y, date.mo);
  if (typeof rule === "number") return (date) => date.d === rule;
  return (date) =>
    date.day === rule.weekday &&
    (rule.nth === "last" ? date.d + 7 > daysInMonth(date.y, date.mo) : Math.ceil(date.d / 7) === rule.nth);
}

/**
 * The first instant strictly after `after` at which the trigger fires, or
 * null when it never will again (a `once` in the past; an interval whose
 * filters exclude every instant).
 */
export function nextFire(trigger: Trigger, after: Date): Date | null {
  const afterMs = after.getTime();
  const zone = trigger.tz;

  if (trigger.every === "once") {
    const m = LOCAL_DATETIME_RE.exec(trigger.at)!;
    const ms = localToInstant({ y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]! }, zone);
    return ms > afterMs ? new Date(ms) : null;
  }

  if (trigger.every === "interval") return nextIntervalFire(trigger, afterMs);

  const allows = dateRule(trigger);
  const start = localParts(afterMs, zone);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDays(start.y, start.mo, start.d, i);
    if (!allows(date)) continue;
    let best: number | null = null;
    for (const time of trigger.at) {
      const ms = localToInstant({ ...date, ...parseHHMM(time) }, zone);
      if (ms > afterMs && (best === null || ms < best)) best = ms;
    }
    if (best !== null) return new Date(best);
  }
  return null;
}

function nextIntervalFire(t: Extract<Trigger, { every: "interval" }>, afterMs: number): Date | null {
  const step = t.minutes * 60_000;
  const anchor = Date.parse(t.anchor);
  const horizon = afterMs + HORIZON_DAYS * DAY_MS;
  /** First instant on the rhythm that is ≥ `ms`. */
  const onOrAfter = (ms: number) => anchor + Math.max(0, Math.ceil((ms - anchor) / step)) * step;
  const from = t.between ? parseHHMM(t.between[0]) : { h: 0, mi: 0 };
  const to = t.between ? parseHHMM(t.between[1]) : null;

  let ms = onOrAfter(afterMs + 1);
  while (ms <= horizon) {
    const p = localParts(ms, t.tz);
    const date = addDays(p.y, p.mo, p.d, 0);
    const minute = p.h * 60 + p.mi;
    const dayOk = !t.on || t.on.includes(date.day);
    if (dayOk && minute >= from.h * 60 + from.mi && (!to || minute <= to.h * 60 + to.mi)) return new Date(ms);
    // Filtered out: jump to the next window opening rather than walking the
    // rhythm — today's if it has not opened yet, else the next allowed day's.
    let opening: number | null = null;
    if (dayOk && minute < from.h * 60 + from.mi) opening = localToInstant({ ...date, ...from }, t.tz);
    for (let i = 1; opening === null && i <= 8; i++) {
      const next = addDays(p.y, p.mo, p.d, i);
      if (!t.on || t.on.includes(next.day)) opening = localToInstant({ ...next, ...from }, t.tz);
    }
    if (opening === null) return null;
    ms = onOrAfter(Math.max(opening, ms + 1));
  }
  return null;
}

/** The next `count` fires after `after` — the preview both doors show. */
export function nextFires(trigger: Trigger, after: Date, count = 5): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextFire(trigger, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// ── describeTrigger ────────────────────────────────────────────────────────

const DAY_LABEL: Record<Day, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_NAME: Record<Day, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(time: string): string {
  const { h, mi } = parseHHMM(time);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Weekdays", "Mon, Wed, Fri", … — lower-cased mid-sentence (day
 *  abbreviations keep their capital). */
function dayList(days: readonly Day[], midSentence = false): string {
  const key = DAYS.filter((d) => days.includes(d)).join(",");
  const word = (s: string) => (midSentence ? s.toLowerCase() : s);
  if (key === DAYS.join(",")) return word("Every day");
  if (key === "mon,tue,wed,thu,fri") return word("Weekdays");
  if (key === "sat,sun") return word("Weekends");
  return DAYS.filter((d) => days.includes(d))
    .map((d) => DAY_LABEL[d])
    .join(", ");
}

function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function zoneLabel(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  return `${zone.split("/").pop()!.replace(/_/g, " ")} time`;
}

/** The trigger as one plain sentence — what a person checks the rule against. */
export function describeTrigger(t: Trigger): string {
  const zone = ` (${zoneLabel(t.tz)})`;
  switch (t.every) {
    case "interval": {
      const gap =
        t.minutes === 1
          ? "Every minute"
          : t.minutes === 60
            ? "Every hour"
            : t.minutes % 60 === 0
              ? `Every ${t.minutes / 60} hours`
              : `Every ${t.minutes} minutes`;
      const on = t.on && t.on.length < 7 ? `, ${dayList(t.on, true)}` : "";
      const between = t.between ? `, ${clock(t.between[0])} – ${clock(t.between[1])}` : "";
      return `${gap}${on}${between}${zone}`;
    }
    case "day":
      return `Every day at ${joinAnd(t.at.map(clock))}${zone}`;
    case "week":
      return `${dayList(t.on)} at ${joinAnd(t.at.map(clock))}${zone}`;
    case "month": {
      const which =
        t.day === "last"
          ? "The last day"
          : typeof t.day === "number"
            ? `The ${ordinal(t.day)}`
            : `The ${t.day.nth === "last" ? "last" : ordinal(t.day.nth)} ${DAY_NAME[t.day.weekday]}`;
      return `${which} of each month at ${joinAnd(t.at.map(clock))}${zone}`;
    }
    case "once": {
      const m = LOCAL_DATETIME_RE.exec(t.at)!;
      return `Once, on ${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]} at ${clock(`${m[4]}:${m[5]}`)}${zone}`;
    }
  }
}

// ── Fire-time input ────────────────────────────────────────────────────────

/** The scope roots an automation's input templates may read. */
export const INPUT_ROOTS = ["now", "today", "last"] as const;

/** This automation's latest SUCCESSFUL run, as the input templates see it.
 *  Never null: the evaluator throws on property access through null, and a
 *  bare `{{ last.output.x }}` must work on the first fire. */
export interface LastRun {
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  output: unknown;
}

export const NO_LAST_RUN: LastRun = { runId: null, startedAt: null, finishedAt: null, output: {} };

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* stringsIn(v);
}

/** Write-time check: every `{{ }}` in the input reads only `INPUT_ROOTS`.
 *  `{{ input.x }}` here is a mistake worth a clear error now, not a
 *  fire-time failure nobody is watching. Returns the problems found. */
export function checkInputTemplates(input: unknown): string[] {
  const problems: string[] = [];
  for (const s of stringsIn(input)) {
    for (const expr of templateExprs(s)) {
      let roots: string[];
      try {
        roots = exprRoots(expr);
      } catch (err) {
        problems.push(`{{${expr}}}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const root of roots) {
        if (!(INPUT_ROOTS as readonly string[]).includes(root)) {
          problems.push(`{{${expr}}} reads "${root}" — an automation's input can only read ${INPUT_ROOTS.join(", ")}`);
        }
      }
    }
  }
  return problems;
}

/** `YYYY-MM-DD` in `zone` at an instant. */
export function localDate(at: Date, zone: string): string {
  const p = localParts(at.getTime(), zone);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Resolve an automation's input for one fire. Top-level keys that resolve
 *  to `undefined` are dropped, so the workflow's own `input.x || …`
 *  tolerance applies on the first run. Throws `TemplateError` on a bad
 *  expression — the caller launches nothing. */
export function resolveAutomationInput(automation: Pick<Automation, "input" | "trigger">, at: Date, last: LastRun): Record<string, unknown> {
  const scope = { now: at.toISOString(), today: localDate(at, automation.trigger.tz), last };
  const resolved = resolveConfig(automation.input, scope) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(resolved).filter(([, v]) => v !== undefined));
}
