import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKERS_APP, waitingParts } from "./waiting";

describe("a waiting run's links (plans/human-steps.md §9.1)", () => {
  it("a task opens strut/workers on it, for a viewer the app is listed to; anything else is text", () => {
    assert.deepEqual(waitingParts(["task:4f2c", "ans:k1"], true), [{ text: "task:4f2c", app: { name: WORKERS_APP, input: "task=4f2c" } }, { text: "ans:k1" }]);
    assert.deepEqual(waitingParts(["task:4f2c"], false), [{ text: "task:4f2c" }], "a member is not listed the app");
    assert.equal(new URLSearchParams(`app=${encodeURIComponent(WORKERS_APP)}&input=${encodeURIComponent(waitingParts(["task:a b"], true)[0]!.app!.input)}`).get("input"), "task=a+b");
    assert.deepEqual(waitingParts(undefined, true), []);
  });
});
