# Graph memory: time and delete

How Peel's graph memory (a LadybugDB file) treats time and deletion. Worked out from first principles for this graph, not copied from Jarvis. Neo4j (swarms, Hive) is unchanged by all of it.

Builds on [graph-memory-plan.md](graph-memory-plan.md) (temporal edges, `assert`) and [graph-edge-search.md](graph-edge-search.md) (facts' search rows).

## The model

**Things don't expire, facts do.** A node (Kate, Lisbon, Acme) is a thing. It never ends because time passes or because nothing mentions it. A fact is a temporal edge ("Kate lives in Lisbon") with two clocks: when it was true in the world (`valid_at`, `invalid_at`) and when the graph held it (`created_at`, `expired_at`).

**"Over" means ending a fact.** When something stops being true, the fact is ended with `graph/assert` (`ended`, or `invalid_at`), or replaced by a new value on a one-value slot (supersede). The ended fact stays as history and shows with `include_ended` or `as_of`. Nothing is deleted to record that something is over.

**Time alone never ends a fact.** No sweep job, no TTL. A fact stays current until something says otherwise: a new value, an explicit end, or an `invalid_at` that has passed.

**Delete hides, never erases.** A delete is for a mistake: the wrong person, a fact that was never true. It is a `deleted_at` stamp, never a row removed:

- **A node's delete** (`graph/delete-node`) stamps the node. Its edges and their search rows stay, hidden because an end is deleted. `graph/restore-node`, or a later create of the same identity, brings the node back with every edge and fact it had. A node a merge deleted is restored by `graph/unmerge`, not `graph/restore-node`.
- **An edge's delete** (`graph/delete-edge`) stamps the edge and its search row. A deleted edge is never the current value: it holds no slot, so a new value can be asserted without superseding it. Writing the same plain edge again brings it back.
- **Every read** skips deleted nodes, deleted edges and edges with a deleted end: search (nodes and facts), get, neighbors, walk, edge counts, the word-match fact scan, cardinality checks and merge.
- **`include_deleted`** (default false) on `graph/graph-search`, `graph/graph-get`, `graph/graph-neighbors` and `graph/walk` shows them, each marked `deleted_at`. A fact hidden by a deleted end is marked too, and the end carries its own `deleted_at`.

A hard delete (erasing rows, for privacy or a user's request to forget) is a later option, separate from this.

## Next: volatility, decay and confidence

A second PR, after research. How much a fact should be trusted now depends on how long ago it was last confirmed, who said it, and how quickly that kind of fact changes (where someone lives changes more often than who their parents are). All three are **computed on read** from what is stored (`last_confirmed_at`, the sayers among a fact's `sources`, the edge type's rule), never stored and never written back by a sweep job. Time lowers confidence; it never ends a fact.

Open questions for the research:

- Volatility per edge type: a rule on the edge schema, or learned from how often its slots supersede.
- The decay curve, and how who said a fact (the user, the subject, someone else) weighs in.
- How confidence ranks facts in search and what the agent is told ("Kate lived in Lisbon, last confirmed two years ago").
