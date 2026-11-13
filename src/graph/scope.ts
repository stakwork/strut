/**
 * Who may read what (plans/graph-memory-plan.md step 6): one check under
 * every read tool. Each reader has a list, set by the host — the
 * namespaces it may read and the domains it never sees — and the backend
 * a reader is handed carries a `GraphReader` held to that list
 * (`withScope`, both readers), so a tool built on it cannot skip the check.
 *
 * The readers (`ReaderKind`):
 *   - `assistant` — the person's assistant: an agent's tool call, not
 *     AI-authored, whose run's workflow and frame's workflow are both in
 *     `assistant.workflows`, the frame sealed (B's rule, strut#385);
 *   - `builder` — the chat builder's `graph_query`, `graph_get`, `graph_walk`;
 *   - `jobs` — every other step, and `ctx.services.graph` itself;
 *   - `apps` — an app's calls (`ctx.app`);
 *   - `peers` — another strut on `/graph/*`;
 *   - `ui` — a person's credential on `/graph/*`.
 *
 * Opt-in: a host that sets no `graphReaders` runs as before, every reader
 * reading everything, on both engines. Once it sets them, a reader it
 * leaves out reads nothing. A raw query (graph/query, the builder's
 * `graph_query`, `services.graph.query`) is refused unless the reader can
 * read every namespace the graph holds and has no domain filter: its rows
 * carry nothing to filter by.
 *
 * Neo4j edges hold no namespace, so there an edge is seen when both its
 * ends are; on Ladybug its own namespace must be in the list too.
 *
 * No runtime imports: the steps and the runner load this beside `graphCtx`.
 */
import type { GraphBackend } from "./backend.js";
import type { Params, Row } from "./engine.js";
import { branchedNamespace, isBranchNamespace, type GraphReader, type ReadScope } from "./search.js";

export const READER_KINDS = ["assistant", "builder", "jobs", "apps", "peers", "ui"] as const;
export type ReaderKind = (typeof READER_KINDS)[number];

/** Every namespace, in a list. */
export const ALL_NAMESPACES = "*";

/** One reader's list. `namespaces` may hold `"*"`; `default` means the
 *  backend's own namespace. */
export interface ReaderList {
  namespaces: string[];
  exclude_domains?: string[];
}

/** `StrutOptions.graphReaders` / `STRUT_HOST_CONFIG.graphReaders`. */
export type GraphReaders = Partial<Record<Exclude<ReaderKind, "assistant">, ReaderList>> & {
  assistant?: ReaderList & { workflows: string[] };
};

/** Reads nothing: a reader the host left out. */
const NOTHING: ReaderList = { namespaces: [] };

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Validate `graphReaders`. A malformed one throws (it fails the boot): read
 *  as "no lists" it would open everything it was written to close. */
