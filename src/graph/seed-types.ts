/**
 * The types strut's own code writes beside its Strut bookkeeping, seeded on
 * BOTH engines (plans/ontology.md): the truth layer — `Claim`, `Check`,
 * `Evidence` (plans/claims.md) — and `Concept`, the pages the builder, the
 * job agent and the orchestrator read (`context/concept`), with the edge
 * rules between them and the Strut types.
 *
 * They keep jarvis's names and key specs, so a fresh graph's ids and keys
 * match a swarm's, but declare exactly the attributes strut writes and
 * reads (`claims.ts`'s field lists, `concept-seed.ts`). Beside them,
 * dictation's vocabulary (`VOCABULARY_TYPES`: `Lingo`, `Mishearing`), strut's
 * own names. Every other type is created at runtime (`graph/create-schema`,
 * an app's `data.graph`, a package).
 *
 *   - A Ladybug file seeds them at open with the rest of its ontology
 *     (`ladybug/registry.ts`), adding its own types on top (`Person`, the
 *     record types).
 *   - Neo4j seeds each one at boot ONLY WHEN IT IS MISSING
 *     (`schema-seed.ts`), through `createNodeSchema`, the call an agent
 *     makes. On a swarm jarvis's own rows for these names are already
 *     there, and they are jarvis's: nothing is extended. A vocabulary type
 *     the graph holds already is extended only when it is dictation's
 *     (`notDictations`), and otherwise left as it is.
 *
 * Pure: no engine.
 */
import { CHECK_TYPE, CLAIM_TYPE, EVIDENCE_TYPE, TESTCASE_TYPE } from "./claims.js";
import type { NodeSchema } from "./schema-resolver.js";
import type { AttrType } from "./strut-schemas.js";

export const CONCEPT_TYPE = "Concept";

/** A seed type under `Thing`, as the resolver reports one. */
export const seedType = (
  type: string,
  key_spec: string,
  index: string[],
  title_key: string,
  description_key: string,
  attributes: Record<string, AttrType>,
  rules: Pick<NodeSchema, "role" | "identifiers"> = {},
): NodeSchema => ({
  type,
  parent: "Thing",
  key_spec,
  index,
  vector_index: [],
  embed: true,
  attributes,
  title_key,
  description_key,
  domainLabels: [],
  isStrut: false,
  ...rules,
});

/** Claim, Check, Evidence, TestCase, Concept. */
export const SEED_TYPES: readonly NodeSchema[] = [
  seedType(CLAIM_TYPE, "claim-id", ["name", "claim_text", "speaker_name"], "name", "claim_text", {
    id: "string",
    name: "?string",
    claim_text: "string",
    speaker_name: "?string",
    belief_valid_from: "?datetime",
    belief_valid_to: "?datetime",
  }, { role: "claim" }),
  seedType(CHECK_TYPE, "check-id", ["name", "description"], "name", "description", {
    id: "string",
    name: "?string",
    description: "?string",
    step_type: "?string",
    step_config: "?string",
    run_when: "?string",
    policy: "?string",
    freshness_days: "?int",
    sample_rate: "?float",
    publisher: "?string",
    // When it was written is the core `created_at` (claims.ts reads it).
    retired_at: "?datetime",
  }),
  seedType(EVIDENCE_TYPE, "evidence-id", ["name", "description", "content"], "name", "description", {
    id: "string",
    name: "?string",
    description: "?string",
    content: "?string",
    evidence_mode: "?string",
    evidence_status: "?string",
    observed_at: "?datetime",
  }),
  // One input to a workflow, shared by the claims it `TESTS` (src/trials.ts):
  // its id is a hash of the two, its name the line the Knowledge app shows.
  // Never embedded: a case is found from its claims, never by search.
  { ...seedType(TESTCASE_TYPE, "testcase-id", ["name"], "name", "name", {
    id: "string",
    name: "?string",
    case_workflow: "string",
    /** The workflow's input, as JSON. */
    case_input: "string",
  }), embed: false },
  seedType(CONCEPT_TYPE, "concept-name", ["name", "description", "docs"], "name", "description", {
    name: "string",
    description: "?string",
    docs: "?string",
    id: "?string",
    repo: "?string",
    file: "?string",
    pr_numbers: "?string",
    commit_shas: "?string",
    // The source stamp a seeded page carries (src/concept-seed.ts): whose
    // file it came from, and which version of it.
    unique_source_id: "?string",
    // Its other names, for `resolve` (`resolve.ts`): `aliases` is the
    // Schema rows' column.
    alt_names: "?list",
    // A read step whose items show under the page (`context/recent`,
    // plans/recent-work.md §2): a page under `Recent Work` names one.
    step: "?string",
  }, { role: "concept" }),
];

/** A word or phrase dictation learns (src/audio's fixer reads the type). */
export const LINGO_TYPE = "Lingo";
/** A mishearing dictation learned (src/steps/lib/dictation/_graph.ts): one
 *  hidden node per pair, saying dictation writes `value` for the node
 *  `entity_ref_id` (as `form`, null meaning its name). Undo and remove are
 *  soft deletes with the reason. Not searched, embedded or walked. */
export const MISHEARING_TYPE = "Mishearing";

