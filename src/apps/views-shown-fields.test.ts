import { test } from "node:test";
import assert from "node:assert/strict";
import { isInternalKey, shownFields } from "./views/src/lib/shown-fields.js";

const show = {
  title: "Cover / Portada",
  ok: true,
  flag: "missing_content",
  index: 0,
  key: "a|b",
  book_title: "Dune",
  pos: 0,
  hash: "3592082823744535070191037687574482087991".repeat(2),
  is_cover: true,
  idem: "0.q11e4z4q8k",
  replay: false,
};

test("shownFields hides bookkeeping keys and opaque tokens", () => {
  assert.deepEqual(shownFields(show), [["flag", "missing_content"]]);
});

test("shownFields hides bare flags and a book workflow's bookkeeping, keeps real fields", () => {
  const leaked = { title: "Page 10", pending: true, isCover: false, backCover: false, numberStatus: "none", bookTitle: "Dune", bookAuthor: "Herbert", jevError: "x", note: "Blurry" };
  assert.deepEqual(shownFields(leaked), [["note", "Blurry"]]);
  assert.deepEqual(shownFields({ ...leaked, fields: ["pending"] }), [["pending", "true"]], "an opt-in list still shows what it names");
});

test("isInternalKey: names, prefixes, id suffixes, opaque values", () => {
  for (const k of ["id", "Idem", "_x", "$x", "user_id", "userId", "Replay"]) assert.ok(isInternalKey(k), k);
  for (const k of ["flag", "note", "paid"]) assert.ok(!isInternalKey(k), k);
  assert.ok(isInternalKey("note", "a".repeat(32)));
  assert.ok(!isInternalKey("note", "a ".repeat(20)));
});

test("show.fields (or display) is an opt-in list, in order", () => {
  assert.deepEqual(shownFields({ ...show, fields: ["book_title", "key", "missing"] }), [["book_title", "Dune"], ["key", "a|b"]]);
  assert.deepEqual(shownFields({ a: "x", b: "y", display: ["b", "a"] }), [["b", "y"], ["a", "x"]]);
});
