import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRegistry } from "./steps/registry.js";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep, type RunEvent, type StepContext } from "./core.js";
import { buildRegistryTools } from "./steps/core/agent.js";
import {
  GATE_NOTE,
  PROPOSAL_RESULT_PREFIX,
  decideProposal,
  listProposals,
  proposalResultLines,
  proposalsCapability,
  proposalsRoot,
  readProposal,
  type Proposal,
} from "./proposals.js";
import { personToken } from "./auth.js";
import type { JobUpdateInput } from "./jobs.js";

// Proposals (plans/proposals.md): the gate on an agent's tool, the record,
// the decision that applies the step in code, what the thread is told.

/** A step that writes something: what the gate holds back. */
let calls: Array<{ cfg: unknown; ctx: StepContext }> = [];
let failNext = false;
const write = defineStep({
  type: "dev/write",
  description: "Write a thing to the store. More words about how.",
  input: z.object({ name: z.string(), n: z.number().int().default(1) }),
  output: z.any(),
  async run(cfg, ctx) {
    calls.push({ cfg, ctx });
    if (failNext) {
      failNext = false;
      throw new Error("the store is away");
    }
    return { wrote: cfg.name, n: cfg.n };
  },
});
const registry = { "dev/write": write };

describe("proposals", () => {
  let dir = "";
  let updates: Array<{ job: string; update: JobUpdateInput }> = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-proposals-"));
    calls = [];
    updates = [];
    failNext = false;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const cap = () => proposalsCapability(dir, { notify: (job, update) => updates.push({ job, update }) });
  const root = () => proposalsRoot(dir);

  /** The agent's tool ctx: the run, the job, the journal slice. */
  const ctx = (extra: Partial<StepContext> = {}, events: RunEvent[] = []): StepContext => ({
    runId: "r1",
    path: "wf/turn",
    scope: {},
    input: undefined,
    emit: async (e) => void events.push(e),
    services: { proposals: cap() },
    registry,
    job: "j1",
    actor: "ann",
    principal: "ann",
    ...extra,
  });
  type Tool = { description: string; inputSchema: z.ZodTypeAny; execute: (input: unknown, o?: { strutToolPath?: string }) => Promise<unknown> };
  const gated = (c: StepContext) =>
    buildRegistryTools(["dev/write"], registry, c, (d: unknown) => d, { approve: new Set(["dev/write"]), session: "s1" })["dev_write"] as Tool;

  it("a gated tool records a proposal instead of running the step, journals the call, tells the job", async () => {
    const events: RunEvent[] = [];
    const tool = gated(ctx({}, events));
    assert.ok(tool.description.endsWith(GATE_NOTE));
    assert.ok("rationale" in (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape);

    const out = (await tool.execute({ name: "x", rationale: "because" }, { strutToolPath: "wf/turn/001-dev_write" })) as Record<string, unknown>;
    assert.equal(out["status"], "pending");
    assert.equal(out["step"], "dev/write");
    assert.equal(out["url"], `/proposals/${out["proposal"]}`);
    assert.deepEqual(calls, [], "the step did not run");

    const rec = (await readProposal(root(), out["proposal"] as string))!;
    assert.deepEqual(rec.input, { name: "x", n: 1 }, "the step's schema parsed it; rationale is not in the input");
    assert.equal(rec.rationale, "because");
    assert.equal(rec.title, "Write a thing to the store.");
    assert.deepEqual(rec.by, { workflow: "wf", runId: "r1", path: "wf/turn/001-dev_write", job: "j1", session: "s1", actor: "ann", principal: "ann" });
    assert.deepEqual(events.map((e) => [e.type, e.path, e.output]), [["step.end", "wf/turn#001-dev_write", { proposal: rec.id }]]);
    assert.deepEqual(updates.map((u) => [u.job, u.update.kind, u.update.state, u.update.url]), [["j1", "proposal", "pending", `/proposals/${rec.id}`]]);
  });

  it("records the run's workflow, slashes included — not the path's first segment", async () => {
    const tool = gated(ctx({ runId: "r7", path: "acme/linear/sync/turn", workflow: "acme/linear/sync" }));
    const out = (await tool.execute({ name: "x" }, { strutToolPath: "acme/linear/sync/turn/001-dev_write" })) as Record<string, unknown>;
    const rec = (await readProposal(root(), out["proposal"] as string))!;
    assert.equal(rec.by.workflow, "acme/linear/sync");
    assert.equal(rec.by.path, "acme/linear/sync/turn/001-dev_write");
  });

  it("proposals made in one millisecond — an agent's parallel calls — list in the order they were made", async () => {
    const made = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        cap().propose({ step: "dev/write", input: { name: `n${i}`, n: 1 }, title: "Write a thing.", by: { workflow: "wf", runId: "r1", path: `wf/turn/${i}`, session: "s1" } }),
      ),
    );
    const listed = await listProposals(root(), { session: "s1" });
    assert.deepEqual(listed.map((p) => p.id), made.map((p) => p.id).reverse(), "newest first");
    assert.ok(made.every((p, i) => i === 0 || p.createdAt > made[i - 1]!.createdAt), "each stamped after the one before");
  });

  it("a resumed turn making the same call gets the proposal it made; a bad input is refused before any record", async () => {
    const first = (await gated(ctx()).execute({ name: "x" }, { strutToolPath: "wf/turn/001-dev_write" })) as { proposal: string };
    const again = (await gated(ctx({ journal: { "wf/turn#001-dev_write": { proposal: first.proposal } } })).execute({ name: "x" }, { strutToolPath: "wf/turn/001-dev_write" })) as { proposal: string };
    assert.equal(again.proposal, first.proposal);
    assert.equal((await listProposals(root())).length, 1);

    const bad = await gated(ctx()).execute({ name: 7 }, { strutToolPath: "wf/turn/002-dev_write" });
    assert.match(String(bad), /^Error: invalid input for "dev\/write"/);
    assert.equal((await listProposals(root())).length, 1);
  });

  describe("deciding", () => {
    let p: Proposal;
    beforeEach(async () => {
      p = await cap().propose({ step: "dev/write", input: { name: "x", n: 1 }, title: "Write a thing.", by: { workflow: "wf", runId: "r1", path: "wf/turn/001-dev_write", job: "j1", session: "s1", principal: "ann" } });
      updates = [];
    });
    const deps = () => ({ registry, services: { secrets: { get: async () => undefined, forPrincipal: (who: string) => ({ get: async () => `secret-of-${who}` }) } }, notify: (job: string, update: JobUpdateInput) => updates.push({ job, update }) });

    it("accept runs the step then and there, the decider as actor, the proposer's principal binding its secrets", async () => {
      const out = await decideProposal(root(), p.id, { action: "accept", by: "bob" }, deps());
      assert.equal(out.status, 200);
      const rec = out.body as Proposal;
      assert.equal(rec.status, "applied");
      assert.deepEqual(rec.result?.output, { wrote: "x", n: 1 });
      assert.equal(rec.decision?.by, "bob");
      assert.equal(calls.length, 1);
      const c = calls[0]!.ctx;
      assert.equal(c.actor, "bob");
      assert.equal(c.principal, "ann");
      assert.equal(c.job, "j1");
      assert.equal(c.runId, `proposal:${p.id}`);
      assert.equal(await (c.services as { secrets: { get: (n: string) => Promise<string> } }).secrets.get("X"), "secret-of-ann");
      assert.deepEqual(updates.map((u) => u.update.state), ["accepted", "applied"]);

      const twice = await decideProposal(root(), p.id, { action: "accept" }, deps());
      assert.equal(twice.status, 409);
      assert.equal(calls.length, 1, "a decided proposal is never applied twice");
    });

    it("edits are merged and re-validated by the step's schema; a bad edit leaves it pending", async () => {
      const bad = await decideProposal(root(), p.id, { action: "accept", input: { n: "many" } }, deps());
      assert.equal(bad.status, 400);
      assert.equal((await readProposal(root(), p.id))!.status, "pending");
      assert.equal(calls.length, 0);

      const ok = await decideProposal(root(), p.id, { action: "accept", input: { n: 5 } }, deps());
      assert.equal((ok.body as Proposal).status, "applied");
      assert.deepEqual(calls[0]!.cfg, { name: "x", n: 5 });
      assert.deepEqual((ok.body as Proposal).decision?.input, { n: 5 });
    });

    it("reject runs nothing and keeps the reason; a rejected proposal is final", async () => {
      const out = await decideProposal(root(), p.id, { action: "reject", reason: "not that one", by: "bob" }, deps());
      assert.equal((out.body as Proposal).status, "rejected");
      assert.equal((out.body as Proposal).decision?.reason, "not that one");
      assert.equal(calls.length, 0);
      assert.equal((await decideProposal(root(), p.id, { action: "accept" }, deps())).status, 409);
      assert.equal((await decideProposal(root(), p.id, { action: "reject" }, deps())).status, 409);
    });

    it("a failed apply keeps the decision and may be accepted again; an unknown step cannot be applied", async () => {
      failNext = true;
      const failed = await decideProposal(root(), p.id, { action: "accept" }, deps());
      assert.equal((failed.body as Proposal).status, "failed");
      assert.equal((failed.body as Proposal).result?.error, "the store is away");
      const retried = await decideProposal(root(), p.id, { action: "accept" }, deps());
      assert.equal((retried.body as Proposal).status, "applied");
      assert.equal(calls.length, 2);

      const other = await cap().propose({ step: "dev/gone", input: {}, title: "Gone.", by: { workflow: "wf", runId: "r1", path: "wf/turn/002-dev_gone" } });
      const no = await decideProposal(root(), other.id, { action: "accept" }, deps());
      assert.equal(no.status, 400);
      assert.equal((await readProposal(root(), other.id))!.status, "pending");
      assert.equal((await decideProposal(root(), "nope-nope-nope", { action: "accept" }, deps())).status, 404);
    });

    it("the thread is told once: the decided proposals it has not seen, as lines, then marked", async () => {
      await decideProposal(root(), p.id, { action: "reject", reason: "later" }, deps());
      const q = await cap().propose({ step: "dev/write", input: { name: "y", n: 1 }, title: "Write a thing.", by: { workflow: "wf", runId: "r2", path: "wf/turn/001-dev_write", session: "s1" } });
      await decideProposal(root(), q.id, { action: "accept" }, deps());
      const elsewhere = await cap().propose({ step: "dev/write", input: { name: "z", n: 1 }, title: "Write a thing.", by: { workflow: "wf", runId: "r3", path: "wf/turn/001-dev_write", session: "s2" } });
      await decideProposal(root(), elsewhere.id, { action: "accept" }, deps());

      const told = await cap().unreported("s1");
      assert.deepEqual(told.map((t) => t.id), [p.id, q.id], "oldest first, this thread's only");
      assert.deepEqual(proposalResultLines(told), [
        `${PROPOSAL_RESULT_PREFIX} ${p.id} rejected · dev/write "Write a thing." · "later"`,
        `${PROPOSAL_RESULT_PREFIX} ${q.id} applied · dev/write "Write a thing."`,
      ]);
      await cap().markReported(told.map((t) => t.id));
      assert.deepEqual(await cap().unreported("s1"), []);
      assert.equal((await cap().unreported("s2")).length, 1);
      assert.equal((await listProposals(root(), { status: "pending" })).length, 0);
    });
  });

  describe("over HTTP", () => {
    let strut: Strut;
    let saved: string | undefined;
    beforeEach(async () => {
      saved = process.env["STRUT_API_KEY"];
      delete process.env["STRUT_API_KEY"];
      strut = await createStrut({
        workspace: new WorkspaceManager(join(dir, "ws")),
        dataDir: dir,
        registry: await createRegistry([write]),
        store: new MemoryRunStore(),
        serveUi: false,
        enableChat: false,
        scheduler: false,
        systemWorkflows: false,
        job: false,
        orchestrator: false, builder: false,
      });
    });
    afterEach(async () => {
      await strut?.close();
      if (saved === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = saved;
    });

    it("lists, reads, lists by run, and decides", async () => {
      const bag = strut.services as unknown as { proposals: ReturnType<typeof proposalsCapability> };
      const p = await bag.proposals.propose({ step: "dev/write", input: { name: "x", n: 2 }, title: "Write a thing.", by: { workflow: "wf", runId: "r9", path: "wf/turn/001-dev_write" } });

      const list = (await (await strut.app.request("/proposals?status=pending")).json()) as { proposals: Proposal[] };
      assert.deepEqual(list.proposals.map((q) => q.id), [p.id]);
      assert.equal((await strut.app.request("/proposals?status=odd")).status, 400);
      assert.equal(((await (await strut.app.request(`/proposals/${p.id}`)).json()) as Proposal).step, "dev/write");
      assert.equal((await strut.app.request("/proposals/none-none-none")).status, 404);
      const ofRun = (await (await strut.app.request("/workflows/wf/runs/r9/proposals")).json()) as { proposals: Array<{ id: string; url: string }> };
      assert.deepEqual(ofRun.proposals.map((q) => [q.id, q.url]), [[p.id, `/proposals/${p.id}`]]);
      assert.deepEqual(((await (await strut.app.request("/workflows/other/runs/r9/proposals")).json()) as { proposals: unknown[] }).proposals, []);

      const decide = (body: unknown) =>
        strut.app.request(`/proposals/${p.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await decide({ action: "maybe" })).status, 400);
      assert.equal((await decide({ action: "accept", input: [1] })).status, 400);
      const res = await decide({ action: "accept", input: { n: 3 } });
      assert.equal(res.status, 200);
      const rec = (await res.json()) as Proposal;
      assert.equal(rec.status, "applied");
      assert.deepEqual(rec.result?.output, { wrote: "x", n: 3 });
      assert.equal((await decide({ action: "reject" })).status, 409);
      assert.deepEqual(await readdir(proposalsRoot(dir)), [`${p.id}.json`]);
    });
  });

  describe("who may decide (person tokens)", () => {
    const saved: Record<string, string | undefined> = {};
    let strut: Strut;
    let ids: { ann: string; bob: string };
    const KEYS = ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"];
    const boot = async (extra: Record<string, unknown> = {}) => {
      for (const k of KEYS) saved[k] = process.env[k];
      process.env["STRUT_API_KEY"] = "api";
      process.env["STRUT_PEER_KEY"] = "peer";
      strut = await createStrut({
        workspace: new WorkspaceManager(join(dir, "ws")),
        dataDir: dir,
        registry: await createRegistry([write]),
        store: new MemoryRunStore(),
        serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, job: false, orchestrator: false, builder: false,
        ...extra,
      });
      const bag = strut.services as unknown as { proposals: ReturnType<typeof proposalsCapability> };
      const mk = (actor?: string) =>
        bag.proposals.propose({ step: "dev/write", input: { name: actor ?? "none" }, title: "Write.", by: { workflow: "wf", runId: "r1", path: "wf/t", ...(actor ? { actor } : {}) } });
      ids = { ann: (await mk("ann")).id, bob: (await mk("bob")).id };
    };
    afterEach(async () => {
      await strut?.close();
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    const req = (path: string, bearer: string, o: { actor?: string; body?: unknown } = {}) =>
      strut.app.request(path, {
        method: o.body ? "POST" : "GET",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(o.actor ? { "x-strut-actor": o.actor } : {}) },
        ...(o.body ? { body: JSON.stringify(o.body) } : {}),
      });
    const decide = (id: string, bearer: string, actor?: string) => req(`/proposals/${id}/decide`, bearer, { body: { action: "accept" }, ...(actor ? { actor } : {}) });
    const idsOf = async (path: string, bearer: string) => ((await (await req(path, bearer)).json()) as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id);

    it("a person token decides its own proposal only; repeats are 409; reads are its own", async () => {
      await boot();
      const ann = personToken("ann")!.token;
      const bob = personToken("bob")!.token;
      // (b) another person: 403, still pending
      const wrong = await decide(ids.ann, bob);
      assert.equal(wrong.status, 403);
      assert.ok(((await wrong.json()) as { error: string }).error);
      assert.equal((await readProposal(root(), ids.ann))!.status, "pending");
      // (a) the creator
      assert.equal((await decide(ids.ann, ann, "mallory")).status, 200);
      assert.equal((await readProposal(root(), ids.ann))!.decision?.by, "ann");
      // (c) repeat
      const again = await decide(ids.ann, ann);
      assert.equal(again.status, 409);
      assert.equal(((await again.json()) as { proposal: Proposal }).proposal.status, "applied");
      // (d) reads
      assert.deepEqual(await idsOf("/proposals", ann), [ids.ann]);
      assert.equal((await req(`/proposals/${ids.bob}`, ann)).status, 404);
      assert.equal((await req(`/proposals/${ids.ann}`, ann)).status, 200);
      assert.deepEqual(await idsOf("/workflows/wf/runs/r1/proposals", ann), [ids.ann]);
      assert.deepEqual((await idsOf("/proposals", "api")).sort(), [ids.ann, ids.bob].sort());
    });

    it("the plain peer key decides nothing and sees none; the full key is unchanged", async () => {
      await boot();
      // (e)
      assert.equal((await decide(ids.ann, "peer", "ann")).status, 403);
      assert.deepEqual(await idsOf("/proposals", "peer"), []);
      assert.equal((await req(`/proposals/${ids.ann}`, "peer", { actor: "ann" })).status, 404);
      assert.deepEqual(await idsOf("/workflows/wf/runs/r1/proposals", "peer"), []);
      assert.equal((await readProposal(root(), ids.ann))!.status, "pending");
      // (f) the deployment key, any actor
      assert.equal((await decide(ids.ann, "api", "someone-else")).status, 200);
      assert.equal((await decide(ids.bob, "api")).status, 200);
    });

    it("a proposal with no creator can be decided by no person token", async () => {
      await boot();
      const bag = strut.services as unknown as { proposals: ReturnType<typeof proposalsCapability> };
      const orphan = await bag.proposals.propose({ step: "dev/write", input: { name: "o" }, title: "W.", by: { workflow: "wf", runId: "r2", path: "p" } });
      assert.equal((await decide(orphan.id, personToken("ann")!.token)).status, 403);
    });

    it("a lab-style credential (host resolveScope + resolveActor, a `sub`) behaves the same", async () => {
      // (g) mcp maps a `lab:peer` JWT with a `sub` to peer:person + that actor.
      const lab = (c: { req: { header(n: string): string | undefined } }) => {
        const m = (c.req.header("authorization") ?? "").match(/^Bearer lab-jwt:(.+)$/);
        return m?.[1];
      };
      await boot({
        resolveScope: (c: any) => (lab(c) ? "peer:person" : undefined),
        resolveActor: (c: any) => lab(c),
      });
      delete process.env["STRUT_API_KEY"]; // the host's own gate vouches for the JWT
      delete process.env["STRUT_PEER_KEY"];
      assert.equal((await decide(ids.ann, "lab-jwt:bob")).status, 403);
      assert.equal((await readProposal(root(), ids.ann))!.status, "pending");
      assert.deepEqual(await idsOf("/proposals", "lab-jwt:ann"), [ids.ann]);
      assert.equal((await req(`/proposals/${ids.bob}`, "lab-jwt:ann")).status, 404);
      assert.equal((await decide(ids.ann, "lab-jwt:ann")).status, 200);
      assert.equal((await decide(ids.ann, "lab-jwt:ann")).status, 409);
    });
  });
});
