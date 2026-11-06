# Package examples: real runs, copied in with the package

> **Status (2026-11-06): proposed, four rulings in (Evan, the same day;
> "Rulings" below).** Builds on stakwork/strut#559 (a package's graph
> types, `graph/<Type>.yaml`). Written after a read of `main` @dabd868.

## In brief

- A person opening a new box should find the legal desk with runs already
  in it: real openlaw runs, their transcripts and files, and the graph
  data they wrote. Nothing runs, nothing is spent.
- A package gets an `examples/` folder. Each example is one finished run
  copied from the publisher's strut: its log, its summary, its files, and
  the graph nodes and edges it wrote.
- The BUILD exports the run, rewrites what names the publisher's strut,
  refuses a secret, and finds the run's graph writes in its own log.
- The INSTALL puts the run in the run store as `origin: "example"`,
  copies its files, writes its graph data through the writer, and
  projects it. An uninstall takes it all back.

## 1. What a run is, and what it is not

A run is self-contained:

| Part | Where | Note |
|---|---|---|
| The event log | `RunStore` (`<workspace>/workflows/<wf>/runs/<runId>/`) | Every agent's whole session rides on its `step.end` as `messages`, so `run/transcript` reads the log |
| The summary | `RunStore.finalize` | status, input, output, `workflowHash`, `stepCounts`, `totals` (spend) |
| Its files | `<workspace>/artifacts/<runId>/` | outputs name them by RELATIVE path |

- The run id is a millisecond timestamp. Every event's `path` starts with
  the workflow's name (`openlaw-run/ingest/003-agent`; a subflow's steps
  nest under the step that called it, `runner.ts:783`).
- A run from outside goes in through the store as a live one does:
  `append` each event, then `finalize`. `run/list`, `run/get`,
  `run/events` and `run/transcript` read it like any other, and the
  projector (`graph/projector.ts`) can project it afterwards.

What a run does not hold:

- **The graph data it wrote.** Those nodes live in the graph.
- **An app's own SQLite tables.** Not carried (ruling 4).

## 2. A run's graph writes are in its log

Every `graph/*` step that touches nodes marks its output with
`withAccessedNodes`, and the runner lifts the marker onto the event as
`nodes` (`core.ts:576`), never truncated. That holds for an agent's tool
calls too: each is its own `step.end`, `stepType: "tool:<type>"`. So the
log already lists every node a run's graph steps touched.
`create-batch-triplet` reports both ends of every edge it wrote, so a
node the run only linked to is listed too.

Two gaps:

- **Reads mark nodes as well** (`graph-get`, `graph-search`,
  `graph-neighbors`, `walk`). The write steps do not declare
  `effect: "write"`; only some reads declare `effect: "read"`. Item 1 has
  every graph step declare its effect. The export takes `nodes` only from
  events whose step is a write. Those steps are `create-node`,
  `create-triplet`, `create-batch-triplet`, `edit-node`, `edit-edge`,
  `assert`, `merge`, `unmerge`, `move-node` and `restore-node`.
- **A write the log cannot see:** raw Cypher (`graph/query`), a custom
  step that writes without the marker, another process. The request can
  name `namespaces` for these: every live node in them is added. The
  ingestion prompt passes a task namespace, so for openlaw one namespace
  per task catches everything either way.

The edges are every live edge between two nodes of the slice. Node
`ref_id`s are not stable across graphs (ruling 2), so the slice names
nodes by TYPE and KEY, the identity the writer upserts on.

## 3. The format

```
examples/<name>/
  summary.json    # the run's summary, its workflow named as inside the package
  events.jsonl    # the log, transcripts included
  artifacts/…     # the run's files, as under artifacts/<runId>/
  graph.jsonl     # optional: { node: { id, type, namespace, data } } then { edge: { type, source, target, data? } }
```

- `<name>` is the run id. An item of kind `example`, named
  `<workflow path>/<runId>`.
- In `graph.jsonl`, `id` is local to the file (`n1`, `n2`, …). Edges name
  their ends by it. `data` is the node's attributes as its type declares
  them: never `ref_id`, stamps, search text or vectors.
- Every type in `graph.jsonl` is in the package's `graph/`, the native
  seed, or a required package. The build checks this, and so does the
  install. That is the ontology's real completeness check: if the
  example's data cannot be written, the package is missing a type.

## 4. Build

`BuildRequest.examples: [{ workflow, runId, namespaces? }]`. The workflow
is named as it is HERE.

- **What it refuses:**
  - a workflow the package does not carry;
  - a run that is not finished, or did not succeed;
  - a run that cannot be read whole;
  - a graph type outside the package and what it requires;
  - **a secret:** the log, the summary and the files are scanned for
    every value in this strut's secret store, and one found refuses the
    build, naming the secret and the file. It is a byte search, cheap
    beside a publish.
