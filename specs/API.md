# HTTP API — workflows and runs

How a client publishes a workflow, runs it, follows the run, and reads it
back. Every shape below is the one the server sends today; the types it is
lifted from are named so the two can be kept together (`src/core.ts`,
`src/store.ts`, `src/workspace.ts`, the routes in `src/createStrut.ts`).

Everything is JSON unless a row says otherwise. An error is
`{ "error": "<message>" }` with a 400 / 401 / 403 / 404 / 409 status. Companion
how-tos: `CALLBACKS.md` (the result pushed to your endpoint),
`RUN_CONTROL_SPEC.md` (why control is cooperative), `SPEC.md` (the engine).

## Auth

With `STRUT_API_KEY` set there are **no public endpoints**: every request in
this document — reads, runs, streams, transcripts, artifacts — needs
`Authorization: Bearer <STRUT_API_KEY>`, and gets a `401` without it. Where a
header cannot be set the key may ride as `?key=` (the dictation socket) — but
a run's or a job's files take a scoped read token instead, `?t=`, minted by
their listing, so the key never sits in a URL a served page could read
(`/artifacts/:runId` below). Unset (dev mode) everything is open. The only
things served without the key are the web UI's own files and `GET /health`
(§8). The examples below leave the header out for brevity; add
`-H "Authorization: Bearer $STRUT_API_KEY"`.

`x-strut-actor: <id>` names who a request is from — honored only alongside a
matching key — and is recorded on the run (`actor`, `principal`) and on the
workflow it publishes (`owner`). AGENTS.md "Auth" has the whole model.

**A peer's key.** `STRUT_PEER_KEY` is the key another strut holds for this
one (§10). It is presented like `STRUT_API_KEY` (Bearer or `?key=`) but is
**peer-scoped**: every `GET`, a launch (`POST /workflows/:name[/:version]/run`),
and cancel / pause / resume (§6) of a run a peer launched — that run's
`run.start` carries `origin: "peer"`. Anything else is a `403`.
`x-strut-actor` is honored beside it: a peer's launch names the person it
is for. A host that authenticates requests itself decides the scope per
request instead (`createStrut({ resolveScope })`). A launch is not narrowed
by workflow: a peer can run any workflow here, and one whose agent has
`bash` reaches whatever this server can.

## 1. Publish

| Method | Path                | Body                                                                 | Response |
| ------ | ------------------- | -------------------------------------------------------------------- | -------- |
| POST   | `/workflows`        | `{ name, steps \| yaml, input?, params?, claims?, description?, category?, source? }` | 201 `{ ok, workflow, version: "v1", active: "v1", renamed, requested, claims? }` |
| POST   | `/workflows/:name`  | `{ version, steps \| yaml, input?, params?, claims?, description?, source? }` | 201 `{ ok, workflow, version, active, claims? }` |

- `steps` is an array of step objects (below) and the server writes the YAML;
  `yaml` is the whole file as text, `input:` / `params:` / `claims:` blocks
  included. One or the other.
- A create whose `name` is taken gets a suffixed name: `renamed: true`,
  `requested` is what you sent, `workflow` is what was stored.
- `version` is your label (`v2`). A new version becomes active. Reusing a
  label **overwrites** that version's content; the same content under a new
  label is a second version with the same `hash`.
