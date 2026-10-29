/**
 * The `pk:` SOURCE (plans/marketplace.md §5, §13; HTTP-first, 2026-10-28):
 * `pk:<z32 key>/<publisher>/<name>[@sha256:…]` — a package by the KEY that
 * publishes it. The key is the trust; the URL is only where the catalog is
 * served today: the one the install names (`url`: a strut's
 * `GET /packages/catalog?public=1`, or a file a publisher uploaded), later
 * the index row's or the one an install recorded. Later still, the key's
 * Pkarr record is one more place the URL comes from (step 6b); nothing
 * here changes when it lands.
 *
 * A resolve: the catalog fetched from the URL and read as a CARD against
 * the key — the seal, and `seq` against the last catalog accepted from that
 * key (kept under `<dataDir>/packages/index/<key>.json`, so a host that
 * serves an older catalog is caught) — then the release (the pinned digest,
 * which the catalog must list, else the newest not yanked), then its
 * archive by digest from the strut's archive route beside the catalog
 * (`host: self`) and the release's own `urls`, verified against the digest.
 * Every package the release requires that the catalog lists is fetched too,
 * so the install finds them in the cache and never follows a `file:` hint
 * that names the publisher's disk.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { archiveUrl, fetchArchive } from "./archive.js";
import type { CachedPackage, PackageCache } from "./cache.js";
import { Z32_KEY, readCard, releaseFor, type Catalog, type CatalogRelease } from "./card.js";
import { PACKAGE_DIGEST, PACKAGE_NAME } from "./format.js";

export interface PkRef {
  key: string;
  package: string;
  digest?: string;
}

/** `pk:<key>/<publisher>/<name>[@sha256:…]`, or the reason it is not one. */
export function parsePkRef(ref: string): PkRef | string {
  const m = /^pk:([^/@]+)\/([^@]+)(?:@(.+))?$/.exec(ref);
  if (!m) return `${ref} is not pk:<key>/<publisher>/<name>[@sha256:<hex>]`;
  const [, key, pkg, digest] = m as unknown as [string, string, string, string | undefined];
  if (!Z32_KEY.test(key)) return `${ref}: ${key} is not a publisher key in z-base-32 (52 characters)`;
  if (!PACKAGE_NAME.test(pkg)) return `${ref}: ${pkg} is not a package name (publisher/name)`;
  if (digest !== undefined && !PACKAGE_DIGEST.test(digest)) return `${ref}: ${digest} is not a digest (sha256:<64 hex>)`;
  return { key, package: pkg, ...(digest ? { digest } : {}) };
}

export interface PkResolveOptions {
  cache: PackageCache;
  /** Where the publisher's catalog is served: a full URL. */
  url: string;
  /** The digest the ref must resolve to; refused when the catalog does not list it. */
  digest?: string;
  fetch?: typeof fetch;
}

export interface PkResolved extends CachedPackage {
  key: string;
  /** The catalog's URL, as given: what an update starts from. */
  url: string;
  release: CatalogRelease;
  catalog: { seq: number; digest: string };
}

const CATALOG_TIMEOUT_MS = 30_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/** What a reader accepted last from a key: §13's order check across installs. */
async function readKeyState(cache: PackageCache, key: string): Promise<{ seq: number; digest: string } | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(cache.root, "index", `${key}.json`), "utf8")) as { seq?: unknown; digest?: unknown };
    return typeof raw.seq === "number" && typeof raw.digest === "string" ? { seq: raw.seq, digest: raw.digest } : undefined;
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeKeyState(cache: PackageCache, key: string, state: { seq: number; digest: string; url: string }): Promise<void> {
  const dir = join(cache.root, "index");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${key}.${randomBytes(4).toString("hex")}`);
  await writeFile(tmp, JSON.stringify({ ...state, at: new Date().toISOString() }));
  await rename(tmp, join(dir, `${key}.json`));
}

/** The catalog at `url`, read as the key's card. */
export async function fetchCatalog(key: string, url: string, opts: { cache: PackageCache; fetch?: typeof fetch }): Promise<{ card: Catalog; digest: string }> {
  let u: URL;
  try {
    u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not an http(s) URL");
  } catch (err) {
    throw new Error(`package_source_invalid: ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const where = `${u.origin}${u.pathname}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`package_fetch_failed: ${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`package_fetch_failed: ${where} answered ${res.status} for the catalog`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_CATALOG_BYTES) throw new Error(`package_fetch_failed: ${where}: the catalog is over ${MAX_CATALOG_BYTES} bytes`);
  const last = await readKeyState(opts.cache, key);
  const read = readCard(bytes, { key, ...(last ? { last } : {}) });
  if (!last || read.card.seq > last.seq) await writeKeyState(opts.cache, key, { seq: read.card.seq, digest: read.digest, url });
  return read;
}

