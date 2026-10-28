import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { graphCtx, type GraphBackend } from "./_shared.js";

describe("graphCtx: the backend the server wired comes first", () => {
  it("returns ctx.services.graph without opening anything", async () => {
    const wired = { kind: "ladybug", cfg: { kind: "ladybug", path: "/x/graph.lbug", namespace: "default" } } as unknown as GraphBackend;
    // A secrets capability that would fail the env route: the wired backend
    // must win before any of it is read.
    const secrets = { get: async () => { throw new Error("env route taken"); } };
    const b = await graphCtx({ services: { graph: wired, secrets } } as never);
    assert.equal(b, wired);
  });
});

describe("graphCtx: the memory graph is bound per workflow", () => {
  const workspace = { kind: "workspace" } as unknown as GraphBackend;
  const memory = { kind: "memory" } as unknown as GraphBackend;
  const ctx = (workflow: string | undefined, services: Record<string, unknown>, path = `${workflow}/step`) =>
    ({ workflow, path, services }) as never;

  it("the orchestrator gets the memory backend; job (and every other workflow) keeps services.graph", async () => {
    const services = { graph: workspace, memoryGraph: memory };
    assert.equal(await graphCtx(ctx("orchestrator", services)), memory);
    assert.equal(await graphCtx(ctx("job", services)), workspace);
    assert.equal(await graphCtx(ctx("builder", services)), workspace);
    assert.equal(await graphCtx(ctx(undefined, services, "")), workspace, "no workflow: the workspace's");
  });

  it("an agent's tool call has no workflow of its own: the first path segment names it", async () => {
    const services = { graph: workspace, memoryGraph: memory };
    assert.equal(await graphCtx({ path: "orchestrator/turn/001-graph_search", services } as never), memory);
    assert.equal(await graphCtx({ path: "job/work/001-graph_search", services } as never), workspace);
  });

  it("the workflows are the host's: memoryGraphWorkflows names them, and replaces the default", async () => {
    const services = { graph: workspace, memoryGraph: memory, memoryGraphWorkflows: ["orchestrator", "peel-automation-run"] };
    assert.equal(await graphCtx(ctx("peel-automation-run", services)), memory);
    assert.equal(await graphCtx(ctx("orchestrator", services)), memory);
    assert.equal(await graphCtx(ctx("job", services)), workspace);
    const only = { graph: workspace, memoryGraph: memory, memoryGraphWorkflows: ["x"] };
    assert.equal(await graphCtx(ctx("orchestrator", only)), workspace);
  });

  it("without memoryGraph on the bag nothing changes, orchestrator or not", async () => {
    assert.equal(await graphCtx(ctx("orchestrator", { graph: workspace })), workspace);
    assert.equal(await graphCtx(ctx("orchestrator", { graph: workspace, memoryGraphWorkflows: ["orchestrator"] })), workspace);
  });
});
