/**
 * Memory facts' checks (`memory-verify.ts`) on a Ladybug file, with a check
 * runner standing in for strut's: a check that finds the expected activity
 * backs a fact nobody restated; it is not run again until it is due; a
 * quiet one makes the fact stale, and the pass opens one question on it,
 * once; the user's answer closes it; a check that cannot see its source, or
 * fails, keeps nothing.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { testBackends } from "./test-util.js";
import { verifyFacts, type FactCheckInput, type RunCheck } from "./memory-verify.js";
import assertStep from "../steps/lib/graph/assert.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import verifyStep from "../steps/lib/graph/verify-facts.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const DAY = 86_400_000;
type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const run = (step: Step, cfg: Record<string, unknown>, b: LadybugBackend, extra: Record<string, unknown> = {}): Promise<any> =>
  step.run(step.input.parse(cfg), { runId: "r-1", path: "chat/s", workflow: "chat", scope: {}, input: undefined, emit: async () => {}, services: { graph: b }, actor: "tom", ...extra });

describe("memory facts' checks on a ladybug file", { skip: lb.skip }, () => {
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
    // Said once, two years ago: decay alone would say ask by now.
    await run(assertStep, {
      source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: stakwork, text: "Tom works at Stakwork", create_schema_if_missing: true, cardinality: "one",
      volatility: "volatile", expects: { step: "test/activity", every_days: 7, window_days: 30 }, observed_at: new Date(Date.now() - 730 * DAY).toISOString(),
    }, b);
  });
  const fact = async () => (await run(graphSearch, { q: "Tom works at Stakwork", facts: true }, b)).facts[0];
  const runner = (output: unknown, seen: FactCheckInput[] = []): RunCheck => async (step, input) => {
    assert.equal(step, "test/activity");
    seen.push(input);
    return { status: "success", output };
  };

  it("a check that finds the expected activity backs a fact nobody restated, and is not run again until due", async () => {
    assert.equal((await fact()).stance, "ask", "two years quiet");
    const seen: FactCheckInput[] = [];
    const now = Date.now();
    const report = await verifyFacts(b, runner({ supports: true, content: "14 PRs in 30 days" }, seen), { now });
    assert.deepEqual([report.checked, report.supported], [1, 1]);
    assert.deepEqual([seen[0]!.subject.name, seen[0]!.target.name, seen[0]!.window_days], ["Tom", "Stakwork", 30]);
    const f = await fact();
    assert.deepEqual([f.status, f.stance], ["supported", "state"]);
    assert.ok(f.evidence.sayers.some((x: { kind: string; name?: string }) => x.kind === "check" && x.name === "test/activity"));
    assert.equal((await verifyFacts(b, runner({ supports: true }), { now: now + DAY })).checked, 0, "not due for a week");
  });

  it("a quiet check makes it stale; the pass opens one question, once; the user's answer closes it", async () => {
    const now = Date.now();
    await verifyFacts(b, runner({ supports: true }), { now: now - 8 * DAY });
    const quiet = await verifyFacts(b, runner({ supports: false, content: "No activity in 30 days" }), { now });
    assert.equal(quiet.quiet, 1);
    assert.ok(quiet.asked >= 1, "asked about once the check went quiet");
    let f = await fact();
    assert.deepEqual([f.status, f.stance, f.open_check], ["stale", "ask", true]);
    assert.equal((await verifyFacts(b, runner({ supports: false }), { now: now + DAY })).asked, 0, "not asked twice");
    // The user: "yes, still there".
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: stakwork, text: "Tom works at Stakwork", source: "msg-yes" }, b);
    f = await fact();
    assert.equal(f.open_check, undefined, "answered");
  });

  it("a check that cannot see its source, or fails, keeps nothing", async () => {
    const count = async () => Number((await b.query(`MATCH (n:Node {node_type: 'Evidence'}) WHERE n.evidence_mode = 'observed' RETURN count(n) AS c`))[0]!["c"]);
    assert.equal((await verifyFacts(b, runner({ unavailable: true }))).unavailable, 1);
    assert.equal((await verifyFacts(b, async () => ({ status: "error" }))).failed, 1);
    assert.equal((await verifyFacts(b, runner({ nonsense: 1 }))).failed, 1);
    assert.equal(await count(), 0);
  });

  it("graph/verify-facts runs the pass through the step runner, and names a check that is not a step", async () => {
    const out = await run(verifyStep, {}, b, { registry: {} });
    assert.deepEqual([out.checked, out.failed], [1, 1], "test/activity is not in the registry: failed, nothing kept");
  });
});
