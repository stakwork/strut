/**
 * jarvis-dialect node writes (`plans/jarvis-graph-compat.md` §1, §2, §6).
 *
 * Every node strut puts in the graph goes through `NodeWriter`. The writer
 * validates BEFORE building any Cypher (§6 — nothing invalid or unexpected
 * reaches the graph through strut), composes the node's `key` exactly like
 * jarvis's `node_key` (`schema_validation.py:350-399`), builds the
 * `search_text` (jarvis's `Data_Bank`)
 * (`schema_node_helper.py:141-234`, including jarvis's kitchen-sink fallback
 * for schemas without a usable explicit index), and MERGEs with jarvis's
 * label set and generic stamps (`schema_node_helper.py:238-268`).
 *
 * The core attributes go under their shared names — `key`, `search_text`,
 * `created_at`, `title` — on both engines; Neo4j stores the first three
 * under jarvis's (`node_key`, `Data_Bank`, `date_added_to_graph`), mapped in
 * `neo4j-engine.ts`. `created_at` is when the row was created, epoch ms, the
 * writer's alone. `title` is filled on every write from the schema's
 * `title_key` (`composeTitle`), as `search_text` is from its `index`.
 *
 * Types: Strut's own come from the in-code registry; any other type
 * (Document, EvalSet, Concept, …) is resolved from the live `:Schema`
 * meta-graph by `SchemaResolver` — the same source jarvis validates against
 * — so the writer is a drop-in for jarvis on jarvis-typed data too.
 *
 * Two modes:
 *   - `create`: no-op on an existing node (returns its ref_id) — except a
 *     soft-deleted node, which is restored in place
 *     (`schema_node_helper.py:620-657`). Delete and mute are independent:
 *     `is_muted` is left as it is, so a muted node stays hidden. A restore brings back the node,
 *     not its edges: a delete removed those for good (`deletion.ts`).
 *   - `upsert`: jarvis `reprocess` semantics — SET everything except the
 *     preserved identity (`ref_id`, `key`, `namespace`, `created_at`).
 *     Unlike jarvis's reprocess, `search_text` and
 *     the embeddings ARE rebuilt from the new payload, so the resulting
 *     state equals what a fresh create with that payload would produce.
 *
 * `updated_at` is the writer's stamp, as in jarvis (migration 136): epoch ms,
 * equal to `created_at` on create, set again on a restore and on an
 * upsert or update that changes an attribute. A caller's value is dropped.
 *
 * Embeddings are computed in-process before the write (no queue, no
 * pending marker — jarvis's "pending" state is simply `text_embeddings IS
 * NULL`). Without an `Embedder` the vectors stay NULL and the boot sweep
 * (`embeddings.ts`) heals them.
 *
 * The statements live behind `NodeEngine` (`engine.ts`): `neo4j-engine.ts`
 * holds the MERGE template, `ladybug/engine.ts` the one-table form. This
 * file validates, composes and decides; it issues no Cypher.
 */
import { createHash, randomUUID } from "node:crypto";
import { int } from "./bolt.js";
import { EVIDENCE_TYPE } from "./claims.js";
import type { EngineLike, GraphEngine, GraphTx, PreparedNode, SoftDeleteOptions, SoftDeleteResult, WriteMode, WriteOutcome } from "./engine.js";
import { sameStored } from "./engine.js";
import { asEngine } from "./neo4j-engine.js";
import { SchemaResolver, fromStrut, type NodeSchema } from "./schema-resolver.js";
import { nodeTitleFor } from "./title.js";
import { OWN_CREATED_BY, STRUT_DOMAIN_LABEL, isGenericProperty, embeddingColumn, getStrutSchema, vectorStem } from "./strut-schemas.js";

export type { PreparedNode, WriteMode, WriteOutcome };

// ── Errors ──────────────────────────────────────────────────────────────────

export type GraphValidationCode =
  | "UNKNOWN_TYPE"
  | "MISSING_REQUIRED"
  | "UNKNOWN_ATTRIBUTE"
  | "WRONG_TYPE"
  | "INVALID_LIST"
  | "INVALID_DATETIME"
  | "EMPTY_NODE_KEY_TOKEN"
  | "NOT_FOUND"
  | "DUPLICATE_KEY";

export class GraphValidationError extends Error {
  readonly code: GraphValidationCode;
  readonly type: string;
  readonly attribute?: string;
  constructor(code: GraphValidationCode, type: string, message: string, attribute?: string) {
    super(`${type}${attribute ? `.${attribute}` : ""}: ${message}`);
    this.name = "GraphValidationError";
    this.code = code;
    this.type = type;
    this.attribute = attribute;
  }
}

// ── Validation + normalization (§6) ─────────────────────────────────────────

