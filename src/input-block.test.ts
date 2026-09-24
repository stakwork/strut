import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inputSchema, parseInputBlock } from "./input-block.js";

describe("parseInputBlock", () => {
  it("accepts a block as written, including an empty one", () => {
    assert.deepEqual(parseInputBlock({}), {});
    const block = { url: { type: "string", description: "where" }, n: { type: "number", default: 3 } };
    assert.deepEqual(parseInputBlock(block), block);
  });

  it("rejects a bad block with an error naming the field", () => {
    assert.throws(() => parseInputBlock(["url"]), /must be a mapping/);
    assert.throws(() => parseInputBlock({ url: "string" }), /"url" must be a mapping/);
    assert.throws(() => parseInputBlock({ url: { type: "date" } }), /"url": type must be one of/);
    assert.throws(() => parseInputBlock({ "my-url": { type: "string" } }), /identifier/);
    assert.throws(() => parseInputBlock({ url: { type: "string", requried: true } }), /unknown key "requried"/);
    assert.throws(() => parseInputBlock({ url: { type: "string", required: "yes" } }), /`required` must be/);
    assert.throws(() => parseInputBlock({ n: { type: "number", default: "3" } }), /default "3" is not a number/);
    assert.throws(() => parseInputBlock({ j: { type: "json", default: () => 1 } }), /is not a json/);
  });
});

describe("inputSchema", () => {
  const schema = inputSchema(
    parseInputBlock({
      url: { type: "string" },
      limit: { type: "number", default: 10 },
      dryRun: { type: "boolean", required: false },
      extra: { type: "json", required: false },
    }),
  );

  it("requires a field unless it has a default or says required: false", () => {
    assert.equal(schema.safeParse({}).success, false);
    assert.deepEqual(schema.parse({ url: "x" }), { url: "x", limit: 10 });
  });

  it("lets a sent value override a default, and fails a wrong type", () => {
    assert.deepEqual(schema.parse({ url: "x", limit: 2, dryRun: true, extra: [1, { a: null }] }), {
      url: "x",
      limit: 2,
      dryRun: true,
      extra: [1, { a: null }],
    });
    assert.equal(schema.safeParse({ url: 1 }).success, false);
    assert.equal(schema.safeParse({ url: "x", limit: "2" }).success, false);
  });

  it("drops keys the block does not name", () => {
    assert.deepEqual(schema.parse({ url: "x", stray: 1 }), { url: "x", limit: 10 });
  });
});
