// ── LLM token usage ──────────────────────────────────────────────────────────
//
// Normalizes the Vercel AI SDK's usage object into a flat, addable
// { input, cacheRead, cacheWrite, output } token count, shared by the LLM
// steps (the core `agent` step, plus the lab's eval/reflect + gitsee steps).
//
// PRICING IS NOT HERE (an unpriced model costs 0, see aieo's modelPriceSource). aieo owns the price table and the per-provider output
// cap (`getTokenPricing` / `computeSessionCost` in its provider.ts,
// `maxOutputTokensFor` in its resolve.ts); `usageForCost` below is the shape
// adapter into `computeSessionCost`. aieo stays lazy-loaded (it pulls every
// provider SDK), so this module imports only a TYPE from it.

import type { TokenUsageForCost } from "./aieo/index.js";

/** Normalized, provider-agnostic token counts (flat, addable across calls). */
export interface TokenUsage {
  inputTokens: number; // non-cached input (billed at full input price)
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of cacheWriteTokens written with the 1-hour TTL (a SUBSET, priced
   *  at the 1h rate). Absent / 0: all writes are 5-minute ones. */
  cacheWrite1hTokens?: number;
  outputTokens: number;
  totalTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, totalTokens: 0 };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Normalize a Vercel AI SDK `LanguageModelUsage` into a flat {@link TokenUsage}.
 * Prefers the `inputTokenDetails` breakdown (noCache / cacheRead / cacheWrite);
 * falls back to the flat `inputTokens` + pre-v7 `cachedInputTokens` when
 * details are absent, treating the remainder as non-cached input.
 *
 * When the SDK reports no cache activity, the provider's own usage is searched
 * too (see {@link rawCacheTokens}) — pass a STEP's usage and
 * `providerMetadata` for that: only per-step usage keeps `raw`, a run's total
 * (`result.usage`) drops it. Use {@link usageFromSteps} for a whole run.
 */
export function usageFromResult(usage: unknown, providerMetadata?: unknown): TokenUsage {
  if (!usage || typeof usage !== "object") return emptyUsage();
  const u = usage as Record<string, any>;
  const details = (u.inputTokenDetails ?? {}) as Record<string, any>;

  let cacheReadTokens = num(details.cacheReadTokens ?? u.cachedInputTokens);
  let cacheWriteTokens = num(details.cacheWriteTokens);
  // Anthropic's split of the writes by TTL, when its usage carries one.
  const cacheWrite1hTokens = rawCacheWrite1h(u.raw, providerMetadata);
  // Non-cached input: the detailed noCacheTokens when present, else the flat
  // total input minus what we already accounted as cache read/write.
  let inputTokens =
    details.noCacheTokens != null
      ? num(details.noCacheTokens)
      : Math.max(0, num(u.inputTokens) - cacheReadTokens - cacheWriteTokens);

  if (!cacheReadTokens && !cacheWriteTokens) {
    const found = rawCacheTokens(u.raw, providerMetadata);
    if (found.read || found.write) {
      cacheReadTokens = found.read;
      cacheWriteTokens = found.write;
      // OpenAI convention: the prompt total INCLUDES the cached part. A total
      // smaller than the cache counts can only be Anthropic's (cache excluded).
      const total = num(u.inputTokens);
      const rest = total - cacheReadTokens - cacheWriteTokens;
      inputTokens = rest >= 0 ? rest : total;
    }
  }

  const outputTokens = num(u.outputTokens);
  const totalTokens =
    num(u.totalTokens) || inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;

  return { inputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens: Math.min(cacheWrite1hTokens, cacheWriteTokens), outputTokens, totalTokens };
}

/** Sum per-step usage over a run's `steps` — the accurate way to total a run
 *  (each step keeps its raw provider usage; the run's `usage` does not). */
export function usageFromSteps(steps: unknown): TokenUsage {
  let total = emptyUsage();
  for (const s of Array.isArray(steps) ? steps : []) {
    total = addUsage(total, usageFromResult(s?.usage, s?.providerMetadata));
  }
  return total;
}

// Where a provider (or a gateway re-rendering it) puts cache counts in its raw
// usage. The SDK's OpenAI-compatible parsers read only the first of each list,
// and the names drift between OpenRouter direct and Bifrost — so every
// spelling seen is tried, first positive wins.
const RAW_CACHE_READ = [
  "prompt_tokens_details.cached_tokens",
  "prompt_tokens_details.cache_read_tokens",
  "prompt_tokens_details.cached_read_tokens",
  "prompt_tokens_details.cache_read_input_tokens",
  "input_tokens_details.cached_tokens",
  "cache_read_input_tokens",
  "cache_read_tokens",
  "cached_tokens",
];
const RAW_CACHE_WRITE = [
  "prompt_tokens_details.cache_write_tokens",
  "prompt_tokens_details.cached_write_tokens",
  "prompt_tokens_details.cache_creation_tokens",
  "prompt_tokens_details.cache_creation_input_tokens",
  "input_tokens_details.cache_write_tokens",
  "cache_creation_input_tokens",
  "cache_write_tokens",
];
// OpenRouter's provider also copies the read count into its metadata (older
// provider versions kept it ONLY there).
const META_CACHE_READ = ["openrouter.usage.promptTokensDetails.cachedTokens"];

