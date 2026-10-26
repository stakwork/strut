/**
 * The one-shot fs → graph import (fs-import.ts) on both engines: labels,
 * the active pointers and every piece of workflow metadata survive; the
 * run store's files stay; a second run finds nothing; a failure moves
 * nothing; a stale non-active version is skipped and named.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation } from "../automations.js";
import { FileWorkspaceStore, versionLabelOrder } from "../workspace.js";
import { manifestSchema } from "../apps/manifest.js";
import { contentHash } from "../version.js";
import type { GraphBackend } from "./backend.js";
import { FS_IMPORT_MIGRATION_PREFIX, importAsideDir, importFileWorkspace } from "./fs-import.js";
import { testBackends } from "./test-util.js";
import { ladybugWorkspaceFromEnv } from "./wiring.js";
import { GraphWorkspaceStore } from "./workspace-store.js";

const STEP = (desc: string) => `import { z } from "zod";
import { defineStep } from "strut";
export default defineStep({ type: "tools/greet", description: ${JSON.stringify(desc)}, input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(desc)}; } });
`;
const WF = (msg: string) => ({ steps: [{ id: "a", type: "log", config: { message: msg } }] });
const AUTOMATIONS: Automation[] = [
  { id: "a-1", name: "Morning", enabled: true, trigger: { type: "schedule", every: "day", at: ["09:00"], tz: "UTC" }, input: { since: "{{ last.output.id }}" } },
];

/** A file workspace with two workflows, a two-version step, a helper, and a
 *  run record beside the workflow files. */
async function seedFileWorkspace(dataDir: string): Promise<FileWorkspaceStore> {
  const fs = new FileWorkspaceStore(dataDir);
  await fs.publishWorkflow("alpha", "v1", WF("one"), "first", "exp", "seed-x", { source: "seed" });
  await fs.publishWorkflow("alpha", "v2", WF("two"), "second", undefined, undefined, { source: "ui", actor: "evan" });
  await fs.setActiveVersion("alpha", "v1");
  await fs.setWorkflowOwner("alpha", "evan-1");
  await fs.setWorkflowRunCap("alpha", 12.5);
  await fs.setWorkflowAutomations("alpha", AUTOMATIONS);
  await fs.publishWorkflow("beta", "v1", WF("b"), "beta one");
  await fs.publishStep("tools/greet", STEP("hello"), "greets", "me");
  await fs.publishStep("tools/greet", STEP("hi there"), "greets again", "me");
  await fs.setActiveStepVersion("tools/greet", "v1");
  await fs.publishStep("tools/_shared", "export const x = 1;\n", "helper", "me");
  await mkdir(join(dataDir, "workflows", "alpha", "runs", "1700000000000"), { recursive: true });
  await writeFile(join(dataDir, "workflows", "alpha", "runs", "1700000000000", "events.jsonl"), '{"type":"run.start"}\n');
  // An app (plans/apps.md §1.3): two versions, the first active, an upstream
  // on the first (carried onto the second), and the version's files where
  // every backend reads them — under dataDir, beside the pointer.
  await fs.publishApp("acme/ui", "hash-a1", manifestSchema.parse({ title: "Kit" }), { publisher: "me", actor: "evan", source: "seed", upstream: APP_UPSTREAM });
  await fs.publishApp("acme/ui", "hash-a2", manifestSchema.parse({ title: "Kit two" }), { source: "ui", actor: "evan" });
  await fs.setActiveAppVersion("acme/ui", "v1");
  await fs.setAppPinned("acme/ui", true);
  // A HELD app (plans/app-releases.md): r1 then r2 on v1, a draft v2 since.
  await fs.publishApp("held", "hash-h1", manifestSchema.parse({ title: "Held" }));
  await fs.addAppRelease("held", { version: "v1", lock: HELD_LOCK, by: "evan" });
  await fs.addAppRelease("held", { version: "v1", lock: { workflows: {}, steps: {} } });
  await fs.publishApp("held", "hash-h2", manifestSchema.parse({ title: "Held draft" }));
  await fs.setAppLive("held", "r1");
  await mkdir(join(dataDir, "apps", "acme", "ui", "v1", "dist"), { recursive: true });
  await writeFile(join(dataDir, "apps", "acme", "ui", "v1", "dist", "index.html"), "<!doctype html>");
  return fs;
}
const APP_UPSTREAM = { package: "acme/kit", version: "1.0.0", digest: "d1", source: { ref: "file:/tmp/acme-kit" }, secrets: [] };
const HELD_LOCK = { workflows: { alpha: { version: "v1", hash: "wh" } }, steps: { "tools/greet": { version: "v1", hash: "sh" } }, floating: ["one thing"] };

