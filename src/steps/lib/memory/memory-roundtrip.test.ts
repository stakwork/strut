import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryDb, memoryWrite, type Query, type Row } from "./_db.js";

// Phase 0 of the encrypted backup (peel docs/memory-backup.md): memory/export →
// memory/import must bring back EVERY row, edge and property of the graph, not
// just what recall happens to show. This fills a graph with every column type
// the memory schema uses at its edges, exports, imports into an empty graph,
// and compares the two tables dump to dump. Skips where @ladybugdb/core does
// not load, as memory-snapshot.test.ts does.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

const MAX_INT64 = 9223372036854775807n;
const MIN_INT64 = -9223372036854775808n;
const BEYOND_2_53 = 9007199254740993n; // 2^53 + 1: a JS number cannot hold it

/** Every table of the graph as plain rows, sorted: nodes by primary key, rels by their ends. */
async function dump(query: Query): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const tables = await query("CALL show_tables() RETURN name, type");
  for (const t of tables.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const name = String(t.name);
    const info = await query(`CALL table_info('${name}') RETURN *`);
    const columns = info.map((c) => `${c.name} ${c.type}`).sort();
    let rows: Row[];
    if (t.type === "REL") {
      rows = await query(`MATCH (a)-[r:\`${name}\`]->(b) RETURN label(a) AS from_table, a.ref_id AS from_id, label(b) AS to_table, b.ref_id AS to_id, r AS props`);
      rows = rows.map((r) => ({ ...r, props: strip(r.props) }));
    } else {
      // The driver hands INT64 back as a JS number, which cannot tell 2^53 from 2^53+1: read them as text.
      const cols = info.map((c) => (c.type === "INT64" ? `CAST(n.\`${c.name}\` AS STRING) AS \`${c.name}\`` : `n.\`${c.name}\` AS \`${c.name}\``));
      rows = await query(`MATCH (n:\`${name}\`) RETURN ${cols.join(", ")}`);
    }
    // Duplicate edges are rows of their own, so multiplicity is compared too.
    out[name] = [columns, ...rows.sort((x, y) => key(x).localeCompare(key(y)))];
  }
  return out;
}

const strip = (o: Row) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "_id" && k !== "_label" && k !== "_src" && k !== "_dst"));
const key = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : typeof x === "number" && !Number.isFinite(x) ? String(x) : Object.is(x, -0) ? "-0" : x));

