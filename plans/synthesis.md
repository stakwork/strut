# Synthesis: the box's work reaches the canvas as it happens

Status (2026-11-25): a plan, nothing built. The owner chose the scope that
day, four items, out of a review of Recent Work (stakwork/strut#886), the
canvas package and the dream. Strut's part is items 1 and 3. The canvas
package's (stakwork/strut-canvas) is items 2 and 4. Each open question has
a default.

Companions: `plans/recent-work.md` (the index this extends) and
`plans/package-seams.md` §2 (the `on:` entries item 3 adds to).

## The ask

The owner: *"the nodes being added to the canvas in real-time dont really
know your latest jobs, PRs etc … or even not just yours, but any recent
work in your stadeum instance."* *"any jobs or PRs need to be synthesized
into the canvas. And the canvas itself needs to be cleaned up
(de-duplicated) - this shouldnt just happen with "dreams" at night, but
ALL THE TIME"*.

## Two kinds of thing

- An **index** is worked out when it is read. Recent Work is one: it is the
  person's, it changes every minute, and nothing of it is stored.
- A **synthesis** is written: a job put on the card it built, a duplicate
  card removed. It happens when the work does, says who and why, and can
  be undone.

Recent Work stays an index (items 1 and 2). The canvas gets synthesis
(items 3 and 4). The dream is not used: it changes Concept pages only
(ruled 2026-11-11), and canvas cards are outputs.

## What is there today

| | Today |
| --- | --- |
| Recent Jobs (`job/recent`) | The person's own jobs only ("Never another person's"): title, id, repositories, working now. Nothing it delivered. `job/list` already lists every job here to any run |
| The canvas and jobs | `stadeum/canvas/work` puts a job on a card when the card's `Feature.jobs` lists it (only `implement` writes it, through `job-started`) or the job's title or first input carries the card's ref_id. A job started from a chat, the Code app or by another person never shows |
| Duplicate cards | `write` skips a card whose text is the same after case and spaces, and refuses an initiative of the same name. A near duplicate (a call rephrased, a misheard word) is written |
| Packages hearing things | `on:` runs a package's workflow when a node of a type is created, updated or deleted. A job's end is not heard: strut's own types (`StrutJob`, `StrutArtifact`) are left out, and the strict manifest refuses an `event:` entry |
| A job's end | createStrut's `wakeOnEnd` hears every job turn's end (`job` and `builder`) and reads its title, status, reply and deliverables for the wake (`wakeEndOf`) |

## 1. Recent Jobs: everyone's, with what each delivered (strut)

`job/recent` fills as `app/recent` does:

- The person's jobs first (ones they launched a run under: `actors`),
  newest used first. Then the box's other jobs, newest used first, up to
  the page's 8. A launch with no person gets the box's newest.
- `what` says whose it is and what it delivered: `yours` or `<name>'s`
  (`people.names` on `createdBy`; `another person's` when no name is
  kept), the id, the repositories, `working now`, and its newest
  deliverable. A pull request reads `owner/repo#n` with its state as the
  job last reported it (`prOf`, src/pr-checks.ts). Anything else reads as
  its title. No call to GitHub: the step has 2 s.
- `link` is the pull request's address when there is one.
- `JobIndex.list` gains `artifacts: true`, which adds each row's current
  deliverables (the fold `q` already reads). `GET /jobs` is unchanged.
- The `Recent Jobs` page's description says it lists the box's jobs, the
  person's first.

Nothing new is shown: `job/list` already lists every job here to any run.
#886 is not deployed, so `job/recent` changes in place. This replaces
`plans/recent-work.md` §5's Jobs row and its open question 3 ("no jobs"
for a launch with no person); that plan is updated when this is built.

## 2. Recent Initiatives (canvas)

A page in the canvas package's `concepts/`, named `Recent …` as strut's
three are, since a Concept's name is its identity:

```markdown
---
name: Recent Initiatives
description: The canvas's initiatives, the person's first.
step: stadeum/canvas/recent
parents:
  - Recent Work
---
Every initiative: `graph/find` with `node_type: "Initiative"`. One with
everything under it: run `stadeum/canvas/canvas` with `mode: "read"` and
`about` its ref_id.
```

