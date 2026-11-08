# Concept history: the Concept tree and the ontology, in git

> **Status (2026-11-08): proposed, ten rulings in (Evan, 2026-11-07 and
> 2026-11-08; "Rulings" below).** Written after a read of `main`
> @8db356c, revised on 2026-11-07 after a read of openlaw-1's climbs
> (§1), and on 2026-11-08 after a review: one page format with packages
> (§2.1), the ontology's rule changes and the edge rules agents add (§2,
> §3), no Jarvis. Companions: `concept-tree.md` (what the tree holds),
> `knowledge-app.md` (the app that draws it), `live-feeds.md` (the
> writes this plan hears), `proposals.md` (review), `marketplace.md`
> (the package format), `ontology.md` (strut's own ontology),
> `graph-temporal.md` (time for facts, which this plan leaves alone).

## In brief

- Every change to a Concept page or to the ontology is committed to a
  git repository on the box as the run that makes it goes. Each commit
  names that run.
- The files are package files. A page in the history is, byte for
  byte, the page a package carries, and the repository is laid out like
  a package. A commit is a package without its manifest.
- The graph stays the source and stays writable. Agents, apps, workflows
  and people write Concepts and types as they do now. Git only records:
  nothing reads it to serve the graph.
- Two reads serve any benchmark, whatever its shape: **the tree at a
  moment**, and **what a run changed**. The tree a run read is the tree
  when it started.
- `graph/history` reads the history (log, show, diff, tree) and
  `graph/restore` puts a page back. Agents, apps and workflows call both
  alike. `ConceptDiff`, a strut/views component, draws a diff: the
  Knowledge app uses it, and so can any benchmark's app.
- Concepts and the ontology only. What the graph holds of each type,
  instances or counts, is not recorded (ruling 10).
- The evals themselves are not in this plan (ruling 5).

## 1. Why

- Concepts change all the time, and every writer is an AI at some
  level: the sweeps, the job agents, the assistant, a person's edit
  through an app. None of it can be rebuilt by running a recipe again,
  so a tree that is overwritten is gone.
- The ontology changes the same way. It is strut's alone (no Jarvis,
  ruling 9), and it grows at runtime:
  - an agent registers a type with `graph/create-schema`;
  - `create-triplet` and `create-batch-triplet` add an edge rule on
    their own when a write fits none (`create_schema_if_missing`);
  - an app's publish and a package's install register theirs;
  - and a type's rules change, not only its attributes: a new
    `key_spec` re-keys every node of the type (`schema-crud.ts`).

  Two agents that each add a type or an edge for the same thing is
  how an ontology sprawls. The history is where that shows.
- Without a history there is no "who changed this page or this type,
  and in which run", no way back to last week's page, and no way to
  compare the tree before and after a change.
- **What a benchmark needs.** openlaw-1's climbs are the first:
  `openlaw-climb` runs a Harvey task, `openlaw-improve` writes Law and
  Firm Concepts from the criteria that failed, and the task runs again.
  Other shapes will follow: an analyzer workflow on a schedule of its
  own, a sweep, a person's edits. Every one comes down to runs scored on
  tree X, something changing the tree, and runs scored on tree Y. So
  whatever the shape, a benchmark asks the history two things:
  - **the tree at a moment**, the tree a run read being the tree when
    it started;
  - **what a given run changed.**

  Today the climb's page lists only the names of the Concepts it wrote,
  and `openlaw-improve` keeps its own backup file of the pages it
  amends.
- **Considered and not taken:**
  - **History in the graph**: a revision per node's text, read with
    `as_of`. Ladybug's edges already have two clocks
    (`graph-temporal.md`); a node's text has none, and Neo4j has
    neither. Two engines to change, and still no branches.
  - **Git as the source**, the graph read-only and built from it. Every
    writer of a Concept would change, and an agent could no longer just
    make one (ruling 1).
  - **A record per run of the tree it read** (a ref or a field on
    `run.start`). Every app read is a run, so that is a record per run
    by the thousand, and a run's start time finds the same commit with
    nothing written.
  - **One commit per step**, found from the step's declared `effect`
    and its `nodes` marker. Workspace and package steps declare neither
    reliably (`concept/create` on openlaw-1 declares no effect), and an
    accepted proposal runs outside any run's events. §3 hears the
    writes themselves instead.
  - **The graph's shape**: counts per type and per edge, how often each
    attribute is filled. Every edge needs a rule (`ontology.md` ruling
    1), so the ontology already says what the graph can hold. What it
    does hold is facts about instances, the graph's to keep (ruling 10).
