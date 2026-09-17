/**
 * The verify pass, end to end (plans/claims.md §4): real workflows run
 * through `createStrut` on a graph-backed workspace, real checks executed,
 * evidence read back from Neo4j. Steps are injected into the registry (these
 * tests are about verification, not module loading); the workspace still
 * holds their versions, which is what evidence is ABOUT.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type RunEvent, type StepRegistry } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import { coreRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { buildTools } from "../ai/tools.js";
import { buildAuthoringCapability, type AuthoringCapability } from "../authoring.js";
import { buildClaimsAuthoring, type ClaimActor, type ClaimsAuthoring, type CheckSpecInput } from "../claims-authoring.js";
import type { VerifyResult, Verifier } from "../verify.js";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();
const SRC = (type: string, tag: string) => `// ${tag}\nimport { z, defineStep } from "strut";\nexport default defineStep({ type: "${type}", input: z.any(), output: z.any(), run: async () => ({}) });\n`;
const WF = (name: string, steps: string) => `name: ${name}\nsteps:\n${steps}`;

describe("verify pass (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let backend: GraphBackend;
  let dir: string;
  let ws: Neo4jWorkspaceStore;
  let store: MemoryRunStore;
  let strut: Strut;
  let claims: ClaimsAuthoring;
  let verifier: Verifier;
  let registry: StepRegistry;
  let judged = 0;
  const human: ClaimActor = { publisher: "evan", scoped: false };
  const ai: ClaimActor = { publisher: "ai", scoped: false };
  const STEP = { kind: "step" as const, name: "clip/compute-times" };
  const savedEnv: Record<string, string | undefined> = {};

  /** `test A -op B` as a free, observed check. */
  const compare = (a: string, op: string, b: string, extra: Partial<CheckSpecInput> = {}): CheckSpecInput => ({ type: "exec", config: { cmd: "test", args: [a, op, b] }, ...extra });
  const addClaim = async (subject: { kind: "step" | "workflow"; name: string }, text: string, checks: CheckSpecInput[], actor = human) => {
    const r = await claims.addClaim({ subjects: [subject], text, checks }, actor);
    assert.ok("ok" in r, (r as { error?: string }).error);
    return r as { ok: true; id: string; checks: string[] };
  };
  const verify = async (name: string, runId: string): Promise<VerifyResult> => {
    const res = await strut.app.request(`/workflows/${name}/runs/${runId}/verify`, { method: "POST" });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as VerifyResult;
  };
  const statusOf = async (subject: { kind: "step" | "workflow"; name: string }) => {
    const r = await claims.listClaims(subject);
    assert.ok("ok" in r);
    return (r as Extract<typeof r, { ok: true }>).claims.map((c) => [c.text, c.status, c.assertedOnly, c.unverified, c.openSlot] as const);
  };
  const rows = (cypher: string, params: Record<string, unknown> = {}) => backend.bolt.run(cypher, params);
  const count = async (cypher: string) => Number((await rows(cypher))[0]!["c"]);
  const outcomes = (r: VerifyResult) => r.checks.map((k) => [k.path, k.lastVerify] as const);

  before(async () => {
    backend = await openGraphBackend(cfg!, { embeddings: false, skipBoot: true });
    dir = await mkdtemp(join(tmpdir(), "strut-verify-"));
    await wipeGraph(backend.bolt);
    const { seedJarvisOntology } = await import("./ontology-seed.js");
    const { seedStrutDomain } = await import("./schema-seed.js");
    await seedJarvisOntology(backend.bolt);
    await seedStrutDomain(backend.bolt);
    backend.schemas.invalidate();
    for (const k of ["STRUT_VERIFY_BUDGET_USD", "STRUT_VERIFY_BUDGET_USD_PER_DAY"]) savedEnv[k] = process.env[k];
  });
  after(async () => {
    for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rows(`MATCH (n) WHERE NOT n:Schema AND NOT n:Migration DETACH DELETE n`);
    delete process.env["STRUT_VERIFY_BUDGET_USD"];
    delete process.env["STRUT_VERIFY_BUDGET_USD_PER_DAY"];
    judged = 0;
    ws = new Neo4jWorkspaceStore(backend, { materializeDir: join(dir, "steps") });
    store = new MemoryRunStore();
    registry = {
      ...coreRegistry(),
      // start + len → end; `len` can be negative, which is the bug claims catch.
      "clip/compute-times": defineStep({
        type: "clip/compute-times",
        input: z.object({ start: z.number(), len: z.number().default(19) }),
        output: z.any(),
        run: async (c) => {
          if (c.start < 0) throw new Error("start must be ≥ 0");
          return { start: c.start, end: c.start + c.len };
        },
      }),
      // A stand-in for a paid judge: reports cost the way agent/llm-backed steps do.
      llm: defineStep({ type: "llm", input: z.any(), output: z.any(), run: async () => ({ supports: true, content: `judged #${++judged}`, cost: 0.4 }) }),
      "judge/sneaky-cost": defineStep({ type: "judge/sneaky-cost", input: z.any(), output: z.any(), run: async () => ({ supports: true, content: "called a model through services", cost: 0.3 }) }),
    } as StepRegistry;
    await ws.publishStep("clip/compute-times", SRC("clip/compute-times", "v1"), "v1", "ai");
    await ws.publishWorkflowByContent("clipper", WF("clipper", `  - id: times\n    type: clip/compute-times\n    config: { start: "{{ input.start }}", len: "{{ input.len }}" }\n`));
    strut = await createStrut({ workspace: ws, store, registry, dataDir: dir, serveUi: false, enableChat: false, stt: false });
    const getRegistry = async () => registry;
    claims = buildClaimsAuthoring({ graph: backend, workspace: ws, getRegistry });
    // ONE verifier per deployment: passes are single-flighted per instance.
    verifier = strut.verifier!;
  });

  it("run → evidence: Evidence + EVIDENCED_BY / PRODUCED_BY / ABOUT / HAS_SOURCE; idempotent; refuted; stale on a new version", async () => {
    const onStep = await addClaim(STEP, "end is after start", [compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}", { name: "bounds" })]);
    await addClaim({ kind: "workflow", name: "clipper" }, "the clip starts where asked", [compare("{{ input.output.start }}", "-eq", "{{ input.input.start }}")]);
    assert.deepEqual(await statusOf(STEP), [["end is after start", "unknown", false, 1, false]]);

    const good = await strut.run("clipper", { start: 5, len: 19 });
    assert.equal(good.status, "success");
    const first = await verify("clipper", good.runId); // joins (or repeats) the detached pass
    assert.deepEqual(outcomes(first), [["clipper/times", { ran: true }], ["clipper", { ran: true }]]);
    assert.deepEqual(await statusOf(STEP), [["end is after start", "supported", false, 0, false]]);
    assert.deepEqual(await statusOf({ kind: "workflow", name: "clipper" }), [["the clip starts where asked", "supported", false, 0, false]]);

    const written = await rows(
      `MATCH (c:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence)-[:PRODUCED_BY]->(k:Check {id: $k}), (e)-[:ABOUT]->(v:StrutStepVersion), (e)-[hs:HAS_SOURCE]->(r:StrutRun)-[:EXECUTED]->(wv:StrutWorkflowVersion)
       RETURN eb.strength AS strength, e.evidence_mode AS mode, e.evidence_status AS status, e.name AS name, e.content AS content, v.content_hash AS about, r.run_id AS run, wv.name AS wf, hs.context AS context`,
      { c: onStep.id, k: onStep.checks[0] },
    );
    const stepHash = (await ws.getActiveStepHashes())["clip/compute-times"];
    assert.deepEqual(
      written.map((w) => ({ ...w, context: JSON.parse(w["context"] as string) })),
      [{ strength: 1, mode: "observed", status: "collected", name: "end is after start", content: "exit 0", about: stepHash, run: good.runId, wf: "clipper", context: { path: "clipper/times", checkVersion: "exec" } }],
    );

    // A second pass over the same run writes nothing — by construction.
    const evidenceBefore = await count(`MATCH (e:Evidence) RETURN count(e) AS c`);
    const second = await verify("clipper", good.runId);
    assert.deepEqual([second.evidence, outcomes(second)], [0, [["clipper/times", { ran: true }], ["clipper", { ran: true }]]]);
    assert.equal(await count(`MATCH (e:Evidence) RETURN count(e) AS c`), evidenceBefore);
    assert.equal(await count(`MATCH (r:StrutRun) RETURN count(r) AS c`), 1);

    // Adding a check, then re-verifying, runs ONLY that check.
    const extra = await claims.addCheck(onStep.id, compare("{{ input.output.end }}", "-lt", "1000", { name: "sane" }), human);
    assert.ok("ok" in extra);
    const third = await verify("clipper", good.runId);
    assert.equal(third.evidence, 1);

    // A different input refutes; a refutation on the active version always wins.
    const bad = await strut.run("clipper", { start: 50, len: -10 });
    await verify("clipper", bad.runId);
    const [stepStatus] = await statusOf(STEP);
    assert.deepEqual([stepStatus![1], stepStatus![3]], ["refuted", 0]);
    const refutation = await rows(`MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence)-[:HAS_SOURCE]->(:StrutRun {run_id: $r}) WHERE eb.strength < 0 RETURN e.content AS content`, { c: onStep.id, r: bad.runId });
    assert.equal(refutation.length, 1);

    // Publish a fix: nothing runs at publish, the evidence is simply about an older version.
    await ws.publishStep("clip/compute-times", SRC("clip/compute-times", "v2"), "v2");
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1, 4), ["stale", false, 2]);
    const fixed = await strut.run("clipper", { start: 1, len: 5 });
    await verify("clipper", fixed.runId);
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1, 4), ["supported", false, 0]);
  });

  it("the automatic pass fires by itself after a top-level run — no explicit verify", async () => {
    await addClaim(STEP, "end is after start", [compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}")]);
    await strut.run("clipper", { start: 5, len: 19 });
    for (let i = 0; i < 100 && (await statusOf(STEP))[0]![1] !== "supported"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await statusOf(STEP))[0]![1], "supported");
  });

  it("a foreach yields one Evidence per iteration, and one failing iteration refutes the run; an errored step is checkable", async () => {
    await ws.publishWorkflowByContent(
      "batch",
      WF("batch", `  - id: each\n    type: foreach\n    config:\n      items: "{{ input.items }}"\n      body:\n        id: times\n        type: clip/compute-times\n        config: { start: "{{ $current.start }}", len: "{{ $current.len }}" }\n`),
    );
    const c = await addClaim(STEP, "end is after start", [compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}")]);
    const run = await strut.run("batch", { items: [{ start: 1, len: 5 }, { start: 9, len: -3 }, { start: 2, len: 5 }] });
    const r = await verify("batch", run.runId);
    assert.deepEqual(r.checks.map((k) => k.lastVerify), [{ ran: true }, { ran: true }, { ran: true }]);
    const paths = await rows(`MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence)-[hs:HAS_SOURCE]->() RETURN hs.context AS ctx, eb.strength AS s ORDER BY ctx`, { c: c.id });
    assert.deepEqual(paths.map((p) => [JSON.parse(p["ctx"] as string).path, p["s"]]), [["batch/each#0", 1], ["batch/each#1", -1], ["batch/each#2", 1]]);
    assert.equal((await statusOf(STEP))[0]![1], "refuted", "the last iteration passing does not paper over the second failing");

    // "fails loudly on bad input": the subject is { input, error }, no output.
    const loud = await addClaim(STEP, "rejects a negative start, loudly", [{ type: "exec", config: { cmd: "test", args: ["-n", "{{ input.error.message }}"] } }]);
    const failed = await strut.run("clipper", { start: -1, len: 5 });
    assert.equal(failed.status, "error");
    const v = await verify("clipper", failed.runId);
    const byClaim = Object.fromEntries(v.checks.filter((k) => k.path === "clipper/times").map((k) => [k.claimId, k.lastVerify]));
    assert.deepEqual(byClaim[loud.id], { ran: true });
    // The bounds check has no `output` to read: its templates cannot resolve — a broken check, never a verdict.
    assert.deepEqual((byClaim[c.id] as { skipped?: string }).skipped, "cannot-launch");
    const loudRow = (await statusOf(STEP)).find((s) => s[0].startsWith("rejects"))!;
    assert.equal(loudRow[1], "supported");
  });

  it("a nested subflow is an execution of the child workflow: evidence at the nested path, about the child's version", async () => {
    await ws.publishWorkflowByContent("outer", WF("outer", `  - id: inner\n    type: subflow\n    config: { workflow: clipper, input: { start: "{{ input.start }}", len: 4 } }\n`));
    const c = await addClaim({ kind: "workflow", name: "clipper" }, "the clip starts where asked", [compare("{{ input.output.start }}", "-eq", "{{ input.input.start }}")]);
    const run = await strut.run("outer", { start: 7 });
    const r = await verify("outer", run.runId);
    assert.deepEqual(r.checks.map((k) => [k.subject, k.path, k.lastVerify]), [[{ kind: "workflow", name: "clipper" }, "outer/inner", { ran: true }]]);
    const got = await rows(
      `MATCH (:Claim {id: $c})-[:EVIDENCED_BY]->(e:Evidence)-[:ABOUT]->(v:StrutWorkflowVersion), (e)-[hs:HAS_SOURCE]->(r:StrutRun) RETURN v.name AS wf, v.content_hash AS h, r.workflow_name AS run_of, hs.context AS ctx`,
      { c: c.id },
    );
    assert.deepEqual(
      got.map((g) => ({ ...g, ctx: JSON.parse(g["ctx"] as string).path })),
      [{ wf: "clipper", h: await ws.getWorkflowHash("clipper"), run_of: "outer", ctx: "outer/inner" }],
    );
    assert.equal((await statusOf({ kind: "workflow", name: "clipper" }))[0]![1], "supported", "a workflow that only ever runs nested still gets evidence");
  });

  it("no recorded version → no evidence, ever (never 'the active version'); a broken check is never a pass", async () => {
    const c = await addClaim(STEP, "end is after start", [
      compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}"),
      { type: "exec", config: { cmd: "definitely-not-a-real-binary-xyz" }, name: "missing tool" },
      { type: "exec", config: { cmd: "bash", args: ["-c", "exit 127"] }, name: "command not found" },
    ]);
    // A run recorded BEFORE stepHashes existed: same events, no hashes.
    const ts = new Date().toISOString();
    const old: RunEvent[] = [
      { ts, runId: "1700000000000", path: "clipper", type: "run.start", input: { start: 1 } },
      { ts, runId: "1700000000000", path: "clipper/times", type: "step.start", stepType: "clip/compute-times", input: { start: 1, len: 19 } },
      { ts, runId: "1700000000000", path: "clipper/times", type: "step.end", stepType: "clip/compute-times", output: { start: 1, end: 20 } },
      { ts, runId: "1700000000000", path: "clipper", type: "run.end", output: { start: 1, end: 20 } },
    ];
    for (const e of old) await store.append("clipper", "1700000000000", e);
    const blind = await verify("clipper", "1700000000000");
    assert.deepEqual(blind.checks.map((k) => k.lastVerify), [{ skipped: "unknown-version" }, { skipped: "unknown-version" }, { skipped: "unknown-version" }]);
    assert.equal(await count(`MATCH (e:Evidence) RETURN count(e) AS c`), 0);
    assert.equal(await count(`MATCH (r:StrutRun) RETURN count(r) AS c`), 0, "a run that produced no evidence never reaches the graph");

    const run = await strut.run("clipper", { start: 5, len: 19 });
    const r = await verify("clipper", run.runId);
    assert.deepEqual(r.checks.map((k) => ("skipped" in k.lastVerify ? k.lastVerify.skipped : "ran")), ["ran", "cannot-launch", "cannot-launch"]);
    assert.equal(await count(`MATCH (:Claim {id: "${c.id}"})-[:EVIDENCED_BY]->(e) RETURN count(e) AS c`), 1);
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1, 4), ["supported", false, 2], "supported by the one check that ran; two still unverified");
    assert.equal((await verify("clipper", "nope").catch(() => null)), null, "an unknown run is a 404");
  });

  it("a check can be a whole workflow; check runs are never verified, even when the check workflow has claims of its own", async () => {
    await ws.publishWorkflowByContent(
      "bounds-check",
      WF("bounds-check", `  - id: cmp\n    type: exec\n    config: { cmd: bash, args: ["-c", "test {{ input.end }} -gt {{ input.start }} && echo '{\\"supports\\": true, \\"content\\": \\"end {{ input.end }} > start {{ input.start }}\\"}' || echo '{\\"supports\\": false, \\"content\\": \\"end {{ input.end }} <= start {{ input.start }}\\"}'"] }\n  - id: verdict\n    type: exec\n    depends: [cmp]\n    config: { cmd: echo, args: ["{{ cmp.stdout }}"] }\n`),
    );
    // The check workflow carries its own claim — unguarded, verifying it would recurse.
    await addClaim({ kind: "workflow", name: "bounds-check" }, "always answers", [compare("1", "-eq", "1")]);
    const c = await addClaim(STEP, "end is after start", [
      { type: "subflow", name: "bounds", config: { workflow: "bounds-check", input: { start: "{{ input.output.start }}", end: "{{ input.output.end }}" } } },
    ]);
    const listed = await claims.listClaims(STEP);
    assert.equal(("ok" in listed ? listed.claims[0]!.checks[0]!.policy : ""), "always", "no agent/llm in the closure → free → always");

    const run = await strut.run("clipper", { start: 5, len: 19 });
    await verify("clipper", run.runId);
    await new Promise((r) => setTimeout(r, 300)); // let any (wrongly) scheduled pass over the check run settle
    const ev = await rows(`MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence)-[hs:HAS_SOURCE]->(r:StrutRun) RETURN e.content AS content, e.evidence_mode AS mode, eb.strength AS s, hs.context AS ctx, r.run_id AS run`, { c: c.id });
    assert.deepEqual(
      ev.map((e) => ({ ...e, ctx: JSON.parse(e["ctx"] as string) })),
      [{ content: "end 24 > start 5", mode: "observed", s: 1, ctx: { path: "clipper/times", checkVersion: `bounds-check@${await ws.getWorkflowHash("bounds-check")}` }, run: run.runId }],
    );
    // The pass terminated, and nothing is sourced to a verify-origin run.
    assert.equal(await count(`MATCH (r:StrutRun) RETURN count(r) AS c`), 1);
    assert.equal((await statusOf({ kind: "workflow", name: "bounds-check" }))[0]![1], "unknown", "the check's own claim gets evidence only when bounds-check is run directly");
    const direct = await strut.run("bounds-check", { start: 1, end: 2 });
    await verify("bounds-check", direct.runId);
    assert.equal((await statusOf({ kind: "workflow", name: "bounds-check" }))[0]![1], "supported");

    // Republish the instrument under the frozen Check node → on_change notices via checkVersion.
    const onChange = await claims.editCheck(c.checks[0]!, { policy: "on_change" }, human);
    assert.ok("ok" in onChange);
    const r2 = await strut.run("clipper", { start: 6, len: 19 });
    assert.deepEqual((await verify("clipper", r2.runId)).checks.map((k) => k.lastVerify), [{ ran: true }], "a new check node has no evidence yet");
    const r3 = await strut.run("clipper", { start: 7, len: 19 });
    assert.deepEqual((await verify("clipper", r3.runId)).checks.map((k) => k.lastVerify), [{ skipped: "policy" }], "same version, same instrument, fresh");
    await ws.publishWorkflowByContent("bounds-check", WF("bounds-check", `  - id: verdict\n    type: exec\n    config: { cmd: echo, args: ['{"supports": true, "content": "rewritten"}'] }\n`));
    const r4 = await strut.run("clipper", { start: 8, len: 19 });
    assert.deepEqual((await verify("clipper", r4.runId)).checks.map((k) => k.lastVerify), [{ ran: true }], "the check's resolved version changed");
  });

  it("policy + budget: paid checks fire on_change, are asserted, persisted under check:<id>, capped; a free check that reports cost is caught", async () => {
    const c = await addClaim(STEP, "the answer reads naturally", [
      { type: "llm", name: "judge-1", config: { prompt: "natural? {{ input.output.end }}", model: "sonnet" } },
      { type: "llm", name: "judge-2", config: { prompt: "natural? {{ input.output.end }}" } },
      { type: "llm", name: "judge-3", config: { prompt: "natural? {{ input.output.end }}" } },
      { type: "exec", name: "manual-only", config: { cmd: "true" }, policy: "manual" },
    ]);
    process.env["STRUT_VERIFY_BUDGET_USD"] = "0.5";
    const run = await strut.run("clipper", { start: 5, len: 19 });
    const auto = await verifier.verifyRun("clipper", run.runId); // what the detached trigger calls
    const byCheck = Object.fromEntries(auto.checks.map((k) => [c.checks.indexOf(k.checkId), k.lastVerify]));
    assert.deepEqual(byCheck[0], { ran: true });
    assert.deepEqual(byCheck[1], { ran: true }, "0.4 spent < 0.5: the cap is checked BEFORE a check runs");
    assert.deepEqual((byCheck[2] as { skipped: string }).skipped, "budget");
    assert.deepEqual(byCheck[3], { skipped: "policy" }, "manual never fires on the automatic pass");
    assert.ok(Math.abs(auto.costUsd - 0.8) < 1e-9);
    assert.equal(judged, 2);

    const paid = await rows(`MATCH (:Claim {id: $c})-[:EVIDENCED_BY]->(e:Evidence)-[hs:HAS_SOURCE]->() RETURN e.evidence_mode AS mode, hs.context AS ctx ORDER BY e.content`, { c: c.id });
    assert.deepEqual(paid.map((p) => p["mode"]), ["asserted", "asserted"], "a judgment is not an observation");
    const ctx = JSON.parse(paid[0]!["ctx"] as string) as { model?: string; checkRun?: string; checkVersion?: string };
    assert.deepEqual([ctx.model, ctx.checkVersion, typeof ctx.checkRun], ["sonnet", "llm", "string"]);
    // The paid check run is on record in its own bucket, tagged with what it verified — and is never a workflow.
    const bucket = `check:${c.checks[0]}`;
    assert.deepEqual(await store.listRuns(bucket), [ctx.checkRun]);
    const start = (await store.getRunEvents(bucket, ctx.checkRun!)).find((e) => e.type === "run.start")!;
    assert.deepEqual([start.origin, start.verify], ["verify", { checkId: c.checks[0], subject: "step:clip/compute-times", sourceRunId: run.runId }]);
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1, 4), ["supported", true, 2], "assertedOnly: nothing observed yet");

    // verify_run fires the manual check, re-runs nothing else — and judge-3 is still over today's... per-run cap resets per pass.
    const explicit = await verify("clipper", run.runId);
    const again = Object.fromEntries(explicit.checks.map((k) => [c.checks.indexOf(k.checkId), k.lastVerify]));
    assert.deepEqual([again[0], again[1], again[2], again[3]], [{ ran: true }, { ran: true }, { ran: true }, { ran: true }]);
    assert.equal(judged, 3);
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1, 4), ["supported", false, 0], "the observed exec support lifts assertedOnly");

    // on_change: a second run of the SAME version fires none of the paid checks.
    const r2 = await strut.run("clipper", { start: 6, len: 19 });
    const quiet = await verifier.verifyRun("clipper", r2.runId);
    assert.deepEqual(quiet.checks.map((k) => k.lastVerify), [{ skipped: "policy" }, { skipped: "policy" }, { skipped: "policy" }, { skipped: "policy" }]);
    assert.equal(judged, 3);

    // The per-subject daily cap is computed from the store: 1.2 already spent today.
    process.env["STRUT_VERIFY_BUDGET_USD_PER_DAY"] = "1";
    delete process.env["STRUT_VERIFY_BUDGET_USD"];
    await ws.publishStep("clip/compute-times", SRC("clip/compute-times", "v2"), "v2");
    const r3 = await strut.run("clipper", { start: 7, len: 19 });
    const capped = await verifier.verifyRun("clipper", r3.runId);
    assert.deepEqual(capped.checks.slice(0, 3).map((k) => ("skipped" in k.lastVerify ? k.lastVerify.skipped : "ran")), ["budget", "budget", "budget"]);
    assert.equal((await statusOf(STEP))[0]![1], "stale", "skipped for budget is never `supported`");

    // A presumed-FREE check that turns out to cost money: persisted, counted, visible.
    const sneaky = await addClaim(STEP, "cites sources", [{ type: "judge/sneaky-cost", config: {} }]);
    const lc = await claims.listClaims(STEP);
    assert.equal(("ok" in lc ? lc.claims.find((x) => x.id === sneaky.id)!.checks[0]!.policy : ""), "always", "its type says free");
    const r4 = await strut.run("clipper", { start: 8, len: 19 });
    const caught = await verifier.verifyRun("clipper", r4.runId);
    assert.ok(Math.abs(caught.costUsd - 0.3) < 1e-9);
    assert.equal((await store.listRuns(`check:${sneaky.checks[0]}`)).length, 1);
    assert.deepEqual(await store.listRuns(`check:${c.checks[3]}`), [], "a check that reports no cost is not persisted at all");
    // Cumulative, from the store alone: 3 judgments at 0.4 + the sneaky 0.3.
    assert.ok(Math.abs((await verifier.costOf({ kind: "step", type: "clip/compute-times" })) - 1.5) < 1e-9);
    assert.equal(await verifier.costOf({ kind: "workflow", name: "clipper" }), 0);
  });

  it("external checks: a planned slot (no strength, no content), filled in place by add_evidence; a newer version replaces the question", async () => {
    const c = await addClaim(STEP, "the cut sounds natural", [{ description: "listen to the clip at the cut — code cannot hear a click" }]);
    const run = await strut.run("clipper", { start: 5, len: 19 });
    const r = await verify("clipper", run.runId);
    const slotId = (r.checks[0]!.lastVerify as { planned: string }).planned;
    assert.ok(slotId);
    assert.equal(r.slots, 1);
    const slot = await rows(
      `MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence {id: $e})-[:PRODUCED_BY]->(k:Check), (e)-[:ABOUT]->(:StrutStepVersion), (e)-[:HAS_SOURCE]->(:StrutRun {run_id: $r})
       RETURN e.evidence_status AS status, e.name AS name, e.content AS content, e.evidence_mode AS mode, e.observed_at AS at, e.description AS ask, eb.strength AS strength, k.id AS check`,
      { c: c.id, e: slotId, r: run.runId },
    );
    assert.deepEqual({ ...slot[0], ask: undefined }, { status: "planned", name: "the cut sounds natural", content: null, mode: null, at: null, ask: undefined, strength: null, check: c.checks[0] });
    assert.match(String(slot[0]!["ask"]), /listen to the clip.*run .* of clipper, clipper\/times.*"end":24/s);
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1), ["unknown", false, 1, true], "a question is not evidence");
    assert.equal((await verify("clipper", run.runId)).slots, 0, "re-verifying the same run opens nothing");

    // The chat tool surface: add_evidence finds the open slot for this run and FILLS it.
    const tools = buildTools({ workspace: ws, registry, store, getRegistry: async () => registry, verifier }) as unknown as Record<string, { execute: (a: unknown) => Promise<Record<string, unknown>> }>;
    assert.ok(tools["verify_run"] && tools["add_evidence"]);
    const filled = await tools["add_evidence"]!.execute({ claim: c.id, name: "clipper", runId: run.runId, supports: true, content: "ffmpeg astats at the cut: no sample discontinuity above -60dB" });
    assert.deepEqual([filled["ok"], filled["filled"], filled["evidence"]], [true, true, slotId]);
    const after = await rows(`MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence {id: $e})-[hs:HAS_SOURCE]->() RETURN e.evidence_status AS status, e.evidence_mode AS mode, eb.strength AS s, hs.context AS ctx`, { c: c.id, e: slotId });
    assert.deepEqual(after.map((a) => ({ ...a, ctx: JSON.parse(a["ctx"] as string) })), [{ status: "collected", mode: "asserted", s: 1, ctx: { path: "clipper/times", by: "ai" } }]);
    assert.equal(await count(`MATCH (e:Evidence) RETURN count(e) AS c`), 1, "the SAME node");
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1), ["supported", true, 0, false]);

    // Same version again: on_change, already answered → no new question.
    const r2 = await strut.run("clipper", { start: 6, len: 19 });
    assert.deepEqual((await verify("clipper", r2.runId)).checks.map((k) => k.lastVerify), [{ skipped: "policy" }]);
    // A new version → a fresh question. Left unanswered, a still-newer run REPLACES it (the old edge is muted).
    await ws.publishStep("clip/compute-times", SRC("clip/compute-times", "v2"), "v2");
    const r3 = await strut.run("clipper", { start: 7, len: 19 });
    const s3 = ((await verify("clipper", r3.runId)).checks[0]!.lastVerify as { planned: string }).planned;
    const r4 = await strut.run("clipper", { start: 8, len: 19 });
    const s4 = ((await verify("clipper", r4.runId)).checks[0]!.lastVerify as { planned: string }).planned;
    assert.notEqual(s3, s4);
    const open = await rows(`MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence {evidence_status: "planned"}) RETURN e.id AS id, coalesce(eb.is_muted, false) AS muted ORDER BY id`, { c: c.id });
    assert.deepEqual(open.sort((a, b) => Number(a["muted"]) - Number(b["muted"])), [{ id: s4, muted: false }, { id: s3, muted: true }]);
    assert.deepEqual((await statusOf(STEP))[0]!.slice(1), ["stale", true, 1, true], "at most one open slot per external check");
    const refused = await tools["add_evidence"]!.execute({ claim: c.id, name: "clipper", runId: r4.runId, supports: true, content: "x", slot: slotId });
    assert.match(String(refused["error"]), /not an open slot/);
  });

  it("add_evidence without a slot is asserted, check-less evidence; only a seeded harness STEP records observed (fixed point 3)", async () => {
    const c = await addClaim({ kind: "workflow", name: "clipper" }, "accuracy is at least the baseline", [{ description: "the harness reports it" }], human);
    await ws.publishWorkflowByContent("gaia-evolve-gen", WF("gaia-evolve-gen", `  - id: a\n    type: log\n    config: { message: harness }\n`), "seeded", undefined, "seeder");
    await ws.publishWorkflowByContent("candidate", WF("candidate", `  - id: a\n    type: log\n    config: { message: candidate }\n`), "ai's", undefined, "ai");
    // A run with no slot on it: the check is external but on_change was already... use a manual check instead.
    const manual = await claims.editCheck(c.checks[0]!, { policy: "manual" }, human);
    assert.ok("ok" in manual);
    const authoring = (strut.services as { authoring: AuthoringCapability }).authoring;
    const run = await strut.run("clipper", { start: 5, len: 19 });
    await verifier.verifyRun("clipper", run.runId);

    const input = { claim: c.id, name: "clipper", runId: run.runId, supports: true, content: "53 tasks: 31 correct vs baseline 29" };
    const cases = [
      [{ workflow: "gaia-evolve-gen", runId: "h1" }, "observed", "gaia-evolve-gen"],
      [{ workflow: "gaia-evolve-gen", runId: "h1", agentTool: true }, "asserted", "ai:h1"], // a MODEL inside the harness chose to call it
      [{ workflow: "candidate", runId: "h2" }, "asserted", "ai:h2"],
      [undefined, "asserted", "ai"],
    ] as const;
    for (const [caller] of cases) assert.ok(((await authoring.addEvidence(input, caller as never)) as { ok?: true }).ok, JSON.stringify(caller));
    const got = await rows(`MATCH (:Claim {id: $c})-[:EVIDENCED_BY]->(e:Evidence)-[hs:HAS_SOURCE]->() WHERE NOT (e)-[:PRODUCED_BY]->() RETURN e.evidence_mode AS mode, hs.context AS ctx ORDER BY e.id`, { c: c.id });
    assert.deepEqual(got.map((g) => [g["mode"], JSON.parse(g["ctx"] as string).by]), cases.map(([, mode, by]) => [mode, by]));

    // Evidence must be about a version that actually ran.
    const other = await strut.run("candidate", {});
    assert.match(String(((await authoring.addEvidence({ ...input, name: "candidate", runId: other.runId })) as { error: string }).error), /did not execute a subject of this claim/);
    assert.match(String(((await authoring.addEvidence({ ...input, content: " " })) as { error: string }).error), /content is empty/);
    assert.match(String(((await authoring.verifyRun("clipper", run.runId)) as { error: string }).error), /not agent-authored/, "the meta surface verifies only what it published");
    assert.ok(!("error" in ((await authoring.verifyRun("candidate", other.runId)) as object)));
  });

  it("the ledger rides in tool results: run_workflow / run_step list the contract as pending, the settled pass wakes the chat, verify_run returns it", async () => {
    await addClaim(STEP, "end is after start", [compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}", { name: "bounds" })]);
    await addClaim({ kind: "workflow", name: "clipper" }, "the cut sounds natural", [{ description: "listen to it", name: "ear" }]);
    const watched: string[] = [];
    const settled: VerifyResult[] = [];
    // What createStrut's chat block does: remember which runs this chat
    // launched, and hear about their verify pass settling.
    const chatVerifier = { ...verifier, schedule: (key: string, runId: string) => void verifier.verifyRun(key, runId).then((r) => settled.push(r)) };
    const tools = buildTools({
      workspace: ws,
      registry,
      store,
      services: strut.services,
      getRegistry: async () => registry,
      verifier: chatVerifier,
      watchVerify: (runId: string) => watched.push(runId),
    }) as unknown as Record<string, { execute: (a: unknown) => Promise<Record<string, any>> }>;

    // run_workflow: the result carries the contract, every runnable check pending.
    const ran = await tools["run_workflow"]!.execute({ name: "clipper", input: { start: 50, len: -10 } });
    assert.equal(ran["status"], "success");
    assert.deepEqual(watched, [ran["runId"]]);
    assert.match(ran["verify"], /pending.*verify-notification/);
    assert.deepEqual(
      Object.fromEntries(Object.entries(ran["claims"] as Record<string, any[]>).map(([k, v]) => [k, v.map((c) => [c.text, c.status, c.checks.map((x: any) => [x.name, x.lastVerify])])])),
      {
        clipper: [["the cut sounds natural", "unknown", [["ear", { pending: true }]]]],
        "clip/compute-times": [["end is after start", "unknown", [["bounds", { pending: true }]]]],
      },
    );

    // The settled pass is what the [verify-notification] is built from.
    const pass = await verifier.verifyRun("clipper", ran["runId"]);
    const ledger = await verifier.ledger(pass);
    assert.deepEqual(ledger["clip/compute-times"]!.map((c) => [c.status, c.latest?.mode, c.checks[0]!.lastVerify]), [["refuted", "observed", { ran: true }]]);
    const slot = ledger["clipper"]![0]!.checks[0]!;
    assert.deepEqual([ledger["clipper"]![0]!.status, slot.external, Object.keys(slot.lastVerify!)], ["unknown", true, ["planned"]]);
    const { formatVerifyNotification } = await import("../ledger.js");
    assert.match(formatVerifyNotification({ workflow: "clipper", runId: ran["runId"], ledger }), /^\[verify-notification\] Run \d+ of "clipper".*1 REFUTED.*waiting on an external check/s);

    // verify_run returns the same ledger directly.
    const explicit = await tools["verify_run"]!.execute({ name: "clipper", runId: ran["runId"] });
    assert.deepEqual(explicit["claims"], ledger);
    assert.deepEqual(await tools["verify_run"]!.execute({ name: "clipper", runId: "nope" }).then((r) => [r["skipped"], r["claims"]]), ["unknown-run", undefined]);

    // run_step on a step with claims: kept, watched, scheduled — and its contract shown pending.
    const stepRun = await tools["run_step"]!.execute({ type: "clip/compute-times", config: { start: 1, len: 5 } });
    assert.equal(stepRun["kept"], "step:clip/compute-times");
    assert.deepEqual(watched, [ran["runId"], stepRun["runId"]]);
    assert.deepEqual(Object.keys(stepRun["claims"]), ["clip/compute-times"]);
    for (let i = 0; i < 100 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(settled.map((r) => [r.key, r.runId, r.evidence]), [["step:clip/compute-times", stepRun["runId"], 1]]);
    assert.equal((await statusOf(STEP))[0]![1], "supported", "the newer run supersedes the refuting one");

    // A scratch step (no claims) keeps nothing and shows no contract.
    const scratch = await tools["run_step"]!.execute({ type: "log", config: { message: "hi" } });
    assert.deepEqual([scratch["kept"], scratch["claims"]], [undefined, undefined]);
  });

  it("the Claims panel's HTTP door: a person authors, reads the contract with its to-dos, and answers an open slot", async () => {
    const http = async (method: string, path: string, body?: unknown) => {
      const res = await strut.app.request(path, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const SUBJECT = "/claims?kind=step&name=clip%2Fcompute-times";
    assert.deepEqual((await http("GET", SUBJECT)).body, { enabled: true, subject: STEP, claims: [] });
    assert.equal((await http("GET", "/claims?kind=nope&name=x")).status, 400);
    assert.deepEqual((await http("GET", "/claims?kind=step&name=exec")).body["claims"], [], "a built-in step simply has no contract");

    const made = await http("POST", "/claims", {
      subjects: [STEP],
      text: "the cut sounds natural",
      checks: [{ description: "listen at the cut — code cannot hear a click", name: "ear" }, compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}", { name: "bounds" })],
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal((await http("POST", "/claims", { subjects: [STEP], text: "no checks", checks: [] })).status, 400);
    assert.match((await http("POST", "/claims", { subjects: [STEP], text: "bad check", checks: [{ type: "exec", config: { command: "x" } }] })).body["error"], /not valid for step "exec"/);

    const run = await strut.run("clipper", { start: 5, len: 19 });
    await verify("clipper", run.runId);
    const listed = (await http("GET", SUBJECT)).body;
    const claim = listed["claims"][0];
    assert.deepEqual([claim.text, claim.speaker, claim.status, claim.openSlot, claim.unverified], ["the cut sounds natural", "person", "supported", true, 1]);
    assert.deepEqual([claim.latest.content, claim.latest.mode, claim.latest.run], ["exit 0", "observed", { name: "clipper", runId: run.runId, path: "clipper/times" }]);
    assert.deepEqual(claim.checks.map((k: any) => [k.name, k.external, k.publisher]), [["ear", true, "person"], ["bounds", false, "person"]]);
    // The to-do: the question, and which run to look at.
    assert.equal(claim.slots.length, 1);
    assert.match(claim.slots[0].question, /listen at the cut.*run .* of clipper/s);
    assert.deepEqual(claim.slots[0].run, { name: "clipper", runId: run.runId, path: "clipper/times" });

    const answered = await http("POST", `/claims/${claim.id}/evidence`, { name: "clipper", runId: run.runId, supports: false, content: "audible click at 24.0s", slot: claim.slots[0].evidence });
    assert.deepEqual([answered.status, answered.body["filled"]], [200, true]);
    const after = (await http("GET", SUBJECT)).body["claims"][0];
    assert.deepEqual([after.status, after.openSlot, after.slots, after.latest.by, after.latest.mode], ["refuted", false, [], "person", "asserted"], "a person's refutation on the active version wins");

    // Edit → successor; check edit / add / retire; retire the claim.
    const reworded = await http("PATCH", `/claims/${claim.id}`, { text: "the cut is inaudible" });
    assert.ok(reworded.body["id"] && reworded.body["id"] !== claim.id);
    const succ = (await http("GET", SUBJECT)).body["claims"][0];
    assert.deepEqual([succ.id, succ.status, succ.checks.length], [reworded.body["id"], "unknown", 2]);
    const bounds = succ.checks.find((k: any) => k.name === "bounds");
    const patched = await http("PATCH", `/checks/${bounds.id}`, { patch: { policy: "manual" } });
    assert.ok(patched.body["id"] !== bounds.id);
    assert.equal((await http("DELETE", `/checks/${patched.body["id"]}`)).status, 200);
    assert.match((await http("DELETE", `/checks/${succ.checks.find((k: any) => k.name === "ear").id}`)).body["error"], /last active check/);
    assert.equal((await http("POST", `/claims/${succ.id}/attach`, { subject: { kind: "workflow", name: "clipper" } })).body["attached"], true);
    assert.equal((await http("POST", `/claims/${succ.id}/detach`, { subject: { kind: "workflow", name: "clipper" } })).body["detached"], true);
    assert.equal((await http("DELETE", `/claims/${succ.id}`)).status, 200);
    assert.deepEqual((await http("GET", SUBJECT)).body["claims"], []);
    assert.equal((await http("DELETE", `/claims/${succ.id}`)).status, 400, "already retired");
  });

  it("publish checks lint the new version's source; a kept run_step run is verified with EXECUTED → the step version it ran", async () => {
    const lint = await addClaim(STEP, "never reads process.env directly", [
      { type: "exec", when: "publish", name: "env lint", config: { cmd: "bash", args: ["-c", "! grep -q 'process.env' <<< \"$SRC\""], env: { SRC: "{{ input.source }}" } } },
    ], ai);
    await addClaim(STEP, "end is after start", [compare("{{ input.output.end }}", "-gt", "{{ input.output.start }}")]);
    // The instance's registry is injected (publishing off), so publish through
    // a capability of our own over the same workspace, store and verifier.
    const authoring = buildAuthoringCapability({ workspace: ws, store, getRegistry: async () => registry, services: strut.services, verifier });
    const clean = (await authoring.editStep("clip/compute-times", SRC("clip/compute-times", "clean"))) as { publishChecks?: Array<{ check: string; lastVerify: unknown }> };
    assert.deepEqual(clean.publishChecks, [{ claim: lint.id, check: lint.checks[0], lastVerify: { ran: true } }]);
    const about = await rows(`MATCH (:Claim {id: $c})-[eb:EVIDENCED_BY]->(e:Evidence)-[:ABOUT]->(v:StrutStepVersion)<-[:HAS_SOURCE]-(e) RETURN eb.strength AS s, v.content_hash AS h`, { c: lint.id });
    assert.deepEqual(about, [{ s: 1, h: (await ws.getActiveStepHashes())["clip/compute-times"] }], "no run: the source of the evidence IS the version node");
    await authoring.editStep("clip/compute-times", `${SRC("clip/compute-times", "dirty")}// const k = process.env.KEY;\n`);
    assert.equal((await statusOf(STEP)).find((s) => s[0].startsWith("never"))![1], "refuted");

    // run_step on a step with claims → kept under step:<type> → verified, detached.
    const r = (await authoring.runStep("clip/compute-times", { config: { start: 3, len: 4 } })) as { runId: string; kept?: string };
    assert.equal(r.kept, "step:clip/compute-times");
    for (let i = 0; i < 100 && (await statusOf(STEP)).find((s) => s[0].startsWith("end is"))![1] !== "supported"; i++) await new Promise((x) => setTimeout(x, 50));
    const executed = await rows(`MATCH (run:StrutRun {run_id: $r})-[:EXECUTED]->(v:StrutStepVersion) RETURN run.workflow_name AS wf, v.content_hash AS h`, { r: r.runId });
    assert.deepEqual(executed, [{ wf: "step:clip/compute-times", h: (await ws.getActiveStepHashes())["clip/compute-times"] }]);
    assert.ok(!(await ws.listWorkflows()).some((w) => w.name.startsWith("step:")));
  });
});
