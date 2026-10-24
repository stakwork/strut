# LadybugDB graph backend — one file, the graph layer strut owns

**Status (2026-10-14): decided (§7), probed, BUILT — all four slices (§6);
`STRUT_WORKSPACE_BACKEND=ladybug` is the desktop package's default.** The
dialect and performance facts in §2 come from scratch probes against
`@ladybugdb/core` 0.21.2 on darwin-arm64. Supersedes the "idea, not
decided" sketch in `local-desktop-and-stt.md` §3.1 and the first draft of
this plan, which kept the whole jarvis ontology (ruling 6). Companions:
`jarvis-graph-compat.md` (the node model the Neo4j backend implements),
`generic-storage.md` §7 (the storage boundary), `claims.md` (why claims
need a graph).

## Goal

A desktop strut keeps the graph layer **strut itself owns** on one
LadybugDB file under `dataDir`: the graph workspace store (workflows and
steps as nodes), the runs and jobs the projector mirrors, claims / checks /
evidence and the verify pass, and Concepts — the knowledge tree the job
agent reads. No Neo4j, no JVM, no daemon, no port. Today all of that exists
only on the Neo4j backend; the fs workspace has no claims (`GET /claims` →
`{ enabled: false }`), and the desktop runs fs.

Third backend after Neo4j and fs: `STRUT_WORKSPACE_BACKEND=ladybug`.

## Non-goals

- **A clean break from the jarvis schemas.** The Ladybug file holds TEN
  node types, declared in code (§3), and nothing else: no `:Schema`
  meta-graph, no `About`, no CHILD_OF ancestor walks, no bundled ontology,
  no runtime schema registration, no `IS_ALIAS` rewrite. Document,
  Person, EvalSet and the other 140 jarvis types do not exist there. The
  Neo4j backend keeps all of that as it is — jarvis owns that graph.
- **Not the generic `graph/*` surface.** `graph/create-schema`,
  `graph/create-node` of an arbitrary type, `graph_query` over jarvis types:
  Neo4j only. What a desktop needs is the workspace store, the claim
  layer, and Concept reads; the read surface in slice 3 is sized to that.
- **Runs, chats, secrets, sessions, artifacts stay in their file stores.**
  On Neo4j they are files under `dataDir` too, and the projector mirrors
  finished runs into the graph; the same here. "One file" means the GRAPH
  layer in one file. A `LadybugRunStore` is a separate decision (§9).
- **Not replacing Neo4j on swarms**, and not jarvis reading a Ladybug file.
  The rows keep jarvis's identity scheme (`ref_id`, `node_key`,
  `date_added_to_graph`) so a desktop graph can be pushed to a swarm later
  as a row → labels mapping; nothing more.
- **`memory/*` keeps its own file and tables** (ruling 2026-10-13). The
  shared handle (§3.2) makes "same file" a path change later.
- **No runtime translation of Neo4j Cypher text.** Engine-specific code is
  engine-specific code.

## 1. What exists — the seam today

`GraphBackend` (`src/graph/backend.ts`) is one object: `{ cfg, bolt, nodes,
edges, reader, schemas, embedder, embeddings, close }`. Before slice 1
every byte of Cypher went through `Bolt` (`bolt.ts`, the neo4j-driver
wrapper): 17 files, ~230 statements. Who issues them, and what kind:

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
`workspace.graph`), and every `graph/*` step except `create-schema`.

