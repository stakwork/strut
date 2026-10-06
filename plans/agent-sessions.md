# Agent sessions — a finished agent can be given another prompt

> **Status (2026-09-29): implemented** — `src/session-store.ts`, the
> `session` input in `steps/core/agent.ts`, `workdir` in
> `steps/lib/git/checkout.ts` + `_shared.ts`, the routes in
> `createStrut.ts`. Validated offline (§11), live against Anthropic, and
> through the gateway (`npm run test:gateway`, check b2). Supersedes the
> fix in `plans/repo-agent.md` §4.1 (a `messages` input fed from a prior
> run's log): the caller names a thread instead of pointing at a run.
>
> **Found along the way, fixed since (2026-09-29):** a provider error in
> the MIDDLE of an agent loop (an HTTP 400 after a step that succeeded)
> did not fail the step — the stream ended, the step nudged or forced a
> final answer, and returned, so the turn was committed like any other. The
> step now reads the stream's `error` parts (`streamFailure` in
> `steps/core/agent.ts`) and fails with the provider's message, on the
> first call and on any later one; such a turn is never committed.

## Problem

The `agent` step is one-shot. `system` + `prompt` go in, the loop runs, a
result comes out, and the conversation is over: the transcript is recorded
on `step.end.messages`, but nothing can feed it back in. A follow-up
("now fix the tests too") starts a cold agent that has to rediscover
everything the first one learned, in a fresh checkout that has none of its
edits.

A workflow can hold several agents, and they do not all want the same
thing: a worker should remember, a reviewer should come to each turn with
fresh eyes. So the choice has to be per step, and a later run — of the same
workflow or another one — has to be able to join.

## Decided

| Question | Decision |
| --- | --- |
| The unit | **One workflow run per turn.** A follow-up is a new run; nothing parks waiting for input |
| The handle | **A flat, global string the caller supplies** (a uuid, usually `input.session`). No `prior` run, no chain of runs, no hierarchy: the string is the whole key |
| Which agents continue | **The ones with `session` set.** No `session` = cold start, exactly as today |
| Several agents | **Different strings.** The workflow composes them (`"{{ input.session }}/review"`); strut sees unrelated ids. The same string on two steps is one shared thread |
| The record | **A session store**, one append-only thread per id: the chat's `system.md` + `messages.jsonl`. The run log records the TURN, not the thread, so logs grow linearly |
| System prompt | **Frozen by the first turn** and replayed verbatim, the chat's rule. A later step's `system` is ignored (one warn line) |
| Tools, output mode, `maxSteps` | The current step's, every turn |
| Provider and routing | **Fixed by the first turn.** A turn that resolves to another provider, or to the gateway when the thread started direct (or the reverse), fails. The model may change within a provider |
| A busy session | **The step fails** (`session_busy:`). No waiting |
| A failed or cancelled turn | **Appends nothing.** The thread is as it was before the turn |
| Working directory | **Its own name**: `workdir` on `git/checkout`. Kept after the run, reused by the next run that names it, swept when idle |
| Who may join | **Whoever knows the id.** The actor of every turn is recorded, never checked — the secret store's trust model |
| Sub-agents | An `agent` called as a TOOL cannot take a `session` in v1: the model would be choosing the id |

## Design in one paragraph

The `agent` step gets one optional input, `session`. With it set, the step
opens that thread in the session store (taking its lock), sends the
thread's frozen system prompt and its messages, byte for byte, followed by
this turn's prompt, and runs its loop as it does today. On success it
appends the turn — the prompt and everything generated — to the thread and
returns; on any failure it appends nothing. The run log records the turn
and where it sits in the thread. `git/checkout` gets one optional input,
`workdir`: a named working copy that outlives the run. A host continues a
conversation by launching another run with the same strings in `input`.

