# Graph memory v1: Peel-first plan

This replaces `plans/memory-in-workspace-graph.md` from strut#369. The product spec is [graph-memory-prd.md](graph-memory-prd.md).

The whole graph is memory: things are nodes, relationships are temporal edges, sources are never edited, Concepts teach and Claims prove. We build it for Peel, and Hive starts only when Peel passes the criteria below.

## Phases

| Phase | Steps | Outcome | What a Peel user sees |
|---|---|---|---|
| 1. Foundation | 1 | Dynamic ontology and writer transactions merged | Nothing |
| 2. Core graph | 2 to 5 | Core attributes, namespaces, temporal edges, `assert`, search rows, reads, `resolve`, `merge` | Nothing |
| 3. Privacy | 6 | Reader lists enforced under every read tool | Nothing |
| 4. Peel on top | 7 and 8 | Workflows, sync and Peel moved over, Concepts and Claims confirmed | Better answers about what's current |
| 5. Prove it | 9 and 10 | Jarvis off Peel's path, live model test passed | Same as phase 4 |
| Later: Hive | Not planned yet | Company memory, if Peel passes every criterion | Not applicable |

Each step lands as its own small PR. Peel keeps using its current memory until phase 4.

## What happens to each PR

All four PRs currently conflict with main, so each needs a rebase whatever we decide.

| PR | Decision | Why |
|---|---|---|
| A, strut#386, dynamic ontology (+1502 −307) | **Keep.** Rebase and merge first | The PRD depends on all of it |
| B, strut#385, writers and read filter (+1261 −113) | **Split.** Merge caller transactions and edge-keeping soft delete. Rework the managed types and reader filter in step 6 | `assert` needs transactions. The "memory" group goes away |
| C, strut#387, memory on the graph (+5010 −1430) | **Don't merge.** Keep the branch as a source to copy from, then close it | It moves Fact nodes into the graph, and that shape is going. Home sync and the memory step tests are worth reusing |
| D, peel#447, graph reads (+156 −27) | **Hold, then rewrite.** Close it when the replacement opens | Its grants carry over, but its prompts and test assume Fact nodes |
| strut#369, plan | **Close** once this plan has a home | It describes the old model |
| peel#424 | **Close** | Replaced by peel#447 |
| strut#366 | **Close**, after a check that nothing in it is still needed | Part 1 shipped in strut#368 |

Nothing has been closed or changed yet.

## Rulings

- **Ladybug's ontology is dynamic** (Evan's review on strut#369; merged as strut#386). This replaces the closed registry in ruling 6 of [ladybug-backend.md](ladybug-backend.md), and the 2026-10-26 ruling that apps declaring types build only on Neo4j (lifted in [apps.md](apps.md)). The rest of ruling 6 stands: one `Node` table, every attribute a real column, one full-text index and one vector index.

## Steps

Peel's current memory keeps working on its own store until step 7, so nothing breaks along the way.

### 1. Land the foundation
- Rebase and merge A.
- Split B, then rebase and merge the writer half.

### 2. Extend the schema

Core attributes are listed under "Core attributes" below.

- On Ladybug, rename `date_added_to_graph` to `created_at`, `Data_Bank` to `search_text` and `node_key` to `key`. Add the rename to `MIGRATIONS` in `db.ts`, and rebuild the text index, so existing Peel files carry over.
- Neo4j keeps Jarvis's names for now: its engine maps them at the boundary, so shared code uses the new names.
- Add `title` and `created_by` as core node attributes. The writer fills `title` from the schema's `title_key` (see "Core attributes"). `name`, `description` and `aliases` stay ordinary type fields.
- Make `title_key` and `description_key` core Schema properties, defaulting to `name` and `description`.
- Add `namespace`, `created_by`, `updated_at` and `deleted_at` to edges.
- Move Claim-only columns off the shared edge columns, onto the edge types that use them.
- Add `role`, `temporal`, `cardinality`, `key`, `identifiers` and `domain` to the core schema properties, `schema-crud.ts`, the resolver and the Ladybug Schema columns.
- Cardinality is a rule on each edge type, never on nodes. An edge type declares `temporal` and `cardinality`, the slot is source node plus edge type, and `assert` reads the rule from the schema. `cardinality: one` means one current edge per source node. One per target isn't in v1 until something needs it.
- Add namespaces to Ladybug. It refuses anything but `default` today. Writes default to `private`.
  - A namespace says who may read the data. `private` is the graph owner's, readable only by the readers the host grants it (step 6). On Peel the owner is one person; a company graph would give each person a namespace of their own (see "Open decisions").
