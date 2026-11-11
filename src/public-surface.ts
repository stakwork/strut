/**
 * The PUBLIC SURFACE — the server's PUBLIC VIEW in the UI, never a
 * "publish" (plans/public-surface.md §2, §4, decision 19): what a person chose
 * to show anyone on this strut server, live and read-only — Concept roots
 * (the subtree under each), workflows (with or without their runs), steps,
 * node types, and apps. One record per server, a person's act, kept as
 * plain JSON in `<dataDir>/public.json` (nothing in it is a secret).
 *
 * This module is the record and the rules over it, with no routes:
 * - `readSurface` / `writeSurface` / `surfaceProblem` — the file. Its
 *   `runnable` list (plans/paid-runs.md §2) is what anyone may START, and
 *   for how much; the checks that need the workspace, the registry or the
 *   wallet are src/public-runnable.ts's.
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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { RunEvent, RunSummary } from "./core.js";
import type { RunStore } from "./store.js";
import type { PublicLaunchOutcome } from "./public-routes.js";
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

/** What anyone may RUN (plans/paid-runs.md §2): a workflow or a step, free
 *  or priced by one rule, charge = base + markup × what the run cost.
 *  Independent of `workflows` and `steps` (decision 11): an item may be run
 *  by anyone without its definition or its runs being shown. Prices are
 *  dollars. Changing it publishes no version. */
export interface PublicRunnable {
  kind: "workflow" | "step";
  /** A workflow name or a step type. */
  name: string;
  /** Dollars per run or call; 0 when absent. */
  base?: number;
  /** Times what the run cost; 0 when absent. */
  markup?: number;
  /** The most one run may spend, in dollars; required with a markup. */
  capUsd?: number;
  /** The spend its owner carries per UTC day, in dollars. */
  dailyCapUsd?: number;
  /** What a workflow's launcher reads: its output (the default), or the
   *  whole run. A workflow's only. */
  results?: "output" | "run";
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
  /** What anyone may run, and for how much. An older record has none. */
  runnable: PublicRunnable[];
}

/** `<dataDir>/public.json`. */
export const PUBLIC_FILE = "public.json";

export function emptySurface(): PublicSurface {
  return { concepts: [], workflows: [], steps: [], types: [], apps: [], runnable: [] };
}

const NAME_MAX = 200;
const okName = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= NAME_MAX && !/[\u0000-\u001f]/.test(v);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const SURFACE_FIELDS = ["concepts", "workflows", "steps", "types", "apps", "runnable"];
const SURFACE_SHAPE = "the surface is { concepts?, workflows?, steps?, types?, apps?, runnable? }";
const RUNNABLE_FIELDS = ["kind", "name", "base", "markup", "capUsd", "dailyCapUsd", "results"];
const RUNNABLE_SHAPE = "runnable is a list of { kind: workflow | step, name, base?, markup?, capUsd?, dailyCapUsd?, results? }";

/** The label a refusal names an item by: `workflow "acme/x"`. */
export const runnableLabel = (r: { kind: string; name: string }) => `${r.kind} "${r.name}"`;

/** Why one `runnable` entry is not well formed, or undefined: its fields,
 *  and numbers that are finite and not negative (a cap above zero: the
 *  gateway reads a cap of 0 as none, and a daily cap of 0 refuses every
 *  run). What needs the server — the item exists, a wallet — is
 *  src/public-runnable.ts's. */
export function runnableShapeProblem(v: unknown): string | undefined {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || (o["kind"] !== "workflow" && o["kind"] !== "step") || !okName(o["name"])) return RUNNABLE_SHAPE;
  const label = runnableLabel(o as { kind: string; name: string });
  const extra = Object.keys(o).find((k) => !RUNNABLE_FIELDS.includes(k));
  if (extra) return `${label}: unknown field "${extra}" — ${RUNNABLE_SHAPE}`;
  for (const f of ["base", "markup", "capUsd", "dailyCapUsd"]) {
    const n = o[f];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return `${label}: ${f} is a number, 0 or more`;
  }
  if (o["capUsd"] === 0) return `${label}: capUsd is the most one run may spend — above 0 (leave it out for the server's cap)`;
  if (o["dailyCapUsd"] === 0) return `${label}: a daily cap of 0 refuses every run — take the item out instead`;
  if (o["results"] !== undefined) {
    if (o["kind"] === "step") return `${label}: results is a workflow's (a step's call answers its output)`;
    if (o["results"] !== "output" && o["results"] !== "run") return `${label}: results is "output" or "run"`;
  }
  return undefined;
}

