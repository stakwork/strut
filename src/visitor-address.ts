/**
 * Who a public request is from (`visitorAddress`): the key every
 * per-address budget on the public surface counts under — the requests,
 * the launches, the tool calls, the credit challenge's invoices and claims.
 * A budget, not a boundary.
 *
 * The socket's peer is the visitor, unless that peer is a TRUSTED PROXY:
 * then `x-forwarded-for` says whom it forwarded for. The header is walked
 * from the right (the hop the nearest proxy appended), trusted hops
 * skipped, and the first one that is not a trusted proxy is the visitor;
 * every hop trusted, the leftmost. A client that reaches strut with no
 * trusted proxy in between is its socket's address: whatever it writes in
 * the header is never read. No socket (an in-process `app.fetch`) is
 * `unknown`, the header unread.
 *
 * Trusted by default: loopback, link-local and private addresses (RFC 1918,
 * IPv6 unique-local) — Express's `loopback, linklocal, uniquelocal`. A
 * proxy on the same box or the same container network reaches strut from
 * one of those, and trusting none of them would put every visitor behind
 * it in ONE budget. `STRUT_TRUSTED_PROXIES` (`StrutOptions.trustedProxies`)
 * replaces the set: comma-separated IPs and CIDRs, `none` for nothing. A
 * server that untrusted clients reach from a private address (a LAN, a
 * shared container network) without a proxy names its proxy exactly, or
 * `none`.
 */
import { BlockList, isIP } from "node:net";
import type { Context } from "hono";

export const TRUSTED_PROXIES_ENV = "STRUT_TRUSTED_PROXIES";

/** Loopback, link-local, private (RFC 1918, IPv6 unique-local). */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  "127.0.0.0/8",
  "::1/128",
  "169.254.0.0/16",
  "fe80::/10",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
];

/** Is this (plain) address a trusted proxy's? */
export type TrustedProxies = (address: string) => boolean;

/** An address as one client's key: IPv4-mapped IPv6 (`::ffff:10.0.0.2`) as
 *  the IPv4 it maps, a zone (`%eth0`) dropped, lower case. */
export function plainAddress(address: string): string {
  const a = address.trim().toLowerCase().replace(/%.*$/, "");
  return /^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(a) ? a.slice(7) : a;
}

/** The set of IPs and CIDRs as a check. A bad entry throws: a boot with a
 *  proxy list it cannot read stops rather than guessing. */
export function trustedProxies(list: readonly string[]): TrustedProxies {
  const set = new BlockList();
  for (const raw of list) {
    const entry = raw.trim();
    const [ip = "", bits, extra] = entry.split("/");
    const family = isIP(ip);
    const max = family === 4 ? 32 : 128;
    if (!family || extra !== undefined || (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))) {
      throw new Error(`${TRUSTED_PROXIES_ENV}: "${entry}" is not an IP address or a CIDR (comma-separated, or "none")`);
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) set.addAddress(ip, type);
    else set.addSubnet(ip, Number(bits), type);
  }
  return (address) => {
    const family = isIP(address);
    return family !== 0 && set.check(address, family === 4 ? "ipv4" : "ipv6");
  };
}

/** `STRUT_TRUSTED_PROXIES` as a list: unset or blank is undefined (the
 *  default set), `none` is [], else its comma-separated entries. */
export function trustedProxiesFromEnv(raw: string | undefined): string[] | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  if (s.toLowerCase() === "none") return [];
  return s.split(",").map((e) => e.trim()).filter(Boolean);
}

/** The visitor, from the socket's peer and `x-forwarded-for` as sent. */
export function visitorOf(peer: string | undefined, forwardedFor: string | undefined, trusted: TrustedProxies): string {
  if (!peer) return "unknown";
  const self = plainAddress(peer);
  if (!trusted(self)) return self;
  const hops = (forwardedFor ?? "").split(",").map(plainAddress).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusted(hops[i]!)) return hops[i]!;
  return hops[0] ?? self;
}

/** `visitorAddress(c)` over this set of proxies. The peer is the Node
 *  request's socket (`c.env.incoming`, as `@hono/node-server` and a host's
 *  bridge to it hand over). */
export function visitorAddressFor(trusted: TrustedProxies): (c: Context) => string {
  return (c) => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return visitorOf(incoming?.socket?.remoteAddress, c.req.header("x-forwarded-for"), trusted);
  };
}

/** Over the default set: for a `publicRoutes` nobody handed one. */
export const defaultVisitorAddress = visitorAddressFor(trustedProxies(DEFAULT_TRUSTED_PROXIES));
