// ── Elicitation (plans/elicitation.md) ─────────────────────────────────────
//
// The builder's open question, as GET /chat/:id returns it on
// `meta.elicitation` (the server's ElicitationRecord). Form mode carries
// ACP's flat schema subset — string / number / integer / boolean, a single
// select (enum | oneOf), a multi select (array of enum | anyOf) — which maps
// onto the fields the step editor's ConfigField already draws. Every select
// also takes the user's own words (`other`: the "Other…" choice), since the
// options are what the model offered, not what the user may answer. Pure;
// the server re-validates every answer, so this only keeps the form honest.
//
// The mapper is the kit's (`@strut/kit/folds`, answer-form.ts): one copy,
// which strut/views' TaskForm draws a task's answer with too
// (plans/human-steps.md §5.3).

import { contentToSubmit as foldContent, fieldsOf as foldFields, initialContent as foldInitial, missingRequired as foldMissing } from "@strut/kit/folds";
import type { ElicitationSchema, FieldDesc } from "./api";

/** The form's fields, in schema order; every select takes "Other…". */
export function fieldsOf(schema: ElicitationSchema): FieldDesc[] {
  return foldFields(schema, { other: true });
}

/** What the form starts with: the schema's defaults. */
export function initialContent(schema: ElicitationSchema): Record<string, unknown> {
  return foldInitial(schema);
}

/** Required fields the user has not filled — what keeps Submit disabled. */
export function missingRequired(schema: ElicitationSchema, content: Record<string, unknown>): string[] {
  return foldMissing(schema, content);
}

/** The content to send: the schema's fields only, empties dropped. */
export function contentToSubmit(schema: ElicitationSchema, content: Record<string, unknown>): Record<string, unknown> {
  return foldContent(schema, content);
}
