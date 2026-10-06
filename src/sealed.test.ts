import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineStep, type Flow, type Step, type StepRegistry } from "./core.js";
import { flowClosure } from "./closure.js";
import { DEFAULT_SEALED_STEPS, isSealedStep, sealedInClosure, sealedStepPatterns } from "./sealed.js";

const def = (type: string, sealed?: boolean) =>
  defineStep({ type, input: z.any(), output: z.any(), ...(sealed ? { sealed } : {}), run: async () => ({}) });
// A lab-shaped registry: the graders seal themselves on their defs; their
// namespace also holds the producer's door (gaia/get-task), which is open.
const registry = Object.fromEntries(
  ["exec", "log", "agent", "subflow", "clip/trim", "gaia/get-task", "gaia/evaluate", "harvey/score", "eval/reflect"].map((t) => [
    t,
    def(t, t === "gaia/evaluate" || t === "harvey/score"),
  ]),
) as StepRegistry;
const step = (id: string, type: string, config: Record<string, unknown> = {}): Step => ({ id, type, config });
const flow = (name: string, steps: Step[], sealed?: boolean): Flow => ({ name, input: z.any(), steps, ...(sealed ? { sealed } : {}) });
const resolver = (flows: Record<string, Flow>) => ({
  getWorkflow: async (n: string) => flows[n] ?? Promise.reject(new Error(`no ${n}`)),
  getWorkflowVersion: async (n: string, v: string) => flows[`${n}@${v}`] ?? Promise.reject(new Error(`no ${n}@${v}`)),
});

describe("sealed (pure)", () => {
  it("the namespace list: the defaults plus STRUT_SEALED", () => {
    assert.deepEqual(sealedStepPatterns({}), DEFAULT_SEALED_STEPS);
    assert.deepEqual(sealedStepPatterns({ STRUT_SEALED: " secret/*, meta/* ,," }), [...DEFAULT_SEALED_STEPS, "secret/*"]);
  });

  it("a step is sealed by namespace or by its def", () => {
    assert.ok(isSealedStep("eval/reflect") && isSealedStep("meta/run-step"), "the namespaces need no registry");
    assert.ok(isSealedStep("gaia/evaluate", registry) && isSealedStep("harvey/score", registry), "a def seals its step");
    assert.ok(!isSealedStep("gaia/evaluate"), "without the registry only the namespaces are known");
    assert.ok(!isSealedStep("gaia/get-task", registry) && !isSealedStep("clip/trim", registry), "a grader's namespace is not sealed whole");
    assert.ok(!isSealedStep("eval/reflect", registry, []));
    assert.ok(isSealedStep("secret/x", registry, sealedStepPatterns({ STRUT_SEALED: "secret/*" })));
  });

  it("a closure reaches a sealed thing by type, through a subflow, or via a grant — literal or expanded", async () => {
    const flows = {
      grader: flow("grader", [step("g", "log")], true),
      plain: flow("plain", [step("p", "gaia/get-task")]),
      laundered: flow("laundered", [step("s", "subflow", { workflow: "grader" })]),
    };
    const of = (steps: Step[]) => flowClosure(flow("f", steps), resolver(flows));
    assert.equal(sealedInClosure(await of([step("a", "exec"), step("b", "clip/trim"), step("c", "subflow", { workflow: "plain" })]), registry), null);
    assert.equal(sealedInClosure(await of([step("g", "gaia/evaluate")]), registry), 'step "gaia/evaluate"');
    assert.equal(sealedInClosure(await of([step("e", "eval/reflect")]), registry), 'step "eval/reflect"');
    assert.equal(sealedInClosure(await of([step("s", "subflow", { workflow: "grader" })]), registry), 'workflow "grader"');
    assert.equal(sealedInClosure(await of([step("s", "subflow", { workflow: "laundered" })]), registry), 'workflow "grader"', "one hop away is the same oracle");
    assert.equal(sealedInClosure(await of([step("a", "agent", { agentTools: ["meta/*"] })]), registry), 'grant "meta/*"');
    assert.equal(sealedInClosure(await of([step("a", "agent", { agentTools: ["harvey/score"] })]), registry), 'grant "harvey/score"');
    assert.equal(sealedInClosure(await of([step("a", "agent", { agentTools: ["*"] })]), registry), 'grant "*" (reaches "gaia/evaluate")');
    assert.equal(sealedInClosure(await of([step("a", "agent", { agentTools: ["gaia/*"] })]), registry), 'grant "gaia/*" (reaches "gaia/evaluate")');
    assert.equal(sealedInClosure(await of([step("a", "agent", { agentTools: ["clip/*", "gaia/get-task"] })]), registry), null);
  });
});
