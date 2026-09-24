# Multi-repo features: one chain, not separate agents

> Companion to `federation.md`. Plain-language summary first; the
> engineering notes are at the bottom.

## The problem

A feature that touches several repos gets split into parts, one agent per
repo. Today every agent gets the **same original plan**. If agent A changes
a small detail while building its part, agent B never hears about it, and
the two parts don't fit together.

## The fix

Run the parts as **one chain**, where each agent gets the **previous
agent's actual result**, not the original plan.

```
        Plan
          |
          v
  +---------------------------+
  | 1. Agent A builds part A  |   on repo A's workspace
  |    returns: its PR        |
  |    + "what I changed      |
  |       vs. the plan"       |
  +---------------------------+
          |
          v
  +---------------------------+
  | 2. Reconcile              |   fold A's changes into B's task
  |    (update the plan)      |
  +---------------------------+
          |
          v
  +---------------------------+
  | 3. Agent B builds part B  |   on repo B's workspace
  |    gets: updated task     |
  |    + A's PR               |
  +---------------------------+
          |
          v
  +---------------------------+
  | 4. Integration check      |   do A and B fit together?
  |    (a claim + a check)    |   result is recorded and
  +---------------------------+   re-run on every change
```

## The steps

- **Agent A builds part A** in its own repo and workspace. Besides the PR,
  it must report, in a fixed format, anything it did differently from the
  plan.
- **Reconcile.** A small step rewrites agent B's task with A's changes
  folded in. Optionally it also opens a PR against the plan document, so
  the written plan matches what was actually built.
- **Agent B builds part B** in its repo and workspace, starting from the
  updated task and A's PR, never from the original plan alone.
- **Integration check.** A test that exercises the seam between A and B.
  It is attached to the workflow as a claim, so it runs again automatically
  after every later change and its result stays visible.

## Why this works

- The "message" between agents is a **step result**, not a chat message.
  It is saved, ordered, and visible in the run's event log.
- Deviations are **written down** twice: in A's structured report and,
  when reconcile opens a PR, in the plan itself.
- The check **catches what slips through**, instead of hoping every agent
  read carefully.

## Engineering notes

- Step 1 and step 3 are `strut/run-workflow` (federation.md §2.2,
  dispatch-through) on the org strut, with `depends` ordering them. A's
  "what I changed" is the agent step's `schema` output.
- This pulls dispatch-through forward in federation.md's step order (it is
  last today), and changes one rule there: for a multi-repo feature, hive
  dispatches **one** org-strut workflow that fans out, instead of one run
  per repo.
- The integration check is a claim on the org-strut workflow
  (`plans/claims.md`); the verify pass runs it after every landing run.
