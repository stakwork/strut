/**
 * One-shot upgrade of a STANDALONE strut Neo4j's `Claim` schema to the shape
 * the truth layer writes (`plans/claims.md` §1) — a mirror of jarvis
 * migration `124_claim_flexible_identity`.
 *
 * `seedJarvisOntology` is add-only: a database seeded from the pre-119
 * fixture keeps `Claim` at `claim-claim_text-speaker_name` with a required
 * `speaker_name`, and strut's own `validateNode` then rejects every claim
 * (`MISSING_REQUIRED`). Re-dumping the fixture adds `Evidence`, `Check` and
 * the new pairs but never touches that existing node, so this pass does:
 *
 *   1. ledger check — a stamped database is never scanned again;
 *   2. when the live `Claim` schema is still keyed on the old node_key:
 *      DETACH DELETE every `:Claim` node, batched (old-shape claims have no
 *      `id` and cannot be re-keyed; none are expected on a strut database —
 *      nothing wrote them). Gated on the OLD key, so a re-run can never
 *      delete new-shape claims;
 *   3. SET the schema to the fixture's shape (`node_key: claim-id`,
 *      `id: string`, `speaker_name: ?string`, `paid_properties: []`,
 *      `domain: Epistemic`, `parent: Thing`, the epistemic attributes),
 *      keeping the live `ref_id` and `type`, and move `CHILD_OF` to `Thing`;
 *   4. verify the shape, then stamp the `Migration` ledger.
 *
 * Runs at boot BEFORE `seedJarvisOntology`, and only when the ontology seed
 * is on (`STRUT_GRAPH_SEED_ONTOLOGY`) — that flag is what says "no jarvis
 * here". A jarvis-hosted graph is jarvis's to migrate (124 already ran
 * there, and an older jarvis may hold real podcast claims this pass must
 * not delete). An absent `Claim` schema is left for the seed to create.
 */
import { randomUUID } from "node:crypto";
import { Bolt } from "./bolt.js";
import { JARVIS_ONTOLOGY, type OntologyFixture } from "./fixtures/jarvis-ontology.js";
import { schemaStatement } from "./schema-seed.js";

export const CLAIM_SCHEMA_UPGRADE_ID = "strut_claim_schema_upgrade_v1";
const CLAIM_TYPE = "Claim";
const NEW_NODE_KEY = "claim-id";
const BATCH = 1000;

export interface ClaimSchemaUpgradeReport {
  /** `already_done` = ledger row present, nothing read; `nothing_to_do` =
   *  no Claim schema, or already the new shape; `skipped_duplicates` = more
   *  than one Claim schema node — left for a human, NOT stamped. */
  status: "upgraded" | "already_done" | "nothing_to_do" | "skipped_duplicates";
  /** Old-shape `:Claim` nodes removed. */
  deletedClaims: number;
  /** The node_key spec found on the live schema, when it was read. */
  previousNodeKey?: string;
}

/** The fixture's `Claim` schema minus its identity (`ref_id`, `type`). */
function claimShape(fixture: OntologyFixture): Record<string, unknown> {
  const claim = fixture.schemas.find((s) => s["type"] === CLAIM_TYPE);
  if (!claim) throw new Error("upgradeClaimSchema: the ontology fixture has no Claim schema");
  if (claim["node_key"] !== NEW_NODE_KEY) {
    throw new Error(`upgradeClaimSchema: the fixture's Claim is keyed on ${String(claim["node_key"])}, expected ${NEW_NODE_KEY} — re-dump it from a post-124 jarvis`);
  }
  const { ref_id: _ref, type: _type, ...shape } = claim;
  return shape;
}