/** The archive URLs of a release: the strut's archive route beside the
 *  catalog (`host: self`, so the catalog's own query — `public=1` — rides
 *  along), then the release's own `urls`. A catalog that is not a strut's
 *  route (an uploaded file) has no route beside it. */
export function releaseUrls(catalogUrl: string, pkg: string, release: CatalogRelease): string[] {
  const urls: string[] = [];
  const u = new URL(catalogUrl);
  if (u.pathname.endsWith("/packages/catalog")) {
    const base = `${u.origin}${u.pathname.slice(0, -"/packages/catalog".length)}`;
    const query = new URLSearchParams(u.search);
    query.delete("digest");
    const extra = query.toString();
    urls.push(`${archiveUrl(base, pkg, release.digest)}${extra ? `&${extra}` : ""}`);
  }
  urls.push(...(release.urls ?? []));
  return urls;
}

/** Resolve a `pk:` ref: the catalog at `url`, the release, its archive and
 *  the archives of what it requires, into the cache. */
export async function resolvePk(ref: string, opts: PkResolveOptions): Promise<PkResolved> {
  const parsed = parsePkRef(ref);
  if (typeof parsed === "string") throw new Error(`package_source_invalid: ${parsed}`);
  if (opts.digest && parsed.digest && opts.digest !== parsed.digest) {
    throw new Error(`package_source_invalid: ${ref} pins ${parsed.digest}, and the install asks for ${opts.digest}`);
  }
  const pin = opts.digest ?? parsed.digest;
  const { card, digest: catalogDigest } = await fetchCatalog(parsed.key, opts.url, opts);
  const entry = card.packages[parsed.package];
  if (!entry) throw new Error(`package_not_published: ${parsed.key}'s catalog at ${opts.url.split("?")[0]} lists no package ${parsed.package}`);
  const release = pin ? entry.releases.find((r) => r.digest === pin) : releaseFor(card, parsed.package);
  if (!release) {
    throw new Error(pin
      ? `package_not_published: ${parsed.key}'s catalog lists no release of ${parsed.package} at ${pin}`
      : `package_not_published: every release of ${parsed.package} in ${parsed.key}'s catalog is yanked`);
  }
  const doFetch = opts.fetch ?? fetch;
  const got = await fetchArchive({ urls: releaseUrls(opts.url, parsed.package, release), digest: release.digest, cache: opts.cache, package: parsed.package, fetch: doFetch });
  // What it requires and the catalog lists, so the install finds it cached.
  const queue = [...(got.manifest.requires?.packages ?? [])];
  const seen = new Set<string>([release.digest]);
  while (queue.length) {
    const req = queue.shift()!;
    if (seen.has(req.digest)) continue;
    seen.add(req.digest);
    const listed = card.packages[req.package]?.releases.find((r) => r.digest === req.digest);
    if (!listed) continue;
    const dep = await fetchArchive({ urls: releaseUrls(opts.url, req.package, listed), digest: req.digest, cache: opts.cache, package: req.package, fetch: doFetch });
    queue.push(...(dep.manifest.requires?.packages ?? []));
  }
  return { ...got, key: parsed.key, url: opts.url, release, catalog: { seq: card.seq, digest: catalogDigest } };
}
