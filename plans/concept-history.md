# History: the workspace as a package, in git

> **Status (2026-11-08): proposed, eleven rulings in (Evan, 2026-11-07
> and 2026-11-08; "Rulings" below).** Written after a read of `main`
> @8db356c, revised on 2026-11-07 after a read of openlaw-1's climbs
> (§1), and rewritten on 2026-11-08: a snapshot is a package build, and
> the history tracks no write (ruling 11). Companions: `marketplace.md`
> (the package format, the `git+` source, export), `package-examples.md`
> (runs copied into a package; §6 here says where the two meet),
> `concept-tree.md` (what the tree holds), `knowledge-app.md` (the app
> that draws it), `live-feeds.md` (the writes this plan hears),
> `proposals.md` (review), `ontology.md` (strut's own ontology),
> `graph-temporal.md` (time for facts, which this plan leaves alone).

## In brief

- A **snapshot** of the workspace is a package build of everything in
  it: Concepts, graph types, workflows, steps, apps' sources. The
  **history** is that directory in a git repository on the box, one
  commit each time strut hears a write, the run that wrote named on the
  commit.
- The history knows nothing of Concepts. It knows what the package
  format lists (`src/packages/format.ts`). When the format gains a
  folder, the history records it with no change here.
- The graph stays the source and stays writable. Agents, apps, workflows
  and people write as they do now. Git only records: nothing reads it to
  serve the graph.
- Two reads serve any benchmark, whatever its shape: **the tree at a
  moment**, and **what a run changed**. They are read with git's own
  shapes: log, show, diff. The tree a run read is the tree when it
  started.
- One layout, three homes: a package's own repository is its **source**,
  the history is a strut's **record**, the package cache holds
  **installs**. A commit is a package; a package is a commit.
- A run is its own record and is never in the history. A package may
  carry runs as **examples** (`package-examples.md`).
- No restore step. A page is put back by reading it and writing it with
  the tools every caller has; later, a whole commit is installed as a
  package.
- The evals themselves are not in this plan (ruling 5).

## 1. Why

- Concepts change all the time, and every writer is an AI at some
  level: the sweeps, the job agents, the assistant, a person's edit
  through an app. None of it can be rebuilt by running a recipe again,
  so a tree that is overwritten is gone.
- The ontology changes the same way. It is strut's alone (no Jarvis,
  ruling 9) and grows at runtime: an agent registers a type with
  `graph/create-schema`; `create-triplet` and `create-batch-triplet` add
  an edge rule on their own when a write fits none; an app's publish and
  a package's install register theirs; a type's rules change, not only
  its attributes. Two agents that each add a type for the same thing is
  how an ontology sprawls. The history is where that shows.
- Workflows and steps are learned from too: a builder reads a published
  workflow as an example, and a step's code is what a later step copies.
  They have strut's own versions, which pin what a run executes, but no
  one place says what the whole workspace held at a moment.
- **What a benchmark needs.** openlaw-1's climbs are the first:
  `openlaw-climb` runs a Harvey task, `openlaw-improve` writes Law and
  Firm Concepts from the criteria that failed, and the task runs again.
  Other shapes will follow: an analyzer workflow on a schedule, a sweep,
  a person's edits. Every one comes down to runs scored on tree X,
  something changing the tree, and runs scored on tree Y. So whatever
  the shape, a benchmark asks two things: the tree at a moment, and what
  a given run changed. Today the climb's page lists only the names of
  the Concepts it wrote, and `openlaw-improve` keeps its own backup file
  of the pages it amends.
