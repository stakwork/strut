// The memory's vocabulary: entity types and fact predicates, kept as Schema
// nodes of the workspace graph (plans/memory-in-workspace-graph.md decisions
// 1, 2), all managed by memory, so it grows without code changes. The core
// set is seeded (_ontology-seed.ts); anything new arrives as `proposed` for
// a janitor or the user to merge or promote. An entity type is a real node
// type (its entities are nodes of it); a predicate is a Schema with kind
// "predicate", and a fact is a node whose predicate is a field, so a new
// kind of relationship needs no new edge table.
//
// Behaviour is data too: a type's `parent`, `naming` and `role` decide how
// its entities are matched and protected, read through `vocabulary()`. No
// step names a type or predicate.
import { createHash, randomUUID } from "node:crypto";
import type { GraphTx } from "../../../graph/engine.js";
import type { LadybugBackend } from "../../../graph/backend.js";
import type { MemoryTx, Query, Row } from "./_db.js";
import { BASE_SCHEMAS, EDGE_SCHEMAS, ENTITY_BASE, SEED } from "./_ontology-seed.js";

type Kind = "entity_type" | "predicate";

export type Term = {
  kind: Kind;
  name: string;
  description: string;
  status: "active" | "proposed";
  /** Predicates: "one" means a new fact supersedes the subject's current one. */
  cardinality: "one" | "many" | "";
  /** Predicates: the entity types it may start from and point at; "*" is any. A subtype fits its ancestor. */
  subject_types: string[];
  object_types: string[];
  aliases: string[];
  /** Entity types: the type this one inherits naming from; "" for none. */
  parent: string;
  /** Entity types: how names are matched: "person", "organisation" or "plain"; "" inherits, then plain. */
  naming: string;
  /** Entity types: "user" marks the one type that is the user, "dictation" the type dictation makes a new word as. Predicates: "alias" marks a fact whose text is another name for its subject;
   *  "mishearing" one whose value is how dictation mishears it (never an alias). */
  role: string;
};

const MANAGER = "memory";

/** A raw query on the same connection: the Schema rows are read as the
 *  workspace keeps them, not through memory's dialect (_db.ts `cypher`). */
type Raw = (cypher: string, params?: Record<string, unknown>) => Promise<Row[]>;
const rawOf = (query: Query): Raw => (query as Query & { raw?: Raw }).raw ?? query;

export const snake = (s: string) =>
  s.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const pascal = (s: string) => snake(s).split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

export type Resolved = { term: Term; given: string; proposed: boolean };

/** The name a new term of this kind would be stored under; "" when `given` has no letters or digits. */
export function termName(kind: Kind, given: string): string {
  return kind === "entity_type" ? pascal(given) : snake(given);
}

export type Vocabulary = {
  /** Every term, active before proposed, then by name. */
  terms: Term[];
  /** The term a given name means: an exact name, else an alias, both compared as snake_case. */
  term(kind: Kind, given: string): Term | undefined;
  /** The type's parent, its parent, …: nearest first, at most 10, stopping at a cycle. */
  ancestors(type: string): string[];
  /** How a type's names are matched, from the type or its nearest ancestor that sets it; "plain" by default. */
  naming(type: string): string;
  /** The type's own role ("user", "dictation" or ""). Not inherited: a subtype of the user type is not the user. */
  role(type: string): string;
  /** The entity type with role "user", if any. */
  userType(): string | undefined;
  /** The first entity type with this role, e.g. "dictation": the type dictation makes a new word as. */
  typeWithRole(role: string): string | undefined;
  /** The predicates with this role, e.g. "alias": the fact's text gives its subject another name. */
  predicatesWithRole(role: string): string[];
};

const MAX_DEPTH = 10;

