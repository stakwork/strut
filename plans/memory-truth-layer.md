# Memory facts on the truth layer

Every memory fact is a claim with world time on it (when it was true) and a
trail of evidence behind it (who or what backed it or contradicted it, and
when). Whenever a fact is read, its evidence is weighed by who said it and
how fresh it is for that kind of fact, and the read says what the agent
should do with it: **state** it, **cite** its source, or **ask** first. It
is the same `Claim`, `Evidence` and `Check` model strut uses to verify its
own work (`claims.md`, `job-claims.md`).

Status: proposed. Builds on `graph-memory-plan.md` (temporal edges,
`assert`), #541 (`observed_at`, merged), #552 (trust on read) and #523
(soft delete). Neo4j, swarms and Hive are unchanged.

## Why

Today a fact's trust is read from what its edge holds: the people among
its `sources`, `last_confirmed_at`, and the edge type's volatility (#552).
That is a second, private version of the truth layer, and it cannot hold
what the truth layer can:

- **Evidence from something other than a person.** A calendar event, a
  contact card or an email can back or contradict a fact. Today there is
  nowhere to put it.
- **A refutation.** "That was never true" can only end or delete the edge.
  As evidence it is a strength −1 from the user, kept, and it wins.
- **One record per mention.** `sources` is a set: when each person said it,
  and in which message, is lost.
- **A question waiting on someone.** An external check's planned slot is
  already the shape of "ask", filled by the user's answer.
- **One "why do I believe this".** Peel's panel and strut's claims views
  can show the same list: who or what said it, when, for or against.

## Two kinds of time

- **When it was true in the world** (`valid_at`, `invalid_at`): stays on
  the fact edge. The words give it ("I moved in September"); evidence does
  not.
- **How fresh the reason to believe it is**: the newest supporting
  evidence's `observed_at`. Decay works off this, against the edge type's
  volatility.

A static fact (a birthday) still has a claim and evidence: who said it
decides between "14 March" and "3 June". Only the decay does nothing, since
old evidence for a static fact is as good as new.

## The mapping

The vocabulary is jarvis's and is already seeded on every Ladybug graph
(`seed-types.ts`).

