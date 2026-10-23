/**
 * Download a model asset into the model dir: fetch, verify its sha256, then
 * either extract a `.tar.bz2` (sherpa's releases) or keep the single file (a
 * GGUF). A finished install is marked by `<dir>/.ok`; until then nothing is
 * at `dir`. The one downloader behind the STT catalog (stt.ts) and the
 * dictation model picker (dictation-models.ts).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export interface ModelAsset {
  id: string;
  url: string;
  /** sha256 of the downloaded bytes (the archive, or the file). */
  sha256: string;
  bytes: number;
  /** A `.tar.bz2`: the top-level directory inside it becomes `dir`. */
  archiveDir?: string;
  /** A single file: saved as `dir/<file>`. */
  file?: string;
}

export type DownloadProgress =
  | { phase: "download"; received: number; total: number }
  | { phase: "extract" }
  | { phase: "done" };

/** Install `asset` at `dir` (idempotent; concurrent calls for one dir share a download). */
export type Installer = (asset: ModelAsset, dir: string, onProgress?: (p: DownloadProgress) => void) => Promise<void>;

export async function isInstalled(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".ok"));
    return true;
  } catch {
    return false;
  }
}

export function createInstaller(o: { fetchImpl?: typeof fetch; log?: (msg: string) => void } = {}): Installer {
  const fetchImpl = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});
  const inflight = new Map<string, { done: Promise<void>; listeners: Set<(p: DownloadProgress) => void> }>();
  return async (asset, dir, onProgress) => {
    if (await isInstalled(dir)) return;
    let job = inflight.get(dir);
    if (!job) {
      const listeners = new Set<(p: DownloadProgress) => void>();
      const emit = (p: DownloadProgress) => listeners.forEach((l) => l(p));
      job = { listeners, done: download(asset, dir, fetchImpl, log, emit).finally(() => inflight.delete(dir)) };
      inflight.set(dir, job);
    }
    if (onProgress) job.listeners.add(onProgress);
    return job.done;
  };
}

async function download(
  asset: ModelAsset,
  dir: string,
  fetchImpl: typeof fetch,
  log: (msg: string) => void,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  const part = `${dir}.part`;
  log(`downloading ${asset.id} (${Math.round(asset.bytes / 1e6)} MB)`);
  const res = await fetchImpl(asset.url);
  if (!res.ok || !res.body) throw new Error(`download failed for ${asset.id}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? asset.bytes);
  const hash = createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      onProgress({ phase: "download", received, total });
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, meter, createWriteStream(part));
    const digest = hash.digest("hex");
    if (digest !== asset.sha256) throw new Error(`sha256 mismatch for ${asset.id}: expected ${asset.sha256}, got ${digest}`);
    const scratch = `${dir}.extract`;
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    if (asset.archiveDir) {
      onProgress({ phase: "extract" });
      await untar(part, scratch);
      await rm(dir, { recursive: true, force: true });
      await rename(join(scratch, asset.archiveDir), dir);
      await rm(scratch, { recursive: true, force: true });
    } else {
      await rename(part, join(scratch, asset.file ?? "model"));
      await rm(dir, { recursive: true, force: true });
      await rename(scratch, dir);
    }
    await writeFile(join(dir, ".ok"), new Date().toISOString());
  } finally {
    await rm(part, { force: true });
  }
  onProgress({ phase: "done" });
  log(`installed ${asset.id} → ${dir}`);
}

/** `tar xjf` — bsdtar (macOS, Windows 10+) and GNU tar both do bz2; Node's
 *  zlib has no bzip2. */
function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["xjf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim()}`))));
  });
}