- Each version records where it came from: `source` is `"ui"` when the web
  UI publishes and `"api"` for anything else over HTTP (no other value is
  accepted here), with the request's `actor`. The other doors stamp their
  own: `seed` (a host's boot-time seeder), `builder` (the chat builder),
  `agent` (`meta/publish-workflow`), `promote` (a promoted param). Versions
  published before this was recorded have none.
- 400 for what the workspace refuses — a bad `input:` block, or an unquoted
  template (`message: {{ input.x }}` parses as a YAML mapping; write
  `message: "{{ input.x }}"`).

A step (`Step` in `src/core.ts`):

```json
{
  "id": "review",
  "type": "llm",
  "config": { "model": "{{ params.model }}", "prompt": "{{ fetch.markdown }}" },
  "depends": ["fetch"],
  "when": true,
  "options": { "retry": { "max": 3, "delayMs": 1000 }, "onError": { "id": "fallback", "type": "log", "config": {} } }
}
```

`depends` omitted = after the previous step; `[]` = start at once; a list =
wait for all. `when` gates on an `if` step's result. `input` declares the run
payload (`src/input-block.ts`): `{ "<field>": { "type": "string" | "number" |
"boolean" | "json", "required"?, "default"?, "description"? } }`, required
unless it has a default. `params` are the tunable defaults `{{ params.* }}`
reads.

## 2. Read workflows

| Method | Path                            | Response |
| ------ | ------------------------------- | -------- |
| GET    | `/workflows[?q=]`               | `[{ name, activeVersion, versions: ["v1", …], description?, category?, publisher?, owner?, maxRunCostUsd?, automations?, lastRunAt? }]` |
| GET    | `/workflows/:name`              | `{ active, versions: { "v1": { createdAt, description?, hash?, source?, actor? }, … }, category?, publisher?, owner?, maxRunCostUsd?, automations? }` (`WorkflowMetadata`) |
| GET    | `/workflows/:name/flow[?version=]` | `{ name, steps, input?, params?, promotes? }` — the parsed active (or named) version |
| GET    | `/workflows/:name/versions`     | `{ active, versions: [{ version, createdAt, description?, source?, actor?, runs, success, error, lastRunAt? }], unattributed }` newest first; counts by the run's recorded `workflowHash` |
| GET    | `/workflows/:name/:version`     | the YAML source, `text/yaml` |
| PUT    | `/workflows/:name/active`       | `{ version }` → `{ ok, workflow, active }` — rollback; publishes nothing |
| DELETE | `/workflows/:name`    | `{ ok, workflow }` — every version, metadata, schedules and run records; 409 while a run is in flight |

`?q=` is the sidebar's filter: the query is split into words and every word
must appear (case-insensitive) in the name, the category or the description.
Name hits rank first; otherwise the list keeps its order. Empty or absent
returns everything.

## 3. Run

| Method | Path                            | Body | Response |
| ------ | ------------------------------- | ---- | -------- |
| POST   | `/workflows/:name/run`          | `{ input?, params?, paramOverrides?, runId?, callback?, job?, title?, jobCallback?, mcp? }` | 202 `{ runId, callback?: true, jobCallback?: true, mcp?: true }` |
| POST   | `/workflows/:name/:version/run` | same | same |

| Field            | Meaning |
| ---------------- | ------- |
| `input`          | the run payload, validated against the workflow's `input:` block (unknown keys dropped); `{}` when omitted |
| `params`         | shallow-merged over the workflow's `params:` defaults for this run only |
| `paramOverrides` | `{ "<workflow name>": { … } }` — the same, per workflow, reaching subflows |
| `runId`          | your own id (unique within the workflow); default a millisecond timestamp, e.g. `"1790436489808"` |
| `callback`       | `{ url }` (http/https) — the result is POSTed there when the run settles; see `CALLBACKS.md`. Any other scheme is a 400 and nothing launches |
| `job`            | the job to launch under (`plans/jobs.md`): an id you mint, the format of a session id (§9); a bad one is a 400 and nothing launches. Recorded on the run, handed to steps as `ctx.job` and to templates as `{{ $job }}`; `job/dir` gives the run the job's directory, and the callback resolves the output's `artifacts[]` into it (`CALLBACKS.md` §4). The run is also recorded on the job — `GET /jobs/:id` (§5) lists it |
| `title`          | the job's name (`plans/job-index.md`), recorded on the JOB, never on the run: the host's label for it, kept until a later launch carries another. 400 without `job` |
| `jobCallback`    | `{ url }` (http/https) — the JOB's live updates (`job.update`: a hold taken or let go, a check's evidence, a verify ended, a step's screenshot or walkthrough frame) are POSTed there as they happen, from every run under the job; see `CALLBACKS.md` §5. Kept on the job, never returned; the latest launch that carries one wins, `null` clears it, absent keeps it. 400 without `job` or for another scheme |
| `mcp`            | `[{ name, url, token?, headers?, toolFilter? }]` (`McpServer`, `src/core.ts`; at most 10) — YOUR MCP servers, the way back into you for this run's agents: every `agent` step gets their tools as `<name>_<tool>` unless it says `mcp: false`, and so do the jobs a turn starts (`job/start`, `job/continue`) and the runs it launches (`meta/run-workflow`) — never a peer. `url` is a Streamable HTTP endpoint (http/https); `token` is sent as `Authorization: Bearer <token>`, `headers` for any other scheme; `toolFilter` keeps those tools only (names or globs). `name`: letters, digits, `_`, `-`, unique. A bad entry is a 400 and nothing launches. The log records `mcp: [{ name, origin }]` only; the entries are kept beside it for a resume and returned by nothing. A server that cannot be reached when an agent starts is skipped, the agent going on without its tools |

The run is **detached**: the 202 comes back before anything executes, the
run keeps going whether or not you stay connected, and every event is
appended to a log you can read or tail at any time (§4, §5). 404 when the
workflow or version does not exist.

Input is validated **inside** the run, so a bad payload is still a 202. The
run then ends at once with `status: "error"` and a message starting `Input
validation failed:` — its log holds a single `run.error` and no `run.start`.

```bash
curl -X POST http://localhost:3000/workflows/hello/run \
  -H 'Content-Type: application/json' \
  -d '{ "input": { "name": "World" } }'
# → 202 { "runId": "1790436489808" }
```

## 4. Follow a run

`GET /workflows/:name/runs/:runId/stream` is server-sent events. It replays
the log from its first line, then follows appends until the run's terminal
event, then sends one `done` frame and closes. The same request serves a
live run and a finished one (a finished run replays and closes at once), so
attaching late loses nothing.

```
data: {"ts":"…","runId":"1790436489808","path":"hello","type":"run.start","input":{"name":"World","pauseMs":3000},"workflowHash":"31054c203d38"}

data: {"ts":"…","runId":"1790436489808","path":"hello/greet","type":"step.start","stepType":"log","input":{"message":"Hello World!"}}

data: {"ts":"…","runId":"1790436489808","path":"hello/greet","type":"step.end","stepType":"log","output":"Hello World!","durationMs":1}

…

data: {"ts":"…","runId":"1790436489808","path":"hello","type":"run.end","output":"Bye World after 3000ms"}

event: done
data: {"runId":"1790436489808","status":"success","output":"Bye World after 3000ms"}
```

- Every unnamed frame's `data` is one event (§5.3), an agent session
  replaced by its `transcript` link.
- `done` carries `{ runId, status, output?, error? }` (`RunResult`), with
  `status` one of `success`, `error`, `cancelled`. If the run has no summary
  yet (it was resumed and is still going) `status` is its live state instead.
- **A stale run's tail ends.** A log with no terminal event and no live
  process behind it — a run cut off by a crash that was not resumed — is
  replayed and then closed with `done { runId, status: "stale" }` rather
  than followed forever. Resume it (`POST …/resume`) and tail again.
- A resumed run appends past its old terminal event; a tail open at the
  time keeps following.
- **An unknown run id never errors.** With no log and no live run behind
  it, the tail closes at once with `done { status: "stale" }` (above) —
  it does not wait for a log to appear. Launch first, or check `GET
  …/runs/:runId`, before streaming an id you did not just get from a 202.
- `?skip=N` leaves out the first N events. SSE is never compressed and
  every event is its own frame, so for a big log read `GET …/runs/:runId/events`
  first (one gzipped response, §5) and tail with `skip` set to its length:
  the log is append-only, so the count is a race-free cursor. The tail still
  tracks the terminal event through the skipped ones — a `skip` past the end
  of a finished log sends just `done`. Not an integer ≥ 0 → 400.

```js
const es = new EventSource(`${BASE}/workflows/hello/runs/${runId}/stream`);
es.onmessage = (m) => console.log(JSON.parse(m.data));           // each event
es.addEventListener("done", (m) => { console.log(JSON.parse(m.data)); es.close(); });
```

## 5. Read a run

| Method | Path                                                   | Response |
| ------ | ------------------------------------------------------ | -------- |
| GET    | `/runs/active`                                         | every run executing in this server process, any workflow: `[{ workflow, runId, state, parentRunId?, job?, jobTitle? }]` — `state` a §5.2 live state, `parentRunId` on a nested run, `job` + `jobTitle` the job it was launched under and the launch's `title`. A `stale` run is not listed |
| GET    | `/workflows/:name/runs`                                | array, newest first, no paging: a summary (§5.1) per finished run, `{ runId, workflow, status, job?, jobTitle? }` for one still going (§5.2 states; `job` + `jobTitle` as on `/runs/active`) |
| GET    | `/workflows/:name/runs/:runId`                         | the summary (§5.1); a partial one (§5.2) while the run is going or if it died before finalizing; 404 only when there is no log at all |
| GET    | `/workflows/:name/runs/:runId/events`                  | every event, in order (§5.3) |
| GET    | `/workflows/:name/runs/:runId/transcripts/<step path>` | one agent session as a bare array of AI SDK model messages; 404 if that step recorded none. For a step that continued a `session` (§9) this is its system prompt + THAT TURN; `?full=1` is the thread up to and including it (404 once the session is deleted) |
| GET    | `/workflows/:name/runs/:runId/artifacts`               | `{ workflow, runId, job?, artifacts: [{ id, kind, title, label?, summary?, url? \| content? \| error? }] }` — the deliverables the run's output declared, resolved as the run callback resolves them (`CALLBACKS.md` §4); 404 until the run has a summary |
| GET    | `/workflows/:name/evidence[?runId=&limit=&before=]`   | what the checks said about the workflow's runs (§5.4) |
| GET    | `/artifacts/:runId`                                    | `{ runId, files: ["report.md", …], token? }` — what the run's steps wrote, and the run's **file token** (present when there is a secret to sign it: `STRUT_API_KEY`, else `STRUT_SECRET_KEY`): a `GET` of this listing or of any file under it with `?t=<token>` needs no key — the link form, worth this run's files and nothing else (an HMAC of the run id under the secret: no store, rotates with it). A `?t=` strut cannot vouch for is a 401 even on an open strut, so a host's gate may hand token-bearing reads through; 501 when the deployment has no artifact store |
| GET    | `/artifacts/:runId/<path>`                             | the file, content-typed by extension (unknown → `application/octet-stream`), with `X-Content-Type-Options: nosniff` and `Access-Control-Allow-Origin: *`; 404 for a path that is not a file (a directory: the listing is what names what is in it). A step wrote it, so everything but `video/*` and `audio/*` also carries `Content-Security-Policy: sandbox`: opened in a browser it has no origin, and only `text/html` read by its file token runs script (`sandbox allow-scripts`) — a page an agent built runs, and the one thing in its URL is that token; read with the key, or through a host's gate, it runs none. A host that frames or proxies artifacts must keep these headers |
| GET    | `/jobs?q=&workflow=&limit=`                            | `{ jobs: [{ job, title?, createdBy?, actors?, createdAt?, usedAt, busy?, runs, holds }], actor? }` — every job, newest-used first (`plans/job-index.md` §2): `runs` and `holds` are counts, `busy` the run working in its directory now, `actors` everyone who launched a run under it (first seen first; `createdBy` is the head). `q` is the workflows' matcher (§2): every word must hit the title (the id, without one) or the title or summary of a current deliverable. `workflow` keeps the jobs with a recorded run of that workflow (a job from before its runs were recorded on it never matches). `mine=1` keeps the jobs whose `actors` include the request's actor — `actor` in the response is who the server took the request to be from (`resolveActor`); absent, `mine` lists nothing |
| GET    | `/jobs/:id`                                            | the job read back: `{ job, title?, createdBy?, createdAt?, usedAt, busy?, holds: [{ id, kind, since, note?, url? }], urls, repos, files, runs: [{ workflow, runId, at, parentRunId?, status, durationMs?, error?, sealed? }], sessions: [{ id, turns, …, busy? }], artifacts: [{ id, kind, title, summary?, url?, content?, runId, path? }], text?, claims? }` — `claims` is the job's ledger (§5.5), present only where the claims layer is on; `runs` newest first, `status` from the run's summary (`running` without one); a run with a `parentRunId` is one a turn launched, not a turn; a sealed workflow's run shows `sealed: true` and nothing past its status. `holds` are what the job keeps alive beyond a run (`plans/jobs.md` §6), each with a `url` when what it holds has an address; `urls` is the first hold of each kind that has one (`{ pod: "https://…" }`). `sessions` are the threads made under the job (a turn line's `job`, §9) or named after it. `artifacts` are the job's CURRENT deliverables — its successful top-level runs' `artifacts[]`, newest first, the first of each `id` winning, resolved as `…/runs/:runId/artifacts` resolves them, each with the run that last reported it and, for a file, its `path` in the directory (what `job/read` takes); `text` is the newest such run's `output.text`. `threads` (`plans/jobs-sidebar.md`, `src/job-threads.ts`) is the job's execution as a tree: every agent execution in its runs' logs — a `step.end` carrying `messages`, or an attempt of the core `agent` step — grouped by session into `[{ id, session, label, startedAt, updatedAt, turns, totals: { turns, usage, cost, toolCalls, context? } }]`, each turn `{ runId, workflow, path, stepType, label, at, durationMs?, status, turn?, session?, usage?, cost?, context?, toolCalls, transcript?, artifacts?, nodeCount, nodes?, spawned, peer? }` — `transcript` the §5 link (`?full=1` for a session turn), `artifacts` the run's declared deliverables on its last top-level turn, `spawned` the threads the turn caused (a sub-agent under its path, a child run it launched, a `strut/run-workflow` peer run with `peer: { id, workflow, runId, status }`), a run with no agent one turn of `stepType: "run"`. Chronological at every level. `?threads=0` leaves it out, `?nodes=1` adds each turn's touched graph nodes, `?limit=N` bounds the runs the fold reads (newest first; `omittedRuns` counts the rest). 404 for an unknown job |
| GET    | `/jobs/:id/claims`                                     | `{ enabled, job, claims: LedgerClaim[] }` — the job's ledger alone (§5.5): what the work must deliver and whether it does, as of its newest turn. `{ enabled: false, claims: [] }` without the claims layer; 404 for a job not on file |
| POST   | `/jobs/:id/verify`                                     | `{ claims?: [<claim id>], detach?: boolean }` (gated) → `{ job, key, runId, subjects, checks: [{ subject, path, claimId, checkId, lastVerify }], evidence, slots, costUsd, claims: LedgerClaim[] }` — verify the job NOW against its newest turn (`runId`): every check on every claim about the job fires, `manual` ones included, and evidence on an already verified turn is appended, not skipped; the ledger comes back with each check's `lastVerify`. `claims` narrows to ids; no body is every claim. `detach: true` answers 202 `{ job, started: true }` at once instead — each check's evidence and the pass's end reach the job's `jobCallback` (`CALLBACKS.md` §5), the ledger is `GET /jobs/:id/claims` after; a detached verify while one runs joins it. 404 for a job not on file, 409 without the claims layer |
| GET    | `/jobs/:id/files`                                      | `{ job, files: ["plan.md", …], token? }` — every file in a job's directory (`job/dir`, `plans/jobs.md`), recursive, skipping the repositories checked out into it, and the job's file token, as `/artifacts/:runId` mints the run's; 404 for a job with no directory, 400 for a malformed id (percent-encode a `/`) |
| GET    | `/jobs/:id/files/<path>`                               | the file, served exactly like `/artifacts/:runId/<path>` — same content types, same headers, the job's token as `?t=` |
| DELETE | `/jobs/:id`                                            | `{ ok: true, job, released: [<hold id>, …] }` — close a job (`plans/jobs.md` §6): every hold a tool registered on it (a pod) is released through its release step, then the repositories, the directory and the record are removed; runs, chats and sessions are records of their own and stay. 409 while a run holds the job; 500 and nothing removed when a hold will not release (the error names it — call again); 404 for a job with neither a directory nor a record |