| Memory today | On the truth layer |
|---|---|
| A temporal edge `Kate -[LIVES_IN]-> Porto` | Kept as the fact's shape: slots, supersede, history, search and traversal stay as they are |
| — | One `Claim` per fact edge: `claim_text` = the edge's text, `fact_ref_id` = its ref_id, `Claim -ABOUT-> Kate` |
| `valid_at` / `invalid_at` | Stay on the edge |
| `created_at` / `expired_at` | Also `belief_valid_from` / `belief_valid_to` on the claim |
| A source in `sources` (`said_by`, a message, a run) | One `Evidence`: `evidence_mode: asserted`, `observed_at`, `Claim -EVIDENCED_BY {strength: +1}-> Evidence`, `Evidence -HAS_SOURCE {authority_level: owner \| self \| other}-> Person` |
| `last_confirmed_at` | The newest supporting evidence's `observed_at` (the column stays, kept in step) |
| "That was never true" | Evidence from the user, strength −1 |
| A message read again (`rereadOnly`, #552) | The evidence id is a hash of (claim, message, sayer): reading it again writes nothing |
| `ask` | An external check's planned slot on the claim; the user's answer fills it |
| — (new) | Instrument checks: a step that reads a calendar, contacts or email and returns `{ supports, content }` |

The edge stays because every read and write of memory is built on it. The
claim sits beside it as its record of evidence.

## What a fact read returns

Two fields say what the evidence supports and what to do about it, and the
numbers and evidence behind them come with them.

**`status`**: what the evidence says. The claims words where they fit, so
it stays one vocabulary.

| `status` | Meaning |
|---|---|
| `supported` | Strong, fresh, uncontested |
| `disputed` | A rival value is close |
| `stale` | The newest evidence is old for that kind of fact |
| `hearsay` | Only someone other than the user and the subject said it |
| `unknown` | Too little to go on, for example only the agent's own guess |
| `refuted` | The user or a check said it is false |

`supported`, `stale`, `unknown` and `refuted` are already `claimStatus`
values; `disputed` and `hearsay` are new.

**`stance`**: what the agent should do with it.

| `stance` | Meaning | Example |
|---|---|---|
| `state` | Say it as fact | "Kate lives in Porto." |
| `cite` | Say it with its source | "Kate told me in September she's in Porto, though Sam said Lisbon." |
| `ask` | Check before using it; the answer becomes evidence | "Is Kate still in Porto?" |

From status to stance:

| `status` | `stance` |
|---|---|
| `supported` | `state` |
| `disputed`, `hearsay` | `cite` |
| `stale` | `cite`, or `ask` once currency is low enough that it is probably out of date |
| `unknown` | `ask` |
| `refuted` | not used; shown only with history |

**Acting moves `cite` up to `ask`.** The read cannot know what the agent is
about to do. A fact that is fine to mention with its source in chat is not
fine to act on: sending a gift to an address that is `cite` means asking
first. The agent's prompt carries this rule, not the read.

### How an agent uses stance

The same rules go in Peel's prompt and in the strut tool notes, so any
agent reading facts follows them:

1. **A specific question whose fact is `ask`**: answer with what is known,
   then check. "Where does Kate live?" → "Last I heard Porto, but that was
   two years ago. Still there?" Never refuse to answer.
2. **A general question**: build the answer from `state` and `cite` facts.
   Leave `ask` facts out, or flag them briefly as possibly out of date.
   "What's going on with Kate?" gets what is current, and at most one
   question at the end, only if it matters to the answer.
3. **About to act** (send, book, update): `ask` blocks. Check that one fact
   before acting.
4. **Never hold an answer back** waiting on questions, and ask at most one
   question per reply.

Also returned, as #552 does now: `belief` (0–1, from who backed it),
`currency` (0–1, from how fresh the newest backing is), `evidence` (each
piece: source, kind, mode, strength, time) and `rival` (the competing
value, when there is one). `planned` stays a flag: a fact that begins
later.

```json
{ "status": "disputed", "stance": "cite", "belief": 0.9, "currency": 0.98,
  "evidence": { "sayers": [{ "name": "Kate", "kind": "self" }], "last_confirmed": "2026-09-01" },
  "rival": { "target_ref_id": "lisbon", "belief": 0.7 } }
```

### How the status is worked out

`claimStatus` stays as it is for steps, workflows and jobs. A fact is a new
subject kind, `{ kind: "fact", ref_id }`, with its own pure rule,
`factStatus`, built from `fact-score.ts`:

- **Belief** from the supporting evidence's sources, each distinct source
  once, weighted by `authority_level` (owner 0.95, self 0.9, other 0.7)
  and by mode (an `observed` check counts at least as much as the user's
  word). Many messages from one person are one source.
- **Currency**: 0.5 per half-life since the newest supporting evidence,
  after a 14-day grace period, by the edge type's `volatility`. Computed,
  never stored, no sweep job.
- **Refutation wins**, as in `claimStatus`: newer evidence against it from
  the user or an observed check makes it `refuted`.
- **Rivals**: on a one-value slot, support for one value is evidence
  against the others, read that way and never written. An ended value
  replaced by a less trusted source stays in the running.
- **Thresholds** (first guesses, tuned on the benchmark): the best value's
  share under 0.6 is `disputed`; currency under 0.6 is `stale`, and under
  0.25 it asks.

## Expectations: the evidence we'd expect

A claim says what is true; an expectation says what evidence should keep
appearing while it is. The gap between the two is the strongest signal of
all: expected activity present is support, even if nobody restates the fact;
expected activity gone quiet is evidence against, long before time decay
would notice. Volatility becomes the fallback for claims nothing can check.

An expectation is a `Check`, declared once on the type and applied to every
claim of it, which is how strut already tests its own work:

```json
{ "edge_type": "WORKS_AT", "cardinality": "one", "volatility": "stable",
  "expects": { "step": "hive/activity", "every_days": 7, "window_days": 30 } }
```

- **The step** is an ordinary strut step given the fact's subject and value.
  It returns `{ supports: true, content }` (the expected activity is there:
  +1 observed evidence), `{ supports: false, content }` (the source is
  readable and quiet: −1, weaker), or `unavailable` (we cannot see that
  source: no evidence, so silence we could not have heard means nothing).
  That last case is the claim layer's "a check that cannot run writes
  nothing, never a fail".
- **A scheduled pass** (an automation, like the verify pass) runs the
  expectations whose last result is older than `every_days`. Reads stay pure
  and fast; they just see more evidence.
- **Asking is the same machinery.** `stance: ask` opens an external check on
  the claim (a check with no step: the user is the source), as a planned
  slot, so an answered question is not asked again and an unanswered one is
  not asked twice.

| Claim | Expects | Present | Quiet |
|---|---|---|---|
| Tom works at Stakwork (Hive) | `hive/activity`: his commits, PRs and messages there over 30 days, weekly | "14 PRs, 120 messages" → `supported`, `state`, though nobody has said it since 2025 | "No activity in 30 days" → `stale`, `ask`, within weeks, not years |
| Kate is working on Atlas | `github/mentions` of Atlas by Kate over 14 days, weekly | supported | `ask` after two weeks |
| Tom lives in Leeds (Peel) | `calendar/places`: events near Leeds over 90 days | supported | only with a calendar connected; without one, `unavailable`, and decay carries it |
| A birthday | nothing | — | silence is neutral: static |

| Strut verifying its own work | Memory with expectations |
|---|---|
| A Claim about a step or workflow | A Claim about a fact |
| A Check: a step that tests it | An expectation: a step that looks for the expected activity |
| `policy`, `freshness_days` | `every_days`, `window_days` |
| The verify pass writes `observed` Evidence | A scheduled pass writes `observed` Evidence |
| A check that cannot run writes nothing | `unavailable` writes nothing |
| Status on read, never stored | Status and stance on read, never stored |

Expectations also replace `depends_on` (a gym on where someone lives): that
was one narrow case of "something related changed, so doubt this", which an
expectation states directly ("expect gym check-ins near home").

## Examples

**Kate's address**

1. **1 Sep.** Kate tells you she has moved to Porto. Claim C1, Evidence E1
   (Kate, self, +1). The next week: `supported`, **state** — "Kate lives in
   Porto."
2. **October.** Sam mentions Kate is back in Lisbon. Claim C2, Evidence E2
   (Sam, other, +1). C1 is `disputed`, **cite** — "Kate told me in
   September she's in Porto, but Sam said Lisbon."
3. **Two years on, nothing since.** C1 is `stale` and its currency is low,
   so **ask** — "Is Kate still in Porto?" Your "yes" is Evidence E3 (you,
   owner, +1), and it is back to **state**.
4. **Sending her a gift** while it is still `disputed`: the agent is about
   to act, so it asks — "Porto or Lisbon for Kate's gift?"

**Other kinds of ask**

- **A fast-changing fact gone quiet.** "Working on the launch", last said
  six months ago, before drafting a status update: "Are you still on the
  launch?"
- **Hearsay about you.** Sam says you've joined Globex: "Sam mentioned
  you've joined Globex. Is that right?"
- **A planned change whose date has passed.** "You were moving to London in
  June. Did that happen?"
- **The agent's own guess.** Peel inferred you're vegetarian from one
  booking: "Should I keep it vegetarian?"

**A birthday**, told once five years ago, is still **state**: who said it
matters, its age does not.

## The work

Each step is one PR and leaves the system working.

| # | PR | Repo | What | Needs |
|---|---|---|---|---|
| 1 | Facts on claims and evidence | strut | #557: a Claim per fact (its id a hash of subject, edge type and value) and an Evidence per mention, written by `assert`; reads return `status`, `stance` and the evidence, falling back to `sources` for older facts; volatility on the edge rule; the four stance rules in the tool notes. Before merge: an `ended` assert writes no supporting evidence; `refuted` on `graph/assert` writes −1 from the speaker; deleting a fact clears its claim's evidence; `depends_on` dropped (expectations replace it) | — |
| 2 | Soft delete | strut | #523, with its deleted-edge filter added to #557's slot read | Evan's review |
| 3 | Peel | peel | Prompt: pass `observed_at` and `volatility`, follow `stance` by the four rules, "that's wrong" is `refuted` and "I used to" is `ended`; the panel's "why I believe this" (the evidence list); re-pin strut | 1 |
| 4 | Expectations as checks | strut | `expects` on the type, the check step contract (supports, quiet, unavailable), a scheduled pass that writes observed evidence, and `ask` as an external check's planned slot | 1 |
| 5 | First real checks | strut, peel | `hive/activity` for Hive; calendar, contacts and email once Peel has the connectors | 4, connectors |
| 6 | Home sync and backfill | strut | Sync carries memory's claims and evidence (only those for facts; strut's own claims stay out); facts from before claims gain them | 1 |

