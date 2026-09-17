import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Flow, Step, RunEvent } from "./core.js";
import { defineStep } from "./core.js";
import { closureIncludes, flowClosure, globToRegExp, stepHashesFor, walkSteps } from "./closure.js";
import { runWorkflow } from "./runner.js";
import { MemoryRunStore } from "./store.js";

const step = (id: string, type: string, config: Record<string, unknown> = {}, options?: Step["options"]): Step => ({ id, type, config, ...(options ? { options } : {}) });
const flow = (name: string, steps: Step[]): Flow => ({ name, input: z.any(), steps });

/** A resolver over a fixed set of flows; `wf@v2` keys a specific version. */
const resolver = (flows: Record<string, Flow>) => ({
  getWorkflow: async (name: string) => flows[name] ?? Promise.reject(new Error(`no ${name}`)),
  getWorkflowVersion: async (name: string, version: string) => flows[`${name}@${version}`] ?? Promise.reject(new Error(`no ${name}@${version}`)),
});

describe("flowClosure", () => {
  it("walks loop/foreach bodies and onError handlers", () => {
    const seen: string[] = [];
    walkSteps(
      [
        step("a", "clip/fetch", {}, { onError: step("fix", "log") }),
        step("each", "foreach", { body: step("b", "loop", { body: step("c", "clip/trim") }) }),
        step("notbody", "exec", { body: step("x", "never/visited") }),
      ],
      (s) => seen.push(s.type),
    );
    assert.deepEqual(seen, ["clip/fetch", "log", "foreach", "loop", "clip/trim", "exec"]);
  });

  it("follows nested subflows through the workspace, pinned versions included, cycles tolerated", async () => {
    const flows = {
      child: flow("child", [step("s", "stt/transcribe"), step("again", "subflow", { workflow: "parent" })]),
      "pinned@v2": flow("pinned", [step("j", "llm")]),
      parent: flow("parent", [step("c", "subflow", { workflow: "child" }), step("p", "subflow", { workflow: "pinned", version: "v2" })]),
    };
    const c = await flowClosure(flows.parent, resolver(flows));
    assert.deepEqual([...c.types].sort(), ["llm", "stt/transcribe", "subflow"]);
    // Depth-first: child, then what child reaches (back to parent — visited once), then pinned.
    assert.deepEqual(c.workflows, [{ workflow: "child" }, { workflow: "parent" }, { workflow: "pinned", version: "v2" }]);
    assert.equal(c.resolvable, true);
  });

  it("collects agentTools grants verbatim; closureIncludes expands globs", async () => {
    const c = await flowClosure(flow("f", [step("a", "agent", { agentTools: ["clip/*", "http"] })]));
    assert.deepEqual([...c.agentTools], ["clip/*", "http"]);
    assert.ok(closureIncludes(c, "agent") && closureIncludes(c, "http") && closureIncludes(c, "clip/trim"));
    assert.ok(!closureIncludes(c, "clipper/trim") && !closureIncludes(c, "gaia/evaluate"));
    assert.ok(globToRegExp("meta/*").test("meta/run-step") && !globToRegExp("meta/*").test("xmeta/run"));
  });

  it("a templated or missing child, or templated agentTools, makes it unresolvable — what was found is kept", async () => {
    const templated = await flowClosure(flow("f", [step("a", "exec"), step("s", "subflow", { workflow: "{{ input.name }}" })]), resolver({}));
    assert.deepEqual([templated.resolvable, [...templated.types].sort()], [false, ["exec", "subflow"]]);
    assert.equal((await flowClosure(flow("f", [step("s", "subflow", { workflow: "gone" })]), resolver({}))).resolvable, false);
    assert.equal((await flowClosure(flow("f", [step("s", "subflow", { workflow: "child", version: "{{ params.v }}" })]), resolver({}))).resolvable, false);
    assert.equal((await flowClosure(flow("f", [step("s", "subflow", { workflow: "child" })]))).resolvable, false, "no workspace to resolve through");
    assert.equal((await flowClosure(flow("f", [step("a", "agent", { agentTools: "{{ params.tools }}" })]))).resolvable, false);
    assert.equal((await flowClosure(flow("f", [step("a", "agent", { agentTools: ["{{ params.ns }}/*"] })]))).resolvable, false);
  });
});

describe("stepHashesFor", () => {
  const active = { "clip/fetch": "aaaaaaaaaaaa", "clip/trim": "bbbbbbbbbbbb", "stt/transcribe": "cccccccccccc", "other/unused": "dddddddddddd" };
  const ws = (flows: Record<string, Flow>) => ({ ...resolver(flows), getActiveStepHashes: async () => active });

  it("records exactly the workspace steps in reach — by name, through a subflow, or granted to an agent", async () => {
    const flows = { child: flow("child", [step("s", "stt/transcribe")]) };
    const f = flow("f", [step("a", "clip/fetch"), step("c", "subflow", { workflow: "child" }), step("g", "agent", { agentTools: ["clip/tr*"] }), step("h", "http")]);
    assert.deepEqual(await stepHashesFor(ws(flows), f), { "clip/fetch": "aaaaaaaaaaaa", "clip/trim": "bbbbbbbbbbbb", "stt/transcribe": "cccccccccccc" });
  });

  it("an unresolvable closure records every active hash — a superset is still true, a subset loses a version", async () => {
    assert.deepEqual(await stepHashesFor(ws({}), flow("f", [step("s", "subflow", { workflow: "{{ input.wf }}" })])), active);
  });

  it("built-in-only flows, an empty workspace, no workspace, or a failing read → undefined (the run still launches)", async () => {
    assert.equal(await stepHashesFor(ws({}), flow("f", [step("h", "http")])), undefined);
    assert.equal(await stepHashesFor({ ...resolver({}), getActiveStepHashes: async () => ({}) }, flow("f", [step("a", "clip/fetch")])), undefined);
    assert.equal(await stepHashesFor(undefined, flow("f", [step("a", "clip/fetch")])), undefined);
    const err = console.error;
    console.error = () => {};
    try {
      assert.equal(await stepHashesFor({ ...resolver({}), getActiveStepHashes: async () => Promise.reject(new Error("down")) }, flow("f", [step("a", "clip/fetch")])), undefined);
    } finally {
      console.error = err;
    }
  });
});

describe("run.start carries stepHashes / cassette / origin", () => {
  const noop = defineStep({ type: "noop", input: z.any(), output: z.any(), run: async () => ({ ok: true }) });
  const run = async (opts: Parameters<typeof runWorkflow>[3]) => {
    const events: RunEvent[] = [];
    await runWorkflow(flow("wf", [step("a", "noop")]), {}, { noop } as never, { store: new MemoryRunStore(), onEvent: (e) => void events.push(e), ...opts });
    return events;
  };

  it("all three land on run.start, and are absent when not given", async () => {
    const start = (await run({ stepHashes: { noop: "abc" }, cassette: "replay", origin: "verify" })).find((e) => e.type === "run.start")!;
    assert.deepEqual([start.stepHashes, start.cassette, start.origin], [{ noop: "abc" }, "replay", "verify"]);
    const bare = (await run({})).find((e) => e.type === "run.start")!;
    assert.ok(!("stepHashes" in bare) && !("cassette" in bare) && !("origin" in bare));
  });

  it("a resume re-records stepHashes on run.resumed — steps load at relaunch", async () => {
    const events = await run({ resume: true, journal: {}, stepHashes: { noop: "def" } });
    assert.equal(events.find((e) => e.type === "run.start"), undefined);
    assert.deepEqual(events.find((e) => e.type === "run.resumed")!.stepHashes, { noop: "def" });
  });
});
