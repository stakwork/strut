import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { createStrut, type Strut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { appIdentity, signInTicket } from "../auth.js";
import { treeHash } from "../version.js";
import { hostConfigFromEnv } from "../server.js";
import { defineStep, type RunEvent, type RunSummary, type StepContext } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { createRegistry } from "../steps/registry.js";
import { kitForTests } from "../test-util/app-kit.js";
import { readFile } from "node:fs/promises";
import { STEP_RUN_TOOL, redactedConfig } from "./tools.js";
import { STAFF_APP, STAFF_DIR, seedStaffApp } from "./staff-seed.js";
import { answerSchemaProblem } from "../tasks/answer-schema.js";
import { inProcessDoor, STAFF_ROUTES } from "../steps/lib/_admin-door.js";
import { KINDS, modelOf, modelProblem, newField, parseOptions, schemaOf, withKind, type AnswerModel, type FieldModel } from "./staff/src/lib/schema.js";
import {
  fmtWhen, inputOf, leaseOutcome, owedLine, placeOf, queueWarnings, reviewSummary, reviewText, shortActor, shownOf, standingLow, standingText, testsAnswerOf, typeNameProblem, whoOf, workersInOrder,
} from "./staff/src/lib/view.js";
import { draftOf, saveOf, shapeChanged } from "./staff/src/lib/draft.js";
import type { TaskStats, TaskType, Worker } from "./staff/src/lib/types.js";
import statsStep from "../steps/lib/staff/stats.js";
import saveTestStep from "../steps/lib/staff/save-test.js";

/**
 * `strut/staff` (plans/human-steps.md §9, §9.11): the task store's staff
 * routes as an admin's page. Its pure parts (the answer's shape to schema
 * and back, the Queue's warnings, the deep links, which parts of items 4
 * and 5a show); its door (only strut's own page shown to an admin, and
 * `/tasks` alone); its seed and listing (full scope alone); its calls as an
 * admin, a member, a visitor and a peer; and that no expected answer ever
 * reaches a run, an event or the monitor.
 */

const KEY = "staff-app-key";
const PEER_KEY = "staff-peer-key";
const SECRET = "the-expected-answer-7f3a";
const MATCH = { type: "object", properties: { same: { type: "boolean", title: "The same pet?" }, note: { type: "string", maxLength: 200 } }, required: ["same"] };
const quiet = { serveUi: false, enableChat: false, enableMcp: true, scheduler: false, autoResume: false, wakeDelayMs: 0 } as const;
/** strut/views stays: strut/staff imports its TaskForm. */
const seedsOff = { jamie: false, knowledge: false, earnings: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false } as const;

// ── its pure parts ─────────────────────────────────────────────────────────

describe("strut/staff: the answer's shape in the type editor", () => {
  const drawable: unknown[] = [
    MATCH,
    { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, title: "A box" },
    { type: "string", enum: ["cat", "dog"] },
    { type: "integer", minimum: 1, maximum: 5 },
    { type: "object", properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 }, size: { type: "number", enum: [1, 2.5] }, ok: { type: "boolean" } } },
    { type: "object", title: "Two", properties: { where: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } }, required: ["where"] },
    { type: "array", items: { type: "integer", enum: [1, 2, 3] } },
  ];

  it("a schema the kinds draw goes to fields and back unchanged", () => {
    for (const s of drawable) {
      const m = modelOf(s);
      assert.ok(m, JSON.stringify(s));
      assert.deepEqual(schemaOf(m), s);
      assert.equal(modelProblem(m), undefined, JSON.stringify(s));
    }
    assert.equal(modelOf(MATCH)!.form, true);
    assert.equal(modelOf(drawable[1])!.form, false, "a box on a photo is one value");
  });

  it("every schema it writes passes the store's check: each kind new, nested, and switched", () => {
    const fields: FieldModel[] = KINDS.map((k, i) => newField(k, Array.from({ length: i }, (_, j) => `field${j + 1}`)));
    fields[fields.length - 1] = { ...fields[fields.length - 1]!, fields: KINDS.filter((k) => k !== "group").map((k, i) => newField(k, Array.from({ length: i }, (_, j) => `field${j + 1}`))) };
    const model: AnswerModel = { form: true, fields };
    assert.equal(answerSchemaProblem(schemaOf(model)), undefined);
    for (const k of KINDS) {
      const one: AnswerModel = { form: false, value: withKind({ key: "x", required: true, kind: "text" }, k) };
      assert.equal(answerSchemaProblem(schemaOf(one)), undefined, k);
    }
    const bounds: AnswerModel = { form: true, fields: [{ key: "n", required: false, kind: "integer", minimum: 0, maximum: 10 }, { key: "t", required: true, kind: "text", minLength: 1, maxLength: 3 }] };
    assert.equal(answerSchemaProblem(schemaOf(bounds)), undefined);
  });

  it("a schema it cannot draw opens in JSON: null, a list of groups, an enum with a length, an enum on an object", () => {
    for (const s of [
      { type: "null" },
      { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
      { type: "string", enum: ["a"], maxLength: 3 },
      { type: "object", properties: { a: { type: "string" } }, enum: [{ a: "x" }] },
      { type: "object", properties: { a: { type: "null" } } },
    ]) {
      assert.equal(modelOf(s), null, JSON.stringify(s));
    }
    assert.equal(modelOf({ type: "object", properties: {}, minLength: 1 }), null, "the store refuses it: no model either");
  });

  it("what the model needs before it is a schema: keys, options; options typed as a list", () => {
    assert.match(modelProblem({ form: true, fields: [{ key: "", required: true, kind: "boolean" }] })!, /no key/);
    assert.match(modelProblem({ form: true, fields: [{ key: "a", required: true, kind: "boolean" }, { key: "a", required: true, kind: "text" }] })!, /both "a"/);
    assert.match(modelProblem({ form: false, value: { kind: "one", options: [], optionType: "string" } })!, /no options/);
    assert.match(modelProblem({ form: false, value: { kind: "several", options: ["a", "a"], optionType: "string" } })!, /twice/);
    assert.deepEqual(parseOptions("cat, dog ,", "string"), ["cat", "dog"]);
    assert.deepEqual(parseOptions("1, 2.5", "number"), [1, 2.5]);
    assert.match((parseOptions("1, 2.5", "integer") as { problem: string }).problem, /whole number/);
  });
});

