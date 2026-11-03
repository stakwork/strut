// strut/views' SpotCheck: its pure parts (the words a moment is drawn in,
// which moments it marks) and the gallery's answers through the fixture
// client — what the component reads from `run/provenance`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { SPOT_RUN_ID, SPOT_SUBJECTS, SPOT_WORKFLOW } from "./views/src/fixtures/provenance.js";
import { landmarks, markTerms, momentPhrase, sameCell, subjectKey, subjectLabel, whoOf, type Provenance, type ProvenanceMoment } from "./views/src/lib/provenance.js";

const m = (kind: ProvenanceMoment["kind"], extra: Partial<ProvenanceMoment> = {}): ProvenanceMoment => ({
  at: "2026-11-02T22:00:00.000Z", path: "wf/xc/001-tool", agent: "wf/xc", tool: "tool", kind, exact: false, where: "somewhere", snippet: "", ...extra,
});

describe("strut/views — SpotCheck", () => {
  it("names the subject: the cell and its value, the node, a passage, a file", () => {
    assert.equal(subjectLabel({ cell: "FACTS!B13", value: "11" }), "FACTS!B13 = 11");
    assert.equal(subjectLabel({ cell: "FACTS!B13" }), "FACTS!B13");
    assert.equal(subjectLabel({ node: "0b58aa64-beb8" }), "node 0b58aa64");
    assert.equal(subjectLabel({ node: "0b58aa64-beb8" }, "sum_salaries"), "sum_salaries");
    assert.equal(subjectLabel({ value: "  The actual\n average " }), "“The actual average”");
    assert.equal(subjectLabel({ file: "/tmp/w/facts.md" }), "facts.md");
    assert.notEqual(subjectKey({ value: "11" }), subjectKey({ cell: "11" }));
    assert.ok(sameCell("'FACTS'!$B$13", "FACTS!B13"));
    assert.ok(sameCell("'It''s'!A1", "It's!A1"));
    assert.ok(!sameCell("FACTS!B13", "FACTS!B14"));
    assert.ok(!sameCell(undefined, "FACTS!B13"));
  });

  it("says what each moment did, by who: an agent's call, a workflow step, the run's input", () => {
    assert.equal(momentPhrase(m("wrote", { where: "FACTS!B13" })), "wrote FACTS!B13");
    assert.equal(momentPhrase(m("used", { where: "$ grep 54,853 x.txt" })), "used it in $ grep 54,853 x.txt");
    assert.equal(momentPhrase(m("read", { where: "FACTS!B93" })), "read it in FACTS!B93");
    assert.equal(whoOf(m("read")), "xc");
    const step = { agent: undefined, path: "wf/sheet_fill", tool: "sheets/batch-update-values" };
    assert.equal(momentPhrase(m("wrote", { ...step, cell: "'SOURCE: a'!K2", where: "'SOURCE: a'!K2" })), "step sheet_fill wrote 'SOURCE: a'!K2");
    assert.equal(momentPhrase(m("read", step)), "step sheet_fill produced it");
    assert.equal(whoOf(m("read", step)), "sheet_fill");
    assert.equal(momentPhrase(m("read", { agent: undefined, path: "wf", tool: "run input" })), "had it in its input");
    assert.equal(whoOf(m("read", { agent: undefined, path: "wf", tool: "run input" })), "the run");
  });

  it("marks where it was first seen and its last exact write", () => {
    assert.deepEqual(landmarks([m("read"), m("used"), m("wrote", { exact: true }), m("wrote"), m("read")]), { firstSeen: 0, lastWrite: 2 });
    assert.deepEqual(landmarks([m("wrote"), m("read"), m("wrote")]), { firstSeen: -1, lastWrite: 2 }, "no exact write: the last write");
    assert.deepEqual(landmarks([m("read"), m("read")]), { firstSeen: 0, lastWrite: -1 });
    assert.deepEqual(markTerms("$54,853"), ["$54,853", "54853"]);
    assert.deepEqual(markTerms("11"), ["11"]);
    assert.deepEqual(markTerms("x"), []);
  });

  it("the gallery's answers: a count's three writes, a formula's cells followed to the import", async () => {
    const client = createFixtureClient({ latencyMs: 0 });
    const ask = (s: object) => client.run<Provenance>("run/provenance", { workflow: SPOT_WORKFLOW, runId: SPOT_RUN_ID, ...s });
    const count = await ask(SPOT_SUBJECTS[0]!.subject);
    assert.deepEqual(count.moments.filter((x) => x.kind === "wrote").map((x) => x.value), ["", "NOT FOUND — requires full memo drafting to enumerate; see the motion's case citations (Matsushita, Celotex, Anderson, Arnett, Biggins …)", "11"]);
    assert.equal(landmarks(count.moments).lastWrite, 2);
    const avg = await ask(SPOT_SUBJECTS[1]!.subject);
    assert.deepEqual([avg.formula, avg.refs, avg.literals], ["=B79/247", ["FACTS!B79"], ["247"]]);
    const sum = await ask({ cell: avg.refs[0] });
    const source = await ask({ cell: sum.refs[0] });
    assert.equal(momentPhrase(source.moments[0]!), "step sheet_fill wrote 'SOURCE: headcount-data.xlsx — Termination Detail'!K2 and 246 more");
    const nothing = await ask({ value: "247" });
    assert.match(nothing.note!, /Nothing in this run's log/);
  });
});
