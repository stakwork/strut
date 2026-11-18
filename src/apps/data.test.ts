import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStrut, type Strut } from "../createStrut.js";
import { appIdentity } from "../auth.js";
import type { StepContext } from "../core.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { kitForTests } from "../test-util/app-kit.js";
import { appDbPath, createAppDatabases, MIGRATIONS_TABLE, runBatch, runExec, runQuery, sqlRefusal, type AppDatabases } from "./data.js";
import { parseManifest } from "./manifest.js";
import query from "../steps/lib/sqlite/query.js";
import exec from "../steps/lib/sqlite/exec.js";
import batch from "../steps/lib/sqlite/batch.js";

/**
 * An app's own SQLite (plans/apps.md §4.4, work item 3; plans/people-and-hosts.md
 * item 4): the file, the migrations, the `sqlite/*` steps and their refusals,
 * the grant and the kept writes on the app door, the export, and a seeded
 * app's migrations at boot.
 */

const write = async (dir: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
};

const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

describe("the keyword pre-check (plans/apps.md §4.4)", () => {
  it("refuses ATTACH, DETACH, VACUUM INTO, load_extension and a PRAGMA outside the read allowlist", () => {
    for (const [sql, word] of [
      ["ATTACH DATABASE '/tmp/other.db' AS o", /ATTACH/],
      ["attach '/x' as y", /ATTACH/],
      ["DETACH o", /DETACH/],
      ["VACUUM INTO '/tmp/copy.db'", /VACUUM INTO/],
      ["VACUUM main INTO '/tmp/copy.db'", /VACUUM INTO/],
      ["SELECT load_extension('evil')", /load_extension/],
      ["PRAGMA writable_schema = 1", /writable_schema/],
      ["PRAGMA main.journal_mode = WAL", /journal_mode/],
      ["PRAGMA database_list", /database_list/],
      ["PRAGMA user_version = 7", /never set/],
      ["PRAGMA user_version(7)", /never set/],
      ["PRAGMA table_info = x", /never set/],
      ["SELECT * FROM pragma_database_list", /pragma_database_list/],
      ["CREATE TABLE t (a); ATTACH 'x' AS y", /ATTACH/],
    ] as const) {
      assert.match(sqlRefusal(sql) ?? "", word, sql);
    }
  });

  it("reads past strings, comments and quoted names, and lets the read PRAGMAs through", () => {
    for (const sql of [
      "SELECT 'attach the file, then vacuum into the box' AS note",
      "SELECT 1 -- ATTACH 'x' AS y",
      "SELECT 1 /* DETACH x; load_extension('y') */",
      'SELECT "attach" FROM t',
      "SELECT [detach] FROM t",
      "PRAGMA table_info(invoices)",
      "PRAGMA main.index_list('invoices')",
      "PRAGMA user_version",
      "PRAGMA integrity_check",
      "SELECT name FROM pragma_table_info('invoices')",
      "VACUUM",
      "SELECT 'it''s attached'",
    ]) {
      assert.equal(sqlRefusal(sql), null, sql);
    }
  });
});

