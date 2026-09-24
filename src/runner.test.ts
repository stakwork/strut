import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { flow, step, defineStep, withMessages, type Step, type StepRegistry, type RunEvent } from "./core.js";
import { flowFromYaml } from "./workspace.js";
import { runWorkflow } from "./runner.js";
import { MemoryRunStore } from "./store.js";
import foreachStep from "./steps/core/foreach.js";

// ── Test helpers ───────────────────────────────────────────────────────────

/** A simple step that returns its config as output. */
const echoStep = defineStep({
  type: "echo",
  input: z.any(),
  output: z.any(),
  async run(cfg) {
    return cfg;
  },
});

/** A step that returns a fixed value. */
const valueStep = defineStep({
  type: "value",
  input: z.object({ result: z.any() }),
  output: z.any(),
  async run(cfg) {
    return cfg.result;
  },
});

/** A step that always throws. */
const failStep = defineStep({
  type: "fail",
  input: z.object({ message: z.string().default("step failed") }),
  output: z.any(),
  async run(cfg) {
    throw new Error(cfg.message);
  },
});

/** A step that counts how many times it's been called (stateful). */
function createCounterStep() {
  let count = 0;
  return defineStep({
    type: "counter",
    input: z.any(),
    output: z.number(),
    async run() {
      count++;
      return count;
    },
  });
}

/** A step that fails the first N times, then succeeds. */
function createFlakeyStep(failCount: number) {
  let attempts = 0;
  return defineStep({
    type: "flakey",
    input: z.any(),
    output: z.any(),
    async run(cfg) {
      attempts++;
      if (attempts <= failCount) {
        throw new Error(`Attempt ${attempts} failed`);
      }
      return { attempts, ...(cfg ?? {}) };
    },
  });
}

function makeRegistry(extra: Record<string, any> = {}): StepRegistry {
  return {
    echo: echoStep,
    value: valueStep,
    fail: failStep,
    ...extra,
  } as StepRegistry;
}

function eventTypes(store: MemoryRunStore, workflow: string, runId: string): string[] {
  return store.getEvents(workflow, runId).map((e) => e.type);
}

function eventsOfType(
  store: MemoryRunStore,
  workflow: string,
  runId: string,
  type: string,
): RunEvent[] {
  return store.getEvents(workflow, runId).filter((e) => e.type === type);
}

// ── Basic execution ────────────────────────────────────────────────────────

