# Claims, checks and evidence — the truth layer

A step or workflow states how it SHOULD behave. Every execution produces
evidence for or against those statements. Status is computed from the
evidence, never asserted. The engine enforces it at publish and run time;
the prompt only explains it.

Three nodes: a **`Claim`** is the statement, a **`Check`** is an instrument
that can test it, **`Evidence`** is what one test observed.

Companion to `specs/EVAL_SPEC.md` (a score is one kind of evidence) and
`specs/EVOLVE_SPEC.md` (the "capture" beat: a failure becomes a claim with a
check, so it cannot regress silently). Graph vocabulary is jarvis's
epistemic layer (`jarvis-backend/docs/epistemic_layer.md`, migrations
119/120/124/125). This plan adds two things that layer deferred — the
`Check` node (125) and the workflow that produces evidence — plus a minimal
status rule.
The template layer and a stored verdict stay deferred (§7).

## Problem

The builder assistant does not inspect its own work. "Done" means the last
`run_workflow` returned `success`. The `youtube-clip` transcript
(`workspace/chats/mu4h075f-6wzpvp`) is the pattern:

- Four runs. Two failures (a 429 on auto-translated captions; an invented
  `--ignore-no-subtitles` flag), each fixed as it surfaced. Then success.
- After success the assistant ran `ffprobe` and read the transcript. It
  wanted to verify, but had no target and no record, so it checked the
  duration and never checked the one thing the user cares about: that the
  clip's audio contains the located moment.
- Every attempt surfaces a different problem because nothing forces
  coverage (only the one input the assistant tried), nothing is recorded
  (the next session re-discovers), and nothing detects drift (yt-dlp
  updates; the old evidence silently stops meaning anything).

Telling the assistant "state claims and post evidence" is not a fix: an
instruction can be rationalized past, and the producer grading itself is
the failure mode EVOLVE_SPEC §6 already forbids for graders.

## What already exists

| Where | Has | Lacks |
| --- | --- | --- |
| jarvis (migrations 119/120/124, + 125 in review) | `Claim` — since 124 keyed on a caller-supplied `id` (`claim-id`), `speaker_name` optional, `claim_text` not paid, so a claim nobody "said" is writable; bitemporal `belief_valid_from/to`; claim-to-claim pairs `SUPERSEDES`, `PARENT_OF`, `DERIVED_FROM`. `Evidence` (Epistemic domain: `content`, `evidence_mode` observed\|asserted, `evidence_status` planned\|collected, `observed_at`). Pairs `Claim —EVIDENCED_BY {strength −1..1}→ Evidence`, `Evidence —HAS_SOURCE {authority_level, locators}→ Thing` | anything that produces or scores evidence; a template layer — both named as deferred in its doc. (The `Check` node it also deferred is migration 125, written for this plan) |
| hive | evals as graph nodes (`EvalRequirement` → `EvalTriggerOutput`), one LLM judge, "not evaluated is never a fail", `evaluates: workflow\|output` | any observed evidence; any link from feature requirements to evals |
| strut | versioned steps/workflows, persisted runs, `exec`/`agent`/`llm` steps, per-run artifacts, cassettes, the post-hoc projector, `SchemaResolver` (the node writer already accepts any type whose `:Schema` exists in the DB) | any notion of a claim; `run_step` runs are not persisted |

Nothing in the node model below is strut-specific. A claim can be about any
node and evidence can come from any source (a CI run, a person, a strut
run). Strut is the first producer: the one that can execute an arbitrary
check. The Hive eval chain is out of scope here.

## Design

One new node type (`Check`), two reused (`Claim`, `Evidence`), a handful of
edge pairs, two tool changes, one post-run pass.
Requires the graph backend: on `STRUT_WORKSPACE_BACKEND=fs` none of the
claim tools are offered and the verify pass is a no-op.

### Nodes

**`Claim`** — jarvis's type, unchanged after migration 124 (`Epistemic`
domain, Thing-parented, node_key `claim-id`). One plain-English sentence about how a subject should
behave. Strut writes:

| attribute | type | strut writes |
| --- | --- | --- |
| `id` | string | its own identity — never derived from the text. **Lowercase alphanumerics only** (`randomUUID()` with the dashes stripped): `node_key` is `claim-<id>` after jarvis's sanitizer lowercases and drops every non-alphanumeric, so `aB-1` and `ab1` would collide. Same rule for `Check.id` and `Evidence.id` |
| `name` | string | the sentence, bounded (jarvis's required title) |
| `claim_text` | string | the sentence. Behavior, not mechanism; never the output schema restated |
| `speaker_name` | ?string | who asserts it: `ai`, a person, a seeder. This IS strut's `publisher` stamp (fixed point 1, §4.1). Later a `Person —MADE_CLAIM→ Claim` edge (existing pair) |
| `belief_valid_from` | ?datetime | when this node began to hold |
| `belief_valid_to` | ?datetime | when it stopped: retired, or superseded by an edit. **Active = unset.** There is no `status` attribute (`status` is a jarvis reserved name); never deleted, history stays |

Left unset in v1: `answer_volatility` (open question), `polarity`,
`derivation`, `valid_from/to`, and the scorer outputs `verdict` /
`confidence_score` / `assessed_at` — strut computes status on read and per
subject, which one stored verdict cannot express.

**`Check`** (new; Thing-parented, `Epistemic` domain, node_key `check-id`).
One instrument that can test one claim: an executable strut step, or a
named question for someone outside strut.

| attribute | type | meaning |
| --- | --- | --- |
| `id` | string | identity |
| `name` | string | short label ("stt fuzzy-match", "bare-answer lint"); defaults to `step_type` |
| `description` | ?string | what it observes. REQUIRED on an external check: what to look at, and why code cannot |
| `step_type` | ?string | a registry step type (`exec`, `agent`, `llm`, a custom step, or `subflow` — a whole workflow, §4). **Absent = an external check**: answered by a person or an outside system through a planned slot (§4.2) |
| `step_config` | ?string | JSON config for that step; the subject is the check's `input` (§4), so it reads `{{ input.output.quote }}` — no new template root |
| `run_when` | ?string | `run` (default) or `publish` — Hive's `evaluates` split |
| `policy` | ?string | `always` \| `on_change` \| `sample` \| `manual` — when a `run` check fires (§4.1). Default: `always` for code checks, `on_change` for checks presumed paid (an `agent`/`llm` step anywhere in the check closure, §4) and for external checks, where it paces the planned slot (a person's time is the cost) |
| `freshness_days` | ?int | for `on_change`: re-run when the latest evidence is older than this (default 7) — catches environment drift the version pointer cannot see |
| `sample_rate` | ?float | for `sample`: fraction of runs |
| `publisher` | ?string | who wrote it (`ai`, a person, a seeder) — fixed points 1–2 |
| `created_at` | datetime | when this node began to hold |
| `retired_at` | ?datetime | when it stopped: retired, or superseded by an edit. Active = unset |

Why a node and not attributes on the claim: a claim can have SEVERAL checks
(a free `exec` on every run, an `llm` judge on change, a person's ear once
per version), each with its own policy, cost and evidence stream; and a
check can be replaced without touching the statement. Every claim strut
writes has at least one check — an external check is how "this cannot be
checked by code" is said, with its reason in `description`.

**Both are immutable once they have evidence**, separately:

- Editing a check (`step_type`, `step_config`, `run_when`, policy fields)
  creates a NEW `Check` that `SUPERSEDES` the old one, takes over its
  `TESTS` edge, and retires the old node. Evidence produced by a retired
  check stays in the graph and never counts toward status again — a changed
  instrument has measured nothing yet.
- Editing a claim's `claim_text` creates a NEW `Claim` that `SUPERSEDES` the
  old one (existing jarvis pair), carries its `ABOUT` attachments AND its
  active checks across (each check gains a `TESTS` edge to the successor —
  an instrument is not a statement, so it is not cloned), and closes the old
  node's `belief_valid_to`. Old evidence stays on the old node; the
  successor starts `unknown`, and `verify_run` over kept runs repopulates it.

This is the attribution rule EVOLVE_SPEC §6 applies to graders
(`scorerSha256`). A typo fix pays the same price; that is the cost of one
rule. At any time a check tests exactly ONE active claim.

**Claims are NOT versioned with workflow versions.** They attach to the
stable identity and apply to whatever version is active when a run is
verified; the version dimension lives on the evidence (`Evidence —ABOUT→
version`). "What was the contract for v2 at the time" is bitemporal: the
claims whose `[belief_valid_from, belief_valid_to)` window covers v2's
evidence.

**`Evidence`** — jarvis's type, unchanged (node_key `evidence-id`; `name`
is its one required attribute besides `id`). `name` = the claim's text,
bounded. `content` = what was observed (one bounded string;
`PREVIEW_MAX_CHARS` discipline). `evidence_mode` = `observed` when code or
an instrument produced it, `asserted` when a model or a person vouched.
`evidence_status` = `collected` for everything a check or `add_evidence`
writes, and `planned` for an OPEN SLOT: a named question with no `content`
yet, waiting on a person or an outside system (§4.2). Anything that reads
evidence to decide something — status, `on_change`, staleness — reads
`collected` only.

### Edges (one new edge type, `ABOUT`; the rest exist or are new pairs of existing types)

| pair | jarvis | carries |
| --- | --- | --- |
| `Claim` —`ABOUT`→ `StrutStep` / `StrutWorkflow` | **new type** | the STABLE identity, never a version. **Many-to-many**: one claim may be about several subjects (a contract every candidate in a lineage must meet; a timestamp rule shared by two steps), and a subject has many claims. `ABOUT` is minted because a claim can be about any node (a feature, a repository, a concept); no existing edge type reads that way |
| `Evidence` —`ABOUT`→ `StrutWorkflowVersion` / `StrutStepVersion` | new pair | the exact version the observation was made on. Written by whoever writes the evidence; this is what makes status per (claim, subject) a direct lookup, including for nested subflow executions and single-step runs |
| `Check` —`TESTS`→ `Claim` | new pair (`TESTS` exists: codegraph `Test → Function`) | a claim has 1..n checks; a check tests one active claim |
| `Claim` —`EVIDENCED_BY {strength}`→ `Evidence` | exists (119) | `+1` supports, `−1` refutes |
| `Evidence` —`PRODUCED_BY`→ `Check` | new pair (`PRODUCED_BY` exists) | which instrument produced it. Absent on evidence no check produced: `add_evidence` with no slot, an outside system writing directly |
| `Evidence` —`HAS_SOURCE {context, start_time, end_time, post_url}`→ `StrutRun` | exists (`→ Thing`) | provenance: the run and, in `context`, the step's event path (`wf/compute_times`) and the cassette mode; time span / url when the check has one. `context` is ONE `?string` in jarvis's schema, so strut writes it as a small JSON object (`{ path, cassette, checkVersion?, model?, by? }`) — every "`context` names …" below is a key of that object |
| `Claim` —`SUPERSEDES`→ `Claim` | exists | an edit: the successor points at the node it replaced |
| `Check` —`SUPERSEDES`→ `Check` | new pair | same, for a check |
| `StrutRun` —`EXECUTED`→ `StrutStepVersion` | strut-side | new pair for single-step runs (§3) |
| `Claim` —`PARENT_OF` / `DERIVED_FROM`→ `Claim` | exist (119) | **unused in v1.** A compound claim → its parts; a calculated claim → its inputs. No v1 tool writes them, the status rule ignores them, nothing rolls up (§7) |

A claim is a statement; a subject is something it is claimed of.
Evidence is always about ONE version of ONE subject, so the same claim
attached to five workflows has five independent statuses. "Which versions
satisfy this" is one hop from the evidence; a version that breaks a claim
shows as refuting evidence on that version.

### Status is computed on read, per (claim, subject) (`src/graph/claims.ts`)

```
streams := one per ACTIVE check that TESTS this claim, plus one for evidence
           with no PRODUCED_BY edge (add_evidence, an outside system)
latest(stream) := that stream's newest COLLECTED evidence on THIS claim node
           ABOUT any version of THIS subject. Never counted: a superseded
           claim's evidence (the ledger shows the predecessor's last status
           beside it), a retired check's evidence, a `planned` slot (a
           question, not evidence)

any latest is ABOUT the active version and refutes    → refuted
else any latest is ABOUT the active version, supports → supported
else any latest exists (all about older versions)     → stale
else                                                  → unknown
plus: assertedOnly = no counted evidence has evidence_mode = observed
plus: unverified   = active checks with no evidence ABOUT the active version
plus: openSlot     = a planned Evidence exists for this (claim, subject)
```

A refutation on the current version always wins, so a second check can
never paper over a failing one. With one check this is the obvious rule:
latest evidence, `stale` once the version moves on. One pure function over
`(claim, checks[], subject, evidence[], activeVersion)`. No verdict is ever
stored on the node. jarvis's richer scorer (source authority, independence,
`answer_volatility` decay) can replace this function later without touching
the nodes.

## 1. Schema registration

