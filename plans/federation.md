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
| Order | hive workspace selector → read-through → library pull → roll-up projection + the first reflection → dispatch-through. **Gateway chaining: not at all** (§5) |
| Peer identity | **Assigned by whoever registers the peer** — hive uses `swarmId`. No self-declared strut id (strut has none today and would have to coordinate one). A run's cross-strut handle is `(peer, workflow, runId)` as the reader names the peer: hive's handle, unchanged (§3, §4) |
| Version identity | `name` + `contentHash` — already the dedup key in both stores (`src/version.ts:9-11`; content-addressed version nodes, `src/graph/workspace-store.ts` header). Same YAML anywhere = same version (§4) |
| Peer credential | A bearer token the host pushes into a fourth encrypted `FileSecretStore` file, `peers.json` — the delegation and actor-secret pattern. Peers should hold a **read-scoped** token; today's tokens are all-or-nothing, and the fix is a `lab:read` JWT scope in mcp. A central strut never holds a swarm key (§3) |
| Actor across the chain | The same opaque string everywhere: hive derives it from the global `User` (`{login}-{id}`, `hive/src/services/bifrost/reconciler.ts:676-682`), so it is valid on every strut in every org. Forwarded as `x-strut-actor` on peer calls; the peer's own `resolveActor` decides whether to honor it (§3) |
| Cost | **Bill where the run executes**, against the delegation hive already pushes per target. Roll spend up by reading, through one new field, `RunSummary.costUsd` (§5) |
| Secrets | **Never cross a boundary.** A dispatch-through run reads the executing leaf's own deployment and actor secrets, pushed there by hive (§6) |
| Library | **Pull-only.** A pull is `publishWorkflowByContent(…, { reactivateKnown: false })` — the seeder's exact semantics — stamped `publisher: "peer:<id>"`. `WorkflowMetadata.visibility` (`private` \| `org` \| `public`, default `org`) says who may pull (§8) |
| Roll-up store | The existing projector over a remote `RunStore`, each peer into its **own graph namespace** on the central's Neo4j — uniqueness is already per `(node_key, namespace)`, so no schema change and no id rewriting. Summaries only: never events, transcripts, artifacts, secrets (§9) |
| Dispatch-through | A lib step, `strut/run-workflow`, later. The child runs on the peer under the peer's secrets and delegation; the parent's log records the handle; cancel propagates cooperatively. **Hive keeps dispatching directly** (§2.2) |
| Leaf independence | Nothing on a leaf ever awaits a peer: reads are initiated by the reader, the library is pulled, automations need no peer. A central being down costs a stale library, never a broken leaf (§10) |

## Design in one paragraph

A strut names the struts it may read as **peers** — `{ id, baseUrl, token }`
— pushed by its host the way delegations and actor secrets are pushed
today. `src/remote.ts` implements the read half of `WorkspaceStore` and
`RunStore` over a peer's existing HTTP API, so everything that already
consumes those interfaces works on a peer by being handed a different
store: the run list and drill-down, the SSE tail, `step-stats`, the
projector, the builder's `list_workflows` / `get_workflow`. The read routes
of `createStrut` are mounted a second time under `/peers/:id` over the
remote stores, the web UI grows a peer selector, and `peer` joins the
deep-link params. The builder gets `search_library` and `pull_workflow`;
a pull is the boot seeder's own publish call with the origin stamped as
provenance. A central strut is any strut with many peers whose automations
project their run summaries into its graph — one namespace per peer — and
run reflection workflows over the result. A run always executes, bills, and
reads secrets on the strut that holds the workflow; a strut that wants work
done elsewhere launches it there through a step and records the handle.
This is the shape the graph already federates by: a walker on the other
server, not a shared database (`plans/docs/paper.md:46-48`).

## 1. Vocabulary and tiers

