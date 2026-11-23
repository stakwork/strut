# A job's pull request fails its checks: strut wakes the job once

Status: BUILT in strut (stakwork/strut#835), 2026-11-23. strut-github
0.3.0's schedule follows once this strut is on `stable` (work item 4).

History:
- 2026-11-22: proposed. It put an index of each job's pull requests and a
  core timer in strut.
- 2026-11-23, Evan:
  - split the work: strut does what acts as a person, and strut-github says
    when to look;
  - then "isn't a pull request already an artifact?" A job's pull requests
    are its artifacts, so strut keeps no list of them. The only new state is
    one mark per pull request: the fix strut sent.

## The ask

A job on a Stadeum box (Jamie, on stadeum.stakwork.ai) opens a pull request
and ends its turn while CI is still running. Code Change §6 (strut-code)
tells it not to wait. When CI then fails, nothing on the server notices.
The Jamie app's PR card reads `github/pr-status` every 30 s, but only while
someone has it open, and its Fix is a click.

Hive already handles this for the jobs it hosts. When every check on a
job's pull request has finished and one failed, Hive sends the job one
`checks failed` turn, once per pull request. This ports that into strut,
so a box with no Hive gets it too.

## Hive's version, the model

`src/services/strut-jobs/check-failures.ts` (hive `master`). The design is
strut's own `plans/job-artifact-events.md` §3 and §5 (removed from main;
`git show 96be46e0:plans/job-artifact-events.md`).

- **Triggers:** every completed `check_run` or `workflow_run` webhook, and
  the settle of a turn that reported the pull request.
- **Lookup:** the jobs whose reported artifacts include that URL (Hive's
  `StrutJobArtifact` table).
- **Read:** the pull request's live state, with the job owner's token.
- **Decide:**
  - merged or closed: nothing;
  - a check still running: nothing;
  - every check passed: nothing;
  - every check finished and one failed: one `checks failed` turn, as the
    job's owner, in the job's conversation.
- **Once:** `autoEventAt` on the artifact's row, taken before the launch
  and given back only if strut refused it. After that, every fix is a
  person's click on the card.

## Where each part lives

- **Strut core: what acts as a person.** A package never names a person
  (stadeum `plans/software.md` §5, item 15). A package's steps are fenced
  to their run's person, and its workflow's launches run as that run's
  person. So reading a pull request as each job's person, and starting a
  turn as them, is strut's: `src/pr-checks.ts`, behind one step,
  `job/pr-checks`.
- **strut-github: when to look.** A `schedules:` entry runs
  `job/pr-checks` every 5 minutes. Later, its `hooks:` → `on-event`
  workflow calls `job/pr-checks { url }` when a check finishes, and the
  schedule stays as the fallback.
- **The GitHub steps stay in strut core.** `github/pr-status`,
  `github/merge-pr` and the rest are engine-shipped integrations. Strut's
  own Jamie app uses them (the PR card), as any strut can. strut-github
  holds a person's account (connect, paste, disconnect, installations) and
  the box's switches (`job.tools`, and now the schedule).
- **Stadeum: nothing.** A box has this when it follows strut-github 0.3.0.

## What strut does (`src/pr-checks.ts`)

**Which pull requests.** A job's are already its artifacts: each of
`kind: "pull_request"` with a github.com link (`prOf`, the card's rule),
read through the job index (`JobView.artifacts`), with the run that last
reported it. That run's `run.start` gives:
- **the conversation** its end woke: `startedBy.session`, else the launch's
  `conversation`;
- **the person:** its actor and principal;
- **the model:** its `params.model`.

A pull request whose run woke no conversation is not read: there's nowhere
for the reply to land, and the person fixes it from the card.

**Which jobs.** Those used in the last 7 days, newest first from the
`.used` index, stopping at the first older one. A job with no runs is
skipped.

**The read.** `readPullRequest` with the person's `secrets.git(url)`:
their own token for github.com, as any run of theirs reads it. A missing
token or a refused read is warned once per process.

**The outcome:**
- merged or closed: nothing;
- a check still running: nothing;
- none failed: nothing;
- otherwise: failed.

**The turn.** One per job, naming every failed pull request. It runs as
that person, on the job's own workflow (`turnOf`). It's the card's Fix,
made by the server:

```
launchDetached(job workflow,
  { input: { prompt }, job, conversation, wake: true, params: { model } },
  { actor, principal })
```

`wake.ts` relays its end to the conversation. The orchestrator tells the
person in one line, or stays silent, as after any job turn.

**The words.** `checksFixPrompt`, the card's `fixPrompt` (a test pins
them equal), one sentence per pull request, then:

