/**
 * `resolve` (plans/graph-memory-plan.md step 5): given what a caller knows
 * about a thing — its type, and a key, identifiers, a name or aliases —
 * find the ONE existing node, or say which nodes might be it. No model is
 * involved: every stage is an exact lookup, and only the last is a search.
 *
 * The stages, in order; the first that finds anything decides:
 *
 *   1. `key`: the node's stored key, given or composed from `data` the way
 *      the writer composes it (`composeNodeKey`). A type keyed by `ref_id`
 *      (Person) has no key a caller can know, so this stage skips it. A
 *      key held only by a node merged into another (`merge.ts`) finds the
 *      node it was merged into;
 *   2. `identifier`: the type's identifiers (`NodeSchema.identifiers`,
 *      Person's `email`), unique per namespace, read from `data`;
 *   3. `name`: the node's stored `title`, case- and space-blind. The name
 *      is `name`, else the title `data` composes from the type's `title_key`;
 *   4. `alias`: the name or one of `aliases` among a node's `alt_names`, or
 *      one of `aliases` as a node's title. Only a type that declares
 *      `alt_names` has this stage;
 *   5. otherwise candidates: the reader's search for the name and aliases
 *      (keyword + semantic, ranked), then titles that contain the name.
 *
 * One node at a stage is the `match`. Two or more is `ambiguous`: they are
 * the candidates, and nothing is chosen — two people with the same name
 * stay two (pass criterion 9). A node's aliases are the `alt_names` list
 * field, not `aliases`: on a Ladybug file that column is the Schema rows'
 * type aliases (`registry.ts` `SCHEMA_COLUMNS`).
 *
 * It reads only the namespaces it is given, default the backend's own (where
 * a write that names none goes); two namespaces holding the same key are two
 * nodes, and ambiguous. Under a reader list (scope.ts) it reads only what the
 * list reads: the namespaces asked for that the list holds, or with none
 * asked, the list's own; a type the list's domains hide is unknown, and a
 * node outside the list is no match.
 *
 * Ladybug only. On Neo4j it is refused (`ResolveError`): a Neo4j graph
 * stores no core `title` and no `alt_names`, and its namespaces are jarvis's
 * registered partitions, not the per-node `namespace` this scopes by —
 * supporting it would mean new data shapes there.
 */
import type { GraphBackend } from "./backend.js";
import type { Row } from "./engine.js";
import { namespaceName } from "./ladybug/namespaces.js";
import { mergedInto } from "./ladybug/merge.js";
import { EDGE_TEXT_TYPE, MERGE_TYPE, SCHEMA_TYPE } from "./ladybug/registry.js";
import { ALT_NAMES, GraphValidationError, composeNodeKey, keyedByRef } from "./node-writer.js";
import { ALL_NAMESPACES, boundsOf, hidesType, readsNamespace, type ReaderList } from "./scope.js";
import type { NodeSchema } from "./schema-resolver.js";
import { GraphReadError } from "./search.js";
import { composeTitle } from "./title.js";

/** The list field a node's other names are kept in. */
export { ALT_NAMES };

export type ResolveStage = "key" | "identifier" | "name" | "alias";

export interface ResolveInput {
  /** The node type, any case. */
  type: string;
  /** The node's stored key, when the caller has it. */
  key?: string;
  /** Fields the caller knows, as it would write them: the key, the
   *  identifiers and the title come from them when not given on their own. */
  data?: Record<string, unknown>;
  name?: string;
  aliases?: string[];
  /** Where to look; default the backend's own. `default` is the backend's own. */
  namespaces?: string[];
  /** Most candidates to return (1–50, default 5). */
  limit?: number;
}

export interface ResolvedNode {
  ref_id: string;
  node_type: string;
  namespace: string;
  key: string;
  title?: string;
  description?: string;
  /** The type's identifier values the node holds. */
  identifiers?: Record<string, unknown>;
  alt_names?: string[];
  /** Which stage found it; `search` for a candidate the search ranked. */
  matched_by: ResolveStage | "search";
}

export interface ResolveResult {
  node_type: string;
  namespaces: string[];
  /** The one node a stage found; null when none did, or several did. */
  match: ResolvedNode | null;
  /** Several nodes at one stage: they are `candidates`, and none is chosen. */
  ambiguous: boolean;
  /** With no match, the nodes that may be it, best first. */
  candidates: ResolvedNode[];
}

/** A resolve this backend cannot answer. */
export class ResolveError extends Error {
  override name = "ResolveError";
}

const CANDIDATES_DEFAULT = 5;
const CANDIDATES_MAX = 50;
/** Search hits read per wanted candidate: search is not yet scoped by
 *  namespace or liveness here, so a hit outside the scope is dropped after. */
const SEARCH_OVERFETCH = 4;

