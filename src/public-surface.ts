/**
 * The PUBLIC SURFACE — the server's PUBLIC VIEW in the UI, never a
 * "publish" (plans/public-surface.md §2, §4, decision 19): what a person chose
 * to show anyone on this strut server, live and read-only — Concept roots
 * (the subtree under each), workflows (with or without their runs), steps,
 * node types, and apps. One record per server, a person's act, kept as
 * plain JSON in `<dataDir>/public.json` (nothing in it is a secret).
 *
 * This module is the record and the rules over it, with no routes:
 * - `readSurface` / `writeSurface` / `surfaceProblem` — the file.
 * - `createPublicSurface` — the service the `/public` routes
 *   (src/public-routes.ts) read through: which workflow, run or step is
 *   public, the public Concept trees, and which graph NODES are visible
 *   (§4: a Concept under a public root, a node a public run named, a node
 *   of a public type), plus `reader()`, a GraphReader that answers only
 *   with visible nodes — what a public read sees of the graph, whoever
 *   calls it.
 * - `publicEvent` / `publicSummary` — a run's records as a visitor reads
 *   them: the input whole (ruled), never who launched it or where its
 *   callbacks go.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { randomBytes } from "node:crypto";
import type { RunEvent, RunSummary } from "./core.js";
import type { RunStore } from "./store.js";
import type { EdgeEnvelope, GraphReader, NodeEnvelope, SearchParams, SearchResult } from "./graph/search.js";
import { composeNodeKey } from "./graph/node-writer.js";

// ── The record ───────────────────────────────────────────────────────────

/** A public workflow: its definition always, its runs only with `runs`. */
export interface PublicWorkflow {
  name: string;
  /** Its runs too — inputs, outputs, transcripts and files, whole. */
  runs?: boolean;
}

/** A public app (plans/public-surface.md §5, item 2): the held release's
 *  page, the granted reads a visitor's page may call, the domains that
 *  show it (§9, later). Kept now so the record's shape does not change. */
export interface PublicApp {
  name: string;
  reads?: string[];
  domains?: string[];
}

export interface PublicSurface {
  /** Concept ROOT names: each root and every page under it by PARENT_OF. */
  concepts: string[];
  workflows: PublicWorkflow[];
  /** Step types: definition, schemas, source and the helpers it imports. */
  steps: string[];
  /** Node types whose nodes are visible whole. */
  types: string[];
  apps: PublicApp[];
}

/** `<dataDir>/public.json`. */
export const PUBLIC_FILE = "public.json";

export function emptySurface(): PublicSurface {
  return { concepts: [], workflows: [], steps: [], types: [], apps: [] };
}

const NAME_MAX = 200;
const okName = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= NAME_MAX && !/[\u0000-\u001f]/.test(v);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Why `v` is not a surface record, or undefined. Every list is optional
 *  (an absent one is empty); every name is a non-empty string. */
export function surfaceProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the surface is { concepts?, workflows?, steps?, types?, apps? }";
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["concepts", "workflows", "steps", "types", "apps"].includes(k)) return `unknown field "${k}": the surface is { concepts?, workflows?, steps?, types?, apps? }`;
  }
  const names = (field: string): string | undefined => {
    const list = r[field];
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || !list.every(okName)) return `${field} is a list of names`;
    return undefined;
  };
  for (const f of ["concepts", "steps", "types"]) {
    const bad = names(f);
    if (bad) return bad;
  }
  if (r["workflows"] !== undefined) {
    if (!Array.isArray(r["workflows"])) return "workflows is a list of { name, runs? }";
    for (const w of r["workflows"]) {
      const o = w as Record<string, unknown> | null;
      if (!o || typeof o !== "object" || !okName(o["name"])) return "workflows is a list of { name, runs? }";
      if (o["runs"] !== undefined && typeof o["runs"] !== "boolean") return `workflows "${o["name"]}": runs is true or false`;
      if (Object.keys(o).some((k) => k !== "name" && k !== "runs")) return `workflows "${o["name"]}": a workflow is { name, runs? }`;
    }
  }
  if (r["apps"] !== undefined) {
    if (!Array.isArray(r["apps"])) return "apps is a list of { name, reads?, domains? }";
    for (const a of r["apps"]) {
      const o = a as Record<string, unknown> | null;
      if (!o || typeof o !== "object" || !okName(o["name"])) return "apps is a list of { name, reads?, domains? }";
      if (Object.keys(o).some((k) => !["name", "reads", "domains"].includes(k))) return `apps "${o["name"]}": an app is { name, reads?, domains? }`;
      if (o["reads"] !== undefined && (!Array.isArray(o["reads"]) || !o["reads"].every(okName))) return `apps "${o["name"]}": reads is a list of step types`;
      if (o["domains"] !== undefined && (!Array.isArray(o["domains"]) || !o["domains"].every((d) => typeof d === "string" && HOST.test(d)))) {
        return `apps "${o["name"]}": domains is a list of lowercase host names (openlaw.ai)`;
      }
    }
  }
  return undefined;
}

