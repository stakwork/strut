/**
 * The package CACHE (plans/marketplace.md §5): `<dataDir>/packages/sha256-<hex>/`,
 * one directory per digest, written once and never changed. Whatever a
 * resolver produced or an archive brought is kept here by its digest, so a
 * second fetch of the same digest is a no-op, what was installed stays
 * whatever happens upstream (the left-pad rule), and the archive route can
 * serve every package this strut holds — built here, or installed here as a
 * mirror (§9).
 *
 * The invariant: a directory here is a well-formed package whose tree hashes
 * to its name. Every write lands in a scratch directory beside it first, is
 * read and hashed THERE, and is renamed into place only when it matches —
 * never a half-copied tree under a digest, never a source that changed
 * mid-copy.
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unpackArchive } from "./archive.js";
import { PACKAGE_DIGEST, type PackageInfo, readPackage } from "./format.js";
import { resolvePk } from "./pk.js";

export type CachedPackage = PackageInfo & { dir: string };

export class PackageCache {
  /** `<dataDir>/packages`. */
  constructor(readonly root: string) {}

  /** The digest's directory, whether or not it is here. */
  dirOf(digest: string): string {
    if (!PACKAGE_DIGEST.test(digest)) throw new Error(`${JSON.stringify(digest)} is not a digest (sha256:<64 hex>)`);
    return join(this.root, digest.replace(":", "-"));
  }

  /** The package at `digest`, read and hashed again; undefined when it is
   *  not here. A directory whose tree no longer hashes to its name is an
   *  error, never served. */
  async get(digest: string): Promise<CachedPackage | undefined> {
    const dir = this.dirOf(digest);
    if (!(await isDir(dir))) return undefined;
    const info = await readPackage(dir);
    if (info.digest !== digest) throw new Error(`package_cache_corrupt: ${dir} now hashes to ${info.digest}`);
    return { ...info, dir };
  }

  /** Copy the package in `src` in, refusing it when `expected` is given
   *  and it is not that digest. */
  async putDir(src: string, expected?: string): Promise<CachedPackage> {
    const info = await readPackage(src);
    if (expected && info.digest !== expected) throw mismatch(expected, info.digest);
    const have = await this.get(info.digest);
    if (have) return have;
    return this.commit(info.digest, async (scratch) => {
      for (const rel of info.files) {
        const to = join(scratch, ...rel.split("/"));
        await mkdir(dirname(to), { recursive: true });
        await copyFile(join(src, ...rel.split("/")), to);
      }
    });
  }

  /** Unpack an archive in, refusing it unless its tree is `expected`. */
  async putArchive(gz: Buffer, expected: string): Promise<CachedPackage> {
    const have = await this.get(expected);
    if (have) return have;
    return this.commit(expected, (scratch) => unpackArchive(gz, scratch));
  }

  private async commit(expected: string, fill: (scratch: string) => Promise<void>): Promise<CachedPackage> {
    const scratch = join(this.root, ".scratch", randomBytes(8).toString("hex"));
    await mkdir(scratch, { recursive: true });
    try {
      await fill(scratch);
      const info = await readPackage(scratch);
      if (info.digest !== expected) throw mismatch(expected, info.digest);
      const dir = this.dirOf(expected);
      try {
        await rename(scratch, dir);
      } catch (err: any) {
        // Another write of the same digest landed first: the same tree.
        if (err?.code !== "ENOTEMPTY" && err?.code !== "EEXIST") throw err;
      }
      return { ...info, dir };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** The cache under a deployment's data directory. */
export function packageCache(dataDir: string): PackageCache {
  return new PackageCache(join(dataDir, "packages"));
}

function mismatch(expected: string, got: string): Error {
  return new Error(`package_digest_mismatch: expected ${expected}, the tree is ${got}`);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export interface ResolvedPackage extends CachedPackage {
  /** The ref, and for `pk:` the catalog URL it was read from — what an
   *  update starts from (`Upstream.source`). */
  source: { ref: string; url?: string };
  /** The publisher key a `pk:` ref resolved: pinned on the install (§3). */
  key?: string;
}

export interface ResolveOptions {
  cache: PackageCache;
  /** The digest the ref must resolve to (a pin): anything else is refused
   *  and nothing is kept. */
  digest?: string;
  /** What a relative `file:` path is relative to (a distro repo, §12). */
  base?: string;
  /** A `pk:` ref's catalog URL (src/packages/pk.ts). */
  url?: string;
  fetch?: typeof fetch;
}

/**
 * A package REF → its directory in the cache (§5's `resolve`). `file:<path>`
 * (or `file:///…`) copies a directory in; `pk:<key>/<pkg>` reads the key's
 * catalog at `url` and fetches the release by hash (pk.ts); `git+` is a
 * later work item and refuses by name.
 */
export async function resolvePackage(ref: string, opts: ResolveOptions): Promise<ResolvedPackage> {
  if (ref.startsWith("file:")) {
    const path = fileRefPath(ref, opts.base);
    if (!(await isDir(path))) throw new Error(`package_source_invalid: ${ref}: no directory at ${path}`);
    return { ...(await opts.cache.putDir(path, opts.digest)), source: { ref } };
  }
  if (ref.startsWith("pk:")) {
    if (!opts.url) throw new Error(`package_source_invalid: ${ref}: a pk: ref needs url, where the publisher's catalog is served (its strut's /packages/catalog?public=1, or the file it uploaded)`);
    const got = await resolvePk(ref, { cache: opts.cache, url: opts.url, ...(opts.digest ? { digest: opts.digest } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    const { key, url, release: _release, catalog: _catalog, ...info } = got;
    return { ...info, source: { ref, url }, key };
  }
  if (ref.startsWith("git+")) throw new Error(`package_source_unsupported: ${ref}: git+ sources are not built yet — file: and pk: are`);
  throw new Error(`package_source_invalid: ${ref}: a package ref starts with file:, git+ or pk:`);
}

/** The directory a `file:` ref names: an absolute path, or one relative to
 *  `base` (the requiring package's own directory). */
export function fileRefPath(ref: string, base?: string): string {
  const path = ref.startsWith("file://") ? fileURLToPath(ref) : ref.slice("file:".length);
  if (isAbsolute(path)) return path;
  if (!base) throw new Error(`package_source_invalid: ${ref}: a file: ref is an absolute path`);
  return resolve(base, path);
}
