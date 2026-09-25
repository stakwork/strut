# Repo agent — mcp's `POST /repo/agent` as a strut workflow

> **Status (2026-09-24): milestone 1 defined, nothing built.** §7 is the
> first cut: mcp's *default* repo agent (the code-graph explorer) as a
> seeded lab workflow on every workspace strut, multi-repo from the start,
> dispatched by hive's `repo_agent` tool to the workspace's own swarm. The
> engine work is three small changes (two in `git/checkout`, one in the
> agent's repo map); everything else is a seeded YAML, two lab steps and
> hive plumbing. The numbered sections under
> §4 are the later work items, one at a time; §5 records what was decided
> in strut's favour and needs no work; §6 is the open unknown. Current
> behaviour was re-read on `strut@c8ccb3c`, `hive@1b54276` (master) and
> `stakgraph@de9928c` (main); citations are `file:line` on those.
> Companion: `plans/code-change.md` (the first repo_agent surface moved to
> strut, and the foundations this reuses: `git/checkout`, actor secrets,
> callbacks, `ctx.onRunEnd`). `plans/federation.md` owns the question of
> who dispatches across struts; this plan's workflow is the same under any
> answer.

## 1. The idea

mcp's repo agent (`mcp/src/repo`, ~18k lines) is a `ToolLoopAgent` over a
cloned repository with a large tool surface: filesystem and bash, the
stakgraph code graph, jarvis, concepts, Workflow nodes, MCP servers, remote
sub-agents, skills, spreadsheets, PR creation. It is exposed as `POST
/repo/agent`, an async job polled through `/progress` or reported through
`webhookUrl`, with a `sessionId` for follow-up turns and per-step `text` /
`tool_call` events on `GET /events/:request_id`.

The repo engine as a strut workflow is the same loop as ONE `agent` step,
with the repositories from `git/checkout` and the result from `pack`:

```yaml
name: repo-agent
# Input:  { repos: ["https://github.com/stakwork/hive", …], prompt, messages? }
# Output: { result, object, usage, cost, steps }
steps:
  - id: checkouts
    type: foreach
    config:
      items: "{{ input.repos }}"
      concurrency: 4
      body:
        id: checkout
        type: git/checkout
        config: { repo: "{{ $current }}", tokenSecret: GH_TOKEN }

  - id: run
    type: agent
    config:
      cwd: "{{ checkouts[0].root }}"        # the run's worktree root: <owner>/<name>/ per repo (§7.1)
      system: "{{ params.system }}"
      prompt: "{{ input.prompt }}"
      messages: "{{ input.messages }}"      # §4.1, later
      model: "{{ params.model }}"
      maxSteps: "{{ params.maxSteps }}"
      agentTools: "{{ params.tools }}"      # §4.6
      secretsEnv: [GH_TOKEN]                # `gh` in bash — read-only by the TOKEN, not by a blocklist (§4.6)

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
  tools:
    - graph/graph-search       # Concepts and every other jarvis node
    - graph/graph-get
    - graph/graph-neighbors
    - graph/get-ontology
    - stakgraph/search         # the code graph: symbols by keyword / meaning (§4.6)
    - stakgraph/code           # bodies by ref_id or name + node_type
  system: |
    ...
```

Seeded by mcp's lab beside `code-change-propose`. mcp's `mode: "graph"` and
`mode: "workflow"` are the same shape with a different `system` and `tools`
(sibling workflows, or params variants); the graph mode is multi-turn and
waits on §4.1. A caller dispatches it as hive dispatches code-change —
actor secret pushed, `POST …/run { input }` — and in milestone 1 reads the
result by polling the run summary, the way it polls `/progress` today (§7.3);
the callback shape (`{ callback }`, one `run.end` back) is available
whenever the caller goes async. A per-request model is a per-run `params`
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
| hive `repo_agent` tool (askTools, askToolsMulti — one tool per workspace) | repo_url, prompt, pat, Bifrost key/baseUrl/headers; no `toolsConfig` | polls `/progress` (120 × 5 s, `askTools.ts:247-248`), `result.content`; aborts by request_id |
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
| Which strut | **The workspace's own swarm strut.** Not a choice: the code graph and jarvis live on that swarm's Neo4j, so an org strut could not run this without holding the swarm's key or double-hopping every tool call. Hive resolves it once at dispatch — a `repo_agent` purpose on the `workspace` row of `POLICY` (`hive/src/services/strut-target.ts`), the row `benchmark` already uses. Whether hive or a peer strut is the dispatcher is `plans/federation.md`'s question; the workflow and its input are the same either way |
| The repositories | **Multi-repo from the start.** One `git/checkout` per repo through a `foreach`; siblings under the run's worktree root laid out `<owner>/<name>` so a code-graph `file` is a path under `cwd` (§7.1). A fresh, isolated, credential-free worktree per run per repo (§5.2) |
| Tools | The built-ins for files and bash; the four **graph reads** for Concepts and any other jarvis node; **`stakgraph/search` + `stakgraph/code`** as two seeded lab steps over the services bag (§4.6). No `stakgraph_map`, no `workflows/*`, no `concepts/*` tools: the graph reads cover concepts, the filesystem covers the rest |
| GitHub | **The agent uses `gh` and `git` in bash; typed `github/*` steps are for workflows, not agents.** What makes the agent read-only is the TOKEN: a read-only installation token, pushed by hive as the actor secret `GH_TOKEN`, used by checkout and bash alike. The user's write-capable token never enters this workflow (§4.6, §7.3) |
| Asking the user | Strut's elicitation shape, not mcp's `ask_clarifying_questions` tool (§5.1) |
| Result | Strut's: `{ result, object, usage, cost, steps }` from `pack` (§5.3) |
| Run reads | On a swarm every `/lab` route is already behind the swarm key (mcp's `labAuth`); gating them on a standalone strut is a later item (§4.10) |
| Everything else in the contract | Kept as strut has it (§5.4) |

## 3. Why the gaps matter

The loop is not the problem. The `agent` step has no way to continue a
conversation, shows no assistant text while it runs, cannot be stopped
mid-generation, has no protection against outgrowing the context window,
and runs without thinking. Each of those is a shortcoming of the step on
its own, repo agent or not; the repo agent is the workload that makes them
visible. §4 takes them one at a time. Each section states what mcp does,
what strut does, who breaks, and the smallest fix. **None of them blocks
milestone 1**: a single-turn, read-only investigation bounded by the
caller's ten-minute budget rarely meets any of them.

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
from the agent's `onStepEnd` (`src/steps/core/agent.ts:1004`) with the
step's text at the agent's path. Per step, not per token: that is what
mcp's non-stream mode delivers and what hive consumes (only the mcp web UI
used deltas). `RunEventType` is a closed union: the journal, `countSteps`
and the summary ignore it; the events panel renders it as a line. Hive's
hook maps it to `text`.

### 4.3 Cancel reaches the model call and bash

**mcp.** An AbortController per request id and per session id; the signal
goes into the LLM fetch, clone, git and jarvis calls (not into bash, which
runs to its 60 s timeout). Registering a second run on the same key aborts
the first.

**strut.** The step checkpoints in `prepareStep` (`agent.ts:1029-1030`),
i.e. BETWEEN tool calls. Nothing aborts an in-flight generation, and a
drafting turn can run for minutes. The bash tool's `runShell` has no
cancel poll, so a cancelled run waits for the command's 10-minute timeout.
The `exec` step already does this right: it polls `ctx.control.state`
while the child runs and SIGTERMs the process group (`runProcess`).

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
builder can take the same option later. Small enough to ride along with
milestone 1 if wanted; not required by it.

### 4.6 The tools

**mcp.** When a caller sends no `toolsConfig` (hive's `repo_agent` tool
sends none) `get_tools` (`mcp/src/repo/tools.ts:536`) registers every
default tool: `repo_overview`, `file_summary`, `recent_commits`,
`recent_contributions`, `fulltext_search`, `bash`, the editor, `web_search`,
`final_answer`, `list_workflows` / `learn_workflow` / `read_workflow_json`
(Workflow nodes), `vector_search`, `stakgraph_search` / `stakgraph_map` /
`stakgraph_code` (`:1013-1066`), the jarvis reads when `JARVIS_URL` is
set, `list_concepts` / `learn_concept` with `learn_concepts`. Bash gets the
requesting user's PAT as `GH_TOKEN` (`:749-760`) and a regex blocklist on
`git push`, `git remote` and `gh pr|api|repo|release` (`:154-157`) — the
tool description hive shows Jamie promises read-only GitHub inspection
through `gh` (issues, PR threads, CI status, other repos).

**strut.** The built-ins are a filesystem explorer: `repo_overview` from
`git ls-files` — across every git repo directly under `cwd`
(`src/steps/core/agent.ts:149-170`), so a parent of several checkouts
works; ripgrep; bash; the editor; web; and `file_summary`, the stakgraph
AST CLI, registered when `stakgraph` is on PATH (`:873-876`) — it is on
the swarm image, and so is `gh` (`mcp/Dockerfile:105-109`). Registry steps
are grantable through `agentTools`, named by their type with the slash
replaced (`toolNameFor`, `agent.ts:362`). The lib ships `graph/*` over the
swarm's own Neo4j (`src/steps/lib/graph/`): reads (`graph-search`,
`graph-get`, `graph-neighbors`, `get-ontology`, …) and writes.

