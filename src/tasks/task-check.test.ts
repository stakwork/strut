import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";
import { CHECK_TIMEOUT_MS, createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type GradeCall, type GradeVerdict, type TaskErrorCode, type TasksService, type WorkerTask } from "./tasks.js";
import { checkRuleOf, RuleProblem } from "./task-tests.js";

/**
 * A type's CHECK before an answer is accepted (plans/human-steps.md §5.6.7,
 * option c): its sealed step runs on each answer and its files inside
 * `submit`, before anything is written. A fail refuses the answer with the
 * step's reason — the task still the worker's, nothing saved, started or
 * earned — and a pass is accepted as before. The step is a stand-in here;
 * `grade/judge` as a check, through a strut, is in
 * src/steps/lib/grade/grade.test.ts.
 */

const T0 = Date.parse("2026-11-19T12:00:00Z");
const TYPE = "page-photo";
const CHECK = "test/check";
const PAGE = { type: "object", properties: { book: { type: "string" } }, required: ["book"] };
const ANSWER = { book: "Cien años de soledad" };
const SHOW = { ask: "Photo of the next page." };
const jpeg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, fill)]);
const file = (name: string, bytes: Buffer) => ({ name, mediaType: "image/jpeg", data: bytes.toString("base64") });
const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

describe("a type's check: the rule (§5.6.7 c)", () => {
  const sealed = (step: string) => (step === CHECK ? undefined : `${step} is not sealed`);
  it("null or absent is none; a sealed step, with a config or without; never equal, never a step that is not sealed", () => {
    assert.equal(checkRuleOf(undefined, sealed), undefined);
    assert.equal(checkRuleOf(null, sealed), undefined);
    assert.deepEqual(checkRuleOf({ step: CHECK }, sealed), { step: CHECK });
    assert.deepEqual(checkRuleOf({ step: CHECK, config: { rubric: "a whole page" } }, sealed), { step: CHECK, config: { rubric: "a whole page" } });
    for (const [bad, code, re] of [
      ["equal", "bad_request", /"equal" needs an expected answer, which a check has none of/],
      ["grade/judge", "bad_request", /^check is \{ step, config\? \}: a sealed step that reads the answer and its files, or null for none$/],
      [{ step: "" }, "bad_request", /^check\.step names a registry step/],
      [{ step: CHECK, config: [] }, "bad_request", /^check\.config is an object/],
      [{ step: CHECK, rubric: "x" }, "bad_request", /^check is \{ step, config\? \}, not rubric/],
      [{ step: "x/open" }, "bad_grader", /^check: x\/open is not sealed/],
    ] as const) {
      assert.throws(() => checkRuleOf(bad, sealed), (e: unknown) => e instanceof RuleProblem && e.code === code && re.test(e.message), JSON.stringify(bad));
    }
  });
});

const IMPLS = ["SQLite", "memory"] as const;

