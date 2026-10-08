# Federated struts — chains, roll-ups, a shared library, long horizons

> **Status (2026-09-23): design only, nothing built.** Every claim about
> current behaviour was re-read on `strut@596d2b4`, `hive@a64a61e47` (the
> deep-link citations on `hive@59a7e6b81`, the merge of
> [stakwork/hive#5334](https://github.com/stakwork/hive/pull/5334)) and
> `stakgraph@28973f61` (mcp + gateway); citations are `file:line` on those
> commits. Companion plans this builds on and does not reopen:
> `mothership-cost-control.md` (actors, the principal rule, delegations),
> `code-change.md` (the opaque handle and the one dispatch policy in hive),
> `generic-storage.md` (the store boundary), `claims.md` (the truth layer),
> `automations.md` (the clock). The owner's goal, verbatim:
>
> > We may want to move to swarm-specific struts at some point, if we can
> > figure out the clean way to "roll up" struts into each other, and
> > Bifrost/Mothership gateways into each other as well. The strut UI inside
> > hive could have a workspace selector. Any strut could view runs and
> > workflows from other struts. The overall goal is AI assistant
> > workflow-building agents who have a vast library to learn from and to
> > contribute to. Central strut instances may have the highest-level view,
> > which enables vision mapping over extremely long time horizons.
>
> **Revised the same day:** library distribution moved from strut-to-strut
> pull to **export to git, seed from git** (§2.3, §8). A workflow carries
> the repo and path it was seeded from, an export is a PR to that file
> authored with the actor's token, and the next reseed on every strut is
> the distribution. Read-through, the roll-up, cost and dispatch-through
> are unchanged.
>
> **Revised 2026-09-24:** the gateway topology moved to
> `plans/org-gateway.md` — **one gateway per org**, every strut in the org
> billing through it, one delegation per user fanned out across the org.
> §5 here is now a pointer; the arguments it made against *chaining*
> gateways stand and argue for consolidation. Nothing else in this plan
> changes: a run still executes and reads secrets where the workflow
> lives, dispatch-through still forwards the actor, and read-through, the
> roll-up and the library are as they were.
>
> **Revised 2026-10-08:** the **order flips** — dispatch-through (§2.2) is
> the first strut milestone, and read-through (§2.1) follows on the same
> peer record. The first use case is a **local strut calling an explorer
> agent on a cloud strut**: a desktop strut asks a swarm's strut to walk
> that swarm's knowledge graph and return what is relevant. That case
> fixed three rulings: the step waits on the peer's **SSE tail, not a
> callback** (a strut behind NAT can reach a cloud strut and cannot
> receive a POST); a peer is named by the hive **workspace slug** (what a
> person types as `@slug`); and a local strut gets its peers through a
> **paste door**, since hive cannot push to it. `job` is an explicit field
> on the step, never forwarded. Billing across the call — the peer needs
> the caller's principal's delegation — and actor secrets are **deferred**:
> an explorer needs no secret, and the delegation question is
> `plans/org-gateway.md` §3 / `plans/presented-delegations.md`.

## Problem

Every swarm already runs its own strut, and every one of them is a silo.
mcp embeds one strut at `/lab` per swarm (`mcp/src/lab/createLabStrut.ts`,
`mount.ts`), with its own Neo4j (shared with the swarm's code graph and
jarvis), its own workspace volume, its own `API_TOKEN`, and no idea which
swarm it is — nothing in mcp's env or sphinx-swarm's image config names the
swarm to strut (`sphinx-swarm/src/images/repo2graph.rs:95-177`). Every lab
is seeded from the mcp source tree on boot, so the baseline library is
identical everywhere, and everything a swarm learns after boot stays there:
"porting an edit back into the committed template is the only way to spread
it" (`mcp/src/lab/seed-opts.ts:9-11`).

Hive's org-level strut view embeds exactly one of those: the org's default
workspace's swarm, picked server-side by `resolveOrgSwarmWorkspaceForUser`
(`hive/src/lib/helpers/org-workspace.ts:55-86`) and rendered by `StrutView`
with no selector (`hive/src/app/org/[githubLogin]/_components/StrutView.tsx:109-123`;
the route even returns `workspaceSlug` and the component ignores it,
`:13-16`). A person cannot look at another workspace's strut from there. A
builder on one strut can `list_workflows` its own workspace and nothing
else (`src/ai/prompts.ts:254-257`). Nobody has the view across workspaces,
let alone across orgs, and nothing reflects over a quarter of runs.

Strut's own spec lists "distributed execution" as out of scope
(`specs/SPEC.md:907-912`). This plan keeps it out. Federation here means
**reading across struts, copying between them, and occasionally asking one
to run something** — never a shared database and never a run that spans
two processes.

## Decided

| Question | Decision |
| --- | --- |
| Tiers | A tier is a **role** of an ordinary strut, set by what it points at (its peers) and what it is granted. No new server kind, no central-only code path (§1) |
| The one mechanism | **Read-through**: a remote, read-only `WorkspaceStore` + `RunStore` over another strut's existing HTTP API (`src/remote.ts`). The UI's peer view, the builder's library search and pull, the summary roll-up, and dispatch-through's drill-down all sit on it (§2) |
| Order | **Dispatch-through first** (peers + `strut/run-workflow` + `@slug` in the builder), the seeded `explore` workflow beside it, then read-through on the same record, the scoped peer token, library via git, roll-up + reflection. The hive workspace selector is independent. **Gateway chaining: not at all** (§5). Revised 2026-10-08 — the original order put read-through first, for the org-wide runs view |
| Peer identity | **Assigned by whoever registers the peer** — hive uses the **workspace slug** (what a person types as `@slug`; one swarm per workspace, and hive maps slug ↔ `swarmId` when it stores a handle). No self-declared strut id (strut has none today and would have to coordinate one). A run's cross-strut handle is `(peer, workflow, runId)` as the reader names the peer (§3, §4) |
| Version identity | `name` + `contentHash` — already the dedup key in both stores (`src/version.ts:9-11`; content-addressed version nodes, `src/graph/workspace-store.ts` header). Same YAML anywhere = same version (§4) |
| Peer credential | A bearer token in a fourth encrypted `FileSecretStore` file, `peers.json` — pushed by the host (the delegation and actor-secret pattern) or, on a **local strut hive cannot reach, pasted** (`STRUT_PEERS`, a Peers dialog). Peers should hold a **scoped** token — `lab:peer`: read, launch, control what it launched; `lab:read` for a central that only reads. Today's tokens are all-or-nothing, and the fix is the JWT scope in mcp; it matters most for a laptop, which must never hold a swarm's admin key (§3) |
| Actor across the chain | The same opaque string everywhere: hive derives it from the global `User` (`{login}-{id}`, `hive/src/services/bifrost/reconciler.ts:676-682`), so it is valid on every strut in every org. Forwarded as `x-strut-actor` on peer calls; the peer's own `resolveActor` decides whether to honor it. The delegation for that string is on every strut in the org (the fan-out, `plans/org-gateway.md` §3), so a peer bills the forwarded principal without a per-dispatch push (§3) |
| Cost | **One gateway per org** (`plans/org-gateway.md`): every strut in the org bills through it, under a delegation hive fans out to every strut for every member. A run still executes where the workflow lives; the org gateway's log, split by a `workspace` dim, is the LLM-side truth across the org. `RunSummary.costUsd` stays for strut-side per-run spend. **Deferred (2026-10-08):** a cross-strut call needs the caller's principal's delegation on the peer, and the fan-out that would put it there is not built; the explorer milestone does not wait on it (§5) |
| Secrets | **Never cross a boundary.** A dispatch-through run reads the executing leaf's own deployment and actor secrets, pushed there by hive (§6) |
| Library | **Git is the hub.** A workflow's origin is `WorkflowMetadata.source: { repo, path }`, set by the seeder beside `category` and `owner`; a strut seeds from several repos; an **export** is a PR to the file the workflow came from (else `STRUT_HOME_REPO` + a directory convention), authored with the actor's `GITHUB_TOKEN`, never a push to the default branch. Distribution is the next reseed everywhere. No strut-to-strut copy and no `visibility` flag: the repo is the visibility (§2.3, §8) |
| Roll-up store | The existing projector over a remote `RunStore`, each peer into its **own graph namespace** on the central's Neo4j — uniqueness is already per `(node_key, namespace)`, so no schema change and no id rewriting. Summaries only: never events, transcripts, artifacts, secrets (§9) |
| Dispatch-through | A lib step, `strut/run-workflow` — **the first milestone**. The child runs on the peer under the peer's secrets and whatever delegation the peer holds for the forwarded principal; the step waits on the peer's **SSE tail** (reattaching with `?skip=N`), never a callback; `job` is explicit, never forwarded; the parent's log records the handle; cancel propagates cooperatively. **Hive keeps dispatching directly** (§2.2) |
| Leaf independence | Nothing on a leaf ever awaits a peer: reads are initiated by the reader, the library is pulled, automations need no peer. A central being down costs a stale library, never a broken leaf (§10) |

## Design in one paragraph

A strut names the struts it may read as **peers** — `{ id, baseUrl, token }`
— pushed by its host the way delegations and actor secrets are pushed
today, or pasted on a local strut hive cannot reach. `src/remote.ts` implements the read half of `WorkspaceStore` and
`RunStore` over a peer's existing HTTP API, so everything that already
consumes those interfaces works on a peer by being handed a different
store: the run list and drill-down, the SSE tail, `step-stats`, the
projector, the builder's `list_workflows` / `get_workflow`. The read routes
of `createStrut` are mounted a second time under `/peers/:id` over the
remote stores, the web UI grows a peer selector, and `peer` joins the
deep-link params. Workflows come from git and go back to git: the seeder
stamps each one with the repo and path it came from, and the builder's
`export_workflow` opens a PR against that file (or the deployment's home
repo) with the actor's token; the next reseed on every swarm is the
distribution. `search_library` reads peers for the track record a repo
cannot hold. A central strut is any strut with many peers whose automations
project their run summaries into its graph — one namespace per peer — and
run reflection workflows over the result. A run always executes and reads
secrets on the strut that holds the workflow, and bills through the org's
one gateway (`plans/org-gateway.md`); a strut that wants work done elsewhere
launches it there through a step and records the handle.
This is the shape the graph already federates by: a walker on the other
server, not a shared database (`plans/docs/paper.md:46-48`).

## 1. Vocabulary and tiers

| Tier | What it is today | What it becomes |
| --- | --- | --- |
| **Leaf** | A swarm's `/lab` strut: `createLabStrut` (`mcp/src/lab/createLabStrut.ts:213-233`), graph workspace by default on the swarm's Neo4j (`:158-162`), file-backed runs/chats/secrets under `STRUT_LAB_WORKSPACE` (`:225-232`), gated by `labAuth` on the swarm's `API_TOKEN` (`mcp/src/lab/mount.ts:124-138`), seeded inside `createLabStrut` (`:144-199`), which the mount builds on the first request (`mount.ts:10-14`) | Unchanged. It may gain peers if hive pushes some (a workspace that wants to browse a sibling), but nothing requires it |
| **Org strut** | The org's default workspace's leaf — `resolveOrgSwarmWorkspaceForUser` tries `defaultWorkspaceId`, else `findFirst` with no ordering (`hive/src/lib/helpers/org-workspace.ts:69-85`). Nothing in strut distinguishes it | The same leaf, with a peer per other swarm in the org, pushed by hive. It is where the org-wide runs view and the org library live |
| **Central** | Does not exist | An ordinary strut deployment (`src/server.ts`, the standalone image in `Dockerfile`) with peers across orgs, holding read tokens only, running the reflection automations of §9 |
| **Local** | A desktop strut (`plans/local-desktop-and-stt.md`): behind NAT, reachable by nobody | A **caller only**: holds pasted peers (§3), runs `strut/run-workflow` against cloud struts, is never anyone's peer. The first user of dispatch-through (§2.2) |

**A tier is a role, not a kind**, for three reasons. mcp gives strut no
identity and hive keys everything by swarm, so there is nothing a "central
build" could be configured with that a peer list does not already express.
`createStrut`'s options are already the injection points — workspace, store,
chat and secret stores, services, `resolveActor`, `llmAuth`
(`src/createStrut.ts:87-215`) — and the only new one is `peers`. And the
central's jobs (project, reflect, publish a library) are workflows and
automations, which any strut runs. A central that needed special server
code would be a second product to keep in sync with the first.

Several centrals are fine ("central strut *instances*"): one per org is the
org strut; a Stakwork-level one reads across orgs with read tokens. They
do not know about each other unless someone pushes one as the other's peer.

## 2. What "roll up" means — four mechanisms, one seam

| Mechanism | Plugs into | Gives | Proved by |
| --- | --- | --- | --- |
| **(a) Read-through** | `WorkspaceStore` / `RunStore` (`src/workspace.ts:251-344`, `src/store.ts:162-185`) as a remote impl; `createStrut`'s read routes mounted twice | "Any strut could view runs and workflows from other struts"; the org-wide list; the drill-down for (b); the source of (c) and (d) | `storage-conformance.test.ts` mirror cases (§Validation) |
| **(b) Dispatch-through** | A lib step over the remote client + `POST …/run`, `…/cancel` | An org or central workflow that fans work out to leaves | Offline against an in-process peer; `gateway-smoke.ts` for billing on the leaf |
| **(c) Library via git** | The seeder (`publishWorkflowByContent` / `publishStep` with `reactivateKnown: false`, `src/workspace.ts:191-201`) generalized to several repos, plus `git/checkout` → `git/push` → `github/create-pr` (`plans/code-change.md` §3.3, §6) for the way back | A library to learn from and contribute to; templates, params winners, retired steps flowing down; review in git | A seed + export round trip against a local bare repo |
| **(d) Summary roll-up** | `projectRuns` — "a post-hoc consumer of any `RunStore`" (`src/graph/projector.ts:1-13`) — over a remote store | The long-horizon view; step regressions and params winners across the fleet | Projector tests over a remote store; a live graph case |

**(a) is the mechanism for everything that reads a strut; (c) rides git,
not a peer.** (d) is a consumer of (a); (b) needs only the peer record
and the peer's run routes. Order (revised 2026-10-08): (b) first — it is
the use case in hand, and the only one a local strut needs — then (a) on
the same record, (c) beside it (it needs only the git steps), (d) last.
Each ships alone (§Step order).

### 2.1 Read-through — `src/remote.ts`

```ts
export interface Peer { id: string; baseUrl: string; token: string; label?: string }

export function remoteStrut(peer: Peer, opts?: { fetch?: typeof fetch; actor?: string; cacheMs?: number }): {
  workspace: ReadonlyWorkspaceStore;   // Pick<WorkspaceStore, the read methods>
  store: ReadonlyRunStore;             // Pick<RunStore, listRuns | getRunSummary | getRunEvents | tailEvents | lastRunAt>
  claims: (q: { kind: "workflow" | "step"; name: string }) => Promise<unknown>;  // GET /claims, or { enabled: false }
  stepStats: (type: string) => Promise<StepStats>;                                // GET /steps/:type/stats
}
```

Every method is one existing endpoint — the same ones hive already reads
(`hive/src/lib/ai/strutTools.ts:354-419`, the benchmark route's
`strutRunUrl` at `hive/src/app/api/workspaces/[slug]/workflow-benchmarks/run/route.ts:464-466`):

| Method | Endpoint (`src/createStrut.ts`) |
| --- | --- |
| `listWorkflows` | `GET /workflows` (`:651-663`; decorated with `lastRunAt` there, so the remote store's `lastRunAt` reads it off the list) |
| `getWorkflowMetadata` | `GET /workflows/:name` (`:707-712`) |
| `getWorkflow` / `getWorkflowVersion` | `GET /workflows/:name/flow[?version=]` (`:1287-1304`) |
| `getWorkflowSource` | `GET /workflows/:name/:version` (`:1307-1317`) |
| `getWorkflowHash` | from `GET /workflows/:name/versions` (`:1251-1260`) |
| `listSteps`, `getStepSource`, `listStepVersions`, `getStepVersionSource`, `getActiveStepHashes` | `GET /steps`, `/steps/:type/source` (`:1559-1573`), `/versions`, `/version/:v` |
| `listRuns`, `getRunSummary`, `getRunEvents` | `GET /workflows/:name/runs` (`:714-727`), `/runs/:runId` (`:729-743`), `/events` (`:745-749`) |
| `tailEvents` | `GET /workflows/:name/runs/:runId/stream` (`:755`) consumed as SSE — native, so a live run tails live; `tailFromPolling` over `getRunEvents` (`src/store.ts:194-219`) is the fallback the interface already provides |

- **Read-only by type.** The client implements `Pick<…>` of the read
  methods; there are no throwing stubs for writes. Every consumer named in
  the design paragraph already types its dependency as a `Pick` or uses only
  reads (`step-stats.ts:26-28`, the projector, `SubflowResolver` at
  `src/runner.ts:25-28`).
- **Mounting.** `createStrut` factors its GET routes for workflows, runs,
  versions, steps, claims and artifacts into one `mountReadRoutes(app,
  { workspace, store, registry?, claims? })`, called once at `/` with the
  local stores and once per peer at `/peers/:id` with the remote ones. The
  token stays on the server; the browser never talks to a peer. `GET
  /peers` lists `{ id, label }`. Same handlers, second store — the whole
  point of the store boundary (`plans/generic-storage.md`).
- **Cache.** `listWorkflows` and `getRunSummary` are memoized for a few
  seconds inside the client (the sidebar polls); events and tails are never
  cached. Nothing is persisted — a peer view is a live window, and the
  durable copy is (d).
- **Actor.** Peer calls carry `x-strut-actor: <the reader's actor>` when
  the reader has one, for the peer's logs. With mcp's `x-api-token` path the
  peer honors it; with a JWT the token's `sub` wins (`mcp/src/lab/mount.ts:72-93`).
  Reads stamp nothing, so this is telemetry.
- **Who the peer sees.** Today a peer call is indistinguishable from hive:
  the token is the swarm key or a `scope: api` JWT, both full access. §3
  says what to do about that.

### 2.2 Dispatch-through — `strut/run-workflow` (first)

Hive does **not** need this: it resolves the target once at dispatch and
calls that strut directly (`plans/code-change.md` §5, "Keeping the target a
policy"). The cases that do, in the order they are wanted: **a local strut
asking a cloud strut's explorer agent a question** — a desktop strut names
a swarm as a peer, and a workflow or an agent on it runs the swarm's seeded
`explore` workflow, an `agent` over `graph/*` tools (or a `graph/walk`
step) that walks that swarm's knowledge graph and returns what is
relevant; an org workflow that runs a check on every workspace's swarm; a
central reflection that wants a fresh measurement on a leaf; a builder on
the org strut testing a template where the data lives.

A lib step under `src/steps/lib/strut/`:

- `strut/run-workflow { peer, workflow, input?, params?, version?, job?, wait?: boolean }`
  → `POST {peer}/workflows/:name[/:version]/run` (`src/createStrut.ts:1897,1916`)
  with `x-strut-actor: ctx.principal`, then waits on the peer's SSE tail
  (`GET …/runs/:runId/stream`) and returns `{ peer, workflow, runId,
  status, output?, error?, durationMs }`. `wait: false` returns the handle
  at once. Granted to an agent (`agentTools: ["strut/*"]`) it is how a
  local agent asks a cloud graph a question mid-turn.
- **Why a tail, not a callback (decided 2026-10-08).** The tail is
  reader-initiated: the caller needs to reach the peer, and nothing else.
  A callback would need the reverse — a route on the caller the peer can
  POST to, outside the key gate with a nonce as its credential, and the
  caller knowing its own public URL, which no strut does — and a local
  strut behind NAT can do neither. Strut's run callbacks stay what they
  are, a host's contract. The cost is a held connection for the run's
  length, so the step **reattaches** after a dropped connection: it counts
  the events it has read and reopens the stream with `?skip=N`
  (`TailOpts.skip`, the join the web UI already makes); a reattach that
  finds the run finished reads the summary instead. A `job_busy:` or any
  other refusal from the peer fails the step with the peer's message.
- **`job` is explicit, never forwarded.** `meta/run-workflow` carries
  `ctx.job` because the child shares the parent's directory
  (`plans/jobs.md` §4). Across struts there is no shared directory: the
  same id on the peer would be a different job of the same name, with its
  own files and thread there. So the caller names the job it means, or
  none, and the handle for a later turn is `(peer, workflow, runId)` plus
  that id. The job's files, thread and holds live on the peer, and the
  `artifacts` in its output resolve there (`/jobs/<id>/files/…`), so the
  step returns them tagged with the peer rather than rewritten to the
  caller; the read-through routes (§2.1) are how a caller's UI reaches
  them.
- **Control.** The step polls `ctx.control.state` between tail events the
  way `exec` does around its child process and POSTs `/cancel` (`/pause`,
  `/resume`, `:1092-1104`) to the peer; `ctx.onRunEnd` cancels a child still
  running when the parent ends for any reason. The tree is cooperative on
  both sides, so nothing new in `run-control.ts`.
- **Handle.** The peer mints the run id (`generateRunId`, per process,
  `src/store.ts:618-623`); the step records `{ peer, workflow, runId }` in
  its output — on `step.end`, in the parent's log, visible in the events
  panel — and the UI's drill-down follows it through `/peers/:id/…` (2.1).
  v1 links parent → child only; the child records nothing about its caller
  (it does not know the caller by id). A `launchedBy` stamp on the child's
  `run.start` is a later addition if the roll-up ever needs the reverse edge.
- **Secrets and billing** happen on the peer, for the forwarded principal
  — §5, §6. That is why the step forwards `ctx.principal`, exactly as
  `meta/run-workflow` forwards it within one process
  (`src/steps/lib/meta/run-workflow.ts:29-35`). The peer's Mothership
  looks that principal up in its own file; under
  `STRUT_MOTHERSHIP_REQUIRED=1` a principal it has no record for fails the
  child's first model call, honestly. The fan-out that would put every
  member's record on every strut in the org (`plans/org-gateway.md` §3) is
  **not built** — hive pushes delegations and actor secrets per target,
  only before its own dispatches — and the first milestone does not wait
  on it: how a cross-strut call is billed is deferred, with the fan-out
  and the presented grant (`plans/presented-delegations.md`) as the two
  candidates. An explorer needs no actor secret; a job that pushes code
  does (§6). The child run carries its own cap, not the parent's; the
  forwarded per-run grant that would bound the tree is the presented
  grant's job (`plans/org-gateway.md` §6).
- **Hive's handle if hive ever dispatched through an org strut:** the row
  would hold the org strut's `(swarmId, workflow, runId)`, the leaf run
  being that run's child; the org run's own callback fires when it ends.
  Opaque and stable either way, which is all `code-change.md` requires.

### 2.3 Library — export to git, seed from git

The boot seeder is already a library sync with one source, the mcp source
tree: content-hash reconciliation, `reactivateKnown: false` so a local edit
stays active until the template itself changes, `RETIRED_STEPS` for
removals (`mcp/src/lab/seed-opts.ts:13,26-34`). What it lacks is the way
back — "porting an edit back into the committed template is the only way
to spread it" (`seed-opts.ts:9-11`) — and more than one source. Both are
one small addition: a workflow remembers the file it came from, and a tool
writes it back there as a PR. **Git is the hub; struts never copy from each
other.**

- **Origin.** `WorkflowMetadata.source?: { repo, path, transformed? }`
  beside `category`, `owner`, `automations` (`src/workspace.ts:154-166`):
  `repo` a plain URL, `path` the file inside it. Set by the seeder, never
  by a publish, cleared by nothing; a workflow forked under a new name has
  no origin until its first export sets one. The same field on a custom
  step (`StepInfo`). One optional JSON-string attribute on `StrutWorkflow`
  and `StrutStep` (add-only, the AGENTS.md convention); the file store
  keeps it in `_metadata.json`. **A URL and a path are identity enough**:
  content hash already reconciles, so there is no repo id and nothing to
  register anywhere.
- **Seeding from repos.** `STRUT_SEED_REPOS`, a JSON list of `{ repo,
  ref?, path? }`, seeded at boot with the lab's semantics; and a lib step
  `strut/seed { repo, ref?, path? }` — `git/checkout` (the deployment's
  `GITHUB_TOKEN` for a private repo; the bare cache under `<dataDir>/repos`)
  then publish everything under the convention — so a deployment reseeds on
  a schedule with an ordinary automation. The convention: `workflows/<name>.yaml`
  and `steps/<type>.ts` under `path` (default: the repo root); one file per
  workflow, the template, never versions. A file removed from the repo
  retires, on the next reseed, only the workflow or step whose `source`
  names that file — `RETIRED_STEPS` generalized, and a local creation is
  never touched. The mcp lab keeps seeding from the image and stamps
  `source` with the stakgraph repo and each file's path. The mcp lab and a
  company repo are then two sources on one strut, and a workflow's origin
  says which.
- **Export.** `export_workflow({ name, repo?, path?, message? })` — a chat
  tool, with `meta/export-workflow` as its twin so a reflection can promote
  (§9). Target: the workflow's `source`; without one, `STRUT_HOME_REPO`
  (one default per deployment, a plain URL) at the convention path;
  explicit `repo` and `path` override both. It is a run of a seeded
  workflow, `strut-export`: `git/checkout` → `strut/export-files` (the
  YAML as published, plus the source of every custom step in the closure —
  `flowClosure`, `src/closure.ts` — that has no origin of its own or whose
  origin is this repo) → `git/diff` → `git/push` to a branch
  `strut/export/<name>-<hash>` → `github/create-pr`. The `git/*` steps and
  `github/create-pr` are `plans/code-change.md` §3.3 and §6. **Always a PR,
  never a push to the default branch**, authored with the actor's
  `GITHUB_TOKEN` — the actor secret hive pushes before a dispatch, resolved
  through `secrets.get` like any other (§6), so review stays in git. The
  result is the PR URL; a first export sets `source`, so the next one goes
  to the same file.
- **The round trip.** Merge the PR; the next reseed on every strut that
  seeds from that repo sees a new file hash, publishes the next `vN` and
  activates it — on the exporting strut the hash equals its active version,
  so a no-op. Because `reactivateKnown` is false, a local edit made
  elsewhere in the meantime stays active on that strut until the file
  changes again: the seeder's rule, now with a way in.
- **Transformed seeds.** The harvey seeder expands `@@include` and rewrites
  tool names at seed time (`mcp/src/lab/harvey/seed.ts:82-124`), so the
  published YAML is not the file. A seeder that transforms records
  `source.transformed: true`, and the export tool refuses those with a
  message naming the file — until `plans/workspace-files-and-includes.md`
  makes includes round-trip.
- **Visibility is the repo.** A private company repo is org-private; a
  public repo is public; a workflow never exported is workspace-private.
  No flag on the workflow, nothing for a peer to enforce, and the org
  already decides who may merge.
- **Leaf independence holds.** Git unreachable means an export fails and a
  scheduled reseed errors; nothing else changes.
- **Gone from the earlier draft of this plan:** strut-to-strut
  `pull_workflow`, the `peer:<id>` publisher stamp, a `visibility` flag,
  and a qualification gate. Read-through (§2.1) stays, for the track record
  a repo cannot hold.

### 2.4 Summary roll-up — the projector over a peer

`projectRuns` takes any `RunStore` and a workflow list, writes `StrutRun`
nodes with summaries and a `log_ref`, and is idempotent
(`src/graph/projector.ts:1-24`). Point it at `remoteStrut(peer).store` and
`.workspace.listWorkflows()` and the central's graph holds the peer's runs.
Two details make it cheap and collision-free:

- **Summaries only.** `getRunSummary` is one small JSON per run and already
  carries what the long view needs: status, timings, `input`/`output`,
  `actor`/`principal`, `automation`, `workflowHash`, `stepCounts`
  (`src/core.ts:341-366`). Add **`costUsd`**, computed at `finalize` the
  way `stepCounts` is (`countSteps`; the sum `reportedCost` already takes
  from `step.end.output.cost`, `src/verify.ts:234`). The projector never
  calls `getRunEvents` for a peer — transcripts stay where they were made.
- **One graph namespace per peer.** Node uniqueness is per `(node_key,
  namespace)` (`src/graph/schema-seed.ts:149-159`;
  `plans/jarvis-graph-compat.md:383-387`) and the node writer takes a
  per-write `namespace` (`src/graph/node-writer.ts:345-348`). `StrutRun` is
  keyed by `run_id` alone (`src/graph/strut-schemas.ts:246-249`) and run
  ids are per-process timestamps, so two peers collide in one namespace;
  in their own they do not, with no id rewriting and no schema change. The
  central's own workspace stays in `default` (`src/graph/search.ts:34`).
  Cross-namespace questions — "every run of this content hash, anywhere" —
  are a `MATCH` on `content_hash` or `workflow_name` without a namespace
  predicate, which is the fleet view §9 wants.

## 3. Peers — identity, credentials, scope

**The record.** `Peer { id, baseUrl, token, label? }`, kept in a fourth
encrypted `FileSecretStore` file, `peers.json`, beside `secrets.json`,
`mothership.json` and `actor-secrets.json`; memory when the workspace is not
file-backed, injectable as `createStrut({ peerStore })`. Not on the services
bag and not in `GET /secrets` — a step must never read a peer token, for
the same reason it must never read a delegation (`plans/mothership-cost-control.md`
§3). Routes, behind `requireApiKey`: `PUT /peers/:id { baseUrl, token,
label? }`, `DELETE /peers/:id`, `GET /peers` (ids and labels, never tokens;
the same GET the UI selector reads). Standalone and dev: `STRUT_PEERS` as a
JSON list, loaded at boot.

**Who pushes.** Hive: it already holds every swarm's URL and key
(`Swarm.swarmUrl`, `swarmApiKey`, `hive/prisma/schema.prisma:443,449`) and
already pushes per-target state before it needs it (`ensureStrutDelegation`,
`hive/src/services/bifrost/strut-delegation.ts:382-453`). `ensureStrutPeers(target)`
is the third push of that family: for the org strut, one peer per other
workspace swarm in the org (`GET /api/orgs/[login]/workspaces` already
knows which have a swarm, `hive/src/app/api/orgs/[githubLogin]/workspaces/route.ts:18-67`);
reconciled by the delegations cron when members and swarms change — cloud
struts only. A **local strut** (a desktop strut behind NAT, §1) is one hive
cannot reach, so it gets its peers through a **paste door**: `STRUT_PEERS`
set by the desktop host, or a Peers dialog beside Secrets where a person
pastes a swarm's URL and token. The record is the same either way; hive
handing it over the way it hands the embed its `?key=` is a later
convenience.

**Identity.** A peer is named by the strut that holds the record. Hive
names them by the **workspace slug** — what a person types as `@slug` in
a prompt (§8); one swarm per workspace, and hive maps the slug to its
`swarmId` when it stores a handle. Strut does not declare an id for itself: mcp has none to give it,
and a self-declared one is a global namespace with nobody administering
it. The one place this bites — a child run naming its caller — is the
deferred `launchedBy` stamp of §2.2.

**Credentials and scope.** The honest state: a peer token is either the
swarm's `API_TOKEN` (`x-api-token`, full access to `/lab`) or a JWT mcp
mints from it with `scope: "api"` (`mcp/src/index.ts:204-223`,
`mcp/src/repo/events.ts:63-80`) — also full access. A central that reads
forty swarms would hold forty full keys, and a swarm key is admin of that
lab (register a step that reads any secret). So:

- **mcp: a `lab:peer` scope.** `/mint-token` gains `scope: "lab:peer"`;
  `labAuth` accepts it for `GET`, the SSE stream, `POST …/run` and the
  control routes of runs it launched, and honors `x-strut-actor` beside it
  (a launch must name the person, not the machine). `lab:read` is the same
  minus launch, for a central that only reads. Long-lived (60 days, the
  delegation's lifetime), re-minted by hive's cron. This is the token hive
  pushes, or a person pastes, as a peer token — and the only kind a laptop
  may hold.
- **strut: `createStrut({ resolveScope?(c) → "full" | "peer" })`**, the
  twin of `resolveActor` and the only new hook. Default: `"full"` — today's
  behaviour, unchanged for every existing deployment. mcp passes a hook that
  maps the JWT scope. Standalone deployments that want peers can set
  `STRUT_PEER_KEY`, a read-only twin of `STRUT_API_KEY`; nothing else in
  strut learns a new kind of auth. A `peer`-scoped caller may read, launch
  a run and control a run it launched, and nothing else; every other gated
  route (`requireApiKey`, `src/auth.ts:38-46`) refuses it.
- **The first milestone may ship before the scope exists, inside an org.**
  The org strut is one of the org's own swarms, and hive already holds
  every key in the org; hive pushing full tokens to it adds no new class of
  exposure (one swarm holding its siblings' keys is new; a stolen org strut
  is already an org-wide problem). A **local strut** and a cross-org
  central wait for the scope — a laptop must never hold a swarm's admin
  key.

**Actors across the chain.** One string per person everywhere — hive's
actor is built from the global `User` and the GitHub login, not from any
workspace (`hive/src/services/bifrost/strut-delegation.ts:145-154`), and the
macaroon `user_id` is the same string (`hive/src/services/bifrost/macaroon-issuer.ts:241-258`).
Across orgs it still does not collide. A central resolves actors the way
any strut does — its host's hook; standalone, `x-strut-actor` with the key
(`src/auth.ts:70-74`). What an actor may *do* on a peer is decided by the
peer, from the credential, never from the forwarded name. What a peer
needs beyond the string is a delegation for it, and with one gateway per
org that record is the same on every strut in the org — hive fans it out
per member, so a dispatch pushes nothing (`plans/org-gateway.md` §3, §5).

## 4. Handles and visibility

- **A run:** `(peer, workflow, runId)` — the reader's name for the peer,
  the workflow name, the id the peer minted. Never parsed. Hive's
  `(swarmId, workflow, strutRunId)` (`plans/code-change.md` §5) is this
  handle with hive as the reader.
- **A workflow:** its name — names are the seeded library's identity
  across swarms today, and the graph keys `StrutWorkflow` by name
  (`src/graph/strut-schemas.ts:159-162`). **A version:** `contentHash`
  (`src/version.ts:9-11`; `StrutWorkflowVersion` keyed on `(name,
  content_hash)`, `:186-188`). Two struts holding the same YAML hold the
  same version, and `run.start.workflowHash` (`src/runner.ts:240`) says
  which one a run executed — the record the claims layer already relies on
  (`plans/claims.md` §3). A step version: `stepHashes` (`:241`).
- **The UI on strut A showing strut B.** A peer selector in the sidebar
  (from `GET /peers`), which prefixes every API call with `/peers/<id>`;
  `web/src/api.ts` already derives its base at runtime
  (`web/src/api.ts:7-17`), so the prefix is one more segment. The workflow
  list, runs list, versions, the canvas, the events panel and the flyouts
  all read through the same typed wrappers and need no change; **write
  actions are hidden** on a peer (a peer view is read-only by
  construction). The live tail is the proxied SSE. Deep link: `peer` joins
  `DEEP_LINK_PARAMS` (`web/src/embed.ts:16`), mirrored to the host like
  `wf`/`run` (`web/src/app.tsx:180-190`), so hive can open "run X on
  workspace Y" inside the org strut's frame. Hive's side already mirrors
  `wf`/`run`/`v`/`chat` ([stakwork/hive#5334](https://github.com/stakwork/hive/pull/5334),
  merged as `hive@59a7e6b81`: `StrutView.tsx:18,36-52,135-140`) and needs
  `peer` added to its `DEEP_LINK_PARAMS` — the same one-line addition
  `elicit` still needs there.
- **What is live and what is cached.** Lists and summaries: a few seconds
  of memo in the client. Events and tails: live. The durable copy of a
  peer's history is the central's projection (§2.4), which is also what
  survives a peer being decommissioned.

## 5. Cost across the chain — one gateway per org

**Decided 2026-09-24, in `plans/org-gateway.md`:** the org has ONE
gateway — the org default swarm's Bifrost — and every strut in the org
bills through it, always. Hive fans one delegation per user out to every
strut in the org (same macaroon, same VK, same `baseUrl`, a `workspace`
dim per target), the per-workspace gate goes, and the gateway's dashboard
groups the org's spend by `workspace` → user → workflow → step. Strut
needs one additive field (`dims` on the delegation record); nothing about
how a run executes, reads secrets, or attenuates its links changes.

So a leaf run launched from an org strut (§2.2) is billed like any run on
that leaf: the leaf's Mothership finds the forwarded principal in its own
`mothership.json` (`src/mothership.ts:302`), appends its run and step
links (`:274-295,332-336`), and calls the org gateway with the VK hive
pushed — the same one every strut in the org holds for that user.
`STRUT_MOTHERSHIP_REQUIRED=1` (set by sphinx-swarm) still makes a missing
delegation a step error rather than a direct call.

**Why one gateway rather than chained ones.** The earlier draft of this
section rejected chaining a leaf gateway into an org gateway on four
grounds — the plugin reads `x-macaroon` inbound only; a link cannot say
"via swarm L" without a wire-format bump; a realm per gateway makes a
chained macaroon `realm_not_permitted`; two Redis stores count one call
twice — and concluded "gateways stay per swarm". The grounds stand. What
they argue against is *chaining*; consolidation has none of them, and
chaining's only payoff, a cap that spans swarms, is what one gateway gives
by construction. The costs of consolidation (one point of failure for the
org's LLM traffic, prompts transiting the org swarm's host) are weighed
in `plans/org-gateway.md` §8.

**What stays in this plan.** `RunSummary.costUsd` (§2.4) — what strut
knows from its own steps' reported cost, per run, on the summary — so
the central's projection carries spend and the reflection loop reads it
without any gateway credential. The org-wide LLM-side truth is now the
org gateway's log; no cross-swarm aggregator is needed. The `dims`
mechanism this section once proposed for swarm grouping is the `workspace`
dim of `plans/org-gateway.md` §4, riding on the delegation record.

**Deferred for the first milestone (2026-10-08).** A cross-strut call is
billed on the peer, for the forwarded principal, from the delegation the
peer holds — and today the peer holds one only if hive pushed it there
before one of its own dispatches; the org fan-out is designed, not built.
The explorer milestone ships without an answer: a principal the peer has
no record for fails at its first model call with the Mothership error, and
the fix is the fan-out or a presented grant
(`plans/presented-delegations.md`), decided when billing is taken up.

## 6. Secrets across the chain

Confirmed, and made a rule:

- **Deployment secrets and actor secrets never leave the strut that holds
  them.** A dispatch-through run resolves `secrets.get(NAME)` on the peer,
  bound to the forwarded principal (`SecretsCapability.forPrincipal`,
  `src/actor-secrets.ts` header) — so the peer must already hold that
  actor's `GITHUB_TOKEN`, which is hive's `ensureStrutActorSecret(target,
  actor)` before dispatch (`plans/code-change.md` §3.2), per target. A
  central never pushes one.
- **The first milestone needs none of this on the peer.** An explorer
  workflow reads the peer's graph with the peer's own deployment secrets
  (its Neo4j, its model keys or delegation); no actor secret crosses or is
  needed. A job that pushes code on a peer is where the per-target push
  matters, and that is later.
- **Read-through carries no secret.** Run logs mask `secretsEnv` values
  (`specs/EVOLVE_SPEC.md` §4.3), `GET /secrets` and `GET /actors/:actor/secrets`
  return names only (`src/createStrut.ts:1446-1451,1490-1497`), and
  `mothership.json` / `peers.json` have no read route at all.
- **An export is authored with the actor's `GITHUB_TOKEN`, on the strut
  where the export runs.** On a swarm that is the actor secret hive pushes
  per target (`ensureStrutActorSecret`); on a central it is the operator
  actor's, pushed the same way. The token reaches git as `git/checkout`
  already handles it — the scrubbed child env and an inline credential
  helper, never the log or the repository (`plans/code-change.md` §3.3) —
  and the PR is authored by that person, which is what makes the review
  in git mean something.
- **What a central strut is not allowed to hold:** any swarm's `API_TOKEN`
  (admin of that lab); any user's actor secrets other than its own
  operators' (it runs nobody's coding workflows); any delegation of
  another org's users (within an org the fan-out puts every member's on
  every strut, the org strut included — `plans/org-gateway.md` §3); raw transcripts or
  artifacts of peer runs (summaries only, §2.4). What it does hold: read
  tokens per peer; its own provider keys or its own delegations for the
  operator actors that own its reflection automations (their spend is the
  owner's, the principal rule), and those operators' `GITHUB_TOKEN` for the
  PRs a reflection opens; its own graph.
- **Finding.** The lab passes `store`, `chatStore` and `secretStore` as
  file stores in graph mode but not `actorSecretStore`
  (`mcp/src/lab/createLabStrut.ts:225-232`), and strut's default follows
  the workspace kind, so on a graph workspace actor secrets are
  **in-memory** (`src/createStrut.ts:473-476`) and a restart drops every
  pushed token. Hive re-pushes before each dispatch, which hides it. One
  line in mcp (or a strut default that follows `secretStore`'s kind); not
  federation work, noted so it is not forgotten.

## 7. The hive workspace selector

Cheapest useful step, and it needs nothing from strut. Hive today: the org
route resolves one swarm, mints an 8 h JWT with `sub = actor`
(`hive/src/app/api/orgs/[githubLogin]/strut/embed-url/route.ts:88-99`),
pushes the delegation (`:124-129`), returns `{ url, workspaceSlug }`
(`:133-138`); the per-workspace pattern already exists next door —
`stakgraph-sessions/embed-url` takes a slug and uses `getWorkspaceSwarmAccess`
(`hive/src/app/api/workspaces/[slug]/stakgraph-sessions/embed-url/route.ts:44-80`).

- **`embed-url` takes `?workspace=<slug>`.** With it: `getWorkspaceSwarmAccess(slug,
  userId)` (`hive/src/lib/helpers/swarm-access.ts:43-140` — owner or active
  member, swarm `ACTIVE`). Without it: the org default, as now. The
  delegation push is already per target (`ensureStrutDelegation` on the
  resolved swarm), so it needs no change; the same for the actor-secret push
  once `code-change.md` lands.
- **`resolveStrutTarget({ workspaceId, purpose })`** (the one policy
  function, `plans/code-change.md` §5) gains `purpose: "embed"` with an
  optional slug: the named workspace's swarm when given, the org default
  otherwise. The route calls it; nothing else in hive learns how the choice
  is made.
- **`StrutView`** gets a select: "Org (default)" plus every workspace with
  `hasSwarm` from `GET /api/orgs/[login]/workspaces` (`route.ts:18-67`,
  which also returns `isDefault`). Changing it re-fetches the embed URL and
  reloads the iframe; the choice is remembered in the page URL so a link
  reopens it. Deep links keep working per swarm once the
  `strut-deep-links` branch lands.
- **The org-wide list** ("every run across the org's workspaces in one
  table") is *not* this milestone. It needs §2.1 on the org strut plus
  hive pushing peers; the selector then also offers "All workspaces", which
  is the org strut with its peer view open. Hive never aggregates strut
  data itself — it has no store for it, and fan-out over N swarms per page
  load is what the peer view already is, in the right place.

## 8. The builder's learning loop

Three verbs — **search, learn, contribute** — with git carrying the
artifacts and peers carrying the track record.

**Naming a peer.** `GET /peers` is what the builder reads: the prompt (or
a `list_peers` tool, since the prompt is frozen per chat) lists each
peer's id and label, and `@<id>` in the user's message is that peer — hive
registers peers by workspace slug (§3), so `@acme-web` is what a person
would type anyway. `run_workflow`, `list_workflows` and `get_workflow`
take an optional `peer`; `run_workflow({ peer })` is `strut/run-workflow`
(§2.2) as a chat tool, and a workflow grants the step to its agents with
`agentTools: ["strut/*"]`.

**Search.** The library is already local: every workflow a deployment
seeds from its repos is in `list_workflows` (`src/ai/prompts.ts:254-257`),
with `source` saying where it came from. What a repo cannot hold is how a
workflow *performs*, so `search_library({ query, peer? })` reads peers: for
each (or one), `listWorkflows` + a word matcher over name, description and
category — the rule `web/src/step-search.ts` applies to step types (every
word must hit), applied to workflows, server-side beside `searchSteps`
(`src/ai/stepHelpers.ts:177`) — ranked, returning per hit `{ peer, name,
source, activeHash, runs: { total, success, lastAt }, claims: { supported,
refuted, unknown } }` from the peer's summaries, claims and versions
endpoints. A hit with a supported contract on many runs outranks a bare
description, and `activeHash` says whether the peer runs the version this
strut holds or a local edit the repo has not seen. `get_workflow` and
`get_step` gain `peer?` for reading such an edit where it is. Graph hybrid
search across peers is not v1: the central's projection (§2.4) is where
cross-fleet semantic search belongs, one graph, later.

**Learn.** The prompt gains one section, "Library": search before
authoring; a seeded workflow is a baseline with an origin — build on it
and cite it; `edit_workflow` (a person in the loop) publishes a local
version that survives reseeds until the file changes (§2.3); an in-run
author (`meta/*`) forks under a new name, as with seeded baselines today
(`src/authoring.ts:9-27`); and when a local version is worth keeping,
export it. `meta/search-library` is the twin so an evolve loop can start
from the version of a template that performs best across the org.

**Contribute** = `export_workflow` (§2.3). The tool result is the PR, and
the PR body carries what a reviewer needs and the model would otherwise
assert: the claim ledger for the active version (`buildLedger`,
`src/ledger.ts:63`), run counts and success rate from this strut's
summaries, and — when peers exist — the same for every peer running the
same hash. Asserted-only evidence is labelled as such (`plans/claims.md`
§4.1, fixed point 3). **No qualification gate in strut**: what qualifies is
the reviewer's call, in git, with the evidence in front of them. An
`ai`-stamped candidate exports the same way, its stamp in the PR body; and
`meta/export-workflow` is how the central's reflection (§9) promotes a
fleet-wide winner — one PR, human-merged, which is EVOLVE_SPEC §2's
"promote to a reviewable artifact" as the loop's last beat. Hill-climbing
a contract to get merged is the train-set problem EVOLVE_SPEC §7 answers
with held-out validation, which the central can run.

**Org IP.** Where a workflow may go is which repo it is exported to.
`STRUT_HOME_REPO` per deployment is the company repo for a swarm in that
org — private by construction, and the org already decides who may merge;
a public library is a public repo a person names explicitly in the export;
a workflow nobody exports stays on its workspace. Runs and summaries are
governed by who holds a token, which is the org boundary hive draws when it
pushes peers (§3). Nothing in strut needs a visibility flag.

## 9. The central strut and long horizons

**What it holds.** Per peer, per workflow, projected into that peer's
namespace (§2.4): every run summary (`status`, timings, `costUsd`,
`workflowHash`, `stepCounts`, `actor`/`principal`, `automation`, `input`/
`output` previews); every version (`StrutWorkflowVersion` with
`params_json`, content-addressed — the params history *is* the version
history); step versions; the claim ledger per (claim, version) as of each
projection; automation definitions. Never events, transcripts, artifacts,
secrets. A summary is about a kilobyte; a million runs is a gigabyte in
Neo4j. Retention: leaves keep what they keep today; the central keeps
projections indefinitely — they are the point.

**How it gets there.** One automation per peer set, `interval` every few
hours (`plans/automations.md`), running a workflow of `graph/project`-style
steps over `remoteStrut(peer)` — `projectRuns` with `skipSettled: true` is
already incremental (`src/graph/projector.ts:33-36`). A peer that is down
skips a tick and catches up on the next; the run is `error`, visible,
harmless.

**What runs there.** Reflection is the `capture → propose` half of the
shared loop (`specs/EVOLVE_SPEC.md` §2), across the fleet, on a calendar;
`evaluate → promote` stays on the strut that owns the workflow, or runs on
the central against a pulled copy with a dataset. Weekly and monthly
automations of reflection workflows — an `agent` step with
`agentTools: ["graph/*", "meta/*", "strut/*"]` and `graph_query` over the
central's graph, no `bash` (the grant discipline of EVOLVE_SPEC §5.3.2) —
answer, in order of how mechanically they can be computed:

| Question | Computed from | Ties to |
| --- | --- | --- |
| Which workflows **drift**: success rate or `costUsd` moved across versions or across peers running the same hash | `StrutRun` by `workflow_name` × `workflow_hash`, windowed | EVOLVE_SPEC §8's per-miss taxonomy, now per version |
| Which steps **regress**: a step type's error share rose org-wide | `stepCounts` summed per type per week — `step-stats.ts` over every peer instead of one workspace | `GET /steps/:type/stats` (`src/step-stats.ts:1-17`) |
| Which **params keep winning**: an `eval/evolve-loop` or `eval/optimize` run whose `output` names `bestVersion` / `bestPrompt` on several peers, or a promoted default other peers still lack | summaries' `output` (`evolve-loop` output shape, `mcp/src/lab/eval/steps/evolve-loop.ts:581-597`) joined to versions by hash; `promotes` declarations (`src/core.ts:129-140`) | EVOLVE_SPEC §3, §9; the lab's harvey/gaia loops, whose results today live only in their run records |
| Which **claims went stale or refuted** org-wide, and which contracts most workflows share | projected ledgers | `plans/claims.md` §5 |
| What the fleet **spends**, by org → swarm → workflow → step | `costUsd` on summaries; the org gateway's log by `workspace` for the LLM-side truth (`plans/org-gateway.md` §4) | `mothership-cost-control.md` §6 |

**The artifact a human reads.** A dated markdown report — `vision/<period>`
in the central's artifacts (`ctx.services.artifacts`), linked from its run
— with five fixed sections: *what changed* (versions published, pulled,
retired, across peers), *what regressed* (the drift and step tables above,
with the run handles that show it), *what converged* (params and contracts
several peers arrived at independently — the strongest promotion signal
the fleet has), *what to promote* (candidates that meet §8's bar, with
their ledgers), *what to retire* (never-run templates, checks that never
fire). Structured beside the prose: one `Claim` per finding, `ABOUT` the
subject version, with the report run as `HAS_SOURCE` — so the next
reflection reads what the last one found, and a finding that stopped
being true shows as `stale` (`plans/claims.md` §Nodes). "Vision mapping
over extremely long time horizons" is this report read as a series: the
monthly one reads the weekly ones; the quarterly one is a claim ledger over
the year, not a fresh look at a million runs.

**What flows back down.** Merged PRs, by reseed: a promoted template, a
params default worth adopting, a retired step. The central's reflection
opens the PR through `meta/export-workflow` (§2.3), a person merges it,
and every strut that seeds from that repo picks it up on its next reseed —
no channel from the central to a leaf exists or is needed. The report
itself stays where it was made, readable through the peer view; its
actionable findings are the PRs. A leaf that ignores the central loses
nothing it has.

## 10. What not to do

- **No shared database across struts.** Each peer's Neo4j stays its own;
  the central copies summaries into its own graph, namespace per peer. Two
  struts on one Neo4j today would already collide on `StrutRun.run_id`.
- **No distributed consensus, no cross-process run.** A run executes on one
  strut; `parentRunId` and run control stay in-process
  (`src/createStrut.ts:428-431`); the cross-strut edge is a handle in a
  log.
- **No multi-tenancy inside one strut.** One strut per swarm is the
  existing unit of trust (`STRUT_API_KEY` unset or equal to `API_TOKEN`,
  one `mothership.json`, one secret store), and every strut-facing hive seam is
  keyed by swarm. Tenancy inside would mean per-tenant secrets, delegations,
  registries and auth in strut — the "new auth system" this list forbids —
  to save the cost of a container that already exists per swarm.
- **No new auth system in strut.** Hosts resolve actors; the one addition is
  a read scope, resolved by the host too (`resolveScope`).
- **Nothing that makes a leaf depend on a central.** No push from leaves,
  no registration with a central, no central-issued ids, no library that
  must be reachable for a workflow to run.
- **No strut-to-strut writes.** An artifact moves between struts through
  a repo and a reviewed PR (§2.3); read-through is the only strut-to-strut
  channel, and it reads.
- **No gateway chaining, and no dual-mode billing** (§5,
  `plans/org-gateway.md`): one gateway per org, and every strut in the org
  always uses it.
- **No new server kind** (§1).

## Non-goals (v1)

- Cross-fleet hybrid search from a leaf (search is per peer, name and
  description); it belongs on the central's graph.
- Strut-to-strut copying of workflows or steps; git is the only way an
  artifact moves (§2.3). Likewise any review UI in strut: the PR is the
  review.
- The reverse edge from a child run to its cross-strut caller
  (`launchedBy`).
- An org-wide per-user spend cap (needs a shared counter, §5).
- Callbacks from a peer to a caller; dispatch-through tails instead
  (§2.2: a local strut cannot receive one).
- Peer views inside the *chat* flyout (a peer's chats are that swarm's).
- Anything about swarm ↔ swarm graph federation beyond what the paper
  already describes; this plan is about strut's records.

## Step order

Revised 2026-10-08: dispatch first, for the local-strut explorer case.

1. **Strut: dispatch-through** (§2.2, §3, §8). `peers.json` +
   `PUT/DELETE/GET /peers` + `STRUT_PEERS`; the `strut/run-workflow` lib
   step (the tail with reattach, explicit `job`, cancel propagation); the
   builder's `@slug` convention and `peer?` on `run_workflow` /
   `list_workflows` / `get_workflow`. Useful alone: a local strut — or any
   strut — runs a workflow on a swarm and gets the result.
2. **mcp: the seeded `explore` workflow** — an `agent` over `graph/*` (or
   a `graph/walk` step) taking a question and returning text — the
   workflow a peer is asked to run. Beside 1.
3. **Hive: `ensureStrutPeers`** beside the delegation push, cloud struts
   only, id = workspace slug. **Hive: the workspace selector** (§7) is
   independent of everything here: `embed-url?workspace=`,
   `resolveStrutTarget({ purpose: "embed" })`, the select in `StrutView`,
   the URL state, landing with `code-change.md` phase 3.
4. **mcp: `lab:peer`** and **strut: `resolveScope`** (§3). Small, and the
   precondition for a local strut or a cross-org central holding a peer
   token.
5. **Strut: read-through** (§2.1, §4). `src/remote.ts`; `mountReadRoutes`
   mounted at `/` and `/peers/:id` over the record step 1 created;
   `RunSummary.costUsd`; the UI peer selector, read-only mode, `peer` deep
   link. Useful alone: "any strut could view runs and workflows from other
   struts", the org-wide view in hive, and the artifact links of a
   dispatched job.
6. **Library via git** (§2.3, §8). `source` on workflows and steps
   (metadata, schema attribute, the seeders setting it); `STRUT_SEED_REPOS`
   + `strut/seed`; `strut/export-files` + the seeded `strut-export`
   workflow; `export_workflow` / `search_library` chat tools and their
   `meta/*` twins; the PR body with the ledger. The last two steps wait on
   `plans/code-change.md` phase 2 (`git/push`, `github/create-pr`). Useful
   alone: an edit made on any swarm reaches every swarm through one
   reviewed PR.
7. **Roll-up projection + the first reflection** (§2.4, §9). The
   projector over a remote store into a per-peer namespace; the projection
   automation; one weekly reflection workflow producing the report and its
   claims. Useful alone: the long view, on the org strut first.
8. **Billing across a call** (§5): the fan-out (`plans/org-gateway.md`
   §3) or the presented grant (`plans/presented-delegations.md`), decided
   when taken up; the `workspace` dim (`plans/org-gateway.md` §4) rides
   with it.

1, 2 and 3 are independent of each other; 4 gates a local strut's token,
not the step; 5 depends on 1 only; 6's export half waits on
`code-change.md` phase 2, its seeding half does not; 8 is independent of
every step above.

## Validation

- **Remote store — mirror conformance.** `storage-conformance.test.ts`
  gains a third pattern beside file and memory (`:15-20`): an in-process
  origin (`createStrut` with memory stores, no port — the client takes a
  `fetch`, and `strut.app.request` is one) and `remoteStrut` over it. Every
  read assertion of the workspace and run suites is made twice, on the
  origin and on the remote, after writing through the origin; the SSE tail
  is asserted with the run suite's history-then-live case through the
  proxy. A remote store that needs a different assertion changed the
  contract.
- **Read routes mounted twice.** `createStrut.test.ts`: the same list,
  summary, events, versions and source responses at `/…` and at
  `/peers/p/…`; a peer id not on file is a 404; the token is never in any
  response; write routes do not exist under `/peers`.
- **Scope.** With a `peer`-scoped caller: every read route serves, every
  gated route is 401, and no write route exists under `/peers`. With no
  `resolveScope`: byte-identical behaviour to today's suite.
- **Seed + export, offline against a local bare repo** (the `git/*`
  tests' fixture). `strut/seed` publishes the convention's files with
  `source` set and stamps nothing else; an identical reseed is a no-op; a
  local edit survives a reseed until the file changes (`workspace.test.ts`'s
  `reactivateKnown` cases, driven from a repo); a file removed from the
  repo retires only the workflow whose `source` names it, never a local
  creation. `export_workflow` pushes a branch whose files equal the
  published YAML and the closure's step sources; never touches the default
  branch; reads the actor's token through `secrets.get` (a run without one
  fails naming `GITHUB_TOKEN`); targets `source`, else `STRUT_HOME_REPO`,
  else the explicit arguments, in that order; refuses a `transformed` seed
  with the file named; and sets `source` on a first export. Round trip:
  export → fast-forward merge in the fixture → reseed is a no-op on the
  exporter and a new active version on a second strut seeded from the same
  repo. `github/create-pr` is asserted through a cassette, and the PR body
  carries the ledger.
- **Projection.** `projector` tests over a remote store: nodes land in the
  peer's namespace, `run_id` unchanged, `costUsd` carried; two peers with
  colliding run ids project without conflict; `skipSettled` skips on the
  second pass. Live graph case under `npm run test:graph`.
- **Peers.** `GET /peers` never returns a token; `STRUT_PEERS` loads at
  boot and a `PUT` replaces one record; a peer id not on file fails the
  step before any request leaves.
- **Dispatch-through.** Offline against an in-process peer (the client
  takes a `fetch`, and `strut.app.request` is one): the handle in
  `step.end`; cancel of the parent cancels the child (`run-control`'s
  cooperative assertions, across the two apps); a peer that refuses the
  actor, or answers `job_busy:`, fails the step with the peer's message;
  a tail cut mid-run reattaches with `?skip=N` and the step sees every
  event once; a reattach after the run finished returns the summary's
  result; a `job` given reaches the peer's launch body, and the caller's
  own `ctx.job` never does; the output's artifacts are tagged with the
  peer. When billing is taken up (step 8), end to end through the compose
  gateway (`npm run test:gateway`): the child run's calls land on the org
  gateway with the forwarded principal as `user_id` and the leaf's
  `workspace` dim, and a principal with no delegation on the leaf is a
  step error — the smoke script gains that case.
- **Costs.** `costUsd` on the summary equals `reportedCost` over the same
  run's events; absent on summaries written before the field.
- **Hive.** The selector route: a slug the user cannot access is 403; no
  slug is the org default; the delegation push targets the chosen swarm.

## What this changes in `plans/code-change.md`

**Nothing.** Its two rules are what this plan is built on: the handle
`(swarmId, workflow, strutRunId)` stays opaque and stable — a peer's run id
is the id the peer minted, and a rolled-up view names the peer by hive's
`swarmId` — and `resolveStrutTarget` stays the one place "which strut"
changes (§7 adds the `embed` purpose there and nowhere else). Actor-secret
pushes stay per target; delegations fan out per org (`plans/org-gateway.md`
§3). Two things are added beside it, not to it: a third push,
`ensureStrutPeers(target)`, for the org strut; and the `dims` on the
delegation push (`plans/org-gateway.md` §4). Hive continues to dispatch code-change runs directly to
the resolved swarm; dispatch-through (§2.2) is for workflows, not for hive.
Phase 2's `git/push` and `github/create-pr` gain a second consumer, the
export (§2.3) — one more reason to land them as the generic lib steps that
plan already describes, and the actor-secret push it specifies is exactly
what puts the exporting person's token on the swarm.

## Findings along the way

- Actor secrets on the lab are in-memory in graph mode (§6) —
  `mcp/src/lab/createLabStrut.ts:225-232` vs `src/createStrut.ts:473-476`.
- `resolveOrgSwarmWorkspaceForUser`'s fallback is an unordered `findFirst`
  and does not check `swarm.status` (`hive/src/lib/helpers/org-workspace.ts:82-85`);
  the selector's per-workspace path uses `getWorkspaceSwarmAccess`, which
  does.
- Hive's deep-link mirror ([stakwork/hive#5334](https://github.com/stakwork/hive/pull/5334),
  `hive@59a7e6b81`) carries `wf`/`run`/`v`/`chat` but not `elicit`
  (`StrutView.tsx:18`), so a host link to an open builder question does
  not survive a reload yet; `peer` joins the same list with read-through (step 5).
- The installed `gatekey` 0.1.1 lacks upstream's `Claims.chain`
  (`node_modules/gatekey` vs `gateway/auth/ts/src/types.ts:216-251`);
  `mothership.test.ts` decodes the chain by hand for that reason. Not
  blocking.

## Open questions

- **Reseed cadence.** Boot only (the lab today) or a scheduled
  `strut/seed`? Proposed: both, the schedule being an ordinary automation a
  deployment adds; a reseed while a run of that workflow is in flight
  publishes a version, which is what any publish does today.
- **Includes.** An export of a `transformed` seed is refused until
  `workspace-files-and-includes.md` lands; whether the export should
  instead write the expanded YAML over a file with includes is that plan's
  question, not this one's.
- **A step with two homes.** A custom step used by workflows from two
  repos is exported with the workflow that exports it first, which sets
  its `source`; a later export from the other repo leaves it alone.
  Proposed, not decided.
- **Namespace per peer vs per org on the central.** Per peer is decided for
  runs (collisions). For the library view, "the same template on forty
  swarms" is one `content_hash` across forty namespaces; if that query
  proves awkward, a `StrutWorkflowVersion` in a shared `library` namespace
  keyed by hash, with `EXECUTED` edges from every namespace, is a later
  projection, not a change to this one.
- **Qualification bar.** Three supported runs is a placeholder; the first
  library automation will say what the org's real distribution looks like.
- **Billing a cross-strut call** (§5): the fan-out or the presented grant.
  Deferred 2026-10-08; the explorer milestone does not wait on it.
- **How a local strut gets a peer record** beyond pasting: hive handing
  it over on the embed, or a desktop host minting it. The paste door is
  enough for the explorer case.
