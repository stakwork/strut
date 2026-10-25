/**
 * A package's BYTES between struts (plans/marketplace.md §5, §13): a gzipped
 * ustar of its files (src/tar.ts), fetched BY DIGEST from whichever URL
 * answers — the publishing strut's archive route, a mirror's. The digest is
 * the identity, so the archive is only transport: its bytes are never what
 * is checked, the unpacked tree is (`PackageCache.putArchive`), and any URL
 * that serves the right tree is as good as the publisher's.
 *
 * `fetchArchive` is the last hop of the `pk:` resolver (record → catalog →
 * archive), built first: until the catalog exists, its caller names the URLs.
 */
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

/** The archive route on the strut at `baseUrl` for one package digest. */
export function archiveUrl(baseUrl: string, pkg: string, digest: string): string {
  const [publisher, name] = pkg.split("/") as [string, string];
  return `${baseUrl.replace(/\/+$/, "")}/packages/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/archive?digest=${encodeURIComponent(digest)}`;
}

/** `files` under `dir` as one .tar.gz, in the order given. */
export async function packArchive(dir: string, files: string[]): Promise<Buffer> {
  const entries: [string, Buffer][] = [];
  for (const rel of files) entries.push([rel, await readFile(join(dir, rel))]);
  return promisify(gzip)(tar(entries));
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

/** Unpack a package archive into the empty directory `into`. Throws
 *  `bad_package: …` on an archive that is not one, holds a path that
 *  leaves the directory or the digest, or is too big. */
export async function unpackArchive(gz: Buffer, into: string): Promise<void> {
  let entries: Map<string, Buffer>;
  try {
    entries = untar(await promisify(gunzip)(gz, { maxOutputLength: MAX_UNPACKED_BYTES }));
  } catch (err) {
    throw new Error(`bad_package: not a package archive (.tar.gz): ${err instanceof Error ? err.message : String(err)}`);
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
 *  content-length says, since a server may not send one. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel();
    throw new Error(`the archive is ${declared} bytes, more than ${max}`);
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
      throw new Error(`the archive is more than ${max} bytes`);
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
      return { ...named(await cache.putArchive(await readCapped(res, MAX_ARCHIVE_BYTES), digest)), url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("package_name_mismatch:")) throw err;
      failures.push(`${where}: ${msg}`);
    }
  }
  throw new Error(`package_fetch_failed: ${digest}: ${failures.length ? failures.join("; ") : "no URL to fetch it from"}`);
}
