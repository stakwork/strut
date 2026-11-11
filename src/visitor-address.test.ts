/**
 * Who a public request is from (src/visitor-address.ts): the socket's peer,
 * or `x-forwarded-for` only through a trusted proxy.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  DEFAULT_TRUSTED_PROXIES,
  plainAddress,
  trustedProxies,
  trustedProxiesFromEnv,
  visitorAddressFor,
  visitorOf,
} from "./visitor-address.js";

const DEFAULT = trustedProxies(DEFAULT_TRUSTED_PROXIES);

describe("visitorAddress", () => {
  it("a peer that is not a trusted proxy is the visitor: its x-forwarded-for is never read", () => {
    assert.equal(visitorOf("203.0.113.7", "1.2.3.4", DEFAULT), "203.0.113.7");
    assert.equal(visitorOf("203.0.113.7", "1.2.3.4, 10.0.0.1", DEFAULT), "203.0.113.7");
    assert.equal(visitorOf("2001:db8::7", "1.2.3.4", DEFAULT), "2001:db8::7");
  });

  it("through a trusted proxy, the header is walked from the right past trusted hops", () => {
    // The proxy appended `real`; `spoof` is what the client wrote.
    assert.equal(visitorOf("172.18.0.2", "6.6.6.6, 198.51.100.4", DEFAULT), "198.51.100.4");
    // Two proxies, both private: the first public hop from the right.
    assert.equal(visitorOf("172.18.0.2", "6.6.6.6, 198.51.100.4, 10.0.0.5", DEFAULT), "198.51.100.4");
    // Every hop trusted: the leftmost.
    assert.equal(visitorOf("127.0.0.1", "192.168.1.9, 10.0.0.5", DEFAULT), "192.168.1.9");
    // A trusted peer with no header (a local client): the peer.
    assert.equal(visitorOf("127.0.0.1", undefined, DEFAULT), "127.0.0.1");
    assert.equal(visitorOf("127.0.0.1", " , ", DEFAULT), "127.0.0.1");
    // A hop that is not an address is not a trusted proxy: it is the visitor.
    assert.equal(visitorOf("127.0.0.1", "unknown", DEFAULT), "unknown");
  });

  it("the default set: loopback, link-local, private — IPv4 and IPv6", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "169.254.1.1", "fe80::1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "fc00::1", "fd12:3456::1"]) {
      assert.equal(DEFAULT(ip), true, ip);
    }
    for (const ip of ["203.0.113.7", "172.32.0.1", "172.15.255.255", "8.8.8.8", "2001:db8::1", "::", "garbage", ""]) {
      assert.equal(DEFAULT(ip), false, ip);
    }
  });

  it("an IPv4-mapped peer is the IPv4 it maps, trusted or not", () => {
    assert.equal(plainAddress("::ffff:172.18.0.2"), "172.18.0.2");
    assert.equal(plainAddress("::FFFF:203.0.113.7"), "203.0.113.7");
    assert.equal(plainAddress("fe80::1%eth0"), "fe80::1");
    assert.equal(visitorOf("::ffff:172.18.0.2", "6.6.6.6, 198.51.100.4", DEFAULT), "198.51.100.4");
    assert.equal(visitorOf("::ffff:203.0.113.7", "1.2.3.4", DEFAULT), "203.0.113.7");
    // A mapped hop keys the same budget as its IPv4.
    assert.equal(visitorOf("10.0.0.1", "::ffff:198.51.100.4", DEFAULT), "198.51.100.4");
  });

  it("no socket (an in-process fetch) is unknown, the header unread", () => {
    assert.equal(visitorOf(undefined, "1.2.3.4", DEFAULT), "unknown");
  });

  it("STRUT_TRUSTED_PROXIES: unset is the default, `none` trusts nothing, a list replaces the set, a bad entry throws", () => {
    assert.equal(trustedProxiesFromEnv(undefined), undefined);
    assert.equal(trustedProxiesFromEnv("  "), undefined);
    assert.deepEqual(trustedProxiesFromEnv("none"), []);
    assert.deepEqual(trustedProxiesFromEnv(" NONE "), []);
    assert.deepEqual(trustedProxiesFromEnv("203.0.113.5, 10.1.0.0/16,,"), ["203.0.113.5", "10.1.0.0/16"]);

    const none = trustedProxies(trustedProxiesFromEnv("none")!);
    assert.equal(visitorOf("127.0.0.1", "1.2.3.4", none), "127.0.0.1");
    assert.equal(visitorOf("::ffff:172.18.0.2", "1.2.3.4", none), "172.18.0.2");

    const own = trustedProxies(trustedProxiesFromEnv("203.0.113.5, 10.1.0.0/16, 2001:db8::/32")!);
    assert.equal(visitorOf("203.0.113.5", "6.6.6.6, 198.51.100.4", own), "198.51.100.4");
    assert.equal(visitorOf("::ffff:203.0.113.5", "198.51.100.4", own), "198.51.100.4");
    assert.equal(visitorOf("10.1.9.9", "198.51.100.4", own), "198.51.100.4");
    assert.equal(visitorOf("2001:db8::1", "198.51.100.4", own), "198.51.100.4");
    // The default set is replaced, not added to.
    assert.equal(visitorOf("10.2.0.1", "198.51.100.4", own), "10.2.0.1");
    assert.equal(visitorOf("127.0.0.1", "198.51.100.4", own), "127.0.0.1");

    for (const bad of ["proxy.example", "10.0.0.0/33", "::/129", "10.0.0.1/8/1", "10.0.0.0/x", "*"]) {
      assert.throws(() => trustedProxies([bad]), /STRUT_TRUSTED_PROXIES: .* is not an IP address or a CIDR/, bad);
    }
  });

  it("reads the peer off the Node request's socket (`c.env.incoming`)", async () => {
    const app = new Hono();
    const who = visitorAddressFor(DEFAULT);
    app.get("/", (c) => c.text(who(c)));
    const from = async (peer: string | undefined, xff?: string) =>
      (await app.request("/", { headers: xff ? { "x-forwarded-for": xff } : {} }, peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined)).text();
    assert.equal(await from("203.0.113.7", "1.2.3.4"), "203.0.113.7");
    assert.equal(await from("::ffff:172.18.0.2", "6.6.6.6, 198.51.100.4"), "198.51.100.4");
    assert.equal(await from(undefined, "1.2.3.4"), "unknown");
  });
});
