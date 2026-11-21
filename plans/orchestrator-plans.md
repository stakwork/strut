# Plans: the orchestrator carries a plan to its end

Status: BUILT and run with a real model (2026-11-21, see "Validation").
Evan ruled the six questions as recommended, with code landing as one pull
request per repository. He then asked for the simple, generic version,
which is this one. The first, longer version is in this file's history.

Settled while building: the page's last paragraph says how an item is
handed out, which the agreed text left open. A plan's job cannot start a
job, and "hand out" alone could be read as running the item itself. So the
page says it names the next item in its reply, that the item is started
as a job of its own, and that the job is handed back when it ends. The
wake sentence also tells the turn to point the item's job at the plan.

Changed by the runs (three phrases, no new rule): the questions are the
plan job's `ask`; the line on what a question is got its three examples
back; and the wake sentence makes the plan's job the hub. Then two more,
ruled after the first runs: the branch rule is one sentence on the page,
and each line to the person names its item. "Validation" says what each
run showed.

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
>   delivers, its kind, where its work goes and what it starts from. Work
>   in a repository goes on one branch there for the whole plan, and ends
>   as one pull request.
> - **Contracts.** The names and shapes that two items both depend on,
>   written once, here.
> - **Open questions**, each with a default. A question is anything the
>   person knows and you cannot see (what is live, who uses it, what comes
>   next), and any choice that changes how much gets built. The default is
>   the simplest option that is safe; say what it leaves for later. Once
>   ruled they move to **Decided**, with who decided: the person, or the
>   default.
> - **Progress.** For each item: its job, its state, and what it did
>   differently from the plan.
>
> The person reads only your reply: a short overview, and the questions as
> your `ask`. "Go" takes every default.
>
> After go, name ONE item in your reply, the next to do, with its kind, and
> its repositories if it has any. It is started as a job of its own, and
> that job is handed back to you when it ends. Check what it made against
> the plan before you name the next. Decide what comes up the same way and
> tell the person at the end; stop only for what cannot be undone.

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
person approved is a request not yet met, and its job runs it: the
person's "go" and every item that ends, the last one too, go to the
plan's job, and what its
reply then names is the one thing the turn starts, as a job of its own
pointed at the plan. Each line to the person names an item by what it is,
never by its number alone ("Item 1, the server's tags, is finished").

Nothing else changes, because today's rules already cover the rest:

- **Routing.** `Plan` appears in the kinds list with its description.
- **The questions** reach the person: a wake turn asks what the job
  asked.
- **"Go"** reaches the plan's job with job/continue, as any answer to a
  job's question does.
- **One line a step.** "Continue" already says to say in one line that it
  did.
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
there, and the repository ends with one pull request. A plan across three
repositories ends as three pull requests.

The rule is on the `Plan` page, because the branch is shared across items
and the plan is what knows it. A plan need not be about code at all, or
may be about workflows and apps on a strut with no repository. So the page
says it in one sentence that applies only to work in a repository, and an
item names repositories only if it has any. How a branch is pushed and a
pull request opened stays the code kind's, or the deployment's.

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

After the runs with a real model:

9. **The branch rule is on the `Plan` page**, and stays generic: a plan
   need not be about code.
10. **Each line names the item** by what it is, not its number alone.
11. **The default on "is it live"** stays "assume it is live". The person
    sees the question and can say otherwise.
12. **The review reads the work; it need not run it.** The orchestrator is
    moving things along.
13. **An item's job need not open the plan.** Its brief carries what it
    needs and says where the plan is. A large plan is not every item's
    reading.

## Work items

One pull request.

1. `src/concepts/Plan.md`: the page, its claim and the two cases.
2. `src/workflows/orchestrator.yaml`: the sentence in `params.wake`.
3. `WAKE_MAX` 30, with its test and the places that state 4
   (`src/orchestrator-seed.ts`, `specs/CALLBACKS.md`).
4. `docs/jobs.md`.

## Validation

`npm test` cannot show this works: it is a page, a sentence and a number.
What did, on 2026-11-21: a scratch strut from this branch (LadybugDB
workspace, `claude-sonnet-5-5` for every agent) and one conversation,
played three times. The person asked for a plan across two small local
repositories (a counting server and its command line: tags on counters,
and a script that checks the two agree), then said only "go". Every claim
below was checked on disk, not taken from a job's report.

