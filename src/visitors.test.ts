/**
 * Signed-in visitors (plans/app-repos.md §5, work item 4; "Visitors,
 * offline"): the seam — verifiers, methods, Nostr and LNURL-auth — the
 * limits, and a public app's page calling as a visitor that signed strut's
 * challenge with a key: its own `app/state`, its own runs, a spending
 * workflow only as one anyone may run, nothing else of this server's; and
 * on a graph, rows of the app's declared types kept as runs with its actor.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager, FileWorkspaceStore } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { defineStep } from "./core.js";
import { verifyChannelTicket } from "./auth.js";
import { kitForTests } from "./test-util/app-kit.js";
import { STEP_RUN_TOOL } from "./apps/tools.js";
import { createRegistry } from "./steps/registry.js";
import { VISIT_HEADER, emptySurface } from "./public-surface.js";
import { testBackends } from "./graph/test-util.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import type { GraphBackend } from "./graph/backend.js";
import {
  ADDRESS_VISITOR_LIMITS, DEFAULT_VISITOR_LIMITS, VERIFIERS, createLnurlLogins, createVisitorBudget, hostOfRequest, lnurlLogin, nostrSigner,
  offeredMethods, signedInRefusal, visitorLimits, visitorWrite,
} from "./visitors.js";

const subtle = webcrypto.subtle;
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
const sha256 = (s: string | Uint8Array) => new Uint8Array(createHash("sha256").update(s).digest());
const utf8 = (s: string) => new TextEncoder().encode(s);
const p256Key = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const p256Sign = async (key: CryptoKeyPair, message: string) => ({
  key: hex(await subtle.exportKey("raw", key.publicKey)),
  sig: hex(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8(message))),
});
/** A child key derived one-way from a root key and a host — what a provider
 *  holding a root key does where the app asks for `visitorKey: domain`
 *  (LUD-05 derives a BIP-32 path from an HMAC of the domain; an HMAC of the
 *  host straight into a key is the same idea, for a test). */
/** A Lightning signed message the way sphinx-rs's `sign_bytes` makes one
 *  (the ln-message vectors are its real output): for keys a test makes. */
const lnSign = (priv: Uint8Array, message: string) => {
  const s = secp256k1.sign(sha256(sha256(Buffer.concat([utf8("Lightning Signed Message:"), utf8(message)]))), priv);
  return new Uint8Array([31 + s.recovery!, ...s.toCompactRawBytes()]);
};
const childKey = (root: Uint8Array, host: string) => {
  const n = secp256k1.CURVE.n;
  const k = BigInt(`0x${createHmac("sha256", root).update(host).digest("hex")}`) % n;
  return new Uint8Array(Buffer.from(k.toString(16).padStart(64, "0"), "hex"));
};

/** The wallet contract's vectors (specs/WALLET.md §7), which Peel copies:
 *  its sign-in signatures were made by Sphinx's own signer. */
const walletVectors = JSON.parse(readFileSync(new URL("../kit/src/wallet/vectors.json", import.meta.url), "utf-8")) as {
  sign_in_signatures: Array<{ name: string; message: string; key: string; sig: string; actor: string | null }>;
};

describe("ln-message: a Lightning signed message, as Sphinx's signer makes one (sphinx-rs sign_bytes)", () => {
  for (const v of walletVectors.sign_in_signatures) {
    it(`${v.name}: ${v.actor ? "names " + v.actor.slice(0, 13) + "…" : "refused"}`, async () => {
      assert.equal(await VERIFIERS["ln-message"]!(utf8(v.message), Buffer.from(v.key, "hex"), Buffer.from(v.sig, "hex")), v.actor);
    });
  }
  it("one key is one actor, whichever way it signed: a Sphinx signature and a Nostr one", async () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const key = secp256k1.getPublicKey(priv, true);
    const viaSchnorr = await VERIFIERS.bip340!(sha256("challenge"), schnorr.getPublicKey(priv), schnorr.sign(sha256("challenge"), priv));
    assert.equal(await VERIFIERS["ln-message"]!(utf8("the challenge"), key, lnSign(priv, "the challenge")), viaSchnorr);
  });
});

