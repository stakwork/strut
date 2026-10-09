# Job index — a job you can name, find, and read back

> **Status (2026-10-09): BUILT, in strut — the record, the routes, the
> steps and the graph (§9's two commits). Rulings 1–7 confirmed as
> proposed (StrutJob, no StrutArtifact).** What was built departs from the
> text below in four small ways, all simplifications: ONE write instead of
> two — the runner's `recordRun` carries the launch's `title` and `actor`,
> so there is no `describe` and `title` is a `RunOptions` field beside
> `job` (the route and `strut.run` pass it through); a folded artifact
> carries `path` (relative to the job's directory, what `job/read` takes)
> and `job/get` adds `dir`, instead of an absolute `file` per ref;
> `SessionInfo.jobs` is present only when a turn carried a job; the sweep
> keeps a record with runs and leaves its (empty) directory in place.
> `GET /jobs/:id` also carries `text`, the newest successful top-level
> run's `output.text` — the latest reply, what the `StrutJob` summary is
> built from beside the artifacts. Still to do outside strut: the mcp seed's
> `params.tools` + system line (§5) and hive's `title` on the launch body
> (§7). Written 2026-10-08
> after an exploration of how jobs and artifacts are stored today, on this
> checkout (`efce3f1`, main), `hive@d1649a94b` (master) and the mcp lab
> (`stakgraph@329d52de`, the `job` seed v6 and its `Job` Concept). The
> goal it serves: a job that can SEARCH past jobs, learn what they produced,
> look at their artifacts, and find the thread to continue. The choices a
> reader should confirm before building are listed under "Proposed
> rulings". Companions this stands on and does not reopen: `jobs.md` (the
> stamp, the directory, the record, holds, `artifacts[]` — §1 of it already
> names the index and the projector attribute as later work; this is that
> work), `agent-sessions.md` §4 (the session store and its `session_id`
> projection, the precedent every choice below follows), `generic-storage.md`
> §7 (the projector: summaries and `log_ref`, never payloads),
> `job-artifact-events.md` (hive's own index of the refs a job reports,
> keyed on URL, for webhooks — a different question, left where it is).

## Problem

A job exists in strut as a directory, a sidecar record and a stamp on
runs, and that is all (`src/jobs.ts`, `JobRecord { name, usedAt, repos,
holds? }`; `run.start.job`, `RunSummary.job`). Nothing can be asked of it:

- **It has no name.** The id is what hive minted. Hive carries a `title`
  on the launch `input`, but the `job` workflow's `input:` block declares
  `prompt`, `workspace` and `session` only, and the runner records the
  PARSED input on `run.start` (`runner.ts`, `workflow.input.parse`), so the
  title is stripped before anything persists it. The title lives in hive's
  `StrutRun.input` column and nowhere in strut.
- **Its runs are findable only by scan.** Runs are listed per workflow;
  "every run of job X" means reading every workflow's summaries. `jobs.md`
  §1 sketched a `runs: [...]` list on the record, appended per launch; it
  was never built.
- **Its artifacts are a transient output field.** `artifacts: [{ id, kind,
  title, label, summary, path | url | content }]` is read off any run's
  output by `src/artifact-refs.ts`, resolved to links for the callback and
  `GET …/runs/:runId/artifacts`, and remembered nowhere. The "same id is a
  newer version" rule is a convention the model follows; nothing keys on
  it. A file that exists and is not declared is invisible to the host.
- **The graph knows none of it.** `src/graph/strut-schemas.ts` has nine
  types and `job` is an attribute on none — `StrutRun` carries no `job`,
  `actor`, `principal` or `origin`. The closest thing to an artifact in the
  graph is `StrutRun.output_preview`, a 500-character string. Nothing is
  searchable by a job's title or by what it produced.
- **The agent has no door.** The seed grants graph reads and
  `meta/list-workflows`, `get-workflow`, `run-workflow`, `get-run`. No
  jobs tool, no sessions tool, not even `meta/list-runs` — and
  `listRunSummaries` returns no `job`, so a run list could not be grouped.
  `search_runs` would hit `"job":"…"` on `run.start` lines by accident.
- **The one piece with bones is the session.** Each turn line in
  `turns.jsonl` records `workflow`, `runId`, `path`, actor and model
  (`NewTurn`, `src/session-store.ts`); `GET /sessions` lists them; the
  projector stamps `StrutAgentSession.session_id` + `session_turn`, so a
  thread is one query across runs and workflows. That is the shape to
  repeat: a record with lines pointing at runs, a read route, a graph
  attribute — and, because a job has a NAME a person refers to, one node.

## Proposed rulings

Each is a choice the owner has not made; the rest of the document assumes
them.

1. **The job record is the record of truth; the graph is its index.** As
   for runs and chats (`generic-storage.md` §7): the raw store is what
   tailing, resume and `DELETE` act on, the graph is the queryable picture
   on top, and every read route works on the filesystem backend with no
   graph at all.
2. **A job's title comes from the launch** — `POST …/run { job, title? }`
   — recorded on the job record by the route, the first launch's unless a
   later launch carries one. Not from the agent's output (the host names
   the job before its first turn), not from `input` (the stamp stays out of
   it, `jobs.md` §1). The field is called `title`, beside `job` and
   `callback`, the other launch-level fields that describe the job and the
   host rather than the run; it is a 400 without `job`.
