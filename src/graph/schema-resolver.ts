/**
 * Live schema resolution — how the backend knows about node types that are
 * NOT Strut's own (Document, EvalSet, Concept, …): exactly the way jarvis
 * does, from the `:Schema` meta-graph in the database.
 *
 *   - type canonicalization (`node_type_helper.resolve_canonical_node_type`):
 *     Strut registry exact match → live label catalog, case-insensitive →
 *     `Schema.type`, case-insensitive;
 *   - the merged schema (`schema_crud.get_schema`): the node's own props plus
 *     every CHILD_OF ancestor's, child wins, ancestors' `type_description`
 *     ignored;
 *   - domain labels (`domain_helper.get_domain_labels_for_node`): the
 *     schema's `domain` → `Domain_<lower>`, dropped when the type or an
 *     ancestor is in `About.hidden_types` or the domain in `hidden_domains`;
 *   - edge schemas (`schema_crud.get_schema_edge_by_edge_type`): exact,
 *     then source-ancestor, target-ancestor, both-ancestor walks (depth 10),
 *     then the `*`→`*` wildcard; short-circuited by jarvis's `EDGE_TYPES`
 *     allowlist;
 *   - `create_schema_if_missing` (`schema_crud.create_edge_schema`).
 *
 * Strut's own types resolve from the in-code registry (`strut-schemas.ts`)
 * without touching the DB. Everything is cached per resolver with a short
 * TTL, like jarvis's in-process caches.
 *
 * The reads and the one write live behind `SchemaSource` (`engine.ts`):
 * the `:Schema` meta-graph on Neo4j, the `Schema` table on Ladybug. This
 * file merges, walks, caches and canonicalizes; it issues no Cypher.
 */
import { randomUUID } from "node:crypto";
import type { EdgeSchemaWalk, EngineLike, GraphEngine, GraphTx } from "./engine.js";
import { asEngine } from "./neo4j-engine.js";
import {
  SCHEMA_CORE_PROPERTIES,
  STRUT_DOMAIN,
  STRUT_SCHEMAS,
  effectiveAttributes,
  getStrutSchema,
  type StrutSchema,
} from "./strut-schemas.js";

/** jarvis `ApplicationConstant.EDGE_TYPES` — edge types accepted WITHOUT an
 *  edge schema. */
export const EDGE_TYPES_ALLOWLIST = new Set([
  "RELATED_TO", "CREATED_BY", "PARENT_OF", "CHILD_OF", "ALIAS_OF", "TYPE_OF", "PART_OF", "MENTIONS",
  "ORGANIZES", "BELONGS_TO", "OPINION", "USES", "FEATURES", "MEMBER_OF", "SUMMARIZED_AS", "CONTRIBUTES_TO",
  "DEPENDS_ON", "INFLUENCES", "OWNED_BY", "MANAGES", "REPORTS_TO", "COLLABORATES_WITH", "SUPPORTS", "REPLACES",
  "REQUIRES", "INTEGRATES_WITH", "ASSOCIATED_WITH", "PRODUCED_BY", "CONSISTS_OF", "HOSTED_ON", "DEVELOPED_BY",
  "FUNDED_BY", "REGULATED_BY", "HAS_ATTRIBUTE", "INTERACTS_WITH", "EXPORTS_TO", "IMPORTS_FROM", "SYNONYM_OF",
  "TRANSLATED_AS", "CAUSED_BY", "OFFERS", "IMPACT_ON", "IMPACTED", "REFLECTED_ON", "AFFECTED", "SHAPED",
  "INFORMED_BY", "CONTAINS", "HAS", "CALLS", "TESTS", "IS_PREREQUISITE_FOR", "ANSWERS", "FEEDBACK", "REFERS_TO",
  "WORKS_AT", "HAS_PRICE", "HAS_WEATHER", "HAS_CAPITAL", "BORN_ON", "CAUSE_CHILD_OF", "TARGETS_CAUSE",
  "TARGETS_CONCEPT", "SCRATCHPAD_EDGE",
]);

const TYPE_GRAMMAR = /^\??(string|boolean|int|float|complex|datetime|list)$/;

/** The schema shape the writers validate against — Strut registry entries
 *  and DB-resolved jarvis schemas both reduce to this. */
export interface NodeSchema {
  /** Canonical type label. */
  type: string;
  parent?: string;
  node_key: string;
  /** Strut's `exact_key` (strut-schemas.ts): node_key tokens are the hex of
   *  their exact value, not jarvis's sanitized form. */
  exact_key?: boolean;
  /** `get_index_fields`: declared index list (a string becomes a one-item
   *  list); `["node_key"]` when unset. */
  index: string[];
  vector_index: string[];
  /** False when the schema carries the no-embed mark (`embed: false`, a
   *  core Schema key — `SCHEMA_CORE_PROPERTIES`): the writer composes
   *  `Data_Bank` but computes no `text_embeddings`, and the pass removes any
   *  vector such a node holds. */
  embed: boolean;
  /** Attribute name → type string (`?`-prefixed = optional). Includes
   *  everything inherited via CHILD_OF. */
  attributes: Record<string, string>;
  title_key?: string;
  description_key?: string;
  /** `Domain_<x>` labels to stamp on nodes of this type (already filtered
   *  by hidden types/domains). */
  domainLabels: string[];
  /** True for Strut's own types (closed registry rules apply). */
  isStrut: boolean;
}

