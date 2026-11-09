import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut, type Strut } from "../createStrut.js";
import { hostConfigFromEnv } from "../server.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore, WorkspaceManager } from "../workspace.js";
import { appIdentity } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { treeHash } from "../version.js";
import { createRegistry } from "../steps/registry.js";
import type { StepRegistry } from "../core.js";
import type { GraphBackend } from "../graph/backend.js";
import { testBackends } from "../graph/test-util.js";
import type { KitLocation } from "./kit.js";
import { STEP_RUN_TOOL, buildAppTools } from "./tools.js";
import { KNOWLEDGE_APP, KNOWLEDGE_DIR, seedKnowledgeApp } from "./knowledge-seed.js";
import { VIEWS_APP } from "./views-seed.js";
import { buildTree, conceptOf, hasDocs, opening, pathToRoot, reach, rowKey, visibleRows, type Concept } from "./knowledge/src/lib/tree.js";
import { groupLinks, isSystemType, linkLabel, orderTypes, textOf, typeDescription, typePlural } from "./knowledge/src/lib/ontology.js";
import { momentOf } from "./knowledge/src/lib/moments.js";
import { readDiff, readLog, readPage } from "./views/src/lib/history.js";
import { foldConceptDiff } from "../../kit/src/folds/concept-diff.js";

/**
 * `strut/knowledge` (plans/knowledge-app.md): the org's knowledge as a
 * first-party app strut ships — the tree it draws (roots, the unplaced,
 * several parents, cycles, paths, open rows), the ontology and links it
 * lists (which types, how a link reads), its seed beside strut/views,
 * its place in `GET /apps`, and the graph steps its page calls on a real
 * (Ladybug) graph through the app door.
 */

const c = (id: string, name = id, docs: string | null = null): Concept => ({ id, name, description: null, docs, repo: null, file: null });
const edge = (source: string, target: string, edge_type = "PARENT_OF") => ({ source, target, edge_type });

