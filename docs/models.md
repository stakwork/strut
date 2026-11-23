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

**The module.** `createMothership({ dataDir })` → `{ llmAuth, mount(strut) }` (and `grants`, below).
The host mints, once per person and deployment, a delegation for
`strut-agent` (60 days, a cumulative ceiling) and pushes it with that
person's virtual key and the gateway URL: `PUT /llm/delegations/:actor
{ macaroon, apiKey, baseUrl }` (`GET` lists `{ actor, exp, delegationId, v }`,
`v` the macaroon's format so the host can re-mint an old one, and a record
stored before v2 reads as 1; `DELETE` removes; all behind `requireApiKey`).
The PUT checks the shape and that it has not expired. Per run strut appends
one link (the run id, the cap, 8 h) and per step a second one that names
`<workflow>.<step>` — the gateway bills the last name — and sends
`x-macaroon`, `x-bf-dim-session-id: <workflow>` and `x-bf-dim-root-agent:
strut-agent`. A chat turn is one link billed as `strut-assistant`. The
format is the delegation's `v`:

- **v2** (Stadeum, the mothership gateway; gatekey 1.x): a chain of signed
  blocks plus a proof key. The delegation is two blocks: the org's grant to
  the person (`user_id`, `agents: [strut-agent]`) and the person's to strut
  (`agent: strut-agent`, `max_cost_usd` = the ceiling, its `run_id` = the
  delegation id), and its `proof` is the private key of strut's key. Each
  link is gatekey's `attenuate`: a block signed with the proof, naming a
  fresh Ed25519 key that becomes the new proof. So a holder can append but
  never drop a block (the parent's token would need the parent's key):
  `invalid_proof`. A run's block names no agent (strut-agent holds it); a
  step's or a chat turn's names the agent billed. Every block's caps apply
  at the gateway and nothing narrows, so a run cap above the ceiling is no
  error: the delegation's block stops the spend at the ceiling. No
  `max_steps` (a present cap must be non-zero; absent is none).
- **v1** (Hive, stakgraph's gateway on the swarms; gatekey 0.x as the npm
  alias `gatekey-v1`, `src/mothership-v1.ts`): an org-signed user
  authorization + a user-signed standing invocation, extended by keyless
  HMAC links. A link must narrow its parent, so each restates `max_steps: 0`
  and the lineage from `strut-agent`, and a run cap above the ceiling fails
  before any call. Kept while mcp runs strut against the swarms.

Delegations live in a second encrypted `FileSecretStore`
file, `mothership.json` beside `secrets.json`: never on the services bag (no
step can read another user's macaroon), never in the Secrets list. Tests:
`src/mothership.test.ts` verifies the built chain with gatekey's own
verifier, both versions — the TS mirror of the gateway's Go one;
`src/test-util/mint-delegation.ts` mints both. The default server builds it when
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

**Grants: model calls for a machine outside strut** (stakwork/pods PLAN.md
§3.2). `ctx.services.llm.grant({ name, hours })` → `{ id, env, expiresAt }`,
and `revoke(id)`: a pod's apps call the box's gateway themselves, billed to
the run's principal. Strut adds a link of the grant's own to that person's
delegation: its own run id (`grant-<nonce>`, so the
gateway caps it apart from any run), the cap (`STRUT_GRANT_MAX_COST_USD`,
$1000 by default, the owner's call on 2026-11-20; lowered to the
delegation's ceiling when that is less, so a person with a lower spending
limit still gets a grant), an expiry no later than `hours` from now (at most
24; or the person's authorization, when sooner), billed as the grant's
`name` (written as a step's agent name is, `[A-Za-z0-9_.-]`, at most 64). Then it
asks the host for a virtual key under the person's gateway customer:
`POST <STRUT_MOTHERSHIP_GRANTS_URL>` with the deployment key
(`Authorization: Bearer <STRUT_API_KEY>`) and `x-strut-actor`, body
`{ name, macaroon, max_cost_usd, expires_at }`; it answers `{ id, key,
address }`, the key joined as `<virtual key>.<macaroon>` and the address
the gateway's public route (`https://mothership.<box>`). `env` is the
standard variables: `OPENAI_BASE_URL` (`<address>/openai/v1`),
`OPENAI_API_KEY`, `ANTHROPIC_BASE_URL` (`<address>/anthropic`),
`ANTHROPIC_API_KEY`, the last two keys both the joined key; Gemini is left
out (its SDKs share no base-URL variable). `revoke` is `DELETE <url>/<id>`
with the deployment key and no person (a job's sweep releases with none); a
404 is fine. The `id` is the host's, and is what a step keeps (a job's
hold), never the key. On v2 the grant's block binds whoever holds the key:
the pod's code cannot drop it to spend under the person's delegation
(`invalid_proof`). On v1 it does not (gatekey 0.x carries each link's HMAC,
so the pod can present the person's bare delegation), which is why the cap
and the expiry are sent to the host too, and the key's own budget and
deletion hold it. No grant: a
strut without the Mothership, or without `STRUT_MOTHERSHIP_GRANTS_URL`, has
no `llm` on the bag; `grant` answers null when nobody can be billed here (no
principal, or no delegation for them), an error under
`STRUT_MOTHERSHIP_REQUIRED=1`; a host that refuses, a malformed
`STRUT_GRANT_MAX_COST_USD` or an expired delegation is an error. Either way the machine gets no
variables. The runner binds `llm` to the run's principal as it binds
`secrets` (`forPrincipal`, `bindPrincipal`), and a public run gets none: a
grant's spend is outside the run's own cap. Tests: `src/mothership.test.ts`
("grants for a machine outside strut"), against a fake host endpoint.

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
  providerOptions?, name?, images? }` → `{ path, url, mediaType, bytes, model, cost,
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
  keys in the environment) makes one real image per provider, then edits it.

  **An edit** (`images`): files of the run — paths, or what a `human` step's
  `attachments` hands out, so `images: "{{ photo.attachments }}"` transforms
  a worker's photo — read through `ctx.services.artifacts` by the agent's
  loader (`loadListedFiles`, src/ai/attachments.ts: the same caps, 5 MB an
  image), png/jpeg/gif/webp only, and sent as `generateImage`'s
  `prompt: { images, text }`. No list (a step that sent none) draws from the
  prompt alone. What each SDK does with them (read from the pinned
  sources, 2026-11-17): `@ai-sdk/openai` posts multipart to `/images/edits`;
  `@ai-sdk/google` puts them in a Gemini `generateContent` prompt as inline
  data (its Imagen models it refuses outright, edit or not); `@ai-sdk/xai`
  posts JSON to `/images/edits`, the image as a data URL; OpenRouter's
  provider sends them as `/images`'s `input_references` (every image model
  OpenRouter lists takes image input, but the two listed as text-only —
  Recraft V4.1 Flash — were unavailable, so whether OpenRouter refuses or
  ignores a reference such a model cannot take is unknown). No SDK drops
  them. **Edits through the gateway** (stakgraph-gateway as built from
  stakwork/stakgraph#1859 on 2026-11-12: Bifrost transports v2.2.2, commit
  fdeef8e3, its plugin on core v1.10.1; probed live 2026-11-17) ride
  `/openai/v1/images/edits`, Bifrost's image_edit: openai
  (`gpt-image-1-mini`) edits, its usage passed through with
  `input_tokens_details.image_tokens`; google
  (`gemini/gemini-2.5-flash-image`) reached Bifrost's gemini provider as an
  image_edit but was not run, the gateway holding no Google key
  (`no_key_supports_model`) — its gemini provider edits in source
  (generateContent with the images; Imagen's :predict); xai answers
  `unsupported_operation` ("image_edit is not supported by xai provider"),
  nothing sent to xAI; openrouter (`openrouter-images/…`) answers 404: the
  custom provider maps only generation onto OpenRouter's `/v1/images`, and
  OpenRouter has no `/v1/images/edits`. Those two carry no `routedEdits` in
  `MEDIA_MODELS`: their edit is refused before anything is sent, unless the
  grant allows a direct call (`resolveMediaModel(kind, { edit })` →
  `mediaProviders(kind, edit)`). A mask is not offered (xAI ignores one).
  **Cost**: OpenAI reports an edit's input image tokens
  (`input_tokens_details.image_tokens`), priced at the datasheet's
  `input_cost_per_image_token`; Gemini counts the image in its input tokens,
  priced at its input rate (the same for text and images); xAI and
  OpenRouter report the whole call's cost (an xAI edit $0.022 against $0.02).
  An OpenAI response without `input_tokens_details` would price every input
  token at the text rate, an undercount; none was seen, direct or through
  the gateway.
  A 5 MB (2600×2600) JPEG edits on xAI, OpenRouter (FLUX.2 klein) and OpenAI,
  direct and through the gateway: no downscale.

## Files

What each file and folder in this area is, in the order of the tree.

### `aieo/`

the npm package `aieo` (plans/aieo-in-strut.md), built from `src/aieo/` for the repos that still take it from npm (Hive, staklink, mcp): package.json (its version, the provider SDK pins — `src/aieo/pins.test.ts` holds them equal to strut's), tsup.config.js (entry ../src/aieo/index.ts; anthropic, google, openai and provider-utils inlined, as aieo always shipped), tsconfig.json for the build, scripts/ (the live probes: `npm --prefix aieo run try-numes`, keys from strut's `.env`). Nothing strut runs. `npm run build:aieo` → `aieo/dist/` (gitignored; tsup via npx, never a strut dependency), after `aieo/check-install.mjs` refuses an install whose inlined SDKs are not the pinned ones (0.2.8 shipped @ai-sdk/anthropic 4.0.60 from a stale checkout); published by hand: `yarn install --frozen-lockfile`, bump `aieo/package.json`, `npm run build:aieo`, `npm publish ./aieo`. strut itself has no aieo version: it runs `src/aieo/` at its own commit

### `src/aieo/`

aieo, the model layer (moved from stakwork/stakgraph's mcp/src/aieo, history kept): model names → a working AI SDK client (resolve.ts: aliases, `provider/id`, the OpenRouter prefix trap; provider.ts: keys and their companion headers, each provider's client and quirks — thinking rules, Maple's reasoning efforts, gateway paths — output caps, context windows, prices, `computeSessionCost`; the MODEL CATALOG, bifrost's datasheet as data — `loadModelCatalog`, the gateway's key rule, `getModelPrice`, consulted after Maple's and Numes' own tables and before the hand-kept ones, and an image model's prices (`getImagePrice`: image tokens or per image, never OpenRouter's rows, which are not what it charges; `computeImageCost`); `STRUT_MODEL_CATALOG`; MEDIA MODELS — `getMediaModel(kind, provider)` / resolve.ts `resolveMediaModel`: one `connect` (key, gateway, headers, fetch) shared with `getModel`, and one table, `MEDIA_MODELS`, of which providers make each kind (`image`: openai, google, xai, openrouter) and how each rides a gateway's OpenAI-compatible route — openrouter as the gateway's `openrouter-images` custom provider, Bifrost's own having no image generation — and which of them the gateway also EDITS for (`routedEdits`: openai, google); `mediaProviders(kind, edit?)`; a response's reported cost (`usage.cost`, xAI's ticks) put on the call's provider metadata, `mediaCostOf`; a kind is one more key in the table), the web tools (search.ts: native Anthropic or Exa; fetch.ts: native or a guarded HTTP fetch, citations), usage, and the helpers its npm users call (`callModel`, `ConversationStorage`). Strut imports it only through `loadAieo()` (llm.ts), lazily: its index loads every provider SDK. Its own env reads go through `env.ts` (`useEnv`), the one file env.test.ts lets read `process.env`. Its five suites sit beside the sources; the npm package is `aieo/` at the root

### `src/llm.ts`

resolveModel()/listModelOptions()/loadAieo(): strut's glue over aieo's resolve.ts (src/aieo/) — the chat, agent + llm steps resolve model NAME → provider/id/LanguageModel/output cap here; keys via ctx.services.secrets (store → env); backs GET /llm/models. Also the `llmAuth` seam (plans/mothership-cost-control.md §1): a host hook that returns {apiKey, baseUrl, headers} per call, consulted before the client is built; `stepAuth(ctx)` builds a step's call context. `resolveMediaModel(kind, opts)`: the same for a media model (the `image` step) — the grant's gateway when it routes that kind for the provider (for an `edit`, edits it), else direct only where the grant allows (`direct`), else refused before anything is sent

### `src/media.ts`

what a MEDIA step shares (`image` now, `video` next): `saveMedia` — the file where the run's files go (the run's artifacts, or the job's directory on a job run, a `job.update` to a listening host: browser screenshots' rule), `mediaFileName` (the author's `name`, else the step's place in the run — `each-3-pic` in a foreach — led by the run id on a job run), `imagePreview` (the 0.6× copy a model is shown, `sharp`, skipped where it cannot load)

### `src/media-seed.ts`

`image-gen` (src/workflows/image-gen.yaml), seeded at boot by content hash in category `media` like `private-ask`; `createStrut({ mediaWorkflows: false })` seeds none

### `src/mothership.ts`

OPT-IN Mothership cost control (plans/mothership-cost-control.md §3): createMothership({ dataDir, grantsUrl? }) → { llmAuth, grants?, mount }. `grants` is `ctx.services.llm` (model calls for a machine outside strut, a key the host makes per grant: "Grants" above). The host pushes one standing delegation per person (PUT /llm/delegations/:actor); strut extends it with a link per run and per step so the gateway bills user × workflow × step and caps the run. `openDelegation` picks the format by the macaroon's `v`: v2 (gatekey 1.x, signed blocks with a proof key) here, v1 in src/mothership-v1.ts; both hand back a `Link` (`extend`, `encode`). Delegations live in a second encrypted file (mothership.json), never on the services bag. A public run's own cap (`LlmAuthContext.maxCostUsd`, from `ctx.maxCostUsd` through `stepAuth`) makes the run link carry the smaller of it and the workflow's (src/run-cap.ts). Core never imports it

### `src/mothership-v1.ts`

`openV1`: a macaroon v1 delegation (gatekey 0.x through the `gatekey-v1` npm alias; what Hive mints and stakgraph's gateway on the swarms reads), checked and opened as a `Link` that appends keyless HMAC links restating `max_steps: 0` and the agent lineage. Loaded only for a `v: 1` delegation; delete it and the alias when the swarms retire

### `src/steps/lib/llm/`

llm/models: the model catalog `GET /llm/models` serves (every model aieo knows, each `available` when the host's `STRUT_MODELS` lists it or, with no list, when its provider has a key here; the deployment's default) over `ctx.services.llmModels`, the one list both read — what strut's own assistant app's model picker reads (plans/jamie-app.md §5). Not the `llm` core step: it calls no model
