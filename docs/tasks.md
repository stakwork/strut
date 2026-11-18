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
  soon, granted, holding, asking, and per hour, day and week what was
  answered, expired, cancelled, disputed, skipped and lost with p50 and p90
  times, computed on read; a lease past its expiry is waiting and lost, a
  task past due expired, before the sweep marks them), the tasks a worker
  answered (`?by=`), one worker's week and newest leases, a task's run as
  it stands and its files without a lease. Its `staff/*` steps go through
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
  src/move/link.ts, `qrcode-generator`). The Queue opens with a "Bring
  workers in" list, one closed row per public worker app (`sharedApps`,
  `ShareRows` in `components/Share.tsx`): the app's name and the types its
  workers answer, opening to its invite maker, QR and links (kept mounted
  while closed, so an invite just made stays). A type's page shows its
  app's block open, or says it is not public. The page makes nothing
  public.
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
  staff or grading take-back; past the hold no money moves.
  `GET /tasks?review=none` is the review queue.
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
- **Round types** (Tasks and workers' Send a round; `round.ts`, `round` on
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
  run can take back an answer's pay: staff's review does (ruled 2026-11-15;
  a check at submit is later).
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
  src/public-join.ts, `staff/invite`, the `/tasks/invites` routes). Staff
  send a new worker ONE https link, `https://<public view>/public/join#<the
  daemon's invite>&a=<the worker app's share link, encoded>`: Invite, in a
  worker app's Share block (§9.5), asks the treasury daemon for a Sphinx
  invite through the PAYER (the daemon pays the mixer for it: the starting
  sats, the payout settings' `inviteSats` by default, and the mixer's price
  on top), and builds the link on the share links' base, opening the WORKER
  APP at its share link (`publicAppLinks`) — an app the task types name that
  is in the public view (the route takes `app` when there are several).
  Share is for a worker who has Peel; Invite for someone who does not.
  `/public/join` opens Peel on Android with Chrome's `intent://` form of
  `sphinx.chat://?action=i&…&a=…`, the newest APK as its fallback; Peel signs
  a new user up and opens `a=`, an existing user goes straight there, and
  the first sign-in is one tap. ONE STEP for invite-only work: `a=` is the
  share link with `input=invite=<token>` (payments/invites.ts
  `invitedAppUrl`, auth.ts `inviteToken` / `inviteOf`: the daemon's code and
  the app, signed, 90 days from the invite's creation, so a listing shows the
  link sent), the app's tool input; the kit's `useTask` / `useWorker` send it
  as `invite` on `task/next` / `task/me`, and the service's `enterInvite`
  (deps `invite: { read, live }`, createStrut's: `inviteOf`, and the daemon
  listing the invite `sending` / `ready` / `used`) gives that worker the
  app's invite-only, enabled types they hold no row of, by `invite:<code>`
  — one worker per invite (`WorkerStore.grantedBy`, revoked grants
  included; two first asks with one link taken one after the other), never
  a revoked type, never a suspended or banned worker; a token that does not
  hold or opens another app is ignored (invite-grants.test.ts, both stores).
  The task store keeps those grants and nothing else of an invite; an open
  type lets anyone in on their first `task/next` (ruling 9). `a=` lives only
  in the link; the mixer keeps code → starting sats and the core ignores a
  section it does not know.
