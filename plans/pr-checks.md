# A job's pull request fails its checks: strut wakes the job once

Status: PROPOSED (2026-11-22), for Evan to discuss. Nothing is built.
Each open question below has a recommended default.

Revised 2026-11-23, on Evan's go-ahead: the work is split. Strut does
what acts as a person: the index, the read, the one turn. strut-github
says when to look, with a `schedules:` entry now and its `hooks:` route
later. There is no core timer and no environment variable.

## The ask

A job on a Stadeum box (Jamie, on stadeum.stakwork.ai) opens a pull request
and ends its turn while CI is still running. Code Change §6 (strut-code)
tells it not to wait. When CI then fails, nothing on the server notices.
The Jamie app's PR card reads `github/pr-status` every 30 s, but only while
someone has it open, and its Fix is a click.

Hive already handles this for the jobs it hosts. When every check on a
job's pull request has finished and one failed, Hive sends the job one
`checks failed` turn, once per pull request. This plan ports that into
strut, so a box with no Hive gets it too. It is built from pieces strut
already has.

## Hive's version, the model

`src/services/strut-jobs/check-failures.ts` (hive `master`). The design is
strut's own `plans/job-artifact-events.md` §3 and §5 (removed from main;
`git show 96be46e0:plans/job-artifact-events.md`).

- **Triggers.** Every completed `check_run` or `workflow_run` webhook, and
  the settle of a turn that reported the pull request.
