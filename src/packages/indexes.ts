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
 * - The PAGES (the store front, plans/marketplace.md §7): `get` reads one
 *   package's page from the index whose card lists its publisher, and
 *   `concepts` / `concept` the Concept tree the listed packages carry —
 *   the same derived reads, so an agent on this strut (the `package/*`
 *   steps, the assistant door's `search_packages` / `get_package`) sees
 *   what a person sees in the store, and installs nothing.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { searchSteps } from "../search.js";
import type { PeersCapability } from "../peers.js";
import type { PackageCache } from "./cache.js";
import { Z32_KEY, type IndexCatalog, type IndexRow } from "./card.js";
import { PACKAGE_NAME } from "./format.js";
import type { ConceptDetail, IndexConcept, IndexConceptPage, IndexHit, IndexPackage, PackageDetail } from "./index.js";
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

/** A package's page as a followed index serves it (`GET
 *  /index/packages/:publisher/:name` there, `detail` included), with the
 *  index it came from. */
export interface IndexPackagePage extends IndexPackage {
  index: string;
}

/** A Concept page's entry across the followed indexes: one per name, the
 *  first index's (in the order followed). */
export interface IndexConceptHit extends IndexConcept {
  index: string;
}

export interface IndexConceptPageHit extends IndexConceptPage {
  index: string;
}

export interface ConceptSearch {
  concepts: IndexConceptHit[];
  /** An index that could not be read, and why; with no `index`, that none is followed. */
  errors: Array<{ index?: string; error: string }>;
}

/** What every agent-facing READ says about installing (plans/marketplace.md
 *  §8, ruled 2026-10-29): a PERSON decides — an agent that holds
 *  `package/install` proposes (a card they approve), any other tells them
 *  the name. No read installs. */
export const INSTALL_IS_A_PERSONS_ACT =
  "Installing is a PERSON's decision, never yours: if you hold package/install, propose it with that tool (the call becomes a card the person approves — say why in `rationale`); otherwise tell the person its name (publisher/name) — it installs from the Packages dialog of their strut's UI (Find the name, then Install) or from the store's Install link, which opens that dialog on the name. Either way the install re-verifies the package against its publisher's signed catalog.";

/** How much of a README a model-facing page keeps. */
export const README_BRIEF_CHARS = 12_000;

/** A package's detail as a MODEL reads it: the README cut, the Concept
 *  pages' docs left out (one page is read whole with `concept`). */
export type PackageDetailBrief = Omit<PackageDetail, "concepts"> & { concepts: Array<Omit<ConceptDetail, "docs">> };

/** The page a step or a tool hands a model: a page, not a book. The
 *  capability itself returns the whole page. */
export function briefPackagePage<T extends IndexPackage>(page: T): Omit<T, "detail"> & { detail?: PackageDetailBrief } {
  const { detail, ...rest } = page;
  if (!detail) return rest;
  const readme =
    detail.readme !== undefined && detail.readme.length > README_BRIEF_CHARS
      ? `${detail.readme.slice(0, README_BRIEF_CHARS)}\n\n… (cut at ${README_BRIEF_CHARS} of ${detail.readme.length} characters)`
      : detail.readme;
  return {
    ...rest,
    detail: {
      ...detail,
      ...(readme !== undefined ? { readme } : {}),
      concepts: detail.concepts.map(({ docs: _docs, ...c }) => c),
    },
  };
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
  /** One package's page from the first followed index whose card lists its
   *  publisher (or the one `index` names): what `GET
   *  /index/packages/:publisher/:name` serves there, `detail` included.
   *  Throws `package_not_listed` / `package_not_found` / `package_index_*`. */
  get(name: string, opts?: { index?: string }): Promise<IndexPackagePage>;
  /** The Concept pages across the followed indexes (every word of `q` in a
   *  name or description; none lists the tree), one entry per name. */
  concepts(q?: string, opts?: { index?: string }): Promise<ConceptSearch>;
  /** One Concept page — docs, children, parents — from the first index that
   *  carries it; undefined when none does. */
  concept(name: string, opts?: { index?: string }): Promise<IndexConceptPageHit | undefined>;
}

/** `ctx.services.packages` (capabilities.ts): the READS a step or a tool
 *  makes — what the indexes this strut follows know — and the one door
 *  that writes, behind a person's yes. */
export type PackagesCapability = Pick<PackageIndexes, "search" | "get" | "concepts" | "concept"> & {
  /** `package/install`'s door (plans/marketplace.md §8, ruled 2026-10-29):
   *  installs ONLY as the apply of an ACCEPTED proposal of that step for
   *  this very ref — `proposal` is the record's id, checked against the
   *  record on disk (createStrut) — so no step, authored or installed, pulls
   *  code without a person's yes. `ref` is a name through the followed
   *  indexes, or a `pk:` ref with its `url`. */
  install?(ref: string, opts: { proposal: string; index?: string; digest?: string; url?: string; actor?: string }): Promise<unknown>;
};

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

  /** The index's card, from the memo while it is fresh (`cached: true`),
   *  else read again from its URLs in order; `fresh` reads again regardless. */
  const card = async (id: string, opts: { fresh?: boolean } = {}): Promise<{ card: IndexCatalog; url: string; cached: boolean }> => {
    const sub = (await readFileList()).find((s) => s.id === id);
    if (!sub) throw new Error(`package_index_unknown: this strut follows no index "${id}"`);
    const memo = cards.get(id);
    if (!opts.fresh && memo && memo.key === sub.key && now() - memo.at < CARD_TTL_MS) return { ...memo, cached: true };
    const failures: string[] = [];
    for (const url of sub.urls) {
      try {
        const { card: got, digest } = await fetchCatalog(sub.key, url, { cache: deps.cache, kind: "index", fetch: doFetch });
        cards.set(id, { key: sub.key, at: now(), card: got, url });
        states.set(id, { read: { seq: got.seq, digest, at: new Date(now()).toISOString(), url, publishers: Object.keys(got.publishers).length } });
        return { card: got, url, cached: false };
      } catch (err) {
        failures.push(`${url.split("?")[0]}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const error = failures.join("; ");
    states.set(id, { ...(states.get(id)?.read ? { read: states.get(id)!.read } : {}), error });
    throw new Error(`package_index_unreachable: index "${id}": ${error}`);
  };

  /** The indexes followed, or the one `index` names (unknown: a throw). */
  const subsFor = async (opts: { index?: string }): Promise<IndexSubscription[]> => {
    const subs = (await readFileList()).filter((s) => !opts.index || s.id === opts.index);
    if (opts.index && subs.length === 0) throw new Error(`package_index_unknown: this strut follows no index "${opts.index}"`);
    return subs;
  };
  /** The first of `subs` whose card lists the publisher of `name`: the
   *  subscription, its row, and the URL that served the card. A miss over
   *  memoized cards reads them again once — a publisher listed a moment ago
   *  is found now, not after the memo's minute. A card that could not be
   *  read is passed over and named; none listing the prefix is
   *  `package_not_listed`. */
  const rowFor = async (name: string, subs: IndexSubscription[]): Promise<{ sub: IndexSubscription; row: IndexRow; url: string }> => {
    const prefix = name.split("/")[0]!;
    const pass = async (fresh: boolean) => {
      const unreachable: string[] = [];
      let anyCached = false;
      for (const sub of subs) {
        let got: { card: IndexCatalog; url: string; cached: boolean };
        try {
          got = await card(sub.id, { fresh });
        } catch (err) {
          unreachable.push(err instanceof Error ? err.message : String(err));
          continue;
        }
        anyCached ||= got.cached;
        // Own rows only: `constructor` is a valid prefix, and every object answers to it.
        const row: IndexRow | undefined = Object.hasOwn(got.card.publishers, prefix) ? got.card.publishers[prefix] : undefined;
        if (row) return { hit: { sub, row, url: got.url }, unreachable, anyCached };
      }
      return { hit: undefined, unreachable, anyCached };
    };
    let found = await pass(false);
    if (!found.hit && found.anyCached) found = await pass(true);
    if (found.hit) return found.hit;
    const { unreachable } = found;
    // No card we could read lists the prefix: say which could not be read.
    if (unreachable.length === subs.length) throw new Error(unreachable.join("; "));
    const also = unreachable.length ? ` (and ${unreachable.join("; ")})` : "";
    throw new Error(`package_not_listed: no index this strut follows lists the publisher ${prefix} (${subs.map((s) => s.id).join(", ")})${also}`);
  };
  /** One of an index strut's derived reads — `path` under its base, from
   *  the subscription's URLs in order: the body, `notFound` (its 404), or
   *  why nothing answered. A card that is a static file has no base. */
  const readIndex = async <T>(sub: IndexSubscription, path: string): Promise<{ body: T } | { notFound: true } | { error: string }> => {
    const failures: string[] = [];
    for (const url of sub.urls) {
      const base = indexBaseOf(url);
      if (!base) continue;
      try {
        const res = await doFetch(`${base}${path}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        if (res.status === 404) {
          await res.body?.cancel();
          return { notFound: true };
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`answered ${res.status}`);
        }
        return { body: (await res.json()) as T };
      } catch (err) {
        failures.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { error: failures.length ? failures.join("; ") : "its card is a file, not an index strut: no pages there" };
  };
  const noIndex = (what: string) => `package_index_none: this strut follows no package index to ${what} (PUT /packages/indexes/:id, or STRUT_PACKAGE_INDEXES)`;

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
      const subs = await subsFor(opts);
      if (subs.length === 0) {
        throw new Error(`package_source_invalid: ${name} is a name, and this strut follows no index to look it up in — install by pk:<key>/${name} with url, or follow one (PUT /packages/indexes/:id)`);
      }
      const { sub, row } = await rowFor(name, subs);
      return { ref: `pk:${row.key}/${name}`, urls: [...row.urls], index: sub.id };
    },
    async search(q, opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
      const out: PackageSearch = { packages: [], peers: [], errors: [] };
      const subs = await readFileList();
      await Promise.all(
        subs.map(async (sub) => {
          const read = await readIndex<{ packages?: IndexHit[] }>(sub, `/index/packages?q=${encodeURIComponent(q)}&limit=${limit}`);
          if ("body" in read) {
            for (const hit of read.body.packages ?? []) out.packages.push({ ...hit, index: sub.id });
            return;
          }
          out.errors.push({ index: sub.id, error: "error" in read ? read.error : "answered 404" });
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
    async get(name, opts = {}) {
      if (!PACKAGE_NAME.test(name)) throw new Error(`package_source_invalid: ${name} is not a package name (publisher/name)`);
      const subs = await subsFor(opts);
      if (subs.length === 0) throw new Error(noIndex(`look ${name} up in`));
      const { sub } = await rowFor(name, subs);
      const read = await readIndex<IndexPackage>(sub, `/index/packages/${name}`);
      if ("body" in read) return { ...read.body, index: sub.id };
      if ("notFound" in read) throw new Error(`package_not_found: the index "${sub.id}" lists the publisher ${name.split("/")[0]}, but no public catalog it read has ${name}`);
      throw new Error(`package_index_unreachable: index "${sub.id}": ${read.error}`);
    },
    async concepts(q = "", opts = {}) {
      const subs = await subsFor(opts);
      const out: ConceptSearch = { concepts: [], errors: [] };
      if (subs.length === 0) {
        out.errors.push({ error: noIndex("read Concept pages from") });
        return out;
      }
      const reads = await Promise.all(subs.map((sub) => readIndex<{ concepts?: IndexConcept[] }>(sub, `/index/concepts?q=${encodeURIComponent(q)}`)));
      // In the order followed: the first index's entry for a name is the one kept.
      const seen = new Set<string>();
      subs.forEach((sub, i) => {
        const read = reads[i]!;
        if (!("body" in read)) {
          out.errors.push({ index: sub.id, error: "error" in read ? read.error : "answered 404" });
          return;
        }
        for (const c of read.body.concepts ?? []) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          out.concepts.push({ ...c, index: sub.id });
        }
      });
      out.concepts.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },
    async concept(name, opts = {}) {
      const subs = await subsFor(opts);
      if (subs.length === 0) throw new Error(noIndex(`read the Concept page "${name}" from`));
      const errors: string[] = [];
      for (const sub of subs) {
        const read = await readIndex<IndexConceptPage>(sub, `/index/concepts/${encodeURIComponent(name)}`);
        if ("body" in read) return { ...read.body, index: sub.id };
        if ("error" in read) errors.push(`index "${sub.id}": ${read.error}`);
      }
      if (errors.length === subs.length) throw new Error(`package_index_unreachable: ${errors.join("; ")}`);
      return undefined;
    },
  };
}
