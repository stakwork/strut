import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldWorkProducts, isGoogleSheet, parseTimeline, productKind, productView, sourcesOf, type WorkProduct, type WorkProductEvent } from "./work-products.js";

const WF = "acme/matter";
const ts = (s: number) => new Date(Date.UTC(2026, 10, 2, 9, 0, s)).toISOString();

describe("foldWorkProducts", () => {
  const events: WorkProductEvent[] = [
    { type: "run.start", path: WF, ts: ts(0) },
    // A workflow step's output.
    { type: "step.end", path: `${WF}/memo`, stepType: "llm", ts: ts(5), output: { artifacts: [{ id: "memo", title: "Memo", path: "memo.md", from: ["c-1", "c-1", " c-2 "] }] } },
    // An agent's tool call: its result lifted onto the event, the output a preview.
    { type: "step.end", path: `${WF}/work/003-sheets_fill`, stepType: "tool:sheets/fill", ts: ts(9), output: "{\"rows\":…", artifacts: [{ id: "matrix", kind: "sheet", title: "Deviation matrix", url: "https://docs.google.com/spreadsheets/d/x", render: "matrix.csv" }] },
    // Not an entry, and one with no title: skipped.
    { type: "step.end", path: `${WF}/noise`, stepType: "exec", ts: ts(10), output: { artifacts: ["x", { id: "nameless" }] } },
    // The same sheet, filled further: a newer version, made by the same step.
    { type: "step.end", path: `${WF}/work/004-sheets_fill`, stepType: "tool:sheets/fill", ts: ts(12), artifacts: [{ id: "matrix", kind: "sheet", title: "Deviation matrix", summary: "12 of 14 clauses", url: "https://docs.google.com/spreadsheets/d/x", render: "matrix.csv" }] },
    // An agent's structured reply.
    { type: "step.end", path: `${WF}/work`, stepType: "agent", ts: ts(20), output: { result: "", object: { text: "done", artifacts: [{ id: "redline", kind: "redline", title: "NDA redline", path: "nda.docx", render: "nda.html" }, { id: "matrix", kind: "sheet", title: "Deviation matrix", url: "https://docs.google.com/spreadsheets/d/x", render: "matrix.csv" }] } } },
    // pack hands the reply on: it made nothing, but its first declaration is the run's.
    { type: "step.end", path: `${WF}/result`, stepType: "pack", ts: ts(21), output: { artifacts: [{ id: "timeline", title: "Timeline", path: "timeline.json", kind: "timeline" }] } },
    // The run's own output: wins, and a later step changes nothing.
    { type: "run.end", path: WF, ts: ts(22), output: { artifacts: [{ id: "memo", title: "Final memo", path: "memo.md", from: ["c-3"] }, { id: "redline", kind: "redline", title: "NDA redline", path: "nda.docx", render: "nda.html" }] } },
    { type: "step.end", path: `${WF}/late`, stepType: "exec", ts: ts(23), output: { artifacts: [{ id: "memo", title: "Late", path: "late.md" }] } },
  ];

  it("one product per id in the order they first appeared, the newest declaration's fields, the run's output winning; a repeat as it was is no new version", () => {
    const ps = foldWorkProducts(events);
    assert.deepEqual(ps.map((p) => [p.id, p.title, p.versions, p.final]), [
      ["memo", "Final memo", 2, true],
      ["matrix", "Deviation matrix", 3, false],
      ["redline", "NDA redline", 1, true],
      ["timeline", "Timeline", 1, false],
    ]);
    const [memo, matrix, redline, timeline] = ps as [WorkProduct, WorkProduct, WorkProduct, WorkProduct];
    assert.deepEqual([memo.kind, memo.path, memo.from, memo.step, memo.stepType, memo.at, memo.updatedAt], ["markdown", "memo.md", ["c-3"], `${WF}/memo`, "llm", ts(5), ts(22)]);
    assert.deepEqual([matrix.kind, matrix.summary, matrix.render, matrix.step, matrix.stepType], ["sheet", undefined, "matrix.csv", `${WF}/work/003-sheets_fill`, "tool:sheets/fill"]);
    assert.deepEqual([redline.step, redline.stepType], [`${WF}/work`, "agent"]);
    assert.deepEqual([timeline.step, timeline.stepType], [WF, undefined], "pack made nothing: the run did");
  });

  it("mid-run: what the steps declared so far", () => {
    const ps = foldWorkProducts(events.slice(0, 5));
    assert.deepEqual(ps.map((p) => [p.id, p.versions, p.summary]), [["memo", 1, undefined], ["matrix", 2, "12 of 14 clauses"]]);
    assert.deepEqual(ps[0]!.from, ["c-1", "c-2"]);
  });
});

