# The AI workflow builder

The builder chat (`POST /chat`), its tools, prompt, history and compaction, notifications, callbacks and elicitation, and the `meta/*` twins the builder job uses.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| AI builder  | Vercel AI SDK `ToolLoopAgent` over any aieo provider (model picker in the flyout, per-chat `ChatMeta.model`); detached + persisted, reattach via `/chat/:id/stream` SSE |

## Key concepts

- **AI tool args may arrive as JSON strings.** LLMs sometimes pass an
  object-valued tool arg (e.g. `run_workflow`'s `input`) as a JSON
  *string*; the template engine then sees a string and `{{ input.* }}`
  resolves to `undefined`. `buildTools` (`ai/tools.ts:coerceJsonArg`)
  defensively `JSON.parse`s string args that look like objects/arrays for
  `run_workflow` + `run_step` (`input`/`params`/`config`).

- **AI workflow builder** (`src/ai/` + `POST /chat`). A
  `ToolLoopAgent` (Vercel AI SDK, any aieo provider — see "Model picker"
  below) that can browse step
  types (`list_steps`, `search_steps`, `get_step`), author/revise
  custom steps (`create_step`, `edit_step`), publish workflows
  (`create_workflow`), and test them (`run_workflow`). `run_workflow`
  threads `ctx.services` (via `AiDeps.services`), so the agent can
  run workflows whose steps reach external systems (Neo4j, the lab's
  `optimizer`, …) — not just service-free core/lib ones. The system
  prompt is built by `buildSystem(deps)` (pre-seeds the steps tree) on
  a chat's FIRST turn and replayed verbatim after — see "History is
  append-only" below. Its rules (the dialect, the "Tools" section, the
  procedure) are the same text the `builder` JOB's prompt is — rendered
  from one role → tool-name map in `src/ai/prompts.ts`, with the chat's
  names for the chat and the `meta/*` names for the job — so the two
  never drift; the chat's rendering is pinned byte for byte by
  `src/ai/prompts.test.ts`.

- **`chatSystem` — the host's section of the builder's prompt**
  (`createStrut({ chatSystem })` → `AiDeps.hostSystem`). Strut's prompt
  knows how to build workflows, never WHAT a deployment builds: a domain
  convention (what a "janitor" is, which seeded workflow runs one) belongs
  to the host, not in `BASE_SYSTEM`. The hook is called once per CHAT,
  when its first turn renders the prompt, with `{ chatId, turn, actor? }`,
  and its text is appended verbatim after
  strut's rules (and the claims section), before the models line and the
  steps tree — which stays last. The prompt is then frozen for the chat
  (it heads the cached prefix), so an edit to the host's section reaches
  new chats only. Default on a graph (`src/ai/builder-system.ts`): the
  `Workflow Builder` Concept's page and the kinds under it, the page strut
  seeds at boot (`src/concept-seed.ts`); a host's hook replaces it.
  Nothing returned, or a throw (one warn line) → the prompt is strut's
  alone; a turn never fails on it. The text has SYSTEM authority over a
  builder that can publish steps and run bash, so the host owns where it
  comes from and how long it is.

- **`list_secrets` tool** (`AiDeps.secrets`). The agent can list the
  **names** of available credentials (never values — it's the same
  names-only view as `GET /secrets`) so when it authors a step it
  references an existing secret name in `ctx.services.secrets.get("NAME")`
  rather than guessing, and tells the user which secret to add when one
  is missing. Deliberately **read-only**: the agent has no
  set/delete — writing a value through the model would defeat the
  write-only design, and adding a secret is a human action. Wired only
  when strut owns the secret store (absent when the consumer injected
  their own `services.secrets`; the tool then returns an error).

