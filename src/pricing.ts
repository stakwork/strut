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
 * Normalize a Vercel AI SDK `LanguageModelUsage` (the `.usage` / `.totalUsage`
 * on a generate result) into a flat {@link TokenUsage}. Prefers the v6
 * `inputTokenDetails` breakdown (noCache / cacheRead / cacheWrite); falls back
 * to the flat `inputTokens` + deprecated `cachedInputTokens` when details are
 * absent (other providers), treating the remainder as non-cached input.
 */
export function usageFromResult(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== "object") return emptyUsage();
  const u = usage as Record<string, any>;
  const details = (u.inputTokenDetails ?? {}) as Record<string, any>;

  const cacheReadTokens = num(details.cacheReadTokens ?? u.cachedInputTokens);
  const cacheWriteTokens = num(details.cacheWriteTokens);
  // Non-cached input: the detailed noCacheTokens when present, else the flat
  // total input minus what we already accounted as cache read/write.
  const inputTokens =
    details.noCacheTokens != null
      ? num(details.noCacheTokens)
      : Math.max(0, num(u.inputTokens) - cacheReadTokens - cacheWriteTokens);
  const outputTokens = num(u.outputTokens);
  const totalTokens =
    num(u.totalTokens) || inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;

  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens };
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
