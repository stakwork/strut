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
  on the record (`activeTurnOf`; `ClaimsReader` takes a `jobs` dep for it and reads
  `jobs.runs` — the record's run lines alone, as do `verifyJob`, `jobLedger`,
  `addEvidence` and the authoring's job check: never the whole `get` view),
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
  is the dream (below). ON A CONCEPT BRANCH (below; plans/concept-evals.md
  item d) the claims follow the page by name: a work whose root ran on a
  branch opened the branch's page, and main's claims judge it there. Its
  evidence carries the branch (`SourceContext.branch`, every evidence a run
  on a branch is the source of), and a Concept's status is per (claim,
  subject, branch) — main's counts the works run on main, a branch's the
  works run on it since it was made, at its own page's version — so one
  bad trial never marks main's claim refuted. Not built: Concepts in other
  namespaces, claims travelling with a package's pages, any UI.

- **The dream — a tree of Concepts kept in step with what people say**
  (`src/workflows/system/dream/`, `src/knowledge.ts`, the `knowledge/*` and
  `dream/*` steps). A system workflow, off until its automation is switched
  on (daily, 04:00), one per tree: its input `root` names the tree
  (`Personal` by default) and `review` whether a person accepts each change
  (off by default), so a second tree is a second automation. It is
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
  the page (the claim then reads `refuted` on that version); (3) CHANGES
  the tree as little as would have got it right, with `knowledge/edit-page`
  or `knowledge/add-page` — `graph/edit-node`'s and `graph/create-triplet`'s
  inputs, with the rule for a page from git (below): an edit of one is never
  made in the graph, whatever `review` says, but answered by the step (a
  `knowledge/write-pages` proposal in dev mode or an opened repo, skipped
  elsewhere; `answerGated` answers a reviewed call the same way, so it is
  never proposed as a graph edit), and a triplet that would change one is
  refused; the answer's note says which, and the lesson's `change` says it.
  **Automatic by default** (ruled 2026-11-13: "in
  practice no one should need to review, it should be automatic"; "Main,
  with history"): the change lands as the dream makes it, on the live tree,
  and the history keeps it — the commit carries the dream's run (`Run:`),
  and the run's answer holds the lessons that led to it. REVIEW is a switch
  per tree, the input `review: true` on that tree's automation: the two
  tools then sit under the agent's `approve:` (`input.review ?
  params.review : params.none`), each call records a proposal, its answer
  says it waits (`GATE_NOTE`), and nothing changes until a person accepts
  it in the Knowledge app. The dream's own words (the `Dream` page, the
  prompt, the answer's `change`) hold in both modes. The loop closes in the
  claims layer with nothing of the dream's own: a change, made or
  accepted, moves the page's version, the claim reads `stale`, and the next
  run that opens the page is judged. Nothing caps the changes one cycle
  makes but the agent's 60 model steps (each may carry several tool calls)
  and the lessons it finds (at most 60 turns read, 10 claims written); and
  `dream/turns` reads every person's conversations on the server, so with
  review off anyone the assistant talks to can change that tree. Neither a
  cap nor a rule about whose words count is ruled. A dream
  run on a Concept branch (an eval of the dream, or of a tree) keeps its
  own marks (`<dataDir>/dream/branch-<name>/<tree>.json`), starting where
  main's dream is: it never moves main's. No undo: a change is
  put back by another change (plans/concept-history.md, "Open: Revert in
  the Knowledge app"). **Its rules are Concept pages, not its prompt** (ruling 7 of
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
  a Concept's claims with their status; where its tree is reviewed, the
  dream's changes to it drawn over the page and accepted or rejected there
  by an ADMIN (a proposal made in no conversation shows on strut's own
  pages to an admin, `pageSees`), and what waits across the tree; and,
  afterwards, WHAT THE DREAM LEARNED, cycle by cycle (`knowledge/cycles`,
  an admin's read, below): when each dream ran, its tree, whether it was
  reviewed, its lessons (what a person said, the claim, the change) and,
  opened, the diff of the commits carrying its run (`history/read log {
  run }`, drawn by `ConceptDiff` from the commit before the first to the
  last; commits that land in one window share a `Run:` list, so another
  run's write may show beside it). "Learned" over the graph lists the
  tree's recent cycles; a Concept's card lists those whose lesson is on it
  or whose run changed its page (the `runs` of its own history). Where the
  history is off, the view says so; where review was on, nothing changed
  under the run itself, and what a person accepted is its own `proposal
  <id>` commit. Not built: launching a dream from the app, a chat with the
  tender, sources other than conversations, moving a page, retiring a
  claim, reverting a change from the app.

- **Concept branches — a copy of the tree a run can be pointed at**
  (`src/branches.ts`, plans/concept-evals.md item b; rulings 2, 3 and 10).
  A branch is a named copy of the Concept pages in a graph namespace of its
  own, `branch-<name>`, and (where the history is on) a git branch of its
  name in the history: ruling 2's two halves (item c is the git one, below). `POST /branches { name, from: "main" | "empty" }` copies every
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
  Main never sees a branch: while one exists, a Ladybug search that names
  no namespace leaves `branch-*` out (with none it reads as it always did),
  and the history snapshot (`packageFiles(…, EVERYTHING)`)
  records no branch page.
  CLAIMS FOLLOW A PAGE ONTO A BRANCH (item d; ruling 4, "Shared": the
  claims are the measure, the pages the candidate). No fifth subject kind:
  a work whose root ran on a branch is observed on the branch's page of a
  claimed name (the verify pass's `ours` and `verifyWork` find the page on
  the root's branch, `reader.pageOn`) and judged by main's claims about
  `{ kind: "concept", name }`, its evidence ABOUT main's Concept node with
  the branch's page version and the branch on its source
  (`context.branch`). Status is per (claim, subject, branch): `claimStatus`
  counts only the side it is read on (`evidenceOn`; main is the default
  everywhere it was read: the Knowledge app, `knowledge/claims`, `GET
  /claims`, the ledger, the verify pass), a branch's active version is its
  own page's (`reader.activeVersion(subject, branch)`), and a branch counts
  only works whose root run started after it was made (`reader.scopeOf`:
  run ids are ms start times), so a name made again after a drop starts
  clean. `on_change` asks about the same side, so a branch's copy at main's
  version is still measured on it. In a run on a branch the Knowledge door
  reads each claim's status there, `knowledge/add-claim` writes main's claim
  (refused for a page the branch alone has) and `knowledge/add-evidence`
  records a person's word about the run it cites, on THAT run's branch.
  Only a Concept's status reads per branch: a step's, workflow's or job's
  evidence from a run on a branch carries the branch too, and still counts
  where it always did (ruling 3: those are live on every branch). THE
  COMPARE READ (`knowledge.compare`, the `knowledge/compare` step, `GET
  /branches/:name/compare`): for one page, a tree on main (its root and
  every page under it, `PARENT_OF` read level by level) or every page that
  carries claims, each claim on main and on the branch side by side
  (`reader.compareFor`): each side's page version, status, the verdicts on
  its current page (one per check per work, counted by the database) and the
  newest `works` judged there (`ORDER BY` + `LIMIT`); `changed` when the two
  pages differ, and an `outcome` per claim — `better | worse | same` by the
  share of supporting verdicts on each side's current page, `unmeasured`
  while a side has none (`outcomeOf`) — with totals.
  THE GIT BRANCH (item c; src/history.ts): a create snapshots main and
  starts a git branch of the same name at main's commit then (the fork
  point; a git branch of that name left from before is kept aside first);
  its tree is main's with `concepts/` the branch's pages, so a copy from
  main commits nothing and `from: "empty"` one commit with no
  `concepts/`. A write a run on the branch makes (or a proposal applied on
  it) commits there, by main's rules — only when the tree differs, the
  run's `Run:` trailer, the author, the debounce, `settle` — and never on
  main; a type, claim or check it writes is the live graph's and commits on
  main; a write on main never touches a branch. A branch commit is its last
  tree with `concepts/` swapped (`mktree` over the blobs that changed: one
  read of the branch's pages, never the workspace), so everything else
  stays as at the fork and the branch's change since its fork is
  `concepts/` alone. `history/read` takes a branch's name wherever it takes
  a commit and reads a time on `branch`; `diff { from: "main", to:
  "<name>", path: "concepts" }` is the pages the two hold apart, `log {
  from: "main", to: "<name>" }` the branch's own commits, and `branches`
  each one's fork point (`base`, `merge-base` with main). A drop commits
  what the branch waits to commit, then moves its git branch to
  `refs/dropped/<name>/<time>` (the drop's answer says where, `kept`): a
  record of what was tried, the name free. The Knowledge app's Changes
  takes a branch's name as a moment. With no history, a branch is as in
  (b). MERGE (item e; src/branch-merge.ts, `POST /branches/:name/merge`,
  the `knowledge/merge` step): what the branch changed since its fork —
  `base..<name>` under `concepts/`, pages edited, added or removed and their
  `PARENT_OF` links (a page file's `parents`) — is applied to main, then the
  branch is dropped (its git branch kept under `refs/dropped/`). A page
  main changed too since the fork refuses the whole merge, naming it
  (`merge_conflict:`; both ending the same is no conflict, a page only main
  changed stays). Ordinary pages land at once, one commit (`merge <name>`);
  a page whose text comes FROM GIT (below) is never changed by it — one
  `knowledge/write-pages` proposal per writable checkout, the rest skipped
  and listed; a page the branch ADDS is ordinary, even under a page from
  git. Automatic by default; the step's `review: true` makes the merge a
  proposal of itself an admin accepts first; strut never merges on a score
  by itself. Needs the history; a branch made `from: "empty"` is not
  merged. The branch's evidence stays on the branch: main's new page
  versions start unmeasured. Not built: a per-branch type list, a view of
  the compare or the merge.

- **Trials and tests — how often a rule holds, and whether a change to a
  page makes the difference** (`src/trials.ts`, plans/claim-trials.md; on a
  graph workspace with claims on, `ctx.services.trials`). A CASE is one
  input to a workflow, `{ workflow, input }`: a `TestCase` node (a seed
  type beside `Claim`, src/graph/seed-types.ts: `id`, `name`,
  `case_workflow`, `case_input` as JSON; Epistemic, never embedded) that
  `TESTS` the claims it was written for (`TestCase —TESTS→ Claim`, the
  edge a `Check` uses). Its id is a hash of the workflow and its input,
  keys in any order (`testCaseId`, src/graph/claims.ts), so the same
  message under two claims, in a page's file or typed twice, is ONE node
  with two edges, and writing it again writes nothing. A claim lists its
  cases first written first (`reader.testCasesFor`), at most 20, replaced
  whole by `setCases`: one taken away loses this claim's edge alone, and
  the node, its other claims and every verdict on it stay. A reworded
  claim's successor gains a `TESTS` edge from each of its cases, as from
  its checks (claims-writer.ts `editClaim`). `Claim` gains no attribute: a
  swarm's graph shares that type and strut does not extend it. A TRIAL
  runs a claim's cases as fresh runs, and EVERY claim a case tests judges
  each run of it (`reader.claimsOfTestCase`), so a dear run (a job that
  sets a workspace up) feeds all its claims at once.
  A case whose workflow is a job's (`JOB_WORKFLOWS`, src/jobs.ts: `job`,
  `builder`) RUNS AS A JOB OF ITS OWN: each sample a new job id
  (`trial-<batch>-<hex>`), so a tool that needs a job (a pod's `claim`)
  has one, and once the sample is judged the job is closed as `DELETE
  /jobs/:id` closes one (`deleteJob`: its holds released through their
  steps, then its repositories, directory and record), so a pod a sample
  held is let go and strut knows nothing about pods (the deps' `jobs: {
  workflows, close }`). A job that will not close (a hold that will not
  release) is kept with a warning, and the idle sweep tries again. What
  the job would start is held like any trial's.
  `trial` is a LAUNCH-LEVEL FIELD shaped like `branch` (`RunTrial { case,
  claims }`, src/core.ts: the TestCase's id and the claims it tested at
  launch): on `run.start` and the summary, `ctx.trial`, kept
  by a resume, inherited by every run the run starts (`trackRun`), never in
  `input` and never taken from a request — the trials capability alone
  launches one, through `strut.run`. A trial starts nothing outside itself:
  job/start and job/continue answer `{ held: true, runId: "" }`
  (`launchOnce`; the job launcher refuses `trial_held:` behind it, and the
  orchestrator's result carries the brief it would have started as
  `held`), a gated call records no proposal (`proposeCall` answers as a
  pending one would, `held: true`), strut/run-workflow, remote/call and
  remote/run-workflow throw `TRIAL_HELD`, nothing is scheduled
  (`bindTrial`, runner.ts), and no wake and no callback follow its end
  (`launchDetached`). A shell or the web an agent has is NOT held. Every
  claim a trial's case tests judges it whatever its check's policy
  (`verifyOne`: forced when the claim is among the pass's `trial.claims`;
  every other claim keeps its policy), and every evidence a trial is the
  source of says so (`SourceContext.trial`, and `case`, the TestCase's id,
  on the evidence of each claim it tests). A sample is one run and its
  verdicts; four run at once across everything in flight, and what is in
  flight is in memory only (a restart forgets the samples not yet
  started). Beside its verdicts, a sample says what its run took and cost
  (`ms` and `cost` on a trial's sample in `checks`, from the run's own
  summary: `durationMs`, and `totals.cost`, which counts its sub-agents
  and the runs it waited on), so a change that passes as often in half
  the time shows. Neither is a verdict, and nothing is stored for them:
  the summary is read when the page is.
  A PAGE'S FILE CARRIES ITS CLAIMS: the front matter's `claims:` block, in
  either form of page file (`parseConceptFile` → `ConceptFile.claims`,
  `readPageClaims`, claims-schemas.ts): each claim its `text`, the
  `workflow` its cases run, the `cases`, each that workflow's input, and
  its `checks`, the list a workflow's `claims:` block takes
  (`checkSpecSchema`: a step check `{ type, config, policy, … }`, or an
  external `{ description }`). A claim that names none gets the standard
  check (`conceptCheckSpec`, a model reading the work); one that names a
  step is judged by that step, which a check on a Concept is handed the
  work's root run, its pages and its job's id (`input.job`), so a
  package's step can look at what the work left in the world (a pod's
  image) while the trial's job is still open. As a workflow's block, the
  checks are those a claim was first written with: a change to them is a
  new sentence. Never an attribute, and not part of the page's version, so a new case
  moves no verdict to stale. `seedConcepts` hands a seeded page's block out
  on its outcome, and createStrut records strut's own at boot
  (`trials.seed`, speaker `strut`; `createStrut({ concepts: { claims:
  false } })`, or the same in `STRUT_HOST_CONFIG`, seeds the pages without
  them), by the sentence, so a page's checks match its file: a claim
  already there is kept and the file's cases are linked to it (never
  taken away; two claims with the same message share its node); a claim `strut` wrote on a sentence the file no
  longer carries (reworded, or the block gone) is retired, while a
  person's or the dream's claim on the page is never touched. Every page
  that is the seed's is handed over, with a block or with none. A
  PACKAGE'S PAGES' claims are recorded the same way at its install, by the
  package (src/packages/install.ts, `PackageDeps.pageClaims` →
  `trials.seed`, speaker the package's name, as its workflows' claims are
  published by it): once its pages and steps are in, so a check may name
  a step the package ships; an update retires a sentence the file no
  longer carries; what was not recorded is the install's warning. A page
  the package's uninstall retires takes its claims out of sight with it.
  A TEST is two wordings of one page run against the same checks: the page
  as it is, and the page with a change (`test({ concept, docs, n })`). The
  other wording is read by its runs on a Concept branch made for them
  (`test-<id>`, from main, the page's docs written on it) and dropped when
  the last sample is judged; `sweep` drops what a restart left. The test
  itself is kept (`<dataDir>/trials/tests/<id>.json`: both texts and their
  versions), so its diff and its verdicts stay whatever the page becomes,
  and the same two wordings are always the same test. Every case a check
  on the page is tested by runs `n` samples on the change, ONCE however
  many of the page's checks it tests, and the page is topped up to as many
  runs of it on its wording (a run counts once, whichever of its claims
  judged it; `test({ test, n })`, again: `n` more on both). VERDICTS ARE COUNTED BY TEXT: a page version names one wording,
  and a verdict on it counts from a run on main or from a run on one of
  THAT page's own tests (`verdictsOf`; another branch's works never count
  here). Status keeps reading per side (ruling 4); this is the count the
  app shows. `checks(concept)` is the one read: the page's whole text and
  version, whether its text comes from git, each claim with its cases and
  its verdicts on the page's wording now, each test as the page reads it
  (`orient`: the side whose version is the page's is `page`, the other
  `change`; `live` when one of them is the page now), what is running, and
  `problem`, what the last run left with no verdict (a run that failed, a
  judge that gave none). `use({ test })` puts the other wording on the
  page, when a person asks: an ordinary page is written at once and the
  history told; a page whose text comes from git becomes a
  `knowledge/write-pages` proposal into its checkout (dev mode, a repo
  opened here), or is refused where there is none (below). Nothing decides
  by a score. Taking lines out and getting worse, and changing lines and
  getting better, are the same record read from either side; each test
  also says which side is the wording it `tried` (`change` until it is
  used), and the app draws a piece as added whichever side the page is
  (lib/checks.ts `drawnOf`, docs/apps.md).
  THE DOORS are seven steps, thin over the capability, none sealed (a page
  calls them): `knowledge/checks` (the read, for whoever may read the
  tree) and `knowledge/add-check`, `knowledge/cases`, `knowledge/trial`,
  `knowledge/test`, `knowledge/use`, `knowledge/sample` (a trial run's
  input and output, never a person's own run), which answer ONE caller,
  strut's own page shown to an ADMIN, in the page's own call
  (`requireAdminPage`, as knowledge/cycles): never a workflow, an agent's
  tool, a member's page or a model-written one. The Knowledge app draws
  them (docs/apps.md).
  A TURN ON A KEPT PROMPT OBSERVES LESS: a conversation keeps its first
  turn's system prompt, so when the agent step ran on it and was handed
  another (`session.keptSystem` on its output), the pages `context/concept`
  rendered into the unused one are not observed by that run
  (`subjectsOfRun`); a page the agent opened itself still is. Without it a
  conversation begun before a page changed would be judged against the
  wording it never read.
  Not built: a claim's count with a lower bound and a compare that decides
  by a significance test (plan item 2); a trial launched over HTTP or by an
  eval workflow; a case of more than one message; a test of more than one
  page; retiring a claim or deleting a test from the app.

- **Recent Work — what the person most likely means, in every turn**
  (plans/recent-work.md, 2026-11-24). Strut seeds a root Concept, `Recent
  Work`, and three pages under it, each naming a READ step in its `step`
  attribute: `Recent Apps` (`app/recent`), `Recent Workflows`
  (`meta/recent-workflows`), `Recent Jobs` (`job/recent`). A package adds a
  page the same way: one in its `concepts/` whose `parents` name `Recent
  Work` and whose `step` is one of its own read steps; nothing in
  `strut.yaml`. `context/recent` reads the root's children, runs each
  page's step as the run's person (2 s each; an answer, or a failure as no items, kept 5 minutes per
  person and step; a slow one's answer kept for the next turn; a step that
  is not `effect: "read"` is refused) and renders the root's docs, then each
  page's docs (600 characters) and items, 8 a page and 20 in all. Each step
  lists the person's own first, then what else the server has, so a person
  with no history (or a launch with no person) still sees the server's apps
  and workspaces. The orchestrator and the job put the section at the head
  of the TURN's prompt, and only when it changed: the agent step keeps its
  hash on the turn's line (`tags: { recent }`), and the step answers `text:
  ""` while the thread's last line has the same hash and the turn that sent
  it is still replayed (no compaction since). The page names are `Recent …`
  because a Concept's name is its identity: a deployment's own `Apps` page
  is left alone. On a jarvis-seeded graph (a swarm) `Concept` has no `step`,
  so the pages render their docs with no items.

- **Pages whose text comes from git — never changed automatically**
  (src/concept-sources.ts, plans/concept-evals.md item e, rulings 5–8). A
  page is FROM GIT when main's node carries a seed or package stamp
  (`unique_source_id`): strut's own sets (`strut/concepts/`,
  `strut/concepts/personal/`, the lab's earlier `lab/builder/concepts/` and
  `lab/job/concepts/`), any package's (`pkg/<publisher>/<name>/`), or a
  seeder strut does not know. Neither a merge nor the dream changes one in
  the graph (the next seed would put git's text back, or a package page
  would become a fork nobody chose); `Workflow Builder`, `App`, `Game` are
  not special, they only hold more text. A change to one is a proposal of
  `knowledge/write-pages` (an ADMIN's yes, sealed, runs only as an accepted
  proposal, its door checking the record on disk) where strut has a
  WRITABLE CHECKOUT for it: DEV MODE, strut's own pages with
  `STRUT_DEV_CONCEPTS=1` honoured only when the folder strut seeds them from
  is tracked by a git checkout (under `npm run dev`, the checkout's
  `src/concepts/`; the person makes the PR with their own git — strut never
  commits or pushes there), or a package OPENED HERE AS A REPO (its working
  copy; the repo's Commit then makes the branch and the PR). Anything else —
  strut's pages on a deployed strut, a package installed from an index or a
  `git+` ref, a host's seeder — is skipped, and the answer says why.
  Accepting writes each page's file as its stamp names it, in the form its
  seeder or install reads (`fileText`: the front matter byte for byte when
  only the docs changed, the old `<Name>.md` form kept where the page still
  fits it), then RELOADS that set from there (`seedConcepts`: the node takes
  the file's text and its new stamp); a removed page is a removed file and
  its node retired.

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
  Each Concept branch is a git branch beside `main` (above).
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

the verify pass (plans/claims.md §4): subjectsOfRun (a run's event log → observed subjects + the version each executed), mapCheckResult (the check contract; a check that cannot run writes NOTHING), policyFires (always / on_change / sample / manual), budget (presumed-paid skipped at a cap; a run that reported cost is kept under `check:<id>` and its `reportedCost` added to the check's spend tally, src/check-spend.ts — `costOf`, read on every `GET /claims`, and the per-subject daily cap read the tallies, never the check's runs; a check with no tally yet is recounted from its bucket once, off the request for `costOf`), planned slots for external checks, addEvidence, verifyPublish. A PASS NEVER READS THE HISTORY (2026-11-19, as a status does): whether a check already observed a (run, path) is one statement on the deterministic id (`reader.evidenceStatus`, also verifyPublish's), an explicit job re-verify's `#n` is a count (`evidenceCount`), and the policy (`on_change`'s newest) and an external check's open slots come from `statusEvidence`, read once per claim × subject per pass on the pass's side and again after a write (`evidenceOf`, `wrote`); `addEvidence` reads only the slot it fills (`openSlotOf`: by id, or the newest opened on the cited run). The verify test counts the rows a pass and `addEvidence` read across 3 and 16 passes. Triggered from `services.onRunEnd` for every top-level run and after a kept run_step — a run `launchDetached` started only once strut has decided whether its end wakes a conversation (createStrut's `detachedEnds`), so a work is never judged before the turn that reports on its job; check runs (`origin: "verify"`) are never verified. A run's step, workflow and job subjects are its own; its CONCEPT subjects belong to its WORK (src/work.ts): each pass asks whether the run was the last of its work (`workPasses`, nothing read when no Concept carries a claim) and, once it was, judges the work (`verifyWork`, one at a time per root): the pages any of its runs opened, at the version their reads returned (a page the runs read at different versions is observed at none, `unknown-version`), each check handed the root run, every page the work opened and `work`, its bag carrying `ctx.services.work`; the evidence sourced to the root run. CONCEPT BRANCHES (plans/concept-evals.md item d): a pass is on its run's branch (a work: its root's, `run.start.branch`; the result's `branch`), every evidence it writes carries it (`contextOf`), a claimed page is the one of that name on that branch (`pageOf`, `ours`), `on_change` and a slot read only the same side's evidence (`statusEvidence`'s `side`, `pass.scope`), and `ledger(result)` reads a Concept's status there; `addEvidence` takes the cited run's branch TRIALS (src/trials.ts): a pass over a work whose root is a trial (`run.start.trial`) fires the checks of the claim it replays a case of whatever their policy, and stamps `trial` (and that claim's `case`) on the evidence's source; and `subjectsOfRun` leaves out the pages `context/concept` rendered into a system prompt the agent did not run on (`session.keptSystem`).

### `src/check-spend.ts`

each check's SPEND TALLY: what its kept (paid) runs cost, by the subject each verified — all time (`usd`) and on the newest UTC day it spent anything (`day`, `dayUsd`) — at `<dataDir>/checks/<id>/spend.json`, beside the check's run bucket (`checks/<id>/runs/`). The verify pass makes the tally (a recount of the bucket, when there is none) before the run is in the bucket and adds the run after, one thing at a time per check (`withSpend`), so a recount never counts a run twice; a tally that cannot be written is dropped and recounted at the next read. No file = no tally yet: a check from before it (2026-11-19), whose first read recounts each kept run's log once.

### `src/work.ts`

a WORK (plans/concept-evals.md, rulings 5 and 9): a root run and every run it caused — a child it waited on (`parentRunId`), a job a turn started (`startedBy.runId`), a turn reporting on a job (`wake.runId` + `also`, not another strut's); `run/launch`, an automation's fire and a host's launch start works of their own. `recordCaused`: at each `run.start` (createStrut's `onRunEvent`, only where the claims layer is), and for a job a turn starts already by its launcher before `job/start` answers (its run starts detached, after the turn may have ended and found a work of one run, done — the line a second time reads as one), one line naming the run appended to `<dataDir>/works/<cause runId>.jsonl`; `membersOf` walks down those files, `rootsOf` up the causes (null for a child: its parent's end decides; a wake on two works' jobs is in both). `workDone`: read from the stores each time, so a restart loses nothing — every run that is no child ended (a summary not `waiting`), none still in flight here (`isLive`), and no wake on its way for a job in it (its session's wake file holds it queued, or in a wake turn not ended). `foldWork` → `Work` (each run in start order: how it came about, status, input, result, pages opened, its files' folder — a job's directory, else its artifacts — and what it delivered), `renderWork` (a judge's text, cut in code; a work of one run reads as `context/run` always rendered a run), `workCapability` (what the verify pass puts on a check's bag: the work and a READ of its folders, realpath-contained, text in pieces of 30k, a Word file as text, an image as bytes). Pure parts tested in work.test.ts, the whole in graph/work.test.ts

### `src/trials.ts`

trials and tests (plans/claim-trials.md; "Trials and tests" above): `createTrials({ dataDir, graph, claims, verifier, store, branches?, sources?, history?, hasWorkflow, run })` → `ctx.services.trials`, set by createStrut wherever the claims layer is on, a host's own winning. `checks(concept)` (the one read; a trial's sample carries its run's `ms` and `cost` from the run's own summary, read once a run), `addCheck` (a person's claim with the standard check), `setCases`, `trial({ claim, n })` and `test({ concept, docs, n } | { test, n })` (both return at once with the batch; the samples run four at a time and each is `run` then `verifier.verifyRun`), `use({ test, proposer })`, `sample({ workflow, run })` (null unless the run's summary carries `trial`), `seed(pages, speaker)` (the claims and cases a seeded page's file carries) and `sweep()` (the test branches a restart left). Pure and exported for the tests: `sampleOf` (an evidence row as a verdict, or null when it is none of a check's) and `orient` (a test as the page reads it now). Cases are `TestCase` nodes (above); on disk under `<dataDir>/trials/`: `tests/<id>.json` (a `cases/` folder an earlier strut wrote is read by nothing). Tested end to end on a graph in src/graph/trials.test.ts (a stand-in model: the seeded page's two checks sharing one case node and both judging its runs, a held job, a test whose branch is dropped, a page from git refused, an ordinary page taking the other wording, a job's case run as a job of its own whose hold is released once judged, a reworded claim keeping its cases).

### `src/knowledge.ts`

the KNOWLEDGE door: what a workflow that tends the Concept tree works through (the `dream`), and no workflow of ordinary work holds. `createKnowledge({ graph, claims, verifier, store })` → `ctx.services.knowledge`, set by createStrut wherever the claims layer is on: `page(name)` (one Concept as a TENDER reads it — docs cut at 6,000, parents, the pages under it with whether each carries claims, its claims with their computed status; no version is recorded, so tending is never an observation), `claims()` (every Concept carrying claims, with them, by name: what the Knowledge app scans for the refuted ones), `opened(workflow, runId)` (the pages a run opened, off its log: `conceptsOpenedIn`, verify.ts; null when the log cannot say), `addClaim({ concept, text })` (written at once through a door that sets `ClaimActor.concepts`, stamped `ai`, with the STANDARD check — `conceptCheckSpec`: a `subflow` to the `concept-check` system workflow handed the root run of each work that opened the page (the work itself on its bag, src/work.ts); the same sentence already on the page is that claim; at most `KNOWLEDGE_CLAIMS_PER_RUN`, 10, a run; a sentence holding `{{` refused, since it goes into the check's config) and `addEvidence` (what a PERSON said about a run's work, asserted, through `verifier.addEvidence`: only about a run that opened the claim's page, on that run's branch). `compare({ branch, concept?, tree?, works? })`: main against a Concept branch over the same claims (plans/concept-evals.md item d) — each claim's status, verdicts on the current page and works on each side (`reader.compareFor`), `changed`, an `outcome` per claim (`outcomeOf`) and totals; refuses a branch `deps.branches` does not have. `onBranch(ns)`: the door a run on a branch has — the branch's pages, each claim's status on the branch, a claim added on main's page of the name (refused for a page the branch alone has), sharing main's per-run claim count. A tender never writes a check's config: what it reads is untrusted text, and a check is something strut runs. `cycles({ limit, tree })`: the dream's recent runs that read something, newest first, from the run store (`cycleOf` folds a summary — run, status, times, tree, source, `review`, turns, `more`, lessons with `change` (`proposed` on runs from before review was a switch), `stuck`, error — and leaves out a quiet or parked run; at most 200 runs looked through). Changing a Concept is not here: the workflow's own graph steps change it, and where the tree is reviewed its `approve:` makes each change a proposal

### `src/branches.ts`

CONCEPT BRANCHES (plans/concept-evals.md items b, c): `createBranches({ dataDir, graph, inFlight, history? })` → `ctx.services.branches` (`list`, `get`, `create`, `drop`), set by createStrut on a graph workspace; a branch's namespace is `branch-<name>` (`BRANCH_NAME`: lowercase letters, digits, `-`, `_`, a letter first, at most 56; a new one never `main`, the history's branch). With the history on, a create calls `history.branched` once the pages are copied and before it writes the record (its git branch from main's commit now, before any run can be on it) and a drop calls `history.dropBranch` after the record goes and before the pages do (its last writes committed, its git branch kept under `refs/dropped/`, the answer's `kept`); a history failure is logged and fails neither. `load()` (createStrut, at boot) sets the backend's `branches.held` from the records, what a Ladybug read on main leaves `branch-*` out by; a create sets it before it writes, a drop or a failed create reads it again. Create registers the namespace (Neo4j searches registered ones only), clears what a cut-off create left there, copies the live tree in batches of 200 (`writeMany` upsert, `embed: "later"`; every declared attribute but `unique_source_id`) and its `PARENT_OF` edges, then writes the record; a copy that fails is cleared. Drop removes the record first (a run that starts from then on finds no branch), then every node in the namespace (`DETACH DELETE`), and on Neo4j unregisters the namespace. `bindBranch(services, branch)`: the run's view of the bag (the runner, beside `bindPrincipal` / `bindGraph`; an accepted proposal made on a branch too) — `graph` held to the branch (`onBranch`, src/graph/branch.ts), `knowledge` reading the branch's pages and each claim's status there (`KnowledgeCapability.onBranch`; item d), the automation steps' `create`/`update`/`fire` refused; on EVERY run, `sessions` refusing a conversation whose first turn ran on another branch and stamping each committed turn with the run's. `branchOfServices`: the branch a bag is already on — a run launched with a step's `ctx.services` is on it (runner.ts). `merge(name, { actor?, run?, by?, dryRun? })` (item e): inside the branch's lock, refused while a run on it is in flight (a dry run is not), `mergeBranch` (src/branch-merge.ts), then the drop (`dropLocked`, the drop's own body) — its answer `dropped`; deps `sources` (src/concept-sources.ts) and a history that `settle`s, `sync`s, `git`s and `touch`es. Tested on both engines in graph/branches.test.ts and graph/branch-merge.test.ts

### `src/branch-merge.ts`

MERGE a Concept branch into main (plans/concept-evals.md item e): `planMerge` — the history settled and synced (main's commit is the live tree), the fork point `merge-base main <branch>` (refused when that commit is newer than the branch: its git branch was made later, with the history off), the branch's changes `diff --name-status --no-renames base <branch> -- concepts/`, main's `diff --name-only base main`, each changed file read at base and at the branch (`git show`, `parseConceptFile`); a path main changed too is a CONFLICT unless main's file is the branch's (`MergeConflict`, the names, 409) — then each edited or removed page's main node asked whether its text comes from git (`sources.fromGit`). `landPages`: the ordinary pages on main through the raw backend — an edit `nodes.update` with the attributes the branch dropped removed, an add `upsert` (a deleted node of the name restored), then the links (`parents` added since the base written, dropped ones deleted; a parent main lacks is a note), then the removals (`deleteNode`). `mergeBranch`: plan, a dry run's answer (the checkouts it would propose to, no record), else land — one `merge <name>` touch and a settle, whatever stopped it — and `sources.propose` for the pages from git. `MergeRefused` (409): no history, a branch made `from: "empty"` (against its fork it removes every page main has). The branch's evidence is not copied: main's new versions start unmeasured

### `src/concept-sources.ts`

PAGES WHOSE TEXT COMES FROM GIT (plans/concept-evals.md item e, rulings 5–8): `createConceptSources({ graph, dataDir, own?, dev?, repos?, proposals?, history? })` → `ctx.services.conceptSources`, set by createStrut on a graph workspace. `parseStamp` (`<prefix><file>@<hash>`), `fromGit(names)` / `fromGitByRef(ref)` — main's live nodes carrying a stamp, each a `PageSource { name, set, file, checkout?, why? }`: strut's own sets (an earlier seeder's `legacyPrefixes` read as strut's) with `checkout: "strut"` only in DEV MODE, a package's `pkg/<p>/<n>/` with `checkout: <package>` only when it is opened here as a repo (`repos.isOpen`), anything else skipped with why. `pageOf(name)`: main's page as a page file holds it (`conceptPageFile`, packages/build.ts), what the dream's edit is laid over. `propose(changes, { by, cause })`: one `knowledge/write-pages` proposal per checkout (`approver: "admin"`, a card naming the checkout, the pages and why), the rest `skipped`. `write(input, { proposal })`, the door: the accepted record on disk for this very input (`stable` JSON) or `write_pages_needs_person:`; the checkout resolved again (`no_checkout:` — dev off, the repo closed or waiting on a merge); each page's set held by that checkout and its file a bare `<name>.md`; the file written in its form (`fileText`: the front matter byte for byte when its values did not change, the old `<Name>.md` form where the file is named by the page and it still fits, else `renderConceptPage`) or removed; the touched sets reloaded (`seedConcepts`: strut's own set as it is, a repo's `{ dir: <working copy>/concepts, prefix: conceptPrefix(pkg), keepEdited, adopt }`), removed pages retired (`retireConcepts`), the history touched (`proposal <id>`). `devConcepts(sets, env)`: at boot, `STRUT_DEV_CONCEPTS=1` and the sets whose folder holds pages `git ls-files` lists (never a build's copy, an image's or a dependency's); createStrut says in one line when the flag is set and not honoured. Tested on both engines in graph/branch-merge.test.ts, the dream's side in graph/dream.test.ts

### `src/ledger.ts`

the ledger (plans/claims.md §5): buildLedger (claims per subject with computed status + each check's lastVerify: pending | ran | skipped | planned), subjectsOfFlow (what a launch can execute), the [verify-notification] text. The forcing function — the model reads its contract in a tool RESULT, not an instruction

### `src/claims-routes.ts`

the Claims panel's HTTP door: GET /claims?kind=&name=&branch= (contract + computed status + latest evidence + open slots; with `branch`, a Concept's status on that Concept branch; `{ enabled: false }` on a filesystem workspace), GET /workflows/:name/evidence (the run view: every verdict on a workflow's runs — its claims and its steps' — keyed by the run, `limit` counts runs; mounted before the `/:version` catch-all), POST/PATCH/DELETE /claims[/:id], /claims/:id/{attach,detach,checks,evidence}, PATCH/DELETE /checks/:id. Mutations behind requireApiKey; the actor is a PERSON (unscoped, stamped `person`; evidence `asserted`, `by: person`)

### `src/history.ts`

the HISTORY (plans/concept-history.md items 2–3): the whole workspace as a package directory (`packageFiles(…, EVERYTHING)`, packages/build.ts) committed to a bare git repository, `<dataDir>/history.git` (branch `main`; its work tree `history.git/work/`, inside it so it moves and is backed up with it), each time strut hears a write. TOUCHES: a run's or a proposal's graph view flushing a write a snapshot records (graph-writes.ts `historyRecords`: never a flush of instances alone), the workspace store `watch`ed once in createStrut (a publish, a change of the active version, a delete, an app release — never metadata a package does not carry), an install or uninstall `hold`ing the queue so what it publishes is one commit under `install <package>@<digest>`, `start()` at the end of the boot (cause `boot`; createStrut awaits it, so a strut that answers has its boot commit), `sync`. One in-process queue: a snapshot a second after the last touch (five at most after the first), each file written into the work tree only when its bytes changed (sha1 by path, read from disk on the first snapshot), nothing spawned when nothing did; else `add -A`, `write-tree`, and when the tree is not `main`'s, `commit-tree` + `update-ref`: author the actor who wrote (`strut` for boot and sync), email `history@strut.invalid`, the first line the first cause, the others below, one `Run:` trailer per run whose flush touched since the last commit, the date in whole seconds. A failed snapshot is logged, never a run's failure; the next is whole. Every git command on one repository runs on one in-process chain, and what the process knows of the repository (the work tree's sums, `main`'s commit and tree) is kept per repository, so two struts over one data directory never race; a data directory that vanished is not made again. A `WholeMemo` keeps the reads by version label / content hash (workflows, steps, app sources) and the installed pins until the workspace or a hold drops them, so a snapshot on a quiet workspace is three listings and the Concept and type reads. `settle` flushes every view with writes waiting and runs the queue now (what `history/read` does first); `git(args)` runs a READ command for it. git through `runProcess` (shell.ts) with the binary `findGit` found on PATH — on macOS `/usr/bin/git` only when `xcode-select -p` answers, so a boot never raises the Command Line Tools dialog — and no system or user config, hooks or signing. `openHistory`: off with `history: false` / `STRUT_HISTORY=0`, with no graph, or with no git (one boot line). `ctx.services.history` is its reads and touches (`HistoryCapability`), never `hold` or `close`. CONCEPT BRANCHES (plans/concept-evals.md item c): each is a git branch of its name (`refs/heads/<name>`); the queue keeps a pending snapshot, debounce and timer per target — main, or a branch a touch names (`HistoryTouch.branch`, set by graph-writes.ts for a run's or a proposal's view on a branch: a page or a `PARENT_OF` link there, `historySides`) — on the one chain. A branch's snapshot reads only the branch's pages (`conceptFilesOf`, packages/build.ts), hashes them in process (git's blob id), writes the blobs that changed in one `hash-object -w --stdin-paths`, and builds the tree with `mktree`: its last tree's root entries but `concepts`, kept in the per-repository memo with `concepts/`'s blob ids, and the new `concepts/` — then `commit-tree` on the branch's last commit and `update-ref` with the old value. Its memo is read back from the ref (`ls-tree`) on first use, so a restart carries on; a git branch missing for a branch that exists (made with the history off) is made at main's commit then. `start()` catches up every branch after the boot commit (cause `boot`). `branched(name, touch)`: views flushed, main snapshotted (`sync`) — the fork point is the live tree — any git branch of that name kept aside, then the branch's first snapshot under the create's cause (`branch <name> from <main|empty>`): from main nothing commits, the ref is main's commit. `dropBranch(name)`: views flushed, the branch's pending snapshot run, its touches dropped from then on (`gone`), and its ref moved to `refs/dropped/<name>/<YYYYMMDDTHHMMSSmmmZ>`, the memo forgotten. Readers may run `merge-base` and `for-each-ref` too

### `src/concept-seed.ts`

Concept files → `Concept` nodes on either engine: seedConcepts(graph, sets) — a set is a folder of pages + a stamp prefix, a page in either FORM (`parseConceptFile`, plans/concept-history.md §2.1): the old `<Name>.md` (named by its file; front matter `description`, one `parent`) — strut's own pages, every package published before — or the new one, told apart by `name` in the front matter (named by it whatever the file; then every attribute, then `parents`, every parent by name; `renderConceptPage` writes it, what a package build puts under the node key; `NOT_ATTRIBUTES`, what the graph or a seeder stamps or derives, never an attribute), body = docs either way; an attribute the graph's `Concept` does not declare is left out, one log line (`declaredAttributes`); each page reconciled by `unique_source_id = <prefix><file>@<hash>` (create; keep when the node holds the file's text; update when the file changed — or when the node's docs or an attribute the page sets were edited in the graph: a seed always matches git, so every boot puts them back; a deleted page of ours restored; someone else's or unstamped skipped; `legacyPrefixes` = an earlier seeder's stamps counted as ours), a `PARENT_OF` from each parent (a page of another call or already in the graph), an undeclared `PARENT_OF` between two pages the call owns removed — so a package's page under strut's `Job` keeps its edge through strut's every boot, `retired` files soft-deleted while they carry their stamp (`retireConcepts`). A set with `keepEdited` (a package's, src/packages/install.ts) keeps a page of its own whose text was edited in the graph — the outcome says `edited` — takes a deleted node under a page's name, and counts a stamp of any of its files as its own (a page a release moved to another file — the old form rebuilt under its key — is written again). Engine calls only (readByKeys / the writers / liveEdgesOfMany), no Cypher, and BATCHED (2026-11-10: a package's tree is hundreds of pages — openlaw/legal-desk's 752 took 19 s on Neo4j and 28 s on Ladybug one page at a time, about 1 s now): every page's node in one read per 250 names (`findConcepts`), the creates and updates 250 at a time (`writeMany`, `embed: "later"` — the vectors left to the backend's background embedder), the parents' live `PARENT_OF` edges in one read, only the missing edges written and the undeclared ones removed from that read; a failed batch is written again page by page, so a failure stays that page's outcome, and a name two pages share is seeded after the batch, in order; `progress` reports `pages` / `edges` done of total; one summary log line. createStrut seeds STRUT_CONCEPTS at boot on a graph (`concepts: false` seeds none); a host seeds its own sets with the same call afterwards and anchors pages from the outcomes it returns A page's front matter may carry a `claims:` block (plans/claim-trials.md §3; `readPageClaims`): read into `ConceptFile.claims`, never an attribute (`NOT_ATTRIBUTES`), a block that is not one left out with a warning and the page still seeded; a page that is the seed's (created, updated or kept) hands it out on its outcome (`ConceptSeedOutcome.claims`) for the caller to record.

PAGES READ FROM THEIR FILES (2026-11-24): `conceptFiles(sets)` → `ctx.services.conceptFiles` (`get(name | ref)`; createStrut sets it over the sets it ships, graph or not) — a set's pages parsed once, each with the pages that name it as a parent, under a ref of its own (`file:<prefix><file>`, never a node's). `graph/graph-get` answers a Concept BY NAME from it where no graph holds the page: with no wired graph (no connection attempt), and when the graph read comes back a failure (no such node, no `Concept` type, a read that threw), in the step's own shape with `source: "file"` and `children` on `PARENT_OF`. So `context/concept`, which reads through that step, renders a page strut ships on a server with no graph (`STRUT_WORKSPACE_BACKEND=fs`), and an agent opens the pages under it with the tool it always uses. A node the graph holds always wins: a page someone took over is theirs. Reads only: writing a page, a package's pages, claims and the dream need a graph. This replaced the orchestrator's `params.rulesText`, a copy of its page kept in the workflow for the same case.

### `src/concepts/`

the Concept pages strut SHIPS (copied into build/ by `npm run build`): `Workflow Builder` (what the builder's prompt reads, and since plans/one-job-agent.md a kind of job, UNDER `Job`: what is built here; the page the stakgraph lab seeded first, whose stamps `lab/builder/concepts/` + `lab/job/concepts/` count as strut's. As a job's kind its page is cut at 6,000 characters, so its three sections on a `human` step moved, word for word, to `Worker Tasks`, and it says to open that page before writing one) and `Job` (what the job workflow puts in its agent's prompt, `context/concept`: the kinds of work, and since 2026-11-24 the job agent's INSTRUCTIONS, moved from `job.yaml`'s `params.system` — running a workflow, earlier jobs, no browser of its own, done means verified with one claim per change and a check that uses the work as its user would) — roots, workspace-general; each deployment grows the tree under them — ONE TREE PER AGENT: `Job` is the job agent's and `Workflow Builder` the builder's, and the orchestrator reads the kinds under BOTH (`docs: false`) as its two lists, so a kind the builder builds is listed under `Workflow Builder`, never under `Job` (`Workflow Build`, the builder's entry under `Job` while the orchestrator read `Job` alone, is `retired` in `STRUT_CONCEPTS` and soft-deleted at boot; `Job`'s own docs tell a job agent that meets a workflow or an app that lives in a workspace to run `builder` through meta/run-workflow) — and `App` UNDER `Workflow Builder`: the builders' manual (layout, kit, hooks, grants, routines; hand a published app over BY NAME, `{ kind: "app", app }`), and `Game` UNDER `App`: a game as an app — the `game` starter, the loop, input, assets as imports, physics, scores, the look with `window.__debug`; and `Workflow Language`, with no parent, so no prompt lists it (the `Job` page tells the job agent to open it by name): the builder's rules (strut's workflow dialect, the authoring tools, the procedure, then what a build owes) rendered for the `job` agent from src/ai/prompts.ts, the one page whose file is written by a script (`npm run render:concepts`, held to the source by src/ai/prompts.test.ts; docs/builder.md, plans/one-job-agent.md §2); and `Worker Tasks` UNDER `Workflow Builder`: work by people — the page the orchestrator opens (it holds graph/graph-get, and its two lists say how to open a kind's page) before a build of that kind, so the person settles in one message what is theirs: when there is work (any time, a standing type; or one for each item, a `human` step in a run), who (only people they invite, or anyone with the link), the pay in dollars — then what they do once it is built (approve, add money in Earnings, invite in Workers, try it; for work one for each item, ask the assistant to send a round, which a job starts), in their words with no workflow names, inputs or limits, an app pointed to as an artifact, and for the builder how each decision maps onto the type, and that the person's reports stay out of the worker app: `App`'s "Worker apps" says why — a worker app goes public with every workflow it grants, runs and all, so hiding a tab behind `useHost().public` locks nothing) — and `Plan` UNDER `Job`: work too large for one job, or that the person wants planned first, whatever it is made of — code in repositories, workflows and apps here, documents; its description, the line the orchestrator routes by, says a JOB writes the plan and runs it (plans/orchestrator-plans.md) — a plan job keeps ONE `plan.md` (overview, work items, contracts, open questions each with a default, progress) and builds nothing; the person reads its reply alone, an overview and the questions, and "go" takes every default; the questions are the few whose answer would change the plan, often three or four (a typical count, never a cap: a large plan can have ten real ones; what the person knows and the job cannot see, what changes what gets built or how much), put so someone who has never built software can answer them unless the request shows the person builds software, and sent as the reply's `ask` since the job cannot go on without the person's go; every other choice, how it is built above all and whatever the brief lists, the job decides and records under Decided in `plan.md`, where a developer reads the detail (an orchestrator's brief that listed "unit conversion, stock tracking, saving past days, scaling" drew 6 to 8 questions before, 3 to 5 after); and it plans the smaller version (what exists, what can wait, what nobody asked for) and says in its overview what that leaves out (2026-11-22); after go it names one item at a time, which the orchestrator's wake turn starts as a job of its own and hands back when it ends, and it checks what that job made against the plan, from the job's work rather than its report; a plan need not be about code, so the page speaks of a repository in ONE sentence that applies only to work in one (one branch there for the whole plan, ending as one pull request) and an item names repositories only if it has any; the page holds no rule per failure (access control built too deep, a migration nobody needs): they are the CASES of its first claim, run as trials; a second claim (questions about what gets built, never how, in words the person can answer, and a smaller plan offered) has a case from a bakery owner — and `Dream`, the dream's own tree (a root; what holds for any source: the posture, what a lesson is, where it goes — and where a change to a page from git is skipped, the change goes on a page under it, the workspace's own, so a deployed box still learns about a page strut ships, 2026-11-22) with one page per KIND of source under it, `Assistant Conversations` the first (what `dream/turns` hands over: what to look for in it, which run a person's words are about): the dream's rules, read by the `dream` workflow, not its prompt. Like every page here they are the fixed base every strut ships (`Job` → a kind, `Workflow Builder` → `App`, `Dream` → `Assistant Conversations`); what a workspace learns grows in the pages around them. `Job App`, the job side of an app, is `retired` too (2026-10-22): a page over a job's own results is an HTML file in its directory, an app is the builder's, and `Job`'s docs say to pass the builder's app deliverable on `Orchestrator` (a root, plans/claim-trials.md §1): the orchestrator's RULES, the judgment that was `orchestrator.yaml`'s `params.system`, moved as it was; the workflow reads it with `context/concept` (`frame: false`) so every turn opens the page and a claim on it judges the turn, and where no graph holds the page the step reads this file (`conceptFiles`), so the workflow carries no copy of the text. `Browser` UNDER `Job`: looking at a site or a running app — `browser-explore`, what it answers, where its screenshots land, and the captcha a person solves (`browser-captcha`, the `[captcha-answer]` turn); `Job`'s docs keep one paragraph (no browser of your own, open this page), since a rule three pages down was once never read (2026-10-08). Its front matter carries its two checks and the case that tests each ("Can you use bash?"): it says yes and offers to do it, never that it lacks a shell, files or the web; and it never tells the person how it works (jobs, background tasks). They were one claim until its last clause ("never explains how it is built") was judged both ways on near-identical replies (2026-11-20); the old sentence is retired at boot.

### `src/steps/lib/context/`

context/recent { name, session? }: the Recent Work section (see "Recent Work" above): `{ text, hash }`, `text` ending with a blank line so a template puts it first as it is, `""` with no root, and with `session` while that thread already has it (`alreadySent`: its last turn line's `tags.recent` is the hash and the first of the trailing lines that carry it starts at or after `replayFrom`); `recentOutput`, the `{ items: [{ name, what?, at?, link? }] }` shape a page's step answers; `renderRecent`, `capRecent` (past 20 the last item of the longest page goes first: a page's fill before its person's own), `recentItems` pure and tested in recent.test.ts, the three strut steps in recent-pages.test.ts. context/concept: a Concept as an agent's context — the page's docs (capped at 6k) and the name + description of each Concept under it (PARENT_OF), read through graph/graph-get and rendered as a system-prompt section, framed as the workspace's notes, with how to open a child page (`tool`: the agent's name for graph-get; `""` for an agent with none). `docs: false` renders the kinds under the page ALONE — for an agent that routes BY them rather than follows a page's convention; nothing under the page is `""`. The builder's default `chatSystem` is this step on `Workflow Builder`; the `job` workflow puts `{{ concepts.text }}` after `params.system` on `Job`, the `orchestrator` the kinds alone under `Job` and under `Workflow Builder` (`docs: false`, `tool: ""`). A page strut SHIPS is always there: where no graph holds it (no wired graph, no such node, a read that failed) graph/graph-get answers with the page's file (`ctx.services.conceptFiles`), so the same section renders on plain files and the pages under it open with the same tool. `{ text: "" }` without the page — never a failed run, never a Neo4j-from-env fallback (with no wired graph only a shipped name is read). Not under `graph/`, so a `graph/*` grant does not hand it to an agent. context/run: a run as a JUDGE's context — what it was asked, what it returned (or the error it ended in) and the Concept pages it opened, as one block of text cut to its head and tail in code (12,000 characters by default), so a large output never reaches a prompt whole; inside a check the verify pass runs over a WORK it renders that work instead, from `ctx.services.work` (src/work.ts `renderWork`), never from its input; unsealed (the `concept-check` workflow's first step, which an `ai`-stamped check must be able to reach). context/work-file { path, from? }: one file or folder of the work a check judges (`<folder>/<path>`, `""` lists the folders), read through `ctx.services.work` — which only the verify pass sets, so no input points a read elsewhere; read only, the work's own folders, symbolic links resolved; text in pieces, a Word file as text, an image SHOWN (`withMedia`); refuses outside such a check. The standard judge's one tool; unsealed `frame: false` is for a page that IS an agent's rules and that strut ships (the orchestrator's `Orchestrator`): the page's docs alone, as they are, no frame and no kinds, up to `max` characters (6,000 by default, the orchestrator asks for 20,000); the read is still graph/graph-get's, so the run opened the page at a version.

### `src/steps/lib/knowledge/`

the Knowledge door as steps (src/knowledge.ts), thin over `ctx.services.knowledge`: knowledge/page { name, text? } (`effect: read`: a Concept as a tender reads it; `text: true` adds it as one block for a prompt; reading a page this way is not opening it), knowledge/claims (`effect: read`: every Concept carrying claims, with them — the Knowledge app's), knowledge/compare { branch, concept?, tree?, works? } (`effect: read`: main against a Concept branch over the same claims, `compare()`; plans/concept-evals.md item d), knowledge/cycles { tree?, limit? } (`effect: read`: what the dream learned, cycle by cycle, `cycles()`; its lessons quote the conversations the sealed dream read, so it answers ONE caller: strut's own page (`isFirstParty`) shown to an ADMIN, in the page's own call (`RUN_STEP_FLOW`) — the viewer who sees the dream's proposals (`pageSees`); a workflow, an agent's tool, a run a page launched, a member's page or a model-written one is refused `is an admin's`, before anything is read; not `sealed`, since a sealed step is refused to every app), knowledge/add-claim { concept, text } and knowledge/add-evidence { claim, workflow, run, supports?, said, by? } — both `sealed: true`, so the meta surface can neither run them nor publish a workflow that reaches them, and an app's page is refused. Granted by the `dream` system workflow alone (and the three reads to strut/knowledge): never by the job, builder or orchestrator seeds, never the builder chat's tools. The capability reads the graph as it is, so each step first asks whether its CALLER may read the graph's own namespace, where the tree is kept (`requireKnowledge`, _shared.ts: `graphFor` + `boundsOf` + `readsNamespace`): on a personal strut an app's page reads `shared` alone and is refused ITEM E: knowledge/edit-page and knowledge/add-page (`sealed`, `effect: write`) are how the dream changes the tree: `graph/edit-node`'s and `graph/create-triplet`'s own inputs, cards and runs. The rules for changing a Concept page are `graph/edit-node`'s own, so every writer (the dream, the assistant, an app) follows them (src/steps/lib/graph/_concept-page.ts, plans/dream-memory.md): a page that already has docs is changed with `edits` (exact-match `{ property?, old, new }`, `old` found once, src/graph/text-edits.ts) and refuses a whole new `docs` in `node_data`, so a line a writer failed to copy is never lost; and a page whose text comes from git (src/concept-sources.ts) — on main (never on a branch, where every page is a copy), an edit of such a page is laid over its page file and becomes a `knowledge/write-pages` proposal (dev mode, an opened repo) or is skipped (`status: pending | skipped | unchanged`, a `note` the lesson's change repeats; a rename of one is skipped), and a triplet that would change one (naming it inline, or `target_ref_id` moving it under a parent) is refused; `answerGated` (StepDef, agent.ts, on `graph/edit-node` and so on edit-page) answers a call a review gates the same way, so a page from git, or an edit that would be refused, is never proposed as a graph edit; edit-page adds only its sealing and the tree check (`requireTree`); the Knowledge app and the kit's concept diff read them as the graph steps they wrap. knowledge/write-pages { checkout, pages: [{ name, set, file, text? }], cause } (`sealed`, `approver: "admin"`): the apply of such a proposal, ONLY as one (`ctx.proposal`), through `conceptSources.write`. knowledge/merge { branch, review? } (`effect: write`, `approver: "admin"`, not sealed, granted to nothing): an eval workflow's door to `branches.merge` — refused in a run on a branch; `review: true` makes the merge a proposal of this step (its card from a dry run: what lands, is proposed, is skipped; a conflict refuses it before anything is proposed) The checks and tests of a page (src/trials.ts, thin over `ctx.services.trials`, none sealed): knowledge/checks { concept } (`effect: read`), and six that answer strut's own page shown to an admin alone (`requireAdminPage`, _shared.ts): knowledge/add-check { concept, text }, knowledge/cases { claim, cases }, knowledge/trial { claim, n }, knowledge/test { concept, docs, n } | { test, n }, knowledge/use { test } and knowledge/sample { workflow, run } (`effect: read`). Each throws the capability's refusal as its error.

### `src/steps/lib/dream/`

dream/turns { tree, limit, days } (`sealed`: it reads EVERY person's conversations — the ones written since its mark, `conversations.changed(since)`, never every record): the turns no dream has read, oldest first, each with its run (`workflow` + `run`, as knowledge/add-evidence takes them) and the Concept pages that run opened; a WAKE (strut's turn after a job ended) is kept as context with no `said`, with the job run(s) it reports on and the pages each opened, so the reply a person then corrects is in the transcript; a turn in flight and what follows it wait (its end writes the record again); `text` is the transcript, `cursor` and `since` what dream/done takes — `since` ten minutes before it began reading (a record stamped just before the read may reach its day log just after), or, when the limit left turns, the oldest write of a conversation that holds one. dream/done { tree, cursor, since? } (`sealed`): moves the marks, forward only, and keeps `since` (none given: the last). The next dream/turns asks only for the conversations written since then; the first, its `days` window; a state from before `since` was kept, every conversation, once. Marks are bookkeeping, a file per tree (`<dataDir>/dream/<tree>.json`, _state.ts), never the graph; a dream on a Concept branch reads and moves its own (`<dataDir>/dream/branch-<name>/<tree>.json`, `branchOfDream`), starting from main's, and a branch made again under the name (another `createdAt`) starts from main's again

### `src/steps/lib/history/`

history/read (plans/concept-history.md §4): the HISTORY (src/history.ts) as git keeps it, `effect: "read"` — `log { path?, run?, from?, to?, branch?, limit? }` (commits newest first: id, time, author, subject, the `Run:` trailers, each changed path with `added | modified | deleted | renamed` + `from`; `run` the commits carrying that run, `from`/`to` a range, `path` followed through renames with `--follow` when it is a file), `show { path, at }` (the file then: `text`, and `parsed` where the package reader parses it — a page through `parseConceptFile`, a type through `parseTypeFile` — or a folder's entries), `diff { from, to, path?, patch? }` (each path that differs, `before` / `after` as `show` gives them, `patch: true` the unified diff), `sync` (a snapshot now, cause `sync`; nothing written in the graph), `branches` (main and each Concept branch's git branch: `name`, `head`, `time`, `base` — where it forked from main, `merge-base` — and `dropped`, each kept one with its `ref`; plans/concept-evals.md item c). A commit may be a TIME everywhere (ISO 8601 or epoch ms): the last commit at or before it (`rev-list -1 --before=@<s>`) on `branch` (main by default) — or a BRANCH's name: its last commit (`main`/`HEAD`; a Concept branch's name before a commit id it also reads as). So `diff { from: "main", to: "<branch>", path: "concepts" }` is the pages the two hold apart, `log { from: "main", to: "<branch>" }` the branch's own commits; `log`'s default `to` is `branch`'s last commit. Read-your-writes: `history.settle()` first. Held to the caller's reader list (`graphFor` + `boundsOf`, graph/scope.ts): `concepts/` when it cannot read the backend's own namespace, `namespaces/<ns>/` for each it cannot, in none of its answers — a commit of only those is not in its log, `namespaces/` is not listed when none in it is readable; a Concept branch, a copy of the backend's own pages, is not listed or taken as `branch` for a caller who cannot read them (its commits change `concepts/` alone, so none is in such a caller's log). No history: `{ history: false, message }`, never a failed run. No route: the step is the door

### `src/graph/claims.ts`

the truth layer (plans/claims.md): Claim/Check/Evidence contract (ids, check subject + result shapes), claimStatus() — status computed on read per (claim, subject), a Concept's per (claim, subject, branch) (`evidenceOn`: main's works on main, a branch's since it was made; plans/concept-evals.md item d), and ClaimsReader, whose reads are written with the backend's dialect helpers (one reader for Neo4j and a Ladybug file; the evidence joins are four statements joined in TS, never an OPTIONAL MATCH; a filter is in the text only when asked for, never a null param) — ClaimsReader (claimsFor/checksFor/evidenceFor/statusFor — `{ branch }` reads a Concept's on a branch —, `pageOn` a branch's page of a name, `scopeOf` when a branch was made (deps `branches`), `compareFor` a Concept's claims on main and a branch, each side its status, the verdicts on its page counted by the database and its newest `works`; deleted nodes + legacy muted edges invisible). A STATUS NEVER READS THE HISTORY (2026-11-19: swarm38's `GET /claims` peaked at 248 s, evidence grows with every verify pass): `statusFor` and `compareFor` read `statusEvidence`, the evidence `claimStatus` decides from and no more — every open slot; of the counted evidence, each stream's newest measurement (its newest evidence and the rest of that evidence's source) and each check's newest about the active version (what `unverified` asks). `scoped` asks the database what `measured` keeps — ABOUT a version of the subject, from an active check or none, and for a Concept on the side read (its source's `context` JSON matched as text: `"version":`, `"branch":"<b>"` or none; on a re-made branch `src.run_id >= since`, run ids being ms start times of one length); one statement per stream kind finds each stream's newest second (`max(observed_at)`, and the newest on the active version), one the sources of evidence at those seconds, and the rows read are the evidence at those seconds or of those sources (and any with no `observed_at`, which strut never writes). The database still walks the claim's edges; what crosses the wire and is joined in TS is bounded, and the claims test counts the rows read across 10 and 40 passes. `evidenceFor(claim, subject)` reads the whole history, the subject filtered in the query: no request or pass reads it. The verify pass's point reads are on `scoped` too: `evidenceStatus` (one Evidence's status by id, one statement), `evidenceCount` (one check's evidence on one version, one statement) and `openSlotOf` (a planned slot by id, or the newest on a run). `strut.claims` is null unless the workspace is graph-backed. Four subject kinds, one rule — a run observes each thing it used, at the version it used: `step`, `workflow` (content hashes), `job` (the turn) and `concept` (what opening the page returned; evidence ABOUT the Concept, the version on its source)

### `src/graph/concept-version.ts`

a Concept's VERSION, what a claim about it is versioned by: `conceptVersionOf` (pure: a hash of its name, description and docs and of the name + description of each Concept under it, PARENT_OF, in name order) and `readConceptVersion(graph, ref_id)` (two statements with the dialect helpers, over the graph as it is — a scoped view's unscoped query, `boundsOf`). ONE function for both sides: `graph/graph-get` stamps it on the node it reports when it opens a Concept (`AccessedNode.version`), and `ClaimsReader.activeVersion` computes it now

### `src/graph/claims-writer.ts`

ClaimsWriter: the claim graph's invariants — ≥1 check per claim, edits SUPERSEDE (successor claim carries ABOUT + checks; successor check takes over TESTS), retire = timestamp, detach = deleted edge, last check / last subject refused
