import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { WorkerEmbedder } from "./embeddings.js";
import type { Embedder } from "./node-writer.js";

// A stand-in for MiniLM: vector = [text length, the thread that computed
// it]; `busyMs` holds its thread the way onnxruntime's synchronous run does.
const FAKE = `data:text/javascript,${encodeURIComponent(`
import { threadId } from "node:worker_threads";
export async function load(o = {}) {
  if (o.failLoad) throw new Error("no model here");
  return {
    async embed(texts) {
      if (texts.includes("__exit__")) process.exit(3);
      if (texts.includes("__throw__")) throw new Error("bad text");
      const end = Date.now() + (o.busyMs ?? 0);
      while (Date.now() < end) {}
      return texts.map((t) => [t.length, threadId]);
    },
  };
}`)}`;

/** The longest the event loop went without running a 5 ms interval while `work` ran. */
async function maxLag(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return Math.max(max, performance.now() - last);
}

describe("WorkerEmbedder", () => {
  const open: WorkerEmbedder[] = [];
  const make = (options?: Record<string, unknown>, factory = "load") => {
    const w = new WorkerEmbedder({ module: FAKE, factory, options });
    open.push(w);
    return w;
  };
  after(async () => {
    await Promise.all(open.map((w) => w.close()));
  });

  it("embeds in a worker thread, the vectors in order", async () => {
    const w = make();
    const vectors = await w.embed(["a", "bcd"]);
    assert.deepEqual(vectors.map((v) => v[0]), [1, 3]);
    assert.notEqual(vectors[0]![1], threadId, "computed off the main thread");
    assert.deepEqual(await w.embed([]), []);
  });

  it("leaves the event loop free while the model holds its thread — inline, it would not", async () => {
    const w = make({ busyMs: 400 });
    await w.embed(["warm up"]);
    const inWorker = await maxLag(() => w.embed(["x"]));
    const inline = (await (await import(FAKE)).load({ busyMs: 400 })) as Embedder;
    const onMain = await maxLag(() => inline.embed(["x"]));
    assert.ok(onMain >= 350, `inline: the loop stalled ${onMain.toFixed(0)} ms`);
    assert.ok(inWorker < 150, `worker: the loop stalled ${inWorker.toFixed(0)} ms`);
  });

  it("a factory that throws, or is missing, fails the call with why", async () => {
    await assert.rejects(make({ failLoad: true }).embed(["a"]), /embedding worker: no model here/);
    await assert.rejects(make({}, "nope").embed(["a"]), /exports no function nope/);
  });

  it("an error inside embed fails that call alone", async () => {
    const w = make();
    const [before] = await w.embed(["a"]);
    await assert.rejects(w.embed(["__throw__"]), /embedding worker: bad text/);
    const [again] = await w.embed(["a"]);
    assert.equal(again![1], before![1], "the same worker");
  });

  it("a worker that dies fails its calls in flight, and the next call starts another", async () => {
    const w = make();
    const [before] = await w.embed(["a"]);
    await assert.rejects(w.embed(["__exit__"]), /embedding worker exited with code 3/);
    const [again] = await w.embed(["a"]);
    assert.equal(again![0], 1);
    assert.notEqual(again![1], before![1], "a new worker");
  });
});