/** Why `v` is not a surface record, or undefined. Every list is optional
 *  (an absent one is empty); every name is a non-empty string. */
export function surfaceProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return SURFACE_SHAPE;
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!SURFACE_FIELDS.includes(k)) return `unknown field "${k}": ${SURFACE_SHAPE}`;
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
  if (r["runnable"] !== undefined) {
    if (!Array.isArray(r["runnable"])) return RUNNABLE_SHAPE;
    for (const item of r["runnable"]) {
      const bad = runnableShapeProblem(item);
      if (bad) return bad;
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
    runnable: unique(
      (r.runnable ?? []).map((x) => ({
        kind: x.kind,
        name: x.name,
        ...(x.base ? { base: x.base } : {}),
        ...(x.markup ? { markup: x.markup } : {}),
        ...(x.capUsd !== undefined ? { capUsd: x.capUsd } : {}),
        ...(x.dailyCapUsd !== undefined ? { dailyCapUsd: x.dailyCapUsd } : {}),
        ...(x.kind === "workflow" && x.results === "run" ? { results: "run" as const } : {}),
      })),
      (x) => `${x.kind}:${x.name}`,
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
const PRIVATE_RUN_FIELDS = ["actor", "principal", "job", "startedBy", "peerPerson", "callback", "mcp", "credit", "visitor"] as const;

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
  /** The item anyone may run under this name, if it is one (plans/paid-runs.md §2). */
  runnable(kind: PublicRunnable["kind"], name: string): Promise<PublicRunnable | undefined>;
  conceptTree(): Promise<PublicConceptTree>;
  /** The trees under these roots, whether or not they are public — what
   *  the Publish dialog's Public view tab shows before a root is added (its page count). */
  walk(roots: string[]): Promise<PublicConceptTree>;
  /** The ref_ids a run's steps reported (`step.end.nodes`), this graph's only. */
  runNodes(workflow: string, runId: string): Promise<Set<string>>;
  /** Feed a run event to the visible-refs index (no-op until a workflow's
   *  index is first used): adds `nodes` as steps end. */
  noteEvent(workflow: string, event: { nodes?: unknown }): void;
  /** A workflow's runs were deleted: forget what they made visible. */
  forgetRuns(workflow: string): void;
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

  /** Per public workflow with `runs: true`: every ref its runs reported,
   *  built once (persisted sets + logs), then kept current from events. */
  const index = new Map<string, { refs: Set<string>; ready: Promise<void> }>();
  const indexFor = (name: string) => {
    let e = index.get(name);
    if (!e) {
      const refs = new Set<string>();
      const entry = { refs, ready: Promise.resolve() };
      entry.ready = (async () => {
        for (const runId of await deps.store.listRuns(name)) for (const r of await runNodes(name, runId)) refs.add(r);
      })().catch((err) => {
        if (index.get(name) === entry) index.delete(name);
        throw err;
      });
      index.set(name, entry);
      e = entry;
    }
    return e;
  };
  // The index only. `runSets` stays `runNodes`' alone: a run's set there is
  // read as COMPLETE, and an event stream joined mid-run is not — the index
  // is built on the first visitor read, so a run already going would keep
  // only the steps that ended after it, and lose the rest on disk.
  const noteEvent = (workflow: string, event: { nodes?: unknown }): void => {
    const e = index.get(workflow);
    if (!e || !Array.isArray(event.nodes)) return;
    for (const n of event.nodes as { ref_id?: unknown; peer?: unknown }[]) {
      if (!n?.peer && typeof n?.ref_id === "string") e.refs.add(n.ref_id);
    }
  };
  const forgetRuns = (workflow: string): void => {
    index.delete(workflow);
    runSets.delete(workflow);
    runSetsLoaded.delete(workflow);
    // After any save in flight, so it cannot write the file back.
    saving = saving.then(() => rm(nodesFile(workflow), { force: true })).catch(() => {});
  };

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
      const e = indexFor(w.name);
      await e.ready;
      if (e.refs.has(ref_id)) return true;
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
      for (const name of [...index.keys()]) if (!s.workflows.some((w) => w.name === name && w.runs)) index.delete(name);
      return s;
    },
    workflow,
    async step(type) {
      return (await get()).steps.includes(type);
    },
    async runnable(kind, name) {
      return (await get()).runnable.find((r) => r.kind === kind && r.name === name);
    },
    conceptTree,
    walk: walkTrees,
    runNodes,
    noteEvent,
    forgetRuns,
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

/** Is this workflow one anyone may RUN (`runnable`, plans/paid-runs.md §2)? */
export function runnableWorkflow(surface: PublicSurface, name: string): PublicRunnable | undefined {
  return surface.runnable.find((r) => r.kind === "workflow" && r.name === name);
}

/** Why a visitor's call is refused, or null: checked after the app's own
 *  grants (`grantRefusal`), so this only ever narrows. `live` is the app's
 *  version the public view serves. Every reason is a sentence a page can
 *  show.
 *
 *  A visitor's page LAUNCHES a workflow the app grants that a person made
 *  runnable (plans/paid-runs.md §10): through the same launcher as `POST
 *  /public/workflows/:name/run` (`visitorRuns`), its host paying when it is
 *  priced. It reads the runs of a workflow whose runs are public, and of a
 *  runnable one the runs its own visit launched (`visitorRuns` keeps it to
 *  those). Nothing else starts or stops a run. */
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
  const wf = typeof config["workflow"] === "string" ? config["workflow"] : "";
  if (type === "run/cancel") return "stopping a run is not available in the public view";
  if (type === "run/launch") {
    if (!runnableWorkflow(surface, wf)) return `workflow "${wf}" is not open to visitors to run on this strut server — a visitor's page starts only what a person made runnable in the public view`;
    return null;
  }
  if (VISITOR_RUN_READS.has(type)) {
    const w = surface.workflows.find((x) => x.name === wf);
    const runnable = !!runnableWorkflow(surface, wf);
    if (!w && !runnable) return `workflow "${wf}" is not in the public view`;
    if (type === "run/transcript" && config["full"]) return "a whole thread (`full`) is not in the public view: one transcript at a time";
    // Not public, but runnable: the visit's own runs (`visitorRuns`).
    if (type !== "run/workflow" && !w?.runs && !runnable) return `the runs of "${wf}" are not in the public view`;
    return null;
  }
  if (VISITOR_GRAPH_READS.has(type)) return null;
  if (type === "app/state" || type === "app/report-error") return "nothing is kept for a visitor: the page keeps its state for the visit";
  if (type.startsWith("graph/")) return `"${type}" is not available in the public view (the graph reads are ${[...VISITOR_GRAPH_READS].join(", ")})`;
  if (type.startsWith("job/") || type.startsWith("app/")) return `"${type}" is not available in the public view`;
  if (entry.reads?.includes(type)) return null;
  return `"${type}" is not one of this app's public reads — a person adds it in the Publish dialog's Public view tab`;
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

/** A relative path a run's output names as one of its files, or undefined:
 *  `./` dropped, nothing absolute, no `..`, no URL. */
export function relativeFile(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("/")) return undefined;
  const p = v.replace(/^(?:\.\/)+/, "");
  return p && !p.split("/").includes("..") ? p : undefined;
}

/** The files a run's output declares (`artifacts[].path`, and `render`
 *  when it is a file): what a launcher shown the output alone may read. */
export function declaredPaths(output: unknown): Set<string> {
  const out = new Set<string>();
  const list = (output as { artifacts?: unknown } | null | undefined)?.artifacts;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    for (const k of ["path", "render"] as const) {
      const p = relativeFile((e as Record<string, unknown>)[k]);
      if (p) out.add(p);
    }
  }
  return out;
}

