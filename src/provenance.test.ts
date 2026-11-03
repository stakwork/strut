import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "./core.js";
import { buildProvenance, citedCells, figuresIn, formulaParts, needleOf, normalizeText, parseRange } from "./provenance.js";

// The spot check's engine (plans/spot-check.md) over a log shaped like
// openlaw-run's: an agent that greps a document and fills a sheet cell twice,
// a drafter that writes a formula block anchored at one cell and a memo
// script, a graph write, and a workflow step that imports a source tab.

let clock = 0;
const ts = () => new Date(Date.UTC(2026, 10, 2, 22, 0, clock++)).toISOString();
const ev = (type: RunEvent["type"], path: string, extra: Partial<RunEvent> & Record<string, unknown> = {}): RunEvent =>
  ({ ts: ts(), runId: "1", path, type, ...extra }) as RunEvent;
/** A tool call's two events; its whole result lives in the agent's transcript. */
const call = (agent: string, n: number, tool: string, id: string, input: unknown, preview: unknown = "…", nodes?: unknown[]): RunEvent[] => {
  const path = `${agent}/${String(n).padStart(3, "0")}-${tool}`;
  return [
    ev("step.start", path, { stepType: `tool:${tool}`, input, toolCallId: id }),
    ev("step.end", path, { stepType: `tool:${tool}`, output: preview, toolCallId: id, ...(nodes ? { nodes } : {}) }),
  ];
};
const SHEET = "1rHl";
const GREP_OUT = "*Anderson v. Liberty Lobby, Inc.*\n*Celotex Corp. v. Catrett*\n*Matsushita Elec. Indus. Co. v. Zenith Radio Corp.*";
const MEMO = `ISSUES = ["The actual average of the 247 salaries in the same exhibit is $54,853.44 (FACTS!B93) \\u2014 2.19 times too high"]`;