describe("the seam (plans/app-repos.md §5.2)", () => {
  it("ecdsa-p256: a WebCrypto key's signature names p256:<compressed key>; anything else is null", async () => {
    const key = await p256Key();
    const { key: pub, sig } = await p256Sign(key, "the challenge");
    const actor = await VERIFIERS["ecdsa-p256"]!(utf8("the challenge"), Buffer.from(pub, "hex"), Buffer.from(sig, "hex"));
    assert.match(actor ?? "", /^p256:0[23][0-9a-f]{64}$/);
    assert.equal(await VERIFIERS["ecdsa-p256"]!(utf8("another"), Buffer.from(pub, "hex"), Buffer.from(sig, "hex")), null);
    assert.equal(await VERIFIERS["ecdsa-p256"]!(utf8("the challenge"), new Uint8Array(33), Buffer.from(sig, "hex")), null, "not a point");
    assert.equal(await VERIFIERS["ecdsa-p256"]!(utf8("the challenge"), Buffer.from(pub, "hex"), new Uint8Array(70)), null, "not a signature");
    // The same key, compressed or not, is one actor.
    const compressed = Buffer.from(actor!.slice(5), "hex");
    assert.equal(await VERIFIERS["ecdsa-p256"]!(utf8("the challenge"), compressed, Buffer.from(sig, "hex")), actor);
  });

  it("ecdsa-secp256k1 (LNURL-auth) and bip340 name one secp256k1 key one actor, secp:<x-only>", async () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const k1 = sha256("k1");
    const der = secp256k1.sign(k1, priv).toDERRawBytes();
    const viaLnurl = await VERIFIERS["ecdsa-secp256k1"]!(k1, secp256k1.getPublicKey(priv, true), der);
    const viaSchnorr = await VERIFIERS.bip340!(sha256("challenge"), schnorr.getPublicKey(priv), schnorr.sign(sha256("challenge"), priv));
    assert.match(viaLnurl ?? "", /^secp:[0-9a-f]{64}$/);
    assert.equal(viaSchnorr, viaLnurl, "one key, whichever way it signed");
    assert.equal(await VERIFIERS["ecdsa-secp256k1"]!(sha256("other"), secp256k1.getPublicKey(priv, true), der), null);
    assert.equal(await VERIFIERS.bip340!(sha256("other"), schnorr.getPublicKey(priv), schnorr.sign(sha256("challenge"), priv)), null);
    assert.equal(VERIFIERS.webauthn, undefined, "named, not built");
  });

  it("one root key is one actor on every host; a child key per domain is one actor per domain", async () => {
    const root = secp256k1.utils.randomPrivateKey();
    const asRoot = await Promise.all(["moon.game", "other.game"].map(async (host) => VERIFIERS.bip340!(sha256(host), schnorr.getPublicKey(root), schnorr.sign(sha256(host), root))));
    assert.equal(asRoot[0], asRoot[1]);
    const asChild = await Promise.all(["moon.game", "other.game"].map(async (host) => {
      const child = childKey(root, host);
      return VERIFIERS.bip340!(sha256(host), schnorr.getPublicKey(child), schnorr.sign(sha256(host), child));
    }));
    assert.notEqual(asChild[0], asChild[1]);
    assert.notEqual(asChild[0], asRoot[0]);
  });

  it("methods: Nostr signs with its one key, so not where the app asks for a key per domain", () => {
    assert.deepEqual(offeredMethods(["key", "nostr", "lnurl"], "root"), ["key", "nostr", "lnurl"]);
    assert.deepEqual(offeredMethods(["key", "nostr", "lnurl"], "domain"), ["key", "lnurl"]);
    assert.equal(hostOfRequest({ host: "Moon.Game:8443", url: "http://x/" }), "moon.game");
    assert.equal(hostOfRequest({ forwardedHost: "moon.game, proxy", host: "10.0.0.1:3000", url: "http://x/" }), "moon.game");
    assert.equal(hostOfRequest({ url: "http://localhost:3000/visitors" }), "localhost");
  });

  it("nostr: a NIP-98 event holds for this URL, method and body, and nothing else", async () => {
    const priv = schnorr.utils.randomPrivateKey();
    const pubkey = hex(schnorr.getPublicKey(priv));
    const body = JSON.stringify({ challenge: "c", method: "nostr" });
    const url = "https://moon.game/visitors/session";
    const event = (o: { payload?: string; u?: string; at?: number } = {}) => {
      const tags = [["u", o.u ?? url], ["method", "POST"], ["payload", o.payload ?? hex(sha256(body))]];
      const created_at = o.at ?? Math.floor(Date.now() / 1000);
      const id = sha256(JSON.stringify([0, pubkey, created_at, 27235, tags, ""]));
      const ev = { id: hex(id), pubkey, created_at, kind: 27235, tags, content: "", sig: hex(schnorr.sign(id, priv)) };
      return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
    };
    const ok = await nostrSigner(event(), { url, method: "POST", body });
    assert.ok(!("error" in ok));
    assert.equal(await VERIFIERS.bip340!(ok.id, ok.key, ok.sig), `secp:${pubkey}`);
    for (const [bad, why] of [
      [event({ payload: hex(sha256("another body")) }), /payload/],
      [event({ u: "https://elsewhere/visitors/session" }), /u tag/],
      [event({ at: Math.floor(Date.now() / 1000) - 3600 }), /created_at/],
      ["Bearer x", /Authorization: Nostr/],
    ] as const) {
      const got = await nostrSigner(bad, { url, method: "POST", body });
      assert.ok("error" in got && why.test(got.error), JSON.stringify(got));
    }
  });

  it("lnurl: a wallet signs k1, and only the page that holds the challenge takes the session — once", async () => {
    const logins = createLnurlLogins();
    const { k1 } = logins.register("challenge-1", "moon.game");
    assert.deepEqual({ ...logins.take(k1, "challenge-1", "moon.game"), exp: 0 }, { pending: true, exp: 0 });
    const priv = secp256k1.utils.randomPrivateKey();
    const k1b = Buffer.from(k1, "hex");
    assert.match(JSON.stringify(await logins.sign(k1, secp256k1.sign(k1b, secp256k1.utils.randomPrivateKey()).toDERRawBytes(), secp256k1.getPublicKey(priv, true))), /does not hold/);
    const signed = await logins.sign(k1, secp256k1.sign(k1b, priv).toDERRawBytes(), secp256k1.getPublicKey(priv, true));
    assert.ok("actor" in signed);
    assert.ok("error" in logins.take(k1, "another challenge", "moon.game"), "k1 alone, the code anyone saw, buys nothing");
    assert.deepEqual(logins.take(k1, "challenge-1", "moon.game"), { actor: signed.actor });
    assert.ok("error" in logins.take(k1, "challenge-1", "moon.game"), "taken once");
    const { url, lnurl } = lnurlLogin("https://moon.game/", k1);
    assert.equal(url, `https://moon.game/visitors/lnurl?tag=login&k1=${k1}&action=login`);
    assert.match(lnurl, /^LNURL1[02-9AC-HJ-NP-Z]+$/);
  });

  it("limits: per visitor per day, the public view's over strut's defaults, and the address's on top whatever they say", () => {
    assert.deepEqual(visitorLimits(emptySurface()), DEFAULT_VISITOR_LIMITS);
    const limits = visitorLimits({ visitors: { signIn: ["key"], limits: { writesPerDay: 2 } } });
    assert.deepEqual(limits, { writesPerDay: 2, launchesPerDay: DEFAULT_VISITOR_LIMITS.launchesPerDay });
    let now = Date.parse("2026-11-10T12:00:00Z");
    const budget = createVisitorBudget(() => now);
    for (let i = 0; i < 2; i++) {
      assert.equal(budget.check("write", "a", "1.2.3.4", limits), null);
      budget.spend("write", "a", "1.2.3.4");
    }
    assert.match(budget.check("write", "a", "1.2.3.4", limits) ?? "", /^visitor_limit: 2 writes a day for one visitor/);
    assert.equal(budget.check("write", "b", "1.2.3.4", limits), null, "another visitor has its own");
    assert.equal(budget.check("launch", "a", "1.2.3.4", limits), null, "launches are counted apart");
    // The address: every visitor on it together, whatever `limits` says.
    const generous = { writesPerDay: 1_000_000, launchesPerDay: 1_000_000 };
    for (let i = 0; i < ADDRESS_VISITOR_LIMITS.writesPerDay; i++) budget.spend("write", `v${i % 50}`, "5.6.7.8");
    assert.match(budget.check("write", "a-new-key", "5.6.7.8", generous) ?? "", /a day from one address/);
    assert.equal(budget.check("write", "a-new-key", "9.9.9.9", generous), null);
    // A new UTC day starts over.
    now += 86_400_000;
    assert.equal(budget.check("write", "a", "1.2.3.4", limits), null);
    assert.equal(budget.check("write", "a-new-key", "5.6.7.8", generous), null);
    assert.equal(visitorWrite("app/state", {}), false, "a read of the state is no write");
    assert.equal(visitorWrite("app/state", { set: { a: 1 } }), true);
    assert.equal(visitorWrite("graph/create-node", {}), true);
    assert.equal(visitorWrite("graph/find", {}), false);
  });

  it("the rules: §5.1's list over the anonymous visitor's, and nothing past the public view", async () => {
    const surface = { ...emptySurface(), apps: [{ name: "game" }], runnable: [{ kind: "workflow" as const, name: "paid", dailyCapUsd: 1 }] };
    const app = { name: "game", version: "v2" };
    const rules = { declared: ["Score"], spends: async (wf: string) => wf !== "score" };
    const refusal = (type: string, config: Record<string, unknown> = {}, live = "v2") => signedInRefusal(surface, live, app, type, config, rules);
    assert.equal(await refusal("app/state", { set: { a: 1 } }), null);
    assert.equal(await refusal("graph/create-node", { node_type: "Score" }), null, "the door checks the declared type");
    assert.equal(await refusal("graph/find", { node_type: "score" }), null);
    assert.match((await refusal("graph/find", { node_type: "Concept" }))!, /reads the types this app declares/);
    assert.match((await refusal("graph/find", { node_type: "Score", namespace: "other" }))!, /namespace/);
    assert.equal(await refusal("run/launch", { workflow: "score" }), null);
    assert.equal(await refusal("run/get", { workflow: "score", runId: "1" }), null);
    assert.equal(await refusal("run/launch", { workflow: "paid" }), null, "runnable: the public run door");
    assert.match((await refusal("run/launch", { workflow: "ghost" }))!, /can spend/);
    assert.match((await refusal("run/cancel", { workflow: "score" }))!, /stopping a run/);
    assert.match((await refusal("job/start", {}))!, /not available in the public view/);
    assert.match((await refusal("app/state", {}, "v1"))!, /not the version in the public view/);
    assert.match((await signedInRefusal(surface, "v1", { name: "other", version: "v1" }, "app/state", {}, rules))!, /not in this strut server's public view/);
    // A worker's step (plans/human-steps.md §5.2): passed for a signed-in
    // visitor where the step says it is one, on the app at its version only.
    assert.match((await refusal("task/next"))!, /not one of this app's public reads/, "with no worker rule, a step like any other");
    const worker = { ...rules, worker: (t: string) => t.startsWith("task/") };
    assert.equal(await signedInRefusal(surface, "v2", app, "task/next", {}, worker), null);
    assert.equal(await signedInRefusal(surface, "v2", app, "task/submit", { lease: "l", answer: {} }, worker), null);
    assert.match((await signedInRefusal(surface, "v1", app, "task/next", {}, worker))!, /not the version in the public view/);
    assert.match((await signedInRefusal(surface, "v2", app, "app/grant", {}, worker))!, /not available/);
  });

  it("a worker's step is no visitor write: the task store counts its calls per worker", () => {
    for (const t of ["task/next", "task/submit", "task/skip", "task/file", "task/me"]) assert.equal(visitorWrite(t, { answer: { a: 1 } }), false, t);
    assert.equal(visitorWrite("graph/create-node", {}), true);
    assert.equal(visitorWrite("app/state", { set: { a: 1 } }), true);
  });
});

// ── A public app's page, signed in ───────────────────────────────────────

const KEY = "visitors-test-key";
const json = { "content-type": "application/json" };
const auth = { authorization: `Bearer ${KEY}`, ...json };
const VISIT = "visit-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Counts what it was asked: a step that spends nothing. */
const tally = defineStep({
  type: "test/tally",
  input: z.object({ n: z.number() }),
  output: z.any(),
  async run(cfg) {
    return { n: cfg.n + 1 };
  },
});

const scoreYaml = "name: score\ninput:\n  n: { type: number, default: 1 }\nsteps:\n  - id: t\n    type: test/tally\n    config:\n      n: \"{{ input.n }}\"\n";
const spendingYaml = (name: string) => `name: ${name}\ninput:\n  q: { type: string, default: hi }\nsteps:\n  - id: ask\n    type: llm\n    config:\n      prompt: hello\n`;

describe("a signed-in visitor on a public app (plans/app-repos.md §5.1)", () => {
  let root: string;
  let saved: string | undefined;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const store = new MemoryRunStore();
  let identity: string;

  const req = (path: string, init: RequestInit & { host?: string } = {}) => strut.app.request(`http://${init.host ?? "moon.game"}${path}`, init);
  const challenge = async (host = "moon.game") => {
    const res = await req("/visitors/challenge", { host });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as { challenge: string; methods: string[]; visitorKey: string };
  };
  /** A key signs a challenge in: the session's answer, its cookie, and what was sent. */
  const signIn = async (key: CryptoKeyPair, host = "moon.game") => {
    const { challenge: c } = await challenge(host);
    const signed = await p256Sign(key, c);
    const body = JSON.stringify({ challenge: c, method: "key", ...signed });
    const res = await req("/visitors/session", { method: "POST", headers: json, body, host });
    const got = (await res.json()) as { actor: string; token: string; exp: number; error?: string };
    return { res, got, body, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  /** A page's call through the visitor's door, as its host sends it. */
  const call = async (type: string, config: Record<string, unknown>, headers: Record<string, string> = {}, app = identity) => {
    const res = await req("/public/mcp", {
      method: "POST",
      headers: { ...json, accept: "application/json, text/event-stream", [VISIT_HEADER]: VISIT, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app } } }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
    const out = JSON.parse(body.result.content[0].text) as Record<string, any>;
    return body.result.isError ? { error: out["error"] as string } : { result: out };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const putView = async (visitors: Record<string, unknown>) => {
    const res = await strut.app.request("/public-view", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ apps: [{ name: "game" }], runnable: [{ kind: "workflow", name: "paid", dailyCapUsd: 1 }], visitors }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-visitors-"));
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      workspace, store, kit, registry: await createRegistry([tally]),
      scheduler: false, serveUi: false, views: false, jamie: false, knowledge: false,
      job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    await workspace.publishWorkflowByContent("score", scoreYaml);
    for (const name of ["ghost", "paid"]) {
      await workspace.publishWorkflowByContent(name, spendingYaml(name));
      await workspace.setWorkflowOwner(name, "owner-1");
    }
    for (const [name, grants] of [["game", "[score, ghost, paid]"], ["other", "[score]"]] as const) {
      const dir = join(root, "apps", name);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "app.yaml"), `title: ${name}\ngrants:\n  workflows: ${grants}\n`);
      await writeFile(join(dir, "src", "App.tsx"), `export default function App() { return <p className="p-2">${name}</p>; }\n`);
      const r = await strut.apps.publish(dir, name, { surface: "person" });
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    }
    await putView({ signIn: ["key", "lnurl", "nostr"], limits: { writesPerDay: 4, launchesPerDay: 3 } });
    const html = await (await req("/public/apps/game/document")).text();
    identity = html.match(/<meta name="strut-app-token" content="([^"]+)">/)![1]!.replace(/&amp;/g, "&");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await rm(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });

  it("GET /visitors says how one signs in here and who this is", async () => {
    assert.deepEqual(await (await req("/visitors")).json(), { methods: ["key", "lnurl", "nostr"], visitorKey: "root" });
    const { got } = await signIn(await p256Key());
    const me = (await (await req("/visitors", { headers: bearer(got.token) })).json()) as { actor?: string };
    assert.equal(me.actor, got.actor);
  });

  it("a public view that names no sign-in offers a visitor's Sphinx account; `signIn: []` offers none", async () => {
    try {
      await putView(undefined as unknown as Record<string, unknown>);
      assert.deepEqual(await (await req("/visitors")).json(), { methods: ["sphinx"], visitorKey: "root" });
      assert.equal((await req("/visitors/challenge")).status, 200);
      const key = await p256Key();
      const refused = await signIn(key);
      assert.equal(refused.res.status, 401, "this browser's key is not offered by the default");
      assert.match(refused.got.error!, /"key" is not a sign-in this server offers/);
      await putView({ signIn: [] });
      assert.deepEqual(await (await req("/visitors")).json(), { methods: [], visitorKey: "root" });
      assert.equal((await req("/visitors/challenge")).status, 404);
    } finally {
      await putView({ signIn: ["key", "lnurl", "nostr"], limits: { writesPerDay: 4, launchesPerDay: 3 } });
    }
  });

  it("two keys sign in as two actors, each with its own app/state; an anonymous visitor keeps none", async () => {
    const a = await signIn(await p256Key());
    const b = await signIn(await p256Key());
    assert.equal(a.res.status, 200, JSON.stringify(a.got));
    assert.match(a.got.actor, /^p256:/);
    assert.notEqual(a.got.actor, b.got.actor);
    assert.match(a.cookie, /^strut_visitor=/);
    assert.deepEqual(await call("app/state", { set: { best: 10 } }, bearer(a.got.token)), { result: { state: { best: 10 } } });
    assert.deepEqual(await call("app/state", { set: { best: 20 } }, bearer(b.got.token)), { result: { state: { best: 20 } } });
    assert.deepEqual(await call("app/state", {}, bearer(a.got.token)), { result: { state: { best: 10 } } });
    const anonymous = await call("app/state", { set: { best: 99 } });
    assert.match(anonymous.error ?? "", /nothing is kept for a visitor/);
  });

  it("the token as a bearer works as the cookie does", async () => {
    const a = await signIn(await p256Key());
    await call("app/state", { set: { tab: "scores" } }, bearer(a.got.token));
    assert.deepEqual(await call("app/state", {}, { cookie: a.cookie, "x-strut-ui": "1" }), { result: { state: { tab: "scores" } } });
    assert.deepEqual(await call("app/state", {}, { "x-strut-visitor": a.got.token }), { result: { state: { tab: "scores" } } }, "beside a credit token");
    // The cookie alone, with no UI header, is no session: the CSRF rule.
    assert.match((await call("app/state", {}, { cookie: a.cookie })).error ?? "", /nothing is kept for a visitor/);
  });

  it("a challenge is good once, for its host, and a bad signature does not burn it", async () => {
    const key = await p256Key();
    const { challenge: c } = await challenge();
    const wrong = await p256Sign(await p256Key(), "something else");
    const refused = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: c, method: "key", key: wrong.key, sig: wrong.sig }) });
    assert.equal(refused.status, 401);
    const body = JSON.stringify({ challenge: c, method: "key", ...(await p256Sign(key, c)) });
    assert.equal((await req("/visitors/session", { method: "POST", headers: json, body })).status, 200);
    const replay = await req("/visitors/session", { method: "POST", headers: json, body });
    assert.equal(replay.status, 401);
    assert.match(((await replay.json()) as { error: string }).error, /already used/);
    // Minted for another host: refused here.
    const elsewhere = await challenge("other.game");
    const there = JSON.stringify({ challenge: elsewhere.challenge, method: "key", ...(await p256Sign(key, elsewhere.challenge)) });
    assert.match(((await (await req("/visitors/session", { method: "POST", headers: json, body: there })).json()) as { error: string }).error, /was for other\.game/);
    // Not strut's, and not a method here.
    assert.equal((await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: "strut-visitor.x.y", method: "key", key: "00", sig: "00" }) })).status, 401);
    assert.equal((await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: c, method: "passkey" }) })).status, 400);
  });

  it("one root key is one actor on two hosts; with visitorKey: domain each host's child key is another, and Nostr is not offered", async () => {
    const key = await p256Key();
    const [a, b] = [await signIn(key, "moon.game"), await signIn(key, "other.game")];
    assert.equal(a.got.actor, b.got.actor);
    await putView({ signIn: ["key", "lnurl", "nostr"], visitorKey: "domain", limits: { writesPerDay: 4, launchesPerDay: 3 } });
    try {
      const c = await challenge();
      assert.deepEqual(c.methods, ["key", "lnurl"]);
      assert.equal(c.visitorKey, "domain");
      // A provider signs with the domain's child of its root: two actors.
      const root = new Uint8Array(32).fill(7);
      const actors = [];
      for (const host of ["moon.game", "other.game"]) {
        const { challenge: ch } = await challenge(host);
        const child = childKey(root, host);
        // The `key` method's verifier is P-256; a child of a secp root signs
        // through a secp method — LNURL-auth's, per domain by its spec.
        const started = (await (await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: ch, method: "lnurl" }), host })).json()) as { k1: string };
        const k1 = Buffer.from(started.k1, "hex");
        const signed = await req(`/visitors/lnurl?tag=login&k1=${started.k1}&sig=${hex(secp256k1.sign(k1, child).toDERRawBytes())}&key=${hex(secp256k1.getPublicKey(child, true))}`, { host });
        assert.deepEqual(await signed.json(), { status: "OK" });
        const took = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: ch, method: "lnurl", k1: started.k1 }), host });
        assert.equal(took.status, 200);
        actors.push(((await took.json()) as { actor: string }).actor);
      }
      assert.notEqual(actors[0], actors[1]);
      // Nostr signs with its one key: refused where the app asks for a key per domain.
      const { challenge: ch } = await challenge();
      const nostr = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: ch, method: "nostr" }) });
      assert.equal(nostr.status, 401);
      assert.match(((await nostr.json()) as { error: string }).error, /key per domain/);
    } finally {
      await putView({ signIn: ["key", "lnurl", "nostr"], limits: { writesPerDay: 4, launchesPerDay: 3 } });
    }
  });

  it("nostr: an extension's NIP-98 event signs in as secp:<its key>", async () => {
    const priv = schnorr.utils.randomPrivateKey();
    const pubkey = hex(schnorr.getPublicKey(priv));
    const { challenge: c } = await challenge();
    const body = JSON.stringify({ challenge: c, method: "nostr" });
    const tags = [["u", "http://moon.game/visitors/session"], ["method", "POST"], ["payload", hex(sha256(body))]];
    const created_at = Math.floor(Date.now() / 1000);
    const id = sha256(JSON.stringify([0, pubkey, created_at, 27235, tags, ""]));
    const ev = { id: hex(id), pubkey, created_at, kind: 27235, tags, content: "", sig: hex(schnorr.sign(id, priv)) };
    const res = await req("/visitors/session", { method: "POST", headers: { ...json, authorization: `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}` }, body });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { actor: string }).actor, `secp:${pubkey}`);
  });

  it("sphinx: the person's Sphinx key signs the challenge as a Lightning message, and is secp:<its key>", async () => {
    await putView({ signIn: ["key", "sphinx"], limits: { writesPerDay: 4, launchesPerDay: 3 } });
    try {
      assert.deepEqual((await challenge()).methods, ["key", "sphinx"]);
      const priv = secp256k1.utils.randomPrivateKey();
      const key = hex(secp256k1.getPublicKey(priv, true));
      const post = (body: Record<string, unknown>) => req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify(body) });
      // Over another message, or naming another key: refused, and the challenge kept.
      const { challenge: c } = await challenge();
      const other = hex(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));
      assert.equal((await post({ challenge: c, method: "sphinx", key, sig: hex(lnSign(priv, `${c}x`)) })).status, 401, "a signature over another message");
      assert.equal((await post({ challenge: c, method: "sphinx", key: other, sig: hex(lnSign(priv, c)) })).status, 401, "another key named");
      assert.equal((await post({ challenge: c, method: "sphinx", sig: hex(lnSign(priv, c)) })).status, 400, "no key");
      const res = await post({ challenge: c, method: "sphinx", key, sig: hex(lnSign(priv, c)) });
      assert.equal(res.status, 200, await res.clone().text());
      const got = (await res.json()) as { actor: string; token: string };
      assert.equal(got.actor, `secp:${key.slice(2)}`);
      assert.deepEqual(await call("app/state", { set: { best: 1 } }, bearer(got.token)), { result: { state: { best: 1 } } });
      // The wallet derives the domain's child key itself: offered where the app asks for one.
      await putView({ signIn: ["key", "sphinx"], visitorKey: "domain", limits: { writesPerDay: 4, launchesPerDay: 3 } });
      assert.deepEqual((await challenge()).methods, ["key", "sphinx"]);
    } finally {
      await putView({ signIn: ["key", "lnurl", "nostr"], limits: { writesPerDay: 4, launchesPerDay: 3 } });
    }
    // Not a method this server offers now.
    const { challenge: c } = await challenge();
    const priv = secp256k1.utils.randomPrivateKey();
    const off = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: c, method: "sphinx", key: hex(secp256k1.getPublicKey(priv, true)), sig: hex(lnSign(priv, c)) }) });
    assert.equal(off.status, 401);
    assert.match(((await off.json()) as { error: string }).error, /not a sign-in this server offers/);
  });

  it("a host page on another origin signs a visitor in here: the sign-in routes answer it (CORS)", async () => {
    const pre = await req("/visitors/session", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);
    const preRead = await req("/visitors", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    assert.equal(preRead.status, 204);
    assert.match(preRead.headers.get("access-control-allow-headers") ?? "", /authorization/);
    const read = await req("/visitors/challenge", { headers: { origin: "http://localhost:5173" } });
    assert.equal(read.headers.get("access-control-allow-origin"), "*");
    const { challenge: c } = await challenge();
    const posted = await req("/visitors/session", { method: "POST", headers: { ...json, origin: "http://localhost:5173" }, body: JSON.stringify({ challenge: c, method: "key", ...(await p256Sign(await p256Key(), c)) }) });
    assert.equal(posted.status, 200);
    assert.equal(posted.headers.get("access-control-allow-origin"), "*");
    // Nothing else of this server's answers a preflight with it.
    const other = await req("/apps", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" } });
    assert.notEqual(other.headers.get("access-control-allow-origin"), "*");
  });

  it("lnurl: the page learns the session for its k1 once the wallet signed", async () => {
    const { challenge: c } = await challenge();
    const started = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: c, method: "lnurl" }) });
    assert.equal(started.status, 202);
    const { k1, lnurl, url } = (await started.json()) as { k1: string; lnurl: string; url: string };
    assert.equal(url, `http://moon.game/visitors/lnurl?tag=login&k1=${k1}&action=login`);
    assert.match(lnurl, /^LNURL1/);
    const poll = () => req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge: c, method: "lnurl", k1 }) });
    assert.equal((await poll()).status, 202, "the wallet has not signed yet");
    const priv = secp256k1.utils.randomPrivateKey();
    const bad = await req(`/visitors/lnurl?tag=login&k1=${k1}&sig=${hex(secp256k1.sign(Buffer.from(k1, "hex"), secp256k1.utils.randomPrivateKey()).toDERRawBytes())}&key=${hex(secp256k1.getPublicKey(priv, true))}`);
    assert.equal(((await bad.json()) as { status: string }).status, "ERROR");
    const ok = await req(`/visitors/lnurl?tag=login&k1=${k1}&sig=${hex(secp256k1.sign(Buffer.from(k1, "hex"), priv).toDERRawBytes())}&key=${hex(secp256k1.getPublicKey(priv, true))}`);
    assert.deepEqual(await ok.json(), { status: "OK" });
    const done = await poll();
    assert.equal(done.status, 200);
    assert.equal(((await done.json()) as { actor: string }).actor, `secp:${hex(secp256k1.getPublicKey(priv, true).slice(1))}`);
    assert.equal((await poll()).status, 401, "taken once");
  });

  it("a workflow that spends nothing launches as the visitor and reads back to it alone; one that spends only as one anyone may run", async () => {
    const a = await signIn(await p256Key());
    const b = await signIn(await p256Key());
    const launched = await call("run/launch", { workflow: "score", input: { n: 41 } }, bearer(a.got.token));
    const runId = (launched.result as { runId?: string } | undefined)?.runId;
    assert.ok(runId, JSON.stringify(launched));
    const got = await call("run/get", { workflow: "score", runId, wait: 10 }, bearer(a.got.token));
    const rec = got.result as Record<string, unknown>;
    assert.equal(rec["status"], "success", JSON.stringify(got));
    assert.deepEqual(rec["output"], { n: 42 });
    assert.equal(rec["actor"], undefined, "a visitor reads no actor ids");
    const summary = await store.getRunSummary("score", runId!);
    assert.equal(summary?.actor, a.got.actor);
    assert.equal(summary?.origin, "app");
    assert.match((await call("run/get", { workflow: "score", runId }, bearer(b.got.token))).error ?? "", /not found/, "another visitor's run is not theirs");
    assert.equal(((await call("run/list", { workflow: "score" }, bearer(a.got.token))).result as unknown as unknown[]).length, 1);
    assert.deepEqual((await call("run/list", { workflow: "score" }, bearer(b.got.token))).result, []);
    assert.match((await call("run/launch", { workflow: "score", job: "j1" }, bearer(a.got.token))).error ?? "", /input and key alone, not job/);
    // Spending, not runnable: refused, signed in or not.
    assert.match((await call("run/launch", { workflow: "ghost" }, bearer(a.got.token))).error ?? "", /can spend/);
    assert.match((await call("run/launch", { workflow: "ghost" })).error ?? "", /not open to visitors to run/);
    // Spending and runnable: the public run door, free under its daily cap.
    const paid = await call("run/launch", { workflow: "paid" }, bearer(a.got.token));
    assert.ok((paid.result as { runId?: string } | undefined)?.runId, JSON.stringify(paid));
    // And an anonymous visitor launches no workflow that is not runnable.
    assert.match((await call("run/launch", { workflow: "score" })).error ?? "", /not open to visitors to run/);
  });

  it("per-visitor limits from the public view, per actor, counted when they went", async () => {
    const a = await signIn(await p256Key());
    for (let i = 0; i < 4; i++) assert.ok(!("error" in (await call("app/state", { set: { i } }, bearer(a.got.token)))), `write ${i}`);
    assert.match((await call("app/state", { set: { i: 5 } }, bearer(a.got.token))).error ?? "", /visitor_limit: 4 writes a day for one visitor/);
    assert.ok(!("error" in (await call("app/state", {}, bearer(a.got.token)))), "a read is no write");
    for (let i = 0; i < 3; i++) assert.ok(!("error" in (await call("run/launch", { workflow: "score" }, bearer(a.got.token)))), `launch ${i}`);
    assert.match((await call("run/launch", { workflow: "score" }, bearer(a.got.token))).error ?? "", /visitor_limit: 3 launches a day/);
    const b = await signIn(await p256Key());
    assert.ok(!("error" in (await call("app/state", { set: { i: 1 } }, bearer(b.got.token)))), "another key has its own");
  });

  it("a visitor reaches neither Jamie, nor another app, nor a private read", async () => {
    const a = await signIn(await p256Key());
    for (const [method, path] of [["POST", "/mcp"], ["GET", "/apps"], ["GET", "/workflows"], ["GET", "/public-view"]] as const) {
      const res = await req(path, { method, headers: { ...bearer(a.got.token), ...json }, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(res.status, 403, path);
    }
    // Another app is not public: no document, no identity, and a forged one opens nothing.
    assert.equal((await req("/public/apps/other/document")).status, 404);
    const forged = identity.replace("app:game@", "app:other@");
    assert.match((await call("app/state", {}, bearer(a.got.token), forged)).error ?? "", /not a valid app identity/);
    // Its channel ticket: the public app's at the version the view serves, naming it.
    const version = identity.match(/^app:game@(v\d+)\./)![1]!;
    const ticket = await req("/apps/game/channel-ticket", { method: "POST", headers: { ...bearer(a.got.token), ...json }, body: JSON.stringify({ version }) });
    assert.equal(ticket.status, 200, await ticket.clone().text());
    assert.equal(verifyChannelTicket(((await ticket.json()) as { ticket: string }).ticket)?.actor, a.got.actor);
    assert.equal((await req("/apps/other/channel-ticket", { method: "POST", headers: { ...bearer(a.got.token), ...json }, body: JSON.stringify({ version: "v1" }) })).status, 403);
    assert.equal((await req("/apps/game/channel-ticket", { method: "POST", headers: { ...bearer(a.got.token), ...json }, body: JSON.stringify({ version: "v9" }) })).status, 403);
  });
});

