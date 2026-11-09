# Checks for memory facts

Memory facts are claims with a trail of evidence (#557): who said a fact,
when, for or against, and a trust read that says whether to state it, cite
it or ask. Today the only evidence is what people say. This plan adds the
third piece of strut's truth layer, the `Check`: a way to go and look for
the evidence a fact should keep producing while it is true, as strut already
looks for evidence that its own workflows behave (`claims.md`).

Status: proposed. Builds on #557 and `memory-truth-layer.md` (#555). Neo4j,
swarms and Hive are unchanged.

## The idea

Two questions per kind of fact:

- **What evidence would we expect?** While someone works somewhere, they
  talk about it, meet about it, commit to its repos. A birthday produces
  nothing ongoing.
- **What evidence do we have?** Look for it, in a window.

The gap is the signal. Expected activity present backs a fact nobody has
restated; expected activity gone quiet is evidence against it, weeks before
time decay would notice; a source we cannot see says nothing. Time decay
stays as the fallback for facts nothing can check.

## The model

The same three nouns strut uses for its own work, and nothing new in the
ontology: `Claim`, `Evidence`, `Check` are seeded on every Ladybug graph.

```
Check { id: hash(edge type), name, step_type: "graph/check-chats",
        step_config: { expects: "the fact comes up in chats", window_days: 30 },
        freshness_days: 14, policy: "on_change" }

Claim "Tom works at Stakwork"
  ├─EVIDENCED_BY {+1}→ Evidence  Tom said it             (asserted, 2025)
  ├─EVIDENCED_BY {+1}→ Evidence  Sam's email             (asserted, Jun 2026)
  └─EVIDENCED_BY {+1}→ Evidence  12 messages this month  (observed, today)
                          └─PRODUCED_BY→ Check (above)
```

- **One Check per kind of fact**, not per fact, found by a hash of the edge
  type. The model writes its expectation in plain words when it makes the
  edge type, as it sets `volatility`.
- **Its step** is an ordinary strut step with one contract:
  ```
  input:  { subject, edge_type, target, text, since }
  output: { supports: true | false, content } | { unavailable: true }
  ```
  found is +1 `observed` evidence, quiet is −0.5, unavailable or an error
  writes nothing, as a check that cannot run never fails a claim.
- **Its evidence** links `PRODUCED_BY` to the Check, so editing a check
  supersedes it and retiring one stops its evidence counting, as for
  workflow checks.

## When checks run

No janitor. Strut runs a check when its subject runs and the check's
policy fires (`policyFires`, `verify.ts`): `on_change` fires when the
newest evidence is older than `freshness_days`. A fact does not run, but it
is read, and a read is when its truth matters:

```
read finds a fact ─▶ score it now from the evidence it has ─▶ answer
                                   │
          type has a Check, its newest evidence older than freshness_days,
          not already queued, under the per-read cap?
                 │ no ─▶ done (most reads)
                 │ yes
                 ▼
   background: run the Check's step ─▶ found  +1 ┐
                                    ─▶ quiet −0.5├─▶ Evidence ─▶ the next read sees it
                                    ─▶ can't see: nothing
```

- At most one check per fact per freshness window, however often it is
  read. A fact nobody reads is never checked: nobody is relying on it.
- The read never waits; the next one sees the result.
- `manual` and `sample` policies carry over. An explicit "check this now"
  (`graph/verify-facts`, like `verify_run`) runs one on demand.
- `ask` gets the same treatment: a read whose stance is `ask` opens one
  open question on the claim (an external check's planned slot), unless one
  is open; the read reports `open_check`, so the agent does not ask twice,
  and the user's answer (new evidence) closes it.

## Sources

A check is a step, and the step decides where it looks:

| Source | Where | First step |
|---|---|---|
| Peel's chats | Peel's `sphinx/search` device read, answered by the user's Mac | `graph/check-chats`: the fact as a search ("Stakwork"; "Porto from:Kate") over the window |
| A swarm graph | Hive: commits, PRs, people already in the graph | `hive/activity` |
| Connectors | calendar, contacts, email, as Peel connects them | `calendar/places`, `contacts/card`, … |
| Anything | a model with the read tools granted, guided by the expectation text | `graph/check-fact` (model-judged, `asserted`) |

Adding a source is one step with the contract, and pointing a type's Check
at it. Only a short finding is stored ("12 messages mentioning Stakwork this
month"), never the data read. Usage (`ACCESSED`: the agent reading a node)
is not a source: a fact being read a lot does not make it true.

## Examples

| Fact | Check | Found | Quiet |
|---|---|---|---|
| Tom works at Stakwork (Peel) | chats mention Stakwork, 30 days, every 14 | `supported`, `state`, though nobody restated it | `stale`, `ask` |
| Tom works at Stakwork (Hive) | his commits and PRs there, 30 days, weekly | supported daily by his work | `ask` within weeks of him leaving |
| Kate is working on Atlas | Atlas PRs or issues by Kate, 14 days | supported | `ask` after two weeks |
| Tom lives in Leeds | calendar events near Leeds, 90 days | supported | only with a calendar connected; without, unavailable, decay carries it |
| A birthday | none | — | silence is neutral |

## The work

One PR, after #557:

1. Check nodes per edge type: made by `graph/assert` from the model's
   expectation, kept the first time (never overwritten), found by hash.
2. The step contract, and `graph/check-chats` as the first step, through
   `sphinx/search`.
3. The trigger in `graph/graph-search` and `graph/graph-neighbors`: stale
   facts with a Check queue their check in the background, deduplicated and
   capped; `graph/verify-facts` for on demand.
4. Evidence `PRODUCED_BY` the Check; the trust read treats a check as its
   own kind of source (`check`), and a quiet newest check makes a fact
   `stale`, `ask`.
5. Open questions for `ask`: the planned slot, `open_check` on the read,
   closed by the next evidence.
6. Tests: found, quiet, unavailable, not re-run before it is due, one
   question asked once and closed by the answer.

Later, one small PR each: `hive/activity`, the calendar and contacts
checks, and the model-judged `graph/check-fact`.

## Open questions

- **How rough is a chat search?** "Stakwork" coming up backs "works at
  Stakwork", but a search cannot tell "I love my job at Stakwork" from "I
  left Stakwork". Found counts as support and quiet as weakly against;
  contradictions stay with what people say. A model-judged check could read
  the matches.
- **Cost of model-judged checks.** They run under the verify pass's spend
  caps (`STRUT_VERIFY_BUDGET_USD` and the per-day cap); the cheap
  deterministic steps should come first.
- **Device reads in the background.** `sphinx/search` waits on the user's
  Mac; with the Mac away a check is unavailable, which is the safe answer.
