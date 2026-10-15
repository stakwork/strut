import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as strut from "./index.js";

describe("dumpYaml / loadYaml — YAML for a step that can import only strut", () => {
  it("are on the barrel and round-trip a value", () => {
    const value = { services: { postgres: { image: "postgres:15", ports: ["5432:5432"] } }, volumes: { data: null } };
    assert.deepEqual(strut.loadYaml(strut.dumpYaml(value)), value);
  });

  it("fold at strut's width, not js-yaml's 80, and write a repeated object out each time", () => {
    const command = `sh -c '${"x".repeat(100)}'`;
    const env = { A: "1" };
    const text = strut.dumpYaml({ a: { command, environment: env }, b: { environment: env } });
    assert.ok(text.split("\n").some((l) => l.startsWith("  command: ") && l.includes("x".repeat(100))), "a 108-char command stays on its line");
    assert.ok(!/[&*]ref_/.test(text), "no anchors");
    assert.equal(text.match(/A: '1'/g)?.length, 2);
  });

  it("takes js-yaml's options over strut's, and throws on text that is not YAML", () => {
    assert.match(strut.dumpYaml({ a: "x".repeat(100) }, { lineWidth: 40 }), /a: >-/);
    assert.throws(() => strut.loadYaml("a: [1, 2"), /YAML|unexpected end/i);
  });
});
