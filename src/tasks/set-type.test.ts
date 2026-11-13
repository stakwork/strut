/**
 * `task/set-type` (plans/human-steps.md §9.8, §9.11, ruled §9.12): the
 * builder ASKS for a task type, an ADMIN says yes. The step runs only as a
 * proposal an admin accepted, and the door behind it (`taskTypes.save`)
 * opens only for that accepted record on disk; its input is checked as the
 * store checks a type before any proposal is made; it is merged over the
 * type; the card says what changes, marks a missing or unfit app and a rise
 * in pay as dangers, and shows no test's expected answer; only the builder
 * seed grants and gates it. `task/types` reads what is there.
 */
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { zodSchema } from "ai";

import { createStrut, type Strut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import type { StepContext } from "../core.js";
import { gatedSchema, type Proposal } from "../proposals.js";
import { personToken, signInTicket } from "../auth.js";
import { buildRegistryTools } from "../steps/core/agent.js";
import { RUN_STEP_FLOW } from "../run-step.js";
import { builderWorkflowYaml } from "../builder-seed.js";
import { jobWorkflowYaml } from "../job-seed.js";
import { orchestratorWorkflowYaml } from "../orchestrator-seed.js";
import { globToRegExp } from "../closure.js";
import { formProblem as kitFormProblem } from "../../kit/src/folds/answer-form.js";
import { answerText, formProblem, mergeType, typeCard, typeChangeInput, type TaskTypeRow, type TaskTypesCapability } from "./set-type.js";
import type { TaskType } from "./task-store.js";

const KEY = "set-type-key";
const PEER_KEY = "set-type-peer-key";
const SECRET = "the-expected-answer-5e1d";
const MATCH = { type: "object", properties: { same: { type: "boolean", title: "The same pet?" }, note: { type: "string", maxLength: 200 } }, required: ["same"] };
const BOX = { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 };

/** A type as the store keeps it, as `list()` reads it. */
const row = (o: Partial<TaskTypeRow> = {}): TaskTypeRow => ({
  name: "pet-match",
  app: "workers",
  answer: MATCH as TaskType["answer"],
  leaseSeconds: 600,
  withinHours: 72,
  enabled: true,
  holdHours: 72,
  changedAt: 1,
  open: 0,
  workers: 0,
  answeredWeek: 0,
  ...o,
});
const field = (card: ReturnType<typeof typeCard>, label: string) => card.fields?.find((f) => f.label === label);

// ── the pure parts ──────────────────────────────────────────────────────────

describe("task/set-type: its input, the merge and the card", () => {
  it("the input is checked as the store checks a type: a shape strut cannot check, a bad rule, a bad name or pay is refused", () => {
    assert.ok(typeChangeInput.safeParse({ name: "pet-match", app: "workers", answer: MATCH }).success);
    assert.ok(typeChangeInput.safeParse({ name: "acme/pet-match", app: "workers" }).success, "a change needs no answer");
    const refused = (input: Record<string, unknown>, re: RegExp) => {
      const r = typeChangeInput.safeParse({ name: "pet-match", app: "workers", ...input });
      assert.equal(r.success, false, JSON.stringify(input));
      assert.match(r.error!.message, re, JSON.stringify(input));
    };
    refused({ answer: { type: "object", properties: { x: { type: "string", pattern: "^a" } } } }, /answer: .*pattern/);
    refused({ answer: { properties: {} } }, /answer: /);
    refused({ tests: { rate: 2 } }, /tests\.rate is a share/);
    refused({ tests: { nope: 1 } }, /tests\.nope is not a test rule/);
    refused({ copies: { max: 11 } }, /copies\.max is a whole number from 1 to 10/);
    refused({ copies: { agree: 4, max: 3 } }, /copies\.agree/);
    refused({ paySats: 1.0001 }, /to the msat/);
    refused({ paySats: -1 }, /paySats|too_small|>=/i);
    refused({ holdHours: 0 }, /holdHours|too_small|>=/i);
    refused({ leaseSeconds: 1.5 }, /leaseSeconds|int/i);
    refused({ name: "Pet Match" }, /lowercase letters/);
    assert.ok(typeChangeInput.safeParse({ name: "x", app: "a", tests: null, copies: null }).success, "null turns them off");
    // What the model is handed: a JSON Schema, `rationale` beside the fields.
    const gated = gatedSchema(typeChangeInput);
    assert.ok(gated instanceof z.ZodObject);
    const json = zodSchema(gated).jsonSchema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(json.properties), ["name", "app", "answer", "leaseSeconds", "withinHours", "enabled", "paySats", "holdHours", "tests", "copies", "rationale"]);
    assert.deepEqual(json.required, ["name", "app"]);
  });

  it("the merge keeps what is left out and merges tests and copies over the type's own; null turns them off; a new type needs answer", () => {
    const was = row({ paySats: 21, holdHours: 24, tests: { rate: 0.1, newRate: 0.25, newTasks: 50, qualify: 5, window: 20, minGraded: 10, threshold: 0.9, grade: "equal", gradeCapUsd: 0.05 }, copies: { max: 3, agree: 2, compare: "equal", onDisagree: "more" } });
    assert.deepEqual(mergeType("pet-match", was, { app: "workers", leaseSeconds: 900, tests: { qualify: 2 } }), {
      app: "workers",
      answer: MATCH,
      leaseSeconds: 900,
      withinHours: 72,
      enabled: true,
      paySats: 21,
      holdHours: 24,
      tests: { ...was.tests, qualify: 2 },
      copies: was.copies,
    });
    const off = mergeType("pet-match", was, { app: "workers", tests: null, copies: null, paySats: 0 });
    assert.equal(off.tests, null);
    assert.equal(off.copies, null);
    assert.equal(off.paySats, 0);
    assert.deepEqual(mergeType("new", undefined, { app: "workers", answer: BOX }), { app: "workers", answer: BOX });
    assert.throws(() => mergeType("new", undefined, { app: "workers" }), /^TaskError: bad_request: task type new is new: it needs answer/);
  });

  it("the card's flat-form check gives the kit's verdict, and the answer reads one line per field", () => {
    const schemas: unknown[] = [
      MATCH,
      BOX,
      { type: "object", properties: {} },
      { type: "object", properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 } } },
      { type: "object", properties: { pts: { type: "array", items: { type: "number" } } } },
      { type: "object", properties: { where: { type: "object", properties: { x: { type: "number" } } } } },
      { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5 }, kind: { type: "string", enum: ["cat", "dog"] } } },
      { type: "string", enum: ["a"] },
      null,
    ];
    for (const s of schemas) assert.equal(formProblem(s), kitFormProblem(s), JSON.stringify(s));
    assert.equal(answerText(MATCH), 'same ("The same pet?"): yes or no, required\nnote: text up to 200 characters');
    assert.equal(
      answerText({ type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5 }, kind: { type: "string", enum: ["cat", "dog"] }, tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 } }, required: ["kind"] }),
      "n: a whole number from 1 to 5\nkind: one of cat, dog, required\ntags: any of a, b (at least 1)",
    );
    assert.match(answerText(BOX), /^needs the app's own view \(the answer is not an object of fields\):\n\{"type":"array"/);
  });

  it("the card for a new type: its fields, nobody granted, no answer marked when none is given", () => {
    const card = typeCard({ name: "pet-match", app: "workers", answer: MATCH, withinHours: 48 });
    assert.equal(card.title, "New task type pet-match");
    assert.deepEqual(card.actions, { accept: "Save type", reject: "Don't" });
    assert.deepEqual(
      card.fields!.map((f) => [f.label, f.value, !!f.danger]),
      [
        ["Drawn by", "workers", false],
        ["The answer", 'same ("The same pet?"): yes or no, required\nnote: text up to 200 characters', false],
        ["Lease", "10 minutes", false],
        ["Expires after", "48 hours unanswered", false],
        ["On", "on", false],
        ["Workers", "none: this grants it to nobody — an admin grants workers in Tasks and workers (strut/staff)", false],
        ["Pay", "unpaid", false],
        ["Tests", "off", false],
        ["Copies", "off: a step asks one worker", false],
      ],
    );
    assert.match(card.summary!, /^A new task type pet-match, drawn by the app workers: .* It grants it to no worker: an admin does, in Tasks and workers\.$/);
    // A new type with no answer: the card says so as a danger, and that accepting fails.
    const none = typeCard({ name: "pet-match", app: "workers" });
    assert.equal(field(none, "The answer")?.danger, true);
    assert.match(field(none, "The answer")!.value, /none given — task type pet-match is new: it needs answer/);
    assert.match(none.summary!, /Accepting it fails: task type pet-match is new: it needs answer/);
    // A paid new type: in sats and dollars at the rate, a rise from nothing, so a danger.
    const paid = typeCard({ name: "pet-match", app: "workers", answer: MATCH, paySats: 10, tests: { qualify: 3 }, copies: { max: 2, agree: 2 } }, { usdPerBtc: 100_000 });
    assert.deepEqual(field(paid, "Pay"), { label: "Pay", value: "10 sats an answer ($0.01), held 72 hours before it can be withdrawn", danger: true });
    assert.match(paid.summary!, /Its pay rises from nothing to 10 sats an answer \(\$0\.01\)\./);
    assert.match(field(paid, "Tests")!.value, /^on: 5% of tasks are tests \(25% until a worker has answered 50 real ones\); 3 tests to qualify before any real task; a grant is revoked under 80% passed of the last 20 graded, read once 10 are; graded by equal answers$/);
    assert.equal(field(paid, "Copies")!.value, "on: a step may ask up to 2 workers, each paid; 2 matching answers settle a task, compared by equal answers; when they disagree one more worker is asked, up to 2");
  });

  it("the card for a change: each field before and after, the pay rise a danger with the last week's cost, the app's problem a danger; a cut in pay is none", () => {
    const was = row({ paySats: 10, open: 3, workers: 4, answeredWeek: 40 });
    const card = typeCard({ name: "pet-match", app: "pets", answer: { ...MATCH, required: ["same", "note"] }, paySats: 25, leaseSeconds: 1200, tests: { rate: 0.1 } }, { existing: was, usdPerBtc: 100_000, appProblem: "app pets does not grant task/submit: its page cannot answer this type's tasks" });
    assert.equal(card.title, "Change task type pet-match");
    assert.deepEqual(field(card, "Drawn by"), { label: "Drawn by", value: "pets — app pets does not grant task/submit: its page cannot answer this type's tasks", danger: true });
    assert.equal(
      field(card, "What changes")!.value,
      ["drawn by: workers → pets", "answer: a new shape (see The answer)", "lease: 10 minutes → 20 minutes", "pay: 10 sats → 25 sats", "tests: off → on"].join("\n"),
    );
    assert.equal(field(card, "Open tasks")!.value, "3: their answers are checked against the new shape when submitted");
    assert.equal(field(card, "Workers")!.value, "4 hold it");
    assert.deepEqual(field(card, "Pay"), {
      label: "Pay",
      value: "25 sats an answer ($0.03), held 72 hours before it can be withdrawn; now 10 sats ($0.01). The last week's 40 answers would have cost 1,000 sats ($1.00), against 400 sats ($0.40) at the pay now",
      danger: true,
    });
    assert.match(card.summary!, /^Changes the task type pet-match: drawn by, answer, lease, pay, tests\. Workers cannot answer it yet: app pets does not grant task\/submit.* Its pay rises from 10 sats to 25 sats an answer \(\$0\.03\)\.$/);
    // Rules merged over the type's own, key by key.
    const tested = row({ tests: { rate: 0.05, newRate: 0.25, newTasks: 50, qualify: 10, window: 20, minGraded: 10, threshold: 0.8, grade: "equal", gradeCapUsd: 0.05 } });
    assert.equal(field(typeCard({ name: "pet-match", app: "workers", tests: { qualify: 5, threshold: 0.9 } }, { existing: tested }), "What changes")!.value, "tests: qualify 10 → 5, threshold 0.8 → 0.9");
    // A merge the save would refuse: K over the type's own window.
    const tooMany = typeCard({ name: "pet-match", app: "workers", tests: { window: 4 } }, { existing: tested });
    assert.deepEqual(field(tooMany, "Tests"), { label: "Tests", value: "refused: tests.qualify is a whole number from 0 to 4", danger: true });
    assert.match(tooMany.summary!, /Accepting it fails: tests\.qualify is a whole number from 0 to 4\.$/);
    // A cut in pay is no danger; unchanged, the card says so.
    const cut = typeCard({ name: "pet-match", app: "workers", paySats: 5 }, { existing: was });
    assert.equal(field(cut, "Pay")!.danger, undefined);
    assert.equal(field(typeCard({ name: "pet-match", app: "workers" }, { existing: was }), "What changes")!.value, "nothing: the type is already so");
    // Turned off: its own title, and what becomes of its open tasks.
    const off = typeCard({ name: "pet-match", app: "workers", enabled: false }, { existing: was });
    assert.equal(off.title, "Turn off task type pet-match");
    assert.equal(field(off, "On")!.value, "off");
    assert.equal(field(off, "Open tasks")!.value, "3: not handed out once it is off; they expire when due");
    assert.match(off.summary!, /^Turns off the task type pet-match: a `human` step can make no new task of it/);
  });
});

