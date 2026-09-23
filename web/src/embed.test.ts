import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLinkParams } from "./embed";

test("deepLinkParams keeps only the deep-link keys", () => {
  assert.deepEqual(
    deepLinkParams("?wf=clip&run=123&v=v2&chat=c1&key=secret&embed_origin=https://hive.test&x=1"),
    { wf: "clip", run: "123", v: "v2", chat: "c1" },
  );
});

test("deepLinkParams carries the builder's open question", () => {
  assert.deepEqual(deepLinkParams("?chat=c1&elicit=e1"), { chat: "c1", elicit: "e1" });
});

test("deepLinkParams drops empty values", () => {
  assert.deepEqual(deepLinkParams("?wf=&run=5"), { run: "5" });
  assert.deepEqual(deepLinkParams(""), {});
});
