// Memory's move into the workspace graph (plans/memory-in-workspace-graph.md,
// PR C), once, at boot: from its own Ladybug file, `<dataDir>/memory/graph.lbug`
// or STRUT_MEMORY_DB, when that file is there and not yet marked migrated.
//
//   1. back the old file up (a copy, under the memory folder's backups/);
//   2. copy every entity, fact and episode, the edges between them and its
//      vocabulary (the proposed terms too) into the workspace graph, keeping
//      ref_ids and stamps, in ONE transaction;
//   3. stamp the workspace's Migration ledger, and rename the old file to
//      `graph.lbug.migrated`, leaving it in place.
//
// Idempotent: a node already in the workspace (by ref_id) is left as it is,
// so running again (after a crash between 2 and 3, or once memory steps
// have written meanwhile) adds only what is missing. A failure leaves the
// workspace without the old file's nodes and the old file untouched: it is
// opened read-only, and renamed only once the copy has committed.
// Leading underscore: skipped by registry discovery.
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { bootEnv } from "../../../env.js";
import type { LadybugBackend } from "../../../graph/backend.js";
import { loadLadybug } from "../../../graph/ladybug/db.js";
import { ladybugMaxDbSize } from "../../../graph/ladybug/max-size.js";
import { type Row, exclusiveOn, memoryOn, ownerOnly } from "./_db.js";
import { EPISODE, FACT, MEMORY_EDGES } from "./_ontology-seed.js";
import type { Term } from "./_ontology.js";
import { type Dump, type DumpNode, applyDump, dump, pick } from "./_snapshot.js";

export type MemoryMigration =
  | { status: "none" }
  | { status: "migrated"; from: string; to: string; backup: string; nodes: number; edges: number; skipped: number; lock_ms: number }
  | { status: "renamed"; from: string; to: string };

/** The old memory file: STRUT_MEMORY_DB, else `<dataDir>/memory/graph.lbug`. */
export function oldMemoryPath(dataDir: string, env: Record<string, string | undefined> = bootEnv()): string {
  return resolve(env["STRUT_MEMORY_DB"] || join(dataDir, "memory", "graph.lbug"));
}

const SIDE = [".wal", ".lock", ".shadow"];

/** Moves the old file (and what Ladybug keeps beside it) out of the way, in place. */
function renameOld(path: string): string {
  const to = `${path}.migrated`;
  renameSync(path, to);
  for (const s of SIDE) if (existsSync(path + s)) renameSync(path + s, to + s);
  return to;
}

