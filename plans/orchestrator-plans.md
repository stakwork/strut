# Plans: the orchestrator carries a plan to its end

Status: RULED, not built (2026-11-21). Evan ruled the six questions as
recommended, with code landing as one pull request per repository. He then
asked for the simple, generic version, which is this one. The first,
longer version is in this file's history.

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

Two things go wrong most often when agents work this way:

- **Access control goes too deep.** Layers and kinds of token pile up
  before the roles and integrations are known. There are usually more of
  both than expected.
- **Backward compatibility nobody needs.** A migration gets built for
  something merged yesterday, with no deployment and no data. The person
  knows that. The agent does not.

One constraint on the fix: it stays SIMPLE AND GENERIC. Many rules and
nudges make a model worse, and each model has its own best way of
working. The whole guidance is a plan with work items, and open questions
with defaults.

## What strut already has

- **The wake chains.** When a job ends, strut runs one more orchestrator
  turn with the job's reply (`src/wake.ts`). A job that turn starts wakes
  the conversation again when it ends.
- **Two things stop the chain.** The wake prompt (`params.wake` in
  `src/workflows/orchestrator.yaml`) gives the turn three choices:
  summarize (the default), continue that same job, or stay silent. And
  `WAKE_MAX` is 4: after four wake turns with no message from the person,
  strut stops waking and the host shows the job's raw reply.
- **Kinds.** A page under `Job` is a kind of work. The orchestrator sees
  each kind's name and description every turn and passes one as `kind` on
  job/start. The job opens that page at the head of every turn.
- **The orchestrator has no shell and no files.** It cannot read a diff
  or edit a plan file. A job can do both.
- **A job reads another job's files** (job/get, job/read), and is told
  its own id. So an item's job can read the plan that another job keeps.
- **Job claims.** A job states what its work must do and checks it before
  it reports (`plans/job-claims.md`). That covers "is this item's work
  done". It does not cover "do the items fit together".
- **Claims with cases.** A page's front matter can carry a claim and the
  cases that test it, run as trials (`plans/claim-trials.md`).
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

One new page, one sentence in a prompt, and one number. No new step,
schema or store.

### 1. The `Plan` page

`src/concepts/Plan.md`, a child of `Job`. This is the whole page:

> Work too large for one job, or that the person wants planned first.
>
> Keep ONE file in your directory, `plan.md`, and build nothing yourself.
> It holds:
>
> - **Overview.** What will exist when the plan is done, in a few lines.
> - **Work items.** A few, each large: a job's worth of work that one
>   agent can finish and that can be checked on its own. Each says what it
>   delivers, its kind, its repositories, and what it starts from.
> - **Contracts.** The names and shapes that two items both depend on,
>   written once, here.
> - **Open questions**, each with a default. A question is anything the
>   person knows and you cannot see, and any choice that changes how much
>   gets built. The default is the simplest option that is safe; say what
>   it leaves for later. Once ruled they move to **Decided**, with who
>   decided: the person, or the default.
> - **Progress.** For each item: its job, its state, and what it did
>   differently from the plan.
>
> The person reads only your reply: a short overview and the questions.
> "Go" takes every default.
>
> After go, hand out one item at a time and check what comes back against
> the plan. Decide what comes up the same way and tell the person at the
> end; stop only for what cannot be undone.

The page names what the file holds, because several agents read and write
it: the plan's job over many turns, each item's job, and the review. It
leaves the rest to the model: how the file is laid out, how an item is
handed out, how a review is done.

The two failures in "The ask" are one failure: the agent decided what was
the person's to decide. One is a fact only the person knows (is it live).
The other is how much to build (how deep access control goes). The line
under "Open questions" covers both, so the page has no rule about access
control and none about migrations.

They are TEST CASES instead. The page carries one claim, "what it could
not know, it asked, with a default", with two cases: a request that
touches who can read what, and a change to something just merged. Trials
run them. When a model fails one, the sentence is what changes. No rule is
added.

### 2. The orchestrator

One sentence is added to the wake prompt's "continue" choice. A plan the
person approved is a request not yet met: the turn starts the item the
plan's job names next, as a job of its own, and when that job ends it
hands it back to the plan's job.

Nothing else changes, because today's rules already cover the rest:

- **Routing.** `Plan` appears in the kinds list with its description.
- **The questions** reach the person: a wake turn asks what the job
  asked.
- **"Go"** reaches the plan's job with job/continue, as any answer to a
  job's question does.
- **One line per finished item.** "Continue" already says to say in one
  line that it did.
- **"Never widen the task on your own"** stays. The plan the person
  approved is the task.

The wake prompt is read fresh on every wake, so this works in
conversations already open.

### 3. The cap

`WAKE_MAX` goes from 4 to 30. An item costs two wake turns (hand back,
then start the next), so a ten-item plan needs about twenty, plus fixes.
Past the cap nothing changes: the host shows the job's words, the person
says "go on", and the count starts over. `wakeMax` stays the host's to
set.

### 4. Code: one branch and one pull request per repository

Every item that touches a repository works on the plan's one branch
there. The first item to push opens the pull request and later items add
to it. A plan across three repositories ends as three pull requests.

This is not on the `Plan` page, which knows nothing of code. It is the
`Code Change` page's (see "Outside this repo").

## Rulings (2026-11-21)

1. **Who reviews an item against the contracts.** The plan's job, with
   the work in front of it. Not the orchestrator from the job's reply.
2. **When it stops to ask mid-plan.** Only for what cannot be undone.
   Everything else it decides, records, and tells the person at the end.
3. **What the person hears while it runs.** One line per finished item,
   then the final summary.
4. **The cap.** Raised to 30. The mechanism is unchanged.
5. **How code items build on each other.** One branch and one pull
   request per repository, for the whole plan.
6. **The lab's `Plan Mode`.** Retired when the lab picks up `Plan`.
7. **Simple and generic.** The page above is the whole of the guidance.
   No rule per failure: a failure becomes a case.
8. **The plan file's parts** stay on the page.

## Work items

One pull request.

1. `src/concepts/Plan.md`: the page, its claim and the two cases.
2. `src/workflows/orchestrator.yaml`: the sentence in `params.wake`.
3. `WAKE_MAX` 30, with its test and the places that state 4
   (`src/orchestrator-seed.ts`, `specs/CALLBACKS.md`).
4. `docs/jobs.md`.

## Validation

`npm test` cannot show this works: it is a page, a sentence and a number.
Two things can.

- **Trials** of the page's claim, on the models in use. Not tried yet: a
  trial of `job` with `kind: Plan`.
- **One run with a real model** on a scratch strut: a three-item plan
  across two repositories, "go" with no rulings, and nothing typed until
  the end. What to read afterwards: did it reach the end, how many wake
  turns it took, what the person was sent, whether the questions arrived
  with their defaults, whether a contract that changed mid-plan reached
  the next item, and whether each repository has one pull request.

## Outside this repo

- `Code Change` (the strut-code package, and the lab's own page) needs one
  line: as an item of a plan, work on the plan's branch for that
  repository, creating it if it is not there, and open a pull request only
  when none is open for it.
- The lab retires `Plan Mode` at the bump that brings `Plan`.

## Left out

- Items that run at the same time.
- A field for the questions that a host could draw as buttons.
- A spending limit for a plan run. The cap is a count of turns.
