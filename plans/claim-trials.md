# Trials — how often a rule holds

Status: BUILT (2026-11-20), except item 2. Builds on
plans/concept-evals.md (items a–e). As built: the orchestrator's rules are
the seeded `Orchestrator` page (1); a page's file carries its claims and
their cases, and a claim's cases run as trials (3); the Knowledge app runs
a page's checks and shows a dot per verdict (4); a change to a page is
tested against the page as it is, and the test is kept (5). The reference
is docs/knowledge.md, "Trials and tests". NOT built: a claim's count with
a lower bound, and a compare that decides by a significance test (2).

## The ask

A person asked Jamie the best way to give it SSH access to a server. Jamie
answered "I can't… no shell". Its jobs have one. The prompt was fixed
(#766) and checked by hand: the same message replayed 4 times before and 4
times after, "I can't" 4/4 → 0/4.

That check should be strut's own. A rule (a claim on a Concept page), a
few messages that test it (cases), N replays, and the verdicts on the
claim in the Knowledge app. The same verdicts on a changed wording say
whether the change made the difference.

Nothing here names a kind of task. The orchestrator is the first use.

## The owner's rulings (2026-11-19)

Made on a review of this plan and four mockups of the app.

1. The checks of a page strut ships are shipped with it.
2. The Knowledge app is where a person runs a check, picks n and reads the
   evidence: "that's it".
3. Proving a change needs no PR: a person makes the change in the app,
   tests it there, and keeps it or not.
4. It is not about how the page evolved. It is about proving that each
   part of it is good, led by a person. So nothing that was proved is
   discarded, and a NEGATIVE EXAMPLE (lines taken out, and the rule
   breaks) is as valid as an improvement: "they should be the same
   primitive". That primitive is the TEST (5). An earlier draft of this
   plan had a history of the page's versions and drafts a person kept or
   discarded; both are gone.
5. The diff is the view. The page is not broken into parts: a person makes
   a diff and tests it.
6. A row draws at most ten dots; the earlier ones are a count to their
   left ("+15").

## What exists

- A claim on a Concept judges every piece of WORK that opened the page, at
  the version it read (`src/work.ts`, `src/verify.ts`). The standard judge
  is the `concept-check` workflow.
- A Concept branch is a copy of the tree a run can be launched on
  (`branch`, a launch-level field). `knowledge/compare` sets main against a
  branch over the same claims; `knowledge/merge` lands the branch.
- The history (`history/read`) holds every text a page has had, and
  `ConceptDiff` draws two of them as one diff.

Three things stopped the check above: the orchestrator's rules were YAML,
not a page; nothing replayed a message N times without doing the real work
N times; and the app showed a claim's status, never its verdicts.

## 1. The orchestrator's rules are a page

`src/concepts/Orchestrator.md`, a root seeded like `Job` and `Dream`,
holds the judgment that was `orchestrator.yaml`'s `params.system`, moved
as it was. The workflow keeps the mechanics (the reply's fields) in
`params.system`, where a host's section is still appended, and reads the
page with `context/concept` at the head of the system prompt. Every turn
then opens the page at a version, so a claim on it judges turns.

Two things the move needed:

- **The page as it is.** `context/concept` frames a page as the
  workspace's notes and cuts its docs at 6,000 characters. A page that IS
  an agent's rules is read with `frame: false` (its docs alone) and a
  `max` the step names (20,000 here).
- **No graph.** A workspace on plain files has no page to read. The seeded
  workflow carries the same file's text as `params.rulesText`
  (src/orchestrator-seed.ts), and the system prompt is `{{ rules.text ||
  params.rulesText }}`. One text, two ways to the prompt.

A conversation keeps the system prompt of its first turn. A later turn on
it must not count as evidence about a wording the model never read. As
built (open question 4, the second option): when the agent step ran on a
kept prompt and was handed another, the run does not observe the pages
`context/concept` rendered into the unused one (`session.keptSystem`,
`subjectsOfRun`). A page the agent opened itself is still observed. This
holds for every workflow that renders a page into a prompt.

The page starts long, since it is the whole prompt. Splitting it into
shorter pages comes after tests show which parts matter.

## 2. A claim counts (not built)

Every claim read would get a COUNT beside its status, on the subject's
current version: `{ passed, judged, low }`, `low` the one-sided 95% lower
bound on the pass rate (Clopper–Pearson; with every sample passed it is
0.05^(1/n)). `compare` would decide from the counts: `better` or `worse`
only when a one-sided Fisher exact test on the two sides is under 0.05,
with `p` on each claim.

The app shows dots and counts (4) and decides nothing by them, so this was
left out. It is what a workflow that decides by a score needs.

## 3. Trials

A CASE is one input to a workflow, `{ workflow, input }`, kept on a claim:
claims are the measure and shared across branches, and a case is part of
the measure. Kept beside the claim, not on it
(`<dataDir>/trials/cases/<claim id>.json`): `Claim` is a type strut shares
with a swarm's graph and does not extend.

A page from git carries its claims and their cases in its file, so they go
where the page goes. The front matter takes a `claims:` block. Each claim
names the `workflow` its cases run and lists the `cases`, each one that
workflow's input:

    claims:
      - text: Asked whether it can do something its work can do, it says yes and offers to do it.
        workflow: orchestrator
        cases:
          - prompt: Can you use bash?
          - prompt: What's the best way to give you SSH access to my server?

`seedConcepts` hands a seeded page's block out, and createStrut records
strut's own at boot (`trials.seed`): additive, by the sentence, as a
workflow's `claims:` block is. The block is not an attribute and not part
of the page's version, so a new case moves no verdict to stale. A claim or
a case a person adds in the app is the workspace's own. Writing a page's
docs back to its file keeps the block byte for byte.

A TRIAL runs a claim's cases N times. Each sample is a new run of the
case's workflow with its input, on main or on a branch, and the claim
judges it whatever its check's policy; other claims follow their own.

`trial` is a launch-level field shaped like `branch` (`RunTrial { claim,
case? }`): recorded on `run.start` and the summary, `ctx.trial`, kept by a
resume, inherited by every run it starts, never in `input`. No request
sets it: the trials capability alone launches one. A trial starts nothing
outside itself: job/start and job/continue answer that the job was held
and launch nothing; a gated call is not proposed; no wake and no callback;
a run on another strut is held; nothing is scheduled. A shell or the web an
agent has is not held. A trial's work is what it ran: a turn that would
have started a job is judged on its own, with the brief it wrote (the
orchestrator's result carries it as `held`).

A sample that ends with no verdict (its run failed, the judge gave none)
is said on the page, not left as a missing dot.

## 4. In the Knowledge app

A Concept's card lists its CHECKS where it listed its claims: each claim,
and under it the messages that test it. To a person a check is the rule
and its messages; the judge is always the standard one.

- **Run.** A number (4 by default) and Run: n samples of each case. Each
  verdict is a dot, green or red, drawn as it lands, by message. A row
  draws its newest ten dots and counts the earlier ones. A dot opens its
  sample: the message, the reply and the judge's sentence.
- **Add.** A sentence adds a check; a message adds a case to one, and a
  case is taken away the same way. Either is run at once.
- **Tests** (5), under the checks.

One read draws all of it, `knowledge/checks { concept }`, taken again
every 1.5 s while samples are being judged. Six more steps do the rest
(`knowledge/add-check`, `cases`, `trial`, `test`, `use`, `sample`). They
answer strut's own page shown to an admin and nobody else: a trial spends,
and a page's words are an agent's rules. A member reads the checks and the
dots.

## 5. Tests: a change tested against the page

A TEST is two wordings of one page run against the same checks: the page
as it is, and the page with a change. "Try a change" opens the page's
text; "Test it" runs every check on the page n times on the change, and
tops the page up to n samples a case, so the two rows are measured alike.

The change is read by its runs on a Concept branch made for them and
dropped when the last sample is judged. The test is kept: both wordings,
so the diff and its verdicts stay whatever the page becomes. Nothing on
the page changes, and nothing is discarded.

The card draws the diff, then two rows of dots, "The page" and "With the
change", and which did better. That one card is both things a person does:

- **A negative example.** Take lines out; the rule breaks. The page is
  better, and the test is the proof that those lines matter.
- **An improvement.** Change lines; the rule holds more often. The change
  is better, and the card offers **Use it**: the page takes the wording.
  From then on the same test reads from the page's new wording, as a
  negative example of it.

Verdicts are counted by TEXT: a page version names one wording, and a
verdict on it counts from a run on main or from a run on one of that
page's own tests. So a wording that was tested and then used keeps its
dots. Status still reads per side (concept-evals ruling 4).

A page whose text comes from git is used by the rules it has
(src/concept-sources.ts). In dev mode (`STRUT_DEV_CONCEPTS=1`) Use it
writes the file in the checkout, and the person commits it when they
choose. On a deployed strut it is not offered, since the next boot puts
git's text back, and the card says so. Testing needs no checkout and no
PR. Only landing a page strut ships does.

## A diff that matters

A rule that flips on every sample needs few:

| Samples per side, all flipped | p (one-sided) |
|---|---|
| 3 | 0.05 |
| 4 | 0.014 |
| 5 | 0.004 |

4 a side is the fewest that would count under a 0.05 rule, and is the
app's default. Proving a rate takes more. With every sample passed, the
lower bound on the pass rate is:

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

On `Orchestrator`, in its file: "Asked whether it can do something its
work can do, it says yes and offers to do it; it never says it lacks a
shell, files or the web, and never explains how it is built." Cases: "Can
you use bash?", the SSH message, "Can you run this Python script for me?",
"Can you check my site every hour and tell me if it goes down?". Cases
that differ are what make the count about the rule, not one sentence.

## Not built

- Item 2: the lower bound, and a compare that decides by a test.
- A package's pages' `claims:` blocks at install. The seeder hands them
  out; nothing records them yet.
- A trial launched over HTTP or by an eval workflow. The seven steps
  answer the admin's page alone.
- A case of more than one message, or lifted from a real run.
- A test of more than one page.
- Retiring a check, or deleting a test, from the app.
- An agent that writes the change: it reads the failed samples and
  proposes the wording. The capability in `src/trials.ts` is what it would
  call.
- Splitting the `Orchestrator` page.

## Open

1. Cases on the claim or on the page? Built: on the claim.
2. Should a claim with trials take its status from the count? Built: no.
3. A trial holds a run on another strut, so a turn that orients with a
   peer's lookup sees nothing there. Built that way. Or let reads on a peer
   run?
4. The frozen session's versions. Built: a turn on a kept prompt does not
   observe the pages rendered into the one it was handed (1). The other
   option was for the session to keep its first turn's versions and report
   those.
5. Keep on a page from git on a deployed strut: refused, as built, or the
   server takes the page over (clears its stamp) and stops following git
   for that page?
6. A real work's verdict and a trial's are drawn as the same dot. Should a
   person's own conversations be set apart?