`stadeum/canvas/recent` (`effect: "read"`) lists the live initiatives:
the person's own first (`author` is them: one they made by hand), then
`active`, then `planned`, newest first. Removed and dropped ones are left
out. Each item: `name` its name; `what` its status, whose (`you started
it`, `on the canvas`) and its description; `at` when it was made; `link`
its canvas link.

On a strut before #886 the page's `step` is dropped and the page is left
unattached, which does no harm. It works once #886 is on strut's `stable`.

## 3. `event: job.ended` (strut)

An `on:` entry may name an event in place of an op:
`{ event: job.ended, workflow: link }`. There is one event, `job.ended`,
and the strict manifest refuses any other, as it refuses all of them
today.

- **When:** a job turn ends, where `wakeOnEnd` already hears it: a run of
  `job` or `builder` under a job, whatever its status, whether or not a
  conversation is woken. A job that takes another turn ends again.
- **Input:** `{ event: "job.ended", job, run, workflow, status, title?,
  text?, artifacts: [{ title, kind, url?, summary? }] }`. `text` is the
  job's reply, cut as the wake cuts it. It is read once, for the wake and
  the event.
- **As whom:** the job run's person (its actor, else its principal), on
  their bill, launched detached like any `on:` run.
- **The guards are `on:`'s:** nothing without a person. A job run that
  carries an `on:` mark never fires that package's entries, and counts
  toward `ON_CHAIN_MAX`. Nothing for a trial's run or a run on a Concept
  branch: both are tries, not changes to the box. A job that ended on
  another strut (`POST /conversations/wake`) fires nothing here.
- **What a person sees:** the run says it was started by `on: job.ended`
  and by which run.

It names no package and no kind of job. Stadeum's planned
`actor.removed` takes the same key later.

Where: `src/packages/format.ts` (the entry), `src/packages/on.ts` (an
event's match beside `matches`), `src/createStrut.ts` (fired from the
run-end path `wakeOnEnd` sits on), `docs/packages.md`,
`plans/package-seams.md` ("`event:` entries are not built").

## 4. The canvas keeps itself in step (canvas)

One page, one helper, two workflows and a change to `write`.

**The page, `Canvas Upkeep`,** under `Canvas Planning`: when two cards
are one (the same need in other words; not when one is narrower), and when
a job's work is for a feature (it built part of it; planning or talking
about it is not). The judge reads it with `context/concept`, so a person
or the dream can change it, and the workflows carry no prompt.

**The helper, `steps/_similar.ts`:** the words two texts share (lower
case, short and common words dropped) as a score from 0 to 1, and a
threshold. Code only, the same on Neo4j and LadybugDB. It finds
candidates. A model decides.

**`write` returns near matches.** After a write, each new card is scored
against the live cards of its type in its initiative, which `write` has
already read. Over the threshold, the output gains `similar: [{ ref_id,
text, like: { ref_id, text, by } }]` and its `text` a line: `requirement
"X" is close to "Y" (<ref>): if they are one, edit Y and delete X.`
Nothing is refused, so there is no retry loop.

**`tidy`, on every new card.** In `strut.yaml`:

```yaml
on:
  - { created: Initiative, workflow: tidy }
  - { created: UserStory, workflow: tidy }
  - { created: Requirement, workflow: tidy }
  - { created: Milestone, workflow: tidy }
  - { created: Feature, workflow: tidy }
```

`on:` fires a second after a run's last write, as the person whose run
wrote. So a call's chunk is tidied while people talk, and a card a person
adds by hand is checked too. The workflow:

1. `tidy-candidates` (code): the new card against the older live cards of
   its type in its initiative (an initiative against the others). Nothing
   over the threshold ends the run with no model call.
2. `llm` with a schema and the `Canvas Upkeep` page: for each candidate,
   the same card or not, and why.
3. `tidy-apply` (code): removes the newer card of a pair judged the same,
   only when a model wrote it and nothing links to it but its parent (no
   requirement under a story, no feature satisfying a requirement). It
   uses the canvas's own removal, so Restore puts the card back, and
   `removed_reason` names the card kept. Anything else is left as it is,
   and the run's output says why.

A person's card is never changed or removed, as the canvas rules already
say. Brainstorm questions and options are not tidied: the options under a
question are meant to differ, and `brainstorm-check` already holds the
tree's shape.

