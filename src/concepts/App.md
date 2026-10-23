---
description: An APP — a front-end project over this strut's workflows, built against a fixed kit and rendered by any MCP Apps host; how to lay one out, what it may call, pinning one as a tab of the workspace, and the rules that keep it cheap and safe.
parent: Workflow Builder
---
An APP is interactive software the builder writes on top of this strut's
own workflows (plans/apps.md): a directory of TSX, CSS and an `app.yaml`,
built against a FIXED kit into one self-contained HTML document, published
as a versioned object in the workspace and rendered in a sandboxed frame by
strut's own UI, by a portal, by Claude — any MCP Apps host. Its backend is the
registry, reached through ONE tool under the grants its manifest declares.
Workflows are its server functions, steps its API, runs its history.

## Layout

```
apps/<name>/
  app.yaml            # the manifest: title, description, icon (a lucide name), grants, data
  src/App.tsx         # the entry — its default export is the root component
  src/pages/*.tsx     # anything else the app is made of
  src/components/ui/  # optional: overrides of the kit's shadcn components (shadcn's own model)
  src/styles.css      # optional: @theme, @layer, custom utilities (Tailwind 4)
  public/             # images, fonts, JSON fixtures, imported by path (inlined at build)
  db/                 # SQL migrations (a later strut; keep it empty for now)
```

