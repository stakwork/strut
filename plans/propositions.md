# Propositions and evidence — the truth layer

A step or workflow states how it SHOULD behave. Every execution produces
evidence for or against those statements. Status is computed from the
evidence, never asserted. The engine enforces it at publish and run time;
the prompt only explains it.

Companion to `specs/EVAL_SPEC.md` (a score is one kind of evidence) and
`specs/EVOLVE_SPEC.md` (the "capture" beat: a failure becomes a proposition
with a check, so it cannot regress silently). Graph vocabulary comes from
jarvis's epistemic layer (`jarvis-backend/docs/epistemic_layer.md`,
migrations 119/120); this plan adds what that layer deliberately deferred.

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
| jarvis (migration 119/120) | `Evidence` (Epistemic domain: `content`, `evidence_mode` observed\|asserted, `evidence_status` planned\|collected, `observed_at`); edge pairs `EVIDENCED_BY {strength −1..1}`, `HAS_SOURCE {authority_level, locators}`, `DERIVED_FROM`, `PARENT_OF`; verdict vocabulary on the claim side | a speaker-free claim (`Claim` is the podcast type, keyed on `claim_text` + required `speaker_name`; a child type inherits the requirement); a template layer; a Check node; anything that produces or scores evidence — all named as deferred |
| hive | evals as graph nodes (`EvalRequirement` → `EvalTriggerOutput`), one LLM judge, "not evaluated is never a fail", `evaluates: workflow\|output` | any observed evidence; any link from feature requirements to evals |
| strut | versioned steps/workflows, persisted runs, `exec`/`agent`/`llm` steps, per-run artifacts, cassettes, the post-hoc projector, `SchemaResolver` (the node writer already accepts any type whose `:Schema` exists in the DB) | any notion of a claim; `run_step` runs are not persisted |

Nothing in the node model below is strut-specific. A proposition can be
about any node and evidence can come from any source (a CI run, a person,
a strut run). Strut is the first producer: the one that can execute an
arbitrary check. The Hive eval chain is out of scope here.

## Design

Two node types, four edge pairs, two tool changes, one post-run pass.
Requires the graph backend: on `STRUT_WORKSPACE_BACKEND=fs` none of the
proposition tools are offered and the verify pass is a no-op.

### Nodes

**`Proposition`** (new; Thing-parented, `Epistemic` domain, node_key
`proposition-id`). One plain-English sentence about how a subject should
behave, plus its optional executable twin.

| attribute | type | meaning |
| --- | --- | --- |
| `id` | string | its own identity, so rewording keeps the evidence |
| `text` | string | the sentence. Behavior, not mechanism; never the output schema restated |
| `check_type` | ?string | a registry step type that verifies it (`exec`, `agent`, `llm`, a custom step) |
| `check_config` | ?string | JSON config for that step; the subject is the check's `input` (§4), so it reads `{{ input.output.quote }}` — no new template root |
| `check_when` | ?string | `run` (default) or `publish` — Hive's `evaluates` split |
| `check_policy` | ?string | `always` \| `on_change` \| `sample` \| `manual` — when a `run` check fires (§4.1). Default: `always` for code checks, `on_change` for `agent`/`llm` checks |
| `check_freshness_days` | ?int | for `on_change`: re-run when the latest evidence is older than this (default 7) — catches environment drift the version pointer cannot see |
| `check_sample_rate` | ?float | for `sample`: fraction of runs |
| `why_no_check` | ?string | required when `check_type` is absent |
| `status` | string | `active` \| `retired` (never deleted; history stays) |
| `publisher` | ?string | who wrote it (`ai`, a person, a seeder) |
| `created_at` | datetime | |

Why a new type and not jarvis's `Claim`: `Claim` requires `speaker_name`
in its node_key, jarvis validation rejects a node missing any required
attribute, `valid_node_key` forbids optional key fields, and a child type
inherits the requirement. The doc's own example ("Alice is 41") cannot be
written as specified. The name is Tom's call; the alternative is a
node_key migration over every existing Claim.

