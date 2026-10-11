# Semantic search without jarvis — strut keeps the graph's vectors

> **Status (2026-10-11): the strut side is BUILT** — §1 (`src/graph/embeddings.ts`,
> `EmbeddingPass`), §2 (`src/graph/index-reconcile.ts`), §3 (`routeIndexes` /
> `overfetch` in `search.ts`), strut's half of §4 (`embed` in the core-key
> mirror, the resolver, the writer, the two registry entries), `GET
> /graph/embeddings`. Not yet: the jarvis PR (§4), the stakgraph PR (§5), the
> fixture re-dump after the jarvis PR lands (until then a test sets `Turn`'s
> mark by hand), the swarm38 validation (after the mcp pin). Where the build
> differs from the text below: the reconcile only WIDENS (a string `index`
> equal to the library's one-item list is left as it is — fewer writes to
> jarvis's nodes, same meaning); the pass addresses a node by `elementId`,
> never by `ref_id` or `(node_key, namespace)` (stakgraph writes both, but
> nothing here should depend on it); the newcomer tick is one range seek over
> `Data_Bank` reading every marked type's index fields at once, not one query
> per type; a tick logs only when it did something, and a page that fails
> moves the sweep to the next type (the next sweep retries); the per-field
> `vector_index` vectors are filled by the sweep, not by the newcomer tick;
> `GET /graph/embeddings` has no web client. Before this it was PROPOSED,
> written after a seeded
> `explore` run on swarm38 never used the graph (job run `1791735838490` →
> explore run `1791735843683`, a question about hive's GitHub integration:
> 0 graph calls, 16 file reads), and revised twice the same day. First
> review: execution records (`Turn`, `StrutToolCall`, `StrutTurn`) get no
> vector (decided); the pass writes the domain label strut's writer would;
> jarvis's Schema API is not the route to current `index` lists (§2).
> Second review, against the code: stakgraph's ingest rewrites `Data_Bank`
> on every re-sync (Problem 5), so the stale test compares the stored text
> with the composed one (ruling 4); the pass pages by `node_key` instead of
> scanning (§1); typed searches go through the domain vector indexes, not
> the global one (ruling 5); the no-embed mark goes on the Schema node
> through a jarvis PR (§4); the reconcile is stamped per fixture version
> (§2); a status read for debugging (§1). Third pass, jarvis-backend read
> end to end: §4's mechanics are verified, not assumed — the boot sync, the
> validators, the enqueue sites, and what an older jarvis does with the
> mark — and `date_added_to_graph` is milliseconds in all three writers.
> Every number below was read from
> swarm38's graph that day (read-only Cypher through stakgraph's
> `/api/hive/query`), from jarvis-backend (`04317241`), from stakgraph
> (`15cfb17b`), or from this checkout (`1c04946`, main). The choices still
> to confirm are under "Rulings". Companions this stands on:
> `jarvis-graph-compat.md` (§2 embeddings parity — MiniLM, `Data_Bank`, the
> `index` fields; the bundled ontology seed), `generic-storage.md` (the
> label registry).

## Problem

