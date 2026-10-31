import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summaryHead, labelsOf } from "./proposal-view.js";

describe("proposal view", () => {
  it("the head of a summary is its first line, cut when long", () => {
    assert.equal(summaryHead("one\ntwo"), "one");
    assert.equal(summaryHead("x".repeat(300)).length, 160);
    assert.ok(summaryHead("x".repeat(300)).endsWith("…"));
  });
  it("labels come from the card", () => {
    assert.deepEqual(labelsOf(undefined), { accept: "Accept", reject: "Reject" });
    assert.deepEqual(labelsOf({ v: 1, title: "t", fields: [], full: true, actions: { accept: "Install", reject: "No" } }), { accept: "Install", reject: "No" });
  });
});
