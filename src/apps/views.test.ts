import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctNodeRefs, foldRunOverview, projectWithLaunches, type OverviewEvent } from "@strut/kit/folds";
import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { kitForTests } from "../test-util/app-kit.js";
import type { KitLocation } from "./kit.js";
import { VIEWS_APP, VIEWS_DIR, seedViewsApp } from "./views-seed.js";
import { treeHash } from "../version.js";
import { CHILD_EVENTS, CHILD_RUN_ID, REF, RUN_EVENTS } from "./views/src/fixtures/runs.js";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { RunGraphReader } from "./views/src/components/run-graph/reader.js";

const quiet = { serveUi: false, enableChat: false, scheduler: false } as const;

describe("strut/views — what its run views draw", () => {
  it("RunTimeline's fold over the gallery's run: a row per step, the work each started under it, the child and peer runs it can open", () => {
    const o = foldRunOverview(RUN_EVENTS as OverviewEvent[]);
    assert.equal(o.status, "success");
    assert.equal(o.durationMs, 50_200);
    assert.equal(o.modelCalls, 15);
    assert.equal(Math.round(o.cost * 1e4) / 1e4, 0.2905);
    assert.deepEqual(
      o.rows.map((r) => [r.label, r.kind, r.depth]),
      [
        ["plan", "llm", 0],
        ["explore", "agent", 0],
        ["graph_walk", "step", 1],
        ["summarize", "run", 1],
        ["@acme-lab lookup", "peer", 1],
        ["each", "loop", 0],
        ["pack", "step", 0],
      ],
    );
    assert.deepEqual(o.rows[3]!.child, { runId: CHILD_RUN_ID, workflow: "summarize" });
    assert.equal(o.rows[4]!.child?.peer, "acme-lab");
  });

  it("RunGraph's data path: the calls from run/events, the nodes, edges and lineage read through graph-get-batched and graph-neighbors, a peer's node never read here", async () => {
    const { calls, launches } = projectWithLaunches(RUN_EVENTS);
    assert.equal(calls.length, 8);
    assert.equal(calls[0]!.hits, 3, "a search's matches are counted, not drawn");
    assert.deepEqual(launches.get("research/explore/005-meta_run_workflow"), { workflow: "summarize", runId: CHILD_RUN_ID });
    assert.equal(launches.get("research/explore/006-strut_run_workflow")?.peer, "acme-lab");

    const reader = new RunGraphReader(createFixtureClient());
    await reader.read(distinctNodeRefs(calls));
    const s = reader.snapshot();
    assert.deepEqual([s.nodesRead, s.edgesRead, s.lineageRead, s.truncated], [true, true, true, false]);
    const byName = new Map(s.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("Arrhythmia")?.found, true);
    assert.equal(byName.get("Medicine")?.ancestor, true, "the lineage above what the run touched");
    assert.equal(byName.get("Cardiology")?.ancestor, undefined, "a touched node is never an ancestor");
    const peer = byName.get("Lab panels")!;
    assert.deepEqual([peer.found, peer.peer, peer.ref_id.startsWith("@acme-lab:")], [false, "acme-lab", true]);
    assert.deepEqual(s.peers?.map((p) => [p.slug, p.read]), [["acme-lab", false]]);
    const edge = (a: string, t: string, b: string) => s.edges.some((e) => e.source === a && e.edge_type === t && e.target === b);
    assert.ok(edge(REF.medicine, "PARENT_OF", REF.cardiology));
    assert.ok(edge(REF.cardiology, "PARENT_OF", REF.arrhythmia));
    assert.ok(edge(REF.trial, "ABOUT", REF.hypertension));
    assert.ok(reader.bodies.get(REF.arrhythmia)?.properties["docs"], "a node's body is read with it");

    // A child run opens through the runId its launching call named, under that call's path.
    const prefix = "research/explore/005-meta_run_workflow";
    const child = projectWithLaunches(CHILD_EVENTS, { prefix });
    assert.deepEqual(child.calls.map((c) => c.path), [`${prefix}/summarize/read/001-graph_graph_get`, `${prefix}/summarize/read/002-graph_graph_get`]);
    await reader.read(distinctNodeRefs(child.calls));
    assert.equal(reader.snapshot().nodes.filter((n) => n.name === "ESC guideline 2026").length, 1, "read once");
  });

  it("without the graph steps granted, the nodes are as the run's log named them", async () => {
    const refusing = { run: async () => { throw new Error('step "graph/graph-get-batched" is not granted to this app'); } };
    const reader = new RunGraphReader(refusing);
    await reader.read(distinctNodeRefs(projectWithLaunches(RUN_EVENTS).calls));
    const s = reader.snapshot();
    assert.equal(s.nodesRead, false);
    assert.match(s.unreadReason ?? "", /not granted/);
    assert.ok(s.nodes.some((n) => n.name === "Hypertension" && !n.found), "the name the step reported");
  });
});

