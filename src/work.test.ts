/**
 * A WORK's pure and file-backed parts (src/work.ts): what caused a run, a
 * work's runs and its root read back from the record, when it is done, the
 * work as a judge reads it, and the one read its files allow.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunSummary } from "./core.js";
import { MemoryRunStore } from "./store.js";
import { wakeFilePath } from "./wake.js";
import { causesOf, foldWork, membersOf, recordCaused, renderWork, rootsOf, workCapability, workDone, type Work, type WorkMember } from "./work.js";

const at = (n: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, n)).toISOString();
const startOf = (runId: string, extra: Partial<RunEvent> = {}, n = 0): RunEvent => ({ ts: at(n), runId, path: "x", type: "run.start", input: { prompt: runId }, ...extra });
const summary = (runId: string, workflow: string, status: RunSummary["status"] = "success", output: unknown = { text: `${runId} done` }): RunSummary => ({
  runId, workflow, startedAt: at(0), finishedAt: at(1), durationMs: 1000, status, input: {}, ...(status === "success" ? { output } : {}),
});

describe("what caused a run", () => {
  it("its parent, the turn that started it, the job runs it woke on — never another strut's", () => {
    assert.deepEqual(causesOf({}), []);
    assert.deepEqual(causesOf({ parentRunId: "p" }), ["p"]);
    assert.deepEqual(causesOf({ startedBy: { workflow: "orchestrator", runId: "t", session: "c" } }), ["t"]);
    assert.deepEqual(causesOf({ wake: { job: "j", runId: "j1", also: [{ job: "k", runId: "k1" }, { job: "x", runId: "x1", peer: "acme" }] } }), ["j1", "k1"]);
    assert.deepEqual(causesOf({ wake: { job: "j", runId: "j1", peer: "acme" } }), []);
  });
});

describe("a work read back from the record", () => {
  let dir = "";
  before(async () => (dir = await mkdtemp(join(tmpdir(), "strut-work-"))));
  after(() => rm(dir, { recursive: true, force: true }));

  it("down from its root through the causes, up from any run to its root; a child's end asks nothing; a wake on two works' jobs is in both", async () => {
    const store = new MemoryRunStore();
    const runs: Array<[string, string, Partial<RunEvent>]> = [
      ["orchestrator", "t1", {}],
      ["job", "j1", { startedBy: { workflow: "orchestrator", runId: "t1", session: "c-1" }, job: "a" }],
      ["builder", "b1", { parentRunId: "j1" }],
      ["orchestrator", "t2", {}],
      ["job", "j2", { startedBy: { workflow: "orchestrator", runId: "t2", session: "c-1" }, job: "b" }],
      ["orchestrator", "w1", { wake: { job: "a", runId: "j1", also: [{ job: "b", runId: "j2" }] } }],
      ["job", "j3", { startedBy: { workflow: "orchestrator", runId: "w1", session: "c-1" }, job: "c" }],
    ];
    for (const [i, [workflow, runId, extra]] of runs.entries()) {
      const start = startOf(runId, extra, i);
      await store.append(workflow, runId, start);
      await recordCaused(dir, workflow, start);
    }
    assert.deepEqual((await membersOf(dir, { workflow: "orchestrator", runId: "t1" })).map((r) => r.runId), ["t1", "j1", "b1", "w1", "j3"]);
    assert.deepEqual((await membersOf(dir, { workflow: "orchestrator", runId: "t2" })).map((r) => r.runId), ["t2", "j2", "w1", "j3"]);
    assert.deepEqual(await rootsOf(store, { workflow: "job", runId: "j3" }), [{ workflow: "orchestrator", runId: "t1" }, { workflow: "orchestrator", runId: "t2" }]);
    assert.deepEqual(await rootsOf(store, { workflow: "orchestrator", runId: "t1" }), [{ workflow: "orchestrator", runId: "t1" }]);
    assert.equal(await rootsOf(store, { workflow: "builder", runId: "b1" }), null, "a child: its parent's end decides");
    assert.deepEqual(await rootsOf(store, { workflow: "orchestrator", runId: "gone" }), [{ workflow: "orchestrator", runId: "gone" }], "nothing on file: its own root");
  });

  it("done: every run that is no child ended, none still here in flight, no wake on its way for a job in it", async () => {
    const store = new MemoryRunStore();
    const d = await mkdtemp(join(tmpdir(), "strut-work-done-"));
    const add = async (workflow: string, runId: string, extra: Partial<RunEvent> = {}, status?: RunSummary["status"]) => {
      await store.append(workflow, runId, startOf(runId, extra));
      if (status) await store.finalize(workflow, runId, summary(runId, workflow, status));
    };
    await add("orchestrator", "t", {}, "success");
    await add("job", "j", { startedBy: { workflow: "orchestrator", runId: "t", session: "c-1" } }, "success");
    await add("builder", "child", { parentRunId: "j" });
    const members = [
      { workflow: "orchestrator", runId: "t" },
      { workflow: "job", runId: "j" },
      { workflow: "builder", runId: "child" },
    ];
    const deps = { store, dataDir: d };
    assert.deepEqual(await workDone(deps, members), { done: true }, "a child cut off is its parent's: not asked");
    assert.deepEqual(await workDone({ ...deps, isLive: (_w, id) => id === "j" }, members), { done: false, why: "job j is running" });
    assert.deepEqual(await workDone({ ...deps, isLive: (_w, id) => id === "j" }, members, { workflow: "job", runId: "j" }), { done: true }, "the run whose end asks is over");

    // The job's end is queued to wake its conversation: not done until that turn ends.
    const file = wakeFilePath(d, "c-1");
    await mkdir(join(d, "wakes"), { recursive: true });
    const end = { runId: "j", workflow: "job", job: "a", status: "success", artifacts: [] };
    await writeFile(file, JSON.stringify({ session: "c-1", queued: [end], seen: ["j"] }));
    assert.deepEqual(await workDone(deps, members), { done: false, why: "a wake is on its way for job j" });
    await writeFile(file, JSON.stringify({ session: "c-1", queued: [], turn: { workflow: "orchestrator", runId: "w", ends: [end] }, seen: ["j"] }));
    assert.equal((await workDone(deps, members)).done, false, "the wake turn launched and not ended");
    await add("orchestrator", "w", {}, "success");
    assert.deepEqual(await workDone(deps, members), { done: true }, "the wake turn ended: it answers for itself");

    await add("job", "parked", {}, "waiting");
    assert.deepEqual(await workDone(deps, [...members, { workflow: "job", runId: "parked" }]), { done: false, why: "job parked is waiting" });
    await rm(d, { recursive: true, force: true });
  });
});

describe("the work as a judge reads it", () => {
  const member = (workflow: string, runId: string, extra: Partial<RunEvent>, concepts: string[], n: number, o: Partial<WorkMember> = {}): WorkMember => ({
    ref: { workflow, runId },
    start: startOf(runId, extra, n),
    summary: summary(runId, workflow),
    concepts,
    ...o,
  });

  it("each run in the order it started, how it came about, the pages it opened, its folder and what it delivered", () => {
    const work = foldWork({ workflow: "orchestrator", runId: "t" }, [
      member("orchestrator", "w", { wake: { job: "a/1", runId: "j" } }, ["Job"], 3),
      member("orchestrator", "t", {}, ["Job", "Workflow Builder"], 1),
      member("job", "j", { startedBy: { workflow: "orchestrator", runId: "t" }, job: "a/1" }, ["Planning"], 2, {
        dir: "/data/jobs/a%2F1",
        summary: summary("j", "job", "success", { text: "Wrote it.", artifacts: [{ id: "plan", title: "The plan", path: "plan.md" }, { id: "x", title: "Theirs", peer: "acme" }] }),
      }),
    ]);
    assert.deepEqual(work.runs.map((r) => [r.n, r.runId, r.cause, r.files]), [
      [1, "t", undefined, undefined],
      [2, "j", { kind: "job", of: [1] }, "job-a_1"],
      [3, "w", { kind: "wake", of: [2] }, undefined],
    ]);
    assert.deepEqual(work.concepts, ["Job", "Workflow Builder", "Planning"]);
    assert.deepEqual(work.files, { "job-a_1": "/data/jobs/a%2F1" });
    const text = renderWork(work, 24_000);
    assert.match(text, /^THE WORK: 3 runs, everything the request in RUN 1 set off/);
    assert.match(text, /── RUN 2: job, a job RUN 1 started \(job a\/1\); it succeeded\nWHAT IT WAS ASKED:/);
    assert.match(text, /── RUN 3: orchestrator, a turn reporting on RUN 2; it succeeded/);
    assert.match(text, /ITS FILES: job-a_1\/ — it delivered: "The plan" at job-a_1\/plan\.md; "Theirs" \(on @acme, not readable here\)/);
    assert.match(text, /CONCEPT PAGES OPENED IN THE WORK: Job, Workflow Builder, Planning\n\nFOLDERS OF FILES THE WORK MADE: job-a_1\/$/);
  });

  it("a work of one run reads as one run always did", () => {
    const work = foldWork({ workflow: "orchestrator", runId: "t" }, [member("orchestrator", "t", {}, ["Job"], 1)]);
    assert.equal(renderWork(work, 12_000), 'WHAT IT WAS ASKED:\n{\n  "prompt": "t"\n}\n\nWHAT IT RETURNED:\n{\n  "text": "t done"\n}\n\nCONCEPT PAGES IT OPENED: Job');
  });
});

describe("the work's files: read only, and only its own", () => {
  let dir = "";
  let work: Work;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-work-files-"));
    await mkdir(join(dir, "job", "sub"), { recursive: true });
    await writeFile(join(dir, "job", "plan.md"), "x".repeat(40_000) + "END");
    await writeFile(join(dir, "job", "sub", "notes.txt"), "notes");
    await writeFile(join(dir, "job", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, "job", "blob.bin"), Buffer.from([1, 0, 2, 0]));
    await writeFile(join(dir, "secret.txt"), "not the work's");
    await symlink(join(dir, "secret.txt"), join(dir, "job", "leak.txt"));
    work = { root: { workflow: "w", runId: "1" }, runs: [], concepts: [], files: { "job-a": join(dir, "job") } };
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("folders and files of the work's folders, text in pieces, images shown, anything else named", async () => {
    const w = workCapability(work);
    assert.deepEqual(await w.read(""), { path: "", kind: "folder", entries: ["job-a/"] });
    assert.deepEqual(await w.read("job-a"), { path: "job-a", kind: "folder", entries: ["blob.bin", "leak.txt", "plan.md", "shot.png", "sub/"] });
    const first = await w.read("job-a/plan.md");
    assert.equal(first.kind, "text");
    assert.deepEqual(first.kind === "text" && [first.text.length, first.from, first.next, first.size], [30_000, 0, 30_000, 40_003]);
    const rest = await w.read("/job-a/plan.md", 30_000);
    assert.ok(rest.kind === "text" && rest.text.endsWith("END") && rest.next === undefined);
    assert.equal((await w.read("job-a/sub/notes.txt")).kind, "text");
    const shot = await w.read("job-a/shot.png");
    assert.deepEqual(shot.kind === "image" && [shot.mediaType, shot.size], ["image/png", 4]);
    assert.deepEqual(await w.read("job-a/blob.bin"), { path: "job-a/blob.bin", kind: "other", size: 4, note: "not text" });
  });

  it("refuses anything outside them: another folder, a path that climbs out, a link that leads out", async () => {
    const w = workCapability(work);
    await assert.rejects(w.read("elsewhere/x"), /"elsewhere" is not a folder of this work's files: job-a\//);
    await assert.rejects(w.read("job-a/../secret.txt"), /outside the work's files/);
    await assert.rejects(w.read("job-a/leak.txt"), /leads outside the work's files/);
    await assert.rejects(w.read("job-a/nope.md"), /no file or folder "job-a\/nope.md"/);
    assert.ok(Object.isFrozen(w));
  });
});
