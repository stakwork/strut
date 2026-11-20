/**
 * Peel links to a box (plans/people-and-hosts.md §2.1): a link challenge
 * naming a person, signed by Peel's Sphinx key as a Lightning message and
 * posted to `POST /people/link`, links `sphinx:<key>` to them and answers a
 * person token that names the account. The token holds while the link does;
 * Peel renews it by signing again (`GET /people/challenge`,
 * `POST /people/token`). The three routes answer without the key. Tests sign
 * as Peel would, with a test secp256k1 key (as src/visitors.test.ts does).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { LINK_CHALLENGE_MS, LINKED_TOKEN_DAYS, linkChallenge, verifyPersonToken } from "./auth.js";
import { lnSign, setEnv } from "./test-util/public-door.js";

const KEY = "people-link-key";
const BOX = "box.test";
const json = { "content-type": "application/json" };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Peel: a Sphinx key, and what it posts for a challenge. */
function peel() {
  const priv = secp256k1.utils.randomPrivateKey();
  const key = hex(secp256k1.getPublicKey(priv, true));
  return { key, signed: (challenge: string, extra: Record<string, unknown> = {}) => ({ challenge, key, sig: hex(lnSign(priv, challenge)), ...extra }) };
}

describe("Peel links to a box (plans/people-and-hosts.md §2.1)", () => {
  let dir: string;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  const req = (path: string, init: RequestInit & { host?: string } = {}) => strut.app.request(`http://${init.host ?? BOX}${path}`, init);
  const post = (path: string, body: unknown, host?: string) => req(path, { method: "POST", headers: json, body: JSON.stringify(body), ...(host ? { host } : {}) });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  /** A challenge the person's page would show (`account/link`). */
  const offer = (actor: string, name?: string) => linkChallenge({ host: BOX, actor, ...(name ? { name } : {}) })!.challenge;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-people-link-"));
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_PUBLIC_URL: undefined, STRUT_HOST_KEYS: undefined });
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      autoResume: false,
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    await strut.workspace.publishWorkflowByContent("hello", 'name: hello\npeer: true\nsteps:\n  - id: say\n    type: log\n    config:\n      message: "hi"\n');
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    restoreEnv?.();
    await rm(dir, { recursive: true, force: true });
  });

  it("the three routes answer without the key; every other route still needs it", async () => {
    const challenge = await req("/people/challenge");
    assert.equal(challenge.status, 200, await challenge.clone().text());
    const got = (await challenge.json()) as { challenge: string; exp: number };
    assert.match(got.challenge, /^strut-link\./);
    assert.ok(got.exp > Date.now() && got.exp <= Date.now() + 60_000, "a renewal's challenge lives a minute");
    assert.equal((await post("/people/link", {})).status, 401, "refused for what it carries, not for a missing key");
    assert.equal((await post("/people/token", {})).status, 401);
    assert.equal((await post("/people/link", "not an object")).status, 400);
    for (const [method, path] of [["GET", "/workflows"], ["GET", "/conversations"], ["GET", "/people"], ["POST", "/hosts/link"], ["POST", "/people/other"]] as const) {
      assert.equal((await req(path, { method, ...(method === "POST" ? { headers: json, body: "{}" } : {}) })).status, 401, `${method} ${path}`);
    }
    // A body Peel would never send is refused before it is read whole.
    const big = await req("/people/link", { method: "POST", headers: json, body: JSON.stringify({ challenge: "x".repeat(9_000) }) });
    assert.equal(big.status, 413);
  });

  it("a challenge naming a person links the key that signs it; the token is that person's, for seven days", async () => {
    const ada = peel();
    const address = `${ada.key}_03${"1".repeat(64)}_7`;
    const res = await post("/people/link", ada.signed(offer("ada", "Ada Lovelace"), { name: "Ada on Sphinx", address }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { actor: string; name?: string; token: string; exp: number };
    assert.equal(body.actor, "ada");
    assert.equal(body.name, "Ada on Sphinx", "the name strut shows for her: the account's, she has none of her own");
    assert.ok(Math.abs(body.exp - (Date.now() + LINKED_TOKEN_DAYS * 86_400_000)) < 60_000);
    assert.deepEqual(verifyPersonToken(body.token), { actor: "ada", exp: body.exp, account: `sphinx:${ada.key}` }, "a person token naming the account");
    const link = await strut.people.linkOf({ kind: "sphinx", key: ada.key });
    assert.deepEqual([link?.actor, link?.name, link?.address, link?.host], ["ada", "Ada on Sphinx", address, undefined]);
    // As Ada: a person route reads her own, and a run launched with it is hers.
    const listed = await req("/conversations", { headers: bearer(body.token) });
    assert.equal(listed.status, 200, await listed.clone().text());
    const launched = await req("/workflows/hello/run", { method: "POST", headers: { ...json, ...bearer(body.token) }, body: JSON.stringify({}) });
    assert.equal(launched.status, 202, await launched.clone().text());
    const { runId } = (await launched.json()) as { runId: string };
    let start: { actor?: string } | undefined;
    for (let i = 0; i < 200 && !start; i++) {
      start = ((await (await req(`/workflows/hello/runs/${runId}/events`, { headers: bearer(KEY) })).json()) as Array<{ type: string }>).find((e) => e.type === "run.start") as typeof start;
      if (!start) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(start?.actor, "ada");
    // Not an admin's: a person token's scope, as any.
    assert.equal((await req("/people?actor=ada", { headers: bearer(body.token) })).status, 403);
  });

  it("a challenge is refused reused, expired, for another host or naming nobody; a bad signature does not burn it", async () => {
    const bob = peel();
    const challenge = offer("bob");
    const wrong = await post("/people/link", { ...bob.signed(challenge), sig: hex(lnSign(secp256k1.utils.randomPrivateKey(), challenge)) });
    assert.equal(wrong.status, 401);
    assert.match(((await wrong.json()) as { error: string }).error, /signature does not hold/);
    assert.equal((await post("/people/link", bob.signed(`${challenge.slice(0, -2)}xx`))).status, 401, "not strut's");
    assert.equal((await post("/people/link", { ...bob.signed(challenge), key: "02nothex" })).status, 400);
    assert.equal((await post("/people/link", bob.signed(challenge), "other.test")).status, 401, "another host's");
    assert.equal((await post("/people/link", bob.signed(challenge))).status, 200, "still good after the refusals");
    const again = await post("/people/link", bob.signed(challenge));
    assert.equal(again.status, 401);
    assert.match(((await again.json()) as { error: string }).error, /already used/);
    const expired = linkChallenge({ host: BOX, actor: "bob" }, -1)!.challenge;
    assert.equal((await post("/people/link", bob.signed(expired))).status, 401);
    const renewal = ((await (await req("/people/challenge")).json()) as { challenge: string }).challenge;
    const nobody = await post("/people/link", bob.signed(renewal));
    assert.equal(nobody.status, 401);
    assert.match(((await nobody.json()) as { error: string }).error, /links nobody/);
    assert.equal(LINK_CHALLENGE_MS, 10 * 60_000);
    assert.equal((await post("/people/link", peel().signed(offer("bob"), { address: "not-an-address" }))).status, 400);
    assert.equal((await post("/people/link", peel().signed(offer("bob"), { name: 42 }))).status, 400);
  });

  it("a key linked to someone else is a 409; its own person links it again", async () => {
    const cat = peel();
    assert.equal((await post("/people/link", cat.signed(offer("cat")))).status, 200);
    const taken = await post("/people/link", cat.signed(offer("dan")));
    assert.equal(taken.status, 409);
    assert.match(((await taken.json()) as { error: string }).error, /^linked_elsewhere: /);
    assert.equal((await strut.people.linkOf({ kind: "sphinx", key: cat.key }))?.actor, "cat");
    assert.equal((await post("/people/link", cat.signed(offer("cat"), { name: "Cat" }))).status, 200);
    assert.equal((await strut.people.linkOf({ kind: "sphinx", key: cat.key }))?.name, "Cat");
  });

  it("removing the link ends the token at once, and linking the key to another does not bring it back", async () => {
    const eve = peel();
    const { token } = (await (await post("/people/link", eve.signed(offer("eve")))).json()) as { token: string };
    assert.equal((await req("/conversations", { headers: bearer(token) })).status, 200);
    assert.equal(await strut.people.unlink({ kind: "sphinx", key: eve.key }, "eve"), true);
    const gone = await req("/conversations", { headers: bearer(token) });
    assert.equal(gone.status, 401);
    assert.match(((await gone.json()) as { error: string }).error, /no longer linked/);
    assert.equal((await post("/people/link", eve.signed(offer("fay")))).status, 200);
    assert.equal((await req("/conversations", { headers: bearer(token) })).status, 401, "the key is Fay's now, not Eve's");
  });

  it("renewal: a linked key signs a fresh challenge for a new token; an unlinked one is 403 not_linked", async () => {
    const gus = peel();
    assert.equal((await post("/people/link", gus.signed(offer("gus"), { name: "Gus" }))).status, 200);
    const renew = async (who: ReturnType<typeof peel>) => {
      const { challenge } = (await (await req("/people/challenge")).json()) as { challenge: string };
      return post("/people/token", who.signed(challenge));
    };
    const res = await renew(gus);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { actor: string; name?: string; token: string };
    assert.deepEqual([body.actor, body.name], ["gus", "Gus"]);
    assert.equal(verifyPersonToken(body.token)?.account, `sphinx:${gus.key}`);
    assert.equal((await req("/conversations", { headers: bearer(body.token) })).status, 200);
    const stranger = await renew(peel());
    assert.equal(stranger.status, 403);
    assert.match(((await stranger.json()) as { error: string }).error, /^not_linked: /);
    // A challenge renews once, and only here.
    const { challenge } = (await (await req("/people/challenge")).json()) as { challenge: string };
    assert.equal((await post("/people/token", gus.signed(challenge), "other.test")).status, 401);
    assert.equal((await post("/people/token", gus.signed(challenge))).status, 200);
    assert.equal((await post("/people/token", gus.signed(challenge))).status, 401);
  });
});
