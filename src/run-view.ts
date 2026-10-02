import type { RunEvent, RunSummary } from "./core.js";

/**
 * The run VIEW the builder reads (`get_run`, `meta/get-run`).
 *
 * A run's event log grows with its EXECUTION — an agent writes two events per
 * tool call, a foreach two per iteration — while what a reader can hold grows
 * with the workflow's SHAPE. So the log is folded into the step tree the
 * workflow's author already knows, one level open and everything below it
 * rolled up: an agent's thousand tool calls are one node with a status and a
 * histogram by tool. `path` zooms — that node with its payloads, its children
 * listed one level deep. Errors come first, the deepest ones, each with the
 * few siblings that ran before it. A char budget tightens lists and previews
 * in a fixed order, and every cut says what it dropped and how to open it
 * (the model reads its contract in the tool RESULT, as the ledger does).
 *
 * Path grammar (src/runner.ts, the agent step): `wf/step`, a subflow's
 * children `wf/sub/child`, an iteration `wf/each#3` (its body's events sit on
 * the iteration path), an agent's tool calls `wf/agent/042-bash`, a fallback
 * `wf/step/onError`. The web UI's run drill reads the same grammar.
 */

export type NodeStatus =
  | "success"
  | "error"
  | "skipped"
  | "replayed"
  /** No `step.end` of its own, but its `onError` fallback succeeded — the
   *  runner returns the fallback's output without ending the step. */
  | "recovered"
  | "cancelled"
  | "running"
  /** Started, never ended, and the run is over: cut off (crash, cancel). */
  | "incomplete";

const TERMINAL = new Set<NodeStatus>(["success", "error", "skipped", "replayed", "recovered", "cancelled"]);

export interface RunViewOptions {
  /** Zoom: the node at this event path (`wf/agent`, `wf/items#3`, `wf/agent/042-bash`). */
  path?: string;
  /** Logged input/output payloads on the nodes in view (cut to the budget). */
  fullEvents?: boolean;
  /** The result's char budget (its JSON): lists and previews tighten to fit. */
  maxChars?: number;
}

export const DEFAULT_MAX_CHARS = 20_000;

/** One node of the folded log — every path that has an event, plus the
 *  ancestors those paths imply. */
export interface RunNode {
  id: string;
  path: string;
  parent?: RunNode;
  stepType?: string;
  status?: NodeStatus;
  started?: string;
  /** The newest event at or below this node. */
  lastTs?: string;
  durationMs?: number;
  retries: number;
  iteration?: number;
  error?: { message: string; stack?: string };
  input?: unknown;
  output?: unknown;
  /** Order of first appearance in the log. */
  order: number;
  children: Map<string, RunNode>;
}

/** `wf/each#3/child` → `["wf", "each", "#3", "child"]`: an iteration is a
 *  child of its container. */
export function splitPath(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    const hash = seg.indexOf("#");
    if (hash > 0) {
      out.push(seg.slice(0, hash), seg.slice(hash));
    } else {
      out.push(seg);
    }
  }
  return out;
}

function newNode(id: string, path: string, order: number, parent?: RunNode): RunNode {
  return { id, path, parent, retries: 0, order, children: new Map() };
}

/** Fold a log into its tree. The root is the run itself (its `run.*` events
 *  sit on the workflow name). */
export function foldRun(events: RunEvent[]): RunNode {
  const root = newNode(events[0] ? splitPath(events[0].path)[0]! : "", events[0] ? splitPath(events[0].path)[0]! : "", 0);
  let order = 0;
  for (const e of events) {
    const segs = splitPath(e.path);
    let node = root;
    let path = segs[0]!;
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i]!;
      path += seg.startsWith("#") ? seg : `/${seg}`;
      let child = node.children.get(seg);
      if (!child) {
        child = newNode(seg, path, ++order, node);
        node.children.set(seg, child);
      }
      node = child;
    }
    for (let n: RunNode | undefined = node; n; n = n.parent) n.lastTs = e.ts;
    apply(node, e);
  }
  const runEnded = root.status !== undefined && TERMINAL.has(root.status);
  settle(root, runEnded);
  return root;
}

function apply(node: RunNode, e: RunEvent): void {
  if (e.stepType) node.stepType = e.stepType;
  if (e.iteration != null && e.type !== "step.retry") node.iteration = e.iteration;
  switch (e.type) {
    case "step.start":
    case "run.start":
      node.started = e.ts;
      node.status = "running";
      if (e.input !== undefined) node.input = e.input;
      break;
    case "step.retry":
      node.retries++;
      node.status = "running";
      break;
    case "step.end":
    case "run.end":
      node.status = "success";
      if (e.output !== undefined) node.output = e.output;
      if (e.durationMs != null) node.durationMs = e.durationMs;
      break;
    case "step.replayed":
      node.status = "replayed";
      if (e.output !== undefined) node.output = e.output;
      break;
    case "step.error":
    case "run.error":
      node.status = "error";
      node.error = e.error ?? { message: "unknown" };
      break;
    case "step.skipped":
      node.status = "skipped";
      break;
    case "run.cancelled":
      node.status = "cancelled";
      break;
    default:
      // run.paused / run.resumed / run.cancelling: markers, no status.
      break;
  }
}

