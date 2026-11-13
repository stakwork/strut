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
import { buildTree, conceptOf, hasDocs, opening, parentsByName, pathToRoot, reach, rowKey, visibleRows, type Concept } from "./knowledge/src/lib/tree.js";
import { groupLinks, isSystemType, linkLabel, orderTypes, textOf, typeDescription, typePlural } from "./knowledge/src/lib/ontology.js";
import { momentOf } from "./knowledge/src/lib/moments.js";
import {
  byStatus, changesByConcept, claimsUnavailable, conceptOfChange, evidenceLine, waitingAcross, waitingWords, DREAM, type PageClaim, type PendingChange,
} from "./knowledge/src/lib/learning.js";
import { cycleSpan, cycleWords, cyclesFor, cyclesUnavailable, runsOf, CYCLES_STEP, type DreamCycle } from "./knowledge/src/lib/cycles.js";
import { readDiff, readLog, readPage, readProposalEntry } from "./views/src/lib/history.js";
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
    // A Concept branch's name, when the history holds it (plans/concept-evals.md item c).
    assert.equal(momentOf("try", now, ["main", "try"]), "try");
    assert.equal(momentOf(" Try ", now, ["main", "try"]), "try");
    assert.equal(momentOf("try", now), null);
    assert.equal(momentOf("main", now, ["main", "try"]), "main");
  });
});

describe("strut/knowledge: claims and the changes waiting on a person", () => {
  const claim = (id: string, status: PageClaim["status"]): PageClaim => ({ id, text: id, status });
  const change = (id: string, step: string, input: unknown, createdAt = "2026-11-11T10:00:00Z", status = "pending"): PendingChange => ({ id, step, title: id, status, createdAt, input });

  it("a claim's latest evidence in a line: what a person said and who, or what a check saw; the worst status first", () => {
    assert.equal(evidenceLine({ content: "too long", mode: "asserted", by: "evan" }), "evan said: “too long”");
    assert.equal(evidenceLine({ content: "too long", mode: "asserted", by: "person" }), "A person said: “too long”");
    assert.equal(evidenceLine({ content: "three lines", mode: "observed" }), "Checked: three lines");
    assert.equal(evidenceLine({ content: "  ", mode: "observed" }), null);
    assert.equal(evidenceLine(undefined), null);
    assert.deepEqual([claim("a", "supported"), claim("b", "unknown"), claim("c", "refuted"), claim("d", "stale")].sort(byStatus).map((c) => c.id), ["c", "d", "b", "a"]);
  });

  it("why the claims are not shown, in one line, from the step's refusal", () => {
    assert.equal(
      claimsUnavailable('knowledge/page: this caller may not read "private", where the Concept tree is kept (an app\'s page reads only what an app may)'),
      "Claims aren't shown here: this page may not read where the tree is kept.",
    );
    assert.equal(claimsUnavailable("knowledge/page needs the claims layer (ctx.services.knowledge): a graph-backed workspace with claims on"), "This server keeps no claims.");
    assert.equal(claimsUnavailable("boom"), "Couldn't read the claims: boom");
  });

  it("the Concept a change is to: an edit, move or delete its node; a new page under another the parent; anything else none", () => {
    assert.equal(conceptOfChange(change("e", "graph/edit-node", { ref_id: "a", node_data: { docs: "x" } })), "a");
    assert.equal(conceptOfChange(change("m", "graph/move-node", { ref_id: "a", to_ref_id: "b" })), "a");
    assert.equal(conceptOfChange(change("d", "graph/delete-node", { ref_id: "a" })), "a");
    const triplet = { source_ref_id: "p", edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "New" } };
    assert.equal(conceptOfChange(change("t", "graph/create-triplet", triplet)), "p");
    assert.equal(conceptOfChange(change("t", "graph/create-triplet", { ...triplet, edge_type: "RELATES_TO" })), null);
    assert.equal(conceptOfChange(change("t", "graph/create-triplet", { ...triplet, target_type: "Person" })), null);
    assert.equal(conceptOfChange(change("x", "graph/create-node", { node_type: "Concept", node_data: { name: "x" } })), null);
    assert.equal(conceptOfChange(change("x", "graph/edit-node", {})), null);
  });

  it("the changes by Concept, oldest first, only what still waits and only Concepts in the tree; what waits across the tree, changes first", () => {
    const tree = buildTree([c("a", "Alpha"), c("b", "Beta"), c("z", "Zeta")], [edge("a", "b")]);
    const list = [
      change("late", "graph/edit-node", { ref_id: "a" }, "2026-11-11T12:00:00Z"),
      change("early", "graph/edit-node", { ref_id: "a" }, "2026-11-11T09:00:00Z"),
      change("again", "graph/edit-node", { ref_id: "b" }, "2026-11-11T09:30:00Z", "failed"),
      change("done", "graph/edit-node", { ref_id: "b" }, "2026-11-11T09:00:00Z", "applied"),
      change("gone", "graph/edit-node", { ref_id: "elsewhere" }),
    ];
    const by = changesByConcept(list, tree);
    assert.deepEqual([...by].map(([id, l]) => [id, l.map((p) => p.id)]), [["a", ["early", "late"]], ["b", ["again"]]]);
    assert.deepEqual([...changesByConcept(list).keys()].sort(), ["a", "b", "elsewhere"], "no tree: every Concept named");

    const claimed = [
      { concept: "Zeta", ref_id: "z", claims: [claim("1", "refuted"), claim("2", "refuted"), claim("3", "supported")] },
      { concept: "Beta", ref_id: "b", claims: [claim("4", "refuted")] },
      { concept: "Gone", ref_id: "elsewhere", claims: [claim("5", "refuted")] },
      { concept: "Alpha", ref_id: "a", claims: [claim("6", "stale")] },
    ];
    const waiting = waitingAcross(tree, by, claimed);
    assert.deepEqual(waiting.map((w) => [w.name, w.changes, w.refuted]), [["Alpha", 2, 0], ["Beta", 1, 1], ["Zeta", 0, 2]]);
    assert.deepEqual(waiting.map(waitingWords), ["2 changes", "1 change · 1 refuted", "2 refuted"]);
    assert.deepEqual(waitingAcross(tree, new Map(), []), []);
  });
});

