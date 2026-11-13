# Jobs, conversations, wakes and proposals

Jobs (one directory and memory across runs), the job index and threads, conversations and the wake, live feeds, proposals, and the workflows strut seeds.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **One wake — a conversation hears its job's reply** (`plans/jamie-app.md`
  §1; `src/wake.ts`). A job turn that ends naming a conversation on this
  strut (job/start's `startedBy.session`, a host launch's `conversation`, or
  `POST /conversations/wake` for a job on another strut) runs one more turn
  of the conversation's workflow, its prompt the template's `params.wake`:
  Hive's web chat, a tribe, a call and Peel's DM all get the same wake, so
  no host keeps its own. The job's run.end says `wake: "launched" | "capped"
  | "none"`; the wake turn's says `wake: { job, runId }`; the 202 of a
  conversation launch says `wake: true`, which is how a host knows to stop
  waking itself (§7). Specs: `CALLBACKS.md` §9, `API.md` §3.

- **Jobs — one directory and one memory across many runs**
  (`plans/jobs.md`; `src/jobs.ts`, `src/artifact-refs.ts`, `steps/lib/job/dir.ts`).
  A host hands strut work as a *job*: `POST …/run { job: "<id>" }` — a
  flat, global id the CALLER mints (the session-id format), beside `input`
  and `callback`, never in `input`. It is recorded on `run.start` and the
  summary, handed to every step as `ctx.job`, seen by templates as
  `{{ $job }}` (always a key in scope — `undefined` on a plain run, so
  `session: "{{ $job }}"` is a cold agent then, not an error), and kept by a
  durable resume. `job/dir` returns `<dataDir>/jobs/<id>/`, the SAME
  directory for every run of the job, held by one run at a time
  (`job_busy:`; a child run launched by `meta/run-workflow` shares it — the
  child carries the job, and `holdJob` walks `ctx.control`'s parent chain;
  a run that parks lets it go while it waits, and a wake — any durable
  resume — takes it again where `job/dir` replays, waiting for a run that
  took the job meanwhile instead of failing: `reholdJob`, `StepDef.onReplay`),
  and the generalization of yesterday's `workdir`:
  `git/checkout { workdir: "{{ $job }}" }` checks repositories out INTO it,
  the idle sweep removes those and keeps the job's own files. So a job
  workflow is `job/dir → agent (cwd: the dir, session: "{{ $job }}") →
  pack`, and turn twelve opens the `plan.md` turn three wrote with a
  transcript that remembers writing it; without a job the same YAML is a
  one-shot in the run's artifact dir. **Deliverables** are declared in
  the run's OUTPUT, `artifacts: [{ id, kind?, title, path | url | content }]`
  (`specs/CALLBACKS.md` §4): the `run.end` callback (and `GET
  …/runs/:runId/artifacts`) carries them resolved — `path` →
  `/jobs/<id>/files/<path>` (served like `/artifacts`, sandboxed) or
  `/artifacts/<runId>/<path>`, `kind` from the extension when omitted, an
  `error` when a file is not there — while `output` stays as packed. The
  same `id` on a later run is a newer version of the same thing; one live
  file behind one link is the contract (no snapshots). The job agent is the one
  WORKFLOW strut SHIPS, `job` (`src/workflows/job.yaml`, seeded at boot by
  `createStrut` through `src/job-seed.ts` — moved out of the mcp lab's seed
  on 2026-10-13: every job primitive was already strut's, and a standalone
  strut had a Jobs sidebar with nothing to run in it); its `params.tools`
  grow on the swarm, and a host appends its own grants and prompt section
  through `createStrut({ job: { tools, system } })` — the lab adds `pod/*`,
  a desktop strut adds nothing. A `context/concept` step reads the `Job`
  Concept (seeded by strut, `src/concepts/Job.md`; `params.concept`) and the
  kinds under it into the end of the agent's system prompt, the way the
  builder's prompt reads `Workflow Builder`, so the agent sees them before
  it acts and opens the matching page: which workflow does which kind of
  work is its children, graph data, never prompt text. The thread keeps its
  first turn's prompt, so a job keeps the list it began with. The host's
  side (mint an id, launch, store the refs, proxy a link) is closed by design.
  **Holds** (§6): a tool that claims something that must outlive the run —
  a pod — records it on the job through `ctx.services.jobs.hold(job, { id,
  kind, release: { type, input } })`, naming the registry step that lets it
  go; the tool that releases it calls `release`. Strut runs the release
  steps (a bare type's active version, under a minimal context: the bag,
  the registry, the job) when the job is deleted — `DELETE /jobs/:id`,
  which then removes repositories, directory and record; 409 while a run
  holds it, 500 and nothing removed when a hold will not release — and
  from the idle sweep, which lets holds go before it removes repositories
  (a hold that fails stays for the next sweep; a bare run with no registry
  leaves jobs with holds alone). Strut knows nothing about pods: a hold is
  an id, a kind and a way to be released.
  **The index** (plans/job-index.md; `src/job-index.ts`): a job you can
  name, find and read back. `POST …/run { job, title }` names it — the
  title is a launch-level field like `job` and `callback`, never in `input`
  (the workflow's `input:` block would strip it, and strut must write it
  onto the record without knowing the workflow); the RUNNER records every
  run launched under a job as one line on its record, at `run.start`,
  through `ctx.services.jobs.recordRun` (children with `parentRunId`;
  a resume records nothing), so a job's record is the job's history and the
  sweep keeps one that has runs. A session's turn line records the `job` it
  was made under (`SessionInfo.jobs`). `GET /jobs?q=` and `GET /jobs/:id`
  read it all back — runs with status, threads, holds, files, and the
  job's CURRENT deliverables folded from its runs' outputs (the "same id =
  newer version" rule of §3 made real: newest run first, first id wins,
  nothing stored) — and `job/list` / `job/get` / `job/read` are the same
  reads as steps the job seed grants, so a turn can find an earlier job by
  words, see what it produced, look at a screenshot it took, and learn the
  thread id to continue. On a graph workspace the projector stamps `job` on
  `StrutRun` / `StrutAgentSession` and upserts one `StrutJob` node per job
  (title + a summary of its deliverables and latest reply; `IN_JOB` from
  each run) in the run-end hook, so `graph/graph-search` finds a job by
  meaning. Each current deliverable is a `StrutArtifact` too (one per job
  and artifact id, the fold's newest version: `HAS_ARTIFACT` from the job,
  `DELIVERED` from each run whose output declared it; another strut
  server's deliverable and one with an `error` are left out). Not
  yet: `job` on chats, a jobs sidebar, continuing ANOTHER job's thread from
  inside a turn (its files are in the other directory; `session_busy:`).
  **An app reaches a job BY NAME** (2026-10-22): the `builder` publishes
  it and lists `{ id, kind: "app", title, app: "<name>", version? }` in
  its reply, resolved to the version's document with `app: { name,
  version, hash, builtAt }` (artifact-refs.ts); a job that ran the builder
  passes the entry on, and a page over the job's OWN results is an HTML
  file in its directory. The `Job App` kind and the job seed's `app/init`,
  `app/build`, `app/get` are retired — three doors to an app confused the
  orchestrator; the job-app RUNTIME went after it (a directory's own
  identity and narrowed token, the implicit own-job grant, "Publish as an
  app" — plans/chained-orchestrators.md §6): a `{ kind: "app", path }`
  entry is an error saying to hand the app over by name.

- **Live feeds — what a job and the graph are doing, for a reader that
  cannot be called** (`plans/live-feeds.md`; `src/live-feed.ts`,
  `src/graph-writes.ts`). A host hears a job on its `jobCallback`; an app's
  page can open no connection and has none. So every `job.update` is also
  KEPT (per job, the newest state of each thing, in memory) and read with a
  cursor that may WAIT — `job/updates` / `GET /jobs/:id/updates`, kit
  `useJobUpdates` — and every graph write a run makes through strut's
  writers is HEARD: `bindGraph` wraps the run's `services.graph` writers,
  the run's job gets `job.update { kind: "graph" }` (cumulative, a second
  after the last write and at the run's end — which is what makes Hive's
  canvas re-read the cards a brainstorm just wrote, not when the job ends),
  and the deployment's `graphChanges` feed keeps ids, types and time for
  `graph/changes` / `GET /graph/changes` / kit `useGraphChanges`, whoever
  wrote. A run says what it is doing with `job/status { title }` (`kind:
  "status"`, one line per run). Cursors are `<epoch>.<seq>`: a restart
  empties the feeds and the next read says `reset: true` — a feed is a
  notification, never the record. Not heard: raw Cypher, another process's
  writes.

- **Jobs sidebar — the operator's view of a job** (`plans/jobs-sidebar.md`;
  `src/job-threads.ts`, `web/src/components/JobTimeline.tsx`). The first-class
  item in a job is a THREAD, not a run: `GET /jobs/:id` folds every agent
  execution in the job's runs' logs — a `step.end` carrying `messages`, or an
  attempt of the core `agent` step — into threads by session id (a cold agent
  is a thread of one), each turn pointing at its run and step path with its
  usage, cost, context, tool calls, transcript link and the artifacts the run
  declared, and under it what it spawned (a sub-agent by path, a child run by
  `parentRunId`, a `strut/run-workflow` peer run). Nothing in it names a
  workflow or a step id, so the seed can rename `work` and the view holds. An
  agent strut did not run (the pod's goose) is a tool call until its step
  marks its output with `withMessages`; then it is a row like any sub-agent.
  The UI: the sidebar's history panel — ONE slot below Workflows, **Runs |
  Jobs** in its title row, the two lists sliding between them, the mode
  remembered in localStorage (`historyMode`), both scoped to the selected
  workflow (`GET /jobs?q=&workflow=`) — the timeline in the canvas area when
  a job is selected (the workflow stays selected underneath as that filter,
  so the list you clicked in never reshuffles; `timelineOpen` = a job and no
  run, and the topbar is the job's then; a run opened from it keeps the job
  for the breadcrumb, `?job=` deep-links), a read-only thread view in the
  flyout (the chat's renderer, lifted into `Transcript.tsx` /
  `transcript.ts`), and a job chip on a run's row. No send box: a host
  launches turns.

- **Proposals — a tool call a person approves before it runs**
  (`plans/proposals.md`; `src/proposals.ts`, the `agent` step's `approve:`).
  Jamie's `propose_*` tools, generalized: there are no proposal TYPES. An
  `agent` step names registry steps in `approve:` beside `agentTools`
  (globs as there; `params.approve` on the `job` and `orchestrator` seeds,
  filled by the host's delta — `createStrut({ orchestrator: { approve } })`,
  `STRUT_HOST_CONFIG`'s `approve`). A gated tool keeps its name and schema
  (plus `rationale`), but a call does not run the step: the gate parses the
  input with the step's own schema (a bad one is refused to the model as a
  direct call would be), writes the record to `<dataDir>/proposals/<id>.json`,
  journals the call at `<agent path>#<call>` (a resumed turn gets the same
  proposal), tells the job's host (`job.update { kind: "proposal" }`) and
  returns `{ proposal, status: "pending", url }` — the turn goes on (no
  `withStop`; ending the turn stays the automation steps' and Peel's device
  requests' way, for a decision awaited inside the turn). The same step is
  an immediate write in a janitor automation and a proposal in a chat; the
  WORKFLOW decides, never the model. A person decides at `POST
  /proposals/:id/decide { action: accept | reject, input?, reason? }` —
  hive's card, strut's own run overview and job timeline, a host's route —
  and on accept strut runs the step then and there with the recorded input
  (the person's edits merged one level and re-parsed by the step's schema;
  400 and still pending when they do not fit) under a minimal context
  (`releaseWith`'s: the bag with `secrets` bound to the proposing run's
  principal, the registry, the job, the decider as `ctx.actor`, the run's
  MCP servers best effort), recording `result: { output | error }`; reject
  records the reason and runs nothing. A decided proposal is final (409 with
  the record — a double click does nothing twice); a `failed` apply may be
  accepted again. Never a model turn: the proposing SESSION is told on its
  next turn, in code — one `[proposal-result] <id> applied|rejected|failed ·
  <step> "<title>"` line per decision before the prompt, stamped
  `reportedAt` when the turn commits. `run.end` carries `proposals:
  [{ id, step, title, status, url, rationale? }]` beside `artifacts`, from
  the records (`GET …/runs/:runId/proposals` is the same list; `GET
  /proposals?job=&session=&runId=&status=`, `GET /proposals/:id` the
  records — a person token (`peer:person`) lists only the proposals of its
  own threads (`by.conversation`, else `by.session`, is `<actor>` or
  `<actor>/…`: a proposal shows where it was made, so a Hive chat's is
  answered in Hive and never listed to the person's device), decides only
  its own, and reads any by id, as it already reads every run's log and a
  job's files, plans/proposal-links.md; the plain `peer` none); the
  `proposal/list` + `proposal/get` steps are the agent's reads; `proposal/decide` is strut's own app's door (first-party only). **Only an
  ADMIN accepts some** (plans/member-rights.md): a step with `approver:
  "admin"` (`StepDef.approver`; `package/install`, `package/commit`, `remote/buy-credit`, `task/set-type`) is accepted only
  by full scope — the key, an admin's session, a host's server with the
  key; a member's session (Jamie's `proposal/decide`) or a person token
  gets `403 admin_required:` and may still reject (`acceptRefusal`). The
  app door stamps `AppRef.admin` when the connection holds full scope, and
  it rides on every run the page launches; a turn whose person is KNOWN not
  to be an admin is refused the proposal itself (`proposeCall` →
  `adminStanding`: `ctx.app.admin`, else createStrut's `personIsAdmin` over
  the root's `run.start` — `origin: peer`, an app turn, `startedBy`, a
  wake), since a proposal shows only where it was made and nobody there
  could accept it. The record and brief carry `approver`; a page's
  `proposal/get` adds `viewer: { admin }`, and Jamie's card says "An admin
  must approve this" in place of Accept. The host's
  card renders by `step` — `graph/create-node`'s input is what hive's
  `graphNodeCreate` card draws — and a generic one from the
  step's schema (`GET /steps/:type/schema`). V1 gates the graph and Concept
  writes (`graph/create-node`, `edit-node`, `create-triplet`,
  `create-batch-triplet`, `move-node`, `delete-edge`, `delete-node`; a
  Concept is a node of type `Concept`); hive-owned rows (initiatives,
  milestones, prompts) come later as lab `hive/*` steps with nothing new
  here. Not yet: MCP tools behind the gate (the apply would need the
  launch's credential), a step's `describe` hook for a card's preview,
  `approveWait` (a decision awaited inside the turn), expiry, grouping
  (`after`). **In the graph** each proposal is a `StrutProposal`
  (`projectProposalOnce`, graph/projector.ts): a projection of the record,
  written when the call is made, again when its run ends (`IN_RUN` the
  run) and at each decision and apply (`ACCESSED` to each node the apply
  wrote that the graph holds) — the title, step, rationale, who and what
  was decided, never the input or the result. The record stays what every
  list reads; the node is for what points at a proposal and for search
  (`graph-search { types: ["StrutProposal"] }` finds one by why it was
  made). `graph/project` backfills the proposals of the runs it projects.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/system-workflows.ts`

SYSTEM WORKFLOWS: the built-in automations strut ships, one folder each under src/workflows/system/<name>/ (`workflow.yaml` + `automation.json`), installed at boot as category `system` at version `s-<content hash>` (a seed always matches git) with the automation OFF; an existing automation is never touched. A folder with no `automation.json` is a workflow something else runs (`concept-check`): installed the same, with none. `SYSTEM_WRITER` (`janitor`): who a write from inside one is recorded as

### `src/jobs.ts`

the job directory (plans/jobs.md): `<dataDir>/jobs/<encoded id>/` + its record beside it (usedAt, the repos checked out into it), held by one run at a time (`job_busy:`; a child run launched by `meta/run-workflow` shares it — its controller descends from the holder's; `reholdJob` takes it again for a run a durable resume replays past `job/dir` or a kept `git/checkout` — their `onReplay` — and waits while another run holds it, told at once when it goes), the idle sweep (holds released, repositories removed, files kept), HOLDS (plans/jobs.md §6: `ctx.services.jobs.hold/release/holds` — what a tool claimed that outlives the run, a pod, recorded with the registry step that lets it go; `releaseWith` runs it under a minimal context from the sweep and from `DELETE /jobs/:id` → `deleteJob`), `withLock` (the in-process keyed mutex the git steps share), the file listing/path guard the `/jobs/:id/files` routes use, `JOB_WORKFLOWS` + `turnOf` (the job-shaped workflows a job's turns may run — `job`, `builder` — and the job's newest such run: what `job/continue` launches and `GET /jobs/:id` reports as `workflow`), and LIVE UPDATES (plans/live-artifacts.md: `setJobCallback` keeps a launch's `jobCallback` in `jobs/.callbacks/`, never in the record; `notifyJob` / `ctx.services.jobs.notify` POST `job.update` there, ordered per job and coalesced per thing; holds and the verify pass announce themselves, a hold's update naming the job's turn in flight through the `runOf` seam; the jobs a run starts through `job/start` / `job/continue` INHERIT the launching run's `jobCallback` — kept beside its log by `RunStore.setRunJobCallback`, so a jobless orchestrator turn carries one for the jobs it starts, CALLBACKS.md §5); every update is also KEPT, callback or not, in a per-job feed (`readJobUpdates`, src/live-feed.ts, 200 things a job, in memory) that `ctx.services.jobs.updates`, the `job/updates` step and `GET /jobs/:id/updates` read — how an app's page, which cannot be called, follows its jobs (plans/live-feeds.md §1)

### `src/live-feed.ts`

`LiveFeed` (plans/live-feeds.md): the newest state of each thing, in the order things last changed, for a reader that asks "what changed since my cursor?" — `<epoch>.<seq>` cursors (another process's, or one past what the feed dropped, reads everything with `reset: true`; `"now"` is the feed's position), `wait` held on a promise (≤ 55 s) and answered a second after the first new thing (`FEED_GATHER_MS`), so a reader asking again on each answer makes at most a call a second. In memory: a feed is a notification, never the record. `evictable` picks what goes first when it is full, `remove` takes things out with no change, `readNow` answers in the same tick. Used by a job's updates (jobs.ts), the graph change feed (graph-writes.ts) and channels

### `src/proposal-feed.ts`

the PROPOSAL FEED (plans/live-feeds.md, "Proposal feed"): a LiveFeed of proposal EVENTS — `created`, `decided`, `applied`, `failed`, the event read off the record's status — one per change, never folded, 1 000 kept, the envelope only (id, status, kind, title + summary cut at 200, actor, time; never the input). createStrut makes ONE and pushes every record the proposals' `changed` hook is told of, beside the `StrutProposal` projection, so proposals.ts knows nothing of it; read by `GET /proposals/changes` and `proposal/changes` (`ctx.services.proposalChanges`), scoped by `visibleTo` like the list

### `src/proposals.ts`

PROPOSALS (plans/proposals.md): a tool call a person approves before it runs. A step's `describe(cfg, ctx)` (§7, built 2026-10-29) runs at proposal time, best effort, and its `title` / `summary` go on the record for the card (`package/install` reads the package's page off the index); its `input`, when it gives one that the step's schema parses, is the input KEPT on the record — the one asked with a default read now filled in (`app/make-public` pins the app's version live when asked), so the yes applies what the card showed. The `agent` step's `approve:` list (beside `agentTools`) gates registry steps: a call to one records a proposal — `<dataDir>/proposals/<id>.json`, moved to `proposals/archive/` once decided (rejected, applied, failed): the step type, the input the step's schema parsed, the model's `rationale` (added to the gated tool's schema), who proposed it (run, path, job, session, actor, principal) — journaled at `<agent path>#<call>` so a resumed turn finds it, and returns `{ proposal, status: pending }` to the model, which goes on. `decideProposal` is the person's door (`POST /proposals/:id/decide { action: accept | reject, input?, reason? }`): accept APPLIES the step in code — the recorded input with the person's edits merged and re-parsed by the step's schema (a bad merge is 400, still pending), under a minimal context (`releaseWith`'s shape: the bag with secrets bound to the proposer's principal, the registry, the job, the decider as `ctx.actor`, the run's MCP servers best effort), the result or the error on the record; reject records the reason; a decided one answers 409 with the record, a `failed` apply may be accepted again. Every list (`listProposals`: `GET /proposals`, a run's, `run.end`, a conversation's turns, the session's `[proposal-result]` lines, `after`) filters an IN-MEMORY INDEX — each record less its payloads, `by` whole, loaded once per process by one pass over both folders and kept current by every write — so only the matches are read; what a request may see (`visibleTo`) is decided on the index too, before `limit`. `run.end` carries `proposals: [brief]` from the records, `GET …/runs/:runId/proposals` the same; a job run's host gets `job.update { kind: "proposal", state }` at each change; `ctx.services.proposals` is the record's writer and reads (the `proposal/list` + `proposal/get` steps). The proposing SESSION is told on its next turn, in code: `[proposal-result]` lines before the prompt, stamped `reportedAt` once the turn commits — never a turn of its own. No proposal types: the step is the contract `requireApproval(type, ctx)`: a step that reaches past this strut (`strut/run-workflow`) refuses unless it runs as an accepted proposal (`ctx.proposal`) whenever a host delta's `approve:` names it — so the builder's `remote` branch (`job/start { peer }`, `meta/run-workflow` with `input.peer`) and `meta/run-step` cannot reach a peer around the gate; no host gate, no change.

### `src/job-index.ts`

the job INDEX (plans/job-index.md), the read side of jobs.ts: createJobIndex({ dataDir, store, sessions, sealed }) → list (every job newest-used first, each with `workflow` — the newest turn's, `turnOf` — when it has one, `q` through src/search.ts over the title + current deliverables, `workflow` keeps the jobs with a recorded run of it — the sidebar's filter; `actor` the jobs that actor launched a run of — the record's `actors`, `GET /jobs?mine=1`, the sidebar's user icon) / get (runs with status from the run store, threads from the session store — a turn line's `job`, or a thread named after the job — holds, files, and the ARTIFACT FOLD: the successful top-level runs' `artifacts[]` newest first, the first of each id winning, resolved like …/runs/:runId/artifacts — so a turn that ran on a peer (the `builder`'s `remote` branch) folds the peer's deliverables tagged, never `not found`; a sealed workflow's run shows its status and nothing more) / read (one file: text head+tail-capped, an image as bytes for withMedia). createStrut builds it into `ctx.services.jobs` beside the record's writes; `GET /jobs[/:id]` and the job/* steps are thin over it; the projector builds `StrutJob` from `get`

### `src/job-subject.ts`

what a JOB check reads (plans/job-claims.md §3) — PURE: buildJobSubject(view, { runId, dir, output? }) → `JobCheckSubject`, the job's STATE from the index's view (dir, repos, the artifact fold, holds, `urls`, the turn's output, the latest reply) as the check step's run input, so a check's config says `url: "{{ input.urls.pod }}/settings"` or `cwd: "{{ input.dir }}"`. The verify pass builds it once per pass (`jobInputOf`) for every check on a job subject — in place of the step subject's log-derived input

### `src/job-threads.ts`

the job's THREADS (plans/jobs-sidebar.md §1): foldJobThreads — every agent execution in a job's runs' logs (a `step.end` carrying `messages`, or an attempt of the core `agent` step) grouped by session into threads, each turn with its run, usage, cost, the thread's context after it (from the session's turn line), tool-call count, transcript link (`?full=1` for a session turn), the run's declared artifacts (on its last top-level turn), and under it what it SPAWNED: a sub-agent by path, a child run by `parentRunId` (hung on the tool call whose output names its run id), a `strut/run-workflow` peer run (one whose output names its session there joins that thread, `@<peer>/<session>`, so a build on a peer is one thread); a step the gate skipped is no turn; a run with no agent is one turn of `stepType: "run"`. Pure; `GET /jobs/:id` serves it as `threads` (`?threads=0` / `?nodes=1` / `?limit=`), the web's Jobs sidebar renders it

### `src/job-seed.ts`

the ONE workflow strut ships, `job` (plans/jobs.md §5): seedJobWorkflow — createStrut publishes src/workflows/job.yaml at boot by content hash (`publishWorkflowByContent`, `source: "seed"`; a seed always matches git: a new text publishes + activates the next version, a text seen before — a delta taken back out, a template reverted — is made active again, and a workspace edit lasts until the next boot), with the HOST's delta applied first — `createStrut({ job: { tools, system } })`, the twin of `chatSystem`: grants appended to `params.tools` (the lab's `pod/*`), a section appended to `params.system` after strut's (what the deployment adds — which workspace, which peers); the merged text is the hash. Exactly one seeder per name. `job: false` seeds nothing

### `src/orchestrator-seed.ts`

another workflow strut ships, `orchestrator`: seeded exactly as `job` (templateWithDelta from job-seed.ts), with the same host delta — `createStrut({ orchestrator: { tools, system } })` (Peel adds sphinx/*, calendar/*, its automation steps; the lab adds its graph reads, gated writes and its lookups, `explore` + `logs`). `orchestrator: false` seeds nothing. `personalOrchestratorSystem(person)` is the section a PERSON's own strut (a laptop, the desktop app) appends (plans/chained-orchestrators.md §1): its peers are the person's orgs, a turn decides where a request belongs (this machine, or which org), hands an org's to that org's `orchestrator` through `strut/run-workflow { …, input: { prompt, session: "<person>/<org>" }, room: true }` and relays the reply word for word

### `src/wake.ts`

ONE WAKE (plans/jamie-app.md §1): a job turn (`JOB_WORKFLOWS`) that ends naming a conversation here — job/start's `startedBy.session`, or a host launch's `conversation` (`POST …/run { conversation }`, full scope) — or a host's `POST /conversations/wake { session, source, end }` (a job on ANOTHER strut, its run.end from that strut's room) runs ONE more turn of the conversation's workflow on its session: `input: { prompt, session, context }`, the prompt the workflow's own `params.wake` filled by `wakePrompt` (an `{each}…{/each}` section per job: its reply inline, capped at 6 000 chars, between markers it cannot close; its question; how to continue — job/continue, or the go-ahead to `@<source>`'s assistant; `{silent}` = `[silent]`), the context's `line` the time now in the person's latest turn's `timeZone`, then its `where` (`wakeContext`; a person's turn reads `line` alone, so a host keeps its medium there too), that turn's `params.model`, the job run's actor and principal, the callbacks of the person's latest turn that has them. `jobEnded` → `launched | capped | none`, decided BEFORE the job's run.end goes out (it carries `wake`). Gates: once per job run (`seen`); queued while the session is held or a run launched on it is in flight, every waiting end ONE turn; `max` wake turns since the person's last (turn lines' `wake: true`) → capped; the host did not ask (opt-in per launch: `POST …/run { wake: true }` on the person's turn that started the job — a job a wake turn started, the person's latest — or on the host's own launch of the job beside `conversation`; recorded as `run.start.wakeAsked`; the door is a host asking) → none; a relay (a turn of `origin` peer or app — a person token's) → none; a workflow with no `params.wake` → none. Durable: `<dataDir>/wakes/<session>.json` before launch, cleared when the turn ends (a `session_busy:` failure requeues), `reconcile` at boot after the runs scan (`STRUT_AUTO_RESUME`). The wake turn's `run.start` and run.end carry `wake: { job, runId, peer?, also? }` (`WakeMark`, core.ts; `ctx.wake`, so the agent's turn line says `wake: true`); the 202 of a launch of a `params.wake` workflow on a session says `wake: true`. `createStrut({ orchestrator: { wake: false, wakeMax } })`, STRUT_HOST_CONFIG's `orchestrator`. Pure parts tested in wake.test.ts

### `src/conversations.ts`

CONVERSATIONS (plans/jamie-app.md §2): the assistant's chats as a person reads them, for a host and strut's own app alike. A conversation is a session whose turns run a workflow with `params.wake` (`isConversationFlow`; never under `peer/` or `app/`); its TURNS are its runs read back (`input.prompt` or a wake's mark, the reply's `text` / `ask` / artifacts resolved, on a wake what the job run it woke on delivered (`delivered`, read from that run), the proposals it made, the jobs it started or continued — `turnJobs`, the kit's `assistantJobs` logic, each with the workflow the launch returned — its status while in flight; a settled turn read once per process). Several people may share one (ruled 2026-11-04): listed for whoever took a turn (actor, else principal), the actor its id is under (`<actor>/…`) and whoever opened it while `shared` (readable to any actor here). Files under `<dataDir>/conversations/` on every backend: `sessions/<id>.json` (title — the first message, Hive's `@<workspace>` line left out, `titleOf` — renamed, shared, forkedFrom, viewers, its turns as run ids with who, when and status, the jobs its turns started or continued — read from each turn's log when it ends, a record from before them filled in the background at its next list — `rev`), `shared.json` (the shared ones' ids: every actor's list shows them, `team: true`, until they open one), `viewers/<actor>.json` (a person's list: each row the record's facts copied, plus their own archived + seenAt, so a list reads one file), `built.json`. Written by createStrut's launcher when a turn LAUNCHES (before its run starts) and ENDS (`launched` / `ended`; the end from the run's terminal event, `RunOptions.onEvent`, before the summary is written) — a failed turn commits nothing to the session, and still shows. A session from before the index is built from its turn lines (`SessionStore.turns`): when read, and all at once at the first list. `get { wait, since }` holds until `rev` moves; fork copies the source's session turn by turn (`appendTurn` per line: the agent remembers) under `<actor>/<hex>`. `ctx.services.conversations`; the `conversation/*` steps and `GET /conversations`, `GET /conversations/item?id=`, `POST /conversations/update`, `POST /conversations/fork` (specs/API.md §9.1) are thin over it. In the graph a conversation is a `StrutChat` of `kind: assistant`, projected from its record with each turn's run (`record` / `conversationRecords`, the projector's reader; never built there)

### `src/artifact-refs.ts`

deliverables (plans/jobs.md §3): a run output's `artifacts: [{ id, kind?, title, path | url | content, render?, from? }]` resolved to links for the `run.end` callback and GET …/runs/:runId/artifacts — `path` → `/jobs/<job>/files/…` (a job run) or `/artifacts/<runId>/…`; `kind` from the extension when omitted (the host's renderer names). `kind: "app"` is strut's own, two forms: `app: "<name>"` (+ `version?`) is an app PUBLISHED in the workspace — the builder's deliverable (2026-10-22) — resolved to the version's document (`/apps/<name>/<vN>/files/dist/index.html`, the active version unless named; `appVersion` → `apps.versionDir` + `dist/build.json`) with `app: { name, version, hash, builtAt }` beside the url, `no such app: …` otherwise; a `path` is no app — an entry with an error saying to hand it over by name (a JOB's app directory is retired, plans/chained-orchestrators.md §6). An entry tagged `peer` (another strut's — strut/run-workflow tags them, plans/builder-job.md §3) is left as it came: its `path` (in `job`'s directory THERE) and `url` the peer's, no link made here, no `not found` — the reader resolves it against the peer by id (the handle rule, plans/federation.md §2.2). The WORK-PRODUCT kinds (plans/work-products.md): `sheet`, `table`, `timeline`, `docx`, `redline` (`.docx` → docx, `.csv`/`.tsv`/`.xlsx` → table), `render` (a file a page draws in the thing's place, resolved like `path`, left out when missing), `from` (the graph ref_ids it was made from → `StrutArtifact -[:DERIVED_FROM]->` each node the graph holds, projector.ts); `liftedArtifacts` — what a tool's result declared, put on its `step.end` by `wrapToolsWithEmit`

### `src/workflows/`

the workflows strut SHIPS (YAML, copied into build/ by `npm run build`): job.yaml — job/dir → checkouts (git/checkout into the job dir) → the `Job` page → the KIND's page (`input.kind`, a page under `Job`: rendered at the head of every turn's PROMPT, so the agent starts from the kind's convention instead of having to open it; nothing without one) → agent (session: the job, structured { text, artifacts, ask? }; git/checkout among its tools, so a repository it finds it needs mid-turn — a private one too — is checked out into the job dir with the person's token, which bash never holds) → pack; every step strut's own. orchestrator.yaml — one turn of a long conversation: job/dir (no job → the run's artifact dir) → context/concept twice (the CHILDREN of `Job` — the kinds of work a job does here — and of `Workflow Builder` — the kinds of thing the builder builds — `docs: false`, no `tool`, for the end of the prompt, so the turn routes a request by kind: a job's passed as `kind` on job/start, a build's named in the brief) → agent (session: input.session, one per conversation, compacted in place; its prompt is the first turn's; toolFilter [none], job/start, continue, list, get, read + strut/list-peers + strut/run-workflow (a peer's workflow, inside the turn) as tools, job's reply shape) → pack; `peer: person` (another strut launches it only through a person's credential, on that person's own session — plans/chained-orchestrators.md §2). The turn is the conversation, the work is a job's: it answers from what is already KNOWN, ASKS what a request needs answered first, may run a LOOKUP the deployment grants (a workflow that returns an answer, here or on a peer) to ORIENT — its answer the reply only when it is the whole answer, else a job's brief — and starts jobs detached for anything to be found out or made (one sentence: to build, change, test or debug a workflow, or an app that lives in a workspace, start the job with `workflow: builder`, `peer` when it belongs on another strut — `builder` a field value, never a noun the person hears; one more line: talk to the person in their words, never the names of tools, workflows or the lists — the rule itself rides on job/start's schema, and what the builder builds here is the second list). params.tools + params.system + params.wake (the prompt of the turn strut runs when a job a turn started ends, src/wake.ts) are the evolvable surface; `context: { line, where?, timeZone? }`: `line` heads the prompt; `where` (the medium alone) and `timeZone` are read by the wake only, which puts the time and `where` in its own `line`. builder.yaml — a workflow BUILD as a job (plans/builder-job.md): job/dir → context/concept on `Workflow Builder` → if (`input.peer`) → agent (session: the job; toolFilter = params.builtins, the web tools and the editor family; agentTools = meta/* + app/* + the graph reads + job/list, get, read + git/checkout; system = the chat builder's rules in the twins' names around the job's own text; job's reply shape) | strut/run-workflow (the PEER's `builder` under this job id — the build happens there, this run waits and reattaches) → pack (+ `peer`); `peer: true`. private-ask.yaml (privacy/anonymize → llm → privacy/deanonymize; an llm error destroys the vault and is the run's error), image-gen.yaml (input `prompt`, `model` — default `xai/grok-imagine-image` — → `image` → pack: `{ image, model, cost, artifacts: [{ id: image, kind: image, title, path }] }`, so its launcher, a stranger's public run included, gets the file), browser-capture.yaml / browser-explore.yaml / browser-captcha.yaml / browser-watch.yaml — the browser workflows (src/browser/seed.ts): one declared browser/capture call (its `claims:` block checks the PNG on disk), an agent whose tools are `browser/*` (on a captcha it keeps the page for the job and stops, `captcha: { session }`), one round of a captcha a PERSON solves on that kept page (crop + manifest to ask; tap / type the answer, verify, look — never solved by the agent), a scheduled region reader that diffs against `last`. `system/`: the SYSTEM WORKFLOWS (src/system-workflows.ts), one folder each — `tidy-memory` (merges duplicates in a person's memory), `dream` (keeps a tree of Concepts in step with what people said: dream/turns → knowledge/page on the root it tends → context/concept on `Dream` and on the source's page, its rules → agent (graph/graph-get for the pages around them) → dream/done; see "The dream" in docs/knowledge.md; `sealed: true`, daily at 04:00, off until switched on) and `concept-check` (no automation: the judge every claim the dream writes is checked by, over a whole WORK — `context/run`, which renders the work the verify pass put on the bag, then an `agent` whose one tool is `context/work-file` (no built-ins, no web, no MCP, 8 steps at most) answering `{ supports?, content }`, `supports` left out when the rule is not about that work; no `input:` block, since a run's input and output are whatever its workflow made them)

### `src/steps/lib/job/`

job/dir: the run's JOB directory (jobs.ts) for an agent's cwd — `<dataDir>/jobs/<job>/`, the same path every run launched with that `job`; a run with no job gets its own artifact dir, so a job workflow is also a one-shot; `hold: false` hands it out without holding it, for a run that only reads (several of a job's readers at once — a convention, not a sandbox). job/upload / job/delete-upload: one file into / out of the job's `uploads/` (`saveJobUpload`, jobs.ts: never overwritten, a taken name numbered, the job made when there is none, no hold) — an app page's upload (plans/apps.md §12), never kept as a run from the app door since its input is the bytes. job/updates: the job's LIVE UPDATES after a cursor, held up to `wait` (`ctx.services.jobs.updates`, plans/live-feeds.md §1) — an app page's way to follow its jobs, granted like any read; job/status { title, detail? }: one line of what the run is doing now, `job.update { kind: "status", id: <runId> }` to the run's job (nothing without one). job/list, job/get, job/read: the job INDEX (job-index.ts) as steps — find an earlier job by words, read what it produced and the thread to continue, open one of its files (an image is SHOWN to the model via withMedia) — thin over `ctx.services.jobs`, the same reads `GET /jobs[/:id]` serves. job/start, job/continue: hand work to a job-shaped workflow DETACHED — `job`, or `builder` with `workflow: builder` (the authoring hands — workflows, and the apps that live in a workspace; `peer` for a build on another strut, plans/builder-job.md §2; the closed set is `JOB_WORKFLOWS`, jobs.ts, and the rule is on the field's own description, beside the `Workflow Builder` kinds the orchestrator reads) — and return `{ job, runId, callback, workflow }` at once — `workflow` the one the job's run is, the record's for a continue (an orchestrator's start_job / continue_job, as Jamie does in Hive); the job's run records the TURN that started it — `startedBy: { workflow, runId, session? }`, the launching root run and the conversation its launch named, on its `run.start`, the job record's run line and its `run.end` (CALLBACKS.md §2) — so a host hearing every job of a person on one room socket finds the conversation — unlike meta/run-workflow, which waits, so the calling turn ends and its session is free; through `ctx.services.jobs.launch` (createStrut, over launchDetached): the job's `run.end` goes to the LAUNCHING run's own callback (the run store's, never a URL the model wrote), `job_busy:` while a run of the job is in flight, start mints the id and takes a `title` and the request's `kind` (a page under `Job`, which job.yaml opens every turn with; continue carries the last turn's unless it names another) (`peer` with `workflow: job`, `kind` with `workflow: builder`, or `repos` with `builder`, refused), continue refuses a job not on file and names only the job — the launcher follows the record (`turnOf`: the workflow the newest turn ran, that turn's `input.peer` carried along), so a builder job on a peer stays one; and both fill `input.workspace` from this strut's `self` record when the launch has none, so the agent's first line names its workspace as a host's own launch does; a job a run on a Concept BRANCH starts is on that branch (the launching run's, src/branches.ts), and so is the wake turn that reports on it (the conversation's first turn's branch, `WakeLaunch.branch`). job/verify { job, claims?, detach? } and job/evidence { job, claim, runId, supports, content, slot? }: a PERSON's acts on a job's claims — what `POST /jobs/:id/verify` and `POST /claims/:id/evidence { job }` do, over `ctx.services.jobs.verify` / `.evidence` (set by createStrut where the claims layer is on) — for strut's own app's claims card: only as a first-party page's own call (never an agent's tool; an agent has meta/verify-job), on a job the viewer launched a run of (the record's `actors`)

### `src/steps/lib/conversation/`

conversation/list { q?, archived?, limit?, before? }, conversation/get { session, limit?, before?, wait?, since? }, conversation/update { session, title?, archived?, seen?, shared? }, conversation/fork { session, id? }: the conversation index (src/conversations.ts) as steps, the viewer the step's actor — thin over `ctx.services.conversations`; conversation/list also answers `viewer`, the actor the list is for (where a page mints `<viewer>/<id>`). Refused under `ctx.app`, except a first-party page's (strut's own app, plans/jamie-app.md §3), which reads them as its viewer's person token

### `src/steps/lib/proposal/`

proposal/list { job?, session?, workflow?, status?, input? }, proposal/get: the proposals on file as an agent reads them (what waits on the person, what they decided) — thin over `ctx.services.proposals`; `workflow` keeps one workflow's (the dream's), `input: true` adds what each runs with; under `ctx.app`, the list is the viewer's own, and in strut's own page's own call an ADMIN viewer's also holds what no conversation made (`pageSees`: the dream's changes to the tree). proposal/changes { cursor?, wait?, limit? }: the PROPOSAL FEED (src/proposal-feed.ts) after a cursor, held up to `wait` — what happened, never the input; `GET /proposals/changes` is the same read; under `ctx.app` the viewer's own. proposal/decide { id, action, input?, reason? }: a PERSON's decision, for strut's own app (plans/jamie-app.md §3) — runs only as a first-party page's own call (a one-step run, never an agent's tool), the viewer's own proposals (and, for an admin, one made in no conversation, decided as their session would), through the capability's `decide` (the decide route's code); one only an admin accepts (`approver: "admin"`) only when the page's viewer is one (`AppRef.admin`), which a page's `proposal/get` answers as `viewer: { admin }`
