/**
 * Helpers for the graph tests.
 *
 * `testBackends()` is the one list every behavioral graph suite iterates
 * (plans/ladybug-backend.md §5): ALWAYS a LadybugDB file (a temp directory
 * per suite, removed after; the suite is skipped with the reason printed
 * when the addon or its extensions are missing, as `memory-steps.test.ts`
 * does), and Neo4j when `STRUT_TEST_NEO4J_URI` names one. The Neo4j tests
 * WIPE that database between cases — point it at a throwaway container,
 * never at a jarvis instance. Example:
 *
 *   docker run -d --name strut-neo4j-test -p 7688:7687 \
 *     -e NEO4J_AUTH=neo4j/struttest neo4j:5
 *   STRUT_TEST_NEO4J_URI=bolt://localhost:7688 STRUT_TEST_NEO4J_PASSWORD=struttest \
 *     npm run test:graph
 *
 * The raw-read helpers below (`rawNode`, `rawEdge`, …) give a test the same
 * picture of a node or edge on both engines: a type and the properties
 * stored, as Neo4j's `properties()` reports them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { Bolt, type Neo4jConfig } from "./bolt.js";
import type { GraphKind } from "./engine.js";
import { loadLadybug, openLadybug } from "./ladybug/db.js";
import type { Embedder } from "./node-writer.js";
import { typeLabelOf, typeValue } from "./strut-schemas.js";

export function testGraphConfig(): Neo4jConfig | null {
  const uri = process.env["STRUT_TEST_NEO4J_URI"];
  if (!uri) return null;
  return {
    uri,
    user: process.env["STRUT_TEST_NEO4J_USER"] ?? "neo4j",
    password: process.env["STRUT_TEST_NEO4J_PASSWORD"] ?? "",
    namespace: process.env["STRUT_TEST_NEO4J_NAMESPACE"] ?? "default",
  };
}

// ── The backends a suite runs against ───────────────────────────────────────

export interface TestBackend {
  name: string;
  kind: GraphKind;
  /** The `describe` skip reason, or false. */
  skip: string | false;
  /** A fresh backend for the suite (one per `describe`; `skipBoot`; no
   *  embedder unless one is given — the writer and the reader share it). */
  open(opts?: { embedder?: Embedder }): Promise<GraphBackend>;
  /** Empty the graph between cases (schemas and all on Neo4j — reseed after). */
  wipe(b: GraphBackend): Promise<void>;
  /** Remove every data node and edge, keeping the schemas (Neo4j's `:Schema`
   *  meta-graph and its indexes) — a cheaper reset for a suite that seeds
   *  the ontology once. */
  clear(b: GraphBackend): Promise<void>;
  close(b: GraphBackend): Promise<void>;
}

/** Why Ladybug cannot run here, or null: the addon, then an open with the
 *  extensions, tried once per process. */
