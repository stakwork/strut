# A step says "look again later": strut wakes the job once it has settled

Status: BUILT in strut, 2026-11-24. The pods package's `bake` is the first
user (stakwork/pods, `feature/bake-wake`), once this strut is on `stable`.

## The ask

Seen on stadeum.stakwork.ai on 2026-11-24: a Pod Setup job baked twice.
Each bake takes 9–10 minutes. `stadeum/pods/bake` starts the build and
returns at once, and its answer says to call `bake { status: true }` once
the image is ready. The agent had nothing to wait with but `sleep` in bash,
so it slept 290 seconds between looks and read each status about five
minutes late. The job was busy the whole time, so the person could not
redirect it (`job_busy:`).

Evan's standing ruling (2026-11-10): to a job agent a long task is
asynchronous. It ends its turn and wakes when the task ends; no tool call
waits inside the turn. The CI wake (plans/pr-checks.md) has that shape, but
its look is GitHub's code in core. This is the generic one: any step can
ask for it.

## What it does

A step running in a job's turn asks strut to follow up:

```ts
await ctx.services.jobs.followUp({
  job: ctx.job, runId: ctx.runId,
  id: "bake",                                  // the same id again replaces it
  look: { type: "stadeum/pods/bake", input: { status: true } },
  everySeconds: 60,                            // 30–3600, default 60
  limitMinutes: 45,                            // up to a day, default 60
});
```

Strut then:

1. **Looks.** Every `everySeconds` it runs the look step, as the person of
   the run that asked, outside any run (a proposal's apply is the model:
   `secrets` and `llm` bound to the person, `actor` and `principal` on the
   context, the job). A look that throws is tried again next time.
2. **Settles** when the step's output says `settled: true`. The test is the
   step's own field, never an expression.
3. **Sends one turn** of the job: its own workflow (`turnOf`), as that
   person, naming the conversation the asking turn woke, `wake: true`,
   with the job's `kind` and `peer` carried as `job/continue` carries them
   (so the turn opens with the kind's page, and its claims judge it). So
   `wake.ts` relays its end to the conversation, as for the CI wake. The
   prompt is the look and its output:

   ```
   stadeum/pods/bake {"status":true} settled. Its answer:
   {"images":[{"image":3,"state":"ready"}],"stack":{...},"settled":true}
   Strut sent this when it settled: a step of an earlier turn asked it to follow up. The person didn't type it.
   ```
4. **Times out** past its limit: one turn saying the look didn't settle,
   with its last answer or error.

Then the follow-up is gone from the record.

## The rules

- **Durable.** `JobRecord.followUps`, beside `prFixes`. A mark,
  `jobs/.follow-ups/<id>`, names the jobs that have one, so a look reads
  those records alone. A restart looks again at once.
- **The person is strut's.** The ask names a run, never a person. Strut
  checks that the run is one of the job's runs, and reads who ran it and
  where its end went from its `run.start` (`turnPerson`, the reader
  pr-checks uses too). A package's step holds `followUp` to its own run
  and job, and to a look among its package's own steps (the fence,
  `heldToItsRun`).
- **Not in a trial.** A trial's job is closed once its run is judged, so a
  trial's run is refused one; its step looks within the turn, as before.
- **Never beside a live turn.** A follow-up that settled while a run of
  the job is in flight keeps its prompt on the record (`ready`), and the
  turn goes on the first tick the job is free. The check is the one
  `job/start` makes, synchronous before the launch, so the turn itself
  never fails `job_busy:`.
- **Once.** The follow-up is taken off the record under the record's lock
  before the launch, and put back if the launch is refused.
- **One turn per job.** Follow-ups of one job that are ready together go
  as one turn.

## Who drives the look: strut's own timer

A core timer, armed only while a follow-up is pending: when one is asked
for, and at boot when a mark is left. It ticks every 15 seconds, reads the
marked jobs, and looks at each follow-up whose time has come.

Why not a package schedule, as strut-github drives pr-checks:

- **The cadence is the step's.** A bake wants a look a minute; a schedule
  fires on its own clock for every box that follows the package, pending
  or not.
- **Generic.** Any package's step asks with one call. With schedules each
  package would ship a workflow and a schedule, and a box would wake its
  jobs only once its admin left the schedule on.
- **No second wake on Hive's swarms.** Only a step that asks gets a turn,
  and nothing on a swarm asks: the lab's `pod/*` steps don't, and Hive has
  no wake of its own for these. pr-checks needed the package split because
  Hive already sends the check-failure turn itself.

## Reused, not copied

- The turn's launch (`launchJobTurn`) and the reader of a run's person
  (`turnPerson`) are one function each in createStrut, shared with
  pr-checks. So pr-checks' fix turn now also checks for a run in flight
  with nothing awaited before its launch, and carries the job's kind, as
  the card's Fix (a continue) does.
- `editFollowUps` is `editPrFixes`' twin, with the mark.
- **pr-checks could sit on this later:** a turn that reports a pull
  request would ask for a follow-up whose look is `github/pr-status`, with
  `settled` once every check finished. Not moved now: its schedule, its
  week-long watch and its once-per-PR mark work, and Hive's swarms must
  keep not getting it.

## Not in this

- A route or a step to list a job's follow-ups. `GET /jobs/:id` doesn't
  show them; the person sees the turn when it comes.
- Cancelling one. The agent ends the job, or the limit does.
- Waking on an event instead of a look (a webhook). The look is the
  fallback any event would keep.

## Work items

1. **Strut, done:** `src/follow-ups.ts` and its tests (with a run through a
   whole strut); `JobRecord.followUps` with `editFollowUps` and the mark
   (`src/jobs.ts`); `followUp` on the jobs capability and the fence;
   `docs/jobs.md`.
2. **stadeum/pods:** `bake` asks for the follow-up when it starts a bake,
   says `settled` on its answer, and tells the agent to end its turn. The
   `Pod` and `Pod Setup` pages say the same. It needs this strut on
   `stable`: on an older one, `followUp` is missing and bake says to look
   with `status: true`, as before.

## Validation

On stadeum.stakwork.ai, once both are out:

1. Start a Pod Setup job for a workspace.
2. The job bakes and ends its turn saying it is baking.
3. Within a minute of the image being ready, one turn starts on the job,
   saves the stack and writes the workspace's page, and Jamie's
   conversation gets the wake's line.
