# Model picker for the AI builder + agent step (via aieo)

> **Status (2026-09-11): implemented.** aieo 0.1.39 ships `resolve.ts`
> (additive); strut has `src/llm.ts`, `GET /llm/models`, `POST /chat { model }`,
> the flyout picker, and the step-editor datalist. Two deliberate
> departures from the text below: `POST /chat` validates only an EXPLICIT
> `model` pick (a missing key for the default surfaces as `chat.error`,
> which the flyout already renders — so tests that post without a key
> stay offline), and strut names its glue `resolveModel`, not
> `resolveStrutModel`. The rest is as written.

## Problem

The AI builder chat is hard-wired to Anthropic. `createStrut.ts` imports
`@ai-sdk/anthropic` directly and calls `anthropic(chatModel)`,
`STRUT_CHAT_MODEL` is documented as "an Anthropic model id",
`maxOutputTokensFor("anthropic")` is fixed, and the anthropic-only
provider-executed `web_search` tool is always offered. There is no way to
pick a model from the UI (per chat or per deployment), and nothing tells the
UI or the builder which providers actually have keys.

The `agent` step already resolves models through aieo (aliases like
`sonnet`/`grok`, slash ids like `openrouter/moonshotai/kimi-k2.6`, provider
inference, gateway routing, per-provider env keys). But its `model` field is
a blind text box in the step editor, and the builder has no idea which
providers are configured when it authors `model:` in a workflow. The `llm`
step still has its own anthropic/openai switch and knows nothing of aieo.

aieo owns everything needed: the provider list, the alias → id table,
provider inference, key lookup, client construction, context limits. Strut
should consume it rather than copy it (`pricing.ts` is already a
"keep in sync" copy of aieo's table — don't add another).

Version facts that shape this:

- strut's installed `aieo` is 0.1.34, whose `Provider` type has no `xai` —
  yet `agent.ts` already advertises `grok` and AGENTS.md lists xai. Today an
  xai model throws "Unknown LLM provider". The local checkout at
  `mcp/src/aieo` is 0.1.38 (= the published latest) and has it.
- aieo does not export its alias table (`MODELS`), its defaults
  (`DEFAULT_MODELS`), or its key-env table (inside
  `lookupApiKeyForProvider`). Listing models without an API key is
  therefore impossible from the outside today.
