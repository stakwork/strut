/**
 * The Strut schema library — a TypeScript mirror of one jarvis schema library
 * (`schema_library.py` in jarvis-backend). Every node type strut writes to the
 * graph is declared here, and ONLY here: the node writer rejects any type not
 * in `STRUT_SCHEMAS`, any attribute not declared on its schema, and any edge
 * not in `STRUT_EDGES` (plan §6).
 *
 * Vocabulary (labels + edges) comes from the label registry in
 * `plans/generic-storage.md`; key/index choices from `jarvis-graph-compat.md`
 * §5. Do not invent labels — every one here was verified absent from jarvis's
 * own library.
 *
 * Attribute grammar (jarvis `_assert_is_valid_schema`):
 *   string | boolean | int | float | datetime | list, optionally `?`-prefixed
 *   for optional. `datetime` values are normalized to epoch SECONDS (int)
 *   before write. jarvis also knows `complex`; strut never uses it.
 */

export type AttrBase = "string" | "boolean" | "int" | "float" | "datetime" | "list";
export type AttrType = AttrBase | `?${AttrBase}`;

export interface StrutSchema {
  type: string;
  parent: "Thing";
  domain: "Strut";
  /** The key spec, `-`-joined: token 0 = type.lower(), then attribute
   *  names. A node's `key` is composed from it (`node-writer.ts`); Neo4j
   *  stores the spec as the Schema node's `node_key`. */
  key_spec: string;
  /** Compose the key from the HEX of each token's exact value instead of
   *  jarvis's sanitized form (`node-writer.ts` `keyToken`). The sanitizer
   *  strips every non-alphanumeric character, so without this `pod/test`,
   *  `pod-test`, `pod_test` and `podtest` are ONE node and the second name
   *  published lands on the first's (swarm38, 2026-10-07). Hex is
   *  alphanumeric — every other node_key rule holds — injective, and
   *  reversible. Strut's own rule, never flattened onto the Schema node:
   *  jarvis cannot recompute these keys from the spec and never needs to;
   *  strut is the only writer of its workspace types, and
   *  workspace-store.ts matches on the name attribute, never the key. */
  exact_key?: true;
  /** Fields that build `Data_Bank` (search text + `text_embeddings`), in
   *  declared order. Keep large payloads OUT of here. */
  index: string[];
  /** Fields that get their own `{stem}_embeddings` vector + per-label vector
   *  index (jarvis `vector_index`). Only the `input_q`/`output_q` search
   *  types declare this. */
  vector_index?: string[];
  /** `false`: nodes of this type get `Data_Bank` (keyword search) but never
   *  a `text_embeddings` vector — the execution records (`StrutToolCall`,
   *  `StrutTurn`) are too fine-grained to search by meaning, and the pass
   *  (`embeddings.ts`) removes any vector they hold. Strut's own rule for
   *  its own types, never flattened onto the Schema node: an older jarvis
   *  reads an unknown Schema key as a REQUIRED attribute and refuses every
   *  node of the type. jarvis-typed nodes carry the same mark on their
   *  Schema node, which the resolver reads (plans/semantic-search.md §4). */
  embed?: false;
  icon: string;
  shape: string;
  primary_color: string;
  secondary_color: string;
  title_key: string;
  description_key: string;
  type_description: string;
  attributes: Record<string, AttrType>;
}

/** One row of the edge registry: (source label, edge type, target label). */
export interface StrutEdgeDef {
  edge: string;
  source: string;
  target: string;
  /** Jarvis schema types outside the Strut domain that this edge points at
   *  (e.g. `Person`, `Thing`). Seeding skips the edge-schema row when the
   *  target Schema node is absent (standalone mode without that type). */
  note?: string;
  /** A row only a Ladybug file holds: the registry accepts it on either
   *  engine, but Neo4j's seed writes no edge schema for it. */
  ladybugOnly?: true;
}

// ── Constants shared with jarvis ────────────────────────────────────────────

export const STRUT_DOMAIN = "Strut";
export const STRUT_DOMAIN_LABEL = "Domain_strut";
export const THING_TYPE = "Thing";

/** Colour pair for every Strut type (one of jarvis's `get_color_pairs()`). */
const COLORS = { primary_color: "#1D3140", secondary_color: "#4FA7D9" };

/**
 * jarvis's root schema, verbatim (`default_schemas.py:11-33`). Seeded only in
 * standalone mode; a jarvis-seeded `Thing` is never touched. `name` sits at
 * the top level in jarvis's dict, so it flattens onto the node like an
 * attribute — every type inherits it.
 */
export const THING_SCHEMA = {
  type: "Thing",
  name: "string",
  key_spec: "thing-name",
  index: ["name", "description"],
  icon: "NodesIcon",
  shape: "sphere",
  primary_color: "#36292D",
  secondary_color: "#A96755",
  type_description:
    "The highest-level node in the ontology hierarchy, representing an abstract concept with no direct individual instances",
  title_key: "name",
  description_key: "description",
  attributes: {
    description: "?string",
    weight: "?float",
    is_muted: "?boolean",
    unique_source_id: "?string",
    image_url: "?string",
  } as Record<string, AttrType>,
} as const;