`app/init { path: "apps/<name>" }` scaffolds this (a shadcn sidebar with
react-router, two pages, `app.yaml` with empty grants). Write the files
with the editor (`str_replace_based_edit_tool`), then `app/build { path }`
— it returns `{ ok, errors, warnings }`: fix every error and build again —
then `app/publish { name, path }`: a new app is v1, the same name again is
the next version, which people open — unless a person has HELD the app at a
release. Then the new version is a DRAFT: the result says `live: false` and
which version is live, and a person makes it live, never you. `app/get { name }` shows a published app's
manifest, files, build and its latest CLIENT ERRORS (`errors`: what the
page's error boundary reported) — read them after a change the person says
broke. `app/checkout { name, path }` copies a version out to edit it.

## The manifest

```yaml
title: Benchmark
description: Runs of score-wf over time.
icon: bar-chart-3
grants:
  workflows: [score-wf]        # the app's ROUTINES: run/* on these — list, read, launch, cancel
  steps: [graph/graph-get]     # cheap, deterministic steps it may call — never llm / agent / exec
  sqlite: false                # its own tables (a later strut)
  automations: []              # schedules (a later strut)
data:
  graph:
    types: {}                  # node types it declares and may WRITE (a later strut registers them)
```

The grants are the app's whole reach, checked by strut on every call in
every host: `run/*` only on `grants.workflows`, any other step only when
`grants.steps` names it (globs as `agentTools` takes them). What a
model-written manifest may NEVER grant: `llm`, `agent`, `exec` (a paid or
shell-shaped step — put it in a workflow and grant the workflow), a sealed
step or workflow. Granting a workflow that does not exist is a build
error; a graph WRITE is refused on a type the manifest does not declare,
so an app can never rewrite a Concept.

## The kit: what an app imports

Every import resolves against the kit — never `node_modules`, never a URL:
React 19, Tailwind 4, shadcn/ui at `@/components/ui/<name>` and `cn` at
`@/lib/utils`, `lucide-react`, `recharts`, `d3`, `@xyflow/react`, `motion`
(`framer-motion` aliased), `react-router` (a memory router), `zustand`,
`@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-virtual`,
`@dnd-kit/*`, `date-fns`, `lodash`, `zod`, `react-hook-form`, `papaparse`,
`mathjs`, `simple-statistics`, `fuse.js`, `react-markdown` + `remark-gfm`,
`sonner`, `cmdk`, `three` + `@react-three/fiber`, `leaflet` + `react-leaflet`
(tiles from a domain in `csp.resourceDomains`). An import outside this set is
a build error naming the set — ask for a workflow instead. A `.css` import of
a kit stylesheet (`@xyflow/react/dist/style.css`, `leaflet/dist/leaflet.css`)
is appended raw. Each app keeps only what it uses: three icons are three
icons, not the library — import what you draw.

**Installed kits** (`app/list` shows them): another app's `src/` imports by
name — `import { X } from "acme/ui"` resolves to the installed app
`acme/ui`'s `src/index.ts`, `"acme/ui@v3"` pins a version — and is compiled
into this app's bundle, running under THIS app's grants.

**`strut/views`** is strut's own: its components for a run, its log, a
transcript, a workflow's input, a graph node — import them rather than
drawing a run by hand:

```tsx
import { LaunchForm, RunList, RunTimeline, RunGraph } from "strut/views";
<LaunchForm workflow="score" />            // the input: block, deduped launch, last run
<RunList workflow="score" onSelect={(r) => setRunId(r.runId)} />
<RunTimeline workflow="score" runId={runId} />   // status, cost, a row per step
<RunGraph workflow="score" runId={runId} live />  // the graph calls, replayable
```

Also `RunStatus`, `Transcript` (an agent step's session through
`run/transcript` — `workflow`, `runId`, `path` — or `messages` you pass),
`ArtifactView` (a run's file through `run/files`), `NodeCard`, `NodeSearch`, `NodeGraph`. They run on
YOUR grants: the run views need the workflow (and a child run's) in
`grants.workflows`; the graph views need `graph/graph-get-batched`,
`graph/graph-neighbors` (and `graph/graph-search` for `NodeSearch`) in
`grants.steps`. Its own page is a gallery of all of them. The pure folds
under them — `foldRunOverview`, `transcriptToEntries`, `projectWithLaunches`
— come from `@strut/kit`, for a run drawn your own way.

**The hooks** come from `@strut/kit`, each naming a `run/*` step, over one
tool (`step_run`) the host relays to strut:

| Hook | What it does |
| --- | --- |
| `useRuns(workflow, { status?, automation?, job?, limit?, since?, live? })` | `run/list`: the runs, newest first; `live` refetches while any is in flight; `useRuns(null, { job })` a job's runs across workflows |
| `useRun(workflow, runId, { live? })` | `run/get`: the summary, its whole `input` and `output`, `artifacts` as links; `live` long-polls (`wait`) while in flight |
| `useRunEvents(workflow, runId, { live? })` | `run/events`: the log, transcripts as links |
| `useTranscript(workflow, runId, path, { full? })` | `run/transcript`: the agent session a `step.end`'s `transcript` link names (the page cannot follow the link); `full` a session turn's whole thread; `truncated` says what a 2 MB cap cut |
| `useLaunch(workflow)` → `{ launch(input, params?, key?), pending }` | `run/launch`: a MUTATION — a function to call on a click, never a query |
| `useCancel()` → `{ cancel(workflow, runId) }` | `run/cancel` |
| `useWorkflow(workflow)` | `run/workflow`: description, the `input:` block, params defaults — what a launch form renders |
| `useStep(type)` → `{ run(config, input) }` | any granted step, as a function |
| `useToolInput()` | what the model or a deep link opened the app with |
| `useApp()` | which app the page is: `{ name, version }`, or a job's app `{ job, path }` |
| `useHost()` → `{ theme, sendMessage(text), openLink(url) }` | the host: `sendMessage` reaches the builder chat ("change this app"), `openLink` opens a strut link in place |

A step's output comes back whole; a refused call or a failed step throws a
`StrutError` with the reason. `useStrutClient().run(type, config, input)`
is the call under every hook.

## Routines: where the model runs

A paid or shell-shaped step is never called from the page — the grant is
refused — so anything slow, paid or shell-shaped is a WORKFLOW, launched on
a click and never on a render:

- `useLaunch(workflow)` with a `key` (`launch(input, undefined, "score")`):
  a double click, a re-mounted component, a retried request all land on
  the ONE run in flight under that key (`{ runId, existing: true }`).
- then `useRun(workflow, runId, { live: true })` to follow it, and
  `useRuns(workflow, { live: true })` for the list.
- A chat box inside an app is a workflow with an `agent` step on
  `session: "{{ input.session }}"`, one run per turn.

Reads (`useRuns`, `useRun`, `useRunEvents`, `useTranscript`, `useWorkflow`) are free and may
refetch on their own. A tool call (`useStep` on a cheap step) is fine on a
render. A launch is a click. Nothing in the kit launches on mount or on a
poll, and `step_run` refuses `llm`, `agent` and `exec` whatever the manifest
says — the workflow is the unit of spend, logged, billed to the viewer,
cancelable, verified.

## Where data lives

| Data | Where | Why |
| --- | --- | --- |
| What workflows did, one row per execution: scores, polls, extractions | Runs | Already there: `useRuns` and outputs |
| Entities and relations others should see too: customers, facts, people | The graph (`graph/*`, declared types) | Agents find them, workflows write them, another app reads them |
| The app's own tables: line items, a big import, settings | The app's SQLite (`sqlite/*`) | A later strut; until then keep state in runs or the graph |

"If an agent should ever find it, it goes in the graph." Migrations (when
they come) are additive: a rollback never rolls the schema back.

## Loading related data: one call, not a loop

When a view needs a lot of RELATED data at once — a run graph with its
nodes, the edges between them and each node's ancestors — do the whole
analysis server-side in ONE purpose-built step or workflow (a single Cypher
query that returns everything, for example), grant it, and call it once.
Never assemble it in the page: a `graph/graph-neighbors` call per node,
`graph/graph-get-batched` in a loop, a lineage walked hop by hop. Every
call is a browser round trip through the host, and a few hundred of them
make the page slow. A cheap read is a step (`useStep`, fine on a render);
an analysis too slow for that is a workflow, launched on a click and
followed with `useRun`. The worked example is `openhealth/run-graph`: one
call runs three queries and returns the nodes, edges and ancestors that
used to take up to ~240 browser round trips. The `strut/views` graph
components read node by node, so they suit a small graph; a big one needs
a step like this.

## What the build refuses

An import outside the kit and the installed apps; a relative import that
leaves the directory; `http(s):` imports; `dangerouslySetInnerHTML`,
`eval`, `new Function`. A call to the global `fetch`, `XMLHttpRequest` or a
`WebSocket` is a warning: the page's CSP is `connect-src 'none'`, so it
fails at runtime — call a granted step with `useStep`, launch a workflow
with `useLaunch`. The document's size over 6 MB is a warning.

## Four shapes

- **Benchmark hill-climb**: `useRuns` over the scoring workflow, a
  `recharts` line of `output.score` over time, `useLaunch` behind a
  button, `useRun({ live })` on the newest run, a tab for its output.
- **Invoice tracker**: customers, visits and invoices as declared graph
  types written with `graph/*`, a table from `@tanstack/react-table`, a
  photo-reading workflow launched per invoice (a later strut adds SQLite
  for line items and schedules for reminders).
- **Fact library**: a URL goes to an ingest workflow whose agent writes
  `Fact` and `Source` nodes; the app searches them with
  `graph/graph-search` and shows a card per fact.
- **Virality tracker**: a polling workflow's runs are the series
  (`useRuns({ automation })`), a chart of each poll's output, and "why did
  this take off?" a one-step workflow around `llm`, launched by a button and
  never by the chart.

Describe the app's pages in `text` when you publish, and where your reply
carries `artifacts` (a job's), hand the app over by NAME and with the
VERSION `app/publish` returned — `{ id, kind: "app", title, app: "<name>",
version: "v4" }`, so a draft opens as the draft — so the person opens
it where they are: under Apps in strut's UI, where "Edit with the builder"
brings a request back here, and a message typed inside the app ("add a
column") arrives in this chat naming the app; or in a host's own frame.
An app lives in the workspace: never hand over an app directory as a
file.

When the person asks for the app as a TAB of the workspace — "pin it", "put
it in the sidebar" — `app/pin { name }`: a host that lists this
workspace's apps (a portal's sidebar) shows it as a tab of its own, at its
live version, until `app/pin { name, pinned: false }`. Pinning also HOLDS
the app at the version it shows: from then on what you publish is a draft
until a person makes it live — say so when you pin. Never pin on your own.
