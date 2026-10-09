# Tool-result spill — a budget per result, and a way past every cut

> **Status (2026-10-06): proposed.** Covers the builder chat (`ai/tools.ts`
> `capToolResults`, `createStrut.ts` `launchChatTurn`) and the `agent` step
> (`steps/core/agent.ts`). Builds on `plans/compaction.md` §4 (caps follow
> the window) and the append-only rule (strut#76). Written after chat
> `muwr8dzn-20rzt5` on swarm38; the first fix, `run_step` returning a step's
> output once instead of three times, is strut#110 (merged). Since 2026-10-09
> `edit_workflow` / `edit_step` take `edits` (exact-string replacements over
> the active version), so a document the builder changes need not come back
> whole, and `get_workflow` / `get_step` are capped by the window's headroom
> alone (176k on 1M, never the 50k ceiling; `DOCUMENT_TOOLS`) and never
> re-cut on replay. The exemption below — an ERROR past the budget instead
> of a cut — is superseded: with `edits`, a cut document is still editable.

## Problem

Chat `muwr8dzn-20rzt5` (swarm38, Opus 5.5) went from 75k to 635k tokens of
context in one model call. A `run_step` of a probe step the builder had
written returned 384 KB of output. The tool sent it three times (as
`output`, on `step.end`, and on `run.end`), 1.15 MB of JSON, about 560k
tokens at the 2 chars per token of escaped JSON and UUIDs. Every later call
re-sent it, and the chat finished its turn at 805k / 1M. None of it was
needed: 376 KB of it was two `edges` arrays holding whole Repository nodes,
a bug in the probe that a short view would have shown.

strut#110 removed the repetition. What it did not fix:

1. **The builder's cap is per STRING, not per result.** `capToolOutput`
   cuts each string at the cap (50k, bounded by the window since
   compaction), so a result made of many shorter strings has no bound. The
   largest string in that result was exactly 50,000 chars: the cap fired
   and did not matter.
2. **A cut has no way past it.** A capped string ends in `[TRUNCATED: N
   chars, cut to M]`. The full value exists only in the chat's
   `events.jsonl`, which the model cannot address. `get_run` is the same:
   its focus node's payload tops out at 20k even with `fullEvents: true`
   (`run-view.ts` `FULL_LEVELS`). The builder's `bash` cuts at 20k inside
   `runShell`, and the only way to the rest is running the command again
   (a curl, a clone: slow, and not always repeatable).
3. **The `agent` step's `agentTools` results are not capped at all.**
   `registryToolModelOutput` passes a registry step's output straight
   through. A `graph/*` or `jarvis/*` step granted to a workflow agent can
   put megabytes into its context in one call.

## Decided

| Question | Decision |
| --- | --- |
| The unit | **One budget per tool RESULT**, the whole value as the model reads it, not per string |
| The number | **The window-derived cap compaction already computes** (`resultCapChars`, `src/compaction.ts`): the builder's `min(STRUT_CHAT_TOOL_RESULT_MAX_CHARS, headroom)`, the agent's `min(500k, headroom)`. A tool may declare a smaller budget, and the smaller one wins |
| Over budget | **Spill and preview.** The full result goes to a file the model can read with tools it already has, and the model gets a preview that keeps the result's shape, says what was cut, and names the file |
| Not pagination | Character pages split JSON mid-structure, and reading every page costs what the whole result did. The model reads past a cut by path or query (`jq`, a Python one-liner, `sed -n`), only what it needs |
| Exempt | **A document the model sends back whole**: `get_step` with `source: true` (→ `edit_step`) and `get_workflow` (→ `edit_workflow`). Never cut. Over budget, an error naming the size instead of a cut document |
| `get_run` | **Not exempt, not separate.** It keeps its shaping (one level open, rollups, errors first) and its 20k budget, now declared to the wrapper. Its cuts spill like any other tool's (§4) |
| Media | File parts (`withMedia`, images) pass through whole, as today |
| History | **Unchanged rule**: the preview is fixed when the result is made, recorded in `messages.jsonl` as sent, replayed byte for byte. Reading past a cut is a NEW tool call |

## Design in one paragraph

A tool returns its natural result. The wrapper that already sits on every
builder tool's `toModelOutput` (`capToolResults`), and a new one on the
agent step's tools, measures it. Under budget, it passes untouched. Over
budget, the wrapper writes the full result to a file named by the tool
call, and sends the model a PREVIEW: the same JSON shape, with long arrays
kept as head + tail and an `{ omitted, from, to }` gap, long strings kept as
head and `…[cut: N chars]`, tightened in fixed levels until it fits, inside
an envelope that says where the rest is. The model reads past the cut with
`bash`, or with `view` in the agent step. A tool that shapes its own view
(`get_run`) hands the wrapper the view AND its uncut form, and the uncut
form is what spills.

## 1. The module

`src/tool-result.ts`, pure apart from one write:

```
fitResult(output: ToolResultOutput, budget: number): { preview: ToolResultOutput; cut: boolean; hint?: string }
spillResult(output: ToolResultOutput, budget: number, spill: Spill): Promise<ToolResultOutput>
  // under budget → output as is; over → write full, return the preview envelope
interface Spill { dir: string; name: string; shown: string }   // shown = the path as the model should write it
withFull<T>(view: T, full: unknown): T  /  fullOf(v): unknown  // a non-enumerable marker, like withMedia
```

**Measuring.** The size is `JSON.stringify` of the value for `json`, the
string's length for `text`, the text parts' total for `content` (file parts
do not count; they are never cut).

**The preview** (`fitResult`). It walks the value, with these limits per
level:

| Level | Longest string | Array kept (head + tail) |
| --- | --- | --- |
| 0 | 8000 | 40 |
| 1 | 2000 | 16 |
| 2 | 500 | 8 |
| 3 | 150 | 4 |

It stops at the first level that fits. If none does (a giant object with
thousands of keys), the last resort is the level-3 render's JSON head, cut
to the budget: still bounded, and still pointing at the file. Object keys
are never dropped, so the model sees every field that exists and how big
each one was. A cut array leaves `{ omitted: n, from: i, to: j }` in place
of the stretch it removed, the gap shape `get_run` already uses. A `text`
result keeps its head (2/3 of the budget) and its tail (1/3), so both a
command's result and the error that ended it survive, as
`runProcess`'s output cap does.

**The envelope.** A cut `json` result is sent as

```json
{
  "cut": { "chars": 1152800, "full": "scratch/tool-results/<chatId>/<toolCallId>.json",
           "hint": "Cut to fit 50000 chars: arrays to 8 items, strings to 500. The whole result is in `full`; read the part you need, e.g. jq '.output[2].edges | length' <full>." },
  "result": <the preview>
}
```

A cut `text` result is the preview with one line at the end:
`[cut: 412000 chars. Whole output: <full>. Read it with sed -n / grep / tail.]`.

The envelope changes the shape only when there is a cut, and then it says
so first. The hint is fixed text plus the numbers, so the same result
always yields the same bytes.

**The file.** The full result as JSON (`json`, `content` text parts) or as
written (`text`). Written before the preview is returned. If the write
fails, the preview goes out without `full`, and the hint says the rest is
not available. A tool result never fails because its spill did.

## 2. The builder

`capToolResults(tools, maxChars)` becomes `fitToolResults(tools, { budget,
spill })`, with the same position in `buildTools`. For each tool with an
`execute`:

- **Budget**: `min(deps.toolResultMaxChars, the tool's own)`. Tools declare
  their own through a map in `tools.ts` (`get_run: 20_000`), not a field
  on the tool, since the AI SDK's `tool()` has no such field.
- **Exempt** (`get_step` when called with `source: true`, `get_workflow`):
  not cut. Over budget, the tool returns `{ error: "<name> is N chars, over
  the M this model can read in one result. …" }` instead of the document.
  Today they are cut per string, which gives the model a truncated file to
  edit. An error is better than that.
- **Spill dir**: `<deps.shell.cwd>/scratch/tool-results/<chatId>/`, so the
  path the model reads is relative to `bash`'s cwd. `AiDeps` gains `chatId`
  (set by `launchChatTurn`), because a non-Anthropic provider's tool-call
  ids are not guaranteed unique across chats. No `deps.shell` (a host that
  turned `bash` off): no spill, the preview says so. A `read_result` tool
  for that case waits until a host actually runs without `bash`.
- **`bash`**: `runShell(command, cwd, timeoutMs, 20_000)` cut the output
  before the wrapper saw it. The capture cap becomes the agent's ceiling
  (500k, head + tail), and the wrapper does the cutting, so a long command's
  output spills instead of being lost.
- **Replay**: `truncateToolMessages` stays as it is. It only touches
  histories recorded before caps moved to the source.

`STRUT_CHAT_TOOL_RESULT_MAX_CHARS` keeps its name and default. Its meaning
changes from per string to per result (AGENTS.md's env table and the chat
paragraph say so). `0` still removes the ceiling, and the window's cap
still applies while compaction is on.

## 3. The agent step

One wrapper over the merged tool set, after `wrapToolsWithEmit`, so the
event log still records the tool's own output (cut to 1500 chars for the
log, as today):

