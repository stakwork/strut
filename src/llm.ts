// ── LLM model resolution: strut's glue over aieo ────────────────────────────
//
// One place turns a model NAME — an alias ("sonnet"), a full id
// ("claude-opus-4-8"), or the canonical "provider/id" form
// ("openrouter/moonshotai/kimi-k2.6") — into a provider, a concrete id, an
// AI SDK LanguageModel and an output-token cap. The chat builder, the `agent`
// step and the `llm` step all come through here, so provider knowledge lives
// in aieo (`resolve.ts`) and nowhere in strut.
//
// Keys come through the secrets boundary: `ctx.services.secrets.get(name)`
// (secret store first, then env) is handed to aieo as `getSecret` and asked
// by the provider's env-var NAME (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). So a
// key pasted under Secrets in the UI works, and one in env keeps working.
//
// aieo stays lazy-imported: its index pulls every provider SDK at load.

import type { Provider } from "aieo";
import type { SecretsCapability } from "./capabilities.js";
import type { StepContext } from "./core.js";

// ── The auth seam (plans/mothership-cost-control.md §1) ────────────────────
//
// Core knows one hook: `llmAuth(ctx)` → where to send the call and what to
// send with it. A host that routes spend through a gateway (src/mothership.ts)
// returns the gateway root, a per-user key and the headers that attribute the
// call; `undefined` means "call the provider directly, as always". Core never
// knows what a macaroon is.

/** What a call site tells the hook about the call it is about to make. */
export interface LlmAuthContext {
  kind: "step" | "chat";
  provider: Provider;
  runId?: string;
  chatId?: string;
  turn?: number;
  /** The top-level workflow of the run (a subflow's steps name their root). */
  workflow?: string;
  /** The step's event path, e.g. `digest/loop#3/summarize`. */
  stepPath?: string;
  actor?: string;
  principal?: string;
}

export interface LlmAuthResult {
  apiKey?: string;
  /** The gateway ROOT; aieo appends the per-provider path. */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Turn a provider/gateway error into a clearer message (a 402 that names
   *  a delegation, say). Return `undefined` to keep the original error. */
  explainError?: (err: unknown) => string | undefined;
}

export type LlmAuth = (ctx: LlmAuthContext) => Promise<LlmAuthResult | undefined>;

export interface ResolveModelOptions {
  /** alias | id | "provider/id" | "openrouter/org/id". Omit for the provider's default. */
  model?: string;
  /** Explicit provider; otherwise inferred from `model`. */
  provider?: string;
  /** The secrets boundary (`ctx.services.secrets`). Optional — without it
   *  aieo reads `process.env` directly. */
  secrets?: SecretsCapability;
  /** The auth hook (`ctx.services.llmAuth`), consulted when `auth` is also
   *  given. Its result takes precedence over the secrets boundary. */
  llmAuth?: LlmAuth;
  /** What the hook is told; the provider is filled in here. */
  auth?: Omit<LlmAuthContext, "provider">;
}

export interface ResolvedModel {
  provider: Provider;
  /** Concrete id as the provider knows it (alias resolved, prefix stripped). */
  modelId: string;
  /** Canonical "<provider>/<modelId>" — what `ChatMeta.model` records. */
  name: string;
  /** The key the model was built with — for `createWebTools` (the
   *  anthropic native tools need it). Never log or persist it. */
  apiKey: string;
  /** The AI SDK LanguageModel. Typed loosely so `ai`/aieo stay lazy. */
  model: any;
  contextLimit: number;
  /** Per-generation output cap: aieo's per-provider value (anthropic 128k,
   *  else 64k — without it the SDK's 4096 default truncates big tool calls
   *  mid-JSON), with strut's `STRUT_MAX_OUTPUT_TOKENS` override on top. An
   *  infra constant, never step/workflow config. */
  maxOutputTokens: number;
  /** True when an `llmAuth` grant sent this call through a gateway (it
   *  returned a `baseUrl`). `createWebTools` reads it: a routed call never
   *  uses Anthropic's server-executed web tools (see `routed` there). */
  routed: boolean;
}

