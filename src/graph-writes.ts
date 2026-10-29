/**
 * GRAPH WRITES, HEARD (plans/live-feeds.md §2, §3): what a run writes to the
 * graph through strut's writers, told to the run's job and kept in the
 * deployment's change feed — so a host or a page showing what the graph
 * holds reads it again when it changes, not when the job ends.
 *
 * The runner gives every run a VIEW of `services.graph` (`bindGraph`, the
 * twin of `bindPrincipal`): the backend with its `nodes` and `edges`
 * writers wrapped, so each mutating call reports what it changed when it
 * returns. A step that calls `graph/*` steps through `ctx.registry` passes
 * the same `ctx`, and so the same view: nothing for a step author to do.
 *
 * Reports are gathered per run and sent a second after the run's last
 * write (at most five after the first), and when the run ends:
 *
 *   - to the run's JOB, as `job.update { kind: "graph", id: <runId>,
 *     state: "written", detail: { writes, types, refs } }` — `detail`
 *     cumulative for the run, so an outbox replacing a pending update with
 *     a newer one loses nothing. Hive reads the card's trees again on any
 *     update for a job on a canvas card;
 *   - to the deployment's FEED (`createGraphChangeFeed`), which
 *     `graph/changes` and `GET /graph/changes` read: ids, types and time
 *     only, the latest per node or edge.
 *
 * Not heard: a write through raw Cypher (`graph.query`), a write by another
 * process (jarvis, an ingest, a host writing the database itself), and
 * strut's own bookkeeping (`QUIET`). A transaction that rolls back after a
 * write returned is reported anyway: a reader reads again and finds the
 * graph as it was.
 */

import type { JobUpdateInput } from "./jobs.js";
import { LiveFeed, type FeedRead } from "./live-feed.js";

/** One write, as the feed keeps it. */
export interface GraphChange {
  kind: "node" | "edge";
  op: "created" | "updated" | "deleted";
  /** The node's ref_id, or the edge's. */
  ref_id: string;
  at: string;
  /** A node's type. */
  node_type?: string;
  /** An edge's type and endpoints, and their types where known. */
  edge_type?: string;
  source?: string;
  target?: string;
  types?: string[];
}

/** Strut's own bookkeeping, never reported: the projector's run nodes, the
 *  claims layer (its own updates are `evidence` / `verify`) and the ontology. */
const QUIET_TYPES = new Set(["claim", "check", "evidence", "thing", "schema"]);
export const isQuietType = (t: string | undefined): boolean => !!t && (/^strut/i.test(t) || QUIET_TYPES.has(t.toLowerCase()));

/** The writes the deployment's feed keeps. */
export const GRAPH_FEED_MAX = 5_000;
/** The most a read answers. */
export const GRAPH_FEED_READ_MAX = 500;

export interface GraphChangesRead {
  cursor: string;
  reset?: true;
  more?: true;
  changes: GraphChange[];
}

export interface GraphChangeFeed {
  push(changes: readonly GraphChange[]): void;
  /** The writes after `since`, the latest per node or edge; `types` keeps
   *  a node of one of them, and an edge with an end of one of them (or
   *  whose ends could not be typed). With `wait`, held until one lands. */
  read(o?: { types?: readonly string[]; since?: string; wait?: number; limit?: number; signal?: AbortSignal }): Promise<GraphChangesRead>;
  /** Let every waiting read answer (the server closing). */
  close(): void;
}

export function createGraphChangeFeed(opts: { max?: number; gatherMs?: number } = {}): GraphChangeFeed {
  const feed = new LiveFeed<GraphChange>({ max: opts.max ?? GRAPH_FEED_MAX, keyOf: (c) => `${c.kind}:${c.ref_id}`, ...(opts.gatherMs !== undefined ? { gatherMs: opts.gatherMs } : {}) });
  return {
    push(changes) {
      for (const c of changes) feed.push(c);
    },
    async read(o = {}) {
      const types = o.types?.length ? new Set(o.types.map((t) => t.toLowerCase())) : undefined;
      const filter = types
        ? (c: GraphChange) =>
            c.kind === "node"
              ? !!c.node_type && types.has(c.node_type.toLowerCase())
              : !c.types?.length || c.types.some((t) => types.has(t.toLowerCase()))
        : undefined;
      const limit = Math.min(GRAPH_FEED_READ_MAX, o.limit && o.limit > 0 ? o.limit : GRAPH_FEED_READ_MAX);
      const read: FeedRead<GraphChange> = await feed.read({ since: o.since, wait: o.wait, limit, signal: o.signal, ...(filter ? { filter } : {}) });
      const { items, ...rest } = read;
      return { ...rest, changes: items };
    },
    close() {
      feed.wakeAll();
    },
  };
}

