# Work products: what a run makes for a person, first-class

> **Status (2026-11-02): built in one PR, every row *proposed*** — open to
> a ruling. Companion to `live-artifacts.md` (a job tells its HOST what
> changed, ruled 2026-10-15) and `jobs.md` §3 (the deliverables contract,
> `src/artifact-refs.ts`, `specs/CALLBACKS.md` §4). Nothing here changes a
> ruling there: the run's output is still the record, `kind` is still the
> host's vocabulary passed through, a live item is still never the source of
> truth. What this adds is for a PAGE following a run (a strut app), and the
> graph.

## Problem

A demo of a legal matter should show the work products — the issues memo,
the deviation-matrix sheet, the NDA redline, the deal timeline — as the
main thing on screen, appearing while the agent works, each tied to the
Concepts and passages it came from. Today:

| Has | Lacks |
| --- | --- |
| `artifacts: [{ id, kind?, title, path?, url?, content? }]` on a run's output, resolved at `run.end` | kinds for a sheet, a table, a timeline, a Word document, a redline |
| `StrutArtifact` nodes, `HAS_ARTIFACT` / `DELIVERED` (#413) | what a product was made FROM |
| `job.update` to a host while a run goes (`live-artifacts.md`) | anything a PAGE can follow: an app cannot be called |
| `useRunEvents` reads the log incrementally | the artifacts a tool call declared: the log keeps a 1 500-char preview of a tool's result |
| ArtifactView, DocumentView (keeps `<ins>`/`<del>`) | one place that shows a run's products, live |

## 1. Kinds (*proposed*)

Five kinds join the host vocabulary. Each says what `path`, `url`,
`render` and `content` carry:

| Kind | `path` | `url` | `render` | `content` |
| --- | --- | --- | --- | --- |
| `sheet` | a table file (CSV / TSV / table JSON / .xlsx), when there is no live sheet | the live spreadsheet (a Google Sheet) | the table file a page draws, beside the `url` | `{ sources }` |
| `table` | a CSV / TSV / .xlsx / table JSON file | — | — | `{ columns: string[], rows: unknown[][], sources? }`, or an array of row objects |
| `timeline` | a JSON file of the content's shape | — | — | `{ entries: [{ date, title, detail?, sources? }], sources? }`, or the bare array; `date` ISO when it can be |
| `docx` | the .docx | — | its HTML | — |
| `redline` | the tracked-changes .docx | — | its HTML, the changes as `<ins>` / `<del>` | `{ sources }` |

- **`render`** is a new field: a file a page can draw in the thing's place
  — relative like `path`, or a link. `resolveArtifactRefs` resolves it like
  a `path` and leaves it out when the file is not there (the thing itself
  still shows). It is not a second deliverable: `path` / `url` is the thing.
- **Inference** (`artifactKind`, and the kit's copy, `productKind`, held to
  it by a root test): `.docx` → `docx`; `.csv`, `.tsv`, `.xlsx` → `table`
  (`.csv` was `code`). `redline`, `sheet` and `timeline` are always
  declared.
- **Hosts that do not know a kind.** Hive's mapping
  (`services/strut-runs/job-turn.ts`, `mapStrutArtifacts`) checked
  2026-11-02: an unknown kind with a strut-relative `url` (a `path` resolved
  here) becomes a `url` card through the reader (`readerKind`); with an
  absolute `url` a `url` card; with only `content` it is DROPPED, named
  "unsupported content" in the turn's row. Unknown fields (`from`, `render`)
  are ignored (`parseStrutArtifacts`). So nothing breaks, and the contract
  says: a product of these kinds carries a `path` or a `url` beside any
  `content`. One change in Hive: a `.csv` a job lists without a kind was a
  `code` card (its text) and is now a `url` card, until Hive adds `table`.

## 2. Provenance (*proposed*)

- **`from?: string[]`** on an entry: the graph `ref_id`s it was made from —
  the Concepts whose rules it follows, the excerpts it quotes. Kept as
  declared (strings, trimmed, deduped, at most 200), on the resolved ref and
  the job index's fold.
- **`content.sources`** (or the file's own `sources`, for a timeline or a
  table JSON): an item → its `ref_id`s, finer than the product. Keys:
  - a sheet / table: a cell by its address, the sheet's own (`C4`,
    `'Deal Terms'!C4`; row 1 is the header), or a row by its key — its
    first column's text (`"Non-solicit"`): SheetView's keys (#421), so the
    shelf hands `sources` to it as they are;
  - a timeline: an entry's index — or the entry's own `sources`;
  - a redline: a change's index among the render's `<ins>` / `<del>`
    elements, in document order, 0-based. (The sanitizer keeps no attribute
    on either, so an index is the one key a page can find again; a
    `docx/redline` step should number its changes the same way.)
- **The graph: `StrutArtifact -[:DERIVED_FROM]-> any node`**, one edge per
  `from` ref the graph holds (`getNode`; a ref on another graph or since
  deleted gets none). `DERIVED_FROM` because jarvis already uses it for
  exactly this — `ComputedFigure -[:DERIVED_FROM]-> Excerpt` — so "what was
  this made from" is one query over both; declared against `Thing` like
  `ACCESSED` (a wildcard target in the Strut registry), and a rel table on a
  Ladybug file. Add-only like every edge the projector writes: a ref a later
  version drops keeps its edge (the union of the versions). *Open:* prune
  to the newest version's `from` if the union misleads.

## 3. Live, for a page (*proposed*)

- **A step may declare `artifacts` in its own output**, while the run goes:
  a workflow step's `output.artifacts` (an agent's structured reply,
  `output.object.artifacts`), and a TOOL's result — lifted onto the tool
  call's `step.end` as `artifacts` (`liftedArtifacts`; whole entries, a
  `content` over the 50 KB cap left out), because the log keeps only a
  preview of a tool's result. Nothing new for a workflow to write: the
  shape is the deliverable's.
