import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectInputRefs,
  inputSchemaFromContract,
  parseInputContract,
  undeclaredInputRefs,
  type InputContract,
} from "./input-contract.js";
import type { Step } from "./core.js";

describe("parseInputContract", () => {
  it("accepts an empty contract", () => {
    assert.deepEqual(parseInputContract({}), {});
  });

  it("keeps YAML insertion order and omits absent default and description", () => {
    const contract = parseInputContract({
      city: { type: "string", required: true, description: "where" },
      count: { type: "number", required: false, default: 3 },
      payload: { type: "json", required: false },
    });
    assert.deepEqual(Object.keys(contract), ["city", "count", "payload"]);
    assert.deepEqual(contract.city, { type: "string", required: true, description: "where" });
    assert.equal("default" in contract.city, false);
    assert.deepEqual(contract.payload, { type: "json", required: false });
    assert.equal("description" in contract.payload, false);
    assert.equal("default" in contract.payload, false);
  });

  it("rejects a non-mapping, a bad type, a non-identifier, and a forbidden name", () => {
    assert.throws(() => parseInputContract(["city"]), /must be a mapping/);
    assert.throws(() => parseInputContract(null), /must be a mapping/);
    assert.throws(() => parseInputContract({ city: { type: "date", required: true } }), /invalid type/);
    assert.throws(() => parseInputContract({ "city-name": { type: "string", required: true } }), /identifier/);
    assert.throws(() => parseInputContract({ "1city": { type: "string", required: true } }), /identifier/);
    assert.throws(
      () => parseInputContract(JSON.parse('{"__proto__":{"type":"string","required":true}}')),
      /not allowed/,
    );
    assert.throws(() => parseInputContract({ constructor: { type: "string", required: false } }), /not allowed/);
    assert.throws(() => parseInputContract({ prototype: { type: "string", required: false } }), /not allowed/);
  });

  it("rejects an unknown key, a non-boolean required, and a default of the wrong type", () => {
    assert.throws(
      () => parseInputContract({ city: { type: "string", required: true, hint: "x" } }),
      /unknown key/,
    );
    assert.throws(() => parseInputContract({ city: { type: "string", required: "yes" } }), /required/);
    assert.throws(() => parseInputContract({ n: { type: "number", required: false, default: "3" } }), /not a number/);
    assert.throws(() => parseInputContract({ n: { type: "number", required: false, default: NaN } }), /not a number/);
    assert.throws(
      () => parseInputContract({ n: { type: "number", required: false, default: Infinity } }),
      /not a number/,
    );
    assert.throws(() => parseInputContract({ j: { type: "json", required: false, default: undefined } }), /not a json/);
  });

  it("allows a default on a required field, and a plain JSON default", () => {
    const contract = parseInputContract({
      city: { type: "string", required: true, default: "Paris" },
      payload: { type: "json", required: false, default: { a: [1, true, null] } },
    });
    assert.equal(contract.city.default, "Paris");
    assert.equal(contract.city.required, true);
    assert.deepEqual(contract.payload.default, { a: [1, true, null] });
  });
});

describe("inputSchemaFromContract", () => {
  const contract = parseInputContract({
    city: { type: "string", required: true },
    count: { type: "number", required: false, default: 3 },
    flag: { type: "boolean", required: true, default: false },
    payload: { type: "json", required: false },
  });
  const schema = inputSchemaFromContract(contract);

  it("fails a missing required field", () => {
    const r = schema.safeParse({});
    assert.equal(r.success, false);
  });

  it("fills an omitted optional from its default and lets a sent value override it", () => {
    assert.deepEqual(schema.parse({ city: "Lima" }), { city: "Lima", count: 3, flag: false });
    assert.deepEqual(schema.parse({ city: "Lima", count: 9, flag: true }), {
      city: "Lima",
      count: 9,
      flag: true,
    });
  });

  it("fails a wrong type the same way", () => {
    assert.equal(schema.safeParse({ city: 1 }).success, false);
    assert.equal(schema.safeParse({ city: "Lima", count: "9" }).success, false);
  });

  it("strips unknown keys", () => {
    assert.deepEqual(schema.parse({ city: "Lima", extra: "nope", count: 1 }), {
      city: "Lima",
      count: 1,
      flag: false,
    });
  });

  it("puts the description on the wrapper, the layout zodToFields reads", () => {
    const described = inputSchemaFromContract(
      parseInputContract({ city: { type: "string", required: true, description: "where" } }),
    );
    const shape = (described._def as { shape: Record<string, { description?: string; _def: { type: string } }> }).shape;
    assert.equal(shape.city.description, "where");
  });
});

describe("collectInputRefs", () => {
  const steps: Step[] = [
    { id: "top", type: "log", config: { message: "Hello {{ input.city }}" } },
    {
      id: "each",
      type: "loop",
      config: {
        until: "false",
        body: { id: "body", type: "log", config: { message: '{{ input["nested"] }}' } },
      },
      options: { onError: { id: "oops", type: "log", config: { message: "{{ input.failed }}" } } },
    },
    { id: "skip", type: "log", config: { message: "{{ input?.[computed] }} {{ input[expr] }}" } },
  ];

  it("walks a top-level step, a nested loop body, and onError, and skips non-literals", () => {
    const refs = collectInputRefs(steps);
    assert.deepEqual(
      refs.map((r) => [r.path, r.name]),
      [
        ["steps[0]", "city"],
        ["steps[1].config.body", "nested"],
        ["steps[1].options.onError", "failed"],
      ],
    );
  });

  it("warns once per undeclared name and stays silent for a declared one", () => {
    const contract = parseInputContract({ city: { type: "string", required: true } });
    const warnings = undeclaredInputRefs(steps, contract);
    assert.deepEqual(
      warnings.map((w) => w.name),
      ["nested", "failed"],
    );
    assert.equal(warnings[0]!.path, "steps[1].config.body");
    assert.match(warnings[0]!.message, /input\.nested/);
    assert.equal(undeclaredInputRefs(steps, null).length, 0);
  });
});