describe("what a product carries", () => {
  it("productKind: as given, an app by name, else by the file's name", () => {
    assert.equal(productKind({ kind: "redline", path: "a.docx" }), "redline");
    assert.equal(productKind({ app: "visits" }), "app");
    assert.equal(productKind({ path: "nda.docx" }), "docx");
    assert.equal(productKind({ path: "m.CSV" }), "table");
    assert.equal(productKind({ path: "walkthroughs/1/walkthrough.json" }), "walkthrough");
    assert.equal(productKind({ url: "https://x/y" }), "url");
  });

  it("parseTimeline: entries or the bare array, as content or JSON text; sorted when every date is ISO; sources from the entry and the list", () => {
    const t = parseTimeline({
      entries: [
        { date: "2026-03-04", title: "Signed", sources: ["e-2"] },
        { date: "2025-11", title: "Term sheet", detail: "LOI" },
        { title: "no date" },
      ],
      sources: { "1": ["e-1"] },
    })!;
    assert.deepEqual(t.map((e) => [e.date, e.title, e.sources, e.index]), [["2025-11", "Term sheet", ["e-1"], 1], ["2026-03-04", "Signed", ["e-2"], 0]]);
    assert.deepEqual(parseTimeline(JSON.stringify([{ date: "Q3", title: "B" }, { date: "Q1", title: "A" }]))!.map((e) => e.title), ["B", "A"], "not ISO: as given");
    assert.equal(parseTimeline("not json"), null);
    assert.equal(parseTimeline({ rows: [] }), null);
  });

  it("sourcesOf: an item's refs, deduped, empty lists and non-lists dropped", () => {
    assert.deepEqual(sourcesOf({ sources: { "Non-solicit": ["x", "x"], C4: ["y"], "3": [], bad: "z" } }), { "Non-solicit": ["x"], C4: ["y"] });
    assert.deepEqual(sourcesOf("no"), {});
  });

  it("productView: a docx or redline reads as its render, a sheet or table through SheetView, a timeline its own list, media its file, the rest a link", () => {
    const p = (o: Partial<WorkProduct>): WorkProduct => ({ id: "x", kind: "url", title: "X", from: [], step: "wf", versions: 1, final: false, ...o });
    assert.deepEqual(productView(p({ kind: "redline", path: "nda.docx", render: "nda.html" })), { view: "document", path: "nda.html", as: "html" });
    assert.deepEqual(productView(p({ kind: "docx", path: "memo.docx" })), { view: "file", path: "memo.docx" });
    // A sheet: the live Google sheet first, then its table file, then rows; a table: its file or rows.
    assert.deepEqual(productView(p({ kind: "sheet", url: "https://docs.google.com/spreadsheets/d/1abc/edit#gid=0", render: "m.csv" })), { view: "sheet", spreadsheet: "https://docs.google.com/spreadsheets/d/1abc/edit#gid=0" });
    assert.deepEqual(productView(p({ kind: "sheet", url: "https://example.com/m", render: "m.csv" })), { view: "sheet", path: "m.csv" });
    assert.deepEqual(productView(p({ kind: "sheet", url: "https://example.com/m" })), { view: "link", url: "https://example.com/m" });
    assert.deepEqual(productView(p({ kind: "table", path: "m.tsv" })), { view: "sheet", path: "m.tsv" });
    assert.deepEqual(productView(p({ kind: "table", path: "m.xlsx" })), { view: "file", path: "m.xlsx" });
    assert.deepEqual(productView(p({ kind: "table", content: { columns: ["a"], rows: [["1"]] } })), { view: "sheet", rows: { columns: ["a"], rows: [["1"]] } });
    assert.deepEqual(productView(p({ kind: "table", content: { sources: {} } })), { view: "none" }, "sources alone are no table");
    assert.equal(isGoogleSheet("https://docs.google.com/spreadsheets/d/1abc/edit#gid=0"), true);
    assert.equal(isGoogleSheet("https://docs.google.com/document/d/1"), false);
    assert.deepEqual(productView(p({ kind: "timeline", path: "t.json" })), { view: "timeline" });
    assert.deepEqual(productView(p({ kind: "markdown", path: "memo.md" })), { view: "document", path: "memo.md", as: "markdown" });
    assert.deepEqual(productView(p({ kind: "markdown", content: "# Hi" })), { view: "inline", text: "# Hi", as: "markdown" });
    assert.deepEqual(productView(p({ kind: "image", path: "shot.png" })), { view: "file", path: "shot.png" });
    assert.deepEqual(productView(p({ kind: "pull_request", url: "https://github.com/a/b/pull/1" })), { view: "link", url: "https://github.com/a/b/pull/1" });
    assert.deepEqual(productView(p({ kind: "url" })), { view: "none" });
  });
});
