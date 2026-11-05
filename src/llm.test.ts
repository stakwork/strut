import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { MAPLE_MODELS, NUMES_MODELS } from "aieo";
import { resolveModel, listModelOptions, canonicalModelName, createWebTools, defaultModel } from "./llm.js";
import { secretsCapability } from "./capabilities.js";
import { MemorySecretStore } from "./secret-store.js";
import { zodToFields } from "./ai/schemaHelpers.js";
import agent from "./steps/core/agent.js";
import llm from "./steps/core/llm.js";

/**
 * The strut glue over aieo's resolver. OFFLINE: aieo's getModel only
 * constructs SDK clients. What's strut's here — and tested here — is the
 * secrets boundary (store → env) as the key source, the output cap's
 * STRUT_MAX_OUTPUT_TOKENS override, and the catalog's availability flags.
 */

const ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_WORKSPACE_ID",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "MAPLE_API_KEY",
  "MAPLE_BASE_URL",
  "NUMES_API_KEY",
  "NUMES_BASE_URL",
  "EXA_API_KEY",
  "STRUT_MAX_OUTPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "LLM_PROVIDER",
  "STRUT_MODELS",
  "STRUT_DEFAULT_MODEL",
];

describe("llm: model resolution through the secrets boundary", () => {
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

  const withStore = async (entries: Record<string, string>) => {
    const store = new MemorySecretStore();
    for (const [k, v] of Object.entries(entries)) await store.set(k, v);
    return secretsCapability(store, { envFallback: process.env });
  };

  it("reads the provider key from the secret store by env-var name", async () => {
    const secrets = await withStore({ OPENAI_API_KEY: "from-store" });
    const r = await resolveModel({ model: "gpt", secrets });
    assert.equal(r.provider, "openai");
    assert.equal(r.modelId, "gpt-5.6-luna");
    assert.equal(r.name, "openai/gpt-5.6-luna");
    assert.equal(r.model.modelId, "gpt-5.6-luna");
    assert.equal(r.maxOutputTokens, 64_000);
    assert.equal(r.contextLimit, 1_050_000);
  });

  it("falls back to env through the same boundary", async () => {
    process.env["XAI_API_KEY"] = "from-env";
    const secrets = await withStore({});
    const r = await resolveModel({ model: "grok-4-fast", secrets });
    assert.equal(r.provider, "xai");
    assert.equal(r.name, "xai/grok-4-fast");
  });

  it("works with no secrets capability at all (bare env, as in runWorkflow without services)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    const r = await resolveModel({ model: "sonnet" });
    assert.equal(r.name, "anthropic/claude-sonnet-5-5");
    assert.equal(r.maxOutputTokens, 128_000);
  });

  it("no key anywhere → the error names the secret to set", async () => {
    const secrets = await withStore({});
    await assert.rejects(() => resolveModel({ model: "gemini", secrets }), /GOOGLE_API_KEY/);
  });

  it("an explicit provider wins, and an unknown one is the agent-step error", async () => {
    process.env["OPENROUTER_API_KEY"] = "k";
    const r = await resolveModel({ model: "moonshotai/kimi-k2.6", provider: "openrouter" });
    assert.equal(r.name, "openrouter/moonshotai/kimi-k2.6");
    assert.equal(r.model.modelId, "moonshotai/kimi-k2.6");
    await assert.rejects(() => resolveModel({ model: "gpt-5", provider: "nope" }), /Unknown LLM provider: "nope"/);
  });

  it("the no-prefix OpenRouter name is rejected with the fix, before any key lookup", async () => {
    let asked = 0;
    const secrets = { get: async () => (asked++, "k") };
    await assert.rejects(
      () => resolveModel({ model: "moonshotai/kimi-k2.6", secrets }),
      /openrouter\/moonshotai\/kimi-k2\.6/,
    );
    assert.equal(asked, 0);
    await assert.rejects(() => canonicalModelName("x-ai/grok-4"), /"x-ai" is not a provider/);
    assert.equal(await canonicalModelName("kimi"), "openrouter/moonshotai/kimi-k3");
  });

  it("STRUT_MAX_OUTPUT_TOKENS overrides the per-provider output cap", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k";
    process.env["STRUT_MAX_OUTPUT_TOKENS"] = "4321";
    const r = await resolveModel({ model: "haiku" });
    assert.equal(r.maxOutputTokens, 4321);
  });

  it("listModelOptions: availability from store OR env, canonical default, never values", async () => {
    process.env["XAI_API_KEY"] = "env-xai-secret";
    const secrets = await withStore({ OPENAI_API_KEY: "store-openai-secret" });
    const cat = await listModelOptions({ default: "sonnet", secrets });
    assert.equal(cat.default, "anthropic/claude-sonnet-5-5");
    const by = (alias: string) => cat.models.find((m) => m.alias === alias)!;
    assert.equal(by("gpt").available, true, "store key");
    assert.equal(by("grok").available, true, "env key");
    assert.equal(by("sonnet").available, false);
    assert.equal(by("kimi").name, "openrouter/moonshotai/kimi-k3");
    assert.equal(by("sonnet").default, true);
    assert.equal(by("opus").default, false);
    assert.equal(cat.keyNames["openrouter"], "OPENROUTER_API_KEY");
    const json = JSON.stringify(cat);
    assert.ok(!json.includes("secret"), "key values must never leave the catalog");
  });

  it("listModelOptions: a misconfigured default still lists the catalog", async () => {
    const cat = await listModelOptions({ default: "moonshotai/kimi-k2.6" });
    assert.equal(cat.default, "moonshotai/kimi-k2.6");
    assert.ok(cat.models.length >= 7);
  });

  it("listModelOptions: every model aieo knows, once each, with its window; a price only where it is the model's own", async () => {
    const cat = await listModelOptions();
    const names = cat.models.map((m) => m.name);
    assert.equal(new Set(names).size, names.length, "no model twice");
    for (const id of Object.keys(MAPLE_MODELS)) assert.ok(names.includes(`maple/${id}`), `maple/${id}`);
    for (const id of Object.keys(NUMES_MODELS)) assert.ok(names.includes(`numes/${id}`), `numes/${id}`);
    const at = (name: string) => cat.models.find((m) => m.name === name)!;
    // An aliased model keeps its alias; one without has none.
    assert.equal(at("numes/z-ai/glm-5.3").alias, "numes");
    assert.equal(at("numes/z-ai/glm-5.3").default, true);
    assert.equal(at("maple/glm-5-3").alias, undefined);
    assert.equal(at("maple/glm-5-3").default, false);
    // Maple and Numes have their own rate per model. Every other model has
    // none: aieo's flat per-provider rate is not the model's price.
    assert.equal(at("maple/glm-5-3").contextLimit, 262_144);
    assert.deepEqual(at("maple/glm-5-3").pricing, { inputTokenPrice: 3.6, outputTokenPrice: 11.5 });
    assert.deepEqual(at("numes/z-ai/glm-5.3-flash").pricing, { inputTokenPrice: 0, outputTokenPrice: 0 });
    assert.equal(at("numes/z-ai/glm-5.3-flash").contextLimit, 1_048_576);
    assert.equal(at("anthropic/claude-sonnet-5-5").pricing, undefined);
    for (const m of cat.models) {
      assert.ok((m.contextLimit ?? 0) > 0, `${m.name} has a window`);
      assert.equal(!!m.pricing, m.provider === "maple" || m.provider === "numes", `${m.name}: a price only from a per-model table`);
    }
    assert.equal(cat.listed, false);
  });

  it("STRUT_MODELS: exactly the host's list is available, whatever keys strut holds; the default is STRUT_DEFAULT_MODEL", async () => {
    process.env["ANTHROPIC_API_KEY"] = "k"; // a key the list overrides
    const secrets = await withStore({
      STRUT_MODELS: JSON.stringify([
        "anthropic/claude-opus-5-5",
        "numes/z-ai/glm-5.3-flash",
        "sonnet", // any name aieo takes, read canonically
        "openrouter/meta-llama/llama-4-scout", // an OpenRouter id aieo has no row for
        "acme/llama-4", // a provider aieo does not know
      ]),
      STRUT_DEFAULT_MODEL: "anthropic/claude-opus-5-5",
    });
    const cat = await listModelOptions({ default: "haiku", secrets });
    assert.equal(cat.listed, true);
    assert.equal(cat.default, "anthropic/claude-opus-5-5");
    assert.deepEqual(
      cat.models.filter((m) => m.available).map((m) => m.name).sort(),
      ["acme/llama-4", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "numes/z-ai/glm-5.3-flash", "openrouter/meta-llama/llama-4-scout"],
    );
    assert.equal(cat.models.find((m) => m.name === "anthropic/claude-haiku-4-5")!.available, false, "keyed, but not on the list");
    const llama = cat.models.find((m) => m.name === "openrouter/meta-llama/llama-4-scout")!;
    assert.deepEqual([llama.provider, llama.modelId, llama.alias, llama.default], ["openrouter", "meta-llama/llama-4-scout", undefined, false]);
    assert.ok(llama.contextLimit, "a provider aieo knows has its window");
    assert.equal(llama.pricing, undefined, "and no price of its own");
    const acme = cat.models.find((m) => m.name === "acme/llama-4")!;
    assert.deepEqual(acme, { provider: "acme", modelId: "llama-4", name: "acme/llama-4", default: false, available: true });
  });

  it("STRUT_MODELS from env when the store has none; with none, or one that is not a list, the keys decide", async () => {
    process.env["XAI_API_KEY"] = "k";
    process.env["STRUT_MODELS"] = JSON.stringify(["openai/gpt-5.6-luna"]);
    const fromEnv = await listModelOptions({ secrets: await withStore({}) });
    assert.deepEqual(fromEnv.models.filter((m) => m.available).map((m) => m.name), ["openai/gpt-5.6-luna"]);
    // No secrets boundary at all: the boot env.
    assert.deepEqual((await listModelOptions()).models.filter((m) => m.available).map((m) => m.name), ["openai/gpt-5.6-luna"]);

    for (const bad of ["openai/gpt-5.6-luna", '{"models":[]}', "[1]"]) {
      process.env["STRUT_MODELS"] = bad;
      const cat = await listModelOptions();
      assert.equal(cat.listed, false, bad);
      assert.deepEqual([...new Set(cat.models.filter((m) => m.available).map((m) => m.provider))], ["xai"], bad);
    }
    delete process.env["STRUT_MODELS"];
    assert.equal((await listModelOptions()).listed, false);
    // An empty list is a list: nothing may be picked.
    process.env["STRUT_MODELS"] = "[]";
    const none = await listModelOptions();
    assert.equal(none.listed, true);
    assert.equal(none.models.some((m) => m.available), false);
  });

  it("defaultModel: STRUT_DEFAULT_MODEL from the store, then env, else the boot default; blank is unset", async () => {
    assert.equal(await defaultModel("sonnet"), "sonnet");
    process.env["STRUT_DEFAULT_MODEL"] = "openai/gpt-5";
    assert.equal(await defaultModel("sonnet"), "openai/gpt-5");
    assert.equal(await defaultModel("sonnet", await withStore({})), "openai/gpt-5");
    assert.equal(await defaultModel("sonnet", await withStore({ STRUT_DEFAULT_MODEL: "xai/grok-4.7" })), "xai/grok-4.7");
    process.env["STRUT_DEFAULT_MODEL"] = "  ";
    assert.equal(await defaultModel("sonnet"), "sonnet");
  });

  it("createWebTools: native pair on anthropic; fetch shim everywhere; search shim only with an Exa key", async () => {
    const a = await createWebTools({ provider: "anthropic", apiKey: "k" });
    assert.deepEqual(Object.keys(a.tools).sort(), ["web_fetch", "web_search"]);
    // Provider-executed: no client-side execute (the emit/mask wrappers skip them).
    assert.equal(a.tools["web_search"].execute, undefined);
    assert.equal(a.tools["web_fetch"].execute, undefined);

    const o = await createWebTools({ provider: "openai", apiKey: "k" });
    assert.deepEqual(Object.keys(o.tools), ["web_fetch"], "no Exa key → no search shim");
    assert.equal(typeof o.tools["web_fetch"].execute, "function");

    const secrets = await withStore({ EXA_API_KEY: "exa-secret" });
    const oe = await createWebTools({ provider: "openai", apiKey: "k", secrets });
    assert.deepEqual(Object.keys(oe.tools).sort(), ["web_fetch", "web_search"]);
    assert.equal(typeof oe.tools["web_search"].execute, "function");

    process.env["EXA_API_KEY"] = "exa-env";
    const oenv = await createWebTools({ provider: "xai", apiKey: "k", secrets: await withStore({}) });
    assert.ok("web_search" in oenv.tools, "env Exa key through the same boundary");
  });

  it("createWebTools: routed through a gateway → the shims on anthropic too, never the server-executed pair", async () => {
    // Bifrost cannot round-trip a `server_tool_use` block (the next request
    // is a 400 `server_tool_use.input: Field required`), so a routed call
    // gets ordinary client tools: the HTTP fetch, and Exa search iff keyed.
    const r = await createWebTools({ provider: "anthropic", apiKey: "k", routed: true });
    assert.deepEqual(Object.keys(r.tools), ["web_fetch"], "no Exa key → no web_search; the native one is not a fallback");
    assert.equal(typeof r.tools["web_fetch"].execute, "function", "the HTTP shim, not Anthropic's web_fetch");

    const re = await createWebTools({ provider: "anthropic", apiKey: "k", routed: true, secrets: await withStore({ EXA_API_KEY: "exa-secret" }) });
    assert.deepEqual(Object.keys(re.tools).sort(), ["web_fetch", "web_search"]);
    assert.equal(typeof re.tools["web_search"].execute, "function", "the Exa shim");

    const direct = await createWebTools({ provider: "anthropic", apiKey: "k", routed: false });
    assert.equal(direct.tools["web_search"].execute, undefined, "called directly, the native pair as before");
  });

  it("the agent and llm steps' `model` field is marked for the model catalog", () => {
    for (const step of [agent, llm]) {
      const f = zodToFields(step.input).find((x) => x.name === "model");
      assert.ok(f, `${step.type}: model field`);
      assert.equal(f!.kind, "string");
      assert.equal(f!.required, false);
      assert.equal(f!.suggest, "llm-models");
    }
    // Nothing else grows the marker by accident.
    const prompt = zodToFields(llm.input).find((x) => x.name === "prompt")!;
    assert.equal(prompt.kind, "string");
    assert.equal(prompt.suggest, undefined);
  });
});

