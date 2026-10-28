import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_NAME, nextVersion, packageOf } from "./package-release";

test("packageOf reads the package off a workflow name with a prefix", () => {
  assert.equal(packageOf("stakwork/tools/summarize"), "stakwork/tools");
  assert.equal(packageOf("acme/demo/x/deep"), "acme/demo");
  assert.equal(packageOf("acme/x"), null);
  assert.equal(packageOf("summarize"), null);
});

test("PACKAGE_NAME takes two lowercase segments", () => {
  assert.ok(PACKAGE_NAME.test("stakwork/tools"));
  assert.ok(!PACKAGE_NAME.test("Stakwork/tools"));
  assert.ok(!PACKAGE_NAME.test("stakwork/tools_x"));
});

test("nextVersion raises the last number", () => {
  assert.equal(nextVersion(undefined), "1.0.0");
  assert.equal(nextVersion("1.4.0"), "1.4.1");
  assert.equal(nextVersion("1.0.9"), "1.0.10");
  assert.equal(nextVersion("v3"), "v4");
  assert.equal(nextVersion("2.0.0-rc"), "2.0.1-rc");
  assert.equal(nextVersion("beta"), "beta");
});
