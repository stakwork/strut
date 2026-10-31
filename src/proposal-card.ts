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

type TableEntry = (input: Record<string, unknown>) => ProposalDescription | undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Steps this repo does not own, by type, used when a step has no
 *  `describe`. `concept/create` is the stakgraph lab's; its clean home is a
 *  `describe` on that step. */
const TABLE: Record<string, TableEntry> = {
  "concept/create": (i) => {
    const name = str(i["name"]) ?? "(unnamed)";
    const fields: CardField[] = [];
    for (const k of ["parent", "kind", "description"]) if (str(i[k])) fields.push({ label: k, value: str(i[k])! });
    if (typeof i["docs"] === "string" && i["docs"]) fields.push({ label: "docs", value: i["docs"], kind: "markdown" });
    return { title: `New Concept: ${name}`, fields };
  },
};

export interface BuildCardArgs {
  step: string;
  input: unknown;
  /** The title the record carries (describe's, else titleOf). */
  title: string;
  summary?: string;
  described?: ProposalDescription;
}

export function buildCard(a: BuildCardArgs): ProposalCard {
  const obj = typeof a.input === "object" && a.input !== null && !Array.isArray(a.input) ? (a.input as Record<string, unknown>) : undefined;
  let d = a.described;
  let title = a.title;
  const summary = a.summary;
  if (!d?.fields) {
    const t = obj ? TABLE[a.step]?.(obj) : undefined;
    if (t) {
      d = { ...d, ...t };
      if (!a.described?.title?.trim()) title = t.title ?? title;
    }
  }
  let fields: CardField[];
  let explicitFull = true;
  if (d?.fields) {
    fields = d.fields;
    explicitFull = d.full !== false;
  } else {
    // The generic card: every top-level key of the parsed input.
    fields = obj ? objectFields(obj) : a.input === undefined ? [] : [{ label: "input", value: valueText(a.input), kind: "code" }];
  }
  const clamped = clampFields(fields);
  return {
    v: 1,
    title,
    ...(summary ? { summary } : {}),
    fields: clamped.fields,
    actions: d?.actions ?? { accept: "Accept", reject: "Reject" },
    full: clamped.full && explicitFull,
  };
}