describe("versionLabelOrder", () => {
  it("v2 before v10; anything else after", () => {
    assert.deepEqual(["v10", "v2", "x", "v1"].sort(versionLabelOrder), ["v1", "v2", "v10", "x"]);
  });
  it("the aside folder carries the import's moment", () => {
    assert.equal(importAsideDir("/d", new Date("2026-10-14T22:30:45.123Z")), "/d/fs-workspace.imported-2026-10-14T22-30-45");
  });
});

for (const tb of testBackends()) {
  describe(`fs → graph import (${tb.name})`, { skip: tb.skip }, () => {
    let backend: GraphBackend;
    let dir: string;
    let ws: GraphWorkspaceStore;
    before(async () => {
      backend = await tb.open();
    });
    after(() => tb.close(backend));
    beforeEach(async () => {
      await tb.wipe(backend);
      dir = await mkdtemp(join(tmpdir(), "strut-fs-import-"));
      ws = new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps", "_graph") });
    });

    it("imports every version under its label with the metadata, keeps the runs, moves the files aside, and is a no-op after", async () => {
      const fs = await seedFileWorkspace(dir);
      const alphaV2 = await fs.getWorkflowSource("alpha", "v2");
      const now = new Date("2026-10-14T22:30:45Z");

      const r = await importFileWorkspace(dir, ws, { now });
      assert.equal(r.status, "imported", r.error);
      assert.deepEqual(
        [r.workflows, r.workflowVersions, r.steps, r.stepVersions, r.skipped, r.movedTo],
        [2, 3, 2, 3, [], join(dir, "fs-workspace.imported-2026-10-14T22-30-45")],
      );

      // The graph holds it all, labels and pointers as they were.
      const list = await ws.listWorkflows();
      const alpha = list.find((w) => w.name === "alpha")!;
      assert.deepEqual(
        [alpha.activeVersion, alpha.versions.sort(versionLabelOrder), alpha.description, alpha.category, alpha.publisher, alpha.owner, alpha.maxRunCostUsd, alpha.automations],
        ["v1", ["v1", "v2"], "first", "exp", "seed-x", "evan-1", 12.5, AUTOMATIONS],
      );
      assert.deepEqual(list.find((w) => w.name === "beta")!.versions, ["v1"]);
      const meta = (await ws.getWorkflowMetadata("alpha"))!;
      assert.equal(meta.versions["v1"]!.source, "seed");
      assert.deepEqual([meta.versions["v2"]!.source, meta.versions["v2"]!.actor, meta.versions["v2"]!.description], ["ui", "evan", "second"]);
      assert.equal(meta.versions["v2"]!.hash, contentHash(alphaV2));
      assert.equal(await ws.getWorkflowSource("alpha", "v2"), alphaV2);
      assert.equal((await ws.getWorkflow("alpha")).steps[0]!.config["message"], "one", "the active version runs");

      const greet = await ws.listStepVersions("tools/greet");
      assert.deepEqual([greet.active, greet.versions.sort(versionLabelOrder)], ["v1", ["v1", "v2"]]);
      assert.equal(await ws.getStepVersionSource("tools/greet", "v2"), STEP("hi there"));
      const steps = await ws.listSteps();
      assert.deepEqual(steps.map((s) => [s.type, s.publisher, s.description]), [["tools/greet", "me", "greets"]], "the active version's description; a helper is never listed");
      assert.deepEqual(await ws.listStepVersions("tools/_shared"), { active: "v1", versions: ["v1"] }, "the helper came along");

      // The app's pointers, labels and stamps as they were; its files untouched.
      assert.deepEqual([r.apps, r.appVersions], [2, 4]);
      const app = (await ws.getApp("acme/ui"))!;
      assert.deepEqual([app.version, app.hash, app.manifest.title, app.publisher, app.owner, app.upstream, Object.keys(app.versions), app.pinned], ["v1", "hash-a1", "Kit", "me", "evan", APP_UPSTREAM, ["v1", "v2"], true]);
      assert.deepEqual([app.versions["v1"]?.source, app.versions["v2"]?.source, app.versions["v2"]?.actor], ["seed", "ui", "evan"]);
      assert.deepEqual((await ws.getApp("acme/ui", "v2"))?.upstream, APP_UPSTREAM, "carried forward in the file store, imported as recorded");
      const held = (await ws.getApp("held"))!;
      assert.deepEqual([held.version, held.live, held.releases?.map((x) => [x.id, x.version, x.by])], ["v1", "r1", [["r1", "v1", "evan"], ["r2", "v1", undefined]]]);
      assert.deepEqual(held.releases?.[0]?.lock, HELD_LOCK, "the lock as it was");
      assert.ok(existsSync(join(dir, "apps", "acme", "ui", "v1", "dist", "index.html")), "the version's directory stays where it is");
      assert.ok(existsSync(join(r.movedTo!, "apps", "acme", "ui", "_metadata.json")), "the pointer moved aside");
      assert.ok(!existsSync(join(dir, "apps", "acme", "ui", "_metadata.json")));
      assert.deepEqual(await new FileWorkspaceStore(dir).listApps(), []);

      // The files: workspace files gone from the root, the run record
      // still there, everything readable in the aside folder.
      const aside = r.movedTo!;
      assert.ok(!existsSync(join(dir, "workflows", "alpha", "_metadata.json")));
      assert.ok(!existsSync(join(dir, "workflows", "alpha", "v1.yaml")));
      assert.ok(existsSync(join(dir, "workflows", "alpha", "runs", "1700000000000", "events.jsonl")), "the run store's files stay");
      assert.ok(!existsSync(join(dir, "steps", "custom")) && !existsSync(join(dir, "steps", "_history")));
      assert.equal(await readFile(join(aside, "workflows", "alpha", "v2.yaml"), "utf-8"), alphaV2);
      assert.ok(existsSync(join(aside, "workflows", "beta", "_metadata.json")));
      assert.deepEqual((await readdir(join(aside, "steps"))).sort(), ["_history", "custom"]);
      assert.deepEqual(await new FileWorkspaceStore(dir).listWorkflows(), [], "the root reads as an empty workspace");
      assert.deepEqual(await new FileWorkspaceStore(dir).listSteps(), []);

      // Ledger-stamped, and nothing to do the second time.
      const ledger = await backend.query(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: `${FS_IMPORT_MIGRATION_PREFIX}fs-workspace.imported-2026-10-14T22-30-45` });
      assert.equal(ledger[0]!["c"], 1);
      const again = await importFileWorkspace(dir, ws);
      assert.equal(again.status, "nothing");
      assert.equal((await ws.listWorkflows()).length, 2);
    });

    it("a failing ACTIVE version fails the import and moves nothing; a label with other content in the graph is a conflict", async () => {
      await seedFileWorkspace(dir);
      // v3 of beta: metadata says active, the file is not a workflow.
      const betaDir = join(dir, "workflows", "beta");
      await writeFile(join(betaDir, "v2.yaml"), "steps: [\n", "utf-8");
      const meta = JSON.parse(await readFile(join(betaDir, "_metadata.json"), "utf-8"));
      meta.versions["v2"] = { createdAt: new Date().toISOString(), hash: contentHash("steps: [\n") };
      meta.active = "v2";
      await writeFile(join(betaDir, "_metadata.json"), JSON.stringify(meta));

      const r = await importFileWorkspace(dir, ws);
      assert.equal(r.status, "failed");
      assert.match(r.error!, /workflow "beta" v2 \(active\)/);
      assert.equal(r.movedTo, undefined);
      assert.ok(existsSync(join(dir, "workflows", "alpha", "_metadata.json")), "nothing moved");
      assert.ok(existsSync(join(dir, "steps", "custom", "_metadata.json")));
      assert.equal((await backend.query(`MATCH (m:Migration) RETURN count(m) AS c`))[0]!["c"], 0, "no ledger row");

      // Fix beta; now alpha v1 exists in the graph with other content.
      meta.active = "v1";
      delete meta.versions["v2"];
      await writeFile(join(betaDir, "_metadata.json"), JSON.stringify(meta));
      await rm(join(betaDir, "v2.yaml"));
      await tb.wipe(backend);
      await ws.publishWorkflow("alpha", "v1", WF("something else"), "theirs");
      const c = await importFileWorkspace(dir, ws);
      assert.equal(c.status, "failed");
      assert.match(c.error!, /fs_import_conflict: workflow "alpha" v1/);
      assert.ok(existsSync(join(dir, "workflows", "alpha", "v1.yaml")));
    });

    it("a non-active version today's validation refuses is skipped and named; the rest lands", async () => {
      const fs = new FileWorkspaceStore(dir);
      await fs.publishWorkflow("delta", "v1", WF("good"), "ok");
      const deltaDir = join(dir, "workflows", "delta");
      await writeFile(join(deltaDir, "v2.yaml"), "steps: [\n", "utf-8");
      const meta = JSON.parse(await readFile(join(deltaDir, "_metadata.json"), "utf-8"));
      meta.versions["v2"] = { createdAt: new Date().toISOString(), hash: contentHash("steps: [\n") };
      await writeFile(join(deltaDir, "_metadata.json"), JSON.stringify(meta)); // active stays v1

      const r = await importFileWorkspace(dir, ws);
      assert.equal(r.status, "imported", r.error);
      assert.equal(r.skipped.length, 1);
      assert.match(r.skipped[0]!, /^delta v2: /);
      assert.deepEqual((await ws.listWorkflows()).map((w) => [w.name, w.activeVersion, w.versions]), [["delta", "v1", ["v1"]]]);
      assert.equal(await readFile(join(r.movedTo!, "workflows", "delta", "v2.yaml"), "utf-8"), "steps: [\n", "kept in the aside folder");
    });

    it("a workflow beside its namespace, and the upstream on workflow and step versions, are imported as recorded", async () => {
      const fs = new FileWorkspaceStore(dir);
      const up = { package: "acme/linear", version: "1.4.0", digest: "d2", source: { ref: "file:/tmp/acme-linear" }, secrets: ["LINEAR_API_KEY"] };
      await fs.publishWorkflow("acme", "v1", WF("root"), "the root");
      await fs.publishWorkflow("acme/linear/sync", "v1", WF("sync"), "installed", undefined, undefined, { source: "install", upstream: up });
      await fs.publishWorkflow("acme/linear/sync", "v2", WF("fork"), "forked", undefined, undefined, { source: "ui" });
      await fs.publishStep("acme/linear/fetch", STEP("fetch"), "fetches", undefined, { upstream: up, source: "install", actor: "alice" });
      await mkdir(join(dir, "workflows", "acme", "runs", "1700000000001"), { recursive: true });
      await mkdir(join(dir, "workflows", "acme", "linear", "sync", "runs", "1700000000002"), { recursive: true });

      const r = await importFileWorkspace(dir, ws);
      assert.equal(r.status, "imported", r.error);
      assert.deepEqual([r.workflows, r.workflowVersions, r.steps, r.stepVersions], [2, 3, 1, 1]);
      assert.deepEqual((await ws.listWorkflows()).map((w) => [w.name, w.activeVersion]), [["acme", "v1"], ["acme/linear/sync", "v2"]]);
      const meta = (await ws.getWorkflowMetadata("acme/linear/sync"))!;
      assert.deepEqual([meta.versions["v1"]?.upstream, meta.versions["v1"]?.source, meta.versions["v2"]?.upstream], [up, "install", up]);
      const step = (await ws.getStepMetadata("acme/linear/fetch"))?.versions["v1"];
      assert.deepEqual([step?.upstream, step?.source, step?.actor], [up, "install", "alice"]);
      // Aside, nested as they were; the run records stay.
      assert.ok(existsSync(join(r.movedTo!, "workflows", "acme", "linear", "sync", "v2.yaml")));
      assert.ok(existsSync(join(r.movedTo!, "workflows", "acme", "_metadata.json")));
      assert.ok(existsSync(join(dir, "workflows", "acme", "runs", "1700000000001")));
      assert.ok(existsSync(join(dir, "workflows", "acme", "linear", "sync", "runs", "1700000000002")));
      assert.deepEqual(await new FileWorkspaceStore(dir).listWorkflows(), []);
    });

    if (tb.kind === "ladybug") {
      it("ladybugWorkspaceFromEnv runs it: a desktop's fs workspace is in the file after the boot", async () => {
        await tb.close(backend); // this case opens its own file under dir
        await seedFileWorkspace(dir);
        const { backend: b, workspace, imported } = await ladybugWorkspaceFromEnv({ STRUT_WORKSPACE: dir, STRUT_GRAPH_EMBEDDINGS: "off" });
        try {
          assert.equal(imported.status, "imported", imported.error);
          assert.deepEqual((await workspace.listWorkflows()).map((w) => w.name).sort(), ["alpha", "beta"]);
          assert.equal((await workspace.listStepVersions("tools/greet")).active, "v1");
          assert.ok(existsSync(join(dir, "graph", "graph.lbug")));
          const again = await ladybugWorkspaceFromEnv({ STRUT_WORKSPACE: dir, STRUT_GRAPH_EMBEDDINGS: "off" });
          assert.equal(again.backend, b, "the same cached backend");
          assert.equal(again.imported.status, "nothing");
        } finally {
          await b.close();
          backend = await tb.open();
        }
      });
    }
  });
}
