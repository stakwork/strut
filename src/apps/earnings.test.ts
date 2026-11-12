import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut, type Strut } from "../createStrut.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appIdentity, fileToken, signInTicket } from "../auth.js";
import { treeHash } from "../version.js";
import { hostConfigFromEnv } from "../server.js";
import { FakePayer, FakeWallet } from "../payments/fake-wallet.js";
import { lightningCapability } from "../payments/lightning.js";
import type { ExchangeRate } from "../payments/rate.js";
import { kitForTests } from "../test-util/app-kit.js";
import type { KitLocation } from "./kit.js";
import { STEP_RUN_TOOL } from "./tools.js";
import { EARNINGS_APP, EARNINGS_DIR, seedEarningsApp } from "./earnings-seed.js";
import { addBlocked, decidesByHand, depositAmount, pendingState, walletLine, withdrawBlocked, type PendingSend } from "./earnings/src/lib/view.js";
import readInvoiceStep from "../steps/lib/earnings/read-invoice.js";
import walletStep from "../steps/lib/earnings/wallet.js";
import { encodeBolt11 } from "../payments/bolt11.js";

/**
 * `strut/earnings` (specs/API.md §14.14): strut's Earnings tab as an app a
 * host frames for an admin. Its words; its seed; that it is an ADMIN's —
 * left out of a member's `GET /apps`, its files refused short of full scope;
 * and that its `earnings/*` steps reach the routes in process for strut's
 * own page shown to an admin, and for nothing else.
 */

const KEY = "earnings-app-key";
const RATE = 100_000;
const quiet = { serveUi: false, enableChat: false, enableMcp: true, scheduler: false } as const;
const seedsOff = { views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false } as const;

describe("strut/earnings: its words", () => {
  const pending = (p: Partial<PendingSend>): PendingSend => ({ paymentHash: "ab".repeat(32), msat: 1000, at: 0, purpose: "withdrawal", payer: "sphinx:x", stale: false, reading: false, otherWallet: false, ...p });

  it("Withdraw and Add sats say why they are off; the wallet in a line names who sets it", () => {
    assert.match(withdrawBlocked({ provider: null, receive: false, pay: false })!, /No wallet/);
    assert.match(withdrawBlocked({ provider: "sphinx", receive: true, pay: false })!, /pay credential/);
    assert.equal(withdrawBlocked({ provider: "sphinx", receive: true, pay: true }), null);
    assert.match(addBlocked(undefined)!, /receives/);
    assert.equal(addBlocked({ receive: true }), null);
    assert.equal(walletLine({ provider: "sphinx", receive: true, pay: true, url: "http://treasury:8095", env: true }), "Sphinx daemon at http://treasury:8095, set by this server's deployment.");
    assert.match(walletLine({ provider: null, receive: false, pay: false }), /No wallet/);
    assert.match(walletLine({ provider: null, receive: true, pay: false, host: true }), /host provides/);
  });

  it("a send still out: where it stands, and when a person decides it by hand", () => {
    assert.match(pendingState(pending({ reading: true })), /being read/);
    assert.match(pendingState(pending({ stale: true })), /stale/);
    assert.match(pendingState(pending({ answered: true })), /not settled yet/);
    assert.match(pendingState(pending({})), /never answered/);
    assert.equal(decidesByHand(pending({ stale: true })), true);
    assert.equal(decidesByHand(pending({ otherWallet: true })), true);
    assert.equal(decidesByHand(pending({})), false);
  });

  it("an Add sats amount: whole sats within the server's limit", () => {
    assert.deepEqual(depositAmount("50,000"), { sats: 50_000 });
    assert.deepEqual(depositAmount(""), { error: "" });
    assert.match((depositAmount("1.5") as { error: string }).error, /whole number/);
    assert.match((depositAmount("0") as { error: string }).error, /At least/);
    assert.match((depositAmount("20000000") as { error: string }).error, /At most/);
  });
});

