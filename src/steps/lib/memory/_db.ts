// The memory/* steps' graph: the person's workspace graph (Ladybug), where
// memory's nodes are ordinary nodes beside the workflows and runs
// (plans/memory-in-workspace-graph.md). Leading-underscore file → imported by
// siblings, skipped by registry discovery (see AGENTS.md).
//
// The memory is a Graphiti-style graph: an Episode is what was said, an
// entity what it was about, a Fact one sentence linking them, with valid /
// invalid / expired times. A fact that changes is superseded, never
// overwritten. Vocabulary (entity types, predicates) is memory's Schema
// nodes (_ontology.ts).
//
// Two clocks: valid_at / invalid_at say when a fact was true in the world
// (NULL when the words gave no time), created_at / expired_at when the memory
// learned it and stopped holding it current. Every time is an int attribute
// in epoch ms.
//
// An episode's speaker is the ref_id of who said it; NULL means the user, so
// an episode the user said before they had an entity needs none made.
//
// Every memory type is managed by "memory" (decision 7): only these steps
// write it, through the generic node and edge writers, naming the manager.
// remember, merge, forget and attributes each run as one transaction of the
// workspace (memoryWrite): a failure part-way leaves nothing behind, and a
// read beside it never sees a write in progress. Memory's own queue sits
// above the workspace's write lock, so a home sync import can hold memory
// still while it lets the workspace's other writers in between its batches.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { GraphTx } from "../../../graph/engine.js";
import type { GraphBackend, LadybugBackend } from "../../../graph/backend.js";
import { NodeWriter, mintManagerKey, type ManagerKey } from "../../../graph/node-writer.js";
import { rawGraphOf } from "../../../graph/managed.js";
import { seedMemoryOntology, invalidate, wroteOntology } from "./_ontology.js";

export const EntityRef = z.object({
  ref_id: z.string().optional().describe("An existing entity's ref_id, when you already know it."),
  type: z.string().min(1).describe(
    "An entity type from memory/ontology, e.g. Person; each type's description says when to use it, and user_type is the user. " +
      "A new type is kept as proposed.",
  ),
  name: z.string().min(1).describe("The entity's name, e.g. 'Kate' or 'Friday Night Chef'."),
});
export type EntityRefT = z.infer<typeof EntityRef>;

/** Who writes memory's types (decision 7): the writers refuse anyone else. */
export const MANAGER = "memory";

/** Memory's write key (node-writer.ts `mintManagerKey`), minted here and
 *  never handed out: only these steps, through MemoryTx, write memory's types. */
const KEY: ManagerKey = mintManagerKey(MANAGER);

export type Row = Record<string, any>;
type Run = (cypher: string, params?: Record<string, any>) => Promise<Row[]>;
/** A query in memory's dialect; `raw`, when there, runs Cypher as it is. */
export type Query = Run & { raw?: Run };

// ── The query dialect ───────────────────────────────────────────────────────
//
// Memory's Cypher names its three kinds of node as labels, `(e:Entity)`,
// `(f:Fact)`, `(ep:Episode)`, and an entity's fields as they read
// (`e.type`, `e.aliases`, `e.attributes`). In the workspace they are all
// rows of the one `Node` table: an entity is a node whose type inherits
// MemoryEntity (marked `memory_entity`), and `aliases` / `attributes` are
// stored as `alias_keys` / `attributes_json`, since a Schema row keeps its
// own `aliases` and `attributes` (ladybug/ontology.ts). `cypher()` rewrites
// the one into the other. A label's filter goes into the clause's WHERE,
// never inline: in Ladybug 0.21 an inline filter (a literal one too) plus an
// OPTIONAL MATCH returns the node's fields as null.

const KIND: Record<string, (v: string) => string> = {
  Entity: (v) => `${v}.memory_entity = true`,
  Fact: (v) => `${v}.node_type = 'Fact'`,
  Episode: (v) => `${v}.node_type = 'Episode'`,
};
const CLAUSE = /\b(OPTIONAL MATCH|MATCH|(?<!STARTS |ENDS )WITH|RETURN|SET|CREATE|DETACH DELETE|DELETE|ORDER BY|UNWIND|MERGE|LIMIT)\b/;
const FIELDS: Array<[RegExp, string]> = [
  [/\b([a-z_][A-Za-z0-9_]*)\.type\b/g, "$1.node_type"],
  [/\b([a-z_][A-Za-z0-9_]*)\.aliases\b/g, "$1.alias_keys"],
  [/\b([a-z_][A-Za-z0-9_]*)\.attributes\b/g, "$1.attributes_json"],
];

