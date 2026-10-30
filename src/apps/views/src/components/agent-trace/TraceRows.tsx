// The cascade's rows and geometry, ported from hive's Traces view
// (src/components/legal/CascadeRow.tsx, CascadeTrace.tsx): 34px rows set
// absolutely over one SVG per agent that draws the lane spines and the
// sub-agents' fork and merge curves. These constants are the layout. Every
// tooltip is a `title`, so the downloaded snapshot keeps them.
import type { ReactNode } from "react";
import type { AccessedNode, TraceRow, TraceTurn } from "@strut/kit";
import { cn } from "@/lib/utils";
import { fmtTokens } from "../../lib/format";

export const ROW_H = 34;
export const TOP_PAD = 10;
export const LANE_X = [96, 176, 248];
/** Node chips live on the right rail. */
export const RAIL_CHIP_W = 224;
export const RAIL_RIGHT = 8;
export const MIN_W = 760;

export const LANE_TEXT = ["text-cyan-700 dark:text-cyan-400", "text-violet-700 dark:text-violet-400", "text-rose-700 dark:text-rose-400"];
export const LANE_STROKE = ["stroke-cyan-600 dark:stroke-cyan-400", "stroke-violet-600 dark:stroke-violet-400", "stroke-rose-600 dark:stroke-rose-400"];
const LANE_FILL = ["fill-cyan-600 dark:fill-cyan-400", "fill-violet-600 dark:fill-violet-400", "fill-rose-600 dark:fill-rose-400"];

export const laneOf = (depth: number) => Math.min(Math.max(depth, 0), LANE_X.length - 1);

type Pill = Extract<TraceRow, { kind: "pill" }>;
type AgentRow = Extract<TraceRow, { kind: "agent" }>;
type NodeRow = Extract<TraceRow, { kind: "node" }>;

/** What renders: the model's rows, an open agent row's prompt, an open pill's turns. */
export type ViewRow =
  | { type: "row"; row: TraceRow; key: string }
  | { type: "prompt"; row: AgentRow; key: string }
  | { type: "turn"; pill: Pill; turn: TraceTurn; key: string };

/** A pill by its first call, so the reasoning a transcript adds before it keeps the pill open. */
export function pillKey(row: Pill): string {
  return `${row.session}:${row.turns.find((t) => t.kind !== "reasoning")?.order ?? row.from}`;
}

export function buildViewRows(rows: TraceRow[], open: ReadonlySet<string>): ViewRow[] {
  const out: ViewRow[] = [];
  rows.forEach((row, i) => {
    const key = row.kind === "pill" ? `pill:${pillKey(row)}` : row.kind === "agent" ? `agent:${row.session}` : `${row.kind}:${row.session}:${i}`;
    out.push({ type: "row", row, key });
    if (row.kind === "agent" && row.prompt && open.has(key)) out.push({ type: "prompt", row, key: `prompt:${row.session}` });
    if (row.kind === "pill" && open.has(key)) for (const turn of row.turns) out.push({ type: "turn", pill: row, turn, key: `turn:${row.session}:${turn.order}` });
  });
  return out;
}

export const viewLane = (vr: ViewRow) => laneOf(vr.type === "turn" ? vr.pill.depth : vr.row.depth);