const unique = <T>(list: T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(key(t)) ? false : (seen.add(key(t)), true)));
};

/** A valid record with every list present, each name once (the first wins). */
export function normalizeSurface(v: unknown): PublicSurface {
  const r = (v ?? {}) as Partial<PublicSurface>;
  return {
    concepts: unique([...(r.concepts ?? [])], (s) => s),
    workflows: unique((r.workflows ?? []).map((w) => ({ name: w.name, ...(w.runs ? { runs: true } : {}) })), (w) => w.name),
    steps: unique([...(r.steps ?? [])], (s) => s),
    types: unique([...(r.types ?? [])], (s) => s),
    apps: unique(
      (r.apps ?? []).map((a) => ({
        name: a.name,
        ...(a.reads?.length ? { reads: unique([...a.reads], (s) => s) } : {}),
        ...(a.domains?.length ? { domains: unique([...a.domains], (s) => s) } : {}),
      })),
      (a) => a.name,
    ),
  };
}

/** The record on file; empty when there is none. A file that does not
 *  parse, or is not a surface, throws: it is a person's record, and
 *  showing nothing in its place would hide that it broke. */
export async function readSurface(dataDir: string): Promise<PublicSurface> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, PUBLIC_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptySurface();
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const problem = surfaceProblem(parsed);
  if (problem) throw new Error(`${PUBLIC_FILE}: ${problem}`);
  return normalizeSurface(parsed);
}

export async function writeSurface(dataDir: string, s: PublicSurface): Promise<void> {
  const file = join(dataDir, PUBLIC_FILE);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

// ── A run as a visitor reads it ──────────────────────────────────────────

/** What a public view never carries: who launched a run or pays for it
 *  (actors are deferred, plans/public-surface.md decision 18), the job and
 *  conversation it ran in (their ids name people), and where its callbacks
 *  and MCP servers are. */
const PRIVATE_RUN_FIELDS = ["actor", "principal", "job", "startedBy", "peerPerson", "callback", "mcp"] as const;

/** A run event for a visitor: the private fields gone, an agent session
 *  replaced by `transcript`, a link under `/public` (the transcript route
 *  serves it). The input, outputs and errors are kept whole. */
export function publicEvent(e: RunEvent, transcript: (path: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e };
  for (const k of PRIVATE_RUN_FIELDS) delete out[k];
  if (out["messages"]) {
    delete out["messages"];
    out["transcript"] = transcript(e.path);
  }
  return out;
}

/** A run summary for a visitor (the private fields gone). */
export function publicSummary(s: RunSummary | Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const k of PRIVATE_RUN_FIELDS) delete out[k];
  return out;
}

// ── Helpers a step imports ───────────────────────────────────────────────

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** The step names a source's relative imports reach (`./_shared.js` from
 *  `openlaw/runs` → `openlaw/_shared`), extensions dropped. */
