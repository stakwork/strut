# Public surface — what a strut server shows anyone, live

> **Status (2026-11-04): proposed.** From one design conversation with the
> owner. Rows in "Decided" marked **ruled** are his words; rows marked
> *agreed* are proposals of mine he accepted ("ok this makes sense"); every
> other row is *proposed*. Nothing here is built. Written against strut
> `main` @7669cbe, stakgraph `main` @c323be4f and sphinx-swarm `main`
> @220b6c1a. Companion to `marketplace.md` (packages: the copy side, which
> this leaves as it is), `apps.md` (what an app is and what it may call),
> `app-releases.md` (the held release a public app serves),
> `federation.md` §2.1 (read-through, which this builds the first half of),
> `proposals.md` (the suggestion door reuses its records) and
> `concept-tree.md` (the generated Codebase tree, the first living tree to
> put in the public view).
>
> **Named PUBLIC VIEW (ruled 2026-11-04):** the live, read-only list is the
> server's public view, and its UI the **Public view** dialog. Nothing in
> it is PUBLISHED: publishing records a version (a workflow, step or app)
> or a package release, a copy by digest, and the Packages dialog's **Make
> public** puts a release in the public catalog. Adding an item to the
> public view copies nothing; visitors read the live item under `/public`,
> and taking it out closes it again. The routes keep `/public`, the record
> `public.json`; "the surface" below is the same thing.
>
> **Item 1 BUILT 2026-11-04** (uncommitted at writing): `src/public-surface.ts`
> (the record, the Concept trees, the visible-node rule, the filtered
> reader), `src/public-routes.ts` (the `/public` reads, CORS, a per-address
> budget of 1200 a minute), the record's door and the gate in `createStrut.ts`,
> `effect: "read"` on the `run/*` and graph read steps, `specs/API.md` §17.
> One choice beyond the text: a run id under `/public` must be one path
> segment, so it cannot name another workflow's run through the file
> store's directories.
>
> **Items 2 and 6 BUILT the same day, in the same PR** (ruled: "keep it
> in the same PR, it's really part of the same work product"): a public
> app (`/public/apps[/:name[/document]]`, `POST /public/mcp`, held at the
> version it shows when it is added), the kit's `useHost().public`,
> SoloApp's `&public=1`, `LaunchForm` disabled there with a line saying why,
> and the **Public view** dialog with its cascade (`src/public-view.ts`,
> `GET /public-view/needs`). Choices beyond the text: the record's door
> moved to `/public-view` (GET, PUT, `needs`), so nothing under `/public`
> is a person's; a visitor's page carries its OWN identity, signed over
> `public-app:<name>@<vN>`, which opens `POST /public/mcp` for that app and
> no private door or file route; `app/state` is refused to a visitor (the
> kit keeps a refused write on the page, so its state lasts the visit);
> `graph/find` and `graph/query` are not visitor reads (they read the
> engine past the filtered reader); a job run's files are closed through
> `run/files` as through the routes.
>
> **Item 4 BUILT (the index side), after #483 merged:** a LIVE row is its
> own map on the index card, `live: { <prefix>: { url, description? } }`
> beside `publishers` — not a field of a package row, because a reader that
> knows only `publishers` refuses a row with no key or catalog, and a
> server needs neither to be listed live. `PUT /index/live/:prefix`, read
> at the row and with every crawl (`<url>/public`, `<url>/public/concepts`;
> a failed read keeps the last one), `GET /index/live` open to anyone, the
> live trees folded into `/index/concepts`, and the store's Live apps,
> Live workflows and steps, a page per live item read from its publisher in
> the visitor's browser, and a live Concept's docs read from there. Not
> yet: a publisher's ping when its view changes (the poll reads it), live
> items in `llms.txt` and the index's MCP tools.
>
> **Scoped the same day, ruled:** openlaw-1 viewable by anyone through the
> index comes FIRST. v1 is the public surface on the publisher's server
> (§2–§5), then the index showing it (§8). Contributions and history (§7),
> custom domains (§9) and the agents' door on a publisher (§6) come after.
> "Work items" is in that order; the open questions are answered or
> deferred in place.

## Problem

The store at index.sphinx.chat lists COPIES. A publisher builds a package,
the index reads its archive at one digest, and a visitor installs that
snapshot (`marketplace.md` §7, "the store front"). That is right for a
workflow someone wants to run on their own server, with their own data,
keys and budget. It is wrong for what the owner calls a "marketplace of
ideas":

- **Knowledge is meant to evolve where it lives.** The Concept tree on a
  home (the Codebase tree, the `Job` and `Workflow Builder` kinds, the Law
  tree on openlaw-1) is edited by the people who maintain it and read by
  everyone else. Exporting 200 pages into a package freezes them at one
  digest; the next edit at home never reaches the store.
- **Workflows, tools and apps evolve too.** They already keep their
  versions on their home (`vN`, an active one, an app's held release); the
  store only ever sees the ones someone packaged.
- **There is no way to SEE anything.** A visitor cannot open the
  openlaw-benchmarks app, read a workflow's runs or a Concept page without
  a credential for openlaw-1. With `STRUT_API_KEY` set every route is
  behind the key (AGENTS.md "Auth"); the only open reads are the index
  role's (`INDEX_READ`, `src/createStrut.ts:832`) and a public catalog
  (`publicPackageRead`, `src/auth.ts`).
- **A read-only app is not a grant you can write today.** An app's grants
  name step types and workflows (`grantRefusal`, `src/apps/tools.ts:144`).
  They decide what may be CALLED, not what may be SEEN, and they include
  launches. openlaw-benchmarks grants `graph/graph-search` (the whole
  graph), `sheets/get-values` (any sheet the service account can open, by
  id), every run read of two workflows, and `run/launch` of a workflow that
  costs about $30 a run.
- **Step labels cannot carry it.** `effect: "read" | "write"` is optional
  (`src/core.ts:52`): 19 lib steps declare `read`, 17 `write`, and most of
  `run/*` and the graph reads declare nothing. A custom step's label is
  whatever its author (often the builder) wrote, `http` depends on its
  method and URL, `agent` on its tools, `exec` on anything.

## Decided

| # | Decision | Who |
|---|---|---|
| 1 | The app, workflows, tools and Concepts are accessible in a view-only mode. "That is essential." | **ruled** |
| 2 | View-only means no launches: nothing a visitor does starts a run or writes. | **ruled** |
| 3 | Knowledge is a living thing: some people contribute to it, others read it (people through apps, external agents). "The point is the evolution of knowledge, not exporting a snapshot to the Store." | **ruled** |
| 4 | Generic: Concepts, workflows, tools and apps all evolve; the model is one model for all four kinds. | **ruled** |
| 5 | Both ways stay: download and install a copy, and view live data read-only. "A flexible architecture that can work any way." | **ruled** |
| 6 | A server's PUBLIC SURFACE is chosen by a person, server-wide, item by item; nothing is public until someone makes it so. | *agreed* |
| 7 | Read-only is ENFORCED at run time by what a step is handed, never trusted from a label. Labels predict; the services view decides. | *agreed* |
| 8 | What a visitor can SEE is the surface, separately from what a step may do: a read of something not on it is "not found". | *agreed* |
| 9 | The index lists both: live items (a publisher's surface) and copies (its releases). | *agreed* |
| 10 | Maintainers write where an item lives; others SUGGEST, and a maintainer accepts. Anonymous visitors never write. | *agreed* |
| 11 | Concept pages get a history (who changed what, when, why, and a way back), as workflows, steps and apps already have. | *agreed* |
| 12 | "Open live" is one page on the publisher's server; the store frames it, a link opens it whole, a custom domain gives it an address. | proposed |
| 13 | Public reads are a route family of their own, `/public/*`, that serves only the surface whatever the gate's mode: a route nobody mounted there does not exist there, and a host's gate passes the prefix by path. The same read handlers, mounted over filtered stores, where they can be. | **ruled** ("Keep /public", after weighing the same routes with an anonymous scope) |
| 14 | A custom domain goes through one edge box (Caddy) in front of the swarms, not through each swarm's Traefik. | proposed; deferred with §9 ("probably one central one connected to hive") |
| 15 | Order: the public surface first, then the index showing it, to get openlaw-1 viewable through the index as soon as possible. Contributions and history, and custom domains, later. | **ruled** |
| 16 | A public run shows its input whole. | **ruled** |
| 17 | A public step shows the helper files it imports, beside its own source. | **ruled** |
| 18 | Whether actors appear in public version and revision lists is deferred; until it is decided, public views carry no actor. | **ruled** (deferred); the v1 default is mine |
| 19 | The name: the PUBLIC VIEW (the **Public view** tab), never "publish" or "make public", which are the copy side's (a version, a package release, the Packages tab's **Make public**). | **ruled**; 2026-11-04: the topbar's **Packages** and **Public view** are one **Publish** button, a dialog with those two tabs — the umbrella is the topbar's way out of the server, and the thing keeps its name |
| 20 | Adding an item to the public view cascades in the dialog, explicitly: an app pre-checks its granted workflows with runs, their custom steps, its reads and the Concept roots its workflows read (`context/concept`); the record lists everything. | *agreed* ("yes that right") |
| 21 | In the public view, a control a visitor cannot use is DISABLED, never hidden ("we dont need to hide stuff... buttons should be disabled"). | **ruled** |

## Design in one paragraph

A person marks items public on their server: Concept roots (the subtree
under each), workflows (with or without their runs), steps, and apps (each
at a held release, optionally with a domain). The server lists them at `GET
/public` and serves them under `/public/*`, open to anyone, with CORS open,
and nothing else: a graph read through that door sees only the nodes the
surface makes visible, a run read only the runs of a workflow whose runs
are public. A public app's page calls `step_run` on `POST /public/mcp`,
where every call runs under a READ-ONLY services view (no graph writers, no
shell, no files, no launches) built the way `bindGraph` and `bindApp` build
a run's view today, and only the reads the person allowed when making it
public. The index's rows gain the publisher's live URL; it crawls each
surface beside each catalog, and the store shows every item with **Open
live** (an app framed from the publisher's server, a workflow, step or
Concept drawn from its live JSON) and, when a release holds it, **Install a
copy**. Contributors with a person token suggest changes as proposals the
home's maintainers decide; Concept pages gain a revision log so the tree's
evolution is visible and reversible. A domain maps to one public app: the
edge box terminates TLS and forwards to the swarm, which serves that app's
page at `/`.

## 1. Two ways to share one thing

| | Live (by reference) | Copy (by value) |
|---|---|---|
| What | An item on its home's public surface | A package release, pinned by digest |
| For | People in the store or an app; external agents; other servers reading through | A server that wants to run it, fork it, or keep working offline (Peel) |
| Changes | Edited at home; every reader sees the current version or the held release | Install, follow a channel, fork (`marketplace.md` §3, §4, §12.1) |
| Trust | The publisher's server over TLS, named by the index row for its key | The publisher's signed card and the archive's digest |
| Built | No | Yes |

A package stays the right container for what a server RUNS, and for the
few Concept pages a package needs in order to work (its manual). The
knowledge base itself is live. The two meet: a release can be cut from
items that are public (the build reads the same workspace), and the store
says which release holds a live item.

## 2. The surface

One record per server, a person's act, plain JSON (nothing in it is a
secret): `<dataDir>/public.json`, beside `packages/indexes.json`.

```json
{
  "concepts": ["Codebase", "Law"],
  "workflows": [{ "name": "openlaw-run", "runs": true }],
  "steps": ["openlaw/list-tasks"],
  "types": [],
  "apps": [{ "name": "openlaw-benchmarks", "reads": ["openlaw/list-tasks", "openlaw/task-details", "openlaw/runs"], "domains": ["openlaw.ai"] }]
}
```

- **One file, not a flag per item.** One place to answer "what does this
  server show anyone", one read for every `/public` request, one door to
  audit. An item deleted or renamed while listed is skipped by every read,
  and `PUT /public-view` answers with what the record names that the server
  does not hold.
- **A Concept is public by ROOT**: the root and every page under it by
  `PARENT_OF`, live. A page moved out of the subtree stops being public; a
  page created under it starts. That is what makes the tree living: the
  maintainers keep editing, and the public edge of it moves with them.
- **A workflow** shows its definition (the active version's YAML and flow,
  its `input:` block), its version list and its claims status. `runs: true`
  adds its runs: summaries, events, transcripts and files, whole. That is
  everything a run's input and its agents saw, so the dialog says so in
  those words.
- **A step** shows its description, input and output schemas, `effect`,
  the secrets it names (names only), its source and its versions. Its
  source is the idea, so it is shown, with the helpers it imports (the
  `_`-prefixed files its relative imports reach, the set a package build
  collects).
- **`types`**: node types whose nodes are public whole (an app's own
  declared types, a `Document` set), for a server that wants that.
- **An app** is public at a HELD release (`app-releases.md` §1: making an
  app public holds it at the version shown, as pinning does). A builder's
  later publish is a draft; the public page changes only when a person
  moves the release. `reads` is §5's list. `domains` is §9's.
- **The door**: `GET`/`PUT /public-view` (full scope only; a person, never the
  builder or a `meta/*` step: the surface is the owner's decision as a
  sealed grant is, `src/apps/grants.ts`). In the UI, the **Public view**
  tab of the topbar's **Publish** dialog, beside **Packages**: what this server shows anyone, each item
  with its options, and an add box per kind. Each item's own flyout shows a
  "Public view" badge that opens the dialog on it.
- **The dialog cascades, in the open** (agreed 2026-11-04). Adding an item
  pre-checks what it needs to be read, every line with what it exposes,
  and Save writes the whole list, so the record stays explicit: a later
  app release that grants one more workflow never widens the public view
  by itself. Adding an APP pre-checks the workflows it grants, with their
  runs (the app reads them); the custom steps those workflows and their
  subflows run, and the app's own granted reads (§5's `reads`); and the
  Concept ROOTS those workflows read. A workflow names its root with
  `context/concept { name }` (`job.yaml`, `orchestrator.yaml` and
  `builder.yaml` read `"{{ params.concept }}"`), or a `graph/graph-get`
  with a literal `node_type: Concept` and `name`: a literal or a `{{
  params.X }}` read off the params' defaults is known up front, the way
  `closure.ts` reads a `{{ params.tools }}` grant; a name from `{{ input.*
  }}` is chosen per run (`job.yaml`'s `{{ input.kind }}`, a page under
  `Job`), and the pages a public run did read are visible through it
  anyway (§4). A root brings its WHOLE subtree, so each pre-checked root
  says how many pages it holds (`Codebase` is every repository and feature
  page). Adding a WORKFLOW pre-checks its custom steps and its roots the
  same way. A person unticks what they do not mean.
