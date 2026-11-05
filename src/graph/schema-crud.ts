/**
 * Node-schema registration — the write side of the `:Schema` meta-graph for
 * types that are NOT Strut's own, mirroring jarvis's `POST /v2/schema`
 * (`schema_service.create_schema` + `schema_crud.create_schema`):
 *
 *   - the parent must already be a Schema (default `Thing`); the type must
 *     not (`ERROR_SCHEMA_EXISTS`), except that a soft-deleted one is
 *     replaced, as jarvis's service does;
 *   - attributes are `name → type string` over jarvis's grammar
 *     (`string | boolean | int | float | complex | datetime | list`, `?` =
 *     optional); names are bare identifiers and may not reuse a core schema
 *     key or a generic node property;
 *   - `key_spec` is `-`-joined attribute tokens, stored as
 *     `<type lower>-<tokens>` (a Neo4j Schema node's `node_key`, a name
 *     still accepted as input); every token must be a declared attribute
 *     (`name` is inherited from Thing and always available);
 *   - `index` defaults to the key tokens and must name attributes;
 *   - `title_key` (a field, or a `{first} {last}` template) and
 *     `description_key` default to `name` and `description`;
 *   - the schema is written flat (core keys + attributes as top-level
 *     properties, like `schema-seed.ts`), linked `CHILD_OF` its parent, and
 *     given the per-type `(node_key, namespace)` uniqueness constraint +
 *     node_key index on Neo4j. The domain's search indexes are created when absent
 *     (`ensure_indexes_for_schema`).
 *
 * The type's rules (plans/graph-memory-plan.md step 2), enforced by the
 * writers: `role` (`NODE_ROLES`: an entity or concept needs a title, a
 * source is keyword-only by default), `embed`, `identifiers` (attributes
 * whose value names one node in a namespace) and `key` (the plan's name for
 * the key spec; `ref_id` makes every write a new node). An edge type's
 * `temporal` and `cardinality` are rules on its edge rules
 * (`SchemaResolver.createEdgeSchema`), never on a node type.
 *
 * `createNodeSchema` also EXTENDS an existing non-Strut schema — add-only,
 * the way `seedStrutDomain` reconciles: attributes the schema lacks are
 * added, nothing existing is changed, identity keys (`type`, `parent`,
 * `key_spec`, `index`) are never touched. That is what lets a workflow add
 * `verdict` to a jarvis-seeded `Claim` without editing the ontology by hand.
 * The rules are the exception: a `role`, `embed` or `identifiers` given is
 * set, and a `key` given re-keys every node of the type. Both check the
 * stored nodes first — two live nodes sharing an identifier value, or two
 * nodes the new key would give one key, refuse the change, and nothing is
 * written.
 *
 * On a Ladybug file names are one-to-one across the ontology
 * (plans/memory-in-workspace-graph.md decision 9): a type's name and its
 * `aliases` may not be another type's name or alias, case-blind, and a type
 * `managed_by` an owner (memory) is extended by that owner only. Neo4j
 * keeps jarvis's rules (`SchemaSource.typesNamed` is Ladybug's).
 *
 * Strut's own types are a closed in-code registry (`strut-schemas.ts`) and
 * are refused here. On Ladybug the same calls write `Schema` rows, and a
 * new attribute adds its column (`ladybug/ontology.ts`), refused when the
 * name is already a column of another type.
 */
import { randomUUID } from "node:crypto";
import type { EngineLike, GraphEngine, GraphKind } from "./engine.js";
import { asEngine } from "./neo4j-engine.js";
import { GraphValidationError, composeNodeKey, keyedByRef, refNodeKey } from "./node-writer.js";
import { NODE_ROLES, isNodeRole, type NodeSchema, type SchemaResolver } from "./schema-resolver.js";
import { SEARCH_TEXT_INDEX, schemaStatement } from "./schema-seed.js";
import { RESERVED_ATTRIBUTE_NAMES, SCHEMA_CORE_PROPERTIES, THING_TYPE, TYPE_OWNABLE_CORE, isGenericProperty, isStrutType } from "./strut-schemas.js";
import { titleFields } from "./title.js";

/**
 * `get_searchable_attributes_from_schema`: with an explicit index → index
 * fields + title_key + description_key; otherwise every string-typed
 * non-core attribute (plus index/title/description keys).
 */