export function relativeImports(stepName: string, source: string): string[] {
  const dir = posix.dirname(stepName);
  const out = new Set<string>();
  for (const m of source.matchAll(RELATIVE_IMPORT)) {
    const resolved = posix.normalize(posix.join(dir === "." ? "" : dir, m[1]!)).replace(/\.(?:[cm]?[jt]s)$/, "");
    if (!resolved.startsWith("..") && !resolved.startsWith("/")) out.add(resolved);
  }
  return [...out];
}

/** Is `name` a helper (a `_`-prefixed file, which registry discovery skips)? */
export function isHelperName(name: string): boolean {
  return posix.basename(name).startsWith("_");
}

/** The helpers a step's source reaches by relative imports, through other
 *  helpers too, each with its source — the set a package build collects
 *  for it (ruled: a public step shows them). `sourceOf` answers null for a
 *  file it does not have, which is left out. */
export async function stepHelpers(
  stepName: string,
  source: string,
  sourceOf: (name: string) => Promise<string | null>,
): Promise<Array<{ name: string; source: string }>> {
  const found: Array<{ name: string; source: string }> = [];
  const seen = new Set<string>([stepName]);
  const queue = relativeImports(stepName, source).filter(isHelperName);
  while (queue.length && found.length < 50) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const src = await sourceOf(name);
    if (src == null) continue;
    found.push({ name, source: src });
    for (const next of relativeImports(name, src)) if (isHelperName(next) && !seen.has(next)) queue.push(next);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ── The service ──────────────────────────────────────────────────────────

/** One page of a public Concept tree. */
export interface PublicConcept {
  ref_id: string;
  name: string;
  description?: string;
  /** Its parent's name in the tree (absent on a root). */
  parent?: string;
  /** The public root it sits under. */
  root: string;
}

export interface PublicConceptTree {
  /** Every page, roots first, then breadth first. */
  concepts: PublicConcept[];
  byRef: Map<string, PublicConcept>;
  /** Roots on the surface with no Concept of that name in the graph. */
  missing: string[];
}

export interface PublicSurfaceDeps {
  dataDir: string;
  store: Pick<RunStore, "listRuns" | "getRunSummary" | "getRunEvents">;
  /** The graph, when the deployment has one: what the Concept trees and
   *  the visible nodes are read from. */
  graph?: {
    reader: GraphReader;
    schemas: { schema(type: string): Promise<{ type: string; key_spec: string; exact_key?: boolean } | null | undefined> };
  };
  /** How long a computed Concept tree is reused before it is read again —
   *  the tree is live; this only bounds how often it is walked. */
  treeTtlMs?: number;
}

export interface PublicSurfaceService {
  get(): Promise<PublicSurface>;
  set(s: PublicSurface): Promise<PublicSurface>;
  workflow(name: string): Promise<PublicWorkflow | undefined>;
  step(type: string): Promise<boolean>;
  conceptTree(): Promise<PublicConceptTree>;
  /** The trees under these roots, whether or not they are public — what
   *  the Public view dialog shows before a root is added (its page count). */
  walk(roots: string[]): Promise<PublicConceptTree>;
  /** The ref_ids a run's steps reported (`step.end.nodes`), this graph's only. */
  runNodes(workflow: string, runId: string): Promise<Set<string>>;
  /** Is this node visible to a visitor (§4)? */
  visible(ref_id: string, node_type: string | undefined): Promise<boolean>;
  /** The graph as a visitor reads it: only visible nodes, only edges
   *  between two of them. Undefined without a graph. */
  reader(): GraphReader | undefined;
}

const TREE_CAP = 5000;
const CHILD_LIMIT = 1000;

/** The node's name, as the readers derive it. */
function nameOf(n: NodeEnvelope): string {
  const p = n.properties ?? {};
  return (typeof n.name === "string" && n.name) || (typeof p["name"] === "string" ? p["name"] : "") || n.ref_id;
}

export function createPublicSurface(deps: PublicSurfaceDeps): PublicSurfaceService {
  const ttl = deps.treeTtlMs ?? 30_000;
  let surface: PublicSurface | undefined;
  let tree: { at: number; key: string; value: Promise<PublicConceptTree> } | undefined;
  /** Per workflow: runId → refs, for FINISHED runs (a summary on file),
   *  loaded from and kept in `<dataDir>/public/run-nodes/`. */
  const runSets = new Map<string, Map<string, Set<string>>>();
  const runSetsLoaded = new Map<string, Promise<void>>();

  const get = async (): Promise<PublicSurface> => (surface ??= await readSurface(deps.dataDir));

  const nodesFile = (workflow: string) => join(deps.dataDir, "public", "run-nodes", `${encodeURIComponent(workflow)}.json`);
  const loadRunSets = (workflow: string): Promise<void> => {
    let p = runSetsLoaded.get(workflow);
    if (!p) {
      p = (async () => {
        const sets = new Map<string, Set<string>>();
        try {
          const raw = JSON.parse(await readFile(nodesFile(workflow), "utf8")) as Record<string, string[]>;
          for (const [runId, refs] of Object.entries(raw)) if (Array.isArray(refs)) sets.set(runId, new Set(refs));
        } catch {
          // none yet, or unreadable: computed again from the logs
        }
        runSets.set(workflow, sets);
      })();
      runSetsLoaded.set(workflow, p);
    }
    return p;
  };
  let saving = Promise.resolve();
  const saveRunSets = (workflow: string) => {
    saving = saving.then(async () => {
      const sets = runSets.get(workflow);
      if (!sets) return;
      const file = nodesFile(workflow);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries([...sets].map(([id, refs]) => [id, [...refs]]))), "utf8");
      await rename(tmp, file);
    }).catch(() => {});
    return saving;
  };

  const runNodes = async (workflow: string, runId: string): Promise<Set<string>> => {
    await loadRunSets(workflow);
    const sets = runSets.get(workflow)!;
    const kept = sets.get(runId);
    if (kept) return kept;
    const refs = new Set<string>();
    for (const e of await deps.store.getRunEvents(workflow, runId)) {
      for (const n of e.nodes ?? []) if (!n.peer && typeof n.ref_id === "string") refs.add(n.ref_id);
    }
    // A finished run's set never changes: keep it. One in flight is read again.
    if (await deps.store.getRunSummary(workflow, runId)) {
      sets.set(runId, refs);
      await saveRunSets(workflow);
    }
    return refs;
  };

  const findConcept = async (name: string): Promise<NodeEnvelope | null> => {
    if (!deps.graph) return null;
    const schema = await deps.graph.schemas.schema("Concept");
    if (!schema) return null;
    const keyed = schema.key_spec.split("-").slice(1);
    if (keyed.length === 1 && keyed[0]!.toLowerCase() === "name") {
      const node = await deps.graph.reader.getNodeByKey(schema.type, composeNodeKey(schema, { name }));
      if (node) return node;
    }
    const hits = await deps.graph.reader.namesLike("Concept", name, 20);
    const exact = hits.find((h) => h.name === name);
    return exact ? deps.graph.reader.getNode(exact.ref_id) : null;
  };

  const walkTrees = async (roots: string[]): Promise<PublicConceptTree> => {
    const concepts: PublicConcept[] = [];
    const byRef = new Map<string, PublicConcept>();
    const missing: string[] = [];
    if (!deps.graph) return { concepts, byRef, missing: [...roots] };
    const reader = deps.graph.reader;
    const add = (n: NodeEnvelope, root: string, parent?: string): PublicConcept | undefined => {
      if (byRef.has(n.ref_id) || byRef.size >= TREE_CAP) return undefined;
      const description = n.properties?.["description"];
      const c: PublicConcept = {
        ref_id: n.ref_id,
        name: nameOf(n),
        ...(typeof description === "string" && description ? { description } : {}),
        ...(parent ? { parent } : {}),
        root,
      };
      byRef.set(n.ref_id, c);
      concepts.push(c);
      return c;
    };
    for (const rootName of roots) {
      const rootNode = await findConcept(rootName);
      if (!rootNode) {
        missing.push(rootName);
        continue;
      }
      const first = add(rootNode, rootName);
      if (!first) continue; // already under another public root
      const queue: PublicConcept[] = [first];
      while (queue.length && byRef.size < TREE_CAP) {
        const at = queue.shift()!;
        const { nodes } = await reader.neighbors(at.ref_id, { edge_types: ["PARENT_OF"], node_types: ["Concept"], direction: "forward", limit: CHILD_LIMIT });
        const children = nodes.filter((n) => n.ref_id !== at.ref_id).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
        for (const child of children) {
          const c = add(child, rootName, at.name);
          if (c) queue.push(c);
        }
      }
    }
    return { concepts, byRef, missing };
  };

  const conceptTree = async (): Promise<PublicConceptTree> => {
    const roots = (await get()).concepts;
    const key = roots.join("\n");
    if (!tree || tree.key !== key || Date.now() - tree.at > ttl) {
      const value = walkTrees(roots);
      tree = { at: Date.now(), key, value };
      value.catch(() => {
        if (tree?.value === value) tree = undefined;
      });
    }
    return tree.value;
  };

  const workflow = async (name: string) => (await get()).workflows.find((w) => w.name === name);

  const visible = async (ref_id: string, node_type: string | undefined): Promise<boolean> => {
    const s = await get();
    if (node_type && s.types.includes(node_type)) return true;
    if ((node_type === undefined || node_type === "Concept") && s.concepts.length && (await conceptTree()).byRef.has(ref_id)) return true;
    for (const w of s.workflows) {
      if (!w.runs) continue;
      for (const runId of await deps.store.listRuns(w.name)) {
        if ((await runNodes(w.name, runId)).has(ref_id)) return true;
      }
    }
    return false;
  };

  const reader = (): GraphReader | undefined => (deps.graph ? publicReader(deps.graph.reader, visible) : undefined);

  return {
    get,
    async set(next) {
      const s = normalizeSurface(next);
      await writeSurface(deps.dataDir, s);
      surface = s;
      tree = undefined;
      return s;
    },
    workflow,
    async step(type) {
      return (await get()).steps.includes(type);
    },
    conceptTree,
    walk: walkTrees,
    runNodes,
    visible,
    reader,
  };
}