- **Budget**: `resultCap`, the number the step already computes once the
  model is resolved (`resultCapChars(BASH_MAX_CHARS, contextLimit, at)`,
  176k on a 1M window).
- **Applies to** every tool with an `execute`: `agentTools` results (the
  hole), `bash`, `fulltext_search`, the aieo web shims. Provider-executed
  tools have no `execute` and are the provider's, as now.
- **Exempt**: `str_replace_based_edit_tool`. A `view` is a file that is
  already on disk, so a copy adds nothing. It keeps its own cap, and the cut
  tells the model to use `view_range`. `repo_overview` and `file_summary`
  cap at 12k and never reach the budget.
- **Spill dir**: `<artifacts.dir(runId)>/tool-results/` (the
  `NNN-<tool>` name the event already uses, `.json` or `.txt`), with
  `os.tmpdir()/strut-tool-results/<runId>/` when the bag has no
  `artifacts`. NOT the agent's `cwd`: that is often a git worktree or a job
  directory, and a spilled file there would end up in a diff or a
  deliverable. The spill dir is added to `textEdit`'s roots, so `view` can
  read it. `bash` reads any absolute path already.
- **Sessions**: a later turn replays the preview, whose absolute path points
  into an earlier run's artifact directory. Artifacts outlive their run,
  so the path stays valid. The tmpdir fallback is removed with
  `ctx.onRunEnd`, and its hint says the file lasts for this run only.
