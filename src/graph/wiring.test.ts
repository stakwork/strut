import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../createStrut.js";
import { coreRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { graphConfigFromEnv } from "./bolt.js";
import { testBackends } from "./test-util.js";
import {
  DEFAULT_NEO4J_HOST,
  graphMaterializeDir,
  graphWorkspaceRequested,
  ladybugConfigFromEnv,
  ladybugGraphPath,
  ladybugWorkspaceFromEnv,
  workspaceBackendFromEnv,
} from "./wiring.js";

describe("graph workspace wiring defaults", () => {
  it("graph by default; STRUT_WORKSPACE_BACKEND=fs opts out (case-insensitive)", () => {
    assert.equal(graphWorkspaceRequested({}), true);
    assert.equal(graphWorkspaceRequested({ STRUT_WORKSPACE_BACKEND: "Graph" }), true);
    assert.equal(graphWorkspaceRequested({ STRUT_WORKSPACE_BACKEND: "FS" }), false);
    assert.equal(graphWorkspaceRequested({ STRUT_WORKSPACE_BACKEND: "file" }), false);
  });
  it("materializes custom steps inside the data dir (module resolution), apart from steps/custom", () => {
    assert.equal(graphMaterializeDir("./lab-workspace"), "lab-workspace/steps/_graph");
  });
  it("connection defaults match the mcp host: localhost:7687 / neo4j / testtest; env wins", () => {
    const d = graphConfigFromEnv({ NEO4J_HOST: DEFAULT_NEO4J_HOST })!;
    assert.deepEqual([d.uri, d.user, d.password, d.namespace], ["bolt://localhost:7687", "neo4j", "testtest", "default"]);
    const e = graphConfigFromEnv({ NEO4J_HOST: DEFAULT_NEO4J_HOST, NEO4J_URI: "bolt://db:7688", NEO4J_PASSWORD: "pw" })!;
    assert.deepEqual([e.uri, e.password], ["bolt://db:7688", "pw"]);
  });
});

describe("workspace backend selection (plans/ladybug-backend.md §4)", () => {
  it("neo4j unless fs or ladybug is named, case-insensitively", () => {
    assert.equal(workspaceBackendFromEnv({}), "neo4j");
    assert.equal(workspaceBackendFromEnv({ STRUT_WORKSPACE_BACKEND: "graph" }), "neo4j");
    assert.equal(workspaceBackendFromEnv({ STRUT_WORKSPACE_BACKEND: "Ladybug" }), "ladybug");
    assert.equal(workspaceBackendFromEnv({ STRUT_WORKSPACE_BACKEND: "fs" }), "fs");
    assert.equal(graphWorkspaceRequested({ STRUT_WORKSPACE_BACKEND: "ladybug" }), true);
  });
  it("the Ladybug file: STRUT_GRAPH_DB, else <dataDir>/graph/graph.lbug; the extension dir and namespace from env", () => {
    assert.deepEqual(ladybugConfigFromEnv({}, "/data"), { kind: "ladybug", path: "/data/graph/graph.lbug", namespace: "default" });
    assert.deepEqual(ladybugConfigFromEnv({ STRUT_GRAPH_DB: "/elsewhere/g.lbug", STRUT_LADYBUG_EXTENSION_DIR: "/app/native", STRUT_GRAPH_NAMESPACE: "x" }, "/data"), {
      kind: "ladybug",
      path: "/elsewhere/g.lbug",
      namespace: "x",
      extensionDir: "/app/native",
    });
    assert.equal(ladybugGraphPath("ws"), "ws/graph/graph.lbug");
  });
});

// ── Live, on a Ladybug file (skipped with the reason when the addon or the
// extensions are missing) ───────────────────────────────────────────────────

const ladybugSkip = testBackends().find((b) => b.kind === "ladybug")!.skip;
describe("ladybugWorkspaceFromEnv → createStrut", { skip: ladybugSkip }, () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-lbug-wiring-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("opens the file under dataDir, is the bag's graph, and /health names the backend and the file", async () => {
    const env = { STRUT_WORKSPACE_BACKEND: "ladybug", STRUT_WORKSPACE: dir, STRUT_GRAPH_EMBEDDINGS: "off" };
    const { backend, workspace } = await ladybugWorkspaceFromEnv(env);
    try {
      assert.equal(backend.kind, "ladybug");
      assert.equal(backend.cfg.path, join(dir, "graph", "graph.lbug"));
      assert.equal(workspace.graph, backend);
      assert.ok(existsSync(join(dir, "graph", "graph.lbug")));
      await workspace.publishWorkflow("hello", "v1", { steps: [{ id: "a", type: "log", config: { message: "hi" } }] }, "first");

      const strut = await createStrut({
        workspace,
        dataDir: dir,
        store: new MemoryRunStore(),
        registry: coreRegistry(),
        serveUi: false,
        enableChat: false,
        stt: false,
        scheduler: false,
      });
      assert.equal((strut.services as { graph?: unknown }).graph, backend, "services.graph is the wired backend");
      process.env["STRUT_API_KEY"] = "k-wiring";
      try {
        const health = (await (await strut.app.request("/health", { headers: { authorization: "Bearer k-wiring" } })).json()) as Record<string, unknown>;
        assert.deepEqual(health["workspace"], { backend: "ladybug", path: join(dir, "graph", "graph.lbug") });
        const list = (await (await strut.app.request("/workflows", { headers: { authorization: "Bearer k-wiring" } })).json()) as Array<{ name: string }>;
        assert.ok(list.some((w) => w.name === "hello"), "the workflow published into the file is listed (beside the seeded ones)");
      } finally {
        delete process.env["STRUT_API_KEY"];
      }
    } finally {
      await backend.close();
    }
  });
});
