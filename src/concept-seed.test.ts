import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { parseConceptFile, planConceptSeed, seedConcepts, stampOf, STRUT_CONCEPTS, type ConceptSet } from "./concept-seed.js";
import { builderSystem, renderBuilderSystem } from "./ai/builder-system.js";
import conceptStep, { renderConceptSection } from "./steps/lib/context/concept.js";
import { accessedNodesOf, defineStep } from "./core.js";
import { runSingleStep } from "./run-step.js";
import { z } from "zod";
import { createRegistry } from "./steps/registry.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { MemoryChatStore } from "./chat-store.js";
import type { GraphBackend } from "./graph/backend.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import { seedConceptSchema, testBackends } from "./graph/test-util.js";

describe("concept files (pure)", () => {
  it("parses front matter into description + parent, the body into docs, and stamps the file", () => {
    const text = "---\ndescription: What it is.\nparent: Root\n---\nThe page.\n";
    assert.deepEqual(parseConceptFile("Child.md", text, "p/"), {
      name: "Child",
      description: "What it is.",
      parent: "Root",
      docs: "The page.",
      stamp: stampOf("Child.md", text, "p/"),
    });
    assert.match(stampOf("Child.md", text, "p/"), /^p\/Child\.md@[0-9a-f]{12}$/);
    assert.deepEqual(parseConceptFile("Bare.md", "just docs", "p/"), { name: "Bare", docs: "just docs", stamp: stampOf("Bare.md", "just docs", "p/") });
  });

  it("plans create / keep / update / skip by the stamp, a legacy path counting as ours", () => {
    const stamp = "strut/concepts/Job.md@aaaaaaaaaaaa";
    const legacy = ["lab/job/concepts/Job.md@"];
    assert.equal(planConceptSeed(null, stamp), "create");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: stamp }, stamp), "keep");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "strut/concepts/Job.md@bbbbbbbbbbbb" }, stamp), "update");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: stamp, deleted: true }, stamp), "update", "a deleted page of ours comes back");
    assert.equal(planConceptSeed({ ref_id: "r" }, stamp), "skip", "no stamp: a person's page");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "other/Job.md@aaaaaaaaaaaa" }, stamp), "skip");
    assert.equal(planConceptSeed({ ref_id: "r", deleted: true }, stamp), "skip", "a person's deleted page stays deleted");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "lab/job/concepts/Job.md@aaaaaaaaaaaa" }, stamp), "skip", "a legacy path counts only when the set names it");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "lab/job/concepts/Job.md@aaaaaaaaaaaa" }, stamp, legacy), "keep", "same text: kept, stamp and all");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "lab/job/concepts/Job.md@cccccccccccc" }, stamp, legacy), "update");

    // A seed always matches git: the same stamp over text edited in the
    // graph is put back; a field the file does not set is not the seed's.
    const file = { description: "The job.", docs: "How a job works." };
    const node = { ref_id: "r", unique_source_id: stamp, description: "The job.", docs: "How a job works." };
    assert.equal(planConceptSeed(node, stamp, [], file), "keep", "the file's text: nothing to write");
    assert.equal(planConceptSeed({ ...node, docs: "Edited in the graph." }, stamp, [], file), "update", "edited docs are put back");
    assert.equal(planConceptSeed({ ...node, description: "Edited." }, stamp, [], file), "update", "an edited description is put back");
    assert.equal(planConceptSeed({ ...node, description: "Added in the graph." }, stamp, [], { docs: file.docs }), "keep", "a field the file does not set is left as it is");
    assert.equal(planConceptSeed({ ref_id: "r", docs: "A person wrote this." }, stamp, [], file), "skip", "a person's page stays theirs");
  });

  it("ships Workflow Builder and Job as roots, Workflow Build and Job App under Job: workspace-general, the legacy lab stamps named; and App, a kind under Workflow Builder", async () => {
    const read = async (file: string) => parseConceptFile(file, await readFile(join(STRUT_CONCEPTS.dir, file), "utf-8"), STRUT_CONCEPTS.prefix);
    const wb = await read("Workflow Builder.md");
    const job = await read("Job.md");
    const build = await read("Workflow Build.md");
    for (const c of [wb, job]) {
      assert.equal(c.parent, undefined, `${c.name} is a root`);
      assert.ok(c.description && c.docs?.includes("PARENT_OF"), c.name);
    }
    // The kind a workflow build is (plans/builder-job.md §2): under Job, so
    // the orchestrator's kinds list carries it like every other kind. Its
    // one line names the door; its docs tell a job agent it is not theirs.
    assert.equal(build.parent, "Job");
    assert.match(build.description!, /workflow: builder/);
    assert.ok(build.docs!.includes("job/start { workflow: builder }") && build.docs!.includes("Workflow Builder"), build.docs);
    for (const c of [wb, job, build]) assert.doesNotMatch(c.docs!, /hive|@<slug>|\bpod\b|pull request/i, `${c.name} names nothing one deployment has`);
    // The App page (plans/apps.md §8): the builder's prompt for an app, one
    // of the kinds under Workflow Builder — the layout, the kit's hooks,
    // the grants, routines, the four shapes.
    const app = await read("App.md");
    assert.equal(app.parent, "Workflow Builder");
    for (const must of ["app.yaml", "grants", "useLaunch", "useRun", "never on a render", "llm", "@/components/ui", "strut/views", "app/build", "app/publish"]) assert.ok(app.docs!.includes(must), must);
    assert.doesNotMatch(app.docs!, /hive|@<slug>|\bpod\b/i, "names nothing one deployment has");
    // The job side of an app (plans/apps.md §6, §8): a kind under Job, so
    // every job turn sees its one line in the kinds list; its page is the
    // job's contract and sends the agent to App for the how-to.
    const jobApp = await read("Job App.md");
    assert.equal(jobApp.parent, "Job");
    assert.match(jobApp.description!, /interactive app/);
    assert.ok(!jobApp.description!.includes("\n"), "one line");
    for (const must of ["apps/<name>/", "app/init", "app/build", "BEFORE you hand it over", 'kind: "app"', "run/list { job }", "run/files { job, path }", "useApp()", "Publish as an app", "open the `App` page"]) assert.ok(jobApp.docs!.includes(must), must);
    assert.doesNotMatch(jobApp.docs!, /hive|@<slug>|\bpod\b/i, "names nothing one deployment has");
    assert.ok(!app.docs!.includes("## A job's app"), "App stays the builders' manual");
    assert.deepEqual(STRUT_CONCEPTS.legacyPrefixes, ["lab/builder/concepts/", "lab/job/concepts/"]);
  });

  it("renders the builder's section: the page, its kinds, and how to open one", () => {
    const text = renderBuilderSystem({ name: "Workflow Builder", docs: "The notes.", children: [{ name: "Janitor", description: "Cleans up." }], more: true });
    assert.match(text, /^Workspace knowledge — the "Workflow Builder" Concept/);
    assert.ok(text.includes("The notes.") && text.includes("- Janitor — Cleans up.") && text.includes("… and more"));
    assert.ok(text.includes('graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'));
    assert.ok(!renderBuilderSystem({ name: "Workflow Builder", children: [] }).includes("Kinds recorded"));
    assert.ok(renderBuilderSystem({ name: "W", docs: "x".repeat(7000), children: [] }).includes(`${"x".repeat(6000)}…`), "docs are capped");
    const job = renderConceptSection({ name: "Job", children: [{ name: "Explore" }] }, "graph_graph_get");
    assert.ok(job.includes('graph_graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "the tool the agent calls");
    assert.ok(job.includes("- Explore\n"));
  });

  it("renders the kinds alone (docs: false) for an agent that routes by them, with no opener when it has no tool, and nothing when there are no kinds", () => {
    const page = { name: "Job", docs: "The job agent's instructions.", children: [{ name: "Explore", description: "Finding out." }] };
    const kinds = renderConceptSection(page, "", { docs: false });
    assert.match(kinds, /^Workspace knowledge — the "Job" Concept/);
    assert.ok(kinds.includes("- Explore — Finding out."));
    assert.ok(!kinds.includes("The job agent's instructions.") && !kinds.includes("(no docs)"), "the page's docs are not for this reader");
    assert.ok(!kinds.includes("OPEN ITS PAGE") && !kinds.includes("node_type"), "no way to open a page is named");
    const opener = renderConceptSection(page, "graph_graph_get", { docs: false });
    assert.ok(opener.includes('A kind\'s page — graph_graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "with a tool, how to open one — never 'follow its convention'");
    assert.ok(!opener.includes("OPEN ITS PAGE FIRST"));
    assert.equal(renderConceptSection({ name: "Job", docs: "x", children: [] }, "", { docs: false }), "", "no kinds, nothing to route by");
    assert.ok(!renderConceptSection(page, "", { docs: true }).includes("OPEN ITS PAGE"), "with docs and no tool, the docs and the kinds, no opener");
  });
});

for (const tb of testBackends()) {
  describe(`seedConcepts (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    let dir: string;
    const set = (extra: Partial<ConceptSet> = {}): ConceptSet => ({ dir, prefix: "test/concepts/", ...extra });
    const page = (name: string, body: string, front: Record<string, string> = {}) => {
      const fm = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
      return writeFile(join(dir, `${name}.md`), `${fm.length ? `---\n${fm.join("\n")}\n---\n` : ""}${body}\n`);
    };
    const props = async (ref_id: string) => (await b.tx((tx) => b.nodeEngine.readRaw(tx, ref_id)))!.props;
    const children = async (ref_id: string) => {
      const out = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, ref_id, "PARENT_OF", true));
      return (out?.edges ?? []).map((e) => e.other).sort();
    };
    const concept = async (name: string, data: Record<string, unknown> = {}) => (await b.nodes.write({ type: "Concept", data: { name, ...data } })).ref_id;
    const byName = (outcomes: Awaited<ReturnType<typeof seedConcepts>>) => Object.fromEntries(outcomes.map((o) => [o.name, o]));

    before(async () => {
      b = await tb.open();
    });
    after(async () => {
      await tb.close(b);
    });
    beforeEach(async () => {
      await tb.wipe(b);
      if (b.kind === "neo4j") await seedStrutDomain(b);
      await seedConceptSchema(b);
      dir = await mkdtemp(join(tmpdir(), "strut-concepts-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("creates the pages and their tree, then keeps them; every boot puts a graph-side edit back to the file's text", async () => {
      await page("Root", "The root page.", { description: "The root." });
      await page("Child", "A kind.", { description: "One kind.", parent: "Root" });
      const first = byName(await seedConcepts(b, [set()]));
      assert.equal(first["Root"]!.action, "create");
      assert.equal(first["Child"]!.action, "create");
      const root = first["Root"]!.ref_id!;
      const child = first["Child"]!.ref_id!;
      assert.deepEqual(await children(root), [child]);
      const p = await props(root);
      assert.equal(p["docs"], "The root page.");
      assert.equal(p["description"], "The root.");
      assert.match(String(p["unique_source_id"]), /^test\/concepts\/Root\.md@[0-9a-f]{12}$/);

      const again = byName(await seedConcepts(b, [set()]));
      assert.deepEqual([again["Root"]!.action, again["Child"]!.action], ["keep", "keep"], "the file's text: nothing written");

      await b.nodes.update(root, { set: { docs: "Edited in the graph." } });
      const second = byName(await seedConcepts(b, [set()]));
      assert.deepEqual([second["Root"]!.action, second["Child"]!.action], ["update", "keep"]);
      assert.equal(second["Root"]!.ref_id, root, "same node");
      assert.equal((await props(root))["docs"], "The root page.", "a seed always matches git");
      assert.deepEqual(await children(root), [child], "the edge is merged, never duplicated");

      await page("Root", "The root page, revised.", { description: "The root." });
      const third = byName(await seedConcepts(b, [set()]));
      assert.equal(third["Root"]!.action, "update");
      assert.equal(third["Root"]!.ref_id, root, "same node");
      assert.equal((await props(root))["docs"], "The root page, revised.");
    });

    it("brings back a deleted page of its own, and leaves a person's page alone while parenting under it", async () => {
      await page("Root", "The root page.");
      const root = byName(await seedConcepts(b, [set()]))["Root"]!.ref_id!;
      assert.ok(await b.nodeEngine.softDelete(root, b.namespace, { type: "Concept" }));
      assert.ok((await props(root))["deleted_at"] != null);
      assert.equal(byName(await seedConcepts(b, [set()]))["Root"]!.action, "update");
      assert.equal((await props(root))["deleted_at"] ?? null, null, "restored in place");

      const theirs = await concept("Theirs", { docs: "A person wrote this." });
      await page("Theirs", "The file's version.");
      await page("Under", "Hangs under a person's page.", { parent: "Theirs" });
      const out = byName(await seedConcepts(b, [set()]));
      assert.equal(out["Theirs"]!.action, "skip");
      assert.equal((await props(theirs))["docs"], "A person wrote this.");
      assert.equal((await props(theirs))["unique_source_id"] ?? null, null);
      assert.deepEqual(await children(theirs), [out["Under"]!.ref_id]);
    });

    it("counts a legacy stamp as its own: the same text kept as it is, a changed one taken over", async () => {
      const text = "---\ndescription: Same.\n---\nSame text.\n";
      await writeFile(join(dir, "Same.md"), text);
      await page("Moved", "New text.");
      const same = await concept("Same", { description: "Same.", docs: "Same text.", unique_source_id: stampOf("Same.md", text, "old/") });
      const moved = await concept("Moved", { docs: "Old text.", unique_source_id: "old/Moved.md@000000000000" });
      const out = byName(await seedConcepts(b, [set({ legacyPrefixes: ["old/"] })]));
      assert.equal(out["Same"]!.action, "keep");
      assert.equal((await props(same))["unique_source_id"], stampOf("Same.md", text, "old/"), "nothing written");
      assert.equal(out["Moved"]!.action, "update");
      assert.equal(out["Moved"]!.ref_id, moved);
      assert.equal((await props(moved))["docs"], "New text.");
      assert.match(String((await props(moved))["unique_source_id"]), /^test\/concepts\/Moved\.md@/);
    });

    it("removes a PARENT_OF between its own pages that no file declares, and no other", async () => {
      await page("Root", "r");
      await page("Child", "c", { parent: "Root" });
      await page("Loose", "l");
      const out = byName(await seedConcepts(b, [set()]));
      const [root, child, loose] = [out["Root"]!.ref_id!, out["Child"]!.ref_id!, out["Loose"]!.ref_id!];
      const foreign = await concept("Foreign");
      await b.edges.write({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: loose });
      await b.edges.write({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: foreign });
      await seedConcepts(b, [set()]);
      assert.deepEqual(await children(root), [child, foreign].sort());
    });

    it("retires a file's page only while it still carries that file's stamp", async () => {
      await page("Old", "o");
      await page("Taken", "t");
      const out = byName(await seedConcepts(b, [set()]));
      await b.nodes.update(out["Taken"]!.ref_id!, { remove: ["unique_source_id"] });
      await rm(join(dir, "Old.md"));
      await rm(join(dir, "Taken.md"));
      await seedConcepts(b, [set({ retired: ["Old.md", "Taken.md"] })]);
      assert.ok((await props(out["Old"]!.ref_id!))["deleted_at"] != null);
      assert.equal((await props(out["Taken"]!.ref_id!))["deleted_at"] ?? null, null);
    });

    it("strut's pages seed, a host's page hangs under one, and the builder's section reads them", async () => {
      const strut = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      assert.deepEqual(
        [strut["Workflow Builder"]!.action, strut["Job"]!.action, strut["Workflow Build"]!.action, strut["App"]!.action, strut["Job App"]!.action],
        ["create", "create", "create", "create", "create"],
      );
      assert.deepEqual(await children(strut["Job"]!.ref_id!), [strut["Workflow Build"]!.ref_id!, strut["Job App"]!.ref_id!].sort(), "the kinds strut ships hang under Job");
      await page("Janitor", "How a janitor is built here.", { description: "Cleans something up.", parent: "Workflow Builder" });
      const host = byName(await seedConcepts(b, [set()]));
      const wb = strut["Workflow Builder"]!.ref_id!;
      // Under Workflow Builder: strut's own App page, and the host's Janitor.
      const under = [strut["App"]!.ref_id!, host["Janitor"]!.ref_id!].sort();
      assert.deepEqual(await children(wb), under);
      const again = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      assert.deepEqual([again["Workflow Builder"]!.action, again["Job"]!.action, again["App"]!.action], ["keep", "keep", "keep"]);
      assert.deepEqual(await children(wb), under, "a page another call owns is not strut's to unlink");

      const text = await builderSystem({ graph: b, registry: await createRegistry([]), services: { graph: b } });
      assert.ok(text?.startsWith('Workspace knowledge — the "Workflow Builder" Concept'), text);
      assert.ok(text!.includes("To record a new kind, add a child Concept here"));
      assert.ok(text!.includes("- Janitor — Cleans something up."));
      assert.ok(text!.includes("- App — An APP — a front-end project"), "strut's own kind is listed");
      assert.equal(await builderSystem({ registry: await createRegistry([]), services: {} }), undefined, "no graph, no section");
    });

    it("context/concept renders a page and the kinds under it for an agent's prompt, reports the page it read, and is empty without one", async () => {
      const strut = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      await page("Explore", "How to explore here.", { description: "Finding out how something works.", parent: "Job" });
      await seedConcepts(b, [set()]);
      const run = (config: Record<string, unknown>, services: Record<string, unknown> = { graph: b }) =>
        conceptStep.run(conceptStep.input.parse(config), { services } as never);

      const out = await run({ name: "Job" });
      assert.ok(out.text.startsWith('Workspace knowledge — the "Job" Concept'), out.text);
      assert.ok(out.text.includes("To record a new kind, add a child Concept here"), "the page's docs");
      assert.ok(out.text.includes("- Explore — Finding out how something works."), "its kinds");
      assert.ok(out.text.includes('graph_graph_get({ node_type: "Concept", name: "<name>"'), "opened with the agent's name for graph-get");
      assert.deepEqual(accessedNodesOf(out)?.map((n) => n.ref_id), [strut["Job"]!.ref_id], "the page it read, never its children");

      const kinds = await run({ name: "Job", docs: false, tool: "" });
      assert.ok(kinds.text.includes("- Explore — Finding out how something works.") && !kinds.text.includes("To record a new kind"), "docs: false — the kinds alone, the orchestrator's read");
      assert.ok(kinds.text.includes("- Workflow Build — Build, change, test or debug a WORKFLOW"), "the kind strut ships is in the orchestrator's list, beside the deployment's");
      assert.ok(out.text.includes("- Job App — Hand over an interactive app as a deliverable"), "the job agent's kinds list carries the job app's one line");
      assert.ok(!kinds.text.includes("graph_graph_get"), "no tool, no opener");
      assert.deepEqual(await run({ name: "App", docs: false }), { text: "" }, "no kinds under it, nothing");
      assert.deepEqual(await run({ name: "Nope" }), { text: "" }, "no such page");
      assert.deepEqual(await run({ name: "Job" }, {}), { text: "" }, "no graph");
      const viaRegistry = await runSingleStep("context/concept", await createRegistry([]), { graph: b }, { config: { name: "Job", tool: "graph_get" } });
      assert.ok((viaRegistry.output as { text: string }).text.includes('graph_get({ node_type: "Concept"'), "discovered as a lib step");
    });
  });
}

// createStrut on a graph: the pages at boot, the builder's prompt from them.
const ladybug = testBackends().find((t) => t.kind === "ladybug")!;
describe("createStrut with a graph", { skip: ladybug.skip }, () => {
  let b: GraphBackend;
  let workspaceDir: string;
  const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
  let saved: Record<string, string | undefined> = {};
  before(async () => {
    b = await ladybug.open();
  });
  after(async () => {
    await ladybug.close(b);
  });
  beforeEach(async () => {
    await ladybug.wipe(b);
    workspaceDir = await mkdtemp(join(tmpdir(), "strut-concepts-ws-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  });
  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  let chats = new MemoryChatStore();
  const make = (extra: Partial<Parameters<typeof createStrut>[0]> = {}) => {
    chats = new MemoryChatStore();
    return createStrut({ workspace: new WorkspaceManager(workspaceDir), graph: b, store: new MemoryRunStore(), chatStore: chats, serveUi: false, scheduler: false, ...extra });
  };
  // Both names have an "o"; namesLike answers nothing for an empty query.
  const names = async () => (await b.reader.namesLike("Concept", "o", 10)).map((n) => n.name).sort();

  it("seeds Workflow Builder and Job at boot; concepts: false seeds nothing", async () => {
    await make({ concepts: false });
    assert.deepEqual(await names(), []);
    await make();
    assert.deepEqual(await names(), ["Job", "Job App", "Workflow Build", "Workflow Builder"]);
    // Job App hangs under Job: the job agent's kinds list carries it.
    const hits = await b.reader.namesLike("Concept", "Job", 10);
    const ref = (n: string) => hits.find((h) => h.name === n)!.ref_id;
    const under = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, ref("Job"), "PARENT_OF", true));
    assert.ok((under?.edges ?? []).some((e) => e.other === ref("Job App")), "Job App under Job after boot");
  });

  it("puts the Job page at the end of the job agent's system prompt", async () => {
    const systems: string[] = [];
    // Stands in for the core `agent` step: records the system prompt it was handed.
    const fakeAgent = defineStep({
      type: "agent",
      input: z.object({ system: z.string() }).passthrough(),
      output: z.any(),
      async run(cfg) {
        systems.push(cfg.system);
        return { result: "ok", object: { text: "ok", artifacts: [] }, steps: 1, usage: {}, cost: 0 };
      },
    });
    const strut = await make({ registry: await createRegistry([fakeAgent]) });
    const res = await strut.run("job", { prompt: "How does billing work?" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    const [system] = systems;
    assert.ok(system!.startsWith("You are working on a JOB with a person"), "strut's prompt leads");
    const at = system!.indexOf('Workspace knowledge — the "Job" Concept');
    assert.ok(at > 0 && system!.slice(0, at).endsWith("verifies again.\n\n"), "the page follows the prompt after a blank line");
    assert.ok(!system!.includes("open the `Job` Concept: graph/graph-get"), "no tool call to make for the list");
  });

  it("puts the Workflow Builder page in a chat's system prompt unless the host passes its own", async () => {
    const bodies: Array<{ system: unknown }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const systemOf = (body: { system: unknown }): string =>
      typeof body.system === "string" ? body.system : (body.system as Array<{ text: string }>).map((s) => s.text).join("");
    const turn = async (strut: Awaited<ReturnType<typeof make>>) => {
      const res = await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
      const { chatId } = (await res.json()) as { chatId: string };
      for (let i = 0; i < 200 && (await chats.getMeta(chatId))?.status === "live"; i++) await new Promise((r) => setTimeout(r, 25));
    };
    try {
      await turn(await make());
      assert.ok(systemOf(bodies[0]!).includes('Workspace knowledge — the "Workflow Builder" Concept'));
      await turn(await make({ chatSystem: () => "HOST-SECTION" }));
      assert.ok(systemOf(bodies[1]!).includes("HOST-SECTION"));
      assert.ok(!systemOf(bodies[1]!).includes("Workspace knowledge"), "the host's hook replaces the default");
    } finally {
      server.close();
    }
  });
});
