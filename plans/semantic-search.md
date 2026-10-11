# Semantic search without jarvis — strut keeps the graph's vectors

> **Status (2026-10-11): PROPOSED, nothing built.** Written after a seeded
> `explore` run on swarm38 never used the graph (job run `1791735838490` →
> explore run `1791735843683`, a question about hive's GitHub integration:
> 0 graph calls, 16 file reads), and revised the same day after review:
> execution records (`Turn`, `StrutToolCall`, `StrutTurn`) get no vector
> (decided); the mark for that lives in strut's code while jarvis is on a
> graph; the pass writes the domain label strut's writer would; and jarvis's
> Schema API is not the route to current `index` lists (§2 says why). Every
> number below was read from swarm38's graph that day (read-only Cypher
> through stakgraph's `/api/hive/query`), from jarvis-backend (`04317241`),
> or from this checkout (`d9eaec4`, main). The choices still to confirm are
> under "Rulings". Companions this stands on: `jarvis-graph-compat.md` (§2
> embeddings parity — MiniLM, `Data_Bank`, the `index` fields; the bundled
> ontology seed), `generic-storage.md` (the label registry). No host
> changes: it reaches a swarm with the next strut pin in mcp.

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
(`resolveWorkspaceAccess`, `validateWorkspaceAccess`). Four reasons, all
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
jarvis, strut's writer and the pass share), one repair job (the pass).

**All of it is code that runs by itself.** Nothing is run by hand on any
swarm: no API call, no script, no migration command. It reaches every swarm
with the next strut pin in mcp. At that boot the reconcile (§2) updates the
stale `index` lists in seconds, and the pass (§1) starts in the background,
catches up, and keeps up from then on. The one switch is the existing
`STRUT_GRAPH_EMBEDDINGS=off`.

## Rulings

1. **The text is the Schema's `index`.** It is already the declaration
   both jarvis and strut read for "the search text of a node of this type"
   (`get_search_fields_for_node`; strut's `searchFieldsFor` /
   `buildSearchText` in `src/graph/node-writer.ts`). A type whose Schema
   declares `index` is embedded from those fields. The pass never falls
   back to jarvis's catch-all text (every property, joined) for a type
   without one: on swarm38, 193 of 255 types declare `index`, and the 62
   that do not (61 `Cloud`-domain Advisor*/Kn* types and `Content`) and the
   types with no Schema node (`Context`, `Chunk`) are skipped.
