# The dream: learning from what the person said

> **Status (2026-11-10): v0 built on `feat/dream-cycle`, not merged.** The
> system workflow, the four `dream/*` steps, lessons on the truth layer and
> the `strut/dream` app. Tested on a Ladybug graph under Peel's reader lists
> with a stand-in model (`src/graph/dream.test.ts`,
> `src/graph/dream-run.test.ts`, `src/apps/dream.test.ts`). Not yet run on a
> real memory. Left for later is under "Not in v0".

## The idea

The assistant already remembers facts as it talks. Nothing looks back. The
dream is a system workflow, like `tidy-memory`, that runs between
conversations: it reads the turns no dream has read, records what the
person corrected, and changes memory to match.

A correction is kept on the truth layer memory facts already use
(`claims.md`, `memory-checks.md`), with no new type:

```
Claim {id: "lesson…"}  "Keep summaries to three lines"
  ├─EVIDENCED_BY {−1}→ Evidence  "too long, keep summaries to three lines"  (session c-1, turn 4)
  ├─EVIDENCED_BY {−1}→ Evidence  "again, too long"                          (session c-1, turn 9)
  └─EVIDENCED_BY {+1}→ Evidence  "yes, exactly like that"                   (session c-1, turn 12)
```

- A **lesson** is a Claim: one sentence that should hold. Its id starts
  `lesson`, so a read tells it from a fact's claim.
- Each piece of **evidence** is one turn: the person's words, −1 when the
  turn shows the lesson broken, +1 when it shows it kept. The turn is the
  edge's `context`.
- How often a lesson was corrected or kept is **counted on read**, never
  stored. A lesson corrected again after a page was changed for it is a
  fix that did not hold.

## What runs

`src/workflows/system/dream/`: installed at boot with its automation off
(daily, 04:00), as every system workflow is.

1. `dream/turns` reads the conversation index for the turns after each
   conversation's mark, oldest first, capped (60). Wakes are skipped; a
   turn in flight stops that conversation there. The first dream reads the
   last 14 days only.
2. With no new turns the run ends here, with no model call.
3. One agent, stamped "janitor", with the lesson steps, the graph reads,
   and `graph/assert`, `graph/edit-node`, `graph/create-triplet`,
   `graph/move-node`. No delete, no merge. In order: record lessons;
   correct a fact the person said is wrong (`refuted` or `ended`); for a
   lasting preference, change one line of the page under `Personal` that
   covers it, or add a page. At most 10 writes to facts and pages.
4. `dream/done` moves the marks. A dream that fails before it reads the
   same turns again; a lesson's evidence is found by its turn, so nothing
   is written twice.
5. The run's output: the report, the lessons as they stand, the turns
   read, the cost.

The marks are bookkeeping, so a file (`<dataDir>/dream/state.json`) and
never the graph.

## The app

`strut/dream`, first-party, seeded beside `strut/views`. The dream's runs,
a Run now button, and for the picked run: what it changed, the lessons
with the turns behind each, and every step the agent took (its
transcript). It is granted the `dream` workflow's runs and no step, so it
shows what the run itself could read. On Peel an app's page reads the
`shared` namespace only; the lessons are in `private`, and reach the page
in the run's output.

## Not in v0

- **Capture in the turn.** The assistant does not note a lesson as it is
  corrected; the dream finds it afterwards.
- **Proposals and undo.** The dream's writes apply. A page edit is in the
  history (`concept-history.md`); a refuted fact is kept as false. Neither
  has a button to take it back yet.
- **Checks on lessons.** Nothing looks at new turns to see whether a
  lesson was followed; `for` counts only what the person said.
- **A hierarchy of lessons**, other sources (calls, builder chats), other
  subjects (workflows, tools, apps), and anything beyond one person.
- **Reaching the running conversation.** The DM keeps its first turn's
  system prompt, so a page changed by a dream is in the prompt after `/new`.