| Run | What changed before it | What happened |
| --- | --- | --- |
| 1 | The page and sentence as first built | Reached the end on "go": 3 items, 6 orchestrator turns, about $0.37. But the plan's job wrote its questions in its reply text, so to the orchestrator it had finished. On "go" the orchestrator started the items itself, two at once. The plan's job never ran again: nothing reviewed, Decided and Progress empty. |
| 2 | The questions are the plan job's `ask` | The questions arrived as a question, with their defaults. The orchestrator still started every item itself, one at a time, reading "start the item its job names next" as the plan's own list. The plan's job never ran again. |
| 3 | The wake sentence makes the plan's job the hub | As designed. "Go" went to the plan's job, which recorded the six defaults under Decided and named item 1. Each finished item went back to it; it read the code on the item's branch against Contracts, filled in Progress, and named the next. 10 orchestrator turns (8 wakes), 5 turns of the plan's job, 3 item jobs, about $0.52, 6 minutes. |

| 4 | One branch per repository, on the page | The plan named one branch per repository and each remote ended with exactly that branch, pushed. The plan's job put the command line's two items into one job. The first item went back to it and was checked; the last job did not, and the orchestrator closed out itself. Two plans with no repository (a welcome pack; a workflow and an app) say so in one line and have nothing about branches. |
| 5 | Each line names the item | Every line named its item ("Item 1, the server's tags, is finished"). Items 1 and 2 went back to the plan's job, which read the diff and ran the tests. The last item again did not go back. One `tags` branch per repository, pushed: cloned fresh, the server's 4 tests and the command line's 6 pass, and the check script agrees. |
| 6 | Real repositories on GitHub; "the last one too" in the sentence | Two private repositories, the jobs pushing and opening pull requests through the machine's own git and gh login (`STRUT_GIT_LOCAL=1`). It ended with one `counter-tags` branch and ONE open pull request in each repository: the server's with one commit, the command line's with two (its item and the check script). Every item went back to the plan's job, the last one too, and the plan file was closed. Cloned from GitHub, the server's 4 tests and the command line's 4 pass and the check script passes. 10 orchestrator turns, 7 minutes. |

In run 3 the built work holds: the server's 5 tests and the command
line's 6 pass, and the agreement script passes against the real server.

**The page's two cases**, run as plan jobs and read by hand (no judge):

- *Something merged yesterday.* Before the three examples went back into
  the line on questions, 1 plan of 1 never asked whether the change was
  live: it planned a migration with a tested down path, a compatibility
  shim and a cleanup "after the migration has run in production". After,
  3 plans of 3 ask whether it is deployed with real data.
- *Sharing a private note.* 4 plans of 4 ask how far access goes and
  default to the small answer (read-only, existing accounts only), with
  invites and public links left for later.

**What the runs leave open:**

- **The last item, once.** In runs 4 and 5 the orchestrator closed the
  plan itself after the last job, so that job was not checked and the plan
  file was left open. "The last one too" went into the sentence, and run 6
  handed every item back. That is one run.
- **Where the plan file lives** (asked 2026-11-21, not ruled). `plan.md`
  in the plan job's folder is not in the pull request, and an item's job
  cannot see it. For work in a repository it could be
  `plans/<feature>.md` on the plan's branch, as this repo's own plans are.
- **The test repositories are still on GitHub**, each with its open pull
  request: `Evanfeenstra/plan-run-tally-server` and
  `Evanfeenstra/plan-run-tally-cli`, private, to delete when done.
- **A wake count.** Three items took 7 or 8 wake turns: two an item, one
  for the plan and at most one to close. The cap of 30 covers about
  fourteen items.
- **Not run:** a trial with the judge (`knowledge/trial`), any model but
  the one above, and a plan large enough to need compaction.

## Outside this repo

- `Code Change` (the strut-code package, and the lab's own page) says
  "always a new branch and a pull request" for a job. It needs one line so
  an item of a plan works on the branch its brief names, and opens a pull
  request only when none is open for it.
- The lab retires `Plan Mode` at the bump that brings `Plan`.

## Left out

- Items that run at the same time.
- A field for the questions that a host could draw as buttons.
- A spending limit for a plan run. The cap is a count of turns.