export interface ValidatedNode {
  schema: NodeSchema;
  /** Attribute values as JS primitives (datetime → epoch seconds), with
   *  null/undefined and empty strings dropped. Used for key and
   *  search_text composition. */
  values: Record<string, unknown>;
  /** The same values as Neo4j parameter values (ints wrapped) — what a
   *  caller feeding bolt directly needs; the writer hands the engine
   *  `values` and lets it wrap. */
  params: Record<string, unknown>;
}

const isOptionalType = (t: string) => t.startsWith("?");
const baseOf = (t: string) => (isOptionalType(t) ? t.slice(1) : t);

/**
 * The write-time gate. Throws `GraphValidationError` on the first violation
 * and writes nothing. Stricter than jarvis in the safe direction: anything
 * accepted here also passes jarvis's validators. Pass a Strut type name or
 * a resolved `NodeSchema` (from `SchemaResolver`) for any type.
 */
export function validateNode(typeOrSchema: string | NodeSchema, data: Record<string, unknown>): ValidatedNode {
  let schema: NodeSchema;
  if (typeof typeOrSchema === "string") {
    const strut = getStrutSchema(typeOrSchema);
    if (!strut) throw new GraphValidationError("UNKNOWN_TYPE", typeOrSchema, "not a registered Strut type (resolve other types via SchemaResolver)");
    schema = fromStrut(strut);
  } else schema = typeOrSchema;
  const type = schema.type;
  const attrs = schema.attributes;

  // 3. Unknown attributes rejected — this is what makes "unexpected" nodes
  //    impossible, not just invalid ones. Generic/system props included.
  for (const key of Object.keys(data)) {
    if (!attrs[key] || isGenericProperty(key)) {
      throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, "attribute is not declared on the schema", key);
    }
  }

  const values: Record<string, unknown> = {};
  const params: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(attrs)) {
    const raw = data[name];
    const base = baseOf(t);
    const present = raw !== null && raw !== undefined && !(typeof raw === "string" && raw.length === 0);
    if (!present) {
      // 2. Required attributes present and non-null. jarvis treats an empty
      //    string as "present" then silently never writes it; we reject it.
      if (!isOptionalType(t)) throw new GraphValidationError("MISSING_REQUIRED", type, `required ${base} attribute is missing`, name);
      continue;
    }
    // 4. Type checks per the grammar.
    const norm = normalizeValue(type, name, base, raw);
    values[name] = norm.value;
    params[name] = norm.param;
  }

  // 5. key integrity: every token after the type must be present
  //    (jarvis: "Attribute referenced in node_key not found in node data")
  //    and must not sanitize to nothing.
  for (const field of schema.key_spec.split("-").slice(1)) {
    const lower = field.toLowerCase();
    const hit = Object.keys(values).find((k) => k.toLowerCase() === lower);
    if (!hit) throw new GraphValidationError("MISSING_REQUIRED", type, "attribute referenced in the key is missing", field);
    if (keyToken(schema, values[hit]).length === 0) {
      throw new GraphValidationError("EMPTY_NODE_KEY_TOKEN", type, "key attribute sanitizes to an empty token", field);
    }
  }

  // Keep the caller's key order (jarvis iterates the request payload, and
  // the kitchen-sink search_text fallback depends on that order).
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(data)) if (k in values) ordered[k] = values[k];
  return { schema, values: ordered, params };
}

function normalizeValue(type: string, name: string, base: string, raw: unknown): { value: unknown; param: unknown } {
  switch (base) {
    case "string":
      if (typeof raw !== "string") throw wrong(type, name, "string", raw);
      return { value: raw, param: raw };
    case "boolean":
      if (typeof raw !== "boolean") throw wrong(type, name, "boolean", raw);
      return { value: raw, param: raw };
    case "int":
      // Booleans are not ints (Python quirk we do not replicate).
      if (typeof raw !== "number" || !Number.isInteger(raw)) throw wrong(type, name, "int", raw);
      return { value: raw, param: int(raw) };
    case "float":
      // int-where-float is accepted (as in jarvis) and written as a FLOAT.
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw wrong(type, name, "float", raw);
      return { value: raw, param: raw };
    case "datetime": {
      const secs = toEpochSeconds(raw);
      if (secs === null) throw new GraphValidationError("INVALID_DATETIME", type, "expected ISO-8601 string or epoch number", name);
      return { value: secs, param: int(secs) };
    }
    case "list": {
      if (!Array.isArray(raw)) throw wrong(type, name, "list", raw);
      // Neo4j lists must be homogeneous primitives.
      const kinds = new Set(raw.map((x) => typeof x));
      if (kinds.size > 1 || (kinds.size === 1 && !["string", "number", "boolean"].includes([...kinds][0]!))) {
        throw new GraphValidationError("INVALID_LIST", type, "list elements must be all strings, all numbers, or all booleans", name);
      }
      return { value: raw, param: raw };
    }
    default:
      // `complex` (jarvis grammar, never used by Strut): passthrough.
      return { value: raw, param: raw };
  }
}

