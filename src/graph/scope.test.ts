/**
 * Reader lists (plans/graph-memory-plan.md step 6, and step 4's scoping;
 * `scope.ts`): one check under every read tool. With no `graphReaders` a
 * host runs as before; with them every reader reads its own list and a
 * reader left out reads nothing. Ladybug carries the whole rule; the
 * Neo4j suite checks a list holds there too, by its nodes' namespaces.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBackend, LadybugBackend } from "./backend.js";
import type { Embedder } from "./node-writer.js";
import { graphFor, graphView, parseGraphReaders, readerKindOf, type GraphReaders } from "./scope.js";
import { readQuery } from "./query.js";
import { setNamespace } from "./set-namespace.js";
import { assertEdge } from "./temporal.js";
import { seedConceptSchema, testBackends } from "./test-util.js";
import { seedStrutDomain } from "./schema-seed.js";
import { createStrut } from "../createStrut.js";
import { hostConfigFromEnv } from "../server.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import graphGet from "../steps/lib/graph/graph-get.js";
import graphGetBatched from "../steps/lib/graph/graph-get-batched.js";
import graphNeighbors from "../steps/lib/graph/graph-neighbors.js";
import graphEdges from "../steps/lib/graph/graph-edges.js";
import graphFind from "../steps/lib/graph/find.js";
import graphQuery from "../steps/lib/graph/query.js";
import createNode from "../steps/lib/graph/create-node.js";
import setNamespaceStep from "../steps/lib/graph/set-namespace.js";
import graphResolve from "../steps/lib/graph/resolve.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j")!;

/** Peel's lists: jobs work on the person's memory as the assistant does,
 *  without Strut's records; apps and peers read only shared. */
const READERS: GraphReaders = parseGraphReaders({
  assistant: { workflows: ["orchestrator"], namespaces: ["private", "shared"] },
  builder: { namespaces: ["*"] },
  jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
  apps: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  peers: { namespaces: ["shared"], exclude_domains: ["Strut"] },
  ui: { namespaces: ["*"] },
});

const RUN = { run_id: "1725220000123", workflow_name: "lighthouse-keeper", run_status: "success", summary: "lit the lighthouse lamp", started_at: 1 };

type Ctx = Record<string, unknown>;
const jobCtx = (services: object, extra: Ctx = {}): Ctx => ({ runId: "r-1", path: "nightly/s", workflow: "nightly", scope: {}, input: undefined, emit: async () => {}, services, ...extra });
const appCtx = (services: object, extra: Ctx = {}): Ctx => jobCtx(services, { app: { name: "notes", version: "1" }, ...extra });
const assistantCtx = (services: object, extra: Ctx = {}): Ctx =>
  jobCtx(services, { path: "orchestrator/agent", workflow: "orchestrator", agentTool: true, frame: { workflow: "orchestrator", sealed: true }, ...extra });
const run = (step: { run: (cfg: any, ctx: any) => Promise<unknown> }, cfg: Ctx, ctx: Ctx) => step.run(cfg, ctx);
const ids = (out: unknown) => (Array.isArray(out) ? out.map((n: { ref_id: string }) => n.ref_id) : out);

const embedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : i === 1 ? t.length / 1000 : 0)));
  },
};

