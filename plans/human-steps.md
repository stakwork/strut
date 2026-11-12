# Human steps: people as part of a workflow

> **Status (2026-11-12): proposed; nothing built.** Written against strut
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
| Task | One question for a person, with what to show them and the shape of the answer |
| Task type | The admin's record for a kind of task: which app draws it, the answer's shape, and later its pay and test rules. Workers are granted task types |
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

`wakeRun(workflow, runId)` in `src/createStrut.ts` is the existing durable
resume (`prepareDurableResume` + `launchDurableResume`) with its
`run.resumed` event marked `wake: true`. The journal replays every
finished step, and each parked step runs again and finds its answer.

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
- **Coalesced.** Wakes for one run within a second are one resume.
- **Across a restart.** A source keeps what it woke (`woken_at` on the
  task). At boot the task store wakes every settled task whose run was
  not woken. A wake during a drain waits until the drain lifts.
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
| `files` | Paths under the run's files: the job's directory on a job run, else the run's artifacts, as `run/files` resolves them. Each must exist when the task is made, or the step fails. `show` refers to one by the same path (§5.5) |
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
| `tasks` | a random id, the type, the key (workflow, run id, step path; unique), `show`, its files (paths and where they are rooted: the run or its job), status (`open`, `settled`, `expired`, `cancelled`), times, the answer, `woken_at` |
| `leases` | a random 128-bit id, task, worker, taken and expiry times, status (`open`, `submitted`, `expired`, `skipped`); one per task and worker |
| `workers` | actor, status (`new`, `active`, `suspended`, `banned`), first seen, a note |
| `grants` | actor, task type, who granted it, when, revoked when and why |

Tests, standing and earnings add tables with their items (§7, §8).
Earnings go in `ledger.db`, where the books check is.

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

### 4.4 The capability

`ctx.services.tasks`, built by createStrut, frozen: `ensure` (the `human`
step's), `next`, `submit`, `skip`, `me` (the worker's), and the staff's
`types`, `setType`, `workers`, `setWorker`, `grant`, `revoke`, `list`.
Inside, the task tables and the worker tables are two modules: the task
side asks "may this actor take this type?" and tells the worker side what
happened. Ruling 5 may one day move the worker side.

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

### 5.4 Reaching the app

The worker app is in the Stadeum's public view with `sphinx` as its only
sign-in and the root key (`visitorKey: root`). Peel opens it as any
public app. Anyone with the link can load the page; it shows a sign-in
and nothing else. An app in the public view is held at a release, so the
builder's edits are drafts until someone makes them live.

### 5.5 Files

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
- Payments per second through one Sphinx daemon.
- Whether a standalone box replaces the Stadeum for some clients.
- Whether workers one day see one balance across clients.

## 12. Work items

Each is its own PR against `main`, never stacked: an item that depends on
another branches after that one has merged. Each PR updates `AGENTS.md`
and the spec it touches (`specs/RUN_CONTROL_SPEC.md` for item 1,
`specs/SPEC.md` for the step, `specs/API.md` for routes).

| Item | What | Needs |
| --- | --- | --- |
| 1 | **Parked runs** (§2). `src/park.ts`, `ctx.park`, `step.parked`, `run.waiting`, the `waiting` status, `foreach`'s rule, `strut.parking`, the wake, cancel of a waiting run, every reader in §2.4, the UI of §2.5. Proven with a test step that parks on a source the test settles | Nothing |
| 2a | **The task store** (§4). `src/tasks/`: the SQLite store and its memory twin, the answer schema check, worker status, the capability, the sweep. No runner code | Nothing |
| 2b | **The `human` step** (§3). The core step, the store registered as the `task` source, the boot wake | 1 and 2a |
| 3 | **The worker's door** (§5, §6). The `task/*` steps, `worker: true`, the visitor rule and bag, the budgets, the `/tasks` routes, `useTask`, `useWorker`, `useTaskFile`, `TaskForm`, the `App` page | 2b |
| 4 | **Tests, copies and standing** (§7). Needs a short design pass first | 3 |
| 5a | **Earnings recorded and shown** (§8): the earning on an accepted answer, the hold, the balance in `task/me`, the run's cost. No money leaves | 3 |
| 5b | **Withdraw** (§8): the payer's third door. Needs its own design and a ruling. Peel's side is not in this repo | 5a |
| 6 | **The staff app** (§9), with `task/set-type` | 3; shows more after 4 and 5a |
| 7 | **`human` with `to:`**: a named person, answered in Jamie. Needs a design pass | 2b |

Items 1 and 2a can be built side by side. So can 4, 5a and 6 once 3 has
merged.

## 13. Tests

| Item | What proves it |
| --- | --- |
| 1 | A run parks and holds no controller. A wake replays and finishes. A park in one branch lets the others finish. A foreach of N parks once with N waits. Cancel of a waiting run. A restart between settle and wake still wakes. Boot auto-resume passes a waiting run over. No `run.end` callback until the real end |
| 2a, 2b | One task per run and path across wakes. Expiry fails the step and `onError` runs. Two workers never hold one task. One answer per lease. An answer that does not fit the schema is refused. A task type whose schema uses a keyword strut does not check is refused when saved. A `files` path that does not exist fails the step |
| 3 | A visitor without a grant gets nothing. A suspended worker's next call is refused. A page cannot name another worker. A different app cannot pull the type. No run directory is written for a worker's call. `task/file` refuses a path not on the task's list. An active worker's requests are counted per worker, a `new` one's per address |

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
