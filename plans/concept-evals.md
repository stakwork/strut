# Concept evals — trying a change to the Concept tree safely

> **Status (2026-11-14):** the primitives below were ruled by Evan on
> 2026-11-12; Paul's remarks reached the conversation through Evan, and the
> discussion with Paul and Tom is ongoing. Work item (a) is built (this
> file's first PR, #669), item (b) is built (#677), item (c) is built
> (#683), item (d) is built (#696), and the dream is automatic by default
> ("Automatic by default", below). Item (e) is built ("(e) What was built",
> below; its rulings are Evan's of 2026-11-15). Everything marked
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
| d | Claims following a page onto a branch, and a compare read (4) | built (#696, below) |
| e | Merge, and the rule for pages from git (8; rulings of 2026-11-15) | built (below) |
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

## (d) What was built

The direction Evan said yes to on 2026-11-13 ("yes, start the (d)
session", after the framing below was put to him): no fifth subject kind;
the evidence carries the branch; main's status filters by branch; claims
written from a branch land on main's shared claims; a compare read; nothing
names a kind of task. Everything past that is marked *mine*.

**No fifth subject kind.** A branch is the setting a Concept was used in,
not a thing measured. A work whose root ran on a branch opened the
branch's page of a name, and is judged by main's claims about `{ kind:
"concept", name }`, exactly as on main (ruling 4: the claims are the
measure, the pages the candidate). The verify pass finds the claimed page
where the work ran (`reader.pageOn(name, branch)`, `ours`, `verifyWork`);
the evidence is ABOUT main's Concept node (it outlives the branch), with
the branch page's version on its source.

**The evidence carries the branch.** `SourceContext.branch` (inside
`HAS_SOURCE.context`, the one JSON string jarvis gives it, so no schema or
conformance entry: no graph attribute is new) is the source run's
`run.start.branch` — a work's root's, the run a person's word cites. Every
evidence a run on a branch is the source of carries it, whatever the kind.

**Status per (claim, subject, branch).** `claimStatus` takes `branch` and
`since`: a Concept's status counts only the works run on the side it is
read on (`evidenceOn`), and a branch's active version is its own page's
(`reader.activeVersion(subject, branch)`). Main is the default everywhere
status was read: the Knowledge app and `knowledge/claims`, `GET /claims`,
the ledger, the verify pass. A branch is read with `GET
/claims?kind=concept&name=…&branch=…`, `statusFor(subject, { branch })`,
and by the Knowledge door a run on the branch holds (`knowledge/page`,
`knowledge/claims`). A run's ledger (`verifier.ledger`) reads its branch's.

**Claims and words from a branch run.** Item (b)'s refusals are lifted.
`knowledge/add-claim` in a run on a branch writes the claim on main's page
of that name, shared; `knowledge/add-evidence` records a person's word
about the run it cites, with that run's branch. So the dream can run on a
branch end to end.

**The compare read.** `knowledge.compare({ branch, concept? | tree?,
works? })`, as the `knowledge/compare` step and `GET
/branches/:name/compare` (specs/API.md §5.7): for one page, a tree on main,
or every page with claims, each claim on main and on the branch side by
side — each side's page version, status, the verdicts on its current page
(one per check per work), and the works judged there, newest first —
`changed` when the two pages differ, an `outcome` per claim, and totals.
`reader.compareFor` reads a page's claims and their evidence once for both
sides. Nothing in it names a kind of task.

*Mine*, every one open to a ruling:
- **Only a Concept's status reads per branch.** A step's, workflow's or
  job's evidence from a run on a branch carries the branch too, and still
  counts where it always did: those subjects are live on every branch
  (ruling 3), and a job's version is a run, which is on one side already.
  So a branch trial that fails a WORKFLOW's claim still shows on main's
  ledger for that workflow, as under (b). Reading those per branch needs no
  new data, only callers that pass the branch.
- **A work is on its root's branch.** A run on another branch inside a work
  (a main run's `meta/run-workflow { branch }` child) read pages that are
  not the root's branch's, and is not observed there. An eval runs the
  flow from a root launched on the branch.
- **No history commit on the evidence.** The branch and the source run's
  start time already find the tree in the history (`history/read show {
  at: <run start>, branch }`); a commit would cost a settle per work and be
  absent with the history off.
- **A branch counts only works whose source run started after it was
  made** (`reader.scopeOf`: run ids are ms start times; an id that is no
  time falls back to when it was observed). So a name made again after a
  drop starts clean, and an old trial never reads as the new one's.
- **`on_change` and an external check's open slot read the same side
  only.** An unedited copy has main's version: asking main's evidence would
  skip it, and main and a branch would make each other fire.
- **A person's word carries the CITED run's branch, not the writer's.** It
  is about what that run read. A dream on a branch that records what a
  person said about a run on main writes main's evidence; it is that
  person's word about main all the same.
- **A claim on a page the branch alone has is refused**, with a message
  that says so: a claim hangs on main's page node. Merge (e) would bring the
  page to main first.
- **The outcome** is the share of supporting verdicts on each side's
  CURRENT page (`outcomeOf`, never a division by zero): `better`, `worse`,
  `same`, and `unmeasured` while a side has no verdict there. Status alone
  is the newest measurement; the share counts every work run on that
  version, which is what repeating a trial many times adds.
- **Its scope**: `tree` is main's tree, walked by `PARENT_OF` a level at a
  time from the root, the root included; neither `concept` nor `tree` is
  every page that carries claims; `works` lists at most 10 a side (50 when
  asked). Its doors: a route beside the branch routes (full scope), and a
  read step granted to nothing yet (an eval workflow, or (e), can be given
  it).
- **`GET /claims` takes `branch` for a Concept only** (a 400 for another
  kind, whose status is one across branches); a branch with no page of
  that name, or none at all, reads `stale` / `unknown`, not a 404.
- **A dream on a branch keeps its own marks**
  (`<dataDir>/dream/branch-<name>/<tree>.json`), starting from main's when
  it first reads, and from main's again for a branch made again under the
  name. Without it a dream tried on a branch would move main's marks, and
  main's next dream would skip those turns.

**Checked end to end** (src/graph/branches.test.ts, on a Ladybug file and
on Neo4j): a claim on `Guide` with a code check, a work on main (supported),
a branch whose `Guide` was edited and the same work on it (refuted, the
evidence's `branch: "try"`, a different page version), main's status still
`supported` and the branch's `refuted`; an unedited branch measured under
`on_change`; `GET /branches/try/compare?concept=Guide` with both verdicts
(`outcome: worse`); a person's word on the branch run carrying the branch;
and, dropped and made again, the branch reading `unknown`.

**Not built here:** merge (e); the type list; any view of the compare; a
per-branch status for steps, workflows and jobs.

## (e) What was built

### Evan's rulings (2026-11-15)

Ruling 8 said a branch's diff becomes proposals on main; "Automatic by
default" (2026-11-13) said the merge may be automatic too. These settle it:

1. **The merge.** What the branch changed since its fork (`base..<branch>`
   over `concepts/`: pages edited, added or removed, and their `PARENT_OF`
   links) is applied onto main. Then the branch is dropped; the drop keeps
   its git history under `refs/dropped/`.
2. **Automatic by default; a person's yes is a setting.** With the setting
   on, the merge is a proposal that waits for a yes: "automatic now,
   person's yes is a setting you can set".
3. **Who triggers a merge:** a person (a route) or an eval workflow (a
   step), for example after `knowledge/compare` says `better`. strut never
   merges on a score by itself.
4. **Main changed the same page since the fork:** the merge is refused and
   names those pages; the trial is run again on a fresh branch. Pages only
   main changed stay as they are.
5. **A page whose text comes from git is never changed automatically,
   neither by a merge nor by the dream:** "seeded ones are just never
   automatic, but non-seeded ones are". A page is from git when main's node
   carries a seed or package stamp (`unique_source_id`): strut's own sets
   (`strut/concepts/`, `strut/concepts/personal/`, the legacy
   `lab/builder/concepts/` and `lab/job/concepts/`) and any package's
   `conceptPrefix(pkg)`. `Workflow Builder`, `App` and `Game` are not
   special; they only hold more text.
6. **Split** ("Yes, split it"). For a branch that changed both kinds,
   ordinary pages land on main at once; the git-sourced pages' changes
   become ONE proposal per checkout, because they were measured together;
   where strut has no writable checkout for them they are skipped and
   listed in the merge's answer. A page the branch ADDS is ordinary and
   lands at once, even under a seeded parent.
7. **Writable checkout.** Accepting the proposal writes the pages' files
   there, in the form that source's seeder or install reads, and reloads
   them from there: (a) DEV MODE, the env flag `STRUT_DEV_CONCEPTS=1`,
   honoured only when strut's own pages folder is inside a git checkout
   (under `npm run dev`, the checkout's `src/concepts/`); the person makes
   the PR with their own git, strut never commits or pushes there; (b) a
   package OPENED AS A REPO (its working copy), whose existing Commit makes
   the branch and the PR; (c) anything else is skipped: strut's pages on a
   deployed strut, a package installed from an index or a `git+` ref that is
   not an opened repo.
8. **The dream follows the same rule (5–7), whatever its `review` says.**
   Before, the automatic dream could edit a seeded page that is not a root
   (`Assistant Conversations`, `App`) and the next boot silently put git's
   text back. Now that edit is a proposal in dev or an opened repo, skipped
   elsewhere, and the dream's answer says so.
9. The branch's evidence stays on the branch. Main's new page versions
   start unmeasured.

### What was built

**The merge** (`src/branch-merge.ts`; `branches.merge`, src/branches.ts):
inside the branch's lock, refused while a run on it is in flight. The
history is settled and synced (main's commit is the live tree), the fork
point is `merge-base main <branch>`, the branch's changes are `git diff
--name-status --no-renames base <branch> -- concepts/` and main's `git diff
--name-only base main`. A path both changed is a conflict unless main's
file is now the branch's: `merge_conflict:` (409) names every such page
and nothing is written. Each edited or removed page's main node is asked
whether its text comes from git. The ordinary pages land through the
backend — an edit as `nodes.update` (attributes the branch dropped
removed), an add as an `upsert`, then the links (the `parents` a page
gained since the base written, the ones it lost deleted), then removals
(`deleteNode`) — and the history is touched once: one commit, `merge
<name>`. The pages from git go to `conceptSources.propose`. Then the
branch is dropped as `DELETE /branches/:name` drops it, the answer's
`dropped` carrying `kept`. `dryRun` answers the same without writing and
keeps the branch.

**Its doors:** `POST /branches/:name/merge { dryRun? }` (full scope, like
every branch route; a person's act, merged at once) and the step
`knowledge/merge { branch, review? }` (`effect: write`, `approver: admin`,
granted to nothing). `review: true` makes the merge a proposal of that very
step, its card from a dry run (what lands, what is proposed into which
checkout, what is skipped); a conflict refuses before anything is proposed.

**Pages from git** (`src/concept-sources.ts`, `ctx.services.conceptSources`):
`fromGit` / `fromGitByRef` read main's live nodes and parse the stamp
(`<prefix><file>@<hash>`) into `{ set, file, checkout?, why? }`; `propose`
makes one `knowledge/write-pages` proposal per checkout (`approver: admin`,
a card naming the checkout, the pages, the cause) and lists the rest as
`skipped` with why. `knowledge/write-pages { checkout, pages: [{ name, set,
file, text? }], cause }` is sealed and runs ONLY as an accepted proposal;
its door (`conceptSources.write`) checks the accepted record on disk for
this very input, as `package/commit` does, resolves the checkout again,
writes each page's file under the name its stamp gives, in its form
(`fileText`), removes the file of a removed page, then reloads the set
(`seedConcepts`; a removed page is retired) and touches the history
(`proposal <id>`). `devConcepts` decides dev mode once at boot; createStrut
logs it.

**The dream** changes the tree with `knowledge/edit-page` and
`knowledge/add-page`, which take `graph/edit-node`'s and
`graph/create-triplet`'s own inputs and run them, with the rule in front.
An edit of a page from git becomes a `knowledge/write-pages` proposal (dev,
an opened repo) or is skipped; its answer's `note` says which, and the
prompt and the lesson's `change` description ask for it in the lesson. A
triplet that would change a page from git is refused. A generic hook,
`StepDef.answerGated` (core.ts; agent.ts calls it before `proposeCall`),
lets a gated step answer a call itself: under `review: true`, an edit of a
page from git is answered the same way, never proposed as a graph edit.
The Knowledge app (`learning.ts`) and the kit's concept diff read the two
steps as the graph steps they wrap, so a reviewed tree draws their
proposals as before.

**Checked end to end** (two scratch struts on Ladybug files, 2026-11-15):
(i) a branch editing `Guide` (ordinary) and `App` (strut's), adding a page
under `App` and removing `Tone`, merged on a strut with no checkout: three
pages landed as one `merge try` commit, `App` skipped and listed with why,
the branch dropped and kept under `refs/dropped/try/…`; (v) a branch and
main both editing `Guide`: 409 naming `Guide`, nothing merged, the branch
kept; (iii) a package with a Concept, opened as a repo from a local bare
remote: the merge proposed `Notes` into `acme/notes`, accepting it wrote
the working copy's `concepts/concept-notes.md` and reloaded the page, the
repo listed it as an edit, and Commit pushed a branch holding it; (ii) the
same merge on a strut run (`tsx src/server.ts`) from a SCRATCH clone of
this branch with `STRUT_DEV_CONCEPTS=1`: one proposal for `strut`;
accepting it rewrote the clone's `src/concepts/App.md`, its front matter
untouched, and reloaded `App`; (iv) `knowledge/edit-page` on `Assistant
Conversations`: skipped on the first strut, a proposal on the dev one, and
accepted, a one-line diff of its description in the clone. The same five
are tests on both engines (src/graph/branch-merge.test.ts), and the dream
itself, played by a stand-in model, skips such an edit and, in dev mode,
proposes it, with review off and on (src/graph/dream.test.ts).

*Mine*, every one open to a ruling:
- **Where the setting lives:** on the step, `knowledge/merge`'s input
  `review`, set by the eval workflow from its own input or params, as the
  dream's `review` is an input on its automation. The route is a person's
  act and merges at once; its `dryRun` shows what would happen.
- **Names:** the route `POST /branches/:name/merge`; the steps
  `knowledge/merge`, `knowledge/write-pages`, `knowledge/edit-page`,
  `knowledge/add-page`; the flag `STRUT_DEV_CONCEPTS`, the checkout name
  `strut`. `knowledge/merge` is not sealed (an eval workflow, even one the
  builder wrote, may hold it) and is granted to nothing; the other three
  are sealed. Both proposals are an ADMIN's yes.
- **How the dream's gate became per page:** two steps of its own over the
  graph steps, plus the generic `answerGated` hook, rather than a guard in
  the graph layer: `graph/edit-node` stays as it was for every other
  workflow (the repo flow's builder edits a package's page through it, as
  app-repos.md §3.2 says), and the rule is visible where the dream calls
  it. `knowledge/add-page` refuses a triplet that would change a page from
  git (naming it inline, or `target_ref_id` moving it); a rename of a page
  from git is skipped (its file would keep the old name).
- **The conflict check covers every page, git-sourced included:** a
  proposal built on an old base would write over main's newer text in the
  checkout. Both sides ending with the same file is no conflict.
- **"From git" is any stamp,** a seeder strut does not know included (a
  host's own set): skipped, with why. Strut's sets are matched by their
  prefix and `legacyPrefixes`.
- **The merge needs the history,** and is refused without it; a branch
  made `from: "empty"` is refused (against its fork it removes every page
  main has); so is one whose git branch was made after it (the history was
  off then: its fork point is not known).
- **One commit on main, one parent,** `merge <name>`, not a two-parent git
  merge: main's log stays main's writes, and the branch's commits stay
  reachable under `refs/dropped/`.
- **A rename on the branch is a removal and an addition** (`--no-renames`;
  a page's file is its node key). The claims on the old name stay on its
  removed node.
- **The branch is dropped even when pages were skipped:** their text is in
  the kept git branch, and the answer names each with why.
- **The proposal carries each page as a new-form page**, and the file's form
  is decided when it is accepted, against the file then: its front matter
  kept byte for byte when its values did not change (an edit of the docs is
  a diff of the docs), the old `<Name>.md` form where the file is named by
  the page and still fits it (`description`, one `parent`), else the new
  form.
- **The reload is the whole set from the checkout,** as a start or an
  install reads it (strut's own set; a repo's with the repo door's
  `keepEdited` and `adopt`), so a parent link the page dropped goes too. In
  dev mode that also picks up the person's other edits there, as a
  restart would. A repo waiting on a merge refuses the write.
- **Dev mode** is per set: `git ls-files` lists pages in that folder (so a
  build's `build/concepts/`, an image's or a git dependency's copy never
  is). Boot says it in one line, and says why when the flag is set and not
  honoured.
- **Who a proposal is by:** the run that asked (an eval workflow's, the
  dream's), else, from the route, no workflow and `merge-<name>-<time>`: it
  belongs to no conversation, so an admin sees it (`pageSees`).
- **The dream's answer** says it through the tool's `note` and the lesson's
  `change`; no new field on the answer.
- **The merge writes main through the backend** and touches the history
  itself (cause `merge <name>`, the run's `Run:` when a step merged); the
  live graph-change feed does not hear it.
- **A dry run settles and syncs the history** (a `sync` commit when main
  had writes it had not heard).

**Not built:** a view of the merge or the compare; the Knowledge app does
not draw a `knowledge/write-pages` proposal over its page (it lists by
ref_id; this one names pages); a merge's ordinary pages are not proposals
under review page by page (the review setting holds the whole merge); the
type list (ruling 6 of 2026-11-12).

