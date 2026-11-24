/**
 * Secrets that refresh themselves (src/actor-secrets.ts; stadeum
 * plans/software.md §5 item 8): a person's token with an expiry and a
 * refresh token is renewed through the connect seam when a read finds it
 * near its end.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actorSecretStore, connectRefresher, type RefreshAnswer, type RefreshSecret } from "./actor-secrets.js";
import { MemorySecretStore } from "./secret-store.js";
import { secretScopesOf, secretsCapability, type StrutCapabilities } from "./capabilities.js";
import { flow, step, defineStep, type StepRegistry, type StepContext } from "./core.js";
import { runWorkflow } from "./runner.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";

const ACTOR = "evan-1";
/** Within the five-minute margin: the next read refreshes. */
const NEAR = 60;
/** Google's: an hour. */
const HOUR = 3599;

/** A seam that answers from `answer`, recording each refresh token spent. */
function fakeRefresh(answer: (refreshToken: string, n: number) => RefreshAnswer | Promise<RefreshAnswer>) {
  const spent: string[] = [];
  const refresh: RefreshSecret = async (provider, refreshToken) => {
    assert.equal(provider, "google");
    spent.push(refreshToken);
    return answer(refreshToken, spent.length);
  };
  return { refresh, spent };
}

/** A rotating provider: each refresh hands back a new pair. */
const rotating = (rt: string, n: number): RefreshAnswer => ({ ok: true, accessToken: `access-${n}`, expiresIn: HOUR, refreshToken: `${rt}+${n}` });

