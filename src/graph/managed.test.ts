/**
 * The writer gaps memory needs (plans/memory-in-workspace-graph.md, PR B):
 * caller transactions, the edge-keeping soft delete, identity by ref_id,
 * the managed-type guard, and the read filter. Nothing in the registry is
 * managed yet, so a test marks a type itself: `Claim` stands in for a
 * memory type — managed by `test-memory` and keyed by `ref_id` — through a
 * resolver that adds the marks (`managing`).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBackend } from "./backend.js";
import { EdgeWriter } from "./edge-writer.js";
import type { GraphTx } from "./engine.js";
import { ManagedReadFilter, withoutManagedRows } from "./managed.js";
import { GraphValidationError, NodeWriter } from "./node-writer.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { readQuery } from "./query.js";
import { SchemaResolver, type NodeSchema } from "./schema-resolver.js";
import { seedStrutDomain } from "./schema-seed.js";
import { edgeCount, rawNode, testBackends } from "./test-util.js";
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

describe("withoutManagedRows (pure)", () => {
  const managed = new Map([["Claim", MANAGER]]);
  it("drops a row holding a managed node by node_type or label, at any depth", () => {
    const rows = [
      { n: { node_type: "Claim", name: "x" } },
      { n: { labels: ["Data_Bank", "Claim"], properties: {} } },
      { list: [{ node_type: "claim" }] },
      { node_type: "Claim" },
      { n: { node_type: "StrutWorkflow" } },
      { count: 3 },
    ];
    assert.deepEqual(withoutManagedRows(rows, managed), [{ n: { node_type: "StrutWorkflow" } }, { count: 3 }]);
  });
  it("passes everything through when nothing is managed", () => {
    const rows = [{ n: { node_type: "Claim" } }];
    assert.equal(withoutManagedRows(rows, new Map()), rows);
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
          const [c] = await b.nodes.writeMany([claim("c1")], "create", { tx, manager: MANAGER });
          await b.nodes.update(wf, { set: { description: "changed" } }, { tx });
          const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c!.ref_id, target_ref_id: wf }, { tx, manager: MANAGER });
          await b.edges.update({ ref_id: e.ref_id }, { set: { weight: 2 } }, { tx, manager: MANAGER });
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
        const c = await b.nodes.write(claim("c1"), "create", { tx, manager: MANAGER });
        const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c.ref_id, target_ref_id: wf }, { tx, manager: MANAGER });
        await b.edges.update({ ref_id: e.ref_id }, { set: { weight: 2 } }, { tx, manager: MANAGER });
        return { c: c.ref_id, e: e.ref_id };
      });
      assert.ok(await rawNode(b, done.c));
      assert.equal(await edgeCount(b, "ABOUT"), 1);

      await assert.rejects(
        b.tx(async (tx) => {
          await b.edges.delete(done.e, { tx, manager: MANAGER });
          throw new Error("abort");
        }),
        /abort/,
      );
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the edge delete rolled back");
      await b.tx((tx) => b.edges.delete(done.e, { tx, manager: MANAGER }));
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
      const c = (await b.nodes.write(claim("c1"), "create", { manager: MANAGER })).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: MANAGER });
      assert.equal(await b.nodes.softDelete(c, { manager: MANAGER, keepEdges: true, reason: "forgotten" }), true);
      const kept = (await rawNode(b, c))!.props;
      assert.ok(kept["deleted_at"]);
      assert.equal(kept["deleted_reason"], "forgotten");
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the edge stays");
      // A second delete keeps the first reason.
      await b.nodes.softDelete(c, { manager: MANAGER, keepEdges: true, reason: "again" });
      assert.equal((await rawNode(b, c))!.props["deleted_reason"], "forgotten");

      const c2 = (await b.nodes.write(claim("c2"), "create", { manager: MANAGER })).ref_id;
      await b.edges.write({ edge: "ABOUT", source_ref_id: c2, target_ref_id: wf }, { manager: MANAGER });
      assert.equal(await b.nodes.softDelete(c2, { manager: MANAGER }), true);
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the default delete takes the node's edges");
      assert.equal((await rawNode(b, c2))!.props["deleted_reason"] ?? null, null, "no reason given, none stored");
    });

    it("softDelete with a manager matches only that manager's nodes; without one, only Strut's own", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: MANAGER })).ref_id;
      assert.equal(await b.nodes.softDelete(c), false, "a managed node is not one of Strut's own");
      assert.equal(await b.nodes.softDelete(c, { manager: "someone-else" }), false);
      assert.equal(await b.nodes.softDelete(wf, { manager: MANAGER }), false, "a Strut node is not the manager's");
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
      const a = await b.nodes.write(claim("same"), "create", { manager: MANAGER });
      const c = await b.nodes.write(claim("same"), "create", { manager: MANAGER });
      assert.equal(a.outcome, "created");
      assert.equal(c.outcome, "created");
      assert.notEqual(a.ref_id, c.ref_id, "two nodes with the same attributes");
      assert.equal(a.node_key, `claim-${a.ref_id}`);

      await b.nodes.softDelete(a.ref_id, { manager: MANAGER, keepEdges: true });
      const d = await b.nodes.write(claim("same"), "upsert", { manager: MANAGER });
      assert.equal(d.outcome, "created", "not a restore");
      assert.notEqual(d.ref_id, a.ref_id);
      assert.ok((await rawNode(b, a.ref_id))!.props["deleted_at"], "the deleted one stays deleted");

      const u = await b.nodes.update(c.ref_id, { set: { claim_text: "changed" } }, { manager: MANAGER });
      assert.deepEqual([u.node_key, u.rekeyed], [c.node_key, false]);
    });

    // ── The managed-type guard ────────────────────────────────────────────

    it("the writers refuse a managed type unless the caller names its manager", async () => {
      await assert.rejects(b.nodes.write(claim("c1")), (e) => code(e) === "MANAGED");
      await assert.rejects(b.nodes.write(claim("c1"), "create", { manager: "someone-else" }), (e) => code(e) === "MANAGED");
      const c = (await b.nodes.write(claim("c1"), "create", { manager: MANAGER })).ref_id;

      await assert.rejects(b.nodes.update(c, { set: { claim_text: "x" } }), (e) => code(e) === "MANAGED");
      await assert.rejects(b.nodes.deleteNode(c), (e) => code(e) === "MANAGED");
      await assert.rejects(b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }), (e) => code(e) === "MANAGED");
      const e = await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: MANAGER });
      await assert.rejects(b.edges.update({ ref_id: e.ref_id }, { set: { weight: 3 } }), (x) => code(x) === "MANAGED");
      await assert.rejects(b.edges.delete(e.ref_id), (x) => code(x) === "MANAGED");
      await assert.rejects(b.edges.delete({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }), (x) => code(x) === "MANAGED");
      assert.equal(await edgeCount(b, "ABOUT"), 1, "the refused delete took nothing");
      const stored = await rawNode(b, c);
      assert.equal(stored!.props["claim_text"], "the deploy pipeline is green");
      assert.equal(stored!.props["deleted_at"] ?? null, null);

      // Unmanaged types are untouched by the guard, a manager named or not.
      await b.nodes.update(wf, { set: { description: "fine" } }, { manager: MANAGER });
      await b.nodes.update(wf, { set: { description: "fine too" } });
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
        c = (await b.nodes.write(claim("c1", "the release train leaves on friday"), "create", { manager: MANAGER })).ref_id;
        e = (await b.edges.write({ edge: "ABOUT", source_ref_id: c, target_ref_id: wf }, { manager: MANAGER })).ref_id;
      });
      const ctxFor = (who: { workflow?: string; agentTool?: boolean } = {}) =>
        ({ runId: "r", path: `${who.workflow ?? "job"}/agent`, scope: {}, input: undefined, emit: async () => {}, services: { graph: b, memoryReaders: ["orchestrator"] }, ...who }) as unknown as StepContext;
      const run = (type: string, input: unknown, ctx = ctxFor({ workflow: "job", agentTool: true })) => {
        const def = registry[type] as StepDef;
        return def.run(def.input.parse(input), ctx);
      };
      const assistant = () => ctxFor({ workflow: "orchestrator", agentTool: true });

      it("every graph write step refuses a managed type", async () => {
        // MANAGED from the writers; NOT_FOUND where a step looks the node up
        // through the filtered reader first (delete-node, the triplet steps).
        // create-batch-triplet reports each item's error in its result.
        const refused = (out: unknown) => {
          const text = typeof out === "string" ? out : (out as { succeeded?: number })?.succeeded === 0 ? JSON.stringify(out) : "";
          return /MANAGED|managed by|NOT_FOUND|not found/.test(text);
        };
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
        for (const ctx of [ctxFor({ workflow: "job", agentTool: true }), assistant()]) {
          for (const [type, input] of tries) {
            const out = await run(type, input, ctx);
            assert.ok(refused(out), `${type} ${JSON.stringify(input)}: ${JSON.stringify(out)}`);
          }
        }
        assert.equal(await edgeCount(b, "ABOUT"), 1);
        assert.equal((await rawNode(b, c))!.props["deleted_at"] ?? null, null);
      });

      it("a managed node is invisible to a job's graph tools, and visible to an allowed workflow's agent", async () => {
        const hiddenFrom = [
          ctxFor({ workflow: "job", agentTool: true }),
          ctxFor({ workflow: "orchestrator" }), // the workflow's own step, not its agent
          ctxFor({ agentTool: true, workflow: "builder" }),
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
          const q = tb.kind === "ladybug" ? `MATCH (n:Node {node_type: '${MANAGED}'}) RETURN n` : `MATCH (n:${MANAGED}) RETURN n`;
          const rows = await run("graph/query", { cypher: q }, ctx);
          assert.equal(rows.rowCount, 0);
          const got = await run("graph/graph-get", { ref_id: wf }, ctx);
          assert.deepEqual(got.edges, {}, "edges to it are not counted");
        }

        const ctx = assistant();
        assert.equal((await run("graph/graph-get", { ref_id: c }, ctx)).ref_id, c);
        const search = await run("graph/graph-search", { q: "release train friday" }, ctx);
        assert.ok(JSON.stringify(search).includes(c));
        assert.equal((await run("graph/find", { node_type: MANAGED }, ctx)).returned, 1);
        const q = tb.kind === "ladybug" ? `MATCH (n:Node {node_type: '${MANAGED}'}) RETURN n` : `MATCH (n:${MANAGED}) RETURN n`;
        assert.equal((await run("graph/query", { cypher: q }, ctx)).rowCount, 1);
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
        const q = tb.kind === "ladybug" ? `MATCH (n:Node) RETURN n.node_type AS node_type, n.ref_id AS ref_id` : `MATCH (n:Data_Bank) RETURN n`;
        const out = await tools.graph_query.execute({ cypher: q, maxRows: 100 });
        assert.ok(out.rows.length > 0);
        assert.ok(!JSON.stringify(out.rows).includes(c));
        assert.equal(await tools.graph_get.execute({ ref_id: c }), `node not found: ${c}`);
        assert.equal((await tools.graph_get.execute({ ref_id: wf })).ref_id, wf);
        // The same read, unfiltered, sees it: the filter is what hides it.
        assert.ok(JSON.stringify((await readQuery(b, q)).rows).includes(c));
      });
    });

    it("/graph/* leaves it out", async () => {
      const c = (await b.nodes.write(claim("c1"), "create", { manager: MANAGER })).ref_id;
      const dir = await mkdtemp(join(tmpdir(), "strut-managed-"));
      try {
        const strut = await createStrut({ workspace: new WorkspaceManager(dir), store: new MemoryRunStore(), serveUi: false, enableChat: false, stt: false, concepts: false, graph: b, memoryReaders: ["orchestrator"] });
        assert.equal((await strut.app.request(`/graph/nodes/${c}`)).status, 404);
        assert.equal((await strut.app.request(`/graph/nodes/${wf}`)).status, 200);
        const names = (await (await strut.app.request(`/graph/names?type=${MANAGED}&q=claim`)).json()) as { nodes: unknown[] };
        assert.deepEqual(names.nodes, []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
