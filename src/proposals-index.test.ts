import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRegistry } from "./steps/registry.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep } from "./core.js";
import { briefOf, createProposal, decideProposal, listProposals, proposalResultLines, proposalsRoot, queryProposals, readProposal, type Proposal } from "./proposals.js";
import { dropProposalIndex, proposalIndex, proposalIoStats } from "./proposals-index.js";

// The proposals index (plans/proposals-index-perf.md): lists answer from
// memory, a poll is one shared computation, decided records are compacted.

const DAY = 86_400_000;
const write = defineStep({
  type: "dev/write",
  description: "Write a thing.",
  input: z.object({ name: z.string() }),
  output: z.any(),
  async run(cfg) {
    return { wrote: cfg.name, big: "y".repeat(10_000) };
  },
});
const registry = { "dev/write": write };
const by = { workflow: "wf", runId: "r1", path: "wf/a", job: "j1", actor: "ann" };
const rec = (id: string, over: Partial<Proposal> = {}): Proposal => ({ id, step: "dev/write", input: { name: id, blob: "x".repeat(20 * 1024) }, title: `T ${id}`, status: "pending", createdAt: new Date().toISOString(), by, ...over });
const put = (root: string, p: Proposal) => writeFile(join(root, `${p.id}.json`), JSON.stringify(p, null, 2));
const pct = (xs: number[], q: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;

describe("proposals index: a huge directory", () => {
  const N = 20_000;
  let dir = "";
  let root = "";
  let buildMs = 0;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-prop-big-"));
    root = proposalsRoot(dir);
    await mkdir(root, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < N; i += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, N - i) }, (_, j) => {
          const k = i + j;
          const pending = k % 400 === 0;
          const createdAt = new Date(now - (N - k) * 1000).toISOString();
          return put(root, rec(`big${String(k).padStart(8, "0")}`, {
            createdAt,
            status: pending ? "pending" : k % 3 ? "applied" : "rejected",
            ...(pending ? {} : { decision: { action: "accept", at: createdAt }, result: { output: { ok: true }, at: createdAt } }),
          }));
        }),
      );
    }
    const t = Date.now();
    await proposalIndex(root).ready;
    buildMs = Date.now() - t;
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("(a) the boot build streams every file in bounded time and indexes them all", async () => {
    console.log(`  index build: ${N} files x ~20KB in ${buildMs} ms`);
    assert.ok(buildMs < 60_000, `build took ${buildMs} ms`);
    assert.equal((await queryProposals(root, {}, { limit: 1 })).total, N);
    assert.equal((await queryProposals(root, { status: "pending" })).total, N / 400);
  });

  it("(e) legacy decided files are compacted in the background, with no migration", async () => {
    const idx = proposalIndex(root);
    await idx.maintenance;
    const sample = await readProposal(root, "big00000001");
    assert.deepEqual(Object.keys(sample!.input as object).sort(), ["_compacted", "bytes"]);
    assert.equal(sample!.title, "T big00000001");
    const pending = await readProposal(root, "big00000000");
    assert.equal((pending!.input as { blob: string }).blob.length, 20 * 1024);
    // idempotent: a second boot over compacted files finds nothing to do
    dropProposalIndex(root);
    const again = proposalIndex(root);
    const t = Date.now();
    await again.ready;
    await again.maintenance;
    console.log(`  rebuild over compacted files: ${Date.now() - t} ms`);
    assert.equal((await queryProposals(root, {}, { limit: 1 })).total, N);
    assert.equal((await readFile(join(root, "big00000001.json"), "utf-8")).length < 2000, true);
  });

  it("(b) 200 concurrent pollers share one computation and read no file", async () => {
    const idx = proposalIndex(root);
    await idx.ready;
    await new Promise((r) => setTimeout(r, 1100)); // let any memo expire
    const reads = proposalIoStats.fileReads;
    let computed = 0;
    const lat: number[] = [];
    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const t = performance.now();
        await idx.memo("pending", async () => {
          computed++;
          return JSON.stringify(await queryProposals(root, { status: "pending" }, { limit: 100 }));
        });
        lat.push(performance.now() - t);
      }),
    );
    assert.equal(computed, 1);
    assert.equal(proposalIoStats.fileReads, reads);
    console.log(`  200 pollers: p50=${pct(lat, 0.5).toFixed(1)}ms p99=${pct(lat, 0.99).toFixed(1)}ms, ${computed} computation, 0 file reads`);
    assert.ok(pct(lat, 0.99) < 1000);
  });

  it("(c) memory and latency stay flat across repeated polls", async () => {
    const idx = proposalIndex(root);
    await idx.ready;
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    const lat: number[] = [];
    for (let i = 0; i < 400; i++) {
      const t = performance.now();
      const body = JSON.stringify(await queryProposals(root, { status: "pending" }));
      lat.push(performance.now() - t);
      assert.ok(body.length > 0);
    }
    gc?.();
    const delta = (process.memoryUsage().heapUsed - heap0) / 1048576;
    const early = pct(lat.slice(0, 100), 0.5);
    const late = pct(lat.slice(-100), 0.5);
    console.log(`  400 polls: heap delta ${delta.toFixed(1)} MB, p50 early ${early.toFixed(2)} ms late ${late.toFixed(2)} ms, p99 ${pct(lat, 0.99).toFixed(2)} ms`);
    assert.ok(delta < 64, `heap grew ${delta} MB`);
    assert.ok(late < Math.max(early * 5, 25));
  });

  it("(f) pagination: limit, offset, total, next; newest first", async () => {
    const all = await queryProposals(root, {}, { limit: 500 });
    assert.equal(all.proposals.length, 500);
    assert.equal(all.next, 500);
    assert.ok(all.proposals[0]!.createdAt > all.proposals[1]!.createdAt);
    const p2 = await queryProposals(root, {}, { limit: 500, offset: 500 });
    assert.equal(p2.proposals[0]!.id, (await queryProposals(root, {}, { limit: 1, offset: 500 })).proposals[0]!.id);
    const last = await queryProposals(root, {}, { limit: 500, offset: N - 10 });
    assert.equal(last.proposals.length, 10);
    assert.equal(last.next, undefined);
    assert.equal(last.total, N);
  });
});

