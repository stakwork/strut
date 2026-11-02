// The gallery's legal matter: a `matter` run on Project Lantern that reviews
// the bidders' NDAs against the firm's drafting rules — it walks the Concept
// tree (Law → M&A → Non-disclosure agreement → NDA drafting rules), writes an
// issues memo, fills the deviation matrix (the Google sheet SheetView's
// fixtures serve, filling in as it is read), redlines Apex's draft and lays
// out the process's timeline. Each step declares what it made in its output,
// so WorkProducts draws them one by one as the run goes.
import type { RunEvent } from "@strut/kit";
import type { GraphNode } from "../lib/graph";
import type { RunFile } from "../lib/run-file";
import { LEGAL, NDA_SHEET, NDA_SOURCES } from "./sheets";

export const MATTER_WORKFLOW = "matter";
export const MATTER_RUN_ID = "1790000000900";
/** The same run, replayed as if in flight. */
export const MATTER_LIVE_RUN_ID = "1790000000901";
/** The finished run's matrix: the NDA sheet as the review left it (the live
 *  run reads `NDA_SHEET`, which fills a provision a read). */
export const MATTER_SHEET_DONE = "1NdaDeviationMatrixDone";

/** The tree above SheetView's legal Concepts, and the firm's playbook under the NDA. */
export const MATTER = {
  law: "e0000000-0000-4000-8000-000000000100",
  mna: "e0000000-0000-4000-8000-000000000101",
  drafting: "e0000000-0000-4000-8000-000000000103",
} as const;

const node = (ref_id: string, node_type: string, name: string, properties: Record<string, unknown>): Omit<GraphNode, "edges"> => ({
  ref_id, node_type, name, properties: { name, namespace: "default", ...properties },
});

/** fixtures/graph.ts serves them with the rest. */
export const MATTER_NODES: Array<Omit<GraphNode, "edges">> = [
  node(MATTER.law, "Concept", "Law", { description: "The root of the legal tree." }),
  node(MATTER.mna, "Concept", "M&A", { description: "Mergers and acquisitions: the deal, its diligence, its documents." }),
  node(MATTER.drafting, "Concept", "NDA drafting rules", { description: "How this firm reviews a bidder's NDA.", docs: "Compare every provision with the playbook.\n\nRecord each deviation in a **Google Sheet**, one row per provision, one column pair per bidder: the bidder's position and its risk." }),
];

export const MATTER_EDGES: Array<{ source: string; target: string; edge_type: string }> = [
  { source: MATTER.law, target: MATTER.mna, edge_type: "PARENT_OF" },
  { source: MATTER.mna, target: LEGAL.nda, edge_type: "PARENT_OF" },
  { source: LEGAL.nda, target: MATTER.drafting, edge_type: "PARENT_OF" },
];