describe("strut/knowledge: the tree", () => {
  // Codebase ─┬─ strut ─┬─ Apps ── Jamie
  //           │         └─ Graph
  //           └─ hive ──── Apps (a second parent)
  // People ─── Tom          Loose (no tree)
  const tree = buildTree(
    [c("cb", "Codebase"), c("st", "strut"), c("hv", "hive"), c("ap", "Apps"), c("jm", "Jamie"), c("gr", "Graph"), c("pe", "People"), c("tm", "Tom"), c("lo", "Loose")],
    [edge("cb", "st"), edge("cb", "hv"), edge("st", "ap"), edge("hv", "ap"), edge("ap", "jm"), edge("st", "gr"), edge("pe", "tm"), edge("cb", "lo", "MENTIONS"), edge("st", "nowhere")],
  );

  it("roots have children and no parent, biggest first; a concept with neither is unplaced; only PARENT_OF between known concepts counts", () => {
    assert.deepEqual(tree.roots, ["cb", "pe"]);
    assert.deepEqual(tree.unplaced, ["lo"], "MENTIONS makes no tree");
    assert.deepEqual(tree.children["st"], ["ap", "gr"], "by name; the edge to a node not read is left out");
    assert.deepEqual(tree.parents["ap"], ["hv", "st"]);
    assert.deepEqual([...reach(tree, "cb")].sort(), ["ap", "gr", "hv", "jm", "st"]);
  });

  it("a path runs from a root through the first parent; an unknown id has none; a cycle stops", () => {
    assert.deepEqual(pathToRoot(tree, "jm"), ["cb", "hv", "ap", "jm"]);
    assert.deepEqual(pathToRoot(tree, "cb"), ["cb"]);
    assert.equal(pathToRoot(tree, "zz"), null);
    const loop = buildTree([c("a"), c("b"), c("r")], [edge("a", "b"), edge("b", "a"), edge("r", "a")]);
    assert.deepEqual(pathToRoot(loop, "b"), ["r", "a", "b"]);
    assert.deepEqual(loop.roots, ["r"]);
    const rows = visibleRows(loop, new Set(["r", "r/a", "r/a/b"]));
    assert.deepEqual(rows.map((r) => r.key), ["r", "r/a", "r/a/b"], "the node met again is not drawn twice");
  });

  it("rows: each root, and under every open row its children; a concept with two parents is a row under each", () => {
    assert.deepEqual(visibleRows(tree, new Set()).map((r) => r.key), ["cb", "pe"]);
    const open = new Set(["cb", "cb/st", "cb/hv", "cb/hv/ap"]);
    const rows = visibleRows(tree, open);
    assert.deepEqual(rows.map((r) => [r.key, r.depth, r.childCount, r.open]), [
      ["cb", 0, 2, true],
      ["cb/hv", 1, 1, true],
      ["cb/hv/ap", 2, 1, true],
      ["cb/hv/ap/jm", 3, 0, false],
      ["cb/st", 1, 2, true],
      ["cb/st/ap", 2, 1, false],
      ["cb/st/gr", 2, 0, false],
      ["pe", 0, 1, false],
    ]);
    assert.deepEqual(opening(["cb", "hv", "ap", "jm"]), ["cb", "cb/hv", "cb/hv/ap"], "the rows to open so jm shows");
    assert.equal(rowKey(["cb", "st"]), "cb/st");
  });

  it("a node's fields: name, blank text as none, docs counted only when there is something to read", () => {
    const n = conceptOf({ ref_id: "abcdef123456", properties: { name: "Apps", description: "  ", docs: "# Apps\n\nWhat strut ships.", repo: "stakwork/strut" } });
    assert.deepEqual(n, { id: "abcdef123456", name: "Apps", description: null, docs: "# Apps\n\nWhat strut ships.", repo: "stakwork/strut", file: null });
    assert.equal(conceptOf({ ref_id: "abcdef123456" }).name, "abcdef12");
    assert.equal(hasDocs(n), true);
    assert.equal(hasDocs(c("x", "x", "short")), false);
  });
});

describe("strut/knowledge: the ontology and a node's links", () => {
  it("lists the domain's types holding a node, Concept first then the biggest; strut's own and the graph's plumbing never", () => {
    const t = (type: string, count: number) => ({ type, description: "", count });
    assert.deepEqual(
      orderTypes([t("Person", 4), t("StrutRun", 90), t("Concept", 12), t("Document", 43), t("Claim", 7), t("Decision", 0), t("Feature", 4)]).map((x) => x.type),
      ["Concept", "Document", "Feature", "Person"],
    );
    assert.equal(isSystemType("StrutWorkflowVersion"), true);
    assert.equal(isSystemType("EdgeText"), true);
    assert.equal(isSystemType("Person"), false);
    assert.equal(typeDescription("?string"), "", "an attribute spec says nothing to a reader");
    assert.equal(typeDescription("Declared by the app strut/canvas (app.yaml data.graph)."), "");
    assert.equal(typeDescription("A written document"), "A written document");
    assert.deepEqual(["Concept", "Person", "Process", "Policy", "Day"].map(typePlural), ["Concepts", "People", "Processes", "Policies", "Days"]);
  });

  it("groups a node's neighbours by edge and direction, each read from this node; strut's own nodes left out, a node once per group", () => {
    const n = (ref_id: string, node_type: string, edge_type: string, direction: "forward" | "reverse") => ({ ref_id, node_type, name: ref_id, edge_type, direction });
    const groups = groupLinks([
      n("auth", "Concept", "OWNS", "forward"),
      n("billing", "Concept", "OWNS", "forward"),
      n("billing", "Concept", "OWNS", "forward"),
      n("rfc", "Document", "AUTHORED", "forward"),
      n("run1", "StrutRun", "TOUCHED", "reverse"),
      n("x", "Thing", "CITES", "reverse"),
    ]);
    assert.deepEqual(groups.map((g) => [g.label, g.nodes.map((m) => m.ref_id)]), [
      ["Owns", ["auth", "billing"]],
      ["Cites (from)", ["x"]],
      ["Wrote", ["rfc"]],
    ]);
    assert.equal(linkLabel("PARENT_OF", "forward"), "Children");
    assert.equal(linkLabel("PARENT_OF", "reverse"), "Parents");
    assert.equal(linkLabel("WORKS_AT", "forward"), "Works at");
  });

  it("a node's text: description (or summary) and docs (or body), blank as none", () => {
    assert.deepEqual(textOf({ summary: "Short", body: "# Long" }), { description: "Short", docs: "# Long" });
    assert.deepEqual(textOf({ description: " ", docs: "" }), { description: null, docs: null });
    assert.deepEqual(textOf(undefined), { description: null, docs: null });
  });
});

