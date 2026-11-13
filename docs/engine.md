# The engine: workflows, steps and runs

How a workflow is loaded, run, journaled, resumed and stored; the step registry, the core steps, and the services bag steps build on.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| Engine      | TypeScript (Node 22+), Zod for schemas, custom expression evaluator        |
| Persistence | One interface per layer — `WorkspaceStore` (workflows/steps), `RunStore` (runs), `ChatStore`, `SecretStore`, `SessionStore` (agent sessions) — with File + Memory impls; local blobs (artifacts/cassettes/shell scratch) live under an explicit `dataDir` |

## Artifacts (per-run files)

`ctx.services.artifacts` (`ArtifactsCapability`, `capabilities.ts`) is per-run
file storage for the files a run produces that later steps — and humans —
reference. Backed by `fileArtifactsCapability` rooted at
`<workspace>/artifacts/<runId>/`, auto-injected by `createStrut` (a consumer
services bag can override it, same as `http`/`secrets`).

- **Convention:** a step writes a file (`write(ctx.runId, relPath, content)`)
  and puts the RELATIVE path in its output; downstream steps resolve it via
  `read`/`dir`. Enforced from 2026-10-30: a step output over
  `STRUT_STEP_OUTPUT_MAX_BYTES` (8 MB as JSON) fails the step with this
  convention in its error (`src/output-cap.ts`). Point an `agent` step's `cwd` at `dir(ctx.runId)` and the
  built-in file tools (`str_replace_based_edit_tool`, `bash`) see the same
  files — that's how agents in a workflow hand files to each other.
- **Isolation:** paths are guarded per run — a relPath cannot escape its
  run's directory (so one run can't reach another's files). Invalid runIds
  (path separators, `..`) are rejected.
- **Retention:** artifacts survive the run (they're part of its record);
  `onRunEnd` does not touch them.
- **HTTP:** `GET /artifacts/:runId` lists (recursive relative paths) and
  mints the run's **file token** (`token`, when there is a secret to sign
  it: `STRUT_API_KEY`, else `STRUT_SECRET_KEY` — never its dev default);
  `GET /artifacts/:runId/<path>` serves the file (minimal content-type map).
  Read-only — steps are the only writers. Behind the key like every route,
  or behind the token: a read of the listing or any file under it with
  `?t=<token>` opens (`carriesFileToken` in the gate), which is what the
  UI's links carry — a browser cannot set a header on an `<a>`, an `<img>`
  or a frame, and the key must never ride in a URL a served page can read.
  The token is an HMAC of the scope under the secret (`fileToken`,
  `auth.ts`): no store, rotates with it, worth exactly that run's files. The
  UI fetches it once per run (`web/src/use-artifact-url.ts`); when the
  listing minted none (a strut with no secret behind a host's gate that
  takes its credential as `?key=`) the link carries the key as it used to.
  `/jobs/:id/files` is the same for a job. **A `?t=` strut cannot vouch for
  is refused by every file route whatever the gate's mode**
  (`carriesBadFileToken`), so a host gate in front of an open strut (mcp's
  `/lab`, which derives `STRUT_SECRET_KEY` from its `API_TOKEN`) hands a
  token-bearing file read straight through and strut judges it.
