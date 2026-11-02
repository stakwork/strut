// SheetView's fixtures: two Google sheets as `sheets/get-values { grid: true }`
// answers — an NDA deviation matrix a review run fills in row by row, and a
// covenant compliance book whose ratios are formulas over an Inputs tab — a
// CSV a run wrote, and the legal Concepts and passages their cells came from.
import type { RunSummary } from "@strut/kit";
import type { RunFile } from "../lib/run-file";
import type { GraphNode } from "../lib/graph";

export const NDA_WORKFLOW = "nda-review";
export const NDA_SHEET = "1NdaDeviationMatrixFixture";
export const NDA_RANGE = "Matrix!A1:H20";
export const COVENANT_SHEET = "1CovenantComplianceFixture";
export const COVENANT_RANGE = "Compliance!A1:I20";
/** A CSV in the research run's files (fixtures/runs.ts RUN_ID). */
export const DEVIATIONS_CSV = "deviations.csv";

export const LEGAL = {
  nda: "e1000000-0000-4000-8000-0000000000a1",
  nonSolicit: "e2000000-0000-4000-8000-0000000000a2",
  standstill: "e3000000-0000-4000-8000-0000000000a3",
  residuals: "e4000000-0000-4000-8000-0000000000a4",
  apexSection7: "f1000000-0000-4000-8000-0000000000b1",
  cedarSection9: "f2000000-0000-4000-8000-0000000000b2",
  leverage: "e5000000-0000-4000-8000-0000000000a5",
  creditAgreement: "f3000000-0000-4000-8000-0000000000b3",
  q3Financials: "f4000000-0000-4000-8000-0000000000b4",
} as const;

const legal = (ref_id: string, node_type: string, name: string, properties: Record<string, unknown>): Omit<GraphNode, "edges"> => ({
  ref_id, node_type, name, properties: { name, namespace: "default", ...properties },
});

/** What the cells cite (fixtures/graph.ts serves them with the rest). */
export const LEGAL_NODES: Array<Omit<GraphNode, "edges">> = [
  legal(LEGAL.nda, "Concept", "Non-disclosure agreement", { description: "Confidentiality terms for a sale process: who may see what, for how long, and what follows.", docs: "Review an NDA against the **playbook**: term, definition of confidential information, non-solicit, standstill, residuals, return or destruction, governing law, remedies." }),
  legal(LEGAL.nonSolicit, "Concept", "Non-solicitation", { description: "The bidder may not hire the target's employees for a period.", docs: "Playbook: **12 months**, with a carve-out for general solicitations not aimed at the target's people. Anything over 18 months is high risk." }),
  legal(LEGAL.standstill, "Concept", "Standstill", { description: "The bidder may not buy shares or make an unsolicited offer for a period.", docs: "Playbook: **12 months**, falling away if a third party announces an offer. No standstill at all is high risk." }),
  legal(LEGAL.residuals, "Concept", "Residuals clause", { description: "Lets the recipient use what its people remember unaided.", docs: "Playbook: not permitted. A residuals clause in a bidder's draft is high risk." }),
  legal(LEGAL.apexSection7, "Document", "Apex Capital NDA draft — §7 Non-solicitation", { content: "For a period of twenty-four (24) months from the date hereof, the Recipient shall not, directly or indirectly, solicit for employment or hire any employee of the Company…" }),
  legal(LEGAL.cedarSection9, "Document", "Cedar Group markup — §9 Residuals", { content: "Nothing herein shall restrict the Recipient's use of Residuals, being information retained in the unaided memory of its Representatives…" }),
  legal(LEGAL.leverage, "Concept", "Total net leverage covenant", { description: "Total debt less cash, over trailing EBITDA, tested each quarter against a maximum.", docs: "A maintenance covenant: breach at a test date is an Event of Default unless cured (equity cure, §8.4)." }),
  legal(LEGAL.creditAgreement, "Document", "Credit agreement — §7.11(a)", { content: "The Borrower shall not permit the Total Net Leverage Ratio as of the last day of any Fiscal Quarter to exceed 3.50:1.00." }),
  legal(LEGAL.q3Financials, "Document", "Q3 2026 management accounts", { content: "EBITDA (LTM) $44.9m; total debt $176.0m; unrestricted cash $16.2m." }),
];

export const LEGAL_EDGES: Array<{ source: string; target: string; edge_type: string }> = [
  { source: LEGAL.nda, target: LEGAL.nonSolicit, edge_type: "PARENT_OF" },
  { source: LEGAL.nda, target: LEGAL.standstill, edge_type: "PARENT_OF" },
  { source: LEGAL.nda, target: LEGAL.residuals, edge_type: "PARENT_OF" },
  { source: LEGAL.apexSection7, target: LEGAL.nonSolicit, edge_type: "ABOUT" },
  { source: LEGAL.cedarSection9, target: LEGAL.residuals, edge_type: "ABOUT" },
  { source: LEGAL.creditAgreement, target: LEGAL.leverage, edge_type: "ABOUT" },
];

// ── A grid answer ──────────────────────────────────────────────────────────

