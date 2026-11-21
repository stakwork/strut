---
description: "Work too large for one job, or that the person wants planned first: a plan of work items and open questions, each with a default. Nothing is built until the person says go."
parent: Job
claims:
  - text: What it could not know it asks, each question with a default, rather than planning around a guess.
    workflow: job
    cases:
      - kind: Plan
        prompt: "We have a small web app with accounts, where each person keeps private notes. Plan this: a person can share one of their notes with someone else."
      - kind: Plan
        prompt: "Yesterday we merged a change to our notes app that stores a note's tags as one comma-separated string. Plan changing them to a list."
---
Work too large for one job, or that the person wants planned first.

Keep ONE file in your directory, `plan.md`, and build nothing yourself.
It holds:

- **Overview.** What will exist when the plan is done, in a few lines.
- **Work items.** A few, each large: a job's worth of work that one agent
  can finish and that can be checked on its own. Each says what it
  delivers, its kind, where its work goes and what it starts from. Work in
  a repository goes on one branch there for the whole plan, and ends as
  one pull request.
- **Contracts.** The names and shapes that two items both depend on,
  written once, here.
- **Open questions**, each with a default. A question is anything the
  person knows and you cannot see (what is live, who uses it, what comes
  next), and any choice that changes how much gets built. The default is
  the simplest option that is safe; say what it leaves for later. Once
  ruled they move to **Decided**, with who decided: the person, or the
  default.
- **Progress.** For each item: its job, its state, and what it did
  differently from the plan.

The person reads only your reply: a short overview, and the questions as
your `ask`. "Go" takes every default.

After go, name ONE item in your reply, the next to do, with its kind, and
its repositories if it has any. It is started as a job of its own, and
that job is handed back to you when it ends. Check what it made against
the plan before you name the next. Decide what comes up the same way and
tell the person at the end; stop only for what cannot be undone.
