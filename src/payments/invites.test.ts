/**
 * Worker invites (plans/human-steps.md §5.8): the join link's shape, the
 * service's rules over a stand-in payer, the `/tasks/invites` routes and the
 * `staff/*` steps on a server whose wallet is the stand-in Sphinx daemon
 * (scripts/fake-sphinx-daemon.ts) over HTTP, and `/public/join` — the page
 * without a key, and its script run against a stand-in browser.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { inProcessRequest, inviteOf, inviteToken, signInTicket } from "../auth.js";
import { inProcessDoor, STAFF_ROUTES } from "../steps/lib/_admin-door.js";
import { STAFF_APP } from "../apps/staff-seed.js";
import { setEnv } from "../test-util/public-door.js";
import { INVITE_PRICE_SATS, startFakeSphinxDaemon, type FakeSphinxDaemon } from "../../scripts/fake-sphinx-daemon.js";
import inviteStep from "../steps/lib/staff/invite.js";
import invitesStep from "../steps/lib/staff/invites.js";
import cancelInviteStep from "../steps/lib/staff/cancel-invite.js";
import { JOIN_HEADERS, JOIN_PAGE, JOIN_SCRIPT, joinLang, joinPage, PEEL_ANDROID_RELEASES } from "../public-join.js";
import { LightningError } from "./lightning.js";
import { NO_INVITES, SphinxDaemonPayer, type Payer, type WalletInvite } from "./payer.js";
import { createInvites, fileInviteNotes, GRANT_LINK_PREFIX, INVITE_TOKEN_DAYS, InviteError, joinLink, memoryInviteNotes } from "./invites.js";
import { publicAppLinks } from "../public-routes.js";
import { WORKER_APP } from "../apps/worker-seed.js";

/** A worker app's share link: what `a=` opens. */
const workerAppUrl = (base: string, app: string) => publicAppLinks(base, app).link;

/** What an invite's link opens (`a=`): Tasks' share link, and the page's
 *  input — the invite's token and the kind of work it is for. */
function opened(link: string, base: string): { invite?: { code: string; app: string; types?: string[] } | undefined; type: string | null } {
  const a = decodeURIComponent(link.slice(link.indexOf("&a=") + 3));
  const share = workerAppUrl(base, WORKER_APP);
  assert.ok(a.startsWith(`${share}&input=`), a);
  const input = new URLSearchParams(decodeURIComponent(a.slice(`${share}&input=`.length)));
  const token = input.get("invite");
  return { invite: token ? inviteOf(token) : undefined, type: input.get("type") };
}

const D = "AAAA_-zz"; // a `d=` section's URL-safe base64, as the core writes it
const INVITE = `sphinx.chat://?action=i&d=${D}&c=BBBB`;

describe("the join link (§5.8)", () => {
  it("is the invite after # with sphinx.chat:// taken off, then a= the worker app's share link encoded whole", () => {
    const app = workerAppUrl("https://stadeum.example/", "acme/workers");
    assert.equal(app, "https://stadeum.example/?app=acme%2Fworkers&solo=1&public=1");
    const link = joinLink("https://stadeum.example", INVITE, app)!;
    assert.equal(link, `https://stadeum.example/public/join#action=i&d=${D}&c=BBBB&a=${encodeURIComponent(app)}`);
    // `a=` is one section: its own & and = never split it.
    const sections = link.split("#")[1]!.split("&");
    assert.deepEqual(sections.map((s) => s.split("=")[0]), ["action", "d", "c", "a"]);
    assert.equal(decodeURIComponent(sections[3]!.slice(2)), app);
    // The bare query is taken as it is; no app, no a=.
    assert.equal(joinLink("https://s.example", `action=i&d=${D}`), `https://s.example/public/join#action=i&d=${D}`);
  });

  it("is none for anything but an invite: no d=, another action, a # or a space in it", () => {
    for (const bad of ["sphinx.chat://?action=t&d=x", "sphinx.chat://?action=i&c=x", "https://evil.example/#action=i&d=x", "action=i&d=x#y", "action=i&d=x y"]) {
      assert.equal(joinLink("https://s.example", bad), undefined, bad);
    }
  });
});

