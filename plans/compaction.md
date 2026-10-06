# Compaction — a boundary in an append-only history

> **Status (2026-10-06): built.** Covers the builder chat
> (`createStrut.ts` `launchChatTurn`, `chat-store.ts`) and the `agent`
> step (`steps/core/agent.ts`, `session-store.ts`). Closes the
> "no compaction yet" item in `plans/agent-sessions.md` §9 with a simpler
> shape than the one noted there (an offset in the thread, not a new
> session id). Reviewed 2026-10-06 against the code and Anthropic's
> preserved-thinking guide: the summarizer keeps the loop's request prefix
> (§3, §5) and the headroom reserves room for what is written after a
> result (§4). Built the same day, as written, with these differences:
>
> - The summarizer call is `streamText`, not `generateText` — strut streams
>   every long generation, since a non-streaming connection shows no bytes
>   until the whole summary is written and intermediaries sever it as idle.
> - It sends the loop's tools WITHOUT their `execute` and no `toolChoice`:
>   the bundled Anthropic provider turns `"none"` into no tools at all (the
>   prefix change this plan forbids), and a changed `tool_choice` invalidates
>   the messages cache. The prompt's last sentence does the work; a call
>   that ends in a tool call runs nothing and counts as no summary.
> - The agent step's record (`step.end.messages`, the committed turn) now
>   also keeps the user turns its continuations insert — the stream-error
>   nudge, the final-answer nudges, the forced prompt — so the record is
>   what the model saw; the forced final-answer turn sees the task prompt
>   too. The output gains `compactions: n`.
> - A turn compacted at open sends the summary and the task as two user
>   turns, which the SDK merges into one message on the wire — as it does
>   the tool result and the instruction in the summarizer's request.
> - Tests use the suites' stand-in Anthropic endpoints (SSE, `input_tokens`
>   set past the mark), not a fake provider.
> - The system prompt carries a cache breakpoint of its own
>   (`cachedSystem`), on the loop, the summarizer and the chat. Without it
>   no cache entry ended at system + tools — the automatic breakpoint sits
>   at the end of the messages — and the first request after a boundary
>   read nothing (live, 2026-10-06: `cache_read` 0, the builder's 25k prompt
>   and tools written again). With it that request reads them (25,096 on
>   the builder, 5,120 on an agent step) and writes about the summary.

## Problem

Neither surface has an exit when the model's window fills. The builder
caps every tool result where it is made (`capToolResults`, 50k chars) and
shows a meter, but a chat that reaches the window fails every later turn
with a provider 400 and the only remedy is a new chat. The `agent` step has
no bound on a run's context at all, and its per-result caps are constants
that know nothing about the model: `bash` and `view` return up to 500k
chars each — a quarter of a 1M window at 2 chars per token, more than a
200k window holds — so a handful of them fill the window inside one run
and the step dies on the next call. A session refuses a turn at 90%
(`session_full:`) and leaves the caller to start over.

mcp's `truncateOldToolResults` (`mcp/src/repo/utils.ts`) is the obvious
model and the wrong one. It rewrites the oldest tool results to
`<TRUNCATED>` inside `prepareStep` once the prompt passes 90%, freeing
just enough each step. Under prefix caching that is the worst case: the
first changed byte sits near the front of the conversation, so every step
past the mark rewrites nearly the whole messages cache, and because the
frontier moves each step, every step misses. On Claude Sonnet 5.5 (strut's
default chat model), Opus 5.5 and Fable 5.1 it is also an invalid edit
under preserved thinking: "clear or shorten an earlier `tool_result`"
invalidates every later thinking block, a 400 by default on accounts
created on or after 2026-08-31. Strut's rule since strut#76 — history is
append-only, cap at the source — already forbids it.

## Decided