/** Name → everything a caller needs to run. Throws on an unknown provider,
 *  the no-prefix OpenRouter trap ("moonshotai/kimi-k2.6" — write
 *  "openrouter/moonshotai/kimi-k2.6"), or a missing key (the error names
 *  the env var / secret to set). */
export async function resolveModel(opts: ResolveModelOptions = {}): Promise<ResolvedModel> {
  const aieo = await import("aieo");
  const secrets = opts.secrets;
  // The hook needs the provider before the model is built (the gateway path
  // is per provider), and aieo only resolves it inside resolveModel — so ask
  // the keyless canonicalizer first. Same errors as the resolve below.
  let grant: LlmAuthResult | undefined;
  if (opts.llmAuth && opts.auth) {
    const provider = aieo.canonicalModelName(opts.model, opts.provider).provider;
    grant = await opts.llmAuth({ ...opts.auth, provider });
  }
  const r = await aieo.resolveModel({
    model: opts.model,
    provider: opts.provider,
    getSecret: secrets ? (name) => secrets.get(name) : undefined,
    ...(grant?.apiKey ? { apiKey: grant.apiKey } : {}),
    ...(grant?.baseUrl ? { baseUrl: grant.baseUrl } : {}),
    ...(grant?.headers ? { headers: grant.headers } : {}),
  });
  return {
    provider: r.provider,
    modelId: r.modelId,
    name: r.name,
    apiKey: r.apiKey,
    model: grant?.explainError ? await explaining(r.model, grant.explainError) : r.model,
    contextLimit: r.contextLimit,
    maxOutputTokens: strutOutputCap() ?? r.maxOutputTokens,
    routed: !!grant?.baseUrl,
  };
}

// ── evaluation models (for `experimental_evaluate`) ─────────────────────────

/** Where TypeSafe's key lives (secret store or env). */
export const TYPESAFE_KEY_NAME = "TYPESAFE_AI_API_KEY";

export interface ResolvedEvaluationModel {
  /** Canonical "<provider>/<modelId>" — "typesafe/jev-latest", "anthropic/claude-haiku-…". */
  name: string;
  /** The AI SDK EvaluationModel. Typed loosely so `ai` stays lazy. */
  model: any;
}

/** "jev", "jev-latest", "typesafe/<id>" → the TypeSafe model id; else undefined. */
function typesafeModelId(model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m) return undefined;
  if (m.startsWith("typesafe/")) return m.slice("typesafe/".length) || "jev-latest";
  if (m === "jev") return "jev-latest";
  return /^jev-/.test(m) ? m : undefined;
}

/**
 * Name → an evaluation model for `experimental_evaluate` (src/evaluate.ts).
 *
 * - "jev" / "jev-<ver>" / "typesafe/<id>": TypeSafe's jev, keyed by
 *   `TYPESAFE_AI_API_KEY` (secret store, then env) — throws naming it when
 *   missing.
 * - no model and no provider: jev when that key is configured, otherwise
 *   `fallback` (the caller's default language model, e.g. STRUT_LLM_*)
 *   as below.
 * - anything else: `resolveModel` (same names, aliases and key errors as
 *   the llm step) wrapped in the SDK's `EvaluationLanguageModel`, which
 *   answers the questions with one structured-output call.
 */
