import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ElicitationSchema } from "./api";
import { contentToSubmit, fieldsOf, initialContent, missingRequired } from "./elicitation";

const schema: ElicitationSchema = {
  type: "object",
  properties: {
    repo: { type: "string", title: "Repository", description: "owner/name" },
    env: { type: "string", enum: ["staging", "production"], default: "staging" },
    region: { type: "string", oneOf: [{ const: "us", title: "United States" }, { const: "eu", title: "Europe" }] },
    count: { type: "integer", minimum: 1 },
    dryRun: { type: "boolean", default: true },
    channels: { type: "array", items: { enum: ["a", "b"] }, minItems: 1 },
    tags: { type: "array", items: { anyOf: [{ const: "x", title: "X" }, { const: "y" }] } },
  },
  required: ["repo", "channels"],
};

describe("elicitation form helpers", () => {
  it("fieldsOf maps the subset onto ConfigField kinds, with titles as labels", () => {
    const f = Object.fromEntries(fieldsOf(schema).map((x) => [x.name, x]));
    assert.deepEqual(f.repo, { name: "repo", kind: "string", required: true, label: "Repository", description: "owner/name" });
    assert.deepEqual(f.env, { name: "env", kind: "enum", required: false, default: "staging", enumValues: ["staging", "production"] });
    assert.deepEqual(f.region, { name: "region", kind: "enum", required: false, enumValues: ["us", "eu"], enumLabels: { us: "United States", eu: "Europe" } });
    assert.deepEqual(f.count, { name: "count", kind: "number", required: false });
    assert.deepEqual(f.dryRun, { name: "dryRun", kind: "boolean", required: false, default: true });
    assert.deepEqual(f.channels, { name: "channels", kind: "multi", required: true, enumValues: ["a", "b"] });
    assert.deepEqual(f.tags, { name: "tags", kind: "multi", required: false, enumValues: ["x", "y"], enumLabels: { x: "X" } });
    assert.deepEqual(fieldsOf(schema).map((x) => x.name), Object.keys(schema.properties), "schema order");
  });

  it("initialContent seeds the defaults", () => {
    assert.deepEqual(initialContent(schema), { env: "staging", dryRun: true });
  });

  it("missingRequired names the empty required fields", () => {
    assert.deepEqual(missingRequired(schema, initialContent(schema)), ["repo", "channels"]);
    assert.deepEqual(missingRequired(schema, { repo: "a/b", channels: [] }), ["channels"]);
    assert.deepEqual(missingRequired(schema, { repo: "a/b", channels: ["a"] }), []);
  });

  it("contentToSubmit keeps the schema's fields and drops empties", () => {
    assert.deepEqual(
      contentToSubmit(schema, { repo: "a/b", env: "", region: undefined, count: 2, dryRun: false, channels: ["a"], tags: [], extra: 1 }),
      { repo: "a/b", count: 2, dryRun: false, channels: ["a"] },
    );
  });
});
