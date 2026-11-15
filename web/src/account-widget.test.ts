import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_CORNERS } from "@strut/kit/visitor";
import {
  appIdentityOf, createPlacementController, creditOf, initialState, parsePlacement, PLACEMENT_INTERVAL_MS, shortActor, workerOf,
} from "./account-widget";

/** A controller on a clock and timers the test drives. */
function rig(initial = initialState()) {
  let t = 10_000;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let n = 0;
  const c = createPlacementController(initial, {
    now: () => t,
    setTimer: (fn, ms) => (timers.push({ at: t + ms, fn, id: ++n }), n),
    clearTimer: (id) => void (timers = timers.filter((x) => x.id !== id)),
  });
  const seen: string[] = [];
  c.subscribe(() => seen.push(`${c.state().corner}/${c.state().collapsed}`));
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t)) {
      timers = timers.filter((y) => y !== x);
      x.fn();
    }
  };
  return { c, seen, advance, timers: () => timers.length };
}

describe("the account widget's default placement", () => {
  it("is top-right, expanded; app.yaml's corner and style (handle: collapsed) replace it; an unknown value falls back", () => {
    assert.deepEqual(initialState(), { corner: "top-right", collapsed: false });
    assert.deepEqual(initialState({ corner: "bottom-left", style: "pill" }), { corner: "bottom-left", collapsed: false });
    assert.deepEqual(initialState({ corner: "top-left", style: "handle" }), { corner: "top-left", collapsed: true });
    assert.deepEqual(initialState({ corner: "middle", style: "banner" }), { corner: "top-right", collapsed: false });
  });
});

describe("strut/account/placement params", () => {
  it("accepts every corner, collapsed either way, and nothing", () => {
    for (const corner of ACCOUNT_CORNERS) assert.deepEqual(parsePlacement({ corner }), { ok: true, placement: { corner } });
    assert.deepEqual(parsePlacement({ collapsed: true }), { ok: true, placement: { collapsed: true } });
    assert.deepEqual(parsePlacement({ corner: "top-left", collapsed: false }), { ok: true, placement: { corner: "top-left", collapsed: false } });
    assert.deepEqual(parsePlacement(undefined), { ok: true, placement: {} });
  });

  it("refuses an unknown corner, a non-boolean collapsed, an unknown field (hidden, opacity, …), and a non-object", () => {
    for (const bad of [{ corner: "middle" }, { corner: 3 }, { collapsed: "yes" }, { collapsed: 0 }, { hidden: true }, { collapsed: true, opacity: 0 }, { size: 0 }, "top-left", ["top-left"], 7]) {
      const r = parsePlacement(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.match((parsePlacement({ corner: "middle" }) as { error: string }).error, /unknown corner/);
  });
});

describe("the placement controller", () => {
  it("moves the widget, collapses and expands it", () => {
    const { c, seen } = rig();
    c.request({ corner: "bottom-left" });
    assert.deepEqual(c.state(), { corner: "bottom-left", collapsed: false });
    assert.deepEqual(seen, ["bottom-left/false"]);
  });

  it("applies one change per interval; the ones inside it are coalesced to the latest, applied when it is up", () => {
    const { c, seen, advance, timers } = rig();
    c.request({ collapsed: true }); // applied at once
    c.request({ corner: "top-left" });
    c.request({ corner: "bottom-left" });
    const answered = c.request({ corner: "bottom-right", collapsed: false });
    assert.deepEqual(answered, { corner: "bottom-right", collapsed: false }, "answers what it will show");
    assert.deepEqual(c.state(), { corner: "top-right", collapsed: true }, "held, not applied");
    assert.equal(timers(), 1, "one timer however many requests");
    advance(PLACEMENT_INTERVAL_MS - 1);
    assert.equal(seen.length, 1);
    advance(1);
    assert.deepEqual(seen, ["top-right/true", "bottom-right/false"], "the latest alone, no jitter between");
    // and the next is held again, since a change was just applied
    c.request({ collapsed: true });
    assert.equal(c.state().collapsed, false);
    advance(PLACEMENT_INTERVAL_MS);
    assert.equal(c.state().collapsed, true);
  });

  it("a held change that comes back to what is shown is dropped; a request after the interval applies at once", () => {
    const { c, seen, advance, timers } = rig();
    c.request({ collapsed: true });
    c.request({ collapsed: false });
    assert.equal(timers(), 1);
    c.request({ collapsed: true }); // back to shown
    assert.equal(timers(), 0);
    advance(5000);
    assert.deepEqual(seen, ["top-right/true"]);
    c.request({ corner: "top-left" });
    assert.equal(c.state().corner, "top-left");
  });

  it("the visitor's click applies at once and drops what the app held", () => {
    const { c, advance } = rig();
    c.request({ collapsed: true });
    c.request({ corner: "bottom-left" });
    c.user(false);
    assert.deepEqual(c.state(), { corner: "top-right", collapsed: false });
    advance(5000);
    assert.deepEqual(c.state(), { corner: "top-right", collapsed: false }, "the held move was dropped");
  });

  it("no sequence of messages leaves a state that is not a known corner and a boolean (nothing hides it)", () => {
    const { c, advance } = rig();
    const junk: unknown[] = [{ corner: "nowhere" }, { hidden: true }, { collapsed: null }, "x", null, { corner: "top-left", collapsed: true }, { corner: "bottom-right" }, { collapsed: false }];
    for (let i = 0; i < 50; i++) {
      const parsed = parsePlacement(junk[i % junk.length]);
      if (parsed.ok) c.request(parsed.placement);
      advance(i % 3 === 0 ? 600 : 100);
      const s = c.state();
      assert.deepEqual(Object.keys(s).sort(), ["collapsed", "corner"]);
      assert.ok((ACCOUNT_CORNERS as readonly string[]).includes(s.corner));
      assert.equal(typeof s.collapsed, "boolean");
    }
  });
});

describe("what the panel shows", () => {
  it("reads the app's identity out of its document, unescaped", () => {
    assert.equal(appIdentityOf('<head><meta name="strut-app-token" content="a&amp;b&quot;c"></head>'), 'a&b"c');
    assert.equal(appIdentityOf("<head></head>"), undefined);
  });

  it("shortens an actor, reads credit, and reads a worker's balance — nothing for what is not one", () => {
    assert.equal(shortActor("p256:02abcdef0123456789ff"), "p256:02abcd…89ff");
    assert.equal(shortActor("alice"), "alice");
    assert.deepEqual(creditOf(200, { remaining_usd: 1.5, remaining_sats: 3000 }), { usd: 1.5, sats: 3000 });
    assert.equal(creditOf(401, { remaining_usd: 1 }), null);
    assert.equal(creditOf(200, {}), null);
    assert.deepEqual(workerOf({ balance: { heldMsat: 2000, withdrawableMsat: 9000 }, payout: { on: true, maxMsat: 9000 } }), { heldMsat: 2000, withdrawableMsat: 9000, maxMsat: 9000, canWithdraw: true });
    assert.equal(workerOf({ balance: { heldMsat: 0, withdrawableMsat: 5000 }, payout: { on: false, maxMsat: 0 } })!.canWithdraw, false);
    assert.equal(workerOf({ error: "refused" }), null);
    assert.equal(workerOf(null), null);
  });
});
