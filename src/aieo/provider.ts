import { createAnthropic, AnthropicProviderOptions } from "@ai-sdk/anthropic";
import {
  createGoogleGenerativeAI,
  GoogleGenerativeAIProviderOptions,
} from "@ai-sdk/google";
import { createOpenAI, OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { LanguageModel, wrapLanguageModel } from "ai";
import { Logger } from "./logger.js";
import { createOpenRouter, OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import { env } from "./env.js";

export type Provider = "anthropic" | "google" | "openai" | "openrouter" | "xai" | "maple" | "numes" | "tokenfactory";

/**
 * Optional LLM gateway URL (e.g. Bifrost: https://github.com/maximhq/bifrost,
 * LiteLLM, Portkey, etc.). When set, all provider SDKs are routed through this
 * gateway using each provider's drop-in path. Leave unset to call providers directly.
 */
const LLM_GATEWAY_URL = env.LLM_GATEWAY_URL?.replace(/\/$/, "");

/**
 * Per-provider path Bifrost (and compatible gateways) expose for each
 * provider's drop-in SDK. Exported so spawners can build per-provider
 * URLs without hand-rolling the suffix.
 *
 * NOTE: OpenRouter has no dedicated Bifrost route and rides the OpenAI
 * path (model id prefixed `openrouter/` in getModel so Bifrost routes it
 * upstream). If you spawn an agent in a way where the runtime would
 * override the model to an OpenRouter model, you want the OpenAI suffix
 * here too. xAI likewise rides the OpenAI-compat path (model id prefixed
 * `xai/` in getModel), since Bifrost has no dedicated Grok route. So do
 * Maple, Numes, Token Factory and any provider aieo does not know
 * (`acme/llama-4`): a gateway holds each as an OpenAI-compatible custom
 * provider of that name.
 */
export const GATEWAY_PATHS: Record<Provider, string> = {
  anthropic: "/anthropic/v1",
  google: "/genai/v1beta",
  openai: "/openai/v1",
  openrouter: "/openai/v1",
  xai: "/openai/v1",
  maple: "/openai/v1",
  numes: "/openai/v1",
  tokenfactory: "/openai/v1",
};

/**
 * The version path on a provider's OWN endpoint (BASE_URL_ENV), so a bare
 * root gets it: Maple's proxy ("http://maple:8080" → /v1), Numes' API
 * ("https://api.numes.ai" → /api/v1), Token Factory's gateway
 * ("https://gateway.trytokenfactory.dev" → /v1).
 */
const ENDPOINT_PATHS: Partial<Record<Provider, string>> = {
  maple: "/v1",
  numes: "/api/v1",
  tokenfactory: "/v1",
};

export function getGatewayBaseURL(provider: Provider | string): string | undefined {
  // A provider with an endpoint of its own (BASE_URL_ENV) never rides the
  // env gateway: it rides a gateway only when a caller passes one (baseUrl).
  if (BASE_URL_ENV[provider as Provider]) return undefined;
  return LLM_GATEWAY_URL ? gatewayUrlFor(provider, LLM_GATEWAY_URL) : undefined;
}

/**
 * Build the fully-formed `<base>/<provider-path>` URL that an official
 * SDK (or Goose, or a workflow LLM node) expects.
 *
 * This is the single source of truth for "which suffix do I add to the
 * gateway root for this provider." Spawners (Hive, Stakwork, anyone
 * launching an agent) should call this when stamping `ANTHROPIC_BASE_URL`,
 * `OPENAI_BASE_URL`, `GOOGLE_BASE_URL`, etc. on a child process or
 * workflow context.
 *
 * Behavior:
 *  - Trims a trailing slash.
 *  - Returns the URL unchanged if it already ends with the provider's
 *    gateway path (`/anthropic/v1`, `/openai/v1`, `/genai/v1beta`), so
 *    the function is idempotent.
 *  - Returns the URL unchanged if it already targets a provider/version
 *    path (e.g. `.../v1`, `.../v1beta`, `.../anthropic/...`). This lets
 *    callers pass fully-qualified URLs through without surprise.
 *  - Otherwise appends `GATEWAY_PATHS[provider]`.
 *
 * Examples
 * --------
 * gatewayUrlFor("anthropic", "https://swarm38.sphinx.chat:8181")
 *   => "https://swarm38.sphinx.chat:8181/anthropic/v1"
 *
 * gatewayUrlFor("openai", "https://swarm38.sphinx.chat:8181/")
 *   => "https://swarm38.sphinx.chat:8181/openai/v1"
 *
 * gatewayUrlFor("anthropic", "https://swarm38.sphinx.chat:8181/anthropic/v1")
 *   => "https://swarm38.sphinx.chat:8181/anthropic/v1"   (idempotent)
 *
 * gatewayUrlFor("openai", "https://api.openai.com/v1")
 *   => "https://api.openai.com/v1"                       (left alone)
 */
export function gatewayUrlFor(provider: Provider | string, baseUrl: string): string {
  // A provider aieo does not know rides the OpenAI-compatible route.
  return withPath(baseUrl, GATEWAY_PATHS[provider as Provider] ?? GATEWAY_PATHS.openai);
}

/** `baseUrl` with `providerPath` appended, unless it already ends in it or
 *  in another provider/version path. */
function withPath(baseUrl: string, providerPath: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  // Already provider-suffixed with the exact path we'd add.
  if (trimmed.endsWith(providerPath)) {
    return trimmed;
  }
  // Already targets a specific provider/version path; trust the caller.
  // Common shapes: `.../anthropic/v1`, `.../openai/v1`, `.../genai/v1beta`,
  // `.../v1`, `.../v1beta`.
  if (/\/(anthropic|openai|genai)\/v\d+[a-z]*$/i.test(trimmed) ||
      /\/v\d+[a-z]*$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}${providerPath}`;
}

/**
 * Like {@link gatewayUrlFor} but takes a model name (shortcut like
 * `"sonnet"`, namespaced like `"anthropic/claude-sonnet-5-5"`, or a full
 * model id like `"claude-sonnet-5-5"`) and resolves the provider for you.
 *
 * Convenient for spawners that have a model name in hand but not a
 * provider — e.g. Hive picking up a user's chosen model and needing to
 * tell the agent which Bifrost route to use.
 */
export function gatewayUrlForModel(modelName: string | undefined, baseUrl: string): string {
  return gatewayUrlFor(getProviderForModel(modelName), baseUrl);
}

/**
 * Build a `{ ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_BASE_URL }`-style
 * env map for spawning agents (Goose, Python, raw SDK callers) that
 * don't normalize the URL themselves. Pass the gateway root once; get
 * back the per-provider URLs.
 *
 * The keys match the env var names the official SDKs read by default:
 *   - `ANTHROPIC_BASE_URL`        (anthropic-sdk-{ts,python,go})
 *   - `OPENAI_BASE_URL`           (openai SDK)
 *   - `GOOGLE_GENERATIVE_AI_BASE_URL` (google-genai SDK / `@ai-sdk/google`)
 *
 * Spawners can spread the result into the child's env. Callers that
 * only need one provider should use {@link gatewayUrlFor} directly.
 */
export function gatewayEnvForProviders(baseUrl: string): {
  ANTHROPIC_BASE_URL: string;
  OPENAI_BASE_URL: string;
  GOOGLE_GENERATIVE_AI_BASE_URL: string;
} {
  return {
    ANTHROPIC_BASE_URL: gatewayUrlFor("anthropic", baseUrl),
    OPENAI_BASE_URL: gatewayUrlFor("openai", baseUrl),
    GOOGLE_GENERATIVE_AI_BASE_URL: gatewayUrlFor("google", baseUrl),
  };
}

/**
 * @deprecated Use {@link gatewayUrlFor}. Kept as an alias for internal
 * call sites; both have identical behavior.
 */
export const normalizeCallerBaseURL = gatewayUrlFor;

export const PROVIDERS: Provider[] = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
  "xai",
  "maple",
  "numes",
  "tokenfactory",
];

// shortcuts to latest models
export type ModelName = "sonnet" | "opus" | "haiku" | "gemini" | "gpt" | "kimi" | "glm" | "grok" | "maple" | "numes" | "tokenfactory";

type ModelId = string;

export const MODELS: Record<Provider, Partial<Record<ModelName, ModelId>>> = {
  anthropic: {
    sonnet: "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    haiku: "claude-haiku-4-5",
  },
  google: {
    gemini: "gemini-3.8-flash",
  },
  openai: {
    gpt: "gpt-5.6-luna",
  },
  openrouter: {
    kimi: "moonshotai/kimi-k3",
    // OpenRouter rolling alias (the leading "~" is part of the id): always
    // the newest GLM Flash. The plain "z-ai/glm-flash-latest" 404s.
    glm: "~z-ai/glm-flash-latest",
  },
  xai: {
    grok: "grok-4.7",
  },
  // The provider's own name is its alias, so "maple" alone names Maple; a
  // bare Maple id ("gemma4-31b") never does — write "maple/gemma4-31b".
  maple: {
    maple: "gemma4-31b",
  },
  // Numes ids are OpenRouter-style "author/model" slugs, so a Numes name has
  // three segments ("numes/z-ai/glm-5.3"); "numes" alone is a free model.
  numes: {
    numes: "z-ai/glm-5.3",
  },
  // Token Factory ids are bare ("glm-5.3"), so a name has two segments
  // ("tokenfactory/glm-5.3"), as for Maple; "tokenfactory" alone is a free model.
  tokenfactory: {
    tokenfactory: "glm-5.3",
  },
};

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: MODELS.anthropic.sonnet!,
  google: MODELS.google.gemini!,
  openai: MODELS.openai.gpt!,
  openrouter: MODELS.openrouter.kimi!,
  xai: MODELS.xai.grok!,
  maple: MODELS.maple.maple!,
  numes: MODELS.numes.numes!,
  tokenfactory: MODELS.tokenfactory.tokenfactory!,
};

// Light/cheap models for batch operations (descriptions, learnings, etc.)
const LIGHT_MODELS: Record<Provider, string> = {
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.0-flash",
  openai: "gpt-4.1-mini",
  openrouter: "moonshotai/kimi-k2.6",
  xai: "grok-4-fast-non-reasoning",
  maple: "gemma4-31b",
  numes: "z-ai/glm-5.3-flash",
  tokenfactory: "minimax-m3.1-flash",
};

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface MapleModel {
  /** Context window (prompt + output), tokens. */
  context: number;
  /** Per-call output cap. The backend refuses a call whose prompt plus
   *  max_tokens passes the window (gemma4-31b: 262,000 passes, 262,144 is a
   *  400), so the cap stays under 10% of it — a prompt can reach strut's
   *  compaction mark (90%) and still be answered. */
  maxOutput: number;
  pricing: TokenPricing;
  /** The `reasoning_effort` values the model takes; any other is a 400.
   *  Absent: anything is taken (gemma4-31b: `none` or no field is no
   *  thinking, any other value turns it on; llama3-3-70b ignores it). */
  efforts?: ReasoningEffort[];
}

/**
 * Maple (maple.ai): open models in attested enclaves, behind Maple's
 * OpenAI-compatible proxy (`ghcr.io/mapleprivacylabs/maple-proxy`), which
 * the deployment runs itself. Chat Completions only, no Responses API.
 * Context and efforts from the proxy's `GET /v1/models` and its 400s
 * (2026-11-03); prices are Maple's per 1M tokens, input / output. Maple
 * publishes no cached-input price, so a cached prompt token (gpt-oss reports
 * them) is billed as input.
 */
export const MAPLE_MODELS: Record<string, MapleModel> = {
  "gemma4-31b": { context: 262_144, maxOutput: 24_576, pricing: { inputTokenPrice: 0.8, outputTokenPrice: 2.0 } },
  "gpt-oss-120b": {
    context: 131_072,
    maxOutput: 12_288,
    pricing: { inputTokenPrice: 0.3, outputTokenPrice: 1.2 },
    efforts: ["low", "medium", "high"],
  },
  "glm-5-3-flash": {
    context: 1_048_576,
    maxOutput: 64_000,
    pricing: { inputTokenPrice: 0.8, outputTokenPrice: 2.5 },
    efforts: ["low", "high", "max"],
  },
  "glm-5-3": {
    context: 262_144,
    maxOutput: 24_576,
    pricing: { inputTokenPrice: 3.6, outputTokenPrice: 11.5 },
    efforts: ["low", "high", "max"],
  },
  "kimi-k3": {
    context: 262_144,
    maxOutput: 24_576,
    pricing: { inputTokenPrice: 8.0, outputTokenPrice: 25.0 },
    efforts: ["none", "low", "high", "max"],
  },
  "deepseek-v4-1-flash": {
    context: 1_048_576,
    maxOutput: 64_000,
    pricing: { inputTokenPrice: 0.65, outputTokenPrice: 1.45 },
    efforts: ["none", "low", "high", "xhigh", "max"],
  },
  "llama3-3-70b": { context: 131_072, maxOutput: 12_288, pricing: { inputTokenPrice: 3.5, outputTokenPrice: 5.5 } },
};

/**
 * The `reasoning_effort` to send Maple for `modelId` when `requested` was
 * asked for: as asked when the model takes it, else the nearest value it
 * takes, a tie going to more thinking (gpt-oss: none → low, xhigh → high;
 * GLM: medium → high). An unknown model or value is sent as asked.
 */
export function mapleReasoningEffort(modelId: string, requested: string): string {
  const efforts = MAPLE_MODELS[modelId]?.efforts;
  const at = EFFORT_ORDER.indexOf(requested as ReasoningEffort);
  if (!efforts || at < 0 || efforts.includes(requested as ReasoningEffort)) return requested;
  let best = efforts[0];
  let bestDistance = Infinity;
  for (const e of efforts) {
    const d = Math.abs(EFFORT_ORDER.indexOf(e) - at);
    if (d < bestDistance || (d === bestDistance && EFFORT_ORDER.indexOf(e) > EFFORT_ORDER.indexOf(best))) {
      best = e;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Maple's fetch: the request's `reasoning_effort` made one the model takes.
 * The AI SDK sends a call's `reasoning` (and `providerOptions.openai.
 * reasoningEffort`) as it is, and every Maple model but gemma4 and llama
 * answers a value outside its own short list with a 400. Through a gateway
 * the model id carries its `maple/` prefix.
 */
function mapleFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const body = init?.body;
    if (typeof body === "string" && body.includes('"reasoning_effort"')) {
      try {
        const json = JSON.parse(body);
        if (typeof json?.model === "string" && typeof json.reasoning_effort === "string") {
          const effort = mapleReasoningEffort(json.model.replace(/^maple\//, ""), json.reasoning_effort);
          if (effort !== json.reasoning_effort) {
            init = { ...init, body: JSON.stringify({ ...json, reasoning_effort: effort }) };
          }
        }
      } catch {
        // Not JSON: sent as it is.
      }
    }
    return inner(input, init);
  };
}

// ── A cost the provider reports ─────────────────────────────────────────────
//
// Numes reports what each call cost in its usage (`cost`); Token Factory
// (LiteLLM) does in a streamed call's usage and, for a call that is not
// streamed, in its `x-litellm-response-cost` header (a stream's header is
// sent before the cost is known, so it is never read). @ai-sdk/openai's chat
// client parses usage through a schema that keeps only token counts, so the
// cost never reached a step's `usage.raw`. It is put back here: a fetch that
// reads it off the response, matched to its call by a header of aieo's own
// (taken off before the request is sent), and a model wrapper that adds it
// to that call's `usage.raw` as `cost` — where a host reads a reported cost
// (strut's `reportedCost`). A call that reports none is left as it was, and
// is priced from the tables (computeSessionCost).

const COST_CALL_HEADER = "x-aieo-cost-call";
let costCalls = 0;

const costOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** The call id a request carries, and the request without it. */
function takeCostCall(init: RequestInit | undefined): [string | undefined, RequestInit | undefined] {
  const h = init?.headers;
  if (!h) return [undefined, init];
  if (h instanceof Headers) {
    const id = h.get(COST_CALL_HEADER) ?? undefined;
    if (!id) return [undefined, init];
    const headers = new Headers(h);
    headers.delete(COST_CALL_HEADER);
    return [id, { ...init, headers }];
  }
  const entries = Array.isArray(h) ? h : Object.entries(h);
  const hit = entries.find(([k]) => k.toLowerCase() === COST_CALL_HEADER);
  if (!hit) return [undefined, init];
  const rest = entries.filter(([k]) => k.toLowerCase() !== COST_CALL_HEADER);
  // Node's header records may hold a list per name; aieo sets one value.
  const id = typeof hit[1] === "string" ? hit[1] : hit[1][0];
  return [id, { ...init, headers: Array.isArray(h) ? rest : Object.fromEntries(rest) }];
}

/** A stream passed on as it came, each `data:` line that carries a usage
 *  `cost` noting it for the call. */
function costFromEvents(id: string, costs: Map<string, number>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  const scan = (text: string) => {
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith("data:") || !line.includes('"cost"')) continue;
      try {
        const cost = costOf(JSON.parse(line.slice(5))?.usage?.cost);
        if (cost !== undefined) costs.set(id, cost);
      } catch {
        // Not JSON: passed on as it is.
      }
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      scan(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      scan(decoder.decode() + "\n");
    },
  });
}

/** The provider's fetch, noting each call's reported cost in `costs`. */
function reportedCostFetch(inner: typeof fetch, costs: Map<string, number>): typeof fetch {
  return async (input, init) => {
    const [id, sent] = takeCostCall(init);
    const res = await inner(input, sent);
    if (!id || !res.ok) return res;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
      return new Response(res.body.pipeThrough(costFromEvents(id, costs)), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    try {
      const body = (await res.clone().json()) as { usage?: { cost?: unknown } } | null;
      const cost = costOf(body?.usage?.cost);
      if (cost !== undefined) costs.set(id, cost);
    } catch {
      // Not JSON: nothing reported.
    }
    if (!costs.has(id) && res.headers.has("x-litellm-response-cost")) {
      const cost = costOf(Number(res.headers.get("x-litellm-response-cost")));
      if (cost !== undefined) costs.set(id, cost);
    }
    return res;
  };
}

/** The usage with `cost` added to its `raw`. */
function usageWithCost<U extends { raw?: unknown }>(usage: U, cost: number): U {
  const raw = usage.raw && typeof usage.raw === "object" ? usage.raw : {};
  return { ...usage, raw: { ...raw, cost } };
}

/** The model, each call's reported cost (noted by reportedCostFetch) on its
 *  usage. Provider and model id are the model's own. */
function withReportedCost(model: Parameters<typeof wrapLanguageModel>[0]["model"], costs: Map<string, number>): LanguageModel {
  const tagged = <P extends { headers?: Record<string, string | undefined> }>(params: P, id: string): P => ({
    ...params,
    headers: { ...params.headers, [COST_CALL_HEADER]: id },
  });
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ model, params }) => {
        const id = String(++costCalls);
        try {
          const result = await model.doGenerate(tagged(params, id));
          const cost = costs.get(id);
          return cost === undefined ? result : { ...result, usage: usageWithCost(result.usage, cost) };
        } finally {
          costs.delete(id);
        }
      },
      wrapStream: async ({ model, params }) => {
        const id = String(++costCalls);
        const result = await model.doStream(tagged(params, id));
        type Part = typeof result.stream extends ReadableStream<infer P> ? P : never;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<Part, Part>({
              transform(part, controller) {
                if (part.type === "finish") {
                  const cost = costs.get(id);
                  costs.delete(id);
                  if (cost !== undefined) part = { ...part, usage: usageWithCost(part.usage, cost) };
                }
                controller.enqueue(part);
              },
              flush() {
                costs.delete(id);
              },
            }),
          ),
        };
      },
    },
  });
}

export interface NumesModel {
  /** Context window (prompt + output), tokens. */
  context: number;
  /** Per-call output cap: the model's own limit (a `max_tokens` past it is a
   *  400) and under a tenth of the window, since Numes refuses a call whose
   *  prompt plus `max_tokens` passes the window (z-ai/glm-5.3: a 199k prompt
   *  with 65,536 is a 502, with 1,000 an answer) — so a prompt can reach
   *  strut's compaction mark (90%) and still be answered. */
  maxOutput: number;
  pricing: TokenPricing;
}

const FREE: TokenPricing = { inputTokenPrice: 0, outputTokenPrice: 0 };

/**
 * Numes (numes.ai): a marketplace of inference providers behind one
 * OpenAI-compatible API, `https://api.numes.ai/api/v1` (Chat Completions;
 * its own `reasoning_effort` mapping, so any value is taken). Model ids are
 * OpenRouter-style slugs, the same on every provider that serves the model.
 * Listed: the models Numes serves FREE, from `GET /api/v1/models` on
 * 2026-11-04 (each answered, called a tool and reported `cost: 0`). A model
 * that stops being free is still priced 0 here until the list changes. Every
 * other Numes model is priced like the same slug on OpenRouter when the host
 * loaded those rates (loadModelPricing), else at TOKEN_PRICING.numes.
 */
export const NUMES_MODELS: Record<string, NumesModel> = {
  "z-ai/glm-5.3": { context: 262_144, maxOutput: 24_576, pricing: FREE },
  "z-ai/glm-5.3-flash": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
  "nvidia/nemotron-3-super-120b-a12b": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
  "nvidia/nemotron-3-ultra-550b-a55b": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
  "dealignai/glm-5.3-uncensored-fp8": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
  "dealignai/glm-5.3-flash-uncensored-fp8": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
  "dealignai/deepseek-v4.1-flash-uncensored-fp8": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
  "uniboshi/kimi-k3-abliterated-v1": { context: 1_048_576, maxOutput: 64_000, pricing: FREE },
};

export interface TokenFactoryModel {
  /** The prompt the gateway takes, tokens: its `max_input_tokens`, the
   *  window less the model's output limit (917,504 of 1,048,576), so a
   *  prompt at strut's compaction mark (90%) is never one it refuses. */
  context: number;
  /** Per-call output cap: under a tenth of the window, as for Numes (the
   *  vLLM backends refuse prompt + `max_tokens` past the window). */
  maxOutput: number;
  pricing: TokenPricing;
}

/**
 * Token Factory (trytokenfactory.dev): open models behind a LiteLLM proxy,
 * `https://gateway.trytokenfactory.dev/v1` (Chat Completions). A key is
 * bought and topped up over Nostr; spend is in USD. Every `reasoning_effort`
 * is taken (a model's own short list is not enforced), so none is rewritten.
 * The gateway reports each call's cost (a streamed call's usage `cost`, a
 * header otherwise), which withReportedCost puts on the call's usage, and a
 * host bills that; these prices answer a call that reports none (a free
 * model's stream) and the model picker.
 * Listed: `GET /v1/models` on 2026-11-09 (windows, output limits); each
 * model called a tool, and its price is what the gateway billed for that
 * call (its `x-litellm-response-cost-input` / `-output` per token): nine
 * cost nothing. A model whose price changes keeps this one until the list
 * does. An unlisted model is priced at TOKEN_PRICING.tokenfactory.
 */
export const TOKENFACTORY_MODELS: Record<string, TokenFactoryModel> = {
  "glm-5.3": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "glm-5.3-flash": { context: 917_504, maxOutput: 64_000, pricing: { inputTokenPrice: 0.15, outputTokenPrice: 0.5 } },
  "kimi-k3.1-pro": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "minimax-m3.1-flash": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "deepseek-v4.1-flash-1017": {
    context: 917_504,
    maxOutput: 64_000,
    pricing: { inputTokenPrice: 0.205, outputTokenPrice: 1.163 },
  },
  "nemotron-3-ultra": { context: 917_504, maxOutput: 64_000, pricing: { inputTokenPrice: 0.6, outputTokenPrice: 2.4 } },
  "nemotron-3-super": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "nemotron-3.5-lightning": {
    context: 917_504,
    maxOutput: 64_000,
    pricing: { inputTokenPrice: 0.06, outputTokenPrice: 0.18 },
  },
  "qwen3.8-27b": { context: 196_608, maxOutput: 24_576, pricing: FREE },
  "glm-5.3-uncensored-fp8": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "glm-5.3-flash-uncensored-fp8": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "deepseek-v4.1-flash-1017-uncensored-fp8": { context: 917_504, maxOutput: 64_000, pricing: FREE },
  "kimi-k3-abliterated": { context: 917_504, maxOutput: 64_000, pricing: FREE },
};

export function getLightModelForProvider(provider: Provider): string {
  return LIGHT_MODELS[provider];
}

export interface TokenPricing {
  inputTokenPrice: number;
  outputTokenPrice: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

export interface TokenUsageForCost {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

/** A provider aieo does not know (one only a gateway has) has no rate here:
 *  0, and the gateway bills it. */
export function computeSessionCost(provider: Provider | string, usage: TokenUsageForCost, modelId?: string, actualCost?: number): number {
  if (typeof actualCost === "number" && actualCost >= 0) return actualCost;
  // The model's own price (Maple's, Numes' or Token Factory's table, then the datasheet), else
  // the provider's flat rate; a provider aieo does not know has neither.
  const pricing = (modelId ? getModelPrice(provider as Provider, modelId) : undefined) ?? TOKEN_PRICING[provider as Provider];
  if (!pricing) return 0;
  const inputCost = (usage.input / 1_000_000) * pricing.inputTokenPrice;
  const cacheReadCost = (usage.cache_read / 1_000_000) * (pricing.cacheReadPrice ?? pricing.inputTokenPrice);
  const cacheWriteCost = (usage.cache_write / 1_000_000) * (pricing.cacheWritePrice ?? pricing.inputTokenPrice);
  const outputCost = (usage.output / 1_000_000) * pricing.outputTokenPrice;
  return inputCost + cacheReadCost + cacheWriteCost + outputCost;
}

export function getProviderForModel(modelName?: ModelName | string): Provider {
  // Handle format like "anthropic/claude-sonnet-4-5" or "openrouter/moonshotai/kimi-k2.6"
  if (modelName && modelName.includes("/")) {
    const provider = modelName.split("/")[0] as Provider;
    if (PROVIDERS.includes(provider)) {
      return provider;
    }
  }
  switch (modelName) {
    case "kimi":
    case "glm":
      return "openrouter";
    case "sonnet":
      return "anthropic";
    case "opus":
      return "anthropic";
    case "haiku":
      return "anthropic";
    case "gemini":
      return "google";
    case "gpt":
      return "openai";
    case "grok":
      return "xai";
    // Only the alias: a bare Maple id is no one's (canonicalModelName says so).
    case "maple":
      return "maple";
    case "numes":
      return "numes";
    case "tokenfactory":
      return "tokenfactory";
    // Full model IDs
    case "claude-sonnet-5-5":
    case "claude-sonnet-5":
    case "claude-opus-5-5":
    case "claude-opus-5":
    case "claude-opus-4-6":
    case "claude-haiku-4-5":
      return "anthropic";
    case "gemini-3.8-flash":
    case "gemini-3-pro-preview":
    case "gemini-2.0-flash":
      return "google";
    case "gpt-5":
    case "gpt-5.5":
    case "gpt-5.6-luna":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-4.1-mini":
      return "openai";
    default:
      // Any bare Grok model id (grok-4, grok-4-fast-non-reasoning,
      // grok-code-fast-1, ...) goes to xAI. OpenRouter-hosted Grok is
      // namespaced ("openrouter/x-ai/grok-4") and handled by the prefix
      // parse above, so this only catches direct-API ids.
      if (typeof modelName === "string" && modelName.toLowerCase().startsWith("grok")) {
        return "xai";
      }
      if (
        env.LLM_PROVIDER &&
        PROVIDERS.includes(env.LLM_PROVIDER as Provider)
      ) {
        return env.LLM_PROVIDER as Provider;
      }
      // Last resort before the anthropic default: the vendor's own id prefix.
      // A bare "gpt-5.6-sol" or "gemini-3.1-pro-preview" used to be sent to
      // anthropic and 404. Kept BELOW LLM_PROVIDER so a deployment that routes
      // bare ids through a gateway provider keeps doing so.
      if (typeof modelName === "string") {
        const m = modelName.toLowerCase();
        if (m.startsWith("gpt-")) return "openai";
        if (m.startsWith("gemini-")) return "google";
      }
      return "anthropic";
  }
}

/**
 * Treat blank/whitespace-only keys as absent.
 *
 * A truthy-but-blank key (a request body with `apiKey: " "`, an env var set to
 * an empty-ish value) otherwise sails past every `!!key` check and reaches the
 * provider SDK, which happily builds `Authorization: Bearer ` and gets a
 * confusing 401 ("Missing Authentication header" from OpenRouter) on every
 * single call instead of failing fast. Also trims stray whitespace so a key
 * pasted with a trailing space still authenticates.
 */
export function normalizeApiKey(key?: string | null): string | undefined {
  if (typeof key !== "string") return undefined;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The env var each provider's API key is read from. Exported so a host with
 * its own secret store knows which NAME to look up (see resolve.ts).
 */
export const API_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
  maple: "MAPLE_API_KEY",
  numes: "NUMES_API_KEY",
  tokenfactory: "TOKENFACTORY_API_KEY",
};

/**
 * A provider with an endpoint of its own, never the LLM gateway's (Maple's
 * proxy, which the deployment runs; Numes' API; Token Factory's gateway): the env var NAME its base
 * URL is read from — through the host's getSecret first, like the key
 * (resolve.ts) — and the URL when none is set. A caller's `baseUrl` wins
 * over both. The full URL, version path included.
 */
export const BASE_URL_ENV: Partial<Record<Provider, string>> = {
  maple: "MAPLE_BASE_URL",
  numes: "NUMES_BASE_URL",
  tokenfactory: "TOKENFACTORY_BASE_URL",
};
export const DEFAULT_BASE_URLS: Partial<Record<Provider, string>> = {
  maple: "http://localhost:8080/v1",
  numes: "https://api.numes.ai/api/v1",
  tokenfactory: "https://gateway.trytokenfactory.dev/v1",
};

/**
 * Settings that go with a provider's key: env var NAME → the header it is
 * sent as. Read from wherever the key was read (resolve.ts asks getSecret
 * first), and only when the key was: a caller that passes its own key brings
 * its own.
 *
 * ANTHROPIC_WORKSPACE_ID: a key made for the whole organization, not one
 * workspace, must name the workspace (`wrkspc_…`) its calls run in, or the
 * API answers 400. A workspace's own key needs none.
 */
export const KEY_HEADER_ENV: Partial<Record<Provider, Record<string, string>>> = {
  anthropic: { ANTHROPIC_WORKSPACE_ID: "anthropic-workspace-id" },
};

/** KEY_HEADER_ENV's headers for `provider`, each value from `lookup`; blanks are dropped. */
export function keyHeaders(
  provider: Provider | string,
  lookup: (envName: string) => string | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [envName, header] of Object.entries(KEY_HEADER_ENV[provider as Provider] ?? {})) {
    const value = normalizeApiKey(lookup(envName));
    if (value) out[header] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function lookupApiKeyForProvider(
  provider: Provider | string,
): string | undefined {
  if (provider === "claude_code") {
    return normalizeApiKey(env.CLAUDE_CODE_API_KEY);
  }
  if (!PROVIDERS.includes(provider as Provider)) return undefined;
  return normalizeApiKey(env[API_KEY_ENV[provider as Provider]]);
}

export function hasApiKeyForProvider(provider: Provider | string): boolean {
  return !!lookupApiKeyForProvider(provider);
}

export function getApiKeyForProvider(provider: Provider | string): string {
  const apiKey = lookupApiKeyForProvider(provider);
  if (!apiKey) {
    throw new Error(`API key not found for provider: ${provider}`);
  }
  return apiKey;
}

export interface GetModelOptions {
  apiKey?: string;
  /**
   * A gateway's root (Bifrost), for every provider: each rides its path
   * there (GATEWAY_PATHS). Maple, Numes, Token Factory and any provider aieo does not know
   * ride its OpenAI-compatible route with the model id `<provider>/<id>`.
   */
  baseUrl?: string;
  /**
   * A provider's OWN endpoint (BASE_URL_ENV: Maple's proxy, Numes' API,
   * Token Factory's gateway), the version path included (a bare root gets
   * it). Read from MAPLE_BASE_URL / NUMES_BASE_URL / TOKENFACTORY_BASE_URL
   * when absent. Ignored with a `baseUrl`: the call then goes
   * through that gateway.
   */
  endpoint?: string;
  modelName?: ModelName | string;
  cwd?: string;
  executablePath?: string;
  logger?: Logger;
  /**
   * Custom HTTP headers to attach to every request the provider client makes
   * to the LLM endpoint. Useful for gateway auth, tenant IDs, etc.
   */
  headers?: Record<string, string>;
  /**
   * AbortSignal from the run's AbortController. When fired (busy timeout /
   * `/repo/agent/abort`), in-flight model calls and streams are cancelled.
   * Stays armed for the entire request/stream lifetime.
   */
  abortSignal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds for the connect / first-response
   * phase only. Once the provider replies with headers the timer is disarmed,
   * so a slow-but-progressing stream is never killed. Defaults to the
   * `LLM_HTTP_TIMEOUT_MS` env var when not supplied.
   */
  timeoutMs?: number;
}

/**
 * Default first-response timeout: how long we wait for the provider to reply
 * with HTTP headers before giving up. The timer is disarmed once headers
 * arrive, so only the connect/stall phase is bounded — not the stream body.
 *
 * 5 min covers slow gateways and — crucially — non-streaming `generateText`
 * calls, where the provider sends nothing (headers included) until the whole
 * message is generated, so an adaptive-thinking call can legitimately need
 * minutes. Still well below the 2-hour busy watchdog. Ops can tune via
 * `LLM_HTTP_TIMEOUT_MS`.
 */
const DEFAULT_LLM_HTTP_TIMEOUT_MS =
  parseInt(env.LLM_HTTP_TIMEOUT_MS || "", 10) || 300_000;

/**
 * Extra attempts after a connect-phase timeout. The timeout aborts via an
 * AbortController, so the AI SDK sees a DOMException AbortError and treats it
 * as an intentional cancellation — its built-in 408/409/429/5xx retry ladder
 * never fires. Retrying here, inside the fetch wrapper, is safe because no
 * headers arrived (nothing was consumed) and the request body is a JSON
 * string. Set `LLM_HTTP_TIMEOUT_RETRIES=0` to disable.
 */
const LLM_HTTP_TIMEOUT_RETRIES = (() => {
  const parsed = parseInt(env.LLM_HTTP_TIMEOUT_RETRIES || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
})();

/**
 * Combine any number of AbortSignals (skipping null/undefined) without
 * requiring `AbortSignal.any` (Node ≥20.3). Returns a signal that aborts when
 * any input fires. Gracefully handles an already-aborted input.
 */
function combineSignals(
  signals: Array<AbortSignal | null | undefined>,
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  // Use native AbortSignal.any when available (Node ≥20.3).
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(live);
  }
  // Manual fallback for older Node 20.x runners.
  const ctrl = new AbortController();
  if (live.some((s) => s.aborted)) { ctrl.abort(); return ctrl.signal; }
  const abort = () => { try { ctrl.abort(); } catch (_) {} };
  for (const s of live) s.addEventListener("abort", abort, { once: true });
  return ctrl.signal;
}

/**
 * Build a `fetch`-compatible wrapper that:
 * 1. Gates the *connect / first-response* phase with a per-request timeout.
 * 2. Disarms the timeout once the provider replies with HTTP headers, so a
 *    slow-but-progressing stream body is never cut mid-flight.
 * 3. Keeps the caller's `runSignal` armed for the full request/stream so a
 *    genuine parent abort (busy timeout / `/repo/agent/abort`) still tears
 *    down an in-flight stream. The AI SDK's own per-request `init.signal`
 *    (from `streamText`/`generateText` abortSignal and internal teardown) is
 *    preserved by folding it into the combined signal rather than overwriting.
 * 4. Logs and re-throws on timeout (`ETIMEDOUT`) or abort (`AbortError`) with
 *    a clear reason string so callers can surface the right error to the agent.
 * 5. Retries pure connect-phase timeouts up to `LLM_HTTP_TIMEOUT_RETRIES`
 *    extra attempts — the AI SDK won't, because the timeout surfaces as an
 *    AbortError, which it treats as a deliberate cancellation. Genuine aborts
 *    (run signal / SDK signal) are never retried.
 *
 * @param timeoutMs  Milliseconds to wait for headers before aborting.
 * @param runSignal  The per-run AbortSignal (may be undefined).
 */
function buildTimeoutFetch(
  timeoutMs: number,
  runSignal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const sdkSignal = init?.signal;
    // A retry re-sends the request from scratch, which is only sound when the
    // body can be replayed: a plain-string body (the AI SDK always sends JSON
    // strings) via a string/URL input. A Request object's body stream may have
    // been consumed by the failed attempt.
    const canResend =
      (typeof input === "string" || input instanceof URL) &&
      (init?.body == null || typeof init.body === "string");
    const maxAttempts = canResend ? 1 + LLM_HTTP_TIMEOUT_RETRIES : 1;

    for (let attempt = 1; ; attempt++) {
      const startMs = Date.now();

      // ── timeout controller — only guards the connect/first-response phase ──
      const timeoutCtrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        timeoutCtrl.abort();
      }, timeoutMs);

      const clearTimer = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      };

      // Combine the per-request timeout signal, the run signal (if any), and
      // the AI SDK's own per-request signal (if any) — overwriting init.signal
      // would silently detach SDK-initiated cancellations from the socket.
      const combinedSignal = combineSignals([
        sdkSignal,
        runSignal,
        timeoutCtrl.signal,
      ]);

      try {
        const response = await fetch(input, { ...init, signal: combinedSignal });
        // Headers received — disarm the timeout so the streaming body is never killed by it.
        clearTimer();
        return response;
      } catch (err: any) {
        clearTimer();
        const elapsedMs = Date.now() - startMs;
        // Classify: the timeout timer fired, and neither the run signal nor the
        // SDK's own signal was the cause.
        const isTimeout =
          timeoutCtrl.signal.aborted && !runSignal?.aborted && !sdkSignal?.aborted;
        const reason = isTimeout ? "timeout" : "aborted";
        console.warn(
          `[llm-fetch] ${reason} after ${elapsedMs}ms (attempt ${attempt}/${maxAttempts}): ${url} — ${err?.message ?? String(err)}`,
        );
        if (isTimeout && attempt < maxAttempts) continue;
        throw err;
      }
    }
  };
}

function getModelForProvider(provider: Provider, modelName: ModelName): string {
  const model = MODELS[provider][modelName];
  if (!model) {
    throw new Error(
      `Model "${modelName}" is not available for provider "${provider}". ` +
        `Available models: ${Object.keys(MODELS[provider]).join(", ")}`
    );
  }
  return model;
}

interface ModelDetails {
  provider: Provider,
  apiKey: string,
  model: LanguageModel,
  modelId: string,
  contextLimit: number,
}
export function getModelDetails(
  modelName?: ModelName | string,
  apiKeyIn?: string,
  baseUrl?: string,
  headers?: Record<string, string>,
  abortSignal?: AbortSignal,
  timeoutMs?: number,
): ModelDetails {
  const provider = getProviderForModel(modelName);
  const callerKey = normalizeApiKey(apiKeyIn);
  const apiKey = callerKey || getApiKeyForProvider(provider);
  console.log("===> getModelDetails", {
    provider,
    modelName: modelName || "(default)",
    keySource: callerKey ? "request body" : "env var",
    apiKeyPrefix: apiKey ? apiKey.slice(0, 12) + "..." : "(missing)",
    baseUrl: baseUrl || "(default)",
    headerKeys: headers ? Object.keys(headers) : [],
    hasAbortSignal: !!abortSignal,
    timeoutMs: timeoutMs ?? DEFAULT_LLM_HTTP_TIMEOUT_MS,
  });
  const model = getModel(provider, {
    modelName,
    apiKey: callerKey,
    baseUrl,
    headers,
    abortSignal,
    timeoutMs,
  });
  // Resolve the actual modelId to look up context limit
  let modelId: string;
  if (modelName && modelName.includes("/")) {
    const parts = modelName.split("/");
    if (PROVIDERS.includes(parts[0] as Provider)) {
      modelId = parts.slice(1).join("/");
    } else {
      modelId = modelName;
    }
  } else if (modelName) {
    // Mirror getModel(): shortcuts (sonnet/opus/...) map through MODELS, but a
    // full model id (e.g. "claude-opus-4-8") must be used as-is. Looking it up
    // in MODELS returns undefined and would wrongly fall back to the default
    // model, corrupting context-limit and thinking-mode (adaptive vs enabled)
    // decisions downstream.
    const shortcut = MODELS[provider][modelName as ModelName];
    modelId = shortcut || modelName;
  } else {
    modelId = DEFAULT_MODELS[provider];
  }
  const contextLimit = getContextLimit(modelId, provider);
  return { model, provider, apiKey, contextLimit, modelId }
}

export function getModel(
  /** An aieo provider, or (through a gateway, `baseUrl`) any provider the
   *  gateway holds as an OpenAI-compatible one. */
  provider: Provider | string,
  opts?: string | GetModelOptions
): LanguageModel {
  if (typeof opts === "string") {
    opts = { apiKey: opts };
  }
  const callerKey = normalizeApiKey(opts?.apiKey);
  const apiKey = callerKey || getApiKeyForProvider(provider);

  // Handle slash format: extract modelId from "provider/model" or "provider/org/model"
  let modelId: string;
  if (opts?.modelName && opts.modelName.includes("/")) {
    const parts = opts.modelName.split("/");
    if (PROVIDERS.includes(parts[0] as Provider) || parts[0] === provider) {
      modelId = parts.slice(1).join("/");
    } else {
      modelId = opts.modelName;
    }
  } else if (opts?.modelName) {
    const knownShortcuts: string[] = [
      "sonnet",
      "opus",
      "haiku",
      "gemini",
      "gpt",
      "kimi",
      "glm",
      "grok",
      "maple",
      "numes",
      "tokenfactory",
    ];
    if (knownShortcuts.includes(opts.modelName) && PROVIDERS.includes(provider as Provider)) {
      modelId = getModelForProvider(provider as Provider, opts.modelName as ModelName);
    } else {
      modelId = opts.modelName;
    }
  } else if (PROVIDERS.includes(provider as Provider)) {
    modelId = DEFAULT_MODELS[provider as Provider];
  } else {
    throw new Error(`A model name is required for provider "${provider}"`);
  }

  if (opts?.logger) {
    opts.logger.info(
      `Getting model for provider: ${provider}, model: ${modelId}`
    );
  }
  // Explicit baseUrl from caller (a gateway's root) takes precedence over
  // the global LLM gateway. Normalize caller-supplied URLs so a bare gateway
  // root (e.g. the swarm host:port) gets the provider's drop-in path appended.
  // A provider with an endpoint of its own (Maple's proxy, Numes' API,
  // Token Factory's gateway) is called there unless a caller passed a gateway: the caller's `endpoint`,
  // else env (resolve.ts asks the host's getSecret first and passes it in).
  const routed = !!opts?.baseUrl;
  const ownBaseUrl = !routed && BASE_URL_ENV[provider as Provider]
    ? normalizeApiKey(opts?.endpoint) ?? normalizeApiKey(env[BASE_URL_ENV[provider as Provider]!]) ?? DEFAULT_BASE_URLS[provider as Provider]
    : undefined;
  const baseURL = opts?.baseUrl
    ? gatewayUrlFor(provider, opts.baseUrl)
    : ownBaseUrl
      ? withPath(ownBaseUrl, ENDPOINT_PATHS[provider as Provider]!)
      : getGatewayBaseURL(provider);
  if (baseURL) {
    const source = opts?.baseUrl ? "caller" : ownBaseUrl ? BASE_URL_ENV[provider as Provider] : "LLM_GATEWAY";
    console.log(`[${source}] routing ${provider} via ${baseURL}`);
  }
  // The key came from env, so its companion settings do too (KEY_HEADER_ENV).
  const merged = {
    ...(!callerKey && keyHeaders(provider, (name) => env[name])),
    ...opts?.headers,
  };
  const extraHeaders = Object.keys(merged).length > 0 ? merged : undefined;
  if (extraHeaders) {
    console.log(`[headers] attaching ${Object.keys(extraHeaders).length} custom header(s) to ${provider} client`);
  }

  // Build the timeout/abort-aware fetch wrapper. When neither abortSignal nor
  // timeoutMs is provided (e.g. callers that don't pass them), the default
  // LLM_HTTP_TIMEOUT_MS still applies so stalled connections are bounded.
  const timeoutFetch = buildTimeoutFetch(
    opts?.timeoutMs ?? DEFAULT_LLM_HTTP_TIMEOUT_MS,
    opts?.abortSignal,
  );

  switch (provider) {
    case "anthropic":
      const anthropic = createAnthropic({
        apiKey,
        ...(baseURL && { baseURL }),
        ...(extraHeaders && { headers: extraHeaders }),
        fetch: timeoutFetch,
      });
      return anthropic(modelId);
    case "google": {
      // Bifrost's native GenAI endpoint (/genai/v1beta) currently fails to
      // resolve provider keys ("no keys found that support model: ..."),
      // while its OpenAI-compatible endpoint (/openai/v1) serves the very
      // same Gemini keys correctly. So when routing Google through a gateway
      // (baseURL is present and suffixed with /genai/v1beta here), call the
      // OpenAI-compat endpoint with a `gemini/`-prefixed model id instead.
      // Direct (non-gateway) Google calls keep the native GenAI client.
      if (baseURL) {
        // Strip whatever provider suffix is present (/genai/v1beta normally,
        // but be resilient to /anthropic/v1, /openai/v1, etc.) to recover the
        // gateway root, then target the OpenAI-compat path.
        const root = baseURL.replace(/\/(anthropic|openai|genai)\/v\d+[a-z]*\/?$/i, "");
        const openaiCompatBase = `${root}/openai/v1`;
        console.log(
          `[gateway] routing google via OpenAI-compat ${openaiCompatBase} (model gemini/${modelId})`
        );
        const googleCompat = createOpenAI({
          apiKey,
          baseURL: openaiCompatBase,
          ...(extraHeaders && { headers: extraHeaders }),
          fetch: timeoutFetch,
        });
        return googleCompat.chat(`gemini/${modelId}`);
      }
      const google = createGoogleGenerativeAI({
        apiKey,
        ...(extraHeaders && { headers: extraHeaders }),
        fetch: timeoutFetch,
      });
      return google(modelId);
    }
    case "openai":
      const openai = createOpenAI({
        apiKey,
        ...(baseURL && { baseURL }),
        ...(extraHeaders && { headers: extraHeaders }),
        fetch: timeoutFetch,
      });
      return openai(modelId);
    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey,
        ...(baseURL && { baseURL }),
        ...(extraHeaders && { headers: extraHeaders }),
        fetch: timeoutFetch,
      });
      // Kimi models are served by many OpenRouter hosts (Fireworks, Together,
      // Chutes, ...) but only Moonshot's own endpoint has automatic prompt
      // caching (reads at 0.25x, writes free). Left unpinned, long agentic
      // runs get routed to non-caching hosts and re-pay the full conversation
      // on every step. Prefer Moonshot, keep fallbacks for availability.
      // usage.include surfaces cached-token counts in the response usage.
      const isMoonshot =
        modelId.startsWith("moonshotai/") ||
        modelId.toLowerCase().includes("kimi");
      const settings: OpenRouterChatSettings = {
        usage: { include: true },
        ...(isMoonshot
          ? { provider: { order: ["moonshotai"], allow_fallbacks: true } }
          : {}),
      };
      // Gatewayed OpenRouter rides the OpenAI-compat route
      // (GATEWAY_PATHS.openrouter is /openai/v1). Bifrost picks the upstream
      // provider from a known "<provider>/" prefix on the model id and
      // otherwise defaults to OpenAI on that route. OpenRouter ids carry
      // their own org prefix ("moonshotai/kimi-k2-0905"), which Bifrost
      // doesn't recognise, so the bare id we stripped above would be sent
      // to OpenAI and 404. Re-add the prefix for gateway calls, mirroring
      // the google and xai branches. Bifrost splits on the first "/" only,
      // so OpenRouter's own "openrouter/auto"-style ids survive the extra
      // hop. Direct calls keep the bare id.
      //
      // Bifrost's OpenAI-compat parser keeps only the fields it knows, so
      // the OpenRouter-only settings above (provider pinning, usage.include)
      // are dropped on the gateway path and only take effect on direct
      // calls.
      const gatewayModelId = baseURL ? `openrouter/${modelId}` : modelId;
      return openrouter(gatewayModelId, settings);
    }
    case "xai": {
      // Gatewayed Grok rides the OpenAI-compat route (GATEWAY_PATHS.xai is
      // /openai/v1) with an `xai/`-prefixed model id, mirroring the google
      // branch above. Direct calls use the official xAI provider, which maps
      // usage (incl. cached prompt tokens) and hits https://api.x.ai/v1.
      // Grok prompt caching is automatic prefix caching — nothing to set here;
      // just keep the request prefix byte-stable across steps.
      if (baseURL) {
        const xaiCompat = createOpenAI({
          apiKey,
          baseURL,
          ...(extraHeaders && { headers: extraHeaders }),
          fetch: timeoutFetch,
        });
        return xaiCompat.chat(`xai/${modelId}`);
      }
      const xai = createXai({
        apiKey,
        ...(extraHeaders && { headers: extraHeaders }),
        fetch: timeoutFetch,
      });
      return xai(modelId);
    }
    case "maple":
    case "numes":
    case "tokenfactory": {
      // Chat Completions (`.chat`): neither Maple's proxy, Numes nor Token
      // Factory speaks the Responses API, which is what `createOpenAI()(id)`
      // calls. The model's provider stays "openai.chat", so a host that
      // treats chat-completions models alike (strut moves tool-result images
      // beside the results) does the same here. Through a gateway (a caller's
      // baseUrl) the model id names the provider, as for xai: Bifrost picks
      // its custom provider of that name. A cost the response reports is put
      // back on the call's usage (withReportedCost).
      const costs = new Map<string, number>();
      const client = createOpenAI({
        apiKey,
        baseURL,
        ...(extraHeaders && { headers: extraHeaders }),
        fetch: reportedCostFetch(provider === "maple" ? mapleFetch(timeoutFetch) : timeoutFetch, costs),
      });
      return withReportedCost(client.chat(routed ? `${provider}/${modelId}` : modelId), costs);
    }
    // case "claude_code":
    //   try {
    //     const customProvider = createClaudeCode({
    //       defaultSettings: {
    //         pathToClaudeCodeExecutable: executablePath,
    //         // Skip permission prompts for all operations
    //         permissionMode: "bypassPermissions",
    //         // Set working directory for file operations
    //         cwd: cwd,
    //       },
    //     });
    //     if (cwd) {
    //       console.log("creating claude code model at", cwd);
    //     }
    //     return customProvider(SOTA[provider]);
    //   } catch (error) {
    //     console.error("Failed to create Claude Code provider:", error);
    //     throw new Error(
    //       "Claude Code CLI not available or not properly installed. Make sure Claude Code is installed and accessible in the environment where this code runs."
    //     );
    //   }
    default:
      // A provider aieo does not know (`acme/llama-4`): an OpenAI-compatible
      // one a gateway holds under that name. Only a gateway reaches it.
      if (baseURL) {
        const compat = createOpenAI({
          apiKey,
          baseURL,
          ...(extraHeaders && { headers: extraHeaders }),
          fetch: timeoutFetch,
        });
        return compat.chat(`${provider}/${modelId}`);
      }
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

