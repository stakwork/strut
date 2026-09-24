# Repo agent — mcp's `POST /repo/agent` as a strut workflow

> **Status (2026-09-23): assessment, nothing built.** Every numbered
> section under §4 is one work item, to be taken one at a time. §5 records
> what was decided in strut's favour and needs no work. §6 is the open
> unknown. Companion: `plans/code-change.md` (the first repo_agent surface
> moved to strut, and the foundations this reuses: `git/checkout`, actor
> secrets, callbacks, `ctx.onRunEnd`).

## 1. The idea

mcp's repo agent (`mcp/src/repo`, ~18k lines) is a `ToolLoopAgent` over a
cloned repository with a large tool surface: filesystem and bash, the
stakgraph code graph, jarvis, concepts, Workflow nodes, MCP servers, remote
sub-agents, skills, spreadsheets, PR creation. It is exposed as `POST
/repo/agent`, an async job polled through `/progress` or reported through
`webhookUrl`, with a `sessionId` for follow-up turns and per-step `text` /
`tool_call` events on `GET /events/:request_id`.

The repo engine as a strut workflow is the same loop as ONE `agent` step,
with the repository from `git/checkout` and the result from `pack`:

```yaml
name: repo-agent
# Input:  { repo, prompt, messages? }
# Output: { result, object, usage, cost, steps }
steps:
  - id: checkout
    type: git/checkout
    config: { repo: "{{ input.repo }}" }

  - id: run
    type: agent
    config:
      cwd: "{{ checkout.path }}"
      system: "{{ params.system }}"
      prompt: "{{ input.prompt }}"
      messages: "{{ input.messages }}"      # §4.1
      model: "{{ params.model }}"
      maxSteps: "{{ params.maxSteps }}"
      agentTools: "{{ params.tools }}"      # §4.6

  - id: result
    type: pack
    config:
      result: "{{ run.result }}"
      object: "{{ run.object }}"
      usage: "{{ run.usage }}"
      cost: "{{ run.cost }}"
      steps: "{{ run.steps }}"

params:
  model: claude-sonnet-5
  maxSteps: 200
  tools: ["stakgraph/*", "concepts/*"]
  system: |
    ...
```

Seeded by mcp's lab beside `code-change-propose`. mcp's `mode: "graph"` and
`mode: "workflow"` are the same shape with a different `system` and `tools`
(sibling workflows, or params variants). A caller dispatches it exactly as
hive dispatches code-change: actor secret pushed, `POST …/run { input,
callback }`, one `run.end` back; a per-request model is a per-run `params`
override; the actor is billed through the Mothership.

What strut already does better than repo_agent, for the record: dollar
cost and cache usage in the output; resume after a severed stream; a
scrubbed child env (mcp's bash inherits the whole `process.env` plus the
PAT); one run event per tool call; cooperative cancel and pause; actor
billing; an isolated credential-free checkout; and a gitleaks scan that
actually covers the change (mcp runs `gitleaks protect` without `--staged`
after `git add -A`, which scans nothing).

**The callers.** Eleven direct HTTP clients were found; every one except
hive's graph chat is single-turn, so a run is the right unit:

| Client | Sends | Reads |
| --- | --- | --- |
| hive `repo_agent` tool (askTools, askToolsMulti) | repo_url, prompt, pat, Bifrost key/baseUrl/headers; no `toolsConfig` | polls `/progress` (120 × 5 s), `result.content`; aborts by request_id |
| hive diagrams create/edit | `skills: {mermaid}`, `subAgents`, `model: opus`, `learn_concepts` | `.content` |
| hive workflow explorer | `mode: "workflow"`, `stakwork_run_step`, stakworkApiKey; webhook when a canvas conversation exists | `.content` |
| hive graph chat | `mode: "graph"`, **`sessionId`** (reused across turns), `propose_concept_change`, webhook | `result.content`, `result.reflection`; Pusher nudge keyed by sessionId |
| hive abort route | `/repo/agent/abort { request_id }` | |
| hive createPr | ephemeral / create_pr | already replaced by code-change |
| hive mock Stakwork runner | commit, username, jsonSchema, skills, subAgents | |
| mcp web UI | `stream: true` | text deltas + tool-input events |
| mcp `subagent.ts` | another swarm's `/repo/agent` | `final_answer` |
| senza-lnd (Stakwork Rails) | `/repo/agent/abort { sessionId: taskId }`, host hard-coded | logs `result.usage` |
| Stakwork workflows | repo2graph_url, subAgents, mcpServers, agentName, sessionId=taskId, `messages` replay for evals | unknown (§6) |

