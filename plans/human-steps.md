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

> **Design pass (2026-11-12),** written against `main` @f3634e97 with
> items 1, 2a, 2b and 3 built. **Ruled the same day:** Evan agreed with
> every recommendation in §7.12, the defaults of §7.8 included. Two things
> are still proposed and marked so: the graders strut ships (PR 4c) and the
> name of item 5a's accepted-answer hook, which is §8's to choose.

Item 4 adds three things to the task store and nothing to the runner:

| Part | What it does |
| --- | --- |
| Test tasks (§7.1 to §7.3) | Tasks whose answer staff know, handed to workers among the real ones |
| Grading, standing, qualifying (§7.4, §7.5) | Each answered test is graded. A worker under the type's threshold loses the type, in their first K tasks of it too |
| Copies (§7.6) | One `human` step asks several workers and settles when enough of them agree |

### 7.1 Test tasks

A **test** is a `show`, its files, the expected answer and how to grade
it, for one task type. It is staff's, and it has no run.

**Where it lives.** A `tests` table in `tasks.db`, sealed. The expected
answer is read in one place, the grading code inside the service. No
method of `ctx.services.tasks`, no step, no page, no run log and no model
doing work sees it. The only readers are the staff routes below (full
scope) and the grader the type names (§7.4).

**What a worker is served is an INSTANCE.** When `next` hands a test to a
worker it writes a row in `tasks`, the instance, with the test's `show` and
file list, and a lease on it, in one transaction. From then on the
instance goes through the code a real task goes through: `ownLease`,
`submit`, `skip`, `file`, the lease's expiry. A page cannot tell them apart
because the path is the same, not because some code hides a difference.

| An instance's column | Value |
| --- | --- |
| `workflow`, `path` | `""`, which no workflow name is, so no `human` step, `cancelRun` or run filter meets one |
| `run_id` | The instance's own id, so the key (workflow, run id, path) stays unique (rule 1) |
| `test` | The test's id; null on a real task. Staff see it |
| `root` | `test`: its files are the test's |
| `served_to` | The worker; unique with `test`, so a worker is served a test once |

An instance lives as long as its one lease. Answered, it is settled and
graded. Skipped, let go of, or past its lease, it closes as `expired` and
never reopens for anyone: `take` never hands out an instance (`test is
null` in its guard), and the sweep closes an open instance whose lease is
no longer live.

