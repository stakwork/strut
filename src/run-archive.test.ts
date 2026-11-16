import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { defineStep, type RunEvent, type RunSummary, type StepRegistry } from "./core.js";
import { createStrut } from "./createStrut.js";
import { hiddenFromSteps } from "./env.js";
import { MemoryObjectStore, type ObjectStore } from "./object-store.js";
import { ARCHIVE_LOCAL_WINDOW, createRetention, parseRetention } from "./retention.js";
import { RunArchiveError, archiveFromEnv, checkArchive, type RunArchive } from "./run-archive.js";
import { FileRunStore, localRuns } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const summary = (runId: string, ageHours: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  runId, workflow: "w", startedAt: at(ageHours), finishedAt: at(ageHours), durationMs: 1, status: "success", input: {}, ...extra,
});

const event = (runId: string, type: string, extra: Record<string, unknown> = {}): RunEvent => ({ type, ts: at(1), runId, path: "w", ...extra }) as RunEvent;

/** A finished run: three events and its summary. */
async function seed(store: FileRunStore, id: string, s: RunSummary = summary(id, 5)) {
  await store.append("w", id, event(id, "run.start", { input: { n: id } }));
  await store.append("w", id, event(id, "step.end", { path: "w/a", output: `the output of run ${id}` }));
  await store.append("w", id, event(id, "run.end"));
  await store.finalize("w", id, s);
}

interface World {
  root: string;
  store: FileRunStore;
  objects: MemoryObjectStore;
  archive: RunArchive;
  /** The object store's calls, in order: `put <key>`, `get <key>`, … */
  calls: string[];
  runDir(id: string): string;
  /** The run's log as the bucket holds it. */
  archived(id: string): string | undefined;
}

/** A file run store with an archive in memory. `faults` replaces calls of the object store. */
async function world(faults: Partial<ObjectStore> = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "strut-archive-"));
  const objects = new MemoryObjectStore();
  const calls: string[] = [];
  const counted: ObjectStore = {
    put: (key, body) => (calls.push(`put ${key}`), (faults.put ?? objects.put.bind(objects))(key, body)),
    get: (key) => (calls.push(`get ${key}`), (faults.get ?? objects.get.bind(objects))(key)),
    head: (key) => (calls.push(`head ${key}`), (faults.head ?? objects.head.bind(objects))(key)),
    delete: (key) => (calls.push(`delete ${key}`), (faults.delete ?? objects.delete.bind(objects))(key)),
  };
  const archive: RunArchive = { objects: counted, prefix: "box-1", label: "s3://test/box-1" };
  const store = new FileRunStore(root);
  store.useArchive(archive);
  return {
    root, store, objects, archive, calls,
    runDir: (id) => join(root, "workflows", "w", "runs", id),
    archived: (id) => {
      const object = objects.objects.get(`box-1/runs/w/${id}/events.jsonl.gz`);
      return object && gunzipSync(object).toString();
    },
  };
}

function sweeper(w: World, retain: unknown, opts: { now?: () => number; bytesPerSweep?: number; isLive?: (wf: string, id: string) => boolean } = {}) {
  return createRetention({
    store: w.store,
    workspace: { listWorkflows: async () => [{ name: "w" }], getWorkflow: async () => (retain === undefined ? {} : { retain: parseRetention(retain) as never }) },
    fallback: ARCHIVE_LOCAL_WINDOW,
    archive: { check: () => checkArchive(w.archive), ...(opts.bytesPerSweep !== undefined ? { bytesPerSweep: opts.bytesPerSweep } : {}) },
    ...(opts.isLive ? { isLive: opts.isLive } : {}),
    now: opts.now ?? (() => NOW),
  });
}

/** Run `fn` with the console quiet; resolves to what it logged and warned. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; warnings: string[] }> {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = await fn();
    return { result, logs: log.mock.calls.map((c) => String(c.arguments[0])), warnings: warn.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    log.mock.restore();
    warn.mock.restore();
  }
}

const logOf = (w: World, id: string) => readFile(join(w.runDir(id), "events.jsonl"), "utf-8");
const hasLog = (w: World, id: string) => stat(join(w.runDir(id), "events.jsonl")).then(() => true, () => false);
const puts = (w: World) => w.calls.filter((c) => c.startsWith("put ") && c.includes("/runs/"));

/** Upload and evict one run, as a sweep would. */
async function evict(w: World, id: string) {
  assert.ok(await w.store.archiveRun("w", id, at(0)), `run ${id} archived`);
  assert.equal(await w.store.evictRun("w", id, at(0)), true, `run ${id} evicted`);
}