describe("reader lists on a ladybug file (plans/graph-memory-plan.md step 6)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let view: GraphBackend;
  let services: { graph: GraphBackend };
  // private: mine (Lighthouse), shared: ours (Harbour) and a shared run.
  let mine: { ref_id: string; key: string };
  let ours: { ref_id: string; key: string };
  let pier: { ref_id: string };
  let runRef: string;
  let crossEdge: string;
  before(async () => {
    b = (await lb.open({ embedder })) as LadybugBackend;
    view = graphView(b, READERS);
    services = { graph: view };
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    mine = await b.nodes.write({ type: "Concept", data: { name: "Lighthouse", description: "the keeper's lamp" } });
    ours = await b.nodes.write({ type: "Concept", data: { name: "Harbour", description: "where the lighthouse stands" } }, "create", { namespace: "shared" });
    pier = await b.nodes.write({ type: "Concept", data: { name: "Pier", description: "beside the harbour" } }, "create", { namespace: "shared" });
    runRef = (await b.nodes.write({ type: "StrutRun", data: RUN }, "create", { namespace: "shared" })).ref_id;
    // A shared edge into private, and a private edge between two shared nodes.
    crossEdge = (await b.edges.write({ edge: "CHILD_OF", source_ref_id: ours.ref_id, target_ref_id: mine.ref_id })).ref_id;
    await b.edges.write({ edge: "CHILD_OF", source_ref_id: pier.ref_id, target_ref_id: ours.ref_id, namespace: "private" });
  });

  it("with no graphReaders the host runs as before: the backend as it is, every reader reads everything", async () => {
    assert.equal(graphView(b, undefined), b);
    const plain = { graph: b };
    assert.ok((ids(await run(graphSearch, { q: "lighthouse" }, jobCtx(plain))) as string[]).includes(mine.ref_id));
    assert.equal(((await run(graphGet, { ref_id: mine.ref_id }, jobCtx(plain))) as { ref_id: string }).ref_id, mine.ref_id);
    assert.ok(((await run(graphQuery, { cypher: "MATCH (n:Node) RETURN count(n) AS c" }, jobCtx(plain))) as { rowCount: number }).rowCount === 1);
  });

  it("a job works on the person's memory: private and shared, with no Strut records", async () => {
    const job = jobCtx(services);
    const found = ids(await run(graphSearch, { q: "lighthouse" }, job)) as string[];
    assert.ok(found.includes(mine.ref_id) && found.includes(ours.ref_id));
    assert.ok(!found.includes(runRef), "a job sees no Strut records, through its domain filter");
    assert.equal(((await run(graphGet, { ref_id: mine.ref_id }, job)) as { ref_id: string }).ref_id, mine.ref_id);
    assert.equal(typeof (await run(graphGet, { ref_id: runRef }, job)), "string");
    assert.match(String(await run(graphFind, { node_type: "StrutRun", namespace: "shared" }, job)), /unknown node type/);
  });

  it("an app reads only shared, with no Strut records, through every read step", async () => {
    const job = appCtx(services);
    const found = ids(await run(graphSearch, { q: "lighthouse" }, job)) as string[];
    assert.ok(found.includes(ours.ref_id));
    assert.ok(!found.includes(mine.ref_id) && !found.includes(runRef), "the private Lighthouse and the shared run are left out");
    assert.match(String(await run(graphGet, { ref_id: mine.ref_id }, job)), /NOT_FOUND|not found|No node/i);
    assert.equal(typeof (await run(graphGet, { ref_id: runRef }, job)), "string", "a run is hidden from an app");
    const batched = (await run(graphGetBatched, { ref_ids: [mine.ref_id, ours.ref_id] }, job)) as { nodes?: Array<{ ref_id: string }> } | Array<{ ref_id: string }>;
    const entries = (Array.isArray(batched) ? batched : batched.nodes ?? []) as Array<{ ref_id: string; error?: string }>;
    assert.deepEqual(entries.filter((n) => !n.error).map((n) => n.ref_id), [ours.ref_id]);
    assert.equal(entries.find((n) => n.ref_id === mine.ref_id)?.error, `node not found: ${mine.ref_id}`, "as a missing one reads");
    const found2 = (await run(graphFind, { node_type: "Concept", namespace: "shared" }, job)) as { nodes: Array<{ ref_id: string }> };
    assert.deepEqual(found2.nodes.map((n) => n.ref_id).sort(), [ours.ref_id, pier.ref_id].sort());
    assert.deepEqual(((await run(graphFind, { node_type: "Concept" }, job)) as { nodes: unknown[] }).nodes, [], "private holds nothing it may read");
    assert.match(String(await run(graphFind, { node_type: "StrutRun", namespace: "shared" }, job)), /unknown node type/, "a hidden domain's type is unknown");
    // Resolve's lookups (step 5) never reveal a node outside the list.
    const r = graphFor(view, job as never).reader;
    assert.equal(await r.getNodeByKey("Concept", mine.key), null);
    assert.deepEqual(await r.namesLike("Concept", "light"), []);
    assert.equal((await r.getNodeByKey("Concept", ours.key, "shared"))?.ref_id, ours.ref_id);
  });

  it("an edge is seen only when its namespace and both ends are: neighbors, edges and counts", async () => {
    const job = appCtx(services);
    const nb = (await run(graphNeighbors, { ref_id: ours.ref_id }, job)) as { nodes?: Array<{ ref_id: string }>; edges?: unknown[] } | string;
    const text = JSON.stringify(nb);
    assert.ok(!text.includes(mine.ref_id), "the shared edge into private is invisible to a shared-only reader, and so is that it exists");
    assert.ok(!text.includes(pier.ref_id), "a private edge between two shared nodes is invisible too");
    assert.ok(!text.includes(crossEdge));
    const edges = (await run(graphEdges, { ref_ids: [ours.ref_id, pier.ref_id], among: [mine.ref_id] }, job)) as { edges: unknown[] };
    assert.deepEqual(edges.edges, []);
    const r = graphFor(view, job as never).reader;
    assert.deepEqual(await r.connectionCounts(ours.ref_id), []);
    assert.deepEqual(await r.edgeCounts([ours.ref_id], "shared"), {});
    const hits = (await r.search({ q: "harbour", include_edge_counts: true })).nodes;
    assert.deepEqual(hits.map((n) => [n.ref_id, n.edges]), [[ours.ref_id, {}], [pier.ref_id, {}]].filter(([id]) => hits.some((h) => h.ref_id === id)));
    // The assistant sees all three edges' worth.
    const a = graphFor(view, assistantCtx(services) as never).reader;
    assert.equal((await a.connectionCounts(ours.ref_id)).reduce((n, c) => n + c.count, 0), 2);
    assert.equal((await a.neighbors(ours.ref_id)).edges.length, 2);
  });

  it("a private run's ACCESSED edge to a shared node is invisible to a shared-only reader (step 8's edges)", async () => {
    const privateRun = (await b.nodes.write({ type: "StrutRun", data: { ...RUN, run_id: "1725220000999" } })).ref_id;
    // Step 8's edge as the projector writes it, in the run's namespace.
    const accessedEdge = async (from: string, to: string, ns: string) =>
      (await b.edges.write({ edge: "ACCESSED", source_ref_id: from, target_ref_id: to, namespace: ns })).ref_id;
    const accessed = await accessedEdge(privateRun, ours.ref_id, "private");
    // A run's records are Strut's: even with the domain filter off, a shared-only reader sees neither the edge nor its end.
    const shared = graphFor(graphView(b, { ...READERS, apps: { namespaces: ["shared"] } }), appCtx(services) as never).reader;
    const nb = JSON.stringify(await shared.neighbors(ours.ref_id));
    assert.ok(!nb.includes(privateRun) && !nb.includes(accessed));
    assert.ok(!(await shared.connectionCounts(ours.ref_id)).some((c) => c.edge_type === "ACCESSED"));
    assert.ok(!Object.keys((await shared.edgeCounts([ours.ref_id], "shared"))[ours.ref_id] ?? {}).includes("ACCESSED"));
    // An ACCESSED edge between two visible ends but in private is hidden too.
    const sharedRun = runRef;
    await accessedEdge(sharedRun, ours.ref_id, "private");
    assert.ok(!JSON.stringify(await shared.neighbors(ours.ref_id)).includes(sharedRun));
    // The assistant sees both.
    const a = graphFor(view, assistantCtx(services) as never).reader;
    assert.equal((await a.neighbors(ours.ref_id, { edge_types: ["ACCESSED"] })).edges.length, 2);
  });

  it("a hidden node returns the same as a node that doesn't exist", async () => {
    const job = appCtx(services);
    const hidden = String(await run(graphGet, { ref_id: mine.ref_id }, job)).replaceAll(mine.ref_id, "X");
    const missing = String(await run(graphGet, { ref_id: "no-such-node" }, job)).replaceAll("no-such-node", "X");
    assert.equal(hidden, missing);
    const n1 = JSON.stringify(await run(graphNeighbors, { ref_id: mine.ref_id }, job)).replaceAll(mine.ref_id, "X");
    const n2 = JSON.stringify(await run(graphNeighbors, { ref_id: "no-such-node" }, job)).replaceAll("no-such-node", "X");
    assert.equal(n1, n2);
  });

  it("the assistant reads private and shared and searches everything, so it finds a run", async () => {
    const a = assistantCtx(services);
    assert.equal(readerKindOf(a as never, READERS), "assistant");
    const found = ids(await run(graphSearch, { q: "lighthouse" }, a)) as string[];
    for (const id of [mine.ref_id, ours.ref_id, runRef]) assert.ok(found.includes(id), id);
    // The memory tools' narrowing (step 4): a call's exclude_domains only narrows.
    const narrowed = ids(await run(graphSearch, { q: "lighthouse", exclude_domains: "strut" }, a)) as string[];
    assert.ok(!narrowed.includes(runRef) && narrowed.includes(mine.ref_id));
    // A reader cannot widen its list by asking.
    assert.deepEqual(ids(await run(graphSearch, { q: "lighthouse", namespace: "private" }, appCtx(services))), []);
  });

  it("B's reader rule: only a sealed, listed, human-authored agent tool call is the assistant", () => {
    const base = assistantCtx(services);
    assert.equal(readerKindOf({ ...base, frame: { workflow: "orchestrator" } } as never, READERS), "jobs", "not sealed");
    assert.equal(readerKindOf({ ...base, aiAuthored: true } as never, READERS), "jobs", "AI-authored");
    assert.equal(readerKindOf({ ...base, agentTool: false } as never, READERS), "jobs", "a DAG step");
    assert.equal(readerKindOf({ ...base, workflow: "nightly" } as never, READERS), "jobs", "another run's workflow");
    assert.equal(readerKindOf({ ...base, frame: { workflow: "helper", sealed: true } } as never, READERS), "jobs", "an unlisted frame");
    assert.equal(readerKindOf({ ...base, app: { name: "notes" } } as never, READERS), "apps");
  });

  it("a reader the host hasn't given a list reads nothing", async () => {
    const { apps: _apps, ...noApps } = READERS;
    const unlisted = { graph: graphView(b, noApps) };
    const app = appCtx(unlisted);
    assert.deepEqual(ids(await run(graphSearch, { q: "harbour" }, app)), []);
    assert.equal(typeof (await run(graphGet, { ref_id: ours.ref_id }, app)), "string");
    const none = graphView(b, parseGraphReaders({}));
    assert.deepEqual((await none.reader.search({ q: "harbour" })).nodes, []);
  });

  it("a raw query is refused unless the reader can read every namespace in the graph", async () => {
    const q = { cypher: "MATCH (n:Node) RETURN count(n) AS c" };
    await assert.rejects(run(graphQuery, q, jobCtx(services)) as Promise<unknown>, /raw graph queries are off/);
    await assert.rejects(view.query(q.cypher), /raw graph queries are off/, "services.graph.query too");
    // The assistant reads private and shared: enough until a third namespace holds something.
    assert.equal(((await run(graphQuery, q, assistantCtx(services))) as { rowCount: number }).rowCount, 1);
    await b.nodes.write({ type: "Concept", data: { name: "Elsewhere" } }, "create", { namespace: "family" });
    await assert.rejects(run(graphQuery, q, assistantCtx(services)) as Promise<unknown>, /raw graph queries are off/);
    // The builder reads "*".
    const builder = graphView(b, READERS, "builder");
    assert.equal((await readQuery(builder, q.cypher)).rowCount, 1);
  });

  it("a new read tool can't skip the check: ctx.services.graph is the jobs view", async () => {
    const hits = (await services.graph.reader.search({ q: "lighthouse" })).nodes.map((n) => n.ref_id);
    assert.ok(hits.includes(mine.ref_id) && !hits.includes(runRef));
    assert.equal(await services.graph.reader.getNode(runRef), null);
    // A view pinned to a shared-only reader, the same way.
    const shared = graphView(b, { ...READERS, jobs: { namespaces: ["shared"] } });
    assert.equal(await shared.reader.getNode(mine.ref_id), null);
  });

  it("a node created straight into shared is visible to a shared-only reader", async () => {
    const made = (await run(createNode, { node_type: "Concept", node_data: { name: "Breakwater" }, namespace: "shared" }, assistantCtx(services))) as { ref_id: string };
    assert.ok((ids(await run(graphSearch, { q: "breakwater" }, appCtx(services))) as string[]).includes(made.ref_id));
  });

  it("moving to shared is the person's act: set-namespace runs only as an accepted proposal, and edges stay", async () => {
    await assert.rejects(run(setNamespaceStep, { ref_id: mine.ref_id, namespace: "shared" }, assistantCtx(services)) as Promise<unknown>, /only as a proposal/);
    const out = (await run(setNamespaceStep, { ref_id: mine.ref_id, namespace: "shared" }, assistantCtx(services, { proposal: { id: "p-1", by: { workflow: "orchestrator", runId: "r-1" } } }))) as { moved: boolean; from: string };
    assert.deepEqual([out.moved, out.from], [true, "private"]);
    assert.ok((ids(await run(graphSearch, { q: "lighthouse" }, appCtx(services))) as string[]).includes(mine.ref_id), "a shared-only reader sees it now");
    const row = await b.query(`MATCH ()-[r {ref_id: $id}]->() RETURN r.namespace AS ns`, { id: crossEdge });
    assert.equal(row[0]!["ns"], "shared", "the edge kept its own namespace");
    const pierEdge = await b.query(`MATCH (a:Node {ref_id: $p})-[r]->() RETURN r.namespace AS ns`, { p: pier.ref_id });
    assert.equal(pierEdge[0]!["ns"], "private");
    // A key the target namespace already holds is refused.
    await b.nodes.write({ type: "Concept", data: { name: "Harbour" } });
    const clash = (await b.query(`MATCH (n:Node {node_type: 'Concept', namespace: 'private', name: 'Harbour'}) RETURN n.ref_id AS r`))[0]!["r"] as string;
    const refused = await run(setNamespaceStep, { ref_id: clash, namespace: "shared" }, assistantCtx(services, { proposal: { id: "p-2", by: { workflow: "orchestrator", runId: "r-1" } } }));
    assert.match(String(refused), /DUPLICATE_KEY/);
  });

  it("a fact's search row is in its edge's namespace, hidden as a node, and moves with its edge", async () => {
    await b.schemas.createEdgeSchema("Concept", "GUARDS", "Concept", { temporal: true, cardinality: "many" });
    const fact = await assertEdge(b, b.schemas, { edge: "GUARDS", source_ref_id: mine.ref_id, target_ref_id: ours.ref_id, text: "The lighthouse guards the harbour" });
    const rowNs = async () => (await b.query(`MATCH (n:Node {node_type: 'EdgeText', key: $k}) RETURN n.namespace AS ns`, { k: `edgetext-${fact.ref_id}` }))[0]?.["ns"];
    assert.equal(await rowNs(), "private");
    for (const ctx of [appCtx(services), assistantCtx(services)]) {
      const hits = (await graphFor(view, ctx as never).reader.search({ q: "guards harbour" })).nodes;
      assert.ok(hits.every((n) => n.node_type !== "EdgeText"), "a search row is never read as a node");
    }
    const moved = await setNamespace(b, { kind: "edge", ref_id: fact.ref_id, namespace: "shared" });
    assert.deepEqual([moved.moved, moved.from], [true, "private"]);
    assert.equal(await rowNs(), "shared", "the row moved with its edge");
    await setNamespace(b, { kind: "node", ref_id: mine.ref_id, namespace: "shared" });
    assert.equal(await rowNs(), "shared", "a node's move leaves its facts' rows where their edges are");
  });

  it("resolve reads only the caller's list: a private Person is no match and no candidate to a shared-only reader", async () => {
    const ada = (await b.nodes.write({ type: "Person", data: { name: "Ada Lovelace", email: "ada@example.com", alt_names: ["Countess Lovelace"] } })).ref_id;
    type Resolved = { match: { ref_id: string } | null; ambiguous: boolean; candidates: unknown[]; namespaces: string[] };
    const resolve = async (cfg: Ctx, ctx: Ctx) => (await run(graphResolve, { node_type: "Person", ...cfg }, ctx)) as Resolved;
    const asks: Ctx[] = [{ node_data: { email: "ada@example.com" } }, { name: "Ada Lovelace" }, { name: "Countess Lovelace" }, { name: "Ada" }];
    for (const ask of asks) {
      const shared = await resolve(ask, appCtx(services));
      assert.deepEqual([shared.match, shared.ambiguous, shared.candidates], [null, false, []], JSON.stringify(ask));
      assert.deepEqual(shared.namespaces, ["shared"], "with none asked, the list's own namespaces");
      const asked = await resolve({ ...ask, namespaces: ["private"] }, appCtx(services));
      assert.deepEqual([asked.match, asked.candidates, asked.namespaces], [null, [], []], "asking for a namespace outside the list reads nothing");
    }
    // A job reads private: it resolves her; and with no lists, as main.
    assert.equal((await resolve(asks[0]!, jobCtx(services))).match?.ref_id, ada);
    assert.equal((await resolve(asks[2]!, jobCtx({ graph: b }))).match?.ref_id, ada);
    assert.deepEqual((await resolve(asks[1]!, jobCtx({ graph: b }))).namespaces, ["private"]);
    // A type the list's domains hide is unknown.
    assert.match(String(await run(graphResolve, { node_type: "StrutRun", name: "lit the lighthouse lamp" }, jobCtx(services))), /unknown node type/i);
  });

  it("search and walk scope by namespace (step 4): a scope returns nothing from outside it, through edges too", async () => {
    const a = assistantCtx(services);
    const scoped = ids(await run(graphSearch, { q: "lighthouse", namespace: "shared" }, a)) as string[];
    assert.ok(scoped.includes(ours.ref_id) && !scoped.includes(mine.ref_id));
    const walker = graphFor(view, a as never, { namespace: "shared" }).reader;
    const nb = await walker.neighbors(ours.ref_id);
    assert.ok(!nb.nodes.some((n) => n.ref_id === mine.ref_id));
    // With no lists, the same scope holds on a plain backend.
    const plain = graphFor(b, jobCtx({ graph: b }) as never, { namespace: "shared" }).reader;
    assert.ok(!(await plain.neighbors(ours.ref_id)).nodes.some((n) => n.ref_id === mine.ref_id));
    const priv = (await b.reader.search({ q: "lighthouse", namespace: "private" })).nodes.map((n) => n.ref_id);
    assert.ok(priv.includes(mine.ref_id) && !priv.includes(ours.ref_id));
  });

  it("vector search runs with efs 500 under a scope", async () => {
    const r = graphFor(view, assistantCtx(services) as never).reader;
    const res = await r.search({ q: "keeper's lamp" });
    assert.ok(!res.warnings?.some((w) => /semantic/.test(w)), JSON.stringify(res.warnings));
  });

  describe("/graph/* and the host config", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "strut-scope-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const strutWith = (graphReaders: GraphReaders | undefined, scope: "full" | "peer") =>
      createStrut({ workspace: new WorkspaceManager(dir), graph: b, ...(graphReaders ? { graphReaders } : {}), store: new MemoryRunStore(), serveUi: false, enableChat: false, stt: false, resolveScope: () => scope });

    it("a peer reads its list, a person theirs; without graphReaders both read everything", async () => {
      const peer = await strutWith(READERS, "peer");
      assert.equal((await peer.app.request(`/graph/nodes/${mine.ref_id}`)).status, 404);
      assert.equal((await peer.app.request(`/graph/nodes/${ours.ref_id}`)).status, 200);
      assert.deepEqual(((await (await peer.app.request("/graph/names?type=Concept&q=light")).json()) as { nodes: unknown[] }).nodes, []);
      assert.equal((await peer.app.request("/graph/changes")).status, 403);
      const person = await strutWith(READERS, "full");
      assert.equal((await person.app.request(`/graph/nodes/${mine.ref_id}`)).status, 200);
      const before = await strutWith(undefined, "peer");
      assert.equal((await before.app.request(`/graph/nodes/${mine.ref_id}`)).status, 200);
    });

    it("POST /graph/nodes/:ref_id/namespace moves a node for a person", async () => {
      const person = await strutWith(READERS, "full");
      const res = await person.app.request(`/graph/nodes/${mine.ref_id}/namespace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ namespace: "shared" }) });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { namespace: string }).namespace, "shared");
      const edge = await person.app.request(`/graph/edges/${crossEdge}/namespace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ namespace: "private" }) });
      assert.equal(edge.status, 200);
      assert.equal((await person.app.request(`/graph/nodes/nope/namespace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ namespace: "shared" }) })).status, 404);
    });

    it("STRUT_HOST_CONFIG carries graphReaders; a malformed one fails the boot", () => {
      const file = join(dir, "host.json");
      writeFileSync(file, JSON.stringify({ graphReaders: { jobs: { namespaces: ["shared"], exclude_domains: ["Strut"] } } }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }).graphReaders, { jobs: { namespaces: ["shared"], exclude_domains: ["strut"] } });
      writeFileSync(file, JSON.stringify({ graphReaders: { jobs: { namespaces: "shared" } } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /graphReaders/);
      writeFileSync(file, JSON.stringify({ graphReaders: { robots: { namespaces: [] } } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /unknown reader/);
      writeFileSync(file, JSON.stringify({ graphReaders: { assistant: { namespaces: ["private"] } } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /workflows/);
    });
  });
});

describe("reader lists on Neo4j", { skip: neo4j.skip }, () => {
  let b: GraphBackend;
  before(async () => {
    b = await neo4j.open();
    await neo4j.wipe(b);
    await seedStrutDomain(b);
    await seedConceptSchema(b);
    await b.reader.registerNamespace("shared");
  });
  after(async () => {
    await neo4j.close(b);
  });

  it("moving between namespaces is Ladybug only: Neo4j refuses it and writes nothing", async () => {
    const node = await b.nodes.write({ type: "Concept", data: { name: "Jetty" } });
    await assert.rejects(setNamespace(b, { kind: "node", ref_id: node.ref_id, namespace: "shared" }), /not on this backend/);
    assert.notEqual((await b.reader.getNode(node.ref_id))?.properties["namespace"], "shared");
  });

  it("a list holds by the nodes' namespaces; with no lists nothing changes", async () => {
    const mine = await b.nodes.write({ type: "Concept", data: { name: "Lighthouse" } });
    const ours = await b.nodes.write({ type: "Concept", data: { name: "Harbour" } }, "create", { namespace: "shared" });
    await b.edges.write({ edge: "CHILD_OF", source_ref_id: ours.ref_id, target_ref_id: mine.ref_id }).catch(async () => {
      await b.schemas.createEdgeSchema("Concept", "CHILD_OF", "Concept");
      await b.edges.write({ edge: "CHILD_OF", source_ref_id: ours.ref_id, target_ref_id: mine.ref_id });
    });
    assert.equal(graphView(b, undefined), b);
    assert.equal((await b.reader.getNode(mine.ref_id))?.ref_id, mine.ref_id);
    const view = graphView(b, READERS);
    const job = graphFor(view, appCtx({ graph: view }) as never);
    assert.equal(await job.reader.getNode(mine.ref_id), null);
    assert.equal((await job.reader.getNode(ours.ref_id))?.ref_id, ours.ref_id);
    assert.ok(!(await job.reader.neighbors(ours.ref_id)).nodes.some((n) => n.ref_id === mine.ref_id), "an edge into default is hidden with its end");
    assert.deepEqual(await job.reader.connectionCounts(ours.ref_id), []);
    assert.deepEqual((await job.reader.search({ q: "Lighthouse" })).nodes, []);
    await assert.rejects(readQuery(job, "MATCH (n) RETURN count(n) AS c"), /raw graph queries are off/);
    const builder = graphView(b, READERS, "builder");
    assert.equal((await readQuery(builder, "MATCH (n) RETURN count(n) AS c")).rowCount, 1);
  });
});
