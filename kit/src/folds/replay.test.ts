import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REPLAY_PACE, replayAdvance, replayCatchUp, replayDelay, replayLive, replayMoving, replayPause, replayPlay, replaySeek, replayStart, replayTime, replayWait,
  type ReplayCursor,
} from "./replay.js";

/** Drive a cursor on a fake clock until nothing moves: each beat's time on screen. */
function play(c: ReplayCursor, times: Array<number | null>, opts: { speed?: number; running?: boolean } = {}): Array<{ at: number; t: number }> {
  const shown: Array<{ at: number; t: number }> = [];
  let t = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const wait = replayWait(c, times, opts);
    if (wait === null) break;
    t += wait;
    c = replayAdvance(c, times.length, opts.running ?? false);
    shown.push({ at: c.at, t });
  }
  return shown;
}

describe("the replay clock", () => {
  it("a beat stays the run's own gap, held to a readable least and an idle stretch cut short, divided by the speed", () => {
    assert.equal(replayDelay(1500), 1500);
    assert.equal(replayDelay(50), REPLAY_PACE.minMs, "the run went faster than a person reads");
    assert.equal(replayDelay(180_000), REPLAY_PACE.maxMs, "a model thinking for three minutes");
    assert.equal(replayDelay(null), REPLAY_PACE.minMs, "no times in the log");
    assert.equal(replayDelay(1500, 2), 750);
    assert.equal(replayDelay(1500, 0.5), 3000);
    assert.equal(replayDelay(50, 100), REPLAY_PACE.floorMs);
    assert.equal(replayTime("2026-11-02T14:00:01.500Z"), Date.UTC(2026, 10, 2, 14, 0, 1, 500));
    assert.equal(replayTime(undefined), null);
  });

  it("starts at the hops so far on a run in flight, following; at the end of a finished one; at the start of one opened in replay", () => {
    assert.deepEqual(replayStart(6, true), { at: 6, mode: "follow" });
    assert.deepEqual(replayStart(6, false), { at: 6, mode: "pause" });
    assert.deepEqual(replayStart(6, false, true), { at: 0, mode: "play" });
    assert.deepEqual(replayStart(0, false, true), { at: 0, mode: "pause" }, "nothing to play");
  });

  it("a finished run replays every beat, in order, at the pace it ran, and stops at its end", () => {
    const times = [0, 1100, 1400, 2500, 2800, 3900]; // a hop: candidates, then 1.1 s later its choice
    const shown = play(replayStart(times.length, false, true), times);
    assert.deepEqual(shown.map((s) => s.at), [1, 2, 3, 4, 5, 6]);
    // The first beat waits the least; then each gap, the 0.3 s ones held to the least.
    assert.deepEqual(shown.map((s) => s.t), [700, 1800, 2500, 3600, 4300, 5400]);
    const twice = play(replayStart(times.length, false, true), times, { speed: 2 });
    assert.equal(twice.at(-1)!.t, 2700);
    assert.equal(replayWait({ at: 6, mode: "pause" }, times), null);
    assert.deepEqual(replayAdvance({ at: 5, mode: "play" }, 6, false), { at: 6, mode: "pause" });
  });

  it("a follower takes beats as they come, faster the further behind, never skipping one", () => {
    assert.deepEqual([1, 3, 5, 9].map(replayCatchUp), [1, 2, 3, 6]);
    // Joined with 2 beats shown; a read brings 8 more at once.
    const times = Array.from({ length: 10 }, (_, i) => i * 1000);
    let c: ReplayCursor = { at: 2, mode: "follow" };
    const waits: number[] = [];
    while (c.at < times.length) {
      waits.push(replayWait(c, times)!);
      c = replayAdvance(c, times.length, true);
    }
    assert.equal(waits.length, 8, "each beat shown");
    assert.ok(waits[0]! < waits.at(-1)!, `catching up: ${waits.join(", ")}`);
    assert.equal(waits.at(-1), 1000, "caught up: the run's own pace");
    assert.deepEqual(c, { at: 10, mode: "follow" }, "still following");
    assert.equal(replayMoving(c, 10, true), true, "a run in flight, followed");
    assert.equal(replayMoving(c, 10, false), false);
  });

  it("a replay that reaches the end of a run still in flight follows it; Live jumps there", () => {
    assert.deepEqual(replayAdvance({ at: 4, mode: "play" }, 5, true), { at: 5, mode: "follow" });
    assert.deepEqual(replayLive(9), { at: 9, mode: "follow" });
  });

  it("play, pause, a step and a scrub", () => {
    assert.deepEqual(replayPlay({ at: 6, mode: "pause" }, 6), { at: 0, mode: "play" }, "at the end: from the start");
    assert.deepEqual(replayPlay({ at: 2, mode: "pause" }, 6), { at: 2, mode: "play" });
    assert.deepEqual(replayPause({ at: 3, mode: "follow" }, 6), { at: 3, mode: "pause" });
    assert.deepEqual(replaySeek(-3, 6), { at: 0, mode: "pause" });
    assert.deepEqual(replaySeek(99, 6), { at: 6, mode: "pause" });
    assert.equal(replayMoving({ at: 2, mode: "pause" }, 6, true), false);
  });
});
