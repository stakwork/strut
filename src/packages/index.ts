/**
 * The package INDEX (plans/marketplace.md §7, step 7; HTTP-first,
 * 2026-10-28): this strut as the phone book — a signed card of PUBLISHER
 * rows (prefix → key, where its public catalog is served) that is the trust
 * root for names — and the crawler behind it: the index strut FOLLOWS every
 * listed publisher's public catalog, verified against the row's key, and
 * serves search and package pages over them. The npm experience with no
 * accounts, no upload door and no bytes it alone holds: everything here is
 * derived, and an install re-verifies against the publisher's own catalog.
 *
 * The index key lives in `publisher.json` beside the publisher's keys
 * (`INDEX`), minted at the first row. The sealed index cards live under
 * `<dataDir>/packages/catalogs/index/` as a publisher's do; the crawl's
 * state — each publisher's last accepted public catalog, or what stopped
 * the read — under `catalogs/index/crawl/`. A publisher's own catalog is
 * read through pk.ts's `fetchCatalog`, so the per-key `seq` rule holds here
 * as on any strut.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { searchSteps } from "../search.js";
import type { SecretStore } from "../secret-store.js";
import { fetchArchive } from "./archive.js";
import type { PackageCache } from "./cache.js";
import { CARD_VERSION, PUBLISHER_PREFIX, Z32_KEY, canonicalJson, keyFromSeed, releaseFor, sealCard, type Catalog, type CatalogRelease, type IndexCatalog, type IndexLiveRow, type IndexRow, type UnsignedIndexCatalog } from "./card.js";
export type { IndexLiveRow, IndexRow } from "./card.js";
import { derivePackageDetail, summarizeDetail, type ConceptDetail, type DetailSummary, type PackageDetail, type StepFacts } from "./detail.js";
export type { AppDetail, ConceptDetail, DetailSummary, PackageCan, PackageDetail, StepDetail, WorkflowDetail } from "./detail.js";
import { fetchCatalog, releaseUrls } from "./pk.js";
import { CatalogStore, type CatalogFile } from "./publisher.js";

const KEY_NAME = "INDEX";

export interface IndexInfo {
  /** The index key, z-base-32: what a strut subscribes to (`STRUT_PACKAGE_INDEXES`). */
  key: string;
  createdAt: string;
  /** Where this index's catalog is served, as the card says. */
  urls: string[];
  /** The rows, as the current card has them. */
  publishers: Record<string, IndexRow>;
  /** The crawl: each listed publisher's catalog as last read. */
  crawled: CrawlState[];
  /** The LIVE rows (plans/public-surface.md §8): where each server's public view is. */
  live: Record<string, IndexLiveRow>;
  /** Each live row's public view as last read. */
  liveCrawled: LiveStateBrief[];
}

/** A publisher server's public view as the crawl last read it
 *  (`<url>/public`, `<url>/public/concepts`; plans/public-surface.md §8). */
export interface LiveState {
  prefix: string;
  url: string;
  checkedAt: string;
  /** When the listing below was read. */
  readAt?: string;
  listing?: LiveListing;
  concepts?: Array<{ name: string; description?: string; parent?: string; root: string }>;
  /** What stopped the last read (the listing kept is the one before). */
  error?: string;
}
export type LiveStateBrief = Omit<LiveState, "listing" | "concepts"> & { apps?: number; workflows?: number; steps?: number; concepts?: number; runnable?: number };

/** `GET <url>/public`, as the index keeps it (src/public-routes.ts). */
export interface LiveListing {
  workflows: Array<{ name: string; description?: string; category?: string; runs?: boolean; activeVersion?: string }>;
  steps: Array<{ type: string; description?: string; effect?: string }>;
  concepts: Array<{ name: string; description?: string; pages?: number }>;
  apps: Array<{ name: string; version: string; title: string; description?: string; icon?: string }>;
  /** What anyone may RUN there, and for how much (plans/paid-runs.md §2,
   *  decision 25), as the crawl read it — absent from a view read before. */
  runnable?: LiveRunnable[];
}

/** One item a publisher's server lets anyone run, as the index keeps it:
 *  its price, the credit a run needs to start, and what recent runs were
 *  charged — read off a stranger's server, so every field is checked
 *  (`liveRunnableOf`). The input is read from the publisher when it is run. */
export interface LiveRunnable {
  kind: "workflow" | "step";
  name: string;
  description?: string;
  /** Dollars a run or call. */
  base: number;
  /** Times what the run cost. */
  markup: number;
  /** The most one run may spend, in dollars; null when the item sets none. */
  capUsd: number | null;
  /** The credit a run needs to start, in dollars. */
  reserve: number;
  results: "output" | "run";
  recent?: { days: number; runs: number; average: number };
}