```yaml
input:
  prompt:  { type: string }
  session: { type: string, required: false }

steps:
  - id: checkout
    type: git/checkout
    config:
      repo: "{{ input.repo }}"
      workdir: "{{ input.session }}"      # the files come along
  - id: work
    type: agent
    config:
      cwd: "{{ checkout.path }}"
      session: "{{ input.session }}"      # the context comes along
      cacheTtl: 1h
      system: "You are a careful engineer."
      prompt: "{{ input.prompt }}"
  - id: review
    type: agent                           # no session: fresh eyes each run
    config:
      cwd: "{{ checkout.path }}"
      system: "You review diffs."
      prompt: "Review the working copy's uncommitted changes."
```

```bash
# turn 0, then the follow-up: the same call, the same session
curl -X POST $STRUT/workflows/repo-agent/run -d \
  '{ "input": { "repo": "…", "prompt": "Why is login slow?", "session": "6f1c…" } }'
curl -X POST $STRUT/workflows/repo-agent/run -d \
  '{ "input": { "repo": "…", "prompt": "Fix it.",           "session": "6f1c…" } }'
```

Nothing is added to `POST …/run`: the id travels in `input`.

## 1. The `session` input

`session?: string` on the `agent` step. Absent → today's behavior,
unchanged in every byte.

**Format.** 1–120 characters (the encoded directory name has to fit a
filesystem's 255); `/`-separated segments, each starting and ending with a
letter or digit, with `[A-Za-z0-9._-]` between. The rule is strict on
purpose. A multi-segment template renders a missing value as the
empty string, so `"{{ input.session }}/review"` without a session is
`/review` — which, accepted, would be ONE thread shared by every run that
forgot to pass an id. An id with an empty or ragged segment is a step error
that says so (`agent: session "/review" has an empty segment — is a
template value missing?`).

A suffixed step that should run cold when no session is passed writes the
condition: `"{{ input.session ? input.session + '/review' : undefined }}"`.

**Literal ids are global.** `session: main` is one thread for every run of
every workflow, forever. That is the feature for an automation that should
remember (`session: janitor-daily`) and a bug anywhere else. The field's
description says so.

## 2. The session store

`src/session-store.ts`: a `SessionStore` interface with File and Memory
implementations, beside the run, chat and secret stores.

```
<dataDir>/sessions/<encodeURIComponent(id)>/
  system.md        the system prompt, written by turn 0, never rewritten
  messages.jsonl   append-only ModelMessages, exactly as sent and generated
  turns.jsonl      one line per SUCCESSFUL turn — the commit record
```

One flat directory per id: `abc/review` is `abc%2Freview`, a sibling of
`abc`, not a child.

A turn line is `{ turn, at, workflow, runId, path, actor?, principal?,
provider, model, routed, offset, count, usage, cost, context: { used,
limit } }` — `offset` and `count` locate the turn's messages in the file.
There is no `meta.json`: a session's summary (created, updated, turns,
first actor, context) is its first and last turn lines.

| Method | |
| --- | --- |
| `load(id)` | `{ system, messages, turns }` or `null` |
| `appendTurn(id, { system, messages, record })` | `system.md` on turn 0, then the messages in one append, then the turn line |
| `list()` | one summary per session |
| `delete(id)` | the directory |

The turn line is the commit. Message lines past the last committed turn (a
crash between the two appends) are dropped on `load` and truncated before
the next append; they were never replayed to a model, so no history is
rewritten.

**Default.** `createStrut({ sessionStore })`, else it follows the CHAT
store's kind: file when the chat store is a `FileChatStore`, memory
otherwise. A graph-workspace host that keeps chats on disk keeps sessions
on disk with no change on its side. No pruning, like chats.

**The capability.** Steps reach the store as `ctx.services.sessions`
(`SessionsCapability`, in `capabilities.ts`; a consumer bag can override
it, like `artifacts`):

```ts
open(id, holder: { runId, path }): Promise<{
  system: string | null;          // null: this is turn 0
  messages: unknown[];
  turns: number;
  last?: TurnRecord;
  commit(turn): Promise<TurnRecord>;
  release(): void;
}>
```

