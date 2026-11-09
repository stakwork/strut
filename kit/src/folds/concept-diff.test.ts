import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  conceptPagePath, editEntry, foldConceptDiff, foldDiffLines, historyEntries, isConceptPagePath, lineDiff, proposalEntry, proposalRefs, textSimilarity,
  type ConceptDiffNode, type ConceptPage, type HistoryDiffEntry,
} from "./concept-diff.js";
import { composeNodeKey } from "../../../src/graph/node-writer.js";

const page = (name: string, parents: string[] = [], extra: Partial<ConceptPage> = {}): ConceptPage => ({ name, attributes: {}, parents, ...extra });
const file = (p: ConceptPage) => ({ text: `---\nname: ${p.name}\n---\n`, parsed: p });

/** The tree as `name [status]`, indented, for an assertion a person reads. */
function draw(nodes: ConceptDiffNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.name} [${n.context ? "context" : n.status}]`, ...draw(n.children, depth + 1)]);
}

describe("concept diff — statuses", () => {
  it("marks every kind of change, and keeps an unchanged page the entries held", () => {
    const law = page("Law", [], { attributes: { description: "The law." } });
    const d = foldConceptDiff([
      { path: "concepts/concept-wills.md", after: page("Wills", ["Law"]) },
      { path: "concepts/concept-torts.md", before: page("Torts", ["Law"]) },
      { path: "concepts/concept-tortlaw.md", from: "concepts/concept-torts2.md", before: page("Torts 2", ["Law"]), after: page("Tort Law", ["Law"]) },
      { path: "concepts/concept-trusts.md", before: page("Trusts", ["Law"]), after: page("Trusts", ["Practice"]) },
      { path: "concepts/concept-nda.md", before: page("NDA", ["Law"], { docs: "a\nb" }), after: page("NDA", ["Law"], { docs: "a\nc" }) },
      { path: "concepts/concept-law.md", before: law, after: law },
    ]);
    const by = Object.fromEntries(d.pages.map((p) => [p.name, p]));
    assert.equal(by["Wills"]!.status, "added");
    assert.equal(by["Torts"]!.status, "removed");
    assert.equal(by["Tort Law"]!.status, "renamed");
    assert.equal(by["Tort Law"]!.nameBefore, "Torts 2");
    assert.equal(by["Tort Law"]!.from, "concepts/concept-torts2.md");
    assert.equal(by["Trusts"]!.status, "moved");
    assert.deepEqual([by["Trusts"]!.parentsBefore, by["Trusts"]!.parentsAfter], [["Law"], ["Practice"]]);
    assert.equal(by["NDA"]!.status, "edited");
    assert.equal(by["NDA"]!.docs, true);
    assert.equal(by["Law"]!.status, "unchanged");
    assert.deepEqual(d.counts, { added: 1, removed: 1, renamed: 1, moved: 1, edited: 1, unchanged: 1 });
    assert.equal(foldConceptDiff([{ path: "concepts/concept-law.md", before: law, after: law }], { hideUnchanged: true }).pages.length, 0);
  });

  it("says everything a page did: renamed, moved and edited at once, an attribute's before and after", () => {
    const d = foldConceptDiff([
      {
        path: "concepts/concept-b.md",
        before: page("A", ["X"], { attributes: { description: "old", repo: "o/r" } }),
        after: page("B", ["Y"], { attributes: { description: "new", alt_names: ["b"] } }),
      },
    ]);
    const c = d.pages[0]!;
    assert.deepEqual(c.marks, ["renamed", "moved", "edited"]);
    assert.equal(c.status, "renamed");
    assert.deepEqual(c.attributes, [
      { name: "description", before: "old", after: "new" },
      { name: "alt_names", after: ["b"] },
      { name: "repo", before: "o/r" },
    ]);
    assert.equal(c.docs, false);
  });
});

describe("concept diff — source one: history/read diff", () => {
  const entries: HistoryDiffEntry[] = [
    { path: "concepts/concept-wills.md", status: "added", after: file(page("Wills", ["Law"])) },
    { path: "concepts/concept-trusts.md", status: "modified", before: file(page("Trusts", ["Law"])), after: file(page("Trusts", ["Practice", "Law"])) },
    { path: "concepts/concept-tortlaw.md", status: "renamed", from: "concepts/concept-torts.md", before: file(page("Torts", ["Law"])), after: file(page("Tort Law", ["Law"])) },
    { path: "concepts/concept-gone.md", status: "deleted", before: file(page("Gone", [])) },
    { path: "namespaces/private/concepts/concept-mine.md", status: "added", after: file(page("Mine")) },
    { path: "concepts/concept-broken.md", status: "modified", before: { text: "x", parseError: "no front matter" }, after: { text: "y", parseError: "no front matter" } },
    { path: "graph/Person.yaml", status: "modified", before: { text: "a", parsed: { type: "Person" } }, after: { text: "b", parsed: { type: "Person" } } },
    { path: "workflows/sync.yaml", status: "added", after: { text: "name: sync" } },
  ];

  it("keeps the Concept pages alone, in every namespace, and drops one that would not parse", () => {
    const got = historyEntries(entries);
    assert.deepEqual(got.map((e) => e.path), [
      "concepts/concept-wills.md", "concepts/concept-trusts.md", "concepts/concept-tortlaw.md", "concepts/concept-gone.md", "namespaces/private/concepts/concept-mine.md",
    ]);
    assert.equal(got[2]!.from, "concepts/concept-torts.md");
    assert.deepEqual(got[1]!.after!.parents, ["Law", "Practice"], "parents sorted");
    assert.ok(isConceptPagePath("concepts/concept-x.md") && !isConceptPagePath("concepts/sub/x.md") && !isConceptPagePath("graph/X.yaml"));
  });

  it("folds them into the tree: renamed by git, moved and added under their parents, a parent the diff lacks as context", () => {
    const d = foldConceptDiff(historyEntries(entries));
    assert.deepEqual(draw(d.tree), [
      "Gone [removed]",
      "Law [context]",
      "  Tort Law [renamed]",
      "  Trusts [moved]",
      "  Wills [added]",
      "Mine [added]",
      "Practice [context]",
      "  Trusts [moved]",
    ]);
  });

  it("pairs a short page git saw as a delete and an add: same parents, like prose", () => {
    // Renamed and rewritten: under 50% alike as files, so git does not pair them.
    const d = foldConceptDiff(historyEntries([
      { path: "concepts/concept-nda.md", status: "deleted", before: file(page("NDA", ["Contracts"], { attributes: { description: "Non-disclosure agreements: what each side may share and for how long." } })) },
      { path: "concepts/concept-nondisclosure.md", status: "added", after: file(page("Non-disclosure", ["Contracts"], { attributes: { description: "Non-disclosure agreements: what each party may share, and how long it lasts." } })) },
      { path: "concepts/concept-sla.md", status: "deleted", before: file(page("SLA", ["Contracts"], { attributes: { description: "Uptime promises." } })) },
      { path: "concepts/concept-msa.md", status: "added", after: file(page("MSA", ["Contracts"], { attributes: { description: "The master agreement every order hangs off." } })) },
      { path: "concepts/concept-gdpr.md", status: "deleted", before: file(page("GDPR", ["Privacy"], { attributes: { description: "Non-disclosure agreements: what each side may share and for how long." } })) },
    ]));
    const by = Object.fromEntries(d.pages.map((p) => [p.name, p]));
    assert.equal(by["Non-disclosure"]!.status, "renamed");
    assert.equal(by["Non-disclosure"]!.paired, true);
    assert.equal(by["Non-disclosure"]!.nameBefore, "NDA");
    assert.equal(by["Non-disclosure"]!.from, "concepts/concept-nda.md");
    assert.equal(by["NDA"], undefined, "the delete is folded into the rename");
    assert.equal(by["SLA"]!.status, "removed", "unlike prose: not paired");
    assert.equal(by["MSA"]!.status, "added");
    assert.equal(by["GDPR"]!.status, "removed", "other parents: not paired");
    assert.ok(textSimilarity("a b c d", "a b c e") >= 0.5 && textSimilarity("a", "") === 0);
  });
});

describe("concept diff — the tree", () => {
  it("climbs a context row through the live tree's parents, puts a page under each parent, and is cycle-safe", () => {
    const live: Record<string, string[]> = { Contracts: ["Law"], Law: [], Practice: ["Law"] };
    const d = foldConceptDiff(
      [
        { path: "concepts/concept-nda.md", before: page("NDA", ["Contracts"]), after: page("NDA", ["Contracts", "Practice"]) },
        { path: "concepts/concept-a.md", before: page("A", ["B"]), after: page("A", ["B"], { docs: "x" }) },
        { path: "concepts/concept-b.md", before: page("B", ["A"]), after: page("B", ["A"], { docs: "y" }) },
      ],
      { parentsOf: (n) => live[n] },
    );
    assert.deepEqual(draw(d.tree), [
      "Law [context]",
      "  Contracts [context]",
      "    NDA [moved]",
      "  Practice [context]",
      "    NDA [moved]",
      "A [edited]",
      "  B [edited]",
    ]);
    const keys = (ns: ConceptDiffNode[]): string[] => ns.flatMap((n) => [n.key, ...keys(n.children)]);
    const all = keys(d.tree);
    assert.equal(new Set(all).size, all.length, "every row's key is unique");
  });

  it("hangs a removed child under its parent's new name when the parent was renamed", () => {
    const d = foldConceptDiff([
      { path: "concepts/concept-torts.md", before: page("Torts", ["Law"]), after: page("Tort Law", ["Law"]) },
      { path: "concepts/concept-negligence.md", before: page("Negligence", ["Torts"]) },
    ]);
    assert.deepEqual(draw(d.tree), ["Law [context]", "  Tort Law [renamed]", "    Negligence [removed]"]);
  });
});

describe("concept diff — source two: a pending proposal over the page now", () => {
  const current = { path: "concepts/concept-nda.md", page: page("NDA", ["Contracts"], { attributes: { description: "Old.", repo: "acme/legal" }, docs: "line one\nline two" }) };
  const names: Record<string, string> = { "ref-nda": "NDA", "ref-contracts": "Contracts", "ref-privacy": "Privacy" };
  const nameOf = (r: string) => names[r];

  it("an edit: the node data over the page, a removed property gone, a person's edits on top", () => {
    const e = proposalEntry(
      {
        step: "graph/edit-node",
        input: { ref_id: "ref-nda", node_data: { description: "New.", docs: "line one\nline 2" }, properties_to_be_deleted: ["repo"] },
        decision: { input: { node_data: { description: "Newer.", docs: "line one\nline 2" } } },
      },
      current,
      nameOf,
    )!;
    const c = foldConceptDiff([e]).pages[0]!;
    assert.equal(c.status, "edited");
    assert.deepEqual(c.attributes, [{ name: "description", before: "Old.", after: "Newer." }, { name: "repo", before: "acme/legal" }]);
    assert.equal(c.docs, true);
    // A rename moves the file: its path is the new key.
    const r = proposalEntry({ step: "graph/edit-node", input: { ref_id: "ref-nda", node_data: { name: "Non-disclosure" } } }, current)!;
    assert.deepEqual([r.path, r.from], ["concepts/concept-nondisclosure.md", "concepts/concept-nda.md"]);
    assert.equal(foldConceptDiff([r]).pages[0]!.status, "renamed");
    // node_type set is a type change, never a page edit.
    assert.equal(proposalEntry({ step: "graph/edit-node", input: { ref_id: "ref-nda", node_type: "Concept", node_data: {} } }, current), null);
    // Nothing to lay it over.
    assert.equal(proposalEntry({ step: "graph/edit-node", input: { ref_id: "ref-nda", node_data: {} } }, null), null);
  });

  it("a move along PARENT_OF: the parent it names swapped, or its only one", () => {
    const named = proposalEntry({ step: "graph/move-node", input: { ref_id: "ref-nda", edge_type: "PARENT_OF", direction: "reverse", from_ref_id: "ref-contracts", to_ref_id: "ref-privacy" } }, current, nameOf)!;
    assert.deepEqual(named.after!.parents, ["Privacy"]);
    const only = proposalEntry({ step: "graph/move-node", input: { ref_id: "ref-nda", edge_type: "PARENT_OF", direction: "reverse", to_ref_id: "ref-privacy" } }, current, nameOf)!;
    const c = foldConceptDiff([only]).pages[0]!;
    assert.equal(c.status, "moved");
    assert.deepEqual([c.parentsBefore, c.parentsAfter], [["Contracts"], ["Privacy"]]);
    assert.deepEqual(proposalRefs({ step: "graph/move-node", input: { ref_id: "ref-nda", from_ref_id: "ref-contracts", to_ref_id: "ref-privacy" } }), ["ref-nda", "ref-contracts", "ref-privacy"]);
    // Another edge, the other way, or a target nobody can name: no page changes.
    assert.equal(proposalEntry({ step: "graph/move-node", input: { ref_id: "ref-nda", edge_type: "TOUCHES", direction: "reverse", to_ref_id: "ref-privacy" } }, current, nameOf), null);
    assert.equal(proposalEntry({ step: "graph/move-node", input: { ref_id: "ref-nda", edge_type: "PARENT_OF", direction: "forward", to_ref_id: "ref-privacy" } }, current, nameOf), null);
    assert.equal(proposalEntry({ step: "graph/move-node", input: { ref_id: "ref-nda", edge_type: "PARENT_OF", direction: "reverse", to_ref_id: "ref-x" } }, current, nameOf), null);
  });

  it("a create of a Concept is an added page; a delete a removed one; anything else is no page", () => {
    const created = proposalEntry({ step: "graph/create-node", input: { node_type: "Concept", node_data: { name: "Wills", description: "Last testaments.", docs: " # Wills " } } }, null)!;
    assert.deepEqual(created, { path: "concepts/concept-wills.md", after: { name: "Wills", attributes: { description: "Last testaments." }, parents: [], docs: "# Wills" } });
    assert.equal(foldConceptDiff([created]).pages[0]!.status, "added");
    const deleted = proposalEntry({ step: "graph/delete-node", input: { ref_id: "ref-nda", reason: "duplicate" } }, current)!;
    assert.equal(foldConceptDiff([deleted]).pages[0]!.status, "removed");
    assert.equal(proposalEntry({ step: "graph/create-node", input: { node_type: "Person", node_data: { name: "Ada" } } }, null), null);
    assert.equal(proposalEntry({ step: "graph/create-triplet", input: {} }, current), null);
  });
});

describe("concept diff — source three: an unsaved edit", () => {
  it("the page as edited against the page as shown", () => {
    const shown = page("NDA", ["Contracts"], { attributes: { description: "Old." } });
    const c = foldConceptDiff([editEntry("concepts/concept-nda.md", shown, { ...shown, attributes: { description: "New." } })]).pages[0]!;
    assert.equal(c.status, "edited");
    assert.deepEqual(c.attributes, [{ name: "description", before: "Old.", after: "New." }]);
    assert.equal(foldConceptDiff([editEntry("concepts/concept-nda.md", shown, shown)]).pages[0]!.status, "unchanged");
  });
});

describe("concept diff — the docs, line by line", () => {
  const ops = (before?: string, after?: string) => lineDiff(before, after).map((l) => `${l.op === "same" ? " " : l.op === "add" ? "+" : "-"}${l.text}`);

  it("keeps the common lines and marks what went and came, deletions first", () => {
    assert.deepEqual(ops("a\nb\nc", "a\nb\nc"), [" a", " b", " c"]);
    assert.deepEqual(ops("a\nb\nc", "a\nx\nc"), [" a", "-b", "+x", " c"]);
    assert.deepEqual(ops("a\nc", "a\nb\nc"), [" a", "+b", " c"]);
    assert.deepEqual(ops("a\nb\nc\nd", "b\nd\ne"), ["-a", " b", "-c", " d", "+e"]);
    assert.deepEqual(ops(undefined, "a\nb"), ["+a", "+b"]);
    assert.deepEqual(ops("a", undefined), ["-a"]);
  });

  it("numbers each line on its side", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nx\ny\nc\nd");
    assert.deepEqual(d.map((l) => [l.op, l.a ?? null, l.b ?? null]), [
      ["same", 1, 1], ["del", 2, null], ["add", null, 2], ["add", null, 3], ["same", 3, 4], ["same", 4, 5],
    ]);
  });

  it("folds long unchanged runs into gaps, keeping context round each change", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const folded = foldDiffLines(lineDiff(before, after), 2);
    assert.deepEqual(folded.map((l) => (l.op === "gap" ? `…${l.count}` : `${l.op[0]}${l.text}`)), ["…8", "sl8", "sl9", "dl10", "aL10", "sl11", "sl12", "…7"]);
    assert.deepEqual(foldDiffLines(lineDiff("a", "a")), [{ op: "gap", count: 1 }]);
  });
});

describe("concept diff — where a page lies", () => {
  it("composes the key as the node writer does, a long name hashed", async () => {
    const schema = { type: "Concept", key_spec: "concept-name" };
    for (const name of ["Wills", "Tort Law", "acme/web", "Ünïcode & Co", "x".repeat(300)]) {
      assert.equal(await conceptPagePath(name), `concepts/${composeNodeKey(schema, { name })}.md`, name);
    }
    assert.equal(await conceptPagePath("Wills", "private"), "namespaces/private/concepts/concept-wills.md");
    assert.equal(await conceptPagePath("!!!"), null);
  });
});
