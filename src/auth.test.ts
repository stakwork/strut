import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Context } from "hono";
import { requireApiKey, fileToken, fileScopeOf, carriesFileToken, carriesBadFileToken, scopeFromKey, actorFromHeader, _resetAuthState, sessionToken, verifySessionToken, issueSession, sessionCookie, sessionOf, sessionFromCookie, sessionTtlMs, apiKeyMatches, carriesApiKey } from "./auth.js";

/**
 * Tests for the deployment-scoped shared-secret middleware.
 *
 * We attach `requireApiKey` to a minimal Hono app rather than importing the
 * real `server.ts`, which has module-level state (workspace, registry) we
 * don't want polluting the dev workspace.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.post("/steps", requireApiKey, (c) => c.json({ ok: true, hit: "post" }));
  app.delete("/steps", requireApiKey, (c) => c.json({ ok: true, hit: "delete-bulk" }));
  app.delete("/steps/:name{.+}", requireApiKey, (c) =>
    c.json({ ok: true, hit: "delete-one", name: c.req.param("name") }),
  );
  app.get("/steps", (c) => c.json({ ok: true, hit: "get" })); // unprotected
  return app;
}

describe("requireApiKey middleware", () => {
  const originalKey = process.env["STRUT_API_KEY"];

  beforeEach(() => {
    _resetAuthState();
    delete process.env["STRUT_API_KEY"];
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = originalKey;
    _resetAuthState();
  });

  // ── Permissive / dev mode ────────────────────────────────────────────────

  describe("when STRUT_API_KEY is unset", () => {
    it("allows POST /steps without any auth header", async () => {
      const app = buildApp();
      const res = await app.request("/steps", { method: "POST" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { hit: string };
      assert.equal(body.hit, "post");
    });

    it("allows DELETE /steps without any auth header", async () => {
      const app = buildApp();
      const res = await app.request("/steps", { method: "DELETE" });
      assert.equal(res.status, 200);
    });

    it("allows DELETE /steps/:name without any auth header", async () => {
      const app = buildApp();
      const res = await app.request("/steps/gitree/save-pr", { method: "DELETE" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { name: string };
      assert.equal(body.name, "gitree/save-pr");
    });

    it("treats empty-string STRUT_API_KEY the same as unset", async () => {
      process.env["STRUT_API_KEY"] = "";
      const app = buildApp();
      const res = await app.request("/steps", { method: "POST" });
      assert.equal(res.status, 200);
    });
  });

  // ── Enforced ─────────────────────────────────────────────────────────────

  describe("when STRUT_API_KEY is set", () => {
    const KEY = "k_test_abc_123";

    beforeEach(() => {
      process.env["STRUT_API_KEY"] = KEY;
    });

    it("accepts a request with the matching bearer token", async () => {
      const app = buildApp();
      const res = await app.request("/steps", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
      });
      assert.equal(res.status, 200);
    });

    it("accepts case-insensitive 'Bearer' scheme", async () => {
      const app = buildApp();
      const res = await app.request("/steps", {
        method: "POST",
        headers: { authorization: `bearer ${KEY}` },
      });
      assert.equal(res.status, 200);
    });

    it("rejects a request with no Authorization header", async () => {
      const app = buildApp();
      const res = await app.request("/steps", { method: "POST" });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.ok(body.error.toLowerCase().includes("unauthorized"));
    });

    it("rejects a request with a wrong bearer token", async () => {
      const app = buildApp();
      const res = await app.request("/steps", {
        method: "POST",
        headers: { authorization: "Bearer wrong-key" },
      });
      assert.equal(res.status, 401);
    });

    it("rejects a request that omits the Bearer scheme", async () => {
      const app = buildApp();
      const res = await app.request("/steps", {
        method: "POST",
        headers: { authorization: KEY },
      });
      assert.equal(res.status, 401);
    });

    it("rejects an empty Bearer token", async () => {
      const app = buildApp();
      const res = await app.request("/steps", {
        method: "POST",
        headers: { authorization: "Bearer " },
      });
      assert.equal(res.status, 401);
    });

    it("gates DELETE /steps the same way", async () => {
      const app = buildApp();

      const bad = await app.request("/steps", { method: "DELETE" });
      assert.equal(bad.status, 401);

      const good = await app.request("/steps?publisher=mcp", {
        method: "DELETE",
        headers: { authorization: `Bearer ${KEY}` },
      });
      assert.equal(good.status, 200);
    });

    it("gates DELETE /steps/:name the same way", async () => {
      const app = buildApp();

      const bad = await app.request("/steps/gitree/save-pr", {
        method: "DELETE",
      });
      assert.equal(bad.status, 401);

      const good = await app.request("/steps/gitree/save-pr", {
        method: "DELETE",
        headers: { authorization: `Bearer ${KEY}` },
      });
      assert.equal(good.status, 200);
    });

    it("does NOT gate GET /steps (reads remain public)", async () => {
      const app = buildApp();
      const res = await app.request("/steps", { method: "GET" });
      assert.equal(res.status, 200);
    });
  });
});

// ── File read tokens ─────────────────────────────────────────────────────
// The key attenuated to one run's (or job's) files — what an artifact link
// carries, since a served page can read its own URL.

describe("the peer key (plans/federation.md §3)", () => {
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"] };
  beforeEach(() => {
    delete process.env["STRUT_API_KEY"];
    delete process.env["STRUT_PEER_KEY"];
  });
  afterEach(() => {
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** One read and one write behind requireApiKey, each saying what it saw. */
  const app = () => {
    const a = new Hono();
    const seen = (c: Context) => c.json({ scope: scopeFromKey(c), actor: actorFromHeader(c) ?? null });
    a.get("/r", requireApiKey, seen);
    a.post("/w", requireApiKey, seen);
    return a;
  };
  const as = (key: string, actor?: string) => ({
    headers: { authorization: `Bearer ${key}`, ...(actor ? { "x-strut-actor": actor } : {}) },
  });

  it("a peer's read, never its write; its actor is honored; the deployment key stays full", async () => {
    process.env["STRUT_API_KEY"] = "api";
    process.env["STRUT_PEER_KEY"] = "peer";
    const a = app();
    assert.deepEqual(await (await a.request("/r", as("peer", "alice-1"))).json(), { scope: "peer", actor: "alice-1" });
    assert.deepEqual(await (await a.request("/r?key=peer")).json(), { scope: "peer", actor: null });
    assert.equal((await a.request("/w", { method: "POST", ...as("peer") })).status, 401);
    assert.deepEqual(await (await a.request("/w", { method: "POST", ...as("api", "hive-1") })).json(), { scope: "full", actor: "hive-1" });
    assert.equal((await a.request("/r", as("nope", "mallory-9"))).status, 401);
  });

  it("unset, it opens nothing; with no API key it only narrows the request that carries it", async () => {
    process.env["STRUT_API_KEY"] = "api";
    const a = app();
    assert.equal((await a.request("/r", as("peer"))).status, 401);
    delete process.env["STRUT_API_KEY"];
    // Dev mode: everything is open, and nobody's word on who pays is taken...
    assert.deepEqual(await (await a.request("/r", as("whoever", "mallory-9"))).json(), { scope: "full", actor: null });
    // ...but a configured peer key still marks its request a peer's.
    process.env["STRUT_PEER_KEY"] = "peer";
    assert.deepEqual(await (await a.request("/r", as("peer", "alice-1"))).json(), { scope: "peer", actor: "alice-1" });
  });
});

