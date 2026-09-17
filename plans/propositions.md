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

Two node types, a handful of edge pairs (two of them reserved), two tool
changes, one post-run pass.
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
| `check_type` | ?string | a registry step type that verifies it (`exec`, `agent`, `llm`, a custom step, or `subflow` — a whole workflow, §4) |
| `check_config` | ?string | JSON config for that step; the subject is the check's `input` (§4), so it reads `{{ input.output.quote }}` — no new template root |
| `check_when` | ?string | `run` (default) or `publish` — Hive's `evaluates` split |
| `check_policy` | ?string | `always` \| `on_change` \| `sample` \| `manual` — when a `run` check fires (§4.1). Default: `always` for code checks, `on_change` for checks presumed paid (an `agent`/`llm` step anywhere in the check closure, §4) and for check-less propositions, where it paces the planned slot (§4.2 — a person's time is the cost) |
| `check_freshness_days` | ?int | for `on_change`: re-run when the latest evidence is older than this (default 7) — catches environment drift the version pointer cannot see |
| `check_sample_rate` | ?float | for `sample`: fraction of runs |
| `why_no_check` | ?string | required when `check_type` is absent. Not every check is a strut step: such a proposition is answered by a person or an outside system through a planned slot (§4.2) |
| `status` | string | `active` \| `retired` (never deleted; history stays) |
| `publisher` | ?string | who wrote it (`ai`, a person, a seeder) |
| `created_at` | datetime | when this node began to hold (jarvis `belief_valid_from`) |
| `retired_at` | ?datetime | when it stopped: retired, or superseded by an edit (jarvis `belief_valid_to`) |

**A proposition node is immutable once it has evidence.** Editing `text`
or any `check_*` field creates a NEW node that `SUPERSEDES` the old one
(existing jarvis edge type, new pair), carries the old node's `ABOUT`
attachments across, and retires the old node with `retired_at`. Old
evidence stays on the old node; the new node starts `unknown` — nothing
has tested the new statement yet — and `verify_run` over kept runs
repopulates it. This is the attribution rule EVOLVE_SPEC §6 applies to
graders (`scorerSha256`), applied to checks. A typo fix pays the same
price; that is the cost of one rule.

**Propositions are NOT versioned with workflow versions.** They attach
to the stable identity and apply to whatever version is active when a run
is verified; the version dimension lives on the evidence (`Evidence —ABOUT→
version`). "What was the contract for v2 at the time" is bitemporal: the
propositions whose `[created_at, retired_at)` window covers v2's evidence.

Why a new type and not jarvis's `Claim`: `Claim` requires `speaker_name`
in its node_key, jarvis validation rejects a node missing any required
attribute, `valid_node_key` forbids optional key fields, and a child type
inherits the requirement. The doc's own example ("Alice is 41") cannot be
written as specified. The name is Tom's call; the alternative is a
node_key migration over every existing Claim.

**`Evidence`** — jarvis's type, unchanged (node_key `evidence-id`; `name`
is its one required attribute besides `id`). `name` = the proposition's
text, bounded. `content` = what was observed (one bounded string;
`PREVIEW_MAX_CHARS` discipline). `evidence_mode` = `observed` when code or
an instrument produced it, `asserted` when a model or a person vouched.
`evidence_status` = `collected` for everything a check or `add_evidence`
writes, and `planned` for an OPEN SLOT: a named question with no `content`
yet, waiting on a person or an outside system (§4.2). Anything that reads
evidence to decide something — status, `on_change`, staleness — reads
`collected` only.

### Edges (one new edge type, `ABOUT`; the rest are new pairs of existing types)

