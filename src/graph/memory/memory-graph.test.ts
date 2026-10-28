import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "../../core.js";
import { buildRegistry } from "../../steps/registry.js";
import { memoryDb, memoryWrite } from "../../steps/lib/memory/_db.js";
import { runWalk } from "../../steps/lib/graph/walk.js";
import { graphCtx } from "../../steps/lib/graph/_shared.js";
import type { Evaluate } from "../../evaluate.js";
import { createMemoryGraph } from "./backend.js";

// Against a real LadybugDB in a temp folder, read through the generic graph/*
// steps with a ctx whose workflow is `orchestrator` and a memory graph on the
// bag. @ladybugdb/core is an optional dependency; where it does not load, skip.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("the read-only memory graph behind graph/*", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-memgraph-"));
  const dbFile = join(dir, "db", "graph.lbug");
  const mkCtx = (file: string, workflow = "orchestrator") => {
    const services: Record<string, unknown> = { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? file : undefined) } };
    services["memoryGraph"] = createMemoryGraph(() => services);
    return { runId: "t", path: `${workflow}/turn`, workflow, scope: {}, input: undefined, emit: async () => {}, services } as unknown as StepContext;
  };
  const ctx = mkCtx(dbFile);
  const plain = { ...mkCtx(dbFile, "job"), services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? dbFile : undefined) } } } as unknown as StepContext;
  let run: (type: string, input: unknown, c?: StepContext) => Promise<any>;
  const ids: Record<string, string> = {};
  const me = { type: "Self", name: "Me" };

  before(async () => {
    const { registry } = await buildRegistry();
    run = (type, input, c = ctx) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("with no memory file yet every read is empty, the ontology is the seeded vocabulary, and nothing is created", async () => {
    const empty = mkCtx(join(dir, "none", "graph.lbug"));
    assert.deepEqual(await run("graph/graph-search", { q: "Kate" }, empty), []);
    assert.match(await run("graph/graph-get", { ref_id: "nope" }, empty), /node not found/);
    assert.deepEqual(await run("graph/graph-neighbors", { ref_id: "nope" }, empty), []);
    const onto = await run("graph/get-ontology", {}, empty);
    assert.ok(onto.node_types.entity.some((t: any) => t.type === "Self"));
    assert.ok(onto.node_types.predicate.some((t: any) => t.type === "works_at"));
    assert.equal(existsSync(join(dir, "none")), false, "a read creates no file or folder");
  });

  it("seeds a memory through memory/remember", async () => {
    const a = await run("memory/remember", {
      episode: "My name is Tom.",
      facts: [{ subject: me, predicate: "name", text: "The user's name is Tom." }],
    }, plain);
    ids.self = a.entities[0].ref_id;
    ids.tom = a.facts[0].ref_id;
    const b = await run("memory/remember", {
      episode: "Actually, call me Thomas.",
      facts: [{ subject: me, predicate: "name", text: "The user's name is Thomas." }],
    }, plain);
    ids.thomas = b.facts[0].ref_id;
    const c = await run("memory/remember", {
      episode: "Kate works at Acme and likes cooking.",
      facts: [
        { subject: { type: "Person", name: "Kate" }, predicate: "works_at", object: { type: "Organization", name: "Acme" }, text: "Kate works at Acme." },
        { subject: { type: "Person", name: "Kate" }, predicate: "prefers", text: "Kate likes cooking." },
      ],
    }, plain);
    ids.kate = c.entities.find((e: any) => e.name === "Kate").ref_id;
    ids.acme = c.entities.find((e: any) => e.name === "Acme").ref_id;
    ids.works = c.facts[0].ref_id;
    ids.cooks = c.facts[1].ref_id;
    const d = await run("memory/remember", {
      episode: "Kate also plays chess.",
      facts: [{ subject: { type: "Person", name: "Kate" }, predicate: "interested_in", text: "Kate plays chess." }],
    }, plain);
    ids.chess = d.facts[0].ref_id;
  });

  // Row counts and the newest write, to prove no graph call touches the file.
  const fingerprint = async () => {
    const q = await memoryDb(plain);
    const out: unknown[] = [];
    for (const t of ["Entity", "Fact", "Episode", "Ontology"]) out.push((await q(`MATCH (n:${t}) RETURN count(n) AS n`))[0]!.n);
    out.push((await q("MATCH (f:Fact) RETURN max(f.updated_at) AS m, sum(f.created_at) AS s"))[0]);
    return JSON.stringify(out, (_, v) => (typeof v === "bigint" ? Number(v) : v));
  };
  let before0: string;

  it("graph-search finds entities and facts, with the same top hits as memory/recall", async () => {
    before0 = await fingerprint();
    for (const q of ["Kate", "Kate cooking", "name", "Acme", "chess"]) {
      const recall = await run("memory/recall", { q }, plain);
      const hits = await run("graph/graph-search", { q }, ctx);
      assert.deepEqual(hits.map((h: any) => h.ref_id), recall.map((h: any) => h.ref_id), `same hits, same order: ${q}`);
    }
    const kate = await run("graph/graph-search", { q: "Kate" });
    assert.equal(kate[0].node_type, "Person");
    assert.equal(kate[0].name, "Kate");
    assert.ok(kate.some((h: any) => h.node_type === "Fact" && h.name === "Kate works at Acme."), "a fact is found, named by its sentence");
    assert.ok(kate[0].edges["<-SUBJECT"] >= 2, JSON.stringify(kate[0].edges));
    const facts = await run("graph/graph-search", { q: "Kate", type: "Fact" });
    assert.ok(facts.length >= 3 && facts.every((h: any) => h.node_type === "Fact"));
    assert.match(facts[0].description, /Kate · /);
  });

  it("a type filter resolves the vocabulary's aliases: 'user' finds the user's node", async () => {
    const hits = await run("graph/graph-search", { q: "Me", type: "user" });
    assert.ok(hits.some((h: any) => h.ref_id === ids.self), "the user's node is found");
    assert.ok(hits.every((h: any) => h.node_type === "Self"));
    const viaMe = await run("graph/graph-search", { q: "Me", type: "Myself, Topic" });
    assert.ok(viaMe.some((h: any) => h.ref_id === ids.self), "any alias, in a list, finds the user node");
    assert.deepEqual(await run("graph/graph-search", { q: "Kate", type: "Organization" }), [], "an entity type filter excludes other types");
  });

  it("superseded facts are hidden from search; graph-get by ref_id still returns one", async () => {
    const hits = await run("graph/graph-search", { q: "name", type: "Fact" });
    assert.deepEqual(hits.map((h: any) => h.ref_id), [ids.thomas]);
    const old = await run("graph/graph-get", { ref_id: ids.tom });
    assert.equal(old.node_type, "Fact");
    assert.equal(old.name, "The user's name is Tom.");
    assert.equal(old.properties.current, false);
    assert.ok(old.properties.expired_at);
    assert.equal(old.properties.predicate, "name");
  });

  it("graph-get by ref_id from a remember result, by type + name, and the user by any name", async () => {
    const kate = await run("graph/graph-get", { ref_id: ids.kate });
    assert.equal(kate.node_type, "Person");
    assert.equal(kate.name, "Kate");
    assert.deepEqual(kate.properties.aliases, ["kate"]);
    assert.equal(kate.edges["<-SUBJECT"], 3, "three held facts about her");
    const byName = await run("graph/graph-get", { node_type: "Person", name: "kate" });
    assert.equal(byName.ref_id, ids.kate);
    const user = await run("graph/graph-get", { node_type: "user", name: "user" });
    assert.equal(user.ref_id, ids.self, "type alias user + name user");
    assert.match(await run("graph/graph-get", { node_type: "Person", name: "Nobody" }), /not found/);
    assert.match(await run("graph/graph-get", { node_type: "Fact", name: "x" }), /keyed by ref_id/);
    const fact = await run("graph/graph-get", { ref_id: ids.works });
    assert.equal(fact.properties.subject, "Kate");
    assert.equal(fact.properties.object, "Acme");
    assert.equal(fact.edges["SUBJECT"], 1);
    assert.equal(fact.edges["OBJECT"], 1);
    assert.equal(fact.edges["FROM_EPISODE"], 1);
    assert.deepEqual((await run("graph/graph-get", { ref_id: ids.kate, children: "SUBJECT" })).children, [], "forward SUBJECT: an entity is nobody's source");
    const toc = await run("graph/graph-get", { ref_id: ids.works, children: "SUBJECT" });
    assert.deepEqual(toc.children.map((c: any) => [c.ref_id, c.node_type, c.name]), [[ids.kate, "Person", "Kate"]]);
  });

  it("graph-get-batched resolves several, one bad ref_id failing alone", async () => {
    const out = await run("graph/graph-get-batched", { ref_ids: [ids.kate, ids.works, "missing", ids.tom] });
    assert.equal(out.returned, 4);
    assert.deepEqual(out.nodes.map((n: any) => n.node_type ?? n.error?.slice(0, 14)), ["Person", "Fact", "node not found", "Fact"]);
  });

  it("graph-neighbors: an entity's held facts and episodes; a fact's subject, object and episode, with edge_type and direction", async () => {
    const fromKate = await run("graph/graph-neighbors", { ref_id: ids.kate });
    const facts = fromKate.filter((n: any) => n.node_type === "Fact");
    assert.deepEqual(facts.map((n: any) => n.ref_id).sort(), [ids.works, ids.cooks, ids.chess].sort());
    assert.ok(facts.every((n: any) => n.edge_type === "SUBJECT" && n.direction === "reverse"));
    const episodes = fromKate.filter((n: any) => n.node_type === "Episode");
    assert.ok(episodes.length >= 1 && episodes.every((n: any) => n.edge_type === "MENTIONS" && n.direction === "reverse"));
    assert.ok(facts.find((n: any) => n.ref_id === ids.works).name === "Kate works at Acme.");
    // Narrowed by node type and edge type.
    const onlyFacts = await run("graph/graph-neighbors", { ref_id: ids.kate, node_type: ["Fact"], edge_type: ["SUBJECT"] });
    assert.equal(onlyFacts.length, 3);

    const fromFact = await run("graph/graph-neighbors", { ref_id: ids.works });
    const by = (t: string) => fromFact.find((n: any) => n.edge_type === t);
    assert.deepEqual([by("SUBJECT").ref_id, by("SUBJECT").direction, by("SUBJECT").node_type], [ids.kate, "forward", "Person"]);
    assert.deepEqual([by("OBJECT").ref_id, by("OBJECT").direction, by("OBJECT").node_type], [ids.acme, "forward", "Organization"]);
    assert.deepEqual([by("FROM_EPISODE").direction, by("FROM_EPISODE").node_type], ["forward", "Episode"]);
  });

  it("a superseded fact is out of the entity's neighbors, but SUPERSEDES leads to it", async () => {
    const fromSelf = await run("graph/graph-neighbors", { ref_id: ids.self });
    const factIds = fromSelf.filter((n: any) => n.node_type === "Fact").map((n: any) => n.ref_id);
    assert.deepEqual(factIds, [ids.thomas], "the held name only");
    const fromThomas = await run("graph/graph-neighbors", { ref_id: ids.thomas, edge_type: ["SUPERSEDES"] });
    assert.deepEqual(fromThomas.map((n: any) => [n.ref_id, n.direction]), [[ids.tom, "forward"]]);
    const fromOld = await run("graph/graph-neighbors", { ref_id: ids.tom });
    assert.ok(fromOld.some((n: any) => n.ref_id === ids.thomas && n.edge_type === "SUPERSEDES" && n.direction === "reverse"));
    assert.ok(fromOld.some((n: any) => n.ref_id === ids.self && n.edge_type === "SUBJECT"), "an old fact still reaches its subject");
  });

  it("get-ontology lists the entity types and the predicates with their cardinality; get-ontology-type returns one", async () => {
    const onto = await run("graph/get-ontology", { include_edges: true, include_attributes: true });
    assert.deepEqual(onto.domains, ["entity", "memory", "predicate"]);
    const self = onto.node_types.entity.find((t: any) => t.type === "Self");
    assert.match(self.description, /user/i);
    assert.match(self.description, /Also called: me, user, myself/);
    assert.equal(self.attributes.role, "user");
    assert.equal(self.attributes.parent, "Person");
    const works = onto.node_types.predicate.find((t: any) => t.type === "works_at");
    assert.match(works.description, /Cardinality: one — a new fact replaces the current one/);
    assert.match(works.description, /Person → Organization/);
    const works_on = onto.node_types.predicate.find((t: any) => t.type === "works_on");
    assert.match(works_on.description, /Cardinality: many/);
    assert.ok(onto.node_types.memory.some((t: any) => t.type === "Fact") && onto.node_types.memory.some((t: any) => t.type === "Episode"));
    assert.ok(onto.edges.some((e: any) => e.edge_type === "SUBJECT" && e.source_type === "Fact"));
    // The proposed vocabulary a write created is listed too.
    const lean = await run("graph/get-ontology", { domains: "predicate" });
    assert.deepEqual(Object.keys(lean.node_types), ["predicate"]);
    const one = await run("graph/get-ontology-type", { type: "WORKS_AT" });
    assert.equal(one.attributes.cardinality, "one — a new fact replaces the current one");
    assert.equal(one.attributes.subject_types, "Person");
    const user = await run("graph/get-ontology-type", { type: "user" });
    assert.equal(user.attributes.role, "user", "an alias finds the type");
    assert.ok((await run("graph/get-ontology-type", { type: "Fact" })).attributes.predicate);
    assert.match(await run("graph/get-ontology-type", { type: "Nope" }), /unknown type/);
  });

  it("a forgotten fact is gone from search, neighbors and graph-get", async () => {
    await run("memory/forget", { ref_id: ids.chess, reason: "test" }, plain);
    assert.deepEqual((await run("graph/graph-search", { q: "chess" })).map((h: any) => h.ref_id), []);
    assert.ok(!(await run("graph/graph-neighbors", { ref_id: ids.kate })).some((n: any) => n.ref_id === ids.chess));
    assert.match(await run("graph/graph-get", { ref_id: ids.chess }), /node not found/);
    assert.equal((await run("graph/graph-get", { ref_id: ids.kate })).edges["<-SUBJECT"], 2);
  });

  it("graph/walk over the memory reader gathers the related facts", async () => {
    const backend = await graphCtx(ctx);
    // Everything relevant, never sufficient: it walks to the hop limit.
    const evaluate: Evaluate = async ({ state, questions }) => {
      const answers: Record<string, any> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (id.startsWith("relevant_")) answers[id] = { type: "boolean", probability: 0.9 };
        else if (id === "next" && q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none" };
        else if (id === "sufficient") answers[id] = { type: "boolean", probability: 0 };
      }
      void state;
      return { answers: answers as any, usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 2 } };
    };
    const out = await runWalk({ goal: "where does Kate work?", start: [ids.kate], maxHops: 3, maxNodes: 25, threshold: 0.5 }, { reader: backend.reader, evaluate });
    const kept = out.nodes.map((n) => n.ref_id);
    assert.ok(kept.includes(ids.kate) && kept.includes(ids.works) && kept.includes(ids.cooks), kept.join(","));
    assert.ok(!kept.includes(ids.chess) && !kept.includes(ids.tom), "forgotten and superseded facts are not walked");
    const w = out.nodes.find((n) => n.ref_id === ids.works)!;
    assert.deepEqual([w.via?.from, w.via?.edge_type, w.via?.direction], [ids.kate, "SUBJECT", "reverse"]);
    // By query: the walk seeds from graph-search.
    const q = await runWalk({ goal: "where does Kate work?", query: "Acme", maxHops: 1, maxNodes: 10, threshold: 0.5 }, { reader: backend.reader, evaluate });
    assert.ok(q.nodes.some((n) => n.ref_id === ids.acme));
  });

  it("no graph call wrote to the memory file, and the backend has no writers", async () => {
    // The forget above is memory's own write (a soft delete: no row is added or removed).
    assert.deepEqual(JSON.parse(await fingerprint()).slice(0, 4), JSON.parse(before0).slice(0, 4), "row counts unchanged");
    const b = await graphCtx(ctx);
    assert.throws(() => b.nodes, /read-only/);
    assert.throws(() => b.edges, /read-only/);
    assert.throws(() => b.query, /read-only/);
    await assert.rejects(b.reader.registerNamespace("x"), /read-only/);
    await assert.rejects(b.reader.search({ q: "Kate", namespace: "other" }), /one namespace/);
    assert.deepEqual(await b.reader.listNamespaces(), []);
    // Ladybug write transactions from the memory file itself still work: nothing is held open.
    await memoryWrite(plain, async (q) => void (await q("MATCH (e:Entity) RETURN count(e)")));
  });
});
