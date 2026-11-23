/**
 * FILES ON A NODE (src/node-files.ts, plans/package-seams.md §1): the store's
 * versions and limits, whose folder a step writes, the `node/*` steps on a
 * file workspace, and on every graph backend the live check, a soft delete
 * that keeps them and a delete for good that takes them.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, flow, step, type AnyStepDef, type StepContext } from "./core.js";
import type { StrutCapabilities } from "./capabilities.js";
import { createStrut, type Strut } from "./createStrut.js";
import type { GraphBackend } from "./graph/backend.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import { rawWrite, seedConceptSchema, testBackends } from "./graph/test-util.js";
import {
  bindNodeFiles,
  NODE_FILES_KEPT,
  NODE_FILES_MAX_BYTES,
  nodeFilesAs,
  nodeFilesCapability,
  nodeFileStore,
  type NodeFileStore,
} from "./node-files.js";
import { fenceStep } from "./packages/fence.js";
import { runWorkflow } from "./runner.js";
import writeFilesStep from "./steps/lib/node/write-files.js";
import { createRegistry } from "./steps/registry.js";
import { MemoryRunStore } from "./store.js";
import { FileWorkspaceStore } from "./workspace.js";

const text = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("utf-8") : undefined);
const wf = (name: string, steps: ReturnType<typeof step>[]) => flow(name, { input: z.object({}).passthrough(), steps });
/** Each step's output in a run, by step id. */
const outputsOf = async (store: MemoryRunStore, name: string, runId: string): Promise<Record<string, unknown>> =>
  Object.fromEntries((await store.getRunEvents(name, runId)).filter((e) => e.type === "step.end").map((e) => [e.path.slice(name.length + 1), e.output]));

describe("files on a node: the store", () => {
  let dir: string;
  let store: NodeFileStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-node-files-"));
    store = nodeFileStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("a write replaces the package's folder whole as its next version; a read takes the latest or the one named", async () => {
    assert.deepEqual(await store.write("acme/devbox", "n1", { "compose.yml": "a: 1\n", "seed/users.json": new Uint8Array([1, 2, 3]) }, { runId: "r1", note: "first" }), { version: 1 });
    assert.deepEqual(await store.write("acme/devbox", "n1", { "compose.yml": "a: 2\n" }), { version: 2 });

    const latest = await store.read("n1", "acme/devbox");
    assert.equal(latest?.version, 2);
    assert.deepEqual(Object.keys(latest!.files), ["compose.yml"], "the folder replaced whole");
    assert.equal(text(latest!.files["compose.yml"]), "a: 2\n");

    const first = await store.read("n1", "acme/devbox", 1);
    assert.equal(first?.runId, "r1");
    assert.equal(first?.note, "first");
    assert.deepEqual([...first!.files["seed/users.json"]!], [1, 2, 3], "bytes as written");

    assert.equal(await store.read("n1", "acme/devbox", 9), null);
    assert.equal(await store.read("n1", "other/pkg"), null);
    assert.equal(await store.read("n2", "acme/devbox"), null);

    const files = await readdir(join(dir, "nodes", "n1", "acme", "devbox"));
    assert.deepEqual(files.sort(), ["_versions.json", "v1", "v2"]);
  });

  it("keeps each package's folder apart, and lists every kept version of each, newest first", async () => {
    await store.write("acme/devbox", "n1", { a: "1" }, { runId: "r1" });
    await store.write("strut", "n1", { b: "2" });
    await store.write("acme/devbox", "n1", { a: "3", c: "33" });
    const list = await store.list("n1");
    assert.deepEqual(
      list.map((v) => [v.package, v.version, v.paths, v.bytes, v.runId]),
      [
        ["acme/devbox", 2, ["a", "c"], 3, undefined],
        ["acme/devbox", 1, ["a"], 1, "r1"],
        ["strut", 1, ["b"], 1, undefined],
      ],
    );
    assert.equal(text((await store.read("n1", "strut"))!.files["b"]), "2");
    assert.deepEqual(await store.list("nobody"), []);
  });

  it(`keeps the last ${NODE_FILES_KEPT} versions, their numbers never reused`, async () => {
    for (let i = 1; i <= NODE_FILES_KEPT + 2; i++) await store.write("acme/devbox", "n1", { n: String(i) });
    const list = await store.list("n1");
    assert.equal(list.length, NODE_FILES_KEPT);
    assert.equal(list[0]!.version, NODE_FILES_KEPT + 2);
    assert.equal(list.at(-1)!.version, 3);
    assert.equal(await store.read("n1", "acme/devbox", 2), null, "dropped");
    await assert.rejects(stat(join(dir, "nodes", "n1", "acme", "devbox", "v1")), "its folder gone too");
    assert.deepEqual(await store.write("acme/devbox", "n1", { n: "x" }), { version: NODE_FILES_KEPT + 3 });
  });

  it("refuses a version past the limit, a path that is not relative, a file that is a folder, a folder that is no package's", async () => {
    await assert.rejects(store.write("acme/devbox", "n1", { big: new Uint8Array(NODE_FILES_MAX_BYTES + 1) }), /node_files_too_big:/);
    for (const p of ["../x", "/etc/passwd", "a//b", "a/./b", "", "a\\b"]) {
      await assert.rejects(store.write("acme/devbox", "n1", { [p]: "x" }), /node_files_bad_path:/, p);
    }
    await assert.rejects(store.write("acme/devbox", "n1", { a: "1", "a/b": "2" }), /is a file and a folder/);
    for (const pkg of ["acme", "acme/devbox/x", "strut/views", "../x", "Acme Co/x"]) {
      await assert.rejects(store.write(pkg, "n1", { a: "1" }), /node_files_bad_package:/, pkg);
    }
    for (const ref of ["..", "a/b", ""]) await assert.rejects(store.write("strut", ref, { a: "1" }), /node_files_bad_ref:/, ref);
    assert.deepEqual(await store.list("n1"), [], "nothing written");
  });

  it("writes only on a live node when it can ask; remove and the sweep take a node's whole folder", async () => {
    const live = new Set(["n1", "n2"]);
    const checked = nodeFileStore(dir, { live: async (ref) => live.has(ref) });
    await checked.write("acme/devbox", "n1", { a: "1" });
    await checked.write("strut", "n2", { a: "1" });
    await assert.rejects(checked.write("acme/devbox", "gone", { a: "1" }), /node_not_found:/);

    assert.deepEqual(await checked.sweep(async (ref) => ref === "n1"), ["n2"]);
    assert.deepEqual(await checked.list("n2"), []);
    assert.equal((await checked.list("n1")).length, 1);
    assert.equal(await checked.remove("n1"), true);
    assert.equal(await checked.remove("n1"), false);
    assert.deepEqual(await readdir(join(dir, "nodes")), []);
  });
});

