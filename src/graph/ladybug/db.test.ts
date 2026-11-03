/**
 * The handle (plans/ladybug-backend.md §3.2): what slice 1 relies on from the
 * probes, pinned. Skipped with the reason when the addon or its extensions
 * are not here.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LADYBUG_EDGE_TYPES, nodeColumns, ontologySeed } from "./registry.js";
import { CORE_RENAME_MIGRATION, MIGRATIONS, backupPath, ddlStatements, indexCalls, openLadybug, type LadybugHandle } from "./db.js";
import { openGraphBackend } from "../backend.js";
import { testBackends } from "../test-util.js";

const skip = testBackends().find((b) => b.kind === "ladybug")!.skip;
/** The rows a test wrote: the file also holds its ontology, as Schema rows. */
const DATA_ROWS = "MATCH (n:Node) WHERE n.node_type <> 'Schema' RETURN count(n) AS c";

describe("ladybug DDL (pure)", () => {
  it("one Node table (the ontology's rows in it), one rel table per seed edge, the ontology's own rel table, a ledger; every column an ALTER ADD", () => {
    const ddl = ddlStatements();
    assert.ok(ddl[0]!.startsWith("CREATE NODE TABLE IF NOT EXISTS Node("));
    assert.ok(ddl.some((s) => s.startsWith("CREATE NODE TABLE IF NOT EXISTS Migration(")));
    assert.ok(!ddl.some((s) => /NODE TABLE IF NOT EXISTS (Schema|Meta)\b/.test(s)), "no meta-graph node table: a type is a Node row");
    assert.ok(ddl.some((s) => s.startsWith("CREATE REL TABLE IF NOT EXISTS SCHEMA_EDGE(FROM Node TO Node, `ref_id` STRING,") && s.endsWith("`edge_type` STRING, `is_parent` BOOL)")), "parent links and edge rules, apart from the data's edges");
    for (const col of Object.keys(nodeColumns())) if (col !== "ref_id") assert.ok(ddl.includes(`ALTER TABLE Node ADD IF NOT EXISTS \`${col}\` ${nodeColumns()[col]}`), col);
    for (const edge of LADYBUG_EDGE_TYPES) assert.ok(ddl.some((s) => s.startsWith(`CREATE REL TABLE IF NOT EXISTS \`${edge}\`(FROM Node TO Node, `)), edge);
    assert.ok(!ddl.some((s) => /IS_ALIAS|ACCESSED|IN_RUN|IN_SESSION/.test(s)));
    assert.deepEqual(indexCalls().map(([n]) => n), ["node_vec", "node_fts"]);
    assert.deepEqual(MIGRATIONS, [], "nothing has shipped yet");
  });
});