// Dictation's vocabulary, the same on both engines: a Ladybug file seeds the
// two at open (`ladybug/registry.ts`), Neo4j at boot (`schema-seed.ts`). A
// Lingo word is keyed by its ref_id: a name key keeps only a-z and digits,
// so a word with no Latin letters (凯特) could not be one. `resolve` finds a
// word by its name or `alt_names`.
export const LINGO_SCHEMA: NodeSchema = seedType(LINGO_TYPE, "ref_id", ["name", "description"], "name", "description", {
  name: "string",
  description: "?string",
  alt_names: "?list",
}, { role: "entity" });
// Read by dictation alone, by `entity_ref_id`.
export const MISHEARING_SCHEMA: NodeSchema = { ...seedType(MISHEARING_TYPE, "ref_id", [], "value", "value", {
  entity_ref_id: "string",
  /** What dictation writes. */
  value: "string",
  /** The written form it is heard for; absent: the entity's name. */
  form: "?string",
}, { role: "record" }), embed: false };

/** Lingo, Mishearing. */
export const VOCABULARY_TYPES: readonly NodeSchema[] = [LINGO_SCHEMA, MISHEARING_SCHEMA];

/** Why the graph's type `held` is not dictation's `ours`, or null: another
 *  key, an attribute of ours it holds as another type, or one it requires
 *  that dictation never writes (an app's own `Lingo`, keyed by its name and
 *  requiring what the app saves). Such a type is never extended or written
 *  by dictation: half of each would be neither. */
export function notDictations(held: Pick<NodeSchema, "key_spec" | "attributes">, ours: NodeSchema): string | null {
  const base = (t: string) => t.replace(/^\?/, "");
  if (held.key_spec !== ours.key_spec) return `keyed by ${held.key_spec}, not ${ours.key_spec}`;
  for (const [k, t] of Object.entries(ours.attributes)) {
    const h = held.attributes[k];
    if (h && base(h) !== base(t)) return `${k} is a ${base(h)}, not a ${base(t)}`;
  }
  for (const [k, t] of Object.entries(held.attributes)) {
    if (!t.startsWith("?") && k !== "name" && !(k in ours.attributes)) return `it requires ${k}`;
  }
  return null;
}

/** The domain each seed type has on Neo4j: jarvis's, so a fresh graph's
 *  nodes carry the labels a swarm's do (`Domain_epistemic`,
 *  `Domain_general`). A Ladybug file's seed rows name no domain. */
export const SEED_DOMAINS: Readonly<Record<string, string>> = {
  [CLAIM_TYPE]: "Epistemic",
  [CHECK_TYPE]: "Epistemic",
  [EVIDENCE_TYPE]: "Epistemic",
  [TESTCASE_TYPE]: "Epistemic",
  [CONCEPT_TYPE]: "General",
};

export interface SeedEdgeDef {
  edge: string;
  source: string;
  target: string;
}

/** Every (source, edge, target) the claim layer and the Concept tree
 *  write: a claim is about a workflow, a step, a job or a Concept; its
 *  evidence about the version, the run or the Concept it observed, with the
 *  run or version as its source; checks test claims; claims and checks
 *  supersede their own kind. */
export const SEED_EDGES: readonly SeedEdgeDef[] = [
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutWorkflow" },
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutStep" },
  // A job's claim hangs off the job; its evidence is about the TURN — the
  // run (plans/job-claims.md §1–§2).
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutJob" },
  // A claim about a Concept is checked against every run that opened its
  // page; its evidence is about the Concept, at the version the run read
  // (claims.ts, concept-version.ts).
  { edge: "ABOUT", source: CLAIM_TYPE, target: CONCEPT_TYPE },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: CONCEPT_TYPE },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutWorkflowVersion" },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutStepVersion" },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutRun" },
  { edge: "TESTS", source: CHECK_TYPE, target: CLAIM_TYPE },
  { edge: "TESTS", source: TESTCASE_TYPE, target: CLAIM_TYPE },
  { edge: "EVIDENCED_BY", source: CLAIM_TYPE, target: EVIDENCE_TYPE },
  { edge: "PRODUCED_BY", source: EVIDENCE_TYPE, target: CHECK_TYPE },
  // A run check's evidence has the run as its source; a publish check's has
  // the version it read (verify.ts).
  { edge: "HAS_SOURCE", source: EVIDENCE_TYPE, target: "StrutRun" },
  { edge: "HAS_SOURCE", source: EVIDENCE_TYPE, target: "StrutWorkflowVersion" },
  { edge: "HAS_SOURCE", source: EVIDENCE_TYPE, target: "StrutStepVersion" },
  { edge: "SUPERSEDES", source: CLAIM_TYPE, target: CLAIM_TYPE },
  { edge: "SUPERSEDES", source: CHECK_TYPE, target: CHECK_TYPE },
  { edge: "CHILD_OF", source: CONCEPT_TYPE, target: CONCEPT_TYPE },
  // The tree as jarvis keeps it and every reader walks it — a parent points
  // at its children (graph/graph-get `children: "PARENT_OF"`, the seeded
  // pages).
  { edge: "PARENT_OF", source: CONCEPT_TYPE, target: CONCEPT_TYPE },
];
