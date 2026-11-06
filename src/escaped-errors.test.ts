import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";

import { defineStep, flow, step, type StepRegistry } from "./core.js";
import { runWorkflow } from "./runner.js";
import { MemoryRunStore } from "./store.js";
import { guardEscapes, routeEscaped } from "./escaped-errors.js";

// An error a step lets ESCAPE — thrown in a callback, or from a promise it
// never awaits — used to end the process: the run's log stopped at
// `step.start`, it listed as stale, and boot's auto-resume replayed it into
// the same crash. The guard routes it to the step that started the work.
//
// In process, the tests call `routeEscaped` themselves (node:test has its own
// process handlers, which would fail the test on a real escape); the child
// process at the end proves the real handlers.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

describe("guardEscapes", () => {
  it("fails the call with an error routed from work it started", async () => {
    const call = guardEscapes("test", async () => {
      setTimeout(() => assert.equal(routeEscaped(new Error("from a timer"), "test"), true), 5);
      await sleep(500);
      return "never";
    });
    await quiet(() => assert.rejects(call, /from a timer/));
  });

  it("returns the work's own result and rejection untouched", async () => {
    assert.equal(await guardEscapes("test", () => 42), 42);
    await assert.rejects(
      guardEscapes("test", () => {
        throw new Error("thrown");
      }),
      /thrown/,
    );
  });

  it("owns nothing outside a guarded call", () => {
    assert.equal(routeEscaped(new Error("nobody's"), "test"), false);
  });

  it("only logs an escape after the call settled", async () => {
    let late: boolean | undefined;
    const result = await guardEscapes("test", async () => {
      setTimeout(() => (late = routeEscaped(new Error("too late"), "test")), 20);
      return "done";
    });
    assert.equal(result, "done");
    await quiet(() => sleep(50));
    assert.equal(late, true);
  });
});

describe("the runner", () => {
  const leaky = defineStep({
    type: "leaky",
    input: z.object({}),
    output: z.any(),
    async run() {
      // What the process handler does with a callback's throw.
      setTimeout(() => routeEscaped(new Error("escaped from a callback"), "test"), 5);
      await sleep(500);
      return "never";
    },
  });

  it("ends the run as an error with the escaped message", async () => {
    const store = new MemoryRunStore();
    const wf = flow("leaks", { input: z.any(), steps: [step("a", "leaky", {})] });
    const res = await quiet(() => runWorkflow(wf, {}, { leaky } as StepRegistry, { store }));
    assert.equal(res.status, "error");
    assert.match(res.error?.message ?? "", /escaped from a callback/);
    const types = store.getEvents("leaks", res.runId).map((e) => e.type);
    assert.deepEqual(types, ["run.start", "step.start", "step.error", "run.error"]);
  });

  it("retries a step that failed this way", async () => {
    let calls = 0;
    const flaky = defineStep({
      type: "flaky",
      input: z.object({}),
      output: z.any(),
      async run() {
        calls++;
        if (calls === 1) {
          setTimeout(() => routeEscaped(new Error("first attempt escaped"), "test"), 5);
          await sleep(500);
        }
        return calls;
      },
    });
    const wf = flow("retries", { input: z.any(), steps: [step("a", "flaky", {}, { retry: { max: 1 } })] });
    const res = await quiet(() => runWorkflow(wf, {}, { flaky } as StepRegistry, { store: new MemoryRunStore() }));
    assert.equal(res.status, "success");
    assert.equal(res.output, 2);
  });
});

describe("the process handlers", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const url = (rel: string) => pathToFileURL(path.join(ROOT, rel)).href;
  // The entry lives in a temp dir, where a bare "zod" resolves to nothing.
  const zod = pathToFileURL(createRequire(path.join(ROOT, "package.json")).resolve("zod")).href;

  it("keep the process up and fail each step that leaked", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strut-escapes-"));
    const entry = path.join(dir, "leak.mts");
    writeFileSync(
      entry,
      `
import { z } from ${JSON.stringify(zod)};
import { runWorkflow } from ${JSON.stringify(url("src/runner.ts"))};
import { MemoryRunStore } from ${JSON.stringify(url("src/store.ts"))};
import { defineStep, flow, step } from ${JSON.stringify(url("src/core.ts"))};
import { installEscapeGuard } from ${JSON.stringify(url("src/escaped-errors.ts"))};
import { EventEmitter } from "node:events";
installEscapeGuard();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leak = defineStep({
  type: "leak",
  input: z.object({ how: z.string() }),
  output: z.any(),
  async run({ how }) {
    if (how === "callback") setTimeout(() => { throw new Error("thrown in a callback"); }, 5);
    if (how === "unawaited") void Promise.reject(new Error("rejected, never awaited"));
    if (how === "emitter") { const e = new EventEmitter(); setTimeout(() => e.emit("error", new Error("emitter error")), 5); }
    if (how !== "none") await sleep(1_000);
    return "ok";
  },
});
const out = {};
for (const how of ["callback", "unawaited", "emitter", "none"]) {
  const wf = flow("leak-" + how, { input: z.any(), steps: [step("a", "leak", { how })] });
  const res = await runWorkflow(wf, {}, { leak }, { store: new MemoryRunStore() });
  out[how] = { status: res.status, message: res.error?.message };
}
console.log("RESULT " + JSON.stringify(out));
`,
    );
    try {
      const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(code, 0, stderr);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      assert.ok(line, `no result line:\n${stdout}\n${stderr}`);
      assert.deepEqual(JSON.parse(line.slice("RESULT ".length)), {
        callback: { status: "error", message: "thrown in a callback" },
        unawaited: { status: "error", message: "rejected, never awaited" },
        emitter: { status: "error", message: "emitter error" },
        none: { status: "success" },
      });
      assert.match(stderr, /step "leak-callback\/a": an error escaped it \(uncaught exception\)/);
      assert.match(stderr, /step "leak-unawaited\/a": an error escaped it \(unhandled rejection\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
