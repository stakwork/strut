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
import { answerText, askOver, formProblem, mergeType, typeCard, typeChangeInput, type TaskTypeRow, type TaskTypesCapability, type TypeChange } from "./set-type.js";
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
  openTasks: 0,
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
    refused({ holdHours: -1 }, /holdHours|too_small|>=/i);
    refused({ leaseSeconds: 1.5 }, /leaseSeconds|int/i);
    refused({ name: "Pet Match" }, /lowercase letters/);
    assert.ok(typeChangeInput.safeParse({ name: "x", app: "a", tests: null, copies: null, standing: null }).success, "null turns them off");
    assert.equal(typeChangeInput.safeParse({ name: "x", standing: { workflow: "" } }).success, false, "standing names a workflow");
    assert.equal(typeChangeInput.safeParse({ name: "x", standing: { workflow: "w", every: 3 } }).success, false, "standing is { workflow } alone");
    // What the model is handed: a JSON Schema, `rationale` beside the fields.
    const gated = gatedSchema(typeChangeInput);
    assert.ok(gated instanceof z.ZodObject);
    const json = zodSchema(gated).jsonSchema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(json.properties), ["name", "title", "app", "answer", "leaseSeconds", "withinHours", "enabled", "open", "paySats", "holdHours", "payOn", "limits", "tests", "copies", "attachments", "standing", "round", "check", "rationale"]);
    assert.deepEqual(json.required, ["name", "app"]);
    // The answer is said to be an object, so the model sends one; the rules too.
    for (const k of ["answer", "tests", "copies", "attachments", "standing", "round", "check"]) assert.match(JSON.stringify(json.properties[k]), /"object"/, k);
  });

  it("an object field sent as JSON text is parsed, then checked as an object; text that does not parse keeps the shape's refusal", () => {
    const r = typeChangeInput.safeParse({
      name: "pet-match",
      app: "workers",
      answer: JSON.stringify(MATCH),
      tests: '{"qualify":2}',
      copies: "null",
      attachments: '{"max":2}',
      standing: '{"workflow":"found-pets"}',
    });
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.deepEqual(r.data, { name: "pet-match", app: "workers", answer: MATCH, tests: { qualify: 2 }, copies: null, attachments: { max: 2 }, standing: { workflow: "found-pets" } });
    const broken = typeChangeInput.safeParse({ name: "pet-match", app: "workers", answer: '{"type": "object",' });
    assert.equal(broken.success, false);
    assert.match(JSON.stringify(broken.error?.issues), /answer: schema: a schema is an object/);
    assert.equal(typeChangeInput.safeParse({ name: "x", app: "a", answer: JSON.stringify({ type: "object", properties: { x: { type: "string", format: "email" } } }) }).success, false, "parsed, then checked");
    assert.equal(typeChangeInput.safeParse({ name: "x", app: "a", standing: '{"workflow":""}' }).success, false);
  });


  it("the merge keeps what is left out and merges tests and copies over the type's own; null turns them off; a new type with no answer takes the empty one", () => {
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
    // Open (ruling 9): kept when left out, changed when given.
    assert.equal(mergeType("pet-match", { ...was, open: false }, { app: "workers" }).open, false);
    assert.equal(mergeType("pet-match", { ...was, open: false }, { app: "workers", open: true }).open, true);
    // A new type with no answer: the empty object, a files-only task.
    assert.deepEqual(mergeType("new", undefined, { app: "workers" }), { app: "workers", answer: { type: "object", properties: {} } });
  });

  it("a title may be a language map: merged whole, kept, and written on the card", () => {
    const map = { en: "Scan book", es: "Escanear libro" };
    assert.deepEqual(mergeType("pet-match", row({}), { app: "workers", title: map }).title, map);
    assert.equal(typeChangeInput.safeParse({ name: "x", app: "a", title: map }).success, true);
    assert.equal(typeChangeInput.safeParse({ name: "x", app: "a", title: { "Not A Lang": "x" } }).success, false);
    assert.equal(typeChangeInput.safeParse({ name: "x", app: "a", title: { en: "x".repeat(81) } }).success, false);
    assert.equal(typeCard({ name: "pet-match", app: "workers", title: map }).title, "New task: Scan book / Escanear libro");
  });

  it("a title (plans/i18n.md) is kept when left out, replaced when given, gone with null; the card says it", () => {
    const was = row({ title: "Revisión de recibo" });
    assert.equal(mergeType("pet-match", was, { app: "workers" }).title, "Revisión de recibo");
    assert.equal(mergeType("pet-match", was, { app: "workers", title: "Foto del recibo" }).title, "Foto del recibo");
    assert.equal("title" in mergeType("pet-match", was, { app: "workers", title: null }), false);
    assert.equal(typeChangeInput.safeParse({ name: "x", app: "a", title: "x".repeat(81) }).success, false, "80 characters at most");
    const card = typeCard({ name: "pet-match", app: "workers", title: "Foto del recibo" }, { existing: was });
    assert.equal(card.title, "Change task: Foto del recibo");
    assert.equal(field(card, "What changes")!.value, "what workers call it: “Revisión de recibo” → “Foto del recibo”");
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

  it("the card for a new type, for a person who is not technical: a sentence, then what a worker hands in, when, who and the pay in their words; the type's settings under Details", () => {
    const card = typeCard({ name: "pet-match", app: "workers", answer: MATCH, withinHours: 48 });
    assert.equal(card.title, "New task: pet match");
    assert.deepEqual(card.actions, { accept: "Approve", reject: "Don't" });
    assert.deepEqual(
      card.fields!.map((f) => [f.label, f.value, f.detail ? "detail" : f.danger ? "danger" : "shown"]),
      [
        ["A worker hands in", "Answers:\n• The same pet? — yes or no\n• Note — a few words (optional)", "shown"],
        ["When", "When a workflow sends one out: one for each thing it asks about.", "shown"],
        ["Who can do it", "Anyone signed in to the worker page.", "shown"],
        ["Pay", "Unpaid.", "shown"],
        ["Task type", "pet-match, in the app workers", "detail"],
        ["The answer", 'same ("The same pet?"): yes or no, required\nnote: text up to 200 characters', "detail"],
        ["Time limits", "10 minutes to finish one once started; one nobody takes expires after 48 hours", "detail"],
        ["Workers", "none yet: anyone signed in holds it from their first ask", "detail"],
        ["Tests", "off", "detail"],
        ["Copies", "off: a step asks one worker", "detail"],
        ["Checked when handed in", "No: every answer that fits is accepted the moment it is handed in.", "detail"],
      ],
    );
    assert.equal(card.summary, 'Anyone signed in to the worker page can do the "pet match" task when a workflow sends one out, unpaid.');
    // §5.6: the files an answer carries, said as photos (or files), merged over the defaults; a bad rule refused on the card.
    const photo = typeCard({ name: "court-paper", app: "workers", answer: MATCH, attachments: { max: 4, min: 1, types: ["image/*"] } });
    assert.equal(field(photo, "A worker hands in")!.value, "1 to 4 photos, and answers:\n• The same pet? — yes or no\n• Note — a few words (optional)");
    assert.match(field(typeCard({ name: "court-paper", app: "workers", answer: MATCH, attachments: {} }), "A worker hands in")!.value, /^up to 1 file, and answers:/);
    assert.equal(typeChangeInput.safeParse({ name: "court-paper", attachments: { max: 11 } }).success, false, "max past 10 is the model's error");
    assert.deepEqual(mergeType("court-paper", { app: "workers", answer: MATCH, leaseSeconds: 600, withinHours: 72, enabled: true, holdHours: 72, attachments: { max: 4, min: 1, types: ["image/*"] } }, { attachments: { max: 2 } }).attachments, { max: 2, min: 1, types: ["image/*"] });
    // Only people you invite: the admin gives it to each.
    const invite = typeCard({ name: "pet-match", app: "workers", answer: MATCH, open: false });
    assert.equal(field(invite, "Who can do it")!.value, "Only people you invite: give it to each of them in Workers.");
    assert.equal(field(invite, "Workers")!.value, "none yet: you give it to each worker in Workers (strut/workers)");
    assert.match(invite.summary!, /^Only people you invite can do the "pet match" task/);
    // A new type with no answer: nothing to hand in but what the files rule says; nothing that fails.
    const none = typeCard({ name: "pet-match", app: "workers" });
    assert.equal(field(none, "A worker hands in")!.value, "nothing");
    assert.deepEqual(field(none, "The answer"), { label: "The answer", value: "no fields: only the files sent with it", detail: true });
    assert.doesNotMatch(none.summary!, /Approving it fails/);
    // Made switched off: said in the sentence.
    assert.match(typeCard({ name: "pet-match", app: "workers", answer: MATCH, enabled: false }).summary!, /It starts switched off: nobody gets one until it is turned on\.$/);
    // A paid new type: dollars first, then sats, and the wait; a rise from nothing, so a danger, never folded.
    const paid = typeCard({ name: "pet-match", app: "workers", answer: MATCH, open: false, paySats: 10, tests: { qualify: 3 }, copies: { max: 2, agree: 2 } }, { usdPerBtc: 100_000 });
    assert.deepEqual(field(paid, "Pay"), { label: "Pay", value: "$0.01 (10 sats) for each one, from this server's wallet. Workers can withdraw it at once.", danger: true });
    const held = typeCard({ name: "pet-match", app: "workers", answer: MATCH, open: false, paySats: 10, holdHours: 72 }, { usdPerBtc: 100_000 });
    assert.match(field(held, "Pay")!.value, /Workers can withdraw it 3 days later\.$/);
    assert.match(paid.summary!, /for \$0\.01 \(10 sats\) each, paid from this server's wallet\.$/);
    assert.match(field(paid, "Tests")!.value, /^on: 5% of tasks are tests \(25% until a worker has answered 50 real ones\); 3 tests to qualify before any real task; a grant is revoked under 80% passed of the last 20 graded, read once 10 are; graded by equal answers$/);
    assert.equal(field(paid, "Copies")!.value, "on: a step may ask up to 2 workers, each paid; 2 matching answers settle a task, compared by equal answers; when they disagree one more worker is asked, up to 2");
    // Ruling 12: a new PAID type anyone may take is the admin's call — said plainly as a danger, never refused.
    const paidOpen = typeCard({ name: "pet-match", app: "workers", answer: MATCH, paySats: 10, tests: { qualify: 3 } });
    assert.deepEqual(field(paidOpen, "Who can do it"), {
      label: "Who can do it",
      value: "Anyone signed in to the worker page, after passing a test of 3 tasks, but only 0 of its 3 test tasks are ready, so nobody new can start until 3 more are made.",
      danger: true,
    });
    assert.match(paidOpen.summary!, /Nobody new can start it until 3 more test tasks are made\.$/);
    assert.doesNotMatch(paidOpen.summary!, /Approving it fails/);
    const noTests = typeCard({ name: "pet-match", app: "workers", answer: MATCH, paySats: 10 });
    assert.deepEqual(field(noTests, "Who can do it"), {
      label: "Who can do it",
      value: "Anyone signed in to the worker page, and they are paid from their first one: there is no qualifying test, so only your own review of their answers checks them.",
      danger: true,
    });
    assert.match(noTests.summary!, /Anyone signed in is paid from their first one, with no qualifying test\.$/);
    // §5.7: a standing type is "any time", and names the workflow each one starts.
    const standing = typeCard({ name: "labels", app: "workers", answer: MATCH, standing: { workflow: "nutrition-label" } });
    assert.equal(standing.summary, 'Anyone signed in to the worker page can do the "labels" task whenever they like, as many as they like, unpaid.');
    assert.equal(field(standing, "When")!.value, "Any time: a worker starts one whenever they like, and many can work at once. Each one they hand in starts the workflow nutrition-label.");
    assert.equal(field(standing, "Time limits")!.value, "10 minutes to finish one once started", "a standing task has no expiry: it lives as long as its lease");
    // A round type: one for each item, sent from Workers or by asking.
    const round = typeCard({ name: "visits", app: "workers", answer: MATCH, round: { workflow: "shop-visits" } });
    assert.equal(field(round, "When")!.value, "One for each item, when you send a round: from Workers (Send a round), or by asking here. The workflow shop-visits makes them.");
    // What the person decides on is never folded, nor is any danger.
    for (const c of [card, invite, paid, paidOpen, noTests, standing, round]) {
      for (const f of c.fields!) assert.ok(!(f.detail && f.danger), `${f.label}: a danger is never folded`);
      assert.deepEqual(c.fields!.filter((f) => !f.detail && !f.danger).map((f) => f.label).filter((l) => l !== "Pay" && l !== "Who can do it" && l !== "Checked when handed in"), ["A worker hands in", "When"]);
    }
  });

  it("a check before an answer is accepted (§5.6.7 c): taken whole, kept when left out, gone with null; the card says what pay waits on", () => {
    const CHECK = { step: "grade/judge", config: { rubric: "One whole book page, no text cut off." } };
    assert.ok(typeChangeInput.safeParse({ name: "pages", app: "workers", check: CHECK }).success);
    assert.ok(typeChangeInput.safeParse({ name: "pages", app: "workers", check: JSON.stringify(CHECK) }).success, "as JSON text too");
    assert.equal(typeChangeInput.safeParse({ name: "pages", app: "workers", check: { step: "" } }).success, false, "a check names a step");
    assert.equal(typeChangeInput.safeParse({ name: "pages", app: "workers", check: { step: "grade/judge", rubric: "x" } }).success, false, "{ step, config? } alone");
    const was = row({ paySats: 4, check: CHECK });
    assert.deepEqual(mergeType("pages", was, { app: "workers" }).check, CHECK, "kept when left out");
    assert.deepEqual(mergeType("pages", was, { check: { step: "grade/judge" } }).check, { step: "grade/judge" }, "replaced whole, never merged");
    assert.equal(mergeType("pages", was, { check: null }).check, null);

    // Paid and checked: shown, in the person's words.
    const checked = typeCard({ name: "pages", app: "workers", answer: MATCH, paySats: 4, check: CHECK });
    assert.deepEqual(field(checked, "Checked when handed in"), {
      label: "Checked when handed in",
      value: "Yes: a model checks it: “One whole book page, no text cut off.”. One that fails is refused with the reason: the worker keeps the task and sends it again, and nothing is paid for it. Each answer costs one model call.",
    });
    assert.equal(field(typeCard({ name: "pages", app: "workers", check: { step: "grade/judge" } }), "Checked when handed in")!.value.split(".")[0], "Yes: a model checks it does what the task asks");
    assert.match(field(typeCard({ name: "pages", app: "workers", check: { step: "acme/check" } }), "Checked when handed in")!.value, /^Yes: checked by acme\/check\. .* nothing is paid for it\.$/);
    // Paid with no check: shown, so the person sees every answer is paid.
    assert.deepEqual(field(typeCard({ name: "pages", app: "workers", paySats: 4 }), "Checked when handed in"), { label: "Checked when handed in", value: "No: every answer that fits is accepted, and paid, the moment it is handed in." });
    // A change says it.
    assert.equal(field(typeCard({ name: "pages", app: "workers", check: CHECK }, { existing: row({ paySats: 4 }) }), "What changes")!.value, "checked when handed in: not checked → a model checks it: “One whole book page, no text cut off.”");
    assert.equal(field(typeCard({ name: "pages", app: "workers", check: null }, { existing: was }), "What changes")!.value, "checked when handed in: a model checks it: “One whole book page, no text cut off.” → not checked");
  });

  it("askOver: a new ask built on the waiting one — what it leaves out is the waiting one's, rules merged key by key, null off, standing replaced", () => {
    const waiting = { name: "visit", app: "workers", answer: MATCH, open: false, paySats: 5500, attachments: { max: 4, min: 4, types: ["image/*"] }, standing: { workflow: "visit" }, tests: { qualify: 3 } } as TypeChange;
    assert.deepEqual(askOver(waiting, { name: "visit", paySats: 6600 } as TypeChange), { ...waiting, paySats: 6600 });
    assert.deepEqual(
      askOver(waiting, { name: "visit", attachments: { max: 2 }, tests: null, standing: { workflow: "other" } } as TypeChange),
      { ...waiting, attachments: { max: 2, min: 4, types: ["image/*"] }, tests: null, standing: { workflow: "other" } },
    );
  });

  it("when a paid answer earns (payOn): taken whole, kept when left out, null back to as answered; the card says pay waits for an OK", () => {
    assert.ok(typeChangeInput.safeParse({ name: "pages", app: "workers", payOn: "ok" }).success);
    assert.equal(typeChangeInput.safeParse({ name: "pages", app: "workers", payOn: "later" }).success, false);
    const was = row({ paySats: 4, payOn: "ok" });
    assert.equal(mergeType("pages", was, { app: "workers" }).payOn, "ok", "kept when left out");
    assert.equal(mergeType("pages", was, { payOn: null }).payOn, null);
    const card = typeCard({ name: "pages", app: "workers", paySats: 4, payOn: "ok" });
    assert.deepEqual(field(card, "Pay"), {
      label: "Pay",
      value: "4 sats for each one marked OK — by you, or by the workflow itself — from this server's wallet; one marked rejected is never paid. Workers can withdraw it once it is OK'd.",
      danger: true,
    });
    assert.equal(field(card, "Checked when handed in")!.value, "No: every answer that fits is accepted the moment it is handed in.");
    assert.equal(field(typeCard({ name: "pages", app: "workers", payOn: "ok" }, { existing: row({ paySats: 4 }) }), "What changes")!.value, "paid: as handed in → once marked OK");
  });

  it("the card for a change: what changes in the person's words, the pay rise a danger with the last week's cost, the app's problem a danger; a cut in pay is none", () => {
    const was = row({ paySats: 10, openTasks: 3, workers: 4, answeredWeek: 40 });
    const card = typeCard({ name: "pet-match", app: "pets", answer: { ...MATCH, required: ["same", "note"] }, paySats: 25, leaseSeconds: 1200, tests: { rate: 0.1 } }, { existing: was, usdPerBtc: 100_000, appProblem: "app pets does not grant task/submit: its page cannot answer this type's tasks" });
    assert.equal(card.title, "Change task: pet match");
    assert.deepEqual(field(card, "Task type"), { label: "Task type", value: "pet-match, in the app pets — app pets does not grant task/submit: its page cannot answer this type's tasks", danger: true });
    assert.equal(
      field(card, "What changes")!.value,
      ["worker app: workers → pets", "questions: new ones (see A worker hands in)", "time to finish: 10 minutes → 20 minutes", "pay: $0.01 (10 sats) → $0.03 (25 sats)", "tests: off → on"].join("\n"),
    );
    assert.equal(card.fields![0]!.label, "What changes", "a change's card leads with it");
    assert.deepEqual(field(card, "Open tasks"), { label: "Open tasks", value: "3: their answers are checked against the new questions when handed in", detail: true });
    assert.equal(field(card, "Workers")!.value, "4 hold it");
    assert.deepEqual(field(card, "Pay"), {
      label: "Pay",
      value: "$0.03 (25 sats) for each one, from this server's wallet. Workers can withdraw it 3 days later. It is $0.01 (10 sats) now. The last week's 40 answers would have cost $1.00 (1,000 sats), against $0.40 (400 sats) at the pay now.",
      danger: true,
    });
    assert.equal(
      card.summary,
      'Changes the "pet match" task: worker app, questions, time to finish, pay, tests. Workers cannot do it yet: app pets does not grant task/submit: its page cannot answer this type\'s tasks. Its pay goes up from $0.01 (10 sats) to $0.03 (25 sats) each.',
    );
    // Rules merged over the type's own, key by key.
    const tested = row({ tests: { rate: 0.05, newRate: 0.25, newTasks: 50, qualify: 10, window: 20, minGraded: 10, threshold: 0.8, grade: "equal", gradeCapUsd: 0.05 } });
    assert.equal(field(typeCard({ name: "pet-match", app: "workers", tests: { qualify: 5, threshold: 0.9 } }, { existing: tested }), "What changes")!.value, "tests: qualify 10 → 5, threshold 0.8 → 0.9");
    // A merge the save would refuse: K over the type's own window — a danger, shown.
    const tooMany = typeCard({ name: "pet-match", app: "workers", tests: { window: 4 } }, { existing: tested });
    assert.deepEqual(field(tooMany, "Tests"), { label: "Tests", value: "refused: tests.qualify is a whole number from 0 to 4", danger: true });
    assert.match(tooMany.summary!, /Approving it fails: tests\.qualify is a whole number from 0 to 4\.$/);
    // Opened with enough ready tests on file: no danger, and the change named; short of them, a danger.
    const ready = row({ paySats: 10, open: false, readyTests: 10, tests: tested.tests! });
    const opened = typeCard({ name: "pet-match", app: "workers", open: true }, { existing: ready });
    assert.equal(field(opened, "What changes")!.value, "who can do it: only people you invite → anyone signed in to the worker page");
    assert.deepEqual(field(opened, "Who can do it"), { label: "Who can do it", value: "Anyone signed in to the worker page, after passing a test of 10 tasks." });
    const short = typeCard({ name: "pet-match", app: "workers", open: true }, { existing: { ...ready, readyTests: 7 } });
    assert.match(field(short, "Who can do it")!.value, /but only 7 of its 10 test tasks are ready, so nobody new can start until 3 more are made\.$/);
    assert.equal(field(short, "Who can do it")!.danger, true);
    assert.match(short.summary!, /Nobody new can start it until 3 more test tasks are made\.$/);
    // Made standing, and off again: "any time" against "when a workflow sends one".
    assert.equal(field(typeCard({ name: "pet-match", app: "workers", standing: { workflow: "labels" } }, { existing: was }), "What changes")!.value, "when: when a workflow sends one → any time");
    assert.equal(field(typeCard({ name: "pet-match", app: "workers", standing: null }, { existing: { ...was, standing: { workflow: "labels" } } }), "What changes")!.value, "when: any time → when a workflow sends one");
    // A cut in pay is no danger; unchanged, the card says so.
    const cut = typeCard({ name: "pet-match", app: "workers", paySats: 5 }, { existing: was });
    assert.equal(field(cut, "Pay")!.danger, undefined);
    assert.equal(field(typeCard({ name: "pet-match", app: "workers" }, { existing: was }), "What changes")!.value, "nothing: it is already so");
    // Turned off: its own title, and what becomes of its open tasks.
    const off = typeCard({ name: "pet-match", app: "workers", enabled: false }, { existing: was });
    assert.equal(off.title, "Turn off task: pet match");
    assert.equal(field(off, "What changes")!.value, "turned off");
    assert.equal(field(off, "Open tasks")!.value, "3: not handed out once it is off; they expire when due");
    assert.match(off.summary!, /^Turns off the "pet match" task: nobody gets a new one, and the open ones expire when due\./);
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
      workersApp: false,
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

  it("a second ask while the first card still waits is built on it and replaces it: one card, the whole type, and the yes saves it; once the type exists an ask is a change and replaces nothing", async () => {
    const photos = { max: 4, min: 4, types: ["image/*"] };
    const first = (await ask({ name: "visit", app: "workers", answer: MATCH, open: false, paySats: 5500, attachments: photos, rationale: "Shop visits at $5." })) as { proposal: string };
    // "Make it $6": the builder asks for the change alone, as for a type that exists.
    const second = (await ask({ name: "visit", app: "workers", paySats: 6600, rationale: "Now $6." })) as { proposal: string; title: string; replaced?: string };
    assert.equal(second.title, "New task: visit");
    assert.equal(second.replaced, first.proposal, "the builder reads that its earlier card is closed");
    const rec = await record(second.proposal);
    assert.deepEqual(rec.input, { name: "visit", app: "workers", answer: MATCH, open: false, paySats: 6600, attachments: photos }, "the record keeps the whole type the card shows");
    assert.equal(rec.replaces, first.proposal);
    assert.match(rec.card!.summary!, /^Only people you invite can do the "visit" task .* for \$6\.60 \(6,600 sats\) each, paid from this server's wallet\. .*It replaces the earlier card for this task\.$/);
    assert.match(rec.card!.fields.find((f) => f.label === "A worker hands in")!.value, /^4 photos, and answers:/);
    const old = await record(first.proposal);
    assert.deepEqual([old.status, old.replacedBy], ["rejected", second.proposal]);
    assert.deepEqual((await proposals()).filter((p) => p.status === "pending").map((p) => p.id), [second.proposal], "one card left");

    const accepted = await decide(second.proposal, auth);
    assert.equal(accepted.body.status, "applied", JSON.stringify(accepted.body.result));
    const [t] = await types();
    assert.deepEqual([t!.paySats, t!.open, t!.attachments], [6600, false, photos], "the yes saved the whole type");

    const third = (await ask({ name: "visit", app: "workers", paySats: 7000 })) as { proposal: string };
    const r3 = await record(third.proposal);
    assert.equal(r3.replaces, undefined);
    assert.deepEqual(r3.input, { name: "visit", app: "workers", paySats: 7000 }, "a change of the type, merged over it when saved");
    assert.equal(r3.card!.title, "Change task: visit");
  });

  it("task/grant is a card an admin approves: no worker named grants the person who asked; task/report reads spend and each worker's numbers; staff grant @me and make a grant link", async () => {
    const cap = strut.tasks.capability;
    await cap.setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 21, limits: { budgetSats: 100 } }, "ada");
    const tool = buildRegistryTools(["task/grant"], strut.getRegistry(), ctx({ actor: "tom", principal: "tom" }), (d: unknown) => d, { approve: new Set(["task/grant"]), session: "s1" })["task_grant"] as Tool;
    const asked = (await tool.execute({ type: "pet-match" }, { strutToolPath: "orchestrator/turn/001-task_grant" })) as { proposal: string; status: string; title: string };
    assert.equal(asked.status, "pending");
    assert.equal(asked.title, 'Give you the "pet-match" work');
    const rec = await record(asked.proposal);
    assert.equal(rec.approver, "admin");
    // Never on its own: a direct call, or the door with a pending record.
    await assert.rejects(step("task/grant").run({ type: "pet-match" }, ctx()), /runs only as a proposal an admin accepted/);
    await assert.rejects(taskTypes().grant({ type: "pet-match" }, { proposal: asked.proposal }), /grant_needs_admin/);
    assert.equal((await decide(asked.proposal, { cookie: await signIn("bo", "member") })).status, 403);
    const yes = await decide(asked.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(yes.body.status, "applied", JSON.stringify(yes.body.result));
    const tom = (await cap.worker("tom"))!;
    assert.deepEqual(tom.grants.map((g) => [g.type, g.by]), [["pet-match", "ada"]], "the person who asked holds it now");

    await cap.ensure({ type: "pet-match", workflow: "pets", runId: "r1", path: "pets/review" });
    const lease = (await strut.tasks.worker.next("tom", { type: "pet-match" })) as { lease: string };
    await strut.tasks.worker.submit("tom", { lease: lease.lease, answer: { same: true } });
    const report = (await step("task/report").run({ type: "pet-match" }, ctx())) as { types: Array<{ spentSats: number; limits?: unknown; workers: Array<{ worker: string; answered: number; earnedSats: number }> }> };
    assert.deepEqual([report.types[0]!.spentSats, report.types[0]!.limits], [21, { budgetSats: 100 }]);
    assert.deepEqual(report.types[0]!.workers.map((w) => [w.worker, w.answered, w.earnedSats]), [["tom", 1, 21]]);

    // The staff's own: @me is the admin granting it to themself; the numbers route.
    const me = await strut.app.request("/tasks/workers/%40me/grants/pet-match", { method: "PUT", headers: { "x-strut-ui": "1", cookie: await signIn("ada", "admin") } });
    assert.equal(me.status, 200, await me.clone().text());
    assert.deepEqual(((await me.json()) as { worker: { actor: string } }).worker.actor, "ada");
    const numbers = (await (await strut.app.request("/tasks/numbers?type=pet-match", { headers: auth })).json()) as { types: Array<{ spentSats: number }> };
    assert.equal(numbers.types[0]!.spentSats, 21);
  });

  it("task/types lists what is there: each type with its app, shape, on or off, open or invite-only, pay, its open tasks, how many hold it, its week and its ready tests — never who", async () => {
    assert.deepEqual(await step("task/types").run({}, ctx()), { types: [] });
    const cap = strut.tasks.capability;
    await cap.setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 21 }, "ada");
    await cap.setType("boxes", { app: "workers", answer: BOX, enabled: false }, "ada");
    await cap.grant("w1", "pet-match", "ada");
    await cap.grant("w2", "pet-match", "ada");
    for (const n of [1, 2]) await cap.ensure({ type: "pet-match", workflow: "pets", runId: `r${n}`, path: "pets/review" });
    const lease = (await strut.tasks.worker.next("w1", { type: "pet-match" })) as { lease: string };
    await strut.tasks.worker.submit("w1", { lease: lease.lease, answer: { same: true } });

    const listed = ((await step("task/types").run({}, ctx())) as { types: TaskTypeRow[] }).types;
    const pets = listed.find((t) => t.name === "pet-match")!;
    assert.deepEqual([pets.app, pets.enabled, pets.open, pets.paySats, pets.openTasks, pets.workers, pets.answeredWeek, pets.readyTests], ["workers", true, false, 21, 1, 2, 1, 0]);
    assert.deepEqual(pets.answer, MATCH);
    assert.equal("changedBy" in pets, false, "who saved it is the staff's to read");
    const boxes = listed.find((t) => t.name === "boxes")!;
    assert.deepEqual([boxes.enabled, boxes.open, boxes.openTasks, boxes.workers, boxes.answeredWeek], [false, true, 0, 0, 0]);
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

    // Ruling 12: a new paid type left open with no tests — the card's danger, and the admin's yes saves it.
    const open = (await ask({ name: "pet-match", app: "workers", answer: MATCH, paySats: 10 })) as { proposal: string };
    const openRec = await record(open.proposal);
    assert.equal(openRec.card?.fields.find((f) => f.label === "Who can do it")?.danger, true);
    const opened = await decide(open.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(opened.body.status, "applied");
    assert.deepEqual((await types()).map((t) => [t.name, t.open, t.paySats, t.tests]), [["pet-match", true, 10, undefined]]);
    assert.equal((await strut.app.request("/tasks/types/pet-match", { method: "DELETE", headers: auth })).status, 200);

    const out = (await ask({ name: "pet-match", app: "workers", answer: MATCH, open: false, paySats: 10, rationale: "Low-confidence matches go to a person." })) as { proposal: string; status: string; title: string };
    assert.equal(out.status, "pending");
    assert.equal(out.title, "New task: pet match");
    const rec = await record(out.proposal);
    assert.equal(rec.step, "task/set-type");
    assert.equal(rec.approver, "admin");
    assert.deepEqual(rec.input, { name: "pet-match", app: "workers", answer: MATCH, open: false, paySats: 10 });
    assert.equal(rec.card?.actions.accept, "Approve");
    // No app named workers here: a danger on the card.
    assert.deepEqual(rec.card?.fields.find((f) => f.label === "Task type"), { label: "Task type", value: "pet-match, in the app workers — no app workers on this server", danger: true });
    assert.deepEqual(rec.card?.fields.find((f) => f.label === "Pay"), { label: "Pay", value: "$0.01 (10 sats) for each one, from this server's wallet. Workers can withdraw it at once.", danger: true });

    // A member is refused: their own page's accept (strut's own app, `proposal/decide`), their
    // session at the route, and their person token. Nothing saved, still pending.
    const page = ctx({ app: { name: "strut/jamie", version: "v1", firstParty: true }, workflow: RUN_STEP_FLOW, path: `${RUN_STEP_FLOW}/decide` });
    await assert.rejects(step("proposal/decide").run({ id: out.proposal, action: "accept" }, page), /^Error: admin_required: only an admin of this strut server accepts "New task: pet match" \(task\/set-type\)/);
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
    assert.equal(saved!.open, false);
    // A new invite-only type is its makers' from the start: who asked (ann) and the admin who said yes.
    for (const who of ["ann", "ada"]) {
      const w = await strut.tasks.capability.worker(who);
      assert.deepEqual(w?.grants.filter((g) => g.revokedAt === undefined).map((g) => [g.type, g.qualify]), [["pet-match", 0]], `${who} made it: theirs to try`);
    }
    assert.equal(await strut.tasks.capability.worker("bo"), undefined, "nobody else");
    await assert.rejects(taskTypes().save("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 10 }, { proposal: out.proposal }), /set_type_needs_admin: .*is applied/);
  });

  it("an answer sent as JSON text is proposed and saved as the object; a new type with no answer is saved with the empty one", async () => {
    const out = (await ask({ name: "pet-match", app: "workers", answer: JSON.stringify(MATCH), open: false, tests: '{"qualify":0}' })) as { proposal: string };
    const rec = await record(out.proposal);
    assert.deepEqual(rec.input, { name: "pet-match", app: "workers", answer: MATCH, open: false, tests: { qualify: 0 } });
    const accepted = await decide(out.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(accepted.body.status, "applied", JSON.stringify(accepted.body.result));
    assert.deepEqual((await types())[0]!.answer, MATCH);

    // A new type with no answer: proposed, and saved as a files-only type.
    const files = (await ask({ name: "found-pet", app: "workers", open: false, attachments: { min: 1 } })) as { proposal: string };
    const filed = await decide(files.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(filed.body.status, "applied", JSON.stringify(filed.body.result));
    assert.deepEqual((await types()).find((t) => t.name === "found-pet")!.answer, { type: "object", properties: {} });
  });

  it("a change is merged over the type, the admin's edits merged and checked again; it grants no worker; the card never shows a test's expected answer", async () => {
    const cap = strut.tasks.capability;
    await cap.setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 10, holdHours: 24, withinHours: 48, tests: { qualify: 0 } }, "ada");
    // A test of the type, its expected answer the secret.
    await strut.tasks.tests.create({ type: "pet-match", show: { lost: "a.jpg" }, expected: { same: true, note: SECRET } }, "ada");
    await cap.grant("w1", "pet-match", "ada");
    await cap.ensure({ type: "pet-match", workflow: "pets", runId: "r1", path: "pets/review" });

    const out = (await ask({ name: "pet-match", app: "workers", paySats: 25, tests: { rate: 0.2 } })) as { proposal: string; title: string };
    assert.equal(out.title, "Change task: pet match");
    const rec = await record(out.proposal);
    assert.ok(!JSON.stringify(rec).includes(SECRET), "no expected answer on the record or its card");
    const fields = Object.fromEntries(rec.card!.fields.map((f) => [f.label, f]));
    assert.equal(fields["What changes"]!.value, "pay: $0.01 (10 sats) → $0.03 (25 sats)\ntests: rate 0.05 → 0.2");
    assert.equal(fields["Open tasks"]!.value, "1");
    assert.equal(fields["Workers"]!.value, "1 hold it");
    assert.equal(fields["Pay"]!.danger, true);
    assert.equal(fields["Pay"]!.value, "$0.03 (25 sats) for each one, from this server's wallet. Workers can withdraw it 1 day later. It is $0.01 (10 sats) now. None were done in the last week.");

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

describe("task/set-type in the seeds: whoever builds the workflow asks for its type", () => {
  type Params = { tools: string[]; approve?: string[] };
  const params = (text: string) => (yaml.load(text) as { params: Params }).params;
  const reaches = (grants: string[], type: string) => grants.some((g) => globToRegExp(g).test(type));

  it("the builder and the job grant task/types, task/set-type and task/report and gate task/set-type; the assistant reads and asks for grants, never a type", async () => {
    const builder = params(await builderWorkflowYaml());
    assert.ok(builder.tools.includes("task/types") && builder.tools.includes("task/set-type") && builder.tools.includes("task/report"));
    assert.ok(builder.approve?.includes("task/set-type"), "a proposal: an admin's yes");
    assert.ok(!reaches(builder.tools, "task/next") && !reaches(builder.tools, "task/submit"), "never a worker's steps");
    const orchestrator = params(await orchestratorWorkflowYaml());
    for (const type of ["task/types", "task/report", "task/grant"]) assert.ok(orchestrator.tools.includes(type), `the assistant grants ${type}`);
    assert.ok(orchestrator.approve?.includes("task/grant"), "a grant is an admin's yes");
    assert.ok(!reaches(orchestrator.tools, "task/set-type"), "a type is the builder's");
    // A job builds too (plans/one-job-agent.md §3), so it holds what the
    // builder holds of tasks: the types and the report, never a grant to a
    // worker (a person's) nor a worker's own steps.
    const job = params(await jobWorkflowYaml());
    for (const type of ["task/types", "task/set-type", "task/report"]) assert.ok(job.tools.includes(type), `job grants ${type}`);
    assert.ok(job.approve?.includes("task/set-type"), "a proposal there too");
    for (const type of ["task/grant", "task/next", "task/submit"]) assert.ok(!reaches(job.tools, type), `job does not grant ${type}`);
  });
});
