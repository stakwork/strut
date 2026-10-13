// The memory's vocabulary: entity types and fact predicates, kept as rows
// in the Ontology table so it grows without code changes. The core set is
// seeded once; anything new arrives as `proposed` for a janitor or the user
// to merge or promote. Edge tables never change: a new kind of relationship
// is a new predicate.
import type { Connection } from "@ladybugdb/core";

type Kind = "entity_type" | "predicate";

export type Term = {
  kind: Kind;
  name: string;
  description: string;
  status: "active" | "proposed";
  /** Predicates: "one" means a new fact supersedes the subject's current one. */
  cardinality: "one" | "many" | "";
  /** Predicates: the entity types it may start from and point at; "*" is any. */
  subject_types: string[];
  object_types: string[];
  aliases: string[];
};

const ANY = ["*"];
const PEOPLE = ["Self", "Person"];

const entityTypes: [string, string, string[]][] = [
  ["Self", "The user. There is one.", ["me", "user", "myself"]],
  ["Person", "Someone the user knows of.", ["people", "contact", "friend", "human"]],
  ["Organization", "A company, team, tribe or group.", ["org", "organisation", "company", "team", "group"]],
  ["Place", "A city, address or venue.", ["location", "city", "venue"]],
  ["Topic", "A subject, interest or idea.", ["subject", "interest", "idea"]],
  ["Project", "A piece of work with a goal.", ["work", "initiative"]],
  ["Event", "Something that happens at a time.", ["meeting", "occasion", "appointment"]],
  ["Task", "Something to do later.", ["todo", "reminder", "action"]],
];

const predicates: [string, string, Term["cardinality"], string[], string[], string[]][] = [
  ["name", "What someone or something is called.", "one", ANY, [], ["full_name", "called", "named", "is_called"]],
  ["lives_in", "Where someone lives.", "one", PEOPLE, ["Place"], ["based_in", "lives_at", "home", "resides_in"]],
  ["works_at", "Where someone works.", "one", PEOPLE, ["Organization"], ["employed_by", "works_for", "job_at"]],
  ["works_on", "What someone is working on.", "many", [...PEOPLE, "Organization"], ["Project", "Topic"], ["working_on", "building"]],
  ["knows", "Someone they know.", "many", PEOPLE, ["Person"], ["friend_of", "met", "friends_with"]],
  ["prefers", "Something they like or want.", "many", PEOPLE, [], ["likes", "favourite", "favorite", "wants", "enjoys"]],
  ["dislikes", "Something they avoid.", "many", PEOPLE, [], ["hates", "avoids"]],
  ["interested_in", "A subject they follow.", "many", PEOPLE, ["Topic", "Project"], ["interest", "into", "curious_about"]],
  ["diet", "What they eat or avoid eating.", "one", PEOPLE, [], ["eats", "dietary", "dietary_requirement"]],
  ["about", "What a task, event or topic concerns.", "many", ["Task", "Event", "Topic"], ANY, ["regarding", "for", "concerns", "related_to"]],
  ["due", "When a task should be done.", "one", ["Task"], [], ["deadline", "due_on", "due_by"]],
];

export const ONTOLOGY_DDL = `CREATE NODE TABLE IF NOT EXISTS Ontology(key STRING PRIMARY KEY, kind STRING, name STRING,
  description STRING, status STRING, cardinality STRING, subject_types STRING[], object_types STRING[], aliases STRING[],
  created_by STRING, created_at INT64, updated_at INT64)`;

const MERGE = `MERGE (o:Ontology {key: $key}) ON CREATE SET o.kind = $kind, o.name = $name, o.description = $description,
  o.status = $status, o.cardinality = $cardinality, o.subject_types = $subject_types, o.object_types = $object_types,
  o.aliases = $aliases, o.created_by = $by, o.created_at = $now, o.updated_at = $now`;

/** Adds the core terms that are missing; never overwrites an edited one. */
export async function seed(conn: Connection): Promise<void> {
  const merge = await conn.prepare(MERGE);
  const now = Date.now();
  const write = (t: Term) => conn.execute(merge, { key: `${t.kind}:${t.name}`, ...t, by: "seed", now });
  for (const [name, description, aliases] of entityTypes) {
    await write({ kind: "entity_type", name, description, status: "active", cardinality: "", subject_types: [], object_types: [], aliases });
  }
  for (const [name, description, cardinality, subject_types, object_types, aliases] of predicates) {
    await write({ kind: "predicate", name, description, status: "active", cardinality, subject_types, object_types, aliases });
  }
}

export const snake = (s: string) =>
  s.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const pascal = (s: string) => snake(s).split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

export type Resolved = { term: Term; given: string; proposed: boolean };

/** The name a new term of this kind would be stored under; "" when `given` has no letters or digits. */
export function termName(kind: Kind, given: string): string {
  return kind === "entity_type" ? pascal(given) : snake(given);
}

type Query = (cypher: string, params?: Record<string, any>) => Promise<Record<string, any>[]>;

/** The term a given name means: an exact name, else an alias, both compared as snake_case. */
export async function lookup(query: Query, kind: Kind, given: string): Promise<Term | undefined> {
  const key = snake(given);
  const rows = await query(
    `MATCH (o:Ontology) WHERE o.kind = $kind AND (lower(o.name) = $key OR list_contains(o.aliases, $key))
     RETURN o.kind AS kind, o.name AS name, o.description AS description, o.status AS status, o.cardinality AS cardinality,
            o.subject_types AS subject_types, o.object_types AS object_types, o.aliases AS aliases
     ORDER BY o.status, o.name LIMIT 1`,
    { kind, key: kind === "entity_type" ? key.replace(/_/g, "") : key },
  );
  return rows[0] as Term | undefined;
}

/**
 * As `lookup`, else a new `proposed` term, written now so the next use
 * finds it. `context` fills a proposed predicate's subject and object types.
 */
export async function resolve(
  query: Query, kind: Kind, given: string, by: string,
  context: { subject?: string; object?: string } = {},
): Promise<Resolved> {
  const found = await lookup(query, kind, given);
  if (found) return { term: found, given, proposed: false };
  const name = termName(kind, given);
  if (!name) throw new Error(`invalid_input: ${kind === "entity_type" ? "type" : "predicate"} ${JSON.stringify(given)} has no letters or digits`);
  const term: Term = kind === "entity_type"
    ? { kind, name, description: "", status: "proposed", cardinality: "", subject_types: [], object_types: [], aliases: [] }
    : { kind, name, description: "", status: "proposed", cardinality: "many",
        subject_types: context.subject ? [context.subject] : [], object_types: context.object ? [context.object] : [], aliases: [] };
  await query(MERGE, { key: `${kind}:${term.name}`, ...term, by, now: Date.now() });
  return { term, given, proposed: true };
}

/** A predicate's declared types, as a note when a fact does not fit them. */
export function fitNote(predicate: Term, subject: string, object?: string): string | undefined {
  const fits = (allowed: string[], type?: string) => !type || allowed.length === 0 || allowed.includes("*") || allowed.includes(type);
  if (predicate.status !== "active") return undefined;
  if (!fits(predicate.subject_types, subject)) return `${predicate.name} usually starts from ${predicate.subject_types.join(" or ")}, not ${subject}.`;
  if (!fits(predicate.object_types, object)) return `${predicate.name} usually points at ${predicate.object_types.join(" or ")}, not ${object}.`;
  return undefined;
}
