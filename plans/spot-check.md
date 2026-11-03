# Spot check — where a thing in a run's output came from

Status: BUILDING (2026-11-03). The eval / Cause / proposed-fix half is later.

## The ask

A person reviewing a run picks one thing it made — a number in its Google
Sheet, a sentence in its memo, a node it wrote — and asks "how did the run
get this?". A good answer is the start of an eval; a bad one, later, a
problem linked to its cause.

## What the run log already holds

Everything, for any kind of thing (checked on openlaw-1's run
1793658241194, 2026-11-03):

- Every tool call's INPUT, whole, on its `step.start` (`wrapToolsWithEmit`
  cuts only the output in the event): the cells a `sheets_update_values`
  wrote and their values, the file an editor `create` wrote (113k chars of
  memo source), the command a `bash` ran, the node a graph write made.
- Every tool call's OUTPUT, whole, in its agent's transcript — the
  `messages` on the agent's `step.end`, joined by `toolCallId`.
- The agent's words just before each call, in the same transcript.
- Which graph nodes each call named (`step.end.nodes`).
- Every DAG step's input and output.

So "where did X come from" is a search of one run's log, and every kind of
thing is the same search with a different way to say where it is.

## The model

A SUBJECT is what was picked: `value` (the text as shown) plus, when the
viewer knows it, an ADDRESS — `cell` (a sheet range, with `spreadsheet`),
`node` (a ref_id) or `file` (a path).

The answer is the subject's MOMENTS, oldest first: each time it passed
through the run — a tool call or a step — and which way:

- `wrote`: it was in what went INTO the call (a cell written, a file
  edited, a node created, a command run, a step's config);
- `read`: it was in what came OUT (a document `cat`, a sheet read, a graph
  read, a fetched page, a step's output; the run's own input).

A moment is `exact` when it matched by address (that cell, that node,
that file) and otherwise matched by content (the value's text, numbers in
any of their spellings: `$54,853` finds `54853.4413`). A value too short
to search for (`11`, `3`) is followed by address only.

Each `wrote` moment of an agent carries `why` — the agent's words before
the call — and `before`, the calls it made just before (the two `grep`s
that produced `11`).

A moment in a sheet names its cell; one on a node, the node; one on a
file, the file. Those are subjects of their own: the view opens their
spot check, so the chain is walked one link at a time, by the person. A
cell's formula gives `refs` (the cells it reads) and `literals` (numbers
typed into it, which have no source but the agent's words); a text that
cites cells (`(FACTS!B92)`) gives the same `refs`.

## Pieces

- `src/provenance.ts` — `buildProvenance(events, subject)`, pure, tested.
- `RunsCapability.provenance` + the `run/provenance` step — over the RAW
  log (the capped `run/events` drops transcripts and long fields). A
  `run/*` step: an app reaches it on `grants.workflows`; an agent through
  `agentTools: ["run/*"]` (the later Cause agent).
- `strut/views`: `SpotCheck` (draws the moments, opens a moment's or a
  ref's own spot check); `SheetView` and `DocumentView` take
  `onSpotCheck(subject)` — a cell's "Spot check" in the formula bar, a
  selection's floating button.

## Not covered

- Writes strut never saw: a person's edit in Google Sheets after the run,
  a file a `bash` script wrote without the value in its command (its
  result may still match by content).
- Child runs launched by `meta/run-workflow` (their own logs).
- A value the agent computed in its head and wrote: the chain ends at the
  write, with its `why`. That is what a spot check is for.
