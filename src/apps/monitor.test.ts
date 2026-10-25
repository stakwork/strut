import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_MONITOR_LIMITS as L, USAGE_DIR, createAppMonitor, type AppCall, type AppMonitorOptions } from "./monitor.js";

/**
 * The app monitor (src/apps/monitor.ts): the counts per minute, hour and
 * type, and the five warnings — each on the version that caused it, a
 * burst per (viewer, type), counted once per window and kept a day; then
 * the files under each app's `.usage/` that carry it all across a restart.
 */

const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);

function setup(opts: AppMonitorOptions = {}) {
  let at = T0;
  const monitor = createAppMonitor({ now: () => at, flushEveryMs: 0, ...opts });
  const call = (over: Partial<AppCall> = {}) =>
    monitor.record({ app: "dash", version: "v1", type: "run/get", config: {}, viewer: "ann", status: "ok", ms: 5, bytes: 100, ...over });
  return { monitor, call, tick: (ms: number) => (at += ms), at: () => at };
}

describe("app monitor", () => {
  it("counts calls, failures, bytes and time — per minute for the hour, by type for the day", () => {
    const { monitor, call, tick } = setup();
    call();
    call({ type: "run/list", bytes: 300 });
    call({ status: "refused", bytes: 0, error: "not granted" });
    tick(5 * 60_000);
    call({ type: "run/list", status: "error", bytes: 0, ms: 20 });
    const r = monitor.report("dash");
    assert.deepEqual(r.hour, { calls: 4, errors: 2, bytes: 400, ms: 35 });
    assert.deepEqual(r.day, r.hour);
    assert.equal(r.minutes.length, 60);
    assert.equal(r.minutes[59]!.calls, 1, "this minute");
    assert.equal(r.minutes[54]!.calls, 3, "five minutes ago");
    assert.deepEqual(r.types.map((t) => [t.type, t.calls, t.errors]), [["run/get", 2, 1], ["run/list", 2, 1]]);
    assert.deepEqual(r.warnings, []);
    assert.ok(r.lastCallAt && r.since);
    // An hour on, the minutes have rolled off; the day still has them.
    tick(60 * 60_000);
    const later = monitor.report("dash");
    assert.equal(later.hour.calls, 0);
    assert.equal(later.day.calls, 4);
    // An app never called reports empty counts.
    assert.equal(monitor.report("ghost").day.calls, 0);
  });

  it("fanout: one page calling one type for many configs in a burst — not many pages, not one config", () => {
    const { monitor, call, tick } = setup();
    // Thirty viewers each opening the same run: no loop.
    for (let i = 0; i < 60; i++) call({ viewer: `v${i}`, config: { runId: String(i) } });
    // One viewer polling one run 60 times: not a fan-out.
    for (let i = 0; i < 60; i++) call({ config: { runId: "same" } });
    assert.equal(monitor.warningCount("dash", "v1"), 0);
    tick(10_000);
    // One page, one call per item.
    for (let i = 0; i < 80; i++) call({ type: "run/events", config: { workflow: "w", runId: String(i) } });
    const [w] = monitor.report("dash").warnings;
    assert.equal(w?.kind, "fanout");
    assert.equal(w?.type, "run/events");
    assert.equal(w?.peak, 80, "the peak follows the burst past the threshold");
    assert.equal(w?.distinct, 80);
    assert.equal(w?.times, 1, "one window");
    assert.match(w!.message, /run\/events called 80 times in 10 s from one page, with 80 different configs/);
    assert.match(w!.fix, /one call/);
    assert.equal(w?.example, JSON.stringify({ workflow: "w", runId: "79" }));
    // The next window fires again: times counts windows.
    tick(10_000);
    for (let i = 0; i < L.fanout.calls; i++) call({ type: "run/events", config: { runId: String(i) } });
    assert.equal(monitor.report("dash").warnings[0]!.times, 2);
    assert.equal(monitor.warningCount("dash", "v1"), 1, "one warning, seen twice");
  });

  it("repeat: the same call faster than any view needs; the kit's 2 s poll is fine", () => {
    const { monitor, call, tick } = setup();
    for (let i = 0; i < 30; i++) {
      call({ config: { runId: "1" } });
      tick(2_000);
    }
    assert.equal(monitor.warningCount("dash", "v1"), 0, "a live hook's poll");
    for (let i = 0; i < L.repeat.calls; i++) call({ config: { runId: "1" } });
    const [w] = monitor.report("dash").warnings;
    assert.equal(w?.kind, "repeat");
    assert.equal(w?.peak, L.repeat.calls);
    assert.match(w!.message, /the same run\/get call, config and all, 120 times in a minute/);
  });

  it("volume and bytes: the version's calls whoever made them, by minute and by hour", () => {
    const { monitor, call, tick } = setup();
    for (let i = 0; i < L.volume.minute; i++) call({ viewer: `v${i % 50}`, config: { i: i % 7 }, bytes: 100 * 1024 });
    const kinds = monitor.report("dash").warnings.map((w) => `${w.kind}:${w.window}`).sort();
    assert.deepEqual(kinds, ["bytes:1m", "volume:1m"]);
    const bytes = monitor.report("dash").warnings.find((w) => w.kind === "bytes")!;
    assert.ok(bytes.peak >= L.bytes.minute);
    assert.match(bytes.message, /MB of results in a minute/);
    // Spread over the hour, under the minute's rule, the hour's catches it.
    const { monitor: m2, call: c2, tick: t2 } = setup();
    for (let i = 0; i < L.volume.hour; i++) {
      c2({ viewer: `v${i % 9}`, config: { i: i % 5 } });
      if (i % 100 === 99) t2(60_000);
    }
    assert.deepEqual(m2.report("dash").warnings.map((w) => `${w.kind}:${w.window}`), ["volume:1h"]);
    assert.match(m2.report("dash").warnings[0]!.message, /5000 calls in an hour/);
    void tick;
  });

  it("failing: one call failing over and over, with its last error", () => {
    const { monitor, call } = setup();
    for (let i = 0; i < L.failing.calls; i++) call({ type: "graph/create-node", status: "refused", bytes: 0, error: `step_run refused: a graph write on "Concept" is refused (${i})`, config: { node_type: "Concept" } });
    const [w] = monitor.report("dash").warnings;
    assert.equal(w?.kind, "failing");
    assert.equal(w?.type, "graph/create-node");
    assert.match(w!.error!, /\(19\)$/);
    assert.match(w!.message, /graph\/create-node failed 20 times in a minute: step_run refused/);
    assert.equal(w?.example, JSON.stringify({ node_type: "Concept" }));
  });

  it("a warning belongs to its version and is kept a day; a deleted app is forgotten", () => {
    const { monitor, call, tick } = setup();
    for (let i = 0; i < L.fanout.calls; i++) call({ config: { runId: String(i) } });
    assert.equal(monitor.warningCount("dash", "v1"), 1);
    assert.equal(monitor.warningCount("dash", "v2"), 0, "the fix starts clean");
    tick(23 * 60 * 60_000);
    assert.equal(monitor.warningCount("dash", "v1"), 1);
    tick(60 * 60_000 + 1);
    assert.equal(monitor.warningCount("dash", "v1"), 0, "older than a day");
    assert.deepEqual(monitor.report("dash").warnings, []);
    call();
    monitor.forget("dash");
    assert.equal(monitor.report("dash").day.calls, 0);
    // The brief is the report without its series.
    assert.equal("minutes" in monitor.brief("dash"), false);
  });
});

