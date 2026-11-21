# Plans: the orchestrator carries a plan to its end

Status: RULED, not built (2026-11-21). Evan ruled all six questions as
recommended, with one change: code lands as one pull request per
repository, since a plan often spans several. The choices under "Mine" were
made while writing this and are open to a ruling.

## The ask

On a large plan the person has to say "ok, do the next work item" after
every item. The orchestrator should move along a plan to its end on its
own. The way of working that has held up best:

- The orchestrator talks to the person and reviews the work: it makes
  sure the contracts between the parts match.
- The work is split into a few LARGE work items, each handed to a session
  of its own, in stages.
- The plan document is the record, and the person does not read it. The
  person gets a short overview and a list of open questions, each with a
  default. Saying "go" always works. So does ruling on each one.

## What strut already has

- **The wake chains.** When a job ends, strut runs one more orchestrator
  turn with the job's reply (`src/wake.ts`). A job that turn starts wakes
  the conversation again when it ends.
- **Two things stop the chain.** The wake prompt (`params.wake` in
  `src/workflows/orchestrator.yaml`) gives the turn three choices:
  summarize (the default), continue that same job, or stay silent. It
  says "offering no next step" and "never widen the task on your own".
  And `WAKE_MAX` is 4: after four wake turns with no message from the
  person, strut stops waking and the host shows the job's raw reply.
- **Kinds.** A page under `Job` is a kind of work. The orchestrator sees
  each kind's name and description every turn and passes one as `kind` on
  job/start. The job opens that page at the head of every turn.
- **The orchestrator has no shell and no files.** Its tools are the job
  launchers and reads. It cannot read a diff or edit a plan file. A job
  can do both.
- **A job reads another job's files.** A job is told its own id, and
  job/get and job/read are among its tools. So an item's job can read the
  plan that another job keeps.
- **Job claims.** A job already states what its work must do and checks
  it before it reports (`plans/job-claims.md`). That covers "is this
  item's work done". It does not cover "do the items fit together".
- **No plan kind.** strut seeds none. The lab's `Plan Mode` page
  (stakgraph, `mcp/src/lab/job/concepts/Plan Mode.md`) assumes the
  opposite of the ask: an HTML page for the person to read, questions with
  no defaults, and after "go" the same job builds everything in one
  thread.
- **`plans/multi-repo-features.md`** asked for the same thing in the
  multi-repo case: each agent starts from the last one's actual result,
  and reports what it did differently from the plan. It was never built.
  This plan does it with jobs.

## Proposal

No new step, schema or store. One new page, a change to two prompts, and
one number.

### 1. The `Plan` page

`src/concepts/Plan.md`, a child of `Job`. Its description is what routes a
request to it: work too large for one job to do in one go, or work the
person asks to see planned first.

A plan job keeps ONE file in its directory, `plan.md`. It builds nothing
itself. The file holds:

- **Overview.** What will exist when the plan is done, in a few lines.
- **Work items.** A few, each large: a job's worth of work that one agent
  can finish and that can be checked on its own. Each says what it
  delivers, its kind, its repositories, and what it starts from.
- **Contracts.** The names and shapes that two items both depend on,
  written once, here.
- **Open questions**, each with a default. Once ruled they move to
  **Decided**, with who decided: the person, or the default.
- **Progress.** For each item: its job, its state, and what it did
  differently from the plan.

The plan job has four kinds of turn:

1. **Write the plan.** Its reply is the overview, written for the person.
   Its `ask` is the open questions, each with its default, and a line
   saying "go" takes them all.
2. **Take the rulings** ("go", or answers). It records them and replies
   with the first item to start.
3. **Review an item.** It is handed the job that just ended. It opens
   what that job made (job/get, job/read, the branch) and checks it
   against the contracts. It never reviews from the job's reply alone. It
   records what the item did differently and folds that into the items
   still to come. Then it replies with ONE of: the next item to start, a
   fix for the item just done, a question only the person can answer, or
   done.
4. **Finish.** It checks the whole thing as a job checks any work (its
   own claim), and replies with what was built, where it is, and what it
   decided on the person's behalf.