- **Considered and not taken:**
  - **Tracking each write** (this plan's first draft): hear each write,
    work out which files it touches, a rename through a `ref_id` → key
    index, the children whose `parents` line moved. All of it so a
    commit touches only the right files. Git computes that from two
    whole trees, so the tracking is not needed, and it was where every
    Concept-specific rule lived.
  - **History in the graph**: a revision per node's text, read with
    `as_of`. Two engines to change, and still no branches.
  - **Git as the source**, the graph read-only and built from it. Every
    writer would change, and an agent could no longer just make a
    Concept (ruling 1).
  - **A record per run of the tree it read.** Every app read is a run,
    so that is a record by the thousand, and a run's start time finds
    the same commit with nothing written.
  - **The graph's shape**: counts per type, how often each attribute is
    filled. What the graph holds is facts about instances, the graph's
    to keep (ruling 10).
  - **The apps' object store** (`src/apps/objects.ts`): a file once by
    sha256 and a tree per version, a small git strut already has, with
    no binary to depend on. Git is kept for what comes free with it:
    log, diff, rename detection, tags, branches, and that anyone can
    clone the result and read it with ordinary tools. `git` is in the
    image (`Dockerfile`); the desktop package turns the history off
    (ruling 3).

## 2. What a snapshot holds

One bare repository per strut, `<dataDir>/history.git`, branch `main`.
Its tree is a package directory (`marketplace.md` §1, `format.ts`):

```
strut.yaml                           the manifest: this workspace, and the installed packages it pins
workflows/<path>.yaml                every workflow's active version, as published
steps/<path>.ts                      every step's active version; `_` helpers; <path>.claims.yaml beside it
concepts/<key>.md                    every live Concept in the backend's own namespace (§2.1)
namespaces/<ns>/concepts/<key>.md    every live Concept in any other namespace
graph/<Type>.yaml                    every type in the ontology, the Strut types excepted
apps/<name>/                         every app's active version, its sources; never dist/
```

- **The rule.** The history records what the package format can carry.
  Nothing here says what a Concept, a type or an app is: the writers
  `buildPackage` already has write the files (`conceptFiles`,
  `exportTypes`, the workflow and step copies, an app's tree), and a
  snapshot is those writers over the whole workspace instead of a pick.
  The one shared function is `packageFiles(deps, picks)` → the files; a
  build passes its picks, a snapshot passes everything (§8 item 2).
- **Installed items are in it.** A package installed here is part of
  the workspace, and a fork of one of its items is a local change. Its
  files are byte for byte what the package built (the same writers), so
  git stores each once. The manifest's `requires.packages` lists every
  installed package at its digest, so a commit also says where its
  items came from.
- **Deployment facts stay out**, since the format does not carry them: a
  workflow's owner, category, cost cap, schedules and publisher stamp,
  the active pointer itself (the snapshot writes the active version's
  text; a rollback is a changed file), an app's live release.
- **A deleted item** is a file removed. A restored one comes back.
- **The same node writes the same bytes**, so a write that changes
  nothing makes no commit, and a rename is a file removed and a file
  added that git's rename detection pairs by content. No index, no
  trailer.
- **Not recorded** (ruling 10): instances of any type but Concept and
  their counts; edges other than `PARENT_OF`, such as a PR's `TOUCHES`
  (facts, the graph's to keep with its own clocks); the Strut types,
  which are code; vectors; apps' built output. Runs, chats, sessions,
  jobs, artifacts, proposals: a run is its own record, append-only, and
  §6 says how one travels. Secrets, peers, brand, the public view: a
  deployment's, never in a package.
- In one line: **code and knowledge, never what happened, never who may
  do what, never a credential.**

### 2.1 One page format, with packages

- **Today** a package's page is `concepts/<Name>.md`: front matter
  `description` and one `parent`, the body `docs`. A build keeps the
  first parent by name and no other attribute (`conceptFiles`,
  `build.ts`), and a name with `/` cannot be a file, so the concept
  tree's repository pages (`owner/repo`) cannot travel.
- **The format takes a key-named page** (ruling 8): `concepts/<key>.md`,
  the file named by the node key (`concept-ownerrepo`; the writer makes
  a key lowercase alphanumerics and dashes, `composeNodeKey`), front
  matter `name`, then every attribute the node holds except `docs` and
  what the graph or a seeder stamps or derives (`ref_id`, `key`,
  `namespace`, `search_text`, `title`, the vectors, `created_at`,
  `updated_at`, `created_by`, `unique_source_id`), then `parents`: the
  names of every live `PARENT_OF` parent, sorted. The body is `docs`.
  Names in `parents`, not keys: they are what a person reads, and the
  key follows from the name.
- The reader (`format.ts`) tells the two forms apart by `name` in the
  front matter, and refuses a page whose file name is not its key
  (`bad_package:`). The old form stays readable: strut's own pages
  (`src/concepts/`) and every package already published use it.
- **A build** writes the new form, every parent included. A package
  rebuilt this way has a new digest, a new release like any other.
- **An install** (`seedConcepts`) writes the page's attributes and a
  `PARENT_OF` from each parent, found by name in the package or the
  graph as today. An attribute the installing graph's `Concept` does not
  declare is left out, with a warning naming it. `keepEdited` compares
  every attribute the file carries, not only `description` and `docs`.
- **So** a page means the same bytes in a source repository, in the
  history and in the cache, and the one decision to take before anything
  else is built is this one.

## 3. When

**On every write strut hears**, through what already hears it:

- **The graph.** The runner hands every run a view of `services.graph`
  whose writers report each write (`bindGraph`, `graph-writes.ts`;
  `live-feeds.md` §2), gathered and sent a second after the last one and
  at most five after the first; an accepted proposal's apply gets the
  same view (`proposals.ts`). The history is one more receiver of the
  same flush: it is told "run R flushed" (or "proposal P"), and nothing
  of the batch's contents. So every write made through the view is
  heard, whatever made it: a `graph/*` step, a workspace or package step
  that writes `ctx.services.graph` itself, an agent's tool call, an
  app's `step_run`, an accepted proposal. Nothing depends on what a step
  declares. A type written through the backend's `schemaSource`
  (`createNodeSchema`) and an edge rule through `createEdgeSchema`
  (which `create-triplet` calls itself when a write fits no rule) are
  heard the same way: the view wraps both, as it wraps the node and edge
  writers. The view is bound whenever the history is on.
- **The stores.** The workspace store and the apps service the server
  builds are wrapped once in `createStrut`: every method that changes
  what a snapshot writes (a publish, a rollback of the active version, a
  delete, an app's publish or live release) touches the history after
  it. A package install, a seed at boot and the builder's `meta/*` twins
  all go through them, so none is a call site of its own.
- **Boot**, once, after the seeds; and **`sync`** (§4).

**A touch becomes a snapshot.** Touches go on one in-process queue with a
one-second debounce, so an install's hundred writes make one commit. A
snapshot writes every file, stages everything, and commits when anything
differs:

- authored by the actor who wrote (the run's, the person who published
  or installed; `strut` for boot and sync);
- its first line the cause (`run <id>`, `proposal <id>`, `publish
  acme/sync v3`, `install acme/linear@sha256:…`, `boot`, `sync`);
- one trailer, **`Run:`**, for each run whose flush touched since the
  last commit. A subflow shares its root run's id, so a climb's improve
  step is the climb's run. No step: the run's log already says which
  step wrote what and why (`run/provenance` reads it). Git answers
  "which run", the run log "which step, and why";
- the commit's date is the snapshot's time, in whole seconds. No other
  time field.

**It never holds a run up.** A snapshot that fails is logged and never
fails the run; the next touch catches up, since every snapshot is whole.
**Read-your-writes:** `history/read` flushes the pending views and waits
for the queue to empty before it reads, so a step sees its own run's
writes.

## 4. Reading: `history/read`

One lib step, `effect: "read"`, so an app's grant, an agent's tool list
and an `approve:` list each name one thing that only looks. Agents call
it as a tool, apps through `step_run`, workflows as a step. It is held
to the caller's reader list (`scope.ts`): a namespace folder the caller
cannot read is in none of its answers.

**Wherever a commit is asked for, a time does too.** A time means the
last commit at or before it (`git log -1 --before`). A benchmark passes
a run's start time to get the tree that run read.

| `action` | Input | Output |
| --- | --- | --- |
| `log` | optional `path` (a file or a folder), `run`, `from`, `to`; `limit` | commits, newest first: id, time, author, first line, `runs`, and each changed path with its status (`added`, `modified`, `deleted`, `renamed` with `from`) |
| `show` | `path` and `at` (a commit or time) | the file then: `text`, and `parsed` where the package reader parses it (a page's front matter and docs, a type's rules); a folder: its listing |
| `diff` | `from`, `to` (commits or times), optional `path` | one entry per path that differs: status, and `before` / `after` as `show` gives them; `patch: true` adds the unified diff |
| `sync` | nothing | a snapshot now, cause `sync`; writes nothing in the graph |

- `log { run }` is what that run changed. `log { from, to }` is who
  changed the workspace between two moments, such as a scored run's
  start and end: whether the tree moved while it ran. `log { path }` of
  a page follows it back through renames (`--follow`).
- The output is paths and statuses, the package layout's, whatever the
  file: a page, a type, a workflow, a step. What a diff MEANS for a
  Concept (moved under another parent, renamed) is the view's to say
  (§8 item 4), never the step's.
- **No `restore`.** A page's text and parents at a commit come back from
  `show`, and every caller that may write a Concept already has the step
  to write it with. A whole commit comes back later as a package install
  (Later).

## 5. One layout, three homes

The package directory means the same thing wherever it lies:

| Home | Where | Role |
| --- | --- | --- |
| **source** | a package's own git repository, on GitHub or anywhere; `strut.yaml` at its root, or in a folder a `#<path>` names | what a publisher edits and others install (`marketplace.md` §5, the `git+` source, work item 3 there) |
| **record** | `<dataDir>/history.git` | what this strut held, when, and which run changed it |
| **cache** | `<dataDir>/packages/sha256-<hex>/` | a package as installed, by digest (built) |

- **Export is a copy.** A package from a commit is `git archive` of the
  commit filtered to the picks' closure, with the manifest written for
  the picks; publishing it to a package repository is pushing that tree.
  The marketplace plan's "export as a PR" becomes pushing a directory.
  The secret scan `package-examples.md` §4 describes belongs here, at
  the export, once: the record itself lies beside the graph under
  `dataDir` and adds no exposure.
- **A repository is a publisher.** A tag's archive is an archive URL
  like any other (`fetchArchive` checks the digest over the unpacked
  tree, so how the host gzips is irrelevant; a forge's tarball has one
  top folder to strip), so a repository plus a signed catalog card is a
  complete publisher with no server of its own. The lab's seed folders
  in stakgraph are already laid out this way (`explore/workflows`,
  `explore/steps`, `job/concepts`); a manifest beside them makes the
  folder a package the swarms install and follow (`marketplace.md`
  §12). What a package cannot carry, and should not: a service (the
  pod-manager stays a service its steps call over HTTP with a declared
  secret) and the host's delta (`createStrut({ job: { tools, system } })`).
- **The index** lists, describes and links to install; it builds and
  hosts nothing. A "try it" on the store is a package installed with its
  examples (§6) on a demo strut, nothing run, its app served as a
  visitor's page (`public-surface.md` §5): the app's pages read the
  example runs. Made from install, examples and the public surface,
  nothing new.

## 6. Beside package examples

`package-examples.md` gives a package an `examples/` folder: finished
runs copied in (log, summary, files) with the graph data each wrote
(`graph.jsonl`, nodes by type and key). The two plans divide a package
in two:

| Half | Folders | Changes? | Recorded by |
| --- | --- | --- | --- |
| what it **teaches** | `concepts/`, `graph/`, `workflows/`, `steps/`, `apps/` | yes: a loop edits it, a benchmark compares it | the history, every commit |
| what it **shows** | `examples/` | no: a run is append-only | the run store; copied into a package at export |

- **A run is never in the history.** It cannot change, so there is
  nothing to record; the run store keeps it, and an export copies the
  runs picked. The graph data an example carries is the slice that run
  wrote, part of its record, and travels with it. The history records
  no instances (ruling 10). A Concept page is one type's instances
  rendered as markdown; should the format ever gain a folder of curated
  instances of other types, in `graph.jsonl`'s node record, the history
  records it by the rule in §2 and this plan does not change.
- **An eval's baseline is a package.** A tag on a commit names tree X;
  an export from that commit with the runs scored on X as its examples
  is tree X and its evidence in one archive, installable on any box,
  nothing spent. The examples plan's version check (§4 there: an example
  is a run of the version packed) is met by construction when the
  package is built from a commit and the runs picked executed that
  commit's versions.
- **Shared code**, once: `packageFiles` (§2) for both the build and the
  snapshot; the secret scan at export. The examples' install writes
  through the run store and the graph writers; the history's v1 installs
  nothing, so the two touch the install at different points.
- **Order.** Neither blocks the other. The page format (§8 item 1) comes
  first, since every page in a source, a record and a cache must be the
  same bytes. The examples plan's items 1 and 2 (`effect` on every graph
  step, `origin: "example"`) are independent and small. Whichever of
  the history's item 2 and the examples' item 3 lands first factors
  `packageFiles` out of `buildPackage`; the other uses it.

## 7. Where it runs

- **On by default** wherever strut has a graph and `git`.
  `STRUT_HISTORY=0` turns it off (`createStrut({ history: false })`).
  The desktop package sets it off (ruling 3). Without `git` it is off,
  and boot says so in one line.
- **What it covers:** every Concept in every namespace, every type,
  every workflow, step and app (ruling 3, widened by ruling 11).
- **Backups:** the repository lives under `dataDir`, so a box's backup
  carries it, and a restore brings the history back with the graph it
  describes.
- **Size:** text, and only what changed. swarm38 holds about 500
  Concepts, each rendered at up to 6k chars, and a few hundred workflows
  and steps: a snapshot is a few megabytes and one query per kind, taken
  at most once a second. Git stores an unchanged file once. A graph with
  tens of thousands of Concepts would page the dump; none has.

## 8. Work items (one PR each, in this order)

1. **The page format** (§2.1). The package reader takes both forms, a
   build writes the new one, an install writes the attributes and every
   parent, `keepEdited` compares every attribute. Tests:
   - a page with two parents and a `/` in its name goes through build
     and install with both parents and its attributes;
   - an old-form package installs as before;
   - a page whose file name is not its key is refused;
   - an attribute the installing graph does not declare is left out,
     with a warning.
2. **The history.** `packageFiles` factored out of `buildPackage` and
   given "everything" as a pick; the repository; the queue; the view's
   flush as a touch, with `createNodeSchema` and `createEdgeSchema`
   wrapped; the store and apps wrappers; boot; the setting. Tests on
   both engines:
   - creating, editing, reparenting and deleting a Concept in a run each
     make one commit with the right file and `Run:`;
   - renaming a page shows in `git log --follow` as a rename;
   - the same through a workspace step that writes `ctx.services.graph`
     itself, and through an accepted proposal (`proposal <id>`);
   - `graph/create-schema` in a run makes one commit, and so does
     `create-triplet` when it adds an edge rule; a type whose `key_spec`
     changes makes one commit with the changed line;
   - a workflow publish, a step publish, a rollback and an app publish
     each make one commit naming the cause; an install makes one;
   - a page's file is byte for byte what the package build writes;
   - rewriting a node unchanged makes none;
   - a raw write is caught at the next touch, or by `sync`;
   - with the setting off, no repository exists.
3. **`history/read`.** The actions, times, the reader list,
   read-your-writes. Tests:
   - a time between two commits reads the earlier one;
   - `log { run }` lists exactly that run's commits;
   - `log { path }` of a renamed page reaches back past the rename;
   - `diff` lists a moved page as modified, a renamed one as renamed, a
     type's changed rule as modified, with `before` and `after` parsed;
   - a namespace the caller cannot read is absent from `log`, `show`
     and `diff`.
4. **`ConceptDiff` in strut/views** (ruling 7): given two commits or
   times, the tree with its pages added, edited, moved, renamed and
   removed marked (moved and renamed read off `parents` and `name` in
   `before` and `after`), a page opening to its text diff; given a
   page, its history. The Knowledge app (`strut/knowledge`,
   `knowledge-app.md`) uses it for a page's history and for the tree
   between two moments. A benchmark's app imports it:
   openlaw-benchmarks' climb page would pass the start of one
   iteration's run and the next.

## Later (not this plan)

- **A frozen tree by name:** a tag on a commit, for an eval's baseline
  or a release.
- **A commit installed:** `package/install` of a commit's archive, the
  whole or a path's worth: Concepts through the seeder, types add-only,
  workflows as versions. This is restore. How the installed packages a
  commit pins and the files it holds for them meet is decided then.
- **A package exported from a commit** (§5), and the `git+` source,
  which are the marketplace plan's work item 3.
- **Branches:** a candidate graph (a child Ladybug file) whose snapshots
  commit to a branch of its own. Applying it writes its files into the
  graph, or proposes them. This is what keeps a scored run's tree from
  moving under it, and where Concept and ontology evals start. Neo4j
  has no child file, so on a swarm a candidate graph needs another
  answer first.

## Rulings

Evan, 2026-11-07:

1. **The graph stays the source and stays writable.** Agents make
   Concepts freely; git only records.
2. **A commit follows the write, never a timer.** An app's edit is in
   the history within seconds of the write.
3. **Every Concept and every graph type, in every namespace.** Off on
   desktop.
4. **Review is optional, and it is a strut proposal**, never a GitHub
   PR. Proposals already cover every graph and Concept write
   (`proposals.md`); an accepted one's write is heard like any other.
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
10. **Concepts and the ontology only**, of the graph. Instances, counts
    and the shape of ingested data are facts, the graph's to keep, and
    are not recorded.
11. **A snapshot is a package build, and the history tracks no write.**
    What the package format carries is what the history records,
    workflows, steps and apps included; git computes what changed. A
    run is its own record and is never in it.

## Open

- **A run's tree is the tree when it started.** A write during a long
  run changes what it reads later. `log { from, to }` over its start
  and end says so; nothing stops it until branches.
- **Runs that write at once share a commit.** A commit carries a `Run:`
  for each run whose flush touched since the last one, so `log { run }`
  for either may include the other's writes. The climb loop is
  sequential and never meets this; a swarm's sweeps will. The window
  is the view's flush (one to five seconds) plus the queue's second.
- **Writes outside a run are timed at the next touch.** A raw write
  (`services.graph.query`, another process) is committed with the next
  snapshot, under that snapshot's cause. A benchmark that needs them can
  `sync` before it starts.
- **Reader lists and the repository.** Where `graphReaders` is set, the
  step applies it, but the repository itself holds every namespace, as
  the graph's own file does: anything that can read `dataDir` can read
  it.
- **Edge rules' other fields.** The type grammar carries no `temporal`,
  `cardinality` or aliases yet (`graph-types.ts`), so a type's history
  misses them until it does.
- **The manifest's `requires` and a commit's installed files** both say
  what a package brought. An install from a commit (Later) decides which
  it takes; the record keeps both.
