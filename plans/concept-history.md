# History: the workspace as a package, in git

> **Status (2026-11-09): all four items built (strut#577, strut#579,
> strut#580); revert in the Knowledge app is not (Open). Thirteen
> rulings in (Evan, 2026-11-07 and 2026-11-08; "Rulings" below).** Written after a read of `main`
> @8db356c, revised on 2026-11-07 after a read of openlaw-1's climbs
> (§1), and rewritten on 2026-11-08: a snapshot is a package build, and
> the history tracks no write (ruling 11). Revised on 2026-11-09 after a
> read of the package code against two questions — can a package ship a
> kind under `Job`, and how are a package's Concepts chosen (§6.1): the
> reader takes a page under any file name (§2.1), the snapshot's writers
> carry everything (item 2), and `git` is checked without the macOS shim
> (§7). Companions: `marketplace.md`
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
- One diff view draws a past commit and a pending proposal alike. The
  two are never joined in storage: a proposal is the change before the
  write, a commit the change after it.
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
    image (`Dockerfile`), and the desktop package needs it on the
    machine (ruling 13).

## 2. What a snapshot holds

One bare repository per strut, `<dataDir>/history.git`, branch `main`,
its work tree inside it (`history.git/work/`, so it moves and is backed up
with the repository; any snapshot rebuilds it). Its tree is a package
directory (`marketplace.md` §1, `format.ts`):

```
strut.yaml                           the manifest: this workspace, and the installed packages it pins
workflows/<path>.yaml                every workflow's active version, as published
steps/<path>.ts                      every step's active version; `_` helpers; <path>.claims.yaml beside it
concepts/<key>.md                    every live Concept in the backend's own namespace (§2.1)
namespaces/<ns>/concepts/<key>.md    every live Concept in any other namespace (a Ladybug file has
                                     them too: `private` is its own, any other is made by writing into it)
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
- **The reader** (`format.ts`) tells the two forms apart by `name` in
  the front matter. A new-form page's IDENTITY is its `name`, under
  whatever file name it has (revised 2026-11-09; the first draft refused a
  file not named by its key): a source repository is written by hand —
  the lab's `job/concepts/Explore.md` — and nobody computes
  `concept-explore` to name a file. Two pages with one `name` are refused
  (`bad_package:`). The key-named file is what a BUILD and a snapshot
  write, so the record and the cache hold a page under one path and git
  stores it once; a source may hold it under another, and its digest
  differs, as a source's does anyway. The old form stays readable: strut's
  own pages (`src/concepts/`) and every package already published use it.
- **A parent the package does not own** — strut's `Job`, a required
  package's page — is named in `parents` like any other and found in the
  graph at install, as a top page's `parent` is today (§6.1).
- **A build** writes the new form, every parent included. A package
  rebuilt this way has a new digest, a new release like any other.
- **An install** (`seedConcepts`) writes the page's attributes and a
  `PARENT_OF` from each parent, found by name in the package or the
  graph as today. An attribute the installing graph's `Concept` does not
  declare is left out, with a warning naming it. `keepEdited` compares
  every attribute the file carries, not only `description` and `docs`.
- **So** a page means the same bytes wherever it lies — under its key in
  the history and the cache, under any name in a source — and the one
  decision to take before anything else is built is this one.

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
one-second debounce (five seconds at most after the first touch waiting,
as the view's flush), and an install or uninstall HOLDS the queue, so its
hundred writes make one commit under its own cause. A snapshot writes
every file whose bytes changed, stages everything, and commits when the
tree differs:

- authored by the actor who wrote (the run's, the person who published
  or installed; `strut` for boot and sync), email `history@strut.invalid`
  for every author, committer `strut`;
- its first line the cause (`run <id>`, `proposal <id>`, `publish
  acme/sync v3`, `activate acme/sync v2` for a rollback, `delete <name>`,
  `release <app> <version>`, `install acme/linear@sha256:…`, `uninstall
  acme/linear`, `boot`, `sync`); touches that land in one window list
  their other causes below it, and what an install published is its own;
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

### 6.1 Packages, kinds, and where a package's Concepts come from

Read on 2026-11-09 against two questions. Nothing in this plan changes
for either; two items belong to neighbours and are named here so they are
not lost.

- **A package may ship a kind under `Job`** — a `Legal Task` page, so
  the assistant routes legal work to the package's workflow and the job
  agent starts from its convention. The format carries it today: a page
  with `parent: Job` builds with no warning (strut's stamp is among the
  parents a build accepts, `conceptFiles`), the install finds `Job` in the
  graph and writes the `PARENT_OF` (`install.ts`'s parent check), strut's
  boot reseed leaves the edge alone (it removes only an undeclared edge
  between two pages it owns, `concept-seed.ts`), the orchestrator's
  `context/concept` on `Job` lists the kind on its next turn, and
  `job/start { kind }` puts the page at the head of the job's prompt
  (`job.yaml`'s `kindPage`). Under §2.1 it is `parents: [Job]`. No new
  mechanism: the kind's docs name the workflow, and the job agent runs it
  through `meta/run-workflow`, the door every kind uses. Three facts for
  a package's author, none this plan's:
  - **Docs are copied verbatim; workflows are renamed.** A build stamps a
    workflow's `name:` to `<package>/<path>` and leaves a Concept's docs as
    they are, and the `job` workflow runs under no package, so a kind page
    that says "run `legal-task`" names nothing after install. A source
    repository's author writes the full name; a build from a workspace
    breaks the page silently. `marketplace.md`'s item: rewrite workflow
    names in Concept docs as `name:` lines are rewritten, or warn.
    *Built 2026-11-09 (`marketplace.md`, step 2's notes): both — the
    build rewrites a carried workflow or step's name in a carried page's
    docs and description, and warns on one it neither carries nor
    requires.*
  - **Routing reads the description alone** (`docs: false`): a kind's one
    line is what the assistant routes by.
  - **A conversation's system prompt is its first turn's**, so an
    installed kind reaches new conversations only.
- **A package's Concepts are the ones NAMED** in the build (`concepts` on
  `POST /packages/build`, the Packages tab's picker), each with its whole
  subtree (`conceptFiles`) — or, since 2026-11-09, ALONE (`conceptsAlone`:
  a root the package's steps need, whose pages here are this strut's own). The roots the picked workflows'
  `context/concept` steps read are SUGGESTED, never taken
  (`src/packages/suggest.ts`): the literal names in those steps and the
  pages read in the last five successful runs, each climbed to a root the
  package could carry, offered on the package page as one click. A kind
  under `Job` is read by strut's `job` workflow, not the package's, so it
  is never suggested: the author picks it.
- **Nothing a builder reads names `context/concept` as the way a workflow
  gets its knowledge.** The rules in `src/ai/prompts.ts`, the `Workflow
  Builder` page and the `Job` page are silent; the builder finds the step
  through `list_steps` (its description says what it is for) or by reading
  a seed as an example. One sentence in the dialect rules closes it: an
  agent's domain knowledge comes from a Concept page through
  `context/concept` into its system prompt, never pasted into
  `params.system`. The text is pinned byte for byte by `prompts.test.ts`:
  a fixture update, and one cache miss for every live chat. Not this
  plan's PR.
  *Built 2026-11-09 (`src/ai/prompts.ts`, the Agent rules, which the
  builder job renders too): one line saying an agent's domain knowledge
  is a Concept page read by `context/concept` before it, its text at the
  end of the agent's system, and to grant `graph/graph-get` for the pages
  under it. The line names no `{{ params.… }}`: the builder job's rules
  sit inside `builder.yaml`'s `params.system`, where one would be
  resolved at load.*

## 7. Where it runs

- **On by default** wherever strut has a graph and `git`, the desktop
  package included (ruling 13): Peel needs `git` on the machine for the
  Knowledge app's history. `STRUT_HISTORY=0` turns it off
  (`createStrut({ history: false })`). Without `git` it is off, boot
  says so in one line, and `history/read` answers that there is no
  history, so the app's history view can say so too. On macOS
  `/usr/bin/git` is a shim that opens the Command Line Tools install
  dialog when they are missing, so the check there is `xcode-select -p`
  first, never `git --version` alone: a boot must not raise a system
  dialog.
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

1. **The page format** (§2.1). **BUILT 2026-11-09, strut#577.** The
   package reader takes both forms (a new-form page under any file name,
   its `name` its identity), a build writes the new one under the key, an
   install writes the attributes and every parent, `keepEdited` compares
   every attribute. Beyond this list, a package's page that a release
   moved to another file (the old form rebuilt under its key) is the same
   page, so a distro update across the two forms goes through. Tests:
   - a page with two parents and a `/` in its name goes through build
     and install with both parents and its attributes;
   - an old-form package installs as before;
   - a new-form page under a file name that is not its key installs by
     its `name`; two pages with one `name` are refused;
   - a page whose parent is strut's `Job` installs under it, and strut's
     next boot seed leaves the edge;
   - an attribute the installing graph does not declare is left out,
     with a warning.
2. **The history. BUILT 2026-11-09, strut#579** (`src/history.ts`,
   `packageFiles` in `src/packages/build.ts`). Decided in the build:
   the work tree is `history.git/work/`; the author email is
   `history@strut.invalid`; a commit is made with `commit-tree`, so no
   hook, signing or user config applies, and a snapshot whose files are
   unchanged spawns no git at all; a snapshot's types carry the
   ontology's RULES only — never the edges the graph holds, which a
   build's `exportTypes` adds and which are facts and a scan of every
   edge; the manifest is `strut/workspace` at version `snapshot`; reads
   are kept between snapshots by version label and content hash, so a
   quiet workspace costs three listings plus the Concept and type reads;
   createStrut awaits the boot snapshot, so a strut that answers has its
   boot commit.
   Measured on 300 Concepts of ~3 KB each (a test logs it): ~250–290 ms
   for the first snapshot, ~25 ms for one that changes nothing, ~90 ms
   for one page changed, on Ladybug and Neo4j alike. As planned:
   `packageFiles` factored out of `buildPackage` and
   given "everything" as a pick, in a WHOLE mode: `conceptFiles` refuses
   a page stamped by another seeder and a name with `/`, and `exportTypes`
   warns on an edge to a type left out — a build's rules, which a snapshot
   of this strut's whole graph must not apply (strut's own `Job` is the
   first page it meets); the repository; the queue; the view's flush as a
   touch, with `createNodeSchema` and `createEdgeSchema` wrapped (they are
   `graph.schemas`', not the node and edge writers `bindGraph` wraps
   today); the store and apps wrappers; boot; the setting; the `git`
   check (§7). Tests on both engines:
   - a page strut seeded and a page with `/` in its name are both in the
     snapshot;
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
3. **`history/read`. BUILT 2026-11-09, strut#579**
   (`src/steps/lib/history/read.ts`). A time is ISO 8601 or epoch
   milliseconds; `show` of `""` is the root's listing. Under a reader
   list, `concepts/` is hidden when the caller cannot read the backend's
   own namespace, a commit that changed only hidden paths is not in its
   log, and `namespaces/` is not listed when none in it is readable. The
   actions, times, the reader list, read-your-writes. Tests:
   - a time between two commits reads the earlier one;
   - `log { run }` lists exactly that run's commits;
   - `log { path }` of a renamed page reaches back past the rename;
   - `diff` lists a moved page as modified, a renamed one as renamed, a
     type's changed rule as modified, with `before` and `after` parsed;
   - a namespace the caller cannot read is absent from `log`, `show`
     and `diff`.
4. **`ConceptDiff` in strut/views** (rulings 7 and 12): one component
   over two states of the tree's pages, whatever produced them: a
   commit pair or a time pair from `history/read`; a PENDING PROPOSAL,
   its input laid over the current page (`proposal/get`); a person's
   unsaved edit. It draws the tree with its pages added, edited, moved,
   renamed and removed marked (moved and renamed read off `parents` and
   `name` in `before` and `after`), a page opening to its text diff;
   given a page, its history. The sources never meet in storage: a
   proposal is the change before the write, waiting for a yes, and a
   commit the change after it. The Knowledge app (`strut/knowledge`,
   `knowledge-app.md`) uses it three ways: a page's history and the
   tree between two moments, from the history; the pending proposals
   its Later item draws as green and red changes, from the proposals;
   and REVERT, which is `show` at a commit and a write with
   `graph/edit-node`, as a proposal when review is wanted, so no restore
   primitive is needed. Its "recent changes" reads the history, never
   the live change feed, which is a notification and empties on a
   restart. A benchmark's app imports the same component:
   openlaw-benchmarks' climb page would pass the start of one
   iteration's run and the next.
   **BUILT 2026-11-09, strut#580** (`kit/src/folds/concept-diff.ts`,
   `src/apps/views/src/components/ConceptDiff.tsx` + `lib/history.ts`,
   the Knowledge app's History and Changes). Decided in the build:
   - **The fold is the kit's**, pure, over ENTRIES in `history/read`'s
     `diff` shape (`{ path, from?, before?, after? }`, pages parsed), so
     the three sources are three small functions into one shape:
     `historyEntries`, `proposalEntry`, `editEntry`. A page's `status` is
     the first of everything it earned (`marks`: renamed, moved, edited,
     in that order), so a page renamed and moved at once says both.
   - **Pairing what git did not:** a removed and an added page with the
     SAME parents and prose (description and docs) alike by words — Dice
     over the word multisets ≥ 0.5, best pairs first, one to one — are one
     page renamed, marked `paired`. A page moved as well as renamed and
     rewritten over a range stays a delete and an add (its parents
     differ); in the commit that renamed it, it pairs. Both are tested.
   - **The tree** puts a page under each of its parents (a removed one
     under the ones it had, a moved one under its new ones; its detail
     strikes the old), and a parent the diff does not hold as a hollow
     context row, climbing through the caller's live tree (`parentsOf`)
     when given; cycle-safe. Children never show a parent's move: a page
     lists its parents, not its children (`history/read`'s notes).
   - **A page's file from its name**: `concept-` and the name's letters
     and digits, the node writer's key; past 200 characters its hash,
     through WebCrypto (`conceptPagePath`; null where there is none). The
     Knowledge app reads the backend's own namespace, so `concepts/`.
   - **A commit's change** to a page is the page after it against the
     page after the commit before it in the page's own log (one commit
     more is read than shown, so the oldest row draws too); "Recent
     changes" does the same over `concepts`.
   - **A proposal** changes a page only through the four steps:
     `graph/edit-node` without `node_type` (a `name` in `node_data` renames
     it and moves its file; `null` or `""` removes an attribute), a
     `graph/move-node` along `PARENT_OF` with `direction: reverse`, a
     `graph/create-node` of a Concept (no parents yet), a
     `graph/delete-node`. Anything else, `null`: "changes no Concept page".
     A person's edits in `decision.input` are laid over the input.
   - **The docs diff** is an LCS over lines, the common ends trimmed first;
     past 4M cells the middle is all deleted and added. No library: the
     kit's set has none.
   - **No revert.** `graphWriteRefusal` refuses every page write on a
     Concept (`reservedAppType`), first-party included, and a page cannot
     record a proposal. Left out; Open says what it would need.
   - **The Knowledge app's proposal view** is not wired: the component
     takes `proposal`, the app has no list (its Later item).

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
  answer first. *Built otherwise (2026-11-13):* `plans/concept-evals.md`
  items (b) and (c) — a Concept branch is a graph NAMESPACE holding a copy
  of the pages (both engines, no child file) and a git branch of its name
  in this repository, starting at main's commit, its commits holding main's
  tree with `concepts/` the branch's pages; `history/read` takes a branch's
  name and `branches` gives each one's fork point. Applying a branch
  (merge as proposals) is item (e) there.

## Rulings

Evan, 2026-11-07:

1. **The graph stays the source and stays writable.** Agents make
   Concepts freely; git only records.
2. **A commit follows the write, never a timer.** An app's edit is in
   the history within seconds of the write.
3. **Every Concept and every graph type, in every namespace.** Off on
   desktop (revised by ruling 13: on wherever `git` is, desktop
   included).
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
12. **One diff view, two sources.** Proposals and the history stay apart
    in storage: a proposal is generic over any step, and git fits files.
    They meet in the view alone, which draws a pending proposal and a
    past commit the same way. Revert in the Knowledge app is a read and
    an edit, as a proposal when review is wanted; there is no restore
    primitive.
13. **The history runs on desktop too.** Peel needs `git` installed for
    the Knowledge app's history, and that is accepted. A strut with no
    `git` runs without a history and says so.

## Open

- **Revert in the Knowledge app** (ruling 12, item 4) is not built: the
  app door refuses a page's write on a Concept (`graphWriteRefusal` →
  `reservedAppType`: agents read Concepts as instructions), whoever the
  page is, and nothing lets a page record a proposal — proposals are made
  only by an agent's gated tool call. Either door would do: (a) an
  exception in `src/apps/tools.ts` for a FIRST-PARTY page (`app.firstParty`)
  with a signed-in viewer, `graph/edit-node` by `ref_id` + `node_data`
  only, on a Concept, the fields a page holds (`name`, `description`,
  `docs`, the other declared attributes), with a decision on whether
  members or only admins may — the Knowledge plan's Editing item asks the
  same; or (b) a first-party page's door to RECORD a proposal (the step
  and its input, the viewer as proposer), so the write waits for a yes.
  Then revert is `show { path, at }`, the page's fields as `node_data`,
  and a parent restored by `graph/move-node`; a removed page comes back
  through `graph/create-node`, its ref_id new.

- **A run's tree is the tree when it started.** A write during a long
  run changes what it reads later. `log { from, to }` over its start
  and end says so; nothing stops it until branches.
- **Runs that write at once share a commit.** A commit carries a `Run:`
  for each run whose flush touched since the last one, so `log { run }`
  for either may include the other's writes. The climb loop is
  sequential and never meets this; a swarm's sweeps will. The window
  is the view's flush (one to five seconds) plus the queue's second.
  The history is versioning, not provenance: which run wrote which node
  is the run log's to say, exact wherever a step marks its writes with
  `withAccessedNodes`. The one gap is a custom step that writes the
  graph without the marker; if an eval ever needs it closed, the write
  view, which hears every write, can record each flush on the run's
  own log. Not this plan.
- **Writes outside a run are timed at the next touch.** A raw write
  (`services.graph.query`, another process) is committed with the next
  snapshot, under that snapshot's cause. A benchmark that needs them can
  `sync` before it starts.
- **Reader lists and the repository.** Where `graphReaders` is set, the
  step applies it, but the repository itself holds every namespace, as
  the graph's own file does: anything that can read `dataDir` can read
  it.
- **A reader list's `exclude_domains`** hides no file: the step applies
  namespaces only, so a page or a type of an excluded domain is read.
- **A commit is not yet a package `readPackage` takes**: it refuses the
  `namespaces/` folder, as a package from a newer strut. An install from a
  commit (Later) decides what that folder means there.
- **`settle` during an install** runs the queue though the install holds
  it, so a step that reads the history while an install runs may commit
  part of it, under `sync`. No step does today.
- **Edge rules' other fields.** The type grammar carries no `temporal`,
  `cardinality` or aliases yet (`graph-types.ts`), so a type's history
  misses them until it does.
- **The manifest's `requires` and a commit's installed files** both say
  what a package brought. An install from a commit (Later) decides which
  it takes; the record keeps both.
