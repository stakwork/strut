import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { DictationFixer, within } from "./fixer.js";
import { parseRetractions } from "./fixer-engine.js";

// The fixer's lifecycle with a fake model in the worker: it loads on first
// use, follows the pick, and unloads when idle. The fake answers from its
// options, and says which model it is.
const FAKE = `data:text/javascript,${encodeURIComponent(`
export function make(o) {
  return {
    judge: async (qs) => qs.map(() => o.yes),
    score: async (ss) => ss.map((s) => s.text.length),
    retract: async () => [],
    ready: async () => {},
    which: async () => o.path,
    dispose: async () => {},
  };
}`)}`;

describe("DictationFixer", () => {
  const picked = (pick: { id: string; path: string } | null, idleMs?: number) => {
    let now = pick;
    const fixers = new DictationFixer({
      model: async () => now,
      spec: (m) => ({ module: FAKE, factory: "make", options: { path: m.path, yes: m.id === "qwen3-0.6b-q4" ? 2 : 1 } }),
      ...(idleMs !== undefined ? { idleMs } : {}),
    });
    return { fixers, pick: (p: typeof pick) => (now = p) };
  };

  it("none picked or installed: no fixer", async () => {
    const { fixers } = picked(null);
    assert.equal(await fixers.current(), null);
    assert.equal(fixers.active, null);
  });

  it("calls the picked model in its worker, with the catalog's learn margin", async () => {
    const { fixers } = picked({ id: "qwen3-0.6b-q4", path: "/m/small.gguf" });
    const f = (await fixers.current())!;
    assert.deepEqual([f.id, f.learnMargin], ["qwen3-0.6b-q4", 1]);
    assert.deepEqual(await f.judge([{ typed: "a", edited: "b", from: "a", to: "b", known: "" }]), [2]);
    assert.deepEqual(await f.score([{ name: "X", type: "Lingo", text: "abc" }]), [3]);
    await fixers.close();
  });

  it("follows the pick: another model is another worker, none unloads it", async () => {
    const { fixers, pick } = picked({ id: "qwen3-0.6b-q4", path: "/m/small.gguf" });
    await (await fixers.current())!.ready();
    pick({ id: "qwen3-1.7b-q4", path: "/m/large.gguf" });
    const large = (await fixers.current())!;
    assert.deepEqual([large.id, large.learnMargin, fixers.active], ["qwen3-1.7b-q4", 0, "qwen3-1.7b-q4"]);
    assert.deepEqual(await large.judge([{ typed: "a", edited: "b", from: "a", to: "b", known: "" }]), [1]);
    pick(null);
    assert.equal(await fixers.current(), null);
    assert.equal(fixers.active, null);
  });

  it("unloads after it has been idle, and loads again on the next call", async () => {
    const { fixers } = picked({ id: "qwen3-1.7b-q4", path: "/m/large.gguf" }, 50);
    const f = (await fixers.current())!;
    await f.ready();
    assert.equal(fixers.active, "qwen3-1.7b-q4");
    await sleep(150);
    assert.equal(fixers.active, null);
    const again = (await fixers.current())!;
    assert.deepEqual(await again.score([{ name: "X", type: "Lingo", text: "ab" }]), [2]);
    await fixers.close();
  });

  it("within: the value in time, else undefined while the work goes on", async () => {
    assert.equal(await within(Promise.resolve(1), 50), 1);
    assert.equal(await within(sleep(200).then(() => 1), 20), undefined);
    await assert.rejects(within(Promise.reject(new Error("broke")), 50), /broke/);
  });
});

describe("fixer engine: the take-back reply", () => {
  it("reads the { wrong, cue } items and nothing else", () => {
    assert.deepEqual(parseRetractions('[{"wrong":"Friday","cue":"sorry"},{"wrong":3},"x"]'), [{ wrong: "Friday", cue: "sorry" }]);
    assert.deepEqual(parseRetractions("no idea"), []);
    assert.deepEqual(parseRetractions("[{oops"), []);
  });
});