export async function resolveEvaluationModel(
  opts: ResolveModelOptions & { fallback?: { model?: string; provider?: string } } = {},
): Promise<ResolvedEvaluationModel> {
  const getKey = async () =>
    (await opts.secrets?.get(TYPESAFE_KEY_NAME))?.trim() || process.env[TYPESAFE_KEY_NAME]?.trim() || undefined;
  let jevId = opts.provider ? undefined : typesafeModelId(opts.model);
  let apiKey: string | undefined;
  if (jevId) {
    apiKey = await getKey();
    if (!apiKey) throw new Error(`model "${opts.model}" needs ${TYPESAFE_KEY_NAME} (set it under Secrets or in env)`);
  } else if (!opts.model && !opts.provider) {
    apiKey = await getKey();
    if (apiKey) jevId = "jev-latest";
  }
  if (jevId && apiKey) {
    const { createTypeSafeAi } = await import("@ai-sdk/typesafe-ai");
    return { name: `typesafe/${jevId}`, model: createTypeSafeAi({ apiKey }).evaluationModel(jevId) };
  }
  const named = !!(opts.model || opts.provider);
  const r = await resolveModel({
    model: named ? opts.model : opts.fallback?.model,
    provider: named ? opts.provider : opts.fallback?.provider,
    secrets: opts.secrets,
    llmAuth: opts.llmAuth,
    auth: opts.auth,
  });
  const { Experimental_EvaluationLanguageModel } = await import("@ai-sdk/provider-utils/experimental-evaluation");
  return { name: r.name, model: new Experimental_EvaluationLanguageModel({ model: r.model, provider: `${r.provider}.evaluation` }) };
}

/** The `llmAuth` + `auth` pair for a STEP's `resolveModel` call, from its
 *  context: the hook off the services bag, the run, the top-level workflow
 *  (the path's first segment) and the step path. `{}` without a hook. */
export function stepAuth(ctx: StepContext<unknown> | undefined): Pick<ResolveModelOptions, "llmAuth" | "auth"> {
  const llmAuth = (ctx?.services as { llmAuth?: LlmAuth } | undefined)?.llmAuth;
  if (!llmAuth || !ctx) return {};
  return {
    llmAuth,
    auth: {
      kind: "step",
      runId: ctx.runId,
      workflow: ctx.path.split("/")[0],
      stepPath: ctx.path,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    },
  };
}

/** Wrap a model so a request failure the auth layer can explain is rethrown
 *  with that explanation (the original stays as `cause`). Mid-stream errors
 *  are untouched — a rejected request fails before any stream opens. */
async function explaining(model: any, explain: (err: unknown) => string | undefined): Promise<any> {
  const { wrapLanguageModel } = await import("ai");
  const rethrow = (err: unknown): never => {
    const message = explain(err);
    throw message ? new Error(message, { cause: err }) : err;
  };
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        try {
          return await doGenerate();
        } catch (err) {
          return rethrow(err);
        }
      },
      wrapStream: async ({ doStream }) => {
        try {
          return await doStream();
        } catch (err) {
          return rethrow(err);
        }
      },
    },
  });
}

export interface WebTools {
  /** `web_search` and/or `web_fetch`, ready to spread into a tool set. A
   *  tool is absent when its backend has no key: search off anthropic
   *  needs `EXA_API_KEY` (secret store or env); fetch always builds. */
  tools: Record<string, any>;
  /** Feed each step's content (AI SDK `onStepFinish`) so native results
   *  are recorded on the handles. Optional bookkeeping. */
  capture(stepContent: unknown): void;
}

/**
 * Web tools for a resolved provider — the same `web_search` + `web_fetch`
 * on every provider, via aieo: Anthropic's native server-executed tools,
 * an Exa-backed search and a guarded HTTP fetch (public addresses only,
 * every redirect re-checked) everywhere else. One tool name and result
 * shape regardless of which model is driving.
 */
