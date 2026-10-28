import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workflowOf, type StepContext } from "../../../core.js";
import { buildRegistryTools } from "../../core/agent.js";
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

describe("graphCtx: the memory graph, for an agent's tool calls in the workflows the host names", () => {
  const wired = { kind: "ladybug" } as unknown as GraphBackend;
  // No dataDir and no STRUT_MEMORY_DB: taking the memory route fails on
  // memoryDb's own message, before anything opens. So each case below tells
  // the routes apart without a memory file (memory-graph.test.ts reads one).
  const services = { graph: wired, memoryGraph: { workflows: ["orchestrator", "peel-automation-run"] }, secrets: { get: async () => undefined } };
  const ctx = (c: Partial<StepContext>) => ({ runId: "r", path: "", scope: {}, input: undefined, emit: async () => {}, services, ...c }) as never;
  const MEMORY = /memory\/\* steps need the server's dataDir/;

  it("an agent's tool call in a named workflow reads memory", async () => {
    await assert.rejects(graphCtx(ctx({ workflow: "orchestrator", path: "orchestrator/turn", agentTool: true })), MEMORY);
    await assert.rejects(graphCtx(ctx({ workflow: "peel-automation-run", path: "peel-automation-run/agent", agentTool: true })), MEMORY);
    // A context built by hand: the workflow is its path's first segment.
    await assert.rejects(graphCtx(ctx({ path: "orchestrator/turn", agentTool: true })), MEMORY);
  });

  it("a job the orchestrator starts, a workflow's own step, and a host that names none keep the workspace graph", async () => {
    assert.equal(await graphCtx(ctx({ workflow: "job", path: "job/agent", agentTool: true })), wired, "a job is its own run");
    assert.equal(await graphCtx(ctx({ workflow: "orchestrator", path: "orchestrator/lookup" })), wired, "a DAG step, not an agent's call");
    const hive = { ...services, memoryGraph: undefined };
    assert.equal(await graphCtx({ ...(ctx({ workflow: "orchestrator", agentTool: true }) as object), services: hive } as never), wired, "Hive sets nothing");
  });

  it("an agent's tool call sees the run's workflow, whatever path the call runs at", async () => {
    let seen: StepContext | undefined;
    const registry = { "probe/ctx": { type: "probe/ctx", input: { parse: (v: unknown) => v }, run: async (_: unknown, c: StepContext) => ((seen = c), "ok") } } as never;
    const tools = buildRegistryTools(["probe/ctx"], registry, ctx({ workflow: "orchestrator", path: "orchestrator/turn" }), (d: unknown) => d) as Record<string, { execute(i: unknown, o?: unknown): Promise<unknown> }>;
    await tools["probe_ctx"]!.execute({}, { strutToolPath: "orchestrator/turn/probe_ctx#1" });
    assert.equal(seen?.agentTool, true);
    assert.equal(workflowOf(seen!), "orchestrator");
    await assert.rejects(graphCtx(seen as never), MEMORY);
  });
});