| Question | Decision |
| --- | --- |
| What a compaction is | **A summary message plus a boundary.** Nothing is edited or deleted: the file keeps growing, and the next request replays from the boundary. One cache rebuild per compaction instead of one per step |
| The shape | **Simple compaction**: the whole conversation so far becomes one user message; nothing before it is replayed, so no thinking block is sent back out of its prefix. Not keep-tail (its kept turns fail the preserved-thinking check unless the API wrote the summary), not server-side (§8) |
| Who writes the summary | **The same model, the same route, the same request prefix**: one streamed call that sends the loop's `system`, `tools` (definitions only — `execute` removed, so a stray call runs nothing) and `providerOptions` unchanged, the conversation, and one summarize instruction whose last sentence forbids tool calls; a reply that ends in one counts as no summary. The prefix must be byte for byte the loop's: a thinking block is bound to system + tools + the messages before it, so a summarizer that dropped the tools would fail the preserved-thinking check on the blocks it replays — and tools head the cache prefix, so it would miss the whole cache (the bundled Anthropic provider answers `toolChoice: "none"` by dropping the tools, which is why it is not used). Same cache namespace, so the call reads the warm prefix; same `llmAuth` link, so the Mothership bills it where the turn is billed |
| When | **After any step whose model call passed the mark**, on both surfaces, with the loop continued from the summary; a session also **at open**, replacing the `session_full` refusal. Never inside a tool round: the loop stops after a step whose results are in |
| The mark | **One env, `STRUT_COMPACT_AT`**, a share of the resolved model's window, default `0.9` — today's `session_full` threshold, with a different action. `1` disables (the provider's limit and `session_full` stay as backstops) |
| The caps | **Follow the window.** The headroom above the mark, less a reserve for what the next call and the summary write, is what one step's results may add, so each surface's per-result cap is `min(its cap, headroom)` — the agent's 500k constant and the chat's 50k env cap are ceilings, and a 200k-window model gets a cap that fits it (§4) |
| Where it is recorded | Chat: the `[compaction]` message in `messages.jsonl` + `ChatMeta.replayFrom`. Session: `replayFrom` on the turn line. Run log: the summary inside `step.end.messages`, plus one nested event like a tool call |
| What stays | Capping at the source (`capToolResults`, the agent's tool caps): the first line of defense. `GET /chat/:id`, `GET /sessions/messages`, `?full=1` keep serving the whole history |

## Design in one paragraph

A conversation is a file that only grows. A compaction appends one user
message, `[compaction] <summary>`, and records where it sits: the
`replayFrom` index. Every request after that is `[system, tools,
messages.slice(replayFrom), …new]` — a new prefix once, then append-only
again, exactly the invariant the prompt cache and prefix-bound thinking
blocks need. The tools and system tiers of the cache survive (for the
builder that is the steps tree, the big stable part); the messages tier is
rebuilt once, from a prefix that is now one short message. The summary is
written by the same model in one call that sends the loop's system, tools
and messages unchanged plus one instruction, with tool use turned off, so
compacting at the moment the cache is warm costs roughly its output
tokens. The mark is high (0.9) because the window is for working in; what
makes a high mark safe is that a tool result is never larger than the room
left above it, less what the next generation and the summary need (§4).
Anthropic documents this shape
as the recommended client-side one: models are trained on it, and it is
legal on every provider and through the gateway because it is plain
messages.

```
messages.jsonl (chat)                      request after the boundary
  0  user      "build me a clip workflow"
  1  assistant tool-call …                   system   (frozen, cached)
  2  tool      …                             tools    (cached)
  …                                          ──────── replayFrom = 41
 40  tool      …                        →    41 user  "[compaction] …"
 41  user      "[compaction] …"              42 assistant …  (the same turn, continued)
 42  assistant …
```

## 1. The pure module — `src/compaction.ts`

```ts
compactAtFromEnv(): number                 // STRUT_COMPACT_AT, default 0.9; ≥ 1 disables
overMark(context: { used, limit }, at): boolean
SUMMARY_MAX_TOKENS = 8_000                 // the summarizer's maxOutputTokens
RESERVE_TOKENS = 12_000                    // SUMMARY_MAX_TOKENS + one ordinary generation (§4)
headroomChars(limit: number, at: number): number   // ((1 − at) × limit − RESERVE_TOKENS) tokens × 2 chars, floored at 0
resultCapChars(surfaceCap, limit, at): number      // min(surface ceiling, headroom), never under MIN_RESULT_CHARS; the ceiling alone when at ≥ 1
summarizeMessage(retain: string): ModelMessage     // the one appended instruction (CHAT_RETAIN / AGENT_RETAIN)
summarize({ streamText, model, system, tools, providerOptions, messages, retain, abortSignal }) // → { summary?, finishReason, usage }
compactionMessage(summary: string, of: { messages: number; tokens: number }): string
isCompaction(text) / parseCompaction(text)  // the `[compaction]` prefix and headline, for the UI
```

`SUMMARIZE` is one prompt, with a caller-supplied line on what to retain.
It says: write a handoff for a model that will see nothing else — the task
as given (verbatim when short), what was decided, what was done and where
(files touched; workflows and steps published, with names and versions;
runs launched, with ids and outcomes; claims left pending), what is open
or failing, any question asked of the user that is still unanswered, and
the latest request. No preamble, no "here is a summary". It ends with the
sentence Anthropic's guide calls load-bearing when the request still
carries the conversation's tools — "Do not call any tools while writing
this summary; respond with text only." — the belt to `toolChoice:
"none"`'s braces. The chat's retain line names strut's objects; the
agent's names the working directory and the files in play.

`compactionMessage` renders `[compaction] Compacted <n> messages (~<k>
tokens).\n\n<summary>` — the model-facing text, which the UI parses like
`[run-notification]` (`web/src/notice.ts` runs against this formatter in
its test, as it does for the others).

## 2. The session store

One field on the turn line: `replayFrom?: number`, an absolute index into
`messages.jsonl` where the next turn's replay begins. `nextTurn` carries
it forward (`record.replayFrom ?? last.replayFrom ?? 0`), so every line
states it and `load` returns `replayFrom` from the last line. Offsets stay
absolute: `sessionInfo`, the `?full=1` stitch
(`thread.messages.slice(0, at.offset)`) and `GET /sessions/messages` are
unchanged. The conformance suite gains one case: a turn committed with
`replayFrom` is read back with it, and a later turn without one inherits
it.

The `OpenSession` the capability hands the step (`SessionsCapability.open`,
both in `session-store.ts`) gains `replayFrom`; the step's `prior` becomes
`session.messages.slice(session.replayFrom)`.

## 3. The agent step

Two arrays where there is one today. `bankedMessages` stays the RECORD of
the turn — everything generated, for `step.end.messages`, `returnMessages`
and the commit. The REQUEST is `head` plus the banked messages after the
last compaction, where `head` starts as `[...prior, { user: basePrompt }]`
and becomes `[{ user: compaction }]` once compacted. One helper,
`conversation()`, replaces the three places that spell
`[...head, ...bankedMessages, …]` today (the stream-error resume, the
nudge, the forced final answer).

The loop:

1. **At open** (session only): if `last.context.used > at × contextLimit`,
   summarize `prior` first. The compaction message becomes the first
   message of THIS turn, before `basePrompt`; the turn's record carries
   `replayFrom = offset` (the index of that message). A failed turn commits
   nothing, so the summary is redone next time — one call, acceptable. The
   `session_full` refusal stays for `STRUT_COMPACT_AT=1`.
2. **Between steps**: `stopWhen` gains `overMark` on `contextUsed`, the
   number `onStepEnd` already tracks. The stream ends after a step whose
   tool results are in; the loop sees no `final_answer`, no error, and the
   mark crossed, so it compacts: one streamed call with the loop's own
   `model`, `system`, `tools` (without `execute`) and `providerOptions`
   (the prefix the replayed thinking blocks are bound to, and the cache's),
   `messages: [...conversation(), SUMMARIZE]` and
   `maxOutputTokens: SUMMARY_MAX_TOKENS`; then `head = [{ user:
   compactionMessage + a fresh cwd preamble }]`, the compaction message is
   pushed onto the record, the compaction index noted, and the loop
   continues with `stream({ messages: conversation() })` under the
   remaining step budget (a compaction consumes no step). The summarizer's
   usage is added to the step's usage and cost. After any continuation the
   step's `steps` and `messages` come from the banked arrays
   (`bankedSteps` / `bankedMessages`), as they do today only on a
   stream-error resume: `res` is the last segment, not the turn.
3. **Visibility**: one nested `step.start`/`step.end` pair at
   `<agentPath>/NNN-compaction`, `stepType: "compaction"`, like a tool
   call — input `{ messages, tokens }`, output the summary truncated for
   the log — so the events panel and the run drill show where the agent's
   memory was folded. The full summary is in `step.end.messages`.
   `wrapToolsWithEmit` keeps its call counter in a closure and is called
   twice (the built-ins, then the web tools): hoist it to one counter per
   step that the compaction event shares, so `NNN` stays globally ordered.
4. **Failure**: a summarizer call that fails — a throw, or a `finishReason`
   other than `stop` (a summary cut off at its cap or at the window is no
   summary) — logs a warning and the loop continues uncompacted;
   `overMark` is still true, so it is tried again at the next step
   boundary. The provider's limit is the backstop, as today: on 4.5+
   models a request whose input plus `max_tokens` exceeds the window is
   accepted, and the generation stops with `model_context_window_exceeded`
   — the same silent truncation a `length` finish is today.
5. **Session commit**: `replayFrom = offset + index of the compaction
   message in this turn's record` when one happened, else inherited.

What does not change: `prepareStep` (the checkpoint and the no-op guard),
the journal (a journaled step replays its output; a compaction inside it
is invisible), `agentTools` sub-agents (each is its own loop with its own
mark), and the `schema`/`finalAnswer` modes (the forced answer turn sends
`conversation()`).

## 4. The caps follow the window

The check in §3 runs AFTER the call that read a step's tool results, so
the results themselves must fit in the room above the mark — and so must
what is written after them before the next check: the generation that
reads them, and the summary if that call crosses the mark. With the
context just under `at × limit` and a result filling the whole gap, the
next request's input sits at the window and the model has nothing left to
write; the summarizer at that point has the same problem. So the headroom
is the gap less a reserve, `(1 − at) × contextLimit − RESERVE_TOKENS`,
where the reserve (12k) is the summarizer's `maxOutputTokens` (8k) plus
one ordinary generation (a tool call is hundreds of tokens; a big file
`create`, a few thousand). Today's caps are constants chosen with no
model in view (`BASH_MAX_CHARS` / `FILE_VIEW_MAX_CHARS` 500k; the chat's
`STRUT_CHAT_TOOL_RESULT_MAX_CHARS` 50k). They become ceilings, and the cap
an agent actually applies is derived from its resolved model:

```
cap = min(surface cap, headroomChars)
headroomChars = ((1 − at) × contextLimit − RESERVE_TOKENS) × 2
```

Two chars per token is the dense case (code, JSON, logs), so a result at
the cap costs at most the headroom in tokens. On a 1M window at 0.9 the
agent's `bash`/`view` cap becomes 176k chars (a 2.5-hour transcript, the
budget the 500k comment was sized for, is prose at ~4 chars per token and
still fits); on a 200k window it becomes 16k, and so does the chat's,
instead of a result the window could not hold at all. The reserve does not
shrink with the window, so a small one wants a lower mark
(`STRUT_COMPACT_AT=0.8` on 200k → 56k chars); the default is sized for the
1M windows strut's models have.

- **Agent step**: two sites. The `bash` tool passes `maxOutputChars:
  BASH_MAX_CHARS` to `runShellProcess` inside the step's `run`, after
  `resolveModel`, so it takes the computed cap instead; `textEdit`'s view
  cap (`FILE_VIEW_MAX_CHARS`, a module constant) becomes an optional
  parameter the tool builder supplies, with the constant as its default so
  the pure function's tests stand. `repo_overview` and `file_summary` cap
  at 12k and need nothing. `exec`'s `maxOutputChars` (500k) is a step
  output, not model context, and is unchanged.
- **Chat**: `buildTools(deps)` ends in `capToolResults(tools)` with the
  env default (`ai/tools.ts`). `AiDeps` gains `toolResultMaxChars`, which
  `launchChatTurn` sets per turn to
  `min(toolResultMaxCharsFromEnv(), headroomChars(llm.contextLimit, at))`
  once `llm` is resolved, and `buildTools` hands it to `capToolResults`.
  History is unaffected: a result is recorded as capped, whatever cap was
  in force when it was made.

**Residual.** A step may call several tools at once, and N results at the
cap can still outrun the headroom; so can one generation far larger than
the reserve. The next call is then cut off at the window
(`model_context_window_exceeded`), the truncated step of §3.4. Sized this
way it takes a burst of maximal reads to get there; if it shows up in
practice, the fix is to summarize the conversation WITHOUT the last step
and re-present those results as text after the summary (§9).

## 5. The chat

`ChatMeta.replayFrom?: number`. The two places that assemble a turn's
messages — `POST /chat` (`prior`) and the notifier's wake-up
(`notifier.ts`) — slice `loadMessages(chatId)` at it; `truncateToolMessages`
applies to the slice as before.

Inside `launchChatTurn` the one `agent.stream(...)` becomes a loop, the
agent step's shape: the agent's `stopWhen` gains `overMark` on the turn's
latest `step.finish` context; when the stream ends with the mark crossed
and the model mid-task (its last step issued tool calls), the turn
appends the response messages so far to `messages.jsonl`, summarizes
`[...modelMessages, ...those messages, SUMMARIZE]` with the turn's own
`instructions`, `tools` (without `execute`) and `providerOptions`,
`maxOutputTokens: SUMMARY_MAX_TOKENS` and the turn's abort signal (a stop
cancels it like any model call), appends the
`[compaction]` user message, sets `replayFrom` to its index, writes
`context` to the summary's size (a floor the next call corrects), emits
one `chat.compact` event (`{ messages, tokens, usage }`) for the tail and
the gateway log, and streams again with `messages: [compaction]` under the
remaining step budget, the same `turn`. When the mark was crossed on the
turn's last step (the model finished), the same compaction runs without a
continuation, so the next turn starts from the summary. A failed
summarizer call is a warning, never a failed turn: the loop continues
uncompacted and the next step boundary tries again.