- **`foldWorkProducts(events)`** (kit, `kit/src/folds/work-products.ts`):
  one product per id in the order they first appeared, the newest
  declaration's fields, a declaration repeated as it was not a new version,
  the step that FIRST declared it the one that made it (`pack` and the
  run's output only hand on), and the run's own output (`run.end`) wins —
  nothing after it changes what it said. `useWorkProducts(workflow, runId,
  { live })` folds `useRunEvents`.
- **The record does not change.** `run.end`, `GET …/artifacts`, the job
  fold and `StrutArtifact` still read the run's OUTPUT only. A product a
  step declared that the output does not list is progress, the
  `live-artifacts.md` §5 rule: the page shows it; a host never hears of it.
- *Open:* `notify` (`live-artifacts.md` §3) from the runner for a step's
  declared artifacts on a job run, so a host hears them too (`kind`, the
  resolved `url`, `state: "declared"`). Not built: no host asked yet.

## 4. The shelf (`strut/views` `WorkProducts`) (*proposed*)

One card per product — an icon by kind, the title and summary, `by <step>`
(a tool by its name, a step by its id, "the run"), what it draws on ("2
Concepts · 2 Excerpts", read with `graph/graph-get-batched` when granted,
else "4 sources"), `vN` past the first version. Cards ease in when they
appear and glow when a newer version lands. A click opens the product
under the shelf (`productView`):

| Kind | Opens in |
| --- | --- |
| `docx`, `redline` | DocumentView over `render` (`<ins>` / `<del>` kept); no render: the file |
| `markdown`, `html`, `log`, `code`, `json`, `diff` | DocumentView over the file, or the inline content |
| `image`, `video`, `audio`, `pdf`, `walkthrough` | ArtifactView |
| `timeline` | a dated list, sorted when every date is ISO |
| `sheet` | SheetView over the live Google sheet (`url`; `sheets/get-values` granted), else its table file (`render` / `path`), else rows in `content` — read again while the run writes it and when a step declares a newer version, `sources` marking cells |
| `table` | SheetView over its CSV / TSV / JSON file, or rows in `content` |
| anything with an absolute `url` | its link, opened through the host |

`renderers={{ <kind>: … }}` replaces the viewer for a kind. Under the
viewer, "Made from": the `from` nodes by name and type, each a click
(`onOpenNode`). The gallery's fixture is a legal matter (Project Lantern)
whose memo, deviation matrix (SheetView's NDA sheet, filling in a provision
a read), redline and timeline appear one by one.

## Not now

- A product's own history (each version's content): the page reads the
  file as it is now; a version is a count.
- Per-change provenance drawn in the redline view (marking the nth `<ins>`):
  `sources` is in the contract, DocumentView does not read it yet.
- Hive's renderers for the five kinds (its half, as the contract it reads).