/** Attributes every type inherits from `Thing` (jarvis `get_schema` walks
 *  CHILD_OF and unions the parent's flattened keys). */
export const THING_INHERITED_ATTRIBUTES: Record<string, AttrType> = {
  name: "?string",
  ...THING_SCHEMA.attributes,
};

/** jarvis `USAGE_ATTRIBUTES` — never written by jarvis, read by its
 *  `?sort=usage` and search tiebreak. Strut owns updating them. */
export const USAGE_ATTRIBUTES: Record<string, AttrType> = {
  usage_count: "?int",
  usage_count_30d: "?int",
};

/** Properties jarvis stamps on every node, never declared as attributes and
 *  never accepted from a caller (`GENERIC_NODE_PROPERTIES` + the write-time
 *  system props). */
export const GENERIC_NODE_PROPERTIES = new Set([
  // The core attributes under their shared names (Neo4j stores them under
  // jarvis's, listed below too: `neo4j-engine.ts` maps between them).
  "key",
  "search_text",
  "created_at",
  "created_by",
  "Data_Bank",
  "namespace",
  "spelling_verification",
  "topic_lower",
  "ref_id",
  "node_key",
  "relevancy_score",
  "date_added_to_graph",
  "updated_at",
  "text_embeddings",
  "input_embeddings",
  "output_embeddings",
  "embeddings",
  "algo_page_rank",
  "algo_score",
  "algo_community_id",
  "algo_embedding",
  "_search_fields_used",
  "is_deleted",
]);

/** The core names a type outside strut may still declare as a field of its
 *  own: 15 jarvis types (Concept, PullRequest, Check, …) and an app on Neo4j
 *  declare `created_at`. Neo4j keeps the core stamp under
 *  `date_added_to_graph`, so there the two do not meet: the type's
 *  `created_at` stays its own (`neo4j-engine.ts`). `created_by` likewise:
 *  Neo4j stores no core one outside `OWN_CREATED_BY`. Ladybug holds one
 *  column of each, the core one, and refuses the declaration
 *  (`schema-crud.ts`). Strut's own types never declare them. */
export const TYPE_OWNABLE_CORE = new Set(["created_at", "created_by"]);

/** True when `name` is a core or system property a type may not declare
 *  as its own field. */
export function isGenericProperty(name: string): boolean {
  return GENERIC_NODE_PROPERTIES.has(name) && !TYPE_OWNABLE_CORE.has(name);
}

/** jarvis `SCHEMA_CORE_PROPERTIES` — top-level keys of a Schema node that
 *  are NOT attributes (everything else on the node is one). */
export const SCHEMA_CORE_PROPERTIES = new Set([
  "type", "parent", "attributes", "icon", "media_url", "source_link", "primary_color", "secondary_color",
  "shape", "index", "node_key", "key_spec", "conditional_formatting", "action", "type_description", "description",
  "display_name", "title_key", "description_key", "paid_properties", "domain", "vector_index", "volatility",
  "ref_id",
  // The no-embed mark (plans/semantic-search.md ruling 2): `embed: false`
  // on a Schema means its nodes keep their search text and never get a
  // `text_embeddings` vector. In this list so the resolver reads it as a
  // mark, not as an attribute named `embed` of type `false`.
  "embed",
  // The type's rules (plans/graph-memory-plan.md step 2, `SCHEMA_RULES` in
  // schema-crud.ts): what kind of thing it is, its identifiers, its key, and
  // an edge type's `temporal` / `cardinality`.
  "role",
  "identifiers",
  "key",
  "temporal",
  "cardinality",
]);

/** Attribute names a schema may not declare (jarvis reserved keys, plus the
 *  delete markers `deletion.ts` owns). */
export const RESERVED_ATTRIBUTE_NAMES = new Set(["type", "parent", "node_key", "key_spec", "index", "deleted_at", "deleted_at_backfilled", "deleted_reason"]);

/** Preview fields are capped so search/embedding text stays light; full
 *  payloads stay in the run/chat log behind `log_ref`. */
export const PREVIEW_MAX_CHARS = 500;

/** The one payload kept whole: a conversation turn's words — what was said
 *  and the reply (`StrutAgentSession.message` / `reply` on a turn of a
 *  thread, `StrutTurn.user_text` / `assistant_text`), so search reads what
 *  people said, not its first 500 characters. Past this (a pasted
 *  document) the start and the end are kept. Never tool traffic, system
 *  prompts or attachments. */
export const TEXT_MAX_CHARS = 50_000;

