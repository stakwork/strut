# HTTP API — workflows and runs

How a client publishes a workflow, runs it, follows the run, and reads it
back. Every shape below is the one the server sends today; the types it is
lifted from are named so the two can be kept together (`src/core.ts`,
`src/store.ts`, `src/workspace.ts`, the routes in `src/createStrut.ts`).

Everything is JSON unless a row says otherwise. An error is
`{ "error": "<message>" }` with a 400 / 404 / 409 / 401 status. Companion
how-tos: `CALLBACKS.md` (the result pushed to your endpoint),
`RUN_CONTROL_SPEC.md` (why control is cooperative), `SPEC.md` (the engine).

## Auth

With `STRUT_API_KEY` set there are **no public endpoints**: every request in
this document — reads, runs, streams, transcripts, artifacts — needs
`Authorization: Bearer <STRUT_API_KEY>`, and gets a `401` without it. Where a
header cannot be set (a link, an `<img>`, the dictation socket) the key may
ride as `?key=` instead. Unset (dev mode) everything is open. The only
things served without the key are the web UI's own files and `GET /health`
(§8). The examples below leave the header out for brevity; add
`-H "Authorization: Bearer $STRUT_API_KEY"`.

`x-strut-actor: <id>` names who a request is from — honored only alongside a
matching key — and is recorded on the run (`actor`, `principal`) and on the
workflow it publishes (`owner`). AGENTS.md "Auth" has the whole model.

## 1. Publish

| Method | Path                | Body                                                                 | Response |
| ------ | ------------------- | -------------------------------------------------------------------- | -------- |
| POST   | `/workflows`        | `{ name, steps \| yaml, input?, params?, claims?, description?, category? }` | 201 `{ ok, workflow, version: "v1", active: "v1", renamed, requested, claims? }` |
| POST   | `/workflows/:name`  | `{ version, steps \| yaml, input?, params?, claims?, description? }`          | 201 `{ ok, workflow, version, active, claims? }` |

- `steps` is an array of step objects (below) and the server writes the YAML;
  `yaml` is the whole file as text, `input:` / `params:` / `claims:` blocks
  included. One or the other.
- A create whose `name` is taken gets a suffixed name: `renamed: true`,
  `requested` is what you sent, `workflow` is what was stored.
- `version` is your label (`v2`). A new version becomes active. Reusing a
  label **overwrites** that version's content; the same content under a new
  label is a second version with the same `hash`.
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
| GET    | `/workflows`                    | `[{ name, activeVersion, versions: ["v1", …], description?, category?, publisher?, owner?, maxRunCostUsd?, automations?, lastRunAt? }]` |
| GET    | `/workflows/:name`              | `{ active, versions: { "v1": { createdAt, description?, hash? }, … }, category?, publisher?, owner?, maxRunCostUsd?, automations? }` (`WorkflowMetadata`) |
| GET    | `/workflows/:name/flow[?version=]` | `{ name, steps, input?, params?, promotes? }` — the parsed active (or named) version |
| GET    | `/workflows/:name/versions`     | `{ active, versions: [{ version, createdAt, description?, runs, success, error, lastRunAt? }], unattributed }` newest first; counts by the run's recorded `workflowHash` |
| GET    | `/workflows/:name/:version`     | the YAML source, `text/yaml` |
| PUT    | `/workflows/:name/active`       | `{ version }` → `{ ok, workflow, active }` — rollback; publishes nothing |
| DELETE | `/workflows/:name`    | `{ ok, workflow }` — every version, metadata, schedules and run records; 409 while a run is in flight |

## 3. Run

| Method | Path                            | Body | Response |
| ------ | ------------------------------- | ---- | -------- |
| POST   | `/workflows/:name/run`          | `{ input?, params?, paramOverrides?, runId?, callback? }` | 202 `{ runId, callback?: true }` |
| POST   | `/workflows/:name/:version/run` | same | same |

| Field            | Meaning |
| ---------------- | ------- |
| `input`          | the run payload, validated against the workflow's `input:` block (unknown keys dropped); `{}` when omitted |
| `params`         | shallow-merged over the workflow's `params:` defaults for this run only |
| `paramOverrides` | `{ "<workflow name>": { … } }` — the same, per workflow, reaching subflows |
| `runId`          | your own id (unique within the workflow); default a millisecond timestamp, e.g. `"1790436489808"` |
| `callback`       | `{ url }` (http/https) — the result is POSTed there when the run settles; see `CALLBACKS.md`. Any other scheme is a 400 and nothing launches |

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
- A resumed run appends past its old terminal event; a tail open at the
  time keeps following.
- **An unknown run id never errors: the tail waits for its log to appear.**
  Launch first, or check `GET …/runs/:runId`, before streaming an id you
  did not just get from a 202.

```js
const es = new EventSource(`${BASE}/workflows/hello/runs/${runId}/stream`);
es.onmessage = (m) => console.log(JSON.parse(m.data));           // each event
es.addEventListener("done", (m) => { console.log(JSON.parse(m.data)); es.close(); });
```

## 5. Read a run

