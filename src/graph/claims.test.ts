/**
 * The claims layer: `claimStatus()` over every branch (pure), then the node
 * contract + read helpers against a live Neo4j seeded from the bundled
 * ontology fixture (Claim / Check / Evidence are jarvis types, resolved
 * from the `:Schema` meta-graph).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Bolt } from "./bolt.js";
import { seedStrutDomain } from "./schema-seed.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { SchemaResolver } from "./schema-resolver.js";
import { GraphValidationError, NodeWriter } from "./node-writer.js";
import { EdgeWriter } from "./edge-writer.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";
import {
  ClaimsReader,
  claimStatus,
  claimsReaderFor,
  evidenceId,
  isEpistemicId,
  isExternalCheck,
  newEpistemicId,
  type EvidenceRow,
  type SubjectRef,
} from "./claims.js";
import type { GraphBackend } from "./backend.js";

const cfg = testGraphConfig();

// ── claimStatus (pure) ──────────────────────────────────────────────────────

const STEP: SubjectRef = { kind: "step", type: "clip/compute-times" };
const V1 = "hash-v1";
const V2 = "hash-v2";
let seq = 0;

/** One collected, observed, supporting Evidence about V2 from check `k1` —
 *  override what the case is about. `at` is epoch seconds. */
function ev(over: Partial<EvidenceRow> & { at?: number; version?: string; run?: string } = {}): EvidenceRow {
  const { at, version, run, ...rest } = over;
  seq++;
  return {
    ref_id: `ref-${seq}`,
    id: `e${String(seq).padStart(4, "0")}`,
    name: "the claim",
    evidence_status: "collected",
    evidence_mode: "observed",
    observed_at: at ?? 1000 + seq,
    claim_id: "c1",
    strength: 1,
    check_id: "k1",
    about: { kind: "step", name: "clip/compute-times", content_hash: version ?? V2 },
    ...(run ? { source: { ref_id: `run-ref-${run}`, node_type: "StrutRun", run_id: run } } : {}),
    ...rest,
  };
}

const status = (evidence: EvidenceRow[], checks: Array<{ id: string; retired_at?: number }> = [{ id: "k1" }], activeVersion: string | null = V2) =>
  claimStatus({ claim: { id: "c1" }, checks, subject: STEP, evidence, activeVersion });

