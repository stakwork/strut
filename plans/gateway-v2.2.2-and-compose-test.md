# Task: upgrade the LLM gateway to Bifrost v2.2.2 and give strut a full local compose test through it

You are working in two sibling checkouts: this repo (`~/code/sphinx/strut`) and
`~/code/sphinx/stakgraph` (the gateway lives in `stakgraph/gateway`). Read
`AGENTS.md` here and `stakgraph/gateway/README.md` + `AGENTS.md` there first.
GOAL for everything you add: AS SIMPLE AS POSSIBLE.

## Why (context from the 2026-09-23 investigation)

Prod strut (embedded in stakgraph mcp under `/lab`) routes every LLM call
through the Mothership (`src/mothership.ts` → `llmAuth`) to
`stakwork/stakgraph-gateway`: a CUSTOM Bifrost build (dynamically linked
bifrost-http + our Go plugin `stakgraph-gateway.so` + a wrapper reverse proxy on
:8181). It is pinned to `transports/v1.6.2` (`gateway/Dockerfile` ARG
`BIFROST_VERSION`, `gateway/go.mod` `core v1.6.2`, both set 2026-07-01).

Bifrost only forwards Anthropic frames verbatim for Claude Code's user agent;
every other client (strut's UA is `ai-sdk/anthropic/…`) gets its stream
RE-RENDERED by Bifrost's converter. In v1.6.2 that converter has no branch for
`web_fetch` server-tool items, so when an Anthropic-model chat turn or `agent`
step calls the native `web_fetch` (or `web_search` with dynamic filtering) the
gateway emits `{"type":"content_block_start","index":1}` with NO
`content_block`, aieo's bundled `@ai-sdk/anthropic` rejects the chunk
(`Type validation failed … path: ["content_block"] … expected object, received
undefined`) and the whole turn dies. Confirmed on prod chat `mue7mh9f-o8wt8d`
(turns 1 and 2, 14:44 and 14:54 UTC) and reproduced locally with
`stakgraph-gateway:dev`; stock `maximhq/bifrost` v2.2.1/v2.2.2 and the direct
API stream the same requests fine. The fix landed upstream in
`transports/v1.6.3`; we are going to v2.2.2.

Facts that will save you time:
- aieo inlines its own copy of `@ai-sdk/anthropic` (`node_modules/aieo/dist/
  index.js`, `VERSION2 = "4.0.56"`); strut's own `@ai-sdk/anthropic` never
  parses streams. Reproduce with `aieo.resolveModel({ baseUrl })` +
  `streamText`, not `createAnthropic` from strut's node_modules.
- aieo routes non-Anthropic providers through the gateway's OpenAI-compatible
  path (`GATEWAY_PATHS`: anthropic → `/anthropic/v1`, everything else →
  `/openai/v1`, xai as `createOpenAI(...).chat("xai/<model>")`), so Grok/GPT
  chats never see Anthropic frames and their `web_fetch` is aieo's HTTP shim.
- Bifrost virtual keys are deny-by-default: a VK's `provider_configs` entry
  needs BOTH `key_ids: ["*"]` and `allowed_models: ["*"]` or inference fails
  with "no keys found" / "Provider 'anthropic' is not allowed".
- `transports/v2.2.2` requires `go 1.27.0`, `core v1.10.1`, `framework
  v1.7.3`, `plugins/{compat v0.3.2, governance v1.8.2, logging v1.8.2, maxim
  v1.7.5, modelcatalogresolver v1.1.5}` (its `transports/go.mod`).
- The plugin interface (`core/schemas/plugin.go`) gained ONE method between
  v1.6.2 and v2.2.2: `HTTPTransportPreAuthHook(ctx *BifrostContext, req
  *HTTPRequest) (*HTTPResponse, error)`. The other hook signatures are
  unchanged, but structs the plugin reads (`BifrostStreamChunk`, context keys,
  usage/pricing fields) may have moved: compile and fix.

## Part A — bump the gateway to transports/v2.2.2 (stakgraph repo)

1. `gateway/Dockerfile`: `ARG BIFROST_VERSION=transports/v2.2.2`, `ARG
   GO_VERSION=1.27.x` (a real published golang alpine tag), NODE_VERSION as
   the upstream `ui/` needs. Keep the three-stage shape (clone at tag → build
   ui → build bifrost-http dynamically → build plugin with `go mod edit
   -replace github.com/maximhq/bifrost/core=/src/core` → wrapper).
2. `gateway/go.mod`: `github.com/maximhq/bifrost/core v1.10.1` (+ whatever
   `go mod tidy` pulls). Add `HTTPTransportPreAuthHook` to `gateway/main.go`
   (delegate to `hooks` like the others, or return `nil, nil` if there is
   nothing to do pre-auth; say which and why in a comment).
3. `gateway/data/config.json` (seeded on every boot): check it still parses
   under 2.2.2 (`client`, `auth_config`, `plugins[].placement`,
   `config_store`). Read the upstream changelogs between the tags
   (`transports/CHANGELOG.md`, `core/CHANGELOG.md`) for config or behaviour
   changes that touch: virtual keys, `enforce_auth_on_inference`,
   governance headers (`x-bf-vk`, `x-bf-dim-*`), the logs store, and the
   Anthropic passthrough/converter.
4. `make docker-build && make docker-up` (its compose: redis + gateway on
   :8181). Then prove the bug is gone WITHOUT strut first:
   - create a VK (`POST /api/governance/virtual-keys`, basic auth
     `BIFROST_ADMIN_USER`/`PASS`, `provider_configs` per the fact above);
   - raw SSE: `curl http://localhost:8181/anthropic/v1/messages -H "x-api-key:
     <vk>" -H "user-agent: ai-sdk/anthropic/4.0.56" -d '{"model":
     "claude-sonnet-5","stream":true,"max_tokens":600,"tools":[{"type":
     "web_fetch_20260209","name":"web_fetch","max_uses":1}],"messages":[{"role":
     "user","content":"Fetch https://example.com/ with web_fetch and reply with
     its <title> text only."}]}'` — every `content_block_start` must carry a
     `content_block`, and a `web_fetch_tool_result` block must appear;
   - same with `web_search_20260209`, with `thinking: {type:"adaptive"}`, and
     with a plain client tool.
5. Run the gateway's own Go tests and the UI build. Commit on a branch in
   stakgraph; do not bump the mcp pin or publish an image unless asked.

## Part B — strut: a full docker compose test through our own gateway

Today `docker-compose.yml` here runs strut + Neo4j and strut calls providers
directly. Add a second, opt-in compose that puts OUR gateway (with the
Mothership) in the loop, so "strut agents through Bifrost" can be run, watched
and debugged locally, and so the exact failure above becomes a regression test.

Design (keep it small):

1. `docker-compose.gateway.yml`, used as `docker compose -f docker-compose.yml
   -f docker-compose.gateway.yml up --build`:
   - `gateway`: `build: { context: ${STAKGRAPH_DIR:-../stakgraph}/gateway }`,
     `image: stakgraph-gateway:dev`, port `8181:8181`, env
     `ANTHROPIC_API_KEY` (+ the other provider keys) from `./.env`,
     `BIFROST_ADMIN_USER`/`BIFROST_ADMIN_PASS` with dev defaults, plus
     `redis:7-alpine` only if the plugin needs it for what we test (it runs in
     "observability mode" without redis — prefer no redis unless required).
   - `strut`: NO provider keys in its environment (so a test can only pass by
     going through the gateway), `STRUT_API_KEY` and `STRUT_SECRET_KEY` set,
     `STRUT_MOTHERSHIP=1`, `STRUT_MOTHERSHIP_REQUIRED=1`. Depends on gateway
     health.
2. `src/server.ts`: honour `STRUT_MOTHERSHIP=1` → `createMothership({
   dataDir })`, pass its `llmAuth` to `createStrut`, call `mount(strut)`.
   Document the variable in AGENTS.md's Environment table. Nothing else in
   core changes; `createMothership` and `createStrut({ llmAuth })` already
   exist.
3. `scripts/gateway-smoke.ts` (tsx, opt-in; also wired as `npm run
   test:gateway` gated on `STRUT_TEST_GATEWAY=1` like `test:graph`):
   - wait for `http://localhost:8181/v1/models` (401 is "up") and strut
     `/health`;
   - create a VK on the gateway (see the deny-by-default fact);
   - mint a macaroon for a test actor exactly like Hive does — reuse the
     `mint()` fixture in `src/mothership.test.ts` (`gatekey`:
     `signUserAuthorizationSingle` + `signInvocation` for agent
     `strut-agent`); the gateway ships with `enforce_macaroons: false`
     (shadow mode: verify + WARN, never reject), which is enough here;
   - `PUT /llm/delegations/<actor> { macaroon, apiKey: <vk>, baseUrl:
     "http://localhost:8181" }` (Bearer `STRUT_API_KEY`);
   - run, with `x-strut-actor: <actor>`, and assert on the persisted events:
     a. `POST /chat` on an Anthropic model whose prompt makes the builder call
        `web_fetch` on a URL you control (`https://example.com/`); tail
        `/chat/:id/stream` to `chat.end`; assert a `web_fetch` tool-input
        event and no `chat.error`;
     b. a published workflow with an `agent` step (`web_fetch` + a bash echo)
        and an `llm` step; `POST /workflows/:name/run`, tail the run stream,
        assert `run.end` and the agent's `tool:web_fetch` step event;
     c. the same chat on `xai/grok-4.7` (OpenAI-compatible route) — must pass
        both before and after Part A;
     d. prove the traffic went through the gateway: Bifrost's logs (`GET
        /api/logs` with admin basic auth, or the container log lines
        `PreLLMHook provider=anthropic model=…`) show the calls with
        `x-bf-dim-session-id` = the workflow name / `strut-assistant`.
   - Negative control (regression guard for THIS bug): with
     `GATEWAY_IMAGE=<an image built at transports/v1.6.2>` (or
     `BIFROST_VERSION` build arg), (a) and (b) must fail with `Type validation
     failed: Value: {"type":"content_block_start"` — print the full error so
     the failure is recognisable. Skip the control when no such image exists;
     don't make it a hard dependency.
4. Debug affordances (this is the point of the exercise), documented in
   AGENTS.md under "Running":
   - `scripts/gateway-raw-sse.sh <base> <body.json>`: raw `data:` frames
     through any base URL (direct API or gateway), one line per event, so a
     malformed frame is visible without the AI SDK in the way;
   - `scripts/gateway-stream.mts <baseUrl|direct> <model> <text|tool|thinking|
     editor|websearch|webfetch>`: the same request through
     `aieo.resolveModel({ baseUrl })` + `streamText` with strut's real tool
     wiring (`createWebTools` from `src/llm.ts`, the anthropic text-editor
     tool from `steps/core/agent.ts`) — prints part counts or the full
     TypeValidationError;
   - how to read the gateway: dashboard at `http://localhost:8181` (admin
     creds), `docker compose logs gateway`, the VK/delegation curl one-liners.
5. Tests: keep `npm test` offline and green; the gateway smoke is opt-in.
   `cd web && npx tsc --noEmit && npx vite build` still pass. No new
   dependencies; `gatekey` and `aieo` are already here.

## Acceptance

- Part A: `stakgraph-gateway:dev` built from transports/v2.2.2 streams the
  raw web_fetch / web_search / thinking / tool requests with well-formed
  frames; Go tests pass; the plugin loads (no "plugin was built with a
  different version" error in the container log).
- Part B: `docker compose -f docker-compose.yml -f docker-compose.gateway.yml
  up --build` then `STRUT_TEST_GATEWAY=1 npm run test:gateway` passes end to
  end with strut holding no provider keys; the negative control reproduces the
  headless `content_block_start` frame against a v1.6.2 build.
- Everything new is documented in AGENTS.md (env vars, the compose overlay,
  the smoke test, the two debug scripts) in the existing style, briefly.
- Report at the end: what changed in the gateway to compile against 2.2.2,
  anything in Bifrost 2.x that changed behaviour for us (config keys, headers,
  governance), and the exact commands to run the compose test.
