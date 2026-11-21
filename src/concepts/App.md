---
description: An APP — a front-end project over this workspace's workflows, built against a fixed kit and rendered by any MCP Apps host; how to lay one out, what it may call, live channels between its viewers (a multiplayer game), renaming one (its title), pinning one as a tab of the workspace, and the rules that keep it cheap and safe.
parent: Workflow Builder
---
An APP is interactive software the builder writes on top of this
workspace's own workflows (plans/apps.md): a directory of TSX, CSS and an `app.yaml`,
built against a FIXED kit into one self-contained HTML document, published
as a versioned object in the workspace and rendered in a sandboxed frame by
the strut server's own UI, by a portal, by Claude — any MCP Apps host. Its backend is the
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
  public/             # images, fonts, models, sounds, JSON fixtures, imported by path (inlined at build)
  db/                 # SQL migrations (a later release; keep it empty for now)
```

`app/init { path: "apps/<name>" }` scaffolds this (a shadcn sidebar with
react-router, two pages, `app.yaml` with empty grants), in a folder of its
own: everything in the app's folder is part of each version, so the job's
directory itself is refused. Write the files with the editor
(`str_replace_based_edit_tool`), then `app/build { path }` — it returns
`{ ok, errors, warnings }`: fix every error and build again — then look at
it (below), then `app/publish { name, path }`: a new app is v1, the same name again is
the next version, which people open — unless a person has HELD the app at a
release. Then the new version is a DRAFT: the result says `live: false` and
which version is live, and a person makes it live, never you. `app/get { name }` shows a published app's
manifest, files, build and its latest CLIENT ERRORS (`errors`: what the
page's error boundary reported) — read them after a change the person says
broke. `app/checkout { name, path }` copies a version out to edit it.

**The name is permanent; the title is what people see.** The `name` you
publish under is the app itself: its versions, links, grants, releases and
tab all hang on it, and nothing renames it. What a person calls the app's
name is its `title` in `app.yaml`. Asked to rename an app, check it out,
change `title` (and `description`, if it says the old name) and publish
under the SAME name. Publishing under another name makes a second app
beside the first, never a rename.

**Look before you publish.** A build that passes can still draw nothing,
show an error, or call a step its grants refuse. `app/look { name, path }`
builds the DIRECTORY and opens it in the strut server's own host as you, without
publishing anything, waits for the page to draw and its first calls to
answer, and returns the screenshot (you see it), the page's text, and what
went wrong: `rendered: false` (it drew nothing), `hostError` (the host
could not show it), `errors` (console, page and request errors) and
`appErrors` (what its error boundary reported). Fix what it shows and look
again, from the directory; `app/publish` once the look shows what was asked
for. Every publish is a version people can open, or a draft waiting on a
person, so publish what is finished, not each attempt. `app/look { name,
version }` looks at a published version instead — a held app's draft by
its version. `viewport` looks at another size, a phone's `{ width: 390,
height: 844 }`; `wait` gives a slow page longer. A look runs the page as a
person opening it would: its reads and writes are real calls.

A look opens on the app's first page. To see another, open it the way a
person's link does: `input` is what the link carries (`{ view: "/runs" }`
in the starter template, or your own keys, such as `{ run: "12" }`; see
"Deep links"). `steps` then does what a person would, in order:
`{ do: "click", selector: "text=Agents" }`, `{ do: "fill", selector:
"input[placeholder=Filter]", value: "draft" }`, `{ do: "wait", text:
"3 agents" }` (click, fill, type, press, keydown, keyup, select, hover,
scroll, wait, debug). A step that fails comes back as `stopped`, with the
shot of where the page got to. A view no link reaches is one a person
cannot share either: give it a key in the link.

Keys go to the app: a key step puts focus in the app's frame first, so a
page listening on `window` hears them. `press` taps a key. To HOLD one,
as a game is played: `{ do: "keydown", key: "ArrowRight" }`, `{ do:
"wait", ms: 500 }`, `{ do: "keyup", key: "ArrowRight" }` — one key a
step (a second keydown holds a second key: run and jump), one keydown
event and no auto-repeat, so read the keys held each frame rather than
moving once per keydown event. A key still held when the list ends, or
when a step fails, is let go of.

**What the text cannot say, put on `window.__debug`.** A canvas, a game,
a chart draws pixels, and a look reads only text and a picture. So a page
whose state is not in its text sets `window.__debug` to a JSON value, or
to a function returning one when the state lives in refs and changes
every frame — `window.__debug = () => ({ x: pos.current.x, score })` —
and the look returns it as `debug`, read just after the shot. `{ do:
"debug" }` reads it at that point of the list, into `debugReads` (`{
step, value }`, step = its number in the list), so a debug step before
and after a held key shows what the key did. Keep it small and current:
a read is cut at 8,000 chars of JSON and given 2 s, and one that throws
comes back as an error, never a failed look. It is every app's
convention, not a game's: whatever a look should check and cannot read
off the page goes there.

## An app in a repo

A package opened here as a git repository (Packages → Repos) is worked on
in place: its installed items — `acme/moonlander/game`,
`acme/moonlander/score` — are the ones you edit, and a person's Commit
pushes the edits to the repo. To ADD a workflow, step or app to it, name
it under the package: `acme/moonlander/ghost`, never `ghost`. Inside a
package a bare name means the package's own item first, so a new bare
name is outside the package, and no commit carries it. The package's
items still call each other by their bare names.

## The manifest

```yaml
title: Benchmark
description: Runs of score-wf over time.
icon: bar-chart-3
screenshots:                   # what the package store shows (below), in order
  - { file: public/runs.png, caption: Every run of score-wf, newest first }
grants:
  workflows: [score-wf]        # the app's ROUTINES: run/* on these — list, read, launch, cancel
  steps: [graph/graph-get]     # cheap, deterministic steps it may call — never llm / agent / exec
  sqlite: false                # true: its own tables, sqlite/* (below: The app's tables)
  automations: []              # schedules (a later release)
data:
  graph:
    types: {}                  # node types it declares and may WRITE (below: Graph types)
