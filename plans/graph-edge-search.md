# Graph edge search: finding facts by meaning

Step 3b of `plans/graph-memory-plan.md`. Ladybug only.

## What this is

A fact is a triplet: a source node, an edge and a target node. "Tom works at Stakwork" is `Tom -[WORKS_AT]-> Stakwork`. Step 3 stores the fact's sentence on the edge as `text` and finds facts by word match over that text, as `memory/recall` does today.

This step lets a fact be found by meaning. "Where's my job?" should find "Tom works at Stakwork" even though they share no words. To do that we embed the triplet, meaning its sentence, and search the embeddings.

## Why a search row

Ladybug can't build a keyword or vector index on an edge table, only on the node table. So each fact also gets a hidden row in the node table, holding its sentence and its embedding. Search goes through the indexes that already exist, finds the row, and returns the edge it stands for.

The main plan's "Search rows: prototype result" has the numbers. At 10k and 50k edges, keyword search found the right row 20 times out of 20. Vector recall at 10 was 90–100%. A search took 3–22 ms, and a write cost about 6–10 ms more.

## What gets embedded

The embedding input is the triplet, not only the stored `text`:

```
<source title> <edge type as words> <target title>. <text>
```

For example: `Tom works at Stakwork. Tom works at Stakwork as an engineer.`

- **Names come first.** A sentence written as "He works there" still embeds with both names, so a search for "Tom" or "Stakwork" finds it.
- **The edge type** becomes words: `WORKS_AT` → "works at".
- **The titles** are the nodes' core `title`, which the writer fills (step 2a).
- **The keyword index** reads the same composed text, so a word match on a name finds the fact too.

## The row

- **Type:** a reserved node type, `EdgeText`, with its own Schema row.
  - Role `record`.
  - Embed on.
  - **No `Strut` domain.** These rows are memory, and the memory tools leave `Strut` out (main plan, step 4).
- **Key:** the edge's `ref_id`, with key `edgetext-<edge ref_id>`, so each edge has exactly one row.
- **Fields:**
  - `edge_type`, `source_ref_id` and `target_ref_id`, so a hit fetches its edge without a scan;
  - `search_text`, the composed text above;
  - `title`, the sentence cut down;
  - `text_embeddings`, the vector.
- **Copied from the edge:** `namespace`, `valid_at`, `invalid_at` and `expired_at`, so a row is in the same namespace and time window as its fact.
- **Hidden as a node.** Search, get, neighbours, walk and counts leave `EdgeText` out by type, the way they leave out Schema rows. A row is only ever returned as the edge it stands for.

## Keeping rows in step with edges

Every change happens in the same transaction as the edge change, on Ladybug's single write queue.

| Edge event | Row |
|---|---|
| `assert` creates the edge | row written |
| `assert` re-confirms it | unchanged |
| superseded or ended | `invalid_at` and `expired_at` copied, row kept for history searches |
| edge deleted | row's `deleted_at` set |
| edge moved to another namespace | row moves with it |
| a source or target's `title` changes (rename, merge) | that node's rows recomposed and re-embedded |

Recomposing on a title change touches one node's edges. That's cheap at personal scale. A node with a very large number of edges could instead queue the work for the embedding pass. Decide this if it ever shows up in timing.

## Embedding

- **The model:** strut's existing local MiniLM, 384 dimensions, the same as node embeddings.
- **When it runs:** before the transaction. If it throws, the edge and its row are still written, keyword only, and the existing embedding pass fills in the vector later. Rows are ordinary nodes, so the pass already covers them.
- **Recall:** vector queries raise `efs` to 500, which the main plan's step 4 already asks for.

## Backfill

Rows are derived data: everything in them comes from the edge and its two nodes. So:

- **Older files:** a one-time pass, gated by the `Migration` table, writes a row for every temporal edge that has `text` and no row. It only adds rows, so it isn't one-way and needs no backup (`ONE_WAY_MIGRATIONS`).
- **Rebuilding:** the same pass can rebuild every row, after a change to the composed text or the model.

## Reads

This step builds the rows. Search starts returning edges in step 4 of the main plan, which uses them like this:

- **Query:** a keyword or vector query hits `EdgeText` rows, then fetches their edges and both ends.
- **Result:** an edge comes back with its sentence, its two nodes' titles and its dates.
- **Time:** only current facts by default. `include_ended` and `as_of` read the copied dates.
- **Namespaces:** the reader's namespaces apply to rows as they do to nodes.

## Neo4j

Out of scope. Jarvis has its own edge-text fields on Neo4j (`edge_text`, `edge_text_embeddings`), and strut leaves them alone, as on main.

## Pass criteria

- An `assert` writes its edge and its row together: a process killed mid-write leaves both or neither.
- A search by meaning ("where's my job?") finds "Tom works at Stakwork".
- A search for a name the sentence doesn't use ("He works there") finds the fact through the composed text.
- An ended fact is left out by default and found with `include_ended` or a matching `as_of`.
- A row is never returned as a node by search, get, neighbours, walk or counts.
- A memory-tool search that leaves out the `Strut` domain still finds facts.
- A rename of either end re-embeds its facts.
- A fact in `private` isn't found by a reader limited to `shared`.
- An embedding failure still writes the edge, and the embedding pass fills the vector later.
- The backfill gives an older file a row for every temporal edge with `text`, and running it again changes nothing.

## Order

After step 3 (temporal edges and `assert`), alongside or just before step 4 (reads), and before Peel's strut pin moves (step 7). Without it, Peel's memory can find a fact only by its words.

## Open questions

- **The edge-type phrase.** `WORKS_AT` → "works at" covers most types. Should a Schema row be able to declare its own phrase, for example `KNOWS` → "knows", or `PARENT_OF` → "is the parent of"?
- **Large nodes.** Should a title change on a node with many edges recompose in the transaction, or queue the work?
- **Ranking.** How should a fact hit rank against a node hit in mixed results? Settle this in step 4 with real data.
