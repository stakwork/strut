# Claims, Concepts, the dream and history

The truth layer (claims, checks, evidence, verify), sealing, Concept pages and their seeding, the dream, and the workspace history.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **Claims, checks, evidence — the truth layer** (`plans/claims.md`; graph
  workspaces only, on by default there — on `STRUT_WORKSPACE_BACKEND=fs`,
  or with `STRUT_CLAIMS=0` / `createStrut({ claims: false })`, no claim
  tool is offered, `strut.claims` / `strut.verifier` are null, and nothing
  below runs. `createStrut` decides this once and threads the
  `ClaimsAuthoring | null` to every consumer; nothing else reads
  `workspace.graph`). A `Claim` states how a step or workflow should BEHAVE, a `Check`
  is an instrument that tests it (a registry step run over the subject, or
  an external check answered through a planned slot), `Evidence` is what
  one check observed on one run — all three are jarvis types, written
  through the ordinary node/edge writers. Status (`supported | refuted |
  stale | unknown`) is COMPUTED ON READ per (claim, subject) by
  `claimStatus()` and never stored. Authoring: the `claims` arg on the
  publish tools + `add_claim` / `edit_claim` / … and their `meta/*` twins
  (`src/claims-authoring.ts`), or a top-level **`claims:` block in the
  workflow YAML** — the arg's shape, in the file, shape-checked at every
  publish like `input:` (`readClaimsBlock`), merged with the arg by text,
  applied by every door (chat tools, `meta/publish-workflow`, `POST
  /workflows[/:name]`). It is how a SEEDED template carries its contract:
  `createStrut` records every workflow's active block at boot
  (`reconcileWorkflowClaims`, idempotent; speaker = the workflow's
  `publisher`, else `yaml`) and `strut.reconcileClaims()` re-runs it, so a
  seeder that writes YAML straight into the store needs no claims code. The
  block is content: it rides in the version hash, and a claim retired in
  the UI comes back at the next boot until the YAML drops it. Evidence: every top-level run is verified,
  detached, by `src/verify.ts`, hooked where `services.onRunEnd` fires (a
  run `launchDetached` started: once strut has decided whether its end
  wakes a conversation); check runs carry `origin: "verify"` and are never
  verified. The builder
  reads its contract in tool RESULTS (`src/ledger.ts`): run results list
  the claims `pending`, and a `[verify-notification]` (or the run's
  `[run-notification]`, when the pass settles within 5 s —
  `src/ai/verify-waker.ts`) starts the next turn with each claim's status.
  Versions are recorded, never inferred: `run.start.stepHashes` /
  `workflowHash`, and a subflow step's `step.start.subflow` — no record, no
  evidence.
  **A JOB is the third subject kind** (`plans/job-claims.md`; `{ kind:
  "job", name: <id> }` on every door): a claim about the WORK — "the
  settings page renders" — not the template. Its node is `StrutJob`
  (upserted from the record by `ensureJobNode` when the first claim is
  written, since the projector only writes it at run end) and its version
  is the TURN: evidence is `ABOUT` the turn's `StrutRun` (the projector
  stamps `job` on it), the active version is the job's newest top-level run
  on the record (`activeTurnOf`; `ClaimsReader` takes a `jobs` dep for it),
  so a later turn makes the ledger `stale` and `claimStatus()` reads as it
  does — except that a job's stream has one measurement per pass, never a
  foreach's several. Fixed point 1 has one exception here, ruled: on a job
  an `ai` author may hang its instrument on a PERSON's claim (the person's
  external check stays beside it; edit / retire / detach stay scoped).
  Checks on a job default to `manual` whatever the step
  (`sample` refused): the work is verified when it is said to be ready —
  `meta/verify-job` (door one, the agent mid-turn, with THIS run as the
  version, accepted in flight) or `POST /jobs/:id/verify` (door two, a
  person, the newest turn) — through `verifier.verifyJob`, which skips a
  turn that is no longer the newest as `superseded` (a job check reads the
  LIVE app; nothing about a job is backfilled) and APPENDS on a re-verify
  of the same turn (evidence path `job:<id>#<n>`; the automatic pass writes
  `#0` and stays idempotent). A job check's input is the job's state from
  the index (`buildJobSubject`: `{{ input.urls.pod }}`, `{{ input.dir }}`),
  its run carries the job (`RunStepOptions.job`: a screenshot lands in the
  job's files; `origin: verify` keeps it off the job's run list, no hold)
  and is kept under `check:<id>` when its evidence points into those files.
  The ledger rides on `GET /jobs/:id` (`claims`), `GET /jobs/:id/claims`
  and `job/get` through `JobsCapability.claims`; a person's Supports /
  Refutes is `POST /claims/:id/evidence { job, runId }`. The `job` seed
  grants the claim tools and `http/verify`, and its prompt says: author the
  claims when the ask is understood, verify before saying done.
  **A CONCEPT is the fourth subject kind** (`{ kind: "concept", name }` on
  every door, the Concept of that name in the backend's own namespace): a
  claim about what a piece of work that OPENED the page must look like
  ("a plan has a rollout section"). One rule covers all four kinds: a run
  observes each thing it used, at the version it used. A Concept, though,
  is observed by a WORK, never by one run (src/work.ts,
  plans/concept-evals.md rulings 5 and 9): a root run and every run it
  caused — the jobs a turn started (`startedBy`), the turns strut ran to
  report on them (`wake`), the child runs each waited on (`parentRunId`),
  and on. Each time a run ends the pass asks the stores whether it was the
  last of its work: every run in it ended, none still in flight, and no
  wake on its way for a job in it. Once it was, the work observes every
  page any of its runs opened, at the version those reads returned (a page
  its runs read at DIFFERENT versions, edited while the work went on, is
  observed at none: no one version made the work), and each claim's checks
  run once over it. A turn that starts a job is judged with the job and the
  turn that reported on it, not before. A work of one run is judged as one
  run always was. A Concept's version
  is a hash of what opening its page returns — its name, description and
  docs, and the name and description of each Concept under it
  (`src/graph/concept-version.ts`; a child's docs, or a page elsewhere, do
  not move it) — and it is RECORDED AT THE READ: `graph/graph-get` (so
  `context/concept` and an agent's `graph_graph_get` alike) stamps it on
  the node it reports (`AccessedNode.version` → `step.end.nodes`), so
  `subjectsOfRun` reads it off the log and the pass never asks the graph
  what the page says now. A Concept the log gives no version for — written,
  traversed (`graph-get-batched`, `graph-neighbors`, a walk), touched by a
  run this one launched, another strut's, or of that name in another
  namespace — is not observed. A Concept keeps no node per version:
  evidence is `ABOUT` the Concept itself, sourced to the work's ROOT run
  (`HAS_SOURCE`), with the version on the source (`SourceContext.version`),
  at path `concept:<name>`; two seeded edge rules, `Claim —ABOUT→ Concept`
  and `Evidence —ABOUT→ Concept`. The check reads the ROOT run as a
  workflow's check does (`input.input`, `input.output` or `input.error`,
  `input.params`) plus `input.concept`, `input.concepts` (every page the
  work opened, by name), `input.dir` (the root's files: its job's
  directory, else its artifacts), `input.job` and `input.work` (each run in
  order: how it came about, its status, the pages it opened, its files'
  folder); a check that does not apply to the work returns no `supports`,
  and nothing is recorded. The standard judge (`concept-check`) reads the
  whole work — each run's request and result, cut in code — and may open
  its files with `context/work-file`, both through `ctx.services.work`,
  which only the verify pass puts on a check's bag: read only, the work's
  own folders, no shell, no web, the work never instructions. A person's
  word (`knowledge/add-evidence`) is still about the one run it cites. A
  work that skipped a page never observes it, so a claim that a page GETS OPENED sits on the
  page that lists it ("a request of a kind opens that kind's page" on
  `Job`, checked with `input.concepts`), and rewriting the child's
  description moves that parent's version. Checks take a template's
  defaults (`always` for code, `on_change` for a paid or external one);
  `when: publish` is refused. The DOOR decides who writes one, not the
  author (`ClaimActor.concepts`, `requireConceptDoor` in
  claims-authoring.ts): a claim about a Concept is written where the tree
  is tended, never in passing. The doors of ordinary work — the builder
  chat's tools and the `meta/*` twins — are not offered the kind
  (`subjectSchema`: step, workflow, job) and add, attach, edit and retire
  nothing on such a claim, claim or check; their runs are still checked
  against it, and they read the verdicts in their ledger. A door that sets
  `concepts` may, whoever writes through it: a person's `/claims` routes
  today (`personSubjectSchema`), and next the workflow the Knowledge app
  shows (ruled 2026-11-11: AI-driven, its claims and checks written
  directly, its Concept edits proposals). An AI author there is stamped
  `ai` like any other, so fixed point 2 holds for its checks. That workflow
  is the dream (below). Not built: Concepts in other namespaces, claims
  travelling with a package's pages, running a check against a tree that
  is not live, any UI.

- **The dream — a tree of Concepts kept in step with what people say**
  (`src/workflows/system/dream/`, `src/knowledge.ts`, the `knowledge/*` and
  `dream/*` steps). A system workflow, off until its automation is switched
  on (daily, 04:00), one per tree: its input `root` names the tree
  (`Personal` by default), so a second tree is a second automation. It is
  the one workflow that holds the Knowledge door, and Concepts are the only
  thing it evolves. `dream/turns` (code) hands it the turns no dream has
  read, as a transcript in which every turn names its run and the Concept
  pages that run opened; `knowledge/page` renders the root as a tender
  reads it; ONE `agent` (no built-ins, `toolFilter: [none]`) then does
  three things for each thing a person corrected or asked for: (1) writes a
  CLAIM on the page it belongs to with `knowledge/add-claim`, at once — the
  sentence alone, since the check is always the standard one, the
  `concept-check` workflow, a model judging each later piece of work that
  opened the page, its one tool a read of that work's files (`on_change`:
  once per version of the page, a work the rule is not about left
  unjudged, so the next is judged in its place);
  (2) records WHAT WAS SAID with `knowledge/add-evidence` as that person's
  word against the claim, when the run whose work they corrected opened
  the page (the claim then reads `refuted` on that version); (3) PROPOSES
  the smallest change to the tree with `graph/edit-node` or
  `graph/create-triplet`, both in the workflow's `approve:`, so nothing in
  the tree changes until a person accepts. The loop closes in the claims
  layer with nothing of the dream's own: an accepted edit moves the page's
  version, the claim reads `stale`, and the next run that opens the page is
  judged. **Its rules are Concept pages, not its prompt** (ruling 7 of
  2026-11-12): the YAML keeps the mechanics — the steps, how each tool is
  called, that the material is data, the answer's shape — and the
  judgment is in the dream's OWN tree, which strut seeds like `Job`
  (`src/concepts/Dream.md`): `Dream` holds what is true for any source —
  the posture, what a lesson is, the three things, and where a lesson goes
  (the pages under the tree's root, never the root itself — a root is a
  short page that stays as it is, ruled 2026-11-13: the page it belongs
  on; reworded and put first when the work opened the page and still went
  wrong; the description when the page was never opened; a page directly
  under the root, its description saying when it applies, when it applies
  on almost every turn; `stuck`, for a person, when the page already says
  it plainly) — and one page
  under it per KIND of source holds what that source is, what to look for
  in it and which run a person's words there are about; the first,
  `Assistant Conversations`, is the material `dream/turns` hands over.
  `context/concept` reads `params.concept` (`Dream`) and `input.source`
  (`Assistant Conversations` by default) into the agent's system prompt,
  after the mechanics, only when there are turns. The two shipped pages
  are the FIXED BASE, the same on every strut and put back at every boot
  like `Job` and `Workflow Builder`; what evolves is the pages a workspace
  adds AROUND them (under `Dream`, under a source's page), which the
  rendered sections list and the agent opens with `graph/graph-get` when
  they bear on what it reads. Every page of its own guidance the dream
  reads is opened (graph-get records the version), so the rules are
  MEASURED: a claim on one judges the dream's runs, and a branch can vary
  the pages around the base. The tree it TENDS it reads only through
  `knowledge/page`, so it is never checked against that tree's claims, and
  a quiet dream opens nothing at all. A second kind of source is its page
  under `Dream` and the step that hands over its material. `dream/done`
  moves the marks only after the agent finished, so a dream that failed
  reads the same turns again; with no new turns no model is called. The
  workflow is `sealed` (its run log holds the conversations it read), and
  so are its writing steps and `dream/turns`: the meta surface cannot run
  them, read the dream's runs or publish a workflow that reaches them. A
  person keeps it in the Knowledge app (strut/knowledge, above):
  a Concept's claims with their status, the dream's changes to it drawn
  over the page and accepted or rejected there by an ADMIN (a proposal made
  in no conversation shows on strut's own pages to an admin, `pageSees`),
  and what waits across the tree. Not built: launching a dream from the
  app, a chat with the tender, sources other than conversations, moving a
  page, retiring a claim.

- **Concept branches — a copy of the tree a run can be pointed at**
  (`src/branches.ts`, plans/concept-evals.md item b; rulings 2, 3 and 10).
  A branch is a named copy of the Concept pages in a graph namespace of its
  own, `branch-<name>` (the namespace half of ruling 2; the git half is
  item c). `POST /branches { name, from: "main" | "empty" }` copies every
  live Concept of the graph's own namespace and the `PARENT_OF` edges among
  them (a copy carries no `unique_source_id`, so nothing reads it as a seeded
  or a package's page), `GET /branches` lists them, `DELETE /branches/:name`
  removes the pages and the record, refused while a run on it is in flight;
  the record is `<dataDir>/branches/<name>.json`. A launch's `branch` (a
  launch-level field beside `job`, full scope only, never a peer's) puts a
  run on it: recorded on `run.start` and the summary, `ctx.branch`, kept by
  a resume, inherited by every run it starts (job/start, job/continue,
  meta/run-workflow, meta/run-step, run/launch, a proposal it made, the wake
  turn that reports on its job — the conversation's), never changed by
  them; a run on main may start one on a branch through meta/run-workflow's
  `branch`. A conversation stays on the branch its first turn ran on (a
  turn line carries `branch`; the agent step's session refuses another,
  `session_branch:`). In a run on a branch the CONCEPTS are the branch's and
  the rest of the graph is live (`bindBranch`, the run's view of the bag):
  a Concept by name (graph-get, context/concept, knowledge/page), the
  Concept hits of search, find and resolve, and a Concept write all go to
  the branch; a write to a live Concept, anything else written into the
  branch's namespace, and an edge between a branch page and anything off it
  are refused; raw queries are off; automations are not scheduled from it.
  Main never sees a branch: a Ladybug search that names no namespace leaves
  `branch-*` out, and the history snapshot (`packageFiles(…, EVERYTHING)`)
  records no branch page. Claims stay shared and are not on branches yet
  (item d): a run on a branch opens the branch's pages, which no claim is
  about, so the verify pass records nothing about them, and the Knowledge
  door adds no claim or evidence from a branch. Not built: the git branch
  (c), the compare read (d), merge (e), a per-branch type list.

- **Sealed — what the meta surface may never touch** (`src/sealed.ts`;
  EVOLVE_SPEC §6). The `meta/*` steps publish over ANY workflow and edit any
  custom step, whoever published it (ruled 2026-11-10: there is no
  handover) — but never publish over, RUN, read the runs of, or verify a
  sealed workflow — `sealed: true` at the top of its YAML, a grading harness
  whose run log records what its graders were handed — and never edit or
  run a sealed step: the sealed namespaces (`eval/*`, `meta/*`, plus
  `STRUT_SEALED`) or `sealed: true` on its def (the lab's graders seal
  themselves; `gaia/*` is not sealed whole because `gaia/get-task` is the
  producer's door). A publish whose closure reaches one — the step by type,
  the workflow through a subflow, a grader in an `agentTools` grant — is
  refused, as is a candidate that seals itself or opens itself to peers
  (`peer:`; over a workflow open to peers the AI's version closes it), or a
  step authored into a sealed namespace. So the job agent edits and runs a
  seeded `pod-pr`, and an evolve candidate still cannot run, read, rewrite or
  subflow its grader. A publish over a SEEDED workflow goes through and its
  result's `note` says the next boot puts the seed back. Every version the
  meta surface writes is `source: agent` and stamps the workflow
  `publisher: ai`, which then stays (a person's later publish keeps it):
  what RUNS is read per version (`aiWroteVersion`, authoring.ts — reach and
  `meta/set-automation`, so a seed put back or a person's later version is
  not the AI's), while evidence reads the stamp (only a harness the AI never
  wrote to records `observed`). A step it edits keeps its stamp (a
  service's stays the service's to clean up). The web editor's Publish
  carries `sealed:` (and `claims:`, `promotes:`) through from the version
  being edited.

- **History — what the workspace held, when, and which run changed it**
  (`plans/concept-history.md`; `src/history.ts`, `history/read`). A
  SNAPSHOT is a package build of everything (`packageFiles(deps,
  EVERYTHING)`, src/packages/build.ts): every Concept in every namespace,
  every graph type but strut's own, every workflow's and step's active
  version, every app's sources, `strut.yaml` pinning what is installed —
  the format's folders, so the history knows nothing of Concepts and
  records a folder the format gains with no change. It is committed to a
  bare repository, `<dataDir>/history.git`, each time strut HEARS a write:
  a run's or an accepted proposal's graph view flushing (`bindGraph` — so a
  `graph/*` step, a workspace step writing `ctx.services.graph` itself, an
  agent's tool call, an app's `step_run` alike, schema writes included), the
  workspace store as createStrut wraps it (a publish, a rollback, a delete,
  an app release — a seed, an install and the `meta/*` twins go through
  it), an install as ONE commit, boot once after the seeds, `sync`. One
  queue, a second's debounce: a commit only when the tree differs, the run
  that wrote as a `Run:` trailer. The graph stays the source: git only
  records, and a raw write (`graph.query`, another process) is committed at
  the next touch or by `sync`. Runs, proposals, secrets and deployment facts
  (owner, schedules, the active pointer itself) are never in it. Reads are
  `history/read`: `log` / `show` / `diff` with git's shapes, any commit
  given as a time (the last commit at or before it — a run's start time is
  the tree it read), read-your-writes, held to the caller's reader list.
  On wherever strut has a graph and `git` (`STRUT_HISTORY=0`, `history:
  false`); the desktop needs `git` on the machine.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/claims-authoring.ts`

the policy layer behind BOTH claim doors (chat tools + meta/* twins): check-spec validation + write-time defaults (presumed-paid → on_change; on a JOB subject `manual`, `sample` refused), the additive `claims` publish arg, publisher scoping (fixed point 1; a job is nobody's template, so any author may claim about it, and on a job an `ai` author may add a check to a PERSON's claim — plans/job-claims.md §1, ruled), the sealed check over the check closure (fixed point 2; sealed.ts), `ensureJobNode` before a claim about a job is written

### `src/claims-schemas.ts`

zod shapes + model-facing docs for subjects / check specs / the `claims` arg, shared by ai/tools.ts and the meta/* claim steps; `personSubjectSchema`, the subject at a door that keeps the Concept tree (the `/claims` routes): those kinds plus `concept`, which the doors of ordinary work are not offered

### `src/sealed.ts`

what the meta surface may never touch (EVOLVE_SPEC §6): DEFAULT_SEALED_STEPS (`eval/*`, `meta/*`) + STRUT_SEALED, a step def's `sealed: true` (the graders — their namespace also holds the producer's door), a workflow's top-level `sealed: true` (content: Flow.sealed, rides in the version hash). isSealedStep / sealedInClosure (a grant the closure cannot read before the run counts as reaching one) — read by authoring.ts (run / run-history / verify / run-step refused by name, a publish refused by closure), claims-authoring.ts and verify.ts (an ai-stamped check's closure, fixed point 2)

### `src/verify.ts`

the verify pass (plans/claims.md §4): subjectsOfRun (a run's event log → observed subjects + the version each executed), mapCheckResult (the check contract; a check that cannot run writes NOTHING), policyFires (always / on_change / sample / manual), budget (presumed-paid skipped at a cap; reported cost persisted under `check:<id>` and counted), planned slots for external checks, addEvidence, verifyPublish. Triggered from `services.onRunEnd` for every top-level run and after a kept run_step — a run `launchDetached` started only once strut has decided whether its end wakes a conversation (createStrut's `detachedEnds`), so a work is never judged before the turn that reports on its job; check runs (`origin: "verify"`) are never verified. A run's step, workflow and job subjects are its own; its CONCEPT subjects belong to its WORK (src/work.ts): each pass asks whether the run was the last of its work (`workPasses`, nothing read when no Concept carries a claim) and, once it was, judges the work (`verifyWork`, one at a time per root): the pages any of its runs opened, at the version their reads returned (a page the runs read at different versions is observed at none, `unknown-version`), each check handed the root run, every page the work opened and `work`, its bag carrying `ctx.services.work`; the evidence sourced to the root run

### `src/work.ts`

a WORK (plans/concept-evals.md, rulings 5 and 9): a root run and every run it caused — a child it waited on (`parentRunId`), a job a turn started (`startedBy.runId`), a turn reporting on a job (`wake.runId` + `also`, not another strut's); `run/launch`, an automation's fire and a host's launch start works of their own. `recordCaused`: at each `run.start` (createStrut's `onRunEvent`, only where the claims layer is) one line naming the run appended to `<dataDir>/works/<cause runId>.jsonl`; `membersOf` walks down those files, `rootsOf` up the causes (null for a child: its parent's end decides; a wake on two works' jobs is in both). `workDone`: read from the stores each time, so a restart loses nothing — every run that is no child ended (a summary not `waiting`), none still in flight here (`isLive`), and no wake on its way for a job in it (its session's wake file holds it queued, or in a wake turn not ended). `foldWork` → `Work` (each run in start order: how it came about, status, input, result, pages opened, its files' folder — a job's directory, else its artifacts — and what it delivered), `renderWork` (a judge's text, cut in code; a work of one run reads as `context/run` always rendered a run), `workCapability` (what the verify pass puts on a check's bag: the work and a READ of its folders, realpath-contained, text in pieces of 30k, a Word file as text, an image as bytes). Pure parts tested in work.test.ts, the whole in graph/work.test.ts

### `src/knowledge.ts`

the KNOWLEDGE door: what a workflow that tends the Concept tree works through (the `dream`), and no workflow of ordinary work holds. `createKnowledge({ graph, claims, verifier, store })` → `ctx.services.knowledge`, set by createStrut wherever the claims layer is on: `page(name)` (one Concept as a TENDER reads it — docs cut at 6,000, parents, the pages under it with whether each carries claims, its claims with their computed status; no version is recorded, so tending is never an observation), `claims()` (every Concept carrying claims, with them, by name: what the Knowledge app scans for the refuted ones), `opened(workflow, runId)` (the pages a run opened, off its log: `conceptsOpenedIn`, verify.ts; null when the log cannot say), `addClaim({ concept, text })` (written at once through a door that sets `ClaimActor.concepts`, stamped `ai`, with the STANDARD check — `conceptCheckSpec`: a `subflow` to the `concept-check` system workflow handed the root run of each work that opened the page (the work itself on its bag, src/work.ts); the same sentence already on the page is that claim; at most `KNOWLEDGE_CLAIMS_PER_RUN`, 10, a run; a sentence holding `{{` refused, since it goes into the check's config) and `addEvidence` (what a PERSON said about a run's work, asserted, through `verifier.addEvidence`: only about a run that opened the claim's page). A tender never writes a check's config: what it reads is untrusted text, and a check is something strut runs. Changing a Concept is not here: the workflow's `approve:` makes it a proposal

### `src/branches.ts`

CONCEPT BRANCHES (plans/concept-evals.md item b): `createBranches({ dataDir, graph, inFlight })` → `ctx.services.branches` (`list`, `get`, `create`, `drop`), set by createStrut on a graph workspace; a branch's namespace is `branch-<name>` (`BRANCH_NAME`: lowercase letters, digits, `-`, `_`, a letter first, at most 56). Create registers the namespace (Neo4j searches registered ones only), clears what a cut-off create left there, copies the live tree in batches of 200 (`writeMany` upsert, `embed: "later"`; every declared attribute but `unique_source_id`) and its `PARENT_OF` edges, then writes the record; a copy that fails is cleared. Drop removes the record first (a run that starts from then on finds no branch), then every node in the namespace (`DETACH DELETE`), and on Neo4j unregisters the namespace. `bindBranch(services, branch)`: the run's view of the bag (the runner, beside `bindPrincipal` / `bindGraph`; an accepted proposal made on a branch too) — `graph` held to the branch (`onBranch`, src/graph/branch.ts), `knowledge` reading the branch's pages and adding no claim or evidence (`KnowledgeCapability.onBranch`), the automation steps' `create`/`update`/`fire` refused; on EVERY run, `sessions` refusing a conversation whose first turn ran on another branch and stamping each committed turn with the run's. `branchOfServices`: the branch a bag is already on — a run launched with a step's `ctx.services` is on it (runner.ts). Tested on both engines in graph/branches.test.ts

### `src/ledger.ts`

the ledger (plans/claims.md §5): buildLedger (claims per subject with computed status + each check's lastVerify: pending | ran | skipped | planned), subjectsOfFlow (what a launch can execute), the [verify-notification] text. The forcing function — the model reads its contract in a tool RESULT, not an instruction

### `src/claims-routes.ts`

the Claims panel's HTTP door: GET /claims?kind=&name= (contract + computed status + latest evidence + open slots; `{ enabled: false }` on a filesystem workspace), GET /workflows/:name/evidence (the run view: every verdict on a workflow's runs — its claims and its steps' — keyed by the run, `limit` counts runs; mounted before the `/:version` catch-all), POST/PATCH/DELETE /claims[/:id], /claims/:id/{attach,detach,checks,evidence}, PATCH/DELETE /checks/:id. Mutations behind requireApiKey; the actor is a PERSON (unscoped, stamped `person`; evidence `asserted`, `by: person`)

### `src/history.ts`

the HISTORY (plans/concept-history.md items 2–3): the whole workspace as a package directory (`packageFiles(…, EVERYTHING)`, packages/build.ts) committed to a bare git repository, `<dataDir>/history.git` (branch `main`; its work tree `history.git/work/`, inside it so it moves and is backed up with it), each time strut hears a write. TOUCHES: a run's or a proposal's graph view flushing a write a snapshot records (graph-writes.ts `historyRecords`: never a flush of instances alone), the workspace store `watch`ed once in createStrut (a publish, a change of the active version, a delete, an app release — never metadata a package does not carry), an install or uninstall `hold`ing the queue so what it publishes is one commit under `install <package>@<digest>`, `start()` at the end of the boot (cause `boot`; createStrut awaits it, so a strut that answers has its boot commit), `sync`. One in-process queue: a snapshot a second after the last touch (five at most after the first), each file written into the work tree only when its bytes changed (sha1 by path, read from disk on the first snapshot), nothing spawned when nothing did; else `add -A`, `write-tree`, and when the tree is not `main`'s, `commit-tree` + `update-ref`: author the actor who wrote (`strut` for boot and sync), email `history@strut.invalid`, the first line the first cause, the others below, one `Run:` trailer per run whose flush touched since the last commit, the date in whole seconds. A failed snapshot is logged, never a run's failure; the next is whole. Every git command on one repository runs on one in-process chain, and what the process knows of the repository (the work tree's sums, `main`'s commit and tree) is kept per repository, so two struts over one data directory never race; a data directory that vanished is not made again. A `WholeMemo` keeps the reads by version label / content hash (workflows, steps, app sources) and the installed pins until the workspace or a hold drops them, so a snapshot on a quiet workspace is three listings and the Concept and type reads. `settle` flushes every view with writes waiting and runs the queue now (what `history/read` does first); `git(args)` runs a READ command for it. git through `runProcess` (shell.ts) with the binary `findGit` found on PATH — on macOS `/usr/bin/git` only when `xcode-select -p` answers, so a boot never raises the Command Line Tools dialog — and no system or user config, hooks or signing. `openHistory`: off with `history: false` / `STRUT_HISTORY=0`, with no graph, or with no git (one boot line). `ctx.services.history` is its reads and touches (`HistoryCapability`), never `hold` or `close`

### `src/concept-seed.ts`

Concept files → `Concept` nodes on either engine: seedConcepts(graph, sets) — a set is a folder of pages + a stamp prefix, a page in either FORM (`parseConceptFile`, plans/concept-history.md §2.1): the old `<Name>.md` (named by its file; front matter `description`, one `parent`) — strut's own pages, every package published before — or the new one, told apart by `name` in the front matter (named by it whatever the file; then every attribute, then `parents`, every parent by name; `renderConceptPage` writes it, what a package build puts under the node key; `NOT_ATTRIBUTES`, what the graph or a seeder stamps or derives, never an attribute), body = docs either way; an attribute the graph's `Concept` does not declare is left out, one log line (`declaredAttributes`); each page reconciled by `unique_source_id = <prefix><file>@<hash>` (create; keep when the node holds the file's text; update when the file changed — or when the node's docs or an attribute the page sets were edited in the graph: a seed always matches git, so every boot puts them back; a deleted page of ours restored; someone else's or unstamped skipped; `legacyPrefixes` = an earlier seeder's stamps counted as ours), a `PARENT_OF` from each parent (a page of another call or already in the graph), an undeclared `PARENT_OF` between two pages the call owns removed — so a package's page under strut's `Job` keeps its edge through strut's every boot, `retired` files soft-deleted while they carry their stamp (`retireConcepts`). A set with `keepEdited` (a package's, src/packages/install.ts) keeps a page of its own whose text was edited in the graph — the outcome says `edited` — takes a deleted node under a page's name, and counts a stamp of any of its files as its own (a page a release moved to another file — the old form rebuilt under its key — is written again). Engine calls only (readByKeys / the writers / liveEdgesOfMany), no Cypher, and BATCHED (2026-11-10: a package's tree is hundreds of pages — openlaw/legal-desk's 752 took 19 s on Neo4j and 28 s on Ladybug one page at a time, about 1 s now): every page's node in one read per 250 names (`findConcepts`), the creates and updates 250 at a time (`writeMany`, `embed: "later"` — the vectors left to the backend's background embedder), the parents' live `PARENT_OF` edges in one read, only the missing edges written and the undeclared ones removed from that read; a failed batch is written again page by page, so a failure stays that page's outcome, and a name two pages share is seeded after the batch, in order; `progress` reports `pages` / `edges` done of total; one summary log line. createStrut seeds STRUT_CONCEPTS at boot on a graph (`concepts: false` seeds none); a host seeds its own sets with the same call afterwards and anchors pages from the outcomes it returns

### `src/concepts/`

the Concept pages strut SHIPS (copied into build/ by `npm run build`): `Workflow Builder` (what the builder's prompt reads; byte-identical to the page the stakgraph lab seeded first, whose stamps `lab/builder/concepts/` + `lab/job/concepts/` count as strut's) and `Job` (what the job workflow puts in its agent's prompt, `context/concept`) — roots, workspace-general; each deployment grows the tree under them — ONE TREE PER AGENT: `Job` is the job agent's and `Workflow Builder` the builder's, and the orchestrator reads the kinds under BOTH (`docs: false`) as its two lists, so a kind the builder builds is listed under `Workflow Builder`, never under `Job` (`Workflow Build`, the builder's entry under `Job` while the orchestrator read `Job` alone, is `retired` in `STRUT_CONCEPTS` and soft-deleted at boot; `Job`'s own docs tell a job agent that meets a workflow or an app that lives in a workspace to run `builder` through meta/run-workflow) — and `App` UNDER `Workflow Builder`: the builders' manual (layout, kit, hooks, grants, routines; hand a published app over BY NAME, `{ kind: "app", app }`), and `Game` UNDER `App`: a game as an app — the `game` starter, the loop, input, assets as imports, physics, scores, the look with `window.__debug`) — and `Dream`, the dream's own tree (a root; what holds for any source: the posture, what a lesson is, where it goes) with one page per KIND of source under it, `Assistant Conversations` the first (what `dream/turns` hands over: what to look for in it, which run a person's words are about): the dream's rules, read by the `dream` workflow, not its prompt. Like every page here they are the fixed base every strut ships (`Job` → a kind, `Workflow Builder` → `App`, `Dream` → `Assistant Conversations`); what a workspace learns grows in the pages around them. `Job App`, the job side of an app, is `retired` too (2026-10-22): a page over a job's own results is an HTML file in its directory, an app is the builder's, and `Job`'s docs say to pass the builder's app deliverable on

### `src/steps/lib/context/`

context/concept: a Concept as an agent's context — the page's docs (capped at 6k) and the name + description of each Concept under it (PARENT_OF), read through graph/graph-get and rendered as a system-prompt section, framed as the workspace's notes, with how to open a child page (`tool`: the agent's name for graph-get; `""` for an agent with none). `docs: false` renders the kinds under the page ALONE — for an agent that routes BY them rather than follows a page's convention; nothing under the page is `""`. The builder's default `chatSystem` is this step on `Workflow Builder`; the `job` workflow puts `{{ concepts.text }}` after `params.system` on `Job`, the `orchestrator` the kinds alone under `Job` and under `Workflow Builder` (`docs: false`, `tool: ""`). `{ text: "" }` without a wired graph or the page — never a failed run, never a Neo4j-from-env fallback. Not under `graph/`, so a `graph/*` grant does not hand it to an agent. context/run: a run as a JUDGE's context — what it was asked, what it returned (or the error it ended in) and the Concept pages it opened, as one block of text cut to its head and tail in code (12,000 characters by default), so a large output never reaches a prompt whole; inside a check the verify pass runs over a WORK it renders that work instead, from `ctx.services.work` (src/work.ts `renderWork`), never from its input; unsealed (the `concept-check` workflow's first step, which an `ai`-stamped check must be able to reach). context/work-file { path, from? }: one file or folder of the work a check judges (`<folder>/<path>`, `""` lists the folders), read through `ctx.services.work` — which only the verify pass sets, so no input points a read elsewhere; read only, the work's own folders, symbolic links resolved; text in pieces, a Word file as text, an image SHOWN (`withMedia`); refuses outside such a check. The standard judge's one tool; unsealed

### `src/steps/lib/knowledge/`

the Knowledge door as steps (src/knowledge.ts), thin over `ctx.services.knowledge`: knowledge/page { name, text? } (`effect: read`: a Concept as a tender reads it; `text: true` adds it as one block for a prompt; reading a page this way is not opening it), knowledge/claims (`effect: read`: every Concept carrying claims, with them — the Knowledge app's), knowledge/add-claim { concept, text } and knowledge/add-evidence { claim, workflow, run, supports?, said, by? } — both `sealed: true`, so the meta surface can neither run them nor publish a workflow that reaches them, and an app's page is refused. Granted by the `dream` system workflow alone (and the two reads to strut/knowledge): never by the job, builder or orchestrator seeds, never the builder chat's tools. The capability reads the graph as it is, so each step first asks whether its CALLER may read the graph's own namespace, where the tree is kept (`requireKnowledge`, _shared.ts: `graphFor` + `boundsOf` + `readsNamespace`): on a personal strut an app's page reads `shared` alone and is refused

### `src/steps/lib/dream/`

dream/turns { tree, limit, days } (`sealed`: it reads EVERY person's conversations, `conversations.all()`): the turns no dream has read, oldest first, each with its run (`workflow` + `run`, as knowledge/add-evidence takes them) and the Concept pages that run opened; a WAKE (strut's turn after a job ended) is kept as context with no `said`, with the job run(s) it reports on and the pages each opened, so the reply a person then corrects is in the transcript; a turn in flight and what follows it wait; `text` is the transcript, `cursor` what dream/done takes. dream/done { tree, cursor } (`sealed`): moves the marks, forward only. Marks are bookkeeping, a file per tree (`<dataDir>/dream/<tree>.json`, _state.ts), never the graph

### `src/steps/lib/history/`

history/read (plans/concept-history.md §4): the HISTORY (src/history.ts) as git keeps it, `effect: "read"` — `log { path?, run?, from?, to?, limit? }` (commits newest first: id, time, author, subject, the `Run:` trailers, each changed path with `added | modified | deleted | renamed` + `from`; `run` the commits carrying that run, `from`/`to` a range, `path` followed through renames with `--follow` when it is a file), `show { path, at }` (the file then: `text`, and `parsed` where the package reader parses it — a page through `parseConceptFile`, a type through `parseTypeFile` — or a folder's entries), `diff { from, to, path?, patch? }` (each path that differs, `before` / `after` as `show` gives them, `patch: true` the unified diff), `sync` (a snapshot now, cause `sync`; nothing written in the graph). A commit may be a TIME everywhere (ISO 8601 or epoch ms): the last commit at or before it (`rev-list -1 --before=@<s>`). Read-your-writes: `history.settle()` first. Held to the caller's reader list (`graphFor` + `boundsOf`, graph/scope.ts): `concepts/` when it cannot read the backend's own namespace, `namespaces/<ns>/` for each it cannot, in none of its answers — a commit of only those is not in its log, `namespaces/` is not listed when none in it is readable. No history: `{ history: false, message }`, never a failed run. No route: the step is the door

### `src/graph/claims.ts`

the truth layer (plans/claims.md): Claim/Check/Evidence contract (ids, check subject + result shapes), claimStatus() — status computed on read per (claim, subject) — and ClaimsReader, whose reads are written with the backend's dialect helpers (one reader for Neo4j and a Ladybug file; the evidence joins are four statements joined in TS, never an OPTIONAL MATCH; a filter is in the text only when asked for, never a null param) — ClaimsReader (claimsFor/checksFor/evidenceFor/statusFor; deleted nodes + legacy muted edges invisible). `strut.claims` is null unless the workspace is graph-backed. Four subject kinds, one rule — a run observes each thing it used, at the version it used: `step`, `workflow` (content hashes), `job` (the turn) and `concept` (what opening the page returned; evidence ABOUT the Concept, the version on its source)

### `src/graph/concept-version.ts`

a Concept's VERSION, what a claim about it is versioned by: `conceptVersionOf` (pure: a hash of its name, description and docs and of the name + description of each Concept under it, PARENT_OF, in name order) and `readConceptVersion(graph, ref_id)` (two statements with the dialect helpers, over the graph as it is — a scoped view's unscoped query, `boundsOf`). ONE function for both sides: `graph/graph-get` stamps it on the node it reports when it opens a Concept (`AccessedNode.version`), and `ClaimsReader.activeVersion` computes it now

### `src/graph/claims-writer.ts`

ClaimsWriter: the claim graph's invariants — ≥1 check per claim, edits SUPERSEDE (successor claim carries ABOUT + checks; successor check takes over TESTS), retire = timestamp, detach = deleted edge, last check / last subject refused
