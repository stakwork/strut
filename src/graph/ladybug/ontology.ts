/**
 * A Ladybug file's ontology (plans/memory-in-workspace-graph.md, PR A;
 * decisions 1, 4, 5): types are `Schema` rows of the `Node` table, as Neo4j
 * keeps `:Schema` nodes. The ontology's edges are one rel table of their
 * own, `SCHEMA_EDGE`: a type's parent is a `CHILD_OF` one between two
 * Schema rows marked `is_parent`, and an allowed `source -[EDGE]-> target`
 * an unmarked one with `edge_type` EDGE. The two never stand in for each
 * other: the ancestor walk reads only parent links, the edge-rule lookups
 * only rules (so a type's parent link to Thing allows no CHILD_OF edge, and
 * the rule Concept -[CHILD_OF]-> Concept is no parent). Kept apart from the
 * data's rel tables, a read of an edge type never meets the ontology. The `*` row is the
 * wildcard sentinel.
 *
 * A row's columns are the Schema fields (`SCHEMA_COLUMNS`): the type's
 * `node_key` spec is the row's `node_key`, and the attributes it declares
 * are one JSON column, `attributes`. Read back, a row is the flat map a
 * Neo4j Schema node holds — core keys and attributes side by side — so the
 * resolver merges and walks it the same way.
 *
 * The file's tables follow the ontology: a declared attribute is a real
 * column (`ALTER TABLE Node ADD`), one name keeping one column type across
 * every type, and a new edge type is a new rel table. Both are written in
 * the caller's transaction with the Schema row (Ladybug takes DDL inside a
 * write transaction, with reads in flight). `LadybugCatalog` caches the
 * tables as the file has them, per handle.
 *
 * Every function runs its statements on the `Run` it is given: the write
 * transaction (`LadybugSchemas`, `ladybug/engine.ts`), or the open's own
 * (`seedOntology`, `db.ts`).
 */
import { randomUUID } from "node:crypto";
import type { EdgeSchemaRow, EdgeSchemaWalk, Params, Row, SchemaRow } from "../engine.js";
import { GraphValidationError } from "../node-writer.js";
import { EDGE_COLUMNS, SCHEMA_COLUMNS, SCHEMA_TYPE, columnTypeOf, ontologySeed, type ColumnType } from "./registry.js";

export type Run = (cypher: string, params?: Params) => Promise<Row[]>;

const q = (s: string) => `\`${s}\``;
const S = (alias: string) => `(${alias}:Node {node_type: '${SCHEMA_TYPE}'})`;
const TYPE_GRAMMAR = /^\??(string|boolean|int|float|complex|datetime|list)$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EDGE_NAME = /^[A-Z][A-Z0-9_]*$/;
/** The ontology's edges: one rel table, the edge type a column. */
export const SCHEMA_EDGE = "SCHEMA_EDGE";
/** Tables an edge type may not be named after (names are case-blind). */
const NODE_TABLES = new Set(["NODE", "MIGRATION", SCHEMA_EDGE]);
/** One ontology edge of a type: `(a)-[r:SCHEMA_EDGE]->(b)` with `r.edge_type`. */
const SE = (alias: string) => `[${alias}:${SCHEMA_EDGE}]`;
/** A parent link, and an edge rule: the one mark that tells them apart. */
const PARENT = (alias: string) => `${alias}.is_parent = true`;
const RULE = (alias: string) => `${alias}.is_parent IS NULL`;
const WILDCARD = "*";
/** jarvis's ancestor walk depth (`MAX_ANCESTOR_WALK_DEPTH`). */
const MAX_DEPTH = 10;
/** The Schema columns read back as the type's own keys (`attributes` is unfolded). */
const CORE = Object.keys(SCHEMA_COLUMNS).filter((k) => k !== "attributes");
const LISTS = new Set(Object.entries(SCHEMA_COLUMNS).filter(([, t]) => t === "STRING[]").map(([k]) => k));

