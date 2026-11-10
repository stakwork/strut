import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtEventTime } from "./event-time";

test("ts only", () => {
  const t = fmtEventTime({ ts: "2026-03-03T14:02:09.223Z" })!;
  assert.equal(t.title, "2026-03-03T14:02:09.223Z");
  assert.equal(t.iso, t.title);
});

test("duration gives start = ts - durationMs", () => {
  const t = fmtEventTime({ ts: "2026-03-03T14:02:09.223Z", durationMs: 4100 })!;
  assert.equal(t.title, "start 2026-03-03T14:02:05.123Z\nend 2026-03-03T14:02:09.223Z");
  assert.ok(t.text.includes("→") && t.text.includes("(4.1s)"));
});

test("invalid or missing ts", () => {
  assert.equal(fmtEventTime({ ts: "nope" }), null);
  assert.equal(fmtEventTime({}), null);
});
