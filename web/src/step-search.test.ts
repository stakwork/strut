import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchSteps } from "./step-search";

const steps = [
  { type: "http", description: "Make an HTTP request" },
  { type: "log", description: "Log a message" },
  { type: "slack/post-message", description: "Post a message to a Slack channel" },
  { type: "exec" },
];
const types = (q: string) => searchSteps(steps, q).map((s) => s.type);

describe("searchSteps", () => {
  it("returns everything, in order, for an empty query", () => {
    assert.deepEqual(types("  "), ["http", "log", "slack/post-message", "exec"]);
  });
  it("needs every word, in the name or the description", () => {
    assert.deepEqual(types("slack post"), ["slack/post-message"]);
    assert.deepEqual(types("slack http"), []);
  });
  it("ranks a name hit above a description hit, ignoring case", () => {
    assert.deepEqual(types("MESSAGE"), ["slack/post-message", "log"]);
  });
});