describe("the run archive: upload, then evict", () => {
  it("uploads every finished run's log, evicts the ones past the window, and records both on the summary", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 5));
    await seed(w.store, "3", summary("3", 0.5));
    await w.store.append("w", "5", event("5", "run.start")); // in flight: no summary
    const log1 = await logOf(w, "1");
    const sweep = sweeper(w, "1h");
    const first = await quiet(() => sweep.sweep());
    assert.equal(first.result, 1);
    assert.deepEqual(first.logs, [`[archive] archived 2 run log(s), ${2 * Buffer.byteLength(log1)} bytes`, "[retention] evicted 1 run log(s): w 1"]);
    assert.deepEqual(first.warnings, []);

    // The bucket: the probe, and one gzipped log per finished run.
    assert.deepEqual([...w.objects.objects.keys()].sort(), ["box-1/archive.json", "box-1/runs/w/1/events.jsonl.gz", "box-1/runs/w/3/events.jsonl.gz"]);
    assert.equal(w.archived("1"), log1);
    assert.equal(w.archived("3"), await logOf(w, "3"));

    // Run 1: gone from this disk, in the bucket, and its summary says where.
    assert.deepEqual(await readdir(w.runDir("1")), ["run.json"]);
    const s1 = (await w.store.getRunSummary("w", "1"))!;
    assert.equal(s1.logEvicted, true);
    assert.deepEqual(s1.archive, { key: "box-1/runs/w/1/events.jsonl.gz", bytes: Buffer.byteLength(log1), size: w.objects.objects.get(s1.archive!.key)!.length, at: at(0) });
    // Run 3: uploaded, and still here.
    const s3 = (await w.store.getRunSummary("w", "3"))!;
    assert.equal(s3.logEvicted, undefined);
    assert.equal(s3.archive?.bytes, Buffer.byteLength(await logOf(w, "3")));
    // Run 5 is live: untouched.
    assert.equal(await w.store.getRunSummary("w", "5"), null);

    // Nothing left to do: the next sweep uploads nothing and says nothing.
    const second = await quiet(() => sweep.sweep());
    assert.equal(second.result, 0);
    assert.deepEqual([second.logs, second.warnings], [[], []]);
    assert.equal(puts(w).length, 2);
  });

  it("uploads the event log alone: the files that hold credentials never leave", async () => {
    const w = await world();
    await seed(w.store, "1");
    await w.store.setRunCallback("w", "1", "https://host.example/callback?token=CALLBACK-SECRET");
    await w.store.setRunMcp("w", "1", [{ name: "m", url: "https://mcp.example", headers: { authorization: "Bearer MCP-SECRET" } } as never]);
    await w.store.setRunJobCallback("w", "1", "https://host.example/job?token=JOB-SECRET");
    assert.deepEqual((await readdir(w.runDir("1"))).sort(), ["callback.json", "events.jsonl", "job-callback.json", "mcp.json", "run.json"]);
    await quiet(() => sweeper(w, "1h").sweep());
    assert.deepEqual(await readdir(w.runDir("1")), ["run.json"]);
    assert.deepEqual(puts(w), ["put box-1/runs/w/1/events.jsonl.gz"]);
    for (const [key, object] of w.objects.objects) {
      const text = key.endsWith(".gz") ? gunzipSync(object).toString() : object.toString();
      assert.doesNotMatch(text, /SECRET|callback|mcp\.example/, key);
    }
    // And they are not restored: a restore brings back the log only.
    await quiet(() => w.store.getRunEvents("w", "1"));
    assert.deepEqual((await readdir(w.runDir("1"))).sort(), ["events.jsonl", "run.json"]);
  });

  it("a kept or referenced run is uploaded and stays on this disk", async () => {
    const w = await world();
    await seed(w.store, "2", summary("2", 5, { kept: true } as never));
    await seed(w.store, "3", summary("3", 5));
    await seed(w.store, "4", summary("4", 0.1, { output: { url: "/artifacts/3/out.txt" } }));
    assert.equal((await quiet(() => sweeper(w, "1h").sweep())).result, 0);
    for (const id of ["2", "3", "4"]) {
      assert.ok(await hasLog(w, id), id);
      assert.equal(w.archived(id), await logOf(w, id), id);
    }
  });

  it("a workflow with no policy keeps its logs here for the archive's window (7 days)", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 8 * 24));
    await seed(w.store, "2", summary("2", 6 * 24));
    assert.equal((await quiet(() => sweeper(w, undefined).sweep())).result, 1);
    assert.equal((await w.store.getRunSummary("w", "1"))?.logEvicted, true);
    assert.ok(await hasLog(w, "2"));
  });

  it("a run that died with its process is uploaded before its log goes", async () => {
    const w = await world();
    await w.store.append("w", "7", event("7", "run.start", { ts: at(4), parentRunId: "6" }));
    await w.store.append("w", "7", event("7", "step.start", { ts: at(3) }));
    const log = await logOf(w, "7");
    await utimes(join(w.runDir("7"), "events.jsonl"), new Date(NOW - 3 * HOUR), new Date(NOW - 3 * HOUR));
    assert.equal((await quiet(() => sweeper(w, "1h").sweep())).result, 1);
    const s = (await w.store.getRunSummary("w", "7"))!;
    assert.deepEqual([s.crashed, s.logEvicted, s.status, s.parentRunId, s.archive?.bytes], [true, true, "error", "6", Buffer.byteLength(log)]);
    assert.equal(w.archived("7"), log);
    assert.deepEqual(await readdir(w.runDir("7")), ["run.json"]);
    assert.equal((await quiet(() => w.store.getRunEvents("w", "7"))).result.length, 2);
  });

  it("a dead run resumed while its log was uploaded is left alone", async () => {
    const w = await world();
    await w.store.append("w", "7", event("7", "run.start"));
    await utimes(join(w.runDir("7"), "events.jsonl"), new Date(NOW - 3 * HOUR), new Date(NOW - 3 * HOUR));
    let live = false;
    const real = w.archive.objects.put;
    w.archive.objects.put = async (key, body) => {
      await real(key, body);
      if (key.includes("/runs/")) live = true; // resumed by hand during the upload
    };
    assert.equal((await quiet(() => sweeper(w, "1h", { isLive: () => live }).sweep())).result, 0);
    assert.equal(await w.store.getRunSummary("w", "7"), null);
    assert.ok(await hasLog(w, "7"));
  });

  it("one sweep uploads a bounded amount, the logs due for eviction first; a backlog drains over sweeps", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 9));
    await seed(w.store, "2", summary("2", 8));
    await seed(w.store, "3", summary("3", 7));
    await seed(w.store, "4", summary("4", 0.1)); // not due: after the others
    // A budget smaller than any log: one upload a sweep (a log bigger than the budget still goes).
    const sweep = sweeper(w, "1h", { bytesPerSweep: 1 });
    const first = await quiet(() => sweep.sweep());
    assert.equal(first.result, 1);
    assert.match(first.logs[0]!, /^\[archive\] archived 1 run log\(s\), \d+ bytes; 3 more wait for the next sweep$/);
    assert.deepEqual(puts(w), ["put box-1/runs/w/3/events.jsonl.gz"]); // newest of the due ones first, as the sweep walks
    assert.equal((await quiet(() => sweep.sweep())).result, 1);
    assert.equal((await quiet(() => sweep.sweep())).result, 1);
    for (const id of ["1", "2", "3"]) assert.equal((await w.store.getRunSummary("w", id))?.logEvicted, true, id);
    assert.equal(w.archived("4"), undefined, "the run not due waits until the due ones are done");
    const last = await quiet(() => sweep.sweep());
    assert.equal(last.result, 0);
    assert.match(last.logs[0]!, /^\[archive\] archived 1 run log\(s\), \d+ bytes$/);
    assert.equal(w.archived("4"), await logOf(w, "4"));
  });
});

