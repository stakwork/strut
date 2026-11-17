/**
 * Support (plans/support-chat.md, items 1 and 2): the store over a file in memory,
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
import supportUpdate from "../steps/lib/staff/support-update.js";
import supportDelete from "../steps/lib/staff/support-delete.js";
import supportPhoto from "../steps/lib/staff/support-photo.js";
import { TaskDb } from "../tasks/db.js";
import { actorOfPubkey, SupportStore, supportSchema, type Dm } from "./store.js";
import { dmOf, fileNameIn } from "./support.js";

const PK = (n: number) => `02${n.toString(16).padStart(64, "0")}`;

describe("the feed's records (§7)", () => {
  it("reads a record as stakwork/sphinx#435 writes it; takes the time as seconds, ms or ISO; skips an unknown kind and a pubkey that is not one", () => {
    const base = { seq: 1, id: "m1", fromMe: false, peer: { pubkey: PK(1).toUpperCase(), address: null, alias: " Ana " }, kind: "message", text: "hi", replyTo: null, sats: 0, deleted: false, mediaType: null, fileName: null };
    assert.deepEqual(dmOf({ ...base, time: 1_700_000_000 }, 0), { seq: 1, id: "m1", at: 1_700_000_000_000, fromMe: false, pubkey: PK(1), alias: "Ana", kind: "message", text: "hi" });
    assert.equal(dmOf({ ...base, time: 1_700_000_000_123 }, 0)?.at, 1_700_000_000_123);
    assert.equal(dmOf({ ...base, time: "2026-11-16T10:00:00.250Z" }, 0)?.at, Date.parse("2026-11-16T10:00:00.250Z"));
    assert.deepEqual([dmOf({ ...base, time: undefined }, 42)?.at, dmOf({ ...base, time: undefined }, 42)?.untimed], [42, true], "no time of its own: never newer than the welcome");
    assert.equal(dmOf({ ...base, kind: "boost" }, 0), null);
    assert.equal(dmOf({ ...base, peer: { pubkey: "abc" } }, 0), null);
    assert.equal(dmOf({ ...base, seq: "1" }, 0), null);
    // A send's status is read on the account's own records alone.
    assert.equal(dmOf({ ...base, fromMe: true, status: "pending", clientId: "c1" }, 0)?.status, "sending");
    assert.equal(dmOf({ ...base, fromMe: true, status: "confirmed" }, 0)?.status, "sent");
    assert.equal(dmOf({ ...base, status: "failed" }, 0)?.status, undefined);
    // A send that failed before anything went out has no Sphinx id: kept by its clientId.
    assert.deepEqual(
      dmOf({ ...base, id: null, clientId: "c1", fromMe: true, status: "failed", error: "no route" }, 0),
      { seq: 1, clientId: "c1", at: 0, untimed: true, fromMe: true, pubkey: PK(1), alias: "Ana", kind: "message", text: "hi", status: "failed", error: "no route" },
    );
    assert.equal(dmOf({ ...base, id: null }, 0), null, "neither an id nor a clientId");
    // Every record names its sats: a payment's alone are kept.
    assert.equal(dmOf({ ...base, kind: "payment", sats: 100 }, 0)?.sats, 100);
    assert.equal(dmOf({ ...base, sats: 3 }, 0)?.sats, undefined);
  });

  it("reads the sender's file name from content-disposition (RFC 6266)", () => {
    assert.equal(fileNameIn(`attachment; filename="Scan _1.pdf"; filename*=UTF-8''Scan%20%C3%A91.pdf`), "Scan é1.pdf");
    assert.equal(fileNameIn(`attachment; filename="receipt.png"`), "receipt.png");
    assert.equal(fileNameIn(`attachment; filename*=UTF-8''%E0%A4%A; filename="plain.txt"`), "plain.txt");
    assert.equal(fileNameIn(null), undefined);
  });
});

describe("the store (§4)", () => {
  let s: SupportStore;
  before(async () => {
    s = new SupportStore(await openTaskDb(TASKS_IN_MEMORY));
  });
  after(() => s.close());
  const dm = (o: Partial<Dm> & { seq: number; id: string }): Dm => ({ at: 1000, fromMe: false, pubkey: PK(1), kind: "message", ...o });
  const URL = "http://treasury";

  it("keeps a conversation per pubkey under its actor, the alias it last had, the backlog marked earlier, the cursor", () => {
    assert.equal(s.cursor(URL), 0);
    const page = s.ingest([dm({ seq: 1, id: "c", kind: "contact", alias: "Ana", at: 500 }), dm({ seq: 2, id: "a", text: "old", at: 900 }), dm({ seq: 3, id: "b", text: "new", at: 1500, alias: "Ana B" })], URL, 3, 1000);
    assert.deepEqual(page, { skipped: 0 });
    assert.equal(s.cursor(URL), 3);
    assert.equal(s.cursor("http://another-daemon"), 0, "another daemon's feed is read from its start");
    assert.deepEqual(s.dueWelcomes(), [], "no welcome saved: none due");
    const c = s.conversation(actorOfPubkey(PK(1)))!;
    assert.deepEqual([c.worker, c.alias, c.unread, c.last?.text], [`secp:${PK(1).slice(2)}`, "Ana B", 2, "new"]);
    const { messages } = s.messages(PK(1), { limit: 10 });
    assert.deepEqual(messages.map((m) => [m.kind, m.text, m.earlier ?? false]), [["contact", undefined, true], ["message", "old", true], ["message", "new", false]]);
  });

  it("a record again under a new seq changes the one it has: deleted for good (its text hidden), a send's status", () => {
    s.ingest([dm({ seq: 4, id: "a", deleted: true })], URL, 4, 1000);
    const a = s.messages(PK(1), { limit: 10 }).messages.find((m) => m.id === "a")!;
    assert.deepEqual([a.deleted, a.text], [true, undefined]);
    // An own send kept first, then the feed names it by its clientId.
    const own = s.addOwn({ pubkey: PK(1), clientId: "c".repeat(64), text: "hello", by: "admin-1", at: 2000 });
    assert.equal(own.status, "sending");
    s.ingest([dm({ seq: 5, id: "sphinx-1", clientId: "c".repeat(64), fromMe: true, text: "hello", status: "sending" })], URL, 5, 1000);
    s.ingest([dm({ seq: 6, id: "sphinx-1", clientId: "c".repeat(64), fromMe: true, text: "hello", status: "sent" })], URL, 6, 1000);
    const m = s.message(own.key)!;
    assert.deepEqual([m.id, m.status, m.text, (m as Record<string, unknown>)["by"]], ["sphinx-1", "sent", "hello", undefined]);
    // A POST /dm answer after the feed said sent changes nothing.
    s.answered(own.key, "failed", "late");
    assert.equal(s.message(own.key)!.status, "sent");
    assert.equal(s.messages(PK(1), { limit: 10 }).messages.length, 4);
  });

  it("a record that cannot be kept is skipped, never the page: the cursor moves on", () => {
    const page = s.ingest([dm({ seq: 7, id: "bad", kind: "boost" as never }), dm({ seq: 8, id: "fine", text: "after it" })], URL, 8, 1000);
    assert.equal(page.skipped, 1);
    assert.match(page.error ?? "", /^bad: .*CHECK/);
    assert.equal(s.cursor(URL), 8);
    assert.ok(s.messages(PK(1), { limit: 10 }).messages.some((m) => m.id === "fine"));
    assert.ok(!s.messages(PK(1), { limit: 10 }).messages.some((m) => m.id === "bad"));
    // A key and its negation share an actor: the second keeps no conversation of its own, and nothing fails.
    assert.deepEqual(s.ingest([dm({ seq: 9, id: "neg", pubkey: `03${PK(1).slice(2)}`, text: "x" })], URL, 9, 1000), { skipped: 0 });
  });

  it("a send a past process left sending, with no word from the daemon, is failed when the store opens, so Retry shows", () => {
    const left = s.addOwn({ pubkey: PK(1), clientId: "e".repeat(64), text: "lost?", at: 1500 });
    s.abandonSends();
    assert.deepEqual([s.message(left.key)!.status, /Retry/.test(s.message(left.key)!.error ?? "")], ["failed", true]);
    assert.equal(s.message(s.messages(PK(1), { limit: 50 }).messages.find((m) => m.id === "sphinx-1")!.key)!.status, "sent", "one the daemon confirmed stays");
  });

  it("seen is shared; a retry is claimed once", () => {
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
  });

  it("the welcome: on from its first save, kept by a save again, dropped by clearing it", () => {
    assert.deepEqual(s.welcome(), { welcome: "" });
    assert.deepEqual(s.saveWelcome("Hi!", "admin-1", 100), { welcome: "Hi!", since: 100, savedAt: 100, savedBy: "admin-1" });
    assert.equal(s.saveWelcome("Hello!", "admin-2", 200).since, 100);
    assert.deepEqual(s.saveWelcome("  ", "admin-2", 300), { welcome: "", savedAt: 300, savedBy: "admin-2" });
    assert.equal(s.saveWelcome("Back", undefined, 400).since, 400);
  });

  it("a welcome is due in the page's own transaction, so a restart before it goes loses nothing; claimed and kept once", () => {
    s.ingest(
      [dm({ seq: 10, id: "k-old", pubkey: PK(3), kind: "contact", at: 300 }), dm({ seq: 11, id: "k-new", pubkey: PK(4), kind: "contact", at: 450 }), dm({ seq: 12, id: "k-untimed", pubkey: PK(5), kind: "contact", at: 9_999, untimed: true })],
      URL,
      12,
      0,
    );
    assert.deepEqual(s.dueWelcomes(), [PK(4)], "only the contact newer than the save that turned it on (400)");
    const m = s.startWelcome(PK(4), "f".repeat(64), 500)!;
    assert.deepEqual([m.text, m.auto, m.status], ["Back", "welcome", "sending"]);
    assert.equal(s.startWelcome(PK(4), "0".repeat(64), 501), undefined, "once per worker");
    assert.deepEqual(s.dueWelcomes(), []);
    // Due, then cleared before it went: it goes no more.
    s.ingest([dm({ seq: 13, id: "k-late", pubkey: PK(6), kind: "contact", at: 600 })], URL, 13, 0);
    s.saveWelcome("", undefined, 700);
    assert.equal(s.startWelcome(PK(6), "1".repeat(64), 701), undefined);
    assert.deepEqual(s.dueWelcomes(), []);
  });

  it("search reads aliases, actors and text; a deleted message's text is not searched", () => {
    s.ingest([dm({ seq: 14, id: "z", pubkey: PK(2), alias: "Bo", text: "my photo is blurry" })], URL, 14, 0);
    assert.deepEqual(s.conversations("blurry").map((c) => c.alias), ["Bo"]);
    assert.deepEqual(s.conversations("ana").map((c) => c.alias), ["Ana B"]);
    assert.deepEqual(s.conversations(PK(2).slice(-8)).map((c) => c.alias), ["Bo"]);
    assert.deepEqual(s.conversations("old"), []);
    assert.deepEqual(s.conversations("100%"), []);
    // Unread first: Bo's message is the only one unread, though newer ones (the welcomes above) are Support's.
    assert.deepEqual(s.conversations().map((c) => [c.alias, c.unread])[0], ["Bo", 1]);
    assert.equal(s.conversations()[0]!.last?.text, "my photo is blurry");
  });
  it("the heads-up's count leaves out an admin's own messages to Support; a heads-up is due again an hour after the last", () => {
    const admin = PK(40);
    s.ingest([dm({ seq: 400, id: "adm-1", pubkey: admin, text: "ok, looking", at: 1 }), dm({ seq: 401, id: "wk-1", pubkey: PK(41), text: "help", at: 2 })], URL, 401, 0);
    const before = s.waiting();
    s.seen(PK(41), actorOfPubkey(admin), 5);
    assert.ok(s.admins().some((a) => a.actor === actorOfPubkey(admin) && a.pubkey === admin), "who marked a conversation seen, and is a contact");
    s.ingest([dm({ seq: 402, id: "wk-2", pubkey: PK(41), text: "still?", at: 3 })], URL, 402, 0);
    const after = s.waiting();
    assert.equal(after.unread, before.unread - 1, "the admin's own and the one seen left out, the new one counted");
    assert.equal(s.headsUpDue(actorOfPubkey(admin), 1_000, 3_600_000), true);
    s.headsUpSent(actorOfPubkey(admin), 1_000);
    assert.deepEqual([s.headsUpDue(actorOfPubkey(admin), 3_000_000, 3_600_000), s.headsUpDue(actorOfPubkey(admin), 3_601_000, 3_600_000)], [false, true]);
  });

});

describe("item 2's columns on a file item 1 made (§4)", () => {
  it("a conversation's status and assignee are added to an older file's table, its rows open", () => {
    const db = TaskDb.open(TASKS_IN_MEMORY);
    try {
      db.exec("create table workers (actor text primary key, note text) strict");
      db.exec("create table support_conversations (pubkey text primary key, actor text not null unique, alias text, seen_key integer not null default 0, seen_at integer, seen_by text, welcomed_at integer, welcome_due integer, first_at integer not null) strict");
      db.exec(`insert into support_conversations (pubkey, actor, first_at) values ('${PK(1)}', '${actorOfPubkey(PK(1))}', 1)`);
      db.migrate(() => supportSchema(db));
      const s = new SupportStore(db);
      assert.deepEqual([s.conversation(actorOfPubkey(PK(1)))?.status, s.conversation(actorOfPubkey(PK(1)))?.assigned], ["open", undefined]);
      db.migrate(() => supportSchema(db));
    } finally {
      db.close();
    }
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
  /** The follower read twice (one tick may be in flight from before), and
   *  the files it set out to fetch, fetched. */
  const follow = async () => {
    await strut.support.tick();
    await strut.support.tick();
    await strut.support.settled();
  };
  const w = (pubkey: string) => encodeURIComponent(actorOfPubkey(pubkey));
  type Msg = { key: number; id?: string; kind: string; text?: string; status?: string; error?: string; deleted?: true; auto?: string; sats?: number; replyTo?: string; file?: { state: string; name?: string; mediaType?: string; size?: number } };
  type Conversation = { worker: string; alias?: string; unread: number; welcomedAt?: number; status: string; assigned?: string };
  type Thread = { conversation: Conversation; messages: Msg[]; more: boolean };
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
    // The daemon's own limit, refused before anything is kept.
    await assert.rejects(supportSend.run({ worker: actorOfPubkey(ana.pubkey), text: "é".repeat(17_000) }, ctx), /^Error: bad_request: too long: \d+ bytes/);
  });

  it("a failed send shows its error; Retry resends the same id once", async () => {
    const bo = await worker({ alias: "Bo", text: "hello?" });
    await follow();
    await fetch(`${daemon.url}/next-dm`, { method: "POST", headers: json, body: JSON.stringify({ state: "failed" }) });
    const failed = await post<{ message: Msg }>(`/support/${w(bo.pubkey)}`, { text: "We are here." });
    assert.equal(failed.message.status, "failed");
    assert.match(failed.message.error ?? "", /LSP did not take it/);
    await follow();
    // The feed's copy names it by its clientId alone: nothing went out, so no Sphinx id.
    const before = (await get<Thread>(`/support/${w(bo.pubkey)}`)).messages.find((m) => m.key === failed.message.key)!;
    assert.deepEqual([before.status, before.id], ["failed", undefined]);
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
    const cy = await worker({ alias: "Cy", file: { name: "Lake photo.png", type: "image/png", base64: png.toString("base64") } });
    await worker({ pubkey: cy.pubkey, file: { name: "huge.mov", type: "video/quicktime", size: 26 * 1024 * 1024 } });
    const gone = await worker({ pubkey: cy.pubkey, text: "oops" });
    await worker({ pubkey: cy.pubkey, sats: 100 });
    await follow();
    await fetch(`${daemon.url}/worker-delete/${gone.id}`, { method: "POST" });
    await follow();
    const t = await get<Thread>(`/support/${w(cy.pubkey)}`);
    const [photo, huge, deleted, sats] = t.messages.slice(1);
    // The feed named it `image.png`, from its type; the bytes came with the sender's name.
    assert.deepEqual(photo!.file, { name: "Lake photo.png", mediaType: "image/png", size: png.byteLength, state: "kept" });
    assert.equal(huge!.file?.state, "too_large");
    assert.deepEqual([deleted!.deleted, deleted!.text], [true, undefined]);
    assert.deepEqual([sats!.kind, sats!.sats], ["payment", 100]);
    const file = (await supportFile.run({ worker: actorOfPubkey(cy.pubkey), id: photo!.id! }, staffCtx() as never)) as { base64: string; mediaType: string; name: string };
    assert.deepEqual([Buffer.from(file.base64, "base64").equals(png), file.mediaType, file.name], [true, "image/png", "Lake photo.png"]);
    const tooLarge = await req(`/support/${w(cy.pubkey)}/files/${encodeURIComponent(huge!.id!)}`, { headers: keyed });
    assert.equal(tooLarge.status, 404);
    assert.match(((await tooLarge.json()) as { error: string }).error, /too large/);
    assert.deepEqual(await readdir(join(dir, "ws", "support", "files")).then((f) => f.length), 1);
  });

  it("a file over a step result's cap is read in 3 MB pieces whose base64 joins as one", async () => {
    const big = Buffer.alloc(7 * 1024 * 1024 + 5, 7);
    big.write("start", 0);
    big.write("end", big.byteLength - 3);
    const dee = await worker({ alias: "Dee", file: { name: "clip.mp4", type: "video/mp4", base64: big.toString("base64") } });
    await follow();
    const id = (await get<Thread>(`/support/${w(dee.pubkey)}`)).messages.find((m) => m.kind === "file")!.id!;
    const ctx = staffCtx() as never;
    type Piece = { base64: string; bytes: number; offset: number; next?: number };
    const pieces: Piece[] = [(await supportFile.run({ worker: actorOfPubkey(dee.pubkey), id }, ctx)) as Piece];
    while (pieces.at(-1)!.next !== undefined) pieces.push((await supportFile.run({ worker: actorOfPubkey(dee.pubkey), id, offset: pieces.at(-1)!.next! }, ctx)) as Piece);
    assert.deepEqual(pieces.map((p) => p.offset), [0, 3 * 1024 * 1024, 6 * 1024 * 1024]);
    assert.ok(pieces.every((p) => p.bytes === big.byteLength && p.base64.length < 5 * 1024 * 1024));
    assert.ok(Buffer.from(pieces.map((p) => p.base64).join(""), "base64").equals(big));
    await assert.rejects(supportFile.run({ worker: actorOfPubkey(dee.pubkey), id, offset: 5 }, ctx), /^Error: bad_request: offset/);
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
    assert.deepEqual(t.messages.map((m) => [m.kind, m.text, m.auto, m.status]), [["contact", undefined, undefined, undefined], ["message", "Welcome! This is Support.", "welcome", "sent"]]);
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

  // ── item 2 ────────────────────────────────────────────────────────────────

  /** What the daemon holds as a file of the account's, read with the message token. */
  const daemonFile = async (id: string) => Buffer.from(await (await fetch(`${daemon.url}/dm/${encodeURIComponent(id)}/file`, { headers: { authorization: `Bearer ${MESSAGE}` } })).arrayBuffer());

  it("staff send a file: strut keeps its copy and sends it through the daemon, a caption beside it; Retry resends it; more than 2.5 MiB is refused", async () => {
    const eve = await worker({ alias: "Eve", text: "Can I see the rules?" });
    await follow();
    const pdf = Buffer.from("%PDF-1.4 the rules\n%%EOF");
    const ctx = staffCtx() as never;
    const sent = (await supportSend.run({ worker: actorOfPubkey(eve.pubkey), text: "Here they are", file: { base64: pdf.toString("base64"), type: "application/pdf", name: "../Rules.pdf" } }, ctx)) as { message: Msg };
    assert.deepEqual([sent.message.kind, sent.message.text, sent.message.status, sent.message.file], ["file", "Here they are", "sent", { name: ".._Rules.pdf", mediaType: "application/pdf", size: pdf.byteLength, state: "kept" }]);
    assert.ok(sent.message.id, "the daemon's id, from its answer: a reply may quote it and Delete name it at once");
    assert.ok((await daemonFile(sent.message.id!)).equals(pdf), "the daemon has the bytes");
    await follow();
    const t = await get<Thread>(`/support/${w(eve.pubkey)}`);
    assert.equal(t.messages.filter((m) => m.kind === "file").length, 1, "the feed's copy is the same message");
    const read = (await supportFile.run({ worker: actorOfPubkey(eve.pubkey), id: sent.message.id! }, ctx)) as { base64: string; name: string };
    assert.deepEqual([Buffer.from(read.base64, "base64").equals(pdf), read.name], [true, ".._Rules.pdf"]);

    // A photo alone, failed, then Retry: the same file under the same id.
    const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    await fetch(`${daemon.url}/next-dm`, { method: "POST", headers: json, body: JSON.stringify({ state: "failed" }) });
    const failed = await post<{ message: Msg }>(`/support/${w(eve.pubkey)}`, { file: { base64: jpeg.toString("base64"), type: "image/jpeg", name: "photo.jpg" } });
    assert.deepEqual([failed.message.status, failed.message.text, failed.message.file?.state], ["failed", undefined, "kept"]);
    const again = await post<{ message: Msg }>(`/support/${w(eve.pubkey)}`, { retry: failed.message.key });
    assert.equal(again.message.status, "sent");
    assert.ok((await daemonFile(again.message.id!)).equals(jpeg));

    const big = Buffer.alloc(2.5 * 1024 * 1024 + 1).toString("base64");
    for (const body of [{ file: { base64: big, type: "application/pdf", name: "big.pdf" } }, { file: { base64: "not base64!", type: "image/png", name: "x.png" } }, { file: { base64: "AAAA", type: "nonsense", name: "x" } }, { text: " " }]) {
      const res = await req(`/support/${w(eve.pubkey)}`, { method: "POST", headers: keyed, body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
  });

  it("Delete: one of Support's messages, for both sides; never a worker's; one that never went, strut's copy alone", async () => {
    const fay = await worker({ alias: "Fay", text: "hi" });
    await follow();
    const ctx = staffCtx() as never;
    const sent = (await supportSend.run({ worker: actorOfPubkey(fay.pubkey), text: "Wrong worker, sorry" }, ctx)) as { message: Msg };
    const gone = (await supportDelete.run({ worker: actorOfPubkey(fay.pubkey), key: sent.message.key }, ctx)) as { message: Msg };
    assert.deepEqual([gone.message.deleted, gone.message.text], [true, undefined]);
    const feed = (await (await fetch(`${daemon.url}/dms?after=0&limit=1000`, { headers: { authorization: `Bearer ${MESSAGE}` } })).json()) as { dms: Array<{ id: string | null; deleted: boolean }> };
    assert.equal(feed.dms.find((r) => r.id === sent.message.id)?.deleted, true, "the daemon deleted it");
    await follow();
    assert.equal((await get<Thread>(`/support/${w(fay.pubkey)}`)).messages.find((m) => m.key === sent.message.key)?.deleted, true);
    // Hers is not Support's to delete.
    const hers = (await get<Thread>(`/support/${w(fay.pubkey)}`)).messages.find((m) => m.text === "hi")!;
    await assert.rejects(supportDelete.run({ worker: actorOfPubkey(fay.pubkey), key: hers.key }, ctx), /^Error: unknown_message: /);
    // Failed with nothing sent: no id, deleted here alone; Retry finds nothing.
    await fetch(`${daemon.url}/next-dm`, { method: "POST", headers: json, body: JSON.stringify({ state: "failed" }) });
    const failed = (await supportSend.run({ worker: actorOfPubkey(fay.pubkey), text: "never went" }, ctx)) as { message: Msg };
    assert.equal((await supportDelete.run({ worker: actorOfPubkey(fay.pubkey), key: failed.message.key }, ctx).then((r) => (r as { message: Msg }).message.deleted)), true);
    await assert.rejects(supportSend.run({ worker: actorOfPubkey(fay.pubkey), retry: failed.message.key }, ctx), /^Error: unknown_message: /);
  });

  it("Support's picture is set through the daemon, which sends it as img; strut keeps a copy to show; cleared", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
    const ctx = staffCtx() as never;
    type Settings = { settings: { payoutLines: boolean; photo?: { url: string; mediaType: string; base64?: string; savedBy?: string } } };
    const set = (await supportPhoto.run({ photo: { base64: png.toString("base64"), type: "image/png" } }, ctx)) as Settings;
    assert.match(set.settings.photo?.url ?? "", /^https:\/\/memes\.fake\.invalid\/public\//);
    assert.deepEqual([set.settings.photo?.mediaType, set.settings.photo?.base64, set.settings.photo?.savedBy], ["image/png", png.toString("base64"), "admin-1"]);
    assert.deepEqual(((await supportSettings.run({}, ctx)) as Settings).settings.photo, set.settings.photo);
    assert.equal(((await (await fetch(`${daemon.url}/worker-photo`)).json()) as { img: string | null }).img, set.settings.photo!.url);
    const cleared = (await supportPhoto.run({ photo: null }, ctx)) as Settings;
    assert.equal(cleared.settings.photo, undefined);
    assert.equal(((await (await fetch(`${daemon.url}/worker-photo`)).json()) as { img: string | null }).img, null);
    const res = await req("/support/photo", { method: "PUT", headers: keyed, body: JSON.stringify({ base64: png.toString("base64"), type: "application/pdf" }) });
    assert.equal(res.status, 400);
  });

  it("a payout's line: from Support when it settles, once; none with payout lines off, or to someone who is not a contact", async () => {
    const gus = await worker({ alias: "Gus", text: "when do I get paid?" });
    await follow();
    const key = "a".repeat(64);
    await strut.support.paidOut({ key, worker: actorOfPubkey(gus.pubkey), msat: 1_200_000 });
    await strut.support.paidOut({ key, worker: actorOfPubkey(gus.pubkey), msat: 1_200_000 });
    await follow();
    const lines = (await get<Thread>(`/support/${w(gus.pubkey)}`)).messages.filter((m) => m.auto === "payout");
    assert.deepEqual(lines.map((m) => [m.text, m.status]), [["Paid you 1,200 sats", "sent"]]);
    assert.equal(((await get<{ settings: { payoutLines: boolean } }>("/support/settings")).settings.payoutLines), true, "on by default");
    await supportSaveSettings.run({ payoutLines: false }, staffCtx() as never);
    await strut.support.paidOut({ key: "b".repeat(64), worker: actorOfPubkey(gus.pubkey), msat: 5_000 });
    await strut.support.paidOut({ key: "c".repeat(64), worker: actorOfPubkey(PK(77)), msat: 5_000 });
    assert.equal((await get<Thread>(`/support/${w(gus.pubkey)}`)).messages.filter((m) => m.auto === "payout").length, 1);
    const both = await post<{ settings: { welcome: string; payoutLines: boolean } }>("/support/settings", { payoutLines: true }, "PUT");
    assert.equal(both.settings.payoutLines, true);
  });

  it("done and assigned: taken by an admin, told relative to who asks; filtered by mine and unassigned; a worker writing again reopens it", async () => {
    const hal = await worker({ alias: "Hal", text: "my photo was rejected" });
    await follow();
    const ctx = staffCtx() as never;
    const taken = (await supportUpdate.run({ worker: actorOfPubkey(hal.pubkey), assignee: "me" }, ctx)) as { conversation: Conversation };
    assert.deepEqual([taken.conversation.status, taken.conversation.assigned], ["open", "me"]);
    const asOther = await (await req(`/support/${w(hal.pubkey)}`, { headers: { ...keyed, "x-strut-actor": "admin-2" } })).json() as Thread;
    assert.equal(asOther.conversation.assigned, "other", "no names: another admin's");
    const names = async (filter: string, actor = "admin-1") =>
      ((await (await req(`/support?filter=${filter}`, { headers: { ...keyed, "x-strut-actor": actor } })).json()) as { conversations: Conversation[] }).conversations.map((c) => c.alias);
    assert.ok((await names("mine")).includes("Hal"));
    assert.ok(!(await names("mine", "admin-2")).includes("Hal"));
    assert.ok(!(await names("unassigned")).includes("Hal"));
    assert.ok((await names("unassigned")).includes("Gus"));
    await supportUpdate.run({ worker: actorOfPubkey(hal.pubkey), status: "done" }, ctx);
    assert.ok(!(await names("open")).includes("Hal"));
    assert.ok(!(await names("mine")).includes("Hal"), "mine is the open ones");
    assert.deepEqual(await names("done"), ["Hal"]);
    assert.ok((await names("all")).includes("Hal"));
    await worker({ pubkey: hal.pubkey, text: "still waiting" });
    await follow();
    assert.ok((await names("open")).includes("Hal"), "a worker writing again reopens it");
    assert.equal((await supportUpdate.run({ worker: actorOfPubkey(hal.pubkey), assignee: null }, ctx).then((r) => (r as { conversation: Conversation }).conversation.assigned)), undefined);
    for (const body of [{ status: "closed" }, { assignee: "admin-9" }, {}]) {
      const res = await req(`/support/${w(hal.pubkey)}`, { method: "PUT", headers: keyed, body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await req("/support?filter=everything", { headers: keyed })).status, 400);
  });

  it("the heads-up: a message unread 5 minutes sends each admin Support knows the count, no content, once an hour; an admin who is not a contact gets none", async () => {
    // An admin whose own key is Support's contact, who has used Support.
    const admin = await worker({ alias: "Ida (staff)" }, "/worker-contact");
    await follow();
    const ida = actorOfPubkey(admin.pubkey);
    await req(`/support/${w(admin.pubkey)}/seen`, { method: "POST", headers: { ...keyed, "x-strut-actor": ida } });
    const headsUps = async () => (await get<Thread>(`/support/${w(admin.pubkey)}`)).messages.filter((m) => m.auto === "heads-up");
    // A message only a minute old: nothing yet.
    await worker({ alias: "Jo", text: "fresh", time: new Date(Date.now() - 60_000).toISOString() });
    await follow();
    assert.deepEqual(await headsUps(), []);
    // One waiting six minutes: the count goes, once.
    await worker({ alias: "Kim", text: "the secret words", time: new Date(Date.now() - 6 * 60_000).toISOString() });
    await follow();
    await follow();
    const sent = await headsUps();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text ?? "", /^\d+ messages? waiting in Support$/);
    assert.equal(sent[0]!.status, "sent");
    // Ida answers it from Peel, long ago by the clock: her own message is not news to her.
    await worker({ pubkey: admin.pubkey, text: "on it", time: new Date(Date.now() - 6 * 60_000).toISOString() });
    await follow();
    assert.equal((await get<Thread>(`/support/${w(admin.pubkey)}`)).messages.filter((m) => m.text === "on it").length, 1);
    assert.equal((await headsUps()).length, 1, "once an hour");
    // admin-1, who replied all along, is no contact of Support's: the count on the tab alone.
    assert.ok(!(await get<{ conversations: Conversation[] }>("/support")).conversations.some((c) => c.worker === "admin-1"));
  });
});
