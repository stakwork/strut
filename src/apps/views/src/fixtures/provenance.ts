// SpotCheck's fixtures: what `run/provenance` answers for a few things a
// legal-matter run made — a count an agent grepped for, a formula over a
// sum over an imported tab, a passage of the memo — shaped like a real
// run's answer (openlaw-run on a WARN Act motion), cut short.
import type { Provenance, ProvenanceSubject } from "../lib/provenance";

export const SPOT_WORKFLOW = "matter-review";
export const SPOT_RUN_ID = "1793658241194";
export const SPOT_SHEET = "1MatterFactsFixture";

const at = (hms: string) => `2026-11-02T${hms}.000Z`;
const XC = "matter-review/cross_check";
const DR = "matter-review/drafter";

const COUNT: Provenance = {
  subject: { cell: "FACTS!B13", value: "11" },
  refs: [],
  literals: [],
  figures: [],
  note: '"11" is too short to search for by its text — only where it was written or read by address.',
  moments: [
    {
      at: at("22:33:40"), path: "matter-review/writer/005-sheets_update_values", agent: "matter-review/writer", tool: "sheets_update_values", kind: "wrote", exact: true,
      where: "FACTS!B13", cell: "FACTS!B13", value: "", snippet: "",
      why: "I'm keeping the value cells blank and marking each one unverified, then I'll write the list to the sheet.",
    },
    {
      at: at("22:38:56"), path: `${XC}/049-sheets_update_values`, agent: XC, tool: "sheets_update_values", kind: "wrote", exact: true,
      where: "FACTS!B13", cell: "FACTS!B13", value: "NOT FOUND — requires full memo drafting to enumerate; see the motion's case citations (Matsushita, Celotex, Anderson, Arnett, Biggins …)",
      snippet: "NOT FOUND — requires full memo drafting to enumerate",
    },
    {
      at: at("22:39:14"), path: `${XC}/052-sheets_update_values`, agent: XC, tool: "sheets_update_values", kind: "wrote", exact: true,
      where: "FACTS!B13", cell: "FACTS!B13", value: "11", snippet: "11",
      why: "11 unique cases cited. Let's update the facts sheet.",
      before: [
        { tool: "sheets_update_values", path: `${XC}/049-sheets_update_values`, input: '{"range":"FACTS!B10:B19","values":[[3],["NOT FOUND — …"],[247],…]}' },
        { tool: "bash", path: `${XC}/050-bash`, input: '{"command":"grep -oP \\"\\\\*[A-Z][a-zA-Z.&\' ]+ v\\\\. [A-Za-z.&\' ]+\\\\*\\" motion.docx.txt | sort -u"}', output: "*Arnett v. Myers*\n*Biggins v. Hazen Paper Co.*\n*Celotex Corp. v. Catrett*\n*Hargrove v. Consolidated Logistics Corp.*\n*Matsushita Elec. Indus. Co. v. Zenith Radio Corp.*\n*Rifkin v. McDonnell Douglas Corp.*\n*See Halkias v. Gen. Dynamics Corp.*\n*See Loehrer v. McDonnell Douglas Corp.*" },
        { tool: "bash", path: `${XC}/051-bash`, input: '{"command":"grep -oP \\"\\\\*[^*]+v\\\\.[^*]+\\\\*\\" motion.docx.txt | sort -u"}', output: "* Fed. R. Civ. P. 56(a); *\n*Anderson v. Liberty Lobby, Inc.*\n*Arnett v. Myers*\n*Celotex Corp. v. Catrett*\n*Hotel Emps. & Rest. Emps. Int'l Union Local 54 v. Elsinore Shore Assocs.*\n*See Teamsters Local 413 v. Driver's, Inc.*" },
      ],
    },
    { at: at("22:54:35"), path: "matter-review/tailor/012-sheets_get_values", agent: "matter-review/tailor", tool: "sheets_get_values", kind: "read", exact: true, where: "FACTS!B13", cell: "FACTS!B13", value: "11", snippet: "11" },
    { at: at("23:46:50"), path: "matter-review/verify_arithmetic/020-sheets_get_values", agent: "matter-review/verify_arithmetic", tool: "sheets_get_values", kind: "read", exact: true, where: "FACTS!B13", cell: "FACTS!B13", value: "11", snippet: "11" },
  ],
};

