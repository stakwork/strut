# Dream and memory: one learner, concepts first

> **Status (2026-11-16):** proposed by Tom, for Evan's ruling. Nothing here
> is built. Companions: `concept-evals.md` (the dream made automatic),
> `graph-temporal.md` (facts that change over time), `memory-checks.md`.

## Why

Two parts of strut learn from the same conversations. The dream writes
lessons into the Concept tree (the `Personal` tree by default: "how the
people it works for want things done"), and memory saves facts and
preferences into the graph (`Preferences` nodes among them). Each keeps its
own copy true with its own machinery, and nothing reconciles them, so one
lesson can land twice, or the two can disagree.

More sources are coming (dictation, call transcripts). Each should update
memory once, in the right place.

## The model

Memory is the whole graph. Inside it:

| Part | What it is | How the agent uses it | How it stays true |
|---|---|---|---|
| Entities | People, places, orgs, projects, topics | Searched when relevant | Edited, merged |
| Facts | Temporal edges between entities: what is true, and when | Searched or recalled | `assertEdge`: dated, superseded by newer, confirmed by sources; memory checks |
| Concepts | A tree read step by step, like skill files: how a team does tax writing, product design, how Tom wants team notes | Followed: the root's list is always in view, a concept is opened when it applies | The history, claims judged against the work, the dream |

Concepts are the part the agent **follows**; the rest it **looks up**. The
agent can keep searching and adding to memory as it does now.

## The rule: follow or look up

For each lesson: *would the agent need this to do a kind of work right,
without thinking to search for it?*

- **Yes: a concept.** This includes preferences that change how work is
  done ("notes to my team are casual, three lines at most"), since an agent
  does not search memory before writing a note.
- **No: a fact.** "Sam's daughter starts school in September." "The Lisbon
  trip moved to March."
- **Often both.** "Payouts moved from Stripe to Lightning" is a dated fact,
  and it changes a workspace's payments concept.

## The dream is the one learner

1. **Every source is a concept under `Dream`**, as `Assistant
   Conversations` is now. Dictation and call transcripts are the next ones,
   once those sources reach strut.
2. **One pass over a source routes each lesson** to a concept, a fact, or
   both:
   - a concept: as today (the claim, what was said, the change);
   - a fact: asserted with `graph/assert`, so a newer value supersedes the
     old one with dates, and its source is kept;
   - both: the concept's line names the fact it relies on.
3. **The `Dream` concept gains a section, "Concept, fact or both"**, beside
   "Where a lesson goes", holding the rule above.
4. **Peel's own memory saving** stops writing what the dream now writes. It
   either moves into the dream or stays as the fast path for facts alone.

My earlier `feat/dream-cycle` branch had the dream output memory's facts.
This brings that back on Evan's design.

## Open for Evan

- Peel's memory saving: move into the dream, or keep it for facts only?
- How a concept names a fact: an edge from the concept to the fact, or a
  line of text? An edge would let a superseded fact mark the concept's
  claims for a fresh look.
- Facts asserted with review off: the same rule as concepts (automatic,
  inspected through the history)?
- Whose words count: today the dream reads every person's conversations on
  the server (concept-evals.md, "Not built").

## Not in this plan

Testing a change before it lands (an eval workflow over branches),
measuring whether the right concept was opened, a pass that restructures
the tree (merge, move, prune, settle conflicts), and pinning. Each is its
own plan.
