import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  it("serves a hit within the TTL and recomputes after it", async () => {
    let t = 0;
    let calls = 0;
    const cache = new TtlCache<{ n: number }>(1000, () => t);
    const compute = async () => ({ n: ++calls });
    assert.deepEqual(await cache.get("k", compute), { n: 1 });
    t = 999;
    assert.deepEqual(await cache.get("k", compute), { n: 1 });
    t = 1000;
    assert.deepEqual(await cache.get("k", compute), { n: 2 });
  });

  it("hands out copies, never the cached object", async () => {
    const cache = new TtlCache<{ list: number[] }>(1000, () => 0);
    const a = await cache.get("k", async () => ({ list: [1] }));
    a.list.push(2);
    assert.deepEqual(await cache.get("k", async () => ({ list: [] })), { list: [1] });
  });

  it("shares one in-flight computation and never caches a rejection", async () => {
    const cache = new TtlCache<number>(1000, () => 0);
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 7;
    };
    assert.deepEqual(await Promise.all([cache.get("k", slow), cache.get("k", slow)]), [7, 7]);
    assert.equal(calls, 1);
    await assert.rejects(cache.get("bad", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await cache.get("bad", async () => 1), 1);
  });

  it("delete/clear drop entries, and orphan a computation in flight", async () => {
    const cache = new TtlCache<number>(1000, () => 0);
    await cache.get("a", async () => 1);
    cache.delete("a");
    assert.equal(await cache.get("a", async () => 2), 2);
    cache.clear();
    assert.equal(await cache.get("a", async () => 3), 3);
    // A computation started before clear() must not repopulate after it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = cache.get("b", async () => { await gate; return 10; });
    cache.clear();
    release();
    await pending;
    assert.equal(await cache.get("b", async () => 11), 11);
  });
});