function vocabularyOf(terms: Term[]): Vocabulary {
  const types = new Map(terms.filter((t) => t.kind === "entity_type").map((t) => [t.name, t]));
  const ancestors = (type: string) => {
    const out: string[] = [];
    for (let t = types.get(type)?.parent; t && t !== type && !out.includes(t) && out.length < MAX_DEPTH; t = types.get(t)?.parent) out.push(t);
    return out;
  };
  return {
    terms,
    term(kind, given) {
      const snaked = snake(given);
      const key = kind === "entity_type" ? snaked.replace(/_/g, "") : snaked;
      return terms.find((t) => t.kind === kind && (t.name.toLowerCase() === key || t.aliases.includes(key)));
    },
    ancestors,
    naming: (type) => [type, ...ancestors(type)].map((t) => types.get(t)?.naming).find(Boolean) ?? "plain",
    role: (type) => types.get(type)?.role ?? "",
    userType: () => terms.find((t) => t.kind === "entity_type" && t.role === "user")?.name,
    typeWithRole: (role) => terms.find((t) => t.kind === "entity_type" && t.role === role)?.name,
    predicatesWithRole: (role) => terms.filter((t) => t.kind === "predicate" && t.role === role).map((t) => t.name),
  };
}

/** Memory's Schemas as terms. An entity type's parent MemoryEntity is the base every type has: no parent. */
async function readTerms(raw: Raw): Promise<Term[]> {
  const rows = await raw(
    `MATCH (n:Node) WHERE n.node_type = 'Schema' AND n.managed_by = $m AND n.kind IN ['entity_type', 'predicate'] AND n.deleted_at IS NULL
     RETURN n.kind AS kind, n.type AS name, n.type_description AS description, n.status AS status, n.cardinality AS cardinality,
            n.subject_types AS subject_types, n.object_types AS object_types, n.aliases AS aliases,
            n.parent AS parent, n.naming AS naming, n.role AS role
     ORDER BY n.status, n.type`,
    { m: MANAGER },
  );
  return rows.map((r) => ({
    kind: r.kind, name: r.name, description: r.description ?? "", status: r.status ?? "active", cardinality: r.cardinality ?? "",
    subject_types: r.subject_types ?? [], object_types: r.object_types ?? [], aliases: r.aliases ?? [],
    parent: r.parent && r.parent !== ENTITY_BASE ? r.parent : "", naming: r.naming ?? "", role: r.role ?? "",
  }) as Term);
}

// One read of every term (tens of them) per query function, kept until a
// Schema write through it. The workspace's read connection keeps its copy
// until a memory transaction that wrote a Schema commits (memoryWrite); a
// transaction loads its own, so it sees its own proposals and no reader sees
// them before they commit. Kept on globalThis like the handles, so a
// re-imported module shares it.
const cache = ((globalThis as Record<symbol, unknown>)[Symbol.for("strut.memory.vocabulary")] ??= {
  loaded: new WeakMap<Query, Promise<Vocabulary>>(),
  written: new WeakSet<Query>(),
}) as { loaded: WeakMap<Query, Promise<Vocabulary>>; written: WeakSet<Query> };

export function vocabulary(query: Query): Promise<Vocabulary> {
  let v = cache.loaded.get(query);
  if (!v) {
    v = readTerms(rawOf(query)).then(vocabularyOf);
    cache.loaded.set(query, v);
    const loaded = v;
    v.catch(() => { if (cache.loaded.get(query) === loaded) cache.loaded.delete(query); });
  }
  return v;
}

/** Drops the vocabulary cached for `query`; call after any Schema write made through it. */
export function invalidate(query: Query): void {
  cache.loaded.delete(query);
  cache.written.add(query);
}

/** Whether a Schema write was made through `query`: memoryWrite asks of its transaction. */
export const wroteOntology = (query: Query): boolean => cache.written.has(query);

export async function lookup(query: Query, kind: Kind, given: string): Promise<Term | undefined> {
  return (await vocabulary(query)).term(kind, given);
}

// ── Writing Schemas ─────────────────────────────────────────────────────────

