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
import { MIGRATIONS, ddlStatements, indexCalls, openLadybug, type LadybugHandle } from "./db.js";
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
    await h.exclusive((w) => w("MATCH (n:Node {ref_id: 'w1'}) SET n.date_added_to_graph = 1700000000000, n.name = 'one'"));
    const [row] = await h.query("MATCH (n:Node {ref_id: 'w1'}) RETURN n, n.deleted_at AS gone, {a: n.name, b: n.description} AS s");
    const n = row!["n"] as Record<string, unknown>;
    assert.equal(typeof n["date_added_to_graph"], "number");
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
         await h.withWrite((tx) => tx.run("CREATE (:Node {ref_id: 'a', name: 'one', Data_Bank: 'some text'})"));
         await h.withWrite((tx) => tx.run("MATCH (n:Node {ref_id: 'a'}) SET n.name = 'one again'"));
         process.exit(0);`,
      ],
      { env: process.env, encoding: "utf-8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const again = await openLadybug(file);
    try {
      await again.withWrite((tx) => tx.run("MATCH (n:Node {ref_id: 'a'}) SET n.name = 'two'"));
      assert.equal((await again.query("MATCH (n:Node {ref_id: 'a'}) RETURN n.name AS name"))[0]!["name"], "two");
    } finally {
      await again.close();
    }
  });
  it("close() folds the WAL into the file, so a restart replays nothing", async () => {
    const file = join(dir, "clean", "graph.lbug");
    const c = await openLadybug(file);
    await c.withWrite((tx) => tx.run("CREATE (:Node {ref_id: 'a', name: 'one', Data_Bank: 'some text'})"));
    await c.close();
    assert.equal(existsSync(`${file}.wal`), false);
  });
});
