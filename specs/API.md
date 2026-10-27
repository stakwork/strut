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

**A browser signs in instead.** The web UI trades the key for a short-lived
session cookie at `POST /auth/session` (§13), so the key is never kept in a
browser; a client that is a program keeps using the header.

**A peer's key.** `STRUT_PEER_KEY` is the key another strut holds for this
one (§10). It is presented like `STRUT_API_KEY` (Bearer or `?key=`) but is
**peer-scoped**: every `GET`, a launch (`POST /workflows/:name[/:version]/run`),
and cancel / pause / resume (§6) of a run a peer launched — that run's
`run.start` carries `origin: "peer"`. Anything else is a `403`.
`x-strut-actor` is honored beside it: a peer's launch names the person it
is for. A host that authenticates requests itself decides the scope per
request instead (`createStrut({ resolveScope })`). A peer launches only a
workflow whose YAML says `peer: true`, as published, in a namespace of its
own (§3, "A peer's launch").

**A person's token.** The peer key stands for a strut: its actor is the
`x-strut-actor` the calling strut sends, whoever its run is for. A
**person token** is the peer key attenuated to one actor
(`plans/chained-orchestrators.md` §2, §4): `POST /peers/tokens` mints it
(§10), it is presented as `Authorization: Bearer` only (never `?key=`),
and its request is scoped `peer:person` — everything a peer may do, its
actor the token's own whatever `x-strut-actor` says, and three things
more: a launch of a workflow whose YAML says `peer: person`, the actor's
own agent sessions (§3), the actor's room, and `POST /mcp`, where it gets
an app's `step_run` alone, run as the actor under the app's grants (§14.3,
"A peer's app"). A host maps its
own credential to `peer:person` through `resolveScope` (mcp: a `lab:peer`
JWT with a `sub`).

## 1. Publish

| Method | Path                | Body                                                                 | Response |
| ------ | ------------------- | -------------------------------------------------------------------- | -------- |
| POST   | `/workflows`        | `{ name, steps \| yaml, input?, params?, claims?, peer?, description?, category?, source? }` | 201 `{ ok, workflow, version: "v1", active: "v1", renamed, requested, claims? }` |
| POST   | `/workflows/:name`  | `{ version, steps \| yaml, input?, params?, claims?, peer?, description?, source? }` | 201 `{ ok, workflow, version, active, claims? }` |

- `steps` is an array of step objects (below) and the server writes the YAML;
  `yaml` is the whole file as text, `input:` / `params:` / `claims:` blocks
  included. One or the other.
- A create whose `name` is taken gets a suffixed name: `renamed: true`,
  `requested` is what you sent, `workflow` is what was stored.