// ── The eleven Strut node types ──────────────────────────────────────────────
//
// Keys. The six WORKSPACE types — `StrutWorkflow`, `StrutWorkflowVersion`,
// `StrutStep`, `StrutStepVersion`, `StrutApp`, `StrutAppVersion` — are `exact_key`: `strutstep-<hex of the
// step type>`, `strutworkflowversion-<hex of the name>-<hex of the content
// hash>`, so two names never share a node (`exact-key-migration.ts` moves
// the nodes an older strut keyed on the sanitized name). The run/chat types
// keep jarvis's composition (`strutrun-<run id>`): the collision this guards
// against is between NAMES a person publishes, and the parity fixtures pin
// the sanitizer on them.

const base = {
  parent: "Thing",
  domain: "Strut",
  icon: "NodesIcon",
  shape: "sphere",
  ...COLORS,
} as const;

export const STRUT_SCHEMAS: readonly StrutSchema[] = [
  {
    ...base,
    type: "StrutWorkflow",
    key_spec: "strutworkflow-name",
    exact_key: true,
    index: ["name", "description"],
    title_key: "name",
    description_key: "description",
    type_description: "A strut workflow by name — the stable identity across versions",
    attributes: {
      name: "string",
      description: "?string",
      category: "?string",
      publisher: "?string",
      /** Content hash of the active version (mirrors `ACTIVE_VERSION`). */
      active_version: "?string",
      /** JSON-encoded `Automation[]` — the workflow's schedules
       *  (plans/automations.md §2). Workflow-level, like `category`. */
      automations: "?string",
      /** Opaque actor who owns the workflow — pays for its automations
       *  (plans/mothership-cost-control.md §2). */
      owner: "?string",
      /** Per-run LLM spend cap in dollars, enforced by the Mothership. */
      max_run_cost_usd: "?float",
      /** Disabled workflows refuse every run. */
      disabled: "?boolean",
      ...USAGE_ATTRIBUTES,
    },
  },
  {
    ...base,
    type: "StrutWorkflowVersion",
    key_spec: "strutworkflowversion-name-content_hash",
    exact_key: true,
    index: ["name", "description"],
    vector_index: ["input_schema", "output_schema"],
    title_key: "name",
    description_key: "description",
    type_description: "One content-hashed version of a strut workflow",
    attributes: {
      name: "string",
      content_hash: "string",
      version_label: "?string",
      description: "?string",
      /** When the version was published (epoch seconds, from disk). */
      published_at: "datetime",
      /** Full workflow source — deliberately NOT indexed. */
      source: "?string",
      input_schema: "?string",
      output_schema: "?string",
      params_json: "?string",
      publisher: "?string",
      /** Which door wrote the version (`WorkflowVersionInfo.source`). */
      version_source: "?string",
      actor: "?string",
      /** `Upstream`, JSON-encoded (marketplace.md §3). */
      upstream: "?string",
    },
  },
  {
    ...base,
    type: "StrutStep",
    key_spec: "strutstep-step_type",
    exact_key: true,
    index: ["step_type", "description"],
    vector_index: ["input_schema", "output_schema"],
    title_key: "step_type",
    description_key: "description",
    type_description: "A published strut step type (custom tier)",
    attributes: {
      step_type: "string",
      description: "?string",
      publisher: "?string",
      active_version: "?string",
      input_schema: "?string",
      output_schema: "?string",
      ...USAGE_ATTRIBUTES,
    },
  },
  {
    ...base,
    type: "StrutStepVersion",
    key_spec: "strutstepversion-step_type-content_hash",
    exact_key: true,
    index: ["step_type", "description"],
    title_key: "step_type",
    description_key: "description",
    type_description: "One version of a strut step's source",
    attributes: {
      step_type: "string",
      content_hash: "string",
      version_label: "?string",
      description: "?string",
      /** When the version was published (epoch seconds, from disk). */
      published_at: "datetime",
      /** Full step source — deliberately NOT indexed. */
      source: "?string",
      publisher: "?string",
      /** Which door wrote the version (`StepVersionInfo.source`). */
      version_source: "?string",
      actor: "?string",
      /** `Upstream`, JSON-encoded (marketplace.md §3). */
      upstream: "?string",
    },
  },
  {
    ...base,
    type: "StrutApp",
    key_spec: "strutapp-name",
    exact_key: true,
    index: ["name", "title", "description"],
    title_key: "title",
    description_key: "description",
    type_description: "A strut APP by name (plans/apps.md §1.3) — a front-end project over workflows, the stable identity across versions",
    attributes: {
      name: "string",
      /** The active version's manifest title and description, for search. */
      title: "?string",
      description: "?string",
      publisher: "?string",
      /** The owning actor (the first publish's), as `StrutWorkflow.owner`. */
      owner: "?string",
      /** Shown as a tab by a host (`AppMetadata.pinned`); absent = not pinned. */
      pinned: "?boolean",
      /** Tree hash of the active version (mirrors `ACTIVE_VERSION`). */
      active_version: "?string",
      /** The live release's id while the app is held (plans/app-releases.md §1). */
      live: "?string",
      /** JSON `AppRelease[]`: every release with its lock, oldest first. */
      releases: "?string",
    },
  },
  {
    ...base,
    type: "StrutAppVersion",
    key_spec: "strutappversion-name-content_hash",
    exact_key: true,
    index: ["name", "description"],
    title_key: "name",
    description_key: "description",
    type_description: "One tree-hashed version of a strut app: the manifest and the hash — never a file (the directory is under dataDir)",
    attributes: {
      name: "string",
      /** The TREE hash (`treeHash`, src/version.ts). */
      content_hash: "string",
      version_label: "?string",
      description: "?string",
      /** When the version was published (epoch seconds, from disk). */
      published_at: "datetime",
      /** The manifest (`app.yaml`), JSON-encoded. */
      manifest: "?string",
      publisher: "?string",
      version_source: "?string",
      actor: "?string",
      /** `Upstream`, JSON-encoded (marketplace.md §3). */
      upstream: "?string",
    },
  },
  {
    ...base,
    type: "StrutRun",
    key_spec: "strutrun-run_id",
    index: ["workflow_name", "run_status", "summary"],
    title_key: "workflow_name",
    description_key: "summary",
    type_description: "One strut workflow run — status, timings, params, and a pointer to its log",
    attributes: {
      run_id: "string",
      workflow_name: "string",
      /** success | error | cancelled | stale. NOT `status`: the reader (like
       *  jarvis) hides nodes whose `status` is error/failed/…, which would
       *  make every failed run invisible (run-status-migration.ts). */
      run_status: "string",
      summary: "?string",
      started_at: "datetime",
      finished_at: "?datetime",
      duration_ms: "?int",
      workflow_hash: "?string",
      params_json: "?string",
      input_preview: "?string",
      output_preview: "?string",
      error_message: "?string",
      /** Pointer into the raw run log (store-specific locator). */
      log_ref: "?string",
      /** The job the run was launched under (`run.start.job`,
       *  plans/jobs.md §1) — "everything in job X" is one match
       *  (plans/job-index.md §6). */
      job: "?string",
    },
  },
  {
    ...base,
    type: "StrutAgentSession",
    key_spec: "strutagentsession-run_id-path",
    // `message` + `reply` first: on a turn of a thread they hold the words
    // whole, and the embedding reads the start of the search text. A node
    // without them (a one-shot agent, an older turn) composes from the
    // previews as it always did.
    index: ["message", "reply", "prompt_preview", "result_preview"],
    title_key: "path",
    description_key: "prompt_preview",
    type_description: "One agent-step execution inside a strut run",
    attributes: {
      run_id: "string",
      path: "string",
      step_type: "?string",
      model: "?string",
      iteration: "?int",
      prompt_preview: "?string",
      result_preview: "?string",
      /** A turn of a thread only: the words it answered, whole (the agent
       *  step's `message`, else its `prompt`) — `TEXT_MAX_CHARS`. */
      message: "?string",
      /** A turn of a thread only: its reply, whole — a structured reply's
       *  `text`, else the result. */
      reply: "?string",
      started_at: "?datetime",
      duration_ms: "?int",
      error_message: "?string",
      log_ref: "?string",
      /** The thread this execution was a turn of — the agent step's
       *  `session` (plans/agent-sessions.md). Absent on a one-shot agent. */
      session_id: "?string",
      /** Its 0-based turn in that thread. Absent when the turn failed:
       *  nothing was committed, so it has no number. */
      session_turn: "?int",
      /** The run's job (plans/job-index.md §6): the thread's turns under a
       *  job are one match, whatever the thread's id. */
      job: "?string",
    },
  },
  {
    ...base,
    type: "StrutToolCall",
    key_spec: "struttoolcall-run_id-path-seq",
    index: ["tool_name", "input_preview"],
    embed: false,
    title_key: "tool_name",
    description_key: "input_preview",
    type_description: "One tool call inside a strut agent session",
    attributes: {
      run_id: "string",
      path: "string",
      seq: "int",
      tool_name: "string",
      input_preview: "?string",
      output_preview: "?string",
      started_at: "?datetime",
      duration_ms: "?int",
      error_message: "?string",
      log_ref: "?string",
    },
  },
  {
    ...base,
    type: "StrutChat",
    key_spec: "strutchat-chat_id",
    index: ["title", "summary"],
    title_key: "title",
    description_key: "summary",
    type_description: "A long-lived strut chat",
    attributes: {
      /** The builder chat's id, or the assistant conversation's session id. */
      chat_id: "string",
      /** `builder`: the workflow builder's chat, its turns `StrutTurn`s.
       *  `assistant`: a conversation with the assistant (src/conversations.ts),
       *  its turns the `StrutAgentSession`s of its runs. Absent on a builder
       *  chat projected before the field. */
      kind: "?string",
      title: "?string",
      summary: "?string",
      status: "?string",
      model: "?string",
      /** When the chat began (epoch seconds). */
      started_at: "datetime",
      last_active_at: "?datetime",
      turn_count: "?int",
      log_ref: "?string",
    },
  },
  {
    ...base,
    type: "StrutTurn",
    key_spec: "strutturn-chat_id-turn",
    index: ["user_text", "assistant_text", "user_text_preview"],
    embed: false,
    title_key: "user_text_preview",
    description_key: "assistant_text_preview",
    type_description: "One turn of a strut chat",
    attributes: {
      chat_id: "string",
      turn: "int",
      user_text_preview: "?string",
      assistant_text_preview: "?string",
      /** The user's message and the assistant's text in reply, whole —
       *  `TEXT_MAX_CHARS`. */
      user_text: "?string",
      assistant_text: "?string",
      started_at: "?datetime",
      log_ref: "?string",
    },
  },
  {
    ...base,
    type: "StrutJob",
    key_spec: "strutjob-job_id",
    // Ids may hold `/`, `.` and `-` (the session-id format): the sanitizer
    // would fold `abc/review` and `abc-review` into one node.
    exact_key: true,
    index: ["title", "summary"],
    title_key: "title",
    description_key: "summary",
    type_description: "A strut job — one directory and one history across many runs (plans/job-index.md §6)",
    attributes: {
      job_id: "string",
      /** The record's title, else the id. */
      title: "?string",
      /** The search text: each current deliverable as `title — summary`,
       *  then the latest reply, capped. Built by the projector from the
       *  job index's `get`; as fresh as the job's last finished run. */
      summary: "?string",
      /** When the job began (epoch seconds). */
      started_at: "datetime",
      /** The record's `usedAt`. (`updated_at` is a generic node property.) */
      last_used_at: "?datetime",
      run_count: "?int",
      artifact_count: "?int",
      /** The job id — `GET /jobs/:id` is the record. */
      log_ref: "?string",
    },
  },
  {
    ...base,
    type: "StrutArtifact",
    // IDENTITY (decision): one node per (job, artifact id). A job's artifact
    // ids are stable across turns ("the same id on a later run is a newer
    // version of the same thing", plans/jobs.md §3), so a later turn that
    // re-delivers `plan` UPDATES this node (title, summary, url, run_id move
    // to the newest version) instead of piling up one node per turn; the
    // history is the DELIVERED edges, one from each run that declared it.
    // Ids are only unique within a job, hence the job id in the key; both
    // tokens are hex-encoded (`exact_key`) as ids may hold `/`, `.`, `-`.
    key_spec: "strutartifact-job_id-artifact_id",
    exact_key: true,
    // `kind` and `label` are in the search text so "pull-request" / "url"
    // find artifacts by keyword and meaning; an exact filter is
    // `graph/find { type: StrutArtifact, where: { kind } }`.
    index: ["title", "summary", "kind", "label"],
    title_key: "title",
    description_key: "summary",
    type_description: "A deliverable a strut job turn declared (`artifacts` in the run output): the newest version of one artifact id of one job",
    attributes: {
      job_id: "string",
      /** The artifact's own id within the job. */
      artifact_id: "string",
      kind: "?string",
      label: "?string",
      title: "string",
      summary: "?string",
      /** The resolved link (`/jobs/<job>/files/…`, an app document, or the
       *  declared url). A deliverable another strut server holds is not
       *  projected here: its node is on that server's graph. */
      url: "?string",
      /** Relative to the job's directory, when the artifact is a file. */
      path: "?string",
      /** The run that delivered this (newest) version. */
      run_id: "?string",
      /** When that run started (the job record's line). */
      delivered_at: "?datetime",
    },
  },
  {
    ...base,
    type: "StrutProposal",
    // One per proposal (plans/proposals.md §2): a tool call a person approves
    // before it runs. A PROJECTION of `<dataDir>/proposals/<id>.json`, which
    // stays the record (the decision is written there under a lock) and what
    // every list reads; this node is for what points at a proposal — the run
    // that made it (`IN_RUN`), the nodes its apply wrote (`ACCESSED`) — and
    // for search. Written when the run ends and at each change. Never the
    // input: a payload, behind `GET /proposals/:id`. Ids are base64url, so
    // `-` and `_` matter: hex tokens (`exact_key`).
    key_spec: "strutproposal-proposal_id",
    exact_key: true,
    index: ["title", "rationale", "summary", "step"],
    title_key: "title",
    description_key: "rationale",
    type_description: "A tool call an agent proposed and a person accepts or rejects (plans/proposals.md): the step, why, and what was decided",
    attributes: {
      proposal_id: "string",
      /** The registry step type the proposal runs on accept. */
      step: "string",
      title: "string",
      /** pending | accepted | rejected | applied | failed. NOT `status`:
       *  the reader hides nodes whose `status` is failed (StrutRun's rule). */
      proposal_status: "string",
      /** The model's, for the person. */
      rationale: "?string",
      /** What the step read for the card (`describe`), capped. */
      summary: "?string",
      /** Who proposed it: the run's workflow, the run, its job and thread. */
      workflow_name: "?string",
      run_id: "?string",
      job_id: "?string",
      session_id: "?string",
      conversation_id: "?string",
      /** The proposing run's actor. */
      proposed_by: "?string",
      proposed_at: "datetime",
      decided_by: "?string",
      decided_at: "?datetime",
      /** A rejection's reason. */
      reason: "?string",
      /** A failed apply's error. */
      error_message: "?string",
      /** The record: `GET /proposals/:id`. */
      log_ref: "?string",
    },
  },
];

