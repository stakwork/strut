# Tools as pages: a job reads about a tool on a page and runs it by name

Status (2026-11-25): a plan, nothing built. It moves most of the job
agent's tools out of its tool list, and proves with trials that building
an app is no worse for it. The change is small. Most of this plan is the
proof, and what the proof needs first.

Companions: `plans/one-job-agent.md` (how the list got this long, and
what it was measured to cost) and `plans/experiments.md` (the trials
this is proved with).

## The ask

The owner, 2026-11-25, on seeing that the canvas package gives the job no
tool, only a page and a workflow to run:

> why isnt ALL of the builder tools (making apps, making workflows,
> making steps, verifiying, claims, etc etc etc) the same??? why isnt
> that a "workflow" too, so the job doesnt actually start with those in
> its tool list: it "learns" the tools as then come along?

And then:

> write a plan to move tools to pages - importantly, i want an
> "experiment" about it proving that the change is effective. This whole
> thing needs to be possible to build in jamie itself on a pod, with a pr
> to strut at the end with trials proving that the switch to
> tools-as-pages doesn't lose quality when building a sophisticated strut
> app

Only the quoted words are the owner's. The rest is proposed. Read
against strut `main` @09ebb825, stakwork/strut-canvas `main` @9baed96 and
stakwork/pods `main` @4220fb3.

## What is there today

| | Today |
| --- | --- |
| The job's list | 80 steps and 6 built-ins (`src/workflows/job.yaml`, `params.tools`, counted from the registry). `meta/*` is 35 of them and `app/*` 15 |
| Packages | A package's `job: tools:` adds to every job's list: stadeum/code 4, stadeum/pods 7. The canvas adds none |
| What it costs | A job's first turn wrote 42,127 tokens before any call, mostly tool definitions, when the list was 48 (`plans/one-job-agent.md`, 2026-11-24). About $0.20 once, then cents a turn |
| What it was found to hurt | Nothing measured: no wrong pick among the overlapping tools in 52 asks (the same plan). The list grows with every package, and most jobs build nothing |
| Running a step by name | Built, and in the job's list: `meta/search-steps` finds a step by words, `meta/get-step` gives its description, an example and its config's schema, `meta/run-step` runs it. The step runs as the caller's own tool call would: under its run, as its person, on its job, its budget, its branch and its trial |
| What `meta/run-step` refuses | A sealed step, and a step the agent asks a person before running (`approve`): "Call it as your tool" |
| A page that names tools | `Workflow Language` lists each authoring tool with its arguments (`meta/publish-workflow(name, yaml, description?, category?)`). It is rendered from `src/ai/prompts.ts` for the job (`PAGE_TOOLS`), apart from the builder's own prompt |
| A launch's `params` | May narrow what a workflow grants its agents, never widen it (`grantWidenedBy`, `src/closure.ts`). So today's strut already runs a job on a shorter list |

So the job can already do this. Nothing decided that it should.

## The change

**The rule.** A job's tools are the few every job uses. Everything else
this server can do is a step the job reads about on a page and runs by
name.

It takes away nothing the job can do: `meta/run-step` already runs any
step that is not sealed and does not ask a person first. And it adds
nothing.

### 1. The list

22 steps stay, with the 6 built-ins: 28 tools where there are 86.

| Stays | Why |
| --- | --- |
| `graph/graph-search`, `graph/graph-get` | A page is opened with one and found with the other |
| `meta/search-steps`, `meta/get-step`, `meta/run-step` | Find a step, read it, run it |
| `meta/list-workflows`, `meta/run-workflow` | A workflow that does the work comes before doing it by hand (`Job`) |
| `job/status`, `job/list`, `job/get`, `job/read` | Every job says what it is doing and reads earlier ones |
| `git/checkout` | Most jobs here are in a repository |
| `meta/add-claim`, `meta/verify-job` | Done means verified, for every job (`Job`) |
| `knowledge/edit-page`, `knowledge/add-page`, `package/install`, `package/commit`, `remote/buy-credit`, `task/set-type`, `app/make-public`, `meta/set-automation` | Each asks the person first, and a card needs a listed tool. The last runs only as a card, where a host lists it in `approve` |

A step a host adds to `approve` joins the list with it.

