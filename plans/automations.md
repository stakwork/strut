# Automations — run a workflow on a schedule

> **Status (2026-09-20): implemented**, steps 1–8. Departures from the text
> below, all decided while building:
>
> - **File layout.** The pure half is `src/automations.ts`; the policy layer
>   AND the tick loop are one closure in `src/scheduler.ts`
>   (`createAutomations`) — they share the entry map, so splitting them
>   bought nothing.
> - **The overlap rule reads the run store, not memory.** No `lastRunId`
>   map: "is this automation's previous run still going" is the newest
>   unfinished run in this process whose `run.start` names the automation.
>   It therefore holds across a restart, where boot-time auto-resume may
>   have revived a scheduled run the new process never launched.
> - **The first load schedules from process start**, not from the first
>   tick: a fire due in the seconds between boot and that tick is late, not
>   lost. (Everything after is computed from the current time, as written.)
> - **A mutation always registers its schedule entry**, and an entry whose
>   trigger is unchanged keeps its `nextRunAt` — so editing one automation
>   never swallows another's fire that is already due.
> - **An interval edited without an explicit `anchor` keeps its anchor**, so
>   adding a window or changing the name does not restart the rhythm.
> - **`between` is inclusive at both ends** ("9 to 5" fires at 5:00) and must
>   start before it ends — no overnight windows in v1.
> - **A durable resume keeps the stamp**: `readRunStart` returns
>   `automation`, and the resumed run's summary still names it.
> - **`fire` while the previous run is going is a 409**, and "Run now" obeys
>   the same overlap rule as a scheduled fire.
> - **`{{ last.output }}` as a WHOLE is `{}` on the first fire** (only a
>   property of it is `undefined` and dropped) — inherent in `last` never
>   being null. Workflows meant to be polled should return an object.

## Problem

A workflow runs only when someone launches it: the Run button, `POST
/workflows/:name/run`, or the builder's `run_workflow`. There is no way to say
"run this every weekday at 9" — so the workflows that are most obviously
recurring (the `x/mentions` digest, a nightly graph sync, a weekly report)
need an external cron and a curl.

The person who wants this is often not a developer. A cron string is not an
acceptable interface, and neither is a "friendly" builder that compiles to
cron and cannot read back what it did not write.

## Decided

| Question | Decision |
| --- | --- |
| Representation | Our own structured trigger object. **No cron, no RRULE, no escape hatch.** The grammar is closed; a schedule it cannot express is fixed by adding a shape, which form + summary + chat tool all pick up at once |
| Where it lives | **Workflow-level metadata, beside `category`** — not in the versioned YAML, not a new entity. Editing or pausing a schedule publishes no version, so it never re-fires `on_change` checks and `set_active_version` never changes a schedule |
| Authoring | **Both doors**, one policy layer: a form in the UI and chat tools for the builder. Anything one creates, the other can read and edit |
| Process model | **Single process.** Strut already is (`controllers` in `createStrut.ts` is an in-memory map and "in-flight" means "in this map"); the scheduler does not solve replication first |
| Power features | **Dynamic inputs only** (`{{ last.output.x }}`, `{{ now }}`). No overlap policy, missed-run policy, auto-pause, spend cap, chat wake, calendar view |

## Design in one paragraph

An **automation** is a small record — name, enabled, trigger, input — stored
in a list on the workflow's metadata (`_metadata.json` on the filesystem, one
JSON-string property on the `StrutWorkflow` node in the graph). A pure
function `nextFire(trigger, after)` turns a trigger into its next instant; the
same function drives the form's live "next 5 runs" preview, the chat tool's
result, and the scheduler. The scheduler is an in-process tick loop holding
`nextRunAt` **in memory only**: at boot and after every fire it recomputes
from the trigger and the current time, so there is no runtime state to
persist, no stampede after a restart, and a run missed while the process was
down is simply skipped. A fire resolves the automation's input through the
existing `{{ }}` evaluator against `{ now, today, last }` — `last` being this
automation's latest successful run, read from the run store — and launches
through the same `launchDetached` path as `POST /run`, stamped `origin:
"schedule"`.

## 1. The record and the trigger grammar (`src/automations.ts`)

