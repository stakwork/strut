import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appIdentity } from "../auth.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { MemoryRunStore } from "../store.js";
import { createRegistry } from "../steps/registry.js";
import { kitForTests } from "../test-util/app-kit.js";
import { FileWorkspaceStore } from "../workspace.js";
import { createApps } from "./apps.js";
import { appSchemaInputs, checkAppGraph, graphAttributeType, reservedAppType } from "./graph-types.js";
import type { KitLocation } from "./kit.js";
import { parseManifest, type AppManifest } from "./manifest.js";
import { STEP_RUN_TOOL, buildAppTools } from "./tools.js";

/**
 * An app's graph types (plans/apps.md §4.3): the declaration as jarvis's
 * schema input, the types strut keeps for itself, the backends that cannot
 * hold them (no graph, a LadybugDB file) refusing the build, and — live, on
 * a throwaway Neo4j when STRUT_TEST_NEO4J_URI is set — a publish
 * registering them add-only, a conflicting declaration refused, and a page
 * writing a declared type through `step_run` and reading it back with
 * `graph/find`.
 */

const manifest = (text: string): AppManifest => {
  const m = parseManifest(text);
  assert.ok(m.ok, m.ok ? "" : m.errors.join("\n"));
  return m.manifest;
};

const INVOICES = `title: Invoices
grants:
  steps: [graph/*]
data:
  graph:
    types:
      Customer: { name: string, phone: string?, search: [name] }
      Invoice: { number: string, amount: number, due: date, status: string, meta: json?, key: [number], search: [number, status] }
    edges:
      - [Invoice, BILLED_TO, Customer]
`;
const APP_TSX = 'export default function App() { return <p className="p-2">hi</p>; }\n';

async function writeApp(dir: string, appYaml: string): Promise<string> {
  for (const [rel, text] of Object.entries({ "app.yaml": appYaml, "src/App.tsx": APP_TSX })) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
  return dir;
}