for (const impl of IMPLS) {
  describe(`a type's check before an answer is accepted: ${impl} (§5.6.7 c)`, () => {
    let dir: string;
    let svc: TasksService;
    let ledger: MemoryLedgerStore;
    let calls: GradeCall[];
    let verdict: (call: GradeCall) => Promise<GradeVerdict>;
    let sealedSteps: Set<string>;
    let saves: number;
    const tasks = () => svc.capability;
    const build = () =>
      createTasks({
        open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
        ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
        now: () => T0,
        random: () => 0.5,
        ledger: async () => ledger,
        ledgerIfAny: async () => ledger,
        graderProblem: (step) => (sealedSteps.has(step) ? undefined : `${step} is not sealed`),
        grade: async (call) => {
          calls.push(call);
          return verdict(call);
        },
        saveAttachments: async (t, files) => {
          saves += 1;
          return files.map((f) => ({ name: f.name, mediaType: f.mediaType, size: f.bytes.length, path: `tasks/${t.id}/${f.name}` }));
        },
      });

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-task-check-"));
      ledger = new MemoryLedgerStore();
      calls = [];
      verdict = async () => ({ supports: true, content: "a whole page" });
      sealedSteps = new Set([CHECK]);
      saves = 0;
      svc = build();
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** The type saved by `by` (null: by nobody) with `check`. */
    const typeWith = (check: unknown, more: Record<string, unknown> = {}, by: string | null = "staff") =>
      tasks().setType(TYPE, { app: "workers", answer: PAGE, open: false, paySats: 4, attachments: { max: 1, min: 1, types: ["image/*"] }, ...(check === undefined ? {} : { check: check as never }), ...more }, by ?? undefined);
    let n = 0;
    const made = async () => (await tasks().ensure({ type: TYPE, workflow: "scan", runId: "r1", path: `scan/page#${n++}`, show: SHOW })).task;
    const take = async (actor: string) => {
      const got = await tasks().next(actor, { type: TYPE });
      assert.ok(!("none" in got), `${actor} got nothing`);
      return got as WorkerTask;
    };
    const earned = async (task: string) => (await ledger.payFor([task])).map((e) => e.msat);

    it("saved with the type and read back, kept on file; a whole save without it, or null, turns it off; never equal or a step not sealed", async () => {
      const saved = await typeWith({ step: CHECK, config: { rubric: "One whole page." } });
      assert.deepEqual(saved.check, { step: CHECK, config: { rubric: "One whole page." } });
      if (impl === "SQLite") {
        await svc.close();
        svc = build();
      }
      assert.deepEqual((await tasks().types()).find((t) => t.name === TYPE)!.check, saved.check, "kept on file");
      await assert.rejects(typeWith("equal"), refused("bad_request", /"equal" needs an expected answer/));
      await assert.rejects(typeWith({ step: "x/open" }), refused("bad_grader", /^bad_grader: check: x\/open is not sealed/));
      assert.equal("check" in (await typeWith(undefined)), false, "a whole PUT left without it: none");
      await typeWith({ step: CHECK });
      assert.equal("check" in (await typeWith(null)), false, "null: none");
    });

    it("a fail refuses the answer with the check's reason: the task stays the worker's, and nothing is saved or earned; a pass is accepted and earns", async () => {
      await typeWith({ step: CHECK, config: { rubric: "One whole book page." } });
      await tasks().grant("ann", TYPE);
      const task = await made();
      const got = await take("ann");
      verdict = async () => ({ supports: false, content: "This is a photo of a cup, not a book page." });
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: ANSWER, attachments: [file("cup.jpg", jpeg(1))] }), refused("bad_answer", /^bad_answer: This is a photo of a cup, not a book page\.$/));
      // What the check was handed: the answer, the task's show, its files as
      // base64, no expected answer; billed to the admin who saved the type.
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.deepEqual(
        { step: call.step, config: call.config, input: call.input, principal: call.principal, maxCostUsd: call.maxCostUsd, timeoutMs: call.timeoutMs },
        {
          step: CHECK,
          config: { rubric: "One whole book page." },
          input: { answer: ANSWER, show: SHOW, type: TYPE, files: [{ name: "cup.jpg", mediaType: "image/jpeg", data: jpeg(1).toString("base64") }] },
          principal: "staff",
          maxCostUsd: 0.05,
          timeoutMs: CHECK_TIMEOUT_MS,
        },
      );
      assert.equal("expected" in call.input, false);
      assert.equal(saves, 0, "no file saved");
      assert.deepEqual(await earned(task.id), [], "nothing earned");
      assert.equal((await tasks().task(task.id))!.status, "open");
      assert.equal((await take("ann")).lease, got.lease, "the task is still in ann's hands");

      // She retakes it: the check passes, the answer is accepted and earns.
      verdict = async () => ({ supports: true, content: "one whole page" });
      assert.deepEqual(await tasks().submit("ann", { lease: got.lease, answer: ANSWER, attachments: [file("page.jpg", jpeg(2))] }), { ok: true });
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.input.files![0]!.data, jpeg(2).toString("base64"));
      assert.equal(saves, 1);
      const after = (await tasks().task(task.id))!;
      assert.deepEqual([after.status, after.answer, after.by], ["settled", ANSWER, "ann"]);
      assert.deepEqual(await earned(task.id), [4000]);
    });

    it("a check that cannot run refuses the answer too, asking for it again — past its time, no verdict, no longer sealed — and the next that runs is heard", async () => {
      await typeWith({ step: CHECK });
      await tasks().grant("ann", TYPE);
      const task = await made();
      const got = await take("ann");
      const send = () => tasks().submit("ann", { lease: got.lease, answer: ANSWER, attachments: [file("page.jpg", jpeg(1))] });
      const again = refused("bad_answer", /^bad_answer: this answer could not be checked just now: send it again in a moment$/);
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
      try {
        verdict = async () => {
          throw new Error("timeout: the grader test/check ran past 30 s and was stopped");
        };
        await assert.rejects(send(), again);
        verdict = async () => ({}) as GradeVerdict;
        await assert.rejects(send(), again);
        verdict = async () => ({ supports: true, content: "fine" });
        sealedSteps.delete(CHECK);
        await assert.rejects(send(), again);
        assert.equal(calls.length, 2, "a step no longer sealed is never run");
        assert.equal(warned.length, 1, "logged once until a check runs");
        assert.match(warned[0]!, /task type page-photo's check test\/check could not run, so its answers are refused until it does: timeout/);
        assert.equal(saves, 0);
        assert.deepEqual(await earned(task.id), []);
        assert.equal((await take("ann")).lease, got.lease, "still ann's");

        sealedSteps.add(CHECK);
        assert.deepEqual(await send(), { ok: true });
        assert.deepEqual(await earned(task.id), [4000]);
      } finally {
        console.warn = warn;
      }
    });

    it("who pays is picked, never a reason not to check: the last person who saved the type, kept by a save that names nobody; with nobody ever, none named", async () => {
      await typeWith({ step: CHECK }, {}, "tom");
      await typeWith({ step: CHECK, config: { rubric: "One page." } }, {}, null);
      assert.equal((await tasks().types()).find((t) => t.name === TYPE)!.check?.config?.["rubric"], "One page.", "the save took");
      await tasks().grant("ann", TYPE);
      await made();
      const a = await take("ann");
      assert.deepEqual(await tasks().submit("ann", { lease: a.lease, answer: ANSWER, attachments: [file("p.jpg", jpeg(1))] }), { ok: true });
      assert.equal(calls.at(-1)!.principal, "tom", "a save by nobody kept tom as the payer");

      // A type no person ever saved: checked all the same, nobody named, so
      // the server's own model key pays.
      await tasks().setType("loose-page", { app: "workers", answer: PAGE, open: false, attachments: { max: 1, min: 1, types: ["image/*"] }, check: { step: CHECK } });
      await tasks().grant("ann", "loose-page");
      await tasks().ensure({ type: "loose-page", workflow: "scan", runId: "r2", path: "scan/loose", show: SHOW });
      const b = (await tasks().next("ann", { type: "loose-page" })) as WorkerTask;
      assert.deepEqual(await tasks().submit("ann", { lease: b.lease, answer: ANSWER, attachments: [file("p.jpg", jpeg(2))] }), { ok: true });
      assert.equal("principal" in calls.at(-1)!, false);
    });

    it("a test instance is checked as a task is — a page cannot tell them apart — and a type with no check asks none", async () => {
      await typeWith({ step: CHECK }, { tests: { qualify: 1 } });
      await svc.tests.create({ type: TYPE, show: SHOW, expected: ANSWER }, "staff");
      await tasks().grant("ann", TYPE);
      const got = await take("ann");
      assert.ok((await tasks().list({ test: true }))[0]!.leases.some((l) => l.id === got.lease), "ann holds the test's instance");
      verdict = async () => ({ supports: false, content: "Blurry: hold the phone still." });
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: ANSWER, attachments: [file("p.jpg", jpeg(1))] }), refused("bad_answer", /Blurry/));
      assert.equal(calls.length, 1);

      await typeWith(undefined, { tests: null });
      await tasks().grant("bob", TYPE);
      await made();
      const b = await take("bob");
      assert.deepEqual(await tasks().submit("bob", { lease: b.lease, answer: ANSWER, attachments: [file("p.jpg", jpeg(1))] }), { ok: true });
      assert.equal(calls.length, 1, "no check, no call");
    });
  });
}
