# Run callbacks

Get a workflow run's result pushed to your endpoint instead of polling or
holding a stream open.

## 1. Launch the run with a `callback`

```bash
curl -X POST http://localhost:3000/workflows/review-pr/run \
  -H "Authorization: Bearer $STRUT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "input": { "owner": "stakwork", "repo": "strut", "prNumber": 29 },
    "callback": { "url": "https://your-app.example/hooks/strut?token=s3cret" }
  }'
```

Response (immediately, before the run finishes):

```json
{ "runId": "1790179200000", "callback": true }
```

- `callback.url` must be `http(s)`. Anything else is a `400` and no run starts.
- `callback: true` in the response confirms this server will call you back.
- `POST /workflows/:name/:version/run` accepts the same field.

## 2. Receive the result

When the run ends, strut sends **one** `POST` to your URL with a JSON body:

```json
{
  "event": "run.end",
  "workflow": "review-pr",
  "runId": "1790179200000",
  "status": "success",
  "output": { "summary": "Looks good. Two nits inline." },
  "transcripts": [
    {
      "step": "review-pr/review",
      "stepType": "agent",
      "url": "/workflows/review-pr/runs/1790179200000/transcripts/review-pr/review"
    }
  ],
  "artifacts": [
    { "id": "report", "kind": "markdown", "title": "Review", "url": "/artifacts/1790179200000/report.md" }
  ],
  "durationMs": 48213
}
```

| Field        | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| `event`      | always `"run.end"`                                           |
| `workflow`   | the workflow name you launched                               |
| `runId`      | the id from step 1                                           |
| `job`        | the job the run was launched under — only for a job run      |
| `status`     | `"success"`, `"error"` or `"cancelled"`                      |
| `output`     | the workflow's output (its last step's) — on success only    |
| `error`      | `{ "message": "..." }` — on error only                       |
| `transcripts`| one link per agent session the run recorded — only when it recorded any (see §3) |
| `artifacts`  | the deliverables the workflow's output declared, resolved to links — only when it declared any (see §4) |
| `durationMs` | wall time from launch to finish                              |

Reply with any `2xx`. Strut retries a failed delivery a few times over about
half a minute; a `4xx` reply is taken as "refused" and not retried.

## 3. Fetch more if you need it

The callback carries the result, not the log. Agent transcripts can run to
megabytes each, so it carries **links** to them, never their content. Each
`transcripts[].url` is relative to the strut you launched on and returns that
session as a bare JSON array of AI SDK model messages (system prompt, task,
every turn). Like every read, it needs the deployment's key when one is set.
You don't have to parse it:

```ts
import { put } from "@vercel/blob";

for (const t of body.transcripts ?? []) {
  const res = await fetch(new URL(t.url, STRUT_URL), {
    headers: { authorization: `Bearer ${STRUT_API_KEY}` },
  });
  await put(`runs/${body.runId}/${encodeURIComponent(t.step)}.json`, res.body!, {
    access: "private",
    contentType: "application/json",
  });
}
```

`step` is the step's path in the run: `review-pr/review` for a top-level
agent step, `review-pr/each#2/review` inside a foreach, and
`review-pr/review/003-agent` for a sub-agent that step called.

For everything else, use the `runId`:

```bash
# the run summary (same fields as the callback, plus timestamps)
curl -H "Authorization: Bearer $STRUT_API_KEY" \
  http://localhost:3000/workflows/review-pr/runs/1790179200000

# the full event log: every step's input and output; an agent step's
# step.end carries a `transcript` link (the same URLs as above)
curl -H "Authorization: Bearer $STRUT_API_KEY" \
  http://localhost:3000/workflows/review-pr/runs/1790179200000/events
```

## 4. Artifacts — what the run hands you to look at

A workflow's output may carry `artifacts`: a list of things the run produced
for a person to look at rather than read — a plan, a page, a screenshot, a
pull request, a pod. Each entry names one:

```yaml
- id: result
  type: pack
  config:
    text: "{{ work.object.text }}"
    artifacts:
      - { id: plan, title: "Plan", path: plan.md }                       # a file the run wrote
      - { id: pod,  kind: url, title: "Pod", url: "{{ claim.frontend }}" } # somewhere to go
      - { id: diff, kind: diff, title: "Diff", content: "{{ diff.diff }}" } # small, inline
```