2. **Execution records get no vector — decided (Evan, 2026-10-11):
   `Turn`, `StrutToolCall`, `StrutTurn`.** Too fine-grained to search by
   meaning. `AgentSession` and `StrutAgentSession` (one per agent run) stay
   embedded. The keyword text (`Data_Bank`) stays. strut's writer stops
   embedding `StrutToolCall` and `StrutTurn`, and the pass removes the
   vectors these types already have (410,738 on `Turn`, 37,128 on
   `StrutToolCall`). Where the mark lives:
   - **In strut's code while jarvis is on a graph:** a strut-only field on
     the two `StrutSchema`s, never written to the Schema node (as
     `exact_key` is), and for `Turn` — a jarvis-library type stakgraph
     writes — a strut-side entry keyed by type name beside the bundled
     library.
   - **Not on the Schema node yet.** jarvis reads every Schema property
     outside its `SCHEMA_CORE_PROPERTIES` as an attribute declaration, and
     strut mirrors that list, so an `embed: false` there would read as an
     attribute named `embed` of type `false`. Once jarvis is gone the mark
     moves onto the Schema node (one key added to strut's core list);
     adding the key to jarvis's list would allow it sooner.
   - **Not `About.hidden_types`.** That hides a type from untyped search
     and withholds its `Domain_*` label; strut's resolver follows it, and
     strut's soft delete is scoped by `Domain_strut`.
   - **Not removing `index`.** To jarvis and to strut's writer, a type with
     no `index` gets the catch-all text: they would embed more, not less,
     and the keyword text would change with it.
3. **strut brings stale `index` lists up to the library by writing them
   directly.** At backend open, on every graph (jarvis-hosted included): a
   live Schema whose `index` is non-empty and a strict subset of the bundled
   library's for that type gets the library's list. A type the library does
   not know, a live `index` holding a field the library lacks (5 on swarm38:
   Commit, Contributor, ProposedFix, AgentSession, Prompt), and an absent
   `index` (the catch-all, a different meaning) are left alone. The library
   is jarvis's own, so these are the values jarvis would set — but never
   through jarvis's Schema API (§2).
4. **The pass is the one repair job, and it writes what strut's writer
   would have.** For a node of a marked type that has no vector, or whose
   vector is missing a field that now has a value: the search text
   (`Data_Bank`), the vector, `_search_fields_used`, and the domain label —
   the resolver's, which follows jarvis's rule (none for a hidden type or
   domain), as `prepareMany` already puts on every node strut writes. The
   label is for jarvis's search: hive's `kgSearch` and mcp's `graph_agent`
   tools and `jarvis/*` steps read the domain vector indexes. strut's
   search does not read it, and once jarvis is gone nothing does. The pass
   runs inside the strut process, at backend open and on a timer. Hidden
   domains are embedded too: hiding stays a search-time filter.
5. **One vector index, filters in the query.** The semantic retriever reads
   `text_embeddings_vector_index`; `type`, hidden domains and `domains` are
   `WHERE` filters, with over-fetch to make up for Neo4j 5 filtering after
   the nearest-k cut. strut's search stops reading `Domain_*` labels.

## 1. The pass — `src/graph/embeddings.ts`

`backfillEmbeddings` today embeds `Domain_strut` nodes whose stored
`Data_Bank` has no vector, plus the per-field `{stem}_embeddings` of
strut's own `vector_index` types. It becomes the pass for every marked
type, resolved through `SchemaResolver` (`schema-resolver.ts`, which
already turns a string `index` into a one-item list):

- **Stale** means a vector is missing, or a field the Schema names has a
  value that was not in the embedded text. That catches a node never
  embedded (stakgraph's ingest), a node embedded before the Schema widened
  (the 2,900 name-only vectors), and a field filled in after the node was
  written (stakgraph's descriptions arrive after its nodes). One query per
  type `T` with index fields `$F` (`T` comes from a Schema node and must
  pass a label-name check before it is interpolated: Neo4j 5.19 has no
  dynamic labels):

  ```cypher
  MATCH (n:`T`)
  WITH n, [f IN $F WHERE trim(coalesce(toStringOrNull(n[f]), '')) <> ''] AS present
  WHERE size(present) > 0
    AND (n.text_embeddings IS NULL
         OR any(f IN present WHERE NOT f IN coalesce(n._search_fields_used, [])))
  RETURN n.ref_id AS ref_id, [f IN $F | n[f]] AS values
  LIMIT $batch
  ```

  Run as a count on swarm38 (5.19), it flags 10,681 of hive's Functions
  under today's `index: "name"` and all 13,581 under the library's
  `[name, summary, description]`.

- **Writes** what strut's writer writes, nothing new: `Data_Bank` (the
  text, from `buildSearchText` — the writer's composition and jarvis's),
  `text_embeddings`, `_search_fields_used`, and the resolver's domain label
  when the node lacks it. Overwriting stakgraph's name-only `Data_Bank` also
  feeds `data_bank_full_index` (fulltext on that property) the richer text.
- **No-embed types** (ruling 2) are never embedded, and a vector found on
  one is removed (`REMOVE n.text_embeddings`; `Data_Bank` stays). A standing
  rule, not a one-off, so a `Turn` some other writer embeds loses its vector
  on the next tick.
- **No loop.** A value the query counts as absent (blank, or a list) is
  never required to be in `_search_fields_used`, so a written node is not
  stale again.
- **Per-field vectors** (`vector_index` → `{stem}_embeddings`, what
  `input_q` / `output_q` read): the same pass, missing vectors only, as
  today, from live Schemas instead of strut's list alone.
- **Schedule.** A timer in the strut process, started when the graph
  backend opens; the first tick runs right away, then every minute. It never
  holds up boot: today's awaited `backfillEmbeddings` call in
  `openGraphBackend` becomes the start of the timer. Each tick takes one
  batch (100) from each type that has work, round-robin, until 15 s are
  spent. A type found clean is checked again after 15 minutes, not
  every tick: a clean check of a big type is a scan of all its nodes. One
  pass at a time per backend (`openGraphBackend` is cached per process).
  Constants, not settings, until a swarm says otherwise. One log line per
  tick: embedded and removed per type, types still dirty.
  `STRUT_GRAPH_EMBEDDINGS=off` turns it off with the embedder.
- **Not caught:** an edit to a field that was already embedded (same
  fields, new words). strut's own writer re-embeds on every write; another
  writer's edit keeps the old vector. If that matters, add a slow cursor
  that compares the stored `Data_Bank` with the composed text (§"Not
  doing").

**Throughput.** strut's `MiniLMEmbedder`, measured on an M4 Max: ~1,900
texts/s at ~25 tokens, ~110/s at the 256-token cap. A swarm's CPU is
slower; measure there before trusting these estimates. With the execution
records out, the first catch-up on swarm38 is at most ~144k nodes (the 47
widened types without `Turn`), the code types (~40k) first: at a third of
the M4 rates and the 25% duty cycle above, the code is done in minutes and
the rest in an hour or a few. The ~448k vector removals are writes only.

## 2. The Schema reconcile — `src/graph/ontology-seed.ts`

A new boot step in `openGraphBackend`, beside the migrations that already
run there (`migrateRunStatus`, `migrateExactKeys`), before the pass starts —
not gated on `STRUT_GRAPH_SEED_ONTOLOGY`, since swarm38 is the graph that
needs it. A few dozen property writes at most, so it runs inline: for each
live `:Schema` whose type the bundled library has, normalize
`index` (string → list), and set the library's list when the live one is
non-empty and a strict subset. It only ever touches `index`, needs no
ledger (the subset test is idempotent), and returns what it widened for
the boot log. The pass then sees every node of a widened type whose new
fields hold a value as stale — no vector migration of its own.

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

Written directly, the new `index` triggers nothing in jarvis: it has no
repair job (its embedding worker only drains the queue its own API writes
fill; its startup backfill is a migration-tracked one-shot that ran on
Apr 11). jarvis uses the new lists for nodes later written through its API,
composing the same text the pass does. The next Schema update anyone makes
through jarvis's API rebuilds its keyword index from the Schemas as they
then are — the lists jarvis's own library declares.

## 3. Search — `src/graph/search.ts`

- The `q` semantic layer queries `GLOBAL_VECTOR_INDEX`
  (`text_embeddings_vector_index`), not `domain_all_vector_index` or the
  domain union.
- Filters stay where they are, after `queryNodes`: namespace, visibility,
  `type`, hidden-domain types. `domains` becomes the same kind of filter
  (the type labels whose Schema `domain` is listed) on both layers, so the
  fulltext layer also stays on its global index (`data_bank_attribute_index_v2`).
- **Over-fetch.** Unfiltered: `k = cap`, as today. With a type, domain or
  hidden-domain filter: start at `k = cap × 10` and multiply by 4 until
  `cap` hits survive or `k` reaches 2,000. Constants to tune on swarm38.
  Per-type vector indexes are the escape hatch if a rare type still
  starves; they are not built now.
- `input_q` / `output_q` are unchanged (per-label indexes from
  `vector_index`).

## A graph with no jarvis then needs

| what | who creates it | today |
|---|---|---|
| `:Schema` nodes for the types it holds | the ontology seed (`STRUT_GRAPH_SEED_ONTOLOGY=1`) | exists |
| `index` lists as current as the library | the reconcile (§2) | new |
| `text_embeddings_vector_index`, `data_bank_attribute_index_v2` | `schema-seed.ts`, `ontology-seed.ts` | exists |
| a vector on every marked node, whoever wrote it | the pass (§1) | new |
| the no-embed mark | strut's code; the Schema node once jarvis is gone | new |
| `Domain_*` labels | strut's writer (exists) and the pass (new); nothing reads them once jarvis is gone | — |

## Tests

Live, `npm run test:graph` (throwaway Neo4j):

- A node written raw over bolt as stakgraph writes one (`Function:Data_Bank`,
  `name` + `description`, `Data_Bank` = the name, no label, no vector) is
  embedded by one pass: `Data_Bank` becomes `name\ndescription`,
  `_search_fields_used` `[name, description]`, and it gains
  `Domain_codeartifact`. A description added later re-embeds it. An
  unmarked type and a type with no Schema node are left alone. A blank or
  list-valued index field does not loop: a second pass writes nothing.
- No-embed: a `StrutToolCall` strut's writer projects has `Data_Bank` and
  no vector; a `Turn` holding a vector loses it on the next pass and is
  never embedded.
- Labels: the pass adds the label the resolver computes, and none for a
  hidden type or domain.
- The reconcile widens a live `index: "name"` to the library's list, leaves
  a live `index` with an extra field, an absent `index` and a type the
  library lacks alone, and writes nothing on a second run.
- Search finds an unlabeled `Function` by `q` with `type: Function` among
  nearer decoys of another type (fake embedder with chosen vectors), so the
  over-fetch is exercised; hidden-domain types stay out; `domains` filters.
- With `STRUT_TEST_EMBEDDINGS=1`: a question with none of the function's
  words finds it by its description.

Offline: the pass's text equals `buildSearchText` for an explicit `index`;
the over-fetch widening stops at `cap` survivors or the ceiling.

## Validation on swarm38

1. The pass's first log lines give the stale count per type, and the boot
   log lists the `index` lists the reconcile widened; check both against
   "Problem" above.
2. After deploy: the question above, `type: Function,Endpoint`, returns
   `resolveWorkspaceAccess` / `validateWorkspaceAccess` in the top five,
   through strut's `graph/graph-search` and through jarvis's search (the
   code since May now carries its label). `Turn` and `StrutToolCall` hold
   no vectors. Then rerun the 2026-10-11 explore question.
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
- **Per-type vector indexes.** The escape hatch in §3, if measured recall
  says so.
- **The keyword half.** A question already falls back to a fuzzy any-word
  match when the every-word query finds nothing; whether that fallback
  should weigh less than the semantic half is a tuning question after this
  lands.
- **Embedding at ingest in stakgraph.** The pass covers any writer; a writer
  that embeds itself is adoption, not a dependency.
- **The comparing cursor** for edits of already-embedded fields (§1) —
  later, if stale descriptions show up in practice.

## Open questions

- **Two strut processes on one graph** would both run the pass. The writes
  are idempotent, so this is wasted CPU, not corruption; the scheduler has
  the same single-process stance.
