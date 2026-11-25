// The type editor's ANSWER SHAPE (plans/human-steps.md §9.5): a task type's
// answer schema as fields a person edits, and back. It writes only what the
// task store checks (`answerSchemaProblem`, the kit's copy of
// src/tasks/answer-schema.ts), so the page never offers to save what the
// route refuses. A schema the subset takes but these kinds cannot draw — an
// `enum` on an object, a list of groups, `null`, a keyword a kind does not
// write — opens in JSON (`modelOf` answers null).
import { answerSchemaProblem, type AnswerSchema } from "@strut/kit/folds";

export const KINDS = ["text", "number", "integer", "boolean", "one", "several", "numbers", "group"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABELS: Record<Kind, string> = {
  text: "Text",
  number: "Number",
  integer: "Whole number",
  boolean: "Yes or no",
  one: "Pick one",
  several: "Pick several",
  numbers: "Numbers",
  group: "Group",
};

/** One value of a kind: a field without its key. */
export interface ValueModel {
  kind: Kind;
  title?: string;
  description?: string;
  /** text */
  minLength?: number;
  maxLength?: number;
  /** number, integer */
  minimum?: number;
  maximum?: number;
  /** one, several: the options, and whether they are strings or numbers
   *  (`integer` for whole numbers). */
  options?: Array<string | number>;
  optionType?: "string" | "number" | "integer";
  /** several, numbers */
  minItems?: number;
  maxItems?: number;
  /** group */
  fields?: FieldModel[];
}

export interface FieldModel extends ValueModel {
  key: string;
  required: boolean;
}

/** The answer is a form of fields, or one value (a box on a photo: four numbers). */
export type AnswerModel =
  | { form: true; title?: string; description?: string; fields: FieldModel[] }
  | { form: false; value: ValueModel };

/** The nesting the subset allows (`ANSWER_MAX_DEPTH`). */
const MAX_DEPTH = 8;

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const LABELS = ["title", "description"] as const;
/** Only these keys, so nothing the kind does not write is dropped on the way back. */
const only = (s: Raw, keys: readonly string[]) => Object.keys(s).every((k) => keys.includes(k) || (LABELS as readonly string[]).includes(k));
const labels = (s: Raw): Pick<ValueModel, "title" | "description"> => ({
  ...(typeof s["title"] === "string" ? { title: s["title"] } : {}),
  ...(typeof s["description"] === "string" ? { description: s["description"] } : {}),
});
const num = (s: Raw, k: string): Record<string, number> => (typeof s[k] === "number" ? { [k]: s[k] as number } : {});

/** One schema as a value of a kind, or null when no kind draws it. */
function valueOf(s: unknown, depth: number): ValueModel | null {
  if (!isRecord(s) || depth > MAX_DEPTH) return null;
  const type = s["type"];
  if (type === "string") {
    if (Array.isArray(s["enum"])) {
      if (!only(s, ["type", "enum"]) || !s["enum"].every((o) => typeof o === "string")) return null;
      return { kind: "one", ...labels(s), options: [...(s["enum"] as string[])], optionType: "string" };
    }
    if (!only(s, ["type", "minLength", "maxLength"])) return null;
    return { kind: "text", ...labels(s), ...num(s, "minLength"), ...num(s, "maxLength") };
  }
  if (type === "number" || type === "integer") {
    if (Array.isArray(s["enum"])) {
      if (!only(s, ["type", "enum"]) || !s["enum"].every((o) => typeof o === "number")) return null;
      return { kind: "one", ...labels(s), options: [...(s["enum"] as number[])], optionType: type };
    }
    if (!only(s, ["type", "minimum", "maximum"])) return null;
    return { kind: type, ...labels(s), ...num(s, "minimum"), ...num(s, "maximum") };
  }
  if (type === "boolean") return only(s, ["type"]) ? { kind: "boolean", ...labels(s) } : null;
  if (type === "array") {
    if (!only(s, ["type", "items", "minItems", "maxItems"]) || !isRecord(s["items"])) return null;
    const items = s["items"];
    const sizes = { ...num(s, "minItems"), ...num(s, "maxItems") };
    if (Array.isArray(items["enum"])) {
      // A list of picks: the items are bare, an enum of one kind.
      const t = items["type"];
      if (Object.keys(items).some((k) => k !== "type" && k !== "enum")) return null;
      if (t === "string" && items["enum"].every((o) => typeof o === "string")) return { kind: "several", ...labels(s), options: [...(items["enum"] as string[])], optionType: "string", ...sizes };
      if ((t === "number" || t === "integer") && items["enum"].every((o) => typeof o === "number")) return { kind: "several", ...labels(s), options: [...(items["enum"] as number[])], optionType: t, ...sizes };
      return null;
    }
    if (items["type"] === "number" && Object.keys(items).length === 1) return { kind: "numbers", ...labels(s), ...sizes };
    return null;
  }
  if (type === "object") {
    if (!only(s, ["type", "properties", "required"])) return null;
    const fields = fieldsOf(s, depth);
    return fields ? { kind: "group", ...labels(s), fields } : null;
  }
  return null;
}

/** An object schema's properties as fields, or null when one cannot be drawn. */
function fieldsOf(s: Raw, depth: number): FieldModel[] | null {
  const props = s["properties"] === undefined ? {} : s["properties"];
  if (!isRecord(props)) return null;
  const required = Array.isArray(s["required"]) ? (s["required"] as unknown[]) : [];
  const out: FieldModel[] = [];
  for (const [key, p] of Object.entries(props)) {
    const v = valueOf(p, depth + 1);
    if (!v) return null;
    out.push({ key, required: required.includes(key), ...v });
  }
  // A `required` naming a key with no property is the subset's to refuse.
  if (required.some((k) => typeof k !== "string" || !Object.hasOwn(props, k))) return null;
  return out;
}

/** The schema as the editor's model, or null: it opens in JSON. */
export function modelOf(schema: unknown): AnswerModel | null {
  if (answerSchemaProblem(schema)) return null;
  const s = schema as Raw;
  if (s["type"] === "object" && only(s, ["type", "properties", "required"])) {
    const fields = fieldsOf(s, 1);
    if (!fields) return null;
    return { form: true, ...labels(s), fields };
  }
  const value = valueOf(s, 1);
  return value ? { form: false, value } : null;
}

const put = <T>(o: Raw, k: string, v: T | undefined) => {
  if (v !== undefined && v !== "" && !(typeof v === "number" && Number.isNaN(v))) o[k] = v;
};

/** A value back to its schema. */
function schemaOfValue(v: ValueModel): AnswerSchema {
  const out: Raw = {};
  const lab = () => {
    put(out, "title", v.title);
    put(out, "description", v.description);
  };
  switch (v.kind) {
    case "text":
      out["type"] = "string";
      lab();
      put(out, "minLength", v.minLength);
      put(out, "maxLength", v.maxLength);
      break;
    case "number":
    case "integer":
      out["type"] = v.kind;
      lab();
      put(out, "minimum", v.minimum);
      put(out, "maximum", v.maximum);
      break;
    case "boolean":
      out["type"] = "boolean";
      lab();
      break;
    case "one":
      out["type"] = v.optionType ?? "string";
      lab();
      out["enum"] = [...(v.options ?? [])];
      break;
    case "several":
      out["type"] = "array";
      lab();
      out["items"] = { type: v.optionType ?? "string", enum: [...(v.options ?? [])] };
      put(out, "minItems", v.minItems);
      put(out, "maxItems", v.maxItems);
      break;
    case "numbers":
      out["type"] = "array";
      lab();
      out["items"] = { type: "number" };
      put(out, "minItems", v.minItems);
      put(out, "maxItems", v.maxItems);
      break;
    case "group":
      Object.assign(out, objectOf(v.fields ?? [], v));
      break;
  }
  return out as unknown as AnswerSchema;
}

function objectOf(fields: FieldModel[], labelsOf: { title?: string; description?: string }): Raw {
  const out: Raw = { type: "object" };
  put(out, "title", labelsOf.title);
  put(out, "description", labelsOf.description);
  const properties: Raw = {};
  for (const f of fields) {
    const { key: _key, required: _required, ...value } = f;
    properties[f.key] = schemaOfValue(value);
  }
  out["properties"] = properties;
  const required = fields.filter((f) => f.required).map((f) => f.key);
  if (required.length) out["required"] = required;
  return out;
}

/** The model back to the schema the type saves. */
export function schemaOf(model: AnswerModel): AnswerSchema {
  return (model.form ? objectOf(model.fields, model) : schemaOfValue(model.value)) as unknown as AnswerSchema;
}

/** What is wrong with the model before it is a schema the store takes: a
 *  key missing or used twice, an option list empty or repeated, then the
 *  store's own check. */
export function modelProblem(model: AnswerModel): string | undefined {
  const fieldsProblem = (fields: FieldModel[], where: string): string | undefined => {
    const seen = new Set<string>();
    for (const f of fields) {
      if (!f.key.trim()) return `a field ${where}has no key`;
      if (seen.has(f.key)) return `two fields ${where}are both "${f.key}"`;
      seen.add(f.key);
      const p = valueProblem(f, `"${f.key}"`);
      if (p) return p;
    }
    return undefined;
  };
  const valueProblem = (v: ValueModel, name: string): string | undefined => {
    if (v.kind === "one" || v.kind === "several") {
      const opts = v.options ?? [];
      if (!opts.length) return `${name} has no options to pick from`;
      if (new Set(opts.map(String)).size !== opts.length) return `${name} lists an option twice`;
    }
    if (v.kind === "group") return fieldsProblem(v.fields ?? [], `in ${name} `);
    return undefined;
  };
  const own = model.form ? fieldsProblem(model.fields, "") : valueProblem(model.value, "the answer");
  return own ?? answerSchemaProblem(schemaOf(model));
}

/** A new field of a kind, with a key not yet used. */
export function newField(kind: Kind, taken: readonly string[]): FieldModel {
  let n = taken.length + 1;
  while (taken.includes(`field${n}`)) n++;
  const base: FieldModel = { key: `field${n}`, required: true, kind };
  if (kind === "one" || kind === "several") return { ...base, options: ["yes", "no"], optionType: "string" };
  if (kind === "group") return { ...base, fields: [] };
  return base;
}

/** A field turned into another kind: its key, labels and required kept. */
export function withKind(f: FieldModel, kind: Kind): FieldModel {
  const fresh = newField(kind, []);
  return { ...fresh, key: f.key, required: f.required, ...(f.title ? { title: f.title } : {}), ...(f.description ? { description: f.description } : {}) };
}

/** Options typed as a comma-separated list, of the kind asked for. */
export function parseOptions(text: string, type: "string" | "number" | "integer"): Array<string | number> | { problem: string } {
  const parts = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (type === "string") return parts;
  const nums = parts.map(Number);
  const bad = parts.find((_, i) => !Number.isFinite(nums[i]!) || (type === "integer" && !Number.isInteger(nums[i]!)));
  return bad === undefined ? nums : { problem: `"${bad}" is not a ${type === "integer" ? "whole number" : "number"}` };
}

/** A starting answer: one yes-or-no field. */
export const STARTER: AnswerModel = { form: true, fields: [{ key: "answer", required: true, kind: "boolean", title: "Answer" }] };
