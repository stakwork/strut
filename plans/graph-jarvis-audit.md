# Graph memory: what the Ladybug path still carries from Jarvis

The audit half of step 9 of [graph-memory-plan.md](graph-memory-plan.md). Read only: nothing here was run against Peel's data, and no source changed. Line numbers are from `main` at `1bdda6e`.

## Verdict

**Step 9 is small, about three small PRs and one optional cleanup.** The Ladybug path is already much cleaner than the plan feared:

- It never seeds the Jarvis ontology. `seedJarvisOntology`, `upgradeClaimSchema` and `reconcileIndexLists` run only in the Neo4j branch of `openGraphBackend` (`backend.ts:278-310`); `openLadybugBackend` runs none of them (`backend.ts:25-28`).
- Its Thing is already stripped (`THING_SEED`, `registry.ts:350`; `THING_VESTIGES`, `registry.ts:45`).
- Its edge allowlist is already off (`schema-resolver.ts:314`, `!holdsStrutTypes`).
- The `IS_ALIAS` rewrite, `is_muted`, `BLOCKED_NODE_STATUSES` and `Domain_*` labels exist only in Cypher that runs on Neo4j.
- The Jarvis names are mapped only in `neo4j-engine.ts`.

What is left is shared code that serves both engines and was never split: lists of Jarvis names, one dropped property, one 150 KB fixture that loads on every import, and a few display columns nobody reads. None of it changes what Peel stores, except item 6 (display columns), which only changes what a new file gets.

Two things are **not** baggage, and removing them would damage Peel: the key sanitizer (item 9) and `unique_source_id` (item 10).

## Items

Reads/writes columns say what the Ladybug path does with the item. "Neo4j needs it" is whether Neo4j still uses it, so it stays or becomes Neo4j-only.

