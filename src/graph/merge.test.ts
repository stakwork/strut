/**
 * `merge` and its undo (plans/graph-memory-plan.md step 5, `merge.ts`): the
 * duplicate's edges move and its ref_id, key and name still find the kept
 * node; an undo puts the graph back exactly; the janitor merges only what
 * the duplicates list offers, into the user only on the full name; the user
 * is never the duplicate; a reader can't merge what it can't see. Neo4j
 * refuses, which the last suite checks.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GraphBackend, LadybugBackend } from "./backend.js";
import { JANITOR_CAP, MergeError, duplicatePairs, mergeNodes, unmergeNodes } from "./merge.js";
import { resolveNode } from "./resolve.js";
import { ALL_EDGE_COLUMNS } from "./ladybug/registry.js";
import { createNodeSchema } from "./schema-crud.js";
import { scopedBackend } from "./scope.js";
import { assertEdge } from "./temporal.js";
import { testBackends } from "./test-util.js";
import type { Embedder } from "./node-writer.js";
import graphMerge from "../steps/lib/graph/merge.js";
import graphUnmerge from "../steps/lib/graph/unmerge.js";
import graphGet from "../steps/lib/graph/graph-get.js";
import { SYSTEM_WRITER } from "../system-workflows.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j")!;

const embedder: Embedder = {
  async embed(texts: string[]) {
    return texts.map((t) => Array.from({ length: 384 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 7) / 7 + 0.01));
  },
};

const refused = (re: RegExp) => (e: unknown) => e instanceof MergeError && re.test(e.message);
const EDGES = ["LIVES_IN", "KNOWS", "WORKS_WITH"];

/** Live nodes and every edge, as stored: what an undo must give back. */
async function snapshot(b: GraphBackend): Promise<unknown> {
  const nodes = (await b.query(`MATCH (n:Node) WHERE n.deleted_at IS NULL AND NOT n.node_type IN ['Schema', 'Merge'] RETURN n AS n`)).map((r) => {
    const { text_embeddings: _v, ...n } = r["n"] as Record<string, unknown>;
    // A search row's own clock moves with its edge's; its fields are what count.
    if (n["node_type"] === "EdgeText") delete n["updated_at"];
    return n;
  });
  const edges: unknown[] = [];
  for (const e of EDGES) {
    for (const r of await b.query(`MATCH (s:Node)-[r:${e}]->(t:Node) RETURN s.ref_id AS s, t.ref_id AS t, r AS r`)) {
      const rel = r["r"] as Record<string, unknown>;
      const props = Object.fromEntries(Object.keys(ALL_EDGE_COLUMNS).filter((k) => rel[k] !== undefined && rel[k] !== null).map((k) => [k, rel[k]]));
      edges.push({ edge: e, s: r["s"], t: r["t"], ...props });
    }
  }
  const key = (x: unknown) => JSON.stringify(x);
  return { nodes: nodes.map(key).sort(), edges: edges.map(key).sort() };
}

async function ontology(b: GraphBackend): Promise<void> {
  await createNodeSchema(b, b.schemas, { type: "Place", attributes: { alt_names: "?list" }, role: "entity" });
  await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Place", { temporal: true, cardinality: "one" });
  await b.schemas.createEdgeSchema("Person", "KNOWS", "Person", { temporal: true });
  await b.schemas.createEdgeSchema("Person", "WORKS_WITH", "Person");
}

const person = async (b: GraphBackend, data: Record<string, unknown>, namespace?: string) => (await b.nodes.write({ type: "Person", data }, "create", namespace ? { namespace } : {})).ref_id;

