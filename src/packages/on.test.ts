/**
 * WORKFLOWS ON GRAPH WRITES (`on:` in strut.yaml, plans/package-seams.md §2):
 * the manifest key, one op per node per send, the guards (a person, the
 * package's own runs, the chain of three), where the reporter tells and
 * where it does not (a Concept branch, a trial), and a fixture package on a
 * strut with a graph: a person's write starts its workflow as them, the
 * workflow's own writes start nothing of its own, an uninstall drops it.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { flow, step, type OnWriteMark, type RunEvent } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { LadybugBackend } from "../graph/backend.js";
import { createNodeSchema } from "../graph/schema-crud.js";
import { testBackends } from "../graph/test-util.js";
import { bindGraph, createGraphChangeFeed, graphReporter, lastValues, netOps, NODE_VALUE_MAX, NODE_VALUES_MAX, type NodeWrite, type OnWrites, type WriteBy } from "../graph-writes.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { derivePackageDetail } from "./detail.js";
import { readPackage } from "./format.js";
import { matches, ON_CHAIN_MAX, type InstalledTrigger } from "./on.js";

const PKG = "acme/devbox";

let root: string;
async function writeTree(files: Record<string, string>, name = crypto.randomUUID()): Promise<string> {
  const dir = join(root, "src", name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-on-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const manifest = (on: string) => ({
  "strut.yaml": `package: ${PKG}\nversion: 0.1.0\n${on}`,
  "workflows/setup.yaml": `name: ${PKG}/setup\nsteps:\n  - { id: say, type: log, config: { message: setup } }\n`,
  "workflows/drop.yaml": `name: ${PKG}/drop\nsteps:\n  - { id: say, type: log, config: { message: drop } }\n`,
});

describe("strut.yaml's on: key (readPackage)", () => {
  it("resolves each entry to its op, its type and the package's own workflow, which the install card says", async () => {
    const dir = await writeTree(manifest("on:\n  - created: Workspace\n    workflow: setup\n  - deleted: Workspace\n    workflow: drop\n"));
    const info = await readPackage(dir);
    assert.deepEqual(info.on, [
      { op: "created", type: "Workspace", workflow: `${PKG}/setup` },
      { op: "deleted", type: "Workspace", workflow: `${PKG}/drop` },
    ]);
    const d = await derivePackageDetail({ ...info, dir });
    assert.deepEqual(d.workflows.map((w) => [w.name, w.on]), [
      ["drop", ["when a Workspace is deleted, as the person whose run did it"]],
      ["setup", ["when a Workspace is created, as the person whose run did it"]],
    ]);
    assert.equal((await readPackage(await writeTree(manifest("")))).on, undefined);
  });

  it("refuses a workflow not the package's, an entry with no op or two, a bad type, a key it does not know, the same entry twice", async () => {
    const refusal = async (on: string) => {
      try {
        await readPackage(await writeTree(manifest(on)));
      } catch (e) {
        return (e as Error).message;
      }
      assert.fail("read");
    };
    assert.match(await refusal("on:\n  - created: Workspace\n    workflow: job\n"), /on\[0\]\.workflow: "job" is not a workflow of the package/);
    assert.match(await refusal("on:\n  - workflow: setup\n"), /on\[0\]: an entry names one op — created, updated or deleted — and its type/);
    assert.match(await refusal("on:\n  - created: Workspace\n    updated: Workspace\n    workflow: setup\n"), /names one op .* not created and updated/);
    assert.match(await refusal("on:\n  - created: 9lives\n    workflow: setup\n"), /on\[0\]\.created: a graph type is a letter/);
    assert.match(await refusal("on:\n  - event: actor.removed\n    workflow: setup\n"), /Unrecognized key/);
    assert.match(await refusal("on:\n  - created: Workspace\n    workflow: setup\n  - created: Workspace\n    workflow: setup\n"), /on\[1\]: created: Workspace runs setup twice/);
  });

  it("a bundle has no on: of its own", async () => {
    const dir = await writeTree({ "strut.yaml": `package: ${PKG}\nversion: 0.1.0\nbundle: [git+https://github.com/acme/devbox]\non:\n  - created: Workspace\n    workflow: setup\n` });
    await assert.rejects(readPackage(dir), /on: a bundle lists packages and has no on of its own/);
  });
});

describe("one op per node per send (netOps)", () => {
  const w = (ref_id: string, op: NodeWrite["op"]) => ({ ref_id, op, type: "Workspace" });
  it("folds each node's writes to what the send did to it", () => {
    assert.deepEqual(
      netOps([w("a", "created"), w("a", "updated"), w("b", "created"), w("b", "deleted"), w("c", "updated"), w("c", "deleted"), w("d", "updated"), w("d", "updated"), w("e", "deleted"), w("e", "created"), { ref_id: "f", op: "updated" }]),
      [
        { ref_id: "a", type: "Workspace", op: "created" },
        { ref_id: "c", type: "Workspace", op: "deleted" },
        { ref_id: "d", type: "Workspace", op: "updated" },
        { ref_id: "e", type: "Workspace", op: "updated" },
      ],
    );
  });

  it("a deleted node keeps the values its last delete read; any other op carries none", () => {
    const was = (name: string) => ({ name });
    assert.deepEqual(
      netOps([
        { ...w("a", "updated") },
        { ...w("a", "deleted"), node: was("a1") },
        { ...w("b", "deleted"), node: was("b1") },
        { ...w("b", "created") },
        { ...w("c", "created") },
        { ...w("c", "deleted"), node: was("c1") },
      ]),
      [
        { ref_id: "a", type: "Workspace", op: "deleted", node: { name: "a1" } },
        { ref_id: "b", type: "Workspace", op: "updated" },
      ],
    );
  });
});

describe("what a delete carries of the node (lastValues)", () => {
  it("its small scalar fields: a long string, a list, an object or a number that is not one is left out", () => {
    const long = "x".repeat(NODE_VALUE_MAX + 1);
    assert.deepEqual(
      lastValues({ name: "stakwork", count: 3, live: false, body: long, embedding: [0.1, 0.2], meta: { a: 1 }, nothing: null, nan: Number.NaN, edge: "y".repeat(NODE_VALUE_MAX) }),
      { name: "stakwork", count: 3, live: false, edge: "y".repeat(NODE_VALUE_MAX) },
    );
  });

  it("and no more than NODE_VALUES_MAX characters in all: a field that would pass it is left out, a smaller one after it kept", () => {
    const props: Record<string, unknown> = {};
    // Each field 999 characters with its name: 16 fit, the 17th would pass the whole, "name" (8) still fits.
    for (let i = 0; i < 20; i++) props[`f${String(i).padStart(2, "0")}`] = "z".repeat(NODE_VALUE_MAX - 4);
    props["name"] = "kept";
    const out = lastValues(props);
    const size = Object.entries(out).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
    assert.ok(size <= NODE_VALUES_MAX, `${size} characters`);
    const fit = Math.floor(NODE_VALUES_MAX / (NODE_VALUE_MAX - 1));
    assert.deepEqual(Object.keys(out), [...Object.keys(props).slice(0, fit), "name"]);
  });
});

describe("what a send starts (matches)", () => {
  const T = (pkg: string, op: NodeWrite["op"], type: string, workflow = "w"): InstalledTrigger => ({ package: pkg, op, type, workflow: `${pkg}/${workflow}` });
  const triggers = [T("acme/devbox", "created", "Workspace", "setup"), T("acme/devbox", "deleted", "Workspace", "drop"), T("acme/crm", "created", "Workspace"), T("acme/crm", "created", "Customer")];
  const created: NodeWrite = { ref_id: "n1", type: "Workspace", op: "created" };

  it("each entry of the op and type, marked with the write and the run that wrote", () => {
    const { launches, stopped } = matches(triggers, [created, { ref_id: "n2", type: "Matter", op: "created" }], { runId: "r1", actor: "alice" });
    assert.deepEqual(stopped, []);
    assert.deepEqual(
      launches.map((l) => [l.trigger.workflow, l.mark]),
      [
        ["acme/devbox/setup", { package: "acme/devbox", op: "created", type: "Workspace", ref_id: "n1", by: "r1", depth: 1 }],
        ["acme/crm/w", { package: "acme/crm", op: "created", type: "Workspace", ref_id: "n1", by: "r1", depth: 1 }],
      ],
    );
  });

  it("nothing without a person; nothing of the writing run's own package; nothing past the chain's end", () => {
    assert.deepEqual(matches(triggers, [created], { runId: "r1" }), { launches: [], stopped: [] });
    const mark = (pkg: string, depth: number): OnWriteMark => ({ package: pkg, op: "created", type: "Workspace", ref_id: "n0", by: "r0", depth });
    const fromDevbox = matches(triggers, [created], { runId: "r2", actor: "alice", mark: mark("acme/devbox", 1) });
    assert.deepEqual(fromDevbox.launches.map((l) => [l.trigger.package, l.mark.depth, l.mark.by]), [["acme/crm", 2, "r2"]]);
    const atTheEnd: WriteBy = { runId: "r3", actor: "alice", mark: mark("acme/other", ON_CHAIN_MAX) };
    const stopped = matches(triggers, [created], atTheEnd);
    assert.deepEqual(stopped.launches, []);
    assert.deepEqual(stopped.stopped.map((s) => s.trigger.workflow), ["acme/devbox/setup", "acme/crm/w"]);
  });
});

describe("the reporter tells onWrites", () => {
  const listener = () => {
    const fired: Array<{ writes: readonly NodeWrite[]; by: WriteBy }> = [];
    const onWrites: OnWrites = { fire: (writes, by) => void fired.push({ writes, by }) };
    return { fired, onWrites };
  };
  const reader = { getNode: async (ref: string) => ({ node_type: ref.startsWith("run") ? "StrutRun" : "Workspace" }) };

  it("each send's node writes, folded, with who wrote and the run's own mark; strut's own types and edges never", async () => {
    const { fired, onWrites } = listener();
    const mark: OnWriteMark = { package: "acme/crm", op: "created", type: "Customer", ref_id: "c1", by: "r0", depth: 1 };
    const r = graphReporter({ runId: "r1", actor: "alice", job: "j1", onWrites, onWrite: mark, reader, debounceMs: 5 });
    r.note({ kind: "node", op: "created", ref_id: "n1", node_type: "Workspace" });
    r.note({ kind: "node", op: "updated", ref_id: "n1" });
    r.note({ kind: "node", op: "updated", ref_id: "n2" });
    r.note({ kind: "node", op: "created", ref_id: "run1", node_type: "StrutRun" });
    r.note({ kind: "edge", op: "created", ref_id: "e1", edge_type: "HAS", source: "n1", target: "n2" });
    await r.flush();
    assert.deepEqual(fired, [
      {
        writes: [
          { ref_id: "n1", type: "Workspace", op: "created" },
          { ref_id: "n2", type: "Workspace", op: "updated" },
        ],
        by: { runId: "r1", actor: "alice", job: "j1", mark },
      },
    ]);
    r.note({ kind: "node", op: "deleted", ref_id: "n1", node_type: "Workspace" });
    await r.flush();
    assert.deepEqual(fired[1]!.writes, [{ ref_id: "n1", type: "Workspace", op: "deleted" }], "the next send, apart");
  });

  it("a delete reads the node first: on: is handed its values as they were, the feed never", async () => {
    const { fired, onWrites } = listener();
    const graphChanges = createGraphChangeFeed();
    const props: Record<string, Record<string, unknown>> = { w1: { ref_id: "w1", name: "stakwork", body: "b".repeat(NODE_VALUE_MAX + 1) } };
    const nodes = {
      async deleteNode(ref: string) {
        delete props[ref];
        return { ref_id: ref, edges: 0 };
      },
    };
    const full = { getNode: async (ref: string) => (props[ref] ? { node_type: "Workspace", properties: props[ref] } : null) };
    const bound = bindGraph({ graph: { nodes, reader: full }, onWrites, graphChanges }, { runId: "r1", actor: "alice" });
    await (bound.services.graph.nodes as typeof nodes).deleteNode("w1");
    await bound.reporter!.flush();
    assert.deepEqual(fired[0]!.writes, [{ ref_id: "w1", type: "Workspace", op: "deleted", node: { ref_id: "w1", name: "stakwork" } }]);
    const [fed] = (await graphChanges.read()).changes;
    assert.deepEqual([fed!.op, fed!.ref_id, fed!.node_type, "node" in fed!], ["deleted", "w1", "Workspace", false]);
  });

  it("a branch's writes and a trial's tell nothing; a proposal's apply is `by` its id", async () => {
    const { fired, onWrites } = listener();
    const onBranch = graphReporter({ runId: "r1", actor: "alice", onWrites, reader, branch: "try-1" });
    onBranch.note({ kind: "node", op: "created", ref_id: "n1", node_type: "Workspace" });
    await onBranch.flush();
    assert.deepEqual(fired, []);

    const nodes = { write: async () => ({ ref_id: "n9", node_type: "Workspace", outcome: "created" }) };
    const bag = { graph: { nodes, reader }, onWrites };
    const trial = bindGraph(bag, { runId: "r2", actor: "alice", trial: true });
    await (trial.services.graph.nodes as typeof nodes).write();
    await trial.reporter?.flush();
    assert.deepEqual(fired, [], "a trial is a try");

    const apply = bindGraph(bag, { id: "proposal:p1", actor: "bob" });
    await (apply.services.graph.nodes as typeof nodes).write();
    await apply.reporter!.flush();
    assert.deepEqual(fired, [{ writes: [{ ref_id: "n9", type: "Workspace", op: "created" }], by: { runId: "proposal:p1", actor: "bob" } }]);
  });
});

const lb = testBackends().find((b) => b.kind === "ladybug")!;

describe("on: on a strut with a graph (ladybug)", { skip: lb.skip }, () => {
  let graph: LadybugBackend;
  let strut: Strut;
  let store: MemoryRunStore;
  let ws: WorkspaceManager;
  const saved: Record<string, string | undefined> = {};
  before(async () => {
    for (const k of ["STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES", "ANTHROPIC_API_KEY"]) saved[k] = process.env[k];
    process.env["STRUT_SECRET_KEY"] = "on-secret";
    process.env["STRUT_PACKAGE_INDEXES"] = "[]";
    // A prepared turn resolves the model it scripts its answer under, and calls none.
    process.env["ANTHROPIC_API_KEY"] = "on-test-key";
    graph = (await lb.open()) as LadybugBackend;
    await createNodeSchema(graph, graph.schemas, { type: "Workspace", attributes: { description: "?string" }, role: "entity" });
  });
  after(async () => {
    await lb.close(graph);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(async () => {
    await lb.clear(graph);
    store = new MemoryRunStore();
    const dir = join(root, "box");
    ws = new WorkspaceManager(dir);
    strut = await createStrut({
      workspace: ws,
      dataDir: dir,
      graph,
      store,
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
      subscriptionPoll: false,
    });
  });
  afterEach(async () => {
    await strut.close();
  });

  /** The fixture: `setup` keeps the op in the node's files and edits the
   *  node (its own package's write), on created and updated Workspaces. */
  const DEVBOX = {
    "strut.yaml": `package: ${PKG}\nversion: 0.1.0\non:\n  - created: Workspace\n    workflow: setup\n  - updated: Workspace\n    workflow: setup\n`,
    "workflows/setup.yaml": [
      `name: ${PKG}/setup`,
      "steps:",
      `  - { id: keep, type: node/write-files, config: { ref_id: "{{ input.ref_id }}", files: { op.txt: "{{ input.op }} {{ input.type }} by {{ input.by }}" } } }`,
      `  - { id: mark, type: graph/edit-node, config: { ref_id: "{{ input.ref_id }}", node_data: { description: "set up" } } }`,
      "",
    ].join("\n"),
  };
  const SETUP = `${PKG}/setup`;
  const make = flow("make-workspace", {
    input: z.object({}).passthrough(),
    steps: [
      step("create", "graph/create-node", { node_type: "Workspace", node_data: { name: "{{ input.name }}" } }),
      step("edit", "graph/edit-node", { ref_id: "{{ create.ref_id }}", node_data: { description: "new" } }),
    ],
  });
  /** The runs of `workflow` once none has started for a while, each ended. */
  const settled = async (workflow: string, quietMs = 600) => {
    let seen = -1;
    let since = Date.now();
    for (;;) {
      const ids = await store.listRuns(workflow);
      if (ids.length !== seen) {
        seen = ids.length;
        since = Date.now();
      }
      const ended = (await Promise.all(ids.map((id) => store.getRunSummary(workflow, id)))).every(Boolean);
      if (ended && Date.now() - since > quietMs) return ids;
      if (Date.now() - since > 20_000) throw new Error(`${workflow}'s runs never settled`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const startOf = async (workflow: string, runId: string): Promise<RunEvent> => (await store.getRunEvents(workflow, runId)).find((e) => e.type === "run.start")!;

  it("a person's write starts the package's workflow once, as them; its own writes start nothing of its own; an uninstall drops it", async () => {
    await strut.packages.install(`file:${await writeTree(DEVBOX)}`, { actor: "alice" });

    const made = await strut.run(make, { name: "one" }, { actor: "bob" });
    assert.equal(made.status, "success", JSON.stringify(made.error));
    const ref = ((await store.getRunEvents("make-workspace", made.runId)).find((e) => e.type === "step.end" && e.path.endsWith("/create"))!.output as { ref_id: string }).ref_id;

    const [run, ...more] = await settled(SETUP);
    assert.equal(more.length, 0, "created then updated in one send: created, once — and its own edit started nothing");
    const start = await startOf(SETUP, run!);
    assert.deepEqual(start.input, { ref_id: ref, type: "Workspace", op: "created", by: made.runId });
    assert.deepEqual([start.actor, start.principal], ["bob", "bob"], "as the person whose run wrote");
    assert.deepEqual(start.onWrite, { package: PKG, op: "created", type: "Workspace", ref_id: ref, by: made.runId, depth: 1 });
    assert.equal((await store.getRunSummary(SETUP, run!))!.status, "success");
    const files = await strut.services.nodeFiles!.read(ref, { package: PKG });
    assert.equal(Buffer.from(files!.files["op.txt"]!).toString(), `created Workspace by ${made.runId}`);

    // A write with nobody behind it starts nothing.
    await strut.run(flow("edit-anon", { input: z.object({}).passthrough(), steps: [step("e", "graph/edit-node", { ref_id: ref, node_data: { description: "anon" } })] }), {});
    assert.equal((await settled(SETUP)).length, 1);

    // A person's update does — and a write a job made says which job.
    const edit = await strut.run(flow("edit-it", { input: z.object({}).passthrough(), steps: [step("e", "graph/edit-node", { ref_id: ref, node_data: { description: "again" } })] }), {}, { actor: "carol", job: "carol-job" });
    const after = await settled(SETUP);
    assert.equal(after.length, 2);
    const second = await startOf(SETUP, after.find((id) => id !== run)!);
    assert.deepEqual(second.input, { ref_id: ref, type: "Workspace", op: "updated", by: edit.runId, job: "carol-job" });
    assert.equal(second.actor, "carol");

    await strut.packages.uninstall(PKG);
    await strut.run(make, { name: "two" }, { actor: "bob" });
    assert.equal((await settled(SETUP)).length, 2, "uninstalled: its entries are gone");
  });

  it("a workflow on deleted is handed the node as it was, read before the delete: it need not read a node that may be gone", async () => {
    const DROP = `${PKG}/drop`;
    await strut.packages.install(
      `file:${await writeTree({
        "strut.yaml": `package: ${PKG}\nversion: 0.1.0\non:\n  - deleted: Workspace\n    workflow: drop\n`,
        // An input block drops a key it does not name: `node` is declared, as pods' drop-images does.
        "workflows/drop.yaml": [
          `name: ${DROP}`,
          "input:",
          "  ref_id: { type: string }",
          "  type: { type: string }",
          "  op: { type: string }",
          "  by: { type: string }",
          "  node: { type: json, required: false }",
          "steps:",
          `  - { id: say, type: log, config: { message: "drop {{ input.node.name }}" } }`,
          "",
        ].join("\n"),
      })}`,
      { actor: "alice" },
    );
    const made = await strut.run(make, { name: "five" }, { actor: "bob" });
    assert.equal(made.status, "success", JSON.stringify(made.error));
    const ref = ((await store.getRunEvents("make-workspace", made.runId)).find((e) => e.type === "step.end" && e.path.endsWith("/create"))!.output as { ref_id: string }).ref_id;
    const gone = await strut.run(flow("drop-it", { input: z.object({}).passthrough(), steps: [step("d", "graph/delete-node", { ref_id: ref, reason: "a test" })] }), {}, { actor: "bob" });
    assert.equal(gone.status, "success", JSON.stringify(gone.error));
    const [run, ...more] = await settled(DROP);
    assert.equal(more.length, 0);
    const input = (await startOf(DROP, run!)).input as { ref_id: string; type: string; op: string; by: string; node: Record<string, unknown> };
    assert.deepEqual([input.ref_id, input.type, input.op, input.by], [ref, "Workspace", "deleted", gone.runId]);
    assert.equal(input.node["name"], "five");
    assert.equal(input.node["description"], "new", "its values as the delete found them");
    const said = (await store.getRunEvents(DROP, run!)).find((e) => e.type === "step.end" && e.path.endsWith("/say"));
    assert.match(JSON.stringify(said?.output), /drop five/, "the workflow reads input.node");
    assert.equal((await store.getRunSummary(DROP, run!))!.status, "success");
  });

  it("a job its workflow starts carries its mark: the job's writes are its work, and start nothing of its own", async () => {
    // The box's job workflow: it marks the node its prompt names.
    await ws.publishWorkflow("job", "v1", `name: job\nsteps:\n  - { id: mark, type: graph/edit-node, config: { ref_id: "{{ input.prompt }}", node_data: { description: "baked" } } }\n`);
    await strut.packages.install(
      `file:${await writeTree({
        ...DEVBOX,
        "workflows/setup.yaml": `name: ${SETUP}\nsteps:\n  - { id: start, type: job/start, config: { prompt: "{{ input.ref_id }}", title: "Set up {{ input.ref_id }}" } }\n`,
      })}`,
      { actor: "alice" },
    );
    const made = await strut.run(make, { name: "three" }, { actor: "bob" });
    assert.equal(made.status, "success", JSON.stringify(made.error));
    const [setup, ...more] = await settled(SETUP);
    const [job, ...jobs] = await settled("job");
    assert.deepEqual([more.length, jobs.length], [0, 0], "the job's update of the node started no second setup");
    const mark = (await startOf(SETUP, setup!)).onWrite;
    assert.equal((await store.getRunSummary("job", job!))!.status, "success");
    assert.deepEqual((await startOf("job", job!)).onWrite, mark, "the job run carries the mark of the run that started it");
  });

  it("a chat its workflow starts (conversation/start) carries its mark to the chat's job: the job's writes start nothing of its own", async () => {
    // The box with its orchestrator (no wake: no model here).
    await strut.close();
    strut = await createStrut({
      workspace: ws,
      dataDir: join(root, "box"),
      graph,
      store,
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      job: false,
      orchestrator: { wake: false },
      builder: false,
      views: false,
      concepts: false,
      stt: false,
      subscriptionPoll: false,
    });
    await ws.publishWorkflow("job", "v1", `name: job\nsteps:\n  - { id: mark, type: graph/edit-node, config: { ref_id: "{{ input.prompt }}", node_data: { description: "baked" } } }\n`);
    await strut.packages.install(
      `file:${await writeTree({
        ...DEVBOX,
        "workflows/setup.yaml": `name: ${SETUP}\nsteps:\n  - { id: chat, type: conversation/start, config: { message: "Set up {{ input.ref_id }}", job: { title: "Set up", brief: "{{ input.ref_id }}" }, about: "{{ input.ref_id }}" } }\n`,
      })}`,
      { actor: "alice" },
    );
    const made = await strut.run(make, { name: "four" }, { actor: "bob" });
    assert.equal(made.status, "success", JSON.stringify(made.error));
    // Bounded: without the mark, each job's write starts another setup, and
    // the runs never settle.
    for (let i = 0; !(await store.listRuns("job")).length || !(await store.getRunSummary("job", (await store.listRuns("job"))[0]!)); i++) {
      if (i > 800) assert.fail("the chat's job never ran");
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 800));
    const [setup, ...more] = await store.listRuns(SETUP);
    const [job, ...jobs] = await store.listRuns("job");
    const [turn, ...turns] = await store.listRuns("orchestrator");
    assert.deepEqual([more.length, jobs.length, turns.length], [0, 0, 0], "the chat's job updated the node, and started no second setup");
    assert.equal((await store.getRunSummary(SETUP, setup!))!.status, "success");
    const mark = (await startOf(SETUP, setup!)).onWrite;
    const turnStart = await startOf("orchestrator", turn!);
    assert.deepEqual([turnStart.actor, turnStart.onWrite], ["bob", mark], "the chat is the writer's, its turn carrying the mark");
    assert.equal((await store.getRunSummary("job", job!))!.status, "success");
    assert.deepEqual((await startOf("job", job!)).onWrite, mark, "and its job");
  });
});
