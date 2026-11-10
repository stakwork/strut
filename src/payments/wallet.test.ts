/**
 * The wallet and the rate on a real server (createStrut): set from the
 * environment or by a person, its routes full scope only, and its
 * credentials out of every step's reach (plans/paid-runs.md decision 20,
 * Validation: "No step reads a wallet credential").
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { MemorySecretStore, secretBlanks } from "../secret-store.js";
import { signInTicket } from "../auth.js";
import type { StrutCapabilities } from "../capabilities.js";
import { FakeWallet } from "./fake-wallet.js";
import { lightningCapability } from "./lightning.js";
import { PAYMENTS_FILE, WALLET_ENV } from "./settings.js";
import type { ExchangeRate } from "./rate.js";

const KEY = "wallet-key";
const PEER = "wallet-peer-key";
const NWC_PK = "b".repeat(64);
const NWC_SECRET = "c".repeat(64);
const nwc = (secret = NWC_SECRET) => `nostr+walletconnect://${NWC_PK}?relay=${encodeURIComponent("ws://127.0.0.1:1")}&secret=${secret}`;
const json = { "content-type": "application/json" };
const keyed = { authorization: `Bearer ${KEY}` };

const CLEARED = [...WALLET_ENV, "STRUT_RATE_URL", "STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"];

describe("the wallet on a server", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    dir = join(tmpdir(), `strut-wallet-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    for (const k of CLEARED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(async () => {
    for (const k of CLEARED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const boot = (extra: Parameters<typeof createStrut>[0] = {}) =>
    createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      webDist: join(dir, "dist"),
      scheduler: false,
      ...extra,
    });
  const bag = (strut: { services: unknown }) => strut.services as StrutCapabilities & Record<string, unknown>;

  it("with no wallet set, the bag has no lightning and GET says so", async () => {
    const strut = await boot();
    try {
      assert.equal(bag(strut).lightning, undefined);
      assert.equal(strut.payments.lightning(), null);
      const res = await strut.app.request("/earnings/wallet");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { provider: null, receive: false, pay: false });
    } finally {
      await strut.close();
    }
  });

  it("the environment's wallet goes into payments.json at boot, its receive side onto the bag, its pay token nowhere a step reaches", async () => {
    process.env["LIGHTNING_DAEMON_URL"] = "http://127.0.0.1:1";
    process.env["LIGHTNING_DAEMON_TOKEN"] = "receive-tok-1";
    process.env["LIGHTNING_DAEMON_PAY_TOKEN"] = "pay-tok-1";
    const strut = await boot();
    try {
      const lightning = bag(strut).lightning!;
      assert.deepEqual(Object.keys(lightning).sort(), ["balance", "lookup", "makeInvoice", "received"]);
      assert.equal(lightning, strut.payments.lightning());
      const onFile = await strut.payments.settings.wallet();
      assert.equal(onFile?.provider, "sphinx");
      assert.equal(onFile?.provider === "sphinx" && onFile.payToken, "pay-tok-1", "kept for the payer");
      assert.equal(onFile?.from, "env");
      const raw = await readFile(join(dir, "ws", PAYMENTS_FILE), "utf8");
      assert.ok(!raw.includes("pay-tok-1") && !raw.includes("receive-tok-1"), "encrypted");

      const info = (await (await strut.app.request("/earnings/wallet")).json()) as Record<string, unknown>;
      assert.deepEqual(info, {
        provider: "sphinx",
        receive: true,
        pay: true,
        url: "http://127.0.0.1:1",
        from: "env",
        setAt: onFile!.setAt,
        note: "LIGHTNING_* in the environment sets the wallet again at the next boot",
      });
      // Nothing on the bag carries a wallet credential.
      for (const [name, value] of Object.entries(bag(strut))) {
        let text = "";
        try {
          text = JSON.stringify(value) ?? "";
        } catch {}
        assert.ok(!text.includes("pay-tok-1") && !text.includes("receive-tok-1"), name);
      }
    } finally {
      await strut.close();
    }
    // A second boot with the same environment keeps the record as it was.
    const again = await boot();
    try {
      const w = await again.payments.settings.wallet();
      assert.equal(w?.provider, "sphinx");
    } finally {
      await again.close();
    }
  });

  it("no step reads a wallet credential: secrets.get of every LIGHTNING_* name, and of STRUT_SECRET_KEY, answers nothing, wherever it is held", async () => {
    for (const k of WALLET_ENV) process.env[k] = k === "LIGHTNING_DAEMON_URL" ? "http://127.0.0.1:1" : k.startsWith("LIGHTNING_NWC") ? "" : `env-${k}`;
    delete process.env["LIGHTNING_NWC_URL"];
    delete process.env["LIGHTNING_NWC_PAY_URL"];
    const secretStore = new MemorySecretStore();
    const strut = await boot({ secretStore });
    try {
      // Held in the deployment's store too, as if written there behind the routes' back.
      for (const k of WALLET_ENV) await secretStore.set(k, `store-${k}`);
      await secretStore.set("OTHER_KEY", "other");
      const secrets = bag(strut).secrets;
      process.env["STRUT_SECRET_KEY"] = "the-key-to-payments-json";
      // The credit tokens' root (item 5) is payments.json's too.
      await secretStore.set("L402_ROOT", "ab".repeat(32));
      for (const k of [...WALLET_ENV, "LIGHTNING_ANYTHING", "lightning_daemon_token", "STRUT_SECRET_KEY", "L402_ROOT"]) {
        assert.equal(await secrets.get(k), undefined, k);
        assert.equal(await secrets.forPrincipal?.("tom")?.get(k), undefined, `${k} for a principal`);
      }
      assert.equal(await secrets.get("OTHER_KEY"), "other", "every other name as before");

      // And no person puts one there: the route and an app's fill refuse.
      const put = await strut.app.request("/secrets/LIGHTNING_DAEMON_PAY_TOKEN", { method: "PUT", headers: json, body: JSON.stringify({ value: "x" }) });
      assert.equal(put.status, 400);
      assert.match(((await put.json()) as { error: string }).error, /PUT \/earnings\/wallet/);
      await assert.rejects(secretBlanks(new MemorySecretStore(), () => ({})).fill("LIGHTNING_NWC_URL", "x"), /never by a step/);
      assert.equal((await strut.app.request("/secrets/STRUT_SECRET_KEY", { method: "PUT", headers: json, body: JSON.stringify({ value: "x" }) })).status, 400);
      assert.equal((await strut.app.request("/secrets/L402_ROOT", { method: "PUT", headers: json, body: JSON.stringify({ value: "x" }) })).status, 400);
    } finally {
      await strut.close();
    }
  });

  it("a host's own secrets capability hides them too", async () => {
    process.env["LIGHTNING_NWC_URL"] = nwc();
    const strut = await boot({ services: { secrets: { get: async (n: string) => `host-${n}` } } as never });
    try {
      assert.equal(await bag(strut).secrets.get("LIGHTNING_NWC_URL"), undefined);
      assert.equal(await bag(strut).secrets.get("GITHUB_TOKEN"), "host-GITHUB_TOKEN");
      assert.equal(strut.payments.lightning() !== null, true, "the NWC wallet is set");
    } finally {
      await strut.close();
    }
  });

  it("a person sets, changes and removes the wallet; the bag follows; a refusal leaves what is on file", async () => {
    const strut = await boot();
    try {
      const put = (body: unknown) => strut.app.request("/earnings/wallet", { method: "PUT", headers: json, body: JSON.stringify(body) });
      const r1 = await put({ provider: "nwc", url: nwc() });
      assert.equal(r1.status, 200);
      const a1 = (await r1.json()) as Record<string, unknown>;
      assert.equal(a1["provider"], "nwc");
      assert.equal(a1["pay"], false);
      assert.deepEqual(a1["relays"], ["127.0.0.1:1"]);
      assert.equal((a1["check"] as { ok: boolean }).ok, false, "a relay that is not there fails the check, and the wallet is set anyway");
      assert.ok(!JSON.stringify(a1).includes(NWC_SECRET));
      const first = bag(strut).lightning;
      assert.ok(first);

      const r2 = await put({ provider: "nwc", payUrl: nwc("d".repeat(64)) });
      assert.equal(((await r2.json()) as { pay: boolean }).pay, true, "a pay connection added, the receive one kept");
      assert.equal((await strut.payments.settings.wallet())?.provider, "nwc");

      const bad = await put({ provider: "sphinx", url: "ftp://nope", token: "t" });
      assert.equal(bad.status, 400);
      assert.equal((await strut.payments.settings.wallet())?.provider, "nwc", "unchanged");

      const r3 = await put({ provider: null });
      assert.deepEqual(await r3.json(), { provider: null, receive: false, pay: false });
      assert.equal(bag(strut).lightning, undefined);
      assert.equal(strut.payments.lightning(), null);
    } finally {
      await strut.close();
    }
  });

  it("full scope only: the key and an admin's session pass; a peer's read, a peer's write and a member are refused", async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER;
    const strut = await boot();
    try {
      assert.equal((await strut.app.request("/earnings/wallet")).status, 401);
      assert.equal((await strut.app.request("/earnings/wallet", { headers: keyed })).status, 200);
      assert.equal((await strut.app.request("/earnings/wallet", { headers: { authorization: `Bearer ${PEER}` } })).status, 403, "a peer reads every route but this");
      assert.equal((await strut.app.request("/earnings/wallet", { method: "PUT", headers: { authorization: `Bearer ${PEER}`, ...json }, body: "{}" })).status, 403);

      const session = async (role: "admin" | "member") => {
        const { ticket } = signInTicket(`${role}-1`, role)!;
        const traded = await strut.app.request("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
        return { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1" };
      };
      assert.equal((await strut.app.request("/earnings/wallet", { headers: await session("admin") })).status, 200);
      assert.equal((await strut.app.request("/earnings/wallet", { headers: await session("member") })).status, 403);
      const adminPut = await strut.app.request("/earnings/wallet", { method: "PUT", headers: { ...(await session("admin")), ...json }, body: JSON.stringify({ provider: "nwc", url: nwc() }) });
      assert.equal(adminPut.status, 200);
    } finally {
      await strut.close();
    }
  });

  it("a host's own services.lightning wins: the routes answer 501 and strut never replaces it", async () => {
    process.env["LIGHTNING_NWC_URL"] = nwc();
    const host = lightningCapability(new FakeWallet());
    const strut = await boot({ services: { lightning: host } as never });
    try {
      assert.equal(bag(strut).lightning, host);
      assert.equal(strut.payments.lightning(), host);
      assert.equal(await strut.payments.settings.wallet(), null, "the environment's wallet is not written");
      assert.equal((await strut.app.request("/earnings/wallet")).status, 501);
      assert.equal((await strut.app.request("/earnings/wallet", { method: "PUT", headers: json, body: JSON.stringify({ provider: null }) })).status, 501);
      await assert.rejects(strut.payments.setWallet(null));
    } finally {
      await strut.close();
    }
  });

  it("a bad LIGHTNING_* or STRUT_RATE_URL fails the boot", async () => {
    process.env["LIGHTNING_DAEMON_URL"] = "http://127.0.0.1:1";
    process.env["LIGHTNING_DAEMON_TOKEN"] = "rt";
    process.env["LIGHTNING_NWC_URL"] = nwc();
    await assert.rejects(boot(), /both set/);
    delete process.env["LIGHTNING_NWC_URL"];
    process.env["STRUT_RATE_URL"] = "ftp://rates";
    await assert.rejects(boot(), /STRUT_RATE_URL/);
  });

  it("the rate: a host's function in place of mempool.space, read through strut.payments", async () => {
    const reading: ExchangeRate = { usdPerBtc: 73_176, at: "2026-11-10T18:50:08.000Z", source: "host" };
    let calls = 0;
    const strut = await boot({
      payments: {
        rate: async () => {
          calls++;
          return reading;
        },
      },
    });
    try {
      assert.deepEqual(await strut.payments.rate.read(), reading);
      await strut.payments.rate.read();
      assert.equal(calls, 1, "kept for a minute");
      assert.equal((bag(strut) as Record<string, unknown>)["rate"], undefined, "not on the services bag");
    } finally {
      await strut.close();
    }
  });
});