function wrong(type: string, name: string, expected: string, raw: unknown): GraphValidationError {
  return new GraphValidationError("WRONG_TYPE", type, `expected ${expected}, got ${describe(raw)}`, name);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * jarvis `TimeFormatter._convert_to_unix_timestamp`: ISO string (Z accepted)
 * or epoch number; numbers above 10^12 are milliseconds. Always epoch
 * SECONDS as an int. Returns null when unparseable.
 */
export function toEpochSeconds(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.trunc(v > 1e12 ? v / 1000 : v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s)) return toEpochSeconds(Number(s));
    const ms = Date.parse(s.replace(/Z$/, "+00:00"));
    if (Number.isNaN(ms)) return null;
    return Math.trunc(ms / 1000);
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return Math.trunc(v.getTime() / 1000);
  return null;
}

// ── key (§1: jarvis's node_key) ─────────────────────────────────────────────

export const MAX_NODE_KEY_LENGTH = 200;
export const NODE_KEY_HASH_LENGTH = 32;

/** A schema keyed by `ref_id` (`key_spec: "ref_id"`): every create is a new
 *  node, never a match on its attributes, and never a deleted one brought
 *  back — two people may share a name. */
export const keyedByRef = (schema: Pick<NodeSchema, "key_spec">): boolean => schema.key_spec === "ref_id";

/** The key of a node keyed by `ref_id`: the type token, then the ref_id. */
export function refNodeKey(type: string, ref_id: string): string {
  return `${type.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, "")}-${ref_id}`;
}

/** `String(v).trim()` → drop spaces → lowercase → strip `[^a-zA-Z0-9\s]`. */
export function sanitizeKeyValue(v: unknown): string {
  return String(v)
    .trim()
    .replace(/ /g, "")
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, "");
}

/**
 * One node_key token: jarvis's sanitizer, unless the schema is `exact_key`
 * (strut's workspace types — strut-schemas.ts), then the hex of the exact
 * value, so `pod/test` and `pod_test` never share a key. Hex is
 * alphanumeric, so every rule below still holds; `Buffer.from(token, "hex")`
 * gives the value back.
 */
function keyToken(schema: { exact_key?: boolean }, v: unknown): string {
  return schema.exact_key ? Buffer.from(String(v), "utf8").toString("hex") : sanitizeKeyValue(v);
}

/**
 * `sanitize_node_key` + `_compose_node_key`, verbatim (the token encoding
 * aside — `keyToken`). Property lookup is case-insensitive; a missing
 * property is an error. If the composed key exceeds 200 chars, the value
 * portion collapses to a 32-hex sha256 prefix.
 */
export function composeNodeKey(schema: { type: string; key_spec: string; exact_key?: boolean }, values: Record<string, unknown>): string {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  const parts: string[] = [];
  const tokens = schema.key_spec.split("-");
  tokens.forEach((tok, i) => {
    if (i === 0) {
      parts.push(schema.type.toLowerCase().replace(/[^a-zA-Z0-9\s]/g, ""));
      return;
    }
    if (!lower.has(tok.toLowerCase())) throw new GraphValidationError("MISSING_REQUIRED", schema.type, "key property missing", tok);
    parts.push(keyToken(schema, lower.get(tok.toLowerCase())));
  });
  const composed = parts.join("-");
  if (composed.length <= MAX_NODE_KEY_LENGTH || parts.length < 2) return composed;
  const digest = createHash("sha256").update(parts.slice(1).join("-"), "utf8").digest("hex").slice(0, NODE_KEY_HASH_LENGTH);
  return `${parts[0]}-${digest}`;
}

// ── search_text (§2: jarvis's Data_Bank) ────────────────────────────────────

/** jarvis `DATA_BANK_EXCLUDED_FIELDS` — never part of kitchen-sink search
 *  text — plus the shared names of its core keys. */
export const DATA_BANK_EXCLUDED_FIELDS = new Set([
  "ref_id", "node_key", "date_added_to_graph", "namespace", "Data_Bank", "text_embeddings", "_search_fields_used",
  "key", "search_text",
  "id", "uuid", "tweet_id", "bounty_id", "episode_id", "video_id", "podcast_id", "clip_id", "message_id", "project_id",
  "org_uuid", "workspace_uuid", "phase_uuid", "owner_id", "pub_key", "pubkey",
  "created", "updated", "date", "timestamp", "created_at", "updated_at",
  "image_url", "profile_picture", "source_link", "link", "ticket_url", "media_url", "report_url",
  "old_value", "new_value",
  "contested", "boost", "num_boost", "price", "amount", "commitment_fee", "assigned_hours", "paid", "show", "completed",
  "verified", "impression_count", "sentiment_score", "relevancy_score",
  "start", "end", "line", "column", "operand", "output_data_type",
  "status", "type", "parent", "shape", "icon", "primary_color", "secondary_color", "phase_priority", "number",
]);