### 5.1 Summary (`RunSummary`, `src/core.ts`)

```json
{
  "runId": "1790436489808",
  "workflow": "hello",
  "startedAt": "2026-09-26T15:28:09.808Z",
  "finishedAt": "2026-09-26T15:28:12.815Z",
  "durationMs": 3007,
  "status": "success",
  "input": { "name": "World", "pauseMs": 3000 },
  "output": "Bye World after 3000ms",
  "workflowHash": "31054c203d38",
  "stepCounts": { "log": { "success": 2, "error": 0, "lastAt": "…" }, "wait": { "success": 1, "error": 0, "lastAt": "…" } }
}
```

| Field          | Value |
| -------------- | ----- |
| `status`       | `success`, `error` or `cancelled` |
| `input`        | as validated (defaults filled) — the raw body when validation itself failed |
| `output`       | the workflow's output, its last step's; success only |
| `error`        | `{ message, stack? }`; error only. A cancelled run has neither |
| `workflowHash` | content hash of the version that ran — what `GET …/versions` counts by |
| `stepCounts`   | executions per step type across the whole tree; a tool an agent called is `tool:<type>` |
| `totals`       | `{ modelCalls, usage, cost }` — what the run's model calls spent: the sum of its `step.end` events' fields of the same names (§5.3), sub-agents included, and a run a `meta/run-workflow` step waited on (so summing summaries counts such a child twice). `cost` is dollars at aieo's list prices, an estimate — not the gateway's bill. Absent when nothing called a model |
| `actor`, `principal` | who launched it and who is billed, when known |
| `automation`   | `{ id }` when a schedule fired it |
| `job`          | the job it was launched under (§3), when one was given |