describe("merge on a ladybug file (plans/graph-memory-plan.md step 5)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let kate: string, katie: string, sam: string, lisbon: string, porto: string;
  let livesKate: string, knowsKate: string;
  before(async () => {
    b = (await lb.open({ embedder })) as LadybugBackend;
    await ontology(b);
  });
  after(() => lb.close(b));
  beforeEach(async () => {
    await lb.clear(b);
    kate = await person(b, { name: "Kate Moss" });
    katie = await person(b, { name: "Katie", alt_names: ["K"] });
    sam = await person(b, { name: "Sam" });
    lisbon = (await b.nodes.write({ type: "Place", data: { name: "Lisbon" } })).ref_id;
    porto = (await b.nodes.write({ type: "Place", data: { name: "Porto" } })).ref_id;
    const a = (i: Parameters<typeof assertEdge>[2]) => assertEdge(b, b.schemas, i, { embedder });
    livesKate = (await a({ edge: "LIVES_IN", source_ref_id: kate, target_ref_id: lisbon, text: "Kate lives in Lisbon", valid_at: "2026-01" })).ref_id;
    await a({ edge: "LIVES_IN", source_ref_id: katie, target_ref_id: porto, text: "Katie lives in Porto", valid_at: "2025-01" });
    knowsKate = (await a({ edge: "KNOWS", source_ref_id: kate, target_ref_id: sam, text: "Kate knows Sam", source: "msg-1" })).ref_id;
    await a({ edge: "KNOWS", source_ref_id: katie, target_ref_id: sam, text: "Katie knows Sam", source: "msg-2" });
    await a({ edge: "KNOWS", source_ref_id: sam, target_ref_id: katie, text: "Sam knows Katie" });
    await a({ edge: "KNOWS", source_ref_id: kate, target_ref_id: katie, text: "Kate knows Katie" });
    await b.edges.write({ edge: "WORKS_WITH", source_ref_id: katie, target_ref_id: sam });
  });

  it("moves the duplicate's edges, keeps its names, and its ref_id, key and name find the kept node", async () => {
    const katieKey = String((await b.query(`MATCH (n:Node {ref_id: $r}) RETURN n.key AS k`, { r: katie }))[0]!["k"]);
    const r = await mergeNodes(b, { keep: kate, duplicate: katie, by: "assistant" });

    assert.equal(r.moved.length, 3, "Porto (history once superseded), Sam knows her, works with Sam");
    assert.deepEqual(r.reconfirmed, [{ from: r.reconfirmed[0]!.from, into: knowsKate }], "Kate already knew Sam: re-confirmed");
    assert.deepEqual(r.skipped.map((s) => s.reason), ["between the two nodes"]);
    assert.deepEqual(r.alt_names, ["Katie", "K"]);

    // Old ids keep working: getNode, graph-get, resolve by key and by name.
    assert.equal((await b.reader.getNode(katie))?.ref_id, kate);
    const got = await graphGet.run({ ref_id: katie } as never, { services: { graph: b } } as never);
    assert.equal((got as { ref_id: string }).ref_id, kate);
    assert.equal((await resolveNode(b, { type: "Person", key: katieKey })).match?.ref_id, kate);
    assert.equal((await resolveNode(b, { type: "Person", name: "Katie" })).match?.ref_id, kate);

    // One current LIVES_IN: Lisbon began later, so Porto is superseded by it.
    const lives = await b.query(`MATCH (s:Node {ref_id: $k})-[r:LIVES_IN]->(t:Node) RETURN t.ref_id AS t, r.expired_at AS x, r.superseded_by AS by`, { k: kate });
    assert.deepEqual(lives.filter((l) => l["x"] == null).map((l) => l["t"]), [lisbon]);
    assert.equal(lives.find((l) => l["t"] === porto)?.["by"], livesKate);
    const knows = await b.query(`MATCH (:Node {ref_id: $k})-[r:KNOWS]->(:Node {ref_id: $s}) RETURN r.sources AS src`, { k: kate, s: sam });
    assert.deepEqual(knows.map((k) => k["src"]), [["msg-1", "msg-2"]], "the sources joined on one edge");

    // The reader sees the moved edges and never the duplicate or the record.
    const n = await b.reader.neighbors(kate);
    assert.ok(!n.nodes.some((x) => x.ref_id === katie));
    assert.ok(n.edges.some((e) => e.edge_type === "WORKS_WITH"));
    assert.ok(n.edges.some((e) => e.edge_type === "KNOWS" && e.source === sam));
    assert.equal((await b.reader.getNode(r.merge)), null, "a merge record is not a node anyone reads");

    // The moved facts' rows are composed from the kept node's title and embedded; the duplicate's are gone.
    const rows = await b.query(`MATCH (n:Node {node_type: 'EdgeText'}) WHERE n.deleted_at IS NULL RETURN n.source_ref_id AS s, n.target_ref_id AS t, n.composed AS c, n.text_embeddings IS NOT NULL AS v`);
    assert.ok(!rows.some((x) => x["s"] === katie || x["t"] === katie), "no live row names the duplicate");
    const sams = rows.find((x) => x["s"] === sam && x["t"] === kate)!;
    assert.match(String(sams["c"]), /^Sam knows Kate Moss\. Sam knows Katie$/);
    assert.equal(sams["v"], true, "re-embedded");

    // Nothing is hard-deleted: the duplicate and its own edges are there, hidden.
    const gone = await b.query(`MATCH (n:Node {ref_id: $r}) RETURN n.deleted_at AS d, n.deleted_reason AS why`, { r: katie });
    assert.match(String(gone[0]!["why"]), new RegExp(`^merged into ${kate} by assistant$`));
    assert.equal(Number((await b.query(`MATCH (:Node {ref_id: $r})-[e]-(:Node) RETURN count(e) AS n`, { r: katie }))[0]!["n"]), 5);
    await assert.rejects(mergeNodes(b, { keep: sam, duplicate: katie }), refused(/already merged into/));
  });

  it("an undo puts the graph back exactly, and refuses once a later write would be lost", async () => {
    const was = await snapshot(b);
    const r = await mergeNodes(b, { keep: kate, duplicate: katie });
    assert.notDeepEqual(await snapshot(b), was);
    const u = await unmergeNodes(b, { merge: r.merge });
    assert.deepEqual(u, { merge: r.merge, kept: kate, restored: katie, removed: r.moved.map((m) => m.to) });
    assert.deepEqual(await snapshot(b), was);
    assert.equal((await b.reader.getNode(katie))?.ref_id, katie, "her own id is hers again");
    await assert.rejects(unmergeNodes(b, { merge: r.merge }), refused(/already undone/));

    // Merged again, then Kate's knowing Sam is confirmed by a new message: the undo would lose it.
    const again = await mergeNodes(b, { keep: kate, duplicate: katie });
    await assertEdge(b, b.schemas, { edge: "KNOWS", source_ref_id: kate, target_ref_id: sam, text: "Kate knows Sam", source: "msg-3" });
    await assert.rejects(unmergeNodes(b, { merge: again.merge }), refused(new RegExp(`re-confirmed edge ${knowsKate} was changed since`)));

    // The steps say the same.
    const ctx = { services: { graph: b }, actor: "tom" } as never;
    assert.match(String(await graphUnmerge.run({ merge: again.merge } as never, ctx)), /^graph\/unmerge failed — REFUSED: .*cannot be undone safely/);
  });

  it("the steps merge and undo, stamping who did it", async () => {
    const ctx = { services: { graph: b }, actor: "tom" } as never;
    const out = (await graphMerge.run({ keep: kate, duplicate: katie } as never, ctx)) as Record<string, unknown>;
    assert.equal(out["status"], "Success");
    const rec = await b.query(`MATCH (n:Node {node_type: 'Merge'}) RETURN n.created_by AS by, n.kept_ref_id AS k, n.duplicate_ref_id AS d, n.merge_moves AS m`);
    assert.deepEqual([rec[0]!["by"], rec[0]!["k"], rec[0]!["d"]], ["tom", kate, katie]);
    const moves = JSON.parse(String(rec[0]!["m"]));
    assert.ok(moves.moved.every((m: { from: string; to: string }) => m.from && m.to && m.from !== m.to), "each moved edge's ref_id before and after");
    const back = (await graphUnmerge.run({ merge: out["merge"] } as never, ctx)) as Record<string, unknown>;
    assert.equal(back["restored"], katie);
  });

  it("refuses two types, two namespaces, and the user as the duplicate", async () => {
    await assert.rejects(mergeNodes(b, { keep: kate, duplicate: lisbon }), refused(/a Place cannot be merged into a Person/));
    const elsewhere = await person(b, { name: "Kate" }, "shared");
    await assert.rejects(mergeNodes(b, { keep: kate, duplicate: elsewhere }), refused(/different namespaces/));
    const me = await person(b, { name: "Tom Smith", is_owner: true });
    await assert.rejects(mergeNodes(b, { keep: sam, duplicate: me, by: "tom" }), refused(/the user cannot be merged into another node/));
    const out = await graphMerge.run({ keep: sam, duplicate: me } as never, { services: { graph: b } } as never);
    assert.match(String(out), /^graph\/merge failed — REFUSED: the user cannot be merged/);
  });

  it("a reader limited to shared can't merge private nodes", async () => {
    const shared = scopedBackend(b, { namespaces: ["shared"] });
    await assert.rejects(mergeNodes(shared, { keep: kate, duplicate: katie }), (e: unknown) => e instanceof MergeError && e.code === "NOT_FOUND");
    assert.equal((await b.reader.getNode(katie))?.ref_id, katie, "nothing was merged");
    // Its own nodes it can.
    const [x, y] = [await person(b, { name: "Ana" }, "shared"), await person(b, { name: "Ana" }, "shared")];
    assert.equal((await mergeNodes(shared, { keep: x, duplicate: y })).kept.ref_id, x);
    // And an undo of a private merge is nothing it can see.
    const r = await mergeNodes(b, { keep: kate, duplicate: katie });
    await assert.rejects(unmergeNodes(shared, { merge: r.merge }), (e: unknown) => e instanceof MergeError && e.code === "NOT_FOUND");
  });
});

