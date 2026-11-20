/**
 * The index's REQUESTS DESK (plans/index-listing.md §2–§8): a publisher's
 * listing request (./listing.ts) checked, cheapest first, and then either
 * listed at once or kept for the operator.
 *
 * Listed at once: an edit from the row's own key on the same host, a
 * removal by the row's key, and a NEW name whose base is on a host the
 * operator trusts in advance (`autoHosts`, `STRUT_INDEX_AUTO_HOSTS`) from a
 * key and a host that hold no row yet — one name per swarm. Kept for the
 * operator, with the reason: `host` (not on the list), `second name` (the
 * key holds a row), `same host` (the host holds a row), `move` (the row's
 * key moving it to another host — with automatic moves a stolen key alone
 * would point new installs at the thief's server), `takeover` (another key
 * holds the name — the only way back for a publisher who lost its key),
 * `live row` (the name is a live row the operator listed with no key: theirs
 * to give — unless the request's base IS that live row's URL: the server the
 * operator listed is the one asking, and it claims the row at once).
 *
 * A name is USED (plans/public-view-listing.md §2) when the public catalog
 * at the base lists a package under it, or when the request asks for the
 * server's public view (`live: true`) and `<base>/public` shows something.
 * The catalog is read either way: it is what proves the base holds the key,
 * empty or not.
 *
 * On disk under `<indexDir>/requests/`: `pending/<id>.json` (the request
 * as sent and what the index read, the id its fingerprint), `refused.json`
 * (a refusal is answered for 30 days without a fetch), `seq.json` (the last
 * `seq` from each key, kept only while it could still pass as fresh) and
 * `log.jsonl` (every outcome: what a dispute starts from).
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageCache } from "./cache.js";
import type { IndexLiveRow, IndexRow } from "./card.js";
import { readCapped } from "./archive.js";
import { liveRunnableOf, type PackageIndex } from "./index.js";
import { LISTING_FRESH_MS, catalogUrlOf, hostMatches, hostOf, listingId, normalizeBase, readListing, type Listing } from "./listing.js";
import { fetchCatalog } from "./pk.js";

/** What strut and Stakwork already mean: listed only by the operator. */
export const RESERVED_PREFIXES: readonly string[] = ["strut", "stakwork", "sphinx", "hive", "stadeum", "peel", "jamie", "index", "official", "admin"];
/** Requests waiting at once, in all and per host. */
export const QUEUE_MAX = 200;
export const QUEUE_PER_HOST = 3;
/** How long a request waits, and how long a refusal is answered. */
export const WAIT_MS = 30 * 86_400_000;
export const REFUSAL_MS = 30 * 86_400_000;
/** A row is read at most once a minute on pings. */
export const PING_EVERY_MS = 60_000;
/** Each open route's budget per address a minute (`POST /index/requests`, `POST /index/ping`). */
export const LISTING_REQUESTS_PER_MINUTE = 10;
/** One read of a request's public view: as long as the live crawl's, and no bigger than a catalog. */
const VIEW_TIMEOUT_MS = 15_000;
const VIEW_MAX_BYTES = 4 * 1024 * 1024;

/** What a server's public view showed when its request was read: the store's kinds, counted. */
export interface ViewCounts {
  apps: number;
  workflows: number;
  steps: number;
  concepts: number;
  runnable: number;
}

export type ListingWait = "host" | "second name" | "same host" | "move" | "takeover" | "live row";

/** A request waiting for the operator. */
export interface PendingListing {
  id: string;
  prefix: string;
  key: string;
  base: string;
  host: string;
  reason: ListingWait;
  description?: string;
  url?: string;
  live?: boolean;
  receivedAt: string;
  /** What the index read at the base when it arrived. */
  catalog: { seq: number; digest: string; packages: string[] };
  /** What `<base>/public` showed, when the name is used by the view alone. */
  view?: ViewCounts;
  /** The key that holds the name now, on a takeover. */
  heldBy?: string;
  /** The row's host now, on a move; the live row's, on a live row. */
  from?: string;
  /** The request as sent, its seal included. */
  request: Listing;
}

export interface ListingRefusal {
  prefix: string;
  key: string;
  host?: string;
  reason: string;
  at: string;
  by?: string;
}

export type ListingAnswer =
  | { status: "listed"; prefix: string; row: IndexRow; live?: IndexLiveRow }
  | { status: "removed"; prefix: string }
  | { status: "pending"; id: string; prefix: string; reason: ListingWait };