| Field     | Meaning |
| --------- | ------- |
| `id`      | stable across runs: the same `id` from a later run is a newer version of the same thing (turn 12's `plan` replaces turn 3's) |
| `kind`    | how to show it — the host's renderer names (`markdown`, `html`, `image`, `video`, `audio`, `pdf`, `url`, `diff`, `pull_request`, `code`, `log`, `json`), or `app` (below). Read off the file's extension when omitted (`url` when that says nothing) — or a manifest's name: `walkthrough.json` → `walkthrough`, `captcha-<round>.json` → `captcha`; a `path` with no extension that holds an `app.yaml` → `app` |
| `title`   | shown on the card |
| `label`, `summary` | optional: what it is to the reader ("Plan", "Screenshot"), and a sentence about it |
| `path`    | a file, relative to the run's directory — the **job's** for a run launched with `job` (see below), else the run's own artifact directory |
| `url`     | an absolute URL, or a strut-relative one starting with `/` (another run's `/artifacts/<runId>/clip.mp4`) |
| `content` | inline, up to 50 KB: a diff, a JSON value, short markdown |
| `app`     | an APP published in this workspace, by name (`kind: "app"`): its active version, or the one `version` names (below) |

At least one of `path`, `url`, `app`, `content`; they are not exclusive (a pull
request may carry its link and its fields — both are delivered). `output`
is delivered as the workflow packed it; the resolved list rides beside it
as the callback's top-level `artifacts`, each entry with a `url` (a `path`
becomes `/jobs/<job>/files/<path>` or `/artifacts/<runId>/<path>`, served
behind the key like every read — see `API.md` §5 — and takes the place of a
`url` given beside it) and/or its `content`, or an `error` (`not found`,
`bad url`, `too large`) when nothing could be resolved — show those as
unavailable. Entries with no `id` or `title` are dropped. The same
list is at `GET /workflows/:name/runs/:runId/artifacts` for a callback you
missed.

**An app — `kind: "app"`.** An APP (`plans/apps.md`) is a front-end
project built into one page; the `builder` workflow publishes one in the
workspace and hands it over BY NAME — `{ id, kind: "app", title, app:
"visits" }`, its active version, or `version: "v2"` for one — and a job
that ran the builder passes that entry on. It resolves to that version's
document, with `app` beside the `url`:

```json
{ "id": "visits", "kind": "app", "title": "Visits",
  "url": "/apps/visits/v2/files/dist/index.html",
  "app": { "name": "visits", "version": "v2", "hash": "9f2c…", "builtAt": "2026-10-22T10:04:11.201Z" } }
```

A host that knows apps renders it the way strut's UI does (`API.md` §14.3):
list `GET /apps/<name>/<version>/files` (it mints the version's file
token), fetch the `url` with that token as `?t=` — the page comes back
carrying the token as its identity — frame the TEXT as a sandboxed
`srcdoc`, and relay its `tools/call` to `/mcp`. A host that does not shows
the link: the page opens, with no host behind it, and says so. `app.hash`
is the tree hash the version was built from — a new one is a new document.
A name no app has is an entry with `error: "no such app: …"` (`no such
app version: …` for a pinned version).

The older form is a job's APP DIRECTORY (`plans/apps.md` §6): `path` is a
directory in the job's holding an `app.yaml`, resolved to its document
with `app: { job, path, hash, builtAt }` (`/jobs/<job>/files/<path>/dist/index.html`;
host it through `GET /jobs/<job>/files?path=<app.path>`, the job's token
NARROWED to that directory — `API.md` §14.4). Nothing strut ships produces
one since 2026-10-22 (the job agent has no app tools; a page over a job's
own results is an HTML file in its directory), but a directory handed over
that way still resolves; never built is `error: "not built: …"`. A run with
no job resolves such a `path` under its own artifacts, with no `app`.

