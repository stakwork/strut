import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { ModelWorker } from "./model-worker.js";

// A stand-in for a model with state: a counter, an echo that says which
// thread ran it, and a method that sums a buffer it was handed.
const FAKE = `data:text/javascript,${encodeURIComponent(`
import { threadId } from "node:worker_threads";
export function make(o = {}) {
  let n = o.start ?? 0;
  return {
    bump(by) { n += by; return n; },
    where() { return threadId; },
    async later(ms, v) { await new Promise((r) => setTimeout(r, ms)); return v; },
    sum(a) { return a.reduce((x, y) => x + y, 0); },
  };
}`)}`;

describe("ModelWorker", () => {
  const open: ModelWorker[] = [];
  const make = (options?: Record<string, unknown>) => {
    const w = new ModelWorker({ module: FAKE, factory: "make", options }, "test worker");
    open.push(w);
    return w;
  };
  after(async () => {
    await Promise.all(open.map((w) => w.close()));
  });

  it("calls the object's methods in its thread; what it keeps lasts across calls", async () => {
    const w = make({ start: 10 });
    assert.equal(await w.call("bump", [1]), 11);
    assert.equal(await w.call("bump", [5]), 16);
    assert.notEqual(await w.call("where"), threadId);
  });

  it("calls start in the order they were made, and their results come back to the right caller", async () => {
    const w = make();
    const results = await Promise.all([w.call("later", [40, "slow"]), w.call("bump", [1]), w.call("bump", [1])]);
    assert.deepEqual(results, ["slow", 1, 2]);
  });

  it("a transferred buffer moves to the worker; anything else is copied", async () => {
    const w = make();
    const moved = new Float32Array([1, 2, 3]);
    assert.equal(await w.call("sum", [moved], [moved.buffer]), 6);
    assert.equal(moved.length, 0, "the buffer moved");
    const copied = new Float32Array([4, 5]);
    assert.equal(await w.call("sum", [copied]), 9);
    assert.equal(copied.length, 2);
  });

  it("a method the object lacks fails that call, with the worker's label", async () => {
    const w = make();
    await assert.rejects(w.call("nope"), /test worker: no method nope/);
    assert.equal(await w.call("bump", [2]), 2, "the same worker, still there");
  });
});
