import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import * as api from "../api";
import { displayActor } from "../actor";
import { isArtifactPath } from "../artifact-view";
import { formatTokens } from "../context-meter";
import { foldRunOverview, type OverviewRow, type RowKind } from "../run-overview";
import { AgentIcon, ExternalIcon, EyeIcon, FileIcon, ImageIcon, LoopIcon, RunLinkIcon, SparkIcon, StepIcon, SubflowIcon } from "../icons";
import { ArtifactViewer } from "./ArtifactViewer";
import { fmtCost, fmtDuration, fmtTime, linkOf } from "./JobTimeline";
import { ValueFields } from "./ValueFields";

// ── Run overview: the run at a glance (the events panel's right column) ────
//
// What a person wants from a run before reading its log: did it work, what
// did it cost, how long did it take, what did it produce, and what did it
// start. Cost and model calls on top, the split of the spend under them,
// the deliverables, then a timeline — a row per top-level step with the
// work it started (sub-agents, llm calls, child runs) under it; a hover
// card has a row's numbers, a click opens it. The output and the claims
// come last, folded. Everything but the artifacts and the claims is folded
// from the events (src/run-overview.ts), so a live run moves as it goes.

const KIND_ICON: Record<RowKind, (p: { size?: number }) => JSX.Element> = {
  agent: AgentIcon,
  subagent: AgentIcon,
  llm: SparkIcon,
  subflow: SubflowIcon,
  loop: LoopIcon,
  run: RunLinkIcon,
  peer: RunLinkIcon,
  step: StepIcon,
};

const KIND_LABEL: Record<RowKind, string> = {
  agent: "agent",
  subagent: "sub-agent",
  llm: "llm",
  subflow: "subflow",
  loop: "loop",
  run: "child run",
  peer: "peer run",
  step: "step",
};

/** What an artifact card says about its link: a served file's name, a
 *  URL's host and path. */
const linkText = (link: string): string =>
  link.startsWith("/") ? link.slice(link.lastIndexOf("/") + 1) : link.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");