/** The most runnable items the index keeps of one server's view. */
export const LIVE_RUNNABLE_MAX = 500;
const LIVE_TEXT_MAX = 2000;

/** `GET <url>/public`'s `runnable`, checked: only items with a kind, a
 *  name and prices that are numbers the index can show; strings cut. A
 *  server's answer is a stranger's, never trusted as it came. */
export function liveRunnableOf(raw: unknown): LiveRunnable[] {
  if (!Array.isArray(raw)) return [];
  const money = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : undefined);
  const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
  const out: LiveRunnable[] = [];
  for (const r of raw.slice(0, LIVE_RUNNABLE_MAX)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = o["kind"] === "workflow" || o["kind"] === "step" ? o["kind"] : undefined;
    const name = text(o["name"], 300);
    const base = money(o["base"] ?? 0);
    const markup = money(o["markup"] ?? 0);
    const reserve = money(o["reserve"] ?? 0);
    const cap = o["capUsd"] === null || o["capUsd"] === undefined ? null : money(o["capUsd"]);
    if (!kind || !name || base === undefined || markup === undefined || reserve === undefined || cap === undefined) continue;
    const description = text(o["description"], LIVE_TEXT_MAX);
    const rec = o["recent"] as Record<string, unknown> | undefined;
    const days = money(rec?.["days"]);
    const runs = money(rec?.["runs"]);
    const average = money(rec?.["average"]);
    out.push({
      kind,
      name,
      ...(description ? { description } : {}),
      base,
      markup,
      capUsd: cap,
      reserve,
      results: o["results"] === "run" ? "run" : "output",
      ...(days !== undefined && runs !== undefined && average !== undefined ? { recent: { days, runs: Math.floor(runs), average } } : {}),
    });
  }
  return out;
}

/** One item a publisher's public view shows, as the store lists it. */
export interface IndexLiveItem {
  publisher: string;
  /** The publisher server's base: `<url>/public/...` is where to read it. */
  url: string;
  kind: "app" | "workflow" | "step" | "concept";
  name: string;
  title?: string;
  description?: string;
  /** An app's version; a workflow's runs being public; a Concept root's page count. */
  version?: string;
  runs?: boolean;
  pages?: number;
  /** Anyone may run it there (plans/paid-runs.md §10): its price, as the
   *  crawl read it. */
  run?: Omit<LiveRunnable, "kind" | "name" | "description">;
  /** Runnable, and its definition is NOT in the public view: the store reads
   *  its price and input from the server's `/public` listing alone. */
  definition?: false;
}

export interface CrawlState {
  prefix: string;
  key: string;
  /** The last public catalog accepted from the row's key, and which URL served it. */
  accepted?: { seq: number; digest: string; at: string; url: string };
  checkedAt?: string;
  /** What stopped the last read. */
  error?: string;
  /** How many packages the accepted catalog lists. */
  packages?: number;
  /** How many of them have a page derived from their archive (./detail.ts). */
  derived?: number;
}

/** One search hit: a package's newest public release, with where to get it. */
export interface IndexHit {
  package: string;
  publisher: string;
  key: string;
  urls: string[];
  version: string;
  digest: string;
  description?: string;
  license?: string;
  requires?: CatalogRelease["requires"];
  /** What the release holds — the apps' faces and the counts — once its
   *  archive has been read (./detail.ts). */
  detail?: DetailSummary;
}

/** A package's page: its releases newest first and the public channels that hold them. */
export interface IndexPackage {
  package: string;
  publisher: string;
  key: string;
  urls: string[];
  description?: string;
  releases: CatalogRelease[];
  channels: Record<string, string>;
  /** When the catalog this comes from was read. */
  readAt: string;
  /** The newest release not yanked, read off its archive (./detail.ts). */
  detail?: PackageDetail;
  /** Why it has no `detail`: the archive could not be fetched or read. */
  detailError?: string;
}

/** A package's page without its Concept pages' text: what a reader that
 *  draws the tree from names needs (the store, `?docs=0`; a model's brief
 *  page). One page's docs are `concept(name)`'s. */
export function withoutConceptDocs<T extends { detail?: PackageDetail }>(page: T): Omit<T, "detail"> & { detail?: Omit<PackageDetail, "concepts"> & { concepts: Array<Omit<ConceptDetail, "docs">> } } {
  const { detail, ...rest } = page;
  return detail ? { ...rest, detail: { ...detail, concepts: detail.concepts.map(({ docs: _docs, ...c }) => c) } } : rest;
}

/** One Concept page as the index knows it: across every crawled package. */
export interface IndexConcept {
  name: string;
  description?: string;
  /** Every parent, by name. */
  parents?: string[];
  /** The packages that carry a page of this name, newest release each. */
  packages: Array<{ package: string; version: string }>;
  /** The publisher servers whose public view holds a page of this name,
   *  live (plans/public-surface.md §8): its docs are read from there. */
  live?: Array<{ publisher: string; url: string }>;
}

