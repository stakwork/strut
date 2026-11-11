# The dream: keeping a tree of Concepts in step with what people say

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
Concept and do what it says?). This plan is the first. The walk is its own.

The assistant may save facts as it talks (Peel grants it the graph tools;
strut's own orchestrator has none). Nothing looks back. The dream is a
system workflow, like `tidy-memory`, that runs between conversations: it
reads the turns no dream has read and asks of each correction or
preference "was this already on a Concept?". If not, it adds it. If it was,
it works out why the assistant got it wrong anyway. It keeps what was said
and where, so a correction that comes back shows the fix did not hold.

## Four parts

- A **tree**: a root Concept and the Concepts under it (`PARENT_OF`). A
  Concept is a Concept: how something is done.
- A **claim**: one sentence a Concept should say, `ABOUT` the Concept that
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
| `missing` | No Concept said it | Add the line |
| `not_opened` | A Concept said it, and the assistant did not open that Concept | Move it where it is found |
| `not_followed` | It opened the Concept and still got it wrong | Reword it, put it first |
| `contradicted` | A Concept said the opposite | Change the line |
| `followed` | Nothing: it did as the claim says, or the person confirmed it | — |

The first and fourth are store failures; the second and third are what the
walk needs to hear about. `not_opened` is read from the graph: the
projector writes `StrutRun -ACCESSED-> Concept` for every Concept a run
opened, and `dream/turns` puts them on each turn. Without that the dream
says `not_followed`.

A **cause** is not a fifth part: it is a claim not holding. Claims of one
kind go under a parent claim ("Add nothing unrequested" and "One example
is not a template" under "Build only what was asked"); the parent holds no
evidence, and its counts are its children's. One level. This is what keeps
the tree from filling with one line per remark: the Concept gets one general
line for the group.

Nothing is counted in the graph: `corrected` and `kept` are read off the
evidence. There is no separate check either. New evidence is the check: a
correction on a claim after its Concept was changed is a fix that did not
hold.

The context also names the source, the place in it (`session`, `turn`,
`run`), who said it, and the dream's own run. That run, with the claim's
Concept, finds the history commit that changed the Concept
(`concept-history.md`): which edit answered which claim, and when.

## What runs

`src/workflows/system/dream/`: installed at boot with its automation off
(daily, 04:00), as every system workflow is. Its input is the tree's
settings, so a second tree is a second automation:

- `root` (default `Personal`): the tree it tends.
- `review` (default false): every change to a Concept or a fact is a proposal
  a person decides. Claims and evidence are never gated.

Three rules shape it. Nothing unbounded goes in a prompt: a model reads the
capped batch of turns, or one thing with the few candidates picked for it,
never every claim or the whole tree. Code finds, counts and decides when;
a model judges small things. One job per model call, with no tool but its
answer, so it cannot skip a step or write.

| Stage | Who | Reads | Makes |
| --- | --- | --- | --- |
| `turns` | code | the turns after the tree's marks, capped (60) | the batch |
| FIND | model | the batch | moments: the turn, the words, one sentence that should hold, its kind, whether it was said to last |
| `candidates` | code | the claims and the tree | for each moment, the few claims and Concepts nearest it, and the Concepts its turn opened |
| MATCH | model | each moment with its candidates | which claim (or a new one, on which Concept), and the outcome |
| `record` | code | the sorting | the evidence, checked against the tree |
| FACTS | model, memory's tools | the moments that are facts | a wrong fact refuted or ended |
| `neighbours` | code | the claims | for each claim touched, the few it might be one kind with |
| GROUP | model | those | groups |
| `due` | code | the counts | the claims due a fix: a correction since the last fix, AND said to last or corrected twice (a group together) |
| FIX | model | each due claim, what was said, its one Concept | one edit: a line added or replaced, or a new Concept |
| `apply` | code | the edits | the Concept written (or a proposal), and the fix noted on the claim |
| `done` | code | | the marks moved |

A stage with nothing to do is skipped, so a dream with no new turns and
nothing due calls no model. `candidates` and `neighbours` pick by shared
words (`concept-claims.ts` `nearest`): a stand-in for search, and the seam
a real one replaces. It need not be exact, since GROUP catches a claim
that MATCH made twice. `due` is why one remark changes nothing, and why a
claim fixed and corrected again is fixed again: by replacing its line.

A fix is noted on its claim (an Evidence of its own kind, never counted as
something said): when, which Concept, the line. That is the claim's fix time,
so "came back after its fix" is read off the graph.

The marks are bookkeeping, so a file per tree
(`<dataDir>/dream/<tree>.json`) and never the graph. Each tree has its own:
two trees may be fed by the same conversations. They move only at the end:
a dream that fails reads the same turns again, and evidence is found by its
turn, so nothing is written twice.

The run's output is what each stage did: the moments found and how each
was sorted, the Concept edits (lines lost and gained, for which claim), what
was passed over and why, the tree's claims and Concepts as they stand, and
the cost.

## The app

`strut/dream`, first-party, seeded beside `strut/views`. A viewer: it
starts no run. A run an app launches reads what an app may (on Peel,
`shared` alone) and could not see a private tree, so the dream runs from
its automation, as one of strut's own jobs, and `dream/turns` refuses a run
that cannot read its tree before anything is read or sent to a model. The
Concept lists the dream's runs, and for the picked run, from the outcome back:
four numbers (turns read, corrections found, Concepts changed, claims that came
back); what changed, a Concept at a time, as the lines it lost and gained with
the words that caused them and what the assistant did there; the causes
(claims, groups with theirs under them, the most corrected first, each
marked new, came back, kept or quiet); the tree as it stands, each Concept
marked with what the dream did to it and how many claims it holds; and every
step the agent took. It is granted the `dream` workflow's runs and no step,
so it shows what the run itself could read. On Peel an app reads the
`shared` namespace only; the claims and the tree are in `private`, and
reach the app in the run's output.

## Not in v1

- **More than one level of groups**, and a separate Cause node.
- **A model reading new sessions** to judge whether a claim was followed.
- **Capture in the turn.** The dream finds a correction afterwards.
- **Undo.** A Concept edit is in the history and a refuted fact is kept as
  false; neither has a button to take it back yet.
- **Other sources** (calls, builder chats, pasted skills): `dream/turns`
  is the one reader, and evidence already names its `source`.
- **Other subjects** (workflows, tools, apps), and **the walk**.
