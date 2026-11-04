/**
 * The per-type schema rules (plans/graph-memory-plan.md step 2), enforced
 * by the writers on a Ladybug file: a key that upserts, identifiers unique
 * in a namespace, a key or identifier change refused over clashing nodes,
 * the role's title and embedding rules, an edge type's cardinality, and the
 * base types a fresh file boots with. The Neo4j path keeps jarvis's types,
 * which carry none of these rules: its suites run unchanged.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { GraphValidationError, type Embedder } from "./node-writer.js";
import { createNodeSchema, planNodeSchema } from "./schema-crud.js";
import { LADYBUG_SCHEMAS } from "./ladybug/registry.js";
import { graphSnapshot, nodeCount, rawNode, testBackends } from "./test-util.js";

const tb = testBackends().find((b) => b.kind === "ladybug")!;

const refused = (code: string, attribute?: string) => (e: unknown) => e instanceof GraphValidationError && e.code === code && (attribute === undefined || e.attribute === attribute);

function planCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof GraphValidationError) return `${e.code}${e.attribute ? `:${e.attribute}` : ""}`;
    throw e;
  }
  return "ok";
}

describe("planNodeSchema: the rules (pure)", () => {
  it("takes a role, identifiers, embed and key, and refuses bad ones", () => {
    const p = planNodeSchema({ type: "Gadget", attributes: { serial: "?string" }, role: "entity", identifiers: ["serial"], embed: false, key: "ref_id" });
    assert.deepEqual([p.flat["role"], p.flat["identifiers"], p.flat["embed"], p.key_spec], ["entity", ["serial"], false, "ref_id"]);
    assert.deepEqual(p.index, ["name"], "a type keyed by ref_id searches its name by default");
    assert.equal(planNodeSchema({ type: "Gadget", attributes: { serial: "string" }, key: "serial" }).key_spec, "gadget-serial", "key is key_spec's name in the plan");
    assert.equal(planCode(() => planNodeSchema({ type: "X", attributes: {}, role: "person" })), "WRONG_TYPE:role");
    assert.equal(planCode(() => planNodeSchema({ type: "X", attributes: {}, identifiers: ["email"] })), "UNKNOWN_ATTRIBUTE:identifiers");
    assert.equal(planCode(() => planNodeSchema({ type: "X", attributes: { tags: "?list" }, identifiers: ["tags"] })), "WRONG_TYPE:identifiers");
    assert.equal(planCode(() => planNodeSchema({ type: "X", attributes: {}, embed: "no" as never })), "WRONG_TYPE:embed");
    assert.equal(planCode(() => planNodeSchema({ type: "X", attributes: {}, key: "serial" })), "UNKNOWN_ATTRIBUTE:key_spec");
    assert.equal(planNodeSchema({ type: "X", attributes: {}, key: "serial" }, undefined, { serial: "?string" }).key_spec, "x-serial", "an attribute the type already has may be its key");
    assert.equal(planCode(() => planNodeSchema({ type: "X", attributes: {}, identifiers: ["tags"] }, undefined, { tags: "?list" })), "WRONG_TYPE:identifiers", "an inherited list is no identifier either");
  });
});

describe("schema rules on a ladybug file (plans/graph-memory-plan.md step 2)", { skip: tb.skip }, () => {
  let b: LadybugBackend;
  const embedded: string[] = [];
  const embedder: Embedder = {
    async embed(texts) {
      embedded.push(...texts);
      return texts.map((t) => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : i === 1 ? t.length / 1000 : 0)));
    },
  };
  before(async () => {
    b = (await tb.open({ embedder })) as LadybugBackend;
  });
  after(async () => {
    await tb.close(b);
  });
  beforeEach(async () => {
    await tb.clear(b);
    embedded.length = 0;
  });

  const props = async (ref_id: string) => (await rawNode(b, ref_id))!.props;
  const person = (name: string, extra: Record<string, unknown> = {}) => ({ type: "Person", data: { name, ...extra } });

  it("a fresh file boots with the base types and without jarvis's fixture", async () => {
    const types = (await b.query(`MATCH (n:Node {node_type: 'Schema'}) RETURN n.type AS t`)).map((r) => String(r["t"]));
    assert.equal(types.length, LADYBUG_SCHEMAS.length + 1, "Thing and the seed, nothing else");
    for (const t of ["Person", "Lingo", "Concept", "Claim"]) assert.ok(types.includes(t), t);
    for (const t of ["Self", "Document", "Episode", "Organization", "Entity"]) assert.ok(!types.includes(t), t);
    const p = (await b.schemas.schema("person"))!;
    assert.deepEqual([p.role, p.identifiers, p.key_spec, p.requiresTitle, p.embed], ["entity", ["email"], "ref_id", true, true]);
    assert.equal((await b.schemas.schema("Concept"))!.role, "concept");
  });

  it("a type with a key upserts: two writes give one node; a type keyed by ref_id gives two", async () => {
    const a = await b.nodes.write({ type: "Concept", data: { name: "Kubernetes" } });
    const again = await b.nodes.write({ type: "Concept", data: { name: "kubernetes", description: "the container scheduler" } }, "upsert");
    assert.deepEqual([again.ref_id, again.outcome], [a.ref_id, "updated"]);
    assert.equal((await props(a.ref_id))["description"], "the container scheduler");
    assert.equal(await nodeCount(b, "Concept"), 1);

    const s1 = await b.nodes.write(person("Sam Lee"));
    const s2 = await b.nodes.write(person("Sam Lee"));
    assert.notEqual(s1.ref_id, s2.ref_id, "two people may share a name");
    assert.equal(await nodeCount(b, "Person"), 2);
    // The user is an ordinary Person, marked.
    const me = await b.nodes.write(person("Tom", { is_owner: true }));
    assert.equal((await props(me.ref_id))["is_owner"], true);
  });

  it("a duplicate identifier is refused within a namespace, and nothing is written", async () => {
    const sam = await b.nodes.write(person("Sam", { email: "sam@example.com" }));
    await assert.rejects(b.nodes.write(person("Samuel", { email: "sam@example.com" })), refused("DUPLICATE_KEY", "email"));
    await assert.rejects(
      b.nodes.writeMany([person("A", { email: "a@example.com" }), person("B", { email: "a@example.com" })]),
      refused("DUPLICATE_KEY", "email"),
      "two in one write",
    );
    const kim = await b.nodes.write(person("Kim", { email: "kim@example.com" }));
    const withKim = await graphSnapshot(b);
    await assert.rejects(b.nodes.update(kim.ref_id, { set: { email: "sam@example.com" } }), refused("DUPLICATE_KEY", "email"));
    assert.deepEqual(await graphSnapshot(b), withKim);
    // Its own value is no clash; nor is a deleted holder's.
    await b.nodes.update(sam.ref_id, { set: { name: "Sam Lee", email: "sam@example.com" } });
    await b.nodes.deleteNode(sam.ref_id);
    const next = await b.nodes.write(person("Sam again", { email: "sam@example.com" }));
    assert.equal((await props(next.ref_id))["email"], "sam@example.com");
  });

  it("adding a key to a type with clashing nodes is refused and changes nothing; without the clash it re-keys", async () => {
    await createNodeSchema(b, b.schemas, { type: "Gadget", attributes: { serial: "?string" }, key: "ref_id", role: "entity" });
    const g1 = await b.nodes.write({ type: "Gadget", data: { name: "Lamp", serial: "s-1" } });
    const g2 = await b.nodes.write({ type: "Gadget", data: { name: "Lamp", serial: "s-1" } });
    const snap = await graphSnapshot(b);
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Gadget", attributes: {}, key: "name" }), refused("DUPLICATE_KEY", "key"));
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Gadget", attributes: {}, identifiers: ["serial"] }), refused("DUPLICATE_KEY", "identifiers"));
    assert.deepEqual(await graphSnapshot(b), snap, "the Schema row and every node as they were");
    assert.equal((await b.schemas.schema("Gadget"))!.key_spec, "ref_id");

    await b.nodes.update(g2.ref_id, { set: { name: "Desk", serial: "s-2" } });
    const r = await createNodeSchema(b, b.schemas, { type: "Gadget", attributes: {}, key: "name", identifiers: ["serial"] });
    assert.deepEqual([r.created, r.key_spec, r.changed, r.rekeyed], [false, "gadget-name", ["identifiers", "key_spec"], 2]);
    assert.equal((await props(g1.ref_id))["key"], "gadget-lamp");
    const lamp = await b.nodes.write({ type: "Gadget", data: { name: "Lamp" } });
    assert.deepEqual([lamp.ref_id, lamp.outcome], [g1.ref_id, "existing"], "and now it upserts");
    await assert.rejects(b.nodes.write({ type: "Gadget", data: { name: "Chair", serial: "s-1" } }), refused("DUPLICATE_KEY", "serial"));

    // A node without the new key's attribute has no key: refused.
    await createNodeSchema(b, b.schemas, { type: "Widget", attributes: { code: "?string" }, key: "ref_id" });
    await b.nodes.write({ type: "Widget", data: { name: "w" } });
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Widget", attributes: {}, key: "code" }), refused("MISSING_REQUIRED", "key"));
  });

  it("role: an entity needs a title; a source is found by keyword with no embedding, an entity has both", async () => {
    await createNodeSchema(b, b.schemas, { type: "Gizmo", attributes: { label: "?string", note: "?int" }, key: "ref_id", title_key: "label", index: ["label"], role: "entity" });
    await assert.rejects(b.nodes.write({ type: "Gizmo", data: {} }), refused("MISSING_REQUIRED", "label"), "an entity whose title comes out empty");
    assert.equal((await props((await b.nodes.write({ type: "Gizmo", data: { note: 3 } })).ref_id))["title"], "3", "with no label, the first line of its text");

    embedded.length = 0;
    await createNodeSchema(b, b.schemas, { type: "Utterance", attributes: { text: "string" }, key: "ref_id", title_key: "text", index: ["text"], role: "source" });
    await createNodeSchema(b, b.schemas, { type: "Dictation", parent: "Utterance", attributes: {}, key: "ref_id", title_key: "text", index: ["text"] });
    assert.deepEqual([(await b.schemas.schema("Utterance"))!.embed, (await b.schemas.schema("Dictation"))!.role, (await b.schemas.schema("Dictation"))!.embed], [false, "source", false], "a source's subtype is a source");
    const said = await b.nodes.write({ type: "Dictation", data: { text: "remind me about the zeppelin booking" } });
    const sam = await b.nodes.write(person("Zeppelin Sam"));
    assert.equal((await props(said.ref_id))["text_embeddings"], undefined, "a source gets no vector");
    assert.ok(Array.isArray((await props(sam.ref_id))["text_embeddings"]), "an entity does");
    assert.deepEqual(embedded, ["Zeppelin Sam"]);
    const hits = (await b.reader.search({ q: "zeppelin" })).nodes.map((n) => n.ref_id);
    assert.ok(hits.includes(said.ref_id) && hits.includes(sam.ref_id), "both found by keyword");

    // A source the Schema says to embed is embedded.
    await createNodeSchema(b, b.schemas, { type: "Transcript", attributes: { text: "string" }, key: "ref_id", title_key: "text", index: ["text"], role: "source", embed: true });
    const t = await b.nodes.write({ type: "Transcript", data: { text: "the zeppelin call" } });
    assert.ok(Array.isArray((await props(t.ref_id))["text_embeddings"]));
  });

  it("an edge type's cardinality one: one live edge per source node", async () => {
    await createNodeSchema(b, b.schemas, { type: "Place", attributes: {}, role: "entity" });
    // Not temporal: a temporal type's edges are `assert`'s alone (temporal.test.ts).
    const lives = await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Place", { cardinality: "one", temporal: false });
    assert.deepEqual(lives.rule, { temporal: false, cardinality: "one" });
    assert.deepEqual((await b.schemas.edgeSchema("LIVES_IN", "Person", "Place"))!.rule, { temporal: false, cardinality: "one" });
    // A new rule of the edge type takes the type's rule.
    assert.deepEqual((await b.schemas.createEdgeSchema("Lingo", "LIVES_IN", "Place")).rule, { temporal: false, cardinality: "one" });

    const [sam, kim] = (await b.nodes.writeMany([person("Sam"), person("Kim")])).map((r) => r.ref_id) as [string, string];
    const [london, paris] = (await b.nodes.writeMany([{ type: "Place", data: { name: "London" } }, { type: "Place", data: { name: "Paris" } }])).map((r) => r.ref_id) as [string, string];
    const first = await b.edges.write({ edge: "LIVES_IN", source_ref_id: sam, target_ref_id: london });
    assert.equal((await b.edges.write({ edge: "LIVES_IN", source_ref_id: sam, target_ref_id: london })).ref_id, first.ref_id, "the same edge again is the one there");
    const snap = await graphSnapshot(b);
    await assert.rejects(b.edges.write({ edge: "LIVES_IN", source_ref_id: sam, target_ref_id: paris }), refused("DUPLICATE_KEY"));
    await assert.rejects(
      b.edges.writeMany([
        { edge: "LIVES_IN", source_ref_id: kim, target_ref_id: london },
        { edge: "LIVES_IN", source_ref_id: kim, target_ref_id: paris },
      ]),
      refused("DUPLICATE_KEY"),
      "two in one write",
    );
    assert.deepEqual(await graphSnapshot(b), snap);
    await b.edges.write({ edge: "LIVES_IN", source_ref_id: kim, target_ref_id: london });
    // A move re-points the one edge; a delete frees the slot.
    const moved = await b.edges.move({ ref_id: sam, edge: "LIVES_IN", direction: "forward", to_ref_id: paris });
    assert.equal(moved.moved, true);
    await b.edges.delete(moved.edge_ref_id);
    await b.edges.write({ edge: "LIVES_IN", source_ref_id: sam, target_ref_id: london });

    // A type whose sources already hold several cannot become one.
    await b.schemas.createEdgeSchema("Person", "VISITED", "Place");
    await b.edges.writeMany([
      { edge: "VISITED", source_ref_id: sam, target_ref_id: london },
      { edge: "VISITED", source_ref_id: sam, target_ref_id: paris },
    ]);
    await assert.rejects(b.schemas.createEdgeSchema("Person", "VISITED", "Place", { cardinality: "one" }), refused("DUPLICATE_KEY", "cardinality"));
    assert.deepEqual((await b.schemas.edgeSchema("VISITED", "Person", "Place"))!.rule, {}, "unchanged");
    await assert.rejects(b.schemas.createEdgeSchema("Person", "VISITED", "Place", { cardinality: "two" as never }), refused("WRONG_TYPE", "cardinality"));
  });
});
