/**
 * The memory graph (src/steps/lib/memory/) as a read-only graph backend, so
 * the `graph/*` read steps — graph-search, graph-get, graph-get-batched,
 * graph-neighbors, get-ontology, get-ontology-type, walk — read a person's
 * memory with the inputs and output shapes they have on the workspace graph.
 * `graphCtx` returns it for an agent's tool call in a workflow the host
 * named (`memoryGraph.workflows`); everything else reads the workspace graph.
 *
 * It reads through `memoryDb(ctx)`, the memory's own read connection: no
 * second Database is opened on the file. Nothing here writes: the writers,
 * the schema writes and the engine (`query`, `tx`, `graph/find`) throw
 * `read-only`; memory/remember, forget and merge are the writes.
 *
 *   - Entity, Fact and Episode are nodes. An entity's node_type is its
 *     memory type (Person, Self, …); the others are `Fact` and `Episode`.
 *   - MENTIONS, SUBJECT, OBJECT, FROM_EPISODE, SUPERSEDES, CONTRADICTS and
 *     ALIAS_OF are edges, as stored. An edge has no ref_id of its own: it is
 *     `<source>|<EDGE>|<target>`.
 *   - A forgotten node (deleted_at) is never shown. A fact no longer held
 *     (expired, or its end in the world passed) is left out of search,
 *     neighbors and edge counts; getNode still opens one, flagged
 *     `superseded` or `invalid`.
 *   - The vocabulary is the ontology: each entity type is a schema; `Fact`
 *     lists the predicates as the values of its `predicate` attribute.
 *   - Search is memory/recall's word matching (`_search.ts`); what it cannot
 *     honour (linked, domains, input_q, output_q, a namespace) is a warning.
 */
import type { StepContext } from "../../core.js";
import { canonical, iso, memoryDb, normalize, type Query, type Row } from "../../steps/lib/memory/_db.js";
import { vocabulary, type Term, type Vocabulary } from "../../steps/lib/memory/_ontology.js";
import { factLine, searchMemory, stopWords } from "../../steps/lib/memory/_search.js";
import type { EdgeWriter } from "../edge-writer.js";
import type { NodeWriter } from "../node-writer.js";
import type { NodeSchema, SchemaResolver } from "../schema-resolver.js";
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

/** The memory graph as the read steps see it. */
export interface MemoryBackend {
  readonly kind: "memory";
  readonly namespace: string;
  readonly reader: GraphReader;
  /** `schema(type)` answers (graph-get by node_type + name, its children);
   *  every other method throws read-only. */
  readonly schemas: SchemaResolver;
  /** Throw read-only. */
  readonly nodes: NodeWriter;
  readonly edges: EdgeWriter;
  query(): Promise<never>;
  tx(): Promise<never>;
}

export const MEMORY_DOMAIN = "memory";
/** At most this many neighbors per call, whatever the caller asks. */
export const MEMORY_NEIGHBOR_CAP = 50;

type Table = "Entity" | "Fact" | "Episode";
const TABLES: Table[] = ["Entity", "Fact", "Episode"];

/** The memory's edge tables (src/steps/lib/memory/_db.ts). */
const RELS: Array<[edge: string, from: Table, to: Table]> = [
  ["MENTIONS", "Episode", "Entity"],
  ["SUBJECT", "Fact", "Entity"],
  ["OBJECT", "Fact", "Entity"],
  ["FROM_EPISODE", "Fact", "Episode"],
  ["SUPERSEDES", "Fact", "Fact"],
  ["CONTRADICTS", "Fact", "Fact"],
  ["ALIAS_OF", "Entity", "Entity"],
];

/** What a search, a neighbor list or an edge count may show of a table. */
const SHOWN: Record<Table, (a: string) => string> = {
  Entity: (a) => `${a}.deleted_at IS NULL`,
  Episode: (a) => `${a}.deleted_at IS NULL`,
  Fact: (a) => `${a}.deleted_at IS NULL AND ${a}.expired_at IS NULL AND (${a}.invalid_at IS NULL OR ${a}.invalid_at > $now)`,
};

export class MemoryReadOnlyError extends Error {
  constructor(what: string) {
    super(`read-only: the memory graph cannot ${what}; memory/remember, memory/forget and memory/merge write it`);
    this.name = "MemoryReadOnlyError";
  }
}