An item to start is a short brief: the plan's job id, the item, its kind,
repositories and title. The brief tells the item's job to read `plan.md`
first and to report what it did differently from it. The brief stays
short because the plan carries the detail (a wake passes at most 6,000
characters of a job's reply).

Mid-plan decisions: the plan job decides anything that can be undone and
is inside the plan, and records it under Decided. It asks the person only
for what cannot be undone or is outside the plan.

### 2. The orchestrator's part

The orchestrator shuttles and talks. It never reads `plan.md`.

- **Routing** needs no code: `Plan` appears in the kinds list.
- **The message.** The plan job's overview goes in `text` as it was
  written. Its questions go in `ask`, each with its default. The
  `Orchestrator` page says "one question" today. It gets a line: a plan's
  questions come together, each with a default.
- **"Go" or rulings** go to the plan job with job/continue. That is
  today's rule for answering a job's question.
- **The wake prompt gets a fourth choice, "carry on a plan"**:
  - The plan job's reply names the next item: start it as its own job,
    with the brief as given. Tell the person in one line what finished
    and what started.
  - A job started for a plan ends: hand its job id and outcome to the
    plan job with job/continue, and reply with the silent mark.
  - The plan job asks the person something: relay it and stop.
  - The plan job says done: give its summary.
  - "Never widen the task on your own" stays. The plan the person
    approved is the task.
- **`params.retain`** also keeps a plan under way: its job id and the
  item being worked on.

A conversation keeps the system prompt of its first turn, so the page's
new line reaches new conversations. The wake prompt is read fresh on
every wake, so carrying on works in conversations already open.

### 3. The cap

`WAKE_MAX` goes from 4 to 30. An item costs two wake turns (hand over,
then start the next), so a ten-item plan needs about twenty, plus fixes.
Past the cap nothing changes: the host shows the job's words, the person
says "go on", and the count starts over. `wakeMax` stays the host's to
set.

### 4. Code: one branch and one pull request per repository

Ruled. The plan names one branch per repository it touches. Every item
that touches that repository works on that branch and pushes to it. The
first item to push opens the pull request; later items add to it. A plan
across three repositories ends as three pull requests. The plan job's
last reply lists them.

The `Plan` page states the rule in one line. The mechanics belong to the
`Code Change` page (see "Outside this repo").

## Rulings (2026-11-21)

1. **Who reviews an item against the contracts.** The plan job, with the
   work in front of it. Not the orchestrator from the job's reply.
2. **When it stops to ask mid-plan.** Only for what cannot be undone or is
   outside the plan. Everything else it decides, records, and lists at the
   end.
3. **What the person hears while it runs.** One line per finished item,
   then the final summary.
4. **The cap.** Raised to 30. The mechanism is unchanged.
5. **How code items build on each other.** One branch and one pull
   request per repository, for the whole plan.
6. **The lab's `Plan Mode`.** Retired when the lab picks up `Plan`.

## Mine (made while writing, not ruled)

- The plan job hands out every brief, the first one too.
- One item at a time. Items on one branch would collide, and the plan job
  reviews one result at a time.
- The hand-over turn is silent. The person hears one line when the review
  passes and the next item starts.
- The next item travels in the plan job's reply text. There is no new
  field on a job's reply.
- A fix goes back to the item's own job (job/continue), not to a new job.

## Work items

One pull request.

1. `src/concepts/Plan.md`, with one claim and case in its front matter or
   on the `Orchestrator` page: asked for something large, the turn starts
   a plan, not the work.
2. `src/concepts/Orchestrator.md` (the line on a plan's questions) and
   `src/workflows/orchestrator.yaml` (`params.wake`'s fourth choice,
   `params.retain`).
3. `WAKE_MAX` 30, with its test and the places that state 4
   (`src/orchestrator-seed.ts`, `specs/CALLBACKS.md`).
4. `docs/jobs.md` for the page and the wake prompt.

## Validation

`npm test` cannot show this works: it is three prompts and a number. It
needs a run with a real model on a scratch strut: a three-item plan
across two repositories, "go" with no rulings, and nothing typed until
the end. What to read afterwards: did it reach the end, how many wake
turns it took, what the person was sent, whether a contract changed
mid-plan and reached the next item, and whether each repository has one
pull request.

## Outside this repo

- `Code Change` (the strut-code package, and the lab's own page) needs one
  line: when the brief names a branch, work on that branch, creating it if
  it is not there, and open a pull request only when none is open for it.
- The lab retires `Plan Mode` at the bump that brings `Plan`.

## Left out

- Items that run at the same time.
- A field for the questions that a host could draw as buttons.
- A spending limit for a plan run. The cap is a count of turns.