| Method | Path                                                   | Response |
| ------ | ------------------------------------------------------ | -------- |
| GET    | `/runs/active`                                         | every run executing in this server process, any workflow: `[{ workflow, runId, state, parentRunId? }]` — `state` a §5.2 live state, `parentRunId` on a nested run. A `stale` run is not listed |
| GET    | `/workflows/:name/runs`                                | array, newest first, no paging: a summary (§5.1) per finished run, `{ runId, workflow, status }` for one still going (§5.2 states) |
| GET    | `/workflows/:name/runs/:runId`                         | the summary (§5.1); a partial one (§5.2) while the run is going or if it died before finalizing; 404 only when there is no log at all |
| GET    | `/workflows/:name/runs/:runId/events`                  | every event, in order (§5.3) |
| GET    | `/workflows/:name/runs/:runId/transcripts/<step path>` | one agent session as a bare array of AI SDK model messages; 404 if that step recorded none. For a step that continued a `session` (§9) this is its system prompt + THAT TURN; `?full=1` is the thread up to and including it (404 once the session is deleted) |
| GET    | `/workflows/:name/evidence[?runId=&limit=&before=]`   | what the checks said about the workflow's runs (§5.4) |
| GET    | `/artifacts/:runId`                                    | `{ runId, files: ["report.md", …] }` — what the run's steps wrote; 501 when the deployment has no artifact store |
| GET    | `/artifacts/:runId/<path>`                             | the file, content-typed by extension (unknown → `application/octet-stream`), with `X-Content-Type-Options: nosniff`. A step wrote it, so everything but `video/*` and `audio/*` also carries `Content-Security-Policy: sandbox`: opened in a browser it runs no script and has no origin — an HTML artifact is a static page. A host that frames or proxies artifacts must keep both headers |

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
| `actor`, `principal` | who launched it and who is billed, when known |
| `automation`   | `{ id }` when a schedule fired it |

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

| Type              | Meaning |
| ----------------- | ------- |
| `run.start`       | first line; carries `input`, `workflowHash`, `stepHashes` (custom step versions), `params` / `paramOverrides`, `actor` / `principal`, `origin` (`schedule` / `verify`), `automation`, `callback: { origin }`, `parentRunId` when nested |
| `step.start` / `step.end` / `step.error` | one execution; `step.error` is final, after retries |
| `step.retry`      | an attempt failed and another follows |
| `step.skipped`    | not run: its `when` gate did not match, or every step it depends on was skipped |
| `run.end`         | terminal, success; `output` |
| `run.error`       | terminal, failure; `error` |
| `run.cancelled`   | terminal, cancelled |
| `run.cancelling` / `run.paused` / `run.resumed` | control markers (§6); not terminal. `run.resumed` reopens a log after a terminal event |
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

## 6. Control a run

### 6.1 Live: cancel, pause, resume

| Method | Path                                      | Response |
| ------ | ----------------------------------------- | -------- |
| POST   | `/workflows/:name/runs/:runId/cancel`     | 202 `{ ok, runId, state }` |
| POST   | `/workflows/:name/runs/:runId/pause`      | 202 `{ ok, runId, state, quiesced }` |
| POST   | `/workflows/:name/runs/:runId/resume`     | 202 `{ ok, runId, state, resumed: "in-memory" }` |

404 when there is no such run; 409 when it is not live — already terminal
(`Run already terminal (success)`) or `stale`.

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
(`RunStepResult`): its events at `__run_step__/step`, `recorded` the number
of service calls a cassette captured. The run is kept (`kept:
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
`automation: { id }`.

| Method | Path                                      | Description |
| ------ | ----------------------------------------- | ----------- |
| GET    | `/automations[?workflow=]`                | `[{ …automation, summary, nextRunAt, lastRun, running }]` |
| POST   | `/automations/preview`                    | `{ trigger }` → `{ summary, next }` (the next five fires); writes nothing |
| POST   | `/workflows/:name/automations`  | `{ name, trigger, input?, enabled? }` |
| PATCH  | `/workflows/:name/automations/:id` | any subset; `{ enabled: false }` pauses |
| DELETE | `/workflows/:name/automations/:id` | remove |
| POST   | `/workflows/:name/automations/:id/fire` | run now → 202 `{ runId }`; 409 while its previous run is going |

`GET /health` → `{ ok, dataDir, stepCount }`; without the key, `{ ok: true }`
and nothing else — the one route a keyless probe may call.

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
| `session_full:` | the thread has no room left in the model's window — start a new session |
| `session_mismatch:` | the thread began on another provider, or on the other side of the LLM gateway |
| `workdir_busy:` | another run holds the working copy |

| Method | Path | Response |
| ------ | ---- | -------- |
| GET    | `/sessions` | `{ sessions: [{ id, turns, messages, createdAt, updatedAt, createdBy?, provider, model, context?: { used, limit }, busy? }] }`, newest first |
| GET    | `/sessions?id=<id>` | that summary + `turnLog: [{ turn, at, workflow, runId, path, actor?, principal?, provider, model, routed, offset, count, usage, cost, context? }]`; 404 |
| GET    | `/sessions/messages?id=<id>` | the thread, a bare array: the system message, then every message; 404 |
| DELETE | `/sessions?id=<id>` | `{ ok: true }`; 409 while a turn holds it |

400 for a malformed id; 501 when the host
injected its own `sessions` capability.

### Graph nodes

| Method | Path | Response |
| ------ | ---- | -------- |
| GET    | `/graph/nodes/:ref_id` | `{ ref_id, node_type, name, properties }` — the node as the graph holds it NOW (vectors and internal stamps stripped); 404 when it is gone; 501 on a deployment with no graph |

What the run view opens when a node in a step's **Nodes** list is clicked: a
run's events say which nodes a step touched (`nodes`, above), never their
content.