describe("strut/staff: the type editor's draft", () => {
  const type: TaskType = {
    name: "pets", app: "workers", answer: MATCH as never, leaseSeconds: 900, withinHours: 48, enabled: false, paySats: 20, holdHours: 24,
    tests: { rate: 0.1, newRate: 0.3, newTasks: 40, qualify: 5, window: 10, minGraded: 5, threshold: 0.7, grade: { step: "grade/judge", config: { rubric: "same pet" } }, gradeCapUsd: 0.02 },
    copies: { max: 3, agree: 2, compare: "equal", onDisagree: "fail" }, changedAt: 0,
  };
  const all = { pay: true, tests: true, copies: true };

  it("a type to a draft and back is the type, every part kept", () => {
    const out = saveOf(draftOf(type), all, type);
    assert.ok("input" in out, JSON.stringify(out));
    const { name, ...rest } = out.input;
    assert.equal(name, "pets");
    const { name: _n, changedAt: _c, ...want } = type;
    assert.deepEqual(rest, want);
  });

  it("a part the page does not show is sent back as it was, never dropped by the whole-type PUT", () => {
    const out = saveOf(draftOf(type), { pay: false, tests: false, copies: false }, type);
    assert.ok("input" in out);
    assert.deepEqual([out.input["paySats"], out.input["holdHours"], out.input["tests"], out.input["copies"]], [20, 24, type.tests, type.copies]);
  });

  it("tests and copies turned off are sent as null; a new type starts from the store's defaults; a changed shape is seen", () => {
    const d = { ...draftOf(type), testsOn: false, copiesOn: false };
    const out = saveOf(d, all, type);
    assert.ok("input" in out);
    assert.deepEqual([out.input["tests"], out.input["copies"]], [null, null]);
    const fresh = draftOf();
    assert.deepEqual([fresh.leaseMinutes, fresh.withinHours, fresh.holdHours, fresh.enabled, fresh.testsOn], ["10", "72", "72", true, false]);
    assert.match((saveOf(fresh, all) as { problem: string }).problem, /pick the app/);
    assert.equal(shapeChanged(type, { required: ["same"], properties: MATCH.properties, type: "object" } as never), false, "key order is not a change");
    assert.equal(shapeChanged(type, { type: "boolean" } as never), true);
    assert.equal(shapeChanged(undefined, { type: "boolean" } as never), false);
  });

  it("a new type's name is held to the store's rule", () => {
    assert.equal(typeNameProblem("acme/pet-match", []), undefined);
    assert.match(typeNameProblem("Pets", [])!, /lowercase/);
    assert.match(typeNameProblem("pets", ["pets"])!, /already/);
  });
});