Three readers never call the agent but depend on what it writes to Neo4j:
hive's evals sessions route, the legal cascade (through mcp's benchmark
router) and the session viewer iframe read jarvis `AgentSession` / `Turn`
nodes (§4.11).

## 2. Decided

| Question | Decision |
| --- | --- |
| The unit | One workflow run per turn. A session is a chain of runs (§4.1) |
| The agent | Strut's core `agent` step, extended per §4; never mcp's loop wrapped |
| Tools | `agentTools` over seeded lab steps (§4.6); the built-ins for files and bash |
| The repository | `git/checkout`: a fresh, isolated, credential-free worktree per run (§5.2) |
| Asking the user | Strut's elicitation shape, not mcp's `ask_clarifying_questions` tool (§5.1) |
| Result | Strut's: `{ result, object, usage, cost, steps }` from `pack` (§5.3) |
| Run reads | The run stream is not public: behind the deployment key (§4.10) |
| Everything else in the contract | Kept as strut has it (§5.4) |

## 3. Why the gaps matter

The loop is not the problem. The `agent` step has no way to continue a
conversation, shows no assistant text while it runs, cannot be stopped
mid-generation, has no protection against outgrowing the context window,
runs without thinking, and explores the filesystem where repo_agent
explores the code graph. Each of those is a shortcoming of the step on its
own, repo agent or not; the repo agent is the workload that makes them
visible. §4 takes them one at a time. Each section states what mcp does,
what strut does, who breaks, and the smallest fix.

## 4. The work items

### 4.1 A prior transcript in (multi-turn)

**mcp.** `sessionId` on every request (minted when absent). The prior
messages are loaded from `.sessions/<id>.jsonl` and sent as
`[...previous, userMessage]`; the system prompt and tools are rebuilt from
the current request; new messages are appended after the run. A
`transparent` mode replays a caller-supplied `messages` array verbatim
(evals).

**strut.** `prompt` is a string and the step starts every session from
scratch. The step DOES record the whole session, system message first, on
its `step.end.messages` — so the transcript exists in the run log — but
nothing feeds it back in.

**Who breaks.** Hive's graph chat (the one multi-turn client), any
Stakwork workflow keyed on `sessionId = taskId`, and the evals replay.

**The fix.** Two parts.

1. `messages?: ModelMessage[]` on the agent step: the prior turns, placed
   before the task prompt (`messages: [...cfg.messages, { role: "user",
   content: basePrompt }]` instead of `prompt`). The nudge, forced-answer
   and stream-resume continuations already build message arrays; they
   prepend the prior turns the same way. `buildSession` records system +
   prior + prompt + new turns, so `step.end.messages` is again the
   complete session to that point. This one input also gives evals their
   replay (the whole transcript in, `system` from the replay) and a fork
   or sub-agent its history.