describe("llm: the llmAuth seam (plans/mothership-cost-control.md §1)", () => {
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

  it("the hook is told the PROVIDER before the model is built, and its key/URL/headers win over the secrets boundary", async () => {
    const store = new MemorySecretStore();
    await store.set("OPENAI_API_KEY", "from-store");
    const secrets = secretsCapability(store, { envFallback: process.env });
    const seen: unknown[] = [];
    const r = await resolveModel({
      model: "gpt",
      secrets,
      llmAuth: async (ctx) => {
        seen.push(ctx);
        return { apiKey: "vk-user", baseUrl: "https://gateway.example", headers: { "x-macaroon": "m" } };
      },
      auth: { kind: "step", runId: "r1", workflow: "wf", stepPath: "wf/s", principal: "alice" },
    });
    assert.deepEqual(seen, [{ kind: "step", provider: "openai", runId: "r1", workflow: "wf", stepPath: "wf/s", principal: "alice" }]);
    assert.equal(r.apiKey, "vk-user", "the grant's key, not the store's");
    assert.equal(r.provider, "openai");
    assert.equal(r.routed, true, "a baseUrl in the grant = the call goes through a gateway");

    // A grant that only re-keys the call (no baseUrl) still calls the provider directly.
    const keyed = await resolveModel({ model: "gpt", secrets, llmAuth: async () => ({ apiKey: "vk-user" }), auth: { kind: "step" } });
    assert.equal(keyed.routed, false);
  });

  it("`undefined` from the hook means the provider is called directly, with the boundary's key", async () => {
    const store = new MemorySecretStore();
    await store.set("OPENAI_API_KEY", "from-store");
    const secrets = secretsCapability(store, { envFallback: process.env });
    const r = await resolveModel({ model: "gpt", secrets, llmAuth: async () => undefined, auth: { kind: "step", runId: "r1" } });
    assert.equal(r.apiKey, "from-store");
    assert.equal(r.routed, false);
  });

  it("an organization-wide Anthropic key names its workspace (ANTHROPIC_WORKSPACE_ID) on every request", async () => {
    const { createServer } = await import("node:http");
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers["anthropic-workspace-id"] as string | undefined);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      const { generateText } = await import("ai");
      const call = async (entries: Record<string, string>) => {
        const store = new MemorySecretStore();
        for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: "k", ...entries })) await store.set(k, v);
        const r = await resolveModel({ model: "sonnet", secrets: secretsCapability(store, { envFallback: {} }) });
        await assert.rejects(() => generateText({ model: r.model, prompt: "hi", maxRetries: 0 }), /recorded/);
      };
      await call({ ANTHROPIC_WORKSPACE_ID: " wrkspc_01abc " });
      await call({});
      // A grant that re-keys the call brings its own workspace, if any.
      const store = new MemorySecretStore();
      await store.set("ANTHROPIC_WORKSPACE_ID", "wrkspc_01abc");
      const granted = await resolveModel({
        model: "sonnet",
        secrets: secretsCapability(store, { envFallback: {} }),
        llmAuth: async () => ({ apiKey: "vk-user" }),
        auth: { kind: "step" },
      });
      await assert.rejects(() => generateText({ model: granted.model, prompt: "hi", maxRetries: 0 }), /recorded/);
      assert.deepEqual(seen, ["wrkspc_01abc", undefined, undefined], "trimmed when set; a workspace key or a grant sends none");
    } finally {
      server.close();
    }
  });

  it("a maple call never asks the hook: it goes to MAPLE_BASE_URL with MAPLE_API_KEY, never the gateway", async () => {
    const { createServer } = await import("node:http");
    const seen: { path?: string; auth?: string; macaroon?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization, macaroon: req.headers["x-macaroon"] as string | undefined });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", created: 0, model: "gemma4-31b",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const store = new MemorySecretStore();
      await store.set("MAPLE_API_KEY", "mk");
      await store.set("MAPLE_BASE_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
      let calls = 0;
      const r = await resolveModel({
        model: "maple/gemma4-31b",
        secrets: secretsCapability(store, { envFallback: {} }),
        // The Mothership's grant: the gateway and the user's virtual key.
        llmAuth: async () => (calls++, { apiKey: "vk-user", baseUrl: "https://gateway.example", headers: { "x-macaroon": "m" } }),
        auth: { kind: "step", runId: "r1", principal: "alice" },
      });
      assert.equal(calls, 0, "the hook is not asked");
      assert.deepEqual([r.provider, r.modelId, r.apiKey, r.routed], ["maple", "gemma4-31b", "mk", false]);
      assert.deepEqual([r.contextLimit, r.maxOutputTokens], [262_144, 24_576]);
      const { generateText } = await import("ai");
      const out = await generateText({ model: r.model, prompt: "hi", maxRetries: 0 });
      assert.equal(out.text, "hello");
      assert.deepEqual(seen, [{ path: "/v1/chat/completions", auth: "Bearer mk", macaroon: undefined }]);
    } finally {
      server.close();
    }
  });

  it("a numes call never asks the hook either: NUMES_API_KEY to Numes' API, never the gateway", async () => {
    const { createServer } = await import("node:http");
    const seen: { path?: string; auth?: string; macaroon?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization, macaroon: req.headers["x-macaroon"] as string | undefined });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", created: 0, model: "z-ai/glm-5.3",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const store = new MemorySecretStore();
      await store.set("NUMES_API_KEY", "nk");
      // Numes' own endpoint by default; a stand-in here, as a deployment may point it.
      await store.set("NUMES_BASE_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`);
      let calls = 0;
      const r = await resolveModel({
        model: "numes/z-ai/glm-5.3",
        secrets: secretsCapability(store, { envFallback: {} }),
        llmAuth: async () => (calls++, { apiKey: "vk-user", baseUrl: "https://gateway.example", headers: { "x-macaroon": "m" } }),
        auth: { kind: "step", runId: "r1", principal: "alice" },
      });
      assert.equal(calls, 0, "the hook is not asked");
      assert.deepEqual([r.provider, r.modelId, r.apiKey, r.routed], ["numes", "z-ai/glm-5.3", "nk", false]);
      assert.deepEqual([r.contextLimit, r.maxOutputTokens], [262_144, 24_576]);
      const { generateText } = await import("ai");
      const out = await generateText({ model: r.model, prompt: "hi", maxRetries: 0 });
      assert.equal(out.text, "hello");
      assert.deepEqual(seen, [{ path: "/api/v1/chat/completions", auth: "Bearer nk", macaroon: undefined }]);
    } finally {
      server.close();
    }
  });

  it("no `auth` context → the hook is never consulted (a call site that opted out)", async () => {
    process.env["OPENAI_API_KEY"] = "env";
    let calls = 0;
    const r = await resolveModel({ model: "gpt", llmAuth: async () => (calls++, { apiKey: "never" }) });
    assert.equal(calls, 0);
    assert.equal(r.apiKey, "env");
  });

  it("a grant with explainError wraps the model: a gateway 402 the auth layer recognises is rethrown with its explanation", async () => {
    // A stand-in gateway: every request is a 402 naming the delegation.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "run dele-1 spent $10000.0000 of its $10000.00 cap", code: "run_cost_exceeded" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const explainError = (e: unknown) => {
        const err = e as { message?: string; responseBody?: string };
        return `${err.message ?? ""} ${err.responseBody ?? ""}`.includes("dele-1") ? "authorization for alice is exhausted" : undefined;
      };
      const r = await resolveModel({
        model: "gpt",
        llmAuth: async () => ({ apiKey: "vk", baseUrl: `http://127.0.0.1:${port}`, explainError }),
        auth: { kind: "step", runId: "r1", principal: "alice" },
      });
      assert.equal(r.model.modelId, "gpt-5.6-luna", "same model underneath");
      const { generateText } = await import("ai");
      await assert.rejects(
        () => generateText({ model: r.model, prompt: "hi", maxRetries: 0 }),
        (err: unknown) => {
          assert.equal((err as Error).message, "authorization for alice is exhausted");
          assert.match(String(((err as Error).cause as Error)?.message), /402|cap/);
          return true;
        },
      );
      // The same failure without a recognisable delegation id is left as the SDK raised it.
      const plain = await resolveModel({
        model: "gpt",
        llmAuth: async () => ({ apiKey: "vk", baseUrl: `http://127.0.0.1:${port}`, explainError: () => undefined }),
        auth: { kind: "step", runId: "r1" },
      });
      await assert.rejects(() => generateText({ model: plain.model, prompt: "hi", maxRetries: 0 }), /run dele-1 spent|402/);
    } finally {
      server.close();
    }
  });

  it("a model the person's virtual key does not allow: the gateway's refusal reaches the caller in plain words", async () => {
    // A stand-in gateway answering as bifrost's governance does.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ is_bifrost_error: true, status_code: 403, error: { type: "governance", message: "Model 'claude-opus-5-5' is not allowed" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const { explainRefused } = await import("./mothership.js");
      const r = await resolveModel({
        model: "opus",
        llmAuth: async () => ({ apiKey: "vk", baseUrl: `http://127.0.0.1:${port}`, explainError: explainRefused }),
        auth: { kind: "chat", chatId: "c1", principal: "alice" },
      });
      const { generateText, streamText } = await import("ai");
      const plain = /^claude-opus-5-5 is not enabled for this workspace: ask an admin$/;
      // The SDK's own message is only "Forbidden": the words are in the body.
      await assert.rejects(
        () => generateText({ model: r.model, prompt: "hi", maxRetries: 0 }),
        (err: unknown) => (assert.match((err as Error).message, plain), true),
      );
      let streamed: unknown;
      const s = streamText({ model: r.model, prompt: "hi", maxRetries: 0, onError: ({ error }) => void (streamed = error) });
      await s.consumeStream();
      assert.match(String((streamed as Error)?.message), plain);
    } finally {
      server.close();
    }
  });

  it("routed to a chat-completions API (xai, google), a tool's images reach the model as images, not base64 text", async () => {
    const { createServer } = await import("node:http");
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    try {
      const r = await resolveModel({ model: "grok", llmAuth: async () => ({ apiKey: "vk", baseUrl: `http://127.0.0.1:${port}` }), auth: { kind: "step" } });
      assert.equal(r.model.provider, "openai.chat");
      const { generateText } = await import("ai");
      await assert.rejects(() =>
        generateText({
          model: r.model,
          maxRetries: 0,
          messages: [
            { role: "user", content: "look" },
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolCallId: "c1", toolName: "shot", input: {} },
                { type: "tool-call", toolCallId: "c2", toolName: "note", input: {} },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result", toolCallId: "c1", toolName: "shot",
                  output: { type: "content", value: [{ type: "text", text: '{"path":"a.png"}' }, { type: "file", data: { type: "data", data: png }, mediaType: "image/png" }] },
                },
                { type: "tool-result", toolCallId: "c2", toolName: "note", output: { type: "json", value: { ok: true } } },
              ],
            },
          ] as any,
        }),
      );
      const sent = bodies[0].messages as any[];
      assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "tool", "tool", "user"], "the image after EVERY result of the step");
      assert.equal(sent[2].content, '{"path":"a.png"}\n[1 image in the next message]');
      assert.equal(sent[3].content, '{"ok":true}');
      assert.deepEqual(sent[4].content, [
        { type: "text", text: "[1 image from shot (c1)]" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ]);
    } finally {
      server.close();
    }
  });

  it("moveToolResultImages: images only, the rest of the prompt untouched, the same prompt the same way every time", async () => {
    const { moveToolResultImages } = await import("./llm.js");
    const pdf = { type: "file", data: { type: "data", data: "JVBER" }, mediaType: "application/pdf" };
    const img = { type: "file", data: { type: "data", data: "iVBOR" }, mediaType: "image/jpeg" };
    const result = (id: string, value: unknown[]) => ({ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "content", value } });
    const prompt = [
      { role: "system", content: "s" },
      { role: "tool", content: [result("a", [{ type: "text", text: "doc" }, pdf])] },
      { role: "tool", content: [result("b", [img, img])] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const out = moveToolResultImages(prompt);
    assert.deepEqual(out, moveToolResultImages(prompt));
    assert.equal(out[0], prompt[0]);
    assert.equal(out[1].content[0], prompt[1]!.content[0], "a result with no image is left as it is");
    assert.deepEqual(out[2].content[0].output, { type: "text", value: "[2 images in the next message]" });
    assert.deepEqual(out[3], { role: "user", content: [{ type: "text", text: "[2 images from read (b)]" }, img, img] });
    assert.equal(out[4], prompt[3]);
    // A file that is not an image stays in its result, beside the note.
    const mixed = moveToolResultImages([{ role: "tool", content: [result("c", [pdf, img])] }]);
    assert.deepEqual(mixed[0].content[0].output, { type: "content", value: [pdf, { type: "text", text: "[1 image in the next message]" }] });
    assert.deepEqual(moveToolResultImages([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
  });

  it("the agent step asks Anthropic for automatic prompt caching, with `cacheTtl` as the lifetime", async () => {
    // A stand-in Anthropic endpoint: record each request body, refuse it (400
    // is not retried), so the step fails right after the request we inspect.
    const { createServer } = await import("node:http");
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const ctx = {
        runId: "r1", path: "wf/a", scope: {}, input: undefined, emit: async () => {},
        services: { llmAuth: async () => ({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}` }) },
      };
      for (const [cfg, ttl] of [[{}, "5m"], [{ cacheTtl: "1h" }, "1h"]] as const) {
        const input = agent.input.parse({ system: "s", prompt: "hi", cwd: process.cwd(), model: "sonnet", ...cfg });
        await assert.rejects(() => agent.run(input, ctx as any));
        assert.deepEqual(bodies.at(-1).cache_control, { type: "ephemeral", ttl });
      }
    } finally {
      server.close();
    }
  });

  it("stepAuth: builds the step context from a StepContext, or nothing without a hook on the bag", async () => {
    const { stepAuth } = await import("./llm.js");
    const hook = async () => undefined;
    const ctx = { runId: "r9", path: "digest/loop#2/summarize", scope: {}, input: undefined, emit: async () => {}, services: { llmAuth: hook }, actor: "a", principal: "p" };
    const a = stepAuth(ctx as any);
    assert.equal(a.llmAuth, hook);
    assert.deepEqual(a.auth, { kind: "step", runId: "r9", workflow: "digest", stepPath: "digest/loop#2/summarize", actor: "a", principal: "p" });
    // No hook: no auth, but the context still rides along for the model wrappers (src/extensions.ts).
    const bare = stepAuth({ ...ctx, services: {} } as any, "sess");
    assert.deepEqual([bare.llmAuth, bare.auth, bare.session, bare.ctx?.runId], [undefined, undefined, "sess", "r9"]);
    assert.equal(stepAuth(undefined).llmAuth, undefined);
    // A slashed name: the run's workflow, never the path's first segment.
    const slashed = { ...ctx, path: "acme/linear/sync/summarize", workflow: "acme/linear/sync" };
    assert.equal(stepAuth(slashed as any).auth?.workflow, "acme/linear/sync");
  });
});