/** Memory's Cypher as the workspace's. */
export function cypher(text: string): string {
  let n = 0;
  const parts = text.split(CLAUSE);
  // parts: [before, keyword, body, keyword, body, …]
  for (let i = 1; i < parts.length; i += 2) {
    // A CREATE names the kind in the node's own map (no OPTIONAL MATCH follows a write).
    if (parts[i] === "CREATE" || parts[i] === "MERGE") {
      parts[i + 1] = parts[i + 1]!.replace(/\((\w*):(Entity|Fact|Episode)\s*(\{([^}]*)\})?/g, (_m, v: string, label: string, _b, map?: string) => {
        const own = label === "Entity" ? "memory_entity: true" : `node_type: '${label}'`;
        const rest = (map ?? "").replace(/\btype:/g, "node_type:").replace(/\baliases:/g, "alias_keys:").replace(/\battributes:/g, "attributes_json:");
        return `(${v}:Node {${own}${rest.trim() ? `, ${rest}` : ""}}`;
      });
      continue;
    }
    if (!/MATCH$/.test(parts[i]!)) continue;
    const conds: string[] = [];
    let body = parts[i + 1]!.replace(/\((\w*):(Entity|Fact|Episode)\s*(\{([^}]*)\})?/g, (_m, v: string, label: string, _b, map?: string) => {
      const name = v || `_m${n++}`;
      conds.push(KIND[label]!(name));
      for (const kv of (map ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const [k, ...rest] = kv.split(":");
        conds.push(`${name}.${k!.trim()} = ${rest.join(":").trim()}`);
      }
      return `(${name}:Node`;
    });
    if (conds.length) {
      const where = /\bWHERE\b/.exec(body);
      body = where
        ? `${body.slice(0, where.index)}WHERE ${conds.join(" AND ")} AND (${body.slice(where.index + 5).trimEnd()}) `
        : `${body.trimEnd()} WHERE ${conds.join(" AND ")} `;
    }
    parts[i + 1] = body;
  }
  let out = parts.join("");
  for (const [re, to] of FIELDS) out = out.replace(re, to);
  return out;
}

/** `run` in memory's dialect; `.raw` is `run` as it is (the Schema rows, _ontology.ts). */
const translated = (run: Run): Query =>
  Object.assign((text: string, params: Record<string, any> = {}) => run(cypher(text), params), { raw: run });

// ── The handle ──────────────────────────────────────────────────────────────

/** Memory on one workspace graph: its read query, its queue, the writers. */
export type Handle = {
  backend: LadybugBackend;
  /** Reads on the workspace's read connection: committed writes only. */
  read: Query;
  /** Memory's own queue (memoryExclusive): one memory write at a time. */
  queue: Promise<unknown>;
  ladybug: string;
};

// One per workspace handle, kept on globalThis so a re-imported module shares it.
const HANDLES = ((globalThis as Record<symbol, unknown>)[Symbol.for("strut.memory.workspace")] ??= new WeakMap()) as WeakMap<object, Promise<Handle>>;

/** The workspace graph memory lives in; memory steps refuse without a Ladybug one (decision 11).
 *  A step is handed the graph as a view that leaves memory out (`graphView`); memory's own
 *  steps read the backend behind it, as strut's graph steps do. */
export function memoryBackend(ctx?: StepContext<unknown>): LadybugBackend {
  const view = (ctx?.services as Partial<StrutCapabilities> | undefined)?.graph;
  const graph = (rawGraphOf(view) ?? view) as GraphBackend | undefined;
  if (!graph) throw new Error("memory/* steps need the workspace graph (ctx.services.graph): memory lives in the person's Ladybug workspace");
  if (graph.kind !== "ladybug") {
    throw new Error(`memory/* steps run on a personal (Ladybug) workspace graph only; this workspace is on ${graph.kind} (STRUT_WORKSPACE_BACKEND=ladybug)`);
  }
  return graph;
}

/** Memory on `backend`: its ontology seeded once per handle. */
export function memoryOn(backend: LadybugBackend): Promise<Handle> {
  let h = HANDLES.get(backend.lbug);
  if (!h) {
    h = (async () => {
      await seedMemoryOntology(backend);
      return { backend, read: translated(backend.lbug.query as Run), queue: Promise.resolve(), ladybug: backend.lbug.version };
    })();
    HANDLES.set(backend.lbug, h);
    const mine = h;
    h.catch(() => {
      if (HANDLES.get(backend.lbug) === mine) HANDLES.delete(backend.lbug);
    });
  }
  return h;
}

const handleFor = (ctx?: StepContext<unknown>) => memoryOn(memoryBackend(ctx));

/** The memory this run's workspace keeps, as a query function. */
export async function memoryDb(ctx?: StepContext<unknown>): Promise<Query> {
  return (await handleFor(ctx)).read;
}

/** Makes `folder` owner-only (0700, whatever the umask) when it creates it; true when it did. */
export function ownerOnly(folder: string): boolean {
  if (!mkdirSync(folder, { recursive: true, mode: 0o700 })) return false;
  chmodSync(folder, 0o700);
  return true;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Node data as the writer takes it: nulls and undefined left out. */
const present = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined));

