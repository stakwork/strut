import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPeer, readPeer, togglePeer } from "./peer-flag";

describe("peer flag", () => {
  it("reads true and person, everything else is off", () => {
    assert.equal(readPeer({ peer: true }), true);
    assert.equal(readPeer({ peer: "person" }), "person");
    assert.equal(readPeer({ peer: false }), undefined);
    assert.equal(readPeer({}), undefined);
    assert.equal(readPeer(null), undefined);
  });
  it("toggles on to true and off to absent (person turns off)", () => {
    assert.equal(togglePeer(undefined), true);
    assert.equal(togglePeer(true), undefined);
    assert.equal(togglePeer("person"), undefined);
  });
  it("turning a published person flag off and on again restores person, never true", () => {
    const off = togglePeer("person", "person");
    assert.equal(off, undefined);
    assert.equal(togglePeer(off, "person"), "person");
    assert.equal(togglePeer(undefined, true), true);
    assert.equal(togglePeer(undefined, undefined), true);
  });
  it("applies by setting or removing the key, keeping the rest", () => {
    assert.deepEqual(applyPeer({ name: "a", steps: [] }, true), { name: "a", steps: [], peer: true });
    assert.deepEqual(applyPeer({ name: "a", peer: true, sealed: true }, undefined), { name: "a", sealed: true });
    assert.deepEqual(applyPeer({ peer: "person" }, "person"), { peer: "person" });
  });
});
