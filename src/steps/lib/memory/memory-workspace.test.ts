import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { createNodeSchema } from "../../../graph/schema-crud.js";
import { loadLadybug } from "../../../graph/ladybug/db.js";
import { runWalk } from "../graph/walk.js";
import { memoryOn } from "./_db.js";
import { migrateMemory } from "./_migrate.js";
import { BATCH, applyDump, dump, type Dump } from "./_snapshot.js";
import { NO_LADYBUG, memoryWorkspace, type MemoryWorkspace } from "./_test-workspace.js";

// Memory inside the workspace graph (plans/memory-in-workspace-graph.md, PR C):
// the move from its own file, the generic graph tools reading it, cross
// edges, the managed-type guard, decision 9's clash, and how long a home
// sync import holds the workspace's write lock.

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };
let registry: Record<string, unknown>;
const runIn = (ctx: StepContext) => (type: string, input: unknown) => {
  const def = registry[type] as StepDef;
  return def.run(def.input.parse(input), ctx);
};
before(async () => {
  ({ registry } = await buildRegistry());
});

// Memory's own file as the last strut before this one wrote it.
const OLD_SCHEMA = [
  `CREATE NODE TABLE Entity(ref_id STRING PRIMARY KEY, type STRING, name STRING, summary STRING,
     attributes STRING, aliases STRING[], created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64, deleted_reason STRING)`,
  `CREATE NODE TABLE Fact(ref_id STRING PRIMARY KEY, predicate STRING, text STRING, confidence DOUBLE,
     valid_at INT64, invalid_at INT64, expired_at INT64, created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64,
     deleted_reason STRING, value STRING, form STRING)`,
  `CREATE NODE TABLE Episode(ref_id STRING PRIMARY KEY, kind STRING, source STRING, content STRING,
     occurred_at INT64, created_by STRING, created_at INT64, updated_at INT64, deleted_at INT64, deleted_reason STRING, speaker STRING)`,
  "CREATE REL TABLE MENTIONS(FROM Episode TO Entity)",
  "CREATE REL TABLE SUBJECT(FROM Fact TO Entity)",
  "CREATE REL TABLE OBJECT(FROM Fact TO Entity)",
  "CREATE REL TABLE FROM_EPISODE(FROM Fact TO Episode)",
  "CREATE REL TABLE SUPERSEDES(FROM Fact TO Fact)",
  "CREATE REL TABLE CONTRADICTS(FROM Fact TO Fact)",
  "CREATE REL TABLE ALIAS_OF(FROM Entity TO Entity)",
  `CREATE NODE TABLE Ontology(key STRING PRIMARY KEY, kind STRING, name STRING, description STRING, status STRING, cardinality STRING,
     subject_types STRING[], object_types STRING[], aliases STRING[], created_by STRING, created_at INT64, updated_at INT64,
     parent STRING, naming STRING, role STRING)`,
];