/** A cell as written: text, a number, or a value with its display text and the formula that computes it. */
type Spec = string | number | null | { v: number | string; d?: string; f?: string };

const letters = (col: number) => String.fromCharCode(65 + col);

/** What `sheets/get-values { grid: true }` returns for these cells at A1. */
function grid(id: string, title: string, tabs: Array<{ id: number; title: string }>, sheet: string, cells: Spec[][]) {
  const width = Math.max(0, ...cells.map((r) => r.length));
  const sheetId = tabs.find((t) => t.title === sheet)!.id;
  const value = (s: Spec) => (s && typeof s === "object" ? s.v : s);
  const display = (s: Spec) => (s && typeof s === "object" ? s.d ?? String(s.v) : s === null ? "" : String(s));
  const formula = (s: Spec) => (s && typeof s === "object" && s.f ? s.f : null);
  const anyFormula = cells.some((r) => r.some((s) => formula(s) !== null));
  return {
    spreadsheet_id: id,
    title,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${sheetId}`,
    sheet,
    sheetId,
    tabs,
    range: cells.length ? `'${sheet}'!A1:${letters(width - 1)}${cells.length}` : `'${sheet}'!A1`,
    values: cells.map((r) => r.map(value)),
    display: cells.map((r) => r.map(display)),
    ...(anyFormula ? { formulas: cells.map((r) => r.map(formula)) } : {}),
  };
}

// ── The NDA deviation matrix ───────────────────────────────────────────────

const NDA_HEADER = ["Provision", "Playbook", "Apex Capital", "Apex risk", "Borealis Partners", "Borealis risk", "Cedar Group", "Cedar risk"];

/** Provision, playbook, then each bidder's position and its risk. */
const PROVISIONS: string[][] = [
  ["Term", "2 years", "3 years", "Medium", "2 years", "Low", "5 years", "High"],
  ["Confidential information", "Marked, or reasonably understood as confidential", "All information, marked or not", "Medium", "As playbook", "Low", "Marked only", "Low"],
  ["Non-solicit", "12 months; general solicitations carved out", "24 months; no carve-out", "High", "12 months; carve-out kept", "Low", "18 months", "Medium"],
  ["Standstill", "12 months; falls away on a third-party offer", "None", "High", "6 months", "Medium", "12 months; fall-away kept", "Low"],
  ["Residuals", "Not permitted", "Not permitted", "Low", "Not permitted", "Low", "Permitted (unaided memory)", "High"],
  ["Return or destruction", "30 days; legal-hold copies kept", "10 days; certify destruction", "Medium", "As playbook", "Low", "As playbook", "Low"],
  ["Governing law", "Delaware", "New York", "Low", "Delaware", "Low", "England and Wales", "Medium"],
  ["Remedies", "Injunctive relief without bond", "Bond required", "Medium", "As playbook", "Low", "As playbook", "Low"],
];

const highs = (col: number) => PROVISIONS.filter((p) => p[col] === "High").length;
const highsRow = (n: number): Spec[] => [
  "High-risk deviations", null,
  { f: `=COUNTIF(D2:D${n + 1},"High")`, v: highs(3) }, null,
  { f: `=COUNTIF(F2:F${n + 1},"High")`, v: highs(5) }, null,
  { f: `=COUNTIF(H2:H${n + 1},"High")`, v: highs(7) }, null,
];

/** Reads of the matrix as the review writes it: read `k` holds the first k provisions, the newest without its risks yet; the last adds the count. */
export const NDA_FRAMES = PROVISIONS.length + 2;

export function ndaFrame(k: number) {
  const rows: Spec[][] = [NDA_HEADER];
  const shown = Math.min(k, PROVISIONS.length);
  PROVISIONS.slice(0, shown).forEach((p, i) => {
    const pending = i === shown - 1 && k <= PROVISIONS.length;
    rows.push(pending ? p.map((c, j) => (j === 3 || j === 5 || j === 7 ? "" : c)) : p);
  });
  if (k > PROVISIONS.length) rows.push(highsRow(PROVISIONS.length));
  return grid(NDA_SHEET, "Project Lantern — NDA deviation matrix", [{ id: 0, title: "Matrix" }, { id: 731, title: "Playbook" }], "Matrix", rows);
}

/** The playbook tab: the positions the matrix compares against. */
export const ndaPlaybook = () =>
  grid(NDA_SHEET, "Project Lantern — NDA deviation matrix", [{ id: 0, title: "Matrix" }, { id: 731, title: "Playbook" }], "Playbook", [
    ["Provision", "Position", "Fallback", "Walk away"],
    ...PROVISIONS.map((p) => [p[0]!, p[1]!, "Escalate to deal counsel", p[0] === "Standstill" ? "No standstill" : ""]),
  ]);

/** Where the matrix's cells came from: a row by its provision, a cell by its address. */
export const NDA_SOURCES: Record<string, string[]> = {
  "Non-solicit": [LEGAL.nonSolicit],
  Standstill: [LEGAL.standstill],
  Residuals: [LEGAL.residuals],
  C4: [LEGAL.apexSection7, LEGAL.nonSolicit],
  G6: [LEGAL.cedarSection9, LEGAL.residuals],
};

/** The review run, as `run/get` reports it while the matrix fills. */
export const ndaRun = (runId: string, done: boolean): RunSummary => ({
  runId,
  workflow: NDA_WORKFLOW,
  status: done ? "success" : "running",
  startedAt: new Date(Number(runId)).toISOString(),
  actor: "ada-7f3c",
});

// ── Covenant compliance ────────────────────────────────────────────────────

const QUARTERS = ["Q4 2025", "Q1 2026", "Q2 2026", "Q3 2026"];
const INPUTS: Array<[string, number[]]> = [
  ["EBITDA (LTM, $m)", [48.2, 51.0, 46.7, 44.9]],
  ["Total debt ($m)", [162.0, 158.5, 171.3, 176.0]],
  ["Interest expense ($m)", [11.4, 11.9, 12.6, 13.1]],
  ["Fixed charges ($m)", [19.8, 20.3, 21.0, 21.7]],
  ["Unrestricted cash ($m)", [22.5, 25.1, 18.4, 16.2]],
];
const input = (row: number, q: number) => INPUTS[row]![1][q]!;
const COVENANT_TABS = [{ id: 0, title: "Compliance" }, { id: 1182, title: "Inputs" }];
const COVENANT_TITLE = "Northwind Holdings — Q3 2026 covenant compliance";

/** Inputs column for a quarter: B…E. */
const qcol = (q: number) => letters(1 + q);
const times = (n: number) => `${n < 0 ? "(" : ""}${Math.abs(n).toFixed(2)}x${n < 0 ? ")" : ""}`;
const round = (n: number) => Number(n.toFixed(4));

function covenant(row: number, name: string, section: string, threshold: number, max: boolean, f: (q: number) => [string, number], fmt: (n: number) => string): Spec[] {
  const at = QUARTERS.map((_, q) => f(q));
  const last = at[at.length - 1]![1];
  const head = max ? threshold - last : last - threshold;
  return [
    name,
    section,
    { v: threshold, d: fmt(threshold) },
    ...at.map(([formula, v]) => ({ f: formula, v: round(v), d: fmt(v) })),
    { f: max ? `=C${row}-G${row}` : `=G${row}-C${row}`, v: round(head), d: fmt(head) },
    { f: max ? `=IF(G${row}<=C${row},"Compliant","Breach")` : `=IF(G${row}>=C${row},"Compliant","Breach")`, v: (max ? last <= threshold : last >= threshold) ? "Compliant" : "Breach" },
  ];
}

export function covenantSheet(range: string) {
  if (/^'?Inputs'?(!|$)/.test(range)) {
    return grid(COVENANT_SHEET, COVENANT_TITLE, COVENANT_TABS, "Inputs", [
      ["Metric", ...QUARTERS],
      ...INPUTS.map(([name, v]): Spec[] => [name, ...v.map((n) => ({ v: n, d: n.toFixed(1) }))]),
    ]);
  }
  return grid(COVENANT_SHEET, COVENANT_TITLE, COVENANT_TABS, "Compliance", [
    ["Covenant", "Section", "Threshold", ...QUARTERS, "Headroom", "Status"],
    covenant(2, "Max total net leverage", "§7.11(a)", 3.5, true, (q) => [`=(Inputs!${qcol(q)}3-Inputs!${qcol(q)}6)/Inputs!${qcol(q)}2`, (input(1, q) - input(4, q)) / input(0, q)], times),
    covenant(3, "Min interest coverage", "§7.11(b)", 3.0, false, (q) => [`=Inputs!${qcol(q)}2/Inputs!${qcol(q)}4`, input(0, q) / input(2, q)], times),
    covenant(4, "Min fixed charge coverage", "§7.11(c)", 1.25, false, (q) => [`=Inputs!${qcol(q)}2/Inputs!${qcol(q)}5`, input(0, q) / input(3, q)], times),
    covenant(5, "Min liquidity ($m)", "§7.12", 15, false, (q) => [`=Inputs!${qcol(q)}6`, input(4, q)], (n) => n.toFixed(1)),
  ]);
}

export const COVENANT_SOURCES: Record<string, string[]> = {
  "Max total net leverage": [LEGAL.leverage, LEGAL.creditAgreement],
  G2: [LEGAL.q3Financials],
};

// ── A CSV a run wrote ──────────────────────────────────────────────────────

export const SHEET_FILES: Record<string, RunFile> = {
  [DEVIATIONS_CSV]: {
    path: DEVIATIONS_CSV,
    mediaType: "text/csv",
    bytes: 412,
    text: [
      "Clause,Bidder,Draft,Deviation,Days to cure",
      'Non-solicit,Apex Capital,"24 months, no carve-out",High,0',
      'Standstill,Apex Capital,None,High,0',
      'Residuals,Cedar Group,"Permitted, ""unaided memory""",High,5',
      "Term,Cedar Group,5 years,High,10",
      "Governing law,Cedar Group,England and Wales,Medium,15",
    ].join("\n") + "\n",
  },
};
