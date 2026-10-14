# LadybugDB graph backend — one file, the whole graph layer

**Status (2026-10-14): decided (§7), probed, nothing built.** The dialect and
performance facts in §2 come from two scratch probes run against
`@ladybugdb/core` 0.21.2 on darwin-arm64 on the day of writing; everything
else is a plan. Supersedes the "idea, not decided" sketch in
`local-desktop-and-stt.md` §3.1. Companions: `jarvis-graph-compat.md` (the
node model the Neo4j backend implements), `generic-storage.md` §7 (the
storage boundary), `claims.md` (why claims need a graph).

## Goal

A desktop strut is a FULL graph-backed strut — the graph workspace store,
claims / checks / evidence and the verify pass, the run projector, the
`graph/*` steps, hybrid search, the builder's `graph_query` / `graph_get` /
`graph_walk`, the run flyout's accessed nodes — on **one LadybugDB file
under `dataDir`**. No Neo4j, no JVM, no daemon, no port. Today all of that
exists only on `Neo4jWorkspaceStore`; the fs workspace has no claims
(`GET /claims` → `{ enabled: false }`), and the desktop runs fs.

Third backend after Neo4j and fs: `STRUT_WORKSPACE_BACKEND=ladybug`.

## Non-goals

- **Runs, chats, secrets, sessions, artifacts stay in their file stores.**
  On the Neo4j backend they are files under `dataDir` too, and the projector
  mirrors every finished run into the graph; the same here. "One file" means
  the GRAPH layer in one file. A `LadybugRunStore` is a separate decision
  (§9).
- **Not replacing Neo4j on swarms**, and not jarvis reading a Ladybug file.
  The rows stay jarvis-SHAPED (§3) so a desktop graph can be pushed to a
  swarm's Neo4j later as a row → labels mapping; nothing more.
- **`memory/*` keeps its own file and tables** (ruling 2026-10-13: Graphiti
  shape, not behind `GraphBackend`). The shared handle in §3.2 makes "same
  file" a path change later; this plan does not make it.
- **No runtime translation of Neo4j Cypher text.** A regex layer that turns
  `MATCH (c:Claim …)` into Ladybug Cypher would fail unreadably on the first
  statement it misparsed. Engine-specific code is engine-specific code.

## 1. What exists — the seam today

`GraphBackend` (`src/graph/backend.ts`) is one object: `{ cfg, bolt, nodes,
edges, reader, schemas, embedder, embeddings, close }`. Every byte of Cypher
goes through `Bolt` (`bolt.ts`, the neo4j-driver wrapper): 17 files, ~230
statements. Who issues them, and what kind:

| Module | Statements | Kind |
| --- | --- | --- |
| `node-writer.ts` | 10 | validation + `node_key` / `Data_Bank` composition are PURE; one UNWIND-MERGE template with `SET n += map`, dynamic labels |
| `edge-writer.ts` | 25 | UNWIND-MERGE by `edge_key`, `IS_ALIAS` rewrite, `SET r += $set`, `shortestPath` cycle check, `DELETE r` |
| `search.ts` (`GraphReader`) | 24 | `CALL db.index.fulltext/vector.queryNodes`, Lucene query syntax, `SHOW INDEXES`, `labels(n)` filters; RRF fusion, title boost, usage tiebreak, envelopes are PURE |
| `schema-resolver.ts` | 18 | reads the `:Schema` meta-graph (type, `CHILD_OF` ancestors, `About`, edge schemas = rels between Schema nodes), `CALL db.labels()`; merging / caches / canonicalization PURE |
| `embeddings.ts` (`EmbeddingPass`) | 13 | pages by `elementId`, `[f IN $F \| n[f]]` dynamic property reads, `SET n:Label`; budget / status / `decideRow` PURE |
| `schema-seed.ts`, `ontology-seed.ts`, `schema-crud.ts` | 45 | Schema-node rows (MERGE/SET) + Neo4j DDL (constraints, vector + fulltext indexes) |
| `workspace-store.ts` | 13 | pattern-level reads over Strut-typed nodes (`properties(w)`, `OPTIONAL MATCH`, `collect`) + writes through `nodes`/`edges` |
| `claims.ts` (`ClaimsReader`) | 16 | pattern-level reads (`EXISTS {}`, `OPTIONAL MATCH`, `labels()`, `toInteger`) |
| `projector.ts` | 6 | pattern-level lookups by `run_id` / `content_hash`; writes through `nodes`/`edges` |
| `deletion.ts` | 3 fragments | `NODE_LIVE` / `EDGE_LIVE` / `DELETE_NODE_TAIL` (undirected `DELETE r`) |
| migrations (`vein-`, `run-status-`, `exact-key-`, `claim-schema-upgrade`, `index-reconcile`) | 37 | Neo4j legacy; a fresh file has none of it |
| `query.ts` | — | the MODEL's Cypher, read-only keyword gate |