/** jarvis priority order for the kitchen-sink fallback. */
const PRIORITY_FIELDS = [
  "name", "title", "episode_title", "show_title", "description", "graph_description", "type_description", "text",
  "content", "body", "code", "docs", "summary", "one_sentence_summary", "deliverables", "github_description",
];

const nonBlank = (v: unknown) => v !== null && v !== undefined && String(v).trim().length > 0;

/** A node's other names (`resolve`, `merge`): an ordinary field most named types declare. */
export const ALT_NAMES = "alt_names";

/**
 * `get_search_fields_for_node`: the schema's explicit `index` fields (in
 * declared order) that are present and non-blank, then any of `also` not
 * among them (a Ladybug node's `alt_names`: its other names are always
 * searched, whatever its type's `index`); when the schema has no real index
 * (`["node_key"]`) or none of its index fields are usable, fall through to
 * jarvis's priority list + every other non-excluded property.
 */
export function searchFieldsFor(schema: Pick<NodeSchema, "index">, values: Record<string, unknown>, also: readonly string[] = []): string[] {
  if (!(schema.index.length === 1 && schema.index[0] === "node_key")) {
    const focused = schema.index.filter((f) => nonBlank(values[f]));
    if (focused.length) return [...focused, ...also.filter((f) => !focused.includes(f) && nonBlank(values[f]))];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of PRIORITY_FIELDS) {
    if (f in values && !DATA_BANK_EXCLUDED_FIELDS.has(f) && nonBlank(values[f])) {
      out.push(f);
      seen.add(f);
    }
  }
  for (const [f, v] of Object.entries(values)) {
    if (DATA_BANK_EXCLUDED_FIELDS.has(f) || seen.has(f) || !nonBlank(v)) continue;
    out.push(f);
    seen.add(f);
  }
  return out;
}

/** `build_search_text`: values of the chosen fields, trimmed, joined with
 *  "\n" — no field-name prefixes. Null when nothing qualifies. The ONE
 *  composition: the writer, the pass (`embeddings.ts`) and jarvis's
 *  `build_search_text` all produce this text, which is why "stored
 *  search text ≠ composed text" is the pass's stale test. */
export function buildSearchText(schema: Pick<NodeSchema, "index">, values: Record<string, unknown>, also: readonly string[] = []): { text: string | null; fields: string[] } {
  const fields = searchFieldsFor(schema, values, also);
  const parts = fields.map((f) => String(values[f]).trim()).filter(Boolean);
  return { text: parts.length ? parts.join("\n") : null, fields };
}

/** jarvis `render_schema`: `"Input:\n{text}"` for `input_schema`, etc. */
export function renderVectorField(prop: string, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const stem = vectorStem(prop);
  const cleaned = stem.replace(/_/g, " ").trim();
  const label = cleaned ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : "Text";
  return `${label}:\n${t}`;
}

// ── Writer ──────────────────────────────────────────────────────────────────

export interface Embedder {
  /** One 384-float vector per input text, same order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface NodeInput {
  /** Node type — a Strut type (exact) or any jarvis type (resolved
   *  case-insensitively against the live schema). */
  type: string;
  data: Record<string, unknown>;
  /** Who is writing it: the host's name for the caller's actor (a run's
   *  `actor`, a chat's or job's creator). The writer stamps it as the core
   *  `created_by` on create, never from `data`. Ladybug stores it on every
   *  node; Neo4j only on the types that held their own (`OWN_CREATED_BY`). */
  created_by?: string;
}

export interface NodeWriteResult {
  ref_id: string;
  key: string;
  /** @deprecated `key` under its old name, kept for a release so callers
   *  typed against it (stakgraph's `concept/create`) keep working. */
  node_key: string;
  /** Canonical type label the node was written under. */
  node_type: string;
  outcome: WriteOutcome;
}

export interface NodeWriterOptions {
  embedder?: Embedder;
  /** Shared resolver (one per backend); a private one is created otherwise. */
  resolver?: SchemaResolver;
  /** The writer's clock for `created_at` and `updated_at` (epoch ms). */
  now?: () => number;
}

/** The system stamp: epoch ms, the format of `created_at`. Owned by
 *  the writer on every node type, declared or not; never a caller's. */
export const UPDATED_AT = "updated_at";

/** What every write may carry: the caller's transaction. */
export interface WriterCallOptions {
  /** Run on the caller's write transaction (an engine's `tx()` does not
   *  nest), so the write lands with the caller's other statements. */
  tx?: GraphTx;
}

export interface WriteOptions extends WriterCallOptions {
  /** Override the backend's default namespace for this write. Must already
   *  be registered when it is not `default` (callers check via
   *  `GraphReader.resolveNamespace`). */
  namespace?: string;
}