| pair | carries |
| --- | --- |
| `Proposition` —`ABOUT`→ `StrutStep` / `StrutWorkflow` | the STABLE identity, never a version. **Many-to-many**: one proposition may be about several subjects (a contract every candidate in a lineage must meet; a timestamp rule shared by two steps), and a subject has many propositions. `ABOUT` is minted because a proposition can be about any node (a feature, a repository, a concept); no existing edge type reads that way |
| `Evidence` —`ABOUT`→ `StrutWorkflowVersion` / `StrutStepVersion` | the exact version the observation was made on. Written by whoever writes the evidence; this is what makes status per (proposition, subject) a direct lookup, including for nested subflow executions and single-step runs |
| `Proposition` —`SUPERSEDES`→ `Proposition` | an edit: the successor points at the node it replaced (existing edge type, new pair) |
| `Proposition` —`EVIDENCED_BY {strength}`→ `Evidence` | `+1` supports, `−1` refutes |
| `Evidence` —`HAS_SOURCE {context, start_time, end_time, post_url}`→ `StrutRun` | provenance: the run and, in `context`, the step's event path (`wf/compute_times`) and the cassette mode; time span / url when the check has one. `context` is ONE `?string` in jarvis's schema, so strut writes it as a small JSON object (`{ path, cassette, check?, model?, by? }`) — every "`context` names …" below is a key of that object |
| `StrutRun` —`EXECUTED`→ `StrutStepVersion` | new pair for single-step runs (§3) |
| `Proposition` —`PARENT_OF`→ `Proposition` | **seeded, unused in v1.** A compound proposition → its parts (a workflow proposition over its steps' propositions). Existing jarvis edge type, new pair |
| `Proposition` —`DERIVED_FROM`→ `Proposition` | **seeded, unused in v1.** A calculated proposition → its inputs ("Alice is 41" ← "Alice was born 1985-03-02"; the clock is not a proposition). Same |

The last two are reserved, not used: no v1 tool writes them, the status
rule ignores them, nothing rolls up (§7). They are seeded now because
`Proposition` is Thing-parented and so inherits NONE of `Claim`'s
claim-to-claim pairs — jarvis's 119 seeds `PARENT_OF` / `DERIVED_FROM` for
`Claim → Claim` only. Adding them to the one migration Tom is already
writing is free; adding them later is a second migration.

A proposition is a statement; a subject is something it is claimed of.
Evidence is always about ONE version of ONE subject, so the same
proposition attached to five workflows has five independent statuses.
"Which versions satisfy this" is one hop from the evidence; a version that
breaks a proposition shows as refuting evidence on that version.

### Status is computed on read, per (proposition, subject) (`src/graph/propositions.ts`)

```
evidence := THIS proposition node's COLLECTED evidence ABOUT any version
            of THIS subject (a superseded predecessor's evidence never
            counts — the ledger shows the predecessor's last status beside
            it; a `planned` slot is a question, not evidence)
no evidence                                    → unknown
latest evidence strength < 0                   → refuted
latest evidence strength > 0                   → supported
latest evidence is ABOUT a version that is not
  the subject's active version                 → stale   (overrides the two above)
plus: assertedOnly = no evidence with evidence_mode = observed
plus: openSlot     = a planned Evidence exists for this (proposition, subject)
```

One pure function over `(proposition, subject, evidence[], activeVersion)`.
No verdict is ever stored on the node. jarvis's richer scorer (source
authority, independence, `answer_volatility` decay) can replace this
function later without touching the nodes.

## 1. Schema registration

- **Prod (jarvis-hosted graph):** a jarvis migration seeds `Proposition` and
  every `Proposition` / `Evidence` pair in the table above — the two
  `ABOUT`s, `SUPERSEDES`, `EVIDENCED_BY` (119 seeds it for `Claim →
  Evidence` only), and the reserved `PARENT_OF` / `DERIVED_FROM` — same
  shape as `ontology_119`. `Evidence —HAS_SOURCE→ Thing` already covers
  `StrutRun`. Owner: Tom.
- **Standalone strut Neo4j:** add the same to the bundled ontology fixture
  (`src/graph/fixtures/jarvis-ontology.ts`) so `ontology-seed.ts` creates
  it; `graph/create-schema` is the by-hand fallback. The fixture is a dump
  that PREDATES 119/120: it has no `Evidence` type and no `EVIDENCED_BY` /
  `HAS_SOURCE` epistemic pairs, so those go in too (copy from jarvis's
  `get_epistemic_schema_library()` / `get_epistemic_schema_edges()`), or
  re-dump the fixture from a post-120 jarvis.
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
shared, never by copying the node. `edit_proposition(id, …)` returns the
SUCCESSOR's id (supersession, above); only attachments and `status` change
in place. The publish result
gains `propositions: <count>`; zero returns a warning the assistant has to
answer. Editing a proposition never publishes a workflow version; it
supersedes the proposition node instead.

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
6. An open slot (§4.2) is a question. Answer it only with something you
   observed with a tool, and say what; otherwise relay it to the user —
   what to look at, and where — and end the turn. A proposition that is
   waiting on a person does not keep you looping: the work is "done, not
   yet verified", and you say which lines are waiting.

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
                              { config: check_config, input: subject,
                                workspace, origin: "verify" })
                # the subject IS the check's run input: config templates say
                # {{ input.output.quote }}; validate.ts + runner untouched
                # workspace: a `subflow` check resolves its child through it
                #   (without it the runner throws "no workspace was provided",
                #   which would read as cannot-run → unknown, silently)
                # origin: marks the run so it is never itself verified (Triggers)
      evidence = mapCheckResult(result)        # below
      if evidence: write Evidence + EVIDENCED_BY{strength} + HAS_SOURCE→run
    for each active Proposition on it with NO check_type (check_when = run):
      if its policy fires: open a planned slot (§4.2) — a question, not evidence