/** A payer with the daemon's three invite calls, kept in memory. */
function invitePayer(opts: { noRoute?: boolean } = {}) {
  const made: WalletInvite[] = [];
  const asked: number[] = [];
  const refuse = () => {
    throw new LightningError("wallet_refused", "the Sphinx daemon has no POST /invite", NO_INVITES);
  };
  const payer: Payer = {
    provider: "sphinx",
    id: "sphinx:test",
    capsFee: true,
    minFeeMsat: () => 0,
    pay: async () => assert.fail("no pay"),
    status: async () => assert.fail("no status"),
    invite: async ({ sats }) => {
      if (opts.noRoute) refuse();
      asked.push(sats);
      const inv: WalletInvite = { code: String(made.length).padStart(64, "0"), link: `${INVITE}${made.length}`, sats, status: "ready", createdAt: new Date(Date.UTC(2026, 10, 16, 0, made.length)).toISOString() };
      made.push(inv);
      return inv;
    },
    invites: async () => (opts.noRoute ? refuse() : made),
    cancelInvite: async ({ code }) => {
      const inv = made.find((i) => i.code === code);
      if (!inv) throw new LightningError("wallet_refused", `no invite ${code}`, "not_found");
      inv.status = "cancelled";
      return { code, status: inv.status };
    },
  };
  return { payer, made, asked };
}

const refused = (code: string, status?: number) => (err: unknown) => err instanceof InviteError && err.code === code && (status === undefined || err.status === status);