describe("files on a node: whose folder a step writes", () => {
  let dir: string;
  let store: NodeFileStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-node-files-"));
    store = nodeFileStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("the bag's capability writes strut's folder; another package's view and the run's both carry over", async () => {
    const cap = nodeFilesCapability(store);
    await cap.write("n1", { a: "strut's" });
    const run = bindNodeFiles({ nodeFiles: cap }, "run-7").nodeFiles;
    const pods = nodeFilesAs(run, "acme/devbox")!;
    await pods.write("n1", { a: "the package's" }, { note: "baked" });
    assert.deepEqual(
      (await cap.list("n1")).map((v) => [v.package, v.runId, v.note]),
      [
        ["acme/devbox", "run-7", "baked"],
        ["strut", undefined, undefined],
      ],
    );
    assert.equal(text((await pods.read("n1"))!.files["a"]), "the package's", "its own folder by default");
    assert.equal(text((await pods.read("n1", { package: "strut" }))!.files["a"]), "strut's", "another's by name");
    const own = { write: async () => ({ version: 1 }), read: async () => null, list: async () => [] };
    assert.equal(nodeFilesAs(own, "acme/devbox"), own, "a host's own is answered as it is");
  });

  it("node/write-files writes the workflow's package's folder, a package's step its own, behind its fence", async () => {
    const bake: AnyStepDef = defineStep({
      type: "acme/devbox/bake",
      input: z.object({ ref: z.string() }),
      output: z.any(),
      async run(cfg, ctx: StepContext<StrutCapabilities>) {
        await ctx.services.nodeFiles!.write(cfg.ref, { "image.txt": "baked" });
        // strut's step with its own ctx: still the package's folder.
        return writeFilesStep.run(writeFilesStep.input.parse({ ref_id: cfg.ref, files: { "via.txt": "strut's step" } }), ctx);
      },
    }) as AnyStepDef;
    const registry = await createRegistry([fenceStep(bake, { package: "acme/devbox", secrets: [] })]);
    const services = { nodeFiles: nodeFilesCapability(store) };

    const runs = new MemoryRunStore();
    const own = await runWorkflow(
      wf("acme/devbox/setup", [step("save", "node/write-files", { ref_id: "n1", files: { "compose.yml": "x: 1\n", "blob.bin": { base64: Buffer.from([0, 255]).toString("base64") } } }), step("read", "node/files", { ref_id: "n1" })]),
      {},
      registry,
      { services, store: runs },
    );
    assert.equal(own.status, "success", JSON.stringify(own.error));
    const read = own.output as { package: string; version: number; files: Record<string, unknown> };
    assert.equal(read.package, "acme/devbox");
    assert.deepEqual(read.files, { "blob.bin": { base64: "AP8=" }, "compose.yml": "x: 1\n" });
    assert.equal((await store.read("n1", "acme/devbox"))?.runId, own.runId, "the run that wrote it");

    const box = await runWorkflow(wf("my-flow", [step("save", "node/write-files", { ref_id: "n1", files: { a: "1" } })]), {}, registry, { services, store: runs });
    assert.equal((box.output as { package: string }).package, "strut", "outside a package: strut's");

    const baked = await runWorkflow(wf("other-flow", [step("bake", "acme/devbox/bake", { ref: "n2" })]), {}, registry, { services, store: runs });
    assert.equal(baked.status, "success", JSON.stringify(baked.error));
    assert.deepEqual(
      (await store.list("n2")).map((v) => [v.package, v.paths]),
      [
        ["acme/devbox", ["via.txt"]],
        ["acme/devbox", ["image.txt"]],
      ],
      "its package's folder, whatever workflow ran it",
    );

    const listed = await runWorkflow(wf("lister", [step("ls", "node/files", { ref_id: "n1", list: true }), step("none", "node/files", { ref_id: "n1", package: "other/pkg" })]), {}, registry, {
      services,
      store: runs,
    });
    const out = await outputsOf(runs, "lister", listed.runId);
    assert.deepEqual(
      (out["ls"] as { versions: Array<{ package: string }> }).versions.map((v) => v.package),
      ["acme/devbox", "strut"],
    );
    assert.deepEqual(out["none"], { package: "other/pkg", version: null, files: {} });
  });
});

