# Run Control — Spec

Cancel, pause/resume, and durable resume for runs — including the nested
run TREES the lab produces (an evolve run that launches generation runs
that launch candidate runs), where today the only control is killing the
server and orphaning every in-flight log as "stale".

Status: IMPLEMENTED (all three rungs, and a fourth: parked runs, §5.6). The runner/controller live in
`src/run-control.ts` + `src/runner.ts`, the journal in `src/journal.ts`,
the endpoints in `src/createStrut.ts`
(`POST /workflows/:name/runs/:runId/{cancel,pause,resume}`), the UI in
`web/src/app.tsx`, and the lab linkage (optimizer `parentRunId`,
evolve-loop `ctx.journal` iteration resume) in `mcp/src/lab`. Tests:
`src/run-control.test.ts`.

---

## 1. Problem

A long optimization run (harvey-evolve: hours, tens of dollars, ten+
nested runs) currently offers zero control after launch:

- **No cancel.** A run discovered to be misconfigured at generation 1
  burns the remaining budget anyway.
- **No pause.** Server maintenance means choosing between waiting hours
  or killing everything.
- **No recovery.** A crash or restart loses ALL in-flight progress. The
  event log survives (append-only JSONL, every step's output recorded)
  but nothing can consume it: the run can only be started over from
  scratch, re-spending everything already spent.
- **No tree awareness.** Even with a per-run kill, the lab's runs are
  trees (`harvey-evolve` → `optimizer.run` → `harvey-evolve-gen` →
  `meta/run-workflow` → `harvey-produce-ai`). Each nested launch is an
  independent `runWorkflow` invocation sharing nothing — stopping a
  parent must stop its descendants or it stops nothing.

The runner's own architecture makes this tractable: `runWorkflow` is the
single choke point every run path goes through, every step boundary is
already instrumented (step.start/step.end events), and completed step
outputs are already durably journaled. Run control is mostly about
exposing seams the engine already has.

---

## 2. Design overview

Three features, strictly layered — each rung is independently shippable
and each reuses the previous rung's plumbing:

1. **Cancel** — cooperatively stop a run tree at the next step boundary;
   finalize honestly as `cancelled`.
2. **Pause / resume (in-memory)** — park a run tree at the next step
   boundary of every active branch; release it later. Does not survive a
   restart.
3. **Durable resume (journal replay)** — continue an interrupted run
   after a crash/restart by replaying completed steps' outputs from the
   event log and executing from the first incomplete step.

Pause (2) + durable resume (3) compose into the real operational win:
pause, wait for quiescence, restart the server, resume — a long run
survives a deploy.

### 2.1 One principle: cooperative, at boundaries

The leaves of a run tree cannot be frozen: an LLM call mid-stream, a
`uv`-spawned grader subprocess, an HTTP request. All control is therefore
**cooperative**: the current unit of work completes (and is paid for),
and the run checks for a control signal before starting the next unit.

Checkpoints, from coarse to fine:

| boundary                    | where                                      | rung |
|-----------------------------|--------------------------------------------|------|
| between DAG steps           | `executeFlow.runStep`, before `executeStep`| 1, 2 |
| between loop/foreach iters  | `executeLoop` / `executeForeach`           | 1, 2 |
| between retry attempts      | `executeStep` retry sleep                  | 1, 2 |
| between agent tool calls    | agent step's tool loop                     | 2    |
| between code-step iters     | opt-in via `ctx.control` (e.g. evolve-loop)| 1, 2 |

A run tree paused at these boundaries quiesces within one step / one
tool call per active branch — bounded, predictable, and the money spent
on the in-flight unit is not wasted (its output lands in the journal).

### 2.2 One mechanism: the RunController

```ts
type ControlState = "running" | "pausing" | "paused" | "cancelling";

interface RunController {
  readonly runId: string;
  readonly workflow: string;
  readonly parent?: RunController;      // tree linkage
  readonly children: Set<RunController>;
  state: ControlState;                  // own state; effective state
                                        // inherits the strictest ancestor
  /** The cooperative checkpoint. Resolves immediately when running;
   *  blocks while (effectively) paused; throws CancelledError when
   *  (effectively) cancelling. Every boundary in §2.1 awaits this. */
  checkpoint(): Promise<void>;
  /** True when this run AND all descendants are parked at a boundary
   *  (drives "safe to restart now"). */
  quiesced(): boolean;
  cancel(): void;                       // idempotent; propagates to children
  pause(): void;                        //                    "
  resume(): void;                       //                    "
}
```

- **Registry.** `createStrut` holds `controllers: Map<runId, RunController>`
  (superseding today's `activeRuns: Set<string>` — a controller's presence
  IS "in-flight", so the `"running" | "stale"` listing fallback reads this
  map). Registered/unregistered exactly where `trackRun` is called today:
  `launchDetached`, `strut.run`, authoring's `runWorkflow`.
- **Tree linkage.** Nested launches attach to the launching run's
  controller. The parent runId travels the same paths the services bag
  already does: `RunOptions.parentRunId`, set by `meta/run-workflow` and
  the optimizer capability from their calling step's `ctx.runId`.
  Subflows/foreach/loop need nothing — they share the parent's runId and
  therefore its controller.
- **Effective state.** `checkpoint()` walks ancestors: any ancestor
  cancelling → throw; any ancestor pausing/paused → block. Controls
  therefore apply to WHOLE SUBTREES: cancelling the evolve run cancels
  its generations and candidates; pausing a single candidate pauses only
  that candidate.
- **Threading.** The controller rides `RunOptions` into `runWorkflow` and
  is exposed to steps as `ctx.control` (optional, like `ctx.registry` —
  absent outside the runner, e.g. unit tests). Code steps with long
  internal loops (evolve-loop's generations) call
  `await ctx.control?.checkpoint()` per iteration; steps that ignore it
  simply remain coarse-grained (control applies at their step boundary).

---

## 3. Rung 1 — Cancel

**Semantics.** `controller.cancel()` flips the subtree to `cancelling`.
Every branch throws `CancelledError` at its next boundary. `runWorkflow`
catches it as a distinct outcome (NOT the generic error path):

- emit `run.cancelled` (terminal event; `store.tailRun`'s `isTerminal`
  gains this type so SSE tails end),
- `store.finalize` with `status: "cancelled"` — run.json exists, the run
  is never "stale", partial outputs stay inspectable in the log,
- `onRunEnd` teardown fires as on any other exit (browsers/stacks are
  disposed).

**Force.** Cancel is cooperative, so a step that never returns would hold the
run `cancelling` forever. `controller.force()` is `cancel()` plus abandoning
every in-flight step body in the subtree (`raceForce`, run-control.ts): the
runner stops awaiting it, throws `CancelledError`, and the run finalizes as
`cancelled` as above. The step's code is not killed. An agent step lets go of
its session when the run ends (`ctx.onRunEnd`), and a session let go of
refuses the abandoned turn's commit (`session_released:`), so the thread's
next turn starts and is not overwritten. Surfaces: `POST …/cancel
{ force: true }`, `run/cancel { force }`, chat `cancel_run { force }`, and the
UI's "Force cancel" (shown while `cancelling`).

**Ordering.** Children are cancelled by the same effective-state walk —
no separate fan-out message. A parent blocked awaiting a child's result
(optimizer.run, meta/run-workflow) sees the child return
`{ status: "cancelled" }` and then hits its own checkpoint. Steps that
launch children treat a cancelled child like a failed one (the existing
error paths), except the enclosing run is itself cancelling and will not
proceed.

**In-flight work.** v1 does not kill the current unit: the LLM call or
grader subprocess completes, its output is journaled, THEN the branch
stops. v1.5 (optional): thread an `AbortSignal` (aborted on cancel only,
never pause) into the agent step's AI-SDK calls and `services.http` for
faster, cheaper teardown of the most expensive leaves. Subprocess
graders keep run-to-completion semantics. Subprocesses strut itself
spawns are the exception: the `exec` step and the agent step's `bash`
tool watch the run state and SIGTERM their process group when it turns
cancelling, so a cancel never waits out a hung command (the `bash` tool's
own cap is `bashTimeoutMs`, 5 min by default). Whatever a command leaves
running in its process group after it returns is killed when the run ends,
so nothing a run spawned outlives it.

**API/UI.** `POST /workflows/:name/runs/:runId/cancel` (404 unknown, 409
already terminal; 403 for a `peer`-scoped caller on a run no peer launched —
the same rule for pause and resume, plans/federation.md §3). UI: a Cancel button in the topbar of an active run's
view; confirm dialog states the subtree consequence ("cancels N nested
runs").

**Status vocabulary.** `RunSummary.status` gains `"cancelled"`. The runs
listing keeps synthesizing `"running" | "stale"` for summary-less dirs
(from the controllers map), and adds `"paused"` (§4).

---

## 4. Rung 2 — Pause / resume (in-memory)

**Semantics.** `controller.pause()` → subtree state `pausing`; each
branch blocks inside `checkpoint()` at its next boundary; when all
branches are parked, `quiesced()` is true and state reads `paused`.
`resume()` releases every parked checkpoint. No events are lost, no
state is discarded — the run's promises simply stop advancing.

**Extra boundary: the agent tool loop.** A 200-step author agent must
park between tool calls, not after its whole session. The agent step
checks `ctx.control` between AI-SDK steps (via its per-step hook, e.g.
`prepareStep`/`onStepFinish`) — the in-flight LLM call finishes, the next
one doesn't start. This is the single highest-value checkpoint in the
lab's workloads.

**Observability.** Emit `run.paused` / `run.resumed` (non-terminal) so
the event log records the gap — otherwise a resumed run's step durations
silently include parked time and poison any timing analysis. The runs
listing reports `paused`; SSE tails stay open (heartbeats already exist).

**Honest limits.** In-memory only: a paused run dies with the process
(becoming exactly the orphan that §5 resurrects — pause then restart
WITHOUT rung 3 is still data loss). Wall-clock-sensitive steps (`wait`,
external polling) resume where they left off; external systems don't
pause with us. Pause does not release per-run resources (a gitsee
browser/stack stays up while parked) — pausing to save money only stops
NEW spend, chiefly LLM calls.

---

## 5. Rung 3 — Durable resume (journal replay)

The event log already contains everything a resume needs: every
completed step's `step.end` carries its `output`, keyed by a
deterministic `path` (`wf/stepId`, `wf/stepId#iter/...` for
foreach/loop bodies, synthetic `wf/stepId#gen` rows for iterative code
steps). Resume = re-run the workflow against that journal.

**Mechanism.**

```
resume(workflow, runId):
  events   = store.getRunEvents(workflow, runId)      # the journal
  journal  = { path → output } for every step.end     # completed units
  input    = the run.start event's recorded input
  re-invoke runWorkflow with { runId, journal }        # SAME runId
```

Execution proceeds normally, except `executeStep` consults the journal
first: a step whose `path` has a journaled output **replays** it (emit
`step.replayed` with the output; resolve the DAG promise; zero cost, no
side effects re-executed — only what the step held in memory is put back,
its `onReplay`, §6) instead of executing. The first path NOT in
the journal executes live, and everything downstream follows. Scope,
templates, and skip/gate logic are reconstructed naturally because they
only ever consume step outputs.

The resume first drops the attempt's summary (`run.json`,
`store.clearRunSummary`): a summary always means the LATEST attempt
finished, so a resumed run reads as live — its controller's state —
everywhere (the run, the lists, the scheduler's overlap rule, the job
index), never as the outcome it is resumed from. The log keeps the old
terminal event. A crash before `run.resumed` is appended leaves that
terminal event last, which boot finalizes again (§5.3); a crash after it
leaves a cut-off run boot resumes.

### 5.1 Hard stops are the same case

Nothing above requires a graceful shutdown. The journal is written AS
THE RUN HAPPENS — every event is appended (and awaited) before execution
continues — so after a SIGKILL, an OOM kill, or a power cut, the disk
already holds the completed prefix plus at most one dangling
`step.start` per active branch. Resume replays the prefix and re-executes
the interrupted units. Crash recovery is therefore rung 3 verbatim; a
graceful pause-then-restart merely avoids re-spending the in-flight
step. Three crash-specific hardenings:

- **Torn tail.** A process killed mid-append can leave a truncated final
  JSONL line (step outputs are large; `appendFile` writes them in several
  chunks). The resume endpoint HEALS the log first (`store.repairLog`:
  truncate to the last newline) so the resumed run's first append starts
  on a fresh line instead of being glued onto the fragment — which would
  silently drop that event and leave a merged, unparseable line behind.
  Independently, the readers (`getRunEvents`, `tailEvents`) skip any
  corrupt line with a warning rather than throwing: a log that cannot be
  read is a run that is stuck for good, and a corrupt line never belongs
  to a completed unit.
- **Durability policy.** `appendFile` lands in the page cache; a whole-
  SYSTEM crash (not a process kill) can lose recently "written" events.
  Option: fsync on `step.end` / run-level events only (the events worth
  money). Acceptable default: no fsync — losing the cache tail just
  rewinds resume a little further back, which is correct, merely less
  thrifty.
- **At-least-once side effects.** Re-executed steps REDO their external
  effects: an author agent crashed mid-session republishes (an extra
  candidate version — benign, versions are append-only), a re-run
  meta/run-workflow launches a fresh child run. This is the §6
  re-execution contract doing its job; steps whose effects must not
  double need their own idempotency (none in the current lab do).

### 5.3 Boot-time auto-resume

IMPLEMENTED (`autoResumeStaleRuns` in `createStrut.ts`; on by default
whenever the RUN STORE outlives the process — anything but
`MemoryRunStore`, whatever the workspace's kind, so a graph workspace
with a `FileRunStore` counts — `STRUT_AUTO_RESUME=0` or `autoResume:
false` to disable; runs a few seconds after construction). A resumed run
posts its `run.end` callback: the URL is kept by the run store beside the
log (`setRunCallback`), never in it — and so does a run boot finalizes
(its log ended, its summary was never written): the dead process never
posted it. The operational goal:
a long serial workflow must never need to be started over because the
server restarted.

**Cut off vs. cancelled is knowable.** Cancel and error always FINALIZE
(`run.cancelled` / `run.error` + `run.json`), so a run with a log and no
summary died with its process. Two markers close the remaining gaps:
`run.cancelling` is appended when cancel is REQUESTED (a run that dies
before reaching its boundary is finalized as cancelled on boot, not
resumed), and `run.paused` with no later `run.resumed` means a human
parked it (left alone, resume by hand).

**Roots only.** `run.start` records `parentRunId` for a nested run
(derived from the controller tree). Boot resumes only root runs: a
parent re-executing its launching step relaunches its children (§5.1
at-least-once), so resuming orphaned children would only duplicate work
that reports to nobody.

**Every run the last death cut off.** The scan reads when the previous
process started from `<dataDir>/boot.json` and looks at every root run
with no summary whose last event is at or after it — however many runs
of one workflow were in flight (a `job` or `orchestrator` runs many at
once). It writes this process's start there once it is done, so a
process that dies before its scan leaves the record as it was. A run
whose last event is older was cut off by an earlier death, which the
boot after it already looked at: left alone, unreported. Such a run is
known by its log's mtime (`RunStore.logWrittenAt`, never earlier than
the last event; 2 s of slack for a filesystem that keeps seconds), so
neither its summary nor its log is read: a boot reads only the runs the
last process wrote to, however many a workspace holds. With no record
(the first boot), only the newest root run of each workflow is looked at,
newest-first by run id: if it has a summary, nothing was cut off. No
dedupe is needed by job or automation — one job, and one automation,
never has two runs in flight. Guards: a log over
`STRUT_RESUME_MAX_LOG_BYTES` (**64 MB**) is skipped by its size, unread —
loading it is what the dead process could not survive, and the same cap
is a 413 on `POST …/resume`; a log that
already ends in a terminal event just gets its missing summary written;
a run whose last event is older than **7 days** is skipped; a run with
**5** or more durable `run.resumed` markers is skipped (a step that
deterministically kills the server must not loop forever) — the
`run.resumed` the control routes write when they UNPAUSE a live run is
marked `live: true` and never counted. Every
decision is logged as `[auto-resume] wf/run: resumed|finalized|skipped —
reason`, and the same DAG resolution as the endpoint applies (pinned
version by hash; refused, never forced, when no version matches).

### 5.2 Resume after failure — retry from the failed step

A run that finalized `status: "error"` (an infra hiccup: a 529 from the
provider that outlived retries, a grader subprocess OOM) is the same
journal with a terminal summary on top. The replay mechanics need
NOTHING new: the failed step has no journaled `step.end`, so plain
resume replays the completed prefix and re-executes exactly the failed
step (fresh retry budget, same onError config) and everything
downstream. A failed foreach iteration re-runs alone — completed
iterations replay by their `#i` paths. What failure-resume actually
adds is lifecycle bookkeeping:

- **The terminal-summary guard relaxes.** Resume refuses only
  SUCCESSFUL runs (nothing to resume — unless `from` below). `error`
  and `cancelled` runs are resumable; on the resumed run's completion,
  `store.finalize` supersedes the old summary (the log keeps the
  original `run.error` + `run.resumed` marker, so history stays
  honest).
- **Tail terminality.** `run.error`/`run.cancelled` are no longer
  unconditionally terminal: a later `run.resumed` in the log reopens
  the stream (historical tails scan ahead; live tails consult the
  controllers map). Without this, the UI would freeze a resumed run's
  event panel at the old failure. The converse, added 2026-10-09: a log
  with NO terminal event and no controller is a stale run, and a live
  tail of it CLOSES (`TailOpts.live`, consulted at EOF before any
  terminal event) with `done { status: "stale" }` instead of following
  forever — a peer's `strut/run-workflow` waits on that tail
  (plans/federation.md §2.2). A step that waits on something outside the
  process journals its handle at launch (`<path>#launch`) and reattaches
  on re-execution: in-process a child dies with its parent and relaunch
  is right; across struts the child survives and relaunch is wrong.
- **`from`: forced invalidation (the "re-run from this step" gesture).**
  Resume accepts an optional step path: that path, its transitive
  dependents, and its iteration children are DROPPED from the journal
  before replay, forcing re-execution even though they completed. This
  covers the step that returned garbage without erroring (a judge that
  produced empty criteria, a fetch that 200'd with an error page).
  With `from`, even a successful run is resumable — "re-grade from
  candeval onward" costs the grades, not the memo.

UI: a failed run's view offers **Resume** (retry the failed step, on the
active version — §5.4); a step node's flyout offers **Re-run from here**
(resume with `from: <path>`, on the active version too). Both show what will replay vs re-execute before
confirming — the journal makes that computable upfront. Resume CONTINUES the original run: it
appends to the same JSONL (after a `run.resumed` marker event) and keeps
the runId — critical because artifact directories are keyed by runId
(`artifacts/<runId>/...`): a drafted memo written before the crash is
still on disk at the path the journaled outputs reference. A fresh-runId
"resume" would silently dangle every recorded `outputDir`.

**Nested runs.** A parent step that launched a child run
(meta/run-workflow, optimizer.run) either has a journaled output — child
completed, replayed, child untouched — or doesn't, in which case the
step re-executes and launches a FRESH child run (the interrupted child's
partial log remains on disk as history; v1 does not recursively resume
children — see Non-goals for why not yet).

**Iterative code steps.** A step like `harvey/evolve-loop` is one DAG
step wrapping N generations; all-or-nothing replay would forfeit
completed generations. Such steps already emit per-iteration synthetic
`step.end` events (`…/evolve#3`) carrying full outputs. Contract: the
runner hands the step its own journal slice (`ctx.journal`: path →
output, scoped under the step's path); the step reconstructs completed
iterations from it and continues from the first missing one. Steps that
ignore `ctx.journal` just replay coarse (whole-step or re-run) —
correct, merely less thrifty.

**Agent steps.** v1: an agent step with no journaled output re-runs its
whole session (bounded loss: one step). Future: journal the message
transcript per tool call and resume mid-session — deliberately out of
v1, it drags in provider-state questions the rungs below don't need.

**Validity guards.** Resume refuses when: a live controller exists for
the runId (it's not dead, pause it instead); no stored version of the
workflow matches the content hash the run executed (recorded at
`run.start`, and again on every durable `run.resumed` — replaying
outputs into a DIFFERENT DAG is undefined; power users may override with
an explicit flag, and a resume that names a `version` compares the two
DAGs instead, §5.4). When the
ACTIVE version's hash differs but an older or pinned version still
matches, resume runs against that version — a long run must not
dead-end on "content changed" just because someone published since; or the run
finished successfully with no `from` invalidation (§5.2 — `error` and
`cancelled` runs ARE resumable). Registry drift (a custom step edited
between crash and resume) is allowed but WARNED — steps re-executing
post-resume use current code, same as any new run.

**API/UI.** `POST /workflows/:name/runs/:runId/resume` with optional
`{ from: <stepPath> }` (§5.2). Valid on controller-less runs that are
summary-less ("stale" — crashed), `error`, or `cancelled`; a `success`
run needs `from`. UI: the "stale" badge becomes a Resume affordance.
This retroactively gives "stale" a purpose: it is (part of) the set of
resumable runs.

---

### 5.4 Resume onto another version — a fix reaches the run

IMPLEMENTED (2026-11-05). Without it a durable resume always goes back to
the version the run executed, so a run that failed on a bug in the
workflow's YAML fails the same way on every resume, after replaying
however many hours of steps came before it. Fixing a custom step's code or
a subflow's workflow already reached the run (both load fresh at
relaunch); fixing the workflow itself did not.

`POST …/resume { version: "active" | "vN" }` resumes onto that version.
The two versions are compared step by step (`changedSteps`,
`src/journal.ts`): a top-level step of the target that is new, or differs
in any part of its definition — type, config, its dependencies as the
runner reads them (implicit ones too, so a reorder counts), `when`,
options — or reads a `params` default that changed, is CHANGED; a change
of the workflow's `settings` changes every step. The changed steps and
everything downstream of each are dropped from the journal
(`invalidateSteps`); everything else replays. `from` still applies, on
top. A subflow's child is not compared: it runs whatever version it
names, as on any resume. When the version the run executed is no longer
on record, nothing can be compared: refused (409) unless `force`, which
replays the journal into the target as it is.

The resumed run's `run.resumed` records the version it continues on
(`workflowHash`) and the steps that re-run because they changed
(`changed`); the newest durable `run.resumed`'s hash is the run's version
from then on (`executedWorkflowHash`): what a later resume — boot's
included — goes back to, what the summary, the verify pass and the
graph's `StrutRun` record. Boot's auto-resume never moves a run: it names
no version. A person does: the UI's Resume and Re-run from here send
`version: "active"`, and so do the builder's `resume_run` and
`meta/resume-run` unless told otherwise (`version: "run"` there keeps the
run's own).

### 5.5 What used to leave a run stale

A run with no summary and no controller lists as `stale`. Three ways a
run got there without a crash of the machine, and what happens now:

- **An error a step lets escape** — thrown inside a callback (a timer, an
  event listener, an emitter's `error` with no listener) or from a
  promise the step never awaits. Nothing the runner awaits sees it, and
  Node's default is to end the process: every run in flight was cut off,
  and boot's auto-resume replayed the run into the same crash until its
  cap (5) left it stale. Now each step's `run()` — and each tool-step an
  agent calls — runs inside an AsyncLocalStorage scope
  (`guardEscapes`, `src/escaped-errors.ts`), and createStrut installs
  process handlers (`installEscapeGuard`; `escapeGuard: false` to leave a
  host's process alone) that find the scope of the work that failed and
  fail THAT step with the error: retry and onError apply, the run ends as
  an error, the process keeps serving. A tool-step's escape fails the
  tool call, which the model reads. An escape after its step finished,
  or with no step behind it, is logged.
- **A throw past the runner's own handling** — a store write that fails
  while the run records its end. `runWorkflow` now settles the run before
  rethrowing (`settleUnfinishedRun`): a `run.error` with the error unless
  the log already ends, then the summary.
- **A launch that failed before the runner ran** — for a resume, after it
  cleared the run's summary. The launcher settles it the same way, which
  puts back the end the log already had.

### 5.6 Rung 4 — Parked runs: a run that waits outside memory

Pause holds a run in memory, and a step that awaits a promise for days
does too (about 42 KB a run, lost at a restart, and the drain never goes
idle). A run that waits for something outside it — a person's answer
(plans/human-steps.md) — PARKS instead: it leaves memory, and comes back
by the durable resume of §5. Code: `src/park.ts`, the runner, and the
wake in `createStrut`.

**A step parks** with `ctx.park(on)`, `on` = `<prefix>:<id>` (the prefix
lowercase letters): it throws a `ParkedError`, detected structurally like
`CancelledError`. The step runs again from the top when the run wakes, so
it must find what it started (by `ctx.runId` and `ctx.path`) instead of
starting it twice.

**The runner.** A park is neither the error path nor a cancel: no retry,
no `onError`, no `step.error`. `executeStep` emits `step.parked { path,
on }` and rethrows. Dependents of a parked step stop with it; other
branches run to their end (the DAG already settles every branch), and the
flow's outcome is the worst of its branches — an error, else cancelled,
else parked, waiting on every parked branch's targets. A `foreach` does
not stop at a parked iteration: the pool goes on, and it parks at the end
on every iteration that did, so a foreach over 100 items makes its 100
waits in one pass. A `loop` parks at the iteration that parked; a
`subflow` passes a park through (same run). On a parked outcome
`runWorkflow` appends `run.waiting { on }` — not terminal — writes the
summary with `status: "waiting"` and `waitingOn`, and returns `{ runId,
status: "waiting", waitingOn }`. Teardown runs with `RunEndInfo.parked`:
per-run resources go as at any end.

**A cancel beats a park.** A parked branch has no next checkpoint, so a
cancel that reaches a live run after the last checkpoint of every branch
still open — the woken run cancelled while its parked steps run again is
one way — would otherwise end it `waiting`. `runWorkflow` reads the run's
controller on a parked outcome: cancelling, the run finalizes `cancelled`
(`run.cancelled`, never `run.waiting`), and its teardown carries what the
parked branches waited on (`RunEndInfo { status: "cancelled", waitingOn }`)
so each target's source is told (`cancelled(on)`), as for a cancel of a
waiting run: the `task` source closes the run's open tasks. (A cancel after
every branch FINISHED still ends `success`: the work was done.)

**Where a park fails the step instead** (`park_refused:`, an ordinary
error) — wherever nothing could wake the run: a prefix no source
registered, a single-step run (`runSingleStep`'s `noPark`), a public run,
and an agent's tool call (a turn cannot be resumed mid-loop, §8). A step
that must not START what it would wait on there asks first:
`ctx.parkRefusal(prefix)` is the reason `ctx.park` would give for a target
of that prefix, or undefined (the `human` step makes no task, SPEC §4.1.9).

**The wake.** A source registers under its prefix in the process
(`strut.parking.register(prefix, { settled(on), cancelled?(on, run) })`)
and gets `{ wake(workflow, runId) }`. strut's own is the task store,
`task` (the `human` step, SPEC §4.1.9): a task that leaves `open` wakes
its run, and a cancel of the run cancels the task. A wake is the durable resume of §5
on the run's own version, its `run.resumed` marked `woken: true`:
- **Coalesced:** wakes for one run within `wakeDelayMs` (1 s) are one
  resume.
- **Held while live:** a wake that arrives while the run executes (another
  branch still running, or already resumed) is applied when the run next
  parks or lets go of its controller. During a drain it waits for the
  drain to lift.
- **No lost wake:** after a run parks, each source is asked whether its
  target already `settled`, and the run is woken at once if one did.
- **Across a restart:** strut keeps the waiting runs on file
  (`<dataDir>/parking/`, one file a run, until it really ends; memory
  where the run store is). A source's registration asks it about every
  run waiting on its prefix, so a settle no process woke for wakes at the
  next boot — a source keeps no wake bookkeeping of its own.
- **A crash while parking** (after `run.waiting`, before the summary)
  leaves a cut-off run: boot's auto-resume resumes it, and its steps park
  again on what they made.
- **Not counted:** the crash-loop guard of §5.3 skips `woken` resumes.
- A wake of a run that no longer waits (cancelled, ended, resumed by
  hand) does nothing.

| Reader | A `waiting` run |
| --- | --- |
| Boot auto-resume (§5.3) | Has a summary: passed over |
| Controllers, `GET /runs/active`, the drain's `idle` | Not live: no controller |
| The `run.end` callback, rooms | Nothing sent until the run really ends |
| The verify pass, the graph projection, the conversation wake | Skipped (`RunEndInfo.parked`); they run at the real end |
| The scheduler's overlap rule | Does not hold back the automation's next fire |
| `POST …/cancel` | Finalizes it as cancelled at once (under the lock its wake takes), tells each source (`cancelled(on)`), and runs the end hooks a park put off |
| `POST …/resume` | A durable resume like any dead run's: a person wakes it now |
| `POST …/pause` | 409 |
| `run/get { wait }` | Answers at once: `waiting`, with `waitingOn` |

**Limits.** Per-run resources are gone after a park (a browser page, a
checkout in the run's directory): what later steps need lives in step
outputs, artifacts or a job. The log is read whole at each wake, so the
64 MB resume cap holds; a run past it stays `waiting` and the wake says
why.

**The job's hold.** A parked run lets go of its job's hold (`job/dir`, a
kept `git/checkout`; src/jobs.ts), like every per-run resource, so the job
is free for other runs while it waits. Every durable resume — a wake, a
restart's, a person's — takes it again where the step that took it
replays (`onReplay`, §6), before the steps after it run. If another run
holds the job then (launched while this one waited), the resumed run
WAITS for it to let go: it is live, its cancel and pause are looked at
every 250 ms, and it is told at once when the hold goes (`reholdJob`). It
never fails `job_busy:`, which stays a fresh launch's answer: a resume is
the same run going on.

## 6. Step-author contract (additions)

- `ctx.control?: RunController` — await `checkpoint()` inside long
  internal loops; ignore it and your step remains a coarse unit.
- `ctx.journal?: Record<string, unknown>` — on resume, your own prior
  synthetic `step.end` outputs; consume to skip completed iterations.
- Emit per-iteration synthetic `step.end` events with FULL outputs if
  you want thrifty resume (evolve-loop already complies).
- Side-effectful steps must remain safe to re-execute after a crash
  mid-step (the journal only protects COMPLETED units). This is already
  the implicit contract — retries exist — now it's explicit.
- `ctx.park?(on)` — wait for something outside the run (§5.6). The step
  runs again from the top on the wake: find what you started by
  `ctx.runId` + `ctx.path` rather than start it twice.
- `onReplay?(cfg, ctx, output)` on the step's definition — called when a
  durable resume REPLAYS the step instead of running it, with its config
  resolved as for `run`: put back what `run` held in this process's memory
  and a park or a dead process let go. `job/dir` and a kept `git/checkout`
  take the job's hold again there (§5.6). A throw fails the step. Leave it
  out and a replay stays free.

## 7. Invariants

- **Measurement discipline untouched.** Control flows through the
  runner, not the workflow surface: authors/candidates cannot pause or
  cancel anything. The one door the meta surface has is
  `meta/resume-run` (2026-11-05, §5.4): it resumes a run of a workflow
  the surface could run anyway — never a sealed one (a grading
  harness), and only a run billed to the calling run's principal — so
  a builder that fixed what a run failed on finishes that run instead of
  starting it over. The grader and the §6-EVOLVE_SPEC firewalls are
  unaffected.
- **Terminal statuses are honest.** `cancelled` is never conflated with
  `error`; replayed steps are `step.replayed`, never fake `step.end`
  timings; paused gaps are visible in the log.
- **`runWorkflow` stays the single choke point.** All three rungs live
  in the runner + the launch sites; no per-step-type special cases
  beyond the opt-in contract in §6.

## 8. Non-goals (v1)

- Preemptive freezing of in-flight LLM calls/subprocesses, or process
  snapshotting (CRIU-style).
- Recursive resume of interrupted CHILD runs (parent re-launches fresh;
  a child's completed work is recoverable in a later iteration by
  making optimizer.run/meta-run-workflow journal-aware).
- Mid-session agent resume (transcript journaling).
- Cross-machine migration of paused runs.
- Scheduling/quotas ("pause when spend exceeds $X") — trivially layered
  on `pause()` later, out of scope here.

## 9. Rollout

1. RunController + registry + tree linkage; cancel; `cancelled` status;
   UI button. (Subsumes today's `activeRuns`/`trackRun`.)
2. Pause/resume + agent tool-loop checkpoint + paused/quiesced surfacing.
3. Content-hash recording at `run.start` (ship early — resume needs
   history to exist); journal replay; `ctx.journal`; evolve-loop
   iteration resume; failure-resume + `from` invalidation (§5.2); UI
   resume-from-stale, resume-failed, re-run-from-here.

Each rung lands with runner tests (cancel/pause mid-DAG, mid-foreach,
mid-retry; resume replay correctness incl. skip/gate reconstruction) and
one lab-level integration: cancel a nested optimizer run; pause/resume
an agent step between tool calls; resume a killed two-generation evolve
run and verify generation 0 replays for free.