/** What the launcher of an item that shows its output alone reads of the
 *  summary: never its step counts, nor where an error was raised. */
export function outputOnlySummary(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["runId", "workflow", "status", "startedAt", "finishedAt", "durationMs", "input", "output", "origin", "totals"]) {
    if (s[k] !== undefined) out[k] = s[k];
  }
  const err = s["error"] as { message?: unknown } | undefined;
  if (err && typeof err === "object") out["error"] = { message: String(err.message ?? "") };
  return out;
}

/** A visit's secret, as its host names it on `POST /public/mcp`
 *  (`x-strut-visit`, plans/paid-runs.md §10): 22 to 128 characters of
 *  base64url, minted at random by the host for each page it shows. */
export const VISIT_HEADER = "x-strut-visit";
const VISIT = /^[A-Za-z0-9_-]{22,128}$/;

/** What strut keeps of a visit: a hash of its secret, on the runs it
 *  launches (`run.start.visitor`) — a log or a run record never holds the
 *  secret itself, and the hash opens nothing. Undefined for no visit, or
 *  one that is not a visit's secret. */
export function visitorOfVisit(visit: string | undefined): string | undefined {
  return visit && VISIT.test(visit) ? createHash("sha256").update(`strut-visit:${visit}`).digest("hex").slice(0, 32) : undefined;
}

/** Why a visitor's LAUNCH is refused for want of a visit, else undefined: a
 *  run launched with none could never be read back, so it is refused
 *  before anything is admitted, held or charged — naming the header. */