export function searchableAttributesOf(schema: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const rawIndex = schema["index"];
  const indexFields = Array.isArray(rawIndex) ? rawIndex.map(String).filter(Boolean) : typeof rawIndex === "string" && rawIndex ? [rawIndex] : [];
  const add = (k: unknown) => {
    if (typeof k === "string" && k.trim()) out.add(k.trim());
  };
  if (indexFields.length) {
    for (const f of indexFields) add(f);
    add(schema["title_key"]);
    add(schema["description_key"]);
    return out;
  }
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_CORE_PROPERTIES.has(k)) continue;
    if (v === "string" || v === "?string") out.add(k);
  }
  out.add("node_key");
  add(schema["title_key"]);
  add(schema["description_key"]);
  return out;
}

export interface NodeSchemaInput {
  /** New type label, e.g. `Evidence`. */
  type: string;
  /** Parent type (must exist as a Schema). Default `Thing`. */
  parent?: string;
  /** Attribute name → jarvis type string (`?` prefix = optional). */
  attributes: Record<string, string>;
  /** `-`-joined attribute tokens that identify a node, e.g. `name` or
   *  `claim_text-speaker_name`. Default `name`. A `<type>-` prefix is
   *  accepted and not doubled. */
  key_spec?: string;
  /** jarvis's name for `key_spec`, accepted so saved workflows keep working. */
  node_key?: string;
  /** Searchable attributes; default = the key tokens. */
  index?: string[];
  /** The field a node's title comes from, or a `{first} {last}` template.
   *  Default `name`. */
  title_key?: string;
  /** Default `description`. */
  description_key?: string;
  /** Domain the type belongs to (→ `Domain_<domain>` label). Default `entity`. */
  domain?: string;
  type_description?: string;
  /** Other names the type answers to; each unique across the ontology. */
  aliases?: string[];
  /** The owner whose writes the type is reserved for (`memory`). */
  managed_by?: string;
  /** What its nodes are: entity | concept | claim | source | record
   *  (`NODE_ROLES`), inherited by its subtypes. */
  role?: string;
  /** Attributes whose value names one node of the type in a namespace: a
   *  second live node with the same value is refused. */
  identifiers?: string[];
  /** `false`: keyword search only, never an embedding. Default false for a
   *  `source`, else inherited (true). */
  embed?: boolean;
  /** The type's key: `-`-joined attribute tokens like `key_spec`, or
   *  `ref_id` (every write a new node). Unlike `key_spec`, on an existing
   *  type a different key re-keys its nodes. */
  key?: string;
}

/** A validated, normalized schema ready to write. */
export interface NodeSchemaPlan {
  type: string;
  parent: string;
  key_spec: string;
  tokens: string[];
  index: string[];
  domain: string;
  attributes: Record<string, string>;
  aliases: string[];
  /** The flat `:Schema` node properties (core keys + attributes). */
  flat: Record<string, unknown>;
}

export interface NodeSchemaResult {
  /** True when a new Schema node was written; false when an existing one
   *  was extended (or already had everything). */
  created: boolean;
  ref_id: string;
  type: string;
  parent: string;
  key_spec: string;
  /** Attributes added to an existing schema (always empty on create). */
  added: string[];
  /** Full effective attribute map after the write (inherited included). */
  attributes: Record<string, string>;
  /** The rules an existing schema had changed (`role`, `embed`,
   *  `identifiers`, `key_spec`); empty on create. */
  changed: string[];
  /** Nodes given a new key by a change of `key`. */
  rekeyed: number;
}

const TYPE_LABEL = /^[A-Za-z][A-Za-z0-9_]*$/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPE_GRAMMAR = /^\??(string|boolean|int|float|complex|datetime|list)$/;
const VECTOR_OPTIONS = "OPTIONS { indexConfig: { `vector.dimensions`: 384, `vector.similarity_function`: 'cosine' } }";

/** Why a type that declares `title` must take its title from it. */
const titleOwnRule = (titleKey: string) =>
  `a type that declares its own title attribute takes its title from it: title_key must be "title", not ${JSON.stringify(titleKey)} (name the attribute something else, e.g. job_title)`;

/** Validate one attribute declaration. Reserved = jarvis's protected schema
 *  keys + the generic node properties the writer stamps. Dual-use names
 *  (`description`, `source_link`, `name`) are allowed, as in jarvis — note
 *  the resolver treats a core-key attribute as optional regardless of its
 *  declared type (`schema-resolver.ts` `fromDb`), so a `description:
 *  "string"` is required only when it is a node_key token. */