/** An object whose every method throws read-only, typed as what it stands in for. */
function refusing<T>(what: string, answers: Record<string, unknown> = {}): T {
  return new Proxy(answers, {
    get(target, key) {
      if (typeof key === "string" && key in target) return target[key];
      if (key === "then") return undefined;
      return () => {
        throw new MemoryReadOnlyError(`${what}.${String(key)}`);
      };
    },
  }) as T;
}

const BACKENDS = new WeakMap<Query, Promise<MemoryBackend>>();

/** The memory graph of `ctx`'s deployment, built once per memory file. */
export function memoryGraph(ctx?: StepContext<unknown>): Promise<MemoryBackend> {
  return memoryDb(ctx).then((query) => {
    let b = BACKENDS.get(query);
    if (!b) {
      b = stopWords(ctx).then((stop) => memoryBackend(query, stop));
      BACKENDS.set(query, b);
      b.catch(() => BACKENDS.delete(query));
    }
    return b;
  });
}

/** The backend over one memory read connection. */
export function memoryBackend(query: Query, stop: Set<string>): MemoryBackend {
  const reader = new MemoryReader(query, stop);
  return {
    kind: "memory",
    namespace: DEFAULT_NAMESPACE,
    reader,
    schemas: refusing<SchemaResolver>("schemas", { schema: (type: string) => reader.nodeSchema(type) }),
    nodes: refusing<NodeWriter>("nodes"),
    edges: refusing<EdgeWriter>("edges"),
    query: async () => {
      throw new MemoryReadOnlyError("run a graph query");
    },
    tx: async () => {
      throw new MemoryReadOnlyError("open a write transaction");
    },
  };
}

/** An entity type's name, `Fact`, `Episode`, or undefined. */
function canonicalType(vocab: Vocabulary, given: string): string | undefined {
  const g = given.trim();
  if (g.toLowerCase() === "fact") return "Fact";
  if (g.toLowerCase() === "episode") return "Episode";
  return vocab.term("entity_type", g)?.name;
}

