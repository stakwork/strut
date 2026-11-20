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
 * without touching the DB — except on a store that holds them as Schema
 * rows too (`SchemaSource.holdsStrutTypes`, a Ladybug file), where the row
 * is the type. Everything is cached per resolver with a short
 * TTL, like jarvis's in-process caches.
 *
 * The reads and the one write live behind `SchemaSource` (`engine.ts`):
 * the `:Schema` meta-graph on Neo4j, the `Schema` rows of the `Node` table
 * on Ladybug (`ladybug/ontology.ts`) — the same lookups, so a type resolves
 * the same way on both. A Ladybug file has no `About` (no hidden domains)
 * and no label catalog. This file merges, walks, caches and canonicalizes;
 * it issues no Cypher.
 */
import { randomUUID } from "node:crypto";
import type { EdgeSchemaWalk, EngineLike, GraphEngine, GraphTx } from "./engine.js";
import { asEngine } from "./neo4j-engine.js";
import { VOLATILITIES, isVolatility, type Volatility } from "./fact-score.js";
import { GraphValidationError } from "./node-writer.js";
import {
  GENERIC_NODE_PROPERTIES,
  TYPE_OWNABLE_CORE,
  isGenericProperty,
  SCHEMA_CORE_PROPERTIES,
  STRUT_DOMAIN,
  STRUT_SCHEMAS,
  THING_REFUSED,
  THING_TYPE,
  effectiveAttributes,
  getStrutSchema,
  isStrutType,
  type StrutSchema,
} from "./strut-schemas.js";

/** jarvis `ApplicationConstant.EDGE_TYPES` — edge types accepted WITHOUT an
 *  edge schema, on a graph jarvis shares (it holds jarvis's `About` node) and
 *  nowhere else (plans/ontology.md ruling 1): there an edge needs a rule, as
 *  on a Ladybug file, and strut's own have theirs from the seed. */
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

/** The types whose nodes must have a title (`NodeSchema.requiresTitle`). */
const CONCEPT_TYPE = "Concept";
const ENTITY_TYPE = "Entity";

/** What a type's nodes are: a Schema's `role`, inherited down CHILD_OF
 *  (plans/graph-memory-plan.md step 2). An `entity` or `concept` needs a
 *  title; a `source` (dictation, a transcript, a message) is found by
 *  keyword and gets no embedding unless its Schema says `embed: true`;
 *  `claim` is the claim layer; `record` is strut's own bookkeeping. */