**`Evidence`** — jarvis's type, unchanged. `content` = what was observed
(one bounded string; `PREVIEW_MAX_CHARS` discipline). `evidence_mode` =
`observed` when code or an instrument produced it, `asserted` when a model
or a person vouched. `evidence_status` is always `collected` in v1
(`planned` slots — named-but-unobserved, the human-in-the-loop hook — are a
later add).

### Edges (one new edge type, `ABOUT`; the rest are new pairs of existing types)

| pair | carries |
| --- | --- |
| `Proposition` —`ABOUT`→ `StrutStep` / `StrutWorkflow` | the STABLE identity, never a version. **Many-to-many**: one proposition may be about several subjects (a contract every candidate in a lineage must meet; a timestamp rule shared by two steps), and a subject has many propositions. `ABOUT` is minted because a proposition can be about any node (a feature, a repository, a concept); no existing edge type reads that way |
| `Evidence` —`ABOUT`→ `StrutWorkflowVersion` / `StrutStepVersion` | the exact version the observation was made on. Written by whoever writes the evidence; this is what makes status per (proposition, subject) a direct lookup, including for nested subflow executions and single-step runs |
| `Proposition` —`EVIDENCED_BY {strength}`→ `Evidence` | `+1` supports, `−1` refutes |
| `Evidence` —`HAS_SOURCE {context, start_time, end_time, post_url}`→ `StrutRun` | provenance: the run and, in `context`, the step's event path (`wf/compute_times`) and the cassette mode; time span / url when the check has one |
| `StrutRun` —`EXECUTED`→ `StrutStepVersion` | new pair for single-step runs (§3) |

A proposition is a statement; a subject is something it is claimed of.
Evidence is always about ONE version of ONE subject, so the same
proposition attached to five workflows has five independent statuses.
"Which versions satisfy this" is one hop from the evidence; a version that
breaks a proposition shows as refuting evidence on that version.

### Status is computed on read, per (proposition, subject) (`src/graph/propositions.ts`)

```
evidence := the proposition's evidence ABOUT any version of THIS subject
no evidence                                    → unknown
latest evidence strength < 0                   → refuted
latest evidence strength > 0                   → supported
latest evidence is ABOUT a version that is not
  the subject's active version                 → stale   (overrides the two above)
plus: assertedOnly = no evidence with evidence_mode = observed
```

One pure function over `(proposition, subject, evidence[], activeVersion)`.
No verdict is ever stored on the node. jarvis's richer scorer (source
authority, independence, `answer_volatility` decay) can replace this
function later without touching the nodes.

## 1. Schema registration

- **Prod (jarvis-hosted graph):** a jarvis migration seeds `Proposition` and
  the four edge pairs above, same shape as `ontology_119`. Owner: Tom.
- **Standalone strut Neo4j:** add the same to the bundled ontology fixture
  (`src/graph/fixtures/jarvis-ontology.ts`) so `ontology-seed.ts` creates
  it; `graph/create-schema` is the by-hand fallback.
- **Strut code:** `src/graph/propositions.ts` — attribute names, the
  subject-input contract, `propositionStatus()`, and read helpers
  (`propositionsFor(subject)`, `evidenceFor(proposition)`). Writes go
  through the existing node/edge writers: `SchemaResolver` resolves
  `Proposition` / `Evidence` and their edge pairs from the DB
  (`edge-writer.ts` already falls back to `resolver.edgeSchema` for
  non-Strut endpoints). The ONE change to `strut-schemas.ts` is the new
  Strut-to-Strut row `StrutRun —EXECUTED→ StrutStepVersion`, because
  Strut-to-Strut edges go through the closed `STRUT_EDGES` registry;
  `schema-seed.ts` seeds it like the other rows.

## 2. Authoring

Propositions are graph nodes with their own tools. Two doors onto one write.

