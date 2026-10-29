import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FEED_EPOCH, LiveFeed } from "./live-feed.js";

interface Thing { id: string; v: number; kind?: string }

const feed = (o: { max?: number; gatherMs?: number } = {}) => new LiveFeed<Thing>({ max: o.max ?? 10, keyOf: (t) => t.id, gatherMs: o.gatherMs ?? 30 });

describe("live feed (plans/live-feeds.md)", () => {
  it("keeps the newest state of each thing, in the order they last changed; a cursor reads what came after it", async () => {
    const f = feed();
    f.push({ id: "a", v: 1 });
    f.push({ id: "b", v: 1 });
    f.push({ id: "a", v: 2 });
    const all = await f.read();
    assert.deepEqual(all.items, [{ id: "b", v: 1 }, { id: "a", v: 2 }]);
    assert.equal(all.cursor, `${FEED_EPOCH}.3`);
    assert.equal(all.reset, undefined);
    f.push({ id: "c", v: 1 });
    assert.deepEqual((await f.read({ since: all.cursor })).items, [{ id: "c", v: 1 }]);
    assert.deepEqual((await f.read({ since: f.cursor() })).items, []);
  });

  it("a cursor it cannot honor — another process's, past what it dropped, or junk — reads everything kept with reset", async () => {
    const f = feed({ max: 2 });
    f.push({ id: "a", v: 1 });
    const early = (await f.read()).cursor;
    f.push({ id: "b", v: 1 });
    f.push({ id: "c", v: 1 }); // drops a (seq 1): a cursor at 0 missed it
    assert.deepEqual(await f.read({ since: `${FEED_EPOCH}.0` }), { cursor: `${FEED_EPOCH}.3`, reset: true, items: [{ id: "b", v: 1 }, { id: "c", v: 1 }] });
    assert.deepEqual((await f.read({ since: early })).items, [{ id: "b", v: 1 }, { id: "c", v: 1 }], "a cursor at the dropped thing is honored");
    for (const since of ["0abc.1", "nope", `${FEED_EPOCH}.99`]) assert.equal((await f.read({ since })).reset, true, since);
  });

  it('"now" is the feed\'s position: nothing kept, only what comes after', async () => {
    const f = feed();
    f.push({ id: "a", v: 1 });
    const now = await f.read({ since: "now" });
    assert.deepEqual(now, { cursor: `${FEED_EPOCH}.1`, items: [] });
  });

  it("limit answers the first part and says more, its cursor where it stopped", async () => {
    const f = feed();
    for (const id of ["a", "b", "c"]) f.push({ id, v: 1 });
    const one = await f.read({ limit: 2 });
    assert.deepEqual(one.items.map((t) => t.id), ["a", "b"]);
    assert.equal(one.more, true);
    const two = await f.read({ since: one.cursor, limit: 2 });
    assert.deepEqual(two.items.map((t) => t.id), ["c"]);
    assert.equal(two.more, undefined);
  });

  it("a waiting read answers when something lands, after gathering the burst into one answer", async () => {
    const f = feed({ gatherMs: 40 });
    const t0 = Date.now();
    const waiting = f.read({ since: f.cursor(), wait: 5_000 });
    setTimeout(() => f.push({ id: "a", v: 1 }), 10);
    setTimeout(() => f.push({ id: "b", v: 1 }), 20);
    setTimeout(() => f.push({ id: "a", v: 2 }), 30);
    const got = await waiting;
    assert.deepEqual(got.items, [{ id: "b", v: 1 }, { id: "a", v: 2 }], "one answer for the burst, the newest state");
    assert.ok(Date.now() - t0 < 1_000);
  });

  it("a waiting read with a filter is woken only by what passes it; one with nothing to say answers empty at its deadline", async () => {
    const f = feed({ gatherMs: 10 });
    const waiting = f.read({ since: f.cursor(), wait: 5_000, filter: (t) => t.kind === "x" });
    let answered = false;
    void waiting.then(() => (answered = true));
    f.push({ id: "a", v: 1, kind: "y" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(answered, false, "a thing the filter leaves out does not wake it");
    f.push({ id: "b", v: 1, kind: "x" });
    assert.deepEqual((await waiting).items, [{ id: "b", v: 1, kind: "x" }]);
    const quiet = await f.read({ since: f.cursor(), wait: 30 });
    assert.deepEqual(quiet.items, []);
    assert.equal(quiet.cursor, f.cursor());
  });

  it("wakeAll and an aborted signal let a waiting read answer now", async () => {
    const f = feed();
    const a = f.read({ since: f.cursor(), wait: 50_000 });
    f.wakeAll();
    assert.deepEqual((await a).items, []);
    const ctl = new AbortController();
    const b = f.read({ since: f.cursor(), wait: 50_000, signal: ctl.signal });
    ctl.abort();
    assert.deepEqual((await b).items, []);
  });
});