export async function createWebTools(opts: {
  provider: Provider;
  /** The resolved LLM key (`ResolvedModel.apiKey`). */
  apiKey?: string;
  /** The secrets boundary — the Exa key (`EXA_API_KEY`) is read through it. */
  secrets?: SecretsCapability;
  /** Max `web_search` calls per run (aieo default 3). */
  searchMaxUses?: number;
  /** Max `web_fetch` calls per run (aieo default 5). */
  fetchMaxUses?: number;
  abortSignal?: AbortSignal;
  /** The call goes through a gateway (`ResolvedModel.routed`): aieo's
   *  client-side shims on every provider — Exa search (`EXA_API_KEY`, else
   *  no `web_search`) and the guarded HTTP fetch — never Anthropic's
   *  server-executed pair. Those ride the request and the stream as
   *  `server_tool_use` blocks the gateway must re-render faithfully, and
   *  ours (Bifrost) does not: the v2.2.2 build drops `server_tool_use.input`
   *  from a web_search already in the history, so the model's NEXT request
   *  is a 400 (`…server_tool_use.input: Field required`) and the chat turn
   *  dies; the v1.6.2 build emitted headless `content_block_start` frames
   *  for web_fetch. A shim is an ordinary tool call, forwarded untouched.
   *  Probe a gateway's native handling with scripts/gateway-stream.mts
   *  (`websearch-tool`, `webfetch`); lift this once it passes. */
  routed?: boolean;
}): Promise<WebTools> {
  const aieo = await import("aieo");
  // The Exa key only matters where the search shim runs (routed, or
  // everything but anthropic, whose tool is native) — don't touch the secret
  // store otherwise.
  const searchApiKey =
    opts.routed || aieo.resolveSearchBackend(opts.provider) === "exa"
      ? await opts.secrets?.get("EXA_API_KEY")
      : undefined;
  const ws = aieo.createWebSearch({
    provider: opts.provider,
    apiKey: opts.apiKey,
    searchApiKey,
    ...(opts.routed ? { backend: "exa" as const } : {}),
    maxUses: opts.searchMaxUses,
    abortSignal: opts.abortSignal,
  });
  const wf = aieo.createWebFetch({
    provider: opts.provider,
    apiKey: opts.apiKey,
    ...(opts.routed ? { backend: "http" as const } : {}),
    maxUses: opts.fetchMaxUses,
    abortSignal: opts.abortSignal,
  });
  return {
    tools: {
      ...(ws.tool ? { [aieo.WEB_SEARCH_TOOL_NAME]: ws.tool } : {}),
      ...(wf.tool ? { [aieo.WEB_FETCH_TOOL_NAME]: wf.tool } : {}),
    },
    capture: (c) => {
      ws.capture(c);
      wf.capture(c);
    },
  };
}

/** `STRUT_MAX_OUTPUT_TOKENS`, when set to a positive number. */
function strutOutputCap(): number | undefined {
  const n = Number(process.env["STRUT_MAX_OUTPUT_TOKENS"]);
  return n > 0 ? n : undefined;
}

/** Keyless: the canonical "<provider>/<modelId>" a name resolves to. Same
 *  errors as `resolveModel` minus the key check. */
export async function canonicalModelName(model?: string, provider?: string): Promise<string> {
  const aieo = await import("aieo");
  return aieo.canonicalModelName(model, provider).name;
}

export interface ModelOption {
  provider: Provider;
  alias: string;
  modelId: string;
  /** Canonical name — the value a picker submits. */
  name: string;
  /** The provider's default model. */
  default: boolean;
  /** A key for this provider is configured (secret store or env). */
  available: boolean;
}

export interface ModelCatalog {
  /** The deployment's default chat model, canonical. */
  default: string;
  models: ModelOption[];
  /** provider → the env var / secret NAME that holds its key. */
  keyNames: Record<string, string>;
}

/** aieo's alias catalog with per-provider availability. Never returns key
 *  values — only whether one exists. */
export async function listModelOptions(
  opts: { default?: string; secrets?: SecretsCapability } = {},
): Promise<ModelCatalog> {
  const aieo = await import("aieo");
  const available: Record<string, boolean> = {};
  for (const p of aieo.PROVIDERS) {
    const fromSecrets = opts.secrets ? await opts.secrets.get(aieo.API_KEY_ENV[p]) : undefined;
    available[p] = !!fromSecrets?.trim() || aieo.hasApiKeyForProvider(p);
  }
  let def: string;
  try {
    def = aieo.canonicalModelName(opts.default).name;
  } catch {
    def = opts.default ?? ""; // a misconfigured default still lists the catalog
  }
  return {
    default: def,
    models: aieo.listModels().map((m) => ({
      ...m,
      name: `${m.provider}/${m.modelId}`,
      available: available[m.provider] ?? false,
    })),
    keyNames: { ...aieo.API_KEY_ENV },
  };
}
