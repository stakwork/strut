/**
 * The one delete model, shared with jarvis (graph-delete-model plan R1–R5):
 *
 *   - a node delete is soft: `deleted_at` (epoch ms, first delete kept) plus
 *     `is_deleted = true` until the contract step drops the flag;
 *   - a node is hidden when either is set;
 *   - an edge delete is a hard `DELETE r` — nothing mutes or flags an edge
 *     any more. `EDGE_LIVE` only skips legacy flagged edges until the purge;
 *   - a delete only removes edges whose ends are both `:Data_Bank` in the
 *     same namespace (`EDGE_IN_SCOPE`).
 *
 * Every strut filter and delete reads these, never its own copy. No
 * runtime imports: `claims.ts` must not load neo4j-driver.
 */

/** A node that is not deleted: R2, either marker (`is_deleted` until the
 *  contract step). No muted or status check. */
export const NODE_LIVE = (v: string) => `(${v}.deleted_at IS NULL AND (${v}.is_deleted IS NULL OR ${v}.is_deleted <> true))`;

/** An edge that carries no legacy flag (`is_muted`, plus the legacy `is_deleted`). */
export const EDGE_LIVE = (r: string) => `((${r}.is_muted IS NULL OR ${r}.is_muted <> true) AND (${r}.is_deleted IS NULL OR ${r}.is_deleted <> true))`;

/** R4, as jarvis's `edge_delete_scope_clause`: both ends content
 *  (`:Data_Bank`) in the caller's namespace `$ns`. */
export const EDGE_IN_SCOPE = (a: string, b: string) =>
  `(${a}:Data_Bank AND ${b}:Data_Bank AND ${a}.namespace = $ns AND ${b}.namespace = $ns)`;

/** The delete timestamp: epoch milliseconds, like `date_added_to_graph`.
 *  Pass it as `$now_ms`; `DELETE_NODE_TAIL` writes it as an Integer. */
export const nowMs = () => Date.now();

/**
 * Soft-delete the node bound to `n` and hard-delete its in-scope edges, as
 * one statement tail: expects `n` in scope and `$now_ms` / `$ns` as params,
 * and returns `ref_id` and `deleted_edge_count`.
 */
export const DELETE_NODE_TAIL = (n: string) =>
  `SET ${n}.deleted_at = coalesce(${n}.deleted_at, toInteger($now_ms)), ${n}.is_deleted = true
   WITH ${n}
   OPTIONAL MATCH (${n})-[r]-(m) WHERE ${EDGE_IN_SCOPE(n, "m")}
   DELETE r
   RETURN ${n}.ref_id AS ref_id, count(DISTINCT r) AS deleted_edge_count`;