**Who breaks.** Every hive client, silently: without the code graph the
workflow version would be a different, weaker agent on the same prompt.

**Decided.** Three sources, and no more:

1. **The filesystem, for reading.** Concept docs already list the key
   files; with every repo checked out the agent reads them with bash and
   the editor's `view`, ripgreps from there, and asks `file_summary` for a
   file's structure. No `toolFilter`: the worktree is throwaway and
   credential-free, so a local edit is invisible and harmless.
2. **The graph reads, for Concepts and every other jarvis node** —
   `graph/graph-search` (hybrid), `graph/graph-get` (the node with its
   docs), `graph/graph-neighbors`, `graph/get-ontology`. Granted BY NAME,
   never `graph/*`: the glob would hand a read-only investigator the
   write steps. This replaces `list_concepts` / `learn_concept` and the
   jarvis reads: searching Concepts through the general graph search is
   the direction, not a concept-specific tool.
3. **Two lab steps for the code graph, `stakgraph/search` and
   `stakgraph/code`** (§7.2) — mcp's `stakgraph_search` and
   `stakgraph_code` by another route, and under the same tool names, so
   mcp's descriptions carry over. The graph covers every repo in the
   workspace, and `include_patterns` (`stakwork/hive/**`) scopes a search
   to one of them.