describe("an app's database and its migrations", () => {
  let root: string;
  let dbs: AppDatabases;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-app-data-"));
    dbs = createAppDatabases({ dataDir: join(root, "data") });
  });
  after(async () => {
    dbs.close();
    await rm(root, { recursive: true, force: true });
  });

  it("is one owner-only file per app beside its versions, made only when there is something to keep", async () => {
    const empty = join(root, "empty");
    await write(empty, { "app.yaml": "title: Empty\n" });
    assert.deepEqual(await dbs.migrate("acme/empty", empty), { ok: true, applied: [], warnings: [] });
    assert.equal(dbs.has("acme/empty"), false, "no migrations: no file");
    await dbs.open("acme/notes");
    const file = appDbPath(join(root, "data"), "acme/notes");
    assert.equal(file, join(root, "data", "apps", "acme", "notes", "data.db"));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(dbs.has("acme/notes"), true);
    await assert.rejects(dbs.open("../outside"), /Invalid app name/, "a name is never a path out");
    assert.throws(() => appDbPath(root, "acme/data.db"), /the app's database/);
  });

  it("applies db/*.sql in name order, each once and recorded, and warns when an applied one changed", async () => {
    const dir = join(root, "ordered");
    // 010 sorts after 002, and needs both before it.
    await write(dir, {
      "db/010-index.sql": "CREATE INDEX lines_by_invoice ON lines (invoice);",
      "db/001-init.sql": "CREATE TABLE invoices (id INTEGER PRIMARY KEY, number TEXT NOT NULL);",
      "db/002-lines.sql": "CREATE TABLE lines (id INTEGER PRIMARY KEY, invoice INTEGER REFERENCES invoices(id), cents INTEGER);\n-- a comment\nINSERT INTO invoices (number) VALUES ('A-1');",
      "db/notes.txt": "not a migration",
    });
    const first = await dbs.migrate("ordered", dir);
    assert.deepEqual(first, { ok: true, applied: ["001-init.sql", "002-lines.sql", "010-index.sql"], warnings: [] });
    const db = await dbs.open("ordered");
    assert.deepEqual((db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name), ["001-init.sql", "002-lines.sql", "010-index.sql"]);
    // Again: nothing runs twice (002's insert would add a second row).
    assert.deepEqual(await dbs.migrate("ordered", dir), { ok: true, applied: [], warnings: [] });
    assert.equal((db.prepare("SELECT count(*) AS n FROM invoices").get() as { n: number }).n, 1);
    // An edited migration is not run again, and says so.
    await writeFile(join(dir, "db/001-init.sql"), "CREATE TABLE invoices (id INTEGER PRIMARY KEY, number TEXT, due TEXT);");
    await writeFile(join(dir, "db/011-due.sql"), "ALTER TABLE invoices ADD COLUMN due TEXT;");
    const next = await dbs.migrate("ordered", dir);
    assert.ok(next.ok);
    assert.deepEqual(next.applied, ["011-due.sql"]);
    assert.match(next.warnings.join("\n"), /db\/001-init\.sql changed since it was applied/);
  });

  it("rolls a failing migration back whole, keeps the ones before it, and stops the rest", async () => {
    const dir = join(root, "failing");
    await write(dir, {
      "db/001-ok.sql": "CREATE TABLE a (x);",
      "db/002-bad.sql": "CREATE TABLE b (x);\nINSERT INTO a VALUES (1);\nINSERT INTO nowhere VALUES (1);",
      "db/003-never.sql": "CREATE TABLE c (x);",
    });
    const r = await dbs.migrate("failing", dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.applied, ["001-ok.sql"]);
    assert.match(!r.ok ? r.errors.join("\n") : "", /db\/002-bad\.sql failed, and nothing of it was kept: .*nowhere/);
    const db = await dbs.open("failing");
    assert.deepEqual(tables(db), [MIGRATIONS_TABLE, "a"], "002's table and 003 are not there");
    assert.equal((db.prepare("SELECT count(*) AS n FROM a").get() as { n: number }).n, 0, "002's insert rolled back");
    // Fixed, it applies from where it stopped.
    await writeFile(join(dir, "db/002-bad.sql"), "CREATE TABLE b (x);");
    assert.deepEqual(await dbs.migrate("failing", dir), { ok: true, applied: ["002-bad.sql", "003-never.sql"], warnings: [] });
  });

  it("refuses a migration that attaches another file or ends strut's transaction", async () => {
    const dir = join(root, "sneaky");
    await write(dir, { "db/001-attach.sql": "ATTACH DATABASE 'other.db' AS o;\nCREATE TABLE o.t (x);" });
    const r = await dbs.migrate("sneaky", dir);
    assert.ok(!r.ok && /db\/001-attach\.sql: ATTACH is refused/.test(r.errors[0]!), JSON.stringify(r));
    const own = join(root, "own-tx");
    await write(own, { "db/001-commit.sql": "CREATE TABLE t (x);\nCOMMIT;" });
    const c = await dbs.migrate("own-tx", own);
    assert.ok(!c.ok && /ends the transaction strut runs it in/.test(c.errors[0]!), JSON.stringify(c));
    // `check` tries them in memory and leaves nothing behind.
    const tried = await dbs.check(dir);
    assert.equal(tried.ok, false);
    assert.equal(dbs.has("sneaky-unknown"), false);
  });

  it("copies the database whole for the export", async () => {
    const db = await dbs.open("copied");
    db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('kept');");
    const copy = await dbs.copy("copied");
    assert.ok(copy);
    const chunks: Buffer[] = [];
    for await (const chunk of copy.stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, copy.bytes);
    assert.equal(bytes.subarray(0, 15).toString(), "SQLite format 3");
    assert.equal(await dbs.copy("never-opened"), null);
  });
});