export const NODE_ROLES = ["entity", "concept", "claim", "source", "record"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export const isNodeRole = (v: unknown): v is NodeRole => typeof v === "string" && (NODE_ROLES as readonly string[]).includes(v);

/** An edge type's rule, kept on its edge rules (plans/graph-memory-plan.md
 *  step 2). `cardinality: "one"` is one live edge of the type per source
 *  node: the slot is the source plus the edge type. `temporal` edges are
 *  written by `assert` (step 3). Unset is `many`, not temporal. */
export interface EdgeRule {
  temporal?: boolean;
  cardinality?: "one" | "many";
  /** How fast the type's facts change (`fact-score.ts`); unset reads as `stable`. A Ladybug file only. */
  volatility?: Volatility;
}

/** The rule an edge rule's properties carry. */
export function edgeRuleOf(props: Record<string, unknown>): EdgeRule {
  const out: EdgeRule = {};
  if (typeof props["temporal"] === "boolean") out.temporal = props["temporal"];
  if (props["cardinality"] === "one" || props["cardinality"] === "many") out.cardinality = props["cardinality"];
  if (isVolatility(props["volatility"])) out.volatility = props["volatility"];
  return out;
}

/** The schema shape the writers validate against — Strut registry entries
 *  and DB-resolved jarvis schemas both reduce to this. */
export interface NodeSchema {
  /** Canonical type label. */
  type: string;
  parent?: string;
  /** The key spec (`strutrun-run_id`): a node's `key` is composed from it. */
  key_spec: string;
  /** Strut's `exact_key` (strut-schemas.ts): key tokens are the hex of
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
   *  everything inherited via CHILD_OF. Never a core attribute the writer
   *  owns (`GENERIC_NODE_PROPERTIES`), except a `created_at` a type outside
   *  strut declares (`TYPE_OWNABLE_CORE`: jarvis's Concept, Check, …), which
   *  is the type's own field and optional. */
  attributes: Record<string, string>;
  /** The field the node's `title` comes from, or a `{first} {last}`
   *  template (`composeTitle`, title.ts). Default `name`. A type that
   *  declares its own `title` must have title_key `title` (schema-crud.ts
   *  refuses one that does not). A jarvis type on Neo4j that breaks the rule
   *  (`Person`: `title` is a job title) is not refused: its stored `title`
   *  stays its own, and the writer computes no core title for it. */
  title_key: string;
  /** The field that describes a node. Default `description`. */
  description_key: string;
  /** True when the writer refuses a node whose title comes out empty: an
   *  Entity or a Concept — a type whose `role` is `entity` or `concept`,
   *  and (jarvis's types, which carry no role) the `Concept` type and every
   *  type with `Entity` in its parent chain. */
  requiresTitle?: boolean;
  /** What the type's nodes are (`NODE_ROLES`); inherited. */
  role?: NodeRole;
  /** Attributes whose value names one node of the type in a namespace: the
   *  writer refuses a second live node with the same value. Inherited. */
  identifiers?: string[];
  /** `Domain_<x>` labels to stamp on nodes of this type (already filtered
   *  by hidden types/domains). */
  domainLabels: string[];
  /** True for Strut's own types (strut's in-code rules apply). */
  isStrut: boolean;
}

export interface EdgeSchemaMatch {
  source: string;
  target: string;
  edge_type: string;
  properties: Record<string, unknown>;
  /** The edge type's rule (`edgeRuleOf(properties)`). */
  rule: EdgeRule;
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
  private hidden: Cached<{ domains: Set<string>; types: Set<string>; jarvis: boolean }> | undefined;

  private readonly engine: GraphEngine;

  constructor(engine: EngineLike, private readonly ttlMs = 60_000) {
    this.engine = asEngine(engine);
  }

  private get source() {
    return this.engine.schemaSource;
  }

  /** Strut's own types come from code unless the store holds them. */
  private strut(type: string): StrutSchema | undefined {
    return this.source.holdsStrutTypes ? undefined : getStrutSchema(type);
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
    if (this.strut(key)) return key;
    const c = this.types.get(key.toLowerCase());
    if (this.fresh(c)) return c.value;
    let out: string | null = (await this.source.schemaRow(key, { live: true }, tx))?.type ?? null;
    if (!out) out = await this.source.labelLike(key, tx);
    if (out && this.strut(out)) out = this.strut(out)!.type;
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
    const strut = this.strut(type);
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
    // A Strut type stored as a row (Ladybug) keeps its attributes as declared.
    const isStrut = isStrutType(type);
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v !== "string" || !TYPE_GRAMMAR.test(v) || (isStrut ? GENERIC_NODE_PROPERTIES.has(k) : isGenericProperty(k))) continue;
      // A type's own `created_at` (TYPE_OWNABLE_CORE) is optional too: the
      // writer stamps jarvis's Check one when the caller leaves it out.
      const neverRequired = !isStrut && (k === "name" || SCHEMA_CORE_PROPERTIES.has(k) || TYPE_OWNABLE_CORE.has(k));
      attributes[k] = neverRequired && !v.startsWith("?") ? `?${v}` : v;
    }
    const domain = typeof own["domain"] === "string" ? (own["domain"] as string) : undefined;
    const typeHidden = hidden.types.has(type) || chain.some((t) => hidden.types.has(t));
    const domainLabels = !domain || typeHidden || hidden.domains.has(domain.toLowerCase()) ? [] : [`Domain_${domain.toLowerCase()}`];
    const rawIndex = merged["index"];
    const index = Array.isArray(rawIndex) ? rawIndex.map(String).filter(Boolean) : typeof rawIndex === "string" && rawIndex ? [rawIndex] : [];
    const rawVi = merged["vector_index"];
    const role = isNodeRole(merged["role"]) ? merged["role"] : undefined;
    const identifiers = Array.isArray(merged["identifiers"]) ? merged["identifiers"].map(String).filter(Boolean) : [];
    // The type's own mark wins; else a source is keyword-only; else the
    // inherited mark (Thing's is `embed: true`).
    const embed = typeof own["embed"] === "boolean" ? own["embed"] : role === "source" ? false : merged["embed"] !== false;
    return {
      type,
      parent: typeof merged["parent"] === "string" ? (merged["parent"] as string) : undefined,
      key_spec: String(merged["key_spec"] ?? `${type.toLowerCase()}-name`),
      ...(merged["exact_key"] === true ? { exact_key: true } : {}),
      index: index.length ? index : ["node_key"],
      vector_index: Array.isArray(rawVi) ? rawVi.map(String) : [],
      embed,
      attributes,
      title_key: typeof merged["title_key"] === "string" && merged["title_key"] ? (merged["title_key"] as string) : "name",
      description_key: typeof merged["description_key"] === "string" && merged["description_key"] ? (merged["description_key"] as string) : "description",
      ...(role === "entity" || role === "concept" || type === CONCEPT_TYPE || chain.includes(ENTITY_TYPE) ? { requiresTitle: true } : {}),
      ...(role ? { role } : {}),
      ...(identifiers.length ? { identifiers } : {}),
      domainLabels,
      isStrut,
    };
  }

  /** `About.hidden_domains` (lowercased) and `hidden_types`, and whether
   *  jarvis shares the graph (it holds an `About` node). */
  async hiddenSets(tx?: GraphTx): Promise<{ domains: Set<string>; types: Set<string>; jarvis: boolean }> {
    if (this.fresh(this.hidden)) return this.hidden.value;
    const { domains: d, types: t, about } = await this.source.hidden(tx);
    const value = {
      domains: new Set(Array.isArray(d) ? d.map((x) => String(x).toLowerCase()) : []),
      types: new Set(Array.isArray(t) ? t.map(String) : []),
      jarvis: about === true,
    };
    this.hidden = { at: Date.now(), value };
    return value;
  }

  /**
   * Is `source -[edge]-> target` allowed? jarvis's allowlist first, on a
   * graph jarvis shares; then the edge-schema lookup (exact → ancestor
   * walks → wildcard). Types are canonical labels. Returns the match, or null.
   */
  async edgeSchema(edge: string, sourceType: string, targetType: string, tx?: GraphTx): Promise<EdgeSchemaMatch | null> {
    // jarvis's allowlist is jarvis's: it applies where jarvis is. A graph
    // strut alone holds (a Ladybug file, a Neo4j with no `About` node)
    // allows only the edges its ontology holds.
    if (!this.source.holdsStrutTypes && EDGE_TYPES_ALLOWLIST.has(edge) && (await this.hiddenSets(tx)).jarvis) {
      return { source: sourceType, target: targetType, edge_type: edge, properties: {}, rule: {}, via: "allowlist" };
    }
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
        match = { source: row.source, target: row.target, edge_type: row.edge_type, properties: row.props, rule: edgeRuleOf(row.props), via };
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
   *
   * The edge TYPE has one rule (`EdgeRule`), held on each of its edge rules:
   * a new rule of a type takes the type's rule, and a `rule` given here
   * becomes the type's, on every rule of the type. Making a type
   * `cardinality: "one"` is refused, changing nothing, while a source node
   * holds two live edges of it.
   */
  async createEdgeSchema(sourceType: string, edge: string, targetType: string, rule?: EdgeRule, opts: { aliases?: string[] } = {}): Promise<{ created: boolean; ref_id: string; rule: EdgeRule }> {
    const edgeType = edge.toUpperCase().replace(/ /g, "_");
    if (!/^[A-Z][A-Z0-9_]*$/.test(edgeType)) throw new Error(`invalid edge type ${edge}`);
    const wanted = rule === undefined ? undefined : checkEdgeRule(edgeType, rule);
    const aliases = (opts.aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
    if (aliases.length && !this.source.setEdgeAliases) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", edgeType, "edge type aliases are kept on a Ladybug file only", "aliases");
    return this.engine.tx(async (tx) => {
      for (const t of [sourceType, targetType]) {
        if (t === "*") {
          await this.source.ensureWildcardSchema(randomUUID(), tx);
          continue;
        }
        const exists = await this.source.schemaRow(t, {}, tx);
        if (!exists || exists.type !== t) throw new Error(`schema ${t} does not exist`);
        // The root's "any node" edges are strut's own, seeded apart (`ensureEdgeSchema`).
        if (t === THING_TYPE) throw new GraphValidationError("UNKNOWN_TYPE", THING_TYPE, THING_REFUSED);
      }
      const held = edgeRuleOf((await this.source.edgeRule(edgeType, tx)) ?? {});
      const effective = wanted ?? held;
      const ref_id = randomUUID();
      const r = await this.source.ensureEdgeSchema(sourceType, edgeType, targetType, { ref_id, ...effective }, tx);
      if (wanted && JSON.stringify(wanted) !== JSON.stringify(held)) {
        if (wanted.cardinality === "one" && held.cardinality !== "one") await this.refuseCrowdedSlots(tx, edgeType);
        await this.source.setEdgeRule(edgeType, wanted, tx);
      }
      // The type's aliases, added to: a new rule of the type holds them too.
      if (this.source.setEdgeAliases && this.source.edgeAliases) {
        const had = (await this.source.edgeAliases(tx)).get(edgeType) ?? [];
        const all = [...had, ...aliases.filter((a) => !had.some((h) => h.toLowerCase() === a.toLowerCase()))];
        if (all.length && (r?.created || all.length > had.length)) await this.source.setEdgeAliases(edgeType, all, tx);
      }
      this.edges.clear();
      return { created: r?.created ?? false, ref_id: r?.ref_id ?? ref_id, rule: effective };
    });
  }

  /** Refuse when a source node holds more than one live `edge` edge (its
   *  rel table exists: `ensureEdgeSchema` ran first). */
  private async refuseCrowdedSlots(tx: GraphTx, edge: string): Promise<void> {
    const d = this.engine.dialect;
    const rows = await tx.run(
      `MATCH (s)-[r:\`${edge}\`]->(t) WHERE NOT ${d.isType("s", ["Schema"])} AND ${d.live("s")} AND ${d.live("t")}
       WITH s, count(r) AS c WHERE c > 1 RETURN count(s) AS n`,
    );
    const n = Number(rows[0]?.["n"] ?? 0);
    if (n > 0) throw new GraphValidationError("DUPLICATE_KEY", edge, `cardinality one allows one live ${edge} edge per source node, and ${n} source node(s) hold more: end the extra edges first`, "cardinality");
  }
}

const RULE_KEYS = ["temporal", "cardinality", "volatility"];

/** A caller's edge rule, checked: `temporal` (boolean), `cardinality`
 *  (`one` | `many`) and `volatility` (`VOLATILITIES`). */
export function checkEdgeRule(edge: string, rule: EdgeRule): EdgeRule {
  const raw = rule as Record<string, unknown>;
  for (const k of Object.keys(raw)) if (!RULE_KEYS.includes(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", edge, `an edge rule has ${RULE_KEYS.join(", ")} only`, k);
  if (raw["volatility"] !== undefined && !isVolatility(raw["volatility"])) throw new GraphValidationError("WRONG_TYPE", edge, `volatility is one of ${VOLATILITIES.join(", ")}`, "volatility");
  if (raw["temporal"] !== undefined && typeof raw["temporal"] !== "boolean") throw new GraphValidationError("WRONG_TYPE", edge, "temporal is true or false", "temporal");
  if (raw["cardinality"] !== undefined && raw["cardinality"] !== "one" && raw["cardinality"] !== "many") throw new GraphValidationError("WRONG_TYPE", edge, 'cardinality is "one" or "many"', "cardinality");
  return edgeRuleOf(raw);
}

/** A Strut registry schema as a `NodeSchema` (Thing's attributes inherited,
 *  `Domain_strut` unless hidden). */
export function fromStrut(strut: StrutSchema, hidden?: { domains: Set<string>; types: Set<string> }): NodeSchema {
  const hide = hidden ? hidden.types.has(strut.type) || hidden.types.has("Thing") || hidden.domains.has(STRUT_DOMAIN.toLowerCase()) : false;
  return {
    type: strut.type,
    parent: strut.parent,
    key_spec: strut.key_spec,
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
