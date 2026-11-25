# One job agent: the builder folds into the job

Status: proposed (2026-11-24). The owner, that day: *"clearly the
job/builder split is stupid and might just need to go away? Which is the
'default' though? … do you think an agent would do worse with soooo many
tools? Do you think it makes sense for orchestrator to choose? maybe its
not 2 different workflows, but 2 modes (and can be run as both also)?"*
This plan answers those questions; every point in it is mine and open
until he rules.

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
- **The count is not what hurts; overlap is.** Four tools run something:
  `meta/run-workflow`, `meta/run-step`, `strut/run-workflow`,
  `remote/run-workflow`. Their descriptions must say when each is the
  one.
- **Authoring rules in every prompt hurt more than tools do.** Most jobs
  build nothing. §2 moves them to a page.
- **If it still picks worse,** the lever is loading rarely used tools
  (`task/*`, `remote/*`, rollback) only when searched for. The agent step
  has no such thing today, and this plan does not add one.

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

### 2. The builder's rules become a page

The rules are rendered from `src/ai/prompts.ts`. The chat builder's prompt
and `builder.yaml` both use them (`JOB_TOOLS`, `src/builder-seed.ts`).
Strut seeds them as a page under `Workflow Builder`, `Workflow Language`,
rendered at boot from the same source with the job's tool names. The
seeder stamps the rendered text's hash, so the seed still matches git.
The `Workflow Builder` page says to open it before authoring.

The job's system prompt stays the `Job` page. Its paragraph "A WORKFLOW,
or an APP … is the builder's, never yours by hand" becomes: open `Workflow
Builder` and follow it; one published on another server is that server's
`builder`, run with `peer`.

### 3. The job gets the builder's tools

In `job.yaml`:

- **`params.tools`:** add `meta/*`, `app/*`, `graph/query`, `task/types`,
  `task/set-type` and `task/report`.
- **`params.approve`:** add `task/set-type` and `app/make-public`.
- **Built-ins:** unchanged. The job already holds the editor, web tools,
  `repo_overview` and `fulltext_search`, and keeps `bash`.

A raw `graph/query` stays under the `jobs` reader's scope
(`src/graph/scope.ts`), as every job read is.

### 4. What stays of `builder`

- **The door for another server.** A build on a peer is that peer's
  `builder`, launched by `strut/run-workflow` under this job, as now.
  `job/start { peer }` keeps launching it. `builder.yaml` is unchanged.
- **Builder jobs that already exist.** `job/continue` keeps a job's
  workflow (`turnOf`), and a session's system prompt is its first turn's,
  so they keep going on `builder`. Every new job starts on `job`.
- **A host's `builder` delta** (`createStrut({ builder })`,
  `STRUT_HOST_CONFIG.builder`) applies to that door only. What a host
  wants on the one agent goes in its `job` delta.
- **The chat builder in strut's web UI** is unchanged.

### 5. The orchestrator

- `orchestrator.yaml` drops the `builds` list: `Workflow Builder` is now
  one of the kinds under `Job`.
- `start.workflow` goes from the reply's schema; `peer` stays, for a build
  on another server.
- `Orchestrator.md`'s two paragraphs on `workflow: builder` shrink to one
  line on `peer`.
- `job/start` still accepts `workflow` for a caller that sends it.
  `builder` without `peer` starts a `job` with kind `Workflow Builder`.

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
2. **The rules page.** Default: rendered at boot from `prompts.ts`, so the
   chat builder's prompt and the page never drift. The alternative is a
   hand-written `.md` that the chat builder reads too.
3. **The overlapping run tools.** Default: keep all four, and make each
   description say when it is the one. Trim after measuring (item 6).
4. **Deferred tools.** Default: none, unless item 6 shows worse picks.

## Work items, in order

1. **Now, on its own:** grant a job `app/list`, `app/get`, `app/look` and
   `app/calls`. This fixes the miss above. `app/look` runs the page as the
   person, as opening it does. It also corrects `plans/app-calls.md`'s line.
2. The `Workflow Language` page (§2) and `Workflow Builder` under `Job`;
   `Job.md`'s paragraph.
3. `job.yaml`'s tools and approvals (§3); `src/job-seed.ts` tests.
4. The orchestrator (§5) and `job/start`'s `workflow` with no `peer`.
5. Docs: `docs/jobs.md`, `docs/builder.md`; a status line on
   `plans/builder-job.md` naming this plan.
6. **Measure before item 4 ships:** the same eight asks on a scratch
   strut with a real model, through the two agents as they are and
   through the one:
   - three workflow builds;
   - two app changes;
   - two mixed asks (a repository and the app over it);
   - one look at an installed app.

   Compare whether each job's claims verified, what it cost, how many
   turns it took, and which tools it picked.
