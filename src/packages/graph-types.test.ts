/**
 * A package's GRAPH TYPES (`graph/<Type>.yaml`, ./graph-types.ts): the
 * format, then on every graph backend the build — named types read off the
 * ontology with their parents and the edges the graph holds — and the
 * install on a graph that has never seen them.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { createNodeSchema } from "../graph/schema-crud.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { loadYaml } from "../yaml.js";
import { buildPackage, type BuildRequest, type BuildResult } from "./build.js";
import { packageCache } from "./cache.js";
import { readPackage } from "./format.js";
import { parseTypeFile, typeFileText } from "./graph-types.js";
import type { InstallResult } from "./install.js";

describe("graph types in a package: the format", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-graph-format-"));
    await writeFile(join(dir, "strut.yaml"), "package: acme/legal\nversion: 1.0.0\n");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reads graph/<Type>.yaml as a type named by its file, and refuses a folder or a bad name", async () => {
    await mkdir(join(dir, "graph"));
    await writeFile(join(dir, "graph", "LegalParty.yaml"), "attributes: { role: ?string }\n");
    const info = await readPackage(dir);
    assert.deepEqual(info.items, [{ kind: "type", name: "LegalParty", path: "graph/LegalParty.yaml" }]);

    await mkdir(join(dir, "graph", "more"));
    await writeFile(join(dir, "graph", "more", "X.yaml"), "attributes: {}\n");
    await writeFile(join(dir, "graph", "9lives.yaml"), "attributes: {}\n");
    await assert.rejects(readPackage(dir), (e: Error) => /graph\/more\/X\.yaml: a graph type is graph\/<Type>\.yaml/.test(e.message) && /graph\/9lives\.yaml/.test(e.message));
  });

  it("parses the create-schema grammar with edges, refuses what is not, and writes it back the same", () => {
    const t = parseTypeFile("LegalParty", "graph/LegalParty.yaml", "parent: Legal\nattributes: { role: ?string, name: string }\nedges:\n  - [PARTY_TO, Agreement]\n  - [MENTIONS, '*']\n");
    assert.deepEqual(t.input, { type: "LegalParty", parent: "Legal", attributes: { role: "?string", name: "string" } });
    assert.deepEqual(t.edges, [["PARTY_TO", "Agreement"], ["MENTIONS", "*"]]);
    const text = typeFileText(t);
    assert.equal(text, "parent: Legal\nattributes:\n  name: string\n  role: '?string'\nedges:\n  - - MENTIONS\n    - '*'\n  - - PARTY_TO\n    - Agreement\n");
    assert.deepEqual(parseTypeFile("LegalParty", "f", text).input, t.input);

    assert.throws(() => parseTypeFile("X", "graph/X.yaml", "attributes: { n: number }\n"), /graph\/X\.yaml: attributes\.n: an attribute type is/);
    assert.throws(() => parseTypeFile("X", "graph/X.yaml", "edges: [[party_to, Y]]\n"), /an edge type is UPPER_SNAKE/);
    assert.throws(() => parseTypeFile("X", "graph/X.yaml", "colour: red\n"), /Unrecognized key/);
  });
});

const boot = (workspace: GraphWorkspaceStore, dataDir: string) =>
  createStrut({
    workspace,
    dataDir,
    store: new MemoryRunStore(),
    serveUi: false,
    scheduler: false,
    enableChat: false,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false,
    job: false,
    orchestrator: false,
    builder: false,
    views: false,
    concepts: false,
    stt: false,
  });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

for (const tb of testBackends()) {
  describe(`graph types in a package (${tb.name})`, { skip: tb.skip }, () => {
    let source: GraphBackend;
    let scratch: string;
    const struts: Strut[] = [];
    const opened: GraphBackend[] = [];

    /** A graph that has never seen the package's types: a new file on
     *  Ladybug, the one database wiped and re-seeded on Neo4j. */
    const freshGraph = async (): Promise<GraphBackend> => {
      if (tb.kind === "ladybug") {
        const b = await tb.open();
        opened.push(b);
        return b;
      }
      await tb.wipe(source);
      await seedStrutDomain(source);
      source.schemas.invalidate();
      return source;
    };
    const strutOn = async (graph: GraphBackend, name: string) => {
      const dir = join(scratch, name);
      const s = await boot(new GraphWorkspaceStore(graph, { materializeDir: join(dir, "steps"), appsDir: join(dir, "apps") }), dir);
      struts.push(s);
      return s;
    };
    const build = (s: Strut, graph: GraphBackend, req: Partial<BuildRequest>): Promise<BuildResult> =>
      buildPackage(
        { workspace: s.workspace, cache: packageCache(s.dataDir), graph, getRegistry: async () => s.getRegistry() },
        { package: "acme/legal", version: "1.0.0", ...req },
      );
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return (e as Error).message;
      }
      assert.fail("not refused");
    };
    const install = async (s: Strut, ref: string) => {
      const res = await s.app.request("/packages/install", json({ ref }));
      return { status: res.status, body: (await res.json()) as InstallResult & { error?: string } };
    };

    before(async () => {
      source = await tb.open();
      await tb.wipe(source);
      await seedStrutDomain(source);
      source.schemas.invalidate();
    });
    after(async () => {
      for (const b of opened.splice(0)) await tb.close(b);
      await tb.close(source);
    });
    beforeEach(async () => {
      scratch = await mkdtemp(join(tmpdir(), "strut-graph-types-"));
    });
    afterEach(async () => {
      for (const s of struts.splice(0)) await s.close?.();
      await rm(scratch, { recursive: true, force: true });
    });

    it("builds the named types with their parents and the edges the graph holds, the same bytes twice, and installs them on a graph without them", async () => {
      // The source's ontology: a domain anchor, two types under it, one beside.
      await createNodeSchema(source, source.schemas, { type: "Legal", attributes: {}, domain: "Legal", type_description: "The legal domain" });
      await createNodeSchema(source, source.schemas, { type: "LegalParty", parent: "Legal", attributes: { capacity: "?string", description: "?string" }, domain: "Legal" });
      await createNodeSchema(source, source.schemas, { type: "Agreement", parent: "Legal", attributes: { effective: "?string", ref: "string" }, key_spec: "ref", domain: "Legal" });
      await createNodeSchema(source, source.schemas, { type: "Advocate", attributes: {} });
      // An edge rule of its own, and edges the graph holds under a wildcard
      // rule — as a Jarvis graph holds its allowlisted edges, with no rule
      // between the two types.
      await source.schemas.createEdgeSchema("Agreement", "AMENDS", "Agreement");
      await source.schemas.createEdgeSchema("*", "PARTY_TO", "*");
      await source.schemas.createEdgeSchema("*", "REPRESENTED_BY", "*");
      const party = (await source.nodes.write({ type: "LegalParty", data: { name: "Acme" } }, "create")).ref_id;
      const deal = (await source.nodes.write({ type: "Agreement", data: { name: "MSA", ref: "msa-1" } }, "create")).ref_id;
      const lawyer = (await source.nodes.write({ type: "Advocate", data: { name: "Kim" } }, "create")).ref_id;
      await source.edges.write({ edge: "PARTY_TO", source_ref_id: party, target_ref_id: deal });
      await source.edges.write({ edge: "REPRESENTED_BY", source_ref_id: party, target_ref_id: lawyer });

      const src = await strutOn(source, "source");
      const built = await build(src, source, { types: ["LegalParty", "agreement"] });
      assert.deepEqual(built.files, ["graph/Agreement.yaml", "graph/Legal.yaml", "graph/LegalParty.yaml", "strut.yaml"]);
      // `description` is read as a Schema setting; its value says it is an
      // attribute. Where Thing declares it, LegalParty inherits it.
      const thingHas = "description" in ((await source.schemas.schema("Thing"))?.attributes ?? {});
      assert.deepEqual(loadYaml(await readFile(join(built.dir, "graph/LegalParty.yaml"), "utf-8")), {
        parent: "Legal",
        domain: "Legal",
        attributes: { capacity: "?string", ...(thingHas ? {} : { description: "?string" }) },
        edges: [["PARTY_TO", "Agreement"]],
      });
      assert.deepEqual(loadYaml(await readFile(join(built.dir, "graph/Agreement.yaml"), "utf-8")), {
        parent: "Legal",
        domain: "Legal",
        attributes: { effective: "?string", ref: "string" },
        key_spec: "ref",
        edges: [["AMENDS", "Agreement"]],
      });
      assert.deepEqual(loadYaml(await readFile(join(built.dir, "graph/Legal.yaml"), "utf-8")), { domain: "Legal", type_description: "The legal domain", attributes: {} });
      assert.match(built.warnings.join("\n"), /the graph holds LegalParty -\[REPRESENTED_BY\]-> Advocate, and Advocate is not in the package/);
      assert.equal((await build(src, source, { types: ["Agreement", "LegalParty"] })).digest, built.digest);

      // What no package carries, and what the graph does not hold.
      assert.match(await refusal(build(src, source, { types: ["Nope"] })), /no graph type Nope in this graph's ontology/);
      assert.match(await refusal(build(src, source, { types: ["Concept"] })), /the graph type Concept is the workspace's notes/);

      // A graph that has never seen them: the install registers them, parents first, and the edge writes.
      const buyerGraph = await freshGraph();
      assert.equal(await buyerGraph.schemas.resolveType("LegalParty"), null);
      const buyer = await strutOn(buyerGraph, "buyer");
      const r = await install(buyer, `file:${built.dir}`);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(
        r.body.packages[0]!.items.map((i) => [i.kind, i.name, i.status]),
        [["type", "Agreement", "installed"], ["type", "Legal", "installed"], ["type", "LegalParty", "installed"]],
      );
      assert.equal((await buyerGraph.schemas.schema("LegalParty"))?.parent, "Legal");
      const p = (await buyerGraph.nodes.write({ type: "LegalParty", data: { name: "Acme" } }, "create")).ref_id;
      const a = (await buyerGraph.nodes.write({ type: "Agreement", data: { name: "MSA", ref: "msa-1" } }, "create")).ref_id;
      await buyerGraph.edges.write({ edge: "PARTY_TO", source_ref_id: p, target_ref_id: a });
      await assert.rejects(buyerGraph.edges.write({ edge: "AMENDS", source_ref_id: p, target_ref_id: a }));

      // Again: as it is.
      const again = await install(buyer, `file:${built.dir}`);
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.deepEqual(again.body.packages[0]!.items.map((i) => i.status), ["present", "present", "present"]);
    });

    it("refuses a type the graph holds with another key, before anything is written", async () => {
      const graph = await freshGraph();
      await createNodeSchema(graph, graph.schemas, { type: "Agreement", attributes: { ref: "string" }, key_spec: "ref" });
      const dir = join(scratch, "pkg");
      await mkdir(join(dir, "graph"), { recursive: true });
      await writeFile(join(dir, "strut.yaml"), "package: acme/legal\nversion: 1.0.0\n");
      await writeFile(join(dir, "graph", "Agreement.yaml"), "attributes: { ref: string }\n");
      await writeFile(join(dir, "graph", "Clause.yaml"), "attributes: {}\nedges: [[PART_OF, Agreement]]\n");
      const buyer = await strutOn(graph, "buyer");
      const r = await install(buyer, `file:${dir}`);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error!, /graph\/Agreement\.yaml: key_spec: Agreement is keyed by \[ref\] in the graph, and this package declares \[name\]/);
      assert.equal(await graph.schemas.resolveType("Clause"), null);
    });
  });
}