export interface IndexConceptPage extends Omit<IndexConcept, "parents"> {
  docs?: string;
  /** The pages that name this one among their parents. */
  children: Array<{ name: string; description?: string }>;
  /** The page's ancestors, nearest first, through each one's first parent,
   *  as far as the index knows them. */
  parents: Array<{ name: string; description?: string }>;
}

/** A page's parents: a derived page's `parents`, or the one `parent` a
 *  page derived before the new page form kept, or a live view's tree has. */
const parentsOf = (c: { parents?: string[]; parent?: string }): string[] => c.parents ?? (c.parent ? [c.parent] : []);

/** The derived page of one package, as kept on disk: `detail` or the error. */
interface PageFile {
  package: string;
  digest: string;
  version: string;
  derivedAt: string;
  detail?: PackageDetail;
  error?: string;
}

export interface IndexDeps {
  /** The encrypted store the index key is kept in (the publisher's file). */
  secrets: SecretStore;
  /** `<dataDir>/packages/catalogs/index`. */
  dir: string;
  cache: PackageCache;
  /** Where this index's catalog is served, written into every card. */
  urls?: string[];
  /** Why this strut may not mint (its secret store is only obfuscated), or nothing. */
  unsafe?: () => string | undefined;
  /** This strut's registry, for a derived page's flags (./detail.ts). */
  stepInfo?: (type: string) => StepFacts | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PackageIndex {
  /** The index as it is; undefined before its key is minted. */
  info(): Promise<IndexInfo | undefined>;
  /** Add or change a row (the key minted first when there is none), re-seal the card, and read that publisher now —
   *  or, with `crawl: false`, at the caller's call (`crawl({ prefix })`). */
  setRow(prefix: string, row: IndexRow, opts?: { crawl?: boolean }): Promise<IndexInfo>;
  /** Drop a row and re-seal; the crawl's state for it goes. */
  removeRow(prefix: string): Promise<boolean>;
  /** The current sealed card, or one by digest. */
  catalog(digest?: string): Promise<CatalogFile | undefined>;
  /** Read every listed publisher's public catalog — or the rows whose key is `key`. */
  crawl(filter?: { key?: string; prefix?: string }): Promise<CrawlState[]>;
  /** Packages across every crawled catalog, every word of `q` in the name or description; all of them with no query. */
  search(q: string, limit?: number): Promise<IndexHit[]>;
  /** One package's page, or undefined when no listed publisher's catalog has it. */
  package(name: string): Promise<IndexPackage | undefined>;
  /** Every Concept page across the crawled packages (every word of `q` in the name or description). */
  concepts(q?: string): Promise<IndexConcept[]>;
  /** One Concept page with its docs, children and parents; undefined when no package carries it. */
  concept(name: string): Promise<IndexConceptPage | undefined>;
  /** Add or change a LIVE row (the key minted first when there is none), re-seal the card, and read that view now
   *  (with `crawl: false`, at the next crawl of its prefix). */
  setLive(prefix: string, row: IndexLiveRow, opts?: { crawl?: boolean }): Promise<IndexInfo>;
  /** Drop a live row and re-seal; its crawl state goes. */
  removeLive(prefix: string): Promise<boolean>;
  /** The items the live rows' public views show (every word of `q` in the name, title, description or publisher). */
  live(q?: string): Promise<IndexLiveItem[]>;
}

interface IndexRecord {
  key: string;
  seed: string;
  createdAt: string;
}

/** A row as a person writes it, checked, or the reason it is not one. */
export function indexRowProblem(prefix: unknown, row: unknown): string | undefined {
  if (typeof prefix !== "string" || !PUBLISHER_PREFIX.test(prefix)) return "the prefix is a publisher's: [a-z][a-z0-9-]*, at most 64 characters";
  const r = row as Partial<IndexRow> | undefined;
  if (!r || typeof r !== "object") return "a row is { key, urls, description?, url? }";
  if (typeof r.key !== "string" || !Z32_KEY.test(r.key)) return "key is the publisher's PUBLIC key in z-base-32 (52 characters)";
  if (!Array.isArray(r.urls) || r.urls.length === 0 || !r.urls.every((u) => typeof u === "string" && /^https?:\/\/\S+$/.test(u))) {
    return "urls is a non-empty list of http(s) URLs where the publisher's public catalog is served";
  }
  if (r.description !== undefined && typeof r.description !== "string") return "description is a string";
  if (r.url !== undefined && (typeof r.url !== "string" || !/^https?:\/\/\S+$/.test(r.url))) return "url is a homepage, an http(s) URL";
  return undefined;
}

/** A live row as a person writes it, checked, or the reason it is not one. */
export function liveRowProblem(prefix: unknown, row: unknown): string | undefined {
  if (typeof prefix !== "string" || !PUBLISHER_PREFIX.test(prefix)) return "the prefix is a publisher's: [a-z][a-z0-9-]*, at most 64 characters";
  const r = row as Partial<IndexLiveRow> | undefined;
  if (!r || typeof r !== "object") return "a live row is { url, description? }";
  if (Object.keys(r).some((k) => k !== "url" && k !== "description")) return "a live row is { url, description? }";
  if (typeof r.url !== "string" || !/^https?:\/\/[^\s?#]+$/.test(r.url)) return "url is the server's base, an http(s) URL with no query (https://<swarm>:3355/lab)";
  if (r.description !== undefined && typeof r.description !== "string") return "description is a string";
  return undefined;
}

/** How long one read of a live view may take. */
const LIVE_TIMEOUT_MS = 15_000;

/** Whether a package's name is under a publisher's prefix. A catalog may
 *  list any name its key signs; the index lists only what the row's prefix
 *  covers, since the row is what binds a prefix to a key. */
function underPrefix(prefix: string, pkg: string): boolean {
  return pkg.startsWith(`${prefix}/`);
}

export function createPackageIndex(deps: IndexDeps): PackageIndex {
  const cards = new CatalogStore(deps.dir);
  const crawlDir = join(deps.dir, "crawl");
  const stateFile = (prefix: string) => join(crawlDir, `${prefix}.json`);
  const cardFile = (prefix: string) => join(crawlDir, `${prefix}.catalog.json`);
  // The derived pages (./detail.ts), one file per package under its
  // prefix's folder — apart from the state files `crawledPrefixes` lists.
  const pagesDir = (prefix: string) => join(crawlDir, "pages", prefix);
  const pageFile = (prefix: string, name: string) => join(pagesDir(prefix), `${name.slice(prefix.length + 1)}.json`);
  // A live row's view, apart from the catalog state files.
  const liveDir = join(crawlDir, "live");
  const liveFile = (prefix: string) => join(liveDir, `${prefix}.json`);

  const read = async (): Promise<IndexRecord | undefined> => {
    const raw = await deps.secrets.get(KEY_NAME);
    return raw ? (JSON.parse(raw) as IndexRecord) : undefined;
  };
  let minting: Promise<IndexRecord> | undefined;
  const ensure = async (): Promise<IndexRecord> => {
    const have = await read();
    if (have) return have;
    const why = deps.unsafe?.();
    if (why) throw new Error(`publisher_unsafe_key: ${why}`);
    minting ??= (async () => {
      const seed = randomBytes(32);
      const record: IndexRecord = { key: keyFromSeed(seed).key, createdAt: new Date().toISOString(), seed: seed.toString("hex") };
      await deps.secrets.set(KEY_NAME, JSON.stringify(record));
      return record;
    })().finally(() => {
      minting = undefined;
    });
    return minting;
  };

  const base = async (): Promise<Omit<UnsignedIndexCatalog, "key">> => {
    const cur = await cards.current();
    if (!cur) return { v: CARD_VERSION, seq: 0, publishers: {} };
    const { sig: _sig, key: _key, ...rest } = structuredClone(cur.card as unknown as IndexCatalog);
    return rest;
  };
  const seal = async (card: Omit<UnsignedIndexCatalog, "key">): Promise<CatalogFile> => {
    const record = await ensure();
    const { privateKey, key } = keyFromSeed(Buffer.from(record.seed, "hex"));
    const now = Math.floor((deps.now?.() ?? Date.now()) * 1000);
    const next: UnsignedIndexCatalog = { ...card, v: CARD_VERSION, key, seq: Math.max(now, card.seq + 1), ...(deps.urls?.length ? { urls: deps.urls } : {}) };
    if (!deps.urls?.length) delete next.urls;
    return cards.put(sealCard(next, privateKey, "index") as unknown as Catalog);
  };

  // ── the crawl ──────────────────────────────────────────────────────────
  const readState = async (prefix: string): Promise<CrawlState | undefined> => {
    try {
      return JSON.parse(await readFile(stateFile(prefix), "utf8")) as CrawlState;
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
  };
  const writeFileAtomic = async (file: string, text: string | Buffer) => {
    await mkdir(crawlDir, { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, text);
    await rename(tmp, file);
  };
  /** The accepted catalog of a prefix, from its file. */
  const cardOf = async (prefix: string): Promise<Catalog | undefined> => {
    try {
      return JSON.parse(await readFile(cardFile(prefix), "utf8")) as Catalog;
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
  };
  const readPage = async (prefix: string, name: string): Promise<PageFile | undefined> => {
    try {
      const page = JSON.parse(await readFile(pageFile(prefix, name), "utf8")) as PageFile;
      // A page derived before the new Concept page form kept one `parent`.
      for (const c of page.detail?.concepts ?? []) {
        const parents = parentsOf(c);
        delete (c as { parent?: string }).parent;
        if (parents.length) c.parents = parents;
      }
      return page;
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
  };
  /** The page of every package under the prefix at its newest release not
   *  yanked: the archive fetched by digest from the route beside the catalog
   *  (then the release's own `urls`) into the cache — the mirror §7 allows —
   *  and read into its detail. One at a time; a page already derived for
   *  that digest is kept; a fetch that fails is recorded on the page and
   *  tried again at the next crawl. Never the catalog's acceptance: a
   *  publisher whose archives are slow is still listed. */
  const derivePages = async (prefix: string, card: Catalog, url: string): Promise<number> => {
    let derived = 0;
    for (const pkg of Object.keys(card.packages).sort()) {
      if (!underPrefix(prefix, pkg)) continue;
      const release = releaseFor(card, pkg);
      if (!release) continue;
      const have = await readPage(prefix, pkg);
      if (have?.digest === release.digest && have.detail) {
        derived++;
        continue;
      }
      const page: PageFile = { package: pkg, digest: release.digest, version: release.version, derivedAt: new Date().toISOString() };
      try {
        const info = await fetchArchive({ urls: releaseUrls(url, pkg, release), digest: release.digest, cache: deps.cache, package: pkg, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
        page.detail = await derivePackageDetail(info, { ...(deps.stepInfo ? { stepInfo: deps.stepInfo } : {}) });
        derived++;
      } catch (err) {
        page.error = (err instanceof Error ? err.message : String(err)).replace(/\?[^\s;]*/g, "");
      }
      await mkdir(pagesDir(prefix), { recursive: true });
      await writeFileAtomic(pageFile(prefix, pkg), JSON.stringify(page));
    }
    return derived;
  };
  const crawlOne = async (prefix: string, row: IndexRow): Promise<CrawlState> => {
    const prev = await readState(prefix);
    const at = new Date().toISOString();
    const state: CrawlState = { prefix, key: row.key, ...(prev?.key === row.key && prev.accepted ? { accepted: prev.accepted, packages: prev.packages, ...(prev.derived !== undefined ? { derived: prev.derived } : {}) } : {}), checkedAt: at };
    const failures: string[] = [];
    for (const url of row.urls) {
      try {
        const { card, digest } = await fetchCatalog(row.key, url, { cache: deps.cache, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
        if (state.accepted?.digest !== digest) await writeFileAtomic(cardFile(prefix), canonicalJson(card));
        state.accepted = { seq: card.seq, digest, at, url };
        state.packages = Object.keys(card.packages).filter((pkg) => underPrefix(prefix, pkg)).length;
        delete state.error;
        await writeFileAtomic(stateFile(prefix), JSON.stringify(state));
        state.derived = await derivePages(prefix, card, url);
        await writeFileAtomic(stateFile(prefix), JSON.stringify(state));
        return state;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A rollback or a conflict is the key's word against this host: say so, try the next.
        failures.push(`${url.split("?")[0]}: ${msg}`);
      }
    }
    state.error = failures.join("; ");
    await writeFileAtomic(stateFile(prefix), JSON.stringify(state));
    return state;
  };
  const readLive = async (prefix: string): Promise<LiveState | undefined> => {
    try {
      return JSON.parse(await readFile(liveFile(prefix), "utf8")) as LiveState;
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
  };
  /** Read a live row's public view: the listing and the Concept trees, as
   *  anyone reads them (no credential). A failure keeps the view read
   *  before and says why. */
  const crawlLiveOne = async (prefix: string, row: IndexLiveRow): Promise<LiveState> => {
    const prev = await readLive(prefix);
    const base = row.url.replace(/\/+$/, "");
    const state: LiveState = { prefix, url: base, checkedAt: new Date().toISOString(), ...(prev?.url === base && prev.listing ? { readAt: prev.readAt, listing: prev.listing, concepts: prev.concepts } : {}) };
    const get = async (path: string): Promise<unknown> => {
      const res = await (deps.fetch ?? fetch)(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`${path}: ${res.status} ${res.statusText}`);
      }
      return res.json();
    };
    try {
      const listing = (await get("/public")) as Partial<LiveListing>;
      const tree = listing.concepts?.length ? ((await get("/public/concepts")) as { concepts?: LiveState["concepts"] }).concepts ?? [] : [];
      const runnable = liveRunnableOf((listing as { runnable?: unknown }).runnable);
      state.listing = { workflows: listing.workflows ?? [], steps: listing.steps ?? [], concepts: listing.concepts ?? [], apps: listing.apps ?? [], ...(runnable.length ? { runnable } : {}) };
      state.concepts = tree.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.parent ? { parent: c.parent } : {}), root: c.root }));
      state.readAt = state.checkedAt;
      delete state.error;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    await mkdir(liveDir, { recursive: true });
    const tmp = `${liveFile(prefix)}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, liveFile(prefix));
    return state;
  };
  const liveInFlight = new Map<string, Promise<LiveState>>();
  const crawlLive = (prefix: string, row: IndexLiveRow): Promise<LiveState> => {
    const running = liveInFlight.get(prefix);
    if (running) return running;
    const p = crawlLiveOne(prefix, row).finally(() => liveInFlight.delete(prefix));
    liveInFlight.set(prefix, p);
    return p;
  };
  const liveRows = async (): Promise<Record<string, IndexLiveRow>> => ((await cards.current())?.card as unknown as IndexCatalog | undefined)?.live ?? {};
  const liveStates = async (): Promise<LiveState[]> => {
    const out: LiveState[] = [];
    for (const [prefix, row] of Object.entries(await liveRows())) out.push((await readLive(prefix)) ?? { prefix, url: row.url, checkedAt: "" });
    return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
  };
  const briefOf = ({ listing, concepts, ...rest }: LiveState): LiveStateBrief => ({
    ...rest,
    ...(listing ? { apps: listing.apps.length, workflows: listing.workflows.length, steps: listing.steps.length, ...(listing.runnable?.length ? { runnable: listing.runnable.length } : {}) } : {}),
    ...(concepts ? { concepts: concepts.length } : {}),
  });

  // One crawl of a prefix at a time; a second call joins it.
  const inFlight = new Map<string, Promise<CrawlState>>();
  const crawlPrefix = (prefix: string, row: IndexRow): Promise<CrawlState> => {
    const running = inFlight.get(prefix);
    if (running) return running;
    const p = crawlOne(prefix, row).finally(() => inFlight.delete(prefix));
    inFlight.set(prefix, p);
    return p;
  };

  const rows = async (): Promise<Record<string, IndexRow>> => ((await cards.current())?.card as unknown as IndexCatalog | undefined)?.publishers ?? {};
  const states = async (publishers: Record<string, IndexRow>): Promise<CrawlState[]> =>
    (await Promise.all(Object.entries(publishers).map(async ([prefix, row]) => (await readState(prefix)) ?? { prefix, key: row.key }))).sort((a, b) => a.prefix.localeCompare(b.prefix));

  const info = async (): Promise<IndexInfo | undefined> => {
    const record = await read();
    if (!record) return undefined;
    const cur = (await cards.current())?.card as unknown as IndexCatalog | undefined;
    const publishers = cur?.publishers ?? {};
    return {
      key: record.key,
      createdAt: record.createdAt,
      urls: cur?.urls ?? deps.urls ?? [],
      publishers,
      crawled: await states(publishers),
      live: cur?.live ?? {},
      liveCrawled: (await liveStates()).map(briefOf),
    };
  };

  const hitsOf = async (): Promise<IndexHit[]> => {
    const out: IndexHit[] = [];
    for (const [prefix, row] of Object.entries(await rows())) {
      const card = await cardOf(prefix);
      if (!card) continue;
      for (const [pkg, entry] of Object.entries(card.packages)) {
        // The row binds the prefix to the key: a name under another prefix is not this row's to list.
        if (!underPrefix(prefix, pkg)) continue;
        const release = releaseFor(card, pkg);
        if (!release) continue;
        const page = await readPage(prefix, pkg);
        out.push({
          package: pkg,
          publisher: prefix,
          key: row.key,
          urls: row.urls,
          version: release.version,
          digest: release.digest,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          ...(release.license ? { license: release.license } : {}),
          ...(release.requires ? { requires: release.requires } : {}),
          ...(page?.detail && page.digest === release.digest ? { detail: summarizeDetail(page.detail) } : {}),
        });
      }
    }
    return out.sort((a, b) => a.package.localeCompare(b.package));
  };
  /** Every derived page, at the release the catalog lists today. */
  const pagesOf = async (): Promise<Array<PageFile & { detail: PackageDetail }>> => {
    const out: Array<PageFile & { detail: PackageDetail }> = [];
    for (const [prefix] of Object.entries(await rows())) {
      const card = await cardOf(prefix);
      if (!card) continue;
      for (const pkg of Object.keys(card.packages)) {
        if (!underPrefix(prefix, pkg)) continue;
        const release = releaseFor(card, pkg);
        const page = release ? await readPage(prefix, pkg) : undefined;
        if (page?.detail && page.digest === release!.digest) out.push(page as PageFile & { detail: PackageDetail });
      }
    }
    return out.sort((a, b) => a.package.localeCompare(b.package));
  };
  /** The Concept pages across every package, one entry per name: the first
   *  package (by name) gives the description and parents, every one is listed. */
  const conceptsOf = async (): Promise<Map<string, IndexConcept & { docs?: string }>> => {
    const out = new Map<string, IndexConcept & { docs?: string }>();
    for (const page of await pagesOf()) {
      for (const c of page.detail.concepts) {
        const have = out.get(c.name);
        const parents = parentsOf(c);
        if (have) {
          have.packages.push({ package: page.package, version: page.version });
          if (!have.description && c.description) have.description = c.description;
          if (!have.parents && parents.length) have.parents = parents;
          if (!have.docs && c.docs) have.docs = c.docs;
          continue;
        }
        out.set(c.name, {
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
          ...(parents.length ? { parents } : {}),
          ...(c.docs ? { docs: c.docs } : {}),
          packages: [{ package: page.package, version: page.version }],
        });
      }
    }
    // The live views' trees (plans/public-surface.md §8): names, descriptions
    // and parents here; a page's docs are read from its publisher, live.
    for (const st of await liveStates()) {
      for (const c of st.concepts ?? []) {
        const from = { publisher: st.prefix, url: st.url };
        const have = out.get(c.name);
        const parents = parentsOf(c);
        if (have) {
          (have.live ??= []).push(from);
          if (!have.description && c.description) have.description = c.description;
          if (!have.parents && parents.length) have.parents = parents;
          continue;
        }
        out.set(c.name, {
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
          ...(parents.length ? { parents } : {}),
          packages: [],
          live: [from],
        });
      }
    }
    return out;
  };

  return {
    info,
    async setRow(prefix, row, opts = {}) {
      const problem = indexRowProblem(prefix, row);
      if (problem) throw new Error(`index_row_invalid: ${problem}`);
      const card = await base();
      const clean: IndexRow = { key: row.key, urls: [...row.urls], ...(row.description !== undefined ? { description: row.description } : {}), ...(row.url !== undefined ? { url: row.url } : {}) };
      card.publishers = { ...card.publishers, [prefix]: clean };
      await seal(card);
      // A row with another key starts the crawl over: the old catalog is not this key's.
      const prev = await readState(prefix);
      if (prev && prev.key !== clean.key) await rm(cardFile(prefix), { force: true });
      if (opts.crawl !== false) await crawlPrefix(prefix, clean);
      return (await info())!;
    },
    async removeRow(prefix) {
      const card = await base();
      if (!Object.hasOwn(card.publishers, prefix)) return false;
      const { [prefix]: _gone, ...rest } = card.publishers;
      card.publishers = rest;
      await seal(card);
      await rm(stateFile(prefix), { force: true });
      await rm(cardFile(prefix), { force: true });
      await rm(pagesDir(prefix), { recursive: true, force: true });
      return true;
    },
    async setLive(prefix, row, opts = {}) {
      const problem = liveRowProblem(prefix, row);
      if (problem) throw new Error(`index_row_invalid: ${problem}`);
      const card = await base();
      const clean: IndexLiveRow = { url: row.url.replace(/\/+$/, ""), ...(row.description !== undefined ? { description: row.description } : {}) };
      card.live = { ...(card.live ?? {}), [prefix]: clean };
      await seal(card);
      if (opts.crawl !== false) await crawlLive(prefix, clean);
      return (await info())!;
    },
    async removeLive(prefix) {
      const card = await base();
      if (!card.live || !Object.hasOwn(card.live, prefix)) return false;
      const { [prefix]: _gone, ...rest } = card.live;
      card.live = rest;
      if (!Object.keys(rest).length) delete card.live;
      await seal(card);
      await rm(liveFile(prefix), { force: true });
      return true;
    },
    async live(q = "") {
      const items: IndexLiveItem[] = [];
      for (const st of await liveStates()) {
        const l = st.listing;
        if (!l) continue;
        const at = { publisher: st.prefix, url: st.url };
        // Its price, beside the item when its definition is public too, else
        // an item of its own (decision 11: runnable is not readable).
        const runOf = (kind: "workflow" | "step", name: string) => {
          const r = l.runnable?.find((x) => x.kind === kind && x.name === name);
          if (!r) return undefined;
          const { kind: _k, name: _n, description: _d, ...run } = r;
          return run;
        };
        for (const a of l.apps) items.push({ ...at, kind: "app", name: a.name, title: a.title, ...(a.description ? { description: a.description } : {}), version: a.version });
        for (const w of l.workflows) {
          const run = runOf("workflow", w.name);
          items.push({ ...at, kind: "workflow", name: w.name, ...(w.description ? { description: w.description } : {}), runs: !!w.runs, ...(run ? { run } : {}) });
        }
        for (const t of l.steps) {
          const run = runOf("step", t.type);
          items.push({ ...at, kind: "step", name: t.type, ...(t.description ? { description: t.description } : {}), ...(run ? { run } : {}) });
        }
        for (const r of l.runnable ?? []) {
          const shown = r.kind === "workflow" ? l.workflows.some((w) => w.name === r.name) : l.steps.some((t) => t.type === r.name);
          if (shown) continue;
          const { kind, name, description, ...run } = r;
          items.push({ ...at, kind, name, ...(description ? { description } : {}), run, definition: false });
        }
        for (const c of l.concepts) items.push({ ...at, kind: "concept", name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.pages !== undefined ? { pages: c.pages } : {}) });
      }
      const words = q.trim();
      return words ? searchSteps(items.map((i) => ({ type: i.name, description: [i.title, i.description, i.publisher].filter(Boolean).join(" "), i })), words).map((m) => m.i) : items;
    },
    catalog: (digest) => (digest ? cards.get(digest) : cards.current()),
    async crawl(filter = {}) {
      const all = await rows();
      const picked = Object.entries(all).filter(([prefix, row]) => (!filter.key || row.key === filter.key) && (!filter.prefix || prefix === filter.prefix));
      // A live row has no key: read with the rest, never by a key's ping.
      if (!filter.key) {
        const live = Object.entries(await liveRows()).filter(([prefix]) => !filter.prefix || prefix === filter.prefix);
        await Promise.all(live.map(([prefix, row]) => crawlLive(prefix, row).catch(() => undefined)));
      }
      return (await Promise.all(picked.map(([prefix, row]) => crawlPrefix(prefix, row)))).sort((a, b) => a.prefix.localeCompare(b.prefix));
    },
    async search(q, limit = 100) {
      const hits = await hitsOf();
      const words = q.trim();
      const found = words ? searchSteps(hits.map((h) => ({ type: h.package, description: [h.description, h.publisher].filter(Boolean).join(" "), h })), words).map((m) => m.h) : hits;
      return found.slice(0, Math.max(1, Math.min(limit, 500)));
    },
    async package(name) {
      const prefix = name.split("/")[0]!;
      const all = await rows();
      const row = Object.hasOwn(all, prefix) ? all[prefix] : undefined;
      if (!row) return undefined;
      const state = await readState(prefix);
      const card = await cardOf(prefix);
      const entry = card?.packages[name];
      if (!card || !entry || !state?.accepted) return undefined;
      const channels: Record<string, string> = {};
      for (const [ch, held] of Object.entries(card.channels ?? {})) if (held[name]) channels[ch] = held[name]!;
      const release = releaseFor(card, name);
      const page = release ? await readPage(prefix, name) : undefined;
      const current = page && page.digest === release!.digest ? page : undefined;
      return {
        package: name,
        publisher: prefix,
        key: row.key,
        urls: row.urls,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        releases: entry.releases,
        channels,
        readAt: state.accepted.at,
        ...(current?.detail ? { detail: current.detail } : {}),
        ...(current?.error ? { detailError: current.error } : !release ? { detailError: "every release is yanked" } : !current ? { detailError: "its archive has not been read yet" } : {}),
      };
    },
    async concepts(q = "") {
      const all = [...(await conceptsOf()).values()].map(({ docs: _docs, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name));
      const words = q.trim();
      return words ? searchSteps(all.map((c) => ({ type: c.name, description: c.description ?? "", c })), words).map((m) => m.c) : all;
    },
    async concept(name) {
      const all = await conceptsOf();
      const page = all.get(name);
      if (!page) return undefined;
      const brief = (c: IndexConcept) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) });
      const children = [...all.values()].filter((c) => c.parents?.includes(name)).map(brief).sort((a, b) => a.name.localeCompare(b.name));
      const parents: Array<{ name: string; description?: string }> = [];
      const seen = new Set<string>([name]);
      for (let p = page.parents?.[0]; p && !seen.has(p); p = all.get(p)?.parents?.[0]) {
        seen.add(p);
        const node = all.get(p);
        parents.push(node ? brief(node) : { name: p });
      }
      const { docs, parents: _direct, ...rest } = page;
      return { ...rest, ...(docs ? { docs } : {}), children, parents };
    },
  };
}

/** `<dataDir>/packages/catalogs/index`, the index's cards and crawl. */
export function indexDir(dataDir: string): string {
  return join(dataDir, "packages", "catalogs", "index");
}

/** The prefixes with crawl state on disk (tests). */
export async function crawledPrefixes(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, "crawl"))).filter((f) => f.endsWith(".json") && !f.endsWith(".catalog.json")).map((f) => f.slice(0, -".json".length)).sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}