/** `m:ss` from the run's first agent; blank when either time is unknown. */
function clock(at: number | null, start: number | null): string {
  if (at === null || start === null) return "";
  const s = Math.max(0, Math.round((at - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtSpan(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${(ms / 60_000).toFixed(1)}m`;
}

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A chip of the header strips. */
export function Chip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md border px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
      <span>{label}</span>
      <b className="font-semibold text-foreground">{value}</b>
    </span>
  );
}

export const tokensOf = (u: { totalTokens: number } | undefined) => (u?.totalTokens ? fmtTokens(u.totalTokens) : null);

// ── The lanes ────────────────────────────────────────────────────────────────

const y = (i: number) => TOP_PAD + i * ROW_H + ROW_H / 2;

/** The spines, a dashed hand-off between one lane's segments, and the fork and merge curves. */
export function LanesSvg({ rows, height, live }: { rows: ViewRow[]; height: number; live: boolean }) {
  const lanes = rows.map(viewLane);
  const segments: { lane: number; start: number; end: number }[] = [];
  lanes.forEach((lane, i) => {
    const last = segments[segments.length - 1];
    if (last && last.lane === lane && last.end === i - 1) last.end = i;
    else segments.push({ lane, start: i, end: i });
  });
  const out: ReactNode[] = [];
  segments.forEach((seg, gi) => {
    const x = LANE_X[seg.lane]!;
    out.push(<line key={`seg-${gi}`} x1={x} y1={y(seg.start)} x2={x} y2={y(seg.end)} strokeWidth={2} className={LANE_STROKE[seg.lane]} />);
    const next = segments.slice(gi + 1).find((s) => s.lane === seg.lane);
    if (next) out.push(<line key={`dash-${gi}`} x1={x} y1={y(seg.end)} x2={x} y2={y(next.start)} strokeWidth={1.5} strokeDasharray="2 5" opacity={0.45} className={LANE_STROKE[seg.lane]} />);
  });
  rows.forEach((vr, i) => {
    if (vr.type !== "row") return;
    const curve = (from: number, to: number, a: number, b: number) =>
      `M${LANE_X[from]} ${y(a)} C ${LANE_X[from]} ${y(a) + ROW_H * 0.7}, ${LANE_X[to]} ${y(b) - ROW_H * 0.7}, ${LANE_X[to]} ${y(b)}`;
    if (vr.row.kind === "agent" && i > 0) out.push(<path key={`fork-${i}`} d={curve(lanes[i - 1]!, lanes[i]!, i - 1, i)} fill="none" strokeWidth={2} className={LANE_STROKE[lanes[i]!]} />);
    if (vr.row.kind === "response" && vr.row.merge && i + 1 < rows.length) out.push(<path key={`merge-${i}`} d={curve(lanes[i]!, lanes[i + 1]!, i, i + 1)} fill="none" strokeWidth={2} className={LANE_STROKE[lanes[i]!]} />);
  });
  if (live && rows.length) {
    const last = y(rows.length - 1);
    out.push(<line key="head" x1={LANE_X[0]} y1={last} x2={LANE_X[0]} y2={last + ROW_H * 0.8} strokeWidth={2} opacity={0.6} className={LANE_STROKE[0]} />);
  }
  return (
    <svg width="100%" height={height} className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
      {out}
    </svg>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

function Marker({ x, children }: { x: number; children: ReactNode }) {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" className="pointer-events-none absolute top-1/2 -translate-y-1/2" style={{ left: x - 9 }} aria-hidden>
      {children}
    </svg>
  );
}

function marker(vr: ViewRow, lane: number): ReactNode {
  const fill = LANE_FILL[lane];
  const stroke = LANE_STROKE[lane];
  if (vr.type === "prompt") return <rect x={5} y={5} width={8} height={8} rx={2} className="fill-foreground" />;
  if (vr.type === "turn") {
    const t = vr.turn;
    if (t.kind === "reasoning") return <circle cx={9} cy={9} r={4} className={cn("fill-card", stroke)} strokeWidth={2} />;
    if (t.error) return <circle cx={9} cy={9} r={3.5} className="fill-destructive" />;
    return <circle cx={9} cy={9} r={t.kind === "call" ? 4 : 2.5} className={fill} opacity={t.kind === "call" ? 1 : 0.7} />;
  }
  const row = vr.row;
  switch (row.kind) {
    case "prompt":
      return <rect x={4.5} y={4.5} width={9} height={9} rx={2} className="fill-foreground" />;
    case "agent":
      return <circle cx={9} cy={9} r={5.5} className={cn("fill-card", stroke)} strokeWidth={2.5} />;
    case "pill":
      return <circle cx={9} cy={9} r={4.5} className={fill} />;
    case "node":
      return (
        <rect x={4.5} y={4.5} width={9} height={9} transform="rotate(45 9 9)" strokeWidth={2}
          className={row.verb === "read" ? "fill-card stroke-amber-600 dark:stroke-amber-400" : "fill-amber-600 stroke-amber-600 dark:fill-amber-400 dark:stroke-amber-400"} />
      );
    case "response":
      return (
        <>
          <circle cx={9} cy={9} r={6} fill="none" strokeWidth={1.5} className={row.error ? "stroke-destructive" : stroke} />
          <circle cx={9} cy={9} r={2.8} className={row.error ? "fill-destructive" : fill} />
        </>
      );
  }
}

const LABEL = "absolute top-1/2 -translate-y-1/2 overflow-hidden text-ellipsis whitespace-nowrap";

export interface RowProps {
  vr: ViewRow;
  index: number;
  /** The run's first agent's start: the time gutter's zero. */
  startMs: number | null;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Show a text whole. */
  onRead: (title: string, text: string) => void;
  /** Open a node the trace named. */
  onPeek: (node: AccessedNode) => void;
  /** A node being read, by ref. */
  peeking: string | null;
}

/** One 34px row: the time gutter, its marker on the lane, and its content. */
export function TraceRowItem(p: RowProps) {
  const { vr, index } = p;
  const lane = viewLane(vr);
  const at = vr.type === "turn" ? vr.turn.at : vr.type === "prompt" ? null : vr.row.at;
  const gutter = clock(at, p.startMs);
  return (
    <div className="absolute right-0 left-0 flex items-center rounded-md hover:bg-muted/40" style={{ top: TOP_PAD + index * ROW_H, height: ROW_H }} data-row={vr.type === "row" ? vr.row.kind : vr.type}>
      {gutter && <div className="absolute left-1 w-[52px] text-right font-mono text-[10px] text-muted-foreground tabular-nums">{gutter}</div>}
      <Marker x={LANE_X[lane]!}>{marker(vr, lane)}</Marker>
      <RowContent {...p} lane={lane} />
    </div>
  );
}

function TextButton({ x, title, text, className, onRead, children }: { x: number; title: string; text: string; className?: string; onRead: RowProps["onRead"]; children: ReactNode }) {
  return (
    <button type="button" className={cn(LABEL, "text-left hover:underline", className)} style={{ left: x, right: 250 }} title={cut(text, 600)} onClick={() => onRead(title, text)}>
      {children}
    </button>
  );
}

function RowContent({ vr, lane, open, onToggle, onRead, onPeek, peeking }: RowProps & { lane: number }) {
  const x = LANE_X[lane]!;
  const laneText = LANE_TEXT[lane];
  if (vr.type === "prompt") {
    return (
      <TextButton x={x + 40} title={`${vr.row.label} · prompt`} text={vr.row.prompt} className="text-[12.5px] font-semibold" onRead={onRead}>
        “{oneLine(cut(vr.row.prompt, 240))}”
      </TextButton>
    );
  }
  if (vr.type === "turn") {
    const t = vr.turn;
    const title = `${t.tool ?? t.kind} · ${t.kind}`;
    if (t.kind === "reasoning") {
      return (
        <TextButton x={x + 40} title="reasoning" text={t.text} className="text-xs text-muted-foreground italic" onRead={onRead}>
          {oneLine(cut(t.text, 300))}
        </TextButton>
      );
    }
    return (
      <TextButton x={x + 40} title={title} text={t.text} className={cn("font-mono text-[11.5px] text-muted-foreground", t.error && "text-destructive")} onRead={onRead}>
        <span className={cn("font-semibold", laneText)}>{t.kind === "result" ? "→ " : ""}{t.tool}</span> {oneLine(cut(t.text, 240))}
      </TextButton>
    );
  }
  const row = vr.row;
  switch (row.kind) {
    case "prompt":
      return (
        <TextButton x={x + 26} title="prompt" text={row.text} className="text-[12.5px] font-semibold" onRead={onRead}>
          “{oneLine(cut(row.text, 240))}”
        </TextButton>
      );
    case "response":
      return (
        <TextButton x={x + 26} title={row.error ? "error" : "response"} text={row.text} className={cn("text-[12.5px] font-semibold", row.error ? "text-destructive" : laneText)} onRead={onRead}>
          “{oneLine(cut(row.text, 240))}”
        </TextButton>
      );
    case "agent": {
      const key = vr.key;
      return (
        <button
          type="button"
          onClick={() => onToggle(key)}
          title={`${row.session} — the prompt it was given`}
          className={cn(LABEL, "text-left font-mono text-[10.5px] font-bold tracking-[0.1em] uppercase", laneText)}
          style={{ left: x + 26, right: 250 }}
        >
          <span className="text-[9px] opacity-80">{open.has(key) ? "▾" : "▸"}</span> sub-agent{" "}
          <span className="font-normal tracking-normal text-muted-foreground normal-case">· {row.label} · {row.status}</span>
          {!row.hasTrace && <span className="ml-2 rounded border px-1 py-px text-[9px] font-normal tracking-normal text-muted-foreground normal-case">no trace</span>}
        </button>
      );
    }
    case "pill": {
      const key = vr.key;
      const span = fmtSpan(row.durationMs);
      return (
        <div className="absolute top-1/2 -translate-y-1/2" style={{ left: x + 26 }}>
          <button
            type="button"
            onClick={() => onToggle(key)}
            title={row.mix.map((m) => `${m.tool} ×${m.count}`).join(" · ")}
            className="inline-flex items-center gap-2 rounded-full border bg-muted/30 px-3 py-0.5 font-mono text-[11.5px] text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground"
          >
            <span className="text-[9px] opacity-80">{open.has(key) ? "▾" : "▸"}</span>
            {row.calls > 0 && (
              <>
                <b className="font-semibold text-foreground">{row.calls}</b>
                <span>{row.calls === 1 ? "call" : "calls"}</span>
              </>
            )}
            {row.reasoning > 0 && <span>{row.calls > 0 ? "· " : ""}{row.reasoning} reasoning</span>}
            {span && <span>· {span}</span>}
            {row.errors > 0 && <span className="text-destructive">· {row.errors} failed</span>}
            {row.open && <span className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />}
          </button>
        </div>
      );
    }
    case "node":
      return <NodeChip row={row} x={x} onPeek={onPeek} peeking={peeking} />;
  }
}

const VERB: Record<NodeRow["verb"], string> = { read: "READ", created: "+ CREATED", edited: "EDITED", deleted: "DELETED" };

/** A node the call named, on the right rail; a click opens it from the graph. */
function NodeChip({ row, x, onPeek, peeking }: { row: NodeRow; x: number; onPeek: RowProps["onPeek"]; peeking: string | null }) {
  const n = row.node;
  const wrote = row.verb !== "read";
  const name = n.name || n.ref_id.slice(0, 8);
  const title = `${name}\n${n.node_type ?? "node"} · ${row.verb} by ${row.tool}${n.peer ? ` · in @${n.peer}'s graph` : ""}`;
  return (
    <>
      <div className="absolute top-1/2 border-t border-dashed border-amber-600/60 dark:border-amber-400/60" style={{ left: x + 12, right: RAIL_RIGHT + RAIL_CHIP_W + 12 }} aria-hidden />
      <button
        type="button"
        disabled={!!n.peer}
        onClick={() => onPeek(n)}
        title={title}
        className={cn(
          "absolute top-1/2 flex h-[26px] -translate-y-1/2 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] hover:shadow-sm disabled:cursor-default",
          wrote
            ? "border-amber-600 bg-amber-600 text-white hover:bg-amber-500 dark:border-amber-400 dark:bg-amber-400 dark:text-amber-950"
            : "border-amber-600/45 bg-amber-500/10 text-amber-700 hover:border-amber-600 dark:border-amber-400/45 dark:text-amber-400",
          peeking === n.ref_id && "animate-pulse",
        )}
        style={{ right: RAIL_RIGHT, width: RAIL_CHIP_W }}
      >
        <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden>
          <rect x={2.5} y={2.5} width={7} height={7} transform="rotate(45 6 6)" fill="none" stroke="currentColor" strokeWidth={1.6} />
        </svg>
        <span className="min-w-0 flex-1 overflow-hidden text-left font-semibold text-ellipsis whitespace-nowrap">{name}</span>
        <span className="shrink-0 text-[9px] tracking-[0.12em] opacity-85">{VERB[row.verb]}</span>
      </button>
    </>
  );
}