// ── on a strut ──────────────────────────────────────────────────────────────

describe("task/set-type on a strut: the builder asks, an admin says yes", () => {
  let root: string;
  let strut: Strut;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of ["STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER_KEY;
    process.env["STRUT_SECRET_KEY"] = "set-type-secret";
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-set-type-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
      stt: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      staff: false,
      jamie: false,
      knowledge: false,
      earnings: false,
      concepts: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }) },
    });
  });
  afterEach(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${KEY}` };
  const taskTypes = () => (strut.services as { taskTypes: TaskTypesCapability }).taskTypes;
  const step = (type: string) => strut.getRegistry()[type]!;
  const ctx = (extra: Partial<StepContext> = {}): StepContext => ({
    runId: "r1",
    path: "builder/turn",
    scope: {},
    input: undefined,
    emit: async () => {},
    services: strut.services,
    registry: strut.getRegistry(),
    job: "j1",
    actor: "ann",
    principal: "ann",
    ...extra,
  });
  type Tool = { inputSchema: z.ZodTypeAny; execute: (input: unknown, o?: { strutToolPath?: string }) => Promise<unknown> };
  let calls = 0;
  /** The builder's gated tool call: a proposal, or the error the model reads. */
  const ask = async (input: Record<string, unknown>, extra: Partial<StepContext> = {}) => {
    const tool = buildRegistryTools(["task/set-type"], strut.getRegistry(), ctx(extra), (d: unknown) => d, { approve: new Set(["task/set-type"]), session: "s1" })["task_set_type"] as Tool;
    return tool.execute(input, { strutToolPath: `builder/turn/${String(++calls).padStart(3, "0")}-task_set_type` }) as Promise<{ proposal: string; status: string; title: string } | string>;
  };
  const record = async (id: string): Promise<Proposal> => (await (strut.services as { proposals: { get(id: string): Promise<Proposal | null> } }).proposals.get(id))!;
  const proposals = async () => (strut.services as { proposals: { list(): Promise<Proposal[]> } }).proposals.list();
  const signIn = async (actor: string, role: "admin" | "member") => {
    const res = await strut.app.request("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: signInTicket(actor, role)!.ticket }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const decide = async (id: string, headers: Record<string, string>, body: Record<string, unknown> = { action: "accept" }) => {
    const res = await strut.app.request(`/proposals/${id}/decide`, { method: "POST", headers: { "content-type": "application/json", "x-strut-ui": "1", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Proposal & { error?: string } };
  };
  const types = async () => ((await (await strut.app.request("/tasks/types", { headers: auth })).json()) as { types: TaskType[] }).types;

  it("task/types lists what is there: each type with its app, shape, on or off, pay, its open tasks, how many hold it and its week — never who", async () => {
    assert.deepEqual(await step("task/types").run({}, ctx()), { types: [] });
    const cap = strut.tasks.capability;
    await cap.setType("pet-match", { app: "workers", answer: MATCH, paySats: 21 }, "ada");
    await cap.setType("boxes", { app: "workers", answer: BOX, enabled: false }, "ada");
    await cap.grant("w1", "pet-match", "ada");
    await cap.grant("w2", "pet-match", "ada");
    for (const n of [1, 2]) await cap.ensure({ type: "pet-match", workflow: "pets", runId: `r${n}`, path: "pets/review" });
    const lease = (await strut.tasks.worker.next("w1", { type: "pet-match" })) as { lease: string };
    await strut.tasks.worker.submit("w1", { lease: lease.lease, answer: { same: true } });

    const listed = ((await step("task/types").run({}, ctx())) as { types: TaskTypeRow[] }).types;
    const pets = listed.find((t) => t.name === "pet-match")!;
    assert.deepEqual([pets.app, pets.enabled, pets.paySats, pets.open, pets.workers, pets.answeredWeek], ["workers", true, 21, 1, 2, 1]);
    assert.deepEqual(pets.answer, MATCH);
    assert.equal("changedBy" in pets, false, "who saved it is the staff's to read");
    const boxes = listed.find((t) => t.name === "boxes")!;
    assert.deepEqual([boxes.enabled, boxes.open, boxes.workers, boxes.answeredWeek], [false, 0, 0, 0]);
    assert.ok(!JSON.stringify(listed).includes("w1") && !JSON.stringify(listed).includes("w2"), "no worker named");
  });

  it("runs only as an accepted proposal: a direct call, a workflow's step, meta/run-step, a subflow and a custom step's call of the door are refused", async () => {
    const cfg = { name: "pet-match", app: "workers", answer: MATCH };
    await assert.rejects(step("task/set-type").run(cfg, ctx()), /runs only as a proposal an admin accepted/);
    await assert.rejects(step("task/set-type").run(cfg, ctx({ agentTool: true })), /runs only as a proposal an admin accepted/);
    const authoring = (strut.services as unknown as { authoring: { runStep(t: string, a: unknown): Promise<{ error?: string }> } }).authoring;
    assert.ok((await authoring.runStep("task/set-type", { config: cfg })).error, "meta/run-step may not run it");
    await strut.workspace.publishWorkflow("direct", "v1", { steps: [{ id: "s", type: "task/set-type", config: cfg }] });
    await strut.workspace.publishWorkflow("wrap", "v1", { steps: [{ id: "sub", type: "subflow", config: { workflow: "direct", input: {} } }] });
    for (const wf of ["direct", "wrap"]) {
      const res = await strut.run(wf, {});
      assert.equal(res.status, "error", wf);
      assert.match(JSON.stringify(res.error), /runs only as a proposal an admin accepted/, wf);
    }
    // Any step reaches the shared bag, a custom step the builder wrote included: its save opens nothing.
    await strut.workspace.publishStep(
      "test/sneak",
      `import { z, defineStep } from "strut";
export default defineStep({ type: "test/sneak", input: z.object({}), output: z.any(), async run(_cfg, ctx) {
  return ctx.services.taskTypes.save("pet-match", { app: "workers", answer: { type: "boolean" } }, { proposal: "AAAAAAAAAAAA", actor: "ann" });
} });`,
    );
    await strut.rebuildRegistry();
    await strut.workspace.publishWorkflow("sneak", "v1", { steps: [{ id: "s", type: "test/sneak", config: {} }] });
    const sneak = await strut.run("sneak", {});
    assert.equal(sneak.status, "error");
    assert.match(JSON.stringify(sneak.error), /set_type_needs_admin: saving the task type pet-match runs only as the apply of a proposal an admin accepted for it/);
    assert.deepEqual(await types(), [], "nothing saved");
  });

  it("a forged ctx.proposal saves nothing: no record, a pending one, or another name's", async () => {
    const forged = (id: string) => ctx({ proposal: { id, by: { workflow: "builder", runId: "r0" } } });
    await assert.rejects(step("task/set-type").run({ name: "pet-match", app: "workers", answer: MATCH }, forged("nope-nope-nope")), /^Error: set_type_needs_admin: /);
    const asked = (await ask({ name: "pet-match", app: "workers", answer: MATCH })) as { proposal: string };
    await assert.rejects(step("task/set-type").run({ name: "pet-match", app: "workers", answer: MATCH }, forged(asked.proposal)), /set_type_needs_admin: .*proposal \S+ is pending, for task\/set-type pet-match/);
    await assert.rejects(taskTypes().save("other", { app: "workers", answer: MATCH }, { proposal: asked.proposal }), /set_type_needs_admin/);
    assert.deepEqual(await types(), []);
  });

  it("the builder's call is a proposal with the card; a shape strut cannot check is refused before any proposal; a member's accept is admin_required, an admin's saves it with changedBy", async () => {
    // Refused to the model, nothing recorded.
    const bad = await ask({ name: "pet-match", app: "workers", answer: { type: "object", properties: { x: { type: "string", format: "email" } } } });
    assert.match(String(bad), /^Error: invalid input for "task\/set-type": [\s\S]*"answer: schema\.properties\.x: \\"format\\" is not a keyword strut checks/);
    assert.deepEqual(await proposals(), []);

    const out = (await ask({ name: "pet-match", app: "workers", answer: MATCH, paySats: 10, rationale: "Low-confidence matches go to a person." })) as { proposal: string; status: string; title: string };
    assert.equal(out.status, "pending");
    assert.equal(out.title, "New task type pet-match");
    const rec = await record(out.proposal);
    assert.equal(rec.step, "task/set-type");
    assert.equal(rec.approver, "admin");
    assert.deepEqual(rec.input, { name: "pet-match", app: "workers", answer: MATCH, paySats: 10 });
    assert.equal(rec.card?.actions.accept, "Save type");
    // No app named workers here: a danger on the card.
    assert.deepEqual(rec.card?.fields.find((f) => f.label === "Drawn by"), { label: "Drawn by", value: "workers — no app workers on this server", danger: true });
    assert.deepEqual(rec.card?.fields.find((f) => f.label === "Pay"), { label: "Pay", value: "10 sats an answer ($0.01), held 72 hours before it can be withdrawn", danger: true });

    // A member is refused: their own page's accept (strut's own app, `proposal/decide`), their
    // session at the route, and their person token. Nothing saved, still pending.
    const page = ctx({ app: { name: "strut/jamie", version: "v1", firstParty: true }, workflow: RUN_STEP_FLOW, path: `${RUN_STEP_FLOW}/decide` });
    await assert.rejects(step("proposal/decide").run({ id: out.proposal, action: "accept" }, page), /^Error: admin_required: only an admin of this strut server accepts "New task type pet-match" \(task\/set-type\)/);
    assert.equal((await decide(out.proposal, { cookie: await signIn("bo", "member") })).status, 403, "a member's session reaches no route but the apps");
    const person = await decide(out.proposal, { authorization: `Bearer ${personToken("ann")!.token}` });
    assert.equal(person.status, 403);
    assert.match(person.body.error!, /^admin_required: /);
    assert.equal((await record(out.proposal)).status, "pending");
    assert.deepEqual(await types(), []);

    // An admin's yes saves it, the admin as changedBy; the record opens the door no more.
    const admin = await decide(out.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.status, "applied", JSON.stringify(admin.body.result));
    const [saved] = await types();
    assert.deepEqual([saved!.name, saved!.app, saved!.paySats, saved!.enabled, saved!.leaseSeconds, saved!.changedBy], ["pet-match", "workers", 10, true, 600, "ada"]);
    assert.deepEqual(saved!.answer, MATCH);
    await assert.rejects(taskTypes().save("pet-match", { app: "workers", answer: MATCH, paySats: 10 }, { proposal: out.proposal }), /set_type_needs_admin: .*is applied/);
  });

  it("a change is merged over the type, the admin's edits merged and checked again; it grants no worker; the card never shows a test's expected answer", async () => {
    const cap = strut.tasks.capability;
    await cap.setType("pet-match", { app: "workers", answer: MATCH, paySats: 10, holdHours: 24, withinHours: 48, tests: { qualify: 0 } }, "ada");
    // A test of the type, its expected answer the secret.
    await strut.tasks.tests.create({ type: "pet-match", show: { lost: "a.jpg" }, expected: { same: true, note: SECRET } }, "ada");
    await cap.grant("w1", "pet-match", "ada");
    await cap.ensure({ type: "pet-match", workflow: "pets", runId: "r1", path: "pets/review" });

    const out = (await ask({ name: "pet-match", app: "workers", paySats: 25, tests: { rate: 0.2 } })) as { proposal: string; title: string };
    assert.equal(out.title, "Change task type pet-match");
    const rec = await record(out.proposal);
    assert.ok(!JSON.stringify(rec).includes(SECRET), "no expected answer on the record or its card");
    const fields = Object.fromEntries(rec.card!.fields.map((f) => [f.label, f]));
    assert.equal(fields["What changes"]!.value, "pay: 10 sats → 25 sats\ntests: rate 0.05 → 0.2");
    assert.equal(fields["Open tasks"]!.value, "1");
    assert.equal(fields["Workers"]!.value, "1 hold it");
    assert.equal(fields["Pay"]!.danger, true);
    assert.match(fields["Pay"]!.value, /^25 sats an answer \(\$0\.03\), held 24 hours before it can be withdrawn; now 10 sats \(\$0\.01\)\. No answers in the last week$/);

    // The admin's edit that breaks the shape: 400, still pending, nothing changed.
    const broken = await decide(out.proposal, auth, { action: "accept", input: { answer: { type: "object", properties: { x: { type: "string", pattern: "a" } } } } });
    assert.equal(broken.status, 400);
    assert.equal((await record(out.proposal)).status, "pending");
    assert.equal((await types())[0]!.paySats, 10);
    // The admin lowers the pay: their edit is what is saved; the rest kept, the tests merged.
    const accepted = await decide(out.proposal, { cookie: await signIn("ada", "admin") }, { action: "accept", input: { paySats: 15 } });
    assert.equal(accepted.body.status, "applied", JSON.stringify(accepted.body.result));
    const [t] = await types();
    assert.deepEqual([t!.paySats, t!.holdHours, t!.withinHours, t!.app, t!.changedBy, t!.tests?.rate, t!.tests?.qualify], [15, 24, 48, "workers", "ada", 0.2, 0]);
    assert.deepEqual(t!.answer, MATCH, "the shape kept");
    // It granted nobody and changed no worker.
    const workers = ((await (await strut.app.request("/tasks/workers", { headers: auth })).json()) as { workers: Array<{ actor: string; status: string; grants: Array<{ type: string; by: string }> }> }).workers;
    assert.deepEqual(workers.map((w) => [w.actor, w.status, w.grants.map((g) => [g.type, g.by])]), [["w1", "active", [["pet-match", "ada"]]]]);
  });
});

// ── the seeds ───────────────────────────────────────────────────────────────

describe("task/set-type in the seeds: the builder's alone", () => {
  type Params = { tools: string[]; approve?: string[] };
  const params = (text: string) => (yaml.load(text) as { params: Params }).params;
  const reaches = (grants: string[], type: string) => grants.some((g) => globToRegExp(g).test(type));

  it("the builder grants task/types and task/set-type and gates task/set-type; job and orchestrator reach neither", async () => {
    const builder = params(await builderWorkflowYaml());
    assert.ok(builder.tools.includes("task/types") && builder.tools.includes("task/set-type"));
    assert.ok(builder.approve?.includes("task/set-type"), "a proposal: an admin's yes");
    assert.ok(!reaches(builder.tools, "task/next") && !reaches(builder.tools, "task/submit"), "never a worker's steps");
    for (const [name, text] of [["job", await jobWorkflowYaml()], ["orchestrator", await orchestratorWorkflowYaml()]] as const) {
      const p = params(text);
      for (const type of ["task/types", "task/set-type"]) assert.ok(!reaches(p.tools, type), `${name} does not grant ${type}`);
    }
  });
});