// ── Edge registry ───────────────────────────────────────────────────────────

/** Every (source, edge, target) strut may write. `ACCESSED` and
 *  `DERIVED_FROM` are declared against `Thing` — provenance may point at
 *  ANY node — and the writer accepts any target label for them (plan §6
 *  item 6). */
export const STRUT_EDGES: readonly StrutEdgeDef[] = [
  { edge: "VERSION_OF", source: "StrutWorkflowVersion", target: "StrutWorkflow" },
  { edge: "VERSION_OF", source: "StrutStepVersion", target: "StrutStep" },
  { edge: "ACTIVE_VERSION", source: "StrutWorkflow", target: "StrutWorkflowVersion" },
  { edge: "ACTIVE_VERSION", source: "StrutStep", target: "StrutStepVersion" },
  { edge: "USES_STEP", source: "StrutWorkflowVersion", target: "StrutStep" },
  { edge: "DEPENDS_ON", source: "StrutWorkflowVersion", target: "StrutWorkflow" },
  // Apps (plans/apps.md §1.3): a version's grants name the workflows it reads and launches.
  { edge: "VERSION_OF", source: "StrutAppVersion", target: "StrutApp" },
  { edge: "ACTIVE_VERSION", source: "StrutApp", target: "StrutAppVersion" },
  { edge: "USES_WORKFLOW", source: "StrutAppVersion", target: "StrutWorkflow" },
  { edge: "PUBLISHED_BY", source: "StrutStepVersion", target: "Person", note: "jarvis type; seeded only when Person exists" },
  { edge: "EXECUTED", source: "StrutRun", target: "StrutWorkflowVersion" },
  // Single-step runs (`run_step`), projected only when evidence attaches
  // (plans/claims.md §3).
  { edge: "EXECUTED", source: "StrutRun", target: "StrutStepVersion" },
  { edge: "PROMOTED_FROM", source: "StrutWorkflowVersion", target: "StrutRun" },
  { edge: "IN_RUN", source: "StrutAgentSession", target: "StrutRun" },
  { edge: "IN_SESSION", source: "StrutToolCall", target: "StrutAgentSession" },
  { edge: "SPAWNED", source: "StrutChat", target: "StrutRun" },
  { edge: "IN_CHAT", source: "StrutTurn", target: "StrutChat" },
  // A turn of an assistant conversation is its run's agent session.
  { edge: "IN_CHAT", source: "StrutAgentSession", target: "StrutChat" },
  { edge: "IN_JOB", source: "StrutRun", target: "StrutJob" },
  // Deliverables: the job holds the artifact (one node per job + id, newest
  // version); each run whose output declared it DELIVERED it.
  // A later `StrutArtifact -[:FOR_PR]-> PullRequest` (a jarvis type, so a
  // JARVIS_SOURCED_EDGES-style seeded row, not a registry row) fits here:
  // artifacts of kind "pull-request" carry the PR url, and the key is stable.
  { edge: "HAS_ARTIFACT", source: "StrutJob", target: "StrutArtifact" },
  { edge: "DELIVERED", source: "StrutRun", target: "StrutArtifact" },
  // What a work product was made from (`from` on the deliverable,
  // plans/work-products.md §2): the Concepts it follows, the excerpts it
  // quotes. jarvis's own name for "computed from" (ComputedFigure
  // -[:DERIVED_FROM]-> Excerpt), so one query reads both.
  { edge: "DERIVED_FROM", source: "StrutArtifact", target: "Thing", note: "any node" },
  // Proposals (plans/proposals.md §2): the run that made one, and each node
  // its apply wrote (`result.nodes`, what the step reported).
  { edge: "IN_RUN", source: "StrutProposal", target: "StrutRun" },
  { edge: "ACCESSED", source: "StrutProposal", target: "Thing", note: "any node" },
  { edge: "ACCESSED", source: "StrutToolCall", target: "Thing", note: "any node" },
  // What a run read, on a Ladybug file: it holds no tool calls, so the run
  // itself points at each node its steps reported (projector.ts). Neo4j
  // keeps the tool-call form above.
  { edge: "ACCESSED", source: "StrutRun", target: "Thing", note: "any node", ladybugOnly: true },
];

