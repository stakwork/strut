/**
 * `findNodes` — the nodes of ONE type whose properties match, ordered and
 * paged (plans/apps.md §4.3): the property query the reader's search, get,
 * neighbors and names reads do not have. "Invoices where status is unpaid,
 * due before today, by due date" is one call. The `graph/find` step is thin
 * over it.
 *
 * One statement per page on either engine, written with the dialect
 * helpers (`node`, `live`, `lower`) and nothing else; property access
 * (`n.<field>`, on Neo4j under the name it stores: `storedName`) and
 * comparisons are the same text on both. Every field a filter,
 * an order or the projection names is an attribute of the type's schema
 * (as the resolver merges it, inherited included), `ref_id` or the core
 * stamp — `created_at` (`date_added_to_graph`, its old name, still
 * accepted; Neo4j stores it so), or `date_added_to_graph` on a type that
 * declares its own `created_at` (jarvis's PullRequest, Concept, … on Neo4j),
 * whose field that name stays: the writer's `stampKey` — never text from
 * the caller in the statement, and
 * on a LadybugDB file never a column the table does not have. Values are
 * parameters; a `datetime` attribute's value is turned into the epoch
 * seconds the writer stores (an ISO string or a number), and an app's
 * `date` is an ISO string, which compares as text.
 *
 * Hidden like every read: soft-deleted nodes, and on Neo4j a muted one.
 * Reports nothing as provenance: a list is not what the caller named.
 */
import type { GraphBackend } from "./backend.js";
import { DEFAULT_NAMESPACE } from "./bolt.js";
import { namespaceName } from "./ladybug/namespaces.js";
import { HIDDEN_TYPES } from "./ladybug/registry.js";
import { boundsOf, branchedNamespaceOf, hidesType, onBranchSide, readsNamespace } from "./scope.js";
import { storedName } from "./neo4j-engine.js";
import { stampKey, toEpochSeconds } from "./node-writer.js";
import { nodeTitle } from "./title.js";

export const FIND_LIMIT_DEFAULT = 50;
export const FIND_LIMIT_MAX = 500;

/** The comparisons a `where` field takes besides plain equality. */
export const FIND_OPERATORS = ["gt", "gte", "lt", "lte", "in", "contains"] as const;
export type FindOperator = (typeof FIND_OPERATORS)[number];

/** A field's condition: a value (equal; `null` = not set), or operators, all of which must hold. */
export type FindCondition = string | number | boolean | null | Partial<Record<FindOperator, unknown>>;

export interface FindInput {
  node_type: string;
  where?: Record<string, FindCondition>;
  /** A field to order by (default: newest first, `created_at`). */
  orderBy?: string;
  desc?: boolean;
  limit?: number;
  /** The `cursor` an earlier page returned. */
  cursor?: string;
  /** Also count every match (`total`). */
  count?: boolean;
  namespace?: string;
}

export interface FoundNode {
  ref_id: string;
  node_type: string;
  name?: string;
  properties: Record<string, unknown>;
}

export interface FindResult {
  node_type: string;
  nodes: FoundNode[];
  returned: number;
  /** Set when there are more: pass it back for the next page. */
  cursor?: string;
  total?: number;
}

/** A find the caller got wrong — what `graph/find` says back. */
export class FindError extends Error {
  override name = "FindError";
}

const baseOf = (t: string) => t.replace(/^\?/, "");
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const CMP: Record<Exclude<FindOperator, "in" | "contains">, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** The cursor is the offset of the next page, opaque to the caller. */
const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string): number {
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw new FindError("cursor: not a cursor graph/find returned — pass it back as it came");
}

