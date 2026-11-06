/**
 * How far to trust a fact now (`fact-score.ts`), on slots built by hand:
 * who backed it, each sayer once; how long since it was last backed, by the
 * edge type's volatility; an ended value kept in the running when a less
 * trusted sayer replaced it; a message read again that brings nothing back;
 * a check finding the expected activity, or not; the user saying it is
 * false; an open question; and the status and stance that follow. Evidence rows, and sources for a fact
 * written before claims, give the same answer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combine, currencyOf, scoreSlot, type EvidenceIn, type Person, type SlotEdge, type SlotInput } from "./fact-score.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const at = (d: number) => T0 + d * DAY;

const people = new Map<string, Person>([
  ["me", { name: "Tom", owner: true }],
  ["kate", { name: "Kate", owner: false }],
  ["sam", { name: "Sam", owner: false }],
]);
const user = { ref_id: "me", name: "Tom" };

const edge = (ref_id: string, target: string, sources: string[], d: number, extra: Partial<SlotEdge> = {}): SlotEdge => ({
  ref_id, target, sources, valid_at: null, expired_at: null, superseded_by: null, last_confirmed_at: at(d), created_at: at(d), ...extra,
});
const said = (id: string, by: string | undefined, d: number, strength = 1): EvidenceIn => ({ id, ...(by ? { said_by: by } : {}), observed_at: at(d), strength });
const slot = (subject: string, edges: SlotEdge[], now: number, extra: Partial<SlotInput> = {}) => scoreSlot({ subject, edges, one: true, volatility: "stable", people, user, now: at(now), ...extra });
const view = (s: Map<string, { status: string; stance?: string }>, id: string) => [s.get(id)!.status, s.get(id)!.stance];

describe("fact-score", () => {
  it("belief counts each sayer once, and two people agreeing beat one", () => {
    assert.ok(combine(["owner"]) > combine(["self"]) && combine(["self"]) > combine(["other"]));
    assert.ok(combine(["other", "other"]) > combine(["other"]));
    // Sam saying it five times is one sayer, and only Sam: hearsay, cited.
    const s = slot("kate", [edge("e1", "vegetarian", ["sam", "m1", "m2", "m3"], 0, { evidence: [said("a", "sam", 0), said("b", "sam", 0), said("c", "sam", 1)] })], 2, { volatility: "evolving" });
    assert.equal(s.get("e1")!.belief, Math.round(combine(["other"]) * 100) / 100);
    assert.deepEqual(s.get("e1")!.evidence.sayers, [{ ref_id: "sam", name: "Sam", kind: "other" }]);
    assert.deepEqual(view(s, "e1"), ["hearsay", "cite"]);
    assert.equal(s.get("e1")!.evidence.items!.length, 3);
  });

  it("the user's word, fresh and uncontested, is stated", () => {
    const s = slot("me", [edge("e1", "Acme", ["chat:1", "run:r1"], 0, { evidence: [said("a", undefined, 0)] })], 1);
    assert.deepEqual(s.get("e1")!.evidence.sayers, [{ ref_id: "me", name: "Tom", kind: "owner" }]);
    assert.deepEqual(view(s, "e1"), ["supported", "state"]);
  });

  it("evidence and sources give the same answer for the same mentions", () => {
    const old = slot("kate", [edge("e1", "Porto", ["kate", "m1"], 0)], 40);
    const now = slot("kate", [edge("e1", "Porto", ["kate", "m1"], 0, { evidence: [said("a", "kate", 0)] })], 40);
    const { items, ...withEvidence } = now.get("e1")!.evidence;
    assert.ok(items);
    assert.deepEqual({ ...now.get("e1")!, evidence: withEvidence }, old.get("e1"));
  });

  it("currency halves per half-life after a grace period, a static fact never fades, and a fresh mention restarts it", () => {
    const e = edge("e1", "Bristol", [], 0);
    assert.equal(currencyOf(e, "stable", at(10)), 1, "inside the grace period");
    assert.ok(Math.abs(currencyOf(e, "stable", at(14 + 3 * 365)) - 0.5) < 1e-9, "half after one half-life");
    assert.equal(currencyOf(e, "static", at(5000)), 1);
    assert.equal(currencyOf({ ...e, evidence: [said("a", undefined, 0), said("b", undefined, 1500)] }, "stable", at(1510)), 1, "the newest mention counts");
    assert.equal(currencyOf(e, undefined, at(14 + 3 * 365)), currencyOf(e, "stable", at(14 + 3 * 365)), "unset is stable");
  });

  it("old for its kind is stale and cited; very old is asked", () => {
    assert.deepEqual(view(slot("me", [edge("e1", "Bristol", [], 0)], 300), "e1"), ["supported", "state"]);
    assert.deepEqual(view(slot("me", [edge("e1", "Bristol", [], 0)], 1200), "e1"), ["stale", "cite"]);
    assert.deepEqual(view(slot("me", [edge("e1", "Bristol", [], 0)], 2600), "e1"), ["stale", "ask"]);
    const project = scoreSlot({ subject: "me", edges: [edge("p1", "launch", [], 0)], one: false, volatility: "volatile", people, user, now: at(200) });
    assert.deepEqual(view(project, "p1"), ["stale", "ask"], "a volatile fact quiet for months");
    assert.deepEqual(view(slot("me", [edge("b1", "14 March", [], 0)], 2000, { volatility: "static" }), "b1"), ["supported", "state"], "a birthday never goes stale");
  });

  it("hearsay that replaced the owner's fact is disputed and cited, with the owner's value as its rival", () => {
    const mine = edge("e1", "Acme", ["chat:1"], 0, { expired_at: at(100), superseded_by: "e2" });
    const sams = edge("e2", "Globex", ["sam", "m2"], 100);
    const s = slot("me", [mine, sams], 110);
    assert.deepEqual(view(s, "e2"), ["disputed", "cite"]);
    assert.deepEqual(s.get("e2")!.rival, { ref_id: "e1", target_ref_id: "Acme", belief: 0.95 });
    // Replaced by the owner, the old value is not in the running.
    const corrected = slot("me", [edge("e1", "Leeds", ["sam"], 0, { expired_at: at(10), superseded_by: "e2" }), edge("e2", "Bristol", ["chat:2"], 10)], 20);
    assert.deepEqual([...view(corrected, "e2"), corrected.get("e2")!.rival], ["supported", "state", undefined]);
  });

  it("a message read again after its fact was corrected brings nothing back", () => {
    const old = edge("e1", "Leeds", ["sam", "msg-leeds"], 50, { expired_at: at(60), superseded_by: "e2" });
    const fixed = edge("e2", "Bristol", ["chat:1"], 60, { expired_at: at(200), superseded_by: "e3" });
    const again = edge("e3", "Leeds", ["sam", "msg-leeds", "run:r9"], 200);
    const s = slot("me", [old, fixed, again], 205);
    assert.equal(s.get("e3")!.belief, 0);
    assert.deepEqual(view(s, "e3"), ["unknown", "ask"]);
  });

  it("the user saying it is false refutes it, whoever else backed it", () => {
    const e = edge("e1", "vegan", ["sam"], 0, { evidence: [said("a", "sam", 0), said("b", undefined, 20, -1)] });
    const s = slot("me", [e], 25, { volatility: "evolving" });
    assert.deepEqual([...view(s, "e1"), s.get("e1")!.belief], ["refuted", "ask", 0]);
    // Backed again after the refutation, it stands.
    const back = slot("me", [{ ...e, evidence: [...e.evidence!, said("c", undefined, 30)] }], 35, { volatility: "evolving" });
    assert.equal(back.get("e1")!.status, "supported");
  });

  it("a check that finds the expected activity backs it, as its own kind of source; a quiet one makes it stale, ask", () => {
    const found = said("c1", undefined, 1500);
    const e = edge("w1", "Stakwork", ["chat:1"], 0, { evidence: [said("a", undefined, 0), { ...found, check: "hive/activity" }] });
    const s = slot("me", [e], 1510);
    assert.deepEqual(view(s, "w1"), ["supported", "state"], "nobody restated it, but the activity is there");
    assert.ok(s.get("w1")!.evidence.sayers.some((x) => x.kind === "check" && x.name === "hive/activity"));
    const quiet = slot("me", [{ ...e, evidence: [said("a", undefined, 1490), { id: "c2", observed_at: at(1500), strength: -0.5, check: "hive/activity" }] }], 1505);
    assert.deepEqual(view(quiet, "w1"), ["stale", "ask"], "said lately, but the expected activity is missing");
  });

  it("the user ending a fact, then saying it is false: refuted, whoever else backed it (the vegan story)", () => {
    const sams = [said("a", "sam", 0), said("b", "sam", 1)];
    const e = edge("v1", "vegan", ["sam"], 0, { evidence: [...sams, said("c", undefined, 2, -1)] });
    assert.deepEqual(view(slot("me", [e], 3, { volatility: "evolving" }), "v1"), ["refuted", "ask"]);
    assert.deepEqual(slot("me", [e], 3).get("v1")!.evidence.sayers, [{ ref_id: "sam", name: "Sam", kind: "other" }], "the refutation is not a sayer of it");
  });

  it("an open question is reported, so it is not asked twice", () => {
    const e = edge("e1", "Porto", ["kate"], 0);
    assert.equal(slot("kate", [e], 2600, { open: new Set(["e1"]) }).get("e1")!.open_check, true);
    assert.equal(slot("kate", [e], 2600).get("e1")!.open_check, undefined);
  });

  it("an unanswered ask stays ask until it is answered: the read alone records nothing", () => {
    const e = edge("e1", "Porto", ["kate"], 0);
    assert.equal(slot("kate", [e], 2600).get("e1")!.stance, "ask");
    assert.equal(slot("kate", [e], 2601).get("e1")!.stance, "ask", "the question is opened by graph/verify-facts, not the read");
  });

  it("a fact that begins later is planned; an ended one has a status but no stance", () => {
    assert.equal(slot("me", [edge("e1", "London", [], 0, { valid_at: at(200) })], 10).get("e1")!.planned, true);
    const ended = slot("me", [edge("e1", "Bristol", [], 0, { expired_at: at(5) })], 10).get("e1")!;
    assert.deepEqual([ended.stance, ended.planned], [undefined, undefined]);
  });
});
