import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposal, listProposals, proposalsRoot, readProposal, type NewProposal, type Proposal } from "./proposals.js";
import { proposalsCapability } from "./proposals.js";

// The list index: filters in memory, files read only for what matched.

const mk = (n: string, by: Partial<NewProposal["by"]> = {}): NewProposal => ({
  step: "dev/write",
  input: { name: n },
  title: n,
  by: { workflow: "wf", runId: "r1", path: "wf/a", ...by },
});

describe("proposals index", () => {
  let dir = "";
  let root = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-proposals-ix-"));
    root = proposalsRoot(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** A record written behind the module's back, as an older process left it. */
  const external = async (id: string, extra: Partial<Proposal> = {}) => {
    await mkdir(root, { recursive: true });
    const p = { id, step: "s", input: {}, title: id, status: "pending", createdAt: "2020-01-01T00:00:00.000Z", by: { workflow: "w", runId: "x", path: "p" }, ...extra };
    await writeFile(join(root, `${id}.json`), JSON.stringify(p));
  };

  it("picks up files written before the first list, tolerating corrupt ones", async () => {
    await external("ext-aaaaaaaa");
    await writeFile(join(root, "broken-bbbbbbbb.json"), "{nope");
    const all = await listProposals(root);
    assert.deepEqual(all.map((p) => p.id), ["ext-aaaaaaaa"]);
  });

  it("filters by job, session, runId, status and sorts newest first", async () => {
    const a = await createProposal(root, mk("a", { job: "j1", session: "s1", runId: "r1" }));
    const b = await createProposal(root, mk("b", { job: "j2", session: "s1", runId: "r2" }));
    const c = await createProposal(root, mk("c", { job: "j1", session: "s2", runId: "r2" }));
    assert.deepEqual((await listProposals(root)).map((p) => p.id), [c.id, b.id, a.id]);
    assert.deepEqual((await listProposals(root, { job: "j1" })).map((p) => p.id), [c.id, a.id]);
    assert.deepEqual((await listProposals(root, { session: "s1" })).map((p) => p.id), [b.id, a.id]);
    assert.deepEqual((await listProposals(root, { runId: "r2" })).map((p) => p.id), [c.id, b.id]);
    assert.deepEqual((await listProposals(root, { status: ["pending", "failed"], job: "j2" })).map((p) => p.id), [b.id]);
    assert.deepEqual(await listProposals(root, { status: "applied" }), []);
  });

  it("limit applies after the sort", async () => {
    const ids: string[] = [];
    for (const n of ["a", "b", "c"]) ids.push((await createProposal(root, mk(n))).id);
    assert.deepEqual((await listProposals(root, { limit: 2 })).map((p) => p.id), [ids[2], ids[1]]);
  });

  it("a status change shows in the next list without a rescan, and decided ones are archived but readable", async () => {
    const cap = proposalsCapability(dir, {});
    void cap;
    const a = await createProposal(root, mk("a"));
    assert.equal((await listProposals(root, { status: "pending" })).length, 1);
    // Not indexed: proves the second list does not rescan the directory.
    await external("late-cccccccc");
    assert.deepEqual((await listProposals(root, { status: "pending" })).map((p) => p.id), [a.id]);

    const { decideProposal } = await import("./proposals.js");
    const out = await decideProposal(root, a.id, { action: "reject", reason: "no" }, { registry: {}, services: {} } as never);
    assert.ok(out);
    assert.equal((await listProposals(root, { status: "pending" })).length, 0);
    assert.deepEqual((await listProposals(root, { status: "rejected" })).map((p) => p.id), [a.id]);
    assert.ok((await readdir(join(root, "archive"))).includes(`${a.id}.json`));
    assert.equal((await readProposal(root, a.id))?.status, "rejected");
  });

  it("runId takes several; reported narrows to what the session was or was not told", async () => {
    const a = await createProposal(root, mk("a", { runId: "r1", session: "s" }));
    const b = await createProposal(root, mk("b", { runId: "r2", session: "s" }));
    await createProposal(root, mk("c", { runId: "r3", session: "s" }));
    assert.deepEqual((await listProposals(root, { runId: ["r1", "r2"] })).map((p) => p.id), [b.id, a.id]);
    const cap = proposalsCapability(dir, {});
    assert.equal((await listProposals(root, { reported: false })).length, 3);
    await cap.markReported([a.id]);
    assert.deepEqual((await listProposals(root, { reported: true })).map((p) => p.id), [a.id]);
    assert.equal((await listProposals(root, { reported: false })).length, 2);
  });

  it("viewer: a person token's list is decided on the index, before the limit", async () => {
    // Newest first: two of someone else's, then two of mine.
    const mine1 = await createProposal(root, mk("m1", { actor: "alice", session: "alice/1" }));
    const mine2 = await createProposal(root, mk("m2", { actor: "alice", session: "alice/2" }));
    await createProposal(root, mk("o1", { actor: "bob", session: "bob/1" }));
    await createProposal(root, mk("o2", { actor: "alice", session: "hive-chat" }));
    const viewer = { scope: "peer:person" as const, actor: "alice" };
    assert.deepEqual((await listProposals(root, { viewer, limit: 2 })).map((p) => p.id), [mine2.id, mine1.id]);
    assert.equal((await listProposals(root, { viewer: { scope: "full" } })).length, 4);
    assert.deepEqual(await listProposals(root, { viewer: { scope: "peer" } }), []);
  });

  it("concurrent identical lists share one read", async () => {
    await createProposal(root, mk("a"));
    const [x, y] = await Promise.all([listProposals(root, { status: "pending" }), listProposals(root, { status: "pending" })]);
    assert.notEqual(x, y);
    assert.equal(x[0], y[0]); // the very same parsed record: one read
  });
});