/** A term as the flat Schema map the workspace writes: managed by memory, keyed by ref_id. */
function flatOf(t: Term, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: t.name, kind: t.kind, status: t.status, managed_by: MANAGER, node_key: "ref_id",
    aliases: t.aliases, ...(t.description ? { type_description: t.description } : {}),
    ...(t.naming ? { naming: t.naming } : {}), ...(t.role ? { role: t.role } : {}),
  };
  if (t.kind === "entity_type") out["parent"] = t.parent || ENTITY_BASE;
  else Object.assign(out, { cardinality: t.cardinality || "many", subject_types: t.subject_types, object_types: t.object_types });
  return { ...out, ...extra };
}

/** Whoever else holds `name` (a type or alias, case-blind): decision 9's clash. */
async function heldByOther(b: LadybugBackend, tx: GraphTx, names: string[]): Promise<{ type: string; owner: string } | undefined> {
  const held = (await b.schemaSource.typesNamed(names, tx)).find((h) => h.managed_by !== MANAGER);
  return held && { type: held.type, owner: held.managed_by ?? "the workspace" };
}

/** Creates a term's Schema in `tx`, and an entity type's parent link unless `link` is false (the parent may come later in a batch). */
async function createTerm(b: LadybugBackend, tx: GraphTx, t: Term, link = true): Promise<void> {
  await b.schemaSource.createSchema({ ...flatOf(t), ref_id: randomUUID() }, tx);
  if (link && t.kind === "entity_type") await linkParent(b, tx, t);
}

async function linkParent(b: LadybugBackend, tx: GraphTx, t: Term): Promise<void> {
  // A parent that is not there (yet, or at all) leaves the type under the base.
  if ((await b.schemaSource.ensureChildOf(t.name, t.parent || ENTITY_BASE, randomUUID(), tx)) === null) {
    await b.schemaSource.ensureChildOf(t.name, ENTITY_BASE, randomUUID(), tx);
  }
}

/** An existing entity type's parent, moved: its old CHILD_OF link goes, as there is one parent. */
async function reparent(b: LadybugBackend, tx: GraphTx, type: string, parent: string): Promise<void> {
  await tx.run(
    `MATCH (c:Node)-[r:SCHEMA_EDGE]->(p:Node) WHERE c.node_type = 'Schema' AND c.type = $t AND r.edge_type = 'CHILD_OF' AND p.type <> $p DELETE r`,
    { t: type, p: parent },
  );
  await b.schemaSource.extendSchema(type, { parent }, tx);
  await b.schemaSource.ensureChildOf(type, parent, randomUUID(), tx);
}

export type Clash = { given: string; type: string; owner: string };

/**
 * As `lookup`, else a new `proposed` term, written now (a Schema in the
 * memory transaction) so the next use finds it. `context` fills a proposed
 * predicate's subject and object types. A proposed term's naming and role
 * are left unset, so it behaves as the defaults and a later seed of the same
 * name can fill them. An entity type spelled with a trailing "Type"
 * ("UserType") is looked up and proposed without it. A name another owner
 * holds (an app's "Channel") proposes nothing: the result is a `clash`.
 */
export async function resolve(
  m: MemoryTx, kind: Kind, given: string, by: string,
  context: { subject?: string; object?: string } = {},
): Promise<Resolved | { clash: Clash }> {
  void by;
  const query = m.query;
  const found = await lookup(query, kind, given);
  if (found) return { term: found, given, proposed: false };
  const bare = kind === "entity_type" ? given.trim().replace(/(?<=[A-Za-z0-9])[\s_-]*type$/i, "") : given;
  if (bare !== given) {
    const hit = await lookup(query, kind, bare);
    if (hit) return { term: hit, given, proposed: false };
  }
  const name = termName(kind, bare);
  if (!name) throw new Error(`invalid_input: ${kind === "entity_type" ? "type" : "predicate"} ${JSON.stringify(given)} has no letters or digits`);
  const clash = await heldByOther(m.backend, m.tx, [name]);
  if (clash) return { clash: { given, ...clash } };
  const base = { kind, name, description: "", status: "proposed" as const, aliases: [], parent: "", naming: "", role: "" };
  const term: Term = kind === "entity_type"
    ? { ...base, cardinality: "", subject_types: [], object_types: [] }
    : { ...base, cardinality: "many", subject_types: context.subject ? [context.subject] : [], object_types: context.object ? [context.object] : [] };
  await createTerm(m.backend, m.tx, term);
  invalidate(query);
  m.backend.schemas.invalidate();
  return { term, given, proposed: true };
}

