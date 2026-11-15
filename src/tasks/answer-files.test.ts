import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileArtifactsCapability, type ArtifactsCapability } from "../capabilities.js";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type TaskErrorCode, type TasksService, type WorkerTask } from "./tasks.js";
import { answerAttachments, attachmentRuleOf, saveAnswerAttachments, takesType } from "./answer-files.js";
import { RuleProblem } from "./task-tests.js";

/**
 * Files from a worker (plans/human-steps.md §5.6, item 8): the type's rule,
 * an answer's files checked, where they are saved; then one suite over the
 * SQLite file and the memory twin through the service — the files recorded
 * with the answer, copies kept apart, a test instance's dropped, staff
 * reading them. The door end to end (a worker's photo through `/public/mcp`
 * reaching an agent's prompt) is in worker-door.test.ts.
 */

const T0 = Date.parse("2026-11-15T12:00:00Z");
const TYPE = "court-paper";
const PAGES = { type: "object", properties: { pages: { type: "integer", minimum: 1 } }, required: ["pages"] };
const ONE = { pages: 1 };
const jpeg = (fill: number, n = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, fill)]);
const file = (name: string, bytes: Buffer, mediaType?: string) => ({ name, ...(mediaType ? { mediaType } : {}), data: bytes.toString("base64") });
const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

