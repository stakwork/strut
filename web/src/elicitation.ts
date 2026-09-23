// ── Elicitation (plans/elicitation.md) ─────────────────────────────────────
//
// The builder's open question, as GET /chat/:id returns it on
// `meta.elicitation` (the server's ElicitationRecord). Form mode carries
// ACP's flat schema subset — string / number / integer / boolean, a single
// select (enum | oneOf), a multi select (array of enum | anyOf) — which maps
// onto the fields the step editor's ConfigField already draws. Pure; the
// server re-validates every answer, so this only keeps the form honest.

import type { ElicitationSchema, ElicitationProperty, FieldDesc } from "./api";

function optionsOf(p: ElicitationProperty): { const: string; title?: string }[] | undefined {
  if (p.type === "array") return p.items?.enum ? p.items.enum.map((v) => ({ const: v })) : p.items?.anyOf;
  if (p.enum) return p.enum.map((v) => ({ const: v }));
  return p.oneOf;
}

/** The form's fields, in schema order. */
export function fieldsOf(schema: ElicitationSchema): FieldDesc[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, p]) => {
    const base: FieldDesc = { name, kind: "json", required: required.has(name) };
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
      };
    }
    if (p.type === "string") return { ...base, kind: "string" };
    if (p.type === "number" || p.type === "integer") return { ...base, kind: "number" };
    if (p.type === "boolean") return { ...base, kind: "boolean" };
    return base;
  });
}

/** What the form starts with: the schema's defaults. */
export function initialContent(schema: ElicitationSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(schema.properties)) if (p.default !== undefined) out[name] = p.default;
  return out;
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Required fields the user has not filled — what keeps Submit disabled. */
export function missingRequired(schema: ElicitationSchema, content: Record<string, unknown>): string[] {
  return (schema.required ?? []).filter((name) => empty(content[name]));
}

/** The content to send: the schema's fields only, empties dropped. */
export function contentToSubmit(schema: ElicitationSchema, content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(schema.properties)) if (!empty(content[name])) out[name] = content[name];
  return out;
}
