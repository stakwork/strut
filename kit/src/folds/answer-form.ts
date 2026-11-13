/**
 * A FLAT FORM over a JSON Schema: what the builder's questions carry (ACP's
 * elicitation subset, plans/elicitation.md) and what a task type's answer
 * schema is when it needs no UI of its own (plans/human-steps.md §5.3).
 * One copy: strut's UI draws a question with it (web/src/elicitation.ts),
 * `strut/views`' TaskForm a task's answer.
 *
 * What it draws: an object whose properties are each a string, a number
 * (`integer` too), a boolean, a single select (`enum`, or `oneOf` with
 * titles) or a multi select (an `array` whose `items` are an `enum`, or
 * `anyOf` with titles). Anything else — a nested object, a list of numbers
 * (a box on a photo) — is not a form: `formProblem` says so, and the task
 * type needs its own UI. Pure; the server checks every answer again.
 */

/** A select's option with its label. */
export interface FormOption {
  const: string;
  title?: string;
}

/** One property of a flat form's schema. */
export interface FormProperty {
  type: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  oneOf?: readonly FormOption[];
  items?: { type?: string; enum?: readonly unknown[]; anyOf?: readonly FormOption[] };
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface FormSchema {
  type: string;
  properties?: Record<string, FormProperty>;
  required?: readonly string[];
}

/** One field as a form draws it (strut's UI's `FieldDesc` takes it as it is). */
export interface FormField {
  name: string;
  /** `multi`: a checkbox list over `enumValues`. */
  kind: "string" | "number" | "boolean" | "enum" | "multi" | "json";
  required: boolean;
  default?: unknown;
  /** A select's values, as text. */
  enumValues?: string[];
  /** Display text per value (`oneOf` / `anyOf` titles). */
  enumLabels?: Record<string, string>;
  /** The select also takes the person's own words: an "Other…" choice. */
  other?: boolean;
  label?: string;
  description?: string;
}

export interface FieldsOptions {
  /** Every select also takes the person's own words (default true): a
   *  question's options are what a model offered. Off for an answer schema,
   *  whose `enum` is what the server accepts. */
  other?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SCALARS = new Set(["string", "number", "integer", "boolean"]);

function optionsOf(p: FormProperty): FormOption[] | undefined {
  if (p.type === "array") return p.items?.enum ? p.items.enum.map((v) => ({ const: String(v) })) : p.items?.anyOf ? [...p.items.anyOf] : undefined;
  if (p.enum) return p.enum.map((v) => ({ const: String(v) }));
  return p.oneOf ? [...p.oneOf] : undefined;
}

/** Why `schema` is not a flat form, or null when it is. */
export function formProblem(schema: unknown): string | null {
  if (!isRecord(schema) || schema["type"] !== "object") return "the answer is not an object of fields";
  const props = schema["properties"];
  if (!isRecord(props) || !Object.keys(props).length) return "the answer has no fields";
  for (const [name, raw] of Object.entries(props)) {
    if (!isRecord(raw)) return `${name} has no schema`;
    const p = raw as unknown as FormProperty;
    if (SCALARS.has(p.type)) continue;
    if (p.type === "array" && (p.items?.enum?.length || p.items?.anyOf?.length)) continue;
    if (p.type === "array") return `${name} is a list of values a form cannot pick from (no enum)`;
    return `${name} is ${p.type === "object" ? "a nested object" : `of type ${String(p.type)}`}`;
  }
  return null;
}

/** The form's fields, in schema order. */
export function fieldsOf(schema: FormSchema, opts: FieldsOptions = {}): FormField[] {
  const other = opts.other ?? true;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, p]) => {
    const base: FormField = { name, kind: "json", required: required.has(name) };
    if (p.title) base.label = p.title;
    if (p.description) base.description = p.description;
    if (p.default !== undefined) base.default = p.default;
    const opts = optionsOf(p);
    if (opts) {
      const labels: Record<string, string> = {};
      for (const o of opts) if (o.title) labels[o.const] = o.title;
      return {
        ...base,
        kind: p.type === "array" ? "multi" : "enum",
        enumValues: opts.map((o) => o.const),
        ...(Object.keys(labels).length ? { enumLabels: labels } : {}),
        ...(other ? { other: true } : {}),
      };
    }
    if (p.type === "string") return { ...base, kind: "string" };
    if (p.type === "number" || p.type === "integer") return { ...base, kind: "number" };
    if (p.type === "boolean") return { ...base, kind: "boolean" };
    return base;
  });
}

/** What the form starts with: the schema's defaults. */
export function initialContent(schema: FormSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(schema.properties ?? {})) if (p.default !== undefined) out[name] = p.default;
  return out;
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Required fields not filled — what keeps Submit off. */
export function missingRequired(schema: FormSchema, content: Record<string, unknown>): string[] {
  return (schema.required ?? []).filter((name) => empty(content[name]));
}

/** The content to send: the schema's fields only, empties dropped. */
export function contentToSubmit(schema: FormSchema, content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(schema.properties ?? {})) if (!empty(content[name])) out[name] = content[name];
  return out;
}

/**
 * A form's content as the ANSWER its schema takes, or the first problem:
 * text in a number field read as a number (whole for `integer`), a select's
 * text mapped back to the schema's own value (`enum: [1, 2]` gives 1, not
 * "1"), empties left out, a required one missing named. For a task's
 * answer, whose schema the server checks again.
 */
export function answerOf(schema: FormSchema, content: Record<string, unknown>): { answer: Record<string, unknown> } | { problem: string } {
  const missing = missingRequired(schema, content);
  if (missing.length) return { problem: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required` };
  const answer: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(schema.properties ?? {})) {
    const v = content[name];
    if (empty(v)) continue;
    const label = p.title ?? name;
    const back = (list: readonly unknown[] | undefined, text: unknown) => {
      const found = list?.find((x) => String(x) === String(text));
      return found === undefined ? text : found;
    };
    if (p.type === "number" || p.type === "integer") {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (p.enum) {
        answer[name] = back(p.enum, v);
        continue;
      }
      if (!Number.isFinite(n)) return { problem: `${label} is a number` };
      if (p.type === "integer" && !Number.isInteger(n)) return { problem: `${label} is a whole number` };
      answer[name] = n;
    } else if (p.type === "boolean") {
      answer[name] = v === true || v === "true";
    } else if (p.type === "array") {
      const list = Array.isArray(v) ? v : [v];
      answer[name] = list.map((x) => back(p.items?.enum, x));
    } else {
      answer[name] = p.enum ? back(p.enum, v) : v;
    }
  }
  return { answer };
}
