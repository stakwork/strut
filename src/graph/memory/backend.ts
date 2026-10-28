/**
 * The person's long-term memory (the `memory/*` steps' LadybugDB file,
 * src/steps/lib/memory/_db.ts) as a READ-ONLY graph, for the generic `graph/*`
 * read steps: graph-search, graph-get, graph-get-batched, graph-neighbors,
 * get-ontology, get-ontology-type and walk. Their interfaces are the
 * workspace graph's, unchanged; a host binds them to this graph for chosen
 * workflows (`createStrut({ memoryGraph })`, `graphCtx` in
 * src/steps/lib/graph/_shared.ts) instead of to the workspace's.
 *
 * Mapping:
 *   - an Entity row is a node: node_type = its type (Self, Person, …), name =
 *     its name; properties carry the summary, aliases, attributes, who wrote it;
 *   - a Fact is a node of type `Fact` named by its sentence, an Episode a node
 *     of type `Episode` (what was said);
 *   - MENTIONS (Episode → Entity), SUBJECT and OBJECT (Fact → Entity),
 *     FROM_EPISODE (Fact → Episode), SUPERSEDES and CONTRADICTS (Fact → Fact),
 *     ALIAS_OF (Entity → Entity) are edges, in those directions;
 *   - ref_ids are memory's own, so the ones `memory/remember` returns open here.
 *
 * What is hidden: a row with `deleted_at` is nowhere. A fact that is no longer
 * held (`expired_at`: superseded or ended) is out of search and out of an
 * entity's neighbors, but `graph-get` by ref_id returns it and SUPERSEDES /
 * CONTRADICTS edges lead to it, so history stays reachable.
 *
 * The ontology: every entity type, and every fact predicate, of the memory's
 * vocabulary (src/steps/lib/memory/_ontology.ts) is a schema, entity types in
 * domain `entity`, predicates in `predicate`, and `Fact`, `Episode` and a base
 * `Entity` in `memory` — what `memory/ontology` showed, which this retires.
 * The vocabulary's own properties (term aliases, parent, naming, role, status;
 * a predicate's cardinality and the types it connects) are the schema's
 * `attributes` as readable strings, and are in its description.
 *
 * Reads only: there are no writers here, and anything but `reader` and
 * `schemas` throws "read-only". The file is never created by a read: with none
 * yet, every read is empty (and the ontology is the seeded vocabulary). Search
 * is the words of memory/recall (src/steps/lib/memory/_search.ts), fulltext
 * only; a `type` filter resolves the vocabulary's aliases ("user" → Self).
 */
import { existsSync } from "node:fs";
import type { StepContext } from "../../core.js";
import type { StrutCapabilities } from "../../capabilities.js";
import type { GraphBackend } from "../backend.js";
import {
  DEFAULT_NAMESPACE,
  GraphReadError,
  type ConnectionCount,
  type EdgeEnvelope,
  type GraphReader,
  type NameHit,
  type NeighborsParams,
  type NodeEnvelope,
  type OntologyEdge,
  type SchemaEnvelope,
  type SearchParams,
  type SearchResult,
} from "../search.js";
import type { NodeSchema } from "../schema-resolver.js";
import { iso, memoryDb, memoryDbPath, normalize, readAttributes, type Query, type Row } from "../../steps/lib/memory/_db.js";
import { snake, vocabulary, type Term } from "../../steps/lib/memory/_ontology.js";
import { SEED } from "../../steps/lib/memory/_ontology-seed.js";
import { factDescription, memoryStopWords, scoreMemory } from "../../steps/lib/memory/_search.js";

/** What the read steps need of a graph: the reader, and the schemas graph-get looks a type up in. */
export type GraphReadBackend = Pick<GraphBackend, "reader" | "schemas">;

const READ_ONLY = "the memory graph is read-only: write memory with memory/remember, memory/forget and memory/merge";

/** Relationship tables: [edge, from table, to table]. */
const RELS = [
  ["MENTIONS", "Episode", "Entity"],
  ["SUBJECT", "Fact", "Entity"],
  ["OBJECT", "Fact", "Entity"],
  ["FROM_EPISODE", "Fact", "Episode"],
  ["SUPERSEDES", "Fact", "Fact"],
  ["CONTRADICTS", "Fact", "Fact"],
  ["ALIAS_OF", "Entity", "Entity"],
] as const;
/** Edges that lead to facts no longer held: history, kept reachable. */
const HISTORY = new Set(["SUPERSEDES", "CONTRADICTS"]);

