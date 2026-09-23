/**
 * Mothership cost control (plans/mothership-cost-control.md, "Validation"):
 * the macaroon strut builds passes gatekey's verifier with the step as the
 * billed agent; widening fails; caps resolve and refuse to exceed the
 * ceiling; the delegation file is invisible to the secrets boundary; the
 * routes check a delegation's shape. OFFLINE — no gateway, no provider.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  attenuate,
  attenuationSigBytes,
  bytesToHex,
  decodeMacaroon,
  ecdsaPublicKey,
  encodeMacaroon,
  invocationSigBytes,
  verify,
  type Attenuation,
  type Policy,
} from "gatekey";

import {
  createMothership,
  checkDelegationMacaroon,
  explainExhausted,
  resolveRunCap,
  stepAgentName,
  STRUT_AGENT,
  STRUT_ASSISTANT,
} from "./mothership.js";
import { MemorySecretStore } from "./secret-store.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager, type WorkspaceStore } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import type { LlmAuthContext } from "./llm.js";
import { mintDelegation, type MintOptions } from "./test-util/mint-delegation.js";

// ── Fixture: what hive mints — an org-signed UA + a user-signed standing invocation ──

const ACTOR = "evan-cmx123";
const orgPriv = randomBytes(32);
orgPriv[0] = 1; // keep the scalar well inside the secp256k1 order
const userPriv = randomBytes(32);
const policy: Policy = { type: "single", key: { alg: "ecdsa-secp256k1-sha256", key: bytesToHex(ecdsaPublicKey(orgPriv)) } };
const hex16 = () => randomBytes(16).toString("hex");
const mint = (o: Omit<MintOptions, "actor" | "orgPriv" | "userPriv"> = {}) =>
  mintDelegation({ actor: ACTOR, orgPriv, userPriv, ...o });

/** A workspace stub: only what the hook reads (a workflow's run cap). */
const workspaceWith = (caps: Record<string, number | undefined>): WorkspaceStore =>
  ({
    getWorkflowMetadata: async (name: string) =>
      name in caps ? { active: "v1", versions: {}, ...(caps[name] != null ? { maxRunCostUsd: caps[name] } : {}) } : null,
  }) as unknown as WorkspaceStore;

const stepCtx = (over: Partial<LlmAuthContext> = {}): LlmAuthContext => ({
  kind: "step",
  provider: "anthropic",
  runId: "1700000000000",
  workflow: "digest",
  stepPath: "digest/loop#3/summarize",
  actor: ACTOR,
  principal: ACTOR,
  ...over,
});

const ENV = ["STRUT_RUN_MAX_COST_USD", "STRUT_MOTHERSHIP_REQUIRED", "STRUT_API_KEY"];

