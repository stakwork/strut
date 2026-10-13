# Jobs sidebar — the operator's view of a job

> **Status (2026-10-12): BUILT, in strut — the fold (`src/job-threads.ts`),
> `threads` on `GET /jobs/:id` (`?threads=0`, `?nodes=1`, `?limit=`;
> `job/get` takes `threads: true`), the Jobs sidebar section, the timeline,
> the thread view (the chat's renderer lifted into `Transcript.tsx` +
> `transcript.ts`), the job chip, `?job=` deep links. Departures from the
> text below, all small: a turn carries `offset` (where it starts in the
> thread, what the transcript's turn marks are placed by); the web's types
> are written out in `api.ts` rather than imported from the engine (those
> modules pull node types); `job/get` leaves threads out unless asked
> (`threads: true`), no depth cap; the Jobs section sits between Runs and
> Tools; a selected job's Runs section lists the job's runs (every workflow)
> so turns are a click apart. Verified against the swarm38 job replayed into
> a scratch workspace (its events, transcripts, session and `plan.html`):
> one thread, seven turns, $2.79, the four Concept pages under Nodes. Not
> done: §7 item 7 (the stakgraph `pod/agent*` steps marking their output),
> a separate PR there. Written 2026-10-12 after reading one job on swarm38
> (job `749199e2…`, "Plan: external agent read/update pool config": seven
> runs of the seeded `job` workflow, one agent thread, a goose coding agent
> on a hive pod, two merged PRs) through the routes strut already has, and
> finding that the web UI could show none of it. The choices a reader
> should confirm before building are under "Proposed rulings". Companions
> this stands on and does not reopen: `jobs.md` (the stamp, the directory,
> `artifacts[]` §3, holds §6), `job-index.md` (the record, `GET /jobs`,
> the artifact fold, the `StrutJob` node — §8 of it deferred this sidebar),
> `agent-sessions.md` (the session store, the turn line, the transcript
> route), `federation.md` §2.2 (a peer run's handle and tagged nodes).

## Problem

Strut records everything about a job and shows nothing of it.

- **The web UI has no notion of a job.** `web/src` mentions `job` only in
  artifact-link paths (`/jobs/<id>/files/…`). A job's seven runs sit in
  the `job` workflow's run list as seven unrelated rows between every
  other job's runs; nothing groups, labels or links them. "What was this
  run's job" has no answer in the UI; neither has "which run was the turn
  before this one".
- **The thread is invisible.** A session (`session` on an `agent` step)
  spans runs, so no run view can show it. Its per-turn usage, cost and
  context sit on the turn log (`GET /sessions?id=`, `SessionTurn`) and are
  rendered nowhere; the only place a person sees tokens is the `work`
  step's output JSON in the run flyout, one run at a time. The seven-turn
  session above cost $2.79 over 3.9M tokens; adding that up took jq.
- **The cascade is flat.** A turn that ran a sub-agent (an `agent` granted
  as a tool), a child run (`meta/run-workflow`, which carries the job and a
  `parentRunId`), a peer run (`strut/run-workflow`, journaled at
  `<path>#launch`) or an agent strut did not run at all (the pod's goose,
  reached through `pod/agent*` tool calls) shows as a tool call in the run
  drill, or as another run somewhere in the sidebar. Which agents worked
  on a job, in what order, at what cost, is not a view anyone has.
- **Artifacts are a modal.** A run's `artifacts[]` resolve to links
  (`artifact-refs.ts`) and the job index folds them into the job's current
  deliverables, but the UI reaches an artifact only through the eye beside
  a path in a value field. Which turn produced which version of what is
  not visible.

The strut UI is the operator's debugger, not the product: hive owns the
conversation with the person, the artifact cards and the trace card. What
the debugger lacks is the one surface where a job's whole execution —
threads, cascade, tool calls, tokens, graph walks, deliverables — reads as
one thing, with a drill from any row to the run that did it.

## Proposed rulings

1. **The first-class item in a job is a thread, not a run.** A job's
   timeline lists agent executions grouped by session: seven runs of the
   `job` workflow whose `work` step continued one session are ONE row with
   seven turns, not seven rows. A cold agent (no `session`) is a one-turn
   thread, same row shape. A run is what a turn points at.
2. **Generic by construction: nothing in the view names `job`, `work`, or
   any workflow.** The grouping key is `job` on the launch (any workflow
   can carry it); an agent execution is any `step.end` whose event carries
   `messages` (`withMessages`, the marker the runner and
   `wrapToolsWithEmit` lift); a thread is that execution's
   `output.session.id` when it has one, else the execution alone. The seed
   can rename `work`, hive can launch a different workflow under a job,
   and the view does not change.
3. **The fold is server-side, one read.** `GET /jobs/:id` grows a
   `threads` field computed from the job's run logs and the session store,
   and the UI renders a tree. The UI never reads event logs to build the
   timeline (a job's logs are megabytes; the UI reads one run's log when a
   run is opened, as today).
4. **An agent strut did not run is a tool call until its step says
   otherwise.** The pod's goose is `pod_agent` / `pod_agent_start` /
   `pod_agent_status` tool calls whose output is text. The generic seam is
   the marker that exists: a step that ran a model elsewhere marks its
   output with `withMessages(output, { messages })` and becomes an agent
   execution like any sub-agent, with a transcript link and a row. No
   special case for pods in strut; the stakgraph `pod/*` steps opt in
   (one line each) when they want a row. Until then the goose shows as a
   tool call under the turn that invoked it, which is the truth of what
   strut recorded.
5. **No chat.** The thread view is read-only: the stitched transcript
   (`GET …/transcripts/<path>?full=1`) rendered with the chat flyout's
   message renderer. No input box: a turn is launched with `job`, `title`,
   `callback` and an actor by a host, and strut's UI is not a second host.
   (`jobs.md` §8: the host's side is closed.)
6. **Artifacts hang on the run that reported them.** A row of icons under
   the turn, by `kind` (`artifactKind`), opened by the existing
   `ArtifactViewer`. The same `id` on a later turn is a newer version
   (`jobs.md` §3); the version the job currently points at (the fold) is
   marked. A child run's artifacts sit under the child's row and are never
   folded up — the index never folds a child's either.
7. **The timeline takes the canvas area; a click on a run opens that run's
   canvas.** Selecting a job replaces the workflow canvas with the job's
   timeline; a run row sets `selectedWf` + `selectedRun` as the run list
   does today, so the canvas, the events panel and the run drill are the
   existing ones, unchanged. Back returns to the timeline.
8. **The sidebar's jobs list is a fourth section, not a mode.** Workflows /
   Runs / Tools already stack; Jobs is a fourth collapsible section with
   the same search box (`GET /jobs?q=` is the sidebar matcher,
   `src/search.ts`). Collapsed on a deployment with no jobs.

## Design in one paragraph

`GET /jobs/:id` already returns the job's runs (newest first, with status,
`parentRunId`), its threads (`SessionInfo[]`), its holds, files and the
artifact fold. It grows one field, `threads: JobThread[]` — every agent
execution found in the job's runs' logs, grouped by session id, each turn
pointing at its run and step path with its usage, cost, context, tool-call
count and the artifacts that run declared, and under each turn the
executions it caused: sub-agents (nested `step.end` with `messages`), child
runs (`parentRunId` = this run; their own threads inline), peer runs
(`strut/run-workflow` outputs, tagged with the peer id, not drillable).
The web UI gets a Jobs section in the sidebar (`GET /jobs`), and a
`JobTimeline` component in the canvas area that renders the tree: thread
rows with totals, turn rows with tool counts and artifact icons, a thread
transcript in the flyout, a consolidated graph-walk section
(`foldAccessedNodes` over every execution of the job), and a click on any
turn that opens its run on the canvas you have today.

## 1. The fold — `threads` on `GET /jobs/:id`

`src/job-index.ts` reads each run's summary today. For `threads` it reads
each non-sealed run's events (`RunStore.getRunEvents`) once and folds:

```ts
/** One agent execution: a `step.end` carrying `messages`. */
interface JobTurn {
  runId: string; workflow: string; path: string;      // `job/work`, `job/work/004-agent`
  stepType: string;                                   // `agent`, `tool:agent`, or a marked lib step
  at: string; durationMs?: number; status: "success" | "error" | "cancelled";
  turn?: number;                                      // the session turn, from output.session
  usage?: TokenUsage; cost?: number; context?: { used: number; limit: number };
  toolCalls: number;                                  // nested `step.*` under this path
  transcript: string;                                 // `/workflows/…/transcripts/<path>` (+ `?full=1` when turn is set)
  artifacts: ArtifactRef[];                           // the RUN's declared refs, on its top-level execution only
  nodes: number;                                      // accessed nodes under this path (the walk)
  spawned: JobThread[];                               // sub-agents under this path; child runs with parentRunId = runId; peer handles
  peer?: { id: string; workflow: string; runId: string; status: string };  // a strut/run-workflow execution: no drill
}

/** A thread: one session, or one cold execution. */
interface JobThread {
  id: string;                 // the session id, else `<runId>/<path>`
  session: boolean;
  label: string;              // the step path's leaf (`work`), the stepType for a tool
  startedAt: string; updatedAt: string;
  turns: JobTurn[];           // chronological
  totals: { turns: number; usage: TokenUsage; cost: number; toolCalls: number; context?: { used: number; limit: number } };
}
```

Rules, all mechanical:

- **An execution is a `step.end` whose event has `messages`.** The events
  endpoint replaces them with a `transcript` link; the fold reads the
  store directly and keeps the link only. `usage`, `cost`, `steps` come
  from the execution's `output` (every `agent` output has them; a marked
  lib step reports what it can). `turn`, the session id and `offset` come
  from `output.session`.
- **Grouping.** Executions with `output.session.id` group into that
  thread, ordered by `turn`; the session store's turn line (which the job
  record already lists via `sessions`) supplies `context` and confirms
  the turn committed — an execution the store has no line for (a failed or
  cancelled turn, `agent-sessions.md`: a failed turn commits nothing) is
  still a turn row, with its status, so the timeline shows the attempt.
  Executions without a session are threads of one.