function checkAttribute(type: string, name: string, value: unknown, kind?: GraphKind): void {
  if (!IDENT.test(name)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, "attribute name is not a bare identifier", name);
  if (RESERVED_ATTRIBUTE_NAMES.has(name) || isGenericProperty(name)) {
    throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, "attribute name is a reserved schema/system property", name);
  }
  // Neo4j keeps a type's own `created_at` / `created_by` beside the core
  // stamps; a Ladybug file has one of each, the core.
  if (kind === "ladybug" && TYPE_OWNABLE_CORE.has(name)) {
    const hint = name === "created_at" ? "name the type's date something else (e.g. published_at, started_at)" : "name the type's field something else (e.g. author)";
    throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, `${name} is a core attribute on this graph, set by the writer — ${hint}`, name);
  }
  if (typeof value !== "string" || !TYPE_GRAMMAR.test(value)) {
    throw new GraphValidationError("WRONG_TYPE", type, `attribute type must be one of string|boolean|int|float|complex|datetime|list (optionally ?-prefixed), got ${JSON.stringify(value)}`, name);
  }
}

/**
 * Pure validation + normalization of a schema input (no DB). Throws a
 * `GraphValidationError` on the first problem. Existence checks (parent,
 * duplicate type) happen in `createNodeSchema`. `known` is the attributes
 * the type already has or inherits (name → type string), which its key,
 * index, identifiers and title may name besides its own.
 */
export function planNodeSchema(input: NodeSchemaInput, kind?: GraphKind, known: Readonly<Record<string, string>> = {}): NodeSchemaPlan {
  const type = String(input.type ?? "").trim();
  if (!TYPE_LABEL.test(type)) throw new GraphValidationError("UNKNOWN_TYPE", type || "?", "type must match ^[A-Za-z][A-Za-z0-9_]*$");
  if (type === "*" || type === THING_TYPE) throw new GraphValidationError("UNKNOWN_TYPE", type, "cannot create the root or wildcard schema");
  if (isStrutType(type)) throw new GraphValidationError("UNKNOWN_TYPE", type, "Strut's own types are a closed in-code registry");
  const parent = String(input.parent ?? THING_TYPE).trim() || THING_TYPE;
  if (!TYPE_LABEL.test(parent)) throw new GraphValidationError("UNKNOWN_TYPE", type, `parent must match ^[A-Za-z][A-Za-z0-9_]*$, got ${JSON.stringify(input.parent)}`, "parent");

  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.attributes ?? {})) {
    checkAttribute(type, k, v, kind);
    attributes[k] = v as string;
  }
  const declared = new Set(["name", ...Object.keys(known), ...Object.keys(attributes)]);

  const prefix = `${type.toLowerCase()}-`;
  let rawKey = String(input.key ?? input.key_spec ?? input.node_key ?? "name").trim();
  if (rawKey.toLowerCase().startsWith(prefix)) rawKey = rawKey.slice(prefix.length);
  // `ref_id`: no key of its own — every create is a new node (`keyedByRef`).
  const byRef = rawKey === REF_KEY;
  const tokens = byRef ? [] : rawKey.split("-").map((t) => t.trim()).filter(Boolean);
  if (!byRef && tokens.length === 0) throw new GraphValidationError("MISSING_REQUIRED", type, "key_spec needs at least one attribute token", "key_spec");
  for (const t of tokens) {
    if (!declared.has(t)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, `key_spec token ${t} is not a declared attribute`, "key_spec");
  }
  const key_spec = byRef ? REF_KEY : `${prefix}${tokens.join("-")}`;

  const index = (input.index ?? (byRef ? ["name"] : tokens)).map((f) => String(f).trim()).filter(Boolean);
  for (const f of index) {
    if (!declared.has(f)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, `index field ${f} is not a declared attribute`, "index");
  }
  // A type with its own `title` field keeps the node's title in it (the
  // core `title` is that one property or column), so it is its title_key.
  const titleKey = input.title_key || ("title" in attributes ? "title" : "name");
  if ("title" in attributes && titleKey !== "title") throw new GraphValidationError("WRONG_TYPE", type, titleOwnRule(titleKey), "title_key");
  for (const [key, val] of [["title_key", input.title_key], ["description_key", input.description_key]] as const) {
    if (val === undefined) continue;
    for (const f of key === "title_key" ? titleFields(val) : [val]) {
      if (!declared.has(f)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, `${key} ${val}: ${f} is not a declared attribute`, key);
    }
  }
  const domain = String(input.domain ?? "entity").trim() || "entity";
  if (!IDENT.test(domain)) throw new GraphValidationError("WRONG_TYPE", type, "domain must be a bare identifier", "domain");
  // Case-blind, as a type name is: the first spelling of each is kept.
  const aliases: string[] = [];
  for (const a of (input.aliases ?? []).map((x) => String(x).trim())) {
    const lower = a.toLowerCase();
    if (a && lower !== type.toLowerCase() && !aliases.some((x) => x.toLowerCase() === lower)) aliases.push(a);
  }
  for (const a of aliases) if (!TYPE_LABEL.test(a)) throw new GraphValidationError("UNKNOWN_TYPE", type, `alias must match ^[A-Za-z][A-Za-z0-9_]*$, got ${JSON.stringify(a)}`, "aliases");
  const managed_by = input.managed_by?.trim() || undefined;
  const rules = planRules(type, input, (k) => attributes[k] ?? known[k] ?? (k === "name" ? "string" : undefined));

  const flat: Record<string, unknown> = {
    type,
    parent,
    key_spec,
    index,
    domain,
    title_key: titleKey,
    description_key: input.description_key || "description",
    ...(input.type_description ? { type_description: input.type_description } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(managed_by ? { managed_by } : {}),
    ...rules,
    ...attributes,
  };
  return { type, parent, key_spec, tokens, index, domain, attributes, aliases, flat };
}