const T0 = Date.UTC(2026, 10, 2, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

const memo = { id: "memo", kind: "markdown", title: "Issues memo", summary: "Three high-risk deviations across the bidders; two need the partner's call.", path: "memo.md", from: [LEGAL.nda, MATTER.drafting, LEGAL.nonSolicit, LEGAL.standstill, LEGAL.apexSection7] };
const matrix = (sheet: string, summary: string) => ({
  id: "matrix", kind: "sheet", title: "Deviation matrix", summary,
  url: sheetUrl(sheet), from: [MATTER.drafting, LEGAL.nonSolicit, LEGAL.standstill, LEGAL.residuals, LEGAL.apexSection7, LEGAL.cedarSection9],
  content: { sources: NDA_SOURCES },
});
const redline = { id: "redline", kind: "redline", title: "Apex NDA redline", summary: "Our changes to Apex Capital's draft, as tracked changes.", path: "apex-redline.docx", render: "apex-redline.html", from: [MATTER.drafting, LEGAL.nonSolicit, LEGAL.standstill, LEGAL.apexSection7], content: { sources: { "0": [LEGAL.apexSection7], "1": [LEGAL.nonSolicit], "2": [LEGAL.standstill] } } };
const timeline = { id: "timeline", kind: "timeline", title: "Process timeline", summary: "From the teaser to first-round bids.", path: "timeline.json", from: [LEGAL.nda] };

/** A step's start and end, `s` seconds in for `d` seconds. */
function step(path: string, stepType: string, s: number, d: number, end: Record<string, unknown> = {}): RunEvent[] {
  return [
    { type: "step.start", path, stepType, ts: at(s) },
    { type: "step.end", path, stepType, ts: at(s + d), durationMs: d * 1000, ...end },
  ];
}

const W = MATTER_WORKFLOW;

/** The run's log, its matrix the sheet `sheet`. */
function matterEvents(runId: string, sheet: string): RunEvent[] {
  const filled = matrix(sheet, "8 provisions, 3 bidders");
  return [
    { type: "run.start", path: W, ts: at(0), runId, workflow: W, actor: "ada-7f3c", input: { matter: "Project Lantern — bidder NDAs" } },
    ...step(`${W}/rules`, "graph/walk", 0, 8, {
      output: { nodes: 4 },
      nodes: [
        { ref_id: MATTER.law, node_type: "Concept", name: "Law" },
        { ref_id: MATTER.mna, node_type: "Concept", name: "M&A" },
        { ref_id: LEGAL.nda, node_type: "Concept", name: "Non-disclosure agreement" },
        { ref_id: MATTER.drafting, node_type: "Concept", name: "NDA drafting rules" },
      ],
    }),
    ...step(`${W}/memo`, "llm", 8, 14, { output: { text: "…", artifacts: [memo] }, modelCalls: 1, cost: 0.031 }),
    { type: "step.start", path: `${W}/review`, stepType: "agent", ts: at(22) },
    ...step(`${W}/review/001-sheets_create-spreadsheet`, "tool:sheets/create-spreadsheet", 24, 3, { output: "{\"spreadsheetId\":\"1Nda…", artifacts: [matrix(sheet, "Filling in: one row per provision")] }),
    ...step(`${W}/review/002-sheets_update-values`, "tool:sheets/update-values", 34, 3, { output: "{\"updatedRows\":9…", artifacts: [filled] }),
    ...step(`${W}/review/003-docx_redline`, "tool:docx/redline", 42, 6, { output: "{\"changes\":3…", artifacts: [redline] }),
    { type: "step.end", path: `${W}/review`, stepType: "agent", ts: at(50), durationMs: 28_000, output: { result: "Matrix filled, Apex's draft redlined." }, modelCalls: 6, cost: 0.142 },
    ...step(`${W}/timeline`, "llm", 50, 7, { output: { artifacts: [timeline] }, modelCalls: 1, cost: 0.012 }),
    ...step(`${W}/result`, "pack", 57, 0.2, { output: { text: "Review done.", artifacts: [memo, filled, redline, timeline] } }),
    { type: "run.end", path: W, ts: at(57.2), runId, status: "success", durationMs: 57_200, output: { text: "Review done.", artifacts: [memo, filled, redline, timeline] } },
  ];
}

export const MATTER_EVENTS = matterEvents(MATTER_RUN_ID, MATTER_SHEET_DONE);
export const MATTER_LIVE_EVENTS = matterEvents(MATTER_LIVE_RUN_ID, NDA_SHEET);

const text = (path: string, mediaType: string, body: string): RunFile => ({ path, mediaType, bytes: body.length, text: body });

export const MATTER_FILES: Record<string, RunFile> = {
  "memo.md": text("memo.md", "text/markdown", [
    "# Project Lantern — bidder NDAs",
    "",
    "Three drafts against our **NDA drafting rules**. Borealis is close to the playbook; Apex and Cedar are not.",
    "",
    "1. **Apex — non-solicit.** Twenty-four months with no carve-out for general solicitations. The playbook is twelve, carve-out kept: redlined.",
    "2. **Apex — standstill.** None at all. The playbook asks for twelve months, falling away on a third-party offer: added in the redline.",
    "3. **Cedar — residuals.** Their markup lets their people use what they remember unaided. Not permitted: strike it.",
    "",
    "Cedar's five-year term and English law are negotiable.",
    "",
    "**For the partner:** whether a standstill is a condition of Apex staying in the process, and whether to concede eighteen months on Cedar's non-solicit.",
  ].join("\n")),
  "apex-redline.html": text("apex-redline.html", "text/html", [
    "<h2>Confidentiality Agreement — Apex Capital</h2>",
    "<h3>7. Non-Solicitation</h3>",
    "<p>For a period of <del>twenty-four (24)</del><ins>twelve (12)</ins> months from the date hereof, the Recipient shall not, directly or indirectly, solicit for employment or hire any employee of the Company<ins>; provided that general solicitations not directed at the Company's employees shall not breach this Section 7</ins>.</p>",
    "<h3>8. Standstill</h3>",
    "<p><ins>For twelve (12) months from the date hereof, the Recipient shall not acquire any securities of the Company or propose any acquisition of the Company, unless a third party has announced an offer for the Company.</ins></p>",
    "<h3>12. Governing Law</h3>",
    "<p>This Agreement is governed by the laws of the State of New York.</p>",
  ].join("\n")),
  "timeline.json": text("timeline.json", "application/json", JSON.stringify({
    entries: [
      { date: "2026-09-21", title: "Teaser sent to twelve parties" },
      { date: "2026-10-12", title: "NDAs back from Apex, Borealis and Cedar", sources: [LEGAL.apexSection7, LEGAL.cedarSection9] },
      { date: "2026-11-02", title: "Markups returned", detail: "Apex: non-solicit, standstill. Cedar: residuals." },
      { date: "2026-11-30", title: "First-round bids due", detail: "Every bidder signs before it sees the data room." },
    ],
  }, null, 2)),
};