describe("strut/knowledge: the changes view's moments", () => {
  it("reads now, a time ago, a date and a commit as history/read takes them; anything else as none", () => {
    const now = Date.UTC(2026, 10, 9, 12, 0, 0);
    assert.equal(momentOf("now", now), "main");
    assert.equal(momentOf(" Now ", now), "main");
    assert.equal(momentOf("1 day ago", now), "2026-11-08T12:00:00.000Z");
    assert.equal(momentOf("3 hours ago", now), "2026-11-09T09:00:00.000Z");
    assert.equal(momentOf("2 weeks ago", now), "2026-10-26T12:00:00.000Z");
    assert.equal(momentOf("2026-11-01", now), "2026-11-01T00:00:00.000Z");
    assert.equal(momentOf("a1b2c3d4e5f6", now), "a1b2c3d4e5f6");
    assert.equal(momentOf("", now), null);
    assert.equal(momentOf("yesterday-ish", now), null);
  });
});

describe("strut/knowledge — seeded at boot beside strut/views", () => {
  let kit: KitLocation;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const quiet = { serveUi: false, enableChat: false, scheduler: false } as const;
  before(async () => {
    kit = await kitForTests();
  });
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("publishes strut/knowledge with strut/views compiled in, lists it in GET /apps as Knowledge; a reboot is a no-op; `knowledge: false` and `views: false` seed none", async () => {
    const dataDir = await tmp("strut-knowledge-seed-");
    const first = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    const app = await first.apps.get(KNOWLEDGE_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale], ["v1", "strut", "seed", false]);
    assert.equal(app.hash, await treeHash(KNOWLEDGE_DIR));
    assert.equal(app.manifest.title, "Knowledge");
    assert.deepEqual(app.manifest.grants.workflows, []);
    assert.deepEqual(app.manifest.grants.steps, ["graph/find", "graph/get-ontology", "graph/graph-edges", "graph/graph-get-batched", "graph/graph-neighbors", "graph/graph-search", "history/read"]);
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    const views = (await first.apps.get(VIEWS_APP))!;
    assert.deepEqual(info.imports, [{ name: VIEWS_APP, version: views.version, hash: views.hash }], "strut/views compiled in");
    assert.deepEqual(info.warnings, []);
    const html = await readFile(join(app.dir, "dist", "index.html"), "utf8");
    assert.match(html, /Reading the graph/);
    assert.doesNotMatch(html, /SPRINT-AF/, "the views gallery's fixtures stay out");
    assert.ok(info.bytes < 2_000_000, `${info.bytes} bytes`);

    // What a host's sidebar reads (stadeum's launcher: every app but strut/views, by title).
    const listed = (await (await first.app.request("/apps")).json()) as { apps: Array<{ name: string; title: string; activeVersion: string; publisher?: string }> };
    const row = listed.apps.find((a) => a.name === KNOWLEDGE_APP);
    assert.deepEqual(row && [row.title, row.activeVersion, row.publisher], ["Knowledge", "v1", "strut"]);

    const again = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    assert.deepEqual(Object.keys((await again.apps.get(KNOWLEDGE_APP))!.versions), ["v1"], "no second version");
    assert.deepEqual(await seedKnowledgeApp({ workspace: again.workspace, kit }), { version: "v1", changed: false });

    const off = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-knowledge-off-")), store: new MemoryRunStore(), kit, knowledge: false });
    assert.equal(await off.apps.get(KNOWLEDGE_APP), null);
    assert.ok(await off.apps.get(VIEWS_APP), "the others still seeded");
    const noViews = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-knowledge-noviews-")), store: new MemoryRunStore(), kit, views: false });
    assert.equal(await noViews.apps.get(KNOWLEDGE_APP), null, "nothing to build it against");
  });

  it("STRUT_HOST_CONFIG may turn it off, and nothing else", async () => {
    const file = join(await tmp("strut-knowledge-host-"), "host.json");
    await writeFile(file, JSON.stringify({ knowledge: false }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { knowledge: false });
    await writeFile(file, JSON.stringify({ knowledge: true }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"knowledge" must be false/);
  });
});

// The page's calls on a real graph, through the app door, as its viewer.
const ladybug = testBackends().find((t) => t.kind === "ladybug")!;
describe("strut/knowledge — its page reads the tree on a graph", { skip: ladybug.skip }, () => {
  let b: GraphBackend;
  let root = "";
  let strut: Strut;
  let registry: StepRegistry;
  const store = new MemoryRunStore();
  const page = (actor = "alice") => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor, runStepDeps: { store, workspace: strut.workspace } });
    const app = appIdentity(KNOWLEDGE_APP, "v1");
    return async (type: string, config: Record<string, unknown> = {}) =>
      (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
  };
  before(async () => {
    b = await ladybug.open();
    await ladybug.wipe(b);
    root = await mkdtemp(join(tmpdir(), "strut-knowledge-graph-"));
    registry = await createRegistry([]);
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      graph: b,
      store,
      registry,
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      builder: false,
      concepts: false,
      autoResume: false,
    });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await ladybug.close(b);
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("pages the Concepts, reads PARENT_OF among them and builds the tree; the ontology, counts, searches and neighbours pass; a graph write is refused", async () => {
    const write = async (name: string, docs?: string) => (await b.nodes.write({ type: "Concept", data: { name, description: `About ${name}`, ...(docs ? { docs } : {}) } })).ref_id;
    const cb = await write("Codebase", "# Codebase\n\nEvery repository the team builds.");
    const st = await write("strut");
    const ap = await write("Apps");
    const lo = await write("Loose");
    await b.edges.write({ edge: "PARENT_OF", source_ref_id: cb, target_ref_id: st });
    await b.edges.write({ edge: "PARENT_OF", source_ref_id: st, target_ref_id: ap });

    const call = page();
    const found = await call("graph/find", { node_type: "Concept", orderBy: "name", limit: 2 });
    assert.equal(found.error, undefined, found.error);
    assert.equal(found.result.nodes.length, 2);
    assert.ok(found.result.cursor, "a second page");
    const rest = await call("graph/find", { node_type: "Concept", orderBy: "name", limit: 2, cursor: found.result.cursor });
    const nodes = [...found.result.nodes, ...rest.result.nodes];
    assert.deepEqual(nodes.map((n: any) => conceptOf(n).name).sort(), ["Apps", "Codebase", "Loose", "strut"]);
    assert.equal(conceptOf(nodes.find((n: any) => n.ref_id === cb)).docs, "# Codebase\n\nEvery repository the team builds.");

    const ids = nodes.map((n: any) => n.ref_id);
    const edges = await call("graph/graph-edges", { ref_ids: ids, among: ids });
    assert.equal(edges.error, undefined, edges.error);
    const tree = buildTree(nodes.map(conceptOf), edges.result.edges);
    assert.deepEqual(tree.roots, [cb]);
    assert.deepEqual(tree.unplaced, [lo]);
    assert.deepEqual(pathToRoot(tree, ap), [cb, st, ap]);

    // The ontology the sidebar lists, and a type's count.
    const onto = await call("graph/get-ontology", {});
    assert.equal(onto.error, undefined, onto.error);
    assert.ok(Object.values(onto.result.node_types as Record<string, Array<{ type: string }>>).flat().some((t) => t.type === "Concept"));
    const counted = await call("graph/find", { node_type: "Concept", limit: 1, count: true });
    assert.equal(counted.result.total, 4);

    for (const [type, config] of [
      ["graph/graph-get-batched", { ref_ids: [ap] }],
      ["graph/graph-search", { q: "Apps", exclude_domains: "strut" }],
      ["graph/graph-neighbors", { ref_id: st }],
      ["graph/graph-search", { q: "Apps", type: "Concept" }],
    ] as const) assert.equal((await call(type, config)).error, undefined, type);
    // The graph view's call: a concept's PARENT_OF neighbours, both ways.
    const around = await call("graph/graph-neighbors", { ref_id: st, edge_type: ["PARENT_OF"] });
    assert.deepEqual(around.result.map((n: any) => `${n.direction}:${n.name}`).sort(), ["forward:Apps", "reverse:Codebase"]);
    // The card's links: every edge, grouped and read from this node.
    const all = await call("graph/graph-neighbors", { ref_id: st });
    assert.deepEqual(groupLinks(all.result).map((g) => g.label).sort(), ["Children", "Parents"]);

    for (const [type, config] of [
      ["graph/edit-node", { ref_id: ap, node_data: { docs: "x" } }],
      ["graph/delete-node", { ref_id: ap }],
      ["graph/create-node", { node_type: "Concept", node_data: { name: "New" } }],
      ["graph/create-triplet", { source_ref_id: lo, edge_type: "PARENT_OF", target_ref_id: ap }],
    ] as const) assert.match((await call(type, config)).error!, /not granted|refused/i, `read-only: ${type}`);
    assert.match((await call("run/list", { workflow: "job" })).error!, /grant/i);
  });

  it("reads a Concept's history and the tree between two moments through history/read (plans/concept-history.md §8 item 4)", async () => {
    const call = page();
    // The page's own client: each read through the app door, as the kit's would.
    const client = { run: async (type: string, config: Record<string, unknown> = {}) => {
      const r = await call(type, config);
      if (r.error) throw new Error(r.error);
      return r.result;
    } } as never;
    // The test wrote its Concepts past any run: a sync records them.
    const synced = await call("history/read", { action: "sync" });
    assert.equal(synced.error, undefined, synced.error);
    if (synced.result?.history === false) return; // no git here: nothing to read
    const first = (await readLog(client, { path: "concepts", limit: 5 })).commits[0]!;
    const apps = (await b.reader.namesLike("Concept", "Apps", 1))[0]!;
    await b.nodes.update(apps.ref_id, { set: { description: "The apps strut ships." } });
    await call("history/read", { action: "sync" });

    const history = (await readLog(client, { path: "concepts/concept-apps.md" })).commits;
    assert.ok(history.length >= 2, "the edit is a commit of its own");
    assert.equal((await readPage(client, "concepts/concept-apps.md", first.id))!.attributes["description"], "About Apps");
    const d = foldConceptDiff((await readDiff(client, { from: first.id, to: "main" })).entries);
    assert.deepEqual(d.pages.map((p) => `${p.name}:${p.status}`), ["Apps:edited"]);
    assert.deepEqual(d.pages[0]!.attributes, [{ name: "description", before: "About Apps", after: "The apps strut ships." }]);
    assert.deepEqual(d.pages[0]!.after!.parents, ["strut"]);
  });
});