async function oldMemoryFile(path: string): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  const lbug = await loadLadybug();
  const db = new lbug.Database(path);
  const conn = new lbug.Connection(db);
  for (const ddl of OLD_SCHEMA) await conn.query(ddl);
  for (const stmt of [
    `CREATE (:Ontology {key: 'entity_type:Self', kind: 'entity_type', name: 'Self', description: 'The user.', status: 'active', cardinality: '',
       subject_types: [], object_types: [], aliases: ['me', 'user'], parent: 'Person', naming: 'person', role: 'user'})`,
    `CREATE (:Ontology {key: 'entity_type:Gizmo', kind: 'entity_type', name: 'Gizmo', description: '', status: 'proposed', cardinality: '',
       subject_types: [], object_types: [], aliases: []})`,
    `CREATE (:Ontology {key: 'predicate:frobs', kind: 'predicate', name: 'frobs', description: '', status: 'proposed', cardinality: 'many',
       subject_types: ['Gizmo'], object_types: [], aliases: []})`,
    `CREATE (:Entity {ref_id: 'self', type: 'Self', name: 'Tom', summary: '', attributes: '{}', aliases: ['tom', 'tom smith'], created_by: 'agent', created_at: 1000, updated_at: 1500})`,
    `CREATE (:Entity {ref_id: 'kate', type: 'Person', name: 'Kate', summary: 'A friend.', attributes: '{"dictation":"off"}', aliases: ['kate', 'katie'], created_by: 'agent', created_at: 1100, updated_at: 1600})`,
    `CREATE (:Entity {ref_id: 'katie', type: 'Person', name: 'Katie', attributes: '{}', aliases: ['katie'], created_by: 'agent', created_at: 1150, updated_at: 1700,
       deleted_at: 1700, deleted_reason: 'merged into kate by agent'})`,
    `CREATE (:Entity {ref_id: 'leeds', type: 'Place', name: 'Leeds', aliases: ['leeds'], created_by: 'agent', created_at: 1200, updated_at: 1200})`,
    `CREATE (:Entity {ref_id: 'widget', type: 'Gizmo', name: 'Widget', aliases: ['widget'], created_by: 'agent', created_at: 1250, updated_at: 1250})`,
    // valid_at equal to created_at: record time an older strut stored as world time.
    `CREATE (:Fact {ref_id: 'f-york', predicate: 'lives_in', text: 'Kate lives in York.', confidence: 1.0, valid_at: 1300, invalid_at: 1400, expired_at: 1400, created_by: 'agent', created_at: 1300, updated_at: 1400})`,
    `CREATE (:Fact {ref_id: 'f-leeds', predicate: 'lives_in', text: 'Kate lives in Leeds.', confidence: 1.0, valid_at: 1390, created_by: 'agent', created_at: 1400, updated_at: 1400})`,
    `CREATE (:Fact {ref_id: 'f-heard', predicate: 'heard_as', text: 'Kate is heard as Cate.', value: 'cate', created_by: 'dictation', created_at: 1450, updated_at: 1460,
       deleted_at: 1460, deleted_reason: 'undone'})`,
    `CREATE (:Fact {ref_id: 'f-frobs', predicate: 'frobs', text: 'Widget frobs.', created_by: 'agent', created_at: 1470, updated_at: 1470})`,
    `CREATE (:Episode {ref_id: 'ep', kind: 'chat', source: '', content: 'Kate moved to Leeds.', occurred_at: 1400, speaker: 'self', created_by: 'agent', created_at: 1400, updated_at: 1400})`,
  ]) await conn.query(stmt);
  const edge = (rel: string, a: string, at: string, b: string, bt: string) =>
    conn.query(`MATCH (a:${at}), (b:${bt}) WHERE a.ref_id = '${a}' AND b.ref_id = '${b}' CREATE (a)-[:${rel}]->(b)`);
  await edge("SUBJECT", "f-york", "Fact", "kate", "Entity");
  await edge("SUBJECT", "f-leeds", "Fact", "kate", "Entity");
  await edge("OBJECT", "f-leeds", "Fact", "leeds", "Entity");
  await edge("SUBJECT", "f-heard", "Fact", "kate", "Entity");
  await edge("SUBJECT", "f-frobs", "Fact", "widget", "Entity");
  await edge("SUPERSEDES", "f-leeds", "Fact", "f-york", "Fact");
  await edge("CONTRADICTS", "f-leeds", "Fact", "f-york", "Fact");
  await edge("FROM_EPISODE", "f-leeds", "Fact", "ep", "Episode");
  await edge("MENTIONS", "ep", "Episode", "kate", "Entity");
  await edge("ALIAS_OF", "katie", "Entity", "kate", "Entity");
  await conn.close();
  await db.close();
}