describe("mothership: names and caps", () => {
  it("stepAgentName: strips iteration suffixes and tool-call prefixes, never emits a slash", () => {
    assert.equal(stepAgentName("digest/loop#3/summarize"), "digest.loop.summarize");
    assert.equal(stepAgentName("wf/agent/003-llm"), "wf.agent.llm");
    assert.equal(stepAgentName("wf/agent/003-llm/foreach#12/inner"), "wf.agent.llm.foreach.inner");
    assert.equal(stepAgentName("my wf/st ep"), "my_wf.st_ep");
    assert.equal(stepAgentName("__run_step__/step"), "__run_step__.step");
    for (const p of ["a/b/c", "a//b", "/a/", "weird name/x#1"]) assert.ok(!stepAgentName(p).includes("/"), p);
  });

  it("resolveRunCap: workflow override → env → default; anything non-positive is an error", () => {
    assert.equal(resolveRunCap(undefined, {}), 100);
    assert.equal(resolveRunCap(undefined, {}, 42), 42);
    assert.equal(resolveRunCap(undefined, { STRUT_RUN_MAX_COST_USD: "7.5" }), 7.5);
    assert.equal(resolveRunCap(3, { STRUT_RUN_MAX_COST_USD: "7.5" }), 3);
    assert.equal(resolveRunCap(undefined, { STRUT_RUN_MAX_COST_USD: "" }), 100, "an empty env var is absent, never zero");
    assert.throws(() => resolveRunCap(undefined, { STRUT_RUN_MAX_COST_USD: "0" }), /positive number/);
    assert.throws(() => resolveRunCap(undefined, { STRUT_RUN_MAX_COST_USD: "lots" }), /positive number/);
    assert.throws(() => resolveRunCap(0, {}), /positive number/);
    assert.throws(() => resolveRunCap(-1, {}), /positive number/);
  });

  it("checkDelegationMacaroon: accepts hive's shape and copies out the id and the earlier exp", async () => {
    const d = mint();
    const checked = await checkDelegationMacaroon(d.macaroon);
    assert.equal(checked.delegationId, d.delegationId);
    assert.equal(checked.exp, d.exp);
    assert.equal(checked.ceilingUsd, 10_000);
  });

  it("checkDelegationMacaroon: rejects attenuated, wrong-agent, call-capped, ceiling-less and garbage macaroons", async () => {
    const base = mint();
    const link = attenuate(invocationSigBytes(base.m.invocation), { agents: [STRUT_AGENT], run_id: "r", max_cost_usd: 1, max_steps: 0, exp: base.exp, nonce: hex16() });
    await assert.rejects(() => checkDelegationMacaroon(encodeMacaroon({ ...base.m, attenuations: [link] })), /no attenuations/);
    await assert.rejects(() => checkDelegationMacaroon(mint({ agents: ["browser-agent"] }).macaroon), /strut-agent/);
    await assert.rejects(() => checkDelegationMacaroon(mint({ maxSteps: 200 }).macaroon), /max_steps must be 0/);
    await assert.rejects(() => checkDelegationMacaroon(mint({ ceiling: 0 }).macaroon), /max_cost_usd/);
    await assert.rejects(() => checkDelegationMacaroon("not-a-macaroon"), /does not decode/);
    await assert.rejects(() => checkDelegationMacaroon(Buffer.from('{"v":2}').toString("base64url")), /v=2/);
  });

  it("explainExhausted: a 402 naming the delegation is 'exhausted'; one naming the run is left alone", () => {
    const d = { delegationId: "dele-1" };
    const hit = explainExhausted({ message: "run dele-1 spent $10000.0100 of its $10000.00 cap", responseBody: '{"code":"run_cost_exceeded"}' }, d, ACTOR, 10_000);
    assert.match(hit!, /exhausted/);
    assert.match(hit!, new RegExp(ACTOR));
    assert.match(hit!, /re-authorize/);
    assert.equal(explainExhausted({ message: "run 1700000000000 spent $100.0000 of its $100.00 cap" }, d, ACTOR), undefined);
    assert.equal(explainExhausted(new Error("ECONNRESET"), d, ACTOR), undefined);
    assert.equal(explainExhausted(null, d, ACTOR), undefined);
  });
});