```

**The check contract** (what `mapCheckResult` accepts):

| check step returns | evidence |
| --- | --- |
| `{ supports: boolean, content: string, locator?: { path?, start_time?, end_time?, url? } }` | strength ±1, `content`, locators on the edge |
| bare `exec` with no JSON on stdout | exit 0 → `+1`, non-zero → `−1`; content = stdout/stderr tail |
| `agent` with `schema` / `llm` with `schema` | same object; `evidence_mode = asserted`, `context` names the model — it is a judgment, not an observation |
| `subflow` — the check is a whole workflow (`check_config = { workflow, version?, input }`) | the child workflow's final output, read as the first row. `observed` only when the check closure (below) has no `agent` / `llm` step; otherwise `asserted` |
| the check itself cannot run (command not found, app never booted, step failed to load) | **nothing written**; the proposition stays `unknown`. A broken check must never read as a pass (Hive's "not evaluated, never fail"). |

`exec` and custom code checks write `evidence_mode = observed`. A check
never throws on a failed assertion; it returns `supports: false`.

**A check can be a whole workflow.** `check_type: subflow` needs nothing
new: `runSingleStep` already wraps any step in a one-step flow and takes a
`workspace` for exactly this case. `check_config.input` maps the subject
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
`check_config.workflow` must be a literal; a nested subflow whose
`workflow` is a template makes the closure unresolvable. The closure
decides (a) `evidence_mode` (table above), (b) presumed paid (§4.1),
(c) the grader deny-list (fixed point 2). Unresolvable = presumed paid,
`asserted`, and refused for an ai-stamped author.

**The check's own version.** A proposition is frozen so its evidence keeps
one meaning, but `check_type` names code that can be republished under it:
a custom step, or a subflow's child. Every Evidence therefore records what
actually ran — a `check: { type, version }` key in `HAS_SOURCE.context` (for
`subflow`, the child's name and resolved version) — and the ledger shows it
on `latest`. `on_change` also fires when the check's resolved version
differs from the latest evidence's (§4.1). A subflow check MAY pin
`version` (the subflow step already supports it); pinned, the check is as
immutable as the node.

**How checks and evidence come to exist — who does what.**

| | by whom | automatic? |
| --- | --- | --- |
| a check is added | authoring only: the `propositions` arg, `add_proposition`, or the UI; nothing derives a check from the sentence | no — the prompt rule "a check unless you say why not" + the publish count make omission visible |
| evidence from a code check (`exec`, custom step) | the verify pass | yes, no model anywhere in the path |
| evidence from an `agent` / `llm` check, or a `subflow` check with one in its closure | the verify pass | yes, but it costs money → policy + budget (§4.1) |
| asserted evidence | `add_evidence` from the assistant or a person | no — the only agent-call path, flagged `asserted` in the ledger |
| a planned slot is opened (check-less propositions) | the verify pass | yes, paced by policy; free (§4.2) |
| a planned slot is filled | a person in the panel, the assistant via `add_evidence`, or an outside system writing to the graph | no |

**Triggers.**

- After every TOP-LEVEL run settles — hooked where `services.onRunEnd`
  already fires (`runWorkflow`'s `finally`, once per top-level run), NOT in
  `launchDetached`: a candidate launched by `meta/run-workflow` from inside
  a harness is its own top-level run and must be verified too. And after
  every `run_step`. Always as its OWN detached job — `run_workflow` /
  `run_step` return exactly when they do today and never wait for it.
  Idempotent per run id: a run already verified (by the detached pass or an
  explicit `verify_run`) is skipped.
- **Runs launched BY the verify pass are never verified.** Every check goes
  through `runSingleStep` → `runWorkflow`, so the top-level hook fires for
  check runs too, and a `subflow` check additionally looks like "an
  execution of the child workflow" under the nested rule below. Unguarded,
  a check workflow that has propositions verifies its own checks, whose
  checks verify theirs. The pass marks its runs (`origin: "verify"` on
  `run.start`, beside the cassette mode); the trigger, `verify_run` and
  `meta/verify-run` all skip them. Propositions on a check's step or
  workflow still get evidence when it is run directly.
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
| `always` | every verified run of the subject, every input — coverage comes from inputs | `exec` / custom code checks, and `subflow` checks with no `agent` / `llm` step in the closure (observed, free) |
| `on_change` | the subject's active version changed since the latest evidence; OR the CHECK's resolved version changed (§4, "the check's own version"); OR no evidence yet; OR the latest evidence is older than `check_freshness_days` (env drift: yt-dlp updated, nothing else did) | checks presumed paid: `agent` / `llm`, and `subflow` with one in its closure (or unresolvable) |
| `sample` | a `check_sample_rate` fraction of runs — production monitoring | opt-in |
| `manual` | only `verify_run` / `verify_step` | opt-in |

Publishing a new version runs nothing by itself (there is no run to
observe); the next run finds the evidence stale and the `on_change` checks
fire. **Later (v1.5): re-test on publish** — when a step version is
published, replay the step's kept runs (§3; cassettes make them offline)
through the new version and verify. That is a regression suite for free
wherever cassettes exist, and it is what "only when a step changes" should
eventually mean.

**Budget.** Paid is decided twice, because the type alone cannot be
trusted: a `subflow` hides an `llm` step, a custom step can call a model
through `services`.

- BEFORE the run, from the check closure (§4): a check is PRESUMED paid
  when its closure contains an `agent` or `llm` step, or cannot be
  resolved. That sets the default policy and is what a cap skips.
- AFTER the run, from what it reported: every check runs in memory (as
  `run_step` does, §3). If any `step.end` in its events carries `usage` /
  `cost`, the run is copied to the store (`step:<check_type>`,
  `keep: true`) so the cost is on record exactly as for any agent step, it
  counts against the caps below, and the Evidence's `HAS_SOURCE.context`
  names that check run for debugging. A presumed-free check that turns out
  to cost money is caught here: it spends from the same caps, so later paid
  checks skip, and the ledger's per-subject cost shows it.

A check that reports no cost is not persisted at all — its observation IS
the Evidence `content`, and persisting every `always` check on every
production run would rebuild the volume problem §3 avoids. On top:

- `STRUT_VERIFY_BUDGET_USD` — per verified run (default 1.00) and
  `STRUT_VERIFY_BUDGET_USD_PER_DAY` — per subject. Checks that report no
  cost never count.
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
   access at verify time. The rule applies to the check CLOSURE (§4), not
   just `check_type`: `check_type: subflow` naming a workflow that runs
   `gaia/evaluate`, or grants it to an agent, is the same oracle one hop
   away. "When the verify pass runs" matters more here — the child can be
   republished after the proposition was written — and an unresolvable
   closure is refused.
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
When an open slot exists for that (proposition, run) — or the caller passes
`slot: <evidence id>`, as the panel does — it FILLS the slot instead of
writing a second node (§4.2).

### 4.2 Planned slots — checks that are not a strut step

Not every proposition can be checked by code or a model ("the clip sounds
natural at the cut"), and a strut step is the wrong tool for asking a
person: the verify pass must settle, and a step that blocks for days on a
human cannot (strut has no human-input step; `wait` is a timer). Without
something, a check-less proposition is `unknown` forever and the "not done"
rule (§2) can never be met. jarvis's `planned` evidence (migration 120) is
the non-blocking form: name the observation now, collect it whenever.

**Opening.** For each active proposition with no `check_type`, when its
policy fires (§4.1; default `on_change`, reading collected evidence only),
the verify pass writes everything it knows, so that filling is small:

- `Evidence { evidence_status: planned, name: <the proposition's text>,
  description: <what to look at: run id, step path, a bounded preview of
  the subject's output> }` — no `content`, `evidence_mode` or `observed_at`;
- `Proposition —EVIDENCED_BY→` it with NO `strength` (optional in jarvis's
  schema — an unanswered question has none);
- `—ABOUT→` the version and `—HAS_SOURCE→ StrutRun` with the path and any
  locators, exactly as for collected evidence.

**At most one open slot per (proposition, subject).** A slot about an old
run is a question whose answer would be born `stale`, so when the policy
fires again on a newer run the old slot's `EVIDENCED_BY` edge is muted
(jarvis's soft delete; the node holds no observation) and a fresh slot is
opened. Re-verifying the same run opens nothing. Slots cost no money and
never count against the budget.

**Filling.** Patch the node (`content`, `evidence_status: collected`,
`evidence_mode: asserted`, `observed_at` — the node writer's ON MATCH path)
and the edge (`strength: ±1` — `EdgeWriter.update`, the one way to change
an edge after its ON-CREATE-only MERGE), and record `by` in
`HAS_SOURCE.context`. Three fillers, one write:

- **a person**, from the Propositions panel: an open slot renders as a
  to-do — the question, a link to the run and its artifacts, supports /
  refutes, a note. `by: person`;
- **the assistant**, via `add_evidence` — only with something it observed
  with a tool, and the content says what. `by: ai`, and the ledger's
  `assertedOnly` flag still applies (fixed point 3);
- **an outside system** (CI, Hive, another UI): a slot is an ordinary
  jarvis node and edge, patched through jarvis's own `/v2` API. This is how
  a check that is not a strut step reports in. It may equally skip the slot
  and write collected Evidence with its three edges directly.

**In the ledger.** `openSlot` (the status rule) surfaces as `lastVerify:
{ planned: "<evidence id>" }`; the status itself stays whatever collected
evidence says, usually `unknown` or `stale`. Filling a slot does not wake
the chat in v1 — the next ledger shows it.

**Not in the minimal version:** a templated ask per proposition, slots for
`check_when: publish`, routing a slot to a named person, reminders, and
the `Person` source edge (§7).

## 5. The ledger in tool results

The tool results of `run_workflow` and `run_step` list the propositions
with `lastVerify: { pending: true }` — the model sees the contract at once
and knows a verdict is coming. The `[verify-notification]` message (and a
`[run-notification]` whose verify already settled) carries the full ledger:

```jsonc
"propositions": {
  "youtube-clip": [ { "id", "text", "status": "supported|refuted|unknown|stale", "assertedOnly": false,
                      "latest": { "content", "observed_at", "mode" },
                      "lastVerify": { "pending": true } | { "ran": true } | { "skipped": "policy|budget|cannot-launch" }
                                    | { "planned": "<evidence id>" }   // an open slot, §4.2
                    } ],
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

- Sub-propositions / roll-up. The `PARENT_OF` / `DERIVED_FROM` pairs are
  seeded (Edges) so this needs no second migration, but no tool writes
  them and no status rolls up.
- Example inputs on a proposition (Hive's positive/negative cases); the
  assistant supplies coverage by running more than one input.
- Planned slots beyond the minimal form (§4.2): a templated ask, slots at
  publish time, routing to a named person, reminders.
- Deferred, not rejected — each is a jarvis concept v1 leaves unset:
  `Person` as a `HAS_SOURCE` endpoint for human evidence (v1 records `by`
  in `context`; jarvis counts independent sources by DISTINCT endpoints, so
  this matters once a scorer reads the ledger); `authority_level` on
  `HAS_SOURCE`; a shared `Check` node (checks stay attributes of the
  proposition).
- The Hive eval chain (`EvalTriggerOutput`, `CriterionResult`) — neither
  read nor written.
- A template layer, verdict/confidence scoring beyond the status rule.
- Built-in core/lib steps as subjects (works by construction; not seeded).

## Step order

1. Schema: jarvis migration (Tom; incl. the reserved `PARENT_OF` /
   `DERIVED_FROM` pairs) + strut fixture (incl. `Evidence` and its 119/120
   pairs, which the dump predates) + the one `STRUT_EDGES` row;
   `propositions.ts` with `propositionStatus()` and read helpers;
   graph-backend gate in createStrut; unit tests.
2. `run_step` persists (§3) + projector pair.
3. Authoring tools + `propositions` arg + publish count + prompt section (§2).
4. `verify.ts` + check contract + check closure + triggers (incl. the
   verify-origin guard) + `add_evidence` + `meta/verify-run`
   + `meta/add-evidence` + `meta/attach-proposition` (§4, §6); planned
   slots — open in the pass, fill through `add_evidence` (§4.2).
5. Ledger in run results + the `[verify-notification]` through the
   notifier (§5).
6. UI panel, incl. open slots as to-dos.
7. Re-run the `youtube-clip` prompt on a fresh workspace; compare transcripts.

## Validation

- **Unit:** policy decisions (`always` / `on_change` incl. freshness / `sample`
  / `manual`); budget cap → skipped with reason, free checks uncounted;
  `propositionStatus()` over every branch incl. stale; `mapCheckResult`
  for each row of the contract, incl. cannot-launch → no evidence; exec exit
  mapping; subject-as-input resolution; the check closure (nested subflow,
  loop body, `agentTools` grant, templated `workflow` → unresolvable);
  a presumed-free check that reports cost → persisted and counted;
  `on_change` re-fires on a changed check version; a verify-origin run is
  skipped by the trigger and by `verify_run`; `propositionStatus()` ignores
  `planned` evidence and reports `openSlot`; slot policy — opens on
  `on_change`, never a second open slot, replaced when a newer run fires.
- **Harness (lab, live):** `gaia-evolve-gen` on one task with the contract
  propositions → ledger in the digest; an ai author's proposition naming
  `gaia/evaluate` as `check_type` is refused, and so is a `subflow` check
  whose child uses it — at write, and again at verify after the child is
  republished to add it; ai-written evidence lands `asserted`; a nested
  `gaia-produce` subflow yields evidence at its path.
- **Live graph (`npm run test:graph`):** publish with propositions → nodes +
  `ABOUT`; `run_step` on a step with propositions → persisted under
  `step:<type>`, absent from every workflow listing; verify → `StrutRun` +
  `EXECUTED → StrutStepVersion`; `run_step` on a step without propositions →
  nothing persisted;
  verify → `Evidence` + both edges; publish a new version → status `stale`;
  retire → excluded from the ledger, evidence kept; edit → successor with
  `SUPERSEDES`, attachments moved, predecessor retired, successor `unknown`;
  a `subflow` check → Evidence whose `context.check` names the child and its
  resolved version; a check workflow that has its own propositions → the
  pass terminates and no Evidence has a verify-origin run as its source;
  a check-less proposition → a `planned` Evidence with `name`, no `content`,
  an `EVIDENCED_BY` edge with no `strength`, status still `unknown`;
  `add_evidence` on it → the SAME node now `collected`, the edge patched to
  ±1, status `supported` + `assertedOnly`; a new version + run → the old
  slot's edge muted, one fresh slot; a `Proposition —PARENT_OF→
  Proposition` and a `—DERIVED_FROM→` edge write are accepted by the
  resolver (the reserved pairs exist) on both the fixture and jarvis.
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
- A check may be a whole workflow (`check_type: subflow`). Paid,
  `evidence_mode` and the grader deny-list are decided from the check
  closure, not the type; observed cost is the backstop. Every Evidence
  records the check version that produced it. Verify-origin runs are never
  verified (§4, §4.1).
- Not every check is a strut step. A check-less proposition gets a minimal
  planned slot (jarvis migration 120): opened by the verify pass, paced by
  policy, filled by a person, the assistant or an outside system. There is
  no human-input step (§4.2).
- `PARENT_OF` / `DERIVED_FROM` for `Proposition → Proposition` are seeded
  with the first migration and left unused; roll-up stays a non-goal.
- Deferred: `Person` as a source endpoint, `authority_level`, a `Check`
  node (§7).

## Open questions

- `answer_volatility` vs `check_freshness_days`: the same idea in two
  vocabularies. jarvis's classes (`STATIC` … `INSTANTANEOUS`) are what its
  scorer will read; a `STATIC` proposition (pure arithmetic) would never
  re-fire a paid check for age, an `EVOLVING` one (anything on yt-dlp)
  would. Store the class and derive the days, or keep the bare number?

- Persisted check runs key on `step:<check_type>`. That already lumps every
  `llm` check into one bucket and shows them in `get_step("llm")`'s
  `recentRuns`; with subflow checks it adds a meaningless `step:subflow`.
  A per-proposition key (`check:<proposition-id>`) may be the better home.

- jarvis migration for `Proposition` + `ABOUT`: whether `ABOUT` needs an
  entry in jarvis's `EDGE_TYPES` allowlist or an edge schema per pair.