- **Computed beside each item** in `GET /public`: `can: { spends, acts,
  code }`, the fold the store does over an archive today
  (`src/packages/detail.ts:242`), moved to a module both use, so the store
  and the dialog say the same thing about a live item and its copy.

## 3. The `/public` routes

```
GET  /public                                   the surface (later: `can`, claims status)
GET  /public/workflows[/:name[/versions|/flow|/:version]]   definition and versions
GET  /public/workflows/:name/runs[...]         only with runs: true — list, summary, events, transcripts, files
GET  /public/steps[/:type/schema|/source|/versions|/version/:v]   schemas, effect, secret names, source + helpers
GET  /public/concepts[?q=]                     the public trees: name, description, parent
GET  /public/concepts/:name                    one page: properties (docs), children, parent; history later (§7)
GET  /public/graph/nodes/:ref_id               a visible node (§4)
GET  /public/apps[/:name[/document]]           the public apps; the held release's document (item 2)
POST /public/mcp                               an app's step_run (§5, item 2); the read tools for agents later (§6)
GET|PUT /public-view, GET /public-view/needs   the person's door and the dialog's cascade (behind the key)
GET  /llms.txt                                 the surface as one markdown page (§6, later)
```

The exact paths and shapes as built are `specs/API.md` §17.

- **A route family of its own**, not the existing routes made
  scope-aware. A request under `/public` is answered from the surface
  whatever the gate's mode, so a host whose own gate sits in front of an
  unkeyed strut (mcp's `labAuth`, stakgraph `mcp/src/lab/mount.ts:236`) can
  pass the prefix through as it passes a public catalog read today
  (`isTokenRead`, `mount.ts:297`) and strut still serves nothing else.
  Every other route keeps its credential: `createStrut.test.ts`'s sweep
  ("the API key gate") stays as it is, and a second sweep asserts every
  `/public` route answers an empty surface with nothing.
- **The same handlers where they can be.** The read handlers for
  workflows, runs, steps and nodes are mounted a second time at `/public`
  over FILTERED views of the workspace store, the run store and the graph
  reader. This is `federation.md` §2.1's `mountReadRoutes` ("same handlers,
  second store"), built here first for the public view and later for
  `/peers/:id`. Where a handler is not worth factoring, a small one calls
  the same functions.
- **CORS open** (`access-control-allow-origin: *`) on every `/public`
  answer, which carries no credential and sets none: the store's page reads
  a publisher's items from the visitor's browser (§8).
- **Actors.** No public answer carries an actor in v1: versions show their
  label, time and door, never who. Whether to show one is deferred (open
  question 1).
- **Limits.** Per visitor address, per minute, one budget for the whole
  family; answers over a size cap are cut the way `run/events` cuts
  (`capEvents`, `src/runs.ts`).

## 4. Which graph nodes are visible

A node is visible when ONE of these holds:

1. It is a Concept under a public root (§2).
2. A run of a workflow whose runs are public NAMED it: the nodes its steps
   reported (`step.end.nodes`, the fold in
   `kit/src/folds/accessed-nodes.ts:44`). Kept per workflow as a set of
   ref_ids, added to at each such run's end, rebuilt from the logs when
   missing. Read from the logs, not the projector's `ACCESSED` edges, so it
   holds on a Ladybug file (whose projector skips tool calls) as on Neo4j.
   This is exactly what a run view draws: RunGraph reads a run's nodes from
   its events.
3. Its type is in `types`.

An edge is visible when both ends are. The filtered reader (§3) applies the
rule to every read it serves: `getNode` answers null for a node not
visible, a search over-fetches and drops what is not visible (the way a
typed search over-fetches today, `src/graph/search.ts`), neighbors and
edges are filtered. A raw Cypher read (`graph/query`) cannot be filtered,
so it is never public.

## 5. A public app: read-only, no launches

The page is the same page. What changes is the door it calls and what each
call is handed.

- **Hosting.** strut's UI with `?app=<name>&solo=1&public=1` (SoloApp,
  `web/src/components/SoloApp.tsx`) reads the app from `/public/apps/<name>`
  instead of `GET /apps`, and the host's MCP client talks to `POST
  /public/mcp` with no credential. The document is the held release's,
  served with the app's identity as today (`appIdentity`, `src/auth.ts`).
- **What a call may do.** `step_run` on `/public/mcp` checks the app's
  grants as today, and then:
  - **Run reads** (`run/list`, `get`, `events`, `transcript`, `files`,
    `workflow`, `provenance`): only for a granted workflow on the surface,
    and only one whose runs are public for anything but `run/workflow`.
  - **Graph reads** (`graph/graph-get`, `graph-get-batched`, `graph-search`,
    `graph-neighbors`, `graph-edges`, `find`): through the filtered reader
    of §4.
  - **The app's other granted steps** (custom ones such as `openlaw/runs`,
    or an outside read such as `sheets/get-values`): only those in the
    app's `reads`, which the person ticks when adding it to the public view. The
    dialog pre-ticks what is computable as a read (strut's own steps that
    declare `effect: "read"`) and says, for each one that reaches outside
    the server, what it can reach ("`sheets/get-values`: any spreadsheet
    this server's Google account can open, by id").
  - **Refused**, whatever the grants: `run/launch`, `run/cancel`, every
    `job/*`, every graph write, `app/report-error` (no run is kept for a
    visitor). `app/state` answers `{}` and keeps nothing; the kit keeps the
    page's state in memory (`useAppState`, `kit/src/hooks.ts:935`).
- **The read-only services view.** Every public call runs with a services
  bag built as an ALLOWLIST: `http`, `secrets` (the deployment's, for a
  ticked outside read), the graph's filtered READER (no `nodes` or `edges`
  writers, no `engine`), and the run reads filtered to the surface. Nothing
  else is on it: no `shell`, `artifacts`, `jobs`, `sessions`, `proposals`,
  `peers`, `packages`, `browser`, `automations`. A step that reaches for a
  missing capability fails naming it. This is the per-run view pattern the
  runner already uses (`bindPrincipal`, `bindPeer`, `bindApp`,
  `src/runner.ts:198-226`; `bindGraph`, `src/graph-writes.ts:367`). An
  allowlist, so a capability added later is closed to visitors until
  someone opens it.
- **Why not compute read-or-write from the steps.** For a workflow or an
  app, it IS computed: the fold over the closure (§2's `can`). For one
  step, it cannot be known: a custom step is TypeScript, `http`'s effect is
  its method and URL, `agent`'s its tools. So the labels are what the
  dialog and the store PREDICT with, and the view is what HOLDS. strut's
  own read steps get their `effect: "read"` declared (most of `run/*` and
  the graph reads lack it), so the prediction is right for everything strut
  ships.
- **What the view does not stop.** A step that goes around `ctx.services`
  (its own `fetch`, `fs`) is not held by it; the builder's lint refuses
  those at publish and the registry warns at load (`src/step-lint.ts`).
  Containing untrusted code is `marketplace.md`'s open question 1. On a
  publisher's own server, its own steps are its own; a ticked outside read
  still sends that server's credential to the outside API.
- **The kit.** `useHost()` gains `public: boolean` (`kit/src/hooks.ts:1003`)
  so a page DISABLES its launch controls (ruled: disable, never hide — a
  visitor should see what the app does); a launch it tries anyway is refused
  with a sentence the page can show. strut/views' `LaunchForm` renders with
  every control off and a line saying why.
- **Cost.** No model call is reachable (`llm`, `agent`, `exec` are refused
  on the app door already). Server time is the cost: the app monitor
  (`src/apps/monitor.ts`) counts public calls under the app with the
  visitor's address as the viewer, and §3's limit applies.

## 6. Agents and other servers

- **`POST /public/mcp`** also serves read tools for an agent, the way the
  index's `POST /index/mcp` does (`src/packages/index-tools.ts`):
  `list_public`, `get_workflow`, `get_step`, `get_concept`, `search_graph`
  (visible nodes only), `get_run` when runs are public. `step_run` stays
  app-only (`_meta.ui.visibility: ["app"]`), as on `/mcp`.
- **`GET /llms.txt`**: the surface as one markdown page, the index's shape
  (`llmsTxt`). On a server that is also an index, one page with both.
- **Other servers** read a stranger's surface the same way, with no peer
  record. A peer keeps reading everything its key opens. `src/remote.ts`
  (`federation.md` §2.1) is the client for both, later.

## 7. Contributions and history

### 7.1 Who writes

- **Maintainers** write as today: anyone with full scope on the home, or a
  person token running a `peer: person` workflow there.
- **Contributors** SUGGEST. A suggestion is a proposal (`src/proposals.ts`)
  made directly, not by an agent's gate: `POST /proposals { step, input,
  rationale }` from a person token (`peer:person`) or full scope, recorded
  as an agent's would be (`createProposal`, `:210`) with the contributor as
  `by.actor`, decided at the existing door (`decideProposal`, `:425`). What
  may be suggested follows from the surface, by kind:
  - a Concept: `graph/create-node`, `graph/edit-node`, `graph/move-node` on
    a `Concept` under a public root;
  - a workflow: `meta/publish-workflow` over a public workflow's name;
  - a step: `meta/edit-step` over a public step.
  A suggested step is code that would run in the server; accepting one is
  a code review, and the card shows the diff.
- **From an agent.** `strut/suggest { peer, step, input, rationale }`, beside
  `strut/run-workflow`: a contributor's own server (Peel, an org's swarm)
  sends a suggestion to a peer with the person token it holds there, and
  gets back the proposal's id and link. By-id reads of a proposal stay open
  to its maker (`visibleTo`, `:115`).
- **Where it is decided**: on the home. The home's UI gains a Suggestions
  list (pending proposals with no run behind them); today proposals show
  only in a run's overview and a job's timeline.
- **Anonymous visitors** never write and never suggest.

### 7.2 History

Workflows, steps and apps keep every version with its time, door and actor
already. A Concept does not: an edit overwrites the node
(`NodeWriter.update`, `src/graph/node-writer.ts:582`). So:

- Every node writer `update` and `softDelete` of a node whose type keeps
  history (`Concept` by default), and every edge writer `move` that
  re-homes one (`graph/move-node`), appends one REVISION: the attributes it
  changed, before and after; who (the actor), through what (the run and
  step, or the proposal id and its rationale); when.
- Kept as `<dataDir>/history/<ref_id>.jsonl`, append-only (proposed; open
  question 2), read by `GET /public/concepts/:name` and a `graph/history`
  step. Revert is a write of an earlier revision's values, through the same
  writer, so it is a revision too.
- Writes that bypass strut's node writer (a host writing Neo4j directly)
  are not recorded; the page's `updated_at` moving with no revision says
  so.

## 8. The store

- **The index row gains `live`**: the publisher server's base URL for
  `/public` (on a swarm, `https://<swarm>:3355/lab`). `indexRowProblem`
  (`src/packages/index.ts:165`) takes it; the card carries it, sealed with
  the rest.
- **The crawl reads `GET <live>/public`** at the row, on a ping (the
  publisher pings its index when its surface changes, as `pingPublic` does
  for a catalog, `src/createStrut.ts:3380`) and on the poll. Kept beside the
  catalog's crawl state. Search hits gain live items beside packages; the
  Concept tree folds every publisher's public roots by name, as it folds
  package Concepts today.
- **An item's page**:
  - an APP is framed from the publisher's server
    (`<live>/?app=<name>&solo=1&public=1`), with **Open full page**. strut's
    UI sets no frame restriction today (hive frames it), and the app inside
    keeps its own sandboxed frame;
  - a WORKFLOW, STEP or CONCEPT is drawn by the store itself from
    `<live>/public/...`, fetched by the visitor's browser (CORS, §3), so
    every publisher's items look alike and search works across them;
  - **Install a copy** when a release in the publisher's public catalog
    holds the item.
- **The index never carries a visitor's traffic** to a publisher: a live
  app does not go down with the index, and the index does not take every
  publisher's load. (Hosting a publisher's app THROUGH the index, the way
  a person's server hosts a peer's app over `/peers/:id/mcp`, is what this
  avoids.)
- **Trust**: a live item is what its server says now, over TLS, at the URL
  the signed index row names for that key. Nothing per item is signed; a
  release stays the signed, pinned thing.

## 9. Custom domains

`openlaw.ai` shows openlaw-benchmarks at `/`.

- **At the origin.** A public app's `domains` (§2). A request whose host
  (`Host`, or `X-Forwarded-Host` from the edge) is listed gets strut's UI
  with that app named in the page, rendered as §5's public solo page.
  `/public/*` and the UI's files serve as for any visitor; every other
  route keeps its credential. A host not listed gets nothing new.
- **The edge.** `deploy/edge/`, beside `deploy/index/`: Caddy, one site
  block per domain, each `reverse_proxy` to its origin with the path
  prefix (`/lab` on a swarm) and `X-Forwarded-Host`. Caddy gets each
  domain's certificate itself (HTTP-01). The domain's owner points an `A`
  record (an apex) or a `CNAME` (a subdomain) at the edge. A domain is
  added by a pull request in v1; self-serve later (Caddy's on-demand TLS,
  its `ask` answered yes only when the origin's `GET /public` lists the
  domain).
- **Why not straight at the swarm.** A swarm's Traefik gets certificates
  through Route53 DNS challenges (`sphinx-swarm/src/images/traefik.rs:82`),
  which only work for zones in Stakwork's DNS. Serving a customer's domain
  there means a second certificate resolver, a router per domain and a 443
  entry point (strut is served on 3355 today), on every swarm that has
  one. The edge changes no swarm.
- **Limits.** The origin sees the edge's address for every visitor of a
  domain, so the edge applies the per-visitor limit for its domains and the
  origin gives the edge's address a larger budget.

## 10. What a host does

One line in mcp's lab gate: pass `/public/*` and `/llms.txt` through
untouched, as `isTokenRead` passes a public catalog read
(stakgraph `mcp/src/lab/mount.ts:297`). strut answers them from the surface
alone, whatever its own gate's mode (§3). Nothing changes in sphinx-swarm
(§9) or hive.

## 11. Not in v1

- **Public launches.** A workflow a person opens to visitors, judged by its
  closure (no `acts`, no `code`), with a daily spend cap billed to its
  owner when it `spends`. openlaw-run alone is about $30 a run. Designed
  in `plans/paid-runs.md` (2026-11-10, proposed), where a free launch is a
  price of 0; there the closure is shown and ticked, not refused.
- **A signed `/public` listing** (by the publisher's public key).
- **Diffs** between versions or revisions in the store.
- **Suggesting back from an installed copy** (its `upstream` names the
  publisher's key, so a fork could become a suggestion to the home).
- **Read-through for peers** (`/peers/:id/public/...` and `src/remote.ts`).

## Work items

### v1: openlaw-1 viewable through the index (ruled first)

In order; each is used by the next. Separate PRs against `main`, each
merged before the next is opened, never stacked.

1. **The surface and its reads** (strut). `public.json` and `GET`/`PUT
   /public` (full scope; until item 6 the surface is set with that `PUT`),
   filtered views of the workspace store, the run store and the graph
   reader (§4's rule and the per-workflow node sets), the routes of §3 over
   them (a step with its helpers, a run with its input whole), CORS, the
   per-address limit, the gate tests. `effect: "read"` declared on strut's
   own read steps.
2. **Public apps** (strut; BUILT, with item 6). Holding when added,
   `/public/apps`, `POST /public/mcp`'s `step_run` under the read-only view
   and the app's `reads`, SoloApp's public mode, the kit's
   `useHost().public`, `LaunchForm` disabled with a line saying why.
3. **The lab gate** (stakgraph, the one host change, §10). Pass `/public/*`
   through, and bump the strut pin to a commit with items 1 and 2.
4. **The index showing it** (strut). `live` on index rows, the crawl of
   `/public`, live search hits and Concept roots folded in, the store's
   live pages (a workflow, step or Concept drawn from the publisher's
   JSON) and the framed app, **Install a copy** when a release holds the
   item.
5. **openlaw-1 goes public** (an operator's acts and one app edit). The
   app's own source disables its launch form when `useHost().public` (through
   the builder, or `scripts/preview-app.mjs` and a publish). Then `PUT
   /public`: the app at its release with `reads` ticked
   (`openlaw/list-tasks`, `openlaw/task-details`, `openlaw/runs`,
   `sheets/get-values`), `openlaw-run` and `harvey-lab-run` with runs, the
   Law tree. Then the first row on index.sphinx.chat, with `live`; it mints
   the index's key, which goes into `DEFAULT_PACKAGE_INDEXES`
   (`src/packages/indexes.ts:51`).
6. **The Public view dialog** (strut; BUILT with item 2). The person's door
   in the UI with its cascade (§2). Not yet: the badge on each item's
   flyout.

### Later

7. **`can` on live items.** The fold moved out of `detail.ts` into a module
   `GET /public` and the store's package pages both use.
8. **Agents on a publisher.** The read tools on `/public/mcp`, `GET
   /llms.txt` (§6).
9. **Custom domains** (§9). `domains` on a public app, the host mapping at
   the origin, the edge (probably one central box, connected to hive).
10. **History** (§7.2). Revisions on the writers, `graph/history`, revert,
    a page's history in `/public/concepts/:name` and in the UI.
11. **Suggestions** (§7.1). `POST /proposals` for a person, the suggestible
    steps by kind, `strut/suggest`, the home's Suggestions list.

## Validation

v1 is every case below except the revision, suggestion and domain ones,
which come with items 9–11.

- An empty surface: every route but the UI's files, `/health` and
  `/public/*` answers 401 without the key, as today; every `/public` route
  answers nothing.
- A workflow public without runs: its definition and versions read; its
  runs 404; a run of it named on `/public/mcp` is refused.
- A Concept root in the public view: a page under it reads anonymously with its
  history; a sibling under a private root is "not found"; a page moved out
  of the subtree stops reading, one moved in starts.
- A public app with no credential: its page renders; `run/launch` is
  refused with the sentence; a graph read of a node outside §4 is not
  found; a granted step not in `reads` is refused; a ticked custom step
  that calls `ctx.services.graph.nodes.write` fails naming the missing
  writer, and nothing is written.
- With strut's gate open (no `STRUT_API_KEY`, as on a swarm behind mcp),
  `/public` serves the surface alone, the same answers as above.
- `/public` answers carry `access-control-allow-origin: *` and no cookie.
- A Concept edit through `graph/edit-node` writes a revision naming its run;
  a suggestion accepted through `decideProposal` writes one naming the
  proposal and its rationale; a revert is a revision.
- A person token suggests a Concept edit through `strut/suggest` from
  another server; the home's maintainer sees it in Suggestions and accepts
  it; the contributor reads the outcome by id.
- An index row with `live`: the crawl lists the surface's items; the store
  frames the public app and draws a Concept page from the publisher's
  `/public` in the visitor's browser; nothing of the visitor's traffic
  reaches the index past the store's own page.
- A request with `Host: openlaw.ai` gets the app's public page at `/`; any
  other host gets strut's UI as before; through the edge, a certificate is
  issued and the page loads.
- openlaw end to end: a visitor with no account opens openlaw-benchmarks
  from the store, replays a run, spot-checks a cell, reads the Law tree,
  and cannot launch.

## Open questions

1. **Actors in public views.** *Deferred (ruled).* A version's or a
   revision's actor is an id the home knows (a GitHub login on a swarm).
   v1 shows none.
2. **Revisions in files or in the graph.** *Deferred with history (ruled).*
   A file per node is flat and works on every backend; a revision node
   would let an agent query the history with the graph, and costs a Strut
   type on both engines.
3. **A run's input in public runs.** *Answered (ruled): whole.*
4. **One edge or one per org.** *Deferred with domains (ruled), leaning one
   central box connected to hive.* A self-hosted home would run its own
   (`deploy/edge/` is that compose file).
5. **What a step's public page shows of its source.** *Answered (ruled):
   the step and the helpers it imports.*