- **Support: the staff's chat with workers** (`plans/support-chat.md`, item 1;
  `src/support/`; specs/API.md §22 "Support"). Workers DM the treasury
  daemon's account, "Support", from Peel; staff answer from the Support tab
  of `strut/staff`. Strut reaches the daemon with its MESSAGE token
  (`messageToken` on a `sphinx` wallet, src/payments/settings.ts; specs/
  LIGHTNING.md "Support's DMs"), held by Support alone, never on a bag;
  without one, or with an NWC wallet, every `/support` route answers `501
  not_available` and the page shows no tab (`shownOf`). The FOLLOWER
  (`createSupport`, started beside the task store's sweep) reads `GET
  /dms?after=<seq>` every 3 s while a token is set and keeps what it reads
  in the task store's FILE, on a connection of its own (`openTaskDb` makes
  every table on any connection; `:memory:` beside a task store in memory):
  `support_conversations` keyed by the worker's pubkey (the actor is
  `secp:` + the pubkey without its first byte), `support_messages` keyed by
  the Sphinx id and, for strut's own sends, the `client_id` strut gave
  `POST /dm` — matched by it first, since a send that failed before
  anything went out has no Sphinx id (a record that changes — a send's
  status, a deletion — comes again under a new seq and updates its row; a record that cannot be kept
  is skipped inside its own savepoint, never the page, since one bad record
  would hold the cursor forever), `support_state` (the cursor, one per
  daemon URL, so another daemon is read from its start; when Support first
  followed — the backlog before it is `earlier` — and the welcome). The
  tables are only added, so the file's schema version stays 2. Each
  worker's file is fetched when it arrives (a media token expires), beside
  the reads of the feed and never holding them (the daemon may take 180 s),
  up to 25 MiB (`413 too_large` from the daemon, or more bytes than that,
  is a line), into `<dataDir>/support/files/<sha256 of the id>`, under the
  sender's name from `content-disposition` (the feed's is made from the
  type); `not_found`, `deleted`, `host_not_allowed` and `unreadable` give
  up at once, anything else is tried on the next 4 reads. A reply over the
  daemon's 32 KiB (as the message's JSON) is refused before it is kept. A
  reply is KEPT
  before it is sent (`sending`), then `sent` or `failed` from the daemon's
  answer unless the feed already said; Retry (`{ retry: key }`) claims a
  failed row once and resends the same id. When the store opens (once a
  process), a send a past process left `sending` with no word from the
  daemon is failed (`abandonSends`), so Retry shows. A file goes to a page
  in 3 MB pieces (`offset`, `next`): a step's result is capped at 5 MB. Who replied (`by`) is kept and
  never answered: every reply is from Support. "Seen" is per conversation,
  shared by the staff, up to a message key. The WELCOME (§5): the text in
  `support_state`; a `contact` record (a new contact's key exchange) newer
  than the save that turned it on — one with no time of its own never is —
  marks its conversation's welcome DUE in the page's own transaction, and
  each tick claims and keeps each due welcome as Support's message in one
  transaction (`startWelcome`, `by: "welcome"`), then sends it: once per
  worker, and a restart in between loses nothing. Saving again keeps that
  time; clearing turns it off, and a welcome due then goes no more. The search joins the `workers` table, so a worker's note
  is searched too. Tested by src/support/support.test.ts (the store over a
  file in memory; the routes and the `staff/support-*` steps against the
  stand-in daemon, `scripts/fake-sphinx-daemon.ts`, which answers the DM
  routes and plays a worker through open `/worker-*` routes).
  **Item 2** (staff send files; the desk scales). A STAFF FILE (`POST
  /support/:worker { file: { base64, type, name }, text? }`, at most
  2.5 MiB — the page shrinks a photo to 1,600 px first) is written to
  `<dataDir>/support/files/<sha256 of its clientId>` and kept as Support's
  `file` message (`state: "kept"`) before `POST /dm` carries it as `file
  { data, type, name }`; Retry sends the same file again from that copy.
  The daemon's answer gives the Sphinx id at once (`answered` keeps it), so
  a reply can quote it and Delete name it before the feed has it. DELETE
  (`POST /support/:worker/delete { key }`): Support's own messages alone,
  through `POST /dm/:id/delete` (stakwork/sphinx#436), the row flagged; a
  failed one never went, so it is flagged here alone and Retry no longer
  finds it; the daemon's `409 not_deletable` on a send not yet settled is
  `409 not_yet`, "try again in a moment". The daemon keeps no file bytes:
  Retry sends a file again from strut's copy, and with a file the
  daemon's 32 KiB counts 1 KiB more, which strut counts too.
  SUPPORT'S PICTURE (`PUT`/`DELETE /support/photo`): through the daemon's
  `PUT /dm/photo`, which answers the memes URL it then sends as `img` on
  every message; strut keeps the URL in `support_state` and the bytes in
  `<dataDir>/support/photo` to show staff. A conversation's `status`
  (`open`, `done`) and `assignee` (an admin's actor, answered only as
  `assigned: "me" | "other"`, ruling 4) are columns on
  `support_conversations`, added to a file item 1 made (`supportSchema`
  checks `pragma table_info`); a worker's new message (not a contact, not
  a deletion) reopens a done one in the page's own transaction; `GET
  /support?filter=open|mine|unassigned|done|all`. PAYOUT LINES: the
  withdrawals' `paid` hook (src/payments/withdrawals.ts, after
  `payoutSettled`) calls `support.paidOut`, which sends "Paid you 1,200
  sats" to a worker who is a contact while `payoutLines` is on (the
  default, `support_state`), under a `clientId` made from the payout's key,
  so once per payout; it never throws into the payout. The HEADS-UP (§6):
  each tick, once the oldest unread worker's message is 5 minutes old,
  each admin Support knows — an actor that marked a conversation seen,
  replied or took one, AND is itself a conversation's (a contact, so `POST
  /dm` reaches it, ruling 15) — gets "3 messages waiting in Support", at
  most once an hour each (`headsUpDue` / `headsUpSent`, `support_state`;
  a send that failed leaves it due for the next tick); an admin's own
  messages to Support are not counted as waiting, so answering a heads-up
  from Peel brings none back; any other admin has the tab's count alone. What strut sends on its own is `by`
  `welcome`, `payout` or `heads-up`, answered as `auto`.
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

## Files

What each file and folder in this area is, in the order of the tree.

### `src/tasks/`

the TASK STORE (plans/human-steps.md §4, item 2a; the `human` step that parks on it is item 2b, the worker's `task/*` steps and the staff's routes item 3, §5–§6, earnings item 5a, §8.1): people as a step of a workflow, in the ledger's pattern. answer-schema.ts: the answer's shape, PURE, the SAME FILE as `kit/src/folds/answer-schema.ts` (the staff app's type editor runs that one; the engine's build cannot import the kit, so answer-schema.test.ts holds the two byte for byte; it imports nothing and counts bytes with `TextEncoder`) — a JSON Schema SUBSET strut checks itself (`type` on every schema; `properties` + `required`, a key the schema does not name refused; `items`, `minItems`, `maxItems`; `enum`; `minimum`, `maximum`; `minLength`, `maxLength`; `title` / `description` as labels), `answerSchemaProblem` (a type's schema, refused when it uses anything else, a keyword on a type it does not apply to, or an `enum` option that does not fit) and `answerProblem` (an answer: nesting to 8, 256 KB as JSON), and `taskAppProblem` (the app a type names missing, or its grants — types and globs — not reaching `task/next` and `task/submit`: the queue's `appProblem` and the type editor's line). task-store.ts: the TASK side — `task_types` (app, answer schema, `leaseSeconds` 600, `withinHours` 72, enabled, `open` — any signed-in worker, no grant (ruling 9); on the file `invite_only`, null open, added by `ALTER TABLE` as pay's columns were, so a type from before is open — `paySats` — sats to the msat an answer earns, unpaid when absent — and `holdHours` 72), `tasks` (a random id, unique on workflow + run id + step path, `show`, `files` + `root` run | job, status `open` / `settled` / `expired` / `cancelled` / `disputed`, `due`, the answer and `by`, `copies` — the answers it wants, 1 but for copies), `leases` (128 random bits, one per task and worker ever, `open` / `submitted` / `expired` / `skipped`; LIVE while open and before its expiry, so nothing waits on the sweep to be right; `payMsat`, the type's pay STAMPED by `take`, and `bookedAt`, when its earning reached the ledger; a copies task's `answer` and, once decided, whether it `agrees`), `reviews` (§9.6: one VERDICT per answer, keyed by task and worker, `ok` / `rejected` with `why`, `by`, `at`, replaced when it changes; `create table if not exists`, so a file from before gains it, `user_version` still 2); `TaskStore` with the guarded writes — `take` (rule 2: the oldest open task not past due of a type asked for and enabled, that this worker never held and whose live and submitted leases are fewer than its `copies` — one copy: nobody holds it — while the worker holds nothing live: ONE statement on the file), `settle` (the lease submitted and the task settled, both guarded, one transaction at `synchronous=full`; a copies task's answer kept on the lease until the last asked for, which the caller's `decide` decides in the same transaction or leaves to `decide`), `decide` (a copies task's decision written guarded: still open, still wanting what was decided on, every answer in), `undecided` (open copies tasks with all their answers and no decision), `skip`, `release`, `cancel`, `sweep`, `booked` / `unbooked` (submitted leases with pay and no `bookedAt`, a partial index) — and `MemoryTaskStore`. Pay's four columns are added by `ALTER TABLE` when a file lacks them, `user_version` still 1, so a file from #655 opens as it is. worker-store.ts: the WORKER side — `workers` (status `new` / `active` / `suspended` / `banned`, first seen, a note) and `grants` (one row per worker and type, revoked when and why), `grantOpen` (an open type's grant, by `OPEN_GRANT_BY` "open", made only when the worker has NO row of the type, `new` → `active` as any grant: a revoked one stays revoked), `liveGrants`, `MemoryWorkerStore`; it knows nothing of tasks (ruling 5 may move it). db.ts: `<dataDir>/tasks/tasks.db`, owner-only folder, WAL, every write one `BEGIN IMMEDIATE`, `close()` folds the WAL; task-store-sqlite.ts and worker-store-sqlite.ts keep their own tables in it, made or brought to SCHEMA VERSION 2 (§7.7) by `taskSchema` and `workerSchema` inside ONE migration transaction (`TaskDb.migrate`, from `openTaskStores`): `task_types.tests` and `.copies`, the `tests` table, `tasks.test` / `.served_to` (unique together) / `.copies` / `.grade` / `.graded_at` / `.grade_note`, `leases.answer`, `grants.qualify` (and copies' `leases.agrees`, added as pay's columns were, `user_version` still 2); a version 1 `tasks` table (#655's, with or without #664's pay columns) is REBUILT for its new CHECKs (status `disputed`, root `test`), its rows and `seq` kept; a migration that fails leaves the file as it was; a file newer than this strut is refused. TESTS (§7, item 4a): the task side's `peek` (the type `take` would hand out), `takeTest` (one guarded write: the least-served ready test of a type the worker was never served and that was not made from a task they answered — any of a copies task's answers, not only its `by` — its instance and lease together, ties by the injected `random`), `putTest` / `test` / `tests` / `editTest` (only before served) / `readyTest` / `retireTest` / `retireTestsOf`, `grade` (once, guarded), `ungraded`, `standings` (per worker and type since the grant: the newest `window` graded, an answer rejected in review among them as a fail at its answer's time (`rejected` counts them), every test's pass and fail (`gradedAll`, what qualifying reads: no rejection), errors, pending, real tasks answered — SQL window functions on the file), `putReview` / `reviewsOf` and `list`'s `review` filter (`none`: a real task with an answer no verdict was given on; `ok` / `rejected`: one marked so; with `by`, that actor's); `take` never hands out an instance, and an instance whose lease is no longer live closes `expired` (skip, release, the sweep), never heard by `onSettle`. task-tests.ts: the pure parts — `testRulesOf` (§7.8's defaults under what staff set, each bounded; K at most the window), `gradeRuleOf` (`equal` or a sealed `{ step, config? }`, `bad_grader`), `sameJson`, `openPayProblem` (ruling 9: why a type cannot be saved paid and open with so many ready tests — tests off, K 0, or K short — the message naming the way out; also the card's and, held to it, the staff editor's `openPayHint`), `phaseOf` (qualifying / waiting / qualified; an `error` grade counts neither way), `standingOf`, `revokeWhy` (the revoke's sentence, `standing: passed 13 of the last 20 tests of pet-match, under 80%`, or `qualifying: …` — never with a rejected answer in the window — and `(2 of them answers rejected in review)` when there are some; once K are graded the rule needs no more than K). task-copies.ts: COPIES' pure parts (§7.6, item 4b) — `copiesRuleOf` (§7.8's defaults, `max` 3, `agree` 2, `compare` `equal`, `onDisagree` `more`, under what staff set; `max` at most `COPIES_MAX`, 10; `agree` at most `max`; a step `compare` a sealed grader, `bad_grader`), `decidingRule` (the type's, or `equal` and never more once a type's rule was turned off), `groupsOf` / `groupsOfAsync` (each answer joins the first earlier answer it matches), `decideCopies` (a group of `agree` — at most the copies the task wants — settles with its first answer, the larger and then the earlier of two; else `more` below `max`; else `disputed`). test-files.ts: a test's files, `<dataDir>/tasks/tests/<id>/<path>` owner-only (memory where the store is), at most `TEST_FILE_MAX_BYTES` (what `task/file` can hand a page). grade-step.ts: createStrut's `deps.grade` — a step grader's ONE run through `runSingleStep` on an allowlist bag (`secrets`, `llmAuth`; nothing reaches `onRunEvent`, the events sink or `dataDir`), no actor, the grading principal, `GRADE_TIMEOUT_MS` then force-cancelled, the type's `gradeCapUsd` as `maxCostUsd`; its config the four inputs as sole expressions with the grade's `config` over them; the verdict read by `mapCheckResult` — and `graderProblem` (a registry step that is sealed). tasks.ts: the service — `createTasks({ open, exists?, now?, ledger?, ledgerIfAny?, usdPerBtc? })`, `openTaskStores` (imports `node:sqlite` on first use) / `memoryTaskStores`, `TaskError` (a code first; `needs_tests` 409); its frozen `capability` is the WHOLE store, which the staff routes hold and no services bag carries (plans/human-steps.md §9.2): `ensure` (the `human` step's: the task by key, made only of an enabled type, `show` ≤ 256 KB, ≤ 200 files under the run's files), the worker's `next` / `submit` / `skip` / `file` / `me` for the ACTOR the caller passes and the calling `app` (status and grants read on every call: only `active` takes tasks — but `next` first ENTERS the open, enabled types it reaches that the worker has no grant row of (`enter`, named or all of the calling app's: `grantOpen` with the K a staff grant would record, so a `new` worker becomes `active`; never for a suspended or banned one; a PAID open type short of its K ready tests takes no newcomer, `entry`, and the refusal says why — `not_active` for a `new` worker, `not_granted` by name); `next` narrows by `type` and `app`, returns the worker's live lease again, `{ none: true }` when there is nothing, hands out the type's `answer` schema and the lease's `payMsat`, and with `wait` (≤ `NEXT_WAIT_MAX_S`, 25) HOLDS for a task — woken by a task made or skipped (the oldest waiter of that type, which hands the wake on if it takes nothing), a grant, a revoke or a status change (that worker's), the sweep freeing leases or a type saved (every waiter once); `submit` checks the answer against the type's schema and settles the task, then BOOKS a paid lease's earning (§8.1: the ledger's `pay`, one row per lease, its `releases` the answer's time plus the type's hold as booked; then `bookedAt` here) — a booking that fails is logged, never the worker's, and the sweep books it; `me` lists after the held types the calling app's open types the worker may enter (reading only: no grant recorded; none for a suspended or banned worker), and adds `balance` (`heldMsat`, `withdrawableMsat`, `totalMsat`, `nextReleaseAt?`, read through `ledgerIfAny`, zeros and no file with nothing earned; a payout on its way already out of it) and each type's `payMsat`, and with `deps.payouts` the `payout` (§8.2: `payouts.view`, for the `address` the caller passes); `submit`, `skip` and `file` refuse a lease of a type another app draws, `wrong_app`; `file` reads one path on the task's `files` through the caller's live lease, `not_listed` otherwise, through `deps.file` — createStrut's reads where `run/files` would; each worker makes at most `TASK_CALLS_PER_MINUTE` (120) calls a minute, a held wait counted once, `too_many`), the staff's `types` / `setType` (a PUT; `open` true when left out; `paySats` 0 to 1,000,000, `holdHours` 1 to 720; a paid open type needs its tests on, K ≥ 1 and K ready — `needs_tests` naming the shortfall, `openPayProblem`) / `deleteType` (`in_use` while a task of it is open; revokes its live grants) / `workers` (each with its `balance`, one grouped read) / `setWorker` (`suspended` or `banned` expires the worker's live lease at once) / `grant` (`new` → `active`) / `revoke` (expires a live lease of that type; the status stays) / `list` / `task` (with leases, an answered one with its ledger `earning`); `ensure` answers a settled task with its `pay: { msat, usd? }` (the lease's stamp, dollars at `usdPerBtc` now). TESTS (§7): `setType` takes `tests` (off when left out); `next` serves by the worker's phase per type (qualifying: tests alone, oldest grant first; waiting: nothing; qualified: real tasks, a test drawn in place of the one `take` would hand out at `rate`, or `newRate` under `newTasks` real answers); `submit` on an instance books as a real answer does, tells no `onSettle` and queues it for GRADING (`GRADE_CONCURRENCY` 4 at once; the sweep queues what is left, `UNGRADED_BATCH`); a graded `fail` takes back that lease's earning (`takeBack`, `by: "grading"`), every grade is told to `onGraded`, and a grade under the type's threshold revokes (`revokedBy: "standing"`), expiring the live lease; three `error`s in a row of a type are logged once; `grant` records the type's K on the grant (0 with `{ qualify: false }` or too few ready tests, with a `notice`; a live grant stays as it is); `me` marks each type `qualifying`; `workers` and the new `worker(actor)` carry each grant's `standing`; `deleteType` retires the type's tests; `tests` (the service's, never the capability's) authors them — `list`, `get` (with each instance's answer, grade and the grader's note), `create`, `fromTask` (the real task's `show`, files copied through `deps.bytes`, its answer expected unless given; its worker is never served it), `update` (`in_use` once served), `putFile` (ready once every listed file is there: wakes a waiter), `retire`. `deps.file` reads an instance's file from the test's copy through the same `fileResult` as a real task's. COPIES (§7.6): `setType` takes `copies` (off when left out); `ensure` takes `copies` (1 to the type's `copies.max`, 1 with no rule: `bad_request: copies:` and no task made), wakes one held `next` per copy, and answers a settled copies task with every answer (`answers: [{ answer, by, agrees }]`, in the order given) and `pay` the sum of every copy's; `submit` hands `settle` an `equal` decider (`inlineDecider`) so the last answer is decided in its transaction, or queues the task (`decideOne`, in grading's queue and concurrency) for a step comparator through `deps.grade` — the later answer as `answer`, the earlier as `expected`, billed as a grader is, the type's `tests.gradeCapUsd` or $0.05 — whose failure leaves it undecided, logged once, for the sweep (`undecided`, `UNDECIDED_BATCH` 100, `deciding` in its answer); a decision that lands tells `onSettle` (settled or `disputed`) and `onAgreed` (`{ task, type, agreed, answers: [{ lease, worker, agrees }], at }`), or, for `more`, wakes a waiter; every copy keeps its earning; `grading()` resolves once neither a grade nor a decision waits. The service also has `human` (`ensure` alone, frozen: every step's `ctx.services.tasks` on the SHARED bag, so no step, workflow, agent tool, proposal apply or release step reaches a worker's call — which takes any actor — or the staff's; a host's own `services.tasks` is kept as it is), `worker` (the worker's calls alone, frozen — and `withdraw(actor, { address, msat })`, §8.2, through `deps.payouts`, counted against the worker's calls, any status: what a `worker: true` step's OWN call bag carries on both app doors — `workerServices`, src/apps/tools.ts — never the shared bag) and `isActiveWorker(actor)` (from memory: the active workers loaded when the store opens and kept by every write — what the public routes count a request under). Beside it, for 2b's `task` source: `onSettle` (tasks that left `open` — answered, swept as expired, cancelled, disputed), `onAgreed` (copies tasks decided), `settled(id)`, `cancel(id)`, `cancelRun(workflow, runId)`; `takeBack({ task, worker?, why, by? })` (§8.1: each answer's earning taken back while held — `taken`, `released` past its hold, `none` — booking one not booked first; the service's alone, never a capability's); `review({ task, worker?, verdict, why?, by? })` (§9.6: the verdict on one answer — `worker` when the task has several, `no_answer`, a test's refused — booking a paid answer first so its hold is the ledger's; `final` once that hold has ended and a verdict was given; inside the hold a rejection takes the earning back (`why` `review: <why>`, `REVIEW_TAKE_BACK`) and `ok` restores a take-back a rejection made, through the ledger's `restore`; a rejection on a type with tests runs the standing check; the service's alone); `list`, `task` and `activity` carry each answer's verdict on its lease (`review: { verdict, why?, by?, at, until, final }`); `sweep` (rule 8, and books what `submit` did not) and `start` (the sweep now and every minute, only where a store is open or on file). No file until something is asked of it, and a staff read on a strut without one answers empty. createStrut builds it (`strut.tasks`; memory where the run store is), closes it in `close()`. The store is the `task` SOURCE of parked runs (`TASK_PARK_PREFIX`, registered at the end of createStrut's construction, since its catch-up may wake a run): `settled(on)` is `settled(id)`, `cancelled(on)` cancels the task, and an `onSettle` listener wakes each settled task's run (answered, expired or cancelled); a run that ends cancelled while live cancels the tasks it left open (`cancelRun`, from the end hook, `RunEndInfo.status`), a run that fails keeps them for a resume. `ensure` takes `{ control, resolveFiles }` beside its input: `deps.refusal(control)` refuses a run tree (`refused:`), and `resolveFiles` runs only when the task is MADE. files.ts: `taskFilesRoot`, `resolveTaskFiles` (what the `human` step resolves `files` with). answer-files.ts: FILES FROM A WORKER (§5.6, item 8) — `attachmentRuleOf` (a type's `attachments`: `{ max, min, types }` over the defaults 1, 0, `image/*` + `application/pdf`; `max` 1 to 10, `min` 0 to `max`, 1 to 20 media types, `image/*` a family; a `RuleProblem` otherwise; null or absent takes none), `takesType`, `answerAttachments` (an answer's files: the chat's `parseAttachments` and caps, then the rule — none with none, too few, too many, a type not taken, each a sentence the service makes `bad_answer`), `saveAnswerAttachments` (into the run's artifacts as `tasks/<task id>/<name>` through the artifacts capability, a name already there numbered by `freeName`, one save of a task at a time in the process so two copies never pick one name; returns `RunAttachment`s), `attachmentRuleLine` (the rule as one line); the store keeps the type's rule in `task_types.attachments` and an answer's files in `leases.attachments` (both JSON, added by `ALTER TABLE`, `user_version` still 2); the service checks and saves in `submit` before `settle` (`deps.saveAttachments`, createStrut's; a test instance's dropped), hands the rule out on `task/next`, answers `ensure` with `attachments` (the settled answer's worker's lease's) and each copy's on `answers`, and `taskFile` serves a path an answer carried from the run's artifacts whatever the task's root; answer-files.test.ts the pure parts and one suite over both stores (the rule, refusals that write nothing, the record kept on file, a type that takes none, copies kept apart, a test instance's dropped, staff's read), worker-door.test.ts the door end to end (a photo through `/public/mcp` reaching the next agent's prompt) and the door's size. set-type.ts: `task/set-type`'s pieces (plans/human-steps.md §9.8) — `typeChangeInput` (the step's input: the name and every field `PUT /tasks/types/:name` takes, each checked as the store checks it — `answerSchemaProblem`, `testRulesOf` and `copiesRuleOf` on the shape alone, the bounds, pay to the msat — so a bad one is the model's error and no proposal is made; a ZodObject, so the gate adds `rationale`), `askOver` (a new ask built on the `task/set-type` card still WAITING for the same name in the thread, when no type exists yet: the step's `describe` keeps the merged ask on the record, shows the whole type, and replaces the waiting card, `ProposalDescription.replaces`), `mergeType` (the change over the type: a field left out kept, `tests` and `copies` merged over the type's own rules, `null` off; a new type needs `answer`, `bad_request`), `createTaskTypes` (`ctx.services.taskTypes`, createStrut's over the store the staff routes hold: `list()` — each type less `changedBy`, with `openTasks` (waiting + working; `open` is the type's own, open or invite-only), `workers` (live grants, a count), `answeredWeek` and `readyTests` from `stats()` when the store answers it — `appProblem`, `usdPerBtc`, and `save`, which reads the proposal's record and acts only on an `accepted` `task/set-type` record with `approver: "admin"` whose input with the decision's edits, parsed by `typeChangeInput`, is this name and change (`set_type_needs_admin:` otherwise), then `setType` with the merge and the decider as `changedBy`), `typeCard` (the card, for an admin who is not technical: title "New task: <name>" / "Change task:" / "Turn off task:", the name's dashes as spaces; a one-sentence summary — who can do it, when, the pay in dollars and sats; SHOWN: What changes for a change, A worker hands in (the photos, then each question by its title — `formProblem`, the kit's, held to the same verdict by set-type.test.ts, sends a form it cannot draw to The answer), When (any time for a standing type, naming its workflow; else when a workflow sends one), Who can do it (only people you invite, or anyone signed in; a paid type anyone may take with no qualifying test or short of `readyTests` a danger in plain words), Pay (dollars and sats, the wait before withdrawing, the last week's cost; a rise a danger); under Details (`CardField.detail`, which Jamie's card folds and a host that does not know it shows): Task type (name and app; the app's problem a danger, shown), The answer (one line per field), Time limits, Workers, Open tasks for a change, Tests and Copies (a merge the save would refuse a danger, shown); Approving it fails in the summary; actions "Approve" / "Don't"; it reads a type's rules, never a test). routes.ts: the STAFF's routes (§6), full scope only, reads included — `GET /tasks/types`, `PUT`/`DELETE /tasks/types/:name` (the PUT takes `open`; `409 needs_tests`), `GET /tasks/workers[?status=]`, `PUT /tasks/workers/:actor`, `PUT`/`DELETE /tasks/workers/:actor/grants/:type`, `GET /tasks[?type=&status=&workflow=&runId=&before=&limit=]`, `GET /tasks/:id`, `POST /tasks/:id/take-back { worker?, why }` (`409 released` past the hold), `PUT /tasks/:id/review { worker?, verdict, why? }` (§9.6; `404 no_answer`, `409 final`, `501` with a host's own store), `GET /tasks?review=none|ok|rejected` (the review queue), `GET /tasks/workers/:actor` (one worker with their standing, and — §9.4 — their live lease, their week by type (`workerWeek`: answered, skipped, ran out, of the leases taken in 7 days) and their newest 50 leases with each task, `activity`), `GET /tasks/stats[?type=]` (the queue, `stats`: the store's `stats` counts each type's real tasks — open with and without a live lease, the oldest, due in a day and an hour, live leases — and its windows, the newest 1,000 times of the week read once for all three; the service adds the workers by status and live grants by type (the worker side's `counts`), each type's `readyTests`, the held `task/next`s from memory, the p50 and p90 (`percentiles`, nearest rank); the routes add each type's `appProblem`, `taskAppProblem` over the app's manifest; before `/tasks/:id`), `GET /tasks?by=` (the tasks an actor answered, any copy: `id in` their submitted leases), `GET /tasks/:id` with `run` (createStrut's `runOf`: running here, the summary's status and `waitingOn`, `stale`, or null), `GET /tasks/:id/files/<path>` (`taskFile`: a path on the task's list, no lease, `not_listed`), `GET /tasks/workers` each with `week` (answers in 7 days) and `holding` (one grouped read, `workersNow`), `GET /tasks?test=true|false`, `GET /tasks?status=disputed`, a type's `copies`, a grant's `{ qualify: false }`, and the TEST routes, before `/tasks/:id` — `GET /tasks/tests[?type=&retired=]`, `GET /tasks/tests/:id`, `POST /tasks/tests`, `PUT /tasks/tests/:id/files/<path>` (raw bytes), `POST /tasks/:id/test`, `PUT /tasks/tests/:id`, `DELETE /tasks/tests/:id` — the only answers that hold an expected answer (`501` with a host's own store); a refusal `{ error, code }` (`400`, `404`, `409 in_use`); and the PAYOUT routes (§8.2), before `/tasks/:id` — `GET /tasks/payouts[?state=out|stale|paid|failed&worker=&before=&limit=]` (`{ settings, today, payouts }`, the defaults with no ledger), `PUT /tasks/payouts/settings` (the whole row with `changedBy`; `minSats` ≥ 1, each cap ≥ it), `POST /tasks/payouts/:key/read` and `…/resolve { action, feeMsat? }`, over payouts.ts whatever store the routes hold; specs/API.md §22. tasks.test.ts runs one suite over both; bag.test.ts what a step finds on the bag (a registry, a custom step and an agent's tool call: `ensure` alone); steps/core/human.test.ts the step and the source; staff-reads.test.ts §9.11's stats and reads over both stores with a fixed clock (waiting and working, a dead lease waiting and lost before the sweep, each window's edges, the medians, `asking` while a `next` is held, `?by=` with copies, a worker's week and leases, a task's file and `not_listed`); worker-door.test.ts the door end to end (a run parks, a signed-in visitor's page answers it through `/public/mcp`, the run finishes; a paid answer's run counts its pay, `task/me` shows it held then withdrawable, and only staff take it back) and §13's row 3; task-tests.test.ts §7.10's list for 4a over both stores (an instance indistinguishable to a page and in pay, nothing but the test routes holding an expected answer, no run woken, the draw with `random` fixed, qualifying, standing, re-grants, grader errors and a restart), a strut's grader run (an allowlist bag, the principal, nothing under `dataDir` or to `onRunEvent`), the routes, the redact guard over the registry, and a version 1 file migrated; set-type.test.ts §9.11's `task/set-type` row (the input checked before any proposal, the merge, the kit's form verdict, the card for a new type and a change with the pay-rise and app dangers, a direct call, a workflow's step, meta/run-step, a subflow and a custom step's call of the door refused, a forged `ctx.proposal`, a member's accept `admin_required:` and an admin's saved with `changedBy`, the admin's edits checked again, no expected answer on the record, `task/types`, and the seeds); task-copies.test.ts §7.10's "Copies" list over both stores (two leases to two workers, never two to one, settled only with both answers; the first agreeing answer and its `by`; `more` then `disputed`; a step comparator outside the transaction with no lease meanwhile, a failed one and a restart decided by the sweep; one copy as built; each copy's earning; the type's rule; a test made from a disputed task), and the decision's pure parts; steps/core/human.test.ts also the step's `answers` and `task_disputed:` with and without `onError`; task-review.test.ts the verdict over both stores (one per answer and the review filter, a copies task's answers apart, only a real task's answer, changed inside the hold and final after it, a first verdict after it final at once, nothing in the run touched, a rejection's take-back and `ok`'s restore over and over, a staff take-back never undone, no money after the hold, a copy's earning alone, standing moving on a rejection — and revoking — and back on `ok`, no standing on a type without tests) and a `tasks.db` from before gaining `reviews`; open-types.test.ts ruling 9 over both stores (a new worker takes an open type's tasks with no grant, the first ask recording one by `open`; qualifying first with K ready tests and a failed qualifying's revoke that sticks until staff grant again; suspended and banned refused, nothing recorded; invite-only still a grant; a paid open type refused at save short of tests and closed to newcomers when its tests drop, open again when they are back; `task/me` and `task/next` with no type over the app's open types; a held `next` of a new worker woken), and worker-door.test.ts's open type through `/public/mcp` end to end; payout-routes.test.ts §8.2 on a server (the `/tasks/payouts` routes full scope only, the settings with `changedBy`, the `staff/*` payout steps through the staff door, a withdrawal through the task service paying the session's address with the books balanced, two at once, suspended and banned workers, a host's own store `not_here`, nothing on the shared bag), and worker-door.test.ts `task/withdraw` through `/public/mcp` (an amount alone; `no_address` until sign-in keeps one, a member's page too); worker-loop.test.ts the worker loop's end-to-end test ("The loop end to end" above) over `__fixtures__/court-filing/` (the worker app, `app/`, and its workflow, `court-paper.yaml`; outside the engine's tsc), its door helpers shared with worker-door.test.ts and src/visitors.test.ts in `src/test-util/public-door.ts`. standing.ts: a STANDING type's pick-up read off its workflow (§5.7, item 9) — `standingTask(flow, type)`: the first step a top-level `human` step of the type with no `depends` and no `files`, its `show` reading only `input` and `params` (`exprRoots`) and resolved with the input's defaults and the params, the input valid with none given — `{ path, show }` or `{ problem }`; createStrut's `deps.standing` adds the workflow there and on and its owner. The store keeps the rule in `task_types.standing` and a standing task's `tasks.standing` and `tasks.launched_at` (`ALTER TABLE`, `user_version` still 2); `takeStanding`, `launched`, `unlaunched`; a standing task closes with its lease as an instance does, is never `take`n, swept as past due, cancelled with a run or counted as an expired task. standing.test.ts: over both stores (the save's check, an ask's task and lease with several workers at once, the answer's launch with no settle listener told, a skip and a lease run out closing with no run, the stats, a failed launch the sweep's once, a run's task before a pick-up, a workflow that can no longer be one), `standingTask`'s refusals, and a strut end to end (pick-ups, an answer, the run launched under the pick-up's id finishing with the answer and never parking)

### `src/support/`

SUPPORT (plans/support-chat.md items 1 and 2; "Support" above): the staff's chat with workers over the treasury daemon's DMs. store.ts: `supportSchema` (three tables in the task store's file, made by `openTaskDb` with the task store's own), `SupportStore` (one transaction per write: `ingest` a page of the feed with the cursor — each record in a savepoint of its own (one that throws is skipped and counted), its conversation made, its alias kept, its message added or changed by id or `clientId`, a new contact's welcome marked due — `dueWelcomes` / `startWelcome`, `addOwn` a send kept before it goes (a text, or a file strut keeps), `answered` (its status, and its Sphinx id at once), `claimRetry`, `abandonSends`, `markDeleted`, `setConversation` (status, assignee), `seen`, `payoutLines` / `setPayoutLines`, `photo` / `setPhoto`, the heads-up's `admins` / `waiting` / `headsUpDue` / `headsUpSent`, the welcome's `saveWelcome` (its `since` set when it turns on, kept by a save again, dropped by clearing), the files' `fetching` / `fileKept` / `fileFailed`, the reads `conversations` (unread first; `q` over alias, actor, the worker's note and text), `conversation`, `messages` (pages by key), `fileOf`, `unread`), `messageOf` (a deleted message without its text or file; `by` never out), `actorOfPubkey`. Imported at boot, so it imports `db.ts` for types alone (that loads `node:sqlite`). support.ts: `createSupport` — the daemon (`deps.daemon()`: the wallet's URL and message token, or null: `not_available`), the FOLLOWER (`tick`: pages of `GET /dms` until one is short, 20 at most a tick, the cursor per daemon URL; the welcomes due; the heads-up; up to 5 files fetched, each capped at 25 MB while it streams, written atomically), the due welcomes, the actions the routes call — a file read in 3 MB pieces, a staff file kept then sent, Delete, the picture, a conversation's status and assignee — `paidOut` (a payout's line, never throwing), `SupportError` (its code and status), `dmOf` (a feed record as strut keeps it, lenient on the time, `untimed` when it names none). `readCapped` is src/packages/archive.ts's. routes.ts: `supportRoutes`, full scope only. support.test.ts.

### `src/steps/lib/task/`

the WORKER's door to the task store (plans/human-steps.md §5.1), thin over `ctx.services.tasks` — on their OWN call's bag, the worker's calls alone (`TasksService.worker`, which the app door's `dispatch` adds for a `worker: true` step on `POST /mcp` and `POST /public/mcp`, `workerServices`; the shared bag carries `ensure` alone, plans/human-steps.md §9.2): task/next { type?, wait? } (the oldest open task of a type the worker holds — an OPEN type of the app they never held is entered first, plans/human-steps.md ruling 9 — that the CALLING app draws — `wrong_app` for another app's — or `{ none: true }`; `wait` ≤ 25 s holds for one), task/submit { lease, answer, attachments? } (the files a type's `attachments` rule takes, plans/human-steps.md §5.6, saved in the task's run), task/skip { lease, reason? }, task/file { lease, path } (one of the task's `files`, as `run/files` answers), task/withdraw { msat } (plans/human-steps.md §8.2: what passed its hold, keysent to the Sphinx address the viewer's SESSION carries — the door puts it on the call's bag as `WORKER_ADDRESS`, `workerCall` reads it there and nowhere else; the input is `msat` alone, `.strict()`, so a page that names an address is refused; `not_here` on a host's own store; a refusal `code: sentence`), task/me (status, the types held in this app and then its open types they may enter, each with what an answer earns, whether the worker is `qualifying` for it — a flag, no score, plans/human-steps.md §7.5 — whether it is `standing` and how many of its tasks are `waiting` that they could take (the store's `waitingFor`: take's guard without "holds nothing"), `holding` — the task in their hand — and the worker's `balance` — held, withdrawable, total, plans/human-steps.md §8.1; a first call writes the viewer `new`), `{ all: true }` on task/me and task/history reads the types of every app the caller can open instead of the calling app's (`appsOf` in `_shared.ts`, over `WORKER_APPS` — the door's list on the call's bag: the public view's apps on the public door, none on a member's, meaning every app; the service's `apps` filter), task/history (history.ts: their own newest 50 tasks of this app's types — `ask` from the task's `show`, how each ended, what a paid answer earned and when it clears, `takenBack` — never the run, a test or a reason; the dashboard's list, `TasksService.history` on `recentLeases` + the ledger's `payFor`; optional on a host's store, `{ items: [] }` without it). A type with tests may serve a test instance through task/next, task/submit, task/skip and task/file exactly as a task (§7.2). Each is `worker: true` (`StepDef.worker`: it decides from its own caller): the worker is `ctx.actor` in `ctx.app`, never an input; refused without either, and refused as anything but an app page's own call (a one-step run, never a workflow's step or an agent's tool, `_shared.ts` `workerCall`). On the app door a worker's step is never kept as a run (`keptFromApp`, no claims read); a signed-in visitor's page reaches one its app grants (`signedInRefusal`'s `worker` rule), an anonymous one is refused; not a visitor's daily write; the app monitor counts their `volume` per viewer. Two steps here are NOT a worker's (plans/human-steps.md §9.8; specs/API.md §22, "Asking for a task type"): set-type.ts, `task/set-type` — `effect: "write"`, `approver: "admin"`, its input `typeChangeInput` and its card `typeCard` (src/tasks/set-type.ts); it runs only as a proposal an admin accepted (`ctx.proposal`; a direct call, a workflow's step, meta/run-step and a subflow are refused) and saves through `ctx.services.taskTypes.save`, which checks the record on disk — and types.ts, `task/types` (`effect: "read"`, `{ types }` from `taskTypes.list()`: each type with `open`, and `openTasks`, `workers`, `answeredWeek`, `readyTests`). Only the `builder` seed grants them; a worker app granting `task/*` hands its page `task/types` (a member's page reads it, a visitor's is refused as any private read) and a `task/set-type` that refuses

### `src/steps/lib/staff/`

the STAFF's door to the task store (plans/human-steps.md §9.3; specs/API.md §14.15), for `strut/staff` alone: each step is one `/tasks…` route (or `/support…`, the `support-*` steps: support-list, support-unread, support-thread, support-send, support-seen, support-file, support-settings, support-save-settings, and item 2's support-update, support-delete, support-photo; plans/support-chat.md) made in process in the viewer's name through `ctx.services.staffAdmin` (createStrut's `staffAdminDoor`, `inProcessDoor` over `STAFF_ROUTES`: no other path), which the app door hands to the bag of ONE call — a first-party page's shown to an admin (src/apps/tools.ts `adminBag`, which also leaves the deployment's `onRunEvent` out) — and to nothing else; `_door.ts` `staffCall` refuses without it (`../_admin-door.ts` `adminDoorOf`, the check `earnings/*` shares) and throws a route's refusal with its `code` first. staff/stats, types, save-type, delete-type, round-items and send-round (Send a round: `GET`/`POST /tasks/types/:name/round`), workers, worker, set-worker, grant, revoke, tasks (with `review`, the review queue), task, file, take-back (5a), review (§9.6: `PUT /tasks/:id/review`), tests, test, save-test (a new test, or with `id` a change before it is served), test-file (base64 bytes, sent raw), test-from-task, retire-test (item 4), and item 5b's payouts (§8.2): staff/payouts (`GET /tasks/payouts`), staff/save-payouts (`PUT /tasks/payouts/settings`), staff/payout-read and staff/payout-resolve (`POST /tasks/payouts/:key/read` and `…/resolve`) — `strut/staff` grants them with its Payouts tab (item 5b's PR 3); staff/save-payouts takes `inviteSats` too. §5.8's invites: staff/invite { sats?, app? } (`POST /tasks/invites`; `effect: "write"` — the wallet pays the mixer; adds `qrSvg`, the link as a QR code, as staff/types' share), staff/invites { app? } (`GET /tasks/invites`) and staff/cancel-invite { code } (`POST /tasks/invites/:code/cancel`), for the Share block's Invite and the Workers tab's list. A route's in-process request is `http://strut.invalid`, so the invite routes take the base the share links use (`lastBase`, where the page's own request came, with any mount path). The ones that write an expected answer list `expected` in `redact`; none is kept as a run (`keptFromApp`). `effect` read or write, as their routes

### `src/steps/lib/grade/`

the GRADERS strut ships for test tasks (plans/human-steps.md §7.4, PR 4c): each `sealed: true` on its definition (`grade/*` is not a sealed namespace), `effect: "read"`, `expected` in `redact`, run only as a task type's or test's `grade: { step, config? }` through `grade-step.ts`'s `stepGrader` — its config `answer` and `expected` (with `show` and `type`, unread) and the grade's own `config` over them — and answering the claims check contract `{ supports, content }` (`mapCheckResult`). overlap.ts: `grade/overlap` — a BOX is `[x, y, w, h]` (§4.5's four numbers) or `{ x, y, w, h }`, w and h above 0, one unit for both sides; each side is a box, a list (`[]` is none) or, with `key`, an object holding one under `key`; passes when the boxes pair off one to one (augmenting paths, so the order drawn does not matter) at intersection over union ≥ `min` (0.7, in (0, 1]) — a missing box and an extra box each fail, none expected and none drawn passes; an `expected` that is not boxes throws (`error`, staff's mistake), an answer that is not boxes when the expected one is fails; `content` is the counts and each expected box's IoU to two places (`2 expected, 3 drawn, 2 matched at IoU ≥ 0.7; box 1: IoU 0.92; box 2: IoU 0.81; 1 drawn box matched nothing expected`), never a coordinate. judge.ts: `grade/judge` — ONE `generateText` on the model the llm step builds (`resolveModel` with `stepAuth`, so `llmAuth` routes it and the run's principal and `maxCostUsd` reach the gateway; the output marked with `withUsage`, the spend counted as the llm step counts it), on the grade's `model`, else `STRUT_DEFAULT_MODEL` through `secrets` (the agent step's fallback, without `STRUT_LLM_MODEL`), else it throws; a short system prompt and the `rubric` (default `DEFAULT_RUBRIC`: says what the expected answer says, wording aside), `expected` and `answer` in tags, the values as JSON with `<` escaped so an answer cannot close its tag; the reply must be ONE line `PASS: <reason>` or `FAIL: <reason>` (`parseVerdict`), the reason the `content`; anything else throws, so a garbled reply grades `error`, never `pass`. The worker's answer reaches the model as data, which a determined worker may still try to talk past: staff read each grade's note on `GET /tasks/tests/:id`. grade.test.ts: both through `stepGrader` and `mapCheckResult`, overlap's edges (no boxes, extra, missing, exactly at `min`, the pairing, malformed sides), judge with a stand-in model (`registerModelWrapper`: pass, fail, garbled replies, the default model and none, the spend on `step.end`, `llmAuth` told the principal and the cap), both refused by `graderProblem` with `sealed` removed, and a strut whose types grade with each, answered through the task store (pass, fail, `error` counting for nothing)
