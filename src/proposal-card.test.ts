import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildCard } from "./proposal-card.js";
import { defineStep, type AnyStepDef, type StepContext } from "./core.js";
import { briefOf, proposalsCapability, proposeCall } from "./proposals.js";
import createNode from "./steps/lib/graph/create-node.js";
import editNode from "./steps/lib/graph/edit-node.js";
import createTriplet from "./steps/lib/graph/create-triplet.js";
import createBatch from "./steps/lib/graph/create-batch-triplet.js";
import moveNode from "./steps/lib/graph/move-node.js";
import deleteEdge from "./steps/lib/graph/delete-edge.js";
import deleteNode from "./steps/lib/graph/delete-node.js";
import appGrant from "./steps/lib/app/grant.js";
import pkgInstall from "./steps/lib/package/install.js";

const ctx = {} as StepContext<any>;
const describeOf = async (def: AnyStepDef, cfg: unknown) => {
  const d = await def.describe!(def.input.parse(cfg), ctx);
  return buildCard({ input: def.input.parse(cfg), title: d?.title ?? def.type, ...(d?.summary ? { summary: d.summary } : {}), ...(d ? { described: d } : {}) });
};

describe("proposal card", () => {
  it("generic fallback: one field per key, JSON for non-strings, cut and full=false", () => {
    const c = buildCard({ input: { a: "hi", b: { k: 1 }, c: 3, long: "z".repeat(600) }, title: "T" });
    assert.deepEqual(c.fields.slice(0, 3), [
      { label: "a", value: "hi" },
      { label: "b", value: '{"k":1}', kind: "code" },
      { label: "c", value: "3" },
    ]);
    assert.ok(c.fields[3]!.value.length <= 500 && c.fields[3]!.value.endsWith("… (see full input)"));
    assert.equal(c.full, false);
    assert.deepEqual(c.actions, { accept: "Accept", reject: "Reject" });
    const small = buildCard({ input: { a: "hi" }, title: "T", summary: "S" });
    assert.equal(small.full, true);
    assert.equal(small.summary, "S");
    assert.equal(small.v, 1);
  });

  it("keeps the first 12 keys", () => {
    const input = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
    const c = buildCard({ input, title: "T" });
    assert.equal(c.fields.length, 12);
    assert.equal(c.full, false);
  });


  it("graph/create-node", async () => {
    const c = await describeOf(createNode, { node_type: "Concept", node_data: { name: "Tea", n: 1 } });
    assert.equal(c.title, "Add Concept: Tea");
    assert.deepEqual(c.fields.map((f) => f.label), ["name", "n"]);
    assert.equal((await describeOf(createNode, { node_type: "Thing", node_data: { x: 1 } })).title, "Add Thing: Thing");
  });

  it("graph/edit-node", async () => {
    const c = await describeOf(editNode, { ref_id: "abc", node_data: { description: "d" }, properties_to_be_deleted: ["a", "b"] });
    assert.equal(c.title, "Edit node abc");
    assert.deepEqual(c.fields.map((f) => f.label), ["description", "Delete keys"]);
    assert.equal(c.fields[1]!.value, "a, b");
  });

  it("triplets", async () => {
    const one = await describeOf(createTriplet, { source_ref_id: "s1", target_type: "Concept", target_data: { name: "Tea" }, edge_type: "part of" });
    assert.deepEqual(one.fields.map((f) => f.value), ["s1 -PART_OF-> Tea"]);
    const mk = (n: number) => ({ triplets: Array.from({ length: n }, (_, i) => ({ source_ref_id: `a${i}`, target_ref_id: `b${i}`, edge_type: "E" })) });
    const ten = await describeOf(createBatch, mk(10));
    assert.equal(ten.fields.length, 10);
    assert.equal(ten.full, true);
    const many = await describeOf(createBatch, mk(13));
    assert.equal(many.fields.length, 11);
    assert.equal(many.fields[10]!.value, "+3 more");
    assert.equal(many.full, false);
  });

  it("move, delete-edge, delete-node, app/grant", async () => {
    const mv = await describeOf(moveNode, { ref_id: "n", edge_type: "PARENT_OF", direction: "reverse", to_ref_id: "p" });
    assert.deepEqual(mv.actions, { accept: "Move", reject: "Don't move" });
    assert.ok(mv.fields.some((f) => f.label === "To" && f.value === "p"));
    const de = await describeOf(deleteEdge, { source_ref_id: "a", edge_type: "PARENT_OF", target_ref_id: "b" });
    assert.ok(de.fields.length === 3 && de.fields.every((f) => f.danger));
    assert.deepEqual(de.actions, { accept: "Delete", reject: "Keep" });
    const dn = await describeOf(deleteNode, { ref_id: "n1" });
    assert.ok(dn.fields.every((f) => f.danger));
    assert.equal(dn.title, "Delete node n1");
    const g = await describeOf(appGrant, { name: "todo" });
    assert.equal(g.title, "Let app todo talk to the assistant as whoever opens it");
    assert.ok(g.fields.every((f) => f.danger));
    assert.deepEqual(g.actions, { accept: "Grant", reject: "Don't grant" });
    assert.match((await describeOf(appGrant, { name: "todo", workflow: "other" })).title, /run other/);
  });

  it("package/install keeps its summary and adds fields", async () => {
    const hit = {
      package: "acme/linear", version: "1.0.0", license: "MIT", publisher: "acme", key: "abcdefghijklmnopqrstuvwxyz", index: "main", digest: "sha256:" + "a".repeat(64),
      detail: { apps: [{ title: "A" }], workflows: 2, steps: 1, concepts: 0, secrets: ["LINEAR_KEY"], can: { spends: false, acts: true, code: true } },
    };
    const c2 = { services: { packages: { search: async () => ({ packages: [hit] }) } } } as unknown as StepContext<any>;
    const input = pkgInstall.input.parse({ package: "acme/linear" });
    const d = await pkgInstall.describe!(input, c2);
    assert.match(d!.summary!, /^acme\/linear 1\.0\.0 \(MIT\) from acme/);
    const card = buildCard({ input, title: d!.title!, summary: d!.summary!, described: d! });
    assert.deepEqual(card.fields.map((f) => f.label), ["Version and license", "Publisher key", "Brings", "Needs", "Runs code"]);
    assert.equal(card.fields[4]!.danger, true);
    assert.equal(card.fields[3]!.value, "LINEAR_KEY");
    assert.deepEqual(card.actions, { accept: "Install", reject: "Don't install" });
  });
});

