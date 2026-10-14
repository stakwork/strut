// The memory's core vocabulary, seeded into the Ontology table on open
// (_ontology.ts `seed`). This file and the language data are the only
// non-test places a type or predicate is named: steps read behaviour
// (parent, naming, role) from the rows, never from a name.
import type { Term } from "./_ontology.js";

type Base = Pick<Term, "name" | "description" | "aliases"> & Partial<Term>;

// `previous`: the description an earlier seed wrote, replaced on open when a
// database still has it unedited.
type Seeded = Term & { previous?: string };

export const entityType = (t: Base & { previous?: string }): Seeded => ({
  kind: "entity_type", status: "active", cardinality: "", subject_types: [], object_types: [],
  parent: "", naming: "", role: "", ...t,
});
export const predicate = (t: Base & Pick<Term, "cardinality">): Term => ({
  kind: "predicate", status: "active", subject_types: [], object_types: [], parent: "", naming: "", role: "", ...t,
});

const ANY = ["*"];

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
  predicate({ name: "due", description: "When a task should be done.", cardinality: "one", subject_types: ["Task"], aliases: ["deadline", "due_on", "due_by"] }),
];
