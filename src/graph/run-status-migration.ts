/**
 * One-shot rename of `StrutRun.status` → `StrutRun.run_status`.
 *
 * jarvis treats a node's `status` as PROCESSING state: its reads (and the
 * reader ported from them, search.ts `visibility`) hide any node whose
 * `status` is in `BLOCKED_NODE_STATUSES` — which includes `error`. A run's
 * outcome stored there made every failed run invisible to search, get,
 * neighbors and graph/walk. The outcome now lives in `run_status`, which
 * nothing filters on. This pass moves existing graphs over:
 *
 *   1. ledger check — a stamped database is never scanned again;
 *   2. data nodes, batched: `run_status` ← `status` (unless already set),
 *      `status` removed;
 *   3. the `StrutRun` Schema node: `status` attribute removed, `run_status`
 *      added, `index` list replaced with the library's (the seed that runs
 *      next is add-only and would never drop `status`);
 *   4. the Strut domain fulltext index dropped when it covers `status` but
 *      not `run_status` — the seed recreates it from the library;
 *   5. stamp the `Migration` ledger.
 *
 * Runs at boot before `seedStrutDomain` (backend.ts). Idempotent at every
 * step, so a crash mid-way is repaired by the next boot.
 */
import { Bolt } from "./bolt.js";
import { DOMAIN_FULLTEXT_INDEX_V2 } from "./schema-seed.js";
import { getStrutSchema } from "./strut-schemas.js";

export const RUN_STATUS_MIGRATION_ID = "strut_run_status_v1";
const BATCH = 1000;

export interface RunStatusMigrationReport {
  /** `already_done` = ledger row present, nothing scanned. */
  status: "migrated" | "already_done" | "nothing_to_do";
  /** StrutRun nodes whose `status` moved to `run_status`. */
  runs: number;
  schemaUpdated: boolean;
  droppedFulltextIndex: boolean;
}

export async function migrateRunStatus(bolt: Bolt): Promise<RunStatusMigrationReport> {
  const report: RunStatusMigrationReport = { status: "nothing_to_do", runs: 0, schemaUpdated: false, droppedFulltextIndex: false };
  const ledger = await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: RUN_STATUS_MIGRATION_ID });
  if (Number(ledger[0]?.["c"] ?? 0) > 0) {
    report.status = "already_done";
    return report;
  }

  // 2. Data nodes.
  for (;;) {
    const rows = await bolt.run(
      `MATCH (r:StrutRun) WHERE r.status IS NOT NULL
       WITH r LIMIT ${BATCH}
       SET r.run_status = coalesce(r.run_status, r.status)
       REMOVE r.status
       RETURN count(r) AS c`,
    );
    const c = Number(rows[0]?.["c"] ?? 0);
    report.runs += c;
    if (c < BATCH) break;
  }

  // 3. Schema node.
  const lib = getStrutSchema("StrutRun")!;
  const schema = await bolt.run(
    `MATCH (s:Schema {type: "StrutRun"}) WHERE s.status IS NOT NULL
     SET s.run_status = $attr, s.index = $index
     REMOVE s.status
     RETURN count(s) AS c`,
    { attr: lib.attributes["run_status"], index: [...lib.index] },
  );
  report.schemaUpdated = Number(schema[0]?.["c"] ?? 0) > 0;

  // 4. Fulltext index built before the rename.
  const idx = await bolt.run(`SHOW INDEXES YIELD name, properties WHERE name = $name RETURN properties`, { name: DOMAIN_FULLTEXT_INDEX_V2 });
  const props = (idx[0]?.["properties"] as string[] | undefined) ?? [];
  if (props.includes("status") && !props.includes("run_status")) {
    await bolt.run(`DROP INDEX \`${DOMAIN_FULLTEXT_INDEX_V2}\` IF EXISTS`);
    report.droppedFulltextIndex = true;
  }

  if (report.runs > 0 || report.schemaUpdated || report.droppedFulltextIndex) report.status = "migrated";
  // 5. Ledger (constraint created by the seed; MERGE is safe without it).
  await bolt.run(`MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = timestamp()`, { id: RUN_STATUS_MIGRATION_ID });
  return report;
}
