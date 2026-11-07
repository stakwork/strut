# Concept history: the Concept tree and the ontology, in git

> **Status (2026-11-07): proposed, five rulings in (Evan, the same day;
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
- A page's history, a diff, the whole tree at any commit, and a restore
  are one step, `graph/history`, which agents, apps and workflows call
  alike. The Knowledge app (`strut/knowledge`) shows a page's history
  with it.
- A tree at a commit is a frozen tree, at the cost of the pages that
  changed. That is what a Concept or ontology eval will stand on later.
  The evals are not in this plan (ruling 5).

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
- **Read-your-writes.** `graph/history` waits for the queue to empty
  before it reads, so a step sees its own writes.

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

## 4. Reading and restoring: `graph/history`

One lib step. Agents call it as a tool, apps through `step_run`,
workflows as a step. It is held to the caller's reader list
(`scope.ts`): a page in a namespace the caller cannot read is in none
of its answers.

| `action` | Input | Output |
| --- | --- | --- |
| `log` | a page (name or key), a type, or nothing for all; `limit` | commits, newest first: id, time, author, run, step, what changed |
| `show` | a page or a type, and a commit | the file at that commit, parsed |
| `diff` | a page, a type or nothing, and two commits | what changed between them |
| `tree` | a commit | every page's name, key and parents at that commit: the tree as it was |
| `restore` | a page and a commit | writes the page's attributes, `docs` and parents at that commit back through the node and edge writers, as the caller. That write is committed like any other |
| `sync` | nothing | runs the full pass |

`restore` is a write: an app needs the grant, an agent the step among
its tools. It never brings back a type, because the ontology is
add-only (`graph-types.ts`).

## 5. Review

Review is optional, and it is a strut proposal, never a GitHub PR
(ruling 4). Proposals already cover every graph and Concept write
(`proposals.md`). An agent that wants a person's yes proposes the
`graph/*` call instead of making it, and an accepted proposal's write
is committed like any other. This plan changes nothing about proposals.

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
3. **`graph/history`.** The six actions, the reader list,
   read-your-writes. Tests:
   - a namespace the caller cannot read is absent from `log`, `tree`
     and `diff`;
   - `restore` of an edited page puts back its text and parents, and
     commits.
4. **The Knowledge app shows a page's history** (`strut/knowledge`,
   `knowledge-app.md`, specs/API.md §14.13): the list and a diff now,
   and Restore once the app edits. It is read-only today.

## Later (not this plan)

- **A frozen tree by name:** a tag on a commit, for an eval's baseline
  or a release.
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

## Open

- **A sweep's commit count.** One commit per write step is a few hundred
  per sweep. If the history reads badly, a run's commits can be squashed
  into one at its end. Not before it does.
- **Reader lists and the repository.** Where `graphReaders` is set,
  `graph/history` applies it, but the repository itself holds every
  namespace, as the graph's own file does: anything that can read
  `dataDir` can read it.
- **Edge rules' other fields.** The type grammar carries no `temporal`,
  `cardinality` or aliases yet (`graph-types.ts`), so a type's history
  misses them until it does.
- **A rename** is a new key, so it reads as one page removed and another
  added, and `log` of the new name starts at the rename.