describe("memory moves into the workspace graph at boot", { skip: NO_LADYBUG }, () => {
  let ws: MemoryWorkspace;
  let path: string;
  let run: ReturnType<typeof runIn>;
  before(async () => {
    ws = await memoryWorkspace();
    run = runIn(ws.ctx());
    path = join(ws.dir, "memory", "graph.lbug");
    await oldMemoryFile(path);
  });
  after(() => ws.close());

  it("copies every node, edge and term, keeping ref_ids and stamps, then renames the file", async () => {
    const out = await migrateMemory(ws.graph, ws.dir, {});
    assert.equal(out.status, "migrated");
    if (out.status !== "migrated") return;
    assert.equal(out.nodes, 10);
    assert.equal(out.edges, 9, "CONTRADICTS is dropped");
    assert.ok(!existsSync(path) && existsSync(`${path}.migrated`));
    // The backup is the file as it was (and its WAL): a memory that reads back the same.
    assert.ok(existsSync(out.backup));
    copyFileSync(out.backup, join(ws.dir, "restored.lbug"));
    if (existsSync(`${out.backup}.wal`)) copyFileSync(`${out.backup}.wal`, join(ws.dir, "restored.lbug.wal"));
    const { readOld } = await import("./_migrate.js");
    assert.equal((await readOld(join(ws.dir, "restored.lbug"))).nodes.length, 10);

    const user = await run("memory/get", { user: true });
    assert.equal(user.ref_id, "self");
    assert.deepEqual(user.aliases, ["tom", "tom smith"]);
    const kate = await run("memory/get", { ref_id: "katie" });
    assert.equal(kate.ref_id, "kate", "a merged-away id still leads to the entity kept");
    assert.deepEqual(kate.attributes, { dictation: "off" });
    assert.deepEqual(kate.facts.map((f: any) => [f.ref_id, f.object]), [["f-leeds", "Leeds"]]);
    const york = await run("memory/get", { ref_id: "f-york" });
    assert.equal(york.valid_at, undefined, "record time stored as world time is cleared");
    assert.equal(york.invalid_at, undefined);
    assert.deepEqual(york.superseded_by.map((f: any) => f.ref_id), ["f-leeds"]);
    const episode = await run("memory/get", { ref_id: "ep" });
    assert.deepEqual([episode.speaker?.ref_id, episode.mentions.map((m: any) => m.ref_id)], ["self", ["kate"]]);
    const lexicon = await run("memory/lexicon", {});
    assert.deepEqual(lexicon.undone.map((u: any) => [u.ref_id, u.undone_at]), [["f-heard", new Date(1460).toISOString()]]);
    const ontology = await run("memory/ontology", {});
    assert.equal(ontology.entity_types.find((t: any) => t.name === "Gizmo")?.status, "proposed");
    assert.equal(ontology.predicates.find((t: any) => t.name === "frobs")?.status, "proposed");
    const [stamp] = await ws.graph.lbug.query("MATCH (n:Node) WHERE n.ref_id = 'kate' RETURN n.updated_at AS u, n.created_at AS c");
    assert.deepEqual([Number(stamp!["u"]), Number(stamp!["c"])], [1600, 1100], "updated_at and created_at are the old file's");
  });

  it("is idempotent: a stamped file is only renamed, an unstamped one adds nothing twice", async () => {
    copyFileSync(`${path}.migrated`, path);
    assert.equal((await migrateMemory(ws.graph, ws.dir, {})).status, "renamed");
    await ws.graph.lbug.withWrite((tx) => tx.run("MATCH (m:Migration) WHERE m.migration_id STARTS WITH 'memory_migrated:' DELETE m"));
    copyFileSync(`${path}.migrated`, path);
    const again = await migrateMemory(ws.graph, ws.dir, {});
    assert.equal(again.status, "migrated");
    if (again.status === "migrated") assert.deepEqual([again.nodes, again.edges, again.skipped], [0, 0, 10]);
    assert.equal((await dump(await memoryOn(ws.graph))).nodes.length, 10);
  });

  it("a file it cannot read leaves the workspace without memory nodes and the file untouched", async () => {
    const other = await memoryWorkspace();
    try {
      const bad = join(other.dir, "memory", "graph.lbug");
      mkdirSync(join(bad, ".."), { recursive: true });
      writeFileSync(bad, "not a ladybug file");
      await assert.rejects(migrateMemory(other.graph, other.dir, {}));
      assert.equal(readFileSync(bad, "utf8"), "not a ladybug file");
      assert.equal((await dump(await memoryOn(other.graph))).nodes.length, 0);
      assert.equal((await migrateMemory(other.graph, join(other.dir, "nowhere"), {})).status, "none");
    } finally {
      await other.close();
    }
  });
});

