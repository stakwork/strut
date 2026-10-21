/** The RUN GRAPH's model (plans/apps.md §3.3), ported from hive
 *  (src/lib/strut-run-graph/) with its tests: a run's log → the calls that
 *  touched the graph (project.ts, over the accessed-nodes marker), the
 *  branch tree and replay frames (replay.ts), the hops a run walked
 *  (walk.ts), lineage along PARENT_OF (lineage.ts), peer-qualified ids
 *  (peer-ref.ts), a node's prose (node-text.ts). Pure, no dependencies. The
 *  layout (layout.ts) needs d3's force simulation, so it is exported from
 *  `@strut/kit` and not from the dependency-free `@strut/kit/folds`;
 *  strut/views' `RunGraph` draws all of it. */
export * from "./types.js";
export * from "./peer-ref.js";
export * from "./lineage.js";
export * from "./project.js";
export * from "./replay.js";
export * from "./walk.js";
export * from "./node-text.js";
