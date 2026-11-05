# Ontology: one native seed, runtime types, no Jarvis library in strut

> **Status (2026-11-05): ruled (Evan, the same day; §9).** Written after a read of
> `main` @3e0f23b and three boots of a fresh strut on a throwaway Neo4j
> 5.26.32 (`STRUT_WORKSPACE_BACKEND=graph`, embeddings on), one per mode:
> - the Jarvis library seed off;
> - the seed on;
> - the seed off, plus Claim / Check / Evidence / Concept and their edge
>   rules, taken from Ladybug's seed.
>
> Companions: `ladybug-backend.md` (ruling 6, amended 2026-10-28),
> `graph-memory-plan.md` (step 9), `jarvis-graph-compat.md`, `semantic-search.md`.

## In brief

- **Stadeum does not need Jarvis's library. Strut does need four of its
  types.** On Neo4j, strut's own seed is the 14 `Strut*` types and `Thing`.
  Strut also writes `Claim`, `Check`, `Evidence` and `Concept`, and on Neo4j
  only Jarvis's library declares them. So with the seed off, claims and
  Concepts break. Everything else works without it.
- **Neo4j is already dynamic.** Types are `:Schema` nodes, and agents and
  apps create them at runtime through the same `createNodeSchema` Ladybug
  uses. The two engines differ in their SEED, not in the mechanism.
- **The approach:** one native seed shared by both engines. It holds
  Thing, the Strut types, and the four types with their edge rules, as
  Ladybug's seed already does. Every other type is created at runtime.
  Jarvis's bundled library leaves strut. On a swarm, Jarvis's types are
  Jarvis's own rows in the graph and read as they are today.
- **A defect found on the way, unrelated to Jarvis.** On Neo4j, a runtime
  type's fields never reach the keyword index when an earlier type in its
  domain created the index first. Ladybug avoids this because it has one
  index over the search text. Neo4j should do the same.

## 1. What the Jarvis port does, and who needs it

**The pieces:**

| Piece | What it does | When it runs |
|---|---|---|
| `fixtures/jarvis-ontology.ts` (151 KB) | 153 Schemas and 346 edge schemas dumped from a Jarvis seed: Legal 40, CodeArtifact 39, Content 18, Workflow 16, Entity 14, Hive 11, KnowledgeArtifact 6, Epistemic 3 (Claim, Check, Evidence), General 1 (Concept), and others | read by the three rows below |
| `seedJarvisOntology` (`ontology-seed.ts:42`) | writes those Schemas, their `CHILD_OF` edges, the per-type constraints, the edge schemas, the global fulltext `data_bank_attribute_index_v2`, and one fulltext + one vector index per domain over a 158-property union | Neo4j, only with `STRUT_GRAPH_SEED_ONTOLOGY=1` (`backend.ts:344-354`) |
| `upgradeClaimSchema` (`claim-schema-upgrade.ts`) | re-keys a pre-119 standalone `Claim` Schema | the same flag |
| `reconcileIndexLists` (`index-reconcile.ts:67`) | widens a live Schema's `index` list to the library's | **every Neo4j boot** (`backend.ts:370`), so every Neo4j process loads the fixture |
| `seedStrutDomain` (`schema-seed.ts:105`) | writes `Thing` (when absent), the 14 `Strut*` Schemas (`strut-schemas.ts:236`), their constraints, `Domain_strut`'s fulltext and vector indexes, and the global vector index | every Neo4j boot |
| `Data_Bank` / `Domain_<d>` / `node_key` | Jarvis's storage names: the label and property for the search text, the domain label, the key | Neo4j writer + reader; mapped at the engine boundary (`neo4j-engine.ts`) |

**Who depends on what** (each row checked in code, and in the live runs where marked):