`open` takes the session's lock — an in-process map in the capability, so
every store implementation gets it — and throws `session_busy: session
"<id>" is in use by run <runId> (<path>)` when it is held. In-process
because strut is single-process by design (the scheduler's posture); a
crash drops every lock.

## 3. The agent step

With `session` set, in order:

1. Check the id's format. Refuse when `ctx.agentTool` is set (§8).
2. Resolve the model, then `open` the session. Everything after is inside
   a `try … finally { release() }`.
3. **Binding.** On turn 0 nothing to check. Later: the resolved provider
   and `routed` must equal the first turn's, else `session_mismatch:`.
4. **Room.** When the last turn left the thread past the compaction mark
   (`STRUT_COMPACT_AT`, 0.9 of the resolved model's `contextLimit`), the
   thread is summarized before any model call and the summary leads this
   turn (`plans/compaction.md` §3, built 2026-10-06). With compaction off,
   fail with `session_full:` instead — a clear error the host can act on
   (start a new session) rather than a provider 400 on every later turn.
5. `system` = the session's, else `cfg.system`.
6. `head = [...session.messages, { role: "user", content: basePrompt }]`.
   The first call becomes `stream({ messages: head })`; the three
   continuation sites (stream-error resume, the premature-stop nudge, the
   forced final answer) replace their leading `{ role: "user", content:
   basePrompt }` with `...head`. One helper, four call sites. The forced
   turn, which today sends neither the system prompt nor the task, leads
   with `head` only when the thread has history — without one it is what
   it always was.
7. On success, `commit` the turn: `[{ role: "user", content: basePrompt },
   ...messages]` — the same `messages` array the step already assembles,
   nudges included.

`basePrompt` keeps its cwd preamble on every turn. It is part of the NEW
message, so history is untouched, and the agent sees the directory as it
is now.

**What the step returns.** `{ result, object?, steps, usage, cost, session:
{ id, turn, offset } }`. `session` is small, enumerable, and visible to
templates and the run callback's `output`.

**What the run log records.** `step.end.messages` = the frozen system
prompt + THIS TURN (`buildSession(system, basePrompt, messages)`, as today,
minus the earlier turns). On turn 0 that is byte-identical to a
session-less agent's. `returnMessages` puts that same array in the output.

**History is append-only.** Every request of turn N begins with turn N-1's
last request plus its reply, unchanged: the same system prompt, the same
messages read back from the file. That is what the prompt cache and
prefix-bound thinking blocks need. Tools come from the current step; a
changed tool list costs a cache miss and nothing else. Turns minutes apart
want `cacheTtl: 1h`.

## 4. Reading a thread

| Method | Path | Response |
| --- | --- | --- |
| GET | `/workflows/:name/runs/:runId/transcripts/<step path>` | unchanged: what the event recorded — for a session turn, the system prompt + that turn |
| GET | `…/transcripts/<step path>?full=1` | the thread up to and including that turn: `[system, ...messages.slice(0, offset), ...turn]`. Behind the key. 404 when the session is gone; on a session-less agent, its transcript (already whole) |
| GET | `/sessions` | summaries: `{ id, turns, messages, createdAt, updatedAt, createdBy?, model, context?, busy? }` |
| GET | `/sessions?id=<id>` | that session's summary + its turn lines (`turnLog`) |
| GET | `/sessions/messages?id=<id>` | `[system, ...messages]`, a bare array |
| DELETE | `/sessions?id=<id>` | 409 while busy |

The id is a query parameter because it contains slashes. Every `/sessions`
route is behind `requireApiKey`, reads included: a thread is the most
sensitive thing strut can serve. The run callback's `transcripts` links are
unchanged; a host that wants the thread adds `?full=1`. 501 when the host
injected its own `sessions` capability (strut does not own that store).

**In the graph.** The projector's `StrutAgentSession` is one execution of
an agent step — one TURN. A turn of a thread carries `session_id` (from the
step's resolved config on `step.start`, so a failed turn is grouped too; an
id the step refused is not stamped) and `session_turn` (from the output,
so only a committed turn has one). A thread is every node with that id,
across runs and workflows; what it touched is

```cypher
MATCH (s:StrutAgentSession {session_id: $id})<-[:IN_SESSION]-(:StrutToolCall)-[:ACCESSED]->(n)
RETURN s.session_turn, s.run_id, n
```

An agent without `session` is found as before, by `run_id` + `path`. Every
top-level run is projected when it ends (`createStrut`, detached), so a
thread's turns are in the graph without a batch.

## 5. The working directory

`git/checkout` gets `workdir?: string`, the same format as a session id.
Absent → today's behavior: a worktree under `worktrees/<runId>/`, removed
when the run ends.

With `workdir`:

- The working copy lives at `<dataDir>/workdirs/<encoded name>/<repo
  name>`, the SAME path on every run — it has to be, the transcript is
  full of it.
- **It exists** → the cache is fetched, the working copy is left exactly as
  the last run left it (edits, untracked and ignored files), and the output
  carries `reused: true`. `ref` applies only when a working copy is
  created; `sha` is always the current `HEAD`.
- **It does not** → created as today, `reused: false`. After a sweep this
  is a session whose agent remembers edits that are gone; the workflow can
  say so in the prompt (`{{ checkout.reused }}`).
- Nothing is removed at run end, and a retry of the step does not start
  over.
- **One run at a time.** The first checkout takes the workdir's lock for
  the RUN (released by `ctx.onRunEnd`); another run's checkout fails
  `workdir_busy:`. The same run may check out several repos into it.
  Outside the runner (no `ctx.onRunEnd`) nothing is held.
- **Sweep.** Beside each directory sits `<encoded name>.json` — `{ name,
  usedAt, repos: [{ cache, dir }] }`, outside the agent's reach. Every kept
  checkout first removes the workdirs idle longer than
  `STRUT_WORKDIR_TTL_DAYS` (default 7; `0` keeps them forever) and not
  locked: `git worktree remove` in each cache, then the directory and its
  file. No timer; disk is reclaimed when the next kept checkout runs. The
  checkout stamps its OWN workdir as used first, so coming back to an idle
  one keeps it.

`workdir` and `session` are independent. A cold reviewer reads the files a
remembering worker wrote; a session with no `workdir` remembers and starts
from a fresh checkout.

## 6. What a caller does

Any HTTP client; nothing here is specific to one host.

1. Mint an id. `POST …/run { input: { prompt, session }, callback }`.
2. Read the result from the callback, as today.
3. For a follow-up, launch again with the same `session`.
4. When the conversation is over, `DELETE /sessions?id=…`. The workdir
   goes with the sweep.

A `session_busy:` / `workdir_busy:` / `session_full:` / `session_mismatch:`
prefix on the run's error message is the contract a host classifies on,
like the `git/*` steps' codes.

## 7. How it meets the rest of strut

| | |
| --- | --- |
| Step `retry` | A failed attempt appended nothing and released the lock: the next attempt starts from the same thread |
| Cancel | The turn ends, nothing is appended. The workdir keeps what the turn wrote |
| Pause | The lock is held until the run resumes or is cancelled |
| Durable resume | A journaled step replays its output and never reaches the store: no second append. A step cut off by a crash re-executes from the thread as it was |
| The crash window | A crash after `commit` and before the runner writes `step.end` re-executes the step on resume, as a further turn. Accepted: the alternative order loses a turn silently |
| "Re-run from here" | Re-executing a session step is a NEW turn. A thread is never rewound |
| `foreach` | `session: "file-{{ item.path }}"` is a thread per item. One literal id across parallel iterations is `session_busy:` |
| Two steps, one id, one run | The second continues the first when it depends on it; in parallel, one of them fails busy |
| Automations | A fixed id is an agent that remembers across fires. It will fill its window (`session_full:`) — see §9 |
| Billing | Each turn is its run's: that run's principal, that run's cap |
| Secrets | Tool output is masked before the model sees it, so a thread holds no `secretsEnv` value |

## 8. Sub-agents

An agent granted `agent` through `agentTools` calls it with the step's
whole input schema, so the MODEL would pick the session id — a read door
into any thread whose name it can guess. In v1 an `agent` running as a tool
(`ctx.agentTool`) with `session` set returns an error. A persistent
sub-agent needs the parent to fix the id, which is its own design.

## 9. Left out

- **Compaction** — built 2026-10-06 as `plans/compaction.md`, with a
  simpler shape than the one first noted here: not a new session seeded
  from a summary but a boundary in the same thread — the `[compaction]`
  message appended at open (a thread left past the mark) or between
  steps, and `replayFrom` on the turn line. `session_full:` remains for
  `STRUT_COMPACT_AT=1`.
- **Forks.** One id is one line. Replaying from a midpoint is copying a
  thread to a new id up to a turn; evals will want it, nothing does yet.
- **A working directory that is not a repository** (an agent whose `cwd` is
  the run's artifact dir). Smallest fix when needed: a `workdir` step that
  returns the named directory's path.
- **Sessions on the `llm` step**, and a thread that moves between
  providers.
- **UI.** The step editor shows `session` from the schema; the run flyout
  shows it in the output. A thread viewer is later.
- **Deleting a workdir by hand**, pruning sessions, a publish-time lint for
  one literal id on parallel steps.

## 10. Work items

1. **Store.** `src/session-store.ts` (interface, File, Memory);
   `SessionsCapability` + the lock in `capabilities.ts`; `createStrut`
   wiring (`StrutOptions.sessionStore`, the default, the bag); a
   `SessionStore conformance` suite in `storage-conformance.test.ts`.
2. **Step.** `session` on `agent` (§3); `contextLimit` and `routed` read
   off the resolved model into the turn line.
3. **Routes.** §4, in `createStrut.ts`; `specs/API.md` §5 and a new
   section for `/sessions`; `web/vite.config.ts` proxies `/sessions`.
4. **Workdir.** `workdir` on `git/checkout`, the lock and the sweep in
   `git/_shared.ts` (§5).
5. **Docs.** `AGENTS.md`: the layout line, `STRUT_WORKDIR_TTL_DAYS`, a Key
   concepts entry, the agent step's paragraph.
Items 1–3 are one PR; 4 is independent of them.

**No host changes.** Everything above is in strut. The store's default,
the routes and the capability need nothing from an embedding host, and
`POST …/run` is unchanged. Using a session is a workflow's choice (two
lines of YAML) and a caller's (one string in `input`) — adoption, not part
of this work.

## 11. Validation

Offline, against a stand-in provider that records request bodies (the
pattern in `chat-endpoints.test.ts`):

- Two runs, one session: the second request's `system` is the first's, and
  its `messages` begin with turn 0's prompt and reply byte for byte,
  followed by the new prompt.
- A changed `system` on turn 1 is ignored; tools follow the step.
- A failing turn, and a cancelled one, leave `messages.jsonl` and
  `turns.jsonl` untouched; a step `retry` then succeeds from the same
  thread.
- Two live turns on one id: the second fails `session_busy:`; after the
  first ends, a third succeeds.
- Bad ids (`/review`, `abc/`, `a..b/`, empty) are refused; an absent
  `session` produces the events a session-less agent produces today.
- `session_mismatch:` and `session_full:` fire before any request.
- `step.end.messages` holds the turn; `?full=1` holds the thread to that
  turn; an `agent` tool call with `session` is refused.
- Durable resume of a run whose session step finished appends nothing.
- `git.test.ts`: a kept workdir is reused with its edits and ignored
  files, `reused` is right, a second run is `workdir_busy:`, an idle
  workdir is swept and its worktree pruned from the cache.

Through the gateway (`npm run test:gateway`, check b2), because history
now crosses it on every turn: a two-turn session whose first turn searches
the web and runs bash, so turn 1 replays those blocks through Bifrost, and
must name the command turn 0 ran and read its prefix from the cache.

Not yet run: the same check across a model change within one provider. It
decides whether "the model may change" stands or the binding tightens to
the model.