- **Lookup.** The jobs whose reported artifacts include that pull request's
  URL (Hive's `StrutJobArtifact` table).
- **Read.** The pull request's live state, with the job owner's token.
- **Decide.** Merged or closed: nothing. A check still running: nothing.
  Every check passed: nothing. Every check finished and one failed: one
  `checks failed` turn, as the job's owner, in the job's conversation.
- **Once.** `autoEventAt` on the ref's row is taken atomically before the
  launch and given back only if strut refused the launch. After that, every
  fix is a person's click on the card.
- **Busy.** Hive can't wait on a live turn, so it stores the event on the
  row and the turn's settle sends it.
- **The reply** lands on the job, and the orchestrator wakes as after any
  turn.

## What strut already has

- **The read.** `readPullRequest` (`src/steps/lib/github/pr-status.ts`)
  returns the state, the head, and every check as
  `failed | running | passed | skipped`, with counts.
- **The person's token.** The person's `GITHUB_TOKEN` is their own actor
  secret (stadeum/github 0.2.0 writes it). `secrets.forPrincipal(p)` reads
  it as any run of theirs would. The secret for github.com comes from the
  box's git host map (`src/git-hosts.ts`).
- **The turn.** The card's Fix is `run/launch` of the job's workflow with
  `input: { prompt: fixPrompt(s) }`, the `job` and the `conversation`.
  Because the app is first-party, the launch carries `wake: true`, so the
  turn's end wakes that conversation (`wakeOnEnd` → `wakes.jobEnded`).
- **The words.** `fixPrompt`, `prOf` and `prLive` in
  `src/apps/jamie/src/lib/pr.ts`.
- **The pattern for a small index.** `jobs/.sweep/<id>` is one empty file
  per job the sweep must look at, kept by `updateJobRecord` under the
  record's lock, so the sweep never reads every record.
- **A package's trigger.** Package schedules (strut#791): a `schedules:`
  entry in a package's `strut.yaml` runs one of its workflows on the
  automations' closed grammar (`interval` with `minutes`, and so on). An
  admin can switch it on or off. It runs as the workflow's owner
  (`runsAs`, strut#794). On a box that follows the package, that owner is
  the person who followed it.
- **A package never names a person** (stadeum `plans/software.md` §5,
  item 15). A package's steps are fenced to their run's person
  (`src/packages/fence.ts`). A package's workflow launches through core
  steps, which run as that run's person. So the package can't read a PR as
  each job's person, or start a turn as them. Strut has to do both.

What's missing on a Stadeum box: a pull request → job index, the
once-only mark, and a trigger.

## Where each part lives

- **Strut core:** everything that acts as a person. That's the index on
  the job record (§1), the check that reads as each job's person and
  launches the one turn (§2), and one step that runs the check,
  `job/pr-checks { url? }` (§3). It takes no person and no text, so its
  caller can only make strut look sooner.
- **strut-github (stadeum/github):** when to look. A `schedules:` entry
  that runs `job/pr-checks` every 5 minutes, and later its `hooks:` →
  `on-event` workflow, calling `job/pr-checks { url }` when a `check_run`
  or `workflow_run` completes (§3).
- **strut-code:** one line in Code Change §6.
- **Stadeum:** nothing. A box has this when it follows strut-github.

## Proposal

### 1. The index: on the job record, with a `.prs` mark

When a job turn ends (a top-level run of a `JOB_WORKFLOWS` workflow),
`createStrut` already resolves the run's artifacts (`artifactRefs`) and
decides its wake. If two things are true:

- an artifact is a GitHub pull request (`kind: "pull_request"` and a
  `github.com/<owner>/<repo>/pull/<n>` link, Jamie's `prOf` rule), and
- the end names a conversation strut wakes (its `wake` is not `none`),

then strut writes one entry per pull request onto the job's record:

```ts
pullRequests?: Array<{
  url: string;            // https://github.com/<owner>/<repo>/pull/<n>
  runId: string;          // the turn that reported it, newest
  at: string;             // when that turn ended
  conversation: string;   // startedBy.session ?? conversation: the one its end woke
  actor?: string;         // that turn's run.start
  principal?: string;
  model?: string;         // that turn's params.model
  fixed?: { at: string; runId?: string }; // the one automatic fix: taken
  over?: "merged" | "closed";
}>;
```

A later turn that reports the same URL refreshes `runId`, `at`,
`conversation` and the person, and keeps `fixed`. The write goes through
`updateJobRecord`, which also keeps `jobs/.prs/<id>`: an empty file for each
job with a WATCHED entry. An entry is watched when it has no `fixed`, no
`over`, and is less than 7 days old (a constant, like the sweep's TTL). Only
watched entries are polled, so the checker never reads every record.

It's written on every box. Only `job/pr-checks` reads it (§3), so where
nothing calls that, it's a few empty files that `deleteJob` removes with
their records. Records from before need no backfill: an old job's pull
request was handled by hand anyway.

The record is a file under `dataDir`, not a workspace node, so no graph
schema changes.

### 2. The check: Hive's `sendOnce`, per job

`src/pr-checks.ts`, `checkJob(job)`. For each watched entry:

1. Read the token: the github.com secret, bound to the entry's `principal`.
   No token, or GitHub refuses the read: `unread`. The entry stays watched,
   and the warning is logged once per entry, not on every pass.
2. `readPullRequest(octokit, owner, repo, number)`, without logs.
3. Merged or closed: stamp `over`, and the entry stops being watched.
   `counts.running > 0`: `running`. `counts.failed === 0`: `clean`. The
   entry stays watched, because a later push can fail. Otherwise: `failed`.

Then for the job's `failed` entries:

- **The job's newest turn is live** (a turn in flight): `busy`. Nothing is
  taken, and the next pass tries again. Polling retries on its own, so
  strut needs nothing like Hive's pending column or settle hook.
- **Otherwise,** take `fixed` on each failed entry under the record's lock.
  An entry already taken by another pass is `taken`. Then launch ONE turn
  that names all of them. If the launch throws, the marks are given back
  (Hive's `skipped`). If it starts, `fixed.runId` is the run.

The launch is the card's Fix, made by the server:

```
launchDetached(turnOf(rec.runs).workflow,          // job, as job/continue picks it
  { input: { prompt }, job, conversation, wake: true,
    params: model ? { model } : undefined },
  { actor, principal })                            // the reporting turn's person
```

`wake: true` with `conversation` is what the Jamie app's launch already
sends. The run records `wakeAsked`, and `wakeOnEnd` relays the turn's end to
that conversation, where the orchestrator tells the person in one line or
stays silent, as after any job turn.

### 3. The trigger: strut-github's schedule now, its webhook later

**The step, in strut:** `job/pr-checks { url? }` (`src/steps/lib/job/`),
backed by a `prChecks` capability that `createStrut` puts on the services
bag.
- With no `url`, it makes one pass: it reads `jobs/.prs/` and runs
  `checkJob` for each job there, one job at a time.
- With a `url`, it runs `checkJob` for each job watching that pull
  request.
- It takes no person and no text. It answers with counts only
  (`{ jobs, sent }`), nothing from anyone's job.
- One pass runs at a time. A call made while a pass runs returns once that
  pass is done, and starts nothing of its own.
- A box with nothing watched reads one empty folder.

**The trigger, in strut-github 0.3.0:**

```yaml
schedules:
  - name: pr-checks
    workflow: pr-checks          # one step: job/pr-checks
    trigger: { interval: { minutes: 5 } }
```

The schedule runs as the package's owner, who reads nothing and launches
nothing themself. The step does both, as each job's person. An admin
switches it off as any package schedule. Its runs are visible to
whoever opens the automation's runs: one step, two counts.

**Against the 2026-11-19 ruling** (stadeum `plans/software.md` §10, row 10:
repository webhooks to each box's strut, polling as the fallback), polling
first is still the right order:

- **The webhook isn't there yet.** It needs stadeum's §5 item 7: `hooks:`
  routes on strut's public origin, signature schemes, a hook secret, and
  stadeum/github creating a webhook on each repository. None of it exists.
- **The ruling asks for the poll anyway.** Building it first builds the half
  that stays.
- **Minutes are fine here.** The fix turn itself takes minutes. Polling also
  needs no public route and no signatures.
- **The webhook is a trigger, not a redesign.** When `hooks:` lands,
  stadeum/github's `on-event` workflow calls the same step with the pull
  request's URL, `job/pr-checks { url }`, and the schedule stays as the
  fallback. The step gives its caller nothing: it reads as each job's own
  person, and fires at most once. A forged delivery only makes strut look
  sooner.

**Cost.** Each watched pull request costs 3 GitHub reads per pass (the pull,
its check runs, its statuses), on its person's token. Every 5 minutes, that
is 36 an hour per pull request, against a user token's 5,000 an hour. For
comparison, an open card reads 360 an hour.

### 4. The message

The card's `fixPrompt` wording, one sentence per failed pull request, then
one line saying who sent it:

```
The checks on stakwork/peel-android#139 failed: build. Find out why, fix it, and push the fix to feature/login — the same pull request.
Strut sent this when the checks finished. The person didn't type it.
```

The second line is for the agent, and for the person reading the job's
thread, where the prompt shows as the turn's message. Code Change §6
already says how to fix: read why with `logs: true`, fix on the same
branch, push, and say what failed. So the message names only what failed.

The engine can't import the app (`src/apps/jamie/**` is outside its build),
so `src/pr-checks.ts` keeps its own `checksFixPrompt`, and `jamie.test.ts`
pins that it says what `fixPrompt` says for the same pull request.

### 5. The loop guard and the burst-to-one rule

- **Once per pull request, ever.** This is Hive's rule. `fixed` is taken
  before the launch and given back only when the launch throws. A fix that
  fails again is shown on the card, and the next fix is a person's click. It
  is the twin of `WAKE_MAX`.
- **One turn per job per pass.** A job with two failing pull requests gets
  one turn that names both, and both marks are taken.
- **Never beside a live turn.** A job with a turn in flight is skipped
  without taking anything.
- **One pass at a time,** in one process. Every take happens under the
  record's lock, so a `job/pr-checks { url }` from the webhook running
  beside a pass finds the mark taken.
- **The race that's left:** a person's Fix landing between the busy check
  and the launch. One of the two runs then fails with `job_busy:`. That's
  harmless, because the other is already fixing it.

### 6. Which conversation is woken

The one the reporting turn's end woke: `startedBy.session` (a job the
orchestrator started), or else the launch's `conversation` (a card's
turn). If several turns reported the pull request, the newest wins, since
that conversation last heard about it.

Hive instead uses the job's first row's conversation. In strut, a job's
newest turn is the closer match. A turn whose end woke nobody isn't
indexed, so there's always somewhere for the reply to land.

### 7. What the PR card shows

`job/get` (the `JobView`) gains `pullRequests` from the record. The card
already reads `job/get`. When its pull request's entry has `fixed`, the
card shows one line under the checks: "Strut asked the job to fix this
when the checks failed · 14:02".

Fix stays as it is. It's how a second fix happens. While the automatic turn
runs, a click is refused as it is today: "The job is still working — try
again in a minute."

## Open questions, each with a default

1. **Where is it on?** Settled by where the trigger lives. It's on where
   a box follows strut-github 0.3.0, and off everywhere else. That
   includes Hive's swarms, which wake their jobs themselves; if both did
   it there, a job would get two turns. An admin switches it off with the
   schedule's switch. **Default: the schedule ships on**, every 5 minutes.
2. **Whose token, and who runs the turn?** **Default: the person of the
   turn that reported the pull request** (its `actor` and `principal`).
   Their token pushed it, and their bill pays. In practice that is the
   job's `createdBy`. The two differ only when someone else continued the
   job in a shared conversation, and then the newest is the one to ask.
3. **Does a person's Fix click spend the automatic one?** **Default: no.**
   That's Hive's rule: a click is a person's, and the automatic turn is
   strut's one. A busy job is skipped anyway, so a click that is still
   running blocks the automatic turn. One that has finished doesn't. If
   CI is still red after that turn, one more attempt is cheap.
4. **Should the wake say the turn was automatic?** **Default: no.** The
   wake says "which was started from this conversation", which is true.
   The job's reply says what it did, and the prompt's second line is in
   its thread.
5. **How long to watch.** **Default: 7 days from the newest turn that
   reported it,** a constant. A pull request nobody has touched in a week
   is a person's to come back to.
6. **Where the message's words live.** **Default: the engine's own copy,
   pinned by a test** to the card's `fixPrompt`. The alternative is a
   dependency-free file kept in both places (`src/tasks/answer-schema.ts`
   does that), which is more ceremony for one sentence.

## Not in this

- **Merged and closed events** (Hive's other artifact events, which
  release a pod). Nothing on a Stadeum box holds a pod across a merge yet.
- **Review comments asking for changes.**
- **Other forges.** `readPullRequest` is GitHub's. GitLab and Forgejo come
  with their packages.
- **The webhook route itself** (stadeum §5 item 7). Only the step it would
  call is sketched here.
- **Granting `job/pr-checks` to the agent.** Nothing needs it: the job's
  own turn reads its checks with `github_pr_status`.
- **A pending queue for a busy job.** The next pass is the retry.
- **Conditional reads (ETags)** to make a pass cheaper. Add them if the
  read count ever matters.

## Work items

One strut PR, then strut-github 0.3.0 once a strut with the step is on
`stable`, then a one-line change to strut-code.

1. **`src/jobs.ts`:** `pullRequests` on `JobRecord`, and the
   `jobs/.prs/` mark kept by `updateJobRecord` (watched = no `fixed`, no
   `over`, newer than 7 days). `deleteJob` removes the mark with the
   record.
2. **`src/pr-checks.ts`:** the pure part (`prUrlOf`, the outcome of a
   `PrStatus`, `checksFixPrompt`) and `createPrChecks(deps)`, which
   provides `watch(job, end)`, `checkJob(job)` and `pass()`. Tests use a
   fake `PrStatusApi` and a stub launcher, and cover: running, clean,
   merged, failed → one launch with `conversation` + `wake: true`, a second
   pass → `taken`, busy → nothing then later a launch, a launch that throws
   → the mark given back, two pull requests → one turn, no token →
   `unread` and still watched.
3. **`src/createStrut.ts`:** `watch` in the run-end path beside
   `wakeOnEnd` (once the wake outcome is known), and the `prChecks`
   capability on the services bag.
4. **`src/steps/lib/job/pr-checks.ts`:** the step, `{ url? }` →
   `{ jobs, sent }`. Tests: a pass, one URL, and a call during a pass
   waiting for it and starting nothing.
5. **`job/get` / `GET /jobs/:id`:** `pullRequests`. The Jamie card shows
   the line. `JobView` gains the field.
6. **Docs:** `docs/jobs.md` (a key concept, the file and the step). In
   `specs/API.md`, the `GET /jobs/:id` field and the step.
7. **strut-github 0.3.0** (stakwork/strut-github), after strut's `stable`
   has the step:
   - `workflows/pr-checks.yaml`, one `job/pr-checks` step;
   - the `schedules:` entry;
   - the README;
   - a package test that the schedule is declared and that its workflow
     runs the step.

   On an older strut the step is unknown, and each fire fails saying so.
   That's why the package waits for strut.
8. **strut-code:** Code Change §6 gets one line under "Still running": if
   they fail later, strut sends you one turn to fix them.

## Validation

On stadeum.stakwork.ai, following strut-github 0.3.0:

1. Ask Jamie for a change in a test repository whose CI will fail (a
   failing test on the branch).
2. The job opens the pull request and ends while CI runs.
3. Within one pass after CI finishes:
   - one fix turn starts on the job;
   - Jamie's conversation gets the wake's line;
   - the card shows "Strut asked the job to fix this".
4. Break CI again by hand. Nothing more is sent. Fix still works on a
   click.
5. Merge a watched pull request. Its entry gets `over`, and the job leaves
   `jobs/.prs/` once nothing else of it is watched.