**Door one — alongside the code.** `create_step`, `edit_step`,
`create_workflow`, `edit_workflow` (`src/ai/tools.ts`, shared core in
`src/authoring.ts` so the `meta/*` twins get it free) take
`propositions?: Array<{ text, check?: { type, config }, when?, why? }>`.
Publish writes each as a `Proposition` + `ABOUT` the published subject.
Door two's `add_proposition` takes one or MORE subjects, and
`attach_proposition(id, subject)` / `detach_proposition(id, subject)` add
or remove a subject on an existing one — attaching is how a contract is
shared, never by copying the node. The publish result
gains `propositions: <count>`; zero returns a warning the assistant has to
answer. Editing a proposition never publishes a version.

**Door two — on their own.** `add_proposition(subject, text, check?, when?,
why?)`, `edit_proposition(id, …)`, `retire_proposition(id)`, plus
`list_propositions(subject)`, on any subject ref. This is what makes it
general: an existing workflow without republishing, an in-workflow
authoring agent, a person in the UI, Hive's planning phase on a feature.

**Prompt rules** (`src/ai/prompts.ts`, one short section):

1. Author propositions BEFORE the first run, in the same turn as the code.
2. Behavior, not mechanism. Never the output schema restated.
3. Every proposition gets a check, or a one-line `why` it cannot.
4. A failure you fix becomes a proposition with a check (the regression
   move — the 429 becomes "fetches only the requested caption languages").
5. A workflow is not done while any proposition is `unknown` or `refuted`,
   and asserted-only evidence is called out to the user.

**UI:** a Propositions panel in `StepEditFlyout` and the workflow view —
text, status badge, latest evidence, add/edit/retire. Can land after the
tools.

## 3. Single-step runs persist — in their own bucket, only when they matter

`run_step` (`src/run-step.ts`) runs in a throwaway `MemoryRunStore` and
returns the output directly. That is the assistant's cheapest loop and
exactly where step propositions get tested, so a run that can become
evidence must leave a record. Three rules keep that from becoming noise:

- **Runs belong to a subject, and listings are per subject.** Every
  `RunStore` read (`listRuns`, `search_runs`, `GET /workflows/:name/runs`,
  the projector's `workflows: []`) already takes one name; there is no
  global run list. Step runs are stored under the `RunStore` key
  `step:<type>` — a store key, never a workflow — which `FileRunStore` maps
  to `steps/<type>/runs/<runId>/`, NOT `workflows/…` (a type like
  `clip/compute-times` nests as `steps/clip/compute-times/runs/`; the
  key is sanitized the way custom-step names already are). `MemoryRunStore`
  mirrors it. `listWorkflows` never sees them; a workflow's `list_runs` /
  `search_runs` are untouched by construction. A step's runs are read by
  asking for that key (`list_runs("step:<type>")`, and `get_step` gains a
  `recentRuns` count).
- **Persist only what can become evidence.** `run_step` runs in memory
  exactly as today, then — when the step has at least one active
  proposition, or the caller passed `keep: true` — copies the run's events
  and summary into the real store under `step:<type>`. `runSingleStep`
  itself is untouched; the decision is one graph read after the run. Since the
  prompt has the assistant author propositions before the first run, this
  means: a step with a contract keeps its test runs, a scratch step does
  not. Each record is one step's `events.jsonl`, a few KB — a thousand of
  them is a few MB.
- **Project only runs that carry evidence.** The verify pass (§4) projects
  the `StrutRun` it is about to attach evidence to (it needs the node for
  `HAS_SOURCE`), with `EXECUTED → StrutStepVersion`. Step runs that
  produced no evidence never reach the graph. `projectRuns` is unchanged.

Retention: an optional per-step cap (`STRUT_STEP_RUN_KEEP`, newest N)
prunes old step runs. Evidence keeps its `content` on the node, so a pruned
run only costs the debug log behind a `log_ref`. Later, not v1.

`run.start` records the cassette mode alongside params. A replay-mode run
is a unit test against a fixture: real evidence, weaker than live. The mode
goes into `HAS_SOURCE.context` so the ledger can show a proposition that
has only ever been checked against a fixture.

## 4. The verify pass — how evidence is produced

`src/verify.ts` — a post-run consumer in the projector's mould (zero
coupling to the hot path; re-runnable; backfills old runs):