/** What a reporter reads a node's type with: the backend's reader. */
interface TypeReader {
  getNode(ref_id: string): Promise<{ node_type?: string | undefined } | null>;
}

export interface GraphReporter {
  note(change: Omit<GraphChange, "at">): void;
  /** Send what is gathered now (the run ending, a proposal applied). */
  flush(): Promise<void>;
}

/** A write is sent this long after the run's last one… */
export const GRAPH_REPORT_DEBOUNCE_MS = 1_000;
/** …and never later than this after the first one waiting. */
export const GRAPH_REPORT_MAX_DELAY_MS = 5_000;
/** An edge's ends looked up per send, at most (a type learned from the
 *  run's own node writes costs nothing). */
const TYPE_LOOKUPS_MAX = 50;
/** A graph update's `refs`: the run's last this-many nodes. */
const REFS_MAX = 20;

/**
 * One run's reports (or one proposal's apply): gathered, typed, then sent
 * to the job (`notify`) and the feed. Never throws, never holds a write:
 * the writer has returned before a note is taken, and a send that fails is
 * dropped with one line — a report is a notification, never the record.
 */
export function graphReporter(o: {
  /** The run that wrote: the update's `runId`, and its `id` unless `id` says otherwise. */
  runId?: string;
  /** What the update is about when it is not a run (a proposal's apply). */
  id?: string;
  job?: string;
  notify?: (job: string, update: JobUpdateInput) => void;
  feed?: GraphChangeFeed;
  reader?: TypeReader;
  debounceMs?: number;
  maxDelayMs?: number;
}): GraphReporter {
  const debounce = o.debounceMs ?? GRAPH_REPORT_DEBOUNCE_MS;
  const maxDelay = o.maxDelayMs ?? GRAPH_REPORT_MAX_DELAY_MS;
  let pending: GraphChange[] = [];
  let firstAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Node types this run learned: from its writes, and its lookups. */
  const typeOf = new Map<string, string>();
  // Cumulative for the run: what the job's `graph` update says.
  let writes = 0;
  const types: Record<string, number> = {};
  const refs: string[] = [];
  let chain: Promise<void> = Promise.resolve();

  const send = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    let lookups = 0;
    const resolve = async (ref: string | undefined): Promise<string | undefined> => {
      if (!ref) return undefined;
      if (typeOf.has(ref)) return typeOf.get(ref);
      if (!o.reader || lookups >= TYPE_LOOKUPS_MAX) return undefined;
      lookups++;
      const t = (await o.reader.getNode(ref).catch(() => null))?.node_type ?? undefined;
      if (t) typeOf.set(ref, t);
      return t;
    };
    const out: GraphChange[] = [];
    for (const c of batch) {
      if (c.kind === "node") {
        const node_type = c.node_type ?? (await resolve(c.ref_id));
        if (isQuietType(node_type)) continue;
        out.push(node_type ? { ...c, node_type } : c);
      } else {
        const ends = [await resolve(c.source), await resolve(c.target)];
        if (ends.some(isQuietType)) continue;
        const known = ends.filter((t): t is string => !!t);
        out.push(known.length ? { ...c, types: known } : c);
      }
    }
    if (out.length === 0) return;
    o.feed?.push(out);
    if (!o.job || !o.notify) return;
    writes += out.length;
    for (const c of out) {
      if (c.kind !== "node") continue;
      if (c.node_type) types[c.node_type] = (types[c.node_type] ?? 0) + 1;
      const at = refs.indexOf(c.ref_id);
      if (at >= 0) refs.splice(at, 1);
      refs.push(c.ref_id);
      if (refs.length > REFS_MAX) refs.shift();
    }
    const id = o.id ?? o.runId;
    o.notify(o.job, {
      kind: "graph",
      ...(id ? { id } : {}),
      ...(o.runId ? { runId: o.runId } : {}),
      state: "written",
      detail: { writes, types: { ...types }, refs: [...refs] },
    });
  };

  const flush = (): Promise<void> => {
    chain = chain.then(send).catch((err: unknown) => {
      console.warn(`[graph-writes] report for ${o.id ?? o.runId ?? "-"} not sent: ${err instanceof Error ? err.message : String(err)}`);
    });
    return chain;
  };

  return {
    note(change) {
      const at = new Date().toISOString();
      if (change.kind === "node" && change.node_type) typeOf.set(change.ref_id, change.node_type);
      pending.push({ ...change, at });
      const now = Date.now();
      if (!timer) firstAt = now;
      else clearTimeout(timer);
      timer = setTimeout(() => void flush(), Math.max(0, Math.min(debounce, firstAt + maxDelay - now)));
      timer.unref?.();
    },
    flush,
  };
}

