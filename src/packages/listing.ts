/**
 * The LISTING request (plans/index-listing.md §1): what a publisher strut
 * sends an index to ask for its name — a small card sealed by the
 * publisher's PUBLIC key under `strut-listing\n`, the third kind of card
 * beside a catalog and an index (./card.ts). It names the index it is for,
 * the prefix, the key the row will carry, and the server's BASE — never a
 * catalog URL: the index builds the one URL it reads,
 * `<base>/packages/catalog?public=1`, so a link on a trusted host that
 * opens with a token can never pass as that host's catalog.
 *
 * Pure: shapes, the base and host rules, the seal and the read. The
 * index's side (the queue, the decision) is ./index-requests.ts; the
 * publisher's (its asks) ./publisher-listings.ts.
 */
import type { KeyObject } from "node:crypto";
import { CARD_VERSION, PUBLISHER_PREFIX, Z32_KEY, canonicalJson, fingerprintOf, sealCard, sealVerifies, type UnsignedCatalog } from "./card.js";

/** The largest request an index reads. */
export const LISTING_MAX_BYTES = 8 * 1024;
/** How far a request's `seq` may be from the index's clock. */
export const LISTING_FRESH_MS = 10 * 60_000;
/** The longest description a request may carry. */
export const LISTING_DESCRIPTION_MAX = 280;

export interface UnsignedListing {
  v: number;
  /** The key of the index it is sent to: a request for one index never works on another. */
  index: string;
  /** The publisher's name, the first segment of its packages. */
  prefix: string;
  /** The PUBLIC key the row will name, which seals this request. */
  key: string;
  /** Where the server is reached: an origin and at most one path segment (a mount, `/lab`). */
  base?: string;
  description?: string;
  /** A homepage. */
  url?: string;
  /** `true`: take the row away. Nothing else is read. */
  remove?: true;
  /** `true`: also list the server's public view (a live row at the base); `false`: drop it. */
  live?: boolean;
  /** Microseconds since the epoch at signing. */
  seq: number;
}

export interface Listing extends UnsignedListing {
  sig: string;
}

const MEMBERS = new Set(["v", "index", "prefix", "key", "base", "description", "url", "remove", "live", "seq", "sig"]);
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** A base as a request names it, checked: `https` (or `http`, on an index
 *  that allows it — tests, a LAN), no credentials, no query, no fragment,
 *  the root or one path segment. */
export function baseProblem(base: unknown, opts: { allowHttp?: boolean } = {}): string | undefined {
  if (typeof base !== "string" || base.length > 500) return "base is the server's address: an https origin and at most one path segment (https://<swarm>:3355/lab)";
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return `base ${JSON.stringify(base)} is not a URL`;
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return `base ${JSON.stringify(base)} is not https`;
  if (u.username || u.password) return "base carries no credentials";
  // An open route makes the index fetch it: a public name only, never an
  // address or a name inside a network (a LAN index allows them with http).
  const host = u.hostname.toLowerCase();
  if (!opts.allowHttp && (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || /\.(local|localhost|internal|lan|home\.arpa)$/.test(host))) {
    return `base ${JSON.stringify(base)} is not a public name: an index reads only a server it can reach by its name over https`;
  }
  if (u.search || u.hash || base.includes("?") || base.includes("#")) return "base has no query and no fragment: the index builds the catalog's URL itself";
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length > 1 || !segments.every((s) => SEGMENT.test(s))) return "base is the server's root or its mount: at most one path segment (/lab)";
  return undefined;
}

/** A base in its one form: origin and the mount, no trailing slash. */
export function normalizeBase(base: string): string {
  const u = new URL(base);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** The ONE URL the index reads for a base: strut's public catalog route,
 *  which serves the public catalog and nothing else with that query. */
export const catalogUrlOf = (base: string): string => `${normalizeBase(base)}/packages/catalog?public=1`;

/** The host of a URL as patterns match it: the hostname, lowercase, and
 *  the port when it is not the scheme's default. */
export function hostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

/** An auto host pattern as an operator writes it, checked: `*`, an exact
 *  `host[:port]`, or `*.domain[:port]` (one label in front). */
export function hostPatternProblem(pattern: unknown): string | undefined {
  if (typeof pattern !== "string" || !pattern) return "a host pattern is a string";
  if (pattern === "*") return undefined;
  const p = pattern.toLowerCase();
  const rest = p.startsWith("*.") ? p.slice(2) : p;
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(rest) || rest.startsWith(".") || rest.includes("..")) return `${JSON.stringify(pattern)} is not a host pattern: *, host[:port] or *.domain[:port]`;
  return undefined;
}