describe("proposals index", () => {
  let dir = "";
  let root = "";
  const saved: Record<string, string | undefined> = {};
  const env = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const fresh = async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-prop-idx-"));
    root = proposalsRoot(dir);
  };
  after(() => {
    for (const [k, v] of Object.entries(saved)) env(k, v);
  });

  it("(d) create and decide update the index and drop the cache: a write is read at once", async () => {
    await fresh();
    env("STRUT_PROPOSALS_CACHE_MS", "60000");
    const idx = proposalIndex(root);
    let computed = 0;
    const pending = () => idx.memo("p", async () => (computed++, (await listProposals(root, { status: "pending" })).map((p) => p.id)));
    assert.deepEqual(await pending(), []);
    assert.deepEqual(await pending(), []);
    assert.equal(computed, 1, "cached");
    const a = await createProposal(root, { step: "dev/write", input: { name: "a" }, title: "A", by });
    assert.deepEqual(await pending(), [a.id]);
    assert.equal(computed, 2);
    const out = await decideProposal(root, a.id, { action: "accept", by: "ann" }, { registry, services: {} });
    assert.equal(out.status, 200);
    assert.deepEqual(await pending(), []);
    assert.deepEqual((await listProposals(root, { status: "applied" })).map((p) => p.id), [a.id]);
    // the cache off: still one computation for overlapping calls
    env("STRUT_PROPOSALS_CACHE_MS", "0");
    const before = computed;
    await Promise.all([pending(), pending(), pending()]);
    assert.equal(computed, before + 1);
    await pending();
    assert.equal(computed, before + 2);
    await rm(dir, { recursive: true, force: true });
  });

  it("(e) a decision compacts after the step ran; the person's answer is whole; failed keeps its input; the lines still read", async () => {
    await fresh();
    env("STRUT_PROPOSALS_CACHE_MS", undefined);
    const a = await createProposal(root, { step: "dev/write", input: { name: "a" }, title: "A", by });
    const out = await decideProposal(root, a.id, { action: "accept", by: "ann" }, { registry, services: {} });
    const body = out.body as Proposal;
    assert.deepEqual(body.input, { name: "a" }, "the answer carries the input the step ran with");
    assert.equal((body.result!.output as { wrote: string }).wrote, "a");
    const stored = (await readProposal(root, a.id))!;
    assert.equal((stored.input as { _compacted?: boolean })._compacted, true);
    assert.equal((stored.result!.output as { _compacted?: boolean })._compacted, true, "a big output is a marker");
    assert.equal(stored.status, "applied");
    assert.equal(briefOf(stored).title, "A");
    assert.match(proposalResultLines([stored])[0]!, /applied · dev\/write "A"/);
    assert.equal((await listProposals(root, { status: "applied" }))[0]!.id, a.id);

    const r = await createProposal(root, { step: "dev/write", input: { name: "r" }, title: "R", by });
    await decideProposal(root, r.id, { action: "reject", reason: "no" }, { registry, services: {} });
    assert.equal(((await readProposal(root, r.id))!.input as { _compacted?: boolean })._compacted, true);

    // failed: input kept, a retry runs it
    const f = await createProposal(root, { step: "dev/write", input: { name: "f" }, title: "F", by });
    const failing = { "dev/write": defineStep({ type: "dev/write", description: "x", input: z.object({ name: z.string() }), output: z.any(), run: async () => { throw new Error("away"); } }) };
    assert.equal(((await decideProposal(root, f.id, { action: "accept" }, { registry: failing, services: {} })).body as Proposal).status, "failed");
    assert.deepEqual((await readProposal(root, f.id))!.input, { name: "f" });
    const retry = await decideProposal(root, f.id, { action: "accept" }, { registry, services: {} });
    assert.equal((retry.body as Proposal).status, "applied");

    // COMPACT=0: kept whole
    env("STRUT_PROPOSALS_COMPACT", "0");
    const k = await createProposal(root, { step: "dev/write", input: { name: "k" }, title: "K", by });
    await decideProposal(root, k.id, { action: "accept" }, { registry, services: {} });
    assert.deepEqual((await readProposal(root, k.id))!.input, { name: "k" });
    env("STRUT_PROPOSALS_COMPACT", undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("(e) legacy files keep working; decided ones past the retention move to archive/ and read from there", async () => {
    await fresh();
    env("STRUT_PROPOSALS_RETENTION_DAYS", "30");
    await mkdir(root, { recursive: true });
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const recent = new Date(Date.now() - 2 * DAY).toISOString();
    await put(root, rec("legacy-old-1", { status: "applied", createdAt: old, decision: { action: "accept", at: old } }));
    await put(root, rec("legacy-new-1", { status: "rejected", createdAt: recent, decision: { action: "reject", at: recent, reason: "no" } }));
    await put(root, rec("legacy-pen-1", { status: "pending" }));
    await writeFile(join(root, "junk.json"), "{not json");
    const idx = proposalIndex(root);
    await idx.ready;
    await idx.maintenance;
    assert.deepEqual((await readdir(join(root, "archive"))).sort(), ["legacy-old-1.json"]);
    assert.equal((await readdir(root)).includes("legacy-old-1.json"), false);
    assert.equal(((await readProposal(root, "legacy-old-1"))!.input as { _compacted?: boolean })._compacted, true);
    assert.deepEqual((await listProposals(root)).map((p) => p.id).sort(), ["legacy-new-1", "legacy-pen-1"]);
    assert.equal(((await readProposal(root, "legacy-new-1"))!.input as { _compacted?: boolean })._compacted, true);
    assert.equal(((await readProposal(root, "legacy-pen-1"))!.input as { blob: string }).blob.length, 20 * 1024);
    env("STRUT_PROPOSALS_RETENTION_DAYS", "0");
    await rm(dir, { recursive: true, force: true });
  });

  it("(f) the route: limit / offset / total / next, a 400 for bad values, a decision at once", async () => {
    await fresh();
    env("STRUT_API_KEY", undefined);
    env("STRUT_PROPOSALS_CACHE_MS", "60000");
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      dataDir: dir,
      registry: await createRegistry([write]),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      systemWorkflows: false,
      job: false,
      orchestrator: false,
      builder: false,
    });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await createProposal(root, { step: "dev/write", input: { name: `n${i}` }, title: `P${i}`, by })).id);
      const get = async (q: string) => (await strut.app.request(`/proposals${q}`)).json() as Promise<{ proposals: Proposal[]; total: number; next?: number }>;
      const all = await get("");
      assert.deepEqual(all.proposals.map((p) => p.id), [...ids].reverse());
      assert.equal(all.total, 5);
      assert.equal(all.next, undefined);
      const p1 = await get("?limit=2");
      assert.deepEqual([p1.proposals.length, p1.total, p1.next], [2, 5, 2]);
      const p3 = await get("?limit=2&offset=4");
      assert.deepEqual([p3.proposals.map((p) => p.id), p3.next], [[ids[0]], undefined]);
      for (const bad of ["limit=0", "limit=501", "limit=x", "limit=1.5", "offset=-1", "offset=x"]) assert.equal((await strut.app.request(`/proposals?${bad}`)).status, 400, bad);
      assert.equal((await strut.app.request("/proposals?status=odd")).status, 400);
      // cached for a minute, yet a decision shows at once
      assert.equal((await get("?status=pending")).total, 5);
      const res = await strut.app.request(`/proposals/${ids[0]}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }) });
      assert.equal(res.status, 200);
      assert.equal((await get("?status=pending")).total, 4);
      assert.equal((await get("?status=rejected")).total, 1);
      assert.equal(((await (await strut.app.request(`/proposals/${ids[1]}`)).json()) as Proposal).input && true, true);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