// Context window sizes (input token limits) per model.
// For models not listed here, falls back to provider default.
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic — 1M is the default and the max on the 5-series; Haiku 4.5 is 200k.
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // Google — Gemini's "1M" is 2^20.
  "gemini-3.8-flash": 1_048_576,
  "gemini-3-pro-preview": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  // OpenAI — 5.4+ is 1,050,000; the 4.1 family is 1,047,576; 5 through 5.3 are 400k.
  "gpt-5": 400_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-4.1-mini": 1_047_576,
  // OpenRouter — values from the OpenRouter model catalog
  // (https://openrouter.ai/api/v1/models, context_length).
  "stealth/ox-alpha": 1_048_576,
  "anthropic/claude-opus-5.5": 1_000_000,
  "anthropic/claude-opus-5": 1_000_000,
  "anthropic/claude-sonnet-5.5": 1_000_000,
  "anthropic/claude-sonnet-5": 1_000_000,
  "openai/gpt-5": 400_000,
  "openai/gpt-5.5": 1_050_000,
  "openai/gpt-5.6-terra": 1_050_000,
  "openai/gpt-5.6-luna": 1_050_000,
  "openai/gpt-5.6-sol": 1_050_000,
  "moonshotai/kimi-k3": 1_048_576,
  // Z.ai via OpenRouter. "~…-latest" is OpenRouter's rolling-alias form.
  "~z-ai/glm-flash-latest": 1_310_720,
  "z-ai/glm-5.3-flash": 1_310_720,
  "z-ai/glm-5.3": 1_310_720,
  "moonshotai/kimi-k2.7-code": 262_144,
  "moonshotai/kimi-k2.6": 262_144,
  "moonshotai/kimi-k2.5": 262_144,
  "moonshotai/kimi-k2-thinking": 262_144,
  "moonshotai/kimi-k2": 131_072,
  // xAI (and the same models via OpenRouter as x-ai/...). Getting these
  // right matters beyond display: contextLimit drives truncateOldToolResults,
  // and premature truncation rewrites old messages — which invalidates Grok's
  // automatic prefix cache on every subsequent step.
  "grok-4.7": 500_000,
  "grok-4.6": 500_000,
  "grok-4.5": 500_000,
  "grok-4.3": 1_000_000,
  "grok-4": 256_000,
  "grok-4-fast": 2_000_000,
  "grok-4-fast-reasoning": 2_000_000,
  "grok-4-fast-non-reasoning": 2_000_000,
  "grok-code-fast-1": 256_000,
  "x-ai/grok-4.7": 500_000,
  "x-ai/grok-4.6": 500_000,
  "x-ai/grok-4.5": 500_000,
  "x-ai/grok-4.3": 1_000_000,
  "x-ai/grok-4": 256_000,
  "x-ai/grok-4-fast": 2_000_000,
  "x-ai/grok-code-fast-1": 256_000,
};