The file order stays the replay order: everything the model saw is
appended before the summary, and the continuation's messages after it.
The stop path (`POST /chat/:id/cancel`, `partialStep`) and the turn-end
callback are unchanged.

## 6. The UI

- **Chat**: `isNotice` recognizes `[compaction]`; the card reads
  "Compacted 612k tokens of history" collapsed and opens to the summary.
  Everything above it is still rendered (the transcript is whole); the
  card marks where the model's memory restarts. The meter resets at the
  next call.
- **Run flyout**: the nested `compaction` event shows in the events panel
  like a tool call; the Step Run flyout's transcript link already serves
  the whole turn.
- **Sessions**: nothing — `GET /sessions` lists turns, and a turn's
  `replayFrom` rides on its line.

## 7. How it meets the rest of strut

| | |
| --- | --- |
| History is append-only (AGENTS.md "Chat is a detached background job") | Kept: the file only grows, the request after the boundary begins with the previous one's system and tools, and no earlier message is replayed |
| Preserved thinking (Sonnet 5.5 / Opus 5.5 / Fable 5.1) | Legal by construction: the checked prefix is `system` + `tools` + the messages before a block; after a boundary nothing earlier is sent, so no block is out of place. The summarizer call is itself an append under the same `system` and `tools`, so the blocks it replays pass the check too — which is why it may not drop them |
| The gateway | Plain messages; no beta header, no provider-only field. Validated by `npm run test:gateway` with a tiny mark (§11) |
| Other providers | The same: a user message and a slice |
| Mothership | The summarizer call carries the turn's or the step's link; billed where the work is |
| Run control | A compaction happens between checkpoints. In the chat a stop aborts the summarizer like any model call (it takes `ac.signal`); the agent step aborts no model call, so a cancel lands at the next `prepareStep` checkpoint, after the summarizer returns — one call, bounded by `SUMMARY_MAX_TOKENS` |
| Sessions (plans/agent-sessions.md) | One id stays one line; the boundary is an offset on the line, not a new session seeded from a summary — the caller's `{{ input.session }}` contract holds |
| Elicitation | An open question's record is in `meta`, and the retain line keeps "what you asked"; the `[elicitation-response]` arrives as the next user message as before |

