# Knowledge: the org's knowledge as a strut app

> **Status (2026-11-09): v2 built — every type, not only Concepts (see v2); v2.1 adds a Concept's history and the tree between two moments (see v2.1).** Before that, (2026-11-06): v1 built, then reshaped on the owner's review — the outline tree (option A) on the left; the GRAPH is the main view (no Concept | Graph toggle), each node's chip expands or collapses its neighbours, a click opens the concept in a panel on the right. Read-only: editing was built and then taken out to keep v1 simple (see Later). As built, Copy link is left out: the address bar follows the selection, and a framed page's clipboard is not reliable. Written after a read of strut `main`
> @e2acbb5, Hive's `src/components/graph-workbench/` and stadeum `main`.
> Companions: `apps.md` (apps, grants, `strut/views`), `jamie-app.md` §3, §5
> (first-party apps, how Jamie is seeded), `concept-tree.md` (what the tree
> holds: `Codebase` → repo → features, ~500 Concepts on swarm38).

## Problem

The Concept tree is only visible in Hive's org graph view
(`?view=graph`, `GraphWorkbench`), and that view is going away. Stadeum
frames strut apps and draws nothing itself, so the tree has to become a
strut app. Stadeum then lists it from `GET /apps` like any other app.

## What was checked

- **Seeding.** `strut/jamie` is seeded by `seedBundledApp` (tree hash,
  build cached per machine) after `strut/views` in `createStrut`, behind
  `opts.jamie !== false`. A `strut/` name at a seeded version is
  first-party, so it reads as its viewer. Knowledge reuses the same
  function and gets its own flag, `knowledge: false`.
- **Listing.** `GET /apps` lists every app. Stadeum's `ui/src/lib/apps.ts`
  leaves out only `strut/views` and orders Jamie first, then the rest by
  `title`. An `app.yaml` with `title: Knowledge` shows up in stadeum's
  sidebar as "Knowledge" with **no stadeum change**. strut's own
  `MemberApps` lists it the same way.
- **Reads, backend-neutral.** Hive reads its own `/graph/*` routes. Strut
  already has steps that answer the same question on Neo4j and on
  Ladybug, so the app needs no raw Cypher (`graph/query` and `graph/walk`
  are backend-specific or LLM-driven, so they are not used):
  - `graph/find { node_type: "Concept", limit, cursor }` pages every
    Concept: ref_id, name and properties, `description` and `docs`
    included.
  - `graph/graph-edges { ref_ids (≤1000), among (≤5000) }` returns every
    edge among them in one call. The app keeps the `PARENT_OF` edges.
  - `graph/graph-get-batched` (`useNode`) reads the selected Concept fresh.
  - `graph/graph-search` (`NodeSearch`) and `graph/graph-neighbors`
    (`NodeGraph`).
- **Concept attributes** (`src/graph/seed-types.ts`): `name`,
  `description`, `docs` (markdown), `repo`, `file`, `alt_names`.
- **Deep link.** `useToolInput()` gives `?input=concept%3D<ref_id>`. The
  app reports a selection with `host.openLink(useAppLink()({ concept }))`.
  A link to the same app is sent in place (`app-host.ts`), so the host's
  address bar, and stadeum's via `strut:location`, follows the selection.
- **Reuse from `strut/views`.** `NodeSearch`, `NodeGraph`, `useNode`, and
  `DocumentView { text, kind: "markdown" }` for docs (react-markdown +
  GFM, links through the host). The colours come from `nodeColor`.
- **Not in the kit:** `@dagrejs/dagre`, which Hive's `TreeCanvas` lays
  out with. `@xyflow/react`, `motion` and `react-resizable-panels` are in
  the kit.

## Decision for Tom: how the tree is drawn

| | A. Outline tree (recommended) | B. Hive's canvas, ported |
|---|---|---|
| Look | A left pane of indented rows, like a file tree, with Hive's node language: amber dot (filled = has docs, hollow = none), chevrons, counts, the selected row and its path to the root lit | React Flow, left to right, 196×38 cards, smoothstep edges, "+3" side toggles |
| Phone | Works: the tree is a list; the detail opens over it | Pan/zoom canvas, which is poor at 375px |
| Cost | No new dependency | Needs dagre added to the kit's vendor layer (a kit release) or a hand-written tidy-tree layout |
| Graph view | `NodeGraph` (React Flow) is the toggle either way | same |

The brief asks for "a left pane with expand/collapse", which is A. B is the
literal port of `TreeCanvas`. **I'd build A** and keep Hive's look in the
rows and the detail. B can come later if the canvas is missed.

## v1 (read-only)

Layout. Wide: a toolbar across the top, the tree on the left (a fixed
~320px), the detail on the right. Narrow (<768px, the rule Jamie uses):
the tree fills the page, and a selection opens the detail full-width with
a back button.