describe("the statements", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT, data BLOB, big INTEGER)");

  it("exec writes one statement and query reads, values as JSON carries them", () => {
    const r = runExec(db, "INSERT INTO notes (text, data, big) VALUES (?, ?, ?)", ["hi", { base64: Buffer.from("bytes").toString("base64") }, "9007199254740993"]);
    assert.deepEqual(r, { changes: 1, lastInsertRowid: 1 });
    runExec(db, "UPDATE notes SET big = CAST(:big AS INTEGER) WHERE id = :id", { big: "9007199254740993", id: 1 });
    runExec(db, "INSERT INTO notes (text) VALUES (?)", [{ tags: ["a", "b"] }]);
    runExec(db, "INSERT INTO notes (text, big) VALUES (?, ?)", [true, 5]);
    const q = runQuery(db, "SELECT id, text, data, big FROM notes ORDER BY id");
    assert.deepEqual(q.columns, ["id", "text", "data", "big"]);
    assert.equal(q.truncated, false);
    assert.deepEqual(q.rows[0], { id: 1, text: "hi", data: { base64: Buffer.from("bytes").toString("base64") }, big: "9007199254740993" });
    assert.equal(q.rows[1]!["text"], '{"tags":["a","b"]}', "an object goes in as its JSON text");
    assert.deepEqual([q.rows[2]!["text"], q.rows[2]!["big"]], ["1", 5], "a boolean is 1");
    assert.deepEqual(runQuery(db, "SELECT id FROM notes WHERE id = 99").columns, ["id"], "columns with no rows");
  });

  it("caps a query's rows and refuses a write in it", () => {
    for (let i = 0; i < 5; i++) runExec(db, "INSERT INTO notes (text) VALUES (?)", [`n${i}`]);
    const q = runQuery(db, "SELECT id FROM notes", undefined, 2);
    assert.equal(q.rows.length, 2);
    assert.equal(q.truncated, true);
    assert.throws(() => runQuery(db, "DELETE FROM notes"), /only reads: a write goes through sqlite\/exec/);
    assert.throws(() => runQuery(db, "INSERT INTO notes (text) VALUES ('x') RETURNING id"), /only reads/);
    // query_only is off again for the next write.
    assert.equal(runExec(db, "INSERT INTO notes (text) VALUES ('after')").changes, 1);
  });

  it("refuses a second statement, a transaction of the caller's own, and the pre-check's words", () => {
    assert.throws(() => runExec(db, "DELETE FROM notes WHERE id = 1; DELETE FROM notes"), /one statement per call/);
    assert.throws(() => runQuery(db, "SELECT 1; SELECT 2"), /one statement per call/);
    assert.equal(runQuery(db, "SELECT 1 AS one; -- and a comment").rows[0]!["one"], 1, "a trailing comment is no statement");
    for (const sql of ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT s", "RELEASE s"]) assert.throws(() => runExec(db, sql), /may not open or end a transaction/, sql);
    assert.throws(() => runExec(db, "ATTACH ':memory:' AS o"), /ATTACH is refused/);
    assert.equal(db.isTransaction, false);
    // A trigger's own BEGIN … END is one statement.
    runExec(db, "CREATE TRIGGER stamp AFTER INSERT ON notes BEGIN UPDATE notes SET big = 7 WHERE id = new.id; END");
    const id = runExec(db, "INSERT INTO notes (text) VALUES ('t')").lastInsertRowid;
    assert.equal(runQuery(db, "SELECT big FROM notes WHERE id = ?", [id]).rows[0]!["big"], 7);
  });

  it("runs a batch in one transaction: all of it, or none", () => {
    const before = runQuery(db, "SELECT count(*) AS n FROM notes").rows[0]!["n"] as number;
    const ok = runBatch(db, ["INSERT INTO notes (text) VALUES ('b1')", { sql: "INSERT INTO notes (text) VALUES (?)", params: ["b2"] }]);
    assert.equal(ok.results.length, 2);
    assert.equal(runQuery(db, "SELECT count(*) AS n FROM notes").rows[0]!["n"], before + 2);
    assert.throws(() => runBatch(db, ["INSERT INTO notes (text) VALUES ('b3')", "INSERT INTO nowhere VALUES (1)"]), /statement 2: .*nothing in the batch was kept/);
    assert.throws(() => runBatch(db, ["INSERT INTO notes (text) VALUES ('b4')", "DETACH x"]), /statement 2: DETACH is refused/);
    assert.equal(runQuery(db, "SELECT count(*) AS n FROM notes").rows[0]!["n"], before + 2, "neither failed batch kept a row");
    assert.equal(db.isTransaction, false);
  });
});

