/**
 * One-shot re-key of strut's WORKSPACE nodes — `StrutWorkflow`,
 * `StrutWorkflowVersion`, `StrutStep`, `StrutStepVersion` — from jarvis's
 * sanitized name to the hex of the exact name (`exact_key` in
 * strut-schemas.ts; `keyToken` in node-writer.ts).
 *
 * `sanitizeKeyValue` strips every non-alphanumeric character, so
 * `pod/test`, `pod-test`, `pod_test` and `podtest` all composed to
 * `strutstep-podtest`, and the second name published landed on the first
 * name's node — the writer MERGEs on `(node_key, namespace)` (swarm38,
 * 2026-10-07: the lab seeder's `pod/test` was swallowed by a custom step
 * `pod_test`; stakwork/stakgraph#1744 renamed it). The keys are injective
 * now; this pass moves what an older strut wrote:
 *
 *   1. ledger check — a stamped database is never scanned again;
 *   2. per type: read every node's identity attributes (never `source`),
 *      compose the key the current code writes, SET it where it differs —
 *      every namespace, soft-deleted nodes included (a later publish of a
 *      deleted name must restore ITS node, which the writer finds by key);
 *   3. stamp the `Migration` ledger.
 *
 * Nothing else moves: `ref_id`s, edges, properties, embeddings, the Schema
 * nodes (the `node_key` SPEC is unchanged — only the token encoding is)
 * and the constraints (`(node_key, namespace)` stays the identity). No two
 * rewritten nodes can collide: distinct old keys mean distinct names, which
 * mean distinct new keys. A node that already HOLDS the key another would
 * move to (a name that is literally the hex of another name; a graph that
 * carries both a renamed Vein node and a current node for one name) is
 * refused before anything is written — that graph needs a human, not a
 * merge policy. Idempotent — a node already on its exact key is skipped —
 * so a crash mid-way is repaired by the next boot. Runs before
 * `seedStrutDomain` (backend.ts) and after the Vein rename, whose `Strut*`
 * labels it matches on.
 */
import { Bolt } from "./bolt.js";
import { composeNodeKey } from "./node-writer.js";
import { schemaStatement } from "./schema-seed.js";
import { STRUT_SCHEMAS, nodeKeyFields } from "./strut-schemas.js";

export const EXACT_KEY_MIGRATION_ID = "strut_exact_keys_v1";
const BATCH = 1000;

export interface ExactKeyMigrationReport {
  /** `already_done` = ledger row present, nothing scanned; `nothing_to_do`
   *  = scanned, every node already on its exact key, ledger stamped. */
  status: "migrated" | "already_done" | "nothing_to_do";
  /** Nodes re-keyed, per type. */
  rekeyed: Record<string, number>;
  /** Nodes left alone because an identity attribute is missing — nothing
   *  the validator ever let through; reported, never touched. */
  skipped: number;
}

export async function migrateExactKeys(bolt: Bolt): Promise<ExactKeyMigrationReport> {
  const report: ExactKeyMigrationReport = { status: "nothing_to_do", rekeyed: {}, skipped: 0 };
  const ledger = await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: EXACT_KEY_MIGRATION_ID });
  if (Number(ledger[0]?.["c"] ?? 0) > 0) {
    report.status = "already_done";
    return report;
  }

  // 2a. What moves where — read-only, every type, before anything is written.
  const plan: Array<{ type: string; moves: Array<{ ref_id: string; key: string }> }> = [];
  const collisions: string[] = [];
  for (const schema of STRUT_SCHEMAS) {
    if (!schema.exact_key) continue;
    const fields = nodeKeyFields(schema);
    const rows = await bolt.run(
      `MATCH (n:\`${schema.type}\`)
       RETURN n.ref_id AS ref_id, n.node_key AS node_key, n.namespace AS ns, ${fields.map((f) => `n.\`${f}\` AS \`${f}\``).join(", ")}`,
    );
    const held = new Map(rows.map((r) => [`${r["ns"]}|${r["node_key"]}`, r["ref_id"] as string]));
    const moves: Array<{ ref_id: string; key: string }> = [];
    for (const r of rows) {
      const values: Record<string, unknown> = {};
      for (const f of fields) if (r[f] !== null && r[f] !== undefined) values[f] = r[f];
      if (Object.keys(values).length < fields.length) {
        report.skipped++;
        continue;
      }
      const key = composeNodeKey(schema, values);
      if (key === r["node_key"]) continue;
      const holder = held.get(`${r["ns"]}|${key}`);
      if (holder && holder !== r["ref_id"]) collisions.push(`${schema.type} ${r["node_key"]} → ${key} (held by ${holder})`);
      moves.push({ ref_id: r["ref_id"] as string, key });
    }
    plan.push({ type: schema.type, moves });
  }
  if (collisions.length > 0) {
    throw new Error(
      `migrateExactKeys: ${collisions.length} node(s) already hold the exact key another node would move to — ` +
        `resolve by hand before booting: ${collisions.slice(0, 5).join("; ")}`,
    );
  }

  // 2b. The moves, batched.
  for (const { type, moves } of plan) {
    for (let i = 0; i < moves.length; i += BATCH) {
      await bolt.run(`UNWIND $rows AS row MATCH (n:\`${type}\` {ref_id: row.ref_id}) SET n.node_key = row.key`, {
        rows: moves.slice(i, i + BATCH),
      });
    }
    if (moves.length > 0) report.rekeyed[type] = moves.length;
  }
  if (Object.keys(report.rekeyed).length > 0) report.status = "migrated";

  await schemaStatement(
    bolt,
    `CREATE CONSTRAINT migration_id_unique IF NOT EXISTS
     FOR (m:Migration) REQUIRE m.migration_id IS UNIQUE`,
  );
  await bolt.run(`MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = timestamp()`, {
    id: EXACT_KEY_MIGRATION_ID,
  });
  return report;
}
