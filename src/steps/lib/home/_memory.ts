// The memory home sync moves: the part of a Ladybug workspace graph that is
// the person's memory, as plain rows. POST /home/pull sends it from the box
// (`readMemory`), and home/sync puts it in place of the copy's own
// (`ensureTypes`, then `replaceMemory`). Leading underscore: imported by home
// sync, skipped by registry discovery.
//
// The memory is every node of a type whose role is `entity` (people, words,
// the types facts were imported as) or `record` (a fact's search row, a
// merge's record, dictation's mishearings), every edge touching one, and
// the ontology those need: the types, with their attributes, and the edge
// rules between them. The rest of the graph (workflows, runs, Concepts,
// claims) is each strut's own and is never sent.
//
// A replace, not a merge: on the copy the memory nodes are deleted and the
// box's written with their ref_ids, every column as the box has it. An edge
// is written when both its ends are on the copy then, so one to a node of
// the copy's own (a claim about a person) comes back. The copy runs no agent
// and only dictation writes there (peel docs/always-on.md); home/sync pushes
// those first, and replays the ones made while the pull was under way.
import { createHash } from "node:crypto";
import type { LadybugBackend } from "../../../graph/backend.js";
import type { Row } from "../../../graph/engine.js";
import { createNodeSchema } from "../../../graph/schema-crud.js";
import { boundsOf } from "../../../graph/scope.js";
import { SCHEMA_EDGE, edgeAliases, edgeRule, edgeSchemaRows, schemaRows } from "../../../graph/ladybug/ontology.js";
import { SCHEMA_TYPE } from "../../../graph/ladybug/registry.js";

/** Bumped when the shape below changes: a copy refuses a format it does not know. */
export const MEMORY_FORMAT = 1;

export interface Memory {
  format: number;
  /** The memory types, as their Schema rows hold them: own attributes and rules. */
  types: Array<Record<string, unknown>>;
  /** The edge rules between memory types, with their edge type's rule and aliases. */
  edge_rules: Array<{ edge: string; source: string; target: string; temporal?: boolean; cardinality?: string; aliases?: string[] }>;
  /** Every memory node: its non-null columns. */
  nodes: Row[];
  /** Every edge touching a memory node: its type, ends and non-null columns. */
  edges: Array<{ type: string; from: string; to: string; props: Row }>;
}

const q = (s: string) => `\`${s}\``;
/** Raw reads and writes: a step's reader list (scope.ts) refuses `b.query`. */
const raw = (b: LadybugBackend) => boundsOf(b)?.query ?? b.query.bind(b);
const ROLES = new Set(["entity", "record"]);

/** The types whose nodes are memory, on `b`. */
async function memoryTypes(b: LadybugBackend): Promise<string[]> {
  const out: string[] = [];
  for (const row of await schemaRows(raw(b))) {
    if (row.type === SCHEMA_TYPE) continue;
    const role = (await b.schemas.schema(row.type))?.role;
    if (role && ROLES.has(role)) out.push(row.type);
  }
  return out;
}

/** A table's columns with their types. */
async function columns(b: LadybugBackend, table: string): Promise<Map<string, string>> {
  return new Map((await raw(b)(`CALL table_info('${table}') RETURN name, type`)).map((r) => [String(r["name"]), String(r["type"])]));
}

const relTables = async (b: LadybugBackend) =>
  (await raw(b)(`CALL show_tables() RETURN name, type`)).filter((t) => t["type"] === "REL" && t["name"] !== SCHEMA_EDGE).map((t) => String(t["name"]));

const present = (r: Row) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));
const byJson = <T>(xs: T[]) => xs.map((x) => [JSON.stringify(x), x] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, x]) => x);

/** The box's side: the memory as rows, and its content hash. */
export async function readMemory(b: LadybugBackend): Promise<{ memory: Memory; content_hash: string }> {
  const types = await memoryTypes(b);
  const typeRows = (await schemaRows(raw(b))).filter((r) => types.includes(r.type)).map((r) => {
    const { ref_id: _ref, ...props } = r.props;
    return props;
  });
  const aliases = await edgeAliases(raw(b));
  const rules: Memory["edge_rules"] = [];
  for (const r of await edgeSchemaRows(raw(b))) {
    if (!types.includes(r.source) || !types.includes(r.target)) continue;
    const rule = (await edgeRule(raw(b), r.edge)) ?? {};
    rules.push({
      ...r,
      ...(typeof rule["temporal"] === "boolean" ? { temporal: rule["temporal"] } : {}),
      ...(typeof rule["cardinality"] === "string" ? { cardinality: rule["cardinality"] } : {}),
      ...(aliases.get(r.edge)?.length ? { aliases: aliases.get(r.edge) } : {}),
    });
  }
  const nodeCols = [...(await columns(b, "Node")).keys()];
  const nodes = types.length
    ? (await raw(b)(`MATCH (n:Node) WHERE n.node_type IN $types RETURN ${nodeCols.map((c) => `n.${q(c)} AS ${q(c)}`).join(", ")} ORDER BY n.ref_id`, { types })).map(present)
    : [];
  const edges: Memory["edges"] = [];
  for (const table of types.length ? await relTables(b) : []) {
    const cols = [...(await columns(b, table)).keys()];
    const read = cols.map((c) => `r.${q(c)} AS ${q(`p_${c}`)}`).join(", ");
    for (const r of await raw(b)(
      `MATCH (a:Node)-[r:${q(table)}]->(z:Node) WHERE a.node_type IN $types OR z.node_type IN $types RETURN a.ref_id AS f, z.ref_id AS t${read ? `, ${read}` : ""}`,
      { types },
    )) {
      const props = present(Object.fromEntries(cols.map((c) => [c, r[`p_${c}`]])));
      edges.push({ type: table, from: String(r["f"]), to: String(r["t"]), props });
    }
  }
  const memory: Memory = { format: MEMORY_FORMAT, types: typeRows, edge_rules: rules, nodes, edges: byJson(edges) };
  return { memory, content_hash: createHash("sha256").update(JSON.stringify(memory)).digest("hex") };
}

