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

## Good to know

- **The URL is your secret.** Put a token in it, like the example. Strut
  never returns the URL — the run log records only its origin, and the URL
  is kept beside the log where no endpoint serves it.
- **If strut restarts mid-run**, it resumes the run at boot and the callback
  posts when the run settles, as if nothing had happened. If you have not
  heard back after a run should have finished, read the summary endpoint above.
- `POST /chat` accepts the same `callback` field for the AI builder; that one
  posts once per turn with `event: "turn.end"`.