const q = (s: string) => `\`${s}\``;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const LIVE_IN = (alias: string) => `${alias}.node_type = $type AND ${alias}.namespace IN $ns AND ${alias}.deleted_at IS NULL`;

export async function resolveNode(b: GraphBackend, input: ResolveInput): Promise<ResolveResult> {
  if (b.kind !== "ladybug") throw new ResolveError(`resolve is not on this backend (${b.kind}): it reads a Ladybug file's titles, alt_names and namespaces`);
  const schema = await b.schemas.schema(String(input.type ?? ""));
  // The view's own query refuses a limited reader: the list is applied here.
  const bounds = boundsOf(b);
  if (!schema || (bounds && hidesType(bounds.list, schema.domainLabels))) throw new GraphValidationError("UNKNOWN_TYPE", String(input.type), "unknown node type");
  // The ontology's Schema rows and the edges' search rows are not data nodes.
  if (schema.type === SCHEMA_TYPE || schema.type === EDGE_TEXT_TYPE || schema.type === MERGE_TYPE) throw new GraphValidationError("WRONG_TYPE", schema.type, "not a node type resolve reads");
  const namespaces = scope(input.namespaces, b.namespace, bounds?.list);
  if (!namespaces.length) return { node_type: schema.type, namespaces, match: null, ambiguous: false, candidates: [] };
  const query: GraphBackend["query"] = bounds?.query ?? b.query.bind(b);
  const limit = Math.min(CANDIDATES_MAX, Math.max(1, Math.floor(Number(input.limit) || CANDIDATES_DEFAULT)));
  const data = input.data ?? {};
  const base = { type: schema.type, ns: namespaces };
  const run = (cypher: string, params: Record<string, unknown>) => query(cypher, { ...base, ...params });
  const refs = (rows: Row[]) => [...new Set(rows.map((r) => String(r["ref_id"])))];

  const name = (input.name ?? "").trim() || composeTitle(schema.title_key, data);
  const aliases = [...(input.aliases ?? []), ...stringList(data[ALT_NAMES])].map((a) => String(a).trim()).filter(Boolean);
  const hasAltNames = ALT_NAMES in schema.attributes;

  const stages: Array<[ResolveStage, () => Promise<string[]>]> = [
    ["key", async () => {
      const key = (input.key ?? "").trim() || composedKey(schema, data);
      if (!key) return [];
      const live = refs(await run(`MATCH (n:Node {key: $key}) WHERE ${LIVE_IN("n")} RETURN n.ref_id AS ref_id`, { key }));
      if (live.length) return live;
      // A node merged into another (`merge.ts`) is found as the one it went into.
      const merged = refs(await run(`MATCH (n:Node {key: $key}) WHERE n.node_type = $type AND n.namespace IN $ns AND n.deleted_at IS NOT NULL RETURN n.ref_id AS ref_id`, { key }));
      const into = await Promise.all(merged.map((id) => mergedInto((c, p) => query(c, p), id)));
      return [...new Set(into.filter((id): id is string => id !== null))];
    }],
    ["identifier", async () => {
      const found: string[] = [];
      for (const attr of schema.identifiers ?? []) {
        const v = data[attr];
        if (v === undefined || v === null || v === "") continue;
        found.push(...refs(await run(`MATCH (n:Node) WHERE ${LIVE_IN("n")} AND n.${q(attr)} = $v RETURN n.ref_id AS ref_id`, { v: typeof v === "string" ? v.trim() : v })));
      }
      return [...new Set(found)];
    }],
    ["name", async () => (name ? refs(await run(`MATCH (n:Node) WHERE ${LIVE_IN("n")} AND lower(trim(n.title)) = $name RETURN n.ref_id AS ref_id`, { name: norm(name) })) : [])],
    ["alias", async () => {
      const all = [...new Set([name, ...aliases].filter(Boolean).map(norm))];
      const asTitle = [...new Set(aliases.map(norm))];
      if (!all.length) return [];
      // A lambda cannot read a parameter on Ladybug: the list is unwound.
      const inAlts = hasAltNames
        ? await run(`MATCH (n:Node) WHERE ${LIVE_IN("n")} AND n.${q(ALT_NAMES)} IS NOT NULL UNWIND n.${q(ALT_NAMES)} AS a WITH n, a WHERE lower(trim(a)) IN $names RETURN DISTINCT n.ref_id AS ref_id`, { names: all })
        : [];
      const asTitles = asTitle.length ? await run(`MATCH (n:Node) WHERE ${LIVE_IN("n")} AND lower(trim(n.title)) IN $asTitle RETURN n.ref_id AS ref_id`, { asTitle }) : [];
      return refs([...inAlts, ...asTitles]);
    }],
  ];

  for (const [stage, find] of stages) {
    const found = await find();
    if (!found.length) continue;
    const nodes = await hydrate(query, schema, namespaces, found, stage);
    if (nodes.length === 1) return { node_type: schema.type, namespaces, match: nodes[0]!, ambiguous: false, candidates: [] };
    if (nodes.length > 1) return { node_type: schema.type, namespaces, match: null, ambiguous: true, candidates: nodes.slice(0, limit) };
  }

  return { node_type: schema.type, namespaces, match: null, ambiguous: false, candidates: await candidates(b, query, schema, namespaces, [name, ...aliases].filter(Boolean), limit) };
}