const DEFAULT_CONTEXT_LIMITS: Record<Provider, number> = {
  anthropic: 1_000_000,
  google: 1_000_000,
  // gpt-5.x models are all 400k+; only legacy chat models are smaller
  openai: 400_000,
  openrouter: 256_000,
  xai: 256_000,
  // An unlisted Maple model: its smallest window.
  maple: 131_072,
  // An unlisted Numes model: the common small window of its catalogue.
  numes: 131_072,
  // An unlisted Token Factory model: its smallest listed (qwen3.8-27b).
  tokenfactory: 196_608,
};

// Conservative fallback if both model and provider lookups miss
const FALLBACK_CONTEXT_LIMIT = 128_000;

/**
 * Get the context window size (max input tokens) for a given model: Maple's,
 * Numes' or Token Factory's table, else the datasheet (`loadModelCatalog`), else this file's.
 */
export function getContextLimit(modelId: string, provider: Provider): number {
  if (provider === "maple") return MAPLE_MODELS[modelId]?.context ?? DEFAULT_CONTEXT_LIMITS.maple;
  if (provider === "numes") return NUMES_MODELS[modelId]?.context ?? DEFAULT_CONTEXT_LIMITS.numes;
  if (provider === "tokenfactory") return TOKENFACTORY_MODELS[modelId]?.context ?? DEFAULT_CONTEXT_LIMITS.tokenfactory;
  return (
    getCatalogEntry(provider, modelId)?.maxInputTokens ??
    MODEL_CONTEXT_LIMITS[modelId] ??
    DEFAULT_CONTEXT_LIMITS[provider] ??
    FALLBACK_CONTEXT_LIMIT
  );
}

