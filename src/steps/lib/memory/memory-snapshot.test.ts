import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { contentHash } from "./_snapshot.js";
import { NO_LADYBUG, memoryWorkspace, type MemoryWorkspace } from "./_test-workspace.js";
import { tar, untar } from "../../../tar.js";

// memory/export → memory/import between real Ladybug workspace graphs, each in
// a temp folder of its own (with a space in its name, as macOS's Application
// Support has): memory moves from one strut's workspace to another's, and the
// rest of either workspace stays where it is. Skips where @ladybugdb/core does
// not load, as memory-steps.test.ts does.
const hasLadybug = !NO_LADYBUG;

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory/export and memory/import", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const spaces = new Map<string, MemoryWorkspace>();
  /** The workspace named `name`, opened the first time it is asked for. */
  const space = async (name: string) => {
    if (!spaces.has(name)) spaces.set(name, await memoryWorkspace(`strut memory snapshot ${name}-`));
    return spaces.get(name)!;
  };
  const ctx = async (name: string) => (await space(name)).ctx();
  let A: StepContext;
  let run: (type: string, input: unknown, c: StepContext) => Promise<any>;
  let snap: any;

  before(async () => {
    A = await ctx("a");
    const { registry } = await buildRegistry();
    run = (type, input, c) => {
      const def = registry[type] as unknown as StepDef;
      return def.run(def.input.parse(input), c);
    };
    const me = { type: "Self", name: "Me" };
    await run("memory/remember", { episode: "My name is Tom.", facts: [{ subject: me, predicate: "name", text: "The user's name is Tom." }] }, A);
    await run(
      "memory/remember",
      {
        episode: "I play chess with Kate, \"Kat\", on Sundays.",
        facts: [{ subject: me, predicate: "plays chess with", object: { type: "Person", name: "Kate" }, text: "The user plays chess with Kate." }],
      },
      A,
    );
    await run("memory/remember", { episode: "Call me Thomas.", facts: [{ subject: me, predicate: "name", text: "The user's name is Thomas." }] }, A);
    const katherine = await run("memory/remember", { episode: "Katherine cooks.", facts: [{ subject: { type: "Person", name: "Katherine" }, predicate: "prefers", text: "Katherine likes cooking." }] }, A);
    const kate = (await run("memory/recall", { q: "Kate", type: "Person" }, A))[0];
    await run("memory/merge", { keep: kate.ref_id, duplicate: katherine.entities[0].ref_id }, A);
    snap = await run("memory/export", {}, A);
  });
  after(() => Promise.all([...spaces.values()].map((w) => w.close())));

  // Hits of one score come in the order the workspace stores them, which a copy need not share: compared as sets.
  const byRef = (hits: any[]) => [...hits].sort((a, b) => (a.ref_id < b.ref_id ? -1 : 1));
  const recallAll = async (c: StepContext) => ({
    name: byRef(await run("memory/recall", { q: "name", type: "Fact", include_expired: true }, c)),
    kate: byRef(await run("memory/recall", { q: "Kate cooking chess", limit: 20 }, c)),
    user: await run("memory/get", { user: true }, c),
  });

  /** A workspace node that is not memory's, and how it reads now. */
  const workflow = async (name: string) => (await (await space(name)).graph.nodes.write({ type: "StrutWorkflow", data: { name: "deploy", description: "Ships strut." } })).ref_id;
  const readNode = async (name: string, ref_id: string) =>
    (await (await space(name)).graph.lbug.query("MATCH (n:Node) WHERE n.ref_id = $id RETURN n.node_type AS type, n.name AS name, n.updated_at AS at, n.deleted_at AS gone", { id: ref_id }))[0];

  it("export writes one owner-only .tar.gz in the memory folder, with a manifest, and nothing else", async () => {
    assert.ok(!snap.error, snap.error);
    assert.match(snap.path, /snapshots\/memory-.*\.tar\.gz$/);
    assert.equal(dirname(dirname(snap.path)), join((await space("a")).dir, "memory"));
    assert.equal(statSync(snap.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(snap.path)).mode & 0o777, 0o700);
    assert.equal(statSync(snap.path).size, snap.bytes);
    assert.deepEqual(readdirSync(dirname(snap.path)), [snap.path.split("/").pop()]);
    assert.equal(snap.manifest.format, 2);
    assert.equal(snap.manifest.ladybug, (await space("a")).graph.lbug.version);
    assert.equal(snap.counts.Entity, 3);
    assert.equal(snap.counts.Fact, 4);
    assert.equal(snap.counts.Episode, 4);
    assert.equal(snap.counts.ALIAS_OF, 1);
    const files = untar(gunzipSync(readFileSync(snap.path)));
    assert.deepEqual([...files.keys()].sort(), ["graph/edges.jsonl", "graph/nodes.jsonl", "graph/ontology.json", "manifest.json"]);
    assert.deepEqual(JSON.parse(files.get("manifest.json")!.toString()), snap.manifest);
  });

  it("an unchanged memory exports the same content hash, and the last snapshot replaces the one before", async () => {
    const again = await run("memory/export", {}, A);
    assert.equal(again.manifest.content_hash, snap.manifest.content_hash);
    assert.deepEqual(readdirSync(dirname(again.path)), [again.path.split("/").pop()]);
    snap = again;
  });

  it("import into an empty memory brings back the same nodes, and recall and get answer the same", async () => {
    const B = await ctx("b");
    const data = readFileSync(snap.path).toString("base64");
    const out = await run("memory/import", { data }, B);
    assert.ok(!out.error, out.error);
    assert.deepEqual(out.counts, snap.counts);
    assert.equal(out.replaced, false);
    assert.equal(out.backup, undefined);
    assert.equal(out.applied.created, snap.counts.Entity + snap.counts.Fact + snap.counts.Episode);
    assert.ok(!existsSync(join((await space("b")).dir, "memory", "backups")), "an empty memory needs no backup");
    assert.deepEqual(await recallAll(B), await recallAll(A));
    assert.ok(!existsSync(join((await space("b")).dir, "memory", "snapshots")), "import keeps no file");
    // And it is a working memory: a later write lands and supersedes.
    const next = await run("memory/remember", { episode: "I'm Tommy now.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Tommy." }] }, B);
    assert.equal(next.facts[0].superseded.length, 1);
  });

  it("import by path reads a file on this machine", async () => {
    const out = await run("memory/import", { path: snap.path }, await ctx("c"));
    assert.deepEqual(out.counts, snap.counts);
  });

  it("inline export returns the snapshot as data, keeps no file, and imports", async () => {
    const out = await run("memory/export", { inline: true }, A);
    assert.equal(out.path, undefined);
    assert.equal(out.manifest.content_hash, snap.manifest.content_hash);
    assert.equal(Buffer.from(out.data, "base64").length, out.bytes);
    assert.deepEqual(readdirSync(dirname(snap.path)), [snap.path.split("/").pop()], "only the earlier file export is there");
    const D = await ctx("d");
    assert.deepEqual((await run("memory/import", { data: out.data }, D)).counts, snap.counts);
    assert.deepEqual(await recallAll(D), await recallAll(A));
  });

  it("import refuses a memory that is not empty", async () => {
    const out = await run("memory/import", { path: snap.path }, A);
    assert.match(out.error, /^not_empty: memory already holds 3 entities, 4 facts and 4 episodes/);
  });

  // G holds a memory of its own, which replace swaps for A's, and a workflow node, which it leaves alone.
  let backups: string;
  const listBackups = () => readdirSync(backups).sort();
  let gBefore: Awaited<ReturnType<typeof recallAll>>;
  let gWorkflow: string;
  let gWorkflowWas: unknown;

  it("replace backs up a memory that is not empty, then loads the snapshot in its place, and leaves the rest of the workspace", async () => {
    const G = await ctx("g");
    backups = join((await space("g")).dir, "memory", "backups");
    gWorkflow = await workflow("g");
    gWorkflowWas = await readNode("g", gWorkflow);
    await run("memory/remember", { episode: "I'm Zed.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Zed." }] }, G);
    gBefore = await recallAll(G);
    const out = await run("memory/import", { path: snap.path, replace: true }, G);
    assert.ok(!out.error, out.error);
    assert.equal(out.replaced, true);
    assert.match(out.backup, /^memory-\d{4}-.*\.tar\.gz$/);
    assert.deepEqual(out.counts, snap.counts);
    assert.ok(out.applied.purged > 0, "G's own memory nodes are purged");
    assert.deepEqual(await recallAll(G), await recallAll(A));
    assert.equal((await run("memory/recall", { q: "Zed" }, G)).length, 0, "the old facts are gone");
    assert.deepEqual(await readNode("g", gWorkflow), gWorkflowWas, "the workflow node is untouched");
    assert.deepEqual(listBackups(), [out.backup]);
    assert.equal(statSync(backups).mode & 0o777, 0o700);
    assert.equal(statSync(join(backups, out.backup)).mode & 0o777, 0o600);
    assert.ok(!existsSync(join((await space("g")).dir, "memory", "snapshots")), "import keeps no file");
    // The backup is a snapshot of memory as it was, and of nothing else.
    const H = await ctx("h");
    assert.ok(!(await run("memory/import", { path: join(backups, out.backup) }, H)).error);
    assert.deepEqual(await recallAll(H), gBefore);
    assert.equal(await readNode("h", gWorkflow), undefined, "the workflow node is not in the backup");
  });

  const repack = (edit: (files: Map<string, Buffer>, manifest: any) => void, rehash = true) => {
    const files = untar(gunzipSync(readFileSync(snap.path)));
    const manifest = JSON.parse(files.get("manifest.json")!.toString());
    files.delete("manifest.json");
    edit(files, manifest);
    if (rehash) manifest.content_hash = contentHash(new Map([...files].map(([n, b]) => [n.slice(6), b])));
    return gzipSync(tar([["manifest.json", Buffer.from(JSON.stringify(manifest))], ...files])).toString("base64");
  };
  /** Rewrites graph/<name>.jsonl a line at a time. */
  const lines = (f: Map<string, Buffer>, name: string, edit: (rows: any[]) => any[]) =>
    f.set(`graph/${name}.jsonl`, Buffer.from(edit(f.get(`graph/${name}.jsonl`)!.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))).map((r) => `${JSON.stringify(r)}\n`).join("")));
  /** Passes every check, and fails part-way: its nodes land, then an edge the workspace's edge rules refuse. */
  const failsPartWay = () =>
    repack((f) => {
      const nodes = f.get("graph/nodes.jsonl")!.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const episode = nodes.find((n) => n.node_type === "Episode")!.ref_id;
      lines(f, "edges", (rows) => [...rows, { edge: "SUBJECT", from: episode, to: episode }]);
    });

  it("replace with a bad snapshot leaves memory as it is and makes no backup", async () => {
    const G = await ctx("g");
    const was = listBackups();
    const changed = repack((f) => f.set("graph/nodes.jsonl", Buffer.concat([f.get("graph/nodes.jsonl")!, Buffer.from("\n")])), false);
    assert.match((await run("memory/import", { data: changed, replace: true }, G)).error, /^bad_snapshot: the content hash/);
    assert.deepEqual(listBackups(), was);
    assert.deepEqual(await recallAll(G), await recallAll(A));
  });

  it("replace that fails part-way loads the backup back", async () => {
    const H = await ctx("h"); // holds G's old memory, from its backup
    const hWorkflow = await workflow("h");
    const hWorkflowWas = await readNode("h", hWorkflow);
    const out = await run("memory/import", { data: failsPartWay(), replace: true }, H);
    assert.match(out.error, /^import_failed: .*; the memory is as it was$/);
    assert.deepEqual(await recallAll(H), gBefore);
    assert.deepEqual(await readNode("h", hWorkflow), hWorkflowWas);
    assert.equal(readdirSync(join((await space("h")).dir, "memory", "backups")).length, 1, "the backup it made stays");
  });

  it("replace keeps the newest three backups", async () => {
    const G = await ctx("g");
    const names: string[] = [];
    for (let i = 0; i < 3; i++) names.push((await run("memory/import", { path: snap.path, replace: true }, G)).backup);
    assert.deepEqual(listBackups(), names.sort());
    assert.deepEqual(await readNode("g", gWorkflow), gWorkflowWas);
  });

  it("failed replaces keep the newest three backups too", async () => {
    const H = await ctx("h");
    const broken = failsPartWay();
    for (let i = 0; i < 4; i++) assert.match((await run("memory/import", { data: broken, replace: true }, H)).error, /the memory is as it was$/);
    assert.equal(readdirSync(join((await space("h")).dir, "memory", "backups")).length, 3);
    assert.deepEqual(await recallAll(H), gBefore);
  });

  it("two replaces in one millisecond make two backups", async () => {
    const G = await ctx("g");
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      const one = await run("memory/import", { path: snap.path, replace: true }, G);
      const two = await run("memory/import", { path: snap.path, replace: true }, G);
      assert.ok(!one.error && !two.error, one.error ?? two.error);
      assert.notEqual(one.backup, two.backup);
      assert.ok(listBackups().includes(one.backup) && listBackups().includes(two.backup));
    } finally {
      mock.timers.reset();
    }
  });

  it("replace refuses a memory whose backup could not be loaded back, and leaves it as it is", async () => {
    const K = await ctx("c"); // holds A's memory; each workspace is one more database open, and Ladybug maps a lot for each
    await run("memory/remember", { episode: "I'm Kim.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Kim." }] }, K);
    // A value no snapshot may carry (JSON has no infinity), written past memory's writers.
    const c = await space("c");
    await c.graph.lbug.withWrite((tx) => tx.run("MATCH (n:Node) WHERE n.node_type = 'Fact' AND n.text = $t SET n.confidence = 1e308 * 10", { t: "The user's name is Kim." }));
    const before = await recallAll(K);
    const out = await run("memory/import", { path: snap.path, replace: true }, K);
    assert.match(out.error, /^backup_failed: bad_snapshot: Fact\.confidence .*the memory is as it was$/);
    assert.deepEqual(await recallAll(K), before);
    assert.ok(!existsSync(join(c.dir, "memory", "backups")), "no backup that could not be loaded back");
  });

  it("import refuses a changed file, a newer or older format, a stray entry, nodes and edges memory does not write, and data over the cap", async () => {
    const E = await ctx("e");
    const eWorkflow = await workflow("e");
    const eWorkflowWas = await readNode("e", eWorkflow);
    const refused = async (data: string, error: RegExp, what?: string) => assert.match((await run("memory/import", { data }, E)).error, error, what);
    await refused(repack((f) => f.set("graph/nodes.jsonl", Buffer.concat([f.get("graph/nodes.jsonl")!, Buffer.from(" ")])), false), /^bad_snapshot: the content hash does not match/);
    await refused(repack((_, m) => (m.format = 3)), /^newer_format: .*format 3/);
    await refused(repack((_, m) => (m.format = 1)), /^old_format: .*format 1/);
    await refused(repack((f) => f.set("../evil", Buffer.from("x"))), /^bad_snapshot: unexpected entry/);
    for (const stray of ["graph/schema.cypher", "graph/copy.cypher", "graph/nodes_Fact.parquet", "graph/notes.txt"]) {
      await refused(repack((f) => f.set(stray, Buffer.from("COPY (RETURN 1) TO '/tmp/x.csv';"))), /^bad_snapshot: unexpected file/, stray);
    }
    await refused(repack((f) => f.delete("graph/edges.jsonl")), /^bad_snapshot: no graph\/edges.jsonl/);
    await refused(repack((f) => f.set("graph/nodes.jsonl", Buffer.from("{not json\n"))), /^bad_snapshot: graph\/nodes.jsonl is not JSON lines/);
    // A node of a workspace type memory does not hold: import would write a workflow.
    await refused(repack((f) => lines(f, "nodes", (rows) => [...rows, { ref_id: "wf", node_type: "StrutWorkflow", attributes: { name: "evil" }, updated_at: 1 }])), /^bad_snapshot: a node of a type memory does not hold \("StrutWorkflow"\)/);
    await refused(repack((f) => lines(f, "nodes", (rows) => [...rows, { ...rows[0], node_type: "Schema" }])), /^bad_snapshot: a node of a type memory does not hold/);
    await refused(repack((f) => lines(f, "nodes", ([first, ...rest]) => [{ ...first, attributes: { ...first.attributes, node_key: "x" } }, ...rest])), /^bad_snapshot: .*\.node_key is not an attribute memory writes/);
    await refused(repack((f) => lines(f, "nodes", (rows) => rows.map((r) => (r.node_type === "Fact" ? { ...r, attributes: { ...r.attributes, confidence: "high" } } : r)))), /^bad_snapshot: Fact\.confidence is not an attribute memory writes, or not of its type/);
    await refused(repack((f) => lines(f, "nodes", ([first, ...rest]) => [first, { ...first }, ...rest])), /^bad_snapshot: node .* is there twice/);
    await refused(repack((f) => lines(f, "nodes", ([first, ...rest]) => [{ ...first, deleted_at: "now" }, ...rest])), /^bad_snapshot: node .* has a bad stamp/);
    // An edge to a node the snapshot does not hold (a workflow node of this workspace, say), and an edge memory does not write.
    await refused(repack((f) => lines(f, "edges", ([first, ...rest]) => [{ ...first, to: eWorkflow }, ...rest])), /^bad_snapshot: an edge memory does not write, or not between two of its nodes/);
    await refused(repack((f) => lines(f, "edges", ([first, ...rest]) => [{ ...first, edge: "HAS_RUN" }, ...rest])), /^bad_snapshot: an edge memory does not write/);
    await refused(repack((f) => f.set("graph/ontology.json", Buffer.from(JSON.stringify([{ kind: "entity_type", name: "Bad name; DROP" }])))), /^bad_snapshot: ontology.json holds a term memory does not write/);
    await refused(Buffer.from("not a snapshot").toString("base64"), /^bad_snapshot: not a memory snapshot/);
    await refused("A".repeat(140 * 1024 * 1024), /^too_large: .* at most 100 MB/);
    assert.match((await run("memory/import", {}, E)).error, /^invalid_input/);
    assert.match((await run("memory/import", { path: join((await space("e")).dir, "nowhere.tar.gz") }, E)).error, /^not_found:/);
    // None of it touched the workspace: memory is still empty and takes a good snapshot, and the workflow node is as it was.
    assert.deepEqual((await run("memory/import", { path: snap.path }, E)).counts, snap.counts);
    assert.deepEqual(await readNode("e", eWorkflow), eWorkflowWas);
  });

  it("a failure part-way leaves memory empty, and it works after", async () => {
    const F = await ctx("f");
    const out = await run("memory/import", { data: failsPartWay() }, F);
    assert.match(out.error, /^import_failed: .*the memory is left empty$/);
    assert.equal((await run("memory/recall", { q: "Thomas Kate" }, F)).length, 0);
    assert.equal((await run("memory/export", { inline: true }, F)).counts.Entity, 0);
    const me = await run("memory/remember", { episode: "I'm Ann.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Ann." }] }, F);
    assert.equal(me.entities[0].type, "Self", "the ontology is still there");
    assert.equal(me.facts[0].predicate, "name");
  });

  it("if_changed answers unchanged while memory is, and the content hash moves when it changes", async () => {
    const hash = snap.manifest.content_hash;
    assert.deepEqual(await run("memory/export", { if_changed: hash }, A), { unchanged: true, content_hash: hash });
    assert.equal((await run("memory/export", { if_changed: "something else", inline: true }, A)).manifest.content_hash, hash);
    // A workflow node is not memory: it does not move the hash.
    await workflow("a");
    assert.deepEqual(await run("memory/export", { if_changed: hash }, A), { unchanged: true, content_hash: hash });
    await run("memory/remember", { episode: "I like tea.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "prefers", text: "The user likes tea." }] }, A);
    const moved = await run("memory/export", { if_changed: hash, inline: true }, A);
    assert.ok(moved.data && !moved.unchanged);
    assert.notEqual(moved.manifest.content_hash, hash);
    assert.equal(moved.counts.Fact, snap.counts.Fact + 1);
  });

  it("measures a small export", () => {
    // Text only: a few facts compress to a few KB.
    assert.ok(snap.bytes < 16 * 1024, `${snap.bytes} bytes`);
  });
});
