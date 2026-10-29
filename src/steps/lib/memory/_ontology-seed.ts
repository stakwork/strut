// The memory's core vocabulary, seeded as Schema nodes of the workspace graph
// (_ontology.ts `seedMemoryOntology`). This file and the language data are the
// only non-test places a type or predicate is named: steps read behaviour
// (parent, naming, role) from the Schemas, never from a name.
import type { Term } from "./_ontology.js";

type Base = Pick<Term, "name" | "description" | "aliases"> & Partial<Term>;

// `previous` / `previousRole`: the description or role an earlier seed wrote,
// replaced on open when a database still has it unedited.
type Seeded = Term & { previous?: string; previousRole?: string };

export const entityType = (t: Base & { previous?: string; previousRole?: string }): Seeded => ({
  kind: "entity_type", status: "active", cardinality: "", subject_types: [], object_types: [],
  parent: "", naming: "", role: "", ...t,
});
export const predicate = (t: Base & Pick<Term, "cardinality">): Term => ({
  kind: "predicate", status: "active", subject_types: [], object_types: [], parent: "", naming: "", role: "", ...t,
});

const ANY = ["*"];

/** What every entity type inherits: the abstract MemoryEntity its types hang
 *  under (none is ever written as one). `memory_entity` marks a node of any
 *  of them, so a read finds every entity whatever its type (_db.ts `cypher`).
 *  `alias_keys` and `attributes_json` are an entity's aliases and attributes:
 *  a Schema row keeps its own `aliases` and `attributes`. */
export const ENTITY_BASE = "MemoryEntity";
export const FACT = "Fact";
export const EPISODE = "Episode";

/** The base types memory declares, attributes as columns (times are epoch ms). */
export const BASE_SCHEMAS: Array<Record<string, unknown>> = [
  {
    type: ENTITY_BASE, parent: "Thing", index: ["name", "summary"], title_key: "name", description_key: "summary",
    type_description: "Something long-term memory knows of: a person, place, organisation, topic, … (the base of memory's entity types).",
    memory_entity: "boolean", name: "string", summary: "?string", alias_keys: "?list", attributes_json: "?string",
    created_by: "?string", created_at: "int",
  },
  {
    type: FACT, parent: "Thing", index: ["text"], title_key: "text",
    type_description: "One sentence long-term memory holds about an entity: its predicate, SUBJECT and OBJECT edges, and when it held.",
    predicate: "string", text: "?string", confidence: "?float", valid_at: "?int", invalid_at: "?int", expired_at: "?int",
    value: "?string", form: "?string", created_by: "?string", created_at: "int",
  },
  {
    // Out of search by default (decision 10): transcripts would crowd it.
    type: EPISODE, parent: "Thing", index: ["content"], title_key: "content", embed: false,
    type_description: "What was said or observed, as said: the source of memory's facts.",
    kind: "?string", source: "?string", content: "?string", occurred_at: "?int", speaker: "?string",
    created_by: "?string", created_at: "int",
  },
];

/** The allowed edges between memory's nodes. OBJECT may also point at a
 *  workflow node or an app's (a cross edge, decision 9): remember adds the
 *  rule for that node's type the first time. */
export const EDGE_SCHEMAS: Array<{ source: string; edge: string; target: string }> = [
  { source: FACT, edge: "SUBJECT", target: ENTITY_BASE },
  { source: FACT, edge: "OBJECT", target: ENTITY_BASE },
  { source: EPISODE, edge: "MENTIONS", target: ENTITY_BASE },
  { source: FACT, edge: "FROM_EPISODE", target: EPISODE },
  { source: FACT, edge: "SUPERSEDES", target: FACT },
  { source: ENTITY_BASE, edge: "ALIAS_OF", target: ENTITY_BASE },
];

/** Every edge type memory writes: what memory/export carries. */
export const MEMORY_EDGES = [...new Set(EDGE_SCHEMAS.map((e) => e.edge))];