/** Whether `v` is a memory this strut can load. */
export function isMemory(v: unknown): v is Memory {
  const m = v as Memory | null;
  return !!m && typeof m === "object" && m.format === MEMORY_FORMAT && [m.types, m.edge_rules, m.nodes, m.edges].every(Array.isArray);
}

/** The copy's side, before the replace: the box's memory types and edge
 *  rules made here where missing, a type's missing attributes added. Only
 *  adds, so it runs outside the replace's transaction (a schema write is
 *  its own). */
export async function ensureTypes(b: LadybugBackend, memory: Memory): Promise<void> {
  let todo = memory.types;
  // Parents first: a type whose parent is not here yet waits a round.
  while (todo.length) {
    const next: typeof todo = [];
    for (const t of todo) {
      const type = String(t["type"]);
      const { type: _t, parent, key_spec, index, title_key, description_key, type_description, aliases, role, identifiers, embed, managed_by, domain, ...rest } = t;
      const attributes = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      const held = await b.schemas.schema(type);
      if (held) {
        const missing = Object.fromEntries(Object.entries(attributes).filter(([k]) => !(k in held.attributes)));
        if (Object.keys(missing).length) await createNodeSchema(b, b.schemas, { type, attributes: missing });
        continue;
      }
      if (typeof parent === "string" && parent && !(await b.schemas.schema(parent))) {
        next.push(t);
        continue;
      }
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const list = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String) : undefined);
      await createNodeSchema(b, b.schemas, {
        type, attributes,
        ...(str(parent) ? { parent: str(parent) } : {}),
        ...(str(key_spec) ? { key_spec: str(key_spec) } : {}),
        ...(list(index) ? { index: list(index) } : {}),
        ...(str(title_key) ? { title_key: str(title_key) } : {}),
        ...(str(description_key) ? { description_key: str(description_key) } : {}),
        ...(str(type_description) ? { type_description: str(type_description) } : {}),
        ...(list(aliases) ? { aliases: list(aliases) } : {}),
        ...(str(role) ? { role: str(role) } : {}),
        ...(list(identifiers) ? { identifiers: list(identifiers) } : {}),
        ...(typeof embed === "boolean" ? { embed } : {}),
        ...(str(managed_by) ? { managed_by: str(managed_by) } : {}),
        ...(str(domain) ? { domain: str(domain) } : {}),
      });
    }
    if (next.length === todo.length) throw new Error(`home-sync: the box's type ${String(next[0]!["type"])} has a parent this strut lacks`);
    todo = next;
  }
  for (const r of memory.edge_rules) {
    await b.schemas.createEdgeSchema(r.source, r.edge, r.target, {
      ...(r.temporal !== undefined ? { temporal: r.temporal } : {}),
      ...(r.cardinality !== undefined ? { cardinality: r.cardinality as "one" | "many" } : {}),
    }, { aliases: r.aliases ?? [] });
  }
}

/** A column's value as the column takes it: lists and vectors cast, an empty list having no type of its own. */
const value = (col: string, type: string, i: number) => `${q(col)}: CAST($v${i} AS ${type})`;

/** The copy's side: its memory replaced by `memory`, in one transaction.
 *  The caller has run `ensureTypes`. Returns what was written. */
export async function replaceMemory(b: LadybugBackend, memory: Memory): Promise<{ nodes: number; edges: number; dropped_edges: number }> {
  const nodeCols = await columns(b, "Node");
  // An edge type this strut has no table for (no rule between memory types made it here) is not written.
  const tables = new Set(await relTables(b));
  const relCols = new Map<string, Map<string, string>>();
  for (const table of new Set(memory.edges.map((e) => e.type))) if (tables.has(table)) relCols.set(table, await columns(b, table));
  const types = [...new Set([...(await memoryTypes(b)), ...memory.nodes.map((n) => String(n["node_type"]))])];
  return b.tx(async (tx) => {
    await tx.run(`MATCH (n:Node) WHERE n.node_type IN $types DETACH DELETE n`, { types });
    for (const n of memory.nodes) {
      const params: Record<string, unknown> = {};
      const fields = Object.entries(n).filter(([k]) => nodeCols.has(k)).map(([k, v], i) => ((params[`v${i}`] = v), value(k, nodeCols.get(k)!, i)));
      await tx.run(`CREATE (n:Node {${fields.join(", ")}})`, params);
    }
    let edges = 0, dropped = 0;
    for (const e of memory.edges) {
      const cols = relCols.get(e.type);
      if (!cols) {
        dropped++;
        continue;
      }
      const params: Record<string, unknown> = { f: e.from, t: e.to };
      const fields = Object.entries(e.props).filter(([k]) => cols.has(k)).map(([k, v], i) => ((params[`v${i}`] = v), value(k, cols.get(k)!, i)));
      const made = await tx.run(`MATCH (a:Node {ref_id: $f}), (z:Node {ref_id: $t}) CREATE (a)-[r:${q(e.type)} {${fields.join(", ")}}]->(z) RETURN count(r) AS c`, params);
      if (Number(made[0]?.["c"] ?? 0) > 0) edges++;
      else dropped++;
    }
    return { nodes: memory.nodes.length, edges, dropped_edges: dropped };
  });
}