export function parseGraphReaders(raw: unknown, where = "graphReaders"): GraphReaders {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object of reader lists`);
  const out: GraphReaders = {};
  for (const [kind, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(READER_KINDS as readonly string[]).includes(kind)) throw new Error(`${where}: unknown reader "${kind}" (one of ${READER_KINDS.join(", ")})`);
    const l = v as Record<string, unknown> | null;
    const shape = kind === "assistant" ? "{ workflows: string[], namespaces: string[], exclude_domains?: string[] }" : "{ namespaces: string[], exclude_domains?: string[] }";
    if (
      !l || typeof l !== "object" || !isStrings(l["namespaces"]) ||
      (l["exclude_domains"] !== undefined && !isStrings(l["exclude_domains"])) ||
      (kind === "assistant" && !isStrings(l["workflows"]))
    ) {
      throw new Error(`${where}.${kind} must be ${shape}`);
    }
    const list: ReaderList = {
      namespaces: (l["namespaces"] as string[]).map((n) => n.trim().toLowerCase()),
      ...(l["exclude_domains"] ? { exclude_domains: (l["exclude_domains"] as string[]).map((d) => d.trim().toLowerCase()) } : {}),
    };
    if (kind === "assistant") out.assistant = { ...list, workflows: l["workflows"] as string[] };
    else out[kind as Exclude<ReaderKind, "assistant">] = list;
  }
  return out;
}

/** The list a reader gets; undefined when the host set no `graphReaders`. */
export function listFor(readers: GraphReaders | undefined, kind: ReaderKind): ReaderList | undefined {
  if (!readers) return undefined;
  return readers[kind] ?? NOTHING;
}

/** What a step context is, as a reader. */
export interface ReaderCtx {
  agentTool?: boolean;
  aiAuthored?: boolean;
  app?: unknown;
  workflow?: string;
  path?: string;
  frame?: { workflow: string; sealed?: boolean };
}

export function readerKindOf(ctx: ReaderCtx | undefined, readers: GraphReaders | undefined): ReaderKind {
  if (ctx?.app) return "apps";
  const listed = readers?.assistant?.workflows ?? [];
  const run = ctx?.workflow ?? ctx?.path?.split("/")[0];
  if (
    ctx?.agentTool && !ctx.aiAuthored && run && listed.includes(run) &&
    ctx.frame?.sealed && listed.includes(ctx.frame.workflow)
  ) {
    return "assistant";
  }
  return "jobs";
}

/** What one call asks for on top of its reader's list (plans step 4): it
 *  can only narrow the list, never widen it. */
export interface Narrowing {
  exclude_domains?: string[];
  /** One namespace (a walk's): on Ladybug only, so Neo4j walks as before. */
  namespace?: string;
}

export function narrowed(list: ReaderList | undefined, n: Narrowing = {}): ReaderList | undefined {
  if (!n.exclude_domains?.length && n.namespace === undefined) return list;
  const base = list ?? { namespaces: [ALL_NAMESPACES] };
  const out: ReaderList = { ...base };
  if (n.exclude_domains?.length) out.exclude_domains = [...new Set([...(base.exclude_domains ?? []), ...n.exclude_domains.map((d) => d.trim().toLowerCase())])];
  if (n.namespace !== undefined) {
    const ns = n.namespace.trim().toLowerCase();
    out.namespaces = base.namespaces.includes(ALL_NAMESPACES) || base.namespaces.includes(ns) ? [ns] : [];
  }
  return out;
}

/** A list as the reader applies it: `default` as the backend's own
 *  namespace, `"*"` as no namespace filter. Undefined reads everything. On
 *  a Concept branch (`branch`, its namespace) the Concepts are its: a list
 *  that reads the backend's own namespace reads the branch too. */
function readScope(list: ReaderList | undefined, own: string, branch?: string): ReadScope | undefined {
  if (!list) return branch ? { concepts: branch } : undefined;
  const all = list.namespaces.includes(ALL_NAMESPACES);
  if (all && !list.exclude_domains?.length && !branch) return undefined;
  const namespaces = all ? undefined : [...new Set(list.namespaces.map((n) => (n === "default" ? own : n)))];
  if (branch && namespaces?.includes(own)) namespaces.push(branch);
  return {
    ...(namespaces ? { namespaces } : {}),
    ...(list.exclude_domains?.length ? { exclude_domains: list.exclude_domains } : {}),
    ...(branch ? { concepts: branch } : {}),
  };
}

/** What a view and a scoped backend carry, under a symbol so the spreads
 *  that wrap a backend (`graph-writes.ts` `reportingGraph`) keep it. */
const SCOPE = Symbol.for("strut.graph.scope");
interface ScopeInfo {
  readers: GraphReaders | undefined;
  /** The backend's own reader and query, unscoped. */
  reader: GraphReader;
  query: GraphBackend["query"];
  /** The reader this view is for, when it is pinned to one (the builder). */
  kind?: ReaderKind;
  /** The list this backend is held to (a scoped backend). */
  list?: ReaderList;
  /** A run on a Concept branch (src/branches.ts): its namespace. */
  branch?: string;
}
const infoOf = (g: unknown): ScopeInfo | undefined => (g && typeof g === "object" ? ((g as Record<symbol, unknown>)[SCOPE] as ScopeInfo | undefined) : undefined);

/** The unscoped reader behind a view, for strut's own bookkeeping (the
 *  change feed's types), never for a caller's reads. */
export function fullReaderOf(g: unknown): GraphReader | undefined {
  return infoOf(g)?.reader;
}

/** `target` carrying `from`'s reader lists, its unscoped raw query replaced
 *  by `query`: a view that keeps every list `from` is held to while it
 *  reads through a query of its own (a public tool's read-only one,
 *  src/public-tools.ts). `target` as it is when `from` carries none. */
export function carryScope<T extends object>(from: object, target: T, query: GraphBackend["query"]): T {
  const info = infoOf(from);
  return info ? ({ ...target, [SCOPE]: { ...info, query } } as T) : target;
}

/** Reads everything: a branch view's list when the host set none. */
const EVERYTHING: ReaderList = { namespaces: [ALL_NAMESPACES] };

/** A scoped backend's list and its unscoped query, for a read that applies
 *  the list itself (graph/find: one type, one namespace). A branch view with
 *  no list is held to reading everything, and to its branch
 *  (`branchedNamespaceOf`). */
export function boundsOf(b: object): { list: ReaderList; query: GraphBackend["query"] } | undefined {
  const info = infoOf(b);
  return info?.list || info?.branch ? { list: info.list ?? EVERYTHING, query: info.query } : undefined;
}

/** The Concept branch a view reads and writes the Concepts of (its
 *  namespace), when it is a run's on one (`withBranch`). */
export function branchOf(b: unknown): string | undefined {
  return infoOf(b)?.branch;
}

/** The namespace a read of ONE type reads through `b` (graph/find,
 *  resolve): on a branch, a Concept asked in the backend's own namespace is
 *  the branch's (`branchedNamespace`). As asked off a branch. */
export function branchedNamespaceOf(b: object, type: string, ns: string): string {
  const branch = infoOf(b)?.branch;
  return branch ? (branchedNamespace({ concepts: branch }, type, ns, (b as { namespace: string }).namespace) ?? ns) : ns;
}

/** Whether a node of `type` in `ns` is one `b` reads, as its reader's
 *  branch rule has it: on a branch, a node is a Concept exactly when it is
 *  in the branch's namespace. Always true off a branch. */
export function onBranchSide(b: object, type: string, ns: string): boolean {
  const branch = infoOf(b)?.branch;
  return !branch || (type.trim().toLowerCase() === "concept") === (ns === branch);
}

/** Whether a list reads a namespace (`own`: the backend's, for `default`). */
export function readsNamespace(list: ReaderList, ns: string, own: string): boolean {
  return list.namespaces.some((n) => n === ALL_NAMESPACES || (n === "default" ? own : n) === ns);
}

/** Whether a list hides a type, by its schema's `Domain_<d>` labels. */
export function hidesType(list: ReaderList, domainLabels: readonly string[]): boolean {
  const hidden = new Set((list.exclude_domains ?? []).map((d) => `domain_${d}`));
  return domainLabels.some((l) => hidden.has(l.toLowerCase()));
}

/** A refusal, as a `GraphReadError` with code `REFUSED` reads (duck-typed
 *  on `name`, as `graphErrorCode` does), with no runtime import of it. */
export class ScopeRefused extends Error {
  readonly code = "REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "GraphReadError";
  }
}

export class RawQueryRefused extends ScopeRefused {
  constructor() {
    super("raw graph queries are off for this reader: it may not read every namespace in the graph — use the typed reads (graph/graph-search, graph/graph-get, graph/graph-neighbors, graph/find)");
  }
}

/** Every namespace the graph holds: the backend's own, and the rest. */
async function graphNamespaces(reader: GraphReader, own: string): Promise<string[]> {
  return [...new Set([own, ...(await reader.listNamespaces())])];
}

/** Whether a list may run a raw query on this graph. A Concept branch's
 *  namespace (src/branches.ts) holds copies of the graph's own pages: it
 *  counts as read by a list that reads the own namespace, and against one
 *  that does not. */
export async function mayQueryRaw(list: ReaderList | undefined, reader: GraphReader, own: string): Promise<boolean> {
  if (!list) return true;
  if (list.exclude_domains?.length) return false;
  if (list.namespaces.includes(ALL_NAMESPACES)) return true;
  const mine = new Set(list.namespaces.map((n) => (n === "default" ? own : n)));
  return (await graphNamespaces(reader, own)).every((ns) => mine.has(ns) || (isBranchNamespace(ns) && mine.has(own)));
}

/** A run on a Concept branch reads the Concepts of its branch alone: raw
 *  rows carry nothing to hold to that. */
export class BranchRawQueryRefused extends ScopeRefused {
  constructor() {
    super("raw graph queries are off in a run on a Concept branch: its Concepts are the branch's, and a raw query would read the live tree — use the typed reads (graph/graph-search, graph/graph-get, graph/graph-neighbors, graph/find)");
  }
}

/** Throw `RawQueryRefused` when the backend's list may not run raw queries
 *  (`readQuery` and every view's `query` call it), and on a branch. */
export async function assertRawQuery(b: object): Promise<void> {
  const info = infoOf(b);
  if (info?.branch) throw new BranchRawQueryRefused();
  if (!info?.list) return;
  const own = (b as { namespace: string }).namespace;
  if (!(await mayQueryRaw(info.list, info.reader, own))) throw new RawQueryRefused();
}

/** The backend held to one list: its reader scoped, its raw query gated.
 *  Undefined `list` (no `graphReaders`) is the backend as it is. */
export function scopedBackend<B extends GraphBackend>(b: B, list: ReaderList | undefined): B {
  const info = infoOf(b);
  const reader = info?.reader ?? b.reader;
  const query = info?.query ?? b.query.bind(b);
  const branch = info?.branch;
  if (!list && !branch) return b;
  const scope = readScope(list, b.namespace, branch);
  if (scope && !reader.withScope) throw new ScopeRefused("this graph's reader cannot apply reader lists");
  const scoped: ScopeInfo = { readers: info?.readers, reader, query, ...(list ? { list } : {}), ...(info?.kind ? { kind: info.kind } : {}), ...(branch ? { branch } : {}) };
  const out = {
    ...b,
    reader: scope ? reader.withScope!(scope) : reader,
    async query(cypher: string, params?: Params): Promise<Row[]> {
      if (branch) throw new BranchRawQueryRefused();
      if (list && !(await mayQueryRaw(list, reader, b.namespace))) throw new RawQueryRefused();
      return query(cypher, params);
    },
    [SCOPE]: scoped,
  };
  return out as B;
}

/** The backend as a run on a Concept branch reads it (src/branches.ts):
 *  its reader held to the branch (`ReadScope.concepts`) on top of whatever
 *  list it is held to, raw queries off, the branch carried so every
 *  `graph/*` step's view (`graphFor`) keeps it. The writers are the
 *  caller's to hold (src/graph/branch.ts). A view already on `branch` as
 *  it is; one on another branch is refused. */
export function withBranch<B extends GraphBackend>(b: B, branch: string): B {
  const info = infoOf(b);
  if (info?.branch === branch) return b;
  if (info?.branch) throw new ScopeRefused(`this graph view is on another Concept branch already`);
  const base = { ...b, [SCOPE]: { readers: info?.readers, reader: info?.reader ?? b.reader, query: info?.query ?? b.query.bind(b), ...(info?.kind ? { kind: info.kind } : {}), branch } };
  return scopedBackend(base as B, info?.list);
}

/**
 * `ctx.services.graph` on a host that set `graphReaders`: the backend as a
 * `jobs` reader sees it (or `kind`'s, for a view pinned to one), carrying
 * the lists so `graphFor` can hold each `graph/*` step to its caller's.
 * Without `graphReaders`, the backend as it is.
 */
export function graphView<B extends GraphBackend>(b: B, readers: GraphReaders | undefined, kind?: ReaderKind): B {
  if (!readers) return b;
  const info = infoOf(b);
  const base = { ...b, [SCOPE]: { readers, reader: info?.reader ?? b.reader, query: info?.query ?? b.query.bind(b), ...(kind ? { kind } : {}), ...(info?.branch ? { branch: info.branch } : {}) } } as B;
  return scopedBackend(base, listFor(readers, kind ?? "jobs"));
}

/** A view pinned to one reader (the builder's tools), from a wired view;
 *  undefined when `g` carries no `graphReaders`. */
export function pinnedTo<B extends GraphBackend>(g: B | undefined, kind: ReaderKind): B | undefined {
  const readers = infoOf(g)?.readers;
  return g && readers ? graphView(g, readers, kind) : undefined;
}

/** The backend a step reads through: the wired view held to its caller's
 *  list, narrowed by the call's own asks. A backend that is no view (no
 *  `graphReaders`, or one handed in as it is) is held only to those. */
export function graphFor<B extends GraphBackend>(g: B, ctx: ReaderCtx | undefined, ask: Narrowing = {}): B {
  const n: Narrowing = { ...(ask.exclude_domains?.length ? { exclude_domains: ask.exclude_domains } : {}), ...(ask.namespace && g.kind === "ladybug" ? { namespace: ask.namespace } : {}) };
  const info = infoOf(g);
  if (!info?.readers) return n.exclude_domains || n.namespace ? scopedBackend(g, narrowed(undefined, n)) : g;
  const kind = info.kind ?? readerKindOf(ctx, info.readers);
  return scopedBackend(g, narrowed(listFor(info.readers, kind), n));
}

/** The reader for one kind on a host's backend (the `/graph/*` routes). */
export function readerFor(b: GraphBackend, readers: GraphReaders | undefined, kind: ReaderKind): GraphReader {
  return scopedBackend(b, listFor(readers, kind)).reader;
}
