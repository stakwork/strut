// What `run/provenance` answers (src/provenance.ts, plans/spot-check.md) and
// the words SpotCheck draws it in — pure, so a test reads them without a DOM.

/** What a person picked: a value as shown, and where it sits when the view knows. */
export interface ProvenanceSubject {
  value?: string;
  /** A sheet range: `FACTS!B13`, `'SOURCE: a.xlsx — Detail'!K2:K248`. */
  cell?: string;
  spreadsheet?: string;
  /** A graph node's ref_id. */
  node?: string;
  file?: string;
}

export interface ProvenanceCall {
  tool: string;
  path: string;
  input: string;
  output?: string;
}

export interface ProvenanceMoment {
  at: string;
  path: string;
  agent?: string;
  tool: string;
  toolCallId?: string;
  kind: "wrote" | "used" | "read";
  exact: boolean;
  where: string;
  cell?: string;
  node?: { ref_id: string; name?: string; node_type?: string };
  file?: string;
  value?: string;
  snippet: string;
  cites?: string[];
  why?: string;
  before?: ProvenanceCall[];
}

export interface Provenance {
  subject: ProvenanceSubject;
  moments: ProvenanceMoment[];
  refs: string[];
  literals: string[];
  formula?: string;
  figures: string[];
  omitted?: number;
  note?: string;
}

/** The step SpotCheck reads through: a `run/*` step, so the run's workflow in `grants.workflows` is all it needs. */
export const PROVENANCE_STEP = "run/provenance";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One line naming the subject: the cell, the node, the file, or the value. */
export function subjectLabel(s: ProvenanceSubject, nodeName?: string): string {
  const value = s.value?.trim().replace(/\s+/g, " ");
  if (s.cell) return value ? `${s.cell} = ${clip(value, 60)}` : s.cell;
  if (s.node) return nodeName ?? (value ? clip(value, 80) : `node ${s.node.slice(0, 8)}`);
  if (value) return `“${clip(value, 120)}”`;
  return s.file?.split("/").pop() ?? "—";
}

/** One spelling of a cell address: `'FACTS'!$B$13` and `FACTS!B13` are the same cell. */
export const cellKeyOf = (cell: string): string => cell.replace(/\$/g, "").replace(/^'((?:[^']|'')+)'!/, (_m, tab: string) => `${tab.replace(/''/g, "'")}!`);
export const sameCell = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && cellKeyOf(a) === cellKeyOf(b);

/** A stable key for a subject: what a query and a trail are keyed by. */
export const subjectKey = (s: ProvenanceSubject): string =>
  JSON.stringify([s.value ?? null, s.cell ?? null, s.spreadsheet ?? null, s.node ?? null, s.file ?? null]);

/** Who did it: the agent (its step's last segment), a workflow step, or the run itself. */
export function whoOf(m: ProvenanceMoment): string {
  if (m.tool === "run input") return "the run";
  return (m.agent ?? m.path).split("/").pop() ?? m.path;
}

/** What happened, in words: "wrote FACTS!B13", "used it in $ grep …", "read it in FACTS!B93". */
export function momentPhrase(m: ProvenanceMoment): string {
  if (m.tool === "run input") return "had it in its input";
  if (!m.agent) {
    const step = m.path.split("/").pop();
    if (m.kind === "wrote") return m.cell ? `step ${step} wrote ${m.where}` : `step ${step} wrote it`;
    if (m.kind === "used") return `step ${step} was given it`;
    return `step ${step} produced it`;
  }
  if (m.kind === "wrote") return `wrote ${m.where}`;
  if (m.kind === "used") return `used it in ${m.where}`;
  return `read it in ${m.where}`;
}

/** The moments that matter most: where it was first seen (the first read before any write) and its last write. */
export function landmarks(moments: readonly ProvenanceMoment[]): { firstSeen: number; lastWrite: number } {
  const firstWrite = moments.findIndex((m) => m.kind === "wrote");
  const firstSeen = moments.findIndex((m, i) => m.kind === "read" && (firstWrite < 0 || i < firstWrite));
  let lastWrite = -1;
  for (let i = moments.length - 1; i >= 0 && lastWrite < 0; i--) if (moments[i]!.kind === "wrote" && moments[i]!.exact) lastWrite = i;
  for (let i = moments.length - 1; i >= 0 && lastWrite < 0; i--) if (moments[i]!.kind === "wrote") lastWrite = i;
  return { firstSeen, lastWrite };
}

/** What to mark in a snippet: the value, and a number's digits as a sheet holds them (`$54,853` → `54853`). */
export function markTerms(value: string | undefined): string[] {
  const v = value?.trim();
  if (!v) return [];
  const digits = /^[($€£]?\s*-?[\d,]+(\.\d+)?%?\)?$/.test(v) ? v.replace(/[^\d.]/g, "").replace(/\.$/, "") : "";
  return [...new Set([v.length > 80 ? v.slice(0, 80) : v, digits].filter((t) => t.length >= 2))];
}

/** A time of day from an ISO moment. */
export const clock = (at: string): string => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
