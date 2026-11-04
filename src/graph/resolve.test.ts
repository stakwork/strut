/**
 * `resolveNode` and `graph/resolve` (plans/graph-memory-plan.md step 5): an
 * exact key or identifier match with no model involved, then the name, then
 * a node's `alt_names`, and candidates when a name is ambiguous or finds
 * nothing — read only in the namespaces given. On a Ladybug file; Neo4j
 * refuses it, which the last suite checks.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { GraphValidationError, type Embedder } from "./node-writer.js";
import { ResolveError, resolveNode } from "./resolve.js";
import { GraphReadError } from "./search.js";
import { setNodeProps, testBackends } from "./test-util.js";
import graphResolve from "../steps/lib/graph/resolve.js";
import { accessedNodesOf } from "../core.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j")!;

/** An embedder that counts what it is asked to embed. */
function countingEmbedder(): Embedder & { calls: number } {
  const e = {
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => Array.from({ length: 384 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7 + 0.01));
    },
  };
  return e;
}

const person = async (b: LadybugBackend, data: Record<string, unknown>, namespace?: string) => (await b.nodes.write({ type: "Person", data }, "create", namespace ? { namespace } : {})).ref_id;

describe("resolve: an exact match involves no model", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  const embedder = countingEmbedder();
  before(async () => {
    b = (await lb.open({ embedder })) as LadybugBackend;
  });
  after(() => lb.close(b));

  it("an exact key match, given or composed from data, involves no model", async () => {
    const word = await b.nodes.write({ type: "Concept", data: { name: "Kubernetes" } });
    embedder.calls = 0;
    const byKey = await resolveNode(b, { type: "concept", key: word.key });
    assert.equal(byKey.match?.ref_id, word.ref_id);
    assert.equal(byKey.match?.matched_by, "key");
    assert.equal(byKey.node_type, "Concept");
    const byData = await resolveNode(b, { type: "Concept", data: { name: "kubernetes" } });
    assert.equal(byData.match?.ref_id, word.ref_id);
    assert.equal(byData.match?.matched_by, "key");
    assert.equal(embedder.calls, 0, "no embedding for an exact match");
  });

  it("an identifier match wins over the name, and involves no model", async () => {
    const ada = await person(b, { name: "Ada Lovelace", email: "ada@example.com" });
    await person(b, { name: "Ada B" });
    embedder.calls = 0;
    const r = await resolveNode(b, { type: "Person", data: { name: "Ada B", email: "ada@example.com" } });
    assert.equal(r.match?.ref_id, ada);
    assert.equal(r.match?.matched_by, "identifier");
    assert.deepEqual(r.match?.identifiers, { email: "ada@example.com" });
    assert.equal(r.ambiguous, false);
    assert.equal(embedder.calls, 0);
  });

});