// ── The graph as a visitor reads it ──────────────────────────────────────

const refused = (what: string) => () => Promise.reject(new Error(`${what} is not available to a public read`));

/** A GraphReader that answers only with VISIBLE nodes and edges between
 *  two of them (plans/public-surface.md §4). A node that is not visible
 *  reads as not there; a search over-fetches and drops what is not
 *  visible, as a typed search over-fetches today. Writes and the
 *  namespace registry are not on it. */
export function publicReader(inner: GraphReader, visible: (ref_id: string, node_type: string | undefined) => Promise<boolean>): GraphReader {
  const keep = async <T extends { ref_id: string; node_type?: string | undefined }>(nodes: T[]): Promise<T[]> => {
    const out: T[] = [];
    for (const n of nodes) if (await visible(n.ref_id, n.node_type)) out.push(n);
    return out;
  };
  const node = async (n: NodeEnvelope | null): Promise<NodeEnvelope | null> => (n && (await visible(n.ref_id, n.node_type)) ? n : null);
  const visibleRefs = async (refs: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const r of refs) if (await node(await inner.getNode(r))) out.push(r);
    return out;
  };
  const view: GraphReader = {
    listNamespaces: refused("the namespace list"),
    registerNamespace: refused("registering a namespace"),
    resolveNamespace: (ns) => inner.resolveNamespace(ns),
    getNode: async (ref_id) => node(await inner.getNode(ref_id)),
    getNodeByKey: async (type, key, ns) => node(await inner.getNodeByKey(type, key, ns)),
    namesLike: async (type, q, limit, ns) => (await keep(await inner.namesLike(type, q, (limit ?? 20) * 4, ns))).slice(0, limit ?? 20),
    connectionCounts: async (ref_id, ns) => ((await view.getNode(ref_id)) ? inner.connectionCounts(ref_id, ns) : []),
    edgeCounts: async (refs, ns, pin) => inner.edgeCounts(await visibleRefs(refs), ns, pin),
    neighbors: async (ref_id, p) => {
      if (!(await view.getNode(ref_id))) return { nodes: [], edges: [] };
      const got = await inner.neighbors(ref_id, p);
      const nodes = await keep(got.nodes);
      const ok = new Set([ref_id, ...nodes.map((n) => n.ref_id)]);
      return { nodes, edges: got.edges.filter((e: EdgeEnvelope) => ok.has(e.source) && ok.has(e.target)) };
    },
    edgesAmong: async (refs, among, limit) => {
      const vis = await visibleRefs(refs);
      const visAmong = among ? await visibleRefs(among) : undefined;
      return inner.edgesAmong(vis, visAmong, limit);
    },
    incoming: async (refs, edge_type) => {
      const got = await inner.incoming(await visibleRefs(refs), edge_type);
      const out: typeof got = [];
      for (const g of got) if (await visible(g.node.ref_id, g.node.node_type)) out.push(g);
      return out;
    },
    search: async (p: SearchParams): Promise<SearchResult> => {
      const limit = p.limit ?? 20;
      const got = await inner.search({ ...p, limit: Math.min(limit * 4, 400), skip: 0 });
      const nodes = (await keep(got.nodes)).slice(p.skip ?? 0, (p.skip ?? 0) + limit);
      const { facts: _facts, ...rest } = got;
      return { ...rest, nodes, total: nodes.length, truncated: got.truncated };
    },
    listSchemas: (opts) => inner.listSchemas(opts),
    getSchema: (type) => inner.getSchema(type),
    ...(inner.withScope ? { withScope: (scope) => publicReader(inner.withScope!(scope), visible) } : {}),
  };
  return view;
}