- **jarvis, migration 124 — merged** (`ontology_124_claim_flexible_identity`,
  stakwork/jarvis-backend#3121; upstream took 123 for an unrelated index):
  `Claim` re-keyed on `id`, `speaker_name` optional, `paid_properties`
  emptied to `[]`, re-homed from `Content` to the `Epistemic` domain
  (Thing-parented, beside `Evidence`), old Claim nodes deleted. Deploy note: every Claim writer must now
  send `id` (the podcast claim-extraction workflows included).
- **jarvis, migration 125 — PR open** (`ontology_125_check_node`,
  stakwork/jarvis-backend#3122)**:** seeds the `Check` node and the five new pairs
  in the table above — `Claim —ABOUT→ Thing`, `Evidence —ABOUT→ Thing`,
  `Check —TESTS→ Claim`, `Evidence —PRODUCED_BY→ Check`, `Check —SUPERSEDES→
  Check` — same shape as `ontology_119`, definitions read live from
  `get_epistemic_schema_library()` / `get_epistemic_schema_edges()`.
  Everything else (`EVIDENCED_BY`, `HAS_SOURCE`, `Claim → Claim`
  `SUPERSEDES` / `PARENT_OF` / `DERIVED_FROM`) is already seeded.
  `Check.created_at` is REQUIRED — a create without it is a 400 — so
  strut's writer must always stamp it.
- **Standalone strut Neo4j:** the bundled ontology fixture
  (`src/graph/fixtures/jarvis-ontology.ts`) is a dump that PREDATES 119: its
  `Claim` is still `claim-claim_text-speaker_name` and it has no `Evidence`.
  Re-dump it from a post-125 jarvis (preferred — the fixture's own source,
  the local `sphinxlightning/sphinx-neo4j` default seed, already has 124 and
  125 applied), or hand-add the new `Claim` shape, `Evidence`, `Check` and
  the pairs, so `ontology-seed.ts` creates them; `graph/create-schema` is the
  by-hand fallback.
- **Standalone DBs that are ALREADY seeded need more than the fixture.**
  `seedJarvisOntology` is add-only ("every schema already exists → nothing
  written"), so a re-dump adds `Evidence`, `Check` and the new pairs but
  leaves an existing `Claim` schema at `claim-claim_text-speaker_name` with a
  required `speaker_name` — and strut's own `validateNode` then rejects every
  claim this plan writes (`MISSING_REQUIRED`). Add a one-shot boot pass in
  `vein-migration.ts`'s mould (`src/graph/claim-schema-upgrade.ts`, stamped in
  the `Migration` ledger, run in `backend.ts` BEFORE `seedJarvisOntology`):
  when the live `Claim` schema's `node_key` is not `claim-id`, DETACH DELETE
  the `:Claim` nodes (none are expected on a strut DB — nothing wrote them)
  and SET the schema to the fixture's shape (`node_key`, `id`,
  `speaker_name: ?string`, `paid_properties: []`, `domain: Epistemic`,
  `parent: Thing` + the `CHILD_OF` edge moved). A mirror of jarvis 124, and a
  no-op on a jarvis-hosted graph, where 124 already ran.
- **Strut code:** `src/graph/claims.ts` — attribute names, the
  subject-input contract, `claimStatus()`, and read helpers
  (`claimsFor(subject)`, `checksFor(claim)`, `evidenceFor(claim)`). Writes
  go through the existing node/edge writers: `SchemaResolver` resolves
  `Claim` / `Check` / `Evidence` and their edge pairs from the DB
  (`edge-writer.ts` already falls back to `resolver.edgeSchema` for
  non-Strut endpoints). The ONE change to `strut-schemas.ts` is the new
  Strut-to-Strut row `StrutRun —EXECUTED→ StrutStepVersion`, because
  Strut-to-Strut edges go through the closed `STRUT_EDGES` registry;
  `schema-seed.ts` seeds it like the other rows.

## 2. Authoring

Claims and checks are graph nodes with their own tools. Two doors onto one
write.

**Door one — alongside the code.** `create_step`, `edit_step`,
`create_workflow`, `edit_workflow` (`src/ai/tools.ts`, shared core in
`src/authoring.ts`) take
`claims?: Array<{ text, checks: Array<CheckSpec> }>`, where a `CheckSpec` is
`{ type, config, name?, when?, policy?, freshnessDays?, sampleRate? }` for a
step check (→ `step_type`, `step_config`, `run_when`, `policy`,
`freshness_days`, `sample_rate`), or `{ description, name? }` alone for an
external check. Publish writes each as a `Claim` + `ABOUT` the published
subject + one `Check —TESTS→` it per spec.

**The arg only ever ADDS.** `edit_step` / `edit_workflow` are called many
times on one subject, so the arg cannot mean "the full set": a claim whose
`text` exactly matches an ACTIVE claim already `ABOUT` that subject is
skipped (a republish with the same arg is a no-op, reported as
`claims: { added, existing }`), anything else is added. It never edits,
retires or detaches — rewording goes through `edit_claim`, removal through
`retire_claim`, so a careless republish cannot drop a contract line or fork
its evidence.
The publish result gains `claims: <count>`; zero returns a warning the
assistant has to answer. Editing a claim or a check never publishes a
workflow version; it supersedes the node instead.

**Door two — on their own.** On any subject ref:

- claims: `add_claim(subjects, text, checks)` (one or MORE subjects, at
  least one check), `edit_claim(id, text)`, `retire_claim(id)`,
  `list_claims(subject)` (each claim with its checks),
  `attach_claim(id, subject)` / `detach_claim(id, subject)` — attaching is
  how a contract is shared, never by copying the node;
- checks: `add_check(claim, spec)`, `edit_check(id, …)`,
  `retire_check(id)`. Retiring a claim's LAST active check is refused: add
  the replacement first, or retire the claim.

`edit_claim` and `edit_check` return the SUCCESSOR's id (supersession,
above); only attachments and the retired timestamps change in place. This
door is what makes it general: an existing workflow without republishing,
an in-workflow authoring agent, a person in the UI, Hive's planning phase on
a feature.

**`meta/*` twins.** Door one's `claims` arg reaches `meta/create-step`,
`meta/edit-step` and `meta/publish-workflow` through the shared core. Door
two's tools do NOT come free — `meta/*` steps are hand-written, one file per
tool (`src/steps/lib/meta/`) — so each gets a twin: `meta/add-claim`,
`meta/edit-claim`, `meta/retire-claim`, `meta/list-claims`,
`meta/attach-claim`, `meta/detach-claim`, `meta/add-check`,
`meta/edit-check`, `meta/retire-check`, all under the publisher scoping of
§4.1 (fixed point 1). This is what lets an in-workflow author
(`agentTools: ["meta/*"]`) make the regression move (prompt rule 4) on a
subject it is not republishing.

**Prompt rules** (`src/ai/prompts.ts`, one short section):

1. Author claims BEFORE the first run, in the same turn as the code.
2. Behavior, not mechanism. Never the output schema restated.
3. Every claim gets at least one check. If code cannot check it, give it an
   external check whose `description` says what to look at and why.
4. A failure you fix becomes a claim with a check (the regression move —
   the 429 becomes "fetches only the requested caption languages").
5. A workflow is not done while any claim is `unknown` or `refuted`, and
   asserted-only evidence is called out to the user.
6. An open slot (§4.2) is a question. Answer it only with something you
   observed with a tool, and say what; otherwise relay it to the user —
   what to look at, and where — and end the turn. A claim that is waiting on
   a person does not keep you looping: the work is "done, not yet
   verified", and you say which lines are waiting.

**UI:** a Claims panel in `StepEditFlyout` and the workflow view — text,
status badge, latest evidence, the checks under each claim,
add/edit/retire. Can land after the tools.

## 3. Single-step runs persist — in their own bucket, only when they matter

`run_step` (`src/run-step.ts`) runs in a throwaway `MemoryRunStore` and
returns the output directly. That is the assistant's cheapest loop and
exactly where step claims get tested, so a run that can become evidence
must leave a record. Three rules keep that from becoming noise:

- **Runs belong to a subject, and listings are per subject.** Every
  `RunStore` read (`listRuns`, `search_runs`, `GET /workflows/:name/runs`,
  the projector's `workflows: []`) already takes one name; there is no
  global run list. Step runs are stored under the `RunStore` key
  `step:<type>` — a store key, never a workflow — which `FileRunStore` maps
  to `steps/<type>/runs/<runId>/`, NOT `workflows/…` (a type like
  `clip/compute-times` nests as `steps/clip/compute-times/runs/`).
  `FileRunStore.runDir` interpolates its key verbatim today — nothing is
  sanitized — so the `step:` prefix is parsed in `runDir`, never written to
  disk, and `<type>` is safe as a path because `workspace.ts` already
  validates step names against its name regex. `MemoryRunStore`
  mirrors it. `listWorkflows` never sees them; a workflow's `list_runs` /
  `search_runs` are untouched by construction. A step's runs are read by
  asking for that key (`list_runs("step:<type>")`, and `get_step` gains a
  `recentRuns` count).
- **Persist only what can become evidence.** `run_step` runs in memory
  exactly as today, then — when the step has at least one active claim, or
  the caller passed `keep: true` — copies the run's events and summary into
  the real store under `step:<type>`. `runSingleStep` itself is untouched;
  the decision is one graph read after the run. Since the prompt has the
  assistant author claims before the first run, this means: a step with a
  contract keeps its test runs, a scratch step does not. Each record is one
  step's `events.jsonl`, a few KB — a thousand of them is a few MB.
- **Project only runs that carry evidence.** The verify pass (§4) projects
  the `StrutRun` it is about to attach evidence to (it needs the node for
  `HAS_SOURCE`), with `EXECUTED → StrutStepVersion`. Step runs that
  produced no evidence never reach the graph. `projectRuns` is unchanged.

Retention: an optional per-step cap (`STRUT_STEP_RUN_KEEP`, newest N)
prunes old step runs. Evidence keeps its `content` on the node, so a pruned
run only costs the debug log behind a `log_ref`. Later, not v1.

**`run.start` gains three optional fields** (`RunEvent` in `src/core.ts`),
plumbed through `runWorkflow`'s opts exactly like `workflowHash` is today
(set in `launchDetached`, `createStrut.ts`, and by `run_step`'s caller):

| field | value | used for |
| --- | --- | --- |
| `stepHashes` | `{ "<custom step type>": "<content hash>" }` for every workspace step the flow can execute, read from the workspace store at launch (a sibling of `getWorkflowHash`) | the ONLY record of which step version a run executed — see "Which version a run executed", §4 |
| `cassette` | `record` \| `replay` \| absent (live) | a replay-mode run is a unit test against a fixture: real evidence, weaker than live. Copied into `HAS_SOURCE.context` so the ledger can show a claim that has only ever been checked against a fixture. (Today the mode exists only in `run-step.ts`'s options; nothing records it.) |
| `origin` | `"verify"` on runs the verify pass launches | the recursion guard (Triggers, §4) |

## 4. The verify pass — how evidence is produced

`src/verify.ts` — a post-run consumer in the projector's mould (zero
coupling to the hot path; re-runnable; backfills old runs):

```
verifyRun(workflow | step, runId):
  events = store.getRunEvents(...)
  for each step.end at path p (and the run.end for the workflow itself):
    for each active Claim on that step type / workflow:
      for each active Check that TESTS it, with run_when = run,
          whose policy fires (§4.1):
        if the check has a step_type:
          subject = { input, output, runId, path: p, artifactsDir, cassette }
          result  = runSingleStep(step_type, fresh registry, services,
                                  { config: step_config, input: subject,
                                    workspace, origin: "verify" })
                    # the subject IS the check's run input: config templates say
                    # {{ input.output.quote }}; validate.ts + runner untouched
                    # workspace: a `subflow` check resolves its child through it
                    #   (without it the runner throws "no workspace was provided",
                    #   which would read as cannot-run → unknown, silently)
                    # origin: marks the run so it is never itself verified (Triggers)
          evidence = mapCheckResult(result)        # below
          if evidence: write Evidence + EVIDENCED_BY{strength} from the claim
                       + PRODUCED_BY→check + ABOUT→version + HAS_SOURCE→run
        else (an external check):
          open a planned slot (§4.2) — a question, not evidence
```

**Where the subject comes from.** Run events carry full values, not
previews (`PREVIEW_MAX_CHARS` is a projector concern; the store never
truncates), so the pass rebuilds the subject from the log alone:

| subject | `input` | `output` |
| --- | --- | --- |
| a step, at path `p` | `step.start.input` at `p` — the step's RESOLVED CONFIG (that is what the runner records as `input`), so a check reads `{{ input.input.url }}` for the config value `url` | `step.end.output` at `p` |
| a `foreach` / loop body | same, per iteration — `path` carries the iteration, one subject and one Evidence each | same |
| the workflow itself | `run.start.params` + the run's input (`run.json`) | the run's final output (`run.end`) |

A `step.replayed` (resume) yields no subject — nothing executed. A step with
`step.error` and no `step.end` yields `{ input, error }` and no `output`, so
a claim like "fails loudly on a private video" is checkable.

**Which version a run executed.** Evidence is `ABOUT` the exact version
observed, and status, `stale` and `on_change` all hang on that edge, so it
must never be guessed:

- the workflow: `run.start.workflowHash` → `StrutWorkflowVersion
  {content_hash}` — the lookup the projector already does for `EXECUTED`;
- a step: `run.start.stepHashes[type]` → `StrutStepVersion {step_type,
  content_hash}`. A workflow version does NOT pin its steps
  (`USES_STEP` targets the stable `StrutStep`; the registry loads whatever
  is active), so without this field the executed step version is
  unrecoverable once the step is republished.

When the hash is absent — a run from before this change, or a built-in
step — the pass writes NO evidence for that subject and reports
`lastVerify: { skipped: "unknown-version" }`. It never falls back to the
currently active version: that would attribute an old run's behaviour to
new code, which is exactly the drift this layer exists to catch. So
"backfills old runs" means runs recorded after step 2 ships.

**The check contract** (what `mapCheckResult` accepts):

| check step returns | evidence |
| --- | --- |
| `{ supports: boolean, content: string, locator?: { path?, start_time?, end_time?, url? } }` | strength ±1, `content`, locators on the edge |
| bare `exec` with no JSON on stdout | exit 0 → `+1`, non-zero → `−1`; content = stdout/stderr tail |
| `agent` with `schema` / `llm` with `schema` | same object; `evidence_mode = asserted`, `context` names the model — it is a judgment, not an observation |
| `subflow` — the check is a whole workflow (`step_config = { workflow, version?, input }`) | the child workflow's final output, read as the first row. `observed` only when the check closure (below) has no `agent` / `llm` step; otherwise `asserted` |
| the check itself cannot run (command not found, app never booted, step failed to load) | **nothing written**; the claim stays `unknown`. A broken check must never read as a pass (Hive's "not evaluated, never fail"). |

`exec` and custom code checks write `evidence_mode = observed`. A check
never throws on a failed assertion; it returns `supports: false`.

**A check can be a whole workflow.** `step_type: subflow` needs nothing
new: `runSingleStep` already wraps any step in a one-step flow and takes a
`workspace` for exactly this case. `step_config.input` maps the subject
into the child (`{ clip: "{{ input.output.clipPath }}", quote:
"{{ input.input.quote }}" }`); the child's last step returns the check
object. This is where any check bigger than a one-liner lives — "the clip
contains the quote" is speech-to-text, normalize, fuzzy-match.

**The check closure.** A `subflow` check is opaque by type, so three
decisions are made from what the check will actually execute: its step
types and the `agentTools` it grants. For a plain step that is the step
itself; for `subflow` it is the child workflow's steps via `collectTypes`
(`src/validate.ts` — already descends loop/foreach bodies and `onError`),
extended to follow nested `subflow` steps through the workspace resolver.
`step_config.workflow` must be a literal; a nested subflow whose
`workflow` is a template makes the closure unresolvable. The closure
decides (a) `evidence_mode` (table above), (b) presumed paid (§4.1),
(c) the grader deny-list (fixed point 2). Unresolvable = presumed paid,
`asserted`, and refused for an ai-stamped author.

**The check's own version.** A `Check` node is frozen so its evidence keeps
one meaning, but `step_type` names code that can be republished under it:
a custom step, or a subflow's child. `PRODUCED_BY` says WHICH check;
`HAS_SOURCE.context.checkVersion` says what code actually ran (for
`subflow`, the child's name and resolved version), and the ledger shows it
on `latest`. `on_change` also fires when the check's resolved version
differs from its latest evidence's (§4.1). A subflow check MAY pin
`version` (the subflow step already supports it); pinned, the check is as
immutable as the node.

**How checks and evidence come to exist — who does what.**

| | by whom | automatic? |
| --- | --- | --- |
| a check is added | authoring only: the `claims` arg, `add_claim` / `add_check`, or the UI; nothing derives a check from the sentence | no — the tools require at least one check per claim, and the publish count makes a missing contract visible |
| evidence from a code check (`exec`, custom step) | the verify pass | yes, no model anywhere in the path |
| evidence from an `agent` / `llm` check, or a `subflow` check with one in its closure | the verify pass | yes, but it costs money → policy + budget (§4.1) |
| asserted evidence | `add_evidence` from the assistant or a person | no — the only agent-call path, flagged `asserted` in the ledger |
| a planned slot is opened (external checks) | the verify pass | yes, paced by policy; free (§4.2) |
| a planned slot is filled | a person in the panel, the assistant via `add_evidence`, or an outside system writing to the graph | no |

**Triggers.**

- After every TOP-LEVEL run settles — hooked where `services.onRunEnd`
  already fires (`runWorkflow`'s `finally`, once per top-level run), NOT in
  `launchDetached`: a candidate launched by `meta/run-workflow` from inside
  a harness is its own top-level run and must be verified too. And after
  every `run_step`. Always as its OWN detached job — `run_workflow` /
  `run_step` return exactly when they do today and never wait for it.
  Idempotent per (check, run, path), by construction rather than by a
  marker: `Evidence.id` is `sha256(check id | run id | path)` truncated to
  32 hex chars, and the pass writes with the node writer's `create` mode (a
  no-op on an existing node), so a second pass over the same run cannot
  duplicate evidence — it only runs checks that have no Evidence for that
  (run, path) yet, which is exactly what "re-verify after adding a check"
  needs. Slots use the same id scheme. Two passes racing on one run (the
  detached pass and a harness's `meta/verify-run`) are serialized by an
  in-process single-flight map keyed on run id: the second caller awaits the
  first and returns its ledger.
- **Runs launched BY the verify pass are never verified.** Every check goes
  through `runSingleStep` → `runWorkflow`, so the top-level hook fires for
  check runs too, and a `subflow` check additionally looks like "an
  execution of the child workflow" under the nested rule below. Unguarded,
  a check workflow that has claims verifies its own checks, whose checks
  verify theirs. The pass marks its runs (`origin: "verify"` on
  `run.start`, beside the cassette mode); the trigger, `verify_run` and
  `meta/verify-run` all skip them. Claims on a check's step or workflow
  still get evidence when it is run directly.
- Inside one run, a `subflow` step's `step.end` is treated as an EXECUTION
  OF THE CHILD WORKFLOW (its `config.workflow` names it; the path addresses
  it), so claims on a workflow that only ever runs nested — the seeded
  `gaia-produce` inside `gaia-run`, inside `gaia-evolve`'s foreach — still
  get evidence, with `context` = the nested path.
  When the pass settles it wakes the chat through the existing notifier
  (`src/ai/notifier.ts`, `plans/dispatch-run-notifications.md`) with a
  `[verify-notification]` message carrying the ledger (§5). The notifier's
  queue-and-drain rule applies unchanged: a verify that finishes while a
  turn is live, or right behind its run's `[run-notification]`, arrives in
  the same wake-up turn; `autoTurns` counts it like any machine-triggered
  turn, so the park limit still holds. Runs launched from the API or UI
  (no chat) just get their evidence written; the panel shows it.
  Which checks actually fire on a given run is the policy's decision
  (§4.1); the pass itself always runs, and is cheap when nothing fires.
- `POST /workflows/:name/runs/:runId/verify` + a `verify_run` chat tool to
  re-verify after claims or checks change, or to backfill.
- `run_when: publish` checks run at the end of the authoring core's publish
  paths — `publishNewStep` / `publishStepVersion` and the capability's
  `publishWorkflow` (`src/authoring.ts`; there is no standalone
  `publishStep`), so chat tools and `meta/*` twins both get them — with
  `input = { source | yaml }`. There is no run, so their Evidence has
  `ABOUT → the new version` and `HAS_SOURCE → that same version node`.
  (Lints: "no step reads process.env directly".)
- An inline check (one that needs live state, e.g. a booted app) would run
  in the runner right after `step.end`. Later; not v1.

### 4.1 When a check fires: policy and budget

"Every run" is right for free checks and wrong for paid ones. Each `Check`
carries a `policy`:

| policy | fires when | default for |
| --- | --- | --- |
| `always` | every verified run of the subject, every input — coverage comes from inputs | `exec` / custom code checks, and `subflow` checks with no `agent` / `llm` step in the closure (observed, free) |
| `on_change` | the subject's active version changed since THIS check's latest evidence; OR the check's resolved code version changed (§4, "the check's own version"); OR it has no evidence yet; OR its latest evidence is older than `freshness_days` (env drift: yt-dlp updated, nothing else did) | checks presumed paid: `agent` / `llm`, and `subflow` with one in its closure (or unresolvable); external checks |
| `sample` | a `sample_rate` fraction of runs — production monitoring | opt-in |
| `manual` | only `verify_run` / `verify_step` | opt-in |

Policy is per check, so one claim can be tested cheaply on every run and
expensively once per version. Publishing a new version runs nothing by
itself (there is no run to observe); the next run finds the evidence stale
and the `on_change` checks fire. **Later (v1.5): re-test on publish** —
when a step version is published, replay the step's kept runs (§3;
cassettes make them offline) through the new version and verify. That is a
regression suite for free wherever cassettes exist, and it is what "only
when a step changes" should eventually mean.

**Budget.** Paid is decided twice, because the type alone cannot be
trusted: a `subflow` hides an `llm` step, a custom step can call a model
through `services`.

- BEFORE the run, from the check closure (§4): a check is PRESUMED paid
  when its closure contains an `agent` or `llm` step, or cannot be
  resolved. That sets the default policy and is what a cap skips.
- AFTER the run, from what it reported: every check runs in memory (as
  `run_step` does, §3). `RunEvent` has no cost field — `agent` / `llm`
  steps return `{ …, usage, cost }` in their OUTPUT — so the test is "any
  `step.end.output.cost > 0` in its events". If so, the run is copied to the
  store under the key `check:<check id>` (→ `checks/<check id>/runs/`, a
  third bucket beside `workflows/` and `steps/`, parsed in `runDir` the same
  way as `step:`) so the cost is on record exactly as for any agent step, it
  counts against the caps below, and the Evidence's `HAS_SOURCE.context`
  names that check run for debugging. Its `run.start` also records
  `verify: { checkId, subject, sourceRunId }`, which lets the caps be
  computed from the store alone: a subject's spend today is the sum of
  `step.end.output.cost` over today's runs, in the buckets of the checks on
  its claims, whose `verify.subject` is that subject. A presumed-free check that turns out
  to cost money is caught here: it spends from the same caps, so later paid
  checks skip, and the ledger's per-subject cost shows it.

A check that reports no cost is not persisted at all — its observation IS
the Evidence `content`, and persisting every `always` check on every
production run would rebuild the volume problem §3 avoids. On top:

- `STRUT_VERIFY_BUDGET_USD` — per verified run (default 1.00) and
  `STRUT_VERIFY_BUDGET_USD_PER_DAY` — per subject. Checks that report no
  cost never count.
- When a cap is hit, the remaining paid checks are **skipped**, the ledger
  records `lastVerify: { skipped: "budget" }` on each, and a claim with no
  other evidence stays `unknown` — never `supported`.
- The ledger and `get_step` show cumulative verify cost per subject, so
  the assistant and a person can see what a claim costs to keep true.
  The evolve loop can read the same number (EVOLVE_SPEC §7: cost is a
  constraint, not telemetry).

**Fixed points (EVOLVE_SPEC §6 applied here).** A check is a contract the
producing agent is MEANT to see, not a hidden grader, so authoring a step
and its checks in one turn is fine. Four guards keep the evolve loop from
gaming it:

1. The `meta/*` twins obey the existing publisher scoping — an ai-stamped
   author edits, retires and detaches only claims stamped `ai`
   (`Claim.speaker_name`) and checks stamped `ai` (`Check.publisher`), never
   one a person or a seeder wrote. It may also ADD a check only to a claim
   stamped `ai`: an always-passing check hung on a seeded contract line
   would read as `supported` whenever the real check was skipped.
2. **A check runs under producer grants.** A check written by an ai-stamped
   author may not name a harness-only `step_type` — `gaia/*`, `harvey/*`,
   `eval/*`, `meta/*`, and any namespace a deployment lists as grader-only
   (`STRUT_VERIFY_DENY`). Enforced when the check is written AND when the
   verify pass runs (a later edit cannot smuggle one in). Same rule as
   "NEVER grant gaia/* to agentTools", moved to the check surface: a
   candidate that embeds its grader as a check is oracle access at verify
   time. The rule applies to the check CLOSURE (§4), not just `step_type`:
   `step_type: subflow` naming a workflow that runs `gaia/evaluate`, or
   grants it to an agent, is the same oracle one hop away. "When the verify
   pass runs" matters more here — the child can be republished after the
   check was written — and an unresolvable closure is refused.
3. **Evidence written by an ai-stamped author is always `asserted`**, with
   `HAS_SOURCE.context` naming the agent session, whatever the agent
   claims. Only the verify pass and seeded (unstamped) harness workflows
   write `observed`. The ledger's `assertedOnly` flag then shows a
   candidate whose only support is its own author's word.
4. Hill-climbing a step until its own checks pass is the train-set
   problem, answered by EVOLVE_SPEC §7's held-out validation, not by
   hiding checks.

**`add_evidence(claim, run, supports, content)`** — the assistant's or a
person's own observation. Written as `evidence_mode = asserted`,
`HAS_SOURCE → StrutRun` with `context` naming the chat (or the Person node
when jarvis has one), and NO `PRODUCED_BY` — no check produced it. Allowed
in v1 so the loop works before every claim has a code check; the ledger
flags asserted-only so it is visible. When an open slot exists for that
(claim, run) — or the caller passes `slot: <evidence id>`, as the panel
does — it FILLS the slot instead of writing a second node (§4.2).

### 4.2 Planned slots — external checks

Not every claim can be checked by code or a model ("the clip sounds
natural at the cut"), and a strut step is the wrong tool for asking a
person: the verify pass must settle, and a step that blocks for days on a
human cannot (strut has no human-input step; `wait` is a timer). An
**external check** — a `Check` with no `step_type` — is how that is said,
and jarvis's `planned` evidence (migration 120) is how it is asked without
blocking: name the observation now, collect it whenever. Without it such a
claim is `unknown` forever and the "not done" rule (§2) can never be met.

**Opening.** For each active external check, when its policy fires (§4.1;
default `on_change`, reading collected evidence only), the verify pass
writes everything it knows, so that filling is small:

- `Evidence { evidence_status: planned, name: <the claim's text>,
  description: <the check's description + what to look at: run id, step
  path, a bounded preview of the subject's output> }` — no `content`,
  `evidence_mode` or `observed_at`;
- `Claim —EVIDENCED_BY→` it with NO `strength` (optional in jarvis's
  schema — an unanswered question has none);
- `—PRODUCED_BY→` the external check, `—ABOUT→` the version and
  `—HAS_SOURCE→ StrutRun` with the path and any locators, exactly as for
  collected evidence.

**At most one open slot per (external check, subject).** A slot about an
old run is a question whose answer would be born `stale`, so when the
policy fires again on a newer run the old slot's `EVIDENCED_BY` edge is
muted (jarvis's soft delete; the node holds no observation) and a fresh
slot is opened. Re-verifying the same run opens nothing. Slots cost no
money and never count against the budget.

Every read in `claims.ts` filters `r.is_muted IS NULL OR r.is_muted = false`
(as `EdgeWriter.update` already does) — a muted slot is neither evidence nor
an open slot.

**Filling.** Patch the node (`content`, `evidence_status: collected`,
`evidence_mode: asserted`, `observed_at` — the node writer's ON MATCH path)
and the edge (`strength: ±1` — `EdgeWriter.update`, the one way to change
an edge after its ON-CREATE-only MERGE), and record `by` in
`HAS_SOURCE.context`. Three fillers, one write:

- **a person**, from the Claims panel: an open slot renders as a to-do —
  the question, a link to the run and its artifacts, supports / refutes, a
  note. `by: person`;
- **the assistant**, via `add_evidence` — only with something it observed
  with a tool, and the content says what. `by: ai`, and the ledger's
  `assertedOnly` flag still applies (fixed point 3);
- **an outside system** (CI, Hive, another UI): a slot is an ordinary
  jarvis node and edge, patched through jarvis's own `/v2` API. This is how
  a check that is not a strut step reports in. It may equally skip the slot
  and write collected Evidence with its edges directly.

**In the ledger.** `openSlot` (the status rule) surfaces on the external
check as `lastVerify: { planned: "<evidence id>" }`; the status itself
stays whatever collected evidence says. Filling a slot does not wake the
chat in v1 — the next ledger shows it.

**Not in the minimal version:** templating the ask over the subject (v1's
ask is the check's `description` plus a preview), slots for `run_when:
publish`, routing a slot to a named person, reminders, and the `Person`
source edge (§7).

## 5. The ledger in tool results

The tool results of `run_workflow` and `run_step` list the claims with each
check's `lastVerify: { pending: true }` — the model sees the contract at
once and knows a verdict is coming. The `[verify-notification]` message
(and a `[run-notification]` whose verify already settled) carries the full
ledger:

```jsonc
"claims": {
  "youtube-clip": [ { "id", "text", "status": "supported|refuted|unknown|stale",
                      "assertedOnly": false, "unverified": 0,
                      "latest": { "content", "observed_at", "mode", "check": "<check id>", "checkVersion" },
                      "checks": [ { "id", "name",
                                    "lastVerify": { "pending": true } | { "ran": true }
                                                | { "skipped": "policy|budget|cannot-launch|unknown-version" }
                                                | { "planned": "<evidence id>" }   // an open slot, §4.2
                                  } ]
                    } ],
  "clip/compute-times": [ … ]     // one list per step type that ran
}
```

Workflow claims and each step's claims are listed separately; step
evidence does NOT roll up into the workflow (roll-up needs sub-claims, out
of scope). Publish results carry the count. This is the forcing function:
the model reads a contract in a tool result, not an instruction. The
prompt's "not done" rule (§2) therefore means: finish the turn after
launching, and act on the ledger when the notification arrives — the same
posture `run_workflow` already asks for on detached runs. The flyout
renders `[verify-notification]` as a dashed notice like
`[run-notification]`.

## 6. Interop with the eval harnesses (GAIA / Harvey, `mcp/src/lab`)

The harnesses live in the **stakgraph** repo (`stakgraph/mcp/src/lab`), not
here: strut ships the `meta/*` steps this section needs (steps 3–4), and
the workflow edits below are a separate change in that repo (step 6).

Reviewed against `gaia-evolve` → `gaia-evolve-gen` → `gaia-candidate-run`
→ `gaia-produce` (EVOLVE_SPEC §5.2 / §9.4). Nothing in the harnesses
changes shape; they gain a ledger. Concretely:

**What the claims ARE for a GAIA candidate.** Never the gold (gold lives in
`services.gaia`, in code, and a claim is producer-visible by design). They
are the HARD CONTRACT the author today smoke-tests by hand in ≤2 runs, plus
the format rules the author tunes prompts for:

| claim (on `gaia-produce` / the candidate) | check | policy |
| --- | --- | --- |
| the last step outputs `taskId`, a non-empty `answer` string, `cost`, `steps` | `exec` over `input.output` | `always`, free |
| `answer` is bare: no "The answer is", no trailing period, no markdown | `exec` | `always`, free |
| for a list question, `answer` is comma-separated in the order asked | `llm` judge over question + answer | `on_change` |
| the workflow never uses `gaia/evaluate` and grants no `gaia/*`, `eval/*`, `meta/*` to any `agentTools` | `run_when: publish` lint over the YAML | at publish, free |

The last row is the promotion-review item gaia-evolve's header assigns to
a human ("Review must also check the candidate never embeds
gaia/evaluate") — it becomes evidence on every publish. The contract is
ONE set of claim nodes, each with its checks, `ABOUT` the base workflow AND
every candidate: `gaia-evolve-gen` attaches them to the candidate after
`author` (`meta/attach-claim` for each active claim of
`params.baseWorkflow`; idempotent — an existing edge is a no-op). Nothing
is copied — the checks hang off the claim, so they come along — and editing
the contract edits it for the whole lineage; "which candidates satisfy it"
is one query. An ai author can attach and add its own claims, but it cannot
`detach` a claim, or add, edit or retire a check on a claim, that it did
not write (fixed point 1), so it cannot drop or soften the contract.

**Where the score goes.** The harness IS the check for the fitness
claim ("the candidate's accuracy on the task set is ≥ baseline").
`gaia-evolve-gen` writes it after `canddigest` with the seeded twin of
`add_evidence` (`meta/add-evidence`, unstamped workflow → `observed`;
content = the digest's `text`, which carries verdicts and answers, never
gold; source = the gen run). No new contract: graders write evidence
through a step, exactly as they write the Hive chain today via
`eval/build-eval-chain` + `graph/create-batch-triplet`.

**Reading the ledger inside a harness.** The detached pass races the
harness: `canddigest` runs right after `candeval` while 53 verify passes
may still be in flight. So harness workflows call `meta/verify-run`
(synchronous; single-flighted with the detached pass and idempotent, §4 —
whichever starts second awaits the first and finds nothing left to write) on
each candidate run before digesting, and `gaia/digest-results` (or the
evolve loop's briefing) folds per-claim pass rates across versions into the
grid. That is EVOLVE_SPEC §8's per-miss taxonomy computed from checks
instead of from the digest's `wrong-answer / empty-answer / produce-error`
heuristics — the author reads WHICH contract line recurs.

**Registry, provenance, cost.** The verify pass builds a fresh registry per
pass, so a candidate step published this generation is visible to its
checks (§5.3.1). There is no `services.authoring.getRegistry()` — the
capability does not expose one; `getRegistry` is a DEP `createStrut` hands
`buildAuthoringCapability` (`AuthoringDeps`, `src/authoring.ts`), and
`verify.ts` takes the same dep. Evidence content on harness
runs is verdict-only by construction (graders emit verdicts, `get-task`
strips gold), so `meta/list-claims` reading claims on seeded subjects leaks
nothing. Paid checks fire `on_change` — once per candidate VERSION, not per
task — but a 5-generation × 53-task run still meets the per-subject daily
cap; the harness sets its paid checks to `manual` or raises
`STRUT_VERIFY_BUDGET_USD_PER_DAY` for the run. Follow-up: fold paid-check
cost into `eval/evolve-loop`'s `totalKnownCost` (the check runs are
persisted under `check:<check id>` with `cost` in their events, so the
number exists).

## 7. Non-goals (v1)

- Sub-claims / roll-up. jarvis already seeds `Claim → Claim` `PARENT_OF` /
  `DERIVED_FROM`, so this needs no migration later, but no tool writes them
  and no status rolls up.
- A check shared by several claims. One check returns one `supports`, about
  one statement; a shared instrument is a shared `subflow` named by several
  checks.
- Example inputs on a claim (Hive's positive/negative cases); the
  assistant supplies coverage by running more than one input.
- Planned slots beyond the minimal form (§4.2): a templated ask, slots at
  publish time, routing to a named person, reminders.
- Deferred, not rejected — each is a jarvis concept v1 leaves unset:
  `Person` as a `HAS_SOURCE` endpoint for human evidence and as
  `MADE_CLAIM` source (v1 records `by` in `context` and the author in
  `speaker_name`; jarvis counts independent sources by DISTINCT endpoints,
  so this matters once a scorer reads the ledger); `authority_level` on
  `HAS_SOURCE`; a stored `verdict` / `confidence_score` on the Claim.
- The Hive eval chain (`EvalTriggerOutput`, `CriterionResult`) — neither
  read nor written.
- A template layer, verdict/confidence scoring beyond the status rule.
- Built-in core/lib steps as subjects (works by construction; not seeded).

## Step order

1. Schema: jarvis 124 (merged) + 125 (PR open; `Check` and the five pairs —
   BLOCKS the live-graph tests below, not the unit work) + strut fixture
   re-dumped from a post-125 jarvis + `claim-schema-upgrade.ts` for
   already-seeded standalone DBs (§1) + the one `STRUT_EDGES` row;
   `claims.ts` with `claimStatus()` and read helpers; graph-backend gate in
   createStrut; unit tests.
2. `run.start` gains `stepHashes` / `cassette` / `origin` (§3) — FIRST, since
   only runs recorded after it can ever be verified; then `run_step`
   persists under `step:<type>` (§3) + the projector pair.
3. Authoring tools + `claims` arg + publish count + prompt section (§2),
   and their `meta/*` twins: `meta/add-claim`, `meta/edit-claim`,
   `meta/retire-claim`, `meta/list-claims`, `meta/attach-claim`,
   `meta/detach-claim`, `meta/add-check`, `meta/edit-check`,
   `meta/retire-check`, with publisher scoping.
4. `verify.ts` + check contract + check closure + triggers (incl. the
   verify-origin guard) + `add_evidence` + `meta/verify-run`
   + `meta/add-evidence` (§4, §6); planned slots — open in the pass for
   external checks, fill through `add_evidence` (§4.2).
5. Ledger in run results + the `[verify-notification]` through the
   notifier (§5).
6. Harness wiring (§6) — in the **stakgraph** repo (`mcp/src/lab`), after
   strut 3–5 are released there: seed the contract claims on `gaia-produce`,
   `meta/attach-claim` in `gaia-evolve-gen`, `meta/verify-run` before
   `canddigest`, the fitness `meta/add-evidence`, per-claim pass rates in
   `gaia/digest-results`. Not needed for step 8.
7. UI panel (`web/src/components/StepEditFlyout.tsx` + the workflow view),
   incl. open slots as to-dos.
8. Re-run the `youtube-clip` prompt on a fresh workspace; compare transcripts.

## Validation

- **Unit:** policy decisions (`always` / `on_change` incl. freshness / `sample`
  / `manual`), each read from THAT check's evidence; budget cap → skipped
  with reason, free checks uncounted; `claimStatus()` over every branch —
  incl. stale, a current refutation beating a current support from another
  check, a retired check's evidence ignored, `unverified` counting;
  `mapCheckResult` for each row of the contract, incl. cannot-launch → no
  evidence; exec exit mapping; subject-as-input resolution; the check
  closure (nested subflow, loop body, `agentTools` grant, templated
  `workflow` → unresolvable); a presumed-free check that reports cost →
  persisted and counted; `on_change` re-fires on a changed check version; a
  verify-origin run is skipped by the trigger and by `verify_run`;
  `claimStatus()` ignores `planned` evidence and reports `openSlot`; slot
  policy — opens on `on_change`, never a second open slot per external
  check, replaced when a newer run fires; the `claims` arg — a republish
  with the same arg adds nothing, a new text is added, nothing is ever
  retired by it; ids are lowercase alphanumeric and `Evidence.id` is
  deterministic over (check, run, path) — a second `verifyRun` over one run
  writes nothing, and adding a check then re-verifying runs only that check;
  two concurrent `verifyRun` calls on one run id share one pass; the subject
  of a step is its `step.start.input` + `step.end.output`, a foreach yields
  one subject per iteration, a `step.error` yields `{ input, error }`, a
  `step.replayed` yields none; `run.start` carries `stepHashes` /
  `cassette` / `origin`; a run with no `stepHashes` entry for a step →
  `skipped: "unknown-version"` and no Evidence, even when the step has an
  active version; muted edges are invisible to every read;
  `claim-schema-upgrade` — old-shape `Claim` schema → upgraded once, a
  second boot is a no-op, a jarvis-hosted (already `claim-id`) graph is
  untouched.
- **Harness (lab, live):** `gaia-evolve-gen` on one task with the contract
  claims → ledger in the digest; an ai author's check naming
  `gaia/evaluate` as `step_type` is refused, and so is a `subflow` check
  whose child uses it — at write, and again at verify after the child is
  republished to add it; an ai author's `meta/add-check` /
  `meta/edit-check` / `meta/detach-claim` on a seeded contract claim is
  refused; ai-written evidence lands `asserted`; a nested `gaia-produce`
  subflow yields evidence at its path.
- **Live graph (`npm run test:graph`):** publish with claims → `Claim` +
  `ABOUT` + `Check —TESTS→`; a Claim with no `speaker_name` and two Claims
  with the same text and different ids are both accepted (migration 124);
  `run_step` on a step with claims → persisted under `step:<type>`, absent
  from every workflow listing; verify → `StrutRun` + `EXECUTED →
  StrutStepVersion`; `run_step` on a step without claims → nothing
  persisted; verify → `Evidence` + `EVIDENCED_BY`, `PRODUCED_BY`, `ABOUT`,
  `HAS_SOURCE`; publish a new version → status `stale`; retire a claim →
  excluded from the ledger, evidence kept; `edit_claim` → successor with
  `SUPERSEDES`, attachments and checks carried, predecessor's
  `belief_valid_to` set, successor `unknown`; `edit_check` → successor
  check, the old check's evidence no longer counted, the claim back to
  `unknown` until it runs; two checks on one claim → two evidence streams,
  refuted if either refutes on the active version; a `subflow` check →
  Evidence whose `context.checkVersion` names the child and its resolved
  version; a check workflow that has its own claims → the pass terminates
  and no Evidence has a verify-origin run as its source; an external check
  → a `planned` Evidence with `name`, no `content`, an `EVIDENCED_BY` edge
  with no `strength`, `PRODUCED_BY` the external check, status still
  `unknown`; `add_evidence` on it → the SAME node now `collected`, the edge
  patched to ±1, status `supported` + `assertedOnly`; a new version + run →
  the old slot's edge muted, one fresh slot.
- **The youtube-clip rerun, judged by transcript:** ≥3 claims authored
  before the first run; each fixed failure adds one; final ledger has no
  `unknown`; the clip-contains-quote claim has an OBSERVED check
  (speech-to-text over the produced clip — `src/audio/stt.ts` already ships).

## Decided

- The statement is jarvis's `Claim`, not a new type. Migration 124 removed
  the blocker (identity on `id`, optional `speaker_name`), and using it
  inherits `EVIDENCED_BY`, `SUPERSEDES`, `PARENT_OF`, `DERIVED_FROM` and
  `MADE_CLAIM` instead of re-seeding them: one vocabulary whether a claim
  was said on a podcast or written about a workflow.
- `Claim` lives in jarvis's `Epistemic` domain with `Check` and `Evidence`
  (re-homed by migration 124, in the same PR — free there because 124
  deletes every Claim, so no node carried a `Domain_content` label). One
  `?domains=epistemic` read returns the whole layer, and hiding `Content`
  no longer hides the claims while leaving their checks and evidence.
- `ABOUT` needs only its two edge schemas, NOT an entry in jarvis's
  `EDGE_TYPES`. That list is the set of generic tokens that SKIP the
  edge-schema lookup on write; staying out of it keeps `ABOUT` validated
  against its pairs (verified live: `Check —ABOUT→ x` is a 400). `→ Thing`
  pairs resolve for any descendant through jarvis's CHILD_OF ancestor walk
  (verified live with `Claim —ABOUT→ Topic`), and every `Strut*` schema is
  Thing-parented with a `CHILD_OF` edge (`schema-seed.ts`), so `StrutStep`
  / `StrutWorkflow` / their versions qualify as subjects. Note `TESTS` and
  `PRODUCED_BY` ARE generic tokens: jarvis will accept them between any two
  nodes, so direction is strut's writer's job, not the schema's.
- The check is its own node, `Check`. Not `Policy`: jarvis already has a
  `Policy` type (Legal domain, a policy document, `policy-name`), `Check` is
  the name jarvis's own doc gave this deferred node, and `policy` is already
  the word for WHEN a check fires. A claim has 1..n checks; an external
  check (no `step_type`) replaces a "why there is no check" field.
- Claim and check are immutable separately; an edit supersedes that node
  only. Evidence counts only while both its claim and its check are active.
- Subject edge: `ABOUT`, minted, `Claim → subject`, many-to-many; also
  `Evidence → version` so status is per (claim, subject).
- Shared contracts are attached, never copied; their checks come along.
- Step runs: store key `step:<type>` in a separate `steps/<type>/runs/`
  bucket; persisted only when the step has claims or `keep: true`;
  projected only when evidence attaches (§3).
- Persisted (paid) check runs key on `check:<check id>`, a third `RunStore`
  bucket, not `step:<step_type>` — that would lump every `llm` check into
  one bucket, show them in `get_step("llm")`'s `recentRuns`, and add a
  meaningless `step:subflow`. `step:<type>` is only for the user's own
  `run_step` calls (§3, §4.1).
- A run's executed versions are recorded, never inferred: `workflowHash`
  (exists) and `stepHashes` (new) on `run.start`. No hash → no evidence
  (`skipped: "unknown-version"`).
- The `claims` authoring arg is additive and idempotent by exact text; it
  never edits, retires or detaches (§2).
- Verify is idempotent by construction: deterministic `Evidence.id` over
  (check, run, path) + the node writer's `create` mode; concurrent passes on
  one run are single-flighted (§4).
- Verify is a second notification: `run_workflow` / `run_step` return as
  today with `lastVerify: pending`; the detached verify pass wakes the chat
  with `[verify-notification]` (§4, §5).
- A check may be a whole workflow (`step_type: subflow`). Paid,
  `evidence_mode` and the grader deny-list are decided from the check
  closure, not the type; observed cost is the backstop. Every Evidence
  records the check that produced it and the code version that ran.
  Verify-origin runs are never verified (§4, §4.1).
- Not every check is a strut step. An external check gets a minimal planned
  slot (jarvis migration 120): opened by the verify pass, paced by policy,
  filled by a person, the assistant or an outside system. There is no
  human-input step (§4.2).
- Roll-up stays a non-goal; the `Claim → Claim` pairs it would use already
  exist.
- Deferred: `Person` as a source endpoint, `authority_level`, a stored
  verdict (§7).

## Open questions

- `answer_volatility` vs `freshness_days`: the same idea in two
  vocabularies, now on two nodes — jarvis's classes (`STATIC` …
  `INSTANTANEOUS`) sit on the `Claim` and are what its scorer will read;
  `freshness_days` sits on the `Check`. A `STATIC` claim (pure arithmetic)
  would never re-fire a paid check for age, an `EVOLVING` one (anything on
  yt-dlp) would. Set the class on the claim and derive each check's days
  from it, or keep the bare number per check? **Not blocking:** v1 ships
  the bare `freshness_days` per check and leaves `answer_volatility` unset
  (§ Nodes); deriving one from the other later changes no stored data.
