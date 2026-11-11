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
things served without the key are the web UI's own files, `GET /health`
(§8), and `GET /public/*` with the POSTs §17 names (a visitor's page, a
launch and its cancel, buying and claiming credit): what a person put in
the public view, and nothing when nothing is. The examples below leave the header out for brevity; add
`-H "Authorization: Bearer $STRUT_API_KEY"`.

`x-strut-actor: <id>` names who a request is from — honored only alongside a
matching key — and is recorded on the run (`actor`, `principal`) and on the
workflow it publishes (`owner`). AGENTS.md "Auth" has the whole model.

**A browser signs in instead.** The web UI trades the key for a short-lived
session cookie at `POST /auth/session` (§13), so the key is never kept in a
browser; a client that is a program keeps using the header. A host that
signs its people in (§13.1) names each one's role: an admin's session is
the key's equal, a MEMBER's opens the apps here and nothing else (scope
`member`, §13.1 "Admins and members").

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
own agent sessions (§3), the actor's room, `POST /mcp`, where it gets
an app's `step_run` alone, run as the actor under the app's grants (§14.3,
"A peer's app"), `POST /voice/calls`, a call set up as the actor (§15.2),
and `POST /proposals/:id/decide` for a proposal its actor
made — and it lists only those, but reads any proposal by id (§12). The
plain peer key decides no proposal and sees none. A host maps its
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
| GET    | `/workflows[?q=]`               | `[{ name, activeVersion, versions: ["v1", …], description?, category?, publisher?, owner?, maxRunCostUsd?, disabled?, automations?, lastRunAt? }]` |
| GET    | `/workflows/:name`              | `{ active, versions: { "v1": { createdAt, description?, hash?, source?, actor?, upstream? }, … }, category?, publisher?, owner?, maxRunCostUsd?, disabled?, automations? }` (`WorkflowMetadata`; `upstream` = `{ package, version, digest, source: { ref }, secrets }`, the package a version was installed from or forked off — every publish carries the active version's forward) |
| GET    | `/workflows/:name/flow[?version=]` | `{ name, steps, input?, params?, promotes? }` — the parsed active (or named) version |
| GET    | `/workflows/:name/versions`     | `{ active, versions: [{ version, createdAt, description?, source?, actor?, runs, success, error, lastRunAt? }], unattributed }` newest first; counts by the run's recorded `workflowHash` |
| GET    | `/workflows/:name/:version`     | the YAML source, `text/yaml` |
| PUT    | `/workflows/:name/active`       | `{ version }` → `{ ok, workflow, active }` — rollback; publishes nothing |
| PUT    | `/workflows/:name/publisher`    | `{ publisher: "ai" \| null }` → `{ ok, workflow, publisher }` — hand the workflow to the builder, or take it back (below); publishes nothing |
| PUT    | `/workflows/:name/disabled`     | `{ disabled: boolean }` → `{ ok, workflow, disabled }` — disable the workflow, or enable it again (below); publishes nothing |
| DELETE | `/workflows/:name`    | `{ ok, workflow }` — every version, metadata, schedules and run records; 409 while a run is in flight |

`?q=` is the sidebar's filter: the query is split into words and every word
must appear (case-insensitive) in the name, the category or the description.
Name hits rank first; otherwise the list keeps its order. Empty or absent
returns everything.

`publisher` is the stamp the builder's authoring (`meta/publish-workflow`,
the builder job's tool) publishes over: it writes only over workflows
stamped `ai`, so the builder can edit what it made and nothing else. A
person hands a workflow to it with `PUT /workflows/:name/publisher {
publisher: "ai" }` — the Workflow flyout's "Let the builder edit this" — and
takes it back with `null`. From then on the builder publishes new versions
without asking; every version stays, so a bad one is rolled back with
`PUT …/active`. A publish never moves the stamp, a person's included. `400`
for any other value, `404` for an unknown workflow, `409` when the workflow
is stamped by a service (another value, theirs to keep) or, to hand it
over, when its active version is a seed (every boot puts the committed
version back), says `sealed: true` (a grading harness) or `peer:` (the
builder may not publish that key, so its next version would close the
workflow to other struts). A peer's request is refused by the gate.

`disabled: true` (`PUT /workflows/:name/disabled`, the Workflow flyout's
Disable) makes the workflow refuse every NEW run until a person enables it
again: `POST …/run` and `…/:version/run` answer `409` with `workflow '<name>'
is disabled: …`, and the same refusal is what `strut.run`, a `subflow` step
that calls it, `job/start` / `job/continue`, `run/launch`, `meta/run-workflow`,
the builder's `run_workflow` and the conversation wake get. A durable resume
(`POST …/resume`, boot's auto-resume) is refused too (`409`; auto-resume
reports the run skipped). Its schedules are HELD, not failed: a due fire
launches nothing and records no `lastFireError`, and `POST
…/automations/:id/fire` answers with the refusal. A run already in flight
finishes. Like `category`, it is workflow metadata: no version is published,
a publish keeps it, and a rollback does not change it. `400` when `disabled`
is not a boolean, `404` for an unknown workflow; a peer's request is refused
by the gate.

## 3. Run

| Method | Path                            | Body | Response |
| ------ | ------------------------------- | ---- | -------- |
| POST   | `/workflows/:name/run`          | `{ input?, params?, paramOverrides?, settings?, runId?, callback?, job?, title?, jobCallback?, mcp?, attachments?, conversation?, wake? }` | 202 `{ runId, callback?: true, jobCallback?: true, mcp?: true, attachments?: true, wake?: true }` |
| POST   | `/workflows/:name/:version/run` | same | same |
| POST   | `/conversations/wake`           | `{ session, source, end }` | 200 `{ wake: "launched" \| "capped" \| "none" }` |

| Field            | Meaning |
| ---------------- | ------- |
| `input`          | the run payload, validated against the workflow's `input:` block (unknown keys dropped); `{}` when omitted |
| `params`         | shallow-merged over the workflow's `params:` defaults for this run only. A `model` among them also reaches the jobs the run starts or continues (`job/start`, `job/continue`), so a conversation and its jobs run on one model |
| `paramOverrides` | `{ "<workflow name>": { … } }` — the same, per workflow, reaching subflows |
| `settings`       | `{ "<setting>": value }` — this run's level of the registered settings (`privacy`: `PRIVACY_SPEC.md` §10): over the workflow's `settings:` and the deployment's, under a step's `options.settings`. Not validated at launch (a bad value fails the step that reads it), not recorded on `run.start` (a durable resume runs without it), not handed to runs this run starts |
| `runId`          | your own id (unique within the workflow); default a millisecond timestamp, e.g. `"1790436489808"` |
| `callback`       | `{ url }` (http/https) — the result is POSTed there when the run settles; see `CALLBACKS.md`. Any other scheme is a 400 and nothing launches. Or `{ room: true }`: delivered to the launching actor's ROOM, a socket the client holds open (`GET /rooms`, §10; `CALLBACKS.md` §8) — 400 for a request that names no actor or carries the shared peer key |
| `job`            | the job to launch under (`plans/jobs.md`): an id you mint, the format of a session id (§9); a bad one is a 400 and nothing launches. Recorded on the run, handed to steps as `ctx.job` and to templates as `{{ $job }}`; `job/dir` gives the run the job's directory, and the callback resolves the output's `artifacts[]` into it (`CALLBACKS.md` §4). The run is also recorded on the job — `GET /jobs/:id` (§5) lists it |
| `title`          | the job's name (`plans/job-index.md`), recorded on the JOB, never on the run: the host's label for it, kept until a later launch carries another. 400 without `job` |
| `jobCallback`    | `{ url }` (http/https) — the JOB's live updates (`job.update`: a hold taken or let go, a check's evidence, a verify ended, a step's screenshot or walkthrough frame) are POSTed there as they happen, from every run under the job; see `CALLBACKS.md` §5. Kept on the job, never returned; the latest launch that carries one wins, `null` clears it, absent keeps it. With or without `job`, the jobs THIS run starts (`job/start`, `job/continue`) inherit it — an orchestrator turn's host hears every job it starts at one URL, each event naming its `job` and `runId`. 400 for another scheme. `{ room: true }` as for `callback` |
| `mcp`            | `[{ name, url, token?, headers?, toolFilter? }]` (`McpServer`, `src/core.ts`; at most 10) — YOUR MCP servers, the way back into you for this run's agents: every `agent` step gets their tools as `<name>_<tool>` unless it says `mcp: false`, and so do the jobs a turn starts (`job/start`, `job/continue`) and the runs it launches (`meta/run-workflow`) — never a peer. `url` is a Streamable HTTP endpoint (http/https); `token` is sent as `Authorization: Bearer <token>`, `headers` for any other scheme; `toolFilter` keeps those tools only (names or globs). `name`: letters, digits, `_`, `-`, unique. A bad entry is a 400 and nothing launches. The log records `mcp: [{ name, origin }]` only; the entries are kept beside it for a resume and returned by nothing. A server that cannot be reached when an agent starts is skipped, the agent going on without its tools |
| `attachments`    | `[{ name, mediaType?, data }]` (`src/ai/attachments.ts`) — files for the run's agents, the person's message's: `data` is base64 or a data URL, `mediaType` defaults from the data URL, else the extension. At most 10, 10 MB each, 5 MB an image, 15 MB together; a bad one is a 400 and nothing launches. Saved under the run's artifacts as `attachments/<name>` (`GET /artifacts/:runId` lists them) and put on every `agent` step's prompt after its text — an image or a PDF as a file the model sees, text and Word inline, anything else announced by its path — unless the step says `attachments: false`; a sub-agent never gets them. `run.start` records `attachments: [{ name, mediaType, size, path }]`, never the bytes (the agent's transcript keeps what the model saw). An orchestrator turn hands a job the ones it needs by name (`job/start` / `job/continue` `attachments`) — this message's, or one an earlier turn of its session carried (the turn log records them, `/sessions?id=`); not to a builder job on a peer |
| `conversation`   | a session id (§9; a bad one is a 400) — the conversation this run belongs to, for a job turn you launch yourself: when it ends, strut WAKES that conversation as it does for a job a turn started (`CALLBACKS.md` §9, `src/wake.ts`). Recorded on `run.start`; read wherever `startedBy.session` is (a proposal's conversation). The deployment's only: a peer's launch carrying it is a 403 |
| `wake`           | `true`: ASK strut to wake this run's conversation when a job ends — on a person's turn (`input.session`), the jobs it starts; on a job turn you launch naming a `conversation`, that job (`CALLBACKS.md` §9, `src/wake.ts`). Opt-in: a launch that does not ask is never woken, so a host that wakes on its own never gets two. `true` or `false` (else a 400); recorded on `run.start` as `wakeAsked`. A peer's is dropped (its turns are relays) |

**The wake.** A launch that asks (`wake: true`, with the deployment's
rights) of a conversation workflow — one whose template has `params.wake`,
the seeded `orchestrator` — on an `input.session`, or of a job turn naming a
`conversation`, answers `wake: true`: when a job of that conversation ends,
strut runs one more turn of it on its own (`CALLBACKS.md` §9). Every job turn's `run.end` then says what strut did
(`wake: "launched" | "capped" | "none"`), and the wake turn's carries
`wake: { job, runId }`. `POST /conversations/wake` is the same wake for a
job that ran on ANOTHER strut, whose `run.end` you heard on that strut's
room: `session` the local conversation, `source` the peer's id, `end` the
`run.end` as it came (a job's: `workflow` `job` or `builder`; anything
else, or a bad session or source, is a 400). Its Continue hands the
go-ahead to `@<source>`'s assistant. The deployment's only (403 to a peer).
`createStrut({ orchestrator: { wake: false } })` turns all of it off: no
`wake: true`, every job end `"none"`.

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
`<actor>/…`, the thread the actor's host opens for them here too — and so
does a CONVERSATION it continues: a turn of a conversation workflow (one
with `params.wake`, the orchestrator) whose `input.session` is a
conversation the actor took a turn in, or a shared one (§9.1), under
whatever id it has — Hive's are bare. That run records `continues: <id>`
on `run.start`. Another person's conversation is a `403`
(`conversation_not_yours: "<id>" is another person's conversation …`),
and nothing launches. Every other id it names is still `peer/<id>`; its
`job` is still `peer/<job>`. Only the same person's credential resumes
such a run.

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
attaching late loses nothing. An append wakes the tail at once (the log is still re-read every 250 ms as the fallback), so a live reader — a voice agent following `reply.delta` events — hears each event within milliseconds.

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
| GET    | `/workflows/:name/runs?limit=&before=`                 | array, newest first, ONE PAGE: `limit` runs (default 50, at most 500) older than `before` (a run id — the last row of the page before; omitted, the newest). A summary (§5.1) per finished run, `{ runId, workflow, status, job?, jobTitle? }` for one still going (§5.2 states; `job` + `jobTitle` as on `/runs/active`). Fewer than `limit` rows: there are no older runs (or ask for `limit + 1` to know without another request, as the web UI does). The cursor holds when that run has been deleted |
| GET    | `/workflows/:name/runs/:runId`                         | the summary (§5.1); a partial one (§5.2) while the run is going or if it died before finalizing; 404 only when there is no log at all |
| GET    | `/workflows/:name/runs/:runId/events`                  | every event, in order (§5.3) |
| GET    | `/workflows/:name/runs/:runId/transcripts/<step path>` | one agent session as a bare array of AI SDK model messages; 404 if that step recorded none. For a step that continued a `session` (§9) this is its system prompt + THAT TURN; `?full=1` is the thread up to and including it (404 once the session is deleted). An app reads the same through `run/transcript` (§14.2) |
| GET    | `/workflows/:name/runs/:runId/artifacts`               | `{ workflow, runId, job?, artifacts: [{ id, kind, title, label?, summary?, url? \| content? \| error?, peer?, job?, path? }] }` — the deliverables the run's output declared, resolved as the run callback resolves them (`CALLBACKS.md` §4) — one tagged `peer` (another strut's, `strut/run-workflow`) as it came, its `path` in that peer's `job`, resolved by the reader against the peer; 404 until the run has a summary |
| GET    | `/workflows/:name/evidence[?runId=&limit=&before=]`   | what the checks said about the workflow's runs (§5.4) |
| GET    | `/artifacts/:runId`                                    | `{ runId, files: ["report.md", …], token? }` — what the run's steps wrote, and the run's **file token** (present when there is a secret to sign it: `STRUT_API_KEY`, else `STRUT_SECRET_KEY`): a `GET` of this listing or of any file under it with `?t=<token>` needs no key — the link form, worth this run's files and nothing else (an HMAC of the run id under the secret: no store, rotates with it). A `?t=` strut cannot vouch for is a 401 even on an open strut, so a host's gate may hand token-bearing reads through; 501 when the deployment has no artifact store |
| GET    | `/artifacts/:runId/<path>`                             | the file, content-typed by extension (unknown → `application/octet-stream`), with `X-Content-Type-Options: nosniff` and `Access-Control-Allow-Origin: *`; 404 for a path that is not a file (a directory: the listing is what names what is in it). A step wrote it, so everything but `video/*` and `audio/*` also carries `Content-Security-Policy: sandbox`: opened in a browser it has no origin, and only `text/html` read by its file token runs script (`sandbox allow-scripts`) — a page an agent built runs, and the one thing in its URL is that token; read with the key, or through a host's gate, it runs none. A host that frames or proxies artifacts must keep these headers |
| GET    | `/jobs?q=&workflow=&limit=`                            | `{ jobs: [{ job, title?, createdBy?, actors?, createdAt?, usedAt, busy?, workflow?, runs, holds }], actor? }` — `workflow` is the one the job's newest TURN ran, `job` or `builder` (`JOB_WORKFLOWS`, `plans/builder-job.md` §2): what the job is, what `job/continue` launches next; — every job, newest-used first (`plans/job-index.md` §2): `runs` and `holds` are counts, `busy` the run working in its directory now, `actors` everyone who launched a run under it (first seen first; `createdBy` is the head). `q` is the workflows' matcher (§2): every word must hit the title (the id, without one) or the title or summary of a current deliverable. `workflow` keeps the jobs with a recorded run of that workflow (a job from before its runs were recorded on it never matches). `mine=1` keeps the jobs whose `actors` include the request's actor — `actor` in the response is who the server took the request to be from (`resolveActor`); absent, `mine` lists nothing |
| GET    | `/jobs/:id`                                            | the job read back: `{ job, title?, createdBy?, createdAt?, usedAt, busy?, workflow?, holds: [{ id, kind, since, note?, url? }], urls, repos, files, runs: [{ workflow, runId, at, parentRunId?, status, durationMs?, error?, sealed? }], sessions: [{ id, turns, …, busy? }], artifacts: [{ id, kind, title, summary?, url?, content?, runId, path? }], text?, claims? }` — `workflow` is what the job IS: the one its newest turn ran, `job` or `builder` (a run under the job of any other workflow is not a turn), the one `job/continue` launches next; `claims` is the job's ledger (§5.5), present only where the claims layer is on; `runs` newest first, `status` from the run's summary (without one, `running` while it executes and `stale` when a restart cut it off and it was not resumed — a thread turn the same); a run with a `parentRunId` is one a turn launched, not a turn; a sealed workflow's run shows `sealed: true` and nothing past its status. `holds` are what the job keeps alive beyond a run (`plans/jobs.md` §6), each with a `url` when what it holds has an address; `urls` is the first hold of each kind that has one (`{ pod: "https://…" }`). `sessions` are the threads made under the job (a turn line's `job`, §9) or named after it. `artifacts` are the job's CURRENT deliverables — its successful top-level runs' `artifacts[]`, newest first, the first of each `id` winning, resolved as `…/runs/:runId/artifacts` resolves them, each with the run that last reported it and, for a file, its `path` in the directory (what `job/read` takes); `text` is the newest such run's `output.text`. `threads` (`plans/jobs-sidebar.md`, `src/job-threads.ts`) is the job's execution as a tree: every agent execution in its runs' logs — a `step.end` carrying `messages`, or an attempt of the core `agent` step — grouped by session into `[{ id, session, label, startedAt, updatedAt, turns, totals: { turns, usage, cost, toolCalls, context? } }]`, each turn `{ runId, workflow, path, stepType, label, at, durationMs?, status, turn?, session?, usage?, cost?, context?, toolCalls, transcript?, artifacts?, nodeCount, nodes?, spawned, peer? }` — `transcript` the §5 link (`?full=1` for a session turn), `artifacts` the run's declared deliverables on its last top-level turn, `spawned` the threads the turn caused (a sub-agent under its path, a child run it launched, a `strut/run-workflow` peer run with `peer: { id, workflow, runId, status }`), a run with no agent one turn of `stepType: "run"`. Chronological at every level. `?threads=0` leaves it out, `?nodes=1` adds each turn's touched graph nodes, `?limit=N` bounds the runs the fold reads (newest first; `omittedRuns` counts the rest). 404 for an unknown job |
| GET    | `/jobs/:id/claims`                                     | `{ enabled, job, claims: LedgerClaim[] }` — the job's ledger alone (§5.5): what the work must deliver and whether it does, as of its newest turn. `{ enabled: false, claims: [] }` without the claims layer; 404 for a job not on file |
| POST   | `/jobs/:id/verify`                                     | `{ claims?: [<claim id>], detach?: boolean }` (gated) → `{ job, key, runId, subjects, checks: [{ subject, path, claimId, checkId, lastVerify }], evidence, slots, costUsd, claims: LedgerClaim[] }` — verify the job NOW against its newest turn (`runId`): every check on every claim about the job fires, `manual` ones included, and evidence on an already verified turn is appended, not skipped; the ledger comes back with each check's `lastVerify`. `claims` narrows to ids; no body is every claim. `detach: true` answers 202 `{ job, started: true }` at once instead — each check's evidence and the pass's end reach the job's `jobCallback` (`CALLBACKS.md` §5), the ledger is `GET /jobs/:id/claims` after; a detached verify while one runs joins it. 404 for a job not on file, 409 without the claims layer |
| GET    | `/jobs/:id/updates?since=&wait=&limit=`                | `{ job, cursor, reset?, more?, updates: [{ event: "job.update", job, at, runId?, kind, url?, id?, title?, state?, detail? }] }` — the job's LIVE UPDATES (`plans/live-feeds.md` §1): the same `job.update`s a `jobCallback` receives (`CALLBACKS.md` §5), kept whether or not one is on file, for a reader that cannot be called (an app's page; the `job/updates` step is the same read). The newest state of each thing (`kind` + `url` + `id`), in the order they last changed, at most 200 per job, in memory. `since` is the `cursor` the last read returned — or `now`, only what comes after — and absent reads everything kept; `reset: true` says the cursor could not be honored (another process's: the server restarted, or the job dropped things past it) and everything kept follows — read again what you show. `wait` (ms, at most 55 000) holds the call while nothing is new; once something lands it answers a second later with whatever else landed by then, so a reader that asks again on each answer makes at most a call a second. `limit` caps `updates` (`more: true`, read again from `cursor`). Answers for a job with no record yet (a reader may start before the first run); 400 for a malformed id |
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
| `run.start`       | first line; carries `input`, `workflowHash`, `stepHashes` (custom step versions), `params` / `paramOverrides`, `actor` / `principal`, `origin` (`schedule` / `verify` / `peer`), `peerPerson` (a peer run a person's credential launched, §3), `continues` (the conversation a person's turn continues under an id not their own, §3), `automation`, `callback: { origin }`, `mcp: [{ name, origin }]`, `attachments: [{ name, mediaType, size, path }]`, `parentRunId` when nested, `startedBy` (a job a turn started), `conversation` (the launch's, §3), `wakeAsked: true` (the launch asked for the wake, §3), `wake: { job, runId, peer?, also? }` (a wake turn: the job run it woke on) |
| `step.start` / `step.end` / `step.error` | one execution; `step.error` is final, after retries |
| `step.retry`      | an attempt failed and another follows |
| `step.skipped`    | not run: its `when` gate did not match, or every step it depends on was skipped |
| `run.end`         | terminal, success; `output` |
| `run.error`       | terminal, failure; `error` |
| `run.cancelled`   | terminal, cancelled |
| `run.cancelling` / `run.paused` / `run.resumed` | control markers (§6); not terminal. `run.resumed` reopens a log after a terminal event and carries `stepHashes`, `callback: { origin }` and `mcp` like `run.start`; a durable one also `workflowHash` (the version the run continues on) and, when it moved the run onto another version, `changed` |
| `step.replayed`   | on resume: a finished step's journaled `output`, not re-executed |
| `reply.delta`     | an `agent` step with `stream: true`: `{ path, call, text, reset? }`, a piece of the reply as the model writes it (schema mode: the answer's `text` field, from the `final_answer` call or the forced final-answer turn; no schema/finalAnswer: the assistant text), batched ~50 ms, `reset: true` when a new answer starts over what was said. Kept in the log; the events sink never sends it; UI panels and folds skip it. The SSE tail delivers an appended event within milliseconds. A consumer's rule: if a run ends with no `reply.delta` for the reply, use `output.text` |

`step.start.stepVersion: { version, hash }` records a pinned custom step's
version; `step.start.subflow: { workflow, version?, hash? }` the child a
subflow step resolved. Tool-call events inside an agent step have their I/O
truncated for the log; every other input and output is stored whole. A
step output over `STRUT_STEP_OUTPUT_MAX_BYTES` (8 MB as JSON) never reaches
the log: the step fails, its `step.error` naming the size, the cap and
where large data goes (a file under `ctx.services.artifacts`, its relative
path in the output); a tool call's result over it fails the call the same
way, the error text being the model's tool result.

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
| `{}`                  | resume a `stale`, `error` or `cancelled` run, on the version it executed |
| `{ "from": "<path>" }` | re-run a **successful** run from that step (it, its dependents and later iterations are dropped from the journal); `from` on a live run is a 409 |
| `{ "version": "active" }` or `{ "version": "v5" }` | resume onto THAT version, so a fix to the workflow reaches the run: every top-level step that changed between the run's version and this one (config, type, dependencies, `when`, options, a `params` default it reads; all of them when `settings` changed) re-runs with everything downstream, the rest replays. Combines with `from`. On a live run, a 409 |
| `{ "force": true }`   | resume even though the workflow's content changed since the run started and no stored version matches (with `version`: replay into it without comparing) |

Response: 202 `{ ok, runId, resumed: "journal", replaying: <n>, version?,
changed? }` (`version` when a stored version is what runs — the run's own
by its hash, or the one named; `changed` the top-level steps that re-run
because they changed in it). The log's `run.resumed` records the same
`changed` and the version's `workflowHash`, which a later resume goes back
to. 400 for a successful run without `from`, or a `version` that is not a
non-empty string; 404 unknown run or version; 409 when the log has no
`run.start`, when a resume is already in flight, when the workflow changed
and no stored version matches the run's hash (pass `force`), or when a
`version` is named and the run's own version is no longer on record (pass
`force`, or `from`); 413 when the
run's log is over `STRUT_RESUME_MAX_LOG_BYTES` (64 MB) — refused by its
size, never read (`{ error: "run log is 139.0 MB (…), over the 64.0 MB (…)
resume cap (STRUT_RESUME_MAX_LOG_BYTES) — not loaded" }`); boot-time
auto-resume skips such a run the same way.

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
| POST   | `/workflows/:name/automations/:id/fire` | run now → 202 `{ runId }`; 409 while its previous run is going; 503 while draining (§8.1) |

`GET /health` → `{ ok, dataDir, stepCount, workspace: { backend, path? }, drain? }` —
`backend` is `fs`, `neo4j` or `ladybug` (where workflows and steps live;
`STRUT_WORKSPACE_BACKEND`), `path` the LadybugDB file on `ladybug`, `drain`
present while draining (`{ since, reason, until?, idle }`, §8.1); without
the key, `{ ok: true }` and nothing else — the one route a keyless probe may
call.

### 8.1 Drain — a quiet moment to restart (`src/drain.ts`)

Before restarting strut — a new image, a backup — whoever runs it turns on
a DRAIN: nothing new starts, what is running finishes, and `idle` says when
nothing is left. Then it stops the process; the next boot starts undrained.

| Method | Path     | Description |
| ------ | -------- | ----------- |
| GET    | `/drain` | `DrainView` (below) |
| PUT    | `/drain` | `{ reason?, minutes? }` → `DrainView`. `reason` (≤ 200 chars, default `maintenance`) is said in every refusal; `minutes` (> 0, ≤ 1440) lifts the drain by itself, so one whose updater died does not refuse everything forever. A drain already on keeps its `since`. 400 on a bad body. A person's or the deployment's credential: a peer's is 403 |
| DELETE | `/drain` | lift it → `DrainView`. Wake turns it held back launch now |

```ts
interface DrainView {
  draining: boolean;
  since?: string;      // ISO, when it was turned on
  reason?: string;
  until?: string;      // ISO, when it lifts by itself
  idle: boolean;       // no run executing, no builder chat turn running, no public tool call in flight
  active: { runs: number; chats: number; tools: number };
  runs: { workflow: string; runId: string; state: string }[]; // the top-level runs it waits on (first 50)
}
```

While draining:

- **Refused, 503 + `Retry-After: 60`**, body `{ error }` starting
  `draining:`: `POST /workflows/:name[/:version]/run`, a durable
  `POST …/runs/:runId/resume` (unpausing a live run is let through), `POST
  /steps/:type/run` of a step that does not declare `effect: "read"` (a read
  still answers), `POST /chat`, an elicitation answer (the question stays
  open), Run now, and anyone's `POST /public/workflows/:name/run` and `POST
  /public/steps/:type/run` (§17.4, §17.6; a public call is refused whatever
  its step declares, and one in flight is waited on).
- **Refused in process**: every new top-level run whatever starts it — an
  agent's `job/start` / `job/continue` or `meta/run-workflow`, the builder's
  `run_workflow`, an app's `run/launch`, `strut.run()` — reads the same
  `draining:` error. A run a run IN FLIGHT launches (`parentRunId`, as
  meta/run-workflow sets) is that run's work and starts.
- **Held**: a schedule's fire launches nothing and records no failure (a
  missed fire is skipped, as always). A wake turn (`src/wake.ts`) stays queued
  on disk and launches when the drain lifts or at the next boot.
- **Not waited on**: a paused run (it waits on a person; a restart leaves it
  paused), the verify pass and the graph projection after a run (best
  effort).

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
| GET    | `/sessions?id=<id>` | that summary + `turnLog: [{ turn, at, workflow, runId, path, actor?, principal?, job?, attachments?, wake?, provider, model, routed, offset, count, usage, cost, context?, replayFrom }]`; 404. `attachments` = the files the turn's prompt carried, `[{ name, mediaType, size, path }]` under `runId`'s artifacts. `wake: true` = a turn strut ran because a job ended (`CALLBACKS.md` §9), not a person's. `replayFrom` is the thread index the NEXT turn replays from — 0 until a turn compacts the thread, then the index of its `[compaction]` message (plans/compaction.md); offsets stay absolute and the whole thread is still served |
| GET    | `/sessions/messages?id=<id>` | the thread, a bare array: the system message, then every message; 404 |
| DELETE | `/sessions?id=<id>` | `{ ok: true }`; 409 while a turn holds it |

400 for a malformed id; 501 when the host
injected its own `sessions` capability.

### 9.1 Conversations (`src/conversations.ts`; `plans/jamie-app.md` §2)

A conversation is a session whose turns are runs of a workflow with
`params.wake` (the seeded `orchestrator`). These routes read it as a person
does: a list, and each conversation's TURNS read back from their runs, never
the model transcript. Sending a message is still `POST
/workflows/orchestrator/run { input: { prompt, session } }`.

**Who sees what.** The viewer is the request's actor (`x-strut-actor` with
the key, or a person token's own). A conversation is listed for everyone who
took a turn in it (the launch's actor, else its principal), for the actor
its id is under (`<actor>/…`), and for anyone who opened it while it was
`shared`. Shared makes it readable to any actor on this strut, and puts it in
every actor's list (`team: true`, never unread) until they open it; taking a
turn makes you a participant. The key with no actor reads any conversation; a
plain peer reads the routes and sees none. A person token may also POST the
two writes.

**Who may continue one.** The key launches a turn on any id. A person's
token (§3) and strut's own app (§14.10) open the person's own ids
(`<actor>`, `<actor>/…`) as they are, and also a conversation the person
took a turn in, or a shared one, under whatever id it has (Hive's are
bare): the run records `continues: <id>` on `run.start`. Another person's
conversation is refused with `conversation_not_yours:` (a `403`, or the
step's error from the app's `run/launch`). Having opened it while it was
shared is not a turn. An id that is no conversation stays in the caller's
own namespace (`peer/<id>`, `app/<name>/<viewer>/<id>`), as before.

| Method | Path | Body | Response |
| ------ | ---- | ---- | -------- |
| GET    | `/conversations?q=&archived=1&limit=&before=` | | `{ conversations: ConversationListItem[], next? }`, newest first. `q`: every word in the title. `archived=1`: the archived ones alone (default: the rest). `limit` at most 200 (default 50). `next` is the `before` of the next page |
| GET    | `/conversations/item?id=&limit=&before=&wait=&since=` | | `ConversationView`; 404 when there is none, or it is not the viewer's to read. `limit` at most 100 turns (default 20); `before` a turn number (`next`); `wait` (ms, at most 55 000) holds until the conversation's `rev` moves past `since` (default: its rev now), so a turn launched, or one settling, answers it |
| POST   | `/conversations/update` | `{ session, title?, archived?, seen?, shared? }` | the viewer's `ConversationListItem`. `title` renames it for everyone (`""` gives back the first message's); `shared` for everyone; `archived` and `seen` the viewer's own. 404 |
| POST   | `/conversations/fork` | `{ session, id? }` | 201 the new conversation's `ConversationListItem`. A new session with the source's messages copied turn by turn, so the agent remembers, and its finished turns shown; listed for the forker alone. `id` defaults to `<actor>/<12 hex>`; a person token's must be under its own id. 404, 409 when `id` exists |

```ts
// One row of the list.
interface ConversationListItem {
  id: string;            // the session
  title: string;         // the first message (Hive's leading `@<workspace>` line left out), cut at 80; a rename replaces it
  createdAt: string;
  updatedAt: string;     // the last turn launched or ended
  turns: number;
  status?: string;       // the last turn's, once it ended
  shared?: true;
  forkedFrom?: string;
  archived?: true;       // the viewer's
  seenAt?: string;       // the viewer's
  unread: boolean;       // something happened since seenAt
  running?: true;        // a turn is in flight in this process
  jobs?: ConversationJob[]; // the jobs its turns started or continued, most recent first, at most 10
  moreJobs?: number;     // jobs past those listed
  team?: true;           // listed because it is shared, not the viewer's yet; opening it makes it theirs
  startedBy?: string;    // who took its first turn
}

// A job as a row shows it. A conversation keeps its job ids, read from each
// turn's log when the turn ends; one kept from before that has none until
// a list reads them, in the background (the next list shows them).
interface ConversationJob {
  job: string;
  title?: string;        // the job's record's
  running?: true;        // a turn of it is in flight in this process
  prs?: Array<{          // the pull requests its turns delivered (artifacts of kind `pull_request` with a GitHub link), newest first, each once
    url: string; title?: string; repo: string; number: number;
    state?: string;      // as the job reported it; the live state is `github/pr-status`'s (§14.11)
  }>;
}

interface ConversationView {
  conversation: ConversationListItem;
  participants: string[];   // who took a turn
  turns: ConversationTurn[]; // newest first
  next?: number;            // `before` for the older turns
  rev: number;              // `since` for `wait`
}

interface ConversationTurn {
  turn: number;             // 0-based, oldest first
  runId: string;
  workflow: string;
  at: string;               // when it launched
  by?: string;              // who took it
  status: string;           // success | error | cancelled; while not settled running | paused, stale when no process runs it
  prompt?: string;          // the person's words (input.prompt) — absent on a wake
  wake?: { job: string; runId: string; peer?: string; also?: unknown[] } | true;  // a wake turn: the job run it woke on (run.start.wake)
  delivered?: Array<{ job: string; runId: string; workflow: string; artifacts: ArtifactRef[] }>; // a wake turn: what each job run it woke on (on this strut) delivered, resolved as its run.end carried it
  attachments?: Array<{ name: string; mediaType: string; size: number; path: string }>; // `path`: read with `run/files` on the turn's run
  text?: string;            // the reply
  ask?: string;             // its question
  artifacts?: ArtifactRef[]; // resolved, as GET …/runs/:runId/artifacts
  error?: string;
  proposals: ProposalBrief[]; // as run.end carries them (§12)
  jobs: Array<{ job: string; runId: string; workflow?: string }>; // what it started (job/start) or continued; `workflow` the run's (job, builder), absent on a continue logged before job/continue returned it
}
```

A turn that failed is listed with its error: turns are recorded when they
launch and end, not only when the agent's session commits. The
`conversation/list`, `conversation/get` (`wait`, `since`),
`conversation/update` and `conversation/fork` steps are the same reads and
writes, as the step's actor; they are refused to an app's page, except
strut's own (first-party, §14.10), which reads them as its viewer's
person token does. `conversation/list` also answers `viewer`, the actor the
list is for — where a page mints a new conversation, `<viewer>/<id>`.

### Graph nodes

| Method | Path | Response |
| ------ | ---- | -------- |
| GET    | `/graph/types` | `{ types: [{ type, parent?, domain?, description? }] }` — the graph's node types, sorted, strut's own (`Strut*`), `Thing` and `Schema` left out: the package page's typeahead for Graph types. 501 on a deployment with no graph |
| GET    | `/graph/nodes/:ref_id` | `{ ref_id, node_type, name, properties }` — the node as the graph holds it NOW (vectors and internal stamps stripped); 404 when it is gone; 501 on a deployment with no graph |
| GET    | `/graph/changes?types=&since=&wait=&limit=` | `{ cursor, reset?, more?, changes: [{ kind: "node" \| "edge", op: "created" \| "updated" \| "deleted", ref_id, at, node_type?, edge_type?, source?, target?, types? }] }` — the graph writes made THROUGH STRUT after a cursor (`plans/live-feeds.md` §3; the `graph/changes` step is the same read): every run's, a proposal's apply, an app's — the latest per node or edge, the deployment's last 5 000, in memory. Ids, types and time only; read what changed with the reads you already make. `types` (comma-separated, case-blind) keeps nodes of those types and edges with an end of one (an edge's `types` are its ends', where strut could read them; an edge with none passes). Strut's own types (`Strut*`, `Claim`, `Check`, `Evidence`, `Thing`, `Schema`) are never in it; neither is a write through raw Cypher or by another process. `since`, `wait`, `limit` (at most 500), `reset` and `more` as `GET /jobs/:id/updates`. 501 on a deployment with no graph |
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

Strut serves three tool sets over the Model Context Protocol (Streamable HTTP,
stateless; `src/ai/mcp.ts`), for an agent outside strut — Claude Code, Hermes,
any MCP client:

| Door | Tool set | For |
| ---- | -------- | --- |
| `POST /mcp` | **assistant** (`src/ai/assistant-tools.ts`): nine tools — talk to the workflow builder, read its chats, list workflows and runs, read a run, run a workflow, search the package store and read a package's page | an agent with its own connectors that wants workflows built, run and shared, and should not learn strut's YAML; the default |
| `POST /mcp/builder` | **builder**: the SAME tools the builder chat's model gets — `list_steps` … `create_workflow` … `run_workflow` … `get_run`, the `app_*` steps, the `package_*` reads and the text editor, with their descriptions, input schemas and capped results (`buildTools`, nothing reimplemented) | an agent that authors workflows itself |
| `POST /index/mcp` | **store** (`src/packages/index-tools.ts`; §16): three READ tools over a package INDEX's derived pages — `search_packages`, `get_package`, `get_concept` — nothing that installs | any agent, with NO credential: a strut with the index role is the store, and this is its face for an agent as `?store=1` is for a person (`claude mcp add --transport http strut-store https://<index>/index/mcp`). An agent that fetches URLs instead reads `GET /llms.txt` (§16): the same store as one markdown page |

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
| `search_packages` | `query?` (empty lists everything), `limit?` (30, ≤ 200) | §16's `PackageSearch` — `{ packages: [IndexHit & { index }], peers, errors }`, each hit with its `detail` (the apps, counts, secrets, `can`) — plus `install`: where a PERSON installs (the UI's Publish dialog, its Packages tab, or `<base>/?install=<name>`). The indexes this strut follows; none followed → empty lists, no error |
| `get_package` | `package` (publisher/name), `index?` | the package's page from the index that lists its publisher (§16's `IndexPackage` + `index`), as a model reads it: `detail.readme` cut at 12 000 chars, the Concept pages' `docs` left out; plus `ui` (`<base>/?install=<name>`, the Publish dialog's Packages tab on the name) and `install`. `{ error }` with the code first: `package_not_listed` (no followed index lists the publisher), `package_not_found` (listed, but no public catalog has it), `package_index_none` (this strut follows no index), `package_index_unknown` / `package_index_unreachable` |

