/**
 * The types strut's own code writes beside its Strut bookkeeping, seeded on
 * BOTH engines (plans/ontology.md): the truth layer — `Claim`, `Check`,
 * `Evidence` (plans/claims.md) — and `Concept`, the Concepts the builder, the
 * job agent and the orchestrator read (`context/concept`), with the edge
 * rules between them and the Strut types.
 *
 * They keep jarvis's names and key specs, so a fresh graph's ids and keys
 * match a swarm's, but declare exactly the attributes strut writes and
 * reads (`claims.ts`'s field lists, `concept-seed.ts`). Every other type is
 * created at runtime (`graph/create-schema`, an app's `data.graph`, a
 * package).
 *
 *   - A Ladybug file seeds them at open with the rest of its ontology
 *     (`ladybug/registry.ts`), adding its own types on top (`Person`,
 *     `Lingo`, the record types).
 *   - Neo4j seeds each one at boot ONLY WHEN IT IS MISSING
 *     (`schema-seed.ts`), through `createNodeSchema`, the call an agent
 *     makes. On a swarm jarvis's own rows for these names are already
 *     there, and they are jarvis's: nothing is extended.
 *
 * Pure: no engine.
 */
import { CHECK_TYPE, CLAIM_TYPE, EVIDENCE_TYPE } from "./claims.js";
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

/** Claim, Check, Evidence, Concept. */
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
  seedType(CONCEPT_TYPE, "concept-name", ["name", "description", "docs"], "name", "description", {
    name: "string",
    description: "?string",
    docs: "?string",
    id: "?string",
    repo: "?string",
    file: "?string",
    pr_numbers: "?string",
    commit_shas: "?string",
    // The source stamp a seeded Concept carries (src/concept-seed.ts): whose
    // file it came from, and which version of it.
    unique_source_id: "?string",
    // Its other names, for `resolve` (`resolve.ts`): `aliases` is the
    // Schema rows' column.
    alt_names: "?list",
  }, { role: "concept" }),
];

/** The domain each seed type has on Neo4j: jarvis's, so a fresh graph's
 *  nodes carry the labels a swarm's do (`Domain_epistemic`,
 *  `Domain_general`). A Ladybug file's seed rows name no domain. */
export const SEED_DOMAINS: Readonly<Record<string, string>> = {
  [CLAIM_TYPE]: "Epistemic",
  [CHECK_TYPE]: "Epistemic",
  [EVIDENCE_TYPE]: "Epistemic",
  [CONCEPT_TYPE]: "General",
};

export interface SeedEdgeDef {
  edge: string;
  source: string;
  target: string;
}

/** Every (source, edge, target) the claim layer and the Concept tree
 *  write: a claim is about a workflow, a step or a job; its evidence about
 *  the version or the run it observed, with that as its source; checks
 *  test claims; claims and checks supersede their own kind. */
export const SEED_EDGES: readonly SeedEdgeDef[] = [
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutWorkflow" },
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutStep" },
  // A job's claim hangs off the job; its evidence is about the TURN — the
  // run (plans/job-claims.md §1–§2).
  { edge: "ABOUT", source: CLAIM_TYPE, target: "StrutJob" },
  // A claim about a Concept, and claims of one kind under a parent
  // claim (plans/dream.md, `concept-claims.ts`).
  { edge: "ABOUT", source: CLAIM_TYPE, target: CONCEPT_TYPE },
  { edge: "PARENT_OF", source: CLAIM_TYPE, target: CLAIM_TYPE },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutWorkflowVersion" },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutStepVersion" },
  { edge: "ABOUT", source: EVIDENCE_TYPE, target: "StrutRun" },
  { edge: "TESTS", source: CHECK_TYPE, target: CLAIM_TYPE },
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
  // concepts).
  { edge: "PARENT_OF", source: CONCEPT_TYPE, target: CONCEPT_TYPE },
];
