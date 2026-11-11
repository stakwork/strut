import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { kitForTests } from "../test-util/app-kit.js";
import { treeHash } from "../version.js";
import type { KitLocation } from "./kit.js";
import { DREAM_APP, DREAM_DIR } from "./dream-seed.js";
import { VIEWS_APP } from "./views-seed.js";
import { buildModel, conceptOf, headline, inMemory, inlineDiff, runSummary, stagesOf, type Run } from "./dream/src/lib/model.js";
import { agoText, changesOf, costText, foundBy, nest, conceptChanges, sectionsOf, standingOf, summaryOf, type Claim, type SaidRow, type TreeConcept } from "./dream/src/lib/report.js";

/**
 * `strut/dream` (plans/dream.md): what the dream did, as a first-party app
 * strut ships — how the app reads a run's report, and its seed beside
 * strut/views.
 */

describe("strut/dream: the report", () => {
  it("splits the report into its sections, an item a line; `none` and blank lines are no item", () => {
    const text = "CLAIMS: Keep summaries to three lines — session c-1 turn 1, new\n- No greeting in emails to Sam — turn 4\nFACTS: none\nPAGES:\n- Writing: added \"three lines\"\n\n**LEFT ALONE:** (none)";
    assert.deepEqual(sectionsOf(text), [
      { title: "Claims", lines: ["Keep summaries to three lines — session c-1 turn 1, new", "No greeting in emails to Sam — turn 4"] },
      { title: "Facts changed", lines: [] },
      { title: "Memory changed", lines: ['Writing: added "three lines"'] },
      { title: "Left alone", lines: [] },
    ]);
  });

  it("a report not shaped that way is not split: the app draws it as written", () => {
    assert.equal(sectionsOf("No new turns since the last dream."), null);
    assert.equal(sectionsOf(""), null);
  });

  it("lists each group with its claims under it, then the claims in no group; a claim whose group is not listed stands alone", () => {
    const c = (id: string, extra: Partial<Claim> = {}): Claim => ({ id, title: id, text: id, about: "p", concept: "Writing", corrected: 0, kept: 0, evidence: [], ...extra });
    const listed = nest([c("group", { children: ["a", "b"] }), c("a", { parent: "group" }), c("solo"), c("b", { parent: "group" }), c("orphan", { parent: "gone" })]);
    assert.deepEqual(listed.map((x) => [x.claim.id, x.children.map((k) => k.id)]), [["group", ["a", "b"]], ["solo", []], ["orphan", []]]);
  });

  const concept = (ref_id: string, name: string, extra: Partial<TreeConcept> = {}): TreeConcept => ({ ref_id, name, depth: 1, parent: "root", ...extra });
  const said = (extra: Partial<SaidRow> = {}): SaidRow => ({ source: "conversation", session: "s", turn: 1, excerpt: "too long", denies: false, outcome: "missing", at: "2026-11-10T10:00:00.000Z", ...extra });
  const claim = (id: string, extra: Partial<Claim> = {}): Claim => ({ id, title: id, text: id, about: "w", concept: "Writing", corrected: 0, kept: 0, evidence: [], ...extra });

  it("reads what a dream changed off the tree before and after: lines lost and gained, a Concept added, moved or removed; an untouched Concept is not listed", () => {
    const root = { ref_id: "root", name: "Personal", depth: 0 };
    const before = [root, concept("w", "Writing", { docs: "Be brief.\nNo emoji." }), concept("m", "Meetings", { docs: "Mornings." }), concept("old", "Old"), concept("same", "Same", { docs: "x" })];
    const after = [root, concept("w", "Writing", { docs: "Summaries are three lines or fewer.\nNo emoji." }), concept("m", "Meetings", { docs: "Mornings.", parent: "w" }), concept("same", "Same", { docs: "x" }), concept("new", "Email", { docs: "No greeting.", parent: "w" })];
    assert.deepEqual(conceptChanges(before, after), [
      { ref_id: "w", name: "Writing", kind: "changed", removed: ["Be brief."], added: ["Summaries are three lines or fewer."] },
      { ref_id: "m", name: "Meetings", kind: "moved", removed: [], added: [], from: "Personal", to: "Writing" },
      { ref_id: "new", name: "Email", kind: "added", removed: [], added: ["No greeting."], to: "Writing" },
      { ref_id: "old", name: "Old", kind: "removed", removed: [], added: [], from: "Personal" },
    ]);
    assert.deepEqual(conceptChanges(undefined, after), [], "a dream that read nothing kept no snapshot before");
    assert.deepEqual(conceptChanges([root, concept("w", "Writing", { description: "How to write", docs: "x" })], [root, concept("w", "Writing", { description: "How to write to me", docs: "x" })]), [
      { ref_id: "w", name: "Writing", kind: "changed", removed: [], added: [], description: { was: "How to write", is: "How to write to me" } },
    ], "a description alone is a change");
  });

  it("says where a claim stands, and sums a run: what it found, the Concepts it changed, the claims that came back", () => {
    const now = Date.parse("2026-11-15T10:00:00.000Z");
    const fresh = claim("a", { corrected: 1, evidence: [said({ dream: "run-2" })] });
    const back = claim("b", { corrected: 2, evidence: [said({ dream: "run-2", outcome: "not_followed", at: "2026-11-14T10:00:00.000Z" }), said({ dream: "run-1" })] });
    const kept = claim("c", { corrected: 1, kept: 1, evidence: [said({ dream: "run-2", outcome: "followed", at: "2026-11-14T10:00:00.000Z" }), said({ dream: "run-1" })] });
    const quiet = claim("d", { corrected: 1, evidence: [said({ dream: "run-1" })] });
    assert.deepEqual([fresh, back, kept, quiet].map((c) => standingOf(c, "run-2", now).label), ["New", "Came back", "Kept", "Quiet 5 days"]);
    assert.deepEqual(foundBy([fresh, back, kept, quiet], "run-2").map((f) => f.claim.id), ["b", "c", "a"], "newest first, this run's alone");
    const root = { ref_id: "root", name: "Personal", depth: 0 };
    const out = { turns: 12, claims: [fresh, back, kept, quiet], before: [root, concept("w", "Writing")], tree: [root, concept("w", "Writing", { docs: "Be brief." })] };
    assert.deepEqual(summaryOf(out, "run-2"), { turns: 12, found: 2, concepts: 1, back: 1 }, "a confirmation is not a correction");
  });

  it("a staged dream lists its own Concept edits, and a claim with its fixes on it says where it stands exactly", () => {
    const now = Date.parse("2026-11-15T10:00:00.000Z");
    const out = { changes: [{ claim: "a", title: "Summaries too long", concept: { ref_id: "w", name: "Writing" }, kind: "changed" as const, removed: ["old"], added: ["new"], why: "it came back" }, { claim: "b", title: "x", concept: { name: "Email" }, kind: "added" as const, removed: [], added: ["No greeting."], proposed: "p1" }] };
    assert.deepEqual(changesOf(out).map((c) => [c.ref_id, c.name, c.kind, c.claim, c.proposed]), [["w", "Writing", "changed", "a", undefined], ["new:Email", "Email", "added", "b", "p1"]]);
    const fix = { at: "2026-11-12T10:00:00.000Z", concept: "w", line: "new" };
    assert.deepEqual([
      claim("back", { corrected: 2, open: 1, fixes: [fix], evidence: [said({ at: "2026-11-14T10:00:00.000Z" })] }),
      claim("fixed", { corrected: 2, open: 0, fixes: [fix], evidence: [said()] }),
      claim("due", { corrected: 2, open: 2, fixes: [], evidence: [said()] }),
      claim("lasting", { corrected: 1, open: 1, lasting: true, fixes: [], evidence: [said()] }),
      claim("once", { corrected: 1, open: 1, fixes: [], evidence: [said()] }),
    ].map((c) => standingOf(c, "run", now).label), ["Came back after fix", "Fixed, quiet 3 days", "Due a fix", "Due a fix", "Seen once"]);
    const came = claim("back", { corrected: 2, open: 1, fixes: [fix], evidence: [said({ dream: "run", at: "2026-11-14T10:00:00.000Z" }), said({ dream: "old" })] });
    assert.deepEqual(summaryOf({ turns: 3, claims: [came], changes: out.changes }, "run"), { turns: 3, found: 1, concepts: 2, back: 1 }, "came back: corrected after a fix already made");
  });

  it("reads every dream together: evidence added up across runs, each change tied to its claim, and where each cause stands", () => {
    const fix = { at: "2026-11-11T04:00:00.000Z", concept: "w", line: "Summaries are three lines." };
    const first = said({ dream: "run-1", at: "2026-11-10T10:00:00.000Z", excerpt: "too long" });
    const again = said({ dream: "run-1", at: "2026-11-10T11:00:00.000Z", turn: 2, excerpt: "still too long" });
    const back = said({ dream: "run-2", at: "2026-11-12T10:00:00.000Z", turn: 3, excerpt: "long again", outcome: "not_followed" });
    const other = said({ dream: "run-2", at: "2026-11-12T11:00:00.000Z", turn: 4, excerpt: "no emoji" });
    const run = (runId: string, startedAt: string, output: Run["output"]): Run => ({ runId, startedAt, status: "completed", output });
    const root = { ref_id: "root", name: "Personal", depth: 0 };
    const runs = [
      run("run-1", "2026-11-11T04:00:00.000Z", {
        turns: 5, claims: [claim("a", { corrected: 2, open: 0, fixes: [fix], evidence: [again, first] })],
        changes: [{ claim: "a", title: "a", concept: { ref_id: "w", name: "Writing" }, kind: "changed", removed: ["Be brief."], added: [fix.line], why: "said twice" }],
      }),
      run("run-2", "2026-11-13T04:00:00.000Z", {
        turns: 3, claims: [claim("a", { corrected: 3, open: 1, fixes: [fix], evidence: [back] }), claim("b", { corrected: 1, open: 1, fixes: [], evidence: [other] })],
        changes: [], tree: [root, concept("w", "Writing", { docs: "Summaries are three lines.\nNo emoji." })],
      }),
      run("run-3", "2026-11-14T04:00:00.000Z", { turns: 0 }),
    ];
    const m = buildModel(runs);
    assert.deepEqual(m.runs.map((r) => r.runId), ["run-3", "run-2", "run-1"], "newest first");
    assert.deepEqual(m.causes.map((c) => [c.claim.id, c.fix, c.back, c.fresh, c.said.map((e) => e.excerpt)]), [
      ["a", "back", 1, false, ["long again", "still too long", "too long"]],
      ["b", "none", 0, true, ["no emoji"]],
    ], "the newest run's claims, with what every run kept said for them");
    const a = m.byId.get("a")!;
    assert.deepEqual(a.fixes.map((f) => [f.run.runId, f.change.name, f.causes.map((w) => w.said.excerpt)]), [["run-1", "Writing", ["still too long", "too long"]]]);
    assert.deepEqual([conceptOf(m, "w")?.name, conceptOf(m, "new:Writing", "Writing")?.ref_id, conceptOf(m, "gone")], ["Writing", "w", undefined], "a Concept by ref, or by name when a dream added it");
    assert.deepEqual(inMemory(m, a), [fix.line], "the line written for it that memory still has");
    assert.deepEqual(runs.map((r) => runSummary(m, r)), [{ turns: 5, changed: 1, found: 2, back: 0 }, { turns: 3, changed: 0, found: 2, back: 1 }, { turns: 0, changed: 0, found: 0, back: 0 }]);
    assert.deepEqual(runs.map((r) => headline(m, r)), ["1 change · 2 corrections", "2 corrections · 1 came back", "Nothing new to read"]);
    assert.equal(headline(m, { ...runs[2]!, status: "running" }), "Dreaming");
  });

  it("says a time as how long ago for today and yesterday, the date before that", () => {
    const now = new Date(2026, 10, 11, 15, 0, 0).getTime();
    const back = (mins: number) => new Date(now - mins * 60_000).toISOString();
    assert.deepEqual([back(0), back(5), back(61), back(20 * 60), back(30 * 60)].map((t) => agoText(t, now)), ["just now", "5 min ago", "1 hr ago", "20 hr ago", "yesterday"]);
    assert.match(agoText(new Date(2026, 10, 8, 9, 0, 0).toISOString(), now), /8/);
    assert.doesNotMatch(agoText(new Date(2026, 10, 8, 9, 0, 0).toISOString(), now), /ago|yesterday/);
    assert.equal(agoText("nope", now), "");
  });

  it("reads a rewritten line as one line, and two lines that share little apart", () => {
    assert.deepEqual(inlineDiff("Call it [peel agent] in notes", "Call it [Agent] in notes"), [["Call it ", "same"], ["[peel agent]", "gone"], ["[Agent] ", "new"], ["in notes", "same"]]);
    assert.equal(inlineDiff("Be brief.", "Summaries are three lines or fewer."), null);
  });

  it("says how a staged dream got there, a stage a line; an older run has no stages", () => {
    const out = { turns: 60, more: true, moments: 8, records: [{ i: 0, claim: "a", created: true, recorded: true, outcome: "missing" as const }, { i: 1, claim: "a", created: false, recorded: true, outcome: "missing" as const }, { i: 2, claim: "b", created: false, recorded: false, outcome: "missing" as const }], groups: [{ claim: "g", grouped: ["a", "b"] }], due: 1, changes: [] };
    assert.deepEqual(stagesOf(out).map((s) => [s.stage, s.count]), [["Read", 60], ["Found", 8], ["Recorded", 2], ["Grouped", 1], ["Due", 1], ["Changed", 0]]);
    assert.match(stagesOf(out)[2]!.text, /1 on a new cause, 1 on one already known/);
    assert.deepEqual(stagesOf({ turns: 5 }), []);
  });

  it("says what a run cost, and when it cost nothing", () => {
    assert.deepEqual([costText(0), costText(undefined), costText(0.004), costText(1.239)], ["no model cost", "no model cost", "under $0.01", "$1.24"]);
  });
});

