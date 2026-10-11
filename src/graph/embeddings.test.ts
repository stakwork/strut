import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bolt, int } from "./bolt.js";
import { seedStrutDomain } from "./schema-seed.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { NodeWriter, buildSearchText, type Embedder } from "./node-writer.js";
import { EMBEDDING_DIM, EmbeddingPass, MiniLMEmbedder, WorkerEmbedder, cosine, decideRow, meanPoolNormalize } from "./embeddings.js";
import { SchemaResolver, fromStrut } from "./schema-resolver.js";
import { getStrutSchema } from "./strut-schemas.js";
import { openGraphBackend } from "./backend.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { coreRegistry } from "../steps/registry.js";
import { createStrut } from "../createStrut.js";
import { graphSnapshot, testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();
const runModel = process.env["STRUT_TEST_EMBEDDINGS"] === "1";

interface Golden {
  model: string;
  max_seq_length: number;
  vectors: Record<string, number[]>;
  texts: Record<string, string>;
}
const golden = JSON.parse(readFileSync(new URL("./fixtures/minilm-golden.json", import.meta.url), "utf8")) as Golden;

describe("meanPoolNormalize (pure)", () => {
  it("averages masked positions and L2-normalizes", () => {
    // batch=1, seq=3, dim=2; third position masked out.
    const hidden = new Float32Array([1, 0, 0, 1, 100, 100]);
    const [v] = meanPoolNormalize(hidden, [1, 3, 2], [1, 1, 0]);
    assert.ok(Math.abs(v![0]! - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(v![1]! - Math.SQRT1_2) < 1e-6);
  });
  it("golden fixture is the model jarvis uses, at 256 tokens", () => {
    assert.equal(golden.model, "sentence-transformers/all-MiniLM-L6-v2");
    assert.equal(golden.max_seq_length, 256);
    assert.equal(golden.vectors["short"]!.length, EMBEDDING_DIM);
  });
});

describe("MiniLMEmbedder parity vs sentence-transformers", { skip: runModel ? false : "STRUT_TEST_EMBEDDINGS=1 not set (downloads the model)" }, () => {
  let embedder: MiniLMEmbedder;
  before(async () => {
    embedder = await MiniLMEmbedder.load();
  });

  it("matches the Python golden vectors (cosine ≥ 0.999), including the >256-token truncation case", async () => {
    const keys = Object.keys(golden.texts);
    const vectors = await embedder.embed(keys.map((k) => golden.texts[k]!));
    keys.forEach((k, i) => {
      const c = cosine(vectors[i]!, golden.vectors[k]!);
      assert.ok(c >= 0.999, `${k}: cosine ${c}`);
      assert.equal(vectors[i]!.length, EMBEDDING_DIM);
      const norm = Math.sqrt(vectors[i]!.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 1e-4, `${k}: not unit length (${norm})`);
    });
  });

  it("truncation actually happens at 256 tokens (a 512-cap vector would differ)", async () => {
    const long = golden.texts["long_truncated"]!;
    const [truncated] = await embedder.embed([long]);
    // The same text with its tail removed past token 256 must embed
    // identically; cut generously short and it must not.
    const words = long.split(" ");
    const [head] = await embedder.embed([words.slice(0, 40).join(" ")]);
    assert.ok(cosine(truncated!, head!) < 0.999, "40-word prefix should differ from the 256-token vector");
    assert.ok(cosine(truncated!, golden.vectors["long_truncated"]!) >= 0.999);
  });

  it("in a worker thread (the pass's), the same vectors", async () => {
    const worker = new WorkerEmbedder();
    try {
      const texts = Object.values(golden.texts);
      const [inline, inWorker] = [await embedder.embed(texts), await worker.embed(texts)];
      inline.forEach((v, i) => assert.ok(cosine(v, inWorker[i]!) >= 0.99999, `${i}: cosine ${cosine(v, inWorker[i]!)}`));
    } finally {
      await worker.close();
    }
  });
});

describe("decideRow (pure)", () => {
  const index = ["name", "summary", "description"];
  it("stale when the stored text is not the composed one, or the vector is missing", () => {
    assert.deepEqual(decideRow(index, { text: "POST", values: ["POST", null, "Creates a thing"], unembedded: false }), { text: "POST\nCreates a thing", fields: ["name", "description"] });
    assert.equal(decideRow(index, { text: "POST\nCreates a thing", values: ["POST", null, "Creates a thing"], unembedded: false }), "clean");
    assert.deepEqual(decideRow(index, { text: "POST\nCreates a thing", values: ["POST", null, "Creates a thing"], unembedded: true }), { text: "POST\nCreates a thing", fields: ["name", "description"] });
  });
  it("blank when every index field is blank — never jarvis's catch-all text", () => {
    assert.equal(decideRow(index, { text: "x", values: ["  ", null, ""], unembedded: true }), "blank");
    assert.equal(decideRow(index, { text: null, values: [null, null, null], unembedded: true }), "blank");
  });
  it("renders a list-valued field as the writer does", () => {
    assert.deepEqual(decideRow(["tags"], { text: null, values: [["a", "b"]], unembedded: true }), { text: "a,b", fields: ["tags"] });
  });
  it("is the writer's composition", () => {
    const schema = fromStrut(getStrutSchema("StrutRun")!);
    const values: Record<string, unknown> = { run_id: "1", workflow_name: "wf", run_status: "ok", summary: "s" };
    const d = decideRow(schema.index, { text: null, values: schema.index.map((f) => values[f]), unembedded: true });
    assert.equal((d as { text: string }).text, buildSearchText(schema, values).text);
  });
});

/** First dim = the text's length, second = a hash of it, so two texts
 *  never share a vector and a vector names its text. */
function hashText(t: string): number {
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
  return h;
}
const fake: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      v[0] = t.length;
      v[1] = hashText(t);
      return v;
    });
  },
};