describe("strut/knowledge: what the dream learned, cycle by cycle", () => {
  const lesson = (concept: string, change?: string) => ({ session: "c-1", turn: 1, said: "too long", concept, claim: "Summaries are short", ...(change ? { change } : {}) });
  const cycle = (run: string, over: Partial<DreamCycle> = {}): DreamCycle => ({
    run, status: "success", startedAt: "2026-11-13T04:00:00Z", finishedAt: "2026-11-13T04:01:00Z", tree: "Personal", review: false, turns: 3, lessons: [], stuck: [], ...over,
  });

  it("the cycles about one Concept: a lesson's claim is on it, or its run changed the page; newest first as read", () => {
    const list = [cycle("3", { lessons: [lesson("Personal", "a Summaries page")] }), cycle("2"), cycle("1", { lessons: [lesson("Writing")] })];
    assert.deepEqual(cyclesFor(list, "Personal").map((c) => c.run), ["3"]);
    // The page the change made names no lesson, but its history carries the run that made it.
    const changed = runsOf([{ runs: ["3"] }, { runs: [] }, { runs: ["2", "9"] }]);
    assert.deepEqual([...changed].sort(), ["2", "3", "9"]);
    assert.deepEqual(cyclesFor(list, "Summaries", changed).map((c) => c.run), ["3", "2"]);
    assert.deepEqual(cyclesFor(list, "Nowhere"), []);
  });

  it("what a cycle changed, as two moments: from the commit before its first to its last; none when no commit carries its run", () => {
    const commits = [{ id: "c3", time: "2026-11-13T04:00:09Z" }, { id: "c2", time: "2026-11-13T04:00:03Z" }];
    assert.deepEqual(cycleSpan(commits, { id: "c1" }), { from: "c1", to: "c3" });
    assert.deepEqual(cycleSpan(commits, null), { from: "2026-11-13T04:00:02.000Z", to: "c3" }, "the history's first: a second before");
    assert.equal(cycleSpan([], { id: "c1" }), null);
  });

  it("a cycle in a line; why the cycles are not shown, from the step's refusal (nothing for a member)", () => {
    assert.equal(cycleWords(cycle("1", { lessons: [lesson("A"), lesson("B")], turns: 14 })), "2 lessons · 14 turns read");
    assert.equal(cycleWords(cycle("1", { turns: 1, more: true })), "nothing learned · 1 turn read, more waiting");
    assert.equal(cycleWords(cycle("1", { status: "error", turns: 0 })), "it did not finish");
    assert.equal(cyclesUnavailable("knowledge/cycles is an admin's: only strut's own page, shown to an admin of this server, reads what the dream learned"), null);
    assert.equal(
      cyclesUnavailable('knowledge/cycles: this caller may not read "private", where the Concept tree is kept'),
      "What the dream learned isn't shown here: this page may not read where the tree is kept.",
    );
    assert.equal(cyclesUnavailable("knowledge/cycles needs the claims layer (ctx.services.knowledge)"), "This server keeps no claims, so there is no dream.");
    assert.equal(cyclesUnavailable("boom"), "Couldn't read what the dream learned: boom");
  });

  it("each Concept's parents by name, for the diff to climb to its root", () => {
    const tree = buildTree([c("a", "Alpha"), c("b", "Beta"), c("x", "Hive"), c("z", "Zeta")], [edge("a", "b"), edge("x", "b")]);
    const of = parentsByName(tree);
    assert.deepEqual([of("Beta"), of("Alpha"), of("Nope")], [["Hive", "Alpha"].sort((p, q) => p.localeCompare(q)), [], undefined]);
    assert.equal(parentsByName(undefined)("Beta"), undefined);
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
    assert.deepEqual(app.manifest.grants.steps, [
      "graph/find", "graph/get-ontology", "graph/graph-edges", "graph/graph-get-batched", "graph/graph-neighbors", "graph/graph-search", "history/read",
      // The learning loop: a Concept's claims, what the dream learned (an admin's), and its changes a person decides here.
      "knowledge/page", "knowledge/claims", "knowledge/cycles", "proposal/list", "proposal/get", "proposal/decide",
    ]);
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
  /** The page's `step_run` as `actor`; `admin` when the door holds full scope (an admin's session, the key). */
  const page = (actor = "alice", admin = false) => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor, admin, runStepDeps: { store, workspace: strut.workspace } });
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
    // Only the commits carrying a run: a run that changed nothing here has none.
    assert.deepEqual((await readLog(client, { path: "concepts", run: "1700000000000" })).commits, []);
    const d = foldConceptDiff((await readDiff(client, { from: first.id, to: "main" })).entries);
    assert.deepEqual(d.pages.map((p) => `${p.name}:${p.status}`), ["Apps:edited"]);
    assert.deepEqual(d.pages[0]!.attributes, [{ name: "description", before: "About Apps", after: "The apps strut ships." }]);
    assert.deepEqual(d.pages[0]!.after!.parents, ["strut"]);
  });

  it("the dream's changes: an admin's page lists them, draws one over its page and decides it; a member's sees none; claims say why they are not shown", async () => {
    const [apps] = await b.reader.namesLike("Concept", "Apps", 1);
    const [cb] = await b.reader.namesLike("Concept", "Codebase", 1);
    const proposals = (strut.services as unknown as { proposals: { propose: (p: unknown) => Promise<{ id: string }> } }).proposals;
    // As the dream proposes them: a run no person launched, in no conversation.
    const by = { workflow: DREAM, runId: "1", path: "dream/tend" };
    const edit = await proposals.propose({ step: "graph/edit-node", input: { ref_id: apps!.ref_id, node_data: { docs: "Every app strut ships." } }, title: "Edit a node", rationale: "The person asked for it.", by });
    const add = await proposals.propose({
      step: "graph/create-triplet",
      input: { source_ref_id: cb!.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "Style", description: "How code reads." } },
      title: "Add a page",
      by,
    });
    // Another workflow's, made in a person's conversation: never listed here.
    await proposals.propose({ step: "graph/edit-node", input: { ref_id: apps!.ref_id, node_data: { docs: "x" } }, title: "Hers", by: { workflow: "orchestrator", runId: "2", path: "orchestrator/agent", actor: "alice", session: "alice/c1" } });

    const ada = page("ada", true);
    const listed = await ada("proposal/list", { workflow: DREAM, status: "pending", input: true });
    assert.equal(listed.error, undefined, listed.error);
    assert.deepEqual(listed.result.proposals.map((p: any) => p.id).sort(), [edit.id, add.id].sort());
    const tree = buildTree((await ada("graph/find", { node_type: "Concept", limit: 50 })).result.nodes.map(conceptOf), []);
    assert.deepEqual([...changesByConcept(listed.result.proposals, tree)].map(([id, l]) => [tree.nodes[id]!.name, l.map((p) => p.title)]).sort(), [["Apps", ["Edit a node"]], ["Codebase", ["Add a page"]]]);
    // A member sees none of them, and may not decide one; a model-written page is never shown them either.
    const mo = page("mo");
    assert.deepEqual((await mo("proposal/list", { workflow: DREAM, status: "pending" })).result.proposals, []);
    assert.match((await mo("proposal/decide", { id: edit.id, action: "accept" })).error!, /not yours to decide/);

    // What the card draws: the change over the page as it is now, through the app's own grants.
    const client = { run: async (type: string, config: Record<string, unknown> = {}) => {
      const r = await ada(type, config);
      if (r.error) throw new Error(r.error);
      return r.result;
    } } as never;
    const added = await readProposalEntry(client, add.id);
    assert.deepEqual(added.entry, { path: "concepts/concept-style.md", after: { name: "Style", attributes: { description: "How code reads." }, parents: ["Codebase"] } });

    // The admin decides: rejected, nothing runs; accepted, the page changes.
    assert.equal((await ada("proposal/decide", { id: add.id, action: "reject" })).result.status, "rejected");
    const accepted = await ada("proposal/decide", { id: edit.id, action: "accept" });
    assert.equal(accepted.result.status, "applied", accepted.error ?? JSON.stringify(accepted.result));
    assert.equal(accepted.result.decision.by, "ada");
    assert.equal((await b.reader.getNode(apps!.ref_id))!.properties["docs"], "Every app strut ships.");
    assert.deepEqual((await ada("proposal/list", { workflow: DREAM, status: "pending" })).result.proposals, []);

    // No claims layer on this server: the card says so in one line.
    const claims = await ada("knowledge/page", { name: "Apps" });
    assert.equal(claimsUnavailable(claims.error!), "This server keeps no claims.");

    // What the dream learned: granted, and an admin's alone (its lessons quote what people said); a member's page
    // is refused before anything is read, and sees no button. With no claims layer there is no dream to read.
    assert.equal(cyclesUnavailable((await mo(CYCLES_STEP, {})).error!), null);
    assert.equal(cyclesUnavailable((await ada(CYCLES_STEP, {})).error!), "This server keeps no claims, so there is no dream.");
  });
});
