# Concept evals — trying a change to the Concept tree safely

> **Status (2026-11-12):** the primitives below were ruled by Evan on
> 2026-11-12, in a design conversation that Paul joined. Work item (a) is
> built (this file's first PR). The rest are not started. Everything marked
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

## Build order

Ruled: checks first. One PR each, against main.

| Item | What | Status |
|---|---|---|
| a | Whole-work checks on main (rulings 5, 9) | built (this PR) |
| b | A branch you can create, run on and drop (2, 3, 10) | not started |
| c | The branch recorded in git (2) | not started |
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
