/**
 * How far to trust a fact now (`fact-score.ts`), on slots built by hand: who
 * said it, each sayer once; how long since it was last confirmed, by the
 * edge type's volatility; an ended value kept in the running when a less
 * trusted sayer replaced it; a message read again that brings nothing back;
 * a change in a slot it depends on; and when to hedge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combine, currencyOf, scoreSlot, type Person, type SlotEdge, type SlotInput } from "./fact-score.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const at = (d: number) => T0 + d * DAY;

const people = new Map<string, Person>([
  ["me", { name: "Tom", owner: true }],
  ["kate", { name: "Kate", owner: false }],
  ["sam", { name: "Sam", owner: false }],
  ["ben", { name: "Ben", owner: false }],
]);
const user = { ref_id: "me", name: "Tom" };

const edge = (ref_id: string, target: string, sources: string[], d: number, extra: Partial<SlotEdge> = {}): SlotEdge => ({
  ref_id, target, sources, valid_at: null, expired_at: null, superseded_by: null, last_confirmed_at: at(d), created_at: at(d), ...extra,
});
const slot = (subject: string, edges: SlotEdge[], now: number, extra: Partial<SlotInput> = {}) => scoreSlot({ subject, edges, one: true, volatility: "stable", people, user, now: at(now), ...extra });

describe("fact-score", () => {
  it("belief counts each sayer once, and two people agreeing beat one", () => {
    assert.ok(combine(["owner"]) > combine(["self"]) && combine(["self"]) > combine(["other"]));
    assert.ok(combine(["other", "other"]) > combine(["other"]));
    // Sam saying it five times is one sayer.
    const s = slot("kate", [edge("e1", "vegetarian", ["sam", "m1", "m2", "m3", "m4", "m5"], 0)], 1, { volatility: "evolving" });
    assert.equal(s.get("e1")!.belief, Math.round(combine(["other"]) * 100) / 100);
    assert.deepEqual(s.get("e1")!.evidence.sayers, [{ ref_id: "sam", name: "Sam", kind: "other" }]);
    assert.equal(s.get("e1")!.hearsay, true);
  });

  it("a fact no Person is a source of was said by the user", () => {
    const s = slot("me", [edge("e1", "Acme", ["chat:1", "run:r1"], 0)], 1);
    assert.deepEqual(s.get("e1")!.evidence.sayers, [{ ref_id: "me", name: "Tom", kind: "owner" }]);
    assert.equal(s.get("e1")!.hedge, false);
  });

  it("currency halves per half-life after a grace period, a static fact never fades, and a fresh mention restarts it", () => {
    const e = edge("e1", "Bristol", [], 0);
    assert.equal(currencyOf(e, "stable", at(10)), 1, "inside the grace period");
    assert.ok(Math.abs(currencyOf(e, "stable", at(14 + 3 * 365)) - 0.5) < 1e-9, "half after one half-life");
    assert.equal(currencyOf(e, "static", at(5000)), 1);
    assert.equal(currencyOf({ ...e, last_confirmed_at: at(1500) }, "stable", at(1510)), 1);
    assert.equal(currencyOf(e, undefined, at(14 + 3 * 365)), currencyOf(e, "stable", at(14 + 3 * 365)), "unset is stable");
    assert.ok(currencyOf(e, "volatile", at(5000)) >= 0.05, "never below the floor");
  });

  it("hearsay that replaced the owner's fact is hedged, with the owner's value as its rival", () => {
    const mine = edge("e1", "Acme", ["chat:1"], 0, { expired_at: at(100), superseded_by: "e2" });
    const sams = edge("e2", "Globex", ["sam", "m2"], 100);
    const s = slot("me", [mine, sams], 110);
    assert.equal(s.get("e2")!.hedge, true);
    assert.deepEqual(s.get("e2")!.rival, { ref_id: "e1", target_ref_id: "Acme", belief: 0.95 });
    // Replaced by the owner, the old value is not in the running.
    const corrected = slot("me", [edge("e1", "Leeds", ["sam"], 0, { expired_at: at(10), superseded_by: "e2" }), edge("e2", "Bristol", ["chat:2"], 10)], 20);
    assert.deepEqual([corrected.get("e2")!.hedge, corrected.get("e2")!.rival], [false, undefined]);
  });

  it("a message read again after its fact was corrected brings nothing back", () => {
    const old = edge("e1", "Leeds", ["sam", "msg-leeds"], 50, { expired_at: at(60), superseded_by: "e2" });
    const fixed = edge("e2", "Bristol", ["chat:1"], 60, { expired_at: at(200), superseded_by: "e3" });
    const again = edge("e3", "Leeds", ["sam", "msg-leeds", "run:r9"], 200);
    const s = slot("me", [old, fixed, again], 205);
    assert.equal(s.get("e3")!.belief, 0);
    assert.equal(s.get("e3")!.hedge, true);
    assert.equal(s.get("e3")!.rival!.target_ref_id, "Bristol");
  });

  it("a fact gone unconfirmed past its half-life is hedged; a volatile one sooner", () => {
    assert.equal(slot("me", [edge("e1", "Bristol", [], 0)], 300).get("e1")!.hedge, false);
    assert.equal(slot("me", [edge("e1", "Bristol", [], 0)], 1500).get("e1")!.hedge, true);
    const many = scoreSlot({ subject: "me", edges: [edge("p1", "launch", [], 0)], one: false, volatility: "volatile", people, user, now: at(200) });
    assert.equal(many.get("p1")!.hedge, true);
  });

  it("a change in a slot it depends on, since it was last confirmed, hedges it", () => {
    const gym = edge("g1", "PureGym", [], 300);
    const moved = [edge("h1", "Bristol", [], 0, { expired_at: at(400), superseded_by: "h2" }), edge("h2", "London", [], 400, { valid_at: at(395) })];
    assert.equal(slot("me", [gym], 420, { parents: [moved] }).get("g1")!.hedge, true);
    assert.equal(slot("me", [gym], 420).get("g1")!.hedge, false, "without the link it is stated");
    assert.equal(slot("me", [{ ...gym, last_confirmed_at: at(430) }], 440, { parents: [moved] }).get("g1")!.hedge, false, "confirmed after the move");
  });

  it("a fact that begins later is planned; ended edges are scored but never hedged", () => {
    const s = slot("me", [edge("e1", "London", [], 0, { valid_at: at(200) })], 10);
    assert.equal(s.get("e1")!.planned, true);
    const ended = slot("me", [edge("e1", "Bristol", [], 0, { expired_at: at(5) })], 10).get("e1")!;
    assert.deepEqual([ended.hedge, ended.planned], [false, undefined]);
  });
});
