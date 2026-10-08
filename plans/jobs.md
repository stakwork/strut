# Jobs — a host hands strut work; strut hands back artifacts

> **Status (2026-09-30): V1's strut half built** (§11 item 1, on this
> branch: the stamp, `jobs/` + `job/dir`, `/jobs/:id/files`, `artifacts[]`
> in the callback; `src/jobs.test.ts`). The mcp seed and hive's side are
> next. Decided with the owner in
> one sitting; the two rulings that shape everything are in §2 (the job
> agent is a WORKFLOW, and the host's side is a closed contract — the
> workflow evolves, the host does not). **Built in slices** (§11): V1 is
> the smallest thing that round-trips — a host launches `job`, a
> session-carrying agent writes `plan.md` or a page into the job
> directory, the callback hands back links, the host renders them. No
> repositories, pods, authoring or running other workflows in it; each of
> those is a later tool in `params.tools`, which is the point. The rest
> of this document is the whole shape so the slices land in one place.
> **Update (2026-10-06):** a job runs other workflows through
> `meta/run-workflow`, which stamps the child with the job and lets it share
> the job directory (§4, §2) — the separate `strut/run-workflow` and
> `LaunchCapability` an earlier draft of §4 had are not needed.
> **Update (2026-10-07):** §6 built — `ctx.services.jobs` (hold / release /
> holds on the job record), the sweep releasing holds before it removes
> repositories, `DELETE /jobs/:id` (`deleteJob`); `src/jobs.test.ts`.
> **Update (2026-10-08):** what happens to a held pod when its pull request
> merges, and how failing checks reach the job, is `job-artifact-events.md`
> — an event about an artifact a job reported is a turn on that job, one
> door for every kind; strut unchanged.
> Current behaviour was re-read on
> this checkout (`fe24cb6`, main), `hive@b210ddab6` (master, the merge of
> [stakwork/hive#5375](https://github.com/stakwork/hive/pull/5375)) and the
> swarm38 lab (`task-to-workflow` v2, the `hive/*` pod steps). Companions
> this stands on and does not reopen: `agent-sessions.md` (the thread and
> the kept working copy — the job directory is its generalization),
> `code-change.md` (actor secrets, run callbacks, `ctx.onRunEnd`, hive's
> `StrutRun` rows), `repo-agent.md` §4 (the agent-step gaps a long job
> makes visible), `agentic-loop-as-workflow.md` §5 (the harness / policy
> split this is an instance of), `federation.md` §2.2 (a `strut/run-workflow`
> is named there for dispatch-through to a PEER, later; the local half is
> `meta/run-workflow`, §4).

## Problem

Hive's Jamie chat can dispatch strut today in exactly one way: a builder
chat (`dispatch_strut`, `hive/src/lib/ai/strutTools.ts`), whose replies come
back as prose (`turn.end.text`). It builds workflows well. It is the wrong
shape for the rest of what Jamie wants done — plan this, explain that, make
this change, stand it up in a pod and let me click around — because:

- **Nothing persists across turns except a transcript.** A plan revised
  twenty times is twenty replies, not one file. Run artifacts are keyed by
  `runId` (`capabilities.ts` `artifactPath`, `GET /artifacts/:runId`), so a
  run cannot see what the previous turn wrote; the builder's shell works in
  one shared, unscoped `scratch/`.
- **The result is text.** Hive just grew a place to show what an agent
  hands the reader to LOOK at — `message.artifacts: ArtifactRef[]`
  (`hive/src/app/org/[githubLogin]/_state/canvasChatArtifacts.ts`: `id`,
  `kind`, `title`, `label?`, `summary?`, `source`) with a card, a panel and
  versions — but nothing writes refs and nothing reads a `graph` pointer.
  A strut turn has no way to say "here is the plan, here is the pod".
- **A chat is not a run.** It has no claims, no `params`, no schedule, no
  place on the canvas, and cannot be swept for a better prompt or a better
  tool. The other dev's prototype on swarm38 (`task-to-workflow`) put the
  agent in a workflow — right instinct — but gave it only `meta/*`, whose
  ownership rule (`authoring.ts` `notOwned`) refuses to run anything not
  stamped `publisher: "ai"`. So for a one-line colour change it authored a
  wrapper around the seeded `code-change-propose`, debugged the wrapper by
  publishing eleven `t2w-scratch-*` workflows into the shared workspace,
  and took 22 minutes. No session, so every goal starts cold; a JSON schema
  blob for a result, not artifacts.

What is wanted: one handle — a **job** — under which any number of runs,
of any workflow, by any agent, over days, share a directory and a memory;
a way for a run to say what it produced so the host can render it; and a
job agent whose tools and prompt improve on the swarm without a host
release.

## Decided

| Question | Decision |
| --- | --- |
| The job agent | **A seeded WORKFLOW, `job`** — an `agent` step with `session`, its tools granted through `agentTools`, its prompt in `params`. Not the builder chat, which stays the human authoring surface (and gains the same `job` stamp, §7). A run is what strut records, verifies, bills, schedules and evolves; a chat is none of those |
| What evolves, and where | **The workflow's `params` (`system`, `model`, `tools`) and the steps it can grant** — new versions published on the swarm. **The host's contract is closed** (§8): start / continue a job, one `StrutRun` kind, one artifact reader. A capability the agent needs is a STEP, never a host feature. "No more PRs to hive" |
| The handle | **A flat, global string the CALLER mints**, the session rule (`idProblem`, `session-store.ts`): no hierarchy, no chain of runs. Passed on the LAUNCH (`POST …/run { job }`, `POST /chat { job }`), beside `input` / `params` / `callback` — where a run belongs is not part of its subject |
| The directory | **`<dataDir>/jobs/<job>/`, the generalization of `workdir`**: the same lock, manifest and idle sweep (`git/_shared.ts`), with one change — the sweep removes the REPOSITORIES in an idle job and keeps its FILES. The agent's `cwd`; `plan.md` lives there for the life of the job |
| Per-run artifacts | **Unchanged.** `artifacts/<runId>/` stays the immutable record of what a run produced, for every workflow. The job directory is for what a job MAINTAINS |
| Deliverables | **Declared in the run's OUTPUT**, `artifacts: [{ id, kind?, title, path \| url \| content }]`, resolved to links in the `run.end` callback the way `transcripts` are (`createStrut.ts` `postRunCallback`). The host stores refs, reads bytes from strut when someone looks |
| Versions of one file | **The live file.** Twenty turns editing `plan.md` are twenty refs with the same `id` pointing at one path; a card shows what is there now. Distinct things get distinct names. History of one file, if ever wanted, is git in the job dir (§10), not snapshots |
| Running other workflows | **`meta/run-workflow`**, which runs ANY unsealed workflow as its own run under the parent's controller, stamped with the job (§4). One step: since what the meta surface may run is decided by sealing, not by publisher, there is no reason for a second |
| Resources that outlive a run | **The agent claims them, through tools** (a pod: `hive/claim-pod`), and the job REMEMBERS them: a hold in the job manifest with a release action strut runs when the job is closed or swept (§6). Never claimed by the host on the agent's behalf |
| Asking the user | **In the output** (`ask`), the run ends `success`; the answer is the next turn. Nothing parks (the sessions rule) |
| One turn at a time | **Per job**, the workdir rule: a second top-level run of a job while one holds the directory fails `job_busy:`. Child runs the turn launches share it |

## Design in one paragraph

A caller mints an id and launches a workflow with it: `POST
/workflows/job/run { job, input: { prompt }, callback }`. The id is recorded
on the run (`run.start`, the summary), reaches every step as `ctx.job` and
templates as `{{ $job }}`, and rides to every child run the turn launches.
`job/dir` returns `<dataDir>/jobs/<job>/` — created on first use, held by
this run until it ends — and the agent works there with `session: "{{ $job
}}"`, so turn twelve opens the file turn three wrote with a transcript that
remembers writing it. Repositories are checked out INTO the job directory
(`git/checkout` with `workdir: "{{ $job }}"`, unchanged) and swept when the
job goes idle; everything else in it is kept. The turn ends with an output
that names what it produced — a path in the job directory, a URL (a pod, a
pull request), or a small inline value — and strut's callback resolves each
to a link on this server. A pod the agent claimed is a hold on the job: the
manifest records how to let it go, and strut lets it go when the job is
deleted or has sat idle past the TTL. The host's whole side is: mint an id,
launch a turn, store the refs the callback carries, proxy a link when a
person opens one.

```yaml
name: job
input:
  prompt: { type: string }
  repos:  { type: json, required: false, description: "repository URLs to check out into the job" }
steps:
  - id: dir
    type: job/dir                          # <dataDir>/jobs/<job>/ — held by this run
  - id: checkouts
    type: foreach
    config:
      items: "{{ input.repos || [] }}"
      body:
        type: git/checkout
        config: { repo: "{{ item }}", workdir: "{{ $job }}" }   # lands INSIDE the job dir
  - id: work
    type: agent
    config:
      cwd: "{{ dir.path }}"
      session: "{{ $job }}"
      cacheTtl: 1h
      model: "{{ params.model }}"
      system: "{{ params.system }}"
      prompt: "{{ input.prompt }}"
      agentTools: "{{ params.tools }}"
      schema: { …: "{ text, artifacts: [{ id, kind?, title, path? | url? | content? }], ask? }" }
  - id: result
    type: pack
    config:
      text: "{{ work.object.text }}"
      artifacts: "{{ work.object.artifacts }}"
      ask: "{{ work.object.ask }}"
      cost: "{{ work.cost }}"
params:
  model: claude-sonnet-5
  tools:                                   # THE evolvable surface
    - meta/*                               # meta/run-workflow: run any unsealed workflow under this job
    - graph/graph-search
    - graph/graph-get
    - graph/graph-neighbors
    - hive/*                               # pods: claim, agent, push, release
    - browser/*
  system: |
    …read the Concept tree for this kind of goal first; prefer an existing
    workflow (meta/run-workflow) over authoring one; …
```

```bash
# turn 0, then a follow-up a week later: the same call, the same job
curl -X POST $STRUT/workflows/job/run -d \
  '{ "job": "6f1c…", "input": { "prompt": "Plan the auth rewrite", "repos": ["https://github.com/stakwork/hive"] }, "callback": { "url": "…" } }'
curl -X POST $STRUT/workflows/job/run -d \
  '{ "job": "6f1c…", "input": { "prompt": "Split step 3 in two." }, "callback": { "url": "…" } }'
```

The callback for each carries `artifacts: [{ id: "plan", kind: "markdown",
title: "Plan", url: "/jobs/6f1c…/files/plan.md" }]` — the same `id`, the
same `url`, a newer file.

## 1. The `job` stamp

`job?: string` on `RunBody` (`createStrut.ts`) and on `POST /chat`. Checked
with `idProblem` (400 otherwise — the same format as session ids and workdir
names, for the same reason: a multi-segment template renders a missing value
as `""`). Absent → nothing changes anywhere.

Where it goes, all optional, all absent when the launch had none:

| | |
| --- | --- |
| `RunOptions.job` → `run.start.job`, `RunSummary.job` | the record; a resume reads it back like `principal` |
| `ctx.job` | steps: `job/dir`, `git/checkout`, `hive/claim-pod` read it |
| `{{ $job }}` | templates, beside `$runId`: `session: "{{ $job }}"`, `workdir: "{{ $job }}"` |
| `ChatMeta.job` | the builder chat (§7) |
| `meta/run-workflow` (built, §4); the chat's `run_workflow` (with §7) | pass the launching run's / chat's job to the child, like `parentRunId` and `actor` |
| the projector | a `job` attribute on `StrutRun`, `StrutChat`, `StrutAgentSession` (schema entries + conformance cases, the convention in AGENTS.md) — "everything in job X" is one query, no new node type, the `session_id` precedent |

**The index.** `GET /jobs/:id` → `{ job, runs: [{ workflow, runId, status,
startedAt }], chats: [id…], sessions: [id…], files: [path…], holds: […]
}`. Runs come from the job manifest (§2): the launcher appends one line
per launch, so the file store — which only lists runs per workflow — needs
no scan. Chats: `ChatStore.list()` filtered on `meta.job`. Sessions:
`SessionStore.list()` filtered on `id === job || id.startsWith(job + "/")`.
`GET /jobs` lists manifests. `DELETE /jobs/:id` releases every hold, removes
the directory and manifest (409 while a run holds it); runs, chats and
sessions are not touched — they are records, and each has its own delete.

## 2. The job directory

`<dataDir>/jobs/<encodeId(job)>/` with its manifest BESIDE it,
`<encodeId(job)>.json`, outside the agent's reach — exactly `workdirs/` in
`git/_shared.ts` (`workdirRoot`, `touchWorkdir`, `holdWorkdir`,
`sweepWorkdirs`), moved and widened. `workdirs/` becomes `jobs/`; the
`workdir` input on `git/checkout` keeps its name and semantics (a checkout
into the job dir at `<jobdir>/<repo name>`, one run at a time, `reused`
on the second run) — its value is now documented as "the job's directory,
usually `{{ $job }}`". A `workdir` that is not a job (a literal name, as
before) is simply a job nobody launched a run under: same directory, same
sweep. Nothing about sessions changes: a job and a session with the same
string are unrelated stores that happen to be named alike, by design.

```
<dataDir>/jobs/
  6f1c….json            { name, usedAt, repos: { "<abs dir>": { cache, ref } }, runs: [...], holds: [...] }
  6f1c…/
    plan.md               kept
    shots/turn-7.png      kept
    hive/                 a worktree of the credential-free cache — swept when idle
```

**`job/dir`**, a core step: `{}` → `{ path, job, created }`. Requires a job
on the run (a plain run has no job directory: use `artifacts/dir`). Creates
the directory, stamps `usedAt`, takes the hold for this run (`job_busy:`
when another run has it — the `holdWorkdir` rule, released by
`ctx.onRunEnd`), runs the sweep (§2.1). `git/checkout { workdir }` takes the
same hold, so a job workflow may call either first.

**Held by the turn, shared by its children.** The hold is per top-level
run. A child the turn launches through `meta/run-workflow` carries the job
stamp, and because its controller descends from the holder's
(`trackRun(…, parentRunId)`, RUN_CONTROL_SPEC §2.2), its `job/dir` — or
`git/checkout { workdir: "{{ $job }}" }` — is the SAME directory, not
`job_busy:` (`holdJob` walks `ctx.control`'s parent chain with
`isAncestorRun`; the child registers no release of its own, the holder's
stands). The child is the turn, so "one turn at a time" is still one rule
with no exceptions: an unrelated run of the job, with no controller or
with one outside the holder's tree, is refused as before. A child that
would rather keep its output apart writes its own `artifacts/<childRunId>/`
as any run does.

### 2.1 Sweep

`sweepWorkdirs` becomes `sweepJobs`, run by every `job/dir` and kept
checkout as today, and by `DELETE /jobs/:id`. For a job idle longer than
`STRUT_WORKDIR_TTL_DAYS` (kept: default 7, `0` never) and not held:

1. every hold's release action is run (§6) and the hold dropped;
2. every repository in `repos` is removed (`git worktree remove` in its
   cache, `prune`), as today;
3. the FILES stay, the manifest stays. A job directory is removed only by
   `DELETE /jobs/:id`.

A run that comes back to a swept job finds its plan and no repositories;
`git/checkout` recreates them (`reused: false`), and the session remembers
the edits that are gone — the workflow says so in the prompt
(`{{ checkouts.results[0].reused }}`), as agent-sessions §5 already
advises.

### 2.2 Serving

`GET /jobs/:id/files` → `{ job, files: [relative paths] }`, recursive,
skipping the repositories in the manifest (a checkout is not a deliverable
and can be enormous). `GET /jobs/:id/files/<path>` serves any path under
the directory — a screenshot the agent saved inside a repo dir included —
with `artifactHeaders` (`Content-Security-Policy: sandbox`,
`X-Content-Type-Options: nosniff`; the video/audio exemption): an HTML page
an agent wrote is a static page here as it is under `/artifacts`. Same
path guard as `artifactPath` (no `..`, no escape). Behind the key like
every route; the UI's links carry it as `?key=`.

## 3. Deliverables — `artifacts[]` in the output

Any workflow's output may carry `artifacts`. Strut reads it in
`postRunCallback` (beside `transcripts`) and puts the resolved list on the
`run.end` payload as a top-level `artifacts`, leaving `output` as the
workflow packed it.

```ts
interface ArtifactEntry {
  id: string;            // stable across turns: the same id later = a newer version of the same thing
  kind?: string;         // the host's renderer vocabulary, passed through; inferred from the extension for `path`
  title: string;
  label?: string;        // "Plan", "Screenshot", "Pod" — what it is to the reader
  summary?: string;
  path?: string;         // relative to the job dir (a plain run: its artifact dir) → resolved to a url
  url?: string;          // absolute (a pod, a PR), or strut-relative starting with "/" (`/artifacts/<childRunId>/clip.mp4`)
  content?: unknown;     // inline: a diff, a JSON value, short markdown — capped at 50 KB
}
```

At least one of `path` / `url` / `content` — not exclusive: a `content`
rides along a `path` or `url`, and a `path` takes a `url`'s place (strut
holds the file). The first `job` run that opened a PR (2026-10-07) named it
by link AND fields and lost the card to an "exactly one" rule. Resolution:

| entry | the callback carries |
| --- | --- |
| `path: "plan.md"` on a job run | `url: "/jobs/<job>/files/plan.md"` |
| `path: "clip.mp4"` on a run with no job | `url: "/artifacts/<runId>/clip.mp4"` — so the contract works for every workflow, not only `job` |
| `path` that does not exist | the entry with `error: "not found"` and no `url`; the run is not failed for it (the host shows "unavailable"; `GET /jobs/:id/files` has the truth) |
| `url` | as given |
| `content` | as given (capped; over the cap → `error: "too large"`) |
| no `kind` and a `path`/`url` with an extension | `kind` from the extension (`artifactKind`, `src/artifact-refs.ts` — the host's names; the UI's own table in `web/src/artifact-view.ts` is about what ITS viewer renders and stays separate); `url` otherwise |

The vocabulary is the host's (`markdown | html | image | video | audio | pdf
| url | diff | pull_request | code | log | json` today); strut checks
nothing about `kind` beyond "a short string". The run summary is untouched;
`GET /workflows/:name/runs/:runId/artifacts` returns the same resolved list
for a host that missed the callback (the `GET /chat/:id` fallback's twin).

**What the job agent does.** Writes files where it likes under `cwd`, and
lists what matters in its structured output. The `hive/*` pod tools return
URLs; a child run's output names its files under `/artifacts/<childRunId>/`
(the builder's convention, `prompts.ts`); a `git/diff` result is inline
`content`. Everything the turn hands the human is one list, whatever
produced it.

## 4. Running other workflows — `meta/run-workflow`

A job launches other workflows through the step that already exists.
`meta/run-workflow` (`src/steps/lib/meta/run-workflow.ts`): `{ name,
input?, params?, version? }` → `{ runId, status, output?, error? }`, thin
plumbing over `AuthoringCapability.runWorkflow` (`src/authoring.ts`). The
child is its OWN persisted run (inspect it with `meta/get-run`), attached
under this run's controller (`parentRunId`, so cancel and pause reach it),
billed to this run's principal, and **stamped with this run's job**:
`ctx.job` rides as `opts.job` into `RunOptions.job`, so the child's
`run.start` and summary record it, its `{{ $job }}` resolves to it, and its
`job/dir` or `git/checkout { workdir: "{{ $job }}" }` is the directory this
run holds — shared, not `job_busy:` (§2). Awaited: a turn that launched a
two-hour child is a two-hour turn, which is what a run is for. Any workflow
but a sealed one: seeded, ai-published, the one it is running in (a job can
launch a job).

An earlier draft of this section had a separate `strut/run-workflow` over
a `LaunchCapability` on the services bag, because `meta/run-workflow` then
refused anything not stamped `publisher: "ai"`. The sealed-meta change
(`src/sealed.ts`: what the meta surface may RUN is decided by sealing, not
by who published) removed the only reason for a second step — it runs a
seeded `pod-pr` as readily as a candidate — so there is one, and the
chat's `run_workflow` keeps its own door (`AiDeps`). Federation's
dispatch-through to a peer stays a later, separate thing (`federation.md`
§2.2).

## 5. The `job` workflow

Seeded YAML in the mcp lab (`mcp/src/lab/job/`), category `job`, publisher
`job-seed`, `reactivateKnown: false` like every seed — a version published
on the swarm survives the next boot. The shape is the one above. Its
`params` are the policy:

- `system` — the prototype's good parts: read the Concept tree for the
  goal's kind before choosing anything (the `Workflow Builder` concept and
  its children name which workflow runs what; `Pod Decision` says when a
  sandbox is warranted); prefer `meta/run-workflow` on an existing workflow
  over authoring; author only when nothing fits, and test candidates with
  `meta/run-step` and cassettes, never by publishing scratch workflows;
  name deliverables stably (`plan`, not `plan-v3`); end with `ask` when a
  decision is the human's.
- `tools` — the grant list. Adding a capability to jobs is a new step on the
  swarm (published through the builder, or by the job agent with
  `meta/create-step`) and a line here.
- `model`, `maxSteps`.

**Self-improvement.** The seeded `job` is not `ai`-stamped, so the meta
surface cannot rewrite it in place (`notOwned`) — right: a job must not
change the workflow it is running in mid-flight. The loop is the one
EVOLVE_SPEC already defines: candidates (`job-candidate-*`) authored by an
evolve harness or the builder, measured on the job's claims, promoted by
publishing a new version of `job` (the builder, the UI, or a `meta/*`
harness that owns a copy). The claims on `job` are the yardstick: every
declared `path` resolves; no `password`/`token`-named key in the output;
`text` is non-empty; a turn with `repos` checked out reports `reused`
honestly.

**Pods** (`hive/claim-pod`, `hive/pod-latest`, `hive/pod-agent`,
`hive/pod-branch-diff`, `hive/pod-push`, `hive/release-pod` — custom steps
on swarm38 today, to move into the lab's seed). In the job model the pod
is where the repositories and the dependency tree live for a task too big
for an isolated checkout; the worker is `hive/pod-agent` (goose in the pod,
staklink's own `session: "{{ $job }}"` so it remembers as well, billed
through `llmAuth` as tom wired it); the pod's `frontend` and `ide` are `url`
artifacts — the iframe the person reviews the site in between turns. Two
things change for them: the claim registers a hold (§6), and the password
stops appearing in step outputs.

## 6. Holds — what a job keeps alive

A resource a tool claims that must outlive the run — a pod, later a browser
or a VM — is a **hold** on the job:

```ts
// ctx.services.jobs (JobsCapability), present on the standard bag
hold(job, { id, kind, since?, release: { type: string; input: unknown }, note?: string }): Promise<void>;
release(job, id): Promise<void>;            // the tool that let it go says so
holds(job): Promise<Hold[]>;
```

Recorded in the manifest (§2). `release` names a registry STEP and its
input — `{ type: "hive/release-pod", input: { workspaceId, podId } }` —
which strut runs — a bare type, its active version, under a minimal
context (the standard bag, the registry, the job; no run) — when the job is
deleted or swept (§2.1):
each guarded and logged, a failure leaves the hold for the next sweep.
Strut knows nothing about pods; it knows a hold has a way to be released.

`hive/claim-pod` registers the hold when the run has a job (and does not
when it has none — a plain workflow releases its own pod, `pod-pr` style);
`hive/release-pod` clears it. The agent releases when the Concept says the
job is done; the sweep is the safety net for a job nobody came back to.

**Credentials.** `hive/claim-pod` returns `password` in its output today,
and the `hive-claim-pod` workflow packs it into its result — so it sits in
the run log, the summary and the callback. In the job model the tool result
is also in the session transcript. The rule is the `git/*` steps': a
credential never rides in a step's config or output as a value. What rides
is tom's sealed handle (`hive/pod-claim-sealed` → `sealed`, ciphertext
`hive/pod-call` opens), or, cleaner, a job-scoped secret a step may write
(§10). The claim step's plain `password` output goes either way.

## 7. The builder chat is a driver too

`POST /chat { job }` stores `ChatMeta.job`. With it: the builder's `bash`
runs with `cwd` at the job directory (`AiDeps.shell.cwd`, per chat instead
of the deployment's `dataDir` — which also ends the shared `scratch/`), and
its `run_workflow` stamps the runs it launches. A person in the strut UI
and the job workflow are then two drivers over one job: the same files, the
same index. `dispatch_strut` keeps working unchanged for "build me a
workflow"; a host that passes `job` gets the chat's runs and files under
the job. The chat's own system prompt does not change — it is still the
builder.

## 8. The host's side — closed

Hive, in one PR, on tom's refs:

| | |
| --- | --- |
| `start_job({ workspace, title, prompt, repos? })` | mints the id (the sessions rule: the caller's), pushes the actor's secrets as for `code_change`, launches `job` as a `StrutRun` with `kind: "job_turn"` and the id on the row, returns it |
| `continue_job({ jobId, prompt })` | the same launch with the same id; `job_busy:` in the error is "a turn is still running", not a failure |
| the `job_turn` handler | appends the assistant row: `text`, and `artifacts` mapped to `ArtifactRef`s — `path`/strut-relative `url` → `source: { type: "graph", swarmId, key: <the url> }` (rename `graph` to `swarm` or not; the shape fits), absolute `url` → `inline { url }`, `content` → `inline`; `ask` rendered as a question |
| the reader | one route: checks the ref against hive's rows, `GET {lab}<key>` with the swarm key, streams the body with strut's headers preserved. The one thing `useArtifactContent.ts` says is missing |
| Stop | `cancelStrutRun`, as today |

Nothing else. No pod claims, no handshake, no capability-specific fields.
When jobs learn to do something new, hive's side does not change — that is
the point.

## 9. How it meets the rest of strut

| | |
| --- | --- |
| Cancel | The turn's run is cancelled; `meta/run-workflow` children with it (`parentRunId`). The hold is released with the run's `onRunEnd`; the job's holds (pods) stay — a cancelled turn is not a closed job |
| Durable resume | `run.start.job` is read back; `job/dir` re-takes the hold (the run is the same). A journaled session step replays, as agent-sessions §7 |
| A crash | Directory holds are in-process, like workdirs' — gone with the process; the manifest and its holds survive, and the sweep still releases them |
| Automations | A scheduled job is an automation whose `input` names a fixed `job` — a janitor that keeps a plan up to date has one directory and one thread forever (and will fill its window: `session_full:`, agent-sessions §9) |
| Claims | `job` carries claims (§5); every turn is verified like any top-level run; check runs (`origin: "verify"`) carry no job |
| Billing | Each turn is its run: principal, cap, `<workflow>.<step>` lineage; a child run is its own |
| Secrets | Actor secrets reach the turn through the principal as for any run; nothing job-scoped yet (§10) |
| The graph | The projector's `job` attribute (§1) — `MATCH (r:StrutRun {job: $job})` is the job's history; a `StrutAgentSession` with `session_id = job` its thread; `ACCESSED` edges what it read |
| The UI | The run flyout shows `job` in the summary and links `artifacts[]` from the output the way it links `/artifacts/…` paths today (`ValueFields`); `GET /jobs` is a later sidebar |
| Federation | Dispatch-through to a peer is `federation.md` §2.2's later step; a job's directory and holds stay on the strut that owns the job |

## 10. Left out

- **Job-scoped secrets a step can write** (`ctx.services.secrets.forJob`
  + a `set`). The right home for a pod password; the sealed handle covers
  v1.
- **History of one file.** `git init` in the job directory, a commit per
  turn, `?run=<id>` on the file route served from `git show`. Nothing needs
  it yet; the live file is the contract.
- **Child artifacts physically under the job** (`jobs/<job>/runs/<runId>/`
  with the run's `artifacts` capability bound per job and `/artifacts/:runId`
  resolving through it). The index gives the same view for free.
- **Artifacts on the chat turn callback.** `turn.end` carries text only;
  a builder chat with a job that ran a producing workflow reports it in
  prose, as today.
- **Mid-turn artifacts** (`run.artifact` events posted as they appear).
  A turn is the unit, like a chat turn.
- **A periodic sweep.** Holds cost money while idle; the sweep is lazy
  (the next `job/dir`) plus `DELETE`. A scheduler tick can call it later.
- **The agent-step gaps** `repo-agent.md` §4 lists — assistant text in
  the run stream, cancel reaching the in-flight call and bash, thinking.
  Jobs make them visible; none blocks the first turn.
- **A job viewer in the UI.**

## 11. Work items

**V1 — a plan you can iterate on.** One strut PR, one mcp seed, one hive
PR, in that order. A host launches `job` with a prompt; a session-carrying
agent writes `plan.md` (or a page) into the job directory; the callback
carries the link; the host renders it; the next launch with the same `job`
revises the same file.

1. **Strut** — built. `job` on `RunBody` / `RunOptions` → `run.start`,
   `RunSummary`, `ctx.job`, `$job` (§1, the run half only; `$job` is
   always a key in scope, undefined on a plain run, so a job workflow is
   also a one-shot). `workdirs/` → `jobs/` (`src/jobs.ts`, which also
   took `withLock` from `git/_shared.ts`); the sweep keeps files and
   removes repositories (§2.1); `job/dir` (§2 — falls back to the run's
   artifact dir without a job). `GET /jobs/:id/files[/path]` (§2.2).
   `artifacts[]` resolved in `postRunCallback` + `GET
   …/runs/:runId/artifacts` (`src/artifact-refs.ts`, §3). `specs/CALLBACKS.md`
   §4, `specs/API.md`, AGENTS.md. Tests: `src/jobs.test.ts`, `git.test.ts`.
2. **mcp.** The `job` seed with NO grants beyond the agent's built-ins:
   `job/dir → agent (cwd, session: "{{ $job }}", schema { text, artifacts,
   ask? }) → pack`; `params.system` says deliverables are files in `cwd`,
   named stably, listed in the output. "Built-ins" means ALL of them —
   files, `bash`, `web_search`, `web_fetch` — with `params.tools` wired to
   `agentTools` (empty in V1) and never to `toolFilter`: the seed as first
   merged ([stakwork/stakgraph#1727](https://github.com/stakwork/stakgraph/pull/1727))
   filtered the agent down to the three file tools, so the first prod job
   ("explain this doc at a GitHub URL") could not fetch anything. On a
   swarm every call is routed through the gateway, so `web_search` there
   needs `EXA_API_KEY`; `web_fetch` needs no key.
3. **Hive** (§8): `start_job` / `continue_job`, the `job_turn` handler, the
   reader route. For an `html` deliverable the reader serving the proxied
   bytes from hive's own origin is what makes it framable — hive's call.

**V2 — repositories and pods.** `git/checkout { workdir: "{{ $job }}" }` in
the YAML (works today). `JobsCapability.hold` / `release`, the sweep
running release actions, `DELETE /jobs/:id` (§6) — built 2026-10-07. Left:
the `hive/*` pod steps into the seed with the hold registered and the plain
`password` gone; `hive/*` and `browser/*` in `params.tools`.

**V3 — running and authoring workflows.** `meta/run-workflow` stamps the
job and its child shares the directory — built (§4, §2; `authoring.test.ts`,
`jobs.test.ts`). Left: `meta/*` in `params.tools`; the Concept docs
(`Workflow Builder` gains a `Job` child); claims on `job` (§5).

**Later, as needed.** `POST /chat { job }` + the per-chat shell cwd (§7);
`GET /jobs`, `GET /jobs/:id` (the index); the projector attribute; the
items in §10.

## 12. Validation

Offline (`npm test`):

- A run launched with `job` records it on `run.start` and the summary, hands
  it to steps and templates, and to a `meta/run-workflow` child; a bad id
  is a 400; a resume reads it back.
- `job/dir` creates the directory, stamps the manifest, refuses a second
  concurrent run (`job_busy:`), and is free after the first ends; a child
  run of the turn is not refused for the job it carries.
- `git/checkout { workdir: <job> }` lands inside the job directory;
  `git.test.ts`'s kept-workdir cases pass unchanged under `jobs/`.
- The sweep on an idle job runs each hold's release step (a fake step
  records the call), removes the repositories, keeps the files and the
  manifest; a held job is skipped; `DELETE` releases and removes.
- `GET /jobs/:id/files/<path>` serves with both headers, refuses `..`, and
  the listing skips repository subdirectories; the routes answer 401
  without the key (the sweep in `createStrut.test.ts` covers them).
- The callback: `path` on a job run and on a plain run resolve to the two
  URL forms; a missing file carries `error`; `url` and `content` pass
  through; `kind` is inferred from an extension; `output` is unchanged.
- `meta/run-workflow` runs a seeded workflow, attaches under the parent
  (cancel reaches it), stamps the job; the child's `job/dir` is the
  parent's directory, not `job_busy:`, and the hold leaves with the parent;
  a child of a job-less parent records no job.
- The projector stamps `job` on the three node types (a graph case under
  `npm run test:graph`).

Live, on swarm38 once 4 is seeded: two turns of `job` a minute apart that
edit one `plan.md` — the second turn's request replays the first's thread
byte for byte (the gateway smoke's check b2 already proves the mechanism),
the callback's `artifacts` carry the same `id` and `url` twice, the file at
that URL is the second version; a third turn that claims a pod leaves a
hold that `DELETE /jobs/:id` releases (the pool shows the pod freed).