- A `name` may carry `/` — a package's prefix, `acme/linear/sync`: then no
  segment may be empty, `.` or `..`, none may be `runs`, and no `\` or `#`. In a
  URL the name is ONE segment, encoded: `/workflows/acme%2Flinear%2Fsync/run`.
  Unencoded, the slash splits the path and the request matches nothing (404).
  Its runs' event paths begin with the whole name (`acme/linear/sync/fetch`),
  so a reader takes the name from the run (`run.start`'s `path`, the
  summary's `workflow`), never from a path's first `/`. A one-segment name
  is unchanged.
- `version` is your label (`v2`). A new version becomes active. Reusing a
  label **overwrites** that version's content; the same content under a new
  label is a second version with the same `hash`.
- Each version records where it came from: `source` is `"ui"` when the web
  UI publishes and `"api"` for anything else over HTTP (no other value is
  accepted here), with the request's `actor`. The other doors stamp their
  own: `seed` (a host's boot-time seeder), `builder` (the chat builder),
  `agent` (`meta/publish-workflow`), `promote` (a promoted param), `install`
  (a package install, plans/marketplace.md §3). Versions published before
  this was recorded have none.
- `peer: true` at the top of the YAML (or `peer: true` beside `steps`)
  opens the workflow to other struts: it is what a peer's launch needs
  (§3). `peer: person` opens it only to a person's credential (Auth). Content,
  so it is in the version's `hash`; anything but `true`, `person` or absent
  is a 400.
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
| GET    | `/workflows/:name`              | `{ active, versions: { "v1": { createdAt, description?, hash?, source?, actor?, upstream? }, … }, category?, publisher?, owner?, maxRunCostUsd?, automations? }` (`WorkflowMetadata`; `upstream` = `{ package, version, digest, source: { ref }, secrets }`, the package a version was installed from or forked off — every publish carries the active version's forward) |
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
| POST   | `/workflows/:name/run`          | `{ input?, params?, paramOverrides?, settings?, runId?, callback?, job?, title?, jobCallback?, mcp?, attachments? }` | 202 `{ runId, callback?: true, jobCallback?: true, mcp?: true, attachments?: true }` |
| POST   | `/workflows/:name/:version/run` | same | same |

| Field            | Meaning |
| ---------------- | ------- |
| `input`          | the run payload, validated against the workflow's `input:` block (unknown keys dropped); `{}` when omitted |
| `params`         | shallow-merged over the workflow's `params:` defaults for this run only |
| `paramOverrides` | `{ "<workflow name>": { … } }` — the same, per workflow, reaching subflows |
| `settings`       | `{ "<setting>": value }` — this run's level of the registered settings (`privacy`: `PRIVACY_SPEC.md` §10): over the workflow's `settings:` and the deployment's, under a step's `options.settings`. Not validated at launch (a bad value fails the step that reads it), not recorded on `run.start` (a durable resume runs without it), not handed to runs this run starts |
| `runId`          | your own id (unique within the workflow); default a millisecond timestamp, e.g. `"1790436489808"` |
| `callback`       | `{ url }` (http/https) — the result is POSTed there when the run settles; see `CALLBACKS.md`. Any other scheme is a 400 and nothing launches. Or `{ room: true }`: delivered to the launching actor's ROOM, a socket the client holds open (`GET /rooms`, §10; `CALLBACKS.md` §8) — 400 for a request that names no actor or carries the shared peer key |
| `job`            | the job to launch under (`plans/jobs.md`): an id you mint, the format of a session id (§9); a bad one is a 400 and nothing launches. Recorded on the run, handed to steps as `ctx.job` and to templates as `{{ $job }}`; `job/dir` gives the run the job's directory, and the callback resolves the output's `artifacts[]` into it (`CALLBACKS.md` §4). The run is also recorded on the job — `GET /jobs/:id` (§5) lists it |
| `title`          | the job's name (`plans/job-index.md`), recorded on the JOB, never on the run: the host's label for it, kept until a later launch carries another. 400 without `job` |
| `jobCallback`    | `{ url }` (http/https) — the JOB's live updates (`job.update`: a hold taken or let go, a check's evidence, a verify ended, a step's screenshot or walkthrough frame) are POSTed there as they happen, from every run under the job; see `CALLBACKS.md` §5. Kept on the job, never returned; the latest launch that carries one wins, `null` clears it, absent keeps it. With or without `job`, the jobs THIS run starts (`job/start`, `job/continue`) inherit it — an orchestrator turn's host hears every job it starts at one URL, each event naming its `job` and `runId`. 400 for another scheme. `{ room: true }` as for `callback` |
| `mcp`            | `[{ name, url, token?, headers?, toolFilter? }]` (`McpServer`, `src/core.ts`; at most 10) — YOUR MCP servers, the way back into you for this run's agents: every `agent` step gets their tools as `<name>_<tool>` unless it says `mcp: false`, and so do the jobs a turn starts (`job/start`, `job/continue`) and the runs it launches (`meta/run-workflow`) — never a peer. `url` is a Streamable HTTP endpoint (http/https); `token` is sent as `Authorization: Bearer <token>`, `headers` for any other scheme; `toolFilter` keeps those tools only (names or globs). `name`: letters, digits, `_`, `-`, unique. A bad entry is a 400 and nothing launches. The log records `mcp: [{ name, origin }]` only; the entries are kept beside it for a resume and returned by nothing. A server that cannot be reached when an agent starts is skipped, the agent going on without its tools |
| `attachments`    | `[{ name, mediaType?, data }]` (`src/ai/attachments.ts`) — files for the run's agents, the person's message's: `data` is base64 or a data URL, `mediaType` defaults from the data URL, else the extension. At most 10, 10 MB each, 5 MB an image, 15 MB together; a bad one is a 400 and nothing launches. Saved under the run's artifacts as `attachments/<name>` (`GET /artifacts/:runId` lists them) and put on every `agent` step's prompt after its text — an image or a PDF as a file the model sees, text and Word inline, anything else announced by its path — unless the step says `attachments: false`; a sub-agent never gets them. `run.start` records `attachments: [{ name, mediaType, size, path }]`, never the bytes (the agent's transcript keeps what the model saw). An orchestrator turn hands a job the ones it needs by name (`job/start` / `job/continue` `attachments`) — this message's, or one an earlier turn of its session carried (the turn log records them, `/sessions?id=`); not to a builder job on a peer |

**A peer's launch** (the peer key, Auth) is narrower. The workflow — the
version launched, for `/:version/run` — must say `peer: true` at the top
of its YAML, else `403` (`workflow "x" is not open to peers`). It runs as
published: `params`, `paramOverrides`, `runId` or `settings` in the body is a `403`
(`a peer launches a workflow as published — drop params`). And it runs in
a namespace of its own: its `job` is kept as `peer/<job>` (what
`run.start.job`, `ctx.job` and `GET /jobs/:id` say), and every agent
session the run opens is `peer/<id>` — a name a peer chooses never opens
a local job or a local thread. A peer's durable resume (§6) of a run it
launched is refused the same way when the version it would run does not
say `peer: true`.

A workflow that says `peer: person` takes only a person's credential
(`peer:person`, Auth); the peer key is a `403` (`workflow "x" is open to a
person's credential only`). `peer: true` takes both. A run a person's
credential launched records `peerPerson: true` beside `origin: "peer"` on
`run.start`, and opens the actor's OWN sessions as they are — `<actor>` and
`<actor>/…`, the thread the actor's host opens for them here too — while
every other id it names is still `peer/<id>`; its `job` is still
`peer/<job>`. Only the same person's credential resumes such a run.

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
| GET    | `/workflows/:name/runs/:runId/transcripts/<step path>` | one agent session as a bare array of AI SDK model messages; 404 if that step recorded none. For a step that continued a `session` (§9) this is its system prompt + THAT TURN; `?full=1` is the thread up to and including it (404 once the session is deleted). An app reads the same through `run/transcript` (§14.2) |
| GET    | `/workflows/:name/runs/:runId/artifacts`               | `{ workflow, runId, job?, artifacts: [{ id, kind, title, label?, summary?, url? \| content? \| error?, peer?, job?, path? }] }` — the deliverables the run's output declared, resolved as the run callback resolves them (`CALLBACKS.md` §4) — one tagged `peer` (another strut's, `strut/run-workflow`) as it came, its `path` in that peer's `job`, resolved by the reader against the peer; 404 until the run has a summary |
| GET    | `/workflows/:name/evidence[?runId=&limit=&before=]`   | what the checks said about the workflow's runs (§5.4) |
| GET    | `/artifacts/:runId`                                    | `{ runId, files: ["report.md", …], token? }` — what the run's steps wrote, and the run's **file token** (present when there is a secret to sign it: `STRUT_API_KEY`, else `STRUT_SECRET_KEY`): a `GET` of this listing or of any file under it with `?t=<token>` needs no key — the link form, worth this run's files and nothing else (an HMAC of the run id under the secret: no store, rotates with it). A `?t=` strut cannot vouch for is a 401 even on an open strut, so a host's gate may hand token-bearing reads through; 501 when the deployment has no artifact store |
| GET    | `/artifacts/:runId/<path>`                             | the file, content-typed by extension (unknown → `application/octet-stream`), with `X-Content-Type-Options: nosniff` and `Access-Control-Allow-Origin: *`; 404 for a path that is not a file (a directory: the listing is what names what is in it). A step wrote it, so everything but `video/*` and `audio/*` also carries `Content-Security-Policy: sandbox`: opened in a browser it has no origin, and only `text/html` read by its file token runs script (`sandbox allow-scripts`) — a page an agent built runs, and the one thing in its URL is that token; read with the key, or through a host's gate, it runs none. A host that frames or proxies artifacts must keep these headers |
| GET    | `/jobs?q=&workflow=&limit=`                            | `{ jobs: [{ job, title?, createdBy?, actors?, createdAt?, usedAt, busy?, workflow?, runs, holds }], actor? }` — `workflow` is the one the job's newest TURN ran, `job` or `builder` (`JOB_WORKFLOWS`, `plans/builder-job.md` §2): what the job is, what `job/continue` launches next; — every job, newest-used first (`plans/job-index.md` §2): `runs` and `holds` are counts, `busy` the run working in its directory now, `actors` everyone who launched a run under it (first seen first; `createdBy` is the head). `q` is the workflows' matcher (§2): every word must hit the title (the id, without one) or the title or summary of a current deliverable. `workflow` keeps the jobs with a recorded run of that workflow (a job from before its runs were recorded on it never matches). `mine=1` keeps the jobs whose `actors` include the request's actor — `actor` in the response is who the server took the request to be from (`resolveActor`); absent, `mine` lists nothing |
| GET    | `/jobs/:id`                                            | the job read back: `{ job, title?, createdBy?, createdAt?, usedAt, busy?, workflow?, holds: [{ id, kind, since, note?, url? }], urls, repos, files, runs: [{ workflow, runId, at, parentRunId?, status, durationMs?, error?, sealed? }], sessions: [{ id, turns, …, busy? }], artifacts: [{ id, kind, title, summary?, url?, content?, runId, path? }], text?, claims? }` — `workflow` is what the job IS: the one its newest turn ran, `job` or `builder` (a run under the job of any other workflow is not a turn), the one `job/continue` launches next; `claims` is the job's ledger (§5.5), present only where the claims layer is on; `runs` newest first, `status` from the run's summary (`running` without one); a run with a `parentRunId` is one a turn launched, not a turn; a sealed workflow's run shows `sealed: true` and nothing past its status. `holds` are what the job keeps alive beyond a run (`plans/jobs.md` §6), each with a `url` when what it holds has an address; `urls` is the first hold of each kind that has one (`{ pod: "https://…" }`). `sessions` are the threads made under the job (a turn line's `job`, §9) or named after it. `artifacts` are the job's CURRENT deliverables — its successful top-level runs' `artifacts[]`, newest first, the first of each `id` winning, resolved as `…/runs/:runId/artifacts` resolves them, each with the run that last reported it and, for a file, its `path` in the directory (what `job/read` takes); `text` is the newest such run's `output.text`. `threads` (`plans/jobs-sidebar.md`, `src/job-threads.ts`) is the job's execution as a tree: every agent execution in its runs' logs — a `step.end` carrying `messages`, or an attempt of the core `agent` step — grouped by session into `[{ id, session, label, startedAt, updatedAt, turns, totals: { turns, usage, cost, toolCalls, context? } }]`, each turn `{ runId, workflow, path, stepType, label, at, durationMs?, status, turn?, session?, usage?, cost?, context?, toolCalls, transcript?, artifacts?, nodeCount, nodes?, spawned, peer? }` — `transcript` the §5 link (`?full=1` for a session turn), `artifacts` the run's declared deliverables on its last top-level turn, `spawned` the threads the turn caused (a sub-agent under its path, a child run it launched, a `strut/run-workflow` peer run with `peer: { id, workflow, runId, status }`), a run with no agent one turn of `stepType: "run"`. Chronological at every level. `?threads=0` leaves it out, `?nodes=1` adds each turn's touched graph nodes, `?limit=N` bounds the runs the fold reads (newest first; `omittedRuns` counts the rest). 404 for an unknown job |
| GET    | `/jobs/:id/claims`                                     | `{ enabled, job, claims: LedgerClaim[] }` — the job's ledger alone (§5.5): what the work must deliver and whether it does, as of its newest turn. `{ enabled: false, claims: [] }` without the claims layer; 404 for a job not on file |
| POST   | `/jobs/:id/verify`                                     | `{ claims?: [<claim id>], detach?: boolean }` (gated) → `{ job, key, runId, subjects, checks: [{ subject, path, claimId, checkId, lastVerify }], evidence, slots, costUsd, claims: LedgerClaim[] }` — verify the job NOW against its newest turn (`runId`): every check on every claim about the job fires, `manual` ones included, and evidence on an already verified turn is appended, not skipped; the ledger comes back with each check's `lastVerify`. `claims` narrows to ids; no body is every claim. `detach: true` answers 202 `{ job, started: true }` at once instead — each check's evidence and the pass's end reach the job's `jobCallback` (`CALLBACKS.md` §5), the ledger is `GET /jobs/:id/claims` after; a detached verify while one runs joins it. 404 for a job not on file, 409 without the claims layer |
| GET    | `/jobs/:id/files`                                      | `{ job, files: ["plan.md", …], token? }` — every file in a job's directory (`job/dir`, `plans/jobs.md`), recursive, skipping the repositories checked out into it, and the job's file token, as `/artifacts/:runId` mints the run's; 404 for a job with no directory, 400 for a malformed id (percent-encode a `/`). |
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
| `origin`       | who launched it when it was not a person or an API call: `schedule`, `peer`, `app` (as on `run.start`) |
| `app`          | `{ name, version }` — the app it was launched for, with `origin: "app"` (§14.1) |

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
| `path`       | `<workflow>` for run events — the whole name, slashes included; `<workflow>/<stepId>` for a step, nesting through subflows (`wf/sub/child`), `#n` for a loop or foreach iteration (`wf/each#2/review`), `NNN-<tool>` for a tool an agent called (`wf/review/003-agent`) |
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
| `run.start`       | first line; carries `input`, `workflowHash`, `stepHashes` (custom step versions), `params` / `paramOverrides`, `actor` / `principal`, `origin` (`schedule` / `verify` / `peer`), `peerPerson` (a peer run a person's credential launched, §3), `automation`, `callback: { origin }`, `mcp: [{ name, origin }]`, `attachments: [{ name, mediaType, size, path }]`, `parentRunId` when nested |
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

A step that never returns would hold a cooperative cancel forever. For that,
`POST …/cancel` with body `{ "force": true }` also stops waiting on every step
in flight in the tree: the run finalizes as `cancelled` at once. The stuck
step's code is abandoned, not killed — whatever it holds (a subprocess, a
socket) stays until it dies or the process restarts. An agent step's session
is let go when the run ends, so the thread's next turn can start; the
abandoned turn, should it ever finish, commits nothing. The same `force` is on
the `run/cancel` step, the chat builder's `cancel_run` tool, `useCancel`'s
`cancel(workflow, runId, force?)`, and the UI's **Force cancel** button, which
replaces Cancel while a run sits in `cancelling`.

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
| GET    | `/steps`                        | every step type: core, lib and workspace custom, with its source tier — `{ core: [{ type, source, description?, secrets?, effect? }], workspace }`. `secrets` names the secrets the step can take its credential from when its config passes none (it works when any one is set) and `effect` is `read` or `write` (does running it change anything outside the run); each is absent when the step does not declare it, or declares it malformed — treat a missing `effect` as `write` |
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
| GET    | `/sessions?id=<id>` | that summary + `turnLog: [{ turn, at, workflow, runId, path, actor?, principal?, job?, attachments?, provider, model, routed, offset, count, usage, cost, context?, replayFrom }]`; 404. `attachments` = the files the turn's prompt carried, `[{ name, mediaType, size, path }]` under `runId`'s artifacts. `replayFrom` is the thread index the NEXT turn replays from — 0 until a turn compacts the thread, then the index of its `[compaction]` message (plans/compaction.md); offsets stay absolute and the whole thread is still served |
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
| GET    | `/peers` | `{ peers: [{ id, baseUrl, label?, description?, repos? }] }` — never a token |
| PUT    | `/peers/:id` | `{ baseUrl, token, label?, description?, repos? }` → `{ ok, id, baseUrl, label?, description?, repos? }` (`repos`: the workspace's repository URLs — what `strut/list-peers` shows an agent choosing a peer); replaces; 400 for a bad id (`[A-Za-z0-9][A-Za-z0-9._-]*`, ≤ 64), a non-http(s) URL or a missing token |
| DELETE | `/peers/:id` | `{ ok, id }`; 404 |
| GET    | `/peers/:id/jobs/:job/files[/<path>]`, `/peers/:id/artifacts/:runId[/<path>]`, `/peers/:id/apps`, `/peers/:id/apps/:name/usage`, `/peers/:id/apps/:name/:version/files[/<path>]` | READ-THROUGH: that peer's job files, run artifacts and apps (its app list, an app's usage — counted where its calls run, §14.6 — an app version's listing and files, the document among them — §14.3, "A peer's app"), fetched with THIS strut's token for it — the listing (JSON) or the file, the peer's status passed on; a host's `If-None-Match` goes along and the peer's `ETag` comes back, so a 304 passes through. Prefix `peers/<id>/` for one more hop: `/peers/acme/peers/billing/jobs/<job>/files/report.md` reads `billing`'s file through `acme`, each hop with its own token — how an entry tagged `{ peer, via, job }` opens (`CALLBACKS.md` §4). Those paths only (anything else 404); a peer not on file 404 (`peer_unknown:`), unreachable 502. Served under this strut's artifact headers (sandboxed, no scripts); this strut's `?key=` is never forwarded. A read like any other: a peer may call it |
| POST   | `/peers/:id/mcp` | An app page's tools/call, relayed to that peer's `/mcp` with THIS strut's token for it (a person token: the peer answers with `step_run` alone, as that person — §14.3, "A peer's app"). The JSON-RPC body as it came, `accept`, `mcp-protocol-version` and `mcp-session-id`; the answer streams back with its own content type (JSON or an event stream). A peer of this strut is 403 (a POST); a peer not on file 404 |
| POST   | `/peers/tokens` | `{ actor, days? }` → `{ token, actor, exp }` — a PERSON token for this strut (Auth): what a person's own strut puts in its peer record for this one. `days` defaults to 60 (at most 365); nothing is stored, and rotating the signing secret (`STRUT_API_KEY`, else `STRUT_SECRET_KEY`) revokes every one. The deployment's call only (a peer is 403); 400 for a missing actor, bad `days`, or no secret to sign with |
| GET    | `/self` | `{ self: { id?, label?, description?, repos? } \| null }` — this strut's OWN workspace (never in `/peers`) |
| PUT    | `/self` | `{ id?, label?, description?, repos? }` → `{ ok, id?, label?, description?, repos? }`; 400 on a bad shape. `STRUT_SELF` / `createStrut({ self })` seed it |
| DELETE | `/self` | `{ ok }`; 404 when none |

`STRUT_PEERS` (a JSON array of the same records) puts peers on file at boot
for a strut nobody pushes to — a desktop strut behind NAT.

**Rooms** — how a strut nobody can call hears its runs here
(`plans/chained-orchestrators.md` §3; `CALLBACKS.md` §8). `GET /rooms` is a
WebSocket: the upgrade passes the gate like any request, and the socket
joins the request's actor's room — a `full` request with an actor (the key
with `x-strut-actor`, a session, a host's credential) or a person's
credential (`peer:person`); the shared peer key and a request with no actor
are `403`, plain HTTP `426`. A launch's `callback` / `jobCallback` `{ room:
true }` (§3) delivers that run's `run.end` and its jobs' `job.update`s and
`run.end`s to every socket in the room, one JSON text message each; with
none open the newest 1 000 wait in memory for the next join. A host that owns
the Node server routes its upgrades to `strut.upgrade(req, socket, head, {
basePath })`. `strut/run-workflow { room: true }` asks a peer for this on its
launch.

**The token** is whatever the peer accepts as a bearer. Give it the peer's
`STRUT_PEER_KEY` (Auth), not its deployment key: that is everything a call
needs — read, launch, cancel what it launched — and nothing more. A
person's own strut (a laptop) holds a person token instead (`POST
/peers/tokens` on the peer, or a host's pairing): the same calls as that
person, plus what only a person's credential opens (a `peer: person`
workflow, their own sessions there).

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
durationMs }` — the peer's `RunResult` under the handle; each entry of
an `artifacts` list in it comes back tagged `{ peer, job }` — `job` the
job the peer recorded the run under — so its `path` stays the peer's
(`/jobs/<job>/files/…` THERE; `CALLBACKS.md` §4), and a graph `ref_id` in
it is the peer's graph's. An entry the peer itself got from a third strut
(already tagged) comes back as the NEXT HOP: `{ peer: <this peer>, via:
<the third, as the peer names it>, job: <the third's> }`, opened through
the peer's read-through (above). `wait: false`
returns `{ peer, workflow, runId, status: "running" }` at once. Cancelling
the caller's run POSTs `…/cancel` on the peer. `job` names a job ON THE
PEER (kept there as `peer/<job>`, §3); the caller's own job is never
forwarded (no shared directory across struts). On its peer key a peer
runs only a `peer: true` workflow, without `params` (§3). A launch the
peer refuses fails the step with the peer's message (not open to peers,
`job_busy:`, an unknown workflow); an id not on file is `peer_unknown:`; a
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
| `POST /mcp/builder` | **builder**: the SAME tools the builder chat's model gets — `list_steps` … `create_workflow` … `run_workflow` … `get_run`, the `app_*` steps and the text editor, with their descriptions, input schemas and capped results (`buildTools`, nothing reimplemented) | an agent that authors workflows itself |

