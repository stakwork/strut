/**
 * The chat check (plans/memory-checks.md): a fact becomes a chat search, and
 * the search's answer is counted inside the window, leaving out the chats
 * named in `exclude_chats`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatQuery, countMatches } from "./check-chats.js";

const ANSWER = [
  "3 messages match 'Stakwork', newest first:",
  "== Contact 'Peel' (chat=02agent) ==",
  "[Me] 2026-11-06T13:01:41Z (uuid=a): i work at stakwork since 2023",
  "== Tribe 'Dev team' (chat=02tribe) ==",
  "[Sam] 2026-11-01T09:00:00Z (uuid=b): the Stakwork deploy is done",
  "[Me] 2026-08-01T09:00:00Z (uuid=c): Stakwork standup moved",
].join("\n");

describe("graph/check-chats", () => {
  it("a fact as a search: the value, and only what the subject wrote when it is about someone else", () => {
    assert.equal(chatQuery({ subject: { name: "Tom", owner: true }, target: { name: "Stakwork" } }), "Stakwork");
    assert.equal(chatQuery({ subject: { name: "Kate Smith" }, target: { name: "Porto" } }), "Porto from:Kate");
    assert.equal(chatQuery({ subject: { name: "Kate" }, target: { name: "Atlas project" } }), '"Atlas project" from:Kate');
    assert.equal(chatQuery({ subject: { name: "Tom", owner: true }, target: { name: "AI" } }), null, "too short to search");
  });

  it("counts the matches in the window, leaving out excluded chats", () => {
    const since = Date.parse("2026-10-07T00:00:00Z");
    assert.deepEqual(countMatches(ANSWER, since), { matched: true, recent: 2 });
    assert.deepEqual(countMatches(ANSWER, since, ["02agent"]), { matched: true, recent: 1 }, "the agent's own chat left out by id");
    assert.deepEqual(countMatches(ANSWER, since, ["peel", "Dev team"]), { matched: true, recent: 0 }, "and by name");
    assert.deepEqual(countMatches("No messages match 'Lisbon'.", since), { matched: false, recent: 0 });
  });
});