// ── A visitor's step_run (plans/public-surface.md §5) ─────────────────────

/** The graph reads a visitor's page may call: each reads through the
 *  backend's reader alone, which the visitor's bag holds to visible nodes.
 *  (`graph/find` and `graph/query` read the engine directly: not these.) */
export const VISITOR_GRAPH_READS: ReadonlySet<string> = new Set([
  "graph/graph-get",
  "graph/graph-get-batched",
  "graph/graph-search",
  "graph/graph-neighbors",
  "graph/graph-edges",
]);

/** The run reads a visitor's page may call, on a workflow in the public view
 *  (its runs public, except `run/workflow`, the definition). */
export const VISITOR_RUN_READS: ReadonlySet<string> = new Set([
  "run/list",
  "run/get",
  "run/events",
  "run/transcript",
  "run/files",
  "run/workflow",
  "run/provenance",
]);

/** Why a visitor's call is refused, or null: checked after the app's own
 *  grants (`grantRefusal`), so this only ever narrows. `live` is the app's
 *  version the public view serves. Every reason is a sentence a page can
 *  show. */
export function visitorRefusal(
  surface: PublicSurface,
  live: string | undefined,
  app: { name: string; version: string },
  type: string,
  config: Record<string, unknown>,
): string | null {
  const entry = surface.apps.find((a) => a.name === app.name);
  if (!entry) return `"${app.name}" is not in this strut server's public view`;
  if (!live || live !== app.version) return `${app.name}@${app.version} is not the version in the public view${live ? ` (${live})` : ""}`;
  if (type === "run/launch" || type === "run/cancel") return "starting or stopping a run is not available in the public view";
  if (VISITOR_RUN_READS.has(type)) {
    const wf = typeof config["workflow"] === "string" ? config["workflow"] : "";
    const w = surface.workflows.find((x) => x.name === wf);
    if (!w) return `workflow "${wf}" is not in the public view`;
    if (type !== "run/workflow" && !w.runs) return `the runs of "${wf}" are not in the public view`;
    if (type === "run/transcript" && config["full"]) return "a whole thread (`full`) is not in the public view: one transcript at a time";
    return null;
  }
  if (VISITOR_GRAPH_READS.has(type)) return null;
  if (type === "app/state" || type === "app/report-error") return "nothing is kept for a visitor: the page keeps its state for the visit";
  if (type.startsWith("graph/")) return `"${type}" is not available in the public view (the graph reads are ${[...VISITOR_GRAPH_READS].join(", ")})`;
  if (type.startsWith("job/") || type.startsWith("app/")) return `"${type}" is not available in the public view`;
  if (entry.reads?.includes(type)) return null;
  return `"${type}" is not one of this app's public reads — a person adds it in the Public view dialog`;
}

