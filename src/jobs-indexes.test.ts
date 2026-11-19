/**
 * The indexes beside the job records (jobs.ts, `.used` and `.sweep`): a job
 * turn's sweep and a `GET /jobs?limit=N` read the records they have
 * something to do with, never every record on the server. A swarm holds
 * 100k jobs after months; before these, every turn and every listing read
 * them all.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsp, { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { shellCapability } from "./capabilities.js";
import { MemoryRunStore } from "./store.js";
import { createJobIndex } from "./job-index.js";
import { deleteJob, jobRoot, jobsCapability, jobsIndexed, readJobRecord, sweepJobs, touchJob, type JobRecord } from "./jobs.js";

const DAY = 86_400_000;
const shell = shellCapability();

/** How many job records (`<dataDir>/jobs/*.json`) are read while `fn` runs. */
async function recordReads<T>(dataDir: string, fn: () => Promise<T>): Promise<{ reads: number; result: T }> {
  const base = join(dataDir, "jobs") + sep;
  const real = fsp.readFile;
  let reads = 0;
  fsp.readFile = ((path: unknown, ...rest: unknown[]) => {
    const p = String(path);
    if (p.startsWith(base) && p.endsWith(".json") && !p.slice(base.length).includes(sep)) reads++;
    return (real as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real;
  syncBuiltinESMExports();
  try {
    return { result: await fn(), reads };
  } finally {
    fsp.readFile = real;
    syncBuiltinESMExports();
  }
}

/** Every entry in `.used`, by day. */
async function usedEntries(dataDir: string): Promise<string[]> {
  const used = join(dataDir, "jobs", ".used");
  const out: string[] = [];
  for (const day of await readdir(used)) for (const e of await readdir(join(used, day))) out.push(e);
  return out;
}

describe("jobs — the indexes beside the records", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = join(await mkdtemp(join(tmpdir(), "strut-job-indexes-")), "data");
  });
  afterEach(async () => {
    await rm(join(dataDir, ".."), { recursive: true, force: true });
  });

  /** `n` jobs of runs alone (what most jobs are), each used after the one before. */
  const jobsOfRuns = async (names: string[]) => {
    const jobs = jobsCapability(dataDir);
    for (const name of names) {
      await jobs.recordRun(name, { workflow: "job", runId: `${name}-run` });
      await new Promise((r) => setTimeout(r, 2)); // distinct `usedAt`s
    }
  };
  const many = (n: number, prefix = "j") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  /** A job with a repository checked out into it, `idleDays` unused. */
  const withRepo = async (name: string, idleDays: number) => {
    const r = jobRoot(dataDir, name);
    await mkdir(join(r, "repo"), { recursive: true });
    await touchJob(r, name, { dir: join(r, "repo"), cache: join(dataDir, "repos", "x.git"), ref: "main" });
    const rec = (await readJobRecord(r))!;
    rec.usedAt = new Date(Date.now() - idleDays * DAY).toISOString();
    await writeFile(`${r}.json`, JSON.stringify(rec));
    return r;
  };

  it("a turn's sweep reads only the jobs it has something to look at, not every record", async () => {
    await jobsOfRuns(many(60));
    const idle = await withRepo("idle", 8);
    const fresh = await withRepo("fresh", 1);
    await jobsIndexed(dataDir);

    const first = await recordReads(dataDir, () => sweepJobs(shell, dataDir, 7 * DAY));
    assert.deepEqual(first.result, ["idle"]);
    assert.ok(!existsSync(idle), "an idle job with nothing left is still removed");
    assert.ok(existsSync(join(fresh, "repo")));
    // Each job in `.sweep` is read, and read again under its lock: two jobs.
    assert.equal(first.reads, 4, "the 60 jobs of runs alone are never read");

    const second = await recordReads(dataDir, () => sweepJobs(shell, dataDir, 7 * DAY));
    assert.deepEqual(second.result, []);
    assert.equal(second.reads, 2, "the swept job left the index; the fresh one stays in it");
  });

  it("a job whose repositories were swept leaves the sweep's index; a checkout puts it back", async () => {
    const r = await withRepo("kept", 8);
    await jobsCapability(dataDir).recordRun("kept", { workflow: "job", runId: "k1" });
    const rec = (await readJobRecord(r))!;
    rec.usedAt = new Date(Date.now() - 8 * DAY).toISOString();
    await writeFile(`${r}.json`, JSON.stringify(rec));

    assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), ["kept"]);
    assert.ok(existsSync(`${r}.json`), "the job's history stays");
    assert.ok(!existsSync(join(dataDir, "jobs", ".sweep", "kept")), "nothing left for a sweep");
    assert.equal((await recordReads(dataDir, () => sweepJobs(shell, dataDir, 7 * DAY))).reads, 0);

    await mkdir(join(r, "repo"), { recursive: true });
    await touchJob(r, "kept", { dir: join(r, "repo"), cache: join(dataDir, "repos", "x.git"), ref: "main" });
    assert.ok(existsSync(join(dataDir, "jobs", ".sweep", "kept")), "a repository again: back in the index");
  });

  it("GET /jobs?limit=N reads N records, newest-used first; an id prefix is decided before a record is read", async () => {
    await jobsOfRuns([...many(60), "app/bench/a", "app/bench/b", ...many(20, "k")]);
    const index = createJobIndex({ dataDir, store: new MemoryRunStore() });
    await jobsIndexed(dataDir);

    const top = await recordReads(dataDir, () => index.list({ limit: 5 }));
    assert.deepEqual(top.result.map((j) => j.job), ["k-19", "k-18", "k-17", "k-16", "k-15"]);
    assert.equal(top.reads, 5, "not the 82 on file");

    const app = await recordReads(dataDir, () => index.list({ prefix: "app/bench/" }));
    assert.deepEqual(app.result.map((j) => j.job), ["app/bench/b", "app/bench/a"]);
    assert.equal(app.reads, 2);

    // A job used again moves to the front; its earlier entry goes.
    await jobsCapability(dataDir).recordRun("j-0", { workflow: "job", runId: "again" });
    assert.deepEqual((await index.list({ limit: 2 })).map((j) => [j.job, j.runs]), [["j-0", 2], ["k-19", 1]]);
    assert.equal((await usedEntries(dataDir)).length, 82, "one entry per job");

    // A deleted job leaves the listing and the index.
    await deleteJob(shell, jobRoot(dataDir, "k-19"), "k-19", undefined);
    assert.deepEqual((await index.list({ limit: 2 })).map((j) => j.job), ["j-0", "k-18"]);
    assert.equal((await usedEntries(dataDir)).length, 81);

    // Without a limit, every job, newest-used first.
    const all = await index.list();
    assert.equal(all.length, 81);
    const used = all.map((j) => Date.parse(j.usedAt));
    assert.deepEqual(used, [...used].sort((a, b) => b - a));
  });

  it("records from before the indexes are put in by one pass, the first time a sweep or a listing needs them", async () => {
    // A data directory from before: records alone, written by hand.
    const base = join(dataDir, "jobs");
    await mkdir(join(base, "old-repo", "repo"), { recursive: true });
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
    const records: JobRecord[] = [
      { name: "older", usedAt: at(3), repos: {}, runs: [{ workflow: "job", runId: "o", at: at(3) }] },
      { name: "newer", usedAt: at(2), repos: {}, runs: [{ workflow: "job", runId: "n", at: at(2) }] },
      { name: "old-repo", usedAt: at(9), repos: { [join(base, "old-repo", "repo")]: { cache: join(dataDir, "repos", "x.git"), ref: "main" } }, runs: [{ workflow: "job", runId: "r", at: at(9) }] },
    ];
    for (const rec of records) await writeFile(join(base, `${rec.name}.json`), JSON.stringify(rec));

    const index = createJobIndex({ dataDir, store: new MemoryRunStore() });
    assert.deepEqual((await index.list()).map((j) => j.job), ["newer", "older", "old-repo"]);
    assert.ok(existsSync(join(base, ".indexed")), "done once for this data directory");
    assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), ["old-repo"], "its repository is found and swept");
    assert.ok(!existsSync(join(base, "old-repo", "repo")));
  });
});
