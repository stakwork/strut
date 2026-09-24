# Run callbacks

Get a workflow run's result pushed to your endpoint instead of polling or
holding a stream open.

## 1. Launch the run with a `callback`

```bash
curl -X POST http://localhost:3000/workflows/review-pr/run \
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
| `durationMs` | wall time from launch to finish                              |

Reply with any `2xx`. Strut retries a failed delivery a few times over about
half a minute; a `4xx` reply is taken as "refused" and not retried.

## 3. Fetch more if you need it

The callback carries the result, not the log. Agent transcripts can run to
megabytes each, so it carries **links** to them, never their content. Each
`transcripts[].url` is relative to the strut you launched on and returns that
session as a bare JSON array of AI SDK model messages (system prompt, task,
every turn). You don't have to parse it:

```ts
import { put } from "@vercel/blob";

for (const t of body.transcripts ?? []) {
  const res = await fetch(new URL(t.url, STRUT_URL));
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
curl http://localhost:3000/workflows/review-pr/runs/1790179200000

# the full event log: every step's input and output; an agent step's
# step.end carries a `transcript` link (the same URLs as above)
curl http://localhost:3000/workflows/review-pr/runs/1790179200000/events
```

## Good to know

- **The URL is your secret.** Put a token in it, like the example. Strut
  never stores or returns the URL — the run log records only its origin.
- **If strut restarts mid-run**, the callback is lost with it. If you have not
  heard back after a run should have finished, read the summary endpoint above.
- `POST /chat` accepts the same `callback` field for the AI builder; that one
  posts once per turn with `event: "turn.end"`.