describe("strut/views — seeded at boot, imported by apps", () => {
  let kit: KitLocation;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  before(async () => {
    kit = await kitForTests();
  });
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("publishes strut/views on a clean workspace — its gallery built to a document — and is a no-op on reboot; `views: false` seeds nothing", async () => {
    const dataDir = await tmp("strut-views-seed-");
    const first = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    const app = await first.apps.get(VIEWS_APP);
    assert.ok(app, "seeded");
    assert.equal(app.version, "v1");
    assert.equal(app.hash, await treeHash(VIEWS_DIR));
    assert.equal(app.publisher, "strut");
    assert.equal(app.stale, false);
    assert.deepEqual(app.manifest.grants, { workflows: [], steps: [], sqlite: false, automations: [] }, "no grants of its own");
    const html = await readFile(join(app.dir, "dist", "index.html"), "utf8");
    assert.match(html, /"gallery"/, "the gallery page");

    const again = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    const rec = await again.apps.get(VIEWS_APP);
    assert.equal(rec?.version, "v1");
    assert.deepEqual(Object.keys(rec?.versions ?? {}), ["v1"], "no second version");
    assert.deepEqual(await seedViewsApp({ workspace: again.workspace, kit }), { version: "v1", changed: false });

    const off = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-views-off-")), store: new MemoryRunStore(), kit, views: false });
    assert.equal(await off.apps.get(VIEWS_APP), null);
  });

  it("an app that imports strut/views builds — the import's hash in its build.json — and carries only what it uses", async () => {
    const dataDir = await tmp("strut-views-import-");
    const strut = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    await strut.workspace.publishWorkflowByContent("research", "name: research\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n");
    const views = (await strut.apps.get(VIEWS_APP))!;
    const dir = join(await tmp("strut-views-importer-"), "viewer");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Viewer\ngrants:\n  workflows: [research]\n  steps: [graph/graph-get-batched, graph/graph-neighbors]\n");
    await writeFile(
      join(dir, "src", "App.tsx"),
      `import { RunGraph, RunTimeline } from "strut/views";\nexport default function App() {\n  return <div className="p-4"><RunTimeline workflow="research" runId="1" /><RunGraph workflow="research" runId="1" /></div>;\n}\n`,
    );
    const built = await strut.apps.build(dir, { name: "acme/viewer" });
    assert.ok(built.ok, built.ok ? "" : built.errors.join("\n"));
    assert.deepEqual(built.imports, [{ name: VIEWS_APP, version: "v1", hash: views.hash }]);
    const info = JSON.parse(await readFile(join(dir, "dist", "build.json"), "utf8"));
    assert.deepEqual(info.imports, [{ name: VIEWS_APP, version: "v1", hash: views.hash }]);
    const html = await readFile(join(dir, "dist", "index.html"), "utf8");
    assert.doesNotMatch(html, /react-flow__/, "NodeGraph and its stylesheet stay out of an app that does not draw one");
    assert.doesNotMatch(html, /SPRINT-AF/, "the gallery's fixtures stay out");
    assert.ok(built.bytes < 1_200_000, `${built.bytes} bytes`);
  });
});
