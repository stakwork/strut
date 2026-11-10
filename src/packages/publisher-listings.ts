/**
 * This strut's ASKS to be listed (plans/index-listing.md §1, §6): the
 * publisher's side of a listing. A person clicks **List on <index>** in the
 * Packages tab; this strut seals a listing request with its PUBLIC key
 * (./listing.ts, the publisher's `sealListing`) and POSTs it to the index
 * strut beside the followed card (`…/index/catalog` → `…/index/requests`).
 * The index's key comes from the followed record, never from the network.
 *
 * The answers are kept in `<dataDir>/packages/listings.json` (plain JSON,
 * nothing secret). Whether the name is LISTED is read off the index's own
 * signed card, which ./indexes.ts already reads: our name with our public
 * key. So an operator's approval shows up without the index calling back.
 * After a release, `ping` tells every index we asked that our public
 * catalog moved (`POST …/index/ping { key }`, open there).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, type IndexRow } from "./card.js";
import { indexBaseOf, type PackageIndexes } from "./indexes.js";
import { baseProblem, normalizeBase } from "./listing.js";
import type { Publisher } from "./publisher.js";

/** `<dataDir>/packages/listings.json`. */
export const LISTINGS_FILE = "listings.json";

/** What a person asks for. */
export interface ListingAsk {
  /** Where this server is reached: an origin and at most one path segment. */
  base: string;
  description?: string;
  /** A homepage. */
  url?: string;
  /** Also list this server's public view. */
  live?: boolean;
}

/** The last answer an index gave this strut. */
export interface ListingRecord {
  /** The followed index's id. */
  index: string;
  indexKey: string;
  prefix: string;
  base?: string;
  description?: string;
  url?: string;
  live?: boolean;
  status: "listed" | "pending" | "removed" | "refused" | "error";
  /** Why it waits, or why it was refused or failed. */
  reason?: string;
  /** The waiting request's id at the index. */
  id?: string;
  at: string;
}

/** One followed index as the Packages tab draws its line. */
export interface ListingLine {
  index: string;
  label?: string;
  indexKey: string;
  /** Where requests go; absent when the card is a file no index strut serves. */
  requests?: string;
  /** Our name with our public key on the index's card, as last read. */
  listed: boolean;
  /** The row under our name on the card. */
  row?: IndexRow;
  /** Another key holds our name there. */
  heldBy?: string;
  /** Why the card could not be read. */
  cardError?: string;
  /** What we asked last, and the answer. */
  asked?: ListingRecord;
}

export interface ListingOutcome {
  /** The index's HTTP status. */
  status: number;
  /** The index's answer, or `{ error }`. */
  answer: Record<string, unknown>;
  record: ListingRecord;
}

export interface PublisherListings {
  list(): Promise<ListingLine[]>;
  /** Ask a followed index to list this strut's name (or change its row). */
  ask(index: string, ask: ListingAsk): Promise<ListingOutcome>;
  /** Take this strut's row (or its waiting request) off a followed index. */
  withdraw(index: string): Promise<ListingOutcome>;
  /** Tell every index asked that the catalog sealed by `key` moved. Best effort. */
  ping(key: string): Promise<void>;
}

export interface PublisherListingsDeps {
  file: string;
  indexes: PackageIndexes;
  publisher: Publisher;
  fetch?: typeof fetch;
  now?: () => number;
}

const ASK_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 10_000;

