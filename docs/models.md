# Models: aieo, LLM calls, media and cost control

How a model name becomes a client (aieo, `llm.ts`), media models, the model catalog, and the Mothership gateway path.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| LLM step    | Vercel AI SDK (`ai`) over an aieo-resolved model — lazy-loaded. `ai`, `zod`, `@ai-sdk/anthropic` are **peerDependencies** (see "One copy per process" below); the other provider SDKs (google, openai, xai, openrouter) are strut's own dependencies, pinned exactly. aieo, the provider layer, is strut's own source (`src/aieo/`) |

## Mothership cost control (opt-in)

`plans/mothership-cost-control.md` is the design; `src/mothership.ts` the
module. Strut core knows two generic hooks and nothing about macaroons:

- **`createStrut({ llmAuth })`** — consulted by the `agent`/`llm` steps and
  the chat turn before a model client is built (`src/llm.ts`), with the
  call's context (`kind`, `provider`, `runId`, `workflow`, `stepPath`,
  `actor`, `principal`). Returns `{ apiKey, baseUrl, headers }` to route the
  call through a gateway, or `undefined` to call the provider directly with
  the secrets boundary's key, as always.
- **`createStrut({ resolveActor(c) })`** — who a request is from, as an
  opaque string strut stores and forwards but never interprets (no accounts,
  no login). The default honors `x-strut-actor` only alongside a configured,
  matching `STRUT_API_KEY`; mcp passes its own hook (the verified JWT's `sub`).

**Stamps.** `WorkflowMetadata.owner` is set by the first publish — or the
first schedule — that carries an actor, and changed only by
`PUT /workflows/:name/owner` (gated). `POST /actor/claim { workflows? }`
claims every ownerless workflow (or the named ones) for the request actor and
never takes one someone else owns — the migration for a workspace that
predates owners (seeded lab workflows, script publishes); the topbar's owner
chip offers it as "Claim" / "Claim all unowned". A run
records `actor` (who launched it) and `principal` (who pays: the actor, else
the owner — so an automation's spend lands on the owner) on `run.start` and
the summary, and hands both to every step as `ctx.actor` / `ctx.principal`. A
resume reads the principal back from the log rather than re-deriving it. The
chat's actor is whoever last spoke to it; the builder's runs are billed to
them. `ChatMeta.createdBy` is who STARTED the chat (the first speaker with
an actor, never re-stamped — the chat twin of `owner`), shown in the chat
history list. The UI shows an actor id's first `-` segment
(`web/src/actor.ts`); storage and the wire keep the whole id.
`WorkflowMetadata.maxRunCostUsd` (`PUT /workflows/:name/run-cap`, the
topbar's cap chip) is the run's cap when routed; nothing else reads it. A
PUBLIC run (plans/paid-runs.md §7) carries a cap of its own below it, the
smallest of its item's `capUsd`, the workflow's and what is left of its
daily cap: `RunOptions.maxCostUsd` → `run.start` → `ctx.maxCostUsd` →
`LlmAuthContext.maxCostUsd`, and the run link carries the smaller of the
two (`resolveRunCap`, src/run-cap.ts).

**The module.** `createMothership({ dataDir })` → `{ llmAuth, mount(strut) }`.
Hive mints, once per user and deployment, a macaroon (org-signed user
authorization + a user-signed standing invocation for `strut-agent`, 60
days, a cumulative ceiling) and pushes it with that user's virtual key and
the gateway URL: `PUT /llm/delegations/:actor { macaroon, apiKey, baseUrl }`
(`GET` lists `{ actor, exp, delegationId }`; `DELETE` removes; all behind
`requireApiKey`). Strut never signs: per run it appends one keyless HMAC link
(the run id, the cap, 8 h) and per step a second one that adds
`<workflow>.<step>` to the agent lineage — the gateway bills the last name
— and sends `x-macaroon`, `x-bf-dim-session-id: <workflow>` and
`x-bf-dim-root-agent: strut-agent`. A chat turn is one link billed as
`strut-assistant`. Delegations live in a second encrypted `FileSecretStore`
file, `mothership.json` beside `secrets.json`: never on the services bag (no
step can read another user's macaroon), never in the Secrets list. Tests:
`src/mothership.test.ts` verifies the built chain with gatekey's own
verifier — the TS mirror of the gateway's Go one. The default server builds it when
`STRUT_MOTHERSHIP=1`; `docker-compose.gateway.yml` + `npm run test:gateway`
run the whole path locally (see "Running"). A chat's model pick is validated
through the same hook, so a strut behind the gateway needs no provider keys.
The grant explains the gateway's refusals in plain words
(`explainExhausted`, `explainRefused`): a spent ceiling is "re-authorize",
and a model or provider the person's virtual key does not allow (Bifrost
governance: `Model 'X' is not allowed`) is "X is not enabled for this
workspace: ask an admin". Every provider asks the hook, Maple, Numes and
Token Factory included (`src/llm.ts` `resolveModel`): aieo sends a grant's
call to the gateway's route for that provider, and Maple, Numes, Token
Factory and a provider only the gateway has (`modelProvider`) ride its OpenAI-compatible route as
`<provider>/<id>`.
A provider that gateway does not hold — Bifrost's 400 "could not auto
resolve a provider", a Numes or Token Factory nobody added as a custom
provider there — is sent again straight to the provider with the
deployment's key (`LlmAuthResult.direct`, `directWhenGatewayLacks` in
src/llm.ts; one warn line per provider), unbilled by the gateway; under
`STRUT_MOTHERSHIP_REQUIRED=1` it is an error naming the provider to add
(`explainUnrouted`).
A routed call (`ResolvedModel.routed`: the grant carried a `baseUrl`) never
uses Anthropic's server-executed web tools — `createWebTools` hands out
aieo's Exa + HTTP shims instead, because Bifrost drops `server_tool_use.input`
on the request path (2026-09-24, swarm38: every builder turn that searched
and then called a tool died with `…server_tool_use.input: Field required`).
So a swarm behind the gateway needs `EXA_API_KEY` for `web_search`; without
it the builder and the agent step have `web_fetch` only.

## Key concepts

- **Model picker** (`src/llm.ts` + `GET /llm/models`). The chat runs on
  any aieo provider. `POST /chat { model }` (the flyout's picker, or any
  aieo name typed as "Custom…") is validated — provider known, key
  configured — BEFORE anything is persisted (400 otherwise, so a bad
  pick never creates a dead chat) and recorded on `ChatMeta.model` in
  canonical `provider/id` form (three segments for OpenRouter:
  `openrouter/moonshotai/kimi-k2.6`). Every later turn — including
  notification-triggered ones — resolves that; a chat with no pick records
  none, and each of its turns runs on the deployment's default as it is
  then: `STRUT_DEFAULT_MODEL`, else `STRUT_CHAT_MODEL`. Keys come through
  `ctx.services.secrets` (secret store → env) handed to aieo's
  `resolveModel` as `getSecret`, so a key pasted under **Secrets** works
  for the chat and the `agent`/`llm` steps alike (a store key shadows
  the env var of the same name). Everything provider-shaped keys off the
  RESOLVED provider: the web tools (`web_search` + `web_fetch` via aieo's
  `createWebSearch`/`createWebFetch` — native on anthropic, an Exa-backed
  search (`EXA_API_KEY`, store or env) and a guarded HTTP fetch elsewhere;
  `createWebTools` in `src/llm.ts`, shared with the agent step) and the
  output-token cap. Routed through a gateway (`ResolvedModel.routed`), the
  shims serve every provider — see "Mothership cost control".
  `GET /llm/models` lists every model aieo knows — its aliases and every
  Maple, Numes and Token Factory model — each with its `contextLimit`, its
  `pricing` (USD per million tokens) only where strut knows the model's own
  rate (today Maple's, Numes' and Token Factory's; aieo's flat per-provider rate is not a price, and
  prices and windows are to come from bifrost's datasheet:
  plans/aieo-in-strut.md §6–7), and whether it is `available`: listed in
  `STRUT_MODELS` when the host sets it (`listed: true`; the pickers then
  show only those), else its provider has a key (never values); plus the
  default. The step editor offers the same catalog as a datalist on
  `model` fields whose Zod schema carries `.meta({ suggest: "llm-models" })`
  (`FieldDesc.suggest`), and the system prompt names the configured
  providers — or the host's listed models — so the builder only authors
  runnable `model:` values. Jamie's picker drops a remembered pick the
  list no longer has: the turn then sends no `params.model`. A job a turn
  starts or continues runs on the turn's `params.model` (the job launcher
  reads it off the turn's `run.start`; no pick, the job's own), and Jamie's
  cards send their job turns (Fix, a captcha's answer, a stored secret) on
  the viewer's pick, so a conversation and its jobs run on one model.

- **`image` core step** (`src/steps/core/image.ts`, specs/SPEC.md §4.1.6a).
  ONE image from a prompt with any image model, through the AI SDK's
  `generateImage`: `{ prompt, model, size?, aspectRatio?, seed?,
  providerOptions?, name? }` → `{ path, url, mediaType, bytes, model, cost,
  usage, revisedPrompt? }`, the file written where the run's files go
  (`src/media.ts`), never in the output — a workflow declares `path` as a
  deliverable (`kind: image`). The model is aieo's `<provider>/<id>`
  (`resolveMediaModel`, llm.ts → aieo `getMediaModel`): `xai/grok-imagine-image`,
  `openai/gpt-image-1-mini`, `google/gemini-2.5-flash-image` /
  `google/imagen-…`, `openrouter/<org>/<model>` (OpenRouter's `/images`
  endpoint: its Gemini image models and FLUX, Recraft, Seedream…);
  anthropic, maple, numes and tokenfactory make none. **Cost is never
  guessed**: what the response reported (OpenRouter's and a gateway's
  `usage.cost`, xAI's `cost_in_usd_ticks` — read off the response by
  aieo's `reportedCostFetch`, which the SDKs' image schemas drop), else the
  model's datasheet price (image tokens, else per image), else the step is
  refused BEFORE the call (`image_unpriced:`); it goes out through
  `withUsage`, so a run's totals and a public run's charge (base + markup ×
  cost) count it. **Through the gateway** (stakgraph-gateway, Bifrost
  transports v2.2.2 / core v1.10.1, probed live 2026-11-12): xai, openai (the
  bare id — `@ai-sdk/openai` sends `response_format` for any id not starting
  `gpt-image-`, which OpenAI refuses) and google ride
  `/openai/v1/images/generations`. Bifrost's own openrouter provider has NO
  image generation (every version to v2.5.1), so an OpenRouter image model
  rides as `openrouter-images/<org>/<model>`: a custom OpenAI-type provider
  on OpenRouter's images API, which the gateway holds from
  stakwork/stakgraph#1859, and which a person's virtual key reaches only once
  Hive lists it among the key's providers (`DEFAULT_PROVIDERS`); until then
  the gateway refuses it, `provider_blocked`. That PR also makes the
  gateway bill image calls (before it, $0: its post-hook read chat and
  responses usage only, so a run's gateway cap did not stop image spend);
  strut's own cost, and so the public charge, is right either way. A kind a
  provider makes with no `routed` entry is refused through a gateway before
  anything is sent, unless the grant allows a direct call. Spends like `llm` and `agent`: in `SPENDING_STEPS`,
  `PAID_OR_SHELL`, `PAID_OR_SHELL_STEPS`, verify's paid types and reach's
  always-allowed set. As an agent's tool the model sees a 0.6× copy
  (`withMedia`). Image models are not in `GET /llm/models` (chat models).
  Several images: a foreach. `video` next is one more `MEDIA_MODELS` key and
  one more thin step on `src/media.ts`. `npm run test:image` (opt-in, the
  keys in the environment) makes one real image per provider.

## Files

What each file and folder in this area is, in the order of the tree.

### `aieo/`

the npm package `aieo` (plans/aieo-in-strut.md), built from `src/aieo/` for the repos that still take it from npm (Hive, staklink, mcp): package.json (its version, the provider SDK pins — `src/aieo/pins.test.ts` holds them equal to strut's), tsup.config.js (entry ../src/aieo/index.ts; anthropic, google, openai and provider-utils inlined, as aieo always shipped), tsconfig.json for the build, scripts/ (the live probes: `npm --prefix aieo run try-numes`, keys from strut's `.env`). Nothing strut runs. `npm run build:aieo` → `aieo/dist/` (gitignored; tsup via npx, never a strut dependency), after `aieo/check-install.mjs` refuses an install whose inlined SDKs are not the pinned ones (0.2.8 shipped @ai-sdk/anthropic 4.0.60 from a stale checkout); published by hand: `yarn install --frozen-lockfile`, bump `aieo/package.json`, `npm run build:aieo`, `npm publish ./aieo`. strut itself has no aieo version: it runs `src/aieo/` at its own commit

### `src/aieo/`

aieo, the model layer (moved from stakwork/stakgraph's mcp/src/aieo, history kept): model names → a working AI SDK client (resolve.ts: aliases, `provider/id`, the OpenRouter prefix trap; provider.ts: keys and their companion headers, each provider's client and quirks — thinking rules, Maple's reasoning efforts, gateway paths — output caps, context windows, prices, `computeSessionCost`; the MODEL CATALOG, bifrost's datasheet as data — `loadModelCatalog`, the gateway's key rule, `getModelPrice`, consulted after Maple's and Numes' own tables and before the hand-kept ones, and an image model's prices (`getImagePrice`: image tokens or per image, never OpenRouter's rows, which are not what it charges; `computeImageCost`); `STRUT_MODEL_CATALOG`; MEDIA MODELS — `getMediaModel(kind, provider)` / resolve.ts `resolveMediaModel`: one `connect` (key, gateway, headers, fetch) shared with `getModel`, and one table, `MEDIA_MODELS`, of which providers make each kind (`image`: openai, google, xai, openrouter) and how each rides a gateway's OpenAI-compatible route — openrouter as the gateway's `openrouter-images` custom provider, Bifrost's own having no image generation; `mediaProviders`; a response's reported cost (`usage.cost`, xAI's ticks) put on the call's provider metadata, `mediaCostOf`; a kind is one more key in the table), the web tools (search.ts: native Anthropic or Exa; fetch.ts: native or a guarded HTTP fetch, citations), usage, and the helpers its npm users call (`callModel`, `ConversationStorage`). Strut imports it only through `loadAieo()` (llm.ts), lazily: its index loads every provider SDK. Its own env reads go through `env.ts` (`useEnv`), the one file env.test.ts lets read `process.env`. Its five suites sit beside the sources; the npm package is `aieo/` at the root

### `src/llm.ts`

resolveModel()/listModelOptions()/loadAieo(): strut's glue over aieo's resolve.ts (src/aieo/) — the chat, agent + llm steps resolve model NAME → provider/id/LanguageModel/output cap here; keys via ctx.services.secrets (store → env); backs GET /llm/models. Also the `llmAuth` seam (plans/mothership-cost-control.md §1): a host hook that returns {apiKey, baseUrl, headers} per call, consulted before the client is built; `stepAuth(ctx)` builds a step's call context. `resolveMediaModel(kind, opts)`: the same for a media model (the `image` step) — the grant's gateway when it routes that kind for the provider, else direct only where the grant allows (`direct`), else refused before anything is sent

### `src/media.ts`

what a MEDIA step shares (`image` now, `video` next): `saveMedia` — the file where the run's files go (the run's artifacts, or the job's directory on a job run, a `job.update` to a listening host: browser screenshots' rule), `mediaFileName` (the author's `name`, else the step's place in the run — `each-3-pic` in a foreach — led by the run id on a job run), `imagePreview` (the 0.6× copy a model is shown, `sharp`, skipped where it cannot load)

### `src/media-seed.ts`

`image-gen` (src/workflows/image-gen.yaml), seeded at boot by content hash in category `media` like `private-ask`; `createStrut({ mediaWorkflows: false })` seeds none

### `src/mothership.ts`

OPT-IN Mothership cost control (plans/mothership-cost-control.md §3): createMothership({ dataDir }) → { llmAuth, mount }. Hive pushes one standing macaroon per user (PUT /llm/delegations/:actor); strut appends keyless HMAC links per run and per step (gatekey `attenuate`) so the gateway bills user × workflow × step and caps the run. Delegations live in a second encrypted file (mothership.json), never on the services bag. A public run's own cap (`LlmAuthContext.maxCostUsd`, from `ctx.maxCostUsd` through `stepAuth`) makes the run link carry the smaller of it and the workflow's (src/run-cap.ts). Core never imports it

### `src/steps/lib/llm/`

llm/models: the model catalog `GET /llm/models` serves (every model aieo knows, each `available` when the host's `STRUT_MODELS` lists it or, with no list, when its provider has a key here; the deployment's default) over `ctx.services.llmModels`, the one list both read — what strut's own assistant app's model picker reads (plans/jamie-app.md §5). Not the `llm` core step: it calls no model