A live-model check (the benchmark stories through the real model) runs
after step 3, with an API key. A test in Peel on a throwaway profile
(6 Nov) passed every story but one: a correction ("that's wrong, I'm not
vegan") was written as an `ended` assert and read as the user backing the
fact, which step 1's fixes close.

## Costs and risks

- **Nodes.** One Claim per fact and one Evidence per mention: tens of
  thousands of nodes at personal scale, fine for Ladybug as long as
  Evidence is not embedded (seed types are `embed: true` today).
- **Two records of one mention.** `sources` and the Evidence rows hold the
  same thing until every reader reads Evidence. Writing both in one
  transaction keeps them in step; dropping `sources` is a later cleanup.
- **Home sync** copies the `entity` and `record` roles only, so memory's
  claims would not reach Home without step 6. Strut's own workflow claims
  live in the same graph and must stay out.
- **Two status rules.** `claimStatus` gives a verdict on versions;
  `factStatus` gives a graded result over time. Both share the evidence
  rows, `newestFirst`, the per-check streams and refutation-wins, and should
  not be forced into one function.
- **A question nobody answered is asked again.** Until step 4 (planned
  slots), nothing records that the agent asked, so a user who ignores
  "still in Porto?" can be asked it on the next read. A benchmark story
  covers it; the planned slot is the fix.
- **Decay only works on what it can see.** A fact has to be a temporal
  edge (not a note or a Concept page) to be scored at all, and its edge
  type needs the right volatility. A type with none reads as `stable` (a
  three-year half-life), so something that changes in weeks, said on
  1 January, would not look stale by November. The prompt has to ask the
  model to set volatility when it makes an edge type.
- **Thresholds are guesses.** The 0.6 and 0.25 cut-offs and the trust
  weights come from the synthetic benchmark; the live-model check (after step 3)
  and real use will move them.

## Open questions

- Should "Kate moved" (the world changed) and "Sam was wrong" (the claim
  was false) be told apart by the model when it writes, or only on read
  from who said what? This plan reads it.
- Does an observed check's evidence outrank the user's word, or only break
  ties?
- Hive: Jarvis already has claims with speakers and bitemporal validity.
  Is a fact claim on Ladybug the node shape Hive would want, so the layer
  can be shared later?
- Claims about entities that aren't facts ("Kate is reliable") are out of
  scope here, but `Claim -ABOUT-> Kate` would hold them.