/** One memory transaction: reads on it, and every write through the generic
 *  writers, naming memory as the manager. */
export class MemoryTx {
  readonly query: Query;
  constructor(
    readonly backend: LadybugBackend,
    readonly tx: GraphTx,
    /** The node writer: the backend's, or one on a copy's clock (memory/import). */
    private readonly nodes: NodeWriter = backend.nodes,
  ) {
    this.query = translated((c, p) => tx.run(c, p) as Promise<Row[]>);
  }

  private get opts() {
    return { tx: this.tx, manager: KEY };
  }

  /** A new node of a memory type; `ref_id` defaults to a new one. */
  async create(type: string, data: Record<string, unknown>, ref_id = newRefId()): Promise<string> {
    return (await this.nodes.write({ type, data: present(data), ref_id }, "create", this.opts)).ref_id;
  }

  /** Several new nodes of one clock in one write; returns their ref_ids. */
  async createMany(inputs: Array<{ type: string; data: Record<string, unknown>; ref_id: string }>): Promise<string[]> {
    if (!inputs.length) return [];
    const out = await this.nodes.writeMany(inputs.map((i) => ({ ...i, data: present(i.data) })), "create", this.opts);
    return out.map((r) => r.ref_id);
  }

  /** Sets attributes; a null (or undefined) one is removed. */
  async set(ref_id: string, patch: Record<string, unknown>): Promise<void> {
    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    for (const [k, v] of Object.entries(patch)) (v === null || v === undefined ? remove.push(k) : (set[k] = v));
    await this.nodes.update(ref_id, { set, remove }, this.opts);
  }

  /** Soft delete that keeps the edges (canonical() follows ALIAS_OF out of a
   *  merged node; unalias and dictation read a forgotten fact's SUBJECT). */
  async forget(ref_id: string, reason: string, at?: number): Promise<boolean> {
    return this.nodes.softDelete(ref_id, { ...this.opts, keepEdges: true, reason, ...(at !== undefined ? { at } : {}) });
  }

  async link(edge: string, from: string, to: string): Promise<void> {
    await this.backend.edges.write({ edge, source_ref_id: from, target_ref_id: to }, this.opts);
  }

  async linkMany(edges: Array<{ edge: string; from: string; to: string }>): Promise<void> {
    if (!edges.length) return;
    await this.backend.edges.writeMany(edges.map((e) => ({ edge: e.edge, source_ref_id: e.from, target_ref_id: e.to })), this.opts);
  }

  async unlink(edge: string, from: string, to: string): Promise<void> {
    await this.backend.edges.delete({ edge, source_ref_id: from, target_ref_id: to }, this.opts);
  }
}

/** Runs `fn` as one transaction of the workspace, in memory's queue: all of
 *  it lands, or, when it throws, none of it. Must not nest: an inner call
 *  would wait on the queue the outer one holds. */