- **Git as it stands does what is needed.** A commit is a frozen tree,
  unchanged pages are shared between commits, and `log`, `diff` and
  `show` read it. Anyone can clone the repository and read it with
  ordinary tools. `git` is already in strut's image (`Dockerfile`).
- **Steps and workflows keep strut's own versions.** A run pins the
  exact version it executes and a resume goes back to it
  (RUN_CONTROL_SPEC §5.4). Nothing pins a Concept that way, so a record
  to look back through is enough.

## 2. What is recorded

One bare repository per graph, `<dataDir>/concept-history.git`, branch
`main`, laid out like a package (`marketplace.md`):

```
concepts/<key>.md                    one per live Concept in the backend's own namespace
namespaces/<ns>/concepts/<key>.md    one per live Concept in any other namespace
graph/<Type>.yaml                    one per type in the ontology, the Strut types excepted
```

- **Why this layout.** The ontology is one per graph; Concepts live in
  a namespace. The backend's own namespace (`default` unless
  `STRUT_GRAPH_NAMESPACE` says otherwise) is the only one on a Ladybug
  file and the common case on Neo4j, so the repository's root is a
  package's layout, and a commit is a package without its `strut.yaml`.
- **A page** is named by its node key (`concept-ownerrepo`). The writer
  already makes a key lowercase alphanumerics and dashes
  (`composeNodeKey`, `node-writer.ts`), so every key is a file name, and
  the key is the page's identity in its namespace, so two pages never
  share a file. A name cannot be the file name: the concept tree names
  its repository pages `owner/repo`.
- **A page's file**:
  - front matter: `name`; then every attribute the node holds except
    `docs` and what the graph or a seeder stamps or derives (`ref_id`,
    `key`, `namespace`, `search_text`, `title`, the vectors,
    `created_at`, `updated_at`, `created_by`, `unique_source_id`); then
    `parents`, the names of every live `PARENT_OF` parent, sorted. A
    page may have several parents. Names, not keys: they are what a
    person reads, and the key follows from the name;
  - the body: `docs`.
- **A type** is its `graph/<Type>.yaml` in the package grammar
  (`graph-types.ts`), written by the same code a package build uses.
  The file holds every rule the grammar carries (`key_spec`, `index`,
  `identifiers`, `title_key`, `description_key`, `role`, `embed`,
  `edges`) beside the attributes, so a changed rule is a changed line.
- **A deleted page** is a file removed. A restored one comes back. A
  type no longer in the ontology is a file removed.
- **A rename.** An edit of a page's name keeps its `ref_id` and
  recomposes its key (`node-writer.ts`). The history keeps every live
  page's `ref_id` → key in memory (the full pass builds it, each batch
  keeps it current). A page whose key changed is its old file moved to
  the new name in the same commit, with a `Renamed: <old key> <new key>`
  trailer, and its children's files are rewritten, since their
  `parents` changed.
- **Not recorded:**
  - other node types and their instances, and counts of them (ruling
    10);
  - other edges, such as a PR's `TOUCHES` or a file's `MODIFIES`. Those
    are facts, the graph's to keep with its own clocks;
  - the Strut types, which are code;
  - vectors.
- The same node always writes the same bytes, so a write that changes
  nothing makes no commit.

### 2.1 One page format, with packages

- **Today** a package's page is `concepts/<Name>.md`: front matter
  `description` and one `parent`, the body `docs`. A build keeps the
  first parent by name and no other attribute (`conceptFiles`,
  `build.ts`), and a name with `/` cannot be a file, so the concept
  tree's repository pages cannot travel.
- **The package format takes the history's page** (ruling 8):
  `concepts/<key>.md` with `name`, the attributes and `parents`. The
  reader (`format.ts`) tells the two forms apart by `name` in the front
  matter, and refuses a page whose file name is not its key
  (`bad_package:`). The old form stays readable: strut's own pages
  (`src/concepts/`) and every package already published use it.