/** A type keyed by its nodes' ref_ids (`keyedByRef`, node-writer.ts). */
const REF_KEY = "ref_id";

/** The node rules an input sets, checked: a known role, a boolean embed,
 *  identifiers that are scalar attributes of the type. */
function planRules(type: string, input: NodeSchemaInput, typeOf: (attr: string) => string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.role !== undefined) {
    if (!isNodeRole(input.role)) throw new GraphValidationError("WRONG_TYPE", type, `role is one of ${NODE_ROLES.join(", ")}, got ${JSON.stringify(input.role)}`, "role");
    out["role"] = input.role;
  }
  if (input.embed !== undefined) {
    if (typeof input.embed !== "boolean") throw new GraphValidationError("WRONG_TYPE", type, "embed is true or false", "embed");
    out["embed"] = input.embed;
  }
  if (input.identifiers !== undefined) {
    if (!Array.isArray(input.identifiers)) throw new GraphValidationError("WRONG_TYPE", type, "identifiers is a list of attribute names", "identifiers");
    const ids = [...new Set(input.identifiers.map((x) => String(x).trim()).filter(Boolean))];
    for (const id of ids) {
      const t = typeOf(id);
      if (!t) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, `identifier ${id} is not a declared attribute`, "identifiers");
      if (/^\??(list|complex)$/.test(t)) throw new GraphValidationError("WRONG_TYPE", type, `identifier ${id} is a ${t}: an identifier is one value`, "identifiers");
    }
    out["identifiers"] = ids;
  }
  return out;
}

/**
 * Create the schema (or add-only extend an existing non-Strut one). The
 * resolver's caches are invalidated so the next write sees the new type.
 */
