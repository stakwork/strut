/**
 * A YAML workflow's declared `input:` contract — parallel to `params:`.
 *
 * The block is the source of truth. `flowFromYaml` turns it into the Zod
 * schema `runWorkflow` already parses; the flow API returns the parsed
 * mapping itself (never a walk back from Zod — `z.any()` and a declared
 * `json` field are indistinguishable once unwrapped). Workflows with no
 * block keep `z.any()` and today's open input.
 *
 * The contract is never inferred by scanning templates. `collectInputRefs`
 * exists only so publish can WARN when a step reads a name the author did
 * not declare.
 */
import { z } from "zod";
import type { Step } from "./core.js";

export const INPUT_TYPES = ["string", "number", "boolean", "json"] as const;
export type InputFieldType = (typeof INPUT_TYPES)[number];

export interface InputField {
  type: InputFieldType;
  required: boolean;
  default?: unknown;
  description?: string;
}

/** Field name → declaration, in YAML insertion order. */
export type InputContract = Record<string, InputField>;

/** Safe identifier. `__proto__` / `constructor` / `prototype` match the
 *  pattern but are rejected by name — a YAML key of those names is an own
 *  property, and must not become a schema key. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_KEYS = new Set(["type", "required", "default", "description"]);

export class InputContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputContractError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A JSON value a `json` field may default to: plain object, array, or a
 *  scalar. Prototype-bearing values (Date, Map, class instances) are not. */
export function isPlainJson(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isPlainJson);
  if (isPlainObject(v)) return Object.values(v).every(isPlainJson);
  return false;
}

function defaultMatches(type: InputFieldType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      return isPlainJson(value);
  }
}

/**
 * Validate a parsed `input:` block. Throws `InputContractError` — publish
 * and load share this so the two cannot disagree. `{}` is a valid empty
 * contract (no fields; unknown keys still stripped at run time).
 */
export function parseInputContract(raw: unknown): InputContract {
  if (!isPlainObject(raw)) {
    throw new InputContractError("`input` must be a mapping of field name → { type, required }.");
  }
  const contract: InputContract = {};
  // Object.entries skips a key whose value is Object.prototype (the ordinary
  // reading of `__proto__`). Own names include it, so the forbidden-name
  // check still fires.
  const names = [...new Set([...Object.keys(raw), ...Object.getOwnPropertyNames(raw)])];
  for (const name of names) {
    const spec = raw[name];
    if (!FIELD_NAME_RE.test(name) || FORBIDDEN_NAMES.has(name)) {
      throw new InputContractError(
        `Input field "${name}" must be an identifier (^[A-Za-z_][A-Za-z0-9_]*$); ` +
          `"__proto__", "constructor" and "prototype" are not allowed.`,
      );
    }
    if (!isPlainObject(spec)) {
      throw new InputContractError(`Input field "${name}" must be a mapping with \`type\` and \`required\`.`);
    }
    const unknown = Object.keys(spec).filter((k) => !FIELD_KEYS.has(k));
    if (unknown.length) {
      throw new InputContractError(
        `Input field "${name}" has unknown key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
          `Allowed: type, required, default, description.`,
      );
    }
    const type = spec["type"];
    if (typeof type !== "string" || !(INPUT_TYPES as readonly string[]).includes(type)) {
      throw new InputContractError(
        `Input field "${name}" has invalid type ${JSON.stringify(type)} — expected string, number, boolean, or json.`,
      );
    }
    if (typeof spec["required"] !== "boolean") {
      throw new InputContractError(`Input field "${name}" requires \`required: true\` or \`required: false\`.`);
    }
    if ("description" in spec && typeof spec["description"] !== "string") {
      throw new InputContractError(`Input field "${name}" \`description\` must be a string.`);
    }
    if ("default" in spec && !defaultMatches(type as InputFieldType, spec["default"])) {
      throw new InputContractError(
        `Input field "${name}" default ${JSON.stringify(spec["default"])} is not a ${type}.`,
      );
    }
    const field: InputField = { type: type as InputFieldType, required: spec["required"] };
    if ("default" in spec) field.default = spec["default"];
    if (typeof spec["description"] === "string") field.description = spec["description"];
    contract[name] = field;
  }
  return contract;
}

function fieldSchema(field: InputField): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "json":
      // Any JSON value, including scalars — not only objects. `.strip()` on
      // the parent object is what drops unknown sibling keys.
      schema = z.json();
      break;
  }
  // A default fills an omitted field whether or not it is required. A sent
  // value still overrides it (Zod applies the default only when the key is
  // missing). Description lives on the wrapper, the layout zodToFields reads.
  if ("default" in field) schema = schema.default(field.default as never);
  else if (!field.required) schema = schema.optional();
  if (field.description) schema = schema.describe(field.description);
  return schema;
}