/** Fields of a run record a visitor never reads (`PRIVATE_RUN_FIELDS`), and
 *  a deliverable's link rewritten under `/public` — a job's files are not
 *  public, so a link into them is dropped. */
export function visitorRunRecord<T>(workflow: string, runId: string, rec: T): T {
  if (!rec || typeof rec !== "object") return rec;
  const out = publicSummary(rec as Record<string, unknown>);
  const arts = out["artifacts"];
  if (Array.isArray(arts)) {
    const prefix = `/artifacts/${encodeURIComponent(runId)}/`;
    out["artifacts"] = arts.map((a: Record<string, unknown>) => {
      const { url, ...rest } = a ?? {};
      if (typeof url !== "string") return rest;
      const path = url.split("?")[0]!;
      if (path.startsWith(prefix)) return { ...rest, url: `/public/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}/files/${path.slice(prefix.length)}` };
      return /^https?:\/\//.test(url) && !url.includes("?t=") ? { ...rest, url } : rest;
    });
  }
  return out as T;
}

type RunsReads = {
  list(q: { workflow: string } & Record<string, unknown>, by?: unknown): Promise<Array<Record<string, unknown>>>;
  get(q: { workflow: string; runId: string; wait?: number }, by?: unknown): Promise<Record<string, unknown> | null>;
  events(q: { workflow: string; runId: string; skip?: number }, by?: unknown): Promise<RunEvent[]>;
  files(q: { workflow: string; runId: string; path: string }, by?: unknown): Promise<unknown>;
  transcript(q: { workflow: string; runId: string; path: string; full?: boolean }, by?: unknown): Promise<unknown>;
  workflow(q: { workflow: string }, by?: unknown): Promise<unknown>;
  provenance?(q: Record<string, unknown> & { workflow: string; runId: string }, by?: unknown): Promise<unknown>;
};

