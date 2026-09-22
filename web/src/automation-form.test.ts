import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Trigger } from "./api";
import { cleanInput, emptyTriggerForm, formFromTrigger, isTemplate, lastOutputToken, relativeTime, timeZoneOptions, triggerFromForm } from "./automation-form";

const stored = (t: Record<string, unknown>) => ({ type: "schedule", ...t }) as Trigger;
const draftOf = (t: Trigger) => {
  const r = triggerFromForm(formFromTrigger(t));
  assert.ok("trigger" in r, JSON.stringify(r));
  return r.trigger;
};

describe("automation form ⇄ trigger", () => {
  it("every stored shape round-trips through the form unchanged", () => {
    const triggers: Record<string, unknown>[] = [
      { every: "interval", minutes: 90, anchor: "2026-09-20T09:00:00.000Z", tz: "UTC" },
      { every: "interval", minutes: 120, anchor: "2026-09-20T09:00:00.000Z", on: ["mon", "fri"], between: ["09:00", "17:00"], tz: "America/New_York" },
      { every: "day", at: ["09:00", "17:00"], tz: "UTC" },
      { every: "week", on: ["mon", "wed", "fri"], at: ["09:00"], tz: "Europe/London" },
      { every: "month", day: 15, at: ["08:00"], tz: "UTC" },
      { every: "month", day: "last", at: ["08:00"], tz: "UTC" },
      { every: "month", day: { nth: "last", weekday: "fri" }, at: ["16:00"], tz: "UTC" },
      { every: "once", at: "2026-10-03T14:00", tz: "UTC" },
    ];
    for (const t of triggers) {
      const { type: _type, ...want } = stored(t) as Trigger & { type: string };
      assert.deepEqual(draftOf(stored(t)), want);
    }
  });

  it("hours are shown as hours but stored as minutes; the anchor survives an edit", () => {
    const form = formFromTrigger(stored({ every: "interval", minutes: 120, anchor: "2026-09-20T09:00:00.000Z", tz: "UTC" }));
    assert.deepEqual([form.gap, form.gapUnit], [2, "hours"]);
    const r = triggerFromForm({ ...form, gap: 3 });
    assert.deepEqual("trigger" in r && r.trigger, { every: "interval", minutes: 180, anchor: "2026-09-20T09:00:00.000Z", tz: "UTC" });
  });

  it("canonicalizes days and times, and drops blank times", () => {
    const r = triggerFromForm({ ...emptyTriggerForm("UTC"), repeat: "week", weekDays: ["fri", "mon"], at: ["17:00", "", "09:00", "09:00"] });
    assert.deepEqual("trigger" in r && r.trigger, { every: "week", on: ["mon", "fri"], at: ["09:00", "17:00"], tz: "UTC" });
  });

  it("an unfinished form says what is missing, in plain language", () => {
    const base = emptyTriggerForm("UTC");
    const problem = (f: typeof base) => {
      const r = triggerFromForm(f);
      return "problem" in r ? r.problem : null;
    };
    assert.match(problem({ ...base, repeat: "day", at: [""] })!, /time/);
    assert.match(problem({ ...base, repeat: "week", weekDays: [] })!, /day/);
    assert.match(problem({ ...base, repeat: "month", monthMode: "day", monthDay: 31 })!, /last day/);
    assert.match(problem({ ...base, repeat: "interval", gap: 0 })!, /1 minute/);
    assert.match(problem({ ...base, repeat: "interval", limitHours: true, between: ["17:00", "09:00"] })!, /window/);
    assert.match(problem({ ...base, repeat: "once" })!, /date/);
    assert.equal(problem(base), null);
  });

  it("input tokens + cleanup", () => {
    assert.equal(lastOutputToken("newest_id"), "{{ last.output.newest_id }}");
    assert.equal(lastOutputToken("newest-id"), '{{ last.output["newest-id"] }}');
    assert.deepEqual([isTemplate("{{ now }}"), isTemplate("now"), isTemplate(3)], [true, false, false]);
    assert.deepEqual(cleanInput({ a: "x", b: "", c: undefined, d: 0, e: false }), { a: "x", d: 0, e: false });
  });

  it("relativeTime + time zone options", () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    assert.equal(relativeTime("2026-09-20T12:00:20Z", now), "in less than a minute");
    assert.equal(relativeTime("2026-09-20T12:45:00Z", now), "in 45 minutes");
    assert.equal(relativeTime("2026-09-20T13:00:00Z", now), "in 1 hour");
    assert.equal(relativeTime("2026-09-23T12:00:00Z", now), "in 3 days");
    assert.equal(relativeTime("2026-09-20T10:00:00Z", now), "2 hours ago");
    const zones = timeZoneOptions("Asia/Kolkata");
    assert.equal(zones[0], "Asia/Kolkata");
    assert.equal(new Set(zones).size, zones.length, "no duplicates");
    assert.ok(zones.includes("UTC"));
  });
});