| # | Item | Where | Ladybug reads/writes | Neo4j needs it | Recommendation | Effort |
|---|---|---|---|---|---|---|
| 1 | Bundled ontology fixture (151 KB) | `fixtures/jarvis-ontology.ts`; imported by `ontology-seed.ts:20`, `index-reconcile.ts:32`, `claim-schema-upgrade.ts:32`; exported `index.ts:622-623` | Never loads it, but pays for it: `backend.ts:44` imports `ontology-seed.ts` statically, and `schema-crud.ts:60` imports `searchableAttributesOf` from the same file, so every Ladybug import pulls the fixture in | Yes (seed, `index` reconcile, Claim upgrade) | Make Neo4j-only: lazy-import the three Neo4j boot steps (with a comment), move `searchableAttributesOf` next to `schema-crud.ts`. Keep the files. | S |
| 2 | `_search_fields_used` | written `node-writer.ts:512`, dropped on update `:620`; stripped `search.ts:60`; Neo4j writes it `embeddings.ts:666` | Computed, then thrown away at `ladybug/engine.ts:83` (`DROPPED_PROPS`) | Yes | Make Neo4j-only: set it only when `engine.kind === "neo4j"`, delete `DROPPED_PROPS`. | S |
| 3 | Response stripping lists | `search.ts:55-67`; used by `serializeNode` `:514` and `serializeEdge` `:534` | Reads. Ladybug rows hold none of `spelling_verification`, `topic_lower`, `relevancy_score`, `algo_*`, `*_embeddings` other than `text_embeddings`, `workflow_author`, `labels`, `system_id`; edges none of `edge_text*`, `algo_similarity` | Yes, all of them | Split into a shared core set (`key`, `search_text`, `created_at`, `updated_at`, `ref_id`, `namespace`, `text_embeddings`, `edge_key`, `unique_source_id`, `weight`) and a Neo4j-only set. `serializeNode` already detects a Neo4j node (`date_added_to_graph` in props), so the Neo4j set applies only then. | S |
| 4 | Write-side reserved names | `GENERIC_NODE_PROPERTIES`, `strut-schemas.ts:132-158`; read by `isGenericProperty` (`schema-crud.ts:158`, `node-writer.ts:124`, `schema-resolver.ts`) | Reads: a Ladybug type cannot declare `topic_lower`, `algo_score`, …, though no such column exists | Yes (Jarvis stamps them) | Same split as item 3: core names refuse on both, Jarvis names refuse on Neo4j only. Low value; do it in the same PR as item 3. | S |
| 5 | Kitchen-sink search text | `DATA_BANK_EXCLUDED_FIELDS` (about 70 names: `tweet_id`, `bounty_id`, `pubkey`, `episode_id`…) and `PRIORITY_FIELDS` (`episode_title`, `show_title`, `github_description`…), `node-writer.ts:294-345`; `envelope()` fallback chain `search.ts:570` | Reads, but only when a type has no usable `index` or its index fields are all blank. Every Ladybug seed type has an explicit `index`, so this fires for runtime types only | Yes | **Behaviour change, not a deletion.** Leave until step 3 settles search rows. Later: on Ladybug, fall back to "every non-blank string attribute" and keep the Jarvis lists for Neo4j. Changing the text marks affected nodes stale, so the embed pass re-embeds them. | M |
| 6 | Schema display properties | `icon`, `shape`, `primary_color`, `secondary_color`: `SCHEMA_COLUMNS` `registry.ts:296-299`, written for Strut types by `seedFlat` `registry.ts:376` | **Writes only.** No reader in strut or Peel (I searched both source trees); the Jarvis UI is the only consumer, and it is on Neo4j | Yes (Neo4j Schema seed, `schema-seed.ts`) | Remove from the Ladybug columns and seed. An existing file keeps its empty columns (a column is never dropped, `registry.ts:~262`). The seed id is a hash of the seed, so it changes and the file re-seeds once at next open (`db.ts:350`); that is a rewrite of Schema rows only, not of user nodes. | S |
| 7 | Schema properties with no Ladybug column | `SCHEMA_CORE_PROPERTIES` `strut-schemas.ts:178-196`: `media_url`, `source_link`, `conditional_formatting`, `action`, `display_name`, `paid_properties`, `volatility` | Never written (`splitFlat`, `ladybug/ontology.ts:110`, leaves keys without a column out). The set still matters on read: `splitSchema` (`search.ts:1212`) and the resolver (`schema-resolver.ts:262`) treat these names as core, so a Ladybug type that declares an attribute called `action` or `source_link` is misread as core | Yes (flat Neo4j Schema nodes) | Split the set: Ladybug's core is what `SCHEMA_COLUMNS` holds; the Jarvis display keys join it for Neo4j only. Write a test first that declares `action` on Ladybug to confirm the misread before changing it. | S |
| 8 | Schema columns missing from the core set | `exact_key`, `aliases`, `status`, `naming`, `managed_by` are in `SCHEMA_COLUMNS` (`registry.ts:289-310`) but not in `SCHEMA_CORE_PROPERTIES` | `splitSchema` puts them under `attributes` in the schema envelope | No | Not Jarvis baggage, a possible bug found on the way. Check with a `graph_get` of a Schema, and fix inside the item 7 PR. | S |
| 9 | Node-key convention (`composeNodeKey`) | `node-writer.ts:233-290`; `sanitizeKeyValue`, 200-char collapse to a sha256 prefix, type-token prefix; pinned by `fixtures/node-key-parity.json` | Reads and writes: the `key` column is the MERGE identity for `concept-name`, `claim-id`, `check-id`, `lingo-name`, run/chat types | Yes | **Keep.** Changing it re-keys Peel's nodes, which is a migration, not a removal. Only rename the test ("parity with jarvis") and the fixture so they read as the contract they are. If Concept keys should be exact (so `C++` and `C` don't collide), that is a design decision for step 5/8, not step 9. | XS (rename) |
| 10 | `unique_source_id` | `registry.ts:123`, `strut-schemas.ts:110`, `projector.ts:69-75`, `concept-seed.ts`, `packages/*`; edge side `edge-writer.ts:128,374`, `engine.ts:190` | Node side: real, Concept seeding and package install depend on it. Edge side: Ladybug edge columns have no `unique_source_id` (`registry.ts:~253`), so the stamp appears to be dropped (unverified) | Yes | Node side **keep**. Edge side: make Neo4j-only after step 3 lands (it owns `edge-writer.ts`). | S |
| 11 | Edge `weight` stamp | `edge-writer.ts:56,408` stamps 1; Ladybug column `registry.ts:256` | Writes a constant 1; `reader.ts:95` notes the response strips it. Nothing orders by it (`importance` does) | Yes | Stop writing it on Ladybug after step 3; existing columns stay. Low value. | S, blocked |
| 12 | `composeEdgeKey` pattern | `edge-writer.ts:148,371` | Dead on Ladybug: `ensureEdgeSchema` keeps only `ref_id` and the rule (`ladybug/ontology.ts:423-436`), so a Ladybug edge schema never has an `edge_key` pattern | Yes | Keep as is. Already inert; do not touch. | none |
| 13 | `complex` in the type grammar | `TYPE_GRAMMAR` in `schema-crud.ts:143` and `schema-resolver.ts:65`; `node-writer.ts:197`; `registry.ts:~217` returns null for it | A Ladybug type can declare `complex`, then fails later at column creation | Yes (grammar) | Refuse `complex` up front when the engine is Ladybug. Tiny, optional. | XS |
| 14 | Neo4j-only helpers sitting in shared files | `DEFAULT_NAMESPACE = "default"` and `BLOCKED_NODE_STATUSES` (`search.ts:47,50`), `NODE_LIVE`/`EDGE_LIVE` with `is_deleted`/`is_muted` (`deletion.ts:19-29`), `EDGE_TYPES_ALLOWLIST` (`schema-resolver.ts:53`), `JARVIS_SOURCED_EDGES` (`strut-schemas.ts:632`), the `Neo4jReader` class in `search.ts` | Ladybug never reads them | Yes | Already isolated by behaviour, only misplaced. Move into a Neo4j module only if a later PR touches the same lines; do not make a PR for the move alone. `search.ts` is 1233 lines and step 3 is editing it. | M, defer |
| 15 | Parity inputs on the `graph/*` steps | `allow_scratchpad` (`create-triplet.ts:81`, `create-batch-triplet.ts:63`), unsupported inputs on `edit-node.ts:32,36` | Accepted and ignored | The lab's workflows may pass them | Keep until the Neo4j workflows are audited: removing an input breaks a saved workflow. Hide them from Ladybug tool descriptions if wanted. | S, risky |
| 16 | Name and comment residue | `jarvisType()` helper `registry.ts:47`; "jarvis" comments in `ladybug/ontology.ts:110,116,424`, `reader.ts:140,274,403`, `apps/graph-types.ts:20-45`; `_shared.ts` header; `ai/prompts.ts:527` (Neo4j layout text, correct for Neo4j) | None; names only | No | Rename `jarvisType` → `seedType`, trim comments. Do it while editing the same files, not as its own PR. | XS |
| 17 | Legacy-name migration in `db.ts:140-240` | `Data_Bank`/`node_key`/`date_added_to_graph` → `search_text`/`key`/`created_at` | Runs once per old file | No | **Keep for now.** It is what lets an older Peel file open. Retire only when no file written before the rename is left, which this audit cannot see. | n/a |