describe("files on a node: a file workspace", () => {
  let dir: string;
  let strut: Strut;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-node-files-ws-"));
    strut = await createStrut({
      workspace: new FileWorkspaceStore(dir),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      concepts: false,
      stt: false,
    });
  });
  after(async () => {
    await strut.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a run's files under <dataDir>/nodes, with no graph to ask", async () => {
    const res = await strut.run(wf("acme/devbox/keep", [step("save", "node/write-files", { ref_id: "ws-1", files: { "a.txt": "hello" }, note: "kept" })]), {});
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.deepEqual(res.output, { ref_id: "ws-1", package: "acme/devbox", version: 1 });
    const kept = await (strut.services as StrutCapabilities).nodeFiles!.list("ws-1");
    assert.deepEqual(kept.map((v) => [v.package, v.version, v.runId, v.note]), [["acme/devbox", 1, res.runId, "kept"]]);
    assert.ok((await stat(join(strut.dataDir, "nodes", "ws-1", "acme", "devbox", "v1", "a.txt"))).isFile());
  });
});

for (const tb of testBackends()) {
  describe(`files on a node: the graph (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    let dir: string;
    let store: NodeFileStore;
    const exists = async (ref: string) => !!(await b.tx((tx) => b.nodeEngine.readRaw(tx, ref)));
    before(async () => {
      b = await tb.open();
      if (b.kind === "neo4j") {
        await tb.wipe(b);
        await seedStrutDomain(b);
        await seedConceptSchema(b);
      }
    });
    after(async () => {
      await tb.close(b);
    });
    beforeEach(async () => {
      await tb.clear(b);
      dir = await mkdtemp(join(tmpdir(), "strut-node-files-graph-"));
      store = nodeFileStore(dir, { live: async (ref) => !!(await b.reader.getNode(ref)) });
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("writes on a live node only; a soft delete keeps them, a restore finds them, a delete for good sweeps them away", async () => {
      const [ws] = await b.nodes.writeMany([{ type: "Concept", data: { name: "Workspace one" } }]);
      const ref = ws!.ref_id;
      await store.write("acme/devbox", ref, { "compose.yml": "a: 1\n" });
      await assert.rejects(store.write("acme/devbox", "no-such-node", { a: "1" }), /node_not_found:/);

      await b.nodes.deleteNode(ref);
      await assert.rejects(store.write("acme/devbox", ref, { a: "2" }), /node_not_found:/, "a deleted node takes no new version");
      assert.deepEqual(await store.sweep(exists), [], "soft-deleted: still the graph's");
      assert.equal(text((await store.read(ref, "acme/devbox"))!.files["compose.yml"]), "a: 1\n");

      if (b.nodes.restoreNode && b.kind === "ladybug") {
        await b.nodes.restoreNode(ref);
        assert.deepEqual(await store.write("acme/devbox", ref, { a: "3" }), { version: 2 }, "restored, with its versions");
      }

      await rawWrite(b, b.kind === "neo4j" ? "MATCH (n:Data_Bank {ref_id: $r}) DETACH DELETE n" : "MATCH (n:Node {ref_id: $r}) DETACH DELETE n", { r: ref });
      assert.deepEqual(await store.sweep(exists), [ref]);
      assert.deepEqual(await store.list(ref), []);
    });
  });
}
