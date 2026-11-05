// Writes the old memory database src/graph/fixtures/old-memory.json holds
// (every row and edge the retired memory/* steps wrote for a short history:
// a name, a move, a past job, a mishearing, a forgotten entity) at the path
// given: `tsx scripts/write-old-memory.ts <path>`. memory-on-graph.test.ts
// runs it in a child process, so the test's own process never opens the
// file graph/import-memory must leave as it found it.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLadybug } from "../src/graph/ladybug/db.js";
import { createTables } from "../src/steps/lib/memory/_db.js";

async function writeOldMemory(path: string): Promise<void> {
  const dump = JSON.parse(readFileSync(new URL("../src/graph/fixtures/old-memory.json", import.meta.url), "utf8")) as Record<string, any>;
  mkdirSync(join(path, ".."), { recursive: true });
  const lbug = await loadLadybug();
  const db = new lbug.Database(path);
  const conn = new lbug.Connection(db);
  const q = async (cypher: string, params: Record<string, unknown> = {}) => {
    const r = Object.keys(params).length ? await conn.execute(await conn.prepare(cypher), params) : await conn.query(cypher);
    return (await (Array.isArray(r) ? r[r.length - 1]! : r).getAll()) as Record<string, unknown>[];
  };
  await createTables(q);
  for (const table of ["Entity", "Fact", "Episode", "Ontology"]) {
    const types = new Map((await q(`CALL table_info('${table}') RETURN name, type`)).map((c) => [String(c["name"]), String(c["type"])]));
    for (const row of dump[table] as Record<string, unknown>[]) {
      const keys = Object.keys(row);
      await q(`CREATE (:${table} {${keys.map((k, i) => `${k}: CAST($p${i} AS ${types.get(k)})`).join(", ")}})`, Object.fromEntries(keys.map((k, i) => [`p${i}`, row[k]])));
    }
  }
  const ends: Record<string, [string, string]> = {
    MENTIONS: ["Episode", "Entity"], SUBJECT: ["Fact", "Entity"], OBJECT: ["Fact", "Entity"], FROM_EPISODE: ["Fact", "Episode"],
    SUPERSEDES: ["Fact", "Fact"], CONTRADICTS: ["Fact", "Fact"], ALIAS_OF: ["Entity", "Entity"],
  };
  for (const [rel, pairs] of Object.entries(dump["rels"] as Record<string, [string, string][]>)) {
    const [from, to] = ends[rel]!;
    for (const [x, y] of pairs) await q(`MATCH (a:${from} {ref_id: $x}), (b:${to} {ref_id: $y}) CREATE (a)-[:${rel}]->(b)`, { x, y });
  }
  await q("CHECKPOINT"); // all of it in the file, none left in a WAL
  await conn.close();
  await db.close();
}

const path = process.argv[2];
if (!path) throw new Error("usage: tsx scripts/write-old-memory.ts <path>");
await writeOldMemory(path);