1. **Toolbar.** `NodeSearch type="Concept"` (picking a hit selects it,
   expands its ancestors and scrolls it into view), the selected concept's
   path (`Codebase › strut › Apps`, Hive's `PathLabel`), and a Tree | Graph
   toggle (Hive's `CanvasModeToggle`).
2. **Tree.** Roots are Hive's rule: Concepts with children and no parent,
   biggest tree first. Concepts in no tree are listed in a folded "Not in
   any tree (n)" group at the bottom, so nothing is hidden. Children are
   sorted by name. Expand/collapse is per row, and the set of open rows is
   remembered per viewer (`useAppState`). A Concept with several parents
   shows under each parent, and the path uses the first. Only open rows
   mount, so a tree of a few thousand stays light. Keyboard: ↑ ↓ to move,
   ← → to fold and open.
3. **Detail.** Name, path, `description`, then `docs` drawn with
   `DocumentView kind="markdown"`. If there are no docs, Hive's line:
   "Nothing written on this concept yet." Then Parents and Children as
   chips that select, `repo` and `file` when set, and Copy link.
4. **Graph mode.** The main area swaps to `NodeGraph refId={selected}`
   (all edge types), at full height. A click on a node there selects it
   when it is a Concept.
5. **Deep link.** `input: { concept: <ref_id> }` selects and reveals that
   concept on open, and each selection reports it back. An unknown id
   gives a plain notice and the tree.
6. **States.** "Reading the graph…", a graph error (including "no graph on
   this server") as a notice, "No concepts yet", and Hive's "too big to
   read in full" when the cap below is hit.

**Reading the tree.** On open: `graph/find` pages of 200 Concepts
(properties included; docs are capped near 6k chars, so a page stays well
under `step_run`'s 5 MB), then `graph/graph-edges` in chunks of 1,000
`ref_ids` with every Concept as `among`. With about 500 Concepts that is 3
finds and 1 edges call. The cap is 5,000 Concepts (`among`'s limit); past
it the notice shows. The graph is held in react-query, and the selected
concept is read fresh with `useNode`.

**Files.**
- `src/apps/knowledge/app.yaml`: `title: Knowledge`, `icon: network`,
  `grants.steps: [graph/find, graph/graph-edges, graph/graph-get-batched,
  graph/graph-neighbors, graph/graph-search]`, no workflows, no writes.
- `src/apps/knowledge/src/`: `App.tsx`, `lib/tree.ts` (pure:
  build/roots/path/reach, ported from Hive's `model.ts`),
  `lib/read.ts` (find + edges), `components/{Tree,Detail,Toolbar}.tsx`.
  It imports from `strut/views`.
- `src/apps/knowledge-seed.ts`: `seedKnowledgeApp`, a copy of
  `jamie-seed.ts`.
- `src/createStrut.ts`: seed it after Jamie behind `opts.knowledge !==
  false`. `STRUT_HOST_CONFIG` accepts `knowledge: false`, the same way it
  accepts `jamie: false` (`hostConfigFromEnv`, `src/server.ts`).
- Tests in `src/apps/knowledge.test.ts`:
  - seeded at boot, built against the kit with `strut/views` compiled
    in; a reboot is a no-op; `knowledge: false` seeds none;
  - listed by `GET /apps` with title "Knowledge";
  - a page call to each granted step passes, and a graph write is refused;
  - `lib/tree.ts` covers roots, unplaced Concepts, several parents,
    cycles and the path.
- Docs: `specs/API.md` gets §14.13 `strut/knowledge`; AGENTS.md gets the
  layout line and the apps paragraph.

**Checked in the browser**: a local strut on Ladybug, seeded with about 12
nested Concepts (two roots, three levels, one with several parents, one
unplaced, one with long markdown docs), opened as `?app=strut/knowledge&solo=1`.
Light and dark, at 1280px and 375px: search → reveal, deep link,
graph toggle.

## v1.1 (after the owner's review)

- **Graph first.** The middle of the page is `NodeGraph` round the concept
  picked in the outline, search or link, on `PARENT_OF` only (so every node
  in it is a Concept; cross-links to code or people are for later); the toggle is gone. Edges are
  straight, border to border (`FloatingEdge`), with no handle dots and no
  label when every edge has the same type. Each node carries an expand chip
  (⇕ and the count not yet drawn) that reads its neighbours, and a collapse chip that
  folds away what that expansion placed, and everything expanded past it; the view refits
  after each.
- **The panel.** A click on a Concept node, a row or a chip opens it in a
  panel on the right (✕ closes it; narrow, it takes the page with Back).

## v2 (2026-11-09): every type, not only Concepts

Concepts are one node type; a reader wants to search and walk everything the
org knows — people, documents, decisions, features — and to see the ontology
itself. Chosen from seven prototypes run on a local strut with a mixed demo
graph (an ontology rail, a search-first home, a full-canvas explorer and
mixes of them): the explorer with A's sidebar, no landing page.

- **Sidebar**: one search over every domain type (`graph/graph-search` with
  `exclude_domains: "strut"`; type chips narrow the hits), and under it the
  **ontology**: each type `graph/get-ontology` names that holds a node, with
  its count (`graph/find … count: true`), Concept first. Strut's own
  bookkeeping (`Strut*`) and the graph's plumbing (`Claim`, `EdgeText`, …)
  are never listed (`lib/ontology.ts` `isSystemType`). A type opens its
  nodes: Concepts as the tree, any other type 15 at a time by name, "Show
  more" reading the next page by `graph/find`'s cursor, and a search within
  the type once it holds more than a page — a type with thousands stays
  usable.
- **Graph**: `NodeGraph` round the pick on every edge type. **Types ▾** over
  it ticks node types on and off (`NodeGraph`'s new `hiddenTypes`: drawn or
  not, nothing re-read; a node whose only way back runs through a hidden one
  goes too). `NodeGraph` now also refits when its canvas changes size — a
  page drawn while its frame is hidden was fitted to nothing.
- **Card**: the pick floats on the right — type, where a Concept sits, name,
  description, then its links grouped by how they read from this node
  ("Owns", "Owned by", "Children"; `linkLabel`), each a chip to walk to.
  "Docs and more" widens it to the docs. Narrow, it takes the page and goes
  back to the graph.
- **Trail** along the bottom with Back. The start is the first root concept.
  `?input=node%3D<ref_id>` opens any node (`concept%3D` still read); every
  pick is reported as `node=`.
- Grants: `graph/get-ontology` added, still read-only.

Known gaps: the ⇕ count on a node includes neighbours of hidden types; the
card can cover nodes at the right edge of the graph; search is keyword-only
on a graph with no embeddings.

## v2.1 (2026-11-09): history (`concept-history.md` §8 item 4)

What the Concept tree WAS, read from the history (`history/read`, one more
grant, a read), drawn by `strut/views`' `ConceptDiff`:

- **A concept's History.** The card's **History** button (Concepts only)
  widens it to every commit that changed the page, newest first, followed
  through renames: time, who, the commit's first line, the runs that wrote.
  A click draws what that commit did against the one before it; two ticked
  are compared; "The page then" shows the page as it was. The page's file is
  found from its name (`concepts/concept-<letters and digits>.md`, as the
  node writer keys it), so it is the backend's own namespace's.
- **Changes.** A button over the graph swaps it for the tree between two
  moments: `diff { from, to, path: "concepts" }`, with each page marked
  added, removed, renamed, moved or edited on the tree (a parent that did
  not change drawn hollow, climbing through the live tree), a page opening
  to its name, parents, attributes and docs line by line. From and to are
  typed — `now`, `3 hours ago`, a date, a commit — and open on the last
  day. Beside it, **Recent changes**: the history's last commits on
  `concepts`, each a click into what it did. Never the live change feed,
  which is a notification and empties on a restart. Picking a node in the
  sidebar returns to the graph.
- **No revert.** The plan asked for one (`show` at a commit, then
  `graph/edit-node`), but the app door refuses every page write on a
  Concept, first-party included — the same refusal Editing below meets.
  Recorded in `concept-history.md`'s Open section.

## Later (not built now)

- **Editing** a concept's name, description and docs from the panel. Built
  once and taken out of v1: strut refuses every page write on a Concept
  (`reservedAppType` — agents read Concepts as instructions), so it needs a
  strut-core exception for this app (first-party, a signed-in person, those
  three fields only, as strings, by `graph/edit-node`) and a decision on
  whether members or only admins may edit. Note for the editor: the app's
  frame is sandboxed without `allow-forms`, so it must not be a `<form>`.
- **Revert** a page to a commit (`concept-history.md` ruling 12): the same
  door as Editing, plus `history/read show` for the text.
- **Proposals** drawn as dashed changes (green added, red removed) from
  `proposal/list`, with accept/reject through `proposal/decide`
  (first-party only). `ConceptDiff` already takes a proposal
  (`<ConceptDiff proposal={id} />`: `proposal/get`, the nodes it names,
  the page now, laid over); what is left is the list, and the grants
  `proposal/list`, `proposal/get` and `proposal/decide`.
- **"Ask Jamie about this concept"**: `ui/open-link` to
  `?app=strut/jamie&input=…` with the concept as the draft's `/` mention.
- **Live refresh** through `graph/changes` (`useGraphChanges(["Concept"])`):
  re-read when a Concept or PARENT_OF write lands.
- Hive's Health groups (unplaced, several parents, empty docs, unread) and
  reads counts.
- The canvas tree (option B), if it is missed.
