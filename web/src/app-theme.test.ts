import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPeelApp, peelTheme } from "./app-theme.js";

describe("the Peel look, opt-in", () => {
  it("is strut's worker and staff apps, or any app that says so", () => {
    assert.equal(isPeelApp("strut/worker"), true);
    assert.equal(isPeelApp("strut/staff"), true);
    assert.equal(isPeelApp("strut/jamie"), false);
    assert.equal(isPeelApp("acme/tasks", "peel"), true);
  });
  it("follows the address, then the browser; other apps keep the host's default", () => {
    assert.equal(peelTheme("light", true, () => false), "light");
    assert.equal(peelTheme(undefined, true, () => true), "light");
    assert.equal(peelTheme(undefined, true, () => false), "dark");
    assert.equal(peelTheme(undefined, false, () => true), undefined);
    assert.equal(peelTheme("dark", false), "dark");
  });
});