// ── The catalog ─────────────────────────────────────────────────────────────

/** The file's tables as they are: every Node column with its type, and the rel tables. */
export interface Catalog {
  columns: Record<string, string>;
  edges: Set<string>;
}

export async function readCatalog(run: Run): Promise<Catalog> {
  const columns: Record<string, string> = {};
  for (const r of await run(`CALL table_info('Node') RETURN name, type`)) columns[String(r["name"])] = String(r["type"]);
  const edges = new Set((await run(`CALL show_tables() RETURN name, type`)).filter((t) => t["type"] === "REL").map((t) => String(t["name"])));
  return { columns, edges };
}

/** The catalog of one handle, read once on the read connection and dropped
 *  on every schema write. A write that names a column the cache lacks reads
 *  it again on its own transaction before refusing (`ladybug/engine.ts`). */
export class LadybugCatalog {
  private cached: Promise<Catalog> | undefined;
  constructor(private readonly read: Run) {}

  get(): Promise<Catalog> {
    if (!this.cached) {
      const c = readCatalog(this.read);
      this.cached = c;
      c.catch(() => {
        if (this.cached === c) this.cached = undefined;
      });
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

const CATALOGS = new WeakMap<object, LadybugCatalog>();

/** The one catalog of a handle, shared by every engine and reader over it. */
export function catalogOf(lbug: { query: Run }): LadybugCatalog {
  let c = CATALOGS.get(lbug);
  if (!c) CATALOGS.set(lbug, (c = new LadybugCatalog(lbug.query)));
  return c;
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** A flat Schema map as the row's fields and its attributes: every key whose
 *  value is a type string is an attribute (as the resolver reads it), the
 *  Schema fields are columns, and anything else (a jarvis display key the
 *  file has no column for) is left out. */
export function splitFlat(flat: Record<string, unknown>): { core: Record<string, unknown>; attributes: Record<string, string> } {
  const core: Record<string, unknown> = {};
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k === "ref_id" || k === "node_key" || k === "type" || v === undefined || v === null) continue;
    if (k === "attributes" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [a, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === "string") attributes[a] = t;
      continue;
    }
    if (typeof v === "string" && TYPE_GRAMMAR.test(v)) attributes[k] = v;
    else if (k in SCHEMA_COLUMNS && k !== "attributes") {
      // Only a value the column can hold: a failed write after the DDL would roll it back.
      const col = SCHEMA_COLUMNS[k];
      if (LISTS.has(k)) core[k] = Array.isArray(v) ? v.map(String) : [String(v)];
      else if (col === "BOOL") {
        if (typeof v === "boolean") core[k] = v;
      } else if (typeof v === "string" || typeof v === "number") core[k] = String(v);
    }
  }
  return { core, attributes };
}

function parseAttributes(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** A Schema row (`RETURN n`) as the flat map: its fields, then its attributes. */
export function toSchemaRow(n: Record<string, unknown>): SchemaRow {
  const props: Record<string, unknown> = {};
  for (const k of ["type", "ref_id", "node_key", ...CORE]) if (n[k] !== undefined && n[k] !== null) props[k] = n[k];
  Object.assign(props, parseAttributes(n["attributes"]));
  return { type: String(n["type"]), ref_id: typeof n["ref_id"] === "string" ? n["ref_id"] : undefined, props };
}

/** The Schema whose type matches case-insensitively, exact case first. */
export async function schemaRow(run: Run, type: string, live = false): Promise<SchemaRow | null> {
  const rows = await run(
    `MATCH ${S("n")} WHERE lower(n.type) = lower($t) ${live ? `AND n.deleted_at IS NULL AND n.type <> '${WILDCARD}'` : ""}
     RETURN n ORDER BY CASE WHEN n.type = $t THEN 0 ELSE 1 END, n.type LIMIT 1`,
    { t: type.trim() },
  );
  return rows.length ? toSchemaRow(rows[0]!["n"] as Record<string, unknown>) : null;
}

/** Every live Schema but the wildcard, by type. */
export async function schemaRows(run: Run): Promise<SchemaRow[]> {
  const rows = await run(`MATCH ${S("n")} WHERE n.deleted_at IS NULL AND n.type <> '${WILDCARD}' RETURN n ORDER BY n.type`);
  return rows.map((r) => toSchemaRow(r["n"] as Record<string, unknown>));
}

/** Every edge rule between two live Schemas, the wildcard's included. */
export async function edgeSchemaRows(run: Run): Promise<Array<{ edge: string; source: string; target: string }>> {
  const rows = await run(
    `MATCH ${S("s")}-${SE("r")}->${S("t")} WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL AND ${RULE("r")}
     RETURN r.edge_type AS edge, s.type AS source, t.type AS target`,
  );
  return rows
    .map((r) => ({ edge: String(r["edge"]), source: String(r["source"]), target: String(r["target"]) }))
    .sort((a, b) => a.edge.localeCompare(b.edge) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

/** The CHILD_OF ancestors of `type` (exact), nearest first: parent links
 *  only, never an edge rule named CHILD_OF. */
export async function ancestors(run: Run, type: string): Promise<{ chain: string[]; rows: Array<Record<string, unknown>> }> {
  const chain: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let at = type;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const up = await run(`MATCH ${S("c")}-${SE("r")}->${S("p")} WHERE c.type = $t AND ${PARENT("r")} RETURN p ORDER BY p.type LIMIT 1`, { t: at });
    if (!up.length) break;
    const row = toSchemaRow(up[0]!["p"] as Record<string, unknown>);
    if (row.type === type || chain.includes(row.type)) break;
    chain.push(row.type);
    rows.push(row.props);
    at = row.type;
  }
  return { chain, rows };
}

/** The rule `source -[edge]-> target` (exact types), case-blind on the edge
 *  type: its edge type as stored, and its properties. A parent link is no rule. */
async function edgeBetween(run: Run, edge: string, source: string, target: string): Promise<{ edge: string; props: Record<string, unknown> } | null> {
  const rows = await run(
    `MATCH ${S("s")}-${SE("r")}->${S("t")} WHERE s.type = $s AND t.type = $t AND ${RULE("r")} AND lower(r.edge_type) = lower($e)
     RETURN r.edge_type AS edge, r.ref_id AS ref_id ORDER BY CASE WHEN r.edge_type = $e THEN 0 ELSE 1 END LIMIT 1`,
    { s: source, t: target, e: edge },
  );
  const r = rows[0];
  return r ? { edge: String(r["edge"]), props: typeof r["ref_id"] === "string" ? { ref_id: r["ref_id"] } : {} } : null;
}

/** One step of the resolver's edge-schema lookup (jarvis
 *  `get_schema_edge_by_edge_type`): exact, then the source's ancestors, the
 *  target's, both, nearest first, then `*`→`*`. */
export async function findEdgeSchema(run: Run, walk: EdgeSchemaWalk, source: string, edge: string, target: string): Promise<EdgeSchemaRow | null> {
  const at = async (s: string, t: string) => edgeBetween(run, edge, s, t);
  const exactType = async (raw: string) => (await schemaRow(run, raw))?.type ?? null;
  const hit = (s: string, t: string, found: { edge: string; props: Record<string, unknown> }): EdgeSchemaRow => ({ source: s, target: t, edge_type: found.edge, props: found.props });
  const src = await exactType(source);
  const tgt = await exactType(target);
  switch (walk) {
    case "exact": {
      if (!src || !tgt) return null;
      const p = await at(src, tgt);
      return p ? hit(src, tgt, p) : null;
    }
    case "source-ancestor": {
      if (!src || !tgt) return null;
      for (const a of (await ancestors(run, src)).chain) {
        const p = await at(a, tgt);
        if (p) return hit(src, tgt, p);
      }
      return null;
    }
    case "target-ancestor": {
      if (!src || !tgt) return null;
      for (const a of (await ancestors(run, tgt)).chain) {
        const p = await at(src, a);
        if (p) return hit(src, tgt, p);
      }
      return null;
    }
    case "both-ancestors": {
      if (!src || !tgt) return null;
      const sa = (await ancestors(run, src)).chain;
      const ta = (await ancestors(run, tgt)).chain;
      const pairs = sa.flatMap((s, i) => ta.map((t, j) => ({ s, t, d: i + j }))).sort((x, y) => x.d - y.d);
      for (const { s, t } of pairs) {
        const p = await at(s, t);
        if (p) return hit(src, tgt, p);
      }
      return null;
    }
    case "wildcard": {
      const p = await at(WILDCARD, WILDCARD);
      return p ? hit(WILDCARD, WILDCARD, p) : null;
    }
  }
}

/** Live Schemas whose type or an alias is one of `names`, case-blind
 *  (plans/memory-in-workspace-graph.md decision 9). */
export async function typesNamed(run: Run, names: string[]): Promise<Array<{ type: string; aliases: string[]; managed_by?: string }>> {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const rows = await run(`MATCH ${S("n")} WHERE n.deleted_at IS NULL AND n.type <> '${WILDCARD}' RETURN n.type AS type, n.aliases AS aliases, n.managed_by AS managed_by`);
  return rows
    .map((r) => ({ type: String(r["type"]), aliases: Array.isArray(r["aliases"]) ? (r["aliases"] as unknown[]).map(String) : [], managed_by: typeof r["managed_by"] === "string" ? (r["managed_by"] as string) : undefined }))
    .filter((r) => wanted.has(r.type.toLowerCase()) || r.aliases.some((a) => wanted.has(a.toLowerCase())));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Each declared attribute as a column: added when the file lacks it,
 *  refused when the file has it as another type (decision 5). `catalog` is
 *  updated in place. */
export async function addColumns(run: Run, catalog: Catalog, type: string, attributes: Record<string, string>): Promise<string[]> {
  // Every check before the first ALTER: rolling back a transaction that
  // altered a table can crash the engine (ladybug 0.21), so a refused type
  // must leave its transaction without DDL in it.
  const wanted = planColumns(catalog.columns, type, attributes);
  for (const [k, col] of wanted) {
    await run(`ALTER TABLE Node ADD IF NOT EXISTS ${q(k)} ${col}`);
    catalog.columns[k] = col;
  }
  return wanted.map(([k]) => k);
}

/** The columns `attributes` need that `columns` lacks, with their types;
 *  throws the refusal when one cannot be a column or clashes with one
 *  `columns` has (decision 5). Pure: no statement runs. */
export function planColumns(columns: Readonly<Record<string, string>>, type: string, attributes: Record<string, string>): Array<[string, ColumnType]> {
  const wanted: Array<[string, ColumnType]> = [];
  for (const [k, t] of Object.entries(attributes)) {
    if (!IDENT.test(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, "attribute name is not a bare identifier", k);
    const base = t.replace(/^\?/, "") as Parameters<typeof columnTypeOf>[0];
    const col: ColumnType | null = columnTypeOf(base);
    if (!col) throw new GraphValidationError("WRONG_TYPE", type, `a ${base} attribute has no column type in a ladybug file (string, boolean, int, float, datetime or list)`, k);
    const have = columns[k];
    if (have && have !== col) {
      throw new GraphValidationError("WRONG_TYPE", type, `${k} is a ${have} column in this graph and ${t} would need ${col} — one attribute name keeps one column type across every type`, k);
    }
    if (!have) wanted.push([k, col]);
  }
  return wanted;
}

/** The rel table for `edge`, created when the file lacks it (decision 4). */
export async function ensureRelTable(run: Run, catalog: Catalog, edge: string): Promise<void> {
  if (!EDGE_NAME.test(edge) || NODE_TABLES.has(edge)) throw new GraphValidationError("WRONG_TYPE", edge, "an edge type is UPPER_SNAKE (^[A-Z][A-Z0-9_]*$) and not a node table's name");
  if (catalog.edges.has(edge)) return;
  const cols = Object.entries(EDGE_COLUMNS).map(([k, t]) => `${q(k)} ${t}`).join(", ");
  await run(`CREATE REL TABLE IF NOT EXISTS ${q(edge)}(FROM Node TO Node, ${cols})`);
  catalog.edges.add(edge);
}

/** The ontology's own rel table, made at open (`db.ts`); here for a file
 *  an older build made. */
export async function ensureSchemaEdgeTable(run: Run, catalog: Catalog): Promise<void> {
  if (catalog.edges.has(SCHEMA_EDGE)) return;
  await run(SCHEMA_EDGE_DDL);
  catalog.edges.add(SCHEMA_EDGE);
}

/** Shaped like every other rel table (the edge columns), plus the type and the parent mark. */
export const SCHEMA_EDGE_DDL = `CREATE REL TABLE IF NOT EXISTS ${SCHEMA_EDGE}(FROM Node TO Node, ${Object.entries(EDGE_COLUMNS)
  .map(([k, t]) => `${q(k)} ${t}`)
  .join(", ")}, ${q("edge_type")} STRING, ${q("is_parent")} BOOL)`;

/** The row's fields as a CREATE / SET list, lists cast (an empty list has no type of its own). */
function assigns(alias: string, fields: Record<string, unknown>, params: Params, sep: ": " | " = "): string[] {
  return Object.entries(fields).map(([k, v], i) => {
    params[`f${i}`] = v;
    const value = LISTS.has(k) ? `CAST($f${i} AS STRING[])` : `$f${i}`;
    return sep === ": " ? `${q(k)}: ${value}` : `${alias}.${q(k)} = ${value}`;
  });
}

/** A new Schema row from its flat map (`MERGE … ON CREATE`, as on Neo4j:
 *  a type already there is left as it is), and its attributes' columns. */
export async function createSchemaRow(run: Run, catalog: Catalog, flat: Record<string, unknown>): Promise<void> {
  const type = String(flat["type"] ?? "").trim();
  if (!type) throw new GraphValidationError("UNKNOWN_TYPE", "?", "a Schema needs a type");
  if ((await run(`MATCH ${S("n")} WHERE n.type = $t RETURN n.ref_id AS r LIMIT 1`, { t: type })).length) return;
  const { core, attributes } = splitFlat(flat);
  await addColumns(run, catalog, type, attributes);
  const params: Params = {
    ref_id: typeof flat["ref_id"] === "string" ? flat["ref_id"] : randomUUID(),
    type,
    attributes: JSON.stringify(attributes),
    now: Date.now(),
  };
  const fields = ["ref_id: $ref_id", `node_type: '${SCHEMA_TYPE}'`, "type: $type", "attributes: $attributes", "date_added_to_graph: CAST($now AS INT64)"];
  if (typeof flat["node_key"] === "string") {
    params["node_key"] = flat["node_key"];
    fields.push("node_key: $node_key");
  }
  fields.push(...assigns("n", core, params, ": "));
  await run(`CREATE (n:Node {${fields.join(", ")}})`, params);
}

/** Set keys on an existing Schema (exact type): its fields set (its
 *  `node_key` spec too, when given), its attributes merged in (the given
 *  ones win), a new attribute's column added. */
export async function extendSchemaRow(run: Run, catalog: Catalog, type: string, props: Record<string, unknown>): Promise<void> {
  const rows = await run(`MATCH ${S("n")} WHERE n.type = $t RETURN n.attributes AS a`, { t: type });
  if (!rows.length) return;
  const { core, attributes } = splitFlat(props);
  await addColumns(run, catalog, type, attributes);
  const params: Params = { t: type, attributes: JSON.stringify({ ...parseAttributes(rows[0]!["a"]), ...attributes }) };
  const sets = ["n.attributes = $attributes", ...assigns("n", core, params, " = ")];
  if (typeof props["node_key"] === "string") {
    params["node_key"] = props["node_key"];
    sets.push("n.node_key = $node_key");
  }
  await run(`MATCH ${S("n")} WHERE n.type = $t SET ${sets.join(", ")}`, params);
}

/** Hard-delete a Schema and its edges. Its columns stay: a column is never dropped. */
export async function deleteSchemaRow(run: Run, type: string): Promise<void> {
  await run(`MATCH ${S("n")} WHERE n.type = $t DETACH DELETE n`, { t: type });
}

/** `(child)-[:CHILD_OF]->(parent)` between two Schemas. False when it was
 *  there; null when either is missing. */
export async function ensureChildOf(run: Run, catalog: Catalog, child: string, parent: string, ref_id: string): Promise<boolean | null> {
  await ensureSchemaEdgeTable(run, catalog);
  const ends = await run(`MATCH ${S("c")}, ${S("p")} WHERE c.type = $c AND p.type = $p RETURN c.ref_id AS c`, { c: child, p: parent });
  if (!ends.length) return null;
  const have = await run(`MATCH ${S("c")}-${SE("r")}->${S("p")} WHERE c.type = $c AND p.type = $p AND ${PARENT("r")} RETURN r.ref_id AS r LIMIT 1`, { c: child, p: parent });
  if (have.length) return false;
  await run(`MATCH ${S("c")}, ${S("p")} WHERE c.type = $c AND p.type = $p CREATE (c)-[:${SCHEMA_EDGE} {ref_id: $ref_id, edge_type: 'CHILD_OF', is_parent: true}]->(p)`, { c: child, p: parent, ref_id });
  return true;
}

/** `(source)-[:EDGE]->(target)` between two Schemas — the rule that the
 *  edge is allowed — creating EDGE's rel table first when the file lacks
 *  it. Of `props` only `ref_id` is kept: jarvis's edge schemas declare the
 *  edge's attributes there (`importance: "?float"`), which the file's typed
 *  edge columns neither need nor hold. Null when either Schema is missing. */
export async function ensureEdgeSchema(run: Run, catalog: Catalog, source: string, edge: string, target: string, props: Record<string, unknown>): Promise<{ created: boolean; ref_id: string } | null> {
  await ensureRelTable(run, catalog, edge);
  await ensureSchemaEdgeTable(run, catalog);
  const ends = await run(`MATCH ${S("s")}, ${S("t")} WHERE s.type = $s AND t.type = $t RETURN s.ref_id AS s`, { s: source, t: target });
  if (!ends.length) return null;
  const have = await edgeBetween(run, edge, source, target);
  if (have) return { created: false, ref_id: String(have.props["ref_id"] ?? "") };
  const ref_id = typeof props["ref_id"] === "string" ? props["ref_id"] : randomUUID();
  await run(`MATCH ${S("s")}, ${S("t")} WHERE s.type = $s AND t.type = $t CREATE (s)-[:${SCHEMA_EDGE} {ref_id: $ref_id, edge_type: $e}]->(t)`, { s: source, t: target, ref_id, e: edge });
  return { created: true, ref_id };
}

/** The `*` wildcard Schema sentinel. */
export async function ensureWildcardSchema(run: Run, ref_id: string): Promise<void> {
  if ((await run(`MATCH ${S("n")} WHERE n.type = '${WILDCARD}' RETURN n.ref_id AS r LIMIT 1`)).length) return;
  await run(`CREATE (n:Node {ref_id: $r, node_type: '${SCHEMA_TYPE}', type: '${WILDCARD}'})`, { r: ref_id });
}

// ── The seed ────────────────────────────────────────────────────────────────

export interface OntologySeedReport {
  createdSchemas: string[];
  /** Seed types whose stored row differed from the seed, with the keys the
   *  seed set back: strut's own definitions win on their own keys. */
  reconciled: Record<string, string[]>;
  createdEdgeSchemas: string[];
  /** Seed types left as they are, and why: a column of another type, or a
   *  name another type holds. Never a failed open. */
  skipped: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The seed (`registry.ts`) into the file. A missing type is created; an
 * existing seed type is RECONCILED: the seed's own keys (fields, `node_key`
 * spec, parent, the attributes it declares) are set back to the seed's, so
 * a change to strut's types reaches files made before it, and anything
 * added at runtime (another attribute, an alias) stays. Edge rules are
 * add-only. A second run changes nothing.
 *
 * Planned whole before any statement that alters a table, since rolling
 * back DDL can crash the engine: a seed type whose attributes clash with a
 * column (a runtime type took the name first), or whose name a runtime type
 * holds as an alias or in another casing, is skipped and reported, and the
 * rest of the seed lands.
 */
export async function seedOntology(run: Run, seed = ontologySeed()): Promise<OntologySeedReport> {
  const catalog = await readCatalog(run);
  const report: OntologySeedReport = { createdSchemas: [], reconciled: {}, createdEdgeSchemas: [], skipped: [] };
  const names = await typesNamed(run, seed.schemas.map((f) => String(f["type"])));
  const columns: Record<string, string> = { ...catalog.columns };
  const plans: Array<{ flat: Record<string, unknown>; hit: SchemaRow | null; changed: string[] }> = [];
  for (const flat of seed.schemas) {
    const type = String(flat["type"]);
    const holder = names.find((n) => n.type !== type && (n.type.toLowerCase() === type.toLowerCase() || n.aliases.some((a) => a.toLowerCase() === type.toLowerCase())));
    if (holder) {
      report.skipped.push(`${type}: the name is held by ${holder.type}`);
      continue;
    }
    const hit = await schemaRow(run, type);
    const { attributes } = splitFlat(flat);
    try {
      for (const [k, col] of planColumns(columns, type, attributes)) columns[k] = col;
    } catch (e) {
      if (!(e instanceof GraphValidationError)) throw e;
      report.skipped.push(`${type}: ${e.message}`);
      continue;
    }
    const changed = hit ? Object.entries(flat).filter(([k, v]) => k !== "type" && !same(hit.props[k], v)).map(([k]) => k) : [];
    plans.push({ flat, hit: hit && hit.type === type ? hit : null, changed });
  }

  for (const { flat, hit, changed } of plans) {
    const type = String(flat["type"]);
    if (!hit) {
      await createSchemaRow(run, catalog, flat);
      report.createdSchemas.push(type);
    } else if (changed.length) {
      await extendSchemaRow(run, catalog, type, flat);
      report.reconciled[type] = changed.sort();
    }
  }
  const planned = new Set(plans.map((p) => String(p.flat["type"])));
  for (const { flat } of plans) {
    const type = String(flat["type"]);
    const parent = typeof flat["parent"] === "string" ? flat["parent"] : undefined;
    if (!parent) continue;
    // One parent, the seed's: a link to another (an older seed's) goes.
    await run(`MATCH ${S("c")}-${SE("r")}->${S("p")} WHERE c.type = $c AND ${PARENT("r")} AND p.type <> $p DELETE r`, { c: type, p: parent });
    await ensureChildOf(run, catalog, type, parent, randomUUID());
  }
  for (const e of seed.edges) {
    if (!planned.has(e.source) || !planned.has(e.target)) continue;
    const r = await ensureEdgeSchema(run, catalog, e.source, e.edge, e.target, { ref_id: randomUUID() });
    if (r?.created) report.createdEdgeSchemas.push(`${e.source}-[${e.edge}]->${e.target}`);
  }
  return report;
}