## 8. Why not the server's forms

Anthropic offers three, all through the AI SDK provider aieo bundles
(4.0.56) and all known to the pinned Bifrost core (v1.10.1):

- **Context editing** (`clear_tool_uses_20250919`, beta
  `context-management-2025-06-27`): the server clears old tool results
  above a trigger, keeping the last N, `clear_at_least` to batch. It does
  not count as a history edit, but it still "invalidates cached prompt
  prefixes when content is cleared" (its docs), it is Anthropic-only, and
  every provider-native field so far has broken on the routed path
  (`server_tool_use.input`, swarm38).
- **Threshold compaction** (`compact_20260112`, beta `compact-2026-01-12`):
  the server summarizes at a trigger and returns a `compaction` block that
  the provider round-trips as a text part with provider metadata; the
  store would persist it. One cache reset per compaction, as here. Same
  two objections: Anthropic-only, and a gateway round trip to prove.
- **On-demand compaction** (`compact-2026-09-04`, top-level `compaction`):
  the one Anthropic now recommends; not in the bundled provider yet.

The boundary gives the same cache behavior for every provider with no
beta, and the summary prompt is strut's to write. Threshold compaction is
worth revisiting as an Anthropic-only lever once the gateway smoke test
covers a compaction block in both directions.

## 9. Left out

