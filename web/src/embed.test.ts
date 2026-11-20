import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLinkParams, embedPage } from "./embed";

test("deepLinkParams keeps only the deep-link keys", () => {
  assert.deepEqual(
    deepLinkParams("?wf=clip&run=123&v=v2&chat=c1&key=secret&embed_origin=https://hive.test&x=1"),
    { wf: "clip", run: "123", v: "v2", chat: "c1" },
  );
});

test("deepLinkParams carries an app and what it is opened with", () => {
  assert.deepEqual(deepLinkParams("?app=bench&input=view%3D%252Fruns&solo=1"), { app: "bench", input: "view=%2Fruns" });
});

test("deepLinkParams carries the builder's open question", () => {
  assert.deepEqual(deepLinkParams("?chat=c1&elicit=e1"), { chat: "c1", elicit: "e1" });
});

test("deepLinkParams drops empty values", () => {
  assert.deepEqual(deepLinkParams("?wf=&run=5"), { run: "5" });
  assert.deepEqual(deepLinkParams(""), {});
});

test("embedPage is the framing host's own page, on the origin that asked for reports", () => {
  const host = "https://box.test";
  assert.equal(embedPage("?app=strut%2Fjamie&embed_page=https%3A%2F%2Fbox.test%2F", true, host), "https://box.test/");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fbox.test%2Fapps%2Fbench", true, host), "https://box.test/apps/bench");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fbox.test%2F", false, host), undefined, "not framed: no host page");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fevil.test%2F", true, host), undefined, "another site's page");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fbox.test%2F", true, null), undefined, "no host asked for reports");
  assert.equal(embedPage("?embed_page=not%20a%20url", true, host), undefined);
  assert.equal(embedPage("?app=x", true, host), undefined);
  assert.equal(deepLinkParams("?app=x&embed_page=https%3A%2F%2Fbox.test%2F").embed_page, undefined, "never a deep-link param");
});