export async function upgradeClaimSchema(bolt: Bolt, fixture: OntologyFixture = JARVIS_ONTOLOGY): Promise<ClaimSchemaUpgradeReport> {
  const report: ClaimSchemaUpgradeReport = { status: "nothing_to_do", deletedClaims: 0 };
  const ledger = await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: CLAIM_SCHEMA_UPGRADE_ID });
  if (Number(ledger[0]?.["c"] ?? 0) > 0) {
    report.status = "already_done";
    return report;
  }

  const shape = claimShape(fixture);
  const live = await bolt.run(
    `MATCH (s:Schema) WHERE toLower(s.type) = toLower($t)
     RETURN s.ref_id AS ref_id, s.node_key AS node_key, s.id AS id_attr, s.speaker_name AS speaker_name,
            s.paid_properties AS paid_properties, s.domain AS domain, s.parent AS parent`,
    { t: CLAIM_TYPE },
  );
  // Two Schema nodes for one type would make the SET below fan out.
  if (live.length > 1) {
    report.status = "skipped_duplicates";
    return report;
  }

  if (live.length === 1) {
    const s = live[0]!;
    report.previousNodeKey = typeof s["node_key"] === "string" ? (s["node_key"] as string) : undefined;
    const needsRekey = s["node_key"] !== NEW_NODE_KEY;
    const needsShape =
      needsRekey ||
      s["id_attr"] !== "string" ||
      s["speaker_name"] !== "?string" ||
      s["domain"] !== shape["domain"] ||
      s["parent"] !== shape["parent"] ||
      !(Array.isArray(s["paid_properties"]) && (s["paid_properties"] as unknown[]).length === 0);

    if (needsRekey) {
      for (;;) {
        const rows = await bolt.run(`MATCH (n:\`${CLAIM_TYPE}\`) WITH n LIMIT ${BATCH} DETACH DELETE n RETURN count(*) AS c`);
        const c = Number(rows[0]?.["c"] ?? 0);
        report.deletedClaims += c;
        if (c < BATCH) break;
      }
    }

    if (needsShape) {
      const parent = String(shape["parent"]);
      await bolt.write(async (tx) => {
        await tx.run(`MATCH (s:Schema {ref_id: $ref_id}) SET s += $shape`, { ref_id: s["ref_id"], shape });
        await tx.run(`MATCH (s:Schema {ref_id: $ref_id})-[r:CHILD_OF]->(p:Schema) WHERE p.type <> $parent DELETE r`, { ref_id: s["ref_id"], parent });
        await tx.run(
          `MATCH (s:Schema {ref_id: $ref_id}), (p:Schema {type: $parent})
           MERGE (s)-[r:CHILD_OF]->(p) ON CREATE SET r.ref_id = $edge_ref`,
          { ref_id: s["ref_id"], parent, edge_ref: randomUUID() },
        );
      });
      const check = await bolt.run(
        `MATCH (s:Schema {ref_id: $ref_id})
         RETURN s.node_key AS node_key, s.id AS id_attr, s.speaker_name AS speaker_name, s.domain AS domain,
                [(s)-[:CHILD_OF]->(p:Schema) | p.type] AS child_of`,
        { ref_id: s["ref_id"] },
      );
      const got = check[0];
      const ok =
        got &&
        got["node_key"] === NEW_NODE_KEY &&
        got["id_attr"] === "string" &&
        got["speaker_name"] === "?string" &&
        got["domain"] === shape["domain"] &&
        JSON.stringify(got["child_of"]) === JSON.stringify([parent]);
      // Not stamped: the next boot retries.
      if (!ok) throw new Error(`upgradeClaimSchema: Claim schema did not reach the expected shape: ${JSON.stringify(got)}`);
      report.status = "upgraded";
    }
  }

  await schemaStatement(
    bolt,
    `CREATE CONSTRAINT migration_id_unique IF NOT EXISTS
     FOR (m:Migration) REQUIRE m.migration_id IS UNIQUE`,
  );
  await bolt.run(`MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = timestamp()`, {
    id: CLAIM_SCHEMA_UPGRADE_ID,
  });
  return report;
}
