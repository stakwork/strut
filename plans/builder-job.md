# The builder job: workflow building as a kind of job, here and on another strut

> **Status (2026-10-20): proposed, two points ruled; work item 1 BUILT** on
> `feature/builder-job` — `src/workflows/builder.yaml`, `src/builder-seed.ts`,
> the `peer: false` delta, `createStrut({ builder })`, `STRUT_HOST_CONFIG.builder`,
> `src/builder-seed.test.ts`. **Work item 2 BUILT** on
> `feature/builder-prompt-source`: the builder's rules in `src/ai/prompts.ts`
> render from a role → tool-name map (`CHAT_TOOLS`, `JOB_TOOLS`), the
> chat's byte-identical (`src/ai/prompts.test.ts`), the job's rendered into
> builder.yaml's `params.system` by the seed. **Work item 3 BUILT
> 2026-10-21, amended first** (ruled that day): the orchestrator learns the
> kind the way it learns every other kind — a Concept strut seeds under `Job`
> (`src/concepts/Workflow Build.md`) — with the routing rule on `job/start`'s
> `workflow` field and ONE sentence in its prompt, not the paragraph §2 first
> proposed. The reason: Jamie's "what can I do" answer IS the `Job` tree
> (`context/concept`, the kinds alone), so a kind that lives only in prose
> never appears in it, and the model routes everything else from that table.
> Written against strut
> `main` @4b19438 (this worktree), hive `master` @250154f6e and stakgraph
> `main` @be2cde00; citations are `file:line` on those commits. The question:
> Jamie's chats are now turns of strut's `orchestrator` workflow
> (`src/workflows/orchestrator.yaml`), and the orchestrator has no way to
> get a workflow BUILT — what hive's `dispatch_strut` did by calling the
> swarm's builder chat (`hive/src/lib/ai/strutTools.ts:236-238`). The owner
> ruled on 2026-10-20: **(1) building workflows is a separate kind of work
> from building code or any other job — the authoring tools are never a
> grant on a regular job; (2) building on ANOTHER strut is v1, not later.**
> Every other row in "Decided" is mine and open until he says otherwise.
> Companion to `jobs.md` (the job, deliverables, the index), `federation.md`
> §2.2 and §3 (dispatch-through, peers, `peer: true`), `proposals.md` (the
> approval lever), `specs/EVOLVE_SPEC.md` §5–§6 (the `meta/*` surface and
> what it may never touch) and `specs/CALLBACKS.md` (what a job's `run.end`
> carries). Hive's half is described as the contract it reads, not as work
> items here.
>
> **Work item 4 BUILT 2026-10-21** on `feature/peer-tagged-artifacts`:
> `strut/run-workflow` tags the peer output's `artifacts` with `peer` and the
> job as the PEER recorded it (its `run.start`: `peer/<job>` on its peer key
> — the peer's own id for the job, so a host resolves a path with no
> namespace rule of its own), `resolveArtifactRefs` leaves a tagged ref as
> it came, the job fold and the UI's deliverable cards show it as foreign;
> `specs/CALLBACKS.md` §4 is the host's contract.
>
> **Work item 5 VALIDATED 2026-10-21** (`feature/builder-job-live-validation`):
> two struts from this checkout, a real model, every row of §9 — the
> orchestrator routing a build to `@second` (and, with no `@`, here), `#launch`,
> peer-tagged nodes and deliverables, `job/continue` on the peer's thread,
> kill-and-resume reattaching, cancel forwarded, `peer: false` refusing.
> Three strut bugs found and fixed on the branch (a peer's job thread was
> `peer/peer/<job>`; the job view split a peer build into phantom threads;
> a reverted host delta was never re-applied, so seeds now always match
> git, as ruled that day); four observations written up in §9. About $1.53
> of model spend.
>
> **Amended 2026-10-21, after the day's review:** the split is WHERE the work
> lives and which hands it gets — not trust. A workflow lives on one strut
> (its graph, secrets, services) and is built there; code lives in its
> repository and is checked out wherever a job runs. No bash on the builder
> is focus, not a boundary: §9 found every build reaching a shell through an
> `exec` check, and `meta/run-workflow` runs any unsealed workflow, `job`
> included. So: a job agent that meets a build runs `builder` itself
> (`meta/run-workflow`, the `Workflow Build` page) instead of bouncing it
> with "this is a builder job"; a job started through `job/start` gets
> `input.workspace` from the strut's `self` record; the job's prompt carries
> its id (what a claim's subject and the build's thread are named by).
>
> **Amended 2026-10-22:** the builder builds APPS too (plans/apps.md §8:
> `app/*` and the editor are on its seed), and the orchestrator was never
> told: asked for an app on a peer, it answered that apps run here. Two
> changes. (1) **One tree per agent.** `Workflow Build` sat under `Job` only
> because the orchestrator read `Job` alone, so the job agent's manual was
> also the orchestrator's menu. It is retired (`STRUT_CONCEPTS.retired`,
> soft-deleted at boot); the orchestrator reads the kinds under BOTH roots —
> `Job` (what a job does) and `Workflow Builder` (what the builder builds,
> `App` and a deployment's janitors among them) — and `Job`'s own docs tell
> a job agent that meets a workflow or a workspace's app to run `builder`.
> (2) **The app split.** Anything about an app that should exist in a
> workspace — a new one, a change to one, one on a peer — is a builder job;
> `Job App` is only an app that shows THIS job's own results — and, later
> that day, RETIRED: a page over a job's results is an HTML file in its
> directory, an app is the builder's, and the builder hands it over BY
> NAME — `{ id, kind: "app", title, app: "<name>", version? }`, resolved
> to the version's document with `app: { name, version, hash }`
> (`artifact-refs.ts`; hive's frame already takes `{ app, version }`). The
> job seed grants no `app/*`; the job-app runtime stays until hive's job
> path is confirmed dead. `job/start`'s
> `workflow` field and the orchestrator's one sentence say "a workflow, or
> an app that lives in a workspace"; the builder names an app it published
> (name, version) in its `text` and hands back no unpublished app
> directory, so the two paths do not overlap. §2's "A Concept strut seeds
> under `Job`" below is superseded by (1).

## Problem

`dispatch_strut` was Jamie's door to strut's **workflow builder**: a message
to the swarm's builder chat (`POST /chat`, `hive/src/lib/ai/strutTools.ts:236-392`)
with a callback per turn, continued by `chatId`. The chat is the authoring
surface strut has had longest: the AI SDK agent in `src/ai/tools.ts` with
every authoring tool (list/search/get steps, create/edit a step, create/edit
a workflow, validate, run, run a step with a cassette, list/get/search runs,
set the active version, control a run, claims, schedules, ask the user,
request a secret), a prompt that is strut's YAML dialect plus the procedure
(`src/ai/prompts.ts:169-178`, `:180-329`) plus the `Workflow Builder`
Concept page as the deployment's section (`src/ai/builder-system.ts`).

The orchestrator has none of it. Its tools are memory, the job launchers,
the job reads and the two peer steps (`orchestrator.yaml:94-107`), and its
rule is that anything needing a working directory is a job's
(`:124`). The `job` workflow's agent holds the `meta/*` READ and RUN twins —
list/get a workflow, run it, read a run — and the seed's comment holds the
write twins back "until running works" (`job.yaml:145-147`). Running works.
But granting the writes to `job` is the wrong move for a reason the owner
named: a workflow build is a different kind of work from a code change or
a research job, with a different prompt, a different reference page, a
different set of hands, and a different trust statement when another strut
asks for it. Ruled point 1.

And the old tool took a `workspace` slug that never meant anything: hive
resolves purpose `chat` to the org's default swarm whatever slug Jamie
fills in (`hive/src/services/strut-target.ts:63-80`; the comment at
`:30-40` records why — a per-workspace swarm had no delegation pushed, so
the chat's first model call was refused). The orchestrator runs on the same
default (`:78`, purpose `orchestrator`). So "build on @acme-web" has never
worked, and it is wanted in v1. Ruled point 2.

The two rulings point at one unit. Dispatch-through launches only a
workflow that says `peer: true`, as published, with no `params`
(`src/createStrut.ts:3008-3014`; `federation.md` §3): whatever a workflow
is locally is exactly what a peer gets. A **separate `builder` workflow**
that strut ships, `peer: true` from the start, is the kind of work ruled in
(1) and the unit ruled in (2).

## Decided

| Question | Decision |
| --- | --- |
| Where the authoring tools live | **A third seeded workflow, `builder`** (ruled: separate from `job`). `job.yaml` is untouched: a code job never sees a `meta/*` write. The orchestrator starts a builder job as it starts any job |
| Cross-strut in v1 | **Yes** (ruled). The builder is `peer: true` in its seed, launched on another strut through `strut/run-workflow` from a branch inside the same YAML (§3) |
| The door | `job/start` gains `workflow` (`job` \| `builder`, default `job`) and `peer` (§2); `job/continue` follows the job's record. Mine |
| How the orchestrator learns it | **Superseded 2026-10-22: it reads the kinds under both `Job` and `Workflow Builder`, and `Workflow Build` is retired** (amendment above). First: **a kind under `Job`, seeded by strut** (`Workflow Build`), the routing rule in `job/start`'s own schema, one prompt sentence (§2). Ruled 2026-10-21: a workflow build IS a kind of job to the person, and the kinds table is what the orchestrator routes by and recites; `builder` vs `job` is where the work lives and which hands it gets (amended that day, above), never something the person names. A job the orchestrator misroutes still gets built: its agent runs `builder` (`Workflow Build`'s docs) |
| The builder's built-ins | **web_search + web_fetch only** (`toolFilter`), as the lab's `explore` keeps bash off a workflow another strut may launch (`stakgraph/mcp/src/lab/explore/workflows/explore.yaml:25-32,78,133`). What the chat used bash for goes through `meta/run-step` with a cassette and `meta/get-run` / `job/read` (§1). Mine |
| The builder's tools | `meta/*` as a glob — every authoring twin, and a twin added later lands with no seed edit — plus the graph reads and the `job/*` reads (§1). Mine |
| The builder's prompt | **One source.** The dialect rules and the procedure in `src/ai/prompts.ts` are factored to render with the chat's tool names for the chat and with `meta/*` names for the seed; the `Workflow Builder` page comes in through `context/concept` exactly as the chat reads it (§1). Mine |
| Deliverables from a peer | **Tagged by peer id, never resolved locally** (`federation.md` §2.2's handle rule applied to an artifact): `strut/run-workflow` tags the peer output's `artifacts` with `peer`, `artifact-refs` leaves a tagged ref alone (§3). Mine |
| The trust statement | `peer: true` on the builder says: a person the org strut forwards may AUTHOR here, which is code in this process (§4) — an `exec` step, a custom step over `ctx.services.shell`, `meta/run-workflow` of any unsealed workflow, `job` included. A deployment drops the key through the seed delta; `approve` turns every publish into a proposal. Mine |

## Design in one paragraph

Strut ships a third workflow, `builder` (`src/workflows/builder.yaml`,
seeded like `job` and `orchestrator` through `templateWithDelta`,
`src/job-seed.ts:69-75`): the job skeleton — `job/dir` → `context/concept`
on `Workflow Builder` → `agent` on the job's session → `pack` in the job's
reply shape — with the authoring surface as its tools (`meta/*`, the graph
reads, the job reads), web search and fetch as its only built-ins, and the
chat builder's rules and procedure as its system prompt, rendered from the
one source the chat uses. It says `peer: true` at the top, so another strut
may launch it as published. `job/start` takes `workflow` and `peer`: a
builder job on this strut is a launch of `builder`; a builder job on
`@acme-web` is the SAME local launch with `input.peer`, and `builder.yaml`
branches on it the way `job.yaml` branches on `input.agent` (`job.yaml:50-112`)
— the agent locally, one `strut/run-workflow` step to the peer otherwise,
under the same job id, so the job exists on the org strut (its record, its
runs, hive's row) while the work, the files and the thread live on the
target under `peer/<job>`. Everything dispatch-through already does comes
for free: the `#launch` journal so a restart reattaches instead of
launching twice, cancel forwarded, the touched nodes folded and tagged
(`src/steps/lib/strut/run-workflow.ts:44-56,154-170`). Two additions tag the
peer's deliverables so the person opens them where they are. The
orchestrator learns one line: a workflow to build, change or debug is a
builder job, and `@slug` names the strut it belongs on.

## 1. The `builder` workflow

**Shape.** `job.yaml`'s, less the checkouts and the local-agent branch,
plus the peer branch (§3):

```yaml
name: builder
peer: true        # another strut may launch it, as published (§4 is the statement this makes)
input:
  prompt:    { type: string }
  session:   { type: string, required: false }   # the thread; the job id unless given
  workspace: { type: string, required: false }   # the slug of the workspace this strut belongs to
  peer:      { type: string, required: false }   # run it THERE instead (§3); unset on the target
steps:
  - id: dir
    type: job/dir
  - id: concepts            # what THIS workspace builds: the Workflow Builder page + its kinds
    type: context/concept   # (job.yaml's order: read before the gate; empty without a graph)
    config: { name: "{{ params.concept }}" }
  - id: here
    type: if
    config: { cond: "{{ !input.peer }}" }
  - id: build
    type: agent
    depends: here
    when: true
    config:
      cwd: "{{ dir.path }}"
      session: "{{ input.session || $job }}"
      model: "{{ params.model }}"
      maxSteps: "{{ params.maxSteps }}"
      system: |-
        {{ params.system }}
        {{ concepts.text }}
      prompt: "{{ input.workspace ? 'Workspace: @' + input.workspace + '. ' : '' }}{{ input.prompt }}"
      toolFilter: "{{ params.builtins }}"
      agentTools: "{{ params.tools }}"
      approve: "{{ params.approve }}"
      schema: <job's: text, artifacts, ask>
  - id: remote              # §3
    type: strut/run-workflow
    depends: here
    when: false
    config:
      peer: "{{ input.peer }}"
      workflow: builder
      input: { prompt: "{{ input.prompt }}", session: "{{ input.session }}", workspace: "{{ input.peer }}" }
      job: "{{ $job }}"
  - id: result
    type: pack
    depends: [build, remote]
    config:
      text: "{{ build?.object?.text || remote?.output?.text }}"
      artifacts: "{{ build?.object?.artifacts || remote?.output?.artifacts }}"
      ask: "{{ build?.object?.ask || remote?.output?.ask }}"
      cost: "{{ build?.cost || remote?.output?.cost }}"
      session: "{{ build?.session || remote?.output?.session }}"
      peer: "{{ input.peer }}"
params:
  model: claude-sonnet-5-5
  maxSteps: 200
  concept: Workflow Builder
  builtins: [web_search, web_fetch]
  tools: [meta/*, graph/graph-get, graph/graph-search, graph/get-ontology, job/list, job/get, job/read]
  approve: []
  system: <rendered at seed time — below>
```

**Tools.** `meta/*` is a glob (`src/steps/core/agent.ts:1081`): the
twenty-seven twins under `src/steps/lib/meta/` today — the reads, the runs,
`publish-workflow`, `create-step`, `edit-step`, `validate-workflow`,
`run-step`, the claim steps, `verify-run`, `verify-job` — and whichever is
added for the parity gaps (§6) without a seed edit. The graph reads are what
the chat has as `graph_get` and the Concept walk; `graph_query` is a chat
tool by design (AGENTS.md on `src/graph/query.ts`: "a chat tool, deliberately
not a step") and stays one. The `job/*` reads let a builder start from an earlier job's
deliverables, as the job agent does. No `strut/*`: the builder on a strut
builds for THAT strut; a cross-workspace lookup from inside a build is the
orchestrator's business before it starts the job.

**Built-ins.** `web_search` and `web_fetch` only — API documentation while
authoring, the one thing the chat's prompt says the web tools are for
(`prompts.ts`, "Tools"). No `bash`, no editor, no file tools: a workflow
another strut may launch gets no shell (`explore.yaml:25-27`, the same
rule), and the builder authors YAML and TypeScript as tool arguments, not
files. What the chat did with bash has a door already: probing an API is
`meta/run-step` on the `http` step with a cassette, which is what the
chat's own prompt tells it to do for an authenticated API; a run's files
are `meta/get-run` and `job/read`. Authoring a step is code execution in
the target's process whatever the built-ins are (§4), so keeping bash
would buy nothing the surface does not already imply, and dropping it
removes the casual path. The standing rule that a seeded GENERAL agent keeps every built-in is
about the job agent; `explore` filters, and so does this. (Amended: the
editor family joined with plans/apps.md §8, and "no bash" turned out to be
focus, not a boundary — §9.)

**Knowledge.** `context/concept` on `Workflow Builder` (`params.concept`),
rendered for the system prompt with the agent's own name for
`graph/graph-get` as the tool it opens a child page with (the step's
default) — the same step the chat's default
`chatSystem` is (`src/ai/builder-system.ts:40-55`) and the `job` workflow
uses for `Job` (`job.yaml:45-49`). So a builder on a swarm knows what THAT
workspace builds and the convention each kind follows, reads a kind's page
before building one, and never publishes a second workflow for a job a
convention already names. Empty without a graph or the page, never a failed
run.

**Prompt — one source.** `BASE_SYSTEM` (`prompts.ts:180-329`) is the dialect
(YAML shape, `params` and `input`, templates, quoting, the LLM-vs-code
split, caps, branching, loops, agents, errors, authoring a step and the
`ctx.services` contract) followed by a "Tools" section that names the CHAT
tools, and `BUILDER_PROCEDURE` (`:169-178`) names them again. The twins have
other names: `meta/list-workflows` for `list_workflows`, `meta/run-step`
for `run_step`, and so on; `ask_user` is the job's `ask`, `request_secret`
has no twin (§6). Rather than a second copy in the seed that drifts, the
module is factored: the dialect text stands alone, and the "Tools" section
and the procedure are rendered from a role → name map, once with the chat's
names (the chat's prompt is byte-identical to today's, so no chat's cached
prefix moves) and once with the meta names by `builder-seed.ts`, which
fills `params.system` before the host's delta is appended
(`templateWithDelta`, `job-seed.ts:69-75`). The merged text is what is
hashed and published, so a prompt edit in strut publishes the next version
at the next boot, as a seed edit does.

**Thread.** `session: input.session || $job`: the build is the job's
thread, compacted in place, continued by `job/continue`. On a target the
job is `peer/<id>` and so is the session (`src/createStrut.ts:3011`,
`src/runner.ts:171-181`).

**Host delta.** `createStrut({ builder: { tools, approve, system, model } })`
and `STRUT_HOST_CONFIG`'s `builder`, the same `JobSeedOptions` the other two
seeds take, plus one more: `peer: false` deletes the key for a deployment
that will not have other struts author on it (§4). `builder: false` seeds
nothing. `src/builder-seed.ts` is `orchestrator-seed.ts` with the names
changed.

## 2. The door — `job/start { workflow, peer }`

`job/start` (`src/steps/lib/job/start.ts`) launches the `job` workflow by
name through `ctx.services.jobs.launch`, which reads it off the workspace
(`src/createStrut.ts:2929-2932`). Two inputs join `prompt`, `title` and
`repos`:

- `workflow`: `job` (default) or `builder` — the two job-shaped workflows
  strut ships. A closed enum on the step's schema, so the model cannot
  name an arbitrary workflow (that is `meta/run-workflow`'s job, inside a
  job). `JobLaunch` gains `workflow?`, and the launcher reads that
  workflow instead of `"job"`. The job's record already keeps each run's
  workflow (`src/jobs.ts:53-81`, `recordRun` at `run.start`), so
  `job/continue` launches the workflow the job's last run was, and
  `GET /jobs/:id` shows which a job is.
- `peer`: the id of the strut the build belongs on, as `strut/list-peers`
  lists them (`@acme-web` → `acme-web`). Only with `workflow: builder`: a
  workflow lives on one strut and is built there, while code is checked
  out wherever the job runs, so a code job runs here (amended 2026-10-21;
  `job` also stays closed to peers, its `agent` and `cwd` inputs being a
  host's). Passed into the launch's `input.peer`; the
  record keeps it with the run's input, so `job/continue` finds it and
  the orchestrator need not remember it.

**How the orchestrator learns it** (amended 2026-10-21; built so). Not a
prompt paragraph. The orchestrator's list of what a job can do here is the
`Job` Concept's children, rendered by `context/concept` at the end of every
turn's prompt (`orchestrator.yaml`, `docs: false`), and that list is what it
routes by and what it recites when asked what it can do. A kind that lives
only in prose never shows up there. So the kind lives where every other kind
lives, in three small pieces:

1. **A Concept strut seeds under `Job`**: `src/concepts/Workflow Build.md`,
   `parent: Job`, in `STRUT_CONCEPTS` beside the two roots — strut ships the
   builder on every strut, so the kind is workspace-general. Its one-line
   `description` is what the orchestrator sees (the kinds are name + line):
   a workflow to build, change, test or debug is a builder job, on the strut
   whose workspace it belongs to. Its docs are for the job agent that reads
   the `Job` tree WITH docs and lands here by mistake: this kind is not a
   job agent's, say so in the reply, do not improvise YAML.
2. **The routing rule on the tool**: `job/start`'s `workflow` field says in
   its own description when it is `builder` and when `peer` goes with it —
   the model reads a tool's schema more reliably than prose, and the rule
   sits beside the call it governs.
3. **One sentence in the orchestrator prompt**, in the job paragraph: a
   workflow to build, change, test or debug is a builder job (`workflow:
   builder`), on the strut whose workspace it belongs to (`peer` when that
   is not this one). The old tool's "a workflow request goes here by
   default" (`strutTools.ts:238-241`) in strut's words, and no more.

Its `retain` already keeps the jobs started by id and title. Nothing else in
the orchestrator changes: no authoring tool, no builder prompt, no new grant.
`GET /jobs/:id` (and each `GET /jobs` row) carries `workflow`: the one its
newest top-level turn ran, among the job-shaped workflows strut ships
(`JOB_WORKFLOWS`, `src/jobs.ts`) — what `job/continue` launches, and what a
host shows.

## 3. Another strut — the `input.peer` branch

The peer case needs no new runtime machinery. `builder.yaml` branches on
`input.peer` as `job.yaml` branches on `input.agent` (`job.yaml:50-112`:
strut's agent or a local ACP agent, one `if`, two `when`s): locally the
agent runs; with a peer, the one step is `strut/run-workflow { peer,
workflow: builder, input: { prompt, session }, job: $job }`
(`src/steps/lib/strut/run-workflow.ts`). The run on the org strut is a
real job turn under the job id, so:

- **the job exists here.** `job/list` and `job/get` find it; the record
  has its runs; hive's row keys on this run's id and this swarm; its
  `run.end` goes to the root callback through the launcher that exists
  (`createStrut.ts:2929-2958`), with `workflow: "builder"` and the job
  (§5).
- **the work is there.** `launchOnPeer` POSTs the peer's `/workflows/
  builder/run` with `x-strut-actor: <this run's principal>` and `job`
  (`src/peers.ts:253-280`); the peer keeps the job as `peer/<id>` and the
  session with it; the target's `builder` runs with `input.peer` unset,
  so its agent branch runs. Its files, its runs, its claims and its
  billing are the peer's.
- **resume.** The step journals the handle at `<path>#launch` before it
  waits; a re-executed step for the same peer and workflow reattaches
  (`run-workflow.ts:14-30,89-91`). The org strut restarting mid-build
  does not launch a second build.
- **cancel.** Hive cancels the local run; the step POSTs cancel to the
  peer (`:134-147`); a local run ending for any other reason takes the
  peer's with it.
- **nodes.** What the target's builder read and wrote is folded off the
  tail, tagged with the peer, onto this step's `step.end` (`:154-170`), so
  the run flyout and hive's run graph show it as foreign.
- **ask.** The target's builder puts its question in `ask`; the pack
  passes it; hive shows it; the person's answer is `job/continue { job }`
  → the local `builder` → `remote` again → the peer's thread continues.
- **the tail, not a callback.** Reader-initiated by the decision of
  2026-10-08 (`federation.md` §2.2): the org strut needs to reach the
  peer and nothing else. The cost is a held connection for the build's
  length, which the step already reattaches after a drop.

**Deliverables, tagged.** The target's builder lists what it made in
`artifacts` with `path`s relative to ITS job directory, which would mean
nothing resolved here: `artifact-refs` turns a `path` into
`/jobs/<job>/files/…` on this strut and reports `not found`
(`src/artifact-refs.ts:150-170`). Two additions apply the handle rule — a
foreign thing is tagged with the peer, by id, never rewritten to a URL,
and resolved by the reader (`federation.md` §2.2, "Provenance"):

1. `strut/run-workflow` folds `peer: cfg.peer` and `job` onto each entry
   of the peer output's `artifacts` when the output has one — `job` as
   the PEER recorded the run (its `run.start`, `peer/<job>` on its peer
   key; `cfg.job` only when the log has none). The same step, the same
   tail, no extra request; the model sees the plain output. An entry the
   peer itself tagged (from a third strut) keeps its tag, as a node does.
2. `resolveArtifactRefs` leaves a ref carrying `peer` as it came — no
   local path, no `error` — so the `run.end` callback and
   `GET …/runs/:runId/artifacts` carry `{ id, title, path, peer, job }`
   and the host resolves it against that peer (§5). The pack's top-level
   `peer` says the same of the whole turn.

Nothing new crosses. `params` are not sent (the gate refuses them —
`createStrut.ts:3008-3010`); the caller's MCP servers are never forwarded
(`strut/run-workflow` sends none; `mcp-servers.ts`); the org strut's job
directory is not shared; no callback URL is handed to the peer.

## 4. What "securely" means here

Stated plainly, since `peer: true` on a workflow that AUTHORS is a stronger
statement than on `explore`, which reads.

**Who may launch it.** A holder of the target's `lab:peer` token
(`stakgraph/mcp/src/lab/mount.ts:140-141`): read every route, launch a
`peer: true` workflow, control a run a peer launched; nothing else
(`createStrut.ts:1073-1098`). Hive mints one per other swarm in the org,
for the org strut only, from a cron (`hive/src/app/api/cron/strut-peers`;
`federation.md` §3, built 2026-10-09). So the set of struts that may ask
the target to build is the org's own, and the launch must name a person:
`x-strut-actor`, forwarded as this run's principal, which the target bills
through that person's delegation and binds `secrets` to
(`SecretsCapability.forPrincipal`).

**What cannot ride on the launch.** `params` (an override is how a peer
would hand this agent bash — refused, `createStrut.ts:3008-3010`); the
caller's MCP servers; a local job or session name (`peer/` namespace);
`runId`. The target runs the builder exactly as its seed, with its own
host's delta, published.

**What the builder can do on the target.** Author and run `ai`-stamped
workflows and steps: publish only over names so stamped
(`src/authoring.ts:746-752`), never `sealed: true` or `peer: true`
(`:763-769`), never a closure that reaches a sealed step or workflow
(`src/sealed.ts:36-55`). A custom step is TypeScript loaded into the
target's process with the target's `ctx.services`: `step-lint` refuses
`child_process`, `fs`, `net`, `http`, a `process.env` read and the global
`fetch` (`src/step-lint.ts:26-75`), but `ctx.services.shell` is a sanctioned
subprocess and `ctx.services.secrets.get(NAME)` returns any deployment
secret by name. **This is exactly what the target's own chat builder could
always do**, and what `dispatch_strut` exposed to every Jamie user on the
org's default swarm. The builder is a person-level authoring surface, and
`peer: true` on its seed says, in its header comment: a person the org
strut forwards may author here, as they could in this strut's own UI.
Within the org boundary hive draws when it pushes peers, that is the
intended statement. Dropping bash (§1) does not change it: §9 found every
build reaching a shell through an `exec` check with no step authored, and
`meta/run-workflow` runs any unsealed workflow on the target, `job`
included, with `params`.

**Levers.**

- A deployment that disagrees drops the key: `createStrut({ builder: {
  peer: false } })` / `STRUT_HOST_CONFIG`. The builder then runs locally
  only, and a peer's launch is refused with `notForPeers`.
- A deployment that wants a hand on every publish sets `approve:
  [meta/publish-workflow, meta/create-step, meta/edit-step]` through the
  same delta (`plans/proposals.md`): a call records a proposal and runs
  nothing until a person accepts at `POST /proposals/:id/decide`. On a
  peer run the records are the target's; `run.end` carries them as
  `proposals: [brief]` (`proposals.md` §6), and `strut/run-workflow` can
  fold that list off the tail's `run.end` the way it folds `nodes` — a
  small addition, not in v1's work items unless a host asks (§10).
- `STRUT_SEALED` seals more namespaces on the target; a sealed workflow is
  unreachable from any publish.

What this does NOT do: open `/chat` or `/mcp/builder` to the peer key
(`lab:peer` stays read + launch), put a token in any workflow, or let the
model name a workflow to launch as a job (`workflow` is a closed enum).

## 5. The host — hive

Three things, each small, each needed for cross-strut v1.

1. **Delegations on every swarm in the org.** Every swarm runs with the
   Mothership required, so the builder's first model call on a target
   with no delegation for the forwarded person is refused — the exact
   failure `strut-target.ts:30-40` records for the per-workspace `chat`
   row. `ensureStrutDelegation` (`hive/src/services/bifrost/strut-delegation.ts:387`)
   pushes per target; the gate per workspace slug (`BIFROST_ENABLED`)
   must open for every workspace that has a swarm, or the peers cron
   pushes the delegation beside the peer token. Actor secrets
   (`ensureStrutActorSecrets`, `hive/src/services/strut-actor-secret.ts:92`)
   are not needed for a build; a workflow that needs the person's GitHub
   token at RUN time reads it where that run happens.
2. **Accept `builder` as a job-shaped turn.** The webhook adopts a job the
   orchestrator started only when `payload.workflow === JOB_WORKFLOW`
   (`hive/src/app/api/strut-runs/webhook/route.ts:130`), and
   `adoptOrchestratorJobRun` writes `workflow: JOB_WORKFLOW`
   (`orchestrator-jobs.ts:60-67`). The honest generalization: a `run.end`
   that carries `job` is a job turn whatever its workflow, and the row
   records the workflow the payload names. The job-turn renderer is
   unchanged — the reply shape is the job's.
3. **Resolve a peer-tagged artifact.** A ref `{ path, peer, job }` is a
   file on the swarm hive registered as peer `<slug>`, at
   `/lab/jobs/<job, percent-encoded>/files/<path>` there (`job` is the
   peer's own id for it, `peer/<id>`), read with that swarm's own
   credential through the proxy hive already has per swarm. One branch
   in the artifact reader; hive's run-graph fold already skips
   peer-tagged nodes (`job-turn.ts:541-543`), so the shape is familiar.

Not hive's: which strut a build belongs on. The orchestrator decides from
the person's words and `strut/list-peers`; hive launches the orchestrator
turn as it does today (`hive/src/services/strut-orchestrator.ts:101-107`).

## 6. How it meets the rest of strut

- **The `meta/*` surface and EVOLVE_SPEC §5–§6.** The twins exist for an
  in-run agent that authors (`meta/_shared.ts:1-14`). §5.3 item 2 — "an
  agent with `meta/*` and bash can author a step that reads a rubric"
  (`EVOLVE_SPEC.md:307`) — is about a harness's author beside a producer
  that is graded; the builder has no bash and is no candidate's author.
  The sealed rule holds whatever it has.
- **The chat builder stays.** The UI's flyout, the MCP doors and
  `ask_workflow_builder` are the person-driven and external-agent doors;
  the builder job is the orchestrator's. Both run the same policy
  (`src/authoring.ts`), read the same `Workflow Builder` page and, after
  the prompt factoring, the same rules.
- **Claims.** `meta/add-claim` and the publish tools' `claims` arg are in
  the glob; the builder states what the workflow it built should do and
  the verify pass measures it, as the job agent's prompt teaches.
- **The Concept tree.** `Workflow Builder`'s children stay what they are:
  the kinds a deployment builds. Nothing of strut's dialect is written
  into a page; the dialect is strut's prompt, versioned with strut.
- **Parity with `dispatch_strut`'s builder**, tool by tool:

  | Chat tool | Builder job |
  | --- | --- |
  | list/search/get steps, list/get workflows, validate, create/edit workflow, create/edit step, run_step, run_workflow, list/get/search runs, list_secrets, claims | the `meta/*` twins, by glob |
  | `graph_get` | `graph/graph-get` (+ search, ontology) |
  | `ask_user` | the reply's `ask` — the person's answer is the next turn |
  | `bash` | `meta/run-step` with a cassette; `meta/get-run`; `job/read` |
  | `run_workflow`'s auto-detach + `[run-notification]` | `meta/run-workflow` waits inside the turn as a child run; the job card shows it working |
  | `set_active_version` | **gap** — a `meta/set-active-version` twin over `authoring.setActiveVersion` |
  | `cancel_run` / `pause_run` / `resume_run` | **gap** — twins over `controlRun`; the job's own child runs only |
  | `set_automation` on any workflow | **gap** — `automation/*` is scoped to the host's one workflow by design; a `meta/set-automation` twin over `strut.automations` |
  | `request_secret` | **gap** — the builder says in `ask` which NAME to add under Secrets; no deep link (the elicitation id is the chat's) |
  | `graph_query` | by design a chat tool, not a step |

  Each gap is a thin twin when wanted and lands in the glob.

## 7. Left out

- A code job on a peer (`job/start { workflow: job, peer }`): not needed —
  code is checked out wherever the job runs, and a job reaches another
  workspace through that strut's lookups. `job` would also have to drop its
  host-only inputs (`agent`, `cwd`) before it could say `peer: true`.
- The builder reaching a THIRD strut from inside a build (`strut/*` in its
  tools): the orchestrator chooses the strut before the job starts.
- Read-through of the peer's runs and files from the org strut's own UI
  (`federation.md` §2.1): hive resolves by slug; strut's UI shows the
  handle.
- A `launchedBy` stamp on the target's run naming the caller
  (`federation.md` §2.2, deferred there too).
- Proposals folded off the peer's tail (§4, levers) — unless a host sets
  `approve` on the builder in v1.
- The parity twins in §6 — each its own small change.

## 8. Work items

Strut, in order; each a PR of its own, never stacked.

1. **`src/workflows/builder.yaml` + `src/builder-seed.ts`**, seeded by
   `createStrut` beside `job` and `orchestrator` (`createStrut({ builder })`,
   `STRUT_HOST_CONFIG.builder`, `builder: false`), `peer: true` with the
   header comment that §4 is; the `peer: false` delta. Tests: the seed
   publishes and reactivates like the other two; the YAML's `peer`,
   closure and claims pass `assertValidWorkflowYaml`; `peer: true` is
   refused from the meta surface as it is today.
2. **The prompt factoring** in `src/ai/prompts.ts`: the dialect text, the
   "Tools" section and `BUILDER_PROCEDURE` rendered from a role → name
   map; `buildSystem` output byte-identical to today's (a test pins the
   chat's rendering against a fixture); the seed renders the meta names
   into `params.system`. **BUILT** (`feature/builder-prompt-source`):
   `BuilderTools` is the map, with `chat` for what the chat alone has (the
   steps listing, detach and notifications, `ask_user` / `request_secret`,
   `edits`, bash, graph_query, rollback, run control, schedules, peers);
   `builderRules(t)` is the dialect + tools + procedure. builder.yaml keeps
   the job's own text (who the agent is, claims, the kinds, the reply)
   around one `<<strut: the builder's rules>>` line the seed replaces
   before the delta (`templateWithDelta`'s `fill`). Found on the way: the
   loader resolved a `{{ params.x }}` inside a param to `""` when `x` was
   not declared, so the rules' own examples ("Reference them as
   {{ params.name }}") were blanked — it now leaves them as written.
3. **`job/start { workflow, peer }`**, `job/continue` following the record,
   `JobLaunch.workflow`, the launcher reading that workflow; `GET /jobs/:id`
   says which workflow a job is. The kind as a Concept strut seeds under
   `Job` (`Workflow Build`), the rule on the `workflow` field, one prompt
   sentence (§2, amended). Tests: a builder job launches `builder`;
   continue launches what the last turn was and carries its `peer`; `peer`
   is refused with `workflow: job`; the page seeds under `Job` and the
   orchestrator's kinds list it. **BUILT 2026-10-21.**
4. **Deliverables tagged**: `strut/run-workflow` tags the peer output's
   `artifacts`; `resolveArtifactRefs` leaves a tagged ref alone; the
   `run.end` callback and `GET …/artifacts` carry it; `specs/CALLBACKS.md`
   §4 documents `peer` on a ref. Tests over both. **BUILT 2026-10-21.**
5. **Live over two struts** (§9) before the mcp bump that carries 1–4.
   **VALIDATED 2026-10-21** — §9 "What the run showed" has the run, what
   matched, the three fixes (`peerScoped`, the job-threads fold, seeds
   that always match git) and what is left open.

Hive, as the contract it reads (§5): delegations on every org swarm; a
`run.end` with `job` adopted whatever its workflow; a peer-tagged artifact
resolved by slug.

## 9. Validation

- Two struts in one compose (the standalone image twice, the second with
  `STRUT_PEER_KEY` and a `Workflow Builder` page of its own), the first
  holding the second as a peer in `STRUT_PEERS`. A `POST
  /workflows/orchestrator/run` on the first whose prompt asks for a
  workflow on `@second`: the orchestrator calls `job/start { workflow:
  builder, peer: second }`; the first's run log shows the `#launch`
  record and a `step.end` with peer-tagged `nodes`; the second holds a
  job `peer/<id>`, a session of that name, and an `ai`-stamped workflow
  that was not there before; the first's `run.end` carries `artifacts`
  tagged `peer: second`; `GET /jobs/<id>` on the first lists the run with
  `workflow: builder`.
- Kill the first mid-build: its auto-resume reattaches (one run on the
  second, not two). Cancel the first's run: the second's run ends
  `cancelled`.
- The second with `builder: { peer: false }`: the launch fails the step
  with `notForPeers`' message, nothing published.
- The same ask with no `peer`: the build happens on the first, the job's
  directory holds nothing but the record, the chat builder's UI lists the
  new workflow with `publisher: ai`.
- `npm test`: the seed tests, the prompt fixture, the `job/start` enum,
  the artifact tagging; the route sweep unchanged (no new route).

### What the run showed (2026-10-21)

**Setup.** Two `node build/server.js` processes of this checkout (strut
`main` @e47a098, then the branch's two fixes), not the compose image
twice: the same code without a Docker build. A on :3201 held B as peer
`second` through `STRUT_PEERS`; B on :3202 had `STRUT_PEER_KEY`. Each had
its own data dir and `STRUT_API_KEY`, ran on the Ladybug backend
(`STRUT_GRAPH_EMBEDDINGS=off`) with the Anthropic key in env, and had no
Mothership. B's `Workflow Builder` page was seeded at boot, and a
`Greeting Workflow` kind was added under it (`graph/create-triplet`; the
convention: name `greet-<audience>`, one `log` step `say`, a `greeting`
knob, category `demo`). A had no such kind. A listener on :3299 took the
callbacks.

**What matched.**

- **Routing.** `POST /workflows/orchestrator/run` on A with "On @second,
  build me a small workflow that greets a person by name…" made one tool
  call, `job_start { workflow: builder, peer: second, title }` (6 s, $0.05).
  The same ask without `@second`, in a new conversation, made
  `job_start { workflow: builder }` with no `peer`.
- **A's builder run.** `remote` journaled `builder/remote#launch` (`{ peer,
  workflow, runId, launchedAt }`) before it waited. Its `step.end` carried
  `nodes` tagged `peer: "second"`: B's `Workflow Builder` and `Greeting
  Workflow` pages. The builder opened the kind's page, followed it, and said
  so in its reply.
- **B.** `run.start` recorded `job: peer/<id>`, `origin: peer`, and
  `actor` / `principal` set to the forwarded `x-strut-actor`. B held a job
  `peer/<id>` with `workflow: builder` and both its runs: the builder's,
  and the `greet-person` test run it launched. `greet-person` v1 was
  stamped `publisher: ai` in category `demo`, with a claim the builder
  added and verified `supported`. A peer launch of `job` was 403 (`not
  open to peers`).
- **A's `run.end` callback.** It carried `workflow: "builder"`, the `job`
  and `output.peer: "second"`. Turn 2 also carried `artifacts: [{ id:
  readme, kind: markdown, path: README.md, peer: second, job: peer/<id> }]`
  (the builder wrote the file with the editor). `GET
  …/runs/:runId/artifacts` and `GET /jobs/<id>`'s fold carried the same
  entry. On B the file reads at `/jobs/peer%2F<id>/files/README.md` with
  B's key and with its peer key: the path hive#5583 resolves.
- **`GET /jobs/<id>` on A.** `workflow: builder`, both runs `builder`.
- **Turn 2, through the orchestrator** in the same conversation session.
  The call was `job_continue { job, prompt }`, naming only the job. A's
  launch carried `input.peer: second` from the record. B's builder went on
  in the same thread: it edited, by id, the check it had made in turn 1.
- **Kill.** A was SIGKILLed while B's builder was three tool calls in. At
  A's next boot: `[auto-resume] builder/<run>: resumed — replaying 4
  journaled step(s)`. `remote` ran again without a second `#launch` and
  reattached. B had ONE builder run for the job, and the callback posted
  once, after the resume. Ladybug rebuilt its full-text index at that boot,
  as designed.
- **Cancel.** `POST …/cancel` on A mid-build. B's run logged
  `run.cancelling` in the same second and `run.cancelled` 2 s later; A's
  run and its callback both said `cancelled`.
- **`peer: false`.** B was restarted with
  `STRUT_HOST_CONFIG={"builder":{"peer":false}}`. A's `remote` failed with
  `peer "second" refused POST /workflows/builder/run (403): forbidden:
  workflow "builder" is not open to peers…`, and nothing was published or
  recorded on B.
- **Local.** With no `peer`, the build ran on A. The job's directory was
  empty beside its record, the session was the plain job id, and
  `greet-person` was stamped `ai`, with no category: A has no greeting kind.

**Fixed on the branch** (each its own commit, with its test):

1. **B's thread was `peer/peer/<id>`**, not the `peer/<id>` §1 names.
   `peerLaunchBody` namespaces the job, then `bindPeer` prefixed every
   session id again, and the builder's session IS `$job`. `peerScoped()`
   (`src/session-store.ts`) leaves an id already under `peer/` as it is;
   the runner and the projector both use it. No deployed strut has a peer
   builder job yet (stakgraph#1805 is still open), so no thread is orphaned.
2. **A's job view split a peer build into phantom threads.** Each turn
   showed the skipped local `build` agent as a turn of status `error`, and
   each turn's `remote` as a thread of its own, so one conversation on B
   read as two one-turn threads beside two failures. A path with only
   `step.skipped` is no turn now (`src/job-threads.ts`). A peer turn joins
   the thread of the session its output names (`@second/peer/<id>`) and is
   numbered by that session's turn.

   After both fixes, a re-run gave B the thread `peer/fixcheck-1` with 2
   turns, and A one thread `@second/peer/fixcheck-1` with turns 0 and 1.
3. **A reverted delta was never applied (every seed).** After the `peer:
   false` boot, B was restarted with its normal config and seeded
   nothing: v1's content was known, and every seeder passed
   `reactivateKnown: false`, which leaves the active version alone. So v2
   (`peer: false`) stayed active, and the peer launch stayed 403 until
   `PUT /workflows/builder/active { version: v1 }`. Ruled 2026-10-21: **a
   seed always matches git.** Every boot now makes the committed template
   (with the host's delta) the active version: `job`, `orchestrator`,
   `builder`, the browser workflows, the system workflows (`tidy-memory`;
   its automation's on/off and trigger stay the person's) and the
   `strut/views` app. A text seen before is made active again, nothing new
   is published, and an edit made since (the UI, the chat builder, a
   promotion) stays in the history, active until the next boot. The store
   keeps `reactivateKnown: false` for callers that want an edit kept. The
   Concept pages strut seeds follow the same rule (ruled the same day): a
   page's description or docs edited in the graph is put back to the
   file's text at the next boot. A page a person made under the same name,
   or took over by clearing its stamp, is still theirs.

**Found, not fixed.**

- **"No bash" is not a boundary in practice.** All six builds that
  published wrote their claim's check as an `exec` running `sh -c`,
  `bash` or `node -e`. One build also published an `exec` step (`tr a-z
  A-Z`) after the expression language refused `toUpperCase()`. §4 already
  says authoring is code execution. The run adds that this takes no step
  authoring and that no lint applies: a check's config or a workflow's YAML
  is enough. This is evidence for §10 question 1.
- **The prompt does not say strings have no methods.** The dialect text
  lists the array whitelist only. One build spent three failing test runs
  on `toUpperCase()`, and another gave up on counting words. One line in
  `src/ai/prompts.ts` would cover it.
- **A peer build's spend is not on the org strut's summary.** A's builder
  run has no `totals`; the peer's cost is only in `output.cost` (§10
  question 5). Separately, and not the builder's alone: a CANCELLED agent
  step reports no usage. B's cancelled turn made two model calls and its
  summary shows none.
- **`concepts` reads the org strut's page on the remote branch too.** The
  text is unused, and A's `Workflow Builder` is recorded as touched by a
  run that built elsewhere. Moving the step under `here` would avoid that;
  job.yaml's order was kept on purpose, so it is left as is.

**Cost.** About $1.53 of Anthropic spend (claude-sonnet-5-5): seven
builder turns on B, $1.08; the local build on A, $0.32; three orchestrator
turns, $0.08; and the cancelled turn, which recorded nothing (about $0.05
by its two calls). A peer build turn took about 20 s end to end.

**Not covered.** mcp's `/lab` host (the `lab:peer` JWT through
`resolveScope`, the `/lab` base URL), the Mothership (no delegation for
the forwarded person on the target: §5 item 1's first-use window), hive
(hive#5583's webhook and peer-artifact reader), the Neo4j backend and the
compose image.

**stakgraph#1805.** As far as strut goes, it is safe to merge for
cross-strut building. Every row above held on code that contains its pin
(d7d3670): the first turns ran before any fix. The first two only rename
a thread and tidy a view. One caution there: the first fix renames the
peer's thread, so if a peer build could start between #1805 and a bump
past this branch, that job's next turn after the bump begins a cold
thread on the peer (its files are kept). Re-pinning #1805 to this
branch's merge before it ships avoids that. The third changes what a
boot does: on the first boot past this branch, a strut-seeded workflow
someone edited on a swarm (`job`, `orchestrator`, `builder`, the browser
and system workflows) goes back to git's version, the edit kept in its
history. The lab's own seeders (`SEED_OPTS` in
`stakgraph/mcp/src/lab/seed-opts.ts`) still pass `reactivateKnown: false`
and keep edits until mcp makes the same change. The lab-specific doors
above are #1805's own to test.

## 10. Open questions (OPEN)

1. **Bash on the builder.** §1 drops it for parity with `explore`'s rule
   and because authoring is code execution regardless. The chat keeps
   bash. If probing through `meta/run-step` proves too slow for the model
   in practice, the alternative is `builtins` in the host delta — a
   deployment that trusts its org adds `bash` back — with the seed's
   default still off. Needs the owner's call once the builder has run.
2. **`workflow` as an enum vs a YAML flag.** The enum is the smallest
   gate and strut ships both members. A host kind of job later (Peel's)
   would want `job: true` at the top of a YAML, the `peer:` /
   `sealed:` shape, published by a person. Not needed until a host asks.
3. **Where the person's answer to a peer builder's `ask` lands.** §3
   routes it through `job/continue` on the org strut, so the orchestrator
   mediates; the alternative (hive continuing the target's job directly)
   would need hive to hold a row on the target. The first keeps hive's
   contract closed; is the extra hop acceptable?
4. **Proposals across the tail.** With `approve` set on a target's
   builder, the person deciding is on hive and the record is on the
   target. Folding `proposals` off the tail's `run.end` is small; hive
   deciding against the target's `/proposals/:id/decide` with that
   swarm's key is the other half. Which host wants this first?
5. **Billing the tail.** The org strut's `builder` run is a wait with no
   model call; its `cost` is the peer's, carried in the output. Does the
   Mothership want the org strut's run to report the forwarded cost on
   its own summary, or is the peer's record enough?