describe("app monitor — kept on disk", () => {
  const roots: string[] = [];
  const fresh = async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-usage-"));
    roots.push(root);
    return root;
  };
  after(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });
  /** A second monitor over the same files and the same clock: a restart. */
  const restart = (root: string, at: () => number) => createAppMonitor({ root, now: at, flushEveryMs: 0 });
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("timed out");
  };

  it("a restart reads the last day back: the counts, the minutes, the types, the warnings", async () => {
    const root = await fresh();
    const { monitor, call, tick, at } = setup({ root });
    call();
    call({ type: "run/list", status: "error", bytes: 0, error: "nope" });
    tick(3 * 60_000);
    for (let i = 0; i < 60; i++) call({ type: "run/events", config: { runId: String(i) } });
    const before = monitor.report("dash");
    assert.equal(before.warnings[0]?.kind, "fanout");
    await monitor.close();
    const after = restart(root, at).report("dash");
    assert.deepEqual(after, before);
    assert.equal(restart(root, at).warningCount("dash", "v1"), 1, "the dot survives too");
  });

  it("a crash loses only what was not written yet — and a warning is written the moment it fires", async () => {
    const root = await fresh();
    const { monitor, call, at } = setup({ root });
    for (let i = 0; i < 10; i++) call();
    await monitor.flush();
    // Unwritten: the counts of the burst. Written at once: its warning.
    for (let i = 0; i < 60; i++) call({ type: "run/events", config: { runId: String(i) } });
    const file = join(root, "dash", USAGE_DIR, "2026-10-23.jsonl");
    await waitFor(async () => (await readFile(file, "utf8")).includes('"warning"'));
    const after = restart(root, at).report("dash");
    assert.equal(after.day.calls, 10, "the counts since the last write are gone");
    assert.deepEqual(after.warnings.map((w) => [w.kind, w.type, w.version]), [["fanout", "run/events", "v1"]]);
    // A line cut off by the crash is skipped.
    await appendFile(file, '{"at":"2026-10-23T12:00:00.000Z","vers');
    assert.equal(restart(root, at).report("dash").day.calls, 10);
  });

  it("the hour's volume goes on across a restart, and a warning already fired in the window is not counted twice", async () => {
    const root = await fresh();
    const a = setup({ root });
    for (let i = 0; i < 3_000; i++) {
      a.call({ viewer: `v${i % 9}`, config: { i: i % 5 } });
      if (i % 100 === 99) a.tick(60_000);
    }
    await a.monitor.close();
    let at = a.at();
    const b = createAppMonitor({ root, now: () => at, flushEveryMs: 0 });
    const call = (i: number) => b.record({ app: "dash", version: "v1", type: "run/get", config: { i: i % 5 }, viewer: `v${i % 9}`, status: "ok", ms: 1, bytes: 10 });
    for (let i = 0; i < 2_000; i++) {
      call(i);
      if (i % 100 === 99) at += 60_000;
    }
    const vol = b.report("dash").warnings.find((w) => w.kind === "volume" && w.window === "1h");
    assert.ok(vol, "3 000 before the restart + 2 000 after");
    assert.equal(vol.peak, 5_000);
    assert.equal(vol.times, 1);
    await b.close();
    const c = createAppMonitor({ root, now: () => at, flushEveryMs: 0 });
    c.record({ app: "dash", version: "v1", type: "run/get", config: {}, viewer: "v0", status: "ok", ms: 1, bytes: 10 });
    assert.equal(c.report("dash").warnings.find((w) => w.kind === "volume")?.times, 1, "the same window: no second sighting");
  });

  it("one file per UTC day under the app's .usage, a minute's lines summed on read, 30 days kept, a forgotten app's files gone", async () => {
    const root = await fresh();
    const { monitor, call, tick, at } = setup({ root });
    call({ app: "acme/hvac", type: "run/get", bytes: 7, ms: 3 });
    await monitor.flush();
    call({ app: "acme/hvac", type: "run/get", bytes: 5, ms: 1 });
    await monitor.flush();
    const dir = join(root, "acme", "hvac", USAGE_DIR);
    const lines = (await readFile(join(dir, "2026-10-23.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      { at: "2026-10-23T12:00:00.000Z", version: "v1", types: { "run/get": [1, 0, 7, 3] } },
      { at: "2026-10-23T12:00:00.000Z", version: "v1", types: { "run/get": [1, 0, 5, 1] } },
    ]);
    assert.deepEqual(restart(root, at).report("acme/hvac").types, [{ type: "run/get", calls: 2, errors: 0, bytes: 12, ms: 4 }]);
    // Thirty days on, the first day's file goes when the app is next counted.
    await writeFile(join(dir, "2026-09-01.jsonl"), "");
    tick(31 * 24 * 60 * 60_000);
    call({ app: "acme/hvac" });
    await monitor.flush();
    assert.deepEqual((await readdir(dir)).sort(), ["2026-11-23.jsonl"]);
    // Read back on first touch, the old ones pruned too.
    await writeFile(join(dir, "2026-09-01.jsonl"), "");
    const reread = restart(root, at);
    assert.equal(reread.report("acme/hvac").day.calls, 1, "the day before is past the report");
    await reread.flush();
    assert.deepEqual((await readdir(dir)).sort(), ["2026-11-23.jsonl"]);
    monitor.forget("acme/hvac");
    await monitor.flush();
    await assert.rejects(readdir(dir), /ENOENT/);
  });
});
