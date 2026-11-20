# Trials — how often a rule holds

Status: PROPOSED (2026-11-19). Builds on plans/concept-evals.md (items
a–e, all built). Revised the same day on the owner's review: a page's
checks ship in its file (3), the Knowledge app runs them and shows their
history (4), and a change is tried there as a draft (5).

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

The owner's review (2026-11-19) added three things. The checks of a page
strut ships are shipped with it. The Knowledge app is where a person runs
one, picks n and reads the evidence: "that's it". And the proof needs no
PR: a person makes the change in the app as an experiment, tests it
there, and keeps it or not.

## What exists

- A claim on a Concept judges every piece of WORK that opened the page, at
  the version it read (`src/work.ts`, `src/verify.ts`). The standard judge
  is the `concept-check` workflow.
- A Concept branch is a copy of the tree a run can be launched on
  (`branch`, a launch-level field). `knowledge/compare` sets main against a
  branch over the same claims; `knowledge/merge` lands the branch.
- The Knowledge app shows a Concept's claims with their status.
- The history (`history/read`) holds every text a page has had, on main
  and on each branch, and `ConceptDiff` draws two of them as one diff.

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

A page from git carries its claims and their cases in its file, so they
go where the page goes. The front matter takes a `claims:` block shaped
like a workflow's (`readClaimsBlock`). Each claim names the `workflow` its
cases run and lists the `cases`, each one that workflow's input:

    claims:
      - text: Asked whether it can do something its work can do, it says yes and offers to do it.
        workflow: orchestrator
        cases:
          - prompt: Can you use bash?
          - prompt: What's the best way to give you SSH access to my server?

`seedConcepts` records the block when it writes the page, as
`reconcileWorkflowClaims` does a workflow's (idempotent; the speaker is
the set's seeder; the check is the standard one): strut's own pages at
boot, a package's at install. That is the "claims travelling with a
package's pages" docs/knowledge.md lists as not built. The block is not an
attribute and not part of the page's version (the version is what opening
the page returns), so a new case moves no verdict to stale. A claim or a
case a person adds in the app is the workspace's own. A seeded one retired
there comes back at the next boot until the file drops it, as a
workflow's does.

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

Doors: `knowledge/trial { claim, n, branch? }` and `knowledge/cases {
claim, cases }` (a claim's cases, replaced whole), through the Knowledge
door (an admin, or an eval workflow), and the Knowledge app (4). Samples
and their judges spend like any check (`src/check-spend.ts`).

## 4. In the Knowledge app

A Concept's card lists its CHECKS where it lists its claims today: each
claim, and under it the cases that test it. To a person a check is the
rule and its messages; the judge is always the standard one.

- **Run.** A number (4 by default) and Run: `knowledge/trial`, n samples
  of each case. Each verdict is a dot, green or red, drawn as it lands. A
  dot opens its sample: the message, the reply and the judge's sentence
  (the root run's input and output, the evidence's content).
- **Add.** A sentence adds a claim (`knowledge/add-claim`) and a message
  adds a case to it (`knowledge/cases`, which also takes one away). Either
  is run at once.
- **History.** One row per TEXT the page has had, newest first, with its
  dots and its count. Between two rows sits what changed: one line ("+12
  −2") that opens to the lines removed and added (`ConceptDiff`).

The history records nothing new. Every verdict on a Concept already
carries the version of the page its work read, the work's root run and
when it was observed. One read groups them: `knowledge/history { claim,
branch? }` → the versions judged, newest first, each `{ version, from,
to, passed, judged, samples: [{ run, workflow, supports, content, at }]
}`. The change between two rows is `history/read diff` between a run of
each: a run's start time names the tree it read, so nothing maps a
version to a commit. A row's date is its verdicts' own (`from`, `to`).
Nothing here reads a repository on GitHub: the history is the server's
own (`<dataDir>/history.git`), and where it is off the rows show without
the change.

The app shows dots and counts. `low` and `p` (2) stay on the reads, for a
workflow that decides by them.

These are the app's first writes besides a decision on a proposal, and an
admin's alone, as the dream's changes are. Its grants gain
`knowledge/trial`, `knowledge/cases`, `knowledge/add-claim`,
`knowledge/history` and the draft's doors (5).

## 5. Drafts: a change tried in the app

A row needs a text that was the page's, and waiting for a release to
change a page strut ships is no way to find the wording. A DRAFT is a
change to one page, tried before it lands. It is a Concept branch the app
makes (`draft-<page key>-<time>`, from main) with that page's docs edited
on it. On a branch every page is an ordinary copy
(`graph/_concept-page.ts`), so a page from git is edited there like any
other.

"Try a change" on a card opens the page's text. Run then runs every check
on the page n times on the draft, and tops main's current text up to n
samples a case, so the two rows are measured the same way at the same
time. The draft's row sits above "This version", with what it changes
between them (`history/read diff { from: "main", to: <draft> }`). Each
edit that is run is a row of its own: a person edits, reads the dots, and
edits again. That loop is the point. The checks are the measure, and the
page is what is tuned against them.

**Keep** is `knowledge/merge`. **Discard** drops the branch (its git
branch is kept, as with any drop). A row is a text, and its dots are the
verdicts of every work that read that text, on main or on a draft of that
page, so a kept draft's row becomes "This version" with its dots. Status
still reads per side (concept-evals ruling 4).

A page from git is kept by the rules it has. In dev mode
(`STRUT_DEV_CONCEPTS=1`) Keep is a `knowledge/write-pages` proposal that
writes the file in the checkout, and the person commits it when they
choose. On a deployed strut it is not kept, since the next boot puts
git's text back: the card says so, and the draft stays with its rows
until it is discarded. Trying needs no checkout and no PR. Only landing a
page strut ships does.

Doors: `knowledge/draft { concept, docs }` makes the draft, or writes its
page again, and answers its name; `{ draft, discard: true }` drops it.
`knowledge/trial`, `knowledge/history` and `knowledge/merge` take the
name as their `branch`.

## A diff that matters

A branch is main's pages plus one change, and `main..branch` in the
history is that diff. A draft (5) is that branch, made by the app. Run
the same cases on both sides at the same time, then compare. A rule that
flips on every sample needs few:

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
- A draft of more than one page. A branch made by hand still holds any
  number; the app's draft edits one.
- An agent that writes the draft: it reads the failed samples and
  proposes the wording. The doors in 3–5 are what it would call.
- Writing a claim or a case added in the app back into a page's file
  (`knowledge/write-pages` writes the page's text alone). A person adds it
  to the front matter.
- Retiring a claim from the app.

## Open

1. Cases on the claim (my pick) or on the page?
2. Should a claim with trials take its status from the count? My pick: no,
   the count sits beside it.
3. A trial holds a run on another strut (my pick, as a branch does not
   cross): a turn that orients with a peer's lookup then sees nothing
   there. Or let reads on a peer run?
4. The frozen session's versions: the session keeps them (my pick), or
   only a session's first turn observes the pages in its prompt?
5. A kept draft's verdicts count on main's new text (my pick: a row is a
   text), or main starts unmeasured, as a merge leaves it today, and the
   checks are run again?
6. Keep on a page from git on a deployed strut: refused (my pick), or the
   server takes the page over (clears its stamp) and stops following git
   for that page?
7. Run on a draft runs every check on the page (my pick: a change that
   fixes one rule can break another), or only the one it was opened
   from?