Not carried over: `stakgraph_map` (the subtree map; ripgrep on a symbol
name and `file_summary` get most of the way), `vector_search`, the
Workflow-node tools, `recent_commits` / `recent_contributions` (`git log`
on the checkout), skills, spreadsheets. If runs show the agent flailing on
"who calls this" questions, the next step is not the map tool but the
**code family in strut's own `graph/search`** (`src/graph/search.ts`): it
filters `n.namespace = $namespace` (`:569`) and stakgraph's code nodes
have no namespace; neighbours filter on `Domain_*` labels the code nodes
lack; and code embeddings live under `embeddings` from BGE-small
(`mcp/src/vector/index.ts:4-5`, 384 dims) rather than `text_embeddings`
from MiniLM — same width, different model, so the vectors do not compare.
A contained change (visibility for label-less `Data_Bank` nodes, the
fulltext leg routed to stakgraph's `nameBodyFileIndex`, the vector leg
skipped or BGE-embedded) would make the graph reads cover code too and
retire the two lab steps. Only with evidence.

**GitHub: `gh`, on a read-only token.** Remaking `gh` as agent tools is a
losing race, and each remade tool is a schema the model has to learn; in
bash the model already knows the CLI. Typed `github/*` steps stay what
they are — workflow steps, where recorded config, typed outputs, cassettes
and error codes matter. The only question is the credential, and the
answer is to make the TOKEN read-only rather than the tool: a GitHub App
installation token scoped to the workspace's repositories with read-only
permissions (contents, metadata, pull requests, issues, checks, actions),
one-hour expiry, pushed by hive before each dispatch as the actor secret
`GH_TOKEN` (§7.3). `git/checkout` takes it as `tokenSecret`; the agent
lists it in `secretsEnv` (`agent.ts:730`, secret NAMES, masked out of tool
output); `gh` reads `GH_TOKEN` first. Read-only by construction, no
blocklist, and the user's write token never enters the workflow. Local git
needs no token at all: log, blame, show and diff work on the checkout.