```
The checks on stakwork/peel-android#139 failed: build. Find out why, fix it, and push the fix to feature/login — the same pull request.
Strut sent this when the checks finished. The person didn't type it.
```

Code Change §6 already says how to fix: read why with `logs: true`, fix on
the same branch, push, and say what failed.

**The rules.**
- **Once per pull request, ever:** `JobRecord.prFixes[url]`, the only new
  state.
  - It's taken under the record's lock before the launch, with
    `editPrFixes`, which is not a use: `usedAt` stays.
  - It's stamped with the run's id once the turn launches, and given back
    if the launch throws.
  - A fix that fails again is a person's click on the card.
- **Never beside a live turn:** a job whose directory a run holds
  (`jobHolder`) is passed over without taking anything. The next pass is
  the retry.
- **One pass at a time:** a call while a pass runs gets that pass's result
  and starts nothing.

**The step:** `job/pr-checks { url? }` → `{ jobs, sent }`, which runs
`ctx.services.prChecks.check`. With `url`, it reads that pull request
alone. It takes no person and no text, so a caller, or a forged webhook,
can only make strut look sooner.

**Cost:** each pull request read costs 3 GitHub reads (the pull, its check
runs, its statuses), on its person's token. A pull request sent its fix is
never read again. A merged or closed one is read each pass until its job
is a week old. Every 5 minutes that's at most 36 reads an hour per pull
request, against a user token's 5,000. An open card reads 360.

## The strut-github side (0.3.0)

```yaml
schedules:
  - name: pr-checks
    workflow: pr-checks          # one step: job/pr-checks
    trigger: { interval: { minutes: 5 } }
```

The schedule runs as the package's owner, who reads nothing and launches
nothing themself: the step does both, as each job's person. An admin can
switch it off as any package schedule. On a strut without the step, each
fire fails with "unknown step", which is why the package waits for strut's
`stable`.

## Open questions, with the rulings and defaults

1. **Where is it on?** Settled by the split. It's on where a box follows
   strut-github 0.3.0, and nowhere else. That includes Hive's swarms, which
   wake their jobs themselves; with both, a job would get two turns. **The
   schedule ships on.**
2. **Whose token, and who runs the turn?** **The person of the run that
   reported the pull request.** Their token pushed it, and their bill pays.
3. **Does a person's Fix click spend the automatic one?** **No**, as in
   Hive. A busy job is skipped, so a click still running blocks the
   automatic turn.
4. **Should the wake say the turn was automatic?** **No.** The prompt's
   second line says so in the job's thread.
5. **How long to watch?** **7 days from the job's last use**
   (`PR_WATCH_MS`).
6. **Where the words live:** **the engine's own copy**, pinned by a test to
   the card's `fixPrompt`.

## Not in this

- **A line on the PR card** saying strut sent the fix. The card would read
  `prFixes` through `job/get`. Add it if people ask what happened.
- **Merged and closed events** (Hive's other artifact events, which release
  a pod). Nothing on a Stadeum box holds a pod across a merge yet.
- **Review comments asking for changes.**
- **Other forges.** `readPullRequest` is GitHub's.
- **The webhook route itself** (stadeum §5 item 7). The step it would call
  is here.
- **Granting `job/pr-checks` to the agent.** Nothing needs it: the job's
  own turn reads its checks with `github_pr_status`.

## Work items

1. **Strut (#835), done:**
   - `src/pr-checks.ts` and its tests (`src/pr-checks.test.ts`, which
     includes a run through a whole strut with GitHub's API answered
     in-process);
   - `JobRecord.prFixes` with `editPrFixes` (`src/jobs.ts`);
   - the `job/pr-checks` step and the `prChecks` capability
     (`src/createStrut.ts`);
   - `docs/jobs.md`.
2. **strut-github 0.3.0:**
   - `workflows/pr-checks.yaml`, with its one `job/pr-checks` step;
   - the `schedules:` entry;
   - the README;
   - a package test.

   Merge it after strut's `stable` has the step.
3. **strut-code:** one line in Code Change §6, under "Still running": if
   they fail later, strut sends you one turn to fix them.

## Validation

On stadeum.stakwork.ai, following strut-github 0.3.0:

1. Ask Jamie for a change in a test repository whose CI will fail.
2. The job opens the pull request and ends while CI runs.
3. Within 5 minutes of CI finishing:
   - one fix turn starts on the job;
   - Jamie's conversation gets the wake's line.
4. Break CI again by hand. Nothing more is sent, and Fix still works on a
   click.