/** The runs capability as a visitor's page reads it: reads only, every
 *  record without who launched it, a job run's files closed. */
export function visitorRuns(inner: RunsReads): Record<string, unknown> {
  const closed = (what: string) => () => Promise.reject(new Error(`${what} is not available in the public view`));
  return {
    list: async (q: { workflow: string } & Record<string, unknown>, by?: unknown) =>
      (await inner.list(q, by)).map((r) => visitorRunRecord(q.workflow, String(r["runId"] ?? ""), r)),
    get: async (q: { workflow: string; runId: string; wait?: number }, by?: unknown) => {
      const r = await inner.get(q, by);
      return r ? visitorRunRecord(q.workflow, q.runId, r) : r;
    },
    events: async (q: { workflow: string; runId: string; skip?: number }, by?: unknown) =>
      (await inner.events(q, by)).map((e) => visitorRunRecord(q.workflow, q.runId, e)),
    transcript: (q: { workflow: string; runId: string; path: string; full?: boolean }, by?: unknown) => inner.transcript({ ...q, full: false }, by),
    files: async (q: { workflow: string; runId: string; path: string }, by?: unknown) => {
      const r = await inner.get({ workflow: q.workflow, runId: q.runId }, by);
      if (r && r["job"]) throw new Error("a job's files are not in the public view");
      return inner.files(q, by);
    },
    workflow: (q: { workflow: string }, by?: unknown) => inner.workflow(q, by),
    ...(inner.provenance ? { provenance: (q: Record<string, unknown> & { workflow: string; runId: string }, by?: unknown) => inner.provenance!(q, by) } : {}),
    launch: closed("starting a run"),
    cancel: closed("stopping a run"),
  };
}
