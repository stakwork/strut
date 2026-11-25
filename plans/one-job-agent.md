# One job agent: the builder folds into the job

Status: proposed (2026-11-24). The owner, that day: *"clearly the
job/builder split is stupid and might just need to go away? Which is the
'default' though? … do you think an agent would do worse with soooo many
tools? Do you think it makes sense for orchestrator to choose? maybe its
not 2 different workflows, but 2 modes (and can be run as both also)?"*
This plan answers those questions; every point in it is mine and open
until he rules.

Reviewed against the code the same day, and changed where it did not
hold: `meta/run-step` asks too (§6); the builder's own paragraphs, and a
rendering for an agent with a shell (§2); a build's kind and its page's
cap (§1); the orchestrator's `builds` list kept (§5); the measure moved
before the grants, with jobs that build nothing in it.

Work items 1 to 3 are built (strut#891, #892, #893). Building item 3
changed two things, written back here on 2026-11-25: the page is a file
in git, and it has no parent yet (§2, open questions 2 and 8).

Items 4 and 6 are built on `feature/one-job-agent` (2026-11-25,
strut#896), on the defaults of open questions 6 to 8, with one thing
folded in at the owner's word: an app says where it is changed (§7).
Item 5, the measurement, ran the same day: see "Measured" below.

It reverses a ruling: on 2026-10-20 the owner ruled that building workflows
is separate work, and the authoring tools are never granted to a regular
job (`plans/builder-job.md`). This plan grants them.

Companion: `plans/recent-work.md`. Its Apps page points at the app tools
this plan grants a job.

## The ask

A call's job on stadeum.stakwork.ai (2026-11-25 00:07 UTC,
`call-addc3b7cc6c78da6`) was asked for a screenshot of the trials UI in
the Knowledge app. It answered: *"I don't have the knowledge app's
address"*. A job holds no `app/*` tool:

- `job.yaml` dropped them all on 2026-10-22 ("an APP is the builder's").
  That was meant to keep a job from building apps, but it took the reads
  too.
- So the job could not list the apps (`app/list`), and could not look at
  one. `app/look { name: "strut/knowledge", steps: [...] }` takes exactly
  that screenshot, as the person.
- The gap went unnoticed: `plans/app-calls.md` says `app/calls` is under
  `app/*` "so the builder and jobs already hold it". Jobs do not.

The split costs in three more ways:

- **The orchestrator picks the tools before anyone has looked**
  (`start.workflow: job | builder`). A wrong pick cannot be undone inside
  the job.
- **Crossing over loses the thread.** A job that meets a build runs
  `builder` with a prompt that "stands alone: the builder sees nothing of
  your thread" (`Job.md`).
- **Real asks are mixed.** "Fix the canvas app and the repository behind
  it." The canvas package's Implement routes by the Architecture's
  `builds_in`: a repository goes to a Code Change job, strut goes to the
  builder.

## Why the split exists, and what holds

From `builder.yaml`'s header and `plans/builder-job.md` (amended
2026-10-21: *"the split is WHERE the work lives and which hands it gets,
not trust"*):

| Reason | Holds? |
| --- | --- |
| A workflow lives on one strut, so it is built there | For another server only: a build there is that server's agent anyway. Here, one agent can build |
| No shell keeps the builder authoring through its tools | A posture, not a boundary: the file says "It is no sandbox", and §9 of builder-job found every build reaching a shell through an `exec` check. A page can say it |
| The builder's rules sit in its system prompt | They belong on a page the agent opens when it builds (§2) |
| Other servers may run `builder` (`peer: true`), never `job`, whose input takes `agent` and `cwd` | Holds. `builder` stays as that door (§4) |

## Would it do worse with this many tools?

Measured on stadeum.stakwork.ai, 2026-11-24:

| Agent | Tools | System prompt |
| --- | --- | --- |
| Job | 48 granted (14 of them packages') + 6 built-ins | 10,769 characters |
| Builder | 23 entries; `meta/*` (34) and `app/*` (14) expand them to 69, + 5 built-ins | 35,904 characters, most of it the builder's rules |
| Both | about 90 granted + 6 built-ins | — |

- **The job already carries a lot.** Its first turn wrote 42,127 tokens to
  the cache before calling any tool, mostly tool definitions.
- **The cost is small.** Definitions are cached for an hour: roughly $0.20
  more on a job's first turn, then cents a turn.
- **The count is not what hurts; overlap is.** Three groups, and each
  tool's description must say when it is the one:
  - running something: `meta/run-workflow`, `meta/run-step`,
    `strut/run-workflow`, `remote/run-workflow`;
  - looking at a page: `app/look`, `browser/verify`,
    `browser/walkthrough`, and the `browser-explore` workflow;
  - verifying: `meta/verify-run` on a workflow's claim, `meta/verify-job`
    on the job's (open question 6).
- **Authoring rules in every prompt hurt more than tools do.** Most jobs
  build nothing. §2 moves them to a page.
- **Text that contradicts the tools hurts most.** The builder's rules say
  "No shell here"; this agent holds `bash`. §2 renders them for it.
- **Most jobs build nothing, and they hold the tools too.** A Code Change
  job could publish a workflow or a step nobody asked for. The measure
  (work item 5) runs such jobs and counts any authoring call.
- **Tools can be kept out of view without losing the cache.** A changed
  `tools` list rewrites the whole thread to the cache, so a thread's list
  stays as it started. The API now lets a request declare a tool deferred
  and bring it into view later, in a message (`tool_addition`, beta
  `mid-conversation-tool-changes-2026-07-01`), and the cached prefix
  holds. `@ai-sdk/anthropic` 4.0.71, the version installed, has both
  (`deferLoading`, `toolChanges`); Sonnet 5.5 takes them, Sonnet 5 does
  not. The agent step sends neither today, and this plan does not add
  them: open question 4 says when it would.

## Proposal

### 1. The default is `job`, and the kind is the mode

There is one agent: the job's. Building is a kind of job, as Code Change
is. `Workflow Builder` becomes a child of `Job`, and its children (`App`,
`Worker Tasks`, a deployment's janitors) are the kinds of build under it.

- **The orchestrator still chooses the kind**, as it does now (`kind` on
  `start`). It no longer chooses the tools, so a wrong kind costs little:
  the job opens the other page and goes on, with its thread.
- **"Run as both" comes free.** A job that changes a repository and the
  app over it holds both sets of tools.
- **A build's `kind` is `Workflow Builder`, never a page under it.** A
  kind's page is cut at 6,000 characters in the turn's prompt
  (`context/concept`'s `DOCS_MAX`; `kindPage` sets no `max`), and `App`
  is 67,709. The job opens the page under it in full with
  graph/graph-get, as the builder does. `Workflow Builder` itself is
  6,176, so its last lines are already cut in the builder's prompt: open
  question 7.

### 2. The builder's rules become a page

The rules are rendered from `src/ai/prompts.ts`. The chat builder's prompt
and `builder.yaml` both use them (`JOB_TOOLS`, `src/builder-seed.ts`).
Strut ships them as one more page of its own, `Workflow Language`: a file
in `src/concepts/` that `npm run render:concepts` writes from the same
source, and that a test holds to it (`src/ai/prompts.test.ts`). It is
seeded as every page is, so the seed matches git.

The page has no parent yet. A page under `Workflow Builder` is listed, as
a kind to open, in every prompt that reads that page: the chat builder's,
the `builder` job's and the orchestrator's. A line on `Workflow Builder`
telling its reader to open it reaches the first two as well, since both
read that page's text. Where it hangs, and which page says to open it, is
open question 8.

- **A third rendering.** `JOB_TOOLS` is written for an agent with no
  shell: "No shell here: probe an API's real response with
  meta/run-step", and an `App` page "listed at the end of this prompt".
  The page is rendered for the job: the `meta/*` names, the line on
  `bash` that the chat's rendering has (in the job's directory), and the
  `App` page named as the one under `Workflow Builder`. The chat's
  rendering stays byte for byte (`prompts.test.ts`), and a test pins the
  builder's the same way.
- **The builder's own paragraphs come too.** `builder.yaml`'s system
  prompt says three things the rules do not: the claim on the workflow
  and `meta/verify-run` on the test run; an app looked at before it is
  published, never a publish per attempt; a published app listed in
  `artifacts` as `{ kind: "app", app, version }`. They move, word for
  word, into `prompts.ts` beside the rules, and both the page and
  `builder.yaml`'s marker render them: one source, as the rules have.
  They cannot go on `Workflow Builder` itself: the chat builder reads
  that page, under other tool names.
- **After a compaction the page is out of view.** The builder's rules sit
  in its system prompt, which a compaction keeps; a page opened as a tool
  result is summarized away. The summary keeps the pages opened, by name
  (`AGENT_RETAIN`, `src/compaction.ts`), so the agent opens it again.
  Rare on a 1M window, where the mark is 90%; common on a 200k model.

The job's system prompt stays the `Job` page. Its paragraph "A WORKFLOW,
or an APP … is the builder's, never yours by hand" becomes: open `Workflow
Builder` and follow it, and `Workflow Language` before authoring (open
question 8); one published on another server is that server's
`builder`, run with `peer`. Its line "Never write workflow YAML into a
file or publish one another way" is dropped with it: the rules say a
workflow travels as a tool argument.

### 3. The job gets the builder's tools

In `job.yaml`:

- **`params.tools`:** add `meta/*`, `app/*`, `graph/query`, `task/types`,
  `task/set-type` and `task/report`.
- **`params.approve`:** add `task/set-type` and `app/make-public`.
- **Built-ins:** unchanged. The job already holds the editor, web tools,
  `repo_overview` and `fulltext_search`, and keeps `bash`.

A raw `graph/query` stays under the `jobs` reader's scope
(`src/graph/scope.ts`), as every job read is.

`approve` gates the tool call alone. §6 keeps `meta/run-step` from being
the same call without the ask.

### 4. What stays of `builder`

- **The door for another server.** A build on a peer is that peer's
  `builder`, launched by `strut/run-workflow` under this job, as now.
  `job/start { peer }` keeps launching it. `builder.yaml` does what it
  does now; the part of its system prompt that §2 moves is rendered from
  `prompts.ts`.
- **Builder jobs that already exist.** `job/continue` keeps a job's
  workflow (`turnOf`), and a session's system prompt is its first turn's,
  so they keep going on `builder`. Every new job starts on `job`.
- **A host's `builder` delta** (`createStrut({ builder })`,
  `STRUT_HOST_CONFIG.builder`) applies to that door only. What a host
  wants on the one agent goes in its `job` delta.
- **The chat builder in strut's web UI** is unchanged.

### 5. The orchestrator

- **`orchestrator.yaml` keeps the `builds` list.** Its lists are one
  level deep: the kinds under `Job`, and the kinds under `Workflow
  Builder`. Without the second it would no longer see `App`, `Worker
  Tasks` or a deployment's janitors, and `Worker Tasks` is written for
  the assistant to talk through before anything is built. A request for
  one of them is a job with `kind: Workflow Builder`, the build named in
  its brief, as `Orchestrator.md` says now.
- `start.workflow` goes from the reply's schema; `peer` stays, for a build
  on another server.
- `Orchestrator.md`'s two paragraphs on `workflow: builder` become: a
  build is `kind: Workflow Builder`, with `peer` when it is published on
  another server.
- `job/start` still accepts `workflow` for a caller that sends it.
  `builder` without `peer` starts a `job` with kind `Workflow Builder`.
  `peer` with no `workflow` launches the peer's `builder`; today
  `job/start` refuses `peer` unless `workflow` is `builder`.

As built: a kind named beside `workflow: builder` stands, where it was
refused, so a job can change a repository and build over it. With `peer`
no kind is passed on, since a builder reads its own page, and `repos`
are refused there. `peer` beside `workflow: job` is still refused.

### 6. `meta/run-step` asks too

`approve` holds back the agent's own tool call and nothing else. Read in
the code, not run:

- `meta/run-step` runs any step that is not sealed (`runStep`,
  `src/authoring.ts`).
- Strut's own gated steps refuse outside an accepted proposal
  (`ctx.proposal`: `package/install`, `remote/buy-credit`,
  `task/set-type`, `app/make-public`), and a host's gates hold whatever
  the route (`hostGates`, `src/proposals.ts`).
- A package's gate does neither. strut-gmail grants the job `send` with
  `approve: [send]`, and the step sends when it is called.

So a job that holds `send` as a tool that asks first, with `meta/run-step`
beside it, could send in one call with no card.

The fix, before the grant, is one refusal: `meta/run-step` refuses a type
the calling agent's own `approve` names, and says to call it as the tool.
The agent step knows that list and passes it with the tool's context, as
it already holds a sub-agent to it (`holdSubAgent`,
`src/steps/core/agent.ts`).

What it leaves alone, on purpose:

- **Building.** A workflow that holds `send` publishes and runs as
  written, for the builder and for a job: that is what a build is. What
  the builder can build does not change.
- **The `builder` workflow.** Packages grant to `job` alone
  (`packageJobGrants`), so its `approve` never names a package's step,
  and its `meta/run-step` runs one as it does now.

What stays as it is today:

- A test run of a workflow that sends, sends, with no card.
- An agent can still put `send` in a workflow of one step and run it. The
  refusal closes the route of one call, not every route: an agent that
  writes step code reaches the same API with the same secret, and only a
  reach (`builder.reach`) stops that.

### 7. An app says where it is changed

The owner's question, 2026-11-25: an app that is published here and is
also in a repository. Does the job edit it here, or open a pull request?

Before this it depended on the page the request landed on. The `App` page
says a package opened here as a repository is edited in place. The Code
package's `Code Change` page and the orchestrator's rule ("code in a
repository is a code change, even when the person calls it an app") say
checkout, branch, pull request. One agent with both pages and both sets
of tools had nothing to choose by, and the Recent Work list showed the
app and its repository as two unrelated lines.

So an app's line says where it comes from, which is where a change to it
goes (`appOrigin`, `src/apps/apps.ts`). Strut already keeps the facts.

| The line says | The app is | A change to it |
| --- | --- | --- |
| nothing | made here | is made here |
| `repo <address>, opened here` | its package is opened as a repository (Packages → Repos) | is made here, in place, and reaches the repository by `package/commit` when the person asks |
| `package <name>` | an installed package's | made here is this server's own copy |
| `strut's own` | seeded | is put back by the next boot, so it is a code change to strut |

- **Where it shows:** `app/recent` (the Recent Work list), each row of
  `app/list`, and `app/get`, as `origin`. The `Recent Apps` page says
  what each means.
- **The repository's address is on the line,** so "the moonlander repo"
  matches the app as well as the repository.
- **Three pages say to follow it,** in a few lines each: `Job` (in every
  job's prompt, so it holds for a job that started as a code change), the
  orchestrator's rule (its one exception), and `App`'s "An app in a
  repo": the edit ends on this server, and a commit is the person's to
  ask for.

Not built: a refusal in `git/push` for a repository opened here. A pod's
own `git push` goes around it.

## Measured (2026-11-25)

Work item 5. Two arms: "two agents" is `main` at a83d3c67, "one agent" is
`feature/one-job-agent` at 4004b787.

- **Servers.** Two scratch servers per arm, each with an empty workspace,
  `claude-sonnet-5-5`, and the same fixtures: a small code repository,
  one app made on the server, and two apps in packages opened as
  repositories (through Create repo).
- **The asks.** A script played the person. Each of 13 asks was one
  message to the assistant, so routing was measured too: three workflow
  builds (one with a person's step), three app asks, two mixed asks, one
  look at an installed app, the app in a repository named by its
  repository, and three that build nothing. A question from the assistant
  or a job got one plain "go ahead".
- **Repeats.** Each ask ran twice per arm, on a fresh server each time: 52
  runs, $8.20 in all.
- **Checked by hand.** The workflows were run on a known input, the apps'
  sources read, the code jobs' tests run. A job's own report was not
  taken as the result.

| | Two agents | One agent |
| --- | --- | --- |
| Cost, 26 runs | $3.84 | $4.36 |
| Model calls | 225 | 190 |
| Tool calls | 289 | 228 |
| Authoring calls in the 8 runs that build nothing | 0 | 0 |
| The app in a repository, named by its repository: changed in place | 0 of 2 | 2 of 2 |

Average for one ask, by kind:

| Kind of ask | Two agents | One agent |
| --- | --- | --- |
| Workflow build (3 asks) | $0.23, 9 model calls | $0.16, 8 model calls |
| App ask (3) | $0.10, 7 | $0.21, 8 |
| Mixed (2) | $0.23, 17 | $0.22, 11 |
| No build (4) | $0.09, 5 | $0.11, 4 |

What it showed:

1. **An app that is also in a repository (§7).** Named by its repository,
   two agents routed it as code both times: a commit on a new branch in a
   checkout, a push tried, the app never republished, and a question
   asking the person to make the remote writable. The one agent edited it
   in place both times, published it, and said the change was not yet in
   the repository. Named by the app, both arms edited in place; only the
   one agent said where the change was not.
2. **No drift.** No run that builds nothing made an authoring call, in
   either arm.
3. **The results were the same.** Every testable workflow's claim was
   supported in both arms, and each gave the right answer on a known
   input. The workflow with a person's step asked for the same task type
   in both. Both arms' code fixes pass their tests.
4. **The pages were opened.** The one agent opened `Workflow Language` on
   8 of 8 workflow builds and `Worker Tasks` on 2 of 2. On app asks it
   opened `App` 10 of 10 and `Workflow Language` 1 of 10. The builder
   opened `App` on none of the 8 app asks it was given.
5. **Cost.** 13% more overall. A workflow build cost the one agent less.
   An app ask cost it about double: it reads the 67k `App` page, and
   every call carries the longer tool list. On a cold cache the same look
   at an app cost $0.21 against $0.13.
6. **A mixed ask is still two jobs.** For "a code change and a workflow"
   the assistant started two jobs in both arms. One job did both only
   where the ask read a repository to build an app.
7. **Bash where the builder used the editor.** The one agent wrote and
   tested with its shell in builds.

What it does not show:

- The asks were small: the dearest job cost $0.35. Nothing here ran long
  enough to compact, so it says nothing on the page after a compaction or
  on open question 9.
- Two runs of each ask per arm. A difference of a few cents is noise.
- No Code package on the scratch servers: `Code Change` had no page, and
  nothing could push. The repositories were read-only on purpose.

For the open questions: 4 stays at its default (no worse picks, no
authoring calls where nothing is built). 9 is not answered.

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Is the split worth keeping | Direction: it "might just need to go away" | owner's question, 2026-11-24, not a ruling |
| 2 | The default | `job` | proposed |
| 3 | Who chooses | The orchestrator chooses the kind, never the tools | proposed |
| 4 | Two workflows or two modes | One workflow; the kind's page is the mode | proposed |

## Open questions, each with a default

1. **The door for another server.** Default: keep `builder` for peers,
   with no shell, as now. The alternative is opening `job` to peers. That
   means refusing `agent` and `cwd` on a peer's launch, and a person
   forwarded from another server would get a shell here.
2. **The rules page.** Built in item 3 as a file in git, written from
   `prompts.ts` by `npm run render:concepts`. A test fails while the file
   is behind, so the chat builder's prompt and the page never drift. The
   first default was rendering at boot. The seeder, the read from files
   on a server with no graph, and the dream all take a page as a file, so
   a file changed none of them. The alternative is still a hand-written
   `.md` that the chat builder reads too.
3. **The overlapping tools.** Default: keep them all, and make each
   description say when it is the one. Trim after measuring (item 5).
4. **Tools out of view until a job builds.** Default: none, unless item 5
   shows worse picks, or authoring calls in jobs that build nothing. Then
   the build's tools (the `meta/*` authoring steps, `app/*`, `task/*`)
   are declared deferred and brought into view when the job opens
   `Workflow Builder`, as its kind or by hand: the page is the mode, and
   its tools come with it. That needs the agent step to send
   `deferLoading` and `toolChanges`, a check through the gateway
   (`scripts/gateway-smoke.ts`), and every tool in view on a model or a
   route that takes neither. Search (`tool_search`) is the other way; it
   is a tool the provider runs, and a routed strut avoids those.
5. **How far a gate reaches (§6).** Default: the agent's own
   `meta/run-step`, and no further. A workflow that holds a gated step
   publishes and runs as written, as the builder's do now. Holding the
   gate inside a workflow the AI writes was considered and dropped: it
   would stop a build whose ask is a workflow that sends.
6. **What a build's claim is about.** Default: the workflow, verified
   with `meta/verify-run`, as the builder does now: the claim stays with
   the workflow after the job. The job's own ledger then shows nothing
   for a pure build. The alternative is one claim on both subjects
   (`meta/add-claim` takes several), so `meta/verify-job` shows it on the
   job too. Built as the default: the `Job` page says a build's claim is
   on the workflow, not on the job.
7. **`Workflow Builder` under the cap.** It is 6,176 characters and gains
   a line. Default: its three sections on `human` steps move, word for
   word, to a page under it that the agent opens when a workflow asks a
   person. The chat builder and `builder` read the same page, so they
   open it too. The alternative is a higher `max` on `kindPage`, which
   the owner declined on 2026-11-23, when `Code Change` reached the cap.
   Built: they moved to `Worker Tasks`, the page under it for work by
   people, which the builders already open for that kind. A page of
   their own would be one more kind in three prompts' lists. `Workflow
   Builder` is now 844 characters.
8. **Where `Workflow Language` hangs, and which page says to open it.**
   Default: no parent, opened by name, and the `Job` page's paragraph on
   building (§2) says to open it. `Job` is the job agent's page alone, so
   the chat builder, the `builder` job and the orchestrator see neither
   the page nor the line. It is then a root page, beside `Job` and
   `Dream`. The alternative is under `Workflow Builder`, with a
   description that says whose it is. The three prompts then list it as a
   kind, and the `builder` job, which has no shell, may open rules that
   say it has one. Built as the default.
9. **The job builds in its own thread.** The `Job` page still says "You
   coordinate; other agents do the heavy work", and a build is now the
   job's own work: a 28k page of rules, then cycles of build and look.
   Default: leave that paragraph as it is, and read item 5's numbers (what
   a build costs and how many turns it takes; whether a job that builds
   nothing drifts). The alternative is a sub-agent that builds, which is
   the split again inside one workflow.

## Work items, in order

1. **Now, on its own:** grant a job `app/list`, `app/get`, `app/look` and
   `app/calls`. This fixes the miss above. `app/look` runs the page as the
   person, as opening it does. It also corrects `plans/app-calls.md`'s
   line, and `job.yaml`'s comment "No app/*".
2. **Before any grant of `meta/run-step`:** the refusal (§6), with two
   tests: a job's `meta/run-step` on a type its `approve` names is
   refused, and a workflow that holds the same step still publishes and
   runs. It ships on its own.
3. The `Workflow Language` page (§2): the third rendering, the builder's
   paragraphs from one source, the pin on the builder's rendering, the
   pages opened in a compaction's summary. Nothing reads the page yet:
   it is built with no parent, as a file in git (open questions 2 and 8).
4. On one branch, together: `Workflow Builder` under `Job` and under its
   cap (open question 7), `Job.md`'s paragraph, where `Workflow Language`
   hangs (open question 8), `job.yaml`'s tools and approvals (§3),
   `src/job-seed.ts` tests, and where an app is changed (§7). Any one of
   them changes what every job does, so the branch does not merge before
   item 5. Built 2026-11-25 on `feature/one-job-agent`.
5. **Measure the branch before it merges:** on a scratch strut with a
   real model, the same asks through the two agents as they are and
   through the one, each ask twice (one run of an agent says little):
   - three workflow builds;
   - two app changes;
   - two mixed asks (a repository and the app over it);
   - one look at an installed app;
   - one change to an app that is also in a repository, asked by the
     app's name and by the repository's (§7);
   - three jobs that build nothing: a code change, a page of research, a
     plan.

   Compare whether each job's claims verified, what it cost, how many
   turns it took, and which tools it picked. In the jobs that build
   nothing, count any authoring call (`meta/publish-workflow`,
   `meta/create-step`, `app/publish`): there should be none.
6. The orchestrator (§5) and `job/start`: `workflow` with no `peer`,
   `peer` with no `workflow`. It merges with item 4, not after it. With
   `Workflow Builder` under `Job`, the orchestrator's first list names it
   as a kind of job, while its page still sent a build to `builder`,
   and `job/start` refused a `kind` beside `workflow: builder`. Built
   2026-11-25 on the same branch.
7. Docs: `docs/jobs.md`, `docs/builder.md`, `docs/security.md` (§6); a
   status line on `plans/builder-job.md` naming this plan. Done with
   items 4 and 6.
