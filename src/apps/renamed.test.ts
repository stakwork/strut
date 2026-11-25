/**
 * Seeded apps renamed (./renamed.ts): `strut/staff` is `strut/workers` and
 * `strut/worker` is `strut/tasks`. A box that ran the old names boots with
 * the new ones (./renamed-boot.ts) — Support's database, the task types and
 * the public view carried over, the old apps deleted — and a link made
 * before opens the new name.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import type { PublicSurface } from "../public-surface.js";
import { kitForTests } from "../test-util/app-kit.js";
import { setEnv } from "../test-util/public-door.js";
import { renamedApp, renamedAppUrl } from "./renamed.js";
import { carryRenamedRecords, retireRenamedApps } from "./renamed-boot.js";
import { seedBundledApp } from "./views-seed.js";

const HELLO = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "hello");
const surface = (apps: PublicSurface["apps"]): PublicSurface => ({ concepts: [], workflows: [], steps: [], types: [], apps, runnable: [] });

describe("renamedApp, renamedAppUrl", () => {
  it("an old name is its new one; any other name is itself", () => {
    assert.deepEqual(["strut/staff", "strut/worker", "strut/workers", "strut/tasks", "hello", "constructor"].map(renamedApp), ["strut/workers", "strut/tasks", "strut/workers", "strut/tasks", "hello", "constructor"]);
  });
  it("puts ?app= and ?back= to the new names; a link that names neither is left alone", () => {
    const url = new URL(renamedAppUrl("https://s.example/lab/?app=strut%2Fworker&solo=1&public=1&lang=es")!);
    assert.deepEqual([url.pathname, Object.fromEntries(url.searchParams)], ["/lab/", { app: "strut/tasks", solo: "1", public: "1", lang: "es" }]);
    assert.equal(new URL(renamedAppUrl("https://s.example/?app=call-guide&back=strut/worker")!).searchParams.get("back"), "strut/tasks");
    assert.equal(new URL(renamedAppUrl("https://s.example/?app=strut/staff&input=tab%3Dsupport")!).searchParams.get("app"), "strut/workers");
    assert.equal(renamedAppUrl("https://s.example/?app=strut/tasks&solo=1"), null);
    assert.equal(renamedAppUrl("https://s.example/?wf=x"), null);
  });
});

describe("retireRenamedApps, carryRenamedRecords", () => {
  it("moves each old name's database and state, deletes the old app, and is a no-op the second time", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-renamed-"));
    try {
      await mkdir(join(dataDir, "apps", "strut", "staff", ".state"), { recursive: true });
      await writeFile(join(dataDir, "apps", "strut", "staff", "data.db"), "support");
      await writeFile(join(dataDir, "apps", "strut", "staff", "data.db-journal"), "journal");
      await writeFile(join(dataDir, "apps", "strut", "staff", ".state", "ann.json"), "{}");
      await mkdir(join(dataDir, "apps", "strut", "worker", ".state"), { recursive: true });
      await writeFile(join(dataDir, "apps", "strut", "worker", ".state", "bo.json"), "{}");
      const live = new Set(["strut/staff", "strut/worker", "hello"]);
      const deps = { dataDir, hasApp: async (n: string) => live.has(n), deleteApp: async (n: string) => live.delete(n) };
      assert.deepEqual(await retireRenamedApps(deps), [
        "strut/staff → strut/workers: moved data.db",
        "strut/staff → strut/workers: moved data.db-journal",
        "strut/staff → strut/workers: moved .state",
        "strut/staff: deleted",
        "strut/worker → strut/tasks: moved .state",
        "strut/worker: deleted",
      ]);
      assert.equal(await readFile(join(dataDir, "apps", "strut", "workers", "data.db"), "utf8"), "support");
      assert.ok(existsSync(join(dataDir, "apps", "strut", "workers", ".state", "ann.json")));
      assert.ok(existsSync(join(dataDir, "apps", "strut", "tasks", ".state", "bo.json")));
      assert.ok(!existsSync(join(dataDir, "apps", "strut", "staff", "data.db")));
      assert.deepEqual([...live], ["hello"]);
      assert.deepEqual(await retireRenamedApps(deps), [], "done once");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("leaves an old database where it is when the new name has its own", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-renamed-"));
    try {
      await mkdir(join(dataDir, "apps", "strut", "staff"), { recursive: true });
      await mkdir(join(dataDir, "apps", "strut", "workers"), { recursive: true });
      await writeFile(join(dataDir, "apps", "strut", "staff", "data.db"), "old");
      await writeFile(join(dataDir, "apps", "strut", "workers", "data.db"), "new");
      assert.deepEqual(await retireRenamedApps({ dataDir, hasApp: async () => false, deleteApp: async () => {} }), []);
      assert.equal(await readFile(join(dataDir, "apps", "strut", "staff", "data.db"), "utf8"), "old");
      assert.equal(await readFile(join(dataDir, "apps", "strut", "workers", "data.db"), "utf8"), "new");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retypes the task types and puts the new name in the public view, in place, or drops the old one when the new is there", async () => {
    const types = [{ name: "labels", app: "strut/worker" }, { name: "pages", app: "pages-app" }];
    let view = surface([{ name: "pages-app" }, { name: "strut/worker", reads: ["x/read"] }]);
    const deps = {
      retypeApp: async (from: string, to: string) => types.filter((t) => t.app === from).map((t) => ((t.app = to), t.name)),
      publicView: { get: async () => view, set: async (next: PublicSurface) => (view = next) },
    };
    assert.deepEqual(await carryRenamedRecords(deps), ["strut/worker → strut/tasks: task types labels", "strut/worker → strut/tasks: the public view"]);
    assert.deepEqual(types.map((t) => t.app), ["strut/tasks", "pages-app"]);
    assert.deepEqual(view.apps, [{ name: "pages-app" }, { name: "strut/tasks", reads: ["x/read"] }]);
    assert.deepEqual(await carryRenamedRecords(deps), [], "done once");
    view = surface([{ name: "strut/tasks" }, { name: "strut/worker" }]);
    await carryRenamedRecords(deps);
    assert.deepEqual(view.apps, [{ name: "strut/tasks" }]);
  });
});

describe("a box that ran strut/staff and strut/worker", () => {
  it("boots with strut/workers and strut/tasks: Support's rows, the task types and the public view carried over, the old apps gone, an old link opens the new name", async () => {
    const KEY = "renamed-key";
    const admin = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
    const restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_PEER_KEY: undefined });
    const root = await mkdtemp(join(tmpdir(), "strut-renamed-boot-"));
    const quiet = { serveUi: false, enableChat: false, enableMcp: false, scheduler: false, autoResume: false } as const;
    // The new apps stay out: the hello fixture stands in for strut/tasks.
    const seedsOff = { views: false, jamie: false, knowledge: false, earnings: false, workersApp: false, tasksApp: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false, concepts: false, systemWorkflows: false } as const;
    const boot = () => createStrut({ ...quiet, ...seedsOff, workspace: new WorkspaceManager(root) });
    try {
      const kit = await kitForTests();
      // What the last release left: a task type and the public view naming
      // strut/worker (written through the routes as an admin would) …
      let strut = await boot();
      const put = await strut.app.request("/tasks/types/labels", { method: "PUT", headers: admin, body: JSON.stringify({ app: "strut/worker", answer: { type: "object", properties: { product: { type: "string" } } } }) });
      assert.equal(put.status, 200, await put.text());
      const pv = await strut.app.request("/public-view", { method: "PUT", headers: admin, body: JSON.stringify(surface([{ name: "strut/worker" }])) });
      assert.equal(pv.status, 200, await pv.text());
      await strut.close?.();
      // … the two seeded apps (strut/staff with a migration, as Support's
      // has), Support's database with a row, and strut/tasks to open.
      const staffSrc = await mkdtemp(join(tmpdir(), "strut-renamed-src-"));
      await cp(HELLO, staffSrc, { recursive: true });
      await mkdir(join(staffSrc, "db"));
      await writeFile(join(staffSrc, "db", "001-old.sql"), "CREATE TABLE old_only (x TEXT);");
      const ws = new WorkspaceManager(root);
      await seedBundledApp({ workspace: ws, name: "strut/staff", dir: staffSrc, kit });
      for (const name of ["strut/worker", "strut/tasks"]) await seedBundledApp({ workspace: ws, name, dir: HELLO, kit });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(root, "apps", "strut", "staff", "data.db"));
      db.exec("CREATE TABLE conversations (id TEXT); INSERT INTO conversations VALUES ('ann')");
      db.close();
      await rm(staffSrc, { recursive: true, force: true });

      strut = await boot();
      try {
        assert.equal(await strut.workspace.getApp("strut/staff").catch(() => null), null);
        assert.equal(await strut.workspace.getApp("strut/worker").catch(() => null), null);
        const moved = new DatabaseSync(join(root, "apps", "strut", "workers", "data.db"), { readOnly: true });
        assert.deepEqual(moved.prepare("SELECT id FROM conversations").all().map((r) => r["id"]), ["ann"]);
        moved.close();
        assert.ok(!existsSync(join(root, "apps", "strut", "staff", "data.db")), "the old app is gone before the seeded migrations run");
        const types = (await (await strut.app.request("/tasks/types", { headers: admin })).json()) as { types: Array<{ name: string; app: string }> };
        assert.deepEqual(types.types.map((t) => [t.name, t.app]), [["labels", "strut/tasks"]]);
        const view = (await (await strut.app.request("/public-view", { headers: admin })).json()) as { surface: PublicSurface };
        assert.deepEqual(view.surface.apps.map((a) => a.name), ["strut/tasks"]);
        const old = await strut.app.request("/public/apps/strut/worker");
        assert.equal(old.status, 200);
        assert.equal(((await old.json()) as { name: string }).name, "strut/tasks");
        assert.equal((await strut.app.request("/public/apps/strut/worker/document")).status, 200);
      } finally {
        await strut.close?.();
      }
    } finally {
      restoreEnv();
      await rm(root, { recursive: true, force: true });
    }
  });
});
