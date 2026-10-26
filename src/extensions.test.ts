import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { applyModelWrappers, applyToolWrappers, registerModelWrapper, registerSetting, registerToolWrapper, resolveSettings, validateSettings } from "./extensions.js";
import { resolveModel } from "./llm.js";

describe("extension points", () => {
  it("resolveModel with nothing registered returns the model untouched", async () => {
    const info = { provider: "anthropic", modelId: "m", routed: false };
    const m = {};
    assert.equal(await applyModelWrappers(m, info), m);
    const tools = { t: { execute: () => 1 } };
    const exec = tools.t.execute;
    applyToolWrappers(tools);
    assert.equal(tools.t.execute, exec);
    const r = await resolveModel({ model: "claude-sonnet-4-5", secrets: { get: async () => "test-key" } as any });
    assert.match(String(r.model.provider), /^anthropic/);
    assert.equal(r.model.specificationVersion, "v4");
    assert.equal(r.model.doGenerate.name === "doGenerate" || typeof r.model.doGenerate === "function", true);
  });

  it("wrappers apply in order; settings resolve highest level first, whole", () => {
    const seen: string[] = [];
    registerModelWrapper((m, i) => { seen.push("a:" + i.modelId); return { ...m, a: 1 }; });
    registerModelWrapper(async (m) => { seen.push("b"); return { ...m, b: 1 }; });
    registerToolWrapper((t) => void (t["x"] = 1));
    registerSetting({ key: "knob", schema: z.union([z.literal("on"), z.object({ n: z.number() })]), normalize: (v) => (v === "on" ? { n: 1 } : v) });
    return applyModelWrappers({}, { provider: "p", modelId: "m", routed: false }).then((m) => {
      assert.deepEqual(m, { a: 1, b: 1 });
      assert.deepEqual(seen, ["a:m", "b"]);
      const t: Record<string, any> = {};
      applyToolWrappers(t);
      assert.equal(t["x"], 1);
      assert.deepEqual(resolveSettings({ deployment: { knob: "on", d: 1 }, workflow: { knob: { n: 2 } }, run: undefined, step: undefined }), { knob: { n: 2 }, d: 1 });
      assert.deepEqual(resolveSettings({ deployment: { knob: { n: 9 } }, workflow: { knob: "on" }, run: { knob: { n: 3 } }, step: { knob: "on" } }), { knob: { n: 1 } });
      assert.deepEqual(validateSettings({ knob: "on" }), []);
      assert.match(validateSettings({ knob: "off" })[0]!, /settings\.knob/);
      assert.match(validateSettings({ nope: 1 })[0]!, /unknown setting "nope"/);
      assert.match(validateSettings([])[0]!, /mapping/);
    });
  });
});
