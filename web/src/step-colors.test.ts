import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PALETTE, paletteKey, stepColors } from "./step-colors";

describe("paletteKey", () => {
  it("core steps wear their own entry", () => {
    assert.equal(paletteKey("agent"), "agent");
    assert.equal(paletteKey("llm"), "llm");
    assert.equal(paletteKey("subflow"), "subflow");
  });
  it("a tool call is the step it ran; a sub-agent its own", () => {
    assert.equal(paletteKey("tool:llm"), "llm");
    assert.equal(paletteKey("tool:agent"), "subagent");
    assert.equal(paletteKey("tool:bash"), "default");
  });
  it("lib steps by type, then by namespace", () => {
    assert.equal(paletteKey("strut/run-workflow"), "run");
    assert.equal(paletteKey("job/start"), "run");
    assert.equal(paletteKey("browser/captcha-ask"), "browser");
    assert.equal(paletteKey("sheets/get-values"), "google");
    assert.equal(paletteKey("gdrive/export-file"), "google");
  });
  it("anything else is default — never an internal entry by name", () => {
    assert.equal(paletteKey("concepts/decide"), "default");
    assert.equal(paletteKey("run"), "default");
    assert.equal(paletteKey("subagent"), "default");
    assert.equal(stepColors("nope"), PALETTE.default);
  });
});
