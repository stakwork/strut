import { useEffect, useState } from "preact/hooks";
import { fmtTime } from "./JobTimeline";

/**
 * A run's time in a list row. The id (a millisecond timestamp) is never
 * shown: it is the tooltip, and a click copies it — without selecting the
 * row. The duration rides along, dim. A run still in flight has no summary
 * yet, so `at` falls back to the id itself — the launch time in ms.
 */
export function RunTime({ runId, at, durationMs }: { runId: string; at?: string; durationMs?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  const when = at ?? (/^\d+$/.test(runId) ? new Date(Number(runId)).toISOString() : undefined);
  return (
    <span class="run-time" title={`${runId} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(runId).then(() => setCopied(true), () => {});
      }}>
      {copied ? "copied" : when ? fmtTime(when, true) : "…"}
      {!copied && durationMs != null && <span class="run-time-dur">{durationMs}ms</span>}
    </span>
  );
}