describe("mothership: the llmAuth hook", () => {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const build = async (o: { caps?: Record<string, number | undefined>; delegation?: ReturnType<typeof mint>; runCapDefault?: number; now?: () => Date } = {}) => {
    const store = new MemorySecretStore();
    const ms = createMothership({ dataDir: "/nonexistent", store, runCapDefault: o.runCapDefault, now: o.now });
    ms.mount({ app: new Hono(), workspace: workspaceWith(o.caps ?? {}) });
    const d = o.delegation ?? mint();
    await ms.delegations.put(ACTOR, { macaroon: d.macaroon, delegationId: d.delegationId, apiKey: "vk-evan", baseUrl: "https://swarm.example:8181", exp: d.exp });
    return { ms, d };
  };

  it("a step call: the gateway URL, the virtual key, and a macaroon that verifies with the STEP as the billed agent", async () => {
    const { ms, d } = await build({ caps: { digest: 5 } });
    const grant = (await ms.llmAuth(stepCtx()))!;
    assert.equal(grant.apiKey, "vk-evan");
    assert.equal(grant.baseUrl, "https://swarm.example:8181");
    assert.equal(grant.headers!["x-bf-dim-session-id"], "digest");
    assert.equal(grant.headers!["x-bf-dim-root-agent"], STRUT_AGENT);

    const claims = verify(grant.headers!["x-macaroon"]!, policy, new Date());
    assert.equal(claims.agent_name, "digest.loop.summarize");
    assert.equal(claims.run_id, "1700000000000");
    assert.equal(claims.user_id, ACTOR);
    assert.equal(claims.effective_caveats.max_cost_usd, 5, "the workflow's maxRunCostUsd is the run cap");
    assert.equal(claims.effective_caveats.max_steps, 0);
    assert.deepEqual(claims.effective_caveats.agents, [STRUT_AGENT, "digest.loop.summarize"]);

    // Three layers, two run ids: [run, delegation] is what the gateway enforces.
    const m = decodeMacaroon(grant.headers!["x-macaroon"]!);
    assert.equal(m.attenuations.length, 2);
    const runIds = new Set([m.invocation.run_id, ...m.attenuations.map((a) => a.caveats.run_id)]);
    assert.deepEqual([...runIds].sort(), [d.delegationId, "1700000000000"].sort());
    assert.deepEqual(m.attenuations[0]!.caveats.agents, [STRUT_AGENT]);
    assert.equal(m.attenuations[0]!.caveats.max_cost_usd, 5);
    assert.equal(m.attenuations[1]!.caveats.max_cost_usd, 5, "the step link restates the run cap");
    assert.equal(m.attenuations[1]!.caveats.exp, m.attenuations[0]!.caveats.exp);
  });

  it("the run link is shared by every step of a run and differs between runs", async () => {
    const { ms } = await build();
    const a = decodeMacaroon((await ms.llmAuth(stepCtx({ stepPath: "digest/fetch" })))!.headers!["x-macaroon"]!);
    const b = decodeMacaroon((await ms.llmAuth(stepCtx({ stepPath: "digest/summarize" })))!.headers!["x-macaroon"]!);
    const c = decodeMacaroon((await ms.llmAuth(stepCtx({ runId: "1700000000001" })))!.headers!["x-macaroon"]!);
    assert.equal(a.attenuations[0]!.hmac, b.attenuations[0]!.hmac, "same run → same run link");
    assert.notEqual(a.attenuations[1]!.hmac, b.attenuations[1]!.hmac, "different step → different step link");
    assert.notEqual(a.attenuations[0]!.hmac, c.attenuations[0]!.hmac, "different run → different run link");
    assert.equal(verify(encodeMacaroon(b), policy, new Date()).agent_name, "digest.summarize");
  });

  it("the cap resolves workflow → env → default, and a cap above the ceiling fails before any call, naming both", async () => {
    const { ms } = await build({ caps: { capped: 2, uncapped: undefined }, runCapDefault: 25, delegation: mint({ ceiling: 50 }) });
    const cap = async (workflow: string, runId: string) =>
      verify((await ms.llmAuth(stepCtx({ workflow, runId, stepPath: `${workflow}/s` })))!.headers!["x-macaroon"]!, policy, new Date()).effective_caveats.max_cost_usd;
    assert.equal(await cap("capped", "1"), 2);
    assert.equal(await cap("uncapped", "2"), 25);
    process.env["STRUT_RUN_MAX_COST_USD"] = "9";
    assert.equal(await cap("uncapped", "3"), 9);
    assert.equal(await cap("capped", "4"), 2, "the workflow's own cap wins over env");
    process.env["STRUT_RUN_MAX_COST_USD"] = "500";
    await assert.rejects(() => ms.llmAuth(stepCtx({ workflow: "uncapped", runId: "5", stepPath: "uncapped/s" })), /cap \$500 exceeds the delegation ceiling \$50/);
    process.env["STRUT_RUN_MAX_COST_USD"] = "0";
    await assert.rejects(() => ms.llmAuth(stepCtx({ workflow: "uncapped", runId: "6", stepPath: "uncapped/s" })), /positive number/);
  });

  it("a widened link is what the gateway rejects: more money, a dropped ancestor, a call cap, a longer life", async () => {
    const { ms, d } = await build({ caps: { digest: 5 } });
    const good = decodeMacaroon((await ms.llmAuth(stepCtx()))!.headers!["x-macaroon"]!);
    const run = good.attenuations[0]!;
    const widen = (caveats: Partial<Attenuation["caveats"]>) => {
      const link = attenuate(attenuationSigBytes(run), { ...good.attenuations[1]!.caveats, nonce: hex16(), ...caveats });
      return () => verify({ ...good, attenuations: [run, link] }, policy, new Date());
    };
    assert.throws(widen({ max_cost_usd: 6 }), /attenuation_widened|max_cost_usd/);
    assert.throws(widen({ agents: ["digest.loop.summarize"] }), /dropped parent entry/);
    assert.throws(widen({ max_steps: 1 }), /max_steps/);
    assert.throws(widen({ exp: new Date(Date.now() + 61 * 86_400_000).toISOString() }), /exp/);
    assert.throws(widen({ run_id: "other", max_cost_usd: 10_001 }), /max_cost_usd/);
    // And the real thing, untouched, is fine — the delegation's own exp bounds it.
    assert.equal(verify(good, policy, new Date()).effective_caveats.max_cost_usd, 5);
    assert.ok(run.caveats.exp <= d.exp);
  });

  it("links get shorter in the delegation's last hours (never outlive the invocation)", async () => {
    const soon = mint({ ttlMs: 2 * 3600_000 });
    const { ms } = await build({ delegation: soon });
    const m = decodeMacaroon((await ms.llmAuth(stepCtx()))!.headers!["x-macaroon"]!);
    assert.equal(m.attenuations[0]!.caveats.exp, soon.exp, "the parent's own exp string, verbatim");
    assert.doesNotThrow(() => verify(m, policy, new Date()));
  });

  it("a chat turn: billed as the assistant, one gateway run per turn, the chat as the session", async () => {
    const { ms } = await build({ runCapDefault: 12 });
    const grant = (await ms.llmAuth({ kind: "chat", provider: "openai", chatId: "chat-7", turn: 3, actor: ACTOR, principal: ACTOR }))!;
    const claims = verify(grant.headers!["x-macaroon"]!, policy, new Date());
    assert.equal(claims.agent_name, STRUT_ASSISTANT);
    assert.equal(claims.run_id, "chat-7.3");
    assert.deepEqual(claims.effective_caveats.agents, [STRUT_AGENT, STRUT_ASSISTANT]);
    assert.equal(claims.effective_caveats.max_cost_usd, 12);
    assert.equal(grant.headers!["x-bf-dim-session-id"], "chat-7");
  });

  it("no principal, or no delegation for it → undefined (direct provider keys); required mode makes both an error", async () => {
    const { ms } = await build();
    assert.equal(await ms.llmAuth(stepCtx({ principal: undefined, actor: undefined })), undefined);
    assert.equal(await ms.llmAuth(stepCtx({ principal: "stranger-1" })), undefined);
    process.env["STRUT_MOTHERSHIP_REQUIRED"] = "1";
    await assert.rejects(() => ms.llmAuth(stepCtx({ principal: undefined })), /nobody to bill/);
    await assert.rejects(() => ms.llmAuth(stepCtx({ principal: "stranger-1" })), /no Mothership authorization on file for stranger-1/);
  });

  it("an expired delegation is an error that says to re-authorize, not a silent fallback", async () => {
    const { ms } = await build({ now: () => new Date(Date.now() + 61 * 86_400_000) });
    await assert.rejects(() => ms.llmAuth(stepCtx()), /expired .* re-authorize from hive/);
  });

  it("a re-pushed delegation replaces a cached run link (the old chain would no longer verify)", async () => {
    const { ms } = await build();
    const before = decodeMacaroon((await ms.llmAuth(stepCtx()))!.headers!["x-macaroon"]!);
    const fresh = mint();
    await ms.delegations.put(ACTOR, { macaroon: fresh.macaroon, delegationId: fresh.delegationId, apiKey: "vk-2", baseUrl: "https://g", exp: fresh.exp });
    const after = decodeMacaroon((await ms.llmAuth(stepCtx()))!.headers!["x-macaroon"]!);
    assert.equal(after.invocation.run_id, fresh.delegationId);
    assert.notEqual(after.attenuations[0]!.hmac, before.attenuations[0]!.hmac);
    assert.doesNotThrow(() => verify(after, policy, new Date()));
  });

  it("the grant's explainError maps only the delegation's own 402", async () => {
    const { ms, d } = await build();
    const grant = (await ms.llmAuth(stepCtx()))!;
    assert.match(grant.explainError!({ message: `run ${d.delegationId} spent $10000.0000 of its $10000.00 cap` })!, /exhausted/);
    assert.equal(grant.explainError!({ message: "run 1700000000000 spent $5.0000 of its $5.00 cap" }), undefined);
  });
});

