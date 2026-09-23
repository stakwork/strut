// ── LLM token usage ──────────────────────────────────────────────────────────
//
// Normalizes the Vercel AI SDK's usage object into a flat, addable
// { input, cacheRead, cacheWrite, output } token count, shared by the LLM
// steps (the core `agent` step, plus the lab's eval/reflect + gitsee steps).
//
// PRICING IS NOT HERE. aieo owns the price table and the per-provider output
// cap (`getTokenPricing` / `computeSessionCost` in its provider.ts,
// `maxOutputTokensFor` in its resolve.ts); `usageForCost` below is the shape
// adapter into `computeSessionCost`. aieo stays lazy-loaded (it pulls every
// provider SDK), so this module imports only a TYPE from it.

import type { TokenUsageForCost } from "aieo";

/** Normalized, provider-agnostic token counts (flat, addable across calls). */
export interface TokenUsage {
  inputTokens: number; // non-cached input (billed at full input price)
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 };
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

  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens };
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

/** Sum two normalized usages (e.g. across multiple LLM calls in one run). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
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
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens) || num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens) + num(u.outputTokens),
  };
}

/** The shape aieo's `computeSessionCost(provider, usage, modelId?)` prices —
 *  `computeSessionCost(provider, usageForCost(u))` is the whole cost calc. */
export function usageForCost(u: TokenUsage): TokenUsageForCost {
  return {
    input: u.inputTokens,
    cache_read: u.cacheReadTokens,
    cache_write: u.cacheWriteTokens,
    output: u.outputTokens,
  };
}
