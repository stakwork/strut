import { fmtDuration } from "./duration";

const FULL: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
};
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

export interface EventTime {
  /** Readable local-time text. */
  text: string;
  /** Full ISO string(s), for the hover title. */
  title: string;
  /** ISO of the event's ts, for <time dateTime>. */
  iso: string;
}

/** The wall-clock time an event ran: `ts` (emission time; the END for events
 *  with a duration) and, with `durationMs`, the start → end range. */
export function fmtEventTime(evt: { ts?: string; durationMs?: number }): EventTime | null {
  if (!evt.ts) return null;
  const end = new Date(evt.ts);
  if (Number.isNaN(end.getTime())) return null;
  const iso = end.toISOString();
  const d = evt.durationMs;
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) {
    return { text: end.toLocaleString(undefined, FULL), title: iso, iso };
  }
  const start = new Date(end.getTime() - d);
  const sameDay = start.toDateString() === end.toDateString();
  return {
    text: `${start.toLocaleString(undefined, FULL)} → ${end.toLocaleString(undefined, sameDay ? TIME : FULL)} (${fmtDuration(d)})`,
    title: `start ${start.toISOString()}\nend ${iso}`,
    iso,
  };
}