/** A predicate's declared types, as a note when a fact does not fit them. A type fits when it or an ancestor is listed. */
export function fitNote(vocab: Vocabulary, predicate: Term, subject: string, object?: string): string | undefined {
  const fits = (allowed: string[], type?: string) =>
    !type || allowed.length === 0 || allowed.includes("*") || [type, ...vocab.ancestors(type)].some((t) => allowed.includes(t));
  if (predicate.status !== "active") return undefined;
  if (!fits(predicate.subject_types, subject)) return `${predicate.name} usually starts from ${predicate.subject_types.join(" or ")}, not ${subject}.`;
  if (!fits(predicate.object_types, object)) return `${predicate.name} usually points at ${predicate.object_types.join(" or ")}, not ${object}.`;
  return undefined;
}

// ── The seed ────────────────────────────────────────────────────────────────

export type SeedTerm = Term & { previous?: string; previousRole?: string };

/** Which seed a graph has had: the stamp in the workspace's Migration ledger. */
export const ontologyVersion = (): string =>
  createHash("sha256").update(JSON.stringify({ BASE_SCHEMAS, EDGE_SCHEMAS, SEED })).digest("hex").slice(0, 12);

export interface MemorySeedReport {
  created: string[];
  /** Seed terms not made because another owner holds the name (decision 9). */
  skipped: Array<{ name: string; owner: string }>;
}

/**
 * Seeds memory's ontology into the workspace, once per version of the seed,
 * in one transaction: the base types (MemoryEntity, Fact, Episode, their
 * attributes as columns), the entity types and predicates, and the edge
 * rules between them. Adds what is missing and backfills unset behaviour on
 * what is there; never overwrites an edited term. The user role goes to one
 * type only: a seed term with role user, when another type already has it,
 * is left without one.
 */