describe("resolve on a ladybug file (plans/graph-memory-plan.md step 5)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
  });
  after(() => lb.close(b));
  beforeEach(() => lb.clear(b));

  it("a Person is keyed by its ref_id, so its name is tried next, case- and space-blind", async () => {
    const grace = await person(b, { name: "Grace Hopper", description: "Admiral" });
    const r = await resolveNode(b, { type: "Person", name: "  grace   HOPPER " });
    assert.equal(r.match?.ref_id, grace);
    assert.equal(r.match?.matched_by, "name");
    assert.equal(r.match?.title, "Grace Hopper");
    assert.equal(r.match?.description, "Admiral");
    assert.equal(r.match?.namespace, "private");
  });

  it("two people with the same name stay two: ambiguous, both candidates, none chosen", async () => {
    const a = await person(b, { name: "Sam Lee", email: "sam@a.com" });
    const c = await person(b, { name: "Sam Lee", email: "sam@c.com" });
    const r = await resolveNode(b, { type: "Person", name: "Sam Lee" });
    assert.equal(r.match, null);
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.candidates.map((n) => n.ref_id).sort(), [a, c].sort());
    assert.ok(r.candidates.every((n) => n.matched_by === "name" && n.identifiers?.["email"]));
    // An identifier tells them apart.
    assert.equal((await resolveNode(b, { type: "Person", data: { name: "Sam Lee", email: "sam@c.com" } })).match?.ref_id, c);
  });

  it("an alias: the name among a node's alt_names, or an alias as its title", async () => {
    const bob = await person(b, { name: "Robert Smith", alt_names: ["Bobby", "Rob"] });
    const byAlt = await resolveNode(b, { type: "Person", name: "bobby" });
    assert.equal(byAlt.match?.ref_id, bob);
    assert.equal(byAlt.match?.matched_by, "alias");
    assert.deepEqual(byAlt.match?.alt_names, ["Bobby", "Rob"]);
    const byAliasInput = await resolveNode(b, { type: "Person", name: "R. Smith", aliases: ["Robert Smith"] });
    assert.equal(byAliasInput.match?.ref_id, bob);
    assert.equal(byAliasInput.match?.matched_by, "alias");
    const concept = await b.nodes.write({ type: "Concept", data: { name: "Graph memory", alt_names: ["memory graph"] } });
    assert.equal((await resolveNode(b, { type: "Concept", name: "Memory Graph" })).match?.ref_id, concept.ref_id);
  });

  it("nothing exact: ranked candidates for the caller to choose from, or none", async () => {
    const ada = await person(b, { name: "Ada Lovelace" });
    await person(b, { name: "Charles Babbage" });
    const r = await resolveNode(b, { type: "Person", name: "Ada" });
    assert.equal(r.match, null);
    assert.equal(r.ambiguous, false);
    assert.equal(r.candidates[0]?.ref_id, ada);
    assert.equal(r.candidates[0]?.matched_by, "search");
    assert.ok(!r.candidates.some((n) => n.title === "Charles Babbage"));
    assert.deepEqual((await resolveNode(b, { type: "Person", name: "Zebedee" })).candidates, []);
    assert.deepEqual(await resolveNode(b, { type: "Person" }), { node_type: "Person", namespaces: ["private"], match: null, ambiguous: false, candidates: [] });
  });

  it("reads only the namespaces given, default the writer's; one key in two is ambiguous", async () => {
    const shared = await person(b, { name: "Linus" }, "shared");
    assert.equal((await resolveNode(b, { type: "Person", name: "Linus" })).match, null);
    assert.deepEqual((await resolveNode(b, { type: "Person", name: "Linus" })).candidates, [], "a candidate outside the scope is dropped");
    const r = await resolveNode(b, { type: "Person", name: "Linus", namespaces: ["shared"] });
    assert.equal(r.match?.ref_id, shared);
    assert.equal(r.match?.namespace, "shared");
    assert.deepEqual(r.namespaces, ["shared"]);

    const mine = await b.nodes.write({ type: "Lingo", data: { name: "strut" } });
    const theirs = await b.nodes.write({ type: "Lingo", data: { name: "strut" } }, "create", { namespace: "shared" });
    assert.equal((await resolveNode(b, { type: "Lingo", data: { name: "strut" }, namespaces: ["default"] })).match?.ref_id, mine.ref_id, "default is the backend's own");
    const both = await resolveNode(b, { type: "Lingo", data: { name: "strut" }, namespaces: ["private", "shared"] });
    assert.equal(both.ambiguous, true);
    assert.deepEqual(both.candidates.map((n) => n.namespace).sort(), ["private", "shared"]);
    assert.deepEqual(both.candidates.map((n) => n.ref_id).sort(), [mine.ref_id, theirs.ref_id].sort());
  });

  it("never resolves a deleted node, or a node of another type", async () => {
    const gone = await person(b, { name: "Old Friend" });
    await setNodeProps(b, gone, { deleted_at: 1 });
    await b.nodes.write({ type: "Concept", data: { name: "Old Friend" } });
    const r = await resolveNode(b, { type: "Person", name: "Old Friend" });
    assert.equal(r.match, null);
    assert.deepEqual(r.candidates, []);
  });

  it("refuses an unknown type, a Schema or EdgeText row, and a malformed namespace", async () => {
    await assert.rejects(resolveNode(b, { type: "Nope", name: "x" }), (e) => e instanceof GraphValidationError && e.code === "UNKNOWN_TYPE");
    for (const type of ["EdgeText", "Schema"]) {
      await assert.rejects(resolveNode(b, { type, name: "x" }), (e) => e instanceof GraphValidationError && (e.code === "WRONG_TYPE" || e.code === "UNKNOWN_TYPE"), type);
    }
    await assert.rejects(resolveNode(b, { type: "Person", name: "x", namespaces: ["Not A Name"] }), (e) => e instanceof GraphReadError && e.code === "INVALID_NAMESPACE");
  });

  it("graph/resolve is the step over it: the match is a node it read, an error is said back", async () => {
    const ada = await person(b, { name: "Ada Lovelace", email: "ada@example.com" });
    const ctx = { services: { graph: b } } as never;
    const r = (await graphResolve.run({ node_type: "Person", node_data: { email: "ada@example.com" } } as never, ctx)) as Record<string, any>;
    assert.equal(r["match"].ref_id, ada);
    assert.equal(r["match"].matched_by, "identifier");
    assert.deepEqual(accessedNodesOf(r), [{ ref_id: ada, node_type: "Person", name: "Ada Lovelace" }]);
    assert.match(String(await graphResolve.run({ node_type: "Nope", name: "x" } as never, ctx)), /^graph\/resolve failed — UNKNOWN_TYPE: /);
  });
});

describe("resolve on neo4j: not on this backend", { skip: neo4j.skip }, () => {
  it("is refused with a clear error, and writes nothing", async () => {
    const b = await neo4j.open();
    try {
      await assert.rejects(resolveNode(b, { type: "Person", name: "Ada" }), (e) => e instanceof ResolveError && /not on this backend \(neo4j\)/.test(e.message));
      assert.match(String(await graphResolve.run({ node_type: "Person", name: "Ada" } as never, { services: { graph: b } } as never)), /^graph\/resolve failed: resolve is not on this backend/);
    } finally {
      await neo4j.close(b);
    }
  });
});