const TOKEN_PRICING: Record<Provider, TokenPricing> = {
  anthropic: {
    inputTokenPrice: 3.0,
    outputTokenPrice: 15.0,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  },
  google: {
    inputTokenPrice: 1.25,
    outputTokenPrice: 5.0,
  },
  openai: {
    inputTokenPrice: 2.5,
    outputTokenPrice: 10.0,
  },
  openrouter: {
    inputTokenPrice: 0.6,
    outputTokenPrice: 3.0,
  },
  // grok-4 rates. cacheReadPrice matters: computeSessionCost bills cache
  // reads at full input price when it's absent, and Grok discounts cached
  // prompt tokens 4x. (Grok has no cache-write charge — writes are billed
  // as ordinary input, so no cacheWritePrice here.)
  xai: {
    inputTokenPrice: 3.0,
    outputTokenPrice: 15.0,
    cacheReadPrice: 0.75,
  },
  // An unlisted Maple model (MAPLE_MODELS has the listed ones): the dearest
  // listed rate (kimi-k3), so a cost is never under-reported.
  maple: {
    inputTokenPrice: 8.0,
    outputTokenPrice: 25.0,
  },
  // A Numes model neither listed free (NUMES_MODELS) nor priced by OpenRouter's
  // rates: the dearest in Numes' catalogue (openai/gpt-6-astra, 2026-11-04),
  // so a cost is never under-reported.
  numes: {
    inputTokenPrice: 12.28,
    outputTokenPrice: 61.36,
  },
  // An unlisted Token Factory model: the dearest listed rate
  // (nemotron-3-ultra), so a cost is never under-reported.
  tokenfactory: {
    inputTokenPrice: 0.6,
    outputTokenPrice: 2.4,
  },
};

