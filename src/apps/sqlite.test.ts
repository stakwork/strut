import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { StepContext } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { appIdentity } from "../auth.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { createRegistry } from "../steps/registry.js";
import { kitForTests } from "../test-util/app-kit.js";
import { FileWorkspaceStore } from "../workspace.js";
import sqliteQuery from "../steps/lib/sqlite/query.js";
import sqliteExec from "../steps/lib/sqlite/exec.js";
import sqliteBatch from "../steps/lib/sqlite/batch.js";
import { createApps } from "./apps.js";
import { appsRoot } from "./files.js";
import type { KitLocation } from "./kit.js";
import { AppDatabases, MIGRATIONS_TABLE, QUERY_ROWS_MAX, sqlProblem } from "./sqlite.js";
import { STEP_RUN_TOOL, buildAppTools } from "./tools.js";

/**
 * An app's own SQLite file (plans/apps.md §4.4): the keyword pre-check; the
 * file's migrations (in order, once, each in its own transaction, a changed
 * one refused, a failing one rolled back); reads on a read-only connection,
 * writes one statement at a time or in one transaction; a publish applying
 * `db/*.sql` before the version and publishing nothing when one fails; the
 * `sqlite/*` steps finding the file from `ctx.app` and refusing `app` under
 * it; the app door's `grants.sqlite` with writes kept; the export route.
 */

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-app-sqlite-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
let n = 0;
const fresh = (name: string) => join(root, `${name}-${++n}`);

async function writeFiles(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
  return dir;
}

const APP_TSX = 'export default function App() { return <p className="p-2">hi</p>; }\n';
const V1_SQL = "CREATE TABLE line_items (id INTEGER PRIMARY KEY, invoice TEXT NOT NULL, amount REAL NOT NULL, note TEXT);\n";
const V2_SQL = "ALTER TABLE line_items ADD COLUMN paid INTEGER NOT NULL DEFAULT 0;\nCREATE INDEX line_items_invoice ON line_items (invoice);\n";

describe("sqlProblem — the keyword pre-check", () => {
  it("refuses ATTACH, DETACH, VACUUM INTO, load_extension, a PRAGMA outside the read list or set, and a second statement", () => {
    assert.match(sqlProblem("ATTACH DATABASE '/etc/x' AS x")!, /ATTACH is refused/);
    assert.match(sqlProblem("detach x")!, /DETACH is refused/);
    assert.match(sqlProblem("VACUUM INTO '/tmp/copy.db'")!, /VACUUM INTO is refused/);
    assert.match(sqlProblem("SELECT load_extension('evil')")!, /load_extension is refused/);
    assert.match(sqlProblem("PRAGMA writable_schema = 1")!, /PRAGMA writable_schema = … is refused/);
    assert.match(sqlProblem("PRAGMA journal_mode")!, /PRAGMA journal_mode is refused/);
    assert.match(sqlProblem("PRAGMA main.user_version = 3")!, /user_version = … is refused/);
    assert.match(sqlProblem("SELECT 1; SELECT 2")!, /one statement per call/);
    assert.match(sqlProblem("   ")!, /empty/);
  });

  it("reads past comments, strings and quoted names, allows a read PRAGMA, a trailing semicolon, and several statements in a migration", () => {
    assert.equal(sqlProblem("SELECT 'attach; detach' AS \"VACUUM INTO\" -- load_extension(\n"), null);
    assert.equal(sqlProblem("/* ATTACH */ SELECT * FROM [attach]"), null);
    assert.equal(sqlProblem("PRAGMA table_info(line_items)"), null);
    assert.equal(sqlProblem("PRAGMA user_version"), null);
    assert.equal(sqlProblem("SELECT 1;  \n"), null);
    assert.equal(sqlProblem(V2_SQL, { many: true }), null);
    assert.match(sqlProblem(`${V2_SQL}ATTACH 'x' AS y;`, { many: true })!, /ATTACH/);
  });
});

