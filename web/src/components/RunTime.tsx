import { useEffect, useState } from "preact/hooks";
import { fmtTime } from "./JobTimeline";

/**
 * A run's time in a list row. The id (a millisecond timestamp) is never
 * shown: it is the tooltip, and a click copies it — without selecting the
 * row. The duration rides along, dim.
 */
export function RunTime({ runId, at, durationMs }: { runId: string; at?: string; durationMs?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span class="run-time" title={`${runId} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(runId).then(() => setCopied(true), () => {});
      }}>
      {copied ? "copied" : at ? fmtTime(at, true) : "…"}
      {!copied && durationMs != null && <span class="run-time-dur">{durationMs}ms</span>}
    </span>
  );
}