Never touch `bolt`: `claims-writer.ts`, `claims-authoring.ts`, `verify.ts`,
`ledger.ts`, the chat tools, `createStrut.ts` (the claims gate is
`workspace.graph`), and every `graph/*` step except `create-schema`
(`createNodeSchema(b.bolt, …)`).

The node model (jarvis's, `jarvis-graph-compat.md`): a node carries labels
`Type:Node:Data_Bank:Domain_*`; identity `(node_key, namespace)` with a
uniqueness constraint; `ref_id` unique; attributes validated IN TS against
a Schema resolved from the live `:Schema` meta-graph; `Data_Bank` search
text + `text_embeddings`; soft delete (`deleted_at`, `is_deleted`); edges
by `ref_id` + `edge_key`, hard-deleted. Strut's own ten types and sixteen
edge rows are the registry in `strut-schemas.ts`; `Claim` / `Check` /
`Evidence` are jarvis types from the bundled ontology fixture.

## 2. Probe facts (2026-10-14, `@ladybugdb/core` 0.21.2, darwin-arm64)

Run in a scratch folder against a one-`Node`-table schema with 100k rows
(the shape §3 proposes). Not in the repo; the first slice turns them into
tests.

**Works:**

- DDL: `CREATE NODE TABLE … FLOAT[384]` with a backticked `Data_Bank`
  column; `ALTER TABLE ADD IF NOT EXISTS` on node and rel tables, with
  indexes present and inside a transaction; one `REL TABLE` per edge type
  `FROM Node TO Node` with properties; `CALL SHOW_TABLES()` /
  `TABLE_INFO()` / `SHOW_CONNECTION()` / `SHOW_INDEXES()`.
- `MERGE` keyed on the PRIMARY KEY with `ON CREATE SET` / `ON MATCH SET`;
  `UNWIND $rows` over a list of structs (null fields fine) for `CREATE` and
  `MATCH … SET`; `MATCH (n:Node {a: $x, b: $y})` inline patterns.
- `OPTIONAL MATCH … WHERE` on a pattern connected to a bound variable;
  `EXISTS { MATCH … }` subqueries, nested rel chains included; `x IN [..]`,
  `CASE WHEN` (also in `ORDER BY`), `coalesce`; multi-type rels
  `-[r:A|B]->`; unlabeled `-[r]->` across every rel table + `label(r)`;
  `DELETE r` with a count; `RETURN n` (a struct of every column, nulls
  present), `properties(n)`, `label(n)`, `{a: n.a, b: n.b} AS m`.
- Functions: `lower` and `toLower`, `CONTAINS` / `STARTS WITH` and
  `contains()` / `starts_with()`, `=~` and `regexp_matches`, `any` / `all`
  / `none`, `size`, `list_contains`, `range`, `list_reduce`, `list_filter`
  / `list_transform` lambdas, `gen_random_uuid`, `CAST` / `to_int64`,
  `string_split`, `count(DISTINCT)`, `SKIP` / `LIMIT`.
- Params: lists in `IN`, null (`$x IS NULL OR …`), booleans, `FLOAT[384]`
  on `SET` with or without `CAST`, `STRING[]`.
- Paths: `-[:E* SHORTEST 1..10]->`; the recursive-rel filter
  `(r, n | WHERE …)`.
- Transactions: `BEGIN TRANSACTION` … DDL + writes … `COMMIT` / `ROLLBACK`;
  snapshot isolation — a second `Connection` on the same `Database` sees
  committed state only. A second `Database` handle on the same file in
  the same process opened too (read-write AND read-only); the plan still
  uses one handle per file (§3.2).
- Extensions: `LOAD EXTENSION '<absolute path>'` (the bundled form);
  `CALL CREATE_VECTOR_INDEX('Node', 'node_vec', 'text_embeddings')` with
  most vectors NULL; `QUERY_VECTOR_INDEX('Node', 'node_vec', $v, k)` with
  a PLAIN parameter (a `CAST(...)` expression there is rejected), `efs :=`,
  and `WITH node, distance WHERE …` post-filters; **the HNSW index tracks
  rows embedded or re-embedded after it was built**.
  `CREATE_FTS_INDEX('Node', 'node_fts', ['Data_Bank', 'name'], stemmer :=
  'porter')`, `QUERY_FTS_INDEX(…, conjunctive := true, top := k)` with
  `WITH node, score WHERE …`; **the FTS index tracks later inserts and
  updates** (no rebuild); quotes and slashes in a query do not error.

**Does not work (and the rewrite):**

- `MERGE` on a non-PK pattern — `Create node n expects primary key ref_id
  as input` → identity `(node_key, namespace)` is resolved by a pre-read
  in the write transaction, then `CREATE` or `SET` (§4, node engine).
- `SET n += map` → explicit column lists, built in TS from the schema.
- List comprehensions `[x IN l WHERE … | …]` and dynamic property reads
  `n[f]` → `list_filter` / `list_transform`; one table makes the dynamic
  read unnecessary (columns are known).
- `WITH … ORDER BY` without `SKIP`/`LIMIT` → order in `RETURN` or in TS.
- `OPTIONAL MATCH` on a pattern NOT connected to a bound variable
  (`Variable w is not in scope`) → connect it (`(v)-[:VERSION_OF]->(w)`)
  or two reads joined in TS.
- Undirected `DELETE`, and an aggregate followed by `DELETE` in one
  statement → the soft-delete tail is three statements in one transaction.
- A pattern naming a table that does not exist is a BINDER ERROR, not an
  empty result → a TS registry of existing rel tables (§3.1).
- Neo4j names: `randomUUID`, `toInteger`, `split`, `reduce`, `keys()`,
  `timestamp()`, `elementId`, `labels()`, `type(r)`, `startNode` /
  `endNode`, `properties()` on a map, `CAST(timestamp AS INT64)` → dialect
  helpers (§4); stamps come from TS as they already do for
  `date_added_to_graph`.

**Numbers (100k rows, no vectors unless said):** bulk `CREATE` 12.5k rows/s;
PK lookup 0.6 ms; non-PK scan (`node_key` + `namespace`) 12 ms; a 200-key
pre-read in one `UNWIND` 10 ms; `lower(name) CONTAINS` scan 8 ms; HNSW
build on 100k mostly-NULL vectors 85 ms; vector query k=5 10 ms; FTS build
1.2 s, query 20–60 ms, rebuild 1.1 s; file 51 MB. Earlier measurements
(2026-10-13, same package): HNSW build over 100k real vectors 47 s,
incremental insert into an existing index ≈ 12 ms per vector; one
read-write PROCESS per file (a second gets a lock error), N read-only.

## 3. The decision: jarvis-shaped rows in Ladybug-native tables

`local-desktop-and-stt.md` §3.1 asked how much to conform. The answer is
**conform at the DATA level, not the storage level.** Every row keeps
`ref_id`, `node_key`, `namespace`, `node_type`, `Data_Bank`,
`text_embeddings`, `date_added_to_graph`, `deleted_at` / `is_deleted` /
`is_muted`, the same ids and keys, and every attribute is validated
against the same Schema meta-graph by the same TS code. Nothing of Neo4j's
STORAGE comes along: no multi-label nodes, no constraints, no Lucene.

Why: the writers' validation and composition, the claim contract, the
projector fold, the ledger, the UI and the `graph/*` step contracts do not
change at all; a push to a swarm is `(node_type, domain) → labels`; and
ONE node table gives one HNSW and one FTS index. The alternative — a node
table per type, the `memory/*` pattern — is Ladybug-idiomatic but costs a
DDL per registered type (the bundled ontology has 153), N index calls per
untyped search, and 150 HNSW builds, for no gain the data model needs.

### 3.1 Tables

- **`Node`** — one table, PRIMARY KEY `ref_id` (what edges, claims, the
  projector and every read key on; the only hash lookup Ladybug has).
  Columns:
  - generic: `node_key`, `namespace`, `node_type` (the type label),
    `domain` (`strut` / the Schema's domain, lower — the `Domain_*` label
    as a value), `Data_Bank`, `text_embeddings FLOAT[384]`,
    `date_added_to_graph INT64`, `updated_at`, `deleted_at INT64`,
    `is_deleted BOOL`, `is_muted BOOL`, `relevancy_score`, `weight`;
  - **hot columns**: every attribute of the ten Strut types (55 names, no
    type conflicts among them), every attribute of `Claim` / `Check` /
    `Evidence` (32, no conflicts with Strut's), and `name`,
    `description`, `status`, `importance` (what reads filter and order
    on: `namesLike`, `visibility()`, neighbors). Grammar → column type:
    `string` STRING, `int` / `datetime` INT64 (epoch seconds, as the
    writer already normalizes), `float` DOUBLE, `boolean` BOOL, `list`
    STRING[]. Added with `ALTER TABLE Node ADD IF NOT EXISTS` at open
    from the registries — the mechanical form of the "a new graph field
    needs a schema entry" convention; a new Strut attribute is one line in
    `strut-schemas.ts` and lands on restart;
  - **`attrs STRING`** — JSON text of every OTHER attribute (the bundled
    ontology declares 606 attribute names across 147 schemas, with 18
    name/type conflicts among them: `created_at` is a datetime on every
    Strut and claim type and a string on `Concept` / `Feature`; `id` a
    string on 19 types and an int on 3). Routing rule, decided per
    (schema, attribute) by the writer, which knows both: a hot column
    when the attribute's declared type matches the column's, else
    `attrs`. Reads merge columns and parsed `attrs` into the envelope.
    No JSON extension: the text is parsed in TS, never queried. A unit
    test over the fixture asserts the routing is deterministic and
    conflict-free.
- **One REL table per edge type**, `<EDGE>(FROM Node TO Node, …)`, every
  one with the same columns: `ref_id`, `edge_key`, `date_added_to_graph`,
  `unique_source_id`, `weight`, `is_muted`, `is_deleted`,
  `muted_by_delete_of`, `importance DOUBLE`, and the claim edges' own
  (`strength DOUBLE`, `context`, `start_time`, `end_time`, `post_url`),
  plus `props STRING` for the rest. Created on first use (`CREATE REL
  TABLE IF NOT EXISTS`, inside the write) — jarvis's allowlist and
  `create_schema_if_missing` mean the edge vocabulary is open. A TS set
  of existing rel tables (from `SHOW_TABLES()` at open, maintained on
  create) lets a read that names an unknown edge type answer empty
  instead of hitting the binder error; `-[r]->` reads need nothing.
- **`Schema`** (PK `type`) — the meta-graph as rows: the core properties
  as columns (`parent`, `node_key`, `index STRING[]`, `vector_index
  STRING[]`, `title_key`, `description_key`, `domain`, `embed BOOL`,
  `icon`, `shape`, colours, `type_description`, `display_name`, `ref_id`,
  `is_deleted`) + `attributes STRING` (JSON, name → grammar).
  `CHILD_OF(FROM Schema TO Schema)`. Edge schemas: jarvis stores one as a
  REL OF THAT TYPE between two Schema nodes; here `EDGE_SCHEMA(FROM Schema
  TO Schema, edge_type STRING, ref_id, props STRING)` — one table, the
  type a column, which the resolver's walks read 1:1. `About`
  (hidden types / domains) → a `Meta(key PK, value STRING)` row.
  `Migration(migration_id PK, executed_at INT64)` — the same ledger, so
  boot steps (the Schema `index` reconcile) stay idempotent the same way.
- **Indexes**: `node_vec` (HNSW, cosine) on `Node.text_embeddings`, created
  at open — fine with every vector NULL, and the pass fills them in;
  `node_fts` over `[Data_Bank, name]` with the porter stemmer. A Schema
  with `vector_index` (the `input_q` / `output_q` search types) gets its
  `<stem>_embeddings FLOAT[384]` column and one HNSW each, only when such a
  Schema exists (`vectorIndexedPairs`). No constraints: the PK is the only
  uniqueness; `(node_key, namespace)` identity is the writer's pre-read
  under the single writer.
- **Namespace**: one per file, always `default`. The column stays (the
  push path reads it); `registerNamespace` refuses, `listNamespaces` is
  `["default"]`.

### 3.2 The handle — `src/graph/ladybug/db.ts`

The generalization of `steps/lib/memory/_db.ts`'s `connection()`, which
already has the right shape: one `Database` per ABSOLUTE PATH per process
on a `globalThis` registry (so a re-imported module shares it, and
`memory/*` can adopt it later); the folder created owner-only (0700); the
addon `await import()`-ed on first use with the install hint on failure;
a read `Connection` plus a write `Connection` with a queue — `withWrite(fn)`
runs `fn` under `BEGIN TRANSACTION` … `COMMIT` / `ROLLBACK`, one at a time
(the engine-level transaction every writer uses); a `readOnly()` handle
(a second `Database` opened read-only) for `graph_query`. On open: load
the `vector` and `fts` extensions by path (`STRUT_LADYBUG_EXTENSION_DIR`;
unset → `INSTALL vector` / `INSTALL fts`, the dev download), then the DDL
of §3.1 (tables, `ALTER ADD` for every hot column, rel tables for
`STRUT_EDGES` + `CLAIM_EDGES` + `CHILD_OF` / `IS_ALIAS`, indexes), then an
append-only `MIGRATIONS` list like memory's. An orphan `.wal` beside a
missing file is removed before open (a stale WAL fails every query with
"Database ID … does not match").

## 4. The seams — how Neo4j and Ladybug share code

Principle: **pure code is shared as it is; each class that issues Cypher
gets its engine-specific part pulled behind a SMALL interface with two
implementations; the pattern-level statements run on BOTH engines through
a fixed set of dialect helpers; migrations and Neo4j DDL are Neo4j-only.**
The Neo4j implementation of every engine interface is today's code,
moved, not rewritten — `npm run test:graph` stays green through the
extraction before any Ladybug code exists.

- **`GraphBackend`** gains `kind: "neo4j" | "ladybug"`, `query(cypher,
  params)` (one auto-commit statement on the engine — what the
  pattern-level readers call instead of `bolt.run`), `tx(fn)` (the
  engine's write transaction), and `dialect` (below). `bolt` becomes
  `bolt?` (Neo4j only); `lbug?` is the Ladybug handle. `GraphConfig`
  becomes `Neo4jConfig | LadybugConfig` (`{ kind: "ladybug", path,
  namespace: "default" }`); `openGraphBackend` caches by path. The
  Ladybug open runs: DDL, the Thing + Strut Schema rows and edge schemas
  (today's seed logic over the Schema source), **the bundled jarvis
  ontology fixture always** (`Claim` / `Check` / `Evidence` / `Concept` /
  `Person` live there; 153 rows, cheap), the Schema `index` reconcile
  (shared logic, Schema rows), then starts the pass. No vein / run-status
  / exact-key / claim-upgrade migrations: nothing to migrate.
- **Dialect helpers** — a fixed set, on `backend.dialect`, used by
  `workspace-store.ts`, `claims.ts`, `projector.ts`, `deletion.ts`:
  `node(alias, type, props?)` → ``(c:`Claim` {…})`` vs `(c:Node
  {node_type: 'Claim', …})`; `isType(alias, types[])` → `(s:StrutStep OR
  s:StrutWorkflow)` vs `s.node_type IN [...]`; `typeOf(alias)` →
  `labels(n)` (then `typeLabelOf`) vs `n.node_type`; `edgeType(r)` →
  `type(r)` vs `label(r)`; `int(x)` → `toInteger` vs `CAST`; `lower(x)`;
  `project(alias, fields)` → the `{a: n.a}` struct form, which both
  accept (never `properties(n)` on a hot path: a Ladybug node struct
  carries every column). The rule: **no ninth helper** — a statement that
  cannot be written with these becomes a method on an engine interface.
  Two Neo4j statements change shape to stay neutral, and the live suite
  guards them: the workspace store's list reads connect their `OPTIONAL
  MATCH` through `VERSION_OF` (more correct than matching on `name`
  anyway) and order in TS; `DELETE_NODE_TAIL` becomes three statements in
  one transaction (SET, delete outgoing, delete incoming).
- **`NodeWriter`** keeps `validateNode`, `composeNodeKey`, `buildSearchText`,
  the embed-before-write, the outcome classification, and `update` /
  `softDelete` / `retirePlannedEvidence` semantics; the Cypher moves
  behind `NodeEngine { mergeBatch(schema, rows, mode), update(ref, set,
  remove), softDelete(ref), readRaw(ref) }`. Neo4j: today's `mergeBatch`.
  Ladybug: pre-read `(node_key, namespace)` for the batch in the write
  transaction → `CREATE` the misses with fresh `ref_id`s, `SET` the hits
  (upsert or restore) with explicit column lists from the schema, non-hot
  attributes folded into `attrs`.
- **`EdgeWriter`** → `EdgeEngine { ensure(edgeType), mergeBatch(edgeType,
  rows), update(where, set, remove), delete(ref), move(m), aliasTargets(refs)
  }`; the cycle check's `shortestPath` is `SHORTEST`; `SET r += $set` is
  an explicit list.
- **`SchemaResolver`** keeps merging, the ancestor walk order, caches and
  canonicalization over `SchemaSource { schema(type), ancestors(type),
  typeLike(t), hidden(), edgeSchema(src, edge, tgt) and the three ancestor
  walks, createEdgeSchema, upsertSchema }` — seven reads, one write. Neo4j:
  the `:Schema` graph as today. Ladybug: the `Schema` table + `CHILD_OF` +
  `EDGE_SCHEMA`. `schema-seed.ts` / `ontology-seed.ts` / `schema-crud.ts`
  write Schema rows through `upsertSchema` on both; their Neo4j DDL
  (constraints, vector / fulltext indexes) stays behind `kind === "neo4j"`.
- **`GraphReader`** becomes an interface (today's method list);
  `Neo4jReader` is today's class; `LadybugReader` is new: `getNode` /
  `getNodeByKey` / `namesLike` / `connectionCounts` / `edgeCounts` /
  `neighbors` (two directed halves — no `startNode`), `listSchemas` /
  `getSchema` over the Schema table, and `search` = FTS
  (`QUERY_FTS_INDEX`, conjunctive for an exact query, disjunctive
  otherwise; a quoted phrase and `exclude` / `linked` as `WITH … WHERE`
  post-filters under the same `overfetch`) + vector (`QUERY_VECTOR_INDEX`
  over-fetched and post-filtered by `node_type`, as the typed Neo4j path
  already is) → the SAME `fuseHits`, `applyTitleBoost`,
  `applyUsageTiebreak`, `serializeNode`. Lucene escaping and the fuzzy
  `~` fallback have no twin and are not needed: the vector half covers
  near-misses, and a desktop graph is small.
- **`EmbeddingPass`** keeps the timer, budget, status, sweep order and
  `decideRow`; the reads move behind `PassSource { types(), page(type,
  cursor), writeVectors(rows), removeVectors(ids), newcomers(after) }`.
  Ladybug pages by `ref_id` within `node_type = $t`, reads index fields
  from columns and `attrs`; the "stamp the missing label" repair step
  vanishes (one table).
- **`query.ts`**: the model's Cypher runs on the read-only handle — a real
  guarantee, as Neo4j's READ transaction is; the keyword gate gains
  `COPY`, `INSTALL`, `LOAD`, `ATTACH`, `IMPORT`. The builder's prompt line
  for `graph_query` gets one sentence per backend (one `Node` table,
  `node_type`, a rel table per edge type, `label(r)`), rendered at the
  chat's first turn like the rest.
- **`graph/*` steps**: `graphCtx` (`_shared.ts`) prefers the backend the
  SERVER wired — `createStrut` puts `opts.graph ?? workspace.graph` on
  `ctx.services.graph`, the way the chat tools already get `deps.graph` —
  and falls back to the env resolution it does today. `create-schema`
  calls `createNodeSchema(backend, …)`, not `b.bolt`.
- **`workspace-store.ts`**: `Neo4jWorkspaceStore` → `GraphWorkspaceStore`
  over any `GraphBackend`, the old name kept as an alias export (mcp's
  `createLabStrut` imports `graphWorkspaceFromEnv` and logs the class
  name). It passes `workspaceConformance` on both engines.
- **`createStrut.ts`**: unchanged in substance — the claims gate is
  `workspace.graph`, the projector hook `workspace.graph`, the
  `/graph/*` routes `opts.graph ?? workspace.graph`. One line for
  `services.graph`.
- **Wiring**: `STRUT_WORKSPACE_BACKEND=ladybug` → `wiring.ts`
  `ladybugWorkspaceFromEnv` → `{ backend, workspace }` with the file at
  `STRUT_GRAPH_DB` (default `<dataDir>/graph.lbug`) and the materialize
  dir `steps/_graph` as today; `server.ts`'s graph branch covers both
  kinds. `GET /health` (keyed) reports `workspace: { backend }`.

## 5. Tests

Today the graph layer has 260 live cases under `npm run test:graph`
(Neo4j, wiping a throwaway database; opt-in by `STRUT_TEST_NEO4J_URI`).
The behavioral suites — `claims`, `claims-authoring`, `verify`,
`projector`, `workspace-store` (the conformance suite), `node-writer`,
`edge-writer`, `search`, `names`, `schema-resolver`, `query`,
`graph-steps` — take their backend from one helper, `testBackends()`:
**always Ladybug** (a temp file per `describe`, removed after; skipped
with the reason printed when the addon or the extensions are missing,
exactly as `memory-steps.test.ts` does) **and Neo4j when the env names
one**. So the same suite runs offline in `npm test` against Ladybug and
live against Neo4j — the graph layer's conformance suite, as
`storage-conformance.test.ts` is for the stores. Neo4j-internal tests
(`schema-seed` DDL, the migrations, `index-reconcile`, `wiring`, the
pass's paging, `test-util`'s snapshot) stay live-only. A few asserts split
on `kind` (labels in a snapshot → `node_type`).

CI (`tests.yml`) installs with `--ignore-scripts`; the addon loaded here
with its install script blocked (the platform package carries
`lbugjs.node`), so Linux should match — verify in slice 1. The two
extension files are fetched once into a cached `~/.lbdb` or vendored by a
script per platform; if CI cannot, the suite skips and says so, never
silently.

## 6. Build order — four slices, each green

1. **Handle, DDL, engines, conformance.** `ladybug/db.ts`; `kind` /
   `query` / `tx` / `dialect` on `GraphBackend`; `NodeEngine` /
   `EdgeEngine` / `SchemaSource` extracted with the Neo4j code moved behind
   them (`test:graph` green, no behavior change); the Ladybug
   implementations; seeds through `SchemaSource`; `GraphWorkspaceStore`
   passes `workspaceConformance` on a Ladybug file in `npm test`. ~4 days.
2. **Claims on a file.** The dialect helpers through `workspace-store`,
   `claims.ts`, `projector.ts`, `deletion.ts` (with the two connected
   rewrites); `claims` / `claims-authoring` / `verify` / `projector` tests
   on both backends → claims, checks, evidence, the verify pass, the
   ledger, the Claims panel and the run projection work on a Ladybug
   file. ~3 days. **This is the slice that answers the goal.**
3. **The read surface.** `LadybugReader` (lookups, neighbors, schemas, then
   search over FTS + HNSW) and `PassSource` → `graph/*` steps, `graph_get`
   / `graph_walk` / `graph_query`, the run flyout's nodes, semantic search;
   `search` / `names` / `graph-steps` tests on both. ~4 days.
4. **Wiring and the desktop.** Env + `wiring.ts` + `server.ts`;
   `services.graph` for the steps; the read-only handle for `query.ts` +
   the prompt sentence; `/health`; `package-desktop.mjs` ships the two
   extensions in `native/` beside `lbugjs.node`, pinned to the Ladybug
   version (the extension directory is versioned with the CORE, `0.21.0`
   for the 0.21.2 package), and `desktop.js` sets
   `STRUT_LADYBUG_EXTENSION_DIR`; the one-shot **fs → ladybug import** of
   an existing desktop workspace (every workflow and step version
   published through the store with its label and metadata, ledger-stamped,
   the fs directory renamed aside — a boot step, not a script, per the
   repo's rule); docs: AGENTS.md's stack row and Environment table, the
   desktop plan's §3.1 pointer. ~3 days.

About three weeks. Slice 2 is the first useful desktop milestone, slice 3
the "full graph" one.

## 7. Decisions (Evan, 2026-10-14)

1. **The desktop default flips to `ladybug` once the import exists.**
   Slice 4 ships the one-shot boot import of an existing fs workspace, and
   `desktop.js` defaults `STRUT_WORKSPACE_BACKEND` to `ladybug` when the
   addon and the extensions are in the package. Peel's fs workspace
   migrates on first boot.
2. **Two files in v1.** `memory/*` keeps `<dataDir>/memory/graph.lbug` and
   its Graphiti tables (the 2026-10-13 ruling); the graph is
   `<dataDir>/graph.lbug`. The shared handle (§3.2) makes one file a path
   change later.
3. **Runs and chats stay file stores**, with the projector mirroring runs
   into the graph as on swarms. No `LadybugRunStore` in this plan.
4. **The extensions are required.** An open without `vector` + `fts` fails
   with the install hint; the packager bundles both in `native/`, dev
   installs them once. One search path.
5. **The hot-column rule for jarvis types** (§3.1) stands as written — not
   raised; the fixture test is what guards it.

## 8. Risks and gotchas (from the probes)

- **No uniqueness on `(node_key, namespace)`.** The single writer (the
  handle's queue) is what keeps two rows from sharing a key; the pre-read
  is a scan — 10 ms per 200 keys at 100k rows, fine for a personal graph.
  Past ~1M rows a `key`-PK variant with `ref_id` as a column is the fix;
  not now.
- **Unknown table = error.** Every edge type needs its rel table before a
  read names it; writes `ensure()`, reads filter requested types against
  the registry.
- **HNSW incremental cost** ≈ 12 ms per vector: the pass's batches of 100
  are ~1.2 s, inside its 15 s/min budget. A BULK import of embedded nodes
  (a code graph) should drop the index, load, and rebuild it (one minute
  for 100k) rather than pay 12 ms a row.
- **FTS is BM25 over tokens**: no phrase, fuzzy or per-field boost
  operators. Phrases are post-filters; camelCase is one token (the memory
  note) — `Data_Bank` composition already splits names into words.
- **Node structs carry every column** (~100 once the hot columns are in):
  project in hot reads; `RETURN n` only where today's envelopes need the
  whole node.
- **Extensions are versioned with the core** and downloaded from
  extension.ladybugdb.com in dev; a notarised app cannot download, so the
  packager bundles them (§6.4). `algo` is broken on macOS (memory note);
  nothing here needs it.
- **A stale `.wal`** beside a missing file fails every query; the handle
  checks before open, the test helper removes both.
- **Prompt cache**: the `graph_query` prompt sentence is rendered once per
  chat like the rest of the system prompt; nothing here re-renders
  history.

## 9. Later

- `memory/*` onto the shared handle; same file if wanted (decision 2).
- Push a desktop graph to a swarm's Neo4j: rows → labels, same `ref_id`s
  and `node_key`s — the reason the rows stay jarvis-shaped.
- `LadybugRunStore`, if "everything in one file" is wanted (decision 3).
- Code graphs on desktop: stakgraph's JSONL `COPY`-ed into `Node` with the
  index rebuilt around the load (the 2026-10-13 code-store assessment).