| Tier | What it is today | What it becomes |
| --- | --- | --- |
| **Leaf** | A swarm's `/lab` strut: `createLabStrut` (`mcp/src/lab/createLabStrut.ts:213-233`), graph workspace by default on the swarm's Neo4j (`:158-162`), file-backed runs/chats/secrets under `STRUT_LAB_WORKSPACE` (`:225-232`), gated by `labAuth` on the swarm's `API_TOKEN` (`mcp/src/lab/mount.ts:124-138`), seeded inside `createLabStrut` (`:144-199`), which the mount builds on the first request (`mount.ts:10-14`) | Unchanged. It may gain peers if hive pushes some (a workspace that wants to browse a sibling), but nothing requires it |
| **Org strut** | The org's default workspace's leaf — `resolveOrgSwarmWorkspaceForUser` tries `defaultWorkspaceId`, else `findFirst` with no ordering (`hive/src/lib/helpers/org-workspace.ts:69-85`). Nothing in strut distinguishes it | The same leaf, with a peer per other swarm in the org, pushed by hive. It is where the org-wide runs view and the org library live |
| **Central** | Does not exist | An ordinary strut deployment (`src/server.ts`, the standalone image in `Dockerfile`) with peers across orgs, holding read tokens only, running the reflection automations of §9 |

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
| **(c) Library sync** | `publishWorkflowByContent` / `publishStep` with `reactivateKnown: false` (`src/workspace.ts:191-201`) — the seeder's own call | A library to learn from and contribute to; templates, params winners, retired steps flowing down | The seeder semantics, replayed against a remote source |
| **(d) Summary roll-up** | `projectRuns` — "a post-hoc consumer of any `RunStore`" (`src/graph/projector.ts:1-13`) — over a remote store | The long-horizon view; step regressions and params winners across the fleet | Projector tests over a remote store; a live graph case |

**(a) is the mechanism; (b), (c), (d) are consumers of it.** Order: (a)
first, then (c) and (d) which need nothing but reads, (b) last because it is
the only one that makes a strut act on another. Each ships alone (§Step
order).

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

### 2.2 Dispatch-through — `strut/run-workflow` (later)