function log(): RunEvent[] {
  clock = 0;
  const xc = "wf/cross_check";
  const dr = "wf/drafter";
  return [
    ev("run.start", "wf", { input: { task_slug: "employment-labor/identify-issues" } }),
    ev("step.start", "wf/sheet_fill", { stepType: "sheets/batch-update-values", input: { spreadsheet_id: SHEET, data: [{ range: "'SOURCE: a.xlsx — Detail'!K1", values: [["Salary"], [94500], [68200]] }] } }),
    ev("step.end", "wf/sheet_fill", { stepType: "sheets/batch-update-values", output: { total_updated_cells: 3 } }),
    ev("step.start", xc, { stepType: "agent", input: { prompt: "Fill FACTS." } }),
    ...call(xc, 1, "sheets_update_values", "c1", { spreadsheet_id: SHEET, range: "FACTS!B10:B14", values: [[3], [""], [247], ["NOT FOUND — 11 named cases"], [2]] }),
    ...call(xc, 2, "bash", "c2", { command: "grep -oP '\\*[^*]+v\\.[^*]+\\*' motion.txt | sort -u" }),
    ...call(xc, 3, "sheets_update_values", "c3", { spreadsheet_id: SHEET, range: "FACTS!B13", values: [[11]] }),
    ...call(xc, 4, "sheets_get_values", "c4", { spreadsheet_id: SHEET, range: "FACTS!A1:B20" }),
    ...call(xc, 5, "graph_create_node", "c5", { node_type: "ComputedFigure", node_data: { name: "sum_salaries", value: 162700 } }, "…", [{ ref_id: "n-1", name: "sum_salaries", node_type: "ComputedFigure" }]),
    ev("step.end", xc, {
      stepType: "agent",
      output: { result: "done" },
      messages: [
        { role: "system", content: "You are the cross-check agent." },
        { role: "user", content: "Fill FACTS." },
        { role: "assistant", content: [{ type: "reasoning", text: "Seeding the counts." }, { type: "tool-call", toolCallId: "c1", toolName: "sheets_update_values", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: { type: "json", value: { updated_range: "FACTS!B10:B14" } } }] },
        { role: "assistant", content: [{ type: "text", text: "Counting the cases the motion cites." }, { type: "tool-call", toolCallId: "c2", toolName: "bash", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", output: { type: "text", value: GREP_OUT } }] },
        { role: "assistant", content: [{ type: "text", text: "11 unique cases cited." }, { type: "tool-call", toolCallId: "c3", toolName: "sheets_update_values", input: {} }, { type: "tool-call", toolCallId: "c4", toolName: "sheets_get_values", input: {} }] },
        { role: "tool", content: [
          { type: "tool-result", toolCallId: "c3", output: { type: "json", value: { updated_range: "FACTS!B13" } } },
          // The sheets tools answer JSON text.
          { type: "tool-result", toolCallId: "c4", output: { type: "text", value: JSON.stringify({ range: "FACTS!A1:B20", values: [...Array.from({ length: 12 }, () => ["x", "1"]), ["authorities_cited", "11"]] }) } },
        ] },
        { role: "assistant", content: [{ type: "text", text: "Recording the salary sum." }, { type: "tool-call", toolCallId: "c5", toolName: "graph_create_node", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c5", output: { type: "json", value: { ref_id: "n-1" } } }] },
      ],
    }),
    ev("step.start", dr, { stepType: "agent", input: { prompt: "Draft the memo." } }),
    ...call(dr, 1, "sheets_update_values", "d1", { spreadsheet_id: SHEET, range: "FACTS!A91", values: [["DRAFTER BLOCK", "value"], ["implied", "=329.47*365"], ["actual_avg_salary", "=B79/247"]] }),
    ...call(dr, 2, "sheets_get_values", "d2", { spreadsheet_id: SHEET, range: "FACTS!B93" }),
    ...call(dr, 3, "str_replace_based_edit_tool", "d3", { command: "create", path: "/tmp/w/make_memo_data.py", file_text: MEMO }),
    ev("step.end", dr, {
      stepType: "agent",
      output: { result: "memo written" },
      messages: [
        { role: "system", content: "You are the drafter." },
        { role: "assistant", content: [{ type: "text", text: "All arithmetic as live formulas." }, { type: "tool-call", toolCallId: "d1", toolName: "sheets_update_values", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "d1", output: { type: "json", value: { updated_range: "FACTS!A91:B93" } } }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "d2", toolName: "sheets_get_values", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "d2", output: { type: "json", value: { range: "FACTS!B93", values: [[54853.44129554656]] } } }] },
        { role: "assistant", content: [{ type: "text", text: "Writing the memo data." }, { type: "tool-call", toolCallId: "d3", toolName: "str_replace_based_edit_tool", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "d3", output: { type: "text", value: "File created" } }] },
      ],
    }),
    ev("run.end", "wf", { output: {} }),
  ];
}

describe("provenance — addresses and needles", () => {
  it("reads sheet ranges: quoted tabs, a cell, an anchor, a column, a tab alone", () => {
    assert.deepEqual(parseRange("FACTS!B13"), { tab: "FACTS", c1: 2, r1: 13, c2: 2, r2: 13 });
    assert.deepEqual(parseRange("'SOURCE: a.xlsx — Detail'!K2:K248"), { tab: "SOURCE: a.xlsx — Detail", c1: 11, r1: 2, c2: 11, r2: 248 });
    assert.deepEqual(parseRange("'It''s'!A1"), { tab: "It's", c1: 1, r1: 1, c2: 1, r2: 1 });
    assert.deepEqual(parseRange("B:B"), { tab: null, c1: 2, r1: 1, c2: 2, r2: Infinity });
    assert.deepEqual(parseRange("FACTS"), { tab: "FACTS", c1: 1, r1: 1, c2: Infinity, r2: Infinity });
    assert.equal(parseRange("FACTS!nope"), null);
  });

  it("reads a formula's cells (unqualified ones on the cell's tab) and the numbers typed into it", () => {
    assert.deepEqual(formulaParts("=B79/247", "FACTS"), { refs: ["FACTS!B79"], literals: ["247"] });
    assert.deepEqual(formulaParts("=SUM('SOURCE: a.xlsx — Detail'!K2:K248)", "FACTS"), { refs: ["'SOURCE: a.xlsx — Detail'!K2:K248"], literals: [] });
    assert.deepEqual(formulaParts("=329.47*60*247", "FACTS"), { refs: [], literals: ["329.47", "60", "247"] });
    assert.deepEqual(formulaParts('=IF($B$2>0,"B9",B3)', null), { refs: ["B2", "B3"], literals: ["0"] });
    assert.deepEqual(formulaParts("=B5", "My Tab"), { refs: ["'My Tab'!B5"], literals: [] });
  });

  it("finds only tab-qualified cells in prose, and the figures a passage states", () => {
    assert.deepEqual(citedCells("an average of $54,853.44 (FACTS!B93), see B12 and 'SOURCE: x'!K2"), ["FACTS!B93", "'SOURCE: x'!K2"]);
    assert.deepEqual(figuresIn("The actual average of the 247 salaries is $54,853.44 — 2.19 times, 3 sites, FACTS!B93."), ["247", "$54,853.44", "2.19"]);
  });

  it("searches a number in any spelling, a short value not at all", () => {
    // As the search reads a haystack: normalized.
    const hits = (value: string, text: string) => !!needleOf(value)?.test(normalizeText(text));
    assert.equal(needleOf("11"), null, "too short to tell from noise");
    assert.equal(needleOf("3"), null);
    assert.equal(needleOf("TRUE"), null);
    assert.ok(hits("$54,853", "average 54853.44129554656"));
    assert.ok(hits("54853.4413", "is $54,853.44 (FACTS!B93)"));
    assert.ok(!hits("54853", "154853"), "not inside a longer number");
    assert.ok(!hits("54,853", "54,853,000"));
    assert.ok(hits("329.47", "rate of $329.47 per day"));
    assert.ok(!hits("329.47", "rate of 329.03"), "below 1,000 the decimals count");
    assert.equal(needleOf("0.33"), null, "two significant digits");
    assert.ok(hits("0.335", "a ratio of 0.3351"));
    assert.ok(!hits("0.335", "10.335"));
    assert.ok(hits("“Celotex Corp. v. Catrett”", 'cites "Celotex Corp. v. Catrett" first'), "quotes in any spelling");
    assert.ok(hits("its “Verification” row", 'ISSUES = ["its \\u201cVerification\\u201d row verifies nothing"]'), "escapes in source an agent wrote");
    assert.ok(hits("34.46%", "exceeds the line items by 34.46% (Issue 11)"));
    assert.ok(hits("34.46%", '{"values":[[0.34459876]]}'), "a percentage held as its ratio");
    assert.ok(!hits("34.46%", "0.3412"));
    assert.ok(hits("0.0712", "a rate of 0.07125"), "leading zeros are not significant");
    assert.ok(!hits("0.0712", "0.0799"));
    const long = "The actual average of the 247 salaries in the same exhibit is $54,853.44, which the Motion never mentions anywhere in its brief";
    assert.ok(hits(long, 'ISSUES = ["The actual average of the 247 salaries in the same " "exhibit …'), "a long passage by a window of it");
  });
});

describe("provenance — a run's log", () => {
  it("a cell: every write and read of it, the agent's words, and the calls before the write", () => {
    const p = buildProvenance(log(), { cell: "FACTS!B13", value: "11" });
    assert.deepEqual(p.moments.map((m) => [m.kind, m.exact, m.tool, m.where, m.value ?? null]), [
      ["wrote", true, "sheets_update_values", "FACTS!B13", "NOT FOUND — 11 named cases"],
      ["wrote", true, "sheets_update_values", "FACTS!B13", "11"],
      ["read", true, "sheets_get_values", "FACTS!B13", "11"],
    ]);
    const last = p.moments[1]!;
    assert.equal(last.agent, "wf/cross_check");
    assert.equal(last.why, "11 unique cases cited.");
    assert.deepEqual(last.before!.map((b) => b.tool), ["sheets_update_values", "bash"]);
    assert.match(last.before![1]!.output!, /Celotex/, "the grep's whole result, from the transcript");
    assert.equal(p.moments[0]!.why, "Seeding the counts.");
    assert.match(p.note!, /too short/);
  });

  it("calls made together share the words before the first", () => {
    const p = buildProvenance(log(), { cell: "FACTS!B13" });
    assert.equal(p.moments[2]!.kind, "read");
    assert.equal(p.moments[2]!.why, undefined, "a read carries no why");
    const reads = buildProvenance(log(), { value: "authorities_cited" }).moments;
    assert.equal(reads[0]!.where, "FACTS!A13", "a value found in a sheet read names its cell");
  });

  it("a formula cell written by a block anchored at one cell: its refs and literals, then where its value went", () => {
    const p = buildProvenance(log(), { cell: "FACTS!B93", value: "54853.4413" });
    assert.equal(p.formula, "=B79/247");
    assert.deepEqual([p.refs, p.literals], [["FACTS!B79"], ["247"]]);
    assert.deepEqual(p.moments.map((m) => [m.kind, m.exact, m.where]), [
      ["wrote", true, "FACTS!B93"],
      ["read", true, "FACTS!B93"],
      ["wrote", false, "make_memo_data.py"],
    ]);
    assert.equal(p.moments[0]!.why, "All arithmetic as live formulas.");
    assert.deepEqual(p.moments[2]!.cites, ["FACTS!B93"], "the memo cites the cell beside the number");
    assert.equal(p.moments[2]!.file, "/tmp/w/make_memo_data.py");
  });

  it("a passage: found in the file that wrote it, with the cells it cites and the figures it states", () => {
    const p = buildProvenance(log(), { value: "The actual average of the 247 salaries in the same exhibit is $54,853.44 (FACTS!B93)", file: "memo.html" });
    assert.deepEqual(p.moments.map((m) => [m.kind, m.agent, m.where]), [["wrote", "wf/drafter", "make_memo_data.py"]]);
    assert.equal(p.moments[0]!.why, "Writing the memo data.");
    assert.deepEqual(p.refs, ["FACTS!B93"]);
    assert.deepEqual(p.figures, ["247", "$54,853.44"]);
  });

  it("a node: the call that wrote it, by address", () => {
    const p = buildProvenance(log(), { node: "n-1", value: "sum_salaries" });
    assert.deepEqual(p.moments.map((m) => [m.kind, m.exact, m.where, m.node?.node_type]), [["wrote", true, "sum_salaries", "ComputedFigure"]]);
    assert.equal(p.moments[0]!.why, "Recording the salary sum.");
  });

  it("a source range: the workflow step that imported it; a command that holds a value is a use, not a write", () => {
    const p = buildProvenance(log(), { cell: "'SOURCE: a.xlsx — Detail'!K2:K3" });
    assert.deepEqual(p.moments.map((m) => [m.kind, m.exact, m.tool, m.agent ?? null]), [["wrote", true, "sheets/batch-update-values", null]]);
    assert.match(p.moments[0]!.snippet, /K2 = 94500; .*K3 = 68200/);
    const used = buildProvenance(log(), { value: "Celotex Corp. v. Catrett" }).moments;
    assert.deepEqual(used.map((m) => [m.kind, m.tool]), [["read", "bash"]]);
    const cmd = buildProvenance(log(), { value: "motion.txt | sort" }).moments;
    assert.deepEqual(cmd.map((m) => [m.kind, m.tool, m.why]), [["used", "bash", "Counting the cases the motion cites."]]);
  });

  it("the run's input, and nothing at all", () => {
    const p = buildProvenance(log(), { value: "employment-labor/identify-issues" });
    assert.deepEqual(p.moments.map((m) => [m.kind, m.where]), [["read", "the run's input"]]);
    const none = buildProvenance(log(), { value: "nowhere in this run" });
    assert.deepEqual(none.moments, []);
    assert.match(none.note!, /Nothing in this run's log/);
  });
});
