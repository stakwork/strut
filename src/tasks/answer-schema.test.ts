import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MAX_BYTES, answerProblem, answerSchemaProblem, type AnswerSchema } from "./answer-schema.js";

/** plans/human-steps.md §4.5: the subset strut checks, at save and at submit. */

const schema = (raw: unknown): AnswerSchema => {
  const p = answerSchemaProblem(raw);
  assert.equal(p, undefined, p);
  return raw as AnswerSchema;
};

describe("a task type's answer schema", () => {
  it("takes the plan's box on a photo, and an object of fields", () => {
    schema({ type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 });
    schema({
      type: "object",
      title: "Match",
      properties: {
        same: { type: "boolean", description: "the same pet?" },
        breed: { type: "string", enum: ["cat", "dog"] },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        note: { type: "string", maxLength: 500 },
        nothing: { type: "null" },
      },
      required: ["same"],
    });
  });

  it("refuses a keyword strut does not check, naming it", () => {
    for (const [raw, word] of [
      [{ type: "string", pattern: "^a" }, "pattern"],
      [{ type: "string", format: "email" }, "format"],
      [{ type: "object", additionalProperties: true }, "additionalProperties"],
      [{ type: "number", exclusiveMinimum: 0 }, "exclusiveMinimum"],
      [{ type: "object", properties: { a: { type: "string", $ref: "#/x" } } }, "$ref"],
      [{ anyOf: [{ type: "string" }] }, "type"],
    ] as const) {
      const p = answerSchemaProblem(raw);
      assert.ok(p?.includes(word), `${JSON.stringify(raw)} → ${p}`);
    }
  });

  it("refuses a keyword on a type it does not apply to, and a bad type", () => {
    assert.match(answerSchemaProblem({ type: "number", minLength: 2 })!, /"minLength" does not apply to type number/);
    assert.match(answerSchemaProblem({ type: "string", items: { type: "string" } })!, /"items" does not apply/);
    assert.match(answerSchemaProblem({ type: ["string", "null"] })!, /"type" must be one of/);
    assert.match(answerSchemaProblem({ type: "date" })!, /"type" must be one of/);
    assert.match(answerSchemaProblem({})!, /"type" must be one of/);
    assert.match(answerSchemaProblem("string")!, /a schema is an object/);
  });

  it("refuses bounds that make no sense, required names properties lack, enum options that do not fit", () => {
    assert.match(answerSchemaProblem({ type: "array", minItems: 5, maxItems: 4 })!, /"minItems" is above "maxItems"/);
    assert.match(answerSchemaProblem({ type: "string", maxLength: -1 })!, /whole number/);
    assert.match(answerSchemaProblem({ type: "number", minimum: 3, maximum: 1 })!, /"minimum" is above/);
    assert.match(answerSchemaProblem({ type: "object", properties: { a: { type: "string" } }, required: ["b"] })!, /names "b"/);
    assert.match(answerSchemaProblem({ type: "string", enum: [] })!, /non-empty/);
    assert.match(answerSchemaProblem({ type: "string", enum: ["a", 2] })!, /enum\[1\]: expected a string/);
  });

  it("refuses a schema nested deeper than 8", () => {
    let s: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 7; i++) s = { type: "array", items: s };
    schema(s); // 8 levels
    assert.match(answerSchemaProblem({ type: "array", items: s })!, /deeper than 8/);
  });
});

describe("an answer", () => {
  const box = schema({ type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 });
  const match = schema({
    type: "object",
    properties: { same: { type: "boolean" }, breed: { type: "string", enum: ["cat", "dog"] }, n: { type: "integer", minimum: 0 } },
    required: ["same"],
  });

  it("fits", () => {
    assert.equal(answerProblem(box, [1, 2.5, 3, 4]), undefined);
    assert.equal(answerProblem(match, { same: true, breed: "cat", n: 3 }), undefined);
    assert.equal(answerProblem(match, { same: false }), undefined);
  });

  it("does not fit, and says where", () => {
    assert.match(answerProblem(box, [1, 2, 3])!, /^answer: at least 4 items, got 3/);
    assert.match(answerProblem(box, [1, 2, 3, "4"])!, /^answer\[3\]: expected a number, got string/);
    assert.match(answerProblem(match, { breed: "cat" })!, /"same" is required/);
    assert.match(answerProblem(match, { same: true, extra: 1 })!, /"extra" is not a field of this answer/);
    assert.match(answerProblem(match, { same: true, breed: "fox" })!, /answer\.breed: must be one of "cat", "dog"/);
    assert.match(answerProblem(match, { same: true, n: 1.5 })!, /answer\.n: expected a whole number/);
    assert.match(answerProblem(match, { same: true, n: -1 })!, /at least 0/);
    assert.match(answerProblem(match, [true])!, /expected an object, got a list/);
    assert.match(answerProblem(box, undefined)!, /an answer is required/);
    assert.match(answerProblem(schema({ type: "number" }), Number.NaN)!, /expected a number, got NaN/);
  });

  it("is at most 256 KB as JSON and nests at most 8 levels", () => {
    const text = schema({ type: "string" });
    assert.equal(answerProblem(text, "x".repeat(ANSWER_MAX_BYTES - 2)), undefined);
    assert.match(answerProblem(text, "x".repeat(ANSWER_MAX_BYTES))!, /bytes as JSON; at most/);
    // An array with no `items` checks nothing inside it, but the depth holds.
    const any = schema({ type: "array" });
    let deep: unknown = 1;
    for (let i = 0; i < 8; i++) deep = [deep];
    assert.equal(answerProblem(any, deep), undefined);
    assert.match(answerProblem(any, [deep])!, /deeper than 8/);
  });
});
