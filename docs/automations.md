# Automations

Running a workflow on a schedule: the trigger grammar, the tick loop, and both doors.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **Automations — run a workflow on a schedule** (`plans/automations.md`;
  `src/automations.ts` pure, `src/scheduler.ts` stateful). An automation is
  `{ id, name, enabled, trigger, input, callback?, package? }`, stored as **workflow-level
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
- **Schedules a package ships** (`schedules:` in strut.yaml; docs/packages.md,
  specs/API.md §16; stadeum plans/software.md §5 item 3). An entry is an
  automation's draft (`name?`, `trigger`, `input?`) with the package's own
  `workflow` — the grammar above, so strut has one "how often". Each is an
  ORDINARY automation in the same metadata list, marked `package` (set by
  the sync alone; no door's body carries it) with the id
  `packageAutomationId(package, name)` (`a-` + 8 hex of sha256 of
  `<package>\n<name>`), so a restart, a reinstall or a restored backup finds
  the one it made. `syncPackageSchedules(shipped, keep)` makes the marked
  automations exactly what the installed packages ship
  (src/packages/schedules.ts reads them): it makes what is missing (on),
  follows a release's trigger, input and name (an interval keeps its anchor
  while it stays one: `triggerFrom`), drops what no package ships any more,
  a duplicate, or one on the wrong workflow, and never touches an automation
  no package made (one under a shipped id is left alone, with a warning).
  createStrut runs it once at boot, before `start()`, and after every package
  write (`oneAtATime`). THE RULE for an admin: on or off is theirs, and a
  release keeps it; the name, the trigger and the input are the package's —
  a PATCH that would change them (or set a callback) is refused, and so is a
  DELETE (a release would only make it again: pausing is how it stops); for
  another rhythm or input, pause it and add an automation of one's own. Both
  doors and the `automation/*` steps share that one layer. The Automate tab
  shows the package, the toggle and Run now, and no Edit or Delete.