export interface NodeUpdate {
  /** Properties to set/overwrite (validated against the schema after
   *  merging over the node's current attributes). */
  set?: Record<string, unknown>;
  /** Attribute names to remove. Required attributes cannot be removed. */
  remove?: string[];
}

export interface NodeUpdateResult {
  ref_id: string;
  key: string;
  /** True when the update changed the key (identity attrs edited). */
  rekeyed: boolean;
}

/** Identity props never touched after create. `date_added_to_graph` is
 *  the core stamp of a type that declares its own `created_at` (`stampKey`). */
const PRESERVED = new Set(["ref_id", "key", "namespace", "created_at", "date_added_to_graph", "created_by"]);

/** Where the writer puts a node's core creation stamp: `created_at`, or,
 *  on a type that declares its own `created_at` (jarvis's Concept, Check,
 *  … on Neo4j: TYPE_OWNABLE_CORE), jarvis's `date_added_to_graph`, the
 *  name Neo4j stores the stamp under anyway. */
export const stampKey = (schema: Pick<NodeSchema, "attributes">): string => ("created_at" in schema.attributes ? "date_added_to_graph" : "created_at");

export class NodeWriter {
  readonly resolver: SchemaResolver;
  private readonly engine: GraphEngine;
  constructor(
    engine: EngineLike,
    private readonly opts: NodeWriterOptions = {},
  ) {
    this.engine = asEngine(engine);
    this.resolver = opts.resolver ?? new SchemaResolver(this.engine);
  }

  private stamp(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The caller's data without `updated_at`, dropped before validation (a
   *  type may still declare it). */
  private callerData(data: Record<string, unknown>): Record<string, unknown> {
    if (!(UPDATED_AT in data)) return data;
    const { [UPDATED_AT]: _drop, ...rest } = data;
    return rest;
  }

  /** Validate + compose everything except the MERGE. Exposed for tests and
   *  the batch path. */
  async prepare(input: NodeInput, opts: WriteOptions = {}): Promise<PreparedNode> {
    const [p] = await this.prepareMany([input], opts);
    return p!;
  }

  async prepareMany(inputs: NodeInput[], opts: WriteOptions = {}): Promise<PreparedNode[]> {
    const namespace = opts.namespace ?? this.engine.namespace;
    const validated: ValidatedNode[] = [];
    const now = this.stamp();
    for (const i of inputs) {
      const schema = await this.resolver.schema(i.type, opts.tx);
      if (!schema) throw new GraphValidationError("UNKNOWN_TYPE", i.type, "unknown node type (not a Strut type and no such Schema in the graph)");
      validated.push(validateNode(schema, this.callerData(i.data)));
    }
    // Gather every text to embed across the batch → one encoder call.
    const jobs: Array<{ idx: number; column: string; text: string }> = [];
    const prepared: PreparedNode[] = validated.map((v, idx) => {
      const ref_id = randomUUID();
      const key = keyedByRef(v.schema) ? refNodeKey(v.schema.type, ref_id) : composeNodeKey(v.schema, v.values);
      // A Neo4j graph keeps jarvis's composition: its nodes hold no alt_names.
      const { text, fields } = buildSearchText(v.schema, v.values, this.engine.kind === "neo4j" ? [] : [ALT_NAMES]);
      // One clock read for both stamps; `created_at` is identity
      // (PRESERVED), so only a create writes it.
      const props: Record<string, unknown> = { ...v.values, [stampKey(v.schema)]: now, [UPDATED_AT]: now };
      const by = inputs[idx]!.created_by;
      if (by && (this.engine.kind !== "neo4j" || OWN_CREATED_BY.has(v.schema.type))) props["created_by"] = by;
      // A type that declares `title` itself (StrutApp, StrutJob: title_key
      // `title`) owns it: the caller's value is the title, or there is none.
      // So does a jarvis type that breaks the title_key rule (Person, whose
      // `title` is a job title): its stored `title` is left as it is. A
      // Neo4j graph stores no core title (no new data shapes there): its
      // readers compose one from `title_key` (`nodeTitle`).
      if (!("title" in v.schema.attributes)) {
        const title = nodeTitleFor(v.schema, v.values, text);
        if (title && this.engine.kind !== "neo4j") props["title"] = title;
        else if (!title && v.schema.requiresTitle) {
          throw new GraphValidationError("MISSING_REQUIRED", v.schema.type, `an Entity or Concept needs a title: its ${v.schema.title_key} (the type's title_key) is empty and it has no text`, v.schema.title_key);
        }
      }
      if (text !== null) {
        // Ladybug's full-text index splits words on spaces alone ("Kate\nKatherine"
        // is one word to it), so a Ladybug file stores the text on one line.
        const stored = this.engine.kind === "neo4j" ? text : text.replace(/\s+/g, " ");
        props["search_text"] = stored;
        props["_search_fields_used"] = fields;
        // The no-embed mark: keyword text, never a vector.
        if (v.schema.embed) jobs.push({ idx, column: "text_embeddings", text: stored });
      }
      for (const vi of v.schema.vector_index) {
        const raw = v.values[vi];
        if (typeof raw !== "string") continue;
        const rendered = renderVectorField(vi, raw);
        if (rendered) jobs.push({ idx, column: embeddingColumn(vi), text: rendered });
      }
      return { schema: v.schema, key, ref_id, namespace, props };
    });
    if (this.opts.embedder && jobs.length) {
      const vectors = await this.opts.embedder.embed(jobs.map((j) => j.text));
      jobs.forEach((j, i) => {
        prepared[j.idx]!.props[j.column] = vectors[i];
      });
    }
    return prepared;
  }