describe("the sqlite/* steps: which database", () => {
  const dbs = createAppDatabases({ memory: true });
  const apps = { manifestOf: async (name: string) => (name === "acme/notes" || name === "other" ? { version: "v1", manifest: {}, seeded: false } : null) };
  const ctx = (app?: string) => ({ services: { appDb: dbs, apps }, ...(app ? { app: { name: app, version: "v1" } } : {}) }) as unknown as StepContext;

  it("runs on ctx.app's own database, and refuses to name one when ctx.app is set", async () => {
    await exec.run({ sql: "CREATE TABLE t (x)" }, ctx("acme/notes"));
    await exec.run({ sql: "INSERT INTO t VALUES (?)", params: ["mine"] }, ctx("acme/notes"));
    await assert.rejects(exec.run({ sql: "SELECT 1", app: "other" }, ctx("acme/notes")), /`app` names a database, and this call runs for the app acme\/notes/);
    await assert.rejects(query.run({ sql: "SELECT 1", app: "acme/notes" }, ctx("acme/notes")), /drop `app`/, "even its own name");
    const rows = await query.run({ sql: "SELECT x FROM t" }, ctx("acme/notes"));
    assert.deepEqual(rows.rows, [{ x: "mine" }]);
  });

  it("with no ctx.app, runs on the app it names, which must exist", async () => {
    assert.deepEqual((await query.run({ sql: "SELECT x FROM t", app: "acme/notes" }, ctx())).rows, [{ x: "mine" }], "a workflow of its own reads the app's file");
    await assert.rejects(query.run({ sql: "SELECT 1" }, ctx()), /needs `app`/);
    await assert.rejects(query.run({ sql: "SELECT 1", app: "nobody" }, ctx()), /no app "nobody"/);
    assert.equal(dbs.has("nobody"), false, "no file for a name that is no app");
    await assert.rejects(query.run({ sql: "SELECT x FROM t" }, ctx("other")), /no such table: t/, "another app's database is another file");
    const b = await batch.run({ statements: ["INSERT INTO t VALUES ('b1')", { sql: "INSERT INTO t VALUES (?)", params: ["b2"] }], app: "acme/notes" }, ctx());
    assert.equal(b.results.length, 2);
  });
});