After a durable resume (§6.2) the summary describes the resumed execution:
`startedAt` is the resume's, and replayed steps are not counted again.

### 5.2 Partial summary (`PartialRunSummary`, `src/store.ts`)

Served for a run with no summary yet. `partial: true` is the discriminator;
never treat one as a result.

```json
{
  "runId": "1790436489808",
  "workflow": "hello",
  "partial": true,
  "status": "running",
  "eventCount": 4,
  "steps": { "greet": "Hello World!" },
  "startedAt": "2026-09-26T15:28:09.809Z",
  "input": { "name": "World", "pauseMs": 3000 },
  "lastEventAt": "2026-09-26T15:28:09.812Z",
  "lastEvent": { "type": "step.start", "path": "hello/pause", "ts": "…" }
}
```

| Field       | Value |
| ----------- | ----- |
| `status`    | the live state — `running`, `pausing`, `paused`, `cancelling` — or `stale`: no process is running it (it crashed, or the server restarted); resumable (§6.2) |
| `steps`     | the latest output of each finished top-level step, in completion order |
| `lastError` | `{ path, message, ts }` — the last `step.error` anywhere, where a dead run stopped |
| `lastEvent` | `{ type, path, ts }` — how far the log got |

### 5.3 Events (`RunEvent`, `src/core.ts`)

One object per line of the run's append-only log. Common fields:

