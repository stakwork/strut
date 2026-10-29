/**
 * The indexes this strut FOLLOWS (plans/marketplace.md §7, step 7's client
 * half): the other side of src/packages/index.ts. An index is followed BY
 * ITS KEY, with the URLs its card is served at — `{ id, key, urls }`, kept in
 * `<dataDir>/packages/indexes.json` (public data: no token, nothing to
 * encrypt), put on file at boot from `STRUT_PACKAGE_INDEXES`, else the
 * built-in defaults, each replacing the record of its id.
 *
 * Two uses:
 * - a BARE NAME (`acme/linear`) resolves through the indexes' SIGNED cards,
 *   in order: the first card with a row for `acme` names the key and where
 *   its public catalog is served, and the install goes on as
 *   `pk:<key>/acme/linear` — so the install pins the key the card named
 *   (§3), and everything after is checked against the publisher.
 * - SEARCH reads each index strut's derived, unsigned `GET /index/packages`
 *   and every peer's `GET /packages` (what that strut installed). A hit is
 *   shown, never installed as it came: installing one is installing its
 *   bare name, which goes through the card.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { searchSteps } from "../search.js";
import type { PeersCapability } from "../peers.js";
import type { PackageCache } from "./cache.js";
import { Z32_KEY, type IndexCatalog, type IndexRow } from "./card.js";
import { PACKAGE_NAME } from "./format.js";
import type { IndexHit } from "./index.js";
import type { InstalledPackage } from "./installed.js";
import { fetchCatalog } from "./pk.js";

export interface IndexSubscription {
  /** A short name of this strut's choosing (`stakwork`). */
  id: string;
  /** The index key, z-base-32: the trust root for names. */
  key: string;
  /** Where its card is served, tried in order: an index strut's `GET /index/catalog`. */
  urls: string[];
  label?: string;
}

/** The indexes a strut follows when `STRUT_PACKAGE_INDEXES` is unset.
 *  Stakwork's public index goes here once it is deployed with the role and
 *  its key is known; until then a strut follows none by default. */
export const DEFAULT_PACKAGE_INDEXES: readonly IndexSubscription[] = [];

/** `<dataDir>/packages/indexes.json`. */
export const INDEXES_FILE = "indexes.json";

/** How long a card read is reused before the next resolve reads it again. */
const CARD_TTL_MS = 60_000;
const SEARCH_TIMEOUT_MS = 15_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A subscription as written, checked, or the reason it is not one. */
export function indexSubscriptionProblem(sub: unknown): string | undefined {
  const s = sub as Partial<IndexSubscription> | undefined;
  if (!s || typeof s !== "object") return "an index is { id, key, urls, label? }";
  if (typeof s.id !== "string" || !ID.test(s.id)) return "id is [a-z0-9][a-z0-9_-]*, at most 64 characters";
  if (typeof s.key !== "string" || !Z32_KEY.test(s.key)) return "key is the index key in z-base-32 (52 characters)";
  if (!Array.isArray(s.urls) || s.urls.length === 0 || !s.urls.every((u) => typeof u === "string" && /^https?:\/\/\S+$/.test(u))) {
    return "urls is a non-empty list of http(s) URLs where the index's card is served (an index strut's /index/catalog)";
  }
  if (s.label !== undefined && typeof s.label !== "string") return "label is a string";
  return undefined;
}

/** `STRUT_PACKAGE_INDEXES`: a JSON list of subscriptions; `[]` follows none.
 *  Unset: the defaults. A bad value throws (it fails the boot). */
