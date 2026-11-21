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
  anyOpenWork, answerFiles, fmtWhen, grantedBy, inviteChoices, inviteWorkText, isPicture, inputOf, leaseOutcome, liveTypesText, mostByOneWorkerToday, openPayHint, owedLine, payoutCover, payoutState, placeOf, shortAddress, needsYou, navOf, toReviewOf, moneyOf, captionOf, answerLine, answerFields, emptyFields, pictureOf, tookText, happenings, reviewSummary, reviewText, shortActor, shownOf, standingLow, standingText, testsAnswerOf, typeNameProblem, whoElse, whoOf, workersInOrder,
  INVITE_WORDS, acceptedBy, inviteBadge, inviteExpiry, sortInvites, inviteOpen, invitesReadMs, inviteSatsOf, inviteWhyText, whatsappUrl,
  fmtBytes, initialsOf, messageLine, paymentLine, supportName, textPieces,
  fitWithin,
  shrinkable,
  attachProblem,
  SUPPORT_FILTERS,
  jpgName,
} from "./staff/src/lib/view.js";
import { draftOf, saveOf, shapeChanged } from "./staff/src/lib/draft.js";
import { conversationOf, likeOf, messageOf, searchHit, settingsOf, type MessageRow } from "./staff/src/lib/support.js";
import type { TaskStats, TaskType, Worker } from "./staff/src/lib/types.js";
import statsStep from "../steps/lib/staff/stats.js";
import saveTestStep from "../steps/lib/staff/save-test.js";
import { qrSvg } from "../move/link.js";

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
    name: "pets", app: "workers", answer: MATCH as never, leaseSeconds: 900, withinHours: 48, enabled: false, open: false, paySats: 20, holdHours: 24,
    tests: { rate: 0.1, newRate: 0.3, newTasks: 40, qualify: 5, window: 10, minGraded: 5, threshold: 0.7, grade: { step: "grade/judge", config: { rubric: "same pet" } }, gradeCapUsd: 0.02 },
    copies: { max: 3, agree: 2, compare: "equal", onDisagree: "fail" }, changedAt: 0,
  };
  const all = { pay: true, tests: true, copies: true, open: true };

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
    assert.deepEqual([out.input["paySats"], out.input["holdHours"], out.input["tests"], out.input["copies"], out.input["open"]], [20, 24, type.tests, type.copies, false]);
    // A server from before open types: no choice shown, and nothing sent, so its own default holds.
    const { open: _o, ...older } = type;
    assert.equal("open" in (saveOf(draftOf(older), { pay: true, tests: true, copies: true }, older) as { input: Record<string, unknown> }).input, false);
    // A standing type (plans/human-steps.md §5.7) and a round type keep what they are on a save.
    const standing = { ...type, standing: { workflow: "nutrition-label" } };
    assert.deepEqual((saveOf(draftOf(standing), all, standing) as { input: Record<string, unknown> }).input["standing"], { workflow: "nutrition-label" });
    const round = { ...type, round: { workflow: "shop-visits" } };
    assert.deepEqual([draftOf(round).when, draftOf(round).workflow], ["round", "shop-visits"]);
    assert.deepEqual((saveOf(draftOf(round), all, round) as { input: Record<string, unknown> }).input["round"], { workflow: "shop-visits" });
  });

  it("When there is work: sent names no workflow; any time and rounds name the one picked, and ask for one", () => {
    const input = (d: ReturnType<typeof draftOf>) => (saveOf(d, all, type) as { input: Record<string, unknown> }).input;
    const sent = input({ ...draftOf(type), when: "sent", workflow: "left-over" });
    assert.deepEqual(["standing" in sent, "round" in sent], [false, false], "a PUT of the whole type: neither, so neither is kept");
    assert.deepEqual(input({ ...draftOf(type), when: "standing", workflow: "label-flow" })["standing"], { workflow: "label-flow" });
    const r = input({ ...draftOf(type), when: "round", workflow: "shop-visits" });
    assert.deepEqual([r["round"], "standing" in r], [{ workflow: "shop-visits" }, false]);
    assert.deepEqual(saveOf({ ...draftOf(type), when: "round", workflow: "" }, all, type), { problem: "pick the workflow a round runs" });
    assert.deepEqual(saveOf({ ...draftOf(type), when: "standing", workflow: "" }, all, type), { problem: "pick the workflow each answer starts" });
  });

  it("tests and copies turned off are sent as null; a new type starts from the store's defaults; a changed shape is seen", () => {
    const d = { ...draftOf(type), testsOn: false, copiesOn: false };
    const out = saveOf(d, all, type);
    assert.ok("input" in out);
    assert.deepEqual([out.input["tests"], out.input["copies"]], [null, null]);
    const fresh = draftOf();
    assert.deepEqual([fresh.leaseMinutes, fresh.withinHours, fresh.holdHours, fresh.enabled, fresh.testsOn, fresh.open], ["10", "72", "0", true, false, true], "a new type open, as the store's default");
    assert.match((saveOf(fresh, all) as { problem: string }).problem, /pick the app/);
    assert.equal(shapeChanged(type, { required: ["same"], properties: MATCH.properties, type: "object" } as never), false, "key order is not a change");
    assert.equal(shapeChanged(type, { type: "boolean" } as never), true);
    assert.equal(shapeChanged(undefined, { type: "boolean" } as never), false);
  });

  it("the files an answer carries (§5.6): kept through a draft, comma-separated types, left out when off", () => {
    const photo: TaskType = { ...type, attachments: { max: 4, min: 1, types: ["image/*", "application/pdf"] } };
    const d = draftOf(photo);
    assert.deepEqual([d.filesOn, d.files], [true, { max: "4", min: "1", types: "image/*, application/pdf" }]);
    assert.deepEqual((saveOf(d, all, photo) as { input: Record<string, unknown> }).input["attachments"], photo.attachments);
    assert.equal("attachments" in (saveOf({ ...d, filesOn: false }, all, photo) as { input: Record<string, unknown> }).input, false, "off: the PUT saves none");
    assert.match((saveOf({ ...d, files: { ...d.files, types: " , " } }, all, photo) as { problem: string }).problem, /types/);
    assert.deepEqual([draftOf().filesOn, draftOf().files.types], [false, "image/*, application/pdf"]);
  });

  it("the check before an answer is accepted (§5.6.7 c): kept through a draft, a step and its config; left out when off; never equal", () => {
    const checked: TaskType = { ...type, check: { step: "grade/judge", config: { rubric: "One whole book page." } } };
    const d = draftOf(checked);
    assert.deepEqual([d.checkOn, d.check.step], [true, "grade/judge"]);
    assert.deepEqual((saveOf(d, all, checked) as { input: Record<string, unknown> }).input["check"], checked.check, "a type to a draft and back keeps its check");
    assert.deepEqual((saveOf(d, { pay: false, tests: false, copies: false }, checked) as { input: Record<string, unknown> }).input["check"], checked.check, "shown always: kept whatever else is shown");
    assert.equal("check" in (saveOf({ ...d, checkOn: false }, all, checked) as { input: Record<string, unknown> }).input, false, "off: the PUT saves none");
    assert.deepEqual([draftOf().checkOn, draftOf().check.step], [false, "grade/judge"], "a new one starts on grade/judge");
    assert.match((saveOf({ ...d, check: { kind: "equal", step: "", config: "" } }, all, checked) as { problem: string }).problem, /^the check: pick a step/);
    assert.match((saveOf({ ...d, check: { ...d.check, config: "{ rubric" } }, all, checked) as { problem: string }).problem, /^the check: its config is not JSON/);
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

  it("what needs a person: waiting with nobody let in, due within the hour, off with open tasks, the app, people waiting, answers to review", () => {
    assert.deepEqual(needsYou(stats([row({})])), []);
    const w = needsYou(stats([row({ waiting: 3, granted: 0, dueHour: 1, toReview: 4 }), row({ type: "boxes", enabled: false, working: 2, appProblem: "no app boxer on this server", toReview: 1 })], 2));
    assert.deepEqual(
      w.map((x) => [x.text, x.action, x.tone]),
      [
        ["pets has 3 tasks waiting and no worker who may take it.", "Let someone in", "warn"],
        ["1 task of pets expires unanswered within the hour.", "See them", "warn"],
        ["boxes: no app boxer on this server.", "Open the type", "warn"],
        ["boxes is turned off with 2 open tasks: none is handed out, and each expires when due.", "Open the type", "warn"],
        ["2 people signed in and are waiting to be let in.", "Let them in", "warn"],
        ["5 answers have not been reviewed.", "Start reviewing", "plain"],
      ],
    );
    assert.deepEqual(w[4]!.to, { tab: "workers" });
    assert.deepEqual(w[1]!.to, { tab: "tasks", type: "pets" });
    // The review queue: by group once a workflow named one, else one by one.
    assert.deepEqual(w[5]!.to, { tab: "tasks", review: "none" });
    assert.deepEqual(needsYou(stats([row({ toReview: 1 })]), { groups: true }).map((x) => [x.text, x.to]), [["1 answer has not been reviewed.", { tab: "groups" }]]);
    assert.equal(needsYou(stats([row({})], 1))[0]!.text, "1 person signed in and is waiting to be let in.");
    // What is left to review: every type's, one type's, and nothing said where the server does not count.
    const counted = stats([row({ toReview: 4 }), row({ type: "boxes", toReview: 1 })]);
    assert.deepEqual([toReviewOf(counted), toReviewOf(counted, "boxes"), toReviewOf(stats([row({})])), toReviewOf(undefined)], [5, 1, undefined, undefined]);
  });

  it("six tabs, one a job: a group is under Answers and a test under Task types, and each place keeps its own link", () => {
    assert.deepEqual([navOf("queue"), navOf("tasks"), navOf("groups"), navOf("types"), navOf("tests"), navOf("workers"), navOf("payouts"), navOf("support")], ["queue", "tasks", "tasks", "types", "types", "workers", "payouts", "support"]);
    assert.deepEqual(placeOf({ group: "Order 12", type: "pets" }), { tab: "groups", group: "Order 12", type: "pets" });
    assert.deepEqual(placeOf(inputOf({ tab: "groups", type: "pets" })), { tab: "groups", type: "pets" });
  });

  it("an answer in a list: what it is called, its fields in a line, its picture, how long it took, what happened", () => {
    const photo = { name: "a.jpg", mediaType: "image/jpeg", size: 9, path: "tasks/t/a.jpg" };
    const thumb = { name: "thumb.jpg", mediaType: "image/jpeg", size: 2, path: "out/thumb.jpg" };
    const lease = { id: "l1", task: "t", worker: "ann", type: "shelf", taken: 1_000, expires: 9_000, closed: 22_000, status: "submitted" as const, attachments: [photo] };
    const task = { id: "t", seq: 1, type: "shelf", workflow: "shelves", runId: "r1", path: "ask", show: { ask: "Photo of the shelf" }, files: [], root: "run" as const, status: "settled" as const, created: 500, due: 99_000, settledAt: 22_000, by: "ann", answer: { aisle: "7", price: 3.5, note: "", sku: null }, leases: [lease] };
    // The run's words after the answer, else the words it asked with.
    assert.equal(captionOf(task), "Photo of the shelf");
    assert.equal(captionOf({ ...task, reply: { at: 23_000, show: { title: "Aisle 7", ask: "Thanks", ok: true } } }), "Aisle 7 · Thanks");
    assert.equal(captionOf({ show: { boxes: [] } }), "");
    assert.deepEqual(answerFields(task.answer), [["aisle", "7"], ["price", "3.5"]]);
    assert.deepEqual(emptyFields(task.answer), ["note", "sku"]);
    assert.equal(answerLine(task.answer), "Aisle: 7 · Price: 3.5");
    assert.equal(answerLine(true), "true");
    assert.equal(answerLine(undefined), "");
    // The reply's picture (what the run made of it) before the answer's own.
    assert.deepEqual(pictureOf(task), photo);
    assert.deepEqual(pictureOf({ ...task, reply: { at: 23_000, files: [thumb] } }), thumb);
    assert.equal(pictureOf({ ...task, leases: [{ ...lease, attachments: [] }] }), undefined);
    assert.equal(tookText(lease), "21 s");
    assert.equal(tookText({ ...lease, status: "skipped" }), "");
    const who = (a: string) => a.toUpperCase();
    assert.deepEqual(
      happenings({ ...task, reply: { at: 23_000 }, leases: [{ id: "l0", task: "t", worker: "bob", type: "shelf", taken: 600, expires: 900, closed: 700, status: "skipped" as const }, { ...lease, review: { verdict: "rejected" as const, why: "blurry", by: "ada", at: 30_000, until: 40_000, final: false } }] }, who, 50_000).map((h) => [h.at, h.text]),
      [[500, "The run made the task"], [600, "BOB took it"], [700, "BOB: skipped"], [1_000, "ANN took it"], [22_000, "ANN answered"], [23_000, "The run replied"], [30_000, "ada marked it rejected"]],
    );
  });

  it("what workers are owed beside the wallet, in parts", () => {
    assert.equal(moneyOf(undefined), null);
    const workers = { owedMsat: 304_000, heldMsat: 0, withdrawableMsat: 304_000, payees: 5, accepted: { answers: 76, msat: 304_000, days: [] }, takenBack: { answers: 0, msat: 0 } };
    assert.deepEqual(moneyOf({ workers, wallet: { balance: { msat: 8_321_000 } } }), { owedMsat: 304_000, heldMsat: 0, withdrawableMsat: 304_000, walletMsat: 8_321_000, coverMsat: 8_017_000 });
    assert.deepEqual(moneyOf({ workers, wallet: { error: "down" } }), { owedMsat: 304_000, heldMsat: 0, withdrawableMsat: 304_000, walletError: "down" });
    assert.equal(moneyOf({ workers, wallet: { balance: { msat: 100_000 } } })!.coverMsat, -204_000, "short of what is owed");
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
    // A host's own store: no test routes, no pay on its types, no balance or standing on its workers, no open on its types.
    assert.deepEqual(shownOf({ types: [plain], workers: [worker], testsAnswer: "no" }), { tests: false, standing: false, copies: false, pay: false, earnings: false, review: false, open: false, payouts: false, support: false });
    // This strut, before anything is tested or paid: the sections, not the empty columns.
    const here = shownOf({ types: [{ ...plain, holdHours: 72, open: true }], workers: [{ ...worker, balance: { totalMsat: 0, heldMsat: 0, withdrawableMsat: 0 }, standing: {} }], testsAnswer: "yes" });
    assert.deepEqual(here, { tests: true, standing: false, copies: true, pay: true, earnings: false, review: true, open: true, payouts: false, support: false });
    // A tested, paid type: the columns too.
    const busy = shownOf({ types: [{ ...plain, holdHours: 72, open: false, paySats: 5, tests: { qualify: 1 } as never }], workers: [{ ...worker, balance: { totalMsat: 5000, heldMsat: 5000, withdrawableMsat: 0 }, standing: {} }], testsAnswer: "yes" });
    assert.deepEqual(busy, { tests: true, standing: true, copies: true, pay: true, earnings: true, review: true, open: true, payouts: false, support: false });
    assert.equal(shownOf({ types: [], workers: [], testsAnswer: "no", payoutsAnswer: "yes" }).payouts, true, "the Payouts tab: when /tasks/payouts answers");
    assert.equal(shownOf({ types: [], workers: [], testsAnswer: "yes" }).open, true, "no type yet: the choice is shown for the first");
    assert.equal(testsAnswerOf({ error: new Error("step_run: not_available: this server's task store is its host's") }), "no");
    assert.equal(testsAnswerOf({ error: new Error("network") }), "unknown");
    assert.equal(testsAnswerOf({ data: { tests: [] } }), "yes");
  });

  it("the Support tab (plans/support-chat.md §3): shown when Support is on, its deep link, how a conversation and a message read", () => {
    assert.equal(shownOf({ types: [], workers: [], testsAnswer: "yes", supportAnswer: "yes" }).support, true);
    assert.equal(shownOf({ types: [], workers: [], testsAnswer: "yes", supportAnswer: "no" }).support, false, "no message token, or an NWC wallet, and no conversation");
    assert.deepEqual(placeOf({ tab: "support", worker: "secp:abc" }), { tab: "support", worker: "secp:abc" }, "not the worker's Workers page");
    assert.deepEqual(placeOf({ tab: "support" }), { tab: "support" });
    for (const p of [{ tab: "support" }, { tab: "support", worker: "secp:abc" }] as const) assert.deepEqual(placeOf(inputOf(p)), p);
    // The name staff gave them first, then their Sphinx name, then the actor.
    const c = { worker: "secp:0123456789abcdef", alias: "Ana" };
    assert.equal(supportName(c, { actor: c.worker, note: "Ana Lopez\nlikes pets" }), "Ana Lopez");
    assert.equal(supportName(c), "Ana");
    assert.equal(supportName({ worker: c.worker }), "secp:0123…def");
    assert.deepEqual([initialsOf("Ana Lopez"), initialsOf("bo"), initialsOf("secp:0123…def")], ["AL", "BO", "01"]);
    const task = "0123456789abcdef0123456789abcdef";
    assert.deepEqual(textPieces(`see ${task}, please`), [{ text: "see " }, { task }, { text: ", please" }]);
    assert.deepEqual(textPieces("no task here"), [{ text: "no task here" }]);
    const m = { key: 1, fromMe: false, at: 0 };
    assert.equal(messageLine({ ...m, kind: "message", text: "hi" }), "hi");
    assert.equal(messageLine({ ...m, fromMe: true, kind: "message", text: "hello" }), "Support: hello");
    assert.equal(messageLine({ ...m, kind: "message", deleted: true }), "Message deleted");
    assert.equal(messageLine({ ...m, kind: "file", file: { state: "kept", mediaType: "image/jpeg" } }), "Photo");
    assert.equal(messageLine({ ...m, kind: "file", file: { state: "too_large", name: "a.mov" } }), "a.mov");
    assert.equal(messageLine({ ...m, kind: "contact" }), "Added Support as a contact");
    assert.equal(paymentLine({ fromMe: false, sats: 1200 }), "Sent you 1,200 sats");
    assert.equal(paymentLine({ fromMe: true, sats: 1 }), "Support sent 1 sat");
    assert.deepEqual([fmtBytes(820), fmtBytes(14_000), fmtBytes(3_400_000)], ["820 B", "14 KB", "3.2 MB"]);
  });

  it("Support's rows as the page draws them (plans/people-and-hosts.md §5): a message, a conversation, settings, a search", () => {
    const row: MessageRow = { key: 7, id: "sx", from_me: 1, kind: "file", text: "the rules", reply_to: "q1", sats: null, deleted: 0, by: "welcome", status: "failed", error: "not_a_contact: no", media_type: "application/pdf", file_name: "Rules.pdf", file_size: 12, file_state: "kept", at: 5 };
    assert.deepEqual(messageOf(row), { key: 7, id: "sx", fromMe: true, kind: "file", text: "the rules", replyTo: "q1", file: { name: "Rules.pdf", mediaType: "application/pdf", size: 12, state: "kept" }, status: "failed", error: "not_a_contact: no", at: 5, auto: "welcome" });
    // A deleted one shows neither its text nor its file (ruling 12); an admin's own is never named (ruling 4).
    assert.deepEqual(messageOf({ ...row, deleted: 1, by: "secp:admin", status: "sent", error: null }), { key: 7, id: "sx", fromMe: true, kind: "file", replyTo: "q1", deleted: true, status: "sent", at: 5 });
    assert.deepEqual(messageOf({ ...row, from_me: 0, kind: "file", text: null, by: null, status: null, error: "too_large", file_state: "too_large", file_size: null }).file, { name: "Rules.pdf", mediaType: "application/pdf", state: "too_large", error: "too_large" });
    const c = conversationOf(
      { pubkey: "02ab", actor: "secp:ab", seen_at: null, status: "open", welcomed_at: 3, assigned: "me", unread: 2, last_key: 9, last_from_me: 0, last_kind: "message", last_text: "hi", last_deleted: 0, last_media_type: null, last_file_name: null, last_sats: null, last_at: 8 },
      "Ana",
    );
    assert.deepEqual(c, { worker: "secp:ab", pubkey: "02ab", alias: "Ana", unread: 2, last: { key: 9, fromMe: false, kind: "message", text: "hi", at: 8 }, welcomedAt: 3, status: "open", assigned: "me" });
    assert.equal(messageLine(c.last!), "hi");
    assert.deepEqual(settingsOf({ welcome: "", welcome_since: null, welcome_saved_at: null, payout_lines: 1, photo: null, photo_type: null, photo_url: null }), { welcome: "", payoutLines: true });
    assert.deepEqual(settingsOf({ welcome: "Hi", welcome_since: 1, welcome_saved_at: 2, payout_lines: 0, photo: { base64: "AA==" }, photo_type: "image/jpeg", photo_url: "https://m/x" }), {
      welcome: "Hi",
      since: 1,
      savedAt: 2,
      payoutLines: false,
      photo: { url: "https://m/x", mediaType: "image/jpeg", base64: "AA==" },
    });
    assert.equal(likeOf("50%_off\\"), "%50\\%\\_off\\\\%");
    assert.ok(searchHit("ana", c, ["", "Ana"], new Set()), "by name");
    assert.ok(searchHit("lopez", c, ["Ana Lopez\nlikes pets", ""], new Set()), "by the staff's note");
    assert.ok(searchHit("rules", c, [], new Set(["02ab"])), "by what a message says");
    assert.ok(!searchHit("bo", c, ["", "Ana"], new Set()));
  });

  it("Support's item 2 (plans/support-chat.md §3): a staff file in a line, a photo's size once shrunk, what may be sent", () => {
    const m = { key: 1, fromMe: true, at: 0 };
    assert.equal(messageLine({ ...m, kind: "file", file: { state: "kept", mediaType: "image/jpeg" } }), "Support: Photo");
    assert.equal(messageLine({ ...m, kind: "file", text: "the rules", file: { state: "kept", name: "Rules.pdf", mediaType: "application/pdf" } }), "Support: Rules.pdf: the rules");
    assert.deepEqual(fitWithin(4032, 3024, 1600), { width: 1600, height: 1200 });
    assert.deepEqual(fitWithin(900, 1600, 1600), { width: 900, height: 1600 }, "never larger");
    assert.deepEqual(fitWithin(3000, 100, 512), { width: 512, height: 17 });
    assert.deepEqual([shrinkable("image/jpeg"), shrinkable("image/PNG"), shrinkable("image/gif"), shrinkable("image/svg+xml"), shrinkable("application/pdf")], [true, true, false, false, false]);
    assert.equal(attachProblem({ size: 2.5 * 1024 * 1024 }), undefined);
    assert.match(attachProblem({ size: 2.5 * 1024 * 1024 + 1 }) ?? "", /^Files up to 2\.5 MB/);
    assert.deepEqual(SUPPORT_FILTERS.map((f) => f.id), ["open", "mine", "unassigned", "done"]);
    assert.deepEqual([jpgName("IMG_0042.HEIC"), jpgName("scan"), jpgName(".png")], ["IMG_0042.jpg", "scan.jpg", "photo.jpg"]);
  });

  it("the Payouts tab: its deep links, an address and a state in words, the cover, the worker cap's use", () => {
    const key = "ab".repeat(32);
    assert.deepEqual(placeOf({ tab: "payouts" }), { tab: "payouts" });
    assert.deepEqual(placeOf({ tab: "payouts", worker: "secp:abc" }), { tab: "payouts", worker: "secp:abc" }, "a worker's page links here: not their Workers page");
    assert.deepEqual(placeOf({ worker: "secp:abc" }), { tab: "workers", worker: "secp:abc" });
    assert.deepEqual(placeOf({ payout: key }), { tab: "payouts", payout: key });
    for (const p of [{ tab: "payouts" }, { tab: "payouts", worker: "secp:abc" }, { tab: "payouts", payout: key }] as const) assert.deepEqual(placeOf(inputOf(p)), p);
    assert.deepEqual(inputOf({ tab: "payouts", worker: "w" }), { tab: "payouts", worker: "w" });
    const address = `02${"a1".repeat(32)}_03${"b2".repeat(32)}_1099511627776`;
    assert.equal(shortAddress(address), "02a1a1…a1a1_…_1099511627776");
    assert.equal(shortAddress("not-an-address"), "not-an-address");
    const p = { state: "out", stale: false } as const;
    assert.deepEqual([payoutState(p), payoutState({ ...p, stale: true }), payoutState({ state: "paid", stale: false }), payoutState({ state: "failed", stale: false })], ["out", "stale", "paid", "failed"]);
    assert.equal(payoutCover(undefined), null, "nothing owed: no line");
    const books = { workers: { owedMsat: 20_000, heldMsat: 20_000, withdrawableMsat: 0, payees: 1, accepted: { answers: 1, msat: 20_000, days: [] }, takenBack: { answers: 0, msat: 0 } }, wallet: { balance: { msat: 5_000 }, coverMsat: -15_000 } };
    assert.equal(payoutCover(books)!.short, true);
    const day = "2026-11-13";
    assert.equal(
      mostByOneWorkerToday([{ worker: "a", msat: 3000, state: "paid", day }, { worker: "a", msat: 2000, state: "out", day }, { worker: "b", msat: 4000, state: "paid", day }, { worker: "b", msat: 9000, state: "failed", day }, { worker: "a", msat: 9000, state: "paid", day: "2026-11-12" }], day),
      5000,
      "a failed payout and another day count for nothing",
    );
    assert.equal(mostByOneWorkerToday([], day), 0);
  });

  it("Invite (§5.8): the sats as typed, what may still be shared or cancelled, why a server cannot invite, the WhatsApp link", () => {
    assert.deepEqual(inviteSatsOf(" "), { problem: "Enter the sats they start with." }, "blank is a problem: the box starts filled");
    assert.deepEqual(inviteSatsOf(" 250 "), { sats: 250 });
    for (const bad of ["0", "1.5", "-3", "100001", "lots"]) assert.ok("problem" in inviteSatsOf(bad), bad);
    assert.deepEqual((["sending", "ready", "failed", "used", "cancelled"] as const).filter((status) => inviteOpen({ status })), ["sending", "ready"]);
    // The read backstop: fast while paying, slow while waiting for use, never otherwise.
    assert.equal(invitesReadMs([{ status: "ready" }, { status: "sending" }]), 3_000);
    assert.equal(invitesReadMs([{ status: "used" }, { status: "ready" }]), 30_000);
    assert.equal(invitesReadMs([{ status: "used" }, { status: "cancelled" }]), false);
    assert.equal(invitesReadMs(undefined), false);
    assert.equal(Object.keys(INVITE_WORDS).length, 5);
    // Plain first, for an admin who is not technical; the cause in brackets for whoever runs the server.
    assert.match(inviteWhyText("no_pay_credential"), /^To invite people, this server's wallet has to be set up first, in Earnings\. \(.*pay token\.\)$/);
    assert.match(inviteWhyText("no_invites"), /^This server's wallet cannot make invites yet: it needs an update\. \(.*invite routes\.\)$/);
    const link = "https://s.example/public/join#action=i&d=AA&a=https%3A%2F%2Fs.example%2F%3Fapp%3Dw";
    const wa = new URL(whatsappUrl(link));
    assert.equal(wa.origin, "https://wa.me");
    assert.ok(wa.searchParams.get("text")!.endsWith(link), "the link whole, # and all");
  });

  it("Invite history: newest first, who took it, link expiry, badges", () => {
    const inv = (code: string, createdAt?: string) => ({ code, ...(createdAt ? { createdAt } : {}) });
    assert.deepEqual(
      sortInvites([inv("none"), inv("old", "2026-01-01T00:00:00Z"), inv("new", "2026-03-01T00:00:00Z"), inv("none2")]).map((i) => i.code),
      ["new", "old", "none", "none2"],
    );
    const workers = [
      { actor: "secp:aaaaaaaaaaaaaaaa", name: "Ada", grants: [{ type: "t", at: 5, by: "invite:c1" }] },
      { actor: "secp:bbbbbbbbbbbbbbbb", grants: [{ type: "t", at: 9, by: "invite:c2" }] },
    ];
    assert.deepEqual(acceptedBy({ code: "c1" }, workers), { who: "Ada", at: 5 });
    assert.equal(acceptedBy({ code: "c2" }, workers)!.who, "secp:bbbb…bbb");
    assert.equal(acceptedBy({ code: "c3" }, workers), null);
    assert.equal(acceptedBy({ code: "c1" }, undefined), null);
    assert.equal(inviteExpiry({ createdAt: "2026-01-01T00:00:00Z" }), Date.parse("2026-04-01T00:00:00Z"));
    assert.equal(inviteExpiry({ createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z" }), Date.parse("2026-02-01T00:00:00Z"));
    assert.equal(inviteExpiry({}), null);
    assert.equal(inviteBadge("ready").label, "Ready · unused");
    assert.match(inviteBadge("used").className, /green/);
    assert.match(inviteBadge("failed").className, /destructive/);
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

  it("an open grant and what a paid open type means for who earns, in words (rulings 9 and 12)", () => {
    assert.equal(grantedBy({ by: "ada" }), "by ada");
    assert.equal(grantedBy({ by: "open" }), "by themselves: the type is open");
    assert.equal(liveTypesText({ grants: [{ type: "a", at: 0, by: "open" }, { type: "b", at: 0, by: "ada" }, { type: "c", at: 0, by: "open", revokedAt: 1 }] }), "a (open), b");
    const paid = { open: true, paySats: 5, testsOn: true, qualify: 10 };
    assert.equal(openPayHint(paid, 10), null);
    assert.match(openPayHint(paid, 7)!, /qualifies newcomers on 10 tests and has 7 ready, so it takes no new worker until they are/);
    // No qualifying is the admin's call: said, whatever is counted.
    assert.match(openPayHint({ ...paid, testsOn: false }, 0)!, /no qualifying tests: anyone signed in earns from their first answer/);
    assert.match(openPayHint({ ...paid, qualify: 0 }, undefined)!, /no qualifying tests/);
    assert.equal(openPayHint({ ...paid, open: false }, 0), null, "invite-only");
    assert.equal(openPayHint({ ...paid, paySats: 0 }, 0), null, "unpaid");
    assert.equal(openPayHint(paid, undefined), null, "not counted here: the server says");
  });

  it("who a worker is, their standing in a cell, a lease's outcome, the list's order", () => {
    assert.equal(shortActor("secp:3fa2d0e1c9b87a6591c"), "secp:3fa2…91c");
    assert.equal(shortActor("ada"), "ada");
    assert.equal(whoOf({ actor: "secp:3fa2d0e1c9b87a6591c", note: "Ada Lovelace\nfrom the invite" }), "Ada Lovelace");
    // A name (plans/people-and-hosts.md §1): after the staff's own note, the short key beside it.
    assert.equal(whoOf({ actor: "secp:3fa2d0e1c9b87a6591c", name: "Ada L." }), "Ada L.");
    assert.equal(whoOf({ actor: "secp:3fa2d0e1c9b87a6591c", note: "Ada Lovelace", name: "Ada L." }), "Ada Lovelace", "the note comes first");
    assert.equal(whoElse({ actor: "secp:3fa2d0e1c9b87a6591c", name: "Ada L." }), "secp:3fa2…91c");
    assert.equal(whoElse({ actor: "secp:3fa2d0e1c9b87a6591c", note: "Ada Lovelace", name: "Ada L." }), "Ada L. · secp:3fa2…91c");
    assert.equal(whoElse({ actor: "secp:3fa2d0e1c9b87a6591c" }), "", "the key is already what shows");
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

  it("a task's pictures, drawn at once: an image's media type, or a path's extension; the answer's files from the lease that gave it", () => {
    assert.equal(isPicture("tasks/t/photo-1.jpg", "image/jpeg"), true);
    assert.equal(isPicture("images/remix.png", "image/png"), true);
    assert.equal(isPicture("photo.jpg", "text/plain"), false, "the media type wins over the name");
    assert.equal(isPicture("notes.txt", "text/plain"), false);
    // A task's own files are paths alone.
    for (const p of ["found.jpg", "a/b.JPEG", "x.png", "x.gif", "x.webp", "x.avif"]) assert.equal(isPicture(p), true, p);
    for (const p of ["found.txt", "doc.pdf", "jpg", "x.svg"]) assert.equal(isPicture(p), false, p);

    const photo = { name: "IMG_1.jpg", mediaType: "image/jpeg", size: 9, path: "tasks/t/photo-1.jpg" };
    const lease = (worker: string, status: "submitted" | "skipped", attachments?: (typeof photo)[]) => ({
      id: worker, task: "t", worker, type: "photo", taken: 0, expires: 0, status, ...(attachments ? { attachments } : {}),
    });
    assert.deepEqual(answerFiles({ by: "ann", leases: [lease("bob", "skipped"), lease("ann", "submitted", [photo])] }), [photo]);
    assert.deepEqual(answerFiles({ by: "ann", leases: [lease("ann", "skipped", [photo]), lease("ann", "submitted")] }), [], "the lease that answered, not one put back");
    assert.deepEqual(answerFiles({ leases: [lease("ann", "submitted", [photo])] }), [], "no answer accepted (disputed): each copy's are on its lease");
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
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale, app.manifest.admin, app.manifest.title], ["v1", "strut", "seed", false, true, "Workers"]);
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
    const saved = await admin("staff/save-type", { name: "pets", app: "workers", answer: MATCH, open: false, paySats: 10, holdHours: 24, copies: { max: 3, agree: 2 } });
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
    // Granted to w1, and to ada, who made it (a new invite-only type is its maker's, to try it).
    assert.deepEqual([pets.waiting, pets.working, pets.granted, pets.app, pets.appProblem], [1, 0, 2, "workers", undefined]);
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
    // The Workers tab's names (plans/people-and-hosts.md §1): granted, every name on an admin's page.
    await strut.people.setName("w1", "Willa", "host");
    assert.deepEqual((await admin("people/names", { actors: ["w1", "w2"] })).result, { people: { w1: { name: "Willa" }, w2: {} } });
    const back = await admin("staff/take-back", { task: id, worker: "w1", why: "the wrong pet" });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.result.earnings[0].result, "taken");

    // 5b: the Payouts tab's four steps, granted by the app, reach the payout routes in the admin's name.
    const none = await admin("staff/payouts");
    assert.equal(none.error, undefined, none.error);
    assert.deepEqual([none.result.settings.on, none.result.payouts, none.result.today.serverLeftMsat], [false, [], 10_000_000_000]);
    const savedP = await admin("staff/save-payouts", { on: true, minSats: 10, workerDaySats: 500, serverDaySats: 5000 });
    assert.equal(savedP.error, undefined, savedP.error);
    assert.deepEqual([savedP.result.settings.on, savedP.result.settings.minSats, savedP.result.settings.changedBy], [true, 10, "ada"]);
    assert.equal((await admin("staff/payouts", { state: "stale" })).result.today.serverLeftMsat, 5_000_000);
    assert.match((await admin("staff/payout-read", { key: "ab".repeat(32) })).error ?? "", /unknown_payout/);
    assert.match((await admin("staff/payout-resolve", { key: "ab".repeat(32), action: "drop" })).error ?? "", /unknown_payout/);
    await admin("staff/save-payouts", { on: false, minSats: 1000, workerDaySats: 1_000_000, serverDaySats: 10_000_000 });

    // §9.6: a verdict through the door, in the admin's name; a mark that
    // leaves the finished run as it was.
    const events = (await strut.store.getRunEvents("pets", runId)).length;
    const summary = await strut.store.getRunSummary("pets", runId);
    assert.deepEqual((await admin("staff/tasks", { review: "none" })).result.tasks.map((t: { id: string }) => t.id), [id], "the review queue");
    const rv = await admin("staff/review", { task: id, verdict: "rejected", why: "the wrong pet" });
    assert.equal(rv.error, undefined, rv.error);
    assert.deepEqual([rv.result.worker, rv.result.review.verdict, rv.result.review.by], ["w1", "rejected", "ada"]);
    assert.equal(rv.result.earning.takenBackWhy, "the wrong pet", "taken back by staff already: the rejection takes nothing more");
    const okd = await admin("staff/review", { task: id, verdict: "ok" });
    assert.equal(okd.result.earning.takenBackWhy, "the wrong pet", "and ok never undoes a staff take-back");
    await admin("staff/review", { task: id, verdict: "rejected", why: "the wrong pet" });
    assert.equal((await admin("staff/task", { id })).result.task.leases[0].review.why, "the wrong pet");
    assert.deepEqual((await admin("staff/tasks", { review: "rejected", by: "w1" })).result.tasks.map((t: { id: string }) => t.id), [id]);
    assert.equal((await admin("staff/worker", { actor: "w1" })).result.recent[0].lease.review.verdict, "rejected", "the worker's page shows it");
    assert.match((await admin("staff/review", { task: id, verdict: "rejected" })).error ?? "", /bad_request: a rejection says why/);
    // Groups (task/reply's group): granted by the app, through the door in the
    // admin's name; this run named none.
    assert.deepEqual((await admin("staff/groups", { type: "pets" })).result, { groups: [] });
    assert.deepEqual((await admin("staff/tasks", { group: "Book one" })).result.tasks, []);
    assert.deepEqual((await admin("staff/review-group", { group: "Book one", verdict: "ok" })).result, { reviewed: 0, more: false });
    assert.match((await admin("staff/review-group", { group: "Book one", verdict: "rejected" })).error ?? "", /bad_request: a rejection says why/);
    assert.equal((await strut.store.getRunEvents("pets", runId)).length, events, "the run is not touched");
    assert.deepEqual(await strut.store.getRunSummary("pets", runId), summary);
  });

  it("staff/types answers each type's share and Tasks': not public, then public with its links on the request's base and a QR of the Peel link", async () => {
    const cookie = await signIn("ada", "admin");
    // As mcp's /lab proxies it: another host, a mount path.
    const lab = { cookie, "x-forwarded-host": "box.example", "x-forwarded-proto": "https", "x-forwarded-prefix": "/lab" };
    const answer = async () => {
      const r = await door("/mcp", lab, "staff/types");
      assert.equal(r.error, undefined, r.error);
      return r.result as { types: TaskType[]; tasks?: TaskType["share"] };
    };
    const types = async () => (await answer()).types.find((t: { name: string }) => t.name === "pets") as TaskType;
    assert.deepEqual((await types()).share, { public: false }, "workers is not in the public view: no links");
    assert.deepEqual((await answer()).tasks, { public: false }, "nor is Tasks, which every invite opens");
    const put = await strut.app.request("/public-view", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ apps: [{ name: "workers" }, { name: "strut/worker" }] }) });
    assert.equal(put.status, 200, await put.clone().text());
    const share = (await types()).share!;
    const link = "https://box.example/lab/?app=workers&solo=1&public=1";
    assert.deepEqual([share.public, share.link, share.peelLink], [true, link, `peel://open?url=${encodeURIComponent(link)}`]);
    assert.equal(share.qrSvg, qrSvg(share.peelLink!), "the QR is the Peel link's");
    const tasks = (await answer()).tasks!;
    assert.deepEqual([tasks.public, tasks.link], [true, "https://box.example/lab/?app=strut%2Fworker&solo=1&public=1"]);
    assert.equal(tasks.qrSvg, qrSvg(tasks.peelLink!));
    // The invite panel's choices: each type that is on, open or invite-only, its app online or not.
    const pets = await types();
    assert.deepEqual(inviteChoices([pets, { ...pets, name: "off", enabled: false }, { ...pets, name: "drafts", app: "drafts", open: true, share: { public: false } }]), [
      { name: "drafts", label: "drafts", open: true, app: "drafts", online: false },
      { name: "pets", label: "pets", open: false, app: "workers", online: true },
    ]);
    assert.equal(inviteWorkText(undefined), "Tasks shows them every kind of open work.");
    assert.equal(inviteWorkText(inviteChoices([pets])[0]), "Invite-only: this link makes it theirs.");
    assert.equal(anyOpenWork([pets]), false, "pets is invite-only here: no link for a group");
    assert.equal(anyOpenWork([{ ...pets, open: true }]), true);
    await strut.app.request("/public-view", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ apps: [] }) });
  });

  it("a member's session on the same page, a visitor and a peer are refused every staff/* step", async () => {
    const member = page(signIn("bo", "member"));
    const configs: Record<string, Record<string, unknown>> = { "staff/grant": { actor: "x", type: "pets" }, "staff/save-type": { name: "x", app: "workers", answer: MATCH }, "staff/review": { task: "t1", verdict: "ok" }, "staff/review-group": { group: "g", verdict: "ok" } };
    for (const type of ["staff/stats", "staff/types", "staff/workers", "staff/tests", "staff/save-type", "staff/grant", "staff/review", "staff/groups", "staff/review-group"]) {
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
    for (const path of ["/tasks/stats", "/tasks/types", "/tasks/workers/w1", "/tasks?by=w1", "/tasks?review=none", "/tasks/groups"]) {
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