describe("file tokens", () => {
  const originalKey = process.env["STRUT_API_KEY"];
  const originalSecret = process.env["STRUT_SECRET_KEY"];
  const KEY = "k_test_abc_123";

  beforeEach(() => {
    process.env["STRUT_API_KEY"] = KEY;
    delete process.env["STRUT_SECRET_KEY"];
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = originalKey;
    if (originalSecret === undefined) delete process.env["STRUT_SECRET_KEY"];
    else process.env["STRUT_SECRET_KEY"] = originalSecret;
  });

  it("signs with the secret-store key when there is no API key — never with its dev default", () => {
    delete process.env["STRUT_API_KEY"];
    assert.equal(fileToken({ kind: "run", id: "1" }), undefined);
    process.env["STRUT_SECRET_KEY"] = "lab-secret";
    const t = fileToken({ kind: "run", id: "1" })!;
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    process.env["STRUT_API_KEY"] = KEY; // the API key signs when both are set
    assert.notEqual(fileToken({ kind: "run", id: "1" }), t);
  });

  it("a ?t= strut cannot vouch for is a bad token, whatever the gate would say", async () => {
    const app = new Hono();
    app.get("/artifacts/:runId/:path{.+}", (c) => c.json({ bad: carriesBadFileToken(c) }));
    const bad = async (path: string) => ((await (await app.request(path)).json()) as { bad: boolean }).bad;
    const t = encodeURIComponent(fileToken({ kind: "run", id: "r1" })!);
    assert.equal(await bad("/artifacts/r1/page.html"), false); // no token: the gate's business
    assert.equal(await bad(`/artifacts/r1/page.html?t=${t}`), false);
    assert.equal(await bad(`/artifacts/r2/page.html?t=${t}`), true);
    assert.equal(await bad("/artifacts/r1/page.html?t="), true);
    delete process.env["STRUT_API_KEY"]; // no secret at all: nothing can be vouched for
    assert.equal(await bad(`/artifacts/r1/page.html?t=${t}`), true);
    assert.equal(await bad("/artifacts/r1/page.html"), false);
  });

  it("is the key attenuated to one scope: none without a key, one per scope, rotates with the key", () => {
    delete process.env["STRUT_API_KEY"];
    assert.equal(fileToken({ kind: "run", id: "1" }), undefined);
    process.env["STRUT_API_KEY"] = KEY;
    const t = fileToken({ kind: "run", id: "1" })!;
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fileToken({ kind: "run", id: "1" }), t);
    assert.notEqual(fileToken({ kind: "run", id: "2" }), t);
    assert.notEqual(fileToken({ kind: "job", id: "1" }), t);
    process.env["STRUT_API_KEY"] = "another";
    assert.notEqual(fileToken({ kind: "run", id: "1" }), t);
  });

  it("reads the scope off a path — the listing or anything under it, the id decoded", () => {
    assert.deepEqual(fileScopeOf("/artifacts/123"), { kind: "run", id: "123" });
    assert.deepEqual(fileScopeOf("/artifacts/123/a/b.html"), { kind: "run", id: "123" });
    assert.deepEqual(fileScopeOf("/jobs/a%2Fb/files"), { kind: "job", id: "a/b" });
    assert.deepEqual(fileScopeOf("/jobs/a%2Fb/files/plan.md"), { kind: "job", id: "a/b" });
    for (const path of [
      "/artifacts", "/artifacts/", "/jobs/x", "/jobs/x/files-x", "/jobs/x/holds",
      "/workflows/x/runs/1/events", "/artifacts/%E0%A4%A/x",
    ]) {
      assert.equal(fileScopeOf(path), undefined, path);
    }
  });

  it("opens a read under its scope and nothing else", async () => {
    const app = new Hono();
    app.use("*", (c, next) => (carriesFileToken(c) ? next() : requireApiKey(c, next)));
    const hit = (c: Context) => c.json({ ok: true });
    app.get("/artifacts/:runId", hit);
    app.get("/artifacts/:runId/:path{.+}", hit);
    app.get("/jobs/:id/files", hit);
    app.get("/jobs/:id/files/:path{.+}", hit);
    app.get("/workflows", hit);
    app.delete("/artifacts/:runId/:path{.+}", hit);
    const t = encodeURIComponent(fileToken({ kind: "run", id: "r1" })!);
    const j = encodeURIComponent(fileToken({ kind: "job", id: "a/b" })!);
    const status = async (path: string, method = "GET") => (await app.request(path, { method })).status;

    assert.equal(await status(`/artifacts/r1?t=${t}`), 200);
    assert.equal(await status(`/artifacts/r1/deep/page.html?t=${t}`), 200);
    assert.equal(await status(`/jobs/a%2Fb/files?t=${j}`), 200);
    assert.equal(await status(`/jobs/a%2Fb/files/plan.md?t=${j}`), 200);
    assert.equal(await status(`/artifacts/r1/page.html?key=${KEY}`), 200); // the key still does

    const tampered = `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`;
    for (const [path, method] of [
      [`/artifacts/r2/page.html?t=${t}`], // another run
      [`/artifacts/r1/page.html?t=${j}`], // a job's token on a run
      [`/jobs/a/files/plan.md?t=${j}`], // another job
      [`/artifacts/r1/page.html`], // no token
      [`/artifacts/r1/page.html?t=`],
      [`/artifacts/r1/page.html?t=${tampered}`],
      [`/artifacts/r1/page.html?key=${t}`], // a token is not the key
      [`/workflows?t=${t}`], // not a file route
      [`/artifacts/r1/page.html?t=${t}`, "DELETE"], // not a read
    ] as [string, string?][]) {
      assert.equal(await status(path, method), 401, `${method ?? "GET"} ${path}`);
    }
  });
});