describe("the graph tools read memory; only memory writes it", { skip: NO_LADYBUG }, () => {
  let ws: MemoryWorkspace;
  let remember: ReturnType<typeof runIn>;
  // The person's assistant (a host's memoryReaders, its sealed frame), and a job.
  const as = (workflow: string) => runIn({ ...ws.ctx({ memoryReaders: ["orchestrator"] }), path: `${workflow}/agent`, agentTool: true, frame: { workflow, sealed: true } } as unknown as StepContext);
  let concept: string;
  let out: any;
  before(async () => {
    ws = await memoryWorkspace();
    remember = runIn(ws.ctx());
    concept = (await ws.graph.nodes.write({ type: "Concept", data: { name: "Release train" } })).ref_id;
    out = await remember("memory/remember", {
      episode: "I work on the release train, and Kate lives in Leeds.",
      facts: [
        { subject: { type: "Self", name: "Tom" }, predicate: "works_on", object: { ref_id: concept, type: "Project", name: "Release train" }, text: "Tom works on the release train." },
        { subject: { type: "Person", name: "Kate" }, predicate: "lives_in", object: { type: "Place", name: "Leeds" }, text: "Kate lives in Leeds." },
      ],
    });
  });
  after(() => ws.close());

  it("a fact may point at a workflow node by ref_id: a cross edge, and nothing is mentioned of it", async () => {
    assert.equal(out.facts[0].status, "created");
    const fact = await remember("memory/get", { ref_id: out.facts[0].ref_id });
    assert.deepEqual(fact.object, { ref_id: concept, name: "Release train" });
    assert.ok(!out.entities.some((e: any) => e.ref_id === concept));
    assert.equal((await ws.graph.lbug.query("MATCH (n:Node) WHERE n.node_type = 'Project' RETURN n.ref_id AS id")).length, 0, "no Project was made for it");
  });

  it("graph-search finds memory's nodes by type for the assistant, never for a job, and Episodes only when asked", async () => {
    const leeds = await as("orchestrator")("graph/graph-search", { q: "Leeds", type: "Place" });
    assert.deepEqual(leeds.map((n: any) => n.name), ["Leeds"]);
    assert.deepEqual(await as("job")("graph/graph-search", { q: "Leeds", type: "Place" }), []);
    const untyped = await as("orchestrator")("graph/graph-search", { q: "release train Leeds" });
    assert.ok(untyped.some((n: any) => n.node_type === "Fact"), JSON.stringify(untyped));
    assert.ok(!untyped.some((n: any) => n.node_type === "Episode"), "Episodes stay out of a search that does not ask");
    const episodes = await as("orchestrator")("graph/graph-search", { q: "release train", type: "Episode" });
    assert.deepEqual(episodes.map((n: any) => n.ref_id), [out.episode]);
  });

  it("walk goes from the user to the workflow node through the cross edge", async () => {
    const self = (await remember("memory/get", { user: true })).ref_id;
    const expandAll = async ({ questions }: any) => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, q]: [string, any]) => [
          id,
          q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none" } : { type: "boolean", probability: id === "sufficient" ? 0 : 0.9 },
        ]),
      ),
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const walked = await runWalk({ goal: "what does Tom work on?", start: [self], maxHops: 3, maxNodes: 20, threshold: 0.5 } as any, { reader: ws.graph.reader, evaluate: expandAll as any });
    assert.ok(walked.nodes.some((n) => n.ref_id === concept), JSON.stringify(walked.nodes.map((n) => n.ref_id)));
  });

  it("a generic graph write is refused on a Fact, even for the assistant", async () => {
    const fact = out.facts[1].ref_id;
    for (const [type, input] of [
      ["graph/edit-node", { ref_id: fact, node_data: { text: "Kate lives in Bath." } }],
      ["graph/create-node", { node_type: "Fact", node_data: { predicate: "lives_in", text: "x", created_at: 1 } }],
      ["graph/delete-node", { ref_id: fact }],
    ] as const) {
      const res = await as("orchestrator")(type, input);
      assert.match(JSON.stringify(res), /MANAGED|managed by memory|not_found|NOT_FOUND/i, `${type}: ${JSON.stringify(res)}`);
    }
    assert.equal((await remember("memory/get", { ref_id: fact })).text, "Kate lives in Leeds.");
  });

  it("a type spelled with a trailing Type (UserType) is the type without it, never a new one", async () => {
    const self = (await remember("memory/get", { user: true })).ref_id;
    const said = await remember("memory/remember", { episode: "I like tea.", facts: [{ subject: { type: "UserType", name: "Tom" }, predicate: "prefers", text: "Tom likes tea." }] });
    assert.equal(said.entities[0].ref_id, self);
    assert.equal(said.ontology?.proposed, undefined);
  });

  it("remember proposing a type an app owns creates nothing, and notes it", async () => {
    await createNodeSchema(ws.graph, ws.graph.schemas, { type: "Channel", parent: "Thing", attributes: { name: "string" } });
    const before = (await ws.graph.lbug.query("MATCH (n:Node) WHERE n.node_type = 'Channel' RETURN count(n) AS n"))[0]!["n"];
    const said = await remember("memory/remember", {
      episode: "Post it in #general.",
      mentions: [{ type: "Channel", name: "#general" }],
      facts: [{ subject: { type: "Self", name: "Tom" }, predicate: "prefers", object: { type: "Channel", name: "#general" }, text: "Tom prefers #general." }],
    });
    assert.ok(!said.entities.some((e: any) => e.type === "Channel"));
    assert.equal(said.facts[0].status, "skipped");
    assert.ok(said.ontology.notes.some((n: string) => /Channel is the workspace's type/.test(n)), JSON.stringify(said.ontology));
    assert.equal((await ws.graph.lbug.query("MATCH (n:Node) WHERE n.node_type = 'Channel' RETURN count(n) AS n"))[0]!["n"], before);
    const [row] = await ws.graph.lbug.query("MATCH (n:Node) WHERE n.node_type = 'Schema' AND n.type = 'Channel' RETURN n.managed_by AS m");
    assert.equal(row!["m"], null, "the app's type is left as it was");
  });
});