describe("the run archive: a bucket that fails", () => {
  const down = async (): Promise<never> => {
    throw new Error("connect ECONNREFUSED 10.0.0.9:9000");
  };

  it("unreachable: nothing is uploaded or evicted, and the sweep says so in one line", async () => {
    const w = await world({ put: down, get: down, head: down, delete: down });
    await seed(w.store, "1", summary("1", 5));
    const before = await readFile(join(w.runDir("1"), "run.json"), "utf-8");
    const sweep = await quiet(() => sweeper(w, "1h").sweep());
    assert.equal(sweep.result, 0);
    assert.deepEqual(sweep.logs, []);
    assert.deepEqual(sweep.warnings, ["[archive] the bucket does not answer, so this sweep archives and evicts nothing: connect ECONNREFUSED 10.0.0.9:9000"]);
    assert.ok(await hasLog(w, "1"));
    assert.equal(await readFile(join(w.runDir("1"), "run.json"), "utf-8"), before);
  });

  it("even a run uploaded on an earlier sweep stays while the bucket is down", async () => {
    let isDown = false;
    const w = await world();
    const { head } = w.archive.objects;
    w.archive.objects.head = (key) => (isDown ? down() : head(key));
    await seed(w.store, "1", summary("1", 0.5));
    await quiet(() => sweeper(w, "1h").sweep()); // uploaded, not due yet
    assert.ok((await w.store.getRunSummary("w", "1"))?.archive);
    isDown = true;
    const later = await quiet(() => sweeper(w, "1h", { now: () => NOW + 2 * HOUR }).sweep());
    assert.equal(later.result, 0);
    assert.equal(later.warnings.length, 1);
    assert.ok(await hasLog(w, "1"));
  });

  it("an upload that fails mid-sweep stops the sweep: nothing after it is evicted, one line", async () => {
    const w = await world();
    const { put } = w.archive.objects;
    const tried: string[] = [];
    w.archive.objects.put = (key, body) => (tried.push(key), key.includes("/runs/w/2/") ? (body.resume(), down()) : put(key, body));
    for (const id of ["1", "2", "3"]) await seed(w.store, id, summary(id, 5));
    const sweep = await quiet(() => sweeper(w, "1h").sweep());
    assert.equal(sweep.result, 1); // 3 went (newest first), 2 failed, 1 was not tried
    assert.deepEqual(sweep.warnings, ["[archive] the bucket failed, so this sweep archives and evicts nothing more: connect ECONNREFUSED 10.0.0.9:9000"]);
    assert.equal((await w.store.getRunSummary("w", "3"))?.logEvicted, true);
    for (const id of ["1", "2"]) {
      assert.ok(await hasLog(w, id), id);
      assert.equal((await w.store.getRunSummary("w", id))?.archive, undefined, id);
    }
    assert.deepEqual(tried, ["box-1/archive.json", "box-1/runs/w/3/events.jsonl.gz", "box-1/runs/w/2/events.jsonl.gz"]);
  });

  it("an upload the bucket does not hold whole is not an upload", async () => {
    const w = await world();
    // A bucket that takes the PUT and keeps half of it.
    w.archive.objects.put = async (key, body) => {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
      const whole = Buffer.concat(chunks);
      w.objects.objects.set(key, key.includes("/runs/") ? whole.subarray(0, whole.length >> 1) : whole);
    };
    await seed(w.store, "1", summary("1", 5));
    const sweep = await quiet(() => sweeper(w, "1h").sweep());
    assert.equal(sweep.result, 0);
    assert.match(sweep.warnings[0]!, /the bucket failed.*events\.jsonl\.gz" is \d+ bytes after an upload of \d+/);
    assert.ok(await hasLog(w, "1"));
    assert.equal((await w.store.getRunSummary("w", "1"))?.archive, undefined);
  });

  it("a log the bucket lost after its upload (a lifecycle rule, a delete) is uploaded again before it is evicted", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 0.5));
    await quiet(() => sweeper(w, "1h").sweep()); // uploaded, not due yet
    const key = (await w.store.getRunSummary("w", "1"))!.archive!.key;
    w.objects.objects.delete(key);
    // Due now: the sweep asks the bucket again before it takes the record's word.
    assert.equal((await quiet(() => sweeper(w, "1h", { now: () => NOW + 2 * HOUR }).sweep())).result, 1);
    assert.equal(puts(w).length, 2);
    assert.equal(await hasLog(w, "1"), false);
    assert.equal((await quiet(() => w.store.getRunEvents("w", "1"))).result.length, 3);
  });

  it("the store itself refuses to drop a log the bucket does not hold", async () => {
    const w = await world();
    await seed(w.store, "1");
    assert.equal(await w.store.evictRun("w", "1", at(0)), false, "never uploaded");
    assert.ok(await w.store.archiveRun("w", "1", at(0)));
    await w.store.append("w", "1", event("1", "late")); // the log grew after the upload
    assert.equal(await w.store.evictRun("w", "1", at(0)), false, "the upload is not this log");
    assert.ok(await hasLog(w, "1"));
    assert.equal((await w.store.getRunSummary("w", "1"))?.logEvicted, undefined);
  });

  it("a restore the bucket fails rejects, leaves the run as it was, and works once the bucket is back", async () => {
    let isDown = false;
    const w = await world();
    const { get } = w.archive.objects;
    w.archive.objects.get = (key) => (isDown ? down() : get(key));
    await seed(w.store, "1");
    await evict(w, "1");
    const before = await w.store.getRunSummary("w", "1");
    isDown = true;
    await assert.rejects(w.store.getRunEvents("w", "1"), (err: Error) => {
      assert.ok(err instanceof RunArchiveError);
      assert.equal(err.message, 'The log of run 1 of "w" is archived in s3://test/box-1 and could not be restored: connect ECONNREFUSED 10.0.0.9:9000');
      return true;
    });
    assert.deepEqual(await w.store.getRunSummary("w", "1"), before);
    assert.deepEqual(await readdir(w.runDir("1")), ["run.json"]);
    isDown = false;
    assert.equal((await quiet(() => w.store.getRunEvents("w", "1"))).result.length, 3);
  });

  it("an object that is not the log the summary recorded is refused", async () => {
    const w = await world();
    await seed(w.store, "1");
    await evict(w, "1");
    await seed(w.store, "other"); // another, longer log put where run 1's is
    await w.store.append("w", "other", event("other", "more"));
    w.objects.objects.set("box-1/runs/w/1/events.jsonl.gz", gzipSync(await logOf(w, "other")));
    await assert.rejects(w.store.getRunEvents("w", "1"), /could not be restored: .*holds \d+ bytes of log where \d+ were archived/);
    assert.deepEqual(await readdir(w.runDir("1")), ["run.json"]);
  });
});