- **A build** writes the new form, every parent included. A package
  rebuilt this way has a new digest, a new release like any other.
- **An install** (`seedConcepts`) writes the page's attributes and a
  `PARENT_OF` from each parent, found by name in the package or the
  graph as today. An attribute the installing graph's `Concept` does not
  declare is left out, with a warning naming it: `Concept` is a seed
  type, so a package never carries its `graph/Concept.yaml`
  (`exportTypes`). `keepEdited` compares every attribute the file
  carries, not only `description` and `docs`.
- **So** a page means the same bytes in a package and in the history,
  and "a package from a commit" (Later) copies files.

## 3. When

**As a run writes.** The runner hands every run a view of
`services.graph` whose writers report each write (`bindGraph`,
`graph-writes.ts`; `live-feeds.md` §2), and an accepted proposal's apply
gets the same view (`proposals.ts`). So every write made through it is
heard, whatever made it: a `graph/*` step, a workspace or package step
that writes `ctx.services.graph` itself, an agent's tool call, an app's
`step_run`, an accepted proposal. Nothing depends on what a step
declares, and nothing is asked of steps.

- **The batches already exist.** The view gathers a run's writes and
  sends them a second after the last one, at most five after the first,
  and when the run ends (the live feed's `job.update { kind: "graph" }`).
  The history is one more receiver of the same batches. For each batch:
  - it reads every Concept the batch wrote, and every Concept a
    `PARENT_OF` it wrote or deleted points to. A live one is written to
    its file; a deleted one is removed; a renamed one is moved (§2);
  - when the batch wrote a type or an edge rule, it writes the type
    files again;
  - then it makes one commit.
- **Types are heard the same way.** A type is written through the
  backend's `schemaSource` (`createNodeSchema`), and an edge rule
  through the resolver's `createEdgeSchema`, which `create-triplet` and
  `create-batch-triplet` call themselves when a write fits no rule
  (`writeEdge`, `steps/lib/graph/_shared.ts`). The view wraps both, as
  it wraps the node and edge writers (item 2).
- **The commit** is authored by the run's actor. Its message says what
  changed, and it carries these trailers:
  - `Run:` the run that made the change. A subflow shares its root
    run's id, so a climb's improve step is the climb's run;
  - `At:` the time of the batch's last write, to the millisecond. The
    commit's git date is the same time in whole seconds, so a lookup by
    time can start with `git log --before` (§4);
  - `App:` or `Proposal:` when one made the change;
  - `Renamed:` for each page the batch renamed.

  No step: the run's log already says which step wrote what and why
  (each tool call beside the agent's words; `run/provenance` reads it).
  Git answers "which run", the run log "which step, and why".
- **The runs that only read the tree are not recorded anywhere.** Their
  start time finds their tree (§4).
- **It never holds the run up.** Commits go on one in-process queue, in
  order. A commit that fails is logged and never fails the run; the next
  full pass catches up.
- **Read-your-writes.** `graph/history` sends the batches still
  pending and waits for the queue to empty before it reads, so a step
  sees its own run's writes.

**The full pass** writes the whole tree and every type, then commits
whatever differs. It catches every write made outside a run's view: a
seed, raw Cypher through `services.graph.query`, another process
writing the same graph.
- At boot (after the seeds), and when `graph/history` is asked to
  `sync`: authored `strut`, no `Run:`, the message naming the cause.
- After an app publish or a package install, which register types (an
  install also writes Concepts) outside any run: authored by the person
  who published or installed, with `App: <name>@<vN>` or
  `Package: <publisher>/<name>@<digest>`.

## 4. Reading and restoring: `graph/history` and `graph/restore`

Two lib steps, because strut grants by step name: an app's grants, an
agent's tools and an `approve:` list each name steps. One step that
could both read and restore could not be granted for looking only.
Agents call them as tools, apps through `step_run`, workflows as steps.
Both are held to the caller's reader list (`scope.ts`): a page in a
namespace the caller cannot read is in none of their answers.

**Wherever a commit is asked for, a time does too.** A time means the
last commit whose `At:` is at or before it: `git log --before` on the
commit dates finds the candidates, and the `At:` trailers pick the
commit. A benchmark passes a run's start time to get the tree that run
read.

`graph/history` (`effect: "read"`):

| `action` | Input | Output |
| --- | --- | --- |
| `log` | a page (name or key), a type, a `run`, or nothing for all; optional `from` and `to`; `limit` | commits, newest first: id, time, author, run, app, package or proposal, what changed |
| `show` | a page or a type, and a commit or time | the file then, parsed |
| `diff` | a page, a type or nothing, and two commits or times | the difference (below) |
| `tree` | a commit or time | every page's name, key and parents then |
| `sync` | nothing | runs the full pass |

- `log { run }` is what that run changed. `log { from, to }` is who
  changed the tree between two moments, such as a scored run's start and
  end: whether the tree moved while it ran. `log` of a page follows it
  back through its `Renamed:` trailers.
- **A diff** is a list a view can draw:
  - `pages`: one entry per page that differs, with its key, its name,
    its change (`added`, `removed`, `edited`, `moved` when its parents
    changed, `renamed`, or several of the last three) and its file
    before and after (front matter parsed, `docs` as text). A rename is
    read from the `Renamed:` trailers, never guessed from the text. The
    caller draws the text diff;
  - `types`: one entry per type that differs, with its change
    (`added`, `extended` when attributes or edge rules were added,
    `changed` when a rule changed, `removed`), which fields, and its
    file before and after;
  - `runs`: the runs whose commits fall between the two, each with how
    many pages and types it changed.

`graph/restore` (`effect: "write"`) takes a page and a commit or time,
and writes the page's attributes, `docs` and parents as they were then
back through the node and edge writers, as the caller. The write is
heard and committed like any other. An app needs the grant, an agent
the step among its tools, and an `approve:` list may gate it. It never
writes a type: an attribute once declared stays (`graph-types.ts`), and
putting back an older `key_spec` would re-key every node of the type.

## 5. Review

Review is optional, and it is a strut proposal, never a GitHub PR
(ruling 4). Proposals already cover every graph and Concept write
(`proposals.md`). An agent that wants a person's yes proposes the
`graph/*` call instead of making it, and an accepted proposal's write
is heard and committed like any other (§3), with `Proposal:`. This plan
changes nothing about proposals.

## 6. Where it runs

- **On by default** wherever strut has a graph and `git`.
  `STRUT_CONCEPT_HISTORY=0` turns it off. The desktop package sets it
  off (ruling 3). Without `git` it is off, and boot says so in one line.
- **What it covers:** every Concept and every type, in every namespace
  (ruling 3).
- **Backups:** the repository lives under `dataDir`, so a box's backup
  carries it, and a restore brings the history back with the graph it
  describes. Stadeum backs up every volume.
- **Size:** text, and only what changed. swarm38 holds about 500
  Concepts, each rendered at up to 6k chars. A sweep that rewrites
  fifty pages a day adds about 100 MB a year before git compresses it.

## 7. Work items (one PR each, in this order)

1. **The page format** (§2.1). The package reader takes both forms, a
   build writes the new one, an install writes the attributes and every
   parent, `keepEdited` compares every attribute. Tests:
   - a page with two parents and a `/` in its name goes through build
     and install with both parents and its attributes;
   - an old-form package installs as before;
   - a page whose file name is not its key is refused;
   - an attribute the installing graph does not declare is left out,
     with a warning.
2. **The history.** The repository, the history as a receiver of the
   view's batches, the view wrapping `createNodeSchema` and
   `createEdgeSchema`, the `ref_id` → key index, the queue, the full
   pass (boot, `sync`, and with its cause after an app publish or a
   package install), and the setting. Tests on both engines:
   - creating, editing, reparenting and deleting a Concept in a run
     each make one commit, with the right file, `Run:` and `At:`, and a
     git date that matches `At:`;
   - renaming a page makes one commit that moves its file, rewrites its
     children's `parents`, and carries `Renamed:`;
   - the same through a workspace step that writes `ctx.services.graph`
     itself, and through an accepted proposal (`Proposal:`);
   - `graph/create-schema` in a run makes one commit, and so does
     `create-triplet` with `create_schema_if_missing` when it adds an
     edge rule;
   - a type whose `key_spec` changes makes one commit with the changed
     line;
   - an app publish that registers a type commits it with `App:`, and a
     package install with `Package:`;
   - a page's file is byte for byte what the package build writes for
     it;
   - rewriting a node unchanged makes none;
   - a raw write is caught by the full pass;
   - with the setting off, no repository exists.
3. **`graph/history` and `graph/restore`.** The actions, times, the
   reader list, read-your-writes. Tests:
   - a time between two commits reads the earlier one;
   - `log { run }` lists exactly that run's commits;
   - `log` of a renamed page reaches back past the rename;
   - a diff marks a renamed page, an extended type and a changed rule;
   - a namespace the caller cannot read is absent from `log`, `tree`
     and `diff`;
   - `restore` of an edited page puts back its text and parents, and
     commits.
4. **`ConceptDiff` in strut/views** (ruling 7): given two commits or
   times, the tree with its pages added, edited, moved, renamed and
   removed marked, and a page opening to its text diff; given a page,
   its history. The Knowledge app (`strut/knowledge`,
   `knowledge-app.md`, specs/API.md §14.13) uses it for a page's history
   and for the tree between two moments, with Restore once the app edits
   (it is read-only today). A benchmark's app imports it:
   openlaw-benchmarks' climb page would pass the start of one
   iteration's run and the next.

## Later (not this plan)

- **A frozen tree by name:** a tag on a commit, for an eval's baseline
  or a release.
- **Branches:** a candidate graph (a child Ladybug file) whose writes
  commit to a branch of its own. Applying it writes its files into the
  graph, or proposes them. This is what keeps a scored run's tree from
  moving under it, and where Concept and ontology evals start. Neo4j
  has no child file, so on a swarm a candidate graph needs another
  answer first.
- **A package from a commit:** a build that copies its Concepts and
  types from a commit instead of reading the live graph. The files are
  already package files (§2.1).

## Rulings

Evan, 2026-11-07:

1. **The graph stays the source and stays writable.** Agents make
   Concepts freely; git only records.
2. **A commit follows the write, never a timer.** An app's edit is in
   the history within seconds of the write.
3. **Every Concept and every graph type, in every namespace.** Off on
   desktop.
4. **Review is optional, and it is a strut proposal**, never a GitHub
   PR.
5. **Evals come later.** This plan builds the history they will stand
   on, and none of the evals.
6. **General over any shape of benchmark.** A loop, a separate
   analyzer, a sweep and a person's edits all use the same two reads:
   the tree at a moment, and what a run changed. The history knows runs
   and times, and nothing of loops, subflows or climbs.
7. **The diff view is a strut/views component**, so every benchmark's
   app draws the same one.

Evan, 2026-11-08:

8. **One page format.** The package format takes key-named pages with
   `name`, the attributes and `parents`, and the history is laid out
   like a package.
9. **No Jarvis.** Strut owns the ontology, and every edge has a rule
   (`ontology.md` ruling 1). Nothing here works around Jarvis.
10. **Concepts and the ontology only.** Instances, counts and the shape
    of ingested data are facts, the graph's to keep, and are not
    recorded.

## Open

- **A run's tree is the tree when it started.** A write during a long
  run changes what it reads later. `log { from, to }` over its start
  and end says so; nothing stops it until branches.
- **Two runs writing at once can commit out of time order.** A batch
  goes a second after its run's last write, at most five after its
  first, so another run's later write can be committed first. The tree
  at a moment inside that window can then hold a write from just after
  it, or miss one from just before. The window is at most five seconds.
- **Writes from outside a run are timed late.** The full pass commits
  them when it runs, so a time between the write and the pass misses
  them. A benchmark that needs them can `sync` before it starts.
- **A pass with a cause credits all it finds.** The pass after an app
  publish or a package install commits whatever differs, so a raw write
  made just before it is credited to the publish or install too.
- **A long writer makes many commits**, one every few seconds while it
  writes. `log { run }` groups them; nothing squashes them.
- **Reader lists and the repository.** Where `graphReaders` is set,
  both steps apply it, but the repository itself holds every namespace,
  as the graph's own file does: anything that can read `dataDir` can
  read it.
- **Edge rules' other fields.** The type grammar carries no `temporal`,
  `cardinality` or aliases yet (`graph-types.ts`), so a type's history
  misses them until it does.
