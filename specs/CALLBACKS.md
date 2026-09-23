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
| `durationMs` | wall time from launch to finish                              |

Reply with any `2xx`. Strut retries a failed delivery a few times over about
half a minute; a `4xx` reply is taken as "refused" and not retried.

## 3. Fetch more if you need it

The callback carries the result, not the log. For everything else, use the
`runId`:

```bash
# the run summary (same fields as the callback, plus timestamps)
curl http://localhost:3000/workflows/review-pr/runs/1790179200000

# the full event log — every step's input/output, and each agent step's
# complete model transcript in its step.end event's `messages`
curl http://localhost:3000/workflows/review-pr/runs/1790179200000/events
```

## Good to know

- **The URL is your secret.** Put a token in it, like the example. Strut
  never stores or returns the URL — the run log records only its origin.
- **If strut restarts mid-run**, the callback is lost with it. If you have not
  heard back after a run should have finished, read the summary endpoint above.
- `POST /chat` accepts the same `callback` field for the AI builder; that one
  posts once per turn with `event: "turn.end"`.
