# Experiments: a goal and a budget, and Jamie does the rest

> **Status (2026-11-27): a plan, one part built.** Strut tests a change
> to one page today, from an admin's Knowledge app. A budget on a job is
> built, and Jamie's reply carries one to the job it starts
> (stakwork/strut#872). A change that spans pages, the form that starts
> one, and Jamie doing it all are not built. "First" says what is next.
>
> **The goal (owner, 2026-11-23):** *"an Experiments tab in the Knowledge
> app that generates a bunch of cases for you and runs them all the way
> through."* The first use: *"jamie picks a bunch of repos to use (some
> yours, some common, mix of languages) and does them all and optimizes
> the Pods and Pod Setup concepts based on real trials, then tries again
> - not just changing one thing at a time, but being intelligent enough
> to make a bunch of changes and guiding real evolution"*, toward *"the
> MOST USABLE output - the thing that feels the most real to the human
> (no dead links.. stub and mock if needed!!!! which could include mock
> data prs directly if needed!)"*.
>
> **Generic (owner, the same day):** *"a generic simple solution that
> will work for any hillclimbing on concepts later (legal benchmarks,
> coding benchmarks, anything)"*. *"ideas like 'pods' or 'jamie picking
> repositories' should JUST BE IN A PROMPT! Thats what i mean by GENERIC
> - no specific logic about how or why an experiemnt runs."* *"Why does
> it matter whether a human or jamie did it? Cant it be the same UI?"*
>
> **You just set a budget (owner, the same day):** *"The point was for
> jamie to do all this automatically so we can just go ahead and it
> makes up all the cases."* The money is not a prompt's to keep: *"why
> is money cap in the prompt?"* The owner's example:
>
> > evan: "Do this experiment of setting up solana dev tools and a full
> > stack app on top".
> > jamie: "whats your budget?"
> > evan: 100 USD
> > jamie: ok - keeps spinning up and optimizing until it either plateao
> > in a good spot, or runs out of money! optimizations need to be
> > GENERIC!!! legal tasks. web design. makeing a video. setting up
> > pods. writing concepts for recurssive learning. etc etc
>
> And then: *"budget means model calls only"*. *"jamie doesnt need to
> state anything extra. minimal is best"*. *"Just like the pod setup is
> triggered from the Code app - could we trigger this from the Knowledge
> app (and it would tie back to the knowledge app of course too, in the
> trials UI right?)"* *"what about Experiment being the Job kind, and
> then it has its own children?"*
>
> **Work done, then a new prompt (owner, 2026-11-25),** on proving that
> an agent knows what a person means: *"By running examples of work
> being done, and then a brand new prompt that should understand
> immediately what the user is talking about"*.
>
> **Jamie offers one (owner, 2026-11-27, asked and not ruled):** *"Can
> it be triggered from Jamie himself (as a job kind, so Jamie could
> seamlessly say like 'do you want me to run an experiment on
> this?')"*
>
> Only the quoted words are the owner's. The rest is proposed. Read
> against strut `main` @07101d4b and stakwork/pods `main` @95d6c37, and
> strut checked again @20fca3ee and, the whole plan, @9369a905.
> Earlier drafts had kinds of case, rounds, a rule for keeping a change,
> and the budget in the prompt. This file's history has them.

## The design

An **experiment** is a goal and a budget. A person gives both. Jamie
does the rest: makes up the cases, runs them, changes the pages, runs
them again, and stops when it stops improving or the money is spent.

Strut knows two things about one:

- **Its budget.** A cap on its model calls, kept in code at the gateway,
  where the money is spent. A prompt can ask Jamie to be careful. It
  can't stop a run.
- **Its tests.** What was tried. A test is one change to the pages, run
  on some cases, with what the claims said with it and without it.

The parts of a test are strut's already:

| | |
| --- | --- |
| A **case** | Something to run: an input to a workflow |
| A **claim** | A sentence the result must make true, with a check that judges it |
| A **change** | A diff of the pages: any number edited, added or removed |

Strut knows nothing more:

- **No round, score or rule for keeping, in code.** A climb is tests in
  a row, each starting from the best so far. Jamie picks the next.
- **Everything else is a prompt:** what the cases are, how many, what
  good means, what to change, how many things at once, when it has
  stopped improving.
- **It names no kind of work.** A case is whatever a workflow can run,
  and a check is any step. Pods, a legal task and a video differ only in
  what the prompt says.

**A prompt is** a person's message, and pages. The message can name
cases, or a kind of case: "try hive, strut and two Django apps", "only
Rust repositories". Cases it names are used as given, a kind it names
bounds the ones made up, and the pages fill in the rest. The subject's
own pages say what the work is (`Pod Setup`). One page, `Experiment`,
says how to experiment well: use the cases the person names and make up
the rest to cover the goal, read every failure before changing
anything, make every change the reading supports, keep some cases back,
never reword a claim to pass it, stop when it stops improving. It is a
page, so it has claims of its own and can be experimented on.

**`Experiment` is a kind of job, and its children are kinds of
experiment** (owner). Strut's `Job` page already says each child is a
kind, and "A kind's own children refine it", as `Pod Setup` refines
`Pod`. A page under `Experiment` says what one sort of experiment needs:
for pods, to pick repositories, some the person's and some common, in a
mix of languages, where the person names none. So that prompt has a
home, and nobody types it twice.

**A person can do any of it by hand,** through the same steps, and it
is the same record drawn the same way. The record says who made each
case, claim and change.

## The box is the lab

An experiment runs on the server it is asked on. Its cases are runs of
workflows there, and a change is tried on a copy of the pages (a Concept
branch). It needs no repository and no pod.

Most experiments are this kind (owner, 2026-11-25): *"The core purpose
of strut apps is to make generative-AI-powered apps (text, image, etc),
so people will want jamie to know how to make experiments for them too!
A nice automatic testing paradigm for prompts sort of?"*

```text
person:  make the summaries shorter but keep every action item
jamie:   what's your budget?
person:  $5
jamie:   9 of 10 with the new wording, 6 of 10 before.      [Use it]
```

A pod comes in only when what is being changed is code in a repository:
strut's own (`plans/tools-as-pages.md`), or an app that lives in one.
Then the lab is a second server, run from the branch. The pods example
below is neither: its cases set pods up, so a pod is what it tests, not
where it runs.

### An app's own prompts

What an app's model is told goes on a page, as everywhere in strut
(AGENTS.md, "Core ideas"). The app's workflow reads the page
(`context/concept`), and its YAML holds no instructions. Then a claim on
the page, cases that are inputs to the app's workflow, a test of a new
wording and Use it all work on it as built: by an admin in the Knowledge
app today, and by Jamie once the test steps are his ("What strut
needs").

- **The `App` page says so,** where it tells how an app's workflows are
  written, so an app Jamie builds can be tested from its first version.
  `Workflow Language` is rendered from the builder's rules, which stay as
  they are.
- **It costs a card.** A job adds a page with `knowledge/add-page`,
  which asks the person first. Proposed: one card at an app's first
  build, for a page named for the app; a second prompt is a page under
  it. Later an app could ship its pages in its own directory, as a
  package does.
- **What is kept in `params` instead** (a model's name, a temperature, a
  tool list) is tried with a case that carries `params` ("What strut
  needs").

## Starting one

From the Knowledge app, as Set up is from the Code app:

```text
Experiments

  What should get better?   [                                      ]
  Budget                    [ $     ]                       [Start]

  Solana dev tools and a full stack app    running             $64 of $100
  A lease review a lawyer would sign       stopped improving   $31 of $50
  Pod setup feels real                     out of budget       $100 of $100
```

- **The box is the person's message,** several lines: the goal, and
  anything they want tried. Jamie reads it as he would the same words
  in a chat.
- **Start** opens a Jamie chat with the experiment already running,
  through the seam Set up uses (`conversation/start`): no model turn
  decides it, and there is no second click. The seam takes no budget
  yet ("What strut needs").
- **It starts a job of kind `Experiment`.** Jamie opens the page under
  it that fits, as any job does with its kind.
- **From a page,** the same form starts one about that page. From a
  page under `Experiment`, it starts one of that kind.
- **In a Jamie chat,** a person just asks, and Jamie asks for the
  budget, as in the owner's example. His reply carries the kind and the
  budget to the job it starts (`start.kind`, `start.budgetUsd`; built).
  What tells him to ask is the `Experiment` page, with no code: its one
  line is what he sees of a kind in his list, and he opens a kind's page
  for what a person decides before the work starts.
- **Jamie can offer one** (owner, asked): "do you want me to run an
  experiment on this?" The same page says when (open question 9).
- **A plain change is still a card.** Asked to change what a page says,
  Jamie proposes the edit and the person accepts it
  (`knowledge/edit-page`, built). Nothing is tried and nothing is spent.
  An experiment is the other way to the same change: it is tried on
  cases first.
- **Nothing is spent before the budget is set.** The steps that run a
  test answer only a job that has one.
- **Jamie says nothing extra** before he goes (owner).
- **It ends one of two ways.** It stops improving, which is Jamie's
  call. Or the budget is spent, which is strut's: it starts nothing
  more, the gateway refuses what is in flight ("The budget"), and the
  chat is told in a fixed line with no model turn. Either way the best
  so far is there to use.

The list is every job whose kind is `Experiment` or a page under it:
its goal, what it has spent of its budget, and whether it is running. A
row opens its chat and the pages it is about.

## Where it shows

In the trials UI the Knowledge app has, on each page's card. Nothing
new is drawn for an experiment. Its trials show as each is judged, and
stay after it ends.

- **Every run Jamie makes is a trial.** Its verdict is a dot on the
  page's check, beside its case, with what the run took and cost. A dot
  opens its sample, as today: the message, the reply and the judge's
  line. Once a sample's files are kept ("What strut needs"), it also
  opens what the run left: a recording, a page it wrote.
- **Every change he tries is a test.** The diff, a row of dots with it
  and a row without, each side's time and cost, and which did better. A
  change that spans pages shows on each page it touches.
- **Use it** is the button a test has today. A person presses it. The
  pages don't change while an experiment runs.
- **A page lists its experiments,** and each opens its chat. The chat is
  about the page (`conversation/start`'s `about`), as a workspace's chat
  is in Code.

## What strut needs

| What | Today |
| --- | --- |
| **A test of a change that spans pages,** either side able to start from an earlier test's change ("A test of several pages") | `test` takes one page's new wording against the page as it is |
| **A case with a history:** launches that run first, in order, before the one that is judged, and a judge that reads all of it ("A case with a history") | A case is one launch: a workflow and its input. "A case of more than one message" is not built (docs/knowledge.md) |
| **The test steps as Jamie's tools:** `knowledge/checks`, `add-check`, `cases`, `trial`, `test` and `sample`, for a job with a budget, which is told when a test's last sample is judged | They answer only strut's own page shown to an admin: "a trial spends, and a page's words are an agent's rules" (open question 1). A trial's end wakes nothing |
| **The form and the list** in the Knowledge app, and a page's experiments on its card | A page's card has its checks and tests |
| **The form's budget reaches the job:** `conversation/start`'s `job` takes `budgetUsd`, from a page's call only, where the viewer typed it | Its `job` is a title, a brief, a kind and repositories (`PreparedJob` in `src/core.ts`). Only Jamie's own reply starts a job with a budget |
| **A sample's files kept with its verdict:** what its run left, for whoever opens the dot | A sample that ran as a job loses them. Strut closes the job once it is judged, and that deletes its directory |
| **As many cases as a benchmark has,** and samples of each: for a job with a budget, the budget is the limit | At most 20 cases on a claim, and 20 samples of each (`CASES_MAX`, `TRIAL_N_MAX` in `src/trials.ts`) |
| **The `Experiment` page,** under `Job`, and the list reading the kinds under it | Not there. A kind under a kind works already |
| **A case carries `params`:** a model's name, a tool list, a prompt that is not on a page. Narrower only, where they grant tools (`plans/tools-as-pages.md`) | A case is a workflow and its input. A launch already takes `params`, and refuses ones that widen a grant (`grantWidenedBy`, `src/closure.ts`) |
| **A build leaves nothing behind:** what a trial's job published (workflows, steps, apps) goes when the job closes, and two samples of one case never run at once | Closing a job removes its directory, its record and what it held. What it published stays, and the next sample builds on it |
| **A real run as a case:** a run a person's app already made, kept as a case with its input | A case is typed in. `knowledge/sample` opens a trial's run and no other |
| **A judge that hears and watches,** for an app that makes sound or video | The standard judge reads text and is shown images (`context/work-file`) |

That is all. No new kind of node, no workflow of its own, and nothing in
stadeum: the Knowledge app is strut's, framed as any app is (rule 1).

Already built, and used as it is:

- claims on a page, cases, trials, and a test of one page's wording;
- a case that runs as a job of its own, closed once it is judged;
- each run's time and cost beside its verdicts;
- a check that is any step, so it can look at the world;
- Concept branches, which a test's changed side runs on;
- a package's pages carrying their claims and checks;
- a cap on one run, kept at the gateway;
- a budget on a job and everything it starts, and Jamie's reply
  carrying one to the job ("The budget");
- `conversation/start`, and the chat about a node.

### First

Three rows give a person an experiment in a Jamie chat, on one page's
wording:

1. the `Experiment` page;
2. the test steps as the tools of a job with a budget;
3. that job told when a test's last sample is judged.

The budget is built, and so is the reply that carries it. The form is
then one call to `conversation/start`, once that takes a budget. A test
of several pages is next: the owner's first use changes `Pod` and
`Pod Setup` together. Each other row waits for the use that needs it.

### The budget

Built (stakwork/strut#872; docs/jobs.md, "A budget on a job"). It is any
job's to have, not only an experiment's.

- **A person sets it.** `job/start { budgetUsd }`, which Jamie's reply
  carries with only the amount the person gave, or
  `PUT /jobs/:id/budget`. Nothing a job's own agent holds can raise it.
- **What spends it:** the job's runs, their children, their checks, and
  the samples of a trial one of its runs asked for (`ctx.budgetJob`).
- **Strut adds up** what those runs cost, from the cost each run's
  summary has (`totals.cost`), and starts nothing more once the budget
  is spent. The sum is the "$64 of $100" in the list.
- **The gateway is the hard stop** on what is in flight. The job holds a
  link of its own between the person's delegation and each run's link,
  capped at the budget (`src/mothership.ts`).
- **A turn that ended for want of budget** wakes no model turn. The chat
  is told in a fixed line.

Not yet:

- **A job that a budgeted job starts** with `job/start` is not held to
  the budget. No job's agent holds `job/start` today, and a trial's
  samples are held already.
- **A pod's own model calls,** through a key strut granted it, are
  capped by the gateway and are not in strut's sum.
- **A box with no gateway** (no Mothership: a model key of its own,
  local development) has only strut's sum. It starts nothing past the
  budget, and a run in flight finishes, so a climb there can go over by
  what was in flight.

### A test of several pages

`knowledge/test` takes `changes`, each a page by name and its whole new
text: `null` takes the page out, and a name that is not there adds it,
under `parent`. `from`, a test's id, starts both sides from that test's
changed side, so a climb builds on its best so far. A Concept branch is
a copy of the whole tree, a package's pages included (`src/branches.ts`),
so the changed side runs as it does today.

Use it puts one page's wording on today (`knowledge/use`). With
`changes` it lands every page of the test or none: where one of them
cannot be written, it is refused, saying which (open question 4).

### A case with a history

A case gains `before`: launches that run first, in order, each a
workflow and its input. The case's own launch then runs, and it alone is
judged. So a case can say: this work was done, then this was asked.

```yaml
claims:
  - text: A new conversation knows which earlier work a message means, without asking.
    workflow: orchestrator
    cases:
      - before:
          - { workflow: job, input: { prompt: "Write a one-page brief on the spring price change, as brief.md." } }
        prompt: Make the pricing brief shorter.
```

In a page's file a case is the workflow's input, so `before` is a key
beside it. An entry is a case, `{ workflow, input }`, or the input alone
when it runs the claim's workflow.

- **One sample is one history.** Every launch of it is the sample's
  trial and runs on its branch. A page the history writes is there for
  the launch that is judged, and goes with the branch.
- **The judged launch starts new.** The history's turns are one
  conversation, and each of its jobs is a job of its own, as a job's case
  is today. The judged launch is a new conversation. It knows of the
  history only what the box kept: its pages, and what its lists show
  (`plans/recent-work.md`).
- **What a launch would start is held,** as in any trial. A history
  names each job as an entry (open question 7), and the judged turn's
  answer carries the brief it would have sent (`held`). The judge reads
  that brief: whether it names the right thing is the test.
- **The judge reads the history, and the run never does.** The work a
  judge is handed (`src/work.ts`) holds the history's runs before the
  judged one, marked as the history. So one claim covers every case, and
  no case needs its answer written down.
- **A sample's work is its own.** The jobs and conversations a history
  makes are listed to that sample's runs alone, a list kept for a person
  (Recent Work keeps each for five minutes) is read new inside a sample,
  and all of it is closed once the sample is judged. Today a trial's job
  is in every list until it closes, so two samples of one case would
  each see the other's history (open question 8).
- **A sample's time and cost are the judged launch's,** so a change that
  understands sooner shows as a number. The history's cost is spent from
  the budget like any run's.
- **A case's id covers its history** (`testCaseId`), so one question
  asked after two histories is two cases.

The first cases are the two failures `plans/recent-work.md` item 6
names, checked by hand so far and for apps only: "experiments.md … in
the stadium repo", and a screenshot of the trials UI asked by a person
who never opened the Knowledge app. Any plan whose last step is "replay
this on a scratch strut, then look" can keep that step as a case
(stakwork/strut#894 item 5).

A dream can be an entry too, once `dream/turns` reads a sample's turns
alone inside one. Today it reads every conversation on the box.

Where: `src/claims-schemas.ts` (the case, and a page's `claims:` block),
`src/graph/claims.ts` (`testCaseId`), `src/trials.ts` (`sampleRun`, and
the sample on `RunTrial`), `src/work.ts` (the history in a work), the
job and conversation lists, and the case form in the Knowledge app.

## Everything else is a prompt

The owner's list. Each could be a page under `Experiment`. Only the
first has been looked at closely. The rest show the shape, and what
Jamie would make up.

| The goal | A case | A check |
| --- | --- | --- |
| **Setting up pods** | A set of repositories to set up | The pods service, and a browser on the pod |
| **A legal task** | A matter and its documents | A model reading the draft against the claim |
| **Web design** | A brief for a page | A model looking at the page in a browser |
| **Making a video** | A brief | A model watching the result |
| **Writing concepts** | Conversations to learn from | A model reading the pages that were written |
| **A benchmark** | One of its tasks | Its grader |
| **Knowing what a person means** | Work done, then a new message that names it loosely ("A case with a history") | A model reading what the turn would start against the history |

The answer to a case is a claim's sentence, or something its check
knows. The run sees neither: it is handed the page, never its claims.

### What the pods example needs

None of it is strut's. It is the pods package's pages and steps.

- **A page under `Experiment`,** say `Pod Setup Experiment`: pick about
  ten sets of repositories, some the person's and some common, in a mix
  of languages, unless the person named them, set each up, and improve
  `Pod` and `Pod Setup` toward what feels most real to a person.
- **"Most usable" as claims** on `Pod Setup`. Four are there: it bakes,
  a person gets in, it asked for no secret, and the workspace's page is
  written. Three more:
  - **No dead ends.** Every link and button the test user can reach
    leads to a page that works.
  - **It has something in it.** Lists have rows, and a record opens.
  - **Everything outside is stood in for,** by a stub or a mock in the
    pod.
- **A check that follows every link,** for "No dead ends": a step, as
  `stadeum/pods/baked` is one.
- **Mock data in the repository itself.** The owner: stubbing *"could
  include mock data prs directly if needed"*. Read here as pull requests
  that add seed data or stubs to a repository, opened by the setup
  without asking (open question 3). `Pod Setup` would say so. In a
  trial, pods already holds the push and shows the judge what it would
  have sent.
- **`claim` asks strut for a model key,** for an app that calls a model.
  Strut's grant is built. `claim` doesn't ask yet.
- **A trial leaves nothing behind.** Built: a workspace of the sample's
  own, its images deleted with it, its page a file of the job.

The two real setups of hive cost $0.31 and $0.66 in model calls, so $100
is 150 to 300 setups, before the judges' own calls. A pod's time is the
pods service's bill, and is not in the budget.

Time is the other limit. Trials run four samples at a time on a box
(`CONCURRENCY` in `src/trials.ts`). A test of ten sets of repositories,
four samples of each on both sides, is 80 setups in 20 waves: hours, at
10 to 20 minutes a setup. And since a pod's time is not in the budget,
nothing caps how long a climb runs (open question 6).

## Later

Each is the same steps, used by something else:

- **The dream writes cases.** When a person corrects the model, the
  dream writes the lesson on a page and the fact as a claim. With the
  question as a case, the fact can't quietly fall out of the pages.
- **Finished jobs as a dream source,** beside conversations: what a
  setup that baked found to work, how a plan's questions were ruled.
- **A claim judged only on its own cases.** A page of 30 facts costs 30
  judge calls after each edit today, because the Knowledge app sets no
  policy on a claim.

## Open questions

1. **Jamie holding the test steps.** Strut keeps them to an admin's own
   page because a trial spends and a page's words are an agent's rules.
   Proposed: a budget is the person's yes to the spending, so a job with
   one holds them. All but `knowledge/use`, which stays a person's: a
   button, or a card the person accepts (question 2).
2. **Who uses the result, and where.** A person, with Use it (proposed).
   Or Jamie, when it stops *"in a good spot"*? And the `[Use it]` the
   chat shows in "The box is the lab" is not there today: Use it is a
   button in the Knowledge app. Proposed: a card in the chat, as a page
   edit is. The job calls `knowledge/use` and the person accepts it
   (`approve:` in `job.yaml`), so the page's words stay a person's. Or
   Jamie's reply links the test in the Knowledge app.
3. **"Mock data prs."** Pull requests that add seed data or stubs to a
   repository, as read above? Or made-up pull requests as data, for an
   app that shows them?
4. **A package's pages.** Strut never changes a package's page in the
   graph. Use it writes into a checkout of the package where the box has
   one, and is refused where it doesn't. The pods package's source is
   `package/` in stakwork/pods, and boxes follow a published copy. So
   where does a climb on `Pod Setup` land? The owner's first use waits
   on this: on a box, a climb on `Pod` and `Pod Setup` finds a better
   wording and has nowhere to put it.
5. **What a question runs on.** A case that only asks something needs a
   workflow that answers in one run. The orchestrator sends what it must
   find out to a job, and a trial holds jobs.
6. **How long a climb runs.** Four samples at a time make a pods test
   take hours, and pod time is uncapped. Proposed: `Pod Setup Experiment`
   asks for one sample of each case at first, and four at a time stays
   until a climb shows it is the wall.
7. **A history's jobs.** A trial holds what a turn would start, so a
   history's turn starts nothing. Proposed: a history names each job as
   an entry of its own. Or do a history's turns start their jobs inside
   the sample, with the wake turns that follow?
8. **Whose work a sample sees.** A sample runs as whoever started the
   trial, so that person's real work is in its lists beside the
   history's. Proposed: as it is, with made-up names in the cases, and a
   sample's own jobs and conversations hidden from everything else. A
   person of the sample's own, and a history by two people, need a run
   seen as one person that spends as another.
9. **When Jamie offers one.** The owner asked that he can. Nothing says
   when, and the chat in "The box is the lab" answers a plain request to
   change a wording with "what's your budget?". Read as a rule, that
   makes every change an experiment. Proposed, as a line on the
   `Experiment` page: he offers when the page has cases to judge a
   change by, or when the person says a change did not work. Otherwise
   the change is a card ("Starting one"). He never starts one unasked:
   the budget is the person's yes.