| Dependent | Needs | Without the library |
|---|---|---|
| Projector's `Strut*` types | strut's own registry | works (live: `StrutRun` projected) |
| Claims (`claims-writer.ts`, `verify.ts`) | `Claim`, `Check`, `Evidence`, and the edge rules `ABOUT`, `EVIDENCED_BY`, `HAS_SOURCE`, `SUPERSEDES` (`claims.ts:52-57`). `TESTS` and `PRODUCED_BY` pass through Jarvis's allowlist (`schema-resolver.ts:53`) | **breaks** (live): publishing a `claims:` block answers "Claim: unknown node type", `browser-capture`'s claims fail at boot, and no evidence is written |
| Concepts (`concept-seed.ts:209`, `context/concept`, `ai/builder-system.ts`) | `Concept`, plus `PARENT_OF` (allowlisted) | **breaks** (live): strut's pages (`Job`, `Workflow Builder`, `App`) are not seeded and `context/concept` returns `""`, so the job, builder and orchestrator prompts lose their manual |
| Memory | the `memory/*` steps use their own Ladybug file. Memory on the graph (`assert`, `resolve`, `merge`, dictation) is Ladybug-only (`temporal.ts:138`, `resolve.ts:115`, `merge.ts:128`, `dictation/_graph.ts:42`); `Person` and `Lingo` come from Ladybug's seed | unaffected |
| Apps' `data.graph` | `createNodeSchema` and `createEdgeSchema` (`apps/graph-types.ts:206,213`), parent `Thing` | works (live: `Recipe`, `Ingredient`, `USES_INGREDIENT`) |
| `graph/*` steps | any type with a Schema | works (live: `create-schema`, `create-node`, `create-triplet` with `create_schema_if_missing`) |
| Embedding pass | the Schemas that exist | works. With the library it sweeps 163 types instead of 12 |
| Search | `routeIndexes` falls back to the visible domains' indexes when the global index is absent (`search.ts:294`) | works, with the keyword defect in §2 in both modes |
| Projector's speaker edges (`SENT` from `HiveWorkspaceMember` or `Person`) and `PUBLISHED_BY → Person` | Jarvis types | skipped when the types are absent (`projector.ts:893`): swarm-only by design |
| Hive and stakgraph data on a swarm (`HiveWorkspace*`; code types such as `Function`, `File`, `Endpoint`) | Jarvis's LIVE ontology, which Jarvis seeds itself; the flag is off on swarms | strut only reads these (search, the pass, the reconcile) |
| stakgraph lab tests (`janitor/seed.test.ts`, `concepts/__tests__/pages.test.ts`, the smokes) | they set the flag | outside strut |

Every other Jarvis type name in strut's code is a default or a comment:
`EXCLUDED_NODE_TYPES` (Hint, Memory, Clip, Turn), the `Entity` parent
chain in `requiresTitle`, and words in the UI.

**So:** strut needs four non-Strut types and their edge rules, and nothing
else of the library's 153 types.

## 2. Is Neo4j dynamic?

**Yes.** The writer's gate is `resolver.schema(type)` (`node-writer.ts:493`):
- A `Strut*` type comes from code.
- Any other type needs a `:Schema` node whose `CHILD_OF` chain reaches an
  existing parent (`Thing` by default), with its key tokens declared.
- An edge needs an edge schema (exact match, an ancestor walk, or the `*`
  wildcard), unless the edge type is on Jarvis's 60-type allowlist
  (`schema-resolver.ts:314`).

`createNodeSchema` (`schema-crud.ts:308`) writes the Schema node and its
`CHILD_OF` edge, the per-type constraint and index, and the domain's
fulltext and vector indexes. Agents reach it through `graph/create-schema`,
apps through `registerAppGraph`. With the seed off, every runtime path in
the live run answered Success.

**The defect.** The domain fulltext index is created `IF NOT EXISTS` over
the FIRST type's searchable fields and never widened
(`schema-crud.ts:380-384`).
- Live: `domain_entity_attribute_index_v2` held Widget's 5 properties.
  `Gadget.spec` and `Recipe.steps` were not in it, and a direct
  `queryNodes` for "titanium" or "tamarind" found nothing. `graph-search`
  found those nodes only through its vector half.
- The seed does not fix it: the library's indexes are a fixed 158-property
  union, and it lacks `spec` too.
- Jarvis rebuilds its indexes when a Schema changes, which is what makes
  its Schema API slow.
- Ladybug has one FTS index over `search_text`, which the writer composes
  from each type's `index` fields, so a new type is searchable at once.

## 3. What Ladybug got, and what Neo4j needs

- **#386 (PR A, the dynamic ontology)** gave Ladybug what Neo4j already
  had: types as Schema rows in the file, seeded from `ladybug/registry.ts`
  and created at runtime by the same `createNodeSchema` / `createEdgeSchema`.
- **#508** stopped loading the fixture on Ladybug. Ladybug's seed was
  already Jarvis-free. Neo4j still loads the fixture on every boot, for the
  reconcile.
- **Ladybug's seed** (`registry.ts:94`) is the 10 Strut types it keeps, plus:
  - `Claim`, `Check`, `Evidence`, `Concept`, under Jarvis's names and key
    specs but with only the attributes strut reads and writes;
  - `Person` and `Lingo` (memory);
  - three record types (`EdgeText`, `Merge`, `Mishearing`);
  - 16 edge rules for claims and Concepts (`registry.ts:215`).

**Where the engines differ, and whether they need to:**