export function parseIndexesEnv(raw: string | undefined): IndexSubscription[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PACKAGE_INDEXES.map((s) => ({ ...s, urls: [...s.urls] }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`STRUT_PACKAGE_INDEXES is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("STRUT_PACKAGE_INDEXES is a JSON list of { id, key, urls, label? }");
  return parsed.map((s, i) => {
    const problem = indexSubscriptionProblem(s);
    if (problem) throw new Error(`STRUT_PACKAGE_INDEXES[${i}]: ${problem}`);
    return clean(s as IndexSubscription);
  });
}

function clean(s: IndexSubscription): IndexSubscription {
  return { id: s.id, key: s.key, urls: [...s.urls], ...(s.label !== undefined ? { label: s.label } : {}) };
}

/** What `GET /packages/indexes` shows of one: the record and its last read. */
export interface IndexSubscriptionInfo extends IndexSubscription {
  read?: { seq: number; digest: string; at: string; url: string; publishers: number };
  error?: string;
}

/** A bare name, resolved through a card: what the install goes on with. */
export interface ResolvedName {
  ref: string;
  /** Where the publisher's public catalog is served, as the row says: tried in order. */
  urls: string[];
  /** The index whose card named the key. */
  index: string;
}

/** One search hit from an index (unsigned: shown, never installed as it came). */
export interface IndexSearchHit extends IndexHit {
  index: string;
}

/** A package a peer has installed. */
export interface PeerSearchHit {
  peer: string;
  package: string;
  version?: string;
  digest?: string;
  source?: { ref: string };
}

export interface PackageSearch {
  packages: IndexSearchHit[];
  peers: PeerSearchHit[];
  /** An index or a peer that could not be read, and why. */
  errors: Array<{ index?: string; peer?: string; error: string }>;
}

export interface IndexesDeps {
  /** `<dataDir>/packages/indexes.json`. */
  file: string;
  cache: PackageCache;
  peers?: PeersCapability;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PackageIndexes {
  list(): Promise<IndexSubscriptionInfo[]>;
  set(sub: IndexSubscription): Promise<IndexSubscriptionInfo>;
  remove(id: string): Promise<boolean>;
  /** The index's card, checked against its key (read again after a minute). */
  card(id: string): Promise<{ card: IndexCatalog; url: string }>;
  /** A bare name through the cards, in order — or one index's, with `index`. */
  resolveName(name: string, opts?: { index?: string }): Promise<ResolvedName>;
  /** The indexes' packages and the peers' installed ones, every word of `q` matched. */
  search(q: string, opts?: { limit?: number; peers?: boolean }): Promise<PackageSearch>;
}

/** Where an index strut serves search, from its card's URL; nothing for a card that is a static file. */
export function indexBaseOf(cardUrl: string): string | undefined {
  const u = new URL(cardUrl);
  return u.pathname.endsWith("/index/catalog") ? `${u.origin}${u.pathname.slice(0, -"/index/catalog".length)}` : undefined;
}

export function createIndexes(deps: IndexesDeps): PackageIndexes {
  const now = () => deps.now?.() ?? Date.now();
  const doFetch = deps.fetch ?? fetch;
  const states = new Map<string, Pick<IndexSubscriptionInfo, "read" | "error">>();
  const cards = new Map<string, { key: string; at: number; card: IndexCatalog; url: string }>();

  const readFileList = async (): Promise<IndexSubscription[]> => {
    try {
      const raw = JSON.parse(await readFile(deps.file, "utf8")) as { indexes?: IndexSubscription[] };
      return (raw.indexes ?? []).filter((s) => !indexSubscriptionProblem(s)).map(clean);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  };
  let writes: Promise<unknown> = Promise.resolve();
  const update = <T>(fn: (list: IndexSubscription[]) => { list: IndexSubscription[]; out: T }): Promise<T> => {
    const next = writes.then(async () => {
      const { list, out } = fn(await readFileList());
      await mkdir(dirname(deps.file), { recursive: true });
      const tmp = `${deps.file}.${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, JSON.stringify({ indexes: list }, null, 2));
      await rename(tmp, deps.file);
      return out;
    });
    writes = next.catch(() => undefined);
    return next;
  };
  const withState = (s: IndexSubscription): IndexSubscriptionInfo => ({ ...s, ...(states.get(s.id) ?? {}) });

  const card = async (id: string): Promise<{ card: IndexCatalog; url: string }> => {
    const sub = (await readFileList()).find((s) => s.id === id);
    if (!sub) throw new Error(`package_index_unknown: this strut follows no index "${id}"`);
    const memo = cards.get(id);
    if (memo && memo.key === sub.key && now() - memo.at < CARD_TTL_MS) return memo;
    const failures: string[] = [];
    for (const url of sub.urls) {
      try {
        const { card: got, digest } = await fetchCatalog(sub.key, url, { cache: deps.cache, kind: "index", fetch: doFetch });
        cards.set(id, { key: sub.key, at: now(), card: got, url });
        states.set(id, { read: { seq: got.seq, digest, at: new Date(now()).toISOString(), url, publishers: Object.keys(got.publishers).length } });
        return { card: got, url };
      } catch (err) {
        failures.push(`${url.split("?")[0]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const error = failures.join("; ");
    states.set(id, { ...(states.get(id)?.read ? { read: states.get(id)!.read } : {}), error });
    throw new Error(`package_index_unreachable: index "${id}": ${error}`);
  };

  return {
    list: async () => (await readFileList()).map(withState),
    async set(sub) {
      const problem = indexSubscriptionProblem(sub);
      if (problem) throw new Error(`package_index_invalid: ${problem}`);
      const record = clean(sub);
      await update((list) => ({ list: [...list.filter((s) => s.id !== record.id), record], out: undefined }));
      cards.delete(record.id);
      states.delete(record.id);
      return withState(record);
    },
    async remove(id) {
      const removed = await update((list) => ({ list: list.filter((s) => s.id !== id), out: list.some((s) => s.id === id) }));
      cards.delete(id);
      states.delete(id);
      return removed;
    },
    card,
    async resolveName(name, opts = {}) {
      if (!PACKAGE_NAME.test(name)) throw new Error(`package_source_invalid: ${name} is not a package name (publisher/name)`);
      const prefix = name.split("/")[0]!;
      const subs = (await readFileList()).filter((s) => !opts.index || s.id === opts.index);
      if (opts.index && subs.length === 0) throw new Error(`package_index_unknown: this strut follows no index "${opts.index}"`);
      if (subs.length === 0) {
        throw new Error(`package_source_invalid: ${name} is a name, and this strut follows no index to look it up in — install by pk:<key>/${name} with url, or follow one (PUT /packages/indexes/:id)`);
      }
      const unreachable: string[] = [];
      for (const sub of subs) {
        let got: { card: IndexCatalog };
        try {
          got = await card(sub.id);
        } catch (err) {
          unreachable.push(err instanceof Error ? err.message : String(err));
          continue;
        }
        // Own rows only: `constructor` is a valid prefix, and every object answers to it.
        const row: IndexRow | undefined = Object.hasOwn(got.card.publishers, prefix) ? got.card.publishers[prefix] : undefined;
        if (row) return { ref: `pk:${row.key}/${name}`, urls: [...row.urls], index: sub.id };
      }
      // No card we could read lists the prefix: say which could not be read.
      if (unreachable.length === subs.length) throw new Error(unreachable.join("; "));
      const also = unreachable.length ? ` (and ${unreachable.join("; ")})` : "";
      throw new Error(`package_not_listed: no index this strut follows lists the publisher ${prefix} (${subs.map((s) => s.id).join(", ")})${also}`);
    },
    async search(q, opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
      const out: PackageSearch = { packages: [], peers: [], errors: [] };
      const subs = await readFileList();
      await Promise.all(
        subs.map(async (sub) => {
          const failures: string[] = [];
          for (const url of sub.urls) {
            const base = indexBaseOf(url);
            if (!base) continue;
            try {
              const res = await doFetch(`${base}/index/packages?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
              if (!res.ok) {
                await res.body?.cancel();
                throw new Error(`answered ${res.status}`);
              }
              const body = (await res.json()) as { packages?: IndexHit[] };
              for (const hit of body.packages ?? []) out.packages.push({ ...hit, index: sub.id });
              return;
            } catch (err) {
              failures.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          out.errors.push({ index: sub.id, error: failures.length ? failures.join("; ") : "its card is a file, not an index strut: no search there" });
        }),
      );
      if (opts.peers !== false && deps.peers) {
        const peers = await deps.peers.list().catch(() => []);
        await Promise.all(
          peers.map(async (peer) => {
            try {
              const res = await deps.peers!.fetch(peer.id, "/packages", { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
              if (!res.ok) {
                await res.body?.cancel();
                throw new Error(`answered ${res.status}`);
              }
              const body = (await res.json()) as { packages?: InstalledPackage[] };
              const listed = (body.packages ?? []).map((p) => ({ type: p.package, p }));
              for (const { p } of searchSteps(listed, q)) {
                out.peers.push({ peer: peer.id, package: p.package, ...(p.version ? { version: p.version } : {}), ...(p.digest ? { digest: p.digest } : {}), ...(p.source ? { source: p.source } : {}) });
              }
            } catch (err) {
              out.errors.push({ peer: peer.id, error: err instanceof Error ? err.message : String(err) });
            }
          }),
        );
      }
      // The order the indexes are followed in, then the index's own ranking.
      const order = new Map(subs.map((s, i) => [s.id, i]));
      out.packages = out.packages.map((h, i) => ({ h, i })).sort((a, b) => order.get(a.h.index)! - order.get(b.h.index)! || a.i - b.i).map((x) => x.h).slice(0, limit);
      out.peers.sort((a, b) => a.peer.localeCompare(b.peer) || a.package.localeCompare(b.package));
      out.errors.sort((a, b) => (a.index ?? a.peer ?? "").localeCompare(b.index ?? b.peer ?? ""));
      return out;
    },
  };
}
