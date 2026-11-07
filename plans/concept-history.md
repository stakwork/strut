# Concept history: the Concept tree and the ontology, in git

> **Status (2026-11-07): proposed, six rulings in (Evan, the same day;
> "Rulings" below).** Written after a read of `main` @8db356c.
> Companions: `concept-tree.md` (what the tree holds), `knowledge-app.md`
> (the app that draws it), `package-examples.md` (§2's markers and its
> item 1, shared with this plan), `proposals.md` (review),
> `graph-temporal.md` (time for facts, which this plan leaves alone).

## In brief

- Every change to a Concept page or a graph type is committed to a git
  repository on the box, right after the step that made it: one commit
  per write step, naming the run, the step and who ran it.
- The graph stays the source and stays writable. Agents, apps, workflows
  and people write Concepts as they do now. Git only records: nothing
  reads it to serve the graph.
- Three steps use the history, for agents, apps and workflows alike:
  - `graph/history` reads a page's changes, a diff, and the tree at any
    commit;
  - `graph/snapshot` names a commit;
  - `graph/revert` puts a page back, or undoes everything one run did.
- The Knowledge app (`strut/knowledge`) shows it: a page's History, a
  timeline with one row per run, and a picker of snapshots that draws
  the tree as it was.
- A tree at a commit is a frozen tree, at the cost of the pages that
  changed, and a snapshot is a frozen tree with a name. That is what a
  Concept or ontology eval will stand on later. The evals are not in
  this plan (ruling 5).

## 1. Why

- Concepts change all the time, and every writer is an AI at some
  level: the sweeps, the job agents, the assistant, a person's edit
  through an app. None of it can be rebuilt by running a recipe again,
  so a tree that is overwritten is gone.
- Without a history there is no "who changed this page, and in which
  run", no way back to last week's page, and no way to compare the tree
  before and after a change.
- **Considered and not taken:**
  - **History in the graph**: a revision per node's text, read with
    `as_of`. Ladybug's edges already have two clocks
    (`graph-temporal.md`); a node's text has none, and Neo4j has
    neither. Two engines to change, and still no branches.
  - **Git as the source**, the graph read-only and built from it. Every
    writer of a Concept would change, and an agent could no longer just
    make one (ruling 1).
- **Git as it stands does what is needed.** A commit is a frozen tree,
  unchanged pages are shared between commits, and `log`, `diff` and
  `show` read it. `git` is already in strut's image (`Dockerfile`).
- **Steps and workflows keep strut's own versions.** A run pins the
  exact version it executes and a resume goes back to it
  (RUN_CONTROL_SPEC §5.4). Nothing pins a Concept that way, so a record
  to look back through is enough.

## 2. What is recorded

One bare repository per graph, `<dataDir>/concept-history.git`, branch
`main`, with two folders:

```
concepts/<namespace>/<key>.md    one per live Concept
graph/<Type>.yaml                one per type in the graph's ontology, the Strut types excepted
```

- **A page** is named by its node key (`concept-ownerrepo`). The writer
  already makes a key lowercase alphanumerics and dashes
  (`composeNodeKey`, `node-writer.ts`), so every key is a file name. The
  package format's `concepts/<Name>.md` cannot hold every page: a build
  refuses a name with `/` in it (`conceptFiles`, `build.ts`), and the
  concept tree names its repository pages `owner/repo`. The key is the
  graph's own identity, so two pages never share a file.
- **A page's file**:
  - front matter: `name`; then every attribute the node holds except
    `docs` and what the graph stamps or derives (`ref_id`, `key`,
    `namespace`, `search_text`, `title`, the vectors, `created_at`,
    `updated_at`, `created_by`); then `parents`, the keys of every live
    `PARENT_OF` parent, sorted. A page may have several parents; the
    package export keeps only the first;
  - the body: `docs`.
- **A type** is its `graph/<Type>.yaml` in the package grammar
  (`graph-types.ts`), written by the same code a package build uses.
- **A deleted page** is a file removed. A restored one comes back.
- **Not recorded:**
  - other node types;
  - other edges, such as a PR's `TOUCHES` or a file's `MODIFIES`. Those
    are facts, the graph's to keep with its own clocks;
  - the Strut types, which are code;
  - vectors.
- The same node always writes the same bytes, so a write that changes
  nothing makes no commit.

## 3. When

**Right after each write step**, never on a timer (ruling 2). Every
graph write that an agent, an app, a workflow or an accepted proposal
makes is a step: a run's step, an agent's tool call, an app's
`step_run`. Each runs inside `runWorkflow`, which hands every event to
`services.onRunEvent` (`runner.ts:447`), a single step's run
(`runStep`) included. The history is one more listener there:

- On the `step.end` of a graph write step that lists `nodes` (the
  `withAccessedNodes` marker, lifted onto the event, `core.ts`):
  - it reads each listed node. A live Concept is written to its file;
    a deleted one is removed;
  - it writes every type file again. There are tens of them, and git
    keeps the unchanged ones;
  - then it makes one commit.