  /** Write one node. */
  async write(input: NodeInput, mode: WriteMode = "create", opts: WriteOptions = {}): Promise<NodeWriteResult> {
    const [r] = await this.writeMany([input], mode, opts);
    return r!;
  }

  /**
   * Write many nodes (any mix of types) in one transaction — one batch per
   * type, same resulting state as the single form. Results are in input
   * order. All-or-nothing: a validation error anywhere writes nothing.
   * With `tx`, on the caller's transaction.
   */
  async writeMany(inputs: NodeInput[], mode: WriteMode = "create", opts: WriteOptions = {}): Promise<NodeWriteResult[]> {
    if (inputs.length === 0) return [];
    const namespace = opts.namespace ?? this.engine.namespace;
    const prepared = await this.prepareMany(inputs, { ...opts, namespace });
    const results: NodeWriteResult[] = new Array(inputs.length);
    const go = async (tx: GraphTx) => {
      await this.ontoKept(tx, inputs, prepared, { ...opts, namespace, tx });
      const byType = new Map<string, Array<{ i: number; p: PreparedNode }>>();
      prepared.forEach((p, i) => {
        const list = byType.get(p.schema.type) ?? [];
        list.push({ i, p });
        byType.set(p.schema.type, list);
      });
      await this.refuseSharedIdentifiers(tx, prepared.map((p) => ({ p, key: p.key })), namespace);
      for (const [type, rows] of byType) {
        const out = await this.engine.nodeEngine.mergeBatch(tx, rows[0]!.p.schema, namespace, rows.map((r) => r.p), mode);
        rows.forEach((r, k) => {
          results[r.i] = { ...out[k]!, node_key: out[k]!.key, node_type: type };
        });
      }
    };
    await (opts.tx ? go(opts.tx) : this.engine.tx(go));
    this.embedRecomposed(opts.tx);
    return results;
  }

  /**
   * Partial update by ref_id (jarvis `POST /v2/nodes/:ref_id` with
   * `node_data` / `properties_to_be_deleted`): the patch is merged over the
   * node's current attributes, the merged payload is re-validated as a
   * whole, the `key` is recomposed (an identity edit that collides with
   * another node fails with DUPLICATE_KEY, nothing written), and
   * `search_text`, `title` + vectors are rebuilt. Identity stamps (`ref_id`,
   * `namespace`, `created_at`) and the delete markers are untouched.
   * A type keyed by `ref_id` keeps its key. With `tx`, on the caller's
   * transaction.
   */
  async update(ref_id: string, patch: NodeUpdate, opts: WriterCallOptions = {}): Promise<NodeUpdateResult> {
    const remove = patch.remove ?? [];
    const set = this.callerData(patch.set ?? {});
    const go = async (tx: GraphTx): Promise<NodeUpdateResult> => {
      // Read by the type's schema: a Concept on Neo4j that holds no
      // `created_at` of its own must not show its stamp as one.
      const raw = await this.engine.nodeEngine.readRaw(tx, ref_id, (t) => this.resolver.schema(t, tx));
      if (!raw) throw new GraphValidationError("NOT_FOUND", "?", `no node with ref_id ${ref_id}`);
      const props = raw.props;
      const type = raw.type ?? "?";
      const schema = await this.resolver.schema(type, tx);
      if (!schema) throw new GraphValidationError("UNKNOWN_TYPE", type, "stored node's type has no schema");
      const attrs = schema.attributes;

      const current: Record<string, unknown> = {};
      // The stored stamp is the writer's, not an attribute to revalidate: an
      // integer on a type still declared ?string would fail the edit.
      for (const k of Object.keys(attrs)) if (k !== UPDATED_AT && props[k] !== undefined && props[k] !== null) current[k] = props[k];
      for (const k of remove) {
        if (k === UPDATED_AT) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, "updated_at is system-owned and cannot be removed", k);
        const t = attrs[k];
        if (!t) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, "attribute is not declared on the schema", k);
        if (!isOptionalType(t)) throw new GraphValidationError("MISSING_REQUIRED", type, "required attribute cannot be removed", k);
        delete current[k];
      }
      const merged = { ...current, ...set };
      for (const k of remove) if (k in set) delete merged[k];