- **Whom a fire runs as** (`runsAs`, src/workspace.ts; the scheduler's
  `personFor`) — the one rule for a run nobody launched (stadeum
  plans/software.md §5 item 15: every token is a person's): it acts as its
  workflow's OWNER, with their secrets and on their bill, and as nobody
  else. The owner is whoever brought the workflow in as a person — their
  install (`InstallOptions.actor` owns the new workflows), their
  subscription (docs/packages.md: the `PUT`'s actor installs every release
  as them), their publish — or whom an admin gave it to (`PUT
  /workflows/:name/owner`, `POST /actor/claim`); a release keeps it, an
  admin's choice included. Every fire passes that owner to `launch` as
  `principal`: `run.start` carries it and no `actor`, and its steps read
  secrets as any run of theirs (`get`: theirs, else the deployment's, else
  env; a package step's `secrets.own` theirs; never `secrets.deployment`).
  With no owner a PACKAGE's schedule launches nothing (set up by nobody: the
  distro's or a boot install, a subscription nobody made, an install with
  no actor), and so does any automation where the deployment requires
  someone to bill (`principalRequired`, which `ownerGate` still checks at
  create and update): `nobody to run as: …`, saying what to do, is the
  fire's error and `lastFireError`. The list says it before anything fires
  (`AutomationView.nobodyToRunAs`), beside whom it runs as (`runsAs`); the
  Automate tab shows both ("Runs as alice", "It cannot run yet: …"). An
  automation a person made, on a box that bills nobody, still runs as
  nobody when its workflow has no owner, as it always has.
- **A schedule for each person** (`each`; stadeum plans/gmail.md §7 item
  2). A package's schedule may name a secret the package provides:
  `each: GOOGLE_TOKEN`. Each fire then launches one run for each person who
  holds that secret as their own, as that person, and not as the owner:
  their secrets, their bill, `principal` on `run.start`, `origin:
  "schedule"` and the automation's id. Who holds it is
  `ActorSecretStore.holders(name)` (src/actor-secrets.ts): the actors with
  an `A_<hex(actor)>_<NAME>` entry, never a value, and never the
  deployment's value, which is nobody's. With nobody holding it a fire
  launches nothing, and that is no error. Each person's `last` is their own:
  their latest successful run of it (the summary's `automation.id` and
  `principal`). The overlap rule is each person's too: a person whose
  previous run is still going is skipped, and the others run; Run now is
  refused (409) only when everyone is. A run that cannot start for one
  person is said in `lastFireError`, and the others still start. The scan
  for a person's `last` reads 100 runs for each person, so a cursor looks as
  far back as a single automation's does. The record carries `each`, set by
  the packages' sync alone (no door's body takes it). The list shows
  `people`, how many hold it now, in place of `runsAs`; `lastRun` and
  `running` are any person's. The Automate tab says "Runs as each person
  with GOOGLE_TOKEN · 3 now". On or off is still the admin's, for everyone's
  runs at once, and needs no owner. Nothing here names a domain: a Calendar,
  Outlook or Slack package uses the same key.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/automations.ts`

automations, the PURE half (plans/automations.md): the record, the closed trigger grammar (zod; interval / day / week / month / once — no cron), normalizeTrigger (fills tz + the interval anchor), nextFire / nextFires (Intl-only zone math, DST-safe), describeTrigger (the human sentence), and the fire-time input scope (`now` / `today` / `last`; checkInputTemplates, resolveAutomationInput)

### `src/scheduler.ts`

automations, the STATEFUL half: createAutomations(deps) — the policy layer behind BOTH doors (list / create / update / remove / preview / fire, and `syncPackageSchedules`, the packages' schedules made exactly) + the in-process tick loop; whom a fire runs as is `runsAs` (src/workspace.ts), through `personFor`, and the list shows it (`runsAs`, `nobodyToRunAs`); a schedule for each person (`each`) fires once for each holder of its secret (`deps.holders`, `fireEach`), each with their own `last`, and the list shows how many (`people`). `nextRunAt` is memory-only (computed from now → missed runs are skipped, never replayed); the `last` cursor and "previous run still in flight" are read from the run store. `strut.automations`

### `src/automations-routes.ts`

the Automations flyout's HTTP door: GET /automations[?workflow=], POST /automations/preview, POST/PATCH/DELETE /workflows/:name/automations[/:id], POST …/:id/fire (Run now). Mutations + fire behind requireApiKey

### `src/retention.ts`

the run-retention sweep (docs/engine.md "Retention"): started right beside `automations.start()` in `createStrut` (same `scheduler` option / `STRUT_SCHEDULER` switch), once at boot and then hourly, its timer unref'd and stopped by `close()`. Evicts finished runs' logs per the workflow's `retain:` or `STRUT_RETENTION` (first named `STRUT_RUN_RETENTION`, still read); never a running, waiting, kept or artifact-referenced run (claim evidence does not hold one), and logs `[retention] evicted N run log(s): …` when it evicts. With an archive (`RetentionDeps.archive`, docs/engine.md "The archive tier for run logs") the same pass uploads first: it asks the bucket's check, uploads finished runs' logs within the sweep's byte budget (those due for eviction first), and evicts only a run whose upload the store recorded; a bucket that fails means nothing is uploaded or evicted, in one line. `strut.retention.sweep()` runs a pass by hand (a host with `scheduler: false`).

### `src/steps/lib/automation/`

automation/list, preview, create, update, delete, run-now: an agent's own door onto the automations (scheduler.ts), through `ctx.services.automations` — scoped to the ONE workflow the host names (`createStrut({ automation: { workflow, approve } })`, STRUT_HOST_CONFIG's `automation`), never another workflow's schedules; the run is handed `{ name, prompt, since: "{{ last.finishedAt }}", now: "{{ now }}" }` (the person's `{{`/`}}` kept apart by a zero-width space). The acting four first run the host's APPROVAL step (`{ intent: { action, content?, details? } }` → `{ approved }`, or a withStop output that the step passes up, ending the turn with nothing changed), refuse without one, and journal what they did so a resume never acts twice. A host whose approval step grants more than the prompt (`automation.grants`: Peel's posting as the person) gets a `grant` on create and update: strut never reads it, hands it to the approval step with the automation's ID and name (the id minted BEFORE the card, `automationId`, the same for the same call, given to `create`), and the host keeps what it allowed under that id; a change, run-now or delete card names the automation the same way (the host lets a deleted one's grant go). At each fire the runner hands every step `ctx.automation` (set by the scheduler's launch alone — a `POST …/run` or `meta/run-workflow` body cannot), which is where a host step acting on the grant names the automation; nothing rides in the input. An automation made from a turn inherits the root run's callback, as job/start does

### `src/steps/lib/meta/set-automation.ts`

the builder job's schedule for a workflow it published: only on one whose ACTIVE version the meta surface wrote (`source: agent`, `aiWrote`), and only as a proposal a person accepted (`ctx.proposal`, set by the apply alone) — a tool call, DAG step, meta/run-step or subflow is refused, so the host lists it in the builder's `approve:`; a proposal of it waits (`StepDef.after`, 409 on an early accept) for a pending `meta/publish-workflow` of the same workflow. Create, change, pause, remove by id; its fires report where the proposing run does, else nowhere until the host points them
