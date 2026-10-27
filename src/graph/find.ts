/**
 * `findNodes` — the nodes of ONE type whose properties match, ordered and
 * paged (plans/apps.md §4.3): the property query the reader's search, get,
 * neighbors and names reads do not have. "Invoices where status is unpaid,
 * due before today, by due date" is one call. The `graph/find` step is thin
 * over it.
 *
 * One statement per page on either engine, written with the dialect
 * helpers (`node`, `live`, `lower`, `project`) and nothing else; property
 * access and comparisons are the same text on both. Every field a filter,
 * an order or the projection names is an attribute of the type's schema
 * (as the resolver merges it, inherited included), `ref_id` or
 * `date_added_to_graph` — never text from the caller in the statement, and
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
import { toEpochSeconds } from "./node-writer.js";

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
  /** A field to order by (default: newest first, `date_added_to_graph`). */
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

/** Fields every node has besides its type's attributes. */
const NODE_FIELDS: Record<string, string> = { ref_id: "string", date_added_to_graph: "float" };

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
  if (!type || !schema) throw new FindError(`unknown node type "${raw}" — graph/get-ontology lists the types`);

  const fields: Record<string, string> = { ...schema.attributes, ...NODE_FIELDS };
  const known = Object.keys(fields).sort();
  const field = (name: string, where: string): string => {
    if (!(name in fields)) throw new FindError(`${where}: ${type} has no field "${name}" — its fields: ${known.join(", ")}`);
    return `n.\`${name}\``;
  };

  const d = b.dialect;
  const params: Record<string, unknown> = { ns: input.namespace ?? b.namespace ?? DEFAULT_NAMESPACE, default_ns: DEFAULT_NAMESPACE };
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
  for (const [name, cond] of Object.entries(input.where ?? {})) {
    const ref = field(name, `where.${name}`);
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
  const order = input.orderBy ? field(input.orderBy, "orderBy") : "n.`date_added_to_graph`";
  const dir = (input.orderBy ? input.desc : input.desc ?? true) ? "DESC" : "ASC";

  const rows = await b.query(
    `${match}
     RETURN ${d.project("n", known)} AS props
     ORDER BY ${order} ${dir}, n.\`ref_id\`
     SKIP ${offset} LIMIT ${limit + 1}`,
    params,
  );
  const more = rows.length > limit;
  const title = schema.title_key && schema.title_key in fields ? schema.title_key : "name";
  const nodes = rows.slice(0, limit).map((r): FoundNode => {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((r["props"] ?? {}) as Record<string, unknown>)) if (v !== null && v !== undefined) props[k] = v;
    const ref_id = String(props["ref_id"]);
    delete props["ref_id"];
    const name = props[title] ?? props["name"];
    return { ref_id, node_type: type, ...(typeof name === "string" && name ? { name } : {}), properties: props };
  });

  let total: number | undefined;
  if (input.count) {
    const counted = await b.query(`${match} RETURN count(n) AS total`, params);
    total = Number(counted[0]?.["total"] ?? 0);
  }
  return { node_type: type, nodes, returned: nodes.length, ...(more ? { cursor: encodeCursor(offset + limit) } : {}), ...(total !== undefined ? { total } : {}) };
}
