/**
 * The shape of a task's answer (plans/human-steps.md §4.5): a SUBSET of JSON
 * Schema that strut checks itself, pure. Strut has no general validator (the
 * builder's questions check a flat subset, `src/ai/elicitation.ts`; zod is a
 * peer dependency), so a task type's schema may use only what is checked
 * here, and a schema that uses anything else is refused when the type is
 * saved: a type never promises a check strut does not make.
 *
 * Checked: `type` (one of object, array, string, number, integer, boolean,
 * null — required on every schema), `properties` + `required` on an object
 * (a key the schema does not name is refused), `items`, `minItems`,
 * `maxItems` on an array, `enum`, `minimum` / `maximum` on a number,
 * `minLength` / `maxLength` on a string. `title` and `description` are
 * accepted as labels and check nothing. Nesting to 8 levels, in the schema
 * and in an answer; an answer is at most 256 KB as JSON.
 *
 * A box on a photo: `{ type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }`.
 */

export const ANSWER_MAX_BYTES = 256 * 1024;
export const ANSWER_MAX_DEPTH = 8;

export const ANSWER_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

/** A schema `answerSchemaProblem` passed. */
export interface AnswerSchema {
  type: AnswerType;
  title?: string;
  description?: string;
  properties?: Record<string, AnswerSchema>;
  required?: string[];
  items?: AnswerSchema;
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** The keywords each type may carry, beyond `type` and the labels. */
const KEYWORDS: Record<AnswerType, readonly string[]> = {
  object: ["properties", "required", "enum"],
  array: ["items", "minItems", "maxItems", "enum"],
  string: ["enum", "minLength", "maxLength"],
  number: ["enum", "minimum", "maximum"],
  integer: ["enum", "minimum", "maximum"],
  boolean: ["enum"],
  null: ["enum"],
};
const LABELS = ["title", "description"];
const ALL = [...new Set(["type", ...LABELS, ...Object.values(KEYWORDS).flat()])];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Why `raw` may not be a task type's answer schema, or undefined when it may. */
export function answerSchemaProblem(raw: unknown): string | undefined {
  try {
    checkSchema("schema", raw, 1);
    return undefined;
  } catch (e) {
    if (e instanceof Problem) return e.message;
    throw e;
  }
}

/** Why `answer` does not fit `schema`, or undefined when it does. */
export function answerProblem(schema: AnswerSchema, answer: unknown): string | undefined {
  if (answer === undefined) return "an answer is required";
  let json: string | undefined;
  try {
    json = JSON.stringify(answer);
  } catch {
    return "the answer is not JSON";
  }
  if (json === undefined) return "the answer is not JSON";
  const bytes = Buffer.byteLength(json);
  if (bytes > ANSWER_MAX_BYTES) return `the answer is ${bytes} bytes as JSON; at most ${ANSWER_MAX_BYTES}`;
  if (depthOver(answer, ANSWER_MAX_DEPTH)) return `the answer nests deeper than ${ANSWER_MAX_DEPTH} levels`;
  try {
    checkValue("answer", schema, answer);
    return undefined;
  } catch (e) {
    if (e instanceof Problem) return e.message;
    throw e;
  }
}

// ── the schema ────────────────────────────────────────────────────────────

class Problem extends Error {}

function fail(where: string, what: string): never {
  throw new Problem(`${where}: ${what}`);
}

function checkSchema(where: string, raw: unknown, depth: number): AnswerSchema {
  if (depth > ANSWER_MAX_DEPTH) fail(where, `nests deeper than ${ANSWER_MAX_DEPTH} levels`);
  if (!isObj(raw)) fail(where, "a schema is an object");
  const type = raw.type;
  if (typeof type !== "string" || !(ANSWER_TYPES as readonly string[]).includes(type)) {
    fail(where, `"type" must be one of ${ANSWER_TYPES.join(", ")}${type === undefined ? "" : ` (got ${JSON.stringify(type)})`}`);
  }
  const t = type as AnswerType;
  const allowed = new Set(["type", ...LABELS, ...KEYWORDS[t]]);
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    if (ALL.includes(key)) fail(where, `"${key}" does not apply to type ${t}`);
    fail(where, `"${key}" is not a keyword strut checks (it checks: ${ALL.join(", ")})`);
  }
  for (const label of LABELS) {
    if (raw[label] !== undefined && typeof raw[label] !== "string") fail(where, `"${label}" must be a string`);
  }

