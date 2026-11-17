/**
 * The archive tier for run logs (plans/run-archive.md): a finished run's
 * `events.jsonl` is uploaded gzipped to a bucket before retention evicts it
 * (`src/retention.ts`), and a read of an evicted log brings it back to its
 * local path first (`FileRunStore`). The run summary stays local as the
 * index and records the upload (`RunSummary.parts.log.archive`).
 *
 * This file is the transport: a log file to an object and back, each way
 * checked. Only the event log travels. `callback.json`, `mcp.json` and
 * `job-callback.json` hold credentials and are never read here.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform, pipeline as pipe } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { ArchivedPart } from "./core.js";
import { S3ObjectStore, type ObjectStore } from "./object-store.js";

export interface RunArchive {
  objects: ObjectStore;
  /** The key prefix this strut writes under, no slash at either end. */
  prefix: string;
  /** What a log line calls it: `s3://bucket/prefix`. */
  label: string;
}

/** An archived log could not be brought back (the bucket is unreachable,
 *  the object is gone or is not the log the summary recorded). */
export class RunArchiveError extends Error {}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The archive `STRUT_ARCHIVE_S3_*` describes, or undefined with no bucket.
 *  One key without the other is not "no archive" (retention would then
 *  delete what the deployer meant to keep): the archive is on, every call
 *  to it fails saying so, and nothing is evicted. */
export function archiveFromEnv(env: NodeJS.ProcessEnv): RunArchive | undefined {
  const get = (name: string) => env[`STRUT_ARCHIVE_S3_${name}`]?.trim() || undefined;
  const bucket = get("BUCKET");
  if (!bucket) return undefined;
  const prefix = (get("PREFIX") ?? "").replace(/^\/+|\/+$/g, "") || "strut";
  const endpoint = get("ENDPOINT");
  const accessKeyId = get("ACCESS_KEY_ID");
  const secretAccessKey = get("SECRET_ACCESS_KEY");
  const half = !accessKeyId !== !secretAccessKey;
  const objects = half
    ? refusing("STRUT_ARCHIVE_S3_ACCESS_KEY_ID and STRUT_ARCHIVE_S3_SECRET_ACCESS_KEY are set together or not at all")
    : new S3ObjectStore({
        bucket,
        region: get("REGION") ?? env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1",
        ...(endpoint ? { endpoint } : {}),
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      });
  return { objects, prefix, label: `s3://${bucket}/${prefix}${endpoint ? ` at ${endpoint}` : ""}` };
}

function refusing(why: string): ObjectStore {
  const refuse = async (): Promise<never> => {
    throw new Error(why);
  };
  return { put: refuse, get: refuse, head: refuse, delete: refuse };
}

/** Where a run's log goes. `workflow` is a run store key that is a workflow
 *  name: the `step:` / `check:` buckets are not archived. */
export function logKey(archive: RunArchive, workflow: string, runId: string): string {
  return `${archive.prefix}/runs/${workflow}/${runId}/events.jsonl.gz`;
}

/** Passes bytes through, reporting how many. */
const counting = (add: (n: number) => void) =>
  new Transform({
    transform(chunk: Buffer, _encoding, done) {
      add(chunk.length);
      done(null, chunk);
    },
  });

/** Upload `file` gzipped under `key` and check the bucket holds what was
 *  sent. Resolves to the log's size as read and the object's. Nothing is
 *  written locally, so a full disk can still be emptied. */
export async function uploadLog(objects: ObjectStore, key: string, file: string): Promise<{ bytes: number; size: number }> {
  let bytes = 0;
  let size = 0;
  // The callback form returns the last stream and destroys the chain with
  // the error when any part fails, which is how the upload hears of it.
  const body = pipe(
    createReadStream(file),
    counting((n) => (bytes += n)),
    createGzip(),
    counting((n) => (size += n)),
    () => {},
  );
  await objects.put(key, body);
  const held = await objects.head(key);
  if (held?.size !== size) throw new Error(`"${key}" is ${held ? `${held.size} bytes` : "missing"} after an upload of ${size}`);
  return { bytes, size };
}

/** Bring an archived log back to `file`: written beside it and renamed into
 *  place, so a reader never sees half a log. Refuses an object that is not
 *  as long as the log its record describes. The directory is the run's and
 *  is there (its summary is in it); one that went meanwhile, with a deleted
 *  workflow, is not made again. */
export async function downloadLog(objects: ObjectStore, log: ArchivedPart, file: string): Promise<void> {
  const tmp = `${file}.restoring`;
  let bytes = 0;
  try {
    // Flushed before the rename: a crash must not leave a short file under the log's name.
    await pipeline(await objects.get(log.key), createGunzip(), counting((n) => (bytes += n)), createWriteStream(tmp, { flush: true }));
    if (bytes !== log.bytes) throw new Error(`"${log.key}" holds ${bytes} bytes of log where ${log.bytes} were archived`);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Settle once the bucket answers for this prefix, reject with why not. A
 *  small object under the prefix is the probe: written the first time,
 *  read every time after. A read that fails is not yet a failure: without
 *  `s3:ListBucket` a key that is not there answers 403, not 404, so the
 *  probe is written and read again before anything is concluded. */
export async function checkArchive(archive: RunArchive): Promise<void> {
  const key = `${archive.prefix}/archive.json`;
  if (await archive.objects.head(key).catch(() => null)) return;
  await archive.objects.put(key, Readable.from([`${JSON.stringify({ strut: "run archive", since: new Date().toISOString() })}\n`]));
  if (!(await archive.objects.head(key))) throw new Error(`"${key}" was written and cannot be read back`);
}

/** Delete the archived logs of runs whose records are gone (a deleted
 *  workflow's). Best effort: one line says how many could not be deleted. */
export async function forgetLogs(archive: RunArchive, keys: string[]): Promise<void> {
  let failed = 0;
  let why = "";
  for (const key of keys) {
    await archive.objects.delete(key).catch((err) => {
      failed++;
      why ||= errorText(err);
    });
  }
  if (failed) console.warn(`[archive] ${failed} of ${keys.length} archived run log(s) could not be deleted from ${archive.label}: ${why}`);
}
