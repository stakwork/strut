# Human steps and the task store

People as a step of a workflow: the task store, workers, and the worker's steps.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **The task store — people as a step of a workflow** (`plans/human-steps.md`
  §4, item 2a; `src/tasks/`). A `human` step (item 2b) makes a TASK keyed by
  its workflow, run id and step path and parks its run; a WORKER signed in to
  the worker app takes the next task of a type an admin granted them, answers
  it, and the answer settles the task. Strut's own SQLite file
  (`<dataDir>/tasks/tasks.db`, the ledger's pattern), never an app's SQL: a
  worker reaches a task only through their own LEASE, one live at a time, one
  answer per lease checked against the type's answer schema (a subset strut
  checks itself, `answer-schema.ts`; a type whose schema uses anything else is
  refused when saved). The worker is the actor the CALLER passes, never an
  argument, and their status and grants are read on every call; suspending or
  banning one expires their lease at once. A sweep every minute frees dead
  leases and expires tasks past their `withinHours`; `onSettle` hears every
  task that leaves `open`, which is how item 2b wakes runs. Two modules: the
  task side and the worker side, so the workers may one day be managed
  elsewhere.
- **Tests, grading and standing** (`plans/human-steps.md` §7, item 4a;
  `task-tests.ts`, `test-files.ts`, `grade-step.ts`). A task type with
  `tests` mixes TESTS — staff's, the expected answer in a sealed `tests`
  table — among its tasks. A worker is served a test as an INSTANCE: a
  `tasks` row (`root: "test"`, empty workflow and path, `served_to`) with
  one lease, written by `takeTest`, then the same code a real task goes
  through, so a page cannot tell them apart and the answer earns alike.
  `next` serves a qualifying worker only tests (K, recorded on the grant),
  then nothing until they are graded; after that a test replaces a real
  task only when `take` would hand one out (`peek`), at the type's rate.
  An answered instance wakes no run: it is GRADED in an in-process queue —
  `equal`, or a SEALED step run once on `secrets` and `llmAuth` alone,
  billed to the grading principal (`tasks.principal`, else the admin who
  saved the type); strut ships two, `grade/overlap` (boxes on an image)
  and `grade/judge` (a model under staff's rubric) — a `fail` inside the hold takes back its earning, an
  `error` counts for nothing, and STANDING (the newest `window` graded since
  the grant) under the threshold revokes the grant (`revokedBy:
  "standing"`). The expected answer is read only by the test routes and the
  grader: no capability method, step or other route holds one.
- **Copies** (`plans/human-steps.md` §7.6, item 4b; `task-copies.ts`). A
  `human` step's `copies: N` asks N workers, up to its type's `copies.max`;
  a type with no `copies` rule asks one, so how much paid work a step may
  multiply is the admin's. The task wants `copies` answers, each on its own
  worker's lease (`leases.answer`), and `take` hands it out while its live
  and submitted leases are fewer. When the LAST answer asked for is in (a
  worker already leased is never cut off), it is DECIDED by the type's rule:
  the answers grouped by `compare` (each joins the first earlier answer it
  matches), a group of `agree` settles the task with its first answer and
  that answer's worker as `by`; otherwise `more` asks one more worker (up to
  `max`) and `fail`, or `max` reached, makes the task `disputed`, which
  fails the step `task_disputed:` so `onError` runs. `equal` decides in
  `submit`'s own transaction; a SEALED step comparator (the grader's
  contract and runner: the later answer as `answer`, the earlier as
  `expected`) decides in grading's queue, outside any transaction, while no
  lease can be taken, and the sweep decides what a restart or a failed
  comparison left. Each copy earns as any answer does and keeps it:
  `onAgreed` hears each decision with every answer's `agrees`, and nothing
  takes back a disagreeing copy's earning (an open question).

- **The staff app and its reads** (`plans/human-steps.md` §9, item 6;
  `src/apps/staff/`, `src/steps/lib/staff/`). The staff run task types and
  workers in `strut/staff`, an admin-only first-party app over the `/tasks`
  routes: the page is a face, the routes decide. It reads the QUEUE
  (`GET /tasks/stats`: per type waiting, being worked, the oldest, due
  soon, granted, holding, asking, its answers not reviewed (`toReview`),
  and per hour, day and week what was
  answered, expired, cancelled, disputed, skipped and lost with p50 and p90
  times, computed on read; a lease past its expiry is waiting and lost, a
  task past due expired, before the sweep marks them), the tasks a worker
  answered (`?by=`), one worker's week and newest leases, a task's run as
  it stands, its files without a lease (a picture drawn as it comes into
  view) and the run's reply beside the answer. Its page is six tabs, one a
  job — Overview, Answers (one by one, or by group), Workers, Task types,
  Payouts, Support — described in docs/apps.md and specs/API.md §14.15. Its `staff/*` steps go through
  the STAFF DOOR, `/tasks…` alone in the admin's name, which only strut's
  own page shown to an admin reaches; none is kept as a run or hands the
  deployment's `onRunEvent` an event, so a test's expected answer and a
  grader's note stay behind the routes. The answer-shape check is one file
  in two places (`src/tasks/answer-schema.ts`, `kit/src/folds/`), so the
  type editor offers to save only what the store takes.
  How workers get in (§9.5): `staff/types` adds each type's `share` — its
  app in the public view or not, and then the share links
  (`ctx.services.publicView.share`, src/public-view.ts, `publicAppLinks` on
  `lastBase`, the last OUTSIDE request's base: an in-process request no
  longer moves it) and a QR of `peelLink` drawn server-side (`qrSvg`,
  src/move/link.ts, `qrcode-generator`) — and `tasks`, the same for Tasks
  (`strut/worker`), which every invite opens. ONE panel, "Invite a worker"
  (`InvitePanel` and `BringWorkersIn` in `components/Share.tsx`), opened by
  Invite a worker in the page's header on every tab, and by Invite someone
  on a type's card with that type picked first (kept mounted once opened,
  so an invite just made stays), and shown on each type's page with that
  type picked: the invite
  first (Work they'll do — "Anything open" or a type that is on,
  `inviteChoices` — and the starting sats under More), then, folded and only
  while some work is open (`anyOpenWork`), "Anyone with the link": Tasks'
  Peel link and QR, open work only, for people who have Peel. While Tasks
  is not in the public view the panel offers "Put Tasks online"
  (`staff/tasks-online`, `POST /tasks/online`: createStrut's `tasksOnline`,
  `publicViewNeeds` + `withNeeds` through `savePublicView`, as the Public
  view tab saves it with nothing unticked, in the admin's name). That is
  the one app the page puts online: strut ships it and it calls only the
  worker's `task/*` steps; work answered in another app that is not online
  says so (approve its card, or the Public view).
- **Task types the builder asks for** (`plans/human-steps.md` §9.8, item 6
  PR 2; `src/tasks/set-type.ts`, `task/set-type`, `task/types`). The
  builder writes the workflow with the `human` step, so it knows when a
  type is needed: it ASKS with `task/set-type`, a proposal only an ADMIN
  accepts (`approver: "admin"`), and reads what is there with `task/types`.
  Both are over `ctx.services.taskTypes` on the shared bag: `list()` (each
  type with its open tasks, how many workers hold it and its week's
  answers — never who), the card's reads (the app's problem, the rate),
  and `save`, which opens only for the ACCEPTED `task/set-type` record on
  disk for that name and input, the admin's edits included, and saves the
  change MERGED over the type with that admin as `changedBy`. It grants no
  worker, deletes no type and changes no worker. Only the `builder` seed
  grants and gates it. An object field the model sends as JSON TEXT
  (`answer`, `tests`, `copies`, `attachments`, `standing`) is parsed
  before its check, so the record and the accept hold the object; the
  tool's schema says `answer` is an object. A NEW type with no `answer`
  takes the empty object (`EMPTY_ANSWER`, `{ type: "object", properties:
  {} }`): a files-only task, photos and nothing else; the card reads "no
  fields: only the files sent with it", and a missing answer is never a
  failure.
- **The review verdict** (`plans/human-steps.md` §9.6, ruled §9.12 4 and
  5; `review` on the service, `PUT /tasks/:id/review`, `staff/review`). A
  person marks one ANSWER — the task and the worker who gave it, so a
  copies task's answers apart — `ok` or `rejected` (with why), one row an
  answer in `tasks.db`'s `reviews`. A MARK: the run has gone on, and
  nothing in it changes or wakes. It can change until the answer's hold
  ends (its earning's `releases`, or the type's hold from when it was
  answered), then it is final (`409 final`); a first verdict may come later,
  final at once. A rejection is a `fail` in the worker's STANDING window
  for the type (by when the answer was given, since the grant) and runs
  the standing check, so it can revoke; `ok` takes it out, and a revoke
  stays. Inside the hold a rejection TAKES BACK the answer's earning (its
  `why` begins `review: `) and `ok` RESTORES that take-back — the ledger's
  `restore`, the take-back it cleared kept in `pay_restores` — never a
  staff or grading take-back; past the hold no money moves. The run that
  asked gives a verdict too, `task/reply { verdict, why }`, by
  `workflow:<name>` (`RUN_REVIEWER_PREFIX`), on the answer the task settled
  with: the same `review`, so it moves money and standing as staff's does,
  and staff can change it until it is final ("Pay on OK" next).
  `GET /tasks?review=none` is the review queue, and `GET /tasks/stats`
  counts it: each type's `toReview` is its real tasks' answers with no
  verdict, of any age (`QueueCounts.unreviewed`, one count a type in both
  stores) — what the staff app's Answers tab and its Overview say is left
  to review.