2. A source for the transcript. The client knows the previous run (it got
   the id on the 202 and again in the callback), so the input carries
   `priorRunId` and a step reads that run's agent transcript from the log,
   system message dropped. Steps cannot reach the run store today
   (`StrutCapabilities` is http / secrets / artifacts / shell / stt /
   dataDir), so this is a read-only `runs` capability on the standard bag
   plus one lib step, `run/transcript { workflow, runId, step }`. No second
   store: the run log stays the only record.

   Caveat: the transcript then appears twice per run in the log (the
   history step's output and the agent's session), so a long session's
   logs grow with the square of its length. If that bites, cap the
   history step's tool results the way mcp caps its persisted transcript
   (50 lines / 2000 chars per tool result), or let the agent step take the
   prior run's coordinates directly. The alternative design, a session
   file under `dataDir` keyed by id (mcp's model, ~40 lines in the step),
   is linear but is a second store with its own pruning.

### 4.2 Assistant text in the run stream

**mcp.** The non-streaming job pushes one event per completed step on
`GET /events/:request_id`: `text` (the assistant's prose), `tool_call`
(name + input), `done`, `error`. Tool results are deliberately withheld.
`stream: true` pipes the AI SDK UI message stream (token deltas).

**strut.** Every tool call is a nested `step.start` / `step.end` at
`<agent>/NNN-<tool>` with the input and a truncated output, so hive's
`tool_call` has an equivalent. The assistant's text between tool calls is
never emitted: it is only in `step.end.messages` when the step finishes.
Watching a long run, you see the calls and none of the reasoning.

**Who breaks.** Hive's `useAgentEvents` renders `text` and `tool_call`;
half of it goes dark. The events panel has the same blind spot.

**The fix.** One non-terminal run event type, e.g. `step.note`, emitted
from the agent's `onStepEnd` with the step's text at the agent's path. Per
step, not per token: that is what mcp's non-stream mode delivers and what
hive consumes (only the mcp web UI used deltas). `RunEventType` is a
closed union: the journal, `countSteps` and the summary ignore it; the
events panel renders it as a line. Hive's hook maps it to `text`.

### 4.3 Cancel reaches the model call and bash

**mcp.** An AbortController per request id and per session id; the signal
goes into the LLM fetch, clone, git and jarvis calls (not into bash, which
runs to its 60 s timeout). Registering a second run on the same key aborts
the first.

**strut.** The step checkpoints in `prepareStep`, i.e. BETWEEN tool calls.
Nothing aborts an in-flight generation, and a drafting turn can run for
minutes. The bash tool's `runShell` has no cancel poll, so a cancelled run
waits for the command's 10-minute timeout. The `exec` step already does
this right: it polls `ctx.control.state` while the child runs and SIGTERMs
the process group (`runProcess`).

**Who breaks.** Hive's Stop button: the cancel is acknowledged, the run
keeps burning tokens until the next tool boundary.

**The fix.** Derive an AbortController from run control (a `signal` on
`RunControl` fired on cancel, or the poll `exec` uses) and pass
`abortSignal` to `agent.stream(...)` (and the nudge / forced-answer
calls). Move the bash tool onto `runProcess`, which already kills the
process group on abort. `isTransientStreamError` already refuses to resume
an abort, so a cancel is never mistaken for a dropped socket; after the
abort the step lets `checkpoint()` raise the canonical `CancelledError`.
Pause stays as it is (it parks at the next checkpoint).

### 4.4 A context-window guard

**mcp.** `truncateOldToolResults` in `prepareStep`: when the last step's
provider-reported input tokens (or a tokenizer estimate) reach 90% of the
model's context limit, the oldest tool results' outputs are replaced with
`<TRUNCATED>` until the excess plus 10% is freed. No summarisation. There
is no default step cap; a two-hour watchdog with time-budget nudges at 50 /
75 / 92% bounds the run.

**strut.** Nothing. `resolveModel` returns `contextLimit` and the step
ignores it. A long session grows until the provider answers 400 (context
too long); that is not a transient error, so the step throws and the run
ends `error` with the work banked in the log but no result. Separately,
`maxSteps` defaults to 40, a research budget, not a coding one; the repo
agent sets it high in params.

**Who breaks.** Any long coding session, on any client.

**The fix.** `prepareStep` already exists (the checkpoint) and may return a
rewritten `messages` list. Read the last banked step's input tokens; at
0.9 × `contextLimit`, replace the oldest tool-result outputs with a marker
until the budget is back, mcp's rule. The AI SDK's `pruneMessages` (drop
reasoning / tool calls before the last N messages) is the coarser
built-in; mcp's oldest-first-by-budget is the better fit for a coding
loop. The recorded session (`step.end.messages`) keeps the untruncated
banked turns; only the in-flight copy is trimmed.

### 4.5 Thinking

**mcp.** `getProviderOptions(provider, undefined, modelId)`: adaptive
thinking with summarised display on sonnet / opus, `thinkingBudget:
24000` on Google, usage accounting on OpenRouter, plus `cacheControl:
ephemeral` on anthropic.

**strut.** `providerOptions` is `{ anthropic: { cacheControl: { type:
"ephemeral", ttl } } }` and nothing for any other provider. No thinking
anywhere.

**Who breaks.** Nobody's integration; the agent is just worse at the job
than the one it replaces.

**The fix.** aieo, which strut already depends on, exports that same
`getProviderOptions(provider, thinkingSpeed?, modelName?)`. Merge its
result under strut's `cacheControl` (keeping `cacheTtl`). Expose it as a
`thinking: "thinking" | "fast"` knob on the step. Default to thinking on
sonnet / opus like mcp: the repo agent is the reason this exists, and a
workflow that wants a cheap agent says `fast`. The `llm` step and the chat
builder can take the same option later.

### 4.6 The code-graph tools

**mcp.** When a caller sends no `toolsConfig` (hive's `repo_agent` tool
sends none) `get_tools` returns EVERY default tool: `stakgraph_search`,
`stakgraph_map`, `stakgraph_code` (the Neo4j code graph), `vector_search`
(embeddings), `list_workflows` / `learn_workflow` / `read_workflow_json`
(Workflow nodes), the jarvis reads when `JARVIS_URL` is set,
`repo_overview` backed by the `stakgraph overview` CLI, `recent_commits` /
`recent_contributions` (gitsee). Diagrams and the repo_agent tool add
`learn_concepts` (`list_concepts`, `learn_concept`). The default repo
agent is a code-graph explorer.

**strut.** The built-ins are a filesystem explorer: `repo_overview` from
`git ls-files`, ripgrep, bash, the editor, web, and `file_summary` when the
stakgraph CLI is on PATH. `jarvis/*` is seeded in the lab (12 steps) and
grantable; the code graph, concepts and Workflow nodes are not.

**Who breaks.** Every hive client, silently: the workflow version would be
a different, weaker agent on the same prompt.

**The fix.** No engine change. Seed the tools as lab steps and grant them
with `agentTools` — the code-change plan's §3.4 line. The lab strut runs
inside mcp, so the steps call the same functions `tools.ts` calls today:
`stakgraph/search`, `stakgraph/map`, `stakgraph/code`,
`stakgraph/vector-search`, `stakgraph/overview` (the CLI, preferred over
the file tree when on PATH), `concepts/list`, `concepts/learn`,
`workflows/list`, `workflows/learn`, `workflows/read-json`,
`repo/recent-commits`. Each marks its output with `withAccessedNodes`, so
the projector draws the `ACCESSED` edges. Then `params.tools:
["stakgraph/*", "concepts/*"]`, and the graph and workflow modes are a
different list.

### 4.7 MCP servers

**mcp.** Per request, `mcpServers[]`: http `{ name, url, token?, headers?,
toolFilter? }` or stdio `{ name, command, args?, env? }`. Tools are named
`<server>_<tool>`, merged after the built-ins, clients closed after the
run; `token` / `headers` / `env` are stripped before the config is
persisted. Hive's task workflows pass the org_agent callback this way.

**strut.** None.

**Who breaks.** Hive's task and plan workflows (the org_agent MCP server);
whichever Stakwork workflows pass one.

**The fix.** `mcpServers` on the agent step, http only (stdio is arbitrary
command execution on the host; leave it out). The token by secret NAME
(`tokenSecret`), like `git/*`, because a step's config is recorded on
`step.start`. Client: `@ai-sdk/mcp` (2.0.x; on `ai` 7 the MCP client
lives there, not in `ai`) — it hands tools to the host's `ai`, so check it
against the one-copy-per-process rule before adding it. The tools go
through the same mask + emit wrappers as everything else, so every MCP
call is a run event; clients close in the step's `finally`.

### 4.8 Remote sub-agents

**mcp.** `subAgents[{ name, description, url, apiToken, repoUrl,
toolsConfig }]` become one tool each: POST `{ prompt, repo_url?, model?,
toolsConfig }` to another swarm's `/repo/agent`, poll `/progress` for up
to 600 s, return `final_answer`. No session, depth one. Hive's diagrams and
task workflows send them; mcp's own `subagent.ts` is one of repo_agent's
clients.

**strut.** Local sub-agents through `agentTools: ["agent"]`; nothing that
crosses a process.

**Who breaks.** Hive's diagrams and task workflows.

**The fix.** A lib step, `strut/run`: launch a workflow on another strut
(`POST {base}/workflows/:name/run`, key by secret name, actor forwarded)
and wait for it (poll the run summary, or tail the stream). Granted with
`agentTools`, it IS the remote sub-agent tool: the name and description
come from the target workflow. This is the federation plan's "chain"
primitive, so it is worth building once for both. Once §4.10 gates run
reads, the caller needs the key anyway.

### 4.9 Image attachments

**mcp.** `attachments[]` of image URLs (or an `<attachments>` tag in the
last user message), at most 8 × 15 MB, downloaded once and cached per
session, sent as a multimodal user message; the persisted transcript holds
a placeholder.

**strut.** `prompt` is a string.

**Who breaks.** No hive client was found sending attachments. Only worth
doing if a Stakwork workflow does (§6).

**The fix.** `attachments?: string[]` on the agent step: the task turn
becomes `[{ type: "text" }, { type: "image", image: url }]` content parts
(the provider fetches the URL; for private URLs, download through
`ctx.services.http` first). Record only the URL in the session. The
smallest item here.

### 4.10 The run stream is public

**Today.** With `STRUT_API_KEY` set, only mutations are gated. `GET
/workflows/:name/runs`, `/runs/:runId`, `/runs/:runId/events`,
`/runs/:runId/stream` and `/promotions` answer anyone — the whole log,
transcripts included. mcp scopes a per-request `events_token` JWT to the
one request.

**Decided.** Not public.

**The fix.** `requireApiKey` on the run read family: the stream, and with
it the events, the summary and the list, which expose the same log. The
web UI already attaches the key to every request once it has one
(`apiFetch`, header-based, so the SSE reattach needs no change) and hive's
embed hands it over as `?key=`; `apiKeyMatches` already accepts `?key=`
for the WebSocket. Dev mode (key unset) stays open, as everywhere. The
same question then applies to `GET /artifacts/:runId/*` and the chat
reads; decide them together.

### 4.11 The `AgentSession` / `Turn` readers

**mcp.** Writes a jarvis `AgentSession` (model, provider, usage, status)
at session start and end, and a live `Turn` chain
(`HAS_TURN` / `NEXT`; `user_input`, `reasoning`, `tool_call`,
`tool_result`, `response`) from `onStepFinish`, tool results cut to 100
chars, keyed `turn-<agent>-<session>-turn-<n>`.

**strut.** The projector writes `StrutRun` / `StrutAgentSession` /
`StrutToolCall` (and `StrutChat` / `StrutTurn` for chats) from the run
log.

**Who breaks.** Hive's evals sessions route, the legal cascade (mcp's
benchmark router, `/api/sessions…`) and the session viewer iframe read the
jarvis labels; strut-run sessions are invisible to them.

**The fix.** Outside the agent step. mcp already has `buildExternalTurns`
(`turns.ts`) for agents that run in another process — hive uses it to
record its own agents — so the lab can project a strut run's agent
`step.end.messages` into the jarvis shapes after `onRunEnd`. The
alternative, teaching strut's projector the jarvis labels, puts mcp's
schema in strut; prefer the lab.

## 5. Decided in strut's favour (no work)

### 5.1 Asking the user

mcp's `ask_clarifying_questions` is a tool whose call ends the turn and
whose output (questions plus mermaid / table / swatch artifacts) IS the
answer. Strut's elicitation — ACP's shape, one open question, the turn
stops on the ask, the answer arrives as the next turn's message through a
route — is the better model and stays. It exists for the chat today, not
for runs; if a repo-agent run ever has to ask, it gets the same shape on a
run (a paused run carrying the question), not a port of the tool. No hive
client enables the tool.

### 5.2 The repository

mcp keeps one shared clone per repo under `/tmp`, the PAT in the remote
URL, `GH_TOKEN` in the bash env, and `/tmp` as cwd for multi-repo. Edits
and installed dependencies persist across turns and across users, and the
agent can push. Strut's `git/checkout` is a fresh detached worktree per
run, credential-free, removed at run end; several checkouts in one run
land as siblings under the run's worktree root, so multi-repo is cwd = the
parent. Turn N+1 gets turn N's edits as a diff (`git/diff` → the next run's
`git/apply`, the code-change pattern) or after they land. Cold dependencies
per run are the price; a warm cache is an environment concern (ENV_SPEC),
not the step's. The agent cannot use `gh`; handing it `GITHUB_TOKEN`
through `secretsEnv` would reopen the push path the code-change plan
closed, so it stays closed.