- **Chat is a detached background job** (`src/chat-store.ts`), NOT a
  connection-bound stream — the same launch+reattach model as runs
  (§8). `POST /chat { chatId?, message, model? }` appends the user message,
  launches the turn server-side **without awaiting it** (a
  `launchChatTurn` mirroring `launchDetached`), and returns
  `{ chatId, turn }` (202). The turn consumes the agent's `fullStream`
  and persists each part; close the browser and it keeps running.
  Watch/reattach via `GET /chat/:id/stream` (SSE tail), load the
  transcript via `GET /chat/:id`, list sessions via `GET /chats`.
  `POST /chat/:id/cancel` stops the live turn (the flyout's stop square,
  shown only while the chat is working): the agent stream is aborted, what
  streamed so far is persisted — a tool call cut off before its result gets
  a stopped result, so the next turn never re-feeds a dangling call — and
  the turn ends `chat.end { stopped: true }`, status `done` (the turn
  callback carries `stopped: true` too). Queued notifications still drain.
  Each chat lives in `chats/<id>/` with the deliberate **two-file
  split** (borrowed from `mcp/src/repo/session.ts`): `messages.jsonl`
  is the **replayable** conversation, exactly as the model saw it
  (re-fed to the agent next turn + rendered as transcript — whole
  `ModelMessage`s, never deltas — written as each STEP of a turn ends, so a
  turn cut off by a restart leaves whole steps behind, never a call without
  its result); `events.jsonl` is the fine-grained **observability** stream
  the SSE tail follows (text deltas, tool calls/results, step/turn
  boundaries — never re-sent to the model); `meta.json` tracks
  `{ status, currentTurn, … }`. A chat is long-lived across turns, so
  the launch+tail unit is a **turn**: each turn's events carry
  `turn: N` and end with `chat.end`/`chat.error`, and `tailEvents`
  replays a multi-turn log but stops at the requested turn's terminal
  (race-free, like the run tail). The shared tail engine is
  `tailJsonl` in `store.ts` (used by both `FileRunStore.tailEvents`
  and `FileChatStore`).
  **History is append-only — the prompt cache depends on it.** What a
  turn sends is the previous request plus new messages, byte for byte:
  a rewritten earlier message misses Anthropic's cache from that point
  on (the WHOLE conversation once the change sits beyond its 20-block
  lookback, since the chat has one automatic breakpoint), and on models
  that bind thinking blocks to the prefix (Opus 5.5, Fable 5.1)
  invalidates every later block — a 400 on accounts enforced for it. So
  (1) tool results are capped WHERE THEY ARE MADE: `capToolResults`
  (`ai/tools.ts`) wraps every builder tool's `toModelOutput` with
  `capToolOutput` (each string, then the whole result as the model reads
  it — long arrays kept head + tail with a `{ omitted, from, to }` gap,
  strings cut shorter, by the largest factor that fits; idempotent; env
  `STRUT_CHAT_TOOL_RESULT_MAX_CHARS`, default 50000, `0` disables), so
  the model reads the capped result in its own turn and `messages.jsonl`
  records exactly that (the uncapped output is in `events.jsonl`);
  `truncateToolMessages` applies the cap on replay: to a result the model
  READ (an assistant message came after it) only its strings, a no-op
  except for histories recorded before the cap moved; to a result nothing
  came after (its request refused) the whole cap, since nothing is bound
  to its bytes — the way out for a chat whose last result was over the
  window (swarm38, 2026-11-02: 5,622 rows in one `run_workflow`, every
  later turn `prompt is too long`). The two DOCUMENT reads
  (`get_workflow`, `get_step` — `DOCUMENT_TOOLS`) get the window's headroom
  with no ceiling at the source (`AiDeps.documentMaxChars`) and are skipped
  on replay: a 50k workflow is read whole, and `edit_workflow` /
  `edit_step` take `edits` (exact-string replacements) so even a cut one
  is editable without being resent. (2) The system prompt is
  rendered on a chat's first turn and stored (`ChatStore.getSystem` /
  `setSystem`, `chats/<id>/system.md`), then replayed verbatim: a step
  published mid-chat never re-renders the steps tree, and the model
  reads what changed through `list_steps` / `search_steps`. (3) When the
  window fills the turn COMPACTS instead of editing (plans/compaction.md
  §5; `src/compaction.ts`): after a step whose model call passed the mark
  (`STRUT_COMPACT_AT`, 0.9) — its tool results in, so never inside a tool
  round — the turn has the same model summarize everything it has seen,
  in one streamed call under the turn's own system prompt, tool
  definitions (without their `execute`) and cache options — the prefix the
  thinking blocks are bound to; a summarizer that dropped the tools would
  fail the preserved-thinking check and miss the whole cache — appends
  the summary as a `[compaction]` user message, sets `ChatMeta.replayFrom`
  to its index, emits `chat.compact` (the meter's floor rides on it), and
  goes on from the summary alone when the model was mid-task; a finished
  turn leaves the summary for the next one. Every later turn replays
  `messages.jsonl` from `replayFrom` (`POST /chat` and the notifier's
  wake-up both slice there). The file only grows, `GET /chat/:id` serves
  it whole, and the flyout shows the boundary as a collapsed card
  ("Compacted 612k tokens of history") that opens to the summary. A
  summarizer that fails, or stops short of `finishReason: stop`, is a
  warning: the turn goes on uncompacted and the next step boundary tries
  again.
  **Context meter:** each `step.finish` event carries `context: { used,
  limit }` — that model call's input (cached reads included) plus its
  output, against aieo's window for the model (`ResolvedModel.contextLimit`)
  — also written to `ChatMeta.context`; the flyout header shows it as
  `351k / 1M`, amber from 80% (`web/src/context-meter.ts`).
  `chatMaxSteps` (env `STRUT_CHAT_MAX_STEPS`, default 100) bounds the
  per-turn agent loop. The browser (`web/src/api.ts`: `sendChat` +
  `streamChat` + `getChat`) persists the active `chatId` in
  localStorage and reattaches to a still-live turn on reopen.
  **A restart mid-turn** (`reconcileStaleChat` + `autoResumeStaleChats` in
  createStrut — the chat twin of run auto-resume, the same
  `STRUT_AUTO_RESUME` gate on the CHAT store's kind): a chat left `live` by
  the dead process is reconciled on first sight — the boot scan 3 s after
  construction, or whichever read finds it first. Its dead turn gets
  `chat.error` (`chat.end` when that turn had asked the user: the question
  stays open, nothing else was lost), and with auto-resume on a
  `[restart-notification]` (`formatRestartNotification`, ai/notifier.ts) is
  appended that says what the event log knows and the transcript does not —
  the tool calls with no result yet, the detached runs that will never
  notify — and the chat is woken through the notifier like a run
  notification: counted against the auto-turn cap, so a turn that crashes
  the server every time parks after 10 restarts; appended but not launched
  past 7 days idle. `POST /chat` appends the notice and lets the typed
  message's turn follow. The host hears the dead turn's `turn.end` (no
  `trigger`; `settled: false` while the wake-up turn runs). Off: marked
  `error` on first read, nothing appended. The UI shows the notice as a
  "Server restarted" card.

- **Attachments — files on a builder message** (`src/ai/attachments.ts`).
  `POST /chat { attachments: [{ name, mediaType?, data }] }` (`data` base64
  or a data URL; the message may then be empty) — at most 10, 10 MB each, 5
  MB an image, 15 MB together, refused with a 400 before anything is
  persisted. Each file is written to `<dataDir>/uploads/<chatId>/` (never
  over an earlier one of the same name) and becomes parts of the user
  message after the typed text: an `[attachment] <name> (<type>, <size>) —
  saved at <absolute path>` line, then the image or PDF as a `file` part (the
  model sees it; verified direct and through the gateway), or the text
  inline — anything UTF-8, or a .docx / .doc's extracted text, cut at 200k
  chars — or nothing more (the builder reads it with bash). The bytes stay in
  `messages.jsonl` like any content, so they are replayed every turn until a
  compaction: hence the caps (Anthropic refuses a request over 32 MB). The
  flyout attaches by the paperclip, a drop on the flyout or a pasted
  screenshot, and shows the files as chips (`transcript.ts` `userContent`).
  **A run takes them too** — `POST …/run { attachments }`, the same shape
  and caps, a launch-level field beside `mcp` (a host's message to the
  orchestrator, the person's files with it).
  Saved under the run's ARTIFACTS as `attachments/<name>` before the first
  event (`saveRunAttachments`; a repeated name numbered), recorded on
  `run.start` as `attachments: [{ name, mediaType, size, path }]` — never
  the bytes, so a resume reads them back from there — and handed to every
  step as `ctx.attachments`. Every `agent` step of the run puts them on its
  prompt as the parts above (`attachments`, default true; a sub-agent never
  gets them — its prompt is its caller's words); in a session they are that
  turn's message, replayed like the chat's, and the turn line records them
  (`SessionTurn.attachments`). `job/start` / `job/continue` take
  `attachments: [name]`: the files the job needs — this turn's, or, from an
  agent with a `session`, one an EARLIER turn of its thread carried (the
  agent hands its tools those too, newest turn first, each with the `runId`
  that holds it; a name attached twice is the newest), so a file the
  person attached before answering a question still goes with the job.
  Read back from the artifacts of the run each came with and launched with
  the job's run, which keeps its own copies — the job does not see the
  conversation. A name no turn had is refused with the ones the
  conversation has. Refused for a builder job on a peer
  (strut/run-workflow carries no files).

- **Dispatch-mode `run_workflow` + run notifications**
  (`src/ai/notifier.ts`, `plans/dispatch-run-notifications.md`). The chat
  agent's `run_workflow` tool races the run against a wait window
  (`chatRunWaitMs`, env `STRUT_CHAT_RUN_WAIT_MS`, default 60s): a fast run
  returns synchronously as before; a run that outlives the window converts
  to DETACHED — the tool returns a `{ status: "running", detached: true,
  runId }` stub (a well-formed tool RESULT, so `messages.jsonl` never has a
  dangling tool call), the run is tracked in `activeRuns`, and when it
  settles the notifier WAKES the chat: it appends a slim user-role
  `[run-notification]` message (status, duration, truncated output — the
  agent has `get_run` for the rest) and launches the next turn through the
  same `launchChatTurn` path a human message uses. Notifications arriving
  while a turn is live queue and drain into ONE wake-up turn (via
  `launchChatTurn`'s `finally` → `notifier.turnEnded`). Liveness is an
  in-process set (not `meta.status` — stale after a crash; pending
  notifications die with the process — the `[restart-notification]` that
  wakes the chat after the restart names the runs that will never report). Runaway
  guard: `ChatMeta.autoTurns` counts consecutive machine-triggered turns
  since the last human message (`POST /chat` resets it); at
  `chatMaxAutoTurns` (env `STRUT_CHAT_MAX_AUTO_TURNS`, default 10) the chat
  PARKS — notifications still append to the transcript but no turn
  launches until a human replies. The seam is `AiDeps.detach` (absent →
  the tool awaits to completion, unchanged for tests/embedders). The tool
  is an async generator: its first yield, `{ status: "running", workflow,
  runId }`, is a preliminary result (a `tool-progress` chat event) the
  flyout opens the run on at LAUNCH, so the sidebar and canvas follow it
  live; only the last yield reaches the model (a direct `execute` caller
  drains it). The flyout polls `GET /chat/:id/meta` (~4s, idle+open only, one in flight; the transcript is loaded when the turn advanced) to notice
  server-initiated turns and renders `[run-notification]` /
  `[verify-notification]` messages as a collapsed notice card, not a user
  bubble (`web/src/notice.ts` parses the model-facing text —
  `notice.test.ts` runs it against the server's own formatters, so a
  format change there fails a test; `NoticeView` opens it level by level:
  card → claim → evidence + checks → raw message. Unparseable → the old
  dashed text notice).

- **Turn-end callbacks — how a HOST dispatches the builder**
  (`src/ai/turn-callback.ts`; the URL check + poster are `src/callback.ts`,
  shared with run callbacks). A turn takes seconds or hours, and one
  dispatch can produce SEVERAL turns (the detached-run / verify wake-ups
  above), so a host app does not tail or poll: `POST /chat { …, callback:
  { url } }` stores the URL on `ChatMeta.callback` — on the CHAT, so
  notification-triggered turns post too; `callback: null` clears it — and
  the 202 carries `callback: true` (the host's proof this server honors
  the field; an older one ignores it and would never call back). Every turn
  end POSTs `{ event: "turn.end", chatId, turn, status, trigger: "human" |
  "notification", text?, error?, settled, parked, elicitation? }` from `launchChatTurn`'s
  `finally`, AFTER the notifier's drain — so the chat is no longer live when
  the host hears (it may reply at once without a 409), unless queued
  notifications already launched the next turn. `settled: false` = something
  this process knows of will (or may) start another turn: an `expect()`
  token is outstanding (a detached run until its notification is delivered;
  a watched verify pass until its verdict is delivered, folded into the
  run's notification, or found to be nothing) or the next turn is already
  live. When the last token resolves WITHOUT a turn (a quiet verify pass; a
  notification that parked at the auto-turn cap) an `{ event: "settled" }`
  post follows — a host told `settled: false` always hears `settled: true`.
  `parked` = the auto-turn cap is reached. Posts are chained per chat
  (ordered), retried a few times, detached from the turn; state is
  in-process, the notifier's crash posture (a restart drops it — the host's
  fallback is `GET /chat/:id`). The URL is the credential (the host signs
  it): logs and read endpoints (`GET /chat/:id`, `/chats`) carry its origin
  only.

- **Elicitation — the builder asks the user, and secrets never touch a
  model** (`plans/elicitation.md`; `src/ai/elicitation.ts` pure, the rest
  in `ai/tools.ts` + `createStrut.ts`). Shapes are ACP's elicitation RFD:
  `mode: form | url`, `message`, a FLAT `requestedSchema` (string / number /
  integer / boolean, enum | oneOf selects, array-of-enum multi-selects — no
  nested objects), `action: accept | decline | cancel`, `content`,
  `elicitationId`. Two chat tools: `ask_user({ message, requestedSchema })`
  is form mode; `request_secret({ name, reason })` is URL mode for ONE
  secret — the server builds a RELATIVE link to its own page
  (`?chat=<id>&elicit=<eid>`), and the model, transcript, events, callback
  and logs only ever carry the NAME (`ask_user` refuses a field whose name
  or title looks like a credential). A select's options are what the model
  OFFERED, never a constraint: the form always ends a single or multi
  select with "Other…" (a text box; `FieldDesc.other`, set only by the
  question mapper, so a step's Zod enum stays strict), `validateContent`
  takes any string there, and the prompt tells the model the value is the
  user's own answer. The prompt also says a `decline` is not a pick: say
  what is needed in one line and stop — before this a user whose answer
  was not among the options hit Decline and watched the model choose for
  them (2026-10-12). **Transport:** the tool records the
  question on `ChatMeta.elicitation` (ONE per chat; a new ask replaces it,
  the replaced id comes back; persisted, so it survives a restart) and
  returns `{ elicitationId, status: "asked" }`; the agent's `stopWhen` ends
  the turn on a tool RESULT that asked (`stepAsked` — a refused ask does not
  end the turn, so the model can retry), a complete call with its result.
  The answer arrives as the next turn's user message,
  `[elicitation-response] <id> accept|decline|cancel [by <actor>]` (+ the
  content as JSON, or `— secret NAME stored (value not shown)`), through
  `POST /chat/:id/elicitations/:eid { action, content? }` or
  `…/:eid/secret { value }` (the name comes from the server's record, never
  the request; both behind `requireApiKey`; 404 once the question is
  closed). Both hand the message to `notifier.deliver(…, { human: true })`:
  `autoTurns` resets, the turn launches as `human`, or QUEUES behind a live
  one — so a form never sees a 409 (`POST /chat` keeps its 409, and closes
  the open question). Who answered is RECORDED (`by`), never checked against
  the chat's actor: the secret store is deployment-global, so the
  deployment's auth in front of the UI is the binding, as for `PUT
  /secrets`; the id is crypto-random because with the key unset the link is
  the authorization to write one named secret. **Hosts:** `turn.end`
  carries `elicitation` whenever a question is open, and when THIS turn
  asked it `text` IS the question — a host that only reads text still sees
  it and a prose reply through `POST /chat` answers it. **UI:** the flyout
  renders `meta.elicitation` as `ElicitationForm` (fields via
  `web/src/elicitation.ts` → `ConfigField`, which gained a `multi` kind
  and the `other` text box);
  the response renders as a notice card (`notice.ts`); `elicit` joins the
  embed deep-link params, set while open and dropped once closed. Tests: the
  pure module, the notifier's human path, the endpoints, a sentinel-secret
  no-leak test over transcript/events/meta/callbacks/logs/responses, and a
  fake provider proving the turn stops on an ask and goes on after a
  refused one (`chat-endpoints.test.ts`).

## Files

What each file and folder in this area is, in the order of the tree.

### `src/chat-view.ts`

the chat VIEW an external agent reads (the assistant MCP door), the chat twin of run-view.ts: `messages.jsonl` folded into TURNS — the caller's message (or the server notice that woke the builder), the builder's final text, and `did`: what the turn CHANGED, folded from the tool calls by tool NAME over the builder tools' own result shapes (workflows published, steps, runs launched with their artifacts — a detached run and its result one entry — schedules set, the question asked), never from prose. `since` is a message-index cursor, `limit` keeps the newest turns, `detail` adds the calls (previews, or whole), a 20k budget cuts text then the oldest turns and says so. Pure; tested

### `src/chat-store.ts`

ChatStore interface + FileChatStore + MemoryChatStore (chats/<id>/: meta.json + system.md + messages.jsonl + events.jsonl) + capToolOutput (the builder's tool-result cap) + truncateToolMessages (the same cap on replay)

### `src/compaction.ts`

compaction (plans/compaction.md): the mark (`STRUT_COMPACT_AT`, `overMark`), the window-derived result cap (`resultCapChars`), the summarizer call (`summarize`: the loop's own system + tools without `execute` + provider options, the conversation, one instruction, streamed) and the `[compaction]` message the chat and the `agent` step APPEND as the boundary a replay starts from — history is never edited

### `src/builder-seed.ts`

the third, `builder` (plans/builder-job.md): a WORKFLOW BUILD as a job — the meta/* authoring twins, app/* and git/checkout (a repository to learn from, into the job's directory: the prompt names the job id for its `workdir`) as the agent's tools, the web tools and the editor family as its built-ins (never bash), the `Workflow Builder` page in its prompt (which says when to ask for a task type and that the worker app grants the `task/*` steps), `task/types` and `task/set-type` (plans/human-steps.md §9.8: a task type asked of an ADMIN, in `approve:` beside package/install, package/commit and remote/buy-credit — the builder's alone, never `job`'s, `orchestrator`'s or the chat's), the job's reply shape; its system prompt is the builder CHAT's rules — the dialect, the tools section and the procedure, in the twins' names (`builderRules(JOB_TOOLS)`, ai/prompts.ts) — rendered into builder.yaml's `<<strut: the builder's rules>>` line before the host's delta is appended (`templateWithDelta`'s `fill`), so the hash covers it and a rules change publishes the next version at boot; `peer: true` in the template, so another strut may launch it as published (the orchestrator's door to building on `@acme-web`). Same seeding, same delta — `createStrut({ builder: { tools, approve, system, model, peer } })`, `peer: false` the one addition (a delta may CLOSE a workflow to peers, never open one). A workflow lives on one strut (its graph, secrets, services), so a build runs on the strut it belongs to, while code is checked out wherever a job runs: `job` never carries these tools, and a job agent that meets a build runs `builder` itself through meta/run-workflow (the `Job` page's docs). No bash on it is focus, not a sandbox — it can publish and run an `exec` step or run any unsealed workflow — so `peer: true` says a forwarded person may run code there (builder.yaml's header). `builder: false` seeds nothing

### `src/steps/lib/meta/`

the AUTHORING TWINS (EVOLVE_SPEC §5.2): the chat builder's tools as registry steps over `ctx.services.authoring` (authoring.ts `buildAuthoringCapability`, the meta policy on top) — what the `builder` job and an evolve loop author through. Steps: list/search/get-step, create-step, edit-step (`code` or `edits`), run-step, list/get-workflow, validate-workflow, publish-workflow (the upsert), edit-workflow (`edits` over the active YAML, then the same publish), set-active-version (rollback, workflow or step), set-workflow-category, run-workflow, list/get/search-runs, resume-run, cancel-run, pause-run (never the caller's own run: `ownRunRefusal`), list-secrets, the claim steps, verify-run, verify-job. Not in the chat's set: bash, ask_user / request_secret (the job asks in its reply), peers, schedules (below)

### `src/ai/`

AI workflow-builder backend (used by POST /chat)

### `src/ai/index.ts`

barrel export

### `src/ai/prompts.ts`

SYSTEM prompt + buildSystem(deps) (pre-seeds steps tree); AiDeps carries `services` + `secrets` (read-only names). The builder's RULES — strut's workflow dialect, the "Tools" section, the procedure — are ONE text rendered from a role → tool-name map (`BuilderTools`, plans/builder-job.md §1): `CHAT_TOOLS` for the chat, byte-identical to the prompt it always had (prompts.test.ts pins it against `fixtures/chat-system*.txt` — it heads every chat's cached prefix), `JOB_TOOLS` (the meta/* twins, app/*, the graph reads; `chat: false` — no listing, no detach, no bash, ask in the reply; the job's own lines for meta/edit-workflow, rollback, category and run control sit in its branch of the Tools section, the chat's untouched) for the builder job, which builder-seed.ts renders through `builderRules`

### `src/ai/builder-system.ts`

the DEFAULT `chatSystem` on a graph: the `Workflow Builder` Concept's docs + the kinds under it (`PARENT_OF`), rendered by the `context/concept` step (framed as the workspace's notes, docs capped at 6k); a host's own hook replaces it

### `src/ai/tools.ts`

buildTools(deps): list_steps, search_steps, get_step, list_secrets (NAMES only), create_step, edit_step, list_workflows (query?/limit?: slim entries — name/description/category/activeVersion — cut at 100 with `total` + a `hint` the model reads; the sidebar's matcher, src/search.ts) / get_workflow (one metadata read; both shared with the meta/* twins through authoring.ts), create_workflow / edit_workflow (the full YAML, or `edits`: exact-string replacements over the active version, each matching once — a one-line change to a 50k workflow without resending it; edit_step takes the same), run_workflow (threads ctx.services), graph_query (read-only Cypher; only when deps.graph is wired), graph_get (the graph/graph-get STEP as a chat tool — its schema, its run(); one node by ref_id or type + name, with `children`; same gate), graph_walk (graph/walk as a chat tool; same gate), list_runs / get_run (a run as a TREE — src/run-view.ts) / search_runs (grep across recent runs' logs → (runId, path, snippet); then get_run on a hit's path), set_active_version (rollback), cancel_run/pause_run/resume_run (when deps.controlRun is wired; resume_run also HEALS a dead run onto the active version with deps.resumeRun), validate_workflow (static YAML check, no publish — src/validate.ts), list_automations / set_automation / delete_automation (schedules; when deps.automations is wired), ask_user / request_secret (the builder asks the user — plans/elicitation.md; when deps.openElicitation is wired)

### `src/ai/walk-tool.ts`

graph_walk (OFF for now: `GRAPH_WALK_TOOL_ENABLED` in prompts.ts): an async-generator tool bridging runWalk's per-hop ctx.emit to preliminary results (→ `tool-progress` chat events, GET /chat/:id/progress/:toolCallId for history); toModelOutput hands the model only { goal, stopped, decider, nodes }

### `src/ai/turn-callback.ts`

POST /chat { callback }: every turn end POSTs to the host with `settled` (expect() tokens for detached runs + verify passes) — how a host app dispatches the builder without tailing

### `src/ai/attachments.ts`

files on a chat message (`POST /chat { attachments }`): validated + capped, saved under `<dataDir>/uploads/<chatId>/`, turned into the user message's parts — an image or a PDF as a `file` part the model sees, text and Word (.docx/.doc via `word-extractor`, lazy) as inline text, anything else announced with its path for bash. A run's (`POST …/run { attachments }`) the same, saved under the run's artifacts (`saveRunAttachments` / `loadRunAttachments`) and put on its agents' prompts

### `src/ai/mcp.ts`

strut over MCP (stateless Streamable HTTP, one SDK `Server` per request, the SDK lazy-imported): `toolsetServer` adapts ANY AI SDK ToolSet GENERICALLY, so no tool exists twice — tools/list from each tool's `asSchema` JSON Schema, tools/call = validate → execute → drain a generator (earlier yields → `notifications/progress`) → `toModelOutput` (where the cap lives) → content (+ `structuredContent`; `isError` on a `{ error }` result) — and `createMcpDoor` is the per-request transport. Three doors in createStrut: `POST /mcp` = the ASSISTANT set (assistant-tools.ts; `assistantInstructions`, ten lines), `POST /mcp/builder` = the BUILDER set (`builderServer`: `buildTools(deps)` + `builderInstructions` = BUILDER_PROCEDURE + the UI's URL + its `?secrets=1` deep link, since ask_user / request_secret are not offered there, + the full `buildSystem` — the host's `chatSystem` section included, resolved at each prompts/get with chat id `mcp` — as the `workflow-builder` prompt); with the chat off `/mcp` serves the builder set; `POST /index/mcp` = the INDEX role's STORE set (packages/index-tools.ts: three reads over the index's derived pages, open to anyone). createStrut's `builderDeps` is what both doors and the chat turn share; the doors add `publicUrl` + `artifactRefs` (artifact links absolute with their `?t=` file token, `ui` deep links) and a polling detach hint (get_run's `wait`). specs/API.md §11

### `src/ai/assistant-tools.ts`

the ASSISTANT tool set, `POST /mcp`'s default: NINE tools for an external agent (Claude Code, Hermes) that has forty other tools and should not learn strut's YAML — `ask_workflow_builder` (a message to the builder, new chat or continuation; holds up to `wait` and returns the turn's `text` + `did` from chat-view.ts, `status` done | working | asked (the open question, a secret's link for the caller's USER) | parked | error, `settled`), `read_workflow_builder_chat` (turns since a cursor), `list_workflow_builder_chats` (find a chat again; `mine` by the connection's `x-strut-actor`), `list_workflows` (+ schedules, last run), `list_runs` (+ each run's artifacts as links), `get_run` (the basics; an output field over 2k chars HELD BACK as `{ $omitted }` until named in `fields`; `files: true` lists the run's files with links; no step tree — the builder debugs), `run_workflow` (the builder's own, output trimmed the same way), `search_packages` (the package STORE over `ctx.services.packages`: the followed indexes' hits with their `detail`, the peers' installs) and `get_package` (one package's page as a model reads it, `briefPackagePage`, with `ui` = `<base>/?install=<name>`, the person's Publish dialog on its Packages tab, on the name) — the two say a PERSON installs, and where. No model behind any but the first. `AssistantChatDoor` is createStrut's way in: `sendChatMessage` (POST /chat's core, shared), the notifier's liveness, the turn callbacks' `isSettled`; a chat started here is stamped `ChatMeta.publicUrl`, so the builder's tool results in it carry absolute links and its reply text copies them

### `src/ai/elicitation.ts`

the builder asks the user (plans/elicitation.md), the PURE half: ACP's flat schema subset + validator (model schema, submitted content), the secret-looking-field guard, crypto-random ids, `stepAsked` (the chat's stop condition), the `[elicitation-response]` formatter, the question as callback text

### `src/ai/stepHelpers.ts`

lsSteps / searchSteps / readStepSource (filesystem-style browser)

### `src/ai/schemaHelpers.ts`

zodToFields: Zod → FieldDesc[] (the UI config form); stepSchemas: Zod → JSON Schema (get_step's input/output for the builder)
