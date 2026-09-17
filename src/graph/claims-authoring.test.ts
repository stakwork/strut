/**
 * Claim + check authoring (plans/claims.md §2): the graph writer's
 * invariants, the policy layer (defaults, publisher scoping, the grader
 * deny-list), and both doors — the `claims` arg on the publish tools and
 * the standalone claim / check tools — over a live graph-backed workspace.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepRegistry } from "../core.js";
import { coreRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { AI_PUBLISHER, buildAuthoringCapability, type AuthoringCapability } from "../authoring.js";
import { buildTools } from "../ai/tools.js";
import { CLAIMS_SECTION, buildSystem } from "../ai/prompts.js";
import { DEFAULT_VERIFY_DENY, buildClaimsAuthoring, deniedInClosure, verifyDenyPatterns, type ClaimActor, type ClaimsAuthoring } from "../claims-authoring.js";
import { claimSpecSchema } from "../claims-schemas.js";
import { flowClosure } from "../closure.js";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { evidenceId } from "./claims.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();

// ── Pure ────────────────────────────────────────────────────────────────────

describe("grader deny-list (pure)", () => {
  const types = ["exec", "llm", "clip/trim", "gaia/evaluate", "harvey/score"];
  const closureOf = (steps: Array<{ type: string; config?: Record<string, unknown> }>) =>
    flowClosure({ steps: steps.map((s, i) => ({ id: `s${i}`, type: s.type, config: s.config ?? {} })) });

  it("defaults + STRUT_VERIFY_DENY", () => {
    assert.deepEqual(verifyDenyPatterns({}), DEFAULT_VERIFY_DENY);
    assert.deepEqual(verifyDenyPatterns({ STRUT_VERIFY_DENY: " secret/*, gaia/* ,," }), [...DEFAULT_VERIFY_DENY, "secret/*"]);
  });

  it("a named grader, a literal grant, and a glob grant that REACHES one are all caught", async () => {
    const deny = DEFAULT_VERIFY_DENY;
    assert.equal(deniedInClosure(await closureOf([{ type: "exec" }, { type: "clip/trim" }]), deny, types), null);
    assert.equal(deniedInClosure(await closureOf([{ type: "gaia/evaluate" }]), deny, types), "gaia/evaluate");
    assert.equal(deniedInClosure(await closureOf([{ type: "agent", config: { agentTools: ["meta/*"] } }]), deny, types), "meta/*");
    assert.equal(deniedInClosure(await closureOf([{ type: "agent", config: { agentTools: ["harvey/score"] } }]), deny, types), "harvey/score");
    assert.equal(deniedInClosure(await closureOf([{ type: "agent", config: { agentTools: ["*"] } }]), deny, types), "* (reaches gaia/evaluate)");
    assert.equal(deniedInClosure(await closureOf([{ type: "agent", config: { agentTools: ["clip/*"] } }]), deny, types), null);
  });

  it("the tool schema requires text and at least one check", () => {
    assert.ok(claimSpecSchema.safeParse({ text: "t", checks: [{ type: "exec", config: { command: "true" } }] }).success);
    assert.ok(claimSpecSchema.safeParse({ text: "t", checks: [{ description: "listen to the cut" }] }).success);
    assert.ok(!claimSpecSchema.safeParse({ text: "t", checks: [] }).success);
    assert.ok(!claimSpecSchema.safeParse({ text: "t", checks: [{ type: "exec", sampleRate: 2 }] }).success);
  });
});

describe("filesystem workspace: no claims layer (pure)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-claims-fs-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("no claim tool, no `claims` arg, no prompt section; the meta twins answer with an error", async () => {
    const workspace = new WorkspaceManager(dir);
    const deps = { workspace, registry: {} as StepRegistry, store: new MemoryRunStore(), getRegistry: async () => ({}) as StepRegistry };
    const tools = buildTools(deps) as Record<string, { inputSchema: z.ZodObject }>;
    for (const t of ["add_claim", "list_claims", "edit_claim", "retire_claim", "attach_claim", "detach_claim", "add_check", "edit_check", "retire_check"]) {
      assert.equal(tools[t], undefined, t);
    }
    assert.ok(!("claims" in tools["create_step"]!.inputSchema.shape) && !("claims" in tools["edit_workflow"]!.inputSchema.shape));
    assert.ok(!(await buildSystem(deps)).includes(CLAIMS_SECTION));

    const authoring = buildAuthoringCapability({ workspace, store: new MemoryRunStore(), getRegistry: async () => ({}) as StepRegistry });
    assert.match(String(((await authoring.listClaims({ kind: "step", name: "x" })) as { error: string }).error), /graph-backed workspace/);
    // A contract that cannot be recorded must not be silently dropped.
    const refused = await authoring.createStep("my/step", "export default 1;", undefined, [{ text: "t", checks: [{ description: "look" }] }]);
    assert.match(String(refused.error), /Nothing was published/);
    assert.deepEqual(await workspace.listSteps(), []);
  });
});

// ── Live graph ──────────────────────────────────────────────────────────────

const STEP_SRC = (type: string, tag = "one") =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: "${type}", description: "${tag}", input: z.any(), output: z.any(), run: async () => ({ tag: "${tag}" }) });\n`;
const EXEC = { type: "exec", config: { cmd: "true" } };

describe("claims authoring (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let backend: GraphBackend;
  let ws: Neo4jWorkspaceStore;
  let dir: string;
  let registry: StepRegistry;
  let claims: ClaimsAuthoring;
  let authoring: AuthoringCapability;
  let getRegistry: () => Promise<StepRegistry>;
  const human: ClaimActor = { publisher: "evan", scoped: false };
  const chat: ClaimActor = { publisher: AI_PUBLISHER, scoped: false };
  const meta: ClaimActor = { publisher: AI_PUBLISHER, scoped: true };
  const STEP = { kind: "step" as const, name: "clip/compute-times" };
  const SEEDED = { kind: "workflow" as const, name: "gaia-produce" };
  const CANDIDATE = { kind: "workflow" as const, name: "candidate-1" };

  const idOf = (r: unknown): string => {
    const x = r as { ok?: true; id?: string; error?: string };
    assert.equal(x.error, undefined, x.error);
    return x.id!;
  };
  const errOf = (r: unknown): string => String((r as { error?: string }).error ?? "");
  const listed = async (subject: { kind: "step" | "workflow"; name: string }) => {
    const r = await claims.listClaims(subject);
    assert.ok("ok" in r, errOf(r));
    return (r as Extract<typeof r, { ok: true }>).claims;
  };

  before(async () => {
    backend = await openGraphBackend(cfg!, { embeddings: false, skipBoot: true });
    dir = await mkdtemp(join(tmpdir(), "strut-claims-"));
    // Boot obligations by hand (skipBoot), ONCE: the ontology (Claim / Check /
    // Evidence) + the Strut domain. Each test then clears data, not schemas.
    await wipeGraph(backend.bolt);
    const { seedJarvisOntology } = await import("./ontology-seed.js");
    const { seedStrutDomain } = await import("./schema-seed.js");
    await seedJarvisOntology(backend.bolt);
    await seedStrutDomain(backend.bolt);
    backend.schemas.invalidate();
  });
  after(async () => {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await backend.bolt.run(`MATCH (n) WHERE NOT n:Schema AND NOT n:Migration DETACH DELETE n`);
    ws = new Neo4jWorkspaceStore(backend, { materializeDir: join(dir, "steps") });
    // A registry the checks can name: core + a stand-in grader and an llm-ish judge.
    const grader = defineStep({ type: "gaia/evaluate", input: z.any(), output: z.any(), run: async () => ({}) });
    registry = { ...(await coreRegistry()), "gaia/evaluate": grader } as StepRegistry;
    // Like the real one: whatever the workspace holds is loadable (stubbed —
    // these tests are about claims, not module loading).
    getRegistry = async () => ({
      ...registry,
      ...Object.fromEntries((await ws.listSteps()).map((s) => [s.type, defineStep({ type: s.type, input: z.any(), output: z.any(), run: async () => ({}) })])),
    });
    claims = buildClaimsAuthoring({ graph: backend, workspace: ws, getRegistry, env: {} });
    authoring = buildAuthoringCapability({ workspace: ws, store: new MemoryRunStore(), getRegistry });

    await ws.publishStep("clip/compute-times", STEP_SRC("clip/compute-times"), "one", AI_PUBLISHER);
    await ws.publishWorkflowByContent("gaia-produce", "name: gaia-produce\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n", "seeded", undefined, "seeder");
    await ws.publishWorkflowByContent("candidate-1", "name: candidate-1\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n", "candidate", undefined, AI_PUBLISHER);
  });

  it("door one: the `claims` arg adds, is idempotent by exact text, never retires, and warns on zero", async () => {
    const none = await claims.applyClaimsArg(STEP, undefined, chat);
    assert.deepEqual([none.count, none.added, none.existing], [0, 0, 0]);
    assert.match(none.warning!, /NO claims/);

    const contract = [
      { text: "computes start/end inside the video's duration", checks: [EXEC, { description: "scrub to the cut and look — code cannot see framing" }] },
      { text: "fails loudly on a private video", checks: [{ type: "exec", config: { cmd: "test", args: ["-n", "{{ input.error.message }}"] }, name: "error surfaced" }] },
    ];
    const first = await claims.applyClaimsArg(STEP, contract, chat);
    assert.deepEqual([first.count, first.added, first.existing, first.warning], [2, 2, 0, undefined]);
    const again = await claims.applyClaimsArg(STEP, contract, chat);
    assert.deepEqual([again.count, again.added, again.existing], [2, 0, 2], "a republish with the same arg is a no-op");
    const grown = await claims.applyClaimsArg(STEP, [contract[0]!, { text: "fetches only the requested caption languages", checks: [EXEC] }], chat);
    assert.deepEqual([grown.count, grown.added, grown.existing], [3, 1, 1], "a new text is added; the omitted claim is NOT retired");

    const rows = await listed(STEP);
    assert.deepEqual(rows.map((r) => [r.text.slice(0, 8), r.status, r.speaker, r.checks.length]), [
      ["computes", "unknown", "ai", 2],
      ["fails lo", "unknown", "ai", 1],
      ["fetches ", "unknown", "ai", 1],
    ]);
    const [code, external] = rows[0]!.checks;
    assert.deepEqual([code!.type, code!.config, code!.name, code!.when, code!.policy, code!.external, code!.publisher], ["exec", { cmd: "true" }, "exec", "run", "always", false, "ai"]);
    assert.deepEqual([external!.external, external!.type, external!.policy, external!.when], [true, undefined, "on_change", "run"]);
    // The graph shape: Claim —ABOUT→ the STABLE step, Check —TESTS→ Claim.
    const shape = await backend.bolt.run(
      `MATCH (k:Check)-[:TESTS]->(c:Claim)-[:ABOUT]->(s:StrutStep {step_type: "clip/compute-times"}) RETURN count(DISTINCT c) AS claims, count(k) AS checks`,
    );
    assert.deepEqual(shape, [{ claims: 3, checks: 4 }]);
    const ids = await backend.bolt.run(`MATCH (n) WHERE n:Claim OR n:Check RETURN collect(n.id) AS ids`);
    for (const id of ids[0]!["ids"] as string[]) assert.match(id, /^[a-z0-9]{32}$/);
  });

  it("defaults: free code checks fire always; anything presumed paid — llm, agent, a subflow hiding one — fires on_change", async () => {
    await ws.publishWorkflowByContent("judge", "name: judge\nsteps:\n  - id: j\n    type: llm\n    config: { prompt: ok }\n");
    await ws.publishWorkflowByContent("matcher", "name: matcher\nsteps:\n  - id: m\n    type: exec\n    config: { cmd: 'true' }\n");
    const id = idOf(
      await claims.addClaim(
        {
          subjects: [STEP],
          text: "the answer is bare",
          checks: [
            EXEC,
            { type: "llm", config: { prompt: "is it bare? {{ input.output.answer }}" } },
            { type: "subflow", config: { workflow: "judge", input: {} } },
            { type: "subflow", config: { workflow: "matcher", input: {} }, name: "fuzzy" },
            { type: "exec", config: { cmd: "true" }, policy: "manual", when: "publish", freshnessDays: 3 },
          ],
        },
        human,
      ),
    );
    const [row] = (await listed(STEP)).filter((r) => r.id === id);
    assert.deepEqual(
      row!.checks.map((k) => [k.name, k.policy, k.when, k.publisher]),
      [["exec", "always", "run", "evan"], ["llm", "on_change", "run", "evan"], ["subflow", "on_change", "run", "evan"], ["fuzzy", "always", "run", "evan"], ["exec", "manual", "publish", "evan"]],
    );
    assert.equal(row!.checks[4]!.freshnessDays, 3);
  });

  it("validation: bad specs are refused with nothing written", async () => {
    const bad = async (checks: unknown[], re: RegExp) => assert.match(errOf(await claims.addClaim({ subjects: [STEP], text: "t", checks: checks as never }, chat)), re);
    await bad([], /at least one check/);
    await bad([{}], /`type`.*or.*`description`/s);
    await bad([{ type: "nope/missing" }], /not found/);
    await bad([{ description: "look", config: { a: 1 } }], /without a `type`/);
    await bad([{ description: "look", when: "publish" }], /external check cannot run at publish/);
    await bad([{ type: "exec", config: { cmd: "true" }, policy: "sample" }], /needs a sampleRate/);
    await bad([{ type: "exec", config: { cmd: "true" }, policy: "hourly" }], /policy must be one of/);
    // The check's config gets the same static check a workflow step does.
    await bad([{ type: "exec", config: { command: "true" } }], /not valid for step "exec".*cmd/s);
    await bad([{ type: "exec", config: { cmd: "test", args: ["{{ output.x }}"] } }], /not valid for step "exec"/);
    await bad([{ type: "subflow", config: { workflow: "no-such-workflow", input: {} } }], /closure cannot be resolved.*missing/s);
    assert.match(errOf(await claims.addClaim({ subjects: [STEP], text: "  ", checks: [EXEC] }, chat)), /text is empty/);
    assert.match(errOf(await claims.addClaim({ subjects: [{ kind: "step", name: "exec" }], text: "t", checks: [EXEC] }, chat)), /built-in steps cannot/);
    assert.match(errOf(await claims.addClaim({ subjects: [], text: "t", checks: [EXEC] }, chat)), /at least one subject/);
    assert.equal((await backend.bolt.run(`MATCH (n) WHERE n:Claim OR n:Check RETURN count(n) AS c`))[0]!["c"], 0);
    assert.deepEqual(await claims.validateClaimsArg([{ text: "a", checks: [EXEC] }, { text: "a", checks: [EXEC] }], chat), { error: "claims[1]: the same text appears twice" });
  });

  it("edit_claim: a successor SUPERSEDES it, carries attachments and checks, and starts unknown; evidence stays behind", async () => {
    const old = idOf(await claims.addClaim({ subjects: [STEP, CANDIDATE], text: "the clip contians the quote", checks: [EXEC] }, chat));
    const [check] = (await listed(STEP))[0]!.checks;
    // Evidence on the OLD claim, about the active version.
    const v = (await backend.bolt.run(`MATCH (v:StrutStepVersion {step_type: "clip/compute-times"}) RETURN v.ref_id AS r`))[0]!["r"] as string;
    const oldRef = (await claims.reader.getClaim(old))!.ref_id;
    const checkRef = (await claims.reader.getCheck(check!.id))!.ref_id;
    const e = await backend.nodes.write({ type: "Evidence", data: { id: evidenceId(check!.id, "run-1", "p"), name: "n", content: "ok", evidence_mode: "observed", evidence_status: "collected", observed_at: 100 } });
    await backend.edges.writeMany([
      { edge: "EVIDENCED_BY", source_ref_id: oldRef, target_ref_id: e.ref_id, properties: { strength: 1 } },
      { edge: "PRODUCED_BY", source_ref_id: e.ref_id, target_ref_id: checkRef },
      { edge: "ABOUT", source_ref_id: e.ref_id, target_ref_id: v },
    ]);
    assert.equal((await listed(STEP))[0]!.status, "supported");

    assert.deepEqual(await claims.editClaim(old, "the clip contians the quote", chat), { ok: true, id: old, unchanged: true });
    const edited = await claims.editClaim(old, "the clip contains the quote", chat);
    const successor = idOf(edited);
    assert.notEqual(successor, old);
    assert.equal((edited as { superseded?: string }).superseded, old);

    for (const subject of [STEP, CANDIDATE]) {
      const rows = await listed(subject);
      assert.deepEqual(rows.map((r) => [r.id, r.text, r.status]), [[successor, "the clip contains the quote", "unknown"]], subject.name);
      assert.deepEqual(rows[0]!.checks.map((k) => k.id), [check!.id], "the instrument is carried, never cloned");
    }
    const predecessor = (await claims.reader.getClaim(old))!;
    assert.equal(typeof predecessor.belief_valid_to, "number");
    assert.deepEqual(await backend.bolt.run(`MATCH (a:Claim {id: $a})-[:SUPERSEDES]->(b:Claim {id: $b}) RETURN count(*) AS c`, { a: successor, b: old }), [{ c: 1 }]);
    assert.equal((await claims.reader.evidenceFor(old)).length, 1, "old evidence stays on the old node");
    assert.deepEqual((await claims.reader.claimsTestedBy(check!.id)).map((c) => c.id), [successor], "a check tests exactly ONE active claim");
    assert.match(errOf(await claims.editClaim(old, "again", chat)), /retired or superseded/);

    idOf(await claims.retireClaim(successor, chat));
    assert.deepEqual(await listed(STEP), []);
    assert.equal((await claims.reader.claimsFor({ kind: "step", type: STEP.name }, { includeRetired: true })).length, 2, "retired, never deleted");
  });

  it("edit_check: a successor takes over TESTS and the old check's evidence stops counting; the last check cannot be retired", async () => {
    const claim = idOf(await claims.addClaim({ subjects: [STEP], text: "bounds hold", checks: [EXEC] }, chat));
    const k1 = (await listed(STEP))[0]!.checks[0]!.id;
    const v = (await backend.bolt.run(`MATCH (v:StrutStepVersion {step_type: "clip/compute-times"}) RETURN v.ref_id AS r`))[0]!["r"] as string;
    const e = await backend.nodes.write({ type: "Evidence", data: { id: evidenceId(k1, "run-1", "p"), name: "n", content: "nope", evidence_mode: "observed", evidence_status: "collected", observed_at: 100 } });
    await backend.edges.writeMany([
      { edge: "EVIDENCED_BY", source_ref_id: (await claims.reader.getClaim(claim))!.ref_id, target_ref_id: e.ref_id, properties: { strength: -1 } },
      { edge: "PRODUCED_BY", source_ref_id: e.ref_id, target_ref_id: (await claims.reader.getCheck(k1))!.ref_id },
      { edge: "ABOUT", source_ref_id: e.ref_id, target_ref_id: v },
    ]);
    assert.equal((await listed(STEP))[0]!.status, "refuted");

    assert.deepEqual(await claims.editCheck(k1, { policy: "always" }, chat), { ok: true, id: k1, unchanged: true });
    const k2 = idOf(await claims.editCheck(k1, { config: { cmd: "test", args: [1, "-lt", 2] }, name: "bounds" }, chat));
    const [row] = await listed(STEP);
    assert.deepEqual([row!.status, row!.unverified], ["unknown", 1], "a changed instrument has measured nothing yet");
    assert.deepEqual(row!.checks.map((k) => [k.id, k.name, k.type, k.config, k.policy]), [[k2, "bounds", "exec", { cmd: "test", args: [1, "-lt", 2] }, "always"]]);
    assert.equal(typeof (await claims.reader.getCheck(k1))!.retired_at, "number");
    assert.deepEqual(await backend.bolt.run(`MATCH (:Check {id: $a})-[:SUPERSEDES]->(:Check {id: $b}) RETURN count(*) AS c`, { a: k2, b: k1 }), [{ c: 1 }]);

    assert.match(errOf(await claims.retireCheck(k2, chat)), /last active check/);
    const k3 = idOf(await claims.addCheck(claim, { description: "listen to the cut — code cannot hear" }, chat));
    idOf(await claims.retireCheck(k2, chat));
    assert.deepEqual((await listed(STEP))[0]!.checks.map((k) => k.id), [k3]);
    assert.match(errOf(await claims.retireCheck(k1, chat)), /retired or superseded/);
  });

  it("attach / detach: one node shared across subjects, idempotent, restorable, and never orphaned", async () => {
    const id = idOf(await claims.addClaim({ subjects: [SEEDED], text: "answer is a bare string", checks: [EXEC] }, human));
    assert.deepEqual(await claims.attachClaim(id, CANDIDATE, chat), { ok: true, id, attached: true });
    assert.deepEqual(await claims.attachClaim(id, CANDIDATE, chat), { ok: true, id, attached: false }, "idempotent");
    assert.deepEqual((await listed(CANDIDATE)).map((r) => r.id), [id]);
    assert.equal((await backend.bolt.run(`MATCH (c:Claim) RETURN count(c) AS c`))[0]!["c"], 1, "attached, never copied");

    assert.deepEqual(await claims.detachClaim(id, CANDIDATE, chat), { ok: true, id, detached: true });
    assert.deepEqual(await listed(CANDIDATE), []);
    assert.deepEqual(await claims.detachClaim(id, CANDIDATE, chat), { ok: true, id, detached: false });
    assert.match(errOf(await claims.detachClaim(id, SEEDED, chat)), /only subject — retire the claim/);
    assert.deepEqual(await claims.attachClaim(id, CANDIDATE, chat), { ok: true, id, attached: true }, "a detached (muted) edge is restored");
    assert.deepEqual((await listed(CANDIDATE)).map((r) => r.id), [id]);
  });

  it("fixed point 1 — the meta surface only touches what it stamped, on subjects it published", async () => {
    const seeded = idOf(await claims.addClaim({ subjects: [SEEDED], text: "answer is a bare string", checks: [EXEC] }, human));
    const seededCheck = (await listed(SEEDED))[0]!.checks[0]!.id;

    // The lineage move works: attach the seeded contract to an ai-published candidate…
    assert.deepEqual(await authoring.attachClaim(seeded, CANDIDATE), { ok: true, id: seeded, attached: true });
    // …but the contract cannot be dropped, softened, or papered over.
    assert.match(errOf(await authoring.detachClaim(seeded, CANDIDATE)), /only detaches claims it wrote/);
    assert.match(errOf(await authoring.editClaim(seeded, "answer is anything")), /only edits claims it wrote/);
    assert.match(errOf(await authoring.retireClaim(seeded)), /only retires claims it wrote/);
    assert.match(errOf(await authoring.addCheck(seeded, EXEC)), /only adds checks to claims it wrote/);
    assert.match(errOf(await authoring.editCheck(seededCheck, { config: { cmd: "false" } })), /only edits checks it wrote/);
    assert.match(errOf(await authoring.retireCheck(seededCheck)), /only retires checks it wrote/);
    // Nor may it write claims onto a subject it did not publish.
    assert.match(errOf(await authoring.addClaim({ subjects: [SEEDED], text: "mine", checks: [EXEC] })), /only adds claims to subjects it authored/);
    assert.match(errOf(await authoring.attachClaim(seeded, SEEDED)), /only attaches claims to subjects it authored/);

    // Its OWN claims on its own candidate: the full surface.
    const own = idOf(await authoring.addClaim({ subjects: [CANDIDATE], text: "cites its sources", checks: [EXEC] }));
    const ownCheck = ((await authoring.listClaims(CANDIDATE)) as { claims: Array<{ id: string; checks: Array<{ id: string }> }> }).claims.find((c) => c.id === own)!.checks[0]!.id;
    idOf(await authoring.editCheck(ownCheck, { name: "cites" }));
    const reworded = idOf(await authoring.editClaim(own, "cites every source it used"));
    idOf(await authoring.retireClaim(reworded));
    // Reading a seeded contract is allowed — the producer is MEANT to see it.
    assert.equal(((await authoring.listClaims(SEEDED)) as { claims: unknown[] }).claims.length, 1);
    // The human-supervised chat surface is not scoped.
    idOf(await claims.addCheck(seeded, EXEC, chat));
  });

  it("fixed point 2 — an ai-stamped check may never reach a grader: by name, through a subflow, via a grant, or unresolvably", async () => {
    await ws.publishWorkflowByContent("sneaky", "name: sneaky\nsteps:\n  - id: g\n    type: gaia/evaluate\n    config: {}\n");
    await ws.publishWorkflowByContent("granting", "name: granting\nsteps:\n  - id: a\n    type: agent\n    config: { prompt: go, agentTools: ['gaia/*'] }\n");
    const refuse = async (check: Record<string, unknown>, re: RegExp) => {
      for (const actor of [chat, meta]) assert.match(errOf(await claims.addClaim({ subjects: [CANDIDATE], text: "scores well", checks: [check as never] }, actor)), re);
    };
    await refuse({ type: "gaia/evaluate", config: {} }, /harness-only step \(gaia\/evaluate\)/);
    await refuse({ type: "subflow", config: { workflow: "sneaky", input: {} } }, /harness-only step \(gaia\/evaluate\)/);
    await refuse({ type: "subflow", config: { workflow: "granting", input: {} } }, /harness-only step \(gaia\/\*\)/);
    await refuse({ type: "agent", config: { prompt: "grade", agentTools: ["meta/*"] } }, /harness-only step \(meta\/\*\)/);
    await refuse({ type: "subflow", config: { workflow: "{{ input.output.wf }}", input: {} } }, /closure cannot be resolved/);
    assert.match(errOf(await authoring.createStep("cand/x", STEP_SRC("cand/x"), "d", [{ text: "t", checks: [{ type: "gaia/evaluate" }] }])), /Nothing was published.*harness-only/s);
    assert.ok(!(await ws.listSteps()).some((s) => s.type === "cand/x"), "an invalid contract blocks the publish");

    // A person (or a seeder) wiring the harness as a check is not the producer.
    idOf(await claims.addClaim({ subjects: [SEEDED], text: "accuracy ≥ baseline", checks: [{ type: "subflow", config: { workflow: "sneaky", input: {} } }] }, human));
    // STRUT_VERIFY_DENY extends the list per deployment.
    const strict = buildClaimsAuthoring({ graph: backend, workspace: ws, getRegistry, env: { STRUT_VERIFY_DENY: "log" } });
    assert.match(errOf(await strict.addClaim({ subjects: [CANDIDATE], text: "t", checks: [{ type: "log", config: { message: "x" } }] }, chat)), /harness-only step \(log\)/);
  });

  it("both doors, end to end: the capability publishes with a contract; the chat tools offer the claims surface", async () => {
    const contract = [{ text: "returns a tag", checks: [{ type: "exec", config: { cmd: "test", args: ["-n", "{{ input.output.tag }}"] } }] }];
    const created = (await authoring.createStep("cand/step", STEP_SRC("cand/step"), "d", contract)) as { ok?: true; claims?: { count: number; added: number } };
    assert.deepEqual([created.ok, created.claims?.count, created.claims?.added], [true, 1, 1]);
    const edited = (await authoring.editStep("cand/step", STEP_SRC("cand/step", "two"), "d", contract)) as { claims?: { count: number; added: number; existing: number } };
    assert.deepEqual(edited.claims, { count: 1, added: 0, existing: 1 });
    const bare = (await authoring.publishWorkflow("candidate-2", "name: candidate-2\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n")) as { claims?: { count: number; warning?: string } };
    assert.equal(bare.claims?.count, 0);
    assert.match(bare.claims!.warning!, /NO claims/);

    const deps = { workspace: ws, registry, store: new MemoryRunStore(), getRegistry };
    const tools = buildTools(deps) as Record<string, { inputSchema: z.ZodObject; execute: (a: unknown) => Promise<Record<string, unknown>> }>;
    for (const t of ["add_claim", "list_claims", "edit_claim", "retire_claim", "attach_claim", "detach_claim", "add_check", "edit_check", "retire_check"]) assert.ok(tools[t], t);
    for (const t of ["create_step", "edit_step", "create_workflow", "edit_workflow"]) assert.ok("claims" in tools[t]!.inputSchema.shape, t);
    assert.ok((await buildSystem(deps)).includes(CLAIMS_SECTION));

    const wf = await tools["create_workflow"]!.execute({
      name: "youtube-clip",
      yaml: "name: youtube-clip\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n",
      claims: [{ text: "the clip's audio contains the requested quote", checks: [{ description: "play the clip — no STT step is wired yet" }] }],
    });
    assert.deepEqual([wf["ok"], (wf["claims"] as { count: number }).count], [true, 1]);
    const listing = await tools["list_claims"]!.execute({ subject: { kind: "workflow", name: "youtube-clip" } });
    assert.deepEqual((listing["claims"] as Array<{ status: string; checks: Array<{ external: boolean }> }>).map((c) => [c.status, c.checks[0]!.external]), [["unknown", true]]);
    const blocked = await tools["edit_workflow"]!.execute({ name: "youtube-clip", yaml: "name: youtube-clip\nsteps:\n  - id: b\n    type: log\n    config: { message: v2 }\n", claims: [{ text: "x", checks: [{ type: "nope" }] }] });
    assert.match(String(blocked["error"]), /Nothing was published/);
    assert.deepEqual((await ws.getWorkflowMetadata("youtube-clip"))!.active, "v1", "no version was published");
  });
});