/** The namespaces asked for, checked; the backend's own when none are.
 *  Under a reader list, only those it reads, and with none asked, the
 *  list's own (`*` keeps the backend's). */
function scope(asked: string[] | undefined, own: string, reads?: ReaderList): string[] {
  const all = !reads || reads.namespaces.includes(ALL_NAMESPACES);
  const list = asked?.length ? asked : all ? [own] : reads.namespaces;
  const out: string[] = [];
  for (const raw of list) {
    const ns = namespaceName(String(raw), own);
    if (ns === null) throw new GraphReadError("INVALID_NAMESPACE", `${String(raw)} is not a namespace name`);
    if (reads && !readsNamespace(reads, ns, own)) continue;
    if (!out.includes(ns)) out.push(ns);
  }
  return out;
}

/** The key the writer would give `data`, or "" when it has not every token. */
function composedKey(schema: NodeSchema, data: Record<string, unknown>): string {
  if (keyedByRef(schema) || !Object.keys(data).length) return "";
  try {
    return composeNodeKey(schema, data);
  } catch (e) {
    if (e instanceof GraphValidationError) return "";
    throw e;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
}

/** The nodes behind `ref_ids` that are in scope, in the order given. */
async function hydrate(query: GraphBackend["query"], schema: NodeSchema, namespaces: string[], ref_ids: string[], matched_by: ResolvedNode["matched_by"]): Promise<ResolvedNode[]> {
  if (!ref_ids.length) return [];
  const fields = [...new Set([schema.description_key, ...(schema.identifiers ?? []), ...(ALT_NAMES in schema.attributes ? [ALT_NAMES] : [])])].filter((f) => f && f in schema.attributes);
  const rows = await query(
    `MATCH (n:Node) WHERE n.ref_id IN $ids AND ${LIVE_IN("n")}
     RETURN n.ref_id AS ref_id, n.namespace AS namespace, n.\`key\` AS key, n.title AS title${fields.map((f, i) => `, n.${q(f)} AS f${i}`).join("")}`,
    { ids: ref_ids, type: schema.type, ns: namespaces },
  );
  const byRef = new Map(rows.map((r) => [String(r["ref_id"]), r]));
  return ref_ids.flatMap((ref_id) => {
    const r = byRef.get(ref_id);
    if (!r) return [];
    const value = (f: string) => r[`f${fields.indexOf(f)}`];
    const identifiers = Object.fromEntries((schema.identifiers ?? []).map((f) => [f, value(f)]).filter(([, v]) => v !== null && v !== undefined));
    const description = value(schema.description_key);
    const alts = stringList(value(ALT_NAMES));
    const node: ResolvedNode = {
      ref_id,
      node_type: schema.type,
      namespace: String(r["namespace"]),
      key: String(r["key"]),
      ...(typeof r["title"] === "string" && r["title"] ? { title: r["title"] } : {}),
      ...(typeof description === "string" && description ? { description } : {}),
      ...(Object.keys(identifiers).length ? { identifiers } : {}),
      ...(alts.length ? { alt_names: alts } : {}),
      matched_by,
    };
    return [node];
  });
}

/** Nodes that may be the one: the search's ranking for each name, then the
 *  titles that contain the name, in scope and once each. */
async function candidates(b: GraphBackend, query: GraphBackend["query"], schema: NodeSchema, namespaces: string[], names: string[], limit: number): Promise<ResolvedNode[]> {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (ids: string[]) => ids.forEach((id) => !seen.has(id) && (seen.add(id), ordered.push(id)));
  for (const n of names) {
    const hits = await b.reader.search({ q: n, types: [schema.type], limit: limit * SEARCH_OVERFETCH });
    add(hits.nodes.map((h) => h.ref_id));
  }
  const ranked = await hydrate(query, schema, namespaces, ordered, "search");
  if (names[0] && ranked.length < limit) {
    const rows = await query(`MATCH (n:Node) WHERE ${LIVE_IN("n")} AND lower(n.title) CONTAINS $frag RETURN n.ref_id AS ref_id ORDER BY n.title LIMIT ${limit}`, {
      type: schema.type,
      ns: namespaces,
      frag: norm(names[0]),
    });
    const more = rows.map((r) => String(r["ref_id"])).filter((id) => !seen.has(id));
    ranked.push(...(await hydrate(query, schema, namespaces, more, "search")));
  }
  return ranked.slice(0, limit);
}
