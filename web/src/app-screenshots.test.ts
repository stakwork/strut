import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newestVersion, savedNote } from "./app-screenshots";

describe("app-screenshots", () => {
  it("newestVersion: by number, not by text", () => {
    assert.equal(newestVersion({ v1: {}, v10: {}, v9: {} }), "v10");
    assert.equal(newestVersion({}), undefined);
  });

  it("savedNote: live, a draft, and nothing new", () => {
    assert.equal(savedNote({ version: "v4", changed: true, live: true }), "Saved as v4, now live.");
    assert.match(savedNote({ version: "v4", changed: true, live: false, liveVersion: "v2" }), /a draft: v2 stays live until you make v4 live/);
    assert.equal(savedNote({ version: "v1", changed: false, live: true }), "That list is exactly v1's, so no new version was made: v1 is live again.");
    assert.equal(savedNote({ version: "v1", changed: false, live: false }), "That list is exactly v1's, so no new version was made.");
  });
});