describe("strut/staff: the Queue, deep links, and what shows", () => {
  const row = (over: Partial<TaskStats["types"][number]>): TaskStats["types"][number] => ({
    type: "pets", app: "workers", enabled: true, waiting: 0, working: 0, dueSoon: 0, dueHour: 0, granted: 1, holding: 0, asking: 0,
    windows: { hour: zero(), day: zero(), week: zero() }, ...over,
  });
  const zero = () => ({ answered: 0, expired: 0, cancelled: 0, disputed: 0, skipped: 0, leasesLost: 0 });
  const stats = (types: TaskStats["types"], fresh = 0): TaskStats => ({ at: 0, types, workers: { new: fresh, active: 1, suspended: 0, banned: 0 }, holding: 0, asking: 0 });

  it("the Queue's warnings: waiting with nobody granted, due within the hour, off with open tasks, the app, new workers", () => {
    assert.deepEqual(queueWarnings(stats([row({})])), []);
    const w = queueWarnings(stats([row({ waiting: 3, granted: 0, dueHour: 1 }), row({ type: "boxes", enabled: false, working: 2, appProblem: "no app boxer on this server" })], 2));
    assert.deepEqual(
      w.map((x) => x.text),
      [
        "pets has 3 tasks waiting and no worker granted it.",
        "1 task of pets expires unanswered within the hour.",
        "boxes: no app boxer on this server.",
        "boxes is turned off with 2 open tasks: none is handed out, and each expires when due.",
        "2 new workers signed in and wait for a grant.",
      ],
    );
    assert.deepEqual(w[4]!.to, { tab: "workers" });
    assert.deepEqual(w[1]!.to, { tab: "tasks", type: "pets" });
  });

  it("the deep-link input: each place opens its tab and goes back out as the same input", () => {
    assert.deepEqual(placeOf(undefined), { tab: "queue" });
    assert.deepEqual(placeOf({ task: "t1" }), { tab: "tasks", task: "t1" });
    assert.deepEqual(placeOf({ run: "acme/pets/r9" }), { tab: "tasks", run: "acme/pets/r9" });
    assert.deepEqual(placeOf({ worker: "secp:abc" }), { tab: "workers", worker: "secp:abc" });
    assert.deepEqual(placeOf({ type: "pets" }), { tab: "types", type: "pets" });
    assert.deepEqual(placeOf({ tab: "tests", type: "pets" }), { tab: "tests", type: "pets" });
    assert.deepEqual(placeOf({ tab: "nope" }), { tab: "queue" });
    assert.deepEqual(placeOf({ review: "none" }), { tab: "tasks", review: "none" }, "the review queue (§9.6)");
    assert.deepEqual(placeOf({ review: "rejected", by: "w" }), { tab: "tasks", review: "rejected", by: "w" }, "one worker's rejected answers");
    assert.deepEqual(placeOf({ review: "maybe" }), { tab: "queue" });
    for (const p of [
      { tab: "queue" }, { tab: "workers" }, { tab: "types", type: "a/b" }, { tab: "tasks", task: "x" }, { tab: "tests", test: "y" }, { tab: "tasks", by: "w" }, { tab: "tasks", run: "wf/r" },
      { tab: "tasks", review: "none" }, { tab: "tasks", review: "ok", by: "w" },
    ] as const) {
      assert.deepEqual(placeOf(inputOf(p)), p);
    }
  });

  it("items 4 and 5a show only when the server answers for them", () => {
    const plain: TaskType = { name: "a", app: "w", answer: { type: "boolean" } as never, leaseSeconds: 600, withinHours: 72, enabled: true, changedAt: 0 };
    const worker: Worker = { actor: "w1", status: "active", firstSeen: 0, changedAt: 0, grants: [] };
    // A host's own store: no test routes, no pay on its types, no balance or standing on its workers.
    assert.deepEqual(shownOf({ types: [plain], workers: [worker], testsAnswer: "no" }), { tests: false, standing: false, copies: false, pay: false, earnings: false, review: false });
    // This strut, before anything is tested or paid: the sections, not the empty columns.
    const here = shownOf({ types: [{ ...plain, holdHours: 72 }], workers: [{ ...worker, balance: { totalMsat: 0, heldMsat: 0, withdrawableMsat: 0 }, standing: {} }], testsAnswer: "yes" });
    assert.deepEqual(here, { tests: true, standing: false, copies: true, pay: true, earnings: false, review: true });
    // A tested, paid type: the columns too.
    const busy = shownOf({ types: [{ ...plain, holdHours: 72, paySats: 5, tests: { qualify: 1 } as never }], workers: [{ ...worker, balance: { totalMsat: 5000, heldMsat: 5000, withdrawableMsat: 0 }, standing: {} }], testsAnswer: "yes" });
    assert.deepEqual(busy, { tests: true, standing: true, copies: true, pay: true, earnings: true, review: true });
    assert.equal(testsAnswerOf({ error: new Error("step_run: not_available: this server's task store is its host's") }), "no");
    assert.equal(testsAnswerOf({ error: new Error("network") }), "unknown");
    assert.equal(testsAnswerOf({ data: { tests: [] } }), "yes");
  });

  it("the Queue's line on what workers are owed beside the wallet; none for a strut that never paid one", () => {
    const workers = (owed: number) => ({ owedMsat: owed, heldMsat: owed, withdrawableMsat: 0, payees: owed ? 1 : 0, accepted: { answers: owed ? 1 : 0, msat: owed, days: [] }, takenBack: { answers: 0, msat: 0 } });
    assert.equal(owedLine({ workers: workers(0) }), null);
    assert.deepEqual(owedLine({ workers: workers(20_000), wallet: { balance: { msat: 50_000 }, owedToWorkersMsat: 20_000, coverMsat: 30_000 } }), {
      text: "Workers are owed 20 sats (20 sats held, 0 sats withdrawable); the wallet holds 50 sats, 30 sats more than that.",
      short: false,
    });
    assert.equal(owedLine({ workers: workers(20_000), wallet: { balance: { msat: 5_000 }, coverMsat: -15_000 } })!.short, true);
  });

  it("who a worker is, their standing in a cell, a lease's outcome, the list's order", () => {
    assert.equal(shortActor("secp:3fa2d0e1c9b87a6591c"), "secp:3fa2…91c");
    assert.equal(shortActor("ada"), "ada");
    assert.equal(whoOf({ actor: "secp:3fa2d0e1c9b87a6591c", note: "Ada Lovelace\nfrom the invite" }), "Ada Lovelace");
    const s = { qualifying: false, qualify: 10, window: 20, graded: 20, passed: 15, errors: 0, pending: 0, minGraded: 10, threshold: 0.8 };
    assert.deepEqual([standingText(s), standingLow(s)], ["75% of 20", true]);
    assert.equal(standingText({ ...s, qualifying: true, graded: 2, pending: 1 }), "qualifying 3/10");
    assert.deepEqual(
      [leaseOutcome({ status: "submitted", expires: 0 }), leaseOutcome({ status: "expired", expires: 0 }), leaseOutcome({ status: "expired", reason: "worker suspended", expires: 0 })],
      ["answered", "ran out", "ended early: worker suspended"],
    );
    assert.deepEqual(workersInOrder([{ status: "active" as const, a: 1 }, { status: "new" as const, a: 2 }]).map((w) => w.a), [2, 1]);
  });

  it("a task's verdicts in a cell and one verdict in words (§9.6)", () => {
    const lease = (worker: string, review?: { verdict: "ok" | "rejected" }) => ({
      id: worker, task: "t", worker, type: "pets", taken: 0, expires: 0, status: "submitted" as const,
      ...(review ? { review: { ...review, at: 0, until: 1, final: false } } : {}),
    });
    assert.equal(reviewSummary({ leases: [lease("a")] }), "to review");
    assert.equal(reviewSummary({ leases: [lease("a", { verdict: "rejected" })] }), "rejected");
    assert.equal(reviewSummary({ leases: [lease("a", { verdict: "ok" }), lease("b")] }), "1 ok, 1 to review");
    assert.equal(reviewSummary({ test: "x", leases: [lease("a")] }), "", "a test is graded, not reviewed");
    assert.equal(reviewSummary({ leases: [{ ...lease("a"), status: "expired" }] }), "", "no answer, nothing to review");
    const at = Date.parse("2026-11-13T12:00:00");
    assert.equal(
      reviewText({ verdict: "rejected", why: "a cat", by: "ada", at, until: at + 3_600_000, final: false }, at),
      `rejected: a cat · by ada, ${fmtWhen(at, at)} · changeable until ${fmtWhen(at + 3_600_000, at)}`,
    );
    assert.equal(reviewText({ verdict: "ok", at, until: at, final: true }, at), `ok · ${fmtWhen(at, at)} · final`);
  });
});

