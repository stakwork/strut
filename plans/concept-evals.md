# Concept evals — trying a change to the Concept tree safely

> **Status (2026-11-13):** the primitives below were ruled by Evan on
> 2026-11-12; Paul's remarks reached the conversation through Evan, and the
> discussion with Paul and Tom is ongoing. Work item (a) is built (this
> file's first PR, #669), item (b) is built (#677), item (c) is built
> (#683), and the dream is automatic by default ("Automatic by default",
> below). The rest are not started. Everything marked
> *mine* was chosen by the session that built it, not ruled; it is open to
> a ruling. Companions: `claims.md` (claims, checks, evidence),
> `job-claims.md`, `concept-history.md` (the history in git), and
> `docs/knowledge.md` ("A CONCEPT is the fourth subject kind", "The dream").

## Why

The Concept tree is the guidance strut's agents read. To change it safely
it has to be measured: try a change, run the whole flow again, compare. The
same eval has been built several times over, Evan notes (the openlaw
climb, harvey's judge and disputer). The first thing he
wants measured is the orchestrator's mastery over the agents doing the
jobs: did it read between the lines, ask the big-picture questions, and
leave no stubs or loose ends. Whatever is built must not name a kind of
task: "The type of task shouldn't matter at all" — a code change, a legal
document with a .docx deliverable, or anything.

## The rulings (Evan, 2026-11-12)

1. **Claims are sentences on Concepts; rubrics are claims.** Generic on
   what they measure: claims "could be anything really", and "we'll change
   it up a lot". Nothing in the mechanism may name a kind of task.
2. **A branch is a git branch in the history plus a graph namespace
   holding the same pages.** "a 'git branch plus a graph namespace' is a
   great approach."
3. **A run on a branch redirects Concepts only** ("Concepts only"); the
   rest of the graph stays live.
4. **Claims are shared across branches** ("Shared"): the claims are the
   measure, the pages are the candidate.
5. **A check is handed the whole work under one root run** ("Yes, whole
   work"), judged once, when the work is done (ruling 9).
6. **Types: pages only for now.** "Pages only for now, but we will do the
   type list later": a per-branch list of which types a run is shown is
   decided, and deferred.
7. **The dream gets a `Dream` Concept**, with a child page per kind of
   source.
8. **Merge: the branch's diff becomes proposals on main** that a person
   accepts ("yes i agree").
9. **Live work is everything one person's message set off**: the turn, the
   jobs it started, the turns that report on those jobs, and on. It is done
   when all of it has finished. "Done" belongs to the work, never a stop
   condition on a claim; a judge that finds a rule is not about what it
   sees gives no verdict.
10. **`branch` is a launch-level field beside `job`**: recorded on
    `run.start`, inherited by every run it starts and never changed by
    them, never in `input`, set by whoever launches the root. A
    conversation stays on the branch its first turn ran on; a branch does
    not cross to another strut.

## Automatic by default (Evan, 2026-11-13)

Said on #677: "This whole project is analogous to Claude Code memory
system... in practice no one should need to review, it should be
automatic. The review there is there for us at the beginning to deeply
understand what got updated and why. The branches are there for us to be
able to run sophisticated evals on our own Dream cycle or on other
knowledge work (like the legal concept tree)."

- **The dream updates the tree by itself** in normal use. Review (a person
  accepting each change as a proposal, as `params.approve` gates the
  dream's edits today) is a mode to turn on, not the design: for us now,
  to learn what changed and why, and for anyone who wants it.
- **Branches are for evals**: trying a change to the dream itself, or to a
  tree like the legal one, and measuring it against main. Ruling 8's merge
  may then be automatic too, not only a person's yes.
- **What follows for (d):** a branch refuses claims and evidence today
  (item b), and the dream writes both as it goes, so the dream cannot yet
  be evaluated on a branch end to end. (d) lifts that first.
- **Everyday dreaming writes main** (ruled the same day: "Main, with
  history"). What a cycle changed, and why, is read from the history: its
  commits carry the run (`Run:` trailer), and the run leads to the
  conversations it read. No branch per cycle: no nightly copy of the tree,
  no merge.

### What was built (the dream made automatic)

- **Automatic by default.** The dream's page changes land as it makes
  them: `graph/edit-node` and `graph/create-triplet` run at once, through
  the run's graph view, so the history's commit for them is `run <id>`
  with a `Run:` trailer naming the dream's run. **Review is a switch per
  tree**: the dream's input `review` (default `false`), set on that tree's
  automation, puts the two tools back under the agent's `approve:` exactly
  as before (`approve: "{{ input.review ? params.review : params.none }}"`).
  *Mine:* the switch is an input, not a param, since each tree is its own
  automation and an automation sets input.
- **The words hold in both modes.** The `Dream` page's third thing is THE
  CHANGE: "Make the smallest change … and make it now. Where a person
  reviews this tree, the tool answers that it waits for their yes: leave it
  to them." The prompt's tool line says the same, and the gated tool's own
  description (`GATE_NOTE`) says it waits only where review is on. The
  answer's `proposed` is now `change`; `review` is on the answer too. The
  other rules on the page are unchanged.
- **What a cycle changed, and why** (the Knowledge app). `knowledge/cycles`
  (a read step beside `knowledge/claims`, over a new `cycles()` on the
  Knowledge door) folds the dream's recent runs that read something: when,
  the tree, `review`, turns, the lessons (said, claim, change), `stuck`, an
  error. *Mine:* it answers ONE caller, strut's own page shown to an admin
  in the page's own call — the viewer who sees the dream's proposals
  (`pageSees`) — and refuses a workflow, an agent's tool, a run a page
  launched and a member's page; it is not `sealed`, since a sealed step is
  refused to every app. The app's **Learned** (over the graph, shown only
  when that read answers) lists the cycles; each opens to the diff of the
  commits carrying its run (`history/read log { run }`, drawn by
  `ConceptDiff`), and says so where the history is off. A Concept's card
  lists the cycles about it: a lesson's claim on it, or a run named on its
  own history. The waiting queue is as it was, for a tree under review.
- **At upgrade.** A deployment whose dream automation is already on keeps
  its input (an automation's input is never touched at boot), which names
  no `review`, so its next cycle is automatic. To keep reviewing, set
  `review: true` on that automation's input. *Mine:* no migration. The
  dream's proposals still pending stay pending, listed and decided in the
  Knowledge app as before; an accept applies them as it always did.
- **Not built.** Undo (Evan's open decision, plans/concept-history.md,
  "Open: Revert in the Knowledge app"); a cap on changes per cycle (today
  nothing caps them but the agent's 60 model steps, each of which may carry
  several tool calls, and the lessons found: at most 60 turns read, 10
  claims written); a rule about whose words count (`dream/turns` reads
  every person's conversations on the server, so with review off anyone
  the assistant talks to can change that tree). Neither is ruled. Under
  review, the run itself changes nothing, and what a person accepts is its
  own `proposal <id>` commit, which names no run: the cycle view shows that
  cycle's lessons and says its changes waited.
- **Checked with a real model** (Sonnet 5.5, a scratch strut on a Ladybug
  file, `concepts: { personal: true }`): two assistant turns, the second a
  correction ("Too formal … Notes to my team are casual and three lines at
  most, from now on"). The dream, automatic, wrote the claim on `Personal`,
  recorded the person's words, and added a page `Team notes` under the
  root ("Open when writing any note, message or announcement to the
  person's team"), the root's own text untouched; no proposal; one commit,
  `run <id>`, adding `concepts/concept-teamnotes.md`; $0.04. The app's
  Learned view showed the cycle, its lesson and that diff to an admin, and
  the `Team notes` card listed it; a member's page showed no Learned.

## Build order

Ruled: checks first. One PR each, against main.

| Item | What | Status |
|---|---|---|
| a | Whole-work checks on main (rulings 5, 9) | built (this PR) |
| b | A branch you can create, run on and drop (2, 3, 10) | built (below) |
| c | The branch recorded in git (2) | built (below) |
| d | Claims following a page onto a branch, and a compare read (4) | not started |
| e | Merge as proposals (8) | not started |
| — | The `Dream` Concept (7) | another session, in parallel |
| — | The type list (6) | deferred |

## (a) What was built

**The work** (`src/work.ts`). A root run and every run it caused. One run
causes another three ways, each already on the caused run's `run.start`:
`parentRunId` (a child its parent waited on, `meta/run-workflow`),
`startedBy.runId` (a job a turn started, `job/start` / `job/continue`) and
`wake.runId` + `wake.also` (a turn strut ran to report on a job). When a
caused run starts, a line naming it is appended to
`<dataDir>/works/<cause runId>.jsonl`; a work's runs are a walk down those
files, a run's root a walk up its causes. *Mine:* a run `run/launch`
starts (a page's call, a person's act), an automation's fire and a host's
own launch are roots of their own; another strut's runs stay out.

**Done** is read from the stores each time a top-level run ends, so a
restart loses nothing: every run in the work ended (a summary that is not
`waiting`) and no wake is still on its way for a job in it (its session's
wake file holds the job run queued, or in a wake turn that has not ended).
A run's end is checked only after strut has decided whether it wakes a
conversation. *Mine:* a child run is not asked; its parent waited on it,
so the parent's end covers it, and a child cut off by a crash never blocks
its work.

**Observation.** When the work is done it observes each Concept any of its
runs opened, at the version that read returned (each run's last read, as
one run always did). *Mine:* a page the runs read at different versions (it
was edited while the work went on) is observed at none of them: no one
version made the work, and the verify pass never guesses a version. The
evidence is ABOUT the Concept with the version on its source, sourced to
the root run, at the id one run always had (check, root run,
`concept:<name>`). Policies keep their meaning with "work" for "run"
(`on_change`: once per version of the page, on the first work the rule is
about). A work of one run is judged exactly as one run was.

**What the check is handed**, built in code: the root run as before
(`input`, `params`, `output` or `error`), `concepts` (every page the work
opened), and `work` (each run in order, how it came about, its status, the
pages it opened, the folder its files are in). The standard judge
(`concept-check`) reads the whole work, each run's request and result cut
in code, through a capability the verify pass puts on the check's bag
(`ctx.services.work`). No input a caller writes can set it.

**The judge** gets one tool, `context/work-file`: read only, no shell, no
web, and it reaches the work's own folders and nothing else (each run's
job directory, else its artifacts, symbolic links resolved). Text comes in
pieces, a Word file as its text, an image is shown. The work is data,
never instructions. With no verdict (the rule is not about this work)
nothing is recorded, as before. It stays reachable by an `ai`-stamped
check. *Mine:* at most 8 model steps a judgment, and the work rendered in
24,000 characters.

**Not built here:** a person's word (`knowledge/add-evidence`) is still
about the one run it cites, which must have opened the page; the `step`,
`workflow` and `job` subjects are unchanged (still per run).

## (b) What was built

**A branch** (`src/branches.ts`) is a named copy of the Concept pages in a
graph namespace of its own, `branch-<name>`: the namespace half of ruling
2. `POST /branches { name, from }` copies every live Concept of the graph's
own namespace and the `PARENT_OF` edges among them (`from: "main"`), or
nothing (`"empty"`); `GET /branches` lists; `DELETE /branches/:name`
removes the pages and the record, refused while a run on it is in flight.
The record is `<dataDir>/branches/<name>.json` (name, namespace, when, who,
from what, pages, links). Full scope only (specs/API.md §5.7). *Mine:* a
branch name is `[a-z][a-z0-9_-]{0,55}` so the namespace is the name with a
fixed prefix (valid as a git branch name too, for item c); the prefix
`branch-` is reserved by convention, not enforced; a copy carries every
attribute and the docs but NOT `unique_source_id` (the seed or package
stamp), so no seeder, package fold or listing counts a copy as an installed
or seeded page; drop removes every node in the namespace for good (`DETACH
DELETE`, not a soft delete) and unregisters it on Neo4j; a parked run on a
dropped branch is not a reason to refuse the drop — it fails `no_branch:`
when woken.

**The launch field** (ruling 10): `branch` beside `job` on `POST …/run`,
`strut.run`, `RunOptions`; recorded on `run.start` and the summary,
`ctx.branch` for every step, kept by a durable resume. Every launcher a run
reaches passes it on: `job/start` / `job/continue` (the launching run's),
`meta/run-workflow` and `meta/run-step`, `run/launch`, a proposal it made
(applied on the branch when accepted), and the wake turn that reports on
its job (the conversation's first turn's branch). A run launched with a
bag already on a branch (a step's `ctx.services`) is on it, and naming
another is `branch_fixed:`; `trackRun` holds a child to its parent's. A
conversation stays on its first turn's branch: each turn line records
`branch`, and every run's view of `sessions` refuses a session whose first
turn ran elsewhere (`session_branch:`). A peer's launch is refused it, and
`strut/run-workflow` carries none. *Mine:* a run on main starts a run on a
branch through `meta/run-workflow { branch }` (the one in-run door that
names one; `run/launch` only inherits); a run on a branch does not
schedule (`automation/*` create, update and run-now refuse): a fire is a
run of its own, started later, on the live tree; a run naming a branch
that does not exist fails at its start like an input that does not parse.

**The redirect, Concepts only** (ruling 3), one seam: `bindBranch` in the
runner, beside `bindPrincipal` and `bindGraph`. The graph view
(`src/graph/branch.ts`) rides the reader-list seam (`src/graph/scope.ts`):
both readers hold every read to "a node is a Concept exactly when it is in
the branch's namespace", a keyed read of a Concept (by name) reads the
branch's, a Neo4j search reads the branch's namespace beside its own, and
graph/find and resolve take the branch's namespace for a Concept — so
`graph/graph-get`, `context/concept`, search, find, the tree walk and the
neighbors all answer the branch's pages and every other type's live nodes.
Writes: a Concept goes to the branch; a write to a live Concept, anything
else written into the branch's namespace, and an edge with a branch page
at one end and anything off the branch at the other are refused, as is a
move into or out of it (`graph/set-namespace`). The Knowledge door reads
the branch's pages (`KnowledgeCapability.onBranch`). *Mine:* raw queries
(`graph/query`) are refused on a branch, since their rows cannot be held
to it; a branch page links to nothing off the branch, not even a live
node of another type, so no read on main walks onto a branch; a live
Concept read by ref_id from a branch run is not found (no translation to
the branch's page of that name); schemas are written live (types are
shared, ruling 6).

**Main does not see a branch.** Audited every read of Concepts here that
names no namespace. Neo4j's reads, `knowledge.ts`, the claims reads, the
package fold (`installed.ts`), the seeder, the public surface and the
dream's reads all name the graph's own namespace. Two did not: a Ladybug
search (and fact search) that names no namespace read every namespace, and
now leaves out `branch-*` while the graph holds a branch (with none it
issues the query it always did: the backend's `branches.held`, loaded
from the records at boot and kept by create and drop); and the history snapshot (`allConceptFiles`,
packages/build.ts) filed other namespaces under `namespaces/<ns>/`, and
now leaves a branch out until item (c) gives it its own git branch. The
builder's Ladybug Cypher conventions tell its model to leave `branch-*`
out. A branch's namespace does not take raw queries away from a reader
list that reads the graph's own namespace (its pages are copies of that
one's); it still counts against a list that does not. Outside this repo and not fixed: the mcp lab (stakgraph
`mcp/src/lab/concepts/store/*`) and Hive run raw Cypher over `:Concept`
with no namespace, which sees a branch's copies.

**Claims** stay shared and are not on branches (item d): a run on a branch
opens the branch's pages, which no claim is about — the verify pass's
`ours` check already skips a page outside the graph's own namespace — so it
records nothing about them and does not fail. *Mine:* `knowledge/add-claim`
and `knowledge/add-evidence` refuse in a run on a branch, so nothing a
branch run writes lands on main's claims before item (d) decides how
claims follow a page.

**Not built here:** the git branch (c), claims following a page and the
compare read (d), merge (e), the type list (ruling 6), any UI.

## (c) What was built

**A git branch per Concept branch** (`src/history.ts`), the git half of
ruling 2: `refs/heads/<name>` in `<dataDir>/history.git`, beside `main`.
A create snapshots main first (so the fork point is the live tree), then
starts the git branch at main's commit. Its tree is main's with `concepts/`
holding the branch's pages: a copy from main is main's tree exactly, so
the ref IS main's commit and nothing is committed; `from: "empty"` is one
commit, `branch <name> from empty`, with no `concepts/`.

**Recording.** A run's (or an accepted proposal's) graph view on a branch
tells the history which side a write is (`historySides`,
src/graph-writes.ts): a page or a `PARENT_OF` link touches the branch; a
type, a claim or a check is the live graph's (ruling 3) and touches main; a
write of unknown type, both. The queue keeps one pending snapshot and one
debounce per target, on the one chain, by main's rules: a commit only when
the tree differs, the cause line, `Run:` trailers, the author, `settle`
for read-your-writes. A write on main never touches a branch. A branch's
snapshot never rebuilds the workspace: it reads the branch's pages alone
(`conceptFilesOf`, packages/build.ts), writes the blobs that changed, and
`mktree`s its last tree's other root entries with the new `concepts/`.

**Reading** (`history/read`). A branch's name works wherever a commit does
(`at`, `from`, `to`: its last commit), and `branch` says which branch a
time is read on (main by default). `diff { from: "main", to: "<name>", path:
"concepts" }` is exactly the pages the two hold apart; `log { from: "main",
to: "<name>" }` lists the commits made on the branch; a new action,
`branches`, gives each git branch's `head`, `time` and `base` (its fork
point, `merge-base` with main) — so item (e) can diff `base..<name>` for
what the branch changed and `base..main` for what main changed since. A
caller whose reader list leaves out the graph's own namespace sees no
branch: not listed, refused as `branch`, its commits (all `concepts/`) not
in its log.

**Drop.** What the branch waits to commit is committed, then its git branch
moves to `refs/dropped/<name>/<YYYYMMDDTHHMMSSmmmZ>`; the drop's answer says
where (`kept: { ref, commit }`), `branches` lists it under `dropped`, and the
name is free: made again, it starts at main's commit then. A touch for a
dropped branch is dropped from then on, and its memo forgotten.

**The view.** The Knowledge app's Changes takes a branch's name as a moment
(`momentOf` with the names `history/read branches` lists): `now` against
`try` is main against the branch, drawn by the diff view that exists.

**Off and restart.** With the history off or no `git`, a branch is exactly
as in (b) (`kept` absent). The only state per branch is its ref: the memo
of its tree is read back from git on first use, so a restart carries on;
boot catches up every branch, and makes the git branch of one made while
the history was off (at main's commit then).

*Mine*, every one open to a ruling:
- a branch commit is the branch's LAST tree with `concepts/` swapped, not
  main's current tree: everything but the pages stays as at the fork, so
  the branch's own diff from its fork point is pages alone (what a merge
  needs, ruling 8), and a branch's `log` shows only its own runs' changes.
  The price: a workflow or type on a branch commit is as it was at the
  fork, while the run itself used the live one (ruling 3) — read those on
  main at the run's time;
- a create snapshots main first (a `sync`, cause `sync`), so a raw write
  main had not heard is main's, never the branch's first commit;
- drop KEEPS the git branch under `refs/dropped/<name>/<time>`, never deletes
  it: a record of what was tried, reachable by its commits, out of the
  name's way; a stale git branch of the name (from a history that missed a
  drop) is kept aside the same way at a create;
- a new branch may not be named `main` (it would be the history's own
  branch); one named so under (b) still lists and drops;
- a Concept branch's name wins over a commit id it also reads as
  (`deadbeef`); `history/read`'s default is main even in a run on a branch;
- `branches` is a new action, the one read that gives the fork point.

**Not built here:** claims or evidence on a branch, the compare read of
verdicts, a commit stamped on evidence (d); merge (e); the type list; any
other UI. Checked by hand once (headless Chrome on a scratch strut): the
Changes view from `now` to `try` drew the one page the branch had edited.
