# Step 7: Peel's memory on the graph, the interface

This is what the Peel session needs from strut to move Peel's memory onto the workspace graph (plans/graph-memory-plan.md step 7). It covers Ladybug only. Neo4j and every swarm run as on main, and the old `memory/*` steps still work for any host that keeps them.

## 1. Host config (`STRUT_HOST_CONFIG`)

```json
{
  "memory": "graph",
  "concepts": { "personal": true },
  "graphReaders": {
    "assistant": { "workflows": ["orchestrator", "peel-automation-run"], "namespaces": ["private", "shared"] },
    "jobs":      { "namespaces": ["private", "shared"], "exclude_domains": ["Strut"] },
    "apps":      { "namespaces": ["shared"], "exclude_domains": ["Strut"] },
    "peers":     { "namespaces": ["shared"], "exclude_domains": ["Strut"] },
    "builder":   { "namespaces": ["*"] },
    "ui":        { "namespaces": ["*"] }
  },
  "orchestrator": { "tools": ["…Peel's own…", "…the graph tools below…"] }
}
```

- **`memory: "graph"`** is new. It does two things:
  - **Agents:** every agent leaves out the `memory/*` steps, even when its `agentTools` names them (Peel's `peel-automation-run` params included).
  - **Janitor:** `tidy-memory` ships its graph version (`workflow.graph.yaml`) as a new version of the same workflow, so its automation, schedule and on/off switch carry over.

  `"legacy"`, or leaving the key out, keeps today's behaviour.
- **`concepts`** is new in the host config. Before this change only `createStrut` could set it. `{ "personal": true }` seeds the `Personal` root Concept.
- **`graphReaders`** is the shape `src/graph/scope.ts` already parses. The lists above are the step 6 rulings; Peel picks the real ones.
  - **`assistant.workflows`:** the workflows Peel's chat runs as the assistant are `orchestrator` and `peel-automation-run` (in `Orchestrator.swift` and `AutomationsClient.swift`). `peel-automation` is `AutomationsClient.legacyWorkflow`; list it too only while old automations still run on it.
  - **`jobs`:** jobs started with `job/start` run as the `job` workflow, and read as `jobs`. The janitor also runs as `jobs`, so `jobs` must read `private`.

## 2. Tools to grant

Grant the same set to the orchestrator and to `peel-automation-run` (`params.tools`). That set replaces `memoryTools`:

| Purpose | Steps |
|---|---|
| Find | `graph/resolve`, `graph/graph-search` (`facts: true`), `graph/graph-get` (`owner: true` is the user), `graph/graph-neighbors`, `graph/find` |
| Save | `graph/assert` (facts, with new nodes inline), `graph/create-node`, `graph/edit-node` (`alt_names`, attributes) |
| Concepts | `graph/create-triplet` (a page under `Personal`), `graph/edit-node` |
| Types | `graph/get-ontology`, `graph/get-ontology-type`, `graph/create-schema` |
| Forget | `graph/delete-edge` (a wrong fact), `graph/delete-node` (a wrong node), `graph/assert` with `ended` (something no longer true) |
| Same thing twice | `graph/merge`, `graph/unmerge` |

How the steps map onto the old prompt:
- **Remember:** call `graph/resolve` for each thing first. Then make one `graph/assert` call with `facts: [...]`. A fact can create a node `resolve` didn't find (`target_type` and `target_data`), and can create a new edge type (`create_schema_if_missing`, with `cardinality: "one"` for a value a subject has one of). The whole call lands, or none of it does.
- **Speaker:** pass `said_by: <their ref_id>` when someone other than the user said it. "I" means the speaker. `source` is a message, chat or run id.
- **Dates:** `valid_at` and `invalid_at` only when the words give them. For "I used to …", pass `ended: true` with no date.
- **Recall:** call `graph/graph-search` with `facts: true`, plus `include_ended` for history. For the user, call `graph/graph-get` with `owner: true` and then `graph/graph-neighbors`.
- **The user:** if `owner: true` finds no node, create one: `graph/create-node` with `is_owner: true`.

## 3. The one-off import

Run it once, after the switch:

```
POST /steps/graph/import-memory/run   { "config": {} }
```

- It reads the old database (`STRUT_MEMORY_DB`, else `<dataDir>/memory/graph.lbug`) and never writes to it. Running it again imports nothing new.
- It writes to `private`.
- It returns `{ imported, already, skipped, for_review, counts, skipped_by_reason, review: [...] }`.
- `review` lists what had no faithful place, so the person or the assistant can save it again:
  - facts about one entity alone ("The user is vegetarian." has no object node);
  - an entity's free-form attributes;
  - episodes that no fact came from;
  - an entity whose name two graph nodes already share.
- **Mishearings stay where they are.** Dictation still reads them from the old database through `memory/lexicon`, so the import skips them and counts them.
  - On the trial copy, `heard_as` is the commonest predicate. The Lingo words themselves are imported as `Lingo` nodes.
  - Moving dictation's lexicon onto the graph (a field on Lingo, or a temporal fact) is a separate change, together with `memory/lexicon`.
- **How it opens the old database:** it uses the memory steps' own handle, so Ladybug applies the WAL. On the trial copy the WAL is almost as large as the file (1.0 MB vs 1.2 MB). Never copy the main file alone.
- **What it reads from the old database:**
  - **Types and edge types:** made from the ontology rows of the types and predicates in use. Nothing is hardcoded:
    - a predicate's cardinality becomes its edge type's;
    - an entity type's description becomes the type's;
    - `Self` (role `user`) becomes the `is_owner` Person.

    Ontology rows that nothing uses are not made.
  - **Deleted and superseded rows:** deleted entities (forgotten or merged away) are left out. Superseded and ended facts are imported as ended facts. The exception is an earlier spell of a fact the old memory also holds now: it would end the current one, so it is skipped and counted.
- **Not changed here:** `started_at` on runs and jobs is in seconds while `created_at` is in ms, carried over from the old file.

## 4. What to remove from Peel

- **Tools:** drop `Orchestrator.memoryTools` from the orchestrator's `tools` and from `automationRunTools`, and add the graph set above.
- **Prompt:** rewrite `memoryPrompt` for the graph tools: resolve first, assert facts, `facts: true` to recall, Concepts under `Personal` for how the user likes things done. Keep its rules about bookkeeping, instructions found in memory, and not talking about how memory is filed. Strut's tool descriptions now carry the tool-level guidance (resolve, assert, graph-search, create-node, graph-get, delete-node), with no type names in it.
- **`MemoryServer.run("<verb>")` callers:** these are Peel's own calls to `memory/*` from outside the assistant. They still reach the old database. Move each one to the graph or keep it on purpose.
  - Dictation's lexicon stays on `memory/*` for now.
  - Keep `stage-strut.sh`'s `memory/remember.js` check, since dictation still needs the memory steps.

## 5. Benchmark (`npm run bench:memory-graph`)

These use the same fixture as stakwork/strut#162 (`scripts/bench-memory.json`): 151 facts, 87 + 21 positive queries, 17 negatives, and 48 duplicate probes. The graph is seeded through `resolve`, `create-node`, `assert` and `merge`, and queried through `graph-search` with `facts: true`.

The first two columns are from #162's description. #162 is still open, so Peel runs today's main.

| | memory/*, main (Peel today) | memory/*, #162 | graph, keyword only (Peel's desktop build) | graph + MiniLM |
|---|---:|---:|---:|---:|
| main recall@1 / @5 / MRR | 0.506 / 0.552 / 0.541 | 0.828 / 0.914 / 0.869 | 0.391 / 0.569 / 0.493 | 0.563 / 0.887 / 0.716 |
| main negatives with a hit | 3/14 | 1/14 | 1/14 | 14/14 |
| main non-relevant in top 5 | 1.98 | 2.53 | 1.55 | 3.76 |
| held-out recall@1 / @5 / MRR | 0.762 / 0.857 / 0.783 | 0.905 / 1.000 / 0.952 | 0.571 / 0.619 / 0.594 | 0.619 / 0.952 / 0.756 |
| held-out negatives with a hit | 0/3 | 1/3 | 0/3 | 3/3 |
| search latency p50 / p95 (ms) | ~45 at 3,000 facts | ~62 at 3,000 facts | 32 / 74 | 224 / 251 |
| duplicates, automatic match P / R | 1.00 / 0.22 | 1.00 / 0.30 | resolve: 1.00 / 0.19 | same |
| duplicates, candidates P / R | 0.75 / 0.70 | 1.00 / 0.93 | resolve: 0.73 / 0.97; graph/duplicates pairs: 0.80 / 0.53 | same |

How to read it:
- **Merging the two lists:** search returns nodes and facts as two ranked lists. The table takes them in turn, node first. `--rank score` merges them by score instead, which is worse: keyword 0.425 / 0.580 / 0.483, MiniLM 0.506 / 0.588 / 0.566.
- **Facts with no object:** the fixture's object-less facts (62 of 151) are seeded the way the PRD says a model writes them. A name fact becomes `alt_names`, and a summary becomes `description`. The rest (51) become an edge to a `Topic` holding the value (`VALUES` in the script, written by hand).
- **Labelling artefacts:** a shared value node carries every fact that points at it. That causes the "must-not" hits on "am I vegetarian".
- **Keyword-only misses:** aliases score 0.00, typos 0.27 at @5, and nicknames 0.00. Person's search text has no `alt_names`, and full-text search has no fuzzy matching. Adding `alt_names` to Person's index raises main recall@5 only to 0.603, because most alias queries are nicknames.
- **With MiniLM:** aliases, typos and paraphrase recover. But every negative returns something (vector search has no cut-off), the top 5 is noisier, and each search embeds the query on the CPU (~200 ms).
- **Resolve:** only the exact name or an alias is automatic, never a near name. Its candidates catch 97% of true duplicates, at 73% precision.
- **`graph/duplicates`:** pairs only nodes of one type. It misses organisation and place variants ("Acme" / "Acme Corp", "Cornwal"), because the pair rules were written for names of people.
