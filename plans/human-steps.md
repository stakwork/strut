# Human steps: people as part of a workflow

> **Status (2026-11-12): items 1 (stakwork/strut#654), 2a
> (stakwork/strut#655), 2b (stakwork/strut#656) and 3
> (stakwork/strut#657) built; the rest proposed** — §12 has each item's
> state. Written against strut
> `main` @a5663769. The rows under
> "Rulings" are the owner's, from one conversation. Everything else is
> mine and open. Strut succeeds Stakwork, and what Stakwork has that strut
> lacks is people as PART of a workflow: a worker signs in, does a task in
> a purpose-built UI, is tested, and is paid sats. **Build first: work
> items 1, 2a, 2b and 3** (a run that waits, the task store, the `human`
> step, the worker's door). Tests, earnings and the staff app follow;
> their sections are shorter and need rulings before they are built.
> Companion to
> `specs/RUN_CONTROL_SPEC.md` (a parked run is a fourth rung), `apps.md`
> (the app door, the kit), `app-repos.md` §5 (signed-in visitors),
> `paid-runs.md` (the ledger's pattern, the wallet, the payer) and
> `elicitation.md`, which left "a step pausing for a human" to a plan of
> its own. This is that plan.
>
> **Keeping this plan current.** Each session that builds an item edits
> this file in that item's PR: its row in §12 says it is built and names
> the PR, and wherever a section says something other than what was built,
> it is marked **Built differently (#PR):** with what was built and why. The
> Rulings table changes only on Evan's word.

## Rulings (2026-11-12)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | Where it runs first | **The client's Stadeum.** The workflow, the worker app, the tasks and the wallet are on one strut. A standalone box stays open |
| 2 | Who pays | **The client** pays for model calls and funds the Stadeum's wallet (the Sphinx daemon). **The wallet pays the worker**, who is the app's user. Nobody buys a workflow: the priced public door of `paid-runs.md` is not part of this |
| 3 | How a worker is paid | **A balance per Stadeum.** Earnings wait before they can be withdrawn, and the app has a withdraw section. One payment per withdrawal, not per task |
| 4 | How Stakwork is paid | Out of band. Not designed here |
| 5 | Workers across clients | **Shared: Stakwork manages the workers, clients manage the workflows.** For now the shared layer is the Sphinx mixer Stakwork runs (an invite admits a worker, a disabled account bans one). Each Stadeum keeps its own grants, standing and balance |
| 6 | The Stadeum checking a worker's mixer account | **Deferred** (§11) |
| 7 | Order | **`human` and the task store first** |

## Problem

Three jobs Stakwork does today:

- **Lost pets.** A model matches a found pet's photo against an owner's
  photos with a confidence. A low confidence goes to a person.
- **Ballot signatures.** Most are validated by a vision model. The rest
  need a person.
- **Legal documents.** Most pages digitize with a model. Some need review.

In each, the person is one step of a workflow, in a UI built for that task
(draw a box on a photo, compare two signatures). Workers are tested with
tasks whose answer is known, keep access only above a threshold, and are
paid per task.

| Strut has | Strut lacks |
| --- | --- |
| `wait` (a `setTimeout`), pause (in memory), durable resume after a crash (journal replay) | A run that waits days for a person without living in memory |
| Five ways a person answers strut: proposals, the builder's questions, captchas, a job's `ask`, a claim's open slot | One that is a workflow step. None lets a run wait on the answer |
| Signed-in visitors (`sphinx`), the public view, apps and the kit | A call a worker's page may make. A signed-in visitor's page reaches app state, graph writes on declared types, `graph/find` and launches that spend nothing (`signedInRefusal`, `src/visitors.ts`) |
| An app's own SQLite, planned (`apps.md` §4.4) | A store the page cannot write freely (§4) |
| The ledger, the wallet, a payer with two doors | A way to owe a person for work and pay them |

Measured on 2026-11-12 (one process, M4 Max, requests in process,
concurrency 50; the harness is not in the repo):

| What | Result |
| --- | --- |
| A bare step | 32,547 calls/s |
| An app page's call (`step_run`) | 1,703 calls/s |
| The same, while another app has 1,000 error reports on file | 69 calls/s |
| A run waiting in memory | about 42 KB of RSS each; lost at a restart |
| The ledger's SQLite pattern | about 21,000 transactions/s |

## Design in one paragraph

A `human` step creates a **task** and the run **parks**: it leaves memory
with a summary that says what it waits on. The task sits in a **task
store**, a SQLite file strut owns, reached only through a few fixed calls.
A **worker** is a person who signed in to the worker app and holds a grant
for that **task type**; their page asks for the next task, shows it in
whatever UI the app has, and submits an answer. The store checks the
answer and **wakes** the run, which replays its journal and goes on with
the answer as the step's output. Later items add test tasks and standing,
a balance with a withdraw section, and a staff app. The worker app is an
ordinary strut app that Jamie builds and edits. Only that app's page is
reachable by non-members; the workflow, its runs and Jamie stay private.

## 1. Words

| Word | Meaning |
| --- | --- |
| Task | One question for a person, with what to show them and the shape of the answer. Not a run and not an app: one `human` step makes one task, so a run may make none, one or many |
| Task type | The admin's record for a kind of task: which app draws it, the answer's shape, and later its pay and test rules. Workers are granted task types |
| Worker app | The screen that draws tasks. One app may draw many task types, each as a view (§5.1) |
| Worker | A signed-in person (a visitor or a member) with a row in the store. Never an agent |
| Lease | One worker's hold on one task for a limited time. The only way a worker reaches a task |
| Park | A run leaving memory to wait for something |
| Wake | Resuming a parked run because what it waited on happened |
| Test task | A task whose answer is known, mixed in to score a worker (§7) |
| Standing | A worker's rolling test score for one task type (§7) |

## 2. Parked runs

The one engine change. It is general: a timer, a proposal awaited inside a
run and a wait on another strut's run can use it later (§11).

### 2.1 What a step does

`ctx.park(on)` never returns. It throws a `ParkedError` (detected by a
flag, like `CancelledError`, `src/run-control.ts`) carrying `on`, a string
naming what the step waits for: `task:<id>`.

A step that parks runs again from the top when the run wakes. So it must
find what it started rather than start it twice, by a key of the run id
and its step path (the `strut/run-workflow` `#launch` precedent).

### 2.2 What the runner does

- **`executeStep`** (`src/runner.ts`): a `ParkedError` is not the error
  path. No retry, no `onError`, no `step.error`. It emits
  `step.parked { path, on }` and rethrows.
- **The DAG:** dependents of a parked step stop with it. Other branches
  run to their end; the DAG already waits for every branch
  (`Promise.allSettled`). The flow's outcome is the worst of its branches:
  an error, else cancelled, else parked.
- **`foreach`:** a parked iteration does not stop the others. The pool
  goes on, and the foreach parks at the end if any iteration did. A
  foreach over 100 documents therefore creates its 100 tasks in one pass,
  not one per wake.
- **`loop`:** parks at the iteration that parked. Its iterations depend
  on each other.
- **`subflow`:** a park passes through; it is the same run.
- **`runWorkflow`:** on a parked outcome it appends
  `run.waiting { on: [...] }`, which is not a terminal event, writes the
  summary with `status: "waiting"` and `waitingOn`, and returns
  `{ runId, status: "waiting" }`. Teardown runs with
  `RunEndInfo.parked: true`: per-run resources are released, as at a
  restart.
- **An agent's tool:** a tool-step that parks is a tool error ("this step
  waits for a person; an agent cannot wait in the middle of a turn"). An
  agent session cannot be resumed mid-loop (RUN_CONTROL_SPEC §8).
- **A single-step run** (`runStep`, `meta/run-step`, an app page's call):
  a park is refused the same way.

### 2.3 Wake

The wake (`createParking` in `src/park.ts`, its server side in
`src/createStrut.ts`) is the existing durable resume
(`prepareDurableResume` + `launchDurableResume`), under a per-run lock its
cancel takes too, with its `run.resumed` event marked `woken: true`. The
journal replays every finished step, and each parked step runs again and
finds its answer. **Built differently (#654):** the marker is `woken`, not
`wake`: `RunEvent.wake` is already the conversation wake's mark.

- **Sources.** `on` is `<prefix>:<id>`, the prefix lowercase letters.
  Whoever a step parks on is a source, registered in process under its
  prefix: `strut.parking.register(prefix, source)` returns
  `{ wake(workflow, runId) }`. A source is
  `{ settled(on): Promise<boolean>, cancelled?(on, run): Promise<void> }`.
  The types, `ParkedError` and `isParkedError` live in a new `src/park.ts`.
  The task store registers `task`; item 1's tests register a source of
  their own. A park on a prefix nobody registered fails the step.
- **No lost wake.** After a run parks, strut asks each source whether
  `on` already settled, and wakes at once if so. A wake that arrives
  while the run is live (another branch still running, or already
  resumed) is kept and applied when it next parks.
- **Coalesced.** Wakes for one run within a second are one resume
  (`createStrut({ wakeDelayMs })`, 1000 by default).
- **Across a restart.** **Built differently (#654):** strut keeps the
  waiting runs itself, one file a run under `<dataDir>/parking/` until the
  run really ends, and when a source registers asks it `settled(on)` about
  every run waiting on its prefix. A settle no process woke for wakes at
  the next boot, and a source keeps no wake bookkeeping. The plan had the
  source keep `woken_at` and wake at boot what it had not woken, which
  left a run waiting for good if the process died between the wake and
  the resume. A wake during a drain waits until the drain lifts.
- **A crash while parking.** If the process dies after `run.waiting` is
  appended and before the summary is written, boot auto-resume sees a
  cut-off run and resumes it. Its steps park again on the tasks they
  already made.
- **Not counted.** Boot auto-resume counts durable resumes to stop a
  crashing step looping (5). A wake is not one.

### 2.4 What a parked run is to everything else

| Reader | A run with `status: "waiting"` |
| --- | --- |
| Boot auto-resume | Has a summary, so it is passed over |
| Controllers, the drain's `idle`, `GET /runs/active` | Not live: no controller, no memory |
| The `run.end` callback, rooms, the events sink | No end is sent. It is sent when the run really ends |
| The verify pass, the projector, the conversation wake | Skipped (`RunEndInfo.parked`). They run at the real end |
| The scheduler's overlap rule | Does not block the automation's next fire |
| `POST …/cancel` | Finalizes the run as cancelled and tells each source (`cancelled(on)`), which closes its open tasks |
| `POST …/resume` | Works as for any dead run: a person may force a wake |
| `run/get { wait }`, the UI | `waiting`, with what it waits on. Not held as in flight |

### 2.5 Statuses and what the UI shows

- `RunResult.status` and `RunSummary.status` (`src/core.ts`) gain
  `"waiting"`. `run.waiting` is not a terminal event (`isTerminalEvent`,
  `src/createStrut.ts`).
- **A run's row** (sidebar, job timeline) shows `waiting`. `statusTone`
  (`web/src/helpers.ts`) already gives it the tone `paused` has.
- **The run overview** (`kit/src/folds/run-overview.ts`, `RunOverview.tsx`)
  reads a step whose latest attempt ends in `step.parked` as `waiting`,
  and lists what the run waits on from the summary's `waitingOn`.
- **The canvas** gives a parked step its own status mark, apart from
  pending and running. Its flyout shows what it waits on.
- **`latestAttempt`** (`web/src/step-attempt.ts`) needs no change: a wake
  runs the step again, which starts a new attempt.

### 2.6 Limits

- **Per-run resources are gone after a park:** a browser page, a checkout
  in the run's directory. A workflow with a `human` step keeps what later
  steps need in step outputs, artifacts or a job.
- **The log is read whole at each wake.** The 64 MB resume cap applies; a
  run past it stays `waiting` and says why.
- **One run per item is the shape for volume:** one run per pet, per
  ballot, per page. A run's cost while parked is its files on disk.

## 3. The `human` step

A core step, `src/steps/core/human.ts`.

```yaml
- id: review
  type: human
  config:
    task: pet-match          # the task type
    show:                    # what the worker's app is handed
      lost: "{{ input.lost }}"
      found: "{{ input.found }}"
      guess: "{{ match.object }}"
    files: ["found.jpg", "lost-1.jpg"]   # optional; what the worker may open
    withinHours: 48          # optional; the task type has a default
```

| Field | Meaning |
| --- | --- |
| `task` | The task type's name. It must exist and be enabled |
| `show` | Any JSON, at most 256 KB. Files are named, not inlined |
| `files` | Paths under the run's files: the job's directory on a job run, else the run's artifacts, as `run/files` resolves them. An entry may be a pattern (`photos/*`): `*` and `?` match within one folder. Patterns are resolved when the task is made, so the task's list is fixed; a file written later does not join it. A path that does not exist, or a pattern that matches nothing, fails the step. At most 200 files a task. `show` refers to one by the same path (§5.5) |
| `withinHours` | How long the task may stay unanswered; a number, fractions allowed. Then the step fails with `task_expired:`, so `retry` and `onError` apply (an `onError` may accept the model's guess). Strut has no duration parser, and its settings carry the unit in the name |
| `copies` | Later (§7): ask several workers |

Output: `{ answer, by, task }`, where `by` is the worker's actor.

What it does, each time it runs:

1. Asks the store for the task keyed by this workflow, run id and step
   path, creating it if there is none.
2. Open: `ctx.park("task:<id>")`.
3. Settled: returns the answer.
4. Expired or cancelled: throws.

Refused, before any task is made: in a stranger's public run and in a run
another strut launched with no person's credential (the trees createStrut
marks `noRemoteSpend`, as `remote/*` spending is), and as an agent's tool
(§2.2).

A second form, `to:` a named person with an inline `message` and `answer`
schema, is an approval inside a workflow. It uses the same store and the
same park. It is a later item (§12, item 7).

**Built differently (#656):**

- **Refused where `ctx.park` would refuse, too.** Besides the trees
  createStrut marks `noRemoteSpend` (refused by the store's `refusal`, so
  `ensure` makes nothing: `refused:`) and an agent's tool call, the step
  refuses before any task is made in a single-step run (`runStep`,
  `meta/run-step`, an app page's call) and a public run, where `ctx.park`
  would only fail after the task was made. It asks the runner through a new
  `ctx.parkRefusal(prefix)`: the reason `ctx.park` would give, or nothing
  (`park_refused:`). The `noRemoteSpend` trees include the runs a public
  run or a peer's launch started, as for `remote/*` spending.
- **`retry` fails again; `onError` is the way on.** A task is made once per
  step path (rule 1), so a retry reads the same expired task and fails at
  once. Making a new task per attempt would need the attempt in the key,
  and a wake starts the attempts over.
- **Cancelled is `task_cancelled:`.** It is reached only by a person's
  `POST …/resume` of a cancelled run.
- **A run cancelled while live cancels the tasks it left open** (the
  end hook, from a new `RunEndInfo.status`), so nobody answers for a run
  that is over. A cancel of a waiting run closes them through the source
  (`cancelled(on)`). A run that FAILED keeps its open tasks: a resume finds
  them, answered or not, and they expire on their own otherwise (§11).
- **Files.** A folder's name may be a pattern too, a name starting with `.`
  matches only a pattern segment that starts with `.` (as a shell's glob),
  and a pattern matches files, never folders. The list is resolved only when
  the task is made (`ensure`'s `resolveFiles`), so a file removed after that
  never fails the step when it runs again. The code is `src/tasks/files.ts`,
  which item 3's `task/file` reads by.
- **The source** registers at the end of createStrut's construction: its
  catch-up may wake a run at once, and the wake resumes through what is
  defined before it. An answer, an expiry and a cancel all wake the run
  (`onSettle`); a wake of a run that no longer waits does nothing.

## 4. The task store

### 4.1 Strut's own, not the app's SQLite

The store is a SQLite file, as the ledger is, and that is the only thing
it shares with the app SQLite of `apps.md` §4.4.

| | An app's SQLite | The task store |
| --- | --- | --- |
| Who writes it | The page, with any SQL | Strut's code only |
| How a page reaches it | `sqlite/query`, `sqlite/exec` | A few fixed calls (§5) |
| What a worker could do | Read and change every row | What those calls allow for their own lease |
| Who else reaches it | The app and the runs it launched | The `human` step of any workflow, and the wake |
| Who writes the rules | The builder, per app | Strut, once |

`apps.md` allows raw SQL there because "the worst a page can do is damage
its own tables". Here the tables would hold other workers' tasks, the
test answers and the earnings, and a worker can skip the page and call
the server directly.

### 4.2 The file

`src/tasks/`, in the ledger's pattern (`src/payments/ledger-sqlite.ts`):
`<dataDir>/tasks/tasks.db` in an owner-only folder, WAL, every write one
`BEGIN IMMEDIATE`, `node:sqlite` imported on first use, a memory twin, one
test suite over both. A strut that never runs a `human` step makes no
file.

| Table | Holds |
| --- | --- |
| `task_types` | name, app, the answer's schema (§4.5), `leaseSeconds` (default 600), `withinHours` (default 72), enabled, who changed it. Later: pay, test rate, threshold, hold |
| `tasks` | a random id, the type, the key (workflow, run id, step path; unique), `show`, its files (paths and where they are rooted: the run or its job), status (`open`, `settled`, `expired`, `cancelled`), times, the answer. No `woken_at`: strut keeps the waiting runs (§2.3, built differently in #654) |
| `leases` | a random 128-bit id, task, worker, taken and expiry times, status (`open`, `submitted`, `expired`, `skipped`); one per task and worker |
| `workers` | actor, status (`new`, `active`, `suspended`, `banned`), first seen, a note |
| `grants` | actor, task type, who granted it, when, revoked when and why |

Tests, standing and earnings add tables with their items (§7, §8).
Earnings go in `ledger.db`, where the books check is.

**Built differently (#655):** as above, plus what the rules need: a task
keeps `seq` (creation order: oldest first, paging), `due` (its
`withinHours` as a time), `root` (`run` or `job`) with the `job`, the
worker who answered (`by`) and when it left `open`; a lease keeps when it
closed and why (`reason`). A lease closed early, because its task expired
or was cancelled or its worker was suspended, banned or lost the grant, is
`expired` with a reason; there is no fifth lease status. A grant is one row
per worker and type: granting again after a revoke makes the row live, so
only the last revoke is kept. A worker row also keeps who changed it last
and when. The two sides are two modules on one file
(`src/tasks/task-store*.ts`, `src/tasks/worker-store*.ts`, `db.ts`).

### 4.3 The rules

1. A task is created once per workflow, run and step path.
2. **Next** is one guarded statement: an open task of a type the worker
   holds a live grant for, that the worker has no lease on and that has
   no other live lease. It writes the lease. A worker holds one open
   lease at a time.
3. A worker reaches a task only through their own open lease.
4. One answer per lease, checked against the type's answer schema.
   Nothing is accepted after the lease expires.
5. The worker is the session's actor, never an argument.
6. The worker's status and grant are read on every call, so a suspension
   takes effect at once whatever the session says.
7. An accepted answer settles the task and wakes its run.
8. A sweep, every minute and at boot, reopens a task whose lease expired
   and settles as expired a task past its `withinHours`, which wakes its run.

**Built differently (#655):**

- **Rule 2.** The guarded statement (`take`) covers tasks and leases. The
  grant is read from the worker side just before it and handed in as the
  types the worker may take, since the two sides are two modules (§4.4). A
  revoke that lands between the read and the statement leaves a lease the
  worker can no longer answer (refused `not_granted`); it frees the task
  when it expires.
- **Rule 2, asked again.** `next` from a worker who holds a live lease
  returns that lease when it is of a type asked for, and refuses
  (`lease_held`) when it is not, so a page that reloads gets its task back.
- **Rules 7 and 8.** The store does not wake runs: it tells `onSettle`
  listeners which tasks left `open` (answered, expired, cancelled), and item
  2b's `task` source wakes them. A lease past its expiry, and a task past
  due, count as such before the sweep marks them, so the sweep is
  bookkeeping and the wake's trigger, never what makes a rule hold. The
  minute's sweep runs only where a store is open or on file.

### 4.4 The capability

`ctx.services.tasks`, built by createStrut, frozen: `ensure` (the `human`
step's), `next`, `submit`, `skip`, `me` (the worker's), and the staff's
`types`, `setType`, `workers`, `setWorker`, `grant`, `revoke`, `list`.
Inside, the task tables and the worker tables are two modules: the task
side asks "may this actor take this type?" and tells the worker side what
happened. Ruling 5 may one day move the worker side.

**Built differently (#655):** the worker's calls take the actor as their
first argument (`next(actor, { type?, app? })`), filled by the caller from
the session, never from a page's input. The staff side also has `task(id)`.
What a source needs is on the service (`strut.tasks`), not the capability:
`onSettle`, `settled(id)` (true when no longer open, or not on file),
`cancel(id)`, `cancelRun(workflow, runId)`, `sweep`. The task side tells the
worker side nothing yet: nothing there uses it before tests and earnings
(items 4, 5a). `next { wait }` is item 3's (§5.1).

### 4.5 The answer's shape

Strut has no general JSON Schema validator today: the builder's questions
check a flat subset (`src/ai/elicitation.ts`), and the agent step checks
only `required`. A zod converter cannot be relied on, since zod is a peer
dependency from 4.3. So the store checks a subset itself, in a pure
`src/tasks/answer-schema.ts`:

- `type`: `object`, `array`, `string`, `number`, `integer`, `boolean`,
  `null`.
- `properties` and `required`. A key the schema does not name is refused.
- `items`, `minItems`, `maxItems`.
- `enum`, `minimum`, `maximum`, `minLength`, `maxLength`.
- Nesting to 8 levels. An answer is at most 256 KB as JSON.

A schema that uses anything else is refused when the task type is saved,
so a type never promises a check strut does not make. A box on a photo is
`{ type: array, items: { type: number }, minItems: 4, maxItems: 4 }`.

**Built differently (#655):** `title` and `description` are accepted as
labels and check nothing (a form needs them, and they promise no check).
`type` is required on every schema and is one name, never a list. A
keyword on a type it does not apply to (`minLength` on a number) is refused,
and so is an `enum` option that the rest of the schema would refuse.

### 4.6 A worker's status

| Status | Set by | May |
| --- | --- | --- |
| `new` | The worker's first call | `task/me` only |
| `active` | The first grant | Take tasks of the types granted |
| `suspended` | Staff; staff may lift it | `task/me` only |
| `banned` | Staff | `task/me` only |

Revoking a worker's last grant leaves them `active` with nothing to take.
A change to `suspended` or `banned` expires the worker's open lease at
once, and the task reopens.

**Built differently (#655):** revoking a grant also expires a live lease of
that type at once, since the worker can no longer answer it. Staff may set
any status, a ban lifted included, and may set one before the worker's
first call. A grant moves only `new` to `active`; a suspended or banned
worker stays so. `me` lists the types a worker holds whatever their status.

## 5. The worker's door

### 5.1 The steps

`src/steps/lib/task/`:

| Step | In | Out |
| --- | --- | --- |
| `task/next` | `{ type?, wait? }` | `{ lease, type, show, expires }`, or `{ none: true }`. `wait` holds up to 25 s for a task to appear |
| `task/submit` | `{ lease, answer }` | `{ ok: true }` |
| `task/skip` | `{ lease, reason? }` | `{ ok: true }`; the task reopens for someone else |
| `task/file` | `{ lease, path }` | one file the task named, as `run/files` returns one |
| `task/me` | `{}` | the worker's status and the task types they hold |

Each is marked `worker: true` on its definition: a step that decides from
its own caller. Each refuses without an actor and without `ctx.app`, and
`task/next` refuses a type whose `app` is not the calling app, so another
app cannot pull a type's tasks.

**One app, many task types.** A task type names one app, and any number
of types may name the same one. That is the usual shape: one worker app
per client, with a view per task type. `task/next` with no `type` gives
the next task of any type the worker holds that names the calling app,
oldest first, and the result's `type` tells the app which view to show.
With a `type` it gives only that type's. `task/me` lists the types the
worker holds in this app, so the app can show a menu.

**Built differently (#657):**

- **`task/next` hands out more:** `{ lease, type, show, files, expires,
  answer }`. `files` is the task's list (§5.5) and `answer` the type's
  answer schema, which a page needs to draw `TaskForm` (§5.3) and otherwise
  has no way to read.
- **A page's own call only.** Besides an actor and `ctx.app`, each step
  refuses to run as anything but an app page's own one-step call: never a
  step of a workflow the app launched, never an agent's tool. A worker is a
  person (§1), and a workflow launched from the app carries `ctx.app` and
  the viewer's actor.
- **The calling app on every call.** `task/submit`, `task/skip` and
  `task/file` also refuse (`wrong_app`) a lease of a type another app
  draws, not only `task/next`.
- **The first call** writes the `new` worker row: #655's service already
  did, on every worker call (`seen`), so nothing was added for it.

### 5.2 Who may call them

- **A member's page** (`POST /mcp`): when the app's `grants.steps` names
  the step. Nothing else changes.
- **A signed-in visitor's page** (`POST /public/mcp`): `signedInRefusal`
  passes a `worker: true` step the app grants, and the signed-in bag
  carries `tasks` (`src/createStrut.ts`). An anonymous visitor is refused.
- **Never kept as a run** (`keptFromApp`, `src/apps/tools.ts`): the lease
  and the answer are the record.
- **Counted per worker.** Three budgets stand in a worker's way today,
  all made for anonymous keys:
  - *Requests per address* (`PUBLIC_REQUESTS_PER_MINUTE`, 1,200, in
    `publicMiddleware`, `src/public-routes.ts`). A request that carries a
    visitor session whose actor is an `active` worker is counted under
    that worker instead, at `TASK_REQUESTS_PER_MINUTE` (240). The routes
    take a `budgetKey(c)` for it; the store answers "is this actor an
    active worker?" from memory. Sign-in stays per address.
  - *Visitor writes per day* (`visitorWrite`, `src/visitors.ts`). The
    worker steps are not added to it, so they are not counted.
  - *The app monitor's* `volume` rule. It only warns. For the worker
    steps it counts per viewer, not per app.

  The store's own limit is `TASK_CALLS_PER_MINUTE` (120) per worker, in
  memory. A held `task/next { wait }` counts once.

The first call by an actor the store has not seen writes a `workers` row
with status `new`. Staff see it and grant task types (§6).

**Built differently (#657):**

- **The signed-in bag** carries the worker's calls of the store alone
  (`next`, `submit`, `skip`, `file`, `me`: `TasksService.worker`), never the
  staff's, so no step a visitor's page reaches can save a type or grant one.
- **Never kept, whatever claims.** The door also hands a worker's call no
  claims reader, so a claim on a `task/*` step could not make it a kept run.
- **The store's limit** counts every worker call, `task/me` and
  `task/file` included (`too_many`).
- **A held wait is woken**, not polled: a task made or skipped wakes the
  oldest waiter that may take its type, and a waiter that takes nothing
  hands the wake to the next, so one task is one guarded write, not one per
  waiter; a grant, a revoke or a status change wakes that worker's own; the
  sweep freeing leases, a release or a type saved wakes every waiter once.
  A lease that runs out between sweeps wakes nobody: the page's next ask,
  as its 25 s wait ends, finds the task. A worker with nothing to take
  waits the whole 25 s too, so a page asking again on each answer never
  loops.
- **The monitor's `volume`** counts the worker steps per viewer over all of
  them together (a warning marked `perViewer`), and the version's own count
  leaves them out, read back from the files too. The per-viewer counts are
  not on file: a restart starts them at nought.
- **`budgetKey`** answers `{ key, limit }`; a worker's key is one no
  address can be. `visitorWrite` needed no change: it never counted the
  worker steps.

### 5.3 The kit

- `useTask(type)` gives `{ task, submit, skip, status }`. It holds one
  `task/next { wait }` at a time and none while the page is hidden.
- `useWorker()` is `task/me`.
- `useTaskFile(path)` is `task/file` for the current lease, as text,
  base64 or a `blob:` URL, the way `useRunFile` and `useRunFileUrl` are.
- `strut/views` gets `TaskForm`: the answer schema drawn as a form, for a
  task type that needs no custom UI. It draws a schema whose properties
  are all strings, numbers, booleans, enums or lists of enums, which is
  what the builder's question form draws today. That mapper
  (`fieldsOf`, `web/src/elicitation.ts`) moves to `kit/src/folds/` so the
  kit and strut's UI share one copy. For any other schema `TaskForm` says
  the task type needs its own UI.
- The `App` Concept page gets a section on worker apps, so the builder
  knows the hooks and the grants.

**Built differently (#657):**

- **`useTaskFile(task, path)`**, not `useTaskFile(path)`: a hook has no
  current lease of its own, so the page passes `useTask().task`. Beside it
  `useTaskFileUrl(task, path)`, the `blob:` URL, as `useRunFileUrl`.
- **`useTask(type?)`** answers `{ task, submit, skip, status, error }`,
  `status` one of `waiting`, `working`, `sending`, `inactive` (the worker
  may take nothing here now), `error`. It drops the task when its lease
  runs out or the server says it is gone, and asks for the next; a refused
  call waits 5 s before asking again, 30 s for `not_active`. `useWorker()`
  is `task/me` as a query.
- **`TaskForm`** takes the task (`{ lease, answer }`), `onSubmit`
  (`useTask().submit`) and `onSkip`: the form is the task's `answer`
  schema. A select takes the schema's values only, never "Other…", and a
  pick of a number enum is sent as the number.
- **The fold** (`kit/src/folds/answer-form.ts`) holds `fieldsOf` with
  `initialContent`, `missingRequired` and `contentToSubmit`, all of which
  `web/src/elicitation.ts` re-exports over, plus `answerOf` (the form's
  content as the answer) and `formProblem` (why a schema is no form).

### 5.4 Reaching the app

The worker app is in the Stadeum's public view with `sphinx` as its only
sign-in and the root key (`visitorKey: root`). Peel opens it as any
public app. Anyone with the link can load the page; it shows a sign-in
and nothing else. An app in the public view is held at a release, so the
builder's edits are drafts until someone makes them live.

### 5.5 Files

A task does not get its run's files. A run is the whole workflow for an
item and a task is the one piece a `human` step hands to a person, so the
run usually holds more than the task needs: the other 39 pages of a
contract when the task is page 12, the client's original upload, the
model's working notes. And strut's file access is all or nothing per run
(below). So the files are the run's own, never copies, and the list says
which of them this one task may show.

The step's `files` lists what a worker may open (§3). The store keeps the
paths with the task, with whether they are rooted in the run's artifacts
or its job's directory. `show` mentions a file by the same path, as an
ordinary string; the app decides what to do with it.

`task/file { lease, path }` reads a file only when the path is on the
task's list and the lease is the caller's and open. It answers as
`run/files` does (text or base64, `fileResult`, `src/runs.ts`), so the
practical size is the tool call's: about 3.7 MB of binary. A path not on
the list is refused whether or not the file exists.

Never a run's or a job's file token: that opens every file of the run.
Links scoped to a lease for larger images, and uploads from a worker, are
later (§11).

## 6. Task types and staff

Routes, full scope only (specs/API.md gets a section):

| Route | Does |
| --- | --- |
| `GET /tasks/types`, `PUT /tasks/types/:name`, `DELETE …` | The task types |
| `GET /tasks/workers`, `PUT /tasks/workers/:actor` | The workers and their status |
| `PUT /tasks/workers/:actor/grants/:type`, `DELETE …` | Grant and revoke a task type |
| `GET /tasks`, `GET /tasks/:id` | Tasks by type, status or run, with their leases |

**Built differently (#657):** `src/tasks/routes.ts`, specs/API.md §22.
`DELETE /tasks/types/:name` is refused (`409 in_use`) while a task of the
type is open, and revokes the type's live grants, so a type made again
under the name starts with no workers; its tasks on file keep the name.
`DELETE /tasks/workers/:actor/grants/:type` takes the reason as `?why=`.
`GET /tasks` filters by `type`, `status`, `workflow` and `runId`, a page
at a time (`before`, `limit`). A refusal is `{ error, code }`.

A task type's answer shape, and later its pay, are the admin's, never the
workflow's: the YAML names a type and cannot set them. That keeps an
AI-written workflow from setting its own pay and lets test tasks share
one shape. For the builder, `task/set-type` is a step that runs only as a
proposal an admin accepted (`approver: "admin"`, the `package/install`
pattern). It comes with the staff app (§9).

## 7. Tests, copies and standing (item 4)

- **Test tasks** live in a sealed table: a `show`, the expected answer,
  and how to grade it. `task/next` hands one out at the type's rate,
  higher for a new worker. Nothing in the payload, the pay or the timing
  tells it from a real task. A test task never appears in a run log.
- **Grading** is deep equality, or a registry step that answers in the
  claims layer's check contract (`{ supports, content }`), so a box on a
  photo is graded by overlap and free text by a model.
- **Standing** is a worker's score over their last N tests of a type.
  Below the type's threshold the grant is revoked automatically. Staff
  may grant it again.
- **Qualifying.** A worker's first K tasks of a type are all tests.
- **Copies.** `copies: n` on the step asks n workers. The type says how
  they must agree; a disagreement asks one more worker or fails the step.

## 8. Earnings and withdraw (items 5a and 5b)

Ruled: a balance per Stadeum, earnings wait, a withdraw section (the
Rulings table), and the seven questions at the end of 8.1 (2026-11-12).
The rest is proposed.

### 8.1 Earnings recorded and shown (item 5a)

Evan ruled on 8.1's questions on 2026-11-12, agreeing with every
recommendation. They are listed at its end, and where the text below rests
on one it says so. The rest of 8.1 is proposed.

An accepted answer is owed to its worker. 5a
writes what is owed, holds it, shows it to the worker and to the admin,
and marks the run with it. No sats move: the wallet pays nobody until 5b.

#### Pay

| On the task type | Unit | Meaning |
| --- | --- | --- |
| `paySats` | sats, to the msat | What one accepted answer earns. Absent or 0: the type is unpaid, and its answers write nothing to the ledger |
| `holdHours` | hours | How long an earning waits before it can be withdrawn. Ruled: 72 by default, from 1 to 720, never 0, since earnings wait (the Rulings table's 3) |

- **The admin's, never the workflow's** (§6). Set by `PUT
  /tasks/types/:name` (full scope) and, with item 6, by `task/set-type`
  behind an admin's yes. The YAML names a type and cannot set its pay, and
  no step a page or a model reaches writes it. Proposed: at most 100,000
  sats an answer, a guard against a slip, not a policy.
- **Sats, not dollars.** Ruled. The wallet holds sats and pays sats. Owed in sats,
  the sum the wallet must hold does not move with the price of bitcoin.
  Pay in dollars would leave the wallet owing a number of sats that does.
- **Locked when the task is taken.** Ruled. `next` stamps the type's pay on the
  lease and hands it to the page (`WorkerTask.payMsat`). A worker sees what
  an answer earns before doing it, and the answer earns exactly that. A
  change to the type's pay reaches the next lease, never one in hand. A
  lease with no stamp, taken before the type was paid, earns nothing.
- **No rate is locked.** The earning is sats and stays sats. Dollars appear
  only where something is shown: the run's cost is read at the rate when
  the step returns, and the Earnings tab shows sats at the rate of the
  moment, as it shows the wallet's balance.

`tasks.db` gains four nullable columns: `task_types.pay_msat`,
`task_types.hold_hours`, `leases.pay_msat` and `leases.booked_at`. Each is
added with `ALTER TABLE … ADD COLUMN` when `table_info` lacks it, and
`user_version` stays 1. A file #655 made opens as it is, and a strut from
before still opens one that has them: it reads past them and writes them
null.

#### The earning

**In `ledger.db`,** where the books check is and where 5b's payout will be
written. A payout must take from the balance and record the send in one
transaction, so the balance lives beside the withdrawals. The answer
itself settles in `tasks.db`. So an earning crosses from one file to the
other, and is safe to cross because it is written once per lease and
marked when it lands.

Three tables, each `create table if not exists`, as `deposits` is. A
ledger file from before opens unchanged, and a strut from before opens one
that has them.

| Table | One row per | Holds |
| --- | --- | --- |
| `pay` | accepted answer (a lease) | `lease` (the key), `task`, `worker`, `type`, `msat`, `at` (when the answer was accepted), `releases` (`at` plus the hold), `workflow`, `run_id`, `path` (empty for item 4's test tasks, which book through the same call), and `taken_back`, `taken_back_why`, `taken_back_by`. Unique on `task` and `worker`, so item 4's copies each earn. A trigger refuses any update but setting the take-back columns, once |
| `payees` | worker | `worker` (the key), `accepted` (msat, every earning), `taken_back` (msat), `withdrawn` (msat; 0 until 5b), `answers`, the first and last `at` |
| `pay_daily` | UTC day and task type | `answers`, `msat`, `taken_back_answers`, `taken_back_msat`. What every read of pay over time sums, never `pay` |

Indexes: `pay(worker, releases) where taken_back is null` (one worker's
held sum), `pay(releases) where taken_back is null` (everyone's) and
`pay(run_id)`. Both ledger stores, the file and its memory twin, pass one
suite.

**Booking.** `submit` (§5.1) goes on as #657 built it, then:

1. The task settles in `tasks.db` (rules 4 and 7). The lease keeps the pay
   it was stamped with.
2. `ledger.pay(…)` writes the `pay` row and adds to the payee's row and the
   day's, in one `BEGIN IMMEDIATE` committed at `synchronous=full`. The
   same lease again writes nothing and answers the first row. The first
   paid answer makes `ledger.db`.
3. The lease is marked `booked_at` in `tasks.db`.
4. `onSettle` hears it and the run wakes, as today.

A failure at 2 or 3 is logged and never the worker's: their answer was
accepted, and `submit` answers `ok`. The minute's sweep books every
submitted lease with pay and no `booked_at`, read off a partial index on
`leases`, so a crash between 1 and 3 is booked at the next sweep, once. An
unpaid lease is never on that list.

**The hold.** An earning is held until `releases` and withdrawable from
then. Computed on every read (`releases <= now`), never swept, as a
lease's expiry is: nothing waits on a timer to be right. `releases` is the
answer's time plus the type's hold when the earning is booked, so a later
change to the hold reaches only later earnings.

**Taken back.** Item 4 (§7) decides which answers lose their pay. 5a gives
it one hook:

- `strut.tasks.takeBack({ task, worker?, why, by? })`: every earning the
  task's answers made, or that worker's alone. For each, `taken` or why
  not: `released` (past its hold, it is the worker's), `none` (nothing was
  earned) or `taken` (already).
- It books an answer not yet booked first, so a take-back never loses a
  race with the sweep.
- In `ledger.db` it is one guarded statement (`… where lease = ? and
  taken_back is null and releases > ?`), with the payee's and the day's
  rows, at `synchronous=full`.
- It is on the service (`TasksService`), never the capability: no step
  reaches it.
- A person reaches it as `POST /tasks/:id/take-back { worker?, why }`, full
  scope, `409 released` past the hold. Ruled: the route ships in 5a, so an
  answer an admin finds bad inside the hold loses its pay before item 4
  exists.

A worker's status touches no earning (ruled). A suspension or a ban stops
new work; what was earned stays owed until it is taken back. Whether a
banned worker may withdraw is 5b's.

#### The balance

`task/me` answers one more field, and each type it lists carries its
`payMsat`:

```
balance: { heldMsat, withdrawableMsat, totalMsat, nextReleaseAt? }
```

| Field | Read from |
| --- | --- |
| `totalMsat` | The payee's row: `accepted − taken_back − withdrawn` |
| `heldMsat` | The sum of the worker's earnings not taken back whose `releases` is still ahead, over the `(worker, releases)` index |
| `withdrawableMsat` | `total − held` |
| `nextReleaseAt` | The soonest `releases` ahead, on the same index |

- **Cheap per call.** A read of one row by its key and a range of one
  index, bounded by what the worker answered within one hold: thousands at
  the most, well under a millisecond. `task/me` already counts against the
  worker's 120 calls a minute, so the balance costs no budget of its own.
- **No file for nothing.** The ledger is read only where one is
  (`ledgerIfAny`): a worker with nothing earned reads zeros, and a strut
  whose types are all unpaid never makes `ledger.db`.
- **The kit.** `WorkerInfo` gains `balance`, and `useTask().submit`
  refetches `useWorker()`, so the balance moves as the answer goes in.
- **Totals only.** The worker sees no list of earnings in 5a. A history,
  and whether it may say an answer was a test, is item 4's and item 6's.

#### The run's cost

The `human` step's output gains `pay: { msat, usd? }` when the answer
earned. The step marks the output with the dollars,
`withUsage(out, { modelCalls: 0, usage: empty, cost: usd })`, as
`remote/call` marks what a seller charged. `ensure` answers a settled task
with its pay (the submitted lease's stamp) and the dollars at the rate
now: `createTasks` is handed the rate by createStrut. A rate that cannot
be read leaves `usd` out and marks nothing, and the step still returns.

| Reader | Worker pay |
| --- | --- |
| `RunSummary.totals.cost`, the run overview's Cost and its split, `StrutRun.cost_usd`, the events sink | Counted. A run's cost is its model calls plus its human work, per item |
| `modelCalls`, tokens | Not counted |
| A workflow's `maxRunCostUsd`, `STRUT_RUN_MAX_COST_USD`, the Mothership | Not counted. The gateway enforces them on model calls and never sees pay |
| A public run's charge and an item's `dailyCapUsd` | Nothing today: `human` is refused in a public run (§3). If §11's "`human` in a public run" is built, pay reaches the charge through `withUsage` as a seller's charge does, and the reserve must cover it |
| The verify budget | Nothing: a check cannot park |
| The ledger | Not from here. What is owed is the `pay` row, written when the answer was accepted |

**Worker pay does not count against the model caps** (ruled). They are the
gateway's brake on a model that loops, and the gateway never sees pay.
Counting pay would need a cap strut enforces between steps, and a run
stopped after a worker answered still owes the worker. Pay's brake is the
task type's: its pay, and how many tasks the workflow makes. A daily
budget per type, which stops handing out tasks once the day's pay reaches
it, is later. The wallet's cover (below) is 5b's.

A journal replay counts nothing again (`step.replayed`). A "re-run from
here" on the `human` step itself reads the same answer and marks its pay
again: the run's totals count it twice while the ledger counts it once. A
known limit, as for any step run again.

#### The books

What is owed to workers is a debt in sats, beside the credit owed as
service, which is in dollars. 5a shows it. It moves no sats, so the books
check (`expectedMsat`) does not change.

`readEarnings` (`GET /earnings`, `earnings/read`) gains, in the unscoped
view only, as `received` and `withdrawn` are:

```
workers: {
  owedMsat, heldMsat, withdrawableMsat,  // now, not ranged
  payees,                                // workers with a balance
  accepted: { answers, msat, days },     // in the range, from pay_daily
  takenBack: { answers, msat }
}
```

With `wallet`, it adds `wallet.owedToWorkersMsat` and `wallet.coverMsat`:
the balance less what workers are owed, below 0 when the wallet is short.

| Where | Shows |
| --- | --- |
| The Earnings tab and `strut/earnings` (one fold, `kit/src/folds/earnings.ts`) | **Owed to workers** beside **Outstanding credit**: sats, at the rate of the moment, held and withdrawable. A **Workers** column by day: sats accepted, less taken back. Under the balance, whether it covers what workers are owed, in red when short |
| The admin's Withdraw dialog | What workers are owed beside the balance, and a warning when the amount would leave the wallet short of it. Ruled: 5a warns, 5b refuses |
| `GET /tasks/workers` | Each worker's balance, in one grouped read |
| `GET /tasks/:id` | Each answer's pay: sats, held until when, taken back |

Worker pay never enters `daily`. There "earned" is what this server sold
(paid-runs.md §8), and an item's margin stays its own.

**The solvency 5b will need.**

- The wallet must hold what workers are owed, held and withdrawable both:
  `cover = balance − owed`. Sats against sats, so the price of bitcoin
  never moves it.
- The credit owed as service is not added in. It is owed as runs, not as
  sats, and the client's deposits are what fund the workers (ruling 2).
- A send in flight is already out of the balance (a wallet keeps the
  debit). So a payout counts as gone from the moment it is sent, and must
  leave the payee's balance at that moment too.
- Ruled: 5b refuses an admin's withdrawal that would leave the wallet
  short of what workers are owed. Whether a worker's withdrawal is refused
  while the wallet is short is 5b's to design.

#### Tests that prove it

| File | What proves it |
| --- | --- |
| `src/payments/ledger.test.ts`, both stores | One `pay` row per lease: the same lease again writes nothing and answers the first. A payee's total is accepted less taken back less withdrawn. An earning is held one millisecond before `releases` and withdrawable at it. A take-back inside the hold leaves held and total; one past it is `released`; a second is `taken` and changes nothing. The trigger refuses changing a row's `msat`. `pay_daily` sums by day and type. A ledger file without the tables opens and gains them, and the existing suite passes unchanged |
| `src/tasks/tasks.test.ts`, both stores | `next` stamps the type's pay on the lease and hands it out; a pay change after the take leaves the lease's. A paid answer books once, with the type's hold; an unpaid one books nothing and makes no ledger file. A ledger that throws inside `submit` still answers `ok` and wakes the run, and the next sweep books it, once. A take-back of an answer not yet booked books it first. A `tasks.db` made by #655's schema opens, gains the columns and keeps its rows. `me` answers held, withdrawable and total on a fake clock |
| `src/steps/core/human.test.ts` | A paid answer's step has `pay`, and its `step.end` has `cost` at the rate and `modelCalls: 0`. The run's totals count it once across a wake and a later resume. With no rate, nothing is marked and the step still returns. An unpaid type marks nothing |
| `src/tasks/worker-door.test.ts` | End to end: a run parks, a signed-in visitor answers through `/public/mcp`, and the run finishes with its totals counting the pay. `task/me` through the door shows it held, then withdrawable once the clock passes the hold. No step a visitor's page reaches can take pay back |
| `src/payments/earnings.test.ts` | `workers` owed, held, withdrawable and by day. `coverMsat` against a fake wallet, below 0 when short. A scoped view leaves workers out. Zeros, and no file, without a ledger |
| The routes | `PUT /tasks/types` takes and checks `paySats` and `holdHours`. `POST /tasks/:id/take-back` is full scope only and answers 409 past the hold. `GET /tasks/workers` and `GET /tasks/:id` carry pay |

#### PRs

Two, against `main`. The second branches after the first has merged.

1. **The earning.** Pay on the type and the lease, the three ledger tables
   in both stores, booking and the sweep, the take-back hook and route,
   the balance in `task/me` and pay in `task/next`, the step's `pay` and
   mark, the kit's types. `specs/API.md` §22, `specs/SPEC.md`'s `human`.
2. **The books.** `readEarnings`' `workers` and `cover`, the earnings fold,
   the Earnings tab, `strut/earnings` and the Withdraw dialog's warning.
   `specs/API.md` §19. Checked in the browser.

#### Ruled (2026-11-12)

Evan agreed with every recommendation.

1. **Pay is in sats.** The wallet holds and pays sats, so what is owed
   never moves with the price.
2. **Pay is locked when the lease is taken.** The worker sees it before
   doing the work, and an admin who raises pay reaches the queue at once.
3. **The hold is per type: 72 hours by default, from 1 to 720, never 0.**
   Long enough for item 4 to grade a test and an admin to look, and
   earnings wait (the Rulings table's 3).
4. **Worker pay counts in the run's totals, never against
   `maxRunCostUsd` or the Mothership.** Those brake model loops at the
   gateway, and a stopped run still owes the worker.
5. **A person's take-back ships in 5a,** as `POST /tasks/:id/take-back`.
   Until item 4, a person is the only one who catches a bad answer, and
   that is what the hold is for.
6. **A ban touches no earning;** staff take back what was bad. Pay for
   accepted work is owed, and a ban is often for later conduct. Whether a
   banned worker may withdraw is 5b's.
7. **5a warns, and 5b refuses, an admin's withdrawal that would leave the
   wallet short of what workers are owed.** paid-runs.md §8 lets Withdraw
   take any sats because they are the seller's; once workers are owed,
   some of them are not.

### 8.2 Withdraw (item 5b)

Needs its own design and a ruling, the payer's third door first. One thing
is ruled already (8.1's ruling 7): 5b refuses an admin's withdrawal that
would leave the wallet short of what workers are owed. 5a hands it:

- `payees.withdrawn`, which a payout adds to in the same transaction as
  its `withdrawal` entry (purpose `worker`, actor the worker).
- The withdrawable sum, computed inside the statement that guards a
  payout, as `hold` guards a token's credit.
- What workers are owed, and the wallet's cover, for the solvency check.
- The rule that a released earning is the worker's, so a payout never
  meets a take-back.

The bullets below are as they stood before 5a was designed.

- **Withdraw.** The worker's host makes an invoice (Peel, from the
  worker's own account) and strut's payer pays it. The page asks for a
  withdrawal and never supplies the invoice.
- **The payer's third door.** Today two things reach the payer
  (`src/payments/payer.ts`). This is a third that pays with no admin's
  yes per payment, inside caps per worker and per day and a solvency
  check (the wallet must hold what is owed). It needs a ruling.
- **Books.** A payout is a ledger `withdrawal` with purpose `worker`, one
  per payment hash, so the existing check counts it. What is owed to
  workers is added beside the credit owed as service.
- **Proposed defaults:** the worker pays the routing fee; a minimum
  withdrawal of 1,000 sats.
- **Not confirmed:** that a payment between two accounts on one mixer
  costs nothing. The mixer's code says so (`move_funds`); no real payment
  was made to check.

## 9. The staff app (item 6)

A first-party, admin-only app, as `strut/earnings` is: `admin: true` in
its `app.yaml`, so it is listed to full scope alone, and its steps reach
the staff routes of §6 through the admin door (`AppToolDeps.adminServices`,
`src/apps/tools.ts`), which is handed only to a first-party page whose
connection holds full scope. It shows task types, queue depth and
throughput, workers with their standing and grants, answers to review,
test tasks and payouts. The page is only a face: the routes decide. A
client's own dashboard built by Jamie would need read steps a person
grants it, and is not in this item. Money settings stay behind a proposal.

## 10. Scale

What the measurements ask for, and where each lands:

| Finding | Answer |
| --- | --- |
| The app door looks the app up from scratch on every call (1,703 calls/s; 69 with error reports on file) | A cached manifest lookup. Its own change, proposed separately; it helps every app |
| A page's write is kept as a run directory | Answers are rows (§4). Nothing is kept |
| Limits count per address | Worker calls count per worker (§5.2) |
| A waiting run lives in memory | Parked runs (§2) |

With those, one process is estimated to carry about 5,000 workers. That
figure is inferred, not measured. Several processes cannot share one data
directory, so past one process the answer is another strut.

## 11. Deferred and open

**Deferred by ruling**

- **The Stadeum checking the mixer.** A mixer ban stops pay, not work:
  sign-in is a signature check strut does alone. Checking the worker's
  account with the mixer at sign-in and at withdraw closes that. The
  mixer has no route to look one account up or turn one off today.

**Later**

- Lease-scoped file links, and uploads from a worker's page.
- Invitation codes and open enrolment behind the qualifying tests.
- A default worker app for task types that need only `TaskForm`.
- Other things that park: a timer, a proposal awaited in a run, a wait on
  another strut's run.
- `human` in a public run.

**Open**

- A parked run lets go of its job. On wake the journal replays `job/dir`
  and the hold is not taken again.
- A run that fails with a task still open keeps it (§3, built differently
  in #656): a worker may answer for a run nobody resumes, until the task
  expires.
- A cancel that reaches a live run after its last checkpoint is lost when
  every branch that did not finish parked: the run ends `waiting`, not
  `cancelled` (item 1's flow outcome; found building 2b). A cancel while
  a woken run replays to its `human` steps is one way to meet it.
- `PUT /public-view` takes a runnable workflow with a `human` step; its
  public runs fail `park_refused:`.
- Payments per second through one Sphinx daemon.
- Whether a standalone box replaces the Stadeum for some clients.
- Whether workers one day see one balance across clients.

## 12. Work items

Each is its own PR against `main`, never stacked: an item that depends on
another branches after that one has merged. Each PR updates `AGENTS.md`
and the spec it touches (`specs/RUN_CONTROL_SPEC.md` for item 1,
`specs/SPEC.md` for the step, `specs/API.md` for routes).

| Item | What | Needs | State |
| --- | --- | --- | --- |
| 1 | **Parked runs** (§2). `src/park.ts`, `ctx.park`, `step.parked`, `run.waiting`, the `waiting` status, `foreach`'s rule, `strut.parking`, the wake, cancel of a waiting run, every reader in §2.4, the UI of §2.5. Proven with a test step that parks on a source the test settles | Nothing | **Built**: stakwork/strut#654. Differs in §2.3 |
| 2a | **The task store** (§4). `src/tasks/`: the SQLite store and its memory twin, the answer schema check, worker status, the capability, the sweep. No runner code | Nothing | **Built**: stakwork/strut#655. Differs in §4.2–§4.6 |
| 2b | **The `human` step** (§3). The core step, the store registered as the `task` source (`settled`, `cancelled`). The boot wake is strut's since #654 (§2.3) | 1 and 2a | **Built**: stakwork/strut#656. Differs in §3 |
| 3 | **The worker's door** (§5, §6). The `task/*` steps, `worker: true`, the visitor rule and bag, the budgets, the `/tasks` routes, `useTask`, `useWorker`, `useTaskFile`, `TaskForm`, the `App` page | 2b | **Built**: stakwork/strut#657. Differs in §5.1–§5.3, §6 |
| 4 | **Tests, copies and standing** (§7). Needs a short design pass first | 3 | Not started |
| 5a | **Earnings recorded and shown** (§8): the earning on an accepted answer, the hold, the balance in `task/me`, the run's cost. No money leaves | 3 | Not started |
| 5b | **Withdraw** (§8): the payer's third door. Needs its own design and a ruling. Peel's side is not in this repo | 5a | Not started |
| 6 | **The staff app** (§9), with `task/set-type` | 3; shows more after 4 and 5a | Not started |
| 7 | **`human` with `to:`**: a named person, answered in Jamie. Needs a design pass | 2b | Not started |

Items 1 and 2a can be built side by side. So can 4, 5a and 6 once 3 has
merged.

## 13. Tests

| Item | What proves it |
| --- | --- |
| 1 | A run parks and holds no controller. A wake replays and finishes. A park in one branch lets the others finish. A foreach of N parks once with N waits. Cancel of a waiting run. A restart between settle and wake still wakes. Boot auto-resume passes a waiting run over. No `run.end` callback until the real end |
| 2a, 2b | One task per run and path across wakes. Expiry fails the step and `onError` runs. Two workers never hold one task. One answer per lease. An answer that does not fit the schema is refused. A task type whose schema uses a keyword strut does not check is refused when saved. A `files` path that does not exist fails the step |
| 3 | A visitor without a grant gets nothing. A suspended worker's next call is refused. A page cannot name another worker. A different app cannot pull the type. No run directory is written for a worker's call. `task/file` refuses a path not on the task's list. A `files` pattern is resolved when the task is made. `task/next` with no `type` returns a task of any type the worker holds in the calling app. An active worker's requests are counted per worker, a `new` one's per address. Built in `src/tasks/worker-door.test.ts` (with a run that parks, is answered through `/public/mcp` and finishes; the pattern, also #656's `human.test.ts`) and `src/tasks/tasks.test.ts` |

## Rejected

- **The app's own SQLite as the store.** §4.1.
- **A priced public run as how the client pays.** It answered a question
  that does not exist on the client's Stadeum (ruling 2).
- **A served box per task type.** No Jamie, and changes only by a git
  push. Another strut is for when one process is not enough.
- **Paying per task as it is accepted.** It works on one mixer, but a
  balance cuts the payments to one per withdrawal (ruling 3).
- **A step that waits in memory.** 42 KB a run, lost at a restart, and
  the drain never goes idle.