// ── the view ──────────────────────────────────────────────────────────────

interface NodeWriteLike { ref_id: string; node_type?: string; outcome?: string }
interface EdgeWriteLike { ref_id: string; created?: boolean; source_ref_id: string; target_ref_id: string }
interface EdgeChangedLike { ref_id: string; edge: string; source_ref_id: string; target_ref_id: string }

const nodeOp = (outcome: string | undefined): GraphChange["op"] | null =>
  outcome === "created" || outcome === "restored" ? "created" : outcome === "updated" ? "updated" : null;

/** The node writer, each mutating call reported when it returns. A call the
 *  writer makes on itself goes to the writer, not here: no write is
 *  reported twice. */
function watchNodes<W extends object>(writer: W, r: GraphReporter, reader: TypeReader | undefined): W {
  const noteWrite = (res: NodeWriteLike | undefined) => {
    const op = nodeOp(res?.outcome);
    if (res && op) r.note({ kind: "node", op, ref_id: res.ref_id, ...(res.node_type ? { node_type: res.node_type } : {}) });
  };
  // A deleted node can no longer be read: its type is read first.
  const typeBefore = async (ref: string) => (reader ? ((await reader.getNode(ref).catch(() => null))?.node_type ?? undefined) : undefined);
  return new Proxy(writer, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = v as (...args: unknown[]) => Promise<unknown>;
      switch (prop) {
        case "write":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as NodeWriteLike;
            noteWrite(res);
            return res;
          };
        case "writeMany":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as NodeWriteLike[];
            for (const one of res ?? []) noteWrite(one);
            return res;
          };
        case "update":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as { ref_id?: string } | undefined;
            const ref = res?.ref_id ?? (typeof args[0] === "string" ? args[0] : undefined);
            if (ref) r.note({ kind: "node", op: "updated", ref_id: ref });
            return res;
          };
        case "softDelete":
        case "deleteNode":
          return async (...args: unknown[]) => {
            const ref = typeof args[0] === "string" ? args[0] : undefined;
            const node_type = ref ? await typeBefore(ref) : undefined;
            const res = await fn.apply(target, args);
            if (ref && res) r.note({ kind: "node", op: "deleted", ref_id: ref, ...(node_type ? { node_type } : {}) });
            return res;
          };
        default:
          return fn.bind(target);
      }
    },
  });
}

