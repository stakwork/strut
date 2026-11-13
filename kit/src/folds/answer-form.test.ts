import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerOf, contentToSubmit, fieldsOf, formProblem, initialContent, missingRequired, type FormSchema } from "./answer-form.js";

/** A task type's answer, as an admin saved it (src/tasks/answer-schema.ts's subset). */
const MATCH: FormSchema = {
  type: "object",
  properties: {
    same: { type: "boolean", title: "Same pet?" },
    rating: { type: "integer", enum: [1, 2, 3] },
    score: { type: "number", minimum: 0 },
    count: { type: "integer" },
    marks: { type: "array", items: { type: "string", enum: ["coat", "ears"] } },
    note: { type: "string", default: "" },
  },
  required: ["same", "rating"],
};

describe("answer-form: a flat form over a JSON Schema", () => {
  it("formProblem: plain fields draw; a nested object or a list of numbers does not", () => {
    assert.equal(formProblem(MATCH), null);
    assert.equal(formProblem({ type: "object", properties: { box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } } }), "box is a list of values a form cannot pick from (no enum)");
    assert.equal(formProblem({ type: "object", properties: { where: { type: "object", properties: {} } } }), "where is a nested object");
    assert.equal(formProblem({ type: "array", items: { type: "number" } }), "the answer is not an object of fields");
    assert.equal(formProblem({ type: "object", properties: {} }), "the answer has no fields");
    assert.equal(formProblem(null), "the answer is not an object of fields");
  });

  it("fieldsOf: an answer's selects take only their values; a question's take the person's own words too", () => {
    const f = Object.fromEntries(fieldsOf(MATCH, { other: false }).map((x) => [x.name, x]));
    assert.deepEqual(f.same, { name: "same", kind: "boolean", required: true, label: "Same pet?" });
    assert.deepEqual(f.rating, { name: "rating", kind: "enum", required: true, enumValues: ["1", "2", "3"] });
    assert.deepEqual(f.marks, { name: "marks", kind: "multi", required: false, enumValues: ["coat", "ears"] });
    assert.equal(f.count!.kind, "number");
    assert.equal(fieldsOf(MATCH)[1]!.other, true, "a question's select by default");
  });

  it("answerOf: numbers read, picks mapped back to the schema's values, empties left out, the required named", () => {
    assert.deepEqual(answerOf(MATCH, { same: true }), { problem: "rating is required" });
    assert.deepEqual(answerOf(MATCH, {}), { problem: "same, rating are required" });
    assert.deepEqual(answerOf(MATCH, { same: false, rating: "2", score: "1.5", count: "3", marks: ["ears"], note: "" }), {
      answer: { same: false, rating: 2, score: 1.5, count: 3, marks: ["ears"] },
    });
    assert.deepEqual(answerOf(MATCH, { same: true, rating: "1", count: "2.5" }), { problem: "count is a whole number" });
    assert.deepEqual(answerOf(MATCH, { same: true, rating: "1", score: "lots" }), { problem: "score is a number" });
  });

  it("initialContent, missingRequired and contentToSubmit: the defaults, what is left to fill, what is sent", () => {
    assert.deepEqual(initialContent(MATCH), { note: "" });
    assert.deepEqual(missingRequired(MATCH, { same: false }), ["rating"], "false is an answer");
    assert.deepEqual(contentToSubmit(MATCH, { same: true, note: "", marks: [], other: 1 }), { same: true });
  });
});