/** `m:ss` from the run's start, for a hover card's range. */
const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function RunOverview(props: {
  events: api.RunEvent[];
  /** The run's state as the server's controller sees it (a stale run has
   *  no terminal event and no controller), when the caller knows it. */
  status?: string;
  /** The workflow's per-run spend cap, when it sets one. */
  cap?: number;
  onOpenRun: (workflow: string, runId: string) => void;
  /** Open a step of this run — the flyout on its top-level step. */
  onOpenStep: (path: string) => void;
  onOpenJob: (job: string) => void;
}) {
  const runId = props.events[0]?.runId ?? "";
  const [now, setNow] = useState(Date.now());
  const o = useMemo(() => foldRunOverview(props.events, now), [props.events, now]);
  const live = o.status === "running" || o.status === "paused";
  // A run cut off by a crash ends in no event: the server says so.
  const status = live && props.status === "stale" ? "stale" : o.status;
  const ticking = status === "running";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // What a finished run produced, and what its checks said about it.
  const [artifacts, setArtifacts] = useState<api.ArtifactRef[]>([]);
  const [files, setFiles] = useState(0);
  const [evidence, setEvidence] = useState<api.RunEvidence[]>([]);
  const done = !live;
  useEffect(() => {
    setArtifacts([]);
    setFiles(0);
    setEvidence([]);
    if (!done || !runId || !o.workflow) return;
    let alive = true;
    api.getRunArtifacts(o.workflow, runId).then((r) => alive && setArtifacts(r.artifacts), () => {});
    api.fileScope(`/artifacts/${runId}`).then((s) => alive && setFiles(s.files.length), () => {});
    // The verify pass runs after the run ends: look again once if it had
    // not written anything yet.
    const readEvidence = () =>
      api.getRunEvidence(o.workflow, { runId, limit: 1 }).then((r) => alive && setEvidence(r.evidence.filter((e) => e.run.runId === runId)), () => {});
    void readEvidence();
    const again = setTimeout(readEvidence, 8000);
    return () => { alive = false; clearTimeout(again); };
  }, [done, runId, o.workflow]);

  const [viewing, setViewing] = useState<string | null>(null);
  const [inline, setInline] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [showClaims, setShowClaims] = useState(false);
  const [hover, setHover] = useState<{ row: OverviewRow; top: number; left: number } | null>(null);
  const output = useMemo(() => {
    for (let i = props.events.length - 1; i >= 0; i--) if (props.events[i]!.type === "run.end") return props.events[i]!.output;
    return undefined;
  }, [props.events]);

  const openArtifact = (ref: api.ArtifactRef) => {
    const link = linkOf(ref);
    if (link && isArtifactPath(link)) return setViewing(link);
    if (link) return void window.open(link, "_blank", "noopener");
    if (ref.content !== undefined) setInline((k) => (k === ref.id ? null : ref.id));
  };
  const inlineRef = artifacts.find((a) => a.id === inline && a.content !== undefined);

  const openRow = (row: OverviewRow) => {
    if (row.child?.workflow && !row.child.peer) return props.onOpenRun(row.child.workflow, row.child.runId);
    props.onOpenStep(row.key);
  };
  const showCard = (row: OverviewRow, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // Beside the column, over the event log, so it never covers the rows.
    setHover({ row, left: Math.max(8, r.left - 232), top: Math.min(r.top - 4, window.innerHeight - 170) });
  };

  const total = Math.max(1, o.durationMs);
  const spend = o.rows.filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost);
  const tokens = o.usage.inputTokens + o.usage.cacheReadTokens + o.usage.cacheWriteTokens + o.usage.outputTokens;
  const verdicts = {
    supports: evidence.filter((e) => e.verdict === "supports").length,
    refutes: evidence.filter((e) => e.verdict === "refutes").length,
    open: evidence.filter((e) => e.verdict === "open").length,
  };

  return (
    <aside class="run-overview">
      <div class="ov-head">
        <div class="ov-head-row">
          <span class={`ov-status ov-status-${status}`}>{status}</span>
          {o.job && (
            <button class="ov-job" title={`Open job ${o.job}`} onClick={() => props.onOpenJob(o.job!)}>{o.job}</button>
          )}
        </div>
        <div class="ov-meta">
          {o.workflow}
          {o.actor && <> · by {displayActor(o.actor)}</>}
          {o.startedAt && <> · {fmtTime(o.startedAt)}</>}
        </div>
        {o.error && (
          <button class="ov-error" title={o.error.path ? `Open ${o.error.path}` : undefined} onClick={() => o.error?.path && props.onOpenStep(o.error.path)}>
            {o.error.message || "failed"}
          </button>
        )}
        <div class="ov-tiles">
          <div class="ov-tile">
            <div class="ov-tile-label">Cost</div>
            <div class="ov-tile-value">{fmtCost(o.cost)}</div>
            <div class="ov-tile-sub">{props.cap ? `of ${fmtCost(props.cap)} cap` : `${formatTokens(tokens)} tokens`}</div>
          </div>
          <div class="ov-tile">
            <div class="ov-tile-label">Model calls</div>
            <div class="ov-tile-value">{o.modelCalls}</div>
            <div class="ov-tile-sub">{o.toolCalls} tool call{o.toolCalls === 1 ? "" : "s"}</div>
          </div>
        </div>
        {spend.length > 0 && (
          <div class="ov-spend">
            {spend.map((r) => (
              <div key={r.key} class={`ov-k-${r.kind}`} style={{ flex: `0 1 ${(r.cost / o.cost) * 100}%` }} title={`${r.label} · ${fmtCost(r.cost)}`} />
            ))}
          </div>
        )}
        <div class="ov-time">
          {fmtDuration(o.durationMs)}
          {o.longest && o.rows.length > 1 && o.longest.share >= 0.3 && (
            <span class="ov-dim"> · {Math.round(o.longest.share * 100)}% in {o.longest.label}</span>
          )}
        </div>
      </div>

      {(artifacts.length > 0 || files > 0) && (
        <div class="ov-sec">
          <div class="ov-sec-title">Artifacts</div>
          {artifacts.map((a) => {
            const link = linkOf(a);
            const viewable = !!link && isArtifactPath(link);
            const Icon = a.kind === "image" ? ImageIcon : FileIcon;
            return (
              <button key={a.id} class="ov-art" onClick={() => openArtifact(a)} title={a.summary ?? a.title}>
                <Icon size={14} />
                <span class="ov-art-text">
                  <span class="ov-art-title">{a.title}</span>
                  <span class="ov-art-sub">{a.error ?? a.label ?? (link ? linkText(link) : a.kind)}</span>
                </span>
                {viewable ? <EyeIcon /> : link ? <ExternalIcon /> : null}
              </button>
            );
          })}
          {inlineRef && (
            <pre class="ov-inline">{typeof inlineRef.content === "string" ? inlineRef.content : JSON.stringify(inlineRef.content, null, 2)}</pre>
          )}
          {files > 0 && (
            <button class="ov-link" onClick={() => setViewing(`/artifacts/${runId}`)}>
              {files} file{files === 1 ? "" : "s"} in this run
            </button>
          )}
        </div>
      )}

      {o.rows.length > 0 && (
        <div class="ov-sec" onMouseLeave={() => setHover(null)}>
          <div class="ov-sec-title">Timeline</div>
          {o.rows.map((r) => {
            const Icon = KIND_ICON[r.kind];
            const left = (r.start / total) * 100;
            const width = Math.max(((r.end - r.start) / total) * 100, 0.6);
            return (
              <div
                key={r.key}
                class={`ov-row${r.depth ? " ov-row-nested" : ""}${hover?.row.key === r.key ? " ov-row-on" : ""} ov-row-${r.status}`}
                onMouseEnter={(e) => showCard(r, e.currentTarget as HTMLElement)}
                onClick={() => openRow(r)}
              >
                <span class={`ov-row-label${r.child && !r.child.peer ? " ov-row-link" : ""}`}>
                  <Icon size={12} />
                  <span>{r.label}{r.count > 1 ? ` ×${r.count}` : ""}</span>
                </span>
                <span class="ov-track">
                  <span class={`ov-bar ov-k-${r.kind}${r.status === "running" ? " ov-bar-running" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} />
                </span>
                <span class="ov-num">{fmtDuration(r.end - r.start)}</span>
              </div>
            );
          })}
        </div>
      )}

      {(evidence.length > 0 || output !== undefined) && (
        <div class="ov-sec ov-folds">
          {evidence.length > 0 && (
            <>
              <button class="ov-fold" onClick={() => setShowClaims((v) => !v)}>
                <span>Claims</span>
                <span>
                  {verdicts.supports > 0 && <span class="ov-ok">{verdicts.supports} supported</span>}
                  {verdicts.refutes > 0 && <span class="ov-bad">{verdicts.supports ? " · " : ""}{verdicts.refutes} refuted</span>}
                  {verdicts.open > 0 && <span>{verdicts.supports + verdicts.refutes ? " · " : ""}{verdicts.open} open</span>}
                  <span class={`ov-chev cat-caret${showClaims ? " is-open" : ""}`}>▸</span>
                </span>
              </button>
              {showClaims && (
                <ul class="ov-claims">
                  {evidence.map((e, i) => (
                    <li key={i} class={`ov-claim ov-claim-${e.verdict}`} title={e.content ?? e.question ?? ""}>{e.claim.text}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {output !== undefined && (
            <>
              <button class="ov-fold" onClick={() => setShowOutput((v) => !v)}>
                <span>Output</span>
                <span class={`ov-chev cat-caret${showOutput ? " is-open" : ""}`}>▸</span>
              </button>
              {showOutput && <ValueFields value={output} blockClass="event-detail-block" />}
            </>
          )}
        </div>
      )}

      {hover && (
        <div class="ov-card" style={{ top: `${hover.top}px`, left: `${hover.left}px` }}>
          <div class="ov-card-title">
            {hover.row.label} <span class="ov-dim">{KIND_LABEL[hover.row.kind]}{hover.row.parent ? ` · in ${hover.row.parent}` : ""}</span>
          </div>
          <div class="ov-card-line"><span>Time</span><span>{fmtDuration(hover.row.end - hover.row.start)} <span class="ov-dim">· {clock(hover.row.start)} → {clock(hover.row.end)}</span></span></div>
          {hover.row.count > 1 && <div class="ov-card-line"><span>Runs</span><span>{hover.row.count}</span></div>}
          {hover.row.cost > 0 && <div class="ov-card-line"><span>Cost</span><span>{fmtCost(hover.row.cost)}</span></div>}
          {hover.row.modelCalls > 0 && <div class="ov-card-line"><span>Model calls</span><span>{hover.row.modelCalls}</span></div>}
          {hover.row.toolCalls > 0 && <div class="ov-card-line"><span>Tool calls</span><span>{hover.row.toolCalls}</span></div>}
          {hover.row.child && (
            <div class="ov-card-foot">{hover.row.child.peer ? `run ${hover.row.child.runId} on ${hover.row.child.peer}` : "click to open the run"}</div>
          )}
        </div>
      )}

      {viewing && <ArtifactViewer path={viewing} onClose={() => setViewing(null)} />}
    </aside>
  );
}