describe("createInvites (§5.8)", () => {
  const BASE = "https://s.example";
  let restoreEnv: () => void;
  before(() => {
    restoreEnv = setEnv({ STRUT_API_KEY: "invites-unit" });
  });
  after(() => restoreEnv?.());
  /** Tasks and the court app online; pets drawn by Tasks, court-work by court, drafts by an app nobody put online. */
  const deps = (o: { online?: string[]; payer?: Payer | null } = {}) => {
    const online = o.online ?? [WORKER_APP, "court"];
    const apps: Record<string, string> = { pets: WORKER_APP, "court-work": "court", drafts: "drafts" };
    return { inviteSats: async () => 100, publicApps: async () => online, typeApp: async (name: string) => apps[name], ...(o.payer !== undefined ? { payer: async () => o.payer! } : {}) };
  };

  it("an invite: the settings' sats when it names none; its link opens Tasks, its token naming no work (open work alone)", async () => {
    const { payer, asked } = invitePayer();
    const invites = createInvites({ ...deps(), payer: async () => payer });
    const a = await invites.create({ base: BASE });
    assert.deepEqual(asked, [100]);
    assert.ok(a.link?.startsWith(`${BASE}/public/join#action=i&d=${D}&c=BBBB0&a=`), a.link);
    assert.deepEqual(opened(a.link!, BASE), { invite: { code: a.code, app: WORKER_APP, types: [] }, type: null });
    assert.equal(a.type, undefined);
    assert.equal((await invites.create({ base: BASE, sats: 2_500 })).sats, 2_500);
    for (const sats of [0, -1, 1.5, 100_001]) await assert.rejects(invites.create({ base: BASE, sats }), refused("bad_request", 400), String(sats));
    assert.deepEqual(asked, [100, 2_500], "nothing refused reached the wallet");
  });

  it("an invite for a kind of work: Tasks opens it, and the token gives it — whichever app draws it", async () => {
    const { payer } = invitePayer();
    const invites = createInvites({ ...deps(), payer: async () => payer });
    for (const type of ["pets", "court-work"]) {
      const made = await invites.create({ base: BASE, type });
      assert.equal(made.type, type);
      assert.deepEqual(opened(made.link!, BASE), { invite: { code: made.code, app: WORKER_APP, types: [type] }, type });
    }
  });

  it("Tasks offline, no such type, the type's app offline — each refused before the wallet is asked", async () => {
    const { payer, asked } = invitePayer();
    await assert.rejects(createInvites({ ...deps({ online: ["court"] }), payer: async () => payer }).create({ base: BASE }), refused("no_worker_app", 409));
    const invites = createInvites({ ...deps(), payer: async () => payer });
    await assert.rejects(invites.create({ base: BASE, type: "nope" }), (err) => refused("bad_request", 400)(err) && /no task type nope/.test(String(err)));
    await assert.rejects(invites.create({ base: BASE, type: "drafts" }), (err) => refused("not_online", 409)(err) && /drafts is answered in drafts/.test(String(err)));
    assert.deepEqual(asked, []);
  });

  it("a wallet that cannot invite: no pay credential, NWC, a daemon without the routes — the list says why and invites nothing", async () => {
    const nwc: Payer = { provider: "nwc", id: "nwc:x", capsFee: false, minFeeMsat: () => 0, pay: async () => assert.fail(), status: async () => assert.fail() };
    const old = invitePayer({ noRoute: true }).payer;
    for (const [payer, why, status] of [[null, "no_pay_credential", 409], [nwc, "no_invites", 501], [old, "no_invites", 501]] as const) {
      const invites = createInvites({ ...deps(), payer: async () => payer });
      assert.deepEqual(await invites.list({ base: BASE }), { invites: [], sats: 100, why });
      await assert.rejects(invites.create({ base: BASE }), refused(why, status));
    }
  });

  it("the list: newest first, each with the link it was sent with and its work; one made before invites named their work gives what it gave; Tasks offline, no links; a cancel; an unknown code", async () => {
    const { payer, made } = invitePayer();
    let online = [WORKER_APP, "court"];
    const notes = memoryInviteNotes();
    const invites = createInvites({ ...deps(), publicApps: async () => online, payer: async () => payer, notes });
    const first = await invites.create({ base: BASE });
    const second = await invites.create({ base: BASE, type: "court-work" });
    // An invite the daemon keeps that strut noted nothing of: made before.
    made.push({ code: "f".repeat(64), link: `${INVITE}9`, sats: 100, status: "ready", createdAt: "2026-11-01T00:00:00.000Z" });
    const all = await invites.list({ base: BASE });
    assert.deepEqual(all.invites.map((i) => [i.code, i.type]), [[second.code, "court-work"], [first.code, undefined], ["f".repeat(64), undefined]]);
    assert.equal(all.invites[0]!.link, second.link, "the link it was sent with");
    assert.equal(all.invites[1]!.link, first.link);
    assert.deepEqual(opened(all.invites[2]!.link!, BASE).invite, { code: "f".repeat(64), app: WORKER_APP }, "no types: every invite-only type Tasks draws, as before");
    online = ["court"];
    assert.ok((await invites.list({ base: BASE })).invites.every((i) => i.link === undefined), "a link that opened nothing would mislead");
    assert.deepEqual(await invites.cancel(first.code), { code: first.code, status: "cancelled" });
    await assert.rejects(invites.cancel("e".repeat(64)), refused("unknown_invite", 404));
    await assert.rejects(invites.cancel("../balance"), refused("bad_request", 400));
  });

  it("who made an invite and when its link stops: noted at create, listed; older invites show nothing", async () => {
    const { payer } = invitePayer();
    const invites = createInvites({ ...deps(), publicApps: async () => [WORKER_APP], payer: async () => payer, notes: memoryInviteNotes() });
    const made = await invites.create({ base: BASE, by: "secp:abc" });
    assert.equal(made.by, "secp:abc");
    const [one] = (await invites.list({ base: BASE })).invites;
    assert.equal(one!.by, "secp:abc");
    assert.equal(one!.expiresAt, new Date(Date.parse(one!.createdAt!) + INVITE_TOKEN_DAYS * 86_400_000).toISOString());
    assert.equal((await invites.create({ base: BASE })).by, undefined);
  });

  it("the notes on disk: written one after another, read back by the next process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-invite-notes-"));
    try {
      const path = join(dir, "tasks", "invites.json");
      const notes = fileInviteNotes(path);
      assert.deepEqual(await notes.all(), {});
      await Promise.all([notes.set("a", { type: "pets" }), notes.set("b", {}), notes.set("c", { type: "court-work" })]);
      assert.deepEqual(await fileInviteNotes(path).all(), { a: { type: "pets" }, b: {}, c: { type: "court-work" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("worker invites on a server (§5.8)", () => {
  const KEY = "invites-key";
  const PAY = "invites-pay";
  let dir: string;
  let restoreEnv: () => void;
  let daemon: FakeSphinxDaemon;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const json = { "content-type": "application/json" };
  const keyed = { authorization: `Bearer ${KEY}`, ...json };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-invites-"));
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_PUBLIC_URL: undefined, LIGHTNING_DAEMON_URL: undefined, LIGHTNING_DAEMON_TOKEN: undefined, LIGHTNING_DAEMON_PAY_TOKEN: undefined, NWC_URL: undefined });
    daemon = await startFakeSphinxDaemon({ port: 0, token: "invites-receive", payToken: PAY, settleAfterMs: 0, startSats: 10_000 });
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      webDist: join(dir, "dist"),
      scheduler: false,
      autoResume: false,
      payments: { rate: async () => ({ usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" }), payer: new SphinxDaemonPayer({ url: daemon.url, payToken: PAY }) },
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
  const daemonBalance = async () => ((await (await fetch(`${daemon.url}/balance`, { headers: { authorization: `Bearer ${PAY}` } })).json()) as { msat: number }).msat;
  const session = async (role: "admin" | "member") => {
    const { ticket } = signInTicket(`${role}-1`, role)!;
    const traded = await req("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
    return { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1", ...json };
  };
  /** The staff's door as the app door hands it to strut/staff. */
  const staffCtx = () => ({
    app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true },
    actor: "admin-1",
    services: { staffAdmin: inProcessDoor((r, a) => Promise.resolve(strut.app.fetch(inProcessRequest(r, a))), STAFF_ROUTES, "staff") },
  });
  it("the routes are full scope only; with Tasks not public an invite is refused before the wallet pays", async () => {
    const member = await session("member");
    for (const [method, path, body] of [["POST", "/tasks/invites", {}], ["GET", "/tasks/invites"], ["POST", `/tasks/invites/${"a".repeat(64)}/cancel`], ["POST", "/tasks/online", {}]] as const) {
      for (const headers of [json, member]) {
        const res = await req(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.ok(res.status === 401 || res.status === 403, `${method} ${path}: ${res.status}`);
      }
    }
    const before = await daemonBalance();
    const none = await req("/tasks/invites", { method: "POST", headers: keyed, body: "{}" });
    assert.equal(none.status, 409);
    assert.equal(((await none.json()) as { code: string }).code, "no_worker_app");
    assert.equal(await daemonBalance(), before);
    const extra = await req("/tasks/invites", { method: "POST", headers: keyed, body: JSON.stringify({ sats: 10, app: "workers" }) });
    assert.equal(extra.status, 400, "an invite names its work, never an app");
    // The grant link's maker is gone: an invite works for someone who has Peel too.
    assert.equal((await req("/tasks/invites/link", { method: "POST", headers: keyed, body: "{}" })).status, 404);
  });

  it("an invite through the routes: its link on the request's base (a proxy's headers honored), opening Tasks on its work; the settings' sats; listed with its work; cancelled", async () => {
    assert.equal((await req("/tasks/types/pets", { method: "PUT", headers: keyed, body: JSON.stringify({ app: WORKER_APP, answer: { type: "boolean" } }) })).status, 200);
    // A type whose app is not in the public view.
    assert.equal((await req("/tasks/types/drafts", { method: "PUT", headers: keyed, body: JSON.stringify({ app: "drafts", answer: { type: "boolean" } }) })).status, 200);
    const view = await req("/public-view", { method: "PUT", headers: keyed, body: JSON.stringify({ apps: [{ name: WORKER_APP }] }) });
    assert.equal(view.status, 200, await view.clone().text());

    const before = await daemonBalance();
    const res = await req("/tasks/invites", { method: "POST", headers: keyed, body: "{}" });
    assert.equal(res.status, 200, await res.clone().text());
    const made = (await res.json()) as { code: string; link: string; sats: number; status: string; type?: string };
    assert.deepEqual([made.sats, made.status, made.type], [100, "ready", undefined]);
    assert.match(made.link, /^http:\/\/strut\.test\/public\/join#action=i&d=[A-Za-z0-9_-]+=*&a=/);
    assert.deepEqual(opened(made.link, "http://strut.test"), { invite: { code: made.code, app: WORKER_APP, types: [] }, type: null });
    assert.equal(await daemonBalance(), before - (100 + INVITE_PRICE_SATS) * 1000);

    // Behind a proxy, for one kind of work: the public host it names, and type=.
    const proxied = await req("/tasks/invites", { method: "POST", headers: { ...keyed, "x-forwarded-proto": "https", "x-forwarded-host": "stadeum.example" }, body: JSON.stringify({ sats: 42, type: "pets" }) });
    const p = (await proxied.json()) as { code: string; link: string; sats: number; type: string };
    assert.deepEqual([p.sats, p.type], [42, "pets"]);
    assert.ok(p.link.startsWith("https://stadeum.example/public/join#action=i&"), p.link);
    assert.deepEqual(opened(p.link, "https://stadeum.example"), { invite: { code: p.code, app: WORKER_APP, types: ["pets"] }, type: "pets" });
    // Refused before anything is paid: work answered in an app nobody put online; no such work.
    const paid = await daemonBalance();
    const drafts = await req("/tasks/invites", { method: "POST", headers: keyed, body: JSON.stringify({ type: "drafts" }) });
    assert.deepEqual([drafts.status, ((await drafts.json()) as { code: string }).code], [409, "not_online"]);
    assert.equal((await req("/tasks/invites", { method: "POST", headers: keyed, body: JSON.stringify({ type: "nope" }) })).status, 400);
    assert.equal(await daemonBalance(), paid);

    // The money settings' default.
    const settings = await req("/tasks/payouts/settings", { method: "PUT", headers: keyed, body: JSON.stringify({ on: false, minSats: 1_000, workerDaySats: 1_000_000, serverDaySats: 10_000_000, inviteSats: 250 }) });
    assert.equal(settings.status, 200, await settings.clone().text());
    assert.equal(((await settings.json()) as { settings: { inviteSats: number } }).settings.inviteSats, 250);
    const third = (await (await req("/tasks/invites", { method: "POST", headers: keyed, body: "{}" })).json()) as { code: string; sats: number };
    assert.equal(third.sats, 250);

    const list = (await (await req("/tasks/invites", { headers: keyed })).json()) as { invites: Array<{ code: string; status: string; link?: string; type?: string }>; sats: number };
    assert.equal(list.sats, 250);
    assert.equal(list.invites.length, 3);
    assert.deepEqual(list.invites.find((i) => i.code === p.code)?.type, "pets");
    assert.ok([made.code, third.code].every((code) => list.invites.some((i) => i.code === code && i.type === undefined)));
    assert.ok(list.invites.every((i) => i.link?.startsWith("http://strut.test/public/join#action=i&")));

    const beforeCancel = await daemonBalance();
    const cancel = await req(`/tasks/invites/${made.code}/cancel`, { method: "POST", headers: keyed });
    assert.deepEqual(await cancel.json(), { code: made.code, status: "cancelled" });
    assert.equal(await daemonBalance(), beforeCancel + (100 + INVITE_PRICE_SATS) * 1000);
    const unknown = await req(`/tasks/invites/${"e".repeat(64)}/cancel`, { method: "POST", headers: keyed });
    assert.equal(unknown.status, 404);
  });

  it("the staff/* steps through the staff door: the link on the base the share links use (where the page came, a mount path kept), with its QR code; an invite for work", async () => {
    const ctx = staffCtx();
    // The page's own request, from outside behind mcp's /lab: the base the
    // door's in-process requests (http://strut.invalid) take.
    const page = await req("/health", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "stadeum.example", "x-forwarded-prefix": "/lab" } });
    assert.equal(page.status, 200);
    const made = (await inviteStep.run({ sats: 21 }, ctx as never)) as { code: string; link: string; qrSvg: string; sats: number };
    assert.equal(made.sats, 21);
    assert.ok(made.link.startsWith("https://stadeum.example/lab/public/join#action=i&d="), made.link);
    assert.equal(opened(made.link, "https://stadeum.example/lab").invite?.code, made.code);
    assert.match(made.qrSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
    const listed = (await invitesStep.run({}, ctx as never)) as { invites: Array<{ code: string; link: string }> };
    assert.equal(listed.invites.find((i) => i.code === made.code)?.link, made.link);
    assert.deepEqual(await cancelInviteStep.run({ code: made.code }, ctx as never), { code: made.code, status: "cancelled" });
    const pets = (await inviteStep.run({ type: "pets" }, ctx as never)) as { code: string; link: string; type: string };
    assert.equal(pets.type, "pets");
    assert.equal(opened(pets.link, "https://stadeum.example/lab").type, "pets");
    // The step refuses a page that is not strut's staff app shown to an admin.
    await assert.rejects(inviteStep.run({}, { ...ctx, app: { name: "mine", version: "v1" } } as never), /is an admin's/);
  });

  it("what an invite gives: its invite-only work to its first worker and nobody after, whichever app draws it; open work, no grant; a link sent before invites named their work, what it gave then", async () => {
    assert.equal((await req("/tasks/types/court-work", { method: "PUT", headers: keyed, body: JSON.stringify({ app: "court", answer: { type: "boolean" }, open: false }) })).status, 200);
    assert.equal((await req("/tasks/types/court-other", { method: "PUT", headers: keyed, body: JSON.stringify({ app: "court", answer: { type: "boolean" }, open: false }) })).status, 200);
    assert.equal((await req("/public-view", { method: "PUT", headers: keyed, body: JSON.stringify({ apps: [{ name: WORKER_APP }, { name: "court" }] }) })).status, 200);
    const worker = strut.tasks.worker;
    // Tasks' dashboard: every app of the public view, the invite read for Tasks.
    const tasksMe = (actor: string, invite: string) => worker.me(actor, { apps: [WORKER_APP, "court"], inviteApp: WORKER_APP, invite });
    const tokenOf = (link: string) => new URLSearchParams(decodeURIComponent(decodeURIComponent(link.slice(link.indexOf("&a=") + 3)).split("&input=")[1]!)).get("invite")!;

    const made = (await (await req("/tasks/invites", { method: "POST", headers: keyed, body: JSON.stringify({ type: "court-work" }) })).json()) as { link: string };
    const first = await tasksMe("pip", tokenOf(made.link));
    assert.deepEqual(first.types.filter((t) => t.app === "court").map((t) => t.name), ["court-work"], "the work it names, and no other invite-only work");
    const second = await tasksMe("quin", tokenOf(made.link));
    assert.ok(!second.types.some((t) => t.name === "court-work"), "one person per invite");

    const open = (await (await req("/tasks/invites", { method: "POST", headers: keyed, body: "{}" })).json()) as { link: string };
    const rae = await tasksMe("rae", tokenOf(open.link));
    assert.ok(!rae.types.some((t) => t.app === "court"), "an invite for open work grants nothing");

    // A grant link sent before (its code strut's own, its token naming an app and no work).
    const old = inviteToken(`${GRANT_LINK_PREFIX}0123456789abcdef01`, "court", Date.now() + 86_400_000)!;
    const sam = await worker.me("sam", { app: "court", invite: old });
    assert.deepEqual(sam.types.map((t) => t.name).sort(), ["court-other", "court-work"], "every invite-only type of its app, as then");
  });

  it("POST /tasks/online refuses where there is no Tasks to put online", async () => {
    // This server seeds no strut/worker (no kit to build it): the route says so, and nothing is saved.
    const before = ((await (await req("/public-view", { headers: keyed })).json()) as { surface: { apps: unknown[] } }).surface;
    const res = await req("/tasks/online", { method: "POST", headers: keyed, body: "{}" });
    if (res.status === 200) return; // a machine that built it: worker.test.ts covers the rest
    assert.equal(res.status, 400, await res.clone().text());
    assert.deepEqual(((await (await req("/public-view", { headers: keyed })).json()) as { surface: { apps: unknown[] } }).surface.apps, before.apps);
  });

  it("GET /public/join answers without the key: the static page, its script pinned by hash; the QR library beside it", async () => {
    const page = await req("/public/join");
    assert.equal(page.status, 200);
    assert.equal(await page.text(), JOIN_PAGE);
    const csp = page.headers.get("content-security-policy")!;
    assert.equal(csp, JOIN_HEADERS["content-security-policy"]);
    const script = /<script>([\s\S]*)<\/script>/.exec(JOIN_PAGE)![1]!;
    assert.equal(script, JOIN_SCRIPT);
    assert.ok(csp.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`));
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const qr = await req("/public/join/qrcode.js");
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get("content-type")!, /^text\/javascript/);
    const lib = await qr.text();
    // A global `qrcode` that draws an SVG, as the page calls it.
    const g = { exports: undefined } as Record<string, unknown>;
    runInNewContext(`${lib}; this.svg = qrcode(0, "M"); this.svg.addData("x"); this.svg.make(); this.out = this.svg.createSvgTag({ cellSize: 4, margin: 4, scalable: true });`, g);
    assert.match(String(g["out"]), /^<svg /);
  });

  it("GET /public/join speaks the worker's language (plans/i18n.md): the link's lang=, else the browser's first; one script in each", async () => {
    const es = await req("/public/join", { headers: { "accept-language": "es-MX,es;q=0.9,en;q=0.8" } });
    const page = await es.text();
    assert.equal(page, joinPage(undefined, "es"));
    assert.match(page, /<html lang="es">/);
    assert.match(page, /<h1>Tienes una invitación<\/h1>/);
    assert.match(page, />Abrir en Peel</);
    assert.equal(es.headers.get("vary"), "accept-language");
    assert.equal(es.headers.get("content-security-policy"), JOIN_HEADERS["content-security-policy"], "the same script, the same hash");
    assert.equal(/<script>([\s\S]*)<\/script>/.exec(page)![1], JOIN_SCRIPT);
    // lang= on the link wins over the browser, both ways.
    assert.equal(await (await req("/public/join?lang=es", { headers: { "accept-language": "en-US" } })).text(), joinPage(undefined, "es"));
    assert.equal(await (await req("/public/join?lang=en", { headers: { "accept-language": "es-ES" } })).text(), JOIN_PAGE);
    // No language, or one the page does not speak: English.
    assert.equal(await (await req("/public/join", { headers: { "accept-language": "pt-BR,es;q=0.5" } })).text(), JOIN_PAGE);
    for (const [lang, accept, want] of [[undefined, undefined, "en"], ["", "es", "es"], ["es_MX", undefined, "es"], [" ES ", "en", "es"], ["fr", "es", "en"], [undefined, "*", "en"], [undefined, "es;q=0.8", "es"], ["constructor", undefined, "en"]] as const) {
      assert.equal(joinLang(lang, accept), want, `${lang} / ${accept}`);
    }
    // A name, escaped, in Spanish's word order.
    assert.match(joinPage("Acme & <Co>", "es"), /<h1>Acme &amp; &lt;Co&gt; te invita<\/h1>/);
  });
});

/** The join page's script in a stand-in browser: what it shows and links. */
async function runJoin(o: { hash: string; userAgent: string; release?: unknown; noClipboard?: boolean }) {
  const el = (id: string) => ({ id, hidden: true, href: "#", innerHTML: "" });
  const els = Object.fromEntries(["android", "elsewhere", "bad", "open", "again", "qr"].map((id) => [id, el(id)]));
  const appended: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const drawn: string[] = [];
  const copied: string[] = [];
  const href = `https://s.example/public/join${o.hash}`;
  runInNewContext(JOIN_SCRIPT, {
    // What /public/join/qrcode.js defines, once the page has loaded it.
    qrcode: () => ({ addData: (t: string) => drawn.push(t), make: () => {}, createSvgTag: () => "<svg>qr</svg>" }),
    location: { hash: o.hash, href },
    navigator: o.noClipboard ? { userAgent: o.userAgent } : { userAgent: o.userAgent, clipboard: { writeText: async (t: string) => void copied.push(t) } },
    document: { getElementById: (id: string) => els[id], createElement: () => ({}), head: { appendChild: (s: Record<string, unknown>) => appended.push(s) } },
    fetch: async (url: string) => {
      fetched.push(url);
      return { ok: o.release !== undefined, json: async () => o.release };
    },
    encodeURIComponent,
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { els, appended, fetched, drawn, copied, href };
}

describe("the join page's script (§5.8)", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
  const app = encodeURIComponent("https://s.example/?app=workers&solo=1&public=1");
  const hash = `#action=i&d=${D}&c=BBBB&a=${app}`;
  const intent = (fallback: string) => `intent://?action=i&d=${D}&c=BBBB&a=${app}#Intent;scheme=sphinx.chat;package=com.sphinx.peel;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;

  it("on Android: both buttons fire Peel's intent, the invite as it came and the fallback encoded — the releases page until the newest APK is known", async () => {
    const r = await runJoin({ hash, userAgent: ANDROID });
    assert.equal(r.els["android"]!.hidden, false);
    assert.equal(r.els["elsewhere"]!.hidden, true);
    assert.equal(r.els["open"]!.href, intent(PEEL_ANDROID_RELEASES));
    assert.equal(r.els["again"]!.href, intent(PEEL_ANDROID_RELEASES));
    assert.deepEqual(r.fetched, ["https://api.github.com/repos/stakwork/peel-android/releases/latest"]);
    const apk = "https://github.com/stakwork/peel-android/releases/download/v0.1.4/peel-0.1.4.apk";
    const latest = await runJoin({ hash, userAgent: ANDROID, release: { assets: [{ browser_download_url: "https://github.com/stakwork/peel-android/releases/download/v0.1.4/notes.txt" }, { browser_download_url: apk }] } });
    assert.equal(latest.els["open"]!.href, intent(apk));
    assert.equal(latest.els["again"]!.href, intent(apk));
    // Another host's file is never the fallback.
    const evil = await runJoin({ hash, userAgent: ANDROID, release: { assets: [{ browser_download_url: "https://evil.example/peel.apk" }] } });
    assert.equal(evil.els["open"]!.href, intent(PEEL_ANDROID_RELEASES));
    // The daemon's whole link after # reads the same.
    const whole = await runJoin({ hash: `#sphinx.chat://?action=i&d=${D}&c=BBBB&a=${app}`, userAgent: ANDROID });
    assert.equal(whole.els["open"]!.href, intent(PEEL_ANDROID_RELEASES));
  });

  it("on Android: a tap on either button copies the invite link, for a Peel installed after it to read; nothing before a tap", async () => {
    const r = await runJoin({ hash, userAgent: ANDROID });
    assert.deepEqual(r.copied, [], "the clipboard is written only on a gesture");
    const tap = (id: string) => (r.els[id] as unknown as { onclick: () => void }).onclick();
    tap("open");
    tap("again");
    assert.deepEqual(r.copied, [`sphinx.chat://?action=i&d=${D}&c=BBBB&a=${app}`, `sphinx.chat://?action=i&d=${D}&c=BBBB&a=${app}`]);
    // No clipboard (an old browser, a refusal): the tap still opens Peel.
    const none = await runJoin({ hash, userAgent: ANDROID, noClipboard: true });
    assert.doesNotThrow(() => (none.els["open"] as unknown as { onclick: () => void }).onclick());
    assert.equal(none.els["open"]!.href, intent(PEEL_ANDROID_RELEASES));
  });

  it("anywhere else: open it on an Android phone, a QR code of the page's own URL; no invite: says so and fires nothing", async () => {
    const r = await runJoin({ hash, userAgent: IPHONE });
    assert.equal(r.els["elsewhere"]!.hidden, false);
    assert.equal(r.els["android"]!.hidden, true);
    assert.deepEqual(r.fetched, []);
    assert.equal(r.appended.length, 1);
    assert.equal(r.appended[0]!["src"], "join/qrcode.js");
    // Drawn once the library loads, from location.href — the invite in it.
    (r.appended[0]!["onload"] as () => void)();
    assert.deepEqual(r.drawn, [r.href]);
    assert.equal(r.els["qr"]!.innerHTML, "<svg>qr</svg>");
    for (const bad of ["", "#", "#action=i&c=x", "#action=t&d=x", `#action=i&d=${D}#more`]) {
      const b = await runJoin({ hash: bad, userAgent: ANDROID });
      assert.equal(b.els["bad"]!.hidden, false, bad);
      assert.equal(b.els["android"]!.hidden, true, bad);
      assert.equal(b.els["open"]!.href, "#", bad);
    }
  });
});