describe("memory export → import is lossless", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut memory roundtrip-"));
  const ctx = (name: string) =>
    ({
      runId: "test",
      path: "test",
      scope: {},
      input: undefined,
      emit: async () => {},
      services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, name, "graph.lbug") : undefined) } },
    }) as unknown as StepContext;
  const A = ctx("a");
  const B = ctx("b");
  let run: (type: string, input: unknown, c: StepContext) => Promise<any>;
  let snap: any;

  before(async () => {
    const { registry } = await buildRegistry();
    run = (type, input, c) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
    const me = { type: "Self", name: "Me" };
    // What the steps themselves write: supersession, a merge (ALIAS_OF), a soft delete with a reason.
    await run("memory/remember", { episode: "My name is Tom.", facts: [{ subject: me, predicate: "name", text: "The user's name is Tom." }] }, A);
    await run("memory/remember", { episode: "Call me Thomas.", facts: [{ subject: me, predicate: "name", text: "The user's name is Thomas." }] }, A);
    await run(
      "memory/remember",
      { episode: "I play chess with Kate on Sundays.", facts: [{ subject: me, predicate: "plays chess with", object: { type: "Person", name: "Kate" }, text: "The user plays chess with Kate." }] },
      A,
    );
    const katherine = await run("memory/remember", { episode: "Katherine cooks.", facts: [{ subject: { type: "Person", name: "Katherine" }, predicate: "prefers", text: "Katherine likes cooking." }] }, A);
    const doomed = await run("memory/remember", { episode: "Bob owns a boat.", facts: [{ subject: { type: "Person", name: "Bob" }, predicate: "prefers", text: "Bob likes boats." }] }, A);
    const kate = (await run("memory/recall", { q: "Kate", type: "Person" }, A))[0];
    await run("memory/merge", { keep: kate.ref_id, duplicate: katherine.entities[0].ref_id }, A);
    await run("memory/forget", { ref_id: doomed.facts[0].ref_id, reason: "wrong, it's \"Bill\", not Bob" }, A);

    // What the steps never write by hand: values at the edges of every column type.
    await memoryWrite(A, async (q) => {
      const entity = (id: string, p: Record<string, unknown>) =>
        q(
          `CREATE (:Entity {ref_id: $id, type: $type, name: $name, summary: $summary, attributes: $attributes, aliases: $aliases,
             created_by: $created_by, created_at: $created_at, updated_at: $updated_at, deleted_at: $deleted_at, deleted_reason: $deleted_reason})`,
          { id, type: "Thing", name: id, summary: null, attributes: null, aliases: null, created_by: null, created_at: 1, updated_at: 1, deleted_at: null, deleted_reason: null, ...p },
        );
      await entity("e-aliases", {
        // Commas, quotes, a backslash, a newline, a tab, an apostrophe, CJK, an emoji, and the empty string.
        aliases: ["kate", "kat, the \"great\"", "back\\slash", "line\nbreak\ttab", "it's", "ケイト", "😀👩‍👩‍👧", "", " padded "],
        summary: "x".repeat(300_000) + "é" + "\u{1F600}",
        attributes: JSON.stringify({ a: [1, 2.5, null], "k,ey": "v\"al" }),
      });
      await entity("e-empty-list", { aliases: [] });
      await entity("e-null-list", { aliases: null });
      await entity("e-empty-string", { summary: "", name: "", attributes: "" });
      await entity("e-ints", { created_at: MAX_INT64, updated_at: MIN_INT64, deleted_at: BEYOND_2_53, deleted_reason: "reason\nwith newline" });
      await entity("e-zero", { created_at: 0, updated_at: -1 });
      await q(
        `CREATE (:Fact {ref_id: $id, predicate: 'p', text: 't', confidence: $c, valid_at: $v, invalid_at: $i, expired_at: $x,
           created_by: 'u', created_at: 1, updated_at: 1, deleted_at: null, deleted_reason: null, value: $value})`,
        { id: "f-pi", c: Math.PI, v: BEYOND_2_53, i: MAX_INT64, x: MIN_INT64, value: "name,with,commas" },
      );
      for (const [id, c] of [
        ["f-third", 1 / 3],
        ["f-zero", 0],
        ["f-tiny", 5e-324],
        ["f-huge", Number.MAX_VALUE],
        ["f-one", 1],
        ["f-null", null],
      ] as const) {
        await q(`CREATE (:Fact {ref_id: $id, predicate: 'p', text: '', confidence: $c, created_at: 1, updated_at: 1})`, { id, c });
      }
      await q(
        `CREATE (:Episode {ref_id: 'ep-all', kind: 'chat', source: 'src, "quoted"', content: $content, occurred_at: $t,
           created_by: 'u', created_at: 1, updated_at: 2, deleted_at: 3, deleted_reason: 'r', speaker: 'e-aliases'})`,
        { content: "line1\nline2\r\nline3\0not-a-terminator".replace("\0", ""), t: BEYOND_2_53 },
      );
      await q(`CREATE (:Episode {ref_id: 'ep-null'})`);
      await q(
        `CREATE (:Ontology {key: 'type:Custom', kind: 'type', name: 'Custom', description: 'd, "q"', status: 'proposed', cardinality: 'many',
           subject_types: ['A,B', ''], object_types: [], aliases: null, created_by: 'x', created_at: $t, updated_at: 0, parent: null, naming: 'n', role: null})`,
        { t: MAX_INT64 },
      );
      // Every edge kind, beside the ones the steps made; duplicates, a self-loop, both directions.
      const edge = (rel: string, from: [string, string], to: [string, string]) =>
        q(`MATCH (a:${from[0]} {ref_id: $a}), (b:${to[0]} {ref_id: $b}) CREATE (a)-[:${rel}]->(b)`, { a: from[1], b: to[1] });
      await edge("MENTIONS", ["Episode", "ep-all"], ["Entity", "e-aliases"]);
      await edge("MENTIONS", ["Episode", "ep-all"], ["Entity", "e-aliases"]);
      await edge("SUBJECT", ["Fact", "f-pi"], ["Entity", "e-ints"]);
      await edge("OBJECT", ["Fact", "f-pi"], ["Entity", "e-aliases"]);
      await edge("FROM_EPISODE", ["Fact", "f-pi"], ["Episode", "ep-all"]);
      await edge("SUPERSEDES", ["Fact", "f-third"], ["Fact", "f-pi"]);
      await edge("SUPERSEDES", ["Fact", "f-one"], ["Fact", "f-one"]);
      await edge("CONTRADICTS", ["Fact", "f-pi"], ["Fact", "f-third"]);
      await edge("CONTRADICTS", ["Fact", "f-third"], ["Fact", "f-pi"]);
      await edge("ALIAS_OF", ["Entity", "e-ints"], ["Entity", "e-zero"]);
    });

    // Not empty by luck: every table of the schema holds rows.
    const counts = (await run("memory/export", { inline: true }, A)).counts as Record<string, number>;
    for (const [table, n] of Object.entries(counts)) assert.ok(n > 0, `the fixture leaves ${table} empty`);

    snap = await run("memory/export", { inline: true }, A);
    assert.ok(!snap.error, snap.error);
    const out = await run("memory/import", { data: snap.data }, B);
    assert.ok(!out.error, out.error);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("the fixture really holds the awkward values (so the comparison below is not vacuous)", async () => {
    const q = await memoryDb(A);
    const [e] = await q(
      "MATCH (e:Entity {ref_id: 'e-ints'}) RETURN CAST(e.created_at AS STRING) AS hi, CAST(e.updated_at AS STRING) AS lo, CAST(e.deleted_at AS STRING) AS big",
    );
    assert.deepEqual([e!.hi, e!.lo, e!.big], [String(MAX_INT64), String(MIN_INT64), String(BEYOND_2_53)]);
    const [l] = await q("MATCH (e:Entity {ref_id: 'e-aliases'}) RETURN e.aliases AS a, size(e.summary) AS n");
    assert.equal(l!.a.length, 9);
    assert.ok(l!.n > 300_000);
    const [z] = await q("MATCH (f:Fact {ref_id: 'f-tiny'}) RETURN f.confidence AS c");
    assert.equal(z!.c, 5e-324);
    assert.ok(Number((await q("MATCH (e:Entity) WHERE e.deleted_at IS NOT NULL RETURN count(e) AS n"))[0]!.n) > 1);
    assert.ok(Number((await q("MATCH (f:Fact) WHERE f.deleted_at IS NOT NULL RETURN count(f) AS n"))[0]!.n) >= 1);
  });

  it("every table, column, row and edge comes back exactly", async () => {
    const a = await dump(await memoryDb(A));
    const b = await dump(await memoryDb(B));
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
    for (const table of Object.keys(a)) assert.equal(key(b[table]), key(a[table]), `${table} differs after the round trip`);
  });

  it("a second hop (export the import, import again) is still identical", async () => {
    const again = await run("memory/export", { inline: true }, B);
    assert.deepEqual(again.counts, snap.counts);
    const C = ctx("c");
    assert.ok(!(await run("memory/import", { data: again.data }, C)).error);
    assert.equal(key(await dump(await memoryDb(C))), key(await dump(await memoryDb(A))));
  });

  it("the comparison would notice a changed value, a lost list item and a lost edge", async () => {
    const a = key(await dump(await memoryDb(A)));
    const q = await memoryDb(B);
    const same = async () => key(await dump(q)) === a;
    assert.ok(await same());
    await q("MATCH (f:Fact {ref_id: 'f-third'}) SET f.confidence = 0.33333333333333337");
    assert.ok(!(await same()), "a double one ulp away");
    await q("MATCH (f:Fact {ref_id: 'f-third'}) SET f.confidence = $c", { c: 1 / 3 });
    assert.ok(await same());
    await q("MATCH (e:Entity {ref_id: 'e-aliases'}) SET e.aliases = list_slice(e.aliases, 1, 8)");
    assert.ok(!(await same()), "a list one item short");
    await q("MATCH (e:Entity {ref_id: 'e-ints'}) SET e.created_at = $v", { v: MAX_INT64 - 1n });
    assert.ok(!(await same()), "an INT64 one away");
    await q("MATCH (:Episode {ref_id: 'ep-all'})-[m:MENTIONS]->(:Entity {ref_id: 'e-aliases'}) WITH m LIMIT 1 DELETE m");
    assert.ok(!(await same()), "a duplicate edge short");
  });
});