`graph/graph-search` fuses two retrievers (`src/graph/search.ts`,
`GraphReader.search`): a Lucene fulltext query and ONE vector query —
strut's MiniLM embedding of `q` against each node's `text_embeddings`,
through `domain_all_vector_index` or, when that is absent, the union of
`domain_<d>_vector_index`, which index the `Domain_<d>` LABEL. On swarm38 a
question with no keyword in it finds nothing by meaning: "how do we stop one
workspace from seeing another workspace's data" (`type:
Function,Endpoint,Class,Datamodel,File`) returns `strutTools.ts`,
`initiativeTools.ts` and a markdown file, and none of the access functions
(`resolveWorkspaceAccess`, `validateWorkspaceAccess`). Five reasons, all
measured:

1. **Nobody embeds what jarvis did not write.** Code nodes come from
   stakgraph's ingest, which writes over bolt and never through jarvis.
   They got a `Domain_codeartifact` label and a vector only from one-off
   jarvis migrations, each of which processed the nodes that existed when
   it ran. stakwork/hive's 13,581 Functions:

   | added to the graph | label | vector | count | what covered them |
   |---|---|---|---|---|
   | until Apr 10 | yes | yes | 2,900 | vector: `backfill_focused_index_embeddings_v1` (Apr 11); label: `030`–`036` (Apr 24–30) |
   | Apr 11 – Apr 30 | yes | no | 420 | label: `030`–`036` (Apr 24–30) |
   | May 1 onward | no | no | 10,261 | nothing |

   Graph-wide, 205,752 of 984,770 `Data_Bank` nodes have no
   `text_embeddings`: 131,786 `Turn` (agent-log turns), ~32k code nodes
   (12,003 Function, 3,715 Var, 3,145 File, 2,810 Datamodel, 1,309 Request,
   642 Endpoint, …), the rest assorted.
2. **What was embedded is the name.** The live `Function` Schema declares
   `index: "name"`, so the 2,900 vectors carry `_search_fields_used:
   ["name"]` — the text embedded for a route handler is `"POST"`. jarvis's
   own library has declared `[name, summary, description]` since 2026-04-10
   (jarvis `e6b14dbc`), and strut's bundled snapshot
   (`src/graph/fixtures/jarvis-ontology.ts`) carries it, but schema seeding
   is add-only on both sides, so the live node never changed. 47 live types
   declare a narrower `index` than the library (56 Schema nodes: swarm38
   holds duplicates for nine types): the code types, Person/Topic/Episode/…,
   and `Turn` (`tool` → `content, tool`). Execution records are embedded
   too: 410,738 of `Turn`'s 542,524 nodes carry a vector of a tool name
   (`"shell"`, `"edit"`), and strut's own writer embeds every
   `StrutToolCall` it projects (37,128 of 37,128) from `tool_name` +
   `input_preview`.
3. **Search skips the one index that needs no label.** Both
   `schema-seed.ts` and `ontology-seed.ts` create `text_embeddings_vector_index`
   on `Data_Bank` (swarm38 has it, from jarvis); `search.ts` never reads it.
4. **The database cannot filter a vector query.** swarm38 runs Neo4j 5.19
   community: no multi-label vector index (why `domain_all_vector_index`
   does not exist there) and no filtered vector search — `queryNodes`
   returns the k nearest, then a `WHERE` drops what does not match.
5. **stakgraph's ingest rewrites `Data_Bank` on every re-sync.** Its node
   MERGE (`ast/src/lang/graphs/neo4j/queries/nodes.rs`, `build()`) puts
   `Data_Bank = name` into `$properties` and runs `ON MATCH SET node +=
   $properties`, so an incremental sync of a file resets every one of its
   nodes' search text to the bare name while `text_embeddings` and
   `_search_fields_used` survive. Any repair that trusts
   `_search_fields_used` calls such a node clean, with a vector that no
   longer matches the stored text and jarvis's `data_bank_full_index` back
   to name-only. The node's payload is `name`, `file`, `body`, `start`,
   `end`, `docs`, `hash`, `data_type` and `meta` (`ast/src/lang/asg.rs`);
   `description` is written afterwards by mcp's describe job
   (`mcp/src/graph/queries.ts`, beside its own BGE `embeddings`), so the
   library's text is reachable with no jarvis — it just arrives later.

stakgraph's own `embeddings` property is on nearly every code node, but it
is a different model (fastembed BGE-small, of the code body; queried by
mcp's search, never by strut) — see "Not doing".

## Goal

Everything semantic search needs is created and kept current by strut,
from the `:Schema` meta-graph, on any Neo4j 5: a jarvis-hosted graph today,
a graph with no jarvis tomorrow. Whoever writes a node — strut, stakgraph's
ingest, an import — it becomes searchable by meaning within minutes,
without that writer knowing about embeddings. One source of truth (the live
Schema's `index`), one rule (MiniLM over the text of those fields, the rule
jarvis, strut's writer and the pass share), one invariant any reader can
check (`Data_Bank` is that text and `text_embeddings` is its vector), one
repair job (the pass).

**All of it is code that runs by itself.** Nothing is run by hand on any
swarm: no API call, no script, no migration command. It reaches every swarm
with the next strut pin in mcp. At that boot the reconcile (§2) updates the
stale `index` lists in seconds, and the pass (§1) starts in the background,
catches up, and keeps up from then on. The one switch is the existing
`STRUT_GRAPH_EMBEDDINGS=off`.

**strut needs nothing from stakgraph or jarvis for this to work.** Two
small PRs beside it remove waste, not dependencies: stakgraph stops
rewriting `Data_Bank` on match (§5), and jarvis learns the no-embed mark so
it stops embedding `Turn` (§4). Until each is deployed on a swarm, the pass
heals what they do — a re-synced node is re-embedded, a `Turn` vector is
removed — at the cost of the extra work.

## Rulings

1. **The text is the Schema's `index`.** It is already the declaration
   both jarvis and strut read for "the search text of a node of this type"
   (`get_search_fields_for_node`; strut's `searchFieldsFor` /
   `buildSearchText` in `src/graph/node-writer.ts`). A type whose Schema
   declares `index` is embedded from those fields. The pass never falls
   back to jarvis's catch-all text (every property, joined) for a type
   without one: on swarm38, 193 of 255 types declare `index`, and the 62
   that do not (61 `Cloud`-domain Advisor*/Kn* types and `Content`) and the
   types with no Schema node (`Context`, `Chunk`) are skipped — and named
   in the status read (§1), so a graph where the code types have no Schema
   node says so instead of silently embedding nothing.
2. **Execution records get no vector — decided (Evan, 2026-10-11):
   `Turn`, `StrutToolCall`, `StrutTurn`.** Too fine-grained to search by
   meaning. `AgentSession` and `StrutAgentSession` (one per agent run) stay
   embedded. The keyword text (`Data_Bank`) stays. strut's writer stops
   embedding `StrutToolCall` and `StrutTurn` (both of its paths,
   `prepareMany` and `update`), and the pass removes the vectors these
   types already have (410,738 on `Turn`, 37,128 on `StrutToolCall`) — as
   the last job of its first sweep, after the code is caught up. Where the
   mark lives:
   - **On the Schema node, as `embed: false`, through a jarvis PR (§4).**
     jarvis reads every Schema property outside its
     `SCHEMA_CORE_PROPERTIES` as an attribute declaration — an older
     jarvis would read `embed: false` as a required attribute of type
     `false` and refuse every node of that type (§4) — so the key must
     join that list in jarvis before anything writes it to a node jarvis
     reads; strut mirrors the list (`SCHEMA_CORE_PROPERTIES` in
     `strut-schemas.ts`) and gains the key at the same time, so a Schema
     carrying it is read as a mark by both. The jarvis PR puts the mark on
     `Turn` in its library; jarvis's own boot sync carries it onto the
     live `Turn` Schema (§4, verified); the fixture is re-dumped after it
     lands, so a graph with no jarvis gets it from the ontology seed.
   - **In strut's code for strut's own two types, permanently** — a
     strut-only field on the `StrutToolCall` / `StrutTurn` registry
     entries, never written to their Schema nodes (as `exact_key` is not:
     `flattenSchema` drops it). strut is the only writer of those types, and
     writing the key onto a node an older jarvis reads would break it.
   - **Until the jarvis PR is deployed on a graph**, jarvis's writer keeps
     giving every `Turn` written through its API a vector and the pass
     removes it on its next sweep. Bounded waste (one vector per `Turn`
     jarvis writes), not a correctness problem, and gone with the PR.
   - **Not `About.hidden_types`.** That hides a type from untyped search
     and withholds its `Domain_*` label; strut's resolver follows it, and
     strut's soft delete is scoped by `Domain_strut`.
   - **Not removing `index`.** To jarvis and to strut's writer, a type with
     no `index` gets the catch-all text: they would embed more, not less,
     and the keyword text would change with it.
3. **strut brings stale `index` lists up to the library by writing them
   directly, once per bundled snapshot.** At backend open, on every graph
   (jarvis-hosted included): a live Schema whose `index` is non-empty and a
   strict subset of the bundled library's for that type gets the library's
   list. A type the library does not know, a live `index` holding a field
   the library lacks (5 on swarm38: Commit, Contributor, ProposedFix,
   AgentSession, Prompt), and an absent `index` (the catch-all, a different
   meaning) are left alone. The library is jarvis's own, so these are the
   values jarvis would set — but never through jarvis's Schema API (§2).
   The run is stamped per fixture version (§2): a widening jarvis later
   undoes on purpose is not redone at every strut boot.
4. **The pass is the one repair job, and it writes what strut's writer
   would have.** A node of a marked type is stale when its stored
   `Data_Bank` is not the text the writer would compose from its index
   fields today, or its vector is missing. That one comparison catches a
   node never embedded (stakgraph's ingest), a node embedded before the
   Schema widened (the 2,900 name-only vectors), a field filled in after
   the node was written (mcp's descriptions), a field edited since (new
   words, same fields), and a text another writer rewrote (Problem 5) —
   whoever the writer, with no bookkeeping of its own. The pass writes the
   search text (`Data_Bank`), the vector, `_search_fields_used` (jarvis's
   record, kept for parity, read by nothing here), and the domain label —
   the resolver's, which follows jarvis's rule (none for a hidden type or
   domain), as `prepareMany` already puts on every node strut writes. The
   label is load-bearing for everyone: jarvis's search (hive's `kgSearch`,
   mcp's `graph_agent` tools, the `jarvis/*` steps) and, with ruling 5,
   strut's own typed search read the per-domain vector indexes. The pass
   runs inside the strut process, at backend open and on a timer. Hidden
   domains are embedded too: hiding stays a search-time filter.
5. **Typed searches go through the domain indexes; untyped ones through
   the global index; filters in the query either way.** The database
   cannot filter a vector query (Problem 4), but it can scope one to a
   label, and the code types share one: `Domain_codeartifact` (~40k nodes,
   against ~330k vectors graph-wide once the execution records are out).
   `domain_codeartifact_vector_index` already exists on swarm38 and in
   strut's ontology seed, and the pass puts the label on every code node.
   So a search with `type` resolves each type's Schema `domain` and reads
   those domains' indexes (the union when several), as an explicit
   `domains` filter does today; a search with no `type` reads
   `text_embeddings_vector_index` (the global index `search.ts` never read;
   `domain_all_vector_index` is dropped — it never exists on 5.19). `type`
   and hidden-domain exclusion stay `WHERE` filters, with over-fetch to
   make up for Neo4j filtering after the nearest-k cut. A type with no
   domain, a hidden domain, or a domain whose index is absent falls back to
   the global index with the same over-fetch. No per-type vector indexes.

## 1. The pass — `src/graph/embeddings.ts`

`backfillEmbeddings` today embeds `Domain_strut` nodes whose stored
`Data_Bank` has no vector, plus the per-field `{stem}_embeddings` of
strut's own `vector_index` types. It becomes the pass for every marked
type, resolved through `SchemaResolver` (`schema-resolver.ts`, which
already turns a string `index` into a one-item list):

- **Pages, never scans.** Every seeded type has a `node_key` index (jarvis
  migration `add_node_key_indexes`; strut's two seeds create the same
  `CREATE INDEX IF NOT EXISTS FOR (n:T) ON (n.node_key)`, and the pass
  runs that statement for each marked type at open so the cursor is
  index-backed on any graph). One page per query, index fields only, the
  vector never read (`T` comes from a Schema node and must pass a
  label-name check before it is interpolated: Neo4j 5.19 has no dynamic
  labels):

  ```cypher
  MATCH (n:`T`) WHERE n.node_key > $cursor
  WITH n ORDER BY n.node_key LIMIT $page
  RETURN n.node_key AS node_key, n.ref_id AS ref_id, n.Data_Bank AS text,
         [f IN $F | n[f]] AS values, n.text_embeddings IS NULL AS unembedded
  ```

  A `LIMIT` with no cursor re-reads the nodes earlier batches already
  fixed (quadratic over a catch-up: the 448k `Turn` removals would visit
  nodes on the order of a billion times) and makes every clean check a scan
  of the whole type; a cursor makes each query one index seek, each tick a
  bounded amount of work, and the cursor the one number to log. The cursor
  is memory-only: a restart begins the sweep again, which is cheap when
  the graph is clean (a page of 1,000 nodes' names and descriptions).
- **Stale** is decided in strut, not in Cypher: the page's `values` go
  through the writer's own `buildSearchText` (`node-writer.ts` — one
  composition, the one jarvis's `build_search_text` matches: trimmed
  values joined with `\n`, blank values skipped), and a node is stale when
  `text` differs from the result or `unembedded` is true. Run as a count on
  swarm38 (5.19), the equivalent predicate flags all 13,581 of hive's
  Functions under the library's `[name, summary, description]` (10,681 of
  them under today's `index: "name"`). A list-valued index field renders
  as the writer renders it; a node jarvis wrote with such a field is
  re-embedded once and then stable until jarvis next rewrites it.
- **Writes** what strut's writer writes, nothing new: `Data_Bank`,
  `text_embeddings`, `_search_fields_used`, and the resolver's domain
  label when the node lacks it — in UNWIND batches of 100 within the page.
  Overwriting stakgraph's name-only `Data_Bank` also feeds
  `data_bank_full_index` (jarvis's fulltext on that property) the richer
  text. A node whose composed text is empty (every index field blank) is
  left alone.
- **No-embed types** (ruling 2) are never embedded, and a vector found on
  one is removed (`REMOVE n.text_embeddings`; `Data_Bank` stays) — the
  same cursor, pages where `text_embeddings IS NOT NULL`. A standing rule,
  not a one-off, so a `Turn` some other writer embeds loses its vector on
  the next sweep. Ordered last in a sweep and rate-limited like the
  embeds: 448k vector removals are 448k index updates, and nothing waits
  on them.
- **Per-field vectors** (`vector_index` → `{stem}_embeddings`, what
  `input_q` / `output_q` read): the same sweep, the page read including
  those properties and whether each column is null, missing vectors only,
  as today, from live Schemas instead of strut's list alone.
- **Namespaces.** Every namespace, like `migrateExactKeys` and jarvis's
  own backfills: a vector does not depend on the namespace, and the search
  filter applies it at read time.
- **Schedule.** One sweep is one ordered walk: the marked types with
  `domain: CodeArtifact` first, then the rest, then the no-embed removals,
  each type from an empty cursor to its end. A timer in the strut process,
  started when the graph backend opens — today's awaited
  `backfillEmbeddings` call in `openGraphBackend` becomes the start of the
  timer, so it never holds up boot. Every minute a tick resumes the sweep
  where the last tick stopped and works for up to 15 s; when the sweep
  ends, the next begins an hour later. Between sweeps the same tick embeds
  **newcomers**: nodes with `date_added_to_graph` past the last tick's
  high-water mark (stakgraph, jarvis — `TimeFormatter.now_epoch_ms()` —
  and strut all stamp it on create, as epoch milliseconds; the pass creates `CREATE INDEX IF NOT EXISTS FOR (n:Data_Bank) ON
  (n.date_added_to_graph)` at open, so this is an index range seek) that
  carry a marked label and no vector — so a freshly ingested function is
  searchable by meaning within a minute, and a description mcp fills in
  later is caught by the next sweep. A node jarvis writes has no vector
  until its worker drains the queue; when the newcomer tick gets there
  first, both compute the same vector — bounded duplicate work, one
  result. Pages of 1,000; embed batches of 100. One pass at a time per backend (`openGraphBackend` is cached per
  process). Constants, not settings, until a swarm says otherwise.
  `STRUT_GRAPH_EMBEDDINGS=off` turns it off with the embedder.
- **CPU.** The pass runs inside the serving process (mcp's
  `createLabStrut` opens the backend there), and onnxruntime-node's
  default is every core. `MiniLMEmbedder.load` passes `session_options:
  { intraOpNumThreads: 2 }` (transformers.js hands it to the ONNX session)
  so hours of inference share the host with chat turns and runs; the
  search path embeds one query at a time and does not notice.
- **Observability.** One log line per tick: the sweep position (type,
  cursor), embedded / removed / newcomers this tick, and types still
  dirty. `GET /graph/embeddings` (behind the key, mounted in `createStrut`
  beside `GET /graph/nodes/:ref_id`) returns the same as JSON: the sweep
  (started, type, cursor, done), per type the counts of the last complete
  sweep (seen, stale, embedded, removed, errors), the types skipped and
  why (no Schema node, no `index`, no-embed), and the last error. "Is
  search healthy" is also one Cypher query anyone can run — the stale
  predicate above, as a count — because the invariant is on the node.

**Throughput.** strut's `MiniLMEmbedder`, measured on an M4 Max: ~1,900
texts/s at ~25 tokens, ~110/s at the 256-token cap. A swarm's CPU is
slower, and the thread cap halves it again; measure there before trusting
these estimates. With the execution records out, the first sweep on
swarm38 embeds at most ~144k nodes (the 47 widened types without `Turn`),
the code types (~40k) first: at a third of the M4 rates and the 25% duty
cycle above, the code is done in minutes and the rest in an hour or a few.
The ~448k vector removals come last and are writes only. A clean sweep
afterwards is ~1,000 page reads of small properties — well under a minute
of light database work per hour.

## 2. The Schema reconcile — `src/graph/ontology-seed.ts`

A new boot step in `openGraphBackend`, beside the migrations that already
run there (`migrateRunStatus`, `migrateExactKeys`), before the pass starts —
not gated on `STRUT_GRAPH_SEED_ONTOLOGY`, since swarm38 is the graph that
needs it. A few dozen property writes at most, so it runs inline: for each
live `:Schema` whose type the bundled library has, normalize
`index` (string → list), and set the library's list when the live one is
non-empty and a strict subset. It only ever touches `index`, and returns
what it widened for the boot log. The pass then sees every node of a
widened type as stale — its `Data_Bank` no longer matches the wider text —
no vector migration of its own.

**Stamped per fixture version.** The subset test is idempotent, but not
safe against jarvis narrowing an `index` on purpose: strut would re-widen
it at every boot from a snapshot that predates the change, and jarvis's
next migration would narrow it again — a silent fight. So the reconcile
runs once per bundled snapshot: a `Migration` node
`strut_index_reconcile_<version>`, the version a constant beside the
fixture's `source` string, bumped at every re-dump. A graph is widened
once per library snapshot and left alone until the next.

**Why not jarvis's Schema API.** Updating `index` through jarvis (`PUT
/schema/:ref_id` → `update_schema`) does re-embed: when the index changed,
`migrate_existing_data_bank_index` rebuilds `Data_Bank` and the vector of
every node of the type, stakgraph's never-embedded ones included. It is
still not the route:

- it runs inside the request, encodes one node at a time and writes
  nothing until the whole type is done — minutes for Function's 15.5k
  nodes on a swarm CPU;
- every Schema update also runs `sync_indexes_for_schema`, which drops and
  recreates jarvis's shared keyword index over all of `Data_Bank` (~985k
  nodes on swarm38) — once per type, about fifteen times for the code types;
- it fixes the nodes that exist at that moment; stakgraph's next ingest
  writes unembedded nodes again;
- it adds no `Domain_*` label, so jarvis's own search still misses the code
  added since May.

Written directly, the new `index` triggers nothing in jarvis — verified
against its boot path (`gunicorn.conf.py` → `setup_jarvis`): the schema
sync (`SchemaHelper._synchronize_schemas` → `_get_missing_schema_updates`)
adds only keys ABSENT from a live Schema and never touches an existing
`index`; the keyword and domain indexes are ensured create-if-missing
(`ensure_data_bank_attribute_index_on_startup`,
`ensure_domain_indexes_on_startup`), so no rebuild; the two startup
backfill threads are migration-tracked one-shots
(`backfill_focused_index_embeddings_v1` ran on Apr 11); and the embedding
worker drains the Redis queue its own API writes fill
(`embedding_queue.py`), with no NULL rescan anywhere outside migrations.
`get_schema` is uncached, so jarvis composes with the new list from its
very next node write — the same text the pass does. The next Schema update
anyone makes through jarvis's API rebuilds its keyword index from the
Schemas as they then are — the lists jarvis's own library declares.

## 3. Search — `src/graph/search.ts`

- **Routing** keeps today's shape (`route()`), with the global vector
  index corrected and `type` joining `domains` as a reason to route:
  - an explicit `domains` filter → those domains' indexes, as today;
  - `type` set → the Schema `domain` of each requested type (the resolver
    knows it) → the union of those `domain_<d>_vector_index` /
    `domain_<d>_attribute_index_v2`; a type with no domain, a hidden
    domain, or a domain whose index is absent (`SHOW INDEXES`, read once
    up front as today) contributes the global index instead;
  - neither → `data_bank_attribute_index_v2` and
    `text_embeddings_vector_index` (`GLOBAL_VECTOR_INDEX`), the
    hidden-domain types excluded in the `WHERE` as today.
- **Filters** stay where they are, after `queryNodes`: namespace,
  visibility, `type`, hidden-domain types.
- **Over-fetch.** Unfiltered: `k = cap`, as today. With a `type` filter
  (a type within its domain's index, or a type on the global index): start
  at `k = cap × 10` and multiply by 4 until `cap` hits survive or `k`
  reaches 2,000 — the query embedding computed once, the index queried
  again with the larger `k`. Constants to tune on swarm38. The domain route
  is what keeps this from starving: `Endpoint` is 642 of ~330k vectors
  globally and a few hundred of ~40k in `Domain_codeartifact`.
- `input_q` / `output_q` are unchanged (per-label indexes from
  `vector_index`).

## 4. The jarvis PR — the no-embed mark

Small, and strut does not wait for it (ruling 2 says what happens until it
lands). Read against jarvis-backend `04317241`:

**How a library key reaches a live graph.** jarvis boots through
`setup_jarvis` (`gunicorn.conf.py`; `app.py` outside gunicorn):
`Migration.run()` (ledger one-shots), then `SchemaHelper.run()` —
`create_schema` for each library type the graph lacks (the whole entry,
core keys and attributes), then `_synchronize_schemas`, which for every
library type that exists compares the entry with the live Schema
(`_get_missing_schema_updates`) and sends the keys the live node LACKS —
every `SCHEMA_KNOWN_PROPERTIES` key but `type` / `parent` / `attributes` /
`ref_id`, plus absent attributes — to `schema_crud.update_schema`. So a
new key on a library entry lands on the live Schema at the next boot, and
an existing value (`index`) is never changed. That call is the crud
function, not the HTTP route: `sync_indexes_for_schema` (the keyword index
drop and recreate) runs only in `schema_service` on a PUT, and
`index_changed` fires only when `index` is in the update — never from the
sync. So the mark lands with no index rebuild and no re-embed.

**Why the key must be in jarvis's list first.** Two validators sit in front
of every Schema write, the sync's included: `_validate_schema_properties`
refuses any top-level key outside `SCHEMA_KNOWN_PROPERTIES`
(`ERROR_SCHEMA_PROPERTY`), and `_assert_is_valid_schema` requires every key
not in that list to carry a type string (`"?string"`, `"int"`, …) —
`false` is neither, so a sync carrying `embed: false` without the list
change fails for that type (logged, not fatal; the key never lands). And a
Schema node that already carries the key, written by anyone, is read by an
older jarvis through `_split_schema_properties` as an attribute `embed` of
type `false`; `assert_is_valid_schema_of_type` then treats an attribute
that is not `?`-optional and absent from the payload as REQUIRED, and every
node create of that type through jarvis's API fails with "Missing required
attribute 'embed'". For `Turn` that would stop the agent-log writes. Hence:
the key reaches a node only through jarvis's own sync, after jarvis knows
it; strut never writes it (ruling 2).

**The PR:**

- `embed` joins `SCHEMA_KNOWN_PROPERTIES` (`application_constant.py`;
  `SCHEMA_CORE_PROPERTIES` is that list plus `ref_id`, so
  `_split_schema_properties`, `_schema_attribute_names` and
  `get_searchable_attributes_from_schema` all keep it out of the
  attributes).
- A Schema with `embed: false` still gets `Data_Bank` and
  `_search_fields_used` (keyword search unchanged) and never a
  `text_embeddings` job. The sites, each of which already holds the node's
  schema from an uncached `get_schema`: the create path in
  `schema_node_helper.py` (`push_embedding_job(ref_id, data_bank_value)`
  after the MERGE), the v1 update path in `node_service.py` (the same call
  when `Data_Bank` changed), `migrate_existing_data_bank_index`
  (`schema_migration_helper.py`, the inline encode on an API `index`
  change), and the v1 bulk edge path in `node_service.py` that builds
  `Data_Bank` for both endpoints. The per-property `vector_index` kinds
  (`input` / `output`) are unaffected by the mark, and the worker needs no
  change — it only sees jobs.
- `Turn` carries `embed: false` in `schema_library.py`. Nothing else in the
  library changes: a type without the key embeds, as today.
- jarvis's search is untouched (a `Turn` with no vector is simply not a
  semantic hit, as the 131k unembedded ones already are).

strut's side of the same change: `embed` in its mirror of the core list,
the resolver reading it onto `NodeSchema`, the writer and the pass honoring
it, and the fixture re-dumped once the PR has landed in jarvis's default
seed.

**Precedent.** jarvis already repairs, at every boot and ungated, the one
label drift it knows about: `ensure_concept_domain_labels_on_startup`
re-applies `Domain_*` to `Concept` nodes because stakgraph's gitree writes
them over bolt without one, "and an unlabeled node is absent from every
domain vector index". The pass is that repair for every marked type —
vectors included, continuous instead of boot-only.

## 5. The stakgraph PR — `Data_Bank` on create only

In `nodes.rs` `build()`, `Data_Bank` moves out of `$properties` into the
`ON CREATE SET` clause, beside `date_added_to_graph` (the same set-once
rule, for the same reason: a re-ingest must not reset what a later writer
improved). `build_stream()` is already `ON CREATE` only. Without it strut
is still correct — the pass sees the rewritten text as stale and
re-embeds the node — but a full re-ingest would re-embed every code node
of the repository each time; with it, a re-sync of an unchanged function
touches nothing the pass reads.

## A graph with no jarvis then needs

| what | who creates it | today |
|---|---|---|
| `:Schema` nodes for the types it holds | the ontology seed (`STRUT_GRAPH_SEED_ONTOLOGY=1`; the compose sets it) — without it the pass embeds nothing of stakgraph's and the status read says so | exists |
| `index` lists as current as the library | the reconcile (§2) | new |
| `text_embeddings_vector_index`, `data_bank_attribute_index_v2`, the per-domain indexes | `schema-seed.ts`, `ontology-seed.ts` | exists |
| the `node_key` and `date_added_to_graph` indexes the cursor and the newcomer tick seek on | the seeds, and the pass at open | partly |
| a vector on every marked node, whoever wrote it | the pass (§1) | new |
| the no-embed mark | the Schema node (`embed: false`, via the re-dumped fixture); strut's code for its own two types | new |
| `Domain_*` labels | strut's writer (exists) and the pass (new); strut's typed search and jarvis's search read the per-domain indexes | — |

## Tests

Live, `npm run test:graph` (throwaway Neo4j):

- A node written raw over bolt as stakgraph writes one (`Function:Data_Bank`,
  `name` + `description`, `Data_Bank` = the name, no label, no vector) is
  embedded by one sweep: `Data_Bank` becomes `name\ndescription`,
  `_search_fields_used` `[name, description]`, and it gains
  `Domain_codeartifact`. A description added later re-embeds it; a
  description edited later re-embeds it; a `Data_Bank` reset to the name
  by a stakgraph-shaped `ON MATCH SET += {Data_Bank: name}` re-embeds it.
  An unmarked type and a type with no Schema node are left alone and are
  named in the status. A node whose index fields are all blank is left
  alone; a second sweep over a clean graph writes nothing.
- The cursor: a type of 2,500 nodes is swept in pages, every node visited
  once; a sweep interrupted after a tick resumes at its cursor; a
  newcomer written between sweeps is embedded by the next tick without a
  sweep.
- No-embed: a `StrutToolCall` strut's writer projects has `Data_Bank` and
  no vector (`prepareMany` and `update` both); a Schema with `embed:
  false` is honored for a jarvis-typed node; a `Turn` holding a vector
  loses it on the next sweep and is never embedded.
- Labels: the pass adds the label the resolver computes, and none for a
  hidden type or domain.
- The reconcile widens a live `index: "name"` to the library's list,
  leaves a live `index` with an extra field, an absent `index` and a type
  the library lacks alone, writes nothing on a second run, and does not
  run again under the same fixture version after the live list is
  narrowed by hand.
- Search: a typed query is routed through the type's domain index and
  finds an unlabeled-then-labeled `Function` among nearer decoys of
  another domain (fake embedder with chosen vectors); a type with no
  domain goes to the global index and the over-fetch is exercised;
  hidden-domain types stay out; `domains` filters as before.
- `GET /graph/embeddings` reports the sweep and the skipped types.
- With `STRUT_TEST_EMBEDDINGS=1`: a question with none of the function's
  words finds it by its description.

Offline: the pass's text equals `buildSearchText` for an explicit `index`;
the stale decision on a page of rows (stale / clean / blank / list-valued);
the over-fetch widening stops at `cap` survivors or the ceiling; the
routing table (type → domain index, no-domain → global).

## Validation on swarm38

1. `GET /graph/embeddings` after the first tick: the stale counts per type
   and the skipped types, against "Problem" above; the boot log lists the
   `index` lists the reconcile widened. `PROFILE` the page query on
   `Function` and `Turn`: an index seek on `node_key`, no label scan.
2. After the first sweep: the question above, `type: Function,Endpoint`,
   returns `resolveWorkspaceAccess` / `validateWorkspaceAccess` in the top
   five, through strut's `graph/graph-search` and through jarvis's search
   (the code since May now carries its label). `Turn` and `StrutToolCall`
   hold no vectors. Re-sync a repository and check a function's
   `Data_Bank` is still the composed text (with §5) or is stale for one
   tick and then is again (without it). Then rerun the 2026-10-11 explore
   question.
3. Only then revisit the explore prompt: stakgraph branch
   `feature/explore-graph-first-search` (`c31b98fe`, unpushed — "begin with
   one graph search") made one search and went back to grep. Rerun it on a
   question with no keyword.

## Not doing

- **Healing through jarvis's Schema API.** A one-shot with the costs in §2;
  the pass is needed anyway for whatever is written next.
- **stakgraph's BGE `embeddings` as a third retriever.** A second model in
  strut, and a vector of the code body; a question matches a written
  description better. Adds nothing once §1 runs.
- **Per-type vector indexes.** The domain route (ruling 5) is the
  pre-filter; a per-type index is the escape hatch if measured recall on
  a rare type within a big domain says so.
- **The keyword half.** A question already falls back to a fuzzy any-word
  match when the every-word query finds nothing; whether that fallback
  should weigh less than the semantic half is a tuning question after this
  lands.
- **Embedding at ingest in stakgraph.** The pass covers any writer; a writer
  that embeds itself is adoption, not a dependency. (§5 is not that: it
  stops stakgraph from undoing a write, it does not teach it to embed.)
- **A persisted cursor.** A restart re-sweeps; a clean sweep is cheap.

## Open questions

- **Two strut processes on one graph** would both run the pass. The writes
  are idempotent and the cursor is per process, so this is wasted CPU, not
  corruption; the scheduler has the same single-process stance.