describe("strut/dream — seeded at boot beside strut/views", () => {
  let kit: KitLocation;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const quiet = { serveUi: false, enableChat: false, scheduler: false } as const;
  before(async () => {
    kit = await kitForTests();
  });
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("publishes strut/dream with strut/views compiled in, granted the dream workflow's runs and no step; `dream: false` seeds none", async () => {
    const first = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-dream-seed-")), store: new MemoryRunStore(), kit });
    const app = await first.apps.get(DREAM_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale], ["v1", "strut", "seed", false]);
    assert.equal(app.hash, await treeHash(DREAM_DIR));
    assert.equal(app.manifest.title, "Dreaming");
    assert.deepEqual(app.manifest.grants.workflows, ["dream"]);
    assert.deepEqual(app.manifest.grants.steps, []);
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    const views = (await first.apps.get(VIEWS_APP))!;
    assert.deepEqual(info.imports, [{ name: VIEWS_APP, version: views.version, hash: views.hash }], "strut/views compiled in");
    assert.deepEqual(info.warnings, []);
    const html = await readFile(join(app.dir, "dist", "index.html"), "utf8");
    assert.match(html, /run it once, in Automations/);
    assert.match(html, /In memory now/);
    assert.doesNotMatch(html, /Run now/, "the app starts no run");
    assert.match(html, /Every step it took/);
    assert.ok(info.bytes < 2_000_000, `${info.bytes} bytes`);

    const off = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-dream-off-")), store: new MemoryRunStore(), kit, dream: false });
    assert.equal(await off.apps.get(DREAM_APP), null);
    assert.ok(await off.apps.get(VIEWS_APP), "the others still seeded");
  });
});