// ── its door ───────────────────────────────────────────────────────────────

describe("strut/staff: the door, outside its page", () => {
  it("a staff/* step refuses a workflow, a model-written page, a member's view of strut's own, and a call with no door", async () => {
    const door = { staffAdmin: { call: async () => ({ ok: true, status: 200, body: { types: [] } }) } };
    const run = (ctx: object) => statsStep.run({}, { services: door, ...ctx } as never);
    await assert.rejects(() => run({}), /an admin's/);
    await assert.rejects(() => run({ app: { name: "acme/x", version: "v1", admin: true } }), /an admin's/, "a model-written page, even granted it");
    await assert.rejects(() => run({ app: { name: STAFF_APP, version: "v1", firstParty: true } }), /an admin's/, "strut's own page shown to a member");
    await assert.rejects(() => statsStep.run({}, { app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true }, services: {} } as never), /door is not on this call/);
    assert.deepEqual(await run({ app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true } }), { types: [] });
  });

  it("the door reaches /tasks alone; a refusal comes back as the step's error, its code first", async () => {
    const sent: string[] = [];
    const door = inProcessDoor(async (req) => (sent.push(new URL(req.url).pathname), new Response(JSON.stringify({ error: "in_use: open tasks", code: "in_use" }), { status: 409 })), STAFF_ROUTES, "staff");
    await assert.rejects(() => door.call("GET", "/earnings/wallet"), /reaches its own routes alone/);
    await assert.rejects(() => door.call("GET", "/tasksx"), /reaches its own routes alone/);
    assert.deepEqual(await door.call("DELETE", "/tasks/types/pets"), { ok: false, status: 409, body: { error: "in_use: open tasks", code: "in_use" } });
    assert.deepEqual(sent, ["/tasks/types/pets"]);
    const step = (await import("../steps/lib/staff/delete-type.js")).default;
    await assert.rejects(() => step.run({ name: "pets" }, { app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true }, services: { staffAdmin: door } } as never), /^Error: in_use: open tasks$/);
  });

  it("a step that carries an expected answer redacts it; the monitor keeps a call's config redacted", () => {
    assert.deepEqual(saveTestStep.redact, ["expected"]);
    const registry = { "staff/save-test": saveTestStep } as never;
    assert.deepEqual(redactedConfig(registry, "staff/save-test", { type: "pets", expected: { same: true } }), { type: "pets", expected: "[redacted]" });
    assert.deepEqual(redactedConfig(registry, "staff/tests", { type: "pets" }), { type: "pets" });
  });
});