const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export class MemoryReader implements GraphReader {
  constructor(
    private readonly query: Query,
    private readonly stop: Set<string>,
  ) {}

  async listNamespaces(): Promise<string[]> {
    return [];
  }

  async registerNamespace(): Promise<never> {
    throw new MemoryReadOnlyError("register a namespace");
  }

  async resolveNamespace(namespace: string | undefined): Promise<string> {
    if (namespace && namespace !== DEFAULT_NAMESPACE) throw new GraphReadError("INVALID_NAMESPACE", `the memory graph has one namespace, default; got ${namespace}`);
    return DEFAULT_NAMESPACE;
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────

  /** Entity, then Fact, then Episode: a ref_id carries no table. A
   *  merged-away entity leads to the one it was merged into. */
  async getNode(ref_id: string): Promise<NodeEnvelope | null> {
    const id = await canonical(this.query, ref_id);
    for (const table of TABLES) {
      const [row] = await this.query(`MATCH (n:${table}) WHERE n.ref_id = $id AND n.deleted_at IS NULL RETURN n`, { id });
      if (row) return (await this.envelopes(table, [row["n"] as Row], true))[0]!;
    }
    return null;
  }

  /** An entity by type and name: `node_key` is graph-get's
   *  `<type>-<hex of the name>` (`nodeSchema` keys entities by name). */
  async getNodeByKey(type: string, node_key: string, namespace?: string): Promise<NodeEnvelope | null> {
    await this.resolveNamespace(namespace);
    const vocab = await vocabulary(this.query);
    const t = canonicalType(vocab, type);
    if (!t || t === "Fact" || t === "Episode") return null;
    const hex = node_key.slice(node_key.indexOf("-") + 1);
    const name = Buffer.from(hex, "hex").toString("utf8");
    // As memory/get: the user type is its one entity; else a name before an alias, then the oldest.
    const rows = vocab.role(t) === "user"
      ? await this.query("MATCH (n:Entity) WHERE n.type = $t AND n.deleted_at IS NULL RETURN n ORDER BY n.created_at LIMIT 1", { t })
      : await this.query(
          `MATCH (n:Entity) WHERE n.type = $t AND n.deleted_at IS NULL AND (lower(n.name) = $key OR list_contains(n.aliases, $key))
           RETURN n ORDER BY CASE WHEN lower(n.name) = $key THEN 0 ELSE 1 END, n.created_at LIMIT 1`,
          { t, key: normalize(name) },
        );
    return rows[0] ? (await this.envelopes("Entity", [rows[0]["n"] as Row], false))[0]! : null;
  }

  async namesLike(type: string, q: string, limit = 10, namespace?: string): Promise<NameHit[]> {
    await this.resolveNamespace(namespace);
    const t = canonicalType(await vocabulary(this.query), type);
    if (!t || t === "Fact" || t === "Episode") return [];
    const rows = await this.query(
      `MATCH (n:Entity) WHERE n.type = $t AND n.deleted_at IS NULL AND lower(n.name) CONTAINS $q
       RETURN n.ref_id AS ref_id, n.name AS name, n.summary AS summary ORDER BY n.name LIMIT ${Math.max(1, Math.floor(limit))}`,
      { t, q: normalize(q) },
    );
    return rows.map((r) => ({ ref_id: r["ref_id"], node_type: t, name: r["name"], ...(r["summary"] ? { description: r["summary"] } : {}) }));
  }

  /** Node envelopes for rows of one table, in their order. `opened`: the
   *  caller asked for these by ref_id, so a fact no longer held is flagged. */
  private async envelopes(table: Table, rows: Row[], opened: boolean): Promise<NodeEnvelope[]> {
    if (!rows.length) return [];
    if (table === "Entity") {
      const vocab = await vocabulary(this.query);
      return rows.map((n) => {
        let attributes: unknown = {};
        try {
          attributes = JSON.parse(n["attributes"] || "{}");
        } catch {
          // stays {}
        }
        return {
          ref_id: n["ref_id"],
          node_type: n["type"],
          name: n["name"],
          properties: defined({
            name: n["name"],
            summary: n["summary"] || undefined,
            aliases: n["aliases"] ?? [],
            attributes,
            // Marks the user, so a reader needs no type name to know them (memory/get).
            user: vocab.role(n["type"]) === "user" ? true : undefined,
            created_by: n["created_by"],
            created_at: iso(n["created_at"]),
            updated_at: iso(n["updated_at"]),
          }),
        };
      });
    }
    if (table === "Episode") {
      return rows.map((n) => {
        const at = iso(n["occurred_at"]);
        return {
          ref_id: n["ref_id"],
          node_type: "Episode",
          // An episode has no name: its kind and day.
          name: `${n["kind"] ?? "episode"}${at ? ` · ${at.slice(0, 10)}` : ""}`,
          properties: defined({
            kind: n["kind"],
            source: n["source"] || undefined,
            content: n["content"],
            speaker: n["speaker"] || undefined,
            occurred_at: at,
            created_by: n["created_by"],
          }),
        };
      });
    }
    const ids = rows.map((n) => n["ref_id"] as string);
    const ends = await this.query(
      `MATCH (f:Fact) WHERE f.ref_id IN $ids
       OPTIONAL MATCH (f)-[:SUBJECT]->(s:Entity)
       OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
       OPTIONAL MATCH (by:Fact)-[:SUPERSEDES]->(f) WHERE by.deleted_at IS NULL
       RETURN f.ref_id AS ref_id, s.name AS subject, s.ref_id AS subject_ref_id, o.name AS object, o.ref_id AS object_ref_id,
              count(by) AS superseded_by`,
      { ids },
    );
    const byId = new Map(ends.map((e) => [e["ref_id"] as string, e]));
    const now = Date.now();
    return rows.map((n) => {
      const e = byId.get(n["ref_id"]) ?? {};
      const expired = n["expired_at"] != null;
      const ended = n["invalid_at"] != null && Number(n["invalid_at"]) <= now;
      const superseded = expired && Number(e["superseded_by"] ?? 0) > 0;
      return {
        ref_id: n["ref_id"],
        node_type: "Fact",
        name: n["text"],
        properties: defined({
          text: n["text"],
          predicate: n["predicate"],
          description: factLine({ ...n, subject: e["subject"], object: e["object"] }),
          subject: e["subject_ref_id"] ? { ref_id: e["subject_ref_id"], name: e["subject"] } : undefined,
          object: e["object_ref_id"] ? { ref_id: e["object_ref_id"], name: e["object"] } : undefined,
          confidence: num(n["confidence"]),
          value: n["value"] || undefined,
          form: n["form"] || undefined,
          valid_at: iso(n["valid_at"]),
          invalid_at: iso(n["invalid_at"]),
          created_at: iso(n["created_at"]),
          expired_at: iso(n["expired_at"]),
          created_by: n["created_by"],
          // Only on a fact asked for by ref_id: search and neighbors never show one.
          superseded: opened && superseded ? true : undefined,
          invalid: opened && !superseded && (expired || ended) ? true : undefined,
        }),
      };
    });
  }

  /** The envelopes of `ids`, whichever table holds each; missing ones left out. */
  private async nodesById(ids: string[], shownOnly: boolean): Promise<Map<string, NodeEnvelope>> {
    const out = new Map<string, NodeEnvelope>();
    if (!ids.length) return out;
    for (const table of TABLES) {
      const left = ids.filter((id) => !out.has(id));
      if (!left.length) break;
      const rows = await this.query(
        `MATCH (n:${table}) WHERE n.ref_id IN $ids AND ${shownOnly ? SHOWN[table]("n") : "n.deleted_at IS NULL"} RETURN n`,
        { ids: left, now: Date.now() },
      );
      for (const env of await this.envelopes(table, rows.map((r) => r["n"] as Row), !shownOnly)) out.set(env.ref_id, env);
    }
    return out;
  }

  /** The table holding `ref_id` (not forgotten), or undefined. */
  private async tableOf(ref_id: string): Promise<Table | undefined> {
    for (const table of TABLES) {
      if ((await this.query(`MATCH (n:${table}) WHERE n.ref_id = $id AND n.deleted_at IS NULL RETURN n.ref_id AS id`, { id: ref_id })).length) return table;
    }
    return undefined;
  }

  // ── Edges ─────────────────────────────────────────────────────────────────

  /** Every shown edge at `ref_id`: its type, direction, and the other end's
   *  ref_id, table and created_at, newest other end first. */
  private async edgesAt(ref_id: string): Promise<Array<{ edge: string; direction: "out" | "in"; other: string; table: Table; type: string; at: number }>> {
    const table = await this.tableOf(ref_id);
    if (!table) return [];
    const now = Date.now();
    const out: Array<{ edge: string; direction: "out" | "in"; other: string; table: Table; type: string; at: number }> = [];
    for (const [edge, from, to] of RELS) {
      for (const direction of ["out", "in"] as const) {
        if ((direction === "out" ? from : to) !== table) continue;
        const other = direction === "out" ? to : from;
        const pattern = direction === "out" ? `(a:${from})-[:${edge}]->(x:${to})` : `(x:${from})-[:${edge}]->(a:${to})`;
        const rows = await this.query(
          `MATCH ${pattern} WHERE a.ref_id = $id AND ${SHOWN[other]("x")}
           RETURN x.ref_id AS ref_id, ${other === "Entity" ? "x.type" : `'${other}'`} AS type, x.created_at AS at`,
          { id: ref_id, now },
        );
        for (const r of rows) out.push({ edge, direction, other: r["ref_id"], table: other, type: r["type"], at: Number(r["at"] ?? 0) });
      }
    }
    return out.sort((a, b) => b.at - a.at || a.other.localeCompare(b.other));
  }

  async connectionCounts(ref_id: string, namespace?: string): Promise<ConnectionCount[]> {
    await this.resolveNamespace(namespace);
    const counts = new Map<string, ConnectionCount>();
    for (const e of await this.edgesAt(ref_id)) {
      const key = `${e.edge}|${e.type}|${e.direction}`;
      const c = counts.get(key) ?? { edge_type: e.edge, target_type: e.type, direction: e.direction, count: 0 };
      c.count += 1;
      counts.set(key, c);
    }
    return [...counts.values()];
  }

  /** `{ref_id: {EDGE_TYPE: count}}`, both directions together, as the
   *  workspace readers count. */
  async edgeCounts(ref_ids: string[], namespace: string): Promise<Record<string, Record<string, number>>> {
    await this.resolveNamespace(namespace);
    const out: Record<string, Record<string, number>> = {};
    for (const id of ref_ids) {
      const m: Record<string, number> = {};
      for (const e of await this.edgesAt(id)) m[e.edge] = (m[e.edge] ?? 0) + 1;
      out[id] = m;
    }
    return out;
  }

  async neighbors(ref_id: string, p: NeighborsParams = {}): Promise<{ nodes: NodeEnvelope[]; edges: EdgeEnvelope[] }> {
    await this.resolveNamespace(p.namespace);
    const source = await this.getNode(ref_id);
    if (!source) return { nodes: [], edges: [] };
    const vocab = await vocabulary(this.query);
    const typeSet = (ts?: string[]) => (ts?.length ? new Set(ts.map((t) => canonicalType(vocab, t) ?? t)) : undefined);
    const only = typeSet(p.node_types);
    const exclude = typeSet(p.exclude_node_types);
    const edgeTypes = p.edge_types?.length ? new Set(p.edge_types.map((e) => e.replace(/[<>]/g, "").trim().toUpperCase())) : undefined;
    const limit = Math.min(p.limit ?? MEMORY_NEIGHBOR_CAP, MEMORY_NEIGHBOR_CAP);
    const picked = (await this.edgesAt(source.ref_id))
      .filter((e) => !edgeTypes || edgeTypes.has(e.edge))
      .filter((e) => (p.direction === "forward" ? e.direction === "out" : p.direction === "reverse" ? e.direction === "in" : true))
      .filter((e) => (!only || only.has(e.type)) && !exclude?.has(e.type))
      .slice(0, limit);
    const others = await this.nodesById([...new Set(picked.map((e) => e.other))], true);
    if (p.include_edge_counts) {
      const counts = await this.edgeCounts([...others.keys()], DEFAULT_NAMESPACE);
      for (const [id, n] of others) n.edges = counts[id] ?? {};
    }
    const edges: EdgeEnvelope[] = picked.map((e) => {
      const [s, t] = e.direction === "out" ? [source.ref_id, e.other] : [e.other, source.ref_id];
      return { source: s, target: t, ref_id: `${s}|${e.edge}|${t}`, edge_type: e.edge, properties: {} };
    });
    return { nodes: [source, ...others.values()], edges };
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(p: SearchParams): Promise<SearchResult> {
    const warnings: string[] = [];
    const ignored = (what: string) => warnings.push(`the memory graph cannot honour ${what}; it was ignored`);
    if (p.input_q) ignored("input_q");
    if (p.output_q) ignored("output_q");
    if (p.linked?.length) ignored("linked");
    if (p.domains?.length && !p.domains.every((d) => d.toLowerCase() === MEMORY_DOMAIN)) ignored("domains");
    if (p.namespace && p.namespace !== DEFAULT_NAMESPACE) ignored(`namespace ${p.namespace}`);
    const limit = Math.max(1, p.limit ?? 20);
    const skip = Math.max(0, p.skip ?? 0);
    if (!p.q?.trim()) return { nodes: [], total: 0, truncated: false, ...(warnings.length ? { warnings } : {}) };

    let types: Set<string> | undefined;
    if (p.types?.length) {
      const vocab = await vocabulary(this.query);
      types = new Set();
      for (const t of p.types) {
        const c = canonicalType(vocab, t);
        if (c && c !== "Episode") types.add(c);
        else warnings.push(c ? "the memory graph does not search episodes; open one from a fact (FROM_EPISODE)" : `unknown type ${t}`);
      }
      if (!types.size) return { nodes: [], total: 0, truncated: false, warnings };
    }
    const hits = await searchMemory(this.query, { q: p.q, types, stop: this.stop, includeExpired: false, includeEnded: false });
    const page = hits.slice(skip, skip + limit);
    const found = await this.nodesById(page.map((h) => h.ref_id), true);
    const max = hits[0]?.score || 1;
    const nodes = page.flatMap((h) => {
      const n = found.get(h.ref_id);
      return n ? [{ ...n, score: Math.round((h.score / max) * 1e6) / 1e6, match_type: "keyword" }] : [];
    });
    if (p.include_edge_counts) {
      const counts = await this.edgeCounts(nodes.map((n) => n.ref_id), DEFAULT_NAMESPACE);
      for (const n of nodes) n.edges = counts[n.ref_id] ?? {};
    }
    return { nodes, total: hits.length, truncated: skip + limit < hits.length, ...(warnings.length ? { warnings } : {}) };
  }

  // ── Ontology ──────────────────────────────────────────────────────────────

  async listSchemas(opts: { domains?: string[]; includeDeleted?: boolean } = {}): Promise<{ schemas: SchemaEnvelope[]; edges: OntologyEdge[] }> {
    if (opts.domains?.length && !opts.domains.some((d) => d.toLowerCase() === MEMORY_DOMAIN)) return { schemas: [], edges: [] };
    const vocab = await vocabulary(this.query);
    const schemas = [
      ...vocab.terms.filter((t) => t.kind === "entity_type").map((t) => entitySchema(t)),
      factSchema(vocab.terms.filter((t) => t.kind === "predicate")),
      EPISODE_SCHEMA,
    ];
    // Entity ends are any entity type: "*".
    const end = (t: Table) => (t === "Entity" ? "*" : t);
    const edges = RELS.map(([edge, from, to]) => ({ edge_type: edge, source_type: end(from), target_type: end(to) }));
    return { schemas, edges };
  }

  async getSchema(type: string): Promise<SchemaEnvelope | null> {
    const vocab = await vocabulary(this.query);
    const t = canonicalType(vocab, type);
    if (!t) return null;
    if (t === "Fact") return factSchema(vocab.terms.filter((x) => x.kind === "predicate"));
    if (t === "Episode") return EPISODE_SCHEMA;
    return entitySchema(vocab.terms.find((x) => x.kind === "entity_type" && x.name === t)!);
  }

  /** The resolver's view of a type, for graph-get: an entity type is keyed
   *  by name (its key the hex of the name, `getNodeByKey`); a fact or an
   *  episode by ref_id alone. */
  async nodeSchema(type: string): Promise<NodeSchema | null> {
    const s = await this.getSchema(type);
    if (!s) return null;
    const entity = s.type !== "Fact" && s.type !== "Episode";
    return {
      type: s.type,
      node_key: entity ? "type-name" : "type",
      exact_key: true,
      index: [],
      vector_index: [],
      embed: false,
      attributes: s.attributes as Record<string, string>,
      title_key: s.type === "Fact" ? "text" : entity ? "name" : "kind",
      description_key: s.type === "Fact" ? "description" : entity ? "summary" : "content",
      domainLabels: [],
      isStrut: false,
    };
  }
}

const ENTITY_ATTRIBUTES = { name: "string", summary: "?string", aliases: "?string[]", attributes: "?json" };

/** An entity type as a schema: its node attributes, then the type's own
 *  vocabulary (other names, parent, naming, role, status) as attributes. */
function entitySchema(t: Term): SchemaEnvelope {
  return {
    type: t.name,
    domain: MEMORY_DOMAIN,
    description: t.description,
    attributes: {
      ...ENTITY_ATTRIBUTES,
      ...defined({
        type_aliases: t.aliases.length ? t.aliases.join(", ") : undefined,
        parent_type: t.parent || undefined,
        naming: t.naming || undefined,
        role: t.role || undefined,
        status: t.status === "active" ? undefined : t.status,
      }),
    },
    inherited_attributes: {},
  };
}

/** One predicate, as a line of the Fact schema's `predicate` attribute. */
function predicateLine(t: Term): string {
  const types = (ts: string[]) => (ts.length ? ts.join("|") : "*");
  const extra = [t.cardinality === "one" ? "one value: a new fact replaces the current one" : "", t.role ? `role ${t.role}` : "", t.status === "active" ? "" : t.status]
    .filter(Boolean);
  return `${t.name} (${types(t.subject_types)} → ${t.object_types.length ? types(t.object_types) : "no object"})` +
    `${t.aliases.length ? ` aka ${t.aliases.join(", ")}` : ""}: ${t.description || "no description"}${extra.length ? ` [${extra.join("; ")}]` : ""}`;
}

function factSchema(predicates: Term[]): SchemaEnvelope {
  return {
    type: "Fact",
    domain: MEMORY_DOMAIN,
    description: "One sentence about an entity (SUBJECT), sometimes linking a second (OBJECT), from the episodes it was said in (FROM_EPISODE). A fact that changes is superseded (SUPERSEDES), never overwritten.",
    attributes: {
      text: "string",
      predicate: `string, one of:\n${predicates.map(predicateLine).join("\n")}`,
      confidence: "?float",
      valid_at: "?datetime",
      invalid_at: "?datetime",
      value: "?string",
      form: "?string",
    },
    inherited_attributes: {},
  };
}

const EPISODE_SCHEMA: SchemaEnvelope = {
  type: "Episode",
  domain: MEMORY_DOMAIN,
  description: "What was said or observed, in the speaker's words: the source of facts (FROM_EPISODE) and what it mentions (MENTIONS).",
  attributes: { kind: "string", content: "string", source: "?string", speaker: "?ref_id", occurred_at: "datetime" },
  inherited_attributes: {},
};