// ── Rows a visitor writes, on a graph ────────────────────────────────────

for (const tb of testBackends()) describe(`a signed-in visitor's rows on ${tb.name}`, { skip: tb.skip }, () => {
  let b: GraphBackend;
  let root: string;
  let saved: string | undefined;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const store = new MemoryRunStore();
  let identity: string;

  const call = async (type: string, config: Record<string, unknown>, token?: string) => {
    const res = await strut.app.request("http://moon.game/public/mcp", {
      method: "POST",
      headers: { ...json, accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app: identity } } }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
    const out = JSON.parse(body.result.content[0].text) as Record<string, any>;
    return body.result.isError ? { error: out["error"] as string } : { result: out as unknown };
  };
  const signIn = async () => {
    const { challenge } = (await (await strut.app.request("http://moon.game/visitors/challenge")).json()) as { challenge: string };
    const signed = await p256Sign(await p256Key(), challenge);
    return (await (await strut.app.request("http://moon.game/visitors/session", { method: "POST", headers: json, body: JSON.stringify({ challenge, method: "key", ...signed }) })).json()) as { actor: string; token: string };
  };

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    b = await tb.open();
    await tb.wipe(b);
    await seedStrutDomain(b);
    root = await mkdtemp(join(tmpdir(), "strut-visitor-rows-"));
    strut = await createStrut({
      workspace: new FileWorkspaceStore(join(root, "ws")), store, graph: b, kit: await kitForTests(), registry: await createRegistry([]),
      scheduler: false, serveUi: false, enableChat: false, enableMcp: true, job: false, orchestrator: false, builder: false, concepts: false,
      views: false, jamie: false, knowledge: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    const dir = join(root, "apps", "board");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Board\ngrants:\n  steps: [graph/create-node, graph/find]\ndata:\n  graph:\n    types:\n      Score: { name: string, points: number }\n");
    await writeFile(join(dir, "src", "App.tsx"), 'export default function App() { return <p className="p-2">board</p>; }\n');
    const r = await strut.apps.publish(dir, "board", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    const put = await strut.app.request("/public-view", { method: "PUT", headers: auth, body: JSON.stringify({ apps: [{ name: "board" }], visitors: { signIn: ["key"] } }) });
    assert.equal(put.status, 200, await put.clone().text());
    const html = await (await strut.app.request("http://moon.game/public/apps/board/document")).text();
    identity = html.match(/<meta name="strut-app-token" content="([^"]+)">/)![1]!.replace(/&amp;/g, "&");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (b) await tb.close(b);
    await rm(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });

  it("each visitor's row is a kept run with its actor; every visitor reads the app's rows; nothing else is written or read", async () => {
    const [a, c] = [await signIn(), await signIn()];
    for (const [who, name, points] of [[a, "ada", 10], [c, "cy", 20]] as const) {
      const wrote = await call("graph/create-node", { node_type: "Score", node_data: { name, points } }, who.token);
      assert.ok(!("error" in wrote), JSON.stringify(wrote));
    }
    const kept = await Promise.all((await store.listRuns("step:graph/create-node")).map((id) => store.getRunSummary("step:graph/create-node", id)));
    assert.deepEqual(kept.map((s) => s?.actor).sort(), [a.actor, c.actor].sort(), "a row says who");
    const found = await call("graph/find", { node_type: "Score", orderBy: "points" }, c.token);
    const rows = (found.result as { nodes: Array<{ properties: Record<string, unknown> }> }).nodes;
    assert.deepEqual(rows.map((n) => n.properties["name"]).sort(), ["ada", "cy"]);
    assert.match((await call("graph/create-node", { node_type: "Concept", node_data: { name: "x" } }, a.token)).error ?? "", /refused/);
    assert.match((await call("graph/find", { node_type: "Concept" }, a.token)).error ?? "", /reads the types this app declares/);
    assert.match((await call("graph/create-node", { node_type: "Score", node_data: { name: "z", points: 1 } })).error ?? "", /not available in the public view/, "anonymous: no write");
  });
});
