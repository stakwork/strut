/**
 * LIVE run-archive test: the S3 client against a real S3-compatible store
 * (MinIO in Docker). Skipped unless STRUT_TEST_S3_BUCKET is set:
 *
 *   docker run -d --name strut-minio-test -p 9100:9000 \
 *     -e MINIO_ROOT_USER=struttest -e MINIO_ROOT_PASSWORD=struttest123 minio/minio server /data
 *   docker exec strut-minio-test mc alias set local http://localhost:9000 struttest struttest123
 *   docker exec strut-minio-test mc mb local/strut-test
 *   STRUT_TEST_S3_ENDPOINT=http://localhost:9100 STRUT_TEST_S3_BUCKET=strut-test \
 *     STRUT_TEST_S3_ACCESS_KEY_ID=struttest STRUT_TEST_S3_SECRET_ACCESS_KEY=struttest123 npm run test:archive
 *
 * It writes under `strut-test/<random>/` in that bucket and deletes what it
 * wrote. Without STRUT_TEST_S3_ENDPOINT it talks to AWS S3 itself, with the
 * key pair or, with none, the default credential chain.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunSummary } from "./core.js";
import { S3ObjectStore, type ObjectStore } from "./object-store.js";
import { ARCHIVE_LOCAL_WINDOW, createRetention } from "./retention.js";
import { archiveFromEnv, checkArchive, type RunArchive } from "./run-archive.js";
import { FileRunStore } from "./store.js";
import { objectStoreConformance } from "./test-util/object-store-conformance.js";

const env = (name: string) => process.env[`STRUT_TEST_S3_${name}`]?.trim() || undefined;
const bucket = env("BUCKET");
const prefix = `strut-test/${randomBytes(4).toString("hex")}`;

describe("run archive live (STRUT_TEST_S3_BUCKET)", { skip: bucket ? false : "STRUT_TEST_S3_BUCKET not set" }, () => {
  // The settings as a deployment gives them, through the same door.
  const settings = {
    STRUT_ARCHIVE_S3_BUCKET: bucket,
    STRUT_ARCHIVE_S3_PREFIX: prefix,
    STRUT_ARCHIVE_S3_REGION: env("REGION"),
    STRUT_ARCHIVE_S3_ENDPOINT: env("ENDPOINT"),
    STRUT_ARCHIVE_S3_ACCESS_KEY_ID: env("ACCESS_KEY_ID"),
    STRUT_ARCHIVE_S3_SECRET_ACCESS_KEY: env("SECRET_ACCESS_KEY"),
  };
  const written = new Set<string>();
  let archive!: RunArchive;
  /** The archive's store, remembering every key so `after` can delete it. */
  const s3 = (): ObjectStore => {
    if (!archive) {
      const real = archiveFromEnv(settings)!;
      archive = { ...real, objects: { ...bind(real.objects), put: (key, body) => (written.add(key), real.objects.put(key, body)) } };
      closers.push(() => (real.objects as S3ObjectStore).close());
    }
    return archive.objects;
  };
  const bind = (o: ObjectStore): ObjectStore => ({ put: o.put.bind(o), get: o.get.bind(o), head: o.head.bind(o), delete: o.delete.bind(o) });
  const closers: Array<() => Promise<void>> = [];

  after(async () => {
    for (const key of written) await archive.objects.delete(key).catch(() => {});
    for (const close of closers) await close();
  });

  describe("S3ObjectStore", () => {
    objectStoreConformance(s3, `${prefix}/conformance`);
  });

  it("the archive answers its check, and the probe is where the prefix says", async () => {
    s3();
    await checkArchive(archive);
    await checkArchive(archive);
    assert.ok(await archive.objects.head(`${prefix}/archive.json`));
    assert.equal(archive.prefix, prefix);
  });

  it("a sweep uploads a finished run's log and evicts it; a read restores it byte for byte", async () => {
    s3();
    const root = await mkdtemp(join(tmpdir(), "strut-archive-live-"));
    try {
      const store = new FileRunStore(root);
      store.useArchive(archive);
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      // A log that does not fit one 5 MB upload part once gzipped: 8 MB of
      // noise, which base64 makes 10.4 MB of log and gzip takes back to 8.
      for (let i = 0; i < 6; i++) {
        await store.append("live", "1", { type: i ? "step.end" : "run.start", ts: old, runId: "1", path: "live", output: randomBytes(1_300_000).toString("base64") } as RunEvent);
      }
      await store.append("live", "1", { type: "run.end", ts: old, runId: "1", path: "live" } as RunEvent);
      await store.setRunCallback("live", "1", "https://host.example/callback?token=SECRET");
      await store.finalize("live", "1", { runId: "1", workflow: "live", startedAt: old, finishedAt: old, durationMs: 1, status: "success", input: {} } as RunSummary);
      const file = join(root, "workflows", "live", "runs", "1", "events.jsonl");
      const log = await readFile(file);

      const sweep = createRetention({
        store,
        workspace: { listWorkflows: async () => [{ name: "live" }], getWorkflow: async () => ({}) },
        fallback: ARCHIVE_LOCAL_WINDOW,
        archive: { check: () => checkArchive(archive) },
      });
      assert.equal(await sweep.sweep(), 1);
      const s = (await store.getRunSummary("live", "1"))!;
      assert.equal(s.logEvicted, true);
      assert.deepEqual([s.archive?.key, s.archive?.bytes], [`${prefix}/runs/live/1/events.jsonl.gz`, log.length]);
      assert.ok(s.archive!.size > 5 * 1024 * 1024, "sent as a multipart upload");
      assert.deepEqual(await archive.objects.head(s.archive!.key), { size: s.archive!.size });
      assert.deepEqual(await readdir(join(root, "workflows", "live", "runs", "1")), ["run.json"]);

      assert.equal((await store.getRunEvents("live", "1")).length, 7);
      assert.ok((await readFile(file)).equals(log));
      assert.equal((await store.getRunSummary("live", "1"))?.logEvicted, undefined);

      // Asked again, the bucket still holds it: no second upload. Deleted
      // from the bucket (a lifecycle rule), it is uploaded again.
      const puts = written.size;
      assert.deepEqual(await store.archiveRun("live", "1", old), { archive: s.archive });
      await archive.objects.delete(s.archive!.key);
      const again = await store.archiveRun("live", "1", new Date().toISOString());
      assert.deepEqual([again?.archive?.key, again?.archive?.bytes], [s.archive!.key, log.length]);
      assert.deepEqual(await archive.objects.head(s.archive!.key), { size: again!.archive!.size });
      assert.equal(written.size, puts, "the same key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a key the bucket refuses: the check fails in one line that names the call", async () => {
    if (!settings.STRUT_ARCHIVE_S3_ACCESS_KEY_ID) return; // the default chain has no wrong key to give
    const wrong = archiveFromEnv({ ...settings, STRUT_ARCHIVE_S3_SECRET_ACCESS_KEY: "not-the-secret" })!;
    closers.push(() => (wrong.objects as S3ObjectStore).close());
    await assert.rejects(checkArchive(wrong), /^Error: S3 PUT ".*archive\.json" failed \(403\)/);
  });
});