describe("proposeCall carries the card", () => {
  let dir = "";
  beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "strut-card-"))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("record, brief and job.update; rationale stays out of the card; an old record reads", async () => {
    const seen: any[] = [];
    const cap = proposalsCapability(dir, { notify: (_j, u) => seen.push(u) });
    const plain = defineStep({ type: "dev/plain", description: "Do a thing. Then more.", input: z.object({ a: z.string() }), output: z.any(), async run() { return 1; } });
    const c = { runId: "r", path: "wf/t", scope: {}, input: undefined, emit: async () => {}, services: { proposals: cap }, job: "j", actor: "ann" } as unknown as StepContext;
    await proposeCall("dev/plain", plain as AnyStepDef, { a: "x" }, "because", c);
    const [rec] = await cap.list();
    assert.equal(rec!.card!.title, "Do a thing.");
    assert.deepEqual(rec!.card!.fields, [{ label: "a", value: "x" }]);
    assert.ok(!JSON.stringify(rec!.card).includes("because"));
    assert.equal(rec!.rationale, "because");
    assert.deepEqual(briefOf(rec!).card, rec!.card);
    // the job hears the title and the state, not the card
    assert.equal(seen[0].title, "Do a thing.");
    assert.equal(seen[0].state, "pending");
    assert.equal(seen[0].detail.card, undefined);
    const { card: _c, ...old } = rec!;
    assert.equal(briefOf(old).card, undefined);
  });
});
