/**
 * The Schema `index` reconcile (plans/semantic-search.md §2) — strut brings
 * a live `:Schema`'s `index` list up to the bundled jarvis library's by
 * writing it directly, once per bundled snapshot.
 *
 * Why: a node's search text is composed from its Schema's `index` (strut's
 * writer, the pass, jarvis's own writer — one rule), and schema seeding is
 * add-only on both sides — jarvis's `_synchronize_schemas` never changes an
 * existing `index` — so a graph seeded before jarvis widened a type's list
 * (`Function`: `"name"` → `[name, summary, description]`, jarvis `e6b14dbc`)
 * still embeds the name alone. The library is jarvis's own, so these are the
 * values jarvis would set — but never through its Schema API, which
 * re-embeds the whole type inside one request and rebuilds the shared
 * keyword index once per type.
 *
 * Rule: a live `index` that is non-empty and a STRICT SUBSET of the
 * library's for that type gets the library's list. Left alone: a type the
 * library does not know, a live list holding a field the library lacks, and
 * an absent `index` (the catch-all text — a different meaning). Written
 * directly, the new list triggers nothing in jarvis (verified against its
 * boot path): its next node write composes with the new list, as the pass
 * does.
 *
 * Stamped per fixture version in the `Migration` ledger
 * (`strut_index_reconcile_<version>`): idempotent, and never a fight with a
 * jarvis that narrows a list on purpose — a graph is widened once per
 * library snapshot and left alone until the next. The pass
 * (`embeddings.ts`) then sees every node of a widened type as stale; no
 * vector migration of its own.
 */
import { Bolt } from "./bolt.js";
import { JARVIS_ONTOLOGY, type OntologyFixture } from "./fixtures/jarvis-ontology.js";
import { schemaStatement } from "./schema-seed.js";

export interface IndexReconcileReport {
  /** `already_done` = the ledger row for this fixture version is present,
   *  nothing read; `nothing_to_do` = every live list is current (or wider,
   *  or absent), ledger stamped. */
  status: "reconciled" | "already_done" | "nothing_to_do";
  /** Per type, the live list and what replaced it. */
  widened: Record<string, { from: string[]; to: string[] }>;
}

export function reconcileMigrationId(version: string): string {
  return `strut_index_reconcile_${version}`;
}

/** jarvis `get_index_fields`: a string is a one-item list. */
export function normalizeIndex(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

/** The library's list when `live` is a non-empty strict subset of it;
 *  null otherwise. Pure. */
export function widenedIndex(live: unknown, library: unknown): string[] | null {
  const a = normalizeIndex(live);
  const b = normalizeIndex(library);
  if (a.length === 0 || b.length === 0) return null;
  const inLibrary = new Set(b);
  if (!a.every((f) => inLibrary.has(f))) return null;
  if (new Set(a).size >= b.length) return null;
  return b;
}

export async function reconcileIndexLists(bolt: Bolt, fixture: OntologyFixture = JARVIS_ONTOLOGY): Promise<IndexReconcileReport> {
  const report: IndexReconcileReport = { status: "nothing_to_do", widened: {} };
  const id = reconcileMigrationId(fixture.version);
  const ledger = await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id });
  if (Number(ledger[0]?.["c"] ?? 0) > 0) {
    report.status = "already_done";
    return report;
  }

  for (const schema of fixture.schemas) {
    const type = String(schema["type"]);
    if (type === "*" || normalizeIndex(schema["index"]).length === 0) continue;
    // Case-insensitive like the seeders; every live node of the type (a
    // long-lived graph can hold duplicates), soft-deleted ones left alone.
    const live = await bolt.run(
      `MATCH (n:Schema) WHERE toLower(n.type) = toLower($t) AND (n.is_deleted IS NULL OR n.is_deleted = false)
       RETURN elementId(n) AS eid, n.index AS index`,
      { t: type },
    );
    for (const r of live) {
      const to = widenedIndex(r["index"], schema["index"]);
      if (!to) continue;
      await bolt.run(`MATCH (n:Schema) WHERE elementId(n) = $eid SET n.index = $to`, { eid: r["eid"], to });
      report.widened[type] = { from: normalizeIndex(r["index"]), to };
    }
  }
  if (Object.keys(report.widened).length > 0) report.status = "reconciled";

  await schemaStatement(bolt, `CREATE CONSTRAINT migration_id_unique IF NOT EXISTS FOR (m:Migration) REQUIRE m.migration_id IS UNIQUE`);
  await bolt.run(`MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = timestamp()`, { id });
  return report;
}