/** Resolve what the log left open: a step without an end whose `onError`
 *  fallback succeeded recovered; one still open when the run is over was cut
 *  off; a path with events below it and none of its own takes its children's. */
function settle(node: RunNode, runEnded: boolean): void {
  for (const c of node.children.values()) settle(c, runEnded);
  if (node.status === undefined) {
    const kids = [...node.children.values()];
    node.status = kids.some((k) => k.status === "error")
      ? "error"
      : kids.some((k) => k.status === "running")
        ? "running"
        : kids.length === 0 || runEnded
          ? "incomplete"
          : "running";
  }
  if (node.status === "running") {
    const fallback = node.children.get("onError");
    if (fallback && (fallback.status === "success" || fallback.status === "replayed")) node.status = "recovered";
    else if (runEnded) node.status = "incomplete";
  }
}

export function findNode(root: RunNode, path: string): RunNode | undefined {
  const segs = splitPath(path);
  if (segs[0] !== root.id) return undefined;
  let node: RunNode | undefined = root;
  for (let i = 1; i < segs.length && node; i++) node = node.children.get(segs[i]!);
  return node;
}

// ── The view ────────────────────────────────────────────────────────────────

interface Limits {
  /** Listed children per level; beyond it the head, the tail and every error. */
  list: number;
  /** Siblings shown before an error. */
  before: number;
  /** Last child ids in a rollup. */
  last: number;
  byType: boolean;
  /** Payload preview chars on the focus node, on listed nodes (0 = none), on the summary. */
  focusChars: number;
  listedChars: number;
  summaryChars: number;
  errors: number;
}

/** Tightened in order until the view fits. */
const LEVELS: Limits[] = [
  { list: 40, before: 3, last: 5, byType: true, focusChars: 2000, listedChars: 0, summaryChars: 600, errors: 15 },
  { list: 16, before: 2, last: 3, byType: true, focusChars: 1200, listedChars: 0, summaryChars: 400, errors: 10 },
  { list: 8, before: 1, last: 0, byType: true, focusChars: 600, listedChars: 0, summaryChars: 240, errors: 6 },
  { list: 4, before: 0, last: 0, byType: false, focusChars: 300, listedChars: 0, summaryChars: 120, errors: 3 },
];
/** `fullEvents`: the same shape with payloads on every node in view. */
const FULL_LEVELS: Limits[] = [
  { ...LEVELS[0]!, focusChars: 20_000, listedChars: 1500, summaryChars: 8000 },
  { ...LEVELS[1]!, focusChars: 8000, listedChars: 600, summaryChars: 4000 },
  { ...LEVELS[2]!, focusChars: 3000, listedChars: 300, summaryChars: 2000 },
  { ...LEVELS[3]!, focusChars: 1000, listedChars: 150, summaryChars: 800 },
];

export interface NodeView {
  id: string;
  path: string;
  stepType?: string;
  status: NodeStatus;
  iteration?: number;
  durationMs?: number;
  /** For a node still open: from its start to the newest event below it. */
  elapsedMs?: number;
  retries?: number;
  error?: string;
  /** The focus node's error stack, previewed. */
  stack?: string;
  input?: unknown;
  output?: unknown;
  children?: Rollup;
}

/** What is below a node, without listing it. */
export interface Rollup {
  /** Direct children. */
  count: number;
  /** Every node below, when deeper than one level. */
  nodes?: number;
  status: Partial<Record<NodeStatus, number>>;
  /** Direct children by step type: an agent's tool histogram. */
  byType?: Record<string, { n: number; errors: number; ms: number }>;
  /** The last few child ids — what a container was doing at the end. */
  last?: string[];
}

/** A run of children left out of a long list. */
export interface Gap {
  omitted: number;
  from: string;
  to: string;
}

export interface ErrorView {
  path: string;
  stepType?: string;
  message: string;
  retries?: number;
  /** The siblings that ran before it, newest last. */
  before?: { id: string; stepType?: string; status: NodeStatus; durationMs?: number }[];
}