describe("a write to a merged-away key lands on the kept node", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  before(async () => {
    b = (await lb.open({ embedder })) as LadybugBackend;
    await ontology(b);
  });
  after(() => lb.close(b));
  beforeEach(() => lb.clear(b));
  const lingo = (name: string, description?: string, mode: "create" | "upsert" = "create") =>
    b.nodes.write({ type: "Lingo", data: { name, ...(description ? { description } : {}) } }, mode);
  const row = async (ref_id: string) => (await b.query(`MATCH (n:Node {ref_id: $r}) RETURN n AS n`, { r: ref_id }))[0]!["n"] as Record<string, unknown>;
  const live = async (type: string) => (await b.query(`MATCH (n:Node {node_type: $t}) WHERE n.deleted_at IS NULL RETURN n.ref_id AS r`, { t: type })).map((r) => r["r"]);

  it("k8s merged into Kubernetes: writing k8s again updates Kubernetes, and k8s stays merged", async () => {
    const kube = (await lingo("Kubernetes", "container orchestration")).ref_id;
    const k8s = (await lingo("k8s", "short for it")).ref_id;
    const m = await mergeNodes(b, { keep: kube, duplicate: k8s });
    const kubeKey = (await row(kube))["key"];

    const created = await lingo("k8s");
    assert.deepEqual([created.ref_id, created.outcome], [kube, "existing"], "a create finds the kept node");
    const upserted = await lingo("k8s", "runs containers", "upsert");
    assert.deepEqual([upserted.ref_id, upserted.outcome, upserted.node_key], [kube, "updated", kubeKey]);
    assert.deepEqual(await live("Lingo"), [kube], "one node: the duplicate was not revived");
    const kept = await row(kube);
    assert.deepEqual([kept["name"], kept["title"], kept["key"], kept["description"]], ["Kubernetes", "Kubernetes", kubeKey, "runs containers"], "its own name and key, the written field");
    assert.match(String(kept["search_text"]), /Kubernetes/);
    assert.ok((await row(k8s))["deleted_at"] !== null, "the duplicate is as the merge left it");

    // The undo still works: the duplicate comes back as it was, the write stays on the kept node.
    await unmergeNodes(b, { merge: m.merge });
    assert.deepEqual((await live("Lingo")).sort(), [kube, k8s].sort());
    assert.equal((await row(k8s))["description"], "short for it");
    assert.equal((await row(kube))["description"], "runs containers");
    // Once undone, the key is k8s's own again.
    assert.equal((await lingo("k8s")).ref_id, k8s);
  });

  it("follows a chain of merges to the node in force", async () => {
    const [a, mid, c] = [(await lingo("a")).ref_id, (await lingo("b")).ref_id, (await lingo("c")).ref_id];
    await mergeNodes(b, { keep: mid, duplicate: a });
    await mergeNodes(b, { keep: c, duplicate: mid });
    const w = await lingo("a", "via b", "upsert");
    assert.equal(w.ref_id, c);
    assert.deepEqual(await live("Lingo"), [c]);
    assert.deepEqual([(await row(c))["name"], (await row(c))["description"]], ["c", "via b"]);
  });

  it("a node deleted but never merged is restored, as before", async () => {
    const helm = (await lingo("Helm")).ref_id;
    assert.ok(await b.nodes.deleteNode(helm));
    const w = await lingo("Helm");
    assert.deepEqual([w.ref_id, w.outcome], [helm, "restored"]);
    assert.equal((await row(helm))["deleted_at"] ?? null, null);
  });

  it("a Person named by a merged-away node's email lands on the kept node; undo keeps the write's stamp", async () => {
    const kate = await person(b, { name: "Kate Moss" });
    const katie = await person(b, { name: "Katie", email: "katie@example.com" });
    const m = await mergeNodes(b, { keep: kate, duplicate: katie });
    const stamped = (await row(kate))["updated_at"];
    const w = await b.nodes.write({ type: "Person", data: { name: "Katie", email: "katie@example.com", description: "a friend" } }, "upsert");
    assert.equal(w.ref_id, kate, "no second Person for the email");
    assert.deepEqual(await live("Person"), [kate]);
    const kept = await row(kate);
    assert.deepEqual([kept["name"], kept["email"], kept["description"], kept["alt_names"]], ["Kate Moss", "katie@example.com", "a friend", ["Katie"]]);
    assert.notEqual(kept["updated_at"], stamped);

    // Undo: the email now names both Kate and the revived Katie.
    await assert.rejects(unmergeNodes(b, { merge: m.merge }), refused(/katie@example.com/));
    await b.nodes.update(kate, { remove: ["email"] });
    const before = (await row(kate))["updated_at"];
    await unmergeNodes(b, { merge: m.merge });
    assert.deepEqual([(await row(kate))["alt_names"] ?? null, (await row(kate))["updated_at"]], [null, before], "alt_names set back, the later stamp kept");
    assert.equal((await row(katie))["deleted_at"] ?? null, null);
  });
});

