import { test } from "node:test";
import assert from "node:assert/strict";
import { displayActor } from "./actor";

test("displayActor keeps the part before the first dash", () => {
  assert.equal(displayActor("evanfeenstra-s8fhs8efhs8ehf"), "evanfeenstra");
  assert.equal(displayActor("alice-1-extra"), "alice");
  assert.equal(displayActor("plain"), "plain");
  assert.equal(displayActor("-leading"), "-leading");
});