export interface RunView {
  workflow: string;
  runId: string;
  status: string;
  summary: Record<string, unknown>;
  /** The deepest errors, the run's failure chain first. */
  errors?: ErrorView[];
  /** When `errors` is capped: how many there are. */
  errorCount?: number;
  /** The zoomed node, with its payloads. */
  focus?: NodeView;
  /** The level in view: the run's top-level steps, or the focus node's children. */
  steps: (NodeView | Gap)[];
  /** Present when anything was cut: how to open what was left out. */
  hint?: string;
}

export function buildRunView(
  workflow: string,
  runId: string,
  events: RunEvent[],
  summary: RunSummary | null,
  opts: RunViewOptions = {},
): RunView | { error: string } {
  const root = foldRun(events);
  if (summary && !TERMINAL.has(root.status!)) settle(root, true);
  let focus: RunNode | undefined;
  if (opts.path && opts.path !== root.path) {
    focus = findNode(root, opts.path);
    if (!focus) {
      const top = [...root.children.values()].slice(0, 30).map((c) => c.path);
      return {
        error: `No events at path "${opts.path}" in run ${runId} of "${workflow}". Top-level paths: ${top.join(", ") || "(none)"}.`,
      };
    }
  }
  const levels = opts.fullEvents ? FULL_LEVELS : LEVELS;
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let view: RunView | undefined;
  let cuts = 0;
  let tightened = false;
  for (let i = 0; i < levels.length; i++) {
    const r = render(workflow, runId, root, summary, focus, levels[i]!);
    view = r.view;
    cuts = r.cuts;
    tightened = i > 0;
    if (JSON.stringify(view).length <= max) break;
  }
  if (cuts > 0 || tightened) {
    view!.hint =
      (tightened ? `The view was tightened to fit ${max} chars. ` : "Some previews or lists are cut. ") +
      `get_run with path: "<path>" opens one node with its payloads and its children listed; ` +
      `fullEvents: true adds payloads to every node in view; search_runs greps the full payloads of recent runs.`;
  }
  return view!;
}

function render(
  workflow: string,
  runId: string,
  root: RunNode,
  summary: RunSummary | null,
  focus: RunNode | undefined,
  limits: Limits,
): { view: RunView; cuts: number } {
  const counter = { cuts: 0 };
  const errors = errorViews(root, limits);
  if (errors.total > errors.items.length) counter.cuts++;
  const level = focus ?? root;
  const steps = listChildren(level, limits, counter);
  const view: RunView = {
    workflow,
    runId,
    status: summary?.status ?? root.status ?? "running",
    summary: summaryView(summary, root, limits.summaryChars, counter),
    ...(errors.items.length ? { errors: errors.items } : {}),
    ...(errors.total > errors.items.length ? { errorCount: errors.total } : {}),
    ...(focus ? { focus: nodeView(focus, limits, limits.focusChars, counter, true) } : {}),
    steps,
  };
  return { view, cuts: counter.cuts };
}

function summaryView(
  summary: RunSummary | null,
  root: RunNode,
  chars: number,
  counter: { cuts: number },
): Record<string, unknown> {
  if (!summary) {
    return {
      partial: true,
      note: "no summary yet: the run is still executing, or was cut off before it finalized",
      ...(root.started ? { startedAt: root.started } : {}),
      ...(root.lastTs ? { lastEventAt: root.lastTs } : {}),
      ...(root.input !== undefined ? { input: preview(root.input, chars, counter) } : {}),
    };
  }
  return {
    status: summary.status,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: summary.durationMs,
    input: preview(summary.input, chars, counter),
    ...(summary.output !== undefined ? { output: preview(summary.output, chars, counter) } : {}),
    ...(summary.error ? { error: summary.error.message } : {}),
    ...(summary.actor ? { actor: summary.actor } : {}),
    ...(summary.principal && summary.principal !== summary.actor ? { principal: summary.principal } : {}),
    ...(summary.job ? { job: summary.job } : {}),
    ...(summary.automation ? { automation: summary.automation } : {}),
  };
}

/** A payload as the model sees it: as is when it fits, else its JSON head
 *  and how much there was. */
function preview(v: unknown, max: number, counter: { cuts: number }): unknown {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return undefined;
  if (s.length <= max) return v;
  counter.cuts++;
  return `${s.slice(0, max)}…[cut: ${s.length} chars]`;
}