describe("claimStatus (pure)", () => {
  it("no evidence → unknown, every active check unverified, never assertedOnly", () => {
    const s = status([], [{ id: "k1" }, { id: "k2" }]);
    assert.deepEqual(s, { status: "unknown", assertedOnly: false, unverified: 2, openSlot: false, slots: [] });
  });

  it("latest evidence on the active version decides: supported / refuted", () => {
    assert.equal(status([ev()]).status, "supported");
    assert.equal(status([ev({ strength: -1 })]).status, "refuted");
    // Newest wins within one stream: a fix after a failure reads supported…
    const fixed = status([ev({ strength: -1, at: 10, run: "r1" }), ev({ at: 20, run: "r2" })]);
    assert.equal(fixed.status, "supported");
    assert.equal(fixed.unverified, 0);
    // …and a regression after a pass reads refuted.
    assert.equal(status([ev({ at: 10, run: "r1" }), ev({ strength: -1, at: 20, run: "r2" })]).status, "refuted");
  });

  it("stale once the version moves on; unknown subjects' active version never matches", () => {
    const s = status([ev({ version: V1 })]);
    assert.equal(s.status, "stale");
    assert.equal(s.unverified, 1, "no evidence ABOUT the active version");
    assert.equal(s.latest?.about?.content_hash, V1);
    assert.equal(status([ev()], [{ id: "k1" }], null).status, "stale");
  });

  it("a current refutation beats a current support from another check", () => {
    const s = status([ev({ check_id: "k1", at: 50 }), ev({ check_id: "k2", strength: -1, at: 10 })], [{ id: "k1" }, { id: "k2" }]);
    assert.equal(s.status, "refuted");
    assert.equal(s.latest?.check_id, "k2", "latest is the evidence carrying the verdict");
    // An OLD-version refutation does not: only the active version's count.
    const old = status([ev({ check_id: "k1" }), ev({ check_id: "k2", strength: -1, version: V1 })], [{ id: "k1" }, { id: "k2" }]);
    assert.equal(old.status, "supported");
    assert.equal(old.unverified, 1, "k2 has nothing about the active version");
  });

  it("one run is one measurement: a foreach's failing iteration is not papered over by a later passing one", () => {
    const s = status([
      ev({ at: 10, run: "r1", strength: -1, source: { ref_id: "x", run_id: "r1", context: { path: "wf/each[0]/clip" } } }),
      ev({ at: 11, run: "r1", source: { ref_id: "x", run_id: "r1", context: { path: "wf/each[1]/clip" } } }),
    ]);
    assert.equal(s.status, "refuted");
    // A NEWER run that passes everywhere supersedes the whole older run.
    assert.equal(status([ev({ at: 10, run: "r1", strength: -1 }), ev({ at: 11, run: "r1" }), ev({ at: 20, run: "r2" })]).status, "supported");
  });

  it("a retired check's evidence is ignored — a changed instrument has measured nothing yet", () => {
    const s = status([ev({ check_id: "k-old" })], [{ id: "k-old", retired_at: 5 }, { id: "k-new" }]);
    assert.equal(s.status, "unknown");
    assert.equal(s.unverified, 1);
    // A check that does not TEST this claim at all is no different.
    assert.equal(status([ev({ check_id: "stranger" })]).status, "unknown");
  });

  it("evidence no check produced is its own stream", () => {
    const s = status([ev({ check_id: undefined, evidence_mode: "asserted" })]);
    assert.equal(s.status, "supported");
    assert.equal(s.assertedOnly, true);
    assert.equal(s.unverified, 1, "k1 itself still has nothing");
  });

  it("assertedOnly reads the evidence carrying the verdict", () => {
    assert.equal(status([ev()]).assertedOnly, false);
    assert.equal(status([ev({ evidence_mode: "asserted" })]).assertedOnly, true);
    const mixed = status([ev({ check_id: "k1", evidence_mode: "asserted" }), ev({ check_id: "k2" })], [{ id: "k1" }, { id: "k2" }]);
    assert.equal(mixed.assertedOnly, false, "one observed support is enough");
    // An observed support on an OLD version does not vouch for an asserted current one.
    const old = status([ev({ check_id: "k1", evidence_mode: "asserted" }), ev({ check_id: "k2", version: V1 })], [{ id: "k1" }, { id: "k2" }]);
    assert.equal(old.status, "supported");
    assert.equal(old.assertedOnly, true);
  });

  it("planned slots are questions, not evidence — reported as openSlot, never counted", () => {
    const slot = ev({ check_id: "k-ext", evidence_status: "planned", strength: undefined, evidence_mode: undefined, observed_at: undefined, content: undefined });
    const s = status([slot], [{ id: "k-ext" }]);
    assert.equal(s.status, "unknown");
    assert.equal(s.openSlot, true);
    assert.deepEqual(s.slots, [{ evidence_id: slot.id, check_id: "k-ext" }]);
    assert.equal(s.unverified, 1);
    // Filled: the SAME node, now collected.
    const filled = status([{ ...slot, evidence_status: "collected", evidence_mode: "asserted", strength: 1, observed_at: 99 }], [{ id: "k-ext" }]);
    assert.deepEqual([filled.status, filled.assertedOnly, filled.openSlot, filled.unverified], ["supported", true, false, 0]);
    // Evidence with no recognised evidence_status is not counted either.
    assert.equal(status([ev({ evidence_status: undefined })]).status, "unknown");
    assert.equal(status([ev({ strength: 0 })]).status, "unknown");
  });

  it("is per (claim, subject): other subjects', other claims' and un-attributed evidence are ignored", () => {
    const elsewhere = ev({ about: { kind: "step", name: "clip/other", content_hash: V2 }, strength: -1 });
    const workflowSameName = ev({ about: { kind: "workflow", name: "clip/compute-times", content_hash: V2 }, strength: -1 });
    const predecessor = ev({ claim_id: "c0", strength: -1 });
    const unattributed = ev({ about: undefined, strength: -1 });
    assert.equal(status([elsewhere, workflowSameName, predecessor, unattributed]).status, "unknown");
    assert.equal(status([elsewhere, workflowSameName, predecessor, unattributed, ev()]).status, "supported");
  });

  it("orders by observed_at, then date_added_to_graph, then id — deterministically", () => {
    const a = ev({ observed_at: undefined, date_added_to_graph: 5_000, strength: -1, run: "r1" });
    const b = ev({ observed_at: 6, run: "r2" }); // 6s = 6000ms, newer than a
    assert.equal(status([a, b]).status, "supported");
    assert.equal(status([b, a]).status, "supported");
  });
});

