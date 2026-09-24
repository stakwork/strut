import { describe, it } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import { canvasPublishDump } from "./helpers";

describe("canvasPublishDump", () => {
  it("writes a declared input contract back and omits it when absent", () => {
    const input = { city: { type: "string" as const, required: true }, count: { type: "number" as const, required: false, default: 3 } };
    const dumped = canvasPublishDump("wf", [{ id: "a", type: "log", config: { message: "hi" } }], { model: "x" }, input);
    const round = yaml.load(yaml.dump(dumped, { lineWidth: 120, noRefs: true })) as { input?: unknown; params?: unknown };
    assert.deepEqual(round.input, input);
    assert.deepEqual(round.params, { model: "x" });

    const open = canvasPublishDump("wf", [{ id: "a", type: "log", config: {} }], null, null);
    assert.equal("input" in open, false);
    assert.equal("params" in open, false);
  });
});
