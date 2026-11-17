/**
 * Support (plans/support-chat.md, item 1): the store over a file in memory,
 * the feed's records as strut reads them, and the `/support` routes and the
 * `staff/support-*` steps on a server whose wallet is the stand-in Sphinx
 * daemon (scripts/fake-sphinx-daemon.ts) over HTTP, its message token set
 * by `PUT /earnings/wallet`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { inProcessRequest, signInTicket } from "../auth.js";
import { inProcessDoor, STAFF_ROUTES } from "../steps/lib/_admin-door.js";
import { STAFF_APP } from "../apps/staff-seed.js";
import { setEnv } from "../test-util/public-door.js";
import { openTaskDb, TASKS_IN_MEMORY } from "../tasks/tasks.js";
import { startFakeSphinxDaemon, type FakeSphinxDaemon } from "../../scripts/fake-sphinx-daemon.js";
import supportList from "../steps/lib/staff/support-list.js";
import supportThread from "../steps/lib/staff/support-thread.js";
import supportSend from "../steps/lib/staff/support-send.js";
import supportUnread from "../steps/lib/staff/support-unread.js";
import supportSeen from "../steps/lib/staff/support-seen.js";
import supportFile from "../steps/lib/staff/support-file.js";
import supportSettings from "../steps/lib/staff/support-settings.js";
import supportSaveSettings from "../steps/lib/staff/support-save-settings.js";
import { actorOfPubkey, SupportStore, type Dm } from "./store.js";
import { dmOf } from "./support.js";

const PK = (n: number) => `02${n.toString(16).padStart(64, "0")}`;

describe("the feed's records (§7)", () => {
  it("reads a record; takes the time as seconds, ms or ISO; skips an unknown kind and a pubkey that is not one", () => {
    const base = { seq: 1, id: "m1", fromMe: false, peer: { pubkey: PK(1).toUpperCase(), alias: " Ana " }, kind: "message", text: "hi" };
    assert.deepEqual(dmOf({ ...base, time: 1_700_000_000 }, 0), { seq: 1, id: "m1", at: 1_700_000_000_000, fromMe: false, pubkey: PK(1), alias: "Ana", kind: "message", text: "hi" });
    assert.equal(dmOf({ ...base, time: 1_700_000_000_123 }, 0)?.at, 1_700_000_000_123);
    assert.equal(dmOf({ ...base, time: "2026-11-16T10:00:00.250Z" }, 0)?.at, Date.parse("2026-11-16T10:00:00.250Z"));
    assert.equal(dmOf({ ...base, time: undefined }, 42)?.at, 42);
    assert.equal(dmOf({ ...base, kind: "boost" }, 0), null);
    assert.equal(dmOf({ ...base, peer: { pubkey: "abc" } }, 0), null);
    assert.equal(dmOf({ ...base, seq: "1" }, 0), null);
    // A send's status is read on the account's own records alone.
    assert.equal(dmOf({ ...base, fromMe: true, status: "pending", clientId: "c1" }, 0)?.status, "sending");
    assert.equal(dmOf({ ...base, fromMe: true, status: "confirmed" }, 0)?.status, "sent");
    assert.equal(dmOf({ ...base, status: "failed" }, 0)?.status, undefined);
  });
});

describe("the store (§4)", () => {
  let s: SupportStore;
  before(async () => {
    s = new SupportStore(await openTaskDb(TASKS_IN_MEMORY));
  });
  after(() => s.close());
  const dm = (o: Partial<Dm> & { seq: number; id: string }): Dm => ({ at: 1000, fromMe: false, pubkey: PK(1), kind: "message", ...o });

  it("keeps a conversation per pubkey under its actor, the alias it last had, the backlog marked earlier, the cursor", () => {
    assert.equal(s.cursor(), 0);
    const contacts = s.ingest([dm({ seq: 1, id: "c", kind: "contact", alias: "Ana", at: 500 }), dm({ seq: 2, id: "a", text: "old", at: 900 }), dm({ seq: 3, id: "b", text: "new", at: 1500, alias: "Ana B" })], 3, 1000);
    assert.deepEqual(contacts, [{ pubkey: PK(1), at: 500 }]);
    assert.equal(s.cursor(), 3);
    const c = s.conversation(actorOfPubkey(PK(1)))!;
    assert.deepEqual([c.worker, c.alias, c.unread, c.last?.text], [`secp:${PK(1).slice(2)}`, "Ana B", 2, "new"]);
    const { messages } = s.messages(PK(1), { limit: 10 });
    assert.deepEqual(messages.map((m) => [m.kind, m.text, m.earlier ?? false]), [["contact", undefined, true], ["message", "old", true], ["message", "new", false]]);
  });

  it("a record again under a new seq changes the one it has: deleted for good (its text hidden), a send's status", () => {
    s.ingest([dm({ seq: 4, id: "a", deleted: true })], 4, 1000);
    const a = s.messages(PK(1), { limit: 10 }).messages.find((m) => m.id === "a")!;
    assert.deepEqual([a.deleted, a.text], [true, undefined]);
    // An own send kept first, then the feed names it by its clientId.
    const own = s.addOwn({ pubkey: PK(1), clientId: "c".repeat(64), text: "hello", by: "admin-1", at: 2000 });
    assert.equal(own.status, "sending");
    s.ingest([dm({ seq: 5, id: "sphinx-1", clientId: "c".repeat(64), fromMe: true, text: "hello", status: "sending" })], 5, 1000);
    s.ingest([dm({ seq: 6, id: "sphinx-1", clientId: "c".repeat(64), fromMe: true, text: "hello", status: "sent" })], 6, 1000);
    const m = s.message(own.key)!;
    assert.deepEqual([m.id, m.status, m.text, (m as Record<string, unknown>)["by"]], ["sphinx-1", "sent", "hello", undefined]);
    // A POST /dm answer after the feed said sent changes nothing.
    s.answered(own.key, "failed", "late");
    assert.equal(s.message(own.key)!.status, "sent");
    assert.equal(s.messages(PK(1), { limit: 10 }).messages.length, 4);
  });

  it("seen is shared; a retry is claimed once; the welcome is claimed once", () => {
    s.seen(PK(1), "admin-1", 3000);
    const c = s.conversation(actorOfPubkey(PK(1)))!;
    assert.deepEqual([c.unread, c.seenAt], [0, 3000]);
    assert.deepEqual(s.unread(), { unread: 0, conversations: 0 });
    const f = s.addOwn({ pubkey: PK(1), clientId: "d".repeat(64), text: "x", at: 4000 });
    s.answered(f.key, "failed", "no route");
    assert.deepEqual([s.message(f.key)!.status, s.message(f.key)!.error], ["failed", "no route"]);
    assert.equal(s.claimRetry(f.key), true);
    assert.equal(s.claimRetry(f.key), false);
    assert.equal(s.own(PK(2), f.key), undefined, "not in another worker's thread");
    assert.equal(s.claimWelcome(PK(1), 5000), true);
    assert.equal(s.claimWelcome(PK(1), 5001), false);
  });

  it("the welcome: on from its first save, kept by a save again, dropped by clearing it", () => {
    assert.deepEqual(s.welcome(), { welcome: "" });
    assert.deepEqual(s.saveWelcome("Hi!", "admin-1", 100), { welcome: "Hi!", since: 100, savedAt: 100, savedBy: "admin-1" });
    assert.equal(s.saveWelcome("Hello!", "admin-2", 200).since, 100);
    assert.deepEqual(s.saveWelcome("  ", "admin-2", 300), { welcome: "", savedAt: 300, savedBy: "admin-2" });
    assert.equal(s.saveWelcome("Back", undefined, 400).since, 400);
  });

  it("search reads aliases, actors and text; a deleted message's text is not searched", () => {
    s.ingest([dm({ seq: 7, id: "z", pubkey: PK(2), alias: "Bo", text: "my photo is blurry" })], 7, 0);
    assert.deepEqual(s.conversations("blurry").map((c) => c.alias), ["Bo"]);
    assert.deepEqual(s.conversations("ana").map((c) => c.alias), ["Ana B"]);
    assert.deepEqual(s.conversations(PK(2).slice(-8)).map((c) => c.alias), ["Bo"]);
    assert.deepEqual(s.conversations("old"), []);
    assert.deepEqual(s.conversations("100%"), []);
    // Unread first: Bo's message is unread, Ana's are seen.
    assert.deepEqual(s.conversations().map((c) => c.alias), ["Bo", "Ana B"]);
  });
});

describe("Support on a server (§3, §5, §8)", () => {
  const KEY = "support-key";
  const MESSAGE = "support-message";
  let dir: string;
  let restoreEnv: () => void;
  let daemon: FakeSphinxDaemon;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const json = { "content-type": "application/json" };
  const keyed = { authorization: `Bearer ${KEY}`, "x-strut-actor": "admin-1", ...json };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-support-"));
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, LIGHTNING_DAEMON_URL: undefined, LIGHTNING_DAEMON_TOKEN: undefined, LIGHTNING_DAEMON_PAY_TOKEN: undefined, LIGHTNING_DAEMON_MESSAGE_TOKEN: undefined, LIGHTNING_NWC_URL: undefined });
    daemon = await startFakeSphinxDaemon({ port: 0, token: "support-receive", payToken: "support-pay", messageToken: MESSAGE, settleAfterMs: 0 });
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      webDist: join(dir, "dist"),
      scheduler: false,
      autoResume: false,
      payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }) },
      support: { pollMs: 3_600_000 },
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await daemon?.close();
    restoreEnv?.();
    await rm(dir, { recursive: true, force: true });
  });

  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://strut.test${path}`, init);
  const get = async <T,>(path: string) => {
    const res = await req(path, { headers: keyed });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as T;
  };
  const post = async <T,>(path: string, body: unknown, method = "POST") => {
    const res = await req(path, { method, headers: keyed, body: JSON.stringify(body) });
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as T;
  };
  /** A worker, played on the stand-in daemon. */
  const worker = async (body: Record<string, unknown>, path = "/worker-dm") => (await (await fetch(`${daemon.url}${path}`, { method: "POST", headers: json, body: JSON.stringify(body) })).json()) as { id: string; pubkey: string };
  /** The follower read twice: one tick may be in flight from before. */
  const follow = async () => {
    await strut.support.tick();
    await strut.support.tick();
  };
  const w = (pubkey: string) => encodeURIComponent(actorOfPubkey(pubkey));
  type Msg = { key: number; id?: string; kind: string; text?: string; status?: string; error?: string; deleted?: true; welcome?: true; sats?: number; replyTo?: string; file?: { state: string; name?: string; mediaType?: string; size?: number } };
  type Thread = { conversation: { worker: string; alias?: string; unread: number; welcomedAt?: number }; messages: Msg[]; more: boolean };
  const staffCtx = () => ({
    app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true },
    actor: "admin-1",
    services: { staffAdmin: inProcessDoor((r, a) => Promise.resolve(strut.app.fetch(inProcessRequest(r, a))), STAFF_ROUTES, "staff") },
  });

  it("is an admin's; without a message token every route says not_available", async () => {
    const { ticket } = signInTicket("member-1", "member")!;
    const traded = await req("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
    const member = { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1", ...json };
    for (const headers of [json, member]) assert.ok([401, 403].includes((await req("/support", { headers })).status));
    // A receive-only Sphinx wallet: no Support.
    await post("/earnings/wallet", { provider: "sphinx", url: daemon.url, token: "support-receive" }, "PUT");
    for (const [method, path] of [["GET", "/support"], ["GET", "/support/unread"], ["GET", "/support/settings"], ["GET", `/support/${w(PK(9))}`]] as const) {
      const res = await req(path, { method, headers: keyed });
      assert.equal(res.status, 501, path);
      assert.equal(((await res.json()) as { code: string }).code, "not_available");
    }
    await assert.rejects(supportUnread.run({}, staffCtx() as never), /^Error: not_available: /);
    // The message token may not be the receive or the pay token.
    const same = await req("/earnings/wallet", { method: "PUT", headers: keyed, body: JSON.stringify({ provider: "sphinx", messageToken: "support-receive" }) });
    assert.equal(same.status, 400);
    assert.match(((await same.json()) as { error: string }).error, /message token is the receive or the pay token/);
    const wallet = await post<{ messages?: true }>("/earnings/wallet", { provider: "sphinx", messageToken: MESSAGE }, "PUT");
    assert.equal(wallet.messages, true);
    assert.deepEqual(await get("/support/unread"), { unread: 0, conversations: 0 });
  });

  it("a worker's message arrives; a reply goes from Support, kept before it went; seen is shared; the steps say the same", async () => {
    const ana = await worker({ alias: "Ana", text: "Is task 0123456789abcdef0123456789abcdef paid?" });
    await follow();
    const list = await get<{ conversations: Array<{ worker: string; alias?: string; unread: number; last?: Msg }> }>("/support");
    assert.deepEqual(list.conversations.map((c) => [c.worker, c.alias, c.unread, c.last?.text]), [[actorOfPubkey(ana.pubkey), "Ana", 1, "Is task 0123456789abcdef0123456789abcdef paid?"]]);
    assert.deepEqual(await get("/support/unread"), { unread: 1, conversations: 1 });
    const t = await get<Thread>(`/support/${w(ana.pubkey)}`);
    assert.deepEqual(t.messages.map((m) => m.kind), ["contact", "message"]);

    const sent = await post<{ message: Msg }>(`/support/${w(ana.pubkey)}`, { text: "Yes, it is.", replyTo: ana.id });
    assert.deepEqual([sent.message.status, sent.message.text, sent.message.replyTo], ["sent", "Yes, it is.", ana.id]);
    assert.equal((sent.message as Record<string, unknown>)["by"], undefined, "who replied is never shown");
    await follow();
    const after = await get<Thread>(`/support/${w(ana.pubkey)}`);
    const mine = after.messages.find((m) => m.key === sent.message.key)!;
    assert.ok(mine.id, "the daemon's id, from the feed");
    assert.equal(after.messages.length, 3, "the feed's copy of the send is the same message");

    await post(`/support/${w(ana.pubkey)}/seen`, {});
    assert.deepEqual(await get("/support/unread"), { unread: 0, conversations: 0 });

    const ctx = staffCtx() as never;
    const listed = (await supportList.run({ q: "paid" }, ctx)) as { conversations: unknown[] };
    assert.equal(listed.conversations.length, 1);
    assert.equal(((await supportList.run({ q: "nothing like it" }, ctx)) as { conversations: unknown[] }).conversations.length, 0);
    const thread = (await supportThread.run({ worker: actorOfPubkey(ana.pubkey), limit: 1 }, ctx)) as Thread;
    assert.deepEqual([thread.messages.length, thread.more], [1, true]);
    const viaStep = (await supportSend.run({ worker: actorOfPubkey(ana.pubkey), text: "From the step" }, ctx)) as { message: Msg };
    assert.equal(viaStep.message.status, "sent");
    assert.deepEqual(await supportSeen.run({ worker: actorOfPubkey(ana.pubkey) }, ctx).then((r) => (r as Thread).conversation.unread), 0);
    await assert.rejects(supportThread.run({ worker: actorOfPubkey(PK(9)) }, ctx), /^Error: no_conversation: /);
    await assert.rejects(supportSend.run({ worker: actorOfPubkey(ana.pubkey), text: "  " }, ctx), /^Error: bad_request: /);
  });

  it("a failed send shows its error; Retry resends the same id once", async () => {
    const bo = await worker({ alias: "Bo", text: "hello?" });
    await follow();
    await fetch(`${daemon.url}/next-dm`, { method: "POST", headers: json, body: JSON.stringify({ state: "failed" }) });
    const failed = await post<{ message: Msg }>(`/support/${w(bo.pubkey)}`, { text: "We are here." });
    assert.equal(failed.message.status, "failed");
    assert.match(failed.message.error ?? "", /LSP did not take it/);
    const again = await post<{ message: Msg }>(`/support/${w(bo.pubkey)}`, { retry: failed.message.key });
    assert.deepEqual([again.message.key, again.message.status], [failed.message.key, "sent"]);
    // A second Retry of a sent one sends nothing.
    assert.equal((await post<{ message: Msg }>(`/support/${w(bo.pubkey)}`, { retry: failed.message.key })).message.status, "sent");
    await follow();
    const t = await get<Thread>(`/support/${w(bo.pubkey)}`);
    assert.deepEqual(t.messages.filter((m) => m.text === "We are here.").map((m) => m.status), ["sent"]);
    const unknown = await req(`/support/${w(bo.pubkey)}`, { method: "POST", headers: keyed, body: JSON.stringify({ retry: 999_999 }) });
    assert.equal(unknown.status, 404);
  });

  it("a worker's file is fetched when it arrives and read through staff/support-file; one over 25 MB is a line; a deleted message is hidden; sats are a line", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const cy = await worker({ alias: "Cy", file: { name: "photo.png", type: "image/png", base64: png.toString("base64") } });
    await worker({ pubkey: cy.pubkey, file: { name: "huge.mov", type: "video/quicktime", size: 26 * 1024 * 1024 } });
    const gone = await worker({ pubkey: cy.pubkey, text: "oops" });
    await worker({ pubkey: cy.pubkey, sats: 100 });
    await follow();
    await fetch(`${daemon.url}/worker-delete/${gone.id}`, { method: "POST" });
    await follow();
    const t = await get<Thread>(`/support/${w(cy.pubkey)}`);
    const [photo, huge, deleted, sats] = t.messages.slice(1);
    assert.deepEqual(photo!.file, { name: "photo.png", mediaType: "image/png", size: png.byteLength, state: "kept" });
    assert.equal(huge!.file?.state, "too_large");
    assert.deepEqual([deleted!.deleted, deleted!.text], [true, undefined]);
    assert.deepEqual([sats!.kind, sats!.sats], ["payment", 100]);
    const file = (await supportFile.run({ worker: actorOfPubkey(cy.pubkey), id: photo!.id! }, staffCtx() as never)) as { base64: string; mediaType: string; name: string };
    assert.deepEqual([Buffer.from(file.base64, "base64").equals(png), file.mediaType, file.name], [true, "image/png", "photo.png"]);
    const tooLarge = await req(`/support/${w(cy.pubkey)}/files/${encodeURIComponent(huge!.id!)}`, { headers: keyed });
    assert.equal(tooLarge.status, 404);
    assert.match(((await tooLarge.json()) as { error: string }).error, /too large/);
    assert.deepEqual(await readdir(join(dir, "ws", "support", "files")).then((f) => f.length), 1);
  });

  it("the welcome goes automatically, once, only to contacts newer than its first save; none before one is saved", async () => {
    const early = await worker({ alias: "Early" }, "/worker-contact");
    await follow();
    assert.equal((await get<Thread>(`/support/${w(early.pubkey)}`)).messages.length, 1, "no welcome before one is saved");
    const saved = (await supportSaveSettings.run({ welcome: "Welcome! This is Support." }, staffCtx() as never)) as { settings: { welcome: string; since: number; savedBy: string } };
    assert.deepEqual([saved.settings.welcome, saved.settings.savedBy], ["Welcome! This is Support.", "admin-1"]);
    assert.deepEqual(((await supportSettings.run({}, staffCtx() as never)) as typeof saved).settings, saved.settings);
    const late = await worker({ alias: "Late" }, "/worker-contact");
    await follow();
    await follow();
    const t = await get<Thread>(`/support/${w(late.pubkey)}`);
    assert.deepEqual(t.messages.map((m) => [m.kind, m.text, m.welcome ?? false, m.status]), [["contact", undefined, false, undefined], ["message", "Welcome! This is Support.", true, "sent"]]);
    assert.ok(t.conversation.welcomedAt);
    assert.equal((await get<Thread>(`/support/${w(early.pubkey)}`)).messages.length, 1, "the backlog gets none");
    // Cleared: off.
    await post("/support/settings", { welcome: "" }, "PUT");
    const off = await worker({ alias: "Off" }, "/worker-contact");
    await follow();
    assert.equal((await get<Thread>(`/support/${w(off.pubkey)}`)).messages.length, 1);
    const bad = await req("/support/settings", { method: "PUT", headers: keyed, body: JSON.stringify({ welcome: "x", payouts: true }) });
    assert.equal(bad.status, 400);
  });
});