describe("claim ids (pure)", () => {
  it("claim/check ids are lowercase alphanumeric, so node_key sanitizing cannot collide two", () => {
    const made = Array.from({ length: 500 }, () => newEpistemicId());
    const ids = new Set(made);
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^[a-z0-9]{32}$/);
    assert.deepEqual([...made].sort(), made, "time-sortable: id order is creation order, even within one millisecond");
    assert.ok(isEpistemicId("ab1") && !isEpistemicId("aB-1") && !isEpistemicId("") && !isEpistemicId(7));
  });

  it("Evidence.id is deterministic over (check, run, path)", () => {
    const id = evidenceId("k1", "run-1", "wf/clip");
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.equal(evidenceId("k1", "run-1", "wf/clip"), id);
    assert.notEqual(evidenceId("k1", "run-1", "wf/each[1]/clip"), id);
    assert.notEqual(evidenceId("k2", "run-1", "wf/clip"), id);
    assert.notEqual(evidenceId("k1", "run-2", "wf/clip"), id);
  });

  it("the gate: no graph behind the workspace → no claims layer", () => {
    assert.equal(claimsReaderFor({}), null);
    assert.ok(claimsReaderFor({ graph: { bolt: {} } as unknown as GraphBackend }) instanceof ClaimsReader);
    assert.ok(isExternalCheck({}) && !isExternalCheck({ step_type: "exec" }));
  });
});

// ── Live graph ──────────────────────────────────────────────────────────────