3. **The runner records the run on the job, through the jobs capability**,
   at `run.start` when `opts.job` is set — one place every launch passes
   (the route, `strut.run`, `meta/run-workflow`, the builder's
   `run_workflow`), children included, resumes excluded (`run.resumed`).
   The alternative — the four launch sites each append — spreads one write
   over four files.
4. **Artifacts are a read-time fold, nothing stored.** A job's current
   deliverables are its top-level runs' `output.artifacts`, newest first,
   the first occurrence of each `id` winning, resolved by
   `resolveArtifactRefs`. The "same id is a newer version" rule becomes
   real here and nowhere else.
5. **A `StrutJob` node, no `StrutArtifact` node.** The job is an entity
   with a name; search must hit SOMETHING by that name and by what the job
   produced, and no existing node's indexed fields can carry it. An
   artifact's live form is one URL per (job, id), produced by the fold; its
   title and summary ride in the job node's indexed text. A node per
   artifact is added when something needs to point AT one — an `ACCESSED`
   edge from a later job that viewed it, or hive's artifact-events index
   moving in — and not before (the precedent: tool calls are nodes because
   `ACCESSED` hangs off them).
6. **Reading across jobs follows the key's trust domain.** `GET
   /jobs/:id/files` already serves any job's files to anyone with the API
   key; a step that reads another job's file is the same door from inside
   a run. A per-actor rule is left out (§8).
7. **The sweep keeps a record that has runs.** Today a job directory with
   nothing left is removed with its record. Once the record is the job's
   history — a small JSON file — only `DELETE /jobs/:id` removes it.

## Design in one paragraph

The job record gains a title, who launched it, when, and one line per run;
the route writes the first three from the launch body, the runner writes
the run line through the existing `ctx.services.jobs` capability at
`run.start`. A session's turn line gains the job it was made under, so a
thread is found from its job whatever its id. Two read routes — `GET /jobs`
(with `?q=`) and `GET /jobs/:id` — answer from the record, the run store and
the session store: the job's runs with status, its threads, its holds and
files, and its current deliverables folded from its runs' outputs and
resolved to links. The same reads back three lib steps, `job/list`, `job/get`
and `job/read`, which the seed grants, so a turn can find an earlier job by
words, see what it produced, open a page or a screenshot from it, and learn
the thread's id to continue. On a graph workspace the projector stamps `job`
on `StrutRun` and `StrutAgentSession` and upserts one `StrutJob` node per
job — title, a summary made of its artifacts and its latest reply, counts —
with an `IN_JOB` edge from each run, in the run-end hook that already
projects every run; `graph/graph-search` then finds a job by meaning,
`graph-neighbors` its runs, and `ACCESSED` what they read, with tools the
agent already holds.

## 1. The record

`JobRecord` (`src/jobs.ts`) today: `{ name, usedAt, repos, holds? }`. It
gains:

```ts
interface JobRecord {
  name: string;
  title?: string;        // the launch's; a later launch with one renames
  createdBy?: string;    // the first launch's actor (resolveActor), recorded, never checked
  createdAt?: string;    // the first launch
  usedAt: string;
  repos: Record<string, { cache: string; ref: string }>;
  holds?: JobHold[];
  runs?: Array<{ workflow: string; runId: string; at: string; parentRunId?: string }>;
}
```

Two writes, each where the information is, both on `JobsCapability`
(`ctx.services.jobs`, which already carries `hold` / `release` / `holds`):

- **`describe(job, { title?, createdBy? })`** — called by the run route
  (`createStrut.ts`, where `jobOf(body)` validates the id) and by
  `strut.run(wf, input, { job, title? })`, its in-code twin. Sets
  `createdAt` and `createdBy` on first sight, `title` whenever one is
  given. Under the record lock (`withLock(`${root}.json`)`), like `touchJob`.
- **`recordRun(job, { workflow, runId, parentRunId? })`** — called by the
  runner right after it emits `run.start` when `opts.job` is set, the way
  it reads `services.onRunEnd` off the bag today: one line appended,
  `usedAt` stamped. A child launched through `meta/run-workflow` carries
  the job and its controller's parent, so its line carries `parentRunId`
  and the reader can tell a turn from what the turn ran. `run.resumed`
  writes nothing — the run is already on the list. A check run (`origin:
  "verify"`) carries no job and is never recorded. A bare in-code run with
  no `jobs` on its bag records nothing, as it holds nothing.

The record is a file under `dataDir` whatever the workspace backend, as
today; the index is therefore complete on the filesystem backend.

## 2. The read routes

Behind `requireApiKey` like everything else. Both are thin over
`JobsCapability.list` / `get`, which `createStrut` builds with the run
store, the session store and `dataDir` in hand — the policy layer behind
both doors (the routes and the steps of §4), the `claims-authoring` /
`scheduler` pattern.

**`GET /jobs?q=&limit=`** → `{ jobs: [{ job, title?, createdBy?, createdAt?,
usedAt, runs, holds, busy? }] }`, newest `usedAt` first. `busy` names the
run holding the directory (`jobHolder`). `q` goes through the one matcher
in `src/search.ts` (`searchWorkflows`'s rule: every word must hit, name
hits first), with the title as the name and the current artifacts' titles
and summaries as the description — so "landing page" finds the job whose
plan is titled that, with or without a graph. The listing reads every
record; with `q` it also folds each job's artifacts (§3). Fine for a
swarm's dozens of jobs; a cap is one line if it is ever not.

**`GET /jobs/:id`** →

```ts
{
  job, title?, createdBy?, createdAt?, usedAt, busy?,
  holds: JobHold[],
  repos: string[],                           // directory names, as the record keys them
  files: string[],                           // listJobFiles, repositories skipped
  runs: [{ workflow, runId, parentRunId?, status, startedAt?, durationMs?, error? }],  // newest first; status from the summary, "running" without one
  sessions: [{ id, turns, updatedAt, busy? }],
  artifacts: ArtifactRef[] & { runId }[],    // the fold (§3): the job's current deliverables, each with the run that last reported it
}
```

A run of a sealed workflow (`src/sealed.ts`) launched under a job by a
person is listed with its status and nothing of its output, and its
artifacts are not folded: the meta surface may not read a sealed run, and
`job/get` is that surface from inside a run.

`GET /jobs/:id/files[/:path]` and `DELETE /jobs/:id` are unchanged; the
delete removes the record and so the index, and still touches no run,
chat or session. `specs/API.md` documents all of it.

## 3. The artifact fold

`jobs.md` §3's contract says the same `id` on a later run is a newer
version of the same thing, and nothing in strut keys on it. The fold does:

```
for each top-level run of the job, newest first (the record's lines without parentRunId):
  summary = getRunSummary(workflow, runId); skip without one, or status != success
  for each entry of artifactEntriesOf(summary.output):
    if its id is not yet seen: keep it, with this runId
resolve the kept entries with resolveArtifactRefs(…, { runId, job, exists })
```

The result is what the host would have assembled from every callback, and
what `GET …/runs/:runId/artifacts` gives for one run — nothing new is
resolved or stored. A `path` whose file was overwritten by a later turn
serves the later bytes: one live file behind one link, the contract as
written. Children's artifacts are not folded — a child names its files
under `/artifacts/<childRunId>/` as a `url` in the turn's own list when the
turn wants them shown (`jobs.md` §3).

For the agent's door (§4) each file-backed ref also carries `file`, the
absolute path on this host, so a turn can open it with the tools it has.

## 4. The session's job

`NewTurn` (`src/session-store.ts`) gains `job?: string`; the agent step's
commit (`steps/core/agent.ts`, the `record:` literal beside `actor` and
`principal`) writes `ctx.job`. `SessionInfo` gains `jobs: string[]`, the
distinct jobs across its turn lines (`sessionInfo`), so `GET /sessions`
shows which jobs a thread served. `GET /jobs/:id` lists `sessions` as
`list()` filtered on `jobs.includes(job)`, plus — for threads committed
before the field — `id === job || id.startsWith(job + "/")`, the seed's
naming convention. The job and the thread stay two stores (`jobs.md` §2):
the line records which job a turn was made under; it ties nothing.

## 5. The agent's door

Tools are steps. Three lib steps under `src/steps/lib/job/` beside
`job/dir`, each thin over `ctx.services.jobs`:

| step | input | output |
| --- | --- | --- |
| `job/list` | `{ q?, limit? }` | `GET /jobs`'s list |
| `job/get` | `{ job }` | `GET /jobs/:id`'s object, artifacts with `file` |
| `job/read` | `{ job, path }` | `{ kind, text? }` for a text kind, or `{ kind }` marked with `withMedia` (`core.ts`) for an image — the `browser/screenshot` pattern, so the model SEES it; the path guarded by `jobFilePath`, size-capped (a text over the cap comes back head + tail, the shell's rule) |

The seed adds the three to `params.tools` and one line to `params.system`:
earlier jobs are findable by words, and a thread's id is on a job's run
output (`session.id`) for a turn that should continue it. Text artifacts
need `job/read` only for the media case: `bash` is not sandboxed to `cwd`
and `job/get`'s `file` is a path `cat` can read. Writing into another job's
directory stays impossible by construction — `job/dir` hands out this
run's job only, and the hold is per directory.

**Continuing another job's thread** is then a run with that `session` —
the seed's `session` input accepts one, so `meta/run-workflow { name:
"job", input: { session, prompt } }` from inside a turn does it, under THIS
job's directory (the child shares it, `jobs.md` §2). The thread remembers
files that are in the other job's directory. That mismatch, and
`session_busy:` when the other job is mid-turn, are the two things a
ruling on "reconnect" has to settle; this plan finds the id and stops.

## 6. The graph

Two additions in `src/graph/strut-schemas.ts`, the projector reading them,
the conformance cases AGENTS.md asks for, under `npm run test:graph`.

**The attribute.** `job: "?string"` on `StrutRun` and `StrutAgentSession`
(and `StrutChat` once `jobs.md` §7 lands `job` on chats). The projector
reads `run.start.job` (`projectRunEvents`'s `start`) and stamps every
session of the run with it. "Everything in job X" is then one match, and
the job joins the tool calls and `ACCESSED` nodes through the edges that
exist — the `session_id` precedent, `agent-sessions.md` §4.

**The node.**

```ts
{
  type: "StrutJob",
  node_key: "strutjob-job_id",
  exact_key: true,          // ids may hold `/`, `.`, `-`: jarvis's sanitizer would fold `abc/review` and `abc-review`
  index: ["title", "summary"],
  title_key: "title", description_key: "summary",
  type_description: "A strut job — one directory and one history across many runs",
  attributes: {
    job_id: "string",
    title: "?string",       // the record's, else the id
    summary: "?string",     // the search text: each current artifact as `title — summary`, then the latest turn's `text`, cut at a cap of its own (2000)
    created_by: "?string",
    created_at: "datetime",
    last_used_at: "?datetime",   // `updated_at` is a generic node property the seed refuses
    run_count: "?int",
    artifact_count: "?int",
    log_ref: "?string",     // the job id — `GET /jobs/:id` is the record
  },
}
```

One edge row: `{ edge: "IN_JOB", source: "StrutRun", target: "StrutJob" }`.
The session reaches the job through `IN_RUN` in one hop; a chat edge comes
with `job` on chats.

**When.** In `projectRun`, after the run's own nodes: when `start.job` is
set, `jobs.get(job)` (the projector takes an optional `jobs:
Pick<JobsCapability, "get">`, as it takes a `ChatStore`), upsert the
`StrutJob` from the record and the fold, and write the `IN_JOB` edge from
this run. That is the run-end hook `createStrut` already runs for every
top-level run, detached, so no new hot path and nothing on the fs backend.
A job's node is therefore as fresh as its last finished run; `projectRuns`
(the batch) does the same per run it visits. The schema seed adds the type
on boot, add-only, so a deployed graph picks it up on restart.

**For the agent.** `graph/graph-search` filtered to `StrutJob` finds a
job by meaning — the hybrid search over `Data_Bank` built from `title` and
`summary`; `graph/graph-neighbors` on it lists the runs; a run's sessions
and their `ACCESSED` nodes are the existing hops. `job/get` then hands the
links. The agent's tool list grows by the three steps of §5 and nothing
graph-shaped.

**Deletion.** `DELETE /jobs/:id` removes the record. The node is the
history's picture and stays, like a `StrutRun` whose log was removed; the
next projection cannot refresh it (no record) and leaves it. A soft delete
of the node on `DELETE` is one call if a dangling job ever bothers a
listing.

## 7. The host

Hive passes `title` on the launch body beside `job` (`dispatchStrutRun` in
`lib/ai/strutTools.ts`, where `start_job` already has the title in hand)
and may keep it on `input` for the reply header as today. `StrutRun.jobId`
remains hive's own job-to-rows lookup; the reader route and the artifact
cards are unchanged. Nothing else.

## 8. Left out

- **`job` on chats** (`jobs.md` §7): the builder as a job's driver; the
  `StrutChat` attribute and the `IN_JOB` chat edge come with it.
- **Renaming through a route** (`PATCH /jobs/:id { title }`): a later launch
  with a title renames; enough for now.
- **`StrutArtifact` nodes** — ruling 5: when something must point at an
  artifact, or when the artifact-events index (`job-artifact-events.md`)
  moves from hive into strut.
- **History of one file** (`jobs.md` §10): the fold gives the current
  version of each id; versions are the file history's job.
- **A per-actor read rule** — ruling 6.
- **A jobs sidebar in the web UI** — `GET /jobs` is its data; the run
  flyout showing `job` in the summary is one line, done with §1 or after.
- **`job` in the builder's `list_runs` result** — the slim entries could
  carry it; the index makes the per-workflow listing the wrong door for
  jobs anyway.

## 9. Work items

One strut PR in two commits, so the filesystem half stands alone:

1. **The record and its doors.** `JobRecord` fields + `describe` /
   `recordRun` on `JobsCapability` (§1), the runner's call at `run.start`,
   the route's `title`, the sweep keeping a record with runs (ruling 7);
   `NewTurn.job` + `SessionInfo.jobs` (§4); `JobsCapability.list` / `get`
   with the fold (§2, §3); `GET /jobs`, `GET /jobs/:id`; `job/list`,
   `job/get`, `job/read` (§5). `specs/API.md`, AGENTS.md (the jobs
   paragraph, the `job/` layout line, the `/sessions` list shape).
2. **The graph.** `StrutJob` + `job` attributes + `IN_JOB` (§6), the
   projector's `jobs` dep, the live cases.

Then the mcp seed (§5: the three steps in `params.tools`, the system
line, a sentence on the `Job` Concept page), pinned to the strut commit;
then hive's one line (§7).

## 10. Validation

Offline (`npm test`):

- A launch with `job` and `title` writes `title`, `createdBy`, `createdAt`
  and one run line; a second launch with no title keeps it, with a title
  renames it; a child through `meta/run-workflow` adds a line with
  `parentRunId`; a resume adds none; a check run adds none; a bad `title`
  without `job` is a 400.
- `GET /jobs` lists newest-used first with counts and `busy`; `?q=`
  matches on the title and on an artifact's title, every word required.
- `GET /jobs/:id`: runs with status from summaries and `running` without
  one; sessions by the turn line's `job` and by the naming fallback;
  artifacts folded newest-first with the first `id` winning, a later turn's
  overwritten file served, a sealed run's output withheld; 404 for an
  unknown job; both routes 401 without the key (the sweep in
  `createStrut.test.ts`).
- The session store round-trips `job` on a turn line and `jobs` in its
  info (`storage-conformance.test.ts`, both impls).
- `job/list` / `job/get` return the routes' shapes from inside a run;
  `job/read` returns text for a markdown file and a media-marked output
  for a PNG, refuses `..`, caps a large text.
- The sweep leaves a record with runs in place when its directory is empty.

Live (`npm run test:graph`): a run with a job projects `StrutRun.job`,
`StrutAgentSession.job`, one `StrutJob` with the title, the summary built
from the artifacts and the text, and an `IN_JOB` edge; a second run of the
job upserts the same node (one node, two edges) with the newer artifact
first in the summary; a run without a job projects no job node.