describe("EmbeddingPass (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  let resolver: SchemaResolver;
  let pass: EmbeddingPass;
  const lines: string[] = [];
  const BEFORE = Date.now() - 60_000;
  const skipMe = (reason: string) => (s: { type: string; reason: string }) => s.reason === reason;

  /** A node as another writer leaves it: labels, properties, no vector. */
  const raw = (type: string, key: string, props: Record<string, unknown>, stamp = BEFORE) =>
    bolt.run(
      `CREATE (n:\`${type}\`:Node:Data_Bank) SET n = $p, n.node_key = $k, n.ref_id = $k, n.namespace = 'default', n.date_added_to_graph = $now`,
      { p: props, k: key, now: int(stamp) },
    );
  /** stakgraph's shape: `Data_Bank` = the name, no domain label, no vector. */
  const fn = (key: string, name: string, description?: string, stamp?: number) =>
    raw("Function", key, { name, file: "src/access.ts", Data_Bank: name, ...(description === undefined ? {} : { description }) }, stamp);
  const node = async (key: string) => {
    const r = await bolt.run(`MATCH (n:Data_Bank {node_key: $k}) RETURN labels(n) AS labels, properties(n) AS p`, { k: key });
    assert.equal(r.length, 1, key);
    return { labels: [...(r[0]!["labels"] as string[])].sort(), p: r[0]!["p"] as Record<string, unknown> };
  };
  const vectorOf = (p: Record<string, unknown>) => p["text_embeddings"] as number[] | undefined;

  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedJarvisOntology(bolt);
    await seedStrutDomain(bolt);
    // The mark on `Turn` by hand, until the fixture is re-dumped after the
    // jarvis PR lands (plans/semantic-search.md §4).
    await bolt.run(`MATCH (s:Schema {type: "Turn"}) SET s.embed = false`);
  });
  after(async () => {
    await pass?.stop();
    await bolt?.close();
  });
  beforeEach(async () => {
    await pass?.stop();
    // The Schemas stay; everything written by a test goes.
    await bolt.run(`MATCH (n) WHERE NOT n:Schema AND NOT n:Migration DETACH DELETE n`);
    resolver = new SchemaResolver(bolt);
    lines.length = 0;
    pass = new EmbeddingPass(bolt, fake, resolver, { autoStart: false, sweepEveryMs: 1e12, log: (l) => lines.push(l) });
  });

  it("embeds a node another writer put in the graph; a later description, an edit and a stakgraph reset re-embed it; a clean sweep writes nothing", async () => {
    await fn("function-a", "resolveWorkspaceAccess", "Checks a user may read the workspace");
    await fn("function-b", "validateWorkspaceAccess");
    await pass.sweep();
    let a = await node("function-a");
    assert.equal(a.p["Data_Bank"], "resolveWorkspaceAccess\nChecks a user may read the workspace");
    assert.deepEqual(a.p["_search_fields_used"], ["name", "description"]);
    assert.ok(a.labels.includes("Domain_codeartifact"), `labels ${a.labels}`);
    const v1 = vectorOf(a.p)!;
    assert.equal(v1[0], (a.p["Data_Bank"] as string).length);
    let b = await node("function-b");
    assert.equal(b.p["Data_Bank"], "validateWorkspaceAccess");
    assert.deepEqual(b.p["_search_fields_used"], ["name"]);
    assert.ok(vectorOf(b.p));
    let s = pass.status();
    assert.deepEqual([s.sweep.n, s.sweep.phase, s.sweep.type, s.sweep.cursor], [1, "idle", null, null]);
    assert.deepEqual(s.last["Function"], { seen: 2, stale: 2, embedded: 2, removed: 0, errors: 0 });
    assert.ok(lines.some((l) => /sweep 1 done/.test(l)), lines.join("\n"));

    // A description filled in after the node was written (mcp's describe job).
    await bolt.run(`MATCH (n:Function {node_key: "function-b"}) SET n.description = "Validates access before a write"`);
    // A field edited since.
    await bolt.run(`MATCH (n:Function {node_key: "function-a"}) SET n.description = "Checks a user may read or write the workspace"`);
    await pass.sweep();
    a = await node("function-a");
    b = await node("function-b");
    assert.equal(a.p["Data_Bank"], "resolveWorkspaceAccess\nChecks a user may read or write the workspace");
    assert.notDeepEqual(vectorOf(a.p), v1);
    assert.equal(b.p["Data_Bank"], "validateWorkspaceAccess\nValidates access before a write");
    assert.deepEqual(pass.status().last["Function"], { seen: 2, stale: 2, embedded: 2, removed: 0, errors: 0 });

    // stakgraph's re-sync: `ON MATCH SET node += {Data_Bank: name}` — the
    // vector and the record survive, the text is the name again.
    await bolt.run(`MATCH (n:Function {node_key: "function-a"}) SET n += {Data_Bank: n.name}`);
    await pass.sweep();
    a = await node("function-a");
    assert.equal(a.p["Data_Bank"], "resolveWorkspaceAccess\nChecks a user may read or write the workspace");
    assert.deepEqual(pass.status().last["Function"], { seen: 2, stale: 1, embedded: 1, removed: 0, errors: 0 });

    // Clean: a sweep reads and writes nothing.
    const snap = await graphSnapshot(bolt);
    await pass.sweep();
    assert.deepEqual(await graphSnapshot(bolt), snap);
    assert.deepEqual(pass.status().last["Function"], { seen: 2, stale: 0, embedded: 0, removed: 0, errors: 0 });
  });

  it("leaves unmarked types alone and names them: no index, no Schema node, no-embed; a blank node is left alone", async () => {
    await bolt.run(`CREATE (:Schema {type: "Advisor", domain: "Cloud", node_key: "advisor-name", name: "string", ref_id: "schema-advisor"})`);
    await raw("Advisor", "advisor-1", { name: "Adv", Data_Bank: "Adv" });
    await raw("Context", "context-1", { name: "ctx", Data_Bank: "ctx" }); // a label with no Schema (stakgraph's)
    await fn("function-blank", "   ");
    await pass.sweep();
    for (const k of ["advisor-1", "context-1", "function-blank"]) {
      const n = await node(k);
      assert.equal(vectorOf(n.p), undefined, k);
      assert.ok(!n.labels.some((l) => l.startsWith("Domain_")), `${k}: ${n.labels}`);
    }
    assert.equal((await node("advisor-1")).p["Data_Bank"], "Adv");
    const s = pass.status();
    const named = s.skipped.filter((x) => ["Advisor", "Context", "Turn", "StrutToolCall", "StrutTurn"].includes(x.type)).sort((x, y) => x.type.localeCompare(y.type));
    assert.deepEqual(named, [
      { type: "Advisor", reason: "no_index" },
      { type: "Context", reason: "no_schema" },
      { type: "StrutToolCall", reason: "no_embed" },
      { type: "StrutTurn", reason: "no_embed" },
      { type: "Turn", reason: "no_embed" },
    ]);
    assert.ok(!s.skipped.some(skipMe("invalid_label")));
    assert.deepEqual(s.last["Function"], { seen: 1, stale: 0, embedded: 0, removed: 0, errors: 0 });
    assert.ok(!("Advisor" in s.last) && !("Context" in s.last));
    await bolt.run(`MATCH (s:Schema {type: "Advisor"}) DETACH DELETE s`);
  });

  it("pages by node_key: every node once, a tick resumes at the cursor, the code types first", async () => {
    await pass.stop();
    // One batch per page, so budget 0 = one page per tick.
    pass = new EmbeddingPass(bolt, fake, resolver, { autoStart: false, sweepEveryMs: 1e12, pageSize: 1000, batchSize: 1000, tickBudgetMs: 0, log: (l) => lines.push(l) });
    await bolt.run(
      `UNWIND range(1, 2500) AS i
       CREATE (n:Function:Node:Data_Bank)
       SET n.name = 'fn' + i, n.file = 'f.ts', n.Data_Bank = 'fn' + i, n.node_key = 'function-' + right('0000' + toString(i), 4),
           n.ref_id = 'function-' + i, n.namespace = 'default', n.date_added_to_graph = $now`,
      { now: int(BEFORE) },
    );
    await raw("Concept", "concept-1", { name: "Billing", description: "How we bill", Data_Bank: "Billing" });
    // Budget 0 = one page per tick. Tick until Function's first page is in.
    let ticks = 0;
    while (pass.status().current["Function"]?.seen !== 1000) {
      await pass.tick();
      assert.ok(++ticks < 100, `no Function page after ${ticks} ticks: ${JSON.stringify(pass.status())}`);
    }
    let s = pass.status();
    assert.deepEqual([s.sweep.phase, s.sweep.type, s.sweep.cursor], ["embed", "Function", "function-1000"]);
    assert.ok(!("Concept" in s.current), "the code types come first");
    await pass.tick();
    s = pass.status();
    assert.deepEqual([s.current["Function"]!.seen, s.sweep.cursor], [2000, "function-2000"]);
    await pass.sweep();
    s = pass.status();
    assert.deepEqual(s.last["Function"], { seen: 2500, stale: 2500, embedded: 2500, removed: 0, errors: 0 });
    assert.deepEqual(s.last["Concept"], { seen: 1, stale: 1, embedded: 1, removed: 0, errors: 0 });
    const missing = await bolt.run(`MATCH (n:Function) WHERE n.text_embeddings IS NULL OR NOT n:Domain_codeartifact RETURN count(n) AS c`);
    assert.equal(missing[0]!["c"], 0);
  });

  it("a spent budget stops a tick between batches, not at the end of a page; the next resumes at the last batch", async () => {
    await pass.stop();
    // Budget 0 = one batch of 100 per tick, inside pages of 1,000.
    pass = new EmbeddingPass(bolt, fake, resolver, { autoStart: false, sweepEveryMs: 1e12, pageSize: 1000, batchSize: 100, tickBudgetMs: 0, log: (l) => lines.push(l) });
    await bolt.run(
      `UNWIND range(1, 250) AS i
       CREATE (n:Function:Node:Data_Bank)
       SET n.name = 'fn' + i, n.file = 'f.ts', n.Data_Bank = 'fn' + i, n.node_key = 'function-' + right('000' + toString(i), 3),
           n.ref_id = 'function-' + i, n.namespace = 'default', n.date_added_to_graph = $now`,
      { now: int(BEFORE) },
    );
    let ticks = 0;
    while (pass.status().current["Function"]?.seen !== 100) {
      await pass.tick();
      assert.ok(++ticks < 100, `no Function batch after ${ticks} ticks: ${JSON.stringify(pass.status())}`);
    }
    let s = pass.status();
    assert.deepEqual([s.sweep.type, s.sweep.cursor, s.current["Function"]!.embedded], ["Function", "function-100", 100]);
    const embedded = await bolt.run(`MATCH (n:Function) WHERE n.text_embeddings IS NOT NULL RETURN max(n.node_key) AS k, count(n) AS c`);
    assert.deepEqual([embedded[0]!["k"], embedded[0]!["c"]], ["function-100", 100]);
    await pass.tick();
    s = pass.status();
    assert.deepEqual([s.current["Function"]!.seen, s.sweep.cursor], [200, "function-200"]);
    await pass.sweep();
    assert.deepEqual(pass.status().last["Function"], { seen: 250, stale: 250, embedded: 250, removed: 0, errors: 0 });
  });

  it("embeds newcomers between sweeps, within a tick, without a sweep", async () => {
    await fn("function-old", "oldFn", "there before");
    await pass.sweep();
    assert.equal(pass.status().sweep.n, 1);
    await fn("function-new", "newFn", "added after the sweep", Date.now());
    await pass.tick();
    const n = await node("function-new");
    assert.equal(n.p["Data_Bank"], "newFn\nadded after the sweep");
    assert.ok(vectorOf(n.p));
    assert.ok(n.labels.includes("Domain_codeartifact"));
    const s = pass.status();
    assert.deepEqual([s.sweep.n, s.newcomers.embedded], [1, 1]);
    assert.ok(typeof s.newcomers.since === "number");
    await pass.tick();
    assert.equal(pass.status().newcomers.embedded, 1, "nothing new: nothing done");
  });

  it("newcomers: rows the pass never embeds do not hide the code ingested beside them; a stamp a whole batch shares is read through; blank rows on one stamp are stepped past", async () => {
    await pass.stop();
    pass = new EmbeddingPass(bolt, fake, resolver, { autoStart: false, sweepEveryMs: 1e12, pageSize: 3, log: (l) => lines.push(l) });
    await pass.sweep();
    const t = Date.now();
    // A run's agent log (no-embed) and blank code, more than a page of each, first.
    for (let i = 0; i < 5; i++) await raw("Turn", `turn-${i}`, { content: `ran ${i}`, tool: "shell", Data_Bank: `ran ${i}\nshell` }, t);
    for (let i = 0; i < 4; i++) await fn(`function-blank-${i}`, "  ", undefined, t);
    // stakgraph's ingest: one `$now` for the batch.
    for (let i = 0; i < 7; i++) await fn(`function-batch-${i}`, `batched${i}`, "one ingest batch, one stamp", t + 1);
    await fn("function-late", "late", "after the batch", t + 2);
    await pass.tick();
    for (const k of [...[0, 1, 2, 3, 4, 5, 6].map((i) => `function-batch-${i}`), "function-late"]) assert.ok(vectorOf((await node(k)).p), k);
    for (let i = 0; i < 5; i++) assert.equal(vectorOf((await node(`turn-${i}`)).p), undefined);
    for (let i = 0; i < 4; i++) assert.equal(vectorOf((await node(`function-blank-${i}`)).p), undefined);
    assert.equal(pass.status().newcomers.embedded, 8);
  });

  it("newcomers: a spent budget stops the tick between batches, and the next resumes", async () => {
    await pass.stop();
    pass = new EmbeddingPass(bolt, fake, resolver, { autoStart: false, sweepEveryMs: 1e12, batchSize: 2, tickBudgetMs: 0, log: (l) => lines.push(l) });
    await pass.sweep();
    const t = Date.now();
    for (let i = 0; i < 5; i++) await fn(`function-n${i}`, `n${i}`, "new", t + i);
    const embedded: number[] = [];
    for (let k = 0; k < 4; k++) {
      await pass.tick();
      embedded.push(pass.status().newcomers.embedded);
    }
    assert.deepEqual(embedded, [2, 4, 5, 5]);
  });

  it("no-embed: strut's execution records get text and no vector (write and update); a marked jarvis type too; a vector found on one is removed, the text kept", async () => {
    const w = new NodeWriter(bolt, { embedder: fake, resolver });
    const [tc] = await w.writeMany([{ type: "StrutToolCall", data: { run_id: "r", path: "wf/agent", seq: 1, tool_name: "bash", input_preview: "ls" } }], "upsert");
    const byRef = async (ref_id: string) => (await bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) RETURN properties(n) AS p`, { r: ref_id }))[0]!["p"] as Record<string, unknown>;
    let p = await byRef(tc!.ref_id);
    assert.equal(p["Data_Bank"], "bash\nls");
    assert.deepEqual(p["_search_fields_used"], ["tool_name", "input_preview"]);
    assert.equal(vectorOf(p), undefined);
    await w.update(tc!.ref_id, { set: { input_preview: "ls -la" } });
    p = await byRef(tc!.ref_id);
    assert.equal(p["Data_Bank"], "bash\nls -la");
    assert.equal(vectorOf(p), undefined);
    // A vector an earlier writer left goes with the next update.
    await bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) SET n.text_embeddings = [1.0, 2.0]`, { r: tc!.ref_id });
    await w.update(tc!.ref_id, { set: { input_preview: "pwd" } });
    assert.equal(vectorOf(await byRef(tc!.ref_id)), undefined);

    const [turn] = await w.writeMany([{ type: "Turn", data: { turn_id: "t1", content: "ran ls", tool: "shell" } }], "create");
    p = await byRef(turn!.ref_id);
    assert.equal(p["Data_Bank"], "ran ls\nshell");
    assert.equal(vectorOf(p), undefined);
    // jarvis's worker, before the PR: a Turn with a vector.
    await bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) SET n.text_embeddings = [0.5, 0.5]`, { r: turn!.ref_id });
    await bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) SET n.text_embeddings = [0.5, 0.5]`, { r: tc!.ref_id });
    await pass.sweep();
    p = await byRef(turn!.ref_id);
    assert.equal(vectorOf(p), undefined);
    assert.equal(p["Data_Bank"], "ran ls\nshell");
    assert.equal(vectorOf(await byRef(tc!.ref_id)), undefined);
    const s = pass.status();
    assert.deepEqual(s.last["Turn"], { seen: 1, stale: 0, embedded: 0, removed: 1, errors: 0 });
    assert.deepEqual(s.last["StrutToolCall"], { seen: 1, stale: 0, embedded: 0, removed: 1, errors: 0 });
  });

  it("labels: the resolver's — none for a hidden type", async () => {
    await bolt.run(`CREATE (:About {hidden_types: ["Var"]})`);
    await raw("Var", "var-1", { name: "X", file: "a.ts", body: "const x = 1", Data_Bank: "X" });
    await fn("function-l", "f", "d");
    await pass.sweep();
    const v = await node("var-1");
    assert.equal(v.p["Data_Bank"], "X\nconst x = 1");
    assert.ok(vectorOf(v.p), "hidden is a search-time filter: embedded all the same");
    assert.ok(!v.labels.some((l) => l.startsWith("Domain_")), `${v.labels}`);
    assert.ok((await node("function-l")).labels.includes("Domain_codeartifact"));
  });

  it("GET /graph/embeddings reports the sweep and the skipped types; { enabled: false } with embeddings off", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-emb-"));
    const backend = await openGraphBackend(cfg!, { embeddings: fake, seedOntology: true, pass: { autoStart: false, sweepEveryMs: 1e12, log: () => undefined } });
    const off = await openGraphBackend(cfg!, { embeddings: false });
    const mk = (b: typeof backend) => createStrut({ workspace: new Neo4jWorkspaceStore(b), store: new MemoryRunStore(), registry: coreRegistry(), dataDir, serveUi: false, enableChat: false, stt: false, scheduler: false });
    const strut = await mk(backend);
    const strutOff = await mk(off);
    try {
      assert.equal(backend.indexReconcile!.status, "nothing_to_do", "the fixture's lists are the library's");
      assert.ok(backend.embeddings);
      let res = await strut.app.request("/graph/embeddings");
      assert.equal(res.status, 200);
      let body = (await res.json()) as { enabled: boolean; sweep: { n: number; phase: string }; skipped: Array<{ type: string; reason: string }>; ticks: number };
      assert.deepEqual([body.enabled, body.sweep.n, body.ticks], [true, 0, 0]);
      await backend.embeddings!.sweep();
      res = await strut.app.request("/graph/embeddings");
      body = await res.json();
      assert.deepEqual([body.sweep.n, body.sweep.phase], [1, "idle"]);
      assert.ok(body.skipped.some((s) => s.type === "Turn" && s.reason === "no_embed"), JSON.stringify(body.skipped));
      assert.ok(body.skipped.some((s) => s.type === "StrutToolCall" && s.reason === "no_embed"));
      const offRes = await strutOff.app.request("/graph/embeddings");
      assert.deepEqual(await offRes.json(), { enabled: false });
    } finally {
      await strut.close();
      await strutOff.close();
      await backend.close();
      await off.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