- Seed base types without Jarvis's fixture. The user is an ordinary `Person` marked as the owner, with no separate `Self` type. `Lingo` stays, because dictation reads it.
- Strut's own records keep the `Strut` domain and live in their writer's namespace; Schema rows are file-wide. A namespace says whose data something is; the domain says what kind of thing it is.
- Keep the hard-coded skip list in `graph-neighbors.ts` and `walk.ts` for v1. A `walkable` schema setting can replace it later.
- Add a per-type `embed` setting. Source types (dictation, transcripts, messages) default to keyword search only, with no embedding, so they don't crowd vector results. Entities, Concepts and Claims are embedded.

### 3. Add temporal edges, `assert` and search rows
- Give temporal edge tables the two clocks, a sentence, an embedding and sources.
- Add `assertEdge` in `src/graph/` and a `graph/assert` step. In one transaction: load the schema, then re-confirm, supersede or create. Move the date handling from `remember.ts` and `supersede()` on C's branch, and take the schema-driven shape from Jarvis's `temporal_edge_helper.py`.
- Write a hidden search row with every edge sentence, in the same transaction. End it when the edge ends.
- Refuse plain edge creation on temporal types.

### 4. Update the reads
- Search returns edges as well as nodes, and hides search rows as nodes.
- Reads default to current data, with `include_ended` and `as_of`.
- Search and walk scope by namespace.
- Strut records are filtered by domain, not namespace. The memory tools leave out domain `Strut` by default; the assistant searches everything, so it can find a run, job or workflow.
- Raise `efs` to 500 on vector queries, for recall as the graph grows.

### 5. Add identity
- `resolve`: key, identifier, name and alias, then candidates.
- `merge`: move edges, keep old ids working, record it, allow undo.

### 6. Enforce privacy with namespaces
- Replace `managed_by: memory` with one check under every read tool: each reader has a list of namespaces, plus an optional domain filter, set by the host. A job's list is `shared` with domain `Strut` left out, so it sees no Strut records.
- In Peel, everything is written to `private` by default, and public Concepts go in `shared`. The assistant reads both. Jobs read only `shared`, and get anything else through their brief.
- Keep B's reader rule and raw-query refusal, keyed on the list.
- Every reader gets its own list, including the two outside Peel's chat: apps with graph grants, and peers reading through `/graph/*`. A reader the host hasn't given a list reads nothing.
- A person can move something to `shared` by hand.

### 7. Rebuild the workflows and Peel on top

This is the first step a Peel user notices.

- `remember`, `forget` and `tidy` call the generic tools.
- Concepts need no tool or workflow of their own: the assistant writes them with create and edit node.
- Rebuild home sync from C's code to move knowledge, once we decide what counts.
- Rewrite D: grants, prompts, journey test, and re-pinned `strut.lock`.
- Sync imports are bounded and batched, so a pull never holds the workspace write lock long enough to stall run projections or publishes.
- Sync and export say how they treat an edge that crosses namespaces: it travels only when both ends and its own namespace travel. Today only the read rule exists.
- Sync and export leave out domain `Strut` unless asked.
- Add a small one-off import for current memory: facts linking two nodes become edges, and the rest are reviewed. The new graph otherwise starts fresh, so the assistant doesn't forget everything at the switch.

### 8. Confirm Concepts and Claims on Peel's path
- Seed a personal root Concept, and walk it through `context/concept` and `graph_get`.
- Add a record of what a run read. Ladybug has `StrutRun` nodes but no tool-call nodes, and the `ACCESSED` code only runs on Neo4j, so this is new work. Use a direct edge from the run to the node, and add a simple read of Concept use.
- Run the Claims tests unchanged.

### 9. Remove Jarvis from Peel's path
Audit what the Ladybug path still carries from Jarvis (node-key conventions, unused Schema properties, the bundled ontology) and remove what does nothing. The audit hasn't been done, so its size is unknown.

### 10. Test with a live model
Run the real orchestrator and a live model on a fresh graph through a scripted conversation that covers every pass criterion. Seed it from a scripted conversation and leave real files alone.

## Pass criteria