- **What it rewrites:**
  - `summary.workflow` and the first segment of every event's `path`
    become the workflow's path in the package (`openlaw-run`; the install
    puts the prefix back);
  - `workflowHash` on `run.start`, `run.resumed` and the summary becomes
    the packaged version's hash, so "runs of this version" holds on the
    box;
  - the summary's and `run.start`'s `app` become the app's path in the
    package, its `version` dropped.
- **What it removes**, since it names the publisher's people and plumbing:
  `actor`, `principal`, `job`, `automation`, `callback`, `mcp`,
  `continues`, `conversation`, `wake`, `wakeAsked`, `peerPerson`, and an
  `origin` other than `app`.
- **What it keeps:** step references as written (the install finds them
  in the package first, plans/packages-ux.md §2), `stepHashes`, `totals`
  (what the run cost is worth showing), timestamps.
- **The size:** an archive is capped at 64 MB packed and 256 MB unpacked
  (`archive.ts`). The build result reports each example's bytes, and the
  package page shows them.

## 5. Install

After the graph types, steps, workflows and apps, so everything an
example names is there:

1. **The graph data first.** Each node goes through `nodes.write(…,
   "upsert")` in its namespace (registered when missing). The new
   `ref_id` is kept against the local `id`. Then each edge goes through
   `edges.write`. An existing node with the same key is the same node.
2. **The run.** Its events go into the run store under the installed
   workflow's name (prefix restored), then its summary, with
   `origin: "example"`. Its run id stays as it was, which keeps
   `artifacts/<runId>/` and any run linking another valid. A run id the
   store already holds for that workflow is skipped (`present`).
3. **Its files**, into `artifacts/<runId>/`.
4. **The projection**, as when a run ends, so the run is a `StrutRun` and
   the assistant finds it.

Then:

- **An example never runs again.** A resume, a retry or a cancel is
  refused (`origin: "example"`). The verify pass skips it, so it writes no
  evidence. It is never billed: nothing calls the gateway.
- **Uninstall** deletes the example runs and their files, and soft-deletes
  the nodes and edges its graph data created. A node that was already
  there (`existing` at install) is left. Taking back a failed install does
  the same.
- **The distro's door:** a release's examples replace the last release's.

## 6. What shows it

- **Run lists badge it.** The summary carries `origin` so a list can badge
  a run without reading its log (`core.ts:829`). The UI's run lists and
  the kit's `useRuns` show "Example". An app filters on it if it wants.
- **The package page** gets an Examples field beside the workflows: a
  workflow's recent successful runs, ticked.
- **The store's derived page** (`detail.ts`) counts a release's examples.

## 7. Work items (one PR each, in this order)

1. **`effect` on every graph step.** The write steps declare
   `effect: "write"`, the reads `"read"`. A test holds every `graph/*`
   step to one. This also makes the store's `can.acts` true for a package
   that writes the graph.
2. **`origin: "example"`.** The `RunOrigin` value, refused by resume,
   retry and cancel, skipped by the verify pass, badged in the UI's run
   lists and the kit.
3. **Examples' runs and files.** The format (`examples/<runId>/` without
   `graph.jsonl`), the build's export, rewrites and secret scan, and the
   install, uninstall and take-back. Tests: a run built on one strut and
   installed on another reads back through `run/get`, `run/events` and
   `run/transcript` with its files; a secret refuses the build.
4. **Examples' graph data.** The slice from the log's write steps (item
   1) and named namespaces, `graph.jsonl`, the type check at build and
   install, and the writes by key at install. Tests on both engines: the
   slice of an agent's batch-triplet writes, installed on a graph that
   never saw them, then removed by an uninstall.
5. **The package page's Examples field**, and the store's count.

Items 1 and 2 are independent of each other and of #559. Item 3 needs
item 2, item 4 needs items 1 and 3 and #559.

## Rulings (Evan, 2026-11-06)

1. **Examples are copied into the package**, never read live from the
   publisher's public surface: a box stands alone.
2. **`ref_id`s are not stable across graphs.** The graph data names nodes
   by type and key.
3. **A namespace is a good way to collect a run's graph data**, and the
   run's own log is read for its writes as well (§2).
4. **No app SQLite data** in an example yet.

## Open

- **Does openlaw-run use one namespace per task?** Read off a run on
  openlaw-1 before item 4. If it does, a task's namespace and the log's
  writes should be the same set, and the build can say when they differ.
- **A node an example only linked to** comes along whole (its type and
  key). On the box it is written when missing and kept on uninstall when
  it was already there. If such shared nodes turn out to be big, an
  option is to carry only their key.
