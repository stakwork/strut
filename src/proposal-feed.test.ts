import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createProposalFeed, type ProposalChangesRead } from "./proposal-feed.js";
import type { Proposal, ProposalsCapability } from "./proposals.js";
import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep } from "./core.js";
import { personToken } from "./auth.js";

const prop = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id,
  step: "graph/create-node",
  input: { secret: "TOP-SECRET-INPUT" },
  rationale: "TOP-SECRET-RATIONALE",
  title: "Create a node",
  status: "pending",
  createdAt: new Date().toISOString(),
  by: { workflow: "w", runId: "r", path: "w/a", actor: "ann", session: "ann/chat" },
  ...over,
});
const full = { scope: "full" as const };

test("events come in order, one per event", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  const p = prop("a");
  f.push(p);
  f.push({ ...p, status: "accepted", decision: { action: "accept", by: "ann", at: "t" } });
  f.push({ ...p, status: "applied", decision: { action: "accept", by: "ann", at: "t" } });
  const r = await f.read(full);
  assert.deepEqual(r.events.map((e) => [e.event, e.status]), [["created", "pending"], ["decided", "accepted"], ["applied", "applied"]]);
  assert.equal(r.events[0]!.kind, "step");
  assert.equal(r.events[0]!.actor, "ann");
});

test("a cursor resumes after what was read", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push(prop("a"));
  const first = await f.read(full);
  f.push(prop("a", { status: "failed" }));
  const next = await f.read({ ...full, cursor: first.cursor });
  assert.deepEqual(next.events.map((e) => e.event), ["failed"]);
  assert.equal((await f.read({ ...full, cursor: "now" })).events.length, 0);
});

test("wait returns early on an event", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  const t = Date.now();
  const pending = f.read({ ...full, cursor: "now", wait: 5000 });
  setTimeout(() => f.push(prop("b", { step: "mcp/s/t" })), 20);
  const r = await pending;
  assert.ok(Date.now() - t < 2000);
  assert.equal(r.events[0]!.kind, "tool");
});

test("the buffer wraps and a stale cursor resets", async () => {
  const f = createProposalFeed({ max: 3, gatherMs: 5 });
  f.push(prop("a"));
  const old = (await f.read(full)).cursor;
  for (const id of ["b", "c", "d", "e"]) f.push(prop(id));
  const r = await f.read({ ...full, cursor: old });
  assert.equal(r.reset, true);
  assert.deepEqual(r.events.map((e) => e.id), ["c", "d", "e"]);
});

test("events never carry the input, rationale or a long title whole", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push(prop("a", { title: "x".repeat(500), summary: "y".repeat(500) }));
  const r = await f.read(full);
  const json = JSON.stringify(r);
  assert.ok(!json.includes("TOP-SECRET"));
  assert.ok(r.events[0]!.title.length <= 200 && r.events[0]!.summary!.length <= 200);
  assert.deepEqual(Object.keys(r.events[0]!).sort(), ["actor", "at", "event", "id", "kind", "status", "summary", "title"]);
});

test("a person token sees only its own threads' events", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push(prop("mine"));
  f.push(prop("theirs", { by: { workflow: "w", runId: "r", path: "p", actor: "bob", session: "bob/chat" } }));
  f.push(prop("hive", { by: { workflow: "w", runId: "r", path: "p", actor: "ann", session: "hive-chat" } }));
  const ann = await f.read({ scope: "peer:person", actor: "ann" });
  assert.deepEqual(ann.events.map((e) => e.id), ["mine"]);
  assert.equal((await f.read({ scope: "peer", actor: "ann" })).events.length, 0);
  assert.equal((await f.read(full)).events.length, 3);
});

test("a rejection is a decided event", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push(prop("a", { status: "rejected", decision: { action: "reject", by: "bob", at: "t" } }));
  const [e] = (await f.read(full)).events;
  assert.deepEqual([e!.event, e!.status, e!.actor], ["decided", "rejected", "bob"]);
});

test("GET /proposals/changes: what the server's proposals did, scoped like the list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "strut-proposal-feed-"));
  const KEYS = ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env["STRUT_API_KEY"] = "api";
  process.env["STRUT_PEER_KEY"] = "peer";
  const write = defineStep({ type: "dev/write", description: "Write a thing.", input: z.object({ name: z.string() }), output: z.any(), run: async (cfg) => ({ wrote: cfg.name }) });
  const strut = await createStrut({
    workspace: new WorkspaceManager(join(dir, "ws")),
    dataDir: dir,
    registry: await createRegistry([write]),
    store: new MemoryRunStore(),
    serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, job: false, orchestrator: false, builder: false,
  });
  try {
    const bag = strut.services as unknown as { proposals: ProposalsCapability };
    const mk = (actor: string) => bag.proposals.propose({ step: "dev/write", input: { name: actor }, title: "Write.", by: { workflow: "wf", runId: "r1", path: "wf/t", actor, session: `${actor}/c1` } });
    const ann = await mk("ann");
    await mk("bob");
    const req = (path: string, bearer: string, body?: unknown) =>
      strut.app.request(path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-strut-actor": "ann" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await req(`/proposals/${ann.id}/decide`, "api", { action: "accept" })).status, 200);
    const read = async (bearer: string, q = "") => {
      const res = await req(`/proposals/changes${q}`, bearer);
      assert.equal(res.status, 200);
      return (await res.json()) as ProposalChangesRead;
    };
    // The deployment key reads every event; "changes" is never taken for an id.
    const all = await read("api");
    assert.deepEqual(all.events.map((e) => e.event), ["created", "created", "decided", "applied"]);
    // A person token reads its own threads' events; the plain peer key none.
    assert.deepEqual((await read(personToken("ann")!.token)).events.map((e) => [e.id, e.event]), [[ann.id, "created"], [ann.id, "decided"], [ann.id, "applied"]]);
    assert.equal((await read("peer")).events.length, 0);
    // The cursor it hands back reads nothing new.
    assert.equal((await read("api", `?cursor=${encodeURIComponent(all.cursor)}`)).events.length, 0);
  } finally {
    await strut.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
});