function at(obj: unknown, path: string): number {
  let v: any = obj;
  for (const k of path.split(".")) v = v && typeof v === "object" ? v[k] : undefined;
  return num(v);
}
const firstPositive = (obj: unknown, paths: string[]): number => {
  for (const p of paths) {
    const n = at(obj, p);
    if (n > 0) return n;
  }
  return 0;
};

/** Cache counts from a provider's raw usage, then its metadata — whatever the
 *  field is called. Zeros when nothing is found. */
export function rawCacheTokens(raw: unknown, providerMetadata?: unknown): { read: number; write: number } {
  return {
    read: firstPositive(raw, RAW_CACHE_READ) || firstPositive(providerMetadata, META_CACHE_READ),
    write: firstPositive(raw, RAW_CACHE_WRITE),
  };
}

// Anthropic's raw usage (also providerMetadata.anthropic.usage, the same
// object) splits writes: cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens.
// @ai-sdk/anthropic's schema is a looseObject, so the field survives in `raw`.
const RAW_CACHE_WRITE_1H = ["cache_creation.ephemeral_1h_input_tokens", "anthropic.usage.cache_creation.ephemeral_1h_input_tokens"];
const RAW_CACHE_WRITE_5M = ["cache_creation.ephemeral_5m_input_tokens", "anthropic.usage.cache_creation.ephemeral_5m_input_tokens"];

/** The 1-hour cache-write tokens in a provider's raw usage / metadata (0: none). */
export function rawCacheWrite1h(raw: unknown, providerMetadata?: unknown): number {
  return firstPositive(raw, RAW_CACHE_WRITE_1H) || firstPositive(providerMetadata, RAW_CACHE_WRITE_1H.slice(1));
}

/** Whether the raw usage carries a 5m/1h breakdown of the cache writes at all. */
export function hasCacheWriteSplit(raw: unknown, providerMetadata?: unknown): boolean {
  const has = (o: unknown, p: string) => {
    let v: any = o;
    for (const k of p.split(".")) v = v && typeof v === "object" ? v[k] : undefined;
    return typeof v === "number";
  };
  return [...RAW_CACHE_WRITE_1H, ...RAW_CACHE_WRITE_5M].some((p) => has(raw, p) || has(providerMetadata, p));
}

/** Sum two normalized usages (e.g. across multiple LLM calls in one run). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0),
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Coerce an unknown (e.g. a usage object threaded through a workflow template)
 *  back into a {@link TokenUsage} so it can be safely summed. */
export function coerceUsage(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== "object") return emptyUsage();
  const u = usage as Record<string, any>;
  return {
    inputTokens: num(u.inputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    cacheWrite1hTokens: num(u.cacheWrite1hTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens) || num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens) + num(u.outputTokens),
  };
}

/** The dollars a provider reported for ONE model call, when it reports them:
 *  the step's raw usage `cost` — Numes' and Token Factory's, which aieo's
 *  chat client puts there (`withReportedCost`: @ai-sdk/openai's own usage
 *  schema drops it) — or OpenRouter's, which its provider lifts into
 *  `providerMetadata.openrouter.usage.cost`. Only a step's usage keeps `raw`,
 *  so pass a step's `usage` and `providerMetadata`. Undefined: none reported
 *  — price the tokens instead (aieo's `computeSessionCost`). */
export function reportedCost(usage: unknown, providerMetadata?: unknown): number | undefined {
  const fromRaw = (usage as { raw?: { cost?: unknown } } | undefined)?.raw?.cost;
  const fromMeta = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  for (const v of [fromRaw, fromMeta]) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/** The shape aieo's `computeSessionCost(provider, usage, modelId?)` prices —
 *  `computeSessionCost(provider, usageForCost(u))` is the whole cost calc. */
export function usageForCost(u: TokenUsage): TokenUsageForCost {
  return {
    input: u.inputTokens,
    cache_read: u.cacheReadTokens,
    cache_write: u.cacheWriteTokens,
    ...(u.cacheWrite1hTokens ? { cache_write_1h: u.cacheWrite1hTokens } : {}),
    output: u.outputTokens,
  };
}
