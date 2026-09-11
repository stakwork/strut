import { z } from "zod";

// ── Schema helpers (reused from server.ts pattern) ─────────────────────────

export interface FieldDesc {
  name: string;
  kind: "string" | "number" | "boolean" | "enum" | "json";
  required: boolean;
  default?: unknown;
  enumValues?: string[];
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
  if (kind === "enum")
    return { name, kind: "enum", required, default: defaultVal, enumValues: (inner as any).options };
  if (kind === "string") {
    // `.meta()` registers on the schema it's called on — the outer wrapper
    // (`z.string().optional().meta(…)`) or the inner (`z.string().meta(…).optional()`).
    const suggest = (s as any).meta?.()?.suggest ?? (inner as any).meta?.()?.suggest;
    return { name, kind: "string", required, default: defaultVal, ...(suggest ? { suggest } : {}) };
  }
  if (kind === "number") return { name, kind: "number", required, default: defaultVal };
  if (kind === "boolean") return { name, kind: "boolean", required, default: defaultVal };
  return { name, kind: "json", required, default: defaultVal };
}