export const SEED: Seeded[] = [
  entityType({
    name: "Self",
    description: "The user: the person this memory belongs to. There is one: give it the user's name when known, and any of their names finds it.",
    aliases: ["me", "user", "myself"], parent: "Person", naming: "person", role: "user", previous: "The user. There is one.",
  }),
  entityType({ name: "Person", description: "Someone the user knows of.", aliases: ["people", "contact", "friend", "human"], naming: "person" }),
  entityType({
    name: "Organization", description: "A company, team, tribe or group.",
    aliases: ["org", "organisation", "company", "team", "group"], naming: "organisation",
  }),
  entityType({ name: "Place", description: "A city, address or venue.", aliases: ["location", "city", "venue"] }),
  entityType({ name: "Topic", description: "A subject, interest or idea.", aliases: ["subject", "interest", "idea"] }),
  entityType({ name: "Project", description: "A piece of work with a goal.", aliases: ["work", "initiative"] }),
  entityType({ name: "Event", description: "Something that happens at a time.", aliases: ["meeting", "occasion", "appointment"] }),
  entityType({
    name: "Task", description: "Something to do later: a thing the user means to do is a Task, with what it is about and when it is due.",
    aliases: ["todo", "reminder", "action"], previous: "Something to do later.",
  }),
  entityType({
    name: "Lingo",
    description: "A word or phrase the user uses that is not a person, place, organisation, project or topic: jargon, an acronym, a product or code word.",
    aliases: ["term", "jargon", "acronym", "word", "vocabulary"],
    // The type dictation makes a new word as; its words are taught to dictation (memory/lexicon's lingo_type).
    role: "dictation", previousRole: "",
  }),

  predicate({ name: "name", description: "What someone or something is called.", cardinality: "one", subject_types: ANY, aliases: ["full_name", "called", "named", "is_called"], role: "alias" }),
  predicate({ name: "lives_in", description: "Where someone lives.", cardinality: "one", subject_types: ["Person"], object_types: ["Place"], aliases: ["based_in", "lives_at", "home", "resides_in"] }),
  predicate({ name: "works_at", description: "Where someone works.", cardinality: "one", subject_types: ["Person"], object_types: ["Organization"], aliases: ["employed_by", "works_for", "job_at"] }),
  predicate({ name: "works_on", description: "What someone is working on.", cardinality: "many", subject_types: ["Person", "Organization"], object_types: ["Project", "Topic"], aliases: ["working_on", "building"] }),
  predicate({ name: "knows", description: "Someone they know.", cardinality: "many", subject_types: ["Person"], object_types: ["Person"], aliases: ["friend_of", "met", "friends_with"] }),
  predicate({ name: "prefers", description: "Something they like or want.", cardinality: "many", subject_types: ["Person"], aliases: ["likes", "favourite", "favorite", "wants", "enjoys"] }),
  predicate({ name: "dislikes", description: "Something they avoid.", cardinality: "many", subject_types: ["Person"], aliases: ["hates", "avoids"] }),
  predicate({ name: "interested_in", description: "A subject they follow.", cardinality: "many", subject_types: ["Person"], object_types: ["Topic", "Project"], aliases: ["interest", "into", "curious_about"] }),
  predicate({ name: "diet", description: "What they eat or avoid eating.", cardinality: "one", subject_types: ["Person"], aliases: ["eats", "dietary", "dietary_requirement"] }),
  predicate({ name: "about", description: "What a task, event or topic concerns.", cardinality: "many", subject_types: ["Task", "Event", "Topic"], object_types: ANY, aliases: ["regarding", "for", "concerns", "related_to"] }),
  // The wrong text is the fact's value, never an alias: a misrecognition must not find or merge anything.
  predicate({
    name: "heard_as", description: "How dictation mishears this: the wrong text it writes for it.", cardinality: "many",
    subject_types: ANY, aliases: ["misheard_as", "transcribed_as"], role: "mishearing",
  }),
  predicate({ name: "due", description: "When a task should be done.", cardinality: "one", subject_types: ["Task"], aliases: ["deadline", "due_on", "due_by"] }),
];
