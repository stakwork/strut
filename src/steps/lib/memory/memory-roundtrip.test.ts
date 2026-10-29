import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import type { StepContext } from "../../../core.js";
import { NodeWriter } from "../../../graph/node-writer.js";
import { buildRegistry } from "../../registry.js";
import { type MemoryTx, type Row, exclusiveOn, memoryOn, writeOn } from "./_db.js";
import { termsOf } from "./_ontology.js";
import { untar } from "../../../tar.js";
import { NO_LADYBUG, memoryWorkspace, type MemoryWorkspace } from "./_test-workspace.js";

// Phase 0 of the encrypted backup (peel docs/memory-backup.md): memory/export →
// memory/import must bring back EVERY node, edge and attribute of memory, not
// just what recall happens to show. Memory lives in the workspace graph, so
// this fills one workspace with memory at the edges of every attribute type
// (and a workspace node that is not memory's), exports, imports into another
// workspace, and compares memory's part of the two row for row, read straight
// from the `Node` table. Skips where @ladybugdb/core does not load.
const hasLadybug = !NO_LADYBUG;

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

// A snapshot is JSON: an int attribute holds what a JS number holds exactly (times are epoch ms).
const MAX_INT = Number.MAX_SAFE_INTEGER;
const MIN_INT = Number.MIN_SAFE_INTEGER;

/** Columns that are not memory's to carry: when the copy was made, and what the writer derives for search on the
 *  copy from the attributes (its text joins them in the order they are written, so it may read in another order). */
const NOT_CARRIED = new Set(["date_added_to_graph", "text_embeddings", "Data_Bank", "_search_fields_used"]);

/** Memory's part of a workspace as plain rows, read from the tables, not through the snapshot code. */
async function dumpRows(ws: MemoryWorkspace) {
  const q = (c: string, p?: Record<string, unknown>) => ws.graph.lbug.query(c, p) as Promise<Row[]>;
  const managed = await ws.graph.schemas.managedTypes();
  const types = [...managed].filter(([, by]) => by === "memory").map(([t]) => t);
  const info = await q("CALL table_info('Node') RETURN *");
  // The driver hands INT64 back as a JS number: read them as text, so nothing is rounded on the way.
  const cols = info
    .filter((c) => !NOT_CARRIED.has(String(c.name)))
    .map((c) => (c.type === "INT64" ? `CAST(n.\`${c.name}\` AS STRING) AS \`${c.name}\`` : `n.\`${c.name}\` AS \`${c.name}\``));
  const nodes = (await q(`MATCH (n:Node) WHERE n.node_type IN $types RETURN ${cols.join(", ")}`, { types })).sort((x, y) => cmp(x.ref_id, y.ref_id));
  const edges = (
    await q(`MATCH (a:Node)-[r]->(b:Node) WHERE a.node_type IN $types AND b.node_type IN $types RETURN label(r) AS edge, a.ref_id AS from_id, b.ref_id AS to_id`, { types })
  ).sort((x, y) => cmp(key(x), key(y)));
  const terms = (await termsOf(q)).sort((x, y) => cmp(`${x.kind}:${x.name}`, `${y.kind}:${y.name}`));
  return { nodes, edges, terms };
}

const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
const key = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : typeof x === "number" && !Number.isFinite(x) ? String(x) : Object.is(x, -0) ? "-0" : x));

