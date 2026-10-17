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
| `kind`    | how to show it — the host's renderer names (`markdown`, `html`, `image`, `video`, `audio`, `pdf`, `url`, `diff`, `pull_request`, `code`, `log`, `json`). Read off the file's extension when omitted (`url` when that says nothing) |
| `title`   | shown on the card |
| `label`, `summary` | optional: what it is to the reader ("Plan", "Screenshot"), and a sentence about it |
| `path`    | a file, relative to the run's directory — the **job's** for a run launched with `job` (see below), else the run's own artifact directory |
| `url`     | an absolute URL, or a strut-relative one starting with `/` (another run's `/artifacts/<runId>/clip.mp4`) |
| `content` | inline, up to 50 KB: a diff, a JSON value, short markdown |

At least one of `path`, `url`, `content`; they are not exclusive (a pull
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

**Jobs.** `POST …/run { job: "<id>" }` launches the run under a job — an
id you mint, the format of a session id (`API.md` §9) — and the `job/dir`
step then hands the workflow ONE directory, `<dataDir>/jobs/<id>/`, the
same for every run launched with that id. Launch again with the same `job`
(and the same `session` on the agent) and the next run revises the same
files behind the same links: that is how a plan gets iterated on across
twenty turns. `plans/jobs.md` is the design.

**A job your run started.** A workflow whose agent is granted `job/start`
and `job/continue` hands bigger work to strut's `job` workflow and ends
its turn without waiting. That job's run carries YOUR run's callback, so
your URL gets a second `run.end` when the job ends: `workflow: "job"`,
the `job` id, and its artifacts resolved in the job's directory. Tell the
two apart by `workflow` and `job`. A run launched with no callback starts
jobs with none.

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
- `400` without `job`, or when the URL is not `http(s)`. The `202` carries
  `jobCallback: true`.
- Like `callback.url`, it is your secret: kept apart from the job's record,
  never returned by any endpoint.

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
| `runId` | the run that made the change, when one did |

What strut sends today:

| `kind` | When | `state` |
| ------ | ---- | ------- |
| the hold's kind (`pod`, `browser` — a page the job keeps, `id: browser:<session>`) | a hold is taken, or let go (by its tool, a delete, the idle sweep; a kept page also when it goes idle) | `held` / `released` |
| `evidence` | a check writes evidence about the job (`detail: { claim, check }`; `url` = what it pointed at, a screenshot) | `supported` / `refuted` / `planned` (a slot for a person) |
| `verify` | a verify of the job ended (`detail: { evidence, slots, claims: [{ id, status }] }`) | `done` |
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
