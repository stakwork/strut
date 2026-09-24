import { test } from "node:test";
import assert from "node:assert/strict";
import { dependsForSave } from "./step-depends";

test("dependsForSave keeps a checked list", () => {
  assert.deepEqual(dependsForSave(undefined, ["a"]), ["a"]);
  assert.deepEqual(dependsForSave([], ["a", "b"]), ["a", "b"]);
});

test("dependsForSave preserves an explicit empty array (parallel step) on a no-op save", () => {
  assert.deepEqual(dependsForSave([], []), []);
});

test("dependsForSave writes [] when the user unchecks every dependency", () => {
  assert.deepEqual(dependsForSave(["a"], []), []);
  assert.deepEqual(dependsForSave("a", []), []);
});

test("dependsForSave leaves an implicitly sequential step implicit", () => {
  assert.equal(dependsForSave(undefined, []), undefined);
  assert.equal(dependsForSave(null, []), undefined);
});