describe("merge by the janitor", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let me: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    await ontology(b);
  });
  after(() => lb.close(b));
  beforeEach(async () => {
    await lb.clear(b);
    me = await person(b, { name: "Tom Smith", is_owner: true });
  });
  const janitor = (keep: string, duplicate: string) => mergeNodes(b, { keep, duplicate, by: SYSTEM_WRITER });

  it("two people sharing a first name stay two; into the user only on the full name", async () => {
    const [kateMoss, kateJones] = [await person(b, { name: "Kate Moss" }), await person(b, { name: "Kate Jones" })];
    await assert.rejects(janitor(kateMoss, kateJones), refused(/may only merge a pair the duplicates list offers/));
    const tom = await person(b, { name: "Tom" });
    await assert.rejects(janitor(me, tom), refused(/may only merge a pair the duplicates list offers/));
    const pairs = await duplicatePairs(b, "private");
    assert.ok(!pairs.some((p) => [p.a.ref_id, p.b.ref_id].includes(me) && [p.a.ref_id, p.b.ref_id].includes(tom)));
    // Anyone else may: a person or the assistant decides.
    assert.equal((await mergeNodes(b, { keep: kateMoss, duplicate: kateJones, by: "tom" })).kept.ref_id, kateMoss);

    const full = await person(b, { name: "Tom Smith" });
    assert.equal((await janitor(me, full)).kept.ref_id, me, "a Person with the user's full name");
    const tomS = await person(b, { name: "Tom S" });
    await assert.rejects(janitor(me, tomS), refused(/may (only merge a pair|merge into the user only)/));
    await assert.rejects(janitor(tomS, me), refused(/the user cannot be merged into another node/));
  });

  it(`stops at ${JANITOR_CAP} merges a day`, async () => {
    for (let i = 0; i < JANITOR_CAP; i++) {
      const [x, y] = [await person(b, { name: `Sam Lee ${i}` }), await person(b, { name: `Sam Lee ${i}` })];
      await janitor(x, y);
    }
    const [x, y] = [await person(b, { name: "Ana Ruiz" }), await person(b, { name: "Ana Ruiz" })];
    await assert.rejects(janitor(x, y), refused(new RegExp(`already merged ${JANITOR_CAP} pairs in the last 24 hours`)));
    assert.equal((await mergeNodes(b, { keep: x, duplicate: y, by: "tom" })).kept.ref_id, x, "the cap is the janitor's");
  });
});

