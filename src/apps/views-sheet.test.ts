// strut/views' SheetView: its pure parts (A1, the sources folded to one
// table, what changed between reads, the cells `sources` marks) and the
// gallery's sheets as the fixture client serves them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cellA1, columnIndex, columnLetters, diffTables, fromFile, fromGetValues, fromRows, hasFormulas, looksNumeric, parseCell, parseCsv,
  quoteTab, rangeForTab, rangeStart, resolveSources, splitRange, spreadsheetRef, toCell, type SheetTable,
} from "./views/src/lib/sheet.js";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { COVENANT_RANGE, COVENANT_SHEET, NDA_FRAMES, NDA_RANGE, NDA_SHEET, NDA_WORKFLOW } from "./views/src/fixtures/sheets.js";

const texts = (t: SheetTable) => t.rows.map((r) => r.map((c) => c.text));

describe("strut/views — SheetView: A1", () => {
  it("columns both ways, past Z and ZZ", () => {
    for (const [col, letters] of [[0, "A"], [25, "Z"], [26, "AA"], [51, "AZ"], [701, "ZZ"], [702, "AAA"]] as const) {
      assert.equal(columnLetters(col), letters);
      assert.equal(columnIndex(letters), col);
    }
    assert.equal(cellA1({ row: 9, col: 27 }), "AB10");
  });

  it("a cell, absolute or not; anything else is null", () => {
    assert.deepEqual(parseCell("B3"), { row: 2, col: 1 });
    assert.deepEqual(parseCell("$aa$10"), { row: 9, col: 26 });
    for (const bad of ["B", "3", "A0", "B2:C3", "Non-solicit", "ABCD1"]) assert.equal(parseCell(bad), null, bad);
  });

  it("a range's tab and cells: quoted names, a doubled quote, cells alone, a bare word is a tab", () => {
    assert.deepEqual(splitRange("'Deal Terms'!B2:F9"), { tab: "Deal Terms", cells: "B2:F9" });
    assert.deepEqual(splitRange("'Q''s'!A1"), { tab: "Q's", cells: "A1" });
    assert.deepEqual(splitRange("Matrix!A:H"), { tab: "Matrix", cells: "A:H" });
    assert.deepEqual(splitRange("A1:H20"), { cells: "A1:H20" });
    assert.deepEqual(splitRange("C:F"), { cells: "C:F" });
    assert.deepEqual(splitRange("Inputs"), { tab: "Inputs", cells: "" });
    assert.deepEqual(splitRange("Tab"), { tab: "Tab", cells: "" });
    assert.equal(quoteTab("Q's"), "'Q''s'");
  });

  it("the same cells on another tab; where a range starts", () => {
    assert.equal(rangeForTab("Matrix!A1:H20", "Play book"), "'Play book'!A1:H20");
    assert.equal(rangeForTab("A1:H20", "Inputs"), "'Inputs'!A1:H20");
    assert.equal(rangeForTab(undefined, "Inputs"), "'Inputs'");
    assert.equal(rangeForTab("Matrix", "Inputs"), "'Inputs'");
    assert.deepEqual(rangeStart("'Deal Terms'!B2:F9"), { row: 1, col: 1 });
    assert.deepEqual(rangeStart("Sheet1!C:F"), { row: 0, col: 2 });
    assert.deepEqual(rangeStart("3:9"), { row: 2, col: 0 });
    assert.deepEqual(rangeStart("Inputs"), { row: 0, col: 0 });
  });

  it("a spreadsheet's id from its id or a URL, with the URL's tab", () => {
    assert.deepEqual(spreadsheetRef("1AbC-d_9"), { id: "1AbC-d_9" });
    assert.deepEqual(spreadsheetRef("https://docs.google.com/spreadsheets/d/1AbC-d_9/edit?usp=sharing#gid=1182"), { id: "1AbC-d_9", gid: 1182 });
    assert.deepEqual(spreadsheetRef("https://docs.google.com/spreadsheets/d/1AbC-d_9/edit"), { id: "1AbC-d_9" });
  });
});