| Field        | Value |
| ------------ | ----- |
| `ts`         | ISO time |
| `runId`      | the run |
| `path`       | `<workflow>` for run events; `<workflow>/<stepId>` for a step, nesting through subflows (`wf/sub/child`), `#n` for a loop or foreach iteration (`wf/each#2/review`), `NNN-<tool>` for a tool an agent called (`wf/review/003-agent`) |
| `type`       | below |
| `stepType`   | the step's type (`log`, `agent`, `tool:<name>` for an agent's tool call); bare even when the workflow pinned a version |
| `input`      | on `run.start` the validated payload; on `step.start` the resolved config (a subflow's child input; a foreach's items) |
| `output`     | on `run.end` / `step.end` / `step.replayed` |
| `error`      | `{ message, stack? }` on `run.error` / `step.error` |
| `durationMs` | on `step.end` / `step.error` |
| `transcript` | on an agent step's `step.end`: the URL of its session (the `messages` never ride in this response) |
| `nodes`      | on `step.end`: the graph nodes the step read or wrote, `[{ ref_id, node_type?, name? }]`, never truncated — on a graph step the workflow ran (`graph/graph-get`) and on one an agent called (`tool:graph_graph_get`) alike. Only nodes the caller NAMED (fetched, expanded, created, edited, moved): a search's hits and the neighbors or children a call listed are not in it. `name` is the node's label when it was touched. Absent when the step touched none |
| `toolCallId` | on a tool call's `step.start` / `step.end` / `step.error` (`stepType: tool:<name>`): the AI SDK's id for that call — the key to the same call's `tool-result` part in the agent's transcript (§5), which holds the full result where `output` here is a 1,500-char preview |
| `modelCalls`, `usage`, `cost` | on the `step.end` of a step that called a model — an `agent`, an `llm`, a sub-agent's or an llm's tool call (whose `output` here is a preview string) — or waited on a run that did (`meta/run-workflow`: that run's totals): how many calls, their tokens `{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens }`, and their cost in dollars. Each spend is on exactly one event — an agent's own fields never include its sub-agents' — so a run's spend is their sum (the summary's `totals`). Absent on a step that called none |

| Type              | Meaning |
| ----------------- | ------- |
| `run.start`       | first line; carries `input`, `workflowHash`, `stepHashes` (custom step versions), `params` / `paramOverrides`, `actor` / `principal`, `origin` (`schedule` / `verify` / `peer`), `automation`, `callback: { origin }`, `mcp: [{ name, origin }]`, `parentRunId` when nested |
| `step.start` / `step.end` / `step.error` | one execution; `step.error` is final, after retries |
| `step.retry`      | an attempt failed and another follows |
| `step.skipped`    | not run: its `when` gate did not match, or every step it depends on was skipped |
| `run.end`         | terminal, success; `output` |
| `run.error`       | terminal, failure; `error` |
| `run.cancelled`   | terminal, cancelled |
| `run.cancelling` / `run.paused` / `run.resumed` | control markers (§6); not terminal. `run.resumed` reopens a log after a terminal event and carries `stepHashes`, `callback: { origin }` and `mcp` like `run.start` |
| `step.replayed`   | on resume: a finished step's journaled `output`, not re-executed |

`step.start.stepVersion: { version, hash }` records a pinned custom step's
version; `step.start.subflow: { workflow, version?, hash? }` the child a
subflow step resolved. Tool-call events inside an agent step have their I/O
truncated for the log; every other input and output is stored whole.

### 5.4 Evidence (`RunEvidence`, `src/claims-authoring.ts`)

Every run of a workflow is checked against its claims (`plans/claims.md`):
the workflow's own and those of each custom step it executed. `GET
/workflows/:name/evidence` returns what those checks recorded, newest run
first and by step path within a run:

```json
{
  "enabled": true,
  "workflow": "clipper",
  "evidence": [
    {
      "claim": { "id": "…", "text": "end is after start" },
      "subject": { "kind": "step", "name": "clip/compute-times", "version": "<content hash>" },
      "verdict": "refutes",
      "content": "exit 1",
      "observedAt": 1790436490,
      "mode": "observed",
      "check": "…",
      "checkVersion": "exec",
      "run": { "name": "clipper", "runId": "1790436489808", "path": "clipper/times" }
    }
  ],
  "next": "1790436489808"
}
```

- `verdict` is `supports`, `refutes`, or `open`: an external check's
  question (`question`), still waiting on someone. `mode` is `observed` (a
  check measured it) or `asserted` (a model's or a person's word). `by`
  names who asserted it.
- `limit` counts **runs**, not rows (default 50, 1–200; out of range is a
  400). Only runs that produced evidence count. `next` is present when the
  page is full; pass it as `before` to get older runs. `runId` returns one
  run.
- `subject.version` is the version the run executed. A claim that was
  reworded later still shows the text its check tested.
- On a workspace without claims (the filesystem backend, `STRUT_CLAIMS=0`)
  the response is `{ "enabled": false, "evidence": [] }`.

### 5.5 A job's claims (`LedgerClaim`, `src/ledger.ts`; `plans/job-claims.md`)

A claim may be about a **job** — `{ kind: "job", name: <job id> }` on every
claim route and tool — and then states what the WORK must deliver ("the
settings page renders"), not how a template behaves. Its version is the
turn: evidence is about the job's newest top-level run, a later turn makes
it `stale`, and a check on a job is `manual` by default (`sample` is
refused) — it fires when the work agent calls `meta/verify-job` before it
reports, or when a person calls `POST /jobs/:id/verify`. `GET /jobs/:id`
carries the ledger as `claims`; `GET /jobs/:id/claims` serves it alone:

```json
{
  "enabled": true,
  "job": "j-1",
  "claims": [
    {
      "id": "…",
      "text": "the settings page renders",
      "status": "supported",
      "assertedOnly": false,
      "unverified": 0,
      "latest": {
        "content": "https://pod.example/settings: renders",
        "observed_at": 1792018615,
        "mode": "observed",
        "check": "…",
        "checkVersion": "probe/shot",
        "about": "1792018615451",
        "locator": { "url": "/jobs/j-1/files/shots/j-1.png", "file": "shots/j-1.png" }
      },
      "checks": [
        { "id": "…", "name": "shot", "lastVerify": { "ran": true } },
        { "id": "…", "name": "eyes", "external": true, "lastVerify": { "planned": "<evidence id>" } }
      ]
    }
  ]
}
```

- `latest.about` is the TURN the verdict is about (a run id); `locator` is
  what the check pointed at — a screenshot the job's files serve (`GET
  /jobs/:id/files/<path>`), an endpoint's url.
- `lastVerify` is per check, from the latest pass: `{ ran }`,
  `{ skipped: policy | budget | cannot-launch | superseded | denied, reason? }`
  — `superseded` is a verify of a turn that is no longer the newest; nothing
  about a job is backfilled — or `{ planned: <evidence id> }`, an external
  check waiting on a person.
- A person answers an external check, or vouches, with `POST
  /claims/:id/evidence { job, runId, supports, content, slot? }` (gated):
  `runId` must be one of the job's turns, else 400; an open slot on that
  turn is filled, otherwise a new asserted evidence is written. A
  refutation on the newest turn wins over every instrument until the turn
  moves.

## 6. Control a run

### 6.1 Live: cancel, pause, resume

| Method | Path                                      | Response |
| ------ | ----------------------------------------- | -------- |
| POST   | `/workflows/:name/runs/:runId/cancel`     | 202 `{ ok, runId, state }` |
| POST   | `/workflows/:name/runs/:runId/pause`      | 202 `{ ok, runId, state, quiesced }` |
| POST   | `/workflows/:name/runs/:runId/resume`     | 202 `{ ok, runId, state, resumed: "in-memory" }` |

404 when there is no such run; 409 when it is not live — already terminal
(`Run already terminal (success)`) or `stale`; 403 for a peer (Auth) on a
run no peer launched, here and in §6.2.

Control is **cooperative**. A request marks the run (`run.cancelling`,
`run.paused`, `run.resumed` in the log) and takes effect at the next
boundary: between steps, between loop or foreach iterations, between retry
attempts, between an agent's tool calls. A step already executing finishes
first — cancel a workflow inside a 20 second `wait` and it stays
`cancelling` for up to 20 seconds, then finalizes as `cancelled`. `state`
is what the run is doing now (`pausing` → `paused` once every branch has
reached a boundary, which `quiesced` reports). Cancel and pause apply to
the whole tree: every nested run launched under this one.

### 6.2 Durable: resume a dead, failed or cancelled run

`POST /workflows/:name/runs/:runId/resume` with no live run replays the
log's journal — every finished step's output, as `step.replayed` events,
at zero cost — and re-executes from the first incomplete step, appending
to the **same** log under the same id.

| Body                  | Effect |
| --------------------- | ------ |
| `{}`                  | resume a `stale`, `error` or `cancelled` run |
| `{ "from": "<path>" }` | re-run a **successful** run from that step (it, its dependents and later iterations are dropped from the journal); `from` on a live run is a 409 |
| `{ "force": true }`   | resume even though the workflow's content changed since the run started |

Response: 202 `{ ok, runId, resumed: "journal", replaying: <n>, version? }`
(`version` when a stored version matches the run's hash and is what runs).
400 for a successful run without `from`; 404 unknown; 409 when the log has
no `run.start`, when a resume is already in flight, or when the workflow
changed and no stored version matches its hash (pass `force`).

## 7. Run one step

`POST /steps/:type/run` `{ config?, input?, params?, cassette?: "record" |
"replay", cassetteName?, keep? }` runs a single step in memory and returns
`{ runId, status, output?, error?, events, recorded?, kept? }`
(`RunStepResult`): its events at `__run_step__/<type>` (slashes as dots:
`__run_step__/clip.shout`), `recorded` the number of service calls a
cassette captured. The run is kept (`kept:
"step:<type>"`, readable under that key) only with `keep: true` or when
the step has claims. 404 for an unknown type.

## 8. Steps, automations, health

| Method | Path                            | Description |
| ------ | ------------------------------- | ----------- |
| GET    | `/steps`                        | every step type: core, lib and workspace custom, with its source tier |
| GET    | `/steps/:type/schema`           | Zod-derived field descriptors for a step's config |
| GET    | `/steps/:type/source`           | source code |
| GET    | `/steps/:type/versions`         | a custom step's versions + active id |
| GET    | `/steps/:type/version/:version` | archived source for one version |
| PUT    | `/steps/:type/active` | `{ version }` — switch the active version; rebuilds the registry |
| POST   | `/steps`              | `{ name, code, description?, publisher? }` → `{ version, changed }`; content-hash idempotent |
| DELETE | `/steps/:name`        | delete a custom step |
| DELETE | `/steps?publisher=X`  | delete every step a publisher owns |

Automations launch a workflow on a schedule; the trigger grammar is in
`SPEC.md` §12.1 and `plans/automations.md`. A scheduled run is an ordinary
run whose `run.start` and summary carry `origin: "schedule"` and
`automation: { id }`. An automation's optional `callback: { url }` gets each
fire's `run.end`, as `POST …/run { callback }` does; the URL is the host's
credential, kept in a file of its own (never the deployment's secrets, which
steps read), so every read shows `callback: { origin }` only.

| Method | Path                                      | Description |
| ------ | ----------------------------------------- | ----------- |
| GET    | `/automations[?workflow=]`                | `[{ …automation, summary, nextRunAt, lastRun, running }]` |
| POST   | `/automations/preview`                    | `{ trigger }` → `{ summary, next }` (the next five fires); writes nothing |
| POST   | `/workflows/:name/automations`  | `{ name, trigger, input?, enabled?, callback?, id? }` (`id`: normally minted, `a-<8 hex>`; a taken one is 400). A trigger with no fire to come (a one-off in the past) is 400 here and on PATCH |
| PATCH  | `/workflows/:name/automations/:id` | any subset; `{ enabled: false }` pauses; `{ callback: null }` clears the callback |
| DELETE | `/workflows/:name/automations/:id` | remove |
| POST   | `/workflows/:name/automations/:id/fire` | run now → 202 `{ runId }`; 409 while its previous run is going |

`GET /health` → `{ ok, dataDir, stepCount, workspace: { backend, path? } }` —
`backend` is `fs`, `neo4j` or `ladybug` (where workflows and steps live;
`STRUT_WORKSPACE_BACKEND`), `path` the LadybugDB file on `ladybug`; without
the key, `{ ok: true }` and nothing else — the one route a keyless probe may
call.

## 9. Agent sessions

An `agent` step with `session` set continues a thread instead of starting
cold (`plans/agent-sessions.md`). Nothing is added to `POST …/run`: the id
is the caller's, it travels in `input`, and the workflow hands it to the
step.

```yaml
input:
  prompt:  { type: string }
  session: { type: string, required: false }
steps:
  - id: checkout
    type: git/checkout
    config: { repo: "{{ input.repo }}", workdir: "{{ input.session }}" }   # the files come along
  - id: work
    type: agent
    config:
      cwd: "{{ checkout.path }}"
      session: "{{ input.session }}"                                        # the context comes along
      system: You are a careful engineer.
      prompt: "{{ input.prompt }}"
```

```bash
curl -X POST http://localhost:3000/workflows/repo-agent/run -H 'Content-Type: application/json' \
  -d '{ "input": { "repo": "…", "prompt": "Why is login slow?", "session": "6f1c2a9e" } }'
# the follow-up: the same call, the same session
curl -X POST http://localhost:3000/workflows/repo-agent/run -H 'Content-Type: application/json' \
  -d '{ "input": { "repo": "…", "prompt": "Fix it.", "session": "6f1c2a9e" } }'
```

- **The id** is a flat, GLOBAL string: every run of every workflow naming
  it shares one thread. Up to 120 characters; `/`-separated segments of
  letters, digits and `. _ -`, a letter or digit at each end. A slash is
  part of the name (`abc/review` is unrelated to `abc`). Anyone who knows
  an id can continue it — use a uuid.
- **A turn** starts from the thread's system prompt (fixed by its first
  turn; the step's `system` is ignored after) and every earlier message,
  and is appended when the step succeeds. A failed or cancelled turn
  appends nothing.
- **The step's output** gains `session: { id, turn, offset }`; its
  `step.end` records the turn, not the thread.
- **`workdir`** on `git/checkout` keeps the working copy under a name: the
  next run naming it gets the same path as it was left (`reused: true`).
  Idle ones are removed after `STRUT_WORKDIR_TTL_DAYS` (default 7).

A run that cannot take its turn fails with one of these at the start of the
error message:

| Prefix | Meaning |
| ------ | ------- |
| `session_busy:` | another run holds the session; one turn at a time |
| `session_full:` | compaction is off (`STRUT_COMPACT_AT=1`) and the thread has no room left in the model's window — start a new session. With compaction on (the default), a thread past the mark is summarized at open instead and the turn goes ahead (plans/compaction.md) |
| `session_mismatch:` | the thread began on the other side of the LLM gateway, or still replays another provider's own server-run tool calls (Anthropic's web tools, called direct). The model and the provider may otherwise change between turns |
| `workdir_busy:` | another run holds the working copy |

| Method | Path | Response |
| ------ | ---- | -------- |
| GET    | `/sessions` | `{ sessions: [{ id, turns, messages, createdAt, updatedAt, createdBy?, jobs?, provider, model, context?: { used, limit }, busy? }] }`, newest first. `jobs` = the distinct jobs its turns were made under (`plans/job-index.md` §4), present when any turn carried one |
| GET    | `/sessions?id=<id>` | that summary + `turnLog: [{ turn, at, workflow, runId, path, actor?, principal?, job?, provider, model, routed, offset, count, usage, cost, context?, replayFrom }]`; 404. `replayFrom` is the thread index the NEXT turn replays from — 0 until a turn compacts the thread, then the index of its `[compaction]` message (plans/compaction.md); offsets stay absolute and the whole thread is still served |
| GET    | `/sessions/messages?id=<id>` | the thread, a bare array: the system message, then every message; 404 |
| DELETE | `/sessions?id=<id>` | `{ ok: true }`; 409 while a turn holds it |

400 for a malformed id; 501 when the host
injected its own `sessions` capability.

### Graph nodes

| Method | Path | Response |
| ------ | ---- | -------- |
| GET    | `/graph/nodes/:ref_id` | `{ ref_id, node_type, name, properties }` — the node as the graph holds it NOW (vectors and internal stamps stripped); 404 when it is gone; 501 on a deployment with no graph |
| GET    | `/graph/embeddings` | the embedding pass's status (`plans/semantic-search.md` §1; a debugging read): `{ enabled: true, sweep: { n, startedAt, finishedAt, phase, type, cursor }, current, last, skipped, newcomers: { since, embedded }, lastError, ticks }` — `current` / `last` are per type `{ seen, stale, embedded, removed, errors }` for the sweep in flight / the last complete one; `skipped` is `[{ type, reason: "no_schema" \| "no_index" \| "no_embed" \| "invalid_label" }]`. `{ enabled: false }` with `STRUT_GRAPH_EMBEDDINGS=off`; 501 on a deployment with no graph |

What the run view opens when a node in a step's **Nodes** list is clicked: a
run's events say which nodes a step touched (`nodes`, above), never their
content.

## 10. Peers — calling a workflow on another strut

A strut may call workflows on other struts it has on file as **peers**
(`plans/federation.md` §2.2, §3). A peer is `{ id, baseUrl, token, label? }`:
the caller's own name for it (hive registers a workspace's strut by its
slug), the peer's base URL, and a bearer the peer accepts. The record is
kept encrypted; the token has no read route.

| Method | Path | Response |
| ------ | ---- | -------- |
| GET    | `/peers` | `{ peers: [{ id, baseUrl, label? }] }` — never a token |
| PUT    | `/peers/:id` | `{ baseUrl, token, label? }` → `{ ok, id, baseUrl, label? }`; replaces; 400 for a bad id (`[A-Za-z0-9][A-Za-z0-9._-]*`, ≤ 64), a non-http(s) URL or a missing token |
| DELETE | `/peers/:id` | `{ ok, id }`; 404 |

`STRUT_PEERS` (a JSON array of the same records) puts peers on file at boot
for a strut nobody pushes to — a desktop strut behind NAT.

**The token** is whatever the peer accepts as a bearer. Give it the peer's
`STRUT_PEER_KEY` (Auth), not its deployment key: that is everything a call
needs — read, launch, cancel what it launched — and nothing more.

**The call** is a step, `strut/run-workflow { peer, workflow, input?,
params?, version?, job?, wait? }`, or the builder's `run_workflow` with
`peer` (and `list_workflows` / `get_workflow` with `peer`, `list_peers`).
It makes two requests of this API on the peer:

1. `POST {baseUrl}/workflows/:name[/:version]/run { input, params?, job? }`
   with `x-strut-actor: <the caller run's principal>` — the peer stamps that
   person as the run's actor and principal, bills them from its own
   delegation and binds `secrets` to them. Nothing of the caller's secrets
   crosses.
2. `GET {baseUrl}/workflows/:name/runs/:runId/stream` (§4), until `done`.
   A dropped connection is reattached with `?skip=<events read so far>`,
   so every event reaches the caller once. The wait is reader-initiated: the
   caller needs to reach the peer and nothing else (no callback, no route
   back).

The step's output is `{ peer, workflow, runId, status, output?, error?,
durationMs }` — the peer's `RunResult` under the handle; an `artifacts`
path in it is the peer's (`/jobs/<id>/files/…` or `/artifacts/<runId>/…`
THERE), and a graph `ref_id` in it is the peer's graph's. `wait: false`
returns `{ peer, workflow, runId, status: "running" }` at once. Cancelling
the caller's run POSTs `…/cancel` on the peer. `job` names a job ON THE
PEER; the caller's own job is never forwarded (no shared directory across
struts). A launch the peer refuses fails the step with the peer's message
(`job_busy:`, an unknown workflow); an id not on file is `peer_unknown:`; a
peer that stays unreachable is `peer_unreachable:`; a peer run that died
with its process and was not resumed there is `peer_run_stale:`.

Two things ride on the tail. The graph nodes the peer's run touched
(`nodes` on its `step.end` events, §5.3) are folded onto the step's own
`step.end` as `nodes`, each tagged `peer: <id>` — a ref another strut's
graph holds, never opened against this one. And the handle is journaled
right after the launch, as a `step.end` at `<step path>#launch` with
`output: { peer, workflow, runId, launchedAt }` and no `stepType`: a
durable resume of the caller's run (§6, boot-time auto-resume included)
re-executes the step, which REATTACHES to that run instead of launching a
second one.

## 11. MCP — strut for an external agent

Strut serves two tool sets over the Model Context Protocol (Streamable HTTP,
stateless; `src/ai/mcp.ts`), for an agent outside strut — Claude Code, Hermes,
any MCP client:

| Door | Tool set | For |
| ---- | -------- | --- |
| `POST /mcp` | **assistant** (`src/ai/assistant-tools.ts`): seven tools — talk to the workflow builder, read its chats, list workflows and runs, read a run, run a workflow | an agent with its own connectors that wants workflows built, run and shared, and should not learn strut's YAML; the default |
| `POST /mcp/builder` | **builder**: the SAME tools the builder chat's model gets — `list_steps` … `create_workflow` … `run_workflow` … `get_run`, with their descriptions, input schemas and capped results (`buildTools`, nothing reimplemented) | an agent that authors workflows itself |

```bash
claude mcp add --transport http strut http://localhost:3000/mcp --header "Authorization: Bearer $STRUT_API_KEY" --header "x-strut-actor: hermes"
claude mcp add --transport http strut-builder http://localhost:3000/mcp/builder --header "Authorization: Bearer $STRUT_API_KEY"
```

| Method | Path | Response |
| ------ | ---- | -------- |
| POST   | `/mcp`, `/mcp/builder` | JSON-RPC — `initialize`, `tools/list`, `tools/call` (+ `prompts/list`, `prompts/get` on the builder door); the response is an SSE stream carrying the result (and a `notifications/progress` per preliminary result of a tool that yields them — `run_workflow` — when the request carried a `progressToken`); 406 without `Accept: application/json, text/event-stream` |
| GET, DELETE | `/mcp`, `/mcp/builder` | 405 — no standalone stream, no session: every POST stands alone |

Auth is the gate's (Auth): `Authorization: Bearer <STRUT_API_KEY>`; a
peer's key is a `403`; dev mode is open. **The caller's identity is a
header**, `x-strut-actor`, set where the server is added (MCP has none of
its own; `clientInfo` is a client's name, the same for every instance):
honored as on every request, it stamps the chats the caller starts
(`createdBy`), the runs it launches and the workflows it publishes, and it is
what `list_workflow_builder_chats` filters by. Without it nothing is scoped.
`createStrut({ enableMcp: false })` mounts neither door; the default follows
`enableChat`, and with the chat off `/mcp` serves the builder set (there is
no builder to talk to).

**Links.** Every link in a result is ABSOLUTE: `ui` opens the workflow, run
or chat in the web UI (`<base>/?wf=<name>`, `…&run=<runId>`,
`<base>/?chat=<id>`); an artifact link (a run's declared deliverables, §5,
`CALLBACKS.md` §4, resolved like the run callback's) carries the file's read
token (`?t=`, Auth), so it opens the file by itself and the key never rides
in one — a caller shares it with its own connectors as it is (anyone with the
link reads that one run's files, nothing else; it does not expire). The base
is `STRUT_PUBLIC_URL` (`createStrut({ publicUrl })`), else the request's own
origin (`x-forwarded-proto` / `x-forwarded-host` honored). A chat started
over the assistant door is stamped with that base (`ChatMeta.publicUrl`), so
the builder's own tool results in it — and the reply text that copies them —
carry absolute links too.

### 11.1 The assistant set

| Tool | Arguments | Result |
| ---- | --------- | ------ |
| `ask_workflow_builder` | `message`, `chat?` (continue), `title?` (a new chat's), `wait?` (ms, default 45000, max 55000) | `{ chat, turn, status, at?, text?, did?, toolCalls?, asked?, turns?, cursor, question?, settled, hint?, ui }` — the builder's reply for the turn it waited on: `text` (its final text), `did` (below). `status`: `done`; `working` (the turn outlived `wait` — `read_workflow_builder_chat` with `wait`); `asked` (a question for the caller in `question`: a form's `requestedSchema`, or for a secret the absolute `url` the caller's USER opens — the value never passes through the caller; the next message on the chat answers); `parked` (the auto-turn cap); `error` (+ `error`). `settled: false` = a detached run will wake the chat again. A chat with a turn in progress is refused: `{ error, status: "working", hint }` |
| `read_workflow_builder_chat` | `chat`, `since?` (a message index: the previous read's `cursor`, or a turn's `at`), `limit?` (turns, newest kept, default 20), `detail?` (`effects` \| `tools` \| `full`), `wait?` (ms, default 0) | `{ chat, turn, status, turns: [...], cursor, omitted?, hint?, question?, settled, ui }`. A **turn** is `{ at, you? \| notices?, text?, did?, toolCalls?, tools?, asked?, compacted? }`: what the caller said (or the server notice that woke the builder — a run finishing, a verdict), the builder's final text, and `did`; `tools` only with `detail`. Cut to ~20k chars (text first, then the oldest turns), `hint` saying so |
| `list_workflow_builder_chats` | `q?` (title words), `limit?`, `mine?` (default true) | `{ chats: [{ chat, title?, status, updatedAt, turns, createdBy?, asked?, ui }], total, hint? }` — newest first; `mine` keeps the connection's actor's chats (nothing is filtered without an actor) |
| `list_workflows` | `query?`, `limit?` | §2's slim list + per workflow `schedules?: [{ id, summary, enabled, next }]`, `lastRun?: { runId, at, status }`, `ui` |
| `list_runs` | `workflow`, `limit?`, `status?`, `since?` (ISO) | `{ workflow, runs: [{ runId, status, startedAt, durationMs?, cost?, modelCalls?, origin? \| actor?, error?, job?, artifacts?, ui }], total }` — `artifacts` on a successful run, as absolute links |
| `get_run` | `workflow`, `runId`, `fields?`, `files?`, `wait?` | `{ workflow, runId, status, startedAt, finishedAt, durationMs, cost?, error?, artifacts?, input, output, omitted?, files?, hint?, ui }`. Every top-level `output` field over 2 000 chars is HELD BACK in place as `{ $omitted: { chars, kind, preview } }` and named in `omitted`; `fields` includes the named ones whole (cut at 50 000 with a note; a non-object output is the one field `output`). `files: true` lists every file under the run's artifact directory (or its job's) with a tokened link. A run still going is `{ status: "running", hint }` — `wait` holds for it. No step tree: a failing run is debugged by asking the builder |
| `run_workflow` | `name`, `input?`, `params?`, `version?` | the builder's own `run_workflow` — its launch, detach and links — with `output` trimmed like `get_run`'s (+ `omitted`, `hint`). A run still going after the wait window (`STRUT_CHAT_RUN_WAIT_MS`) is `{ status: "running", detached: true, runId }`: poll `get_run` with `wait` |

`did` — what a turn changed, folded from the builder's tool calls by tool
name (`src/chat-view.ts`; never inferred from prose): `workflows: [{ name,
version?, action: created | edited | activated, ui? }]`, `steps: [...]`,
`runs: [{ workflow, runId, status, error?, artifacts?, ui? }]` (a detached run
and its later result are one entry), `automations: [{ workflow, id?,
summary?, next?, action: set | deleted }]`. The `instructions` the door hands
a client at `initialize` are ten lines: what strut is, ask for building and
debugging, read for status and links, how `wait` and polling work, that links
are shareable, never collect a secret's value. Nothing notifies an MCP
client: a caller polls with `wait`, or `list_runs` with `since`.

### 11.2 The builder set

What the door adds for a caller that is not the UI. `instructions` are the
builder's procedure, the web UI's URL and where a missing credential is added
— `<base>/?secrets=1` opens the UI's Secrets dialog, since `ask_user` /
`request_secret` are not offered on this door; the full system prompt — the
YAML rules, every tool's use, the deployment's own section (`createStrut({
chatSystem })`; on a graph, the `Workflow Builder` Concept's page), the step
catalog — is the `workflow-builder` prompt (`prompts/get`), built at each
read, so an edit to that page shows at once (a chat freezes its prompt on its
first turn). The results of `create_workflow` / `edit_workflow` /
`run_workflow` / `get_run` carry `ui` and `artifacts` as above.

Long runs: a `run_workflow` still going after the wait window
(`STRUT_CHAT_RUN_WAIT_MS`, a minute) returns `{ status: "running",
detached: true, runId }` and the run goes on; nothing can notify an MCP
client, so `get_run` takes `wait` (ms, at most 55000) — it holds until the
run settles or the wait is up, then reads the run as it stands, and the
caller calls again until `status` is terminal.

## 12. Proposals — a tool call a person approves before it runs

`plans/proposals.md`. An `agent` step's `approve:` list gates registry
steps: a call to one is RECORDED (`<dataDir>/proposals/<id>.json`) rather
than run, and the person's accept runs it in code. The record (`Proposal`,
`src/proposals.ts`): `{ id, step, input, rationale?, title, status: pending
| accepted | rejected | applied | failed, createdAt, by: { workflow, runId,
path, job?, session?, actor?, principal? }, decision?: { action, by?, at,
input?, reason? }, result?: { output?, error?, cost?, nodes?, at },
reportedAt? }`. `input` is what the step's schema parsed at proposal time;
on accept it runs with `decision.input` merged over it. `reportedAt` is
when the proposing session was told (its next turn's `[proposal-result]`
lines).

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/proposals?job=&session=&runId=&status=` | `{ proposals: Proposal[] }`, newest first; `status` one of the five |
| GET    | `/proposals/:id` | one record; 404 |
| GET    | `/workflows/:name/runs/:runId/proposals` | `{ workflow, runId, proposals: [{ id, step, title, status, url, rationale?, createdAt, decidedAt? }] }` — what the run proposed, the `run.end` field's twin (`CALLBACKS.md` §6) |
| POST   | `/proposals/:id/decide` | `{ action: "accept" \| "reject", input?: object, reason?: string }` → the record after the decision. `accept` merges `input` (one level) onto the proposal's, re-parses with the step's schema (400, still pending, when it does not fit), records the decision, runs the step under a minimal context (the decider — the request's actor — as `ctx.actor`, the proposing run's principal binding its secrets, its job, the registry), and records `result`. `reject` records `reason`, runs nothing. 409 with the record once decided (`failed` may be accepted again); 400 for a step no longer in the registry; 404 |

The steps `proposal/list` ({ job?, session?, status?, limit? } → the briefs)
and `proposal/get` ({ id } → the record) are the same reads for an agent.
