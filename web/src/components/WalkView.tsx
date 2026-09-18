import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { formatJson } from "../helpers";
import { foldWalk, walkSummary, type WalkNode } from "../walk-graph";
import { ToolResultView } from "./ToolResultView";
import { WalkGraph } from "./WalkGraph";

// A graph_walk call in the chat (plans/walk-chat-demo.md §3): its progress
// outputs (one hop event each) folded into a live force graph. A live walk
// takes ~2 s — too fast to follow — so hops play from a queue at HOP_MS each
// while the answer streams below. A walk loaded from history shows its final
// state at once, with a replay button.

const HOP_MS = 400;
const NONE: unknown[] = [];

/** The final result, as the live stream carries it ({ status: "done", … })
 *  or as the transcript stores it (the model's view: { goal, stopped, nodes }). */
function doneOf(output: unknown): unknown | null {
  const o = output as { status?: string; stopped?: string; nodes?: unknown[] } | null;
  if (!o || typeof o !== "object" || !o.stopped || !Array.isArray(o.nodes)) return null;
  return { ...o, status: "done" };
}

export function WalkView(props: {
  chatId: string | null;
  toolCallId?: string;
  input: unknown;
  /** Hop events received live (tool-progress), in order. */
  progress?: unknown[];
  result?: { output: unknown; isError: boolean };
  live: boolean;
  onOpenRun: (workflow: string, runId: string) => void;
}) {
  const { chatId, toolCallId, result, live } = props;
  // A call that already has its result when first shown came from history
  // (or finished before we attached): fetch its hop events, show them all.
  const [fromHistory] = useState(() => !!result && !props.progress?.length);
  const [fetched, setFetched] = useState<unknown[] | null>(null);
  useEffect(() => {
    if (!fromHistory || !chatId || !toolCallId) return;
    let cancelled = false;
    api.getToolProgress(chatId, toolCallId).then((r) => !cancelled && setFetched(r.outputs)).catch(() => !cancelled && setFetched([]));
    return () => {
      cancelled = true;
    };
  }, [fromHistory, chatId, toolCallId]);

  // The SDK streams every yield as progress, the final `done` included; the
  // result carries that one, so progress is only the hop events.
  const raw = (fromHistory ? fetched : props.progress) ?? NONE;
  const hops = useMemo(() => raw.filter((o) => (o as { status?: string })?.status === "walking"), [raw]);
  const finalOutput = result && !result.isError ? result.output : undefined;
  const outputs = useMemo(() => {
    const done = doneOf(finalOutput);
    return done ? [...hops, done] : hops;
  }, [hops, finalOutput]);

  // Playback cursor over `outputs`. History starts at the end; live plays.
  const [played, setPlayed] = useState(fromHistory ? Infinity : 0);
  useEffect(() => {
    if (played >= outputs.length) return;
    const t = setTimeout(() => setPlayed((p) => p + 1), HOP_MS);
    return () => clearTimeout(t);
  }, [played, outputs.length]);

  const shown = Math.min(played, outputs.length);
  const state = useMemo(() => foldWalk(outputs.slice(0, shown)), [outputs, shown]);
  const playing = shown < outputs.length || (live && !result);
  const [selected, setSelected] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const node = selected ? state.nodes.get(selected) : undefined;
  const goal = (props.input as { goal?: string } | null)?.goal;
  // The decider: the first progress output names it, the final result repeats it.
  const decider =
    (raw.find((o) => (o as { status?: string })?.status === "start") as { decider?: string } | undefined)?.decider ??
    (finalOutput as { decider?: string } | undefined)?.decider;

  return (
    <div class="walk-view">
      <div class="walk-head">
        <span class={`chat-tool-dot is-${result ? (result.isError ? "error" : "ok") : live ? "pending" : "unknown"}`} />
        <span class="chat-tool-name">graph_walk</span>
        <span class="walk-summary">
          {result?.isError ? "error" : walkSummary(state, playing)}
        </span>
        <span class="walk-head-end">
          {decider && (
            <span class="walk-pill" title={`${decider} judged every hop: relevance, next node, enough?`}>
              {deciderLabel(decider)}
            </span>
          )}
          {!playing && hops.length > 0 && (
            <button
              type="button"
              class="walk-btn"
              onClick={() => {
                setSelected(null);
                setPlayed(0);
              }}
              title="Play the walk again"
            >
              replay
            </button>
          )}
        </span>
      </div>
      {goal && (
        <button type="button" class="walk-goal" onClick={() => setInputOpen((o) => !o)} title="Show the call's input">
          {goal}
        </button>
      )}
      {inputOpen && <pre class="chat-tool-input">{formatJson(props.input)}</pre>}
      {(state.nodes.size > 0 || playing) && <WalkGraph state={state} selected={selected} onSelect={setSelected} />}
      {node && <WalkNodeDetail node={node} from={node.via ? state.nodes.get(node.via.from) : undefined} onOpenRun={props.onOpenRun} />}
      {result && <ToolResultView result={result} open={rawOpen} onToggle={() => setRawOpen((o) => !o)} />}
    </div>
  );
}

/** "typesafe/jev-latest" → "jev"; "anthropic/claude-haiku-4-5" → "claude-haiku-4-5". */
function deciderLabel(name: string): string {
  return (name.split("/").pop() ?? name).replace(/-latest$/, "");
}

function WalkNodeDetail({ node, from, onOpenRun }: { node: WalkNode; from?: WalkNode; onOpenRun: (workflow: string, runId: string) => void }) {
  const p = node.properties ?? {};
  const workflow = typeof p["workflow_name"] === "string" ? p["workflow_name"] : undefined;
  const runId = typeof p["run_id"] === "string" ? p["run_id"] : undefined;
  return (
    <div class="walk-detail">
      <div class="walk-detail-row">
        <span class="walk-detail-type">{node.type}</span>
        <span class="walk-detail-state">
          {node.state}
          {node.relevance !== undefined && ` · ${node.relevance.toFixed(2)}`}
        </span>
        {node.type === "StrutRun" && workflow && runId && (
          <button type="button" class="walk-btn" onClick={() => onOpenRun(workflow, runId)}>
            open run
          </button>
        )}
      </div>
      <div class="walk-detail-name">{node.name}</div>
      {node.via && (
        <div class="walk-detail-via">
          via {node.via.edge_type} ({node.via.direction}) from {from?.name ?? node.via.from}
        </div>
      )}
      {node.mergedCount > 0 && (
        <div class="walk-detail-via">
          +{node.mergedCount} like it: {[...new Set(node.merged)].slice(0, 3).join("; ")}
        </div>
      )}
    </div>
  );
}