describe("strut/views — SheetView: every source to one table", () => {
  it("CSV: quoted fields, doubled quotes, a newline inside quotes, CRLF, a BOM, the last newline", () => {
    assert.deepEqual(parseCsv('﻿a,"b, c",d\r\n"say ""hi""","two\nlines",\n'), [["a", "b, c", "d"], ['say "hi"', "two\nlines", ""]]);
    assert.deepEqual(parseCsv("x\ty\n1\t2", "\t"), [["x", "y"], ["1", "2"]]);
    assert.deepEqual(parseCsv(""), []);
  });

  it("numbers as a sheet shows them read as numbers; words with digits do not", () => {
    for (const n of ["1200", "$1,200.50", "-$3", "25%", "2.50x", "(0.06x)", "1.2E+05", ".5", "−4"]) assert.equal(looksNumeric(n), true, n);
    for (const t of ["Q3 2026", "12 months", "§7.11(a)", "", "1,20", "x2"]) assert.equal(looksNumeric(t), false, t);
  });

  it("cells: a number stays one, booleans as a sheet writes them, a cell object with its formula", () => {
    assert.deepEqual(toCell(0.1 + 0.2), { text: "0.3", value: 0.30000000000000004, numeric: true });
    assert.deepEqual(toCell(true), { text: "TRUE", value: true, numeric: false });
    assert.deepEqual(toCell(null), { text: "", value: null, numeric: false });
    assert.deepEqual(toCell({ value: 3.56, text: "3.56x", formula: "=C2/C3" }), { text: "3.56x", value: 3.56, formula: "=C2/C3", numeric: true });
  });

  it("records get a header of their keys in first-seen order; rows are padded and trailing empties dropped", () => {
    const b = fromRows([{ clause: "Term", risk: "High" }, { clause: "Standstill", days: 30 }]);
    assert.deepEqual(texts(b.table), [["clause", "risk", "days"], ["Term", "High", ""], ["Standstill", "", "30"]]);
    assert.deepEqual([b.tabs, b.tab, b.table.width], [[""], "", 3]);
    assert.equal(b.table.rows[2]![2]!.numeric, true);
    assert.deepEqual(texts(fromRows([["a", "b", ""], ["c"], [], [null]]).table), [["a", "b"], ["c", ""]]);
  });

  it("{ columns, rows }, { tabs: [{ name, rows }] }, CSV text and a get-values answer", () => {
    assert.deepEqual(texts(fromRows({ columns: ["k", "v"], rows: [["a", 1]] }).table), [["k", "v"], ["a", "1"]]);
    const tabs = fromRows({ title: "Book", tabs: [{ name: "One", rows: [["x"]] }, { name: "Two", values: [["y"], ["z"]] }] });
    assert.deepEqual([tabs.title, tabs.tabs, tabs.tab, texts(tabs.tables!["Two"]!)], ["Book", ["One", "Two"], "One", [["y"], ["z"]]]);
    assert.deepEqual(texts(fromRows("a,b\n1,2\n").table), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(fromRows({ range: "Sheet1!B2:C3", values: [["h"]] }).table.origin, { row: 1, col: 1 });
  });

  it("a file: JSON parsed, TSV split on tabs, anything else read as CSV", () => {
    assert.deepEqual(texts(fromFile("out/table.json", '[["a",1]]').table), [["a", "1"]]);
    assert.deepEqual(texts(fromFile("t.tsv", "a\tb").table), [["a", "b"]]);
    assert.deepEqual(texts(fromFile("deviations.csv", "a,b").table), [["a", "b"]]);
  });

  it("a grid read (`sheets/get-values { grid: true }`): display text drawn, values and formulas kept, the tabs and their ids", () => {
    const b = fromGetValues({
      title: "Covenants",
      url: "https://docs.google.com/spreadsheets/d/S/edit#gid=7",
      sheet: "Compliance",
      tabs: [{ id: 7, title: "Compliance" }, { id: 9, title: "Inputs" }],
      range: "'Compliance'!B2:C3",
      values: [["Covenant", "Q3"], ["Leverage", 3.559]],
      display: [["Covenant", "Q3"], ["Leverage", "3.56x"]],
      formulas: [[null, null], [null, "=(Inputs!E3-Inputs!E6)/Inputs!E2"]],
    }, "S");
    assert.deepEqual([b.title, b.tab, b.tabs, b.tabIds, b.url], ["Covenants", "Compliance", ["Compliance", "Inputs"], { Compliance: 7, Inputs: 9 }, "https://docs.google.com/spreadsheets/d/S/edit#gid=7"]);
    assert.deepEqual(b.table.origin, { row: 1, col: 1 });
    assert.deepEqual(b.table.rows[1]![1], { text: "3.56x", value: 3.559, formula: "=(Inputs!E3-Inputs!E6)/Inputs!E2", numeric: true });
    assert.equal(b.table.rows[0]![1]!.numeric, false, "a header Q3 is text");
    assert.equal(hasFormulas(b.table), true);
    assert.equal(fromGetValues({ range: "A1", values: [] }, "S").url, "https://docs.google.com/spreadsheets/d/S/edit");
  });
});

describe("strut/views — SheetView: what a read changed", () => {
  const t = (rows: unknown[][], origin = "A1") => fromRows({ range: origin, values: rows }).table;
  const head = ["Provision", "Apex", "Risk"];

  it("a first read lights nothing; a new row is a row, a changed cell a cell", () => {
    const a = t([head, ["Term", "3 years", ""]]);
    const b = t([head, ["Term", "3 years", "Medium"], ["Standstill", "None", ""]]);
    assert.deepEqual(diffTables(undefined, a), { cells: new Set(), rows: new Set() });
    assert.deepEqual(diffTables(a, b), { cells: new Set(["1:2"]), rows: new Set([2]) });
    assert.deepEqual(diffTables(b, b), { cells: new Set(), rows: new Set() });
  });

  it("rows are matched by their key, so a row written above the others is one new row", () => {
    const a = t([head, ["Term", "3 years", "Medium"], ["Remedies", "Bond", "Medium"]]);
    const b = t([head, ["Term", "3 years", "Medium"], ["Standstill", "None", "High"], ["Remedies", "Bond", "Low"]]);
    assert.deepEqual(diffTables(a, b), { cells: new Set(["3:2"]), rows: new Set([2]) });
  });

  it("without a key of its own on every row, by position; a header change is a cell; another origin changes nothing", () => {
    const a = t([head, ["", "x", ""], ["", "y", ""]]);
    const b = t([["Provision", "Apex Capital", "Risk"], ["", "x", ""], ["", "z", ""], ["", "w", ""]]);
    assert.deepEqual(diffTables(a, b), { cells: new Set(["0:1", "2:1"]), rows: new Set([3]) });
    assert.deepEqual(diffTables(a, t([head, ["", "q", ""]], "B2")), { cells: new Set(), rows: new Set() });
  });

  it("a formula that changed under the same text is a change", () => {
    const a = fromRows([["x"], [{ value: 2, formula: "=1+1" }]]).table;
    const b = fromRows([["x"], [{ value: 2, formula: "=4/2" }]]).table;
    assert.deepEqual([...diffTables(a, b).cells], ["1:0"]);
  });
});

describe("strut/views — SheetView: the cells `sources` marks", () => {
  // A range starting at B2: the sheet's own C4 is row 2, column 1 here.
  const table = fromRows({ range: "'Matrix'!B2:D5", values: [["Provision", "Apex", "Risk"], ["Term", "3y", "Low"], ["Non-solicit", "24m", "High"], ["Standstill", "None", "High"]] }).table;

  it("a cell by the sheet's own address, a row by its key (exact, else any case) on its first cell; refs merged and deduplicated", () => {
    const m = resolveSources(table, { C4: ["p7", "c1"], "non-solicit": ["c1", "c2"], Standstill: ["c3"], Z99: ["far"], Missing: ["x"], Term: [] }, "Matrix");
    assert.deepEqual(Object.fromEntries(m), { "2:1": ["p7", "c1"], "2:0": ["c1", "c2"], "3:0": ["c3"] });
  });

  it("a key naming a tab is that tab's; one naming none is the tab the view opened on", () => {
    const sources = { "'Matrix'!C4": ["a"], "Playbook!C4": ["b"], D5: ["c"], Term: ["d"] };
    assert.deepEqual(Object.fromEntries(resolveSources(table, sources, "Matrix", "Matrix")), { "2:1": ["a"], "3:2": ["c"], "1:0": ["d"] });
    assert.deepEqual(Object.fromEntries(resolveSources(table, sources, "Playbook", "Matrix")), { "2:1": ["b"] });
    assert.deepEqual(resolveSources(table, undefined).size, 0);
  });
});

describe("strut/views — SheetView: the gallery's sheets", () => {
  it("the NDA matrix fills a provision a read, the last one's risks a read later, until its run ends", async () => {
    const client = createFixtureClient();
    const { runId } = await client.run<{ runId: string }>("run/launch", { workflow: NDA_WORKFLOW });
    let prev: SheetTable | undefined;
    let lit = 0;
    for (let i = 0; i < NDA_FRAMES; i++) {
      assert.equal((await client.run<{ status: string }>("run/get", { workflow: NDA_WORKFLOW, runId })).status, "running");
      const book = fromGetValues(await client.run("sheets/get-values", { spreadsheet_id: NDA_SHEET, range: NDA_RANGE, grid: true }), NDA_SHEET);
      assert.deepEqual([book.tabs, book.tab], [["Matrix", "Playbook"], "Matrix"]);
      const d = diffTables(prev, book.table);
      if (i > 1) assert.equal(d.rows.size, 1, `read ${i}: one new row`);
      if (i > 1) assert.ok(d.cells.size >= 3, `read ${i}: the row before it got its risks`);
      lit += d.cells.size;
      prev = book.table;
    }
    assert.ok(lit > 0);
    assert.equal((await client.run<{ status: string }>("run/get", { workflow: NDA_WORKFLOW, runId })).status, "success");
    assert.deepEqual(prev!.rows.at(-1)!.map((c) => c.formula ?? c.text), ["High-risk deviations", "", '=COUNTIF(D2:D9,"High")', "", '=COUNTIF(F2:F9,"High")', "", '=COUNTIF(H2:H9,"High")', ""]);
    assert.deepEqual(prev!.rows.at(-1)!.filter((c) => c.numeric).map((c) => c.value), [2, 0, 2]);
  });

  it("the covenant book: ratios are formulas over Inputs, Q3 leverage in breach; its Inputs tab reads by name", async () => {
    const client = createFixtureClient();
    const book = fromGetValues(await client.run("sheets/get-values", { spreadsheet_id: COVENANT_SHEET, range: COVENANT_RANGE, grid: true }), COVENANT_SHEET);
    const lev = book.table.rows[1]!;
    assert.deepEqual([lev[0]!.text, lev[6]!.text, lev[6]!.formula, lev[7]!.text, lev[8]!.text], ["Max total net leverage", "3.56x", "=(Inputs!E3-Inputs!E6)/Inputs!E2", "(0.06x)", "Breach"]);
    assert.equal(lev[8]!.formula, '=IF(G2<=C2,"Compliant","Breach")');
    assert.deepEqual(book.tabIds, { Compliance: 0, Inputs: 1182 });
    const inputs = fromGetValues(await client.run("sheets/get-values", { spreadsheet_id: COVENANT_SHEET, range: rangeForTab(COVENANT_RANGE, "Inputs"), grid: true }), COVENANT_SHEET);
    assert.deepEqual([inputs.tab, texts(inputs.table)[1]], ["Inputs", ["EBITDA (LTM, $m)", "48.2", "51.0", "46.7", "44.9"]]);
    assert.equal(hasFormulas(inputs.table), false);
  });

  it("the run's CSV, through run/files", async () => {
    const client = createFixtureClient();
    const f = await client.run<{ text: string }>("run/files", { workflow: "research", runId: "1790000000100", path: "deviations.csv" });
    const t = fromFile("deviations.csv", f.text).table;
    assert.deepEqual(texts(t)[3], ["Residuals", "Cedar Group", 'Permitted, "unaided memory"', "High", "5"]);
    assert.equal(t.rows[1]![4]!.numeric, true);
  });
});
