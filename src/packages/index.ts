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
import type { PackageCache } from "./cache.js";
import { CARD_VERSION, PUBLISHER_PREFIX, Z32_KEY, canonicalJson, keyFromSeed, releaseFor, sealCard, type Catalog, type CatalogRelease, type IndexCatalog, type IndexRow, type UnsignedIndexCatalog } from "./card.js";
export type { IndexRow } from "./card.js";
import { fetchCatalog } from "./pk.js";
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
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PackageIndex {
  /** The index as it is; undefined before its key is minted. */
  info(): Promise<IndexInfo | undefined>;
  /** Add or change a row (the key minted first when there is none), re-seal the card, and read that publisher now. */
  setRow(prefix: string, row: IndexRow): Promise<IndexInfo>;
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

export function createPackageIndex(deps: IndexDeps): PackageIndex {
  const cards = new CatalogStore(deps.dir);
  const crawlDir = join(deps.dir, "crawl");
  const stateFile = (prefix: string) => join(crawlDir, `${prefix}.json`);
  const cardFile = (prefix: string) => join(crawlDir, `${prefix}.catalog.json`);

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
  const crawlOne = async (prefix: string, row: IndexRow): Promise<CrawlState> => {
    const prev = await readState(prefix);
    const at = new Date().toISOString();
    const state: CrawlState = { prefix, key: row.key, ...(prev?.key === row.key && prev.accepted ? { accepted: prev.accepted, packages: prev.packages } : {}), checkedAt: at };
    const failures: string[] = [];
    for (const url of row.urls) {
      try {
        const { card, digest } = await fetchCatalog(row.key, url, { cache: deps.cache, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
        if (state.accepted?.digest !== digest) await writeFileAtomic(cardFile(prefix), canonicalJson(card));
        state.accepted = { seq: card.seq, digest, at, url };
        state.packages = Object.keys(card.packages).length;
        delete state.error;
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
    return { key: record.key, createdAt: record.createdAt, urls: cur?.urls ?? deps.urls ?? [], publishers, crawled: await states(publishers) };
  };

  const hitsOf = async (): Promise<IndexHit[]> => {
    const out: IndexHit[] = [];
    for (const [prefix, row] of Object.entries(await rows())) {
      const card = await cardOf(prefix);
      if (!card) continue;
      for (const [pkg, entry] of Object.entries(card.packages)) {
        const release = releaseFor(card, pkg);
        if (!release) continue;
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
        });
      }
    }
    return out.sort((a, b) => a.package.localeCompare(b.package));
  };

  return {
    info,
    async setRow(prefix, row) {
      const problem = indexRowProblem(prefix, row);
      if (problem) throw new Error(`index_row_invalid: ${problem}`);
      const card = await base();
      const clean: IndexRow = { key: row.key, urls: [...row.urls], ...(row.description !== undefined ? { description: row.description } : {}), ...(row.url !== undefined ? { url: row.url } : {}) };
      card.publishers = { ...card.publishers, [prefix]: clean };
      await seal(card);
      // A row with another key starts the crawl over: the old catalog is not this key's.
      const prev = await readState(prefix);
      if (prev && prev.key !== clean.key) await rm(cardFile(prefix), { force: true });
      await crawlPrefix(prefix, clean);
      return (await info())!;
    },
    async removeRow(prefix) {
      const card = await base();
      if (!(prefix in card.publishers)) return false;
      const { [prefix]: _gone, ...rest } = card.publishers;
      card.publishers = rest;
      await seal(card);
      await rm(stateFile(prefix), { force: true });
      await rm(cardFile(prefix), { force: true });
      return true;
    },
    catalog: (digest) => (digest ? cards.get(digest) : cards.current()),
    async crawl(filter = {}) {
      const all = await rows();
      const picked = Object.entries(all).filter(([prefix, row]) => (!filter.key || row.key === filter.key) && (!filter.prefix || prefix === filter.prefix));
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
      const row = (await rows())[prefix];
      if (!row) return undefined;
      const state = await readState(prefix);
      const card = await cardOf(prefix);
      const entry = card?.packages[name];
      if (!card || !entry || !state?.accepted) return undefined;
      const channels: Record<string, string> = {};
      for (const [ch, held] of Object.entries(card.channels ?? {})) if (held[name]) channels[ch] = held[name]!;
      return {
        package: name,
        publisher: prefix,
        key: row.key,
        urls: row.urls,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        releases: entry.releases,
        channels,
        readAt: state.accepted.at,
      };
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