      const [p] = await this.prepareMany([{ type: schema.type, data: merged }], { namespace: String(props["namespace"]), tx });
      const key = keyedByRef(schema) ? String(props["key"]) : p!.key;
      const rekeyed = key !== props["key"];
      await this.refuseSharedIdentifiers(tx, [{ p: p!, key, self: ref_id }], String(props["namespace"]));
      if (rekeyed) {
        const clash = await this.engine.nodeEngine.refByKey(tx, schema.type, key, String(props["namespace"]));
        if (clash && clash !== ref_id) throw new GraphValidationError("DUPLICATE_KEY", type, `Node already exists in the graph with key: ${key}`);
      }

      // Everything the fresh payload would carry, minus identity stamps.
      const setMap: Record<string, unknown> = { key };
      // A type's own `created_at` (TYPE_OWNABLE_CORE) is a field it may edit.
      for (const [k, val] of Object.entries(p!.props)) if (!PRESERVED.has(k) || k in attrs) setMap[k] = val;
      const drop = new Set<string>(remove);
      if (!("search_text" in setMap)) for (const k of ["search_text", "_search_fields_used", "text_embeddings"]) drop.add(k);
      else if (!schema.embed) drop.add("text_embeddings"); // a vector an earlier writer left on a no-embed node goes with the update
      else if (!this.opts.embedder && setMap["search_text"] !== props["search_text"]) drop.add("text_embeddings");
      if (!("title" in setMap) && !("title" in attrs)) drop.add("title");
      for (const vi of schema.vector_index) {
        const col = embeddingColumn(vi);
        if (!(vi in merged)) drop.add(col);
        else if (!this.opts.embedder && merged[vi] !== props[vi]) drop.add(col);
      }
      for (const k of drop) delete setMap[k];
      // Attributes present before but absent from the merged payload
      // (e.g. explicitly set to null) go too.
      for (const k of Object.keys(attrs)) if (k in props && !(k in setMap) && !drop.has(k) && !(k in merged)) drop.add(k);
      // `updated_at` moves only when an attribute does, so a resync keeps its
      // stamp. search_text, title and the vectors follow from the attributes.
      if (!rekeyed && Object.keys(attrs).every((k) => k === UPDATED_AT || sameStored(props[k], p!.props[k]))) delete setMap[UPDATED_AT];
      await this.engine.nodeEngine.update(tx, schema, ref_id, setMap, [...drop]);
      return { ref_id, key, rekeyed };
    };
    const out = await (opts.tx ? go(opts.tx) : this.engine.tx(go));
    this.embedRecomposed(opts.tx);
    return out;
  }

  /** A title change recomposed facts' search rows (Ladybug,
   *  plans/graph-edge-search.md): embed them in the background now it has
   *  committed; the write never waits. On a caller's transaction, not yet
   *  committed, they wait for the next open. */
  private embedRecomposed(tx: GraphTx | undefined): void {
    if (tx || !this.opts.embedder || !this.engine.nodeEngine.takeUnembedded?.()) return;
    void this.engine.nodeEngine.embedPendingRows?.(this.opts.embedder);
  }

  /**
   * A write to the key of a node merged away (`merge.ts`) lands on the node
   * it was merged into, chains followed: its prepared row is composed again
   * with the kept node's key and title attributes, so the write is an
   * ordinary one to the kept node (a create finds it, an upsert sets its
   * other fields), and the kept node keeps its own name. The duplicate stays
   * as the merge left it, so undo still finds it so. A node deleted but
   * never merged is restored as before. Ladybug only (`mergedAway`).
   */
  private async ontoKept(tx: GraphTx, inputs: NodeInput[], prepared: PreparedNode[], opts: WriteOptions): Promise<void> {
    const engine = this.engine.nodeEngine;
    if (!engine.mergedAway) return;
    const target = new Map<number, string>();
    const byType = new Map<string, number[]>();
    prepared.forEach((p, i) => byType.set(p.schema.type, [...(byType.get(p.schema.type) ?? []), i]));
    for (const [type, idxs] of byType) {
      const schema = prepared[idxs[0]!]!.schema;
      // The key first (a type keyed by ref_id never matches on it), then
      // each identifier, as the identifier rule reads them.
      const slots: Array<[string, (i: number) => unknown]> = (schema.identifiers ?? []).map((id) => [id, (i) => prepared[i]!.props[id]]);
      if (!keyedByRef(schema)) slots.unshift(["key", (i) => prepared[i]!.key]);
      for (const [attribute, valueOf] of slots) {
        const open = idxs.filter((i) => !target.has(i) && valueOf(i) !== undefined && valueOf(i) !== null && valueOf(i) !== "");
        if (!open.length) continue;
        const kept = await engine.mergedAway(tx, type, attribute, open.map(valueOf), opts.namespace!);
        for (const i of open) {
          const ref_id = kept.get(String(valueOf(i)));
          if (ref_id) target.set(i, ref_id);
        }
      }
    }
    for (const [i, ref_id] of target) {
      const raw = await engine.readRaw(tx, ref_id);
      if (!raw) continue;
      const schema = prepared[i]!.schema;
      const names = [...schema.key_spec.split("-").slice(1), schema.title_key].filter(Boolean).map((n) => n.toLowerCase());
      const data = Object.fromEntries(Object.entries(inputs[i]!.data).filter(([k]) => !names.includes(k.toLowerCase())));
      for (const [k, v] of Object.entries(raw.props)) if (names.includes(k.toLowerCase()) && v !== null && v !== undefined) data[k] = v;
      const [p] = await this.prepareMany([{ ...inputs[i]!, data }], opts);
      prepared[i] = { ...p!, key: String(raw.props["key"]) };
    }
  }

  /**
   * The identifier rule (`NodeSchema.identifiers`): an identifier's value
   * names one live node of the type in the namespace. A write that would give
   * it to a second node — another stored node, or another node of the batch
   * — is refused before anything is written. The node itself (`self`, or a
   * node with the write's own key: a create that finds it) is no clash.
   */
  private async refuseSharedIdentifiers(tx: GraphTx, nodes: Array<{ p: PreparedNode; key: string; self?: string }>, namespace: string): Promise<void> {
    const slots = new Map<string, { type: string; id: string; rows: Array<{ value: unknown; key: string; self?: string }> }>();
    for (const n of nodes) {
      for (const id of n.p.schema.identifiers ?? []) {
        const value = n.p.props[id];
        if (value === undefined || value === null || value === "") continue;
        const slot = `${n.p.schema.type}\u0000${id}`;
        const at = slots.get(slot) ?? { type: n.p.schema.type, id, rows: [] };
        at.rows.push({ value, key: n.key, self: n.self });
        slots.set(slot, at);
      }
    }
    const clash = (type: string, id: string, value: unknown, other: string) =>
      new GraphValidationError("DUPLICATE_KEY", type, `${other} already has ${id} ${JSON.stringify(value)}: an identifier names one node`, id);
    for (const { type, id, rows } of slots.values()) {
      const byValue = new Map<string, string>();
      for (const r of rows) {
        const other = byValue.get(String(r.value));
        if (other !== undefined && other !== r.key) throw clash(type, id, r.value, "another node in this write");
        byValue.set(String(r.value), r.key);
      }
      const holders = await this.engine.nodeEngine.holdersOf(tx, type, id, rows.map((r) => r.value), namespace);
      for (const r of rows) {
        const other = holders.find((h) => String(h.value) === String(r.value) && h.ref_id !== r.self && h.key !== r.key);
        if (other) throw clash(type, id, r.value, other.ref_id);
      }
    }
  }

  /** Soft delete (`deletion.ts`): stamps `deleted_at` (the first delete
   *  time is kept) + `is_deleted`, and hard-deletes the node's in-scope edges
   *  in the same statement. Scoped to Strut's own nodes in this namespace.
   *  Options: `keepEdges` leaves the edges, `reason` is stored as
   *  `deleted_reason`, `tx` runs on the caller's transaction. */
  async softDelete(ref_id: string, opts: SoftDeleteOptions = {}): Promise<boolean> {
    return (await this.engine.nodeEngine.softDelete(ref_id, this.engine.namespace, { domainLabel: STRUT_DOMAIN_LABEL }, opts)) !== null;
  }

  /** `softDelete` for a node of ANY type in the namespace, on a caller's
   *  say-so (`graph/delete-node`, the twin of hive's graphNodeDelete):
   *  `deleted_at` stamped, its in-scope edges hard-deleted and counted.
   *  Null when there is no such node there. The `Domain_strut` guard stays
   *  on `softDelete` for strut's own rows. Takes `softDelete`'s options. */
  async deleteNode(ref_id: string, opts: SoftDeleteOptions & { namespace?: string } = {}): Promise<SoftDeleteResult | null> {
    const { namespace, ...how } = opts;
    return this.engine.nodeEngine.softDelete(ref_id, namespace ?? this.engine.namespace, {}, how);
  }

  /** `softDelete` for the one non-Strut node strut retires: a stale
   *  `planned` Evidence slot (`verify.ts`). Evidence is jarvis's epistemic
   *  domain, so `softDelete`'s `Domain_strut` guard stays; this matches only
   *  a planned slot in this namespace. */
  async retirePlannedEvidence(ref_id: string): Promise<boolean> {
    return (await this.engine.nodeEngine.softDelete(ref_id, this.engine.namespace, { type: EVIDENCE_TYPE, props: { evidence_status: "planned" } })) !== null;
  }
}
