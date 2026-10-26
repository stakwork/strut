import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { StepContext } from "../../../core.js";
import { buildRegistry } from "../../registry.js";
import { memoryDb } from "./_db.js";
import { contentHash } from "./_snapshot.js";
import { tar, untar } from "../../../tar.js";

// memory/export → memory/import against real LadybugDB files in a temp folder
// (with a space in its name, as macOS's Application Support has). Skips where
// @ladybugdb/core does not load, as memory-steps.test.ts does.
const hasLadybug = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);

type StepDef = { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: StepContext): Promise<any> };

describe("memory/export and memory/import", { skip: !hasLadybug && "@ladybugdb/core is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut memory snapshot-"));
  const graph = (name: string) =>
    ({
      runId: "test",
      path: "test",
      scope: {},
      input: undefined,
      emit: async () => {},
      services: { secrets: { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, name, "graph.lbug") : undefined) } },
    }) as unknown as StepContext;
  const A = graph("a");
  let run: (type: string, input: unknown, c: StepContext) => Promise<any>;
  let snap: any;

  before(async () => {
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
  after(() => rmSync(dir, { recursive: true, force: true }));

  const recallAll = async (c: StepContext) => ({
    name: await run("memory/recall", { q: "name", type: "Fact", include_expired: true }, c),
    kate: await run("memory/recall", { q: "Kate cooking chess", limit: 20 }, c),
    user: await run("memory/get", { user: true }, c),
  });

  it("export writes one owner-only .tar.gz in the memory folder, with a manifest, and nothing else", () => {
    assert.ok(!snap.error, snap.error);
    assert.match(snap.path, /snapshots\/memory-.*\.tar\.gz$/);
    assert.equal(dirname(dirname(snap.path)), join(dir, "a"));
    assert.equal(statSync(snap.path).mode & 0o777, 0o600);
    assert.equal(statSync(snap.path).size, snap.bytes);
    assert.deepEqual(readdirSync(dirname(snap.path)), [snap.path.split("/").pop()], "the EXPORT DATABASE folder is gone");
    assert.equal(snap.manifest.format, 1);
    assert.equal(snap.manifest.ladybug, "0.21.2");
    assert.equal(snap.counts.Entity, 3);
    assert.equal(snap.counts.Fact, 4);
    assert.equal(snap.counts.Episode, 4);
    assert.equal(snap.counts.ALIAS_OF, 1);
    const files = untar(gunzipSync(readFileSync(snap.path)));
    assert.deepEqual(JSON.parse(files.get("manifest.json")!.toString()), snap.manifest);
    assert.ok(files.has("graph/schema.cypher"));
  });

  it("an unchanged graph exports the same content hash, and the last snapshot replaces the one before", async () => {
    const again = await run("memory/export", {}, A);
    assert.equal(again.manifest.content_hash, snap.manifest.content_hash);
    assert.deepEqual(readdirSync(dirname(again.path)), [again.path.split("/").pop()]);
    snap = again;
  });

  it("import into an empty graph brings back the same rows, and recall and get answer the same", async () => {
    const B = graph("b");
    const data = readFileSync(snap.path).toString("base64");
    const out = await run("memory/import", { data }, B);
    assert.ok(!out.error, out.error);
    assert.deepEqual(out.counts, snap.counts);
    assert.equal(out.replaced, false);
    assert.equal(out.backup, undefined);
    assert.ok(!existsSync(join(dir, "b", "backups")), "an empty graph needs no backup");
    assert.deepEqual(await recallAll(B), await recallAll(A));
    assert.ok(!existsSync(join(dir, "b", "snapshots")), "the unpacked files are gone");
    // And it is a working memory: a later write lands and supersedes.
    const next = await run("memory/remember", { episode: "I'm Tommy now.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Tommy." }] }, B);
    assert.equal(next.facts[0].superseded.length, 1);
  });

  it("import by path reads a file on this machine", async () => {
    const out = await run("memory/import", { path: snap.path }, graph("c"));
    assert.deepEqual(out.counts, snap.counts);
  });

  it("inline export returns the snapshot as data, keeps no file, and imports", async () => {
    const out = await run("memory/export", { inline: true }, A);
    assert.equal(out.path, undefined);
    assert.equal(out.manifest.content_hash, snap.manifest.content_hash);
    assert.equal(Buffer.from(out.data, "base64").length, out.bytes);
    assert.deepEqual(readdirSync(dirname(snap.path)), [snap.path.split("/").pop()], "only the earlier file export is there");
    const D = graph("d");
    assert.deepEqual((await run("memory/import", { data: out.data }, D)).counts, snap.counts);
    assert.deepEqual(await recallAll(D), await recallAll(A));
  });

  it("import refuses a graph that is not empty", async () => {
    const out = await run("memory/import", { path: snap.path }, A);
    assert.match(out.error, /^not_empty: memory already holds 3 entities, 4 facts and 4 episodes/);
  });

  // G holds a memory of its own, which replace swaps for A's.
  const G = graph("g");
  const backups = join(dir, "g", "backups");
  const listBackups = () => readdirSync(backups).sort();
  let gBefore: Awaited<ReturnType<typeof recallAll>>;

  it("replace backs up a graph that is not empty, then loads the snapshot in its place", async () => {
    await run("memory/remember", { episode: "I'm Zed.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Zed." }] }, G);
    gBefore = await recallAll(G);
    const out = await run("memory/import", { path: snap.path, replace: true }, G);
    assert.ok(!out.error, out.error);
    assert.equal(out.replaced, true);
    assert.match(out.backup, /^memory-\d{4}-.*\.tar\.gz$/);
    assert.deepEqual(out.counts, snap.counts);
    assert.deepEqual(await recallAll(G), await recallAll(A));
    assert.equal((await run("memory/recall", { q: "Zed" }, G)).length, 0, "the old facts are gone");
    assert.deepEqual(listBackups(), [out.backup]);
    assert.equal(statSync(backups).mode & 0o777, 0o700);
    assert.equal(statSync(join(backups, out.backup)).mode & 0o777, 0o600);
    assert.ok(!existsSync(join(dir, "g", "snapshots")), "the unpacked files are gone");
    // The backup is a snapshot of the graph as it was.
    const H = graph("h");
    assert.ok(!(await run("memory/import", { path: join(backups, out.backup) }, H)).error);
    assert.deepEqual(await recallAll(H), gBefore);
  });

  it("replace with a bad snapshot leaves the graph as it is and makes no backup", async () => {
    const was = listBackups();
    const changed = repack((f) => f.set("graph/schema.cypher", Buffer.concat([f.get("graph/schema.cypher")!, Buffer.from(" ")])), false);
    assert.match((await run("memory/import", { data: changed, replace: true }, G)).error, /^bad_snapshot: the content hash/);
    assert.deepEqual(listBackups(), was);
    assert.deepEqual(await recallAll(G), await recallAll(A));
  });

  it("replace that fails part-way loads the backup back", async () => {
    const H = graph("h"); // holds G's old memory, from its backup
    const broken = repack((f) => {
      const name = [...f.keys()].find((n) => /Fact.*\.parquet$/.test(n))!;
      f.set(name, f.get(name)!.subarray(0, 40));
    });
    const out = await run("memory/import", { data: broken, replace: true }, H);
    assert.match(out.error, /^import_failed: .*; the memory is as it was$/);
    assert.deepEqual(await recallAll(H), gBefore);
    assert.equal(readdirSync(join(dir, "h", "backups")).length, 1, "the backup it made stays");
  });

  it("replace keeps the newest three backups", async () => {
    const names: string[] = [];
    for (let i = 0; i < 3; i++) names.push((await run("memory/import", { path: snap.path, replace: true }, G)).backup);
    assert.deepEqual(listBackups(), names.sort());
  });

  it("failed replaces keep the newest three backups too", async () => {
    const H = graph("h");
    const broken = repack((f) => {
      const name = [...f.keys()].find((n) => /Fact.*\.parquet$/.test(n))!;
      f.set(name, f.get(name)!.subarray(0, 40));
    });
    for (let i = 0; i < 4; i++) assert.match((await run("memory/import", { data: broken, replace: true }, H)).error, /the memory is as it was$/);
    assert.equal(readdirSync(join(dir, "h", "backups")).length, 3);
    assert.deepEqual(await recallAll(H), gBefore);
  });

  it("two replaces in one millisecond make two backups", async () => {
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

  it("replace refuses a graph whose backup could not be loaded back, and leaves it as it is", async () => {
    const K = graph("c"); // holds A's memory; each graph is one more database open, and Ladybug maps a lot for each
    await run("memory/remember", { episode: "I'm Kim.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Kim." }] }, K);
    // A table import would refuse: a MAP column is not in the table-definition allowlist.
    await (await memoryDb(K))("CREATE NODE TABLE Odd(id STRING PRIMARY KEY, m MAP(STRING, INT64))");
    const before = await recallAll(K);
    const out = await run("memory/import", { path: snap.path, replace: true }, K);
    assert.match(out.error, /^backup_failed: bad_snapshot: schema.cypher .*the memory is as it was$/);
    assert.deepEqual(await recallAll(K), before);
    assert.ok(!existsSync(join(dir, "c", "backups")), "no backup that could not be loaded back");
  });

  const repack = (edit: (files: Map<string, Buffer>, manifest: any) => void, rehash = true) => {
    const files = untar(gunzipSync(readFileSync(snap.path)));
    const manifest = JSON.parse(files.get("manifest.json")!.toString());
    files.delete("manifest.json");
    edit(files, manifest);
    if (rehash) manifest.content_hash = contentHash(new Map([...files].map(([n, b]) => [n.slice(6), b])));
    return gzipSync(tar([["manifest.json", Buffer.from(JSON.stringify(manifest))], ...files])).toString("base64");
  };

  it("import refuses a changed file, a newer format, a stray entry, Cypher beyond table definitions, and data over the cap", async () => {
    const E = graph("e");
    const changed = repack((f) => f.set("graph/schema.cypher", Buffer.concat([f.get("graph/schema.cypher")!, Buffer.from(" ")])), false);
    assert.match((await run("memory/import", { data: changed }, E)).error, /^bad_snapshot: the content hash does not match/);
    assert.match((await run("memory/import", { data: repack((_, m) => (m.format = 2)) }, E)).error, /^newer_format: .*format 2/);
    assert.match((await run("memory/import", { data: repack((_, m) => (m.migrations = 999)) }, E)).error, /^newer_format: .*newer strut/);
    assert.match((await run("memory/import", { data: repack((f) => f.set("../evil", Buffer.from("x"))) }, E)).error, /^bad_snapshot: unexpected entry/);
    const extra = repack((f) => f.set("graph/schema.cypher", Buffer.concat([f.get("graph/schema.cypher")!, Buffer.from("\nMATCH (n) DELETE n;")])));
    assert.match((await run("memory/import", { data: extra }, E)).error, /^bad_snapshot: schema.cypher/);
    // A double-quoted string with an apostrophe in it, then a statement of its own: refused, the line is not a table definition.
    const smuggled = repack((f) => {
      const [first, ...rest] = f.get("graph/schema.cypher")!.toString().split("\n");
      const evil = first!.replace("STRING,", "STRING DEFAULT \"x'y\",").replace(/;$/, `;COPY (RETURN 'pwned') TO '${join(dir, "pwned.csv")}';`);
      f.set("graph/schema.cypher", Buffer.from([evil, ...rest].join("\n")));
    });
    assert.match((await run("memory/import", { data: smuggled }, E)).error, /^bad_snapshot: schema.cypher/);
    assert.ok(!existsSync(join(dir, "pwned.csv")));
    const indexed = repack((f) => f.set("graph/index.cypher", Buffer.from("CALL CREATE_FTS_INDEX('Fact', 'x', ['text']);")));
    assert.match((await run("memory/import", { data: indexed }, E)).error, /^bad_snapshot: index.cypher/);
    // IMPORT DATABASE reads a copy.cypher too: no file EXPORT does not write gets in.
    for (const stray of ["graph/copy.cypher", "graph/macro.cypher", "graph/nodes_Nope.parquet", "graph/notes.txt"]) {
      const sneaked = repack((f) => f.set(stray, Buffer.from("COPY (RETURN 1) TO '/tmp/x.csv';")));
      assert.match((await run("memory/import", { data: sneaked }, E)).error, /^bad_snapshot: unexpected file/, stray);
    }
    assert.match((await run("memory/import", { data: Buffer.from("not a snapshot").toString("base64") }, E)).error, /^bad_snapshot: not a memory snapshot/);
    assert.match((await run("memory/import", { data: "A".repeat(140 * 1024 * 1024) }, E)).error, /^too_large: .* at most 100 MB/);
    assert.match((await run("memory/import", {}, E)).error, /^invalid_input/);
    // None of it touched the graph: it is still empty and takes a good snapshot.
    assert.deepEqual((await run("memory/import", { path: snap.path }, E)).counts, snap.counts);
  });

  it("a failure part-way leaves the graph empty, and it works after", async () => {
    const F = graph("f");
    const broken = repack((f) => {
      const name = [...f.keys()].find((n) => /Fact.*\.parquet$/.test(n))!;
      f.set(name, f.get(name)!.subarray(0, 40));
    });
    const out = await run("memory/import", { data: broken }, F);
    assert.match(out.error, /^import_failed: .*the memory is left empty$/);
    assert.equal((await run("memory/recall", { q: "Thomas Kate" }, F)).length, 0);
    const me = await run("memory/remember", { episode: "I'm Ann.", facts: [{ subject: { type: "Self", name: "Me" }, predicate: "name", text: "The user's name is Ann." }] }, F);
    assert.equal(me.entities[0].type, "Self", "the ontology is seeded again");
    assert.equal(me.facts[0].predicate, "name");
  });

  it("measures a small export", () => {
    // Text only: a few facts compress to a few KB, nearly all of it Parquet framing.
    assert.ok(snap.bytes < 64 * 1024, `${snap.bytes} bytes`);
  });
});
