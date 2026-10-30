/** The FOLDS (plans/apps.md §3): pure functions from what strut serves — a
 *  run's event log, an agent's transcript, a step's accessed nodes, an
 *  artifact path, the graph a run walked — to what a view draws. One copy: strut's own UI (`web/`)
 *  imports them as `@strut/kit/folds`, `strut/views` and any app from
 *  `@strut/kit`. No React, no DOM, nothing from the server. */
export * from "./run-overview.js";
export * from "./run-health.js";
export * from "./transcript.js";
export * from "./accessed-nodes.js";
export * from "./artifact-view.js";
export * from "./document.js";
export * from "./run-graph/index.js";