**A deliverable from another strut — `peer` and `job`.** A run that did
its work on another strut (`strut/run-workflow`; the `builder` workflow
launched with `input.peer`, `plans/builder-job.md` §3) hands back THAT
strut's deliverables, and its files are there, not here. Each such entry
carries `peer` — the id this strut has the other on file under (`GET
/peers`; hive registers a workspace's swarm by its slug) — and, when the
work ran under a job there, `job`: the job as THAT strut holds it
(`peer/<id>` when it was launched on its peer key). Strut delivers it as it
came, never resolved here:

```json
{ "id": "plan", "kind": "markdown", "title": "Plan", "path": "plan.md", "peer": "acme-web", "job": "peer/build-1" }
```

no `url` made on this strut, no `not found`; `kind` is read off the
extension as for any entry. **Resolve it against the peer, by its id**: a
`path` is `GET /jobs/<job, percent-encoded>/files/<path>` on the strut you
know as `peer`, read with your own credential for that strut; a `url`
starting with `/` is a link on that strut too; an absolute `url` and a
`content` are what they are anywhere. A host that cannot reach the peer
shows the entry as foreign — its title and where it lives — rather than as
unavailable. An entry the peer itself got from a third strut keeps the tag
the peer gave it (the peer's id for that strut). The output's own `peer`
(the `builder`'s reply) says the same of the whole turn. A link is never
written into the entry: a URL would be a second identity for one thing,
stale once the peer moves (the handle rule, `plans/federation.md` §2.2).

**Jobs.** `POST …/run { job: "<id>" }` launches the run under a job — an
id you mint, the format of a session id (`API.md` §9) — and the `job/dir`
step then hands the workflow ONE directory, `<dataDir>/jobs/<id>/`, the
same for every run launched with that id. Launch again with the same `job`
(and the same `session` on the agent) and the next run revises the same
files behind the same links: that is how a plan gets iterated on across
twenty turns. `plans/jobs.md` is the design.

**A job your run started.** A workflow whose agent is granted `job/start`
and `job/continue` hands bigger work to strut's `job` workflow — or to
`builder`, when what is to be made or changed is a workflow (`job/start {
workflow: builder }`, `plans/builder-job.md`; `GET /jobs/:id` says which a
job is) — and ends its turn without waiting. That job's run carries YOUR
run's callback, so your URL gets a second `run.end` when the job ends:
`workflow: "job"` (or `"builder"`), the `job` id, and its artifacts
resolved in the job's directory. Tell the two apart by `workflow` and
`job`: a `run.end` carrying `job` is a job turn whatever its workflow. A
run launched with no callback starts
jobs with none. The same goes for live updates: the jobs a run starts
inherit its `jobCallback` (§5).

## 5. Live updates — a job tells you what changed, as it changes

`run.end` arrives when a turn is over. To see a job's work AS it happens —
a screenshot the agent just took, a walkthrough recording frame by frame, a
pod it claimed, a check's verdict — launch with a `jobCallback` beside
`job`:

```json
{
  "job": "j-123",
  "input": { "…": "…" },
  "callback":    { "url": "https://your-app.example/hooks/strut-run?id=…&token=…" },
  "jobCallback": { "url": "https://your-app.example/hooks/strut-job?job=j-123&token=…" }
}
```

- It belongs to the **job**, not the run: every run under the job reaches
  it — later turns, the runs a turn starts, verify passes. The latest launch
  that carries one wins (rotate your token with any turn); `jobCallback:
  null` clears it; leaving it out keeps what is on file.
- `400` when the URL is not `http(s)`. The `202` carries `jobCallback: true`.
- Like `callback.url`, it is your secret: kept apart from the job's record,
  never returned by any endpoint.

**The jobs your run starts inherit it.** A run whose agent starts jobs
(`job/start`, `job/continue` — §4) hands each of them the `jobCallback`
its own launch carried, the way it hands them its `callback`: written onto
the job before the job's run starts, so its first update finds it, and on
to the jobs that job starts in turn. So a launch needs no `job` of its own
to carry one — an orchestrator turn is launched with `callback` and
`jobCallback` and nothing else, and every job it starts reports to that
URL:

```json
{
  "input": { "message": "…", "session": "…" },
  "callback":    { "url": "https://your-app.example/hooks/strut-run?id=…&token=…" },
  "jobCallback": { "url": "https://your-app.example/hooks/strut-jobs?conversation=…&token=…" }
}
```

That URL is then **shared by every job of the conversation**, not minted
per job, so route by the payload: `job` names the job and `runId` the run
(the turn) that made the change — both ride in every event a run makes
(below). A turn launched without one leaves what each job has on file; a
later turn that carries one replaces it, the rule above. The inherited URL
is kept beside the launching run's log like its `callback`, so a turn
resumed after a restart still hands it on.

Strut then POSTs one small event per change:

```json
{
  "event": "job.update",
  "job": "j-123",
  "at": "2026-10-15T18:04:11.201Z",
  "runId": "1790179200000",
  "kind": "walkthrough",
  "url": "/jobs/j-123/files/walkthroughs/004/walkthrough.json",
  "state": "recording",
  "detail": { "frames": 3 }
}
```

| Field | Meaning |
| ----- | ------- |
| `kind`  | what changed, in the same vocabulary as an artifact's `kind` — passed through, strut reads neither it nor `state` |
| `url`   | its link: a job file is `/jobs/<job>/files/<path>`, exactly what a deliverable with that `path` resolves to in `run.end` — match the two by URL |
| `id`    | its own id where it has one: a hold's, a piece of evidence's |
| `state`, `title`, `detail` | what happened to it, small and kind-specific |
| `runId` | the run that made the change — a hold taken or let go by a tool names the job's turn in flight; absent only for a change no run made (a hold released by a delete or the idle sweep) |

What strut sends today:

| `kind` | When | `state` |
| ------ | ---- | ------- |
| the hold's kind (`pod`, `browser` — a page the job keeps, `id: browser:<session>`) | a hold is taken, or let go (by its tool, a delete, the idle sweep; a kept page also when it goes idle) | `held` / `released` |
| `evidence` | a check writes evidence about the job (`detail: { claim, check }`; `url` = what it pointed at, a screenshot) | `supported` / `refuted` / `planned` (a slot for a person) |
| `verify` | a verify of the job ended (`detail: { evidence, slots, claims: [{ id, status }] }`) | `done` |
| `app` | `app/build` built a job's app (`id` = its directory, `url` = its document, `title` = its manifest's; `detail: { path, hash, bytes }`, or `{ path, errors }` when the build failed) — reload a frame showing it | `built` / `failed` |
| anything a step names | a step called `ctx.services.jobs.notify` — the lab's browser steps for a screenshot (`image`) and every frame of a walkthrough (`walkthrough`, its manifest's url); never a captcha's crop, which its own card shows | the step's |

**An event is a notification, never the record.** Each points at something
you can read again: the job's files, `GET /jobs/:id` (holds, deliverables),
`GET /jobs/:id/claims` (the ledger). Events for one job are posted in
order, retried twice, and coalesced: while one post is in flight, a newer
update about the same thing (same `kind`, `url` and `id`) replaces the one
waiting — you get each thing's latest state, not every step on the way. A
restart drops what was waiting. So treat an event as "look at this now",
and read the job when you open it or think you missed one.

`POST /jobs/:id/verify { detach: true }` starts a verify and answers `202 {
job, started: true }` at once: the evidence and the `verify` event arrive
here as they land (`API.md`). `plans/live-artifacts.md` is the design.

## 6. Proposals — what the run asked the person to approve

A run whose agent has tools in `approve:` (`plans/proposals.md`) may have
PROPOSED changes it did not make: a tool call recorded for a person to
accept or reject. `run.end` lists them, resolved by strut from its records
(never from the model's output):

```json
"proposals": [
  { "id": "p3f9aKq2", "step": "graph/create-node", "title": "Create a node in the strut knowledge graph.",
    "status": "pending", "url": "/proposals/p3f9aKq2", "rationale": "The Rate limits page is missing.", "createdAt": "…" }
]
```

| Field | Meaning |
| ----- | ------- |
| `step` | the registry step the proposal will run — what picks your card |
| `status` | `pending` → `applied` (accepted and run) \| `rejected` \| `failed` (accepted, the step failed; may be accepted again) |
| `url` | the record: `GET /proposals/:id` gives the step's `input` (what will run), the rationale, who proposed it, the decision and the result |

A person decides at `POST /proposals/:id/decide { action: "accept" | "reject",
input?, reason? }` — `input` is edits merged onto the proposal's input and
re-validated by the step's schema (400 when they do not fit); the response is
the record after the decision, the step already run on accept. A decided
proposal answers `409` with its record. `x-strut-actor` on the request is
recorded as who decided. On a job run each change is also a `job.update {
kind: "proposal", id, url, state }` (§5). Absent when the run proposed
nothing; `GET …/runs/:runId/proposals` is the same list for a host that
missed the callback.

## 7. Every run's events — a listener set once (`STRUT_EVENTS_SINK`)

Everything above is asked for per launch and carries a result to the caller
that asked. A server that wants to *watch* strut — draw which workflow is
running, which step lit up, how long it took, what it spent — across every
run, whoever launched it, is set once on the deployment:

```bash
STRUT_EVENTS_SINK=https://viz.example/strut?token=s3cret
```

(`createStrut({ eventsSink: { url } })` for a host that embeds strut.) Strut
then POSTs every run's events there, batched — about once a second, or every
100 events — as:

```json
{
  "event": "run.events",
  "events": [
    { "workflow": "review-pr", "runId": "1790179200000", "path": "review-pr", "type": "run.start", "ts": "…", "actor": "evan", "workflowHash": "…" },
    { "workflow": "review-pr", "runId": "1790179200000", "path": "review-pr/review", "type": "step.start", "stepType": "agent", "ts": "…" },
    { "workflow": "review-pr", "runId": "1790179200000", "path": "review-pr/review/001-bash", "type": "step.end", "stepType": "tool:bash", "durationMs": 812, "toolCallId": "…", "ts": "…" },
    { "workflow": "review-pr", "runId": "1790179200000", "path": "review-pr/review", "type": "step.end", "stepType": "agent", "durationMs": 48100, "modelCalls": 7, "usage": { "inputTokens": 51200, "outputTokens": 2100, "totalTokens": 53300 }, "cost": 0.19, "ts": "…" },
    { "workflow": "review-pr", "runId": "1790179200000", "path": "review-pr", "type": "run.end", "ts": "…" }
  ]
}
```

Each event is the **envelope** of the one in the run's log: `workflow`,
`runId`, `path`, `type`, `ts`, `stepType`, `durationMs`, `iteration`, what a
model-calling step spent (`modelCalls`, `usage`, `cost` — a run's spend is
their sum over its `step.end`s), which version ran (`workflowHash`,
`stepVersion`, `subflow`), who and what for (`actor`, `principal`, `job`,
`origin`, `automation`, `parentRunId`, `verify`), a tool call's `toolCallId`,
and on a failure `error.message`. **Never** a step's `input`, `output`,
transcript, params, the nodes it touched, or a stack: nothing the workflow
handled leaves on it. When you need more, read the run by its id
(`GET /workflows/:name/runs/:runId/events`, with the key).

Batches land in order (one POST in flight at a time). This is telemetry, not
the record: a delivery that fails is retried briefly and then **dropped**, and
a listener that cannot keep up loses the oldest queued events — nothing in a
run ever waits on it. The log in strut is the source of truth; backfill from
it when you missed something. The URL is treated as a credential: strut logs
its origin only.

## Good to know

- **The URL is your secret.** Put a token in it, like the example. Strut
  never returns the URL — the run log records only its origin, and the URL
  is kept beside the log where no endpoint serves it.
- **If strut restarts mid-run**, it resumes the run at boot and the callback
  posts when the run settles, as if nothing had happened. If you have not
  heard back after a run should have finished, read the summary endpoint above.
- `POST /chat` accepts the same `callback` field for the AI builder; that one
  posts once per turn with `event: "turn.end"`. A turn a restart cut off
  posts `turn.end { status: "error" }` once strut is back, with `settled:
  false` when the builder was woken to go on from where it stopped — that
  turn's own `turn.end` follows.