describe("merge on Neo4j", { skip: neo4j.skip }, () => {
  let b: GraphBackend;
  before(async () => {
    b = await neo4j.open();
    await neo4j.wipe(b);
  });
  after(() => neo4j.close(b));

  it("is refused with a clear error, and nothing is written", async () => {
    const [x, y] = [await b.nodes.write({ type: "StrutWorkflow", data: { name: "a" } }), await b.nodes.write({ type: "StrutWorkflow", data: { name: "b" } })];
    await assert.rejects(mergeNodes(b, { keep: x.ref_id, duplicate: y.ref_id }), refused(/LadybugDB graph only: this graph is neo4j/));
    await assert.rejects(unmergeNodes(b, { merge: "m" }), refused(/LadybugDB graph only/));
    const ctx = { services: { graph: b } } as never;
    assert.match(String(await graphMerge.run({ keep: x.ref_id, duplicate: y.ref_id } as never, ctx)), /^graph\/merge failed — REFUSED: graph\/merge works on a LadybugDB graph only/);
    assert.ok(await b.reader.getNode(y.ref_id), "the duplicate is untouched");
  });

  it("a soft-deleted node is restored by a write of its key, as before", async () => {
    const x = await b.nodes.write({ type: "StrutWorkflow", data: { name: "revived" } });
    assert.ok(await b.nodes.softDelete(x.ref_id));
    const again = await b.nodes.write({ type: "StrutWorkflow", data: { name: "revived" } });
    assert.deepEqual([again.ref_id, again.outcome], [x.ref_id, "restored"]);
  });
});