permissions: []                # motion, camera, geolocation: beyond every app's (below)
account: { corner: top-right, style: pill }   # where strut's account widget sits on a public page (below); optional
```

The grants are the app's whole reach, checked by the strut server on every call in
every host: `run/*` only on `grants.workflows`, any other step only when
`grants.steps` names it (globs as `agentTools` takes them). What a
model-written manifest may NEVER grant: `llm`, `agent`, `exec` (a paid or
shell-shaped step — put it in a workflow and grant the workflow), a sealed
step or workflow (but see "The assistant" below). Granting a workflow
that does not exist is a build
error; a graph WRITE is refused on a type the manifest does not declare,
so an app can never rewrite a Concept.

Every app may use what a game needs: `element.requestFullscreen()` (and
`screen.orientation.lock()` on a phone, which needs fullscreen),
`element.requestPointerLock()` for mouse-look, the gamepad
(`navigator.getGamepads()`), and `navigator.wakeLock.request("screen")` to
keep the screen on — as well as the microphone and writing to the clipboard.
Fullscreen and pointer lock need a click or a tap first, like on any page:
call them from its handler.

`permissions` names what the page may use beyond that. The host grants only
the names listed, on that version's frame; without the name the browser
refuses the call (the promise rejects, or the event never fires):

| name | lets the page |
|---|---|
| `motion` | `devicemotion` / `deviceorientation` — tilt controls (no compass heading). Motion can be read to guess what a person types, so ask only when the app is steered by tilting. On iPhone, call `DeviceMotionEvent.requestPermission()` from a tap first |
| `camera` | a photo from strut's own camera: `useCamera().capture()` (see "The camera"). The frame's own `getUserMedia` is refused by Chrome — an app's frame has an opaque origin — so take photos through the hook |
| `geolocation` | `navigator.geolocation` — the browser still asks the person |

`fullscreen`, `pointer-lock`, `gamepad`, `wake-lock`, `microphone` and
`clipboard-write` are accepted too, so a manifest that lists them still
builds, and change nothing: every app has them. Any other name is a build
error naming these. There is no `vibrate`: browsers block `navigator.vibrate`
in a frame like an app's, and no permission turns it on — show it instead.

`screenshots` are images of the app, for the package store: a package's
app card on Browse shows the first as a square, and its package page shows
them all, one large with the rest in a strip under it, each with its
caption. Each is a file in the app's directory (`.png`, `.jpg`, `.webp` or
`.gif`, at most 2 MB, at most 8), written as a path or `{ file, caption }`;
a path that is not a file there is a build error. The app never loads
them, and they are not in its document. An app with none shows its
initials. Make them with `app/look { name, path, saveAs:
"public/screenshots/home.png" }`: the look's shot is also written into
the directory there (with `input`, `steps` and `viewport` to show the page
that matters), and nothing is saved when the page drew nothing or the look
stopped. Then list the file under `screenshots:`. A person sets them
too, in the app's Versions panel (Screenshots: take one, upload, caption,
reorder), which saves a new version; check out the newest version before
you edit, so theirs are kept.

## The kit: what an app imports

Every import resolves against the kit — never `node_modules`, never a URL:
React 19, Tailwind 4, shadcn/ui at `@/components/ui/<name>` and `cn` at
`@/lib/utils`, `lucide-react`, `recharts`, `d3`, `@xyflow/react`, `motion`
(`framer-motion` aliased), `react-router` (a memory router), `zustand`,
`@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-virtual`,
`@dnd-kit/*`, `date-fns`, `lodash`, `zod`, `react-hook-form`, `papaparse`,
`mathjs`, `simple-statistics`, `fuse.js`, `react-markdown` + `remark-gfm`,
`sonner`, `cmdk`, `three` + `@react-three/fiber` + `@react-three/drei`,
three's addons by path (`three/addons/controls/OrbitControls.js`), Rapier
physics (`@react-three/rapier`, `@dimforge/rapier3d-compat`,
`@dimforge/rapier2d-compat`), `@react-three/postprocessing`,
`three-mesh-bvh`, `leaflet` + `react-leaflet` (tiles from a domain in
`csp.resourceDomains`). An import outside this set is a build error naming
the set — ask for a workflow instead. A `.css` import of a kit stylesheet
(`@xyflow/react/dist/style.css`, `leaflet/dist/leaflet.css`) is appended
raw. Each app keeps only what it uses: three icons are three icons, not the
library — import what you draw. A GAME — a canvas, 2D or 3D — has a page of
its own under this one, `Game`, and a starter: `app/init { path, template:
"game" }`.

**Files are imports.** An image, font, sound, video, 3D model or texture in
the app's folder is imported by path and becomes a data URL inlined in the
document — `import logo from "../public/logo.svg"`, `<img src={logo}>`,
`useGLTF(ship)`; `.md`, `.txt`, `.csv` and `.html` import as their text,
`.json` as its value. The page may `fetch` such a data URL, or a blob: URL
it made, and nothing else: nothing is served beside the document.

**The look is the server's.** A person sets a brand on the server (a color,
a corner radius, a font) and the host hands it to every page, so draw the
app's own look with the theme's tokens — `bg-primary`,
`text-primary-foreground`, `ring`, `bg-muted`, `text-muted-foreground`,
`border`, `rounded-md` — which follow it. A fixed color (`bg-blue-500`) never
changes: keep those for what a color means, such as a status.

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
<RunTimeline workflow="score" runId={runId} />   // status, cost, a row per step (`tree split`: every level, each iteration)
<RunGraph workflow="score" runId={runId} live />  // the graph calls, replayable; a run screen's master view (below)
<AgentTrace workflow="score" runId={runId} live /> // the run's agents as a cascade
<WalkView workflow="score" runId={runId} live />   // a walk through the graph, hop by hop (`replay`: from its start)
```

`RunGraph` can be a run screen's one master view, with lenses beside it: a
lens passes `highlight` (the ref_ids it is about: the rest dims where it
is, nothing moves), and its panel answers a click through `onSelectNode`
and selects a node itself through `selected`; `details={false}` leaves the
node's page to that panel, and `calls={false}` starts the call list closed
behind a toggle, so the graph has the room. It opens zoomed so a stage's
lane is 62% of its height, at the run's start; the view fits what a lens
highlights; a button goes back to the whole run. A run that touched
thousands of nodes draws a few dozen a stage, the rest folded into "+N"
nodes a click opens, and a loop of many iterations as one box marked "×N"
that a click lays out side by side. Play pans across the lanes at one
steady speed, each call's nodes appearing just ahead of the view
(`play="timed"` keeps the run's own pace instead); a scrub or a step pans
to the call's lane; a drag stops the following, play or a step resumes it.
One button cycles the calls shown: all, the reads, the writes.

Other views can follow the graph's replay: `onReplay` hands on the
current call's time (epoch ms; null on the whole run) — give it to
`AgentTrace`'s `cursor` to light the rows the replay is on — and `clock`
(one per screen, `useMemo(createReplayClock, [])`) carries it frame by
frame while the graph plays, which `AgentTrace`'s `clock` takes to scroll
to each agent a little before the replay reaches it:

```tsx
const [at, setAt] = useState<number | null>(null);
const clock = useMemo(createReplayClock, []);
<RunGraph workflow="score" runId={runId} onReplay={setAt} clock={clock} />
<AgentTrace workflow="score" runId={runId} cursor={at} clock={clock} />
```

`WorkProducts` is what a run MADE for a person — memos, sheets, redlines,
timelines — as a shelf that fills while the run goes: every `artifacts`
entry a step declared in its output (a tool's included), the run's own
output winning by id. Each card says which step made it and how many
Concepts it draws on (`from`); a click opens it in the viewer its kind
reads in — a sheet or a table in SheetView, filling in while the run
writes it (a Google sheet needs `sheets/get-values` in `grants.steps`) —
and `renderers={{ <kind>: … }}` plugs your own in per kind. Show a
run's work this way rather than listing its files. The products' shape —
the kinds `sheet`, `table`, `timeline`, `docx`, `redline`, a `render` file a
page draws, `from` and `content.sources` for provenance — is
plans/work-products.md.

`AgentTrace` draws every agent the run started as a nested cascade: the
agents that ran together side by side, their tool calls in pills that open
into each call and the reasoning before it, the nodes a call read or wrote
(a click opens one, with `graph/graph-get-batched` granted), sub-agents on
lanes of their own, and a "Download HTML" of what is on screen. Nodes
other than Concepts, two or more in a row, fold into one row a click opens
("collapse all" folds them again). Use it rather than folding a run's
events into agents yourself.

`SheetView` draws a spreadsheet work product in the page and fills it in
as a workflow writes it: a Google Sheet (`spreadsheet`, its id or URL, and
`range`; grant `sheets/get-values`), a CSV, TSV or JSON table a run wrote
(`path`, through `run/files`), or `rows` you hold. Give it the run that
writes it (`workflow`, `runId`) and it reads again while that run is in
flight, lighting what each read changed; `refresh` reads again on demand.
`sources` maps a cell (`C4`) or a row's key (its first column's text) to
the graph ref_ids it came from, and a corner mark on the cell opens them. A
page may not frame Google Sheets: draw the sheet with SheetView, whose
"Open in Google Sheets" asks the host to open it.

```tsx
<SheetView spreadsheet={sheetId} range="Matrix!A1:H40" workflow="nda-review" runId={runId}
  sources={{ "Non-solicit": [conceptRef], C4: [passageRef] }} />
```

`SpotCheck` answers "where did the run get this?" for one thing it made —
a sheet cell, a passage of a document, a graph node — off the run's own log
(`run/provenance`, on the run's workflow: nothing to grant past
`grants.workflows`): where the run first saw it, each time an agent wrote
it (its words before the write, the calls just before), each time it was
read back. A formula's cells, the numbers typed into it and the figures a
passage states are spot checks of their own, a click away. `SheetView` and
`DocumentView` take `onSpotCheck`: a selected cell gets a Spot check button
in the formula bar, selected text one under the selection; hand the subject
they give to SpotCheck. A node: `{ node: refId }`.

```tsx
const [subject, setSubject] = useState<ProvenanceSubject | null>(null);
<SheetView spreadsheet={sheetId} range="FACTS" workflow={wf} runId={runId} onSpotCheck={setSubject} />
{subject && <SpotCheck workflow={wf} runId={runId} subject={subject} onOpenStep={(path) => showInGraph(path)} />}
```

`WalkView` draws a walk through the graph as it plays out — a `graph/walk`
step's hops, or an agent reading a Concept tree with its own graph calls,
drawn the same way: the path as a trail (Law › Corporate / M&A › NDA › …),
each hop's other candidates behind "+N considered", the newest hop
pulsing. Live and replay are one view with RunGraph's controls above the
walk (a hop back, play/pause, a hop on, scrub, speed): joined in flight it
shows the hops so far and follows, Live returns to the newest; a finished
walk replays from the run's log at the pace it ran — `replay` opens it
playing from the start. Scrubbing never changes its height. A click on a
node opens it in a drawer over the walk; pass `onOpenNode` to open it your
own way instead. It sizes by its container, so it works in a half-width
panel: put it at the centre of a page that shows a person the harness at
work; `path` picks the walk when a run took several.

Also `RunStatus`, `Transcript` (an agent step's session through
`run/transcript` — `workflow`, `runId`, `path` — or `messages` you pass),
`ArtifactView` (a run's file through `run/files`), `DocumentView` (an HTML
page, markdown or text from `run/files`, with `terms` highlighted; HTML drawn
from its safe elements, never as HTML — `SafeHtml` for HTML you hold),
`RunHealth` (what failed, was retried, skipped or cut off, and the log's
numbers), `NodeCard`, `NodeSearch`, `NodeGraph`. They run on
YOUR grants: the run views need the workflow (and a child run's) in
`grants.workflows`; the graph views need `graph/graph-get-batched`,
`graph/graph-edges` (`RunGraph`'s edges and lineage, a call per thousand
nodes — without it, it reads them a node at a time, slowly),
`graph/graph-neighbors` (and `graph/graph-search` for `NodeSearch`) in
`grants.steps`. Its own page is a gallery of all of them. The pure folds
under them — `foldRunOverview`, `foldRunHealth`, `foldAgentTrace`,
`foldWorkProducts`, `findWalks` + `foldWalkTrail`, `transcriptToEntries`,
`projectWithLaunches`, `sanitizeHtml` — come from
`@strut/kit`, for a run drawn your own way.

**The hooks** come from `@strut/kit`, each naming a `run/*` step, over one
tool (`step_run`) the host relays to the strut server:

| Hook | What it does |
| --- | --- |
| `useRuns(workflow, { status?, automation?, job?, limit?, since?, live? })` | `run/list`: the runs, newest first; `live` refetches while any is in flight; `useRuns(null, { job })` a job's runs across workflows |
| `useRun(workflow, runId, { live? })` | `run/get`: the summary, its whole `input` and `output`, `artifacts` as links; `live` long-polls (`wait`) while in flight |
| `useRunEvents(workflow, runId, { live?, intervalMs? })` | `run/events`: the log, transcripts as links; `live` reads only what was appended, every `intervalMs` (2 s; pass 10 000 for a long run) until the run ends |
| `useWorkProducts(workflow, runId, { live?, intervalMs? })` → `{ products, events }` | the run's work products folded from `run/events`, appearing as steps declare them; what `WorkProducts` draws |
| `useTranscripts(workflow, runId, paths)` | `run/transcript` for several agents, one call at a time, each kept: a Map by path. Ask only for agents that ended |
| `useTranscript(workflow, runId, path, { full? })` | `run/transcript`: the agent session a `step.end`'s `transcript` link names (the page cannot follow the link); `full` a session turn's whole thread; `truncated` says what a 2 MB cap cut |
| `useRunFile(workflow, runId, path)`, `useRunFileUrl(workflow, runId, path)` → `{ url, file, pending, error }` | `run/files`: one file a run made (its job's folder when it ran under a job), as text or base64 — or, with `useRunFileUrl`, as a `blob:` URL for `<img>`, `<video>`, a model loader (`useGLTF(url)`) or `fetch(url)`, let go of when the component goes. One call's answer is capped at 5 MB of text: a binary file up to about 3.7 MB. `runFileBlob(file)` is the same outside a component |
| `useLaunch(workflow, { job? })` → `{ launch(input, params?, key?, files?), pending }` | `run/launch`: a MUTATION — a function to call on a click, never a query; `job` launches under one of the app's jobs, `files` go with the run |
| `useUpload(job)` → `{ upload(file), remove(path) }` | `job/upload` / `job/delete-upload`: a file into the app's job, its `path` back (see "Files a person brings") |
| `useCancel()` → `{ cancel(workflow, runId) }` | `run/cancel` |
| `useWorkflow(workflow)` | `run/workflow`: description, the `input:` block, params defaults — what a launch form renders |
| `useStep(type)` → `{ run(config, input) }` | any granted step, as a function |
| `useAppState(key, initial)` → `[value, set, { loaded }]` | what THIS viewer's page remembers across visits, like `useState`: a tab, a filter, a draft (`app/state`, always granted) |
| `useToolInput()` | what the model or a deep link opened the app with; a link's values are strings |
| `useAppLink()` → `link(input?)`, `appLink(name, input?)` | a deep link to this app (or another) opened with `input`: `openLink(link({ view: "/runs", run: id }))` shows it, and the host's address bar follows, so the person can share it |
| `useShareLink()` → `link(input?)` or undefined | the address a person can PASTE to open this app at `input` (the host's own page, e.g. `https://box/?input=…`) — for a Copy link button; undefined where the host has no address to give, so offer no Copy link there |
| `useApp()` | which app the page is: `{ name, version }`, or a job's app `{ job, path }` |
| `useHost()` → `{ theme, public, runnable, results, sendMessage(text), openLink(url) }` | the host: `sendMessage` reaches the builder chat ("change this app"), `openLink` opens a link to the strut server's UI in place; `public` is true when a visitor opened the page in the server's public view, `runnable` the workflows a visitor may start there and `results` what it reads of its own runs (see "The public view") |
| `useAssistant({ thread? })` → `{ messages, send(text, files?), pending, jobs }` | a chat with the person's ASSISTANT (`orchestrator`), as the viewer — see "The assistant" |
| `useAccountWidget()` → `{ available, setPlacement({ corner?, collapsed? }) }` | on a public page, strut's own account widget (see "Signed-in visitors"): move it to another corner or collapse / expand it — e.g. a game collapses it during play and expands it in menus. It can never be hidden |
| `useCamera()` → `{ available, capture({ facing?, maxSide?, title?, review? }) }` | a photo the person takes in strut's camera sheet, as a JPEG `File` (null when they cancel); needs `camera` in `permissions:` — see "The camera" |
| `useVisitor()` → `{ available, actor, signIn(), signOut() }` | on a public page, who is playing: a visitor may SIGN IN, and then the page's calls are theirs — their own `useAppState`, channels, rows (see "Signed-in visitors"). `signIn({ silent: true })` as the page loads signs in only when nobody has to say yes (in Peel, a page Peel already lets sign them in), drawing nothing; keep a Sign in button for the rest |

**Deep links.** The page is opened with whatever its link carries
(`?app=<name>&input=…`), as `useToolInput()`. The starter template's router
goes to `view`; add keys of your own for anything else a view needs (a run
id, a filter) and read them there. A view a person would want to send
someone opens through `useAppLink()` + `openLink` rather than the router
alone. A link only opens a view: never launch a run from its input.

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
  `session: "{{ input.session }}"`, one run per turn — or, when the chat
  should do what the person's assistant does (start jobs, follow them),
  the assistant itself (below).

## The public view

A person may put an app in the server's PUBLIC VIEW (the Public view
dialog, or an admin's yes to your `app/make-public`): anyone can then open
it with no account, and the store can frame it. There `useHost().public` is true, and the server refuses whatever the
page tries beyond reading — cancelling a run, saving state (`useAppState`
lasts the visit, until the visitor signs in: see "Signed-in visitors"),
uploads, writes — and beyond starting what a person made
RUNNABLE: `useHost().runnable` lists the workflows the app grants that a
visitor may start. A free one starts at once; a priced one is paid by the
visitor to the HOST, which shows the invoice over the page and only then
returns the launch — the page sees a launch that took a moment longer and
never handles money. So when `public` is true, keep the page as it is and
DISABLE the controls that would only fail — a Run button or launch form
for a workflow NOT in `runnable`, a cancel, an upload, an edit — with one
line beside them saying runs are started by the people who keep this
server. Never hide them: a visitor should see what the app does.
strut/views' `LaunchForm` already does this, and stays enabled for a
runnable workflow.

A visitor reads the runs of a runnable workflow that IT started (the host
names the visit), and only as far as `useHost().results[workflow]` says:
`"output"` (the default) — `useRun` (status, input, output) and
`run/files` of the files the output declares; `useRunEvents`,
`useWorkProducts`, a run timeline or graph and transcripts are refused —
or `"run"`, everything. So on a public page, show a visitor's own run
through `useRun` and its declared files unless `results` is `"run"`.
Everything else works as it does for anyone: the runs of a workflow whose
runs are public, the graph, the reads the person allowed, a tab or filter
kept for the visit. Do it in every app, in the
view or not yet: a person adds an app later, and it should already be
right. An app in the public view is held at a release, so a publish is
a draft until a person moves it: say so when you hand one over.

## Signed-in visitors

A public page's visitor is anonymous until they SIGN IN: the server's
public view names how (a box serving one app says it in `serve.yaml`:
`signIn: [key, lnurl, nostr, sphinx]`), and `useVisitor().available` is
then true. `signIn()` asks the HOST, which draws the sheet over the page
and signs the server's challenge with a key the visitor holds — this
browser's own key (one tap), a Lightning wallet by QR code, a Nostr
extension, or in Peel the person's Sphinx account (`sphinx`: one visitor
on every app, the wallet's own sheet the sign-in). Call it from a press:
a wallet asks for one. The
page never sees a key; it gets the visitor's `actor` (`p256:…`, `secp:…`),
the same on every visit from the same key, or undefined when they closed
the sheet. `signOut()` forgets them.

Signed in, a visitor is that actor here, and the page may do a little
more than read:
- `useAppState` keeps THEIR state across visits — a best score, a level,
  settings. Anonymous, it lasts the visit. Signing in reads the visitor's
  saved state anew and drops what was set before and not kept, so to keep
  a score won before signing in, set it again after (a functional set reads
  the saved value: `setBest((b) => Math.max(b, score))`).
- `useChannel` works: rooms, presence, moves, stamped with their actor.
- Graph writes on the types the app declares (`data.graph`) — a
  leaderboard row — each kept with the actor, so the row says who; and
  `graph/find` on those types reads every visitor's rows. A visitor's edit
  or delete reaches ANY row of a declared type, not only their own: for a
  leaderboard grant `graph/create-node` alone, and put who wrote a row in
  the row itself when the page shows it.
- `useLaunch` starts a granted workflow that spends nothing (no `agent`,
  no `llm`) as the visitor, who then reads back their own runs of it. One
  that spends starts only if it is runnable (priced, or free under a daily
  cap) — as for anyone.
- Never another app, the assistant, jobs or anything of the server's.

A step of your own that a visitor's page calls runs on what a visitor's
call carries: `ctx.services.http`, `secrets`, the graph, `runs` and
`people` — no `shell`, no files, no app tables (`appDb`). Such a step works
for a member and fails for every visitor, each worker who signs in through
Peel included, and `app/build` warns naming it. So keep a list the page
shows in rows of a type the app declares (a worker's page: what the run
replied, see "Worker apps"), and put work on files, a shell or the app's
tables in a workflow the app grants and launches — not one launched on
every load: launches count against the visitor's daily budget.

Each visitor has a daily budget of writes and launches (the server's,
which `serve.yaml`'s `limits` changes), refused with a `visitor_limit:`
error past it: save on a change that matters (a level done, a new best),
never on every frame.

```tsx
import { useVisitor, useAppState } from "@strut/kit";
const { available, actor, signIn } = useVisitor();
const [best, setBest] = useAppState("best", 0);
// After a game: anonymous, offer to sign in to keep the score.
async function keep(score: number) {
  if (!actor && !(await signIn())) return;
  setBest((b) => Math.max(b, score));
}
{available && !actor && <Button onClick={() => void keep(score)}>Sign in to keep your score</Button>}
```

Write it so it works either way: an app is anonymous where the server
offers no sign-in (`available` false) — hide the sign-in button then, and
let the game play.

### The account widget

On a public page (a visitor's, never a member's), strut itself draws an
ACCOUNT WIDGET over the app, outside its frame: a small pill that opens a
panel with who is signed in (Sign in / Sign out, the same flow as
`useVisitor`), the credit held at this server, and — for a signed-in worker on
an app that grants `task/me` — what they earned: what is held and what can be
withdrawn (Withdraw, which also needs `task/withdraw`); a worker's panel shows
credit only when they hold some. Without those grants the worker
part is not drawn. The app draws none of this and sees nothing of it.

Say where it sits by default in `app.yaml`:

```yaml
account:
  corner: bottom-left   # top-left | top-right (default) | bottom-left | bottom-right
  style: handle         # pill (default) | handle: starts collapsed, a dot
```

Anything else under `account:` is a build error. At run time the page may move
or collapse it with `useAccountWidget()` (offered only where the host says so:
`available`); `setPlacement({ corner?, collapsed? })` rejects an unknown corner.
The host applies at most one change per 500 ms and holds the latest of the
ones inside it, so call it on a state change, not every frame. A collapsed
widget is a small dot that stays on screen and opens on a click: an app can
collapse the widget, never hide or remove it. Keep the corner you pick clear of
the app's own controls; strut does not move the app out of the way.

### The camera

An app's frame gets no camera of its own: it is a sandboxed document with an
opaque origin, and Chrome refuses `getUserMedia` there whatever the frame's
`allow`. So strut draws the camera, as it draws the payment and sign-in
sheets: list `camera` in `permissions:`, then on a click

```tsx
const camera = useCamera();
const photo = await camera.capture({ title: "Fit the whole page in the frame" }); // File | null
if (photo) await launch({}, undefined, undefined, [photo]);
```

The person sees a full-screen viewfinder that says which app asks, takes the
shot, and chooses Retake or Use photo; the page gets that one JPEG (its
longest side `maxSide`, 1600 px by default, at most 4096) and never the
stream. `facing: "user"` asks for the front camera. Cancel answers null.
`available` is false where the host draws no camera (no `camera` in
`permissions:`, or an app hosted from another server). To send the photo
with a run, see `useLaunch`'s `files`; on a public page the workflow's
runnable entry must take files (`attachments: true`).

The page has no viewfinder of its own, so never draw one: a round shutter
button on a dark screen only opens strut's camera, and the person taps it,
sees no photo taken, and taps again. Name the button for what it does
("Scan pages", "Take a photo").

For many photos in a row (the pages of a book), ask with `review: false`:
the shutter hands each photo over at once, one tap a photo, with no Retake
or Use photo. Ask again as soon as one comes back, with the next title
(`"Page 13"`), and check or send the last one in the background: a page
that waits for its server before it asks again makes the person wait too.

## Worker apps: people as a step of a workflow

A workflow asks a PERSON with a `human` step: it makes a TASK of a task
type and waits, out of memory, until a worker answers it. A WORKER APP is
the page they answer in. The task type — the app that draws it and the
answer's schema — is an admin's (the server's `/tasks` routes); a workflow
names a type, never its shape, and you ask an admin for a new one with
`task/set-type` (the `Workflow Builder` page). One app usually draws several types, a view
each.

Every server has a worker app already, `strut/worker`: it draws any task
whose answer is plain fields and photos (strut/views' `WorkerPage`). A type
that needs nothing more names it and no app is built. It is also every
worker's DASHBOARD, the one link staff share: it lists the task types of
every app in the public view, and a type your app draws opens your app on
it (`?input=type=<the type>`; `WorkerPage` goes straight to it, and a page
of your own reads `useToolInput().type`). Build your own only for a view it
cannot draw, and start from the same pieces:

```tsx
import { WorkerPage, WorkerTask, TaskPhotos, TaskForm } from "strut/views";
// The whole page — sign in, a dashboard of the work they can do, what they
// earned and what they did; then tasks of the kind they choose, one after another:
export default () => <WorkerPage title="Labels" intro="Photograph nutrition labels for sats." />;
// Or your own around one task: what it pays and asks, its photos, its fields.
const { task, submit, skip } = useTask("label-photo");
task && <WorkerTask task={task} submit={submit} skip={skip} />;
```

`TaskPhotos` alone is the photos an answer carries (Take a photo in the
host's camera, or Choose one from the device, held to the type's rule);
`TaskForm` alone is the answer's fields. Grant the worker's steps:

```yaml
grants:
  steps: [task/next, task/submit, task/skip, task/file, task/me, task/history, task/withdraw]
```

A worker app is for WORKERS alone: keep the person's reports out of it.
It goes in the public view, and every workflow it grants goes with it,
runs and all: anyone with the link reads each run in full, every worker's
answers and photos with them. So what the answers come to (a report, a
tally, the photos marked up) is never a tab of the worker app, and never
grant it the workflow whose runs hold them. Hiding a tab behind
`useHost().public` locks nothing: the grant is what opens the runs. The
person reads the answers in Workers (each task with its answer,
its photos and its run); a page of their own over the runs, when they ask
for one, is a separate app that is never made public.

The worker is always the page's signed-in viewer: the steps read it from
the session, never from the page. `useWorker()` is who they are here —
`status` (`new` until they take up an open type or an admin grants them
one; `active` takes tasks; `suspended`, `banned`), the `types` they hold
or may take up in this app (an open type needs no grant; each with
`payMsat`, what an answer earns, and `qualifying` — true while every task
of that type they get is a test they qualify on: say so on the page, since
those arrive at once and no score is shown; `standing`, work of it whenever
they ask; `waiting`, how many of its tasks wait that they could take), the
task in their hand (`holding`) and their `balance` — `{ heldMsat,
withdrawableMsat, totalMsat, nextReleaseAt? }`, in msat (1,000 to a sat):
what they earned here, an earning held for the type's hold before it can
be withdrawn. `useTask()`
holds one `task/next` on the server at a time (none while the page is
hidden) and hands back `task` — `{ lease, type, show, files, expires,
answer, payMsat, attachments? }`, `type` saying which view to draw, `show` what the
workflow put there, `payMsat` what this answer earns, fixed when the task
was taken — then `submit(answer)` (it must fit the type's `answer` schema)
and `skip()` let it go and the next is asked for; both read `useWorker()`
and `useTaskHistory()` again, so a balance on the page moves as the answer
goes in. `useTaskHistory()` (grant `task/history`) is what they did here,
newest first: each task's `ask`, how it ended, what it earned and when it
clears.
Pay is the task type's, an admin's: no step sets it. `useTask("pet-match")` asks
for one type alone. `useTaskFileUrl(task, path)` is one of `task.files`
as a `blob:` URL for an `<img>`; nothing off that list opens. A type whose
answer is plain fields (text, numbers, yes or no, a pick from a list) needs
no form of yours: `TaskForm` from `strut/views` draws it.

```tsx
import { useTask, useTaskFileUrl, useWorker } from "@strut/kit";
import { TaskForm } from "strut/views";
const me = useWorker();
const { task, submit, skip, status } = useTask();
const photo = useTaskFileUrl(task, task?.files[0]);
if (me.data && me.data.status !== "active") return <p>An admin has not given you tasks here yet.</p>;
if (!task) return <p>{status === "waiting" ? "Waiting for the next task…" : status}</p>;
return (
  <>
    {photo.url && <img src={photo.url} alt="" />}
    <TaskForm task={task} onSubmit={submit} onSkip={() => skip()} />
  </>
);
```

Some answers are a PHOTO — a court paper, a signed form. The task type says
so (its `attachments` rule, an admin's), and `task.attachments` hands it to
the page: `{ max, min, types }`, how many files an answer carries and of
what media types (`image/*` any image); absent, the type takes none. Draw a
button that takes a photo with `useCamera()` (the app's `permissions:`
list `camera`; see "The camera") and send the photos with the answer,
`submit(answer, files)`: at most `max`, at least `min`, 5 MB an image, 15
MB together — a refusal (`bad_answer: …`) keeps the task in hand, so the
worker can take it again. The server saves them in the run that asked, and
its next steps read them; never send a photo another way (a launch, app
state) and name it in the answer.

```tsx
import { useCamera, useTask } from "@strut/kit";
const { task, submit, skip } = useTask("court-paper");
const camera = useCamera();
const [photos, setPhotos] = useState<File[]>([]);
const take = async () => {
  const photo = await camera.capture({ title: "The first page" });
  if (photo) setPhotos((p) => [...p, photo]);
};
// …
<button onClick={take} disabled={!camera.available || photos.length >= (task?.attachments?.max ?? 0)}>Take a photo</button>
<TaskForm task={task} onSubmit={(answer) => submit(answer, photos).then(() => setPhotos([]))} onSkip={() => skip()} />
```

A worker app with a withdraw section also grants `task/withdraw`.
`useWorker().data.payout` says whether the viewer may withdraw now — `on`,
else `why` (`no_address`: they must sign in with Peel, which sends their
account's address; say "Withdraw in Peel") — with `minMsat`, `maxMsat` (the
most one withdrawal may ask now) and `out`, a payout on its way.
`useWithdraw()` gives `{ withdraw(msat), status, error }`: `msat` is what
the worker receives, and a fee of at most `maxFeeMsat` comes off their
balance (say so before they confirm). It goes to the worker's own Sphinx
account, which the server picks: the page sends an amount and never an
address. It reads `useWorker()` again when it answers, then every 5 s while
`out` is there.

A STANDING type (the worker starts the work: a photo of something they
found) always has a task for a worker who may take it: `useTask` hands one
over as soon as the page asks, and each answer starts the type's workflow.
Draw it as a call to act ("Snap a label"), never as a queue that may be
empty; a worker who leaves lets it go with nothing started.

A worker's page has no server of its own. Workers sign in through Peel as
visitors, so a step of yours the page calls gets no shell and no app
tables ("Signed-in visitors"): it works for the member who built it and
fails for every worker. What the page shows of a worker's own work comes
from the run's REPLY: each `useTaskHistory()` item they answered carries
the workflow's `reply`, its `show` (the book, the page, a flag) and its
`files`, opened with `useTaskFileUrl(item, file.path)` (a thumbnail). So
the workflow replies with what the page draws (`task/reply`, the
`Workflow Builder` page). What workers share (who took which book,
closing a book) stays in the workflow. When the page needs it, grant a
workflow that spends nothing and start it with `useLaunch` on a tap,
never on load: a step of yours in it reads the worker as `ctx.actor` and
the app as `ctx.app`, which the server sets; never trust an actor the
input names.

Workers are signed-in visitors of the public view (or the server's own
members). Once the app is published and draws its task types, ask for it
with `app/make-public` (the version `app/publish` answered): an ADMIN
approves a card that says what anyone will see and who can sign in, and
strut adds the app, held at that version (an app strut seeds, such as
strut/worker, is added unheld and follows strut's releases). A view that names no sign-in
offers `sphinx` with the root key, so a worker is one person on every
server. Anyone with the link sees a sign-in and nothing else; a worker's
calls are never kept as runs, and none counts against a visitor's daily
writes. Say in your reply that later publishes are drafts until someone
makes them live. The person shares a worker app from Workers
(`strut/staff`), whose first page opens with its links, a QR code and
Invite (a one-use link that sets up a new worker's phone): point them
there with an artifact, `{ kind: "app", app: "strut/staff" }` (your words
say "Workers"), and never paste a link from the result (or `GET
/public/apps`) in your reply, nor build one by hand.

A worker app is the WORKERS' page and nothing else. Never build an admin
app for work by people — costs, budgets, time per worker, settings,
grants: Workers has them, and a type's `limits` are its budget
and daily cap (`Worker Tasks`, "What is built in").

## The assistant

An app whose chat should be the person's ASSISTANT — the one that starts
jobs, builds and answers in their host's chat — grants the `orchestrator`
workflow and uses `useAssistant()`:

```yaml
grants:
  workflows: [orchestrator, job]   # job: to follow the jobs it starts
```

`orchestrator` is sealed: only a PERSON grants it to an app, once. Your
publish is refused until they have; then say in your reply that the app
needs the assistant granted (the assistant asks the person, who approves a
card), and publish again when the build is continued. Every version after
keeps the grant, and nobody who opens the app is asked anything.

`useAssistant({ thread })` sends a message per `send` (one run per turn)
and reads the turns back as `messages` (the viewer's text, the reply's
`text`, `artifacts` and `ask`, `pending` while it runs). The thread is the
viewer's own in this app — the strut server keeps it apart from their conversation in
their host and from every other viewer's — and remembers across visits by
its name. `jobs` are the jobs the latest turn started or continued
(`{ job, runId, workflow? }`): follow one with
`useRun(workflow ?? "job", runId, { live: true })`, its output's
`artifacts` the deliverables. The assistant cannot make changes that need
the person's approval (graph writes) from inside an app: it does those in
the person's own chat.

Reads (`useRuns`, `useRun`, `useRunEvents`, `useTranscript`, `useTranscripts`, `useRunFile`, `useWorkflow`) are free and may
refetch on their own. A tool call (`useStep` on a cheap step) is fine on a
render. A launch is a click. Nothing in the kit launches on mount or on a
poll, and `step_run` refuses `llm`, `agent` and `exec` whatever the manifest
says — the workflow is the unit of spend, logged, billed to the viewer,
cancelable, verified.

## Files a person brings

A page can open no connection, so a file reaches the strut server through the same
tool, as base64 (a third larger; at most 10 MB a file). Hand the browser's
`File` objects to a hook — a plain `<input type="file">` or a drop zone —
and never read them yourself.

- **For one run:** `launch(input, undefined, undefined, files)`. The files
  are the run's attachments, saved under its artifacts as
  `attachments/<name>` and put on each `agent` step's prompt. Upload, run
  once, done.
- **For many runs, or a conversation about them:** a JOB of the app's.
  `useUpload("library").upload(file)` saves the file at `uploads/<name>` in
  the job and returns its `path`. `library` is the app's own — the strut
  server keeps `app/<name>/library`, so a job per case, project or person is just
  another id. Launch with the same job, `useLaunch("ask", { job: "library" })`,
  and pass the `path` in `input`: the workflow finds the file at that path
  in the folder `job/dir` returns, and an agent on `session: "{{ $job }}"`
  remembers the conversation about it.
- A workflow that only READS the uploads takes `job/dir { hold: false }`,
  so several people asking at once all run. One that writes into the folder
  holds it, one run at a time (`job_busy:`).
- Grant `job/upload`, `job/delete-upload` and `job/get` (its `files` is
  what the job holds) in `grants.steps`.

## Payments: the viewer's wallet

An app can pay from the Lightning wallet of the PERSON viewing it — a tip,
a purchase, sats streamed while something plays — when its host has a
wallet to offer: Peel does, with the person's Sphinx sats. The app never
holds a key or sees a balance. It asks the host, which shows the person
what the app asked for and counts what it spends. Ask in `app.yaml`:

```yaml
wallet:
  request_methods: [pay_keysend, lookup_payment]     # what the app cannot work without
  optional_request_methods: [pay_invoice]            # what the person may leave out
  notification_types: [payment_sent, payment_failed]
  max_amount: 100000                                 # msat per period, fees included (100 sats)
  renewal_period: daily                              # never | daily | weekly | monthly | yearly
```

The methods: `pay_keysend`, `pay_invoice`, `make_invoice`, `lookup_payment`,
`lookup_invoice`, `get_budget`, and, where a wallet has them, `get_balance`,
`list_transactions` and `pay_lightning_address`. Peel has no
`pay_lightning_address`. Put a method only some wallets have in
`optional_request_methods`: a REQUIRED method the wallet lacks fails the
connect (`NOT_IMPLEMENTED`). Ask for what the app uses,
with a limit that fits it: the person sees both and may lower the limit.
Inside the limit the app pays without asking. Over it, the person approves
each payment.

```tsx
import { useWallet, useTransaction, satsToMsat, type Payment } from "@strut/kit";
const wallet = useWallet();
const [payment, setPayment] = useState<Payment>();
const tx = useTransaction(payment);                 // follows it: state, preimage, failureReason
if (!wallet.available) return <p>Tipping needs a wallet: open this app in Peel.</p>;
<Button onClick={async () => setPayment(await wallet.payKeysend({ pubkey: author, amount: satsToMsat(21) }))}>
  Tip 21 sats
</Button>
```

- **Amounts are msat**: sats × 1000 (`satsToMsat`, `msatToSats`).
- **Pay from a click.** The first call asks the person to connect, and a
  payment over the limit asks them to approve. The host opens those sheets
  only right after the person clicked or tapped in the page, so a pay from
  a timer or on mount is refused (`RESTRICTED`). `useWallet` connects by
  itself on the first call that needs it.
- **Pending is not failed.** A keysend to a Sphinx address
  (`<pubkey>_<lsp_pubkey>_<scid>`, given as `pubkey`) waits at the payee's
  LSP until they come online: minutes, or days. Show it as sent and on its
  way, and never offer to pay again. `useTransaction` moves it to
  `settled` or `failed` (a failed payment is refunded). A settled payment may
  come with no preimage; only a page that needs PROOF checks one
  (`verifyPreimage`).
- **A refusal is a `WalletError` with a `code`**:
  - `USER_REJECTED`: the person said no. Stop, and do not ask again on your
    own.
  - `QUOTA_EXCEEDED`: over the limit, and the person chose to refuse those.
  - `INSUFFICIENT_BALANCE`, `PAYMENT_FAILED`: as they say.
  - `NOT_IMPLEMENTED`: this wallet does not do that.

  Say each one in a line on the page.
- **Data with a keysend** goes in `tlv_records` (types 65536 and up, hex
  values). Peel sends only Sphinx's own record, 13377331, whose value is
  base64 text; leave it out unless the payee reads it.
- **`window.webln`** is there too, for a library that expects WebLN.
- **Where it works:** in a host that carries a wallet, which today is Peel.
  A public app's page works too: a visitor in Peel tips or buys from their
  own wallet, and the connection is kept per server whose app it is.
  On the iPhone the org's apps share one connection. Elsewhere — a browser,
  another host, the strut server's own UI — `available` is false: the app still loads, shows
  its prices, and says that paying needs Peel. Never hide the button or the
  price.
- **No money flows to the app's owner yet**: `make_invoice` makes an invoice
  that pays the VIEWER.

## Live between the people on an app: channels

What is happening NOW between the people with the app open — a move, a
cursor, who is here, a lobby filling up, a chat line — goes over a CHANNEL,
never the graph and never a poll. The page's host holds the socket; the page
uses one hook, with no grant:

```tsx
import { useChannel, newChannel, appLink } from "@strut/kit";
const lobby = useChannel("lobby");
lobby.members                                  // who has it open, as the strut server sees their sockets
lobby.send({ x, y }, { key: "cursor" });        // a STATE: replaces this page's last "cursor"
lobby.send({ text: "gg" });                    // an EVENT
lobby.states; lobby.events;                     // every sender's current states; the recent events
useChannel(game, { onMessage: (m) => draw(m) }) // per message, no re-render: a game loop
```

Every message carries the strut server's stamp of who sent it
(`from.actor`, `from.client` — `m.from.client === lobby.client` is this
page's own), never what the page wrote. A channel is lossy and unrecorded:
the last 256 messages, gone on a restart. What must last — a score, a
result, the board at the end — goes through a workflow or the graph. A
host that carries no channels (some MCP Apps hosts) gives
`available: false`: say so on the page rather than failing quietly.

- **A public room** is a fixed name (`lobby`). **A private game** is
  `newChannel()` — unguessable — and `appLink(app, { channel })` is the
  invite; read it back with `useToolInput()`.
- **The rules run in code no player controls.** A page can lie about a
  move; a REFEREE cannot: a custom step the app grants (`game/move`) that
  checks the move and sends the result with `channel/send` (`key: "board"`)
  is stamped as `game/move`, whoever called it, and no page can replace its
  states. A workflow the app launches sends as the workflow — the place to
  record the winner and announce it. An AI player is a workflow whose
  agent has `channel/*` among its tools.
- **Rooms the app authorizes itself.** Anyone who can open the app may join
  a channel whose name they know. To decide who gets in, grant a
  GATEKEEPER step: it checks its own rules (a roster in the graph, an
  invite) as the viewer (`ctx.actor`) and returns `channel/derive { scope:
  "<game>:<epoch>" }` — a name only the app's code can work out, stored
  nowhere. Move the epoch to shut someone out. Pages drop messages whose
  `from.actor` is not on the roster.
- A page never calls `channel/send`, `channel/read` or `channel/derive`
  itself — they are refused from a page; they are for the app's own steps
  and workflows.

## Where data lives

| Data | Where | Why |
| --- | --- | --- |
| What workflows did, one row per execution: scores, polls, extractions | Runs | Already there: `useRuns` and outputs |
| Entities and relations others should see too: customers, facts, people | The graph (`graph/*`, declared types) | Agents find them, workflows write them, another app reads them |
| The app's own tables: line items, a big import, settings | The app's SQLite (`useSql`, `sqlite/*`) | Real queries over many rows: filters, joins, sums, group by |
| Files a person uploads: photos, PDFs, a CSV to work from | A job of the app's (`useUpload`) | Every run under the job reads them; an agent's thread on it remembers them |
| What one viewer's page remembers: a tab, a filter, a draft | `useAppState` | Kept by the strut server per app and viewer, on every host and device; 256 KB a viewer |
| What is happening now between the people on it: moves, cursors, who is here | A channel (`useChannel`) | Live, stamped by the strut server, never kept |

A page has no browser storage: it is framed with an opaque origin, so
`localStorage` and `sessionStorage` last only the page's life (the kit
swaps in an in-memory one, so a library that persists does not break) and
IndexedDB and cookies are not there. Never write `localStorage` for
anything that should outlive the page: use `useAppState`.

"If an agent should ever find it, it goes in the graph."

## The app's tables

An app that keeps rows of its own has a SQLite database of its own: one
file, shared by every version of the app.

- **Grant it**: `grants: { sqlite: true }`.
- **Make the tables with migrations**: `db/001-init.sql`, `db/002-….sql`.
  The strut server applies them at publish, in name order, each ONCE, each
  in one transaction; a failing one fails the publish and nothing goes
  live. `app/build` tries them first on an empty database and names the
  one that fails. No `BEGIN` or `COMMIT` in a migration: it is one
  transaction already.
- **Migrations are additive.** One that ran never runs again, so editing it
  changes nothing: change the schema in a NEW file (`ALTER TABLE … ADD
  COLUMN`). Rolling the app back to an older version never rolls its
  schema back, so every version must work with the newest tables: add
  columns and tables, never drop or rename one a version still reads.
- **Read and write from the page**: `useSql(sql, params)` → `{ columns,
  rows, truncated }`, refetched after each write; `useSqlMutation()` →
  `exec(sql, params)`, and `batch([...])` for several statements in one
  transaction. One statement per call. Values go in `params` (`?` as a
  list, `:name` as an object), never spliced into the text; a blob is
  `{ base64 }`. At most 1000 rows unless you ask for more (`maxRows`, up to
  10000): page with `LIMIT … OFFSET`, or aggregate.
- **A workflow the app launches** reads and writes the same database with
  the `sqlite/*` steps, naming no app: it is the app's.
- **Members only.** A visitor's page (the public view, every worker) is
  refused `useSql`: a public or worker app keeps its rows in a type it
  declares (Graph types).
- Refused everywhere: `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`
  and a `PRAGMA` that sets anything.

## Graph types

```yaml
data:
  graph:
    types:
      Customer: { name: string, phone: string?, search: [name] }
      Invoice: { number: string, amount: number, due: date, status: string, meta: json?, key: [number] }
    edges:
      - [Invoice, BILLED_TO, Customer]
```

An attribute is `string`, `number`, `boolean`, `date` or `json`, with `?`
for optional. `key` lists the attributes that identify a node: the same key
values are the same node, so a second create returns the first (default
`[name]`, which every type has). `search` lists the ones the graph indexes
(default the key). A `date` is an ISO string (`2026-11-01`) and compares as
text. A `json` attribute is JSON text: `JSON.stringify` it when you write,
`JSON.parse` it when you read.

`app/publish` registers the types and edges on the workspace's graph
before the version, add-only. Nothing is ever removed, so a rollback keeps
them. A type another app declared is the same type: declare it with the
same attribute types, the same key and every attribute it requires, and
your new optional attributes are added; the build names whatever conflicts.
The strut server's own types, `Concept`, `Claim`, `Check` and `Evidence` cannot be
declared. A graph registers types on Neo4j and on a LadybugDB file alike;
on a strut server with no graph, an app that declares any does not build,
so keep its data in runs there.

The page writes them with `graph/create-node`, `edit-node`,
`create-triplet` and `delete-node` (granted in `grants.steps`), and reads a
LIST with `graph/find`: `{ node_type: "Invoice", where: { status: "unpaid",
due: { lt: today } }, orderBy: "due" }`, with equality, `gt` / `gte` / `lt`
/ `lte`, `in` and `contains`, a `cursor` for the next page, and `count:
true` for the total. For words or meaning use `graph/graph-search`; for one
node, `graph/graph-get`.

## Loading related data: one call, not a loop

When a view needs a lot of RELATED data at once — a run graph with its
nodes, the edges between them and each node's ancestors — do the whole
analysis server-side in ONE purpose-built step or workflow (a single Cypher
query that returns everything, for example), grant it, and call it once.
Never assemble it in the page: a `graph/graph-neighbors` call per node,
`graph/graph-get-batched` in a loop, a lineage walked hop by hop. Every
call is a browser round trip through the host, and a few hundred of them
make the page slow. (The edges among nodes you hold, and their lineage,
are `graph/graph-edges`: one call per thousand nodes.) A cheap read is a step (`useStep`, fine on a render);
an analysis too slow for that is a workflow, launched on a click and
followed with `useRun`. The worked example is `openhealth/run-graph`: one
call runs three queries and returns the nodes, edges and ancestors that
used to take up to ~240 browser round trips. The `strut/views` graph
components read node by node, so they suit a small graph; a big one needs
a step like this.

The strut server counts every call a page makes, and `app/get` returns it as `usage`:
calls, failures and data by step type, and `warnings` — one call per item,
the same call polled too fast, too many calls, too much data, a call
failing in a loop — each on the version that caused it, with what to do
instead. The person sees them as a warning dot on the app. Read them when
an app is slow or the person asks about one; a fixed version starts clean.

When an app is slow or failing for the person you work for, read
`app/calls { name }` before you guess: what their open page did, in
whatever host they use. It shows each call with when it started, how long
the step took (`ms`), strut's time before it (`doorMs`), how it ended, and
the page's errors where they happened. A console they paste is not the
record: the MCP client's `GET /mcp` 405 there is expected and costs
nothing. Fast calls with a long gap between them mean the time went outside
strut (the host's relay, the document's load, the page's render).

## What the build refuses

An import outside the kit and the installed apps; a relative import that
leaves the directory; `http(s):` imports; `dangerouslySetInnerHTML`,
`eval`, `new Function`. A `fetch` of a URL written out (`fetch("/api/x")`,
`fetch("https://…")`), `XMLHttpRequest` or a `WebSocket` is a warning: the
page's CSP allows a connection to nothing (`connect-src data: blob:` — an
imported file, a blob the page made), so it fails at runtime — call a
granted step with `useStep`, launch a workflow with `useLaunch`, talk to
the app's other viewers with `useChannel`. The document's size over 6 MB is
a warning.

## Four shapes

- **Benchmark hill-climb**: `useRuns` over the scoring workflow, a
  `recharts` line of `output.score` over time, `useLaunch` behind a
  button, `useRun({ live })` on the newest run, a tab for its output.
- **Invoice tracker**: customers, visits and invoices as declared graph
  types written with `graph/*`, a table from `@tanstack/react-table`, a
  photo-reading workflow launched per invoice, the line items in its own
  tables (`useSql`; a later release adds schedules for reminders).
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
it where they are: under Apps in the strut server's UI, where "Edit with the builder"
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
