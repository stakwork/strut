/**
 * Pass criterion 13 of plans/graph-memory-plan.md: a fresh Peel graph boots
 * without jarvis's bundled ontology. scripts/fresh-peel-graph.ts boots the
 * default server on a new LadybugDB workspace graph as Peel's desktop.js
 * does, in a child process whose module hook fails any load of
 * fixtures/jarvis-ontology.ts, then remembers, recalls and resolves through
 * the graph/* steps. Neo4j still seeds that ontology (backend.ts); its
 * suites cover it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JARVIS_ONTOLOGY } from "./fixtures/jarvis-ontology.js";
import { LADYBUG_SCHEMAS } from "./ladybug/registry.js";
import { THING_TYPE } from "./strut-schemas.js";
import { testBackends } from "./test-util.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

describe("a fresh Peel graph (ladybug)", { skip: lb.skip }, () => {
  it("boots without jarvis's bundled ontology, and remembers, recalls and resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-fresh-peel-"));
    try {
      const script = fileURLToPath(new URL("../../scripts/fresh-peel-graph.ts", import.meta.url));
      const out = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), script, dir], { encoding: "utf8", timeout: 120_000 });
      assert.equal(out.status, 0, out.stderr);
      const seen = JSON.parse(out.stdout.trim().split("\n").at(-1)!);

      // The file's types are its own seed; none comes from the fixture.
      const seed = [THING_TYPE, ...LADYBUG_SCHEMAS.map((s) => s.type)].sort();
      assert.deepEqual(seen.types, seed);
      const jarvisOnly = JARVIS_ONTOLOGY.schemas.map((s) => String(s["type"])).filter((t) => !seed.includes(t));
      assert.ok(jarvisOnly.length > 0);
      assert.deepEqual(seen.types.filter((t: string) => jarvisOnly.includes(t)), []);

      assert.equal(seen.remembered.status, "Success", JSON.stringify(seen.remembered));
      assert.deepEqual(seen.remembered.facts.map((f: { action: string }) => f.action), ["created"]);
      const kate = seen.remembered.facts[0].source_ref_id;
      const hit = seen.recalled.find((r: { ref_id: string }) => r.ref_id === kate);
      assert.ok(hit, JSON.stringify(seen.recalled));
      assert.equal(hit.name, "Kate Moss");
      assert.deepEqual(hit.edges, { WORKS_WITH: 1 });
      assert.equal(seen.resolved.match?.ref_id, kate, JSON.stringify(seen.resolved));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
