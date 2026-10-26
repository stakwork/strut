import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDuration } from "./duration";

test("fmtDuration: ms, then s, m, h — one decimal under 10", () => {
  assert.equal(fmtDuration(0), "0ms");
  assert.equal(fmtDuration(340), "340ms");
  assert.equal(fmtDuration(999.6), "1s");
  assert.equal(fmtDuration(2_300), "2.3s");
  assert.equal(fmtDuration(14_200), "14s");
  assert.equal(fmtDuration(59_400), "59s");
  assert.equal(fmtDuration(59_600), "1m");
  assert.equal(fmtDuration(270_000), "4.5m");
  assert.equal(fmtDuration(840_000), "14m");
  assert.equal(fmtDuration(3_540_000), "59m");
  assert.equal(fmtDuration(3_876_098), "1.1h");
  assert.equal(fmtDuration(8_280_000), "2.3h");
  assert.equal(fmtDuration(90_000_000), "25h");
});