describe("claims graph: node contract + reads (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  let nodes: NodeWriter;
  let edges: EdgeWriter;
  let reader: ClaimsReader;
  const now = Math.trunc(Date.now() / 1000);
  const ref: Record<string, string> = {};

  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedJarvisOntology(bolt);
    await seedStrutDomain(bolt);
    const resolver = new SchemaResolver(bolt);
    nodes = new NodeWriter(bolt, { resolver });
    edges = new EdgeWriter(bolt, { resolver });
    reader = new ClaimsReader({ bolt });

    // A step with two versions (v2 active), a workflow, and a run of the step.
    const made = await nodes.writeMany([
      { type: "StrutStep", data: { step_type: "clip/compute-times", active_version: V2 } },
      { type: "StrutStepVersion", data: { step_type: "clip/compute-times", content_hash: V1, created_at: now - 100 } },
      { type: "StrutStepVersion", data: { step_type: "clip/compute-times", content_hash: V2, created_at: now - 50 } },
      { type: "StrutWorkflow", data: { name: "youtube-clip", active_version: "wf-hash" } },
      { type: "StrutRun", data: { run_id: "run-1", workflow_name: "step:clip/compute-times", status: "success", started_at: now - 10 } },
    ]);
    [ref["step"], ref["v1"], ref["v2"], ref["wf"], ref["run"]] = made.map((m) => m.ref_id);
  });
  after(async () => {
    await bolt?.close();
  });

  it("writes Claim / Check / Evidence through the ordinary writers (migration 124 + 125 shapes)", async () => {
    // No speaker_name; two claims with the same text and different ids.
    const text = "computes start/end inside the video's duration";
    const [c1, c2] = await nodes.writeMany(
      [
        { type: "Claim", data: { id: "c1", name: text, claim_text: text, belief_valid_from: now - 40 } },
        { type: "Claim", data: { id: "c2", name: text, claim_text: text, speaker_name: "ai", belief_valid_from: now - 30 } },
      ],
      "create",
    );
    assert.deepEqual([c1!.outcome, c2!.outcome, c1!.node_key, c2!.node_key], ["created", "created", "claim-c1", "claim-c2"]);
    ref["c1"] = c1!.ref_id;
    ref["c2"] = c2!.ref_id;
    const labels = await bolt.run(`MATCH (c:Claim {id: "c1"}) RETURN labels(c) AS l`);
    assert.deepEqual([...(labels[0]!["l"] as string[])].sort(), ["Claim", "Data_Bank", "Domain_epistemic", "Node"]);
    await assert.rejects(
      nodes.write({ type: "Claim", data: { name: text, claim_text: text } }),
      (e: unknown) => e instanceof GraphValidationError && e.code === "MISSING_REQUIRED",
      "id is the identity",
    );

    // Check.created_at is REQUIRED (a create without it is a 400 in jarvis too).
    await assert.rejects(
      nodes.write({ type: "Check", data: { id: "k0", name: "no stamp", step_type: "exec" } }),
      (e: unknown) => e instanceof GraphValidationError && e.code === "MISSING_REQUIRED" && e.attribute === "created_at",
    );
    const [k1, kOld, kExt] = await nodes.writeMany([
      { type: "Check", data: { id: "k1", name: "bounds", step_type: "exec", step_config: '{"command":"true"}', run_when: "run", policy: "always", publisher: "ai", created_at: now - 40 } },
      { type: "Check", data: { id: "kold", name: "bounds (old)", step_type: "exec", created_at: now - 45, retired_at: now - 41 } },
      { type: "Check", data: { id: "kext", name: "listen", description: "does the cut sound natural — code cannot hear", policy: "on_change", created_at: now - 39 } },
    ]);
    ref["k1"] = k1!.ref_id;
    ref["kold"] = kOld!.ref_id;
    ref["kext"] = kExt!.ref_id;

    const written = await edges.writeMany([
      // One claim ABOUT two subjects (many-to-many); both claims about the step.
      { edge: "ABOUT", source_ref_id: ref["c1"]!, target_ref_id: ref["step"]! },
      { edge: "ABOUT", source_ref_id: ref["c1"]!, target_ref_id: ref["wf"]! },
      { edge: "ABOUT", source_ref_id: ref["c2"]!, target_ref_id: ref["step"]! },
      { edge: "TESTS", source_ref_id: ref["k1"]!, target_ref_id: ref["c1"]! },
      { edge: "TESTS", source_ref_id: ref["kold"]!, target_ref_id: ref["c1"]! },
      { edge: "TESTS", source_ref_id: ref["kext"]!, target_ref_id: ref["c1"]! },
      { edge: "SUPERSEDES", source_ref_id: ref["k1"]!, target_ref_id: ref["kold"]! },
    ]);
    assert.ok(written.every((w) => w.created));
    // ABOUT is schema-validated (it is NOT a generic token): only Claim and Evidence may point with it.
    await assert.rejects(
      edges.write({ edge: "ABOUT", source_ref_id: ref["k1"]!, target_ref_id: ref["step"]! }),
      (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE",
    );
  });

  it("claimsFor / checksFor read active nodes; retired ones only on request", async () => {
    assert.deepEqual((await reader.claimsFor(STEP)).map((c) => c.id), ["c1", "c2"]);
    assert.deepEqual((await reader.claimsFor({ kind: "workflow", name: "youtube-clip" })).map((c) => c.id), ["c1"]);
    assert.deepEqual(await reader.claimsFor({ kind: "step", type: "nope" }), []);
    const c1 = (await reader.claimsFor(STEP))[0]!;
    assert.equal(c1.speaker_name, undefined);
    assert.equal(c1.belief_valid_from, now - 40);
    assert.equal(c1.ref_id, ref["c1"]);

    assert.deepEqual((await reader.checksFor("c1")).map((k) => k.id), ["k1", "kext"]);
    assert.deepEqual((await reader.checksFor("c1", { includeRetired: true })).map((k) => k.id), ["kold", "k1", "kext"]);
    const [k1, kext] = await reader.checksFor("c1");
    assert.deepEqual([k1!.step_type, k1!.policy, k1!.publisher, isExternalCheck(k1!)], ["exec", "always", "ai", false]);
    assert.ok(isExternalCheck(kext!) && kext!.description);

    assert.equal(await reader.activeVersion(STEP), V2);
    assert.equal(await reader.activeVersion({ kind: "step", type: "nope" }), null);

    // Retiring a claim (belief_valid_to) drops it from the default read; history stays.
    await nodes.update(ref["c2"]!, { set: { belief_valid_to: now } });
    assert.deepEqual((await reader.claimsFor(STEP)).map((c) => c.id), ["c1"]);
    assert.deepEqual((await reader.claimsFor(STEP, { includeRetired: true })).map((c) => c.id), ["c1", "c2"]);
  });

  it("evidence → status: unknown → supported → stale on a new version → refuted; muted edges are invisible", async () => {
    const before = await reader.statusFor(STEP);
    assert.deepEqual(before.map((r) => [r.claim.id, r.status.status, r.status.unverified]), [["c1", "unknown", 2]]);

    // What the verify pass will write: Evidence + EVIDENCED_BY{strength} + PRODUCED_BY + ABOUT + HAS_SOURCE.
    const id = evidenceId("k1", "run-1", "step");
    const e1 = await nodes.write({ type: "Evidence", data: { id, name: "computes start/end…", content: "start=12 end=31 duration=95", evidence_mode: "observed", evidence_status: "collected", observed_at: now - 5 } }, "create");
    assert.equal(e1.node_key, `evidence-${id}`);
    const context = JSON.stringify({ path: "step", cassette: "replay", checkVersion: "exec" });
    await edges.writeMany([
      { edge: "EVIDENCED_BY", source_ref_id: ref["c1"]!, target_ref_id: e1.ref_id, properties: { strength: 1 } },
      { edge: "PRODUCED_BY", source_ref_id: e1.ref_id, target_ref_id: ref["k1"]! },
      { edge: "ABOUT", source_ref_id: e1.ref_id, target_ref_id: ref["v2"]! },
      { edge: "HAS_SOURCE", source_ref_id: e1.ref_id, target_ref_id: ref["run"]!, properties: { context } },
    ]);
    // A second pass over the same (check, run, path) is a no-op by construction.
    const again = await nodes.write({ type: "Evidence", data: { id, name: "x", content: "DIFFERENT", evidence_status: "collected" } }, "create");
    assert.deepEqual([again.outcome, again.ref_id], ["existing", e1.ref_id]);

    const [row] = await reader.evidenceFor("c1", STEP);
    assert.deepEqual(
      { ...row, date_added_to_graph: undefined },
      {
        ref_id: e1.ref_id, id, name: "computes start/end…", content: "start=12 end=31 duration=95",
        evidence_mode: "observed", evidence_status: "collected", observed_at: now - 5, date_added_to_graph: undefined,
        claim_id: "c1", strength: 1, check_id: "k1",
        about: { kind: "step", name: "clip/compute-times", content_hash: V2 },
        source: { ref_id: ref["run"], node_type: "StrutRun", run_id: "run-1", context: { path: "step", cassette: "replay", checkVersion: "exec" } },
      },
    );
    assert.deepEqual(await reader.evidenceFor("c1", { kind: "workflow", name: "youtube-clip" }), [], "same claim, other subject: its own status");

    let s = (await reader.statusFor(STEP))[0]!.status;
    assert.deepEqual([s.status, s.assertedOnly, s.unverified, s.openSlot], ["supported", false, 1, false]);
    assert.equal(s.latest?.source?.context?.checkVersion, "exec");
    assert.equal((await reader.statusFor({ kind: "workflow", name: "youtube-clip" }))[0]!.status.status, "unknown");

    // Publish v3 → the evidence is about an older version.
    await nodes.update(ref["step"]!, { set: { active_version: "hash-v3" } });
    s = (await reader.statusFor(STEP))[0]!.status;
    assert.deepEqual([s.status, s.unverified], ["stale", 2]);
    await nodes.update(ref["step"]!, { set: { active_version: V2 } });

    // The retired check's refutation on the active version never counts.
    const eOld = await nodes.write({ type: "Evidence", data: { id: evidenceId("kold", "run-1", "step"), name: "old instrument", content: "nope", evidence_mode: "observed", evidence_status: "collected", observed_at: now - 1 } });
    await edges.writeMany([
      { edge: "EVIDENCED_BY", source_ref_id: ref["c1"]!, target_ref_id: eOld.ref_id, properties: { strength: -1 } },
      { edge: "PRODUCED_BY", source_ref_id: eOld.ref_id, target_ref_id: ref["kold"]! },
      { edge: "ABOUT", source_ref_id: eOld.ref_id, target_ref_id: ref["v2"]! },
    ]);
    assert.equal((await reader.statusFor(STEP))[0]!.status.status, "supported");

    // An asserted refutation with no check (add_evidence) on the active version wins.
    const eSay = await nodes.write({ type: "Evidence", data: { id: newEpistemicId(), name: "assistant looked", content: "end > duration on a 20s video", evidence_mode: "asserted", evidence_status: "collected", observed_at: now } });
    const said = await edges.writeMany([
      { edge: "EVIDENCED_BY", source_ref_id: ref["c1"]!, target_ref_id: eSay.ref_id, properties: { strength: -1 } },
      { edge: "ABOUT", source_ref_id: eSay.ref_id, target_ref_id: ref["v2"]! },
    ]);
    s = (await reader.statusFor(STEP))[0]!.status;
    assert.deepEqual([s.status, s.assertedOnly, s.latest?.check_id], ["refuted", true, undefined]);

    // Mute its EVIDENCED_BY edge (jarvis's soft delete) → invisible to every read.
    assert.ok(await edges.mute(said[0]!.ref_id));
    assert.equal((await reader.statusFor(STEP))[0]!.status.status, "supported");
    assert.ok(!(await reader.evidenceFor("c1")).some((e) => e.id === eSay.id));
  });

  it("an external check's planned slot: EVIDENCED_BY with no strength, openSlot, filled in place", async () => {
    const id = evidenceId("kext", "run-1", "step");
    const slot = await nodes.write({ type: "Evidence", data: { id, name: "computes start/end…", description: "does the cut sound natural — run run-1, step", evidence_status: "planned" } }, "create");
    const [eb] = await edges.writeMany([
      { edge: "EVIDENCED_BY", source_ref_id: ref["c1"]!, target_ref_id: slot.ref_id },
      { edge: "PRODUCED_BY", source_ref_id: slot.ref_id, target_ref_id: ref["kext"]! },
      { edge: "ABOUT", source_ref_id: slot.ref_id, target_ref_id: ref["v2"]! },
      { edge: "HAS_SOURCE", source_ref_id: slot.ref_id, target_ref_id: ref["run"]!, properties: { context: JSON.stringify({ path: "step" }) } },
    ]);
    const edge = await bolt.run(`MATCH ()-[r {ref_id: $r}]->() RETURN r.strength AS s`, { r: eb!.ref_id });
    assert.equal(edge[0]!["s"], null, "an unanswered question has no strength");

    let s = (await reader.statusFor(STEP))[0]!.status;
    assert.deepEqual([s.status, s.openSlot, s.unverified], ["supported", true, 1]);
    assert.deepEqual(s.slots, [{ evidence_id: id, check_id: "kext" }]);

    // Fill: the SAME node patched to collected, the edge patched to ±1.
    await nodes.update(slot.ref_id, { set: { content: "sounds clean", evidence_status: "collected", evidence_mode: "asserted", observed_at: now + 1 } });
    await edges.update({ ref_id: eb!.ref_id }, { set: { strength: 1 } });
    s = (await reader.statusFor(STEP))[0]!.status;
    assert.deepEqual([s.status, s.openSlot, s.unverified, s.assertedOnly], ["supported", false, 0, false]);
    assert.equal((await bolt.run(`MATCH (e:Evidence {id: $id}) RETURN count(e) AS c`, { id }))[0]!["c"], 1);
  });
});
