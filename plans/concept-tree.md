# Concept tree: Products → repo → features

> **Status (2026-10-27): ruled.** From one design conversation with the
> owner. The rows in "Decided" marked **ruled** are his; the rows marked
> *proposed* are mine, and he agreed with them ("i agree with your leans").
> Written against strut `main` @998beb8 and stakgraph `main` @86732320. The
> work lands mostly in stakgraph's lab (`mcp/src/lab/concepts/`, the
> workflows that make Concepts from PRs); strut's piece is one step in the
> orchestrator's prompt. **BUILT the same day**: items 1–2 in
> stakwork/stakgraph#1819 (`concepts/pages`, the sweep wiring, the Explore
> line), item 3 in stakwork/strut#364. Two things differ from the text
> below, both marked *as built*: the Concept schema (jarvis's, `Thing`'s
> attributes) has no slot for a second property, so both hashes ride in
> the one stamp; and a page a person edited is still an INPUT of the root,
> so the overview follows the edit. **Ruled after, the same day** (decision
> 12, built into the same PR): the bootstrap names the doc files, with the
> listing and a one-time pick as the fallbacks for repositories
> bootstrapped before. Companion to `semantic-search.md` (what a Concept
> is in the graph), the `linked` filter in `src/graph/search.ts` (which Concepts explore reads)
> and the seeded roots in `src/concepts/` (`Job`, `Workflow Builder`).

## Problem

The lab's concept workflows (`bootstrap-then-process` →
`process-repo-chronological` → `process-change`) turn a repository's PRs
and commits into `Concept` nodes: one per user-facing feature, with
`repo: "owner/repo"` as a property, an id like `owner/repo/auth-system`,
`TOUCHES` edges from the PRs and `MODIFIES` edges to the files. They are a
flat set. No `PARENT_OF` edge touches them.

Every Concept READER strut has walks `PARENT_OF` from a root:
`context/concept` renders a page and the kinds under it into a prompt, the
orchestrator routes a request by the children of `Job` and `Workflow
Builder`, a job agent opens a kind's page before it acts. So the code
knowledge (what each repository is, what its features are) and the agents'
Concept tree (what to do here, how) sit in one database as two graphs that
never meet. An orchestrator asked "what does this team build?" has nothing
to read; a job agent about to explore `stakwork/strut` has no page that
says what strut is, where its AGENTS.md is, or what its features are called.

Nothing in the graph summarizes a repository, and nothing summarizes the
workspace. The feature pages exist; the two levels above them do not.

## Decided

