/** The canvas form's key order (src/canvas-form.ts): what the web editor's
 *  Publish writes, and what a package update reads back. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canvasOrder } from "./canvas-form.js";

describe("the canvas form of a workflow", () => {
  const steps = [{ id: "a", type: "log" }];

  it("orders name, input, steps, params, then every other key as it came, and peer last", () => {
    const doc = { description: "d", peer: true, params: { x: 1 }, claims: [], steps, input: { q: { type: "string" } }, name: "old", sealed: true };
    assert.deepEqual(Object.keys(canvasOrder(doc, "acme/linear/sync")), ["name", "input", "steps", "params", "description", "claims", "sealed", "peer"]);
    assert.equal(canvasOrder(doc, "acme/linear/sync")["name"], "acme/linear/sync", "the name is the caller's, whatever the file says");
  });

  it("leaves out an input that is not set, params with nothing in them, and a peer flag that is off", () => {
    assert.deepEqual(Object.keys(canvasOrder({ steps, input: null, params: {}, peer: false, description: "d" }, "wf")), ["name", "steps", "description"]);
    assert.deepEqual(Object.keys(canvasOrder({ steps, params: null }, "wf")), ["name", "steps"]);
    assert.deepEqual(canvasOrder({ steps, peer: "person" }, "wf"), { name: "wf", steps, peer: "person" });
  });

  it("is its own fixed point", () => {
    const once = canvasOrder({ description: "d", steps, params: { x: 1 }, peer: true }, "wf");
    assert.deepEqual(Object.entries(canvasOrder(once, "wf")), Object.entries(once));
  });
});