`did` — what a turn changed, folded from the builder's tool calls by tool
name (`src/chat-view.ts`; never inferred from prose): `workflows: [{ name,
version?, action: created | edited | activated, ui? }]`, `steps: [...]`,
`runs: [{ workflow, runId, status, error?, artifacts?, ui? }]` (a detached run
and its later result are one entry), `automations: [{ workflow, id?,
summary?, next?, action: set | deleted }]`. The `instructions` the door hands
a client at `initialize` are ten lines: what strut is, ask for building and
debugging, read for status and links, how `wait` and polling work, that links
are shareable, never collect a secret's value, search the package store
before asking for an integration from scratch (installing one is the
person's act). Nothing notifies an MCP client: a caller polls with `wait`,
or `list_runs` with `since`.

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

A record (`src/proposals.ts`) is `{ id, step, input, rationale?, title, summary?, card?, approver?, status, createdAt, by, decision?, result?, reportedAt? }`. `title` is the step description's first sentence, or what the step's `describe` hook gave; `summary` is what that hook read at proposal time for the card (plans/proposals.md §7; `package/install` reads the package's page off the index this strut follows). `GET …/runs/:runId/proposals` and `run.end { proposals }` carry both.

**`card`** (optional; records from before it have none) is what a person
decides on, as data a host draws without knowing the step, computed ONCE at
proposal time (after `describe`) and stored on the record and on the brief:

```ts
card?: {
  v: 1,
  title: string,
  summary?: string,
  fields: { label: string; value: string; kind?: "text" | "code" | "markdown" | "ref"; danger?: boolean }[], // ≤ 12; value ≤ 500 chars
  actions: { accept: string; reject: string },   // button labels, e.g. "Install" / "Don't install"
  full: boolean   // true when `fields` cover everything that will run (nothing cut, nothing left out)
}
```

`title` / `summary` are `describe`'s, else the description's first sentence.
A step's `describe` may also return `fields`, `actions` and `full`; with no
`fields` the card is built from the input (`src/proposal-card.ts`): one field
per top-level key, strings as they are, anything else as JSON (`kind: "code"`
for objects and arrays), a value over 500 chars cut with `… (see full input)`,
the first 12 keys kept, `full: false` when anything was cut or left out;
actions `Accept` / `Reject`. The model's `rationale` is its own field, never
in `card.fields`. The job's `job.update { kind: "proposal" }` carries the
proposal's `title` and `state`, not the card (§CALLBACKS 6).

**Who may decide and see.** A full-scope credential (the deployment key, a
session) decides and sees every proposal, as before. A **person token**
(`peer:person`: a `strut-person` token, or a host's credential mapped by
`resolveScope`, its actor its own subject) may decide a proposal only when its
actor equals the proposal's `by.actor` (`403 { error }` otherwise; a proposal
with no `by.actor` is no person token's). `GET /proposals` and `GET
…/runs/:runId/proposals` list it only the proposals made in its own threads:
its actor's, whose `by.conversation` (else `by.session`) is `<actor>` or
`<actor>/…` — the conversations a person's own strut opens here. A
proposal shows where it was made: one from the same person's chat on the
host's key (a Hive conversation, its session the conversation id) is
answered there and never listed to the person's device. `GET /proposals/:id` answers it for ANY proposal on this strut —
it already reads every run's log here (a gated call's `step.start` carries
its input, its `step.end` the proposal's id) and every job's files by id, so
one rule holds for files, jobs and proposals (plans/proposal-links.md). The
plain `peer` scope decides none (`403`) and sees none, by id (`404`) or in a
list. A repeat decide is still `409` with the record.

**Only an admin accepts some** (`approver: "admin"`, plans/member-rights.md).
A step may say that only an ADMIN of this strut accepts a proposal of it
(`StepDef.approver`; `package/install` says it: installing a package is an
admin's act). The record and its brief carry `approver: "admin"`, copied
from the step at proposal time. An admin is a decider with full scope: the
deployment key, a key login, an admin's session (a ticket with `role:
"admin"`), a host's server holding the key (Hive decides with the swarm
key). Anyone else — a member's session through strut's own app, a person
token — gets `403 { error, proposal }` on `accept`, the error `admin_required:
only an admin of this strut server accepts "<title>" (<step>) — …`, and the
proposal stays as it was; they may still `reject` their own. A person token
names a person, never their role here, so it counts as no admin. The step's
word holds over a record from before it, and the record's over a step that
dropped it. A turn whose person is known NOT to be an admin is refused the
proposal itself — the gated tool call fails with `admin_required: <step> is
an admin's decision on this strut server, …` and nothing is recorded — since
a proposal shows only where it was made and nobody there could accept it:
a turn strut's own app launched for a viewer who is not an admin
(`AppRef.admin` unset), a peer's launch (a person token, another strut), and
a job's run or a wake that one of those started. A turn nothing says about —
a host's launch with the key, an automation — proposes as before, and the
decision decides.

`plans/proposals.md`. An `agent` step's `approve:` list gates registry
steps: a call to one is RECORDED (`<dataDir>/proposals/<id>.json`) rather
than run, and the person's accept runs it in code. The record (`Proposal`,
`src/proposals.ts`): `{ id, step, input, rationale?, title, status: pending
| accepted | rejected | applied | failed, createdAt, by: { workflow, runId,
path, job?, session?, conversation?, actor?, principal? }, decision?: { action, by?, at,
input?, reason? }, result?: { output?, error?, cost?, nodes?, at },
reportedAt? }`. `by.conversation` is the thread the work belongs to: the
session the root run's launch named, or, for a job's run, the session of
the turn that started it (`startedBy`). `input` is what the step's schema parsed at proposal time;
on accept it runs with `decision.input` merged over it. `reportedAt` is
when the proposing session was told (its next turn's `[proposal-result]`
lines).

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/proposals?job=&session=&runId=&status=&limit=` | `{ proposals: Proposal[] }`, newest first; `status` one of the five; `limit` a positive integer, applied after what the caller may see (a person token: its own) |
| GET    | `/proposals/changes?cursor=&wait=&limit=` | `{ cursor, reset?, more?, events: [{ event: "created" \| "decided" \| "applied" \| "failed", id, status, kind: "tool" \| "step", title, summary?, actor?, at }] }` — what happened to proposals after a cursor (`plans/live-feeds.md`, "Proposal feed"; the `proposal/changes` step is the same read), for a reader that would otherwise poll the list: one event per change, oldest first, never folded — `decided` is an accept or a reject (`status` says which), then `applied` or `failed`. The envelope only: title and summary cut at 200 chars, never the input, rationale, card or result — read the record by id. `actor` is the proposer on `created`, the decider after. Scoped like the list: the deployment key every event, a person token its own threads', the plain peer key none. The last 1 000 events, in memory. `cursor` (`since` also accepted), `wait` (at most 55 000) and `reset` as `GET /jobs/:id/updates`; `limit` at most 200 (`more: true`, read again from `cursor`) |
| GET    | `/proposals/:id` | one record (a person token: any, by its id); 404 |
| GET    | `/workflows/:name/runs/:runId/proposals` | `{ workflow, runId, proposals: [{ id, step, title, summary?, card?, approver?, status, url, rationale?, createdAt, decidedAt? }] }` — what the run proposed, the `run.end` field's twin (`CALLBACKS.md` §6) |
| POST   | `/proposals/:id/decide` | `{ action: "accept" \| "reject", input?: object, reason?: string }` → the record after the decision. `accept` merges `input` (one level) onto the proposal's, re-parses with the step's schema (400, still pending, when it does not fit), records the decision, runs the step under a minimal context (the decider — the request's actor — as `ctx.actor`, the proposing run's principal binding its secrets, its job, the registry), and records `result`. `reject` records `reason`, runs nothing. 403 `admin_required:`, still pending, for an `accept` of a proposal only an admin accepts (`approver: "admin"`) by anything but full scope. 409 with the record once decided (`failed` may be accepted again); 409 too, still pending, while a proposal its step waits for (`StepDef.after`: `meta/set-automation` waits for a pending `meta/publish-workflow` of its workflow) is pending; 400 for a step no longer in the registry; 404 |

A step that reaches past this strut — `strut/run-workflow`, another org's
strut — holds to the host's gate by any route: when a host delta's `approve:`
names it (`createStrut({ job, orchestrator, builder })`), it runs only as an
accepted proposal (`ctx.proposal`, set by the apply alone). A workflow step
(the builder's `remote` branch: `job/start { workflow: builder, peer }`, or
`meta/run-workflow builder` with `input.peer`), `meta/run-step` or another
agent's ungated tool is refused. No host gate: unchanged.

The steps `proposal/list` ({ job?, session?, status?, limit? } → the briefs)
and `proposal/get` ({ id } → the record) are the same reads for an agent.
Called from an app's page, or in a run an app launched, `proposal/list`
holds the list to the viewer's own, as a person token's. A page's own
`proposal/get` also answers `viewer: { admin }`: whether its viewer is an
admin here (`AppRef.admin`, §14.1), so a card shows "An admin must approve
this" in place of an Accept the decision would refuse. `proposal/decide`
({ id, action: "accept" | "reject", input?, reason? } → the record after the
decision) is the decide route for strut's own app (§14.10): it runs only as
a first-party page's own call, decides only its viewer's proposals, accepts
one only an admin accepts only when the viewer is an admin, and an agent
never runs it.

## 13. Sessions — a browser signs in

The key is a deployment secret; a browser facing the internet should hold
something shorter-lived. The login trades the key for an HttpOnly cookie the
page cannot read, signed under the same secret as a file token
(`STRUT_API_KEY`, else `STRUT_SECRET_KEY`) and stateless like one: no store,
and rotating that secret ends every session.

| Method | Path            | Description |
| ------ | --------------- | ----------- |
| POST   | `/auth/session` | `{ key, actor? }` or `{ ticket }` → 200 `{ actor?, exp, role? }` + `Set-Cookie: strut_session=…; Path=/; Max-Age=…; HttpOnly; SameSite=Lax[; Secure]`. Open to anyone (it IS the login); a wrong key is a `401` after half a second; `400` with no key configured. `actor`: who is signing in, ≤ 120 chars. A `ticket` (below) sets the same cookie naming the ticket's actor and `role` — an `actor` beside it is ignored; one expired, already used, forged or malformed is a `401 { error }`. The key login names no role |
| GET    | `/auth/session` | `{ actor?, exp, role? }` of the session the request carries — `role` the ticket's (`admin` \| `member`), none for the key login; `404` for a request the key authenticated |
| DELETE | `/auth/session` | clears the cookie → `204`; needs no credential |
| POST   | `/auth/ticket`  | `{ actor, role? }` → 200 `{ ticket, expiresAt }` (`cache-control: no-store`): a SIGN-IN TICKET for that person. `full` scope only — the deployment key, its session or an admin's, or strut's own in-process request; a peer key, a person token or a member's session is `403`, no credential `401`. `actor` required, ≤ 120 chars, no line break (`/peers/tokens`'s rule); `role` `"admin"` or `"member"`, **a member when left out** (§13.1); `400` otherwise, and with no key configured. `expiresAt`: ms since the epoch, a minute out |

`exp` is the session's end in ms since the epoch — `STRUT_SESSION_HOURS`
(default 12) from the login. `Secure` is set when the request came over
https (directly, or `x-forwarded-proto: https`).

A request carrying a valid cookie from the key login, or an admin's ticket,
is the key's equal — every route, `full` scope, never more — and its
`actor` is stamped on what it launches and
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

### 13.1 A host signs one person into the UI it frames

The standalone twin of mcp's `/mint-token` JWT handed to `/lab/?key=`: a
host that frames strut's own UI for its people (stadeum) never puts the key
in a browser. Its SERVER, holding the key, mints a ticket for the person —
the actor is the host's to name, an opaque string strut stamps on what the
session does — and frames the UI with it:

```bash
curl -s -X POST https://strut.acme.com/auth/ticket \
  -H "authorization: Bearer $STRUT_API_KEY" -H 'content-type: application/json' \
  -d '{"actor":"evanfeenstra-cm3k9x","role":"member"}'
# → { "ticket": "strut-ticket.eyJhY3Rvci….3q2…", "expiresAt": 1793813291223 }
# frame: https://strut.acme.com/?ticket=strut-ticket.…&app=strut%2Fjamie&solo=1&theme=light
```

The ticket is `strut-ticket.<base64url claims>.<hmac>`, claims `{ actor,
role, exp, jti }`, signed under the session's secret. It lives 60 s and trades
ONCE: a redeemed `jti` is remembered in memory until it expires (a restart
forgets them). Mint one per page load.

The UI, loaded with `?ticket=`, posts it to `POST /auth/session { ticket }`
(with `x-strut-ui: 1`) before any other request, takes `ticket` off the
address bar with `history.replaceState` — every other param (`app`, `solo`,
`wf`, `run`, `embed_origin`, `input`) kept as written — and carries on
signed in as that person. The ticket wins: a key or a session the browser
held before is dropped either way. Refused, the page says the sign-in link
expired and to reload from the host — never the Settings → Connection key
prompt — and so it does when that session later ends.

**Admins and members** (`plans/member-rights.md`). The ticket's `role` is
the host's own word for the person: an **admin** runs the box, a
**member** uses its apps. The session keeps it (`GET /auth/session` says
`role`). An admin's session is the key's equal, the operator console
included. A member's is scope `member`: it is not the key's equal
anywhere — not at the gate, not on a route's own key check, not on the
dictation socket — and the gate passes it exactly what strut's page calls
to show an app alone (`?app=<name>&solo=1`):

| Route | For |
| ----- | --- |
| `GET /auth/session` | who is signed in, and as what |
| `GET /apps`, `GET /apps/:name/versions` | finding the app; the side panel's versions |
| `GET /apps/:name/:version/files[/…]` | the document; the listing mints the app's identity |
| `GET /brand` | the style the app is shown in (§14.12) |
| `POST /mcp` | the page's calls: `step_run` alone, run as the member under the app's grants, as a person token gets (§14.3); `GET` / `DELETE /mcp` answer 405 |
| `POST /apps/:name/channel-ticket` | the app's channels (§14.11) |
| `GET /artifacts/:runId[/…]`, `GET /jobs/:id/files[/…]` | a file the app hands the side panel, under §13's file rule |

Every other route is `403` — reads included, and a route a host mounts
later. What is open to anyone stays open (`GET /health`, which tells a
member `{ ok: true }` alone; `/auth/session`; a `?t=` file token; a
channel ticket; `/public/*`). A member who opens strut directly gets the
list of the apps here, strut's assistant first, each opening alone — never
the console; `?app=…` and `?artifact=…` open alone for a member with or
without `solo=1`. A ticket with no role, including one minted before
roles, signs in a member: a host that does not say signs nobody in with
the console. It is not a sandbox: what a member's apps can do (Jamie
starts a builder job as them), the member can — except what only an admin
accepts: installing a package (`package/install`, `approver: "admin"`, §12)
is an admin's decision whichever door it comes through, so a member's
Jamie neither proposes one nor accepts one, and tells them to ask an admin.

**Same site only.** The cookie is `SameSite=Lax`, so a framed page gets it
only when strut and the page framing it are SAME-SITE — `strut.acme.com`
framed by `acme.com` (or `app.acme.com`). Framed by another site, the
browser neither stores nor sends the cookie: the trade spends the ticket,
and the next request is a 401. Serve strut from a subdomain of the host's
own site.

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
| GET    | `/apps/:name/grants` | `{ name, grants: [{ workflow, at, by?, proposal? }] }` — the SEALED workflows a person granted the app (§14.8), by its name: an app need not be published yet |
| POST   | `/apps/:name/grants` | `{ workflow }` → 201 `{ ok, name, grant }`: a person grants the app a sealed workflow (the assistant, `orchestrator`); the actor is `by`. `404` for a workflow that is not there, `400` for one that is not sealed (a manifest grants that itself) |
| DELETE | `/apps/:name/grants?workflow=<name>` | take a grant back → `{ ok, name, workflow }`; `404` when there was none. The published versions keep naming it, and their calls to it are refused |
| DELETE | `/apps/:name` | remove the pointers (soft on the graph); the directories stay; the app's grants go |

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
| `run/*` | only on a workflow in `grants.workflows` (`job` on `run/list` filters them); a sealed workflow refused by name — unless a person granted it to the app (§14.8): then the page reaches only the runs the app launched for the same viewer |
| a `job` in any config | the APP's job: a page's `library` is kept as `app/<name>/library` (an id already there is left as it is), so a page never launches under, uploads into or reads a job it did not start; `job/list` lists only the app's (`prefix` narrows inside it) |
| any other type | only when `grants.steps` names it (globs as `agentTools` takes them) |
| `llm`, `agent`, `exec`, `acp/prompt` | refused whatever the manifest says — the workflow is the unit of spend (§5.1): a paid or shell-shaped step runs inside a workflow the app launches |
| a sealed step | refused |
| a graph write (`graph/create-node`, `edit-node`, `create-triplet`, `create-batch-triplet`, `delete-edge`, `edit-edge`, `delete-node`, `move-node`) | refused on a type the manifest's `data.graph.types` does not declare, and on a type strut keeps whatever it declares — the type from the config for a create, the node read first for an edit or delete by `ref_id` (case-blind); every value checked must be a literal, an edge is located by its endpoints |
| `job/upload`, `job/delete-upload`, `job/get`, `job/read`, `job/list` | only when `grants.steps` names them |
| `sqlite/*`, `automation/*` | "not available in this strut yet" (work items 3, 7) |
| `graph/create-schema`, `graph/register-namespace`, `graph/project`, `app/init`, `app/checkout`, `app/build`, `app/publish`, `app/pin`, `app/grant`, `job/dir`, `job/start`, `job/continue` | not a thing a page does (a page runs a workflow in its own job with `run/launch { job }`) |
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

**`admin`.** When the connection holds full scope — the deployment key, a
key login, an admin's session — the door also sets `ctx.app.admin: true`
(`AppRef.admin`): the viewer is an ADMIN of this strut (§13.1, "Admins and
members"). A member's session and a person token never get it, nor does a
visitor. Like `firstParty` it is set by the door alone and carried by every
run the page launches, so a turn knows whether its person may accept what
only an admin accepts (§12, `approver: "admin"`).

### 14.2 The `run/*` steps (`src/steps/lib/run/`; `plans/apps.md` §5)

Runs as steps, unsealed — what the kit's hooks name, grantable to an agent
as `agentTools: ["run/*"]`, and the §3 … §7 routes' layers one more way
(`ctx.services.runs`, `src/runs.ts`). A sealed workflow is refused by name.

| Step | Config | Result |
| ---- | ------ | ------ |
| `run/list` | `{ workflow, limit? (50, ≤ 500), status?, since? (ISO or ms), automation?, job? }` — or `{ job, … }` with no `workflow`: a job's runs across every workflow it ran, off its record | the summaries newest first, without `input` / `output` / `stepCounts`, each with `artifacts` resolved (§5); a run in flight has a live status. `since` is when a run was LAUNCHED (its id; a resumed run keeps its first launch), and a workflow's list stops at the first run before it. One call reads at most the newest 1 000 runs (`RUN_LIST_SCAN_MAX`): a filter that matches nothing among them answers `[]` |
| `run/get` | `{ workflow, runId, wait? (ms, ≤ 55 000) }` | the summary whole + `artifacts`; in flight, the partial summary (`partial: true`) after holding up to `wait` |
| `run/events` | `{ workflow, runId, skip? }` | the log as `GET …/events` serves it (transcripts as links, long fields replaced by their size), cut at 5 000 keeping the head and the last event |
| `run/transcript` | `{ workflow, runId, path, full? }` | `{ path, messages, full?, truncated? }` — one agent's session by step path, the bare array `GET …/transcripts/<path>` serves (a page cannot follow that link); `full` = `?full=1`, a session turn's thread (`full: true` when stitched). Cut at 2 MB of JSON: long strings to head + tail (64k, 16k, then 4k chars), then messages left out after the system prompt and the task; `truncated: { chars, strings, stringMax, messages?: { at, count } }` says what went. No transcript at the path, or a session gone, is an error with the route's 404 message |
| `run/launch` | `{ workflow, input?, params?, job?, title?, key?, attachments?, conversation? }` | `{ runId }` at once (detached, like `POST …/run`; `params` may narrow a grant, never widen it, and may add to an `approve` list, never take from it); with `key`, the run of this workflow still in flight under the same key: `{ runId, existing: true }`. `attachments`: `POST …/run`'s (§3: `[{ name, mediaType?, data }]`, at most 10, 10 MB each, 5 MB an image, 15 MB together), saved under the run's artifacts as `attachments/<name>` and on each agent's prompt, never in `input`. `conversation`: `POST …/run`'s (§3), the conversation a JOB turn (`job`, `builder`) belongs to, so strut wakes it when the turn ends — strut's own app only, and only a conversation its viewer may continue (their own `<actor>/…`, one they took a turn in, a shared one: §9.1; else `conversation_not_yours:`) |
| `run/cancel` | `{ workflow, runId, force? }` | `{ ok: true, runId, state }`; a run that is not live is an error. `force: true` is `POST …/cancel { force: true }` (§6.1): it abandons a step that never returns |
| `run/workflow` | `{ workflow }` | `{ name, description?, category?, activeVersion?, input? (the \`input:\` block), params?, peer? }` |
| `run/files` | `{ workflow, runId, path }` | `{ path, mediaType, bytes, text }` or `{ …, base64 }`, cut at 2 MB (`truncated: true`) — the job's directory for a job run, else the run's artifacts |

**Files from a page** (plans/apps.md §12). A page can open no connection,
so its files ride `step_run` as base64, a third larger. A file for one run
goes with the launch: `run/launch { attachments }`. A file for many runs, or
for an agent's thread, goes into one of the app's jobs (above: the page's
`library` is `app/<name>/library`):

| Step | Config | Result |
| ---- | ------ | ------ |
| `job/upload` | `{ job, name, mediaType?, data }` — `data` base64 or a data URL, at most 10 MB | `{ job, path, name, mediaType, size }`: saved at `<job's directory>/uploads/<name>`, a taken name numbered (`notes-2.txt`), never overwritten; the job is made when there is none. Takes no hold and is never kept as a run (its input is the bytes) |
| `job/delete-upload` | `{ job, path }` | `{ job, path, removed }` — only a file under `uploads/`; `removed: false` when there was none |

A run launched under the same job (`run/launch { job: "library", input:
{ file: "uploads/notes.txt" } }`) finds the file at that path in the folder
`job/dir` returns. `job/dir { hold: false }` hands the folder out without
holding it, so several runs that only read it run at once; a run that
holds it is still one at a time (`job_busy:`).

**Live, from a page** (plans/live-feeds.md). A page cannot be called, so it
follows what changes by asking and waiting — one call held on the server,
answered when something lands. Grant the step in `grants.steps`:

| Step | Config | Result |
| ---- | ------ | ------ |
| `job/updates` | `{ job, since?, wait? (ms, ≤ 55 000), limit? }` | `GET /jobs/:id/updates` (§5): the job's shots, frames, holds, verdicts, status lines and graph writes. The job is the APP's (its id kept under `app/<name>/`, like every job a page names), including the jobs its assistant starts; kit: `useJobUpdates(job)` |
| `graph/changes` | `{ types?, since?, wait?, limit? }` | `GET /graph/changes` (§9): the graph writes made through strut, whoever made them — what a page showing part of the graph reads again on; kit: `useGraphChanges(types)` → a `rev` to put in the reads' dependencies |

A run says what it is doing with `job/status { title }` (`job.update {
kind: "status" }`, one line per run).

### 14.3 Hosting an app (plans/apps.md §7.3, §7.4)

Strut's own UI is an MCP Apps host (`web/src/app-host.ts`,
`web/src/components/AppHost.tsx`), and any other host — hive, a portal —
is one the same way, with no strut change per host:

1. **Fetch the document.** `GET /apps/:name/:version/files` (the active
   version from `GET /apps`) mints the token; `GET …/files/dist/index.html?t=<token>`
   is the page with its identity written in. A host that shows apps as
   tabs takes the ones `GET /apps` marks `pinned`. Frame the TEXT as the `srcdoc`
   of `<iframe sandbox="allow-scripts allow-downloads allow-forms">` — an
   opaque origin, never `allow-same-origin`, no `src` that carries a
   credential. Leave out `allow-forms` and no `<form onSubmit>` in the page
   works: the browser refuses the submission before it fires the `submit`
   event, so the handler never runs. With it a form still goes nowhere —
   the document's CSP says `form-action 'none'`. Not a `blob:`
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
   link (`?wf=`, `?run=`, `?job=`, `?app=` with its `input`, `?artifact=`)
   in place and anything else in a new tab. A theme change is a `ui/notifications/host-context-changed`.
   Strut's UI sends its brand in the host context too (§14.12).
   Strut's UI opens two of them BESIDE the page, in a side panel, rather than
   navigating away from it (below, "The side panel").
4. **Open it where a link says.** A deep link to an app is
   `?app=<name>&input=<the app's own query string>` (the kit's
   `appLink(name, input)`): read `input` back as flat strings —
   `input=view%3D%252Fruns%26run%3D12` is `{ view: "/runs", run: "12" }` —
   and send it as `ui/notifications/tool-input` after the page's
   `ui/notifications/initialized`; a later link to the same app sends the
   new input in place. Carry it as one param of the host's own URL and
   never read inside it: the keys are the app's.

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
button, answers no `ui/message`, and opens in place only a link to an app
on that peer (`?app=<name>` from its page is `@<peer>/<name>`) or a file the
peer serves (`?artifact=<path>` from its page is `/peers/<peer><path>`),
both in the side panel.
With `&solo=1` beside `?app=` (any app, here or a peer's) the UI renders the
page ALONE, nothing of strut's around it — what a native host such as Peel
opens in a web view of its own: `/?key=<the local strut's key>&app=@<peer>/<name>&solo=1`,
with `&input=` for a deep link. `&theme=light` (or `dark`) is the theme the
page hands the app, for a host whose own page is light; without it the app
is shown dark, as strut's UI is. The page behind it matches from its first
paint, before a `ticket` is traded, and so does the app's loading screen;
strut's own bar over the side panel and its file viewer stay dark. A host
that passed `&embed_origin=` is posted `{type: "strut:ready"}` once, when
the app's page is on screen (it initialized, or loaded without the apps
SDK) or the page says why it cannot be (no such app, a refused ticket): a
host keeps its frame hidden until then and fades it in, so strut's page
behind the app never flashes. A link the page opens to itself changes
`input` in place, the URL following (replaced, as the full UI does); a
file or another app opens in the side panel inside the page (below); any
other link opens in a new window.
Alone, the page reads only the listing the app is in — `GET /apps`, or that
one peer's `GET /peers/<id>/apps` — then the app's files and its relay: no
workflows, step types or other peers (one that does not answer cannot hold
it at "Loading apps…"), and no `GET /runs/active` poll while it shows.
A key ending in `@vN` shows that version rather than the live one
(`?app=bench@v3&solo=1`, `?app=@acme/hive/ui@v2&solo=1`), the pin an app
import takes — how `app/look` sees a held app's draft. A version the app
does not have reads as no app. A key ending in `@preview-<12 hex>` is an
unpublished build `app/look { path }` hosts (`apps.preview`: built under
a publish's checks, held in memory for an hour, no version recorded); no
listing holds one, so the page reads none, and its files are served at
`/apps/<name>/preview-<hex>/files[/…]` exactly as a version's are, its
file token and identity `app:<name>@preview-<hex>` with them. `step_run`
checks its calls against the preview's own manifest and the usage
monitor does not count them.

**The side panel** (`plans/jamie-app.md` §4; `web/src/components/AppWithPanel.tsx`,
`panelTarget` in `web/src/app-links.ts`). An app's document frames
nothing (`frame-src 'none'`) and `run/files` returns 2 MB at most, so an
HTML page an agent wrote, another app, a PDF or a video cannot show inside
it. The page hands such a thing to its host with `ui/open-link`, and
strut's UI — in the canvas area and alone (`&solo=1`, which is how Hive
and Peel frame an app, so the panel is inside that one page) — opens two
deep links in a panel BESIDE the page, which stays on screen with its
state:

| Link | The panel shows |
|---|---|
| `?artifact=<path>` | the file through the artifact viewer, as "One file alone" below reads it: `path` must be a served file (`isServedFilePath`: `/jobs/<job>/files/…`, `/artifacts/<runId>/…`, either behind `/peers/<id>` hops), else the link is not the panel's. A page this strut serves runs its scripts under its file token (`?t=`, the one credential a file URL carries; a strut with no secret to sign one falls back to `?key=`, as the viewer does everywhere); a peer's is read with the UI's credential and shown from its bytes, scripts off, no credential in any URL. |
| `?app=<key>&input=…` | another app (`@<peer>/<name>` a peer's, a key may pin `@vN`) under a bar with its title, opened with `input`. A link to the page on screen is not the panel's: its input goes to it in place, as before. An app of this strut with more than one version, or held at a release, gets a chip on that bar (`v3 · draft`, `v1 · live · 2 drafts`) listing its versions (`GET /apps/:name/versions`): a click shows that one in the panel. Viewing only: making a version live is the full UI's Versions flyout, or a host's own admin page over `PUT /apps/:name/active`. |

A new link replaces what the panel shows (a link to the app already in it
is its new input, in place); ✕ closes it; its left edge drags its width,
kept in that browser; in a container narrower than 760 px it lies over the
page. Links from the app in the panel route the same way — a file or a
third app replaces it, a link to the page beside it is that page's. Every
other link (`?wf=`, `?run=`, `?job=`) is followed as before: the full UI
navigates, the page alone opens a new window. The panel is not in the
address bar (a reload closes it), and a visitor's page (`&public=1`) has
none. The kit's `appLink(name, input)` builds the app link; a file's is
`?artifact=<encodeURIComponent(path)>`.

**The store front** (`plans/marketplace.md` §7; `web/src/components/Store.tsx`,
`web/src/store-links.ts`). `?store=1` renders a third page alone: an index
strut's public face, for anyone with no credential — the apps across the
publishers it lists first (each app a package's face, off the derived
`detail`), then the packages, the Concept pages as a wiki (`?store=1&concept=<name>`,
the tree from `/index/concepts`), the publishers off the signed card, and
a package's page (`?store=1&pkg=<publisher/name>`: apps, the workflows
with their inputs and what each reaches, the steps with their secrets
and lint, the Concepts, the README, what it needs, the publisher's key,
the releases and channels). It reads only `/index/catalog`,
`/index/packages`, `/index/packages/:publisher/:name` and
`/index/concepts[/:name]` (§16), never with a credential; on a strut
without the index role it says so. Nothing on it installs: **Install into
your strut** is a link INTO the visitor's own strut —
`<their strut>/?install=<publisher/name>&index=<the index key>&index_url=<its catalog URL>`
— where the shell opens the Publish dialog's Packages tab, Find, on that
name, offers
to FOLLOW the index first when the strut does not yet (`PUT
/packages/indexes/:id` with the link's key, the id the index's host), and
installs on a tap through the followed card, so the key pinned is the
signed card's, never the page's. The visitor names their strut once
("Your strut", kept in that browser); with none the button asks, and the
name to paste is beside it. On an index strut the UI's root redirects a
visitor with no credential there (§16, `GET /`).

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
instead. `solo` is read once and stays in the URL; without it a page's
load ignores `artifact` — what a hosted app's `ui/open-link` to it opens
is the side panel (above).

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
a field (an attribute of the type, `ref_id` or `created_at`, whose old name
`date_added_to_graph` is still accepted) to a
value (equal; `null` = not set) or to operators that must all hold: `gt`,
`gte`, `lt`, `lte`, `in`, `contains` (a string field, case-blind). The
default order is newest first; `limit` is 1–500 (default 50); a `cursor`
comes back while there are more. It works on both engines, over any type
the graph holds.

### 14.8 The assistant in an app — a sealed workflow a person grants (`src/apps/grants.ts`)

An app whose chat is the person's assistant grants `orchestrator` in
`grants.workflows` and uses the kit's `useAssistant()`. The orchestrator is
SEALED, so a model's publish (`app/publish`) naming it is refused until a
PERSON grants it to that app, by name, once:

- **On a proposal.** The orchestrator holds `app/grant { name, workflow }`
  behind `approve:` (its template); a call becomes a proposal (§12), the
  card Hive's Jamie chat and Peel's DM draw, and on accept strut records
  the grant with the decider as `by` and the proposal's id. `app/grant` run
  any other way — a direct tool call, `meta/run-step`, a DAG step — throws.
- **Through `POST /apps/:name/grants`**, or a person's own `POST /apps` (a
  package install among them) whose manifest names a sealed workflow.

Every later version keeps the grant while its manifest names the workflow;
nobody who opens the app is asked anything. With it, the `run/*` steps
open the workflow to the app's pages SCOPED: `run/list` lists, and
`run/get` / `events` / `files` / `transcript` / `cancel` reach, only the
runs the app launched for the same viewer (another's is not found), and a
`run/launch` `key` dedupes within that viewer's launches. A run an app
launched (`origin: "app"`):

- opens its agent sessions under `app/<name>/<viewer>/` — its `input.session`
  is the viewer's thread in that app, never their conversation in a host or
  another viewer's (the run's own job id opens as it is);
- starts its jobs (`job/start`) under `app/<name>/`, and `job/continue`
  continues only those — where the page reads them;
- leaves out every tool its agent's `approve:` gates (graph writes): nothing
  shows an app turn's proposals, and a page must not decide them;
- carries no MCP servers (a page's call has none).

### 14.9 Channels — live messages between an app's viewers (`src/channels.ts`; `plans/app-channels.md`)

A channel is a short in-memory log of JSON messages named by an app and
shared by every viewer of it (every version; a preview has its own). The
page connects nowhere: its HOST holds one WebSocket per open page and
relays it to the page over the MCP Apps bridge. Nothing is kept — no run,
no log line — and a restart empties every channel. Built: the service,
the ticket and the socket below, the bridge methods, the kit's
`useChannel`, strut's own UI as a host, the steps below, and the peer
relay.

**The steps** — for code an app runs (`ctx.app`: a step its page called, a
workflow it launched); refused without it, and refused from a page (a page
uses its host's socket):

| Step | Config | Output |
| --- | --- | --- |
| `channel/send` | `{ channel, data, key? }` | `{ cursor }` — stamped `{ actor?, code }`, `code` the workflow's name or the step the page called |
| `channel/read` | `{ channel, since?, wait? (≤ 55 000 ms), limit? }` | `{ cursor, reset?, more?, messages, members }` |
| `channel/derive` | `{ scope }` | `{ channel }` — `HMAC(per-app key, scope)`, 32 hex characters, nothing stored |

**A ticket** — what a browser host opens the socket with, since a browser
cannot set a header on an upgrade:

```
POST /apps/:name/channel-ticket        { version: "v3", peer? }     (the key or a session; x-strut-actor = the viewer)
→ 200 { ticket: "strut-channel.<claims>.<hmac>", exp: <ms> }
```

The host names the app and version it is showing; the viewer is the
request's actor (Hive: the member, with the swarm key). A ticket lives a
minute (`CHANNEL_TICKET_MS`) and opens only `GET /channels`; the socket
outlives it. 400 without `version`, 404 for a version this strut does not
hold, 403 for any peer credential. With no secret to sign under (dev mode,
the gate open) the ticket is unsigned and taken at its word.

**A peer's app** (`?app=@<peer>/<name>` in strut's UI): the ticket names
`peer`, a peer on file (404 otherwise; the version is the peer's to check),
and the socket it opens HERE is piped to the peer's `/channels?app=<name>@<version>`
with the peer record's token — a person token, so the peer stamps the
person — and its CA. A clean close is passed on as clean; anything else
ends the peer's side abruptly, so it keeps the place while the host comes
back (`?client=` rides along). What the peer refuses (a version it does
not hold, a strut's credential) reaches the page as an `error` frame and a
1011 close. One hop.

**The socket** — `GET /channels` (WebSocket; plain HTTP is a 426). Through
`strut.upgrade` like `/rooms` (§10), so a host that owns the server routes
`<basePath>/channels` to it (mcp: `/lab/channels`). One credential:

| Who | How | |
| --- | --- | --- |
| a browser host | `?ticket=<ticket>` | the ticket's viewer and app; a ticket strut cannot vouch for is a 401 even beside another credential |
| a server (the peer relay) | its credential in a header + `?app=<name>@<version>` | a person token, or the key with `x-strut-actor`; a plain peer key is a 403 |
| a host coming back after a drop | either, plus `?client=<the client id it had>` | the same viewer within 10 s keeps its place: no `left`, no `joined` |

A `?ticket=` never reaches the request log (`ticket=…`).

**Frames** are JSON, one per WebSocket message.

| Direction | Frame |
| --- | --- |
| host → strut | `{ op: "join", channel, since? }` — `since`: the cursor of the last frame it saw, to get what it missed |
| host → strut | `{ op: "leave", channel }` |
| host → strut | `{ op: "send", channel, messages: [{ key?, data }] }` — a batch goes whole or not at all |
| strut → host | `{ op: "joined", channel, client, cursor, members, messages, reset? }` — `client` is this socket's id; `messages` every state and the recent events (or what came after `since`; `reset` when that is gone) |
| strut → host | `{ op: "message", channel, cursor, message }` — the sender's own too |
| strut → host | `{ op: "presence", channel, joined? \| left? }` — a member `{ actor?, client, since }` |
| strut → host | `{ op: "error", channel?, error }` — a refusal naming its limit; the socket stays open |

A message as strut sends it: `{ from: { actor?, client? | code? }, key?, data, at }`
— `from` is strut's stamp, never what the page wrote. A message with a
`key` is a STATE and replaces that sender's last one with the same key
(no sender can replace another's); without, an EVENT. A channel name
follows the session-id format. Limits (`CHANNEL_*` in
`src/channels.ts`): 8 KB of JSON per message, 256 messages kept (events go
first), 16 keys per sender, 30 messages a second per sender in bursts of
60, 8 channels per socket, 1 000 per app, a channel with nobody in it gone
after 10 minutes. A socket that misses a ping (every 10 s) is closed; a
clean close (1000 / 1001) or a `leave` sends `left` at once and drops the
leaver's states.

**The bridge** — what a host and the page say over MCP Apps
(`@strut/kit/channels`). A host that carries channels says so in its
`ui/initialize` answer, `hostCapabilities.experimental["strut/channels"] =
{ v: 1 }`; without it the kit's `useChannel` reports `available: false`.

| Direction | Method | Params |
| --- | --- | --- |
| page → host (request) | `strut/channels/join` | `{ channel }` — the host opens its socket on the first one |
| page → host (request) | `strut/channels/leave` | `{ channel }` |
| page → host (request) | `strut/channels/send` | `{ channel, messages }` — refused before a join |
| host → page (notification) | `strut/channels/frame` | one of strut's frames above as it came, or the host's own `{ op: "status", connected: false, error? }` when its socket drops |

A host keeps one socket per framed page, mints a ticket for it, and when
it drops comes back with `?client=` and each channel's last cursor as
`since`. `relayChannels` in `@strut/kit/channels` does all of it for a
browser host, given `open(client?)` (mint the ticket, make the
`WebSocket`); strut's UI runs it for an app that lives here.

### 14.10 First-party apps — the apps strut ships (`plans/jamie-app.md` §3)

Names under `strut/` are strut's: no door but strut's seed publishes one
(`app/publish`, `POST /apps`, `app/look { path }`'s preview and a package
install all refuse it). A page is FIRST-PARTY when it is a `strut/` app at a
version strut seeded, shown to a person: the connection has an actor, and
it is not the public door (§17.3). The app door marks the call
(`AppRef.firstParty`, on `ctx.app` and on every run the page launches —
`run.start.app` says so), and the page acts with its viewer's own rights,
what their person token has, where §14.8's rules hold a model-written page:

| | A model-written page | A first-party page |
|---|---|---|
| A sealed workflow (the orchestrator) | only through a person's grant (§14.8), the runs this app launched for the viewer | no grant: the viewer's runs (`actor`), whoever launched them, and every turn of a conversation the viewer may read (one they are in, or a shared one) |
| Its runs' agent sessions | under `app/<name>/<viewer>/` | the viewer's own as they are (`<actor>`, `<actor>/…`), so they are conversations (§9.1), and a conversation the viewer took a turn in or a shared one (§9.1, "Who may continue one"); any other id under the app |
| Gated tools (`approve:`) in its runs' agents | left out | kept: the proposals are the viewer's, listed by `proposal/list` and decided by `proposal/decide` — one only an admin accepts (§12) only by a viewer who is one, and a turn of a viewer who is not proposes none |
| Job ids | under `app/<name>/` | the person's own, as they are |
| The wake (§3) | none: its turns are a relay | strut's: each turn asks for it (`wakeAsked`), so a job the turn starts wakes the conversation |
| `conversation/*` (§9.1) | refused | as the viewer's person token |

What stays the same: the manifest's grants, `llm` / `agent` / `exec` /
`acp/prompt` refused from the page, no authoring, nothing past the viewer.
With no actor (the deployment key alone) a `strut/` app is an app like any
other. An app that imports strut's components compiles them into its own
document, which runs on its own grants: rights belong to the document's
identity, never to the code in it.

### 14.11 `strut/jamie` — Jamie, the person's assistant (`plans/jamie-app.md` §5)

The app strut seeds beside `strut/views` (`src/apps/jamie/`,
`src/apps/jamie-seed.ts`): the viewer's conversations with the
`orchestrator` — the list by day, search, show more, rename, archive,
unread, and under each conversation its jobs and their pull requests —
each turn read back (§9.1), the composer (files, a model picker, "/" for a
Concept, the viewer's time zone in `context`), the jobs a turn started
(live while they run, their reply, deliverables, claims, captcha and pull
requests), the proposals it made, and what it made. First-party (§14.10).
`createStrut({ jamie: false })` or `STRUT_HOST_CONFIG`'s `jamie: false`
seeds nothing; `strut/assistant`, its name before, is removed at boot. A
host opens it as `?app=strut/jamie&solo=1`, a conversation as
`&input=session%3D<id>`.

What it calls, beyond §9.1, §12 and §14.2:

| Step | Config | Result |
| ---- | ------ | ------ |
| `llm/models` | `{}` | what `GET /llm/models` serves: `{ default, models: [{ name, provider, modelId, alias?, default, available, contextLimit?, pricing? }], listed, keyNames }` — every model aieo knows; `available` when the deployment's `STRUT_MODELS` lists it (`listed: true`), else when the provider has a key here, never the key; `pricing` is USD per million tokens, present only where the model's own rate is known: Maple's, Numes' and Token Factory's (aieo's tables), and every model bifrost's datasheet holds once the server has loaded it (`STRUT_MODEL_CATALOG`); `contextLimit` comes from the datasheet too, else aieo's table. The picker sends the choice as the turn's `params.model`, and a remembered choice no longer listed as none |
| `job/verify` | `{ job, claims?, detach? }` | `POST /jobs/:id/verify` (§5.5) as a person: every check on the job's claims (or `claims`) against its newest turn, `manual` ones too — the pass and the ledger, or with `detach` `{ job, started: true }` at once, the verdicts on `job/updates` (`evidence`, then `verify` done) |
| `job/evidence` | `{ job, claim, runId, supports, content, slot? }` | `POST /claims/:id/evidence { job, runId }` as a person: `asserted`, `by: person`, about that turn; `slot` answers a check waiting on a person's look. `{ ok, evidence, filled, subject }` |
| `github/pr-status` | `{ repo, number }` | the pull request on GitHub now, read with the viewer's own `GITHUB_TOKEN` (an actor secret, `PUT /actors/:actor/secrets/GITHUB_TOKEN`): `{ url, repo, number, title, state: open \| draft \| merged \| closed, author, head, base, headSha, body, mergeable, checks: [{ name, status: failed \| running \| passed \| skipped, url }], counts }`, checks failed first. Errors `github_unauthorized:`, `github_not_found:`, `github_rate_limited:`, `github_error:` |
| `github/merge-pr` | `{ repo, number, sha?, method? }` | merges it as the viewer — squash by default, else the first method the repository allows — at `sha`, the head the viewer saw: `{ merged: true, url, sha, method }`. Refused before merging when it is not open, is a draft, has conflicts (`pr_not_mergeable:`) or has commits past `sha` (`pr_head_moved:`); `github_unauthorized:` with no token for the viewer. Runs only as a first-party page's own call, or as a proposal a person accepted |

`job/verify` and `job/evidence` run only as a first-party page's own call
(never an agent's tool: an agent verifies with `meta/verify-job`) and only
on a job the viewer launched a run of (the record's `actors`); where the
claims layer is off they say so. The page's turn into a conversation is
`run/launch` of `orchestrator` with `input: { prompt, session, context: {
line, where, timeZone } }`; a new conversation's id is `<viewer>/<12 hex>`.
The page sends into whatever conversation `conversation/list` shows; a
person continues one they took a turn in, or a shared one
(`plans/jamie-app.md` §2.2), and a refused turn
(`conversation_not_yours: …`, someone who read it while it was shared) is
a plain notice. A captcha's answer
is a job turn, `run/launch { workflow: <the job's>, job, input: { prompt:
"[captcha-answer] {…}" }, conversation }`; so is a pull request's Fix, when
its checks failed (`prompt`: which checks, and the branch to push the fix
to). A pull request is one card per thread, at its newest mention; a job's
own card keeps its pull requests in sight while it is collapsed, unless the
thread shows them. A person's attached files show under their message: an
image as a thumbnail that opens large, a text file to read, the rest by
name, each read with `run/files` on the turn's run. The page reads any turn
of a conversation its viewer may read (one they are in, or a shared one),
whoever took it. Share puts a conversation in everyone's list
(`conversation/update { shared }`); a reply has Copy. A deliverable `strut/views`
draws shows in the thread; the rest is handed to the host as
`?artifact=<served path>` or `?app=<key>` (`ui/open-link`, §14.3).

### 14.13 `strut/knowledge` — the Concept tree (`plans/knowledge-app.md`)

The app strut seeds after `strut/views` (`src/apps/knowledge/`,
`src/apps/knowledge-seed.ts`), in place of Hive's org graph view: the
organisation's Concepts as an outline beside their graph, read-only. Roots are the Concepts
with `PARENT_OF` children and no parent, biggest tree first; a Concept in no
tree is listed under "Not in any tree"; a Concept with two parents is a row
under each. The main view is the graph (`NodeGraph` on `PARENT_OF` only, so every node
in it is a Concept) round the concept
picked in the outline, search or a link: each node's chip expands its
neighbours or collapses them again, and a click opens the concept in a panel — its
path, description, `docs` as markdown (`DocumentView`), parents and
children, `repo` and `file`. Search is
`NodeSearch` on `Concept`.
First-party (§14.10), so it reads as its viewer. `createStrut({ knowledge:
false })` or `STRUT_HOST_CONFIG`'s `knowledge: false` seeds nothing. A host
lists it from `GET /apps` (title `Knowledge`) and opens it as
`?app=strut/knowledge&solo=1`, a concept as `&input=concept%3D<ref_id>`;
each selection is reported back the same way (`ui/open-link` to the app
itself), so the host's address bar follows it.

Its grants are reads only: `graph/find` (every Concept, 200 a page),
`graph/graph-edges` (the edges among them, 1,000 `ref_ids` a call with every
Concept as `among`; past 5,000 Concepts the page says it read part of the
graph), `graph/graph-get-batched` (the selected concept, fresh),
`graph/graph-neighbors` and `graph/graph-search`. The same calls on a Neo4j
and a Ladybug file.

From the HISTORY (`plans/concept-history.md` §8 item 4), with one more read,
`history/read`, drawn by `strut/views`' `ConceptDiff`: a concept's panel has
**History** — `log { path: "concepts/<key>.md" }`, the page followed through
renames, each commit's change drawn from two `show`s, two commits compared —
and **Changes** over the graph is the tree between two moments, `diff { from,
to, path: "concepts" }`, from "1 day ago" to now by default; any time, date or
commit may be typed, and "Recent changes" lists the history's last commits on
`concepts`. With no history on the server (no graph, no `git`,
`STRUT_HISTORY=0`) both say so. There is no revert: a page may not write a
Concept (`reservedAppType`), so a person puts a page back through a
proposal an agent makes or through `graph/edit-node` outside the app.

### 14.12 Branding — the look every app here is shown in (`src/brand.ts`)

A page takes its look from its host: the kit's stylesheet reads the MCP
Apps style variables a host sends in `hostContext.styles.variables`
before its own defaults (`kit/src/styles/base.css`). Strut keeps one
brand per server and its UI sends it to every app it hosts (§14.3), here
or a peer's, published before the brand or after. No app is rebuilt: a
change shows the next time a page loads.

```
GET /brand          any credential
PUT /brand          full scope: { color?, colorDark?, radius?, font? }
```

Both answer `{ brand, styles }`. `PUT` replaces the whole brand: a field
left out (or `""`, `null`) is unset, and `{}` resets it (`styles: null`).
400 with `error` on a bad field, and nothing changes. Kept in
`<dataDir>/brand.json`, so it moves and is backed up with the data.

| Field | What | Sent as (light and dark) |
|---|---|---|
| `color` | `#rrggbb` (or `#rgb`): primary buttons, the selected item, focus rings | `--color-background-inverse`, `--color-ring-primary`, and `--color-text-inverse`: near-black or white, whichever reads better on it |
| `colorDark` | the color in the dark theme; `color` when unset (and the reverse) | the same, in the dark theme |
| `radius` | a length in `px`, `rem` or `em` (`0.5rem`) | `--border-radius-md` |
| `font` | a font-family list (`"Avenir Next", system-ui, sans-serif`). An app's page loads no font from the network, so only fonts the viewer's machine has render | `--font-sans` |

`styles` is what a host sends: `{ light: { variables }, dark: { variables } }`,
the standard names only. The MCP Apps client refuses a host context that
carries a name the spec does not list, so `--primary` or `--chart-1` can
never be sent this way. In the kit, the color is `bg-primary` /
`text-primary-foreground`, `ring`, and the sidebar's primary; the radius is
every `rounded-*`. An app that names a color of its own (`bg-blue-500`)
keeps it. A visitor's page (§17) is not branded: it has no credential to
read the brand with.

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

### 15.1 Speaking — text to speech (`src/audio/tts.ts`)

The other direction (plans/private-voice.md §3.3): Kokoro v1.0 through the
same sherpa addon, on CPU, in a worker thread of its own, one speech at a
time. 501 on a build without the addon.

| Method | Path | Body / reply |
| ------ | ---- | ------------ |
| GET    | `/audio/speak` | `{ available, modelDir, models }` — each `TtsModel` (`src/audio/models.ts`) with `installed` and `default`; `voices` is its voice table, `defaultVoice` the one a request that names none gets, `sampleRate` its rate |
| POST   | `/audio/speak` | `{ text, voice?, speed?, model? }` → mono 16-bit little-endian PCM, below |

`text` is what to say, not blank, at most 10,000 characters; `voice` a name
from the model's `voices` (`af_heart` by default; `af_`/`am_` American,
`bf_`/`bm_` British English, female/male); `speed` 0.5–2, 1 the voice's own
pace; `model` a `TTS_MODELS` id, `kokoro-en-v1.0` (the one there is).

A 200 is `content-type: audio/pcm`, `x-sample-rate: 24000`, `x-voice: <the
voice used>`, `cache-control: no-store`, and a body of raw samples with no
WAV header — the shape of Tinfoil's streaming TTS — written a sentence at a
time as Kokoro finishes each (sherpa splits where espeak-ng ends a
sentence), so a client plays the first while the rest is generated:

```bash
curl -sN -X POST localhost:3000/audio/speak -H "authorization: Bearer $STRUT_API_KEY" \
  -H 'content-type: application/json' -d '{"text":"Sure. The meeting moved to Thursday."}' \
  | ffplay -f s16le -ar 24000 -ch_layout mono -nodisp -autoexit -
```

400 for a body that is not `{ text: string, voice?: string, speed?: number,
model?: string }`, a blank or too-long text, an unknown voice (the error lists
the known ones) or model, or a speed out of range; 500 when the model fails
before the first sentence. Once the first sentence is sent the status is
too: a later failure ends the body early (logged).

A model not on disk is downloaded on first use (350 MB, sha256-checked, into
`STRUT_MODEL_DIR/tts/<id>`), and the first speech after a start loads it
(0.3–0.7 s); the request waits for both. `installed` says which a request
will meet; one short warm-up request does both ahead of a call. A strut
with a voice service (`STRUT_VOICE_URL`, §15.2) makes that request itself,
and the recognizer's, when it starts listening, in the background: the
first call after a start meets both loaded.

Hanging up stops the speech: nothing more is sent, and Kokoro stops at a
sentence boundary — sherpa hears a stop only when a sentence ends, by which
time it has begun the next, so up to two sentences are generated for nothing
while the next speech waits its turn (1.7 s, measured with long sentences).
A client that sends one sentence per request keeps that to the one in
flight. Measured on four cores of an M4 (Docker, `npm run test:tts`): a
two-sentence reply's first audio in 0.36 s, all 5.5 s of it in 1.2 s.

### 15.2 A voice call — handed to the voice service (`src/voice.ts`)

A person's call to their agent is set up by the voice service running beside
strut (plans/private-voice.md §4.1); strut only says who the call is for.

| Method | Path | Body / reply |
| ------ | ---- | ------------ |
| POST   | `/voice/calls` | the body as it came (≤ 16 KB) → the voice service's status and body, as they came |

The caller is a **person token** (the call runs as its actor, whatever
`x-strut-actor` says) or the deployment key with `x-strut-actor` (a test,
the deployment itself). strut POSTs the body unchanged to
`{STRUT_VOICE_URL}/calls` with `content-type: application/json`,
`x-strut-actor: <the person>` and `authorization: Bearer
<STRUT_VOICE_TOKEN>`, the secret the two share (`createStrut({ voice: { url,
token } })` wins over the env, `false` turns it off), and answers what the
service answers (`cache-control: no-store`) — a `402` from it stays a `402`.

```bash
curl -s -X POST localhost:3000/voice/calls -H "authorization: Bearer $PERSON_TOKEN" \
  -H 'content-type: application/json' -d '{}'
# → 200 { "url": "ws://127.0.0.1:7880", "room": "sphinx.call.voice.<32 hex>", "token": "<LiveKit JWT>", … }
```

401 with no credential strut can verify; 403 for the plain peer key, or the
deployment key with no `x-strut-actor` (a call always runs as a person); 413
for a body over 16 KB; 503 with no voice service configured, or one that
does not answer within 15 s. A route, not a workflow: the body and the
answer hold the call's key and room tokens, so nothing of either is logged,
kept or recorded as a run.

## 16. Packages — sharing workflows, steps, apps, Concepts and graph types (`plans/marketplace.md` §1–§5)

A PACKAGE is a directory: `strut.yaml` (`package: publisher/name`,
`version`, `description?`, `license?` — an SPDX expression, never
enforced — `requires?`) and the folders `workflows/`,
`steps/`, `concepts/` and `apps/`, each file an item named under the
package's prefix (`steps/create-issue.ts` is the step
`acme/linear/create-issue`, `workflows/sync.yaml` the workflow
`acme/linear/sync`, the folder `apps/issues/` the app
`acme/linear/issues`), and `graph/`, one `<Type>.yaml` per graph type,
named by its type (`src/packages/graph-types.ts`). It is pinned by its DIGEST, `sha256:<hex>` over every
file in it (`readPackage`, `src/packages/format.ts`). A strut keeps every
package it resolved under `<dataDir>/packages/`, one directory per digest,
and serves any of them by digest — whether it built the package or
installed it, it can be a mirror. `file:` and `pk:` refs resolve; `git+`
is refused by name (`package_source_unsupported`).

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/packages` | What is installed: `{ packages: InstalledPackage[] }` (`src/packages/installed.ts`), a fold over the workspace, never a store |
| POST   | `/packages/build` | `BuildRequest` → 201 `{ package, version, digest, files, requires, warnings, leftToInstaller, suggested }` (`src/packages/build.ts`): a package built from this workspace into the cache. With `dryRun: true`, 200 and the same answer with nothing kept: the package page's preview of what comes along. Both pack the package as the archive route would and read it back as a fetching strut does: one past what a strut fetches (10,000 files, 256 MB unpacked, 64 MB as `.tar.gz`) is 400 `package_unarchivable: …`, and nothing is kept. A person's act like install: full scope, one at a time with install and uninstall |
| POST   | `/packages/install` | `{ ref, digest?, url?, index?, wait? }` → 201 `InstallResult` (`src/packages/install.ts`), or with `wait: false` 202 `{ install: InstallState }` at once, the install going on behind it — follow it at `GET /packages/installs/:id` ("An install as it goes" below); a body that is not one is still 400 before anything starts. `ref` is `file:/path/to/package`, `pk:<key>/<publisher>/<name>[@sha256:<hex>]` with `url`, where the publisher's catalog is served (a strut's `…/packages/catalog?public=1`, or the file it uploaded) — see "Installing by key" below — or a bare NAME, `publisher/name`, looked up in the indexes this strut follows (the first whose card lists the publisher, or the one `index` names) and installed as `pk:` with the row's key and catalog URLs, tried in order. A name with `url` is 400; 404 `package_not_listed` when no index lists the publisher, `package_index_unknown` for an `index` not followed; 502 `package_index_unreachable` when no index card could be read; 400 when this strut follows none. A person's act: behind the key at full scope (a peer is 403), one at a time |
| GET    | `/packages/installs` | `{ installs: InstallState[] }` (`src/packages/progress.ts`): every install as it goes, whichever door started it — this route with or without `wait`, a `package/install` proposal's apply, the boot list (`STRUT_PACKAGES`), a subscription — newest first, and the last 20 that ended within the hour. In memory: a restart forgets them |
| GET    | `/packages/installs/:id` | One `InstallState`; 404 for an id this process does not hold |
| DELETE | `/packages/:publisher/:name` | Uninstall → `{ ok: true, package, removed, kept }` (`UninstallResult`) |
| GET    | `/packages/:publisher/:name/archive?digest=sha256:<hex>` | The package at that digest as a `.tar.gz` of its files — ustar, a path past what its header holds in a POSIX PAX extended header, which a strut from before 2026-11-09 cannot read (`content-type: application/gzip`, `ETag: "<digest>"`, `cache-control: private, max-age=31536000, immutable`; `If-None-Match` → 304). 400 without a well-formed `digest`; 404 when this strut holds no package `publisher/name` at that digest. Behind the key like every route; with `?t=` a subscriber's read of a digest the fleet catalog names; with `?public=1` anyone's read of a digest the PUBLIC catalog names (404 for any other, whatever the gate's mode) |
| GET    | `/packages/:publisher/:name/items?digest=sha256:<hex>` | `{ package, version, digest, items: [{ kind: "workflow" \| "step" \| "app" \| "concept" \| "type", name, alone? }] }`: what the package at that digest holds, each by its name INSIDE the package (`summarize` for `acme/tools/summarize`; a Concept by its page name, a graph type by its type), helpers left out — what the package page ticks from a release (`plans/packages-ux.md` §3). `alone: true` on a Concept page that has pages under it in this graph none of which the release holds: it went alone (`conceptsAlone`), and the page picks it alone again. 400 without a well-formed `digest`; 404 when this strut's cache holds no package `publisher/name` at that digest |
| GET    | `/publisher` | This strut's publisher → `{ key, name?, host: "self", createdAt, public?, publicChannels }` (`src/packages/publisher.ts`); 404 before a key is minted. `key` is the FLEET key, what a subscribing strut follows; `public` the PUBLIC key, once a channel was made public — the only key the world sees; `publicChannels` the channels in the public catalog ("One publisher, two keys" below). `name` is the publisher's prefix segment (`stakwork` in `stakwork/tools`), when set. Any credential may read it (a subscriber's, hive's) |
| POST   | `/publisher` | Mint the key → 201 `PublisherInfo`, or 200 with the one already here. 409 `publisher_unsafe_key` on a file store with `STRUT_SECRET_KEY` unset |
| PUT    | `/publisher` | `{ name }` → `PublisherInfo`: the publisher's NAME, `[a-z][a-z0-9-]*` — the first segment of every package published here (`plans/packages-ux.md`). The web UI composes package names from it, so nobody types the prefix. Mints the key first when there is none (409 `publisher_unsafe_key` as above); 400 `publisher_name` for a name that is not one |
| POST   | `/packages/publish` | `BuildRequest` + `channel?` + `public?` (with a channel: mark it public first) → 201 `{ package, version, digest, files, requires, warnings, channel?, catalog: { key, seq, digest } }`: build, then the release added to the catalog (and the channel moved to it). Mints the key on first use. With a publisher `name` set, a `package` whose first segment is another is 400 `package_build_refused` before any build. Full scope, one at a time |
| GET    | `/packages/catalog[?digest=sha256:<hex>]` | The FLEET catalog CARD as served (`application/json`, its RFC 8785 bytes; `ETag: "<catalog digest>"`, `If-None-Match` → 304): the current one (`cache-control: private, no-cache`), or an earlier one by digest (immutable). 404 before the first publish |
| GET    | `/packages/catalog?public=1[&digest=]` | The PUBLIC catalog the same way, sealed by the public key: the public channels and every release one holds or has held. Open to anyone — no credential; 404 before the first **Make public** (or for a fleet catalog's digest) |
| PUT    | `/packages/channels/:channel` | `{ package, digest, public? }` → `{ channel, package, digest, public, catalog }`: the channel moved to a release the catalog lists — a rollback is moving it back — or, with `digest: null`, the package taken out of it. `public: true` marks the channel public first (**Make public** is this on the channel `public`); `false` on a public channel is 409 `catalog_channel_public` — what was published stays published. 409 `catalog_private_requirement` when the release goes public but requires a package no public channel holds. 404 `catalog_no_release`; 400 `catalog_channel` for a name that is not `[a-z0-9][a-z0-9._-]*` |
| GET    | `/publisher/listings` | `{ listings: ListingLine[] }` (`src/packages/publisher-listings.ts`; `plans/index-listing.md` §1): one line per index this strut FOLLOWS — `{ index, label?, indexKey, requests?, listed, row?, heldBy?, cardError?, asked? }`: `listed` is this strut's publisher name on that index's signed card with its PUBLIC key, read now; `heldBy` another key holding the name there; `requests` where an ask goes (absent when the card is a file no index strut serves); `asked` the last answer, kept in `<dataDir>/packages/listings.json` (`{ status: listed \| pending \| removed \| refused \| error, reason?, base?, description?, url?, live?, at }`) |
| POST   | `/publisher/listings` | `{ index, base, description?, url?, live? }` → the index's answer + `record`: ask a followed index to LIST this strut's name, or change its row. Sealed by the PUBLIC key under `strut-listing\n` with the publisher's name as `prefix`, POSTed to the index strut beside the followed card (`…/index/catalog` → `…/index/requests`); the index key comes from the followed record. `base` is where this server is reached — an origin and at most one path segment (`https://<swarm>:3355/lab`); `live` also lists its public view (a live row at the base), `false` drops it. 200 `{ status: "listed" }`, 202 `{ status: "pending", reason }` (waiting for the index's operator); the index's 4xx passed on with its `error`, 502 when it cannot be reached. 409 `publisher_not_public` (no public key: **Make public** first), `publisher_no_name`, `listing_no_route`; 400 `listing_invalid`; 404 `package_index_unknown`. Full scope. After every change to the public catalog this strut also POSTs `{ key }` to `…/index/ping` on every index it asked and has not taken itself off |
| DELETE | `/publisher/listings/:index` | Take this strut's row — or its waiting request — off that index (a request with `remove: true`) → `{ status: "removed" }`; the index's 404 `listing_not_listed` passed on |
| POST   | `/publisher/tokens` | `{ subscriber, days? }` → 201 `{ key, subscriber, token, exp }`: a READ TOKEN for a strut that subscribes to this one's catalog (default 60 days, at most 366). Full scope; the key is minted first when there is none |
| GET    | `/packages/subscriptions` | `{ subscriptions: SubscriptionInfo[] }` (`src/packages/subscriptions.ts`): what this strut follows, what it accepted and applied, and each package it installed with the items edited here (`diverged`). Never a token |
| PUT    | `/packages/subscriptions/:id` | `{ key, url, channel?, token? }` → the `SubscriptionInfo`; the first read starts at once, its outcome on the `GET`. The operator's act: full scope (a peer is 403). 400 `subscription_invalid` |
| DELETE | `/packages/subscriptions/:id[?uninstall=1]` | Stop following → `{ ok, removed, uninstalled }`; with `uninstall=1` its packages go through the distro's door (forks kept). 404 when there is none |
| GET    | `/packages/indexes` | `{ indexes: IndexSubscriptionInfo[] }` (`src/packages/indexes.ts`): the indexes this strut FOLLOWS, each `{ id, key, urls, label?, read?: { seq, digest, at, url, publishers }, error? }` — the last read of its card in this process |
| PUT    | `/packages/indexes/:id` | `{ key, urls, label? }` → the `IndexSubscriptionInfo`, its card read at once (a wrong key or URL shows as `error`). `key` is the index key; `urls` where its card is served (an index strut's `…/index/catalog`). Kept in `<dataDir>/packages/indexes.json`; `STRUT_PACKAGE_INDEXES` and `createStrut({ packageIndexes })` put entries on file at boot. Full scope; 400 `package_index_invalid` |
| DELETE | `/packages/indexes/:id` | Stop following → `{ ok, id }`; 404 when there is none |
| GET    | `/packages/search?q=&limit=&peers=0` | `PackageSearch`: `{ packages: [IndexHit & { index }], peers: [{ peer, package, version?, digest?, source? }], errors: [{ index? \| peer?, error }] }` — each followed index strut's `GET /index/packages` (unsigned: install a hit by its NAME, which goes through the index's signed card) and, unless `peers=0`, every peer's `GET /packages` matched against `q`. A peer asking gets the indexes alone. `limit` 50 (≤ 500) |
| —      | `package/install` (step) | The agent's INSTALL door (`src/steps/lib/package/install.ts`, over `ctx.services.packages.install`; the READS — `package/search`, `package/get`, `package/concepts` — are the steps table below). `package/install { package, index?, digest?, url? }` — a name through the followed indexes, or a `pk:` ref with its `url` — runs ONLY as a proposal a person accepted (plans/marketplace.md §8, ruled 2026-10-29) — and only an ADMIN accepts it (`approver: "admin"`, §12): a member's or a person token's accept is `403 admin_required:`, and a turn whose person is known not to be an admin proposes nothing. The seeds that grant it (`orchestrator`, `builder`, `job`) list it in `approve:`, so the agent's call records a proposal and returns `{ proposal, status: "pending" }`; its card's `summary` is the step's `describe` at proposal time — the index's reading of the package: publisher and key, which index lists it, digest, license, what it brings, what it can spend or act on, the secrets it needs — or that no followed index lists it; `POST /proposals/:id/decide { action: "accept" }` then installs as `POST /packages/install` would, with the decider as actor, and the result reaches the session on its next turn. The door behind the step (`services.packages.install`) checks the ACCEPTED record on disk for that very ref, so no step reaches it any other way; a direct call, a DAG step or `meta/run-step` is refused |
| POST   | `/packages/subscriptions/sync` | `{ key? }` → 202: read the catalogs now — of the subscriptions to `key`, or all; with the index role on, the index rows whose key it is are read too. What a publisher pings: a PEER may send it, since it carries nothing |
| GET    | `/index` | **Index role only** (`STRUT_INDEX=1`, `createStrut({ index })`; `src/packages/index.ts`). `IndexInfo`: `{ key, createdAt, urls, publishers: { "<prefix>": { key, urls, description?, url? } }, crawled: [{ prefix, key, accepted?: { seq, digest, at, url }, checkedAt?, error?, packages? }] }` — the rows as the card has them and each listed publisher's catalog as last read. Any credential; 404 before the first row |
| PUT    | `/index/:prefix` | `{ key, urls, description?, url? }` → `IndexInfo`: list a publisher — its PUBLIC key and where its public catalog is served (`urls`, tried in order) — the index key minted first when there is none, the card re-sealed, that publisher read now. Full scope. 400 `index_row_invalid`; 409 `publisher_unsafe_key` on a file store with `STRUT_SECRET_KEY` unset |
| DELETE | `/index/:prefix` | Drop the row and re-seal → `{ ok, prefix }`; its crawl state goes. 404 when there is none |
| PUT    | `/index/live/:prefix` | `{ url, description? }` → `IndexInfo`: a LIVE row (`plans/public-surface.md` §8) — where a publisher server's public view is served (`<url>/public`, §17), no key, no catalog — sealed into the card's `live` map beside `publishers` (a reader that knows only `publishers` reads the card as before), and read now: `<url>/public` and `<url>/public/concepts`, kept until the next read (a failed read keeps the one before and says why, `liveCrawled[].error`). Read again with every crawl. Full scope. 400 `index_row_invalid` (a `url` with a query, or anything but `url` and `description`) |
| DELETE | `/index/live/:prefix` | Drop the live row and re-seal → `{ ok, prefix }`. 404 when there is none |
| GET    | `/index/live?q=` | `{ items: [{ publisher, url, kind: app \| workflow \| step \| concept, name, title?, description?, version?, runs?, pages? }] }` — what the live rows' public views show, as last read; the item itself is read from `<url>/public/…` (the store does, in the visitor's browser). **Open to anyone** |
| POST   | `/index/crawl` | `{ crawled: CrawlState[] }`: read every listed publisher's catalog now. Full scope |
| POST   | `/index/requests` | **Index role only.** A publisher's LISTING REQUEST (`plans/index-listing.md`; `src/packages/listing.ts`, `src/packages/index-requests.ts`): the RFC 8785 bytes of `{ v: 1, index, prefix, key, base?, description?, url?, remove?, live?, seq, sig }`, sealed by `key` (the publisher's PUBLIC key) under `strut-listing\n` (`listing.test.ts` holds a test vector). Checked cheapest first, nothing fetched until the first five pass: one byte form, ≤ 8 KB, its shape (`base` https on a public name — no IP literal, no local name — an origin and at most one path segment, no query) — `index` this index's key — `seq` (microseconds) within 10 minutes of the index's clock and greater than the last from `key` — the seal — `prefix` not reserved (`strut`, `stakwork`, `sphinx`, `hive`, `stadeum`, `peel`, `jamie`, `index`, `official`, `admin`, + `STRUT_INDEX_RESERVED`) nor refused for this key in the last 30 days (a refusal is of what waited: it never stops a `remove`, nor the row's own key changing its row on the same host) — then `<base>/packages/catalog?public=1` (the ONE URL the index reads: a redirect is refused, never followed, and the body is read no further than 4 MB) is a catalog sealed by `key` listing a package under `prefix/`. Then: the row's own key on the same host, or a NEW name from a host in `STRUT_INDEX_AUTO_HOSTS` (`*`, `host[:port]`, `*.domain[:port]`) from a key and a host that hold no row → 200 `{ status: "listed", prefix, row, live? }`, the publisher read at once; `remove` by the row's key → 200 `{ status: "removed" }`; anything else → 202 `{ status: "pending", id, prefix, reason }`, `reason` one of `host`, `second name`, `same host`, `move` (the row's key, another host), `takeover` (another key holds the name), `live row` (the name is a live row the operator listed with no key). One request waits per (name, key); 200 at most, 3 per host; 30 days. `live: true` also writes a live row at the base, `false` removes it, absent leaves one alone. Errors: 400 `listing_invalid`, 403 `listing_reserved` / `listing_refused` (with the operator's reason), 404 `listing_not_listed`, 409 `listing_rollback`, 422 `listing_no_catalog`, 429 `listing_busy` (also 10 a minute per address), 503 `index_no_key` before the first row. **Open to anyone**: the request carries its own proof |
| POST   | `/index/ping` | **Index role only.** `{ key }` → 202 `{ rows }`: read the rows naming `key` now — at most once a minute each, a ping inside the minute folded into one more read at its end. What a listed publisher sends after a release (its public key). Carries nothing: the catalog is read from the row's own URLs, against the row's key. **Open to anyone**, 10 a minute per address |
| GET    | `/index/requests` | **Index role only.** `{ pending: PendingListing[], refused, autoHosts }`: the requests waiting for the operator, newest first — `{ id, prefix, key, base, host, reason, description?, url?, live?, receivedAt, catalog: { seq, digest, packages }, heldBy? (a takeover), from? (the host now: the row's on a move, the live row's on a `live row`), request }` — and the refusals of the last 30 days `{ prefix, key, host?, reason, at, by? }`. Every outcome is also appended to `<dataDir>/packages/catalogs/index/requests/log.jsonl`. A credential (the operator's; the Publish dialog's Index tab) |
| POST   | `/index/requests/:id/approve` | List it: the catalog read again, then the row written (a takeover replaces the key; a move the URL) → `{ status: "listed", … }`. Full scope; 404 `listing_unknown`, 422 `listing_no_catalog` |
| POST   | `/index/requests/:id/refuse` | `{ reason }` → the refusal: the request dropped, and a re-send from that key for that name answered with `reason` for 30 days, without a fetch. Full scope; 404 `listing_unknown` |
| GET    | `/index/catalog[?digest=]` | The INDEX card as served (RFC 8785 bytes, sealed under `strut-index\n` by the index key; `ETag`, `If-None-Match` → 304; `cache-control: public`): `{ v, key, seq, publishers, urls?, sig }`. **Open to anyone.** A reader checks it with `readCard(bytes, { key, kind: "index" })`; 404 before the first row |
| GET    | `/index/packages?q=&limit=` | `{ packages: IndexHit[] }` — every listed publisher's public packages, each at its newest release not yanked: `{ package, publisher, key, urls, version, digest, description?, license?, requires?, detail? }`; `q` as the sidebar's matcher (every word in the name, description or publisher), at most `limit` (100; ≤ 500). `detail` is the release's archive as the index READ it at the crawl (`src/packages/detail.ts`, below): `{ apps: [{ name, title, description?, icon?, can }], workflows, steps, concepts (counts), secrets, can: { spends, acts, code }, readme }` — absent until the archive has been fetched. **Open to anyone**; derived and unsigned — an install re-verifies against the publisher |
| GET    | `/index/packages/:publisher/:name` | `IndexPackage`: `{ package, publisher, key, urls, description?, releases (newest first, yanked kept), channels: { "<public channel>": digest }, readAt, detail?, detailError? }`. `detail` is the newest release not yanked read off its archive — `PackageDetail`: `{ digest, version, derivedAt, readme?, apps: [{ name, title, description?, icon?, grants: { workflows, steps }, can, files }], workflows: [{ name, description?, inputs: [{ name, type, required, description?, default? }], steps, grants, can, secrets, peer?, sealed?, claims?, error? }], steps: [{ name, helper?, description?, effect?, secrets, lint: [string], bytes, claims? }], concepts: [{ name, description?, parent?, docs? }], secrets, can, files, bytes }` (names inside the package; `can` = what running it reaches: `spends` an `agent` / `llm` step, `acts` a step declaring `effect: "write"`, `code` an `exec` or one of the package's own steps; the steps' facts are regexes over the source, the lint `src/step-lint.ts`'s findings — a reading, never a check); `detailError` says why there is none (the archive not fetched yet, or unreadable). **Open to anyone**; 404 when no listed publisher's catalog has it |
| GET    | `/index/concepts?q=` | `{ concepts: IndexConcept[] }` — every Concept page across the crawled packages AND the live rows' public trees, one per name: `{ name, description?, parent?, packages: [{ package, version }], live?: [{ publisher, url }] }` (the first package by name gives the description and parent, then a live tree's; a page only a live view holds has `packages: []`, and its docs are read from `<url>/public/concepts/<name>`; `q` over names and descriptions). **Open to anyone** |
| GET    | `/index/concepts/:name` | `IndexConceptPage`: the entry plus `docs?` (the first package's text), `children: [{ name, description? }]` (the pages naming this one as parent) and `parents` (nearest first). **Open to anyone**; 404 when no listed package carries it |
| GET    | `/llms.txt` | **Index role only.** The store as ONE markdown page for an agent that fetches URLs (llmstxt.org; `llmsTxt`, `src/packages/index-tools.ts`), `text/markdown`: an H1 naming the index, a blockquote saying what it is (derived, unsigned past the card, an install re-verifies against the publisher), how an agent reaches it (the `claude mcp add` line for `/index/mcp`) and that a PERSON installs; then `## Reads` (the five open routes above, each a link), `## Packages` (every listed package at its newest release — `- [publisher/name](…/index/packages/publisher/name): description — version; N workflows, M steps, K apps; needs SECRET; spends (model calls), acts on the world, runs code`), `## Concepts` (every page the packages carry, each a link to `/index/concepts/<name>`, its parent and packages) and `## Optional` (the store page `?store=1` when the index serves the UI). **Open to anyone**; 401 (no such page, the gate answers) on a strut without the role |
| POST   | `/index/mcp` | **Index role only.** The store for an AGENT (§11; `src/packages/index-tools.ts`): the three reads above as MCP tools over the same derived pages — `search_packages { query?, limit? }` → `{ packages: IndexHit[], total, store?, install }`; `get_package { package }` → the `IndexPackage` as a model reads it (`detail.readme` cut at 12 000 chars, the Concept pages' `docs` left out) + `store?` + `install`, or `{ error }`; `get_concept { name?, query? }` → one `IndexConceptPage` (+ `store?`) or `{ concepts: IndexConcept[], total }`. `store` links the store page (`?store=1&pkg=`, `&concept=`, `&q=`) when the index serves the UI; `install` says a PERSON installs, and where. The `instructions` say what the index is, that everything is derived and an install re-verifies against the publisher, and how a person installs. **Open to anyone** — the one POST the gate opens with the role; GET and DELETE are 405 |
| GET    | `/` | **Index role, with the UI served:** a request for the UI's root with NO credential (no key, no session cookie, no `?key=`) is a 302 to `./?store=1` — the STORE FRONT (§14.3), the index's public face over the four open reads above; what else the URL carried rides along. With a credential, the shell as always |

**Installed at first boot.** `STRUT_PACKAGES` (and `createStrut({
packages })`) lists packages a box should come up with: a JSON list of `{
ref, url?, digest? }`, the fields `POST /packages/install` takes. Once the
boot is done, each listed package not installed here (by its name, at any
digest) is installed through the person's door, one at a time, in order,
in the background (`src/packages/boot.ts`); one already here is left alone,
so a change to the list never updates anything. A source that does not
answer, or any other failure, is a warning and the next boot tries again;
the server is up meanwhile. A malformed value fails the boot. `GET
/packages` shows what landed.

**The store's reads as steps** (`src/steps/lib/package/`; `ctx.services.packages`,
`src/packages/indexes.ts`) — what an agent on a strut that FOLLOWS an index
reads, the same derived pages through the index's open routes above; the
builder chat holds them as `package_search` / `package_get` /
`package_concepts`, the `builder`, `job` and `orchestrator` seeds grant them,
and `POST /mcp` serves `search_packages` / `get_package` over the same
capability (§11.1). Every one is `effect: "read"`, and every description
says installing is the PERSON's decision: an agent that holds
`package/install` (the row above) proposes it, any other tells them the
name — the Publish dialog's Packages tab, or the store's Install link:

| Step | Input | Output |
| ---- | ----- | ------ |
| `package/search` | `query`, `limit?` (30) | `PackageSearch` (`GET /packages/search`): each hit with its `detail` |
| `package/get` | `package`, `index?`, `full?` | the page from the first followed index whose card lists the publisher (or the one `index` names): `IndexPackage & { index }`, as a model reads it — `detail.readme` cut at 12 000 chars, the Concept pages' `docs` left out — or whole with `full: true`. Throws with the code first: `package_not_listed`, `package_not_found` (listed, but no public catalog has it), `package_index_none` (this strut follows no index), `package_index_unknown`, `package_index_unreachable`, `package_source_invalid`. A miss over memoized cards re-reads them once, so a publisher listed a moment ago is found now |
| `package/concepts` | `query?`, `name?`, `index?` | without `name`: `{ concepts: [IndexConcept & { index }], errors }` — the tree across the followed indexes, one entry per name (the first index's), `query` over names and descriptions; with `name`: `IndexConceptPage & { index }` from the first index that carries it, or `{ error: "concept_not_found: …" }` |

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
  "conceptsAlone": ["Firm"],           // a page WITHOUT the pages under it (a root the package's steps need)
  "apps": ["acme/linear/issues"],      // each with what its grants execute and the apps it imports
  "types": ["LegalParty", "Agreement"], // graph types, each with its parents and the edges among them
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
  "warnings": [],                      // a claim left out, a closure read only in part, a parent outside the package, an item left to the installing strut
  "leftToInstaller": [],               // [{ kind: "workflow" | "step" | "app", name, publisher? }]: what the closure reaches that the installing strut must already have (below)
  "suggested": { "types": [], "concepts": [] }  // not carried yet, what the package page offers to add (below)
}
```

What goes in:

- **The closure** of each named workflow (`flowClosure`: its subflows,
  `agentTools` with globs expanded against the registry), the workflows
  named by the names they have HERE (`summarize`, not
  `acme/tools/summarize`; `plans/packages-ux.md` §3). A workflow or custom
  step it reaches is an item when it is LOCAL — made here, from no
  package, not the host's — at the path of its local name; one already
  under the prefix keeps the rest of its name. Each item's own name is
  written under the prefix (a workflow's `name:`, a step's `defineStep({
  type })` literal) and nothing else: references stay as written. The
  helpers are every file a carried step imports by a relative path, which
  must sit at the same place beside it in the package, and every `_`
  helper under the prefix. Core and lib steps, and the host's workflow or
  step — a seed's (`source: "seed"`, such as `job`) or one a service
  published (a `publisher` stamp other than the builder's `ai`) — are
  recorded nowhere: the installing strut must have them, and the install
  checks. One that strut does not seed on every server — a host's seed
  (the mcp lab's `artifacts/dir`), a service's item — is listed in
  `leftToInstaller` and said in a warning (`the step artifacts/dir is left
  to the installing strut (published here by artifacts-seed): a strut
  without it cannot install or run what reaches it`); strut's own seeds
  (`job`, `orchestrator`, `builder`, the browser, privacy, system and
  `home-sync` workflows, the `strut/` apps) are not.
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
  imports, read off its build (`dist/build.json`): a local one is an item,
  another package's a pin, a seed's (`strut/views`) recorded nowhere. An
  app the package carries has one segment as its path (`apps/<name>/`).
- **The Concepts** named, with every page under each, as
  `concepts/<Name>.md` (front matter `description`, `parent`; the body is
  `docs`). A top page keeps its parent. A page in `conceptsAlone` comes
  without the pages under it, whichever way it is reached. In every
  carried page's docs and description, each carried workflow name and
  custom step type is written as packaged (`legal-task-run` →
  `openlaw/legal-desk/legal-task-run`): a name with a `-`, `_` or `/` where
  neither neighbour is `[A-Za-z0-9_/-]`, a one-word name only as a whole
  code span. A page naming a workflow or custom step this strut has, which
  the package neither carries nor requires and strut does not ship, is a
  warning.
- **A workflow's category** as a top-level `category:` line in its YAML
  (after `name:`), which the install sets as the workflow's category; a
  strut that does not read it ignores the key.
- **The graph types** named, each read off this graph's ontology as
  `graph/<Type>.yaml` in `graph/create-schema`'s grammar (`parent`,
  `domain`, `type_description`, `attributes`, `key_spec`, `index`,
  `title_key`, `description_key`, `role`, `identifiers`, `embed`) plus
  `edges: [[EDGE, Target]]`, the edges whose source it is. Its parents
  come along up to a type every strut has (`Thing`, strut's own, the
  seed's Claim / Check / Evidence / Concept) or one a required package
  carries. Its `key_spec` is the attributes after the key's type prefix,
  whoever declared the key: a type with none of its own (jarvis's
  `Content`, `Legal`, which inherit Thing's `thing-name`) is keyed by
  `name`, the default, and writes no `key_spec`. The edges are the ontology's rules among the carried types and
  every edge the graph HOLDS between two of them — so an edge a Jarvis
  graph let through on its allowlist, with no rule, travels as a rule.
  Rules carry no `temporal`, `cardinality` or aliases yet. An edge the
  graph holds between a carried type and one the package does not carry
  is a warning. A type no package carries (strut's own, the seed's) or
  that the graph does not hold refuses the build.
- **Each step's claims**, as `steps/<name>.claims.yaml`. A claim with a
  check that reaches outside the package and what it requires is left out,
  with a warning.
- **`requires`**, from what can be read: secret names in step configs
  (`secretsEnv`, `tokenSecret` and the other secret-name fields, a step's
  own `secrets` and schema defaults), literal `secrets.get("…")` calls in
  step source, literal `exec` commands, literal `runtime:` fields.

**Suggested** (`src/packages/suggest.ts`): what the package's workflows
wrote and read that it does not carry, for the package page to offer — never
added by itself. `types`: the node types the write steps (`graph/create-*`,
`edit-*`, `assert`, `merge`, `move-node`, `restore-node`; an agent's tool
calls included) reported on their `step.end` `nodes`, in the last five
successful runs of each workflow; strut's own, the seed's and the carried
left out. `concepts`: the pages `context/concept` read in those runs, and
the literal `name` of each `context/concept` step the workflows hold, each
climbed `PARENT_OF` to the top of its tree — naming a page brings every page
under it — stopping below a page another seeder or package stamped.

Building twice from the same workspace gives the same digest. Refusals are
400 `{ error }`, one `package_build_refused: …` naming every problem: one
package reached at two digests, a local name and the same name under the
prefix (both one path), a step that imports a file the package does not
carry or one that would not sit beside it, a workflow whose `name:` line
or a step whose `type:` literal cannot be written under the prefix, a version label (`type@vN`, a subflow's
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
with the package as their speaker, and `publish` checks fire. GRAPH TYPES
are checked with everything else — the grammar, a parent and edge ends in
the set or the graph, and the graph as it is: a type it holds keeps its
key and attribute types, and the declaration covers what it requires (the
checks an app's `data.graph` gets) — then registered before any other
write, parents first, add-only; an edge with no rule, so a new edge type
takes the default and an existing one keeps its own. A type is the
graph's: no take-back or uninstall removes one. Without a graph a package
with types is refused (409).

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
                                      // (a graph type: installed | updated, extended | present)
        { "kind": "type", "name": "Issue", "status": "installed" },
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

A package's CONCEPTS are seeded in batches (`seedConcepts`,
`src/concept-seed.ts`): the nodes under every page's name in one read per
250, the creates and the updates written 250 at a time, the parents' live
`PARENT_OF` edges read once and only the missing edges written. Their
VECTORS come after: each page is written with its search text (keyword
search finds it at once) and no vector, and the graph's background
embedder — Neo4j's embedding pass, a Ladybug file's backfill, both in a
worker thread — embeds them within the minute (an update clears the old
vector first). openlaw/legal-desk's 752 pages install in about a second
on either engine; their vectors follow some seconds later.

**An install as it goes** (`src/packages/progress.ts`). Every install has a
record from the moment it is asked for until an hour after it ends —
whichever door started it — so a page can say what it is doing: `POST
/packages/install { …, wait: false }` answers 202 with it at once, and
`GET /packages/installs/:id` reads it again (every 600 ms is plenty;
strut's Packages tab polls so, and shows an install another door started
when it finds one at `GET /packages/installs`). A caller that waits for the
201 can read `GET /packages/installs` meanwhile; the newest record whose
`ref` is its own is its install.

```jsonc
// InstallState
{
  "id": "inst_9f2c41d07a3b55e6",
  "ref": "openlaw/legal-desk",        // as asked; a subscription's refs joined with ", "
  "door": "install",                  // or "distro": a subscription
  "actor": "evan",
  "status": "running",                // queued (behind another install or uninstall: one at a time) | running | done | failed
  "phase": "concepts",                // queued | resolving | checking | types | steps | workflows | apps | concepts | concept-tree | retiring | claims
  "package": "openlaw/legal-desk",    // the package of the set the phase is about, when it names one
  "done": 500, "total": 752,          // how far, when the phase counts: steps, workflows, apps, Concept pages, PARENT_OF edges
  "startedAt": 1794272815737, "updatedAt": 1794272816102,
  "finishedAt": 1794272816911,        // once it ended
  "result": { /* InstallResult */ },  // done: what the 201 would have answered
  "error": "package_conflict: …"      // failed: the refusal as the route would have answered it
}
```

A count is how many are DONE as the phase reports (a step, workflow or app
as the next begins; Concept pages and edges after each batch); `done`,
`total` and `package` are always the current phase's, never one before.
A phase a page does not know yet is shown by its name.

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
| A Concept not in the release with a page under it that stays (this strut's own, or one kept) | kept, and every page above it | `kept` |

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
are kept and listed in `kept: [{ kind, name, reason }]`; so is a page with a
page under it that stays — one this strut added under the package's root,
an edited page — and every page above it, since retiring a page deletes
its edges. 404
`package_not_installed`; 409 `package_busy` while one of its workflows has
a run in flight; 409 `package_distro_owned` for a package the distro
installed.

The archive is transport: a fetcher checks the unpacked TREE against the
digest, never the archive's bytes, so any URL that serves the right tree
is as good as the publisher's (`fetchArchive`, `src/packages/archive.ts`,
which also refuses an entry that leaves the directory or that the digest
never covers — a dotfile, an app's `dist/` or `data.db`).

**Publish** (`plans/marketplace.md` §13, §12.1). A strut that publishes
has an Ed25519 key, minted once and kept in an encrypted file of its own,
`publisher.json` beside `peers.json`; its public key, in z-base-32 (Pkarr's
form, 52 characters), is the publisher's identity between struts. What it
publishes is listed in its CATALOG, a card it seals with that key:

```jsonc
// GET /packages/catalog — served without whitespace, members sorted (RFC 8785)
{
  "v": 1,
  "key": "47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy",
  "seq": 1792972800000000,             // microseconds at signing; never goes back
  "packages": {
    "acme/linear": {
      "description": "Linear issues",
      "releases": [                    // newest first; earlier ones are kept
        { "version": "1.1.0", "digest": "sha256:…", "license": "MIT", "requires": { "secrets": ["LINEAR_API_KEY"] } },
        { "version": "1.0.0", "digest": "sha256:…" }
      ]
    }
  },
  "channels": { "stable": { "acme/linear": "sha256:…" } },  // which release each channel holds
  "sig": "<128 hex>"                   // Ed25519 over "strut-catalog\n" + the fingerprint
}
```

A reader checks it in this order, and refuses with the code that failed
(`readCard`, `src/packages/card.ts`):
1. **One byte form:** the file parsed and written back in RFC 8785 is the
   same bytes (`catalog_noncanonical`). Every number in it is an integer
   within ±(2^53 − 1); a float, or a larger integer, is `catalog_invalid`.
2. **The key it expected:** a subscription's, never taken from the file
   (`catalog_key`).
3. **The version:** `v: 1` (`catalog_version`). A member it does not know
   is ignored, and the seal still covers it.
4. **The seal:** `sig` verifies over `strut-catalog\n` followed by the
   FINGERPRINT, `sha256:<hex>` over the RFC 8785 form without `sig`
   (`catalog_seal`).
5. **The order:** `seq` against the last catalog it accepted from the key.
   A lower one is `catalog_rollback`; another one at the same `seq` is
   `catalog_conflict`.

A catalog's DIGEST is `sha256:<hex>` over its served bytes. The byte host
is this strut (`host: self`), so a release lists no `urls`: its archive is
`GET /packages/:publisher/:name/archive?digest=` beside the catalog. A
channel names a release the catalog lists, and with no channel a reader
takes the newest release not yanked. `src/packages/card.test.ts` holds a
test vector (RFC 8032's first key, a catalog, its fingerprint, seal and
digest) for another implementation to check itself against.

**The index** (`plans/marketplace.md` §7, step 7; `src/packages/index.ts`).
A strut with the index role is the phone book and the crawler behind it.
The ROWS are the trust root for names: a prefix → the publisher's PUBLIC
key and where its public catalog is served, sealed into an index card
(the catalog card one level up — `publishers` where a catalog has
`packages` — under the domain `strut-index\n`, with the same byte form,
`seq` and reader checks) by the index key, which lives beside the
publisher's keys in `publisher.json` and is minted at the first row. The
CRAWL follows each row: the publisher's public catalog is fetched from the
row's `urls` and read as that key's card (`fetchCatalog`, the per-key
`seq` rule holding), kept under `<dataDir>/packages/catalogs/index/crawl/`
— at the row, on a publisher's ping (`POST /packages/subscriptions/sync
{ key }` with the public key, which a publisher sends to every peer on
file when its public catalog changes), and on the poll
(`STRUT_DISTRO_POLL_MINUTES`). Over the crawled catalogs the index serves
search and package pages, open to anyone, derived and unsigned: a client
that finds a package there installs it by `pk:` with the hit's `key` and
`urls` and re-verifies everything against the publisher, so a wrong
answer from the index is a failed install, never wrong code. The index
holds no archive it alone has — but it MIRRORS what it lists: at the
crawl each package's newest release not yanked is fetched by digest from
the route beside the publisher's catalog into the index's cache and READ
(`src/packages/detail.ts`): the apps' manifests, each workflow's YAML
(inputs, the closure's step types and `agentTools`, a `description:`, the
`claims:` count, what it reaches), each step's source (its declared
`effect` and `secrets`, every `secrets.get("NAME")`, the lint's findings),
the Concept pages' front matter and docs, the root README. The page is
kept under `crawl/pages/<prefix>/<name>.json` by digest (an archive is
read once; one that cannot be fetched is tried again at the next crawl
and never blocks the catalog's acceptance), served on the hit's `detail`
and the package page's, and folded across packages into the Concept tree
(`/index/concepts`). The STORE FRONT (§14.3) draws these.

**Installing by key** (`plans/marketplace.md` §5, §13 — HTTP-first,
2026-10-28; `src/packages/pk.ts`). `POST /packages/install { ref:
"pk:<key>/acme/linear", url }` resolves the package by the PUBLISHER's
key: the catalog is fetched from `url` and read as a card against the key
— its seal, and its `seq` against the last catalog accepted from that key
on this strut (`<dataDir>/packages/index/<key>.json`; an older one served
later is `catalog_rollback`, 409) — the release is the digest the ref or
`digest` pins (which the catalog must list: `package_not_published`, 404)
or else the newest not yanked, and its archive is fetched by digest from
the archive route beside the catalog (`…/packages/acme/linear/archive?digest=…&public=1`)
and then the release's own `urls`, verified against the digest. What the
release requires and the catalog lists is fetched from it too, so the
install never follows a `file:` hint that names the publisher's disk. The
install records `upstream.key` (the key an update must match) and
`upstream.source.url` (where the next read starts) on every version it
writes; `GET /packages` shows `source: { ref, url }`. The URL is only
where the catalog is today: an index row or, later, the key's Pkarr
record are other places it comes from, and neither changes a check.

**One publisher, two keys** (`plans/marketplace.md` §13). A card's `seq`
rule is per key, so one key cannot seal a catalog a fleet reads and
another the world reads. The key minted first is the FLEET key: it seals
the catalog above, the whole picture (every release, every channel), and
is what a subscription follows. The first **Make public** — `PUT
/packages/channels/public { package, digest, public: true }` — mints the
PUBLIC key and marks the channel; from then on a second catalog, sealed by
the public key and served at `GET /packages/catalog?public=1` with no
credential, lists the public channels and every release one holds or has
held (what was published stays published), and the archive route serves
those digests to anyone as `?public=1`. A channel goes private → public
only; a package has no visibility setting of its own, its releases are
public once a public channel holds them; a release that requires a package
no public channel holds may not go public (`catalog_private_requirement`).
The fleet card names the public key as `public`; the public card never
names the fleet key. On a swarm, mcp's `labAuth` hands a `?public=1` read
through as it does a `?t=` one, and strut judges it.

**A read token** opens two routes, as `?t=<token>`: `GET
/packages/catalog`, and `GET /packages/:publisher/:name/archive` for a
digest the catalog names (any other is a 404). It opens nothing else: no
run, no workflow, no launch. It is `strut-catalog.<claims>.<hmac>` (the
publisher key, the subscriber, the expiry), signed like a person token
under `STRUT_API_KEY` (else `STRUT_SECRET_KEY`), so rotating that secret
ends every one. A `?t=` this strut cannot vouch for is a 401 on those
routes whatever the gate's mode.

**Subscriptions** (`plans/marketplace.md` §12.1): this strut following
another's catalog by its KEY.

```jsonc
// PUT /packages/subscriptions/acme — the operator's write (hive's cron)
{
  "key": "47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy",  // the publisher's GET /publisher
  "url": "https://central.example/lab",   // the base of the strut that serves the catalog
  "channel": "stable",                    // optional: none = each package's newest release not yanked
  "token": "strut-catalog.…"              // its POST /publisher/tokens; sent as ?t= to `url` alone
}
```

A SYNC runs on that `PUT`, at boot, every `STRUT_DISTRO_POLL_MINUTES`
(default 10; `0` = boot only), and on a ping:
1. It fetches the catalog, with `If-None-Match` on the one accepted.
2. It checks the catalog against the key and the last one accepted
   (`readCard`, above).
3. It fetches the archive of every release the channel holds, and of
   every package one requires that the catalog lists, into the cache by
   digest.
4. It installs the whole set as ONE install through the distro's door:
   §4's table item by item, no ask, all or nothing. Each item records
   `upstream.source.ref` `subscription:<id>`.
5. A package it installed that the channel no longer holds is uninstalled
   the same way, forks kept.

What it cannot apply leaves this strut on the release it applied last,
with `error` on the `GET`. A publisher pings every peer on file after a
publish and after a channel move.

```jsonc
// GET /packages/subscriptions → subscriptions[]
{
  "id": "acme", "key": "47pj…", "url": "https://central.example/lab", "channel": "stable", "token": true,
  "accepted": { "seq": 1792972800000000, "digest": "sha256:…", "at": "…" },   // the last catalog accepted
  "applied": { "seq": 1792972800000000, "digest": "sha256:…", "at": "…",
               "packages": [{ "package": "acme/linear", "version": "1.1.0", "digest": "sha256:…" }] },
  "checkedAt": "…", "error": "…",          // the last read, and what stopped it
  "warnings": [],
  "packages": [{ "package": "acme/linear", "version": "1.1.0", "digest": "sha256:…", "diverged": ["acme/linear/report"] }]
}
```

## 17. The public view — what anyone may read (`plans/public-surface.md`)

A person chooses what this strut server shows anyone, live and read-only —
its PUBLIC VIEW (not a copy: nothing is copied or versioned, and the
Packages tab's **Make public** is the package catalog's, §16):
Concept roots (each root and every page under it by `PARENT_OF`),
workflows (with or without their runs), steps, node types, and apps — and
what anyone may RUN, free or priced in dollars (`runnable`,
`plans/paid-runs.md` §2; a workflow launches through §17.4, a step is
called through §17.6, a priced one paid from a credit token, §17.5).
Everything else stays behind the key. The record is one file,
`<dataDir>/public.json` (`src/public-surface.ts`); nothing public until
someone puts it there. The UI's door is the topbar's **Publish** dialog, its
**Public view** tab (beside **Packages**).

### 17.1 The record — `/public-view` (a person, behind the key)

| Route | |
| --- | --- |
| `GET /public-view` | `{ surface, missing }` — the record as kept, and what it names that this server does not hold |
| `PUT /public-view` | replace the record (body below); `{ surface, missing, held? }` |
| `GET /public-view/needs?app=<name>` \| `?workflow=<name>` | what adding it brings along, for the dialog to pre-check (`src/public-view.ts`) |
| `GET /public-view/runnable?workflow=<name>` \| `?step=<type>` | what the "anyone can run it" box shows: what it can do, what its runs here cost, and what the save will ask (below) |

```json
{
  "concepts": ["Law"],
  "workflows": [{ "name": "openlaw-run", "runs": true }, { "name": "harvey-lab-run" }],
  "steps": ["openlaw/list-tasks"],
  "types": [],
  "apps": [{ "name": "openlaw-benchmarks", "reads": ["openlaw/runs"], "domains": ["openlaw.ai"] }],
  "runnable": [
    { "kind": "workflow", "name": "cve/scan", "dailyCapUsd": 5 },
    { "kind": "workflow", "name": "voxel/character", "base": 0.1, "markup": 1.2, "capUsd": 5, "results": "run" },
    { "kind": "step", "name": "cve/lookup", "base": 0.01 }
  ]
}
```

Every list is optional; the body REPLACES the record. `runs: true` makes a
workflow's runs public whole: their input, outputs, agents' transcripts
and files. An app's `reads` are the granted steps its page may call beyond
runs and the graph (§17.3). A peer's request is a `403`, a malformed body
a `400`. What the record names that this server does not hold is reported,
never refused. An app ADDED by this save that follows latest is HELD at the
version it shows (`held: [{ app, version, release } | { app, error }]`, as
pinning holds, §14.5): a later publish is a draft until a person moves the
release.

```json
{ "surface": { … }, "missing": { "workflows": [], "steps": [], "concepts": [], "apps": [] }, "held": [{ "app": "openlaw-benchmarks", "version": "v7", "release": "r3" }] }
```

**`runnable`** (`plans/paid-runs.md` §2): what anyone may START, a workflow
or a step, independent of `workflows` and `steps` — an item may be run by
anyone without its definition or its runs being shown. One pricing rule,
`charge = base + markup × what the run cost`, in dollars:

| Field | |
| --- | --- |
| `kind`, `name` | `workflow` and its name, or `step` and its type |
| `base` | dollars a run or call; 0 when absent |
| `markup` | times what the run cost; 0 when absent (1 charges exactly the cost) |
| `capUsd` | the most one run may spend, above 0; required with a markup |
| `dailyCapUsd` | the spend the owner carries per UTC day, above 0 |
| `results` | a workflow's: what its launcher reads, `output` (the default) or the whole `run` |

Base and markup both 0 is free. The RESERVE a run needs is derived, never
set: `base + markup × capUsd`. Changing the list publishes no version.
`missing` reports a runnable workflow or step that is not here, like any
other. The save checks every item, and refuses with a `400` naming each one
it refuses (`{ error, problems: [...] }`, `error` the problems joined by
`; `), writing nothing:

- it exists and is not sealed, and a workflow's closure reaches nothing
  sealed (a subflow's grader, a `meta/*` grant);
- a step is not `agent`, `llm`, `exec`, `acp/prompt`, `graph/walk` (a
  stranger runs one inside a workflow: the workflow is the unit of spend),
  `meta/*`, nor one of the runner's containers, `subflow`, `loop`,
  `foreach`, `if` (a stranger's config would choose what they run), nor one
  whose config names a secret — a `secretsEnv`, `tokenSecret`,
  `storageStateSecret` or `secrets` field (`git/*`, `browser/open`,
  `http/verify`): a stranger would choose which secret it reads;
- a workflow declares an `input:` block (§2);
- a `markup` has a `capUsd`;
- a priced item has a wallet (§18, or the host's own `services.lightning`);
- a workflow whose closure calls a model (`agent`, `llm`, `acp/prompt`,
  `graph/walk`, or a closure strut cannot read in full) has someone to pay for a stranger's
  run — its owner, or the host's `createStrut({ publicRuns: { principal } })`
  — and, when it is free, a `dailyCapUsd`;
- every number is finite and not negative.

`GET /public-view/runnable` answers, for the dialog's third box:

```json
{
  "kind": "workflow", "name": "cve/summarize",
  "can": { "spends": true, "acts": false, "code": false },
  "costs": { "days": 30, "runs": 5, "measured": 5, "average": 0.264, "highest": 0.58 },
  "input": true, "owner": "tom-1", "wallet": false, "gateway": false
}
```

`can` is the store's chips over the live closure (`spends`: a model call;
`acts`: a step with `effect: "write"`; `code`: `exec`, a custom step, or an
agent that has `bash`); a closure strut cannot read in full is all three.
`costs` is what its runs on this server cost over the last 30 days, in
dollars, from run summaries (`RunSummary.totals`): `runs` counts every run
in the window, `average` and `highest` are over the newest 200 finished
(`measured`). A step's are its KEPT runs (`step:<type>`: a `run_step` with
claims or `keep`, an app's writes); a step called inside a workflow counts
as the workflow's, so most steps show none. `input` (a workflow's) says
whether it declares an `input:` block; `owner` is the workflow's, `principal`
the host's; `wallet` whether one is set; `gateway` whether model calls go
through the Mothership's gateway, which stops a run at its cap. `404` for
an item not here.

`needs` answers with every line pre-checked or not, each with what it
shows anyone (`note`):

```json
{
  "app": { "name": "bench", "version": "v3", "title": "Bench" },
  "workflows": [{ "name": "openlaw-run", "runs": true, "checked": true, "note": "…" }],
  "steps": [{ "name": "openlaw/_shared-user", "checked": true, "note": "…" }],
  "reads": [{ "name": "sheets/get-values", "checked": false, "note": "calls Google Sheets with this server's credentials: …" }],
  "concepts": [{ "name": "Law", "pages": 27, "from": ["openlaw-run"], "checked": true, "note": "…" }],
  "perRun": ["job: a Concept named per run ({{ input.kind }})"]
}
```

An app brings the workflows it grants (with their runs: the page reads
them), the custom steps those workflows and their subflows run, its granted
reads (pre-checked when the step declares `effect: "read"`), and the
Concept roots its workflows read with `context/concept { name }` — a
literal, or `{{ params.X }}` off the flow's params; a name from the input is
`perRun`. A workflow alone brings its steps and roots, its runs unchecked.

### 17.2 The reads — `GET /public/*` (anyone)

Served from the record alone, whatever the gate's mode: a host's gate in
front of an unkeyed strut (mcp's `/lab`) passes the prefix by path. Each
answer carries `access-control-allow-origin: *` (a preflight is answered
too) and no cookie; each visitor address may make 1200 requests a minute
(the first `x-forwarded-for` hop, else the socket; `429` past it). Paths
and shapes mirror the private routes, minus what a visitor never reads:
who launched, owns or changed a thing, schedules, the job and conversation
a run belonged to, callback and MCP origins. Anything not on the record is
a `404`, as if it were not there.

| Route | Answer |
| --- | --- |
| `GET /public` | `{ workflows: [{ name, activeVersion, versions, description?, category?, runs }], steps: [{ type, source, description?, effect? }], concepts: [{ name, description?, pages }], types, apps: [{ name }], runnable: [{ kind, name, description?, base, markup, capUsd, reserve, results, input, recent }] }` — the roots, with how many pages each holds; what anyone may run (below) |
| `GET /public/workflows[?q=]` | the public workflows, as above |
| `GET /public/workflows/:name` | `{ name, active, category?, runs, versions: { vN: { createdAt, description?, hash, source? } } }` |
| `GET /public/workflows/:name/versions` | `{ active, versions: [{ version, createdAt, description?, source? }] }` newest first |
| `GET /public/workflows/:name/flow[?version=]` | `{ name, steps, input?, params?, sealed?, peer? }` (§2) |
| `GET /public/workflows/:name/:version` | the version's YAML (`text/yaml`) |
| `GET /public/workflows/:name/runs[?limit=&before=]` | with `runs: true`: a page of summaries (§5.1) |
| `GET /public/workflows/:name/runs/:runId` | the summary, or the partial one of a run in flight (§5.2); with a run token, the launcher's view (§17.4) |
| `GET /public/workflows/:name/runs/:runId/events` | the events (§5.3); an agent session is a `transcript` link under `/public` |
| `GET /public/workflows/:name/runs/:runId/transcripts/<step path>` | that session's messages (never `?full=1`: a thread's earlier turns may be another run's) |
| `GET /public/workflows/:name/runs/:runId/files[/<path>]` | the run's own files (its artifacts directory; a job's directory is not public), served sandboxed like `/artifacts/:runId` (§5), no script |
| `GET /public/steps` | `[{ type, source, description?, effect? }]` |
| `GET /public/steps/:type/schema` | `{ type, description?, effect?, secrets?, fields, output }` — `secrets` are names |
| `GET /public/steps/:type/source` | `{ type, source, origin, helpers: [{ name, source }] }` — the `_`-prefixed files its relative imports reach |
| `GET /public/steps/:type/versions`, `/version/:version` | as `/steps/:type/…` (§8) |
| `GET /public/concepts[?q=]` | `{ concepts: [{ ref_id, name, description?, parent?, root }] }` — every page of every public tree, roots first; `q` words must each hit the name or description |
| `GET /public/concepts/:name` | `{ ref_id, name, properties, parent?, root, children: [{ name, description? }] }` — `properties.docs` is the page |
| `GET /public/graph/nodes/:ref_id` | as `/graph/nodes/:ref_id` (§9), for a VISIBLE node |
| `GET /public/apps` | `[{ name, version, title, description?, icon? }]` — each at the version the public view serves |
| `GET /public/apps/:name` | one of them |
| `GET /public/apps/:name/document` | the page: that version's `dist/index.html` with a VISITOR's identity in `<meta name="strut-app-token">` and `<meta name="strut-public-view" content="1">` beside it |

`runnable` lists every item of the record's `runnable` that is here and
not sealed, whether or not its definition is public (its YAML is never
shown there): prices in dollars, `capUsd` null when the item sets none,
`reserve` the credit a run needs to start (`base + markup × capUsd`),
`results` `output` unless the item says `run`, `input` the workflow's
`input:` block or the step's input JSON Schema (draft 2020-12, the input
view: a field with a default is not `required`; what §17.6's `config` is
built from), and `recent` the ledger's
last 30 days for it (`{ days, runs, average }`: public runs, and the
average charge in dollars).

The run routes (`…/runs/:runId`, `/events`, `/transcripts/…`, `/files…`)
also answer a launcher's RUN TOKEN for a public run of theirs whose
workflow's runs are not public (§17.4).

A node is visible when it is a Concept under a public root, a node a run
of a workflow with public runs NAMED (its steps' `step.end.nodes`; another
strut's refs never), or a node of a public type. An edge is visible when
both ends are. The trees are walked live, at most every 30 s.

### 17.3 A public app — `POST /public/mcp` (anyone)

strut's UI hosts a visitor's page at `?app=<name>&solo=1&public=1`: the
document from §17.2, framed as for any app (§14.3), its tools/call relayed to
`POST /public/mcp` with no credential. The door serves `step_run` alone
(app-only, as on `/mcp`, §14.1). Its `app` argument must be the VISITOR's
identity the public document carries — `app:<name>@<vN>.<token>`, the
token signed over `public-app:<name>@<vN>` (`publicAppIdentity`, auth.ts),
which opens this door for that app and nothing else: never `/mcp`, never a
file route's `?t=`; the private identity opens nothing here. Each call is
checked against the app's grants as always, then against the public view
(`visitorRefusal`, src/public-surface.ts), every refusal a sentence a page
can show:

| Call | |
| --- | --- |
| an app not in the public view, or another version than the one it serves | refused |
| `run/list`, `get`, `events`, `transcript`, `files`, `provenance` | a workflow in the public view WITH its runs; `run/workflow` one in it at all; `run/transcript { full }` refused; a job run's files refused |
| `graph/graph-get`, `graph-get-batched`, `graph-search`, `graph-neighbors`, `graph-edges` | through a reader that sees only visible nodes (§17.2) |
| `run/launch`, `run/cancel`, `job/*`, `app/*` (state and error reports included), any other `graph/*` | refused: a visitor starts and keeps nothing |
| anything else granted | only when the app's `reads` name it |

The step runs with NO actor and a bag of reads alone: `http`, `secrets`
(the deployment's, for a read a person ticked), the graph's filtered reader
(no writers, no raw query), and the runs capability held to the public view
(records without actor, principal, job, `startedBy`, callback or MCP
origin; a deliverable's link rewritten under `/public`). Nothing else is on
it, so a step that reaches for a write, a shell or a file fails naming it,
and nothing is kept as a run. The visitor's address counts against §17.2's
budget, and the app's usage (§14.6) counts the call under `visitor <address>`.
In the page, the kit's `useHost().public` is true (it reads the meta), so it
disables what would only fail (it never hides it): strut/views' `LaunchForm`
renders with every control off and a line saying runs are started by the
people who keep the server.

### 17.4 A public run — `POST /public/workflows/:name/run` (anyone)

What anyone may START (`plans/paid-runs.md` §3, §6, §7; `src/public-runs.ts`):
a workflow in the record's `runnable` (§17.1). A free launch carries no
credential — a key or a session sent is ignored; a PRICED one carries a
CREDIT TOKEN, `Authorization: L402 <macaroon>:<preimage>` (§17.5) — and
answers with a RUN TOKEN, the launcher's receipt for that one run. Open by
name in the gate, like `POST /public/mcp`, whatever its mode; CORS as §17.2
(a preflight allows `authorization`; `WWW-Authenticate` and `Retry-After`
are exposed to a browser's script).

| Route | |
| --- | --- |
| `POST /public/workflows/:name/run` | `{ input?, key? }` → `202 { runId, token, credit? }` (`existing: true` when `key` named a run of this caller's: one in flight, or — with a credit token — any run that token and key launched); priced with no token, or one short: `402` (§17.5) |
| `GET /public/workflows/:name/runs/:runId` | with the run token (`?t=` or `Authorization: Bearer`): the launcher's view; `?wait=<s>` holds while the run is in flight, at most 55 s |
| `POST /public/workflows/:name/runs/:runId/cancel` | with the run token: cancels that run and the runs it started; `202 { ok, runId, state }`, `409` when it already ended |

A launch is checked in this order, each step answering before the next
costs anything:

1. **The address's budget**, 60 launches a minute (beside §17.2's 1200
   requests), `429` past it.
2. **The item**: a workflow not in `runnable` (or sealed since) is `404`.
3. **The drain** (§8.1): `503` with `Retry-After`.
4. **The body**, at most 256 KB (`413`): a JSON object with `input` and
   `key` alone — `params`, `job`, `callback`, `attachments`, `settings` or
   anything else is a `400` naming it — and `input` validated against the
   workflow's `input:` block (`400`). `key` is 1 to 200 characters. A
   workflow disabled, or one whose active version no longer declares an
   `input:` block, is `409`.
5. **The caps**, `429` with `Retry-After`: the server's limit on public runs
   in flight (`STRUT_PUBLIC_RUNS_MAX`, 10 by default; `Retry-After: 30`),
   then the item's `dailyCapUsd` — today's cost of its public runs (UTC,
   from the ledger) plus the cap of each of its runs in flight, reaching it
   refuses the launch (`Retry-After` until midnight UTC when the day is
   spent, else 60). The check and counting the new run are one step, so
   launches at once never pass the cap together. A `key` this caller sent
   for a run still in flight returns that run, before any cap: the caller
   is the credit token on a paid launch, else the address.
6. **The price** (§17.5): a free item goes on. A priced one reads the
   credit token BEFORE the caps — what it may be used for is known without
   the wallet: a token that does not verify is `401 invalid_token`, one a
   holder limited to other items `403 token_not_for_this`, one whose holder
   capped a run below this item's reserve `403 token_over_max_charge`.
   After the caps: no token, a token past its end, one replaced by a newer
   (`reason: "replaced"`), or one whose free credit is under the item's
   RESERVE (base + markup × `capUsd`) is a `402` challenge — for the
   SHORTFALL, carrying the token's credit to the new one, when the token
   presented was not narrowed; for the whole reserve otherwise. A token's
   first use asks the wallet (`503` when it cannot); a good token has the
   reserve set aside under the run's id. The same token and `key` as an
   earlier launch return that run and set nothing more aside. The `202`
   carries `credit: { held_usd, remaining_usd, remaining_sats, expires }`.
7. **The run**, detached.

The run is the workflow AS PUBLISHED — the active version, no `params`, no
settings — with `origin: "public"` on `run.start` and its summary, no actor,
and no job (a `job/dir` step gets the run's own directory). Its principal is
the host's `createStrut({ publicRuns: { principal } })`, else the
workflow's owner. Every agent session it opens is `public/<runId>/<id>` —
a paid run's `public/<token id>/<id>` — whatever id its input names; a paid
run's `run.start` names its token as `credit` (never shown to a visitor).
It is verified like any other run. Its CAP is
the smallest of the item's `capUsd`, the workflow's own (`maxRunCostUsd`,
else `STRUT_RUN_MAX_COST_USD`, else $100) and what is left of the daily cap:
recorded on `run.start` as `maxCostUsd`, and carried by the Mothership's
run link, so the gateway stops the run there (without a gateway nothing
stops it mid-flight; the daily cap bounds the day). When it ends — success,
error, cancelled, or finished by a durable resume after a restart — the
ledger records it: a free run is charged nothing and its cost counts in the
day; a paid run is charged its token by the rule — base + markup × cost, at
the price of its launch; a run that FAILED its cost, no markup and no base,
and never more than its reserve — never more than the token holds, and the
rest of its reserve is free again. What is not yet charged is kept in
`<dataDir>/payments/public-runs.json` and charged at the next boot (a run
cut off that nothing resumed, at what its log spent, as an error), and so
is a hold the ledger keeps for a run that file lost (at the item's price
now); the ledger records a run once.

**The run token** is an HMAC over `public-run:<workflow>/<runId>` under the
API key (else `STRUT_SECRET_KEY`, else a key the process makes, which a
restart forgets). It opens that run's `/public` reads and its cancel, and
nothing else: no private route takes it, nor another run's. A wrong token
reads as a run that is not there (`404`).

**The launcher's view** (`GET …/runs/:runId` with the token):

```json
{
  "runId": "1800000000000", "workflow": "cve/scan", "status": "success",
  "startedAt": "…", "finishedAt": "…", "durationMs": 4200, "origin": "public",
  "input": { "package": "lodash" }, "output": { "artifacts": [ … ] },
  "totals": { "modelCalls": 3, "usage": { … }, "cost": 0.042 },
  "artifacts": [{ "id": "report", "title": "Report", "url": "/public/workflows/cve%2Fscan/runs/1800000000000/files/report.md" }],
  "charged": 0
}
```

`charged` (dollars) appears once the run ended and was charged, as the
ledger recorded it: `0` for a free run, whose cost (`totals.cost`) the
seller carried. `artifacts` are the
declared ones, a file here at its `/public` link (add `?t=<token>`). What
else the launcher reads is the item's `results`: with `output` (the
default) the view above, without step counts or an error's stack, and the
declared files alone (`…/files` lists them; any other file, the events and
the transcripts are `404`); with `run`, the summary, events, transcripts and
every file as §17.2 serves a public run's. A workflow whose runs are public
(§17.1) shows them whole to anyone, token or not.

### 17.5 Credit — the L402 token a priced run spends (anyone)

A priced item is paid from a CREDIT TOKEN (`plans/paid-runs.md` §4, §5;
`src/l402.ts`, `src/public-credit.ts`): a bearer L402 credential bought over
Lightning, holding credit in dollars, charged by each run it pays for.
Nothing identifies its holder.

| Route | |
| --- | --- |
| `GET /public/credit` | with `Authorization: L402 <macaroon>:<preimage>` (or `LSAT`): the token's balance, below. A token never used is used here (the wallet asked once) |
| `POST /public/credit` | `{ usd }` (0.01 to 1000) or `{ sats }`: a `402` challenge for that much credit — more than one run's reserve. A token presented that was not narrowed carries its free credit to the new one. `404` on a server that prices nothing |
| `POST /public/credit/claim` | `{ macaroon }`, or `Authorization: L402 <macaroon>`: `{ state: "pending" }`, `{ state: "expired" }`, or `{ state: "settled", preimage, credential: "<macaroon>:<preimage>", msat }` — for a payer whose wallet never hands over the preimage (a phone paying a QR). 120 a minute an address |

The two POSTs are open by name in the gate, like a launch. On a server that
never priced anything (no `L402_ROOT`), `GET /public/credit` and `claim`
are `404`.

**The challenge** (`402`; a launch's, or `POST /public/credit`'s):

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"

{ "error": "payment_required", "usd": 7.5, "sats": 7500,
  "rate": { "usdPerBtc": 100000, "at": "…", "source": "mempool.space" },
  "invoice": "lnbc…", "macaroon": "<base64>",
  "description": "acme/voxel/character: credit for one run",
  "expires": "…", "remaining_usd": 0, "reason": "short", "carries": true }
```

`usd` is what is missing, turned into `sats` at the rate now (rounded up;
§18's rate, `503 rate_unavailable` with none fresh enough). The invoice
lasts ten minutes. The macaroon LOCKS the quote: what was paid buys `usd`
of credit whatever the rate is when it is first used. `reason` (`short`,
`expired`, `replaced`) says why a presented token did not do; `carries`,
that the new token inherits its free credit at its first use (and anything
its runs in flight free later). Nothing is stored for a challenge; minting
invoices has its own allowance, 20 a minute an address (`429
too_many_invoices`). With no wallet, or one that cannot be reached, the
answer is `503 wallet_unavailable`, never `402`.

**Paying:** pay the invoice with any Lightning wallet, then retry with
`Authorization: L402 <macaroon>:<preimage hex>`. The first time strut sees
a token it asks the wallet whether its invoice settled (`503
payment_pending` while it has not) and credits it in proportion to what
settled. A token lasts a year (`expires`); past it, a launch is a `402`
(`reason: "expired"`) and what was left is the seller's.

**The macaroon** is libmacaroons v2 binary, base64 — any macaroon library
reads it and appends a caveat. Its identifier is L402's (version 0, the
payment hash, a token id). Strut writes five first-party caveats:
`services=strut:0`, `strut_sats`, `strut_credit` (micro-dollars),
`strut_valid_until` (unix seconds), `strut_carry` (a token id, or `none`).
A HOLDER may append, before handing a token to someone else:

| Caveat | Means |
| --- | --- |
| `strut_capabilities=workflow:<name>,step:<type>,…` | only these items (`403 token_not_for_this`) |
| `strut_max_charge=<micro-dollars>` | no run or call whose reserve is above it (`403 token_over_max_charge`) |
| `strut_valid_until=<unix>` | an earlier end for this copy |
| `services=…` | must still name `strut:0` |

Every caveat must hold, so a repeat only narrows. Any other caveat — one
strut does not know, a third-party caveat, or strut's own written again —
refuses the token (`401 invalid_token`). A narrowed token is never carried
from: its top-up starts a balance of its own.

**The balance** (`GET /public/credit`):

```json
{
  "token": "<64 hex>", "paid_usd": 10, "spent_usd": 2.5, "held_usd": 4.5,
  "remaining_usd": 3, "remaining_sats": 3000, "rate": 100000, "bought_sats": 10000,
  "created": "…", "expires": "…", "expired": false, "replaced": false,
  "entries": [{ "seq": 7, "at": "…", "kind": "charge", "usd": 2.5, "subject": "workflow:two", "runId": "…", "cost_usd": 2, "outcome": "success" }, …]
}
```

`paid_usd` is its payment and what it inherited; `spent_usd` its charges
and what it handed on or lost to its end; `remaining_*` is 0 once it is
replaced or past its end. `entries` are the newest 50: `payment`, `hold`,
`charge`, `carry` (− out, + in), `expiry`.

### 17.6 A public tool — `POST /public/steps/:type/run` (anyone)

A STEP in the record's `runnable` (§17.1) is called once and answers at
once (`plans/paid-runs.md` §3, §6; `src/public-tools.ts`): what the tool
returns is what its publisher sells. Free, or charged by the rule against a
credit token (§17.5). Open by name in the gate, like a launch; CORS as
§17.2.

| Route | |
| --- | --- |
| `POST /public/steps/:type/run` | `{ config }` → `200 { output, credit? }`; priced with no token, or one short: `402` (§17.5) |

A call is checked in this order, each step answering before the next costs
anything:

1. **The address's budget**: 120 calls a minute, its own (beside §17.4's 60
   launches and §17.2's 1200 requests); a priced call's `402` round trip
   counts. `429` past it.
2. **The drain** (§8.1): `503` with `Retry-After`.
3. **The body**, at most 256 KB (`413`): a JSON object with `config` alone
   (`400` naming anything else).
4. **The item**: a step not in `runnable` is `404`, and so is one the save
   would refuse NOW (§17.1) — sealed since, gone, one that spends or runs a
   shell or other steps, or one whose config names a secret: the registry
   changes after a save.
5. **The config**: an object (absent is `{}`), parsed by the step's own
   input schema (`400` naming the field: `config.cost: …`). One that names
   a secret (`secretsEnv`, `tokenSecret`, `storageStateSecret`, `secrets`)
   is a `400`. A value may hold anything, `{{` included: the config is the
   run's INPUT and the step reads each key as `{{ input["k"] }}`, a sole
   expression the runner returns as it is — nothing a stranger sends is
   evaluated.
6. **The price's token** (a priced step), as a launch's: `401
   invalid_token`, `403 token_not_for_this` (a holder's
   `strut_capabilities` without `step:<type>`), `403 token_over_max_charge`.
7. **The caps**, `429` with `Retry-After`: the address's share of the calls
   in flight (5), the server's limit (20), then the item's `dailyCapUsd`
   when it sets one — today's cost of its calls plus each call in flight at
   its cap (`capUsd`, else the whole daily cap), as a run's. A free step
   needs no daily cap at the save: a runnable step cannot be one that
   spends.
8. **The price**: as a launch's — no token, one past its end or replaced,
   or one short of the RESERVE (`base + markup × capUsd`) is a `402`, for
   the shortfall and carrying when the token was not narrowed; a token's
   first use asks the wallet (`503` when it cannot); a good token has the
   reserve set aside under the call's id. There is no `key`: a call answers
   at once.
9. **The call**: the step run once, for at most 60 s — past it the call is
   stopped and answers `504 timeout` — never kept as a run, nothing in the
   run store, not verified, projected or sent to an events sink; the
   ledger's entry is its record. No actor; the host's
   `createStrut({ publicRuns: { principal } })` as its principal; the
   item's `capUsd` (or what is left of the day) as its cap, carried to the
   Mothership as a run's is.
10. **The charge**, by the rule: base + markup × what the call reported it
    cost (`withUsage`); a call that reports none, its base. A call that
    THREW, ran out of time, or whose result is over 5 MB as JSON is charged
    its cost — no markup, no base — and answers `500` with `code`
    `step_failed` (its error, cut at 2000 characters) or `result_too_big`,
    or the `504`. A lib step that answers a failure as text for a model
    (`graph/*`'s "node not found", `sheets/*`'s API errors) fails the call
    here (`step_failed`). Never more than the reserve, nor what the token
    holds. A free call is charged nothing, and its cost counts in the day.
    A charge the ledger refuses is tried again (every 30 s, for an hour);
    the answer stands meanwhile.

```json
{ "output": { "cves": [ … ] },
  "credit": { "charged_usd": 0.6, "remaining_usd": 4.4, "remaining_sats": 4400, "expires": "…" } }
```

`credit` is a priced call's: what this call was charged and what the token
holds after it; a `500` or `504` carries it too. The token's balance
(§17.5) lists the call as a `hold` and a `charge` on `step:<type>`.

**What the step runs against** is an allowlist (decision 15): the visitor's
(§17.3) — `http`, `secrets` (the keys its publisher's step reads by name in
its own code; a step whose config names one is never callable), the runs
held to the public view — with two differences:

- **The graph is the whole graph's, read-only**, not the public view's (on
  a host that set `graphReaders`, the `jobs` list), so a tool answers from
  a graph that is not public. Its reader, dialect and schema reads pass, and
  a raw query READS: on the engine's own read-only path (a READ transaction
  on Neo4j, a `READ ONLY` connection on a Ladybug file) after the write
  keyword check, and only for a list that reads every namespace, as any
  view's — so `graph/find` works. Its writers, a transaction and every
  write through the schema refuse; the engine's handles are not on it.
- **`http` reaches no private address**: `http(s)` only, never loopback,
  private, link-local (the cloud's metadata service), multicast or
  reserved, nor a name that resolves to one, redirects checked hop by hop,
  each request at most 30 s. A tool that fronts a service on the server's
  own network is a workflow.

There is no shell, no artifacts, no jobs, no sessions, no peers, no MCP,
no browser and no wallet: a step reaching for one fails. Not a sandbox: a
step whose publisher made it callable may still reach past `ctx.services`
— its own connection from a secret its code names.

**A restart between a call's hold and its charge** leaves the hold open,
and the call never answered: the next boot frees it, a charge of nothing
that the day counts as a failed call.

## 18. The wallet — what the server receives with (`plans/paid-runs.md` §9)

The wallet a server sells with: the Sphinx daemon (the treasury) or an NWC
connection. Its credentials live in `payments.json`, an encrypted file of
their own beside `peers.json`, which no step reads (decision 20); its
RECEIVE side is `ctx.services.lightning` (`src/payments/lightning.ts`) while
one is set. Set from the environment at boot (`LIGHTNING_DAEMON_URL`,
`LIGHTNING_DAEMON_TOKEN`, `LIGHTNING_DAEMON_PAY_TOKEN`, or
`LIGHTNING_NWC_URL`, `LIGHTNING_NWC_PAY_URL`; the environment sets it again
at every boot) or here. What strut expects of each wallet is
`specs/LIGHTNING.md`.

FULL SCOPE only: the deployment key or an admin's session. A member's
session, a peer and a person token are refused (`403`), reads included.
Both routes answer `501` when the host brought its own `services.lightning`.

| Route | |
| --- | --- |
| `GET /earnings/wallet[?check=1]` | which wallet is set and what it can do, never a credential; `check=1` also reads its balance |
| `PUT /earnings/wallet` | set it, change it, or remove it; answers as `GET` does, with `check` |

```json
{ "provider": "sphinx", "receive": true, "pay": true, "url": "http://treasury:3000",
  "from": "api", "setAt": "2026-11-10T18:50:08.000Z",
  "check": { "ok": true, "msat": 1250000 } }
```

`provider` is `sphinx`, `nwc` or `null` (none: `receive` and `pay` false).
`receive`: a receive credential is on file, so the server can sell. `pay`:
a pay credential is on file, so Withdraw can pay (item 7). `url` is the
daemon's (no credential in it); for NWC, `relays` lists the relays' hosts
instead, since the connection URL is the credential. `from` is `env` or
`api`. `note` says when the environment names a wallet, which replaces this
one at the next boot. `check` is `{ ok: true, msat }` or `{ ok: false,
error }`, the wallet's balance read within 5 s; a failed check never
refuses the save.

`PUT` bodies:

```json
{ "provider": "sphinx", "url": "http://treasury:3000", "token": "<receive token>", "payToken": "<pay token>" }
{ "provider": "nwc", "url": "nostr+walletconnect://…", "payUrl": "nostr+walletconnect://…" }
{ "provider": null }
```

For the provider already on file, a field left out keeps what is on file
(a pay credential added without typing the receive one again) and `null`
removes a pay credential (`payToken`, `payUrl`); another provider needs
every field. `400` for a body that is not one of these, a daemon URL that
is not http(s) or carries a credential, an NWC URL that does not parse, or
a pay credential equal to the receive one; what is on file stays.

`PUT /secrets/LIGHTNING_…` is refused (`400`): a wallet credential never
goes in the deployment's secrets, and the secrets capability answers
nothing for any `LIGHTNING_*` name, wherever it is held — nor for
`STRUT_SECRET_KEY`, which decrypts `payments.json`.