const AVERAGE: Provenance = {
  subject: { cell: "FACTS!B93", value: "54853.4413" },
  formula: "=B79/247",
  refs: ["FACTS!B79"],
  literals: ["247"],
  figures: [],
  moments: [
    {
      at: at("23:15:59"), path: `${DR}/025-sheets_update_values`, agent: DR, tool: "sheets_update_values", kind: "wrote", exact: true,
      where: "FACTS!B93", cell: "FACTS!B93", value: "=B79/247", snippet: "=B79/247",
      why: "Now I'll add my computation block to the FACTS tab (all arithmetic as live formulas).",
      before: [
        { tool: "sheets_get_values", path: `${DR}/023-sheets_get_values`, input: '{"range":"FACTS!A36:B50","render":"formula"}', output: '{"values":[["COMPUTED FIGURES (live formulas)"],["recomputed_damages","=329.47*60*247"],…]}' },
        { tool: "sheets_get_values", path: `${DR}/024-sheets_get_values`, input: '{"range":"FACTS!A58:B92","render":"formula"}', output: '{"values":[["days_notice_to_termination","=DATE(2025,1,17)-DATE(2024,10,22)"],…]}' },
      ],
    },
    { at: at("23:16:04"), path: `${DR}/026-sheets_get_values`, agent: DR, tool: "sheets_get_values", kind: "read", exact: true, where: "FACTS!B93", cell: "FACTS!B93", value: "54853.44129554656", snippet: "54853.44129554656" },
    {
      at: at("23:29:54"), path: `${DR}/039-str_replace_based_edit_tool`, agent: DR, tool: "str_replace_based_edit_tool", kind: "wrote", exact: false,
      where: "make_memo_data.py", file: "/tmp/work/make_memo_data.py", cites: ["FACTS!B92", "FACTS!B93"],
      snippet: "…329.47 per day implies an average annual salary of $120,256.55 (FACTS!B92) against the record's actual average of $54,853.44 (FACTS!B93) — 2.19 times too high…",
      why: "Now I'll write the document generator script.",
    },
    {
      at: at("23:47:22"), path: "matter-review/verify_correctness/031-bash", agent: "matter-review/verify_correctness", tool: "bash", kind: "used", exact: false,
      where: '$ grep -n "120,256\\|54,853" sources/headcount-data.xlsx.txt', snippet: 'grep -n "120,256\\|54,853\\|Average Annual Salary" sources/headcount-data.xlsx.txt',
      why: "I'll search the Payroll Summary workbook for the salary numbers.",
    },
  ],
};

const SUM: Provenance = {
  subject: { cell: "FACTS!B79" },
  formula: "=SUM('SOURCE: headcount-data.xlsx — Termination Detail'!K2:K248)",
  refs: ["'SOURCE: headcount-data.xlsx — Termination Detail'!K2:K248"],
  literals: [],
  figures: [],
  moments: [
    {
      at: at("22:37:32"), path: `${XC}/036-bash`, agent: XC, tool: "bash", kind: "read", exact: false,
      where: "$ python3 -c \" import re text = open('headcount-data.xlsx.txt').read() …", snippet: "Nashville Plant 1 138 7697600.0 Chattanooga Plant 2 73 3924100.0 Huntsville Plant 3 36 1927100.0 grand total 13548800.0",
    },
    {
      at: at("22:37:52"), path: `${XC}/038-sheets_batch_update_values`, agent: XC, tool: "sheets_batch_update_values", kind: "wrote", exact: true,
      where: "FACTS!B79", cell: "FACTS!B79", value: "=SUM('SOURCE: headcount-data.xlsx — Termination Detail'!K2:K248)", snippet: "=SUM(…)",
      why: "I'll confirm the multiplier with live SUMIF formulas in the Sheet before citing it.",
    },
    { at: at("22:37:56"), path: `${XC}/039-sheets_get_values`, agent: XC, tool: "sheets_get_values", kind: "read", exact: true, where: "FACTS!B79", cell: "FACTS!B79", value: "13548800", snippet: "13548800" },
  ],
};

const SOURCE: Provenance = {
  subject: { cell: "'SOURCE: headcount-data.xlsx — Termination Detail'!K2:K248" },
  refs: [],
  literals: [],
  figures: [],
  moments: [
    {
      at: at("22:24:07"), path: "matter-review/sheet_fill", tool: "sheets/batch-update-values", kind: "wrote", exact: true,
      where: "'SOURCE: headcount-data.xlsx — Termination Detail'!K2 and 246 more", cell: "'SOURCE: headcount-data.xlsx — Termination Detail'!K2",
      snippet: "…K2 = 94500; …K3 = 68200; …K4 = 51800; …",
    },
  ],
};

const PASSAGE: Provenance = {
  subject: { value: "The actual average of the 247 salaries in the same exhibit is $54,853.44", file: "issue-identification-memo.html" },
  refs: [],
  literals: [],
  figures: ["247", "$54,853.44"],
  moments: [
    {
      at: at("23:39:49"), path: `${DR}/041-str_replace_based_edit_tool`, agent: DR, tool: "str_replace_based_edit_tool", kind: "wrote", exact: false,
      where: "make_memo.py", file: "/tmp/work/make_memo.py", cites: ["FACTS!B92"],
      snippet: "…a rate of $329.47 implies an average annual salary of $120,256.55 (FACTS!B92). \" \"The actual average of the 247 salaries in the same exhibit is $54,853.44 (…",
      why: "I'm sketching the risk table layout and deciding how to get a short vehicle label for each of the 49 issues.",
    },
  ],
};

/** The examples the gallery offers, by name. */
export const SPOT_SUBJECTS: Array<{ label: string; subject: ProvenanceSubject }> = [
  { label: "A count (FACTS!B13)", subject: COUNT.subject },
  { label: "A formula (FACTS!B93)", subject: AVERAGE.subject },
  { label: "A passage of the memo", subject: PASSAGE.subject },
];

/** `run/provenance` over the fixtures: by cell, else by value; anything else is found nowhere. */
export function provenanceFixture(c: Record<string, unknown>): Provenance {
  const cell = typeof c["cell"] === "string" ? c["cell"] : undefined;
  const value = typeof c["value"] === "string" ? c["value"] : undefined;
  const known = [COUNT, AVERAGE, SUM, SOURCE, PASSAGE].find((p) => (cell ? p.subject.cell === cell : !!value && p.subject.value === value));
  if (known) return known;
  const subject: ProvenanceSubject = { ...(value ? { value } : {}), ...(cell ? { cell } : {}) };
  return { subject, moments: [], refs: [], literals: [], figures: [], note: "Nothing in this run's log matches it — it may have been written outside the run, or by a script whose command does not hold it." };
}