describe("an app's SQLite through a strut server", () => {
  const KEY = "app-data-key";
  const saved = process.env["STRUT_API_KEY"];
  const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${KEY}` };
  let root: string;
  let strut: Strut;
  const store = new MemoryRunStore();

  /** A page's call of `step_run`: the tool's result, or its error. */
  const page = async (app: string, version: string, type: string, config: Record<string, unknown>) => {
    const res = await strut.app.request("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "step_run", arguments: { type, config, app: appIdentity(app, version) } } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const r = JSON.parse(line ? line.slice(6) : text).result as { isError?: boolean; content: Array<{ text: string }> };
    // The tool's output, unwrapped (toModelOutput): the step's, or `{ error }`.
    const body = JSON.parse(r.content[0]!.text) as any;
    return r.isError ? { error: (body?.error as string | undefined) ?? r.content[0]!.text } : { result: body };
  };

  const publish = async (name: string, files: Record<string, string>) => {
    const dir = join(root, "src", name, String(Date.now()));
    await write(dir, { "src/App.tsx": 'export default function App() { return <p className="p-2">hi</p>; }\n', ...files });
    return strut.apps.publish(dir, name, { surface: "person" });
  };

  const SQL_APP = "title: Ledger\ngrants:\n  sqlite: true\n";

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    root = await mkdtemp(join(tmpdir(), "strut-app-data-server-"));
    const workspace = new FileWorkspaceStore(join(root, "ws"));
    // A seeded app strut published before this boot, with a migration its database never had.
    const seeded = await workspace.publishApp("seeded-notes", "seed-hash-1", parseManifest({ title: "Seeded notes", grants: { sqlite: true } }), { publisher: "strut", source: "seed" });
    await write((await workspace.materializeAppVersion("seeded-notes", seeded.version)).path, {
      "app.yaml": "title: Seeded notes\ngrants:\n  sqlite: true\n",
      "db/001-notes.sql": "CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('from the seed');",
    });
    strut = await createStrut({
      workspace,
      store,
      kit: await kitForTests(),
      scheduler: false,
      serveUi: false,
      enableChat: false,
      enableMcp: true,
      job: false,
      orchestrator: false,
      builder: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      views: false,
      jamie: false,
      knowledge: false,
      earnings: false,
      staff: false,
      worker: false,
    });
  });

  after(async () => {
    await strut?.close();
    await rm(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });

  it("applies a seeded app's migrations at boot", async () => {
    const db = await (strut.services as { appDb: AppDatabases }).appDb.open("seeded-notes");
    assert.deepEqual(db.prepare("SELECT text FROM notes").all().map((r) => ({ ...r })), [{ text: "from the seed" }]);
  });

  it("applies the migrations at publish, and a page with grants.sqlite writes and reads its own rows, its writes kept", async () => {
    const r = await publish("ledger", { "app.yaml": SQL_APP, "db/001-init.sql": "CREATE TABLE entries (id INTEGER PRIMARY KEY, what TEXT, cents INTEGER);" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual(r.migrations, ["001-init.sql"]);
    const wrote = await page("ledger", "v1", "sqlite/exec", { sql: "INSERT INTO entries (what, cents) VALUES (?, ?)", params: ["coffee", 350] });
    assert.deepEqual(wrote, { result: { changes: 1, lastInsertRowid: 1 } });
    const both = await page("ledger", "v1", "sqlite/batch", { statements: [{ sql: "INSERT INTO entries (what, cents) VALUES (?, ?)", params: ["tea", 200] }, "UPDATE entries SET cents = cents + 1"] });
    assert.equal(both.result?.results.length, 2, JSON.stringify(both));
    const read = await page("ledger", "v1", "sqlite/query", { sql: "SELECT what, cents FROM entries ORDER BY id" });
    assert.deepEqual(read.result, { columns: ["what", "cents"], rows: [{ what: "coffee", cents: 351 }, { what: "tea", cents: 201 }], truncated: false });
    // The writes are kept runs with the viewer and the app; the read is not.
    for (const type of ["sqlite/exec", "sqlite/batch"]) {
      const kept = await store.listRuns(`step:${type}`);
      assert.equal(kept.length, 1, type);
      const summary = (await store.getRunSummary(`step:${type}`, kept[0]!))!;
      assert.deepEqual([summary.app?.name, summary.app?.version], ["ledger", "v1"], type);
      assert.equal(summary.status, "success", type);
    }
    assert.deepEqual(await store.listRuns("step:sqlite/query"), []);
    // Naming a database from a page is refused.
    assert.match((await page("ledger", "v1", "sqlite/query", { sql: "SELECT 1", app: "seeded-notes" })).error ?? "", /`app` names a database/);
    // A new version shares the file; its new migration runs once.
    const v2 = await publish("ledger", { "app.yaml": SQL_APP, "db/001-init.sql": "CREATE TABLE entries (id INTEGER PRIMARY KEY, what TEXT, cents INTEGER);", "db/002-tags.sql": "ALTER TABLE entries ADD COLUMN tag TEXT;" });
    assert.ok(v2.ok && v2.version === "v2" && v2.migrations?.join() === "002-tags.sql", JSON.stringify(v2));
    assert.equal((await page("ledger", "v2", "sqlite/query", { sql: "SELECT count(*) AS n FROM entries WHERE tag IS NULL" })).result?.rows[0].n, 2);
  });

  it("refuses sqlite/* to a page whose app does not grant it", async () => {
    const r = await publish("no-sql", { "app.yaml": "title: No SQL\n", "db/001-init.sql": "CREATE TABLE t (x);" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.match((await page("no-sql", "v1", "sqlite/query", { sql: "SELECT * FROM t" })).error ?? "", /does not grant it — app\.yaml grants: \{ sqlite: true \}/);
  });

  it("fails a publish whose migration fails, and activates nothing", async () => {
    const ok = await publish("strict", { "app.yaml": SQL_APP, "db/001-init.sql": "CREATE TABLE a (x);" });
    assert.ok(ok.ok);
    const bad = await publish("strict", { "app.yaml": "title: Strict two\ngrants:\n  sqlite: true\n", "db/001-init.sql": "CREATE TABLE a (x);", "db/002-broken.sql": "CREATE TABLE b (x);\nINSERT INTO missing VALUES (1);" });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.errors.join("\n") : "", /db\/002-broken\.sql failed/);
    const rec = await strut.workspace.getApp("strict");
    assert.deepEqual([rec?.active, Object.keys(rec?.versions ?? {})], ["v1", ["v1"]], "no version recorded");
    assert.match((await page("strict", "v1", "sqlite/query", { sql: "SELECT * FROM b" })).error ?? "", /no such table: b/, "its transaction rolled back");
    // The build says so before a publish does.
    const dir = join(root, "src", "strict-build");
    await write(dir, { "app.yaml": SQL_APP, "src/App.tsx": "export default function App() { return null; }\n", "db/001-attach.sql": "ATTACH 'x.db' AS x;" });
    const built = await strut.apps.build(dir);
    assert.ok(!built.ok && /ATTACH is refused/.test(built.errors.join("\n")), JSON.stringify(built));
  });

  it("exports the file behind the key: GET /apps/:name/data", async () => {
    const res = await strut.app.request(`/apps/${encodeURIComponent("ledger")}/data`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/vnd.sqlite3");
    assert.match(res.headers.get("content-disposition") ?? "", /filename="ledger\.db"/);
    const file = join(root, "export.db");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const db = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(db.prepare("SELECT what FROM entries ORDER BY id").all().map((r) => r["what"]), ["coffee", "tea"]);
    db.close();
    assert.equal((await strut.app.request("/apps/ledger/data")).status, 401, "behind the key");
    assert.equal((await strut.app.request("/apps/nobody/data", { headers: { authorization: `Bearer ${KEY}` } })).status, 404);
    const none = await publish("no-tables", { "app.yaml": "title: No tables\n" });
    assert.ok(none.ok);
    assert.equal((await strut.app.request("/apps/no-tables/data", { headers: { authorization: `Bearer ${KEY}` } })).status, 404, "no database yet");
  });
});