Not Jarvis, so left alone: `src/steps/lib/memory/_ontology-seed.ts` (Peel's own memory seed), `plans/jarvis-graph-compat.md` (the Neo4j design, still true), the roughly 20 test files that seed the Jarvis ontology on Neo4j (they test Neo4j and stay).

## Proposed PRs, in order

Each is independent and leaves Neo4j's behaviour as on main. None needs a migration.

1. **Load the Jarvis ontology only on Neo4j** (item 1). Lazy-import the three boot steps and move `searchableAttributesOf`. Biggest win for the least risk: Ladybug and Peel stop loading 151 KB of Jarvis data at start. Check `index.ts` still exports both names. Effort S, about half a day.
2. **Split the Jarvis names out of the shared lists** (items 2, 3, 4, 13). `_search_fields_used` only on Neo4j; response-stripping and reserved-name sets split into core and Neo4j-only; refuse `complex` on Ladybug. All in `node-writer.ts`, `search.ts`, `strut-schemas.ts`, `ladybug/engine.ts`. Tests: the existing serialisation tests on both engines. Effort S. Touches `search.ts` and `node-writer.ts`, which steps 3 and 6 are changing, so land it after those rebase or expect a conflict.
3. **Trim the Schema columns Ladybug doesn't use** (items 6, 7, 8). Drop the four display columns from new files and the seed; make `SCHEMA_CORE_PROPERTIES` engine-aware; fix the five missing core names. First write the failing test for the `action`/`source_link` misread. Effort S. Changes the seed hash, so an existing file re-seeds its Schema rows once at open: confirm that on a copy of a Peel file, not the real one.
4. **After step 3 lands: edge-side leftovers** (items 10-edge, 11). `unique_source_id` and `weight` on Ladybug edges. Effort S. Blocked on step 3.
5. **Optional: search text on Ladybug** (item 5). Only if step 3's search rows make the kitchen-sink text visibly wrong for Peel. It re-embeds nodes, so it needs its own decision.

Fold items 9 (rename the parity test) and 16 (comments, `jarvisType`) into whichever PR touches the same file. Items 12, 14, 15 and 17 are no-ops for now.

## Where the other sessions will collide

- Step 3 (`assert`, temporal edges, search rows): `edge-writer.ts`, `search.ts`, `ladybug/engine.ts`. Affects PRs 2 and 4.
- Step 5 (identity): `registry.ts` Person type and `identifiers`. Little overlap; PR 3 touches `registry.ts` columns only.
- Step 6 (privacy): `node-writer.ts`, `search.ts`, `namespaces.ts`. Affects PR 2.
- Step 8 (Concepts and Claims reads): `registry.ts`, `ladybug/reader.ts`. PR 3 and 16's renames may conflict on `registry.ts`.

Suggested order given that: PR 1 first (touches `backend.ts`, `schema-crud.ts`, `ontology-seed.ts`, none of which the others own), then PR 3 and PR 2 after steps 3 and 6 merge, then PR 4.

## Not verified

- Items 7, 8 and 10-edge are read from the code, not exercised. Each PR starts with a test that shows the problem.
- "No reader of the display columns" covers strut and Peel source only. If Hive or another app reads Ladybug Schema rows for icons, item 6 changes.
- Whether `created_by` and `deleted_at` should be stripped from responses (they are not in `RESPONSE_STRIPPED_NODE_PROPERTIES`) looks like an oversight from the core-attributes rename; check when doing PR 2.