1. The assistant finds a person and answers about them using only the generic tools.
2. When a relationship changes, reads show the new one and the old one stays in history.
3. A `cardinality: one` edge never has two current values, even after a failed write.
4. A search matched only by a sentence on an edge finds that relationship.
5. A search scoped to one namespace returns nothing from another.
6. An agent can start at a root Concept and walk to the page it needs, and its reads are recorded.
7. Claims, Checks and Evidence behave exactly as they do today.
8. Adding a new type needs no code change.
9. Two people with the same name stay two, and a merge can be undone.
10. A job or unlisted workflow can't read anything in `private`.
11. Sync between box and Mac gives matching hashes.
12. Workflows hold no temporal logic of their own.
13. A fresh Peel graph boots without Jarvis's bundled ontology.

## Core attributes

Every time is epoch milliseconds. Claims are stored in ms like every other time and still show seconds through the claims API.

**Every node:** `ref_id`, `node_type`, `namespace`, `key`, `title`, `search_text`, `text_embeddings`, `created_at`, `created_by`, `updated_at`, `deleted_at`.

**Titles come from the schema.** Not every node has a name: a message or a dictation turn is its text. Each Schema row says which field is its title (`title_key`, a field or a small template such as `{first} {last}`) and which is its description (`description_key`). They default to `name` and `description`. The writer fills `title` from `title_key` on every write, as it fills `search_text` from `index`, so reads, search, the UI and `resolve` never look up the schema to show a node. A node with no title field gets a trimmed first line of its text. The writer refuses an Entity or Concept whose title comes out empty. Changing a type's `title_key` needs a one-off recompute. `name`, `description` and `aliases` are ordinary fields that most types declare; `aliases` matters on the types `resolve` matches, such as Person, Organization and Concept.

**Every edge:** `ref_id`, `namespace`, `created_at`, `created_by`, `updated_at`, `deleted_at`.

**Temporal edges also have:** `text`, `sources`, `valid_at`, `invalid_at`, `expired_at`, `superseded_by`, `last_confirmed_at`.

Only the writer sets `ref_id`, `title`, `search_text`, `created_at`, `created_by` and `updated_at`. Everything else belongs to its type: `docs` on Concept, `email` on Person. Check how `importance` is used before dropping `weight` and `importance` from edges, since it orders neighbors today.

## What exists on Ladybug today

Most of the risk sits in steps 2 to 6, because the Neo4j path has features Peel's Ladybug path doesn't.

| Exists on Ladybug (`main`) | Comes with PR A | New work |
|---|---|---|
| Concepts, Claims, Checks, Evidence, soft delete, `StrutRun` and `StrutJob` nodes (domain `Strut`) | Schema nodes, runtime types | Namespaces, temporal edges, `assert`, search rows, `resolve`, `merge`, reader lists with a domain filter, run read records |

## Step pass criteria

Each step is done when its tests pass, on top of the end-to-end criteria above. These must be agreed before step 3 starts.

### Step 2: schema
- A type with a `key` upserts, and two writes give one node.
- A duplicate identifier is refused within a namespace.
- Adding a key to a type with clashing nodes is refused and changes nothing.
- Node and edge writes accept a namespace, and the same key in two namespaces gives two nodes.
- A fresh file boots with base types and without the Jarvis fixture.
- An app that declares types (`data.graph`) still builds on Ladybug (`src/apps/graph-types.test.ts`, already passing).
- A Source type is found by keyword and has no embedding; an Entity type has both.
- Strut records live in their writer's namespace, and a search with no namespace or type finds a `StrutRun`.
- Schema rows are file-wide: a type resolves whatever namespace a read or write names.
- The writer stamps `created_by` from the caller's actor, and a caller can't set it.
- An existing Peel file migrates to the new names, keeps its nodes and edges, and still searches.
- Every node and edge has the core attributes, and a caller can't set the writer-owned ones.
- Every node has a non-empty `title` from its type's `title_key`, and an Entity or Concept with an empty title is refused.
- Existing Neo4j graph tests still pass.

### Step 3: `assert`
- With `cardinality: one`, a different target ends the old edge and creates the new one. A failure at any point in the transaction leaves the graph as it was.
- The same from, type and to re-confirms: it adds the source once, and repeating it with the same source changes nothing.
- A back-dated assert becomes history and leaves the current edge current.
- Two simultaneous asserts on one slot leave exactly one current edge. Writes are serialised through one writer.
- Embeddings are computed before the transaction. If embedding fails, the edge and its keyword row are written anyway, and the existing backfill sweep adds the vector later.
- An edge and its search row always commit, roll back and end together.
- Killing the process mid-write leaves both or neither after reopening.
- Plain edge creation on a temporal type is refused.