describe("memory export → import is lossless", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  let A: MemoryWorkspace;
  let B: MemoryWorkspace;
  let C: MemoryWorkspace;
  let run: (type: string, input: unknown, c: StepContext) => Promise<any>;
  let snap: any;
  let out: any;
  let concept: string;
  let cross: string;

  before(async () => {
    [A, B, C] = await Promise.all([memoryWorkspace("strut memory roundtrip a-"), memoryWorkspace("strut memory roundtrip b-"), memoryWorkspace("strut memory roundtrip c-")]);
    const { registry } = await buildRegistry();
    run = (type, input, c) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
    const a = A.ctx();
    const me = { type: "Self", name: "Me" };
    // A workspace node that is not memory's, and a fact pointing at it (a cross edge).
    // A workflow node: a Concept would do as well, but Ladybug's seed gives Concept a CHILD_OF rule to itself, which
    // stops the edge resolver's ancestor walk before Thing, so no OBJECT edge may point at one (graph/ladybug).
    concept = (await A.graph.nodes.write({ type: "StrutWorkflow", data: { name: "deploy", description: "Ships strut." } })).ref_id;
    // What the steps themselves write: supersession, a proposed predicate and type, a merge (ALIAS_OF), a soft delete with a reason.
    await run("memory/remember", { episode: "My name is Tom.", facts: [{ subject: me, predicate: "name", text: "The user's name is Tom." }] }, a);
    await run("memory/remember", { episode: "Call me Thomas.", facts: [{ subject: me, predicate: "name", text: "The user's name is Thomas." }] }, a);
    await run(
      "memory/remember",
      { episode: "I play chess with Kate on Sundays.", facts: [{ subject: me, predicate: "plays chess with", object: { type: "Person", name: "Kate" }, text: "The user plays chess with Kate." }] },
      a,
    );
    await run("memory/remember", { episode: "The kettle is a Gadget.", mentions: [{ type: "Gadget", name: "Kettle" }] }, a);
    const katherine = await run("memory/remember", { episode: "Katherine cooks.", facts: [{ subject: { type: "Person", name: "Katherine" }, predicate: "prefers", text: "Katherine likes cooking." }] }, a);
    const doomed = await run("memory/remember", { episode: "Bob owns a boat.", facts: [{ subject: { type: "Person", name: "Bob" }, predicate: "prefers", text: "Bob likes boats." }] }, a);
    const kate = (await run("memory/recall", { q: "Kate", type: "Person" }, a))[0];
    await run("memory/merge", { keep: kate.ref_id, duplicate: katherine.entities[0].ref_id }, a);
    await run("memory/forget", { ref_id: doomed.facts[0].ref_id, reason: "wrong, it's \"Bill\", not Bob" }, a);
    const linked = await run(
      "memory/remember",
      { episode: "I wrote the deploy docs.", facts: [{ subject: me, predicate: "works_on", object: { ref_id: concept, type: "Project", name: "Deploys" }, text: "The user works on the deploy docs." }] },
      a,
    );
    assert.ok(!linked.error, linked.error);
    cross = linked.facts[0].ref_id;

    // What the steps never write: values at the edges of every attribute type, on clocks of their own.
    const handle = await memoryOn(A.graph);
    const clock = { at: 1 };
    const writer = new NodeWriter(A.graph, { embedder: A.graph.embedder, resolver: A.graph.schemas, now: () => clock.at });
    await exclusiveOn(handle, (h) =>
      writeOn(
        h,
        async (m: MemoryTx) => {
          const entity = (id: string, at: number, p: Record<string, unknown>) => {
            clock.at = at;
            return m.create("Person", { memory_entity: true, name: id, created_at: 1, ...p }, id);
          };
          await entity("e-aliases", 2, {
            // Commas, quotes, a backslash, a newline, a tab, an apostrophe, CJK, an emoji, and padding.
            alias_keys: ["kate", "kat, the \"great\"", "back\\slash", "line\nbreak\ttab", "it's", "ケイト", "😀👩‍👩‍👧", " padded "],
            summary: "x".repeat(300_000) + "é" + "\u{1F600}",
            attributes_json: JSON.stringify({ a: [1, 2.5, null], "k,ey": "v\"al" }),
            created_by: "u",
          });
          await entity("e-empty-list", 3, { alias_keys: [] });
          await entity("e-one-empty-item", 3, { alias_keys: [""] });
          await entity("e-null-list", 4, {});
          await entity("e-ints", MAX_INT, { created_at: MAX_INT });
          await entity("e-zero", 5, { created_at: 0 });
          await entity("e-negative", 6, { created_at: MIN_INT });
          clock.at = 7;
          await m.create("Fact", { predicate: "p", text: "t", confidence: Math.PI, valid_at: MAX_INT, invalid_at: MIN_INT, expired_at: 0, value: "name,with,commas", form: "f", created_by: "u", created_at: 1 }, "f-pi");
          let at = 8;
          for (const [id, c] of [
            ["f-third", 1 / 3],
            ["f-zero", 0],
            ["f-tiny", 5e-324],
            ["f-huge", Number.MAX_VALUE],
            ["f-negative", -0.5],
            ["f-one", 1],
            ["f-null", null],
          ] as const) {
            clock.at = at++;
            await m.create("Fact", { predicate: "p", text: "", confidence: c, created_at: 1 }, id);
          }
          clock.at = 20;
          await m.create(
            "Episode",
            { kind: "chat", source: 'src, "quoted"', content: "line1\nline2\r\nline3", occurred_at: MAX_INT, speaker: "e-aliases", created_by: "u", created_at: 1 },
            "ep-all",
          );
          await m.create("Episode", { created_at: 0 }, "ep-null");
          // Soft deletes, each at a time of its own, with and without a reason.
          await m.forget("e-ints", "reason\nwith newline", MAX_INT);
          await m.forget("ep-all", "", 3);
          await m.forget("f-null", "r, \"q\"", 1);
          // Every edge kind, beside the ones the steps made; a self-loop, both directions.
          for (const [edge, from, to] of [
            ["MENTIONS", "ep-all", "e-aliases"],
            ["SUBJECT", "f-pi", "e-ints"],
            ["OBJECT", "f-pi", "e-aliases"],
            ["FROM_EPISODE", "f-pi", "ep-all"],
            ["SUPERSEDES", "f-third", "f-pi"],
            ["SUPERSEDES", "f-one", "f-one"],
            ["SUPERSEDES", "f-pi", "f-third"],
            ["ALIAS_OF", "e-ints", "e-zero"],
          ] as const) await m.link(edge, from, to);
        },
        writer,
      ),
    );

    snap = await run("memory/export", { inline: true }, a);
    assert.ok(!snap.error, snap.error);
    // Not empty by luck: every kind and every edge type holds rows.
    for (const [kind, n] of Object.entries(snap.counts as Record<string, number>)) assert.ok(n > 0, `the fixture leaves ${kind} empty`);
    out = await run("memory/import", { data: snap.data }, B.ctx());
    assert.ok(!out.error, out.error);
  });
  after(() => Promise.all([A, B, C].map((w) => w?.close())));

  it("the fixture really holds the awkward values (so the comparison below is not vacuous)", async () => {
    const { nodes } = await dumpRows(A);
    const by = new Map(nodes.map((n) => [n.ref_id, n]));
    assert.equal(by.get("e-ints")!.created_at, String(MAX_INT));
    assert.equal(by.get("e-ints")!.updated_at, String(MAX_INT));
    assert.equal(by.get("e-ints")!.deleted_at, String(MAX_INT));
    assert.equal(by.get("e-ints")!.deleted_reason, "reason\nwith newline");
    assert.equal(by.get("e-negative")!.created_at, String(MIN_INT));
    assert.equal(by.get("e-aliases")!.alias_keys.length, 8);
    assert.ok(by.get("e-aliases")!.summary.length > 300_000);
    assert.deepEqual(by.get("e-empty-list")!.alias_keys, []);
    assert.deepEqual(by.get("e-one-empty-item")!.alias_keys, [""]);
    assert.equal(by.get("e-null-list")!.alias_keys, null);
    assert.equal(by.get("f-tiny")!.confidence, 5e-324);
    assert.equal(by.get("ep-all")!.deleted_at, "3");
    assert.ok(nodes.filter((n) => n.deleted_at !== null).length >= 5, "the steps' soft deletes and the fixture's");
    assert.ok(nodes.some((n) => n.deleted_reason === "wrong, it's \"Bill\", not Bob"));
    assert.ok(new Set(nodes.map((n) => n.updated_at)).size > 10, "many clocks");
  });

  it("every memory node, attribute, stamp, edge and term comes back exactly", async () => {
    const a = await dumpRows(A);
    const b = await dumpRows(B);
    assert.equal(b.nodes.length, a.nodes.length);
    for (let i = 0; i < a.nodes.length; i++) assert.equal(key(b.nodes[i]), key(a.nodes[i]), `${a.nodes[i]!.ref_id} differs after the round trip`);
    // Edges between two memory nodes only: the cross edge is not memory's to carry (the next test).
    assert.equal(key(b.edges), key(a.edges));
    assert.equal(key(b.terms), key(a.terms));
  });

  it("only memory travels: the workspace's own node stays behind, and the cross edge with it", async () => {
    const files = untar(gunzipSync(Buffer.from(snap.data, "base64")));
    const nodes = files.get("graph/nodes.jsonl")!.toString();
    const edges = files.get("graph/edges.jsonl")!.toString();
    assert.ok(!nodes.includes(concept) && !edges.includes(concept), "neither the workflow node nor an edge to it is in the snapshot");
    assert.equal((await A.graph.lbug.query("MATCH (n:Node) WHERE n.ref_id = $id RETURN n.ref_id AS id", { id: concept })).length, 1);
    assert.equal((await B.graph.lbug.query("MATCH (n:Node) WHERE n.ref_id = $id RETURN n.ref_id AS id", { id: concept })).length, 0);
    const objectOf = (ws: MemoryWorkspace) =>
      ws.graph.lbug.query("MATCH (f:Node)-[:OBJECT]->(o:Node) WHERE f.ref_id = $id RETURN o.ref_id AS id", { id: cross }) as Promise<Row[]>;
    assert.deepEqual((await objectOf(A)).map((r) => r.id), [concept]);
    assert.deepEqual(await objectOf(B), [], "on the copy the fact has no object");
    const fact = await run("memory/get", { ref_id: cross }, B.ctx());
    assert.equal(fact.text, "The user works on the deploy docs.");
  });

  it("an unchanged memory exports the same content hash, on the copy as on the original", async () => {
    assert.equal((await run("memory/export", { inline: true }, A.ctx())).manifest.content_hash, snap.manifest.content_hash);
    assert.equal((await run("memory/export", { inline: true }, B.ctx())).manifest.content_hash, snap.manifest.content_hash);
  });

  it("importing the same snapshot again changes nothing: every node unchanged", async () => {
    const was = await dumpRows(B);
    const again = await run("memory/import", { data: snap.data, replace: true }, B.ctx());
    assert.ok(!again.error, again.error);
    assert.equal(again.applied.created, 0);
    assert.equal(again.applied.updated, 0);
    assert.equal(again.applied.purged, 0);
    assert.equal(again.applied.unchanged, snap.counts.Entity + snap.counts.Fact + snap.counts.Episode);
    assert.deepEqual(again.applied.edges, { added: 0, removed: 0 });
    assert.equal(key(await dumpRows(B)), key(was));
    assert.equal((await run("memory/export", { inline: true }, B.ctx())).manifest.content_hash, snap.manifest.content_hash);
  });

  it("a second hop (export the import, import again) is still identical", async () => {
    const again = await run("memory/export", { inline: true }, B.ctx());
    assert.deepEqual(again.counts, snap.counts);
    assert.ok(!(await run("memory/import", { data: again.data }, C.ctx())).error);
    assert.equal(key(await dumpRows(C)), key(await dumpRows(B)));
  });

  it("the comparison would notice a changed value, a lost list item, a changed stamp and a lost edge", async () => {
    const a = key(await dumpRows(C));
    const write = (c: string, p: Record<string, unknown> = {}) => C.graph.lbug.withWrite((tx) => tx.run(c, p));
    const same = async () => key(await dumpRows(C)) === a;
    assert.ok(await same());
    await write("MATCH (n:Node) WHERE n.ref_id = 'f-third' SET n.confidence = 0.33333333333333337");
    assert.ok(!(await same()), "a double one ulp away");
    await write("MATCH (n:Node) WHERE n.ref_id = 'f-third' SET n.confidence = $c", { c: 1 / 3 });
    assert.ok(await same());
    await write("MATCH (n:Node) WHERE n.ref_id = 'e-aliases' SET n.alias_keys = list_slice(n.alias_keys, 1, 7)");
    assert.ok(!(await same()), "a list one item short");
    await write("MATCH (n:Node) WHERE n.ref_id = 'e-ints' SET n.created_at = $v", { v: MAX_INT - 1 });
    assert.ok(!(await same()), "an int one away");
    await write("MATCH (n:Node) WHERE n.ref_id = 'e-zero' SET n.updated_at = 6");
    assert.ok(!(await same()), "an updated_at one away");
    await write("MATCH (a:Node)-[m:MENTIONS]->(b:Node) WHERE a.ref_id = 'ep-all' AND b.ref_id = 'e-aliases' DELETE m");
    assert.ok(!(await same()), "an edge short");
  });
});
