import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LEVEL_SATS, TOP_LEVEL, TOP_SATS, levelOf } from "./levels.js";

describe("levels", () => {
  it("Level 0 below 1k sats, Level 1 at it", () => {
    assert.deepEqual(levelOf(0), { level: 0, fromSats: 0, toSats: 1_000 });
    assert.deepEqual(levelOf(999), { level: 0, fromSats: 0, toSats: 1_000 });
    assert.deepEqual(levelOf(1_000), { level: 1, fromSats: 1_000, toSats: 2_500 });
  });

  it("the first 25 levels: quick wins, then round numbers", () => {
    assert.deepEqual(LEVEL_SATS.slice(1, 26), [
      1_000, 2_500, 5_000,
      10_000, 12_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000, 60_000, 80_000,
      100_000, 120_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 600_000, 800_000,
      1_000_000, 1_200_000,
    ]);
  });

  it("the ladder is ten times as much every ten levels from 10k at Level 4: 1 BTC at Level 44", () => {
    for (let k = 0; k <= 11; k++) assert.equal(LEVEL_SATS[4 + 10 * k], 10_000 * 10 ** k, `level ${4 + 10 * k}`);
    assert.equal(LEVEL_SATS[44], 100_000_000);
  });

  it("the top is every bitcoin: Level 118 at 21M BTC, with nothing past it", () => {
    assert.equal(TOP_LEVEL, 118);
    assert.equal(LEVEL_SATS[TOP_LEVEL], TOP_SATS);
    assert.equal(LEVEL_SATS[TOP_LEVEL - 1], 2_000_000_000_000_000, "20M BTC, the ladder's last");
    assert.deepEqual(levelOf(TOP_SATS), { level: TOP_LEVEL, fromSats: TOP_SATS });
    assert.equal(levelOf(TOP_SATS - 1).level, TOP_LEVEL - 1);
    assert.equal(levelOf(Number.MAX_SAFE_INTEGER).level, TOP_LEVEL);
  });

  it("every level starts higher than the last, and holds up to one sat before the next", () => {
    for (let l = 1; l < TOP_LEVEL; l++) {
      assert.ok(LEVEL_SATS[l + 1]! > LEVEL_SATS[l]!, `level ${l + 1}`);
      assert.equal(levelOf(LEVEL_SATS[l]!).level, l);
      assert.equal(levelOf(LEVEL_SATS[l + 1]! - 1).level, l);
    }
  });

  it("nonsense reads as nothing earned", () => {
    assert.equal(levelOf(-5).level, 0);
    assert.equal(levelOf(Number.NaN).level, 0);
  });
});
