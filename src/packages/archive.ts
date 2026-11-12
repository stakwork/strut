/**
 * A package's BYTES between struts (plans/marketplace.md §5, §13): a ustar
 * of its files in one pinned layout (`packTar`) — plain, the PLAIN TAR every
 * strut writes identically from its cache and the bytes a package's torrent
 * hashes (./torrent.ts), or gzipped, what a strut from before
 * `format=tar` serves and reads (src/tar.ts; a name ustar cannot hold — a Concept
 * page's long node key — in a PAX header), fetched BY DIGEST from whichever URL
 * answers — the publishing strut's archive route, a mirror's. The digest is
 * the identity, so the archive is only transport: its bytes are never what
 * is checked, the unpacked tree is (`PackageCache.putArchive`), and any URL
 * that serves the right tree is as good as the publisher's.
 *
 * `fetchArchive` is the last hop of the `pk:` resolver (record → catalog →
 * archive), built first: until the catalog exists, its caller names the URLs.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { tar, untar } from "../tar.js";
import type { PackageCache, CachedPackage } from "./cache.js";
import { PACKAGE_DIGEST, packageExcluded } from "./format.js";

/** The most an archive may be on the wire, and unpack to. Packages are
 *  kilobytes to a few megabytes; an app's `public/` is what grows one. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 10_000;
const FETCH_TIMEOUT_MS = 60_000;

/** The archive route on the strut at `baseUrl` for one package digest, as
 *  its plain tar (`format=tar`). A strut from before the plain tar ignores
 *  the parameter and answers the .tar.gz, which `unpackArchive` reads too. */
export function archiveUrl(baseUrl: string, pkg: string, digest: string): string {
  const [publisher, name] = pkg.split("/") as [string, string];
  return `${baseUrl.replace(/\/+$/, "")}/packages/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/archive?digest=${encodeURIComponent(digest)}&format=tar`;
}

/**
 * THE PLAIN TAR of a package (plans/marketplace.md §13, ruled 2026-11-11):
 * `files` under `dir` in the digest's order — sorted as JavaScript sorts
 * strings, which is `readPackage`'s order and `hashTree`'s — each written by
 * `src/tar.ts` (a regular file, mode 0600, owner 0, time 0; a name ustar
 * cannot hold in a PAX `path=` header and nothing else in one), then the two
 * zero blocks. A contract, pinned by a test vector: every strut that holds a
 * package writes these same bytes, so all of them seed one torrent. A change
 * here is a new format, never an edit.
 */
export async function packTar(dir: string, files: string[]): Promise<Buffer> {
  const entries: [string, Buffer][] = [];
  for (const rel of [...files].sort()) entries.push([rel, await readFile(join(dir, rel))]);
  return tar(entries);
}

/** The plain tar gzipped: the archive route's answer with no `format`, for
 *  a strut from before the plain tar. Its bytes are not fixed (zlib's and
 *  the gzip header's vary by host), and never what anything is checked by. */
export async function packArchive(dir: string, files: string[]): Promise<Buffer> {
  return promisify(gzip)(await packTar(dir, files));
}

/** Whether `bytes` are gzipped (the magic `1f 8b`) rather than a plain tar. */
export function isGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Why the package in `dir` (its `files`, as `readPackage` lists them) could
 * not travel, if it could not: packed as the archive route packs it, then
 * read back as `unpackArchive` reads it — its caps, its path checks, the
 * same files. A build asks first, so the cache never keeps a package its
 * archive route cannot serve or no strut could unpack.
 */
export async function archiveProblem(dir: string, files: string[]): Promise<string | undefined> {
  if (files.length > MAX_ARCHIVE_FILES) return `it holds ${files.length} files, more than the ${MAX_ARCHIVE_FILES} a package archive may`;
  let plain: Buffer;
  try {
    plain = await packTar(dir, files);
  } catch (err) {
    return `it cannot be packed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (plain.length > MAX_UNPACKED_BYTES) return `its archive unpacks to ${plain.length} bytes, more than the ${MAX_UNPACKED_BYTES} a strut unpacks`;
  const gz = await promisify(gzip)(plain);
  if (gz.length > MAX_ARCHIVE_BYTES) return `its archive is ${gz.length} bytes, more than the ${MAX_ARCHIVE_BYTES} a strut fetches`;
  let back: Map<string, Buffer>;
  try {
    back = untar(plain);
  } catch (err) {
    return `its archive does not read back: ${err instanceof Error ? err.message : String(err)}`;
  }
  const names = [...back.keys()];
  for (const name of names) {
    const problem = entryProblem(name);
    if (problem) return `its archive's ${JSON.stringify(name)} ${problem}`;
  }
  const sorted = [...files].sort();
  if (names.length !== files.length || names.some((n, i) => n !== sorted[i])) return "its archive does not read back as the same files";
  return undefined;
}