export async function seedMemoryOntology(b: LadybugBackend): Promise<MemorySeedReport | null> {
  const stamp = `memory_ontology_seed:${ontologyVersion()}`;
  const done = await b.lbug.query("MATCH (m:Migration) WHERE m.migration_id = $id RETURN m.migration_id AS id", { id: stamp });
  if (done.length) return null;
  const report: MemorySeedReport = { created: [], skipped: [] };
  await b.lbug.withWrite(async (tx) => {
    const src = b.schemaSource;
    for (const flat of BASE_SCHEMAS) {
      const type = String(flat["type"]);
      const row = await src.schemaRow(type, {}, tx);
      if (row?.type === type && row.props["managed_by"] !== MANAGER) {
        throw new Error(`memory: the workspace already has a type ${type} owned by ${row.props["managed_by"] ?? "the workspace"}; memory cannot move in`);
      }
      if (row?.type === type) await src.extendSchema(type, missingKeys(row.props, flat), tx);
      else {
        await src.createSchema({ ...flat, managed_by: MANAGER, node_key: "ref_id", ref_id: randomUUID() }, tx);
        report.created.push(type);
      }
      await src.ensureChildOf(type, String(flat["parent"]), randomUUID(), tx);
    }
    const terms = await readTerms((c, p) => tx.run(c, p));
    // Naming is filled only where unset (NULL): an empty one was set by someone.
    const unnamed = new Set((await tx.run(
      "MATCH (n:Node) WHERE n.node_type = 'Schema' AND n.managed_by = $m AND n.kind = 'entity_type' AND n.naming IS NULL RETURN n.type AS t",
      { m: MANAGER },
    )).map((r: Row) => r["t"]));
    let user = terms.find((t) => t.kind === "entity_type" && t.role === "user")?.name;
    const made: Term[] = [];
    for (const t of SEED as SeedTerm[]) {
      const have = terms.find((x) => x.kind === t.kind && x.name === t.name);
      if (!have) {
        const clash = await heldByOther(b, tx, [t.name]);
        if (clash) {
          report.skipped.push({ name: t.name, owner: clash.owner });
          continue;
        }
        // A seed alias another owner holds is left off; the term still lands.
        const taken = new Set((await b.schemaSource.typesNamed(t.aliases, tx)).filter((h) => h.managed_by !== MANAGER).flatMap((h) => [h.type, ...h.aliases].map((n) => n.toLowerCase())));
        const role = t.role === "user" && user && user !== t.name ? "" : t.role;
        await createTerm(b, tx, { ...t, role, aliases: t.aliases.filter((a) => !taken.has(a.toLowerCase())) }, false);
        if (role === "user") user = t.name;
        report.created.push(t.name);
        made.push(t);
        continue;
      }
      // Backfill: a parent or naming left unset (a proposal of the same name),
      // a role unset or as an earlier seed wrote it, a description still as an
      // earlier seed wrote it.
      const fill: Record<string, unknown> = {};
      if (t.naming && unnamed.has(t.name)) fill["naming"] = t.naming;
      if (t.role && (have.role === "" || have.role === t.previousRole) && have.role !== t.role && !(t.role === "user" && user && user !== t.name)) fill["role"] = t.role;
      if (t.description && (have.description === "" || have.description === t.previous) && have.description !== t.description) fill["type_description"] = t.description;
      if (Object.keys(fill).length) await src.extendSchema(t.name, fill, tx);
      if (t.kind === "entity_type" && t.parent && !have.parent) await reparent(b, tx, t.name, t.parent);
    }
    for (const t of made) if (t.kind === "entity_type") await linkParent(b, tx, t);
    for (const e of EDGE_SCHEMAS) await src.ensureEdgeSchema(e.source, e.edge, e.target, { ref_id: randomUUID() }, tx);
    await tx.run("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = CAST($now AS INT64)", { id: stamp, now: Date.now() });
  });
  b.schemas.invalidate();
  const users = (await readTerms(b.lbug.query)).filter((t) => t.kind === "entity_type" && t.role === "user");
  if (users.length > 1) console.warn(`memory: more than one type has role user (${users.map((t) => t.name).join(", ")}); ${users[0]!.name} is the user`);
  if (report.skipped.length) console.warn(`memory: seed types held by another owner were not made: ${report.skipped.map((s) => `${s.name} (${s.owner})`).join(", ")}`);
  return report;
}

/** The keys of `flat` a row lacks (add-only). */
function missingKeys(have: Record<string, unknown>, flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) if (k !== "type" && k !== "parent" && !(k in have)) out[k] = v;
  return out;
}

/** Creates or updates terms as another graph has them (memory's migration and
 *  home sync import): missing ones are made; an existing one takes the
 *  given fields. The source is the truth for what it carries. */
export async function applyTerms(b: LadybugBackend, tx: GraphTx, terms: Term[]): Promise<void> {
  const have = await readTerms((c, p) => tx.run(c, p));
  const made: Term[] = [];
  for (const t of terms) {
    const was = have.find((x) => x.kind === t.kind && x.name === t.name);
    if (!was) {
      if (await heldByOther(b, tx, [t.name])) continue;
      await createTerm(b, tx, t, false);
      made.push(t);
      continue;
    }
    const { type: _t, parent: _p, node_key: _k, ref_id: _r, ...fields } = flatOf(t) as Record<string, unknown>;
    await b.schemaSource.extendSchema(t.name, fields, tx);
    if (t.kind === "entity_type" && (t.parent || "") !== (was.parent || "")) await reparent(b, tx, t.name, t.parent || ENTITY_BASE);
  }
  for (const t of made) if (t.kind === "entity_type") await linkParent(b, tx, t);
  b.schemas.invalidate();
}

/** Memory's terms as they are, for an export. */
export async function termsOf(raw: Raw): Promise<Term[]> {
  return readTerms(raw);
}
