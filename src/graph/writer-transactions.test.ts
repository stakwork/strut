/**
 * The writers on a caller's transaction, the soft delete that keeps its
 * edges, and identity by ref_id — on every test backend.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { GraphBackend } from "./backend.js";
import { EdgeWriter } from "./edge-writer.js";
import type { GraphTx } from "./engine.js";
import { NodeWriter } from "./node-writer.js";
import { seedJarvisOntology } from "./__fixtures__/jarvis-seed.js";
import { SchemaResolver, type NodeSchema } from "./schema-resolver.js";
import { seedStrutDomain } from "./schema-seed.js";
import { edgeCount, rawNode, testBackends } from "./test-util.js";

const KEYED = "Claim";

/** A resolver that keys `Claim` by ref_id: the closed Ladybug registry has
 *  no Schema to mark, so the tests mark it here. */
class RefKeyedResolver extends SchemaResolver {
  override async schema(raw: string, tx?: GraphTx): Promise<NodeSchema | null> {
    const s = await super.schema(raw, tx);
    return s?.type === KEYED ? { ...s, key_spec: "ref_id" } : s;
  }
}

function refKeyed(b: GraphBackend): GraphBackend {
  const schemas = new RefKeyedResolver(b);
  return { ...b, schemas, nodes: new NodeWriter(b, { resolver: schemas }), edges: new EdgeWriter(b, { resolver: schemas }) } as GraphBackend;
}

const claim = (id: string, text = "the deploy pipeline is green") => ({ type: KEYED, data: { id, claim_text: text, name: `claim ${id}` } });