export async function createNodeSchema(e: EngineLike, resolver: SchemaResolver, input: NodeSchemaInput): Promise<NodeSchemaResult> {
  const engine = asEngine(e);
  const src = engine.schemaSource;
  // Adopt the live casing of an existing type / parent (jarvis
  // `resolve_graph_label` / `resolve_canonical_node_type`).
  const existingType = typeof input.type === "string" && input.type.trim() ? await resolver.resolveType(input.type) : null;
  const parent = (await resolver.resolveType(String(input.parent ?? THING_TYPE).trim() || THING_TYPE)) ?? null;
  // What the type has or inherits already, which its key and rules may name.
  const held = existingType && !isStrutType(existingType) ? await resolver.schema(existingType) : parent && !isStrutType(parent) ? await resolver.schema(parent) : null;
  const plan = planNodeSchema(input, engine.kind, held?.attributes ?? {});
  const managedBy = typeof plan.flat["managed_by"] === "string" ? (plan.flat["managed_by"] as string) : undefined;

  if (!parent) throw new GraphValidationError("UNKNOWN_TYPE", plan.type, `parent schema ${plan.parent} does not exist`, "parent");
  if (isStrutType(parent)) throw new GraphValidationError("UNKNOWN_TYPE", plan.type, "Strut's own types cannot be extended (closed registry)", "parent");

  const result = await engine.tx(async (tx) => {
    // One name, one type, one owner (decision 9), where the store keeps it.
    for (const held of (await src.typesNamed?.([plan.type, ...plan.aliases], tx)) ?? []) {
      const same = held.type.toLowerCase() === plan.type.toLowerCase();
      if (same && held.managed_by !== managedBy) {
        throw new GraphValidationError("DUPLICATE_KEY", plan.type, `${held.type} is owned by ${held.managed_by ?? "the workspace"}; it cannot be declared or extended here`);
      }
      if (same) continue;
      const clash = [plan.type, ...plan.aliases].find((n) => n.toLowerCase() === held.type.toLowerCase() || held.aliases.some((a) => a.toLowerCase() === n.toLowerCase()))!;
      const what = clash.toLowerCase() === held.type.toLowerCase() ? "the type" : "an alias of";
      throw new GraphValidationError("DUPLICATE_KEY", plan.type, `${clash} is already ${what} ${held.type}${held.managed_by ? ` (owned by ${held.managed_by})` : ""}: a name or alias names one type`, clash === plan.type ? undefined : "aliases");
    }
    if (existingType) {
      if (isStrutType(existingType)) throw new GraphValidationError("UNKNOWN_TYPE", existingType, "Strut's own types are a closed in-code registry");
      const live = await src.schemaRow(existingType, { live: true }, tx);
      if (live && live.type === existingType) {
        // Extend: add only attributes the schema lacks.
        const have = new Set(Object.keys(live.props));
        const missing: Record<string, string> = {};
        for (const [k, v] of Object.entries(plan.attributes)) if (!have.has(k)) missing[k] = v;
        const liveTitleKey = typeof live.props["title_key"] === "string" && live.props["title_key"] ? String(live.props["title_key"]) : "name";
        if ("title" in missing && liveTitleKey !== "title") throw new GraphValidationError("WRONG_TYPE", existingType, titleOwnRule(liveTitleKey), "title");
        // The rules given that differ from the stored ones, and a new key.
        const rules: Record<string, unknown> = {};
        for (const k of RULE_KEYS) if (k in plan.flat && JSON.stringify(plan.flat[k]) !== JSON.stringify(live.props[k] ?? null)) rules[k] = plan.flat[k];
        const newKey = input.key !== undefined && plan.key_spec !== live.props["key_spec"] ? plan.key_spec : undefined;
        // Every check before the first write (on Ladybug a new attribute is
        // DDL, and a transaction that ran DDL must not roll back).
        const schema = held!;
        const ids = Array.isArray(rules["identifiers"]) ? (rules["identifiers"] as string[]) : [];
        const nodes = ids.length || newKey ? await engine.nodeEngine.ofType(tx, existingType) : [];
        if (ids.length) refuseSharedIdentifiers(engine, schema, ids, nodes);
        const rekeys = newKey ? planRekey(engine, { ...schema, key_spec: newKey }, nodes) : [];
        if (Object.keys(missing).length) await src.extendSchema(existingType, missing, tx);
        if (newKey) rules["key_spec"] = newKey;
        if (Object.keys(rules).length) await src.extendSchema(existingType, rules, tx);
        for (const r of rekeys) await engine.nodeEngine.update(tx, schema, r.ref_id, { key: r.key }, []);
        return { created: false, ref_id: String(live.ref_id), type: existingType, added: Object.keys(missing).sort(), changed: Object.keys(rules).sort(), rekeyed: rekeys.length };
      }
      // A soft-deleted schema is replaced (jarvis: delete_schema_permanently, then create).
      await src.deleteSchema(existingType, tx);
    }
    const ref_id = randomUUID();
    await src.createSchema({ ...plan.flat, parent, ref_id }, tx);
    await src.ensureChildOf(plan.type, parent, randomUUID(), tx);
    return { created: true, ref_id, type: plan.type, added: [] as string[], changed: [] as string[], rekeyed: 0 };
  });

  const bolt = engine.bolt;
  if (result.created && bolt) {
    // Neo4j DDL cannot run inside the write transaction. Same objects as
    // the seeders; a Ladybug file has its indexes from the handle's open.
    const t = result.type;
    await schemaStatement(bolt, `CREATE CONSTRAINT ${`unique_${t.toLowerCase()}_node_key`} IF NOT EXISTS FOR (n:\`${t}\`) REQUIRE (n.node_key, n.namespace) IS UNIQUE`);
    await schemaStatement(bolt, `CREATE INDEX IF NOT EXISTS FOR (n:\`${t}\`) ON (n.node_key)`);
    const d = plan.domain.toLowerCase();
    // A graph with the search-text index keyword-searches every type through
    // it; only a graph jarvis shares keeps an index per domain, as jarvis does.
    const searchText = await bolt.run(`SHOW INDEXES YIELD name WHERE name = $name RETURN count(*) AS c`, { name: SEARCH_TEXT_INDEX });
    if (Number(searchText[0]?.["c"] ?? 0) === 0) {
      const props = [...new Set([...searchableAttributesOf(plan.flat), "node_key"])].sort().map((p) => `n.\`${p}\``).join(", ");
      await schemaStatement(
        bolt,
        `CREATE FULLTEXT INDEX \`domain_${d}_attribute_index_v2\` IF NOT EXISTS FOR (n:\`Domain_${d}\`) ON EACH [${props}]
         OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'english' } }`,
      );
    }
    await schemaStatement(bolt, `CREATE VECTOR INDEX \`domain_${d}_vector_index\` IF NOT EXISTS FOR (n:\`Domain_${d}\`) ON n.text_embeddings ${VECTOR_OPTIONS}`);
  }

  resolver.invalidate();
  const schema = await resolver.schema(result.type);
  return {
    created: result.created,
    ref_id: result.ref_id,
    type: result.type,
    parent: schema?.parent ?? parent,
    key_spec: schema?.key_spec ?? plan.key_spec,
    added: result.added,
    attributes: schema?.attributes ?? plan.attributes,
    changed: result.changed,
    rekeyed: result.rekeyed,
  };
}