describe("actor secrets that refresh themselves", () => {
  it("hands over a value far from its end; refreshes one near its end first and keeps the new pair", async () => {
    const { refresh, spent } = fakeRefresh(rotating);
    const s = actorSecretStore(new MemorySecretStore(), { refresh });

    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: HOUR, refreshToken: "rt", provider: "google" });
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "access-0");
    assert.deepEqual(spent, [], "an hour left: no refresh");

    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "access-1");
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "access-1", "the new value lasts an hour");
    assert.deepEqual(spent, ["rt"]);
  });

  it("keeps the old refresh token when none comes back, and spends a rotated one next", async () => {
    const backing = new MemorySecretStore();
    let rotate = false;
    const { refresh, spent } = fakeRefresh((rt, n) =>
      rotate ? { ok: true, accessToken: `a${n}`, expiresIn: NEAR, refreshToken: `rt${n}` } : { ok: true, accessToken: `a${n}`, expiresIn: NEAR },
    );
    const s = actorSecretStore(backing, { refresh });
    await s.set(ACTOR, "GOOGLE_TOKEN", "a0", { expiresIn: NEAR, refreshToken: "rt0", provider: "google" });

    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "a1");
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "a2");
    rotate = true;
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "a3");
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "a4");
    assert.deepEqual(spent, ["rt0", "rt0", "rt0", "rt3"]);
  });

  it("refreshes one at a time: readers at once share one refresh, through any store over the same file", async () => {
    const backing = new MemorySecretStore();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { refresh, spent } = fakeRefresh(async (rt, n) => {
      await gate;
      return rotating(rt, n);
    });
    const one = actorSecretStore(backing, { refresh });
    const two = actorSecretStore(backing, { refresh });
    await one.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });

    const reads = [one, two, one, two, one].map((s) => s.get(ACTOR, "GOOGLE_TOKEN"));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(spent, ["rt"], "one refresh under way, the rest wait for it");
    open();
    assert.deepEqual(await Promise.all(reads), Array(5).fill("access-1"));
    assert.deepEqual(spent, ["rt"]);
  });

  it("two runs as one person never spend one refresh token", async () => {
    const { refresh, spent } = fakeRefresh(async (rt, n) => {
      await new Promise((r) => setTimeout(r, 5));
      // Each new pair is near its end again, so the next read refreshes too.
      return { ok: true, accessToken: `access-${n}`, expiresIn: NEAR, refreshToken: `${rt}+${n}` };
    });
    const actors = actorSecretStore(new MemorySecretStore(), { refresh });
    await actors.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });
    const services = { secrets: secretsCapability({}, { actors }) };
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => runWorkflow(readTwice, {}, registry, { services, actor: ACTOR, principal: ACTOR })),
    );
    for (const r of runs) assert.equal(r.status, "success");
    assert.equal(new Set(spent).size, spent.length, `a refresh token was spent twice: ${spent.join(", ")}`);
  });

  it("a refused refresh removes the secret, so the reader finds it missing", async () => {
    const backing = new MemorySecretStore();
    const { refresh } = fakeRefresh(() => ({ ok: false, refused: true, error: "invalid_grant" }));
    const s = actorSecretStore(backing, { refresh });
    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });

    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), undefined);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(await s.list(ACTOR), []);
    assert.deepEqual(await backing.list(), [], "the value and its refresh are both gone");
    // A person's read falls through to the deployment's, which a box leaves empty.
    const cap = secretsCapability({}, { actors: s });
    assert.equal(await cap.forPrincipal!(ACTOR).get("GOOGLE_TOKEN"), undefined);
  });

  it("not refreshed this time: the secret is kept, that read fails, and the next one tries again", async () => {
    const backing = new MemorySecretStore();
    let down = true;
    const { refresh, spent } = fakeRefresh((rt, n) => (down ? { ok: false, status: 503 } : rotating(rt, n)));
    const s = actorSecretStore(backing, { refresh });
    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });

    await assert.rejects(s.get(ACTOR, "GOOGLE_TOKEN"), /secret_refresh: GOOGLE_TOKEN .*answered 503/);
    assert.deepEqual((await s.list(ACTOR)).map((x) => x.name), ["GOOGLE_TOKEN"]);
    const cap = secretsCapability({ GOOGLE_TOKEN: "deployment" }, { actors: s });
    await assert.rejects(cap.forPrincipal!(ACTOR).get("GOOGLE_TOKEN"), /secret_refresh:/, "never the deployment's in its place");

    down = false;
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "access-3");
    assert.deepEqual(spent, ["rt", "rt", "rt"]);

    // A refresher that throws is no answer, never a refusal.
    const thrown = actorSecretStore(new MemorySecretStore(), { refresh: async () => { throw new Error("socket hang up"); } });
    await thrown.set(ACTOR, "T", "v", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });
    await assert.rejects(thrown.get(ACTOR, "T"), /secret_refresh: T .*did not answer/);
    assert.deepEqual((await thrown.list(ACTOR)).map((x) => x.name), ["T"]);
  });

  it("without a refresher, a value with an expiry is handed over as it is", async () => {
    const s = actorSecretStore(new MemorySecretStore());
    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "access-0");
  });

  it("a plain value drops the refresh kept before; delete removes both", async () => {
    const backing = new MemorySecretStore();
    const { refresh, spent } = fakeRefresh(rotating);
    const s = actorSecretStore(backing, { refresh });
    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "rt", provider: "google" });
    await s.set(ACTOR, "GOOGLE_TOKEN", "pasted");
    assert.equal(await s.get(ACTOR, "GOOGLE_TOKEN"), "pasted");
    assert.deepEqual(spent, []);
    assert.equal((await backing.list()).length, 1);

    await s.set(ACTOR, "GOOGLE_TOKEN", "access-0", { expiresIn: HOUR, refreshToken: "rt", provider: "google" });
    assert.equal((await backing.list()).length, 2);
    assert.equal(await s.delete(ACTOR, "GOOGLE_TOKEN"), true);
    assert.deepEqual(await backing.list(), []);
  });

  it("refuses a refresh it could not use", async () => {
    const s = actorSecretStore(new MemorySecretStore());
    await assert.rejects(s.set(ACTOR, "T", "v", { expiresIn: HOUR, refreshToken: "rt", provider: "../x" }), /invalid provider/);
    await assert.rejects(s.set(ACTOR, "T", "v", { expiresIn: 0, refreshToken: "rt", provider: "google" }), /positive/);
    await assert.rejects(s.set(ACTOR, "T", "v", { expiresIn: HOUR, refreshToken: "", provider: "google" }), /refresh token/);
    assert.deepEqual(await s.list(ACTOR), [], "nothing written");
  });

  it("no reader sees the refresh token: not get, list, a bound capability by any name, own or git", async () => {
    const backing = new MemorySecretStore();
    const { refresh } = fakeRefresh(rotating);
    const actors = actorSecretStore(backing, { refresh });
    await actors.set(ACTOR, "GITHUB_TOKEN", "access-0", { expiresIn: NEAR, refreshToken: "refresh-secret", provider: "google" });

    // The deployment's store is its own file, as the server keeps it.
    const bound = secretsCapability(new MemorySecretStore(), { actors }).forPrincipal!(ACTOR);
    assert.equal(await bound.git!("https://github.com/acme/app"), "access-1", "git by host reads the refreshed token");
    assert.equal(await secretScopesOf(bound)!.own!.get("GITHUB_TOKEN"), "access-1", "a package's own scope reads the same");
    assert.ok(!JSON.stringify(await actors.list(ACTOR)).includes("refresh-secret"));
    // Every name the backing store holds, read through the person's view
    // and the deployment's: none answers the refresh token.
    for (const { name } of await backing.list()) {
      for (const v of [await bound.get(name), await actors.get(ACTOR, name)]) {
        assert.ok(v === undefined || !v.includes("refresh-secret"), name);
      }
    }
  });
});