**`link`, at every job's end.** In `strut.yaml`:
`- { event: job.ended, workflow: link }`.

1. `link-candidates` (code): stop when the turn failed, or when it
   delivered nothing but canvas cards (`kind: graph`). Score the job's
   title and its deliverables' titles against every live feature's name
   and description (`graph/find`). Stop when the job is already on a
   feature (its `jobs` lists it, as `implement` writes), or nothing is
   over the threshold. Keep the top 5.
2. `llm`, with the same page: which of them this job built part of, if
   any.
3. `job-started` for each: appends the job to `Feature.jobs`, which
   `work` already reads. Running it twice changes nothing.

Work that matches no card is linked to nothing, and nothing is created
from a job. Once linked, the card shows the job's pull requests and their
state as `work` reads them today, so a merge or a failing check shows
with no further writes.

Whoever's job ended, or whose run wrote the card, pays. A run with no
candidate calls no model.

**Ordering.** A strut before item 3 refuses the whole canvas manifest
once it holds an `event:` entry. The canvas's CI tests against strut's
`main`, and boxes follow strut's `stable`. So the `link` entry lands last,
after item 3 is on strut's `stable`.

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Scope | Items 1 to 4 | owner, 2026-11-25 |
| 2 | Recent Jobs | The box's jobs, the person's first, each with what it delivered | owner, 2026-11-25 |
| 3 | How a package hears a job's end | An `event: job.ended` entry in `on:` | owner, 2026-11-25 |
| 4 | When the canvas is tidied | After each write and each job's end, not nightly. The dream is not used | owner, 2026-11-25 |
| 5 | Who finds and who decides | Code finds candidates; one model call decides, only when there are some | proposed |
| 6 | Where the judgment lives | The `Canvas Upkeep` page, not the workflows | proposed |

## Open questions, each with a default

1. **A person's duplicate, or one with cards under it.** Default: left
   alone, and the run says so. Later, a proposal the person accepts on the
   card.
2. **Candidates by shared words only.** Default: words. Graph search's
   ranking by meaning would also catch a paraphrase, but a card written a
   second ago has no vector yet (the embedding pass writes it later).
   Revisit with the recorded calls' cards.
3. **What a job is linked to.** Default: features only. A requirement is
   met through its feature.
4. **Work that matches no card.** Default: nothing is created.
5. **`job.ended` on every turn.** Default: every turn. `link` stops when
   the job is already on a card.
6. **How often the Recent Work section changes.** With the box's jobs in
   it, `working now` and `at` change more often, so the section is sent
   again more often: at most once in 5 minutes per person, the steps'
   keep. Default: as it is.

## Work items, in order

1. **strut:** `job/recent` fills from the box and shows each job's
   deliverable; `JobIndex.list { artifacts }`; tests for a person with no
   jobs, their own first, a pull request shown, and no person. The
   `Recent Jobs` page and `plans/recent-work.md` §5. Before #886 deploys.
2. **canvas:** the `Recent Initiatives` page and `stadeum/canvas/recent`,
   with a case in `package.test.ts`.
3. **strut:** `event: job.ended` in the manifest, `on.ts` and createStrut.
   Tests: it starts the entry as the job's person with that input; nothing
   without a person, in a trial, on a branch, or for the package's own
   mark; an unknown event is refused. `docs/packages.md`,
   `plans/package-seams.md`.
4. **canvas:** `_similar.ts`, `write`'s `similar`, the `Canvas Upkeep`
   page and `tidy`; then `link`, once item 3 is on strut's `stable`. The
   code steps tested directly in `package.test.ts`, the judge with a
   scripted stand-in model.
5. **Check with a real model** on a scratch strut with the canvas. Replay
   the 00:03 call's chunks (`call-addc3b7cc6c78da6`) and count the near
   duplicates with and without `tidy`. Start a job from a chat, not from
   `implement`, whose title names a feature and which returns a pull
   request, and see it on that feature's card.

## Not in this plan

- The dream run more often, a budget on an initiative, simulations: the
  review's later items.
- `stadeum/github`'s Repositories page, for pull requests made outside
  strut.
- Setting a feature `done` when its pull requests merge. `work` already
  shows the build's state; the status stays a person's to set.
