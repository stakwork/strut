import type { CardField, ProposalDescription } from "./core.js";

/**
 * The CARD of a proposal (specs/API.md §12): what a person decides on, as
 * data a host draws without knowing the step — a title, an optional summary,
 * up to 12 label/value fields, the button labels, and `full`: true when the
 * fields cover everything that will run (nothing cut, no key left out).
 * Computed once at proposal time (proposals.ts `proposeCall`) from the
 * step's `describe`, else a table below, else the step's input. The model's
 * `rationale` is never in it.
 */

export type { CardField };

export interface ProposalCard {
  v: 1;
  title: string;
  summary?: string;
  fields: CardField[];
  actions: { accept: string; reject: string };
  full: boolean;
}

export const CARD_MAX_FIELDS = 12;
export const CARD_MAX_VALUE = 500;
const CUT = "… (see full input)";

/** A value as a field's text: strings as they are, the rest as JSON. */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** `value` cut to the cap, with the marker; `cut` says whether it was. */
export function cutValue(value: string, marker = CUT): { value: string; cut: boolean } {
  if (value.length <= CARD_MAX_VALUE) return { value, cut: false };
  return { value: value.slice(0, CARD_MAX_VALUE - marker.length).trimEnd() + marker, cut: true };
}

/** One field per top-level key of an object (keys with no value left out). */
export function objectFields(obj: unknown, opts: { skip?: readonly string[] } = {}): CardField[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [];
  const out: CardField[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined || opts.skip?.includes(k)) continue;
    out.push({ label: k, value: valueText(v), ...(typeof v === "object" && v !== null ? { kind: "code" as const } : {}) });
  }
  return out;
}

/** The fields under the caps; `full` false when any value was cut or any
 *  field dropped. */
export function clampFields(fields: CardField[]): { fields: CardField[]; full: boolean } {
  let full = fields.length <= CARD_MAX_FIELDS;
  const out = fields.slice(0, CARD_MAX_FIELDS).map((f) => {
    const c = cutValue(f.value);
    if (c.cut) full = false;
    return { ...f, value: c.value };
  });
  return { fields: out, full };
}

export interface BuildCardArgs {
  input: unknown;
  /** The record's title: describe's, else the description's first sentence. */
  title: string;
  summary?: string;
  described?: ProposalDescription;
}

export function buildCard(a: BuildCardArgs): ProposalCard {
  const d = a.described;
  // The generic card: every top-level key of the parsed input.
  const generic: CardField[] =
    typeof a.input === "object" && a.input !== null && !Array.isArray(a.input)
      ? objectFields(a.input)
      : a.input === undefined
        ? []
        : [{ label: "input", value: valueText(a.input), kind: "code" }];
  const clamped = clampFields(d?.fields ?? generic);
  return {
    v: 1,
    title: a.title,
    ...(a.summary ? { summary: a.summary } : {}),
    fields: clamped.fields,
    actions: d?.actions ?? { accept: "Accept", reject: "Reject" },
    full: clamped.full && d?.full !== false,
  };
}