- **Nesting.** An execution at `wf/work/004-agent` is `spawned` by the
  execution at `wf/work` (path prefix). A run with `parentRunId` is
  spawned by the parent run's top-level execution — or, when the parent
  run has several, by the one whose path prefixes the tool call that
  launched it (`meta/run-workflow` emits `<agentPath>/NNN-meta_run_workflow`
  with the child's `runId` in its output; a match by run id, else the
  run's first execution). A `strut/run-workflow` execution has no log here:
  its `step.end` output (`peer`, `runId`, `status`, cost if the peer
  reported one) becomes a `JobTurn` with `peer` set and no transcript.
- **Order.** Threads by first turn; turns by time. Spawned threads under
  the turn that spawned them. The result is chronological at every level.
- **Artifacts.** `artifactEntriesOf(summary.output)` resolved by
  `resolveArtifactRefs` for every run, attached to that run's top-level
  execution (a run with none — a plain `exec` workflow under a job — gets
  a thread row of zero turns so its artifacts still show; the row's label
  is the workflow name). The fold (`JobView.artifacts`) is unchanged; the
  UI marks a turn's ref as current when `(id, runId)` is in it.
- **Sealed runs** contribute status and nothing more, as `JobRunView` does.
- **Cost.** `TokenUsage` summed per thread (`addUsage`, `pricing.ts`);
  `cost` summed; `context` is the last turn's. The job's own totals are
  the sum over top-level threads (spawned threads counted once, where they
  hang). A peer run's cost counts only if its output carried one.

This is `foldRun` (`run-view.ts`) walked for one node type, over several
runs; the walk itself is a function of events (`foldJobThreads(runs:
Array<{ summary, events }>, turns: SessionTurn[])`), pure and tested
against a recorded log. The route calls it once per `GET /jobs/:id`; a
job with hundreds of runs reads hundreds of logs, so the read is capped
like the run list (`limit`, newest first, `{ omitted }` for the rest) — a
job is tens of runs in practice, and the logs are read, not parsed for
transcripts (`messages` are skipped by key).

`job/get` (the agent's door) is thin over the same `get` and would hand the
model the threads too; it caps `spawned` depth at one and drops `usage`
to keep its result small — or takes `threads: false`. Either is fine; the
step's result cap decides.

## 2. The sidebar — Jobs section

A fourth `sidebar-section` (`data-section="jobs"`), collapsible like
Tools, placed between Runs and Tools:

- The search box is `GET /jobs?q=` (server-side; the index's matcher over
  title + current artifact titles). Rows: title (the id when none), the
  `usedAt` relative time, run count, a live dot while `busy`, a hold count
  when any.
- A click selects the job: `selectedJob` set, `selectedWf` / `selectedRun`
  cleared, the canvas area shows the timeline (§3). The Runs section
  shows the job's runs (every workflow) instead of a workflow's, from
  `JobView.runs`, so the familiar list still works and a run click works
  as today.
- A run in the ordinary Runs list that carries a `job` gets a chip with
  the job's title (one line in the run row; `RunSummary.job` is on the
  summary, the web type gains the field) — the link from the old world
  into the new one. Clicking the chip selects the job.
- Deep link: `?job=<id>` joins `embed.ts`'s params so hive can open a
  job's timeline in the frame it already embeds strut in.

## 3. The timeline — `JobTimeline` in the canvas area

When a job is selected the canvas (`system-canvas`) is not rendered;
`JobTimeline` takes the grid's `canvas` area. Top to bottom:

1. **Header.** Title, id (copy), `createdBy` (`displayActor`), first and
   last activity, totals (runs, threads, tokens, cost), holds (kind + id,
   a release is a DELETE the operator does elsewhere — not here),
   repositories checked out, the directory's file count.
2. **Deliverables.** The fold, as a row of cards: icon by kind, title,
   the turn that produced it (click → that turn). The `ArtifactViewer`
   opens one; a `url` ref opens in a new tab; `content` opens inline.
3. **Threads.** The tree from §1, one row per thread:

   ```
   ▾ work · session 749199e2 · 7 turns · 35.8k out · 3.6M cached · $2.79 · ctx 138k/1M
       t0  16:57  run 1791824267871  22 tools  86s  $0.62   [plan]
       t1  17:04  run 1791824677256   8 tools  64s  $0.41   [plan]
       …
       t4  23:52  run 1791849172643   8 tools 385s  $0.83   [plan] [pod] [ide] [pr]
           ▸ pod_agent  (tool call; a row once the step marks its output)
       t5  00:09  run 1791850149996   3 tools  23s  $0.18   [pr] [pr-migration]
       t6  00:37  run 1791851833178   1 tool    4s  $0.10   [pr ✓ current]
   ▾ explore · cold · 1 turn · … (child run 1791…, parent t4)
   ▸ @acme-web explore (peer run, status success, no drill)
   ```

   A thread row carries the totals and expands to its turns; a turn row
   shows time, run id, tool-call count, duration, cost, status tone, and
   the artifact icons; a spawned thread nests under its turn with an
   indent. A peer turn is a row with a badge and nothing to open (the
   graph refs it brought back are tagged with the peer id and listed in
   the walk section, never opened — `federation.md` §2.2).
4. **Graph walk.** `foldAccessedNodes` run over every execution of the
   job (the UI has the per-run events only when a run is open, so the
   fold returns `nodes` per turn as a count and the route gains
   `?nodes=1` to include the touched node list per execution — the same
   `{ ref_id, node_type, name }` the run flyout shows), merged: type chips,
   one row per node with the turns that touched it, a click opens the
   node in place (`GET /graph/nodes/:ref_id`) as the run flyout does.
   Empty on a deployment without a graph.

Clicks:

- **Turn row → the run.** `setSelectedWf(turn.workflow); setSelectedRun(turn.runId)`,
  then open the flyout on `turn.path` — the run canvas, events panel and
  drill you have today, at that step. A breadcrumb (`Jobs › <title> ›
  run <id>`) returns to the timeline; the run drill's own breadcrumb bar
  is the model (`app.tsx`, `runDrill`).
- **Thread row → the transcript.** The flyout shows the thread, read-only
  (§4). For a session thread the stitched thread up to its LAST turn
  (`?full=1` on the last turn's transcript link); a turn row's "transcript"
  affordance opens the thread up to that turn.
- **Artifact icon → the viewer**, as the eye does; the current version is
  marked, an older one says which later turn superseded it.

## 4. The thread view — read-only transcript in the flyout

The chat flyout already folds stored `ModelMessage`s into display entries
(`transcriptToEntries`: user bubbles, assistant markdown, tool-call chips
with their results attached by `toolCallId`, notices) and renders them.
Lift that fold and its renderer out of `ChatFlyout.tsx` into
`components/Transcript.tsx` (`transcriptToEntries` becomes a pure module,
`web/src/transcript.ts`, tested against a recorded session), and use it
twice: the chat (unchanged) and the thread view. The thread view adds a
turn separator ("turn 4 · run 1791849172643 · $0.83 · ctx 130k") at each
turn's `offset` (the turn log gives `offset` and `count`), the system
prompt collapsed at the top, and the structured final answer (the
`final_answer` tool's input) as the turn's reply card. No input box
(ruling 5). A transcript is megabytes; it loads on open, once per
thread, and the flyout's existing long-list handling applies.

The agent step's `step.end.messages` is what the run log holds for a cold
agent; for a session turn it is the system prompt plus THAT turn, and the
`?full=1` form stitches the thread from the session store. Both are served
today. A marked lib step (ruling 4) renders through the same path: its
`messages` are whatever shape it recorded — for goose, one user message
(the prompt) and one assistant message (the output text) is enough to
read.

## 5. What the graph adds (optional, later)

Nothing in §1–4 reads the graph. A graph-backed workspace already has the
`StrutJob` node, `IN_JOB` from each `StrutRun`, `StrutAgentSession` with
`session_id` / `session_turn` / `job`, and `IN_SESSION` / `ACCESSED` edges
(`job-index.md` §6, `agent-sessions.md` §4). The one thing the file fold
cannot answer — "every job that touched this node", "every thread that
touched this file" — is a Cypher the timeline's node rows could link to
once `graph-search` has a `linked` filter for it. Not in this plan.

## 6. Left out

- **A send box** — ruling 5. A host launches turns.
- **Live updates.** The timeline reads `GET /jobs/:id` on select and on
  the Runs list's refresh tick; a running turn shows `running` from the
  summary-less run and a live dot. Tailing a job's runs is the run view's
  job once one is opened.
- **Releasing a hold, deleting a job, renaming** — reads only. The DELETE
  route exists; a button is a later line, with a confirm.
- **`job` on chats** (`jobs.md` §7) — the builder as a driver would be a
  thread of a different kind; the fold has a place for it when it lands.
- **Pods as rows** — ruling 4: the stakgraph `pod/agent*` steps mark
  their output; strut adds nothing.
- **A per-actor view** — every job is listed; `createdBy` is a column.

## 7. Work items

1. **`foldJobThreads`** (`src/job-threads.ts`): pure, over
   `{ summary, events }[]` + `SessionTurn[]`; nesting by path prefix,
   `parentRunId`, peer outputs; totals. Tests: a recorded multi-turn job
   log (the swarm38 shape above, scrubbed), a cold agent, a sub-agent
   granted as a tool, a child run, a peer run, a sealed run, a failed turn
   with no store line.
2. **`GET /jobs/:id` → `threads`** (`job-index.ts`): read each run's
   events, call the fold, cap by `limit`; `?nodes=1` adds the touched
   nodes per execution. `JobView` type + `specs/API.md`. `job/get` takes
   `threads: false` or depth 1.
3. **Web: types + api** (`web/src/api.ts`: `listJobs`, `getJob`,
   `RunSummary.job`), the Jobs sidebar section, `selectedJob` state, the
   `?job=` embed param, the job chip on run rows.
4. **Web: `JobTimeline`** — header, deliverables, the thread tree, the
   walk section; turn click → run; breadcrumb back.
5. **Web: `Transcript`** — lift the chat's fold + renderer; thread view in
   the flyout with turn separators; `transcript.ts` tested.
6. **CSS** in `components.css`: the section, the tree rows (indent,
   totals, status tone), the artifact icon strip.
7. **Stakgraph (separate PR, after):** `pod/agent`, `pod/agent-start`'s
   status reader mark their output with `withMessages` so the goose shows
   as a thread.

## 8. Validation

- `npm test` for the fold; `cd web && npx tsc --noEmit && npx vite build`.
- Against a local fs strut: a job of three launches with `job` + `title`
  (`POST …/run`), one with a session agent, one child run via
  `meta/run-workflow`, one cold agent; the timeline shows one thread of
  two turns, a spawned thread under turn two, a cold thread; totals equal
  the sum of the run outputs' `cost`; a turn click lands on the run canvas
  at the step; the thread view shows both turns with a separator.
- On swarm38 (through mcp's `/lab`): job `749199e2…` renders as one
  thread of seven turns, $2.79, with the pod tool calls under turn 4 and
  the two PRs as deliverables; after item 7 deploys, the goose rows appear
  under turns 4 and 5 with no strut change.