**If the mint is blocked** (§7.4): never the user's write token in bash —
that is mcp's posture, and the regex blocklist is the thing
`plans/code-change.md` §2 rejected. The interim is ONE generic GET-only
`github/api` lib step (path + query through `ctx.services.http`, token via
`secrets`) granted as an agent tool: issues, PR threads, review comments,
checks and runs without the token reaching the child env. Not a remake of
`gh`'s subcommands.

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

**The fix.** A lib step that launches a workflow on another strut and
waits for it, granted with `agentTools`: it IS the remote sub-agent tool,
its name and description from the target workflow. Who holds the
credential for that call — a peer token, a forwarded attenuated
delegation, or hive as the broker — is `plans/federation.md`'s decision;
the step is the same shape under each.

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

### 4.10 Run reads on a standalone strut

**Today.** With `STRUT_API_KEY` set, only mutations are gated. `GET
/workflows/:name/runs`, `/runs/:runId`, `/runs/:runId/events`,
`/runs/:runId/stream` and `/promotions` answer anyone — the whole log,
transcripts included. mcp scopes a per-request `events_token` JWT to the
one request.

**On a swarm this does not matter.** mcp's `labAuth` gates every `/lab`
route behind the swarm's `API_TOKEN` (Basic, `x-api-token`, or a minted
JWT; `mcp/src/lab/mount.ts`), UI assets excepted. The run log of a
repo-agent run on a swarm is as private as the rest of the lab. So this is
not in milestone 1.

**Decided.** Still not public on a standalone strut (`src/server.ts`, the
Dockerfile image). `requireApiKey` on the run read family: the stream, and
with it the events, the summary and the list, which expose the same log.
The web UI already attaches the key to every request once it has one
(`apiFetch`, header-based, so the SSE reattach needs no change) and hive's
embed hands it over as `?key=`; `apiKeyMatches` already accepts `?key=`
for the WebSocket. Dev mode (key unset) stays open, as everywhere. The
same question then applies to `GET /artifacts/:runId/*` and the chat
reads; decide them together, when a standalone strut runs this workflow.

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
benchmark router, `/api/sessions…`) and the sessions viewer (the
`mcp/benchmark` app served at `/sessions`, which hive iframes) read the
jarvis labels; strut-run sessions are invisible to them.

**The fix.** Outside the agent step, and no change to the viewer: it is
already decoupled from repo_agent. It reads `AgentSession` / `Turn`
through the router, and the router has an out-of-process ingest door
(`benchmark/ingest.ts`) that hive already uses to record its own Jamie
agent (`hive/src/services/stakgraph-session-ingest.ts`, the working
example): `POST /api/sessions` (`session_id`, `source`, `agent_name`,
`repo`, `parent_session_id`, `spawn_tool_call_id`, `start_time`), `POST
/api/sessions/:id/turns` (`turns[]` of `turn_type`, `content`, `tool`,
`tool_call_id`, `timestamp`, `concepts`), `POST /api/sessions/:id/end`
(`status`), `POST /api/sessions/:id/concepts`. `source` is the facet the
UI filters on. Strut records everything those need, so the work is ONE
projector over the run log:

| Viewer field | From the strut run log |
| --- | --- |
| `session_id` | `<runId>:<stepPath>` — one session per agent step execution (a loop iteration is its own) |
| `source` / `agent_name` / `repo` | `"strut"` / `<workflow>/<stepPath>` / the run's `git/checkout` outputs (`url` of each; several for a multi-repo run) |
| `parent_session_id`, `spawn_tool_call_id` | a sub-agent's session rides on its tool-call `step.end.messages`; the parent is the enclosing agent step, the spawn id the tool call's path |
| `user_input` | the task prompt (and, with §4.1, only the NEW prompt; prior turns are already in the parent session's chain) |
| `reasoning` → `response` | each assistant text part; the last one retyped `response` at the end, mcp's rule |
| `tool_call` (`tool`, `tool_call_id`) | each assistant tool-call part of `step.end.messages` |
| `tool_result` | each tool result, cut to 100 chars, mcp's rule |
| `concepts` | the tool-call event's `nodes` (`withAccessedNodes`) where the ref is a `Concept` — the graph reads and the two stakgraph steps all mark theirs |
| model, tokens, cost, status | the step's config `model`, its output `usage` / `cost`, and `step.end` / `step.error` / the run's `cancelled` |

Place it in mcp's lab, on `onRunEnd`, calling the same writers the
router's handlers call (`turns.ts`: `buildExternalTurns`, the session
upsert) in-process — no HTTP, no `authMiddleware`. Turn node keys are
deterministic and the writes are upserts, so re-projecting a resumed run
is safe. The alternative, teaching strut's projector the jarvis labels,
puts mcp's session schema in strut beside strut's own
`StrutAgentSession`; prefer the lab.

Liveness: mcp emits turns while the run is going; strut's transcript
lands on `step.end`, so the first cut is post-hoc. The tool-call events
are live already, and assistant text is live once §4.2 exists, so the
same projector can move to streaming turns later. The chat builder's
turns (`chats/<id>/messages.jsonl`) can go in the same way if the builder
belongs in that view.

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

### 5.2 The repositories

mcp keeps one shared clone per repo under `/tmp/<owner>/<repo>`
(`mcp/src/repo/clone.ts:78`), the PAT in the remote URL, `GH_TOKEN` in the
bash env, and `/tmp` as cwd for multi-repo. Edits and installed
dependencies persist across turns and across users, and the agent can
push. Strut's `git/checkout` is a fresh detached worktree per run per
repo, credential-free, removed at run end; a multi-repo run is a `foreach`
of checkouts landing as siblings under the run's worktree root, and the
agent's cwd is that root (§7.1). Turn N+1 gets turn N's edits as a diff
(`git/diff` → the next run's `git/apply`, the code-change pattern) or
after they land. Cold dependencies per run are the price; a warm cache is
an environment concern (ENV_SPEC), not the step's. The agent CAN use `gh`
— on a read-only token that cannot push, open a PR or write anything
(§4.6); the user's write token is what stays out of bash, which is the
push path `plans/code-change.md` closed and keeps closed.

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
evals). Inventory them before any client cutover beyond hive's `repo_agent`
tool: they decide whether §4.7, §4.8 and §4.9 are needed at all, and
whether anything sends `ask_clarifying_questions`, `jsonSchema` or
`skills`.

## 7. Milestone 1 — the first cut

The default repo agent, on every workspace strut, dispatched by Jamie.
Three repos, in this order; each part is small.

### 7.1 strut: three small changes

- **`root` in the output.** Each checkout returns its own `path`
  (`src/steps/lib/git/checkout.ts:137`) and the expression language has no
  dirname (`ARRAY_METHODS` is map / filter / find / join / includes /
  slice, `src/expr.ts:180`), so the `foreach`'s outputs cannot yield the
  parent. The step also returns `root`, the run's worktree root
  (`worktreeRoot(dataDir, runId)`, `:75`), and the agent reads it off any
  checkout: `cwd: "{{ checkouts[0].root }}"`.
- **The worktree dir is `<root>/<owner>/<name>`**, not `<root>/<name>`
  (`join(wtRoot, r.name)`, `:76`). Two reasons: two repos with the same
  name from different owners no longer collide in one run; and the layout
  mirrors mcp's `/tmp/<owner>/<repo>`, which the code graph's `file`
  property is relative to — so a `stakgraph_search` hit's
  `stakwork/hive/src/foo.ts` is exactly that path under `cwd`, no
  translation.
- **`repo_overview` walks one level deeper.** Its `listRepos` takes the
  IMMEDIATE subdirs of `cwd` that hold a `.git` (`agent.ts:55-61`), and
  `getRepoMap` runs `git ls-files` in each, prefixed (`:153-170`). Under
  `<owner>/<name>` the immediate subdirs are owner dirs, so it would find
  nothing and fall back to "No tracked files found". The fix is a few
  lines: when an immediate subdir is not a repo, look one level further
  and prefix with `<owner>/<name>` — the tree then reads exactly like the
  graph's paths. Ripgrep and bash need nothing; they already recurse.