### 5.3 The result

Strut's `{ result, object, usage, cost, steps }` through `pack`; no
`content`, `final_answer`, `tool_use`, `incomplete` or `reflection`.
`incomplete` has no meaning here because the step forces a final answer
instead of reporting a stall. mcp's `reflection` (a post-run LLM call
ranking the concepts read) becomes a lab step after the agent, for the
workflow that wants it. Clients read the pack.

### 5.4 The smaller contract differences

Kept as strut has them: cancel by run id (senza-lnd's abort-by-session
needs a lookup on the hive side or a change in Stakwork); a callback
dropped by a restart (hive's reconcile cron); no request id (the run id);
no `/progress` (the run summary); no transparent-replay endpoint (evals get
`messages`, §4.1); `_metadata` and `agentName` ride in `input`.

## 6. The unknown

The Stakwork workflow definitions that call `/repo/agent` are not on disk
anywhere under `~/code/sphinx`; what they send is inferred from the vars
hive passes (`repo2graph_url`, `subAgents`, `mcpServers`, `agentName`,
`sessionId = taskId`, Bifrost key / baseUrl / headers, `replayUrl` for
evals). Inventory them before any client cutover: they decide whether
§4.7, §4.8 and §4.9 are needed at all, and whether anything sends
`ask_clarifying_questions`, `jsonSchema` or `skills`.

## 7. Order

§4.6 and §4.10 need no engine change and unblock a first seeded workflow
that hive's `repo_agent` tool could dispatch today. Then §4.1 (graph chat),
§4.2 (the events hook), §4.3, §4.4, §4.5 in the step. §4.7, §4.8, §4.9 and
§4.11 wait on §6.
