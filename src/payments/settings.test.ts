import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, MemorySecretStore } from "../secret-store.js";
import { PAYMENTS_FILE, PaymentsSettings, checkWalletUpdate, walletFromEnv, walletInfo, type WalletSettings } from "./settings.js";
import { parseNwcUrl } from "./nwc-url.js";

const PK = "b".repeat(64);
const SECRET = "c".repeat(64);
const PAY_SECRET = "d".repeat(64);
const nwc = (secret = SECRET, relay = "wss://relay.example.com") => `nostr+walletconnect://${PK}?relay=${encodeURIComponent(relay)}&secret=${secret}`;

describe("the wallet's settings", () => {
  it("reads the environment's wallet: the daemon, NWC, or none — and refuses half of one or both", () => {
    assert.equal(walletFromEnv({}), null);
    assert.deepEqual(walletFromEnv({ LIGHTNING_DAEMON_URL: "http://treasury:3000/", LIGHTNING_DAEMON_TOKEN: "rt", LIGHTNING_DAEMON_PAY_TOKEN: "pt" }), {
      provider: "sphinx",
      url: "http://treasury:3000",
      token: "rt",
      payToken: "pt",
    });
    assert.deepEqual(walletFromEnv({ LIGHTNING_NWC_URL: nwc() }), { provider: "nwc", url: nwc() });
    assert.deepEqual(walletFromEnv({ LIGHTNING_NWC_URL: nwc(), LIGHTNING_NWC_PAY_URL: nwc(PAY_SECRET) }), { provider: "nwc", url: nwc(), payUrl: nwc(PAY_SECRET) });
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{ LIGHTNING_DAEMON_URL: "http://t" }, /LIGHTNING_DAEMON_TOKEN/],
      [{ LIGHTNING_DAEMON_TOKEN: "rt" }, /LIGHTNING_DAEMON_URL/],
      [{ LIGHTNING_DAEMON_PAY_TOKEN: "pt" }, /LIGHTNING_DAEMON_URL/],
      [{ LIGHTNING_NWC_PAY_URL: nwc(PAY_SECRET) }, /LIGHTNING_NWC_URL/],
      [{ LIGHTNING_DAEMON_URL: "http://t", LIGHTNING_DAEMON_TOKEN: "rt", LIGHTNING_NWC_URL: nwc() }, /both/],
      [{ LIGHTNING_DAEMON_URL: "ftp://t", LIGHTNING_DAEMON_TOKEN: "rt" }, /LIGHTNING_\*: .*http/],
      [{ LIGHTNING_NWC_URL: "nostr+walletconnect://nope" }, /LIGHTNING_\*/],
      [{ LIGHTNING_DAEMON_URL: "http://t", LIGHTNING_DAEMON_TOKEN: "same", LIGHTNING_DAEMON_PAY_TOKEN: "same" }, /pay token is the receive token/],
    ];
    for (const [env, re] of refused) assert.throws(() => walletFromEnv(env), re, JSON.stringify(env));
    // A refusal names the field, never a value.
    try {
      walletFromEnv({ LIGHTNING_NWC_URL: nwc().replace(SECRET, "zz") });
      assert.fail("refused");
    } catch (err) {
      assert.ok(!(err as Error).message.includes(PK) && !(err as Error).message.includes("zz"));
    }
  });

  it("a person's update: a new provider needs every field, the same one keeps what is left out, null removes a pay credential", () => {
    const daemon = { provider: "sphinx" as const, url: "http://t", token: "rt" };
    assert.deepEqual(checkWalletUpdate(daemon, null), daemon);
    assert.throws(() => checkWalletUpdate({ provider: "sphinx", url: "http://t" }, null), /receive token/);
    assert.deepEqual(checkWalletUpdate({ provider: "sphinx", payToken: "pt" }, daemon), { ...daemon, payToken: "pt" }, "a pay token added without the receive one again");
    assert.deepEqual(checkWalletUpdate({ provider: "sphinx", payToken: null }, { ...daemon, payToken: "pt" }), daemon);
    assert.throws(() => checkWalletUpdate({ provider: "nwc" }, daemon), /NWC connection url/, "another provider starts from nothing");
    assert.equal(checkWalletUpdate({ provider: null }, daemon), null);
    assert.throws(() => checkWalletUpdate({ provider: "sphinx", token: "rt", secret: "x" }, daemon), /not secret/);
    assert.throws(() => checkWalletUpdate({ provider: "lnd" }, null), /provider must be/);
    assert.throws(() => checkWalletUpdate("nope", null), /body/);
    assert.throws(() => checkWalletUpdate({ provider: "nwc", url: nwc(), payUrl: nwc() }, null), /pay connection is the receive connection/);
  });

  it("what a route may show names the provider and what it can do, never a credential", () => {
    const at = { from: "api" as const, setAt: "2026-11-10T00:00:00.000Z" };
    const sphinx: WalletSettings = { provider: "sphinx", url: "http://treasury:3000", token: "rt-secret", payToken: "pt-secret", ...at };
    assert.deepEqual(walletInfo(sphinx), { provider: "sphinx", receive: true, pay: true, url: "http://treasury:3000", ...at });
    const n: WalletSettings = { provider: "nwc", url: nwc(SECRET, "wss://relay.example.com/?auth=relay-secret"), ...at };
    const info = walletInfo(n);
    assert.deepEqual(info, { provider: "nwc", receive: true, pay: false, relays: ["relay.example.com"], ...at });
    for (const shown of [JSON.stringify(walletInfo(sphinx)), JSON.stringify(info)]) {
      for (const secret of ["rt-secret", "pt-secret", SECRET, "relay-secret"]) assert.ok(!shown.includes(secret), secret);
    }
    assert.deepEqual(walletInfo(null), { provider: null, receive: false, pay: false });
  });

  describe("payments.json", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-payments-"));
    });
    after(() => rm(dir, { recursive: true, force: true }));

    it("keeps the wallet encrypted in its own file beside the deployment's secrets, across a restart", async () => {
      const settings = new PaymentsSettings(new FileSecretStore(dir, PAYMENTS_FILE));
      assert.equal(await settings.wallet(), null);
      const w: WalletSettings = { provider: "sphinx", url: "http://t", token: "receive-tok-123", payToken: "pay-tok-456", from: "env", setAt: "2026-11-10T00:00:00.000Z" };
      await settings.setWallet(w);
      assert.deepEqual(await new PaymentsSettings(new FileSecretStore(dir, PAYMENTS_FILE)).wallet(), w, "a new process reads it back");
      const raw = await readFile(join(dir, PAYMENTS_FILE), "utf8");
      assert.ok(!raw.includes("receive-tok-123") && !raw.includes("pay-tok-456") && !raw.includes("http://t"), "nothing in clear");
      await assert.rejects(readFile(join(dir, "secrets.json"), "utf8"), "never the deployment's secrets file");
      await settings.setWallet(null);
      assert.equal(await settings.wallet(), null);
    });

    it("L402_ROOT: none until minted, 32 random bytes once minted, read back by a new process, never replaced", async () => {
      const settings = new PaymentsSettings(new FileSecretStore(dir, PAYMENTS_FILE));
      assert.equal(await settings.l402Root(), null);
      const [a, b] = await Promise.all([settings.ensureL402Root(), settings.ensureL402Root()]);
      assert.equal(a.length, 32);
      assert.deepEqual(a, b, "two at once mint one");
      assert.deepEqual(await settings.ensureL402Root(), a, "never replaced");
      assert.deepEqual(await new PaymentsSettings(new FileSecretStore(dir, PAYMENTS_FILE)).l402Root(), a, "a new process reads it back");
      assert.ok(!(await readFile(join(dir, PAYMENTS_FILE), "utf8")).includes(a.toString("hex")), "not in clear");
      const bad = new MemorySecretStore();
      await bad.set("L402_ROOT", "not hex");
      const s = new PaymentsSettings(bad);
      assert.equal(await s.l402Root(), null);
      await assert.rejects(s.ensureL402Root(), /fix or remove it by hand/, "a bad root is never silently replaced");
    });

    it("a wallet on file that no longer parses is no wallet, said once", async () => {
      const store = new MemorySecretStore();
      await store.set("WALLET", "{ not json");
      assert.equal(await new PaymentsSettings(store).wallet(), null);
    });
  });

  it("parses an NWC URL: wallet pubkey, relays, secret — wss only, but ws on this machine", () => {
    const c = parseNwcUrl(`${nwc()}&relay=${encodeURIComponent("wss://two.example")}&lud16=a%40b.c`);
    assert.deepEqual(c, { walletPubkey: PK, relays: ["wss://relay.example.com", "wss://two.example"], secret: SECRET, lud16: "a@b.c" });
    assert.equal(parseNwcUrl(nwc(SECRET, "ws://127.0.0.1:7777")).relays[0], "ws://127.0.0.1:7777");
    for (const bad of [nwc(SECRET, "ws://relay.example.com"), nwc("short"), `nostr+walletconnect://${PK}?secret=${SECRET}`, "https://x", `nostr+walletconnect://xyz?relay=wss%3A%2F%2Fa&secret=${SECRET}`]) {
      assert.throws(() => parseNwcUrl(bad), bad);
    }
  });
});