### Step 4: reads
- Search, neighbors and find hide ended data by default, and `include_ended` shows it.
- `as_of` returns what was true at that date, and an ended edge appears only within its dates.
- Search returns an edge when only its sentence matches, and a search row is never returned as a node.
- A namespace scope returns nothing from outside it, including through edges.
- The memory tools leave out domain `Strut` by default, and the assistant's search finds a run.
- Edge counts don't include hidden edges.

### Step 5: identity
- `resolve` returns an exact key or identifier match with no model involved, and returns candidates when a name is ambiguous.
- `merge` moves edges and search rows, and the old id resolves to the winner.
- If a merge leaves a `cardinality: one` slot with two current edges, the merge is refused or `assert` picks by date. Pick one when building this step and test it.
- Undo restores both nodes and their edges.

### Step 6: privacy
The rules:
- Every node and edge lives in one namespace. A write with no namespace goes to `private`.
- A reader with no list can read nothing.
- An edge is visible only if the reader can see its namespace and both ends.
- A search row is in its edge's namespace, and moves with it.
- Jobs have read-only graph tools in v1, so a bad web page can't write anything the assistant later trusts.
- Anything the assistant saves goes to `private`, including what it saves from a job's output.
- Moving something to `shared` is a deliberate act by the person. Moving a node doesn't move its edges.

The tests:
- A reader gets nothing outside its list through search, find, get, neighbors, walk, `as_of`, edge counts or search rows.
- A job sees no Strut records, through its domain filter.
- A raw query is refused unless the reader can read every namespace in the graph.
- An edge from `shared` into `private` is invisible to a job, and so is the fact that it exists.
- `resolve` never reveals a node outside the reader's list.
- A hidden node returns the same result as a node that doesn't exist.
- A new read tool can't skip the check, because the check sits below the tools.

### Step 7: sync
Today the box owns the data and the Mac holds a read copy, which pushes only dictation changes. That stays.
- The copy never writes knowledge of its own, so there's nothing to merge.
- A pull replaces the copy, after a backup, and the hashes match.
- Search rows and embeddings are rebuilt or carried so that search works straight after a pull.
- Which node types travel is listed and tested. Run records stay on the box unless we decide otherwise.
- An import holds the write lock for at most one batch at a time, and a run projected during a pull isn't delayed by more than one batch. The time held is measured in the test.
- An edge crossing namespaces travels only with both ends, and the test covers one that doesn't.
- Strut records don't travel unless asked.

## Search rows: prototype result

Ladybug can't build a text or vector index on an edge table, so each edge's sentence also goes in a hidden row in the node table. The prototype used strut's index setup, 384-dimension vectors, 5 edge types and synthetic data. Times are medians.

| | 10k edges | 50k edges |
|---|---|---|
| Keyword, search row, then fetch edge | 2.8 ms | 3.3 ms |
| Keyword, edge scan (substring only, unranked) | 5.2 ms | 8.8 ms |
| Vector, search row, then fetch 10 edges | 14 ms | 22 ms |
| Vector, edge scan | 40 ms | 62 ms |
| Write, edge alone | 3.5 ms | 3.7 ms |
| Write, edge plus search row | 9.8 ms | 13.6 ms |

- Keyword search found the right row 20 of 20 times, at every size.
- Vector recall at 10 was 100% at 10k. At 50k it was 90% with default settings and 100% with `efs := 500`.
- A rollback removed both the edge and the row, and ending an edge in one transaction hid its row.

**Decision: use search rows.** Both approaches are fast enough at Peel's size, but rows give ranked, stemmed keyword search through the existing indexes, and they stay fast as the graph grows. The cost is about 6 to 10 ms more per write.

**Not tested:** real embeddings, 200k edges (the test harness ran out of string space), and unclean exits. Strut already rebuilds a broken text index after an unclean exit, and search rows would go through the same path.

## Open decisions

- When is a statement a Claim and not an edge? Lean: a Claim when something can test it.

One Person spanning private namespaces, code in the graph, Ladybug at company scale, Hive's own Jarvis calls, and building Concepts automatically (reusing stakgraph's lab workflows, and moving `create-concept` onto the generic write) are for the Hive stage.
