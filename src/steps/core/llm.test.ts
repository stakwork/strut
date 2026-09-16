import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchema } from "ai";
import llm, { toSdkSchema } from "./llm.js";

// OFFLINE: no model call. This covers the normalization a workflow's `schema:`
// goes through before generateObject. The bug it pins: a YAML workflow can only
// write a plain JSON Schema object, and handed one bare the SDK assumes a lazy
// thunk and throws "schema is not a function".
describe("llm step: toSdkSchema", () => {
  const SDK = Symbol.for("vercel.ai.schema");

  it("wraps a plain JSON Schema object (what YAML can write) in jsonSchema()", async () => {
    const out = (await toSdkSchema({
      type: "object",
      properties: { start: { type: "string" } },
      required: ["start"],
    })) as any;
    assert.equal(out[SDK], true);
    assert.deepEqual(out.jsonSchema.required, ["start"]);
  });

  it("passes a Zod schema through untouched", async () => {
    const s = z.object({ start: z.string() });
    assert.equal(await toSdkSchema(s), s);
  });

  it("passes an already-wrapped SDK schema through untouched", async () => {
    const s = jsonSchema({ type: "object" });
    assert.equal(await toSdkSchema(s), s);
  });

  it("leaves undefined alone (free-form text mode)", async () => {
    assert.equal(await toSdkSchema(undefined), undefined);
  });

  it("the config accepts a JSON Schema object under `schema`", () => {
    const parsed = llm.input.parse({ prompt: "x", schema: { type: "object" } });
    assert.deepEqual(parsed.schema, { type: "object" });
  });
});