export interface ListingLogLine {
  at: string;
  prefix: string;
  key: string;
  host?: string;
  outcome: "listed" | "edited" | "claimed" | "removed" | "waiting" | "approved" | "refused" | "withdrawn";
  reason?: string;
  by?: string;
}

export interface RequestsDeskDeps {
  index: PackageIndex;
  /** `<indexDir>/requests`. */
  dir: string;
  cache: PackageCache;
  /** Host patterns listed with no person (./listing.ts `hostMatches`). */
  autoHosts?: readonly string[];
  /** Prefixes beyond `RESERVED_PREFIXES` that only the operator lists. */
  reserved?: readonly string[];
  /** Bases on plain http (tests, a LAN). */
  allowHttp?: boolean;
  /** Runs a write to the card one at a time with the strut's other package writes. */
  serial?: <T>(fn: () => Promise<T>) => Promise<T>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RequestsDesk {
  /** A request's bytes as received → its outcome, or a coded error. */
  submit(bytes: string): Promise<ListingAnswer>;
  /** What waits, newest first, the refusals of the last 30 days, and the auto list. */
  list(): Promise<{ pending: PendingListing[]; refused: ListingRefusal[]; autoHosts: string[] }>;
  /** The operator lists a waiting request (the catalog read again first). */
  approve(id: string, by?: string): Promise<ListingAnswer>;
  /** The operator refuses one; a re-send from that key for that name gets the reason for 30 days. */
  refuse(id: string, reason: string, by?: string): Promise<ListingRefusal>;
  /** A publisher's ping: read the rows naming `key`, at most once a minute each. */
  ping(key: string): Promise<{ rows: number }>;
  close(): void;
}

/** A desk error's code → its HTTP status. */
export const LISTING_ERROR_STATUS: Record<string, 400 | 403 | 404 | 409 | 422 | 429 | 503> = {
  listing_invalid: 400,
  listing_reserved: 403,
  listing_refused: 403,
  listing_rollback: 409,
  listing_not_listed: 404,
  listing_unknown: 404,
  listing_no_catalog: 422,
  listing_busy: 429,
  index_no_key: 503,
};

export function createRequestsDesk(deps: RequestsDeskDeps): RequestsDesk {
  const now = () => deps.now?.() ?? Date.now();
  const iso = () => new Date(now()).toISOString();
  const serial = deps.serial ?? (<T>(fn: () => Promise<T>) => fn());
  const reserved = new Set([...RESERVED_PREFIXES, ...(deps.reserved ?? [])].map((p) => p.toLowerCase()));
  const autoHosts = [...(deps.autoHosts ?? [])];
  const pendingDir = join(deps.dir, "pending");
  const refusedFile = join(deps.dir, "refused.json");
  const seqFile = join(deps.dir, "seq.json");
  const logFile = join(deps.dir, "log.jsonl");

  // The desk's own files change one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const readJson = async <T>(file: string, empty: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (err: any) {
      if (err?.code === "ENOENT") return empty;
      throw err;
    }
  };
  const writeJson = async (file: string, value: unknown) => {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, file);
  };
  const log = async (line: Omit<ListingLogLine, "at">) => {
    await mkdir(deps.dir, { recursive: true });
    await appendFile(logFile, `${JSON.stringify({ at: iso(), ...line })}\n`);
  };

  const readPending = async (): Promise<PendingListing[]> => {
    let files: string[];
    try {
      files = (await readdir(pendingDir)).filter((f) => f.endsWith(".json"));
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const out: PendingListing[] = [];
    for (const f of files) {
      const p = await readJson<PendingListing | undefined>(join(pendingDir, f), undefined);
      if (!p) continue;
      // A request waits at most 30 days.
      if (now() - Date.parse(p.receivedAt) > WAIT_MS) {
        await rm(join(pendingDir, f), { force: true });
        continue;
      }
      out.push(p);
    }
    return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  };
  const dropPending = async (prefix: string, key: string) => {
    for (const p of await readPending()) if (p.prefix === prefix && p.key === key) await rm(join(pendingDir, `${p.id}.json`), { force: true });
  };
  const readRefused = async (): Promise<Record<string, ListingRefusal>> => {
    const all = await readJson<Record<string, ListingRefusal>>(refusedFile, {});
    for (const [k, r] of Object.entries(all)) if (now() - Date.parse(r.at) > REFUSAL_MS) delete all[k];
    return all;
  };
  const refusalKey = (prefix: string, key: string) => `${prefix} ${key}`;
  /** Whether two bases are one server's: a live row typed by hand may not parse. */
  const sameBase = (a: string, b: string): boolean => {
    try {
      return normalizeBase(a) === normalizeBase(b);
    } catch {
      return false;
    }
  };
  /** The host a row's URL names, or nothing: a row typed by hand may hold one that does not parse. */
  const hostOrNone = (url: string | undefined): string | undefined => {
    try {
      return url ? hostOf(url) : undefined;
    } catch {
      return undefined;
    }
  };

  /** The index as it is: its key, rows and live rows. */
  const card = async () => {
    const info = await deps.index.info();
    if (!info) throw new Error("index_no_key: this index has no key yet — its operator lists the first publisher by hand (PUT /index/:prefix), which mints it");
    return info;
  };

  /** The request's catalog, read from the one URL the index builds: the
   *  proof the server at the base holds the key, empty or not. */
  const readCatalog = async (r: Listing): Promise<PendingListing["catalog"]> => {
    const url = catalogUrlOf(r.base!);
    try {
      // That URL and no other: the host is the sender's to choose, so a redirect is refused.
      const { card: catalog, digest } = await fetchCatalog(r.key, url, { cache: deps.cache, redirects: false, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const packages = Object.keys(catalog.packages).filter((p) => p.startsWith(`${r.prefix}/`)).sort();
      return { seq: catalog.seq, digest, packages };
    } catch (err) {
      throw new Error(`listing_no_catalog: ${url.split("?")[0]}?public=1: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** What `<base>/public` shows, counted: the one URL, no redirect, capped. */
  const readView = async (base: string): Promise<ViewCounts> => {
    const url = `${normalizeBase(base)}/public`;
    try {
      const res = await (deps.fetch ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(VIEW_TIMEOUT_MS) });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel();
        throw new Error("it answered a redirect, and the public view is read from that address alone");
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`it answered ${res.status}`);
      }
      const raw = JSON.parse((await readCapped(res, VIEW_MAX_BYTES, "public view")).toString("utf8")) as Record<string, unknown>;
      const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      return { apps: count(raw["apps"]), workflows: count(raw["workflows"]), steps: count(raw["steps"]), concepts: count(raw["concepts"]), runnable: liveRunnableOf(raw["runnable"]).length };
    } catch (err) {
      throw new Error(`listing_no_catalog: ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** The base holds the key (its catalog), and the name is used: a package
   *  under it, or — asked for with `live: true` — a public view that shows
   *  something (plans/public-view-listing.md §2). */
  const readUsed = async (r: Listing): Promise<{ catalog: PendingListing["catalog"]; view?: ViewCounts }> => {
    const catalog = await readCatalog(r);
    if (catalog.packages.length) return { catalog };
    const at = `${catalogUrlOf(r.base!).split("?")[0]}?public=1`;
    if (r.live === false) throw new Error(`listing_no_catalog: ${at}: it lists no package under ${r.prefix}/, so a row without the public view would list nothing — take the row off instead (remove)`);
    if (r.live !== true) throw new Error(`listing_no_catalog: ${at}: it lists no package under ${r.prefix}/ — publish one and make it public first, or ask for this server's public view (live: true)`);
    const view = await readView(r.base!);
    if (!(view.apps + view.workflows + view.steps + view.concepts + view.runnable)) {
      throw new Error(`listing_no_catalog: ${at} lists no package under ${r.prefix}/, and its public view at ${normalizeBase(r.base!)}/public shows nothing — add something to the public view first`);
    }
    return { catalog, view };
  };

  const rowOf = (r: Listing): IndexRow => ({
    key: r.key,
    urls: [catalogUrlOf(r.base!)],
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.url !== undefined ? { url: r.url } : {}),
  });

  /** Write the row (and the live row the request asks for), then read the publisher, detached. */
  const apply = async (r: Listing): Promise<ListingAnswer & { status: "listed" }> => {
    const row = rowOf(r);
    let live: IndexLiveRow | undefined;
    await serial(async () => {
      await deps.index.setRow(r.prefix, row, { crawl: false });
      if (r.live === true) {
        live = { url: normalizeBase(r.base!), ...(r.description !== undefined ? { description: r.description } : {}) };
        await deps.index.setLive(r.prefix, live, { crawl: false });
      } else if (r.live === false) {
        await deps.index.removeLive(r.prefix);
      }
    });
    void deps.index.crawl({ prefix: r.prefix }).catch(() => undefined);
    return { status: "listed", prefix: r.prefix, row, ...(live ? { live } : {}) };
  };

  /** Keep a request for the operator. */
  const wait = async (r: Listing, reason: ListingWait, read: { catalog: PendingListing["catalog"]; view?: ViewCounts }, extra: Pick<PendingListing, "heldBy" | "from"> = {}): Promise<ListingAnswer> => {
    const host = hostOf(r.base!);
    const others = (await readPending()).filter((p) => !(p.prefix === r.prefix && p.key === r.key));
    if (others.length >= QUEUE_MAX) throw new Error(`listing_busy: ${QUEUE_MAX} requests already wait for this index's operator — try again later`);
    if (others.filter((p) => p.host === host).length >= QUEUE_PER_HOST) throw new Error(`listing_busy: ${QUEUE_PER_HOST} requests from ${host} already wait for this index's operator`);
    const id = listingId(r);
    const pending: PendingListing = {
      id,
      prefix: r.prefix,
      key: r.key,
      base: normalizeBase(r.base!),
      host,
      reason,
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.url !== undefined ? { url: r.url } : {}),
      ...(r.live !== undefined ? { live: r.live } : {}),
      receivedAt: iso(),
      catalog: read.catalog,
      ...(read.view ? { view: read.view } : {}),
      ...extra,
      request: r,
    };
    // One request waits per (name, key): the newest.
    await dropPending(r.prefix, r.key);
    await writeJson(join(pendingDir, `${id}.json`), pending);
    await log({ prefix: r.prefix, key: r.key, host, outcome: "waiting", reason });
    return { status: "pending", id, prefix: r.prefix, reason };
  };

  // Pings: one crawl per row a minute; a ping inside the minute folds into one more at its end.
  const lastPing = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();
  const crawlSoon = (prefix: string) => {
    const at = lastPing.get(prefix) ?? 0;
    const wait = at + PING_EVERY_MS - now();
    if (wait <= 0) {
      lastPing.set(prefix, now());
      void deps.index.crawl({ prefix }).catch(() => undefined);
      return;
    }
    if (timers.has(prefix)) return;
    const t = setTimeout(() => {
      timers.delete(prefix);
      lastPing.set(prefix, now());
      void deps.index.crawl({ prefix }).catch(() => undefined);
    }, wait);
    t.unref?.();
    timers.set(prefix, t);
  };

  return {
    async submit(bytes) {
      // 1–4: the request itself, then the index's key, then its order — no fetch.
      const r = readListing(bytes, { ...(deps.allowHttp ? { allowHttp: true } : {}) });
      const info = await card();
      if (r.index !== info.key) throw new Error(`listing_invalid: this request is for the index ${r.index}, and this index is ${info.key}`);
      const ms = r.seq / 1000;
      if (Math.abs(now() - ms) > LISTING_FRESH_MS) throw new Error(`listing_rollback: the request was signed at ${new Date(ms).toISOString()}, more than ${LISTING_FRESH_MS / 60_000} minutes from this index's clock (${iso()}) — sign it again`);
      await locked(async () => {
        const seqs = await readJson<Record<string, number>>(seqFile, {});
        // A seq that can no longer pass as fresh needs no memory.
        for (const [k, s] of Object.entries(seqs)) if (s / 1000 < now() - LISTING_FRESH_MS) delete seqs[k];
        const last = seqs[r.key];
        if (last !== undefined && r.seq <= last) throw new Error(`listing_rollback: a request from this key at seq ${last} was already read; sign a new one`);
        seqs[r.key] = r.seq;
        await writeJson(seqFile, seqs);
      });
      // 5: names only the operator lists, and a refusal still in force. A
      // refusal is of what WAITED: it never stops a removal, nor the row's
      // own key changing its row where it is.
      if (reserved.has(r.prefix)) throw new Error(`listing_reserved: ${r.prefix} is reserved — only this index's operator lists it`);
      const held = info.publishers[r.prefix];
      const own = !!r.remove || (held?.key === r.key && hostOrNone(held.urls[0]) === hostOf(r.base!));
      const refusal = own ? undefined : (await readRefused())[refusalKey(r.prefix, r.key)];
      if (refusal) throw new Error(`listing_refused: ${refusal.reason} (refused ${refusal.at.slice(0, 10)}; this key may ask again after 30 days)`);

      if (r.remove) {
        return locked(async () => {
          const cur = await card();
          const row = cur.publishers[r.prefix];
          if (row && row.key === r.key) {
            await serial(async () => {
              await deps.index.removeRow(r.prefix);
              if (cur.live[r.prefix]) await deps.index.removeLive(r.prefix);
            });
            await dropPending(r.prefix, r.key);
            await log({ prefix: r.prefix, key: r.key, outcome: "removed" });
            return { status: "removed" as const, prefix: r.prefix };
          }
          const waiting = (await readPending()).some((p) => p.prefix === r.prefix && p.key === r.key);
          if (waiting) {
            await dropPending(r.prefix, r.key);
            await log({ prefix: r.prefix, key: r.key, outcome: "withdrawn" });
            return { status: "removed" as const, prefix: r.prefix };
          }
          throw new Error(`listing_not_listed: ${r.prefix} is not listed under this key here`);
        });
      }

      // 6: the base publishes with that key, and the name is used there.
      const read = await readUsed(r);
      const host = hostOf(r.base!);

      // 7: the decision, against the card as it is now.
      return locked(async () => {
        const { publishers, live } = await card();
        const row = publishers[r.prefix];
        if (row) {
          if (row.key !== r.key) return wait(r, "takeover", read, { heldBy: row.key });
          const from = hostOrNone(row.urls[0]);
          if (from !== host) return wait(r, "move", read, from ? { from } : {});
          const listed = await apply(r);
          await dropPending(r.prefix, r.key);
          await log({ prefix: r.prefix, key: r.key, host, outcome: "edited" });
          return listed;
        }
        const rows = Object.values(publishers);
        // A name the operator lists as a live row, with no key, is held too —
        // unless the server at that very URL is the one asking: it claims it.
        const liveRow = live[r.prefix];
        if (liveRow) {
          if (sameBase(liveRow.url, r.base!) && !rows.some((x) => x.key === r.key)) {
            const listed = await apply(r);
            await dropPending(r.prefix, r.key);
            await log({ prefix: r.prefix, key: r.key, host, outcome: "claimed" });
            return listed;
          }
          const from = hostOrNone(liveRow.url);
          return wait(r, "live row", read, from ? { from } : {});
        }
        if (rows.some((x) => x.key === r.key)) return wait(r, "second name", read);
        if (rows.some((x) => x.urls.some((u) => hostOrNone(u) === host))) return wait(r, "same host", read);
        if (!autoHosts.some((p) => hostMatches(p, host))) return wait(r, "host", read);
        const listed = await apply(r);
        await dropPending(r.prefix, r.key);
        await log({ prefix: r.prefix, key: r.key, host, outcome: "listed" });
        return listed;
      });
    },

    async list() {
      return locked(async () => {
        const kept = await readJson<Record<string, ListingRefusal>>(refusedFile, {});
        const refused = await readRefused();
        if (Object.keys(refused).length !== Object.keys(kept).length) await writeJson(refusedFile, refused);
        return { pending: await readPending(), refused: Object.values(refused).sort((a, b) => b.at.localeCompare(a.at)), autoHosts: [...autoHosts] };
      });
    },

    async approve(id, by) {
      const pending = (await readPending()).find((p) => p.id === id);
      if (!pending) throw new Error(`listing_unknown: no request ${id} waits here`);
      // The catalog (and the view) again: they may have moved since the request arrived.
      await readUsed(pending.request);
      return locked(async () => {
        if (!(await readPending()).some((p) => p.id === id)) throw new Error(`listing_unknown: no request ${id} waits here`);
        const listed = await apply(pending.request);
        await dropPending(pending.prefix, pending.key);
        await log({ prefix: pending.prefix, key: pending.key, host: pending.host, outcome: "approved", reason: pending.reason, ...(by ? { by } : {}) });
        return listed;
      });
    },

    async refuse(id, reason, by) {
      return locked(async () => {
        const pending = (await readPending()).find((p) => p.id === id);
        if (!pending) throw new Error(`listing_unknown: no request ${id} waits here`);
        const refusal: ListingRefusal = { prefix: pending.prefix, key: pending.key, host: pending.host, reason, at: iso(), ...(by ? { by } : {}) };
        const all = await readRefused();
        all[refusalKey(pending.prefix, pending.key)] = refusal;
        await writeJson(refusedFile, all);
        await dropPending(pending.prefix, pending.key);
        await log({ prefix: pending.prefix, key: pending.key, host: pending.host, outcome: "refused", reason, ...(by ? { by } : {}) });
        return refusal;
      });
    },

    async ping(key) {
      const info = await deps.index.info();
      const prefixes = Object.entries(info?.publishers ?? {}).filter(([, row]) => row.key === key).map(([prefix]) => prefix);
      for (const prefix of prefixes) crawlSoon(prefix);
      return { rows: prefixes.length };
    },

    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