describe("files from a worker: the pure parts (§5.6)", () => {
  it("a type's rule: the defaults under what staff set, each field bounded; null or absent takes none", () => {
    assert.equal(attachmentRuleOf(undefined), undefined);
    assert.equal(attachmentRuleOf(null), undefined);
    assert.deepEqual(attachmentRuleOf({}), { max: 1, min: 0, types: ["image/*", "application/pdf"] });
    assert.deepEqual(attachmentRuleOf({ max: 4, min: 1, types: [" Image/JPEG ", "image/*", "image/*"] }), { max: 4, min: 1, types: ["image/jpeg", "image/*"] });
    for (const [bad, re] of [
      [[], /attachments is \{ max, min, types \}/],
      [{ max: 0 }, /attachments\.max is a whole number from 1 to 10/],
      [{ max: 11 }, /attachments\.max/],
      [{ max: 1.5 }, /attachments\.max/],
      [{ min: 2 }, /attachments\.min is a whole number from 0 to attachments\.max \(1\)/],
      [{ types: [] }, /attachments\.types is a list of 1 to 20/],
      [{ types: ["photos"] }, /"photos" is not a media type/],
      [{ types: ["*/*"] }, /not a media type/],
      [{ size: 1 }, /attachments\.size is not an attachments rule/],
    ] as const) {
      assert.throws(() => attachmentRuleOf(bad), (e: unknown) => e instanceof RuleProblem && e.code === "bad_request" && re.test(e.message), JSON.stringify(bad));
    }
    assert.equal(takesType(["image/*"], "image/png"), true);
    assert.equal(takesType(["image/*"], "imagex/png"), false);
    assert.equal(takesType(["application/pdf"], "application/pdf"), true);
  });

  it("an answer's files: the chat's parser and caps, then the type's rule", () => {
    const rule = attachmentRuleOf({ max: 2, min: 1, types: ["image/*"] });
    assert.deepEqual(answerAttachments(TYPE, undefined, undefined), [], "no rule, no files: as before");
    assert.deepEqual(answerAttachments(TYPE, undefined, []), []);
    assert.throws(() => answerAttachments(TYPE, undefined, [file("a.jpg", jpeg(1))]), /task type court-paper takes no files with an answer/);
    assert.throws(() => answerAttachments(TYPE, rule, undefined), /needs a file with each answer/);
    assert.throws(() => answerAttachments(TYPE, rule, [file("a.jpg", jpeg(1)), file("b.jpg", jpeg(2)), file("c.jpg", jpeg(3))]), /takes at most 2 files with an answer; this one has 3/);
    assert.throws(() => answerAttachments(TYPE, rule, [file("f.pdf", Buffer.from("%PDF"), "application/pdf")]), /takes image\/\*; f\.pdf is application\/pdf/);
    assert.throws(() => answerAttachments(TYPE, rule, [file("big.png", Buffer.alloc(5 * 1024 * 1024 + 1))]), /big\.png is 5\.0 MB; the limit is 5\.0 MB/);
    assert.throws(() => answerAttachments(TYPE, rule, "a photo"), /attachments must be an array/);
    const [a] = answerAttachments(TYPE, rule, [{ name: "p.jpg", data: `data:image/jpeg;base64,${jpeg(9).toString("base64")}` }]);
    assert.deepEqual([a!.name, a!.mediaType, Buffer.compare(a!.bytes, jpeg(9))], ["p.jpg", "image/jpeg", 0]);
  });

  it("saved in the run's artifacts under tasks/<task id>/: a name there numbered, never overwritten, two saves at once kept apart", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-answer-files-"));
    try {
      const artifacts = fileArtifactsCapability(root);
      const one = (fill: number) => ({ name: "page.jpg", mediaType: "image/jpeg", bytes: jpeg(fill) });
      const [a, b] = await Promise.all([saveAnswerAttachments(artifacts, "r1", "t1", [one(1)]), saveAnswerAttachments(artifacts, "r1", "t1", [one(2), { ...one(3), name: "../../evil.jpg" }])]);
      assert.deepEqual(a, [{ name: "page.jpg", mediaType: "image/jpeg", size: 64, path: "tasks/t1/page.jpg" }]);
      assert.deepEqual(b, [
        { name: "page.jpg", mediaType: "image/jpeg", size: 64, path: "tasks/t1/page-2.jpg" },
        { name: "../../evil.jpg", mediaType: "image/jpeg", size: 64, path: "tasks/t1/evil.jpg" },
      ]);
      assert.deepEqual(Buffer.from(await artifacts.read("r1", "tasks/t1/page.jpg")), jpeg(1));
      assert.deepEqual(Buffer.from(await artifacts.read("r1", "tasks/t1/page-2.jpg")), jpeg(2));
      // Another task's folder is its own.
      assert.equal((await saveAnswerAttachments(artifacts, "r1", "t2", [one(4)]))[0]!.path, "tasks/t2/page.jpg");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const IMPLS = ["SQLite", "memory"] as const;

for (const impl of IMPLS) {
  describe(`files from a worker: ${impl} (§5.6)`, () => {
    let dir: string;
    let svc: TasksService;
    let artifacts: ArtifactsCapability;
    let saves: number;
    const tasks = () => svc.capability;
    const build = () =>
      createTasks({
        open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
        ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
        now: () => T0,
        // As createStrut's: an answer's files in its task's run's artifacts.
        saveAttachments: (t, files) => {
          saves += 1;
          return saveAnswerAttachments(artifacts, t.runId, t.id, files);
        },
        file: async (t, path) => {
          if (t.root !== "run") return null;
          const bytes = await artifacts.read(t.runId, path).catch(() => null);
          return bytes ? { path, mediaType: "image/jpeg", bytes: bytes.byteLength, base64: Buffer.from(bytes).toString("base64") } : null;
        },
      });

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-answer-files-"));
      artifacts = fileArtifactsCapability(join(dir, "artifacts"));
      saves = 0;
      svc = build();
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    const typeWith = (attachments: Record<string, unknown> | null, more: Record<string, unknown> = {}) =>
      tasks().setType(TYPE, { app: "workers", answer: PAGES, open: false, ...(attachments ? { attachments } : {}), ...more }, "staff");
    let n = 0;
    const made = async (copies = 1) => (await tasks().ensure({ type: TYPE, workflow: "papers", runId: "r1", path: `papers/photo#${n++}`, ...(copies > 1 ? { copies } : {}) })).task;
    const take = async (actor: string) => {
      const got = await tasks().next(actor, { type: TYPE });
      assert.ok(!("none" in got), `${actor} got nothing`);
      return got as WorkerTask;
    };

    it("the files are saved with the answer: the type's rule on the task, the lease's record, the step's output, kept on file", async () => {
      const saved = await typeWith({ max: 2, min: 1, types: ["image/*"] });
      assert.deepEqual(saved.attachments, { max: 2, min: 1, types: ["image/*"] });
      assert.deepEqual((await tasks().types()).find((t) => t.name === TYPE)!.attachments, saved.attachments);
      await tasks().grant("ann", TYPE);
      const task = await made();
      const got = await take("ann");
      assert.deepEqual(got.attachments, { max: 2, min: 1, types: ["image/*"] }, "the page learns what to send");
      // Refused before anything is written: the task stays ann's.
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: ONE }), refused("bad_answer", /needs a file/));
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: { pages: 0 }, attachments: [file("p.jpg", jpeg(1))] }), refused("bad_answer", /pages/));
      assert.equal(saves, 0, "a bad answer writes no file");
      assert.deepEqual(await tasks().submit("ann", { lease: got.lease, answer: ONE, attachments: [file("p 1.jpg", jpeg(1)), file("p 2.jpg", jpeg(2))] }), { ok: true });
      const want = [
        { name: "p 1.jpg", mediaType: "image/jpeg", size: 64, path: `tasks/${task.id}/p 1.jpg` },
        { name: "p 2.jpg", mediaType: "image/jpeg", size: 64, path: `tasks/${task.id}/p 2.jpg` },
      ];
      const settled = await tasks().ensure({ type: TYPE, workflow: "papers", runId: "r1", path: `papers/photo#${n - 1}` });
      assert.deepEqual([settled.task.status, settled.task.answer, settled.attachments], ["settled", ONE, want]);
      assert.deepEqual((await tasks().task(task.id))!.leases[0]!.attachments, want, "staff read them on the lease");
      assert.deepEqual(Buffer.from(await artifacts.read("r1", want[1]!.path)), jpeg(2));
      // Staff read an answer's file without a lease; a path on no list is refused.
      assert.equal((await tasks().taskFile(task.id, want[0]!.path)).base64, jpeg(1).toString("base64"));
      await assert.rejects(tasks().taskFile(task.id, `tasks/${task.id}/other.jpg`), refused("not_listed"));
      if (impl === "SQLite") {
        await svc.close();
        svc = build();
        assert.deepEqual((await tasks().task(task.id))!.leases[0]!.attachments, want, "kept on file");
      }
    });

    it("a type that takes no files refuses any, and its answers carry none", async () => {
      await typeWith(null);
      await tasks().grant("ann", TYPE);
      const task = await made();
      const got = await take("ann");
      assert.equal("attachments" in got, false);
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: ONE, attachments: [file("p.jpg", jpeg(1))] }), refused("bad_answer", /takes no files/));
      assert.deepEqual(await tasks().submit("ann", { lease: got.lease, answer: ONE }), { ok: true });
      const settled = await tasks().ensure({ type: TYPE, workflow: "papers", runId: "r1", path: `papers/photo#${n - 1}` });
      assert.equal(settled.task.id, task.id);
      assert.equal("attachments" in settled, false);
      assert.equal(saves, 0);
    });

    it("copies: each answer's files are its own, a repeated name numbered; the output's are the agreed answer's", async () => {
      await typeWith({ max: 1, min: 1 }, { copies: { max: 2, agree: 2 } });
      for (const w of ["ann", "bob"]) await tasks().grant(w, TYPE);
      const task = await made(2);
      const a = await take("ann");
      const b = await take("bob");
      await tasks().submit("ann", { lease: a.lease, answer: ONE, attachments: [file("page.jpg", jpeg(1))] });
      await tasks().submit("bob", { lease: b.lease, answer: ONE, attachments: [file("page.jpg", jpeg(2))] });
      const settled = await tasks().ensure({ type: TYPE, workflow: "papers", runId: "r1", path: `papers/photo#${n - 1}` });
      const ann = [{ name: "page.jpg", mediaType: "image/jpeg", size: 64, path: `tasks/${task.id}/page.jpg` }];
      const bob = [{ name: "page.jpg", mediaType: "image/jpeg", size: 64, path: `tasks/${task.id}/page-2.jpg` }];
      assert.equal(settled.task.status, "settled");
      assert.deepEqual(settled.answers, [
        { answer: ONE, by: "ann", agrees: true, attachments: ann },
        { answer: ONE, by: "bob", agrees: true, attachments: bob },
      ]);
      assert.deepEqual(settled.attachments, ann, "the agreed answer's: its first giver's");
      assert.deepEqual(Buffer.from(await artifacts.read("r1", bob[0]!.path)), jpeg(2));
    });

    it("a test instance takes files as a task does — a page cannot tell — and drops them: no run, nothing saved", async () => {
      await typeWith({ max: 1, min: 1 }, { tests: { qualify: 1 } });
      await svc.tests.create({ type: TYPE, show: { court: "x" }, expected: ONE }, "staff");
      await tasks().grant("ann", TYPE);
      const got = await take("ann");
      const instance = (await tasks().list({ test: true }))[0]!;
      assert.ok(instance.leases.some((l) => l.id === got.lease), "ann holds the test's instance");
      assert.deepEqual(got.attachments, { max: 1, min: 1, types: ["image/*", "application/pdf"] });
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: ONE }), refused("bad_answer", /needs a file/), "checked alike");
      assert.deepEqual(await tasks().submit("ann", { lease: got.lease, answer: ONE, attachments: [file("p.jpg", jpeg(1))] }), { ok: true });
      assert.equal(saves, 0, "nothing saved");
      assert.equal((await tasks().task(instance.id))!.leases[0]!.attachments, undefined);
    });
  });
}