| # | Decision | Who |
|---|---|---|
| 1 | Three levels: a `Products` root, one Concept per repository under it, the existing feature Concepts under each repository. `PARENT_OF` parent → child, as every reader walks it. | **ruled** |
| 2 | A repository page's docs are distilled from the repository's essential docs: README, AGENTS.md, CLAUDE.md. The root's docs combine every repository page into one description of what the workspace (the team) builds. | **ruled** |
| 3 | The workflow owns all three levels. `Products` is NOT a strut-seeded page: a seed always matches git and every boot would put the committed text back over the generated one (`concept-seed.ts`). The lab's sweep creates it when it is missing. The rule that strut owns the root Concepts was about the per-agent roots (`Job`, `Workflow Builder`); this is the one exception, named here. | *proposed* |
| 4 | Pages are distillations, never copies. A page rendered into a prompt is capped at 6k chars (`context/concept`); strut's AGENTS.md alone is ~60k. The full file stays reachable where it is (the code graph's `File` node, the checkout). | *proposed* |
| 5 | When to rewrite is decided by CONTENT HASH, never a threshold, a timer or a model's judgement: a page is a function of its inputs, the hash of the inputs is stamped on it, and the end of every sweep recomputes and rewrites only when the stamp differs (§3). The first sweep after this lands finds no stamp on any existing repository, which is the migration. | *proposed*, agreed |
| 6 | A repository page depends on the doc files at HEAD plus its features' NAMES and DESCRIPTIONS, not their docs. The sweep rewrites the docs of every modified feature every run (`concepts/summarize`); a page that depended on them would churn every sweep for nothing. The root depends on its children's name, description and docs, so a rewritten repository page reaches it and a feature-docs-only sweep does not. | *proposed*, agreed |
| 7 | A page a person edited in the graph is left alone and reported, never overwritten (the `keepEdited` contract packages have, `src/packages/install.ts`). Detected by a second hash, of the text as written. | *proposed*, agreed |
| 8 | Repository and root pages carry NO `repo` property. Every reader of features filters on `f.repo` (`getAllConcepts(repo)`, hive's per-repo list through `GET /gitree/concepts`, `collect-for-eval`, whose output an eval scores against the gold set), so the new levels are invisible to all of them without a change. A repository page's id is `owner/repo` (two segments; a feature's has three). | *proposed* |
| 9 | The tree is RECONCILED at the end of every sweep from the `repo` property, in one idempotent statement, rather than written edge by edge as features are created: it reparents every feature of the repository, existing ones included, and a feature created mid-sweep by `concepts/decide` needs no code of its own. | *proposed* |
| 10 | Nodes and edges for the two page levels go through strut's graph seams on `ctx.services.graph` (the node writer by (type, name), `edges.write({ edge: "PARENT_OF" })`), the way `seedConcepts` writes them, so every reader (the live-edge filter, `children: PARENT_OF`, the embedding pass by `node_key`) sees them exactly as it sees a seeded page. Feature nodes keep the lab's own `saveConcept`. | *proposed* |
| 11 | The doc files are read at HEAD through the GitHub contents API with the token the sweep already holds, never from a clone: the clone exists only for a brand-new repository (`bootstrap-then-process` skips `clone` otherwise, `repoPath` is undefined on every later sweep). | *proposed* |
| 12 | **Which files**: the BOOTSTRAP names them. Its agent already explores a clone on the first run; its output gains `docFiles` — the files that describe the repository as a whole — recorded per repo in `ConceptsMetadata`, and `pages` reads exactly those on every sweep. A repository bootstrapped before the pick existed falls back in order: the root (and `docs/`) listing matched against `docNames` case-insensitively, any extension; then, when nothing README-like is there, the bootstrap's pick run ALONE on a fresh clone, once — its record, empty or not, stops the asking. The repository's SHAPE (manifests at the root, the root listing) is always read too. Never an agent choosing files on every sweep: its choice would drift, every sweep would read as "inputs changed", and the cost bound would go. | **ruled** ("prioritize the very first run: bootstrap and then create the tree") |

## 1. The tree

```
Products                               one per workspace; no repo
├── stakwork/strut                     one per repository; no repo; id = owner/repo
│   ├── Workflow Runs                  the feature Concepts as they are today;
│   ├── AI Workflow Builder            repo = "stakwork/strut", id = owner/repo/slug
│   └── …
├── stakwork/hive
│   └── …
└── …
```

- **`Products`**: `node_type: Concept`, `name: "Products"`, a fixed name
  like `Job` and `Workflow Builder`, so a reader finds it by name
  (`graph-get { node_type: "Concept", name: "Products", children: "PARENT_OF" }`).
  Its children are the repository pages. Its `description` is one line on
  what the team builds; its `docs` the combined overview (§2.2).
- **A repository page**: `name: "owner/repo"` (the `node_key` jarvis derives,
  `concept-ownerrepo`, is stable and never collides with a feature's unless
  a feature is literally named "owner repo"); `id: "owner/repo"`; no `repo`
  (decision 8). Its children are the repository's features. Its
  `description` is one line on what the repository is; its `docs` the
  distillation (§2.1).
- **A feature page**: unchanged. One `PARENT_OF` from its repository page,
  reconciled from `f.repo` (decision 9).
- **Stamps**: both page levels carry `unique_source_id`, the property the
  seeder uses for ownership + hash. *As built*: `lab/concepts/<name>@<inputHash>.<textHash>`
  — the second hash, of the page's text as written (decision 7), rides in
  the same stamp, since the Concept schema declares no property for it
  and the node writer refuses an undeclared one. Strut's seeder treats a
  stamp with another prefix as someone else's and skips the node, so the
  two writers never fight.

What the tree does not change: feature ids, `TOUCHES` and `MODIFIES`,
hive's per-repo concept list, the eval harness's gold comparison. Hive's
knowledge-graph view, which lists Concepts with no repo filter, gains the
two levels and their edges, which is the point.

## 2. What the pages say

### 2.1 A repository page

Inputs, read at HEAD (decision 11): the doc files (decision 12: the
bootstrap's recorded pick, else the listing's README-like matches against
`params.docNames`, else a one-time pick on a clone), each capped at 40k
chars; the repository's shape (the manifests at its root, 4k each, and the
root listing); and the features under the page, each as `name —
description`. `docNames` is a workflow `params` entry, the experiment
surface, like every prompt in these workflows; the bootstrap prompt's
paragraph that asks for `docFiles` is in `bootstrap-then-process`'s params.

Output, from one model call (`summarizer`'s free-text path): a
`description` (one line, what the repository is, for the root's list and
the orchestrator's routing) and `docs` (≤ 6k chars, markdown): purpose,
how it is run, the shape of the code an agent must know, the conventions
that matter, and where the full docs are (the files by path). No feature
list in the docs: the children ARE the list, and `context/concept` renders
them. The prompt is `params.repoPageSystem`.

### 2.2 The root

Inputs: every child's `name`, `description` and `docs`, sorted by name.
Output: a `description` (one line) and `docs` (≤ 6k chars): what the team
builds, how the repositories relate (which is the product, which the
infrastructure, which serves which), in the words an orchestrator routes
by. The prompt is `params.productsSystem`.

## 3. When a page is rewritten

```
inputHash(repo)     = sha256( sorted doc files + shape as "<name>\0<body>"  ‖  sorted features as "<name>\t<description>" )
inputHash(Products) = sha256( sorted children as "<name>\t<description>\t<docs>" )
textHash(page)      = sha256( description ‖ "\n" ‖ docs )   as last written by the step
stamp               = lab/concepts/<name>@<inputHash>.<textHash>   (12 hex each, in unique_source_id)
```

At the end of every sweep, for the repository just swept and then for the
root:

1. Compute `inputHash`. Read the page (by name).
2. No page → write it, stamped. (The migration for an existing workspace: every repository gets its page on its next sweep, the root once the first does.) A page under the name with no stamp of ours — a person's — is `foreign`: left alone, reported, still the parent of what hangs under it.
3. Page with the same stamp → nothing.
4. Page whose stamped text hash ≠ the hash of its current text → a person edited it: leave it, report `edited` in the step's output. The stamp stays old, so the report repeats until someone takes the edit back or deletes the page. *As built*: the edited page is still one of the ROOT's inputs, so the overview is rewritten over the person's words — the edit reaches it instead of being hidden from it.
5. Otherwise → one model call, write, restamp. A repository with no doc files and no features gets no page (`empty`); the root stays a placeholder until a child gives it something to say.

Then reconcile the edges (decision 9): `PARENT_OF` from the repository page
to every Concept with that `repo`, through the edge writer (idempotent on
`edge_key`); `PARENT_OF` from `Products` to the repository page.

Cost: at most one call per repository per sweep and one for the root,
against the hundreds of decision calls a sweep makes; the sweep's cadence is
the throttle. Three GitHub reads for the doc files. A workspace whose N
repositories are swept one after another rewrites the root up to N times
that day; each is one call, and the hash makes the N-th a no-op when the
N-1 before it changed nothing. Usage is recorded on the repository's
running total like the sweep's (`concepts/record-usage`).

Why a hash and not: a threshold (misses the one PR that rewrote the
README; fires on thirty that touched nothing the page reads), a timer
(works when nothing changed, lags when it did), or a model's "changed
enough?" (a second judgement to tune, which the eval harness would then
have to score). The sweep already works this way one level down:
`collect.modifiedConceptIds` is the dirty set and `concepts/summarize`
rewrites exactly those.

## 4. Where it runs

One new step, `concepts/pages` (`steps/pages.ts`, seeded like the others
in `seed.ts`), after `summarize` in `process-repo-chronological`, so every
path that sweeps a repository reaches it (`bootstrap-then-process` subflows
the sweep after the bootstrap, so the first run is bootstrap → features →
pick recorded → sweep → tree; a direct run of the sweep is covered too):

```yaml
  - id: pages
    type: concepts/pages
    config:
      owner: "{{ input.owner }}"
      repo: "{{ input.repo }}"
      docNames: "{{ params.docNames }}"
      repoPageSystem: "{{ params.repoPageSystem }}"
      productsSystem: "{{ params.productsSystem }}"
```

Output: `{ repoPage, products, reparented, unparented?, docs: { source,
files }, usage }`, each page `written | unchanged | edited | foreign | empty
| skipped`, `source` one of `record | listing | identified | none`. `root`
(default `Products`) names the root page, for a test over a shared graph;
`identify: false` turns the one-time clone-and-pick pass off. `record`'s usage list
gains `"{{ pages.usage }}"`. The step reads the doc files through
`services.github(token)` (the `GITHUB_TOKEN` secret, as `fetch-content`
does), the features through `storage.getAllConcepts(repoId)`, and writes
the pages through `ctx.services.graph` (decision 10). A workspace with no
graph on the services bag (unit tests) gets `skipped` and no failure.

Pure parts, tested offline: the two hash functions, the edit detection, the
decision table of §3 (`pages.test.ts` beside the step's tests). One live
test against the throwaway Neo4j: a repo with two features → the three
levels and four edges; a second run → no writes; a feature renamed → the
repository page restamped and the root restamped; a hand-edited root →
`edited` and untouched.

## 5. Who reads it

- **The orchestrator** (strut, `src/workflows/orchestrator.yaml`): a third
  `context/concept` beside the two it has, on `Products`, `docs: true`
  (the overview is what routing by repository needs), `tool: ""` as the
  others. `params.productsConcept: Products`. On a workspace with no root
  the step returns `{ text: "" }` and the prompt is as it was. A session's
  prompt is its first turn's, so the page reaches new conversations only,
  as every change to that prompt does.
- **A job agent exploring** (lab, `lab/job/concepts/Explore.md`): one
  line: before exploring a repository, open its page under `Products`
  (`graph-get { node_type: "Concept", name: "<owner>/<repo>", children:
  "PARENT_OF" }`) and start from what it says and the features it lists.
- **Hive**: nothing. The per-repo list is feature-only as before; the
  knowledge-graph view shows the tree because it filters nothing.
- **The `linked` filter** (Concepts relevant to code, by `MODIFIES`): the
  pages have no `MODIFIES` and stay out of it, correctly.

## 6. Not in v1

- An edge from a repository page to the code graph's `Repository` node
  (stakgraph writes one per ingested repo, with a `documentation` property
  of its own). No reader starts from code and looks for a page today; the
  page's name identifies the repository. When one does, it is one edge
  written in `concepts/pages`.
- Pages per directory or package inside a monorepo. A repository is the
  unit the sweep knows.
- A way to re-run the bootstrap's pick for a repository that already has a
  record (a `docs/` folder added after the pick). Clearing `docFiles` on the
  repo's `ConceptsMetadata` makes the next sweep pick again; a route or a
  step for that comes when someone needs it.
- The orchestrator reading an individual repository page's docs. It reads
  the root; a job it starts opens the repository page.
- Name collisions between two repositories' features (both named
  "Authentication" compute one `node_key`; `saveConcept` already warns
  and leaves the second unstamped). The tree does not fix it and does not
  make it worse; the edge from each repository makes it visible.

## Work items

1. **stakgraph lab: the step and the sweep** — `concepts/pages`, its
   params and wiring in `process-repo-chronological.yaml`, the seed entry,
   the offline and live tests (§3, §4).
2. **stakgraph lab: the Explore page line** (§5). One commit beside item 1.
3. **strut: the orchestrator's third page** (§5), its own small PR; lands
   in the lab at the next strut bump. Independent of item 1 (an absent root
   is an empty section).
