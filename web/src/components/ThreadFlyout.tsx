import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { formatTokens } from "../context-meter";
import { CloseIcon } from "../icons";
import { extractText, transcriptToEntries, type TranscriptMark } from "../transcript";
import { FlyoutResizer } from "./FlyoutResizer";
import { Transcript } from "./Transcript";
import { fmtCost } from "./JobTimeline";

// ── Thread view (plans/jobs-sidebar.md §4) ─────────────────────────────────
//
// One agent thread of a job, read back and rendered with the chat's own
// renderer, read-only: a session's transcript up to a turn (the turn's
// `?full=1` link — the thread stitched from the session store), or a cold
// execution's. Turn marks sit where each turn began (`offset`); the system
// prompt is collapsed at the top. No input box: a host launches turns.

export function ThreadFlyout(props: {
  thread: api.JobThread;
  /** Read the thread up to this turn; default its last turn with a transcript. */
  turn?: api.JobTurn;
  onClose: () => void;
  onOpenRun: (workflow: string, runId: string) => void;
}) {
  const { thread } = props;
  const target = props.turn?.transcript ? props.turn : [...thread.turns].reverse().find((t) => t.transcript);
  const [messages, setMessages] = useState<api.StoredMessage[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  useEffect(() => {
    setMessages(null);
    setError("");
    if (!target?.transcript) return;
    const ctrl = new AbortController();
    api.getTranscript(target.transcript, ctrl.signal).then(
      (m) => setMessages(m),
      (e) => { if ((e as Error)?.name !== "AbortError") setError(errorMessage(e)); },
    );
    return () => ctrl.abort();
  }, [target?.transcript]);

  const entries = useMemo(() => {
    if (!messages) return [];
    const marks: TranscriptMark[] = [];
    if (thread.session && target?.offset != null) {
      // Index 0 is the system prompt; a turn starts at 1 + its offset.
      for (const t of thread.turns) {
        if (t.offset == null || t.offset > target.offset) continue;
        marks.push({
          at: 1 + t.offset,
          label: `turn ${t.turn}`,
          detail: [`run ${t.runId}`, t.toolCalls ? `${t.toolCalls} tool${t.toolCalls === 1 ? "" : "s"}` : "", typeof t.cost === "number" ? fmtCost(t.cost) : ""].filter(Boolean).join(" · "),
        });
      }
    } else if (target) {
      marks.push({ at: 1, label: thread.label, detail: `run ${target.runId}` });
    }
    return transcriptToEntries(messages, marks);
  }, [messages, thread, target]);

  const system = messages?.[0]?.role === "system" ? extractText(messages[0].content) : "";
  const t = thread.totals;

  return (
    <div class="flyout">
      <FlyoutResizer />
      <div class="flyout-header">
        <div>
          <div class="flyout-title">
            {thread.label}
            {thread.session && <span style="color:var(--text-dim);font-weight:400;"> · {thread.id.slice(0, 8)}</span>}
          </div>
          <div class="flyout-meta-row" style="gap:12px;font-size:11px;color:var(--text-muted);">
            <span>{t.turns} turn{t.turns === 1 ? "" : "s"}</span>
            {t.usage.outputTokens > 0 && <span>{formatTokens(t.usage.outputTokens)} out</span>}
            {t.cost > 0 && <span>{fmtCost(t.cost)}</span>}
            {t.context && <span>ctx {formatTokens(t.context.used)}/{formatTokens(t.context.limit)}</span>}
            {target && <button class="turn-link" onClick={() => props.onOpenRun(target.workflow, target.runId)}>open run {target.runId}</button>}
          </div>
        </div>
        <button class="flyout-close" onClick={props.onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div class="flyout-body thread-flyout-body">
        {!target && <div class="job-empty">This thread recorded no transcript.</div>}
        {error && <div class="artifact-status tone-error">{error}</div>}
        {target && !messages && !error && <div class="job-empty">Loading…</div>}
        {system && (
          <details class="thread-system">
            <summary>System prompt · {formatTokens(Math.round(system.length / 4))} tokens (est.)</summary>
            <pre>{system}</pre>
          </details>
        )}
        {messages && (
          <div class="chat-messages" style="padding:0;">
            <Transcript entries={entries} expanded={expanded} onToggle={toggle} onOpenRun={props.onOpenRun} />
          </div>
        )}
      </div>
    </div>
  );
}
