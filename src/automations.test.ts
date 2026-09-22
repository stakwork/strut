/**
 * The pure half of automations (plans/automations.md §1, §5): the trigger
 * grammar, `nextFire`'s calendar math (incl. DST), the human summary, and
 * fire-time input resolution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NO_LAST_RUN,
  automationDraftSchema,
  checkInputTemplates,
  describeTrigger,
  nextFire,
  nextFires,
  normalizeTrigger,
  resolveAutomationInput,
  triggerSchema,
  type Trigger,
  type TriggerDraft,
} from "./automations.js";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);
const trig = (draft: Record<string, unknown>): Trigger =>
  normalizeTrigger(triggerSchema.parse(draft) as TriggerDraft, at("2026-09-20T12:00:00Z"), "UTC");
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fires = (t: Trigger, after: string, n: number) => nextFires(t, at(after), n).map((d) => d.toISOString());

describe("triggerSchema", () => {
  it("accepts every shape and defaults type to schedule", () => {
    for (const draft of [
      { every: "interval", minutes: 90 },
      { every: "day", at: ["09:00"] },
      { every: "week", on: ["mon"], at: ["09:00", "17:00"] },
      { every: "month", day: "last", at: ["16:00"] },
      { every: "month", day: { nth: "last", weekday: "fri" }, at: ["16:00"] },
      { every: "once", at: "2026-10-03T14:00" },
    ]) {
      const parsed = triggerSchema.parse(draft);
      assert.equal(parsed.type, "schedule");
    }
  });

  it("rejects what the grammar does not have", () => {
    const bad: Record<string, unknown>[] = [
      { every: "day", at: [] },
      { every: "day", at: ["9:00"] },
      { every: "day", at: ["24:00"] },
      { every: "week", on: [], at: ["09:00"] },
      { every: "week", on: ["monday"], at: ["09:00"] },
      { every: "month", day: 29, at: ["09:00"] },
      { every: "month", day: { nth: 5, weekday: "fri" }, at: ["09:00"] },
      { every: "interval", minutes: 0 },
      { every: "interval", minutes: 30, between: ["17:00", "09:00"] },
      { every: "interval", minutes: 30, between: ["09:00"] },
      { every: "interval", minutes: 30, between: ["09:00", "12:00", "17:00"] },
      { every: "interval", minutes: 30, anchor: "soon" },
      { every: "once", at: "2026-02-30T09:00" },
      { every: "once", at: "2026-10-03 14:00" },
      { every: "day", at: ["09:00"], tz: "Mars/Olympus" },
      { every: "cron", expr: "0 9 * * *" },
    ];
    for (const draft of bad) assert.equal(triggerSchema.safeParse(draft).success, false, JSON.stringify(draft));
  });

  it("a draft needs a name", () => {
    assert.equal(automationDraftSchema.safeParse({ name: "  ", trigger: { every: "day", at: ["09:00"] } }).success, false);
  });
});

describe("normalizeTrigger", () => {
  it("fills the zone and the interval anchor, and canonicalizes lists", () => {
    const now = at("2026-09-20T12:00:42Z");
    assert.deepEqual(normalizeTrigger(triggerSchema.parse({ every: "interval", minutes: 15 }) as TriggerDraft, now, NY), {
      type: "schedule",
      every: "interval",
      minutes: 15,
      anchor: "2026-09-20T12:00:00.000Z",
      tz: NY,
    });
    assert.deepEqual(
      normalizeTrigger(triggerSchema.parse({ every: "week", on: ["fri", "mon", "fri"], at: ["17:00", "09:00", "09:00"], tz: "UTC" }) as TriggerDraft, now),
      { type: "schedule", every: "week", on: ["mon", "fri"], at: ["09:00", "17:00"], tz: "UTC" },
    );
  });
});

describe("nextFire — wall-clock shapes", () => {
  it("day: every listed time, strictly after", () => {
    const t = trig({ every: "day", at: ["09:00", "17:00"], tz: "UTC" });
    assert.deepEqual(fires(t, "2026-09-20T08:59:00Z", 3), ["2026-09-20T09:00:00.000Z", "2026-09-20T17:00:00.000Z", "2026-09-21T09:00:00.000Z"]);
    assert.equal(iso(nextFire(t, at("2026-09-20T09:00:00Z"))), "2026-09-20T17:00:00.000Z", "an instant is not after itself");
  });

  it("day: the time is in the trigger's zone", () => {
    const t = trig({ every: "day", at: ["09:00"], tz: NY });
    assert.equal(iso(nextFire(t, at("2026-09-20T12:00:00Z"))), "2026-09-20T13:00:00.000Z"); // EDT = UTC−4
    assert.equal(iso(nextFire(t, at("2026-12-20T12:00:00Z"))), "2026-12-20T14:00:00.000Z"); // EST = UTC−5
  });

  it("week: only the listed days, wrapping the week", () => {
    const t = trig({ every: "week", on: ["mon", "fri"], at: ["09:00"], tz: "UTC" });
    // 2026-09-20 is a Sunday.
    assert.deepEqual(fires(t, "2026-09-20T00:00:00Z", 3), ["2026-09-21T09:00:00.000Z", "2026-09-25T09:00:00.000Z", "2026-09-28T09:00:00.000Z"]);
  });

  it("month: a numbered day", () => {
    const t = trig({ every: "month", day: 15, at: ["08:00"], tz: "UTC" });
    assert.deepEqual(fires(t, "2026-09-20T00:00:00Z", 2), ["2026-10-15T08:00:00.000Z", "2026-11-15T08:00:00.000Z"]);
  });

  it("month: the last day, across month lengths and a leap February", () => {
    const t = trig({ every: "month", day: "last", at: ["08:00"], tz: "UTC" });
    assert.deepEqual(fires(t, "2027-12-31T09:00:00Z", 3), ["2028-01-31T08:00:00.000Z", "2028-02-29T08:00:00.000Z", "2028-03-31T08:00:00.000Z"]);
  });

  it("month: the nth and the last weekday", () => {
    const second = trig({ every: "month", day: { nth: 2, weekday: "tue" }, at: ["10:00"], tz: "UTC" });
    assert.deepEqual(fires(second, "2026-09-20T00:00:00Z", 2), ["2026-10-13T10:00:00.000Z", "2026-11-10T10:00:00.000Z"]);
    const lastFri = trig({ every: "month", day: { nth: "last", weekday: "fri" }, at: ["16:00"], tz: "UTC" });
    assert.deepEqual(fires(lastFri, "2026-09-20T00:00:00Z", 2), ["2026-09-25T16:00:00.000Z", "2026-10-30T16:00:00.000Z"]);
  });

  it("once: fires at its instant, then never", () => {
    const t = trig({ every: "once", at: "2026-10-03T14:00", tz: NY });
    assert.equal(iso(nextFire(t, at("2026-09-20T00:00:00Z"))), "2026-10-03T18:00:00.000Z");
    assert.equal(nextFire(t, at("2026-10-03T18:00:00Z")), null);
  });
});

describe("nextFire — DST (America/New_York)", () => {
  it("09:00 stays 09:00 across both transitions", () => {
    const t = trig({ every: "day", at: ["09:00"], tz: NY });
    assert.deepEqual(fires(t, "2026-03-07T00:00:00Z", 3), ["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
    assert.deepEqual(fires(t, "2026-10-31T00:00:00Z", 3), ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
  });

  it("a time that does not exist (spring forward) fires once, shifted past the gap", () => {
    const t = trig({ every: "day", at: ["02:30"], tz: NY });
    // 2026-03-08: 02:00 EST → 03:00 EDT. 02:30 → 03:30 EDT = 07:30Z.
    assert.deepEqual(fires(t, "2026-03-07T12:00:00Z", 2), ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  });

  it("a time that occurs twice (fall back) fires once, at the first", () => {
    const t = trig({ every: "day", at: ["01:30"], tz: NY });
    // 2026-11-01: 02:00 EDT → 01:00 EST. First 01:30 is EDT = 05:30Z.
    assert.deepEqual(fires(t, "2026-10-31T12:00:00Z", 2), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });
});

describe("nextFire — interval", () => {
  it("is anchored: fires are anchor + k·minutes, whatever `after` is", () => {
    const t = trig({ every: "interval", minutes: 420, anchor: "2026-09-20T09:00:00Z", tz: "UTC" });
    assert.deepEqual(fires(t, "2026-09-21T00:00:00Z", 3), ["2026-09-21T06:00:00.000Z", "2026-09-21T13:00:00.000Z", "2026-09-21T20:00:00.000Z"]);
  });

  it("the anchor itself is the first fire when it is still ahead", () => {
    const t = trig({ every: "interval", minutes: 60, anchor: "2026-09-20T15:00:00Z", tz: "UTC" });
    assert.equal(iso(nextFire(t, at("2026-09-20T12:00:00Z"))), "2026-09-20T15:00:00.000Z");
  });

  it("`on` and `between` filter the rhythm (window inclusive) without moving its phase", () => {
    const t = trig({ every: "interval", minutes: 120, anchor: "2026-09-18T09:30:00Z", on: ["mon", "tue", "wed", "thu", "fri"], between: ["09:00", "13:30"], tz: "UTC" });
    // Fri 2026-09-18: 09:30, 11:30, 13:30 — then the weekend is skipped.
    assert.deepEqual(fires(t, "2026-09-18T09:30:00Z", 4), [
      "2026-09-18T11:30:00.000Z",
      "2026-09-18T13:30:00.000Z",
      "2026-09-21T09:30:00.000Z",
      "2026-09-21T11:30:00.000Z",
    ]);
  });

  it("a rhythm that never lands in its window yields null rather than spinning", () => {
    const t = trig({ every: "interval", minutes: 1440, anchor: "2026-09-20T20:00:00Z", between: ["09:00", "17:00"], tz: "UTC" });
    assert.equal(nextFire(t, at("2026-09-20T12:00:00Z")), null);
  });
});

describe("describeTrigger", () => {
  it("one sentence per shape", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ every: "interval", minutes: 90, tz: "UTC" }, "Every 90 minutes (UTC)"],
      [{ every: "interval", minutes: 120, tz: "UTC" }, "Every 2 hours (UTC)"],
      [{ every: "interval", minutes: 15, on: ["mon", "tue", "wed", "thu", "fri"], between: ["09:00", "17:00"], tz: NY }, "Every 15 minutes, weekdays, 9:00 AM – 5:00 PM (New York time)"],
      [{ every: "day", at: ["09:00", "17:00"], tz: NY }, "Every day at 9:00 AM and 5:00 PM (New York time)"],
      [{ every: "week", on: ["mon", "wed", "fri"], at: ["09:00"], tz: NY }, "Mon, Wed, Fri at 9:00 AM (New York time)"],
      [{ every: "week", on: ["sat", "sun"], at: ["00:05"], tz: "UTC" }, "Weekends at 12:05 AM (UTC)"],
      [{ every: "month", day: 1, at: ["12:00"], tz: "UTC" }, "The 1st of each month at 12:00 PM (UTC)"],
      [{ every: "month", day: "last", at: ["16:00"], tz: "UTC" }, "The last day of each month at 4:00 PM (UTC)"],
      [{ every: "month", day: { nth: "last", weekday: "fri" }, at: ["16:00"], tz: "UTC" }, "The last Friday of each month at 4:00 PM (UTC)"],
      [{ every: "month", day: { nth: 2, weekday: "tue" }, at: ["10:00"], tz: "UTC" }, "The 2nd Tuesday of each month at 10:00 AM (UTC)"],
      [{ every: "once", at: "2026-10-03T14:00", tz: NY }, "Once, on Oct 3, 2026 at 2:00 PM (New York time)"],
    ];
    for (const [draft, want] of cases) assert.equal(describeTrigger(trig(draft)), want);
  });
});

describe("automation input", () => {
  const trigger = trig({ every: "day", at: ["09:00"], tz: NY });

  it("checkInputTemplates allows only now / today / last", () => {
    assert.deepEqual(checkInputTemplates({ a: "{{ now }}", b: ["{{ today }}"], c: { d: "{{ last.output.items.map(i => i.id) }}" }, e: "plain input.x" }), []);
    const problems = checkInputTemplates({ a: "{{ input.url }}", b: "{{ last.output.id || fallback }}" });
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /reads "input"/);
    assert.match(problems[1]!, /reads "fallback"/);
  });

  it("first fire: last.output is {}, and undefined keys are dropped", () => {
    const input = { account: "stakwork", since_id: "{{ last.output.newest_id }}", floor: "{{ last.output.newest_id || \"0\" }}", day: "{{ today }}", stamp: "at {{ now }}" };
    assert.deepEqual(resolveAutomationInput({ input, trigger }, at("2026-09-21T02:00:00Z"), NO_LAST_RUN), {
      account: "stakwork",
      floor: "0",
      day: "2026-09-20", // still the 20th in New York
      stamp: "at 2026-09-21T02:00:00.000Z",
    });
  });

  it("later fires read the last successful run, types preserved", () => {
    const last = { runId: "r1", startedAt: "2026-09-20T13:00:00.000Z", finishedAt: "2026-09-20T13:00:05.000Z", output: { newest_id: 42, ids: ["a", "b"] } };
    assert.deepEqual(resolveAutomationInput({ input: { since_id: "{{ last.output.newest_id }}", ids: "{{ last.output.ids }}", since: "{{ last.startedAt }}" }, trigger }, at("2026-09-21T13:00:00Z"), last), {
      since_id: 42,
      ids: ["a", "b"],
      since: "2026-09-20T13:00:00.000Z",
    });
  });

  it("an unresolvable expression throws — the caller launches nothing", () => {
    assert.throws(() => resolveAutomationInput({ input: { x: "{{ last.output.a.b }}" }, trigger }, at("2026-09-21T13:00:00Z"), NO_LAST_RUN));
  });
});
