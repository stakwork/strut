/**
 * Linked places (plans/jamie-in-tribes.md §4, §5.4): a person links a place
 * (a tribe) with the token Peel holds for a box, and the host keeps what it
 * is in to strut's list. The host says who and where it is
 * (`PUT /hosts/me`), and each change to its places nudges that hook with
 * `{ event: "places" }`, naming nothing; it reads `GET /hosts/places`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { personToken } from "./auth.js";
import { setEnv } from "./test-util/public-door.js";

const KEY = "places-key";
const HOST_TOKEN = "places-host-token";
const BOX = `03${"0b".repeat(32)}`;
const ADA = `02${"aa".repeat(32)}`;
const BOB = `02${"bb".repeat(32)}`;
const TRIBE = `02${"77".repeat(32)}`;
const LINK = `sphinx.chat://?action=tribeV2&pubkey=${TRIBE}&host=tribes.example`;

describe("linked places (plans/jamie-in-tribes.md §5.4)", () => {
  let dir: string;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let hook: Server;
  let hookUrl: string;
  const nudges: unknown[] = [];
  const json = { "content-type": "application/json" };
  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await strut.app.request(path, { method, headers: { ...json, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const host = { authorization: `Bearer ${HOST_TOKEN}` };
  /** The token Peel holds for the box: a person token naming the account. */
  const peel = (actor: string, key: string) => ({ authorization: `Bearer ${personToken(actor, 60_000, { account: `sphinx:${key}` })!.token}` });
  /** Waits until `n` nudges came, or fails. */
  const nudged = async (n: number) => {
    for (let i = 0; i < 200 && nudges.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(nudges.length, n, "nudges");
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-places-"));
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_HOST_KEYS: `sphinx:${HOST_TOKEN}` });
    hook = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        nudges.push({ url: req.url, body: JSON.parse(body) });
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/strut/places?token=t1`;
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      autoResume: false,
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    await strut.people.link({ kind: "sphinx", key: ADA }, "ada");
    await strut.people.setName("ada", "Ada", "host");
    await strut.people.link({ kind: "sphinx", key: BOB }, "bob");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await new Promise((r) => hook?.close(r));
    restoreEnv?.();
    await rm(dir, { recursive: true, force: true });
  });

  it("a host that hasn't said who it is takes no place; once it has, Peel is told its account", async () => {
    assert.deepEqual((await call("GET", "/people/places", peel("ada", ADA))).body, { hosts: [], places: [] });
    const early = await call("POST", "/people/places", peel("ada", ADA), { host: "sphinx", key: TRIBE, link: LINK });
    assert.equal(early.status, 404);
    assert.match(early.body["error"], /^no_host: /);
    // The host's own account, and an http(s) hook.
    assert.equal((await call("PUT", "/hosts/me", host, { account: "nope", hook: hookUrl })).status, 400);
    assert.equal((await call("PUT", "/hosts/me", host, { account: BOX, hook: "file:///etc/passwd" })).status, 400);
    assert.equal((await call("PUT", "/hosts/me", host, { account: `email:${BOX}`, hook: hookUrl })).status, 400);
    const me = await call("PUT", "/hosts/me", host, { account: `sphinx:${BOX}`, hook: hookUrl });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.deepEqual([me.body["name"], me.body["account"], "hook" in me.body], ["sphinx", `sphinx:${BOX}`, false]);
    assert.deepEqual((await call("GET", "/people/places", peel("ada", ADA))).body["hosts"], [{ host: "sphinx", account: `sphinx:${BOX}` }]);
    assert.equal(nudges.length, 0, "saying who it is changes no place");
  });

  it("a person links a place; the host is nudged and reads it, with its linker", async () => {
    const linked = await call("POST", "/people/places", peel("ada", ADA), { host: "sphinx", key: TRIBE, link: LINK, name: "Builders" });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body["account"], `sphinx:${BOX}`, "the host's account, for Peel to approve its join");
    assert.deepEqual([linked.body["place"]["key"], linked.body["place"]["account"]], [TRIBE, `sphinx:${ADA}`]);
    await nudged(1);
    assert.deepEqual(nudges[0], { url: "/strut/places?token=t1", body: { event: "places" } });
    const places = await call("GET", "/hosts/places", host);
    assert.deepEqual(places.body["places"].map((p: Record<string, unknown>) => [p["key"], p["link"], p["name"], p["account"], p["linkerName"]]), [[TRIBE, LINK, "Builders", `sphinx:${ADA}`, "Ada"]]);
    assert.deepEqual((await call("GET", "/people/places", peel("ada", ADA))).body["places"].map((p: Record<string, unknown>) => p["key"]), [TRIBE]);
    assert.deepEqual((await call("GET", "/people/places", peel("bob", BOB))).body["places"], []);
  });

  it("another person's place is a 409, and theirs to remove; a bad place is a 400", async () => {
    const taken = await call("POST", "/people/places", peel("bob", BOB), { host: "sphinx", key: TRIBE, link: LINK });
    assert.equal(taken.status, 409);
    assert.match(taken.body["error"], /^place_linked: /);
    assert.deepEqual((await call("DELETE", `/people/places/sphinx/${TRIBE}`, peel("bob", BOB))).body, { removed: false });
    assert.equal((await call("POST", "/people/places", peel("bob", BOB), { host: "sphinx", key: "a b", link: LINK })).status, 400);
    assert.equal((await call("POST", "/people/places", peel("bob", BOB), { host: "slack", key: "C1", link: "x" })).status, 400, "a sphinx account links sphinx places");
    // Her own again: refreshed, and the host is told only when the link moved.
    assert.equal((await call("POST", "/people/places", peel("ada", ADA), { host: "sphinx", key: TRIBE, link: LINK, name: "Builders!" })).status, 200);
    assert.equal((await call("POST", "/people/places", peel("ada", ADA), { host: "sphinx", key: TRIBE, link: `${LINK}&x=1` })).status, 200);
    await nudged(2);
  });

  it("removed by its linker, by the host, or with the linker's account; each nudges the host", async () => {
    assert.deepEqual((await call("DELETE", `/people/places/sphinx/${TRIBE}`, peel("ada", ADA))).body, { removed: true });
    await nudged(3);
    assert.deepEqual((await call("GET", "/hosts/places", host)).body["places"], []);
    assert.equal((await call("POST", "/people/places", peel("bob", BOB), { host: "sphinx", key: TRIBE, link: LINK })).status, 200, "free again");
    await nudged(4);
    assert.deepEqual((await call("DELETE", `/hosts/places/${TRIBE}`, host)).body, { removed: true });
    await nudged(5);
    assert.equal((await call("POST", "/people/places", peel("bob", BOB), { host: "sphinx", key: TRIBE, link: LINK })).status, 200);
    await nudged(6);
    assert.equal(await strut.people.unlink({ kind: "sphinx", key: BOB }, "bob"), true);
    await nudged(7);
    assert.deepEqual((await call("GET", "/hosts/places", host)).body["places"], []);
    await strut.people.link({ kind: "sphinx", key: BOB }, "bob");
  });

  it("each side keeps to its routes: a token naming no account links nothing; a host links no place", async () => {
    const plain = { authorization: `Bearer ${personToken("tom", 60_000)!.token}` };
    assert.equal((await call("GET", "/people/places", plain)).status, 403);
    assert.equal((await call("POST", "/people/places", plain, { host: "sphinx", key: TRIBE, link: LINK })).status, 403);
    assert.equal((await call("GET", "/people/places", { authorization: `Bearer ${KEY}` })).status, 403, "the deployment key is nobody's");
    assert.equal((await call("POST", "/people/places", host, { host: "sphinx", key: TRIBE, link: LINK })).status, 403);
    assert.equal((await call("GET", "/hosts/places", peel("ada", ADA))).status, 403);
    assert.equal((await call("PUT", "/hosts/me", peel("ada", ADA), { account: BOX, hook: hookUrl })).status, 403);
    assert.equal((await call("DELETE", `/hosts/places/${TRIBE}`, peel("ada", ADA))).status, 403);
    // Peel's token ends with its link, and so does its place's linker.
    await strut.people.unlink({ kind: "sphinx", key: ADA }, "ada");
    assert.equal((await call("GET", "/people/places", peel("ada", ADA))).status, 401);
  });
});
