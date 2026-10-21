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
> The other rows of "Decided" are mine and open. The companion plans:
> - `jobs.md` and `live-artifacts.md`: the job directory, deliverables, the
>   file token, `job.update`.
> - `automations.md`: what an app schedules.
> - `claims.md`: what tests an app.
> - `ladybug-backend.md`: the closed registry this plan opens.
> - `marketplace.md`: an app is a package member.
> - `federation.md`: apps stay local, but their workflows may reach peers.
>
> Hosts appear below only as the contract they read. Their own repos are
> adoption, not work items.

**The thesis.** Workflows are an app's server functions, steps its API,
automations its cron, the graph its knowledge base, the builder its
developer, and claims its tests. Runs are its history. The only new store
is a SQLite file of the app's own (§4).

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
| Where an app lives | **In the workspace**, published as a versioned object, **or in a job's directory** (ruled), as a live directory the job's agent edits. One build, one kit, one set of tools, both homes (§1.2, §6). A job's app can be published to the workspace |
| The stack | **Fixed and opinionated** (ruled): React 19, Tailwind 4, shadcn/ui at the import paths models know, lucide, recharts, d3, React Flow, motion, three, react-router, zustand, react-query, tanstack table, dnd-kit, date-fns, zod, papaparse, leaflet and more (§3.1). One kit version is one frozen set |
| Shared components | **A strut kit** (ruled): hooks over the bridge plus strut-native components (`RunGraph` first, ported from hive), in the same React and Tailwind stack, so a host's own pages can import them too |
| The data stores | **The graph and SQLite** (ruled), beside runs (§4). Runs are history, one row per execution. The graph holds entities and relations that agents, workflows and other apps should also see; the app declares its node and edge types in `app.yaml`. A SQLite file of the app's own holds its tables: many rows, sums, imports, settings. Earlier drafts had a strut-wide "records" store; it is gone |
| How the fixed set reaches a page | **Compiled in when the app is built**, never fetched at runtime. esbuild bundles the directory and Tailwind 4's pure-JS compiler compiles its classes, both against the kit, into ONE self-contained HTML document. With nothing to fetch, the page works under any host's CSP and offline. A workspace version keeps its document, so a strut upgrade never breaks it |
| What a build refuses | **Any bare import outside the kit**, a relative import that leaves the directory, URL imports, `dangerouslySetInnerHTML`, `eval` and `new Function`. The errors are the build's result, step-lint's pattern |
| Where an app's data comes from | **Strut, through app-only tools** (§5): runs, launches, single steps (the graph's steps among them), the app's SQL, graph reads, automations and files. One implementation, served over MCP (app-only) and over HTTP (`…/call`) |
| What an app may touch | **Its manifest's `grants`**, checked by strut on every call in every host. Graph writes are limited to the types the app declares, so an app can never rewrite a Concept or a `StrutWorkflow` node. Grants box model-written code acting as the viewer; they never raise the viewer, who already holds a full credential |
| Who pays and who acts | **The viewer.** A launch from an app is billed to whoever clicked, and binds actor secrets to them, exactly as if they had pressed Run |
| How strut knows which app is calling | **The host names it** on the HTTP door: the frame it loaded and the path it called. On the MCP door, where the host relays `tools/call` as-is, the served document carries an **app token**, an HMAC of the app's identity built the way the file token is. It says which app is calling; the connection's credential says who. Alone it is worth nothing |
| Who may grant sealed or shell-like things | **A person only.** The meta surface (the builder, `meta/*`, a job's agent) may not grant a sealed workflow or step, nor `exec` or `agent` as direct step grants; it runs those through a workflow, whose YAML is versioned and reviewable. A person on the HTTP door may grant anything, as with `peer: true` |
| How an agent learns its app broke | **In a result:** the build's errors (from `app/build`, the publish), and the app's client-side errors (the kit's error boundary calls `report_error`), returned by `get_app` and `app/build` |

## Design in one paragraph

An app is a **directory**: `app.yaml` (title, icon, `grants`, the graph
types it declares, extra image or map domains) plus `src/` (TSX, its own
shadcn overrides, CSS), `public/` (assets) and `db/` (SQL migrations).

It lives in one of two places:
- **The workspace:** published as a versioned object, content-hashed over
  its files and the kit version.
- **A job's directory:** a live directory the job's agent edits and
  declares as a deliverable `{ kind: "app", path }`.

**Building** it bundles `src/App.tsx` against the **kit** and produces one
self-contained HTML document carrying the MCP Apps bootstrap. The kit is a
frozen set of React, Tailwind, shadcn/ui and the popular chart, graph,
motion and data libraries, plus strut's own hooks and components (the run
graph among them). A bare import outside the kit is a build error that
names the set.

Any MCP Apps host renders the document in a sandboxed frame: strut's own UI
in an **Apps** section; Claude and the other MCP Apps hosts through
strut's `/mcp`; hive or any portal through `GET …/html` plus a relay.

The page holds no credential. Its `tools/call`s go to its host, which
forwards them with its own credential to strut's app-only tools, and strut
checks each call against the app's grants. Through them the app can:
- list, read, launch (billed to the viewer) and cancel runs;
- run a single step, which is how it reads and writes the graph (`graph/*`,
  writes limited to the types it declares);
- query and write its own SQLite file;
- set schedules;
- read files.

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
  workflows: [invoice-from-photo, invoice-reminders]   # read runs, launch, cancel
  steps: [graph/*, llm]             # step_run (graph writes: declared types only)
  sqlite: true                      # this app's own database (§4.4)
  automations: [invoice-reminders]  # workflows whose schedules it may set
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
  `data.db` (§4.4), dotfiles and `node_modules/`. The limits are 2,000 files
  and 20 MB, and the build refuses past them.
- **The name** follows workflow naming (`hvac-invoices`) in its own
  namespace. An app and a workflow may share a name.
- **The manifest is content.** It is shape-checked at every build, like a
  workflow's `input:` block (zod, `src/apps/manifest.ts`). Its `data.graph`
  attribute types are `string | number | boolean | date | json`, with `?`
  marking an optional one; `search` names the fields the graph indexes.

### 1.2 Two homes

| | A workspace app | A job's app |
| --- | --- | --- |
| Where | The workspace store: `apps/<name>` | The job's directory: `<dataDir>/jobs/<job>/<path>`, by convention `apps/<name>/` |
| Who writes it | The builder (`checkout_app`, `publish_app`), a person (`POST /apps`) | The job's agent, with its editor and bash, in its cwd |
| Versions | `vN`, content-hashed, an active pointer, rollback | None. One live directory behind one link, the jobs contract; `job.update` says it changed |
| Its document | Built at publish and kept with the version | Built when read, cached by content hash (`<dataDir>/apps/builds/<hash>.html`) |
| Its SQLite | `<dataDir>/apps/<name>/data.db`, shared by all its versions | `<path>/data.db`, inside the job's directory, so the agent can `sqlite3` what the person entered |
| Its URL | `/apps/<name>/…` | `/jobs/<job>/app/…?path=<path>` |
| Grants | As published: the meta surface's rules, or a person's (§9) | As its `app.yaml` says, under the meta surface's rules, plus its own job: that job's runs and files (§6) |

A job's app is **published to the workspace** with `app/publish { name,
path }`. A person does it from the job timeline ("Publish as an app"), or
the builder does it on request. The directory becomes the app's next
version, and `data.db` comes along when the workspace app has none yet. A
prototype with real data in a job becomes a real app.

### 1.3 Workspace versions and storage

- **`publishApp` follows `publishStep`.** The hash covers the sorted (path,
  sha256) list of the directory's files plus the kit version. Identical
  content reactivates the version it already is; anything else publishes
  the next `vN`. The active pointer, rollback (`PUT /apps/:name/active`) and
  the `publisher` and `owner` stamps work as they do for workflows.
  Republishing on a newer kit is a new version.
- **A version keeps** its files, its built document, `kit`, `builtAt` and
  `hash`. Old documents are never rebuilt.
- **`WorkspaceStore` gains** `listApps`, `getApp(name, version?)`,
  `publishApp(name, files, built, opts)`, `listAppVersions`,
  `materializeAppVersion(name, version) → dir` (what `checkout_app`
  copies, the twin of `materializeStepVersion`), `setActiveAppVersion` and
  `deleteApp`.
  - **Files:** `apps/<name>/_metadata.json`,
    `apps/<name>/versions/<vN>/…` (the directory as published) and
    `apps/<name>/versions/<vN>.html`.
  - **Graph:** `StrutApp` and `StrutAppVersion`, `exact_key`, joined by
    `VERSION_OF` and `ACTIVE_VERSION`. `USES_WORKFLOW` (version → workflow,
    from `grants.workflows`) makes "which apps read this workflow" one
    query, which the Workflow flyout shows. Where a version's files and
    document live on the graph is open (Open questions 3).
  - **On every layer:** the Neo4j schema (`strut-schemas.ts`), the Ladybug
    registry (`LADYBUG_STRUT_TYPES` and `LADYBUG_EDGES`), a case in
    `src/test-util/workspace-conformance.ts`, the fs → graph import
    (`fs-import.ts`), and a run of `npm run test:graph`, per the AGENTS.md
    convention.
- **Workflows do not name apps.** The grants are the link. Granting a
  workflow that does not exist is a build error. If a granted workflow is
  deleted later, the grant goes inert, and `get_app` says so.

## 2. The build

`src/apps/build.ts` is lazy-imported, as a lib step's SDK is, so building
the registry never loads esbuild. There is one function: `buildApp(dir) →
{ html, warnings } | { errors }`. A workspace publish calls it (§1.3), a
job app's read calls it (§6), and so does `app/build` (§8).

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
    kit's import map (§3.1). Anything else is an error that names the set:
    `"lodash-fp" is not in the app kit (v1). Available: react, recharts, …
    For work the kit cannot do, write a workflow and call it with useLaunch`.
  - **`http(s):` imports** are refused.

  Resolution never consults `node_modules`, so a host's own React or zod
  (mcp, hive) can never leak into a build, and the "one copy per process"
  rule is untouched. None of this code runs in the server process.
- **The AST checks**, over every source file. `dangerouslySetInnerHTML`,
  `eval` and `new Function` are refused. Markdown goes through the kit's
  `react-markdown`, which is safe by default. Even with `connect-src 'none'`
  (§9), a script injected into an app could call that app's granted tools
  as the viewer, so the build closes the door it can see.
- **Types are not checked in v1**, because esbuild strips them. A `tsc` pass
  against the kit's `.d.ts` comes later (§12). Render errors reach the
  agent through `report_error` (§8).

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
- turns render failures and `window.onerror` into `report_error`.

The output is deterministic: the same inputs give the same bytes. The app
token (§7.2) is injected when the document is **served**, never at build,
so rotating the signing secret rebuilds nothing.

### 2.5 Size

esbuild tree-shakes per app, and a typical app lands at 300 KB–1.5 MB.
three and mathjs tree-shake poorly, so an app that uses either imports it
whole. A document over 6 MB is still built, and the result carries a
warning.

## 3. The kit

The kit lives in `kit/` in this repo, with its own `package.json`. It has
one source and two builds:
- **The vendor layer:** the frozen browser bundles of the dependency set
  plus the kit itself. This is what §2 resolves against. It is an artifact
  of the kit's build, not of `npm install`, so strut's own install carries
  no React.
- **The library:** the hooks and components, with React as a peer, for a
  host's own pages. Hive's `package.json` already lists this exact stack
  (React 19, Tailwind 4, shadcn, framer-motion, d3 and react-query), so hive
  can import the kit directly.

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
| Strut | `@strut/kit`: §3.2 and §3.3 |

A new library means a new kit version. Workspace app versions keep the
documents they were built with; a job's app builds on the kit its strut
ships.

### 3.2 Hooks — the bridge, so the model never writes `postMessage`

The hooks come from `@strut/kit`. They are built on react-query over a
`StrutClient { call(tool, args) }`. In an app, the client is the MCP Apps
bridge; in a host's own page, the host supplies it.

| Hook | Tool (§5) |
| --- | --- |
| `useRuns(workflow, { status?, automation?, live? })`, `useRun(workflow, runId, { live? })`, `useRunEvents(workflow, runId)` | `runs_list`, `run_get`, `run_events` |
| `useLaunch(workflow)` → `{ launch(input, params?), pending }`, `useCancel()` | `run_launch`, `run_cancel` |
| `useWorkflow(workflow)`: description, `input:` block, params defaults | `workflow_get` |
| `useStep(type)` → `run(config, input)` | `step_run` |
| `useNodes(type, { where, orderBy, limit })`, `useNode(refId)`, `useNodesByRef(refs)`, `useCreateNode(type)`, `useUpdateNode()`, `useLink()`, `useUnlink()`, `useGraphSearch()` | `step_run` over `graph/find` (new, §4.3), `graph-get`, `graph-get-batched`, `create-node`, `edit-node`, `create-triplet`, `delete-edge`, `graph-search` |
| `useSql(sql, params)`, `useSqlMutation()` | `sql_query`, `sql_exec`, `sql_batch` |
| `useAutomations(workflow)` | `automations_*` |
| `useJob()`: a job's app's own job, with its runs and deliverables | `runs_list { job }`, `files_read` |
| `useToolInput()`: what the model or a link opened the app with | `ui/notifications/tool-input` |
| `useHost()` → theme, display mode, `sendMessage(text)`, `openLink(url)` | `ui/message`, `ui/open-link` |

`live` means a refetch interval while anything shown is in flight, plus
`run_get { wait }`'s long-poll for a single run. That replaces the 10 s
polling OpenHealth does today; push comes later (§12). A graph write
invalidates the `useNodes` queries for its type.

### 3.3 Strut components — only for strut's own concepts

Generic UI is shadcn's and the chart libraries'; the kit writes none of it.

| Component | From |
| --- | --- |
| `RunGraph` | Ported from hive (`lib/strut-run-graph` + `components/strut-run-graph`, ~3.7k lines with its service and routes; already React + Tailwind) |
| `RunTimeline` | `web/src/run-overview.ts` (the fold) |
| `Transcript` | `web/src/transcript.ts` |
| `LaunchForm` | A workflow's `input:` block (`workflow_get`): the Run popover's form, in React |
| `ArtifactView` | `web/src/artifact-view.ts`: markdown, images, video, PDF, HTML, the walkthrough scrubber |
| `RunList`, `RunStatus` | `runs_list` |
| `NodeCard`, `NodeSearch`, `NodeGraph` (React Flow over a node's neighborhood) | `graph/graph-get-batched`, `graph/graph-search`, `graph/graph-neighbors` |
| `ClaimsBadge` | The ledger (§11) |

- **The pure folds move** from `web/src/` into `kit/src/core/`, and `web/`
  imports them from there. That leaves one copy for strut's UI, the kit and
  hosts, and the folds' tests move with them.
- **The run graph's data path moves into strut.** Hive builds it from the
  run log and hydrates its nodes through stakgraph's `/api/hive/query` on
  the swarm. In the kit:
  - its calls come from `run_events` through the accessed-nodes fold;
  - node details come from `graph/graph-get-batched` (up to 50 refs per
    call) through `step_run`, on both engines;
  - a child run opens on demand through the `runId` of the call that
    launched it;
  - a peer-tagged ref is badged and never opened, which is strut's rule.

  Hive's layout, lineage, replay and branch tree come over unchanged.
- **Strut's own Preact UI** can render kit components later through
  `preact/compat` (§12), so one `RunGraph` serves everywhere. v1 does not
  need it: strut's UI hosts apps, and each app brings its own React.

## 4. Data — runs, the graph, the app's own SQLite

### 4.1 Why runs are not enough

A run is history. It records what one execution did; it is immutable, and
its output is whatever that execution produced. For many apps that is all
the data there is. Each run of `openhealth-run` is one attempt with its
score. Each poll of a tweet is one data point. An app reads them with
`runs_list` and draws them, with no store at all (§10).

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
| What workflows did, one row per execution: scores, polls, extractions | **Runs** | Already there. `runs_list` and outputs, filtered by `automation` or `job` |
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
  type is a `REL TABLE` from `Node` to `Node`. The registry's existing rule
  still holds: an attribute name must have one type across every type in
  the file, so two apps cannot give `amount` two different types; that is
  a build error naming both. `Strut*` types and `Concept` stay code-only.
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
graph adds no app tool at all. **The write scope** is the
safety: a write from an app is refused on any type the app does not
declare. For a create the type is in the config; for an edit or delete by
`ref_id`, the node is read first. Reads may touch any type: the viewer can
read the graph anyway.

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
- **The tools:**
  - `sql_query { sql, params? }` → `{ columns, rows }`, capped;
  - `sql_exec { sql, params? }` → `{ changes, lastInsertRowid }`;
  - `sql_batch { statements }`, in one transaction.

  They reach this app's own file only. `ATTACH`, `DETACH`, `VACUUM INTO`,
  `load_extension` and any PRAGMA outside a short read allowlist are
  refused by a keyword pre-check, the way `graph/query.ts` checks Cypher,
  and extensions are never enabled. Raw SQL is fine here: the worst a page
  can do is damage its own tables.
- **The steps:** `sqlite/query` and `sqlite/exec { app | job + path, sql,
  params? }` let a workflow or an agent reach an app's database by naming
  the app. They are grantable (`agentTools: ["sqlite/*"]`). A job's agent
  can also run `sqlite3 apps/<name>/data.db` with its bash.
- **The export:** `GET /apps/:name/data` returns the file, behind the key.
  A job's app's database is one of the job's files.
- **Not shared.** An app's database is its own; anything shared goes in the
  graph. A second app never opens another app's file in v1.

## 5. The app's tools — the backend

`src/apps/tools.ts` holds `buildAppTools(app, deps)`, which returns an AI
SDK `ToolSet` like `buildAssistantTools`. It is served two ways (§7): as
app-only tools over MCP, and as `POST …/call { tool, args }` over HTTP.
Every call checks the app's grants first. Results are whole data, never
trimmed for a model. A result over 5 MB is an error that names the cap.

| Tool | Grant | What it does |
| --- | --- | --- |
| `runs_list { workflow, limit?, status?, since?, automation?, job? }` | `workflows` (`job`: a job's app's own job) | Summaries, newest first: status, timing, cost, actor, origin, automation, job, artifacts |
| `run_get { workflow, runId, wait? }` | `workflows` | The summary, the whole `input` and `output`, and the resolved artifacts |
| `run_events { workflow, runId, skip? }` | `workflows` | The log, with transcripts as links (what `GET …/events` serves), capped |
| `run_launch { workflow, input?, params?, job?, title? }` | `workflows` | Calls `launchDetached`, like `POST …/run`. `run.start` and the summary get `origin: "app"` and `app: { name, version } \| { job, path }`. The actor is the viewer, and the principal follows the usual rule. A `params` override may narrow a grant but never widen it (`grantWidenedBy`, the `meta/run-workflow` rule). Returns `{ runId }` |
| `run_cancel { workflow, runId }` | `workflows` | The cancel that the control route does |
| `workflow_get { workflow }` | `workflows` | The description, the active version, the `input:` block, the params defaults |
| `step_run { type, config?, input? }` | `steps` | Calls `runStep` with the viewer as actor; the step is kept only by the usual rule (claims or `keep`). Graph writes get the §4.3 scope |
| `sql_query`, `sql_exec`, `sql_batch` | `sqlite` | §4.4 |
| `automations_list`, `automations_set`, `automations_delete { workflow, … }` | `automations` | The scheduler's layer (`createAutomations`), as the routes call it; `set` answers with `summary` and `next` |
| `files_read { workflow, runId, path }` or `{ job, path }` | `workflows`, or a job's app's own job | One file, as text or base64, capped. A page cannot fetch a URL (§9) |
| `report_error { message, stack?, componentStack? }` | always | Kept for the agent that wrote the app (§8) |

## 6. Jobs have apps

A job's agent writes an app into its own directory and hands it over the
same way it hands over a plan or a screenshot:

```json
{ "text": "…", "artifacts": [{ "id": "tracker", "kind": "app", "title": "Visit tracker", "path": "apps/tracker" }] }
```

- **`artifact-refs.ts` resolves `kind: "app"`** to `{ url:
  "/jobs/<job>/app/html?path=apps/tracker", app: { job, path } }`. A host
  that knows `app` renders it through its bridge (§7). A host that does
  not shows the link, which opens an inert page. Strut's job timeline and
  the artifact viewer render it through the app host component (§7.3).
- **It is live.** One live directory sits behind one link, as with every
  job deliverable: the same `id` on a later turn is a newer version of the
  same thing. A read builds the document when the directory's content hash
  changed and caches it by hash. `app/build` sends `job.update { kind:
  "app" }` to a listening host, which reloads the frame.
- **`app/build { path }`**, a step the job seed grants, builds without
  serving. It returns the errors, the warnings, the size and the latest
  client errors, so the agent iterates inside its turn the way it does with
  `browser/verify`. `app/init { path, template? }` scaffolds a starter
  directory (§8).
- **The routes**, behind the key:
  - `GET /jobs/:id/app?path=`: the manifest and the build status;
  - `GET /jobs/:id/app/html?path=`: the document;
  - `POST /jobs/:id/app/call?path=`: `{ tool, args }`, §5.

  The path goes through `jobFilePath` (`jobs.ts`), the job file routes'
  guard: nothing outside the job's directory.
- **Grants.** An app's `app.yaml` states its grants under the meta
  surface's rules, since a model wrote them. Every job app also gets its
  own job: that job's runs (`runs_list { job }`, `run_get`) and its files
  (`files_read { job }`).
- **`ui/message` from a job's app goes to the job.** Hive puts it in the
  job's conversation, so the app talks to its agent: "add a column for the
  technician" becomes the job's next turn, and the agent edits the
  directory. Strut's own UI has no send box for jobs today (§12).
- **Publishing to the workspace** is `app/publish` (§1.2).

## 7. The bridge and the hosts

### 7.1 What strut uses of MCP Apps

| Message | Use |
| --- | --- |
| `ui/initialize` → `hostContext` | Theme, `styles.variables`, `displayMode`, locale and time zone, which the kit applies |
| `tools/call` (app → host) | The §5 tools |
| `ui/notifications/tool-input` | What the app was opened with, `{ view?, runId?, … }`, from the model or a deep link (`useToolInput`; react-router navigates to `view`) |
| `ui/message` | A message to the host's conversation (§6, §8) |
| `ui/open-link` | Host-native views: a strut deep link (a run, a job, a workflow) opens in strut's UI; anything else opens in a new tab |
| `ui/notifications/size-changed` | Inline display in a chat host |

### 7.2 The doors in strut

**HTTP.** Every route sits behind the key gate. `createStrut.test.ts`'s
sweep covers new routes by itself, and the Vite dev proxy gains `/apps`.

| Route | |
| --- | --- |
| `GET /apps` | Active apps: name, title, description, icon, active version, grants |
| `GET /apps/:name`, `GET /apps/:name/versions` | One app: its manifest, its files list, build info and recent client errors (§8) |
| `GET /apps/:name/html[?version=]` | The built document's bytes, with the app token injected, for a host to FETCH. It is served `CSP: sandbox` (no scripts) and `nosniff`. Anyone who opens the URL directly, `?key=` and all, sees an inert page, so no script ever reads a credential off its own URL — the `artifactHeaders` lesson. Every host frames the fetched bytes (§7.3, §7.4) |
| `GET /apps/:name/data` | The app's SQLite file |
| `POST /apps` | Publish `{ name, files }`, with files as a path → content map (base64 for binary). This is a person's door, so grants are unrestricted (§9). Build errors are a 400 |
| `PUT /apps/:name/active`, `DELETE /apps/:name` | Rollback; delete (a soft delete on the graph; the database file is kept until it is purged) |
| `POST /apps/:name/call` | `{ tool, args }` → §5. The path names the app: the host that framed the document vouches for which one it loaded |
| `GET /jobs/:id/app[/html]?path=`, `POST /jobs/:id/app/call?path=` | A job's app (§6) |

**MCP.** Both doors, `/mcp` and `/mcp/builder`, gain three things:
- `resources/list` and `resources/read` for `ui://strut/app/<name>`, with
  `mimeType: text/html;profile=mcp-app`, `_meta.ui.csp.resourceDomains` from
  the manifest, and no `connectDomains`.
- One model-visible tool per active workspace app, `app_<name>`. Its
  description is the app's; it takes `{ view?: string, runId?: string }`
  and carries `_meta.ui.resourceUri`. Its text result names the app and
  its absolute URL, for a host without MCP Apps.
- The §5 tools with `_meta.ui.visibility: ["app"]`: hidden from the model,
  callable by the app.

The host relays `tools/call` without saying which app sent it, so every
app-only tool takes an `app` argument: the **app token**. It is an HMAC of
`app:<name>@<version>` under the file token's secret (`tokenSecret`,
`auth.ts`). The served document carries it, and the kit adds it to every
call; strut applies that app's grants and refuses a call with no valid
token. The token opens nothing alone, since the call still needs the MCP
connection's credential.

`toolsetServer` gains `resources` and a per-tool `_meta` side map, which
`mcpToolsFrom` passes through; the SDK is already lazy-imported there.
Job apps over MCP come later (§12).

### 7.3 Strut's own UI as a host

- **The sidebar** gains an **Apps** section above Workflows, showing icon
  and title, with a filter through `src/search.ts`.
- **Selecting an app** shows it in the canvas area, the way the job timeline
  appears. The topbar shows the title, a version select for rollback, and
  **Edit with the builder**, which opens the chat with the app named. The
  deep link is `?app=<name>`, which joins `embed.ts`'s params.
- **The frame.** `api.ts` fetches the document (with the key as a header,
  or with the session) and frames it as a blob URL in `<iframe
  sandbox="allow-scripts">`, as hive's `HtmlArtifactFrame` does. No `src`
  ever carries a credential, and the app runs in an opaque origin, never
  same-origin.
- **The relay**, `web/src/app-host.ts`, is ext-apps' host bridge
  (`AppBridge`), or the handful of messages by hand if that will not sit in
  Preact:
  - `tools/call` → the app's `…/call` route;
  - `ui/message` → `sendChat` on the builder chat (a workspace app);
  - `ui/open-link` → the SPA's own navigation for a strut link;
  - a theme change → `host-context-changed`.

  The same component renders a job's app in the job timeline and the
  artifact viewer.
- **The Workflow flyout** lists the apps that use the workflow
  (`USES_WORKFLOW`).

### 7.4 Any other host — the contract

Hive, Peel or a customer's portal does one of two things; neither needs a
strut change per host:
- **The HTTP route.** List `GET /apps` (and a job's `app` deliverables),
  fetch `…/html`, and frame it `sandbox="allow-scripts"`. Run an MCP Apps
  host bridge, and relay `tools/call` to `…/call` with its own credential
  and `x-strut-actor`. Hive's `HtmlArtifactFrame` already fetches a swarm
  page into a sandboxed blob and runs a `postMessage` nav bridge; this swaps
  the nav-only bridge for an MCP Apps one.
- **MCP.** Connect to `/mcp` as an MCP Apps host. Then every MCP server's
  apps work there, not only strut's.

A host's own pages may also import the kit's library build and give it a
client over the host's routes. Hive's OpenHealth page could swap its run
graph for the kit's. That is adoption.

## 8. Authoring — the builder and the job agent are the developers

Both write an app the same way: files in a directory, with their editor and
bash, then a build that answers with errors.

- **Steps** (one implementation; tools are steps):
  - `app/init { path, template? }` scaffolds a starter directory: `app.yaml`
    and an `App.tsx` with a shadcn sidebar layout, react-router and an
    empty `db/`, shipped under `src/apps/templates/`, so a model starts from
    a shell that already looks right.
  - `app/build { path }` (§6).
  - `app/publish { name, path }` (§1.2), under the meta surface's rules when
    the caller is the meta surface.
- **The builder chat:**
  - `list_apps` and `get_app { name, version? }` (manifest, files list,
    build info, recent client errors);
  - `checkout_app { name, version? }` copies the version into its scratch
    (`scratch/apps/<name>/`, through `materializeAppVersion`);
  - `build_app { path }` and `publish_app { name, path }`, thin over the
    steps;
  - the **text editor** the `agent` step already has
    (`str_replace_based_edit_tool`, its `textEdit()` handler), sandboxed to
    the builder's data directory. Today the builder has only `bash`, and a
    real front-end project wants an editor.

  The MCP builder door carries these like every other builder tool.
- **The prompt** is an `App` Concept page under `Workflow Builder`
  (`src/concepts/App.md`), seeded by strut and one of the kinds the
  builder's prompt lists. The job workflow reads the same page through
  `Job`'s tree. It covers:
  - the layout;
  - the kit's imports, the hooks and the components;
  - §4.2's table;
  - the grant rules;
  - additive migrations;
  - when to put work in a workflow instead (anything slow, paid or
    shell-shaped: `useLaunch`, then `useRun` with `live`);
  - the four example shapes (§10).
- **Client errors come back as results.** The kit's error boundary and
  `window.onerror` call `report_error`. Strut keeps the last 50 per app
  version or job app (`<dataDir>/apps/errors/<key>.jsonl`), and `get_app`
  and `app/build` return them. An app that crashes on a run's real output
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

- **The page holds no credential** beyond the app token, which is worthless
  alone (§7.2). The frame gets an opaque origin and only the `sandbox`
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
  (the meta gate's rule, `authoring.ts`), nor `exec` or `agent` in
  `grants.steps`. This covers the builder and a job's agent alike. A
  person's publish on the HTTP door may grant anything; that is the
  `peer: true` precedent, where a person vouches.
- **The build refuses the obvious holes** (§2.1). Any remaining XSS inside
  an app reaches only its own grants.
- **Billing and secrets follow the viewer.** A launch or a step from an app
  is the viewer's run: their delegation pays through the Mothership, and
  `secrets` binds to their principal.
- **Every write records who made it.** The node writer stamps no actor
  today, so the app tool layer writes one audit line per write, whether it
  is a graph step through `step_run` or `sql_exec` / `sql_batch`. Each line
  holds the tool, the step type or the statement's first 200 chars, the
  `ref_id`s or the change count, the actor and the time, and lands in
  `<dataDir>/apps/audit/<key>.jsonl`.

## 10. The four apps, end to end

| App | Workflows and steps | Graph | SQLite | Kit |
| --- | --- | --- | --- | --- |
| **Benchmark hill-climb** | `openhealth-list-tasks` (the catalogue), `openhealth-run` and `openhealth-improve-loop` (launch, cancel, live), `openhealth-improve` | Reads only: the Concepts an improve step wrote | A person's notes on a run | `RunList`, `LaunchForm`, `RunGraph`, `RunTimeline`, recharts (score over time against the target line), tabs, react-router |
| **HVAC invoice tracker** | `invoice-from-photo`, where an `agent` with vision reads a photo; until uploads exist (§12) a pasted image goes in `input`, and the run returns the invoice and the app writes it. An automation on `invoice-reminders`, whose agent finds overdue invoices with `graph/find` and drafts the emails | `Customer`, `Visit`, `Invoice` plus the edges. "Mark the Henderson invoice paid" works from any agent, and `graph-search` finds "the furnace job on Elm St" | Line items, and last year's invoices imported from CSV | tanstack table, react-hook-form + zod, papaparse, react-leaflet (the day's visits), `NodeGraph` (a customer's history), sonner |
| **Fact library** | `fact-ingest`: a URL goes to an agent, which writes `Fact` and `Source` nodes and their edges with `graph/*` | `Fact`, `Source`, `Topic`. Semantic search comes free (`search: [...]` fields) | Reading lists and saved searches | `NodeSearch`, `NodeCard`, `NodeGraph` (React Flow over a topic), fuse.js, react-markdown |
| **Virality tracker** | `tweet-poll` (`http` plus an `X_BEARER_TOKEN` secret, which the builder's `request_secret` asks for). "Track this tweet" creates an automation on it with `input: { tweetId }`, and `llm` runs as a step for "why did this take off?" | none | none. **The automations are its state** (one per tracked tweet), and each poll's output is a data point: `runs_list { automation }` is the series | recharts, motion, simple-statistics (the growth rate), `useAutomations` |

Every row is built from what strut has, plus `graph/find`, declared graph
types and the app's SQLite file.

## 11. How it meets the rest of strut

- **Claims** (`claims.md`). An app becomes a subject kind, `{ kind: "app",
  name }` for a workspace app, whose version is the app version. A job's
  app is covered by the job's own claims (`job-claims.md`). A check renders
  the app with real data and reads it: `browser/verify` against the app,
  with a recent run's `tool-input`. The browser container must open the
  app without the key in a URL (Open questions 5). Until then,
  `report_error` is the signal.
- **Automations.** The app uses the `automations_*` tools on granted
  workflows. An automation made from an app belongs to the viewer; the
  owner and principal rules are unchanged.
- **Runs.** `origin: "app"` and `app` go on `run.start` and the summary,
  and the run list and the run overview show an app chip.
- **Jobs.** §6.
- **Sealed.** §9.
- **Packages** (`marketplace.md`). An app is a package member, like a
  workflow or a step. The package carries the directory, without its
  `data.db`, and the app is built at install against the installing
  strut's kit. Its declared graph types register then, and its granted
  workflows travel with it or are named as requirements.
- **Peers.** An app is local. A workflow it launches may reach a peer
  through `strut/run-workflow`.
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
  `wait`.
- **A `tsc` pass at build**, against the kit's types.
- **`connectDomains`.**
- **Shared SQLite**, where one app reads another's file. The graph is the
  shared store.
- **Job apps over MCP**, and **`ui/message` from a job's app in strut's
  UI**, which has no send box for jobs. Both need a "continue this job"
  door.
- **Kit components in strut's own Preact UI** (`preact/compat`).
- **`meta/*` twins** of the builder's app tools. The steps are reachable
  already.

## 13. Work items

One PR each, merged in order, never stacked. Each carries its tests and its
docs: `specs/API.md` sections, AGENTS.md layout rows and a key concept, and
`package.json`'s explicit test list.

1. **The app object, the build, the first host.**
   - `WorkspaceStore` app methods on files and the graph: schemas, the
     Ladybug registry, conformance cases, the fs import.
   - `src/apps/manifest.ts` and `build.ts`: esbuild and Tailwind as
     dependencies, the resolver, assets, the AST refusals, the document,
     determinism.
   - `kit/` v1: §3.1's set minus maps and 3D, the bootstrap, `StrutClient`,
     and the run, launch, workflow and step hooks.
   - `src/apps/tools.ts`: the run, workflow, step and `report_error` tools,
     with grant checks.
   - The §7.2 HTTP routes for workspace apps, with `/apps` in the Vite
     proxy.
   - The strut UI host (§7.3).
   - The steps `app/init`, `app/build` and `app/publish`, and the template.
   - The builder's tools and its text editor.
   - `App.md`.

   Tests drive a test app through a fake workflow. By hand, rebuild the
   OpenHealth climb view as an app against a scratch workflow with the
   same output shape.
2. **Job apps.** The `kind: "app"` deliverable in `artifact-refs.ts`, the
   build cache, the job routes, the implicit job grant, `job.update {
   kind: "app" }`, `app/build` in the job seed's grants, the job timeline's
   render, and "Publish as an app". By hand, ask a job for "a tracker for
   the visits in this spreadsheet" and watch it build, open, and publish
   one.
3. **SQLite.** The file per app, migrations at publish and at build, the
   `sql_*` tools and their refusals, `sqlite/*` steps, the export, the audit
   line, and the `engines` bump.
4. **Graph data.** Declared types on Neo4j (`createNodeSchema`) and on
   Ladybug: the declared-types table, `ALTER ADD`, rel tables, and the
   conflict rule. This reverses ruling 6 for app-declared types only. Also
   `graph/find` on both engines (`testBackends()`) and the write scope. By
   hand, build the invoice tracker.
5. **MCP.** `toolsetServer` resources and `_meta`, the per-app tools, the
   app-only tools and the app token. By hand, have Claude render an app
   from strut's `/mcp`.
6. **Strut components.**
   - Move the folds to `kit/src/core/`, with `web/` importing them.
   - `RunTimeline`, `Transcript`, `LaunchForm`, `ArtifactView`, `NodeCard`,
     `NodeSearch` and `NodeGraph`.
   - `RunGraph` ported from hive over `run_events` and
     `graph/graph-get-batched`.
   - The rest of §3.1 (maps, 3D).
   - The kit's library build.
7. **Automations and app claims.** The `automations_*` tools, the app
   subject kind and a render check. By hand, build the virality tracker.

## 14. Validation

- **`npm test`:**
  - **The build.** A good directory gives one document, with relative
    imports and `@/` overrides resolved. A non-kit import, an import that
    leaves the directory, `dangerouslySetInnerHTML` and `eval` are each
    refused with the reason named. The same inputs give the same bytes, and
    the hash covers every file and the kit.
  - **The app store's conformance**, on files and on a Ladybug file.
  - **The app tools.** Each is refused outside its grant. A `params`
    widening is refused. A sealed grant is refused from the builder and
    from a job's agent, and accepted from a person.
  - **The graph.** A write on an undeclared type is refused, including an
    edit by `ref_id` of a Concept. `graph/find` filters, sorts and pages on
    both engines. A conflicting declaration is refused. Declared types
    survive a restart of the Ladybug file.
  - **SQLite.** Migrations run once, in order. A failing one fails the
    publish and activates nothing. `ATTACH` and `load_extension` are
    refused.
  - **Job apps.** A `kind: "app"` deliverable resolves. A read after an
    edit rebuilds. A path out of the job is refused. The job grant sees
    that job's runs and no other's.
  - **The MCP door.** `resources/list` and `resources/read` work,
    `app_<name>` is listed, the app-only tools are flagged, and a missing
    or foreign token is refused.
  - **The key-gate sweep.**
- **By hand, with no host.** Start a scratch strut (`STRUT_WORKSPACE_BACKEND=ladybug`
  and a key). Tell the builder: "build me an invoice tracker for an HVAC
  business". Check that:
  - the app publishes, opens under Apps, and its customers and invoices
    are graph nodes that `graph_get` finds;
  - its line items survive a reload;
  - "Add a due-date column", typed in the app, reaches the chat and makes
    v2, and the frame reloads;
  - rolling back to v1 works.
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
   column per attribute name across all types, two apps' `amount` must
   agree on a type. Is that acceptable, or should app attributes be
   namespaced per type (`Invoice.amount` as its own column)?
3. **Where a workspace version's files and document live on the graph
   backend.** Node properties (the workspace stays self-contained, at up to
   ~20 MB per version) or content-addressed blobs under `dataDir` with the
   node holding the hashes (lighter, but a graph copied without `dataDir`
   loses them)?
4. **How the kit ships.** It could be built in `prepare`, which installs the
   kit's dev dependencies in every git-dependency install (mcp's), or built
   once per kit release and published as a package strut pins exactly,
   which hive can also import. My lean is the second.
5. **How a check opens an app** without a key in a URL: a short-lived,
   read-only view token the verify pass mints for its own browser call, or a
   session in a storage-state secret.
6. **The app token on the MCP door.** My lean is to send it as an argument,
   since the spec has hosts forward arguments as-is. The alternative is
   `params._meta`, but the spec does not promise that hosts forward it.
7. **When migrations run against activation.** Today they run at publish,
   before the version activates, so a v2 migration lands while v1 is still
   live. The alternative is to run them at first call after activation.
8. **How hive lists apps.** A per-workspace Apps page plus a job's `app`
   deliverables, with the benchmark registry's entries becoming apps. That
   is hive's call; strut's contract is §7.4.
