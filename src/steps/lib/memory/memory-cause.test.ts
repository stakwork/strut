import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { causeKey, normalise, parentKey } from "./_cause-key.js";
import { ensureSchema, memoryDb, memoryExclusive } from "./_db.js";

const sha = (s: string) => "ck1_" + createHash("sha256").update(s).digest("hex").slice(0, 16);
const hasLadybug = await import("@ladybugdb/core").then(() => true, () => false);

describe("causeKey", () => {
  it("normalises by hand", () => {
    // "the" stopword; "files" -> "fil" (es dropped); "ignoring" -> "ignor"; "42" dropped; quotes/code stripped
    assert.equal(normalise("The files ignoring `x = 1` \"quoted\" 42 rules"), "fil ignor rul");
    assert.equal(normalise("Missing policies"), "miss policy");
  });
  it("is order independent and deterministic", () => {
    assert.equal(normalise("agent ignored format rules"), normalise("rules format agent ignored"));
    assert.equal(causeKey("a", "b", "Some Text here!"), causeKey("a", "b", "some text here"));
  });
  it("applies defaults and the formula", () => {
    assert.equal(causeKey(undefined, undefined, "format rules"), sha(`correction\nother\n${normalise("format rules")}`));
    assert.match(causeKey(undefined, undefined, "x yy"), /^ck1_[0-9a-f]{16}$/);
    assert.equal(parentKey(), sha("parent\nother"));
    assert.equal(parentKey("m"), sha("parent\nm"));
  });
  it("strips fenced code", () => {
    assert.equal(normalise("bad ```const a = 1;``` output"), "bad output");
  });
});

describe("memory Cause / Concept schema", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut memory cause-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const mk = (name: string) =>
    ({
      runId: "t", path: "t", scope: {}, input: undefined, emit: async () => {},
      services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, name, "graph.lbug") : undefined) } },
    }) as unknown as StepContext;

  it("ensureSchema is idempotent and edges round-trip", async () => {
    const ctx = mk("a");
    const q = await memoryDb(ctx);
    await ensureSchema(q);
    await ensureSchema(q);
    await memoryExclusive(ctx, async ({ write }) => {
      await write("CREATE (:Entity {ref_id:'e1', name:'E'}), (:Fact {ref_id:'f1', text:'T'})");
      await write("CREATE (:Cause {ref_id:'c1', statement:'s', identity_key:'k'}), (:Cause {ref_id:'c0', statement:'p'}), (:Concept {ref_id:'k1', name:'K', keywords:['a']})");
      await write("MATCH (c:Cause {ref_id:'c1'}), (e:Entity {ref_id:'e1'}) CREATE (c)-[:EVIDENCED_BY_ENTITY {excerpt:'x', confidence:0.5, turn_at:1}]->(e)");
      await write("MATCH (c:Cause {ref_id:'c1'}), (f:Fact {ref_id:'f1'}) CREATE (c)-[:EVIDENCED_BY_FACT {why:'w'}]->(f)");
      await write("MATCH (c:Cause {ref_id:'c1'}), (p:Cause {ref_id:'c0'}) CREATE (c)-[:CAUSE_CHILD_OF]->(p)");
      await write("MATCH (k:Concept {ref_id:'k1'}), (c:Cause {ref_id:'c1'}) CREATE (k)-[:ADDRESSES]->(c)");
    });
    const rows = await q("MATCH (c:Cause {ref_id:'c1'})-[r]->(x) WHERE label(r) STARTS WITH 'EVIDENCED_BY' RETURN label(x) AS l, r.excerpt AS ex ORDER BY l");
    assert.deepEqual(rows.map((r) => r.l), ["Entity", "Fact"]);
    assert.equal(rows[0].ex, "x");
    const p = await q("MATCH (:Cause {ref_id:'c1'})-[:CAUSE_CHILD_OF]->(p:Cause) RETURN p.ref_id AS id");
    assert.equal(p[0].id, "c0");
  });

  it("snapshot export/import carries them", async () => {
    const { registry } = await buildRegistry();
    const run = (type: string, input: unknown, c: StepContext) => {
      const d = registry[type] as any;
      return d.run(d.input.parse(input), c);
    };
    const a = mk("a"), b = mk("b");
    const out = await run("memory/export", {}, a);
    await run("memory/import", { path: out.path ?? out.file }, b);
    const rows = await (await memoryDb(b))("MATCH (:Cause)-[:EVIDENCED_BY_ENTITY]->(:Entity) RETURN count(*) AS n");
    assert.equal(Number(rows[0].n), 1);
  });
});