describe("the run archive: restore on read", () => {
  const readers: Array<[string, (s: FileRunStore) => Promise<unknown>, (got: any) => void]> = [
    ["getRunEvents", (s) => s.getRunEvents("w", "1"), (got) => assert.deepEqual(got.map((e: RunEvent) => e.type), ["run.start", "step.end", "run.end"])],
    ["tailEvents", async (s) => { const seen: string[] = []; for await (const e of s.tailEvents("w", "1")) seen.push(e.type); return seen; }, (got) => assert.deepEqual(got, ["run.start", "step.end", "run.end"])],
    ["getRunStart", (s) => s.getRunStart("w", "1"), (got) => assert.deepEqual([got.type, got.input], ["run.start", { n: "1" }])],
    ["readLogTail", (s) => s.readLogTail("w", "1", 64 * 1024), (got) => assert.equal(got.at(-1).type, "run.end")],
    ["repairLog (a durable resume's first step)", (s) => s.repairLog("w", "1"), (got) => assert.equal(got, false)],
  ];
  for (const [name, read, check] of readers) {
    it(`${name} restores an evicted log to its place first`, async () => {
      const w = await world();
      await seed(w.store, "1");
      const log = await logOf(w, "1");
      await evict(w, "1");
      assert.equal(await hasLog(w, "1"), false);
      const { result, logs } = await quiet(() => read(w.store));
      check(result);
      assert.deepEqual(logs, ["[archive] restored the log of w/1 from s3://test/box-1"]);
      assert.equal(await logOf(w, "1"), log);
      const s = (await w.store.getRunSummary("w", "1"))!;
      assert.deepEqual([s.logEvicted, s.evictedAt], [undefined, undefined]);
      assert.ok(s.restoredAt && s.archive);
      assert.deepEqual((await readdir(w.runDir("1"))).sort(), ["events.jsonl", "run.json"]);
    });
  }

  it("asking a log's size or age restores nothing; the size is the archived log's", async () => {
    const w = await world();
    await seed(w.store, "1");
    const bytes = Buffer.byteLength(await logOf(w, "1"));
    await evict(w, "1");
    assert.equal(await w.store.logSize("w", "1"), bytes);
    assert.equal(await w.store.logWrittenAt("w", "1"), null);
    assert.equal(typeof (await w.store.runWrittenAt("w", "1")), "number"); // the directory's
    assert.equal(await hasLog(w, "1"), false);
    assert.deepEqual(w.calls.filter((c) => c.startsWith("get ")), []);
  });

  it("many readers at once: one restore", async () => {
    const w = await world();
    await seed(w.store, "1");
    await evict(w, "1");
    const all = await quiet(() => Promise.all([w.store.getRunEvents("w", "1"), w.store.getRunStart("w", "1"), w.store.readLogTail("w", "1", 1024), w.store.getRunEvents("w", "1")]));
    assert.deepEqual([all.result[0].length, all.result[1]?.type, all.result[2].length, all.result[3].length], [3, "run.start", 3, 3]);
    assert.deepEqual(w.calls.filter((c) => c.startsWith("get ")), ["get box-1/runs/w/1/events.jsonl.gz"]);
  });

  it("a scan over many runs (`localRuns`) reads this disk and restores nothing", async () => {
    const w = await world();
    await seed(w.store, "1");
    await evict(w, "1");
    const local = localRuns(w.store);
    assert.deepEqual(await local.getRunEvents("w", "1"), []);
    assert.equal(await local.getRunStart("w", "1"), null);
    assert.deepEqual(await local.readLogTail("w", "1", 1024), []);
    assert.equal(await local.logSize("w", "1"), 0);
    assert.equal(await hasLog(w, "1"), false);
    assert.equal((await local.getRunSummary("w", "1"))?.logEvicted, true);
    // The store itself still restores.
    assert.equal((await quiet(() => w.store.getRunEvents("w", "1"))).result.length, 3);
  });

  it("a restored log is left a day, then evicted again without another upload", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 5));
    const real = () => Date.now();
    assert.equal((await quiet(() => sweeper(w, "1h", { now: real }).sweep())).result, 1);
    await quiet(() => w.store.getRunEvents("w", "1")); // restored now
    assert.equal((await quiet(() => sweeper(w, "1h", { now: () => real() + 23 * HOUR }).sweep())).result, 0);
    assert.ok(await hasLog(w, "1"));
    const again = await quiet(() => sweeper(w, "1h", { now: () => real() + 25 * HOUR }).sweep());
    assert.equal(again.result, 1);
    assert.deepEqual(again.logs, ["[retention] evicted 1 run log(s): w 1"]);
    assert.equal(await hasLog(w, "1"), false);
    assert.equal(puts(w).length, 1, "the bucket already holds this log");
    assert.equal((await quiet(() => w.store.getRunEvents("w", "1"))).result.length, 3);
  });
});