- Concurrency is safe: one bare cache and one lock per repo, so
  `concurrency: 4` in the `foreach` is fine; the default is sequential.
- Optional: §4.5 thinking. Nothing else in the engine.

### 7.2 mcp: two lab steps and the seeded workflow

- **Why the services bag.** A seeded step is published as source and
  materialized under `<lab-workspace>/steps/_graph` (`graphMaterializeDir`,
  `src/graph/wiring.ts:37`), so a relative import of mcp code cannot
  resolve; the lab's rule is that a seeded step may value-import only
  `strut` (`mcp/src/lab/AGENTS.md:334,383`). The gitsee, harvey and gaia
  steps reach mcp through `ctx.services` with a type-only import, and so
  do these: `services.stakgraph = { search, getCode }` in
  `createLabStrut.ts` beside `harvey` and `gaia`, over the two functions
  `mcp/src/tools/stakgraph` already exports (`search.ts`, `get_code.ts`),
  the ones `tools.ts` calls.
- **`stakgraph/search`.** Inline zod input mirroring `SearchSchema`:
  `query`, `method` (hybrid | fulltext | vector), `node_types`, `limit`,
  `max_tokens`, `language`, `skip_node_types`, `include_patterns`,
  `exclude_patterns`. Output: the list mcp returns, one entry per hit —
  `{ name, node_type, file, lines, ref_id, description }`
  (`tools.ts:1041-1050`) — marked `withAccessedNodes` with each hit's
  `ref_id` + `node_type`, so the projector draws the `ACCESSED` edges.
- **`stakgraph/code`.** Input mirroring `GetCodeSchema` (`GetMapSchema` +
  `depth`): `ref_id`, or `name` + `node_type`, and `depth` (default 0).
  Output `{ text }`, the snippets, marked with the node it was asked about.
- **Names.** `toolNameFor` makes them `stakgraph_search` and
  `stakgraph_code` — mcp's names, so mcp's tool descriptions and any
  prompt that cites them carry over unchanged.
- **`repo-agent.yaml`** (§1) seeded beside `code-change-propose` under
  `lab/code/`, category `code`. `params.system` is mcp's default system
  prompt adapted to the tool set: start from Concepts (`graph_graph_search`
  with type Concept, `graph_graph_get` for docs and key files), read those
  files, ripgrep from there, `stakgraph_search` / `stakgraph_code` for
  symbol lookups across repos, `gh` for anything on GitHub. `params.tools`
  is the list in §1. The graph and workflow modes are later params
  variants or sibling workflows.

### 7.3 hive: the cutover

- **Target.** `POLICY.repo_agent = "workspace"`
  (`hive/src/services/strut-target.ts`) — the row `benchmark` uses; the
  resolver, the row's `swarmId` and every "keep the target a policy" rule
  of `plans/code-change.md` §5 apply unchanged.
- **Delegation.** Superseded by `plans/org-gateway.md`: one gateway per
  org, and one delegation per user fanned out to every strut in the org,
  so a workspace swarm holds the user's authorization before any dispatch
  (the root cause behind stakwork/hive#5345 was a per-target push gated
  per workspace slug by `BIFROST_ENABLED`, never throwing, its result
  discarded). The pre-dispatch check stays as the fast path, and a check
  that finds no delegation fails the tool call with the reason instead of
  dispatching into a certain refusal.