  if (t === "object") {
    const props = raw.properties;
    if (props !== undefined) {
      if (!isObj(props)) fail(where, `"properties" must be an object`);
      for (const [k, v] of Object.entries(props)) checkSchema(`${where}.properties.${k}`, v, depth + 1);
    }
    const required = raw.required;
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((k) => typeof k === "string")) fail(where, `"required" must be a list of property names`);
      if (new Set(required).size !== required.length) fail(where, `"required" names a property twice`);
      for (const k of required as string[]) {
        if (!isObj(props) || !Object.hasOwn(props, k)) fail(where, `"required" names "${k}", which "properties" does not`);
      }
    }
  }
  if (t === "array") {
    if (raw.items !== undefined) checkSchema(`${where}.items`, raw.items, depth + 1);
    bounds(where, raw, "minItems", "maxItems");
  }
  if (t === "string") bounds(where, raw, "minLength", "maxLength");
  if (t === "number" || t === "integer") {
    for (const k of ["minimum", "maximum"]) {
      if (raw[k] !== undefined && (typeof raw[k] !== "number" || !Number.isFinite(raw[k]))) fail(where, `"${k}" must be a number`);
    }
    if (typeof raw.minimum === "number" && typeof raw.maximum === "number" && raw.minimum > raw.maximum) {
      fail(where, `"minimum" is above "maximum"`);
    }
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) fail(where, `"enum" must be a non-empty list`);
    // Each option must fit the rest of the schema: an option no answer could
    // match is a promise the type cannot keep.
    const { enum: _options, ...rest } = raw;
    raw.enum.forEach((option, i) => {
      if (depthOver(option, ANSWER_MAX_DEPTH)) fail(`${where}.enum[${i}]`, `nests deeper than ${ANSWER_MAX_DEPTH} levels`);
      checkValue(`${where}.enum[${i}]`, rest as unknown as AnswerSchema, option);
    });
  }
  return raw as unknown as AnswerSchema;
}

function bounds(where: string, raw: Record<string, unknown>, min: string, max: string): void {
  for (const k of [min, max]) {
    if (raw[k] !== undefined && !count(raw[k])) fail(where, `"${k}" must be a whole number ≥ 0`);
  }
  if (count(raw[min]) && count(raw[max]) && (raw[min] as number) > (raw[max] as number)) fail(where, `"${min}" is above "${max}"`);
}

// ── an answer ─────────────────────────────────────────────────────────────

function checkValue(where: string, s: AnswerSchema, v: unknown): void {
  switch (s.type) {
    case "null":
      if (v !== null) fail(where, `expected null, got ${kind(v)}`);
      break;
    case "boolean":
      if (typeof v !== "boolean") fail(where, `expected a boolean, got ${kind(v)}`);
      break;
    case "string":
      if (typeof v !== "string") fail(where, `expected a string, got ${kind(v)}`);
      if (s.minLength !== undefined && v.length < s.minLength) fail(where, `at least ${s.minLength} characters, got ${v.length}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) fail(where, `at most ${s.maxLength} characters, got ${v.length}`);
      break;
    case "number":
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v)) fail(where, `expected a number, got ${kind(v)}`);
      if (s.type === "integer" && !Number.isInteger(v)) fail(where, `expected a whole number, got ${v}`);
      if (s.minimum !== undefined && v < s.minimum) fail(where, `at least ${s.minimum}, got ${v}`);
      if (s.maximum !== undefined && v > s.maximum) fail(where, `at most ${s.maximum}, got ${v}`);
      break;
    case "array":
      if (!Array.isArray(v)) fail(where, `expected a list, got ${kind(v)}`);
      if (s.minItems !== undefined && v.length < s.minItems) fail(where, `at least ${s.minItems} items, got ${v.length}`);
      if (s.maxItems !== undefined && v.length > s.maxItems) fail(where, `at most ${s.maxItems} items, got ${v.length}`);
      if (s.items) v.forEach((item, i) => checkValue(`${where}[${i}]`, s.items!, item));
      break;
    case "object": {
      if (!isObj(v)) fail(where, `expected an object, got ${kind(v)}`);
      const props = s.properties ?? {};
      for (const k of Object.keys(v)) {
        if (!Object.hasOwn(props, k)) fail(where, `"${k}" is not a field of this answer`);
      }
      for (const k of s.required ?? []) {
        if (v[k] === undefined) fail(where, `"${k}" is required`);
      }
      for (const [k, sub] of Object.entries(props)) {
        if (v[k] !== undefined) checkValue(`${where}.${k}`, sub, v[k]);
      }
      break;
    }
  }
  if (s.enum && !s.enum.some((option) => sameJson(option, v))) {
    fail(where, `must be one of ${s.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return typeof v === "object" ? "an object" : typeof v;
}

/** Whether a value nests deeper than `max` levels (the value itself is 1). */
function depthOver(v: unknown, max: number, depth = 1): boolean {
  if (v === null || typeof v !== "object") return false;
  if (depth > max) return true;
  const children = Array.isArray(v) ? v : Object.values(v);
  return children.some((c) => depthOver(c, max, depth + 1));
}

/** Deep equality over JSON values. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
