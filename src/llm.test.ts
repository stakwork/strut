import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { MAPLE_MODELS, NUMES_MODELS, TOKENFACTORY_MODELS } from "./aieo/index.js";
import { resolveModel, listModelOptions, canonicalModelName, createWebTools, defaultModel, modelProvider } from "./llm.js";
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
  "TOKENFACTORY_API_KEY",
  "TOKENFACTORY_BASE_URL",
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
    const asked: string[] = [];
    const secrets = { get: async (name: string) => (asked.push(name), "k") };
    await assert.rejects(
      () => resolveModel({ model: "moonshotai/kimi-k2.6", secrets }),
      /openrouter\/moonshotai\/kimi-k2\.6/,
    );
    // Only the host's model list is read (is it a provider only its gateway has?), never a key.
    assert.deepEqual(asked, ["STRUT_MODELS"]);
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
    for (const id of Object.keys(TOKENFACTORY_MODELS)) assert.ok(names.includes(`tokenfactory/${id}`), `tokenfactory/${id}`);
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
    assert.equal(at("tokenfactory/glm-5.3").alias, "tokenfactory");
    assert.deepEqual(at("tokenfactory/glm-5.3").pricing, { inputTokenPrice: 0, outputTokenPrice: 0 });
    assert.deepEqual(at("tokenfactory/glm-5.3-flash").pricing, { inputTokenPrice: 0.15, outputTokenPrice: 0.5 });
    assert.equal(at("tokenfactory/qwen3.8-27b").contextLimit, 196_608);
    // Anthropic's own list prices are built in (aieo's table), so its models are priced with no catalog loaded.
    assert.equal(at("anthropic/claude-sonnet-5-5").pricing?.inputTokenPrice, 2);
    assert.equal(at("anthropic/claude-sonnet-5-5").pricing?.cacheWrite1hPrice, 4);
    for (const m of cat.models) {
      assert.ok((m.contextLimit ?? 0) > 0, `${m.name} has a window`);
      if (m.provider === "anthropic") continue; // priced from aieo's Anthropic table where it lists the model
      assert.equal(!!m.pricing, ["maple", "numes", "tokenfactory"].includes(m.provider), `${m.name}: a price only from a per-model table`);
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

  /** One stand-in for both the gateway (`/openai/v1/…`) and a provider's
   *  own endpoint: records each request's path, key, macaroon and model. */
  async function chatServer() {
    const { createServer } = await import("node:http");
    const seen: { path?: string; auth?: string; macaroon?: string; model?: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const model = JSON.parse(body).model;
        seen.push({ path: req.url, auth: req.headers.authorization, macaroon: req.headers["x-macaroon"] as string | undefined, model });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", created: 0, model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { root: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
  }

  it("a maple call asks the hook: a grant sends it through the gateway, billed to the person; no grant, to MAPLE_BASE_URL with MAPLE_API_KEY", async () => {
    const srv = await chatServer();
    try {
      const store = new MemorySecretStore();
      await store.set("MAPLE_API_KEY", "mk");
      await store.set("MAPLE_BASE_URL", `${srv.root}/v1`);
      const secrets = secretsCapability(store, { envFallback: {} });
      const asked: string[] = [];
      const auth = { kind: "step" as const, runId: "r1", principal: "alice" };
      const { generateText } = await import("ai");
      // The Mothership's grant: the gateway and the person's virtual key.
      const routed = await resolveModel({
        model: "maple/gemma4-31b",
        secrets,
        llmAuth: async (c) => (asked.push(c.provider), { apiKey: "vk-user", baseUrl: srv.root, headers: { "x-macaroon": "m" } }),
        auth,
      });
      assert.deepEqual(asked, ["maple"], "the hook is asked, with the provider");
      assert.deepEqual([routed.provider, routed.modelId, routed.name, routed.apiKey, routed.routed], ["maple", "gemma4-31b", "maple/gemma4-31b", "vk-user", true]);
      assert.deepEqual([routed.contextLimit, routed.maxOutputTokens], [262_144, 24_576], "Maple's own limits, routed or not");
      assert.equal((await generateText({ model: routed.model, prompt: "hi", maxRetries: 0 })).text, "hello");
      // No delegation for the person (and none required): Maple's own proxy, as before.
      const direct = await resolveModel({ model: "maple/gemma4-31b", secrets, llmAuth: async () => undefined, auth });
      assert.deepEqual([direct.apiKey, direct.routed], ["mk", false]);
      await generateText({ model: direct.model, prompt: "hi", maxRetries: 0 });
      assert.deepEqual(srv.seen, [
        { path: "/openai/v1/chat/completions", auth: "Bearer vk-user", macaroon: "m", model: "maple/gemma4-31b" },
        { path: "/v1/chat/completions", auth: "Bearer mk", macaroon: undefined, model: "gemma4-31b" },
      ]);
      // STRUT_MOTHERSHIP_REQUIRED: the hook refuses a call it cannot bill, Maple's now too.
      await assert.rejects(
        () => resolveModel({ model: "maple/gemma4-31b", secrets, llmAuth: async () => { throw new Error("no delegation for alice"); }, auth }),
        /no delegation for alice/,
      );
    } finally {
      srv.close();
    }
  });

  it("a numes call asks the hook too: through the gateway as numes/<author>/<model>, else to Numes' API with NUMES_API_KEY", async () => {
    const srv = await chatServer();
    try {
      const store = new MemorySecretStore();
      await store.set("NUMES_API_KEY", "nk");
      // Numes' own endpoint by default; a stand-in here, as a deployment may point it.
      await store.set("NUMES_BASE_URL", `${srv.root}/api/v1`);
      const secrets = secretsCapability(store, { envFallback: {} });
      const auth = { kind: "chat" as const, chatId: "c1", principal: "alice" };
      const { generateText } = await import("ai");
      const routed = await resolveModel({
        model: "numes/z-ai/glm-5.3",
        secrets,
        llmAuth: async () => ({ apiKey: "vk-user", baseUrl: srv.root, headers: { "x-macaroon": "m" } }),
        auth,
      });
      assert.deepEqual([routed.provider, routed.modelId, routed.routed], ["numes", "z-ai/glm-5.3", true]);
      await generateText({ model: routed.model, prompt: "hi", maxRetries: 0 });
      const direct = await resolveModel({ model: "numes/z-ai/glm-5.3", secrets, llmAuth: async () => undefined, auth });
      await generateText({ model: direct.model, prompt: "hi", maxRetries: 0 });
      assert.deepEqual(srv.seen, [
        { path: "/openai/v1/chat/completions", auth: "Bearer vk-user", macaroon: "m", model: "numes/z-ai/glm-5.3" },
        { path: "/api/v1/chat/completions", auth: "Bearer nk", macaroon: undefined, model: "z-ai/glm-5.3" },
      ]);
    } finally {
      srv.close();
    }
  });

  it("a tokenfactory call asks the hook too: through the gateway as tokenfactory/<id>, else to Token Factory with TOKENFACTORY_API_KEY", async () => {
    const srv = await chatServer();
    try {
      const store = new MemorySecretStore();
      await store.set("TOKENFACTORY_API_KEY", "tk");
      // Token Factory's own gateway by default; a stand-in here.
      await store.set("TOKENFACTORY_BASE_URL", `${srv.root}/v1`);
      const secrets = secretsCapability(store, { envFallback: {} });
      const auth = { kind: "chat" as const, chatId: "c1", principal: "alice" };
      const { generateText } = await import("ai");
      const routed = await resolveModel({
        model: "tokenfactory/kimi-k3.1-pro",
        secrets,
        llmAuth: async () => ({ apiKey: "vk-user", baseUrl: srv.root, headers: { "x-macaroon": "m" } }),
        auth,
      });
      assert.deepEqual([routed.provider, routed.modelId, routed.routed], ["tokenfactory", "kimi-k3.1-pro", true]);
      await generateText({ model: routed.model, prompt: "hi", maxRetries: 0 });
      const direct = await resolveModel({ model: "tokenfactory/kimi-k3.1-pro", secrets, llmAuth: async () => undefined, auth });
      assert.equal(direct.contextLimit, 917_504);
      await generateText({ model: direct.model, prompt: "hi", maxRetries: 0 });
      assert.deepEqual(srv.seen, [
        { path: "/openai/v1/chat/completions", auth: "Bearer vk-user", macaroon: "m", model: "tokenfactory/kimi-k3.1-pro" },
        { path: "/v1/chat/completions", auth: "Bearer tk", macaroon: undefined, model: "kimi-k3.1-pro" },
      ]);
    } finally {
      srv.close();
    }
  });

  it("a gateway with no route to the provider: the call goes straight to it when the grant allows, else the gateway's error stands", async () => {
    // A stand-in for both: the gateway's route refuses as Bifrost does with
    // no `tokenfactory` provider; Token Factory's own route answers.
    const { createServer } = await import("node:http");
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { model, stream } = JSON.parse(body);
        seen.push(`${req.url} ${req.headers.authorization} ${stream ? "stream" : "generate"}`);
        if (req.url!.startsWith("/openai/")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ is_bifrost_error: true, error: { message: "could not auto resolve a provider for the request" } }));
          return;
        }
        if (stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          chunk({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] });
          chunk({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", created: 0, model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const store = new MemorySecretStore();
      await store.set("TOKENFACTORY_API_KEY", "tk");
      await store.set("TOKENFACTORY_BASE_URL", `${root}/v1`);
      const secrets = secretsCapability(store, { envFallback: {} });
      const auth = { kind: "step" as const, runId: "r1", principal: "alice" };
      const { generateText, streamText } = await import("ai");
      const r = await resolveModel({
        model: "tokenfactory/glm-5.3",
        secrets,
        llmAuth: async () => ({ apiKey: "vk-user", baseUrl: root, direct: true }),
        auth,
      });
      assert.equal((await generateText({ model: r.model, prompt: "hi", maxRetries: 0 })).text, "hello");
      assert.equal(await streamText({ model: r.model, prompt: "hi", maxRetries: 0 }).text, "hello");
      assert.deepEqual(seen, [
        "/openai/v1/chat/completions Bearer vk-user generate",
        "/v1/chat/completions Bearer tk generate",
        "/openai/v1/chat/completions Bearer vk-user stream",
        "/v1/chat/completions Bearer tk stream",
      ]);
      // Required: no `direct`, so the gateway's refusal is the error.
      seen.length = 0;
      const held = await resolveModel({
        model: "tokenfactory/glm-5.3",
        secrets,
        llmAuth: async () => ({ apiKey: "vk-user", baseUrl: root, explainError: () => "tokenfactory is not set up" }),
        auth,
      });
      await assert.rejects(() => generateText({ model: held.model, prompt: "hi", maxRetries: 0 }), /tokenfactory is not set up/);
      assert.deepEqual(seen, ["/openai/v1/chat/completions Bearer vk-user generate"]);
    } finally {
      server.close();
    }
  });

  it("the llm step bills a Token Factory call at the cost the gateway reported, not the table's", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const model = JSON.parse(body).model;
        // LiteLLM: a call that is not streamed reports its cost in a header.
        res.writeHead(200, { "content-type": "application/json", "x-litellm-response-cost": "0.0123" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", created: 0, model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const store = new MemorySecretStore();
      await store.set("TOKENFACTORY_API_KEY", "tk");
      await store.set("TOKENFACTORY_BASE_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
      const ctx = { services: { secrets: secretsCapability(store, { envFallback: {} }) } };
      const out: any = await llm.run(llm.input.parse({ model: "tokenfactory/glm-5.3-flash", prompt: "hi" }), ctx as any);
      assert.equal(out.text, "hello");
      // The table would say 10 in at $0.15/M + 2 out at $0.50/M = $0.0000025.
      assert.equal(out.cost, 0.0123);
    } finally {
      server.close();
    }
  });

  it("a provider only the gateway has: runs through a grant when the host lists the model, never directly, and an unlisted name is the trap as before", async () => {
    const srv = await chatServer();
    try {
      const store = new MemorySecretStore();
      await store.set("STRUT_MODELS", JSON.stringify(["anthropic/claude-opus-5-5", "acme/llama-4"]));
      const secrets = secretsCapability(store, { envFallback: {} });
      const auth = { kind: "step" as const, runId: "r1", principal: "alice" };
      const asked: string[] = [];
      const grant = async (c: { provider: string }) => (asked.push(c.provider), { apiKey: "vk-user", baseUrl: srv.root, headers: { "x-macaroon": "m" } });
      const r = await resolveModel({ model: "acme/llama-4", secrets, llmAuth: grant, auth });
      assert.deepEqual(asked, ["acme"]);
      assert.deepEqual([r.provider, r.modelId, r.name, r.routed], ["acme", "llama-4", "acme/llama-4", true]);
      const { generateText } = await import("ai");
      assert.equal((await generateText({ model: r.model, prompt: "hi", maxRetries: 0 })).text, "hello");
      assert.deepEqual(srv.seen, [{ path: "/openai/v1/chat/completions", auth: "Bearer vk-user", macaroon: "m", model: "acme/llama-4" }]);
      // No grant: nowhere to send it.
      await assert.rejects(
        () => resolveModel({ model: "acme/llama-4", secrets, llmAuth: async () => undefined, auth }),
        /"acme", a provider only this deployment's gateway has/,
      );
      await assert.rejects(() => resolveModel({ model: "acme/llama-4", secrets }), /only this deployment's gateway has/);
      // Not on the host's list: aieo's own error, which says how to write a hosted model.
      await assert.rejects(() => resolveModel({ model: "moonshotai/kimi-k2.6", secrets, llmAuth: grant, auth }), /openrouter\/moonshotai\/kimi-k2\.6/);
      assert.deepEqual(asked, ["acme"], "the hook is not asked for a name nobody listed");
      assert.deepEqual(await modelProvider("acme/llama-4", undefined, secrets), { provider: "acme", gatewayOnly: true });
      assert.deepEqual(await modelProvider("acme/llama-4", "acme", secrets), { provider: "acme", gatewayOnly: true });
      assert.deepEqual(await modelProvider("maple/gemma4-31b", undefined, secrets), { provider: "maple", gatewayOnly: false });
      // An explicit aieo provider places any name, as aieo always has.
      assert.deepEqual(await modelProvider("acme/llama-4", "openai", secrets), { provider: "openai", gatewayOnly: false });
    } finally {
      srv.close();
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