export async function memoryWrite<T>(ctx: StepContext<unknown> | undefined, fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
  return memoryExclusive(ctx, (handle) => writeOn(handle, fn));
}

/** One workspace transaction on `handle`, for a caller already in memory's queue. */
export async function writeOn<T>(handle: Handle, fn: (tx: MemoryTx) => Promise<T>, nodes?: NodeWriter): Promise<T> {
  let wrote = false;
  try {
    return await handle.backend.lbug.withWrite(async (tx) => {
      const m = new MemoryTx(handle.backend, tx, nodes);
      const out = await fn(m);
      wrote = wroteOntology(m.query);
      return out;
    });
  } finally {
    // A proposal (a new Schema) is seen by readers once it commits.
    if (wrote) {
      invalidate(handle.read);
      handle.backend.schemas.invalidate();
    }
  }
}

/** Runs `fn` in memory's queue, outside any transaction: what holds memory
 *  still across several (an import's batches, a sync's read). Must not nest. */
export async function memoryExclusive<T>(ctx: StepContext<unknown> | undefined, fn: (handle: Handle) => Promise<T>): Promise<T> {
  return exclusiveOn(await handleFor(ctx), fn);
}

export function exclusiveOn<T>(handle: Handle, fn: (handle: Handle) => Promise<T>): Promise<T> {
  const run = () => fn(handle);
  const next = handle.queue.then(run, run);
  handle.queue = next.catch(() => undefined);
  return next;
}

/** Time-sortable and random, never derived from text. */
export function newRefId(): string {
  return Date.now().toString(36).padStart(9, "0") + randomBytes(8).toString("hex");
}

export function normalize(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function iso(ms: unknown): string | undefined {
  return typeof ms === "number" || typeof ms === "bigint" ? new Date(Number(ms)).toISOString() : undefined;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Ends the `old` facts as replaced by `by` (expired now) and links them to it. In
 *  the world one ended when `by` began, when that is known and not before it began itself;
 *  an end still to come is brought forward to then, or to now when that is not known. */
export async function supersede(m: MemoryTx, by: string, valid: number | null, old: string[], now: number): Promise<void> {
  if (!old.length) return;
  const rows = await m.query("MATCH (o:Fact) WHERE o.ref_id IN $old RETURN o.ref_id AS id, o.valid_at AS valid_at, o.invalid_at AS invalid_at", { old });
  for (const o of rows) {
    const ov = num(o.valid_at);
    const oi = num(o.invalid_at);
    // When `by` began, if known and not before `o` did.
    const began = valid !== null && (ov === null || ov <= valid);
    const invalid = oi === null ? (began ? valid : null)
      : oi <= now ? oi
      : began ? Math.min(valid!, oi)
      : now;
    await m.set(o.id, { expired_at: now, invalid_at: invalid });
    await m.link("SUPERSEDES", by, o.id);
  }
}

/** Adds names to an entity's aliases, or with `remove` takes them off; normalised either way. Returns the aliases after. */
export async function editAliases(m: MemoryTx, id: string, names: string[], now: number, remove = false): Promise<string[]> {
  void now; // the writer stamps updated_at
  const [e] = await m.query("MATCH (e:Entity) WHERE e.ref_id = $id RETURN e.aliases AS aliases", { id });
  const was: string[] = e?.aliases ?? [];
  const keys = names.map(normalize);
  const next = remove ? was.filter((a) => !keys.includes(a)) : [...new Set([...was, ...keys])];
  if (e && next.length !== was.length) await m.set(id, { alias_keys: next });
  return next;
}

/** An entity's attributes as an object; {} when the stored string is not a JSON object. */
export function readAttributes(stored: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(typeof stored === "string" && stored ? stored : "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The entity a ref_id now means: itself, or, once merged away, the entity it is an alias of. */
export async function canonical(query: Query, refId: string): Promise<string> {
  const [hit] = await query(
    `MATCH (d:Entity)-[:ALIAS_OF*1..5]->(k:Entity) WHERE d.ref_id = $id AND d.deleted_at IS NOT NULL AND k.deleted_at IS NULL
     RETURN k.ref_id AS id LIMIT 1`,
    { id: refId },
  );
  return hit?.id ?? refId;
}
