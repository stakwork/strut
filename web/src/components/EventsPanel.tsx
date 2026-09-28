import { useState, useEffect, useLayoutEffect, useRef } from "preact/hooks";
import * as api from "../api";
import { eventTone, statusTone } from "../helpers";
import { ValueFields } from "./ValueFields";
import { StepData } from "../flow-to-canvas";
import { CloseIcon } from "../icons";
import { EvolveChart } from "./EvolveChart";
import yaml from "js-yaml";

// ── Events Panel (expandable rows) ─────────────────────────────────────────

interface RunRef {
  label?: string;
  workflow: string;
  runId: string;
}

/** A step may attach pointers to related runs via `input.runs` / `output.runs`
 *  (e.g. eval/optimize links each generation's eval & reflect runs). Collect
 *  them so the panel can render "open run" links that drill into those logs. */
function runRefs(evt: api.RunEvent): RunRef[] {
  const out: RunRef[] = [];
  for (const src of [evt.input, evt.output]) {
    const runs = (src as { runs?: unknown } | null | undefined)?.runs;
    if (!Array.isArray(runs)) continue;
    for (const r of runs) {
      if (r && typeof r.workflow === "string" && typeof r.runId === "string") {
        out.push({ label: typeof r.label === "string" ? r.label : undefined, workflow: r.workflow, runId: r.runId });
      }
    }
  }
  return out;
}

/** A run's history replays back-to-back; a live run's tail polls every 250ms.
 *  A gap this long means the replay is over. */
const SETTLE_MS = 200;

const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

export function EventsPanel(props: {
  events: api.RunEvent[];
  /** Navigate to another workflow's run (used by run-ref links). */
  onOpenRun?: (workflow: string, runId: string) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Opening a run replays its whole log in a quick burst of renders (app.tsx
  // clears events on every run switch, so the panel mounts per run). Stay pinned to the bottom until that burst goes
  // quiet or the user scrolls up — then never follow again: a new event
  // leaves the view where it is, and the pill jumps down on demand.
  const settling = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Auto-expand run.end when it arrives
  useEffect(() => {
    const idx = props.events.findIndex((e) => e.type === "run.end");
    if (idx >= 0) setExpanded(idx);
  }, [props.events]);

  // Layout effect: the scroll lands in the same commit as the new rows, so no
  // scroll event ever sees the grown log unpinned and ends the settle early.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (settling.current) el.scrollTop = el.scrollHeight;
    setAtBottom(isAtBottom(el));
  }, [props.events.length, expanded]);

  useEffect(() => {
    const t = setTimeout(() => { settling.current = false; }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [props.events.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    if (!bottom) settling.current = false;
    setAtBottom(bottom);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div class="shell-events" ref={scrollRef} onScroll={onScroll}>
      {!atBottom && (
        <div class="events-jump-anchor">
          <button class="events-jump" onClick={jumpToBottom} title="Jump to the latest event">↓ Latest</button>
        </div>
      )}
      <div class="events-header">Events ({props.events.length})</div>
      <EvolveChart events={props.events} onOpenRun={props.onOpenRun} />
      {props.events.map((evt, i) => {
        const hasData = evt.input != null || evt.output != null || evt.error != null;
        const isOpen = expanded === i;
        const refs = props.onOpenRun ? runRefs(evt) : [];
        return (
          <div key={i} class="event-row">
            <div class="event-row-summary" onClick={() => hasData && setExpanded(isOpen ? null : i)}>
              <span class={`event-type event-type-${eventTone(evt.type)}`}>{evt.type}</span>
              <span class="event-path">{evt.path}</span>
              {refs.map((r, j) => (
                <button
                  key={j}
                  class="event-run-link"
                  title={`Open ${r.workflow} / ${r.runId}`}
                  onClick={(e) => { e.stopPropagation(); props.onOpenRun!(r.workflow, r.runId); }}
                >
                  ↗ {r.label ?? "open run"}
                </button>
              ))}
              <span class="event-duration">{evt.durationMs != null ? `${evt.durationMs}ms` : ""}</span>
            </div>
            {isOpen && (
              <div class="event-detail">
                {evt.input != null && (
                  <>
                    <div class="event-detail-label">Input</div>
                    <ValueFields value={evt.input} blockClass="event-detail-block" />
                  </>
                )}
                {evt.output != null && (
                  <>
                    <div class="event-detail-label">Output</div>
                    <ValueFields value={evt.output} blockClass="event-detail-block" />
                  </>
                )}
                {evt.error != null && (
                  <>
                    <div class="event-detail-label">Error</div>
                    <ValueFields value={evt.error} blockClass="event-detail-block tone-error" />
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