The node model (jarvis's, `jarvis-graph-compat.md`): a node carries labels
`Type:Node:Data_Bank:Domain_*`; identity `(node_key, namespace)` with a
uniqueness constraint; `ref_id` unique; attributes validated IN TS against
a Schema resolved from the live `:Schema` meta-graph; `Data_Bank` search
text + `text_embeddings`; soft delete (`deleted_at`, `is_deleted`); edges
by `ref_id` + `edge_key`, hard-deleted. Strut's own ten types and sixteen
edge rows are the registry in `strut-schemas.ts`; `Claim` / `Check` /
`Evidence` are jarvis types from the bundled ontology fixture.

## 2. Probe facts (2026-10-14, `@ladybugdb/core` 0.21.2, darwin-arm64)

Run in a scratch folder against a one-`Node`-table schema (the shape §3
proposes). Slice 1's tests pin what it relies on.

**Works:**

- DDL: `CREATE NODE TABLE … FLOAT[384]` with backticked `Data_Bank` and
  `_search_fields_used` columns; `ALTER TABLE ADD IF NOT EXISTS` on node
  and rel tables, with indexes present and inside a transaction (60
  ALTERs ≈ 250 ms the first time, 10 ms when they are no-ops); one
  `REL TABLE` per edge type `FROM Node TO Node` with properties; a rel
  table with TWO pairs (`CHILD_OF(FROM Schema TO Schema, FROM Node TO
  Node)`); `CALL SHOW_TABLES()` / `TABLE_INFO()` / `SHOW_CONNECTION()` /
  `SHOW_INDEXES()`. A fresh open with the two extensions ≈ 45 ms.
- `MERGE` keyed on the PRIMARY KEY with `ON CREATE SET` / `ON MATCH SET`;
  `MERGE (a)-[r:E {edge_key: $k}]->(b)` between two bound nodes; `UNWIND
  $rows` over a list of structs (null fields, a `FLOAT[384]` and a
  `STRING[]` inside the struct all fine) for `CREATE` and `MATCH … SET`
  with explicit column lists; `MATCH (n:Node {a: $x, b: $y})` inline
  patterns; a `UNWIND $keys AS k MATCH (n:Node {node_key: k …})`
  pre-read.
- `OPTIONAL MATCH … WHERE` on a pattern connected to a bound variable;
  `EXISTS { MATCH … }` subqueries; `x IN [..]`, `CASE WHEN` (also in
  `ORDER BY`), `coalesce`; multi-type rels `-[r:A|B]->`; unlabeled
  `-[r]->` across every rel table + `label(r)`; undirected `-[r]-` reads;
  `DELETE r` with a count; `DETACH DELETE n`; `RETURN n` (a struct of
  every column, nulls present, plus `_label` / `_id`), `properties(r)`
  (user props only), `{a: n.a, b: n.b} AS m` (nulls present).
- Functions: `lower` and `toLower`, `CONTAINS` / `STARTS WITH`, `=~`,
  `any` / `all` / `none`, `size`, `list_contains`, `range`, `list_reduce`,
  `list_filter` / `list_transform` lambdas, `gen_random_uuid`, `CAST` /
  `to_int64`, `string_split`, `count(DISTINCT)`, `SKIP` / `LIMIT`.
- Params: lists in `IN`, null, booleans, `FLOAT[384]` on `SET` with or
  without `CAST`, `STRING[]`; a JS number into an INT64 column (a
  fraction is truncated — the writer validates ints first). INT64 reads
  back as a plain JS `number`.
- Paths: `-[:E* SHORTEST 1..10]->` with the recursive-rel filter
  `(r, n | WHERE …)`; `length(p)`.
- Transactions: `BEGIN TRANSACTION` … DDL + writes … `COMMIT` / `ROLLBACK`;
  snapshot isolation — a second `Connection` sees committed state only.
  A second `Database` handle on the same file opened READ-ONLY while the
  first is open (`new Database(path, 0, true, true)`).
- Extensions: `LOAD EXTENSION '<absolute path>'` (the bundled form, from
  `~/.lbdb/extension/0.21.0/<platform>/<name>/lib<name>.lbug_extension`);
  `CALL CREATE_VECTOR_INDEX('Node', 'node_vec', 'text_embeddings', metric
  := 'cosine')` with every vector NULL; `CREATE_FTS_INDEX('Node',
  'node_fts', ['Data_Bank', 'name'], stemmer := 'porter')`; both track
  later inserts and updates (no rebuild).
- The addon: `@ladybugdb/core` is a shim whose install script copies
  `lbugjs.node` from the platform package; with scripts blocked (CI's
  `--ignore-scripts`) the shim fails to load but
  `@ladybugdb/core-<platform>-<arch>` loads directly — the handle tries
  both (§3.2).

**Does not work (and the rewrite):**

- `MERGE` on a non-PK pattern — `Create node n expects primary key ref_id
  as input` → identity `(node_type, node_key)` is resolved by a pre-read in
  the write transaction, then `CREATE` or `SET` (§4, node engine).
- `SET n += map` → explicit column lists, built in TS from the schema.
- **`OPTIONAL MATCH … collect(…)` loses the OUTER row's fields** when the
  optional side matched nothing and the outer pattern carried inline
  properties (`MATCH (w:Node {node_type: 'X'}) OPTIONAL MATCH (v)-[…]->(w)
  RETURN w.ref_id, collect(v.ref_id)` returns `null` for `w.ref_id` on a
  row with no `v`). The two list reads are two statements joined in TS on
  both engines (§4).
- List comprehensions `[x IN l WHERE … | …]` and dynamic property reads
  `n[f]` → `list_filter` / `list_transform`; one table makes the dynamic
  read unnecessary (columns are known).
- `WITH … ORDER BY` without `SKIP`/`LIMIT` → order in `RETURN` or in TS.
- `OPTIONAL MATCH` on a pattern NOT connected to a bound variable →
  connect it, or two reads joined in TS.
- Undirected `DELETE`, and an aggregate followed by `DELETE` in one
  statement → the soft-delete tail is three statements in one transaction.
- A pattern naming a table that does not exist is a BINDER ERROR, not an
  empty result → every edge type the file knows has its rel table from
  the first open (§3.1); nothing else is ever named.
- **A failed statement inside a transaction ends it**: the engine rolls
  back and the NEXT statement runs auto-commit and persists. The handle's
  `withWrite` refuses every statement after the first failure with that
  failure, and skips the ROLLBACK.
- A string param into an INT64 column is a binder error (no implicit
  cast); `undefined` in a param is not a value (the handle writes null).
- Neo4j names: `randomUUID`, `toInteger`, `split`, `reduce`, `keys()`,
  `timestamp()`, `elementId`, `labels()`, `type(r)`, `startNode` /
  `endNode`, `properties()` on a map → dialect helpers (§4); stamps come
  from TS as they already do for `date_added_to_graph`.

**Numbers (100k rows, no vectors unless said):** bulk `CREATE` 12.5k rows/s;
PK lookup 0.6 ms; non-PK scan (`node_key` + `node_type`) 12 ms; a 200-key
pre-read in one `UNWIND` 10 ms; `lower(name) CONTAINS` scan 8 ms; HNSW
build on 100k mostly-NULL vectors 85 ms; vector query k=5 10 ms; FTS build
1.2 s, query 20–60 ms; file 51 MB. Earlier (2026-10-13): HNSW build over
100k real vectors 47 s, incremental insert ≈ 12 ms per vector; one
read-write PROCESS per file, N read-only.

## 3. The decision: a closed registry of ten types, in code

**Ladybug holds exactly these node types** (ruling 6):

| Group | Types | Why |
| --- | --- | --- |
| the workspace store | `StrutWorkflow`, `StrutWorkflowVersion`, `StrutStep`, `StrutStepVersion` | what `GraphWorkspaceStore` reads and writes |
| execution | `StrutRun`, `StrutJob` | evidence hangs off a run (`HAS_SOURCE`), `EXECUTED` ties it to the version; one node per job with its title and deliverables |
| the truth layer | `Claim`, `Check`, `Evidence` | plans/claims.md |
| knowledge | `Concept` | the tree the job agent reads, `CHILD_OF` between Concepts |

Dropped from the file: `StrutAgentSession`, `StrutToolCall`, `StrutChat`,
`StrutTurn` (swarm bookkeeping — a tool call exists so an `ACCESSED` edge
can point at the Concept an agent read, and nothing on the desktop writes
those; the run flyout and the Jobs sidebar read the event log), `Person`
(so no `PUBLISHED_BY`), `Thing` as a node, and the edges `IS_ALIAS`,
`ACCESSED`, `IN_RUN`, `IN_SESSION`, `SPAWNED`, `IN_CHAT`. The projector
skips the dropped types on Ladybug (slice 2); Neo4j keeps writing them.

**The registry is `src/graph/ladybug/registry.ts`**: the six Strut schemas
by name from `strut-schemas.ts` (with `Thing`'s vestige attributes —
`weight`, `is_muted`, `unique_source_id`, `image_url` — left off; `name`
and `description` kept), and the four jarvis-named types declared with
exactly the attributes strut writes and reads: `Claim` (`id`, `name`,
`claim_text`, `speaker_name`, `belief_valid_from`, `belief_valid_to`),
`Check` (the thirteen `CHECK_FIELDS` of `claims.ts`), `Evidence` (`id`,
`name`, `description`, `content`, `evidence_mode`, `evidence_status`,
`observed_at`), `Concept` (`name`, `description`, `docs`, `id`, `repo`,
`file`, `pr_numbers`, `commit_shas` — jarvis's string `created_at` /
`last_updated` and the deprecated `documentation` left off; a row's
creation is `date_added_to_graph`). Same `node_key` specs, same edge
names as jarvis, so the ids and keys a desktop writes match a swarm's. The
edge registry: the Strut rows whose ends are kept types, the six claim
edges with their endpoint types (`ABOUT` from a Claim to a Workflow or
Step and from Evidence to a Version; `TESTS`; `EVIDENCED_BY`;
`PRODUCED_BY`; `HAS_SOURCE` from Evidence to the Run a run check observed
or to the Version a publish check read; `SUPERSEDES` for Claims and for
Checks), and
`Concept -[CHILD_OF]-> Concept`. The module asserts at load that no two
types declare one attribute name with different column types.

**Conform at the DATA level, not the storage level.** Every row keeps
`ref_id`, `node_key`, `namespace` (always `default`; kept because the
shared writer stamps it and every pattern carries it), `date_added_to_graph`,
`deleted_at`, `Data_Bank`, `text_embeddings`, and its attributes under
their jarvis names, validated and composed by the SAME TS code the Neo4j
backend runs. Nothing of Neo4j's STORAGE comes along (no labels, no
constraints, no Lucene) and none of jarvis's unread stamps: no
`is_deleted` (soft-deleted = `deleted_at` set), no `is_muted`, no
`relevancy_score`, `weight`, `unique_source_id`, `_search_fields_used`,
no per-stem `input_embeddings` / `output_embeddings`, no `Domain_*`
(the registry knows a type's domain). Why: the writers' validation and
composition, the claim contract, the projector fold, the ledger and the
UI do not change; one node table gives one HNSW and one FTS index; a
push to a swarm is `node_type → labels` plus the stamps jarvis expects.

### 3.1 Tables

- **`Node`** — one table, PRIMARY KEY `ref_id`. Columns: the generic
  `node_key`, `namespace`, `node_type`, `Data_Bank`, `text_embeddings
  FLOAT[384]`, `date_added_to_graph INT64`, `deleted_at INT64`; and one
  column per attribute of the ten types (the union, ~70 names; grammar →
  type: `string` STRING, `int` / `datetime` INT64 (epoch seconds, as the
  writer normalizes), `float` DOUBLE, `boolean` BOOL, `list` STRING[]).
  Added with `ALTER TABLE Node ADD IF NOT EXISTS` at open from the
  registry — a new attribute is one line in the registry and lands on
  restart. No JSON column: with a closed registry every attribute is a
  column.
- **One REL table per edge type**, `<EDGE>(FROM Node TO Node, …)`: the
  fourteen the registry names (`VERSION_OF`, `ACTIVE_VERSION`,
  `USES_STEP`, `DEPENDS_ON`, `EXECUTED`, `PROMOTED_FROM`, `IN_JOB`,
  `ABOUT`, `TESTS`, `EVIDENCED_BY`, `PRODUCED_BY`, `HAS_SOURCE`,
  `SUPERSEDES`, `CHILD_OF`), every one with the same columns: `ref_id`,
  `edge_key`, `date_added_to_graph INT64`, `weight DOUBLE`, and the
  properties the claim layer writes — `strength DOUBLE` (EVIDENCED_BY),
  `context STRING`, `start_time INT64`, `end_time INT64`, `post_url STRING`
  (HAS_SOURCE). All created at open; an edge property outside this list is
  an error, not a JSON blob. No edge flags: an edge is live or gone.
- **`Migration(migration_id PK, executed_at INT64)`** — the same ledger
  the Neo4j seed stamps, so boot steps stay idempotent the same way.
- **Indexes**: `node_vec` (HNSW, cosine) on `Node.text_embeddings`, created
  at open — fine with every vector NULL; `node_fts` over `[Data_Bank,
  name]` with the porter stemmer. No constraints: the PK is the only
  uniqueness; `(node_type, node_key)` identity is the writer's pre-read
  under the single writer.

### 3.2 The handle — `src/graph/ladybug/db.ts`

The generalization of `steps/lib/memory/_db.ts`'s `connection()`: one
`Database` per ABSOLUTE PATH per process on a `globalThis` registry (so a
re-imported module shares it, and `memory/*` can adopt it later); the
folder created owner-only (0700); the addon `await import()`-ed on first
use — `@ladybugdb/core`, else the platform package it shims — with the
install hint on failure; a read `Connection` plus a write `Connection`
with a queue — `withWrite(fn)` runs `fn` under `BEGIN TRANSACTION` …
`COMMIT` / `ROLLBACK`, one at a time, and refuses every statement after a
failure (§2); a `readOnly()` handle for `graph_query` — a connection of its
own whose every statement runs inside `BEGIN TRANSACTION READ ONLY`, which
the engine refuses writes and catalog changes in (slice 4 found the second
`Database` opened read-only, first planned here, reserves 8 TB of address
space per open and `close()` never returns it: the eighth open in a process
fails with "Mmap for size 8796093022208 failed"; a `COPY … TO` file write
IS allowed in a read-only transaction, so `query.ts`'s keyword gate is what
keeps the machine out of reach). On open: load `vector` and `fts` by path
(`STRUT_LADYBUG_EXTENSION_DIR`; unset → `INSTALL vector` / `INSTALL fts`,
the dev download) — an open without both FAILS with the hint (ruling 4);
then the DDL of §3.1, the indexes, the append-only `MIGRATIONS` list. An
orphan `.wal` beside a missing file is removed before open (a stale WAL
fails every query with "Database ID … does not match"). Rows come back
the way Neo4j's do: INT64 as a number, a struct's null fields and the
engine's `_label` / `_id` keys dropped.

## 4. The seams — how Neo4j and Ladybug share code

Principle: **pure code is shared as it is; each class that issues Cypher
gets its engine-specific part pulled behind a SMALL interface with two
implementations; the pattern-level statements run on BOTH engines through
a fixed set of dialect helpers; migrations and Neo4j DDL are Neo4j-only.**
The Neo4j implementation of every engine interface is today's code, moved
(slice 1 step 1, done: `test:graph` stayed green through the extraction).

- **`GraphBackend` IS a `GraphEngine`** (`engine.ts`): `kind: "neo4j" |
  "ladybug"`, `query(cypher, params)` (one auto-commit statement — what
  the pattern-level readers call instead of `bolt.run`), `tx(fn)` (the
  engine's write transaction), `dialect`, and the three seams
  `nodeEngine` / `edgeEngine` / `schemaSource`. `bolt` is Neo4j's;
  `lbug` the Ladybug handle. `GraphConfig` is `Neo4jConfig |
  LadybugConfig` (`{ kind: "ladybug", path, namespace: "default" }`);
  `openGraphBackend` is overloaded per config and caches by path. The
  Ladybug open runs the DDL (the handle) and nothing else: no seeds (the
  registry is the schema), no migrations (nothing to migrate).
- **Dialect helpers** — nine, on `backend.dialect`, used by
  `workspace-store.ts` and, in slice 2, `claims.ts`, `projector.ts`,
  `deletion.ts`: `node(alias, type, props?)` → ``(c:`Claim` {…})`` vs
  `(c:Node {node_type: 'Claim', …})`; `isType(alias, types[])`;
  `typeOf(alias)` → `labels(n)` (then `typeLabelOf`) vs `n.node_type`;
  `edgeType(r)` → `type(r)` vs `label(r)`; `live(alias)` → `NODE_LIVE`
  vs `deleted_at IS NULL`; `edgeLive(r)` → `EDGE_LIVE` vs `true`;
  `int(x)`; `lower(x)`; `project(alias, fields)` → the `{a: n.a}` struct
  form (never `properties(n)` on a hot path). The rule: **no tenth
  helper** — a statement that cannot be written with these becomes a
  method on an engine interface. The workspace store's two list reads
  are TWO statements each (the workflows, then every live version with
  the `VERSION_OF` target it belongs to), joined and ordered in TS — the
  `OPTIONAL MATCH … collect` form is a Ladybug bug (§2) and the
  `name`-join it replaced was looser than the edge anyway.
- **`NodeWriter`** keeps `validateNode`, `composeNodeKey`, `buildSearchText`,
  the embed-before-write, the outcome classification, and `update` /
  `softDelete` / `retirePlannedEvidence` semantics; the Cypher sits behind
  `NodeEngine { mergeBatch, readRaw, refByKey, update, softDelete }`.
  Values cross the seam as plain JS; the Neo4j engine wraps Integers from
  the schema (`int()` lives nowhere else). Ladybug: pre-read `(node_type,
  node_key)` for the batch in the write transaction → `CREATE` the misses
  with their `ref_id`s in one UNWIND (all-null columns left out of the
  row shape), `SET` the hits (upsert or restore) one by one with explicit
  column lists; `softDelete` is three statements (stamp `deleted_at`,
  delete outgoing, delete incoming). `_search_fields_used` and a write's
  `namespace` other than `default` are refused there.
- **`EdgeWriter`** → `EdgeEngine { endpoints, mergeBatch, setProps,
  findByTriple, delete, liveEdgesOf, wouldCycle, copyProps }`; the cycle
  check's `shortestPath` is `SHORTEST`; `SET r += $set` is an explicit
  list over the edge columns; no alias rewrite on Ladybug.
- **`SchemaResolver`** keeps merging, caches and canonicalization over
  `SchemaSource` — seven reads, the writes, and on Ladybug a `registry`:
  when the source carries one the resolver resolves types and edge rules
  from it alone (case-insensitive on the type name, exact on the edge
  triple, no allowlist, no hidden domains) and `createEdgeSchema` is
  refused. Neo4j: the `:Schema` graph as today. `schema-seed.ts` /
  `ontology-seed.ts` / `schema-crud.ts` write through the source on Neo4j
  and return at once on a closed registry (`mode: "closed"`).
- **`GraphReader`** is an interface (`search.ts`: today's method list);
  `Neo4jReader` is today's class; `LadybugReader` (`ladybug/reader.ts`) is
  sized to the ten types: `getNode` / `getNodeByKey` / `namesLike` /
  `neighbors` / `connectionCounts` / `edgeCounts` over the one table (a
  hop's direction from two directed statements — no `startNode` — merged
  and ordered by `importance` in TS), `listSchemas` / `getSchema` from the
  registry (no Thing; the Strut types carry their domain and display
  keys), and `search` = FTS (`QUERY_FTS_INDEX`, all words required, the
  any-word pass as the zero-hit fallback — no fuzzy operator; a quoted
  span is its words) + vector (`QUERY_VECTOR_INDEX`, `1 - distance`)
  → the SAME `fuseHits`, `applyTitleBoost`, `applyUsageTiebreak`,
  `serializeNode`. Both indexes are filtered AFTER their top-k (`WITH node,
  score WHERE …`), so `type`, `exclude` and `linked` all widen both halves
  with the shared `overfetch` (Neo4j widens the keyword half only for
  `exclude` / `linked`: its typed route is a domain index). One namespace
  (`default`; anything else `INVALID_NAMESPACE`, `registerNamespace`
  refused), one domain (`strut` = the Strut types; else `INVALID_DOMAIN`),
  no `is_muted` / `status` (hidden = `deleted_at`), no per-field vectors
  (`input_q` / `output_q` alone find nothing and say so in `warnings`).
  Every node read projects the columns without `text_embeddings`.
- **Embeddings**: the writer computes a node's vector inline when the
  backend has an embedder, as on Neo4j. The `EmbeddingPass` (healing
  nodes OTHER writers left unembedded) has no job on a file strut alone
  writes: no pass, no `PassSource` (slice 3 decided).
- **`query.ts`** (slice 4, DONE): the model's Cypher runs on the read-only
  handle (§3.2) with the row cap streamed and the timeout on the
  connection; the keyword gate gained `COPY`, `INSTALL`, `LOAD` (any —
  Ladybug's `LOAD FROM <file>` is a file read), `ATTACH`, `IMPORT` /
  `EXPORT` and `CREATE_*_INDEX` / `DROP_*_INDEX` (no word boundary before
  `_`, so `CREATE` alone missed them); the tool description and the
  prompt's "Graph backend" line say how nodes are laid out on each
  (`graphConventions`, ai/prompts.ts). `query.test.ts` runs on both.
- **`graph/*` steps** (slice 4, DONE): `graphCtx` takes
  `ctx.services.graph` — the backend the SERVER wired (`createStrut` puts
  `opts.graph ?? workspace.graph` on the bag) — and only without one opens
  a Neo4j from env; the Concept reads work on the file; a step that
  registers a type or writes one outside the registry fails on Ladybug
  with the closed-registry error.
- **`workspace-store.ts`**: `Neo4jWorkspaceStore` → `GraphWorkspaceStore`
  over any `GraphBackend`, the old name kept as an alias export (mcp's
  `createLabStrut` imports `graphWorkspaceFromEnv` and logs the class
  name). It passes `workspaceConformance` on both engines.
- **`createStrut.ts`**: unchanged in substance — the claims gate is
  `workspace.graph`, the projector hook `workspace.graph`. ONE `graph`
  (`opts.graph ?? workspace.graph`) for the services bag, the chat's
  `graph_query` / `graph_get` and the `/graph/*` reads (slice 4).
- **Wiring** (slice 4, DONE): `STRUT_WORKSPACE_BACKEND=ladybug` →
  `wiring.ts` `workspaceBackendFromEnv` / `ladybugWorkspaceFromEnv` →
  `{ backend, workspace, imported }` with the file at `STRUT_GRAPH_DB`
  (default `<dataDir>/graph/graph.lbug` — its OWN folder, which the handle
  makes owner-only, the memory steps' precedent; §7.2 first said
  `<dataDir>/graph.lbug`, which would have chmod-warned on `dataDir` itself
  every boot) and the materialize dir `steps/_graph` as today; then the fs
  import (§6 item 4). `GET /health` (keyed) reports `workspace: { backend,
  path? }`; `server.ts` boots the fs workspace instead when the import
  failed.

## 5. Tests

The behavioral suites — `workspace-store` (the conformance suite),
`node-writer`, `edge-writer`, the registry half of `schema-resolver`, and
in later slices `claims`, `claims-authoring`, `verify`, `projector`,
`search`, `names` — take their backend from one helper,
`testBackends()` (`src/graph/test-util.ts`): **always Ladybug** (a temp
file per `describe`, removed after; skipped with the reason printed when
the addon or the extensions are missing, exactly as `memory-steps.test.ts`
does) **and Neo4j when `STRUT_TEST_NEO4J_URI` names one**. So the same
suite runs offline in `npm test` against Ladybug and live against Neo4j —
the graph layer's conformance suite, as `storage-conformance.test.ts` is
for the stores. Neo4j-internal tests (`schema-seed` DDL, the jarvis
ontology, `schema-crud`, the migrations, `index-reconcile`, `wiring`, the
pass, `test-util`'s snapshot) stay live-only. A few asserts split on
`kind` (labels and `valueType` on Neo4j; a plain column on Ladybug).

CI (`tests.yml`) installs with `--ignore-scripts`; the handle loads the
platform package directly (§2), so Linux matches. The two extension files
are fetched once by `INSTALL` into `~/.lbdb`; if CI cannot, the suite
skips and says so, never silently.

## 6. Build order — four slices, each green

1. **Seams, handle, engine, conformance.** `kind` / `query` / `tx` /
   `dialect` on `GraphBackend`; `NodeEngine` / `EdgeEngine` /
   `SchemaSource` extracted with the Neo4j code moved behind them
   (DONE, no behavior change); the registry; `ladybug/db.ts`; the
   Ladybug implementations; `GraphWorkspaceStore` passes
   `workspaceConformance` on a Ladybug file in `npm test`.
2. **Claims on a file.** The dialect helpers through `claims.ts` and
   `projector.ts` (which skips the dropped types on a closed registry and
   leaves jarvis's `unique_source_id` stamp off where the schema lacks
   it); `deletion.ts` stays Neo4j's fragments, the neutral form being
   `dialect.live` / `edgeLive`; `claims` / `claims-authoring` / `verify` /
   `projector` tests on both backends → claims, checks, evidence, the
   verify pass, the ledger, the Claims panel and the run projection work
   on a Ladybug file (DONE). **This is the slice that answers the goal.**
   Two more Ladybug facts came out of it: an untyped null parameter is a
   BOOLEAN, so `$x IS NULL OR r.a = $x` fails on the string compare — a
   filter is in the statement text only when asked for; and
   `count(DISTINCT c)` over a node needs a property (`c.ref_id`).
3. **The read surface.** `LadybugReader` sized to the ten types (lookups,
   neighbors, the Concept tree, search over FTS + HNSW) → `graph-get` /
   `graph-search` / `graph-neighbors` on Concepts, `graph_get` in the
   builder, the run flyout's nodes; `search` / `names` tests on both
   (DONE; `importance` joined the edge columns — the one edge property a
   neighbors read orders by). Ladybug facts from it: `QUERY_FTS_INDEX` /
   `QUERY_VECTOR_INDEX` take parameters for the query, `conjunctive`,
   `top` and `k`, and a `WITH node, score WHERE …` after the CALL is the
   post-filter; a quoted span in the FTS query matches nothing (strip the
   quotes); `EXISTS { MATCH … }` over a rel table the file lacks is a
   binder error, so a `linked` entry naming one is `false` in the text;
   `=~` is RE2 full-match and takes `(?i)`; a list parameter works in
   `IN`; `UNION ALL` works. The jarvis-typed routing / query-shape /
   exclude / linked suites stay Neo4j-only: their types (Function, File,
   PullRequest) are not in the file; the Concept cases of the same
   features run on both.
4. **Wiring and the desktop** (DONE, 2026-10-14). Env + `wiring.ts` +
   `server.ts`; `services.graph` for the steps; the read-only handle for
   `query.ts` + the prompt sentence; `/health`; `package-desktop.mjs` ships
   the two extensions in `native/` beside `lbugjs.node` and writes a
   `desktop.json` manifest (`ladybug`, `ladybugExtensions`, `embeddings`,
   `stt`) that `desktop.js` reads its defaults from — the backend is
   `ladybug` when the addon and both extensions are staged,
   `STRUT_LADYBUG_EXTENSION_DIR` is `native/`, and `STRUT_GRAPH_EMBEDDINGS`
   is `off` unless the embeddings stack came along (the default would load
   MiniLM and fail the boot); the one-shot **fs → ladybug import**
   (`src/graph/fs-import.ts`, a boot step inside `ladybugWorkspaceFromEnv`):
   `FileWorkspaceStore.snapshot()` published through the
   `GraphWorkspaceStore` — every workflow version under its label with
   description and provenance, then active / category / publisher / owner /
   cap / automations; every step version in label order, then the active
   one — and only once it all went through, the files moved to
   `<dataDir>/fs-workspace.imported-<timestamp>/` (the run store's
   `workflows/<name>/runs/` stay where they are) and the `Migration` ledger
   stamped with that folder's name; content-addressed so a rerun is a
   no-op, a label holding other content in the graph is
   `fs_import_conflict:`, a non-active version today's lint refuses is
   skipped and named, and a failure moves nothing — `server.ts` then boots
   the fs workspace, loudly, and tries again next boot. Two Ladybug facts
   came out of it: the EXTENSION version is the core's, not the package's
   (`Database.getVersion()` says 0.21.2, the extensions live under
   `0.21.0`), so the packager asks Ladybug — an in-memory database
   `INSTALL`s + `LOAD`s `vector` and `SHOW_LOADED_EXTENSIONS()` reports the
   path (`~/.lbdb/extension/<ver>/<plat>/vector/…`), from which the version
   and platform dir come; a cross-stage downloads the target's from
   `extension.ladybugdb.com/v<ver>/<plat>/<name>/lib<name>.lbug_extension`
   (`osx_arm64` / `osx_amd64`), and the files are ad-hoc linker-signed
   Mach-O dylibs with no rpaths (checkMachO covers them; `.lbug_extension`
   joined `NATIVE_EXT`). And a read-only `Database` reserves 8 TB of
   address space per open, never returned (§3.2) — so `readOnly()` is a
   READ ONLY transaction. Docs: AGENTS.md's stack row, Layout and
   Environment table, the desktop plan's §2.3 + §3.1.

## 7. Decisions (Evan, 2026-10-14)

1. **The desktop default flips to `ladybug` once the import exists.**
   Slice 4 ships the one-shot boot import of an existing fs workspace, and
   `desktop.js` defaults `STRUT_WORKSPACE_BACKEND` to `ladybug` when the
   addon and the extensions are in the package. Peel's fs workspace
   migrates on first boot.
2. **Two files in v1.** `memory/*` keeps `<dataDir>/memory/graph.lbug` and
   its Graphiti tables (the 2026-10-13 ruling); the graph is
   `<dataDir>/graph/graph.lbug` (slice 4 gave it its own folder, as
   memory's: the handle makes the FOLDER owner-only, and `dataDir` itself
   must stay as it is — `STRUT_GRAPH_DB` names any other path). The shared
   handle (§3.2) makes one file a path change later.
3. **Runs and chats stay file stores**, with the projector mirroring runs
   into the graph as on swarms. No `LadybugRunStore` in this plan.
4. **The extensions are required.** An open without `vector` + `fts` fails
   with the install hint; the packager bundles both in `native/`, dev
   installs them once. One search path. The server image bundles them the
   same way (Dockerfile, 2026-10-17: Ladybug INSTALLs its platform's at
   build time, copied into `/usr/src/strut/native`, checked by the
   backend's own open; `docker-compose.ladybug.yml` runs the published
   image on a file, and `scripts/image-smoke.sh` boots it with no network
   before every push).
5. ~~The hot-column rule for jarvis types~~ — superseded by 6.
6. **A clean break from the jarvis schemas: ten types, in code, nothing
   else.** The six Strut types the store and the projector need
   (`StrutWorkflow`, `StrutWorkflowVersion`, `StrutStep`,
   `StrutStepVersion`, `StrutRun`, `StrutJob`), the three claim types, and
   `Concept`; no tool calls, turns, chats or agent sessions in the file;
   no jarvis ontology, no Schema meta-graph, no runtime schema
   registration, no generic `graph/*` surface. Every attribute is a real
   column; jarvis's unread stamps (`is_deleted`, `is_muted`,
   `relevancy_score`, `weight`, `unique_source_id`, `_search_fields_used`,
   the per-stem vectors) are not in the table.

## 8. Risks and gotchas (from the probes)

- **No uniqueness on `(node_type, node_key)`.** The single writer (the
  handle's queue) is what keeps two rows from sharing a key; the pre-read
  is a scan — 10 ms per 200 keys at 100k rows, fine for a personal graph.
- **A failed statement ends the transaction** and the next one would
  auto-commit: `withWrite` refuses everything after the first failure.
- **`OPTIONAL MATCH … collect` is unreliable** (§2): never aggregate over
  an optional side; join in TS.
- **HNSW incremental cost** ≈ 12 ms per vector: fine for the writer's
  inline embedding. A BULK import of embedded nodes should drop the
  index, load, and rebuild it rather than pay 12 ms a row.
- **FTS is BM25 over tokens**: no phrase, fuzzy or per-field boost
  operators. A quoted span is sent as its words, all required
  (`conjunctive`); the zero-hit fallback is any-word, never fuzzy.
- **Node structs carry every column** (~80): project in hot reads;
  `RETURN n` only where today's envelopes need the whole node.
- **Extensions are versioned with the core** and downloaded from
  extension.ladybugdb.com in dev; a notarised app cannot download, so the
  packager bundles them (§6.4). `algo` is broken on macOS; nothing here
  needs it.
- **A stale `.wal`** beside a missing file fails every query; the handle
  checks before open, the test helper removes both.
- **A `Database` reserves `maxDBSize` of address space** (its VM region) on
  open, read-only or not, and `close()` does not return it: at the addon's
  default 8 TB a process fits eight to ten, so both handles pass 1 TB
  (`MAX_DB_SIZE`, 2026-10-19: memory-steps.test.ts opened nine and failed on
  the ninth two runs in three). One handle per file per process (the registry on
  `globalThis`) is the rule; the model's Cypher runs in a READ ONLY
  transaction, never on a second `Database`. The limit is per process
  (four processes side by side each fit the same eight to ten at 8 TB),
  and where it lands varies run to run, so a file that opens as many as
  fit passes alone and fails in the suite.
- **The extensions are versioned with the core** (`0.21.0`), not the npm
  package (`0.21.2`): read the version from `SHOW_LOADED_EXTENSIONS()`'s
  path, never from `Database.getVersion()`.
- **The Neo4j backend is unchanged**: the four dropped types, `IS_ALIAS`,
  Thing's attributes and the jarvis ontology are all still written and
  read there. Only the Ladybug engine knows the file holds less.

## 9. Later

- `memory/*` onto the shared handle; same file if wanted (decision 2).
- Push a desktop graph to a swarm's Neo4j: `node_type → labels`, the
  same `ref_id`s and `node_key`s, the stamps jarvis expects added on the
  way.
- `LadybugRunStore`, if "everything in one file" is wanted (decision 3).
- Claims ABOUT a `StrutJob` (the 2026-10-14 proposal): one more edge row
  in the registry when ruled.