describe("mothership: routes and the delegation file", () => {
  let dir: string;
  let saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    dir = join(tmpdir(), `strut-mothership-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const boot = async (o: { serveUi?: boolean } = {}) => {
    const ms = createMothership({ dataDir: dir });
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      store: new MemoryRunStore(),
      serveUi: o.serveUi ?? false,
      enableChat: false,
      scheduler: false,
      llmAuth: ms.llmAuth,
    });
    ms.mount(strut);
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await strut.app.request(path, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    return { ms, strut, call };
  };

  it("PUT / GET / DELETE a delegation; the file is invisible to the secrets boundary and the Secrets list", async () => {
    const { strut, call } = await boot();
    const d = mint();
    assert.equal((await call("GET", "/llm/mothership")).json.enabled, true);
    assert.deepEqual((await call("GET", "/llm/delegations")).json, []);

    const put = await call("PUT", `/llm/delegations/${encodeURIComponent(ACTOR)}`, { macaroon: d.macaroon, apiKey: "vk-evan", baseUrl: "https://swarm.example:8181/" });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.deepEqual(put.json, { actor: ACTOR, exp: d.exp, delegationId: d.delegationId });
    assert.deepEqual((await call("GET", "/llm/delegations")).json, [{ actor: ACTOR, exp: d.exp, delegationId: d.delegationId }]);

    // Never on the services bag, never in the Secrets list, and its own file.
    const secrets = (strut.services as { secrets: { get(n: string): Promise<string | undefined> } }).secrets;
    assert.equal(await secrets.get(`D_${Buffer.from(ACTOR).toString("hex")}`), undefined);
    assert.deepEqual((await call("GET", "/secrets")).json, { secrets: [] });
    assert.deepEqual(await strut.secretStore.list(), []);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, "mothership.json"), "utf-8");
    assert.ok(!raw.includes("vk-evan") && !raw.includes(d.macaroon), "encrypted at rest");

    const gone = await call("DELETE", `/llm/delegations/${encodeURIComponent(ACTOR)}`);
    assert.equal(gone.status, 200);
    assert.equal((await call("DELETE", `/llm/delegations/${encodeURIComponent(ACTOR)}`)).status, 404);
    assert.deepEqual((await call("GET", "/llm/delegations")).json, []);
  });

  it("PUT rejects the wrong kind of macaroon, a missing key, a bad URL — and needs the deployment key when one is set", async () => {
    const { call } = await boot();
    const d = mint();
    const put = (body: unknown, headers?: Record<string, string>) => call("PUT", `/llm/delegations/${ACTOR}`, body, headers);
    assert.equal((await put({ macaroon: mint({ maxSteps: 40 }).macaroon, apiKey: "k", baseUrl: "https://g" })).status, 400);
    assert.equal((await put({ macaroon: mint({ agents: ["other"] }).macaroon, apiKey: "k", baseUrl: "https://g" })).status, 400);
    assert.equal((await put({ macaroon: d.macaroon, baseUrl: "https://g" })).status, 400);
    assert.equal((await put({ macaroon: d.macaroon, apiKey: "k", baseUrl: "swarm:8181" })).status, 400);
    assert.equal((await put({ macaroon: "zzz", apiKey: "k", baseUrl: "https://g" })).status, 400);
    assert.equal((await put({ macaroon: d.macaroon, apiKey: "k", baseUrl: "https://g" })).status, 200);

    process.env["STRUT_API_KEY"] = "deploy-key";
    assert.equal((await put({ macaroon: d.macaroon, apiKey: "k", baseUrl: "https://g" })).status, 401);
    assert.equal((await call("GET", "/llm/delegations")).status, 401);
    assert.equal((await put({ macaroon: d.macaroon, apiKey: "k", baseUrl: "https://g" }, { authorization: "Bearer deploy-key" })).status, 200);
  });

  it("the routes stay reachable behind the UI's catch-all (mounted after construction)", async () => {
    const { call } = await boot({ serveUi: true });
    assert.equal((await call("GET", "/llm/mothership")).json.enabled, true);
    assert.equal((await call("GET", "/llm/delegations")).status, 200);
    assert.equal((await call("GET", "/llm/nope")).status, 404);
  });
});