describe("the run archive: a run that goes on", () => {
  /** What a durable resume does to the store: drop the summary, append, finish again. */
  async function resumeAndFinish(w: World, id: string, finishedHoursAgo: number) {
    await w.store.clearRunSummary("w", id);
    await w.store.append("w", id, event(id, "run.resumed"));
    await w.store.append("w", id, event(id, "step.end", { path: "w/b", output: "after the resume" }));
    await w.store.append("w", id, event(id, "run.end"));
    await w.store.finalize("w", id, summary(id, finishedHoursAgo));
  }

  it("resumed after it was uploaded and finished again: uploaded again, and the bucket holds the whole log", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 0.5));
    await quiet(() => sweeper(w, "1h").sweep());
    const first = w.archived("1")!;
    assert.equal(first, await logOf(w, "1"));

    await resumeAndFinish(w, "1", 0.2);
    assert.equal((await w.store.getRunSummary("w", "1"))?.archive, undefined, "the record went with the summary the resume dropped");
    await quiet(() => sweeper(w, "1h").sweep());
    const second = w.archived("1")!;
    assert.equal(second, await logOf(w, "1"));
    assert.ok(second.length > first.length && second.startsWith(first));
    assert.equal((await w.store.getRunSummary("w", "1"))?.archive?.bytes, Buffer.byteLength(second));
    assert.equal(puts(w).length, 2);
  });

  it("evicted, resumed (the resume's read restores it), finished and evicted again: a read gives every event", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 5));
    await quiet(() => sweeper(w, "1h").sweep());
    assert.equal(await hasLog(w, "1"), false);

    // A durable resume reads the log before it clears the summary.
    assert.equal((await quiet(() => w.store.repairLog("w", "1"))).result, false);
    assert.equal((await w.store.getRunEvents("w", "1")).length, 3);
    await resumeAndFinish(w, "1", 3);
    // While the run went on, the stale object was never read: the log is here.
    assert.deepEqual(w.calls.filter((c) => c.startsWith("get ")).length, 1);

    assert.equal((await quiet(() => sweeper(w, "1h").sweep())).result, 1);
    assert.equal(await hasLog(w, "1"), false);
    const events = (await quiet(() => w.store.getRunEvents("w", "1"))).result;
    assert.deepEqual(events.map((e) => e.type), ["run.start", "step.end", "run.end", "run.resumed", "step.end", "run.end"]);
  });

  it("a resume that starts while the log is uploading: the upload is not recorded, and the next sweep uploads the finished run", async () => {
    const w = await world();
    await seed(w.store, "1", summary("1", 5));
    const { put } = w.archive.objects;
    let resumed = false;
    w.archive.objects.put = async (key, body) => {
      await put(key, body);
      if (key.includes("/runs/") && !resumed) {
        resumed = true;
        await w.store.clearRunSummary("w", "1");
        await w.store.append("w", "1", event("1", "run.resumed"));
      }
    };
    assert.equal((await quiet(() => sweeper(w, "1h").sweep())).result, 0);
    assert.equal(await w.store.getRunSummary("w", "1"), null, "the sweep wrote no summary onto a run that is going on");
    assert.ok(await hasLog(w, "1"));
    await w.store.append("w", "1", event("1", "run.end"));
    await w.store.finalize("w", "1", summary("1", 4));
    assert.equal((await quiet(() => sweeper(w, "1h").sweep())).result, 1);
    assert.equal((await quiet(() => w.store.getRunEvents("w", "1"))).result.length, 5);
  });
});

