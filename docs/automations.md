# Automations

Running a workflow on a schedule: the trigger grammar, the tick loop, and both doors.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **Automations — run a workflow on a schedule** (`plans/automations.md`;
  `src/automations.ts` pure, `src/scheduler.ts` stateful). An automation is
  `{ id, name, enabled, trigger, input, callback? }`, stored as **workflow-level
  metadata beside `category`** (`WorkflowMetadata.automations`:
  `_metadata.json` on the filesystem, one JSON-string `automations`
  property on the `StrutWorkflow` node in the graph;
  `WorkspaceStore.setWorkflowAutomations`). It is NOT in the versioned
  YAML: adding, editing or pausing a schedule publishes no version, so it
  never re-fires `on_change` checks and a rollback never changes a
  schedule. The trigger is a **closed grammar** — never cron: `interval`
  (anchored: fires are `anchor + k·minutes`, `on` / `between` filter it),
  `day`, `week`, `month` (`day` 1–28 | `"last"` | nth weekday), `once`. A
  schedule the grammar cannot express is fixed by adding a shape. ONE
  implementation of the calendar math (`nextFire`) drives the form's
  preview (`POST /automations/preview`), the chat tool's result and the
  tick loop. **Nothing but the definition is persisted**: `nextRunAt` is
  memory-only and always computed from the current time (the first load
  from process start), so a restart neither stampedes nor double-fires and
  a run missed while the process was down is skipped; the tick advances
  `nextRunAt` BEFORE launching. A fire goes through `launchDetached` like
  `POST /run`, stamped `origin: "schedule"` + `automation: { id }` on
  `run.start` AND on the `RunSummary` — scheduled runs are verified like
  any other. An automation's `callback: { url }` (opt-in, set over HTTP
  only — the chat tool never sees it) is handed to every fire, so its
  `run.end` reaches the host like a `POST /run { callback }` launch's. The
  URL is a credential, so it lives in a fifth encrypted file beside
  `secrets.json` — `automation-callbacks.json` (`AUTOMATION_CALLBACKS_FILE`),
  keyed by the automation id — never in the deployment's secrets, which
  every step reads through `ctx.services.secrets` and `GET /secrets` lists;
  the record keeps `callback: { origin }` — no read of workflow metadata (the
  routes, the graph node) can serve it. Removing the automation, clearing
  the callback (`null`) or deleting the workflow deletes the entry. **Dynamic inputs**: `input` is resolved per fire against
  `{ now, today, last }`, `last` being this automation's latest SUCCESSFUL
  run (a newest-first scan of summaries, ≤100) — so a failed run never
  advances a cursor. `last` is never null (before the first success its
  `output` is `{}`) and a top-level key resolving to `undefined` is
  dropped. One fixed overlap rule, not a setting: a fire is skipped while
  that automation's previous run is still in flight (read from the run
  store, so it holds across a restart) — two overlapping runs would read
  the same cursor. Both doors are thin: the routes and the chat tools
  (`set_automation`'s RESULT carries `summary` + `next`, so the model
  confirms from computed facts) call the same `createAutomations` layer.
  UI is per-workflow: the topbar **Workflow** button opens `WorkflowFlyout`
  (the Automate tab is `AutomationsPanel`); scheduled workflows and scheduled
  runs carry a clock badge in the sidebar.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/automations.ts`

automations, the PURE half (plans/automations.md): the record, the closed trigger grammar (zod; interval / day / week / month / once — no cron), normalizeTrigger (fills tz + the interval anchor), nextFire / nextFires (Intl-only zone math, DST-safe), describeTrigger (the human sentence), and the fire-time input scope (`now` / `today` / `last`; checkInputTemplates, resolveAutomationInput)

### `src/scheduler.ts`

automations, the STATEFUL half: createAutomations(deps) — the policy layer behind BOTH doors (list / create / update / remove / preview / fire) + the in-process tick loop. `nextRunAt` is memory-only (computed from now → missed runs are skipped, never replayed); the `last` cursor and "previous run still in flight" are read from the run store. `strut.automations`

### `src/automations-routes.ts`

the Automations flyout's HTTP door: GET /automations[?workflow=], POST /automations/preview, POST/PATCH/DELETE /workflows/:name/automations[/:id], POST …/:id/fire (Run now). Mutations + fire behind requireApiKey

### `src/steps/lib/automation/`

automation/list, preview, create, update, delete, run-now: an agent's own door onto the automations (scheduler.ts), through `ctx.services.automations` — scoped to the ONE workflow the host names (`createStrut({ automation: { workflow, approve } })`, STRUT_HOST_CONFIG's `automation`), never another workflow's schedules; the run is handed `{ name, prompt, since: "{{ last.finishedAt }}", now: "{{ now }}" }` (the person's `{{`/`}}` kept apart by a zero-width space). The acting four first run the host's APPROVAL step (`{ intent: { action, content?, details? } }` → `{ approved }`, or a withStop output that the step passes up, ending the turn with nothing changed), refuse without one, and journal what they did so a resume never acts twice. A host whose approval step grants more than the prompt (`automation.grants`: Peel's posting as the person) gets a `grant` on create and update: strut never reads it, hands it to the approval step with the automation's ID and name (the id minted BEFORE the card, `automationId`, the same for the same call, given to `create`), and the host keeps what it allowed under that id; a change, run-now or delete card names the automation the same way (the host lets a deleted one's grant go). At each fire the runner hands every step `ctx.automation` (set by the scheduler's launch alone — a `POST …/run` or `meta/run-workflow` body cannot), which is where a host step acting on the grant names the automation; nothing rides in the input. An automation made from a turn inherits the root run's callback, as job/start does

### `src/steps/lib/meta/set-automation.ts`

the builder job's schedule for a workflow it published: only on one whose ACTIVE version the meta surface wrote (`source: agent`, `aiWrote`), and only as a proposal a person accepted (`ctx.proposal`, set by the apply alone) — a tool call, DAG step, meta/run-step or subflow is refused, so the host lists it in the builder's `approve:`; a proposal of it waits (`StepDef.after`, 409 on an early accept) for a pending `meta/publish-workflow` of the same workflow. Create, change, pause, remove by id; its fires report where the proposing run does, else nowhere until the host points them
