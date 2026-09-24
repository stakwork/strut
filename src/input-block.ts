/**
 * A YAML workflow's optional top-level `input:` block — the fields a run's
 * payload carries — and the Zod schema the runner validates it with.
 *
 *   input:
 *     url: { type: string, description: "the page to fetch" }
 *     limit: { type: number, default: 10 }
 *     dryRun: { type: boolean, required: false }
 *
 * A field is required unless it has a `default` or says `required: false`.
 * No block → the flow keeps `z.any()` and accepts any object, as before.
 */
import { z } from "zod";

export const INPUT_TYPES = ["string", "number", "boolean", "json"] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export interface InputField {
  type: InputType;
  /** Defaults to true — unless the field has a `default`. */
  required?: boolean;
  default?: unknown;
  description?: string;
}

/** Field name → declaration, in the order written. */
export type InputBlock = Record<string, InputField>;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYS = new Set(["type", "required", "default", "description"]);
const BASE: Record<InputType, () => z.ZodTypeAny> = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
  json: () => z.json(),
};

function isMapping(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Validate a parsed `input:` block. Throws a plain Error naming the field. */
export function parseInputBlock(raw: unknown): InputBlock {
  if (!isMapping(raw)) {
    throw new Error("`input` must be a mapping of field name → { type, required?, default?, description? }.");
  }
  const block: InputBlock = {};
  for (const [name, spec] of Object.entries(raw)) {
    const at = `Input field "${name}"`;
    if (!NAME_RE.test(name) || name === "__proto__") {
      throw new Error(`${at}: name must be an identifier (letters, digits, underscores).`);
    }
    if (!isMapping(spec)) throw new Error(`${at} must be a mapping with a \`type\`.`);
    for (const k of Object.keys(spec)) {
      if (!KEYS.has(k)) throw new Error(`${at}: unknown key "${k}" (allowed: type, required, default, description).`);
    }
    const type = spec.type as InputType;
    if (!INPUT_TYPES.includes(type)) throw new Error(`${at}: type must be one of ${INPUT_TYPES.join(", ")}.`);
    if (spec.required !== undefined && typeof spec.required !== "boolean") {
      throw new Error(`${at}: \`required\` must be true or false.`);
    }
    if (spec.description !== undefined && typeof spec.description !== "string") {
      throw new Error(`${at}: \`description\` must be a string.`);
    }
    if (spec.default !== undefined && !BASE[type]().safeParse(spec.default).success) {
      throw new Error(`${at}: default ${JSON.stringify(spec.default)} is not a ${type}.`);
    }
    block[name] = spec as unknown as InputField;
  }
  return block;
}

/** The schema `runWorkflow` parses the run input with: a missing required
 *  field or a wrong type fails the run before any step, a `default` fills an
 *  omitted field, and keys the block does not name are dropped. */
export function inputSchema(block: InputBlock): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, f] of Object.entries(block)) {
    const base = BASE[f.type]();
    shape[name] =
      f.default !== undefined ? base.default(f.default as never) : f.required === false ? base.optional() : base;
  }
  return z.object(shape);
}