| | Neo4j | Ladybug | Does the difference need to exist? |
|---|---|---|---|
| Seed | 14 Strut types + Thing (+153 with the flag) | above | **No.** Neo4j lacks four types strut writes. Share the seed (§5) |
| Strut types resolved from | code (Schema nodes written for Jarvis's sake) | rows | For now. On a swarm Jarvis reads those nodes, and `exact_key` / `embed` stay in code because an older Jarvis misreads them (`schema-seed.ts:94-101`) |
| Edge types allowed without a rule | Jarvis's allowlist | none | Only where Jarvis shares the graph (ruling 1) |
| Keyword index | one per domain, over attribute lists | one over the search text | **No.** It is the defect in §2 |
| Temporal edges, resolve, merge, namespaces | refused | built | Out of scope. Memory on Neo4j is a plan of its own |

## 4. Stadeum: the live runs

| | Seed off | Seed on | Seed off + four native types |
|---|---|---|---|
| Boot | 6.8 s | 15.9 s | 6.8 s |
| Schema nodes / indexes | 15 / 41 | 167 / 361 | 19 / not counted |
| strut's Concept pages | none | 3 | 3 |
| `context/concept` on `Job` | 0 chars | 3,197 | 3,197 |
| A `claims:` block | unknown node type | recorded; `supported` | recorded; `supported` |
| Evidence and edges | none | written | `ABOUT` 2, `TESTS`, `EVIDENCED_BY`, `PRODUCED_BY`, `HAS_SOURCE` |
| Runtime types, triplet, app `data.graph` | work | work | work |
| Concept search | none to find | finds them | finds them |
| Keyword hits on a later type's fields | missed | missed | missed |

Evan's hypothesis holds, with one correction: "strut's native types" must
include `Claim`, `Check`, `Evidence` and `Concept`. On Ladybug they already
do. On Neo4j they do not, and that gap is the only reason Stadeum turns
the library on.

## 5. The approach

1. **One native seed in code, shared by both engines.** It holds Thing,
   the Strut types, and Claim / Check / Evidence / Concept with their edge
   rules, defined once in a module both engines read.
   - Ladybug adds its engine-own types on top: `Person`, `Lingo`, the
     records. They stay Ladybug's until memory comes to Neo4j (ruling 3).
   - On Neo4j, `seedStrutDomain` creates each of the four only when it is
     missing (create-only). It uses Jarvis's key specs and domains (Epistemic,
     General).
   - A type someone else made is theirs. On a swarm, Jarvis's rows already
     exist and nothing changes.
2. **Every other type is created at runtime**: by an agent
   (`graph/create-schema`, `create_schema_if_missing`), an app (`data.graph`)
   or a package. This already works on both engines.
3. **Jarvis's edge allowlist applies only where Jarvis shares the graph**,
   which strut knows by Jarvis's `About` node. Jarvis's migrations create it
   (`about_116_single_about_node.py`, and 099 before it), and strut only
   reads it (`neo4j-engine.ts:541`, `search.ts:821`). Elsewhere, an edge
   needs a rule, as on Ladybug. Strut's own edges have rules from the seed.
4. **Jarvis's bundled library leaves strut**: the fixture, its seed, the
   Claim upgrade, the index reconcile, and the flag. §8 is why that is safe
   for swarms.
5. **One keyword index on Neo4j, as on Ladybug:** a fulltext index over the
   composed search text (the `Data_Bank` property). Strut writes it, Jarvis
   writes it, and the embedding pass keeps it current for every Schema-marked
   type. The reader's keyword half reads it with the same type filter and
   over-fetch as its vector half.
   - The title boost is applied after the query (`search.ts:545`) and stays.
   - The domain vector indexes stay: they route rare types on big graphs.


## 6. Work items (one PR each, in this order)