**Files.** A test's files live in `<dataDir>/tasks/tests/<test id>/`,
owner-only, under the paths the test lists. `task/file` on an instance
reads there, as it reads a run's artifacts or a job's directory for a real
task (the service's `deps.file`, with `root: "test"`). A file is at most
what `task/file` can hand a page (about 3.7 MB of binary, §5.5), so a test
never fails where a real task would not. A test made from a real task
copies that task's files: the run's files may be removed later, and a
missing file would be a tell.

**Authoring.** Staff routes, full scope only, beside §6's:

| Route | Does |
| --- | --- |
| `GET /tasks/tests[?type=&retired=]` | The tests with their expected answers, and how many times each was served, passed and failed |
| `POST /tasks/tests { type, show, files?, expected, grade? }` | A new test. `files` lists the paths to come. `expected` is checked against the type's answer schema. → `{ test }` |
| `PUT /tasks/tests/:id/files/<path>` | One of the listed files, the raw bytes as the body. The test is `ready`, and served, once every listed file is there |
| `POST /tasks/:taskId/test { expected?, grade? }` | A test made from a real task: its `show`, its files copied, and its accepted answer as `expected` unless one is given (a disputed or expired task needs one). It records the task, and the worker who answered that task is never served it |
| `PUT /tasks/tests/:id { show?, expected?, grade? }` | Only before it is first served (`409 in_use` after). A test that was served is retired and made again, so every grade on file was graded against what that worker saw |
| `DELETE /tasks/tests/:id` | Retires it: never served again, kept for the grades that name it |

A test becoming ready wakes a held `next` of its type (`wakeFor`), for a
worker who is qualifying. Deleting a task type retires its tests.

The meta surface gets no door here, and the staff app (item 6) must not
add one that keeps a run (§7.9).

### 7.2 How `next` mixes them in

A type opts in with `tests` on its record (`PUT /tasks/types/:name`).
Without it nothing below happens, and the type works as built. With it,
`next` does this:

1. As built: the worker, their live grants, the types asked for. A live
   lease comes back as it is.
2. **Qualifying** (§7.5): a type the worker has not yet qualified for
   gets only its tests, oldest grant first, while fewer than `qualify` of
   them are answered since the grant. After that, nothing of that type
   until those answers are graded.
3. Otherwise `next` reads, without taking, the oldest real task `take`
   would hand out. If there is one, of type T, it draws: with chance
   `rate`, or `newRate` while the worker has answered fewer than
   `newTasks` real tasks of T since the grant, it serves a test of T
   instead. That is the least-served ready test of T this worker was never
   served, ties broken at random. With none left, the real task.
4. Else `take`, as built. No real task and nothing qualifying:
   `{ none: true }`.

The test is served in one transaction (`takeTest`): the worker holds no
live lease; the test is ready, not retired, never served to them and not
made from a task they answered; then the instance and its lease. The draw
uses an injected `random`, so a test can fix it. If someone takes the real
task between the read and the draw, the test is still served: a real task
was there to take.

**A test only ever replaces a real task.** A test served into an empty
queue would arrive at once while real work does not, and a held
`next { wait }` would show it. So, outside qualifying, a worker gets a
test only at a moment they would have got a real task of that type. While
qualifying they get tests whenever they ask, and they are told they are
qualifying (§7.5).

What a worker sees:

| | Real task | Test instance |
| --- | --- | --- |
| `next`'s answer | `{ lease, type, show, files, expires, answer }` | The same fields, from the same code |
| Lease length, expiry, `skip` | The type's | The same |
| `task/file` | The run's file | The test's copy, under the same path |
| `submit` | `{ ok: true }`; the run wakes later, out of sight | `{ ok: true }`; grading runs later, out of sight |
| Pay (item 5a) | An earning, held | The same earning, held (§7.9) |

What can still tell, and is accepted: a revoke right after an answer
suggests that answer was a failed test; a take-back of an earning (§8)
says so after the fact; workers can share the answers to tests. Staff
retire tests served too often (the served count is on the record).

### 7.3 Answering a test

`submit` on an instance settles it as it settles a real task, the answer
on the instance. It does not tell `onSettle`: an instance has no run, so
nothing wakes. The service queues it for grading instead. The worker has
`{ ok: true }` before grading starts.

### 7.4 Grading

How a test is graded is its own `grade`, else its type's `tests.grade`:

| `grade` | Passes when |
| --- | --- |
| `equal` (the default) | The answer equals `expected` as JSON: object keys in any order, arrays in order, numbers by value |
| `{ step, config? }` | The registry step answers in the claims check contract, `{ supports, content }`, with `supports: true`, read by `mapCheckResult` (`src/verify.ts`) |

A box on a photo is graded by overlap and free text by a model, each a
step. *Still proposed (PR 4c):* strut ships two, `grade/overlap` (each box's
intersection over union at least `min`, default 0.7) and `grade/judge`
(a model compares the answer with `expected` under staff's rubric), both
`sealed: true`.

**Which steps may grade.** A grader reads the expected answer, so it must
be one the AI can neither edit nor call: `equal`, or a sealed step
(`isSealedStep`: a sealed namespace, or `sealed: true` on its
definition). Checked when a type or test is saved and again at each
grading, since the registry changes.

**How a grader runs.** Through `runSingleStep`, the way a public tool's
call is (`src/public-tools.ts`), from a `deps.grade` that createStrut
hands `createTasks`, so `tasks.ts` stays free of the runner (as
`deps.file` is):

| | |
| --- | --- |
| Input | `{ answer, expected, show, type }`. `config` is the grade's, its templates resolved against that input; a sole `"{{ input.answer }}"` hands the value over unevaluated |
| Services | An allowlist: `secrets` (model keys) and `llmAuth`. No artifacts, shell, http, graph, runs or tasks, and no `onRunEnd` or `onRunEvent`, so the run is never projected, verified or sent to the events sink |
| Record | The run is in memory (`runSingleStep`'s own `MemoryRunStore`), and its events are dropped once the verdict is read. The verdict and its `content`, cut to 2,000 characters, are kept on the instance for staff |
| Actor, principal | No actor. The principal is the deployment's grading principal (§7.12, 1), so a model grader is billed as the client's model calls are (ruling 2) |
| Time, cost | `GRADE_TIMEOUT_MS`, 60 s (§7.8), then force-cancelled through its `RunController`. Cost capped by the type's `tests.gradeCapUsd` as `maxCostUsd`, $0.05 by default (§7.8) |
| Concurrency | 4 at a time in the process (§7.8): a queue fed by `submit` and by the sweep |

A model grader sends the expected answer to its provider. That is the one
model that sees it.

**A grader that fails or cannot run** (it throws, runs out of time, is no
longer sealed, has nobody to bill, or returns no verdict) records `error`
with the reason. An `error` counts neither way and never moves standing,
so a provider outage cannot revoke a room of workers. Staff see each
type's errors; three in a row are logged once. A test answered and not yet
graded (`pending`) is graded by the sweep, which covers a restart.

### 7.5 Standing and qualifying

**Standing** is a worker's graded tests of one type since their grant,
the newest `window` of them. After each grade the service checks it:

- With at least `minGraded` graded tests, a share passed under
  `threshold` revokes the grant: the existing `revoke`, with
  `revokedBy: "standing"` and a sentence as `why`
  (`standing: passed 13 of the last 20 tests of pet-match, under 80%`).
  The worker's live lease of the type expires at once, as with any revoke.
- `error` and `pending` grades are not counted. Skipped and expired
  instances are not graded and not counted (ruled, §7.12, 4).

Standing is computed from the instances when it is read, never stored as
a number: the `pass` and `fail` rows by `test`, `served_to` and `type`,
settled after the grant's `at`.

**Qualifying.** A grant records `qualify`, the type's K at that moment
(0 when the type has fewer than K ready tests, and the grant's answer says
so). While fewer than K of the type's tests are graded since the grant,
the worker is qualifying for it: `next` serves only its tests (§7.2,
step 2). At K the standing rule above decides. At or over the threshold,
real tasks start. Under it, the grant is revoked
(`qualifying: passed 6 of 10 tests of pet-match, under 80%`). Qualifying
is standing's first window, not a second rule. `task/me` marks a
qualifying type (`qualifying: true`) and shows no score.

**A re-grant** (`PUT /tasks/workers/:actor/grants/:type`) moves the
grant's `at`, as built, so the window starts empty, and the worker
qualifies again unless staff send `{ qualify: false }`. The old grades
stay on their instances for staff and count for nothing (ruled, §7.12,
2).

Staff read standing at a new `GET /tasks/workers/:actor` (the worker, and
per type the window, passed, graded, errors and whether qualifying), and
as a score per grant in `GET /tasks/workers`.

### 7.6 Copies

```yaml
- id: sign
  type: human
  config:
    task: ballot-signature
    show: { … }
    copies: 2        # two workers answer
```

**One task, several answers.** Rule 1 stands: one task per workflow, run
and step path. The task keeps `copies`, how many answers it wants, and
each answer stays on its worker's lease (`leases.answer`). Rule 2 becomes:
an open task with fewer live and submitted leases than `copies`. A worker
has one lease per task, as built, so the answers come from different
workers.

The type's rule, `copies` on its record:

| Field | Meaning | Default (ruled, §7.8) |
| --- | --- | --- |
| `max` | The most copies a step may ask for, and the most `more` may reach | 3 |
| `agree` | How many answers must match to settle; at most what the step asked for | 2 |
| `compare` | `equal`, or a sealed step comparing two answers in the grader's contract (one as `answer`, the other as `expected`) | `equal` |
| `onDisagree` | `more`: ask one more worker, up to `max`. `fail`: the step fails | `more` |

A step asking for more than `max` fails before a task is made.
`copies: 1`, the default, is the task as built.

**Deciding.** When the last answer asked for arrives (all of them: a
worker already leased is not cut off), the answers are grouped by
`compare`, each joining the first earlier answer it matches. A group of
`agree` or more settles the task with its first answer. Otherwise `more`
raises `copies` by one (the task is old, so it is near the front of the
queue), and at `max`, or with `fail`, the task becomes `disputed`. With
`equal` the decision is made in `submit`'s transaction. With a step it is
queued like grading, and the task takes no lease meanwhile, since its
leases already reach `copies`. The sweep decides a task left with all its
answers and no decision, which covers a restart.

What the step sees:

- **Settled:** `{ answer, by, task, answers }`. `answer` is the agreed
  one, `by` the first worker who gave it, and `answers` every copy as
  `[{ answer, by, agrees }]` in the order given. `answers` is there only
  when `copies` was over 1, so a one-copy workflow's output is unchanged.
- **Disputed:** throws `task_disputed: the 3 answers to task <id>
  (ballot-signature) did not agree`, so `onError` applies (asking an
  expert type is the usual one). The answers stay on the task for staff,
  and once staff know the answer they can make it a test (§7.1).
- **Past `withinHours` with answers missing:** `task_expired:`, as built.

`disputed` is a fifth task status. `onSettle` hears it, and the `task`
source wakes the run as for the other three.

Copies and tests stay apart: copies settle real tasks, tests score
workers. Scoring a worker by agreement with other workers is later.

### 7.7 The store's changes

Schema version 2 (`db.ts`'s `user_version`), applied when the file is
opened, in one transaction:

| Table | Change |
| --- | --- |
| `task_types` | `tests` (JSON: `rate`, `newRate`, `newTasks`, `qualify`, `window`, `minGraded`, `threshold`, `grade`, `gradeCapUsd`) and `copies` (JSON: `max`, `agree`, `compare`, `onDisagree`). Null is off |
| `tests` | New: id, type, show, files, expected, grade, the task it was made from and that task's worker, ready, created when and by, retired when and by, served |
| `tasks` | `test`, `served_to` (unique with `test`), `copies` (default 1), `grade` (`pass`, `fail`, `error` or null), `graded_at`, `grade_note`. The status CHECK gains `disputed` and the root CHECK `test`; SQLite cannot change a CHECK, so the table is rebuilt (create, copy, rename) |
| `leases` | `answer` |
| `grants` | `qualify` |

Copies and tests both change `tasks`' CHECKs, so the first PR rebuilds it
once for both (§7.11).

New on the service, beside `onSettle`: `onGraded` and `onAgreed` (§7.9).
The capability gains nothing that reaches a test: authoring is the
routes', grading the service's.

Elsewhere:

- **`human`:** `copies` (1 to the type's `max`), the `answers` output,
  `task_disputed:`. `specs/SPEC.md` §4.1.9.
- **`task/me`:** `qualifying` per type.
- **`specs/API.md` §22:** the test routes, the type's `tests` and
  `copies`, standing on the workers' routes, the re-grant's `qualify`,
  and `GET /tasks?test=true|false` to list instances or leave them out.

### 7.8 Defaults

Ruled as written (§7.12, 9). Staff change them per task type.

| Setting | Default |
| --- | --- |
| `rate` | 0.05 |
| `newRate`, `newTasks` | 0.25, until the worker has answered 50 real tasks of the type since the grant |
| `qualify` (K) | 10 |
| `window` (N), `minGraded` | 20 and 10 (K) |
| `threshold` | 0.8 |
| `GRADE_TIMEOUT_MS`, `gradeCapUsd`, grading concurrency | 60 s, $0.05, 4 |
| `copies.max`, `agree`, `onDisagree` | 3, 2, `more` |

At these numbers a new worker answers 10 tests to qualify, then about one
task in four is a test until they have answered 50 real ones, then one in
twenty.

### 7.9 Interfaces with items 5a and 6

**Earnings (§8).** Item 4 hands earnings three facts. The money is §8's.

| Hook, on `strut.tasks` | When | What item 5a may do with it |
| --- | --- | --- |
| The accepted-answer hook 5a adds (`onAnswered` *proposed*) | Every accepted answer: a real task, each copy, a test instance. `test: true` for an instance, in process only | Write the earning, the same for a test as for a real task, or pay tells |
| `onGraded { lease, task, test, worker, type, result, answeredAt, at }`, `result` one of `pass`, `fail`, `error` | A test instance graded | A `fail` inside the hold takes back that lease's earning. An `error` does nothing |
| `onAgreed { task, type, agreed, answers: [{ lease, worker, agrees }] }` | A copies task decided | Pay every copy, or not one that disagreed |

Two limits for §8. The worker's balance must show a test's earning exactly
as a real one's until it is graded. And a take-back is visible, so it says
after the fact that one answer was a failed test. An automatic revoke
takes back nothing by itself.

**The staff app (§9).** It shows the tests with their served and pass
counts, each type's grader errors, standing per worker, and disputed
tasks. Its steps reach the routes above through the admin door. A step
that authors a test carries the expected answer, so it lists `expected` in
`redact` and is never kept as a run (a read is not kept already).
`task/set-type` sets `tests` and `copies` like the rest of a type, as a
proposal an admin accepts.

### 7.10 Tests that prove it

**Tests, grading, standing, qualifying:**

- A page's view of an instance equals a real task's, field for field;
  `submit`, `skip`, `file` and the lease's expiry behave the same on both.
- No capability method, no step, and no `/tasks` answer but the test
  routes' holds an expected answer. A grader's run writes nothing under
  `dataDir` and sends no event to `onRunEvent`.
- Answering a test wakes no run (`onSettle` does not hear it).
- `take` never hands out an instance. An instance whose lease died
  closes. A worker is never served one test twice, nor a test made from a
  task they answered.
- With `random` fixed: a test replaces a real task only when one was
  takeable; an empty queue serves no test outside qualifying; `newRate`
  gives way to `rate` after `newTasks`.
- Qualifying serves only tests, then nothing until they are graded.
  Passing opens real tasks; failing revokes with its reason.
- Standing under the threshold revokes with `revokedBy: "standing"` and
  the window in `why`, and expires the live lease. `error` grades never
  move it. A re-grant starts an empty window and qualifies again, unless
  `qualify: false`.
- A grader that throws, runs out of time or is no longer sealed records
  `error`. A pending grade survives a restart and is graded by the sweep.
- A type or test naming an unsealed grader is refused when saved.
- Both stores, one suite, as built.

**Copies:**

- `copies: 2` gives two leases to two workers, never two to one, and the
  task settles only when both answers are in.
- Agreement settles with the first agreeing answer and its `by`.
  Disagreement with `more` asks a third worker; at `max` the step fails
  `task_disputed:` and `onError` runs.
- A step comparator decides outside the transaction and hands out no
  lease meanwhile. A restart between the last answer and the decision is
  decided by the sweep.
- With `copies: 1` the output is exactly as built.

### 7.11 The PRs

| PR | What | After |
| --- | --- | --- |
| 4a | Schema version 2 whole (copies' columns and CHECKs too, unused until 4b), the `tests` table and routes, `takeTest` and the draw, the grading queue with `equal` and step graders, standing, qualifying, `onGraded`, `task/me`'s flag, `GET /tasks/workers/:actor`, the specs | 3 |
| 4b | Copies: the step's and the type's fields, the take and settle changes, deciding, `disputed`, `answers`, `onAgreed`, the specs. No migration of its own | 4a merged |
| 4c | *Optional:* the shipped graders, `grade/overlap` and `grade/judge`, sealed, each tested against the check contract | 4a merged |

Never stacked: 4b and 4c branch from `main` after 4a has merged.

### 7.12 Ruled (2026-11-12)

Evan agreed with every recommendation.

1. **A model grader is billed to one grading principal for the
   deployment** (`createStrut({ tasks: { principal } })`, the
   `tasks.principal` of STRUT_HOST_CONFIG, as `publicRuns.principal` is),
   else to the admin who last saved the type. A test has no run to bill,
   and on a Stadeum the client pays for model calls (ruling 2).
2. **A re-grant restarts the window and the worker qualifies again,**
   unless staff send `qualify: false` for a worker they know. Keeping the
   old window would revoke them again at their next grade.
3. **A worker is told they are qualifying:** a flag with no score. Every
   task they get then is a test, so the flag gives nothing away, and it
   explains tasks arriving at once.
4. **Skipped and expired tests count for nothing.** Counting them as
   failures would punish a skip only when it was a test, which no worker
   can see; staff see skip rates instead.
5. **Graders must be sealed:** `equal`, strut's `grade/*`, or a step staff
   published with `sealed: true`. A grader reads every expected answer,
   and one the builder could edit could log them.
6. **A disputed task fails the step** with `task_disputed:`, so `onError`
   applies. Returning `agreed: false` instead would add a field every
   workflow with copies would have to check.
7. **Copies wait for every answer asked for.** Settling at the first
   `agree` matching answers would cut off a worker in the middle of the
   task.
8. **A test that was served is never edited:** it is retired and made
   again, so each grade was against what that worker saw.
9. **The defaults in §7.8 stand as written.**

## 8. Earnings and withdraw (items 5a and 5b)

Ruled: a balance per Stadeum, earnings wait, a withdraw section. The rest
is proposed.

- **Earning.** An accepted answer writes one earning, in msat, to
  `ledger.db`. It becomes withdrawable after the type's hold (proposed
  default 72 h). A failed test inside the hold takes it back.
- **The run's cost.** The `human` step marks its output with what was
  earned (`withUsage`, as `remote/call` marks a seller's charge). The run
  then shows model calls plus human work per item. It is a number on the
  run, not a charge to anyone.
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