function nodeView(node: RunNode, limits: Limits, payloadChars: number, counter: { cuts: number }, isFocus = false): NodeView {
  const open = node.status === "running" || node.status === "incomplete";
  const elapsed = open && node.started && node.lastTs ? Date.parse(node.lastTs) - Date.parse(node.started) : undefined;
  const v: NodeView = {
    id: node.id,
    path: node.path,
    ...(node.stepType ? { stepType: node.stepType } : {}),
    status: node.status ?? "running",
    ...(node.iteration != null ? { iteration: node.iteration } : {}),
    ...(node.durationMs != null ? { durationMs: node.durationMs } : {}),
    ...(elapsed != null && elapsed >= 0 ? { elapsedMs: elapsed } : {}),
    ...(node.retries ? { retries: node.retries } : {}),
    ...(node.error ? { error: node.error.message } : {}),
    ...(isFocus && node.error?.stack ? { stack: preview(node.error.stack, payloadChars, counter) as string } : {}),
  };
  if (payloadChars > 0) {
    if (node.input !== undefined) v.input = preview(node.input, payloadChars, counter);
    if (node.output !== undefined) v.output = preview(node.output, payloadChars, counter);
  }
  if (node.children.size > 0) v.children = rollup(node, limits);
  return v;
}

function countBelow(node: RunNode): number {
  let n = 0;
  for (const c of node.children.values()) n += 1 + countBelow(c);
  return n;
}

function rollup(node: RunNode, limits: Limits): Rollup {
  const kids = [...node.children.values()];
  const status: Partial<Record<NodeStatus, number>> = {};
  const byType: Record<string, { n: number; errors: number; ms: number }> = {};
  for (const k of kids) {
    const s = k.status ?? "running";
    status[s] = (status[s] ?? 0) + 1;
    const t = k.stepType ?? "?";
    const b = (byType[t] ??= { n: 0, errors: 0, ms: 0 });
    b.n++;
    if (s === "error") b.errors++;
    b.ms += k.durationMs ?? 0;
  }
  const below = countBelow(node);
  return {
    count: kids.length,
    ...(below > kids.length ? { nodes: below } : {}),
    status,
    ...(limits.byType ? { byType } : {}),
    ...(limits.last > 0 && kids.length > limits.last ? { last: kids.slice(-limits.last).map((k) => k.id) } : {}),
  };
}

/** A level's children: all of them up to the limit; beyond it the head, the
 *  tail and every error, with a gap marker where a stretch was left out. */
function listChildren(node: RunNode, limits: Limits, counter: { cuts: number }): (NodeView | Gap)[] {
  const kids = [...node.children.values()];
  const chars = limits.listedChars;
  if (kids.length <= limits.list) return kids.map((k) => nodeView(k, limits, chars, counter));
  const head = Math.ceil(limits.list / 2);
  const tail = Math.floor(limits.list / 2);
  const keep = (i: number) => i < head || i >= kids.length - tail || kids[i]!.status === "error";
  const out: (NodeView | Gap)[] = [];
  let gap: Gap | undefined;
  kids.forEach((k, i) => {
    if (keep(i)) {
      if (gap) {
        out.push(gap);
        gap = undefined;
      }
      out.push(nodeView(k, limits, chars, counter));
    } else if (gap) {
      gap.omitted++;
      gap.to = k.id;
    } else {
      gap = { omitted: 1, from: k.id, to: k.id };
    }
  });
  if (gap) out.push(gap);
  counter.cuts++;
  return out;
}

/** The deepest errors (an error whose descendant also errored is the
 *  propagation, not the cause), the run's failure chain first — every
 *  ancestor errored too — then in log order. */
function errorViews(root: RunNode, limits: Limits): { items: ErrorView[]; total: number } {
  const all: RunNode[] = [];
  const walk = (n: RunNode) => {
    if (n !== root && n.status === "error") all.push(n);
    for (const c of n.children.values()) walk(c);
  };
  walk(root);
  const hasErrorBelow = (n: RunNode): boolean => [...n.children.values()].some((c) => c.status === "error" || hasErrorBelow(c));
  const onChain = (n: RunNode): boolean => {
    for (let p = n.parent; p && p !== root; p = p.parent) if (p.status !== "error") return false;
    return true;
  };
  const deepest = all.filter((n) => !hasErrorBelow(n));
  deepest.sort((a, b) => Number(onChain(b)) - Number(onChain(a)) || a.order - b.order);
  const items = deepest.slice(0, limits.errors).map((n): ErrorView => {
    const siblings = n.parent ? [...n.parent.children.values()] : [];
    const at = siblings.indexOf(n);
    const before = limits.before > 0 ? siblings.slice(Math.max(0, at - limits.before), at) : [];
    return {
      path: n.path,
      ...(n.stepType ? { stepType: n.stepType } : {}),
      message: n.error?.message ?? "unknown",
      ...(n.retries ? { retries: n.retries } : {}),
      ...(before.length
        ? {
            before: before.map((s) => ({
              id: s.id,
              ...(s.stepType ? { stepType: s.stepType } : {}),
              status: s.status ?? "running",
              ...(s.durationMs != null ? { durationMs: s.durationMs } : {}),
            })),
          }
        : {}),
    };
  });
  return { items, total: deepest.length };
}
