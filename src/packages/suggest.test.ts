/**
 * What a build suggests (./suggest.ts): the graph types a workflow's runs
 * wrote, and the roots of the Concept pages they read — from the runs' own
 * logs, then on every graph backend the climb to a page's root and the
 * types route the package page's typeahead reads.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunSummary } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { createNodeSchema } from "../graph/schema-crud.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { readRun, suggest } from "./suggest.js";

const at = "2026-11-06T00:00:00.000Z";
const ev = (e: Partial<RunEvent>): RunEvent => ({ ts: at, runId: "r", path: "wf/s", type: "step.end", ...e }) as RunEvent;
const summary = (runId: string, status: RunSummary["status"]): RunSummary => ({ runId, workflow: "wf", startedAt: at, finishedAt: at, durationMs: 1, status, input: {} });

/** A run of `wf` with these events, finished with `status`. */
async function run(store: MemoryRunStore, runId: string, status: RunSummary["status"], events: Array<Partial<RunEvent>>) {
  for (const e of events) await store.append("wf", runId, ev({ runId, ...e }));
  await store.finalize("wf", runId, summary(runId, status));
}

const none = { types: new Set<string>(), concepts: new Set<string>(), conceptStamp: () => false };

describe("what a build suggests, from the runs' logs", () => {
  it("reads the types a run's write steps wrote, an agent's tool calls included, and the pages context/concept read — never what a read step touched", () => {
    const r = readRun([
      ev({ stepType: "tool:graph/create-batch-triplet", nodes: [{ ref_id: "1", node_type: "LegalParty" }, { ref_id: "2", node_type: "Agreement" }] }),
      ev({ stepType: "graph/edit-node", nodes: [{ ref_id: "3", node_type: "Excerpt" }] }),
      ev({ stepType: "tool:graph/graph-search", nodes: [{ ref_id: "4", node_type: "Person" }] }),
      ev({ stepType: "context/concept", nodes: [{ ref_id: "5", node_type: "Concept", name: "Indemnity" }] }),
      ev({ stepType: "graph/create-node", nodes: [{ ref_id: "6", node_type: "Elsewhere", peer: "org" }] }),
      ev({ type: "step.start", stepType: "graph/create-node", nodes: [{ ref_id: "7", node_type: "Started" }] }),
    ]);
    assert.deepEqual(r.types.sort(), ["Agreement", "Excerpt", "LegalParty"]);
    assert.deepEqual(r.concepts, ["Indemnity"]);
  });

  it("reads only successful runs, leaves out strut's own, the seed's and what is carried already", async () => {
    const store = new MemoryRunStore();
    await run(store, "1", "success", [{ stepType: "tool:graph/create-node", nodes: [{ ref_id: "a", node_type: "LegalParty" }, { ref_id: "b", node_type: "Claim" }, { ref_id: "c", node_type: "StrutRun" }] }]);
    await run(store, "2", "error", [{ stepType: "graph/create-node", nodes: [{ ref_id: "d", node_type: "Broken" }] }]);
    await run(store, "3", "success", [{ stepType: "graph/create-node", nodes: [{ ref_id: "e", node_type: "Agreement" }] }]);
    const s = await suggest({ runs: store }, ["wf"], [], { ...none, types: new Set(["agreement"]) });
    assert.deepEqual(s, { types: ["LegalParty"], concepts: [] });
  });
});

const boot = (workspace: GraphWorkspaceStore, dataDir: string, store: MemoryRunStore) =>
  createStrut({
    workspace,
    dataDir,
    store,
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

for (const tb of testBackends()) {
  describe(`what a build suggests, on the graph (${tb.name})`, { skip: tb.skip }, () => {
    let backend: GraphBackend;
    let scratch: string;
    const struts: Strut[] = [];
    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      await seedStrutDomain(backend);
      backend.schemas.invalidate();
    });
    after(() => tb.close(backend));
    beforeEach(async () => {
      await tb.clear(backend);
      scratch = await mkdtemp(join(tmpdir(), "strut-suggest-"));
    });
    afterEach(async () => {
      for (const s of struts.splice(0)) await s.close?.();
      await rm(scratch, { recursive: true, force: true });
    });
    const page = async (name: string, parent?: string) => {
      const { ref_id } = await backend.nodes.write({ type: "Concept", data: { name } }, "upsert");
      if (parent) {
        const p = (await backend.nodes.write({ type: "Concept", data: { name: parent } }, "upsert")).ref_id;
        await backend.edges.write({ edge: "PARENT_OF", source_ref_id: p, target_ref_id: ref_id });
      }
    };

    it("suggests the root of each page the runs read, and of each page a workflow names, once", async () => {
      await page("Legal Desk");
      await page("Clauses", "Legal Desk");
      await page("Indemnity", "Clauses");
      await page("Elsewhere");
      const store = new MemoryRunStore();
      await run(store, "1", "success", [{ stepType: "context/concept", nodes: [{ ref_id: "x", node_type: "Concept", name: "Indemnity" }] }]);
      const steps = [{ type: "context/concept", config: { name: "Clauses" } }, { type: "context/concept", config: { name: "{{ input.page }}" } }];
      assert.deepEqual(await suggest({ runs: store, graph: backend }, ["wf"], steps, none), { types: [], concepts: ["Legal Desk"] });
      assert.deepEqual(await suggest({ runs: store, graph: backend }, ["wf"], steps, { ...none, concepts: new Set(["Legal Desk"]) }), { types: [], concepts: [] });
    });

    it("lists the graph's types for the typeahead, strut's own left out", async () => {
      await createNodeSchema(backend, backend.schemas, { type: "LegalParty", attributes: {}, type_description: "A party" });
      const dir = join(scratch, "s");
      const s = await boot(new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps"), appsDir: join(dir, "apps") }), dir, new MemoryRunStore());
      struts.push(s);
      const r = (await (await s.app.request("/graph/types")).json()) as { types: Array<{ type: string; description?: string }> };
      assert.equal(r.types.find((t) => t.type === "LegalParty")?.description, "A party");
      assert.ok(r.types.some((t) => t.type === "Concept"));
      assert.ok(!r.types.some((t) => t.type.startsWith("Strut") || t.type === "Thing" || t.type === "Schema"));
    });
  });
}