```
verifyRun(workflow | step, runId):
  events = store.getRunEvents(...)
  for each step.end at path p (and the run.end for the workflow itself):
    for each active Proposition on that step type / workflow
        with check_type and check_when = run:
      subject = { input, output, runId, path: p, artifactsDir, cassette }
      result  = runSingleStep(check_type, fresh registry, services,
                              { config: check_config, input: subject })
                # the subject IS the check's run input: config templates say
                # {{ input.output.quote }}; validate.ts + runner untouched
      evidence = mapCheckResult(result)        # below
      if evidence: write Evidence + EVIDENCED_BY{strength} + HAS_SOURCE→run
```

**The check contract** (what `mapCheckResult` accepts):

| check step returns | evidence |
| --- | --- |
| `{ supports: boolean, content: string, locator?: { path?, start_time?, end_time?, url? } }` | strength ±1, `content`, locators on the edge |
| bare `exec` with no JSON on stdout | exit 0 → `+1`, non-zero → `−1`; content = stdout/stderr tail |
| `agent` with `schema` / `llm` with `schema` | same object; `evidence_mode = asserted`, `context` names the model — it is a judgment, not an observation |
| the check itself cannot run (command not found, app never booted, step failed to load) | **nothing written**; the proposition stays `unknown`. A broken check must never read as a pass (Hive's "not evaluated, never fail"). |

`exec` and custom code checks write `evidence_mode = observed`. A check
never throws on a failed assertion; it returns `supports: false`.

**How checks and evidence come to exist — who does what.**

| | by whom | automatic? |
| --- | --- | --- |
| a check is added | authoring only: the `propositions` arg, `add_proposition`, or the UI; nothing derives a check from the sentence | no — the prompt rule "a check unless you say why not" + the publish count make omission visible |
| evidence from a code check (`exec`, custom step) | the verify pass | yes, no model anywhere in the path |
| evidence from an `agent` / `llm` check | the verify pass | yes, but it costs money → policy + budget (§4.1) |
| asserted evidence | `add_evidence` from the assistant or a person | no — the only agent-call path, flagged `asserted` in the ledger |

**Triggers.**

- After every TOP-LEVEL run settles — hooked where `services.onRunEnd`
  already fires (`runWorkflow`'s `finally`, once per top-level run), NOT in
  `launchDetached`: a candidate launched by `meta/run-workflow` from inside
  a harness is its own top-level run and must be verified too. And after
  every `run_step`. Always as its OWN detached job — `run_workflow` /
  `run_step` return exactly when they do today and never wait for it.
  Idempotent per run id: a run already verified (by the detached pass or an
  explicit `verify_run`) is skipped.
- Inside one run, a `subflow` step's `step.end` is treated as an EXECUTION
  OF THE CHILD WORKFLOW (its `config.workflow` names it; the path addresses
  it), so propositions on a workflow that only ever runs nested — the
  seeded `gaia-produce` inside `gaia-run`, inside `gaia-evolve`'s foreach
  — still get evidence, with `context` = the nested path.
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
  re-verify after propositions change or to backfill.
- `check_when: publish` checks run inside `publishWorkflow` / `publishStep`
  with `input = { source | yaml }`; their evidence's source is the
  version node. (Lints: "no step reads process.env directly".)
- `check_inline` (a check that needs live state, e.g. a booted app) runs in
  the runner right after `step.end`. Later; not v1.

### 4.1 When a check fires: policy and budget

"Every run" is right for free checks and wrong for paid ones. Each check
carries a `check_policy`:

| policy | fires when | default for |
| --- | --- | --- |
| `always` | every verified run of the subject, every input — coverage comes from inputs | `exec` / custom code checks (observed, free) |
| `on_change` | the subject's active version changed since the latest evidence; OR no evidence yet; OR the latest evidence is older than `check_freshness_days` (env drift: yt-dlp updated, nothing else did) | `agent` / `llm` checks |
| `sample` | a `check_sample_rate` fraction of runs — production monitoring | opt-in |
| `manual` | only `verify_run` / `verify_step` | opt-in |

Publishing a new version runs nothing by itself (there is no run to
observe); the next run finds the evidence stale and the `on_change` checks
fire. **Later (v1.5): re-test on publish** — when a step version is
published, replay the step's kept runs (§3; cassettes make them offline)
through the new version and verify. That is a regression suite for free
wherever cassettes exist, and it is what "only when a step changes" should
eventually mean.

**Budget.** A PAID check (`agent` / `llm`) executes as its own persisted
step run (`step:<check_type>`, `keep: true`), so its `usage` / `cost` are
on record exactly as for any agent step, and the Evidence's
`HAS_SOURCE.context` names that check run for debugging. A FREE check
(`exec`, custom code) is not persisted at all — its observation IS the
Evidence `content`, and persisting every `always` check on every
production run would rebuild the volume problem §3 avoids. On top:

- `STRUT_VERIFY_BUDGET_USD` — per verified run (default 1.00) and
  `STRUT_VERIFY_BUDGET_USD_PER_DAY` — per subject. Checks with no model
  never count.
- When a cap is hit, the remaining paid checks are **skipped**, the ledger
  records `lastVerify: { skipped: "budget" }` on each, and the proposition
  stays `unknown` — never `supported`.
- The ledger and `get_step` show cumulative verify cost per subject, so
  the assistant and a person can see what a proposition costs to keep true.
  The evolve loop can read the same number (EVOLVE_SPEC §7: cost is a
  constraint, not telemetry).

**Fixed points (EVOLVE_SPEC §6 applied here).** A check is a contract the
producing agent is MEANT to see, not a hidden grader, so authoring a step
and its checks in one turn is fine. Four guards keep the evolve loop from
gaming it:

1. The `meta/*` twins of `add/edit/retire_proposition` obey the existing
   publisher scoping — an ai-stamped author edits only propositions
   stamped `ai`, never one a person or a seeder wrote.
2. **A check runs under producer grants.** A proposition written by an
   ai-stamped author may not name a harness-only `check_type` — `gaia/*`,
   `harvey/*`, `eval/*`, `meta/*`, and any namespace a deployment lists as
   grader-only (`STRUT_VERIFY_DENY`). Enforced when the proposition is
   written AND when the verify pass runs (a later edit cannot smuggle one
   in). Same rule as "NEVER grant gaia/* to agentTools", moved to the
   check surface: a candidate that embeds its grader as a check is oracle
   access at verify time.
3. **Evidence written by an ai-stamped author is always `asserted`**, with
   `HAS_SOURCE.context` naming the agent session, whatever the agent
   claims. Only the verify pass and seeded (unstamped) harness workflows
   write `observed`. The ledger's `assertedOnly` flag then shows a
   candidate whose only support is its own author's word.
4. Hill-climbing a step until its own checks pass is the train-set
   problem, answered by EVOLVE_SPEC §7's held-out validation, not by
   hiding checks.

**`add_evidence(proposition, run, supports, content)`** — the assistant's
or a person's own observation. Written as `evidence_mode = asserted`,
`HAS_SOURCE → StrutRun` with `context` naming the chat (or the Person node
when jarvis has one). Allowed in v1 so the loop works before every
proposition has a check; the ledger flags asserted-only so it is visible.

## 5. The ledger in tool results

The tool results of `run_workflow` and `run_step` list the propositions
with `lastVerify: { pending: true }` — the model sees the contract at once
and knows a verdict is coming. The `[verify-notification]` message (and a
`[run-notification]` whose verify already settled) carries the full ledger:

```jsonc
"propositions": {
  "youtube-clip": [ { "id", "text", "status": "supported|refuted|unknown|stale", "assertedOnly": false,
                      "latest": { "content", "observed_at", "mode" },
                      "lastVerify": { "pending": true } | { "ran": true } | { "skipped": "policy|budget|cannot-launch" } } ],
  "clip/compute-times": [ … ]     // one list per step type that ran
}
```

Workflow propositions and each step's propositions are listed separately;
step evidence does NOT roll up into the workflow (roll-up needs
sub-propositions, out of scope). Publish results carry the count. This is
the forcing function: the model reads a contract in a tool result, not an
instruction. The prompt's "not done" rule (§2) therefore means: finish the
turn after launching, and act on the ledger when the notification arrives —
the same posture `run_workflow` already asks for on detached runs. The
flyout renders `[verify-notification]` as a dashed notice like
`[run-notification]`.

## 6. Interop with the eval harnesses (GAIA / Harvey, `mcp/src/lab`)

Reviewed against `gaia-evolve` → `gaia-evolve-gen` → `gaia-candidate-run`
→ `gaia-produce` (EVOLVE_SPEC §5.2 / §9.4). Nothing in the harnesses
changes shape; they gain a ledger. Concretely:

**What the propositions ARE for a GAIA candidate.** Never the gold (gold
lives in `services.gaia`, in code, and a proposition is producer-visible
by design). They are the HARD CONTRACT the author today smoke-tests by
hand in ≤2 runs, plus the format rules the author tunes prompts for:

| proposition (on `gaia-produce` / the candidate) | check | policy |
| --- | --- | --- |
| the last step outputs `taskId`, a non-empty `answer` string, `cost`, `steps` | `exec` over `input.output` | `always`, free |
| `answer` is bare: no "The answer is", no trailing period, no markdown | `exec` | `always`, free |
| for a list question, `answer` is comma-separated in the order asked | `llm` judge over question + answer | `on_change` |
| the workflow never uses `gaia/evaluate` and grants no `gaia/*`, `eval/*`, `meta/*` to any `agentTools` | `check_when: publish` lint over the YAML | at publish, free |

The last row is the promotion-review item gaia-evolve's header assigns to
a human ("Review must also check the candidate never embeds
gaia/evaluate") — it becomes evidence on every publish. The contract is
ONE set of proposition nodes, `ABOUT` the base workflow AND every
candidate: `gaia-evolve-gen` attaches them to the candidate after `author`
(`meta/attach-proposition` for each active proposition of
`params.baseWorkflow`; idempotent — an existing edge is a no-op). Nothing
is copied, so editing the contract edits it for the whole lineage, and
"which candidates satisfy it" is one query. An ai author can attach and
add, but `detach` of a proposition it did not write is refused (fixed
point 1), so it cannot drop the contract.

**Where the score goes.** The harness IS the check for the fitness
proposition ("the candidate's accuracy on the task set is ≥ baseline").
`gaia-evolve-gen` writes it after `canddigest` with the seeded twin of
`add_evidence` (`meta/add-evidence`, unstamped workflow → `observed`;
content = the digest's `text`, which carries verdicts and answers, never
gold; source = the gen run). No new contract: graders write evidence
through a step, exactly as they write the Hive chain today via
`eval/build-eval-chain` + `graph/create-batch-triplet`.

**Reading the ledger inside a harness.** The detached pass races the
harness: `canddigest` runs right after `candeval` while 53 verify passes
may still be in flight. So harness workflows call `meta/verify-run`
(synchronous; idempotent — the detached pass then skips those runs) on
each candidate run before digesting, and `gaia/digest-results` (or the
evolve loop's briefing) folds per-proposition pass rates across versions
into the grid. That is EVOLVE_SPEC §8's per-miss taxonomy computed from
checks instead of from the digest's `wrong-answer / empty-answer /
produce-error` heuristics — the author reads WHICH contract line recurs.

**Registry, provenance, cost.** The verify pass builds a fresh registry
(`services.authoring.getRegistry()`), so a candidate step published this
generation is visible to its checks (§5.3.1). Evidence content on harness
runs is verdict-only by construction (graders emit verdicts, `get-task`
strips gold), so `meta/list-propositions` reading propositions on seeded
subjects leaks nothing. Paid checks fire `on_change` — once per candidate
VERSION, not per task — but a 5-generation × 53-task run still meets the
per-subject daily cap; the harness sets its paid checks to `manual` or
raises `STRUT_VERIFY_BUDGET_USD_PER_DAY` for the run. Follow-up: fold
paid-check cost into `eval/evolve-loop`'s `totalKnownCost` (the check runs
are persisted step runs with `cost`, so the number exists).

## 7. Non-goals (v1)

- Sub-propositions / roll-up (`PARENT_OF`, `DERIVED_FROM`).
- Example inputs on a proposition (Hive's positive/negative cases); the
  assistant supplies coverage by running more than one input.
- `planned` evidence slots and questions routed to a person.
- The Hive eval chain (`EvalTriggerOutput`, `CriterionResult`) — neither
  read nor written.
- A template layer, verdict/confidence scoring beyond the status rule.
- Built-in core/lib steps as subjects (works by construction; not seeded).

## Step order

1. Schema: jarvis migration (Tom) + strut fixture + the one `STRUT_EDGES`
   row; `propositions.ts` with `propositionStatus()` and read helpers;
   graph-backend gate in createStrut; unit tests.
2. `run_step` persists (§3) + projector pair.
3. Authoring tools + `propositions` arg + publish count + prompt section (§2).
4. `verify.ts` + check contract + triggers + `add_evidence` + `meta/verify-run`
   + `meta/add-evidence` + `meta/attach-proposition` (§4, §6).
5. Ledger in run results + the `[verify-notification]` through the
   notifier (§5).
6. UI panel.
7. Re-run the `youtube-clip` prompt on a fresh workspace; compare transcripts.

## Validation

- **Unit:** policy decisions (`always` / `on_change` incl. freshness / `sample`
  / `manual`); budget cap → skipped with reason, free checks uncounted;
  `propositionStatus()` over every branch incl. stale; `mapCheckResult`
  for each row of the contract, incl. cannot-launch → no evidence; exec exit
  mapping; subject-as-input resolution.
- **Harness (lab, live):** `gaia-evolve-gen` on one task with the contract
  propositions → ledger in the digest; an ai author's proposition naming
  `gaia/evaluate` as `check_type` is refused; ai-written evidence lands
  `asserted`; a nested `gaia-produce` subflow yields evidence at its path.
- **Live graph (`npm run test:graph`):** publish with propositions → nodes +
  `ABOUT`; `run_step` on a step with propositions → persisted under
  `step:<type>`, absent from every workflow listing; verify → `StrutRun` +
  `EXECUTED → StrutStepVersion`; `run_step` on a step without propositions →
  nothing persisted;
  verify → `Evidence` + both edges; publish a new version → status `stale`;
  retire → excluded from the ledger, evidence kept.
- **The youtube-clip rerun, judged by transcript:** ≥3 propositions authored
  before the first run; each fixed failure adds one; final ledger has no
  `unknown`; the clip-contains-quote proposition has an OBSERVED check
  (speech-to-text over the produced clip — `src/audio/stt.ts` already ships).

## Decided

- Type name: `Proposition` (not a `Claim` migration).
- Subject edge: `ABOUT`, minted, `Proposition → subject`, many-to-many;
  also `Evidence → version` so status is per (proposition, subject).
- Shared contracts are attached, never copied.
- Step runs: store key `step:<type>` in a separate `steps/<type>/runs/`
  bucket; persisted only when the step has propositions or `keep: true`;
  projected only when evidence attaches (§3).

- Verify is a second notification: `run_workflow` / `run_step` return as
  today with `lastVerify: pending`; the detached verify pass wakes the chat
  with `[verify-notification]` (§4, §5).

## Open questions

- jarvis migration for `Proposition` + `ABOUT`: whether `ABOUT` needs an
  entry in jarvis's `EDGE_TYPES` allowlist or an edge schema per pair.