/** Whether a host (`hostOf`) matches a pattern. A pattern with no port
 *  matches the scheme's default port only; `*.domain` matches exactly one
 *  label in front of it. */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === "*") return true;
  if (!p.startsWith("*.")) return p === h;
  const rest = p.slice(1); // ".domain[:port]"
  if (!h.endsWith(rest)) return false;
  const label = h.slice(0, -rest.length);
  return label.length > 0 && !label.includes(".") && !label.includes(":");
}

/** A request as received, checked for shape (not its seal), or the reason it is not one. */
export function listingProblem(card: unknown, opts: { allowHttp?: boolean } = {}): string | undefined {
  const r = card as Partial<Listing> | undefined;
  if (!r || typeof r !== "object" || Array.isArray(r)) return "a listing request is a JSON object";
  const extra = Object.keys(r).find((k) => !MEMBERS.has(k));
  if (extra) return `${JSON.stringify(extra)} is not a member of a listing request`;
  if (r.v !== CARD_VERSION) return `v is ${CARD_VERSION}`;
  if (typeof r.index !== "string" || !Z32_KEY.test(r.index)) return "index is the index's key in z-base-32";
  if (typeof r.prefix !== "string" || !PUBLISHER_PREFIX.test(r.prefix)) return "prefix is the publisher's name: [a-z][a-z0-9-]*, at most 64 characters";
  if (typeof r.key !== "string" || !Z32_KEY.test(r.key)) return "key is the publisher's PUBLIC key in z-base-32";
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 0) return "seq is microseconds since the epoch";
  if (typeof r.sig !== "string" || !/^[0-9a-f]{128}$/.test(r.sig)) return "sig is the seal, 128 hex";
  if (r.remove !== undefined && r.remove !== true) return "remove is true, or absent";
  if (r.live !== undefined && typeof r.live !== "boolean") return "live is true or false";
  if (r.remove) return r.base === undefined ? undefined : baseProblem(r.base, opts);
  const bad = baseProblem(r.base, opts);
  if (bad) return bad;
  if (r.description !== undefined && (typeof r.description !== "string" || r.description.length > LISTING_DESCRIPTION_MAX)) return `description is a string of at most ${LISTING_DESCRIPTION_MAX} characters`;
  if (r.url !== undefined && (typeof r.url !== "string" || r.url.length > 500 || !/^https?:\/\/\S+$/.test(r.url))) return "url is a homepage, an http(s) URL";
  return undefined;
}

/** A request sealed by the publisher's public key (`privateKey` is its seed's). */
export function sealListing(card: UnsignedListing, privateKey: KeyObject): Listing {
  return sealCard(card, privateKey, "listing");
}

/** The fingerprint of a request: its id in the index's queue. */
export const listingId = (card: UnsignedListing): string => fingerprintOf(card as unknown as UnsignedCatalog).replace(/^sha256:/, "");

/**
 * A request as an index reads it — its size, one byte form, its shape,
 * then the seal by its own `key` — or a `listing_invalid:` error naming
 * what failed. Freshness, the index's key and the order are the index's
 * checks (./index-requests.ts).
 */
export function readListing(bytes: string, opts: { allowHttp?: boolean } = {}): Listing {
  if (Buffer.byteLength(bytes, "utf8") > LISTING_MAX_BYTES) throw new Error(`listing_invalid: a listing request is at most ${LISTING_MAX_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (err) {
    throw new Error(`listing_invalid: not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problem = listingProblem(parsed, opts);
  if (problem) throw new Error(`listing_invalid: ${problem}`);
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch (err) {
    throw new Error(`listing_invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (canonical !== bytes) throw new Error("listing_invalid: the request is not in its RFC 8785 form, the only one an index reads");
  const card = parsed as Listing;
  if (!sealVerifies(card, card.key, "listing")) throw new Error(`listing_invalid: the seal is not ${card.key}'s over this listing request`);
  return card;
}

/** A per-address budget for an open route: `allow(who)` is false past
 *  `limit` a minute. A budget, not a boundary. */
export function perMinute(limit: number, now: () => number = Date.now): { allow(who: string): boolean } {
  const counts = new Map<string, { minute: number; n: number }>();
  return {
    allow(who) {
      const minute = Math.floor(now() / 60_000);
      const at = counts.get(who);
      if (!at || at.minute !== minute) {
        if (counts.size > 10_000) for (const [k, v] of counts) if (v.minute !== minute) counts.delete(k);
        counts.set(who, { minute, n: 1 });
        return true;
      }
      return ++at.n <= limit;
    },
  };
}
