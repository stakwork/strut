/**
 * Checks for memory facts (`memory-checks.ts`, plans/memory-checks.md) on a
 * Ladybug file. `graph/assert` makes a kind of fact's Check the first time
 * it is given. A check that finds the evidence backs a fact nobody restated,
 * as `observed` evidence `PRODUCED_BY` the Check, and is not run again until
 * its freshness runs out; a quiet one makes the fact stale; one that cannot
 * see its source, or fails, keeps nothing. A read whose stance is ask opens
 * one question, once, and the answer closes it. Through the steps, the chat
 * check runs a stand-in chat search through strut's own runner.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { testBackends } from "./test-util.js";
import { queueFactChecks, verifyFacts, type ReadFact, type RunStep } from "./memory-checks.js";
import { defineStep } from "../core.js";
import { z } from "zod";
import assertStep from "../steps/lib/graph/assert.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import verifyStep from "../steps/lib/graph/verify-facts.js";
import checkChats from "../steps/lib/graph/check-chats.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const DAY = 86_400_000;
type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const ctxOf = (b: LadybugBackend, extra: Record<string, unknown> = {}) => ({ runId: "r-1", path: "chat/s", workflow: "chat", scope: {}, input: undefined, emit: async () => {}, services: { graph: b }, actor: "tom", ...extra });
const run = (step: Step, cfg: Record<string, unknown>, b: LadybugBackend, extra: Record<string, unknown> = {}): Promise<any> => step.run(step.input.parse(cfg), ctxOf(b, extra));

describe("checks for memory facts on a ladybug file", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let tom: string, stakwork: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    await createNodeSchema(b, b.schemas, { type: "Organization", attributes: {}, role: "entity" });
    const [t, s] = await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom", is_owner: true } },
      { type: "Organization", data: { name: "Stakwork" } },
    ]);
    [tom, stakwork] = [t!.ref_id, s!.ref_id];
    // Said once, two years ago, on a fast-changing kind of fact: decay alone says ask.
    await run(assertStep, {
      source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: stakwork, text: "Tom works at Stakwork", create_schema_if_missing: true, cardinality: "one",
      volatility: "volatile", check: { expects: "the organisation comes up in chats", step: "test/check", freshness_days: 7 }, observed_at: new Date(Date.now() - 730 * DAY).toISOString(),
    }, b);
  });
  const fact = async () => (await run(graphSearch, { q: "Tom works at Stakwork", facts: true }, b)).facts[0];
  const runner = (output: unknown): RunStep => async (step) => {
    assert.equal(step, "test/check");
    return { status: "success", output };
  };
  const readFact = async (): Promise<ReadFact> => {
    const f = (await b.reader.search({ q: "Tom works at Stakwork", trust: true })).facts![0]!;
    return { ref_id: f.ref_id, edge_type: f.edge_type, text: f.text, trust: f.trust!, subject: { ref_id: tom, name: "Tom" }, target: { ref_id: stakwork, name: "Stakwork" } };
  };

  it("a kind of fact's Check is made the first time it is given, and never changed", async () => {
    const rows = async () => b.query(`MATCH (k:Node {node_type: 'Check'}) RETURN k.description AS d, k.step_type AS s, k.freshness_days AS f`);
    assert.deepEqual((await rows()).map((r) => [r["d"], r["s"], Number(r["f"])]), [["the organisation comes up in chats", "test/check", 7]]);
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: stakwork, text: "Tom works at Stakwork", check: { expects: "something else" } }, b);
    assert.equal((await rows()).length, 1);
    assert.equal((await rows())[0]!["d"], "the organisation comes up in chats");
  });

  it("a check that finds the evidence backs a fact nobody restated, and is not run again until due", async () => {
    assert.equal((await fact()).stance, "ask");
    const now = Date.now();
    const report = await verifyFacts(b, runner({ supports: true, content: "12 messages mention Stakwork" }), { now });
    assert.deepEqual([report.checked, report.supported], [1, 1]);
    const f = await fact();
    assert.deepEqual([f.status, f.stance], ["supported", "state"]);
    assert.ok(f.evidence.sayers.some((x: { kind: string; name?: string }) => x.kind === "check" && x.name === "test/check"));
    const produced = await b.query(`MATCH (e:Node {node_type: 'Evidence'})-[:PRODUCED_BY]->(k:Node {node_type: 'Check'}) RETURN e.evidence_mode AS m, e.content AS c`);
    assert.deepEqual(produced.map((r) => [r["m"], r["c"]]), [["observed", "12 messages mention Stakwork"]]);
    assert.equal((await verifyFacts(b, runner({ supports: true }), { now: now + DAY })).checked, 0, "fresh for a week");
    assert.equal((await verifyFacts(b, runner({ supports: true }), { now: now + 8 * DAY })).checked, 1, "due again");
  });

  it("a quiet check makes it stale; one that cannot see its source, or fails, keeps nothing", async () => {
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: stakwork, text: "Tom works at Stakwork", source: "msg-today" }, b);
    await verifyFacts(b, runner({ supports: false, content: "No messages mention Stakwork" }), { force: true });
    assert.deepEqual([(await fact()).status, (await fact()).stance], ["stale", "cite"]);
    const observed = async () => Number((await b.query(`MATCH (n:Node {node_type: 'Evidence'}) WHERE n.evidence_mode = 'observed' RETURN count(n) AS c`))[0]!["c"]);
    const before = await observed();
    assert.equal((await verifyFacts(b, runner({ unavailable: true }), { force: true })).unavailable, 1);
    assert.equal((await verifyFacts(b, async () => ({ status: "error" }), { force: true })).failed, 1);
    assert.equal((await verifyFacts(b, runner({ nonsense: 1 }), { force: true })).failed, 1);
    assert.equal(await observed(), before);
  });

  it("a read whose stance is ask opens one question, once, and the answer closes it", async () => {
    const first = await queueFactChecks(b, [await readFact()], undefined);
    assert.equal(first.asked, 1);
    assert.equal((await fact()).open_check, true);
    assert.equal((await queueFactChecks(b, [await readFact()], undefined)).asked, 0, "not asked twice");
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: stakwork, text: "Tom works at Stakwork", source: "msg-yes" }, b);
    const f = await fact();
    assert.deepEqual([f.open_check, f.stance], [undefined, "state"], "answered");
  });

  it("a read runs the due check after it answers, through the check runner", async () => {
    const report = await queueFactChecks(b, [await readFact()], runner({ supports: true }));
    assert.equal(report.supported, 1);
    assert.equal((await fact()).stance, "state");
  });

  it("through the steps: graph/verify-facts runs the chat check, which runs the chat search through strut's runner", async () => {
    await b.query(`MATCH (k:Node {node_type: 'Check'}) SET k.step_type = 'graph/check-chats'`);
    let asked = "";
    const search = defineStep({
      type: "sphinx/search",
      input: z.object({ q: z.string(), limit: z.number().optional() }),
      output: z.any(),
      async run(cfg) {
        asked = cfg.q;
        return `1 message matches '${cfg.q}', newest first:\n== Tribe 'Dev team' (chat=02t) ==\n[Sam] ${new Date().toISOString()} (uuid=a): Stakwork standup`;
      },
    });
    const registry = { "graph/check-chats": checkChats, "sphinx/search": search } as never;
    const out = await run(verifyStep, {}, b, { registry });
    assert.deepEqual([out.checked, out.supported], [1, 1], JSON.stringify(out));
    assert.equal(asked, "Stakwork", "the user's own fact: no from:");
    assert.equal((await fact()).stance, "state");
    // Without a chat search here (a server strut, say): unavailable, nothing kept.
    const none = await run(verifyStep, { force: true }, b, { registry: { "graph/check-chats": checkChats } as never });
    assert.equal(none.unavailable, 1);
  });
});