- **Pay on OK** (`payOn: "ok"` on the type, `PAY_ON`, `earnsNow` in
  task-store.ts, `src/tasks/pay-on-ok.test.ts`; asked 2026-11-22: a
  book-scanner worker was paid for a refused photo AND its retake). By
  default an answer earns as it is answered. A type saved `payOn: "ok"`
  pays only accepted work: `book` books a paid answer once it EARNS
  (`earnsNow`: a verdict `ok` — staff's, a group's, or the asking run's
  `task/reply { verdict }` — or a test graded `pass` or `error`), never a
  rejected one or a test graded `fail`. So `submit` books nothing, `review`
  books on `ok` (the earning's `at` is the ok, its hold from then) and books
  nothing on a rejection before any ok, grading books a pass, and both
  stores' `unbooked` (the sweep's) apply the same rule and never return a
  rejected answer (which also keeps a type turned back to paying as
  answered from paying what was rejected). No ledger change: an answer not
  yet OK'd simply has no `pay` row. Its verdict has no `until` and is never
  final (`holdEnd` undefined: nothing was paid), so a run's rejection can
  become staff's `ok` at any time. The worker sees it waiting: `task/me`'s
  `pendingMsat` (the store's `pendingPay`), `task/history`'s `pending`,
  `task/next`'s `payOn`, and WorkerPage's "Waiting for OK" figure, badge
  and sent screen. Staff set it in the type editor ("Paid when"), and
  `task/set-type` takes it (its card says "for each one marked OK").
- **Levels** (plans/worker-progress.md; `src/tasks/levels.ts`, `xpOf` in
  tasks.ts, the ledger's `payeeEarned`). A worker's XP is everything they
  ever earned here, in whole sats: accepted pay less what was taken back (a
  restore gives it back; a held earning counts; a payout never lowers it;
  an invite's starting sats are not pay). Their LEVEL is a threshold on it:
  Level 0 below 1k sats; quick first levels, 1k, 2.5k and 5k; then from
  10k at Level 4 (about one book of pages) 12k, 15k, 20k, 25k, 30k, 40k,
  50k, 60k, 80k, and ten times as much every ten levels (100k at 14, 1M at
  24, 1 BTC at 44); the last, 118, at 21M BTC (`LEVEL_SATS`, `levelOf`).
  `task/me` answers `xp { sats, level, fromSats, toSats? }` (`toSats` absent
  at the top) wherever the server has a ledger — one not opened yet is
  Level 0 — and nothing on a host's own store. Shown, never a grant: who
  takes which type stays grants, tests and standing. Tasks draws it on top
  of the dashboard (docs/apps.md, `LevelCard`).
- **Groups of tasks** (`task/reply`'s `group`; `group` on the task,
  `tasks.group_key` in the store with its partial index `tasks_group`,
  `groups` and `reviewGroup` on the service, `src/tasks/task-groups.test.ts`).
  A deliverable is often many tasks: a book is its pages, one standing task
  each. The run that asked names the task's group once the answer is in
  (`task/reply { task, group }`, at most `GROUP_MAX` 200 characters on one
  line, trimmed; a reply with only a group leaves what was told as it was,
  and a later reply without one keeps it). Staff: `GET /tasks?group=` (a
  group's tasks), `GET /tasks/groups[?type=]` (each type and group with its
  tasks, answers, `ok`, `rejected`, `unreviewed` and `workers`, the one with
  the newest task first) and `POST /tasks/groups/review { group, type?,
  verdict, why? }`, one `review` for each answer in it with no verdict yet
  (a verdict given stays; `more` past `TASK_LIST_MAX` tasks) — the staff
  app's Answers by group, shown once a workflow named a group. The worker:
  `task/history` items carry `group` and staff's `review { verdict, why?, at
  }` on their answers (never who gave it), `{ group }` reads every answer of
  theirs in one group (past the newest 50), and `{ groups: true }` adds their
  groups, counting only their own answers and never naming other workers.
  So a worker's app can list what they handed in and what was sent back,
  with why. The verdict is staff's message to the worker, so §7.2's "never
  why anything was taken back" now has this exception; tests are never
  reviewed, so a worker could tell a test from the answers that never got a
  verdict where staff review everything — the same known limit replies have.
- **Open task types** (`plans/human-steps.md` rulings 9 and 12; `open` on
  the type, `grantOpen`, `enter` in tasks.ts, `openPayProblem`,
  `openPayWarning`). A type is OPEN by
  default (a type on file from before too): any signed-in worker who is not
  suspended or banned takes its tasks with no grant. Their first
  `task/next` that reaches it records a grant through #671's machinery —
  `by: "open"`, `qualify` the K a staff grant would record — so a `new`
  worker turns `active` and qualifying, standing, the automatic revoke and
  review run unchanged. A revoked grant is never made live by "open" (the
  store's `grantOpen` writes only where no row of the type exists); staff
  grant again. `open: false` is invite-only, as before. Whether a PAID
  open type qualifies newcomers is the admin's (ruling 12, which replaced
  #685's `409 needs_tests`): saved with tests off or K 0, anyone signed in
  earns from their first answer, and the `task/set-type` card's Who can
  do it and the staff editor's hint say so as a danger (`openPayWarning`);
  nothing refuses it. One that asks for K takes no newcomer while its ready
  tests are fewer (`openPayProblem`, told why), a worker already in keeping
  their grant. `task/me` lists the app's open types a worker may enter,
  reading only.
- **Round types** (Workers' Send a round; `round.ts`, `round` on
  the type, `roundRuleOf` in tasks.ts, the `rounds` deps of routes.ts). A
  type saved `round: { workflow }` names the workflow whose run makes one
  task of it for each item; the save checks it has a `human` step of the
  type at any depth (`roundProblem`, through createStrut's `deps.round`)
  and refuses a type both standing and round. `GET /tasks/types/:name/round`
  reads the round's ITEMS off the workflow (`roundItems`: its first `json`
  input whose default is a list, each labelled by its text) and the last
  round (the newest task's run and how many it made); `POST …/round
  { input? }` launches the workflow as the admin, with the items ticked or
  its defaults. `staff/round-items` and `staff/send-round` are those two
  for strut/staff.
- **Standing task types** (`plans/human-steps.md` §5.7, item 9, ruling 13;
  `standing` on the type, `pickUp` and `launchStanding` in tasks.ts,
  `takeStanding` in the store, `standing.ts`). For work a worker starts: a
  photo of a nutrition label. A type saved `standing: { workflow }` has
  work whenever a worker asks: `task/next`, with nothing a run made for
  them, makes ONE task and their lease in one write (as `takeTest` makes an
  instance) — keyed by the workflow, a run id chosen now (`deps.runId`) and
  the path of the workflow's first step, a `human` step of the type, its
  `show` resolved with the workflow's input defaults and params
  (`standingTask`, read through createStrut's `deps.standing`, which also
  checks the workflow is on and, where every run needs someone to bill
  (`STRUT_MOTHERSHIP_REQUIRED`), has someone: its owner, else the actor
  who published its active version; refused only with neither). No run exists yet;
  any number of workers hold one each. `task/submit` settles it as any task
  (files saved under the run id, pay booked), then LAUNCHES the workflow
  under that run id instead of waking a run (`deps.launch`: createStrut's
  `launchDetached`, input `{}`, no actor, billed to the owner, else to
  the active version's publisher; a run on
  file under the id is launched already) and records `launchedAt`; the
  run's `human` step finds its task answered by key and returns at once. A
  failed launch is the sweep's (`unlaunched`, `UNLAUNCHED_BATCH`), logged
  once. A skip or a lease run out closes the task `expired` with no run,
  never heard by `onSettle`, and staff's stats count it as a skipped or lost
  lease, not an expired task. The save checks the workflow (`400
  bad_request: standing: …`) and each ask checks it again (nothing handed
  out, logged once). `task/set-type` takes `standing` (replaced whole,
  `null` off) and its card names the workflow; the staff editor keeps it. `strut/worker`
  (docs/apps.md, specs/API.md §14.16) draws such a task with no app built:
  a type names it, an admin makes it public, and a worker in Peel picks a
  task up and answers it with a photo.
- **Files from a worker** (`plans/human-steps.md` §5.6, item 8;
  `answer-files.ts`). Some answers are a file: a photo of a court paper. A
  type opts in with `attachments: { max, min, types }` (an admin's, as the
  answer and pay are; defaults one file, none required, `image/*` and
  `application/pdf`), `task/next` hands the rule out, and `task/submit {
  lease, answer, attachments }` carries the files in the chat's shape and
  caps (`parseAttachments`: 10 files, 5 MB an image, 15 MB together), held
  to the rule — every check before anything is written, a refusal
  `bad_answer` with the task still the worker's. They are saved in the
  task's RUN's artifacts as `tasks/<task id>/<name>` (a job run's too; a
  name there numbered) BEFORE the guarded `settle`, so the run wakes to
  them; the lease records them (`leases.attachments`), and the `human`
  step's output names them, `attachments: [{ name, mediaType, size, path
  }]` — per answer on a copies task, the agreed answer's on top. An `agent`
  step reads them with `attachments: "{{ <step>.attachments }}"`: its
  `attachments` takes a list of the run's files beside `true` and `false`.
  A test instance checks them as a task does and drops them (no run; graders
  see the answer alone). Staff read them on the lease and through
  `GET /tasks/:id/files/<path>`. A page's MCP request with a session may be
  20 MB (`APP_DOOR_BODY_MAX_BYTES`), an anonymous one 4 MB. Nothing in the
  run can take back an answer's pay: staff's review does (ruled 2026-11-15).
  A type's CHECK refuses a bad answer before it is paid (next).
- **A check before an answer is accepted** (`plans/human-steps.md` §5.6.7,
  option c; `check` on the type, `checkRuleOf` in task-tests.ts, `checked`
  in tasks.ts). A type saved `check: { step, config? }` names a SEALED step
  in the grader's contract (`graderProblem`; never `equal`, which needs an
  expected answer) that `submit` runs on each answer after its shape and
  files pass and BEFORE anything is written: the answer, the task's `show`,
  the type and its files as `{ name, mediaType, data }` (base64), no
  `expected`, through `deps.grade` (`stepGrader`), billed as graders are
  (`payerOf`: the grading principal, else whoever last saved the type, else
  nobody named and the server's own model key) under its `gradeCapUsd`, for
  `CHECK_TIMEOUT_MS` (30 s, inside a host's 60 s tool call) while the
  worker's page waits. `supports: false` refuses the answer `bad_answer:
  <the step's content>`: the lease stays the worker's, so they send it
  again, and no file is saved, no run woken or launched, nothing booked. A
  check that cannot run (gone, no longer sealed, past its time, no verdict,
  its model refused) refuses too, `bad_answer: this answer could not be
  checked just now…`, logged once per type until one runs: nothing is
  accepted, and so earned, unchecked. A test instance is checked as a task
  is (a page cannot tell them apart); each copy's answer on its own. strut
  ships `grade/judge` as a check: handed no `expected`, a model looks at the
  answer and its images and PDFs against the task under `rubric`, and a
  FAIL's reason, which the worker reads, is in the task's language. Stored
  in the task store's `check_rule` column; `task/set-type` takes it (whole,
  `null` off) and its card says "Checked when handed in"; the staff editor
  keeps it and sets it. What the check refuses leaves no record.
- **A run's reply to its workers** (`task/reply`, `src/steps/lib/task/reply.ts`;
  `reply` on the service, `tasks.reply` in the store). After a worker
  answers, the run that asked can tell them what came of it: the mirror of
  the `human` step's `show`, read after the answer. `show` is a JSON object
  (at most 256 KB) and `files` are files of the run (under its artifacts,
  each a path or `{ path, name?, mediaType? }` as an `attachments` output
  lists them; at most 10, each at most `TEST_FILE_MAX_BYTES`, 3.8 MB: what
  `task/file` hands a page inside `step_run`'s 5 MB answer — a 3 MB picture
  passes). A lib step, `effect: "write"`, called on the SHARED bag beside
  `ensure` (`HumanTasksCapability.reply`; a host's own store may lack it, and
  the step refuses). The store reads the CALLING run off the step's run
  control (`runLineage(control)[0]`, its id and workflow), never an input,
  and replies only on a task that run asked: an app page's own call (a
  one-step run), another run, or a custom step naming another run's task is
  `unknown_task`. Only on a task settled by an answer (`not_answered` while
  open, expired, cancelled or disputed), never a test instance; refused as an
  agent's tool. A later reply replaces the one before, whole, with `at`; its
  `group` names the deliverable the task is part of ("Groups of tasks"
  above). One JSON column, `tasks.reply` (`ALTER TABLE`, `user_version` still 2); the
  files stay in the run's artifacts, the task keeps `[{ name, mediaType,
  size, path }]`. The worker reads it through their own door: `task/history`
  items carry `reply` on THEIR answered leases alone (never a skip or a
  lease run out; every worker who answered a copies task), and `task/file {
  lease, path }` through a lease they answered serves exactly a path the
  reply lists, whatever their status now, and nothing else of the run (with
  no reply, `lease_closed` as before). Staff read it on `GET /tasks/:id`
  (`task.reply`) and through `GET /tasks/:id/files/<path>`; `strut/staff`
  draws it on the task's page beside the answer, its pictures at once
  (docs/apps.md, `src/apps/staff/`). A standing type
  works the same: its run launches under the task's run id. Opt-in: a
  workflow that never calls it shows the worker nothing new. The worker page
  draws it (docs/apps.md, "The worker app"). Its `verdict` and `why` are
  the run's review of the answer ("The review verdict", "Pay on OK"); a
  reply may be a verdict alone. KNOWN LIMIT, for the owner to
  rule on: a test instance has no run, so it never gets a reply; on a type
  whose workflow always replies, a worker can tell afterwards which of their
  answers were tests (the ones with no reply), which §7.2's "a page cannot
  tell them apart" rules out. Nothing is built for it.
- **Withdraw** (`plans/human-steps.md` §8.2, item 5b; `src/payments/payouts.ts`,
  `task/withdraw`, the `/tasks/payouts` routes). A worker withdraws what
  passed its hold: the page asks for an AMOUNT, and strut keysends it to
  the Sphinx address the worker's SESSION carries — handed to the worker
  step's own bag by the door (`WORKER_ADDRESS`), never sent by the page —
  through the payer's THIRD DOOR, with nobody's yes per payment. Checks,
  in order: an address whose pubkey is the actor's root key (`no_address`),
  the switch (off until an admin turns it on), a wallet that can keysend,
  solvency (the wallet holds what every worker is owed), then the ledger's
  reserve — the minimum (1,000 sats), one payout on its way per worker, the
  amount and its fee cap in what is withdrawable, the worker's and the
  server's UTC day (1,000,000 and 10,000,000 sats). The worker pays the routing
  fee, at most its cap; the payout leaves their balance when it is
  RESERVED. A suspended or banned worker may withdraw (ruled): status stops
  new work, never money already released. A payout still pending a day after
  it was sent is stale and is cancelled (ruling 11): the minute's check asks
  the daemon once (`POST /keysend/:id/cancel`) and reads it from then on;
  cancelled, it fails and the reserve goes back with nobody's yes. Only when
  the wallet cannot cancel does it wait for staff (`paid` with the fee they
  give, or `drop`, which gives the reserve back). `task/me`'s `payout` says
  whether withdrawing is open and how much; on a host's own store it is
  `not_here`. A `sphinx` sign-in keeps the address (`keptSphinxAddress`,
  src/visitors.ts) when its pubkey is the key that signed; any other
  sign-in has none, and `task/withdraw` answers `no_address`. To try it
  locally without a mixer: docs/running.md, "Payments locally".
- **Inviting a worker** (`plans/human-steps.md` §5.8; src/payments/invites.ts,
  src/public-join.ts, `staff/invite`, the `/tasks/invites` routes; reworked
  2026-11-19 for a first-time worker's sake). Staff send a worker ONE https
  link, for one person: `https://<public view>/public/join#<the daemon's
  invite>&a=<Tasks' share link, encoded>`. "Invite a worker" (`strut/staff`,
  below) asks the treasury daemon for a Sphinx invite through the PAYER (the
  daemon pays the mixer for it: the starting sats, the payout settings'
  `inviteSats` by default, and the mixer's price on top), and builds the
  link on the share links' base. EVERY invite opens TASKS (`strut/worker`,
  `WORKER_APP`), the server's one work page, so Peel keeps one page per
  employer (it records each app a link opens, docs on peel-android's phase
  41); an invite made for one kind of work (`type`) carries `type=<type>`,
  and Tasks starts it once `task/me` has answered when Tasks draws it; a kind
  another app draws goes first on the dashboard, and the worker's tap opens
  that app, with Back to Tasks (`WorkerPage`, docs/apps.md). The same link works for
  someone who has Peel already (Peel ignores the invite part and opens
  `a=`), so staff never ask; the grant link that was for them is gone
  (`link_…` codes already sent still hold, `GRANT_LINK_PREFIX`). Tasks must
  be in the public view (`409 no_worker_app`), and so must the app that
  draws the invite's work (`409 not_online`), both refused before the
  wallet pays. `/public/join` opens Peel on Android with Chrome's
  `intent://` form of `sphinx.chat://?action=i&…&a=…`, the newest APK as its
  fallback; Peel signs a new user up and opens `a=`, granting that page
  sign-in as you as it opens (Peel Android), and Tasks signs in silently
  as it loads (`signIn({ silent: true })`), so the first sign-in is a toast,
  no tap (specs/WALLET.md "Signing a visitor in", steps 4-5); a Peel
  without the grant leaves Sign in to start, one tap. Nothing carries an intent across an install, so the tap also
  copies `sphinx.chat://?…` to the clipboard: a Peel opened with no account
  and no invite reads it there (peel-android's onboarding), and a worker new
  to Peel goes from the download to Tasks without coming back to the link.
  On an iPhone or iPad the page shows "Get Peel" (TestFlight,
  `PEEL_IOS_TESTFLIGHT`; Apple's TestFlight app first) and "Open in Peel"
  (`peel://join?<same query>`; not `sphinx.chat://`, which the Sphinx iOS
  app also registers); both taps copy the same `sphinx.chat://?…` text, for
  Peel iOS to read on first launch (stakwork/peel#588).
  ONE STEP for invite-only work: `a=` carries `input=invite=<token>&type=…`
  (payments/invites.ts `invitedAppUrl`, auth.ts `inviteToken` / `inviteOf`:
  the daemon's code, the app it opens, the types it gives — `t`, `[]` for
  open work alone — signed, 90 days from the invite's creation, so a listing
  shows the link sent), the page's tool input; the kit's `useTask` /
  `useWorker` send it as `invite` on `task/next` / `task/me`, and the
  service's `enterInvite` (deps `invite: { read, live, spent? }`, createStrut's:
  `inviteOf`, and the daemon listing the invite `sending` / `ready` /
  `used`) gives that worker the invite-only, enabled types the token names
  that they hold no row of — whichever app draws them — by `invite:<code>`
  — one worker per invite (`WorkerStore.grantedBy`, revoked grants
  included; two first asks with one link taken one after the other), never
  a revoked type, never a suspended or banned worker; a token that does not
  hold or opens another app is ignored (invite-grants.test.ts, both stores).
  An invite that made its grant is SPENT: the service tells the host
  (`spent`), not waited for (a cancel can take the daemon's 20 s, and this
  is the worker's first look at Tasks), and a failure is only logged, never
  undoing the grant. createStrut's cancels the Sphinx invite while the
  daemon still lists it `ready`, so its starting sats come back: an account
  Peel already had ignores the invite and opens `a=`, leaving the sats at
  the LSP. A new account's sign-up redeems the invite as it registers, and
  the daemon says `used` only once that account adds the server's (its
  first key exchange), which can come after Tasks' first ask; that cancel
  finds nothing to return and ends `cancel_unconfirmed`, harmless (the
  daemon's `cancelReady` counts an invite `cancelled` only once its balance
  rises by at most the invite's sats). The staff's list (`GET
  /tasks/invites`; `createInvites`' `takenBy`, the task store's
  `grantedBy("invite:<code>")`, the first) shows an invite that made a grant
  as `used`, with `takenBy`, whatever the daemon says (`ready`, `sending`,
  `cancelled`), and Cancel is not offered for it; Taken by names the worker
  from their grant, else from `takenBy` (`acceptedBy`, strut/staff).
  A token with no `t` (made before) gives every invite-only type of the app
  it opens, as it did. The daemon keeps the invites (code, sats, status);
  strut notes only each one's work (`InviteNotes`,
  `<dataDir>/tasks/invites.json`, memory beside a memory run store), so a
  listing rebuilds the link that was sent; the task store keeps the grants.
  Open work lets anyone in on their first `task/next` (ruling 9). `a=` lives
  only in the link; the mixer keeps code → starting sats and the core
  ignores a section it does not know.
- **Limits, numbers, grant links, and the assistant's task tools**
  (2026-11-19, after a pilot spec made the builder build its own admin app
  and ledger). A type's `limits` (`LimitRule`: `budgetSats`, the most it
  pays in all; `perWorkerDay`, the most tasks one worker takes a UTC day;
  one `limits` JSON column) are checked in `next` (`limitsReached`, over the
  store's `totals`): a type at one is left out, and when every type the ask
  reaches is, `limit_reached` with why (the kit waits on it like
  `not_granted`). The budget counts answered pay plus the pay on live leases
  plus the next take's. `numbers` (`GET /tasks/numbers`, `staff/numbers`,
  `task/report`) is each type's spend against its limits and, over the last
  `days`, each worker's answered, minutes (taken → answered), per hour and
  earned; the staff's type page shows it ("How it's going"). A NEW
  invite-only type is granted to its makers when it is saved (`setType`'s
  `holders`, qualify 0): the admin saving it in the staff editor (the
  route's actor), or for a `task/set-type` proposal the person who asked
  and the admin who accepted; an open type needs none, a change grants
  nobody. "Try it yourself" on the staff's type page is
  `staff/grant { actor: "@me" }`, for any other admin. A GRANT LINK (an
  invite token whose code is `link_…`, live without the daemon, one worker
  per code) was made here for someone who had Peel; staff make none since
  the invite works for them too, and the ones sent still hold. The assistant (orchestrator) has
  `task/types`, `task/report` and `task/grant` (a proposal an admin
  accepts, `ctx.services.taskTypes.grant` checking the record; no `worker`:
  the person who asked); the builder has `task/report`. The Concept pages
  (`Worker Tasks`, "What is built in"; `App`, "Worker apps") say never to
  build an admin app for any of it.
- **Support: the staff's chat with workers** (`plans/support-chat.md`;
  rebuilt as an app by `plans/people-and-hosts.md` §4, §5, item 5; specs/API.md
  §22 "Support"). Workers DM the treasury daemon's account, "Support", from
  Peel; staff answer from the Support tab of `strut/staff`. Support has NO
  service and no route: its tables are `strut/staff`'s own SQLite
  (`src/apps/staff/db/001-support.sql`: `conversations` keyed by the
  worker's pubkey, with the worker's actor `secp:` + the pubkey without its
  first byte, `seen_key`, `status`, `assignee`, `welcome_due`,
  `welcomed_at`; `messages` keyed by strut's own `key`, unique by Sphinx
  `id` and by `client_id` for Support's own sends, with the daemon's `seq`
  last applied; `files`, a message's bytes; `settings`, one row, with a
  trigger that keeps `welcome_since`, ruling 8). The DAEMON pushes each DM
  record to `support/receive` through `strut/staff`'s `hosts: { sphinx: {
  steps: [support/receive], unlinked: true } }` (`plans/people-and-hosts.md`
  §3), as the contact the record is about; the sender's name comes on
  `x-strut-account-name` (§1). It keeps a batch of one contact's records
  in one transaction (a savepoint each: one that cannot be kept is
  skipped and named, never the call; one kept before changes nothing;
  an older `seq` never undoes a newer), reopens a conversation a worker
  writes to again, marks a welcome due for a `contact` record newer than
  `welcome_since`, tells the app's channel `support`, and starts
  `support-outbox` (`src/workflows/system/support-outbox/`, one step,
  `support/send-due`, launched with `key` so one runs at a time) while a
  welcome is due. The PAGE reads with SQL (`useSql`; lib/support.ts), reads
  again on the channel and every 30 s, and writes its own columns with SQL
  (seen — only when something is unread, since each write is a kept
  `step:sqlite/exec` run —, done, taken through `:actor`, the welcome,
  payout lines). The tools that touch the daemon (`src/steps/lib/support/`,
  `_shared.ts` beside them): `support/send` (kept as `sending`, sent, kept
  as answered; Retry sends a failed one, or one stuck `sending` a minute
  with no id, under its id), `support/delete`, `support/file` (3 MB
  pieces), `support/set-photo`, `support/send-due`. They send through the
  `sphinx` capability (src/payments/sphinx-dm.ts over the message token):
  on an admin first-party page's bag (`adminServices`) and on a run an
  admin first-party app launched (`sendsAsSupport` in `launchDetached`),
  nowhere else. PAYOUT LINES: the withdrawals' `paid` hook calls
  `payoutLine` with strut/staff's database and the capability. THE WELCOME
  BY ADDRESS (plans/support-chat.md §11): a worker who already had Peel
  never adds Support (Peel ignores an invite on an account it has; a Share
  link carries none), so no key exchange marks their welcome due. The task
  service tells its `newWorker` dep the first time it sees a worker (`me` or
  `next`, no row before) whose session carries a Sphinx address
  (`WORKER_ADDRESS`); createStrut's `supportWelcome` calls `welcomeWorker`,
  which sends the saved welcome to that ADDRESS (`deliver`'s `address`: the
  daemon meets them there, 3 sats, and keeps it for a Retry) unless Support
  already has a conversation with them (a contact, the backlog included,
  ruling 8). The conversation is made `welcomed_at` in the same
  transaction, so the key exchange of an invite's new account arriving
  after, or a second first call at once, sends none. Not waited for; never
  throws. Support as
  first built is dropped at boot, with no copy (ruling 7): the task store's
  first open drops `support_conversations`, `support_messages` and
  `support_state` (`DROPPED_SUPPORT_TABLES`), and boot deletes
  `<dataDir>/support/`. Tested by src/apps/support.test.ts (a strut on a
  port, the stand-in daemon pushing to it).
- **The loop end to end** (`worker-loop.test.ts`, in `npm test`). ONE test
  of the whole worker loop through the doors a deployment serves, with no
  browser and no provider key: `POST /apps` and `POST /workflows` publish the
  court-filing worker app and its workflow (`__fixtures__/court-filing/`, the
  2026-11-15 demo's) and `PUT /public-view` makes the app public; an admin
  makes a paid type that takes a photo (`PUT /tasks/types/:name`) and grants
  it to a worker signed in with a Sphinx account (a test key signing the
  challenge, `sphinxSignIn` in `src/test-util/public-door.ts`, so the session
  keeps an address); the run's `human` step posts the task; the worker's page
  takes it and answers WITH the photo on `POST /public/mcp`; the run wakes and
  its `agent` (a stand-in model) has the image on its prompt; the earning is
  held, then released on the task store's clock; the admin funds the wallet
  (`POST /earnings/deposit`) and turns payouts on; the worker withdraws what
  `task/me` offers, as the account widget does, and strut keysends through the
  stand-in Sphinx daemon over HTTP (`LIGHTNING_*` → the real
  `SphinxDaemonPayer`); the worker's balance and the daemon's move by the
  amount and the LSP's fee, and `GET /earnings?wallet=1` differs by 0. Each
  door's edges stay in its own suite. Not covered: the page itself in a
  browser (strut's camera sheet, the widget drawing the balance).
- **The photo demo end to end** (`photo-remix.test.ts`, in `npm test`;
  `__fixtures__/photo-remix/`, PR #729). A STANDING type with a custom worker
  app: the worker snaps anything, an image model reimagines it, and the page
  shows before and after. The workflow (`photo-remix.yaml`): a `human` step
  whose `show` carries the theme from `params.style`; an `image` edit of
  `shot.attachments` (`params.model`, default `openai/gpt-image-1-mini`, the
  edit proven through the gateway; `params.quality` medium as a JPEG, about
  15 s and $0.016 a picture); `task/reply` with the result FIRST and the
  worker's photo second (after the answer a page reads only what the reply
  lists); and when the model fails or refuses, the step's `onError` packs
  `{ error }`, an `if` gate sends the other `task/reply` — a plain line and the
  photo, `show.failed` — so the page never waits out its 2 minutes for
  nothing. The app (`app/`, phone first, on `useTask`, `useTaskHistory({
  refetchInterval })`, `useTaskFileUrl` and `useCamera`, or a photo chosen
  from the device made a 1600 px JPEG): the start screen reads the theme and
  the pay off the task in hand, held only on that screen (none after an
  answer, so a worker who stops holds nothing); after the answer their
  photo waits under a scan, the history read every 3 s for at most 2
  minutes; the reveal is a
  wipe between photo and result (drag by touch or mouse, or the handle's
  arrow keys); Your pictures reads each tile's picture only once it scrolls
  into view; `VIEWS` is the place for a second view. The test publishes both
  through the doors, makes the paid open standing type, signs a worker in
  with Sphinx, answers with a photo, and a stand-in OpenAI (the global fetch,
  as `src/steps/core/image.test.ts` plays it) draws: the edit carries the
  photo, the style, the quality and `jpeg`; the reply reaches the worker's
  history with both files, which open through the answered lease; staff read
  it on the task; the pay is held. Then the model refuses (a 400, never
  retried) and the worker's history gets the plain line instead.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/tasks/`

the TASK STORE (plans/human-steps.md §4, item 2a; the `human` step that parks on it is item 2b, the worker's `task/*` steps and the staff's routes item 3, §5–§6, earnings item 5a, §8.1): people as a step of a workflow, in the ledger's pattern. answer-schema.ts: the answer's shape, PURE, the SAME FILE as `kit/src/folds/answer-schema.ts` (the staff app's type editor runs that one; the engine's build cannot import the kit, so answer-schema.test.ts holds the two byte for byte; it imports nothing and counts bytes with `TextEncoder`) — a JSON Schema SUBSET strut checks itself (`type` on every schema; `properties` + `required`, a key the schema does not name refused; `items`, `minItems`, `maxItems`; `enum`; `minimum`, `maximum`; `minLength`, `maxLength`; `title` / `description` as labels), `answerSchemaProblem` (a type's schema, refused when it uses anything else, a keyword on a type it does not apply to, or an `enum` option that does not fit) and `answerProblem` (an answer: nesting to 8, 256 KB as JSON), and `taskAppProblem` (the app a type names missing, or its grants — types and globs — not reaching `task/next` and `task/submit`: the queue's `appProblem` and the type editor's line). task-store.ts: the TASK side — `task_types` (app, answer schema, `leaseSeconds` 600, `withinHours` 72, enabled, `open` — any signed-in worker, no grant (ruling 9); on the file `invite_only`, null open, added by `ALTER TABLE` as pay's columns were, so a type from before is open — `paySats` — sats to the msat an answer earns, unpaid when absent — and `holdHours` 0, no hold (72 before 2026-11-19); `title` — what workers call it, in their language and any words (plans/i18n.md), at most 80 characters, trimmed, on the file `task_types.title` added by `ALTER TABLE` the same way, none when absent: `task/me`'s types carry it and strut/views shows it in place of the name), `tasks` (a random id, unique on workflow + run id + step path, `show`, `files` + `root` run | job, status `open` / `settled` / `expired` / `cancelled` / `disputed`, `due`, the answer and `by`, `copies` — the answers it wants, 1 but for copies), `leases` (128 random bits, one per task and worker ever, `open` / `submitted` / `expired` / `skipped`; LIVE while open and before its expiry, so nothing waits on the sweep to be right; `payMsat`, the type's pay STAMPED by `take`, and `bookedAt`, when its earning reached the ledger; a copies task's `answer` and, once decided, whether it `agrees`), `reviews` (§9.6: one VERDICT per answer, keyed by task and worker, `ok` / `rejected` with `why`, `by`, `at`, replaced when it changes; `create table if not exists`, so a file from before gains it, `user_version` still 2); `TaskStore` with the guarded writes — `take` (rule 2: the oldest open task not past due of a type asked for and enabled, that this worker never held and whose live and submitted leases are fewer than its `copies` — one copy: nobody holds it — while the worker holds nothing live: ONE statement on the file), `settle` (the lease submitted and the task settled, both guarded, one transaction at `synchronous=full`; a copies task's answer kept on the lease until the last asked for, which the caller's `decide` decides in the same transaction or leaves to `decide`), `decide` (a copies task's decision written guarded: still open, still wanting what was decided on, every answer in), `undecided` (open copies tasks with all their answers and no decision), `skip`, `release`, `cancel`, `sweep`, `booked` / `unbooked` (submitted leases with pay and no `bookedAt`, a partial index) — and `MemoryTaskStore`. Pay's four columns are added by `ALTER TABLE` when a file lacks them, `user_version` still 1, so a file from #655 opens as it is. worker-store.ts: the WORKER side — `workers` (status `new` / `active` / `suspended` / `banned`, first seen, a note) and `grants` (one row per worker and type, revoked when and why), `grantOpen` (an open type's grant, by `OPEN_GRANT_BY` "open", made only when the worker has NO row of the type, `new` → `active` as any grant: a revoked one stays revoked), `liveGrants`, `MemoryWorkerStore`; it knows nothing of tasks (ruling 5 may move it). db.ts: `<dataDir>/tasks/tasks.db`, owner-only folder, WAL, every write one `BEGIN IMMEDIATE`, `close()` folds the WAL; task-store-sqlite.ts and worker-store-sqlite.ts keep their own tables in it, made or brought to SCHEMA VERSION 2 (§7.7) by `taskSchema` and `workerSchema` inside ONE migration transaction (`TaskDb.migrate`, from `openTaskStores`): `task_types.tests` and `.copies`, the `tests` table, `tasks.test` / `.served_to` (unique together) / `.copies` / `.grade` / `.graded_at` / `.grade_note`, `leases.answer`, `grants.qualify` (and copies' `leases.agrees`, added as pay's columns were, `user_version` still 2); a version 1 `tasks` table (#655's, with or without #664's pay columns) is REBUILT for its new CHECKs (status `disputed`, root `test`), its rows and `seq` kept; a migration that fails leaves the file as it was; a file newer than this strut is refused. TESTS (§7, item 4a): the task side's `peek` (the type `take` would hand out), `takeTest` (one guarded write: the least-served ready test of a type the worker was never served and that was not made from a task they answered — any of a copies task's answers, not only its `by` — its instance and lease together, ties by the injected `random`), `putTest` / `test` / `tests` / `editTest` (only before served) / `readyTest` / `retireTest` / `retireTestsOf`, `grade` (once, guarded), `ungraded`, `standings` (per worker and type since the grant: the newest `window` graded, an answer rejected in review among them as a fail at its answer's time (`rejected` counts them), every test's pass and fail (`gradedAll`, what qualifying reads: no rejection), errors, pending, real tasks answered — SQL window functions on the file), `putReview` / `reviewsOf` and `list`'s `review` filter (`none`: a real task with an answer no verdict was given on; `ok` / `rejected`: one marked so; with `by`, that actor's); `take` never hands out an instance, and an instance whose lease is no longer live closes `expired` (skip, release, the sweep), never heard by `onSettle`. task-tests.ts: the pure parts — `testRulesOf` (§7.8's defaults under what staff set, each bounded; K at most the window), `gradeRuleOf` (`equal` or a sealed `{ step, config? }`, `bad_grader`), `sameJson`, `openPayProblem` (ruling 9: why a type cannot be saved paid and open with so many ready tests — tests off, K 0, or K short — the message naming the way out; also the card's and, held to it, the staff editor's `openPayHint`), `phaseOf` (qualifying / waiting / qualified; an `error` grade counts neither way), `standingOf`, `revokeWhy` (the revoke's sentence, `standing: passed 13 of the last 20 tests of pet-match, under 80%`, or `qualifying: …` — never with a rejected answer in the window — and `(2 of them answers rejected in review)` when there are some; once K are graded the rule needs no more than K). task-copies.ts: COPIES' pure parts (§7.6, item 4b) — `copiesRuleOf` (§7.8's defaults, `max` 3, `agree` 2, `compare` `equal`, `onDisagree` `more`, under what staff set; `max` at most `COPIES_MAX`, 10; `agree` at most `max`; a step `compare` a sealed grader, `bad_grader`), `decidingRule` (the type's, or `equal` and never more once a type's rule was turned off), `groupsOf` / `groupsOfAsync` (each answer joins the first earlier answer it matches), `decideCopies` (a group of `agree` — at most the copies the task wants — settles with its first answer, the larger and then the earlier of two; else `more` below `max`; else `disputed`). test-files.ts: a test's files, `<dataDir>/tasks/tests/<id>/<path>` owner-only (memory where the store is), at most `TEST_FILE_MAX_BYTES` (what `task/file` can hand a page). grade-step.ts: createStrut's `deps.grade` — a step grader's ONE run through `runSingleStep` on an allowlist bag (`secrets`, `llmAuth`; nothing reaches `onRunEvent`, the events sink or `dataDir`), no actor, the grading principal, `GRADE_TIMEOUT_MS` then force-cancelled, the type's `gradeCapUsd` as `maxCostUsd`; its config the inputs as sole expressions with the grade's `config` over them (a check's, §5.6.7 c: `answer`, `show`, `type` and `files` as base64, no `expected`); the verdict read by `mapCheckResult` — and `graderProblem` (a registry step that is sealed). tasks.ts: the service — `createTasks({ open, exists?, now?, ledger?, ledgerIfAny?, usdPerBtc? })`, `openTaskStores` (imports `node:sqlite` on first use) / `memoryTaskStores`, `TaskError` (a code first; `needs_tests` 409); its frozen `capability` is the WHOLE store, which the staff routes hold and no services bag carries (plans/human-steps.md §9.2): `ensure` (the `human` step's: the task by key, made only of an enabled type, `show` ≤ 256 KB, ≤ 200 files under the run's files), the worker's `next` / `submit` / `skip` / `file` / `me` for the ACTOR the caller passes and the calling `app` (status and grants read on every call: only `active` takes tasks — but `next` first ENTERS the open, enabled types it reaches that the worker has no grant row of (`enter`, named or all of the calling app's: `grantOpen` with the K a staff grant would record, so a `new` worker becomes `active`; never for a suspended or banned one; a PAID open type short of its K ready tests takes no newcomer, `entry`, and the refusal says why — `not_active` for a `new` worker, `not_granted` by name); `next` narrows by `type` and `app`, returns the worker's live lease again, `{ none: true }` when there is nothing, hands out the type's `answer` schema and the lease's `payMsat`, and with `wait` (≤ `NEXT_WAIT_MAX_S`, 25) HOLDS for a task — woken by a task made or skipped (the oldest waiter of that type, which hands the wake on if it takes nothing), a grant, a revoke or a status change (that worker's), the sweep freeing leases or a type saved (every waiter once); `submit` checks the answer against the type's schema and settles the task, then BOOKS a paid lease's earning (§8.1: the ledger's `pay`, one row per lease, its `releases` the answer's time plus the type's hold as booked; then `bookedAt` here) — a booking that fails is logged, never the worker's, and the sweep books it; `me` lists after the held types the calling app's open types the worker may enter (reading only: no grant recorded; none for a suspended or banned worker), and adds `balance` (`heldMsat`, `withdrawableMsat`, `totalMsat`, `nextReleaseAt?`, read through `ledgerIfAny`, zeros and no file with nothing earned; a payout on its way already out of it) and each type's `payMsat`, and with `deps.payouts` the `payout` (§8.2: `payouts.view`, for the `address` the caller passes); `submit`, `skip` and `file` refuse a lease of a type another app draws, `wrong_app`; `file` reads one path on the task's `files` through the caller's live lease, `not_listed` otherwise, through `deps.file` — createStrut's reads where `run/files` would; each worker makes at most `TASK_CALLS_PER_MINUTE` (120) calls a minute, a held wait counted once, `too_many`), the staff's `types` / `setType` (a PUT; `open` true when left out; `paySats` 0 to 1,000,000, `holdHours` 0 to 720, 0 (no hold) by default; a paid open type needs its tests on, K ≥ 1 and K ready — `needs_tests` naming the shortfall, `openPayProblem`) / `deleteType` (`in_use` while a task of it is open; revokes its live grants) / `workers` (each with its `balance`, one grouped read) / `setWorker` (`suspended` or `banned` expires the worker's live lease at once) / `grant` (`new` → `active`) / `revoke` (expires a live lease of that type; the status stays) / `list` / `task` (with leases, an answered one with its ledger `earning`); `ensure` answers a settled task with its `pay: { msat, usd? }` (the lease's stamp, dollars at `usdPerBtc` now). TESTS (§7): `setType` takes `tests` (off when left out); `next` serves by the worker's phase per type (qualifying: tests alone, oldest grant first; waiting: nothing; qualified: real tasks, a test drawn in place of the one `take` would hand out at `rate`, or `newRate` under `newTasks` real answers); `submit` on an instance books as a real answer does, tells no `onSettle` and queues it for GRADING (`GRADE_CONCURRENCY` 4 at once; the sweep queues what is left, `UNGRADED_BATCH`); a graded `fail` takes back that lease's earning (`takeBack`, `by: "grading"`), every grade is told to `onGraded`, and a grade under the type's threshold revokes (`revokedBy: "standing"`), expiring the live lease; three `error`s in a row of a type are logged once; `grant` records the type's K on the grant (0 with `{ qualify: false }` or too few ready tests, with a `notice`; a live grant stays as it is); `me` marks each type `qualifying`; `workers` and the new `worker(actor)` carry each grant's `standing`; `deleteType` retires the type's tests; `tests` (the service's, never the capability's) authors them — `list`, `get` (with each instance's answer, grade and the grader's note), `create`, `fromTask` (the real task's `show`, files copied through `deps.bytes`, its answer expected unless given; its worker is never served it), `update` (`in_use` once served), `putFile` (ready once every listed file is there: wakes a waiter), `retire`. `deps.file` reads an instance's file from the test's copy through the same `fileResult` as a real task's. COPIES (§7.6): `setType` takes `copies` (off when left out); `ensure` takes `copies` (1 to the type's `copies.max`, 1 with no rule: `bad_request: copies:` and no task made), wakes one held `next` per copy, and answers a settled copies task with every answer (`answers: [{ answer, by, agrees }]`, in the order given) and `pay` the sum of every copy's; `submit` hands `settle` an `equal` decider (`inlineDecider`) so the last answer is decided in its transaction, or queues the task (`decideOne`, in grading's queue and concurrency) for a step comparator through `deps.grade` — the later answer as `answer`, the earlier as `expected`, billed as a grader is, the type's `tests.gradeCapUsd` or $0.05 — whose failure leaves it undecided, logged once, for the sweep (`undecided`, `UNDECIDED_BATCH` 100, `deciding` in its answer); a decision that lands tells `onSettle` (settled or `disputed`) and `onAgreed` (`{ task, type, agreed, answers: [{ lease, worker, agrees }], at }`), or, for `more`, wakes a waiter; every copy keeps its earning; `grading()` resolves once neither a grade nor a decision waits. The service also has `human` (`ensure` and `reply` alone, frozen: every step's `ctx.services.tasks` on the SHARED bag, so no step, workflow, agent tool, proposal apply or release step reaches a worker's call — which takes any actor — or the staff's; a host's own `services.tasks` is kept as it is), `worker` (the worker's calls alone, frozen — and `withdraw(actor, { address, msat })`, §8.2, through `deps.payouts`, counted against the worker's calls, any status: what a `worker: true` step's OWN call bag carries on both app doors — `workerServices`, src/apps/tools.ts — never the shared bag) and `isActiveWorker(actor)` (from memory: the active workers loaded when the store opens and kept by every write — what the public routes count a request under). Beside it, for 2b's `task` source: `onSettle` (tasks that left `open` — answered, swept as expired, cancelled, disputed), `onAgreed` (copies tasks decided), `settled(id)`, `cancel(id)`, `cancelRun(workflow, runId)`; `takeBack({ task, worker?, why, by? })` (§8.1: each answer's earning taken back while held — `taken`, `released` past its hold, `none` — booking one not booked first; the service's alone, never a capability's); `review({ task, worker?, verdict, why?, by? })` (§9.6: the verdict on one answer — `worker` when the task has several, `no_answer`, a test's refused — booking a paid answer first so its hold is the ledger's; `final` once that hold has ended and a verdict was given; inside the hold a rejection takes the earning back (`why` `review: <why>`, `REVIEW_TAKE_BACK`) and `ok` restores a take-back a rejection made, through the ledger's `restore`; a rejection on a type with tests runs the standing check; the service's alone); `list`, `task` and `activity` carry each answer's verdict on its lease (`review: { verdict, why?, by?, at, until, final }`); `sweep` (rule 8, and books what `submit` did not) and `start` (the sweep now and every minute, only where a store is open or on file). No file until something is asked of it, and a staff read on a strut without one answers empty. createStrut builds it (`strut.tasks`; memory where the run store is), closes it in `close()`. The store is the `task` SOURCE of parked runs (`TASK_PARK_PREFIX`, registered at the end of createStrut's construction, since its catch-up may wake a run): `settled(on)` is `settled(id)`, `cancelled(on)` cancels the task, and an `onSettle` listener wakes each settled task's run (answered, expired or cancelled); a run that ends cancelled while live cancels the tasks it left open (`cancelRun`, from the end hook, `RunEndInfo.status`), a run that fails keeps them for a resume. `ensure` takes `{ control, resolveFiles }` beside its input: `deps.refusal(control)` refuses a run tree (`refused:`), and `resolveFiles` runs only when the task is MADE. files.ts: `taskFilesRoot`, `resolveTaskFiles` (what the `human` step resolves `files` with). answer-files.ts: FILES FROM A WORKER (§5.6, item 8) — `attachmentRuleOf` (a type's `attachments`: `{ max, min, types }` over the defaults 1, 0, `image/*` + `application/pdf`; `max` 1 to 10, `min` 0 to `max`, 1 to 20 media types, `image/*` a family; a `RuleProblem` otherwise; null or absent takes none), `takesType`, `answerAttachments` (an answer's files: the chat's `parseAttachments` and caps, then the rule — none with none, too few, too many, a type not taken, each a sentence the service makes `bad_answer`), `saveAnswerAttachments` (into the run's artifacts as `tasks/<task id>/<name>` through the artifacts capability, a name already there numbered by `freeName`, one save of a task at a time in the process so two copies never pick one name; returns `RunAttachment`s), `attachmentRuleLine` (the rule as one line); the store keeps the type's rule in `task_types.attachments` and an answer's files in `leases.attachments` (both JSON, added by `ALTER TABLE`, `user_version` still 2); the service checks and saves in `submit` before `settle` (`deps.saveAttachments`, createStrut's; a test instance's dropped), hands the rule out on `task/next`, answers `ensure` with `attachments` (the settled answer's worker's lease's) and each copy's on `answers`, and `taskFile` serves a path an answer carried from the run's artifacts whatever the task's root; answer-files.test.ts the pure parts and one suite over both stores (the rule, refusals that write nothing, the record kept on file, a type that takes none, copies kept apart, a test instance's dropped, staff's read), worker-door.test.ts the door end to end (a photo through `/public/mcp` reaching the next agent's prompt) and the door's size. set-type.ts: `task/set-type`'s pieces (plans/human-steps.md §9.8) — `typeChangeInput` (the step's input: the name and every field `PUT /tasks/types/:name` takes, each checked as the store checks it — `answerSchemaProblem`, `testRulesOf` and `copiesRuleOf` on the shape alone, the bounds, pay to the msat — so a bad one is the model's error and no proposal is made; a ZodObject, so the gate adds `rationale`), `askOver` (a new ask built on the `task/set-type` card still WAITING for the same name in the thread, when no type exists yet: the step's `describe` keeps the merged ask on the record, shows the whole type, and replaces the waiting card, `ProposalDescription.replaces`), `mergeType` (the change over the type: a field left out kept, `tests` and `copies` merged over the type's own rules, `null` off; a new type needs `answer`, `bad_request`), `createTaskTypes` (`ctx.services.taskTypes`, createStrut's over the store the staff routes hold: `list()` — each type less `changedBy`, with `openTasks` (waiting + working; `open` is the type's own, open or invite-only), `workers` (live grants, a count), `answeredWeek` and `readyTests` from `stats()` when the store answers it — `appProblem`, `usdPerBtc`, and `save`, which reads the proposal's record and acts only on an `accepted` `task/set-type` record with `approver: "admin"` whose input with the decision's edits, parsed by `typeChangeInput`, is this name and change (`set_type_needs_admin:` otherwise), then `setType` with the merge and the decider as `changedBy`), `typeCard` (the card, for an admin who is not technical: title "New task: <name>" / "Change task:" / "Turn off task:", the name's dashes as spaces; a one-sentence summary — who can do it, when, the pay in dollars and sats; SHOWN: What changes for a change, A worker hands in (the photos, then each question by its title — `formProblem`, the kit's, held to the same verdict by set-type.test.ts, sends a form it cannot draw to The answer), When (any time for a standing type, naming its workflow; else when a workflow sends one), Who can do it (only people you invite, or anyone signed in; a paid type anyone may take with no qualifying test or short of `readyTests` a danger in plain words), Pay (dollars and sats, the wait before withdrawing, the last week's cost; a rise a danger); under Details (`CardField.detail`, which Jamie's card folds and a host that does not know it shows): Task type (name and app; the app's problem a danger, shown), The answer (one line per field), Time limits, Workers, Open tasks for a change, Tests and Copies (a merge the save would refuse a danger, shown); Approving it fails in the summary; actions "Approve" / "Don't"; it reads a type's rules, never a test). routes.ts: the STAFF's routes (§6), full scope only, reads included — `GET /tasks/types`, `PUT`/`DELETE /tasks/types/:name` (the PUT takes `open`; `409 needs_tests`), `GET /tasks/workers[?status=]`, `PUT /tasks/workers/:actor`, `PUT`/`DELETE /tasks/workers/:actor/grants/:type`, `GET /tasks[?type=&status=&workflow=&runId=&before=&limit=]`, `GET /tasks/:id`, `POST /tasks/:id/take-back { worker?, why }` (`409 released` past the hold), `PUT /tasks/:id/review { worker?, verdict, why? }` (§9.6; `404 no_answer`, `409 final`, `501` with a host's own store), `GET /tasks?review=none|ok|rejected` (the review queue), `GET /tasks/workers/:actor` (one worker with their standing, and — §9.4 — their live lease, their week by type (`workerWeek`: answered, skipped, ran out, of the leases taken in 7 days) and their newest 50 leases with each task, `activity`), `GET /tasks/stats[?type=]` (the queue, `stats`: the store's `stats` counts each type's real tasks — open with and without a live lease, the oldest, due in a day and an hour, live leases — and its windows, the newest 1,000 times of the week read once for all three; the service adds the workers by status and live grants by type (the worker side's `counts`), each type's `readyTests`, the held `task/next`s from memory, the p50 and p90 (`percentiles`, nearest rank); the routes add each type's `appProblem`, `taskAppProblem` over the app's manifest; before `/tasks/:id`), `GET /tasks?by=` (the tasks an actor answered, any copy: `id in` their submitted leases), `GET /tasks/:id` with `run` (createStrut's `runOf`: running here, the summary's status and `waitingOn`, `stale`, or null), `GET /tasks/:id/files/<path>` (`taskFile`: a path on the task's list, no lease, `not_listed`), `GET /tasks/workers` each with `week` (answers in 7 days) and `holding` (one grouped read, `workersNow`), `GET /tasks?test=true|false`, `GET /tasks?status=disputed`, a type's `copies`, a grant's `{ qualify: false }`, and the TEST routes, before `/tasks/:id` — `GET /tasks/tests[?type=&retired=]`, `GET /tasks/tests/:id`, `POST /tasks/tests`, `PUT /tasks/tests/:id/files/<path>` (raw bytes), `POST /tasks/:id/test`, `PUT /tasks/tests/:id`, `DELETE /tasks/tests/:id` — the only answers that hold an expected answer (`501` with a host's own store); a refusal `{ error, code }` (`400`, `404`, `409 in_use`); and the PAYOUT routes (§8.2), before `/tasks/:id` — `GET /tasks/payouts[?state=out|stale|paid|failed&worker=&before=&limit=]` (`{ settings, today, payouts }`, the defaults with no ledger), `PUT /tasks/payouts/settings` (the whole row with `changedBy`; `minSats` ≥ 1, each cap ≥ it), `POST /tasks/payouts/:key/read` and `…/resolve { action, feeMsat? }`, over payouts.ts whatever store the routes hold; specs/API.md §22. tasks.test.ts runs one suite over both; bag.test.ts what a step finds on the bag (a registry, a custom step and an agent's tool call: `ensure` and `reply` alone); steps/core/human.test.ts the step and the source; staff-reads.test.ts §9.11's stats and reads over both stores with a fixed clock (waiting and working, a dead lease waiting and lost before the sweep, each window's edges, the medians, `asking` while a `next` is held, `?by=` with copies, a worker's week and leases, a task's file and `not_listed`); worker-door.test.ts the door end to end (a run parks, a signed-in visitor's page answers it through `/public/mcp`, the run finishes; a paid answer's run counts its pay, `task/me` shows it held then withdrawable, and only staff take it back) and §13's row 3; task-tests.test.ts §7.10's list for 4a over both stores (an instance indistinguishable to a page and in pay, nothing but the test routes holding an expected answer, no run woken, the draw with `random` fixed, qualifying, standing, re-grants, grader errors and a restart), a strut's grader run (an allowlist bag, the principal, nothing under `dataDir` or to `onRunEvent`), the routes, the redact guard over the registry, and a version 1 file migrated; set-type.test.ts §9.11's `task/set-type` row (the input checked before any proposal, the merge, the kit's form verdict, the card for a new type and a change with the pay-rise and app dangers, a direct call, a workflow's step, meta/run-step, a subflow and a custom step's call of the door refused, a forged `ctx.proposal`, a member's accept `admin_required:` and an admin's saved with `changedBy`, the admin's edits checked again, no expected answer on the record, `task/types`, and the seeds); task-copies.test.ts §7.10's "Copies" list over both stores (two leases to two workers, never two to one, settled only with both answers; the first agreeing answer and its `by`; `more` then `disputed`; a step comparator outside the transaction with no lease meanwhile, a failed one and a restart decided by the sweep; one copy as built; each copy's earning; the type's rule; a test made from a disputed task), and the decision's pure parts; steps/core/human.test.ts also the step's `answers` and `task_disputed:` with and without `onError`; task-check.test.ts the check before an answer is accepted (§5.6.7 c) over both stores (the rule: a sealed step, never `equal`; kept on file, off with null or a whole save without it; a fail refused with its reason, the task still the worker's, no file saved and nothing earned, then a pass settled and earned; one that cannot run — past its time, no verdict, no longer sealed — refused too and logged once; who pays picked: the last saver, kept by a save that names nobody, else nobody named; a test instance checked as a task is); task-groups.test.ts groups over both stores (a reply names its task's group, alone or with what it tells, trimmed and checked; staff's groups by type and newest first, a group's tasks, one call marking its unreviewed answers while a rejection stays, its pay taken back inside the hold; a worker's own groups and every answer of one past the newest 50, with staff's verdict and why and never who gave it). task-review.test.ts the verdict over both stores (one per answer and the review filter, a copies task's answers apart, only a real task's answer, changed inside the hold and final after it, a first verdict after it final at once, nothing in the run touched, a rejection's take-back and `ok`'s restore over and over, a staff take-back never undone, no money after the hold, a copy's earning alone, standing moving on a rejection — and revoking — and back on `ok`, no standing on a type without tests) and a `tasks.db` from before gaining `reviews`; open-types.test.ts ruling 9 over both stores (a new worker takes an open type's tasks with no grant, the first ask recording one by `open`; qualifying first with K ready tests and a failed qualifying's revoke that sticks until staff grant again; suspended and banned refused, nothing recorded; invite-only still a grant; a paid open type refused at save short of tests and closed to newcomers when its tests drop, open again when they are back; `task/me` and `task/next` with no type over the app's open types; a held `next` of a new worker woken), and worker-door.test.ts's open type through `/public/mcp` end to end; payout-routes.test.ts §8.2 on a server (the `/tasks/payouts` routes full scope only, the settings with `changedBy`, the `staff/*` payout steps through the staff door, a withdrawal through the task service paying the session's address with the books balanced, two at once, suspended and banned workers, a host's own store `not_here`, nothing on the shared bag), and worker-door.test.ts `task/withdraw` through `/public/mcp` (an amount alone; `no_address` until sign-in keeps one, a member's page too); worker-loop.test.ts the worker loop's end-to-end test ("The loop end to end" above) over `__fixtures__/court-filing/` (the worker app, `app/`, and its workflow, `court-paper.yaml`; outside the engine's tsc); photo-remix.test.ts the photo demo's ("The photo demo end to end" above) over `__fixtures__/photo-remix/` (`photo-remix.yaml` and `app/`), its door helpers shared with worker-door.test.ts and src/visitors.test.ts in `src/test-util/public-door.ts`. standing.ts: a STANDING type's pick-up read off its workflow (§5.7, item 9) — `standingTask(flow, type)`: the first step a top-level `human` step of the type with no `depends` and no `files`, its `show` reading only `input` and `params` (`exprRoots`) and resolved with the input's defaults and the params, the input valid with none given — `{ path, show }` or `{ problem }`; createStrut's `deps.standing` adds the workflow there and on and its owner. The store keeps the rule in `task_types.standing` and a standing task's `tasks.standing` and `tasks.launched_at` (`ALTER TABLE`, `user_version` still 2); `takeStanding`, `launched`, `unlaunched`; a standing task closes with its lease as an instance does, is never `take`n, swept as past due, cancelled with a run or counted as an expired task. A run's reply (`task/reply`): `tasks.reply` (JSON `{ show?, files?, at }`, `ALTER TABLE`), the store's guarded `reply` (settled, not a test), the service's `reply(input, { control })` (the task's run read off the control), `history`'s `reply` on answered leases, `file` through an answered lease (the reply's files alone) and `taskFile`'s reply files; tasks.test.ts "a run's reply to its workers" over both stores (the run check, answered only, replace-whole, who reads what, copies, a test instance, a restart), worker-door.test.ts the step in a workflow through `/public/mcp` (a 3 MB picture, a page's own call, another run, another worker, an agent's tool) and src/apps/worker.test.ts strut/worker's standing loop replying. standing.test.ts: over both stores (the save's check, an ask's task and lease with several workers at once, the answer's launch with no settle listener told, a skip and a lease run out closing with no run, the stats, a failed launch the sweep's once, a run's task before a pick-up, a workflow that can no longer be one), `standingTask`'s refusals, and a strut end to end (pick-ups, an answer, the run launched under the pick-up's id finishing with the answer and never parking)

### `src/steps/lib/support/`

SUPPORT's tools (plans/people-and-hosts.md §5; "Support" above): `receive` (the Sphinx daemon's call, through strut/staff's `hosts:`), `send`, `send-due` (support-outbox's step), `delete`, `file`, `set-photo`, over strut/staff's own SQLite (`ctx.app`'s, `ctx.services.appDb`). `_shared.ts`: `dmOf` (a feed record, lenient on the time), `keepRecord` (inside the caller's transaction), `keepOwn` / `deliver` / `sendOwn` (kept before it goes, then the daemon's answer unless its record came first, by `seq`), `payoutLine` (the engine's hook), `welcomeWorker` (the welcome to a worker's address on their first time in Tasks, the engine's hook too), `tx` (never across an `await`).

### `src/steps/lib/task/`

the WORKER's door to the task store (plans/human-steps.md §5.1), thin over `ctx.services.tasks` — on their OWN call's bag, the worker's calls alone (`TasksService.worker`, which the app door's `dispatch` adds for a `worker: true` step on `POST /mcp` and `POST /public/mcp`, `workerServices`; the shared bag carries `ensure` and `reply` alone, plans/human-steps.md §9.2): task/next { type?, wait? } (the oldest open task of a type the worker holds — an OPEN type of the app they never held is entered first, plans/human-steps.md ruling 9 — that the CALLING app draws — `wrong_app` for another app's — or `{ none: true }`; `wait` ≤ 25 s holds for one), task/submit { lease, answer, attachments? } (the files a type's `attachments` rule takes, plans/human-steps.md §5.6, saved in the task's run), task/skip { lease, reason?, all? } (`all`: a lease of a type any app the caller can open draws, the worker's own — the dashboard's Let go of `holding.lease`), task/file { lease, path } (one of the task's `files`, as `run/files` answers; through a lease they answered, one of the reply's files), task/withdraw { msat } (a page that grants `task/me` grants it too, for the account widget's Withdraw — `grantRefusal`, the page's list only, never a host's; plans/human-steps.md §8.2: what passed its hold, keysent to the Sphinx address the viewer's SESSION carries — the door puts it on the call's bag as `WORKER_ADDRESS`, `workerCall` reads it there and nowhere else; the input is `msat` alone, `.strict()`, so a page that names an address is refused; `not_here` on a host's own store; a refusal `code: sentence`), task/me (status, the types held in this app and then its open types they may enter, each with what an answer earns, whether the worker is `qualifying` for it — a flag, no score, plans/human-steps.md §7.5 — whether it is `standing` and how many of its tasks are `waiting` that they could take (the store's `waitingFor`: take's guard without "holds nothing"), `holding` — the task in their hand, with its `lease` for the dashboard's Let go — and the worker's `balance` — held, withdrawable, total, plans/human-steps.md §8.1; a first call writes the viewer `new`), `{ all: true }` on task/me and task/history reads the types of every app the caller can open instead of the calling app's (`appsOf` in `_shared.ts`, over `WORKER_APPS` — the door's list on the call's bag: the public view's apps on the public door, none on a member's, meaning every app; the service's `apps` filter), task/history (history.ts: their own newest 50 tasks of this app's types — `ask` from the task's `show`, how each ended, what a paid answer earned and when it clears, `takenBack`, and on an answer the workflow replied to its `reply` — never the run, a test or a reason; the dashboard's list, `TasksService.history` on `recentLeases` + the ledger's `payFor`; optional on a host's store, `{ items: [] }` without it). A type with tests may serve a test instance through task/next, task/submit, task/skip and task/file exactly as a task (§7.2). Each is `worker: true` (`StepDef.worker`: it decides from its own caller): the worker is `ctx.actor` in `ctx.app`, never an input; refused without either, and refused as anything but an app page's own call (a one-step run, never a workflow's step or an agent's tool, `_shared.ts` `workerCall`). On the app door a worker's step is never kept as a run (`keptFromApp`, no claims read); a signed-in visitor's page reaches one its app grants (`signedInRefusal`'s `worker` rule), an anonymous one is refused; not a visitor's daily write; the app monitor counts their `volume` per viewer. Three steps here are NOT a worker's. reply.ts, `task/reply { task, show?, files? }` (`effect: "write"`): a run's reply to the workers who answered a task it asked ("A run's reply" above) — a step of that run alone, never a page's call or an agent's tool. And two the builder uses (plans/human-steps.md §9.8; specs/API.md §22, "Asking for a task type"): set-type.ts, `task/set-type` — `effect: "write"`, `approver: "admin"`, its input `typeChangeInput` and its card `typeCard` (src/tasks/set-type.ts); it runs only as a proposal an admin accepted (`ctx.proposal`; a direct call, a workflow's step, meta/run-step and a subflow are refused) and saves through `ctx.services.taskTypes.save`, which checks the record on disk — and types.ts, `task/types` (`effect: "read"`, `{ types }` from `taskTypes.list()`: each type with `open`, and `openTasks`, `workers`, `answeredWeek`, `readyTests`). Only the `builder` seed grants them; a worker app granting `task/*` hands its page `task/types` (a member's page reads it, a visitor's is refused as any private read) and a `task/set-type` that refuses

### `src/steps/lib/staff/`

the STAFF's door to the task store (plans/human-steps.md §9.3; specs/API.md §14.15), for `strut/staff` alone: each step is one `/tasks…` route made in process in the viewer's name through `ctx.services.staffAdmin` (createStrut's `staffAdminDoor`, `inProcessDoor` over `STAFF_ROUTES`: no other path), which the app door hands to the bag of ONE call — a first-party page's shown to an admin (src/apps/tools.ts `adminBag`, which also leaves the deployment's `onRunEvent` out) — and to nothing else; `_door.ts` `staffCall` refuses without it (`../_admin-door.ts` `adminDoorOf`, the check `earnings/*` shares) and throws a route's refusal with its `code` first. staff/stats, types, save-type, delete-type, round-items and send-round (Send a round: `GET`/`POST /tasks/types/:name/round`), type-workflows (the editor's When there is work: `GET /tasks/workflows?type=`, the rounds deps' `workflowsFor`), workers, worker, set-worker, grant, revoke, tasks (with `review`, the review queue, and `group`), task, file, take-back (5a), review (§9.6: `PUT /tasks/:id/review`), groups (`GET /tasks/groups`) and review-group (`POST /tasks/groups/review`) for the Groups tab, tests, test, save-test (a new test, or with `id` a change before it is served), test-file (base64 bytes, sent raw), test-from-task, retire-test (item 4), and item 5b's payouts (§8.2): staff/payouts (`GET /tasks/payouts`), staff/save-payouts (`PUT /tasks/payouts/settings`), staff/payout-read and staff/payout-resolve (`POST /tasks/payouts/:key/read` and `…/resolve`) — `strut/staff` grants them with its Payouts tab (item 5b's PR 3); staff/save-payouts takes `inviteSats` too. §5.8's invites: staff/invite { sats?, type? } (`POST /tasks/invites`; `effect: "write"` — the wallet pays the mixer; adds `qrSvg`, the link as a QR code, as staff/types' share), staff/invites {} (`GET /tasks/invites`), staff/tasks-online {} (`POST /tasks/online`, Tasks into the public view) and staff/cancel-invite { code } (`POST /tasks/invites/:code/cancel`), for the Invite a worker panel and the Workers tab's list. A route's in-process request is `http://strut.invalid`, so the invite routes take the base the share links use (`lastBase`, where the page's own request came, with any mount path). The ones that write an expected answer list `expected` in `redact`; none is kept as a run (`keptFromApp`). `effect` read or write, as their routes

### `src/steps/lib/grade/`

the GRADERS strut ships for test tasks (plans/human-steps.md §7.4, PR 4c): each `sealed: true` on its definition (`grade/*` is not a sealed namespace), `effect: "read"`, `expected` in `redact`, run only as a task type's or test's `grade: { step, config? }` through `grade-step.ts`'s `stepGrader` — its config `answer` and `expected` (with `show` and `type`, unread) and the grade's own `config` over them — and answering the claims check contract `{ supports, content }` (`mapCheckResult`). overlap.ts: `grade/overlap` — a BOX is `[x, y, w, h]` (§4.5's four numbers) or `{ x, y, w, h }`, w and h above 0, one unit for both sides; each side is a box, a list (`[]` is none) or, with `key`, an object holding one under `key`; passes when the boxes pair off one to one (augmenting paths, so the order drawn does not matter) at intersection over union ≥ `min` (0.7, in (0, 1]) — a missing box and an extra box each fail, none expected and none drawn passes; an `expected` that is not boxes throws (`error`, staff's mistake), an answer that is not boxes when the expected one is fails; `content` is the counts and each expected box's IoU to two places (`2 expected, 3 drawn, 2 matched at IoU ≥ 0.7; box 1: IoU 0.92; box 2: IoU 0.81; 1 drawn box matched nothing expected`), never a coordinate. judge.ts: `grade/judge` — ONE `generateText` on the model the llm step builds (`resolveModel` with `stepAuth`, so `llmAuth` routes it and the run's principal and `maxCostUsd` reach the gateway; the output marked with `withUsage`, the spend counted as the llm step counts it), on the grade's `model`, else `STRUT_DEFAULT_MODEL` through `secrets` (the agent step's fallback, without `STRUT_LLM_MODEL`), else it throws; a short system prompt and the `rubric` (default `DEFAULT_RUBRIC`: says what the expected answer says, wording aside), `expected` and `answer` in tags, the values as JSON with `<` escaped so an answer cannot close its tag; the reply must be ONE line `PASS: <reason>` or `FAIL: <reason>` (`parseVerdict`), the reason the `content`; anything else throws, so a garbled reply grades `error`, never `pass`. Handed no `expected`, it is a type's CHECK (§5.6.7 c): `CHECK_SYSTEM` (the FAIL's reason is the worker's, in the task's language), `checkPrompt` (the `rubric`, default `DEFAULT_CHECK_RUBRIC`, the task's `show`, the answer, the files listed, one the model cannot see said so) and `checkContent` (each image or PDF after it as a file part). The worker's answer reaches the model as data, which a determined worker may still try to talk past: staff read each grade's note on `GET /tasks/tests/:id`. grade.test.ts: both through `stepGrader` and `mapCheckResult`, overlap's edges (no boxes, extra, missing, exactly at `min`, the pairing, malformed sides), judge with a stand-in model (`registerModelWrapper`: pass, fail, garbled replies, the default model and none, the spend on `step.end`, `llmAuth` told the principal and the cap; as a check, the prompt and the file parts the model is sent), both refused by `graderProblem` with `sealed` removed, and a strut whose types grade with each, answered through the task store (pass, fail, `error` counting for nothing), and a type checked by judge (a FAIL refused with its reason, the task still the worker's; a PASS settled)