// ── a strut ────────────────────────────────────────────────────────────────

/** Writes files under the run's artifacts. */
const writeFiles = defineStep({
  type: "test/write-files",
  input: z.object({ paths: z.array(z.string()) }),
  output: z.any(),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    for (const p of cfg.paths) await ctx!.services.artifacts!.write(ctx!.runId, p, `file ${p}`);
    return cfg.paths;
  },
});

const PETS = `name: pets
steps:
  - id: photo
    type: test/write-files
    config:
      paths: ["found.txt", "notes.txt"]
  - id: review
    type: human
    config:
      task: pets
      show:
        guess: "{{ input.guess }}"
      files: ["found.txt"]
`;

describe("strut/staff — seeded, an admin's, and its page's calls", () => {
  let strut: Strut;
  let root: string;
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  /** Every event the deployment's listener heard (a host's `onRunEvent`). */
  const heard: Array<{ workflow: string; event: RunEvent }> = [];

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER_KEY;
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-staff-app-"));
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      ...quiet,
      ...seedsOff,
      workspace,
      kit,
      registry: await createRegistry([writeFiles]),
      services: { onRunEvent: async (workflow: string, event: RunEvent) => void heard.push({ workflow, event }) },
    });
    await workspace.publishWorkflowByContent("pets", PETS);
    const dir = join(root, "apps", "workers");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Workers\ngrants:\n  steps: [task/next, task/submit, task/skip, task/file, task/me]\n");
    await writeFile(join(dir, "src", "App.tsx"), "export default function App() { return <p>workers</p>; }\n");
    const r = await strut.apps.publish(dir, "workers", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await rm(root, { recursive: true, force: true });
    for (const [k, v] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const auth = { authorization: `Bearer ${KEY}` };
  const peer = { authorization: `Bearer ${PEER_KEY}` };
  const signIn = async (actor: string, role: "admin" | "member") => {
    const res = await strut.app.request("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: signInTicket(actor, role)!.ticket }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  /** A page's call through a door, as its host relays it: `{ result }` or `{ error }`. */
  const door = async (path: string, headers: Record<string, string>, type: string, config: Record<string, unknown> = {}, app = appIdentity(STAFF_APP, "v1")) => {
    const res = await strut.app.request(path, {
      method: "POST",
      headers: { "x-strut-ui": "1", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app } } }),
    });
    const text = await res.text();
    if (res.status !== 200) return { error: `HTTP ${res.status}: ${text}`, result: undefined as any };
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(line ? line.slice(6) : text) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
    if (!msg.result) return { error: JSON.stringify(msg.error), result: undefined as any };
    const value = JSON.parse(msg.result.content[0]!.text) as any;
    return msg.result.isError ? { error: JSON.stringify(value) as string, result: undefined as any } : { error: undefined, result: value };
  };
  const page = (cookie: Promise<string>) => async (type: string, config: Record<string, unknown> = {}) => door("/mcp", { cookie: await cookie }, type, config);
  const summaryWhen = async (runId: string, pred: (s: RunSummary) => boolean) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const s = await strut.store.getRunSummary("pets", runId);
      if (s && pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`no summary matched (last: ${JSON.stringify(s?.status)})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("is seeded at boot: built, first-party, `admin: true`; a reboot is a no-op; `staff: false` and STRUT_HOST_CONFIG turn it off", async () => {
    const app = await strut.apps.get(STAFF_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale, app.manifest.admin, app.manifest.title], ["v1", "strut", "seed", false, true, "Tasks and workers"]);
    assert.equal(app.hash, await treeHash(STAFF_DIR));
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    assert.deepEqual(info.warnings, []);
    assert.deepEqual(await seedStaffApp({ workspace: strut.workspace, kit: await kitForTests() }), { version: "v1", changed: false });
    const off = await createStrut({ ...quiet, ...seedsOff, views: false, workspace: new WorkspaceManager(join(root, "off")), kit: await kitForTests(), staff: false });
    assert.equal(await off.apps.get(STAFF_APP), null);
    await off.close?.();
    const file = join(root, "host.json");
    await writeFile(file, JSON.stringify({ staff: false }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { staff: false });
    await writeFile(file, JSON.stringify({ staff: true }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"staff" must be false/);
  });

  it("is an admin's: GET /apps lists it to full scope alone; its files, versions and usage refuse a member and a peer", async () => {
    const names = async (headers: Record<string, string>) => ((await (await strut.app.request("/apps", { headers })).json()) as { apps?: Array<{ name: string }> }).apps?.map((a) => a.name) ?? [];
    assert.ok((await names(auth)).includes(STAFF_APP));
    assert.ok((await names({ cookie: await signIn("ada", "admin") })).includes(STAFF_APP), "an admin's session");
    const member = await signIn("bo", "member");
    assert.ok(!(await names({ cookie: member })).includes(STAFF_APP), "never a member's");
    assert.ok(!(await names(peer)).includes(STAFF_APP), "never a peer's");
    const at = `/apps/${encodeURIComponent(STAFF_APP)}`;
    for (const path of [`${at}/v1/files`, `${at}/v1/files/dist/index.html`, `${at}/versions`, `${at}/usage`]) {
      assert.equal((await strut.app.request(path, { headers: { cookie: member, "x-strut-ui": "1" } })).status, 403, path);
      assert.notEqual((await strut.app.request(path, { headers: peer })).status, 200, path);
    }
  });

  it("an admin's page: saves a type, grants as the admin, reads the queue, the workers, a task with its run and its file", async () => {
    const admin = page(signIn("ada", "admin"));
    const saved = await admin("staff/save-type", { name: "pets", app: "workers", answer: MATCH, paySats: 10, holdHours: 24, copies: { max: 3, agree: 2 } });
    assert.equal(saved.error, undefined, saved.error);
    assert.equal(saved.result.type.changedBy, "ada", "the admin who did it");
    // A worker signs in and is seen; the admin grants them.
    const wc = strut.tasks.worker;
    await wc.me("w1", { app: "workers" });
    const g = await admin("staff/grant", { actor: "w1", type: "pets" });
    assert.equal(g.error, undefined, g.error);
    assert.deepEqual([g.result.worker.status, g.result.worker.grants[0].by], ["active", "ada"]);

    const res = await strut.app.request("/workflows/pets/run", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ input: { guess: "same dog" } }) });
    assert.equal(res.status, 202, await res.clone().text());
    const { runId } = (await res.json()) as { runId: string };
    await summaryWhen(runId, (s) => s.status === "waiting");

    const stats = await admin("staff/stats");
    assert.equal(stats.error, undefined, stats.error);
    const pets = stats.result.types.find((t: { type: string }) => t.type === "pets");
    assert.deepEqual([pets.waiting, pets.working, pets.granted, pets.app, pets.appProblem], [1, 0, 1, "workers", undefined]);
    const tasks = await admin("staff/tasks", { runId });
    const id = tasks.result.tasks[0].id as string;
    const one = await admin("staff/task", { id });
    assert.deepEqual(one.result.run, { status: "waiting", waitingOn: [`task:${id}`] }, "the run as it stands now");
    const f = await admin("staff/file", { task: id, path: "found.txt" });
    assert.equal(f.result.text, "file found.txt");
    assert.match((await admin("staff/file", { task: id, path: "notes.txt" })).error ?? "", /not_listed/, "the run has it; the task does not list it");

    // The worker answers; the run goes on; staff read who answered and what they earned.
    const got = (await wc.next("w1", { app: "workers" })) as { lease: string };
    await wc.submit("w1", { lease: got.lease, answer: { same: true }, app: "workers" });
    await summaryWhen(runId, (s) => s.status === "success");
    assert.deepEqual((await admin("staff/task", { id })).result.run, { status: "success" });
    assert.deepEqual((await admin("staff/tasks", { by: "w1" })).result.tasks.map((t: { id: string }) => t.id), [id]);
    const w = await admin("staff/worker", { actor: "w1" });
    assert.deepEqual([w.result.worker.balance.heldMsat, w.result.week.pets.answered, w.result.recent[0].task.id], [10_000, 1, id]);
    const workers = await admin("staff/workers");
    assert.deepEqual([workers.result.workers[0].week, workers.result.workers[0].balance.totalMsat], [1, 10_000]);
    const back = await admin("staff/take-back", { task: id, worker: "w1", why: "the wrong pet" });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.result.earnings[0].result, "taken");

    // §9.6: a verdict through the door, in the admin's name; a mark that
    // leaves the finished run as it was.
    const events = (await strut.store.getRunEvents("pets", runId)).length;
    const summary = await strut.store.getRunSummary("pets", runId);
    assert.deepEqual((await admin("staff/tasks", { review: "none" })).result.tasks.map((t: { id: string }) => t.id), [id], "the review queue");
    const rv = await admin("staff/review", { task: id, verdict: "rejected", why: "the wrong pet" });
    assert.equal(rv.error, undefined, rv.error);
    assert.deepEqual([rv.result.worker, rv.result.review.verdict, rv.result.review.by], ["w1", "rejected", "ada"]);
    assert.equal((await admin("staff/task", { id })).result.task.leases[0].review.why, "the wrong pet");
    assert.deepEqual((await admin("staff/tasks", { review: "rejected", by: "w1" })).result.tasks.map((t: { id: string }) => t.id), [id]);
    assert.equal((await admin("staff/worker", { actor: "w1" })).result.recent[0].lease.review.verdict, "rejected", "the worker's page shows it");
    assert.match((await admin("staff/review", { task: id, verdict: "rejected" })).error ?? "", /bad_request: a rejection says why/);
    assert.equal((await strut.store.getRunEvents("pets", runId)).length, events, "the run is not touched");
    assert.deepEqual(await strut.store.getRunSummary("pets", runId), summary);
  });

  it("a member's session on the same page, a visitor and a peer are refused every staff/* step", async () => {
    const member = page(signIn("bo", "member"));
    const configs: Record<string, Record<string, unknown>> = { "staff/grant": { actor: "x", type: "pets" }, "staff/save-type": { name: "x", app: "workers", answer: MATCH }, "staff/review": { task: "t1", verdict: "ok" } };
    for (const type of ["staff/stats", "staff/types", "staff/workers", "staff/tests", "staff/save-type", "staff/grant", "staff/review"]) {
      const r = await member(type, configs[type] ?? {});
      assert.ok(r.error, type);
      assert.match(r.error, /admin/, type);
    }
    // A visitor: strut/staff is not in the public view (and its steps are an admin's).
    const visitor = await door("/public/mcp", {}, "staff/stats");
    assert.ok(visitor.error, "a visitor gets nothing");
    assert.ok((await door("/public/mcp", {}, "staff/review", { task: "t1", verdict: "ok" })).error, "nor a verdict");
    // A peer: its key holds no full scope here.
    const p = await door("/mcp", peer, "staff/stats");
    assert.ok(p.error, "a peer gets nothing");
    assert.ok((await door("/mcp", peer, "staff/review", { task: "t1", verdict: "ok" })).error, "nor a verdict");
    for (const path of ["/tasks/stats", "/tasks/types", "/tasks/workers/w1", "/tasks?by=w1", "/tasks?review=none"]) {
      assert.equal((await strut.app.request(path, { headers: peer })).status, 403, path);
      assert.equal((await strut.app.request(path, { headers: { cookie: await signIn("bo", "member") } })).status, 403, path);
    }
    // The route itself: full scope only (§9.12, 3).
    const put = { method: "PUT", body: JSON.stringify({ verdict: "ok" }) };
    for (const headers of [peer, { cookie: await signIn("bo", "member"), "x-strut-ui": "1" }]) {
      assert.equal((await strut.app.request("/tasks/t1/review", { ...put, headers: { ...headers, "content-type": "application/json" } })).status, 403, JSON.stringify(Object.keys(headers)));
    }
    assert.equal((await strut.app.request("/tasks/t1/review", { ...put, headers: { "content-type": "application/json" } })).status, 401, "no key");
    assert.equal((await strut.app.request("/tasks/t1/review", { ...put, headers: { ...auth, "content-type": "application/json" } })).status, 404, "the key reaches it: no task t1");
  });

  it("an expected answer and a grader's note never reach a run, an event or the monitor", async () => {
    const admin = page(signIn("ada", "admin"));
    await admin("staff/save-type", { name: "pets", app: "workers", answer: MATCH, tests: { qualify: 0, rate: 1, newRate: 1 } });
    const made = await admin("staff/save-test", { type: "pets", show: { guess: "a cat" }, expected: { same: false, note: SECRET } });
    assert.equal(made.error, undefined, made.error);
    const id = made.result.test.id as string;
    assert.equal((await admin("staff/tests", { type: "pets" })).result.tests.find((t: { id: string }) => t.id === id).expected.note, SECRET, "the page reads it");
    assert.equal((await admin("staff/test", { id })).result.test.expected.note, SECRET);
    await admin("staff/save-test", { id, expected: { same: true, note: SECRET } });
    // Refused calls, enough of them for the monitor to keep an example of each.
    for (let i = 0; i < 25; i++) await admin("staff/save-test", { type: "pets", expected: { same: "no", note: SECRET } });
    const tasks = await admin("staff/tasks", { status: "settled" });
    await admin("staff/test-from-task", { task: tasks.result.tasks[0].id, expected: { same: true, note: SECRET } });

    const text = (v: unknown) => JSON.stringify(v);
    assert.ok(!heard.some((h) => text(h.event).includes(SECRET)), "no event a listener hears holds it");
    // An admin's answered call reaches no listener (a member's refused one
    // does, and carries nothing but the refusal).
    const answered = heard.filter((h) => h.event.type === "step.end" && /staff\./.test(h.event.path ?? ""));
    assert.deepEqual(answered.map((h) => h.event.path), [], "an admin page's calls hand the listener no event");
    // Nothing on disk holds it but the task store's own file: no run, no
    // run log, no monitor file, no history.
    const kept: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (p === join(root, "ws", "tasks")) continue;
          await walk(p);
        } else if ((await readFile(p)).includes(SECRET)) kept.push(p);
      }
    };
    await walk(root);
    assert.deepEqual(kept, []);
    const report = strut.appMonitor.report(STAFF_APP);
    assert.ok(text(report).includes("staff/save-test"), "the monitor saw the calls");
    assert.ok(!text(report).includes(SECRET), "and kept no expected answer");
    assert.ok(!text(await (await strut.app.request("/tasks", { headers: auth })).json()).includes(SECRET), "GET /tasks holds none");
  });
});

describe("strut/staff with a host's own task store", () => {
  it("the test routes answer not_available and the queue 501: the page shows no Tests tab", async () => {
    const saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    const root = await mkdtemp(join(tmpdir(), "strut-staff-host-"));
    try {
      const own = { types: async () => [], workers: async () => [], list: async () => [], task: async () => undefined, ensure: async () => { throw new Error("no"); } };
      const strut = await createStrut({ ...quiet, ...seedsOff, views: false, staff: false, workspace: new WorkspaceManager(root), services: { tasks: own as never } });
      const tests = await strut.app.request("/tasks/tests");
      assert.equal(tests.status, 501);
      const body = (await tests.json()) as { code: string };
      assert.equal(body.code, "not_available");
      assert.equal(testsAnswerOf({ error: new Error(`step_run: ${body.code}: …`) }), "no");
      assert.equal((await strut.app.request("/tasks/stats")).status, 501);
      assert.equal((await strut.app.request("/tasks/x/files/a")).status, 501);
      await strut.close?.();
    } finally {
      if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
      await rm(root, { recursive: true, force: true });
    }
  });
});
