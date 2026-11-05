import { test } from "node:test";
import assert from "node:assert/strict";
import { createProposalFeed } from "./proposal-feed.js";
import type { Proposal } from "./proposals.js";

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
  f.push("created", p);
  f.push("decided", { ...p, status: "accepted", decision: { action: "accept", by: "ann", at: "t" } });
  f.push("applied", { ...p, status: "applied", decision: { action: "accept", by: "ann", at: "t" } });
  const r = await f.read(full);
  assert.deepEqual(r.events.map((e) => [e.event, e.status]), [["created", "pending"], ["decided", "accepted"], ["applied", "applied"]]);
  assert.equal(r.events[0]!.kind, "step");
  assert.equal(r.events[0]!.actor, "ann");
});

test("a cursor resumes after what was read", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push("created", prop("a"));
  const first = await f.read(full);
  f.push("failed", prop("a", { status: "failed" }));
  const next = await f.read({ ...full, cursor: first.cursor });
  assert.deepEqual(next.events.map((e) => e.event), ["failed"]);
  assert.equal((await f.read({ ...full, cursor: "now" })).events.length, 0);
});

test("wait returns early on an event", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  const t = Date.now();
  const pending = f.read({ ...full, cursor: "now", wait: 5000 });
  setTimeout(() => f.push("created", prop("b", { step: "mcp/s/t" })), 20);
  const r = await pending;
  assert.ok(Date.now() - t < 2000);
  assert.equal(r.events[0]!.kind, "tool");
});

test("the buffer wraps and a stale cursor resets", async () => {
  const f = createProposalFeed({ max: 3, gatherMs: 5 });
  f.push("created", prop("a"));
  const old = (await f.read(full)).cursor;
  for (const id of ["b", "c", "d", "e"]) f.push("created", prop(id));
  const r = await f.read({ ...full, cursor: old });
  assert.equal(r.reset, true);
  assert.deepEqual(r.events.map((e) => e.id), ["c", "d", "e"]);
});

test("events never carry the input, rationale or a long title whole", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push("created", prop("a", { title: "x".repeat(500), summary: "y".repeat(500) }));
  const r = await f.read(full);
  const json = JSON.stringify(r);
  assert.ok(!json.includes("TOP-SECRET"));
  assert.ok(r.events[0]!.title.length <= 200 && r.events[0]!.summary!.length <= 200);
  assert.deepEqual(Object.keys(r.events[0]!).sort(), ["actor", "at", "event", "id", "kind", "status", "summary", "title"]);
});

test("a person token sees only its own threads' events", async () => {
  const f = createProposalFeed({ gatherMs: 5 });
  f.push("created", prop("mine"));
  f.push("created", prop("theirs", { by: { workflow: "w", runId: "r", path: "p", actor: "bob", session: "bob/chat" } }));
  f.push("created", prop("hive", { by: { workflow: "w", runId: "r", path: "p", actor: "ann", session: "hive-chat" } }));
  const ann = await f.read({ scope: "peer:person", actor: "ann" });
  assert.deepEqual(ann.events.map((e) => e.id), ["mine"]);
  assert.equal((await f.read({ scope: "peer", actor: "ann" })).events.length, 0);
  assert.equal((await f.read(full)).events.length, 3);
});