type Kind = "Entity" | "Fact" | "Episode";
type Services = Partial<StrutCapabilities>;

interface RawEdge {
  type: string;
  source: string;
  target: string;
  sourceKind: Kind;
  targetKind: Kind;
  sourceType: string;
  targetType: string;
  sourceExpired: boolean;
  targetExpired: boolean;
}

const BASE_ENTITY = "Entity";
const MEMORY_DOMAIN = "memory";

/** The reader and schemas over `services`' memory file. Construction touches nothing: the file is opened by the first read. */
export function createMemoryGraph(services: Services | (() => Services)): GraphReadBackend & GraphBackend {
  const get = typeof services === "function" ? services : () => services;
  const ctxOf = () => ({ services: get() }) as unknown as StepContext<unknown>;
  const memory = new MemoryReader(ctxOf);
  const target: Record<string, unknown> = {
    kind: "memory",
    reader: memory,
    schemas: new MemorySchemas(memory),
  };
  // Anything a writer or the engine would reach is refused, by name.
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      throw new Error(`${READ_ONLY} (${prop})`);
    },
  }) as unknown as GraphReadBackend & GraphBackend;
}

class MemoryReader implements GraphReader {
  constructor(private readonly ctx: () => StepContext<unknown>) {}

  /** The memory's query function, or null while there is no file: a read never creates it. */
  private async db(): Promise<Query | null> {
    const ctx = this.ctx();
    if (!existsSync(await memoryDbPath(ctx))) return null;
    return memoryDb(ctx);
  }

  /** The vocabulary's terms: the file's, or the seeded ones before there is a file. */
  async terms(): Promise<Term[]> {
    const q = await this.db();
    return q ? (await vocabulary(q)).terms : (SEED as Term[]);
  }

  // ── namespaces ──────────────────────────────────────────────────────────

  async listNamespaces(): Promise<string[]> {
    return [];
  }
  async registerNamespace(): Promise<{ namespace: string; created: boolean }> {
    throw new GraphReadError("INVALID_NAMESPACE", READ_ONLY);
  }
  async resolveNamespace(namespace: string | undefined): Promise<string> {
    if (!namespace || namespace.toLowerCase() === DEFAULT_NAMESPACE) return DEFAULT_NAMESPACE;
    throw new GraphReadError("INVALID_NAMESPACE", `the memory graph holds one namespace, default; got ${namespace}`);
  }

  // ── nodes ───────────────────────────────────────────────────────────────

  async getNode(ref_id: string): Promise<NodeEnvelope | null> {
    const q = await this.db();
    if (!q || !ref_id) return null;
    return (
      (await loadEntities(q, [ref_id]))[0] ?? (await loadFacts(q, [ref_id]))[0] ?? (await loadEpisodes(q, [ref_id]))[0] ?? null
    );
  }

  /** An exact lookup by node_key (`<type>-<name>`, as composeNodeKey writes it): the entity of that type whose name composes to it. */
  async getNodeByKey(type: string, node_key: string, namespace?: string): Promise<NodeEnvelope | null> {
    await this.resolveNamespace(namespace);
    const q = await this.db();
    if (!q) return null;
    const terms = await this.terms();
    const t = resolveType(terms, type);
    if (!t) return null;
    const { composeNodeKey } = await import("../node-writer.js");
    const schema = { type: t, node_key: `${t}-name` };
    const rows = await q("MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.name AS name ORDER BY e.created_at", { type: t });
    const hit = rows.find((r) => composeNodeKey(schema, { name: r["name"] }) === node_key);
    if (hit) return (await loadEntities(q, [hit["ref_id"]]))[0] ?? null;
    // The user is one entity, however it is named: a name that means them finds them.
    const user = terms.find((x) => x.kind === "entity_type" && x.role === "user");
    if (user && user.name === t && rows.length) {
      const self = new Set(["user", "me", "myself", "self", ...user.aliases].map((a) => composeNodeKey(schema, { name: a })));
      if (self.has(node_key)) return (await loadEntities(q, [rows[0]!["ref_id"]]))[0] ?? null;
    }
    return null;
  }

