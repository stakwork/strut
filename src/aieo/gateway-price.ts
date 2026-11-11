// Model prices from the LLM GATEWAY — the single source (strut holds no price
// list of its own, and does not fetch bifrost's datasheet).
//
// The gateway (stakgraph `gateway/`, the Mothership strut routes calls
// through) answers, anonymously and read-only, on its root:
//   GET <root>/_plugin/pricing/model?provider=&model=  → 200 the EFFECTIVE
//        rates in USD per million tokens (fallbacks already applied: tokens ×
//        rates, no rules here), or 404 { error: "unpriced" }
//   GET <root>/_plugin/pricing/status                   → what it has loaded
// It resolves a model exactly as it bills it. There is no long-prompt tier
// here: the gateway has none, and none is invented.
//
// `computeSessionCost` is synchronous, so a step resolves its model's price
// ONCE, before its model loop (`gatewayModelPrice`), and passes it in.

import type { TokenPricing } from "./provider.js";

export interface GatewayPrice {
  pricing: TokenPricing;
  /** Which key the gateway matched, and the table that held it. */
  key?: string;
  source?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface GatewayPriceOptions {
  fetch?: typeof fetch;
  /** For tests: the clock. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
/** After a failed request with nothing to fall back on (or a stale entry kept
 *  through an error): how long before asking again. */
const RETRY_MS = 30_000;
const TIMEOUT_MS = 5_000;

// bifrost's names for aieo's providers, which is how the gateway keys its rows.
const GATEWAY_PROVIDER: Record<string, string> = { google: "gemini", numes: "openrouter" };

/** An id as a price sheet tends to spell it: no leading "<provider>/", dots
 *  between version digits as dashes ("claude-opus-5.5" → "claude-opus-5-5"),
 *  "@YYYYMMDD" as "-YYYYMMDD". */
export function normalizeModelId(provider: string, modelId: string): string {
  const names = [provider, GATEWAY_PROVIDER[provider]].filter(Boolean) as string[];
  let id = modelId.trim();
  for (const n of names) if (id.startsWith(`${n}/`)) id = id.slice(n.length + 1);
  return id.replace(/(\d)\.(?=\d)/g, "$1-").replace(/@(\d{8})$/, "-$1");
}

/** The ids to ask for, in order: as given; normalised; and, as the last try,
 *  without a trailing -YYYYMMDD date. */
export function modelIdCandidates(provider: string, modelId: string): string[] {
  const normalized = normalizeModelId(provider, modelId);
  return [...new Set([modelId, normalized, normalized.replace(/-\d{8}$/, "")])].filter(Boolean);
}

interface Entry {
  value: GatewayPrice | null; // null: the gateway says unpriced
  at: number;
  ttl: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<GatewayPrice | undefined>>();
/** The newest good price per provider/model, whatever the gateway: what the
 *  synchronous limit lookups (getContextLimit, maxOutputTokensFor) read. */
const latest = new Map<string, GatewayPrice>();
let warnedNoGateway = false;

const keyOf = (root: string, provider: string, model: string) => `${root}\0${provider}\0${model}`;
const rootOf = (root: string) => root.replace(/\/+$/, "");

export function resetGatewayPriceCache(): void {
  cache.clear();
  inflight.clear();
  latest.clear();
  statusCache.clear();
  warnedNoGateway = false;
}

/** The last price the gateway gave for a model (any gateway, even a stale
 *  one), without a request: undefined when none was fetched or it was unpriced. */
export function cachedGatewayPrice(provider: string, modelId: string): GatewayPrice | undefined {
  return latest.get(`${provider}\0${modelId}`);
}

/** Say, once per process, that no gateway is configured, so costs of models
 *  priced by it are reported as unpriced. */
export function warnNoGateway(): void {
  if (warnedNoGateway) return;
  warnedNoGateway = true;
  console.error(
    "[aieo] no gateway is configured (no llmAuth grant with a baseUrl, and STRUT_GATEWAY_URL is unset): model prices come only from the gateway, so costs of direct-provider calls are reported as 0 (unpriced)",
  );
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function toPrice(body: Record<string, unknown>): GatewayPrice | undefined {
  const input = num(body["input_per_mtok"]);
  const output = num(body["output_per_mtok"]);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = num(body["cache_read_per_mtok"]);
  const cacheWrite = num(body["cache_write_per_mtok"]);
  const cacheWrite1h = num(body["cache_write_1h_per_mtok"]);
  const maxIn = num(body["max_input_tokens"]);
  const maxOut = num(body["max_output_tokens"]);
  return {
    pricing: {
      inputTokenPrice: input,
      outputTokenPrice: output,
      ...(cacheRead !== undefined ? { cacheReadPrice: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWritePrice: cacheWrite } : {}),
      ...(cacheWrite1h !== undefined ? { cacheWrite1hPrice: cacheWrite1h } : {}),
    },
    ...(typeof body["key"] === "string" ? { key: body["key"] } : {}),
    ...(typeof body["source"] === "string" ? { source: body["source"] } : {}),
    ...(maxIn ? { maxInputTokens: maxIn } : {}),
    ...(maxOut ? { maxOutputTokens: maxOut } : {}),
  };
}

function maxAgeMs(res: Response): number {
  const m = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
  return m ? Number(m[1]) * 1000 : DEFAULT_TTL_MS;
}

/** One ask: a price, null (404: unpriced), or a throw (unreachable / unusable). */
async function ask(root: string, provider: string, model: string, get: typeof fetch): Promise<{ value: GatewayPrice | null; ttl: number }> {
  const url = `${root}/_plugin/pricing/model?provider=${encodeURIComponent(GATEWAY_PROVIDER[provider] ?? provider)}&model=${encodeURIComponent(model)}`;
  const res = await get(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return { value: null, ttl: maxAgeMs(res) };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const price = toPrice((await res.json()) as Record<string, unknown>);
  if (!price) throw new Error("the gateway's price has no input/output rates");
  return { value: price, ttl: maxAgeMs(res) };
}

/** A model's EFFECTIVE price from the gateway at `gatewayRoot`, cached per
 *  (root, provider, model) for the gateway's max-age (5 min by default).
 *  Asks for the id as given, then once per normalised form after a 404.
 *  Unpriced (404) is cached too. A network error keeps the last good entry
 *  (stale-while-error); with none, undefined, asked again in 30 s. Never throws. */
export async function gatewayModelPrice(
  provider: string,
  modelId: string,
  gatewayRoot: string,
  opts: GatewayPriceOptions = {},
): Promise<GatewayPrice | undefined> {
  const root = rootOf(gatewayRoot);
  const key = keyOf(root, provider, modelId);
  const now = opts.now ?? Date.now;
  const hit = cache.get(key);
  if (hit && now() - hit.at < hit.ttl) return hit.value ?? undefined;
  const running = inflight.get(key);
  if (running) return running;
  const get = opts.fetch ?? fetch;
  const work = (async (): Promise<GatewayPrice | undefined> => {
    try {
      let got: { value: GatewayPrice | null; ttl: number } = { value: null, ttl: DEFAULT_TTL_MS };
      for (const id of modelIdCandidates(provider, modelId)) {
        got = await ask(root, provider, id, get);
        if (got.value) break;
      }
      cache.set(key, { value: got.value, at: now(), ttl: got.ttl });
      if (got.value) latest.set(`${provider}\0${modelId}`, got.value);
      return got.value ?? undefined;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (hit?.value) {
        console.warn(`[aieo] gateway price for ${provider}/${modelId} not refreshed (${message}); keeping the last good one`);
        cache.set(key, { value: hit.value, at: now(), ttl: RETRY_MS });
        return hit.value;
      }
      console.warn(`[aieo] gateway price for ${provider}/${modelId} unavailable (${message})`);
      cache.set(key, { value: null, at: now(), ttl: RETRY_MS });
      return undefined;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, work);
  return work;
}

const statusCache = new Map<string, { at: number; value: { status?: unknown; error?: string } }>();

/** What the gateway's /_plugin/pricing/status says (cached 1 min), or the error. Never throws. */
export async function gatewayPricingStatus(gatewayRoot: string, opts: GatewayPriceOptions = {}): Promise<{ status?: unknown; error?: string }> {
  const root = rootOf(gatewayRoot);
  const now = opts.now ?? Date.now;
  const hit = statusCache.get(root);
  if (hit && now() - hit.at < 60_000) return hit.value;
  let value: { status?: unknown; error?: string };
  try {
    const res = await (opts.fetch ?? fetch)(`${root}/_plugin/pricing/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    value = { status: await res.json() };
  } catch (err) {
    value = { error: (err as Error)?.message ?? String(err) };
  }
  statusCache.set(root, { at: now(), value });
  return value;
}
