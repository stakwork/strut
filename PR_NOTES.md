# Private voice, Step 1 — strut side (plans/private-voice.md §3.1, §3.4, §10)

Out of scope and untouched: `/audio/speak`, `src/audio`, Peel / sphinx-voice, Steps 2+.

## What changed, by plan bullet

| Plan bullet | Change |
|---|---|
| §3.1.1 reply `start` | `orchestrator.yaml`: the `turn` schema is `text`, `start { brief, title, kind?, workflow? }`, `artifacts`, `ask` (`text` first). New steps after `turn`: `wantsJob` (`if`, `!!turn.object.start?.brief`) → `started` (`job/start`, `when: true`). `result` depends on `[turn, started]` and also packs `job` and `runId` (undefined when no job). The `job/start` tool stays; the system prompt says to use `start` for one job and the tool for several. |
| §3.1.1 callback | No new code. `job/start` already makes the job inherit the launching run's `jobCallback` (CALLBACKS.md §5), and the DAG step goes through the same `ctx.services.jobs.launch`. Test: the job's `run.end` reaches the callback with `startedBy.runId` = the turn's run. |
| §3.1.2 `params.reasoning` | `turn` takes `reasoning: "{{ params.reasoning }}"`; `params.reasoning: medium` (the agent step's own default, so behaviour is unchanged). A voice launch sends `params: { reasoning: "none" }`. Test: default sends `effort: medium`, `none` sends `thinking: disabled`. |
| §3.1.3 `params.model` per launch | Already a param. Tests: `POST …/run { params: { model, reasoning, stream } }` returns 202 and the request goes to that model; `grantWidenedBy` returns null for those keys and still refuses a widened `tools`. Default model unchanged. |
| §3.1.4 voice line | `input.context.line` already heads the turn's prompt. A yaml comment says so; test proves it is in the turn's user message and not in the (frozen) system prompt. |
| §3.4.1 tap | `stream: true` on the agent step (`z.boolean().default(false)`); orchestrator passes `params.stream` (default `false`). `createReplyTap` is hooked into `streamFailure(result, tap)`, so the loop, the nudge and the forced answer are all tapped. Schema mode: `tool-input-delta` of `final_answer`, `parsePartialJson` for `text`, only the new suffix. Text mode (no schema, no finalAnswer): `text-delta`. Keyed by tool call id (`"text"` in text mode); a new `final_answer` call after text was said gets `reset: true`. |
| §3.4.2 `reply.delta` | New `RunEventType` + `call?`, `text?`, `reset?` on `RunEvent`. Emitted through `ctx.emit` at the step's path, buffered 50 ms (`REPLY_DELTA_MS`), flushed at stream end (also on an error part). Stays in the run log. |
| §3.4.2 sink | `SINK_FIELDS` is an allowlist; `text`, `call` and `reset` are not in it. Test in `events-sink.test.ts`. (The envelope of a `reply.delta` — type, path, time — still goes; it holds no text.) |
| §3.4.2 UI / folds | `EventsPanel` filters it (and its count); `foldRunOverview`, `foldRunHealth` (kit) and `foldRun` (builder's run view) skip it. Tests added for both kit folds. |
| §3.4.3 wake tails | `store.ts`: `append` on the file and memory stores calls `wakeTails(key)`; `tailJsonl` and `tailFromPolling` sleep with `sleepOrWake`. The poll interval stays as the fallback. Test: with a 60 s poll, an append is heard in < 40 ms on both stores. |
| Docs | `specs/API.md`: the `reply.delta` event row; §4 notes the wake-up. |

## Choices where the plan was ambiguous

- **`start` gating** uses an `if` step + `when: true`, the pattern `job.yaml` uses, rather than a new step option. This adds two steps to the template, so `orchestrator-seed.test.ts` expects `[…, agent, if, job/start, pack]`.
- **`start.workflow`** is an enum `[job, builder]`, as `job/start`'s `workflow`. `peer`, `repos` and `attachments` are not in `start`: the plan lists brief/title/kind/workflow only. A turn that needs them uses the `job/start` tool.
- **finalAnswer mode** (a free-text `final_answer` tool) is not tapped: the plan names schema and text modes only.
- **Text mode** emits all assistant text of the step, including prose before a tool call, all under call `"text"`, no reset. It is meant for a voice turn with no tools.
- The tap `await`s `parsePartialJson` per delta. The input is a few KB at most.
- `reply.delta` envelopes are still sent to the sink, only without text. If you would rather drop the whole event from the sink, it is a one-line filter in `slimRunEvent`'s caller.

## Does `text` stream in pieces? (per provider)

The tap needs the provider's tool-call input to arrive as `tool-input-delta` parts of more than one piece.

| Provider path | From the code | Verified by test | Needs live measurement |
|---|---|---|---|
| **Anthropic direct** | aieo's anthropic model sets `eager_input_streaming: true` on tools whenever it streams (`defaultEagerInputStreaming = stream && (toolStreaming ?? true)`, `node_modules/aieo/dist/index.js` ~L8163, and `prepareTools` ~L5832); strut does not override `providerOptions.anthropic.eagerInputStreaming`. | End to end: a stand-in Anthropic SSE endpoint sends `final_answer` input as several `input_json_delta` chunks → the real aieo + AI SDK path → several `reply.delta` events whose text adds up, with nothing from `start`. Also the text-mode path (`text_delta`). | Whether the real API chunks finely with eager streaming on a short reply. Plan says yes; not measured here. |
| **Through Bifrost** | strut's call is the same request with a gateway `baseUrl` (a routed call). Whether Bifrost forwards `eager_input_streaming` and re-emits `input_json_delta` chunk by chunk, or buffers a tool call until complete, is not visible in this repo. | Nothing about Bifrost. | **Yes.** If one lump arrives, `reply.delta` is one event at the end of the reply. Run it through `scripts/gateway-stream.mts` or a voice-turn run, and count `reply.delta` events. |
| **vLLM (e.g. Tinfoil)** | Chat-completions path (`openai.chat`). The AI SDK turns `tool_calls[].function.arguments` fragments into the same `tool-input-delta` parts, so the tap works when the server streams arguments in pieces. Some vLLM tool parsers hold a call's arguments until they are complete. | The tap with the part sequences of both cases: arguments in fragments → streamed text; arguments in one part → exactly one delta, no error. No wire-level OpenAI-compatible stand-in was added: the repo has no such harness for a custom base URL, and the parts layer is what the tap sees. | **Yes**, on the actual endpoint and model (`gemma4-31b`). If it comes as one lump, switch voice turns to text mode (no schema; `start` as a `job/start` call after the text), per §3.4. |

Summary: only the Anthropic-direct path is shown to stream in pieces, and only against a stand-in. Bifrost and Tinfoil are unverified.

## Tests

- `src/steps/core/agent-stream.test.ts` (new): agent step end to end on the Anthropic-style path (schema + text + off by default); the tap on vLLM-style fragments / a lump, escapes, reset, other tools ignored, 50 ms batching, flush on error.
- `src/orchestrator-seed.test.ts`: template shape, `start` job after one model call and its callback, no-`start` skip, knobs and the grant guard, voice line in the prompt and not the system prompt, deltas in the log.
- `src/store.test.ts`: append wakes tails. `src/events-sink.test.ts`: no reply text on the sink. `kit/src/folds/run-overview.test.ts`, `run-health.test.ts`: folds skip it.
- `kit/src/folds/document.test.ts` cannot run here (`@happy-dom/global-registrator` is not installed in `kit/`); it is unrelated.