describe("sessions (the login)", () => {
  const KEY = "deploy-key";
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_SESSION_HOURS"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env["STRUT_API_KEY"] = KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("signs a session and verifies it back; expiry, tampering and another secret refuse it", () => {
    const exp = Date.now() + 60_000;
    const token = sessionToken({ actor: "evan-1", exp })!;
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(verifySessionToken(token), { actor: "evan-1", exp });
    assert.deepEqual(verifySessionToken(sessionToken({ exp })!), { exp }, "no actor");
    // Expired: by the clock the verifier is handed, and by its own.
    assert.equal(verifySessionToken(token, exp), undefined);
    assert.equal(verifySessionToken(sessionToken({ exp: Date.now() - 1 })!), undefined);
    // Tampered: the payload (a later expiry, another actor) or the signature.
    const [payload, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ actor: "evan-1", exp: exp + 3_600_000 })).toString("base64url");
    assert.equal(verifySessionToken(`${forged}.${sig}`), undefined);
    assert.equal(verifySessionToken(`${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`), undefined);
    assert.equal(verifySessionToken(payload), undefined);
    assert.equal(verifySessionToken(""), undefined);
    assert.equal(verifySessionToken(`.${sig}`), undefined);
    // Signed under the key: rotating it ends every session.
    process.env["STRUT_API_KEY"] = "rotated";
    assert.equal(verifySessionToken(token), undefined);
    // No secret at all: nothing is signed, nothing verifies.
    delete process.env["STRUT_API_KEY"];
    assert.equal(sessionToken({ exp }), undefined);
    assert.equal(verifySessionToken(token), undefined);
    // STRUT_SECRET_KEY signs when it is the only secret (a strut behind a host's gate).
    process.env["STRUT_SECRET_KEY"] = "store-key";
    assert.ok(sessionToken({ exp }));
  });

  it("issueSession takes the deployment key and nothing else, for STRUT_SESSION_HOURS", () => {
    assert.equal(issueSession("wrong"), undefined);
    assert.equal(issueSession(""), undefined);
    assert.equal(issueSession("deploy-key-"), undefined, "a prefix is not the key");
    const before = Date.now();
    const issued = issueSession(KEY, "evan-1")!;
    assert.equal(issued.session.actor, "evan-1");
    assert.ok(issued.session.exp >= before + 12 * 3_600_000 && issued.session.exp <= Date.now() + 12 * 3_600_000, "12 h by default");
    assert.deepEqual(verifySessionToken(issued.token), issued.session);
    process.env["STRUT_SESSION_HOURS"] = "2";
    assert.equal(sessionTtlMs(), 2 * 3_600_000);
    assert.ok(issueSession(KEY)!.session.exp <= Date.now() + 2 * 3_600_000);
    process.env["STRUT_SESSION_HOURS"] = "nope";
    assert.equal(sessionTtlMs(), 12 * 3_600_000, "a bad value is the default");
    delete process.env["STRUT_API_KEY"];
    assert.equal(issueSession(KEY), undefined, "no key configured: nothing to sign in to");
  });

  it("the cookie is HttpOnly, SameSite=Lax, Secure on https, and cleared with Max-Age=0", () => {
    const set = sessionCookie("tok", Date.now() + 7_200_000, false);
    assert.match(set, /^strut_session=tok; Path=\/; Max-Age=7(199|200); HttpOnly; SameSite=Lax$/);
    assert.match(sessionCookie("tok", Date.now() + 7_200_000, true), /; Secure$/);
    assert.equal(sessionCookie(undefined, 0, false), "strut_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  });

  it("the gate spends a session on a read, or with the UI header; never on a write or a file read without it", async () => {
    const { token } = issueSession(KEY, "evan-1")!;
    const cookie = `other=1; strut_session=${token}`;
    const app = new Hono();
    app.get("/workflows", (c) => c.json({ session: sessionOf(c) ?? null, key: carriesApiKey(c), actor: actorFromHeader(c) ?? null }));
    app.post("/secrets", (c) => c.json({ key: carriesApiKey(c) }));
    app.get("/artifacts/:runId", (c) => c.json({ key: carriesApiKey(c) }));
    app.get("/artifacts/:runId/:path{.+}", (c) => c.json({ key: carriesApiKey(c) }));
    app.get("/jobs/:id/files/:path{.+}", (c) => c.json({ key: carriesApiKey(c) }));
    const get = async (path: string, headers: Record<string, string> = {}, method = "GET") =>
      (await app.request(path, { method, headers })).json() as Promise<any>;

    // A read: the cookie is enough, and names its actor.
    assert.deepEqual(await get("/workflows", { cookie }), { session: { actor: "evan-1", exp: verifySessionToken(token)!.exp }, key: true, actor: "evan-1" });
    // The header beside it changes nothing: a session's actor is who signed in.
    assert.equal((await get("/workflows", { cookie, "x-strut-actor": "mallory-9" })).actor, "evan-1");
    // A write needs the UI header (a cross-site form cannot set one).
    assert.deepEqual(await get("/secrets", { cookie }, "POST"), { key: false });
    assert.deepEqual(await get("/secrets", { cookie, "x-strut-ui": "1" }, "POST"), { key: true });
    // A file read never opens on the cookie alone — the listing fetch (the
    // header) and the `?t=` token do; an <img> or a navigation has neither.
    assert.deepEqual(await get("/artifacts/r1", { cookie }), { key: false });
    assert.deepEqual(await get("/artifacts/r1/page.html", { cookie }), { key: false });
    assert.deepEqual(await get("/jobs/j1/files/plan.md", { cookie }), { key: false });
    assert.deepEqual(await get("/artifacts/r1", { cookie, "x-strut-ui": "1" }), { key: true });
    // Not a session: no cookie, another cookie, a bad one, the key as a cookie.
    assert.equal((await get("/workflows")).key, false);
    assert.equal((await get("/workflows", { cookie: "other=1" })).key, false);
    assert.equal((await get("/workflows", { cookie: "strut_session=nope.nope" })).key, false);
    assert.equal((await get("/workflows", { cookie: `strut_session=${KEY}` })).key, false);
    // The key itself still works beside a stale cookie, and the header's actor with it.
    process.env["STRUT_API_KEY"] = "rotated";
    assert.equal((await get("/workflows", { cookie })).key, false, "rotated: the session is over");
    assert.deepEqual(await get("/workflows", { cookie, authorization: "Bearer rotated", "x-strut-actor": "hive-1" }), { session: null, key: true, actor: "hive-1" });
    // The WebSocket upgrade: a GET, judged without a context.
    process.env["STRUT_API_KEY"] = KEY;
    assert.equal(apiKeyMatches(undefined, null, cookie), true);
    assert.equal(apiKeyMatches(undefined, null, "strut_session=bad"), false);
    assert.equal(apiKeyMatches(undefined, null, undefined), false);
    assert.deepEqual(sessionFromCookie(cookie), verifySessionToken(token));
    // Scope: a session is `full`, the peer key beside it does not narrow it.
    process.env["STRUT_PEER_KEY"] = "peer";
    const scope = new Hono().get("/x", (c) => c.text(scopeFromKey(c)));
    assert.equal(await (await scope.request("/x", { headers: { cookie, authorization: "Bearer peer" } })).text(), "full");
    assert.equal(await (await scope.request("/x", { headers: { authorization: "Bearer peer" } })).text(), "peer");
    delete process.env["STRUT_PEER_KEY"];
  });
});