export function getTokenPricing(provider: Provider): TokenPricing {
  return TOKEN_PRICING[provider];
}

// ── The model catalog: prices and limits as data ────────────────────────────
//
// bifrost's datasheet — the file the LLM gateway prices every call from
// (stakgraph gateway/internal/pricing) and bifrost prices its logs from —
// keyed by model as bifrost names it ("claude-sonnet-5-5",
// "gemini/gemini-3.8-flash", "openrouter/moonshotai/kimi-k3"), each with its
// per-token prices and input and output limits. `loadModelCatalog` loads it;
// until then, and for a model it does not hold, the tables in this file
// answer. Maple's and Numes' own tables answer before it (the gateway's
// runtime price rows do the same there): the key rule's last-segment form
// would otherwise price a free Numes model, or an unlisted Maple one, at
// another vendor's rate.

export const MODEL_CATALOG_URL = "https://getbifrost.ai/datasheet";

export interface CatalogEntry {
  pricing?: TokenPricing;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

let catalog: Map<string, CatalogEntry> | undefined;
let catalogTimer: ReturnType<typeof setInterval> | undefined;

/** bifrost's provider name for each of aieo's. Maple and Token Factory have
 *  none: their models are priced by their own tables only. A Numes model is looked up as the OpenRouter
 *  slug it is, as its unlisted models were priced before. */
const CATALOG_PROVIDER: Partial<Record<Provider, string>> = {
  anthropic: "anthropic",
  google: "gemini",
  openai: "openai",
  openrouter: "openrouter",
  xai: "xai",
  numes: "openrouter",
};

// Per token → per million, rounded to 12 significant digits so 1e-7 is 0.1,
// not 0.09999999999999999.
const perMillion = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Number((v * 1_000_000).toPrecision(12)) : undefined;
const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

/** The datasheet's JSON → entries. Throws when nothing in it is priced. */
export function parseModelCatalog(raw: string): Map<string, CatalogEntry> {
  const sheet = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const out = new Map<string, CatalogEntry>();
  let priced = 0;
  for (const [key, row] of Object.entries(sheet ?? {})) {
    if (!row || typeof row !== "object") continue;
    const input = perMillion(row.input_cost_per_token);
    const output = perMillion(row.output_cost_per_token);
    const entry: CatalogEntry = {};
    if (input !== undefined && output !== undefined) {
      const cacheRead = perMillion(row.cache_read_input_token_cost);
      const cacheWrite = perMillion(row.cache_creation_input_token_cost);
      entry.pricing = {
        inputTokenPrice: input,
        outputTokenPrice: output,
        ...(cacheRead ? { cacheReadPrice: cacheRead } : {}),
        ...(cacheWrite ? { cacheWritePrice: cacheWrite } : {}),
      };
      priced++;
    }
    const maxIn = positive(row.max_input_tokens);
    const maxOut = positive(row.max_output_tokens);
    if (maxIn) entry.maxInputTokens = maxIn;
    if (maxOut) entry.maxOutputTokens = maxOut;
    if (entry.pricing || maxIn || maxOut) out.set(key, entry);
  }
  if (!priced) throw new Error("the model catalog prices no model");
  return out;
}

/** Use these entries from now on (`undefined`: none). A host that has the
 *  sheet already, and tests, set it here; `loadModelCatalog` does it too. */
export function setModelCatalog(next: Map<string, CatalogEntry> | undefined): void {
  catalog = next;
}

/** The gateway's key rule (`pricing.Keys`): the model as given, then
 *  "<provider>/<model>", then the name after its last "/". */
function catalogKeys(provider: string, model: string): string[] {
  const keys = [model];
  if (!model.startsWith(`${provider}/`)) keys.push(`${provider}/${model}`);
  const i = model.lastIndexOf("/");
  if (i >= 0 && i + 1 < model.length) keys.push(model.slice(i + 1));
  return keys;
}

/** The datasheet's entry for a model: undefined when no catalog is loaded,
 *  the provider is Maple, or the sheet does not hold the model. */
export function getCatalogEntry(provider: Provider, modelId: string): CatalogEntry | undefined {
  const name = CATALOG_PROVIDER[provider];
  if (!catalog || !name || !modelId) return undefined;
  for (const key of catalogKeys(name, modelId)) {
    const entry = catalog.get(key);
    if (entry) return entry;
  }
  return undefined;
}

/** A model's own price per million tokens: Maple's, Numes' or Token Factory's table, then the
 *  datasheet. Undefined when neither knows it — never the provider's flat
 *  rate, which `computeSessionCost` falls back to. */
export function getModelPrice(provider: Provider, modelId: string): TokenPricing | undefined {
  if (provider === "maple") return MAPLE_MODELS[modelId]?.pricing;
  if (provider === "numes") return NUMES_MODELS[modelId]?.pricing ?? getCatalogEntry(provider, modelId)?.pricing;
  if (provider === "tokenfactory") return TOKENFACTORY_MODELS[modelId]?.pricing;
  return getCatalogEntry(provider, modelId)?.pricing;
}

export interface LoadModelCatalogOptions {
  /** Where the last good sheet is kept: read at once (a restart prices from
   *  it before the first fetch), written after each fetch. Omit: memory only. */
  cachePath?: string;
  /** Default `MODEL_CATALOG_URL`. */
  url?: string;
  /** How often to fetch it again; default 24 h (the gateway's cadence), 0 never. */
  refreshMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/** Load bifrost's datasheet: the copy at `cachePath` first, then a fetch,
 *  then a fetch every `refreshMs`. A fetch that fails keeps the last good
 *  sheet and says so; it never throws. Resolves once the first fetch is done
 *  with what is in use: how many models, and where they came from. */
export async function loadModelCatalog(
  opts: LoadModelCatalogOptions = {},
): Promise<{ models: number; source: "fetch" | "cache" | "none" }> {
  const { readFile, writeFile, rename, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const url = opts.url ?? MODEL_CATALOG_URL;
  const get = opts.fetch ?? fetch;
  let source: "fetch" | "cache" | "none" = catalog ? "cache" : "none";
  if (opts.cachePath) {
    try {
      catalog = parseModelCatalog(await readFile(opts.cachePath, "utf8"));
      source = "cache";
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`[aieo] model catalog at ${opts.cachePath} unreadable (${err?.message ?? err}); waiting for a fetch`);
    }
  }
  const fetchOnce = async (): Promise<boolean> => {
    try {
      const res = await get(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.text();
      catalog = parseModelCatalog(raw);
      if (opts.cachePath) {
        const tmp = `${opts.cachePath}.tmp`;
        await mkdir(dirname(opts.cachePath), { recursive: true });
        await writeFile(tmp, raw);
        await rename(tmp, opts.cachePath);
      }
      return true;
    } catch (err: any) {
      console.warn(`[aieo] model catalog fetch from ${url} failed (${err?.message ?? err}); ${catalog ? "keeping the last good one" : "using aieo's own tables"}`);
      return false;
    }
  };
  if (await fetchOnce()) source = "fetch";
  const every = opts.refreshMs ?? 24 * 60 * 60 * 1000;
  if (catalogTimer) clearInterval(catalogTimer);
  catalogTimer = undefined;
  if (every > 0) {
    catalogTimer = setInterval(() => void fetchOnce(), every);
    catalogTimer.unref?.();
  }
  return { models: catalog?.size ?? 0, source: catalog ? source : "none" };
}

/** The datasheet with no saved copy — kept so an older caller (mcp's boot)
 *  works. It loaded OpenRouter's price list before the datasheet held it. */
export async function loadModelPricing(): Promise<void> {
  await loadModelCatalog();
}

export type ThinkingSpeed = "thinking" | "fast";

// Anthropic models that do NOT support `adaptive` thinking. Adaptive is only
// available on certain Sonnet/Opus tiers; Haiku and older models reject it
// with `invalid_request_error: adaptive thinking is not supported on this model`.
function anthropicSupportsAdaptiveThinking(modelName?: string): boolean {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  // Haiku and the Claude 3.x names (claude-3-5-sonnet-..., claude-3-7-sonnet-latest)
  // have no adaptive mode and reject `effort`.
  if (m.includes("haiku") || /claude-3[-.]/.test(m)) return false;
  if (m.includes("fable") || m.includes("mythos")) return true;
  if (!(m.includes("sonnet") || m.includes("opus"))) return false;
  // Adaptive thinking arrived with the 4.6 generation; 4.5 and older take
  // enabled/disabled and reject `effort`. A family name without a version
  // ("opus", "sonnet") is the current default, which is modern.
  const v = /(?:sonnet|opus)-(\d+)(?:-(\d+))?(?!\d)/.exec(m);
  if (!v) return true;
  const major = Number(v[1]);
  const minor = v[2] == null ? 0 : Number(v[2]);
  return major >= 5 || (major === 4 && minor >= 6);
}

// Anthropic models where thinking cannot be turned off (Opus 5.5, Sonnet 5.5,
// the Fable line): `{ type: "disabled" }` is rejected with a 400 at every
// effort level.
function anthropicRejectsDisabledThinking(modelName?: string): boolean {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  return m.includes("opus-5-5") || m.includes("sonnet-5-5") || m.includes("fable");
}

// The model id getModel() builds for this name: no name is the provider
// default, an alias ("sonnet") maps through MODELS. The thinking rules above
// are per model id, so they must see what is actually called.
function anthropicModelId(modelName?: string): string {
  if (!modelName) return DEFAULT_MODELS.anthropic;
  return MODELS.anthropic[modelName as ModelName] ?? modelName;
}

export function getProviderOptions(
  provider: Provider,
  thinkingSpeed?: ThinkingSpeed,
  modelName?: string
) {
  const fast = thinkingSpeed === "fast";
  const explicitThinking = thinkingSpeed === "thinking";
  // Budget only applies when thinking is explicitly enabled.
  // For Google we still need a numeric value; use 0 for fast, otherwise let it think.
  const googleBudget = fast ? 0 : 24000;
  switch (provider) {
    case "anthropic":
      modelName = anthropicModelId(modelName);
      let thinking: AnthropicProviderOptions["thinking"];
      if (fast && anthropicRejectsDisabledThinking(modelName)) {
        // Thinking is always on here: `disabled` is a 400, effort is the only dial.
        return {
          anthropic: {
            effort: "low",
            cacheControl: { type: "ephemeral" },
          } as AnthropicProviderOptions,
        };
      }
      if (fast) {
        // Fast means no thinking, on every model that still allows it (Opus 5,
        // Sonnet 5, the 4.x line, Haiku). Only the models that reject
        // `disabled` outright take the effort-only branch above, which is why
        // every fast call site that picked its own model passes its name.
        thinking = { type: "disabled" };
        return {
          anthropic: {
            thinking,
            cacheControl: { type: "ephemeral" },
          } satisfies AnthropicProviderOptions,
        };
      }

      if (anthropicSupportsAdaptiveThinking(modelName)) {
        // Modern models (Sonnet 4.6+, Opus 4.6+, 4.7, 4.8) require adaptive.
        // type: "enabled" is deprecated and rejected by these models with a 400.
        // `effort` is optional (omitting it == "high"); only set it when thinking
        // is explicitly requested.
        return {
          anthropic: {
            thinking: { type: "adaptive", display: "summarized" },
            ...(explicitThinking && { effort: "high" }),
            cacheControl: { type: "ephemeral" },
          } as AnthropicProviderOptions,
        };
      }

      // Older models (Haiku, Claude 3.x): use enabled if explicitly requested.
      thinking = explicitThinking
        ? { type: "enabled", budgetTokens: 24000 }
        : { type: "disabled" };
      return {
        anthropic: {
          thinking,
          cacheControl: { type: "ephemeral" },
        } satisfies AnthropicProviderOptions,
      };
    case "google":
      return {
        google: {
          thinkingConfig: { thinkingBudget: googleBudget },
        } satisfies GoogleGenerativeAIProviderOptions,
      };
    case "openai":
      return {
        openai: {} satisfies OpenAIResponsesProviderOptions,
      };
    case "openrouter":
      return {
        openrouter: { usage: { include: true } } satisfies OpenRouterChatSettings,
      };
    case "xai":
      // Grok prompt caching is automatic (prefix-based, no breakpoints), so
      // there is no cacheControl analog to send.
      return {
        xai: {},
      };
    case "maple": {
      // The chat-completions client reads its options under `openai`. Fast
      // is no thinking where the model allows it (gpt-oss and GLM think
      // always: their lowest effort), thinking is high; otherwise the
      // model's default (gemma4: none).
      if (!thinkingSpeed) return { openai: {} satisfies OpenAIResponsesProviderOptions };
      const name = modelName?.startsWith("maple/") ? modelName.slice("maple/".length) : modelName;
      const modelId = !name || name === "maple" ? DEFAULT_MODELS.maple : name;
      return {
        openai: { reasoningEffort: mapleReasoningEffort(modelId, fast ? "none" : "high") },
      };
    }
    case "numes":
      // Under `openai`, as for Maple. Numes maps an effort to what the model
      // serving the call takes, so none and high are sent as they are.
      if (!thinkingSpeed) return { openai: {} satisfies OpenAIResponsesProviderOptions };
      return { openai: { reasoningEffort: fast ? "none" : "high" } };
    case "tokenfactory":
      // Under `openai`, as for Numes. Every model takes any effort, so none
      // and high are sent as they are; a model that always thinks (GLM,
      // MiniMax) still does when sent none.
      if (!thinkingSpeed) return { openai: {} satisfies OpenAIResponsesProviderOptions };
      return { openai: { reasoningEffort: fast ? "none" : "high" } };
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

export interface LLMConfig {
  provider: Provider;
  apiKey: string;
  model: LanguageModel;
  modelName?: string;
}

/**
 * Resolve LLM configuration from request params with env fallback.
 * Priority: request body/query → env vars → defaults.
 * Use `light: true` for batch/cheap operations (descriptions, learnings, etc.)
 */
export function resolveLLMConfig(opts?: {
  model?: string;
  apiKey?: string;
  provider?: string;
  light?: boolean;
}): LLMConfig {
  let modelName = opts?.model;
  let providerHint = opts?.provider;
  if (providerHint && !PROVIDERS.includes(providerHint as Provider)) {
    modelName = modelName || providerHint;
    providerHint = undefined;
  }

  const provider = modelName
    ? getProviderForModel(modelName)
    : (providerHint as Provider | undefined) ||
      (env.LLM_PROVIDER as Provider | undefined) ||
      getProviderForModel();

  const callerKey = normalizeApiKey(opts?.apiKey);
  const apiKey = callerKey || getApiKeyForProvider(provider);

  console.log(
    `[resolveLLMConfig] provider=${provider} modelName=${modelName || "(default)"} light=${!!opts?.light} keySource=${callerKey ? "request body" : "env var"} apiKeyPrefix=${apiKey.slice(0, 8)}...`,
  );

  let effectiveModelName = modelName;
  if (!effectiveModelName && opts?.light) {
    effectiveModelName = getLightModelForProvider(provider);
  }

  const model = getModel(provider, {
    apiKey: callerKey,
    modelName: effectiveModelName,
  });

  return { provider, apiKey, model, modelName: effectiveModelName };
}
