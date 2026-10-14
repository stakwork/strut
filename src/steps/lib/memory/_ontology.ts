// The memory's vocabulary: entity types and fact predicates, kept as rows
// in the Ontology table so it grows without code changes. The core set is
// seeded once (_ontology-seed.ts); anything new arrives as `proposed` for a
// janitor or the user to merge or promote. Edge tables never change: a new
// kind of relationship is a new predicate.
//
// Behaviour is data too: a type's `parent`, `naming` and `role` decide how
// its entities are matched and protected, read through `vocabulary()`. No
// step names a type or predicate.
import type { Query } from "./_db.js";

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
  /** Entity types: "user" marks the one type that is the user. Predicates: "alias" marks a fact whose text is another name for its subject. */
  role: string;
};

export const ONTOLOGY_DDL = `CREATE NODE TABLE IF NOT EXISTS Ontology(key STRING PRIMARY KEY, kind STRING, name STRING,
  description STRING, status STRING, cardinality STRING, subject_types STRING[], object_types STRING[], aliases STRING[],
  created_by STRING, created_at INT64, updated_at INT64)`;

// Creates a missing row; on an existing one fills only behaviour columns
// that are NULL (added by a migration after the row was written, or left
// unset by a proposal). A value someone set, even "", is kept. A description
// still reading as an earlier seed wrote it (`previous`) takes the new text.
const MERGE = `MERGE (o:Ontology {key: $key}) ON CREATE SET o.kind = $kind, o.name = $name, o.description = $description,
  o.status = $status, o.cardinality = $cardinality, o.subject_types = $subject_types, o.object_types = $object_types,
  o.aliases = $aliases, o.created_by = $by, o.created_at = $now, o.updated_at = $now
  SET o.parent = coalesce(o.parent, $parent), o.naming = coalesce(o.naming, $naming), o.role = coalesce(o.role, $role),
      o.description = CASE WHEN o.description = $previous THEN $description ELSE o.description END`;

/**
 * Adds the terms that are missing and backfills their unset properties; never
 * overwrites an edited one. The user role goes to one type only: a seed term
 * with role user, when another type already has it, is left without one.
 */
export async function seed(query: Query, terms: (Term & { previous?: string })[]): Promise<void> {
  const now = Date.now();
  invalidate(query);
  const user = (await vocabulary(query)).userType();
  for (const t of terms) {
    // NULL, not "": it stays unset, so the role comes back if the other type goes.
    const role = t.role === "user" && user && user !== t.name ? null : t.role;
    await query(MERGE, { key: `${t.kind}:${t.name}`, ...t, role, previous: t.previous ?? null, by: "seed", now });
  }
  invalidate(query);
  const users = (await vocabulary(query)).terms.filter((t) => t.kind === "entity_type" && t.role === "user");
  if (users.length > 1) console.warn(`memory: more than one type has role user (${users.map((t) => t.name).join(", ")}); ${users[0]!.name} is the user`);
}

export const snake = (s: string) =>
  s.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const pascal = (s: string) => snake(s).split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

export type Resolved = { term: Term; given: string; proposed: boolean };

/** The name a new term of this kind would be stored under; "" when `given` has no letters or digits. */
export function termName(kind: Kind, given: string): string {
  return kind === "entity_type" ? pascal(given) : snake(given);
}

export type Vocabulary = {
  /** Every row, active before proposed, then by name. */
  terms: Term[];
  /** The term a given name means: an exact name, else an alias, both compared as snake_case. */
  term(kind: Kind, given: string): Term | undefined;
  /** The type's parent, its parent, …: nearest first, at most 10, stopping at a cycle. */
  ancestors(type: string): string[];
  /** How a type's names are matched, from the type or its nearest ancestor that sets it; "plain" by default. */
  naming(type: string): string;
  /** The type's own role ("user" or ""). Not inherited: a subtype of the user type is not the user. */
  role(type: string): string;
  /** The entity type with role "user", if any. */
  userType(): string | undefined;
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
    predicatesWithRole: (role) => terms.filter((t) => t.kind === "predicate" && t.role === role).map((t) => t.name),
  };
}

// One read of every row (tens of them) per database, kept until an Ontology
// write. Keyed by the database's query function (_db.ts keeps one per file),
// and kept on globalThis like that handle, so a re-imported module shares it.
const cache = ((globalThis as Record<symbol, unknown>)[Symbol.for("strut.memory.vocabulary")] ??=
  new WeakMap<Query, Promise<Vocabulary>>()) as WeakMap<Query, Promise<Vocabulary>>;

export function vocabulary(query: Query): Promise<Vocabulary> {
  let v = cache.get(query);
  if (!v) {
    v = query(
      `MATCH (o:Ontology)
       RETURN o.kind AS kind, o.name AS name, o.description AS description, o.status AS status, o.cardinality AS cardinality,
              o.subject_types AS subject_types, o.object_types AS object_types, o.aliases AS aliases,
              o.parent AS parent, o.naming AS naming, o.role AS role
       ORDER BY o.status, o.name`,
    ).then((rows) => vocabularyOf(rows.map((r) => ({
      ...r, subject_types: r.subject_types ?? [], object_types: r.object_types ?? [], aliases: r.aliases ?? [],
      parent: r.parent ?? "", naming: r.naming ?? "", role: r.role ?? "",
    }) as Term)));
    cache.set(query, v);
    v.catch(() => cache.delete(query));
  }
  return v;
}

/** Drops the cached vocabulary; call after any Ontology write. */
export function invalidate(query: Query): void {
  cache.delete(query);
}

export async function lookup(query: Query, kind: Kind, given: string): Promise<Term | undefined> {
  return (await vocabulary(query)).term(kind, given);
}

/**
 * As `lookup`, else a new `proposed` term, written now so the next use
 * finds it. `context` fills a proposed predicate's subject and object types.
 * A proposed term's parent, naming and role are left unset (NULL), so it
 * behaves as the defaults and a later seed of the same name can fill them.
 */
export async function resolve(
  query: Query, kind: Kind, given: string, by: string,
  context: { subject?: string; object?: string } = {},
): Promise<Resolved> {
  const found = await lookup(query, kind, given);
  if (found) return { term: found, given, proposed: false };
  const name = termName(kind, given);
  if (!name) throw new Error(`invalid_input: ${kind === "entity_type" ? "type" : "predicate"} ${JSON.stringify(given)} has no letters or digits`);
  const base = { kind, name, description: "", status: "proposed" as const, aliases: [], parent: "", naming: "", role: "" };
  const term: Term = kind === "entity_type"
    ? { ...base, cardinality: "", subject_types: [], object_types: [] }
    : { ...base, cardinality: "many", subject_types: context.subject ? [context.subject] : [], object_types: context.object ? [context.object] : [] };
  await query(MERGE, { key: `${kind}:${term.name}`, ...term, parent: null, naming: null, role: null, previous: null, by, now: Date.now() });
  invalidate(query);
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
