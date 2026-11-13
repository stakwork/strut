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
> it is marked **Built differently (#678):** with what was built and why. The
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
| 8 | Items 4, 5a and 6: the questions their design passes left open | **All as recommended** (2026-11-12): §7.12 (#662), §8's ruled list (#660), §9.12 (#661) |
| 9 | Who may take a task type's tasks | **Task types are open to any signed-in worker by default; a paid open type needs at least K ready tests** (ruled 2026-11-13). Staff can still make a type invite-only, and then grants work as before. An unpaid open type needs no tests |
| 10 | Item 5b (withdraw) | **The ten questions all as recommended; a payout pays the worker's Sphinx address from sign-in by keysend, not an invoice** (ruled 2026-11-13). §8.2's "Ruled (2026-11-13)" |

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

**Built differently (stakwork/strut#682): the wake takes the job again.**
A park lets go of the run's job, as of every per-run resource (§2.6), so
the job is free while the run waits. The wake takes it again where the
run first took it: a step's new `onReplay` (RUN_CONTROL_SPEC §6) runs when
a durable resume replays it, and `job/dir` (and a kept `git/checkout`)
take the hold there, before the steps after them. Every durable resume
does, not only a wake: a restart and a person's resume had the same gap.
When another run holds the job at that moment, the woken run waits for it
to let go, live, its cancel and pause looked at every quarter second. It
never fails `job_busy:`, which stays a fresh launch's answer: a run that
waited days for a person is not lost to a turn that happened to be
running.

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

**Built differently (stakwork/strut#682): a cancel beats a park.** §2.2's
outcome (an error, else cancelled, else parked) lost a cancel that reached
a live run after the last checkpoint of every branch still open, when they
all parked: the run ended `waiting`. A woken run cancelled while its
`human` steps run again is one way. Now a parked outcome whose run is being
cancelled finalizes `cancelled`, and the end hook tells each source what
the stopped branches waited on (`cancelled(on)`), as for a cancel of a
waiting run: the `task` source closes the run's open tasks.

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

**Built differently (#685):** task types are open by default (ruling 9).
A signed-in visitor who is not suspended or banned takes an OPEN type's
tasks with no grant from staff: their first `task/next` that reaches one
(by name, or any of the calling app's with no `type`) records a grant,
`by: "open"`, which makes a `new` worker `active`, so from then on their
requests count per worker. Staff grant only invite-only types (`open:
false`), and grant again after a revoke. `task/me` lists the app's open
types a worker may enter beside the ones they hold.

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

**Built differently (#684):** the builder does not ask the person to open
the Public view dialog. Once the worker app draws its types it calls
`app/make-public { name, version }`, a proposal only an ADMIN accepts
(plans/public-surface.md decision 22, ruled 2026-11-13). The card lists
what anyone will see (the dialog's cascade; a worker's `task/*` steps are
no line, since a signed-in worker calls them whatever is ticked), who can
sign in and the hold; the yes adds the app held at the version the card
showed. It leaves the view's sign-in as it is: a view that names none
offers `sphinx` with the root key once an app is public, which is this
section's setting, and a view that names others keeps them (the card says
which, and "nobody" as a danger).

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

**Built differently (#685):** a type has `open` (ruling 9), on `PUT
/tasks/types/:name`, `staff/save-type` and `task/set-type` (merged, kept
when left out): true by default, a type saved before it existed included.
A PAID open type is refused (`409 needs_tests`, the message naming the
shortfall) unless its tests are on with K (`qualify`) at least 1 and K
ready, so a new paid type is saved invite-only, its tests made, then
opened; `task/set-type`'s card marks it first ("Who takes it", a danger).
`task/types`' count of open tasks is renamed `openTasks` (the type's own
`open` now says open or invite-only) and gains `readyTests`, as `GET
/tasks/stats` does per type. In `strut/staff` the Types editor has Open /
Invite-only with the paid shortfall as its hint; Workers marks an open
grant.

## 7. Tests, copies and standing (item 4)

> **Design pass (2026-11-12),** written against `main` @f3634e97 with
> items 1, 2a, 2b and 3 built. **Ruled the same day:** Evan agreed with
> every recommendation in §7.12, the defaults of §7.8 included. Two things
> were left proposed: the graders strut ships (PR 4c, built since in #676)
> and the name of item 5a's accepted-answer hook (none was built: §7.3).
>
> **Built:** 4a (stakwork/strut#671: tests, grading, standing and
> qualifying), 4b (stakwork/strut#675: copies) and 4c (stakwork/strut#676:
> the shipped graders). Where one differs, the subsection says **Built
> differently (#PR)**.

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

**Built differently (#671):**

- **One more route, `GET /tasks/tests/:id`:** the test with each instance
  served (`{ task, lease, worker, status, served, answer?, answeredAt?,
  grade?, gradedAt?, note? }`). What a grader said (`note`, the verdict's
  `content`) is kept on the instance but answered only here, never on
  `GET /tasks` or `GET /tasks/:id`: a step grader's content may quote the
  expected answer. Those routes show an instance's `test`, `servedTo`,
  `grade` and `gradedAt`.
- **Authoring is the service's** (`strut.tasks.tests`: `list`, `get`,
  `create`, `fromTask`, `update`, `putFile`, `retire`), held by the routes
  as `takeBack` is, never on the capability; the test routes answer `501`
  on a strut whose task store is its host's.
- **Files:** at most 3,800,000 bytes each (`TEST_FILE_MAX_BYTES`). `PUT
  …/files/<path>` is refused (`409 in_use`) once the test was served, as
  its other edits are. A test made from a task copies the files still
  there; one already gone is listed as `missing` and the test is not ready
  until staff put it. A copy over the limit refuses the test. Where the
  task store is memory, so are its tests' files.
- **An instance's `due` is its lease's expiry.** A worker meets
  `lease_expired` first, as on a real task.
- `DELETE /tasks/tests/:id` answers `{ test }`, retired.

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

**Built differently (#671):**

- **Step 2 counts an answer graded `error` for nothing**, so another test
  takes its place: a worker serves tests while their answers that are
  graded `pass` or `fail`, or not graded yet, are fewer than K. Otherwise
  one grader outage during qualifying would leave the worker waiting for
  ever.
- **Step 3's "real tasks answered since the grant"** is the worker's
  submitted leases of real tasks of T closed at or after the grant's `at`.
- **The draw** reads the type `take` would hand out with `peek`, the same
  guarded query read only, and draws only when that type has tests: one
  `random()` for the chance and, when a test is taken, one for the tie.

### 7.3 Answering a test

`submit` on an instance settles it as it settles a real task, the answer
on the instance. It does not tell `onSettle`: an instance has no run, so
nothing wakes. The service queues it for grading instead. The worker has
`{ ok: true }` before grading starts.

**Built differently (#671): the earning.** 5a books an earning inside
`submit` (§8.1), so there is no accepted-answer hook: `takeTest` stamps
the type's pay on the instance's lease as `take` does, and `submit` books
it exactly as a real answer's, before the instance is queued for grading.
Nothing marks it a test on the way, so the balance shows it as a real
earning until it is graded.

### 7.4 Grading

How a test is graded is its own `grade`, else its type's `tests.grade`:

| `grade` | Passes when |
| --- | --- |
| `equal` (the default) | The answer equals `expected` as JSON: object keys in any order, arrays in order, numbers by value |
| `{ step, config? }` | The registry step answers in the claims check contract, `{ supports, content }`, with `supports: true`, read by `mapCheckResult` (`src/verify.ts`) |

A box on a photo is graded by overlap and free text by a model, each a
step. Strut ships two, `grade/overlap` (each box's
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

**Built differently (#671):**

- **A step grader's config** is the four inputs, each as a sole
  expression (`answer: '{{ input["answer"] }}'`, handed over
  unevaluated), with the grade's own `config` over them. A grader step reads
  `answer` and `expected` from its config as any step reads its input, and
  a grade's `config` adds what it needs (`min`, a rubric) without restating
  them. 4c's graders are written to this.
- **Who it is billed to:** `createStrut({ tasks: { principal } })`, or
  `STRUT_HOST_CONFIG`'s `tasks: { principal }`, else the type's
  `changedBy`. With neither, every step grader records `error` ("nobody to
  bill"), whether or not it calls a model: strut cannot tell.
- **`createStrut` hands the service `deps.grade` and `deps.graderProblem`**
  (`src/tasks/grade-step.ts`): a registry step, sealed by `isSealedStep`.
  The grader's run passes no `origin`, so nothing marks it public or a
  check.
- **`equal`'s notes** are "the answer equals the expected one" and "the
  answer differs from the expected one": never the value.
- **Staff see errors** per test (`errors` beside `passed` and `failed` on
  `GET /tasks/tests`) and per worker (`standing.errors`), not on the type.
  "Three in a row" is per type, in memory.
- **The queue** is in memory, 4 at a time; `strut.tasks.grading()` resolves
  once it is empty, and the sweep (at most 100 a minute) answers how many
  it queued (`grading`).

**Built differently (#676): the shipped graders,** `src/steps/lib/grade/`.
Each is `sealed: true` on its definition (`grade/*` is not a sealed
namespace), lists `expected` in `redact`, and reads #671's config:

- **`grade/overlap`.** A box is `[x, y, w, h]`, §4.5's four numbers, or
  `{ x, y, w, h }`: the top-left corner, then width and height above 0, in
  whatever unit the worker app draws in (pixels or fractions), the same on
  both sides. The answer and `expected` are each a box, a list of boxes
  (`[]` is none), or, with `key` in the grade's config, an object holding
  one under that key. It passes when the boxes pair off one to one, each
  pair at intersection over union at least `min` (0.7, in (0, 1]); one
  drawn box never counts for two expected ones, and the order they were
  drawn in does not matter. **A missing box fails, and so does an extra
  one:** boxes drawn everywhere must not pass. None expected and none drawn
  passes. An `expected` that is not boxes throws, so it grades `error`:
  it is staff's mistake, which must not fail a room of workers. An answer
  that is not boxes, when the expected one is, fits the same schema, so it
  is the worker's (a box of no width, which the schema subset cannot
  refuse) and fails. `content` is the counts and each expected box's IoU,
  never a coordinate: `1 expected, 2 drawn, 1 matched at IoU ≥ 0.7; box 1:
  IoU 0.92; 1 drawn box matched nothing expected`.
- **`grade/judge`.** One call on the `llm` step's model layer
  (`resolveModel` with `stepAuth`, so `llmAuth` routes it and the grading
  principal and cost cap reach the gateway; the output marked with
  `withUsage`). The model is the grade's `model`, else
  `STRUT_DEFAULT_MODEL` read through `secrets` as the agent step reads it;
  with neither it throws. There is no `STRUT_LLM_MODEL` fallback. `rubric`
  defaults to "The answer passes when it says what the expected answer
  says. Wording, case, spacing and punctuation may differ." The prompt is a
  three-line system prompt, then the rubric, `expected` and `answer` in
  tags, the values as JSON with `<` escaped so an answer cannot close its
  tag. `show` is not sent: the rubric says what the task is, and `show`
  may be large or name files the model cannot see. The reply must be one
  line, `PASS: <reason>` or `FAIL: <reason>`, the reason the `content`;
  anything else throws, so it grades `error`, never `pass`.
- **Open:** the worker's answer reaches the judge as data, and a worker
  may still try to talk the model into a pass. Staff read each grade's
  note on `GET /tasks/tests/:id`.

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

**Built differently (#671):**

- **`GET /tasks/workers/:actor` answers `{ worker }`**, the worker as a row
  of `GET /tasks/workers` is: with its `balance` and `standing`, a map by
  type of `{ qualifying, qualify, window, graded, passed, errors, pending,
  minGraded, threshold }` for each live grant of a type with tests. Item 6
  adds its own fields beside `worker` (§9.4).
- **When the rule reads:** once `minGraded` are graded, or, for a grant
  with K, once K are: qualifying decides at K even when `minGraded` is
  more. A type's `qualify` and `minGraded` are at most its `window`.
- **Both revokes are `revokedBy: "standing"`**; the `why` begins
  `qualifying:` when the decision is at the end of qualifying, `standing:`
  after.
- **A re-grant is a grant after a revoke.** A `PUT` on a grant already live
  changes nothing, `{ qualify: false }` included (as built: only a revoked
  grant's `at` moves); to drop a live worker's qualifying, staff revoke and
  grant again with it. A grant of a type with fewer ready tests than K
  records 0 and answers a `notice` saying so.
- **`task/me`'s `qualifying` is always there**, `false` when not, as
  `payMsat` always is.

**Built differently (#685):** open types (ruling 9) grant through this
section unchanged. A worker's first ask of an open type records the grant
(`by: "open"`) with K as a staff grant records it: the type's K when it
has K ready tests, else 0 — only possible on an UNPAID type, since a paid
open type short of K ready tests takes no newcomer until its tests are
back (told why; a worker already in keeps their grant). Qualifying,
standing, the review's rejections and the automatic revoke then run as
above. A revoked grant — by standing, by staff, or by the type's deletion
— is never made live by "open": only a staff grant, which qualifies again
as a re-grant does.

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

**Built differently (#675):**

- **A type without a `copies` rule asks one worker** (§7.7's "null is
  off"): a step asking more fails `bad_request: copies:` before a task is
  made. Each copy is paid work, so how much a step may multiply it is the
  admin's, as pay is (§6). `max` is 1 to 10 (`COPIES_MAX`), `agree` 1 to
  `max`.
- **`agree` is at most the copies the task wants when it is decided,** not
  what the step first asked: the task keeps only `copies`, which `more`
  raises. With the defaults the two are the same.
- **Two groups of `agree` or more** (only when `agree` is at most half the
  copies): the larger settles, then the one whose first answer came first.
- **The type's rule is read at each decision.** A type whose copies rule
  was turned off after a task of it was made decides that task by `equal`
  and the default `agree`, and never asks more.
- **A step comparator runs as a grader does** (`deps.grade`: sealed, the
  grading principal, 60 s), capped at the type's `tests.gradeCapUsd` or
  $0.05, in grading's queue and its concurrency of 4; `grading()` resolves
  once neither waits. Its comparisons are made again at each decision (none
  is kept), so after `more` the first two answers are compared again. One
  that fails leaves the task undecided, logged once; the sweep (at most 100
  a minute, `deciding` in its answer) tries again each minute until it
  decides or the task expires (`task_expired:`).
- **A one-copy task's answer is the task's alone:** `leases.answer` is
  written for copies only, so a one-copy task's record is as built.
- **`leases.agrees`**, a column §7.7 did not list (below): whether each copy
  agreed. A step comparator's decision cannot be made again when the step
  reads the task after its wake, and `answers[].agrees` needs it.
- **`pay` is every copy's**, each having earned. A disputed task fails its
  step, so its copies' pay is not in the run's cost, nor are an expired
  task's answered copies'. A known limit.
- **`onAgreed`** is `{ task, type, agreed, answers: [{ lease, worker,
  agrees }], at }`, `agreed` false for a disputed task, told every decision
  but `more` and never for one copy. Nothing in strut listens: every copy
  keeps its earning, a disagreeing one included. Whether one that disagreed
  should lose it (§7.9: "pay every copy, or not one that disagreed") is
  open, Evan's to rule.
- **A test made from a copies task** is never served to any worker who
  answered it (`takeTest` reads the task's answered leases), not only to its
  `by`: a disputed task has none.
- **Waking held waits:** a copies task made wakes one held `next` per copy,
  and `more` one.
- The tests: `src/tasks/task-copies.test.ts` over both stores (§7.10's
  "Copies" list) and `src/steps/core/human.test.ts` (the output,
  `task_disputed:` and `onError`).

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

**Built differently (#671):** the migration is `TaskDb.migrate`, one
transaction at `synchronous=full` over both sides (`taskSchema`,
`workerSchema`), run at every open and a no-op at 2. The rebuild is
decided by the table's own CHECK (`sqlite_master`), not the version, and
keeps `seq`; a failure leaves the file at 1. `tasks` and `tests` gain
indexes for standing, pending grades, open instances and the least-served
draw. `TASK_STATUSES` (what `?status=` takes) gains `disputed` with 4b;
until then only the CHECK knows it.

New on the service, beside `onSettle`: `onGraded` and `onAgreed` (§7.9).
The capability gains nothing that reaches a test: authoring is the
routes', grading the service's.

**Built differently (#675, 4b):** one more nullable column,
`leases.agrees` (1 or 0 once a copies task is decided; §7.6 says why),
added as #664 added pay's (`ADD COLUMN` when the file lacks it,
`user_version` still 2), and an index, `tasks_open_copies`, for the
sweep's undecided tasks. `TASK_STATUSES` gains `disputed`. A task's record
carries `copies` and a copies task's leases their `answer` and `agrees`, on
`GET /tasks` and `GET /tasks/:id`.

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

**Built differently (#671):** no accepted-answer hook (§7.3). `onGraded` is
built as above, and the `fail` rule is the service's own, not a listener's:
a `fail` takes back that lease's earning through `takeBack` (`by:
"grading"`, `why: "the answer to a test was graded fail"`), which does
nothing past the hold (`released`) or for an unpaid answer; `pass` and
`error` take nothing. `onAgreed` is 4b's.

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

**Built differently (#671):** in `src/tasks/task-tests.test.ts`, with a
version 1 file (#655's tables and #664's columns) migrated and one whose
migration fails left at 1. No step authors a test in 4a (the staff app is
item 6), so "a test-authoring step lists `expected` in `redact`" is a
guard over the registry: any step whose input takes `expected` must
redact it.

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
| 4a | Schema version 2 whole (copies' columns and CHECKs too, unused until 4b), the `tests` table and routes, `takeTest` and the draw, the grading queue with `equal` and step graders, standing, qualifying, `onGraded`, `task/me`'s flag, `GET /tasks/workers/:actor`, the specs. **Built: #671** | 3 |
| 4b | Copies: the step's and the type's fields, the take and settle changes, deciding, `disputed`, `answers`, `onAgreed`, the specs. No migration of its own. **Built: #675** | 4a merged |
| 4c | The shipped graders, `grade/overlap` and `grade/judge`, sealed, each tested against the check contract. **Built: #676** | 4a merged |

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
  no step a page or a model reaches writes it. At most 1,000,000 sats an
  answer, a guard against a slip, not a policy. Evan raised it from
  100,000 (about $69 at $69,000 a bitcoin) on 2026-11-12.
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

**Built differently (#664):**

- **The type's record says `paySats` and `holdHours`**, as `PUT` takes
  them, so a staff page reads a type and writes it back whole. `paySats`
  is left out when the type is unpaid (0 is saved as unpaid);
  `holdHours` is always there (72 for a row an older strut wrote null).
- **On the worker's side pay is always a number:** `WorkerTask.payMsat`
  and each of `task/me`'s types' `payMsat` are 0 when unpaid, so a page
  never meets a missing field.
- **A test clock:** `createStrut({ tasks: { now } })`, the task store's
  clock (leases, dues and when an earning releases), so a test can pass a
  hold without waiting. Nothing else reads it.

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

**Built differently (#664):**

- **`pay_daily` counts a take-back on its answer's day,** not the day it
  was taken back: `taken_back_answers` and `taken_back_msat` are, of that
  day's answers, those taken back since. §8.1 left it open; the column
  names read as a part of the same row's `answers`. A past day's row can
  therefore still move, within the hold. PR 2's Workers column by day is
  "accepted that day, less what of it was taken back".
- **What `takeBack` answers:** a list, one entry per answer of the task
  (or of `worker`), `{ lease, worker, result, earning? }`. An earning
  taken back before answers `taken` again, its first take-back's time,
  reason and author unchanged on `earning`. A task with no answer (or none
  by `worker`) answers `[]`; a task not on file is `unknown_task`. `why`
  is required and not blank.
- **The route** answers `{ task, earnings }`, and `409 released` (with
  `earnings`) only when nothing was taken, now or before, and something
  was past its hold. It is `501` on a strut whose task store is its
  host's: the take-back is strut's service's, and a host's store has none.
- **A `pay` row is never deleted either:** a second trigger refuses a
  delete, beside the one that refuses any update but the take-back.
- **The sweep books at most 500** unbooked answers a minute and stops at
  the first booking that fails, so a ledger that is down is one log line
  a minute, not one per answer.
- **`me` reads the balance on every call** and fails with the ledger: a
  ledger that cannot be read is a refusal of `task/me`, not a zero.

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

**Built differently (#664):** the dollars are rounded to the
micro-dollar, as the ledger keeps money, and a pay that rounds to nothing
marks nothing. Ruling 4 needed no code: strut enforces no run cap itself,
only the gateway does, from the macaroon's run link, which never reads
what a run spent; a test shows a run whose pay passes its workflow's
`maxRunCostUsd` finishing.

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

**Built differently (#664):** the two `/tasks` rows of the table above
are built in PR 1, with the rest of §22: `GET /tasks/workers` carries each
worker's `balance` (one grouped read, `payeeBalances`), and `GET /tasks`
and `GET /tasks/:id` carry an answered lease's `earning` (`msat`, `at`,
`releases`, and the take-back's `takenBack`, `takenBackWhy`,
`takenBackBy`). PR 2 is left `readEarnings`, the earnings fold, the
Earnings tab, `strut/earnings` and the Withdraw warning; the ledger's
`payDaily` read is there for it.

**Built differently (#666):**

- **One more ledger read, `owedToWorkers({ now })`,** both stores:
  `owedMsat`, `heldMsat`, `withdrawableMsat` and `payees` in one
  statement, each payee's row with its held range on `pay_held_worker`,
  held never more than a payee's balance (`payeeBalanceOf`'s rule). It
  is held by the task store's clock (`createStrut({ tasks: { now } })`),
  so the Earnings tab and `task/me` agree.
- **`accepted.days` are UTC days, every task type summed,** each
  `{ day, answers, msat, takenBackAnswers, takenBackMsat }`, so the
  Workers column is `msat − takenBackMsat` (#664's rule above). No
  breakdown by type.
- **`workers` is in every unscoped answer, zeros included;** with no
  ledger it is zeros, read from no file. The pages show it only once any
  worker was paid (`showsWorkers`: something owed, or answers in the
  range), so a strut that never paid one reads as it did.
- **`wallet.owedToWorkersMsat` is there whenever the wallet is,** a
  scoped view's too (the wallet is the whole wallet's), and
  `wallet.coverMsat` only when the balance was read.
- **Withdraw's warning is the server's reader's:** `readWithdrawInvoice`
  (and the `earnings/read-invoice` step `strut/earnings` calls) takes
  `owedToWorkersMsat` and answers `shortOfWorkers: { afterMsat,
  owedMsat, shortMsat }` when the amount and its whole fee cap out would
  leave less than what is owed, so both dialogs warn alike. The confirm
  line repeats it; the route is unchanged.
- **A line under the tiles** says how many answers the range accepted,
  what they earned, and what of it was taken back.

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

> **Ruled (2026-11-13).** The design pass (#681) left ten questions. Evan
> accepted every recommendation, and ruled one redesign: **a payout pays the
> worker's Sphinx address, which strut keeps from the worker's sign-in, by
> keysend. It is not an invoice that Peel makes and signs.** The section is
> written against `main` @57f332b5 and describes that design. The rulings are
> at its end, "Ruled (2026-11-13)", and the Rulings table's row 10 records
> them. Peel's side is in stakwork/peel, and the treasury daemon's is in
> stakwork/sphinx. This section designs the contracts they implement:
> `specs/WALLET.md`'s `sign_in` and `specs/LIGHTNING.md`'s daemon.

A worker withdraws what passed its hold. They sign in to the worker app with
their Sphinx account, and that sign-in hands strut their Sphinx address. To
withdraw, the page asks for an amount. Strut sends that amount by keysend to
the address the sign-in gave. The payment goes through the payer's third
door, with no admin's yes per payment, inside caps, a solvency check and a
switch. Each withdrawal is one payment (the Rulings table's 3).

What 5a hands it:

- `payees.withdrawn`, which a payout adds to in the same transaction as its
  `withdrawal` entry.
- The withdrawable sum (`total − held`), read inside the statement that
  guards a payout, as `hold` guards a token's credit.
- What workers are owed, and the wallet's cover (`owedToWorkers`,
  `coverMsat`), for the solvency check.
- The rule that a released earning is the worker's. A take-back and a
  review's restore touch only held earnings, so a payout never meets either.
- `shortOfWorkers(…)` (`withdraw-reading.ts`), for ruling 7's refusal.

#### The flow

```
Sign-in, once:
Peel ──sign_in → { key, sig, address }──▶ strut's UI ──POST /visitors/session { challenge, method: "sphinx", key, sig, address }──▶ strut
                                                       strut keeps the address in the session when its pubkey is the key that signed

Each withdrawal:
worker app ──step_run task/withdraw { msat }──▶ strut (the session: the actor and the address)
                                                  │ checks, reserves
                                                  ├──POST /keysend { id, address, msat, max_fee_msat }──▶ the treasury daemon ──▶ the worker's account
                                                  │◀── { id, state, payment_hash?, fee_msat }
worker app ◀── { state, msat, feeMsat, maxFeeMsat }
```

1. **Sign-in gives the address.** When Peel signs a worker in with the root
   key, its `sign_in` answer also carries the account's Sphinx address,
   `<pubkey>_<lsp_pubkey>_<scid>`. strut's UI passes it on in
   `POST /visitors/session`.
2. **The page asks for an amount.** The kit's `useWithdraw().withdraw(msat)`
   calls `task/withdraw { msat }`, a worker step, as `useTask` calls
   `task/submit`. `msat` is what the worker receives. The page never sends
   or sees an address.
3. **strut checks** (below), reserves the amount in the ledger, and keysends
   it to the session's address through the payer.
4. **The answer** goes back to the page: `settled`, `pending` (on its way,
   and `task/me` shows it) or `failed`, with the fee. A refusal is a code and
   a sentence.

#### The address

**Why it is the worker's own.** Two checks in the code back it:

- **The address's pubkey is the root sign-in key.** Sphinx builds an
  address in `get_my_contact_info` (`sphinx/src/bindings/mod.rs`) from
  `make_signer(seed, Some(0), …).get_node_pubkey()`. Peel's root sign-in key
  (its `accountKey`) is `pubkey_from_seed(idx: 0)` (`sphinx-ffi/src/onion.rs`).
  That function calls the same `make_signer(seed, Some(0), …)` and reads the
  same `get_node_pubkey()`, which is `secret_for_idx(0)` and does not depend
  on the time. So the key the worker signs in with is the key a keysend to
  their address is encrypted to. This holds for the root key only, which the
  worker app uses (`visitorKey: root`, §5.4). A domain child key (LUD-05) is
  no address's key.
- **Only that key can claim the payment.** A keysend's preimage rides in an
  onion encrypted to the address's pubkey. The route hint
  (`<lsp_pubkey>_<scid>`) only says how to reach it. A wrong hint makes the
  payment fail. It cannot send the money to anyone else. So the hint needs
  no signature, and only the pubkey is checked.

**Where strut keeps it: in the visitor's session.**
`POST /visitors/session` takes an optional `address` beside
`{ challenge, method, key, sig }`. Strut keeps it only when all of these
hold:

- the method is `sphinx`;
- the address parses (`parseSphinxAddress`, `kit/src/wallet/protocol.ts`);
- its pubkey is the `key` that signed.

The address then rides in the session's signed claims, beside the actor.
Any other address is dropped and the sign-in still holds, so an older Peel
signs in as before. Keeping it in the session means:

- nothing is written for a visitor who never works;
- each sign-in refreshes it;
- it belongs to the session's own actor;
- the door hands it to a worker step the way it hands the actor, never from
  the step's input.

A worker whose session has no address withdraws nothing until they sign in
again with a Peel that sends one (`no_address`).

**What Peel adds** (`specs/WALLET.md` §1.2, `sign_in`). The answer is
`{ key, sig, address? }`. It carries `address` only when Peel signs with the
root key, and the address is the account's own (Peel's `contactInfo`, from
`myContactInfo`). strut's UI reads it with `readSignInReply`. It checks that
the address's pubkey is `key`, and drops it otherwise. Peel still signs
nothing new. The `sign_in_replies` vectors gain an answer with an address,
and a new vector pins that one seed's address (from `get_my_contact_info`)
and its sign-in key (from `pubkey_from_seed(idx: 0)`) agree.

#### `task/withdraw`

A `worker: true` step with `effect: "write"`, in `src/steps/lib/task/`. It
follows the other worker steps' rules (§5.1, §5.2):

- it runs only as an app page's own call, for its signed-in viewer;
- it counts against the worker's calls;
- it is never kept as a run.

Its input is `{ msat }`. It reaches the payer only through
`tasks.withdraw(actor, { address, msat })`, a call the worker capability
gains (below). The door fills `actor` and `address` from the session.

Strut checks, in this order, before anything is reserved:

| # | Check | Refused |
| --- | --- | --- |
| 1 | The session carries an address whose pubkey is the actor's key (`secp:<x-only>`) | `no_address` |
| 2 | The switch is on, and the wallet can keysend: a Sphinx daemon with a pay token and the keysend route | `payouts_off`, `no_pay_credential`, `no_keysend` |
| 3 | The solvency check (below) | `wallet_short`, `wallet_unavailable` |
| 4 | The ledger's reserve, one guarded statement (below): the minimum, one payout on its way, the balance, the day's caps | `below_minimum`, `payout_out`, `over_balance`, `over_worker_day`, `over_server_day` |

Then the keysend goes through `withdrawals.ts`, as an admin's send does. A
refusal carries the most the worker could ask now (`maxMsat`) where that
helps (`over_balance`, the day's caps). `payout_out` carries the payout on
its way, so a page that asked twice shows the first.

**Built differently (#688):**

- **A refusal is the step's error, `code: sentence`,** as every worker
  step's is: a step can hand a page an error's text and nothing else. The
  sentence says the most the worker may ask now (`… at most 12,000 sats now
  (maxMsat 12000000)`) and names the payout on its way; `PayoutError.detail`
  carries both as numbers for server code; a page reads the numbers from
  `task/me`'s `payout` (`maxMsat`, `out`), which `useWithdraw` refetches.
- **The seam for the address.** The door hands it on the worker step's own
  bag beside the worker's calls, under `WORKER_ADDRESS` (`workerAddress`);
  `workerCall` reads it there and nowhere else. createStrut's
  `sessionAddress(session)` answers none until PR 2, which fills that one
  function (`session.address`). A member's door hands none.
- **The step's input is `msat` alone, strict:** a page that names an
  `address` is refused, not quietly ignored.
- **A daemon without the keysend route is found at the send.** Check 2's
  `no_keysend` refuses before the reserve for a payer with no keysend (NWC).
  A Sphinx daemon without the route is known only when `POST /keysend`
  answers `404 no route …`: that payout was reserved, fails at once with its
  reserve back (a `failed` row says so), and the step refuses `no_keysend`.
  Asking the daemon before every reserve would cost a round trip per
  withdrawal for a case that is a deployment's, once.
- **A send that may have gone answers `pending`, not an error:** a daemon
  that did not answer in time, or answered what strut cannot read, leaves
  the payout out and on file, and the minute's check reads it.

#### A worker on a plain browser

Nothing in v1, and no worker is left out by it. A worker app signs in only
with `sphinx` (§5.4). A plain browser cannot sign in with `sphinx` today
(`app-repos.md` §5.3, 6: the sheet does not offer it). So every worker with
a balance signed in through Peel, the one wallet that sends an address
today.

- `task/me` says `on: false`, `why: "no_address"`, to anyone else, and the
  page can say "Withdraw in Peel".
- When another wallet signs in with a Sphinx account (the passkey wallet of
  `app-repos.md` §5.4), it can send its address the same way. That is a
  different account, so a different actor.

#### The payer's third door

| Door | Who says yes | Pays |
| --- | --- | --- |
| `POST /earnings/withdraw` | An admin, per payment | Any invoice, from the wallet |
| An accepted `remote/buy-credit` | An admin, per proposal | Another strut's invoice, for credit |
| `task/withdraw` (new) | The worker, by asking; nobody per payment, inside the settings below | A keysend to the worker's own address, from their released balance |

**`src/payments/payouts.ts`.** createStrut builds it beside `withdrawals`.
`pay(actor, { address, msat })` runs the checks above, reserves, and sends
through `withdrawals.keysend({ …, purpose: "worker" })`.

- The task service is handed it as `deps.payouts`, as it is handed `grade`
  and `file`, so `tasks.ts` stays free of the payer.
- `TasksService.worker` gains `withdraw`. It counts the call against the
  worker's budget, as every worker call does.
- A host's own task store has no `withdraw`, and `task/withdraw` answers
  `not_here` there.
- `payer.ts`'s comment and `paid-runs.md` §9 then name three doors.

**The payer's keysend.** `Payer` gains `keysend({ id, address, msat,
maxFeeMsat })` and `keysendStatus({ id })`. Both answer as `pay` and `status`
do: `{ state, feeMsat, paymentHash?, preimage?, error? }`.

- **The Sphinx daemon:** `POST /keysend`, and `GET /keysend/:id` to read
  one (below, "The daemon's keysend").
- **NWC: not in v1.** NIP-47's `pay_keysend` takes `amount`, `pubkey`,
  `preimage` and `tlv_records`, but no route hints (`specs/WALLET.md` §6
  says the same). A Sphinx account is reached only through its LSP's hint,
  so an NWC treasury cannot pay a Sphinx address. Its payer answers
  `no_keysend`, and `task/me` says so. The Stadeum's wallet is the Sphinx
  daemon (ruling 2).

**The settings.** Money settings (§9.9), one row in `ledger.db`:

| Setting | Meaning | Default (ruled) |
| --- | --- | --- |
| `on` | The switch. Off: no new payout is reserved, for any worker, from the moment the change commits. Payouts already on their way go on, since a sent payment cannot be called back | Off, until an admin turns it on |
| `minSats` | The least one withdrawal may ask | 1,000 sats |
| `workerDaySats` | The most one worker's payouts may come to in a UTC day | 1,000,000 sats |
| `serverDaySats` | The most all workers' payouts may come to in a UTC day | 10,000,000 sats |

- **The caps count amounts, not fees,** of the payouts on their way and
  paid that UTC day. A failed payout counts for nothing. UTC days, as the
  rest of the ledger keeps them. The caps are a brake on a bug or a theft,
  not a budget: they sit well above a day of honest work, so they bite only
  then.
- **Where they live:** a table of their own in `ledger.db`, beside the
  balances. The reserve reads them inside its own transaction, so a switch
  turned off or a cap lowered takes hold at once, with no window. They are
  backed up with the ledger. With no ledger yet nobody has earned, and the
  routes answer the defaults.
- **Who changes them** (§9.9): an admin, in `strut/staff`'s Payouts tab or
  with `PUT /tasks/payouts/settings`, full scope only. The row keeps who
  changed it last and when. Nothing else reaches them:
  - no step on the shared bag reads or writes them;
  - no proposal reaches them;
  - `task/set-type` has no field for them;
  - no YAML names them.

  This holds because §9.2 closed the shared bag.

**Built differently (#688):** `payouts.ts` is `createPayouts({ ledger,
ledgerIfAny, withdrawals, payer, lightning, now })` → `pay`, `view` (`task/me`'s
`payout`), `settings`, `saveSettings`, `list`, `read`, `resolve` and `sweep`.
The task service is handed `pay` and `view` (`deps.payouts`); the
`/tasks/payouts` routes the rest. `keysend` and `keysendStatus` are
optional on `Payer`: the daemon's payer has them, NWC's has none. The
daemon's routes were built against a stand-in (`payer.test.ts`, beside
`POST /pay`'s, where the daemon's payer is tested; §8.2 named
`sphinx-daemon.test.ts`, the receive provider's file). A `404 no route …`
is `wallet_refused` with walletCode `no_keysend`.

**The solvency check.** Before the reserve, strut reads two things: the
wallet's balance (`lightning.balance()`, waiting at most 5 s), and what all
workers are owed, held and withdrawable (`owedToWorkers`). It refuses when
the balance is less than what is owed (`wallet_short`).

- **What is owed includes this payout's amount and fee cap,** because they
  are the worker's until the reserve. The worker pays the fee, so a payout
  leaves the cover as it was: the wallet loses `msat + fee`, and what is
  owed drops by the same amount.
- **A balance that cannot be read refuses** (`wallet_unavailable`). A door
  that pays with nobody watching fails closed.
- **A short wallet refuses every worker alike.** Paying whoever asks first
  would leave the rest owed with nothing behind it. The admin sees the
  cover in red: in the Earnings tab, the Queue's line and the Payouts tab.

#### The money

**Only released earnings.** The reserve takes at most what is withdrawable:
`accepted − taken_back − withdrawn − out`, less what is still held at that
moment.

- A take-back and a review's restore move only held earnings: each is
  guarded `releases > now`. A reserve moves only released ones.
- Each guard compares with a time read just before its statement, with no
  `await` between. The ledger is synchronous `node:sqlite`, one
  `BEGIN IMMEDIATE` at a time.
- So one earning is never both taken back and withdrawn.

**The key.** Strut makes each payout's key before it sends: 32 random bytes,
in hex. A keysend has no payment hash before it is sent, because the Sphinx
core makes its preimage, so the key stands in for one everywhere:

- the `payouts` row's key;
- the daemon's idempotency key (`id`);
- the pending entry's key in `withdrawals.ts`;
- the `withdrawal` entry's `ref`.

The payment hash the daemon reports is kept beside it.

**The reserve.** A payout leaves the worker's balance when it is reserved,
before it is sent. Otherwise what workers are owed would still count it
while it is on its way, and the cover would read short by it. One
`BEGIN IMMEDIATE` at `synchronous=full`:

1. Reads the settings row: `on`, then `minSats`.
2. Checks that no other payout of this worker is on its way (`payout_out`).
3. Checks that `msat + maxFeeMsat` fits in what is withdrawable now
   (`over_balance`).
4. Checks that the worker's day and the server's day, with this payout, fit
   their caps.
5. Writes the `payouts` row as `out`, with the address it pays, and grows
   `payees.out` by `msat + maxFeeMsat`.

**Settled.** One transaction does four things:

- writes the `withdrawal` entry: subject `worker`, actor the worker, the
  amount, the fee the wallet was charged, and the key as `ref`;
- marks the payout `paid`, with its payment hash;
- takes the reserve off `payees.out`;
- adds what the worker is charged to `payees.withdrawn`: the amount, plus
  the fee up to its cap.

So `payees.withdrawn` moves with the `withdrawal` entry, as 5a said, and the
books check counts the payout as it counts every send.

**On its way, failed, stale.** `withdrawals.ts` sends, reads and keeps a
payout as it does an admin's send. It gains a kind of send, `keysend`, keyed
by the payout's key, with the address in place of an invoice. It also gains
purpose `worker` and two hooks into the ledger:

| What happens | `withdrawals.ts`, as built | What a payout adds |
| --- | --- | --- |
| The daemon answers `settled` | One `withdrawal` entry; the pending entry dropped | The entry is the payout's settle above, in one transaction |
| The daemon answers `pending`, or nothing within 25 s | Kept on file (`withdrawals.json`) and read by the minute's check | The reserve stays out, and `task/me` shows the payout on its way. A keysend is read with `GET /keysend/:id`, which never sends, so the minute's check reads every one, answered or not |
| The daemon answers `failed`, or refused it before sending | Dropped | The payout is `failed` with the daemon's words, and the reserve goes back to the worker's balance |
| `GET /keysend/:id` answers 404 | — | The daemon never took it: it writes the id before it sends. The payout fails, and the reserve goes back |
| The process dies between the reserve and the pending entry | — | Nothing was sent, because the pending entry is written before the payer is called. A minute after the reserve, the minute's check fails a payout that is `out` in the ledger, on no pending list and paid nowhere |
| Stale: still `pending` a day after it was sent | Polling stops. A person records it as paid or drops it | The same, from the Payouts tab or the Earnings tab. `paid` settles the payout, with the fee the person gives (else 0). `drop` fails it and gives the reserve back |

**Stale after a day.** A keysend has no expiry to measure from, and a
payment within one mixer waits on the worker's client (below). The worker
asked from Peel, so Peel is usually open and answers at once. A day is long
enough for a worker who closed it straight away.

**A stale payout needs a person's judgment.** If the worker received the
sats, `paid` is right. If not, `drop` makes them owed again. Only the
worker's wallet knows which, and the Payouts tab says so beside the buttons.

**Who pays the routing fee: the worker** (ruled).

- The page shows: "you receive 5,000 sats; a fee of at most 25 sats comes
  off your balance".
- The cap is `defaultMaxFeeMsat(msat)`: the Sphinx LSP's own limit, 0.5% or
  5 sats. The daemon takes no lower cap, as for `POST /pay`.
- The worker is charged the fee the daemon was charged, never more than the
  cap.
- "Withdraw all" asks the largest amount whose cap still fits beside it. That
  is the search `maxWithdrawMsat` makes for an NWC wallet
  (`withdraw-reading.ts`).

**A minimum of 1,000 sats** (ruled). Below it, the LSP's 5-sat floor is more
than 0.5% of the amount. The minimum also bounds how many payouts one
balance can make.

**Within one mixer.** The Stadeum's wallet is a Sphinx daemon on the mixer
Stakwork runs, and so are its workers' accounts (ruling 5). The mixer's
code handles such a payment inside itself:

- `send_now` sees a local recipient and calls `handle_local`.
- `handle_local` waits for the recipient's client to answer with the
  preimage.
- Then `move_funds` calls `shift_balance`, which moves exactly the amount.
  No routing fee is taken.
- Until the recipient answers, the payment is `pending` and nothing is
  debited. Meanwhile the books' expected balance reads below the wallet's
  by the amount, and the cover reads high by it.

No real payment has checked any of this. The build checks it once, on a
staging Stadeum with Peel on the same mixer:

1. Read the daemon's `GET /balance`.
2. Keysend 1,000 sats to Peel's address, with the cap at the floor.
3. Read the balance again, and what Peel received.

Free means:

- `fee_msat` is 0;
- the balance fell by exactly 1,000,000 msat;
- Peel received 1,000 sats.

Do it once with Peel open and once with it closed, then reopened. The
result goes in `docs/payments.md`. Nothing in the design depends on it: the
worker is charged the fee the daemon was charged, which is 0 if the payment
is free.

**The ledger's changes.** Each uses `create … if not exists`, so a ledger
file from before opens and gains them:

| What | Change |
| --- | --- |
| `payouts` (new) | One row per payout key: `worker`, `address`, `msat`, `max_fee_msat`, `fee_msat` (the daemon's, once paid), `payment_hash` (once known), `state` (`out`, `paid` or `failed`), `at`, `day` (UTC), `ended`, `why` (a failure's words), `by` (a person who resolved it). A unique index on `worker` where `out`, so one payout per worker is on its way. Indexes on `(worker, day)` and on `day`, where not `failed`, for the caps. A trigger lets a row change only from `out` to `paid` or `failed`, once. Never deleted |
| `payees.out` (new column) | What this worker's payout on its way holds back: `msat + max_fee_msat`. Added with `ALTER TABLE … ADD COLUMN` when `table_info` lacks it, as #664 added pay's columns to `tasks.db`. A strut from before reads a payout on its way as still owed |
| `payout_settings` (new) | The one row of settings, with `changed_by` and `changed_at` |
| `entries` | A `withdrawal`'s subject may be `worker`, and `SEND_PURPOSES` gains it. `withdrawal()` refuses `worker`: only a payout's settle writes one |
| Reads | `payeeBalance`, `payeeBalances` and `owedToWorkers` subtract `out` (`payeeBalanceOf` gains it). New calls: `reservePayout`, `payoutSettled`, `payoutFailed`, `payoutOf`, `payouts(q)`, `payoutsToday({ now })`, `payoutSettings` and `setPayoutSettings`. Both stores, one suite |

**Built differently (#688):**

- **A payout has a `seq`** (the row's order) for paging, `payouts({ state,
  worker, before, limit })` newest first with `before` a `seq`; the person
  who resolved one is `resolved_by` (`by` on the record); `payoutsToday({
  now, worker? })` answers `{ day, paidMsat, outMsat, count, workerMsat? }`.
  The settings' `on` is the column `is_on`.
- **The reserve's checks are one pure function both stores call**
  (`payoutRefusal`), with `payoutMaxMsat` for the most the worker could ask
  now; the reserve refuses with it and, for `payout_out`, the one out.
- **The wallet's payment hash is written when the payout is paid,** with
  its fee: the trigger lets an `out` row change only to `paid` or `failed`,
  so nothing is written to it while it is on its way.
- **`owedToWorkers` keeps #666's shape;** the books' `workers.outMsat` is
  summed from the payouts out (a page at a time).
- **A refused send's hook order:** the ledger first (`payoutFailed`,
  `payoutSettled`), then the pending list, so a ledger that fails leaves the
  send on file for the next check.
- **The orphan sweep** is `payouts.sweep()`, run first in every minute's
  check (`withdrawals`' `sweep` dep), on the task store's clock, as the
  payout's `at` is.

#### The daemon's keysend (`specs/LIGHTNING.md`)

Two routes on the pay token, beside `POST /pay`. The daemon pays an invoice
today and sends a text, but it cannot send an amount to an address.

**`POST /keysend { id, address, msat, max_fee_msat }`** sends `msat` to
`address` once.

- `id` is the caller's key, 64 hex. The same `id` again answers that payment
  as it stands and never sends again, a failed one included: a new try is a
  new id. This is what makes it idempotent. The LSP cannot dedupe a keysend
  as it dedupes an invoice by its hash, so the daemon writes
  `{ id, tag, address, msat }` to its ledger before it publishes, as `pay`
  writes the hash.
- `address` is a Sphinx address. The daemon pays it with the core's
  `keysend(…, to: pubkey, amt_msat, data: none, route_hint)`, which sends
  async through the hint (`specs/WALLET.md` §6).
- `max_fee_msat` must be at least the LSP's own limit for `msat`
  (`max_fee_too_low`), as for `POST /pay`.
- It waits up to `PAY_WAIT_MS` (60 s), then answers
  `{ id, state, payment_hash?, fee_msat, preimage?, error? }`. A late answer
  is read with the GET below.
- Refused before anything is sent (400, with `code`): `bad_request`;
  `own_address` (the account's own); `max_fee_too_low`. Anything else that
  failed is `state: "failed"`.
- The fee: what the LSP charged, as for `POST /pay`. Within one mixer that
  is none (above).

**`GET /keysend/:id`** answers the same shape and never sends. It answers
`404 not_found` for an id the daemon never took, and never a
`no route …` 404: that is how strut tells a daemon without these routes
(`no_keysend`) from an id it does not know.

**The one way to pay twice** is a daemon that lost its ledger. It reads an
id it sent as never taken, and strut then fails the payout and gives the
reserve back. LIGHTNING.md says to back the ledger up with the daemon's
state.

#### Standing and status

**A suspended or banned worker may withdraw what passed its hold** (ruled).
8.1's ruling 6 says a ban touches no earning: pay for accepted work is owed,
and a ban is often for later conduct. Staff take back what was bad inside
the hold, and what is released is past review. A `new` worker has earned
nothing. Two levers stay:

- the switch stops everyone at once;
- disabling a worker's account on the mixer (ruling 5) stops the payment
  reaching them.

A freeze on one worker's payouts is not built.

**`task/me` gains `payout`:**

```
payout: {
  on: boolean,                 // withdrawing is open here now
  why?: "off" | "no_wallet" | "no_keysend" | "no_address" | "not_here",
  minMsat: number,
  dayLeftMsat: number,         // this worker's cap left today
  maxMsat: number,             // the most one withdrawal may ask now; 0 when under minMsat
  out?: { key, msat, maxFeeMsat, at, stale: boolean }
}
```

- **`on` says only what strut knows without asking the wallet:** the switch,
  a pay credential that can keysend, an address in the session, and strut's
  own task store. The solvency check runs when a payout is asked for, never
  on every `task/me`.
- **`maxMsat` is the least of three:** the largest amount whose fee cap fits
  in what is withdrawable, the worker's day left, and the server's day left.
  The server's figure is never shown on its own.
- `balance.totalMsat` already leaves out a payout on its way (`out`).
- **It is cheap to read:** the settings row, the worker's open payout on its
  unique index, and two day sums on theirs.

**The kit.** `WorkerInfo` gains `payout`. `useWithdraw()` gives
`{ withdraw(msat), status, error }`. It refetches `useWorker()` when it
answers, then every 5 s while `out` is there. The `App` Concept page says a
worker app with a withdraw section grants `task/withdraw`.

#### The admin's side

**Ruling 7's refusal.** `POST /earnings/withdraw` refuses with
`409 short_of_workers` when the amount and its whole fee cap would leave the
wallet holding less than what workers are owed. It uses `shortOfWorkers`,
with the balance read at that moment. When workers are owed and the balance
cannot be read, the refusal is `409 balance_unknown`.

- The check lives in `withdrawals.withdraw`, so it covers every send that is
  not a worker's: an admin's Withdraw, and an accepted `remote/buy-credit`
  (ruled).
- A retry of a send already out only reads it, and checks nothing.
- The Withdraw dialogs' warning (#666) becomes the reason their button is
  off.

**Routes**, full scope, in `src/tasks/routes.ts` beside §6's, so the staff
door reaches them (`STAFF_ROUTES`):

| Route | Does |
| --- | --- |
| `GET /tasks/payouts?state=&worker=&before=&limit=` | Answers `{ settings, today: { paidMsat, outMsat, count, serverLeftMsat }, payouts }`, newest first. `state` is `out`, `stale`, `paid` or `failed` |
| `PUT /tasks/payouts/settings { on, minSats, workerDaySats, serverDaySats }` | Saves the whole row and answers `{ settings }` with `changedBy` and `changedAt`. `minSats` is at least 1, and each cap at least `minSats` |
| `POST /tasks/payouts/:key/read` | `withdrawals.read`, for a payout |
| `POST /tasks/payouts/:key/resolve { action, feeMsat? }` | `withdrawals.resolve`, for a payout |

The staff door gets four steps: `staff/payouts`, `staff/save-payouts`,
`staff/payout-read` and `staff/payout-resolve`. The `/earnings/withdrawals/…`
routes act on a payout too, through the same hooks.

**Built differently (#688):**

- **The routes' answers:** `GET /tasks/payouts` with no ledger answers the
  defaults and none, makes no file; each payout carries `stale`; `today`
  has its `day`. `…/read` answers `{ payout, …withdrawals' answer }` and
  `…/resolve` `{ payout, action }`. A key that is not 64 lowercase hex is
  `400`, one that is no payout `404 unknown_payout`; a settings body with
  any field but the four is `400`.
- **The four `staff/*` steps are not granted by `strut/staff` yet:** its
  `app.yaml` grants them with the Payouts tab, in PR 3, so the page that
  calls them and its grants land together.
- **Ruling 7 with nothing owed** asks the wallet nothing: a strut that pays
  no worker withdraws as before.

**The Payouts tab** (§9.7) shows when `/tasks/payouts` answers. It has four
parts:

- **The switch**, at the top. Turning it on asks first, and says what it
  does: "Workers may withdraw what passed its hold to their own Sphinx
  address, up to the caps below, with nobody's yes per payment." Turning it
  off says: "No new withdrawal starts; those on their way finish."
- **The caps**, edited in place, each with today's use against it.
- **The wallet's cover**, from `earnings/read`, in red when short:
  "Withdrawals are refused while the wallet is short."
- **The list**: who, the address (shortened), the amount, the fee, the
  state, when, and a failure's words.
  - A stale payout has Read again, Record as paid and Drop, with the note on
    what only the worker's wallet knows.
  - A worker's page links to their payouts (`tab=payouts&worker=`), and
    `payout=<key>` opens one.

**The books.** `readEarnings` gains two fields in the unscoped view:

- `workers.outMsat`: the payouts on their way now;
- `workers.paidOut: { count, msat, feeMsat, days }` in the range, from the
  `withdrawal` entries with subject `worker`.

`withdrawn` stays the admin's own. `expectedMsat` needs no change, because
it already counts every send and every pending one. The Earnings tab and
`strut/earnings` show **Paid to workers** beside Withdrawn and Purchases,
and mark a payout in the pending list.

#### Abuse

| Case | What stops it |
| --- | --- |
| A worker asks again and again | One payout on its way at a time, the minimum, the day's cap, and the worker's 120 calls a minute (§5.2) |
| Two tabs at once | Each reaches the reserve, one statement at a time. The second meets the first on its way (`payout_out`), or a balance without it (`over_balance`) |
| A double click, a retry | `payout_out`, carrying the first. The daemon sends one id once |
| An address that is not the worker's | The address comes only from the worker's own sign-in. Its pubkey must be the key that signed, and is checked again at the payout. Only that key can claim a keysend to it. A wrong route hint makes the payment fail; it cannot pay anyone else |
| A worker app's page that wants the money (a builder's mistake, or a prompt injected into Jamie) | The page chooses only an amount, and the session decides where it goes. A page that withdraws unasked moves the worker's money to the worker's own account, at most for a fee, which is none within one mixer |
| A stolen visitor session | The same: it can pay only the session's address, and the session cannot be changed without the key |
| A race with a take-back or a review's restore | Those move only held earnings, and the reserve only released ones. Each is guarded on the time it runs at |
| A balance the page read seconds ago | The reserve reads it again, and refuses with the most the worker may ask now |
| Many accounts that each earned | A paid open type takes a newcomer only after K tests (ruling 9), earnings wait out the hold, and the server's day cap and the switch bound the whole |
| A bug that pays in a loop | The day caps, and one payout on its way per worker |
| A daemon that lost its ledger | The one way a keysend is paid twice (above). Back the ledger up with the daemon's state |

#### Tests that prove it

| File | What proves it |
| --- | --- |
| `src/payments/ledger.test.ts`, both stores | The reserve takes only what is withdrawable: a held earning is not, one a millisecond past `releases` is. Each refusal, in order. A settle writes one `withdrawal` entry (subject `worker`, the key as `ref`), and moves `out` to `withdrawn` with the fee capped. A failure gives the reserve back. The trigger refuses any other change. `owedToWorkers` and the balance leave out what is on its way. A take-back or a restore a millisecond before `releases` and a reserve a millisecond after never both count one earning, in either order. A file from before gains the tables and the column, and the suite as built passes unchanged |
| `src/payments/payouts.test.ts` (new) | With `FakeWallet` and a fake keysend payer: a payout settles at once; one `pending` stays reserved and settles at the minute's check; one `failed` is given back; a 404 on the read fails it; a crash between the reserve and the send is failed by the check; a stale one is resolved as paid or dropped. `no_address`, an address whose pubkey is not the actor's, `no_keysend` (NWC, or a daemon without the route), the switch off, a short wallet and an unreadable balance. An admin's Withdraw and a purchase refused `short_of_workers` |
| `src/payments/sphinx-daemon.test.ts` | The payer's keysend against a fake daemon: the request's shape, one id sent once, the GET read, the 404 that means never taken, `max_fee_too_low`, `own_address`, and a daemon without the routes read as `no_keysend` |
| `src/visitors.test.ts` | A `sphinx` sign-in with an address keeps it in the session when its pubkey is the key. Otherwise it keeps none and the sign-in still holds: another pubkey, a domain key, an older Peel with no address, another method. Signing in again refreshes it |
| `src/tasks/worker-door.test.ts` | End to end through `/public/mcp`: a run parks, a visitor signed in with a test key and address answers, the clock passes the hold, `task/me` shows `payout`, and `task/withdraw` pays the session's address. The books' expected balance equals the fake wallet's. Two calls at once: one pays, one is `payout_out`. A suspended and a banned worker withdraw. A member's page answers `no_address`, and a host's own store `not_here`. No step on the shared bag reaches a payout |
| `src/tasks/payout-routes.test.ts` (new) | The routes are full scope only, settings keep `changedBy`, and the `staff/*` steps reach the routes through the door |
| `src/payments/earnings.test.ts` | `workers.outMsat` and `paidOut`. A payout is in `expectedMsat` while pending and after. The cover does not move with a payout |
| `kit/src/wallet/protocol.test.ts`, `web/src/native-pay.test.ts`, `kit/src/hooks.test.ts` | The `sign_in` vectors with an address, and the vector pinning address and key to one seed. strut's UI drops an address whose pubkey is not `key`. `useWithdraw`, and `useWorker`'s `payout` |
| Live, once | The one-mixer check above, recorded in `docs/payments.md` |

**Built differently (#688):** PR 1's rows are proven over both ledgers where
they touch the ledger. Until PR 2 no session carries an address, so the
worker-door row is split: `worker-door.test.ts` takes `task/withdraw`
through `/public/mcp` and a member's `/mcp` (an amount alone, `no_address`,
a named address refused, `task/me`'s `payout`), and
`src/tasks/payout-routes.test.ts` pays through the task service and the
step with the address on the bag as the door will hand it (the session's
address paid, two at once, a suspended and a banned worker, a host's own
store `not_here`, the books beside the wallet, nothing on the shared bag).
PR 2 adds the payment through the door. The `earnings.test.ts` row
(`outMsat`, `paidOut`, `expectedMsat` while pending and after, the cover
unmoved) is in `payouts.test.ts` and `payout-routes.test.ts`; the daemon's
in `payer.test.ts`. The live one-mixer check waits for the daemon's routes.

#### PRs

Against `main`, never stacked.

1. **Strut's money side:**
   - the ledger's tables and calls, in both stores;
   - `payouts.ts`;
   - the payer's keysend for the daemon;
   - `withdrawals.ts`'s `keysend` kind, `worker` purpose and hooks;
   - ruling 7's refusal;
   - `task/withdraw` and `task/me`'s `payout`;
   - the `/tasks/payouts` routes and `staff/*` steps;
   - the books' `paidOut`.

   It updates `specs/API.md` §19 and §22, `docs/payments.md` and
   `docs/tasks.md`. The payer is built to the route above, against a fake
   daemon.
2. **Sign-in keeps the address, and the contracts:**
   - `POST /visitors/session`'s `address`, kept in the session, and the
     door handing it to a worker step;
   - `specs/WALLET.md`'s `sign_in` answer with `address`, `protocol.ts` and
     its vectors, and strut's UI passing it on;
   - `specs/LIGHTNING.md`'s `POST /keysend` and `GET /keysend/:id`;
   - `useWithdraw`, `WorkerInfo.payout` and the `App` page.

   It can be built beside PR 1: it touches sign-in, the kit and the specs,
   and PR 1 the money. Until both have merged, a worker has no address and
   `task/withdraw` answers `no_address`.
3. **The pages:** the Payouts tab in `strut/staff`; Paid to workers in the
   Earnings tab and `strut/earnings`; the Withdraw dialogs' refusal. It
   comes after PR 1 and is checked in the browser.

**Outside strut, separate repos:**

- **stakwork/sphinx:** the treasury daemon's `POST /keysend` and
  `GET /keysend/:id`, to LIGHTNING.md as PR 2 writes it.
- **stakwork/peel:** `address` in its `sign_in` answer when it signs with the
  root key.

Then one real withdrawal end to end, with the one-mixer check.

#### Not taken

- **An invoice from Peel, signed for each withdrawal** (#681's design). The
  page asked its host, Peel showed a sheet and made an invoice, and signed
  `strut-payout:<host>:<invoice>` with the sign-in key. Strut checked the
  signature, the invoice's amount and its expiry. It was dropped for paying
  the address (ruled 2026-11-13). The address gives the same guarantee,
  that only the worker's key can take the money, with none of that machinery:
  - no Peel sheet and tap for each withdrawal;
  - no new host op;
  - no signed message;
  - no invoice to check;
  - no invoice expiry to judge staleness by.
- **The page hands strut an invoice or an address.** A page a model wrote
  would choose where a worker's money goes.
- **LNURL-withdraw for a plain browser.** Whoever reads its link takes the
  money, a page included, and no worker needs it in v1.
- **An NWC treasury in v1.** NIP-47's `pay_keysend` has no route hints
  (above).
- **The address kept in its own table.** The session carries it, so nothing
  is written for a visitor who never works, and each sign-in refreshes it.

#### Ruled (2026-11-13)

Evan: "Accept all", and "Yes, redesign" to paying the address. Where the
redesign changes what a ruling covers, the ruling says so.

1. **The third door pays a worker's own withdrawal with nobody's yes per
   payment,** inside the settings and the solvency check. A yes per payment
   would make staff a payroll desk. The hold, the review and the take-back
   are where a person already says no. With the address, the worker's own
   call is the ask: the payment can only reach the address from their
   sign-in.
2. **Withdrawals are off until an admin turns them on.** A door that pays
   with nobody watching opens on a person's act, once, with the caps in
   front of them.
3. **The worker pays the routing fee, at most its cap.** The worker chooses
   when and how much, and a payout then leaves the cover as it was. Within
   one mixer the code moves exactly the amount (`shift_balance`), so the fee
   is likely none; the build checks it once.
4. **The minimum withdrawal is 1,000 sats.** The LSP's 5-sat floor is 0.5% of
   that amount.
5. **The caps are 1,000,000 sats a worker and 10,000,000 sats for the
   server, per UTC day,** as defaults staff can change (ruled again on
   2026-11-13: one answer may pay up to 1,000,000 sats, #665, and a worker's
   day must hold at least one such answer). They are a brake on a bug or a
   theft, well above a day of honest work.
6. **A suspended or banned worker may withdraw what passed its hold,** as
   8.1's ruling 6 has it. Staff take back inside the hold, and the switch
   and a mixer ban remain.
7. **A worker's withdrawal is refused while the wallet is short of what all
   workers are owed, held included.** Paying whoever asks first would leave
   the rest owed with nothing behind it.
8. **Ruling 7's refusal also covers an accepted `remote/buy-credit`:** every
   send that is not a worker's. Ruling 7's reason, that some of the sats are
   not the seller's, holds for a purchase too.
9. **One payout per worker may be on its way, and a stale one waits for
   staff.** It answers two tabs simply, and a stuck payment is when a person
   should look before more goes to that worker. With a keysend, stale means
   still pending a day after it was sent: there is no invoice expiry to
   count from.
10. **In v1 a worker withdraws only through Peel.** This still holds after
    the redesign: Peel is the one wallet that shares an address at sign-in
    today. Another wallet can send its address the same way later.
11. **A payout pays the worker's Sphinx address from their sign-in, by
    keysend, not an invoice** (the redesign). Peel's `sign_in` answer
    carries the address. Strut keeps it in the session when its pubkey is
    the key that signed. The treasury daemon gains a keysend route,
    idempotent on strut's key.

## 9. The staff app (item 6)

The staff are the client's admins, and only they (ruled, §9.12). They
make task types, let workers in, watch the queue and read what was
answered. Today they can only do that with `curl` against the `/tasks`
routes (§6). The staff app is those
routes as a page, the way `strut/earnings` is the `/earnings` routes as a
page. The page is only a face: the routes decide. A client's own
dashboard built by Jamie would need read steps a person grants it, and is
not in this item.

What §9.12 ruled is settled. Anything else below marked proposed is
still open.

### 9.1 What it is

| | |
| --- | --- |
| Name | `strut/staff`, title "Tasks and workers", icon `users`. The name is ruled (§9.12); the title and icon are proposed |
| Sources | `src/apps/staff/` (`app.yaml`, `src/App.tsx`, `src/lib/`, `src/components/`), checked by `npx tsc -p kit/tsconfig.staff.json`, excluded from the root tsc, as `strut/earnings` |
| Seed | `src/apps/staff-seed.ts`, a copy of `earnings-seed.ts`: `seedBundledApp` by tree hash at boot, after `strut/views` (it imports `TaskForm`). Seeded on every server, a served box too, as `strut/earnings` is |
| Opt-out | `createStrut({ staff: false })` and `STRUT_HOST_CONFIG`'s `"staff": false` (`hostConfigFromEnv`, `src/server.ts`) seed nothing |
| Who sees it | `admin: true` in its `app.yaml`: listed to full scope alone, its files `403` to anyone else (specs/API.md §14.14). First-party, so its door needs a viewer with an actor: an admin's session, or the key with `x-strut-actor` |
| Grants | the `staff/*` door steps (§9.3), `app/list` and `app/get` for the type editor's app picker. No workflows: it launches nothing |

**Framed for an admin.**

- **Strut's own UI.** The sidebar's Apps section lists it to an admin, as
  it lists `strut/earnings`. A waiting run links to it: the run overview's
  "Waiting on" line (`RunOverview.tsx`) and a parked step's flyout turn
  `task:<id>` into `?app=strut/staff&input=task%3D<id>`. With the bare
  key and no actor its calls are refused, as `strut/earnings`'s are (a
  first-party page needs a viewer), and the page says to sign in with a
  name.
- **A host (Stadeum).** It frames `?app=strut/staff&solo=1` for a person
  it signed in with `POST /auth/ticket { actor, role: "admin" }`, beside
  `strut/earnings`. Strut's UI never shows.
- **Deep links.** `input` takes one of `tab=queue|types|workers|tasks`,
  `type=<name>`, `worker=<actor>`, `task=<id>`, `run=<workflow>/<runId>`.
  Each move in the page is sent back as `ui/open-link` to the app, so a
  host's address bar follows, as `strut/knowledge` does.

**Built differently (#678):**

- **Its grants** are the `staff/*` steps, `app/list` and `earnings/read`.
  `app/list` already carries each app's grants, so the type editor's check
  needs no `app/get`. `earnings/read` (an admin's read in a first-party page)
  gives the Queue its line on what workers are owed.
- **Five tabs.** The Tests tab of §9.7 sits beside the four. The deep links
  also take `test=<id>` and `by=<actor>` (the tasks one worker answered).
- **A waiting run's link** shows only to a viewer `GET /apps` lists the app
  to, which means an admin (`web/src/waiting.ts`, `WaitingOn.tsx`). A member
  reads the text as before.

### 9.2 First: the task store off the shared bag

`ctx.services.tasks` is the whole capability today (#655, #657): `ensure`,
the worker's calls that take any actor, and the staff's calls. Any step on
the shared bag can reach all of it, a custom step the builder wrote
included. Such a step can grant itself a task type, list tasks with their
live lease ids and answer as another worker, or rewrite a type. Before
money (item 5a) that spoils answers; after, it also pays someone. "Money
settings stay behind a proposal" holds only once this is closed.

| Who | Gets |
| --- | --- |
| The shared bag, every step | `tasks: { ensure }`, the `human` step's, and `taskTypes` (§9.8): the types read, and a save that opens only for an accepted proposal |
| A `worker: true` step on the app door | the worker's calls (`TasksService.worker`), on that one call's bag. The signed-in visitor's bag already does this; the member's door (`POST /mcp`) does it the same way in `dispatch` (`src/apps/tools.ts`) |
| The staff | the routes alone, which hold `strut.tasks` itself. The staff app reaches them through its door (§9.3) |

`worker-door.test.ts` must pass unchanged. A host that brings its own
`services.tasks` keeps it as it is.

### 9.3 The door

`src/steps/lib/staff/`, in the `earnings/*` pattern:

- `_door.ts` refuses unless `ctx.app` is first-party and `admin`, as
  `earnings/_door.ts` does. The check moves into one helper both import.
- The door is `staffAdmin` in createStrut: one request to a `/tasks…`
  route, in process, in the viewer's name (`inProcessRequest`), and to no
  other path. The app door hands it beside `earningsAdmin` in
  `adminServices`, so a grant's `by` and a type's `changedBy` name the
  admin who did it.
- A route's refusal is the step's error, its `code` first
  (`bodyOrThrow`).

| Step | Route | Answers |
| --- | --- | --- |
| `staff/stats { type? }` | `GET /tasks/stats` (new, §9.4) | the queue |
| `staff/types` | `GET /tasks/types` | `{ types }` |
| `staff/save-type { name, app, answer, leaseSeconds?, withinHours?, enabled? }` | `PUT /tasks/types/:name` | `{ type }` |
| `staff/delete-type { name }` | `DELETE /tasks/types/:name` | `{ name, revoked }` |
| `staff/workers { status? }` | `GET /tasks/workers` | `{ workers }` |
| `staff/worker { actor }` | `GET /tasks/workers/:actor` (new) | one worker and what they did |
| `staff/set-worker { actor, status?, note? }` | `PUT /tasks/workers/:actor` | `{ worker }` |
| `staff/grant { actor, type }` | `PUT /tasks/workers/:actor/grants/:type` | `{ worker }` |
| `staff/revoke { actor, type, why? }` | `DELETE /tasks/workers/:actor/grants/:type` | `{ worker }` |
| `staff/tasks { type?, status?, workflow?, runId?, by?, before?, limit? }` | `GET /tasks` (`by` new) | `{ tasks }` |
| `staff/task { id }` | `GET /tasks/:id` (`run` new) | `{ task }` |
| `staff/file { task, path }` | `GET /tasks/:id/files/<path>` (new) | one file, as `run/files` answers |

`staff/save-type` is not `task/set-type`: the first is an admin's own act
in the page; the second is the builder's ask (§9.8). Neither is a worker's
`task/*` step.

**Built differently (#678):**

- **One shared door.** `src/steps/lib/_admin-door.ts` holds the check
  (`adminDoorOf`), `bodyOrThrow` and the in-process door (`inProcessDoor`,
  the routes it reaches as a pattern: `STAFF_ROUTES`). `earnings/_door.ts`
  is now a thin layer over it. A `Uint8Array` body goes as raw bytes, for a
  test's file.
- **More steps.** Items 4 and 5a were built first, so their steps are here
  too. `staff/take-back { task, worker?, why }` is `POST
  /tasks/:id/take-back`. Item 4's are `staff/tests`, `staff/test`,
  `staff/save-test` (a new test, or with `id` a change before it is first
  served), `staff/test-file` (base64), `staff/test-from-task` and
  `staff/retire-test`. `staff/grant` takes `qualify`, and `staff/tasks`
  takes `test`.
- **What the steps carry stays behind the routes.** A call through an admin
  door runs on `adminBag` (src/apps/tools.ts): the doors beside the shared
  bag, but without the deployment's `onRunEvent`. A host's own listener is
  handed every event in full, and a `staff/tests` read's `step.end` holds the
  expected answers; this is how a grader's run is handled already. The
  events sink only ever sent envelopes, and it loses these page reads. The
  steps that write an expected answer list it in `redact`. The app monitor
  keeps a failing call's config as an example, so it now redacts a step's
  `redact` fields first (`redactedConfig`). `GET /apps/:name/usage` refuses
  anyone but an admin for an admin-only app, as its versions do.

### 9.4 Reads the routes lack

What the routes answer today: the types, the workers by status, a page of
tasks by type, status, workflow or run, and one task with its leases. What
the screens need beside that:

| Route | Answers | How |
| --- | --- | --- |
| `GET /tasks/stats[?type=]` | per type: `waiting` (open, no live lease), `working` (open with a live lease), `oldest` (the oldest waiting task's age), `dueSoon` (open tasks due within 24 h), `granted` (live grants), `app` (§9.5's problems with its app); per window (last hour, day, week): `answered`, `expired`, `cancelled`, `skipped`, `leasesLost` (leases that ran out), `toAnswer` and `work` (p50 and p90 in ms). Across types: workers by status, `holding` (a live lease now), `asking` (a held `task/next` now) | Computed on read, never stored. Counts by index; medians over the newest 1,000 answers in the window. `asking` is the service's in-memory list of held waits |
| `GET /tasks?by=<actor>` | the tasks an actor answered, newest first | a filter beside `type`, `status`, `workflow`, `runId` |
| `GET /tasks/workers/:actor` | `{ worker, holding?, week: { [type]: { answered, skipped, lost } }, recent: [{ lease, task: { id, type, workflow, runId, status } }] }`, the newest 50 leases | the worker record and their leases |
| `GET /tasks/:id` | adds `run: { status, waitingOn? } \| null` | the run store's summary for the task's run |
| `GET /tasks/:id/files/<path>` | one file on the task's list, as `run/files` answers one (`fileResult`); `404 not_listed` for any other path | the same read `task/file` uses (`deps.file`), without a lease |

All full scope only, like the rest of §6. `/tasks/stats` is mounted before
`/tasks/:id`. Four new indexes, each `create if not exists`: a task's type
and `settled_at`, a task's `by`, a lease's type and `closed`, and a lease's
worker and `taken`. The memory store answers the same. **Proposed:** the
page reads the stats every 10 s while it is shown, none while hidden.

**Built differently (#678):** none of §9.4 was on the routes after #671 and
#675. #671's `GET /tasks/workers/:actor` answered `{ worker }` alone.

- **`/tasks/stats`.** What is wrong with a type's app is `appProblem`; the
  row's `app` is the type's app name, beside `enabled`. The Queue's
  "expires within the hour" needs `dueHour` beside `dueSoon`. The Queue
  table shows `holding` and `asking` per type, so they are per type as well
  as across. Each window counts `disputed` too. Test instances are not the
  queue, so none is counted. A task past due is counted as expired at its
  due, before the sweep marks it, as a dead lease is waiting and lost.
  `answered` counts answers, every copy's. The newest 1,000 times of the
  week are read once and serve all three windows, since the newest of a
  day are among them.
- **`?by=`** is any answer the actor gave, a copy's included, not only the
  task's `by`: a disputed task has no `by`. It reads the existing
  `leases_answered` index, so three indexes are new, not four:
  `tasks_settled (type, settled_at) where test is null`,
  `leases_type_closed (type, closed)` and `leases_worker_taken (worker,
  taken)`.
- **`GET /tasks/workers` rows gain `week`** (answers in 7 days) and
  **`holding`** (the type of their live lease), in one grouped read
  (`workersNow`). §9.5's Workers list shows both. A worker's own `week`
  counts the leases taken in the last 7 days.
- **`run`** is `running` (live in this process), the summary's status with
  `waitingOn`, `stale` (started, never finished, not live), or null. A test
  instance's is null.
- **A task's file** also answers `404 no_file` when it is gone. An
  instance's files are its test's.
- **A host's own store** answers `501 not_available` on each new route its
  capability lacks.
- **The 10 s read** is built as proposed: React Query's interval, which does
  not run while the page is hidden.

### 9.5 Screens

Four tabs, deep-linkable. On a phone each list opens to its detail and
back.

**Queue** (the tab it opens on). One row a type:

| Column | From `staff/stats` |
| --- | --- |
| Type, its app, on or off | the type |
| Waiting, being worked | `waiting`, `working` |
| Oldest waiting | `oldest` |
| Due within a day | `dueSoon` |
| Answered: hour, day, week | `answered` per window |
| Time to answer (made → answered) and work time (taken → answered) | `toAnswer`, `work`, last day |
| Skipped, leases lost, expired | last day; expired over the week |
| Workers: granted, holding a lease, asking now | `granted`, `holding`, `asking` |

Above the table, one line each for what needs a person: a type with tasks
waiting and nobody granted it; tasks that expire unanswered within the
hour; a type turned off that still has open tasks; a type whose app is
missing or does not grant `task/next` and `task/submit`; workers who are
`new` and wait for a grant (a link to them). A row opens the type.

**Types.** A list (name, app, on, waiting, workers granted), **New type**,
and the editor:

- **Name** on a new type only, held to the store's rule (lowercase
  letters, digits, `.`, `_`, `-`, segments joined by `/`). A saved name is
  fixed: a type under another name is a new type, and the old one keeps
  its grants and tasks.
- **App**, picked from this server's apps (`app/list`). Beside it what is
  wrong with it, read with `app/get`: not here, or its grants lack
  `task/next` or `task/submit`. The same check sits in `/tasks/stats`
  (`app`) and on `task/set-type`'s card, one function.
- **Lease** in minutes (`leaseSeconds`) and **Expires unanswered after**
  in hours (`withinHours`), with the store's bounds.
- **On or off.** Turning it off says what it does: a `human` step can
  make no new task of it, and its open tasks are not handed out and
  expire when due.
- **The answer's shape**, below.
- **Save** is `staff/save-type`, the whole type. A save that changes the
  answer's shape of a type with open tasks says how many first: their
  answers are checked against the new shape when submitted.
- **Delete** is offered only when no task of the type is open, and says
  how many workers lose the grant. Otherwise the page says to turn it off
  and let them settle (`409 in_use`).
- **Workers** who hold the type, with Revoke, and Grant (a picker over the
  workers here).

**The answer's shape.** The editor writes only what
`src/tasks/answer-schema.ts` checks, so it never offers to save what the
route refuses.

- The check moves to `kit/src/folds/answer-schema.ts`, pure, and the
  store imports it from there (`Buffer.byteLength` becomes `TextEncoder`).
  The page runs `answerSchemaProblem` on every change.
- **The answer is** a form of fields, or one value of a kind (a box on a
  photo is one value: four numbers).
- A field has a key, a label (`title`), help (`description`), whether it
  is required, and a kind:

  | Kind | Writes |
  | --- | --- |
  | Text | `string`, with `minLength`, `maxLength` |
  | Number, whole number | `number`, `integer`, with `minimum`, `maximum` |
  | Yes or no | `boolean` |
  | Pick one | `enum` of strings or of numbers |
  | Pick several | `array` of an `enum`, with `minItems`, `maxItems` |
  | Numbers | `array` of `number`, with `minItems`, `maxItems` |
  | Group | `object` with fields of its own, to the subset's eight levels |

- **JSON** shows the schema and takes edits. A schema the subset takes but
  the kinds above cannot draw (an `enum` on an object, an array of groups,
  `null`) stays in JSON, with a line saying so.
- **Preview** draws `TaskForm` (`strut/views`) from the schema: what a
  worker sees when the app has no view of its own. When `formProblem`
  answers, the preview shows its sentence instead: the app must draw this
  type itself.

**Workers.** A list, `new` first: the people who signed in and wait.
Columns: who, status, first seen, the types they hold, answers this week,
holding a lease now.

- **Who** is the actor shortened (`secp:3fa2…91c`), with the note's first
  line as a name when there is one. **Proposed:** the store keeps no name
  of its own; the note is the staff's label.
- **A worker** shows their status with Activate, Suspend, Ban and Lift.
  Ban asks first. Suspend and Ban say that a lease they hold ends now.
- **The note**, edited in place (`staff/set-worker { note }`).
- **Grants**: each live grant with Revoke (a reason asked, kept as `why`),
  Grant from the types here, and revoked grants below with when, who and
  why. Granting a `new` worker makes them `active`, and the page says so.
- **What they did** (`staff/worker`): the week by type, and their newest
  leases (answered, skipped, ran out), each opening its task.
- **Several at once**: tick `new` workers and grant one type to each. One
  door call per worker; the page says which failed.

**Tasks.** Filters: type, status, workflow, run, answered by. Newest
first, a page at a time (`before`). A row: made, type, status, the run,
due, who answered, leases. **A task** shows:

- What the worker was shown: `show` as a JSON tree, and its files, each
  opened through `staff/file` (an image drawn, text shown, anything else
  downloaded).
- Its leases in order: who, taken, how it closed (answered, skipped,
  ran out, ended early) and why.
- The answer and who gave it. When the type's schema draws as a form, the
  answer is shown in that form, read only (`TaskForm` gains a read-only
  mode).
- **The run**: the workflow, the run id, the step's path and the run's
  status now (`run`). **Open the run** sends the strut deep link
  `?wf=<workflow>&run=<runId>` as `ui/open-link`. Strut's own UI opens it.
  A host that never shows strut's UI does what it chooses; the status is
  on the page either way.

**Built differently (#678):**

- **The answer-schema check is one file in two places, not moved.** The
  engine's `tsc` has `rootDir: src`, so the store cannot import
  `kit/src/folds/answer-schema.ts`. `src/tasks/answer-schema.ts` and the
  kit's copy are kept the same byte for byte by a test in
  `answer-schema.test.ts`. Neither imports anything, and both count bytes
  with `TextEncoder`. `taskAppProblem` (§9.5's check of a type's app) is in
  the same file, so the Queue's `appProblem` and the type editor give the
  same sentence.
- **A save sends the whole type**, every part of it. A part the page does not
  show (pay on a server that answers none) is sent back as it was, so a PUT
  never drops it.
- **A one-value shape** has its own kind picker beside "The answer is".
- **Revoke and Take back ask why on a line in the page.** A framed app is
  sandboxed without modals, so `window.prompt` returns nothing.
- **Items 4 and 5a are in the screens** (§9.7). Tasks also shows each
  answer's earning with Take back while held, a copies task's answers and
  whether each agreed, and "make a test of it" for an answered or disputed
  task.
- **TaskForm's read-only mode** is `readOnly` with `value`. Without
  `onSubmit` or `onSkip` it draws no buttons.

### 9.6 Answers to review

A settled answer has woken its run, and the run has gone on: written a
node, told an owner, finished. Nothing in this app can take that back.
So review is a mark on the answer, never an undo of the run.

- **In item 6:** the Tasks tab with `status: settled`, by type and by
  worker, is the review queue. Staff act on the worker (note, suspend,
  revoke), not on the answer.
- **The verdict (ruled, §9.12):** a person marks a settled answer `ok`
  or `rejected`, with a reason. It changes nothing in the run. It may be
  changed until the earning's hold ends, then it is final. A table of its
  own, `reviews` (task, verdict, why, by, at), one row a task. `PUT
  /tasks/:id/review`, `staff/review`, and a `review=none|ok|rejected`
  filter on `GET /tasks`.
- **What a rejection does later:** with item 4 it counts against the
  worker's standing as a failed test does (§7 decides how). With item 5a
  a rejection inside the earning's hold takes the earning back, as a
  failed test inside the hold does (§8); after the hold it changes no
  money.
- **Checking before the run goes on** is the workflow's: a second `human`
  step of a review type after the first, or copies (§7).

**Built differently (#680):**

- **One verdict per ANSWER, not per task.** Copies (#675) give a task
  several answers from different workers, and earnings and standing are
  per worker, so `reviews` is keyed by the task and the worker (one row
  an answer, replaced when it changes). For a one-copy task that is one row
  a task, as ruled. `PUT /tasks/:id/review { worker?, verdict, why? }`
  takes `worker` only when the task has several answers. Only a real
  task's answer: a test's is graded (`400`).
- **`why`** is required for a rejection; `ok` may carry one.
- **When it is final.** A verdict can change until the answer's hold ends:
  its earning's `releases` (a paid answer not booked yet is booked first),
  or, for an unpaid answer, the type's `holdHours` from when it was
  answered. A FIRST verdict may still be given after that (§9.6: "after
  the hold it changes no money"); it is final at once. A change after it
  is `409 final`. Each lease's verdict carries `until` and `final`.
- **Standing (§7.5).** A rejection is a `fail` in the window, at the time
  the answer was given, for answers given since the grant, and the
  standing check runs after it as after a grade, so it can revoke. `ok`
  takes it out of the window; it is not a pass (tests score workers, §7.6).
  A revoke a rejection caused stays: staff grant again, which starts an
  empty window as any re-grant does. Qualifying (`gradedAll`) counts tests
  alone, and a revoke with a rejection in its window never reads
  `qualifying:`; its `why` adds `(2 of them answers rejected in review)`.
  A type with no tests has no standing rules, so a rejection there moves
  none. `standing` gains `rejected`.
- **Money: a take-back a rejection made is undone by `ok` inside the hold**
  (Evan's pick of three options, 2026-11-13). Ruling 4 has a rejection
  inside the hold take the earning back, and ruling 5 says a mistaken
  rejection does not cost the worker pay, but #664's ledger made a
  take-back one-way (a trigger let the take-back columns be set once and
  never cleared). So the ledger gains `restore`: one statement guarded on
  the hold (`… where taken_back is not null and releases > now`) clears
  the take-back whole, the payee's and the day's taken-back counts go back
  down, and the take-back it cleared is appended to a new append-only
  table, `pay_restores`. #664's trigger `pay_take_back_once` is dropped at
  every open and `pay_take_back_or_restore` allows that one more change.
  A rejection's take-back says `review: <why>`, by the reviewer; `ok`
  restores only such a take-back, never one by hand or a graded test's. A
  take-back is final once the hold ends, and only held money moves, which
  cannot be withdrawn, so paid money never moves back. Not taken: taking
  back only when the hold ends (the ledger untouched, but a rejected
  earning shown as held for up to 72 hours, and a sweep that must land
  before the release), and never restoring (against ruling 5).
- **The review queue** is `GET /tasks?review=none` (real tasks with an
  answer no verdict was given on), beside `ok` and `rejected`, each with
  `by` for one worker's answers.
- **The staff app.** The Tasks tab's Review filter and column, a task's
  Review section (Mark ok, and Reject with its reason on a line in the
  page), and a worker's newest leases with their verdicts and links to
  their answers to review and their rejected ones. A host's own store
  answers no review (`501`), so none of it shows there.

### 9.7 Places for later items

Each later item adds its part here. The page shows a tab or a column only
when the server answers for it, never an empty "coming soon".

| Item | Where it shows | What the staff app adds |
| --- | --- | --- |
| 4, tests and standing (§7) | A **Tests** section in the type editor; a **Tests** tab; a **Standing** column on Workers and on a type's workers | The type's test settings, its test tasks (add, edit, retire; their answers and how they are graded), each worker's standing per type and their test history, and an automatic revoke shown in the grant history with its reason. Test tasks are read through new `staff/*` steps only: the sealed table never reaches a run or a worker |
| 5a, earnings (§8) | A **Pay** section in the type editor; **Earned**, **Held** and **Withdrawable** columns on Workers; a line on Queue | The type's pay and hold; what each worker earned and is owed. Queue says what is owed to all workers beside what the wallet holds. The total owed also shows in `strut/earnings` beside the credit owed as service (§8, "Books") |
| 5b, payouts | A **Payouts** tab | Withdrawals by workers (on their way, paid, failed), the caps per worker and per day, and a switch that stops every worker's withdrawals at once |

**Built differently (#678): the places of items 4 and 5a came with PR 1.**
§9.10 assumed item 6 would come first; items 4 and 5a were built before
it, and their routes answer. What shows is decided in the page
(`shownOf`, `src/apps/staff/src/lib/view.ts`), never as an empty "coming
soon":

- The **Tests** tab and a type's Tests and Copies sections show when the
  test routes answer. A host's own task store answers `not_available`.
- **Standing** shows when the workers carry it and some type has tests.
- The **Pay** section shows when the types carry `holdHours`.
- **Earned, Held and Withdrawable** show when the workers carry a balance
  and some type is paid or someone is owed.
- The **Queue's line** shows when `earnings/read` says any worker was ever
  paid (`showsWorkers`' rule).

An automatic revoke shows in a worker's grant history as "by standing
(automatic)" with its `why`. Tests are read and written only through the
`staff/*` steps. 5b has no place yet.

### 9.8 `task/set-type`

The builder writes the workflow with the `human` step and the worker app,
so it is the one that knows a type is needed. It may ask for one. It may
not make one.

The builder calls it as a tool, which records a proposal (its seed lists
it in `approve:`):

```jsonc
{ "name": "pet-match", "app": "workers", "withinHours": 48,
  "answer": { "type": "object", "properties": { "same": { "type": "boolean" } }, "required": ["same"] },
  "rationale": "The pets workflow sends low-confidence matches to a person." }
```

- **The step.** `src/steps/lib/task/set-type.ts`, `effect: "write"`,
  `approver: "admin"`, no `worker` flag. It runs only as a proposal an
  admin accepted (`ctx.proposal`), as `package/install` and
  `remote/buy-credit` do. A direct tool call, a workflow's step,
  `meta/run-step` and a subflow are refused.
- **Input.** `{ name, app, answer?, leaseSeconds?, withinHours?, enabled? }`,
  later the pay and test fields of items 4 and 5a. It is merged over the
  type when there is one (ruled, §9.12), so a field left out is kept as it
  is, not reset to the default. A new type needs `answer`. The input schema runs
  `answerSchemaProblem`, so a shape strut cannot check is refused to the
  model before any proposal is made.
- **The door.** `ctx.services.taskTypes` (§9.2) is `list()` (each type
  with its open tasks and the workers who hold it) and `save(name, input,
  { proposal, actor })`. `save` reads the proposal's record on disk: an
  `accepted` `task/set-type` record for that name and that input, the
  person's edits included, as `package/install`'s door does. A forged
  `ctx.proposal` opens nothing. The type's `changedBy` is the admin who
  accepted.
- **What it cannot do (ruled, §9.12).** It grants no worker, deletes no
  type and changes no worker. Those stay a person's, in this app.
- **Its read twin.** `task/types` (`effect: "read"`, over `list()`): the
  types here, each with its app, answer shape, on or off, open tasks and
  workers. The builder needs the names before it writes a `human` step.
- **Seeds (ruled: the builder's alone, §9.12).** The `builder` seed
  grants `task/types` and `task/set-type`,
  and lists `task/set-type` in `approve:`. Not `job` or `orchestrator`: a
  task type comes with a workflow, and workflows are the builder's. Not
  the builder chat, which has no proposals: there the person uses this
  app. The `Workflow Builder` page says when to ask for a type and that
  the worker app must grant the `task/*` steps.

**The card** (`describe`), read at proposal time:

| Field | Shows |
| --- | --- |
| Title | "New task type pet-match", "Change task type pet-match" or "Turn off task type pet-match" |
| Drawn by | the app, marked as a danger when it is missing or does not grant `task/next` and `task/submit` (§9.5's check) |
| The answer | one line per field ("same: yes or no, required"), or "needs the app's own view" with the schema when `formProblem` answers |
| Lease, expires after, on | in minutes, hours, on or off |
| What changes | for a change, each field before and after |
| Open tasks | how many; for a new answer shape, that their answers are checked against it |
| Workers | how many hold it |
| Pay (item 5a) | in sats and in dollars at the rate, and what it would have cost over the last week's answers. A rise is marked as a danger |

Actions: "Save type", "Don't".

**Built differently (#679):**

- **The pay, test and copies fields came in this PR.** Items 4 and 5a
  were built first, so the input is `PUT /tasks/types/:name`'s whole body
  beside the name: `paySats`, `holdHours`, `tests` and `copies` too. The
  input schema (`typeChangeInput`, `src/tasks/set-type.ts`) holds each
  field to the store's check: `answerSchemaProblem`, the tests and copies
  rules' own checks on their shape, the bounds, pay to the msat. A grader
  step is checked when the type is saved, since a schema has no registry.
- **The merge goes one level into `tests` and `copies`.** An object is
  merged over the type's own rules (or §7.8's defaults), so `{ rate: 0.1 }`
  keeps the rest; `null` turns them off.
- **A new type with no `answer` is refused at the save, not before the
  proposal.** The schema cannot know whether the type exists. The card
  says so as a danger and that accepting fails; the apply fails
  `bad_request:`. A merge the save would refuse (a `tests.window` under
  the type's own `qualify`) is shown the same way.
- **`list()` counts the workers, never names them, and leaves out
  `changedBy`.** It is on the shared bag, which every step reaches, and who
  holds a type is the staff's to read (the routes are full scope). Each type
  has `open` (waiting and being worked), `workers` (live grants) and
  `answeredWeek` (for the card's cost line), read from `stats()`; a host's
  own store that answers no queue leaves them out.
- **The door has the card's two reads beside `list` and `save`:**
  `appProblem(app)` (§9.5's `taskAppProblem`) and `usdPerBtc()`. `save`
  also wants the record's `approver: "admin"`, and refuses
  `set_type_needs_admin:`.
- **The card.** Open tasks shows for a change only (a new type has none).
  Workers on a new type says it is granted to nobody. Tests and Copies
  are fields of their own. A rise in pay from nothing (a new paid type) is a
  rise. The answer's form check is `formProblem`, a copy of the kit's
  (the engine's build cannot import the kit), held to the same verdict by
  `set-type.test.ts`.
- **A member's accept** goes through strut's own app (`proposal/decide`)
  and is refused `admin_required:`; a member's session reaches no
  `/proposals` route at all.
- **The `App` Concept page** also points at `task/set-type` where it says
  a task type is an admin's.

### 9.9 Money settings

A type's pay and hold (item 5a) and the payout caps and switch (item 5b)
are money settings.

- An admin sets them in this app directly: the admin is the person whose
  yes a proposal would ask for.
- An agent sets a type's pay and hold only through `task/set-type`, which
  an admin accepts. Nothing grants an agent the payout caps.
- A workflow's YAML never sets them (§6), and a member never reaches them:
  the routes are full scope.
- They hold only once §9.2 has closed the shared bag.

### 9.10 Building it

Item 6 needs only item 3. §9.2's split lands first, in a PR of its own
(ruled, §9.12). Item 6 then lands as two PRs against `main`, each
branched after the one before merged:

1. **The app.** The reads of §9.4, the moved answer-schema check, the door and its steps,
   `strut/staff` with Queue, Types, Workers and Tasks, its seed and
   opt-out, and the run overview's link to a waiting run's task.
2. **`task/set-type`.** The step, `task/types`, `taskTypes.save` and its
   check of the record, the card, the `builder` seed's grants, and the
   `Workflow Builder` page. Until it lands, the shared bag's `taskTypes`
   is `list()` alone.

Each updates `AGENTS.md` and specs/API.md (§22's new reads, a `strut/staff`
part beside §14.14). The verdict (§9.6) is ruled and comes after them.
**Built differently (#678):** PR 1 updates the area docs (`docs/tasks.md`,
`docs/apps.md`, `docs/web.md`, `docs/payments.md`), not `AGENTS.md`, which
holds only rules since #668. The `strut/staff` part is specs/API.md §14.15.
Cancelling one task is not in item 6 (ruled). The places of §9.7 come
with items 4, 5a and 5b.
**Built differently (#679):** PR 1 put no `taskTypes` on the bag, so its
`list()` and `save` came together in PR 2.

### 9.11 Tests

| What | Proves it |
| --- | --- |
| The bag | A custom step's `ctx.services.tasks` has `ensure` alone, and its `taskTypes.save` refuses without an accepted record. A member's worker page and a signed-in visitor's still take and answer: `worker-door.test.ts` unchanged |
| The door | Each `staff/*` step refuses a member's session on the same page, a model-written app that grants it, a workflow's step and an agent's tool. The door reaches `/tasks…` alone. A grant made through it records the admin as `by` |
| The app's listing | `GET /apps` lists `strut/staff` to full scope only; its files are `403` to a member. `staff: false` and `"staff": false` in `STRUT_HOST_CONFIG` seed nothing |
| The stats | On both stores, with a fixed clock: waiting and being worked, a lease past its expiry counted as waiting before the sweep marks it, each window's edges, the medians, `asking` while a `task/next` is held |
| The reads | `GET /tasks?by=`; one worker's week and leases; a task's file, and `404 not_listed` for a path not on its list; a task's run status |
| `task/set-type` | A direct call is refused. The builder's call records a proposal with the card's fields. A shape strut cannot check is refused before any proposal. A member's accept is `admin_required:`; an admin's saves the type with `changedBy` set to them. A forged `ctx.proposal` with no accepted record is refused. The person's edits are merged and checked again. A field left out keeps its value |
| The page | Its pure parts in `src/apps/staff.test.ts`: the editor's model to schema and back, every schema it writes passing `answerSchemaProblem`, a schema it cannot draw opening in JSON, the Queue's warnings, the deep-link input. `npx tsc -p kit/tsconfig.staff.json` |

**Built differently (#678):** "The bag" row was #663's. PR 1's tests are:

- `src/tasks/staff-reads.test.ts`: the stats and the reads over both
  stores, with a fixed clock.
- `src/apps/staff.test.ts`: the page's pure parts, the draft, the door, the
  seed and listing, and the page's calls as an admin, a member, a visitor
  and a peer. It also shows that items 4 and 5a show only when the server
  answers for them, and that no expected answer reaches a run, an event a
  listener hears, the monitor or a file on disk.
- `web/src/waiting.test.ts`: the waiting run's link.
- The answer schema's two copies, in `answer-schema.test.ts`.

The `task/set-type` row is PR 2's. **Built differently (#679):** PR 2's
tests are `src/tasks/set-type.test.ts`, every part of the row. It also covers
a custom step calling `taskTypes.save` with no accepted record, a
`meta/run-step` and a subflow, the card's dangers, that no test's expected
answer reaches the record, `task/types`, and the seeds. `builder-seed.test.ts`'s
approve lists gain `task/set-type`.

### 9.12 Ruled (2026-11-12)

Evan: "I agree with all the recommendations."

1. **The name is `strut/staff`,** with door steps `staff/*` and the
   option `staff: false`: it is this plan's word, `tasks/*` would sit one
   letter from the worker's `task/*`, and `createStrut({ tasks: false })`
   would read as turning off the task store.
2. **§9.2's split lands on its own, before item 6** (and before item 5a
   at the latest): today a step the builder writes can grant itself a
   type or answer as another worker.
3. **Staff are admins only.** Only full scope reaches the routes and this
   app. A reviewer role (reads and marks answers, changes nothing else)
   can come when a client asks for one.
4. **Review is a mark (§9.6).** A verdict changes nothing in its run; it
   counts against standing (item 4) and takes back an earning still in
   its hold (item 5a). The run has already acted on the answer, and
   checking before the run goes on is the workflow's to model.
5. **A verdict may be changed** until the earning's hold ends, then it is
   final, so a mistaken rejection does not cost a worker pay, and paid
   money never moves back.
6. **`task/set-type` is the builder's alone,** merges over the type, and
   has no twin for grants, deletes or workers: letting workers in and
   deleting a type are a person's acts, and a merge keeps a model from
   resetting what it left out.
7. **Cancelling one task is not in item 6** (`POST /tasks/:id/cancel`,
   which would wake its run with `task_cancelled:`): a task nobody can
   answer expires, and the run's own cancel exists.

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
- Invitation codes behind the qualifying tests.
- A default worker app for task types that need only `TaskForm`.
- Other things that park: a timer, a proposal awaited in a run, a wait on
  another strut's run.
- `human` in a public run.

**Open**

- A run that fails with a task still open keeps it (§3, built differently
  in #656): a worker may answer for a run nobody resumes, until the task
  expires.
- Payments per second through one Sphinx daemon.
- Whether a standalone box replaces the Stadeum for some clients.
- Whether workers one day see one balance across clients.

**Fixed** (found building items 1 to 2b; fixed in stakwork/strut#682)

- A parked run let go of its job, and on wake the journal replayed
  `job/dir` without taking the hold again. Now every durable resume takes
  it again where `job/dir` replays, and waits for a run that took the job
  meanwhile (§2.3, built differently).
- A cancel that reached a live run after its last checkpoint was lost when
  every branch that did not finish parked: the run ended `waiting`, not
  `cancelled`. Now a cancelling run ends `cancelled` and its sources are
  told (§2.4, built differently).
- `PUT /public-view` took a runnable workflow with a `human` step, whose
  public runs could only fail `park_refused:`. Now the save refuses a
  workflow whose closure reaches `human`, and `human` as a runnable step,
  naming it.

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
| 3 | **The worker's door** (§5, §6). The `task/*` steps, `worker: true`, the visitor rule and bag, the budgets, the `/tasks` routes, `useTask`, `useWorker`, `useTaskFile`, `TaskForm`, the `App` page | 2b | **Built**: stakwork/strut#657. Differs in §5.1–§5.3, §6; the store taken off the shared bag in #663 (§9.2) |
| 4 | **Tests, copies and standing** (§7). Designed and ruled in #662; three PRs (§7.11) | 3 | **4a built**: stakwork/strut#671 (tests, grading, standing, qualifying). Differs in §7.1–§7.5, §7.7, §7.9, §7.10. **4b built**: stakwork/strut#675 (copies). Differs in §7.6, §7.7; whether a disagreeing copy keeps its earning is open (§7.6). **4c built**: stakwork/strut#676 (the shipped graders, `grade/overlap` and `grade/judge`). Differs in §7.4 |
| 5a | **Earnings recorded and shown** (§8): the earning on an accepted answer, the hold, the balance in `task/me`, the run's cost. No money leaves | 3 | **Built**: stakwork/strut#664 (the earning) and stakwork/strut#666 (the books). Differs in §8.1 |
| 5b | **Withdraw** (§8.2): the payer's third door, a keysend to the worker's Sphinx address. Designed in #681, ruled in #687. Peel's side is stakwork/peel's and the daemon's keysend stakwork/sphinx's | 5a | **PR 1 built**: stakwork/strut#688 (strut's money side: the ledger's payouts, `payouts.ts`, the payer's keysend, `withdrawals.ts`' keysend kind and hooks, ruling 7's refusal, `task/withdraw` and `task/me`'s `payout`, the `/tasks/payouts` routes and `staff/*` steps, the books' `paidOut`). Differs in §8.2. PR 2 (sign-in keeps the address, the contracts, the kit) and PR 3 (the pages) not yet |
| 6 | **The staff app** (§9), with `task/set-type` | 3; shows more after 4 and 5a | **Built**: stakwork/strut#678 (PR 1, the app, with §9.7's places for items 4 and 5a) and stakwork/strut#679 (PR 2, `task/set-type` with `task/types`, the door and the builder's seed). Differs in §9.1, §9.3–§9.5, §9.7, §9.8, §9.10, §9.11. **The review verdict built** (§9.6, after item 6 as §9.10 said): stakwork/strut#680 — per answer, standing, a rejection's take-back undone by `ok` inside the hold (the ledger's `restore`), the staff app's Review. Differs in §9.6 |
| 6, open types | **Open task types** (ruling 9): `open` on a type, true by default; a paid open type needs K ready tests to be saved and to take a newcomer; a worker's first ask records an `open` grant through 4a's machinery; Open / Invite-only in `strut/staff` | 4a, 6 | **Built**: stakwork/strut#685. Differs in §5.2, §6, §7.5 |
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