// ── the connect seam's refresh route ───────────────────────────────────────

interface Seen {
  path: string;
  auth: string | undefined;
  body: unknown;
}

/** A stand-in for stadeum's `POST /api/connect/:provider/refresh`. */
async function fakeSeam(answer: (body: { refresh_token?: string }, n: number) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const a = answer(body ?? {}, seen.length);
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(a.body === undefined ? "" : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("connectRefresher", () => {
  it("is off without CONNECT_URL and CONNECT_TOKEN", () => {
    assert.equal(connectRefresher({}), undefined);
    assert.equal(connectRefresher({ CONNECT_URL: "http://stadeum-ui:3000" }), undefined);
    assert.equal(connectRefresher({ CONNECT_TOKEN: "t" }), undefined);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(connectRefresher({ CONNECT_URL: "stadeum-ui:3000", CONNECT_TOKEN: "t" }), undefined);
    } finally {
      console.warn = warn;
    }
  });

  it("posts the refresh token with CONNECT_TOKEN and reads each answer", async () => {
    const answers: { status: number; body?: unknown }[] = [
      { status: 200, body: { access_token: "new", expires_in: 3599 } },
      { status: 200, body: { access_token: "new2", expires_in: 3599, refresh_token: "rt2" } },
      { status: 400, body: { error: "invalid_grant" } },
      { status: 401, body: { error: "unauthorized" } },
      { status: 404 },
      { status: 502 },
      { status: 200, body: { expires_in: 3599 } },
    ];
    const seam = await fakeSeam((_b, n) => answers[n - 1]!);
    try {
      const refresh = connectRefresher({ CONNECT_URL: `${seam.url}/`, CONNECT_TOKEN: "ct" })!;
      const got = [];
      for (let i = 0; i < answers.length; i++) got.push(await refresh("google", "rt"));
      assert.deepEqual(got, [
        { ok: true, accessToken: "new", expiresIn: 3599 },
        { ok: true, accessToken: "new2", expiresIn: 3599, refreshToken: "rt2" },
        { ok: false, refused: true, error: "invalid_grant" },
        { ok: false, status: 401 },
        { ok: false, status: 404 },
        { ok: false, status: 502 },
        { ok: false, status: 200 },
      ]);
      assert.deepEqual(seam.seen[0], { path: "/api/connect/google/refresh", auth: "Bearer ct", body: { refresh_token: "rt" } });
    } finally {
      await seam.close();
    }
  });

  it("no answer is not refreshed this time", async () => {
    const refresh = connectRefresher({ CONNECT_URL: "http://127.0.0.1:1", CONNECT_TOKEN: "ct" }, async () => {
      throw new TypeError("fetch failed");
    })!;
    assert.deepEqual(await refresh("google", "rt"), { ok: false });
  });
});

// ── through the server ──────────────────────────────────────────────────────

const readSecret = defineStep({
  type: "read-secret",
  input: z.object({ name: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return { value: (await ctx.services.secrets.get(cfg.name)) ?? null };
  },
});
const registry = { "read-secret": readSecret } as unknown as StepRegistry;
const readFlow = flow("read", { input: z.object({}), steps: [step("s", "read-secret", { name: "GOOGLE_TOKEN" })] });
const readTwice = flow("read-twice", {
  input: z.object({}),
  steps: [step("a", "read-secret", { name: "GOOGLE_TOKEN" }), step("b", "read-secret", { name: "GOOGLE_TOKEN" })],
});

describe("PUT /actors/:actor/secrets/:name with a refresh", () => {
  let tempDir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["STRUT_API_KEY", "CONNECT_URL", "CONNECT_TOKEN"];
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-refresh-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const put = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const makeStrut = () =>
    createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      secretStore: new MemorySecretStore(),
      serveUi: false,
      enableChat: false,
    });

  it("keeps the expiry and refresh token, and a run as the person reads the refreshed value", async () => {
    const seam = await fakeSeam((b, n) => ({ status: 200, body: { access_token: `ya29.new-${n}`, expires_in: 3599, refresh_token: `${b.refresh_token}+${n}` } }));
    process.env["CONNECT_URL"] = seam.url;
    process.env["CONNECT_TOKEN"] = "connect-token";
    try {
      const strut = await makeStrut();
      const res = await strut.app.request(
        `/actors/${ACTOR}/secrets/GOOGLE_TOKEN`,
        put({ value: "ya29.old", expires_in: NEAR, refresh_token: "1//refresh", provider: "google" }),
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, actor: ACTOR, name: "GOOGLE_TOKEN" });

      const runs = await Promise.all([1, 2].map(() => runWorkflow(readFlow, {}, registry, { services: strut.services, actor: ACTOR, principal: ACTOR })));
      assert.deepEqual(runs.map((r) => r.output), [{ value: "ya29.new-1" }, { value: "ya29.new-1" }]);
      assert.deepEqual(seam.seen, [{ path: "/api/connect/google/refresh", auth: "Bearer connect-token", body: { refresh_token: "1//refresh" } }]);

      const list = await (await strut.app.request(`/actors/${ACTOR}/secrets`)).text();
      assert.deepEqual((JSON.parse(list) as { secrets: { name: string }[] }).secrets.map((s) => s.name), ["GOOGLE_TOKEN"]);
      assert.ok(!list.includes("refresh"), list);
      // A step never reads CONNECT_TOKEN.
      const svc = strut.services as unknown as StrutCapabilities;
      assert.equal(await svc.secrets.get("CONNECT_TOKEN"), undefined);
    } finally {
      await seam.close();
    }
  });

  it("a plain value works as before; part of a refresh, or a bad one, is refused", async () => {
    const strut = await makeStrut();
    const url = `/actors/${ACTOR}/secrets/GOOGLE_TOKEN`;
    assert.equal((await strut.app.request(url, put({ value: "plain" }))).status, 200);
    const refused = [
      { value: "v", refresh_token: "rt", provider: "google" },
      { value: "v", expires_in: 3599, provider: "google" },
      { value: "v", expires_in: 3599, refresh_token: "rt" },
      { value: "v", expires_in: "3599", refresh_token: "rt", provider: "google" },
      { value: "v", expires_in: -1, refresh_token: "rt", provider: "google" },
      { value: "v", expires_in: 3599, refresh_token: "", provider: "google" },
      { value: "v", expires_in: 3599, refresh_token: "rt", provider: "../admin" },
      { value: "v", expires_in: 3599, refresh_token: "rt", provider: "Google" },
    ];
    for (const body of refused) {
      const res = await strut.app.request(url, put(body));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const missing = (await (await strut.app.request(url, put(refused[0]))).json()) as { error: string };
    assert.match(missing.error, /expires_in missing/);
    // Without CONNECT_URL and CONNECT_TOKEN, a value near its end is handed over as it is.
    assert.equal((await strut.app.request(url, put({ value: "as-is", expires_in: NEAR, refresh_token: "rt", provider: "google" }))).status, 200);
    const run = await runWorkflow(readFlow, {}, registry, { services: strut.services, actor: ACTOR, principal: ACTOR });
    assert.deepEqual(run.output, { value: "as-is" });
  });
});