  async namesLike(type: string, q: string, limit = 8, namespace?: string): Promise<NameHit[]> {
    await this.resolveNamespace(namespace);
    const db = await this.db();
    if (!db) return [];
    const t = resolveType(await this.terms(), type);
    if (!t) return [];
    const key = normalize(q);
    const rows = await db(
      "MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.name AS name, e.summary AS summary ORDER BY e.name",
      { type: t },
    );
    return rows
      .filter((r) => normalize(String(r["name"])).includes(key))
      .sort((a, b) => Number(!normalize(String(a["name"])).startsWith(key)) - Number(!normalize(String(b["name"])).startsWith(key)))
      .slice(0, limit)
      .map((r) => ({ ref_id: r["ref_id"], node_type: t, name: r["name"], ...(r["summary"] ? { description: r["summary"] } : {}) }));
  }

  // ── edges ───────────────────────────────────────────────────────────────

  /** The edges around `ids`, deleted ends dropped. Whether a fact end still held is hidden is decided per focal node (`shownFrom`). */
  private async edgesOf(q: Query, ids: string[]): Promise<RawEdge[]> {
    const out: RawEdge[] = [];
    for (const [type, from, to] of RELS) {
      const typeOf = (v: string, k: string) => (k === "Entity" ? `${v}.type` : `'${k}'`);
      const rows = await q(
        `MATCH (a:${from})-[:${type}]->(b:${to}) WHERE (a.ref_id IN $ids OR b.ref_id IN $ids) AND a.deleted_at IS NULL AND b.deleted_at IS NULL
         RETURN a.ref_id AS s, b.ref_id AS t, ${typeOf("a", from)} AS st, ${typeOf("b", to)} AS tt` +
          `${from === "Fact" ? ", a.expired_at AS sx" : ""}${to === "Fact" ? ", b.expired_at AS tx" : ""}`,
        { ids },
      );
      for (const r of rows) {
        out.push({
          type, source: r["s"], target: r["t"], sourceKind: from, targetKind: to, sourceType: r["st"], targetType: r["tt"],
          sourceExpired: r["sx"] != null, targetExpired: r["tx"] != null,
        });
      }
    }
    return out;
  }