Hive does **not** need this: it resolves the target once at dispatch and
calls that strut directly (`plans/code-change.md` §5, "Keeping the target a
policy"). The cases that do: an org workflow that runs a check on every
workspace's swarm; a central reflection that wants a fresh measurement on a
leaf; a builder on the org strut testing a template where the data lives.

A lib step under `src/steps/lib/strut/`:

- `strut/run-workflow { peer, workflow, input?, params?, version?, wait?: boolean }`
  → `POST {peer}/workflows/:name[/:version]/run` (`src/createStrut.ts:1897,1916`)
  with `x-strut-actor: ctx.principal`, then awaits the peer's SSE tail and
  returns `{ peer, workflow, runId, status, output?, error?, durationMs }`.
  The tail is reader-initiated, so the peer never needs a route back to the
  caller (a callback would). `wait: false` returns the handle at once.
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
  (`src/steps/lib/meta/run-workflow.ts:29-35`).
- **Hive's handle if hive ever dispatched through an org strut:** the row
  would hold the org strut's `(swarmId, workflow, runId)`, the leaf run
  being that run's child; the org run's own callback fires when it ends.
  Opaque and stable either way, which is all `code-change.md` requires.

### 2.3 Library sync — pull, never push

The boot seeder is already a library sync with one source (the mcp source
tree): content-hash reconciliation, `reactivateKnown: false` so a local edit
stays active until the template itself changes, `RETIRED_STEPS` for
removals (`mcp/src/lab/seed-opts.ts:13,26-34`). Generalizing the source
from "a directory in the image" to "a peer" is the whole mechanism:

```
pull(peer, name, { as? }):
  flow      = peer.workspace.getWorkflow(name)                 // active version
  closure   = flowClosure(flow, peer.workspace)                // src/closure.ts — subflows, agentTools grants
  for each custom step type in closure the local registry lacks:
      publishStep(type, peer.getStepSource(type).code, desc, "peer:<id>", { reactivateKnown: false })
  publishWorkflowByContent(as ?? name, peer.getWorkflowSource(name, active), desc, category,
                           "peer:<id>", { reactivateKnown: false })
  claims    = peer.claims({ kind: "workflow", name })          // → the additive `claims` publish arg, when the local layer is on
  → { name, version, changed, steps: [...], claims: n, originHash }
```

- **Provenance is the publisher stamp** — `peer:<id>` on the workflow and
  on every step it brought. Whether a copy is current is a hash comparison
  (`getWorkflowHash` here vs there), so no new field.
- **Name rules.** Same name + same content: a no-op (the seeder's). Same
  name + `peer:<id>` stamp + different content: a re-pull publishes the
  next `vN` and activates it, and a local edit made since stays active only
  if the origin did not change — the seeder's rule, stated at
  `src/workspace.ts:191-201`. Same name + any other stamp or unstamped
  (a seeded baseline): **refused** unless `as: <newName>`. A pull never
  overwrites something it did not bring.
- **The meta surface treats a pulled workflow like a seeded one.** The
  authoring capability edits, runs and reads runs of `ai`-stamped workflows
  only (`src/authoring.ts:9-27`), so an evolve loop that wants to improve a
  pulled template must fork it under a new name — exactly what it does with
  a seeded baseline today. The chat tools, which a person supervises, can
  edit it in place; that edit is a local version with the seeder's survival
  rule above.
- **Claims come along, checks resolve locally.** A check names a step type
  (`plans/claims.md` §Nodes); pulling the closure first is what makes the
  pulled checks runnable. A check whose closure still does not resolve is
  the `unknown` case the ledger already shows.
- **Down-sync is the same call from the other side**: a leaf's automation
  pulls `visibility: public` (or org) templates from the org strut's library
  on a schedule. Retirement flows the same way: a library entry marked
  retired is soft-deleted on pull like `RETIRED_STEPS`.
- **No push.** A leaf never needs write access on a central, a central
  never needs a route to a leaf, and "contribute" becomes "mark it
  pullable" (§8).

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
reconciled by the delegations cron when members and swarms change.

**Identity.** A peer is named by the strut that holds the record. Hive
names them by `swarmId`, so a handle a central records is the handle hive
stores. Strut does not declare an id for itself: mcp has none to give it,
and a self-declared one is a global namespace with nobody administering
it. The one place this bites — a child run naming its caller — is the
deferred `launchedBy` stamp of §2.2.

**Credentials and scope.** The honest state: a peer token is either the
swarm's `API_TOKEN` (`x-api-token`, full access to `/lab`) or a JWT mcp
mints from it with `scope: "api"` (`mcp/src/index.ts:204-223`,
`mcp/src/repo/events.ts:63-80`) — also full access. A central that reads
forty swarms would hold forty full keys, and a swarm key is admin of that
lab (register a step that reads any secret). So:

- **mcp: a `lab:read` scope.** `/mint-token` gains `scope: "lab:read"`;
  `labAuth` accepts it for `GET` and the SSE stream only, and the actor is
  still the JWT's `sub`. Long-lived (60 days, the delegation's lifetime),
  re-minted by hive's cron. This is the token hive pushes as a peer token.
- **strut: `createStrut({ resolveScope?(c) → "full" | "peer" })`**, the
  twin of `resolveActor` and the only new hook. Default: `"full"` — today's
  behaviour, unchanged for every existing deployment. mcp passes a hook that
  maps the JWT scope. Standalone deployments that want peers can set
  `STRUT_PEER_KEY`, a read-only twin of `STRUT_API_KEY`; nothing else in
  strut learns a new kind of auth. A `peer`-scoped caller may read; what it
  may read of the library is `visibility`'s job (§8). The gated routes
  (`requireApiKey`, `src/auth.ts:38-46`) already refuse it.
- **Milestone 2 may ship before the scope exists.** The org strut is one of
  the org's own swarms, and hive already holds every key in the org; hive
  pushing full tokens to it adds no new class of exposure (one swarm holding
  its siblings' keys is new; a stolen org strut is already an org-wide
  problem). A cross-org central waits for the scope — it must never hold
  a swarm key.

**Actors across the chain.** One string per person everywhere — hive's
actor is built from the global `User` and the GitHub login, not from any
workspace (`hive/src/services/bifrost/strut-delegation.ts:145-154`), and the
macaroon `user_id` is the same string (`hive/src/services/bifrost/macaroon-issuer.ts:241-258`).
Across orgs it still does not collide. A central resolves actors the way
any strut does — its host's hook; standalone, `x-strut-actor` with the key
(`src/auth.ts:70-74`). What an actor may *do* on a peer is decided by the
peer, from the credential, never from the forwarded name.

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

## 5. Cost across the chain — no gateway chaining

**What exists is already the right shape.** One Bifrost per swarm at
`:8181` (`hive/src/services/bifrost/resolve.ts:39-54`); one VK per
(workspace, user) in that swarm's Bifrost (`hive/prisma/schema.prisma:359-367`);
one org signing key per `SourceControlOrg` (`hive/src/services/bifrost/macaroon-org-keys.ts:63-153`)
registered in every swarm's trust registry (`hive/src/services/bifrost/trust-reconciler.ts:352-385`);
one standing delegation per (user, swarm) pushed to that swarm's strut
(`strut-delegation.ts:301-356`). The gateway's own design says this is the
model: one macaroon presented directly to each swarm
(`gateway/plans/cryptographic-identity.md:43-51,589-593`), and a "central
aggregator" that **imports logs after the fact, not a gateway in the path**
(`gateway/plans/phases/phase-11-symmetric-recursive-authorization.md:284-286,502-507`).

So a leaf run launched from an org strut (§2.2) is billed like any run on
that leaf: the leaf's mothership finds the forwarded principal's delegation
in its own `mothership.json` (`src/mothership.ts:69-77`), appends its run
and step links (`:274-294,326-337`), and calls the leaf's gateway with the
leaf VK. Which macaroon: the one hive pushed to *that* target. Attenuated by
whom: that leaf's strut. Presented to which gateway: that leaf's. Nothing
new anywhere — "pushes are per target" is the rule `code-change.md` §5
already states, and `STRUT_MOTHERSHIP_REQUIRED=1` (set by sphinx-swarm)
makes a missing delegation a step error rather than a direct call.

**Why not chain gateways** (leaf gateway → org gateway with a further HMAC
link). The chain math allows it — a link is keyless and an org gateway that
trusts the same org key would verify the whole chain
(`gateway/auth/ts/src/attenuate.ts:45-51`, `gateway/auth/go/verify.go:272-328`)
— and everything around the math does not:

1. Nothing sends a macaroon outbound. The plugin reads `x-macaroon`
   inbound only (`gateway/internal/hooks/transport_prehook.go:57-58`);
   providers are the real APIs with real keys (`gateway/data/config.json:14-65`);
   the wrapper's only upstreams are the local bifrost-http and plugin
   server (`gateway/wrapper/main.go:81-93`).
2. A link cannot say "via swarm L": caveats are a fixed struct, re-marshaled
   before the HMAC, so any extra field fails `attenuation_invalid`
   (`gateway/auth/go/types.go:162-170`, `jcs.go:16-26`, `hmac.go:15-23`),
   and the TS verifier would accept what Go rejects (`auth/ts/src/verify.ts:300`)
   — a wire-format bump either way.
3. One `realm_id` per gateway; a macaroon carrying leaf realm budgets hits
   `realm_not_permitted` at the org gateway (`gateway/internal/auth/enforcement.go:142-185`).
4. Two gateways, two Redis stores under one fixed `bifrost:` prefix
   (`gateway/internal/redisclient/client.go:47,158`): the same call counted
   twice, caps enforced twice on different totals, kills and revocations
   that do not propagate, two transparency-log leaves per call.

Every one of those is gateway work whose only payoff is a cap that spans
swarms — which nobody has asked for, and which the per-user daily customer
budget per swarm and the per-(user, swarm) delegation ceiling already
bound. **Decided: gateways stay per swarm.** Revisit only if an org-wide
per-user cap becomes a requirement; the honest version of that is a shared
Redis with a per-gateway key prefix, not a chain.

**Rolling spend up instead.** Two reads, no gateway change:

- **`RunSummary.costUsd`** (§2.4) — what strut knows from its own steps'
  reported cost, per run, on the summary. The central's projection carries
  it; "what did this workflow cost across the org last month" is a query
  over `StrutRun` nodes. This is the number the reflection loop uses, and it
  does not need any gateway credential — the mothership plan already ruled
  the provisioning token out of strut's hands (§Non-goals there).
- **A `swarm-id` dim for the gateway's own view.** Any `x-bf-dim-*` header
  passes through and lands on the log row (`gateway/internal/pluginctx/dims.go:41-79`);
  `root-agent` is such a dim today, unknown to the gateway
  (`src/mothership.ts:339-351`). Hive knows the swarm id and already pushes
  the delegation, so `PUT /llm/delegations/:actor` gains an optional `dims`
  map strut sends on every call (`x-bf-dim-swarm-id`, `x-bf-dim-org-id`
  when hive wants it — `org-id` is signature-bound and canonicalized from
  the claims on verified traffic, `dims.go:113-176`). Hive's Gateway tab
  then groups by swarm with a one-line addition to the plugin's filter list
  (`gateway/internal/adminapi/observability.go:899-918`; Bifrost's
  `/api/logs` already accepts any `metadata_<key>`, `logstore_client.go:198-203`).
  Billing dims then read `org → swarm → workflow (session-id) → step
  (agent-name)` from one gateway's log, no chain required.

What changes: strut, one summary field and one optional `dims` on the
delegation record; hive, the `dims` in its push; the gateway, one filter
key (optional). `src/mothership.ts`'s links do not change, and
`mothership.test.ts`'s chain assertions stay exactly as they are.

## 6. Secrets across the chain

Confirmed, and made a rule:

- **Deployment secrets and actor secrets never leave the strut that holds
  them.** A dispatch-through run resolves `secrets.get(NAME)` on the peer,
  bound to the forwarded principal (`SecretsCapability.forPrincipal`,
  `src/actor-secrets.ts` header) — so the peer must already hold that
  actor's `GITHUB_TOKEN`, which is hive's `ensureStrutActorSecret(target,
  actor)` before dispatch (`plans/code-change.md` §3.2), per target. A
  central never pushes one.
- **Read-through carries no secret.** Run logs mask `secretsEnv` values
  (`specs/EVOLVE_SPEC.md` §4.3), `GET /secrets` and `GET /actors/:actor/secrets`
  return names only (`src/createStrut.ts:1446-1451,1490-1497`), and
  `mothership.json` / `peers.json` have no read route at all.
- **What a central strut is not allowed to hold:** any swarm's `API_TOKEN`
  (admin of that lab); any actor secret (it runs nobody's coding
  workflows); any user's delegation *for a leaf* (a leaf's mothership file
  is the leaf's); raw transcripts or artifacts of peer runs (summaries
  only, §2.4). What it does hold: read tokens per peer; its own provider
  keys or its own delegations for the operator actors that own its
  reflection automations (their spend is the owner's, the principal rule);
  its own graph.
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

Three verbs — **search, pull, contribute** — over the peers the builder's
strut has, plus the visibility rule that keeps org IP where it belongs.

**Search.** `search_library({ query, peer? })`: for each peer (or one),
`listWorkflows` + a word matcher over name, description and category —
the rule `web/src/step-search.ts` applies to step types (every word must
hit), applied to workflows, server-side beside `searchSteps`
(`src/ai/stepHelpers.ts:177`) — ranked, returning per hit `{ peer, name, description, category, activeHash,
runs: { total, success, lastAt }, claims: { supported, refuted, unknown } }`
from the peer's summaries, claims and versions endpoints. The builder reads
descriptions and claim ledgers before it reads YAML; a hit with a supported
contract on many runs outranks a bare description. `get_workflow` and
`get_step` gain `peer?` so the YAML and step sources can be read where they
are. Graph hybrid search across peers is not v1: the central's projection
(§2.4) is where cross-fleet semantic search belongs, one graph, later.

**Pull.** `pull_workflow({ peer, name, as? })` = §2.3, returning what it
published and the claims it brought. The prompt gains one section,
"Library": search before authoring; a pulled workflow is a baseline with
provenance — cite the peer and hash when you build on it; to change it,
`edit_workflow` publishes a local version (a person is in the loop), while
an in-run author (`meta/*`) must fork under a new name, as with seeded
baselines. `meta/search-library` and `meta/pull-workflow` are the twins so
an evolve loop can start from the org's best-known version of a template.

**Contribute** is pull-only from the other side (§2.3): the org strut's
library automation pulls what qualifies; a person on the org strut curates
(category, retire). What qualifies is read from the leaf, never asserted
by it: `visibility` is `org` or `public`; the active version has at least
one claim and every active claim is `supported` on that version with
evidence from ≥ 3 runs (`buildLedger`, `src/ledger.ts:63`); no `agentTools`
grant outside core, lib and the steps it brings; and — the fixed point that
carries over from `plans/claims.md` §4.1 — evidence that is `asserted`-only
does not count. An `ai`-stamped candidate qualifies exactly like a
human-published one; its stamp travels with it, so the receiving strut's
meta surface treats it the same way. Hill-climbing a contract to get pulled
is the train-set problem `EVOLVE_SPEC` §7 answers with held-out validation,
which the central can run (§9). Who approves: the org strut's owner of the
library automation, by leaving it enabled, and anyone with the key, by
retiring an entry. No inbox, no review UI in v1; the sidebar's `publisher`
stamp and the ledger are the review.

**Visibility.** `WorkflowMetadata.visibility?: "private" | "org" |
"public"`, metadata-only like `category`, `owner`, `automations`
(`src/workspace.ts:154-166`), one optional attribute on `StrutWorkflow`
(add-only schema change, the AGENTS.md convention), settable by the owner
or the key (`PUT /workflows/:name/visibility`, a chat tool
`set_workflow_visibility`, the Workflow flyout). Default **`org`**: the
workspace's swarm is in an org, and the org's struts are the only peers
hive pushes to each other — a workspace's workflow is not public unless the
owner says so, and is invisible to the org only when the owner says that.
Enforcement is on the *serving* strut, by caller scope (§3): a
`peer`-scoped caller sees source, versions and claims of `org` and `public`
workflows only (`private` ones list as name + description, no source, no
pull); a `full` caller (hive, the UI, the deployment) sees everything as
today; `public` workflows are additionally served by `GET /library` with no
credential — the one unauthenticated read strut gains, the Stakwork-level
library's feed. Runs and summaries are not governed by the flag: they are
governed by who holds a token, which is the org boundary hive draws when it
pushes peers.

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
| What the fleet **spends**, by org → swarm → workflow → step | `costUsd` on summaries; the gateway's per-swarm view for the LLM-side truth (§5) | `mothership-cost-control.md` §6 |

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

**What flows back down.** Two things only, both pulls: the library (a
promoted template, a params default worth adopting, a retired step); and
the report, which a leaf's builder can `search_library` for and read like
any other document — no new channel. A leaf that ignores the central loses
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
- **No gateway chaining** (§5).
- **No new server kind** (§1).

## Non-goals (v1)

- Cross-fleet hybrid search from a leaf (search is per peer, name and
  description); it belongs on the central's graph.
- A review inbox for contributions; approval is curation on the org strut.
- The reverse edge from a child run to its cross-strut caller
  (`launchedBy`).
- An org-wide per-user spend cap (needs a shared counter, §5).
- Callbacks from a peer to a caller; dispatch-through tails instead.
- Peer views inside the *chat* flyout (a peer's chats are that swarm's).
- Anything about swarm ↔ swarm graph federation beyond what the paper
  already describes; this plan is about strut's records.

## Step order

1. **Hive: the workspace selector** (§7). `embed-url?workspace=`,
   `resolveStrutTarget({ purpose: "embed" })`, the select in `StrutView`,
   the URL state. Lands with `code-change.md` phase 3, which introduces the
   resolver. No strut change. Useful alone: any workspace's strut, from the
   org page.
2. **Strut: read-through** (§2.1, §3, §4). `src/remote.ts`; `peers.json` +
   `PUT/DELETE/GET /peers`; `mountReadRoutes` mounted at `/` and
   `/peers/:id`; `RunSummary.costUsd`; the UI peer selector, read-only
   mode, `peer` deep link. Hive: `ensureStrutPeers` for the org strut.
   Useful alone: "any strut could view runs and workflows from other
   struts", and the org-wide view in hive.
3. **mcp: `lab:read`** and **strut: `resolveScope`** (§3). Small, and the
   precondition for a peer that is not one of the org's own swarms.
4. **Library pull** (§2.3, §8). `pull_workflow` / `search_library` chat
   tools and `meta/*` twins; `visibility` (metadata, schema attribute,
   route, tool, flyout field); `GET /library`; the org library automation
   with the qualification rule. Useful alone: the builder learns from the
   org.
5. **Roll-up projection + the first reflection** (§2.4, §9). The
   projector over a remote store into a per-peer namespace; the projection
   automation; one weekly reflection workflow producing the report and its
   claims. Useful alone: the long view, on the org strut first.
6. **Dispatch-through** (§2.2). `strut/run-workflow` with control
   propagation; the UI drill-through over `/peers/:id`.
7. **Gateway dims** (§5), whenever hive wants swarm grouping in its
   Gateway tab: `dims` on the delegation push, the filter key in the
   plugin.

1 and 2 are independent. 3 gates cross-org peers, not 4 or 5 within an
org. 6 depends on 2 only.

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
- **Scope.** With a `peer`-scoped caller: `private` workflows list without
  source and refuse `/:version` and pulls; `org` ones serve; gated routes
  401. With no `resolveScope`: byte-identical behaviour to today's suite.
- **Pull.** Against an in-process peer: a first pull publishes the closure
  (steps first) and the workflow, stamped; an identical re-pull is a no-op;
  a local edit survives a re-pull until the origin changes (the seeder
  case, `workspace.test.ts`'s `reactivateKnown` cases replayed remotely);
  same name under another stamp is refused without `as`; claims arrive and
  their checks resolve.
- **Projection.** `projector` tests over a remote store: nodes land in the
  peer's namespace, `run_id` unchanged, `costUsd` carried; two peers with
  colliding run ids project without conflict; `skipSettled` skips on the
  second pass. Live graph case under `npm run test:graph`.
- **Dispatch-through.** Offline against an in-process peer: the handle in
  `step.end`; cancel of the parent cancels the child (`run-control`'s
  cooperative assertions, across the two apps); a peer that refuses the
  actor fails the step with the peer's message. End to end through the
  compose gateway (`npm run test:gateway`): the child run's calls bill
  under the *leaf's* delegation with the forwarded principal as `user_id`,
  and a principal with no delegation on the leaf is a step error — the
  smoke script gains that case.
- **Costs.** `costUsd` on the summary equals `reportedCost` over the same
  run's events; absent on summaries written before the field.
- **Hive.** The selector route: a slug the user cannot access is 403; no
  slug is the org default; the delegation push targets the chosen swarm.

## What this changes in `plans/code-change.md`

**Nothing.** Its two rules are what this plan is built on: the handle
`(swarmId, workflow, strutRunId)` stays opaque and stable — a peer's run id
is the id the peer minted, and a rolled-up view names the peer by hive's
`swarmId` — and `resolveStrutTarget` stays the one place "which strut"
changes (§7 adds the `embed` purpose there and nowhere else). Pushes stay
per target. Two things are added beside it, not to it: a third push,
`ensureStrutPeers(target)`, for the org strut; and an optional `dims` on the
delegation push. Hive continues to dispatch code-change runs directly to
the resolved swarm; dispatch-through (§2.2) is for workflows, not for hive.

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
  not survive a reload yet; `peer` joins the same list in milestone 2.
- The installed `gatekey` 0.1.1 lacks upstream's `Claims.chain`
  (`node_modules/gatekey` vs `gateway/auth/ts/src/types.ts:216-251`);
  `mothership.test.ts` decodes the chain by hand for that reason. Not
  blocking.

## Open questions

- **`private` and hive.** Should a `full`-scoped caller that is another
  swarm's strut (milestone 2 before the read scope) be able to pull a
  `private` workflow? Proposed: yes, because it holds the swarm key and the
  flag is about peers — but that is exactly why the read scope should land
  before a central exists.
- **Namespace per peer vs per org on the central.** Per peer is decided for
  runs (collisions). For the library view, "the same template on forty
  swarms" is one `content_hash` across forty namespaces; if that query
  proves awkward, a `StrutWorkflowVersion` in a shared `library` namespace
  keyed by hash, with `EXECUTED` edges from every namespace, is a later
  projection, not a change to this one.
- **Qualification bar.** Three supported runs is a placeholder; the first
  library automation will say what the org's real distribution looks like.
