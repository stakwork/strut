/**
 * The writer gaps memory needs (plans/memory-in-workspace-graph.md, PR B):
 * caller transactions, the edge-keeping soft delete, identity by ref_id,
 * the managed-type guard, and the read filter. Nothing in the registry is
 * managed yet, so a test marks a type itself: `Claim` stands in for a
 * memory type — managed by `test-memory` and keyed by `ref_id` — through a
 * resolver that adds the marks (`managing`). The resolver's own sources
 * (a Schema's `managed_by`, the registry) are covered on their own below,
 * and on Neo4j with a real Schema.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBackend } from "./backend.js";
import { EdgeWriter } from "./edge-writer.js";
import type { GraphTx } from "./engine.js";
import { ManagedReadFilter, graphView, rawGraphOf, type GraphView } from "./managed.js";
import { GraphValidationError, NodeWriter, mintManagerKey, refuseManaged as refuse, type ManagerKey } from "./node-writer.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { readQuery } from "./query.js";
import { SchemaResolver, type NodeSchema } from "./schema-resolver.js";
import { seedStrutDomain } from "./schema-seed.js";
import { edgeCount, rawNode, testBackends } from "./test-util.js";
import type { SchemaSource } from "./engine.js";
import { graphCtx } from "../steps/lib/graph/_shared.js";
import type { StepContext } from "../core.js";
import { buildRegistry } from "../steps/registry.js";
import { runWalk } from "../steps/lib/graph/walk.js";
import { buildTools } from "../ai/tools.js";
import { MemoryRunStore } from "../store.js";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { hostConfigFromEnv } from "../server.js";

const MANAGER = "test-memory";
const MANAGED = "Claim";
/** The manager's key, as its host would mint it where it wires its steps. */
const KEY = mintManagerKey(MANAGER);

/** A resolver that adds schema marks to the types it resolves. */
class MarkingResolver extends SchemaResolver {
  constructor(
    engine: GraphBackend,
    private readonly marks: Record<string, Partial<NodeSchema>>,
  ) {
    super(engine);
  }
  override async schema(raw: string, tx?: GraphTx): Promise<NodeSchema | null> {
    const s = await super.schema(raw, tx);
    const mark = s ? this.marks[s.type] : undefined;
    return s && mark ? { ...s, ...mark } : s;
  }
  override async managedTypes(): Promise<ReadonlyMap<string, string>> {
    return new Map(Object.entries(this.marks).flatMap(([t, m]) => (m.managed_by ? [[t, m.managed_by] as [string, string]] : [])));
  }
}

/** The backend with `marks` on its schemas, its writers and resolver rebuilt. */
function managing(b: GraphBackend, marks: Record<string, Partial<NodeSchema>> = { [MANAGED]: { managed_by: MANAGER, node_key: "ref_id" } }): GraphBackend {
  const schemas = new MarkingResolver(b, marks);
  return { ...b, schemas, nodes: new NodeWriter(b, { resolver: schemas }), edges: new EdgeWriter(b, { resolver: schemas }) } as GraphBackend;
}

const code = (e: unknown) => (e instanceof GraphValidationError ? e.code : undefined);
const claim = (id: string, text = "the deploy pipeline is green") => ({ type: MANAGED, data: { id, claim_text: text, name: `claim ${id}` } });

