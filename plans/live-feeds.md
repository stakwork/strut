# Live feeds: what a job and the graph are doing, for hosts and for apps

> **Status (2026-10-29): strut side BUILT (items 0–4), not ruled.** Hive's
> item 5 and the builder's side are not done. Where the build differs from
> the text below, "As built" at the end says so. Written
> after a live look at swarm38's `brainstorm` workflows and the Infinite
> Canvas app (`brainstorm-canvas` v26). Every row below is mine and open to
> a ruling. Companion to `live-artifacts.md` (the `job.update` callback this
> extends), `apps.md` (the app door, its grants and the kit) and
> `specs/CALLBACKS.md` §5 (the update's shape). Hive's half is described
> only as the contract it reads. The workflow and app changes at the end
> are recommendations for their author: they are built with the builder,
> not in strut.

## Problem

A person asks Jamie to brainstorm on the infinite canvas. Here is what
happened on swarm38 on 2026-10-29:

| Time | What happened |
| --- | --- |
| 16:15:43 | Hive's Jamie launches an `orchestrator` turn; it starts a `job` and replies "On it" 16 s later |
| 16:16:14 | The job agent runs `canvas` (`meta/run-workflow`, same job) → subflow `canvas-brainstorm` → a draft → audit `loop`. Four drafts fail the audit; the run fails after 334 s with nothing written |
| 16:22:00 | The agent runs `canvas` again. Two draft rounds take 141 s |
| 16:24:27 | `canvas/bs-write` writes every card, in 3 s |
| 16:24:37 | The job ends; Hive's canvas reads the trees again and the cards appear |

Nine minutes with nothing on the canvas, then everything at once. Most of
that is the workflow, which writes only at the end. But even a workflow
that wrote card by card would not show them sooner:

- **Hive** reads the canvas again only when a `job.update` arrives or a
  turn settles (`useCanvasJobs.ts`: "strut writes the graph as it goes,
  and nothing else says so"). A graph write sends no update.
  `canvas/bs-write` calls `graph/create-node` and `graph/create-triplet`
  through the registry and drops their `withAccessedNodes` marker, so not
  even the run log says what was written.
- **An app gets nothing pushed at all.** A page talks to strut only
  through `step_run` (CSP `connect-src 'none'`). A run an app launches has
  no `jobCallback`, and `notifyJob` (`src/jobs.ts:271`) returns at once
  without one, keeping nothing a page could read later. The Infinite
  Canvas app polls instead: the last 3 `canvas` / `canvas-ops` runs as a
  change feed (every 2 s while one is in flight), then `canvas/desk` and
  `canvas/board` read again whole; each job its orchestrator started is
  followed with `run/get { wait }`. About 1 000 `step_run` calls a day,
  and a `canvas/board` read costs ~1.9 s of server time.
- **The kit's `useAssistant().jobs` is always empty.** `assistantJobs`
  (`kit/src/hooks.ts`) looks for `tool:job/start`, but the agent names
  the tool `job_start` (`toolNameFor`), so the event's `stepType` is
  `tool:job_start`; and the event's `output` is a JSON string, not an
  object. The Infinite Canvas app works around both in its own `jobsOf`.

| Has | Lacks |
| --- | --- |
| `job.update` POSTed to a host's URL or room (`notifyJob`), inherited by the jobs a turn starts | a record of the updates a reader can ask for; anything for an app |
| `run/get { wait }`: a long-poll for one run (`RUN_GET_MAX_WAIT_MS`, 55 s) | a long-poll for "something changed" |
| per-run views of the services bag (`bindPrincipal`, `bindPeer`, `bindApp`, `src/runner.ts`) | one that sees graph writes |
| Hive re-reading a canvas card's trees on any update for a job on that card | an update when cards are written |
| holds, shots, walkthrough frames, evidence, proposals as update kinds | a one-line "what I am doing now" |

## Proposed

Five strut items, one Hive item, then the builder's side.

### 0. Fix `assistantJobs` in the kit

Match `tool:job_start` / `tool:job_continue` (and keep the `/` forms for
an older log), and parse a string `output`. Test it against a real
orchestrator log, not a hand-written one: the fixture that passed was
wrong. Small; ships with the next kit build.

### 1. Job updates kept, and readable

`notifyJob` RECORDS every update, then POSTs it when a callback is on
file. The record is what item 3's door and the kit read.

- **In memory, per job.** The latest state of each thing (`kind` + `url` +
  `id`, the outbox's own key), each with a sequence number; 200 things per
  job, the oldest dropped; a job untouched for an hour dropped; at most
  1 000 jobs. An update is a notification, never the record
  (`live-artifacts.md`), so a restart losing them is the rule, not a gap.
- **A cursor**: `<epoch>.<seq>`, the epoch being the process's start. A
  cursor from another epoch gets everything kept and `reset: true`, so a
  reader re-reads what it shows.
- **`JobsCapability.updates(job, { since?, wait? })`** →
  `{ cursor, reset?, updates: JobUpdate[] }`, newest state of each thing
  changed after `since`, in order. With `wait` (at most 55 s, the
  `run/get` rule) and nothing new, it holds on a waiter (a promise, no
  polling) until an update lands, then gathers for 1 s before answering.
  A call that finds updates already waiting answers at once. So a reader
  that calls again on every answer makes at most one call a second however
  fast the job reports.
- **The doors**: a lib step `job/updates { job, since?, wait? }` (a read,
  `effect: "read"`), and `GET /jobs/:id/updates?since=&wait=` beside
  `GET /jobs/:id`. An app reaches the step through `grants.steps`, and
  `scopeAppJobs` already keeps its `job` under `app/<name>/`: a page reads
  only its own jobs, including the ones its orchestrator turns start.
- **The kit**: `useJobUpdates(job, { live })` → `{ updates, latest(kind) }`,
  holding one call in flight while mounted and the page visible.
  `useAssistant` gains `updates` per job.
- **The monitor**: at one call a second, a feed stays under `fanout` (50
  calls with 25 configs in 10 s) and `repeat` (the cursor changes the
  config). Held time is counted like `run/get { wait }`'s. Nothing to
  change; a test pins it.

### 2. A graph write tells its job

A per-run view of `services.graph`, built in the runner beside the other
binds (`bindGraph`): `nodes` and `edges` are the backend's writers wrapped
so that every mutating call (`write`, `writeMany`, `update`, `softDelete`,
`deleteNode`; edges `write`, `writeMany`, `update`, `delete`, `move`)
reports what it changed when it returns. Everything else on the backend is
the backend's own (the view delegates). A step that calls `graph/*` steps
through `ctx.registry`, as `canvas/bs-write` does, passes the same `ctx`
and so the same view: nothing for a step author to do.

What it reports, per run, debounced (1 s after the last write, at most 5 s
after the first):

```
job.update { kind: "graph", id: <runId>, state: "written",
             detail: { writes, types: { Question: 1, Option: 6 }, refs: [last 20] } }
```

`detail` is CUMULATIVE for the run, so the outbox replacing a pending
update with a newer one (same `kind` + `id`) loses nothing. Sent only when
the run has a job. Under 4 000 characters, so Hive's events route forwards
it as it is.

**What it does in Hive with no Hive change:** the events route nudges the
canvas on any update for a job on a card (`nudgeCanvasCardJob`), and
`useCanvasJobs` reads the card's trees again (throttled to 2 s). Cards then
appear when they are written, not when the job ends. The job card's strip
ignores a kind it does not draw.

**Also wrapped:** the context a proposal's apply runs under
(`decideProposal`) and a hold's release (`releaseWith`). They are not runs,
so they report to item 3's feed only.

**Not seen:** a write through raw Cypher (`ctx.services.graph.query` on
Neo4j); a write by another process (jarvis, stakgraph's ingest, Hive). A
transaction that rolls back after a write returned sends a signal for
nothing; a reader reads again and finds the graph as it was.

### 3. The graph change feed

The same reports also land in one ring for the deployment: the last 5 000
writes, `{ seq, at, op, ref_id, node_type }` for a node and
`{ seq, at, op: "edge", edge_type, source, target, types: [s, t] }` for an
edge (the edge writer resolves both endpoints' types for its rule check,
`validateEndpoints`; confirm the result carries them when building).
Strut's own types (`Strut*`), the claims layer's (`Claim`, `Check`,
`Evidence`) and the ontology's (`Thing`, `Schema`) are never in it.
`Concept` is: a page may not write one (`reservedAppType`), but hearing
that one changed is harmless. The same epoch cursor as item 1.

- **`graph/changes { types?, since?, wait? }`** →
  `{ cursor, reset?, more?, changes }`: the writes after `since`, latest
  per `ref_id`, kept by `types` (an edge when either end is of a listed
  type), at most 500 with `more: true`. The same wait and 1 s gather as
  item 1. `GET /graph/changes` is the same read.
- **Ids, types and time only.** No properties, no actor, no workflow: a
  reader reads what changed through the reads it already has.
- **For an app**: granted through `grants.steps` like any read. This is
  the feed a shared canvas needs: a teammate's edit, the janitor's write,
  a brainstorm Hive's Jamie started — none of them is the app's own job,
  which item 1 is limited to.
- **The kit**: `useGraphChanges(types, { live })` → a `rev` that changes
  when a write of those types lands; a page puts it in the dependencies of
  the reads it already makes.

### 4. `job/status`: one line of progress

A lib step `job/status { title, detail? }` →
`ctx.services.jobs.notify(ctx.job, { kind: "status", id: ctx.runId, title, detail })`.
`id` is the run, so each run has one current line and a newer one replaces
it. A no-op without a job (`{ sent: false }`). A workflow writes
`type: job/status` between its steps (`title: "Draft {{ … }}: audit
failed on {{ … }}"`) with no custom code; an agent may be granted it to
narrate. Nothing new in the update itself: `kind` is already free.

### 5. Hive (the contract it reads)

- The job card's strip shows the newest `status` line of the job (one per
  run, the latest run's on top) and counts neither `status` nor `graph`
  in its tally.
- The strip's window starts when the job was launched, not when the card
  mounted (`PendingJobTurnCard`'s `since = Date.now()`): for a job the
  orchestrator starts, the card appears only when the orchestrator's reply
  lands, and anything the job sent before that is in the store but hidden.

## The builder's side (recommendations for the workflow and app author)

None of this needs strut code; it is built with the builder on swarm38.

**`canvas-brainstorm` / `canvas`**

- Write the root question first: it is known before the first draft.
- Write each option as its round passes the audit, or write a round's
  draft at once as cards in a drafting state and confirm or remove them
  after the audit. This is the author's call: the audit gate is the
  design ("only a passing draft is written").
- Say where it is: a `job/status` step per round (item 4). Before that
  ships, a custom step can call `ctx.services.jobs.notify` the same way,
  and Hive's canvas already reads the trees again on any update, so a
  notify right after `canvas/bs-write` makes Hive's cards appear when they
  are written, today.
- Look at the audit's failures: in the run above four drafts in a row
  failed, and about 30% of recent `canvas` runs fail (59 of the last 200).

**The Infinite Canvas app**

- Replace `useLiveSync`'s run-list probe with `useGraphChanges` over the
  types it draws (item 3), and its `JobWatch` polling with
  `useAssistant().jobs` (item 0) and `useJobUpdates` (item 1).
- Until then it can already show progress: it polls the `canvas` run's
  events, and each draft round's `step.end` is in them.

## Order, and what each unlocks

| Item | Where | Unlocks |
| --- | --- | --- |
| 0 | strut (kit) | `useAssistant().jobs`, for every app on the assistant |
| 2 | strut | Hive's canvas updates when cards are written, for every workflow that writes the graph under a job |
| 4 | strut | a progress line from YAML; Hive draws it after item 5 |
| 1 | strut (+ kit) | apps hear their own jobs: shots, frames, holds, verdicts, status, graph writes |
| 3 | strut (+ kit) | apps hear the shared graph |
| 5 | Hive | status line; early updates no longer hidden |

Each strut item reaches a swarm after a strut release, the mcp pin bump
and a deploy. A kit change reaches an app when the app is published again
(the build bundles the kit the server has).

## Later, on the same feed

- **Live deliverables.** A `job/deliver { id, kind, title, path | url | content }`
  tool: the agent hands a deliverable over when it is ready, as
  `job.update { kind: "artifact" }` with the resolved link
  (`artifact-refs.ts`). The turn's `artifacts[]` stays the record; Hive's
  rule (a live item and a delivered artifact match by URL) already merges
  the two.
- **A build on another strut.** `strut/run-workflow` relaying the peer's
  updates onto the caller's job (found in the 2026-10-29 review; the
  peer's job has no callback today).
- Streaming the reply's text (`agent-reply-streaming-research`).

## As built (2026-10-29)

- **Item 2's edge types** come from the run's own node writes, else a
  `reader.getNode` per unknown end (at most 50 a send): the edge writer's
  results carry no endpoint types. An edge whose ends could not be typed
  passes any `types` filter.
- **A proposal's apply** is heard (`bindGraph` around `applyProposal`): the
  update's `id` is `proposal:<id>` and it carries no `runId`. A hold's
  release (`releaseWith`) is not wrapped: no release step writes the graph.
- **`useAssistant`** does not gain `updates`: a hook cannot be called per
  job in a loop. A page renders a component per `useAssistant().jobs` entry
  and calls `useJobUpdates(job)` in it.
- **`job/status`** takes no `job`: it speaks for the run's own job only.
- **The monitor** needs no change; no test pins it yet.
- Defaults taken for the open questions below: memory only (1), any app
  granted `graph/changes` sees ids and types of every write (2), 1 s / 5 s
  (3), `job/status` not in the `job` seed's grants (4).

## Open questions

1. Item 1's memory-only record: enough, or should updates survive a
   restart (a file per job, like the callbacks)?
2. Item 3 for apps: is ids + types + time safe to give any app granted the
   step, or should `types` be limited to what the app declares in
   `data.graph`?
3. Item 2's debounce (1 s, at most 5 s): right for a canvas; too slow for
   anything?
4. Should `job/status` be in the `job` seed's grants, so the job agent can
   narrate long turns?

## Tests

- `notifyJob` records with and without a callback; the cursor, `reset`
  across epochs, the cap, the 1 s gather (one answer for a burst), a
  waiter woken by an update, the app scope on `job/updates`.
- `bindGraph`: a `graph/create-node` called through `ctx.registry` by
  another step reports; the cumulative `detail`; nothing without a job;
  the feed's `types` filter, edges by either end, reserved types never
  in it; on a Ladybug file (`testBackends()`) and Neo4j.
- `assistantJobs` against a recorded orchestrator log.
- The monitor: a feed held in a loop for a minute raises no warning.
