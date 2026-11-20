# Trials — how often a rule holds

Status: PROPOSED (2026-11-19). Builds on plans/concept-evals.md (items
a–e, all built).

## The ask

A person asked Jamie the best way to give it SSH access to a server. Jamie
answered "I can't… no shell". Its jobs have one. The prompt was fixed
(#766) and checked by hand: the same message replayed 4 times before and 4
times after, "I can't" 4/4 → 0/4.

That check should be strut's own. A rule (a claim on a Concept page), a
few messages that test it (cases), N replays, and a number on the claim in
the Knowledge app: "19/20, at least 78% (95% confidence)". The same number
on a branch says whether a change to the page made the difference.

Nothing here names a kind of task. The orchestrator is the first use.

## What exists

- A claim on a Concept judges every piece of WORK that opened the page, at
  the version it read (`src/work.ts`, `src/verify.ts`). The standard judge
  is the `concept-check` workflow.
- A Concept branch is a copy of the tree a run can be launched on
  (`branch`, a launch-level field). `knowledge/compare` sets main against a
  branch over the same claims; `knowledge/merge` lands the branch.
- The Knowledge app shows a Concept's claims with their status.

Three things stop the check above: the orchestrator's rules are YAML, not
a page; a claim's status is its newest verdict, never a count; and nothing
replays a message N times without doing the real work N times.

## 1. The orchestrator's rules are a page

`src/concepts/Orchestrator.md`, a root seeded like `Job` and `Dream`,
holds the judgment of today's `params.system`, moved as it is.
`orchestrator.yaml` keeps the mechanics (the reply's fields, which tool
does what) and reads the page with `context/concept` into the system
prompt, as the dream reads `Dream` (#667). A host's section is still
appended after. Every turn then opens the page, so a claim on it judges
turns.

A session keeps the system prompt of its first turn. A later turn on it
records the page versions that first turn read, not the page's current
one, or a verdict lands on a version the model never saw. This holds for
any page read into a system prompt (`Job` and `Workflow Builder` today).

The page starts long, since it is today's prompt. Splitting it into
shorter pages comes after trials show which parts matter.

## 2. A claim counts

Every claim read gets a COUNT beside its status, on the subject's current
version: `{ passed, judged, low }`. `judged` is the verdicts (an
abstention is none), `low` the one-sided 95% lower bound on the pass rate
(Clopper–Pearson; with every sample passed it is 0.05^(1/n)). The
database counts it, as `compare` already counts verdicts. Status keeps its
meaning.

`compare` decides from the counts: `better` or `worse` only when a
one-sided Fisher exact test on the two sides is under 0.05, else `same`,
with `p` on each claim. A merge's commit carries the compare it landed on,
so the history keeps the proof beside the diff.

## 3. Trials

A CASE is one input to a workflow, `{ workflow, input }`, saved on a
claim: claims are the measure and shared across branches, and a case is
part of the measure. A person writes one in the Knowledge app or lifts one
from a real run ("make this a case": the run's workflow and input).

A TRIAL runs a claim's cases N times. Each sample is a new run of the
case's workflow with its input, as a new conversation (a fresh `session`
where the input has one), on main or on a branch. Each sample's work is
judged by that claim, whatever its check's policy, as an explicit verify
is; other claims follow their own policy.

`trial` is a launch-level field shaped like `branch`: recorded on
`run.start`, inherited by every run it starts, never in `input`, set by
whoever launches. A trial starts nothing outside itself: the job launcher
answers that the job was held, with what it would have started, and
launches nothing; a gated call is not proposed; no wake and no callback; a
run on another strut is held. A shell or the web an agent has is not held,
so a trial of a workflow whose agent has them does real work in its own
folder. A trial's work (concept-evals ruling 9) is what it ran: a turn
that would have started a job is judged on its own, on the brief it wrote.

Doors: `knowledge/trial { claim, n, branch? }`, through the Knowledge door
(an admin, or an eval workflow), and on a claim in the Knowledge app: add
a claim, add a case, Run ×N, the count. Samples and their judges spend
like any check (`src/check-spend.ts`).

## A diff that matters

A branch is main's pages plus one change, and `main..branch` in the
history is that diff. Run the same cases on both sides at the same time,
then compare. A rule that flips on every sample needs few:

| Samples per side, all flipped | p (one-sided) |
|---|---|
| 3 | 0.05 |
| 4 | 0.014 |
| 5 | 0.004 |

Under the 0.05 rule, 4 a side is the fewest that counts. To find which part of a change matters, run one branch per part. A seeded
page's merge is a `knowledge/write-pages` proposal in dev mode
(`STRUT_DEV_CONCEPTS=1`), so a winning change to `Orchestrator` becomes a
strut PR with its counts.

Proving a rate takes more. With every sample passed, the lower bound on
the pass rate is:

| Samples | 95% confidence | 99% confidence |
|---|---|---|
| 6 | 61% | 46% |
| 20 | 86% | 79% |
| 59 | 95% | 91% |
| 299 | 99% | 98% |

No number of samples gives 100%. The count is the judge's verdict, and a
few verdicts by a person (`knowledge/add-evidence`) say how far the judge
is trusted.

## The first claim

On `Orchestrator`: "Asked whether it can do something its work can do, it
says yes and offers to do it; it never says it lacks a shell, files or the
web, and never explains how it is built." Cases: the SSH message, "can
you run this python script?", "can you check my site every hour?", "can
you read this PDF?". Cases that differ are what make the count about the
rule, not one sentence.

## Not in this plan

- A case of more than one message.
- A target rate on a claim.
- Trials that do the whole work of an agent with a shell (a sandbox).
- Splitting the `Orchestrator` page.
- The type list (concept-evals ruling 6).

## Open

1. Cases on the claim (my pick) or on the page?
2. Should a claim with trials take its status from the count? My pick: no,
   the count sits beside it.
3. A trial holds a run on another strut (my pick, as a branch does not
   cross): a turn that orients with a peer's lookup then sees nothing
   there. Or let reads on a peer run?
4. The frozen session's versions: the session keeps them (my pick), or
   only a session's first turn observes the pages in its prompt?