describe("a home sync import holds the write lock per batch only", { skip: NO_LADYBUG }, () => {
  let box: MemoryWorkspace;
  let copy: MemoryWorkspace;
  before(async () => {
    [box, copy] = [await memoryWorkspace(), await memoryWorkspace()];
  });
  after(async () => {
    await box.close();
    await copy.close();
  });

  /** A memory of `people` entities, each with two facts and an episode in every tenth. */
  function seeded(people: number): Dump {
    const nodes: Dump["nodes"] = [];
    const edges: Dump["edges"] = [];
    for (let i = 0; i < people; i++) {
      const at = 1_000_000 + i;
      nodes.push({ ref_id: `p${i}`, node_type: "Person", attributes: { memory_entity: true, name: `Person ${i}`, alias_keys: [`person ${i}`], attributes_json: "{}", created_by: "agent", created_at: at }, updated_at: at });
      for (const k of [0, 1]) {
        nodes.push({ ref_id: `f${i}-${k}`, node_type: "Fact", attributes: { predicate: "prefers", text: `Person ${i} prefers thing ${k}.`, confidence: 1, created_by: "agent", created_at: at }, updated_at: at });
        edges.push({ edge: "SUBJECT", from: `f${i}-${k}`, to: `p${i}` });
      }
      if (i % 10 === 0) {
        nodes.push({ ref_id: `e${i}`, node_type: "Episode", attributes: { kind: "chat", content: `Person ${i} said things.`, occurred_at: at, created_by: "agent", created_at: at }, updated_at: at });
        edges.push({ edge: "MENTIONS", from: `e${i}`, to: `p${i}` });
      }
    }
    return { nodes, edges, terms: [] };
  }

  it("imports a seeded memory in bounded batches while a run projects, skipping unchanged nodes the second time", async (t) => {
    const people = 800;
    const target = seeded(people);
    await applyDump(await memoryOn(box.graph), target, { nodes: [], edges: [], terms: [] }, { single: true });
    const exported = await runIn(box.ctx())("memory/export", { inline: true });
    // A run projecting meanwhile: one small write after another on the copy's workspace.
    let projecting = true;
    const waits: number[] = [];
    const projector = (async () => {
      for (let i = 0; projecting; i++) {
        const t0 = performance.now();
        await copy.graph.nodes.write({ type: "Concept", data: { name: `projected ${i}` } });
        waits.push(performance.now() - t0);
      }
    })();
    const t0 = performance.now();
    const loaded = await runIn(copy.ctx())("memory/import", { data: exported.data });
    const total = performance.now() - t0;
    projecting = false;
    await projector;
    assert.ok(!loaded.error, loaded.error);
    const holds: number[] = loaded.applied.lock_ms;
    const nodes = target.nodes.length;
    const sorted = [...waits].sort((a, b) => a - b);
    const p = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
    t.diagnostic(
      `import of ${nodes} nodes / ${target.edges.length} edges: ${holds.length} transactions, lock held max ${Math.max(...holds)} ms, ` +
        `median ${[...holds].sort((a, b) => a - b)[Math.floor(holds.length / 2)]} ms, total ${Math.round(total)} ms; ` +
        `${waits.length} projector writes meanwhile, wait p50 ${p(0.5)} ms, p99 ${p(0.99)} ms, max ${p(1)} ms`,
    );
    assert.equal(loaded.applied.created, nodes);
    assert.ok(holds.length >= Math.ceil(nodes / BATCH), `at most ${BATCH} nodes a transaction`);
    assert.ok(waits.length > holds.length, "the projector wrote between batches");
    assert.equal(loaded.counts.Entity, people);
    // The copy's own node is left alone.
    assert.ok((await copy.graph.lbug.query("MATCH (n:Node) WHERE n.node_type = 'Concept' RETURN count(n) AS n"))[0]!["n"] > 0);

    const again = await runIn(copy.ctx())("memory/import", { data: exported.data, replace: true });
    assert.equal(again.applied.created, 0);
    assert.equal(again.applied.updated, 0);
    assert.equal(again.applied.unchanged, nodes);
    const hash = (await runIn(copy.ctx())("memory/export", { inline: true })).content_hash;
    assert.equal(hash, exported.content_hash, "the copy exports what the box did");
    assert.ok(readdirSync(join(copy.dir, "memory", "backups")).length === 1);
  });
});