export function visitProblem(visit: string | undefined): string | undefined {
  if (visit === undefined || visit === "") {
    return `visit_required: a visitor's launch needs its host to name the visit — the ${VISIT_HEADER} header on the /public/mcp request, 22 to 128 characters of base64url minted at random for the page — or its run could never be read back; this host sent none`;
  }
  if (!VISIT.test(visit)) return `visit_required: ${VISIT_HEADER} is not 22 to 128 characters of base64url`;
  return undefined;
}

/** A launch's answer as a visitor's page reads it (plans/paid-runs.md §10):
 *  the run (`{ runId, existing?, credit? }`) — never its run token, which
 *  would be a bearer credential in the frame; for a priced workflow no
 *  credit covers, `{ payment_required }` — §10's MCP shape, which the
 *  host pays and retries, never the page; anything else, a thrown error
 *  with the route's sentence. */
export function visitorLaunchResult(out: PublicLaunchOutcome): Record<string, unknown> {
  if (out.status === 202) {
    const { token: _token, ...rest } = out.body;
    return rest;
  }
  if (out.status === 402) {
    const b = out.body;
    const pick: Record<string, unknown> = {};
    for (const k of ["macaroon", "invoice", "usd", "sats", "rate", "description", "expires", "remaining_usd", "reason", "carries"]) if (b[k] !== undefined) pick[k] = b[k];
    return { payment_required: pick };
  }
  const message = typeof out.body["error"] === "string" ? out.body["error"] : `the launch was refused (${out.status})`;
  const code = typeof out.body["code"] === "string" ? out.body["code"] : undefined;
  const retry = out.headers?.["retry-after"];
  throw new Error(`${code && !message.startsWith(`${code}:`) ? `${code}: ` : ""}${message}${retry ? ` (try again in ${retry} s)` : ""}`);
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

/** What a visitor's runs need of the server beyond the reads. */
export interface VisitorRunsOptions {
  /** The public view now. */
  surface: () => Promise<PublicSurface>;
  /** The visit's hash (`visitorOfVisit`), when its host named one: the
   *  runs it launched are the runs it reads of a runnable workflow. */
  visitor?: string;
  /** Why this request may launch nothing (`visitProblem`): no visit, or
   *  not one. Checked before the launcher is called. */
  visitRefusal?: string;
  /** A public launch through the one launcher (`PublicDoors.launch`,
   *  src/public-routes.ts): the address's budget, the drain, the body, the
   *  caps, the price. Absent: nothing launches. */
  launch?: (workflow: string, body: Record<string, unknown>) => Promise<PublicLaunchOutcome>;
}

/** The runs capability as a visitor's page reads it: every record without
 *  who launched it, a job run's files closed. A workflow whose runs are
 *  public reads as before. A RUNNABLE one (plans/paid-runs.md §10) launches
 *  through the public launcher, and reads only the runs this visit
 *  launched — of those, as far as the item's `results` lets its launcher
 *  (`output`: the summary and the declared files; `run`: everything), the
 *  rule `POST /public/workflows/:name/run`'s run token follows — and its
 *  definition only as `GET /public` lists it (name, description, input).
 *  Cancel stays closed. */
export function visitorRuns(inner: RunsReads, o?: VisitorRunsOptions): Record<string, unknown> {
  const closed = (what: string) => () => Promise.reject(new Error(`${what} is not available in the public view`));
  /** How a visitor reads this workflow's runs: `all` (public), `own` (a
   *  runnable one's: the visit's, as far as `results` goes), else none. */
  const access = async (workflow: string): Promise<{ runs: "all" } | { runs: "own"; results: "output" | "run" } | { runs: "none" }> => {
    if (!o) return { runs: "all" };
    const surface = await o.surface();
    if (surface.workflows.find((w) => w.name === workflow)?.runs) return { runs: "all" };
    const item = runnableWorkflow(surface, workflow);
    return item ? { runs: "own", results: item.results === "run" ? "run" : "output" } : { runs: "none" };
  };
  const notPublic = (workflow: string) => new Error(`the runs of "${workflow}" are not in the public view`);
  /** A run this visit launched: its record, whatever its status. */
  const ownRecord = async (q: { workflow: string; runId: string; wait?: number }, by?: unknown) => {
    if (!o?.visitor) return null;
    const r = await inner.get(q, by);
    return r && r["origin"] === "public" && r["visitor"] === o.visitor ? r : null;
  };
  const onlyOutput = (workflow: string) =>
    new Error(`"${workflow}" shows its launcher the run's output alone: its events, transcripts and provenance are not in the public view`);
  return {
    list: async (q: { workflow: string } & Record<string, unknown>, by?: unknown) => {
      const a = await access(q.workflow);
      if (a.runs === "none") throw notPublic(q.workflow);
      if (a.runs === "own" && !o?.visitor) return [];
      const rows = await inner.list(a.runs === "own" ? { ...q, visitor: o!.visitor } : q, by);
      return rows.map((r) => {
        const rec = visitorRunRecord(q.workflow, String(r["runId"] ?? ""), r);
        return a.runs === "own" && a.results === "output" ? outputOnlySummary(rec as Record<string, unknown>) : rec;
      });
    },
    get: async (q: { workflow: string; runId: string; wait?: number }, by?: unknown) => {
      const a = await access(q.workflow);
      if (a.runs === "none") throw notPublic(q.workflow);
      const r = a.runs === "all" ? await inner.get(q, by) : await ownRecord(q, by);
      if (!r) return r;
      const rec = visitorRunRecord(q.workflow, q.runId, r);
      if (a.runs === "all" || a.results === "run") return rec;
      const out = outputOnlySummary(rec as Record<string, unknown>);
      if (rec["artifacts"] !== undefined) out["artifacts"] = rec["artifacts"];
      if (rec["partial"] !== undefined) out["partial"] = rec["partial"];
      return out;
    },
    events: async (q: { workflow: string; runId: string; skip?: number }, by?: unknown) => {
      const a = await access(q.workflow);
      if (a.runs === "none") throw notPublic(q.workflow);
      if (a.runs === "own") {
        if (a.results === "output") throw onlyOutput(q.workflow);
        if (!(await ownRecord(q, by))) return [];
      }
      return (await inner.events(q, by)).map((e) => visitorRunRecord(q.workflow, q.runId, e));
    },
    transcript: async (q: { workflow: string; runId: string; path: string; full?: boolean }, by?: unknown) => {
      const a = await access(q.workflow);
      if (a.runs === "none") throw notPublic(q.workflow);
      if (a.runs === "own") {
        if (a.results === "output") throw onlyOutput(q.workflow);
        if (!(await ownRecord(q, by))) throw new Error(`no run "${q.runId}" of "${q.workflow}"`);
      }
      return inner.transcript({ ...q, full: false }, by);
    },
    files: async (q: { workflow: string; runId: string; path: string }, by?: unknown) => {
      const a = await access(q.workflow);
      if (a.runs === "none") throw notPublic(q.workflow);
      const r = a.runs === "all" ? await inner.get({ workflow: q.workflow, runId: q.runId }, by) : await ownRecord(q, by);
      if (a.runs === "own" && !r) return null;
      if (r && r["job"]) throw new Error("a job's files are not in the public view");
      if (a.runs === "own" && a.results === "output") {
        const path = relativeFile(q.path);
        if (!path || !declaredPaths(r!["output"]).has(path)) throw new Error(`"${q.workflow}" shows its launcher the run's output alone: only the files its output declares`);
      }
      return inner.files(q, by);
    },
    workflow: async (q: { workflow: string }, by?: unknown) => {
      // The definition when it is public; a runnable one's as `GET /public`
      // lists it — what a launch form draws — and nothing more.
      const surface = o ? await o.surface() : undefined;
      if (!surface || surface.workflows.some((w) => w.name === q.workflow)) return inner.workflow(q, by);
      const info = (await inner.workflow(q, by)) as Record<string, unknown>;
      return {
        name: q.workflow,
        ...(typeof info["description"] === "string" ? { description: info["description"] } : {}),
        ...(info["input"] !== undefined ? { input: info["input"] } : {}),
      };
    },
    ...(inner.provenance
      ? {
          provenance: async (q: Record<string, unknown> & { workflow: string; runId: string }, by?: unknown) => {
            const a = await access(q.workflow);
            if (a.runs === "none") throw notPublic(q.workflow);
            if (a.runs === "own") {
              if (a.results === "output") throw onlyOutput(q.workflow);
              if (!(await ownRecord(q, by))) return null;
            }
            return inner.provenance!(q, by);
          },
        }
      : {}),
    launch: o?.launch
      ? async (q: Record<string, unknown> & { workflow: string }) => {
          // The body as the public route takes it: `input` and `key`, and
          // anything else the page sent, which the launcher refuses by name.
          if (o.visitRefusal) throw new Error(o.visitRefusal);
          const { workflow, ...rest } = q;
          const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
          return visitorLaunchResult(await o.launch!(workflow, body));
        }
      : closed("starting a run"),
    cancel: closed("stopping a run"),
  };
}