/**
 * Edges FROM a jarvis-owned type TO a Strut type — jarvis's `SENT` is
 * Person→Message/Email; these rows add `StrutAgentSession` as a target so
 * "who sent an orchestrator turn" can be written
 * (projector `writeSpeakerEdges`). The edge writer validates a non-Strut
 * source against the graph's own edge schemas, so these are SEEDED
 * (`seedStrutDomain`) rather than registry rows, and only when the source
 * type exists in the graph. If jarvis does not have the type (or strut did
 * not seed here, e.g. a jarvis-seeded graph strut cannot extend), the edge
 * schema has to be added in jarvis-backend or by a graph proposal; until
 * then the projector's write is refused and skipped.
 */
export const JARVIS_SOURCED_EDGES: readonly StrutEdgeDef[] = [
  { edge: "SENT", source: "HiveWorkspaceMember", target: "StrutAgentSession", note: "jarvis type; seeded only when HiveWorkspaceMember exists" },
  { edge: "SENT", source: "Person", target: "StrutAgentSession", note: "jarvis type; seeded only when Person exists" },
];

/** The Strut types whose own time had the name the core `created_at` now
 *  has, and the field it is under now (epoch seconds, as before). A Neo4j
 *  graph keeps it as the type's stored `created_at` (`neo4j-engine.ts`); a
 *  Ladybug file moved it once (`ladybug/db.ts`). */
