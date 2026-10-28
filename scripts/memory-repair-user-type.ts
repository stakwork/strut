// One-off repair for a memory graph whose user was filed under a proposed
// "UserType" (a model read `user_type` off memory/ontology and wrote it as
// the type): the user's entity goes back to the user type (Self), and the
// proposed term is retired. remember now reads "UserType" as Self itself
// (_ontology.ts `lookup`), so nothing makes a new one.
//
//   npx tsx scripts/memory-repair-user-type.ts <memory graph.lbug>           # read only: what it would do
//   npx tsx scripts/memory-repair-user-type.ts <memory graph.lbug> --apply   # export, then repair
//
// Stop the strut that holds the file first: Ladybug opens a file in one
// process at a time. With --apply it exports first (memory/export) and keeps
// that snapshot beside the file as memory-before-user-type-repair-<time>.tar.gz,
// which memory/import restores. It changes nothing when the user type
// already has an entity (two users: merge them with memory/merge instead),
// or when more than one entity carries the proposed type.
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildRegistry } from "../src/steps/registry.js";
import { memoryDb, memoryWrite } from "../src/steps/lib/memory/_db.js";
import { invalidate, snake, vocabulary } from "../src/steps/lib/memory/_ontology.js";
import type { StepContext } from "../src/core.js";

const [file, flag] = process.argv.slice(2);
if (!file || (flag !== undefined && flag !== "--apply")) {
  console.error("usage: memory-repair-user-type.ts <memory graph.lbug> [--apply]");
  process.exit(2);
}
const apply = flag === "--apply";
const path = resolve(file);
const ctx = {
  runId: "memory-repair-user-type", path: "memory-repair-user-type", scope: {}, input: undefined, emit: async () => {},
  services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? path : undefined) } },
} as unknown as StepContext;

const query = await memoryDb(ctx);
const vocab = await vocabulary(query);
const userType = vocab.userType();
if (!userType) throw new Error("this memory has no user type");
// Proposed entity types that are the user type once a trailing Type comes off.
const wrong = vocab.terms
  .filter((t) => t.kind === "entity_type" && t.status === "proposed" && /_type$/.test(snake(t.name)))
  .filter((t) => vocab.term("entity_type", snake(t.name).replace(/_type$/, ""))?.name === userType)
  .map((t) => t.name);
const entities = (types: string[]) =>
  query("MATCH (e:Entity) WHERE e.type IN $types AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name ORDER BY e.created_at", { types });
const filed = await entities(wrong);
const users = await entities([userType]);
console.log(JSON.stringify({ file: path, user_type: userType, proposed_terms: wrong, filed_under_them: filed, user_entities: users }, null, 2));

if (!wrong.length) {
  console.log("nothing to repair");
  process.exit(0);
}
if (users.length && filed.length) {
  console.error(`refused: ${userType} already has an entity (${users[0]!.ref_id}); merge ${filed.map((e) => e.ref_id).join(", ")} into it with memory/merge, then run this again to retire the terms`);
  process.exit(1);
}
if (filed.length > 1) {
  console.error(`refused: ${filed.length} entities carry ${wrong.join(", ")}; merge them with memory/merge first, so there is one user`);
  process.exit(1);
}
if (!apply) {
  console.log(`would set ${filed[0]?.ref_id ?? "no entity"} to ${userType} and retire ${wrong.map((t) => `entity_type:${t}`).join(", ")}; run with --apply`);
  process.exit(0);
}

const { registry } = await buildRegistry();
const exporter = registry["memory/export"]!;
const exported = (await exporter.run(exporter.input.parse({}) as never, ctx)) as { path?: string; error?: string };
if (!exported.path) throw new Error(`export failed, nothing changed: ${exported.error ?? JSON.stringify(exported)}`);
const kept = join(dirname(path), `memory-before-user-type-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
copyFileSync(exported.path, kept);
console.log(`exported to ${kept}`);

await memoryWrite(ctx, async (tx) => {
  const now = Date.now();
  if (filed[0]) await tx("MATCH (e:Entity) WHERE e.ref_id = $id SET e.type = $type, e.updated_at = $now", { id: filed[0].ref_id, type: userType, now });
  // Retired: a proposed term nothing uses any more is deleted, as a janitor would.
  for (const t of wrong) await tx("MATCH (o:Ontology) WHERE o.key = $key AND o.status = 'proposed' DELETE o", { key: `entity_type:${t}` });
  invalidate(tx);
});
console.log(`repaired: ${filed[0] ? `${filed[0].ref_id} is ${userType}; ` : ""}retired ${wrong.join(", ")}`);