58 move: the rest of `meta/*` (writing workflows and steps, a run's
controls, a claim's upkeep), `app/*`, the other graph reads, the check
steps a claim names (`http/verify`, `browser/verify`,
`browser/walkthrough`), `strut/*`, `remote/*`, the package and task
reads, and `ssh/keygen`. `app/grant` goes with them: it runs only as a
card a person accepted, the job never listed it as one, so in a job it
could only fail. It stays the assistant's.

### 2. The pages

- **`Job`** gains a paragraph, since every job reads it: your tools are
  the few every job uses; a step a page names that is not among them
  runs through `meta/run-step` with its `type` and `config`;
  `meta/get-step` shows what a step takes; `meta/search-steps` finds one
  no page named. The sentence holds in both arms of the proof, so the
  pages do not differ between them.
- **`Workflow Language`** already gives each authoring tool and its
  arguments. Its rendering for the job (`PAGE_TOOLS`) says they are run
  by name. The builder's prompt is not that rendering and stays as it is,
  byte for byte (`src/ai/fixtures/builder-system.txt`).
- **`App`** names the `app/*` steps where it tells how an app is built.
- **No page of every tool.** `meta/search-steps` is that list, and it is
  never behind.

### 3. What stays as it is

- **`builder`**, the door for another server: its list and its prompt.
- **The assistant's turn** (`orchestrator`): 22 tools, 8 of them a
  card.
- **A package's `job: tools:`.** They work as now. A package moves when
  its owner wants: a page and no grant, as the canvas does.
- **Who may run what.** No grant, gate or seal changes.

## The proof

**One thing differs.** The same cases run twice on one server, at one
commit, with the same pages:

- **listed:** the job with the list it has now;
- **pages:** the job launched with `params.tools` set to the 22.

A launch may narrow the list, so neither arm needs a second workflow or
a second build. The default flips to the short list only after the
numbers are in, as the last commit.

**The claims** are on the `App` page, in its file, so they ship in the
pull request and any server can run them again:

1. An app built here opens, and does what was asked.
2. The job checked the app as a person opening it would, before it said
   done.
3. Nothing was published that the message did not ask for.

Each has the standard check: a model reading the work, its files and
its screenshots.

**The cases** are six messages, each a build that reaches a different
part of what moved:

| Case | Reaches |
| --- | --- |
| A tracker that keeps its own records, with a list and a detail view | An app, its own data |
| Paste notes, get action items, edit and save them | A workflow with a model step, behind an app |
| Weather for the cities a person adds | A new step, written and run until it works |
| A checklist two people tick at once | Live channels between viewers |
| A two-player board game | The `Game` page, under `App` |
| A change to the tracker: a search box and one more stage | Checking an app out, a new version (needs a case with a history, stakwork/strut#914) |

And four short ones on the `Job` page, for a step no page names: what
another server sells, whether a package exists for something, how the
work by people is going, what a failed run's deepest error was. Their
claim: it finds the step the message needs.

**How many.** Three samples of each case in each arm: 36 builds and 24
short runs. By the 2026-11-25 comparison (52 asks for $8.20, an app ask
about double the rest), that is tens of dollars and one to three hours,
four at a time. It is an estimate.

**What counts as no loss,** fixed before it runs:

- On claim 1, pages passes as many samples as listed, or one fewer, of
  18.
- No case passes every sample listed and none with pages.
- Time and cost of each arm are reported beside the verdicts. Pages is
  expected to cost less on the first turn and may take more calls.

Eighteen samples an arm shows a large loss (nine in ten down to six in
ten) and cannot show a small one. A result inside that band is "no loss
seen", and the pull request says so in those words. A result at the
edge is run again with twice the samples.

**When pages loses.** Read which steps the failed samples reached for,
put that group back in the list, and run again. The answer may be a
list of 35, not 22.

## What it needs first

Three things about trials, one about cases, and two outside this
repository. The first three are rows of `plans/experiments.md`'s "What
strut needs".

| # | Need | Today |
| --- | --- | --- |
| 1 | **A job with a budget runs trials:** the test steps as its tools (`plans/experiments.md`, open question 1) | They answer only strut's own page shown to an admin. Nothing launches a trial over HTTP |
| 2 | **A case carries `params`,** held to the launch's rule: narrower, never wider | A case is a workflow and its input |
| 3 | **A build leaves nothing behind.** What a trial's job published (workflows, steps, apps) goes when the job closes, and two samples of one case never run at once | Closing a job removes its directory, its record and what it held. What it published stays, and the next sample finds it and builds on it |
| 4 | A case with a history, for the sixth case alone | stakwork/strut#914, a plan |
| 5 | strut as a workspace a pod can run: its `.pod/` files | None in this repository. Set up, from the Code app, writes them |
| 6 | A model key on the pod, so the strut it runs can call a model | Strut's grant is built. The pods package's `claim` does not ask for it |

A job's budget is built (stakwork/strut#872). The form and the list in
the Knowledge app, a test of several pages and the `Experiment` page are
not needed for this.

## Building it in Jamie, on a pod

The pod is here because this change is to strut's own code, so the lab
has to be a second strut, run from the branch. An experiment on a page
or on an app needs none: the box is the lab (`plans/experiments.md`).
Needs 1 to 4 say nothing of pods.

1. **Set up** strut as a workspace (need 5), once.
2. A person asks Jamie for this plan, with a budget. Jamie starts a Code
   Change job, which takes a pod of that workspace and a branch.
3. **Before anything else, one case by hand, both ways.** Narrowing
   works today, so on the pod's strut the job launches the tracker case
   with the list as it is and with the 22. This is where a step that
   will not run through `meta/run-step` shows, before a page is written
   for it.
4. The job writes the pages (§2) and the claims and cases, and runs the
   tests.
5. **The pod's strut is where the trials run:** started from the branch,
   on a data directory of its own. Nothing a sample builds reaches the
   box. The job starts one job there with a budget, that job runs the
   trial of both arms (need 1), and its reply is the table.
6. The job reads the table against "What counts as no loss". If pages
   loses, it does what "When pages loses" says and runs again.
7. The last commit sets `params.tools` to the list that held, with
   `docs/jobs.md`. The pull request's body is the table: each case, each
   arm, samples passed, time and cost, and the sentence the numbers
   support.

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Does the job keep every tool in its list | No: the few every job uses, and the rest by name | owner, 2026-11-25 |
| 2 | Is it proved before it is switched | Yes, with trials, on building an app | owner, 2026-11-25 |
| 3 | Who builds it | Jamie, on a pod, ending in a pull request to strut | owner, 2026-11-25 |
| 4 | What the arms differ by | The list alone: one server, one commit, the same pages | proposed |
| 5 | Where the trials run | The pod's own strut, so no build lands on the box | proposed |
| 6 | Which tools stay | The 22 in §1 | proposed |

## Open questions, each with a default

1. **A step that asks a person, run by name.** Default: it stays in the
   list. Later `meta/run-step` could make the card itself, and the eight
   could move too.
2. **What `meta/run-step` answers.** It returns the step's output and
   the run's events, more than the tool's own answer. Default: as it is.
   The cost shows in the table, and it is trimmed if it shows.
3. **A claim's check that names a moved step** (`browser/verify`).
   Default: it needs no grant, since the check runs in the verify pass
   and not as the agent's call. To confirm in step 3 of the build.
4. **Packages.** Default: untouched. `stadeum/code` and `stadeum/pods`
   move in their own repositories, after this holds.
5. **A list for each kind of job** (an App job lists `app/*`, a Code
   Change job does not). Default: not built. It is the next thing to try
   if pages loses on apps alone.
6. **The model API's own way** (a tool declared out of view and brought
   in later, `plans/one-job-agent.md`). Default: not used. It keeps the
   schema in view at the price of a second mechanism.
7. **Running the trials with no job holding the test steps** (need 1
   not built). Default: wait for it. The fallback is the job opening the
   pod's Knowledge app in a browser and pressing Run as an admin would.
   It has not been tried.

## Work items, in order

1. **strut, from `plans/experiments.md`:** needs 1, 2 and 3. Tests: a
   job with no budget is refused the test steps; a case's `params` that
   widen are refused; a sample's published app is gone once its job
   closes.
2. **Outside strut:** needs 5 and 6.
3. **One case by hand, both ways** (build step 3). Write down every step
   that did not run by name.
4. **The pages:** the `Job` paragraph, `PAGE_TOOLS`, the `App` page's
   step names, `npm run render:concepts`.
5. **The claims and cases** on `App` and `Job`, in their files.
6. **The trials,** both arms, on the pod's strut. The table.
7. **The switch:** `params.tools` in `job.yaml`, `docs/jobs.md`, and
   `plans/one-job-agent.md`'s tool table.
8. **The pull request,** with the table.

## Not in this plan

- Fewer tools by merging them: five that run something, four that look
  at a page, twelve for claims.
- The assistant's turn and the builder.
- Packages' tools.
- A page per namespace, or a page of every tool.