- aieo's `getModelDetails` is already 80% of the resolver strut needs, but
  it takes a sync `apiKey` or reads env, cannot take an explicit provider
  override, logs a key prefix on every call, and has no output-token cap
  (mcp keeps that in `repo/utils.ts`; strut's `pricing.ts` mirrors it).
- Many repos depend on aieo. **Every aieo change here is additive** — new
  file, new exports; no existing signature or behavior moves.

## Design in one paragraph

aieo gains an additive `resolve.ts`: model name → `{ provider, modelId,
model, contextLimit, maxOutputTokens }`, with the API key pulled from an
optional async `getSecret` hook (env fallback), plus a keyless catalog
listing. Strut's chat, `agent` step, and `llm` step all call it through
~20 lines of glue that plug in `ctx.services.secrets.get`. One strut
endpoint (`GET /llm/models`) exposes the catalog with per-provider
availability. The chat flyout gets a `<select>` fed by that endpoint; the
choice rides along on `POST /chat` and is recorded on `ChatMeta.model` (a
field that already exists). The step editor's `model` field gets a
`<datalist>` from the same endpoint. The builder's system prompt gets one
line naming the configured providers.

## Model name grammar (what aieo does today; unchanged)

Split on `/`. **The first segment is stripped only if it names an aieo
provider** (`anthropic | google | openai | openrouter | xai`). Everything
after it is the provider's own id, which may itself contain slashes. So the
segment count is 1, 2 or 3 depending on the provider, not a fixed shape:

| name                               | provider          | modelId                  |
| ---------------------------------- | ----------------- | ------------------------ |
| `sonnet`                           | anthropic (alias) | `claude-sonnet-5`        |
| `claude-sonnet-5`                  | inferred by name  | `claude-sonnet-5`        |
| `anthropic/claude-sonnet-5`        | anthropic         | `claude-sonnet-5`        |
| `openrouter/moonshotai/kimi-k2.6`  | openrouter        | `moonshotai/kimi-k2.6`   |
| `openrouter/openrouter/auto`       | openrouter        | `openrouter/auto`        |
| `openrouter/openai/gpt-5`          | openrouter        | `openai/gpt-5`           |
| `openai/gpt-5`                     | openai (direct)   | `gpt-5`                  |
| `moonshotai/kimi-k2.6`             | **default** (trap)| `moonshotai/kimi-k2.6`   |

The last row is the trap: `moonshotai` isn't a provider, nothing is
stripped, inference falls through to `LLM_PROVIDER`/anthropic, and the
provider 404s. OpenRouter-hosted models must be written with the
`openrouter/` prefix — the canonical form below makes that automatic.

**Canonical form** (what strut stores on `ChatMeta.model` and shows in the
UI): `<aieo-provider>/<native-id>` — two segments for direct providers,
three for OpenRouter. It round-trips through `getProviderForModel` +
`getModel` with no ambiguity, and it is unaffected by gateway config
(Bifrost's `openrouter/` / `xai/` / `gemini/` wire prefixes are added
inside `getModel` and never surface).

### 0. aieo: additive `resolve.ts` (prerequisite)

New file `mcp/src/aieo/src/resolve.ts`, `export * from "./resolve.js"` in
`index.ts` (aieo has no `exports` map, so that's the only wiring). All
existing functions — `getModel`, `getModelDetails`, `getProviderForModel`,
`resolveLLMConfig`, `hasApiKeyForProvider` — keep their signatures and
behavior. `provider.ts` only gains exports of things it already has:

```ts
// provider.ts — additive exports only
export const MODELS, DEFAULT_MODELS;                 // the private consts, now exported
export const API_KEY_ENV: Record<Provider, string>;  // beside lookupApiKeyForProvider; the switch stays as is
```

```ts
// resolve.ts — all new
export interface ModelOption { provider: Provider; alias: ModelName; modelId: string; default: boolean }
export function listModels(): ModelOption[];         // flattens MODELS + DEFAULT_MODELS, no key needed

/** Pure. `provider` is set only when the name carries an explicit aieo-provider prefix. */
export function parseModelName(name?: string): { provider?: Provider; modelId?: string };

/** mcp's repo/utils.ts function, verbatim: MAX_OUTPUT_TOKENS env wins; anthropic 128k, else 64k. */
export function maxOutputTokensFor(provider?: string): number;

export interface ResolveOptions {
  model?: string;                  // alias | id | "provider/id" | "openrouter/org/id"
  provider?: Provider | string;    // explicit override; else inferred from `model`
  apiKey?: string;
  getSecret?: (envName: string) => Promise<string | undefined>;  // async key source; env is the fallback
  baseUrl?: string; headers?: Record<string, string>; abortSignal?: AbortSignal; timeoutMs?: number;
  quiet?: boolean;                 // no key-prefix logging
}
export interface ResolvedModel {
  provider: Provider; modelId: string;
  name: string;                    // canonical "provider/modelId"
  model: LanguageModel; apiKey: string; contextLimit: number; maxOutputTokens: number;
}
export async function resolveModel(opts: ResolveOptions): Promise<ResolvedModel>;
```

`resolveModel` behavior:

- `provider = opts.provider ?? parseModelName(model).provider ?? getProviderForModel(model)`;
  unknown → `Unknown LLM provider: "x". Supported: …` (same text `agent.ts`
  throws today).
- `apiKey = opts.apiKey ?? (await opts.getSecret?.(API_KEY_ENV[provider])) ?? env` —
  missing everywhere → an error that names the env var.
- `modelId`: alias → table; explicit prefix → stripped; else as-is.
- The trap above gets a targeted error: a slashed name whose first segment
  is not a provider, with no explicit `provider`, → "did you mean
  `openrouter/<name>`?" instead of a provider 404 later.
- `model = getModel(provider, { modelName, apiKey, baseUrl, headers, abortSignal, timeoutMs })`.
- `contextLimit = getContextLimit(modelId, provider)`; `maxOutputTokens = maxOutputTokensFor(provider)`.

Tests: `src/__tests__/resolve.test.ts` in aieo's existing tsx-script style,
offline (`getModel` only constructs clients) — the grammar table above as
cases, the trap message, `getSecret` precedence over env, `provider`
override, `listModels` shape. Publish 0.1.39; strut bumps `aieo` from
`^0.1.34` to `^0.1.39`. mcp's four `getModelDetails` call sites and its
`maxOutputTokensFor` can migrate whenever convenient — nothing forces it.

Note: mcp consumes strut as a git dep and carries aieo as a workspace
package (`mcp/package.json` workspaces: `src/aieo`). Keep strut's range
satisfied by the workspace version so an mcp install links one aieo, not
two.

### 1. `src/llm.ts` — strut's glue (~20 lines)

```ts
export function resolveStrutModel(opts: { model?: string; provider?: string; secrets?: SecretsCapability }) {
  return resolveModel({ ...opts, getSecret: opts.secrets?.get, quiet: true });   // lazy import("aieo"), as agent.ts does
}
export async function listModelOptions(secrets?: SecretsCapability):
  Promise<{ default: string; models: (ModelOption & { available: boolean })[]; keyNames: Record<Provider, string> }>;
```

- `secrets` is `ctx.services.secrets` — the existing boundary (secret store
  first, env fallback). Side effect worth having: keys pasted under
  **Secrets** in the UI start working for LLM steps and the chat (today aieo
  reads only `process.env`, so they silently don't), and because the value
  is read through `secrets.get` it is scrubbed from step cassettes for free.
- `available` = `!!(await secrets?.get(API_KEY_ENV[p])) || hasApiKeyForProvider(p)`.
  Values never leave the function.
- The output cap is aieo's, with `STRUT_MAX_OUTPUT_TOKENS` applied on top in
  `src/llm.ts` (strut's `maxOutputTokensFor` is gone).

Callers:

- **chat** (`createStrut.ts` `launchChatTurn`): replaces the
  `@ai-sdk/anthropic` import and `anthropic(chatModel)`.
- **`agent` step**: replaces its ~15-line resolution block
  (`getModel`/`getProviderForModel`/`PROVIDERS` + env fallbacks). The
  anthropic-only extras (web search, provider text editor, ephemeral
  cacheControl) stay keyed on `provider` exactly as now. `STRUT_LLM_MODEL` /
  `STRUT_LLM_PROVIDER` defaults stay.
- **`llm` step**: drops its anthropic/openai switch and gains all five
  providers — about 20 lines smaller. Recommended; otherwise it is the last
  copy of provider logic.

### 2. `GET /llm/models`

```json
{
  "default": "anthropic/claude-sonnet-5",
  "models": [
    { "provider": "anthropic", "alias": "sonnet", "modelId": "claude-sonnet-5", "default": true,  "available": true },
    { "provider": "openrouter", "alias": "kimi", "modelId": "moonshotai/kimi-k3", "default": true, "available": false }
  ],
  "keyNames": { "anthropic": "ANTHROPIC_API_KEY", "openrouter": "OPENROUTER_API_KEY", "...": "..." }
}
```

- `default` is the deployment's chat default (`chatModel`) in canonical
  form, so the UI can match it to an entry or show it as a custom value.
- `keyNames` lets the UI say exactly which secret to add for a greyed-out
  provider.
- Mounted alongside `/chat` (gated the same way; `enableChat` off → no
  route). Add `/llm` to the static catch-all's API-prefix list and to the
  `web/vite.config.ts` dev proxy.

### 3. Chat: the model is chosen per turn, recorded per chat

- `POST /chat { message, chatId?, model? }`. `model` is validated through
  the resolver **before anything is persisted** — 400 with the resolver's
  message (unknown provider / missing key / the openrouter trap), so a bad
  pick never creates a dead chat. Precedence: request `model` → the chat's
  existing `meta.model` → `chatModel` default. The winner is stored in
  canonical form via `setMeta` (new chats: `createChat({ model })`, which
  already exists).
- `launchChatTurn` reads `meta.model` and resolves it, so
  notification-triggered auto turns (`notifier.startTurn`) use the chat's
  model too — no extra plumbing through the notifier.
- Provider-derived bits move off the hardcode:
  `deps.webSearch = provider === "anthropic"` (aieo's `getProviderTool`
  offers an Exa-backed shim for other providers; adopting it is a separate
  choice — see "Later"), `maxOutputTokens` from the resolver. The chat
  sets no `providerOptions` today and still won't.
- `StrutOptions.chatModel` / `STRUT_CHAT_MODEL`: any aieo name (alias, id,
  or canonical). Default stays `claude-sonnet-5`.
- Switching mid-chat is allowed and applies to the next turn. Same-provider
  switches are clean. Cross-provider switches are best-effort: a transcript
  holding anthropic provider-executed `web_search` parts may be rejected by
  another provider; that surfaces as a normal `chat.error` and **New chat**
  is the way out. Not worth guarding in v1.

### 4. Web UI

- `api.ts`: `listLlmModels()`; `sendChat(message, chatId?, model?)`.
  `ChatMeta.model` is already typed.
- `storage.ts`: a `chatModel` accessor so the pick is sticky across chats
  and reloads (same pattern as `sttSettings`).
- `ChatFlyout`: a compact `<select class="chat-model">` in the input row,
  left of the mic/Send buttons. Options grouped by provider (`<optgroup>`);
  unavailable ones disabled with the key name from `keyNames`
  ("no OPENROUTER_API_KEY — add it under Secrets"). Initial value: the
  stored pick if still available, else the server default, else the first
  available. A trailing "Custom…" option reveals a text input for any aieo
  name (`claude-opus-4-8`, `openrouter/deepseek/deepseek-v3`); the input's
  hint states the grammar ("OpenRouter models: `openrouter/org/model`").
  No available provider at all → an inline notice in the flyout instead of
  a silent failure at send time. History rows show `meta.model` next to
  the time.
- Step editor: `FieldDesc` gains `suggest?: "llm-models"`. The `agent` and
  `llm` steps' `model` fields carry `.meta({ suggest: "llm-models" })`
  (zod v4; `describeField` reads it off the unwrapped inner schema).
  `ConfigField` renders a string field with `suggest` as
  `<input list=…>` + `<datalist>` of canonical names from the (cached)
  `/llm/models` — free text still works, so aliases, slash ids and `{{ }}`
  templates are all fine. An explicit marker rather than matching on the
  field name `model`, so a custom step with an unrelated `model` field
  isn't decorated by accident and `get_step` output carries the marker too.

### 5. AI builder awareness

`buildSystem(deps)` gets one line, e.g.
"LLM providers configured on this deployment: anthropic (default
claude-sonnet-5), openrouter. Only use these in agent/llm `model:`
(OpenRouter models as `openrouter/org/model`); tell the user which secret
to add for anything else." `createStrut` supplies `deps.models` from
`listModelOptions`. `get_step` needs nothing extra — its `fields` now
carry `suggest`.

## Implementation order

1. aieo `resolve.ts` + tests; publish 0.1.39. strut bumps; typecheck passes
   once `Provider` includes `xai`.
2. `src/llm.ts` glue + `src/llm.test.ts`.
3. `agent` step onto the resolver (existing tests must stay green — they set
   `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` and drive a fake SSE
   server). Then the `llm` step.
4. `GET /llm/models`; `POST /chat { model }`; `meta.model` in
   `launchChatTurn`; `webSearch` gating. Chat-endpoint tests.
5. Web: `api.ts` / `storage.ts` / `ChatFlyout` picker; `FieldDesc.suggest`
   + datalist in `ConfigField`; CSS; vite proxy.
6. Prompt line. Docs.

Each step leaves the tree green; 1–3 ship value on their own (xai fixed,
Secrets-dialog keys work) before any UI exists.

## Tests

- aieo `__tests__/resolve.test.ts` (offline): the grammar table; the
  openrouter trap message; explicit `provider` override; `getSecret` wins
  over env; no key anywhere → error names the env var; `maxOutputTokens`
  128k anthropic / 64k others; `listModels` shape.
- `src/llm.test.ts`: the glue reads keys via a `secretsCapability` over a
  seeded `MemorySecretStore`; `listModelOptions` availability reflects it;
  `STRUT_MAX_OUTPUT_TOKENS` precedence.
- `chat-endpoints.test.ts`: `/llm/models` shape; `POST /chat
  { model: "openai/gpt-5" }` without a key → 400 and no chat created; with
  a key → `meta.model === "openai/gpt-5"`; a second turn without `model`
  keeps it; a request for an existing chat with a new model updates it.
- `agent.test.ts`: existing "rejects an unknown provider" and stream-resume
  tests unchanged; add "resolves the key from `ctx.services.secrets` when
  env is unset".
- `schemaHelpers`: `suggest` survives `.optional()` / `.default()`
  wrappers.

## Docs to touch

AGENTS.md — stack row ("AI builder … + Anthropic" → via aieo, any
provider), env table (`STRUT_CHAT_MODEL` wording), layout entries for
`src/llm.ts`, the `/llm/models` endpoint, and the `AiDeps.webSearch`
comment that says "chat is anthropic-only". README env example (other
`*_API_KEY`s, or paste them under Secrets; the `openrouter/org/model`
form). `StrutOptions.chatModel` doc. `pricing.ts` header.

## Later / out of scope

- Thinking and effort controls (aieo `getProviderOptions`) — that is a
  second picker with cost implications; not now.
- ~~Web search on non-anthropic providers~~ Done: `web_search` + `web_fetch`
  ship on every provider (aieo's `createWebSearch`/`createWebFetch` via
  `createWebTools` in `src/llm.ts`) for both the chat and the agent step;
  the anthropic gate is gone. Exa key via `EXA_API_KEY` (store or env).
- ~~`pricing.ts` stays a copy~~ Done: strut's price table, `computeCost` and
  `maxOutputTokensFor` are gone; the agent step prices through aieo's
  `computeSessionCost` (`usageForCost` adapts the usage shape), mcp's lab
  steps through `lab/cost.ts` over the same function.
- mcp migrating its `getModelDetails` / `maxOutputTokensFor` call sites to
  `resolveModel` — optional, nothing breaks either way.
- The desktop host's own settings UI for keys
  (`plans/local-desktop-and-stt.md` §env) — the secret-store path above
  already gives a no-env route, so it isn't blocked on that.
- Light/cheap model variants per provider (`getLightModelForProvider`) in
  the picker — trivial to add to `listModels()` later if wanted.

## Choices to confirm

1. **Picker placement** — input row next to Send (proposed) vs the flyout
   header.
2. **Custom free-text entry** in the chat picker — included in v1 above;
   drop it if aliases-only is enough.
3. **Migrate the `llm` step now** — recommended above so there is exactly
   one resolution path; can be split out.
