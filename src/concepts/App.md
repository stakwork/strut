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
  public/             # images, fonts, JSON fixtures, imported by path (inlined at build)
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

## The manifest

```yaml
title: Benchmark
description: Runs of score-wf over time.
icon: bar-chart-3
grants:
  workflows: [score-wf]        # the app's ROUTINES: run/* on these — list, read, launch, cancel
  steps: [graph/graph-get]     # cheap, deterministic steps it may call — never llm / agent / exec
  sqlite: false                # its own tables (a later release)
  automations: []              # schedules (a later release)
data:
  graph:
    types: {}                  # node types it declares and may WRITE (below: Graph types)
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
| `useLaunch(workflow, { job? })` → `{ launch(input, params?, key?, files?), pending }` | `run/launch`: a MUTATION — a function to call on a click, never a query; `job` launches under one of the app's jobs, `files` go with the run |
| `useUpload(job)` → `{ upload(file), remove(path) }` | `job/upload` / `job/delete-upload`: a file into the app's job, its `path` back (see "Files a person brings") |
| `useCancel()` → `{ cancel(workflow, runId) }` | `run/cancel` |
| `useWorkflow(workflow)` | `run/workflow`: description, the `input:` block, params defaults — what a launch form renders |
| `useStep(type)` → `{ run(config, input) }` | any granted step, as a function |
| `useAppState(key, initial)` → `[value, set, { loaded }]` | what THIS viewer's page remembers across visits, like `useState`: a tab, a filter, a draft (`app/state`, always granted) |
| `useToolInput()` | what the model or a deep link opened the app with; a link's values are strings |
| `useAppLink()` → `link(input?)`, `appLink(name, input?)` | a deep link to this app (or another) opened with `input`: `openLink(link({ view: "/runs", run: id }))` shows it, and the host's address bar follows, so the person can share it |
| `useApp()` | which app the page is: `{ name, version }`, or a job's app `{ job, path }` |
| `useHost()` → `{ theme, public, sendMessage(text), openLink(url) }` | the host: `sendMessage` reaches the builder chat ("change this app"), `openLink` opens a link to the strut server's UI in place; `public` is true when a visitor opened the page in the server's public view (see "The public view") |
| `useAssistant({ thread? })` → `{ messages, send(text, files?), pending, jobs }` | a chat with the person's ASSISTANT (`orchestrator`), as the viewer — see "The assistant" |

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
dialog): anyone can then open it with no account, read-only, and the store
can frame it. There `useHost().public` is true, and the server refuses
whatever the page tries beyond reading: starting or cancelling a run,
saving state (`useAppState` lasts the visit), uploads, writes. So when
`public` is true, keep the page as it is and DISABLE the controls that
would only fail — a Run button, a launch form's fields, a cancel, an
upload, an edit — with one line beside them saying runs are started by the
people who keep this server. Never hide them: a visitor should see what
the app does. strut/views' `LaunchForm` already does this. Everything else
works as it does for anyone: the runs, the graph, the reads the person
allowed, a tab or filter kept for the visit. Do it in every app, in the
view or not yet: a person adds an app later, and it should already be
right. An app in the public view is held at a release, so a publish is
a draft until a person moves it: say so when you hand one over.

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

Reads (`useRuns`, `useRun`, `useRunEvents`, `useTranscript`, `useTranscripts`, `useWorkflow`) are free and may
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
| The app's own tables: line items, a big import, settings | The app's SQLite (`sqlite/*`) | A later release; until then keep state in runs or the graph |
| Files a person uploads: photos, PDFs, a CSV to work from | A job of the app's (`useUpload`) | Every run under the job reads them; an agent's thread on it remembers them |
| What one viewer's page remembers: a tab, a filter, a draft | `useAppState` | Kept by the strut server per app and viewer, on every host and device; 256 KB a viewer |
| What is happening now between the people on it: moves, cursors, who is here | A channel (`useChannel`) | Live, stamped by the strut server, never kept |

A page has no browser storage: it is framed with an opaque origin, so
`localStorage` and `sessionStorage` last only the page's life (the kit
swaps in an in-memory one, so a library that persists does not break) and
IndexedDB and cookies are not there. Never write `localStorage` for
anything that should outlive the page: use `useAppState`.

"If an agent should ever find it, it goes in the graph." Migrations (when
they come) are additive: a rollback never rolls the schema back.

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

## What the build refuses

An import outside the kit and the installed apps; a relative import that
leaves the directory; `http(s):` imports; `dangerouslySetInnerHTML`,
`eval`, `new Function`. A call to the global `fetch`, `XMLHttpRequest` or a
`WebSocket` is a warning: the page's CSP is `connect-src 'none'`, so it
fails at runtime — call a granted step with `useStep`, launch a workflow
with `useLaunch`, talk to the app's other viewers with `useChannel`. The document's size over 6 MB is a warning.

## Four shapes

- **Benchmark hill-climb**: `useRuns` over the scoring workflow, a
  `recharts` line of `output.score` over time, `useLaunch` behind a
  button, `useRun({ live })` on the newest run, a tab for its output.
- **Invoice tracker**: customers, visits and invoices as declared graph
  types written with `graph/*`, a table from `@tanstack/react-table`, a
  photo-reading workflow launched per invoice (a later release adds SQLite
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
