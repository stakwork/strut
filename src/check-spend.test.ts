import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSpend, dropSpend, readSpend, spendFile, spentOn, utcDay, writeSpend } from "./check-spend.js";

const day = (d: string) => Date.parse(`${d}T12:00:00Z`);

describe("check spend tally", () => {
  it("adds all-time spend per subject, and the newest day's apart", () => {
    let s = addSpend({}, "step:a", 0.4, day("2026-11-18"));
    s = addSpend(s, "step:a", 0.1, day("2026-11-19"));
    s = addSpend(s, "step:a", 0.2, day("2026-11-19"));
    s = addSpend(s, "workflow:w", 1, day("2026-11-19"));
    // A run kept late, for a day already past, counts all-time only.
    s = addSpend(s, "step:a", 0.05, day("2026-11-17"));
    assert.ok(Math.abs(s["step:a"]!.usd - 0.75) < 1e-9);
    assert.equal(s["step:a"]!.day, "2026-11-19");
    assert.ok(Math.abs(spentOn(s["step:a"], "2026-11-19") - 0.3) < 1e-9);
    assert.equal(spentOn(s["step:a"], "2026-11-20"), 0, "a new day starts at nothing");
    assert.equal(spentOn(s["step:b"], "2026-11-19"), 0);
    assert.equal(s["workflow:w"]!.usd, 1);
    assert.equal(utcDay(Date.parse("2026-11-19T23:59:59Z")), "2026-11-19");
  });

  it("reads back what was written; none, unreadable or dropped is null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-spend-"));
    try {
      assert.equal(await readSpend(dir, "c1"), null);
      const s = addSpend({}, "step:a", 0.4, Date.now());
      await writeSpend(dir, "c1", s);
      assert.deepEqual(await readSpend(dir, "c1"), s);
      await writeFile(spendFile(dir, "c1"), "{not json", "utf-8");
      assert.equal(await readSpend(dir, "c1"), null, "a torn file is recounted");
      await writeSpend(dir, "c1", s);
      await dropSpend(dir, "c1");
      assert.equal(await readSpend(dir, "c1"), null);
      assert.throws(() => spendFile(dir, "../x"), /Invalid check id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