describe("the resolver's managed types, from its own sources", () => {
  /** A Schema source with no database behind it: `rows` are the Schemas. */
  const source = (rows: Record<string, Record<string, unknown>>, extra: Partial<SchemaSource> = {}) =>
    ({
      schemaRow: async (t: string) => (rows[t] ? { type: t, props: rows[t]! } : null),
      labelLike: async () => null,
      ancestors: async (t: string) => (rows[t]?.["parent"] ? { chain: [String(rows[t]!["parent"])], rows: [rows[String(rows[t]!["parent"])]!] } : { chain: [], rows: [] }),
      hidden: async () => ({ domains: [], types: [] }),
      findEdgeSchema: async () => null,
      ...extra,
    }) as unknown as SchemaSource;
  const engineOf = (schemaSource: SchemaSource) => ({ kind: "neo4j", namespace: "default", schemaSource, query: async () => [], tx: async () => undefined }) as unknown as GraphBackend;

  it("a Schema's own managed_by: read onto its schema, not inherited, never an attribute", async () => {
    const rows = {
      Person: { type: "Person", managed_by: "memory", name: "string", node_key: "ref_id" },
      Contact: { type: "Contact", parent: "Person", email: "string" },
    };
    const calls: string[] = [];
    const r = new SchemaResolver(engineOf(source(rows, { managedTypes: async () => (calls.push("managed"), new Map([["Person", "memory"]])) })));
    const person = await r.schema("Person");
    assert.equal(person?.managed_by, "memory");
    assert.equal(person?.node_key, "ref_id");
    assert.ok(!("managed_by" in person!.attributes), "a core property, not an attribute");
    assert.equal((await r.schema("Contact"))?.managed_by, undefined, "a subtype is not managed by its parent's manager");
    assert.deepEqual(await r.managedTypes(), new Map([["Person", "memory"]]));
    await r.managedTypes();
    assert.deepEqual(calls, ["managed"], "cached");
    r.invalidate();
    await r.managedTypes();
    assert.equal(calls.length, 2, "invalidate drops it");
  });

  it("a closed registry answers from its own types", async () => {
    const types = [{ type: "Person", managed_by: "memory" }, { type: "Concept" }] as unknown as NodeSchema[];
    const registry = { schema: (t: string) => types.find((x) => x.type === t) ?? null, types: () => types, edge: () => null };
    const r = new SchemaResolver(engineOf(source({}, { registry } as Partial<SchemaSource>)));
    assert.deepEqual(await r.managedTypes(), new Map([["Person", "memory"]]));
  });
});

describe("manager keys", () => {
  it("only a minted key names a manager: a string or a lookalike is refused", () => {
    const schema = { type: MANAGED, managed_by: MANAGER };
    assert.throws(() => refuse(schema, { manager: KEY } as ManagerKey), (e) => code(e) === "MANAGED");
    assert.throws(() => refuse(schema, MANAGER as unknown as ManagerKey), (e) => code(e) === "MANAGED");
    assert.throws(() => refuse(schema, mintManagerKey("someone-else")), (e) => code(e) === "MANAGED");
    refuse(schema, KEY);
    assert.ok(Object.isFrozen(KEY));
  });
});

