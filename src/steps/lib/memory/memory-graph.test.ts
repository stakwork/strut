import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryGraph, type MemoryBackend } from "../../../graph/memory/backend.js";
import { graphCtx } from "../graph/_shared.js";
import { memoryDb } from "./_db.js";
import { vocabulary } from "./_ontology.js";

// The graph/* read steps over a real memory file (src/graph/memory/backend.ts),
// called as the orchestrator's agent calls them. Skips where @ladybugdb/core
// does not load, as memory-steps.test.ts does.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("the graph read steps over the memory graph", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memory-graph-"));
  const file = join(dir, "db", "graph.lbug");
  const secrets = { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? file : undefined) };
  const wired = { kind: "ladybug", reader: { search: async () => assert.fail("the workspace graph was read") } };
  const services = { secrets, graph: wired, memoryGraph: { workflows: ["orchestrator"] } };
  const base = { runId: "test", scope: {}, input: undefined, emit: async () => {}, services };
  // An agent's tool call in an orchestrator turn: what reads memory.
  const turn = { ...base, workflow: "orchestrator", path: "orchestrator/turn/tool#1", agentTool: true } as unknown as StepContext;
  let run: (type: string, input: unknown, c?: StepContext) => Promise<any>;
  let b: MemoryBackend;
  const ids: Record<string, string> = {};
  const me = { type: "Self", name: "Tom" };
  const kate = { type: "Person", name: "Kate" };

  before(async () => {
    const { registry } = await buildRegistry();
    run = (type, input, c = turn) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
    const remember = (input: unknown) => run("memory/remember", input, { ...turn, workflow: "test", path: "test" } as StepContext);
    const tom = await remember({ episode: "My name is Tom.", facts: [{ subject: me, predicate: "name", text: "The user's name is Tom." }] });
    ids.self = tom.entities[0].ref_id;
    const k = await remember({
      episode: "Kate works at Acme and lives in Leeds. She used to play golf.",
      facts: [
        { subject: kate, predicate: "works_at", object: { type: "Organization", name: "Acme" }, text: "Kate works at Acme." },
        { subject: kate, predicate: "lives_in", object: { type: "Place", name: "Leeds" }, text: "Kate lives in Leeds." },
        { subject: kate, predicate: "prefers", text: "Kate plays golf.", ended: true },
      ],
    });
    ids.episode = k.episode;
    ids.kate = k.facts[0] && (await run("memory/get", { type: "Person", name: "Kate" })).ref_id;
    ids.acme = k.facts[0].ref_id;
    ids.leeds = k.facts[1].ref_id;
    ids.golf = k.facts[2].ref_id;
    const moved = await remember({
      episode: "Kate moved to York.",
      facts: [{ subject: kate, predicate: "lives_in", object: { type: "Place", name: "York" }, text: "Kate lives in York." }],
    });
    ids.york = moved.facts[0].ref_id;
    const bob = await remember({ episode: "Bob likes tea.", facts: [{ subject: { type: "Person", name: "Bob" }, predicate: "prefers", text: "Bob likes tea." }] });
    ids.bob = bob.entities[0].ref_id;
    await run("memory/forget", { ref_id: ids.bob, reason: "wrong person" }, { ...turn, workflow: "test" } as StepContext);
    // A hub: more facts on the user than one neighbors call returns.
    await remember({
      episode: "Things I like.",
      facts: Array.from({ length: 55 }, (_, i) => ({ subject: me, predicate: "prefers", text: `The user likes dish ${i}.` })),
    });
    b = await memoryGraph(turn);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("graphCtx hands the orchestrator's agent the memory backend, built once over memory's read connection", async () => {
    assert.equal(await graphCtx(turn as never), b);
    assert.equal(b.kind, "memory");
    assert.equal(await graphCtx({ ...turn, workflow: "job", path: "job/agent" } as never), wired, "a job reads the workspace");
  });

  it("graph-search finds entities and current facts, in the workspace graph's hit shape", async () => {
    const hits = await run("graph/graph-search", { q: "Kate" });
    const kateHit = hits.find((h: any) => h.ref_id === ids.kate);
    assert.deepEqual(Object.keys(kateHit).sort(), ["description", "edges", "name", "node_type", "ref_id"]);
    assert.equal(kateHit.node_type, "Person");
    assert.equal(kateHit.name, "Kate");
    assert.deepEqual(kateHit.edges, { MENTIONS: 2, SUBJECT: 2 }, "current facts (Acme, York) and episodes only: Leeds and golf are past");
    const york = hits.find((h: any) => h.ref_id === ids.york);
    assert.equal(york.node_type, "Fact");
    assert.equal(york.name, "Kate lives in York.", "a fact's name is its sentence");
    assert.match(york.description, /^Kate · lives_in → York/);
    assert.deepEqual(york.edges, { SUBJECT: 1, OBJECT: 1, FROM_EPISODE: 1 });
    for (const gone of [ids.leeds, ids.golf, ids.bob]) assert.ok(!hits.some((h: any) => h.ref_id === gone), `${gone}: superseded, ended or forgotten`);
    assert.deepEqual((await run("graph/graph-search", { q: "Kate", type: "Fact" })).map((h: any) => h.node_type), ["Fact", "Fact"]);
  });

  it("graph-search gives memory/recall's top hits", async () => {
    for (const q of ["Kate", "name", "York", "Acme", "Kate York", "dish 7", "golf", "Tom", "where does Kate live"]) {
      const recalled = (await run("memory/recall", { q, limit: 5 })).map((h: any) => h.ref_id);
      const searched = (await run("graph/graph-search", { q, limit: 5 })).map((h: any) => h.ref_id);
      assert.deepEqual(searched, recalled, q);
    }
  });

  it("the user is found by the type user, whatever the words", async () => {
    const hits = await run("graph/graph-search", { q: "user", type: "user" });
    assert.deepEqual(hits.map((h: any) => [h.ref_id, h.node_type]), [[ids.self, "Self"]]);
    const got = await run("graph/graph-get", { node_type: "user", name: "anything" });
    assert.equal(got.ref_id, ids.self);
    assert.equal(got.properties.user, true);
  });

  it("what search cannot honour comes back as warnings", async () => {
    const res = await b.reader.search({ q: "Kate", input_q: "x", linked: ["SUBJECT>Fact"], domains: ["strut"], namespace: "other" });
    assert.ok(res.nodes.length > 0);
    assert.deepEqual(res.warnings?.map((w) => w.replace(/^the memory graph cannot honour ([^;\s]+).*$/, "$1")), ["input_q", "linked", "domains", "namespace"]);
  });

  it("graph-get opens a node with its edge map; a superseded or ended fact is opened, flagged", async () => {
    const got = await run("graph/graph-get", { ref_id: ids.kate });
    assert.deepEqual(Object.keys(got).sort(), ["edges", "name", "node_type", "properties", "ref_id"]);
    assert.deepEqual(got.edges, { "<-MENTIONS": 2, "<-SUBJECT": 2 });
    assert.deepEqual(Object.keys(got.properties).sort(), ["aliases", "attributes", "created_at", "created_by", "name", "updated_at"]);
    const leeds = await run("graph/graph-get", { ref_id: ids.leeds });
    assert.equal(leeds.node_type, "Fact");
    assert.equal(leeds.properties.superseded, true);
    assert.ok(leeds.properties.expired_at);
    assert.deepEqual(leeds.edges, { SUBJECT: 1, OBJECT: 1, FROM_EPISODE: 1, "<-SUPERSEDES": 1 }, "a past fact leads to the current one that replaced it");
    const york0 = await run("graph/graph-get", { ref_id: ids.york });
    assert.equal(york0.edges["SUPERSEDES"], undefined, "never the other way: a past fact is not a neighbor");
    assert.equal((await run("graph/graph-get", { ref_id: ids.golf })).properties.invalid, true);
    const york = await run("graph/graph-get", { ref_id: ids.york });
    assert.equal(york.properties.superseded, undefined);
    assert.deepEqual(york.properties.subject, { ref_id: ids.kate, name: "Kate" });
    assert.equal(await run("graph/graph-get", { ref_id: ids.bob }), `node not found: ${ids.bob}`, "forgotten is never shown");
    const ep = await run("graph/graph-get", { ref_id: ids.episode });
    assert.equal(ep.node_type, "Episode");
    assert.match(ep.name, /^chat · \d{4}-\d{2}-\d{2}$/);
    assert.equal(ep.properties.content, "Kate works at Acme and lives in Leeds. She used to play golf.");
    const byName = await run("graph/graph-get", { node_type: "person", name: "kate" });
    assert.equal(byName.ref_id, ids.kate);
    assert.match(await run("graph/graph-get", { node_type: "Fact", name: "x" }), /keyed by nothing, not name/);
  });

  it("graph-get-batched resolves several, one bad ref_id failing alone", async () => {
    const out = await run("graph/graph-get-batched", { ref_ids: [ids.kate, ids.york, "nope"] });
    assert.deepEqual([out.requested, out.returned, out.truncated], [3, 3, false]);
    assert.deepEqual(out.nodes.map((n: any) => n.node_type ?? n.error), ["Person", "Fact", "node not found: nope"]);
  });

  it("graph-neighbors lists current neighbors with edge type and direction, at most 50", async () => {
    const around = await run("graph/graph-neighbors", { ref_id: ids.kate });
    assert.deepEqual(
      around.map((n: any) => [n.node_type, n.edge_type, n.direction]).sort(),
      [["Episode", "MENTIONS", "reverse"], ["Episode", "MENTIONS", "reverse"], ["Fact", "SUBJECT", "reverse"], ["Fact", "SUBJECT", "reverse"]],
    );
    assert.ok(!around.some((n: any) => n.ref_id === ids.leeds || n.ref_id === ids.golf));
    const fact = await run("graph/graph-neighbors", { ref_id: ids.york });
    assert.deepEqual(fact.map((n: any) => [n.name, n.edge_type, n.direction]).sort(), [["Kate", "SUBJECT", "forward"], ["York", "OBJECT", "forward"], [fact.find((n: any) => n.node_type === "Episode").name, "FROM_EPISODE", "forward"]].sort());
    const hub = await run("graph/graph-neighbors", { ref_id: ids.self });
    assert.equal(hub.length, 50, "56 current facts and 2 episodes, capped");
    assert.equal((await run("graph/graph-neighbors", { ref_id: ids.kate, node_type: ["Fact"] })).length, 2);
    assert.equal((await run("graph/graph-neighbors", { ref_id: ids.kate, edge_type: ["MENTIONS"] })).length, 2);
  });

  it("get-ontology reads the vocabulary: entity types as types, predicates as the Fact type's predicate values", async () => {
    const onto = await run("graph/get-ontology", { include_attributes: true, include_edges: true });
    assert.deepEqual(onto.domains, ["memory"]);
    const types = onto.node_types.memory.map((t: any) => t.type);
    for (const t of ["Self", "Person", "Organization", "Place", "Topic", "Fact", "Episode"]) assert.ok(types.includes(t), t);
    const self = onto.node_types.memory.find((t: any) => t.type === "Self");
    assert.match(self.description, /^The user/);
    assert.equal(self.attributes.role, "user");
    assert.equal(self.attributes.parent_type, "Person");
    assert.equal(self.attributes.type_aliases, "me, user, myself");
    const predicates: string = onto.node_types.memory.find((t: any) => t.type === "Fact").attributes.predicate;
    const vocab = await vocabulary(await memoryDb(turn));
    for (const p of vocab.terms.filter((t) => t.kind === "predicate")) assert.ok(predicates.includes(`\n${p.name} (`), p.name);
    assert.match(predicates, /\nlives_in \(Person → Place\) aka based_in, lives_at, home, resides_in: Where someone lives\. \[one value: a new fact replaces the current one\]/);
    assert.ok(onto.edges.some((e: any) => e.edge_type === "SUBJECT" && e.source_type === "Fact" && e.target_type === "*"));
    assert.deepEqual(await run("graph/get-ontology", { domains: "strut" }), { domains: [], node_types: {} });
    const user = await run("graph/get-ontology-type", { type: "user" });
    assert.equal(user.attributes.role, "user");
    assert.equal(typeof (await run("graph/get-ontology-type", { type: "fact" })).attributes.predicate, "string");
  });

  it("nothing writes: the writers and the engine refuse, and the file is unchanged", async () => {
    const sum = () => {
      const h = createHash("sha256");
      for (const f of readdirSync(join(dir, "db")).sort()) {
        const p = join(dir, "db", f);
        if (statSync(p).isFile()) h.update(f).update(readFileSync(p));
      }
      return h.digest("hex");
    };
    const before = sum();
    await run("graph/graph-search", { q: "Kate" });
    await run("graph/graph-get", { ref_id: ids.kate });
    await run("graph/graph-get-batched", { ref_ids: [ids.kate, ids.york] });
    await run("graph/graph-neighbors", { ref_id: ids.self });
    await run("graph/get-ontology", { include_attributes: true });
    await run("graph/get-ontology-type", { type: "Person" });
    assert.match(await run("graph/find", { node_type: "Person" }), /^graph\/find failed: read-only/);
    assert.match(await run("graph/create-node", { node_type: "Person", node_data: { name: "Zed" } }), /read-only/);
    assert.match(await run("graph/register-namespace", { namespace: "x" }), /read-only/);
    await assert.rejects(b.query(), /read-only/);
    assert.equal(sum(), before);
  });

  it("UserType is read as Self, says so, and proposes no type", async () => {
    const out = await run("memory/remember", {
      episode: "I like tea.",
      facts: [{ subject: { type: "UserType", name: "user" }, predicate: "prefers", text: "The user likes tea." }],
    }, { ...turn, workflow: "test", path: "test" } as StepContext);
    assert.equal(out.entities[0].ref_id, ids.self);
    assert.equal(out.entities[0].type, "Self");
    assert.deepEqual(out.ontology, { notes: ["UserType read as Self"] });
    const vocab = await vocabulary(await memoryDb(turn));
    assert.ok(!vocab.terms.some((t) => t.name === "UserType"));
    assert.equal(vocab.term("entity_type", "UserType"), undefined, "the stripping is lookup's, not the vocabulary's");
  });
});
