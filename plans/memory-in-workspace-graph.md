# Memory lives in the personal workspace graph

**Status (2026-10-28): planned, not built.** Repos: stakwork/strut and stakwork/peel. Checked against strut `origin/main` 8b56eb7 (after #368) and peel `origin/main` (after #426).

Part 1 is done: strut's default orchestrator has no memory, and Peel grants it itself (strut#368, peel#426). This is part 2.

## Goal

One graph per person. Memory's people, organizations, facts and episodes become ordinary nodes in Peel's workspace graph (Ladybug), beside the workflows and runs.
- The generic graph tools (search, get, neighbors, walk) read all of it. Walking just works, with no translator.
- remember, forget and merge keep their rules (superseding, aliases, the user), but write through the generic node and edge writers.
- The ontology on Ladybug becomes dynamic: types are created and edited at runtime, from a default set seeded at boot.

Personal graph first. Memory stays off shared graphs (Hive's Neo4j). The tools can be wrapped for them later.

## What the code says

**Ladybug's types are closed in strut's code, not in Ladybug.**
- `src/graph/ladybug/registry.ts` declares 12 node types and 16 edge types. `LadybugSchemas` (`ladybug/engine.ts:389-450`) answers only from that list, and every schema write throws.
- This was ruling 6 in `plans/ladybug-backend.md`. Its reasons:
  - every attribute is a real column;
  - one Node table gives one FTS index and one vector index;
  - every edge table has to exist before a query names it.
- Neo4j already keeps its ontology as `:Schema` nodes, with `CHILD_OF` parents and edge schemas between them. `graph/create-schema` works there.

**Ladybug accepts schema changes on an open file.**
- The ladybug plan's probe ran `ALTER TABLE ADD` inside a transaction, with the indexes present.
- Memory's import already drops and recreates tables while a second connection stays open.
- Not yet tested: a schema change while other reads are busy.

**Memory already has a dynamic ontology:** its `Ontology` table.
- It holds types and predicates, each with parent, aliases, role, cardinality, subject and object types, and proposed or active status.
- A fact is a node and its predicate is a field. So as the vocabulary grows, memory needs no new edge tables.

**The generic writers can't run memory yet.** Five gaps:
1. **Soft delete.** It stamps `deleted_at` and hard-deletes every edge (`engine.ts:215-246`). Memory keeps the edges, and later reads depend on them:
   - `canonical()` follows ALIAS_OF out of a merged node;
   - unalias reads a forgotten fact's SUBJECT;
   - dictation reads deleted facts.

   There is also no `deleted_reason`, which the janitor cap and dictation's "undone" use.
2. **Transactions.** Each writer call opens its own transaction, and they can't nest. Only `EdgeWriter.writeMany` joins the caller's. A remember is a dozen writes that must land together.
3. **Identity.** A generic node's identity is a key derived from its attributes, and create merges on it, even bringing back a deleted node. Memory always creates a new node, and two people can share a name.
4. **Columns.** None of memory's fields exist on the Node table.
5. **Times.** The generic `datetime` stores seconds; memory uses milliseconds.

**Memory has callers beyond its steps:**
- dictation (raw Cypher on the memory file: `changes-since`, `apply-changes`, `undo`);
- the lexicon, which feeds audio;
- home sync;
- move and archive;
- tidy-memory (the janitor);
- the privacy policy;
- the desktop exit hook, which never closes memory's handle.

**Home sync copies only memory, and that stays.** The box is memory's one writer. The Mac keeps a read copy of it, and pushes back only what dictation learns. Workflows, apps and automations stay on the box. Today the sync ships a snapshot of memory's own file, so once memory is inside the workspace graph, sync needs a memory-only export and import.

## Decisions

1. **Schemas are nodes in the `Node` table, as on Neo4j.**
   - A type is a node with `node_type: "Schema"`. Its parent is a `CHILD_OF` edge.
   - An allowed source → edge → target is an edge between two Schema nodes.
   - Schema's own fields are its attributes: type, parent, node_key, index, title_key, description, aliases, status, role, naming, cardinality, managed_by, embed. The attributes a type declares are one JSON attribute.
   - Schema goes on the graph tools' excluded types (`EXCLUDED_NODE_TYPES`, `steps/lib/graph/_shared.ts`), with `embed: false`. It stays out of search, but `get-ontology` reads it.
   - Memory's `Ontology` rows become Schema nodes: a type as a Schema, a predicate as a Schema with `kind: predicate`.
   - Words: a **Schema** is one type, and the **ontology** is all of them.
2. **Memory's entity types are real node types.** Self, Person, Organization, Place and so on are Schema nodes. A "FootballClub" proposed by remember, or a workflow's "Channel", is a type like any other.
3. **Facts stay nodes.** A Fact has a `predicate` attribute and SUBJECT and OBJECT edges, as now. Superseding, valid and invalid times and sources stay exactly as they are. Direct edges (Tom `likes` a Channel) come later.
4. **One rel table per edge type stays.** A single Edge table would mean rewriting typed patterns in `workspace-store.ts` and about ten in `claims.ts`.
   - A new edge type means `CREATE REL TABLE` at runtime.
   - The reader takes the edge list from the ontology instead of code.
   - Memory needs SUBJECT, OBJECT, MENTIONS, FROM_EPISODE, ALIAS_OF and SUPERSEDES (which already exists). CONTRADICTS is never written, so it goes.
5. **Declared attributes are real columns.** A schema write adds the column (`ALTER TABLE Node ADD`).
   - One attribute name keeps one column type everywhere, and a clash is refused.
   - Memory's free-form `attributes` map stays one JSON attribute.
   - A proposed type's attributes stay in that map until the type is made active, so proposals don't grow columns.
6. **No namespaces yet.** Ladybug holds only `default` (`ladybug/reader.ts:16`). Type filters separate memory from workflows, and edges cross freely.
7. **Memory's types are managed.**
   - A schema can be `managed_by: "memory"`. The writers refuse a managed type unless the caller names that manager.
   - Allowed: remember, forget, merge, attributes, dictation, and the migration.
   - Refused: create-node, edit-node, delete-node, create-triplet, create-batch-triplet, move-node, edit-edge and delete-edge.
   - Workflow types are never managed, so nothing changes for them.
8. **Personal graph only.** Memory steps refuse unless the workspace backend is Ladybug. Nothing changes on Neo4j.
9. **Home sync stays memory-only.** It moves to a memory-only export and import over the workspace graph: the managed types' nodes, plus the edges between them.

## PRs

A and B can be built in parallel; they overlap only in `ladybug/engine.ts`. C needs both, and D needs C.

### A (strut): a dynamic ontology on Ladybug

Behaviour doesn't change: the same types are stored in the file instead of code.

- **The Schema type** and the columns for its fields (`ladybug/db.ts`, `registry.ts`).
- **Seed at open:** one Schema node per type in `registry.ts`, plus CHILD_OF edges and edge-schema edges. Add-only, stamped in `Migration`. `registry.ts` becomes the seed.
- **Reads:** `LadybugSchemas` reads Schema nodes.
  - `schemaRow`: by type, case-insensitively.
  - `ancestors`: the CHILD_OF chain.
  - `findEdgeSchema`: exact match, then the ancestor walks, then the wildcard.
  - `hidden`: none.
  - `labelLike`: null.
  - The resolver drops its registry shortcut on Ladybug and takes the Neo4j path.
- **Writes:** `createSchema`, `extendSchema`, `deleteSchema`, `ensureChildOf`, `ensureEdgeSchema` and `ensureWildcardSchema` write Schema nodes and their edges inside the caller's transaction.
  - A new declared attribute adds its column.
  - A new edge type creates its rel table.
  - Then the resolver's cache is dropped.
- **Dynamic columns and edge list:** `nodeColumns()` and the edge list are read from the ontology and cached. They feed the reader's `projection`, `linkedClause`, `listSchemas` and `getSchema`, and the engine's `columns()` and `edgeTable()`.
- **Gates removed:**
  - `schema-crud.ts:171`
  - `schema-seed.ts:115`
  - `ontology-seed.ts:70`
  - `apps/graph-types.ts:132`
  - `create_schema_if_missing` in `steps/lib/graph/_shared.ts`
- **Projector:** `projector.ts` `holds` and `fit` ask the resolver instead of the registry.
- **Text:**
  - the descriptions of `graph/create-schema` and `create-triplet`;
  - `ai/prompts.ts:519`;
  - `AGENTS.md`;
  - a new ruling in `plans/ladybug-backend.md` replacing ruling 6.
- **Tests:**
  - `registry.test.ts`, `db.test.ts`, `schema-resolver.test.ts` (285-373), `schema-crud.test.ts`, `graph-steps.test.ts` (359), `graph-types.test.ts` (96);
  - creating a type and an edge type on an open file while a read is running, then reopening;
  - a column clash is refused;
  - the seed runs twice with no change;
  - search doesn't return Schema nodes;
  - `test-util.ts` `wipe` keeps Schema nodes;
  - existing graph, claims, projector, workspace and snapshot-roundtrip tests pass unchanged.

### B (strut): the writer gaps

- **Transactions:** a caller's `tx` threads through `NodeWriter.write`, `writeMany`, `update` and `softDelete`, and through `EdgeWriter.update`, `delete` and `move` (as `EdgeWriter.writeMany` already takes one).
- **Soft delete that keeps edges:** `softDelete(ref_id, { keepEdges: true, reason })`, plus a generic `deleted_reason` column. The default stays as today.
- **Identity by ref_id:** a schema with `node_key: "ref_id"` makes create always add a new node, and never bring back a deleted one.
- **The managed-type guard** (decision 7), in the writers.
- **Tests:**
  - the writers' existing tests pass unchanged;
  - each new option;
  - every graph write step refuses a managed type.

### C (strut): memory on the workspace graph

- **Seed memory's ontology** as Schema nodes, all `managed_by: "memory"` and `node_key: "ref_id"`:
  - the entity types from `_ontology-seed.ts` (Self, Person, Organization, Place, Topic, Project, Event, Task, Lingo), with aliases, naming, role and parent;
  - Fact and Episode, with their attributes as columns;
  - the predicates (name, lives_in, works_at, works_on, knows, prefers, dislikes, interested_in, diet, about, heard_as, due), with cardinality and subject and object types;
  - the memory edge schemas.
- **Rewrite memory on the workspace backend:**
  - Which files: `_db.ts`, `remember`, `forget`, `merge`, `attributes`, `get`, `recall`, `duplicates`, `lexicon` and `ontology`.
  - Every write goes through the writers in one transaction.
  - The rules don't change: superseding by cardinality, aliases and unalias, the user role (never forgotten or merged away), mishearings, the janitor cap and stamps.
  - Times become `int` attributes in milliseconds.
- **Vocabulary from the ontology:**
  - `vocabulary()` reads Schema nodes.
  - `resolve()` proposes a type by creating a `proposed` Schema.
  - Keep the "UserType" fix: strip a trailing `Type` before proposing.
- **Recall:** memory's nodes now get the FTS and vector index. Recall keeps its word scoring for this PR.
- **Other callers:**
  - **Dictation** (`changes-since`, `apply-changes`, `undo`): onto the same queries.
  - **The lexicon and audio:** their output is unchanged.
  - **The privacy policy:** add `memory/attributes`.
  - **tidy-memory:** unchanged.
  - **Desktop exit:** the hook stops closing a separate memory handle, since there is none.
- **Home sync:** `memory/export` and `memory/import` dump and load the managed types' nodes and their edges from the workspace graph. Keep the content hash and the `/home/pull` and `/home/push` shapes. Import replaces only memory's nodes, never the workspace's.
- **Migration**, at boot, when `<dataDir>/memory/graph.lbug` (or `STRUT_MEMORY_DB`) exists and isn't marked migrated:
  1. back up a memory snapshot;
  2. copy every Entity, Fact and Episode, their edges and their proposed terms into the workspace graph, keeping ref_ids;
  3. stamp `Migration`, and rename the old file, leaving it in place.

  It is idempotent. A failure leaves the workspace without memory nodes and the old file untouched.
- **Guard:** the memory steps refuse unless the workspace backend is Ladybug.
- **Tests:**
  - port `memory-steps.test.ts` (839 lines) and its four siblings to a Ladybug workspace;
  - migrating from a seeded old memory file;
  - home sync (`home-sync.test.ts`) and dictation correction;
  - graph-search finds memory's nodes with a type filter;
  - walk goes from the user to a workflow node;
  - a generic graph write is refused on a Fact.

### D (peel): read memory with the graph tools

- **Tools:** the orchestrator and automation runs get `memory/remember`, `forget` and `merge`, plus the six graph read tools. recall, get and ontology go.
- **Prompt:** the graph tools read the person's memory; search with type `Self` finds the user; neighbors returns at most 50 per call.
- **Titles:** reuse peel#424's tool titles.
- **Lock bump:** to C's merge commit.
- **Follow-up, not in D:** showing tool results in chat, which needs the bridge to carry results.

### Close

Close strut#367 (the translator) and peel#424 (D takes its titles).

## Risks

- **Runtime DDL under load.** A's first test runs a schema write while a read is busy. If that fails, schema writes take the write queue's exclusive slot, as memory's import already does.
- **Column growth.** Every active declared attribute is a column on one Node table. Proposed types keep theirs in the JSON map.
- **Write cost.** Memory's nodes get FTS and vector embeddings on every write, so a remember costs more. Measure it in C.
- **Migration.** Every Peel user's memory moves once. Back it up first, keep the old file, and make re-running safe.
- **Size.** Memory is about 2,100 lines plus 1,800 lines of tests, and most of its queries are rewritten, so C is the big PR. A and B are medium.

## Later

- A janitor that folds proposed types up ("FootballClub" under Organization) and merges near-duplicate types, by extending tidy-memory.
- Direct edges between memory and workflow nodes.
- Namespaces on Ladybug, if type filters aren't enough.
- Memory on shared graphs, behind a per-person scope.