  async connectionCounts(ref_id: string): Promise<ConnectionCount[]> {
    const q = await this.db();
    if (!q) return [];
    const counts = new Map<string, ConnectionCount>();
    for (const e of await this.edgesOf(q, [ref_id])) {
      for (const dir of ["out", "in"] as const) {
        const focal = dir === "out" ? e.source : e.target;
        if (focal !== ref_id || !shownFrom(e, ref_id)) continue;
        const other = dir === "out" ? e.targetType : e.sourceType;
        const key = `${e.type}|${other}|${dir}`;
        const c = counts.get(key) ?? { edge_type: e.type, target_type: other, direction: dir, count: 0 };
        c.count++;
        counts.set(key, c);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.edge_type.localeCompare(b.edge_type));
  }

  /** `{ref_id: {EDGE: n, "<-EDGE": n}}`: outgoing by type, incoming marked `<-`, as graph-get's own map reads. */
  async edgeCounts(ref_ids: string[], namespace?: string): Promise<Record<string, Record<string, number>>> {
    if (namespace) await this.resolveNamespace(namespace);
    const q = await this.db();
    const out: Record<string, Record<string, number>> = {};
    if (!q || ref_ids.length === 0) return out;
    const focal = new Set(ref_ids);
    for (const e of await this.edgesOf(q, ref_ids)) {
      if (focal.has(e.source) && shownFrom(e, e.source)) ((out[e.source] ??= {})[e.type] = ((out[e.source] ?? {})[e.type] ?? 0) + 1);
      if (focal.has(e.target) && shownFrom(e, e.target)) ((out[e.target] ??= {})[`<-${e.type}`] = ((out[e.target] ?? {})[`<-${e.type}`] ?? 0) + 1);
    }
    return out;
  }

  async neighbors(ref_id: string, p: NeighborsParams = {}): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }> {
    await this.resolveNamespace(p.namespace);
    const q = await this.db();
    const empty = { nodes: [], edges: [] };
    if (!q) return empty;
    const center = await this.getNode(ref_id);
    if (!center) return empty;
    const terms = await this.terms();
    const edgeTypes = p.edge_types?.length ? new Set(p.edge_types.map((e) => e.replace(/[<>]/g, "").toUpperCase())) : undefined;
    const nodeTypes = p.node_types?.length ? new Set(p.node_types.flatMap((t) => typeNames(terms, t))) : undefined;
    const excluded = new Set((p.exclude_node_types ?? []).map((t) => t.toLowerCase()));

    // Each edge with the node at its far end.
    type Hop = { edge: RawEdge; other: string; kind: Kind; forward: boolean };
    let hops: Hop[] = [];
    for (const e of await this.edgesOf(q, [ref_id])) {
      if (!shownFrom(e, ref_id) || (edgeTypes && !edgeTypes.has(e.type))) continue;
      if (e.source === ref_id && p.direction !== "reverse") hops.push({ edge: e, other: e.target, kind: e.targetKind, forward: true });
      if (e.target === ref_id && p.direction !== "forward") hops.push({ edge: e, other: e.source, kind: e.sourceKind, forward: false });
    }
    const ids = (k: Kind) => [...new Set(hops.filter((h) => h.kind === k).map((h) => h.other))];
    const byId = new Map<string, NodeEnvelope>();
    for (const n of [
      ...(await loadEntities(q, ids("Entity"))),
      ...(await loadFacts(q, ids("Fact"))),
      ...(await loadEpisodes(q, ids("Episode"))),
    ]) byId.set(n.ref_id, n);
    hops = hops.filter((h) => {
      const n = byId.get(h.other);
      if (!n) return false;
      const t = n.node_type ?? "";
      return (!nodeTypes || nodeTypes.has(t)) && !excluded.has(t.toLowerCase());
    });
    // Newest first: what was learned last leads.
    const recency = (h: Hop) => Number(byId.get(h.other)?.date_added_to_graph ?? 0);
    hops = hops.map((h, i) => [h, i] as const).sort(([a, i], [b, j]) => recency(b) - recency(a) || i - j).map(([h]) => h);
    if (p.limit && p.limit > 0) hops = hops.slice(0, p.limit);

    const nodes: NodeEnvelope[] = [center];
    const seen = new Set([ref_id]);
    for (const h of hops) {
      if (seen.has(h.other)) continue;
      seen.add(h.other);
      nodes.push(byId.get(h.other)!);
    }
    const edges: EdgeEnvelope[] = hops.map((h) => ({
      source: h.edge.source,
      target: h.edge.target,
      ref_id: `${h.edge.type}:${h.edge.source}:${h.edge.target}`,
      edge_type: h.edge.type,
      properties: {},
    }));
    if (p.include_edge_counts) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return { nodes, edges };
  }

  // ── search ──────────────────────────────────────────────────────────────

