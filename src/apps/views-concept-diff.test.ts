// strut/views' ConceptDiff: what it reads through the importer's client —
// `history/read` (a diff between two moments, a page's log, a page then),
// `proposal/get` and the nodes a proposal names — answered by the gallery's
// fixture history, and the entries the kit's fold draws from them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldConceptDiff } from "@strut/kit/folds";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { HISTORY_COMMITS } from "./views/src/fixtures/history.js";
import { commitReads, compareReads, readDiff, readEntry, readLog, readPage, readProposalEntry, NoHistoryError } from "./views/src/lib/history.js";

const client = createFixtureClient({ latencyMs: 0 });

describe("strut/views — ConceptDiff's reads", () => {
  it("the tree between two moments: every kind of change, the git-missed rename paired", async () => {
    const d = await readDiff(client, { from: HISTORY_COMMITS[0]!.id, to: "main" });
    const by = Object.fromEntries(foldConceptDiff(d.entries).pages.map((p) => [p.name, p.status]));
    // SLA was moved, then renamed and rewritten: over the whole range its parents differ, so it is not paired…
    assert.deepEqual(by, { Escrow: "removed", NDA: "edited", "Service levels": "added", Services: "added", SLA: "removed", "Tort Law": "renamed", Wills: "added" });
    // …and in the commit that renamed it (git saw a delete and an add) its parents match and its words are alike: paired.
    const one = foldConceptDiff((await readDiff(client, { from: HISTORY_COMMITS[2]!.id, to: HISTORY_COMMITS[3]!.id })).entries).pages;
    assert.deepEqual(one.map((p) => `${p.name}:${p.status}${p.paired ? " (paired)" : ""}`), ["Service levels:renamed (paired)", "Tort Law:renamed"]);
    // A time between two commits reads the earlier one.
    const t = await readDiff(client, { from: new Date(Date.parse(HISTORY_COMMITS[1]!.time) + 60_000).toISOString(), to: HISTORY_COMMITS[2]!.id });
    assert.deepEqual(foldConceptDiff(t.entries).pages.map((p) => `${p.name}:${p.status}`), ["Services:added", "SLA:moved", "Wills:added"]);
  });

  it("a page's log follows it through a rename; each commit draws what it did, two compared", async () => {
    const { commits } = await readLog(client, { path: "concepts/concept-tortlaw.md", limit: 5 });
    assert.deepEqual(commits.map((c) => c.changes[0]!.status), ["renamed", "added"]);
    const renamed = await readEntry(client, commitReads(commits, 0));
    assert.deepEqual([renamed!.path, renamed!.from], ["concepts/concept-tortlaw.md", "concepts/concept-torts.md"]);
    assert.equal(foldConceptDiff([renamed!]).pages[0]!.status, "renamed");
    // The first commit added it: nothing before.
    assert.deepEqual(commitReads(commits, 1).before, undefined);
    assert.equal(foldConceptDiff([(await readEntry(client, commitReads(commits, 1)))!]).pages[0]!.status, "added");

    const nda = (await readLog(client, { path: "concepts/concept-nda.md" })).commits;
    assert.equal(nda.length, 2);
    const both = await readEntry(client, compareReads(nda, 1, 0));
    const c = foldConceptDiff([both!]).pages[0]!;
    assert.equal(c.status, "edited");
    assert.equal(c.docs, true);
    assert.equal(await readPage(client, "concepts/concept-wills.md", HISTORY_COMMITS[0]!.id), undefined, "not there then");
  });

  it("a pending proposal laid over the page now: an edit, a move by its ends' names, a create", async () => {
    const edit = await readProposalEntry(client, "prop-edit");
    assert.equal(edit.proposal.title, "Tighten the NDA page");
    const e = foldConceptDiff([edit.entry!]).pages[0]!;
    assert.deepEqual([e.name, e.status, e.docs], ["NDA", "edited", true]);
    const move = foldConceptDiff([(await readProposalEntry(client, "prop-move")).entry!]).pages[0]!;
    assert.deepEqual([move.status, move.parentsBefore, move.parentsAfter], ["moved", ["Contracts", "Services"], ["Services"]]);
    assert.equal(foldConceptDiff([(await readProposalEntry(client, "prop-create")).entry!]).pages[0]!.status, "added");
  });

  it("a strut with no history says so", async () => {
    const none = { run: async () => ({ history: false, message: "There is no history on this strut server." }) } as never;
    await assert.rejects(readLog(none, { path: "concepts" }), (err: unknown) => err instanceof NoHistoryError && /no history/.test(err.message));
  });
});
