import { tool } from "ai";
import type { StepContext } from "../core.js";
import type { Evaluate } from "../evaluate.js";
import { runWalk, walkInput, type WalkReader, type WalkOutput } from "../steps/lib/graph/walk.js";

/**
 * `graph_walk` — the chat's door to `graph/walk` (plans/walk-chat-demo.md §2).
 *
 * The walk reports each hop through `ctx.emit` (a `walk:hop` step.start with
 * what the hop discovered, a step.end with its verdicts). `execute` is an
 * async generator bridging that callback: every hop event is yielded as a
 * PRELIMINARY result (`{ status: "walking", event }` — one event, not the
 * accumulated state; the client folds them), and the last yield is the
 * final one (`{ status: "done", … }`). Only the final result reaches the
 * model's messages, and `toModelOutput` cuts it to what an answer is built
 * from: the goal, why the walk stopped, and the kept nodes.
 */

/** A kept node's string properties, as the model reads them. */
const MODEL_PROPERTY_MAX = 600;

export type WalkHopEvent = {
  type: "step.start" | "step.end" | "step.error";
  path: string;
  stepType: "walk:hop";
  iteration: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string };
};

/** `decider`: the model that judged the walk, e.g. "typesafe/jev-latest". */
export type WalkDone = { status: "done"; decider?: string } & Omit<WalkOutput, "hops">;
export type WalkProgress = { status: "start"; decider: string } | { status: "walking"; event: WalkHopEvent } | WalkDone;

export interface WalkToolDeps {
  reader: WalkReader;
  /** The decider, resolved per call (jev or the deployment's model) and its
   *  name for the UI; tests inject a scripted one. */
  evaluate: (opts: { model?: string; abortSignal?: AbortSignal }) => Promise<{ evaluate: Evaluate; name: string }>;
}

const inputSchema = walkInput.pick({ goal: true, query: true, start: true, maxHops: true, maxNodes: true, model: true });

/** Run the walk, yielding each hop event as it is emitted, then the result. */
export async function* walkProgress(
  cfg: Parameters<typeof runWalk>[0],
  deps: { reader: WalkReader; evaluate: Evaluate },
  abortSignal?: AbortSignal,
): AsyncGenerator<WalkProgress> {
  const queue: WalkHopEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let result: WalkOutput | undefined;
  let error: unknown;
  // `path` enables the walk's emit; the checkpoint makes a cancelled chat
  // turn stop the walk between hops.
  const ctx = {
    path: "graph_walk",
    emit: async (e: WalkHopEvent) => {
      queue.push(e);
      wake?.();
    },
    control: { checkpoint: async () => abortSignal?.throwIfAborted() },
  } as unknown as StepContext;
  runWalk(cfg, { ...deps, ctx })
    .then((r) => (result = r), (e) => (error = e))
    .finally(() => {
      finished = true;
      wake?.();
    });
  for (;;) {
    const e = queue.shift();
    if (e) {
      yield { status: "walking", event: e };
      continue;
    }
    if (finished) break;
    await new Promise<void>((r) => (wake = r));
    wake = undefined;
  }
  if (error) throw error;
  const { hops: _hops, ...rest } = result!;
  yield { status: "done", ...rest };
}

const clip = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > MODEL_PROPERTY_MAX ? v.slice(0, MODEL_PROPERTY_MAX) + "…" : v;
  if (Array.isArray(v)) return v.map(clip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
  return v;
};

/** What the model reads: no hop trace, no per-candidate verdicts, no usage. */
export function walkForModel(out: WalkProgress): unknown {
  if (out.status !== "done") return out; // never reached: preliminary results stay out of the messages
  return {
    goal: out.goal,
    stopped: out.stopped,
    ...(out.decider ? { decider: out.decider } : {}),
    nodes: out.nodes.map((n) => ({
      ref_id: n.ref_id,
      node_type: n.node_type,
      name: n.name,
      relevance: n.relevance,
      ...(n.via ? { via: `${n.via.edge_type} (${n.via.direction}) from ${n.via.from}` } : {}),
      properties: clip(n.properties),
      ...(n.merged?.length ? { merged: n.merged.length, merged_names: [...new Set(n.merged.map((m) => m.name))].slice(0, 5) } : {}),
    })),
  };
}

export function graphWalkTool(deps: WalkToolDeps) {
  return tool({
    description:
      "Walk the strut knowledge graph to gather evidence for a question, then answer from what it returns. Use it for questions about how a workflow " +
      "or step BEHAVES — does it work, why do its runs fail, what do its claims say and what supports or refutes them. Set `goal` to the user's " +
      "question and `query` to the workflow or step name (the walk seeds from a graph search on it). A small decision model walks hop by hop and " +
      "keeps what is relevant; the user watches the walk as a live graph. Returns { goal, stopped, nodes } — the kept nodes, most relevant first " +
      "(workflow versions, runs, claims, checks, evidence: 'supports (…)'/'refutes (…)' evidence names lead with the verdict). Cite node names.",
    inputSchema,
    async *execute({ goal, query, start, maxHops, maxNodes, model }, { abortSignal }): AsyncGenerator<WalkProgress> {
      if (!start?.length && !query?.trim()) throw new Error("graph_walk needs `query` (a workflow or step name) or `start` (ref_ids)");
      const { evaluate, name } = await deps.evaluate({ model, abortSignal });
      // First out, so the UI names the decider before the first hop lands.
      yield { status: "start", decider: name };
      for await (const p of walkProgress({ goal, query, start, maxHops, maxNodes, threshold: 0.7 }, { reader: deps.reader, evaluate }, abortSignal)) {
        yield p.status === "done" ? { ...p, decider: name } : p;
      }
    },
    toModelOutput: ({ output }) => ({ type: "json", value: walkForModel(output) as any }),
  });
}
