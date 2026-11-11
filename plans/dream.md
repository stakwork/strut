# The dream: keeping a tree of pages in step with what people say

> **Status (2026-11-11): v1 built on `feat/dream-cycle`, not merged.** The
> system workflow, the `dream/*` steps, claims about a Concept on both graph
> engines, and the `strut/dream` app. Tested on a Ladybug graph under Peel's
> reader lists with a stand-in model (`src/graph/dream.test.ts`,
> `src/graph/dream-run.test.ts`, `src/apps/dream.test.ts`); the Neo4j half
> of the store's tests runs where `STRUT_TEST_NEO4J_URI` is set. Not yet run
> with a real model or on a real memory. Left for later is under "Not in v1".

## The idea

Two goals: **store** (does what people say end up in the Concept tree, and
stay right?) and **retrieve and act** (does the assistant open the right
page and do what it says?). This plan is the first. The walk is its own.

The assistant may save facts as it talks (Peel grants it the graph tools;
strut's own orchestrator has none). Nothing looks back. The dream is a
system workflow, like `tidy-memory`, that runs between conversations: it
reads the turns no dream has read and asks of each correction or
preference "was this already on a page?". If not, it adds it. If it was,
it works out why the assistant got it wrong anyway. It keeps what was said
and where, so a correction that comes back shows the fix did not hold.

## Four parts

- A **tree**: a root Concept and the Concepts under it (`PARENT_OF`). A
  Concept is a page: how something is done.
- A **claim**: one sentence a page should say, `ABOUT` the Concept that
  holds it, or should.
- **Evidence**: one thing somebody said that bears on a claim.
- The **dream**: what keeps the other three in step.

The truth layer's own nouns (`claims.md`), and nothing new in the ontology
but two edge rules (`seed-types.ts`): a Claim `ABOUT` a Concept, and a
Claim `PARENT_OF` a Claim.

```
Concept "Writing"
  ▲ ABOUT
Claim "Summaries are three lines or fewer"
  ├─EVIDENCED_BY {+1, missing}→      "too long, keep summaries to three lines"  (session c-1, turn 4)
  ├─EVIDENCED_BY {+1, not_followed}→ "again, too long"                          (session c-1, turn 9)
  └─EVIDENCED_BY {+1, followed}→     "yes, exactly like that"                   (session c-1, turn 12)
```

Each piece of evidence keeps two things apart:

- `strength`, as a fact's evidence has it: +1 the sayer says the claim is
  right, −1 that it is wrong. "Too long, keep summaries to three lines"
  says the claim is RIGHT.
- `outcome`, in the edge's `context`: what the assistant did there.

| Outcome | What went wrong | The fix |
| --- | --- | --- |
| `missing` | No page said it | Add the line |
| `not_opened` | A page said it, and the assistant did not open that page | Move it where it is found |
| `not_followed` | It opened the page and still got it wrong | Reword it, put it first |
| `contradicted` | A page said the opposite | Change the line |
| `followed` | Nothing: it did as the claim says, or the person confirmed it | — |

The first and fourth are store failures; the second and third are what the
walk needs to hear about. `not_opened` is read from the graph: the
projector writes `StrutRun -ACCESSED-> Concept` for every page a run
opened, and `dream/turns` puts them on each turn. Without that the dream
says `not_followed`.

A **cause** is not a fifth part: it is a claim not holding. Claims of one
kind go under a parent claim ("Add nothing unrequested" and "One example
is not a template" under "Build only what was asked"); the parent holds no
evidence, and its counts are its children's. One level. This is what keeps
the tree from filling with one line per remark: the page gets one general
line for the group.

Nothing is counted in the graph: `corrected` and `kept` are read off the
evidence. There is no separate check either. New evidence is the check: a
correction on a claim after its page was changed is a fix that did not
hold.

The context also names the source, the place in it (`session`, `turn`,
`run`), who said it, and the dream's own run. That run, with the claim's
Concept, finds the history commit that changed the page
(`concept-history.md`): which edit answered which claim, and when.

## What runs

`src/workflows/system/dream/`: installed at boot with its automation off
(daily, 04:00), as every system workflow is. Its input is the tree's
settings, so a second tree is a second automation:

- `root` (default `Personal`): the tree it tends.
- `review` (default false): every change to a page or a fact is a proposal
  a person decides (the agent's `approve`). Claims and evidence are never
  gated.

1. `dream/turns` reads the conversation index for the turns after each
   conversation's mark, oldest first, capped (60), each with who spoke and
   which pages its run opened. Wakes are skipped; a turn in flight stops
   that conversation there. The first dream reads the last 14 days only.
2. With no new turns the run ends here, with no model call.
3. One agent, stamped "janitor": `dream/claims`, `dream/claim`,
   `dream/group`, the graph reads, and `graph/assert`, `graph/edit-node`,
   `graph/create-triplet`, `graph/move-node`. No delete, no merge. In
   order: look at the claims and the tree; find each correction; sort it
   into an outcome; record it on a claim that covers it, else group it
   with one of its kind, else make a new one; correct a fact the person
   said is wrong; fix the tree as the outcome calls for. One remark alone
   changes no page. At most 10 writes to facts and pages.
4. `dream/done` moves the marks. A dream that fails before it reads the
   same turns again; evidence is found by its turn, so nothing is written
   twice.
5. The run's output: the report, the tree's claims as they stand, the
   turns read, the cost.

The marks are bookkeeping, so a file per tree
(`<dataDir>/dream/<tree>.json`) and never the graph. Each tree has its own:
two trees may be fed by the same conversations.

## The app

`strut/dream`, first-party, seeded beside `strut/views`. The dream's runs,
a Run now button, and for the picked run: what it changed, the claims
(groups with theirs under them) with what was said for each and what the
assistant did there, and every step the agent took. It is granted the
`dream` workflow's runs and no step, so it shows what the run itself could
read. On Peel an app's page reads the `shared` namespace only; the claims
are in `private`, and reach the page in the run's output.

## Not in v1

- **More than one level of groups**, and a separate Cause node.
- **A model reading new sessions** to judge whether a claim was followed.
- **Capture in the turn.** The dream finds a correction afterwards.
- **Undo.** A page edit is in the history and a refuted fact is kept as
  false; neither has a button to take it back yet.
- **Other sources** (calls, builder chats, pasted skills): `dream/turns`
  is the one reader, and evidence already names its `source`.
- **Other subjects** (workflows, tools, apps), and **the walk**.