describe("the run archive: off, and its settings", () => {
  it("a store with no archive evicts as before: the log is gone and nothing brings it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-archive-"));
    const store = new FileRunStore(root);
    await seed(store, "1");
    assert.equal(localRuns(store), store);
    assert.equal(await store.evictRun("w", "1", at(0)), true);
    assert.deepEqual(await readdir(join(root, "workflows", "w", "runs", "1")), ["run.json"]);
    const s = (await store.getRunSummary("w", "1"))!;
    assert.deepEqual([s.logEvicted, s.archive, s.restoredAt], [true, undefined, undefined]);
    assert.deepEqual(await store.getRunEvents("w", "1"), []);
    assert.equal(await store.getRunStart("w", "1"), null);
    assert.equal(await store.logSize("w", "1"), 0);
    await assert.rejects(store.archiveRun("w", "1", at(0)), /no archive/);
  });

  it("deleting a workflow's runs deletes their logs in the bucket", async () => {
    const w = await world();
    await seed(w.store, "1");
    await seed(w.store, "2");
    await evict(w, "1");
    assert.ok(await w.store.archiveRun("w", "2", at(0)));
    await w.store.deleteRuns("w");
    await new Promise((r) => setTimeout(r, 20)); // the deletes are not waited for
    assert.deepEqual([...w.objects.objects.keys()], []);
    assert.deepEqual(await w.store.listRuns("w"), []);
  });

  it("STRUT_ARCHIVE_S3_*: no bucket is no archive; the prefix is trimmed and defaults to `strut`", () => {
    assert.equal(archiveFromEnv({}), undefined);
    assert.equal(archiveFromEnv({ STRUT_ARCHIVE_S3_PREFIX: "x", STRUT_ARCHIVE_S3_ACCESS_KEY_ID: "k", STRUT_ARCHIVE_S3_SECRET_ACCESS_KEY: "s" }), undefined);
    const plain = archiveFromEnv({ STRUT_ARCHIVE_S3_BUCKET: "fleet-logs" })!;
    assert.deepEqual([plain.prefix, plain.label], ["strut", "s3://fleet-logs/strut"]);
    const box = archiveFromEnv({ STRUT_ARCHIVE_S3_BUCKET: "fleet-logs", STRUT_ARCHIVE_S3_PREFIX: "/strut/box-7/", STRUT_ARCHIVE_S3_ENDPOINT: "http://minio:9000" })!;
    assert.deepEqual([box.prefix, box.label], ["strut/box-7", "s3://fleet-logs/strut/box-7 at http://minio:9000"]);
    assert.equal(archiveFromEnv({ STRUT_ARCHIVE_S3_BUCKET: "b", STRUT_ARCHIVE_S3_PREFIX: " / " })!.prefix, "strut");
  });

  it("one key without the other: the archive is on and every call fails saying so, so nothing is evicted", async () => {
    const half = archiveFromEnv({ STRUT_ARCHIVE_S3_BUCKET: "b", STRUT_ARCHIVE_S3_ACCESS_KEY_ID: "k" })!;
    await assert.rejects(checkArchive(half), /STRUT_ARCHIVE_S3_ACCESS_KEY_ID and STRUT_ARCHIVE_S3_SECRET_ACCESS_KEY are set together or not at all/);
  });

  it("no step reads the archive's settings", () => {
    for (const name of ["STRUT_ARCHIVE_S3_BUCKET", "STRUT_ARCHIVE_S3_ACCESS_KEY_ID", "STRUT_ARCHIVE_S3_SECRET_ACCESS_KEY", "strut_archive_s3_endpoint"]) assert.ok(hiddenFromSteps(name), name);
    assert.equal(hiddenFromSteps("STRUT_RUN_RETENTION"), false);
  });

  it("the probe is written once and read after; a key that may not list still passes", async () => {
    const w = await world();
    await checkArchive(w.archive);
    await checkArchive(w.archive);
    assert.deepEqual(w.calls, ["head box-1/archive.json", "put box-1/archive.json", "head box-1/archive.json", "head box-1/archive.json"]);
    // Without s3:ListBucket a HEAD of a key that is not there is a 403, not a 404.
    const strict = await world();
    const { head } = strict.archive.objects;
    strict.archive.objects.head = async (key) => {
      if (!strict.objects.objects.has(key)) throw new Error('S3 HEAD "' + key + '" failed (403)');
      return head(key);
    };
    await checkArchive(strict.archive);
    assert.ok(strict.objects.objects.has("box-1/archive.json"));
  });
});