/** The rules an extend may change (`key_spec` through `key`, `planRekey`). */
const RULE_KEYS = ["role", "embed", "identifiers"] as const;

/** Refuse identifiers two live nodes of the type share in one namespace. */
function refuseSharedIdentifiers(engine: GraphEngine, schema: NodeSchema, ids: string[], nodes: Array<{ ref_id: string; props: Record<string, unknown> }>): void {
  for (const id of ids) {
    const seen = new Map<string, string>();
    for (const n of nodes) {
      const v = n.props[id];
      if (n.props["deleted_at"] != null || v === null || v === undefined || v === "") continue;
      const slot = `${String(n.props["namespace"] ?? engine.namespace)}\u0000${String(v)}`;
      const other = seen.get(slot);
      if (other) throw new GraphValidationError("DUPLICATE_KEY", schema.type, `${other} and ${n.ref_id} share ${id} ${JSON.stringify(v)}: an identifier names one node`, "identifiers");
      seen.set(slot, n.ref_id);
    }
  }
}

/** Every node's key under the type's new key spec, and the ones that
 *  change; refused when a node lacks a key attribute or two nodes in one
 *  namespace would share a key. Pure. */
function planRekey(engine: GraphEngine, schema: NodeSchema, nodes: Array<{ ref_id: string; props: Record<string, unknown> }>): Array<{ ref_id: string; key: string }> {
  const seen = new Map<string, string>();
  const out: Array<{ ref_id: string; key: string }> = [];
  for (const n of nodes) {
    let key: string;
    try {
      key = keyedByRef(schema) ? refNodeKey(schema.type, n.ref_id) : composeNodeKey(schema, n.props);
    } catch (err) {
      if (!(err instanceof GraphValidationError)) throw err;
      throw new GraphValidationError("MISSING_REQUIRED", schema.type, `node ${n.ref_id} has no ${err.attribute ?? "key attribute"}, so it has no key under ${schema.key_spec}`, "key");
    }
    const slot = `${String(n.props["namespace"] ?? engine.namespace)}\u0000${key}`;
    const other = seen.get(slot);
    if (other) throw new GraphValidationError("DUPLICATE_KEY", schema.type, `${other} and ${n.ref_id} would share the key ${key}: the type cannot take ${schema.key_spec}`, "key");
    seen.set(slot, n.ref_id);
    if (key !== n.props["key"]) out.push({ ref_id: n.ref_id, key });
  }
  return out;
}