const LADYBUG_SKIP: string | null = await (async () => {
  try {
    await loadLadybug();
  } catch (e) {
    return (e as Error).message.split("\n")[0]!;
  }
  const dir = await mkdtemp(join(tmpdir(), "strut-lbug-probe-"));
  try {
    const h = await openLadybug(join(dir, "graph.lbug"));
    await h.close();
    return null;
  } catch (e) {
    return (e as Error).message.split("\n")[0]!;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

const dirs = new WeakMap<GraphBackend, string>();

export function testBackends(): TestBackend[] {
  const out: TestBackend[] = [
    {
      name: "ladybug",
      kind: "ladybug",
      skip: LADYBUG_SKIP ?? false,
      async open(opts = {}) {
        const dir = await mkdtemp(join(tmpdir(), "strut-lbug-test-"));
        const b = await openGraphBackend({ kind: "ladybug", path: join(dir, "graph.lbug"), namespace: "default" }, { embeddings: opts.embedder ?? false, skipBoot: true });
        dirs.set(b, dir);
        return b;
      },
      async wipe(b) {
        if (b.kind !== "ladybug") return;
        // The ontology stays: it is the file's schema, seeded at open (its
        // stamp goes with the ledger; the next open seeds nothing new).
        await b.lbug.exclusive(async (w) => {
          await w("MATCH (n:Node) WHERE n.node_type <> 'Schema' DETACH DELETE n");
          await w("MATCH (m:Migration) DELETE m");
        });
        b.schemas.invalidate();
      },
      async clear(b) {
        if (b.kind !== "ladybug") return;
        await b.lbug.exclusive((w) => w("MATCH (n:Node) WHERE n.node_type <> 'Schema' DETACH DELETE n"));
      },
      async close(b) {
        await b.close();
        const dir = dirs.get(b);
        if (dir) await rm(dir, { recursive: true, force: true });
      },
    },
  ];
  const cfg = testGraphConfig();
  out.push({
    name: "neo4j",
    kind: "neo4j",
    skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set",
    open: (opts = {}) => openGraphBackend(cfg!, { embeddings: opts.embedder ?? false, skipBoot: true }),
    async wipe(b) {
      if (b.kind !== "neo4j") return;
      await wipeGraph(b.bolt);
      b.schemas.invalidate();
    },
    async clear(b) {
      if (b.kind !== "neo4j") return;
      await b.bolt.run(`MATCH (n:Data_Bank) DETACH DELETE n`);
    },
    close: (b) => b.close(),
  });
  return out;
}

/** Lets a suite write `Concept` nodes on either engine: on Ladybug the
 *  file's seed already holds the type; on Neo4j (after `seedStrutDomain`) this
 *  adds the one Schema row the writer validates against — jarvis's shape:
 *  the `General` domain (a node outside every domain is invisible to the
 *  connection counts), `file` / `repo` as gitree's summaries carry — and
 *  drops the resolver's cache. */
export async function seedConceptSchema(b: GraphBackend): Promise<void> {
  if (b.kind !== "neo4j") return;
  await b.bolt.run(
    `MATCH (t:Schema {type: "Thing"})
     MERGE (c:Schema {type: "Concept"})
     ON CREATE SET c.parent = "Thing", c.domain = "General", c.node_key = "concept-name", c.index = ["name", "description", "docs"],
                   c.title_key = "name", c.description_key = "description", c.ref_id = "schema-concept",
                   c.name = "string", c.description = "?string", c.docs = "?string", c.file = "?string", c.repo = "?string"
     MERGE (c)-[:CHILD_OF {ref_id: "schema-concept-child-of"}]->(t)`,
  );
  b.schemas.invalidate();
}

// ── Raw reads on either engine ──────────────────────────────────────────────

/** A pattern over any data node: `(a:Data_Bank)` vs `(a:Node)`. */
export function anyNode(b: GraphBackend, alias: string): string {
  return b.kind === "neo4j" ? `(${alias}:Data_Bank)` : `(${alias}:Node)`;
}

/** A Ladybug Schema row is in the Node table, but it is not data. */
const dataOnly = (b: GraphBackend, ...aliases: string[]) =>
  b.kind === "ladybug" ? aliases.map((a) => `${a}.node_type <> 'Schema'`).join(" AND ") : "true";

/** The type a `dialect.typeOf(alias)` column holds (`typeValue`). */
export const typeFrom = typeValue;

/** One raw write statement (test setup), on the engine's write path. */
export async function rawWrite(b: GraphBackend, cypher: string, params: Record<string, unknown> = {}): Promise<void> {
  if (b.kind === "neo4j") await b.bolt.run(cypher, params);
  else await b.lbug.exclusive((w) => w(cypher, params));
}

export interface RawNodeView {
  type: string | undefined;
  /** Every stored property, stamps included; nothing engine-internal. */
  props: Record<string, unknown>;
}

/** One node by ref_id as the engine stores it, or null. */
export async function rawNode(b: GraphBackend, ref_id: string): Promise<RawNodeView | null> {
  if (b.kind === "neo4j") {
    const rows = await b.query(`MATCH (n:Data_Bank {ref_id: $r}) RETURN labels(n) AS labels, properties(n) AS props`, { r: ref_id });
    if (!rows.length) return null;
    return { type: typeLabelOf(rows[0]!["labels"] as string[]), props: rows[0]!["props"] as Record<string, unknown> };
  }
  const rows = await b.query(`MATCH (n:Node {ref_id: $r}) RETURN n`, { r: ref_id });
  if (!rows.length) return null;
  const { node_type, ...props } = rows[0]!["n"] as Record<string, unknown>;
  return { type: typeof node_type === "string" ? node_type : undefined, props };
}

export interface RawEdgeView {
  type: string;
  props: Record<string, unknown>;
  src: string;
  tgt: string;
}

/** One edge by ref_id, or null. */
export async function rawEdge(b: GraphBackend, ref_id: string): Promise<RawEdgeView | null> {
  if (b.kind === "neo4j") {
    const rows = await b.query(`MATCH (a)-[r {ref_id: $r}]->(b) RETURN type(r) AS type, properties(r) AS props, a.ref_id AS src, b.ref_id AS tgt`, { r: ref_id });
    const r = rows[0];
    return r ? { type: String(r["type"]), props: r["props"] as Record<string, unknown>, src: String(r["src"]), tgt: String(r["tgt"]) } : null;
  }
  const rows = await b.query(`MATCH (a:Node)-[r {ref_id: $r}]->(b:Node) RETURN label(r) AS type, r AS rel, a.ref_id AS src, b.ref_id AS tgt`, { r: ref_id });
  const r = rows[0];
  return r ? { type: String(r["type"]), props: r["rel"] as Record<string, unknown>, src: String(r["src"]), tgt: String(r["tgt"]) } : null;
}

/** Set raw properties on a node (test setup: a legacy marker, a stale vector). */
export async function setNodeProps(b: GraphBackend, ref_id: string, props: Record<string, unknown>): Promise<void> {
  if (b.kind === "neo4j") {
    await b.query(`MATCH (n:Data_Bank {ref_id: $r}) SET n += $p`, { r: ref_id, p: props });
    return;
  }
  const assigns = Object.keys(props).map((k, i) => `n.\`${k}\` = $v${i}`);
  const params: Record<string, unknown> = { r: ref_id };
  Object.values(props).forEach((v, i) => (params[`v${i}`] = v));
  await b.lbug.exclusive((w) => w(`MATCH (n:Node {ref_id: $r}) SET ${assigns.join(", ")}`, params));
}

/** How many DATA edges of `edge` the graph holds (every edge when omitted).
 *  Both ends data nodes: an edge SCHEMA (a Neo4j relationship between two
 *  `:Schema` nodes, a Ladybug `SCHEMA_EDGE` between two Schema rows) must
 *  not count. */
export async function edgeCount(b: GraphBackend, edge?: string): Promise<number> {
  const rel = edge ? `[r:\`${edge}\`]` : "[r]";
  const rows = await b.query(`MATCH ${anyNode(b, "a")}-${rel}->${anyNode(b, "b")} WHERE ${dataOnly(b, "a", "b")} RETURN count(r) AS c`);
  return Number(rows[0]?.["c"] ?? 0);
}

/** How many live nodes of `type` (every type when omitted). */
export async function nodeCount(b: GraphBackend, type?: string): Promise<number> {
  const d = b.dialect;
  const pattern = type ? d.node("n", type) : b.kind === "neo4j" ? "(n:Data_Bank)" : "(n:Node)";
  const rows = await b.query(`MATCH ${pattern} WHERE ${d.live("n")} AND ${dataOnly(b, "n")} RETURN count(n) AS c`);
  return Number(rows[0]?.["c"] ?? 0);
}

// ── Neo4j-only: wipe + snapshot ─────────────────────────────────────────────

/**
 * Drop every node, relationship, constraint, and index. A constraint's own
 * index goes with the constraint (dropping it directly throws), and the
 * drop repeats until both lists come back empty. If they never do, some
 * other process is writing to this database — a second `test:graph`.
 */
export async function wipeGraph(bolt: Bolt): Promise<void> {
  await bolt.run(`MATCH (n) DETACH DELETE n`);
  for (let round = 0; round < 5; round++) {
    const constraints = await bolt.run(`SHOW CONSTRAINTS YIELD name RETURN name`);
    const indexes = await bolt.run(
      `SHOW INDEXES YIELD name, type, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL RETURN name`,
    );
    if (!constraints.length && !indexes.length) return;
    for (const c of constraints) await bolt.run(`DROP CONSTRAINT \`${c["name"]}\` IF EXISTS`);
    for (const i of indexes) {
      // Claimed by a constraint since the SHOW: the next round drops that.
      await bolt.run(`DROP INDEX \`${i["name"]}\` IF EXISTS`).catch((e) => {
        if (!/belongs to constraint/.test(String(e))) throw e;
      });
    }
  }
  throw new Error(`wipeGraph: the schema keeps coming back — another process is writing to ${bolt.cfg.uri}`);
}

export interface GraphSnapshot {
  nodes: Array<{ labels: string[]; properties: Record<string, unknown> }>;
  rels: Array<{ type: string; properties: Record<string, unknown>; from: unknown; to: unknown }>;
  constraints: unknown[];
  indexes: unknown[];
}

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x));
}

