# The agent step and agent sessions

The `agent` core step (built-in tools, `agentTools`, the stream rules) and sessions: a thread an agent continues across runs.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **Agent sessions — a finished agent can be given another prompt**
  (`plans/agent-sessions.md`; `src/session-store.ts`, the `agent` step,
  `git/checkout`). `session: <id>` on an `agent` step makes it CONTINUE a
  thread: it opens the session (`ctx.services.sessions.open`, which takes
  the session's in-process lock — a second turn fails `session_busy:`),
  sends the thread's system prompt and messages followed by this turn's
  prompt, and on success appends the turn; a failed or cancelled turn
  appends nothing. The lock is also let go when the run ends, so a turn a
  force-cancel abandoned (run-control.ts `raceForce`) never holds the thread
  past its run; should it wake later, its commit is refused
  (`session_released:`). The id is a flat, GLOBAL string the CALLER supplies
  (usually `"{{ input.session }}"`, a uuid) — no run-level field, no chain
  of runs: any run of any workflow naming it joins, so the unit stays one
  run per turn. Which agents of a workflow remember is per step: several
  agents take different ids (`"{{ input.session }}/review"`; a slash is
  part of the name, not a hierarchy), an agent without `session` starts
  cold. The id format is strict (`idProblem`) because a multi-segment
  template renders a missing value as `""` — `/review` would otherwise be
  one thread shared by every run that forgot an id. A thread stays on the
  Concept BRANCH its first turn ran on (src/branches.ts): every run's view
  of `sessions` (`bindBranch`) refuses a turn from a run on another branch,
  or on main, `session_branch:`, and stamps each turn line with its run's
  `branch` (absent: main).
  **The record** is a second store (`SessionStore`, File + Memory; the
  default follows the CHAT store's kind): `system.md` written by turn 0 and
  never again, append-only `messages.jsonl`, and `turns.jsonl`, one line per
  successful turn (who, which run and step, provider, model, `offset` /
  `count`, usage, the context after it) — the turn line is the commit. The
  run log records the TURN (`step.end.messages` = the system prompt + this
  turn), so logs grow linearly; `GET …/transcripts/<path>?full=1` stitches
  the thread to that turn from the store. The step's output gains
  `session: { id, turn, offset }`.
  **History is append-only**, the chat's rule: the system prompt is frozen
  by the first turn (a later step's `system` is ignored, one warn line) and
  the messages are replayed as stored, so every request begins with the
  previous one byte for byte. `retain` replaces what a
  compaction's summary is told to keep (`AGENT_RETAIN`: files, commands) with
  the caller's own references. Tools, output mode and `maxSteps` are the
  current step's. Whether calls are routed through the gateway is fixed
  by the first turn (`session_mismatch:`); the model and the provider may
  change — each provider's converter drops thinking it cannot verify —
  unless the replayed thread holds another provider's server-run tool calls
  (Anthropic's web tools, direct only; `session_mismatch:` too). A thread the
  last turn left past the compaction mark (`STRUT_COMPACT_AT`, 0.9 of the
  resolved model's window) is summarized AT OPEN: the `[compaction]`
  message leads this turn, the committed line's `replayFrom` points at it,
  and the next turn replays `messages.slice(replayFrom)` — the thread is
  still whole on disk (plans/compaction.md §3). The same happens BETWEEN
  STEPS when a turn itself crosses the mark: the loop stops after the step
  (its tool results in), summarizes the request so far under its own
  system, tools and provider options, pushes the summary onto the record
  and continues from it alone, with one nested `compaction` event beside
  the tool calls (`<agentPath>/NNN-compaction`) and `compactions: n` on the
  output. One `bash` / `view` result, and what the model reads of one
  `agentTools` step's (`capToolOutput`: each string, then the whole), is
  capped at the window's headroom below the mark (`BASH_MAX_CHARS` is the
  ceiling). With compaction off (`STRUT_COMPACT_AT=1`) a thread over 90%
  is refused before any model call (`session_full:`). An `agent` called as
  a TOOL cannot take a session: the model would be choosing the id.
  **The files** follow through `workdir` on `git/checkout`, a name of its
  own (usually the job, `"{{ $job }}"`): the working copy lives inside
  that job's directory, `<dataDir>/jobs/<name>/<repo>` — the same path
  every run, the transcript is full of it — is left as the last run left
  it (`reused: true`; `ref` only applies when it is created), is held by
  one RUN at a time (`job_busy:`; a child run launched by
  `meta/run-workflow` shares it), and is removed once the job is idle
  for `STRUT_WORKDIR_TTL_DAYS` by the next kept checkout or `job/dir`.
  **Run control:** a journaled session step replays its output on resume
  and never reaches the store; "re-run from here" on one is a NEW turn — a
  thread is never rewound. **In the graph** the projector stamps each
  `StrutAgentSession` — one execution, so one TURN — with `session_id`
  (from `step.start`'s resolved config: a failed turn is grouped too) and
  `session_turn` (from the output: committed turns only), so "which nodes
  did this thread touch" is one query over `session_id` → `IN_SESSION` →
  `ACCESSED`, and keeps the turn's `message` and `reply` whole, so what
  was said in a thread is searchable. Endpoints (`/sessions`, all behind the key,
  reads included; the id is a query parameter): list, one session's turn
  log, its messages, delete (409 while held). Tests:
  `storage-conformance.test.ts` (the store), `steps/core/agent-session.test.ts`
  (what a turn puts on the wire, against a stand-in provider),
  `sessions.test.ts` (runs over HTTP + the routes), `git.test.ts` (kept
  working copies).

- **`agent` core step** (`src/steps/core/agent.ts`). A general
  tool-using agent loop (AI SDK `ToolLoopAgent`) — distinct from the
  workflow-*builder* chat above. It explores a working dir (`cwd`)
  with built-in general tools (`repo_overview` — adaptive, token-capped
  dir tree with build/dep/migration dirs collapsed; `fulltext_search`;
  `bash`; `str_replace_based_edit_tool` — view/create/str_replace/insert
  files, sandboxed to `cwd` (the anthropic provider-defined text-editor
  tool, with a generic-`tool()` fallback for other providers; pure handler
  `textEdit()` is unit-tested offline); + `web_search` + `web_fetch` on
  every provider (aieo: native on anthropic; elsewhere — and everywhere when
  routed through a gateway — an Exa-backed search that needs `EXA_API_KEY`
  and a guarded HTTP fetch — no key); +
  `file_summary`, an AST structural summary that's only registered when the
  `stakgraph` CLI is on PATH), filterable via `toolFilter`, and returns one
  of three shapes: a
  `final_answer` tool's
  text (set `finalAnswer` to its description), a STRUCTURED object (set
  `schema` to a JSON Schema: it becomes the `final_answer` tool's INPUT, and
  the step returns the object it was called with — never the SDK's
  `Output.object` grammar over the loop, which forbids all free text and
  made Sonnet 5.5 mark time with `true` / `echo done` tool calls until the
  step cap; the grammar is used only for the forced final-answer turn — one
  request on the loop's own `system` and `tools`, their `execute` removed,
  the model told not to call them: under preserved thinking a replayed
  thinking block is bound to system + tools + the messages before it, and
  the tools head the prompt cache, so the salvage turn must not drop them),
  or the final assistant text. A no-op loop guard runs in every mode: after
  three consecutive steps that are one identical tool call with an
  identical result, the next step offers only `final_answer` (no tools in
  text mode). Provider-direct via aieo
  (anthropic|openai|google|openrouter|xai — inferred from the model
  name, which may be an alias like `sonnet`/`grok` or slash format like
  `openrouter/moonshotai/kimi-k2.6`), lazy-loaded; needs the provider
  key in env + `git`/`rg` on PATH. Returns
  `{ result, object?, steps, usage, cost }` (+ `session` when it continued
  one — see "Agent sessions"). `reasoning` (the AI SDK's provider-neutral
  setting; anthropic maps it to `effort`) defaults to `medium` — anthropic's
  own default is `high`, and a long agent's time is mostly thinking (swarm38,
  2026-10-07: a research job spent 26 of its 27 minutes generating, ~170k of
  203k output tokens thinking). Every model call of the step sends it —
  loop, nudge, forced answer, summarizer — so they share one cache. The full session — system
  prompt, task prompt (with the cwd preamble the model saw), every
  generated turn, as AI SDK model messages — is ALWAYS recorded on the
  step's `step.end` event as `messages` (`buildSession` + `withMessages`,
  the marker the runner lifts; a sub-agent's rides on its tool-call
  `step.end` the same way), so every agent transcript is in the run log:
  over HTTP, `GET …/runs/:runId/events` (and the SSE `/stream`) replace
  it with a `transcript` link, `GET …/runs/:runId/transcripts/<step path>`,
  which serves the bare `messages` array — sessions run to megabytes, and
  the UI's reattach replays the whole log. It is NOT in the output — templates, a parent
  agent's tool result and `run.json` stay slim — and the builder's
  `get_run` strips it. `returnMessages` (default false) additionally puts
  it in the output, for a fork/sub-agent that needs the transcript as
  data. Anything domain-
  specific lives in the CALLER's prompts, not the step (e.g. mcp's
  `/lab` `gitsee-explore-services` wires `clone → agent`).
  - **`agentTools` — "tools are steps"** (`buildRegistryTools`). Beyond the
    built-ins, a caller can expose any REGISTRY step-types as extra LLM tools
    via `agentTools: ["gitsee/boot", "gitsee/read-logs", …]`: each step's
    `input` schema becomes the tool schema and its `run` is the executor,
    invoked with the agent's `ctx` (so tool-steps reach `ctx.services`).
    Resolved through the runner-populated **`ctx.registry`** (see Key
    concepts) — keeps the AI-SDK loop in the step rather than promoting `agent`
    to a container step. Merged ON TOP of the built-ins (not subject to
    `toolFilter`); unknown types are skipped. This is what lets mcp's `/lab`
    `gitsee-setup-and-run` drive a QA harness (boot/browser/observe/assess) as
    the core `agent` instead of a forked loop.
    A tool-step the model must SEE — a `browser/screenshot` step's frame —
    marks its output with `withMedia(output, [{ mediaType, data }])` (the
    third marker, beside `withAccessedNodes` and `withMessages`; `mediaOf`
    reads it): `buildRegistryTools` sets the tool's `toModelOutput`
    (`registryToolModelOutput`), so the model gets the output as JSON text
    plus one file part per entry, while templates, the event log and
    `run.json` see only the plain output (non-enumerable; `maskDeep` carries
    it). The recorded session (`step.end.messages`, the transcript endpoint)
    keeps what the model saw, file parts included. What the model reads
    of any tool-step's result is capped where it is made, at the cap
    `bash` gets (`capToolOutput`, the builder's: each string, then the
    whole result, long arrays kept head + tail with a `{ omitted, from, to
    }` gap; file parts left whole): before 2026-11-02 nothing bounded it
    but the 8 MB output cap. On a chat-completions
    model (`openai.chat`: xai and google routed through the gateway) the
    AI SDK would send a tool result as one string, the image as base64 text,
    so `resolveModel` wraps that model to move the images to a user message
    right after the results (`moveToolResultImages`, `src/llm.ts`) — what
    is sent, never what is stored.
    Entries may be **glob patterns** (`expandAgentTools`): `"jarvis/*"` grants
    every registry step in that namespace (matches sorted, deduped; a pattern
    matching nothing warns). `"agent"` itself is grantable — that's the
    sub-agent primitive: recursion depth is controlled by whether the child's
    own `agentTools` list includes `"agent"` again, not by a numeric cap.
    The model writes a sub-agent's config, so it is held to its parent
    (`holdSubAgent`): an `agentTools` entry the parent does not hold is
    refused, and every step the parent asks before running (`approve`) that
    the sub-agent holds is added to the sub-agent's own `approve`.
    **A tool-step can end the turn**: an output marked `withStop(output)`
    (core.ts, the fourth marker — a device that has not answered, an
    approval waiting on a person) stops the loop after that tool round —
    never a nudge back into it — and one answer turn follows on the loop's
    own prefix with every tool inert (the forced final-answer turn's
    request, its own prompt), so the model says what it is waiting for and
    nothing more runs (a nudge's loop stops the same way; a stream severed
    after the stop is not resumed). A marker, not a field: the model sees
    the plain output, and a step's own `stop` field means nothing. A
    sub-agent's stop ends only its own turn. The output
    gains `stopped: { tool }`. With `toolFilter: ['none']` the step needs
    neither `git` nor `rg` (only the built-ins use them).
  - **The caller's MCP servers are tools too** (`mcp`, default `true`;
    `connectMcpTools`, src/mcp-servers.ts). A run launched with `POST …/run
    { mcp }` hands every agent step its caller's servers as `ctx.mcp`; the
    step connects one client per server when it starts (inside the same
    `try` as the web tools, closed in its `finally`), adds their tools as
    `<server>_<tool>` after everything else in name order (the tool list is
    part of the cached prefix), not subject to `toolFilter`, masked of the
    credentials (`wrapToolsWithMask`) and emitting a run event per call like
    any tool. A tool whose name another tool holds is skipped; a server that
    cannot be reached, refuses the credential or does not answer in 15 s is
    skipped with a warning — the turn goes on without it. A call that fails
    is an `Error:` text the model reads; a result is capped like `bash`'s,
    and an image rides as `withMedia`. `mcp: false` keeps an agent (a judge,
    a narrow researcher) and everything it launches through its tools off
    them.
  - **Every tool call emits a nested run event** (`wrapToolsWithEmit`, applied
    to built-ins AND `agentTools` with one shared counter): a
    `step.start`/`step.end` (or `step.error`) at `<agentPath>/NNN-<tool>` with
    `stepType: "tool:<name>"`, I/O truncated for the log. So the otherwise
    opaque agent loop is **visible in the events panel / run drill-down** —
    each iteration's tool calls show in order. No-op without a runner `ctx`
    (in-code/test); skips `final_answer` + provider-executed tools (no
    `execute`). `agent.run` now consumes `ctx` (registry + emit).
  - **A `bash` command is one unit of run control.** The tool runs the line
    through `runShellProcess` (`shell.ts`: `runProcess` under the platform
    shell — its own PROCESS GROUP) and watches `ctx.control.state` while it
    runs: a cancel SIGTERMs the group at once (SIGKILL 2 s later), the exec
    step's treatment, and the loop's next `prepareStep` checkpoint raises the
    `CancelledError`. `bashTimeoutMs` (default 5 min) SIGKILLs the group and
    the tool result names it; the tool description tells the model the
    budget, so a dev server or a browser behind `| tail` goes to the
    background. Before this a cancel waited out the command's 10-minute cap
    (2026-09-30, swarm38: a `chrome --screenshot … | tail` that never
    returned). What a command leaves running in its process group once it
    has returned is killed when the RUN ends (`runProcess` reports the group
    through `onLeftover` only when something is still in it; the step kills
    them from `ctx.onRunEnd`), so a backgrounded server or browser never
    outlives its run — on swarm38 (2026-10-01) the headless Chromes job runs
    left behind put the repo2graph container at 12 GB.
  - **A stream that ends in an error fails the step** (`streamFailure` +
    `streamError`). The step reads `result.stream`, never `consumeStream`:
    the SDK reports a request the provider REFUSED (a 400 on a later step)
    and a throw out of `prepareStep` (a cancel) as an `error` PART on a
    stream that then closes normally, and `steps` resolves with what was
    banked — which reads exactly like a model that stopped, so the step
    used to nudge, force a final answer and return one. A connection fault
    (`isTransientStreamError`) is still resumed from the banked
    conversation, up to 5 times. Anything else throws `AgentStreamError`,
    `agent failed after N step(s): <message> (HTTP <status>: <body>)` — in
    the MESSAGE, because a run log records nothing else of an error — and a
    cancel is rethrown as it is (`status: "cancelled"`). The nudge and the
    forced final answer are salvage and still give up quietly on a
    connection fault; a refusal or a cancel there fails the step too, since
    the next fallback would send the refused conversation again. With a
    `session`, nothing is committed.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/session-store.ts`

agent sessions (plans/agent-sessions.md): SessionStore iface + FileSessionStore (sessions/<encoded id>/: system.md + messages.jsonl + turns.jsonl — a turn line is the commit; `turns(id)` reads the lines alone) + MemorySessionStore, idProblem (the id format, shared with git/checkout's `workdir`), and `sessionsCapability` — `ctx.services.sessions`, whose `open` takes the session's in-process lock (`session_busy:`)

### `src/steps/lib/acp/`

acp/prompt: one turn of a LOCAL coding agent over the Agent Client Protocol (JSON-RPC 2.0, one line per message, on the child's stdio; _client.ts, no SDK) — `agent` is a preset (claude and codex through their pinned @agentclientprotocol adapters via npx, goose acp, gemini --experimental-acp, opencode acp) or any ACP command line; the agent brings its own login, model and tools, and the client advertises no fs or terminal. `session` is strut's name for the thread, mapped to the agent's own session id in <dataDir>/acp/sessions/<id>.json and resumed with session/load (its replayed history is ignored); another agent on the same name starts fresh. `mode` plan | edit | auto: set as the agent's own session mode when it offers a matching id, AND enforced on every session/request_permission by tool kind (plan: read/search/think/fetch; edit: + edit/delete/move; auto: all) — refusals come back as `denied` plus an `ask`, so a host can rerun the turn with more room; a refused switch_mode (an agent leaving plan mode) keeps its `plan`, and the ask leads with it. Each tool call is a step.start/step.end (step.error when it failed) at <path>/NNN-<kind> with stepType tool:<kind> and the ACP toolCallId (step.end's output is { title, input, output } — the final title and input, which adapters fill in after the call starts); each stretch of prose a `message` pair. Output { text, session?, stopReason, artifacts (files its edit calls changed, relative to cwd), denied, ask?, toolCalls, cost? (this turn's, from the cumulative usage_update total kept with the session) }. Cancel sends session/cancel. The `job` workflow runs it in place of `agent` when the launch names `input.agent`