- **The read-only token.** Hive holds only user OAuth tokens today
  (`getUserAppTokens`, `hive/src/lib/githubApp.ts`; `env.example` has
  `GITHUB_CLIENT_ID` / `_SECRET` / `GITHUB_APP_SLUG` and no app private
  key), which are read AND write as the user. The mint is new but small:
  the app's private key in env, an app JWT, `POST
  /app/installations/:id/access_tokens { permissions: { contents: read,
  metadata: read, pull_requests: read, issues: read, checks: read,
  actions: read }, repositories: [the workspace's] }`. One hour of
  validity against a ten-minute tool budget, so push-before-dispatch is
  enough: `ensureStrutActorSecret(target, actor, "GH_TOKEN", token)`, the
  same push code-change uses for `GITHUB_TOKEN`.
- **The tool keeps its shape.** `repo_agent` in `askTools.ts` /
  `askToolsMulti.ts` (one tool per workspace already) swaps endpoints:
  `POST {lab}/workflows/repo-agent/run { input: { repos, prompt } }` with
  `x-api-token` + `x-strut-actor` → `202 { runId }`; poll `GET
  {lab}/workflows/repo-agent/runs/:runId` until the summary exists, on the
  same 120 × 5 s loop it runs today (`askTools.ts:247-252`); return
  `output.result`. Abort becomes `POST …/runs/:runId/cancel`. `repos` is
  the workspace's `Repository` rows. No `StrutRun` row and no callback in
  this cut; the async shape code-change uses can follow.
- **Bifrost.** The tool stops sending the Bifrost key / baseUrl / headers:
  strut routes the call through the swarm's gateway from the delegation.

### 7.4 If the token mint is blocked

Ship without `gh`: drop the GitHub-inspection sentence from the tool's
description and grant the GET-only `github/api` step of §4.6 instead.
Never the user's write token in bash.

### 7.5 Deliberately left out

- Multi-turn (§4.1): hive's graph chat stays on mcp's `/repo/agent` until
  then.
- Assistant text in the stream (§4.2), cancel mid-generation (§4.3), the
  context guard (§4.4): a ten-minute read-only run rarely meets them.
- `stakgraph_map`, semantic code search through strut's `graph/search`
  (the code family, §4.6): only with evidence from runs.
- MCP servers, remote sub-agents, attachments (§4.7–4.9): §6 first.
- The sessions viewer (§4.11): the run log holds everything it needs, so
  it can come at any time.
- A `StrutRun` row + callback for repo_agent: when hive wants the tool
  async.

### 7.6 Validation

- **strut**, offline against the `git/*` tests' local bare fixture: `root`
  on the output; two repos of the same name under different owners in one
  run land in distinct dirs and are both removed by `ctx.onRunEnd`;
  `getRepoMap` over a `<owner>/<name>` layout lists both repos with the
  two-segment prefix (`agent.test.ts`, no model needed).
- **mcp**: a smoke (`lab/*/smoke.ts` pattern) running `stakgraph/search`
  and `stakgraph/code` against a swarm's graph; the seeded workflow run
  from the strut UI on a swarm with two repos, the events panel showing
  the checkouts, the graph reads and the stakgraph calls with their
  `ACCESSED` edges projected.
- **hive**: `strut-target.test.ts` gains the `repo_agent` row; the tool's
  unit test against a fake lab (202, then a summary); a dispatch to a
  workspace whose delegation push is gated fails with the reason instead
  of dispatching.

## 8. Findings along the way

- Three seeded lab steps value-import mcp code: `gitsee/score-setup`,
  `gitsee/boot-and-exercise` and `eval/reflect` import `../../cost.js`,
  and each is in its seeder's list (`mcp/src/lab/gitsee/seed.ts:40,46`,
  `eval/seed.ts:38`). The lab's own rule forbids it (§7.2), the path cannot
  resolve from the materialize dir, and strut's loader logs a warning and
  skips a step whose import fails (`src/steps/registry.ts:172-173`).
  Unless something not found here copies that module in, those three are
  silently absent on swarms. Check a lab's boot log.
- Hive's `repo_agent` tool appends "PLEASE BE AS FAST AS POSSIBLE …" to
  every prompt (`askTools.ts`); with the model and `maxSteps` in `params`,
  that belongs in a per-run `params` override, not in the prompt.

## 9. Order

1. **Milestone 1** (§7): strut's three small changes → mcp's services
   entry, two steps and the YAML → hive's row, the loud push, the token
   and the tool cutover, behind the existing capability gate.
2. **§4.1** for hive's graph chat; then **§4.2, §4.3, §4.4** in the step;
   **§4.5** whenever.
3. **§4.7, §4.8, §4.9** and **§4.11** wait on §6. **§4.10** when a
   standalone strut runs this workflow.