describe("an app's graph types, as a declaration", () => {
  it("map the app grammar onto jarvis's: number → float, date and json → string, `x?` → `?x`; key → node_key, search → index, a title when there is no name", () => {
    assert.deepEqual(["string", "number?", "boolean", "date", "json?"].map(graphAttributeType), ["string", "?float", "boolean", "string", "?string"]);
    const [customer, invoice] = appSchemaInputs(manifest(INVOICES), "invoices");
    assert.deepEqual(customer, { type: "Customer", attributes: { name: "string", phone: "?string" }, node_key: "name", index: ["name"], type_description: "Declared by the app invoices (app.yaml data.graph)." });
    assert.deepEqual(invoice, {
      type: "Invoice",
      attributes: { number: "string", amount: "float", due: "string", status: "string", meta: "?string" },
      node_key: "number",
      index: ["number", "status"],
      title_key: "number",
      type_description: "Declared by the app invoices (app.yaml data.graph).",
    });
    assert.deepEqual(appSchemaInputs(manifest("title: T\n")), []);
  });

  it("the manifest's key is a list of attributes or name, never empty, never an attribute itself", () => {
    const bad = (types: string) => {
      const m = parseManifest(`title: T\ndata:\n  graph:\n    types:\n      ${types}\n`);
      assert.equal(m.ok, false);
      return m.ok ? "" : m.errors.join("\n");
    };
    assert.match(bad("A: { x: string, key: [nope] }"), /key names "nope", which is not an attribute/);
    assert.match(bad("A: { x: string, key: [] }"), /key needs at least one attribute/);
    assert.match(bad("A: { key: string }"), /`key` is a list of attribute names/);
    assert.match(bad("A: { x: [a] }"), /only `search` .* and `key` .* take a list/);
    assert.ok(parseManifest("title: T\ndata:\n  graph:\n    types:\n      A: { x: string, key: [name, x] }\n").ok, "name needs no declaration");
  });

  it("strut's own types are reserved, whatever their casing", () => {
    for (const t of ["StrutRun", "StrutJob", "Thing", "Schema", "Concept", "concept", "Claim", "Check", "Evidence", "EVIDENCE"]) assert.ok(reservedAppType(t), t);
    for (const t of ["Invoice", "Customer", "Person", "Strategy"]) assert.equal(reservedAppType(t), null, t);
  });

  it("a build is refused with no graph, on a reserved type or an attribute the schema writer refuses — and passes with nothing declared", async () => {
    const m = manifest(INVOICES);
    assert.deepEqual(await checkAppGraph(manifest("title: T\n"), undefined), { errors: [], warnings: [] });
    assert.match((await checkAppGraph(m, undefined)).errors.join("\n"), /this strut has no graph .* does not build here/);
    const reserved = await checkAppGraph(manifest("title: T\ndata:\n  graph:\n    types:\n      Concept: { name: string }\n      StrutRun: { x: string }\n"), undefined);
    assert.equal(reserved.errors.length, 2);
    assert.match(reserved.errors[0]!, /^app\.yaml: data\.graph\.types\.Concept: Concept is the workspace's notes/);
    assert.match(reserved.errors[1]!, /StrutRun is one of strut's own types/);
    assert.match((await checkAppGraph(manifest("title: T\ndata:\n  graph:\n    types:\n      A: { ref_id: string }\n"), undefined)).errors[0]!, /^app\.yaml: data\.graph\.types\.A\.ref_id: attribute name is a reserved/);
  });

  it("a publish on a workspace with no graph publishes nothing, and so does a build", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-app-graph-fs-"));
    try {
      const ws = new FileWorkspaceStore(join(root, "ws"));
      const apps = createApps({ workspace: ws, kit: await kitForTests() });
      const dir = await writeApp(join(root, "src"), INVOICES);
      const pub = await apps.publish(dir, "invoices", { surface: "person" });
      assert.equal(pub.ok, false);
      assert.match(pub.ok ? "" : pub.errors.join("\n"), /no graph/);
      assert.equal(await ws.getApp("invoices"), null);
      const built = await apps.build(dir);
      assert.equal(built.ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// On every graph: a LadybugDB file builds an app's types as Neo4j does
// (plans/memory-in-workspace-graph.md, PR A).
for (const tb of testBackends()) describe(`an app's graph types on ${tb.name}`, { skip: tb.skip }, () => {
  let b: GraphBackend;
  let kit: KitLocation;
  let root: string;
  let strut: Strut;
  const store = new MemoryRunStore();
  let workspace: FileWorkspaceStore;
  let savedKey: string | undefined;
  let registry: Awaited<ReturnType<typeof createRegistry>>;
  let n = 0;
  const publish = async (name: string, appYaml: string) => strut.apps.publish(await writeApp(join(root, `${name}-${++n}`), appYaml), name, { surface: "ai" });

  before(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = "graph-types-key";
    b = await tb.open();
    await tb.wipe(b);
    await seedStrutDomain(b);
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-app-graph-"));
    workspace = new FileWorkspaceStore(join(root, "ws"));
    registry = await createRegistry([]);
    strut = await createStrut({
      workspace,
      store,
      graph: b,
      registry,
      kit,
      scheduler: false,
      serveUi: false,
      enableChat: false,
      job: false,
      orchestrator: false,
      builder: false,
      concepts: false,
      views: false,
      browserWorkflows: false,
      privacyWorkflows: false,
    });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (b) await tb.close(b);
    await rm(root, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
  });

  it("a publish registers the types and edges before the version, add-only; the same declaration again changes nothing", async () => {
    const r = await publish("invoices", INVOICES);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual(r.graph, {
      types: [
        { type: "Customer", created: true, added: [] },
        { type: "Invoice", created: true, added: [] },
      ],
      edges: [{ edge: "Invoice-[BILLED_TO]->Customer", created: true }],
    });
    const invoice = (await b.schemas.schema("Invoice"))!;
    assert.equal(invoice.node_key, "invoice-number");
    assert.equal(invoice.title_key, "number");
    assert.deepEqual(invoice.index.sort(), ["number", "status"]);
    assert.equal(invoice.attributes["amount"], "float");
    assert.equal(invoice.attributes["meta"], "?string");
    assert.ok(await b.schemas.edgeSchema("BILLED_TO", "Invoice", "Customer"));

    const again = await publish("invoices", INVOICES);
    assert.ok(again.ok);
    assert.equal(again.ok && again.version, "v1");
    assert.deepEqual(again.ok && again.graph?.types.map((t) => [t.type, t.created, t.added.length]), [["Customer", false, 0], ["Invoice", false, 0]]);
  });

  it("another app may declare the same type and add to it; a conflicting declaration is refused and publishes nothing", async () => {
    const ledger = await publish("ledger", "title: Ledger\ndata:\n  graph:\n    types:\n      Invoice: { number: string, amount: number, due: date, status: string, paid_on: date?, key: [number] }\n");
    assert.ok(ledger.ok, ledger.ok ? "" : ledger.errors.join("\n"));
    assert.deepEqual(ledger.ok && ledger.graph?.types, [{ type: "Invoice", created: false, added: ["paid_on"] }]);
    assert.ok(ledger.ok && ledger.warnings.some((w) => /indexed on \[number, status\] .* this app's search list does not apply/.test(w)), "its search list cannot change the index");
    assert.equal((await b.schemas.schema("Invoice"))!.attributes["paid_on"], "?string");

    const refused = async (name: string, types: string, re: RegExp) => {
      const r = await publish(name, `title: X\ndata:\n  graph:\n    types:\n      ${types}\n`);
      assert.equal(r.ok, false, name);
      assert.match(r.ok ? "" : r.errors.join("\n"), re);
      assert.equal(await workspace.getApp(name), null, `${name} publishes nothing`);
    };
    await refused("typed", "Invoice: { number: string, amount: string, due: date, status: string, key: [number] }", /data\.graph\.types\.Invoice\.amount: Invoice already holds amount as float, and this app declares string/);
    await refused("keyed", "Invoice: { number: string, amount: number, due: date, status: string }", /data\.graph\.types\.Invoice\.key: Invoice is keyed by \[number\] in the graph, and this app declares \[name\]/);
    await refused("partial", "Invoice: { number: string, amount: number, key: [number] }", /Invoice requires due \(string\) on every node, and this app does not declare it/);
    await refused("notes", "Concept: { name: string }", /Concept is the workspace's notes/);
  });

  it("a page writes a declared type through step_run — kept, as the viewer — and reads it back with graph/find", async () => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, actor: "viewer", runStepDeps: { store, workspace } });
    const call = async (type: string, config: Record<string, unknown>) => {
      const r = (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app: appIdentity("invoices", "v1") }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
      assert.equal(r.error, undefined, r.error);
      return r.result;
    };
    const acme = await call("graph/create-node", { node_type: "Customer", node_data: { name: "Acme" } });
    assert.equal(acme.status, "Success", JSON.stringify(acme));
    for (const [number, amount, due, status] of [
      ["INV-1", 120, "2026-10-01", "unpaid"],
      ["INV-2", 80, "2026-11-01", "paid"],
      ["INV-3", 40, "2026-12-01", "unpaid"],
    ] as const) {
      const made = await call("graph/create-node", { node_type: "Invoice", node_data: { number, amount, due, status, meta: JSON.stringify({ po: number }) } });
      assert.equal(made.status, "Success", JSON.stringify(made));
      const edge = await call("graph/create-triplet", { source_ref_id: made.ref_id, edge_type: "BILLED_TO", target_ref_id: acme.ref_id });
      assert.ok(!/failed/.test(JSON.stringify(edge)), JSON.stringify(edge));
    }
    const kept = await store.listRuns("step:graph/create-node");
    assert.equal(kept.length, 4);
    const summary = (await store.getRunSummary("step:graph/create-node", kept[0]!))!;
    assert.deepEqual([summary.actor, summary.app], ["viewer", { name: "invoices", version: "v1" }]);

    const unpaid = await call("graph/find", { node_type: "Invoice", where: { status: "unpaid", due: { lt: "2026-11-15" } }, orderBy: "due", count: true });
    assert.deepEqual(unpaid.nodes.map((x: { name: string }) => x.name), ["INV-1"]);
    assert.equal(unpaid.total, 1);
    assert.deepEqual(JSON.parse(unpaid.nodes[0].properties.meta), { po: "INV-1" });
    assert.deepEqual(await store.listRuns("step:graph/find"), [], "a read is not kept");
    // The key is the identity: the same number is the same invoice.
    const same = await call("graph/create-node", { node_type: "Invoice", node_data: { number: "INV-1", amount: 120, due: "2026-10-01", status: "unpaid" } });
    assert.equal(same.status, "Warning");
    assert.match(same.messages[0], /already exists in the graph with node_key: invoice-inv1/);
  });
});