```jsonc
{
  "id": "a-3f9c1e",                 // generated; stable across edits
  "name": "Morning mentions digest",
  "enabled": true,
  "trigger": { "type": "schedule", "every": "week",
               "on": ["mon", "wed", "fri"], "at": ["09:00"],
               "tz": "America/New_York" },
  "input": { "account": "stakwork",
             "since_id": "{{ last.output.newest_id }}" }
}
```

`trigger.type` is a discriminator with one member today. Webhook and
"after workflow X finishes" (`services.onRunEnd` already exists) slot in
later without reshaping the record. "When a new item appears" is NOT a future
trigger type — it is a schedule plus a cursor, which dynamic inputs cover.

Shapes of a `schedule` trigger (zod discriminated union on `every`; every
shape carries an IANA `tz`, validated by constructing an
`Intl.DateTimeFormat`):

| `every` | Fields | Reads as |
| --- | --- | --- |
| `interval` | `minutes` (≥ 1), `anchor` (ISO instant), `on?` (days), `between?` (`["09:00","17:00"]`) | "Every 90 minutes", "Every 15 minutes, weekdays 9–5" |
| `day` | `at` (1+ `HH:MM`) | "Every day at 9:00 AM and 5:00 PM" |
| `week` | `on` (1+ days), `at` | "Mon, Wed, Fri at 9:00 AM" |
| `month` | `day`: `1..28` \| `"last"` \| `{ nth: 1..4 \| "last", weekday }`, `at` | "The last Friday of each month at 4:00 PM" |
| `once` | `at` (local `YYYY-MM-DDTHH:MM`) | "Once, on Oct 3 at 2:00 PM" |

Choices inside the grammar:

- **`interval` is anchored, not phase-of-midnight.** Fire instants are
  `anchor + k · minutes`; `on` / `between` FILTER those instants rather than
  restarting the phase. The anchor is definition data (the form's "starting
  at", defaulting to creation time rounded to the minute), so "every 7 hours"
  really is every 7 hours and the phase survives a restart with nothing
  persisted. The form offers minutes or hours; the record stores minutes.
- **`month.day` stops at 28.** Day 29–31 is what `"last"` is for; the grammar
  has no "day 31, except when there isn't one" case to explain to anyone.
- **`once` does not disable itself.** Once its instant has passed `nextFire`
  returns null. Whether it ran or was missed is derived (a run with this
  automation id exists, or not) — the scheduler never writes metadata.

Two pure functions, exported beside the schemas:

- `nextFire(trigger, after: Date): Date | null`
- `describeTrigger(trigger): string` — the human summary, locale `en-US`.

**Time zones, no dependency.** Wall-clock shapes walk candidate local dates
in `tz` and convert (date, `HH:MM`, tz) → instant with `Intl.DateTimeFormat`:
guess the instant as if UTC, subtract the zone's offset at that guess, and
re-check the offset at the result (two passes settle every DST boundary).
9:00 stays 9:00 across DST. A local time that does not exist (spring forward)
fires once at the shifted instant; one that occurs twice (fall back) fires
once, at the first.

## 2. Storage — one field on workflow metadata

`WorkflowMetadata` gains `automations?: Automation[]`, documented the way
`category` is: workflow-level, not version-level, survives publishes.

- **`WorkspaceStore.setWorkflowAutomations(name, list)`** — mirrors
  `setWorkflowCategory`. Replaces the whole list (empty list clears the
  field); throws for an unknown workflow. One method, because every mutation
  is read-modify-write of a short list in a single process.
- **`FileWorkspaceStore`** — an `automations` array in `_metadata.json`.
  Publish paths already read-modify-write that file, so the field survives.
- **`Neo4jWorkspaceStore`** — `automations: "?string"` on `StrutWorkflow` in
  `strut-schemas.ts`, holding the JSON-encoded list; written with the same
  `patchFor` + `nodes.update` as category. No new node type, no new edge.
  Deploy is safe on an already-seeded graph: `schema-seed.ts` reconciles
  add-only, and a new OPTIONAL attribute is exactly what add-only handles —
  no jarvis migration, and none of the required-attribute drift that bit
  claims on prod.
- **`WorkflowListEntry.automations`** — so the Automations view and the
  scheduler's boot load are one `listWorkflows()` call.
- **Conformance** (`storage-conformance.test.ts`, every impl): round-trip;
  survives a publish, a `publishWorkflowByContent` no-op, a category change
  and `setActiveVersion`; empty list clears; unknown workflow throws.

The trade accepted: in the graph, automations are a JSON blob and not
Cypher-queryable. If something ever needs to query schedules as nodes,
promoting the blob to `StrutAutomation` nodes is mechanical.

## 3. Runs know they were scheduled

- `origin?: "verify"` widens to `"verify" | "schedule"` on `RunOptions`,
  `RunEvent` and `RunEndInfo`.
- New `automation?: { id: string }` on `RunOptions`, written to `run.start`
  AND to `RunSummary` (`run.json`). The summary copy is what makes the
  `last` lookup cheap — see §5.
- `launchDetached`'s `extra` gains `origin` and `automation` and threads them
  to `runWorkflow`.

The verify trigger guards on `origin !== "verify"`, so scheduled runs ARE
verified like any other run — they are real executions of the workflow and
their evidence counts. Boot-time auto-resume already covers a scheduled run
cut off by a restart: it is a stale root run like any other.

## 4. The policy layer (`src/automations.ts`, `createAutomations(deps)`)

One module behind both doors, the shape `claims-authoring.ts` established:

- `list()` — every automation across workflows, decorated for display:
  `workflow`, `summary`, `nextRunAt`, `lastRun` (`{ runId, status,
  startedAt }` of the latest run of this automation, any status), `running`.
- `create(workflow, draft)` / `update(workflow, id, patch)` /
  `remove(workflow, id)` — validate, generate the id, default `tz` and the
  interval `anchor`, write through `setWorkflowAutomations`, then tell the
  scheduler to refresh that workflow. Each returns the record plus `summary`
  and `next` (five instants).
- `preview(trigger)` → `{ summary, next }` with no write.
- `fire(workflow, id)` — "Run now": the scheduler's fire path, off-schedule.

Write-time validation of `input`: every `{{ }}` expression is tokenized
(`templateExprs` + `exprRoots`) and its roots must be within `now`, `today`,
`last`. `{{ input.x }}` in an automation's input is a mistake worth a clear
error rather than a fire-time failure.

## 5. Dynamic inputs

At fire time the input is resolved with `resolveConfig(input, scope)`:

| Root | Value |
| --- | --- |
| `now` | The fire instant, ISO 8601 (the scheduled instant; actual time for "Run now") |
| `today` | `YYYY-MM-DD` in the trigger's `tz` |
| `last` | This automation's latest **successful** run: `{ runId, startedAt, finishedAt, output }` |

- **`last` means last SUCCESS.** A cursor must not advance past a failed
  run; the next fire re-reads the same `last` and retries the same window.
- **`last` is never null.** Before the first success it is `{ runId: null,
  startedAt: null, finishedAt: null, output: {} }`. The evaluator throws on
  property access through null (`last.output.id` with `last = null` →
  `Cannot access property 'output' of null`), and the form must be able to
  insert a bare `{{ last.output.newest_id }}` that works on run one.
- **A key that resolves to `undefined` is dropped** from the input, so the
  workflow's own `input.since_id || …` tolerance applies on the first run.
  Defaults are written `{{ last.output.newest_id || "0" }}` — the evaluator
  supports `||` and `?.` but NOT `??`.
- **Lookup.** `listRuns(workflow)` is newest-first; read `getRunSummary` down
  the list to the first with `automation.id === id` and `status ===
  "success"`, scanning at most 100. No cache and no completion hook — a fire
  happens at most once a minute and the match is normally within the first
  few summaries.
- **A fire whose input fails to resolve launches nothing.** The error is
  logged and held in memory as the automation's `lastFireError`, which
  `list()` surfaces. It is lost on restart; the next fire reproduces it.

## 6. The scheduler (`src/scheduler.ts`)

- **State:** `Map<automationId, { workflow, nextRunAt, lastRunId }>`, memory
  only. Built at boot from `listWorkflows()`; `refresh(workflow)` rebuilds
  one workflow's entries after a mutation. A disabled automation has no
  entry.
- **Tick:** every 15 s (timer `unref`'d, like auto-resume, so a host that
  constructs strut and exits is not held open). For each entry with
  `nextRunAt <= now`: **advance first** (`nextRunAt = nextFire(trigger,
  now)`), then fire. A crash between the two loses one run and never doubles
  one. A tick loop over stored instants, not long `setTimeout`s: it is
  indifferent to laptop sleep and clock jumps.
- **Missed runs are skipped**, as a consequence rather than a policy:
  `nextRunAt` is always computed from the current time.
- **One fixed overlap rule:** a fire is skipped while this automation's
  previous run is still in flight (`controllers.has(workflow/lastRunId)`).
  Not a setting. Without it two overlapping runs read the same `last` and
  process the same window twice, which breaks the one power feature in v1.
- **Fire:** `workspace.getWorkflow(name)` (the ACTIVE version, resolved at
  fire time, exactly like `POST /run`) → resolve input (§5) →
  `launchDetached(flow, { input }, { origin: "schedule", automation: { id } })`.
- **Wiring:** `createStrut({ scheduler?: boolean })`, default on,
  `STRUT_SCHEDULER=0` turns it off; `close()` stops the timer. The clock and
  the tick are injectable for tests. A host that wants to own timing turns
  the loop off and calls `fire`. `strut.automations` exposes the policy layer.

Metadata edited out-of-band (someone hand-edits `_metadata.json`) is picked
up at the next restart, not live.

## 7. HTTP (`src/automations-routes.ts`)

| Route | |
| --- | --- |
| `GET /automations` | `list()` — the whole tab in one call |
| `POST /automations/preview` | `{ trigger }` → `{ summary, next }`. The form's live preview; one implementation of the calendar math, on the server |
| `POST /workflows/:name/automations` | create |
| `PATCH /workflows/:name/automations/:id` | edit, including `{ enabled }` for pause/resume |
| `DELETE /workflows/:name/automations/:id` | remove |
| `POST /workflows/:name/automations/:id/fire` | Run now → `{ runId }` 202 |

Mutations and `fire` sit behind `requireApiKey`, like the claims routes: an
automation launches unattended runs with the deployment's secrets.

## 8. Chat tools (`src/ai/tools.ts`, prompt in `prompts.ts`)

- `list_automations({ workflow? })`
- `set_automation({ workflow, id?, name, trigger, input?, enabled? })` —
  create, or update when `id` is given.
- `delete_automation({ workflow, id })`

`set_automation`'s RESULT carries `summary` and `next`, so the model confirms
in plain language from computed facts ("Mon, Wed, Fri at 9:00 AM New York —
next run tomorrow") instead of paraphrasing its own arguments. Same division
of labor as timestamps: the LLM translates intent into the trigger object,
code computes every instant.

The prompt gains a short section: the grammar table, the three input roots
with the `||` default idiom, and one rule — a schedule is metadata; never
publish a workflow version to change one.

`meta/*` step twins are not in v1. The policy layer is already one module, so
they are thin wrappers the day builder-as-workflow needs them.

## 9. Web UI

v1 is **per-workflow**: automations are a list on the workflow, and "run
this every morning" starts from the workflow you are looking at.

- **Entry point** — a clock button in the topbar of the selected workflow
  opens the Automations flyout. Workflows with an enabled automation carry a
  small clock badge in the sidebar list, which is the at-a-glance answer to
  "what is scheduled?" until the global view exists.
- **Flyout** (`AutomationsFlyout.tsx`, reusing `FlyoutResizer`) — two
  states. *List:* one row per automation of this workflow — name, summary,
  next run (relative), last run status (links into the run view), an enabled
  toggle, Run now, and "New automation". `lastFireError` shows as a row
  warning. *Editor:* opened from a row or from "New automation".
  - *When:* a repeat-type select (minutes/hours · daily · weekly · monthly ·
    once), day chips, time inputs, a timezone select defaulting to the
    browser's zone. Below it, live and debounced from `/automations/preview`:
    the summary sentence and **the next five runs**. That list is the trust
    feature — a non-dev checks the dates, not the rule.
  - *With these inputs:* the same inferred fields `RunInputPopover` builds
    from `run-inputs.ts`. Each field has an insert menu: "Time of this run"
    → `{{ now }}`, "Today's date" → `{{ today }}`, "From the last run's
    output…" → `{{ last.output.<key> }}`, keys offered from the latest
    successful run's output when there is one.
- **Runs sidebar** — a small clock badge on runs whose summary carries
  `automation`.
- `api.ts` — typed wrappers for the six routes.

## Non-goals (v1)

- Cron strings, RRULE, or any text representation of a schedule.
- Overlap / missed-run / retry policies, auto-pause on failure, spend caps,
  end conditions ("until", "after N runs").
- Failure notifications and waking a builder chat on a scheduled failure.
- Pinning an automation to a workflow version; per-automation `params`.
- Non-schedule trigger types (the discriminator is the only provision).
- "Every N weeks" — a later shape; it needs the same `anchor` `interval` has.
- A global Automations view (a table across all workflows replacing the
  canvas). `GET /automations` already returns everything, so it is a
  rendering job with no backend change. Likewise a calendar/timeline view.
- Multi-process safety. If replicas ever matter, advance-then-fire becomes a
  compare-and-set on a persisted `nextRunAt`; nothing else changes.

## Step order

1. **Grammar** — `src/automations.ts`: zod schemas, `nextFire`,
   `describeTrigger`. Pure, no I/O. `src/automations.test.ts`.
2. **Storage** — `WorkflowMetadata.automations`, `setWorkflowAutomations` in
   both stores, the `StrutWorkflow` attribute, `WorkflowListEntry`,
   conformance cases.
3. **Run stamps** — widen `origin`, add `automation` to `RunOptions` /
   `run.start` / `RunSummary`, thread through `launchDetached`.
4. **Policy layer + scheduler** — `createAutomations`, `src/scheduler.ts`,
   the `last` lookup, input resolution, wiring + `close()` in `createStrut`.
5. **HTTP** — `src/automations-routes.ts`, `web/src/api.ts`.
6. **Chat** — three tools + the prompt section.
7. **Web** — topbar button, flyout (list + editor), insert menu, sidebar
   and run badges.
8. **Docs** — AGENTS.md layout + endpoints, a SPEC.md section. New test
   files are added to the `test` script in `package.json` (it enumerates
   files; an unlisted test never runs).

Steps 1–3 are independent of each other; 4 needs all three.

## Validation

- **`nextFire`:** each shape; multiple `at` times in one day; week wrap;
  `month` `last` / nth weekday / `"last"` weekday across month lengths and a
  leap February; interval anchor arithmetic with `on` + `between` filtering;
  `once` before and after its instant. DST in `America/New_York`:
  2026-03-08 02:30 (nonexistent → fires once, shifted) and 2026-11-01 01:30
  (ambiguous → fires once, first occurrence); 09:00 holds across both.
- **`describeTrigger`:** one golden string per shape.
- **Scheduler (fake clock, manual tick):** fires when due and advances
  before launching; never fires at boot for an instant already past; a
  disabled automation has no entry; `refresh` after an edit replaces
  `nextRunAt`; a fire is skipped while the previous run is in flight and
  fires again once it settles; `scheduler: false` creates no timer.
- **Dynamic inputs:** first fire sees the empty `last` and drops undefined
  keys; a failed run does not advance `last`; a manual run of the same
  workflow (no `automation` stamp) is ignored by the lookup; two automations
  on one workflow keep separate cursors; an unresolvable input launches
  nothing and surfaces `lastFireError`.
- **Policy layer:** rejects unknown roots in input templates, bad `tz`,
  empty `at` / `on`, `month.day` of 29; `update` keeps the id.
- **Endpoints:** CRUD round-trip, preview, fire → 202 with a run stamped
  `origin: "schedule"`; mutations refuse without the API key.
- **Graph (live, opt-in suite):** the attribute reconciles onto an
  already-seeded `StrutWorkflow` schema; the list round-trips through the
  node property.

## Open questions

- **`now` for a late fire.** Proposed: the scheduled instant, so a window
  computed from `now` is stable. The actual fire time is at most one tick
  later; if a workflow ever needs it, that is a second root, not a change.