describe("AppDatabases — one file per app", () => {
  it("migrates in name order, each once, recorded; refuses a changed one; rolls a failing one back and applies nothing after it", async () => {
    const dbs = new AppDatabases(fresh("root"));
    const dir = await writeFiles(fresh("app"), { "db/002_paid.sql": V2_SQL, "db/001_init.sql": V1_SQL, "db/README.md": "not a migration" });
    assert.deepEqual(await dbs.migrate("invoices", dir), { ok: true, applied: ["001_init.sql", "002_paid.sql"] });
    assert.deepEqual(await dbs.migrate("invoices", dir), { ok: true, applied: [] }, "each once");
    const db = await dbs.database("invoices");
    assert.deepEqual(db.migrations().map((m) => m.name), ["001_init.sql", "002_paid.sql"]);
    assert.deepEqual(db.query("PRAGMA table_info(line_items)").rows.map((r) => r["name"]), ["id", "invoice", "amount", "note", "paid"]);

    await writeFile(join(dir, "db/001_init.sql"), `${V1_SQL}-- edited\n`);
    const changed = await dbs.migrate("invoices", dir);
    assert.equal(changed.ok, false);
    assert.match(changed.ok ? "" : changed.errors[0]!, /db\/001_init\.sql: applied on .* and changed since — a migration runs once/);
    await writeFile(join(dir, "db/001_init.sql"), V1_SQL);

    await writeFile(join(dir, "db/003_bad.sql"), "CREATE TABLE t3 (a INTEGER);\nINSERT INTO nowhere VALUES (1);\n");
    await writeFile(join(dir, "db/004_after.sql"), "CREATE TABLE t4 (a INTEGER);\n");
    const failed = await dbs.migrate("invoices", dir);
    assert.equal(failed.ok, false);
    assert.match(failed.ok ? "" : failed.errors[0]!, /db\/003_bad\.sql: no such table: nowhere — nothing from it was applied/);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").rows.map((r) => r["name"]);
    assert.deepEqual(tables, [MIGRATIONS_TABLE, "line_items"], "t3 rolled back, t4 never ran");

    await writeFile(join(dir, "db/003_bad.sql"), "BEGIN;\nCREATE TABLE t3 (a INTEGER);\nCOMMIT;\n");
    const txn = await dbs.migrate("invoices", dir);
    assert.match(txn.ok ? "" : txn.errors[0]!, /leave out BEGIN and COMMIT/);
    dbs.close();
  });

  it("reads on a read-only connection, writes one statement or a batch in one transaction, and keeps the file owner-only", async () => {
    const dbs = new AppDatabases(fresh("root"));
    await dbs.migrate("ledger", await writeFiles(fresh("app"), { "db/001.sql": V1_SQL }));
    const db = await dbs.database("ledger");
    assert.equal((await stat(db.path)).mode & 0o777, 0o600);

    assert.deepEqual(db.exec("INSERT INTO line_items (invoice, amount, note) VALUES (?, ?, ?)", ["INV-1", 12.5, { po: 7 }]), { changes: 1, lastInsertRowid: 1 });
    db.exec("INSERT INTO line_items (invoice, amount) VALUES (:invoice, :amount)", { invoice: "INV-1", amount: 3 });
    const read = db.query("SELECT invoice, sum(amount) AS total, max(note) AS note FROM line_items GROUP BY invoice");
    assert.deepEqual(read, { columns: ["invoice", "total", "note"], rows: [{ invoice: "INV-1", total: 15.5, note: '{"po":7}' }] });
    assert.throws(() => db.query("DELETE FROM line_items"), /readonly|read-only|attempt to write/i, "a query cannot write");
    assert.throws(() => db.exec("SELECT 1; DELETE FROM line_items"), /one statement per call/);

    assert.throws(
      () => db.batch([{ sql: "INSERT INTO line_items (invoice, amount) VALUES ('INV-2', 1)" }, { sql: "INSERT INTO line_items (invoice) VALUES ('INV-2')" }]),
      /statements\[1\]: NOT NULL constraint failed: line_items\.amount/,
    );
    assert.equal(db.query("SELECT count(*) AS n FROM line_items").rows[0]!["n"], 2, "the batch rolled back whole");
    assert.throws(() => db.batch([{ sql: "INSERT INTO line_items (invoice, amount) VALUES ('x', 1)" }, { sql: "ATTACH 'x' AS y" }]), /statements\[1\]: ATTACH is refused/);
    assert.equal(db.query("SELECT count(*) AS n FROM line_items").rows[0]!["n"], 2, "a refused statement runs nothing");
    const ok = db.batch([
      { sql: "INSERT INTO line_items (invoice, amount) VALUES (?, ?)", params: ["INV-2", 4] },
      { sql: "UPDATE line_items SET note = ? WHERE invoice = ?", params: ["paid", "INV-1"] },
    ]);
    assert.deepEqual(ok.results.map((r) => r.changes), [1, 2]);

    db.exec("CREATE TABLE blobs (b BLOB)");
    db.exec("INSERT INTO blobs VALUES (?)", [{ base64: Buffer.from("hi").toString("base64") }]);
    assert.deepEqual(db.query("SELECT b FROM blobs").rows, [{ b: { base64: Buffer.from("hi").toString("base64") } }]);

    db.exec("CREATE TABLE many (i INTEGER)");
    db.exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${QUERY_ROWS_MAX + 10}) INSERT INTO many SELECT i FROM c`);
    const capped = db.query("SELECT i FROM many");
    assert.equal(capped.rows.length, QUERY_ROWS_MAX);
    assert.equal(capped.truncated, true);

    const out = join(fresh("export"), "copy.db");
    await mkdir(dirname(out), { recursive: true });
    assert.equal(await dbs.exportTo("ledger", out), true);
    assert.equal((await readFile(out)).subarray(0, 15).toString(), "SQLite format 3");
    assert.equal(await dbs.exportTo("nobody", out), false);
    dbs.close();
  });
});

describe("an app's database through the apps capability and the steps", () => {
  it("a publish applies db/*.sql before the version; a failing migration publishes nothing; app/get reports the database", async () => {
    const dataDir = fresh("ws");
    const ws = new FileWorkspaceStore(dataDir);
    const apps = createApps({ workspace: ws, kit: await kitForTests(), root: appsRoot(dataDir) });
    try {
      const dir = await writeFiles(fresh("src"), { "app.yaml": "title: Invoices\ngrants: { sqlite: true }\n", "src/App.tsx": APP_TSX, "db/001_init.sql": V1_SQL });
      const v1 = await apps.publish(dir, "invoices", { surface: "ai" });
      assert.ok(v1.ok, v1.ok ? "" : v1.errors.join("\n"));
      assert.deepEqual(v1.ok && v1.migrations, ["001_init.sql"]);
      assert.equal((await stat(join(dataDir, "apps", "invoices", "data.db"))).isFile(), true, "beside the versions");

      await writeFiles(dir, { "db/002_bad.sql": "ALTER TABLE nowhere ADD COLUMN x INTEGER;\n", "src/App.tsx": APP_TSX.replace("hi", "v2") });
      const bad = await apps.publish(dir, "invoices", { surface: "ai" });
      assert.equal(bad.ok, false);
      assert.match(bad.ok ? "" : bad.errors.join("\n"), /db\/002_bad\.sql: no such table: nowhere/);
      assert.deepEqual(Object.keys((await ws.getApp("invoices"))!.versions), ["v1"], "nothing published");

      await writeFiles(dir, { "db/002_bad.sql": V2_SQL });
      const v2 = await apps.publish(dir, "invoices", { surface: "ai" });
      assert.ok(v2.ok && v2.version === "v2");
      assert.deepEqual(v2.ok && v2.migrations, ["002_bad.sql"]);
      const view = (await apps.get("invoices"))!;
      assert.deepEqual(view.database?.migrations.map((m) => m.name), ["001_init.sql", "002_bad.sql"]);
      assert.ok((view.database?.bytes ?? 0) > 0);

      const noRoot = createApps({ workspace: new FileWorkspaceStore(fresh("ws")), kit: await kitForTests() });
      const refused = await noRoot.publish(dir, "invoices", { surface: "person" });
      assert.match(refused.ok ? "" : refused.errors.join("\n"), /keeps no app databases/);

      // The steps: the file from ctx.app; `app` names it from outside, and is refused under ctx.app.
      const ctx = (app?: { name: string; version: string }) => ({ services: { apps }, ...(app ? { app } : {}) }) as unknown as StepContext<StrutCapabilities>;
      const own = ctx({ name: "invoices", version: "v2" });
      await sqliteExec.run({ sql: "INSERT INTO line_items (invoice, amount) VALUES (?, ?)", params: ["INV-9", 9] }, own);
      await sqliteBatch.run({ statements: [{ sql: "UPDATE line_items SET paid = 1 WHERE invoice = 'INV-9'" }] }, own);
      assert.deepEqual((await sqliteQuery.run({ sql: "SELECT invoice, paid FROM line_items" }, own)).rows, [{ invoice: "INV-9", paid: 1 }]);
      assert.equal((await sqliteQuery.run({ sql: "SELECT count(*) AS n FROM line_items", app: "invoices" }, ctx())).rows[0]["n"], 1, "named from outside the app");
      await assert.rejects(sqliteQuery.run({ sql: "SELECT 1", app: "other" }, own), /`app` is refused here — this call works for the app invoices/);
      await assert.rejects(sqliteQuery.run({ sql: "SELECT 1" }, ctx()), /name the app whose database to use/);
      await assert.rejects(sqliteQuery.run({ sql: "SELECT 1", app: "ghost" }, ctx()), /no app "ghost" on this strut/);
    } finally {
      await apps.close();
    }
  });
});

describe("an app's database at the app door and over HTTP", () => {
  const KEY = "sqlite-door-key";
  const PEER_KEY = "sqlite-peer-key";
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  const store = new MemoryRunStore();
  let kit: KitLocation;
  let strut: Strut;
  let tools: ReturnType<typeof buildAppTools>;

  const call = async (app: string, type: string, config: Record<string, unknown>) =>
    (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app: appIdentity(app, "v1") }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER_KEY;
    kit = await kitForTests();
    const dataDir = fresh("door");
    const workspace = new FileWorkspaceStore(dataDir);
    const registry = await createRegistry([]);
    strut = await createStrut({
      workspace,
      store,
      registry,
      kit,
      scheduler: false,
      serveUi: false,
      enableChat: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      browserWorkflows: false,
      privacyWorkflows: false,
    });
    for (const [name, manifest] of [
      ["tracker", "title: Tracker\ngrants: { sqlite: true }\n"],
      ["plain", "title: Plain\ngrants: { steps: ['sqlite/*'] }\n"],
    ] as const) {
      const dir = await writeFiles(fresh(name), { "app.yaml": manifest, "src/App.tsx": APP_TSX, "db/001_init.sql": V1_SQL });
      const r = await strut.apps.publish(dir, name, { surface: "person" });
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    }
    tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor: "viewer", runStepDeps: { store, workspace } });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    for (const [k, v] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a page with grants.sqlite writes its own file — kept, as the viewer — and reads it, not kept; without the grant, or naming an app, it is refused", async () => {
    const wrote = await call("tracker", "sqlite/exec", { sql: "INSERT INTO line_items (invoice, amount) VALUES (?, ?)", params: ["INV-1", 20] });
    assert.equal(wrote.error, undefined, wrote.error);
    assert.deepEqual(wrote.result, { changes: 1, lastInsertRowid: 1 });
    const read = await call("tracker", "sqlite/query", { sql: "SELECT invoice, amount FROM line_items" });
    assert.deepEqual(read.result.rows, [{ invoice: "INV-1", amount: 20 }]);
    const kept = await store.listRuns("step:sqlite/exec");
    assert.equal(kept.length, 1);
    const summary = (await store.getRunSummary("step:sqlite/exec", kept[0]!))!;
    assert.deepEqual([summary.actor, summary.app], ["viewer", { name: "tracker", version: "v1" }]);
    assert.deepEqual(await store.listRuns("step:sqlite/query"), [], "a read is not kept");

    assert.match((await call("plain", "sqlite/query", { sql: "SELECT 1" })).error ?? "", /grants\.sqlite is false/);
    assert.match((await call("tracker", "sqlite/query", { sql: "SELECT 1", app: "plain" })).error ?? "", /`app` is refused — a page uses its own app's database/);
    assert.match((await call("tracker", "sqlite/vacuum", {})).error ?? "", /not a step of the app's database/);
  });

  it("GET /apps/:name/data exports one consistent copy, to the key and to a peer as every read is; an unknown app is a 404", async () => {
    const res = await strut.app.request("/apps/tracker/data", { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/vnd.sqlite3");
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
    const peer = await strut.app.request("/apps/tracker/data", { headers: { authorization: `Bearer ${PEER_KEY}` } });
    assert.equal(peer.status, 200);
    assert.equal(Buffer.from(await peer.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
    assert.equal((await strut.app.request("/apps/tracker/data")).status, 401, "never without a credential");
    const nobody = await strut.app.request("/apps/ghost/data", { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(nobody.status, 404);
  });
});
