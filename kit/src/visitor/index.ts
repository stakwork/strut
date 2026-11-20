/** `@strut/kit/visitor`: the visitor contract (plans/app-repos.md §5) — the
 *  `strut/visitor/*` bridge methods and the capability a host offers — and
 *  the app's client (`createBridgeVisitor`). No React, no DOM, no
 *  dependency, so a host's page imports it alone. */
export * from "./protocol.js";
export * from "./client.js";