/** Why `name` may not come out of a package archive, if it may not: a path
 *  that leaves the directory, or one the digest never covers (a dotfile, an
 *  app's `dist/`) — so the unpacked tree is exactly what the digest hashes. */
function entryProblem(name: string): string | undefined {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return "is not a relative path";
  const segments = name.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!seg || seg === "." || seg === "..") return "is not a relative path";
    if (packageExcluded(segments.slice(0, i + 1).join("/"), seg)) return "is a path a package digest never covers";
  }
  return undefined;
}

/** Unpack a package archive — the plain tar, or the .tar.gz a strut from
 *  before it serves — into the empty directory `into`. Throws
 *  `bad_package: …` on an archive that is not one, holds a path that
 *  leaves the directory or the digest, or is too big. */
export async function unpackArchive(archive: Buffer, into: string): Promise<void> {
  let entries: Map<string, Buffer>;
  try {
    if (!isGzip(archive) && archive.length > MAX_UNPACKED_BYTES) throw new Error(`it is ${archive.length} bytes, more than ${MAX_UNPACKED_BYTES}`);
    entries = untar(isGzip(archive) ? await promisify(gunzip)(archive, { maxOutputLength: MAX_UNPACKED_BYTES }) : archive);
  } catch (err) {
    throw new Error(`bad_package: not a package archive (.tar or .tar.gz): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (entries.size > MAX_ARCHIVE_FILES) throw new Error(`bad_package: the archive holds ${entries.size} files, more than ${MAX_ARCHIVE_FILES}`);
  for (const name of entries.keys()) {
    const problem = entryProblem(name);
    if (problem) throw new Error(`bad_package: the archive's ${JSON.stringify(name)} ${problem}`);
  }
  for (const [name, bytes] of entries) {
    const path = join(into, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }
}

/** A response body as bytes, refused past `max` — whatever its
 *  content-length says, since a server may not send one. Nothing past the
 *  cap is kept: the read stops there. */
export async function readCapped(res: Response, max: number, what = "archive"): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel();
    throw new Error(`the ${what} is ${declared} bytes, more than ${max}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`the ${what} is more than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface FetchArchiveOptions {
  /** Where to fetch it, tried in order until one serves the right tree. */
  urls: string[];
  digest: string;
  cache: PackageCache;
  /** The package the caller expects at that digest (a catalog's row): a
   *  tree with another `package:` is refused. */
  package?: string;
  /** Sent with every request: the credential the serving strut's gate
   *  wants (its key, today; a package token when selling). */
  headers?: Record<string, string>;
  /** The plain tar's sha256 the catalog names (`CatalogRelease.tar`): a
   *  plain tar that is not it is refused before it is unpacked. A .tar.gz
   *  (an older strut's answer) is checked by its tree alone. */
  tarSha256?: string;
  fetch?: typeof fetch;
}

/**
 * The package at `digest`, from the cache when it is there, else fetched
 * from the first of `urls` whose archive unpacks to that digest — a URL
 * that fails, answers an error or serves another tree is passed over, and
 * when none serves it the error names each. A URL's query never appears in
 * an error: it may carry a token.
 */
export async function fetchArchive(opts: FetchArchiveOptions): Promise<CachedPackage & { url?: string }> {
  const { digest, cache } = opts;
  if (!PACKAGE_DIGEST.test(digest)) throw new Error(`package_fetch_failed: ${JSON.stringify(digest)} is not a digest (sha256:<64 hex>)`);
  const named = (info: CachedPackage) => {
    if (opts.package && info.manifest.package !== opts.package) {
      throw new Error(`package_name_mismatch: ${digest} is the package ${info.manifest.package}, not ${opts.package}`);
    }
    return info;
  };
  const cached = await cache.get(digest);
  if (cached) return named(cached);
  const doFetch = opts.fetch ?? fetch;
  const failures: string[] = [];
  for (const url of opts.urls) {
    let where = url.split("?")[0]!;
    try {
      const u = new URL(url);
      where = `${u.origin}${u.pathname}`;
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not an http(s) URL");
      const res = await doFetch(url, { headers: opts.headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      // A plain tar is at most what a strut unpacks; a .tar.gz at most what
      // a strut fetches.
      const bytes = await readCapped(res, MAX_UNPACKED_BYTES);
      if (isGzip(bytes)) {
        if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`the archive is ${bytes.length} bytes, more than ${MAX_ARCHIVE_BYTES}`);
      } else if (opts.tarSha256) {
        const got = createHash("sha256").update(bytes).digest("hex");
        if (got !== opts.tarSha256) throw new Error(`its tar is sha256 ${got}, not the ${opts.tarSha256} the catalog names`);
      }
      return { ...named(await cache.putArchive(bytes, digest)), url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("package_name_mismatch:")) throw err;
      failures.push(`${where}: ${msg}`);
    }
  }
  throw new Error(`package_fetch_failed: ${digest}: ${failures.length ? failures.join("; ") : "no URL to fetch it from"}`);
}