- **The commit** is authored by the run's actor (from its `run.start`).
  Its message says what changed and carries three trailers: `Run:` (the
  run id), `Step:` (the event's path) and, when an app made the call,
  `App:`.
- **It never holds the run up.** Commits go on one in-process queue, in
  order. A commit that fails is logged and never fails the step; the
  next full pass catches up.
- **Read-your-writes.** The history steps wait for the queue to empty
  before they read, so a step sees its own writes.

So a workflow or agent run commits as it goes, one commit per write
step while the run is still going, and an app's `step_run` commits
right after its one step.

**Why per step, not per run** (ruling 6). A commit records how a page
looks when the commit is taken, not what a run wrote. Taken at the end
of each run:
- **Overlapping runs take each other's credit.** Run A edits a page,
  run B edits it after, and A ends first: A's commit holds B's edit
  under A's name, and B's finds nothing left to commit.
- **Long runs leave gaps.** A sweep of hours, or a job waiting days on a
  person, keeps writes the graph already has out of the history. A
  process that dies mid-run leaves them to the next boot's pass,
  credited to `strut`.
- **Edits within a run collapse.** Two edits to one page keep only the
  last.

Per step, the same race is only the milliseconds between a step's end
and the read. A run as a unit still comes from the `Run:` trailer: one
row per run in the timeline (§5), and `graph/revert` of a whole run
(§4).

**The full pass** writes the whole tree and every type, then commits
whatever differs. It runs at boot (after the seeds), after a package
install, and when `graph/history` is asked to `sync`. It catches what no
write step reported:
- a seed, and a package install's writes;
- raw Cypher through `services.graph.query`;
- another process writing the same Neo4j, such as a swarm's jarvis or
  Hive.

Its commits are authored `strut` and name the cause.

**What this needs of the steps.** Every graph step that writes declares
`effect: "write"` and marks the nodes it changed (`package-examples.md`
item 1). Today `set-namespace` and `import-memory` write nodes and mark
none, and `create-schema` declares no effect. A test holds every
`graph/*` step to the rule.

## 4. Three steps: history, snapshot, revert

Agents call them as tools, apps through `step_run`, workflows as steps.
They are three steps, not one, because an app is granted steps by type
(`grantRefusal`, `apps/tools.ts`): an app that may read the history is
not thereby allowed to change the graph. Each is held to the caller's
reader list (`scope.ts`): a page in a namespace the caller cannot read
is in none of its answers. Wherever a commit is taken, a snapshot's
name works too.

**`graph/history`** (`effect: "read"`):

| `action` | Input | Output |
| --- | --- | --- |
| `log` | a page (name or key), a type, a run, or nothing for all; `limit` | commits, newest first: id, time, author, run, step, app, what changed |
| `show` | a page or a type, and a commit | the file at that commit, parsed |
| `diff` | a page, a type or nothing, and two commits | what changed between them: pages added, removed and changed, each with its text before and after |
| `tree` | a commit | every page's name, key and parents at that commit: the tree as it was |
| `snapshots` | `limit` | the snapshots, newest first: name, commit, time, who, note |
| `sync` | nothing | runs the full pass |

**`graph/snapshot`** names a commit, the newest by default: a name of
lowercase letters, digits and dashes (up to 64), and an optional note.
It is a git tag, annotated with the caller and the note. A name already
taken is refused, so a snapshot never moves. It writes nothing to the
graph. An automation can take one weekly; an eval will name its
baseline.

**`graph/revert`** (`effect: "write"`) puts the graph back, writing
through the node and edge writers as the caller. Its own writes are
committed like any other, with its own run in the trailer.
- **A page to a commit:** the page's attributes, `docs` and parents as
  they were there. A page absent at that commit is deleted, and one
  deleted since is restored.
- **A run:** every page the run's commits changed goes back to how it
  was just before the run's first commit that touched it. Pages the run
  made are deleted, and pages it deleted are restored. A page that
  another commit changed after the run's last one is left as it is and
  reported: that later edit is someone else's.
- **Never a type.** The ontology is add-only (`graph-types.ts`), so a
  type the run made stays, and is reported.

## 5. What a person sees: the Knowledge app

`strut/knowledge` (`knowledge-app.md`, specs/API.md §14.13) draws the
tree: the outline on the left, the graph in the middle, a page's panel
on the right. It reads the history through the steps above.

- **A page's History**, a tab in its panel: each change with its time,
  who made it, and its run (a link to the run). A click shows the diff.
- **The timeline**: the whole tree's changes, one row per run (the
  `Run:` trailer), newest first. A row expands to the pages the run
  changed. A sweep that made a few hundred commits is one row.
- **Snapshots**: a picker in the top bar, `Live` by default, listing the
  snapshots newest first, and **Save snapshot…** to name the commit
  now.
