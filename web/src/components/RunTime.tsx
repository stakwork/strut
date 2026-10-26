import { fmtTime } from "./JobTimeline";
import { fmtDuration } from "../duration";

/**
 * A run's time in a list row. The id (a millisecond timestamp) is never
 * shown: it is the tooltip. A click bubbles to the row, which opens the run,
 * and silently copies the id as well. The duration rides along, dim. A run
 * still in flight has no summary yet, so `at` falls back to the id itself —
 * the launch time in ms.
 */
export function RunTime({ runId, at, durationMs }: { runId: string; at?: string; durationMs?: number }) {
  const when = at ?? (/^\d+$/.test(runId) ? new Date(Number(runId)).toISOString() : undefined);
  return (
    <span class="run-time" title={`${runId} — click to open (id copied)`}
      onClick={() => {
        try { void navigator.clipboard?.writeText(runId).catch(() => {}); } catch { /* no clipboard */ }
      }}>
      {when ? fmtTime(when, true) : "…"}
      {durationMs != null && <span class="run-time-dur">{fmtDuration(durationMs)}</span>}
    </span>
  );
}
