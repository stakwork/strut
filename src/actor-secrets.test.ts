import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actorSecretStore } from "./actor-secrets.js";
import { MemorySecretStore, FileSecretStore } from "./secret-store.js";
import { secretsCapability, standardServices, type StrutCapabilities } from "./capabilities.js";
import { flow, step, defineStep, type Step, type StepRegistry, type StepContext } from "./core.js";
import { runWorkflow } from "./runner.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";

/** `flow(name, { input, steps })` with the steps inline. */
const mk = (name: string, input: z.ZodTypeAny, ...steps: Step[]) => flow(name, { input, steps });

// ── the store ───────────────────────────────────────────────────────────────

describe("actorSecretStore", () => {
  it("scopes set / get / list / delete by actor; actors may carry dashes", async () => {
    const backing = new MemorySecretStore();
    const s = actorSecretStore(backing);
    await s.set("evan-123", "GITHUB_TOKEN", "tok-evan");
    await s.set("evan-123", "OTHER", "x");
    await s.set("bob-9", "GITHUB_TOKEN", "tok-bob");

    assert.equal(await s.get("evan-123", "GITHUB_TOKEN"), "tok-evan");
    assert.equal(await s.get("bob-9", "GITHUB_TOKEN"), "tok-bob");
    assert.equal(await s.get("nobody", "GITHUB_TOKEN"), undefined);

    const list = await s.list("evan-123");
    assert.deepEqual(list.map((x) => x.name), ["GITHUB_TOKEN", "OTHER"]);
    assert.ok(!JSON.stringify(list).includes("tok-evan"));
    assert.deepEqual((await s.list("bob-9")).map((x) => x.name), ["GITHUB_TOKEN"]);
    assert.deepEqual(await s.list("nobody"), []);

    // The backing store holds encoded keys, so nothing there collides with a
    // deployment secret of the same name.
    assert.ok((await backing.list()).every((x) => x.name.startsWith("A_")));
    assert.equal(await backing.get("GITHUB_TOKEN"), undefined);

    assert.equal(await s.delete("evan-123", "OTHER"), true);
    assert.equal(await s.delete("evan-123", "OTHER"), false);
    assert.deepEqual((await s.list("evan-123")).map((x) => x.name), ["GITHUB_TOKEN"]);
  });

  it("validates the secret name and requires an actor", async () => {
    const s = actorSecretStore(new MemorySecretStore());
    await assert.rejects(() => s.set("a", "bad-name", "x"), /invalid secret name/);
    await assert.rejects(() => s.set("", "GOOD", "x"), /actor is required/);
  });
});

// ── the capability ──────────────────────────────────────────────────────────

describe("secretsCapability.forPrincipal", () => {
  it("resolves the principal's secret first, then the base capability", async () => {
    const actors = actorSecretStore(new MemorySecretStore());
    await actors.set("alice", "GITHUB_TOKEN", "alice-tok");
    const cap = secretsCapability({ GITHUB_TOKEN: "deployment-tok", ONLY_DEPLOYMENT: "d" }, { actors });
    assert.equal(await cap.get("GITHUB_TOKEN"), "deployment-tok", "unbound: the deployment's");
    const alice = cap.forPrincipal!("alice");
    assert.equal(await alice.get("GITHUB_TOKEN"), "alice-tok");
    assert.equal(await alice.get("ONLY_DEPLOYMENT"), "d");
    assert.equal(await alice.get("MISSING"), undefined);
    const bob = cap.forPrincipal!("bob");
    assert.equal(await bob.get("GITHUB_TOKEN"), "deployment-tok", "no actor secret: the deployment's");
    // Re-binding replaces the principal rather than stacking.
    assert.equal(await alice.forPrincipal!("bob").get("GITHUB_TOKEN"), "deployment-tok");
  });

  it("is absent without an actor store", () => {
    assert.equal(secretsCapability({ X: "1" }).forPrincipal, undefined);
    assert.equal(secretsCapability(new MemorySecretStore()).forPrincipal, undefined);
  });
});

// ── the runner binds the run's principal ────────────────────────────────────