- **An artifact is untrusted content on strut's own origin** — a step or an
  agent wrote it, and the UI keeps the API key in that origin's storage. So
  the file route answers with `Content-Security-Policy: sandbox` and
  `X-Content-Type-Options: nosniff` (`artifactHeaders` in `createStrut.ts`):
  opened as a document — the "Open in new tab" link, a pasted URL, a frame
  — it gets an opaque origin, so it cannot read the UI's storage, navigate
  the top window, open a popup, submit a form, or send its URL as a
  referrer. An `.html` file read by its file token also gets
  `allow-scripts` (the viewer's frame is `sandbox="allow-scripts"` too), so
  a page an agent built runs — a script can read its own URL, and all it
  finds there is that token. Read any other way — the key as `?key=`, a
  host's own credential in the URL — it runs no script: strut cannot know
  what else that URL holds. Never add `allow-same-origin`: that would hand
  the page the storage.
  Everything else runs no script (an `.svg` opened as a document could).
  Sandboxed unless exempt, so a type added to the map is covered; the one
  exemption is `video/*` and `audio/*`, which cannot script and whose
  player, in a tab of its own, cannot load the file from an opaque origin.
  `Access-Control-Allow-Origin: *` on the file route lets a page `fetch` a
  sibling file (its data) from its opaque origin — the token gates the read,
  not the origin. The header only applies to a document, not to an `<img>`
  / `<video>` / `fetch`.

## Shell (subprocesses)

`ctx.services.shell` (`ShellCapability`, `capabilities.ts`) runs a program and
returns a plain `{ code, signal, stdout, stderr, truncated, timedOut,
durationMs }`. It is the sanctioned way for a step to shell out — the `exec`
core step is a thin wrapper, and a custom step wrapping a CLI should call it
rather than `child_process` (same reasons as `http`: cassette-recordable,
and the child env is scrubbed by construction).

- **`exec` step:** `cmd` + `args`, no shell (templated values are never
  re-parsed; `cmd: bash, args: ["-c", …]` for a pipeline). `script` writes
  inline source into the working dir and appends its path — `cmd: uv,
  args: [run]` + a PEP 723 header is how a workflow runs Python with
  dependencies installed on the fly (uv caches the env; no Dockerfile edit).
  `cwd` defaults to the run's artifact dir so files flow between exec/agent
  steps by relative path. `stdin` pipes a string or JSON in; `parseJson`
  parses stdout. Non-zero exit throws (retry/onError apply) unless
  `allowFailure`.
- **Secrets:** `secretsEnv` (same contract as the agent step's) resolves
  names via `ctx.services.secrets` into the child env only, and masks the
  values out of stdout/stderr. Missing names throw — a deterministic step
  can't degrade gracefully the way an agent can.
- **Cancel:** the step polls `ctx.control.state` while the child runs and
  SIGTERMs the process group (SIGKILL 2s later) when the run starts
  cancelling, then `checkpoint()` raises the canonical `CancelledError`.
  Timeout (default 10 min) is SIGKILL. A process the command left running
  in its group (a server it put in the background) is killed when the run
  ends (`runProcess`'s `onLeftover` → `ctx.onRunEnd` → `killGroups`).
- **Output:** each stream is capped (default 500k chars) keeping head + tail,
  so a JSON result and the error that ended a build both survive; the child
  is NOT killed for being chatty. Big results belong in artifact files.
- **Environment ≠ step:** what's on PATH (python, ffmpeg, yt-dlp) is the
  deployment's business — the Dockerfile / `env.manifest` (EVOLVE_SPEC §4)
  on servers, the host's PATH on desktop. The step just spawns.

## Key concepts

- **`services` bag** is a consumer-defined capabilities object exposed to
  every step via `ctx.services` (typed by `defineStep`, untyped at
  runtime). Inject env-specific implementations (Neo4j vs in-memory,
  real vs fake LLM) without touching workflows or the registry. Threaded
  through `createStrut({ services })` / `strut.run(wf, input, { services })`
  / `runWorkflow(flow, input, registry, { services })`.
  - **`services.onRunEnd(runId)`** — an OPTIONAL generic per-run teardown
    hook the runner calls in a `finally` around `executeFlow` in
    `runWorkflow` (so it fires on success AND error, for every run path,
    once per top-level run; a throw in it can't mask the run result). Lets a
    services bag dispose per-run resources keyed by `runId` (e.g. mcp `/lab`'s
    gitsee browser + booted docker stack). A hard `SIGKILL` still skips it
    (in-process `finally`), so that case stays out-of-band.
  - **`services.onRunEvent(workflow, event)`** — the per-EVENT twin: an
    OPTIONAL bag hook the runner awaits at every emit, after the event is
    in the log, for a listener set once for the deployment — createStrut's
    events sink (`src/events-sink.ts`, `STRUT_EVENTS_SINK`) chains onto a
    host's own. Guarded: a listener that throws is logged, never the run's
    failure. A host's own listener gets the FULL event (transcripts
    included — it is in-process); what leaves the process is the sink's
    envelope.
  - **`ctx.onRunEnd(fn)`** — the same hook for a STEP (plans/code-change.md
    §3.1): a run-scoped disposer list (`Exec.disposers`, one per run, shared
    by subflow frames and an agent's tool-call steps), drained newest-first
    in that same `finally`, each guarded, BEFORE the bag's `onRunEnd`. For a
    lib/custom step that allocates something that must not outlive the run
    and cannot reach the consumer's bag — `git/checkout` removes its worktree
    with it. Absent outside the runner, like `registry`.
  - **`services.dataDir`** — the deployment's data dir on the standard bag
    (set by `createStrut`), for steps that keep local blobs of their own
    beside artifacts and cassettes (`git/*`'s cache + worktrees). A bare
    in-code bag may lack it; steps fall back to the OS temp dir.

- **`ctx.registry`** — the step registry, populated by the runner in
  `dispatchStep`. Lets a step that orchestrates OTHER steps look them up by
  type without being promoted to a runner-handled container step — the seam
  the `agent` step uses for `agentTools` ("tools are steps"). Optional (absent
  outside the runner, e.g. unit tests); read-only by convention.

- **`createRegistry(steps)`** builds a registry from in-code step defs
  layered on core + lib (no filesystem custom/ discovery) — the
  library-usage counterpart to `buildRegistry(customDir)`. User
  steps may shadow core/lib steps (with a warning); duplicates throw.
  Like `buildRegistry`, it imports every lib step *file* at build time
  (cheap: schema + metadata only) — heavy SDK deps load lazily in `run()`
  per the "Lib step dependency convention".

- **Workflows are YAML**. One format everywhere — no `.ts` workflows,
  no JSON workflows. The API accepts either a `steps` array (server
  serializes to YAML) or a raw `yaml` string. Files are stored as
  `<version>.yaml` in the workflow directory. `js-yaml` for parsing.

- **`params` = the experiment surface.** A workflow may declare a
  top-level `params:` block of tunable default knobs (prompts,
  thresholds, sample sizes). Step configs reference them via
  `{{ params.* }}`, parsed in `workspace.ts:loadFlowYaml` and seeded
  into runner scope as `{ ...flow.params, ...runOverride }` (see
  `executeFlow` in `runner.ts`). A `{{ params.x }}` inside another
  param's value is resolved once at load, from the defaults
  (`resolveParamSelfReferences`); one naming a param the workflow does
  not declare is left as written, so a prompt param can teach the
  syntax. Deliberately distinct from `input`:
  `input` is the run *subject* (validated, no defaults), `params` is
  *how* it's processed (all defaults, sparsely overridden per run via
  `POST /run { params }` / `runWorkflow({ params })`). Override
  precedence: step Zod `.default()` < `params` default < per-run
  override. Subflows use their own `params`; the parent override does
  not propagate — a `subflow` step's own `params` config overrides the
  child's defaults for that call (a run's keyed `paramOverrides[child]`
  still wins). This is what lets overnight experiments sweep 100
  prompt variants as 100 **runs** (logged in `run.json`) rather than
  100 workflow versions — promote a winner by editing the `params`
  default and publishing one new version.

- **`input:` = the declared run payload (optional).** A YAML workflow may
  declare a top-level `input:` block — `name: { type: string|number|boolean|json,
  required?, default?, description? }`, required unless it has a `default` or
  says `required: false` (`src/input-block.ts`). `flowFromYaml` turns it into
  the flow's Zod `input` schema (the runner already validates against it
  before any step runs; unknown keys are dropped) and keeps it on
  `Flow.inputBlock`, which `GET /workflows/:name/flow` returns as `input` and
  the Run popover builds its form from. Absent: `z.any()` as before, and the
  popover infers the form from `{{ input.* }}` references (`web/src/run-inputs.ts`).
  Either way the steps' schemas are consulted for one more thing: an input
  that `graph/graph-get` resolves BY NAME (`name: "{{ input.x }}"` with a
  `node_type` that is a literal or a `{{ params.X }}` the params answer) is a
  node name, and ConfigField offers a typeahead over `GET /graph/names?type=&q=`
  for that type (`GraphReader.namesLike`: a case-insensitive name-contains
  read, prefix matches first — not the fulltext search, whose whole-word +
  fuzzy matching answers "Med" with "Medical", never "Medicine";
  `nodeLookups` / `applyLookups`; `FieldDesc.nodeType`). The step
  declares which field is a name and which sibling holds the type —
  `.meta({ lookup: { typeField: "node_type" } })`, passed through
  `zodToFields` as `FieldDesc.lookup` — the YAML declares nothing, and the
  UI picks the read it calls, never the workflow. Free text stays.
  A bad block fails the publish (`assertValidWorkflowYaml`, every backend), so
  it never hides a workflow behind a load error.

- **DAG execution via `depends`**. Steps have an optional `depends`
  field (`string | string[]`). If set, the step waits for those
  dependencies before running. If omitted, the step implicitly
  depends on the previous step in the array (sequential by default).
  `depends: []` means no dependencies — the step runs immediately
  in parallel with others. The runner launches all steps via
  `Promise.all`, each waiting on its own deps internally.

- **No `parallel` step type**. Parallelism is expressed purely via
  `depends`. Two steps with the same `depends` run concurrently.
  A downstream step with `depends: ["a", "b"]` waits for both.

- **Control flow steps** (`if`, `loop`, `subflow`) are intercepted
  by the runner before registry lookup. Their config is NOT
  pre-resolved by `executeStep` — they manage their own template
  resolution (see `SELF_RESOLVING_STEPS` set in `runner.ts`). This
  is because `loop`'s `until` references `$current` which doesn't
  exist until iteration time.

- **Expression evaluator** (`expr.ts`) is a one-pass recursive
  descent parser that evaluates as it parses. `? :`, `&&`, `||` and `??`
  SHORT-CIRCUIT as in JS: the part the operator rules out is parsed under a
  `skip` depth — syntax still checked, nothing looked up, read, indexed or
  called — so `xs.length > 0 ? xs[0].n : 0` holds on an empty list (before
  2026-11-09 both branches ran, and a builder's workflow failed its last
  step on exactly that). The static validator checks a skipped part's roots
  like any other. No function calls in v1.

- **The global regex issue**: `TEMPLATE_RE` is a module-level
  `/g` regex. `resolveTemplate` uses a non-regex check
  (`indexOf("{{")`) for the single-expression fast path to avoid
  the greedy backtracking bug with multi-segment templates.

- **Templates must be quoted in YAML.** A value starting with `{{`
  is parsed by YAML as a flow-mapping, so `pull_number: {{ input.x }}`
  silently becomes an object (`{ "[object Object]": null }`) → the step
  fails with a baffling "expected number, received object". Always write
  `pull_number: "{{ input.x }}"`. A sole `"{{ expr }}"` still preserves
  the value's real type (number stays number). `publishWorkflow`
  **lints for this** (`workspace.ts:assertValidWorkflowYaml`, detects the
  parsed `[object Object]` corruption signature — so it doesn't
  false-positive on `{{ }}` inside block-scalar message bodies) and throws
  an actionable error instead of writing a broken workflow. The AI builder's
  system prompt also carries the quoting rule.

- **`_metadata.json`** in each workflow dir tracks versions and the
  active version. In `steps/custom/_metadata.json` it tracks
  per-step `{ active, versions, publisher? }` keyed by full
  slash-name (e.g. `"gitree/save-feature"`), where `versions` maps
  each version id (`v1`, `v2`, …) to `{ createdAt, description?, hash }`.
  The engine can run without these files but the UI needs them.

- **Custom steps are versioned** (like workflows). `publishStep`
  is keyed by content hash (`src/version.ts`) but labeled with
  sequential `vN` ids: identical content re-activates the existing
  version (no-op if already active; `{ reactivateKnown: false }` skips
  the re-activation, for a caller that wants a UI/API edit kept — strut's
  boot seeders never pass it: a seed always matches git), changed content
  publishes the next `vN`. The active version's source is materialized at
  `steps/custom/<name>.ts` (what the registry loads); every version
  is archived under `steps/_history/<name>/<vid>.ts` for rollback.
  Endpoints: `GET /steps/:type/versions`, `GET /steps/:type/version/:version`,
  `PUT /steps/:type/active`. Versioning is disabled when the registry
  is injected at construction time.

- **A workflow runs a step's ACTIVE version unless it pins one**
  (`src/step-ref.ts`). `type: clip/shout` follows the active pointer, so
  `edit_step` / `PUT /steps/:type/active` changes every workflow that
  names it on their next run — and rolling a WORKFLOW version back never
  rolls a step back. `type: clip/shout@v1` holds that workflow at v1 (custom
  steps only; the `vN` label, never a hash; `@` is reserved in step names).
  The registry stays a flat record of active defs: `resolveStep(registry,
  ref)` loads a pin through the loader `buildRegistry(customDir, {
  loadVersion })` hangs on the registry (`WorkspaceStore.materializeStepVersion`
  — the version written BESIDE the active steps, `<ns>/_<leaf>@<vN>.<hash>.ts`
  in `steps/custom/` or the graph's scratch dir, `materializePinnedStep`, so
  its relative imports resolve as the active version's: a pin holds the
  step's own file, and a helper it imports is the helper's ACTIVE version),
  cached per registry (a version is immutable), and a pin the registry
  cannot honor THROWS before the step starts — never a silent fallback to
  active. Every lookup site goes through it (runner, `agentTools` grants,
  `run_step`, `get_step`, `/steps/:type/schema` + `/source` — so the step
  editor's form is the pinned shape). Events carry the bare `stepType`
  (stats, claims, colors are pin-blind); the executed version is
  `step.start.stepVersion: { version, hash }`, the twin of
  `step.start.subflow`, which verify prefers over `run.start.stepHashes`
  (still "what was active at launch"). `closure.types` strips pins. **UI:**
  a pinned node shows a pin in its bottom-right corner (`renderPinIndicator`,
  header = the bare type); the step editor (`StepEditFlyout`) has a
  **Version** select for custom steps — *Active (vN)* writes a bare type,
  *vN — pinned* writes `type@vN` for THIS workflow's step only (a workflow
  edit → Publish), with a note when the pin differs from the active version.

- **Custom steps are loaded as `.ts` via dynamic `import()`**
  (`registry.ts:loadStepFile`), so the **host process must run with a
  TypeScript-capable loader** — fine in dev (`tsx`), but a plain
  `node build/index.js` can't import `.ts`. Hosts that serve
  filesystem custom steps in production must register a loader (mcp runs
  `node --import tsx build/index.js`). Consumers using only core/lib or an
  in-code `createRegistry([...])` don't need this. A step file is imported
  under `?hash=` — of its source and of every file it reaches by relative
  imports (`hashedUrl`, src/strut-resolve-hook.ts), the hash the resolve hook
  also puts on each of those imports — so a republished step or helper
  reaches every step that imports it at the next registry build, with no
  restart, and an unchanged file keeps its module.

- **Step registration is filesystem-based.** External services
  register steps by `POST /steps { name, code, description?, publisher? }`.
  Names may be nested (`"gitree/save-feature"` writes
  `steps/custom/gitree/save-feature.ts`) and helper files use a
  leading `_` (`"gitree/_shared"`) — these are saved and importable
  by sibling steps but skipped by registry discovery. A service
  cleans up on shutdown via `DELETE /steps?publisher=X`, which
  removes every step it owns and prunes empty namespace dirs.
  Namespaces are pure naming convention (just slashes in the name) —
  no ownership enforcement, last writer wins.

- **`buildRegistry()` returns `{ registry, sources }`.** The
  `sources` map records where each step was loaded from
  (`"core" | "lib" | "custom"`). Always use this map instead of
  guessing from the name — a custom step like `gitree/save-feature`
  has a slash but is `custom`, not `lib`. The `/steps` endpoint
  uses this map.

- **Runs are stored per-workflow** under
  `workflows/<name>/runs/<runId>/`. Run IDs are millisecond
  timestamps (not UUIDs) for natural sort order and easy
  pagination. Listing runs for a workflow is a single `readdir`;
  `GET /workflows/:name/runs` serves them a PAGE at a time (`?limit=`, 50
  by default, after `?before=<runId>`; `runsPage` in `src/runs.ts`) and
  reads only that page's summaries — a swarm's workflow has thousands. The
  sidebar loads one page and a **Load more** row; a refresh re-reads the
  newest page and keeps the older ones below it.

- **Runs launch detached; viewing is reattach-by-tail** (the
  background-job model, `EVAL_SPEC.md` §8). `POST /workflows/:name/run`
  (and `/:version/run`) does **not** stream — it kicks off
  `runWorkflow` **without awaiting it in the request** (`launchDetached`
  in `createStrut.ts`) and returns `{ runId }` (202) immediately. The
  run executes server-side and persists every event to the
  append-only `events.jsonl`; its liveness is decoupled from any
  connection (closing the client, proxy timeouts, etc. can't kill it).
  To watch a run — live **or** after it finished — open
  `GET /workflows/:name/runs/:runId/stream` (SSE). That endpoint calls
  `RunStore.tailEvents`; the file store **tails the events file**: replay
  from byte offset 0 → EOF (history), then follow appends (polling
  `intervalMs`, default 250ms) until the terminal event
  (`run.end`/`run.error`) — or, for a STALE run (no terminal event, no
  controller in this process: cut off by a crash, not resumed), closes
  at EOF (`TailOpts.live`) instead of following forever — then sends a final `done` carrying the
  RunResult. Because the append-only log is the ordered source of
  truth, the history→live join is **race-free** (read to EOF, follow
  from EOF — no sequence numbers, no dedupe), and **one code path
  serves completed and in-flight runs**. Pass an `AbortSignal` (wired
  to `stream.onAbort` on client disconnect) to stop the tail early.
  `?skip=N` (`TailOpts.skip`) leaves out the first N events — what the
  client already read from `GET …/events`, one gzipped response. SSE is
  never compressed and each event is its own frame, so the web UI's run
  select fetches the log first (one render) and tails from its length; a
  big finished run used to replay through the tail, one re-render and
  layout per network chunk (swarm38, 2026-10-03).
  `RunStore` is the FULL contract (append/finalize + listRuns/
  getRunSummary/getRunEvents/tailEvents/lastRunAt): no endpoint
  capability-gates on the concrete class. A backend without a native
  tail delegates `tailEvents` to `tailFromPolling` (re-read + index
  cursor) — `MemoryRunStore` does, so memory-mode strut has run history,
  SSE reattach, durable resume, and promotions. **Crash caveat:** in-flight *execution* is in-memory, so a
  crash mid-run loses the remaining work (the log up to the crash
  survives); true resume is a later add. The web UI's
  `api.runWorkflow` hides the two steps — it POSTs to launch, then
  `streamRun(name, runId)` reattaches to the tail — so callers see the
  same `(onEvent, → RunResult)` interface as before.

- **Run control** (`RUN_CONTROL_SPEC.md`, `src/run-control.ts` +
  `src/journal.ts`). Every launch site registers a `RunController`
  (createStrut's `trackRun` — superseding the old `activeRuns` set); nested
  launches attach to the parent's controller via `parentRunId` (set by
  meta/run-workflow + the lab's optimizer from `ctx.runId`), so
  cancel/pause apply to WHOLE SUBTREES. All control is cooperative: the
  runner awaits `checkpoint()` between DAG steps / loop+foreach iterations /
  retry attempts; the agent step checkpoints between tool calls
  (`prepareStep`); code steps with long loops opt in via
  `ctx.control?.checkpoint()`. Endpoints:
  `POST /workflows/:name/runs/:runId/{cancel,pause,resume}`. Cancel
  finalizes honestly as `status: "cancelled"` (never the error path).
  Durable resume replays the journal (`step.end` outputs keyed by path →
  `step.replayed` events, zero cost) and re-executes from the first
  incomplete path — valid for stale (crashed), error, and cancelled runs;
  a successful run needs `from: <stepPath>` ("re-run from here", which
  drops the target + transitive dependents + later loop iterations).
  `run.start` records the workflow content hash (resume refuses a changed
  DAG unless forced) and per-run params. `{ version: "active" | "vN" }`
  resumes onto that version instead (§5.4): the top-level steps that
  changed re-run with everything downstream, the rest replays, and
  `run.resumed` records the new `workflowHash` + `changed` — the run's
  version from then on (`executedWorkflowHash`). The UI's Resume and
  Re-run from here, the builder's `resume_run` and `meta/resume-run` (a
  run of an unsealed workflow billed to the calling run's principal) send
  `"active"`; boot's auto-resume never moves a run. One function behind
  all of them (`resumeRun` in createStrut). Nothing leaves a run stale
  short of the process dying (§5.5): an error a step lets escape fails
  that step (`src/escaped-errors.ts`), and a throw past the runner's own
  handling or a failed launch settles the run as an error
  (`settleUnfinishedRun`, runner.ts). Iterative code steps consume
  `ctx.journal` to resume completed iterations (harvey/evolve-loop does).
  A durable resume drops the attempt's `run.json` first
  (`RunStore.clearRunSummary`), so a summary always means the latest
  attempt finished and a resumed run reads as live everywhere. A log over
  `STRUT_RESUME_MAX_LOG_BYTES` (64 MB) is never read: the boot scan skips
  it by its size, `POST …/resume` answers 413.

- **Parked runs — a run that waits outside memory** (`src/park.ts`,
  RUN_CONTROL_SPEC §5.6, plans/human-steps.md §2). `ctx.park("<prefix>:<id>")`
  never returns: the step, and its dependents, wait; other branches run to
  their end; a `foreach` goes on past a parked iteration and parks at the
  end on all of them. Not an error (no retry, no `onError`, no
  `step.error`): `step.parked { on }`, then `run.waiting { on }` (not
  terminal) and a summary with `status: "waiting"` + `waitingOn`, and the
  run leaves memory — no controller, no `run.end` callback, no verify pass
  or projection (`RunEndInfo.parked`), not in the scheduler's overlap. A
  SOURCE registered under the prefix (`strut.parking.register`) wakes it:
  the durable resume, `run.resumed { woken: true }` (not counted by the
  crash-loop guard), on the run's own version; parked steps run again from
  the top and must find what they started by `runId` + `path`. Wakes are
  coalesced (`createStrut({ wakeDelayMs })`, 1 s), held while the run is
  live or the server drains, and checked against each source right after a
  park; the waiting runs are kept on file so a registration at the next
  boot wakes what settled meanwhile. `POST …/cancel` on a waiting run
  finalizes it as cancelled at once and tells the sources; `POST …/resume`
  wakes it by hand. A park fails the step (`park_refused:`) where nothing
  could wake the run: no source for the prefix, a single-step run, a
  public run, an agent's tool call; `ctx.parkRefusal(prefix)` asks first,
  for a step that must not start what it would wait on. The UI shows
  `waiting` on the run, an hourglass on a parked step's node, and what it
  waits on in the run overview and the step's flyout. strut's own source
  is the task store, `task`: the `human` core step (specs/SPEC.md §4.1.9)
  makes a task and parks on it, and a worker's answer, the task's expiry
  or a cancel wakes the run.

- **`RunStore.append/finalize`** take `(workflow, runId, ...)`
  — the workflow name is the first param. `MemoryRunStore` keys
  by `"workflow/runId"` internally; use `store.getEvents(wf, id)`
  and `store.getSummary(wf, id)` in tests.

- **Deleting a workflow** (`DELETE /workflows/:name`, gated; the Workflow
  flyout's footer). Three layers, in order: `automations.forget` drops its
  schedules from the tick loop, `RunStore.deleteRuns` removes its run
  records, `WorkspaceStore.deleteWorkflow` removes every version + metadata
  (`rm -rf` of the workflow directory on files; soft-delete on the graph —
  nodes stamped `deleted_at`, their edges hard-deleted — with schedules /
  owner / cap / category cleared FIRST — the node writer restores a
  soft-deleted node on a key match, so a later publish under the same name
  must come back clean; it comes back with only the edges the publish writes). 409 while one of its runs is in flight;
  the run artifacts under `artifacts/<runId>/` are not touched.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/core.ts`

flow(), step(), defineStep(), services bag, all types; the five output markers — withAccessedNodes / withMessages / withMedia / withStop / withUsage (readers accessedNodesOf / messagesOf / mediaOf / stopOf / usageOf): non-enumerable, so invisible to {{ }}, JSON, the event log and run.json. withUsage (what a step's model calls spent) is TAKEN off the output by whoever lifts it onto `step.end` as `modelCalls` / `usage` / `cost` (`takeUsage`), so a pack or subflow handing the same object on never reports it twice; `RunSummary.totals` is their sum (`tallyUsage`, store.ts)

### `src/expr.ts`

{{ }} template evaluator (recursive descent, one pass; `? :`, `&&`, `||`, `??` short-circuit — the part ruled out is parsed under a `skip` depth and never evaluated; `?.`; whitelisted array methods + arrow lambdas; every read-off-nothing error names the fix)

### `src/search.ts`

searchSteps / searchWorkflows: the one matcher behind the sidebar filters, the Add Step picker and `GET /workflows?q=` — every word must hit the name (or the category / description), name hits rank first. The web UI imports it from here

### `src/input-block.ts`

the optional YAML `input:` block → the flow's Zod input schema; kept as Flow.inputBlock for GET …/flow + the Run form

### `src/step-ref.ts`

`type: name@vN` — a PINNED custom-step version (parseStepRef / baseType); a bare type runs the active version. Events keep the bare `stepType`; the pin rides on `step.start.stepVersion`

### `src/runner.ts`

execution engine: DAG (topological), retry, onError, control flow, journal replay; each run's view of the services bag (`bindPrincipal`, `bindPeer`, `bindApp`, `bindBranch` from branches.ts, and `bindGraph` from graph-writes.ts, flushed at the run's end). A run's Concept BRANCH (`RunOptions.branch`, src/branches.ts): the launch's, else the branch of the bag it was launched with (a step's `ctx.services`, already on one — naming another is `branch_fixed:`); a branch that does not exist (`services.branches`) fails the run at its start (`no_branch:`, like an input that does not parse); recorded on `run.start` and every summary, handed to every step as `ctx.branch`

### `src/output-cap.ts`

the step OUTPUT cap (`STRUT_STEP_OUTPUT_MAX_BYTES`, 8 MB as JSON): `outputTooBig` — the error the runner throws for a step, loop or foreach iteration output over it and `wrapToolsWithEmit` for a tool result, naming the size, the cap and the artifacts convention; `fmtBytes` / `positiveBytes`, shared with the resume log cap (`STRUT_RESUME_MAX_LOG_BYTES`, createStrut.ts)

### `src/run-control.ts`

RunController: cooperative cancel/pause/resume for run TREES (RUN_CONTROL_SPEC.md); isAncestorRun reads the tree through a step's `ctx.control` (what lets a child run share its parent's job directory)

### `src/escaped-errors.ts`

an error a step lets ESCAPE (a callback's throw, a promise it never awaits) fails that step instead of ending the process: `guardEscapes` runs a step's `run()` (and each tool-step an agent calls) in an AsyncLocalStorage scope, `installEscapeGuard` (createStrut, `escapeGuard: false` to opt out) adds the process's uncaughtException / unhandledRejection handlers that find the scope and fail it; an escape no step owns is logged, the server keeps serving (RUN_CONTROL_SPEC §5.5)

### `src/park.ts`

PARKED RUNS (plans/human-steps.md §2, RUN_CONTROL_SPEC §5.6): a run that waits for something outside it leaves memory and comes back by durable resume. `ParkedError` / `isParkedError` / `mergeParked` (what `ctx.park("<prefix>:<id>")` throws; the runner's `step.parked`, `run.waiting`, the `waiting` summary with `waitingOn`), `parkPrefix`, the WAITING INDEX (`FileWaitingIndex`: one file a run under `<dataDir>/parking/` until it really ends; `MemoryWaitingIndex`) and `createParking` — the wake's bookkeeping over seams createStrut fills: `register(prefix, { settled, cancelled? })` → `{ wake(workflow, runId) }` (registering asks the source about every run already waiting on its prefix: a settle across a restart wakes at the next boot), `parked` (indexed, each target asked whether it settled: no lost wake), `released` (a wake held while the run was live goes when its controller lets go), `ended`, `cancelled` (each source told), `flush` (the drain lifted); wakes for one run within `wakeDelayMs` are one resume. `strut.parking.register` is the door; the bag's `parking` (`accepts(on)`) is what `ctx.park` asks

### `src/journal.ts`

resume journal: step.end outputs → {path→output}; `from` invalidation; `changedSteps` / `invalidateSteps` — a resume onto another version re-runs what changed (§5.4); `executedWorkflowHash` — the version a run executes now (the newest durable `run.resumed`'s, else `run.start`'s)

### `src/store.ts`

RunStore interface (writes + reads + tail) + FileRunStore + MemoryRunStore + tailJsonl / tailFromPolling. Keys are workflow names, plus two non-workflow buckets no workflow listing can see: `step:<type>` → steps/<type>/runs/ (kept run_step runs), `check:<id>` → checks/<id>/runs/ (paid check runs)

### `src/closure.ts`

what a flow can EXECUTE: walkSteps (loop/foreach bodies, onError), flowClosure (nested subflows via the workspace, agentTools grants — one read from params alone, `"{{ params.tools }}"`, is read off every params the frame may run under: its own defaults and what a subflow step hands it; any other templated grant is UNREAD, and the sealed check refuses it; templated/missing child → unresolvable), stepHashesFor → run.start.stepHashes; grantParams / grantWidenedBy — the params keys a flow's `agentTools` read are GRANTS, and a launch's `params` override (meta/run-workflow) may narrow them, never widen them, and the keys an `approve` list reads only GROW (every step the flow's own approve keys gate stays gated — a builder may not relaunch `builder` with `approve: []`): both sides expanded through the registry, every other key a knob

### `src/step-stats.ts`

GET /steps/:type/stats — the Step Info flyout's Usage: workflows whose active version can run the type (direct, or via subflow) + execution counts summed from their runs' `RunSummary.stepCounts` (written at finalize; older summaries backfilled from the log on first read) and the `step:<type>` bucket

### `src/run-step.ts`

runSingleStep (one step, in memory, optional cassette) + runStep — the run_step surfaces: settles whether the run is kept (the step has claims, or `keep: true`), records stepHashes, then persists a kept run under `step:<type>` (plans/claims.md §3); `events: false` (the app door, which reads the output alone) hands no events back and skips the step-hash read for a run that is not kept. `RunStepOptions.app` (the app door's stamp, plans/apps.md §5) → `ctx.app` for the step and `app` + `actor` on a kept run's summary

### `src/runs.ts`

RUNS as a capability (plans/apps.md §5): the contract (`RunsCapability`: list / get { wait } / events { skip } / launch { key } / cancel / workflow / files / transcript { full }) the `run/*` lib steps are thin over, built by createStrut into `ctx.services.runs` over the same layers the run routes call (the store, the controllers, `launchDetached`, `controlLiveRun`, `artifactRefs`, `readTranscript` — the transcript route's own read), and `provenance` (optional on the interface: an embedder's own may lack it) over the RAW log; here the pure parts — the list filter (`matchesRunFilter`: status, since, automation, job), the event cap (`capEvents`: 5 000, the head + the terminal event, `slimEvent`), the file result (`fileResult`: text or base64, 2 MB), the transcript cap (`capTranscript`: 2 MB of JSON — long strings cut to head + tail at 64k, then 16k, then 4k chars, then the middle left out after the system prompt and the task, never a tool result without its call; `truncated` says what went). Every method refuses a sealed workflow by name: a model's door, like the meta/* twins

### `src/provenance.ts`

the SPOT CHECK's engine (plans/spot-check.md): `buildProvenance(events, subject)` — where one thing a run made came from, read off its RAW log (tool inputs whole on `step.start`, tool outputs whole in the agents' transcripts on their `step.end`, by `toolCallId`). A subject is a `value` as shown plus, when known, an address: `cell` (a sheet range; `spreadsheet`), `node` (a ref_id), `file`. The answer is its MOMENTS, oldest first, each a tool call or step: `wrote` (into a cell — a sheet write's ranges laid out cell by cell from the top-left, so a block anchored at one cell counts — a file the editor wrote, a node a graph write named, a writing step), `used` (in a command, a query, a prompt, a step's config), `read` (out of a call, a step, the run's input); `exact` by address, else by content (`needleOf`: a number in any spelling — `$54,853` finds `54853.4413`, a percentage its ratio — a passage by up to three windows of it, quotes / dashes / a source file's escapes normalized; a value under three significant digits or six characters is followed by address only). A `wrote` or `used` call carries the agent's words before it (`why`), a write the three calls before it (`before`); a cell's formula gives `refs` + `literals`, a passage the cells it cites (`refs`) and the numbers it states (`figures`), a snippet the cells it cites (`cites`) — each a subject of its own. At most 60 moments, every exact one kept. Pure; `RunsCapability.provenance` and `run/provenance` serve it

### `src/run-view.ts`

the run VIEW the builder reads (get_run + meta/get-run, via readRun in authoring.ts): foldRun (the event log → the step tree, by path: `wf/sub/child`, `wf/each#3`, `wf/agent/042-bash`, `wf/step/onError`) + buildRunView — ONE level open (`path` picks which; that node is `focus` with its payloads), everything below rolled up (count / status histogram / by step type / last ids), the deepest errors first with the siblings before each, long lists kept head + tail + errors with `{ omitted }` gaps, previews, and a char budget (20k) that tightens in fixed levels and says so in `hint`. Size follows the DAG, never the execution; a transcript is never in it

### `src/workspace.ts`

WorkspaceStore interface + FileWorkspaceStore (alias WorkspaceManager): versioning, _metadata.json, YAML loading; `snapshot()` / `moveAside()` — the file store's half of the one-shot fs → graph import (graph/fs-import.ts). A workflow name may carry `/` (`acme/linear/sync`, `validateWorkflowName`): nested folders on disk, one URL segment encoded (`%2F`) on the wire, and the whole root of every event path (`acme/linear/sync/fetch`) — a step reads it as `ctx.workflow` (`workflowOf`, core.ts), a fold from the run's `run.*` event, never `path.split("/")[0]`. `Upstream` (plans/marketplace.md §3) on workflow, step and app versions, carried forward by every publish over the name; `activate: false` records a version without moving the active pointer; a publish of a NEW workflow or step name under an INSTALLED package's prefix is refused unless it carries that package's `upstream` (`refuseUnderInstalledPackage`: only the install adds a name there; an edit is a fork) — or the package is OPENED here as a git repo (`setOpenPackages`, createStrut over src/packages/repos.ts: its author adds items there, and a Commit writes them). `deleteWorkflow` on files removes the workflow's own files, never its `runs/` (the run store's)

### `src/storage-conformance.test.ts`

the storage boundary's spec: one suite per layer, run over every impl

### `src/capabilities.ts`

the standard services bag steps build on: http (fetch-like, plain result), secrets, artifacts (per-run files), shell (subprocesses), jobs (a job's holds, jobs.ts) — every one recordable by cassette.ts + secret-safe

### `src/extensions.ts`

the GENERIC extension points a feature registers into (no feature words in it; privacy/boundary.test.ts enforces that): `registerModelWrapper` (`resolveModel` hands every model it builds to `applyModelWrappers(model, { provider, modelId, baseUrl?, routed, ctx?, session? })` — `stepAuth(ctx, session)` carries the step's context and agent session through), `registerToolWrapper` (the agent step's `wrapToolsWithEmit` calls `applyToolWrappers(tools, ctx)` first, so every tool set — built-ins, web tools, MCP, agentTools — passes through it), `registerSetting({ key, schema, normalize? })` and `resolveSettings` / `validateSettings`: a setting is set at four levels, highest wins per key and whole — step `options.settings` > run (`POST …/run { settings }`, `RunOptions.settings`) > workflow YAML top-level `settings:` (`Flow.settings`) > deployment (the `STRUT_HOST_CONFIG` file's `settings`, `createStrut({ settings })`, on the services bag) — and arrives as `ctx.settings`; a subflow inherits its caller's workflow level and the subflow step's options (they win per key over the child's own), a foreach's or loop's `options.settings` reach its body; validate.ts checks a workflow's block. Nothing registered: every function returns what it was given. The one feature on it today is privacy (src/privacy/register.ts, imported once by createStrut): the `privacy` setting, `off | hosted | strict | { mode, mask?, detect?: { llm } }`, off by default — see "Private AI" below and specs/PRIVACY_SPEC.md §10

### `src/model-worker.ts`

a local model in a WORKER THREAD: `ModelWorker` builds an object in the worker from a named factory (`{ module, factory, options }`; entry model-worker-entry.ts) and answers `call(method, args, transfer?)` — calls start in order, buffers in `transfer` move instead of copying, the worker starts on the first call and again after it dies, and holds the process open only while a call is in flight. onnxruntime and sherpa decode synchronously, so a model on the main thread stalls every request; the embedder (`WorkerEmbedder`), the dictation recognizers (audio/decoder.ts), the speech synthesizer (audio/synthesizer.ts) and the privacy NER and LLM detector (privacy/ner.ts, llm.ts) run on it. A worker sees the environment as the env scrub left it, so a model's settings (its cache dir) are read on the main thread and passed in `options`

### `src/shell.ts`

every child process strut spawns: env scrubbing (allowlist, never process.env), runCmd/runShell (agent + builder bash tools), runProcess (the shell capability / exec step: exit code, stdin, abort → process-group kill, head+tail output cap)

### `src/index.ts`

barrel export — createStrut (primary entry), createRegistry, coreRegistry, all types

### `src/yaml.ts`

dumpYaml / loadYaml: js-yaml with strut's own dump options (lineWidth 120, no anchors), on the barrel beside `z` — for a seeded custom step, which resolves `strut` and no other package

### `src/steps/core/`

13 built-in steps: http, exec, log, if, loop, foreach, subflow, llm, agent, image, wait, human, pack (static import). `human` (plans/human-steps.md §3; specs/SPEC.md §4.1.9): a PERSON as a step — makes a task of a task type in the task store (`ctx.services.tasks.ensure`, keyed by workflow + run id + step path, so a wake finds it) and PARKS the run on `task:<id>`; open → park, settled → `{ answer, by, task }` (+ `pay: { msat, usd? }` for a paid answer, the dollars marked as the step's cost with `withUsage`, no model call: the run's totals count human work, never `maxRunCostUsd` or the Mothership — plans/human-steps.md §8.1), expired → `task_expired:`, cancelled → `task_cancelled:` (so `onError` applies; a `retry` reads the same task). `files` resolved when the task is made (src/tasks/files.ts: the job's directory on a job run, else the run's artifacts; `*` / `?` within one folder; a missing path or an empty pattern fails the step). Refused before any task is made where nothing could wake the run (`ctx.parkRefusal`: a single-step run, a public run, an agent's tool call) and in a run that may not ask a person (the trees createStrut marks `noRemoteSpend`, through the store's `refusal`)

### `src/steps/lib/run/`

run/list, get, events, transcript, launch, cancel, workflow, files, provenance (plans/apps.md §5; provenance: plans/spot-check.md): runs as STEPS, unsealed — the kit's hooks name them, an APP reaches them through `step_run` on its `grants.workflows`, an agent through `agentTools: ["run/*"]` — thin over `ctx.services.runs` (src/runs.ts). run/launch is `launchDetached` (`{ runId }` at once; `attachments` as `POST …/run` takes them, saved under the run's artifacts; `params` may narrow a grant, never widen it — `grantWidenedBy`; `key` dedupes in flight: the run still live under the same key comes back `{ runId, existing: true }`; under `ctx.app` the run records `origin: "app"` + `app` and hands `ctx.app` to its steps; `conversation` — the conversation a JOB turn belongs to, so strut wakes it — from strut's own app only, one its viewer may continue (`mayContinue`), else `conversation_not_yours:`), run/get holds up to `wait` (55 s) while the run is in flight, run/files reads one file (the job's directory for a job run, else the artifacts), text or base64, run/transcript one agent's session by step path (what `run/events`' `transcript` link names; `full` a session turn's thread), capped; run/provenance a SPOT CHECK — where a value, a cell, a node or a file's text came from in the run (src/provenance.ts) — the later Cause agent's door as much as a page's

### `src/steps/registry.ts`

auto-discovery: buildRegistry() core (static) + lib (dynamic) + workspace custom/ (dynamic); createRegistry() for in-code steps

### `src/*.test.ts`

~1700 unit tests across 97 files — the workspace-store conformance, node-writer, edge-writer, schema-resolver, claims, claims-authoring, verify, projector, search (the reader) and names suites among them, on a Ladybug file (+ the live graph tests under src/graph/ and steps/lib/graph/ against Neo4j, opt-in)