- **The tree as it was**: picking a snapshot, or any timeline row, draws
  the tree at that commit, read-only, under a banner ("Viewing
  before-ontology-v2 · Back to live"). Only the Concept layer has a
  past, so the graph shows the pages and their parents, nothing else.
  **Compare with live** marks the pages added, removed and changed, in
  the outline and on the graph.
- **The address carries the commit or the snapshot**, as it carries the
  selection today, so a view of the past is a link.
- **Revert** on a page's change and **Undo this run** on a timeline row
  come when the app edits. It is read-only today.

## 6. Review

Review is optional, and it is a strut proposal, never a GitHub PR
(ruling 4). Proposals already cover every graph and Concept write
(`proposals.md`). An agent that wants a person's yes proposes the
`graph/*` call instead of making it, and an accepted proposal's write
is committed like any other. This plan changes nothing about proposals.

## 7. Where it runs

- **On by default** wherever strut has a graph and `git`.
  `STRUT_CONCEPT_HISTORY=0` turns it off. The desktop package sets it
  off (ruling 3). Without `git` it is off, and boot says so in one line.
- **What it covers:** every Concept and every type, in every namespace
  (ruling 3).
- **Nothing is dropped.** Every commit stays on `main`, so git's
  clean-up never removes one. A snapshot only gives a commit a name.
- **Backups:** the repository lives under `dataDir`, so a box's backup
  carries it, and a restore brings the history back with the graph it
  describes. Stadeum backs up every volume.
- **Size:** text, and only what changed. swarm38 holds about 500
  Concepts, each rendered at up to 6k chars. A sweep that rewrites
  fifty pages a day adds about 100 MB a year before git compresses it.

## 8. Work items (one PR each, in this order)

1. **Write steps say so.** `effect: "write"` on every graph write step,
   the `nodes` marker on `set-namespace` and `import-memory`, and the
   test. This is `package-examples.md` item 1, shared: whichever plan
   lands first does it.
2. **The history.** The repository, the file format, the listener on
   `onRunEvent`, the queue, the full pass (boot, install, `sync`), and
   the setting. Tests on both engines:
   - creating, editing, reparenting, deleting and restoring a Concept
     each make one commit, with the right file and trailers;
   - `graph/create-schema` makes one commit;
   - rewriting a node unchanged makes none;
   - a raw write is caught by the full pass;
   - with the setting off, no repository exists.
3. **The three steps**: `graph/history`, `graph/snapshot` and
   `graph/revert`, with the reader list and read-your-writes. Tests:
   - a namespace the caller cannot read is absent from `log`, `tree`
     and `diff`;
   - a snapshot's name works wherever a commit does, and a name already
     taken is refused;
   - reverting an edited page puts back its text and parents, and
     commits;
   - undoing a run puts back every page it changed, deletes the pages it
     made, and leaves and reports a page another run changed since.
4. **The Knowledge app** (§5): a page's History, the timeline, the
   snapshot picker, the tree as it was, and Compare with live. Revert
   and Undo this run once the app edits.

## Later (not this plan)

- **A snapshot loaded for a run.** A run names a snapshot. Strut builds
  a child Ladybug file from its commit (cached by the commit id), points
  that run's `ctx.services.graph` at it, and records the commit on the
  run, so every score says which tree it ran on. To decide in the eval
  plan: a snapshot holds only the Concept layer and the types, not the
  data under them. So the child is probably the live data with the
  snapshot's Concepts in place: cheap from a Ladybug file (copy it, swap
  the layer), an export of what the tasks touch from Neo4j.
- **Branches:** a candidate graph (a child Ladybug file) whose writes
  commit to a branch of its own. Applying it writes its files into the
  graph, or proposes them. This is where Concept and ontology evals
  start.
- **A package from a commit:** a build that reads its Concepts and types
  at a commit instead of from the live graph.

## Rulings (Evan, 2026-11-07)

1. **The graph stays the source and stays writable.** Agents make
   Concepts freely; git only records.
2. **A commit follows the write, never a timer.** An app's edit is in
   the history as soon as the step that made it ends.
3. **Every Concept and every graph type, in every namespace.** Off on
   desktop.
4. **Review is optional, and it is a strut proposal**, never a GitHub
   PR.
5. **Evals come later.** This plan builds the history they will stand
   on, and none of the evals.
6. **A commit per write step, not per run** (§3). A run as a unit comes
   from the `Run:` trailer.

## Open

- **A sweep's commit count.** A few hundred commits per sweep. The
  timeline shows a run as one row, so the count matters only if git's
  size or speed suffers, which is not expected at this scale.
- **Reader lists and the repository.** Where `graphReaders` is set, the
  steps apply it, but the repository itself holds every namespace, as
  the graph's own file does: anything that can read `dataDir` can read
  it.
- **Edge rules' other fields.** The type grammar carries no `temporal`,
  `cardinality` or aliases yet (`graph-types.ts`), so a type's history
  misses them until it does.
- **A rename** is a new key, so it reads as one page removed and another
  added, and `log` of the new name starts at the rename.