describe("runWorkflow - basic execution", () => {
  it("runs a single-step workflow", async () => {
    const wf = flow("simple", {
      input: z.object({ msg: z.string() }),
      steps: [step("echo", "echo", { message: "{{ input.msg }}" })],
    });

    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, { msg: "hello" }, makeRegistry(), {
      runId: "test-1",
      store,
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { message: "hello" });
    assert.equal(result.runId, "test-1");
  });

  it("runs sequential steps with scope propagation", async () => {
    const wf = flow("sequential", {
      input: z.object({ x: z.number() }),
      steps: [
        step("first", "value", { result: "{{ input.x }}" }),
        step("second", "echo", { prev: "{{ first }}", doubled: "{{ input.x + input.x }}" }),
      ],
    });

    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, { x: 21 }, makeRegistry(), {
      runId: "test-2",
      store,
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { prev: 21, doubled: 42 });
  });

  it("output is the last step's output", async () => {
    const wf = flow("multi", {
      input: z.object({}),
      steps: [
        step("a", "value", { result: "first" }),
        step("b", "value", { result: "second" }),
        step("c", "value", { result: "third" }),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal(result.output, "third");
  });

  it("empty workflow returns undefined", async () => {
    const wf = flow("empty", { input: z.object({}), steps: [] });
    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal(result.status, "success");
    assert.equal(result.output, undefined);
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("runWorkflow - input validation", () => {
  it("validates input against flow schema", async () => {
    const wf = flow("typed", {
      input: z.object({ name: z.string(), age: z.number() }),
      steps: [step("echo", "echo", { name: "{{ input.name }}" })],
    });

    const result = await runWorkflow(wf, { name: "Alice", age: 30 }, makeRegistry());
    assert.equal(result.status, "success");
  });

  it("returns error on invalid input", async () => {
    const wf = flow("typed", {
      input: z.object({ name: z.string(), age: z.number() }),
      steps: [step("echo", "echo", {})],
    });

    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, { name: "Alice" }, makeRegistry(), {
      runId: "bad-input",
      store,
    });

    assert.equal(result.status, "error");
    assert.ok(result.error?.message.includes("Input validation failed"));
  });

  it("a YAML contract fails a missing required field before any step, with no run.start", async () => {
    const wf = flowFromYaml(
      "contract",
      "v1",
      "name: contract\ninput:\n  city:\n    type: string\n    required: true\nsteps:\n  - id: a\n    type: log\n    config:\n      message: hi\n",
    );
    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, {}, makeRegistry(), { runId: "missing", store });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /^Input validation failed/);
    const types = eventTypes(store, "contract", "missing");
    assert.deepEqual(types, ["run.error"]);
  });

  it("journals the stripped contract input, and a no-block workflow keeps extras", async () => {
    const declared = flowFromYaml(
      "contract",
      "v1",
      `name: contract
input:
  city:
    type: string
    required: true
steps:
  - id: a
    type: echo
    config:
      seen: "{{ input }}"
`,
    );
    const store = new MemoryRunStore();
    const result = await runWorkflow(declared, { city: "Lima", extra: 1 }, makeRegistry(), { runId: "stripped", store });
    assert.equal(result.status, "success", JSON.stringify(result.error));
    const start = (await store.getRunEvents("contract", "stripped")).find((e) => e.type === "run.start");
    assert.deepEqual(start?.input, { city: "Lima" });

    const open = flowFromYaml("open", "v1", "name: open\nsteps:\n  - id: a\n    type: echo\n    config:\n      message: hi\n");
    const kept = await runWorkflow(open, { extra: 1 }, makeRegistry(), { runId: "open", store });
    assert.equal(kept.status, "success");
    const openStart = (await store.getRunEvents("open", "open")).find((e) => e.type === "run.start");
    assert.deepEqual(openStart?.input, { extra: 1 });
  });

  it("emits run.error event on input validation failure", async () => {
    const wf = flow("typed", {
      input: z.object({ required: z.string() }),
      steps: [step("echo", "echo", {})],
    });

    const store = new MemoryRunStore();
    await runWorkflow(wf, {}, makeRegistry(), {
      runId: "val-err",
      store,
    });

    const types = eventTypes(store, "typed", "val-err");
    assert.ok(types.includes("run.error"));
    assert.ok(!types.includes("run.start"));
  });
});

// ── Event logging ──────────────────────────────────────────────────────────

describe("runWorkflow - event logging", () => {
  it("emits run.start, step.start, step.end, run.end for success", async () => {
    const wf = flow("logged", {
      input: z.object({}),
      steps: [step("a", "value", { result: 1 })],
    });

    const store = new MemoryRunStore();
    await runWorkflow(wf, {}, makeRegistry(), {
      runId: "log-1",
      store,
    });

    const types = eventTypes(store, "logged", "log-1");
    assert.deepEqual(types, [
      "run.start",
      "step.start",
      "step.end",
      "run.end",
    ]);
  });

  it("a scheduled run is stamped on run.start, on the summary (success AND error), and in onRunEnd", async () => {
    const store = new MemoryRunStore();
    const ended: unknown[] = [];
    const opts = (runId: string) => ({
      runId,
      store,
      origin: "schedule" as const,
      automation: { id: "a-1" },
      services: { onRunEnd: (_id: string, info: unknown) => void ended.push(info) },
    });
    const ok = flow("sched", { input: z.object({}), steps: [step("a", "value", { result: 1 })] });
    await runWorkflow(ok, {}, makeRegistry(), opts("s-1"));
    const start = store.events.get("sched/s-1")!.find((e) => e.type === "run.start")!;
    assert.deepEqual([start.origin, start.automation], ["schedule", { id: "a-1" }]);
    assert.deepEqual((await store.getRunSummary("sched", "s-1"))?.automation, { id: "a-1" });

    const bad = flow("sched", { input: z.object({}), steps: [step("a", "fail", {})] });
    await runWorkflow(bad, {}, makeRegistry(), opts("s-2"));
    const failed = await store.getRunSummary("sched", "s-2");
    assert.deepEqual([failed?.status, failed?.automation], ["error", { id: "a-1" }]);
    assert.deepEqual(ended, [{ workflow: "sched", origin: "schedule" }, { workflow: "sched", origin: "schedule" }]);

    await runWorkflow(ok, {}, makeRegistry(), { runId: "s-3", store });
    assert.equal((await store.getRunSummary("sched", "s-3"))?.automation, undefined, "an ordinary run carries no stamp");
  });

  it("emits step events with correct paths", async () => {
    const wf = flow("paths", {
      input: z.object({}),
      steps: [
        step("a", "value", { result: 1 }),
        step("b", "value", { result: 2 }),
      ],
    });

    const store = new MemoryRunStore();
    await runWorkflow(wf, {}, makeRegistry(), {
      runId: "log-2",
      store,
    });

    const starts = eventsOfType(store, "paths", "log-2", "step.start");
    assert.equal(starts[0]!.path, "paths/a");
    assert.equal(starts[1]!.path, "paths/b");
  });

  it("emits step.error and run.error on failure", async () => {
    const wf = flow("failing", {
      input: z.object({}),
      steps: [step("boom", "fail", { message: "kaboom" })],
    });

    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, {}, makeRegistry(), {
      runId: "log-3",
      store,
    });

    assert.equal(result.status, "error");
    const types = eventTypes(store, "failing", "log-3");
    assert.ok(types.includes("step.start"));
    assert.ok(types.includes("step.error"));
    assert.ok(types.includes("run.error"));
  });

  it("writes run summary on success", async () => {
    const wf = flow("summary", {
      input: z.object({}),
      steps: [step("a", "value", { result: "done" })],
    });

    const store = new MemoryRunStore();
    await runWorkflow(wf, {}, makeRegistry(), {
      runId: "sum-1",
      store,
    });

    const summary = store.getSummary("summary", "sum-1");
    assert.ok(summary);
    assert.equal(summary!.status, "success");
    assert.equal(summary!.workflow, "summary");
    assert.equal(summary!.output, "done");
    assert.ok(summary!.durationMs >= 0);
  });

  it("writes run summary on error", async () => {
    const wf = flow("err-summary", {
      input: z.object({}),
      steps: [step("boom", "fail", {})],
    });

    const store = new MemoryRunStore();
    await runWorkflow(wf, {}, makeRegistry(), {
      runId: "sum-2",
      store,
    });

    const summary = store.getSummary("err-summary", "sum-2");
    assert.ok(summary);
    assert.equal(summary!.status, "error");
    assert.ok(summary!.error?.message);
  });
});

// ── Retry ──────────────────────────────────────────────────────────────────

describe("runWorkflow - retry", () => {
  it("retries on failure and succeeds", async () => {
    const flakey = createFlakeyStep(2); // fails first 2 attempts
    const wf = flow("retry-ok", {
      input: z.object({}),
      steps: [
        step("s", "flakey", {}, { retry: { max: 3, delayMs: 0 } }),
      ],
    });

    const store = new MemoryRunStore();
    const result = await runWorkflow(
      wf,
      {},
      makeRegistry({ flakey }) as StepRegistry,
      { runId: "retry-1", store },
    );

    assert.equal(result.status, "success");
    assert.equal((result.output as any).attempts, 3);

    // Should have retry events
    const retries = eventsOfType(store, "retry-ok", "retry-1", "step.retry");
    assert.equal(retries.length, 2);
  });

  it("fails after exhausting retries", async () => {
    const flakey = createFlakeyStep(5); // fails 5 times, we only retry 2
    const wf = flow("retry-fail", {
      input: z.object({}),
      steps: [
        step("s", "flakey", {}, { retry: { max: 2, delayMs: 0 } }),
      ],
    });

    const result = await runWorkflow(
      wf,
      {},
      makeRegistry({ flakey }) as StepRegistry,
    );
    assert.equal(result.status, "error");
  });
});

// ── onError fallback ───────────────────────────────────────────────────────

describe("runWorkflow - onError", () => {
  it("executes fallback step on error", async () => {
    const wf = flow("fallback", {
      input: z.object({}),
      steps: [
        step(
          "risky",
          "fail",
          { message: "oops" },
          { onError: step("recover", "value", { result: "recovered" }) },
        ),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal(result.status, "success");
    assert.equal(result.output, "recovered");
  });

  it("fallback has access to $error", async () => {
    const wf = flow("fallback-error", {
      input: z.object({}),
      steps: [
        step(
          "risky",
          "fail",
          { message: "something broke" },
          {
            onError: step("recover", "echo", {
              errorMsg: "{{ $error.message }}",
            }),
          },
        ),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal(result.status, "success");
    assert.equal((result.output as any).errorMsg, "something broke");
  });

  it("$error.cause flattens the cause chain (the socket reason behind a wrapped failure)", async () => {
    // A severed stream throws a bare "terminated"; the reason it died is only
    // on the cause. Without this, an onError handler records the symptom and
    // loses the diagnosis.
    const throwWithCause = defineStep({
      type: "boom",
      input: z.object({}),
      run: async () => {
        throw new Error("terminated", {
          cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        });
      },
    });
    const wf = flow("cause-chain", {
      input: z.object({}),
      steps: [
        step("risky", "boom", {}, {
          onError: step("recover", "echo", {
            msg: "{{ $error.message }}",
            cause: "{{ $error.cause }}",
          }),
        }),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry({ boom: throwWithCause }));
    assert.equal(result.status, "success");
    assert.equal((result.output as any).msg, "terminated");
    assert.equal((result.output as any).cause, "ECONNRESET: socket hang up");
  });

  it("$error.cause is empty when there is no cause", async () => {
    const wf = flow("no-cause", {
      input: z.object({}),
      steps: [
        step("risky", "fail", { message: "plain" }, {
          onError: step("recover", "echo", { cause: "{{ $error.cause }}" }),
        }),
      ],
    });
    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal((result.output as any).cause, "");
  });

  it("retry + onError: fallback runs after retries exhausted", async () => {
    const flakey = createFlakeyStep(10); // never succeeds
    const wf = flow("retry-then-fallback", {
      input: z.object({}),
      steps: [
        step(
          "s",
          "flakey",
          {},
          {
            retry: { max: 2, delayMs: 0 },
            onError: step("recover", "value", { result: "fallback" }),
          },
        ),
      ],
    });

    const result = await runWorkflow(
      wf,
      {},
      makeRegistry({ flakey }) as StepRegistry,
    );
    assert.equal(result.status, "success");
    assert.equal(result.output, "fallback");
  });
});

// ── Unknown step type ──────────────────────────────────────────────────────

describe("runWorkflow - unknown step type", () => {
  it("fails with unknown step type", async () => {
    const wf = flow("unknown", {
      input: z.object({}),
      steps: [step("s", "nonexistent", {})],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal(result.status, "error");
    assert.ok(result.error?.message.includes("nonexistent"));
  });
});

// ── Template resolution in runner ──────────────────────────────────────────

describe("runWorkflow - template resolution", () => {
  it("resolves input references", async () => {
    const wf = flow("templates", {
      input: z.object({ url: z.string() }),
      steps: [step("fetch", "echo", { target: "{{ input.url }}" })],
    });

    const result = await runWorkflow(wf, { url: "/api" }, makeRegistry());
    assert.deepEqual(result.output, { target: "/api" });
  });

  it("resolves references to previous step outputs", async () => {
    const wf = flow("chain", {
      input: z.object({}),
      steps: [
        step("first", "value", { result: { data: 42 } }),
        step("second", "echo", { value: "{{ first.data }}" }),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.deepEqual(result.output, { value: 42 });
  });

  it("resolves complex expression in template", async () => {
    const wf = flow("expr", {
      input: z.object({ a: z.number(), b: z.number() }),
      steps: [
        step("sum", "echo", { total: "{{ input.a + input.b }}" }),
      ],
    });

    const result = await runWorkflow(wf, { a: 3, b: 7 }, makeRegistry());
    assert.deepEqual(result.output, { total: 10 });
  });

  it("resolves multi-segment templates", async () => {
    const wf = flow("multi-seg", {
      input: z.object({ service: z.string() }),
      steps: [
        step("msg", "echo", {
          text: "deployed {{ input.service }} successfully",
        }),
      ],
    });

    const result = await runWorkflow(
      wf,
      { service: "api" },
      makeRegistry(),
    );
    assert.deepEqual(result.output, {
      text: "deployed api successfully",
    });
  });
});

// ── params (tunable knobs) ──────────────────────────────────────────────────

describe("runWorkflow - params", () => {
  it("exposes flow.params defaults to step configs via {{ params.* }}", async () => {
    const wf = flow("with-params", {
      input: z.object({}),
      params: { greeting: "hello", max: 5 },
      steps: [
        step("echo", "echo", {
          msg: "{{ params.greeting }}",
          n: "{{ params.max }}",
        }),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { msg: "hello", n: 5 });
  });

  it("run-level params override defaults per-key (shallow merge)", async () => {
    const wf = flow("override", {
      input: z.object({}),
      params: { greeting: "hello", max: 5 },
      steps: [
        step("echo", "echo", {
          msg: "{{ params.greeting }}",
          n: "{{ params.max }}",
        }),
      ],
    });

    const result = await runWorkflow(wf, {}, makeRegistry(), {
      params: { greeting: "bonjour" }, // only override one knob
    });
    assert.deepEqual(result.output, { msg: "bonjour", n: 5 });
  });

  it("params and input are independent scopes", async () => {
    const wf = flow("split", {
      input: z.object({ prNumber: z.number() }),
      params: { prompt: "review" },
      steps: [
        step("echo", "echo", {
          subject: "{{ input.prNumber }}",
          knob: "{{ params.prompt }}",
        }),
      ],
    });

    const result = await runWorkflow(wf, { prNumber: 42 }, makeRegistry(), {
      params: { prompt: "audit" },
    });
    assert.deepEqual(result.output, { subject: 42, knob: "audit" });
  });

  it("params default to {} when the flow declares none", async () => {
    const wf = flow("no-params", {
      input: z.object({}),
      steps: [step("echo", "echo", { has: "{{ params }}" })],
    });

    const result = await runWorkflow(wf, {}, makeRegistry());
    assert.deepEqual(result.output, { has: {} });
  });
});

// ── Transcript marker (withMessages → step.end.messages) ───────────────────

describe("step.end carries a step's session marker as `messages`", () => {
  const session = [
    { role: "system", content: "s" },
    { role: "user", content: "p" },
    { role: "assistant", content: "a" },
  ];
  /** A step that returns a slim output marked with the session behind it. */
  const talker = defineStep({
    type: "talker",
    input: z.object({ n: z.any().optional() }),
    output: z.any(),
    async run(cfg) {
      return withMessages({ result: `done ${cfg.n ?? ""}`.trim() }, session);
    },
  });

  it("lifts the marker onto step.end and keeps it out of the output, the scope and the summary", async () => {
    const wf = flow("talk", {
      input: z.object({}),
      steps: [step("t", "talker", {}), step("after", "echo", { got: "{{ t }}" })],
    });
    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, {}, makeRegistry({ talker }), { store });
    assert.equal(result.status, "success");
    const events = await store.getRunEvents("talk", result.runId);
    const end = events.find((e) => e.type === "step.end" && e.path === "talk/t")!;
    assert.deepEqual(end.messages, session);
    assert.equal(JSON.stringify(end.output), '{"result":"done"}');
    // Downstream steps see the plain output; the summary has no transcript.
    assert.deepEqual(result.output, { got: { result: "done" } });
    assert.ok(!JSON.stringify(await store.getRunSummary("talk", result.runId)).includes("assistant"));
    const after = events.find((e) => e.type === "step.end" && e.path === "talk/after")!;
    assert.ok(!("messages" in after), "an unmarked output emits no messages field");
  });

  it("lifts it on foreach iterations too (the body's step.end is the iteration's)", async () => {
    const wf = flow("talk-each", {
      input: z.object({ items: z.array(z.number()) }),
      steps: [
        step("each", "foreach", {
          items: "{{ input.items }}",
          body: step("t", "talker", { n: "{{ $current }}" }),
        }),
      ],
    });
    const store = new MemoryRunStore();
    const result = await runWorkflow(wf, { items: [1, 2] }, makeRegistry({ talker, foreach: foreachStep }), { store });
    assert.equal(result.status, "success");
    const ends = (await store.getRunEvents("talk-each", result.runId)).filter(
      (e) => e.type === "step.end" && e.stepType === "talker",
    );
    assert.equal(ends.length, 2);
    for (const e of ends) assert.deepEqual(e.messages, session);
    assert.deepEqual(result.output, [{ result: "done 1" }, { result: "done 2" }]);
  });
});

// ── ctx.onRunEnd ───────────────────────────────────────────────────────────

const mk = (name: string, input: z.ZodTypeAny, ...steps: Step[]) => flow(name, { input, steps });

describe("ctx.onRunEnd", () => {
  /** A step that registers a disposer recording its name + the info it got. */
  function disposerStep(log: string[]) {
    return defineStep({
      type: "alloc",
      input: z.object({ name: z.string(), fail: z.boolean().default(false), throwOnDispose: z.boolean().default(false) }),
      output: z.any(),
      async run(cfg, ctx) {
        ctx.onRunEnd?.((info) => {
          if (cfg.throwOnDispose) throw new Error(`dispose ${cfg.name} failed`);
          log.push(`dispose:${cfg.name}:${info.workflow}`);
        });
        log.push(`run:${cfg.name}`);
        if (cfg.fail) throw new Error("step failed");
        return cfg.name;
      },
    });
  }

  it("runs every registered disposer once, newest first, before the bag's onRunEnd — on success", async () => {
    const log: string[] = [];
    const registry = { alloc: disposerStep(log) } as StepRegistry;
    const wf = mk("wf", z.object({}), step("a", "alloc", { name: "a" }), step("b", "alloc", { name: "b" }));
    const res = await runWorkflow(wf, {}, registry, {
      services: { onRunEnd: async (id: string, info: { workflow: string }) => void log.push(`bag:${info.workflow}`) },
    });
    assert.equal(res.status, "success");
    assert.deepEqual(log, ["run:a", "run:b", "dispose:b:wf", "dispose:a:wf", "bag:wf"]);
  });

  it("runs disposers on error too, and a throwing disposer neither masks the result nor blocks the others", async () => {
    const log: string[] = [];
    const registry = { alloc: disposerStep(log) } as StepRegistry;
    const wf = mk(
      "wf",
      z.object({}),
      step("a", "alloc", { name: "a", throwOnDispose: true }),
      step("b", "alloc", { name: "b", fail: true }),
    );
    const res = await runWorkflow(wf, {}, registry, {});
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /step failed/);
    // b registered its disposer before throwing; a's disposer throws and is skipped, not fatal.
    assert.deepEqual(log, ["run:a", "run:b", "dispose:b:wf"]);
  });

  it("subflow steps register into the parent run's list", async () => {
    const log: string[] = [];
    const registry = { alloc: disposerStep(log) } as StepRegistry;
    const child = mk("child", z.object({}), step("c", "alloc", { name: "c" }));
    const parent = mk("parent", z.object({}), step("sub", "subflow", { workflow: "child", input: {} }));
    const res = await runWorkflow(parent, {}, registry, {
      workspace: { getWorkflow: async () => child } as never,
    });
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.deepEqual(log, ["run:c", "dispose:c:parent"]);
  });
});