1. **Claim, Check, Evidence and Concept in Neo4j's native seed.**
   - Move the four definitions and their edge rules out of
     `ladybug/registry.ts` into a shared module (e.g. `src/graph/seed-types.ts`).
   - Ladybug's `ontologySeed()` hash must stay byte-identical, so no Peel
     file re-seeds; a test pins it.
   - `seedStrutDomain` creates the four when missing, with constraints and
     edge rules (the 16 Ladybug holds, `TESTS`, `PRODUCED_BY` and
     `PARENT_OF` among them).
   - Drop `STRUT_GRAPH_SEED_ONTOLOGY` from strut's `docker-compose.yml`, and
     fix the `concept-seed.ts:211` message.
   - Tests (`testBackends`):
     - a fresh Neo4j with the flag off seeds the Concept pages, records a
       `claims:` block and writes evidence (this plan's third run, as a suite);
     - a graph holding Jarvis's `Claim` keeps it unchanged.
   - Expect hard-coded Schema counts in the Neo4j suites to change; CI's
     unit job skips them, so run `npm run test:graph`.
2. **Jarvis's edge allowlist only on a Jarvis graph.** The resolver reads
   the allowlist only when the graph holds an `About` node
   (`schema-resolver.ts:314`), read once per resolver like the hidden
   domains.
   - Test: on a fresh Neo4j, every edge strut itself writes (claims,
     Concepts, the projector, an app's `data.graph`) still writes, and
     `RELATED_TO` between two runtime types is refused without
     `create_schema_if_missing`.
   - Test: with an `About` node, the allowlist behaves as today.
3. **Remove Jarvis's bundled library from strut.**
   - Delete:
     - the code: `fixtures/jarvis-ontology.ts`, `ontology-seed.ts`,
       `claim-schema-upgrade.ts`, `index-reconcile.ts` and their tests;
     - the flag: in `backend.ts`, `steps/lib/graph/_shared.ts:90`, the
       cache key and AGENTS.md's env row;
     - their exports from `src/index.ts`.
   - Move `jarvis-free-boot.test.ts` onto Neo4j too: the boot loads no
     fixture.
   - The `Migration` rows these steps stamped stay in each graph, harmless.
   - Before it merges, two checks (§8): every swarm carries the reconcile's
     stamp, and stakgraph no longer imports what this removes.
4. **One search-text keyword index on Neo4j.**
   - `seedStrutDomain` creates it, and the reader routes its keyword half
     there.
   - `createNodeSchema` stops creating domain fulltext indexes, and the
     §2 case becomes a test.
   - On a swarm, Neo4j builds the index in the background over every node
     (~330k on swarm38). Compare rankings on a copy before switching swarm
     search to it.

## 7. What changes for Stadeum

- Once item 1 is in a published image, bump `STRUT_IMAGE_TAG` and remove
  `STRUT_GRAPH_SEED_ONTOLOGY: "1"` from `stack/stadeum.yml:166` and
  `docs/stack-spec.md:122`. Boot drops from ~16 s to ~7 s.
- No cleanup: no Stadeum box exists yet (ruling 2), so every box starts on
  the native seed.

## 8. What changes for swarms: nothing, and why

A swarm's ontology is Jarvis's own rows in its graph. Strut's resolver
reads them live, so every type a workflow on a swarm uses
(`HiveWorkspace`, the code types, Jarvis's Claim and Concept) resolves as
it does today. Each item, checked against the code on 2026-11-05:

- **Item 1:** nothing changes. Jarvis's rows for the four types already
  exist there, so the create-only seed skips them, and the keys are the
  same.
- **Item 2:** nothing changes. Every Jarvis graph has `About`, so the
  allowlist still applies there.
- **Item 3:**
  - **The library seed and the Claim upgrade never run on a swarm.** Both
    need the flag, and nothing on a swarm sets it: sphinx-swarm and mcp's
    runtime don't. Only stakgraph's tests, smokes and docs do.
  - **The index reconcile runs on a swarm, but has already done its work.**
    - It is stamped once per library version
      (`strut_index_reconcile_m125-code-description`). On a stamped graph it
      reads that one ledger row and stops.
    - Jarvis's own library on master already holds the widened lists
      (`Function` `[name, summary, description]`; the code types'
      `description`, jarvis-backend 4bbb5616), so a new swarm's Jarvis
      seeds them itself.
    - **Check:** before the PR merges, read every swarm's `Migration`
      ledger for the stamp (read-only, through the Cypher proxy). A swarm
      without it boots the current strut once first.
    - From then on, a change to Jarvis's index lists ships as a Jarvis
      migration.
  - **stakgraph must stop importing what is removed, first.**
    - `mcp/src/lab/wfbench/smoke.ts` imports `JARVIS_ONTOLOGY` from strut,
      and mcp's build compiles it; it is not a test file.
    - The live lab tests (`janitor/seed.test.ts`,
      `concepts/__tests__/pages.test.ts`) set the flag to get
      `HiveWorkspace` and the code types on a bare Neo4j.
    - Both need the types from stakgraph's side: a copy of the fixture in
      the lab, or the few Schemas they use. That change lands in stakgraph
      before strut's PR merges, or mcp's next strut bump fails to build.
- **Item 4:** a one-time index build on each swarm; compare the rankings
  first.
- **No data migration.** A swarm that later drops Jarvis keeps Jarvis's
  rows as ordinary runtime types.

## 9. Rulings (Evan, 2026-11-05)

1. **Jarvis's edge allowlist applies only where Jarvis shares the graph.**
   Off-swarm, an edge needs a rule, as on Ladybug (item 2).
2. **No cleanup of library types on Stadeum boxes**: none exist yet.
3. **No `Person` or `Lingo` in the shared seed for now**: they come with
   memory on Neo4j, if that is built.
4. **Delete Jarvis's seed from strut, as long as it is safe**: swarms must
   keep working exactly as today, since workflows there run on Jarvis's
   types. §8 is the safety case, and item 3 waits on its two checks.
5. **The four types keep Jarvis's domains** (Epistemic, General) on a fresh
   box, for parity with swarms.