describe("memoryReaders in STRUT_HOST_CONFIG", () => {
  it("is a list of workflow names; anything else fails the boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-host-"));
    try {
      const file = join(dir, "host.json");
      await writeFile(file, JSON.stringify({ memoryReaders: ["orchestrator", "peel-automation-run"] }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { memoryReaders: ["orchestrator", "peel-automation-run"] });
      for (const bad of ["orchestrator", [""], [1], { workflows: ["orchestrator"] }]) {
        await writeFile(file, JSON.stringify({ memoryReaders: bad }));
        assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"memoryReaders" must be/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

for (const tb of testBackends()) {
  describe(`graph writer gaps on ${tb.name}`, { skip: tb.skip }, () => {
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
      b = managing(base);
      wf = (await b.nodes.write({ type: "StrutWorkflow", data: { name: "deploy", description: "deploys the pipeline" } })).ref_id;
    });

    // ── Transactions ──────────────────────────────────────────────────────

    it("node and edge writes join the caller's transaction: all land, or none", async () => {
      const wf2 = (await b.nodes.write({ type: "StrutWorkflow", data: { name: "other" } })).ref_id;
      let written: { c: string; e: string } | undefined;
      await assert.rejects(
        b.tx(async (tx) => {
          const [c] = await b.nodes.writeMany([claim("c1")], "create", { tx, manager: KEY });
          await b.nodes.update(wf, { set: { description: "changed" } }, { tx });
          const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c!.ref_id, target_ref_id: wf }, { tx, manager: KEY });
          await b.edges.update({ ref_id: e.ref_id }, { set: { weight: 2 } }, { tx, manager: KEY });
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
        const c = await b.nodes.write(claim("c1"), "create", { tx, manager: KEY });
        const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c.ref_id, target_ref_id: wf }, { tx, manager: KEY });
        await b.edges.update({ ref_id: e.ref_id }, { set: { weight: 2 } }, { tx, manager: KEY });
        return { c: c.ref_id, e: e.ref_id };
      });
      assert.ok(await rawNode(b, done.c));
      assert.equal(await edgeCount(b, "ABOUT"), 1);

      await assert.rejects(
        b.tx(async (tx) => {
          await b.edges.delete(done.e, { tx, manager: KEY });
          throw new Error("abort");
        }),
        /abort/,
      );
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the edge delete rolled back");
      await b.tx((tx) => b.edges.delete(done.e, { tx, manager: KEY }));
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

    it("softDelete keeps the edges and records the reason when asked; the default still takes them", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: KEY });
      assert.equal(await b.nodes.softDelete(c, { manager: KEY, keepEdges: true, reason: "forgotten" }), true);
      const kept = (await rawNode(b, c))!.props;
      assert.ok(kept["deleted_at"]);
      assert.equal(kept["deleted_reason"], "forgotten");
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the edge stays");
      // A second delete keeps the first reason.
      await b.nodes.softDelete(c, { manager: KEY, keepEdges: true, reason: "again" });
      assert.equal((await rawNode(b, c))!.props["deleted_reason"], "forgotten");

      const c2 = (await b.nodes.write(claim("c2"), "create", { manager: KEY })).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c2, target_ref_id: wf }, { manager: KEY });
      assert.equal(await b.nodes.softDelete(c2, { manager: KEY }), true);
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the default delete takes the node's edges");
      assert.equal((await rawNode(b, c2))!.props["deleted_reason"] ?? null, null, "no reason given, none stored");
    });

    it("keepEdges is for a manager's own nodes, and a node deleted that way is no one's way in", async () => {
      await assert.rejects(b.nodes.softDelete(wf, { keepEdges: true }), (e) => code(e) === "MANAGED", "no key, no kept edges");
      await assert.rejects(b.nodes.softDelete(wf, { keepEdges: true, manager: { manager: MANAGER } as ManagerKey }), (e) => code(e) === "MANAGED");
      assert.equal((await rawNode(b, wf))!.props["deleted_at"] ?? null, null);

      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: KEY });
      await b.nodes.softDelete(c, { manager: KEY, keepEdges: true });
      assert.equal(await edgeCount(b, "ABOUT"), 1, "kept");
      assert.deepEqual(await b.reader.neighbors(c), { nodes: [], edges: [] }, "from the deleted node: nothing");
      assert.deepEqual((await b.reader.neighbors(wf)).edges, [], "to it: nothing");
      const live = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, wf, "ABOUT", false));
      assert.deepEqual(live?.edges, [], "its edge is not a live edge of the other end");
      const from = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, c, "ABOUT", true));
      assert.deepEqual(from?.edges ?? [], [], "nor of the deleted node");
    });

    it("a refused edge update or delete changes nothing, even on a transaction the caller commits", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
      const e = (await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf, weight: 1 }, { manager: KEY })).ref_id;
      await b.tx(async (tx) => {
        await assert.rejects(b.edges.update({ ref_id: e }, { set: { weight: 9 } }, { tx }), (x) => code(x) === "MANAGED");
        await assert.rejects(b.edges.delete(e, { tx }), (x) => code(x) === "MANAGED");
      });
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the delete took nothing");
      const [edge] = (await b.reader.neighbors(wf)).edges;
      assert.equal(edge?.weight, 1, "the update set nothing");
    });

    it("move refuses a managed end before its errors name any neighbour", async () => {
      const [c1, c2] = (await b.nodes.writeMany([claim("c1"), claim("c2")], "create", { manager: KEY })).map((r) => r.ref_id) as [string, string];
      for (const c of [c1, c2]) await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: KEY });
      const other = (await b.nodes.write({ type: "StrutWorkflow", data: { name: "other" } })).ref_id;
      await assert.rejects(b.edges.move({ ref_id: wf, edge: "ABOUT", direction: "reverse", to_ref_id: other }), (e) => {
        assert.equal(code(e), "MANAGED");
        assert.ok(![c1, c2].some((c) => String((e as Error).message).includes(c)), String((e as Error).message));
        return true;
      });
      await assert.rejects(b.edges.move({ ref_id: c1, edge: "ABOUT", direction: "forward", to_ref_id: other }), (e) => code(e) === "MANAGED");
    });

    it("softDelete with a manager matches only that manager's nodes; without one, only Strut's own", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
      assert.equal(await b.nodes.softDelete(c), false, "a managed node is not one of Strut's own");
      assert.equal(await b.nodes.softDelete(c, { manager: mintManagerKey("someone-else") }), false);
      assert.equal(await b.nodes.softDelete(c, { manager: { manager: MANAGER } as ManagerKey }), false, "a lookalike key");
      assert.equal(await b.nodes.softDelete(wf, { manager: KEY }), false, "a Strut node is not the manager's");
      assert.equal((await rawNode(b, c))!.props["deleted_at"] ?? null, null);
      assert.equal(await b.nodes.softDelete(wf, { reason: "retired" }), true);
      assert.equal((await rawNode(b, wf))!.props["deleted_reason"], "retired");
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
      const a = await b.nodes.write(claim("same"), "create", { manager: KEY });
      const c = await b.nodes.write(claim("same"), "create", { manager: KEY });
      assert.equal(a.outcome, "created");
      assert.equal(c.outcome, "created");
      assert.notEqual(a.ref_id, c.ref_id, "two nodes with the same attributes");
      assert.equal(a.node_key, `claim-${a.ref_id}`);

      await b.nodes.softDelete(a.ref_id, { manager: KEY, keepEdges: true });
      const d = await b.nodes.write(claim("same"), "upsert", { manager: KEY });
      assert.equal(d.outcome, "created", "not a restore");
      assert.notEqual(d.ref_id, a.ref_id);
      assert.ok((await rawNode(b, a.ref_id))!.props["deleted_at"], "the deleted one stays deleted");

      const u = await b.nodes.update(c.ref_id, { set: { claim_text: "changed" } }, { manager: KEY });
      assert.deepEqual([u.node_key, u.rekeyed], [c.node_key, false]);
    });

    // ── The managed-type guard ────────────────────────────────────────────

    it("the writers refuse a managed type unless the caller names its manager", async () => {
      await assert.rejects(b.nodes.write(claim("c1")), (e) => code(e) === "MANAGED");
      await assert.rejects(b.nodes.write(claim("c1"), "create", { manager: mintManagerKey("someone-else") }), (e) => code(e) === "MANAGED");
      await assert.rejects(b.nodes.write(claim("c1"), "create", { manager: { manager: MANAGER } as ManagerKey }), (e) => code(e) === "MANAGED", "a lookalike key");
      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;

      await assert.rejects(b.nodes.update(c, { set: { claim_text: "x" } }), (e) => code(e) === "MANAGED");
      await assert.rejects(b.nodes.deleteNode(c), (e) => code(e) === "MANAGED");
      await assert.rejects(b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }), (e) => code(e) === "MANAGED");
      const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: KEY });
      await assert.rejects(b.edges.update({ ref_id: e.ref_id }, { set: { weight: 3 } }), (x) => code(x) === "MANAGED");
      await assert.rejects(b.edges.delete(e.ref_id), (x) => code(x) === "MANAGED");
      await assert.rejects(b.edges.delete({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }), (x) => code(x) === "MANAGED");
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the refused delete took nothing");
      const stored = await rawNode(b, c);
      assert.equal(stored!.props["claim_text"], "the deploy pipeline is green");
      assert.equal(stored!.props["deleted_at"] ?? null, null);

      // Unmanaged types are untouched by the guard, a manager named or not.
      await b.nodes.update(wf, { set: { description: "fine" } }, { manager: KEY });
      await b.nodes.update(wf, { set: { description: "fine too" } });
    });

    it("a real Schema's managed_by, on Neo4j: the stock resolver lists it, the writers refuse it, the filter hides it", { skip: tb.kind !== "neo4j" && "the Ladybug registry is closed: no Schema to mark" }, async () => {
      const mark = (m: string | null) => base.tx((tx) => tx.run(`MATCH (s:Schema {type: $t}) SET s.managed_by = $m`, { t: MANAGED, m }));
      await mark(MANAGER);
      base.schemas.invalidate();
      try {
        assert.equal((await base.schemas.managedTypes()).get(MANAGED), MANAGER);
        assert.equal((await base.schemas.schema(MANAGED))?.managed_by, MANAGER);
        await assert.rejects(base.nodes.write(claim("c1")), (e) => code(e) === "MANAGED");
        const c = (await base.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
        assert.equal(await new ManagedReadFilter(base.reader, base.schemas).getNode(c), null);
        assert.equal((await base.reader.getNode(c))?.ref_id, c);
      } finally {
        await mark(null);
        base.schemas.invalidate();
      }
    });

    it("nothing is managed without a mark: the stock backend writes the stand-in type as before", async () => {
      const r = await base.nodes.write(claim("c1"));
      assert.equal(r.outcome, "created");
      assert.equal(r.node_key, "claim-c1");
      assert.deepEqual(await base.schemas.managedTypes(), new Map());
    });

    // ── The graph/* steps ─────────────────────────────────────────────────

    describe("steps", () => {
      type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };
      let registry: Record<string, unknown>;
      let c: string;
      let e: string;
      before(async () => {
        registry = (await buildRegistry()).registry as Record<string, unknown>;
      });
      beforeEach(async () => {
        c = (await b.nodes.write(claim("c1", "the release train leaves on friday"), "create", { manager: KEY })).ref_id;
        e = (await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: KEY })).ref_id;
      });
      type Who = { workflow?: string; agentTool?: boolean; frame?: { workflow: string; sealed?: boolean }; aiAuthored?: boolean };
      const ctxFor = (who: Who = {}) =>
        ({ runId: "r", path: `${who.workflow ?? "job"}/agent`, scope: {}, input: undefined, emit: async () => {}, services: { graph: b, memoryReaders: ["orchestrator", "assistant-recall"] }, ...who }) as unknown as StepContext;
      const run = (type: string, input: unknown, ctx = ctxFor({ workflow: "job", agentTool: true })) => {
        const def = registry[type] as StepDef;
        return def.run(def.input.parse(input), ctx);
      };
      /** The person's assistant: a listed, sealed workflow's agent. */
      const assistant = () => ctxFor({ workflow: "orchestrator", agentTool: true, frame: { workflow: "orchestrator", sealed: true } });

      it("every graph write step refuses a managed type: MANAGED to the assistant, not found to anyone else", async () => {
        // create-batch-triplet reports each item's error in its result.
        const text = (out: unknown) => (typeof out === "string" ? out : (out as { succeeded?: number })?.succeeded === 0 ? JSON.stringify(out) : "");
        const tries: Array<[string, unknown]> = [
          ["graph/create-node", { node_type: MANAGED, node_data: { id: "c9", claim_text: "x" } }],
          ["graph/edit-node", { ref_id: c, node_data: { claim_text: "x" } }],
          ["graph/delete-node", { ref_id: c }],
          ["graph/create-triplet", { source_ref_id: c, target_ref_id: wf, edge_type: "ABOUT" }],
          ["graph/create-triplet", { source_type: MANAGED, source_data: { id: "c9", claim_text: "x" }, target_ref_id: wf, edge_type: "ABOUT" }],
          ["graph/create-batch-triplet", { triplets: [{ source_ref_id: c, target_ref_id: wf, edge_type: "ABOUT" }] }],
          ["graph/edit-edge", { edge_ref_id: e, edge_data: { weight: 3 } }],
          ["graph/delete-edge", { edge_ref_id: e }],
          ["graph/move-node", { ref_id: c, edge_type: "ABOUT", direction: "forward", to_ref_id: wf }],
        ];
        // Even the assistant's tool calls: reading memory is allowed there, writing it through the generic steps never is.
        for (const [type, input] of tries) {
          const out = text(await run(type, input, assistant()));
          assert.match(out, /MANAGED/, `${type} ${JSON.stringify(input)}`);
        }
        // Anyone else learns nothing: no MANAGED, no manager, no type.
        for (const [type, input] of tries) {
          const out = text(await run(type, input, ctxFor({ workflow: "job", agentTool: true })));
          assert.match(out, /NOT_FOUND|not found/, `${type} ${JSON.stringify(input)}: ${out}`);
          assert.doesNotMatch(out, /MANAGED|managed by|test-memory/, `${type}: ${out}`);
        }
        assert.equal(await edgeCount(b, "ABOUT"), 1);
        assert.equal((await rawNode(b, c))!.props["deleted_at"] ?? null, null);
      });

      it("a managed node is invisible to a job's graph tools, and visible to an allowed workflow's agent", async () => {
        const sealed = { workflow: "orchestrator", sealed: true };
        const hiddenFrom = [
          ctxFor({ workflow: "job", agentTool: true }),
          ctxFor({ workflow: "orchestrator", frame: sealed }), // the workflow's own step, not its agent
          ctxFor({ agentTool: true, workflow: "builder" }),
          ctxFor({ workflow: "orchestrator", agentTool: true }), // no frame: not known to be sealed
          ctxFor({ workflow: "orchestrator", agentTool: true, frame: { workflow: "orchestrator" } }), // unsealed: republishable
          ctxFor({ workflow: "orchestrator", agentTool: true, frame: sealed, aiAuthored: true }), // the AI's
          ctxFor({ workflow: "orchestrator", agentTool: true, frame: { workflow: "orchestrator/helper", sealed: true } }), // a subflow nobody listed
        ];
        for (const ctx of hiddenFrom) {
          assert.equal(await run("graph/graph-get", { ref_id: c }, ctx), `node not found: ${c}`);
          const batched = await run("graph/graph-get-batched", { ref_ids: [c, wf] }, ctx);
          assert.deepEqual(batched.nodes.map((n: any) => n.error ? "error" : n.ref_id), ["error", wf]);
          const search = await run("graph/graph-search", { q: "release train friday" }, ctx);
          assert.ok(!JSON.stringify(search).includes(c), "search leaves it out");
          const typed = await run("graph/graph-search", { q: "release train friday", type: MANAGED }, ctx);
          assert.ok(!JSON.stringify(typed).includes(c), "even asked for by type");
          const found = await run("graph/find", { node_type: MANAGED }, ctx);
          assert.match(String(found), /unknown node type/);
          // Raw Cypher is refused outright: `RETURN n.claim_text` carries no type to filter by.
          const q = tb.kind === "ladybug" ? `MATCH (n:Node {node_type: '${MANAGED}'}) RETURN n.claim_text AS t` : `MATCH (n:${MANAGED}) RETURN n.claim_text AS t`;
          await assert.rejects(run("graph/query", { cypher: q }, ctx), /raw graph queries are off/);
          await assert.rejects(run("graph/query", { cypher: "RETURN 1 AS one" }, ctx), /raw graph queries are off/, "any query, while something is managed");
          const ontology = JSON.stringify(await run("graph/get-ontology", {}, ctx));
          assert.ok(!ontology.includes(`"${MANAGED}"`), "the ontology leaves the type out");
          assert.match(String(await run("graph/get-ontology-type", { type: MANAGED }, ctx)), /unknown type/);
          const got = await run("graph/graph-get", { ref_id: wf }, ctx);
          assert.deepEqual(got.edges, {}, "edges to it are not counted");
        }

        const ctx = assistant();
        assert.equal((await run("graph/graph-get", { ref_id: c }, ctx)).ref_id, c);
        const search = await run("graph/graph-search", { q: "release train friday" }, ctx);
        assert.ok(JSON.stringify(search).includes(c));
        assert.equal((await run("graph/find", { node_type: MANAGED }, ctx)).returned, 1);
        const q = tb.kind === "ladybug" ? `MATCH (n:Node {node_type: '${MANAGED}'}) RETURN n.claim_text AS t` : `MATCH (n:${MANAGED}) RETURN n.claim_text AS t`;
        assert.equal((await run("graph/query", { cypher: q }, ctx)).rowCount, 1);
        assert.ok(JSON.stringify(await run("graph/get-ontology", {}, ctx)).includes(`"${MANAGED}"`));
        // A listed subflow of the assistant, sealed too, reads as it does.
        const sub = ctxFor({ workflow: "orchestrator", agentTool: true, frame: { workflow: "assistant-recall", sealed: true } });
        assert.equal((await run("graph/graph-get", { ref_id: c }, sub)).ref_id, c);
        assert.deepEqual((await run("graph/graph-get", { ref_id: wf }, ctx)).edges, { "<-ABOUT": 1 });
      });

      it("neighbors and walk do not cross into a managed node", async () => {
        const job = ctxFor({ workflow: "job", agentTool: true });
        assert.deepEqual(await run("graph/graph-neighbors", { ref_id: wf }, job), []);
        assert.deepEqual(await run("graph/graph-neighbors", { ref_id: c }, job), [], "nothing from inside one");
        const seen = await run("graph/graph-neighbors", { ref_id: wf }, assistant());
        assert.ok(Array.isArray(seen), JSON.stringify(seen));
        assert.deepEqual(seen.map((n: any) => n.ref_id), [c]);

        const reader = new ManagedReadFilter(b.reader, b.schemas);
        const expandAll = async ({ questions }: any) => ({
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, q]: [string, any]) => [
              id,
              q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none" } : { type: "boolean", probability: id === "sufficient" ? 0 : 0.9 },
            ]),
          ),
          usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        const walked = await runWalk({ goal: "what is said about deploy?", start: [wf], maxHops: 4, maxNodes: 10, threshold: 0.5 } as any, { reader, evaluate: expandAll as any });
        assert.deepEqual(walked.nodes.map((n) => n.ref_id), [wf]);
        const open = await runWalk({ goal: "what is said about deploy?", start: [wf], maxHops: 4, maxNodes: 10, threshold: 0.5 } as any, { reader: b.reader, evaluate: expandAll as any });
        assert.ok(open.nodes.some((n) => n.ref_id === c), "an unfiltered reader does reach it");
      });

      it("the chat builder's graph_query and graph_get leave it out", async () => {
        const tools = buildTools({
          workspace: {} as any,
          registry: registry as any,
          store: new MemoryRunStore(),
          getRegistry: async () => registry as any,
          services: { graph: b, memoryReaders: ["orchestrator"] } as any,
          graph: b,
        }) as any;
        const q = tb.kind === "ladybug" ? `MATCH (n:Node) RETURN n.ref_id AS id` : `MATCH (n:Data_Bank) RETURN n.ref_id AS id`;
        const out = await tools.graph_query.execute({ cypher: q, maxRows: 100 });
        assert.match(String(out.error), /raw graph queries are off/);
        assert.equal(await tools.graph_get.execute({ ref_id: c }), `node not found: ${c}`);
        assert.equal((await tools.graph_get.execute({ ref_id: wf })).ref_id, wf);
        // The same read, with nothing hidden, sees it.
        assert.ok(JSON.stringify((await readQuery(b, q)).rows).includes(c));
      });
    });

    it("search `linked` to a managed type finds nothing", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: KEY });
      const p = { q: "deploy", types: ["StrutWorkflow"], linked: [`ABOUT<${MANAGED}`] };
      assert.ok((await b.reader.search(p)).nodes.some((n) => n.ref_id === wf), "unfiltered, the link is found");
      assert.deepEqual((await new ManagedReadFilter(b.reader, b.schemas).search(p)).nodes, []);
    });

    it("/graph/* leaves it out, and a step's ctx.services.graph is the filtered view", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: KEY })).ref_id;
      const dir = await mkdtemp(join(tmpdir(), "strut-managed-"));
      try {
        // A pass that has counted the managed type, to see it left out.
        const counts = { total: 1, embedded: 1, pending: 0 };
        const embeddings = {
          status: () => ({ enabled: true, sweep: { n: 1, startedAt: 1, finishedAt: null, phase: "embed", type: MANAGED, cursor: c }, current: { [MANAGED]: counts, StrutWorkflow: counts }, last: { [MANAGED]: counts }, skipped: [{ type: MANAGED, reason: "no-index" }], newcomers: { since: null, embedded: 0 }, lastError: null, ticks: 1 }),
        };
        const graph = { ...b, embeddings } as unknown as GraphBackend;
        const strut = await createStrut({ workspace: new WorkspaceManager(dir), store: new MemoryRunStore(), serveUi: false, enableChat: false, stt: false, concepts: false, graph, memoryReaders: ["orchestrator"] });
        assert.equal((await strut.app.request(`/graph/nodes/${c}`)).status, 404);
        assert.equal((await strut.app.request(`/graph/nodes/${wf}`)).status, 200);
        const names = (await (await strut.app.request(`/graph/names?type=${MANAGED}&q=claim`)).json()) as { nodes: unknown[] };
        assert.deepEqual(names.nodes, []);
        const status = JSON.stringify(await (await strut.app.request("/graph/embeddings")).json());
        assert.ok(!status.includes(MANAGED) && !status.includes(c), status);
        assert.ok(status.includes("StrutWorkflow"));

        const view = (strut.services as { graph?: GraphView }).graph!;
        for (const handle of ["nodeEngine", "edgeEngine", "schemaSource", "bolt", "lbug", "cfg", "tx", "embeddings"]) assert.ok(!(handle in view), `no ${handle}`);
        assert.equal(await view.reader.getNode(c), null);
        assert.equal((await view.reader.getNode(wf))?.ref_id, wf);
        await assert.rejects(view.query("RETURN 1 AS one"), /raw graph queries are off/);
        await assert.rejects(view.nodes.write(claim("c2"), "create", { manager: { manager: MANAGER } as ManagerKey }), (e) => code(e) === "MANAGED");
        assert.equal((await view.nodes.write({ type: "StrutWorkflow", data: { name: "via the view" } })).outcome, "created");
        assert.ok(Object.isFrozen(view) && Object.isFrozen(view.reader) && Object.isFrozen(view.nodes));
        // Strut's own graph steps reach the backend behind it, and filter by caller.
        assert.equal(rawGraphOf(view), graph);
        assert.equal(await graphCtx({ services: { graph: view } } as unknown as StepContext<never>).then((g) => g.nodeEngine), b.nodeEngine);
        await strut.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("graphView with nothing managed: reads and raw queries go straight through", async () => {
      const view = graphView(base);
      assert.deepEqual(await view.query("RETURN 1 AS one"), [{ one: 1 }]);
      assert.equal((await view.reader.getNode(wf))?.ref_id, wf);
    });
  });
}
