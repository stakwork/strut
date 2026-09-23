import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveModel, listModelOptions, canonicalModelName, createWebTools } from "./llm.js";
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
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "EXA_API_KEY",
  "STRUT_MAX_OUTPUT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "LLM_PROVIDER",
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
    assert.equal(r.name, "anthropic/claude-sonnet-5");
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
    assert.equal(cat.default, "anthropic/claude-sonnet-5");
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
  });

  it("`undefined` from the hook means the provider is called directly, with the boundary's key", async () => {
    const store = new MemorySecretStore();
    await store.set("OPENAI_API_KEY", "from-store");
    const secrets = secretsCapability(store, { envFallback: process.env });
    const r = await resolveModel({ model: "gpt", secrets, llmAuth: async () => undefined, auth: { kind: "step", runId: "r1" } });
    assert.equal(r.apiKey, "from-store");
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
    assert.deepEqual(stepAuth({ ...ctx, services: {} } as any), {});
    assert.deepEqual(stepAuth(undefined), {});
  });
});