  async search(p: SearchParams): Promise<SearchResult> {
    await this.resolveNamespace(p.namespace);
    const empty: SearchResult = { nodes: [], total: 0, truncated: false };
    const warnings: string[] = [];
    if (p.input_q?.trim() || p.output_q?.trim()) warnings.push("input_q / output_q: the memory keeps no per-field vectors; only q is searched");
    if (p.linked?.length) warnings.push("linked: not supported on the memory graph; ignored");
    const qstr = (p.q ?? "").trim();
    const withWarnings = (r: SearchResult): SearchResult => (warnings.length ? { ...r, warnings } : r);
    if (!qstr) return withWarnings(empty);
    const db = await this.db();
    if (!db) return withWarnings(empty);
    const stop = await memoryStopWords(this.ctx()).catch((e: Error) => {
      throw new GraphReadError("INVALID_INPUT", e.message);
    });
    const terms = await this.terms();

    // Which kinds and types: `type` resolves the vocabulary's aliases; `domains` are entity / predicate / memory.
    const wanted = p.types?.length ? p.types.flatMap((t) => typeNames(terms, t)) : undefined;
    const domains = p.domains?.length ? new Set(p.domains.map((d) => d.toLowerCase())) : undefined;
    const allEntities = !wanted || wanted.includes(BASE_ENTITY);
    const entityTypes = wanted && !allEntities ? new Set(wanted) : undefined;
    const entities = (!wanted || allEntities || wanted.some((t) => t !== "Fact" && t !== "Episode")) && (!domains || domains.has("entity"));
    const facts = (!wanted || wanted.includes("Fact")) && (!domains || domains.has(MEMORY_DOMAIN));
    const episodes = !!wanted?.includes("Episode") && (!domains || domains.has(MEMORY_DOMAIN));

    const scored = await scoreMemory(db, { q: qstr, stop, entities, entityTypes, facts, episodes });
    const limit = p.limit ?? 10;
    const skip = p.skip ?? 0;
    const page = scored.slice(skip, skip + Math.max(1, limit));
    const ids = (k: Kind) => page.filter((h) => h.kind === k.toLowerCase()).map((h) => String(h.row["ref_id"]));
    const byId = new Map<string, NodeEnvelope>();
    for (const n of [...(await loadEntities(db, ids("Entity"))), ...(await loadFacts(db, ids("Fact"))), ...(await loadEpisodes(db, ids("Episode")))]) byId.set(n.ref_id, n);
    const nodes: NodeEnvelope[] = [];
    for (const h of page) {
      const n = byId.get(String(h.row["ref_id"]));
      if (n) nodes.push({ ...n, score: h.score, match_type: "fulltext" });
    }
    if (p.include_edge_counts && nodes.length) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id));
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return withWarnings({ nodes, total: scored.length, truncated: scored.length > skip + nodes.length });
  }

  // ── schemas ─────────────────────────────────────────────────────────────

  async listSchemas(opts: { domains?: string[]; includeDeleted?: boolean } = {}): Promise<{ schemas: SchemaEnvelope[]; edges: OntologyEdge[] }> {
    const domains = opts.domains?.length ? new Set(opts.domains.map((d) => d.toLowerCase())) : undefined;
    const schemas = allSchemas(await this.terms()).filter((s) => !domains || domains.has(String(s["domain"])));
    const edges: OntologyEdge[] = RELS.map(([edge_type, s, t]) => ({ edge_type, source_type: s === "Entity" ? BASE_ENTITY : s, target_type: t === "Entity" ? BASE_ENTITY : t }));
    return { schemas, edges: !domains || domains.has("entity") || domains.has(MEMORY_DOMAIN) ? edges : [] };
  }

  async getSchema(type: string): Promise<SchemaEnvelope | null> {
    const terms = await this.terms();
    const name = typeNames(terms, type)[0] ?? resolveType(terms, type) ?? type;
    const key = name.toLowerCase();
    const all = allSchemas(terms);
    return all.find((s) => s.type.toLowerCase() === key) ?? all.find((s) => (s["term_names"] as string[] | undefined)?.includes(key)) ?? null;
  }
}

/** The node schema `graph-get` looks a type up in (its node_key, its title and description fields). */
class MemorySchemas {
  constructor(private readonly reader: MemoryReader) {}