export async function findNodes(b: GraphBackend, input: FindInput): Promise<FindResult> {
  const raw = String(input.node_type ?? "").trim();
  if (!raw) throw new FindError("node_type is required");
  const type = await b.schemas.resolveType(raw);
  const schema = type ? await b.schemas.schema(type) : null;
  // A reader's list (scope.ts) applies here, on the one type and namespace
  // read: a hidden type is unknown, a hidden namespace holds nothing.
  const bounds = boundsOf(b);
  // A fact's search row (EdgeText) is read as its fact, through search, a
  // merge record (Merge) through the node it points to, and a mishearing
  // through dictation: none is a node.
  const hiddenRow = b.kind === "ladybug" && !!type && HIDDEN_TYPES.includes(type);
  if (!type || !schema || hiddenRow || (bounds && hidesType(bounds.list, schema.domainLabels))) throw new FindError(`unknown node type "${raw}" — graph/get-ontology lists the types`);
  const query = bounds?.query ?? b.query.bind(b);

  // Fields every node has besides its type's attributes: `ref_id` and the
  // core stamp, under the name the writer gives it on this type.
  const stamp = stampKey(schema);
  const fields: Record<string, string> = { ...schema.attributes, ref_id: "string", [stamp]: "float" };
  const known = Object.keys(fields).sort();
  // jarvis's name for the stamp, still accepted where it is not the type's own field.
  const canonicalField = (name: string) => (name === "date_added_to_graph" && stamp === "created_at" ? "created_at" : name);
  const d = b.dialect;
  const col = (name: string) => `n.\`${d.kind === "neo4j" ? storedName(schema, name) : name}\``;
  const field = (name: string, where: string): string => {
    if (!(name in fields)) throw new FindError(`${where}: ${type} has no field "${name}" — its fields: ${known.join(", ")}`);
    return col(name);
  };

  // On a ladybug file `default` is the backend's own namespace.
  const ns = b.kind === "ladybug" ? namespaceName(input.namespace, b.namespace) : input.namespace ?? b.namespace ?? DEFAULT_NAMESPACE;
  if (ns === null) throw new FindError(`namespace ${String(input.namespace)} is not a namespace name`);
  // A run on a Concept branch reads the branch's Concepts, and nothing else there.
  const at = branchedNamespaceOf(b, type, ns);
  if ((bounds && !readsNamespace(bounds.list, ns, b.namespace)) || !onBranchSide(b, type, at)) return { node_type: type, nodes: [], returned: 0, ...(input.count ? { total: 0 } : {}) };
  const params: Record<string, unknown> = { ns: at, default_ns: DEFAULT_NAMESPACE };
  let p = 0;
  const param = (name: string, value: unknown): string => {
    const base = baseOf(fields[name]!);
    let v = value;
    if (base === "datetime") {
      const coerce = (x: unknown) => {
        const secs = toEpochSeconds(x);
        if (secs === null) throw new FindError(`where.${name}: ${name} is a datetime — give an ISO-8601 string or epoch seconds`);
        return secs;
      };
      v = Array.isArray(value) ? value.map(coerce) : coerce(value);
    }
    const key = `p${p++}`;
    params[key] = v;
    return `$${key}`;
  };

  const clauses = [d.live("n"), `coalesce(n.namespace, $default_ns) = $ns`];
  // jarvis's hide flag, which every Neo4j read honors (the file keeps none).
  // Not its blocked statuses: a `status: failed` is an app's data here.
  if (b.kind === "neo4j") clauses.push(`(n.is_muted IS NULL OR n.is_muted <> true)`);
  for (const [given, cond] of Object.entries(input.where ?? {})) {
    const name = canonicalField(given);
    const ref = field(name, `where.${given}`);
    const base = baseOf(fields[name]!);
    if (cond === null) {
      clauses.push(`${ref} IS NULL`);
      continue;
    }
    if (!isPlain(cond)) {
      if (Array.isArray(cond)) throw new FindError(`where.${name}: a list matches nothing as a value — use { in: [...] }`);
      clauses.push(`${ref} = ${param(name, cond)}`);
      continue;
    }
    const ops = Object.keys(cond);
    if (!ops.length) throw new FindError(`where.${name}: an empty condition — give a value, or one of ${FIND_OPERATORS.join(", ")}`);
    for (const op of ops) {
      const value = cond[op as FindOperator];
      if (!(FIND_OPERATORS as readonly string[]).includes(op)) throw new FindError(`where.${name}.${op}: not an operator — ${FIND_OPERATORS.join(", ")}, or a plain value for equality`);
      if (base === "list" || base === "complex") throw new FindError(`where.${name}: ${name} is a ${base}, which compares only as a whole value`);
      if (op === "in") {
        if (!Array.isArray(value) || !value.length) throw new FindError(`where.${name}.in: a non-empty list of values`);
        clauses.push(`${ref} IN ${param(name, value)}`);
      } else if (op === "contains") {
        if (base !== "string") throw new FindError(`where.${name}.contains: ${name} is a ${base} — contains takes a string field`);
        if (typeof value !== "string" || !value) throw new FindError(`where.${name}.contains: a non-empty string`);
        const key = `p${p++}`;
        params[key] = value.toLowerCase();
        clauses.push(`${d.lower(ref)} CONTAINS $${key}`);
      } else {
        if (value === null || value === undefined || typeof value === "object") throw new FindError(`where.${name}.${op}: a string or a number`);
        clauses.push(`${ref} ${CMP[op as keyof typeof CMP]} ${param(name, value)}`);
      }
    }
  }

  const match = `MATCH ${d.node("n", type)} WHERE ${clauses.join(" AND ")}`;
  const limit = Math.min(FIND_LIMIT_MAX, Math.max(1, Math.floor(Number(input.limit ?? FIND_LIMIT_DEFAULT)) || FIND_LIMIT_DEFAULT));
  const offset = input.cursor ? decodeCursor(input.cursor) : 0;
  const order = field(input.orderBy ? canonicalField(input.orderBy) : stamp, "orderBy");
  const dir = (input.orderBy ? input.desc : input.desc ?? true) ? "DESC" : "ASC";

  const rows = await query(
    `${match}
     RETURN {${[...new Set([...known, "title"])].map((f) => `\`${f}\`: ${col(f)}`).join(", ")}} AS props
     ORDER BY ${order} ${dir}, n.\`ref_id\`
     SKIP ${offset} LIMIT ${limit + 1}`,
    params,
  );
  const more = rows.length > limit;
  const nodes = rows.slice(0, limit).map((r): FoundNode => {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((r["props"] ?? {}) as Record<string, unknown>)) if (v !== null && v !== undefined) props[k] = v;
    const ref_id = String(props["ref_id"]);
    delete props["ref_id"];
    // The stamp's old name, kept for a release as the node envelopes keep it.
    if (stamp === "created_at" && props["created_at"] !== undefined) props["date_added_to_graph"] = props["created_at"];
    const name = nodeTitle(props, schema.title_key) || props["name"];
    // The core title is the node's `name` here; `properties` are the type's fields.
    if (!("title" in fields)) delete props["title"];
    return { ref_id, node_type: type, ...(typeof name === "string" && name ? { name } : {}), properties: props };
  });

  let total: number | undefined;
  if (input.count) {
    const counted = await query(`${match} RETURN count(n) AS total`, params);
    total = Number(counted[0]?.["total"] ?? 0);
  }
  return { node_type: type, nodes, returned: nodes.length, ...(more ? { cursor: encodeCursor(offset + limit) } : {}), ...(total !== undefined ? { total } : {}) };
}