describe("strut/earnings: the steps outside its page", () => {
  it("earnings/read-invoice reads an invoice with the tab's reader, paying nothing", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const inv = encodeBolt11({ msat: 10_000_000, paymentHash: "ab".repeat(32), timestamp: nowS, expirySecs: 600, description: "to cold storage" });
    const r = (await readInvoiceStep.run({ invoice: inv, balanceMsat: 20_000_000, usdPerBtc: RATE }, {} as never)) as { ok: boolean; msat: number; maxFeeMsat: number; usd: number };
    assert.deepEqual([r.ok, r.msat, r.maxFeeMsat, r.usd], [true, 10_000_000, 50_000, 10]);
  });

  it("an admin door step refuses a workflow, a model-written page, a member's view of strut's own, and a call with no door", async () => {
    const door = { earningsAdmin: { call: async () => ({ ok: true, status: 200, body: { provider: null } }) } };
    const run = (ctx: object) => walletStep.run({}, { services: door, ...ctx } as never);
    await assert.rejects(() => run({}), /an admin's/);
    await assert.rejects(() => run({ app: { name: "acme/x", version: "v1", admin: true } }), /an admin's/);
    await assert.rejects(() => run({ app: { name: EARNINGS_APP, version: "v1", firstParty: true } }), /an admin's/);
    await assert.rejects(
      () => walletStep.run({}, { app: { name: EARNINGS_APP, version: "v1", firstParty: true, admin: true }, services: {} } as never),
      /door is not on this call/,
    );
    assert.deepEqual(await run({ app: { name: EARNINGS_APP, version: "v1", firstParty: true, admin: true } }), { provider: null });
  });
});

describe("strut/earnings — seeded, an admin's, and its page's calls", () => {
  let kit: KitLocation;
  let strut: Strut;
  let saved: string | undefined;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  /** This server's wallet, a payer for it, and the wallet a withdrawal goes to. */
  const wallet = new FakeWallet({ bolt11: true, startMsat: 50_000_000 });
  const payer = new FakePayer();
  const elsewhere = new FakeWallet({ bolt11: true });

  before(async () => {
    kit = await kitForTests();
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    strut = await createStrut({
      ...quiet,
      ...seedsOff,
      workspace: new FileWorkspaceStore(await tmp("strut-earnings-app-")),
      store: new MemoryRunStore(),
      kit,
      services: { lightning: lightningCapability(wallet) },
      payments: { payer, rate: async (): Promise<ExchangeRate> => ({ usdPerBtc: RATE, at: new Date().toISOString(), source: "test" }) },
    });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${KEY}` };
  /** A session from a host's ticket: role admin, member (none named). */
  const signIn = async (actor: string, role?: "admin" | "member") => {
    const ticket = signInTicket(actor, role ?? "member")!.ticket;
    const res = await strut.app.request("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  it("is seeded at boot: built, first-party, `admin: true`; a reboot is a no-op; `earnings: false` and STRUT_HOST_CONFIG turn it off", async () => {
    const app = await strut.apps.get(EARNINGS_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale], ["v1", "strut", "seed", false]);
    assert.equal(app.hash, await treeHash(EARNINGS_DIR));
    assert.equal(app.manifest.admin, true);
    assert.equal(app.manifest.title, "Earnings");
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    assert.deepEqual(info.warnings, []);
    assert.match(await readFile(join(app.dir, "dist", "index.html"), "utf8"), /Reading the books/);
    assert.deepEqual(await seedEarningsApp({ workspace: strut.workspace, kit }), { version: "v1", changed: false });

    const off = await createStrut({ ...quiet, ...seedsOff, workspace: new FileWorkspaceStore(await tmp("strut-earnings-off-")), store: new MemoryRunStore(), kit, earnings: false });
    assert.equal(await off.apps.get(EARNINGS_APP), null);
    await off.close?.();
    const file = join(await tmp("strut-earnings-host-"), "host.json");
    await writeFile(file, JSON.stringify({ earnings: false }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { earnings: false });
    await writeFile(file, JSON.stringify({ earnings: true }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"earnings" must be false/);
  });

  it("is an admin's: GET /apps lists it to the key and an admin's session, never to a member's; its files and versions refuse a member", async () => {
    const names = async (headers: Record<string, string>) => ((await (await strut.app.request("/apps", { headers })).json()) as { apps: Array<{ name: string; admin?: true }> }).apps;
    const keyed = (await names(auth)).find((a) => a.name === EARNINGS_APP);
    assert.equal(keyed?.admin, true);
    const admin = await signIn("ada-1", "admin");
    assert.ok((await names({ cookie: admin })).some((a) => a.name === EARNINGS_APP), "an admin's session");
    const member = await signIn("bo-1");
    assert.ok(!(await names({ cookie: member })).some((a) => a.name === EARNINGS_APP), "never a member's");

    const files = `/apps/${encodeURIComponent(EARNINGS_APP)}/v1/files`;
    assert.equal((await strut.app.request(files, { headers: { cookie: member, "x-strut-ui": "1" } })).status, 403);
    assert.equal((await strut.app.request(`${files}/dist/index.html`, { headers: { cookie: member, "x-strut-ui": "1" } })).status, 403);
    assert.equal((await strut.app.request(`/apps/${encodeURIComponent(EARNINGS_APP)}/versions`, { headers: { cookie: member } })).status, 403);

    // An admin framed by a host (stadeum: POST /auth/ticket { role: admin }):
    // the listing mints the token, the document opens with it.
    const listing = (await (await strut.app.request(files, { headers: { cookie: admin, "x-strut-ui": "1" } })).json()) as { token: string };
    assert.equal(listing.token, fileToken({ kind: "app", id: `${EARNINGS_APP}@v1` }));
    const doc = await strut.app.request(`${files}/dist/index.html?t=${listing.token}`);
    assert.equal(doc.status, 200);
    const html = await doc.text();
    assert.match(html, /<meta name="strut-app-token" content="app:strut\/earnings@v1\./);
    assert.match(doc.headers.get("content-security-policy") ?? "", /sandbox/);
  });

  /** The page through strut's own MCP door, with a session's cookie: what a framed page's host relays. */
  const mcp = async (cookie: string, type: string, config: Record<string, unknown> = {}) => {
    const res = await strut.app.request("/mcp", {
      method: "POST",
      headers: { cookie, "x-strut-ui": "1", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app: appIdentity(EARNINGS_APP, "v1") } } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(line ? line.slice(6) : text) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: !!msg.result.isError, value: JSON.parse(msg.result.content[0]!.text) as any };
  };
  /** The page's calls as an admin's (or a member's) session: `{ result }` or `{ error }`. */
  const page = (actor: string, admin: boolean) => {
    const cookie = signIn(actor, admin ? "admin" : "member");
    return async (type: string, config: Record<string, unknown> = {}) => {
      const r = await mcp(await cookie, type, config);
      return r.isError ? { error: JSON.stringify(r.value) as string, result: undefined as any } : { error: undefined, result: r.value };
    };
  };

  it("through the MCP door: an admin's session reads the books and the wallet; a member's is refused every step", async () => {
    const admin = await signIn("ada-1", "admin");
    const books = await mcp(admin, "earnings/read", { by: "item", wallet: true });
    assert.equal(books.isError, false, JSON.stringify(books.value));
    assert.equal(books.value.wallet?.balance?.msat, 50_000_000);
    const w = await mcp(admin, "earnings/wallet");
    assert.equal(w.isError, false, JSON.stringify(w.value));
    assert.equal(w.value.host, true, "the host brought its own wallet here");
    const member = await signIn("bo-1");
    for (const type of ["earnings/read", "earnings/wallet", "earnings/deposit", "earnings/withdraw", "earnings/remote-credit"]) {
      const r = await mcp(member, type, type === "earnings/deposit" ? { sats: 1 } : type === "earnings/withdraw" ? { invoice: "lnbc1", msat: 1 } : {});
      assert.equal(r.isError, true, type);
      assert.match(JSON.stringify(r.value), /admin/, type);
    }
  });

  it("Add sats: an invoice with its QR code, read until it settles, then in the books", async () => {
    const call = page("ada-1", true);
    const asked = await call("earnings/deposit", { sats: 2_000 });
    assert.equal(asked.error, undefined, asked.error);
    assert.equal(asked.result.state, "pending");
    assert.match(asked.result.qr, /^data:image\/svg\+xml;base64,/);
    assert.match(Buffer.from(asked.result.qr.split(",")[1], "base64").toString(), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    wallet.settle(asked.result.paymentHash);
    const read = await call("earnings/deposit-read", { paymentHash: asked.result.paymentHash });
    assert.equal(read.result.state, "settled");
    const books = await call("earnings/read", { by: "total" });
    assert.equal(books.result.deposited.msat, 2_000_000);
  });

  it("Withdraw: an invoice read, paid at the amount confirmed, booked with who; a refusal is the answer, not an error", async () => {
    const call = page("ada-1", true);
    const { invoice } = await elsewhere.makeInvoice({ msat: 1_000_000, description: "to cold storage" });
    const reading = await call("earnings/read-invoice", { invoice, balanceMsat: 50_000_000, provider: "sphinx" });
    assert.equal(reading.result.ok, true);
    const wrong = await call("earnings/withdraw", { invoice, msat: 999_000 });
    assert.equal(wrong.error, undefined);
    assert.deepEqual([wrong.result.ok, wrong.result.code], [false, "amount_mismatch"]);
    const paid = await call("earnings/withdraw", { invoice, msat: reading.result.msat, maxFeeMsat: reading.result.maxFeeMsat });
    assert.equal(paid.error, undefined, paid.error);
    assert.deepEqual([paid.result.ok, paid.result.state], [true, "settled"]);
    const entries = await call("earnings/entries", { kind: "withdrawal" });
    assert.equal(entries.result.entries[0].actor, "ada-1", "who paid it out, as the route books it");
    assert.equal(entries.result.entries[0].msat, 1_000_000);
  });

  it("credit bought elsewhere reads as the route answers it; a page shown to a member, or without the door, gets nothing", async () => {
    const admin = page("ada-1", true);
    assert.deepEqual((await admin("earnings/remote-credit", { balance: true })).result, { sellers: [] });
    const dropped = await admin("earnings/drop-purchase", { seller: "https://seller.example" });
    assert.equal(dropped.error, undefined, dropped.error);
    const member = page("bo-1", false);
    assert.match((await member("earnings/remote-credit")).error ?? "", /an admin's/);
  });
});