- **`withMedia`**: `registryToolModelOutput` runs first, and the wrapper cuts
  its text part, leaving the file parts whole.

## 4. `get_run`

`readRun` keeps everything that makes the view navigable: one level open,
rollups below it, errors first with their siblings, `path` zoom. What
changes is where its cuts lead:

- It renders twice. Once at its levels, as today, as the view. Once with
  no limits on the same focus, every child listed with whole payloads, as
  the full form. It returns `withFull(view, full)`.
- The wrapper sees the marker. When the view was cut (its `hint` is set),
  the FULL form is spilled and the envelope's `full` points at it. The
  model gets the same view it gets today, plus a way to read the whole 384k
  output: `jq '.focus.output' <full>`.
- Its 20k is declared to the wrapper, which applies whichever budget is
  smaller, 20k or the window's.

`search_runs` keeps its own limits, and the generic spill covers anything
over budget.

## 5. Not in scope

- **Several big results in one step.** Each is bounded, but N at the
  budget can still outrun the headroom (compaction §4 "Residual"). That
  is unchanged.
- **Retention.** Builder spills live under `scratch/`, like everything
  else the builder writes there. Nothing removes them today, and nothing
  will. A sweep, if one is needed, belongs to `scratch/` as a whole.
- **Steps' own outputs.** A step returning megabytes into the run log is a
  workflow concern (`exec`'s 500k cap, artifacts for big results). This
  plan only bounds what a MODEL reads.

## 6. Tests

- `tool-result.test.ts`: under budget passes unchanged (same reference);
  each level fits a constructed value; gaps carry the right indices; keys
  are never dropped; text head + tail; file parts untouched and not
  counted; the last resort is bounded; the same input gives identical bytes
  twice; a failed write still returns a bounded preview without `full`.
- Builder (`ai-integration.test.ts`): a `run_step` whose step returns 1 MB
  comes back under budget with `cut.full` pointing at a file whose contents
  are the whole result; `get_workflow` over budget is an error, not a cut
  YAML; `get_run` with a 300k step output shows today's view and spills
  the focus payload whole; `bash` printing 100k spills.
- Agent step: an `agentTools` step returning 1 MB is cut in the model's
  messages (the stand-in provider sees the request), the file is in the
  run's artifact dir, `view` can read it, and the event log is unchanged.
- The chat-store cap tests move to the new module. `truncateToolMessages`
  keeps its own test.