function sortByCanon<T>(xs: T[]): T[] {
  return [...xs].sort((a, b) => (canon(a) < canon(b) ? -1 : canon(a) > canon(b) ? 1 : 0));
}

/**
 * Canonical, order-independent picture of the whole database: every node
 * (labels + all properties), every relationship (type + properties + the
 * `type`/`ref_id`/`node_key` of its endpoints), every constraint and index.
 * Deep-equal two snapshots to prove a run was a no-op. On Ladybug: every
 * row of `Node` (type as its one label) and every edge, no schema objects.
 */
export async function graphSnapshot(b: Bolt | GraphBackend): Promise<GraphSnapshot> {
  if (!(b instanceof Bolt) && b.kind === "ladybug") {
    const nodes = await b.query(`MATCH (n:Node) RETURN n`);
    const rels = await b.query(
      `MATCH (a:Node)-[r]->(b:Node)
       RETURN label(r) AS type, r AS rel, {ref_id: a.ref_id, node_key: a.node_key} AS from, {ref_id: b.ref_id, node_key: b.node_key} AS to`,
    );
    return {
      nodes: sortByCanon(
        nodes.map((r) => {
          const { node_type, ...properties } = r["n"] as Record<string, unknown>;
          return { labels: [String(node_type)], properties };
        }),
      ),
      rels: sortByCanon(rels.map((r) => ({ type: String(r["type"]), properties: r["rel"] as Record<string, unknown>, from: r["from"], to: r["to"] }))),
      constraints: [],
      indexes: [],
    };
  }
  const bolt = b instanceof Bolt ? b : b.bolt;
  const nodes = await bolt.run(`MATCH (n) RETURN labels(n) AS labels, properties(n) AS properties`);
  const rels = await bolt.run(
    `MATCH (a)-[r]->(b)
     RETURN type(r) AS type, properties(r) AS properties,
            {type: a.type, ref_id: a.ref_id, node_key: a.node_key} AS from,
            {type: b.type, ref_id: b.ref_id, node_key: b.node_key} AS to`,
  );
  const constraints = await bolt.run(
    `SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties
     RETURN name, type, entityType, labelsOrTypes, properties`,
  );
  const indexes = await bolt.run(
    `SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, options
     WHERE type <> 'LOOKUP'
     RETURN name, type, entityType, labelsOrTypes, properties, options`,
  );
  return {
    nodes: sortByCanon(nodes.map((r) => ({ labels: ([...(r["labels"] as string[])]).sort(), properties: r["properties"] as Record<string, unknown> }))),
    rels: sortByCanon(rels.map((r) => ({ type: r["type"] as string, properties: r["properties"] as Record<string, unknown>, from: r["from"], to: r["to"] }))),
    constraints: sortByCanon(constraints),
    indexes: sortByCanon(indexes),
  };
}

/** Names of all constraints / non-lookup indexes. */
export async function schemaObjectNames(bolt: Bolt): Promise<{ constraints: string[]; indexes: string[] }> {
  const c = await bolt.run(`SHOW CONSTRAINTS YIELD name RETURN name`);
  const i = await bolt.run(`SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name`);
  return { constraints: c.map((r) => r["name"] as string).sort(), indexes: i.map((r) => r["name"] as string).sort() };
}
