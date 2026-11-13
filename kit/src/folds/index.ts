/** The FOLDS (plans/apps.md §3): pure functions from what strut serves — a
 *  run's event log, an agent's transcript, a step's accessed nodes, an
 *  artifact path, the graph a run walked, a run's agents as a cascade, the
 *  work products a run declares, a graph walk hop by hop, two states of the
 *  Concept tree's pages, a flat form's schema (a question's, a task's
 *  answer) — to what a view draws. One copy: strut's own UI
 *  (`web/`) imports them as `@strut/kit/folds`, `strut/views` and any app
 *  from `@strut/kit`. No React, no DOM, nothing from the server. */
export * from "./run-overview.js";
export * from "./run-health.js";
export * from "./transcript.js";
export * from "./accessed-nodes.js";
export * from "./artifact-view.js";
export * from "./document.js";
export * from "./agent-trace.js";
export * from "./run-graph/index.js";
export * from "./work-products.js";
export * from "./replay.js";
export * from "./walk/index.js";
export * from "./concept-diff.js";
export * from "./earnings.js";
export * from "./answer-form.js";
export * from "./answer-schema.js";