// ── Through createStrut: the run view, the tail, a resume ───────────────────

describe("the run archive through createStrut", () => {
  /** Fails its first `failures` calls. */
  function flakey(failures: number) {
    let calls = 0;
    return defineStep({
      type: "flakey",
      input: z.any(),
      output: z.any(),
      async run() {
        if (++calls <= failures) throw new Error(`attempt ${calls} failed`);
        return { calls };
      },
    });
  }
  const value = defineStep({ type: "value", input: z.object({ result: z.any() }), output: z.any(), run: async (cfg) => cfg.result });

  async function boot(faults: Partial<ObjectStore> = {}, registry: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "strut-archive-http-"));
    const objects = new MemoryObjectStore();
    const archive: RunArchive = {
      objects: { put: objects.put.bind(objects), get: objects.get.bind(objects), head: objects.head.bind(objects), delete: objects.delete.bind(objects), ...faults },
      prefix: "box-1",
      label: "s3://test/box-1",
    };
    const workspace = new WorkspaceManager(dir);
    const started = await quiet(() =>
      createStrut({ workspace, registry: { value, ...registry } as StepRegistry, archive, serveUi: false, enableChat: false, autoResume: false, scheduler: false }),
    );
    const strut = started.result;
    await new Promise((r) => setTimeout(r, 10)); // the boot check's line
    const store = strut.store as FileRunStore;
    const get = (path: string) => strut.app.request(path);
    const logHere = (wf: string, id: string) => stat(join(dir, "workflows", wf, "runs", id, "events.jsonl")).then(() => true, () => false);
    const waitForSummary = async (wf: string, id: string, not?: string) => {
      for (let i = 0; i < 300; i++) {
        const s = await store.getRunSummary(wf, id);
        if (s && s.finishedAt !== not) return s;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("the run never finished");
    };
    return { dir, strut, store, objects, workspace, get, logHere, waitForSummary, close: async () => { await strut.close(); await rm(dir, { recursive: true, force: true }); } };
  }
  const ONE_STEP = (name: string, type = "value") => `name: ${name}\nsteps:\n  - id: a\n    type: ${type}\n    config: { result: 42 }\n`;

  it("says at boot that the archive is on and works, or that it does not", async () => {
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    try {
      const up = await boot();
      const down = await boot({ head: async () => { throw new Error("no route to host"); }, put: async () => { throw new Error("no route to host"); } });
      await up.close();
      await down.close();
    } finally {
      log.mock.restore();
      warn.mock.restore();
    }
    assert.deepEqual(log.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[archive]")), ["[archive] on: finished runs' logs go to s3://test/box-1 before they are evicted"]);
    assert.deepEqual(warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[archive]")), ["[archive] on, and s3://test/box-1 does not work: no route to host. Nothing is evicted until it does"]);
  });

  it("the sweep createStrut wires uploads and evicts; the run lists as archived and opens: its events and its tail restore it", async () => {
    const t = await boot();
    try {
      await t.workspace.publishWorkflowByContent("hello", `${ONE_STEP("hello")}retain: 1s\n`);
      const run = await t.strut.run("hello", {});
      assert.equal(run.status, "success");
      await new Promise((r) => setTimeout(r, 1100)); // past `retain: 1s`
      assert.equal((await quiet(() => t.strut.retention.sweep())).result, 1);
      assert.equal(await t.logHere("hello", run.runId), false);
      assert.ok(t.objects.objects.has(`box-1/runs/hello/${run.runId}/events.jsonl.gz`));

      const listed = ((await (await t.get("/workflows/hello/runs")).json()) as RunSummary[])[0]!;
      assert.equal(listed.logEvicted, true);
      assert.equal(listed.archive?.key, `box-1/runs/hello/${run.runId}/events.jsonl.gz`);
      // Listings and counts over many runs leave the archive where it is.
      assert.equal((await t.get("/workflows/hello/versions")).status, 200);
      assert.equal((await t.get("/steps/value/stats")).status, 200);
      assert.equal(await t.logHere("hello", run.runId), false);

      // Opening it: the events read restores the log.
      const opened = await quiet(() => t.get(`/workflows/hello/runs/${run.runId}/events`));
      assert.equal(opened.result.status, 200);
      const events = (await opened.result.json()) as RunEvent[];
      assert.deepEqual([events[0]!.type, events.at(-1)!.type], ["run.start", "run.end"]);
      assert.equal(await t.logHere("hello", run.runId), true);
      const after = (await (await t.get(`/workflows/hello/runs/${run.runId}`)).json()) as RunSummary;
      assert.deepEqual([after.logEvicted, typeof after.restoredAt, after.archive?.bytes], [undefined, "string", listed.archive!.bytes]);

      // Evicted again, the live tail restores it too.
      assert.equal(await t.store.evictRun("hello", run.runId, new Date().toISOString()), true);
      const tail = await quiet(async () => (await t.get(`/workflows/hello/runs/${run.runId}/stream`)).text());
      assert.match(tail.result, /"type":"run.start"[\s\S]*"type":"run.end"[\s\S]*event: done/);
      assert.equal(await t.logHere("hello", run.runId), true);
    } finally {
      await t.close();
    }
  });

  it("an evicted run resumes from its archived log, and is uploaded again when it has finished", async () => {
    const t = await boot({}, { flakey: flakey(1) });
    try {
      await t.workspace.publishWorkflowByContent("flaky", `name: flaky\nsteps:\n  - id: a\n    type: value\n    config: { result: 1 }\n  - id: b\n    type: flakey\n    config: {}\n`);
      const failed = await t.strut.run("flaky", {});
      assert.equal(failed.status, "error");
      const first = await t.waitForSummary("flaky", failed.runId);
      assert.ok(await t.store.archiveRun("flaky", failed.runId, new Date().toISOString()));
      assert.equal(await t.store.evictRun("flaky", failed.runId, new Date().toISOString()), true);
      const key = `box-1/runs/flaky/${failed.runId}/events.jsonl.gz`;
      const before = gunzipSync(t.objects.objects.get(key)!).toString();

      const resume = await quiet(() => t.strut.app.request(`/workflows/flaky/runs/${failed.runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      assert.equal(resume.result.status, 202, await resume.result.clone().text());
      const done = await t.waitForSummary("flaky", failed.runId, first.finishedAt);
      assert.equal(done.status, "success");
      assert.equal(done.archive, undefined, "the finished run is not the log the bucket holds");
      const types = (await t.store.getRunEvents("flaky", failed.runId)).map((e) => e.type);
      assert.ok(types.includes("run.error") && types.includes("run.resumed") && types.at(-1) === "run.end", types.join(","));

      assert.ok(await t.store.archiveRun("flaky", failed.runId, new Date().toISOString()));
      const now = gunzipSync(t.objects.objects.get(key)!).toString();
      assert.ok(now.length > before.length && now.startsWith(before));
    } finally {
      await t.close();
    }
  });

  it("a strut with no archive says an archived run's log is in one, where it would show an empty run", async () => {
    const t = await boot();
    try {
      await t.workspace.publishWorkflowByContent("hello", ONE_STEP("hello"));
      const run = await t.strut.run("hello", {});
      assert.ok(await t.store.archiveRun("hello", run.runId, new Date().toISOString()));
      assert.equal(await t.store.evictRun("hello", run.runId, new Date().toISOString()), true);
      // The same data, booted with no bucket set.
      const bare = await createStrut({ workspace: new WorkspaceManager(t.dir), registry: { value } as StepRegistry, serveUi: false, enableChat: false, autoResume: false, scheduler: false });
      try {
        const res = await bare.app.request(`/workflows/hello/runs/${run.runId}/events`);
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: `The log of run ${run.runId} of "hello" is in a run archive (box-1/runs/hello/${run.runId}/events.jsonl.gz), and this strut has no archive configured (STRUT_ARCHIVE_S3_BUCKET)` });
        // A log that was deleted with no archive is still an empty list.
        await bare.store.finalize("hello", "1", { runId: "1", workflow: "hello", startedAt: at(1), finishedAt: at(1), durationMs: 1, status: "success", input: {}, logEvicted: true });
        assert.deepEqual(await (await bare.app.request("/workflows/hello/runs/1/events")).json(), []);
      } finally {
        await bare.close();
      }
    } finally {
      await t.close();
    }
  });

  it("a run whose log the bucket cannot give back opens with that said, not as an empty run", async () => {
    const t = await boot({ get: async () => { throw new Error("no route to host"); } });
    try {
      await t.workspace.publishWorkflowByContent("hello", ONE_STEP("hello"));
      const run = await t.strut.run("hello", {});
      assert.ok(await t.store.archiveRun("hello", run.runId, new Date().toISOString()));
      assert.equal(await t.store.evictRun("hello", run.runId, new Date().toISOString()), true);
      const res = await t.get(`/workflows/hello/runs/${run.runId}/events`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: `The log of run ${run.runId} of "hello" is archived in s3://test/box-1 and could not be restored: no route to host` });
      assert.equal((await t.store.getRunSummary("hello", run.runId))?.logEvicted, true);
    } finally {
      await t.close();
    }
  });
});