- **A burst of maximal parallel reads** (§4's residual). The fix, if it is
  ever needed: summarize the conversation up to the previous step, then
  continue with `[summary, user: "your last calls returned: …"]`, the
  results re-presented as text — a fresh message, nothing replayed.
- **Keep-tail compaction** (recent turns verbatim after the summary): only
  legal when the API writes the summary (on-demand compaction); the
  provider does not carry it yet.
- **Per-step `compactAt`** on the agent step, and a cheaper summarizer
  model (a different model is a different cache namespace, so the
  summarizer would pay full input price for what the same model reads from
  cache). Both are one line later if a workflow wants them.
- **Forks** of a thread at a boundary; a UI that hides the compacted part.

## 10. Work items

1. `src/compaction.ts` + `compaction.test.ts`: the env, `overMark`, the
   reserve + `headroomChars`, the prompt (with its closing no-tools
   sentence), the message formatter and parser.
2. `src/session-store.ts`: `replayFrom` on the turn line, carried forward;
   `load` returns it; `OpenSession` (the capability's handle) exposes it;
   one conformance case.
3. `steps/core/agent.ts`: `conversation()`, the `overMark` stop condition,
   the compaction continuation (the summarizer under the loop's own
   prefix, tools without `execute`; result and record from the banked
   arrays), the open-time compaction, the nested event (one hoisted call
   counter), usage folded in, `replayFrom` on the commit, and the
   window-derived cap threaded into the tool builders. Tests in
   `agent-session.test.ts`'s style (a stand-in provider that also answers
   with a text reply and reports `input_tokens` past the mark): compacts
   between steps and the next request is `[summary, …]` while the record
   is whole; the summarizer request carries the same `system`, `tools` and
   `tool_choice` as the step before it; never inside a tool round; a
   session over the mark compacts at open and the line carries
   `replayFrom`; a failed or cut-off summarizer call does not fail the
   step; a `bash` result is capped at the headroom of a small-window model.
4. `createStrut.ts` + `ai/notifier.ts`: `ChatMeta.replayFrom`, the two
   slices, the continuation loop in `launchChatTurn`, the `chat.compact`
   event, the context floor, the per-turn cap. Tests in
   `chat-endpoints.test.ts` with the fake provider: a turn over the mark
   appends `[compaction]`, sets `replayFrom` and continues the same turn
   from the summary; the next turn's request is `[summary, user]`; `GET
   /chat/:id` still returns everything.
5. `web/src/notice.ts` + `notice.test.ts` (against the server formatter),
   the card in `ChatFlyout.tsx`.
6. Docs: the env table and the chat / agent-session bullets in AGENTS.md
   (the `bash` cap comment), `specs/API.md` (`replayFrom` on `ChatMeta`
   and the turn line, the `chat.compact` event), `plans/agent-sessions.md`
   §9 → this plan.

## 11. Validation

- `npm test`: the four suites above, offline.
- Live, direct: an agent run and a chat with `STRUT_COMPACT_AT=0.01`
  (10k tokens on a 1M window — compacts after the first big tool result)
  on Sonnet 5.5; the next request's `cache_creation_input_tokens` is the
  summary's size and `cache_read_input_tokens` the system prompt's, and
  the step's `context` after the compaction is a fraction of before. Run
  it once more with the preserved-thinking check forced on: the
  `thinking-binding-controls-2026-08-01` beta header (`headers`) plus
  `thinking.block_binding.prefix_mismatch_behavior: "error"` — through
  `providerOptions` if the bundled provider passes `block_binding`
  through, else by replaying a recorded request pair raw
  (`scripts/gateway-raw-sse.sh`) — so a boundary that violated the check
  400s here before it does on a new org. The summarizer's request is the
  one to watch: it replays every block of the turn.
- `STRUT_TEST_GATEWAY=1 npm run test:gateway` with the same mark: one
  agent run that compacts through Bifrost, per "When changing how LLM
  calls or tools are built".

References: Anthropic, *Preserved thinking* (what counts as an edit;
"Compact on the client — Simple compaction (recommended)"), *Context
editing* (cache invalidation on clearing, `clear_at_least`), *Compaction
overview / on demand / at a token threshold* (the server forms, 2026-10-01);
the Fable 5.1 migration guide's summarization prompt for client-side
compaction (tools cannot be dropped for one request; the no-tools closing
sentence); *Context windows* (input + `max_tokens` over the window is
accepted on 4.5+ models and the generation stops with
`model_context_window_exceeded`, 2026-10-06).
