# Apps — interactive software the builder writes on top of its own workflows

> **Design status (2026-10-20): proposed.** This plan was written after
> stakwork/hive#5573 (a generic benchmark registry in hive, merged) raised the
> question of where a benchmark's rich UI belongs. The owner ruled in
> conversation on 2026-10-20:
> - **MCP Apps is the protocol** (more hosts).
> - **An app is its own object, and it is a directory** that can be as
>   sophisticated as a real front-end project, not a single file.
> - **Jobs have apps:** directories in the job's directory.
> - **The stack is fixed and opinionated.** React, Tailwind and the popular
>   chart, motion and data libraries are pre-loaded and cannot change, so the
>   model writes the code it is used to.
> - **Strut ships a library of strut-native components** any app can draw on,
>   the run graph first.
> - **Data has two stores:** the graph for graph-shaped data, and SQLite.
>
> **Revised 2026-10-20, later the same day**, after the synthesis with
> `marketplace.md`. Three more rulings from the owner:
> - **Apps are forkable and flexible.** An app is a package KIND
>   (`apps/<name>/`, `marketplace.md` §1), the one item that is a directory,
>   and the fork is its normal path, not a fallback (§11).
> - **Backends are tools.** An API endpoint is the same thing as a tool or
>   a workflow: an input shape, an execution block, an output shape. So an
>   app's backend is the registry, reached through one tool, and the graph
>   and SQLite are steps like everything else (§5).
> - **Apps are the expression surface of generalized software**: a UI,
>   grants onto the registry, and steps or workflows in the same package
>   when it needs logic of its own. No server code of the app's own.
>
> A fourth, the same day: **an app's agent and LLM workflows are ROUTINES**
> — a core piece of what an app is for, and never triggered by the UI on
> its own (a render, a refetch, a poll). An app has three responsibilities:
> rendering workflow output, calling tools, and AI-agent-powered UI. §5.1
> says what each one is allowed to cost and what may trigger it; the rules
> there (the workflow as the unit of spend, launch as a mutation only, the
> dedupe key) are mine.
>
> **Simplified 2026-10-20, a last pass** (mine, proposed): the app token IS
> the file token, and the document is a file the build writes,
> `dist/index.html`, served by the file routes that exist (§2, §7.2); a
> workspace app's files live under `dataDir` on every backend, the
> workspace store holding pointers only (§1.3, closing open question 3);
> and an app's writes and its error reports are KEPT STEP RUNS, so there is
> no audit file, no error file, and no tool but `step_run` (§5, §8, §9).
> And **one door** (2026-10-21): there is no `POST …/call` route. Every
> host — strut's own UI, hive, Claude — relays the frame's `tools/call` to
> `/mcp` as it is, so the frame's call reaches strut in the shape it left
> the frame in and no host translates anything (§7). Hive's other calls to
> strut, runs, jobs, chat and files over the HTTP API, are untouched: this
> is only where an app frame's calls go. And **no builder app tools**
> (2026-10-21): the `app/*` steps are the builder's tools by name, through
> `buildRegistryTools` as the `agent` step's `agentTools` are, in place of
> five chat tools that each wrapped one of them (§8).
>
> **With stakwork/strut#239** (2026-10-21; the builder job,
> `plans/builder-job.md`): a second author. Apps are a builder job's kind
> of work under that plan's ruling; the `builder` seed gains the editor
> family and `app/*` and still no bash; one authoring path — a directory,
> the editor, `app/build`, `app/publish` — serves the chat, the builder job
> and a code job's agent alike; a build on a peer tags its deliverable by
> peer; the build warns on a global `fetch` (§8, §2.1, §11). Mine, proposed.
>
> **The kit split** (2026-10-21, mine, proposed): strut's kit, `@strut/kit`,
> is the STACK and the BRIDGE and nothing else — the vendor layer, the
> bootstrap, `StrutClient`, the hooks, the pure folds — so it knows no
> deployment. **A kit a deployment shares is an app other apps import** by
> name (§3.4): no new kind, no new store, one resolver rule. Strut's own
> components (`RunGraph` first) are `strut/views`, an app strut seeds that
> the benchmark app imports and the tweet app never sees (§3.3). The kit's
> library build for a host's own pages is deferred (§12): a host that wants
> strut's views renders an app.
>
> **Work item 1 is BUILT** (2026-10-21): stakwork/strut#246 the kit, #248
> the app object and the build, #250 the backend and the hosts (§13). Two
> findings from its by-hand run are written in: the frame is `srcdoc`, not
> a `blob:` URL (§7.3), and the first app's document measured 2.4 MB
> against §2.5's estimate — the size pass opens work item 6. Items 2–8 are
> open; the packaging of the kit's vendor layer and esbuild's binary into
> the image and the desktop package is its own small PR.
>
> What those rulings changed here, in place: §5 is no longer a tool set of
> its own; §4.4's `sql_*` tools are the `sqlite/*` steps; the version hash
> is the tree hash shared with packages and the kit is out of it (§1.3);
> `ctx.app` joins `ctx.job` (Decided, §5); §4.3 proposes per-type columns on
> Ladybug (open question 2); §11 says how an app forks. The specifics of
> each (the hash, `ctx.app`, the `run/*` steps, the per-file merge, the
> columns) are mine and open; the three rulings are not.
>
> The other rows of "Decided" are mine and open. The companion plans:
> - `jobs.md` and `live-artifacts.md`: the job directory, deliverables, the
>   file token, `job.update`.
> - `automations.md`: what an app schedules.
> - `claims.md`: what tests an app.
> - `ladybug-backend.md`: the closed registry this plan opens.
> - `marketplace.md`: an app is a package member.
> - `federation.md`: apps stay local, but their workflows may reach peers.
> - `builder-job.md` (stakwork/strut#239): the `builder` job, the
>   orchestrator's door to authoring, here and on a peer.
>
> Hosts appear below only as the contract they read. Their own repos are
> adoption, not work items.

**The thesis.** Workflows are an app's server functions, steps its API,
automations its cron, the graph its knowledge base, the builder its
developer, and claims its tests. Runs are its history. The only new store
is a SQLite file of the app's own (§4). And an endpoint is a tool is a
workflow — an input shape, an execution block, an output shape — so the
app reaches all of it through ONE tool over the registry (§5), and ships,
forks and updates as a package member like the workflows it drives (§11).

## Problem

Today a workflow's UI is built in one of two ways, and neither scales.

**1. Hand-built in a host.** Hive's OpenHealth UI is ~6.6k lines plus ~5.8k
lines of tests: `src/components/openhealth`, `src/lib/openhealth-benchmarks`
and eleven routes, read from hive `origin/master` @672e6cd. Almost all of it
is keyed on one workflow's internals:
- step ids: `ingest#N`, `seed_checklist`, `loop#N/improve`;
- output keys: `weighted_problem_list_f1_neutral`, `matched[{pred,gt}]`,
  `history[]`, `contestsNotAccepted`;
- artifact paths: `gt-<id>/output/problem-list.json`.

Every change to `openhealth-run`'s output is a hive PR. hive#5573 is the
right generic shell: a registry, one `StrutRun` kind handler, a rendering
convention (`score`, `metric`, `summary`, `artifacts`) and a JSON tree for
the rest. But its escape hatch, `BENCHMARK_RUN_VIEWS`, is the same
hand-built pattern again, once per benchmark. That inverts the rule the job
work settled on: hive stays fixed, the work evolves in strut and is
published on the swarm, and no capability needs a host PR.

**2. Written by an agent as an HTML artifact.** Since strut#126/#127, a page
an agent writes runs scripts (`CSP: sandbox allow-scripts`, read by its
`?t=` file token), and hive renders it in `HtmlArtifactFrame` (hive#5454).
The builder already makes good ones. But such a page is **a snapshot of one
run**:
- It is tied to one run, while a benchmark UI spans many: the task
  catalogue, score over time, climbs.
- It is read-only. The file token opens one run's or one job's files, GET
  only, and hive's frame lets a page connect to CDNs only.
- It is one file, written by hand, with whatever libraries a CDN serves.

So such a page cannot list runs, launch one, cancel one, follow one live, or
keep any state. None of the strut-native views (the run graph, a
transcript, a run timeline) is available to it either: each one lives in
one host, in that host's framework.

What should be possible is wider than benchmarks:

| App | What it is |
| --- | --- |
| Benchmark hill-climb | Pick a task, launch runs and climbs, watch the score climb, open a run's graph, read what the improve step changed |
| HVAC invoice tracker | Customers, visits and invoices; an agent reads a photographed invoice; overdue reminders on a schedule; a map of the day's visits |
| Searchable fact library | Paste a URL and an agent writes the facts into the graph; semantic search over them; a card per fact with its sources |
| Twitter virality tracker | Track a tweet; a schedule polls its metrics every 15 minutes; time-series charts; "why did this one take off?" answered by a model |

| Strut has | Strut lacks |
| --- | --- |
| Workflows, steps, `run_step`, detached launches, run callbacks, `get_run`'s `wait` long-poll | An object that holds a front-end project beside the workflows it drives, versioned like them, and the same thing living in a job |
| Automations (a closed trigger grammar, previews); the graph with hybrid search on both engines; `graph/*` writes | A typed property query on the graph ("invoices where status is unpaid"); node types an app declares on the Ladybug file (its registry is closed); a place for an app's own tables |
| The builder, which writes good HTML; step-lint's refuse-with-a-reason pattern | A fixed stack the model can rely on, and a build that refuses anything outside it |
| Two MCP doors (`/mcp`, `/mcp/builder`) over a generic ToolSet adapter (`src/ai/mcp.ts`) | MCP resources, tool `_meta`, app-only tools |
| Pure folds in `web/src/`: `run-overview.ts`, `transcript.ts`, `accessed-nodes.ts`, `walk-graph.ts`, `artifact-view.ts` | A component library in a framework apps and hosts share; today the run graph lives in hive |
| File tokens: a credential narrowed to one scope | An identity for an app that a host's relay cannot vouch for |

## Decided

Rows marked (ruled) are the owner's (2026-10-20). The rest are what I would
decide, and why; each is open.

| Question | Decision |
| --- | --- |
| The protocol between an app and its host | **MCP Apps** (ruled; SEP-1865, stable 2026-01-26): the `ui/initialize` handshake, `hostContext`, `tools/call`, app-only tools, `ui/message`, `ui/open-link`. Hosts that render it today include Claude, Claude Desktop, VS Code Copilot, M365 Copilot and Goose. Strut's own UI and any other host implement the same bridge |
| What an app is | **A directory with an `app.yaml`** (ruled): sources, styles, assets and SQL migrations, laid out like a Vite + shadcn project (§1.1). Not a run artifact, since an app spans runs, and not a field on a workflow, since one app drives several workflows (OpenHealth uses four) |
| Where an app lives | **In the workspace**, published as a versioned object, **or in a job's directory** (ruled), as a live directory the job's agent edits. One build, one kit, one set of tools, both homes (§1.2, §6). A job's app can be published to the workspace. Either way the files are a directory under `dataDir`; the workspace store holds pointers (§1.3) |
| The stack | **Fixed and opinionated** (ruled): React 19, Tailwind 4, shadcn/ui at the import paths models know, lucide, recharts, d3, React Flow, motion, three, react-router, zustand, react-query, tanstack table, dnd-kit, date-fns, zod, papaparse, leaflet and more (§3.1). One kit version is one frozen set |
| Shared components | **A strut kit** (ruled: strut ships strut-native components, the run graph first), in two parts. `@strut/kit` is the STACK and the BRIDGE — the vendor layer, the bootstrap, `StrutClient`, the hooks, the folds — which every app is built against and which knows nothing of any deployment. Strut's components are **`strut/views`**, an app strut seeds that other apps import (§3.3). A deployment shares components the same way: **a kit is an app other apps import** by name, `hive/ui` beside `hive/…` in its package (§3.4). The ruling's "so a host's own pages can import them too" is deferred (§12): a host renders an app |
| The data stores | **The graph and SQLite** (ruled), beside runs (§4). Runs are history, one row per execution. The graph holds entities and relations that agents, workflows and other apps should also see; the app declares its node and edge types in `app.yaml`. A SQLite file of the app's own holds its tables: many rows, sums, imports, settings. Earlier drafts had a strut-wide "records" store; it is gone |
| How the fixed set reaches a page | **Compiled in when the app is built**, never fetched at runtime. esbuild bundles the directory and Tailwind 4's pure-JS compiler compiles its classes, both against the kit, into ONE self-contained HTML document. With nothing to fetch, the page works under any host's CSP and offline. A workspace version keeps its document, so a strut upgrade never breaks it |
| What a build refuses | **Any bare import outside the kit**, a relative import that leaves the directory, URL imports, `dangerouslySetInnerHTML`, `eval` and `new Function`. The errors are the build's result, step-lint's pattern |
| Where an app's data comes from | **The registry, through one tool** (ruled: an endpoint is a tool is a workflow). `step_run` under the app's grants, an app-only tool on the MCP door and nowhere else — every host relays the frame's `tools/call` to `/mcp` as it is (§5, §7). Runs, launches, the graph, the app's SQLite, schedules and files are all STEPS — `run/*`, `graph/*`, `sqlite/*`, `automation/*`, `job/*` — the same steps a workflow or an agent calls, one implementation each. The app adds no tool of its own: even its error report is a step, `app/report-error` (§8) |
| What an app may touch | **Its manifest's `grants`**: step types, plus a scope per family — which workflows (`run/*`), which graph types (`graph/*` writes), its own file (`sqlite/*`), which schedules (`automation/*`) — checked by strut on every call in every host. So an app can never rewrite a Concept or a `StrutWorkflow` node. Grants box model-written code acting as the viewer; they never raise the viewer, who already holds a full credential |
| Routines — where the model runs | **Inside a run, never inside the page** (ruled: an app's agent and LLM workflows are routines, never triggered on their own). The workflow is the unit of spend: `step_run` from a model-written manifest refuses `llm`, `agent` and `exec`, so every model call an app causes is a run — logged, billed to the viewer, cancelable, verified. A routine is a granted workflow; launching one is a mutation the kit exposes only as a function, never as a query, and `run/launch { key }` returns an in-flight run instead of starting a second (§5.1) |
| How a step knows it runs for an app | **`ctx.app`**, the twin of `ctx.job`: `{ name, version }` for a workspace app, `{ job, path }` for a job's, set by the app door for the call and never by a launch body. The `sqlite/*` steps open the app's file from it, the graph write scope reads the declared types from it, `automation/*` reads `grants.automations` from it, and a run the app launches records `app` on `run.start` as a job run records `job` — so a workflow working for the app finds the app's file the way a job's steps find the job's directory (§5) |
| Sharing and forking | **A package kind** (ruled: forkable and flexible). `apps/<name>/` in a package (`marketplace.md` §1), the one item that is a directory. One representation everywhere: a job's live directory, a workspace version, a package member, a git repo and an `app/init` template are the same bytes. The fork is the normal path: an edit is a fork carrying `upstream`, an update fast-forwards an untouched app and merges a forked one per file, and the app is the wrapper around bought steps, so a forked UI leaves them fast-forwarding (§11) |
| Who writes an app | **A builder** — the chat, or the `builder` job of stakwork/strut#239 — and a code job's agent for a job app (§6). One path for all three: a directory, the editor, `app/build`, `app/publish { name, path }` (§8). Apps are a builder job's kind of work under #239's ruling, so a regular job never holds `app/publish`; the builder job gets the editor family and `app/*` and still no bash |
| Who pays and who acts | **The viewer.** A launch from an app is billed to whoever clicked, and binds actor secrets to them, exactly as if they had pressed Run |
| How strut knows which app is calling | **The app's file token.** The host relays `tools/call` as it is and names nothing; the served document carries the app's **file token** (`fileToken`, `auth.ts`), scoped to its own directory — the token that lets a page read its own files, written into `dist/index.html` as it is served (§7.2). `step_run` reads which app is calling off its scope; the connection's credential says who. Alone it is worth that directory's files and nothing more |
| Who may grant sealed or shell-like things | **A person only.** The meta surface (the builder, `meta/*`, a job's agent) may not grant a sealed workflow or step, nor `llm`, `exec` or `agent` as direct step grants (§5.1); it runs those through a workflow, whose YAML is versioned and reviewable. A person on the HTTP door may grant anything, as with `peer: true` |
| How an agent learns its app broke | **In a result:** the build's errors (from `app/build`, the publish), and the app's client-side errors (the kit's error boundary calls `app/report-error`, a step kept as a run), returned by `app/get` and `app/build` |

## Design in one paragraph

An app is a **directory**: `app.yaml` (title, icon, `grants`, the graph
types it declares, extra image or map domains) plus `src/` (TSX, its own
shadcn overrides, CSS), `public/` (assets) and `db/` (SQL migrations).

It lives in one of two places:
- **The workspace:** published as a versioned object, tree-hashed over its
  files, the directory kept under `dataDir`.
- **A job's directory:** a live directory the job's agent edits and
  declares as a deliverable `{ kind: "app", path }`.

**Building** it bundles `src/App.tsx` against the **kit** and writes one
self-contained HTML document carrying the MCP Apps bootstrap,
`dist/index.html`, beside the sources. The kit is a
frozen set of React, Tailwind, shadcn/ui and the popular chart, graph,
motion and data libraries, plus strut's own hooks. Strut's components (the
run graph among them) are `strut/views`, an app other apps import by name,
and a deployment shares its own the same way (§3.3, §3.4). A bare import
outside the kit and the installed apps is a build error that names both.

Any MCP Apps host renders the document in a sandboxed frame: strut's own UI
in an **Apps** section; Claude and the other MCP Apps hosts through
strut's `/mcp`; hive or any portal through the file route plus a relay to
`/mcp`.

The page holds no credential. Its `tools/call`s go to its host, which
forwards them as they are to `/mcp` with its own credential — strut's one
app tool, `step_run` — and strut checks each call against the app's grants. Every call is a
registry step — the same steps a workflow or an agent runs:
- `run/*`: list, read, launch (billed to the viewer) and cancel runs;
- `graph/*`: read and write the graph (writes limited to the types it
  declares);
- `sqlite/*`: query and write its own SQLite file;
- `automation/*`: set schedules;
- `job/*`: its own job, for a job's app.

An endpoint is a tool is a workflow, so the app's server side is no code of
its own: a UI, grants onto the registry, and steps or workflows in the same
package when it needs logic of its own. The model is always inside a run,
never inside the page: an app renders workflow output, calls cheap tools,
and launches ROUTINES — its agent and LLM workflows — on a click, never on
a render (§5.1).

`ui/message` sends a message to the host's conversation: the builder chat
in strut's UI, the job's conversation for a job's app in hive, Claude's own
in Claude. So "add a due-date column", typed inside the app, becomes a
change to the app.

## 1. The app — a directory

### 1.1 Layout

```
hvac-invoices/
  app.yaml                    # the manifest (below)
  src/
    App.tsx                   # the entry: its default export is the root component
    pages/Invoices.tsx        # anything else the app is made of
    components/InvoiceTable.tsx
    components/ui/button.tsx  # optional: overrides the kit's shadcn button (shadcn's own model)
    lib/format.ts
    styles.css                # optional: @theme, @layer, custom utilities
  public/                     # images, fonts, JSON fixtures, imported by path
  db/
    001-init.sql              # the app's SQLite migrations, applied in name order
```

```yaml
# app.yaml
title: Invoices
description: Customers, visits and invoices for an HVAC business.
icon: receipt                       # a lucide name
entry: src/App.tsx                  # the default
grants:
  workflows: [invoice-from-photo, invoice-reminders]   # the app's ROUTINES: run/* on these — read runs, launch, cancel
  steps: [graph/*]                  # cheap, deterministic steps (graph writes: declared types only); never llm / agent / exec (§5.1)
  sqlite: true                      # sqlite/* on this app's own database (§4.4)
  automations: [invoice-reminders]  # automation/* on these workflows' schedules
data:
  graph:
    types:
      Customer: { name: string, phone: string?, address: string?, search: [name, address] }
      Visit:    { date: date, notes: string? }
      Invoice:  { number: string, amount: number, status: string, due: date }
    edges:
      - [Visit, FOR, Customer]
      - [Invoice, BILLED_TO, Customer]
      - [Invoice, COVERS, Visit]
csp:
  resourceDomains: [https://tile.openstreetmap.org]   # images, fonts and map tiles from here, nothing else
```

- **What the build reads.** Every file under the directory except `db/`,
  `data.db` (§4.4), `dist/` (its own output, §2), dotfiles and
  `node_modules/`. The limits are 2,000 files and 20 MB, and the build
  refuses past them. **What the hash covers** (§1.3): every file but
  `data.db` and `dist/` — the data and the derived document.
- **The name** follows workflow naming (`hvac-invoices`) in its own
  namespace. An app and a workflow may share a name.
- **The manifest is content.** It is shape-checked at every build, like a
  workflow's `input:` block (zod, `src/apps/manifest.ts`). Its `data.graph`
  attribute types are `string | number | boolean | date | json`, with `?`
  marking an optional one; `search` names the fields the graph indexes.

### 1.2 Two homes

| | A workspace app | A job's app |
| --- | --- | --- |
| Where | `<dataDir>/apps/<name>/<vN>/`, one directory per version, with the pointer in the workspace store (§1.3) | The job's directory: `<dataDir>/jobs/<job>/<path>`, by convention `apps/<name>/` |
| Who writes it | A builder — the chat, or a `builder` job (stakwork/strut#239) — with the editor: `app/checkout`, files, `app/build`, `app/publish`; a person (`POST /apps`) | The job's agent, with its editor and bash, in its cwd |
| Versions | `vN`, tree-hashed (§1.3), an active pointer, rollback, `upstream` when a package installed it | None. One live directory behind one link, the jobs contract; `job.update` says it changed |
| Its document | `dist/index.html` in the version's directory, written by the publish's build; rebuilt there on a newer kit only when asked | `dist/index.html` in the app's directory, written by `app/build` — the agent builds before it hands the app over, as it verifies before it says done |
| Its SQLite | `<dataDir>/apps/<name>/data.db`, shared by all its versions | `<path>/data.db`, inside the job's directory, so the agent can `sqlite3` what the person entered |
| Its URL | `/apps/<name>/<vN>/files/dist/index.html`, the version's file route (§7.2) | `/jobs/<job>/files/<path>/dist/index.html`, the job's file route |
| Grants | As published: the meta surface's rules, or a person's (§9) | As its `app.yaml` says, under the meta surface's rules, plus its own job: that job's runs and files (§6) |

A job's app is **published to the workspace** with `app/publish { name,
path }`. A person does it from the job timeline ("Publish as an app"), or
a builder does it on request — the chat, or a `builder` job naming the
other job's directory; a code job never holds the step (§8). The
directory becomes the app's next version, and `data.db` comes along when
the workspace app has none yet. A prototype with real data in a job
becomes a real app.

### 1.3 Workspace versions and storage

- **`publishApp` follows `publishStep`.** The hash is the **tree hash**:
  `sha256` over `<path>\0<sha256 of the bytes>\n` for every file under the
  directory, sorted by path — the same computation `marketplace.md` §1 uses
  for a package's digest, so it is one function in `src/version.ts`
  (`treeHash`), and an app's item hash in a package IS its version hash
  here. **The kit is not in it.** The identity is the directory; the built
  document is a derived artifact, `dist/index.html`, written beside the
  sources and left out of the hash with `data.db` (§1.1). Identical content reactivates the version it already is; anything else
  publishes the next `vN`. The active pointer, rollback
  (`PUT /apps/:name/active`) and the `publisher` and `owner` stamps work as
  they do for workflows. Republishing on a newer kit is a REBUILD of the
  same version, never a new one.
- **A version keeps** its files, its `hash`, and in `dist/` the document
  it was last built with — `dist/build.json` records the `kit`, `builtAt`
  and the tree hash it was built from. A strut upgrade rebuilds nothing by
  itself — the old document stays, so the app keeps working; `app/build` on
  the version, or the next publish, builds it on the current kit.
- **`upstream`** rides on an app version as on a workflow's
  (`marketplace.md` §3): which package, which digest, whether it was edited
  since. Carried forward by every publish over the name.
- **The files live under `dataDir`, on every backend.**
  `<dataDir>/apps/<name>/<vN>/` is the version's directory as published,
  `dist/` included, beside the app's `data.db` — the rule AGENTS.md already
  states for artifacts, cassettes and jobs: the inherently local things hang
  off `dataDir`, whatever the workspace's kind. The workspace store keeps
  only the POINTERS, so a version is never a 20 MB graph property, and
  `materializeAppVersion(name, version)` is the directory's path, not a copy
  (`app/checkout` copies from it to edit). Closes open question 3.
  - **`WorkspaceStore` gains** `listApps`, `getApp(name, version?)` (the
    manifest, the hash, the versions, the active one, `publisher`, `owner`,
    `upstream`), `publishApp(name, hash, manifest, opts)`,
    `setActiveAppVersion` and `deleteApp`. On files the pointers are
    `apps/<name>/_metadata.json`; on the graph `StrutApp` and
    `StrutAppVersion`, `exact_key`, joined by `VERSION_OF` and
    `ACTIVE_VERSION`, holding the manifest and the hash and never a file.
    `USES_WORKFLOW` (version → workflow, from `grants.workflows`) makes
    "which apps read this workflow" one query, which the Workflow flyout
    shows.
  - **On every layer:** the Neo4j schema (`strut-schemas.ts`), the Ladybug
    registry (`LADYBUG_STRUT_TYPES` and `LADYBUG_EDGES`), a case in
    `src/test-util/workspace-conformance.ts`, the fs → graph import
    (`fs-import.ts`: pointers only, the directories stay where they are),
    and a run of `npm run test:graph`, per the AGENTS.md convention.
  - A graph copied without its `dataDir` loses the app files, as it loses
    artifacts today; `app/get` says so for a version whose directory is
    missing.
- **Workflows do not name apps.** The grants are the link. Granting a
  workflow that does not exist is a build error. If a granted workflow is
  deleted later, the grant goes inert, and `app/get` says so.

## 2. The build

`src/apps/build.ts` is lazy-imported, as a lib step's SDK is, so building
the registry never loads esbuild. There is one function: `buildApp(dir) →
{ warnings } | { errors }`, which writes `dist/index.html` and
`dist/build.json` (the kit, `builtAt`, the tree hash it built from) into
the directory. A workspace publish calls it (§1.3) and so does `app/build`
(§8). Nothing builds on a read: the document is a file.

### 2.1 Bundle

- **The call.** It is esbuild's JS API: `build({ entryPoints: [entry],
  bundle, format: "esm", platform: "browser", jsx: "automatic", minify,
  write: false, loader: { ".png": "dataurl", ".svg": "dataurl", ".woff2":
  "dataurl", ".json": "json", ".md": "text", … }, plugins: [appResolver]
  })`.
- **The dependency.** esbuild is in the tree today only through `tsx`
  (0.28.1), a devDependency, so it becomes a real dependency. Its platform
  binary travels in the darwin desktop package's `native/`, like sharp's
  and Ladybug's. `esbuild-wasm` is the fallback for a platform without a
  binary.
- **`appResolver`** resolves imports in this order:
  - A **relative import** resolves inside the directory. One that leaves the
    directory is an error.
  - **`@/…`** resolves to the app's `src/` first, then to the kit. So
    `@/components/ui/button` is the kit's shadcn button unless the app has
    its own, which is shadcn's own model: the components are the project's.
  - A **bare specifier** resolves to the kit's vendor file when it is in the
    kit's import map (§3.1).
  - A bare specifier that **names an installed app** (`strut/views`,
    `hive/ui`; `hive/ui@v3` pins a version, else the active one) resolves
    to that app's `src/` — `src/index.ts`, or the path after the name — and
    is compiled into THIS app's bundle: a kit is an app other apps import
    (§3.4). A cycle is an error naming the chain.
  - Anything else is an error that names the set and the kits:
    `"lodash-fp" is not in the app kit (v1). Available: react, recharts, …
    Installed kits: strut/views, hive/ui. For work the kit cannot do, write
    a workflow and call it with useLaunch`.
  - **`http(s):` imports** are refused.

  Resolution never consults `node_modules`, so a host's own React or zod
  (mcp, hive) can never leak into a build, and the "one copy per process"
  rule is untouched. None of this code runs in the server process.
- **The AST checks**, over every source file. `dangerouslySetInnerHTML`,
  `eval` and `new Function` are refused. Markdown goes through the kit's
  `react-markdown`, which is safe by default. Even with `connect-src 'none'`
  (§9), a script injected into an app could call that app's granted tools
  as the viewer, so the build closes the door it can see. A call to the
  global `fetch`, `XMLHttpRequest` or `WebSocket` is a WARNING in the
  result that names the hook to use instead (`useStep`, `useLaunch`): a
  model writes `fetch('/api/…')` by reflex, the CSP refuses it at runtime,
  and without the warning only `app/report-error` would say so — step-lint's
  rule for a step's `fetch`, for the same reason.
- **Types are not checked in v1**, because esbuild strips them. A `tsc` pass
  against the kit's `.d.ts` comes later (§12). Render errors reach the
  agent through `app/report-error` (§8).

### 2.2 Styles

Tailwind 4's `compile()` is pure JS with zero dependencies. I checked it on
2026-10-20 against tailwindcss 4.2.1: `@import "tailwindcss"`, plus the
candidates a regex scan pulled from one TSX line, produced the expected
utilities, `bg-emerald-500/20` and `md:grid-cols-3` among them.

Its input is:
- the kit's base stylesheet: Tailwind, shadcn's CSS variables, and the
  mapping of MCP Apps `hostContext.styles.variables` (`--color-*`,
  `--font-sans`, radii, shadows) onto them, with fallbacks for a host that
  sends none;
- the app's own CSS files (`@theme`, `@layer`, `@utility`);
- the candidates scanned from every source file in the directory;
- the kit's precomputed candidate list, so its components are styled.

`tailwindcss` becomes a dependency.

### 2.3 Assets

Files under `public/` and anything imported by path are inlined: images
and fonts as data URLs, JSON and text as values. The document stays one
file. A large dataset belongs in SQLite or a run's output, not in
`public/`.

### 2.4 The document

```html
<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="…§9…">
<style>/* compiled Tailwind + the app's CSS */</style></head>
<body><div id="root"></div>
<script type="module">/* kit bootstrap + the app bundle */</script></body></html>
```

The kit's bootstrap:
- connects the MCP Apps client and sends `ui/initialize`;
- applies `hostContext`: the theme, the style variables and the display
  mode;
- mounts `<StrutProvider><ErrorBoundary><App/></ErrorBoundary></StrutProvider>`;
- reports its size through `ui/notifications/size-changed`;
- turns render failures and `window.onerror` into `app/report-error`.

The output is deterministic: the same inputs give the same bytes, and
`dist/` holds no credential. The app's file token (§7.2) is written into
the document when it is **served** — the file route, handing out
`dist/index.html` under a valid `?t=`, fills a `<meta>` the kit reads —
never at build, so rotating the signing secret rebuilds nothing.

### 2.5 Size

esbuild tree-shakes per app — which works only because the vendor layer is
a frozen MODULE TREE (kit 0.2, §3): every module as its package ships it,
each import's resolution and `sideEffects` flag recorded once. The first kit
froze pre-bundled chunks instead, and nothing inside a chunk could be
dropped. Measured on 2026-10-21 (the document, minified, with its CSS):

| App | Kit 0.1 (chunks) | Kit 0.2 (module tree) | First paint, headless Chrome |
| --- | --- | --- | --- |
| The build tests' fixture (a button, a badge, a router) | 1.28 MB | 0.60 MB | — |
| A small app (tabs, runs, a host message) | 1.24 MB | 0.60 MB (172 KB gzipped) | 89 → 64 ms |
| The 1c benchmark app (recharts, run list, launch form) | 2.48 MB | 0.96 MB (278 KB gzipped) | 138 → 82 ms |
| An app importing `strut/views`' RunTimeline, RunGraph, LaunchForm and RunList | — | 0.96 MB | 87 ms |
| `strut/views`' own gallery (every component) | — | 1.15 MB | 94 ms |

First paint is from setting the frame's `srcdoc` to the page's first
content-sized `size-changed`, behind ext-apps' `AppBridge`, median of five
(a cold first load is about three times that). The 1c by-hand run saw ~8 s in the
browser pane, which ran as a background page; it does not reproduce in a
foreground browser.

What the old 1.2 MB floor was: all of lucide (649 KB, through three icons),
every radix primitive behind `Slot`, zod's locales (its `z` is a re-exported
namespace esbuild cannot shake — the app build rewrites `import { z }` to
`import * as z`), and every shadcn component's 1 023 classes compiled into
every stylesheet (the build now scans only the kit modules it bundled, and
minifies). What a small app still carries: react-dom (210 KB), the MCP Apps
SDK with its zod schemas (~250 KB), react-query, tailwind-merge. three and
mathjs tree-shake poorly, so an app that uses either imports most of it (a
map and a three.js scene: 1.6 MB); an app that does not import them carries
none. A document over 6 MB is still built, and the result carries a
warning.

## 3. The kit

The kit lives in `kit/` in this repo, with its own `package.json`, and it
is **the stack and the bridge, nothing else**: the vendor layer of §3.1,
the bootstrap of §2.4, `StrutClient` and the hooks of §3.2, and the pure
folds (`run-overview.ts`, `transcript.ts`, `accessed-nodes.ts`,
`artifact-view.ts`, moved from `web/src/` into `kit/src/folds/`, which
`web/` then imports — one copy). Nothing in it knows what a benchmark or an
invoice is, and nothing in it renders a run: strut's own components are an
app, `strut/views` (§3.3), that an app imports when it wants them, as it
imports a deployment's kit (§3.4). One build: **the vendor layer**, the
frozen module tree of the dependency set plus the kit itself (§2.5), is what
§2 resolves against. It is an artifact of the kit's build, not of `npm
install`, so strut's own install carries no React.

### 3.1 The dependency set

This is the stack models write most fluently, the one Claude's artifacts,
v0 and Lovable run, plus what a sophisticated app needs: routing, state,
tables, drag and drop, node graphs.

| Kind | Packages (pinned exactly per kit version) |
| --- | --- |
| UI | `react`, `react-dom`; shadcn/ui at its usual paths (`@/components/ui/button`, `card`, `dialog`, `drawer`, `dropdown-menu`, `input`, `select`, `table`, `tabs`, `tooltip`, `sheet`, `badge`, `popover`, `command`, `calendar`, `chart`, `form`, `resizable`, `skeleton`, `sidebar`, …) and `@/lib/utils` (`cn`), with their Radix primitives, `class-variance-authority`, `clsx`, `tailwind-merge`, `vaul`, `react-day-picker` and `react-resizable-panels`; `lucide-react`, `sonner`, `cmdk` |
| App structure | `react-router` (a memory router; deep links arrive as `tool-input`), `zustand`, `immer` |
| Charts and graphs | `recharts`, `d3`, `@xyflow/react` (React Flow), `three` + `@react-three/fiber` |
| Motion | `motion` (`motion/react`), with `framer-motion` aliased to it |
| Data | `@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-virtual`, `@dnd-kit/core` + `@dnd-kit/sortable`, `date-fns`, `lodash`, `zod`, `react-hook-form` + `@hookform/resolvers`, `papaparse`, `mathjs`, `simple-statistics`, `fuse.js` |
| Content | `react-markdown` + `remark-gfm` |
| Maps | `leaflet` + `react-leaflet` (tiles from a domain the manifest declares) |
| Strut | `@strut/kit`: the bridge (§3.2) and the folds. Strut's components are not in it: they are `strut/views`, an app (§3.3) |

A new library means a new kit version. Workspace app versions keep the
documents they were built with; a job's app builds on the kit its strut
ships.

### 3.2 Hooks — the bridge, so the model never writes `postMessage`

The hooks come from `@strut/kit`. They are built on react-query over a
`StrutClient { run(type, config?, input?) }` — one call, the §5 tool. In an
app, the client is the MCP Apps bridge; in a host's own page, the host
supplies it. Every hook names a STEP TYPE:

| Hook | Step (§5) |
| --- | --- |
| `useRuns(workflow, { status?, automation?, live? })`, `useRun(workflow, runId, { live? })`, `useRunEvents(workflow, runId)`, `useTranscript(workflow, runId, path, { full? })` | `run/list`, `run/get`, `run/events`, `run/transcript` |
| `useLaunch(workflow)` → `{ launch(input, params?, key?), pending }`, `useCancel()` — mutations: a function to call, never a query, so no hook launches on mount or on a poll (§5.1) | `run/launch`, `run/cancel` |
| `useWorkflow(workflow)`: description, `input:` block, params defaults | `run/workflow` |
| `useStep(type)` → `run(config, input)` | any granted step |
| `useNodes(type, { where, orderBy, limit })`, `useNode(refId)`, `useNodesByRef(refs)`, `useCreateNode(type)`, `useUpdateNode()`, `useLink()`, `useUnlink()`, `useGraphSearch()` | `graph/find` (new, §4.3), `graph-get`, `graph-get-batched`, `create-node`, `edit-node`, `create-triplet`, `delete-edge`, `graph-search` |
| `useSql(sql, params)`, `useSqlMutation()` | `sqlite/query`, `sqlite/exec`, `sqlite/batch` |
| `useAutomations(workflow)` | `automation/*` |
| `useJob()`: a job's app's own job, with its runs and deliverables | `run/list { job }`, `job/get`, `job/read` |
| `useToolInput()`: what the model or a link opened the app with | `ui/notifications/tool-input` (the bridge, not a step) |
| `useHost()` → theme, display mode, `sendMessage(text)`, `openLink(url)` | `ui/message`, `ui/open-link` (the bridge) |

`live` means a refetch interval while anything shown is in flight, plus
`run/get { wait }`'s long-poll for a single run. That replaces the 10 s
polling OpenHealth does today; push comes later (§12). A graph write
invalidates the `useNodes` queries for its type.

### 3.3 `strut/views` — strut's components, an app other apps import

Generic UI is shadcn's and the chart libraries'; strut writes none of it.
What strut writes is the views of its OWN concepts — a run, its events, an
agent's transcript, a workflow's `input:` block, a graph node — and it
ships them the way a deployment ships its own (§3.4): as an app,
`strut/views`, seeded at boot by `createStrut` from `src/apps/views/` by
tree hash, the way `job.yaml` is seeded by content hash (`views: false`
seeds nothing). Its page is the gallery of its components, rendered over
fixtures, so a person and the builder can see them. The benchmark app
imports it; the tweet app never sees it; nothing in strut's core depends
on it.

| Component | From |
| --- | --- |
| `RunGraph` | Ported from hive (`lib/strut-run-graph` + `components/strut-run-graph`, ~3.7k lines with its service and routes; already React + Tailwind) |
| `RunTimeline` | `web/src/run-overview.ts` (the fold) |
| `Transcript` | `web/src/transcript.ts` |
| `LaunchForm` | A workflow's `input:` block (`run/workflow`): the Run popover's form, in React |
| `ArtifactView` | `web/src/artifact-view.ts`: markdown, images, video, PDF, HTML, the walkthrough scrubber |
| `RunList`, `RunStatus` | `run/list` |
| `NodeCard`, `NodeSearch`, `NodeGraph` (React Flow over a node's neighborhood) | `graph/graph-get-batched`, `graph/graph-search`, `graph/graph-neighbors` |
| `ClaimsBadge` | The ledger (§11) |

- **The pure folds are the kit's**, not the views': `kit/src/folds/`
  (§3), imported by `web/`, by `strut/views` and by any app that wants to
  draw a run its own way. The folds' tests move with them.
- **The run graph's data path moves into strut.** Hive builds it from the
  run log and hydrates its nodes through stakgraph's `/api/hive/query` on
  the swarm. In `strut/views`:
  - its calls come from `run/events` through the accessed-nodes fold;
  - node details come from `graph/graph-get-batched` (up to 50 refs per
    call) through `step_run`, on both engines;
  - a child run opens on demand through the `runId` of the call that
    launched it;
  - a peer-tagged ref is badged and never opened, which is strut's rule.

  Hive's layout, lineage, replay and branch tree come over unchanged.
- **Strut's own Preact UI** can render `strut/views` components later
  through `preact/compat` (§12), so one `RunGraph` serves everywhere. v1
  does not need it: strut's UI hosts apps, and each app brings its own
  React.
- **`LaunchForm` is the routine's face** (§5.1): the workflow's `input:`
  block as a form, a button, the in-flight run it dedupes onto, and the
  last run's status. An app that only lists its routines and renders their
  output is a complete app.

### 3.4 A kit is an app other apps import

A deployment's apps share components, and the plan's first draft gave them
no way to: every app imported the one kit, and the one kit was strut's.
The generic answer needs **no new kind, no new store and no new route**: a
kit is an app, and an app may import another app's `src/` by name.

- **The import.** `import { EscalationBadge } from "hive/ui"` resolves to
  the installed app `hive/ui`'s `src/index.ts`; `"hive/ui/charts"` to
  `src/charts.ts` or `src/charts/index.ts`; `"hive/ui@v3"` pins that
  version, else the ACTIVE one — the `type: name@vN` pattern. The sources
  are compiled into the importing app's bundle (tree-shaken), so the
  document stays one file and nothing loads at runtime.
- **A kit is an ordinary app.** `apps/ui/` in hive's distro package, with
  an `app.yaml` that needs no grants and an `App.tsx` that is the gallery
  of its components over fixtures, which is how every design system
  already works; versioned, forked and updated as any app (§11); seeded
  by strut for `strut/views`. The sources it imports are the kit's and
  other apps'; its own `src/` may not import the app that imports it — a
  cycle is a build error naming the chain.
- **The importer's grants apply.** The imported code runs in the importing
  app's frame as the importing app: a kit has no grants of its own that
  travel, and a component that launches a workflow launches it on the
  importer's `grants.workflows`, or fails the call like any ungranted step.
- **The build treats imported sources as its own.** The AST checks (§2.1)
  and the Tailwind candidate scan (§2.2) run over them, and
  `dist/build.json` records each imported app's name and hash beside the
  kit's, so `app/get` reports `stale` when a kit it imports has moved. An
  update to `hive/ui` rebuilds nothing by itself; the next `app/build` or
  publish picks it up, as a kit upgrade does (§1.3).
- **In a package** (`marketplace.md` §1, §2), a kit travels as the app it
  is. `buildPackage`'s closure walks an app's imports as it walks its
  grants: a kit in the same package is an item, one in another package is
  a `requires.packages` pin, and an import nobody installed fails the
  build naming the package.
- **The prompt** (`App.md`, §8) lists the installed kits with one line
  each, read at build time from `app/list`; the build error names them.

## 4. Data — runs, the graph, the app's own SQLite

### 4.1 Why runs are not enough

A run is history. It records what one execution did; it is immutable, and
its output is whatever that execution produced. For many apps that is all
the data there is. Each run of `openhealth-run` is one attempt with its
score. Each poll of a tweet is one data point. An app reads them with
`run/list` and draws them, with no store at all (§10).

What runs cannot hold is **state a person changes in place**. An invoice is
created, edited, marked paid, or voided. Modeled as runs:
- every click becomes a workflow run;
- "the unpaid invoices of customer X" becomes a fold over every run of
  every invoice workflow, on every read;
- a correction becomes another run that the fold must know how to apply.

That is event sourcing without the materialized view, and the view is what
the app needs. Runs say what happened; the app also needs what is true now.
That state lives in one of two places, depending on its shape.

### 4.2 Choosing

| Data | Where | Why |
| --- | --- | --- |
| What workflows did, one row per execution: scores, polls, extractions | **Runs** | Already there. `run/list` and outputs, filtered by `automation` or `job` |
| Entities and their relations that others should see too: customers, visits, facts, sources, people, topics | **The graph** | Agents find them (`graph-search`, semantic), workflows write them with `graph/*`, the run graph shows which run touched which invoice (`ACCESSED`), Concepts can describe their types, and another app can read them |
| The app's own tables: line items, a 50k-row import, settings, high-frequency rows, anything summed or grouped | **The app's SQLite** | Real queries (filters, joins, sums, group by), migrations in the directory, one file per app, on every workspace backend including `fs`, which has no graph |

The `App` Concept page (§8) carries this table. "If an agent should ever
find it, it goes in the graph" is the rule of thumb.

### 4.3 The graph

**The app declares its types** in `app.yaml` (`data.graph`, §1.1).
Building or publishing registers them, add-only, on whichever engine the
workspace has:
- **Neo4j:** `createNodeSchema` (`schema-crud.ts`, jarvis's `POST /v2/schema`
  shape), which adds a new type or extends an existing one. It also creates
  the edge schemas.
- **Ladybug:** today the registry is closed: ten types in code, and every
  schema write refused (`ladybug-backend.md`, ruling 6). Apps open it for
  **declared types only**. The file keeps a table of declared types and
  edges. Each new attribute is an `ALTER ADD` column on the one `Node`
  table, the same path a code attribute takes at restart. Each new edge
  type is a `REL TABLE` from `Node` to `Node`. **App attributes get
  per-type columns** (proposed, open question 2): `Invoice__amount`, not
  `amount`, so the registry's one-type-per-attribute-name rule keeps
  holding for the code types while two apps' `amount` never meet, and the
  dialect's `project` maps the column back to its name. The cost is a
  column per (type, attribute), which a SQL-shaped store pays anyway.
  `Strut*` types and `Concept` stay code-only.
- **The `fs` backend** has no graph. An app that declares graph types does
  not build there, and the error says so.

A type an app declares is a type in the workspace's graph. Another app may
declare the same type with the same attributes (add-only), and a
conflicting declaration is a build error.

**`graph/find`, a new step**, provides the read the graph lacks: `{
node_type, where?, orderBy?, limit?, cursor?, count? }` returns nodes with
their properties. `where` takes `{ field: value }` or `{ field: { gt | gte
| lt | lte | in | contains } }`. It is written with the existing dialect
helpers (`node`, `isType`, `live`, `project`). Property access and
comparisons are the same text on both engines, and dates are ISO strings,
which compare as text. It reports nothing through `withAccessedNodes`: a
list is not what the caller named, which is the provenance rule. Today's
reader (`search`, `get`, `neighbors`, `namesLike`, `connectionCounts`) has
no property query. With `find`, "invoices where status is unpaid, due
before today, by due date" is one call.

**Writes go through the existing steps**: `graph/create-node`, `edit-node`,
`create-triplet`, `delete-edge`, `delete-node` and `move-node`. An app
reaches them with `step_run`, and its reads the same way (`graph-get`,
`graph-get-batched`, `graph-search`, `graph-neighbors`, `find`), so the
graph adds no app tool at all — the shape every other backend in §5 now
follows. **The write scope** is the safety: a write from an app is refused
on any type the app does not declare, read off `ctx.app`. For a create the
type is in the config; for an edit or delete by `ref_id`, the node is read
first. Reads may touch any type: the viewer can read the graph anyway.

### 4.4 The app's own SQLite

- **One file per app.** A workspace app's is `<dataDir>/apps/<name>/data.db`,
  shared by all its versions. A job's app's is `<path>/data.db` in the job's
  directory. Both are owner-only, like the memory file. The file uses
  `node:sqlite`, which is built into Node and already used by the
  openhealth steps on the swarm. `engines` rises to `>=22.13`, where
  `node:sqlite` needs no flag.
- **Migrations live in the directory.** The files in `db/*.sql` are applied
  in name order, each one once, each in its own transaction, and recorded
  in `_strut_migrations`. A workspace app applies them at publish, before
  the version activates: a failing migration fails the publish, its
  transaction rolls back, and nothing activates. A job's app applies them
  at build. Rolling back a version does not roll back the schema, so
  migrations must be additive; the Concept page says so.
- **The steps** (ruled: a backend is steps; there are no `sql_*` tools):
  - `sqlite/query { sql, params? }` → `{ columns, rows }`, capped;
  - `sqlite/exec { sql, params? }` → `{ changes, lastInsertRowid }`;
  - `sqlite/batch { statements }`, in one transaction.

  **Which file** is `ctx.app`'s: a page reaches its own file through
  `step_run`, and a run the app launched, or an automation it set, carries
  `app` and finds the same file from its steps. A step with no `ctx.app`
  names it — `{ app: <name> }` or `{ job, path }` — which is how an agent
  granted `agentTools: ["sqlite/*"]` or a workflow outside the app reads
  it; the argument is REFUSED when `ctx.app` is set, so a page can never
  name another app's file. `ATTACH`, `DETACH`, `VACUUM INTO`,
  `load_extension` and any PRAGMA outside a short read allowlist are
  refused by a keyword pre-check, the way `graph/query.ts` checks Cypher,
  and extensions are never enabled. Raw SQL is fine here: the worst a page
  can do is damage its own tables. A job's agent can also run `sqlite3
  apps/<name>/data.db` with its bash.
- **The export:** `GET /apps/:name/data` returns the file, behind the key.
  A job's app's database is one of the job's files.
- **Not shared.** An app's database is its own; anything shared goes in the
  graph. A second app never opens another app's file in v1.

## 5. The backend — the registry, through one tool

**Ruled (2026-10-20): an API endpoint is the same thing as a tool or a
workflow** — an input shape, an execution block, an output shape. So an app
has no tool set of its own. Its backend is the registry, reached through
ONE tool, `step_run { type, config?, input? }`, under the app's grants —
and nothing else: even its error report is a step (§8). The steps an app
calls are the steps a workflow or an agent calls — the same `run()`, the same schemas, one
implementation — and strut's own routes are thin over the same layers, as
`job/*`, `automation/*` and `strut/run-workflow` already are. The first
draft of this section minted fifteen app-only tools and then `sqlite/*`
steps as their twins for workflows; that was two implementations of one
backend.

`src/apps/tools.ts` holds `buildAppTools(app, deps)`: `step_run` with the
grant checks, one tool. It is served one way (§7.2): as an app-only tool on
the MCP doors. Every host, strut's own UI included, relays the frame's
`tools/call` there as it is; there is no HTTP call route.
`step_run` calls `runStep` with the viewer as actor and **`ctx.app` set**
(`RunStepOptions.app`, the twin of `RunStepOptions.job`); the step is kept
only by the usual rule (claims or `keep`). Results are whole data, never
trimmed for a model. A result over 5 MB is an error that names the cap.

| Family | Steps | Grant, and the scope `ctx.app` carries |
| --- | --- | --- |
| Runs | **New: `run/*`**, lib steps, unsealed, thin over the layer the routes call. `run/list { workflow, limit?, status?, since?, automation?, job? }` (summaries newest first: status, timing, cost, actor, origin, automation, job, artifacts); `run/get { workflow, runId, wait? }` (the summary, the whole `input` and `output`, the resolved artifacts); `run/events { workflow, runId, skip? }` (the log, transcripts as links, as `GET …/events` serves, capped); `run/transcript { workflow, runId, path, full? }` (one agent's session by step path, what a `transcript` link names — the route's bare array as `messages`, `full` a session turn's thread, capped with what was cut said; a page cannot follow the link, §9); `run/launch { workflow, input?, params?, job?, title?, key? }` (`launchDetached`, like `POST …/run`: `run.start` and the summary get `origin: "app"` and `app`; the actor is the viewer and the principal follows the usual rule; a `params` override may narrow a grant but never widen it — `grantWidenedBy`, the `meta/run-workflow` rule; returns `{ runId }`; with `key`, an in-flight run of the workflow launched under the same key is returned instead of a second launch, `{ runId, existing: true }`, §5.1); `run/cancel { workflow, runId }`; `run/workflow { workflow }` (the description, the active version, the `input:` block, the params defaults); `run/files { workflow, runId, path }` (one file, text or base64, capped — a page cannot fetch a URL, §9) | `grants.workflows`: the workflows these may read, launch and cancel. A job's app also its own job (§6): `run/list { job }`, `run/files { job, path }` |
| The graph | `graph/*`, as they are, plus `graph/find` (§4.3) | `grants.steps` names them; a write is refused on a type the app does not declare |
| The app's tables | `sqlite/*` (§4.4) | `grants.sqlite: true`; the file is `ctx.app`'s |
| Schedules | `automation/*`, as they are (`list`, `preview`, `create`, `update`, `delete`, `run-now`). Today they are scoped to the ONE workflow the host names (`createStrut({ automation })`) and run its approval step first; under `ctx.app` the scope is `grants.automations` and the approval is the viewer's own click — the app acts as the viewer (§11, Proposals). One step family, two scopes (open question 9) | `grants.automations` |
| The job | `job/get`, `job/read`, as they are | a job's app's own job, implicit (§6) |
| Anything else | Any registry step the manifest names: a package's own deterministic steps | `grants.steps`. Never a paid or shell-shaped step from a model-written manifest: `llm`, `agent`, `exec` and sealed steps only from a person (§5.1, §9) |
| Errors | `app/report-error { message, stack?, componentStack? }`, a step kept as a run for the agent that wrote the app (§8) | always |

**Why `meta/*` is not reused.** `meta/run-workflow` and `meta/get-run` are
the sealed surface's (EVOLVE_SPEC §6): a model-written manifest may never
grant them, and nothing about listing or launching a run is meta. The
`run/*` steps are the unsealed twins — grantable to an agent as well
(`agentTools: ["run/*"]`), the way `job/*` are.

**`ctx.app`** (Decided) is set by the app door for the call — `{ name,
version }` for a workspace app, `{ job, path }` for a job's — beside
`ctx.job` and `ctx.mcp`, never from a launch body. A run `run/launch`
starts, and an automation the app sets, carry it (the launch records `app`
as it records `job`; the scheduler hands it on at each fire as it does
`automation`), so the steps of a workflow working for the app find its
file and its types the way a job's steps find the job's directory.

### 5.1 Three responsibilities — reads, tools, routines

**Ruled (2026-10-20):** an app's agent and LLM workflows are **routines**, a
core part of what an app is for, and they must never be triggered by the
UI on its own. An app does three things, and each has its own cost and its
own trigger:

| Responsibility | Steps | Cost, and what may trigger it |
| --- | --- | --- |
| **Rendering workflow output** | `run/get`, `run/events`, `run/transcript`, `run/files`, `run/list`; the kit's `RunGraph`, `RunTimeline`, `Transcript`, `ArtifactView` | Free reads. They refetch on their own (`live`, `wait`) |
| **Calling tools** | `step_run` over `graph/*`, `sqlite/*`, `job/*`, a package's own deterministic steps | Cheap and synchronous, in the viewer's name. Fine on a render |
| **AI-agent-powered UI** | `run/launch` of a routine, then the reads above. A chat box inside an app is a workflow with an `agent` step on `session: "{{ input.session }}"`, one run per turn — the orchestrator's shape, nothing new. `ui/message` reaches the host's conversation for "change this app" | A click, a run, the viewer pays. Never a render, a refetch or a poll |

Three rules make the third row hold, and strut enforces them, not the
model-written app:

- **The workflow is the unit of spend.** `step_run` from a model-written
  manifest — the builder's, a job agent's — refuses `llm`, `agent` and
  `exec`, whatever `grants.steps` says (§9; a person's publish on the HTTP
  door may still grant them, the `peer: true` precedent). So every model
  call an app causes has a run behind it: a log, a cost on the summary, a
  cancel, the viewer's delegation through the Mothership, the claims pass.
  A one-step workflow around `llm` is the cheapest routine there is (§10).
- **A routine is a granted workflow, and launching is a mutation.**
  `grants.workflows` is the app's routine list; `run/workflow` gives each
  one's description and `input:` block, which is what `LaunchForm`
  renders. In the kit, `useLaunch` returns a function and nothing else, and
  there is no query form of it — react-query's own split: queries refetch,
  mutations fire only when called. Nothing can launch on mount or on a poll.
- **Dedupe in flight.** `run/launch { key }` returns the in-flight run of
  that workflow launched under the same key instead of starting another,
  `{ runId, existing: true }` — a double click, a re-mounted component, a
  retried request all land on one run. The same rule automations already
  have: a fire is skipped while the previous run is live.

The model is therefore always inside a run and never inside the page, which
is what makes a routine safe to show as a button: strut knows what it costs
and who clicked.

## 6. Jobs have apps

A job's agent writes an app into its own directory and hands it over the
same way it hands over a plan or a screenshot:

```json
{ "text": "…", "artifacts": [{ "id": "tracker", "kind": "app", "title": "Visit tracker", "path": "apps/tracker" }] }
```

- **`artifact-refs.ts` resolves `kind: "app"`** as it resolves any job
  `path`, pointing at the document inside it: `{ url:
  "/jobs/<job>/files/apps/tracker/dist/index.html", app: { job, path } }`.
  A host that knows `app` renders it through its bridge (§7). A host that
  does not shows the link, which opens the page with no host behind it —
  it renders, and says so. Strut's job timeline and the artifact viewer
  render it through the app host component (§7.3).
- **It is live.** One live directory sits behind one link, as with every
  job deliverable: the same `id` on a later turn is a newer version of the
  same thing. `app/build` writes `dist/` and sends `job.update { kind:
  "app" }` to a listening host, which reloads the frame. Nothing builds on
  a read: the agent builds before it hands the app over, as it runs
  `browser/verify` before it says done, and a `dist/` older than its
  sources is what a stale screenshot is — `app/get` reports it `stale` from
  `dist/build.json`'s hash.
- **`app/build { path }`**, a step the job seed grants, writes
  `dist/index.html` and `dist/build.json`. It returns the errors, the
  warnings, the size and the latest client errors, so the agent iterates
  inside its turn the way it does with `browser/verify`. `app/init { path, template? }` scaffolds a starter
  directory (§8).
- **No route is new.** The document and the manifest are the job's FILES —
  `GET /jobs/:id/files/<path>/dist/index.html`, `…/<path>/app.yaml` — on
  the file route that exists, behind the job's file token narrowed to the
  app's path (§7.2); the frame's calls go to `/mcp` like every app's, and
  that token names the job and the path. The path goes through
  `jobFilePath` (`jobs.ts`), the job file routes' guard: nothing outside
  the job's directory.
- **Grants.** An app's `app.yaml` states its grants under the meta
  surface's rules, since a model wrote them. Every job app also gets its
  own job: that job's runs (`run/list { job }`, `run/get`), its record
  (`job/get`) and its files (`run/files { job, path }`, `job/read`).
- **`ui/message` from a job's app goes to the job.** Hive puts it in the
  job's conversation, so the app talks to its agent: "add a column for the
  technician" becomes the job's next turn, and the agent edits the
  directory. Strut's own UI has no send box for jobs today (§12).
- **Publishing to the workspace** is `app/publish` (§1.2) — a person's
  "Publish as an app" click (`POST /apps { name, job, path }`), or a
  builder job on request; the job agent never holds the step (§8).
- **What the job agent is told** is the `Job App` Concept page under
  `Job` (`src/concepts/Job App.md`): its one line is in every job turn's
  kinds list, and the page says the above in the agent's terms — the
  directory, build before handover, the deliverable, what the app sees,
  who publishes — and sends it to `App` (under `Workflow Builder`, §8) for
  how to build one. The `job` seed's prompt carries no app text of its
  own.

## 7. The bridge and the hosts

### 7.1 What strut uses of MCP Apps

| Message | Use |
| --- | --- |
| `ui/initialize` → `hostContext` | Theme, `styles.variables`, `displayMode`, locale and time zone, which the kit applies |
| `tools/call` (app → host) | The §5 tool, relayed by the host to `/mcp` as it is |
| `ui/notifications/tool-input` | What the app was opened with, `{ view?, runId?, … }`, from the model or a deep link (`useToolInput`; react-router navigates to `view`) |
| `ui/message` | A message to the host's conversation (§6, §8) |
| `ui/open-link` | Host-native views: a strut deep link (a run, a job, a workflow) opens in strut's UI; anything else opens in a new tab |
| `ui/notifications/size-changed` | Inline display in a chat host |

### 7.2 The doors in strut

**HTTP.** Every route sits behind the key gate. `createStrut.test.ts`'s
sweep covers new routes by itself, and the Vite dev proxy gains `/apps`.
There is no call route: an app's calls go to the MCP door, below.

| Route | |
| --- | --- |
| `GET /apps` | Active apps: name, title, description, icon, active version, grants |
| `GET /apps/:name`, `GET /apps/:name/versions` | One app: its manifest, its files list, build info and recent client errors (§8) |
| `GET /apps/:name/:version/files[/<path>]` | The version's directory, served exactly as a run's artifacts are (`GET /artifacts/:runId[/<path>]`): the listing mints the app's **file token**, a file under it opens with `?t=`, and `dist/index.html` is the document — the token written into it as it is served, `CSP: sandbox allow-scripts` + `nosniff` as any tokened `.html` gets (`artifactHeaders`). Read with the key instead of a token it runs no script, the existing rule, so no document ever reads a credential off its URL. Every host frames the fetched bytes (§7.3, §7.4) |
| `GET /apps/:name/data` | The app's SQLite file |
| `POST /apps` | Publish `{ name, files }`, with files as a path → content map (base64 for binary). This is a person's door, so grants are unrestricted (§9). Build errors are a 400 |
| `PUT /apps/:name/active`, `DELETE /apps/:name` | Rollback; delete (a soft delete on the graph; the database file is kept until it is purged) |

**MCP.** Both doors, `/mcp` and `/mcp/builder`, gain three things:
- `resources/list` and `resources/read` for `ui://strut/app/<name>`, with
  `mimeType: text/html;profile=mcp-app`, `_meta.ui.csp.resourceDomains` from
  the manifest, and no `connectDomains`.
- One model-visible tool per active workspace app, `app_<name>`. Its
  description is the app's; it takes `{ view?: string, runId?: string }`
  and carries `_meta.ui.resourceUri`. Its text result names the app and
  its absolute URL, for a host without MCP Apps.
- `step_run` with `_meta.ui.visibility: ["app"]`: hidden from the model,
  callable by the app. (The builder door's own `run_step` is the model's,
  under the builder's rules; this one is the app's, under the app's
  grants.)

The host relays `tools/call` without saying which app sent it, so
`step_run` takes an `app` argument: the app's **file token** — not a token
of its own. `fileToken` (`auth.ts`) already mints an HMAC of a scope under
the secret, and the scope here is the app's directory: `app:<name>@<vN>`
for a workspace app, the job's token narrowed to the app's path for a job's
(`job:<id>/<path>`, a subtree the job file routes accept for reads under
it). The file route writes it into `dist/index.html` as it serves it, the
kit adds it to every call, and strut reads the app off `fileScopeOf(token)`
and applies that app's grants; a call with no valid token is refused. One
token, one meaning: this document is app X at version V and may read its
own files. Alone it is worth those files, since the call still needs the
MCP connection's credential.

`toolsetServer` gains `resources` and a per-tool `_meta` side map, which
`mcpToolsFrom` passes through; the SDK is already lazy-imported there. A
job's app CALLS through this door from day one, since there is no other —
its token names the job and the path, and strut reads the manifest from
the job's files. A job's app as a RESOURCE a model can open
(`ui://strut/job/<id>/<path>`, an `app_` tool for it) comes later (§12).

### 7.3 Strut's own UI as a host

- **The sidebar** gains an **Apps** section at the bottom, below Tools —
  collapsible, and only one of Tools / Apps open at a time — showing icon
  and title, with a filter through `src/search.ts`.
- **Selecting an app** shows it in the canvas area, the way the job timeline
  appears. The topbar shows the title, a version select for rollback, and
  **Edit with the builder**, which opens the chat with the app named. The
  deep link is `?app=<name>`, which joins `embed.ts`'s params.
- **The frame.** `api.ts` lists the version's files (which mints the
  token — `useFileScope`, as for a run's artifacts), fetches
  `dist/index.html?t=…` and frames the bytes as **`srcdoc`** in `<iframe
  sandbox="allow-scripts">` — not a `blob:` URL, which the first draft said
  and hive's `HtmlArtifactFrame` uses: a blob document's `location.origin`
  is its creator's while its `pathname` is the whole blob URL, and a
  JSON-schema validator bundled into the MCP SDK does `new URL(origin +
  pathname)` at module time, so the page died before it mounted (found by
  #250's by-hand run). No `src` ever carries a credential, and the app runs
  in an opaque origin, never same-origin. A 2.4 MB document takes about
  8 s to parse and hand-shake, which a loading overlay covers (§2.5).
- **The relay**, `web/src/app-host.ts`, is ext-apps' host bridge
  (`AppBridge`, plain TypeScript with no framework in it, so it sits in
  Preact as it is — nothing is hand-rolled):
  - `tools/call` → `/mcp`, as it is: the MCP SDK's `Client` over
    `StreamableHTTPClientTransport` pointed at `/mcp`, with the session
    cookie or the key and the `x-strut-ui: 1` header the UI sends on every
    call, wired to `AppBridge` — the pairing ext-apps is built for. Every
    other screen of the UI keeps the HTTP API as it is;
  - `ui/message` → `sendChat` on the builder chat (a workspace app);
  - `ui/open-link` → the SPA's own navigation for a strut link;
  - a theme change → `host-context-changed`.

  The same component renders a job's app in the job timeline and the
  artifact viewer.
- **The Workflow flyout** lists the apps that use the workflow
  (`USES_WORKFLOW`).

### 7.4 Any other host — the contract

Hive, Peel or a customer's portal is an MCP Apps host, one of two ways;
neither needs a strut change per host, and both end at `/mcp`:
- **Fetch the document itself.** List `GET /apps` (and a job's `app`
  deliverables), fetch the document from its file route with the token the
  listing minted, and frame it as `srcdoc` with `sandbox="allow-scripts"` — never a `blob:` URL (§7.3). Run an MCP Apps
  host bridge, and relay `tools/call` to `/mcp` AS IT IS, with its own
  credential and `x-strut-actor`. In hive this is an app frame **beside**
  `HtmlArtifactFrame`, not instead of it — a new component, or the same
  one switching mode on a `kind: "app"` deliverable, which is hive's call.
  An HTML artifact (a page an agent wrote during a run: one file, one
  run's snapshot, read-only) keeps its frame as it is, the blob URL and
  the `postMessage` nav bridge included; strut's artifact viewer keeps
  rendering it too. The app frame differs in two ways only: the document
  is framed as `srcdoc`, and its bridge is ext-apps' `AppBridge` relaying
  to `/mcp`. Nothing else hive says to strut changes: runs, jobs, chat and
  files stay on the HTTP API as today.
- **Let MCP hand it the document.** Connect to `/mcp` as an MCP Apps host
  and read the app as a resource. Then every MCP server's apps work there,
  not only strut's.

A host that wants strut's views in a page of its own renders an app that
imports `strut/views` (§3.3); a library build of the kit for a host's own
React pages is deferred (§12). Hive's OpenHealth page becomes such an app
(§10). That is adoption.

## 8. Authoring — the builders and the job agent are the developers

Three authors, one path. The chat builder, the `builder` JOB that
stakwork/strut#239 adds (`plans/builder-job.md`: the orchestrator's door to
authoring, `peer: true`, launched with `job/start { workflow: builder,
peer? }`) and a code job's agent all write an app the same way: files in a
directory, with the editor, then `app/build`, which answers with errors,
then `app/publish { name, path }`. That is the loop models are trained on
— create, build, read the errors, fix, build — minus the shell on the two
builders. There is no second, argument-shaped way to author an app (a
`files` map, an `edits` list): a workflow is one document and travels well
as a tool argument, a ten-file front-end project does not, and a shape no
model has seen would fight the very prior the fixed stack was chosen to
ride.

- **Steps** (one implementation; tools are steps — the builder's too,
  below):
  - `app/list` and `app/get { name, version? }`: the manifest, the files
    list, build info, recent client errors, `stale` for a job app (§6).
  - `app/init { path, template? }` scaffolds a starter directory: `app.yaml`
    and an `App.tsx` with a shadcn sidebar layout, react-router and an
    empty `db/`, shipped under `src/apps/templates/`, so a model starts from
    a shell that already looks right. A template is an APP: strut's own
    under `src/apps/templates/`, or any workspace or installed app by name
    (`template: acme/hvac/invoices`), its directory copied under the new
    name with no `upstream` — a COPY, not a fork (§11).
  - `app/checkout { name, version?, path }` copies a version's directory
    (`materializeAppVersion`) to a path to edit: the builder's scratch
    (`scratch/apps/<name>/`), or a job's directory.
  - `app/build { path }` (§6).
  - `app/publish { name, path, job? }` (§1.2), under the meta surface's
    rules when the caller is the meta surface; `job` publishes from another
    job's directory (a builder job publishing a code job's prototype).
- **The builder has no app tools of its own.** It gets the `app/*` steps as
  named tools through `buildRegistryTools`, the function the `agent` step
  already uses for `agentTools`: a step's input schema is the tool schema,
  its `run()` the executor. The builder is a ToolLoopAgent like the agent
  step, so `buildTools(deps)` makes the same call with one fixed grant,
  `app/*`. A job agent gets them through `agentTools: ["app/*"]`, and
  anyone through `run_step`: one implementation, three doors, no wrapper.
  The first draft had five builder tools here (`list_apps`, `get_app`,
  `checkout_app`, `build_app`, `publish_app`), each "thin over a step" —
  the §5 duplication again. The MCP builder door carries them like every
  other builder tool, since it serves `buildTools(deps)`. And because
  `app/list` and `app/get` are steps, an app may be granted them: a
  launcher that lists and opens other apps costs nothing.
- **Apps are a builder job's kind of work.** #239 rules that building
  workflows is a separate kind of work from a code job, and that the
  authoring tools are never a grant on a regular `job`. An app is that
  kind: it is published into the workspace, and the workflows it drives
  are authored in the same breath. So "build me an invoice tracker" from
  the orchestrator is `job/start { workflow: builder }`, and the `builder`
  seed's delta, made by this plan's work item 1, gains `app/*` in
  `params.tools` and the EDITOR FAMILY in `params.builtins` —
  `str_replace_based_edit_tool`, `repo_overview`, `fulltext_search`: view,
  list, grep — and still no `bash`. #239's rule is no SHELL on a workflow
  another strut may launch; the editor is not one. It is view, create,
  str_replace and insert sandboxed to the job's directory (`job/dir`, which
  the builder already has and could not write in), reaching neither the
  process nor the network, and authoring a custom step is already code
  loaded into the process. The build is a step, not `npm run build` in a
  shell, which is what lets a shell-less builder build an app at all. A
  code job's agent keeps `app/init`, `app/build` and `app/get` on the job
  seed for a job app (§6) and never `app/publish` or `app/checkout`, the
  authoring writes: a job app reaches the workspace through a person's
  click or a builder job on request (§1.2).
- **The text editor** the `agent` step already has
  (`str_replace_based_edit_tool`, its `textEdit()` handler), sandboxed to
  the builder's data directory, joins the CHAT builder's tools too. Today
  the chat has only `bash`, and a real front-end project wants an editor.
- **The prompt** is an `App` Concept page under `Workflow Builder`
  (`src/concepts/App.md`), seeded by strut and one of the kinds the
  builder's prompt lists: the chat builder and the `builder` job read it
  through `Workflow Builder`'s tree, the same `context/concept` step
  (`plans/builder-job.md` §1). A page has ONE parent, so the job agent,
  which reads `Job`'s tree, does not see it there: it reads `Job App`
  under `Job` (`src/concepts/Job App.md`), a short job-side contract — the
  job's directory, build before handover, the `kind: "app"` deliverable,
  its job's runs and files, publishing as a person's click — that sends it
  to `App` for the how-to (§6). `App` covers:
  - the layout;
  - the kit's imports and the hooks, and the installed kits — `strut/views`
    first — with how to import one (§3.4);
  - §4.2's table;
  - the grant rules;
  - additive migrations;
  - routines (§5.1): a paid or shell-shaped step is never called from the
    page — the grant is refused — so anything slow, paid or shell-shaped
    is a workflow, launched on a click (`useLaunch` with a `key`, then
    `useRun` with `live`), never on a render;
  - the four example shapes (§10).
- **Client errors come back as results.** The kit's error boundary and
  `window.onerror` call `app/report-error`, a step like any other, through
  `step_run` — and a KEPT one (`keep: true`, the `run_step` surface's own
  rule, plans/claims.md §3): the run lands under `step:app/report-error`
  with the actor, the time, the message and `app` on its summary. `app/get`
  and `app/build` read the app's last 50 from the run store. No file of its
  own. An app that crashes on a run's real output
  therefore reaches the agent in a result it reads. That is the step-lint
  and ledger lesson: the model reads the contract in a result, not in an
  instruction.
- **The app edits itself.** A request typed in the app goes out as
  `ui/message`: into the builder chat in strut's UI, the job's conversation
  for a job's app, and Claude's conversation in Claude. The agent edits
  the directory. A workspace app becomes a new version, a job's app a newer
  directory, and the host reloads the frame.

## 9. Security

An app is model-written code that runs in front of a person, with that
person's authority over the tools its grants name.

- **The page holds no credential** beyond its file token, worth its own
  files and nothing more (§7.2). The frame gets an opaque origin and only the `sandbox`
  flags; `allow-same-origin` is never set.
- **The document's own CSP**, which a host may only tighten:

  ```
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob: <resourceDomains>; font-src data: <resourceDomains>;
  media-src data: blob: <resourceDomains>; connect-src 'none';
  frame-src 'none'; form-action 'none'; base-uri 'none'
  ```

  The page can send data nowhere but through its bridge: no `fetch`, and no
  image beacon to an arbitrary `https:` host. Hive's frame policy allows
  `img-src https:`, and the document's own policy closes that. A manifest
  may not declare `connectDomains` in v1: an app talks to the world through
  a workflow, whose calls are logged.
- **Strut checks the grants on every call**, in every host, whatever the
  host checks. They box the page and never raise the viewer.
- **Graph writes are limited to the app's declared types** (§4.3). SQL
  reaches only the app's own file (§4.4).
- **The meta surface may not grant** a sealed workflow or a sealed step
  (the meta gate's rule, `authoring.ts`), nor `llm`, `exec` or `agent` in
  `grants.steps` — the workflow is the unit of spend (§5.1). This covers
  the builder and a job's agent alike, and `step_run` refuses the call even
  if the manifest says otherwise. A person's publish on the HTTP door may
  grant anything; that is the `peer: true` precedent, where a person
  vouches.
- **The build refuses the obvious holes** (§2.1). Any remaining XSS inside
  an app reaches only its own grants.
- **Billing and secrets follow the viewer.** A launch or a step from an app
  is the viewer's run: their delegation pays through the Mothership, and
  `secrets` binds to their principal.
- **Every write records who made it.** The node writer stamps no actor
  today, so `step_run` KEEPS every write — a `graph/*` write, a
  `sqlite/exec` or `sqlite/batch`; a `run/launch` is a run already — as a
  kept step run (`keep: true`), the surface `run_step` has: the record
  under `step:<type>` holds the step type, the input (the statement, the
  `ref_id`s), the output, the actor and the time, with `app` stamped on the
  summary as `job` is, so a fold by app is one scan. Reads are not kept. No
  audit file of its own; the step stats and the run list see these runs
  like any kept run.

## 10. The four apps, end to end

| App | Workflows and steps | Graph | SQLite | Kit |
| --- | --- | --- | --- | --- |
| **Benchmark hill-climb** | `openhealth-list-tasks` (the catalogue), `openhealth-run` and `openhealth-improve-loop` (launch, cancel, live), `openhealth-improve` | Reads only: the Concepts an improve step wrote | A person's notes on a run | `RunList`, `LaunchForm`, `RunGraph`, `RunTimeline`, recharts (score over time against the target line), tabs, react-router |
| **HVAC invoice tracker** | `invoice-from-photo`, where an `agent` with vision reads a photo; until uploads exist (§12) a pasted image goes in `input`, and the run returns the invoice and the app writes it. An automation on `invoice-reminders`, whose agent finds overdue invoices with `graph/find` and drafts the emails | `Customer`, `Visit`, `Invoice` plus the edges. "Mark the Henderson invoice paid" works from any agent, and `graph-search` finds "the furnace job on Elm St" | Line items, and last year's invoices imported from CSV | tanstack table, react-hook-form + zod, papaparse, react-leaflet (the day's visits), `NodeGraph` (a customer's history), sonner |
| **Fact library** | `fact-ingest`: a URL goes to an agent, which writes `Fact` and `Source` nodes and their edges with `graph/*` | `Fact`, `Source`, `Topic`. Semantic search comes free (`search: [...]` fields) | Reading lists and saved searches | `NodeSearch`, `NodeCard`, `NodeGraph` (React Flow over a topic), fuse.js, react-markdown |
| **Virality tracker** | `tweet-poll` (`http` plus an `X_BEARER_TOKEN` secret, which the builder's `request_secret` asks for). "Track this tweet" creates an automation on it with `input: { tweetId }`. "Why did this take off?" is a routine, `explain-tweet`: a one-step workflow around `llm`, launched by the button and never by the chart (§5.1) | none | none. **The automations are its state** (one per tracked tweet), and each poll's output is a data point: `run/list { automation }` is the series | recharts, motion, simple-statistics (the growth rate), `useAutomations`, `useLaunch` |

Every row is built from what strut has, plus `graph/find`, declared graph
types and the app's SQLite file. `RunList`, `LaunchForm`, `RunGraph`,
`RunTimeline`, `NodeGraph`, `NodeSearch` and `NodeCard` are `strut/views`
imports (§3.3), which the first and third rows take and the second and
fourth never load; the rest of each Kit cell is the stack.

## 11. How it meets the rest of strut

- **Claims** (`claims.md`). An app becomes a subject kind, `{ kind: "app",
  name }` for a workspace app, whose version is the app version. A job's
  app is covered by the job's own claims (`job-claims.md`). A check renders
  the app with real data and reads it: `browser/verify` against the app,
  with a recent run's `tool-input`. The document opens on its file token,
  so the key is not the problem; what the check lacks is a HOST behind the
  page to answer `ui/initialize` and relay `tools/call` (Open questions 5).
  Until then, `app/report-error` is the signal.
- **Automations.** The app uses the `automation/*` steps on granted
  workflows, through `step_run` (§5). An automation made from an app belongs to the viewer; the
  owner and principal rules are unchanged.
- **Runs.** `origin: "app"` and `app` go on `run.start` and the summary,
  and the run list and the run overview show an app chip.
- **Jobs.** §6.
- **Sealed.** §9.
- **Packages** (`marketplace.md` §1, §3, §4). **Ruled: an app is forkable
  and flexible.** An app is a package KIND — `apps/<name>/`, the first
  item that is a directory — named by the prefix rule
  (`acme/hvac/invoices`), its item hash the tree hash (§1.3), `data.db`
  never in the package. The install builds it against the installing
  strut's kit (a failed build refuses the install, so nothing about the
  kit is declared), runs its `db/*.sql` on the buyer's existing file,
  registers its graph types add-only, and its granted workflows travel in
  the package or are `requires.packages` pins (`buildPackage` walks
  `grants` as it walks subflows). **Flexible means one representation:** a
  job's live directory, a workspace version, a package member, a git repo
  and an `app/init` template are the same bytes, and every surface reads
  them. **Forking is the normal path**, the inverse of the "wrap rather
  than edit" nudge for a bought step: an edit is a fork carrying
  `upstream`, an update fast-forwards an untouched app and publishes
  beside a forked one, and the rebase is a per-file three-way merge inside
  the directory — shadcn's model, the code copied into your project so you
  can edit it, with the update path shadcn lacks. The app is the wrapper
  around bought steps, so a forked UI leaves the steps underneath
  fast-forwarding. A COPY under a new name (`app/init { template }`) has no
  `upstream`, and no update reaches it.
- **Peers.** An app is local. A workflow it launches may reach a peer
  through `strut/run-workflow`. A build on a peer is a builder job there
  (`job/start { workflow: builder, peer }`, `plans/builder-job.md` §3): the
  app is published on that strut, its deliverable comes back tagged
  `{ peer, job }` under that plan's rule, and the host resolves it against
  that strut. Nothing of an app crosses.
- **Proposals.** An app acts directly as the viewer. A gated step stays a
  matter for an agent's turn, not a button.
- **The Mothership.** Nothing new: a launch is a run.

## 12. Left out of v1

- **File uploads**: an `<input type=file>` in the frame, sent through
  `files_upload` into the app's directory of files (a workspace app's
  under `<dataDir>/apps/<name>/files/`, a job's app's in the job). The
  invoice photo waits for this.
- **Share links**: an app used by someone without strut access, such as an
  HVAC office's staff. This needs a credential that names an actor and a
  budget.
- **Push**: subscriptions over the bridge, such as a `tool-result`
  notification when a run ends or the graph changes. v1 uses polling plus
  `wait`. This is where "an endpoint is a tool" strains — a tool returns
  once and a UI wants a tail — and the fix is a subscription over the
  bridge, never a streaming route creeping back into §5.
- **A `tsc` pass at build**, against the kit's types.
- **`connectDomains`.**
- **Shared SQLite**, where one app reads another's file. The graph is the
  shared store.
- **A job's app as an MCP resource** a model can open (`ui://strut/job/…`,
  an `app_` tool for it; its CALLS go through `/mcp` from day one, §7.2),
  and **`ui/message` from a job's app in strut's UI**, which has no send
  box for jobs. Both need a "continue this job" door.
- **`strut/views` components in strut's own Preact UI** (`preact/compat`).
- **A library build of the kit** for a host's own React pages, with React
  as a peer. A host that wants strut's views renders an app importing
  `strut/views`; the folds are importable from `@strut/kit` already.
- **`meta/*` twins** of the builder's app tools. The steps are reachable
  already.

## 13. Work items

One PR each, merged in order, never stacked. Each carries its tests and its
docs: `specs/API.md` sections, AGENTS.md layout rows and a key concept, and
`package.json`'s explicit test list.

1. **The app object, the build, the first host.** **BUILT** (2026-10-21)
   as three PRs, never stacked: stakwork/strut#246 the kit (1a: the vendor
   layer and import map, the base stylesheet, the bootstrap over ext-apps,
   `StrutClient`, the run hooks), #248 the app object and the build (1b:
   `treeHash`, the manifest, `build.ts` with the resolver and the §3.4
   import rule, the store pointers on both backends with files under
   `dataDir`, the `app/*` steps, the `/apps` routes with the `app:` file
   token scope — and a kit fix: the CJS vendor entries now export their
   names through an ESM facade), #250 the backend and the hosts (1c:
   `step_run` on both MCP doors, the `run/*` steps, `ctx.app`, kept writes
   and `app/report-error`, strut's UI as a host over `/mcp`, the builder's
   `app/*` tools and editor, the `builder` seed delta, `App.md`). The
   by-hand check of §14 ran as written, in #250's body: the chat built a
   benchmark app for a scratch workflow in one turn; a launch from the page
   produced an `origin: "app"` run with the chip on its row; the app
   crashed on an in-flight run and the crash came back as a kept
   `app/report-error` run the builder read and fixed into v2, the frame
   reloading on publish; a message typed in the app reached the chat and
   made v3; rollback worked; the same ask as a `builder` job built a second
   app with no `bash` in its log, for $0.29. Two findings changed the plan:
   the frame is `srcdoc` (§7.3), and the document was 2.4 MB (§2.5). What
   the three PRs covered, as planned:
   - `WorkspaceStore` app methods on files and the graph: schemas, the
     Ladybug registry, conformance cases, the fs import.
   - `treeHash` in `src/version.ts`, the one hash for an app version and a
     package digest.
   - `src/apps/manifest.ts` and `build.ts`: esbuild and Tailwind as
     dependencies, the resolver, assets, the AST refusals and the `fetch`
     warning, the document written to `dist/` with `build.json`,
     determinism.
   - `kit/` v1: §3.1's set minus maps and 3D, the bootstrap, `StrutClient`,
     and the run, launch, workflow and step hooks.
   - The `run/*` lib steps (`src/steps/lib/run/`), thin over the layers the
     routes call.
   - `src/apps/tools.ts`: `step_run` with the grant checks and `ctx.app`
     (`RunStepOptions.app`); the `app/report-error` step, kept.
   - `step_run` on the MCP doors as an app-only tool: `toolsetServer`'s
     per-tool `_meta` for the visibility flag, the file token as its `app`
     argument. The first host needs it, so it is here, not in item 5.
   - The §7.2 HTTP routes for workspace apps — the version's file route
     with the app's file-token scope, the publish and the pointers — with
     `/apps` in the Vite proxy.
   - The strut UI host (§7.3): `AppBridge` wired to the MCP `Client` over
     `/mcp`.
   - The steps `app/init`, `app/build` and `app/publish`, and the template.
   - The `app/*` steps as the builder's tools (`buildRegistryTools` in
     `buildTools`, grant `app/*`) and the chat's text editor; the `builder`
     seed's delta (stakwork/strut#239, once merged): `app/*` in
     `params.tools`, the editor family in `params.builtins`, no bash.
   - `App.md`.

   Tests drive a test app through a fake workflow. By hand, rebuild the
   OpenHealth climb view as an app against a scratch workflow with the
   same output shape.
2. **Job apps.** **BUILT** (2026-10-21). The `kind: "app"` deliverable in `artifact-refs.ts`
   resolving to `dist/index.html` under the job's files, the job token
   narrowed to an app's path (and `step_run` reading a job app off it),
   the implicit job grant, `job.update { kind: "app" }`, `app/build` in the job seed's grants, the job timeline's
   render, and "Publish as an app". By hand, ask a job for "a tracker for
   the visits in this spreadsheet" and watch it build, open, and publish
   one. As built: `AppRef` is `{ name, version } | { job, path }`; the
   narrowed scope signs `job:<id>\0<path>` and a read tries every
   directory on the way to the file; the identity is `job:<encoded
   id>/<path>.<token>`; the implicit grant also covers `run/transcript` on
   a run of the job; `run/list { job }` with no workflow and `run/files {
   job, path }` are new forms; `app/get { path }` reads a directory back;
   `app/build` in a job checks the grants under the meta rules (nothing
   publishes it) and answers with `clientErrors`; the job agent learns all
   of it from a `Job App` Concept page under `Job` (§6, §8), not from
   `App`, whose one parent is `Workflow Builder`; the kit gained `useApp()`
   (the page's identity) and `useRuns(null, { job })`; a publish from a job
   builds in a scratch copy, so the job's own `dist/` is the agent's. By
   hand (Ladybug, a key, the `job` seed on Sonnet 5.5): the turn read the
   `App` page, scaffolded, wrote the files, built once and listed the app,
   in 41 s for $0.30, with EMPTY grants: it read the CSV through `run/files
   { job, path }` and its runs through `useRuns(null, { job })`. It opened
   in the timeline and the viewer; a second turn's build reloaded the frame
   by its hash; "Publish as an app" made `visits` v1, which opens under
   Apps — and reads no job, since the implicit grant is the job app's
   alone: a prototype's data reaches the workspace as `data.db` (item 3).
3. **SQLite.** The file per app, migrations at publish and at build, the
   `sqlite/*` steps and their refusals (the file from `ctx.app`, or named
   when there is none), the export, writes kept as step runs, and the
   `engines` bump.
4. **Graph data.** Declared types on Neo4j (`createNodeSchema`) and on
   Ladybug: the declared-types table, per-type columns by `ALTER ADD`, rel
   tables, and the conflict rule. This reverses ruling 6 for app-declared
   types only. Also `graph/find` on both engines (`testBackends()`) and the
   write scope. By hand, build the invoice tracker.
5. **MCP for models.** `toolsetServer` resources, the per-app `app_<name>`
   tools with their `_meta.ui.resourceUri`, so an MCP Apps host opens an
   app a model names (the app-only tool itself landed in item 1). By hand, have Claude render an app
   from strut's `/mcp`.
6. **Kits as apps, and `strut/views`.**
   - The resolver's installed-app rule (§3.4): the name, the `@vN` pin,
     the cycle check, imported sources through the AST checks and the
     Tailwind scan, the imported hashes in `dist/build.json` and the
     `stale` mark; `buildPackage`'s closure walking imports.
   - Move the folds to `kit/src/folds/`, with `web/` importing them.
   - `src/apps/views/`, seeded at boot (`views: false`): the gallery page,
     `RunTimeline`, `Transcript`, `LaunchForm`, `ArtifactView`, `NodeCard`,
     `NodeSearch` and `NodeGraph`.
   - `RunGraph` ported from hive over `run/events` and
     `graph/graph-get-batched`.
   - The rest of §3.1 (maps, 3D).
7. **Automations and app claims.** `automation/*` under `ctx.app`
   (`grants.automations` as the scope, the viewer's click as the approval),
   the app subject kind and a render check. By hand, build the virality
   tracker.
8. **The package kind** — in `marketplace.md`'s step order, once its steps
   1–2 exist: `apps/<name>/` in `buildPackage` and `installPackage`,
   `upstream` on app versions, the per-file merge.

## 14. Validation

- **`npm test`:**
  - **The build.** A good directory gives one document, with relative
    imports and `@/` overrides resolved. A non-kit import, an import that
    leaves the directory, `dangerouslySetInnerHTML` and `eval` are each
    refused with the reason named; a `fetch(` call warns, naming the hook.
    An import of an installed app resolves to its `src/`, `@vN` to that
    version, a cycle is refused naming the chain, an import of an app
    nobody installed fails naming the package, and the imported app's hash
    lands in `dist/build.json`. The same inputs give the same bytes, into
    `dist/`; the hash covers every file but `data.db` and `dist/`, is the
    same with any kit, and equals the package digest `marketplace.md`
    computes over the directory.
  - **The app store's conformance**, on files and on a Ladybug file.
  - **The backend.** `step_run` refuses a step outside the grants, a
    `run/*` call on an ungranted workflow, a graph write on an undeclared
    type, and a `sqlite/*` call naming a file while `ctx.app` is set. A
    `params` widening is refused. A sealed grant, and `llm`, `agent` or
    `exec` in `grants.steps`, are refused from the builder and from a job's
    agent, and accepted from a person. `run/launch { key }` returns the
    in-flight run with that key and launches nothing. A workflow launched
    through `run/launch` finds the app's file from `ctx.app`. A write from
    an app is a kept step run under `step:<type>` with the actor and `app`
    on its summary; a read is not kept; an `app/report-error` is.
  - **The graph.** A write on an undeclared type is refused, including an
    edit by `ref_id` of a Concept. `graph/find` filters, sorts and pages on
    both engines. A conflicting declaration is refused. Declared types
    survive a restart of the Ladybug file.
  - **SQLite.** Migrations run once, in order. A failing one fails the
    publish and activates nothing. `ATTACH` and `load_extension` are
    refused.
  - **Job apps.** A `kind: "app"` deliverable resolves to the document
    under the job's files. `app/get` says `stale` after an edit until
    `app/build` runs. A path out of the job is refused, and the narrowed
    token opens nothing outside the app's directory. The job grant sees
    that job's runs and no other's.
  - **The MCP door.** `resources/list` and `resources/read` work,
    `app_<name>` is listed, the app-only tool is flagged, and a missing
    or foreign token is refused. A document served by token carries it;
    the bytes in `dist/` do not. A `tools/call` of `step_run` on `/mcp`
    with a job app's token reads that app's manifest from the job's files
    and applies its grants.
  - **The key-gate sweep.**
- **By hand, with no host.** Start a scratch strut (`STRUT_WORKSPACE_BACKEND=ladybug`
  and a key). Tell the builder: "build me an invoice tracker for an HVAC
  business". Check that:
  - the app publishes, opens under Apps, and its customers and invoices
    are graph nodes that `graph_get` finds;
  - its line items survive a reload;
  - "Add a due-date column", typed in the app, reaches the chat and makes
    v2, and the frame reloads;
  - rolling back to v1 works;
  - the same ask as a `builder` job (`POST /workflows/builder/run { job,
    input: { prompt } }`) writes the app with the editor, builds it with
    `app/build` and publishes it, with no `bash` call in the run log.
- **An MCP Apps host.** Add strut's `/mcp` to Claude as a remote connector.
  "Open the invoices app" should render it inline, its tool calls should
  work, and the viewer's actor should be on what it writes. Repeat with
  the ext-apps reference host.
- **The OpenHealth climb as an app, against swarm38's lab**, once a pin
  carries it. It replaces what the hand-built page shows for one task: the
  catalogue, launch, live stages, the score chart, matched / missed /
  extra, the run graph and the improve summary. Hive changes nothing beyond
  the frame bridge.

## Open questions

1. **The split between graph and SQLite.** My rule: the graph holds what
   others should see, and SQLite what only the app needs. Should an app be
   able to keep entities in SQLite and project some of them into the graph
   (a later step), or is that the job of a workflow?
2. **Ladybug's closed registry.** Apps would open it for declared types,
   which reverses ruling 6 for non-Strut types. Because the file keeps one
   column per attribute name across all types, two apps' `amount` would
   have to agree on a type. **Proposed answer (2026-10-20): per-type
   columns** (`Invoice__amount`, §4.3), so app types never meet each other
   or the code types. Open until ruled.
3. **Where a workspace version's files and document live on the graph
   backend.** Node properties (the workspace stays self-contained, at up to
   ~20 MB per version) or directories under `dataDir` with the node holding
   the hashes? **Proposed answer (2026-10-20): `dataDir`** (§1.3), the rule
   artifacts, cassettes and jobs already follow; a graph copied without its
   `dataDir` loses them as it loses artifacts. Open until ruled.
4. **How the kit ships.** It could be built in `prepare`, which installs the
   kit's dev dependencies in every git-dependency install (mcp's), or built
   once per kit release and published as a package strut pins exactly,
   which hive can also import. My lean is the second.
5. **How a check drives an app.** The document opens on its file token, so
   the URL is no longer the problem; what `browser/verify` lacks is a HOST
   behind the page — something to answer `ui/initialize` and relay
   `tools/call` as the viewer the check runs as. A `browser/open { app }`
   that runs the bridge in the check's own page, or a check that renders
   through strut's UI signed in with a session; not designed.
6. **The file token on the MCP door.** My lean is to send it as an
   argument, since the spec has hosts forward arguments as-is. The alternative is
   `params._meta`, but the spec does not promise that hosts forward it.
7. **When migrations run against activation.** Today they run at publish,
   before the version activates, so a v2 migration lands while v1 is still
   live. The alternative is to run them at first call after activation.
8. **How hive lists apps.** A per-workspace Apps page plus a job's `app`
   deliverables, with the benchmark registry's entries becoming apps. That
   is hive's call; strut's contract is §7.4.
9. **Automations from an app.** The `automation/*` steps today serve one
   host-named workflow behind the host's approval step; §5 has them read
   `grants.automations` from `ctx.app` and take the viewer's click as the
   approval. One step family with two scopes, or does the app want its own
   `automation/*` twins? My lean is one family: the approval is a step the
   host configures, and an app with none configured simply has none.
10. **A new app's tool on a stateless door.** `app_<name>` (§7.2) is a tool
    that did not exist when the host connected. MCP announces that through
    `notifications/tools/list_changed`, which needs a session, and both
    doors are deliberately stateless — one SDK `Server` per request
    (`src/ai/mcp.ts`). So an app the builder publishes mid-conversation
    shows up in Claude Desktop or Goose only once the host refreshes its
    tool list: a new chat, a reconnect. Two ways out: a sessionful door
    (the SDK has one; strut chose stateless for simplicity), or ONE
    `open_app { name, view?, runId? }` tool — which works only if MCP Apps
    lets a tool RESULT carry `_meta.ui.resourceUri`, where my reading of
    SEP-1865 has it on the tool definition alone, so the host can prefetch
    the resource. Check the spec before work item 5. Until it is settled,
    the builder's reply names the app and its URL, and a host without the
    tool shows a link.