export const OWN_CREATED_AT: Readonly<Record<string, "published_at" | "started_at">> = {
  StrutWorkflowVersion: "published_at",
  StrutStepVersion: "published_at",
  StrutAppVersion: "published_at",
  StrutChat: "started_at",
  StrutJob: "started_at",
};

/** The Strut types that declared their own `created_by` before it was a
 *  core attribute: who opened the chat, who launched the job. A Neo4j graph
 *  stores the core one on these types alone (as it stored their own), and
 *  no other node gets one there; a Ladybug file stores it on every node. */
export const OWN_CREATED_BY: ReadonlySet<string> = new Set(["StrutChat", "StrutJob"]);

/** Edge types whose declared target is a wildcard (any node label). */
export const WILDCARD_TARGET_EDGES = new Set(["ACCESSED", "DERIVED_FROM"]);

// ── Lookups ─────────────────────────────────────────────────────────────────

/** Labels jarvis strips when resolving a node's type from its label set
 *  (`resolve_node_type`): `Node`, `Data_Bank`, and every `Domain_*`. */
const STRUCTURAL_LABEL = /^(Node|Data_Bank|Domain_.*)$/;

/** The type label of a node: its labels minus the structural ones. */
export function typeLabelOf(labels: string[]): string | undefined {
  return labels.find((l) => !STRUCTURAL_LABEL.test(l));
}