  async schema(raw: string): Promise<NodeSchema | null> {
    const env = await this.reader.getSchema(raw);
    if (!env || env["domain"] === "predicate") return null;
    return {
      type: env.type,
      node_key: env.type === "Fact" || env.type === "Episode" ? `${env.type}-ref_id` : `${env.type}-name`,
      index: [],
      vector_index: [],
      embed: false,
      attributes: Object.fromEntries(Object.entries(env.attributes).map(([k, v]) => [k, String(v)])),
      title_key: "name",
      description_key: "description",
      domainLabels: [],
      isStrut: false,
    };
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────

/** Whether `e` is shown from `focal`: a fact no longer held is hidden at the far end, except along the edges that are history. */
function shownFrom(e: RawEdge, focal: string): boolean {
  if (HISTORY.has(e.type)) return true;
  const farExpired = e.source === focal ? e.targetExpired : e.sourceExpired;
  return !farExpired;
}

/** The entity type a given name means: its name, or one of its aliases, however written ("user" → Self). */
function resolveType(terms: Term[], given: string): string | undefined {
  const snaked = snake(given);
  const key = snaked.replace(/_/g, "");
  return terms.find((t) => t.kind === "entity_type" && (t.name.toLowerCase() === key || t.aliases.includes(key) || t.aliases.includes(snaked)))?.name;
}

/** The node types a `type` filter names: Fact, Episode, the base Entity (every entity type), or an entity type or alias; an unknown one as written (it matches nothing). */
function typeNames(terms: Term[], given: string): string[] {
  const t = given.trim();
  const lower = t.toLowerCase();
  if (lower === "fact") return ["Fact"];
  if (lower === "episode") return ["Episode"];
  if (lower === "entity") return [BASE_ENTITY];
  return [resolveType(terms, t) ?? t];
}

const iso0 = (ms: unknown) => iso(ms);

async function loadEntities(q: Query, ids: string[]): Promise<NodeEnvelope[]> {
  if (!ids.length) return [];
  const rows = await q(
    `MATCH (e:Entity) WHERE e.ref_id IN $ids AND e.deleted_at IS NULL
     RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases,
            e.attributes AS attributes, e.created_by AS created_by, e.created_at AS created_at, e.updated_at AS updated_at`,
    { ids },
  );
  return rows.map((e: Row) => ({
    ref_id: e["ref_id"],
    node_type: e["type"],
    name: e["name"],
    date_added_to_graph: Number(e["created_at"] ?? 0),
    properties: {
      name: e["name"],
      description: e["summary"] ?? "",
      summary: e["summary"] ?? "",
      aliases: e["aliases"] ?? [],
      attributes: readAttributes(e["attributes"]),
      created_by: e["created_by"],
      created_at: iso0(e["created_at"]),
      updated_at: iso0(e["updated_at"]),
    },
  }));
}

async function loadFacts(q: Query, ids: string[]): Promise<NodeEnvelope[]> {
  if (!ids.length) return [];
  // Filters in WHERE, not inline: an inline parameter filter plus OPTIONAL MATCH reads null in Ladybug 0.21.2 (memory/get).
  const rows = await q(
    `MATCH (f:Fact) WHERE f.ref_id IN $ids AND f.deleted_at IS NULL
     OPTIONAL MATCH (f)-[:SUBJECT]->(s:Entity)
     OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
     RETURN f.ref_id AS ref_id, f.predicate AS predicate, f.text AS text, f.confidence AS confidence, f.valid_at AS valid_at,
            f.invalid_at AS invalid_at, f.expired_at AS expired_at, f.created_by AS created_by, f.created_at AS created_at,
            f.updated_at AS updated_at, f.value AS value, f.form AS form,
            s.ref_id AS s_id, s.name AS s_name, o.ref_id AS o_id, o.name AS o_name`,
    { ids },
  );
  return rows.map((f: Row) => ({
    ref_id: f["ref_id"],
    node_type: "Fact",
    name: f["text"],
    date_added_to_graph: Number(f["created_at"] ?? 0),
    properties: {
      name: f["text"],
      text: f["text"],
      description: factDescription({ ...f, subject: f["s_name"], object: f["o_name"] }),
      predicate: f["predicate"],
      subject: f["s_name"],
      subject_ref_id: f["s_id"],
      ...(f["o_id"] ? { object: f["o_name"], object_ref_id: f["o_id"] } : {}),
      confidence: f["confidence"],
      valid_at: iso0(f["valid_at"]),
      invalid_at: iso0(f["invalid_at"]),
      expired_at: iso0(f["expired_at"]),
      // No longer held: superseded or ended.
      current: f["expired_at"] == null,
      ...(f["value"] ? { value: f["value"] } : {}),
      ...(f["form"] ? { form: f["form"] } : {}),
      created_by: f["created_by"],
      created_at: iso0(f["created_at"]),
      updated_at: iso0(f["updated_at"]),
    },
  }));
}

async function loadEpisodes(q: Query, ids: string[]): Promise<NodeEnvelope[]> {
  if (!ids.length) return [];
  const rows = await q(
    `MATCH (ep:Episode) WHERE ep.ref_id IN $ids AND ep.deleted_at IS NULL
     RETURN ep.ref_id AS ref_id, ep.kind AS kind, ep.source AS source, ep.content AS content, ep.occurred_at AS occurred_at,
            ep.created_by AS created_by, ep.created_at AS created_at, ep.speaker AS speaker`,
    { ids },
  );
  return rows.map((ep: Row) => ({
    ref_id: ep["ref_id"],
    node_type: "Episode",
    name: String(ep["content"] ?? "").slice(0, 160),
    date_added_to_graph: Number(ep["created_at"] ?? 0),
    properties: {
      name: String(ep["content"] ?? "").slice(0, 160),
      content: ep["content"],
      description: `${ep["kind"]}${ep["source"] ? ` · ${ep["source"]}` : ""}${ep["occurred_at"] != null ? ` · ${iso0(ep["occurred_at"])?.slice(0, 10)}` : ""}`,
      kind: ep["kind"],
      source: ep["source"],
      ...(ep["speaker"] ? { speaker: ep["speaker"] } : {}),
      occurred_at: iso0(ep["occurred_at"]),
      created_by: ep["created_by"],
      created_at: iso0(ep["created_at"]),
    },
  }));
}

const FACT_ATTRIBUTES = {
  name: "string", text: "string", predicate: "string", subject: "string", subject_ref_id: "string", object: "?string", object_ref_id: "?string",
  description: "string", confidence: "?float", valid_at: "?datetime", invalid_at: "?datetime", expired_at: "?datetime", current: "boolean",
  value: "?string", form: "?string", created_by: "?string", created_at: "?datetime", updated_at: "?datetime",
};
const EPISODE_ATTRIBUTES = {
  name: "string", content: "string", description: "string", kind: "string", source: "?string", speaker: "?string",
  occurred_at: "?datetime", created_by: "?string", created_at: "?datetime",
};
const ENTITY_ATTRIBUTES = {
  name: "string", description: "?string", summary: "?string", aliases: "?list", attributes: "?json",
  created_by: "?string", created_at: "?datetime", updated_at: "?datetime",
};

/** Every schema the memory has: the base Entity, each entity type, each predicate, Fact and Episode. */
function allSchemas(terms: Term[]): Array<SchemaEnvelope & Record<string, unknown>> {
  const list = (xs: string[]) => xs.join(", ");
  const out: Array<SchemaEnvelope & Record<string, unknown>> = [
    {
      type: BASE_ENTITY, domain: MEMORY_DOMAIN,
      description: "Anything the memory is about; its node_type is one of the entity types below (search type Entity for all of them).",
      attributes: ENTITY_ATTRIBUTES, inherited_attributes: {},
    },
    {
      type: "Fact", domain: MEMORY_DOMAIN,
      description:
        "One sentence the memory holds about an entity (SUBJECT), possibly linking another (OBJECT), with the episode it came from (FROM_EPISODE). " +
        "A fact that changed is superseded, never overwritten: SUPERSEDES leads to the fact it replaced, which is no longer `current`.",
      attributes: FACT_ATTRIBUTES, inherited_attributes: {},
    },
    {
      type: "Episode", domain: MEMORY_DOMAIN,
      description: "What was said or observed, as said: the source of facts (FROM_EPISODE), mentioning the entities it was about (MENTIONS).",
      attributes: EPISODE_ATTRIBUTES, inherited_attributes: {},
    },
  ];
  for (const t of terms) {
    const termAttributes = {
      ...(t.aliases.length ? { term_aliases: list(t.aliases) } : {}),
      ...(t.parent ? { parent: t.parent } : {}),
      ...(t.naming ? { naming: t.naming } : {}),
      ...(t.role ? { role: t.role } : {}),
      status: t.status,
    };
    const names = [t.name.toLowerCase(), ...t.aliases.map((a) => a.toLowerCase()), t.name.toLowerCase().replace(/_/g, "")];
    if (t.kind === "entity_type") {
      out.push({
        type: t.name, domain: "entity", parent: t.parent || BASE_ENTITY, term_names: names,
        description:
          `${t.description}${t.aliases.length ? ` Also called: ${list(t.aliases)}.` : ""}${t.parent ? ` Fits wherever ${t.parent} does.` : ""}` +
          `${t.naming ? ` Names matched as: ${t.naming}.` : ""}${t.role === "user" ? " This is the user." : t.role ? ` Role: ${t.role}.` : ""} Status: ${t.status}.`.trimEnd(),
        attributes: { ...ENTITY_ATTRIBUTES, ...termAttributes },
        inherited_attributes: {},
      });
    } else {
      const connects = `${t.subject_types.length ? list(t.subject_types) : "any"} → ${t.object_types.length ? list(t.object_types) : "no object"}`;
      const cardinality = t.cardinality === "one" ? "one — a new fact replaces the current one" : "many — facts accumulate";
      out.push({
        type: t.name, domain: "predicate", term_names: names,
        description:
          `${t.description} Predicate of a Fact (the fact's predicate). Cardinality: ${cardinality}. Connects: ${connects}.` +
          `${t.aliases.length ? ` Also called: ${list(t.aliases)}.` : ""}${t.role ? ` Role: ${t.role}.` : ""} Status: ${t.status}.`,
        attributes: {
          cardinality: cardinality,
          subject_types: list(t.subject_types) || "any",
          object_types: list(t.object_types) || "none",
          ...termAttributes,
        },
        inherited_attributes: {},
      });
    }
  }
  return out;
}