export interface EdgeSchemaMatch {
  source: string;
  target: string;
  edge_type: string;
  properties: Record<string, unknown>;
  via: "exact" | "ancestor" | "wildcard" | "allowlist";
}

interface Cached<T> {
  at: number;
  value: T;
}

export class SchemaResolver {
  private readonly types = new Map<string, Cached<string | null>>();
  private readonly schemas = new Map<string, Cached<NodeSchema | null>>();
  private readonly edges = new Map<string, Cached<EdgeSchemaMatch | null>>();
  private hidden: Cached<{ domains: Set<string>; types: Set<string> }> | undefined;

  private readonly engine: GraphEngine;

  constructor(engine: EngineLike, private readonly ttlMs = 60_000) {
    this.engine = asEngine(engine);
  }

  private get source() {
    return this.engine.schemaSource;
  }

  /** Drop every cache (call after seeding or schema edits). */
  invalidate(): void {
    this.types.clear();
    this.schemas.clear();
    this.edges.clear();
    this.hidden = undefined;
  }

  private fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
    return !!c && Date.now() - c.at < this.ttlMs;
  }

  /**
   * Canonical type for a user-supplied string, or null. Strut types must
   * match exactly (registry); everything else resolves case-insensitively
   * against `Schema.type` first, then live labels — exact case preferred in
   * both. Schema first, because a long-lived jarvis graph carries LEGACY
   * labels that differ only by case (`Evalset` next to `EvalSet`, with no
   * nodes and no Schema): Neo4j keeps them in `db.labels()` forever, and
   * "first label that matches case-insensitively" then canonicalizes to a
   * type that has no Schema, so every write fails UNKNOWN_TYPE while the
   * real schema sits right there.
   */
  async resolveType(raw: string, tx?: GraphTx): Promise<string | null> {
    const key = raw.trim();
    if (!key) return null;
    if (getStrutSchema(key)) return key;
    const c = this.types.get(key.toLowerCase());
    if (this.fresh(c)) return c.value;
    let out: string | null = (await this.source.schemaRow(key, { live: true }, tx))?.type ?? null;
    if (!out) out = await this.source.labelLike(key, tx);
    if (out && getStrutSchema(out)) out = getStrutSchema(out)!.type;
    this.types.set(key.toLowerCase(), { at: Date.now(), value: out });
    return out;
  }

  /** The merged schema for a (raw) type, or null when unknown. */
  async schema(raw: string, tx?: GraphTx): Promise<NodeSchema | null> {
    const type = await this.resolveType(raw, tx);
    if (!type) return null;
    const c = this.schemas.get(type);
    if (this.fresh(c)) return c.value;
    const hidden = await this.hiddenSets(tx);
    let out: NodeSchema | null;
    const strut = getStrutSchema(type);
    if (strut) out = fromStrut(strut, hidden);
    else out = await this.fromDb(type, hidden, tx);
    this.schemas.set(type, { at: Date.now(), value: out });
    return out;
  }

  private async fromDb(type: string, hidden: { domains: Set<string>; types: Set<string> }, tx?: GraphTx): Promise<NodeSchema | null> {
    const row = await this.source.schemaRow(type, {}, tx);
    if (!row || row.type !== type) return null;
    const own = row.props;
    const { chain, rows: ancestors } = await this.source.ancestors(type, tx);
    const merged: Record<string, unknown> = { ...own };
    for (const a of ancestors) {
      for (const [k, v] of Object.entries(a)) {
        if (k in merged || k === "type_description") continue;
        merged[k] = v;
      }
    }
    // jarvis validates against the flat merged dict: every key whose value
    // is a type string is an attribute — including keys that happen to be
    // in SCHEMA_KNOWN_PROPERTIES (Document's `source_link: "string"`,
    // Thing's `description: "?string"`). Those, plus `name`, are skipped by
    // its required-attribute check, so they are optional here; a node_key
    // token among them is still enforced by the node_key presence check.
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v !== "string" || !TYPE_GRAMMAR.test(v)) continue;
      const neverRequired = k === "name" || SCHEMA_CORE_PROPERTIES.has(k);
      attributes[k] = neverRequired && !v.startsWith("?") ? `?${v}` : v;
    }
    const domain = typeof own["domain"] === "string" ? (own["domain"] as string) : undefined;
    const typeHidden = hidden.types.has(type) || chain.some((t) => hidden.types.has(t));
    const domainLabels = !domain || typeHidden || hidden.domains.has(domain.toLowerCase()) ? [] : [`Domain_${domain.toLowerCase()}`];
    const rawIndex = merged["index"];
    const index = Array.isArray(rawIndex) ? rawIndex.map(String).filter(Boolean) : typeof rawIndex === "string" && rawIndex ? [rawIndex] : [];
    const rawVi = merged["vector_index"];
    return {
      type,
      parent: typeof merged["parent"] === "string" ? (merged["parent"] as string) : undefined,
      node_key: String(merged["node_key"] ?? `${type.toLowerCase()}-name`),
      index: index.length ? index : ["node_key"],
      vector_index: Array.isArray(rawVi) ? rawVi.map(String) : [],
      embed: merged["embed"] !== false,
      attributes,
      title_key: typeof merged["title_key"] === "string" ? (merged["title_key"] as string) : undefined,
      description_key: typeof merged["description_key"] === "string" ? (merged["description_key"] as string) : undefined,
      domainLabels,
      isStrut: false,
    };
  }

  /** `About.hidden_domains` (lowercased) and `hidden_types`. */
  async hiddenSets(tx?: GraphTx): Promise<{ domains: Set<string>; types: Set<string> }> {
    if (this.fresh(this.hidden)) return this.hidden.value;
    const { domains: d, types: t } = await this.source.hidden(tx);
    const value = {
      domains: new Set(Array.isArray(d) ? d.map((x) => String(x).toLowerCase()) : []),
      types: new Set(Array.isArray(t) ? t.map(String) : []),
    };
    this.hidden = { at: Date.now(), value };
    return value;
  }

  /**
   * Is `source -[edge]-> target` allowed? jarvis's allowlist first, then
   * the edge-schema lookup (exact → ancestor walks → wildcard). Types are
   * canonical labels. Returns the match, or null.
   */
  async edgeSchema(edge: string, sourceType: string, targetType: string, tx?: GraphTx): Promise<EdgeSchemaMatch | null> {
    if (EDGE_TYPES_ALLOWLIST.has(edge)) return { source: sourceType, target: targetType, edge_type: edge, properties: {}, via: "allowlist" };
    const key = `${sourceType}|${edge}|${targetType}`;
    const c = this.edges.get(key);
    if (this.fresh(c)) return c.value;
    const walks: Array<[EdgeSchemaWalk, EdgeSchemaMatch["via"]]> = [
      ["exact", "exact"],
      ["source-ancestor", "ancestor"],
      ["target-ancestor", "ancestor"],
      ["both-ancestors", "ancestor"],
      ["wildcard", "wildcard"],
    ];
    let match: EdgeSchemaMatch | null = null;
    for (const [walk, via] of walks) {
      const row = await this.source.findEdgeSchema(walk, sourceType, edge, targetType, tx);
      if (row) {
        match = { source: row.source, target: row.target, edge_type: row.edge_type, properties: row.props, via };
        break;
      }
    }
    if (match && match.via === "exact") match = { ...match, source: sourceType, target: targetType };
    this.edges.set(key, { at: Date.now(), value: match });
    return match;
  }

  /**
   * `create_schema_if_missing`: register `source -[EDGE]-> target` between
   * two existing `:Schema` nodes (`*` allowed on either side; the sentinel
   * is ensured). Idempotent. Returns whether a new schema edge was created.
   */
  async createEdgeSchema(sourceType: string, edge: string, targetType: string): Promise<{ created: boolean; ref_id: string }> {
    const edgeType = edge.toUpperCase().replace(/ /g, "_");
    if (!/^[A-Z][A-Z0-9_]*$/.test(edgeType)) throw new Error(`invalid edge type ${edge}`);
    return this.engine.tx(async (tx) => {
      for (const t of [sourceType, targetType]) {
        if (t === "*") {
          await this.source.ensureWildcardSchema(randomUUID(), tx);
          continue;
        }
        const exists = await this.source.schemaRow(t, {}, tx);
        if (!exists || exists.type !== t) throw new Error(`schema ${t} does not exist`);
      }
      const ref_id = randomUUID();
      const r = await this.source.ensureEdgeSchema(sourceType, edgeType, targetType, { ref_id }, tx);
      this.edges.clear();
      return { created: r?.created ?? false, ref_id: r?.ref_id ?? ref_id };
    });
  }
}

/** A Strut registry schema as a `NodeSchema` (Thing's attributes inherited,
 *  `Domain_strut` unless hidden). */
export function fromStrut(strut: StrutSchema, hidden?: { domains: Set<string>; types: Set<string> }): NodeSchema {
  const hide = hidden ? hidden.types.has(strut.type) || hidden.types.has("Thing") || hidden.domains.has(STRUT_DOMAIN.toLowerCase()) : false;
  return {
    type: strut.type,
    parent: strut.parent,
    node_key: strut.node_key,
    ...(strut.exact_key ? { exact_key: true } : {}),
    index: [...strut.index],
    vector_index: [...(strut.vector_index ?? [])],
    embed: strut.embed !== false,
    attributes: { ...effectiveAttributes(strut) },
    title_key: strut.title_key,
    description_key: strut.description_key,
    domainLabels: hide ? [] : [`Domain_${STRUT_DOMAIN.toLowerCase()}`],
    isStrut: true,
  };
}

/** Every Strut registry schema as `NodeSchema` (no DB, no hidden filtering). */
export function strutNodeSchemas(): NodeSchema[] {
  return STRUT_SCHEMAS.map((s) => fromStrut(s));
}