/** The type a `Dialect.typeOf(alias)` column holds: Neo4j's label list
 *  (→ `typeLabelOf`), Ladybug's `node_type` string as it is. */
export function typeValue(v: unknown): string | undefined {
  return Array.isArray(v) ? typeLabelOf(v.map(String)) : typeof v === "string" ? v : undefined;
}

const BY_TYPE = new Map(STRUT_SCHEMAS.map((s) => [s.type, s]));

/** Exact-match lookup (jarvis resolves case-insensitively; we don't). */
export function getStrutSchema(type: string): StrutSchema | undefined {
  return BY_TYPE.get(type);
}

export function isStrutType(type: string): boolean {
  return BY_TYPE.has(type);
}

/** A schema's full attribute map: its own attributes + `Thing`'s. This is
 *  what jarvis's `get_schema` returns (minus the core keys), so it is what
 *  the validator checks payloads against. */
export function effectiveAttributes(schema: StrutSchema): Record<string, AttrType> {
  return { ...THING_INHERITED_ATTRIBUTES, ...schema.attributes };
}

export function isOptional(t: AttrType): boolean {
  return t.startsWith("?");
}

export function baseType(t: AttrType): AttrBase {
  return (isOptional(t) ? t.slice(1) : t) as AttrBase;
}

/** `input_schema` → `input`; anything else unchanged (jarvis `stem`). */
export function vectorStem(prop: string): string {
  return prop.endsWith("_schema") ? prop.slice(0, -"_schema".length) : prop;
}

/** `{stem}_embeddings` (jarvis `embedding_column`). */
export function embeddingColumn(prop: string): string {
  return `${vectorStem(prop)}_embeddings`;
}

/** `{label.lower()}_{stem}_vector_index` (jarvis `vector_index_name`). */
export function vectorIndexName(type: string, prop: string): string {
  return `${type.toLowerCase()}_${vectorStem(prop)}_vector_index`;
}

/** Node-key tokens after the type token. */
export function nodeKeyFields(schema: StrutSchema): string[] {
  return schema.key_spec.split("-").slice(1);
}