/** Runs the migration when there is an old file to move. Throws on a failure (the caller logs it and boots on). */
export async function migrateMemory(backend: LadybugBackend, dataDir: string, env?: Record<string, string | undefined>): Promise<MemoryMigration> {
  const path = oldMemoryPath(dataDir, env);
  if (!existsSync(path)) return { status: "none" };
  const stamp = `memory_migrated:${path}`;
  const handle = await memoryOn(backend);
  const done = await backend.lbug.query("MATCH (m:Migration) WHERE m.migration_id = $id RETURN m.migration_id AS id", { id: stamp });
  if (done.length) return { status: "renamed", from: path, to: renameOld(path) };

  // 1. The backup: the file as it is, beside the other memory backups.
  const backups = join(dirname(path), "backups");
  ownerOnly(backups);
  const backup = join(backups, `${basename(path)}-premigration-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  copyFileSync(path, backup);
  for (const s of SIDE.slice(0, 1)) if (existsSync(path + s)) copyFileSync(path + s, backup + s);

  // 2. The copy, in one transaction, in memory's queue.
  const old = await readOld(path);
  const out = await exclusiveOn(handle, async (h) => {
    const here = await dump(h);
    const report = await applyDump(h, old, here, { keep: true, single: true });
    await backend.lbug.withWrite((tx) => tx.run("MERGE (m:Migration {migration_id: $id}) ON CREATE SET m.executed_at = CAST($now AS INT64)", { id: stamp, now: Date.now() }));
    return report;
  });

  // 3. Out of the way, in place.
  const to = renameOld(path);
  return {
    status: "migrated", from: path, to, backup, nodes: out.created, edges: out.edges.added, skipped: out.unchanged,
    lock_ms: out.lock_ms.reduce((a, b) => a + b, 0),
  };
}

/** The old file's columns of a table, as it has them (an older strut wrote fewer). */
async function columns(q: (c: string) => Promise<Row[]>, table: string): Promise<Set<string>> {
  return new Set((await q(`CALL table_info('${table}') RETURN name`)).map((r) => String(r["name"])));
}

/** Everything memory's old file holds, as a dump (_snapshot.ts) of the workspace's shape. */
export async function readOld(path: string): Promise<Dump> {
  const lbug = await loadLadybug();
  // Read-only: the old file is never changed by a migration.
  const db = new lbug.Database(path, 0, true, true, ladybugMaxDbSize());
  const conn = new lbug.Connection(db);
  const q = async (c: string): Promise<Row[]> => {
    const r = await conn.query(c);
    return (await (Array.isArray(r) ? r[r.length - 1]! : r).getAll()) as Row[];
  };
  try {
    const tables = new Set((await q("CALL show_tables() RETURN name")).map((r) => String(r["name"])));
    const nodes: DumpNode[] = [];
    const read = async (table: string, type: (r: Row) => string, fields: (r: Row) => Row) => {
      if (!tables.has(table)) return;
      const have = await columns(q, table);
      const cols = [...have].map((c) => `n.\`${c}\` AS \`${c}\``).join(", ");
      for (const r of await q(`MATCH (n:\`${table}\`) RETURN ${cols}`)) {
        const t = type(r);
        nodes.push({
          ref_id: String(r["ref_id"]), node_type: t, attributes: pick(t, fields(r)), updated_at: Number(r["updated_at"] ?? r["created_at"] ?? 0),
          ...(r["deleted_at"] != null ? { deleted_at: Number(r["deleted_at"]) } : {}),
          ...(r["deleted_reason"] != null ? { deleted_reason: String(r["deleted_reason"]) } : {}),
        });
      }
    };
    const born = (r: Row) => Number(r["created_at"] ?? r["updated_at"] ?? 0);
    await read("Entity", (r) => String(r["type"] || "Topic"), (r) => ({
      memory_entity: true, name: r["name"] || r["ref_id"], summary: r["summary"], alias_keys: r["aliases"] ?? [],
      attributes_json: r["attributes"], created_by: r["created_by"], created_at: born(r),
    }));
    // Facts written before world time stored record time in its place: a
    // valid_at equal to created_at, an invalid_at equal to expired_at (the old
    // file's open cleared these; a file not opened since still has them).
    await read("Fact", () => FACT, (r) => ({
      ...r, predicate: r["predicate"] || "about", created_at: born(r),
      valid_at: r["valid_at"] != null && r["valid_at"] === r["created_at"] ? null : r["valid_at"],
      invalid_at: r["invalid_at"] != null && r["invalid_at"] === r["expired_at"] ? null : r["invalid_at"],
    }));
    await read("Episode", () => EPISODE, (r) => ({ ...r, created_at: born(r) }));

    const terms: Term[] = [];
    if (tables.has("Ontology")) {
      const have = await columns(q, "Ontology");
      const col = (c: string) => (have.has(c) ? `o.${c}` : "NULL");
      for (const r of await q(
        `MATCH (o:Ontology) RETURN o.kind AS kind, o.name AS name, o.description AS description, o.status AS status, o.cardinality AS cardinality,
                o.subject_types AS subject_types, o.object_types AS object_types, o.aliases AS aliases,
                ${col("parent")} AS parent, ${col("naming")} AS naming, ${col("role")} AS role`,
      )) {
        terms.push({
          kind: r["kind"], name: r["name"], description: r["description"] ?? "", status: r["status"] === "proposed" ? "proposed" : "active",
          cardinality: r["cardinality"] ?? "", subject_types: r["subject_types"] ?? [], object_types: r["object_types"] ?? [],
          aliases: r["aliases"] ?? [], parent: r["parent"] ?? "", naming: r["naming"] ?? "", role: r["role"] ?? "",
        } as Term);
      }
    }
    // A type an entity has with no term of its own (a row someone removed) comes back as proposed.
    for (const t of new Set(nodes.filter((n) => n.node_type !== FACT && n.node_type !== EPISODE).map((n) => n.node_type))) {
      if (!terms.some((x) => x.kind === "entity_type" && x.name === t)) {
        terms.push({ kind: "entity_type", name: t, description: "", status: "proposed", cardinality: "", subject_types: [], object_types: [], aliases: [], parent: "", naming: "", role: "" });
      }
    }

    const ids = new Set(nodes.map((n) => n.ref_id));
    const edges: Dump["edges"] = [];
    for (const edge of MEMORY_EDGES) {
      if (!tables.has(edge)) continue;
      for (const r of await q(`MATCH (a)-[:\`${edge}\`]->(b) RETURN DISTINCT a.ref_id AS f, b.ref_id AS t`)) {
        if (ids.has(r["f"]) && ids.has(r["t"])) edges.push({ edge, from: String(r["f"]), to: String(r["t"]) });
      }
    }
    return { nodes, edges, terms };
  } finally {
    await conn.close?.();
    await db.close?.();
  }
}