const readSecret = defineStep({
  type: "read-secret",
  input: z.object({ name: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return { value: (await ctx.services.secrets.get(cfg.name)) ?? null };
  },
});
const registry = { "read-secret": readSecret } as unknown as StepRegistry;
const readFlow = mk("read", z.object({}), step("s", "read-secret", { name: "GITHUB_TOKEN" }));

describe("runner: secrets bound to the run's principal", () => {
  it("a step's secrets.get sees the principal's value, else the deployment's; the bag is never mutated", async () => {
    const actors = actorSecretStore(new MemorySecretStore());
    await actors.set("alice", "GITHUB_TOKEN", "alice-tok");
    const services = standardServices({ secretsSource: { GITHUB_TOKEN: "deployment-tok" }, actorSecretStore: actors });

    const asAlice = await runWorkflow(readFlow, {}, registry, { services, actor: "alice", principal: "alice" });
    assert.deepEqual(asAlice.output, { value: "alice-tok" });
    const asBob = await runWorkflow(readFlow, {}, registry, { services, actor: "bob", principal: "bob" });
    assert.deepEqual(asBob.output, { value: "deployment-tok" });
    const nobody = await runWorkflow(readFlow, {}, registry, { services });
    assert.deepEqual(nobody.output, { value: "deployment-tok" });
    assert.equal(await services.secrets.get("GITHUB_TOKEN"), "deployment-tok", "the shared bag is unchanged");
  });

  it("a bag without forPrincipal is passed through untouched", async () => {
    const services = standardServices({ secretsSource: { GITHUB_TOKEN: "deployment-tok" } });
    const res = await runWorkflow(readFlow, {}, registry, { services, principal: "alice" });
    assert.deepEqual(res.output, { value: "deployment-tok" });
  });
});

// ── /actors/:actor/secrets ──────────────────────────────────────────────────

describe("/actors/:actor/secrets endpoints", () => {
  let tempDir: string;
  let savedKey: string | undefined;
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-actor-secrets-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    savedKey = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
  });

  const json = (body: unknown) => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  async function makeStrut(extra: Record<string, unknown> = {}) {
    return createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      secretStore: new MemorySecretStore(),
      serveUi: false,
      enableChat: false,
      ...extra,
    });
  }

  it("PUT / GET / DELETE per actor; never listed under /secrets; readable by a run as that principal", async () => {
    const strut = await makeStrut();
    const actor = "evan-123";
    const put = await strut.app.request(`/actors/${actor}/secrets/GITHUB_TOKEN`, json({ value: "ghp_evan" }));
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, actor, name: "GITHUB_TOKEN" });

    const get = await strut.app.request(`/actors/${actor}/secrets`);
    assert.equal(get.status, 200);
    const body = (await get.json()) as { actor: string; secrets: { name: string }[] };
    assert.equal(body.actor, actor);
    assert.deepEqual(body.secrets.map((s) => s.name), ["GITHUB_TOKEN"]);
    assert.ok(!JSON.stringify(body).includes("ghp_evan"));

    // Not the deployment's secrets: absent from /secrets, and from the
    // unbound capability.
    const dep = (await (await strut.app.request("/secrets")).json()) as { secrets: unknown[] };
    assert.deepEqual(dep.secrets, []);
    const svc = strut.services as unknown as StrutCapabilities;
    assert.equal(await svc.secrets.get("GITHUB_TOKEN"), undefined);

    // A run launched as that principal reads it through the ordinary boundary.
    const asEvan = await runWorkflow(readFlow, {}, registry, { services: strut.services, actor, principal: actor });
    assert.deepEqual(asEvan.output, { value: "ghp_evan" });
    const asOther = await runWorkflow(readFlow, {}, registry, { services: strut.services, actor: "x", principal: "x" });
    assert.deepEqual(asOther.output, { value: null });

    const del = await strut.app.request(`/actors/${actor}/secrets/GITHUB_TOKEN`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const again = await strut.app.request(`/actors/${actor}/secrets/GITHUB_TOKEN`, { method: "DELETE" });
    assert.equal(again.status, 404);
  });

  it("rejects an invalid name and a missing value", async () => {
    const strut = await makeStrut();
    assert.equal((await strut.app.request("/actors/a/secrets/bad-name", json({ value: "x" }))).status, 400);
    assert.equal((await strut.app.request("/actors/a/secrets/GOOD", json({}))).status, 400);
  });

  it("is gated by STRUT_API_KEY like /secrets", async () => {
    process.env["STRUT_API_KEY"] = "k";
    const strut = await makeStrut();
    assert.equal((await strut.app.request("/actors/a/secrets/T", json({ value: "x" }))).status, 401);
    assert.equal((await strut.app.request("/actors/a/secrets")).status, 401);
    const ok = await strut.app.request("/actors/a/secrets/T", {
      ...json({ value: "x" }),
      headers: { "content-type": "application/json", authorization: "Bearer k" },
    });
    assert.equal(ok.status, 200);
  });

  it("returns 501 when the consumer injected its own secrets capability", async () => {
    const strut = await makeStrut({ services: { secrets: secretsCapability({}) } });
    assert.equal((await strut.app.request("/actors/a/secrets")).status, 501);
    assert.equal((await strut.app.request("/actors/a/secrets/T", json({ value: "x" }))).status, 501);
  });

  it("file-backed: persists to actor-secrets.json, encrypted, beside secrets.json", async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      serveUi: false,
      enableChat: false,
    });
    await strut.app.request("/actors/evan-1/secrets/GITHUB_TOKEN", json({ value: "ghp_persisted" }));
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(tempDir, "actor-secrets.json"), "utf8");
    assert.ok(!raw.includes("ghp_persisted"), "encrypted at rest");
    // Readable through a fresh store over the same file.
    const again = actorSecretStore(new FileSecretStore(tempDir, "actor-secrets.json"));
    assert.equal(await again.get("evan-1", "GITHUB_TOKEN"), "ghp_persisted");
  });
});