describe("ladybug handle", { skip }, () => {
  let dir: string;
  let h: LadybugHandle;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "strut-lbug-db-"));
    h = await openLadybug(join(dir, "a", "graph.lbug"));
  });
  after(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the folder owner-only, loads both extensions, has every table and index", async () => {
    assert.equal(statSync(join(dir, "a")).mode & 0o777, 0o700);
    const tables = (await h.query("CALL SHOW_TABLES() RETURN name, type")).map((r) => `${r["type"]}:${r["name"]}`).sort();
    assert.deepEqual(tables, ["NODE:Migration", "NODE:Node", "REL:SCHEMA_EDGE", ...LADYBUG_EDGE_TYPES.map((e) => `REL:${e}`)].sort());
    // `_PK` rows are the tables' primary-key indexes.
    const indexes = (await h.query("CALL SHOW_INDEXES() RETURN index_name")).map((r) => String(r["index_name"])).filter((n) => n !== "_PK").sort();
    assert.deepEqual(indexes, ["node_fts", "node_vec"]);
    assert.match(h.version, /^\d+\.\d+\.\d+$/);
    // The ontology, seeded at open: Thing and the seed's types, stamped.
    const types = (await h.query("MATCH (n:Node {node_type: 'Schema'}) RETURN n.type AS t ORDER BY t")).map((r) => String(r["t"]));
    assert.deepEqual(types, ontologySeed().schemas.map((s) => String(s["type"])).sort());
    assert.equal((await h.query("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: ontologySeed().id }))[0]!["c"], 1);
  });

  it("is one handle per absolute path, and a second open after close is fresh", async () => {
    const again = await openLadybug(join(dir, "a", "..", "a", "graph.lbug"));
    assert.equal(again, h);
  });

  it("withWrite: all of it lands or none, and a failed statement ends the transaction for good", async () => {
    await h.withWrite(async (tx) => {
      await tx.run("CREATE (n:Node {ref_id: 'w1', node_type: 'T'})");
      await tx.run("CREATE (n:Node {ref_id: 'w2', node_type: 'T'})");
    });
    assert.equal((await h.query(DATA_ROWS))[0]!["c"], 2);

    await assert.rejects(
      h.withWrite(async (tx) => {
        await tx.run("CREATE (n:Node {ref_id: 'w3', node_type: 'T'})");
        throw new Error("abort");
      }),
      /abort/,
    );
    assert.equal((await h.query(DATA_ROWS))[0]!["c"], 2, "rolled back");

    // The engine rolls back on the first error; the next statement would
    // run auto-commit and persist. The handle refuses it with that error.
    await assert.rejects(
      h.withWrite(async (tx) => {
        try {
          await tx.run("MATCH (n:Nope) RETURN n");
        } catch {
          // swallowed on purpose
        }
        await tx.run("CREATE (n:Node {ref_id: 'w4', node_type: 'T'})");
      }),
      /Nope/,
    );
    assert.equal((await h.query("MATCH (n:Node {ref_id: 'w4'}) RETURN count(n) AS c"))[0]!["c"], 0, "nothing after the failure persisted");
    // The queue is still usable.
    await h.withWrite((tx) => tx.run("CREATE (n:Node {ref_id: 'w5', node_type: 'T'})"));
    assert.equal((await h.query(DATA_ROWS))[0]!["c"], 3);
  });

  it("rows come back plain: INT64 as a number, a struct's nulls and engine keys dropped, top-level nulls kept", async () => {
    await h.exclusive((w) => w("MATCH (n:Node {ref_id: 'w1'}) SET n.created_at = 1700000000000, n.name = 'one'"));
    const [row] = await h.query("MATCH (n:Node {ref_id: 'w1'}) RETURN n, n.deleted_at AS gone, {a: n.name, b: n.description} AS s");
    const n = row!["n"] as Record<string, unknown>;
    assert.equal(typeof n["created_at"], "number");
    assert.ok(!("_label" in n) && !("_id" in n) && !("deleted_at" in n), "no engine keys, no null fields");
    assert.equal(row!["gone"], null, "a top-level null stays a null");
    assert.deepEqual(row!["s"], { a: "one" });
  });

  it("a read-only handle sees committed state and cannot write", async () => {
    const ro = await h.readOnly();
    try {
      assert.equal((await ro.query(DATA_ROWS))[0]!["c"], 3);
      await assert.rejects(ro.query("CREATE (n:Node {ref_id: 'ro', node_type: 'T'})"), /read-only transaction/);
      await assert.rejects(ro.query("CALL CREATE_FTS_INDEX('Node', 'x_fts', ['name'])"));
      // The refused statements ended nothing: the next one runs, and sees a
      // commit made meanwhile — each statement is its own transaction.
      await h.exclusive((w) => w("CREATE (n:Node {ref_id: 'ro-after', node_type: 'T'})"));
      const { columns, rows, truncated } = await ro.run("MATCH (n:Node) RETURN n.ref_id AS id ORDER BY id", {}, { maxRows: 2 });
      assert.deepEqual([columns, rows.length, truncated], [["id"], 2, true]);
      assert.equal((await ro.query(DATA_ROWS))[0]!["c"], 4);
      // The extensions are the database's: an index read works here too.
      assert.ok(Array.isArray(await ro.query("CALL QUERY_FTS_INDEX('Node', 'node_fts', 'nothing') RETURN node.ref_id")));
    } finally {
      await ro.close();
    }
    // A connection, not a second Database (which reserves 8 TB of address
    // space per open and never gives it back — seven opens, then "Mmap for
    // size 8796093022208 failed"): twenty are nothing.
    for (let i = 0; i < 20; i++) {
      const again = await h.readOnly();
      assert.equal((await again.query(DATA_ROWS))[0]!["c"], 4);
      await again.close();
    }
  });

  it("an open without the extensions fails with the hint; a stale WAL beside a missing file is removed", async () => {
    const empty = join(dir, "no-extensions");
    mkdirSync(empty);
    await assert.rejects(openLadybug(join(dir, "b", "graph.lbug"), { extensionDir: empty }), /vector extension[\s\S]*STRUT_LADYBUG_EXTENSION_DIR/);
    assert.equal(existsSync(join(dir, "b", "graph.lbug")), false, "a failed open leaves no database behind");

    mkdirSync(join(dir, "c"));
    writeFileSync(join(dir, "c", "graph.lbug.wal"), "stale");
    const c = await openLadybug(join(dir, "c", "graph.lbug"));
    try {
      assert.equal((await c.query(DATA_ROWS))[0]!["c"], 0);
    } finally {
      await c.close();
    }
  });
  it("a file whose process exited without close() is writable again: the full-text index is rebuilt", async () => {
    const file = join(dir, "unclean", "graph.lbug");
    // A child that writes a node and exits at once, as a killed strut does.
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { openLadybug } from ${JSON.stringify(fileURLToPath(new URL("./db.js", import.meta.url)))};
         const h = await openLadybug(${JSON.stringify(file)});
         await h.withWrite((tx) => tx.run("CREATE (:Node {ref_id: 'a', title: 'one', search_text: 'some text'})"));
         await h.withWrite((tx) => tx.run("MATCH (n:Node {ref_id: 'a'}) SET n.title = 'one again'"));
         process.exit(0);`,
      ],
      { env: process.env, encoding: "utf-8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const again = await openLadybug(file);
    try {
      await again.withWrite((tx) => tx.run("MATCH (n:Node {ref_id: 'a'}) SET n.title = 'two'"));
      assert.equal((await again.query("MATCH (n:Node {ref_id: 'a'}) RETURN n.title AS title"))[0]!["title"], "two");
    } finally {
      await again.close();
    }
  });
  it("close() folds the WAL into the file, so a restart replays nothing", async () => {
    const file = join(dir, "clean", "graph.lbug");
    const c = await openLadybug(file);
    await c.withWrite((tx) => tx.run("CREATE (:Node {ref_id: 'a', name: 'one', search_text: 'some text'})"));
    await c.close();
    assert.equal(existsSync(`${file}.wal`), false);
    const again = await openLadybug(file);
    await again.close();
    assert.equal(existsSync(backupPath(file, CORE_RENAME_MIGRATION)), false, "a file this build made needs no backup");
  });
});

describe("a file written with the old core column names (plans/graph-memory-plan.md step 2)", { skip }, () => {
  let dir: string;
  let file: string;
  const ref: Record<string, string> = {};
  const columnsOf = async (h: LadybugHandle, table: string) => new Set((await h.query(`CALL table_info('${table}') RETURN name`)).map((r) => String(r["name"])));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "strut-lbug-rename-"));
    file = join(dir, "graph.lbug");
    // The file an older build left, made with its DDL (no extensions, so no
    // indexes: the open builds them) in a process of its own, as a file
    // comes from the last build's: jarvis's column names, the versions' and
    // checks' own seconds in `created_at`, a Schema row keyed by
    // `node_key`, an edge stamped `date_added_to_graph`, no Migration rows.
    const at = 1_790_000_000_000;
    const hex = (s: string) => Buffer.from(s).toString("hex");
    const rows: Array<Record<string, unknown>> = [
      { ref_id: "wf", node_key: `strutworkflow-${hex("harvey-deliver")}`, node_type: "StrutWorkflow", name: "harvey-deliver", description: "Deliver legal memos", Data_Bank: "harvey-deliver\nDeliver legal memos" },
      { ref_id: "v1", node_key: `strutworkflowversion-${hex("harvey-deliver")}-${hex("c-1")}`, node_type: "StrutWorkflowVersion", name: "harvey-deliver", content_hash: "c-1", version_label: "v1", created_at: 1_788_000_000, Data_Bank: "harvey-deliver" },
      { ref_id: "check", node_key: "check-k1", node_type: "Check", id: "k1", name: "bounds", policy: "always", created_at: 1_789_999_999, Data_Bank: "bounds" },
      { ref_id: "concept", node_key: "concept-lighthousekeeper", node_type: "Concept", name: "Lighthouse keeper", description: "who keeps the light", Data_Bank: "Lighthouse keeper\nwho keeps the light" },
      { ref_id: "schema-check", node_key: "check-id", node_type: "Schema", type: "Check", title_key: "name", attributes: JSON.stringify({ id: "string", name: "?string", policy: "?string", created_at: "datetime" }) },
    ];
    const columns = ["node_key STRING", "namespace STRING", "node_type STRING", "Data_Bank STRING", "text_embeddings FLOAT[384]", "date_added_to_graph INT64", "updated_at INT64", "deleted_at INT64",
      "name STRING", "description STRING", "content_hash STRING", "version_label STRING", "created_at INT64", "id STRING", "policy STRING", "type STRING", "attributes STRING", "title_key STRING"];
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { loadLadybug } from ${JSON.stringify(fileURLToPath(new URL("./db.js", import.meta.url)))};
         const lbug = await loadLadybug();
         const db = new lbug.Database(${JSON.stringify(file)});
         const conn = new lbug.Connection(db);
         const run = async (c, p = {}) => (Object.keys(p).length ? conn.execute(await conn.prepare(c), p) : conn.query(c));
         await run("CREATE NODE TABLE Node(\`ref_id\` STRING PRIMARY KEY)");
         await run("CREATE NODE TABLE Migration(\`migration_id\` STRING PRIMARY KEY, \`executed_at\` INT64)");
         for (const c of ${JSON.stringify(columns)}) await run("ALTER TABLE Node ADD " + c);
         await run("CREATE REL TABLE VERSION_OF(FROM Node TO Node, \`ref_id\` STRING, \`edge_key\` STRING, \`date_added_to_graph\` INT64, \`weight\` DOUBLE)");
         for (const r of ${JSON.stringify(rows)}) {
           const fields = Object.keys(r).map((f) => "\`" + f + "\`: $" + f);
           await run("CREATE (:Node {" + [...fields, "namespace: 'default'", "date_added_to_graph: $at", "updated_at: $at"].join(", ") + "})", { ...r, at: ${at} });
         }
         await run("MATCH (a:Node {ref_id: 'v1'}), (b:Node {ref_id: 'wf'}) CREATE (a)-[:VERSION_OF {ref_id: 'edge', edge_key: 'version_of', date_added_to_graph: $at, weight: 1.0}]->(b)", { at: ${at} });
         await run("CHECKPOINT");
         await conn.close();
         await db.close();`,
      ],
      { env: process.env, encoding: "utf-8" },
    );
    assert.equal(child.status, 0, child.stderr);
    Object.assign(ref, { wf: "wf", v1: "v1", check: "check", concept: "concept", edge: "edge" });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("opens with the new names: nodes, Schema rows and edges carried over, the old columns cleared, stamped once", async () => {
    const h = await openLadybug(file);
    try {
      const cleared = await h.query("MATCH (n:Node) WHERE n.node_key IS NOT NULL OR n.Data_Bank IS NOT NULL OR n.date_added_to_graph IS NOT NULL RETURN count(n) AS c");
      assert.equal(cleared[0]!["c"], 0, "the old columns stay in the table, empty: a dropped column breaks the next open");
      const row = async (id: string) => (await h.query("MATCH (n:Node {ref_id: $id}) RETURN n", { id }))[0]!["n"] as Record<string, unknown>;
      const wf = await row(ref["wf"]!);
      assert.equal(wf["key"], `strutworkflow-${Buffer.from("harvey-deliver").toString("hex")}`);
      assert.equal(wf["search_text"], "harvey-deliver\nDeliver legal memos");
      assert.equal(wf["title"], "harvey-deliver", "computed from the type's title_key");
      assert.equal(wf["created_at"], 1_790_000_000_000, "the row's ms");
      const v1 = await row(ref["v1"]!);
      assert.equal(v1["published_at"], 1_788_000_000, "the version's own seconds moved");
      assert.equal(v1["created_at"], 1_790_000_000_000, "and created_at is the row's");
      const check = await row(ref["check"]!);
      assert.equal(check["created_at"], 1_790_000_000_000, "a Check's own seconds give way to the row's ms");
      assert.equal((await row(ref["concept"]!))["title"], "Lighthouse keeper");
      const schema = (await h.query("MATCH (n:Node {node_type: 'Schema', type: 'StrutRun'}) RETURN n.key_spec AS k, n.key AS key"))[0]!;
      assert.deepEqual([schema["k"], schema["key"]], ["strutrun-run_id", null], "seeded with key_spec");
      const oldSchema = (await h.query("MATCH (n:Node {node_type: 'Schema', type: 'Check'}) RETURN n.key_spec AS k, n.key AS key"))[0]!;
      assert.deepEqual([oldSchema["k"], oldSchema["key"]], ["check-id", null], "an old Schema row's node_key is its key_spec, not a key");
      const checkSchema = (await h.query("MATCH (n:Node {node_type: 'Schema', type: 'Check'}) RETURN n.attributes AS a"))[0]!;
      assert.ok(!("created_at" in JSON.parse(String(checkSchema["a"]))), "no type declares the core stamp");
      const versionOf = await columnsOf(h, "VERSION_OF");
      assert.ok(versionOf.has("created_at"));
      const e = (await h.query("MATCH ()-[r:VERSION_OF {ref_id: $id}]->() RETURN r.created_at AS at, r.date_added_to_graph AS old", { id: ref["edge"] }))[0]!;
      assert.deepEqual([e["at"], e["old"]], [1_790_000_000_000, null]);
      const indexes = (await h.query("CALL SHOW_INDEXES() RETURN index_name, property_names")).filter((r) => r["index_name"] === "node_fts");
      assert.deepEqual(indexes.map((r) => r["property_names"]), [["search_text", "title"]]);
      assert.equal((await h.query("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: CORE_RENAME_MIGRATION }))[0]!["c"], 1);
    } finally {
      await h.close();
    }
  });

  it("the file as the older build left it is copied aside first, once, and still has its old columns", async () => {
    const copy = backupPath(file, CORE_RENAME_MIGRATION);
    assert.equal(existsSync(copy), true);
    assert.equal(statSync(copy).mode & 0o077, 0, "owner-only, like the graph");
    // Read raw in a child: a second Database in this process breaks the next open's extensions.
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { loadLadybug } from ${JSON.stringify(fileURLToPath(new URL("./db.js", import.meta.url)))};
         const lbug = await loadLadybug();
         const db = new lbug.Database(${JSON.stringify(copy)});
         const conn = new lbug.Connection(db);
         const rows = await (await conn.query("MATCH (n:Node) WHERE n.Data_Bank IS NOT NULL AND n.node_key IS NOT NULL RETURN count(n) AS c")).getAll();
         process.stdout.write(String(rows[0].c));
         await conn.close();
         await db.close();`,
      ],
      { env: process.env, encoding: "utf-8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "4", "every data row with its old values, for an older strut to open");
    const before = statSync(copy).mtimeMs;
    const h = await openLadybug(file);
    await h.close();
    assert.equal(statSync(copy).mtimeMs, before, "a migrated file is not backed up again");
  });

  it("keys still upsert onto the old nodes, and search finds them over search_text and title", async () => {
    const b = await openGraphBackend({ kind: "ladybug", path: file, namespace: "default" }, { embeddings: false, skipBoot: true });
    try {
      const again = await b.nodes.write({ type: "StrutWorkflow", data: { name: "harvey-deliver", description: "Deliver legal memos, again" } }, "upsert");
      assert.deepEqual([again.ref_id, again.outcome], [ref["wf"], "updated"]);
      const same = await b.nodes.write({ type: "Concept", data: { name: "Lighthouse keeper" } }, "create");
      assert.deepEqual([same.ref_id, same.outcome], [ref["concept"], "existing"]);
      const hits = await b.reader.search({ q: "lighthouse" });
      assert.deepEqual(hits.nodes.map((n) => n.ref_id), [ref["concept"]]);
      assert.equal(hits.nodes[0]!.created_at! > 1e12, true);
      const memos = await b.reader.search({ q: "memos again" });
      assert.ok(memos.nodes.some((n) => n.ref_id === ref["wf"]));
    } finally {
      await b.close();
    }
  });
});