/** The edge writer, the same way. */
function watchEdges<W extends object>(writer: W, r: GraphReporter): W {
  const noteChanged = (op: GraphChange["op"], e: EdgeChangedLike | null | undefined) => {
    if (e) r.note({ kind: "edge", op, ref_id: e.ref_id, edge_type: e.edge, source: e.source_ref_id, target: e.target_ref_id });
  };
  const noteWritten = (edge: unknown, e: EdgeWriteLike | undefined) => {
    if (e?.created) r.note({ kind: "edge", op: "created", ref_id: e.ref_id, ...(typeof edge === "string" ? { edge_type: edge } : {}), source: e.source_ref_id, target: e.target_ref_id });
  };
  const edgeOf = (input: unknown) => (input as { edge?: unknown } | undefined)?.edge;
  return new Proxy(writer, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = v as (...args: unknown[]) => Promise<unknown>;
      switch (prop) {
        case "write":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as EdgeWriteLike;
            noteWritten(edgeOf(args[0]), res);
            return res;
          };
        case "writeMany":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as EdgeWriteLike[];
            const inputs = Array.isArray(args[0]) ? args[0] : [];
            (res ?? []).forEach((one, i) => noteWritten(edgeOf(inputs[i]), one));
            return res;
          };
        case "update":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as EdgeChangedLike;
            noteChanged("updated", res);
            return res;
          };
        case "delete":
          return async (...args: unknown[]) => {
            const res = (await fn.apply(target, args)) as EdgeChangedLike | null;
            noteChanged("deleted", res);
            return res;
          };
        case "move":
          return async (...args: unknown[]) => {
            const m = args[0] as { edge: string; direction: "forward" | "reverse" };
            const res = (await fn.apply(target, args)) as {
              moved: boolean; ref_id: string; from_ref_id: string; to_ref_id: string; edge_ref_id: string; previous_edge_ref_id: string;
            };
            if (res?.moved) {
              // `reverse` = (from)-[EDGE]->(node); `forward` = (node)-[EDGE]->(from).
              const ends = (other: string) => (m.direction === "reverse" ? { source: other, target: res.ref_id } : { source: res.ref_id, target: other });
              r.note({ kind: "edge", op: "deleted", ref_id: res.previous_edge_ref_id, edge_type: m.edge, ...ends(res.from_ref_id) });
              r.note({ kind: "edge", op: "created", ref_id: res.edge_ref_id, edge_type: m.edge, ...ends(res.to_ref_id) });
            }
            return res;
          };
        default:
          return fn.bind(target);
      }
    },
  });
}

/** A graph backend whose writers report to `r`; everything else is the
 *  backend's own. */
export function reportingGraph<G extends object>(graph: G, r: GraphReporter): G {
  const g = graph as { nodes?: object; edges?: object; reader?: TypeReader };
  return {
    ...graph,
    ...(g.nodes ? { nodes: watchNodes(g.nodes, r, g.reader) } : {}),
    ...(g.edges ? { edges: watchEdges(g.edges, r) } : {}),
  } as G;
}

/**
 * The run's view of `services.graph` (plans/live-feeds.md §2): its writes
 * reported to the run's job (through `services.jobs.notify`) and to the
 * deployment's feed (`services.graphChanges`). The bag as it is when there
 * is no graph, or nobody to tell. The consumer's bag is never mutated.
 */
export function bindGraph<TServices>(
  services: TServices,
  o: { runId?: string; id?: string; job?: string; debounceMs?: number; maxDelayMs?: number },
): { services: TServices; reporter?: GraphReporter } {
  if (services == null || typeof services !== "object") return { services };
  const bag = services as {
    graph?: object & { nodes?: object; edges?: object; reader?: TypeReader };
    graphChanges?: GraphChangeFeed;
    jobs?: { notify?: (job: string, update: JobUpdateInput) => void };
  };
  const graph = bag.graph;
  if (!graph || (!graph.nodes && !graph.edges)) return { services };
  const notify = bag.jobs?.notify ? (job: string, update: JobUpdateInput) => bag.jobs!.notify!(job, update) : undefined;
  if (!bag.graphChanges && !(o.job && notify)) return { services };
  const reporter = graphReporter({
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.id ? { id: o.id } : {}),
    ...(o.job ? { job: o.job } : {}),
    ...(notify ? { notify } : {}),
    ...(bag.graphChanges ? { feed: bag.graphChanges } : {}),
    ...(graph.reader ? { reader: graph.reader } : {}),
    ...(o.debounceMs !== undefined ? { debounceMs: o.debounceMs } : {}),
    ...(o.maxDelayMs !== undefined ? { maxDelayMs: o.maxDelayMs } : {}),
  });
  return { services: { ...(services as object), graph: reportingGraph(graph, reporter) } as TServices, reporter };
}