Both doors also list **`step_run`**, the APP door (§14.1): an app-only tool
(`_meta.ui.visibility: ["app"]` — an MCP Apps host hides it from the model
and lets a page call it), served beside each set so a host relays a frame's
`tools/call` to whichever door it connects. A PERSON token (`peer:person`,
Auth) gets `POST /mcp` with `step_run` and nothing else — how a person's own
strut hosts an app that lives here (§14.3, "A peer's app"); `/mcp/builder`
and every plain peer stay 403.

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

### 11.3 Registered MCP servers — strut as a client (`src/mcp-registry.ts`)

The other direction: MCP servers strut CALLS, registered once rather than
handed over per launch (`POST …/run { mcp }`, §3, is unchanged). A
registration holds secret NAMES, never values: `tokenSecret` (sent as
`Authorization: Bearer <value>`) and `headerSecrets` (header → secret name)
resolve through the run's secrets when an agent connects, so a person's
actor secret (`/actors/:actor/secrets`) wins over the deployment's. Kept in
`<dataDir>/mcp-servers.json`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/mcp-servers` | `{ servers: McpRegistration[] }`, by name; a peer gets `{ name, origin }` of each |
| GET    | `/mcp-servers/:name` | one registration; 404 |
| PUT    | `/mcp-servers/:name` | `{ url, tokenSecret?, headerSecrets?, toolFilter?, ungated? }` → the registration. `name`: 1-32 letters, digits, `_`, `-`; `url` http(s) with no credentials, query or fragment, and not on loopback or link-local unless `STRUT_MCP_LOCAL=1`; secret names as `PUT /secrets/:name` takes them, never `STRUT_*`; `toolFilter` / `ungated`: tool names or globs. Any other field (a `token`) is a 400 |
| DELETE | `/mcp-servers/:name` | `{ ok, name }`; 404 |
| POST   | `/mcp-servers/:name/test` | connect as the request's actor would and list the tools: `{ ok: true, tools: [{ name, description?, readOnly, gated }] }`, or `{ ok: false, error }` (a secret not set, a 401, a timeout — masked of the credential); 404 |

An `agent` step reaches a server's tools through `agentTools`:
`mcp/<server>/<tool>` (globs: `mcp/linear/*`, `mcp/*`), as
`<server>_<tool>` tools. Every tool asks first — the call records a
proposal (§12), `mcp/<server>/<tool>` its step — unless the server marks
it `readOnlyHint` or the registration lists it in `ungated`; `approve:`
naming one gates it regardless. The proposal's title names the server and
its origin. Accepting it calls the tool once, through the registration as
it is then, with the proposing run's principal's secrets. A params override
may narrow an `mcp/` grant, never widen it; `mcp/` is no custom step's name.
`mcp: false` on an agent stops the launcher's servers, not its registry
grants.

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
| POST   | `/proposals/:id/decide` | `{ action: "accept" \| "reject", input?: object, reason?: string }` → the record after the decision. `accept` merges `input` (one level) onto the proposal's, re-parses with the step's schema (400, still pending, when it does not fit), records the decision, runs the step under a minimal context (the decider — the request's actor — as `ctx.actor`, the proposing run's principal binding its secrets, its job, the registry), and records `result`. `reject` records `reason`, runs nothing. 409 with the record once decided (`failed` may be accepted again); 409 too, still pending, while a proposal its step waits for (`StepDef.after`: `meta/set-automation` waits for a pending `meta/publish-workflow` of its workflow) is pending; 400 for a step no longer in the registry; 404 |

A step that reaches past this strut — `strut/run-workflow`, another org's
strut — holds to the host's gate by any route: when a host delta's `approve:`
names it (`createStrut({ job, orchestrator, builder })`), it runs only as an
accepted proposal (`ctx.proposal`, set by the apply alone). A workflow step
(the builder's `remote` branch: `job/start { workflow: builder, peer }`, or
`meta/run-workflow builder` with `input.peer`), `meta/run-step` or another
agent's ungated tool is refused. No host gate: unchanged.

The steps `proposal/list` ({ job?, session?, status?, limit? } → the briefs)
and `proposal/get` ({ id } → the record) are the same reads for an agent.

## 13. Sessions — a browser signs in

The key is a deployment secret; a browser facing the internet should hold
something shorter-lived. The login trades the key for an HttpOnly cookie the
page cannot read, signed under the same secret as a file token
(`STRUT_API_KEY`, else `STRUT_SECRET_KEY`) and stateless like one: no store,
and rotating that secret ends every session.

| Method | Path            | Description |
| ------ | --------------- | ----------- |
| POST   | `/auth/session` | `{ key, actor? }` → 200 `{ actor?, exp }` + `Set-Cookie: strut_session=…; Path=/; Max-Age=…; HttpOnly; SameSite=Lax[; Secure]`. Open to anyone (it IS the login); a wrong key is a `401` after half a second; `400` with no key configured. `actor`: who is signing in, ≤ 120 chars |
| GET    | `/auth/session` | `{ actor?, exp }` of the session the request carries; `404` for a request the key authenticated |
| DELETE | `/auth/session` | clears the cookie → `204`; needs no credential |

`exp` is the session's end in ms since the epoch — `STRUT_SESSION_HOURS`
(default 12) from the login. `Secure` is set when the request came over
https (directly, or `x-forwarded-proto: https`).

A request carrying a valid cookie is the key's equal — every route, `full`
scope, never more — and its `actor` is stamped on what it launches and
publishes (`x-strut-actor` beside it is ignored). Two CSRF rules: a request
that is not a `GET`/`HEAD` is honored only with the header `x-strut-ui: 1`
(the UI sends it on every call; a cross-site form cannot), and a file read
(`/artifacts/:runId…`, `/jobs/:id/files…`, or a peer's through
`/peers/<id>/…`) never opens on the cookie alone — fetch the listing with
the header, which mints the `?t=` token (§5), and read the files with that;
a peer's file, which no `?t=` opens here, is read with the header.

```bash
curl -s -c jar.txt -X POST localhost:3000/auth/session \
  -H 'content-type: application/json' -d '{"key":"'"$STRUT_API_KEY"'","actor":"evan"}'
# → { "actor": "evan", "exp": 1790479689808 }
curl -s -b jar.txt localhost:3000/workflows                       # a read: the cookie alone
curl -s -b jar.txt -H 'x-strut-ui: 1' -X POST localhost:3000/workflows/hello/run -d '{}'
curl -s -b jar.txt -X DELETE localhost:3000/auth/session           # → 204, cookie cleared
```

## 14. Apps — a front-end project over workflows

`plans/apps.md`. An APP is a directory with an `app.yaml` (title, `grants`,
the graph types it declares, extra resource domains), `src/` (TSX, its own
shadcn overrides, CSS), `public/` (assets) and `db/` (migrations, a later
item), built against the KIT (`kit/`, `@strut/kit`: the frozen vendor layer,
the bootstrap, the hooks) into ONE self-contained document,
`dist/index.html`, that any MCP Apps host frames. An app lives in the
workspace (below; a JOB's app directory is retired, §14.4). A workspace app is
versioned by the TREE HASH of its directory (`treeHash`, `src/version.ts`;
`dist/` and `data.db` left out, the kit never in it): identical content
re-activates the version it already is, anything else is the next `vN`. The
workspace store holds the pointers (`listApps`, `getApp`, `publishApp`,
`setActiveAppVersion`, `addAppRelease`, `setAppLive`, `deleteApp`,
`materializeAppVersion`); the files live
under `<dataDir>/apps/<name>/<vN>/` on every backend, `dist/` included. A
name may carry a package prefix (`acme/hvac/invoices`, `strut/views`) —
encoded in a URL (`/apps/acme%2Fhvac%2Finvoices`). Every strut with a built
kit lists `strut/views` (publisher `strut`, no grants): strut's own
components as an app other apps import (`import { RunTimeline } from
"strut/views"`), seeded at boot by tree hash (`createStrut({ views: false
})` seeds none); its page is a gallery over fixtures.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/apps` | `{ apps: [{ name, activeVersion, versions, title, description?, icon?, grants, publisher?, owner?, pinned?, live?, warnings? }] }` — `pinned: true` only on an app pinned as a tab; `live` (the release id) only on an app held at a release; `warnings` (§14.6) only when the active version has some from the last day |
| GET    | `/apps/:name[?version=vN]` | one version (the active one by default): the record (`version`, `hash`, `manifest`, `createdAt`, `upstream?`, `active`, `versions: { vN: { createdAt, hash, publisher?, source?, actor?, upstream? } }`, `publisher?`, `owner?`, `pinned?`) plus `dir`, `files`, `build` (`dist/build.json`: `kit`, `builtAt`, `hash`, `imports: [{ name, version, hash, pinned? }]`, `bytes`, `warnings`), `stale` (the document is older than the sources, or an imported kit moved), `missing` (the directory is not on this host), `inertGrants` (granted workflows that no longer exist), `live?` and `releases?: [{ id, version, createdAt, by? }]` (§14.5, without their locks); 404 |
| GET    | `/apps/:name/usage` | what the app's pages cost the server (§14.6): `{ app, since, lastCallAt?, hour, day, minutes, types, warnings }`; 404 for an unknown app |
| GET    | `/apps/:name/versions` | `{ name, active, versions, publisher?, owner?, pinned?, live, releases, behind }` — `live` is the live release's id or `"latest"`; `releases` each with its `lock` (§14.5); `behind: [{ kind: "workflow" \| "step", name, locked, current }]`, what the live release's lock names that has moved on since (`current: null` when gone) |
| GET    | `/apps/:name/:version/files` | `{ app, version, hash, files, token? }` — the version's directory, served exactly as a run's artifacts are (§5): the listing mints the app's FILE TOKEN (scope `app:<name>@<vN>`), absent with no secret to sign it. A version past the newest five (not the active one) is restored from its history and rebuilt first, ~2 s |
| GET    | `/apps/:name/:version/files/<path>` | one file, by `?t=<token>` or the key, sandboxed (`CSP: sandbox`, `nosniff`). `dist/index.html` — the document — read by TOKEN carries the token in `<meta name="strut-app-token">` (written as it is served; `dist/` holds no credential) and gets `sandbox allow-scripts`; read by the KEY it carries no meta and runs no script. The document has an `ETag` and `Cache-Control: private, no-cache`: the same version is the same bytes every time it is served, so a host keeps it and sends `If-None-Match`, answered `304` while it is current. A token for another app or version is `401` whatever else the request carries |
| POST   | `/apps` | `{ name, files: { "<path>": "<text>" \| { base64 }, … }, publisher?, upstream?, reactivateKnown? }` → 201 `{ ok, name, version, changed, hash, bytes, warnings, live, liveVersion?, release?, note?, graph? }` — `live: false` when the app is held: the version is a draft (§14.5). Builds first; a build that fails is `400 { error, errors, warnings }` and publishes nothing. An app that declares graph types (`data.graph`) registers them before the version is recorded, add-only, on a Neo4j graph only: `graph: { types: [{ type, created, added }], edges: [{ edge, created }] }`. On a LadybugDB file or with no graph it does not build, and a declaration that conflicts with the graph (another attribute type, another key, a required attribute left out, a type strut keeps — `Strut*`, `Concept`, `Claim`, `Check`, `Evidence`) is a build error naming it (§14.7). A PERSON's door: the grants are unrestricted (`llm`, a sealed step — what `app/publish` refuses, §9 of the plan). The actor becomes the owner when the app has none. |
| PUT    | `/apps/:name/active` | What people open (§14.5). `{ version: "vN" }` PROMOTES: a new release of that version with a lock taken now, made live — the app is held; `{ release: "rN" }` makes an earlier release live again, adding none; `{ version: "latest" }` follows the newest publish. → `{ ok, name, active, live, release? }` (`release` with its lock, on a promote). `400` without exactly one of the two; `404` for an unknown app, version or release; `409` for a refusal: a version that no longer builds on this strut's kit (the build's errors), an app strut seeds, a release whose lock names a workflow or step that no longer exists |
| PUT    | `/apps/:name/pin` | `{ pinned: boolean }` → `{ ok, name, pinned, live, release? }`: pin the app as a TAB, or unpin it — the record's flag (not a version pin), which a publish and a rollback keep and a delete clears. A host that lists this strut's apps (a portal's sidebar for the workspace this strut belongs to) shows each `pinned` one as a tab at its active version. Pinning an app that follows latest also HOLDS it at that version (§14.5): `release` is the one made, `live` its id; unpinning leaves what is live alone. `400` without a boolean, `404` for an unknown app, `409` when the version to hold no longer builds |
| DELETE | `/apps/:name` | remove the pointers (soft on the graph); the directories stay |

The same reads and writes as steps — `app/list`, `app/get { name, version? }` (or `{ path, job? }`, an app directory you are working on),
`app/init { path, template? }`, `app/checkout { name, version?, path }`,
`app/build { path }`, `app/publish { name, path, job? }`, `app/pin { name, pinned? }` — are the authoring
loop (`plans/apps.md` §8): a directory, the editor, build, read the errors,
publish. `app/publish` stamps `publisher: "ai"` and applies the meta
surface's rules. `app/get` (and `GET /apps/:name`) also carries `errors`:
the app's latest client-side errors, newest first, at most 50 — the kept
`step:app/report-error` runs stamped with the app (§14.1) — and `usage`:
§14.6's report without its per-minute series.

### 14.1 The app door — `step_run` (plans/apps.md §5, §7.2, §9)

An app's page holds no credential but its IDENTITY, written into
`<meta name="strut-app-token">` as the document is served under a valid
`?t=`: `app:<name>@<vN>.<token>` — the scope, then the file token minted for
it (`appIdentity`, `src/auth.ts`); on a strut with no secret to sign one
(dev mode: nothing minted, the gate open) the scope alone, `app:<name>@<vN>.`.
The kit sends it as the `app` argument of every call, and the host relays
the call as it is:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "step_run",
              "arguments": { "type": "run/list", "config": { "workflow": "score-wf" }, "app": "app:bench@v1.<token>" } } }
```

`step_run { type, config?, input?, app }` runs one registry step as the
connection's actor (the viewer: `x-strut-actor`, or who signed in) with
`ctx.app = { name, version }` set — the twin of `ctx.job` — after checking
the call against that app's manifest, in every host:

| Call | Rule |
| ---- | ---- |
| `run/*` | only on a workflow in `grants.workflows` (`job` on `run/list` filters them); a sealed workflow refused by name; `run/launch { job }` refused — a page launches no job's turn |
| any other type | only when `grants.steps` names it (globs as `agentTools` takes them) |
| `llm`, `agent`, `exec`, `acp/prompt` | refused whatever the manifest says — the workflow is the unit of spend (§5.1): a paid or shell-shaped step runs inside a workflow the app launches |
| a sealed step | refused |
| a graph write (`graph/create-node`, `edit-node`, `create-triplet`, `create-batch-triplet`, `delete-edge`, `edit-edge`, `delete-node`, `move-node`) | refused on a type the manifest's `data.graph.types` does not declare, and on a type strut keeps whatever it declares — the type from the config for a create, the node read first for an edit or delete by `ref_id` (case-blind); every value checked must be a literal, an edge is located by its endpoints |
| `job/get`, `job/read` | only when `grants.steps` names them |
| `sqlite/*`, `automation/*`, `job/start`, `job/continue` | "not available in this strut yet" (work items 3, 7; a "continue this job" door, §12 of the plan) |
| `graph/create-schema`, `graph/register-namespace`, `graph/project`, `app/init`, `app/checkout`, `app/build`, `app/publish`, `job/dir` | not a thing a page does |
| `app/report-error { message, stack?, componentStack? }` | always granted |

A refused call, a missing or foreign token (a run's or a job's file token,
a forged or unsigned one on a strut that signs, another app's) and a
step's own failure are error results: `isError: true` with a text
`{ "error": "…" }` the kit throws as a `StrutError`. A result is the
step's whole output — `structuredContent` when it is an object, the same
JSON as text — never trimmed for a model; past 5 MB it is an error naming
the cap. **Writes are kept** (§9): a graph write and an error report land
under `step:<type>` with the actor and `app` on their summary
(`GET /workflows/step:<type>/runs`); reads are not. A run `run/launch`
starts records `origin: "app"` and `app` on `run.start` and its summary and
hands `ctx.app` to every step.

### 14.2 The `run/*` steps (`src/steps/lib/run/`; `plans/apps.md` §5)

Runs as steps, unsealed — what the kit's hooks name, grantable to an agent
as `agentTools: ["run/*"]`, and the §3 … §7 routes' layers one more way
(`ctx.services.runs`, `src/runs.ts`). A sealed workflow is refused by name.

| Step | Config | Result |
| ---- | ------ | ------ |
| `run/list` | `{ workflow, limit? (50, ≤ 500), status?, since? (ISO or ms), automation?, job? }` — or `{ job, … }` with no `workflow`: a job's runs across every workflow it ran, off its record | the summaries newest first, without `input` / `output` / `stepCounts`, each with `artifacts` resolved (§5); a run in flight has a live status |
| `run/get` | `{ workflow, runId, wait? (ms, ≤ 55 000) }` | the summary whole + `artifacts`; in flight, the partial summary (`partial: true`) after holding up to `wait` |
| `run/events` | `{ workflow, runId, skip? }` | the log as `GET …/events` serves it (transcripts as links, long fields replaced by their size), cut at 5 000 keeping the head and the last event |
| `run/transcript` | `{ workflow, runId, path, full? }` | `{ path, messages, full?, truncated? }` — one agent's session by step path, the bare array `GET …/transcripts/<path>` serves (a page cannot follow that link); `full` = `?full=1`, a session turn's thread (`full: true` when stitched). Cut at 2 MB of JSON: long strings to head + tail (64k, 16k, then 4k chars), then messages left out after the system prompt and the task; `truncated: { chars, strings, stringMax, messages?: { at, count } }` says what went. No transcript at the path, or a session gone, is an error with the route's 404 message |
| `run/launch` | `{ workflow, input?, params?, job?, title?, key? }` | `{ runId }` at once (detached, like `POST …/run`; `params` may narrow a grant, never widen it, and may add to an `approve` list, never take from it); with `key`, the run of this workflow still in flight under the same key: `{ runId, existing: true }` |
| `run/cancel` | `{ workflow, runId, force? }` | `{ ok: true, runId, state }`; a run that is not live is an error. `force: true` is `POST …/cancel { force: true }` (§6.1): it abandons a step that never returns |
| `run/workflow` | `{ workflow }` | `{ name, description?, category?, activeVersion?, input? (the \`input:\` block), params?, peer? }` |
| `run/files` | `{ workflow, runId, path }` | `{ path, mediaType, bytes, text }` or `{ …, base64 }`, cut at 2 MB (`truncated: true`) — the job's directory for a job run, else the run's artifacts |

### 14.3 Hosting an app (plans/apps.md §7.3, §7.4)

Strut's own UI is an MCP Apps host (`web/src/app-host.ts`,
`web/src/components/AppHost.tsx`), and any other host — hive, a portal —
is one the same way, with no strut change per host:

1. **Fetch the document.** `GET /apps/:name/:version/files` (the active
   version from `GET /apps`) mints the token; `GET …/files/dist/index.html?t=<token>`
   is the page with its identity written in. A host that shows apps as
   tabs takes the ones `GET /apps` marks `pinned`. Frame the TEXT as the `srcdoc`
   of `<iframe sandbox="allow-scripts">` — an opaque origin, never
   `allow-same-origin`, no `src` that carries a credential. Not a `blob:`
   URL: a blob document's `location.origin` is its creator's while its
   pathname is the whole blob URL, and a validator bundled into the MCP
   SDK builds a URL from the two at module time — the page never mounts.
2. **Run the bridge.** ext-apps' `AppBridge` over a `PostMessageTransport`
   on the frame's window, connected BEFORE the document loads, over the MCP
   SDK's `Client` + `StreamableHTTPClientTransport` pointed at `/mcp` with
   the host's own credential (`Authorization`, `x-strut-actor` — the
   viewer; strut's UI sends its session cookie or key and `x-strut-ui: 1`).
   The bridge relays `tools/call` to the client by itself.
3. **Answer the two requests a page makes of its host:** `ui/message` goes
   to the host's conversation (strut's UI: the builder chat, the text
   prefixed with which app it is about); `ui/open-link` opens a strut deep
   link (`?wf=`, `?run=`, `?job=`, `?app=`) in place and anything else in a
   new tab. A theme change is a `ui/notifications/host-context-changed`.

Nothing else a host says to strut changes: runs, jobs, chat and files stay
on the HTTP API. A page's `tools/call` reaches strut in the shape it left
the frame in.

**A peer's app** (plans/apps.md §7.4). A person's own strut — Peel's, a
laptop's — hosts an app that lives on a peer it holds a PERSON token for,
with every URL above under `/peers/<id>`: `GET /peers/<id>/apps`, `GET
/peers/<id>/apps/:name/:version/files` (the PEER mints the token),
`…/files/dist/index.html?t=<token>` (the peer's identity in the meta, which
the person's strut cannot forge), and the bridge's client pointed at `POST
/peers/<id>/mcp` (§10). On the peer the token gets `step_run` alone, run as
the token's person under the app's grants — a granted workflow runs whatever
its YAML says about peers, as the app's run (`origin: "app"`), never a peer
launch. Open to every app on the peer; a plain peer key gets none of it.
Strut's UI lists each peer's apps beside its own as `?app=@<peer>/<name>`;
for one, it leaves out the version select, the tab toggle and the builder
button, and answers neither `ui/message` nor an in-place `ui/open-link` yet.
With `&solo=1` beside `?app=` (any app, here or a peer's) the UI renders the
page ALONE, nothing of strut's around it — what a native host such as Peel
opens in a web view of its own: `/?key=<the local strut's key>&app=@<peer>/<name>&solo=1`.
Alone, the page reads only the listing the app is in — `GET /apps`, or that
one peer's `GET /peers/<id>/apps` — then the app's files and its relay: no
workflows, step types or other peers (one that does not answer cannot hold
it at "Loading apps…"), and no `GET /runs/active` poll while it shows.
A key ending in `@vN` shows that version rather than the live one
(`?app=bench@v3&solo=1`, `?app=@acme/hive/ui@v2&solo=1`), the pin an app
import takes — how `app/look` sees a held app's draft. A version the app
does not have reads as no app.

**One file alone.** The twin for a deliverable that is a file:
`/?key=<the local strut's key>&artifact=<encodeURIComponent(path)>&solo=1`
renders the artifact viewer alone, filling the window, and reads nothing
but that file (and what it links to in its scope): like the app alone, none
of the UI's other loads and no poll. `path` is a path
on the local strut that serves the file: `/jobs/<job>/files/<file>`,
`/artifacts/<runId>/<file>`, or either behind one or more `/peers/<id>`
hops — `/peers/<org>/jobs/<job>/files/<file>` is an org's file through the
read-through (§10), `/peers/<org>/peers/<via>/jobs/<job>/files/<file>` one
more hop. Each id is one segment, percent-encoded (a job the peer keeps as
`peer/j-1` is `peer%2Fj-1`); the file path keeps its own `/`, and a path
that names a directory shows its listing. Anything else — another route,
an app's files, a URL, a query, an empty or `.`/`..` segment, encoded or
not — shows "Not a file strut serves" and reads nothing
(`isServedFilePath`, `kit/src/folds/artifact-view.ts`). The viewer renders
by extension: markdown (its relative links open in place, its images load,
both inside the same scope), images, video, audio, PDF, text, a directory,
a walkthrough, and HTML — a peer's as a static page in a frame that runs
nothing, since the read-through never serves a peer's page with scripts. A
peer's file is read with the UI's own credential and shown from its bytes
(an object URL, or the page's text), because no file token this strut
mints opens the read-through and the key never goes into an image's or a
frame's URL; a peer's file nothing renders, and the head's link, download
instead. `solo` is read once and stays in the URL; without it `artifact`
is ignored.

### 14.4 A published app as a deliverable

The `builder` workflow publishes an app in the workspace and hands it over
by NAME in its reply's `artifacts`, with the version it published: `{ id,
kind: "app", title, app: "<name>", version? }` (a DRAFT while a person
holds the app, §14.5; without `version`, the version people open), resolved to the version's document with `app: {
name, version, hash, builtAt }` beside the `url` (`CALLBACKS.md` §4) — on
`run.end`, `…/runs/:runId/artifacts` and `GET /jobs/:id`; a job that ran
the builder passes the entry on. Host it as §14.3: the version's listing
mints its token. A directory is no app: a JOB's app (a live directory in a
job's, with an identity of its own) is retired, runtime and all
(`plans/chained-orchestrators.md` §6). A page over a job's own results is
an HTML file in its directory, served as any job file is.

### 14.5 Releases — following latest, or held (plans/app-releases.md)

An app FOLLOWS LATEST by default: every publish is what people open. A
person may HOLD it instead with `PUT /apps/:name/active { version }`, and
PINNING it as a tab holds an app that follows latest at the version it
shows (`PUT /apps/:name/pin`). Either makes a RELEASE — `{ id: "rN", version, lock, createdAt, by? }` — and makes
it live. While held, `active` is the live release's version, a publish
records a DRAFT (`live: false` on its result) and changes nothing people
see, and `{ release }` rolls back (or forward) to another release. An app
keeps every release; one is live. A version a release names keeps its
directory, so a rollback serves the bytes that were live.

The `lock` is taken when the version is made live, never at publish: every
workflow the version grants and every subflow they reach as `{ version,
hash? }`, every workspace (custom) step the closure reaches as `{ version,
hash }` — every one when the closure cannot be read — and `floating`, one
sentence for each thing the lock cannot hold (a subflow chosen by a
template, an agent grant read at run time, a step that starts other runs).
Runs the live release's page launches will run the locked versions; until
that lands, a release holds the page and records the lock.

### 14.6 Usage — what an app's pages cost the server (`src/apps/monitor.ts`)

Every `step_run` of a known app (§14.1) — refused, failed or run — is
counted where it runs, per minute, version and step type, and KEPT in the
app's folder under the data directory, `apps/<name>/.usage/<YYYY-MM-DD>.jsonl`
(one file per UTC day, 30 days kept): one line per minute and version,
`{ "at": "2026-10-24T08:30:00.000Z", "version": "v3", "types": { "run/events": [calls, errors, bytes, ms] } }`
(a minute may span a few lines; they are summed), and a `{ "warning": … }`
line written the moment a warning fires. Counts are written every 15 s and
when the server shuts down cleanly, and read back the first time an app is
asked about after a restart, so a crash loses the last few seconds of
counts — never a warning. Deleting the app deletes its usage.
`GET /apps/:name/usage` reports the last day:

```json
{ "app": "dash", "since": "2026-10-23T09:00:00.000Z", "lastCallAt": "…",
  "hour": { "calls": 1240, "errors": 3, "bytes": 5242880, "ms": 41000 },
  "day":  { "calls": 9800, "errors": 12, "bytes": 40894464, "ms": 310000 },
  "minutes": [{ "at": "…", "calls": 22, "errors": 0, "bytes": 81920 }],
  "types": [{ "type": "run/events", "calls": 8200, "errors": 0, "bytes": 38000000, "ms": 250000 }],
  "warnings": [{ "kind": "fanout", "version": "v3", "type": "run/events", "window": "10s",
                 "peak": 214, "distinct": 214, "times": 6, "firstAt": "…", "lastAt": "…",
                 "message": "run/events called 214 times in 10 s from one page, with 214 different configs — a loop that makes one call per item",
                 "fix": "Gather what the view needs in one call: …", "example": "{\"workflow\":\"w\",\"runId\":\"…\"}" }] }
```

`since` is the oldest minute the report holds (absent before the first
call). `minutes` is the last hour, one entry a minute, oldest first; `hour`
sums it. `day` and `types` (busiest first) are the last 24 hours. `bytes` is the
results' JSON length; `ms` the server's time, a `run/get { wait }` hold
included. A warning is one of five patterns (`APP_MONITOR_LIMITS`), counted
in tumbling windows and kept on the VERSION that caused it:

| `kind` | Fires when |
| ------ | ---------- |
| `fanout` | one viewer calls one step type ≥ 50 times in 10 s with ≥ 25 different configs — a call per item |
| `repeat` | one viewer makes the same call, config and all, ≥ 120 times in a minute (a kit hook's live poll is 30) |
| `volume` | the version is called ≥ 600 times in a minute, or ≥ 5 000 in an hour, whoever calls |
| `bytes` | the version's results pass 50 MB in a minute |
| `failing` | one viewer's call of one step type fails (a refusal or the step's error) ≥ 20 times in a minute; `error` is the last one |

`peak` is the most seen in one window (bytes for `bytes`), `times` how
often it fired (once a window for each viewer it caught), `example` the last such call's config (cut
to 300 chars). `message` and `fix` are written for whoever fixes the app.
A version published and live starts clean: `GET /apps` counts the active
version's warnings only, and the UI shows a dot on the app (its row, the
Apps title, the Usage button) while there are any.

### 14.7 Graph types — what an app declares (`src/apps/graph-types.ts`)

```yaml
data:
  graph:
    types:
      Customer: { name: string, phone: string?, search: [name] }
      Invoice: { number: string, amount: number, due: date, status: string, meta: json?, key: [number] }
    edges:
      - [Invoice, BILLED_TO, Customer]
```

An attribute is `string | number | boolean | date | json`, `?` for
optional; on the graph `number` is a `float`, `date` an ISO string (it
compares as text) and `json` JSON text (a Neo4j property holds no map).
`key` names the attributes that identify a node, which become its
`node_key` (default `[name]`; every type has `name`); `search` the ones the
graph indexes (default the key). Every build checks the declaration
against the graph, and a publish registers it (`createNodeSchema`, the
shape of jarvis's `POST /v2/schema`, then each edge's schema) before the
version is recorded. Registration is add-only: a type another app
declared with the same attribute types, the same key and every attribute
it requires is the same type, a new optional attribute is added to it,
and nothing is removed — rolling back a version keeps what it registered.
Neo4j only: a LadybugDB file's types are fixed in code, so there, and on a
workspace with no graph, an app that declares types does not build.

A page writes the declared types with the graph writes (§14.1) and reads a
list with `graph/find`: `{ node_type, where?, orderBy?, desc?, limit?,
cursor?, count?, namespace? }` → `{ node_type, nodes: [{ ref_id,
node_type, name?, properties }], returned, cursor?, total? }`. `where` maps
a field (an attribute of the type, `ref_id` or `date_added_to_graph`) to a
value (equal; `null` = not set) or to operators that must all hold: `gt`,
`gte`, `lt`, `lte`, `in`, `contains` (a string field, case-blind). The
default order is newest first; `limit` is 1–500 (default 50); a `cursor`
comes back while there are more. It works on both engines, over any type
the graph holds.

## 15. Dictation — speech to text, its models and the user's vocabulary

Speech-to-text over sherpa-onnx (`src/audio/`, plans/local-desktop-and-stt.md
§4; the client contract is plans/native-dictation-client.md, the vocabulary
§7a; the design plans/dictation-models.md). 501 on a build without the sherpa
addon.

| Method | Path | Body / reply |
| ------ | ---- | ------------ |
| POST   | `/audio/transcribe[?model=&hotwords=&hotwordsScore=&session=&lingo=]` | a WAV body → `TranscribeResult` below. The model is `?model=`, else the user's speech pick once it is installed (`dictation/use`), else `STRUT_STT_MODEL` (Kroko); `model` names the one used. An offline model (Parakeet) decodes the clip in one pass: one segment |
| GET    | `/audio/stream` | WebSocket: PCM in, partials and finals out (as heard: no vocabulary). Streaming models only — an offline model is refused |
| GET    | `/audio/models` | `{ available, modelDir, models }` — every STT model with `installed` and `default` |
| POST   | `/audio/models/:id/download` | SSE progress of one STT model's download |

```ts
{
  text: string;            // what to type: the transcript with the vocabulary applied
  segments: { text: string; words: SttWord[] }[];  // as heard
  model: string;           // the speech model used
  hotwords: string | null;
  durationMs: number;
  fixer: string | null;    // the fixer model that read it; null: none ran (none picked or installed, too slow, lingo=0)
  heard?: string;          // the transcript as heard, only when `text` differs from it
  changes?: { heard: string; written: string; at: number }[];  // each edit, in text order: `heard` at offset `at` of `heard` became `written` ("" for a removal)
}
```

The vocabulary is memory/lexicon's, read on each call (src/audio/lingo.ts).
With the user's fixer (a small local model, src/audio/fixer.ts), spans that
may be a vocabulary word are found in code and each is kept when the model
scores the sentence likelier with the word; fillers ("um", "uh") and a word
said twice in a row are removed by rule ("that that", "had had" stay); a
phrase the speaker took back ("Tuesday, no, Wednesday") is removed when the
model names it and code finds it right before its cue. The model never
writes text: every edit is a span code found. With no fixer, or when it has
not answered within 1.5 s (a cold model loads meanwhile), only exact learned
mishearings are applied and `fixer` is null. `lingo=0` returns the
transcript as heard; so does a strut whose memory cannot be read (logged
once, never the text). 400 for a body shorter than a WAV header, 501 without
the speech addon.

Everything else is steps (`POST /steps/<type>/run`, §7), the same for any
client:

| Step | Config | Output |
| ---- | ------ | ------ |
| `dictation/models` | `{}` | `{ models: [{ id, kind: "speech" \| "fixer", name, summary, recommended, bytes, description, state: "available" \| "downloading" \| "installed", progress?, downloaded?, selected, active, removable, error? }] }` — `name` / `summary` what a picker shows, `recommended` true for `qwen3-1.7b-q4` only; `progress` 0..1 and `downloaded` (bytes) while downloading; `selected` the user's pick for its kind, `active` what strut uses now (the installed speech pick, else the default speech model; the installed fixer pick — differs from `selected` while a pick downloads); `removable` false for an active model and the default speech model; `error` why the last download failed |
| `dictation/use` | `{ speech?, fixer? }` — `fixer: null` is none | the same list. A pick that is not installed starts downloading in the background (sha256 checked, extracted into the model dir) and is used once installed; until then dictation keeps to what it had. A speech model is refused where sherpa cannot run |
| `dictation/remove-model` | `{ id }` | the same list. Deletes the model's files. Refused for a model not `removable` (active, or the default speech model) and while it downloads; a pick removed before it was installed goes back to the default speech model, or to no fixer |
| `dictation/correction` | `{ typed, edited }` (each ≤ 20,000 characters) | `{ learned: [{ heard, written, undo: string[] }] }` — what the user's edit of dictation's text teaches. Send it once the edit settles. With no fixer `active`, `learned` is always empty: a client need not send edits then |
| `dictation/enable` | `{ ref_id, on: boolean }` | `{ ref_id, on }` — dictation off (`false`) or back on for one entity: off, its mishearings are not applied, its forms not looked for, nothing learned for it (`memory/lexicon`'s `dictation_off`). The entity stays. `ref_id` is the entity changed |
| `dictation/add` | `{ written, heard }` | `{ heard, written, undo }` — the same write as a learn, by hand |
| `dictation/undo` | `{ undo }` | `{ undone }` — takes back a learn; the pair is never learned again. Refused for ids dictation did not write |
| `dictation/remove` | `{ ref_id }` | `{ forgotten }` — a mishearing, or a word of `lingo_type` with all its mishearings |

Speech models: `zipformer-en-kroko` (streaming, the default) and
`parakeet-tdt-en-0.6b-v2` (offline). Fixer models (GGUF Q4_K_M on
node-llama-cpp, Metal on a Mac): `qwen3-1.7b-q4` (1.1 GB, the one to offer
first) and `qwen3-0.6b-q4` (0.4 GB, faster, worse at telling a mishearing
from a changed word). Only a strut that has node-llama-cpp offers them — the desktop
package; a server install does not carry it — and elsewhere
`dictation/models` lists none and `dictation/use { fixer }` is an error.
The picks live in `<dataDir>/audio/dictation.json`;
with none, Kroko and no fixer — a fixer is never downloaded unless picked.
The fixer loads on first use and unloads after five minutes idle.

`dictation/correction` diffs the two texts word by word; each change of at
most four words a side that could sound like what was typed is asked of the
fixer, yes or no, and learned when it says yes. Nothing is learned with no
fixer installed (or one that, once loaded, takes longer than 1.5 s). Each
pair is written with memory/remember (episode `Dictation: corrected “heard”
to “written”.`, kind `note`, created_by `dictation`, on the entity that
writes `written`, else a new word of memory/lexicon's `lingo_type`); `undo`
is what `dictation/undo` takes back — the new entity, else the new fact,
empty when memory already had the pair. Undone pairs, words turned off
for dictation, and a change whose `heard` side is already a vocabulary form
("BTC" → "Bitcoin", "PH" → "P8") are never written, whatever the fixer says. Only the pair is stored. The sentence is in
the run's own events, returned to the caller and kept only as §7 says
(`keep: true`, or claims on the step), so a caller that wants no record of it
never passes `keep`.

## 16. Packages — sharing workflows, steps, apps and Concepts (`plans/marketplace.md` §1–§5)

A PACKAGE is a directory: `strut.yaml` (`package: publisher/name`,
`version`, `description?`, `license?` — an SPDX expression, never
enforced — `requires?`) and the folders `workflows/`,
`steps/`, `concepts/` and `apps/`, each file an item named under the
package's prefix (`steps/create-issue.ts` is the step
`acme/linear/create-issue`, `workflows/sync.yaml` the workflow
`acme/linear/sync`, the folder `apps/issues/` the app
`acme/linear/issues`). It is pinned by its DIGEST, `sha256:<hex>` over every
file in it (`readPackage`, `src/packages/format.ts`). A strut keeps every
package it resolved under `<dataDir>/packages/`, one directory per digest,
and serves any of them by digest — whether it built the package or
installed it, it can be a mirror. Only `file:` refs resolve today; `git+`
and `pk:` are refused by name (`package_source_unsupported`).

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/packages` | What is installed: `{ packages: InstalledPackage[] }` (`src/packages/installed.ts`), a fold over the workspace, never a store |
| POST   | `/packages/build` | `BuildRequest` → 201 `{ package, version, digest, files, requires, warnings }` (`src/packages/build.ts`): a package built from this workspace into the cache. A person's act like install: full scope, one at a time with install and uninstall |
| POST   | `/packages/install` | `{ ref: "file:/path/to/package", digest?: "sha256:<hex>" }` → 201 `InstallResult` (`src/packages/install.ts`). A person's act: behind the key at full scope (a peer is 403), one at a time |
| DELETE | `/packages/:publisher/:name` | Uninstall → `{ ok: true, package, removed, kept }` (`UninstallResult`) |
| GET    | `/packages/:publisher/:name/archive?digest=sha256:<hex>` | The package at that digest as a `.tar.gz` of its files (`content-type: application/gzip`, `ETag: "<digest>"`, `cache-control: private, max-age=31536000, immutable`; `If-None-Match` → 304). 400 without a well-formed `digest`; 404 when this strut holds no package `publisher/name` at that digest. Behind the key like every route |

**Build** writes a package from what this workspace holds and puts it in
the cache by its digest, so the archive route serves it and an install
takes it from `file:<the cache directory>` (`<dataDir>/packages/sha256-<hex>/`).

```jsonc
// BuildRequest
{
  "package": "acme/linear", "version": "1.4.0",   // required
  "description": "Linear issues", "license": "Apache-2.0",
  "workflows": ["acme/linear/sync"],   // each with everything it can execute
  "steps": ["acme/linear/create-issue"],  // beyond what the workflows reach
  "concepts": ["Linear"],              // each with the pages under it (PARENT_OF)
  "apps": ["acme/linear/issues"],      // each with what its grants execute and the apps it imports
  "requires": {                        // packages BUILT on this strut that this one needs
    "packages": [{ "package": "acme/util", "digest": "sha256:…" }]  // the digest their build returned
  }
}
// → 201
{
  "package": "acme/linear", "version": "1.4.0", "digest": "sha256:…",
  "files": ["concepts/Linear.md", "steps/_shared.ts", "steps/create-issue.claims.yaml", "steps/create-issue.ts", "strut.yaml", "workflows/sync.yaml"],
  "requires": {                        // as written into strut.yaml
    "secrets": ["LINEAR_API_KEY"], "binaries": ["sh"],
    "packages": [{ "package": "acme/util", "digest": "sha256:…", "source": "file:/…/packages/sha256-…" }]
  },
  "warnings": []                       // a claim left out, a closure read only in part, a parent outside the package
}
```

What goes in:

- **The closure** of each named workflow (`flowClosure`: its subflows,
  `agentTools` with globs expanded against the registry). A workflow or
  custom step it reaches under the prefix is an item, and so is every `_`
  helper under the prefix. Core and lib steps, and a seed's workflow or step
  (`source: "seed"`, such as `job`), are recorded nowhere: the installing
  strut must have them, and the install checks.
- **Another package's item** the closure reaches is a `requires.packages`
  pin: at the digest it was installed at (its `upstream`), or, for a
  package built on this strut, at the digest the request names under
  `requires.packages`. A sibling is checked: every item reached under its
  prefix must be in its cached copy, byte for byte as it is here now. A
  named sibling is pinned whether or not anything reaches it.
- **Each named app** as its active version's sources, `apps/<name>/`:
  the files its version hash covers (never `dist/` or `data.db`), checked
  against that hash, so the app's tree hash in the package is its version
  hash here. Its grants are walked like a workflow's closure: each workflow
  in `grants.workflows` and `grants.automations`, each step in
  `grants.steps` (globs expanded against the registry). So are the apps it
  imports, read off its build (`dist/build.json`): one under the prefix is
  an item, another package's a pin, a seed's (`strut/views`) recorded
  nowhere. An app under the prefix has one name segment after it
  (`apps/<name>/`).
- **The Concepts** named, with every page under each, as
  `concepts/<Name>.md` (front matter `description`, `parent`; the body is
  `docs`). A top page keeps its parent.
- **Each step's claims**, as `steps/<name>.claims.yaml`. A claim with a
  check that reaches outside the package and what it requires is left out,
  with a warning.
- **`requires`**, from what can be read: secret names in step configs
  (`secretsEnv`, `tokenSecret` and the other secret-name fields, a step's
  own `secrets` and schema defaults), literal `secrets.get("…")` calls in
  step source, literal `exec` commands, literal `runtime:` fields.

Building twice from the same workspace gives the same digest. Refusals are
400 `{ error }`, one `package_build_refused: …` naming every problem: a
workflow, step or app outside the prefix that came from no package, one
package reached at two digests, a version label (`type@vN`, a subflow's
`version:`, an app import pinned as `name@vN`), an app whose directory is
not its version or that has no build of its sources, an item in a sealed
namespace, a step that does not load here as its own type, a Concept
another seeder stamped, a closure that cannot be read whole (a templated
subflow, a grant read only at run time) unless the request names more than
that workflow, a sibling that is not in the cache or no longer matches.

**Install** resolves the package, then every package its
`requires.packages` pins that is not installed here at that digest (from
the cache when it holds the digest, else from the pin's `source`; a
relative `file:` source is relative to the requiring package's directory),
and installs them FIRST. It is all or nothing: every name and file of every
package is checked before the first write — each step it makes active is
LOADED from a trial directory first, beside the helpers as they will be —
and a step that still fails to load takes back what the install wrote. Each app is copied out of the
cache and BUILT against this strut's kit, with the packages' workflows and
apps in reach, before anything is written — the kit is this strut's, so
the build is the compatibility check — then published after the workflows
through the apps capability (`POST /apps`'s publish), each after the apps
of the set it imports. Each step, workflow and app version it
writes records `source: "install"`, the installing actor, and
`upstream: { package, version, digest, source: { ref }, secrets }` (what
`GET /workflows/:name`, the step version records and `GET /apps/:name`
show); a workflow's and an app's `owner` is the installing actor. A Concept is written stamped
`pkg/<package>/<file>@<hash>` (skipped, with a warning, without a graph).
A step's `<name>.claims.yaml` and a workflow's `claims:` block are recorded
with the package as their speaker, and `publish` checks fire.

```jsonc
// InstallResult
{
  "package": "acme/linear",
  "digest": "sha256:…",
  "packages": [                       // requirements first, the package asked for last
    {
      "package": "acme/linear", "version": "1.4.0", "digest": "sha256:…",
      "source": { "ref": "file:/srv/packages/acme-linear" },
      "status": "installed",          // or "present": everything was here already; "updated": moved from `from`
      "from": { "version": "1.3.0", "digest": "sha256:…" },  // an update only (the distro's door, below)
      "items": [                      // installed | present | modified (here and forked, left as it is) |
                                      // updated | diverged | retired | kept (+ "reason") — an update only
        { "kind": "step", "name": "acme/linear/create-issue", "status": "installed", "version": "v1" },
        { "kind": "workflow", "name": "acme/linear/sync", "status": "installed", "version": "v1" },
        { "kind": "app", "name": "acme/linear/issues", "status": "installed", "version": "v1" },
        { "kind": "concept", "name": "Linear", "status": "installed" }
      ]
    }
  ],
  "missing": { "secrets": ["LINEAR_API_KEY"], "binaries": [], "runtimes": [] },  // reported, never refused
  "warnings": []                      // a step that reaches past ctx.services; claims that did not record
}
```

The same package at the same digest installs again as what is missing (a
deleted item comes back; a fork stays active).

**An update** — the package at another digest — is not taken by this
route yet: a person's update asks first (`plans/marketplace.md` §4, §8).
The operator's DISTRO applies one with no ask, in process
(`strut.packages.install(ref, { door: "distro" })`, `plans/marketplace.md`
§12, §12.1; no route takes the door), item by item, and updates a package
the release requires first:

| The item here | What the update does | `status` |
| --- | --- | --- |
| Its active version is one the package wrote (any release) | the release's version is published and made active | `updated` |
| A fork: its active version is one this strut wrote | the release's version is recorded beside it, not active | `diverged` |
| Already the release's content | nothing | `present` |
| Not in the release, untouched | removed (the runs stay) | `retired` |
| Not in the release, a fork — or a helper while a step of the package stays forked | kept | `kept` |
| A Concept edited here (or whose edit cannot be told) | left as it is | `modified` |

Versions it writes record `source: "distro"`, and `GET /packages` says
`door: "distro"`: such a package is the distro's, and a person's install
or uninstall of it is refused (`package_distro_owned`).

Refusals, as `{ error }` with a code first:

| Status | Code | When |
| ------ | ---- | ---- |
| 400 | `package_source_invalid`, `package_source_unsupported`, `package_digest_mismatch`, `package_name_mismatch` | the ref does not resolve to that package |
| 400 | `bad_package` | a file it cannot install: a workflow naming a step, grant or subflow that is neither on this strut nor in the packages, a workflow whose `name:` is not its path, a claims file that is not a list of claims, a step that does not load or whose `defineStep` type is not its path, an app whose `app.yaml` does not parse, that grants a step that is neither here nor in the packages, or that does not build on this strut's kit (an import the kit lacks, a granted workflow that is nowhere) |
| 409 | `package_conflict` | a local workflow, step or app under the prefix, a step in a sealed namespace, a Concept under the name that is someone else's, a Concept's `parent` that exists nowhere, a package pinned at two digests or installed here at another |
| 409 | `package_update_not_built` | the package is installed here at another digest (a person's update asks first, which is not built yet) |
| 409 | `package_distro_owned` | the distro installed the package here: only the distro updates or removes it |

Once installed, a NEW workflow, step or app name under the prefix is
refused at every door (`package_conflict`, `refuseUnderInstalledPackage`,
`src/workspace.ts`): only the package's own install adds a name there. An
edit of an installed item is a FORK — a new version that carries the
`upstream` forward. And an installed step — a fork too — reads only the
secrets its package declares: any other `secrets.get(NAME)` fails
`secret_fenced: <step> came from the package <package>, which declares
only …` (`src/packages/fence.ts`).

```jsonc
// InstalledPackage
{
  "package": "acme/linear", "version": "1.4.0", "digest": "sha256:…",
  "source": { "ref": "file:/srv/packages/acme-linear" }, "secrets": ["LINEAR_API_KEY"],
  "door": "install",                  // or "distro": the distro wrote it (absent for a package of Concepts alone)
  "items": [
    { "kind": "workflow", "name": "acme/linear/sync", "installed": "v1", "active": "v2", "modified": true },
    { "kind": "step", "name": "acme/linear/_shared", "helper": true, "installed": "v1", "active": "v1", "modified": false },
    { "kind": "app", "name": "acme/linear/issues", "installed": "v1", "active": "v1", "modified": false },
    { "kind": "concept", "name": "Linear", "modified": false }  // its text against the file in the cache; absent when the cache lost it
  ]
}
```

**Uninstall** deletes every item still as the package installed it — the
versions (soft on a graph), never the runs, evidence or jobs, so history
keeps the name it ran under — and retires each untouched Concept. A fork,
an edited page, and the helpers while a forked step of the package stays
are kept and listed in `kept: [{ kind, name, reason }]`. 404
`package_not_installed`; 409 `package_busy` while one of its workflows has
a run in flight; 409 `package_distro_owned` for a package the distro
installed.

The archive is transport: a fetcher checks the unpacked TREE against the
digest, never the archive's bytes, so any URL that serves the right tree
is as good as the publisher's (`fetchArchive`, `src/packages/archive.ts`,
which also refuses an entry that leaves the directory or that the digest
never covers — a dotfile, an app's `dist/` or `data.db`).