for (const tb of testBackends()) {
  describe(`graph writers on ${tb.name}: transactions, kept edges, ref_id identity`, { skip: tb.skip }, () => {
    let base: GraphBackend;
    let b: GraphBackend;
    let wf: string;
    before(async () => {
      base = await tb.open();
      await tb.wipe(base);
      if (tb.kind === "neo4j") await seedJarvisOntology(base);
      await seedStrutDomain(base);
    });
    after(async () => {
      await tb.close(base);
    });
    beforeEach(async () => {
      await tb.clear(base);
      b = refKeyed(base);
      wf = (await b.nodes.write({ type: "StrutWorkflow", data: { name: "deploy", description: "deploys the pipeline" } })).ref_id;
    });

    // ── Transactions ──────────────────────────────────────────────────────

    it("node and edge writes join the caller's transaction: all land, or none", async () => {
      const wf2 = (await b.nodes.write({ type: "StrutWorkflow", data: { name: "other" } })).ref_id;
      let written: { c: string; e: string } | undefined;
      await assert.rejects(
        b.tx(async (tx) => {
          const [c] = await b.nodes.writeMany([claim("c1")], "create", { tx });
          await b.nodes.update(wf, { set: { description: "changed" } }, { tx });
          const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c!.ref_id, target_ref_id: wf }, tx);
          await b.edges.update({ ref_id: e.ref_id }, { set: { weight: 2 } }, { tx });
          await b.nodes.softDelete(wf2, { tx });
          written = { c: c!.ref_id, e: e.ref_id };
          throw new Error("abort");
        }),
        /abort/,
      );
      assert.ok(written);
      assert.equal(await rawNode(b, written.c), null, "the node rolled back");
      assert.equal((await rawNode(b, wf))!.props["description"], "deploys the pipeline", "the update rolled back");
      assert.equal((await rawNode(b, wf2))!.props["deleted_at"] ?? null, null, "the delete rolled back");

      const done = await b.tx(async (tx) => {
        const c = await b.nodes.write(claim("c1"), "create", { tx });
        const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c.ref_id, target_ref_id: wf }, tx);
        await b.edges.update({ ref_id: e.ref_id }, { set: { weight: 2 } }, { tx });
        return { c: c.ref_id, e: e.ref_id };
      });
      assert.ok(await rawNode(b, done.c));
      assert.equal(await edgeCount(b, "ABOUT"), 1);

      await assert.rejects(
        b.tx(async (tx) => {
          await b.edges.delete(done.e, { tx });
          await b.nodes.deleteNode(done.c, { tx });
          throw new Error("abort");
        }),
        /abort/,
      );
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the edge delete rolled back");
      assert.equal((await rawNode(b, done.c))!.props["deleted_at"] ?? null, null, "the node delete rolled back");
      await b.tx((tx) => b.edges.delete(done.e, { tx }));
      assert.equal(await edgeCount(b, "ABOUT"), 0);
    });

    it("move joins the caller's transaction", async () => {
      const [a, p1, p2] = (
        await b.nodes.writeMany([
          { type: "Concept", data: { name: "child" } },
          { type: "Concept", data: { name: "parent one" } },
          { type: "Concept", data: { name: "parent two" } },
        ])
      ).map((r) => r.ref_id) as [string, string, string];
      await b.edges.write({ edge: "PARENT_OF", source_ref_id: p1, target_ref_id: a });
      await assert.rejects(
        b.tx(async (tx) => {
          const m = await b.edges.move({ ref_id: a, edge: "PARENT_OF", direction: "reverse", to_ref_id: p2 }, { tx });
          assert.equal(m.moved, true);
          throw new Error("abort");
        }),
        /abort/,
      );
      const n = await b.reader.neighbors(a, { edge_types: ["PARENT_OF"], direction: "reverse" });
      assert.deepEqual(n.edges.map((e) => e.source), [p1], "still under its first parent");
    });

    // ── Soft delete ───────────────────────────────────────────────────────

    it("a soft delete keeps the edges and records the reason when asked; the default still takes them", async () => {
      const c = (await b.nodes.write(claim("c1"))).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf });
      assert.deepEqual(await b.nodes.deleteNode(c, { keepEdges: true, reason: "forgotten" }), { edges: 0 });
      const kept = (await rawNode(b, c))!.props;
      assert.ok(kept["deleted_at"]);
      assert.equal(kept["deleted_reason"], "forgotten");
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the edge stays");
      // A second delete keeps the first reason.
      await b.nodes.deleteNode(c, { keepEdges: true, reason: "again" });
      assert.equal((await rawNode(b, c))!.props["deleted_reason"], "forgotten");

      const c2 = (await b.nodes.write(claim("c2"))).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c2, target_ref_id: wf });
      assert.equal((await b.nodes.deleteNode(c2))?.edges, 1, "the default delete takes the node's edges");
      assert.equal(await edgeCount(b, "ABOUT"), 1);
      assert.equal((await rawNode(b, c2))!.props["deleted_reason"] ?? null, null, "no reason given, none stored");

      assert.equal(await b.nodes.softDelete(wf, { reason: "retired" }), true);
      assert.equal((await rawNode(b, wf))!.props["deleted_reason"], "retired");
    });

    it("a node deleted with its edges kept is no one's way in", async () => {
      const c = (await b.nodes.write(claim("c1"))).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf });
      await b.nodes.deleteNode(c, { keepEdges: true });
      assert.equal(await edgeCount(b, "ABOUT"), 1, "kept");
      assert.deepEqual(await b.reader.neighbors(c), { nodes: [], edges: [] }, "from the deleted node: nothing");
      assert.deepEqual((await b.reader.neighbors(wf)).edges, [], "to it: nothing");
      const live = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, wf, "ABOUT", false));
      assert.deepEqual(live?.edges, [], "its edge is not a live edge of the other end");
      const from = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, c, "ABOUT", true));
      assert.deepEqual(from?.edges ?? [], [], "nor of the deleted node");
    });

    it("a restore clears the reason with the delete marker", async () => {
      await b.nodes.softDelete(wf, { reason: "retired" });
      const r = await b.nodes.write({ type: "StrutWorkflow", data: { name: "deploy" } });
      assert.equal(r.outcome, "restored");
      const props = (await rawNode(b, wf))!.props;
      assert.equal(props["deleted_at"] ?? null, null);
      assert.equal(props["deleted_reason"] ?? null, null);
    });

    // ── Identity by ref_id ────────────────────────────────────────────────

    it("a type keyed by ref_id always creates, never brings back a deleted node, and keeps its key on update", async () => {
      const a = await b.nodes.write(claim("same"));
      const c = await b.nodes.write(claim("same"));
      assert.equal(a.outcome, "created");
      assert.equal(c.outcome, "created");
      assert.notEqual(a.ref_id, c.ref_id, "two nodes with the same attributes");
      assert.equal(a.key, `claim-${a.ref_id}`);

      await b.nodes.deleteNode(a.ref_id, { keepEdges: true });
      const d = await b.nodes.write(claim("same"), "upsert");
      assert.equal(d.outcome, "created", "not a restore");
      assert.notEqual(d.ref_id, a.ref_id);
      assert.ok((await rawNode(b, a.ref_id))!.props["deleted_at"], "the deleted one stays deleted");

      const u = await b.nodes.update(c.ref_id, { set: { claim_text: "changed" } });
      assert.deepEqual([u.key, u.rekeyed], [c.key, false]);
    });

    it("a type keyed as before still matches on its attributes", async () => {
      const again = await base.nodes.write({ type: "StrutWorkflow", data: { name: "deploy" } });
      assert.deepEqual([again.ref_id, again.outcome], [wf, "existing"]);
    });
  });
}
