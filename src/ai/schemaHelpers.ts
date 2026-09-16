import { z } from "zod";
import type { AnyStepDef } from "../core.js";

// ── Schema helpers ─────────────────────────────────────────────────────────
//
// Two renderings of a step's Zod schemas, for two readers:
//   - zodToFields: a flat FieldDesc[] for the web UI's config form — one row
//     per top-level field (kind / required / default / enum / suggest /
//     description), nested shapes collapsed to "json".
//   - stepSchemas: JSON Schema for the AI builder's get_step — keeps every
//     `.describe()`, default, enum, constraint and nested shape, in the
//     format models read best. One zod call; nothing to maintain here.

export interface FieldDesc {
  name: string;
  kind: "string" | "number" | "boolean" | "enum" | "json";
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  /** The field's `.describe()` text — the config form shows it as a hint. */
  description?: string;
  /** UI hint for a free-text field: a catalog to offer as suggestions
   *  ("llm-models" → GET /llm/models). Set on the Zod schema via
   *  `.meta({ suggest: "llm-models" })`; the value stays free text. */
  suggest?: "llm-models";
}

export function zodToFields(schema: z.ZodTypeAny): FieldDesc[] {
  const shape = getObjectShape(schema);
  if (!shape) return [];
  return Object.entries(shape).map(([name, s]) =>
    describeField(name, s as z.ZodTypeAny),
  );
}

/**
 * JSON Schema (draft 2020-12, `$schema` stripped) for a step's config and
 * result. `input` is the INPUT view, so a field with a default is optional.
 * `output` is omitted when the step declares `z.any()` — its description
 * then states the shape.
 */
export function stepSchemas(def: Pick<AnyStepDef, "input" | "output">): {
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
} {
  const input = toJsonSchema(def.input, "input");
  const output = toJsonSchema(def.output, "output");
  return Object.keys(output).length ? { input, output } : { input };
}

function toJsonSchema(schema: z.ZodTypeAny, io: "input" | "output"): Record<string, unknown> {
  // `unrepresentable: "any"`: a custom step's z.custom()/z.date() renders as
  // {} instead of throwing and taking get_step down with it.
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" });
  return rest;
}

// zod v4 def layout: `_def.type` is a lowercase kind string ("object",
// "optional", "default", ...), an object's `_def.shape` is a plain record,
// a default's `_def.defaultValue` is the VALUE (not a thunk), and `.refine`
// no longer wraps the schema (transforms become a "pipe" whose input is
// `_def.in`).
function getObjectShape(s: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const def = s._def as any;
  if (def.type === "object") return def.shape;
  if (def.type === "pipe") return getObjectShape(def.in);
  return null;
}

function describeField(name: string, s: z.ZodTypeAny): FieldDesc {
  let required = true;
  let defaultVal: unknown;
  let inner = s;
  for (;;) {
    const def = inner._def as any;
    if (def.type === "optional") {
      required = false;
      inner = def.innerType;
    } else if (def.type === "default" || def.type === "prefault") {
      required = false;
      defaultVal = def.defaultValue;
      inner = def.innerType;
    } else if (def.type === "nullable") {
      required = false;
      inner = def.innerType;
    } else break;
  }
  const kind = (inner._def as any).type as string;
  // `.describe()` / `.meta()` register on the schema they're called on — the
  // outer wrapper (`z.string().optional().describe(…)`) or the inner
  // (`z.string().describe(…).optional()`) — so check both.
  const description: string | undefined = (s as any).description ?? (inner as any).description;
  const base: FieldDesc = { name, kind: "json", required, default: defaultVal };
  if (description) base.description = description;
  if (kind === "enum") return { ...base, kind: "enum", enumValues: (inner as any).options };
  if (kind === "string") {
    const suggest = (s as any).meta?.()?.suggest ?? (inner as any).meta?.()?.suggest;
    return { ...base, kind: "string", ...(suggest ? { suggest } : {}) };
  }
  if (kind === "number") return { ...base, kind: "number" };
  if (kind === "boolean") return { ...base, kind: "boolean" };
  return base;
}
