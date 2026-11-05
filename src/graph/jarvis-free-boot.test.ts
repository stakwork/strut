/**
 * Pass criterion 13 of plans/graph-memory-plan.md: a fresh Peel graph boots
 * without jarvis's ontology library. scripts/fresh-peel-graph.ts boots the
 * default server on a new LadybugDB workspace graph as Peel's desktop.js
 * does, in a child process whose module hook fails any load of
 * __fixtures__/jarvis-*.ts, then remembers, recalls and resolves through
 * the graph/* steps. Neither engine seeds jarvis's library any more
 * (plans/ontology.md item 3): it is a test fixture, which no module outside
 * a test imports — checked below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JARVIS_ONTOLOGY } from "./__fixtures__/jarvis-ontology.js";
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

describe("jarvis's ontology library is a test fixture", () => {
  it("no module outside a test imports src/graph/__fixtures__", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__fixtures__" && name !== "node_modules") walk(p);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && /__fixtures__\/jarvis-/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(src);
    assert.deepEqual(offenders, []);
  });
});