/**
 * The schema `runWorkflow` parses. Missing required fails; a sent value
 * overrides `default`; an omitted optional uses `default`; a wrong type
 * fails; unknown keys are stripped (Zod 4 does not strip unless told).
 */
export function inputSchemaFromContract(contract: InputContract): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, field] of Object.entries(contract)) shape[name] = fieldSchema(field);
  return z.object(shape).strip();
}

// ── Undeclared-ref scan ────────────────────────────────────────────────────
//
// Match `input.name` and `input["name"]` the way `refsInExpr` in
// `web/src/run-inputs.ts` does. Do NOT use `exprRoots`: it returns only the
// scope root `input` and skips member names after `dot` / `optionalDot`.
// `input?.[name]` and `input[expr]` are skipped — the name is not a literal.

/** An `input.X` or `input["X"]` / `input['X']` reference. Optional-dot and
 *  computed brackets are deliberately not matched. */
const INPUT_REF_RE = /\binput(?:\.([A-Za-z_$][\w$]*)|\[\s*(["'])([^"']+)\2\s*\])/g;
const SEGMENT_RE = /\{\{([\s\S]*?)\}\}/g;

export interface InputRef {
  /** Step id the reference lives in (a nested body keeps its own id). */
  stepId: string;
  /** `steps[i]`, `steps[i].config.body`, `steps[i].options.onError`, … */
  path: string;
  name: string;
}

function refsInString(value: string): string[] {
  const names: string[] = [];
  for (const seg of value.matchAll(SEGMENT_RE)) {
    const expr = seg[1] ?? "";
    for (const m of expr.matchAll(INPUT_REF_RE)) {
      const name = m[1] ?? m[3];
      if (name) names.push(name);
    }
  }
  return names;
}

function refsInValue(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(...refsInString(value));
  else if (Array.isArray(value)) {
    for (const v of value) refsInValue(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) refsInValue(v, out);
  }
}

/**
 * Every `{{ input.<name> }}` / `{{ input["name"] }}` in the workflow,
 * including nested `loop` / `foreach` bodies and `onError` handlers.
 * One entry per occurrence — callers dedupe.
 */
export function collectInputRefs(steps: readonly Step[]): InputRef[] {
  const refs: InputRef[] = [];
  // Descends `loop` / `foreach` bodies and `onError`, mirroring walkSteps,
  // and keeps the path validate.ts already uses.
  const visit = (s: Step | undefined, path: string) => {
    if (!s || typeof s !== "object" || typeof s.type !== "string") return;
    const names: string[] = [];
    // `body` and `onError` are nested steps, visited below with their own
    // path. Scanning them here would report the same ref twice.
    const config = (s.config ?? {}) as Record<string, unknown>;
    const ownConfig =
      s.type === "loop" || s.type === "foreach"
        ? Object.fromEntries(Object.entries(config).filter(([k]) => k !== "body"))
        : config;
    refsInValue(ownConfig, names);
    const options = (s.options ?? {}) as Record<string, unknown>;
    refsInValue(
      Object.fromEntries(Object.entries(options).filter(([k]) => k !== "onError")),
      names,
    );
    const id = typeof s.id === "string" && s.id ? s.id : path;
    for (const name of names) refs.push({ stepId: id, path, name });
    const body = (s.config as Record<string, unknown> | undefined)?.["body"] as Step | undefined;
    if (s.type === "loop" || s.type === "foreach") visit(body, `${path}.config.body`);
    visit(s.options?.onError, `${path}.options.onError`);
  };
  steps.forEach((s, i) => visit(s, `steps[${i}]`));
  return refs;
}

export interface UndeclaredInputRef {
  path: string;
  name: string;
  message: string;
}

/**
 * One warning per missing name. No contract (open input) → no warnings.
 * A declared name is silent. The message names the step path and the field
 * only — never a default, a description, or the surrounding template.
 */
export function undeclaredInputRefs(
  steps: readonly Step[],
  contract: InputContract | null,
): UndeclaredInputRef[] {
  if (!contract) return [];
  const seen = new Set<string>();
  const out: UndeclaredInputRef[] = [];
  for (const ref of collectInputRefs(steps)) {
    if (ref.name in contract || seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push({
      path: ref.path,
      name: ref.name,
      message: `Step "${ref.stepId}" reads {{ input.${ref.name} }} but "${ref.name}" is not declared in \`input:\`.`,
    });
  }
  return out;
}

/** Log each undeclared ref. The step path and the field name only. */
export function warnUndeclaredInputRefs(workflow: string, refs: readonly UndeclaredInputRef[]): void {
  for (const ref of refs) {
    console.warn(`[input] ${workflow} ${ref.path}: undeclared input "${ref.name}"`);
  }
}