export function createPublisherListings(deps: PublisherListingsDeps): PublisherListings {
  const doFetch = deps.fetch ?? fetch;
  const iso = () => new Date(deps.now?.() ?? Date.now()).toISOString();

  const read = async (): Promise<Record<string, ListingRecord>> => {
    try {
      return (JSON.parse(await readFile(deps.file, "utf8")) as { listings?: Record<string, ListingRecord> }).listings ?? {};
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  };
  let writes: Promise<unknown> = Promise.resolve();
  const save = (record: ListingRecord): Promise<void> => {
    const next = writes.then(async () => {
      const all = await read();
      all[record.index] = record;
      await mkdir(dirname(deps.file), { recursive: true });
      const tmp = `${deps.file}.${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, JSON.stringify({ listings: all }, null, 2));
      await rename(tmp, deps.file);
    });
    writes = next.catch(() => undefined);
    return next;
  };

  const subOf = async (id: string) => {
    const sub = (await deps.indexes.list()).find((s) => s.id === id);
    if (!sub) throw new Error(`package_index_unknown: this strut server follows no index "${id}"`);
    return sub;
  };
  const baseOf = (urls: string[]) => urls.map((u) => indexBaseOf(u)).find((b): b is string => !!b);
  const requestsOf = (urls: string[]) => {
    const base = baseOf(urls);
    return base ? `${base}/index/requests` : undefined;
  };

  /** Seal, send, keep the answer. */
  const send = async (id: string, fields: Omit<ListingRecord, "index" | "indexKey" | "prefix" | "status" | "at" | "reason" | "id">, remove: boolean): Promise<ListingOutcome> => {
    const sub = await subOf(id);
    const to = requestsOf(sub.urls);
    if (!to) throw new Error(`listing_no_route: the index "${id}" serves its card as a file, not from an index strut server — ask its operator to list this server`);
    const sealed = await deps.publisher.sealListing({
      index: sub.key,
      ...(fields.base !== undefined ? { base: fields.base } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.url !== undefined ? { url: fields.url } : {}),
      ...(fields.live !== undefined ? { live: fields.live } : {}),
      ...(remove ? { remove: true as const } : {}),
    });
    let status: number;
    let answer: Record<string, unknown>;
    try {
      const res = await doFetch(to, { method: "POST", headers: { "content-type": "application/json" }, body: canonicalJson(sealed), signal: AbortSignal.timeout(ASK_TIMEOUT_MS) });
      status = res.status;
      answer = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (!res.ok && typeof answer["error"] !== "string") answer = { error: `${to} answered ${res.status}` };
    } catch (err) {
      status = 502;
      answer = { error: `listing_index_unreachable: ${to}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const error = typeof answer["error"] === "string" ? (answer["error"] as string) : undefined;
    const said = answer["status"];
    const record: ListingRecord = {
      index: id,
      indexKey: sub.key,
      prefix: sealed.prefix,
      ...fields,
      status: error ? (/^listing_refused:/.test(error) ? "refused" : "error") : said === "listed" || said === "pending" || said === "removed" ? said : "error",
      ...(error ? { reason: error } : typeof answer["reason"] === "string" ? { reason: answer["reason"] as string } : {}),
      ...(typeof answer["id"] === "string" ? { id: answer["id"] as string } : {}),
      at: iso(),
    };
    await save(record);
    return { status, answer, record };
  };

  return {
    async list() {
      const pub = await deps.publisher.get();
      const asked = await read();
      const out: ListingLine[] = [];
      for (const sub of await deps.indexes.list()) {
        const line: ListingLine = { index: sub.id, ...(sub.label !== undefined ? { label: sub.label } : {}), indexKey: sub.key, listed: false, ...(asked[sub.id] ? { asked: asked[sub.id] } : {}) };
        const to = requestsOf(sub.urls);
        if (to) line.requests = to;
        try {
          // Read now: an operator's approval shows the moment it is sealed.
          const { card } = await deps.indexes.card(sub.id, { fresh: true });
          const row = pub?.name && Object.hasOwn(card.publishers, pub.name) ? card.publishers[pub.name] : undefined;
          if (row) {
            line.row = row;
            if (pub?.public && row.key === pub.public) line.listed = true;
            else line.heldBy = row.key;
          }
        } catch (err) {
          line.cardError = err instanceof Error ? err.message : String(err);
        }
        out.push(line);
      }
      return out;
    },
    async ask(id, ask) {
      const problem = baseProblem(ask.base, { allowHttp: true });
      if (problem) throw new Error(`listing_invalid: ${problem}`);
      return send(id, {
        base: normalizeBase(ask.base),
        ...(ask.description?.trim() ? { description: ask.description.trim() } : {}),
        ...(ask.url?.trim() ? { url: ask.url.trim() } : {}),
        ...(ask.live !== undefined ? { live: ask.live } : {}),
      }, false);
    },
    async withdraw(id) {
      return send(id, {}, true);
    },
    async ping(key) {
      const asked = Object.values(await read()).filter((r) => r.status === "listed" || r.status === "pending");
      const subs = await deps.indexes.list();
      await Promise.allSettled(
        asked.map(async (r) => {
          const sub = subs.find((s) => s.id === r.index);
          const base = sub && baseOf(sub.urls);
          if (!base) return;
          const res = await doFetch(`${base}/index/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }), signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
          await res.body?.cancel();
        }),
      );
    },
  };
}