/**
 * Searchable attributes across the Strut library, per jarvis's tier-1 rule
 * for schemas with an explicit `index` (`get_searchable_attributes_from_schema`):
 * index fields + title_key + description_key. Used to build the domain
 * fulltext index (sorted, plus `node_key` appended by the seeder).
 */
export function searchableAttributes(schemas: readonly StrutSchema[] = STRUT_SCHEMAS): string[] {
  const out = new Set<string>();
  for (const s of schemas) {
    for (const f of s.index) out.add(f);
    out.add(s.title_key);
    out.add(s.description_key);
  }
  return [...out].sort();
}

/** (type, property) pairs that declare a per-property vector index. */
export function vectorIndexedPairs(
  schemas: readonly StrutSchema[] = STRUT_SCHEMAS,
): Array<{ type: string; prop: string }> {
  const out: Array<{ type: string; prop: string }> = [];
  for (const s of schemas) for (const p of s.vector_index ?? []) out.push({ type: s.type, prop: p });
  return out;
}

// ── Author-time validation ──────────────────────────────────────────────────

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const EDGE_TYPE = /^[A-Z][A-Z0-9_]*$/;
const ATTR_TYPES = new Set<string>(["string", "boolean", "int", "float", "datetime", "list"]);

/**
 * Structural checks on the library itself (mirrors jarvis `valid_node_key`
 * `schema_validation.py:311-338` + `_assert_is_valid_schema`, tightened):
 * bare-identifier attribute names, no reserved names, every node_key token
 * a REQUIRED attribute, index/vector_index/title/description fields
 * declared, edge types uppercase, edge endpoints known. Throws on the first
 * violation. Runs once at module load so a bad edit fails fast.
 */
export function assertLibraryWellFormed(
  schemas: readonly StrutSchema[] = STRUT_SCHEMAS,
  edges: readonly StrutEdgeDef[] = STRUT_EDGES,
): void {
  const types = new Set<string>();
  for (const s of schemas) {
    if (!IDENT.test(s.type)) throw new Error(`schema ${s.type}: type is not a bare identifier`);
    if (types.has(s.type)) throw new Error(`schema ${s.type}: duplicate type`);
    types.add(s.type);
    if (s.parent !== THING_TYPE) throw new Error(`schema ${s.type}: parent must be Thing`);
    if (s.domain !== STRUT_DOMAIN) throw new Error(`schema ${s.type}: domain must be Strut`);

    for (const [name, t] of Object.entries(s.attributes)) {
      if (!IDENT.test(name)) throw new Error(`schema ${s.type}: attribute "${name}" is not a bare identifier`);
      if (RESERVED_ATTRIBUTE_NAMES.has(name)) throw new Error(`schema ${s.type}: attribute "${name}" is reserved`);
      if (GENERIC_NODE_PROPERTIES.has(name)) throw new Error(`schema ${s.type}: attribute "${name}" is a generic node property`);
      if (!ATTR_TYPES.has(baseType(t))) throw new Error(`schema ${s.type}: attribute "${name}" has unknown type "${t}"`);
    }

    const tokens = s.key_spec.split("-");
    if (s.key_spec.startsWith("-") || s.key_spec.endsWith("-") || tokens.length < 2) {
      throw new Error(`schema ${s.type}: malformed key_spec "${s.key_spec}"`);
    }
    if (tokens[0] !== s.type.toLowerCase()) {
      throw new Error(`schema ${s.type}: key_spec must start with "${s.type.toLowerCase()}"`);
    }
    for (const tok of tokens.slice(1)) {
      const t = s.attributes[tok];
      if (!t) throw new Error(`schema ${s.type}: key_spec token "${tok}" is not a declared attribute`);
      if (isOptional(t)) throw new Error(`schema ${s.type}: key_spec token "${tok}" must be required`);
    }

    if ("title" in s.attributes && s.title_key !== "title") throw new Error(`schema ${s.type}: declares its own title, so its title_key must be "title"`);
    const declared = effectiveAttributes(s);
    if (s.index.length === 0) throw new Error(`schema ${s.type}: index must be non-empty`);
    for (const f of [...s.index, ...(s.vector_index ?? []), s.title_key, s.description_key]) {
      if (!declared[f]) throw new Error(`schema ${s.type}: field "${f}" is not a declared attribute`);
    }
    for (const f of s.vector_index ?? []) {
      if (baseType(declared[f]!) !== "string") throw new Error(`schema ${s.type}: vector_index field "${f}" must be a string`);
    }
  }

  for (const e of edges) {
    if (!EDGE_TYPE.test(e.edge)) throw new Error(`edge ${e.edge}: type must match ^[A-Z][A-Z0-9_]*$`);
    if (!types.has(e.source)) throw new Error(`edge ${e.edge}: source "${e.source}" is not a Strut type`);
    if (!types.has(e.target) && !e.note) {
      throw new Error(`edge ${e.edge}: target "${e.target}" is not a Strut type (add a note if it is a jarvis type)`);
    }
  }
}

assertLibraryWellFormed();
