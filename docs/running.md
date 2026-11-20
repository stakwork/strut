# Running, testing and deploying

Every way to run strut and its tests, the Docker image and compose files, and the deploy folders.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| Tests       | Node native test runner (`node:test`) via tsx                              |

## Running

```bash
# Engine
cd strut
npm install
npm test                    # ~4,800 tests
STRUT_TEST_SHARD=1/3 npm test   # one shard of the files (node's --test-shard), as CI's unit job runs three
npm run dev                 # starts Hono server on :3000 (workspace in Neo4j — see Environment)
STRUT_WORKSPACE_BACKEND=ladybug npm run dev   # the workspace on one LadybugDB file instead, <workspace>/graph/graph.lbug (the desktop's default; a filesystem workspace there is imported at this boot)

# Graph backend tests — LIVE, against a THROWAWAY Neo4j (they wipe it).
# Skipped entirely when STRUT_TEST_NEO4J_URI is unset. Add
# STRUT_TEST_EMBEDDINGS=1 to also run the real-model parity case (downloads
# ~90MB of ONNX weights into ~/.cache/strut-models on first run). One run per
# database at a time: a second run (another worktree) waits for the first
# (scripts/test-graph.mjs) — a bare `tsx --test` on a graph file skips that lock.
# One file: `npm run test:graph -- src/graph/claims.test.ts`. CI's graph job
# runs the Neo4j half only (STRUT_TEST_LADYBUG=off: the unit job runs Ladybug)
# in three shards (STRUT_TEST_SHARD=1/3 …, node's --test-shard), a Neo4j each.
# 5.19.0 is what the swarms run: a newer 5.x parses Cypher 5.19 refuses
# (`coalesce(all(…))`, 2026-10-22 — every node write failed on a swarm).
docker run -d --name strut-neo4j-test -p 7688:7687 -e NEO4J_AUTH=neo4j/struttest neo4j:5.19.0
STRUT_TEST_NEO4J_URI=bolt://localhost:7688 STRUT_TEST_NEO4J_PASSWORD=struttest npm run test:graph

# Run archive live test: the S3 client against a real S3-compatible store.
# Skipped unless STRUT_TEST_S3_BUCKET is set. It writes under
# strut-test/<random>/ in the bucket and deletes what it wrote. Without
# STRUT_TEST_S3_ENDPOINT it talks to AWS S3 (the key pair, or the default chain).
docker run -d --name strut-minio-test -p 9100:9000 -e MINIO_ROOT_USER=struttest -e MINIO_ROOT_PASSWORD=struttest123 minio/minio server /data
docker exec strut-minio-test mc alias set local http://localhost:9000 struttest struttest123
docker exec strut-minio-test mc mb local/strut-test
STRUT_TEST_S3_ENDPOINT=http://localhost:9100 STRUT_TEST_S3_BUCKET=strut-test STRUT_TEST_S3_ACCESS_KEY_ID=struttest STRUT_TEST_S3_SECRET_ACCESS_KEY=struttest123 npm run test:archive
# The same MinIO serves a local strut: STRUT_ARCHIVE_S3_ENDPOINT / _BUCKET /
# _PREFIX / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY, with STRUT_RETENTION=1m
# to see a log leave (the sweep runs at boot, then hourly).

# Speech-to-text live test — needs the sherpa addon (optionalDependency,
# installed by `npm install` on supported platforms) and downloads the 57 MB
# kroko model into STRUT_TEST_STT_MODEL_DIR (temp dir when unset).
STRUT_TEST_STT=1 npm run test:stt
# + Parakeet (482 MB) through the dictation picker: download, verify,
# extract, transcribe kroko's clip; logs the time.
npm run test:stt:parakeet

# Text-to-speech live test — downloads Kokoro (350 MB) and kroko (57 MB, to
# hear the reply back) into STRUT_TEST_TTS_MODEL_DIR (temp dir when unset);
# logs time to first audio, total, audio length and real-time factor.
npm run test:tts

# Image generation live test — one real image per provider whose key is in
# the environment (xAI $0.02, OpenAI gpt-image-1-mini low ~$0.002, FLUX.2
# klein through OpenRouter $0.014), through the `image` step, direct:
STRUT_TEST_IMAGE=1 npx tsx --env-file=.env --test src/steps/core/image.live.test.ts

# Dictation's fixer: node-llama-cpp lives in fixer/ (its own lockfile, never
# strut's dependencies). Install it to run the eval (the Qwen3 GGUFs in
# ./.models/gguf) or to check its types against fixer-engine.ts.
yarn --cwd fixer install --frozen-lockfile --ignore-scripts
npm run check:fixer
npm run eval:dictation

# Web UI (dev mode with HMR)
cd strut/web
npm install
npm run dev                 # Vite on :5173, proxies API to :3000

# The store front (`?store=1`) of this checkout over a deployed index's open reads
# (web/vite.config.ts proxies `/index` there; `.claude/launch.json`'s `store` runs it on :5183):
cd strut/web && STRUT_DEV_INDEX=https://index.stakwork.ai npm run dev   # → http://localhost:5173/?store=1

# Web UI (production build, served by engine)
cd strut/web && npm run build  # outputs web/dist/
cd strut && npm run dev        # serves API + UI on :3000

# The app kit (kit/, plans/apps.md §3). Its VENDOR LAYER — kit/vendor, the frozen
# browser bundles + import-map.json every APP build resolves against (`app/build`,
# `POST /apps`) — is built by strut's own `npm run build` (= build:engine +
# build:kit, so `prepare` builds it too): scripts/build-kit.mjs installs the kit's
# dependency set into kit/node_modules from kit/yarn.lock (yarn v1; never into
# strut's node_modules, which carries no React) and runs its `build:vendor`.
# ~7 s warm; a cold cache downloads ~410 MB in ~15 s.
npm run build:kit           # the vendor layer alone
npm run test:app-build      # builds the fixture app (src/apps/__fixtures__/hello) with build/ against it
# Where each deployment finds it (src/apps/kit.ts: `@strut/kit` when pinned, else <strut>/kit):
#   checkout, mcp host   <strut>/kit/vendor — `npm run build` / `prepare`; package.json `files`
#                        ships kit/vendor + kit/src/styles/base.css in a git-dependency install
#   Docker image         /usr/src/strut/kit/vendor — the Dockerfile's `kit` stage; the image
#                        build runs test:app-build and fails without a document
#   desktop package      <stage>/kit/vendor — copied by package-desktop.mjs, which also moves
#                        esbuild's binary into native/ (desktop.js sets ESBUILD_BINARY_PATH)
# Unbuilt, an app build's error says so; the app tests build the layer into a temp
# dir when it is missing. The kit's own tests (in the root `npm test`) and its
# library build need the kit's install:
cd strut/kit && yarn install --frozen-lockfile --ignore-scripts
yarn build                  # vendor/ and dist/ (the library), ~2 s

# Docker — the standalone image (Dockerfile), media tools baked in (ffmpeg,
# yt-dlp, tesseract, poppler, pandoc, agent python venv, uv), on the GRAPH
# backend beside its own Neo4j 5.26 LTS, pinned (jarvis ontology seeded, MiniLM embeddings on).
# Data lives in named volumes: neo4j, workspace, models, uv cache. Neo4j's host
# ports are offset (Browser :7475, bolt :7689; STRUT_NEO4J_HTTP_PORT /
# STRUT_NEO4J_BOLT_PORT) to stay clear of a local Neo4j and the test:graph one.
# The browser/* steps drive the `browser` service (ghcr.io/stakwork/strut-browser,
# from images/browser) over BROWSER_WS_URL + BROWSER_WS_PATH; it sits on a
# network of its own that strut joins, so a page reaches strut but not Neo4j.
docker compose up -d           # http://localhost:3000 (STRUT_HOST_PORT=3100 when `npm run dev` has 3000) — pulls ghcr.io/stakwork/strut:latest (STRUT_IMAGE_TAG=<sha> pins one)
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build   # this checkout's code instead
# Same image on the fs backend, no Neo4j (`docker compose up -d browser` first for the browser steps):
docker compose run --rm --no-deps --service-ports -e STRUT_WORKSPACE_BACKEND=fs strut

# A package INDEX (deploy/index/): the index strut + a Pkarr relay
# behind Caddy, on a box of its own. Two hostnames pointed at it, ports 80 + 443
# open (Caddy's certificates), UDP 6881 open (the relay's DHT node). BACK UP the
# strut volume before the first row: the index key is minted into publisher.json
# then, sealed under STRUT_SECRET_KEY — keep the two apart. Locally, the hosts
# index.localhost + relay.localhost get Caddy's own certificates:
cd deploy/index && cp env.example .env   # fill in hosts + keys
docker compose up -d
curl -s https://$STRUT_INDEX_HOST/index/catalog      # the index card, open to anyone
curl -s https://$PKARR_RELAY_HOST/<z32 key>          # a Pkarr record through the relay

# Browser live test — the service against a real Playwright server:
docker run --rm -d -p 3300:3000 -e BROWSER_WS_PATH=devpath ghcr.io/stakwork/strut-browser:1.64.1
BROWSER_WS_URL=ws://127.0.0.1:3300 BROWSER_WS_PATH=devpath npm run test:browser

# Through OUR LLM gateway (stakgraph-gateway: Bifrost + the governance plugin,
# built from ${STAKGRAPH_DIR:-../stakgraph}/gateway) with the Mothership on.
# strut gets NO provider keys (only the gateway reads ./.env) and its own
# workspace volume, so anything that works went through the gateway.
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up --build
STRUT_TEST_GATEWAY=1 npm run test:gateway   # scripts/gateway-smoke.ts: VK + minted
  # delegation, then an anthropic chat with web_fetch, an agent+llm run, an xai
  # chat, and the calls in the gateway log under their session dims
# The gateway mangles Anthropic's SERVER-EXECUTED tools (Bifrost re-renders
# both directions): v2.2.2 and upstream latest drop `server_tool_use.input`
# from a web_search already in the history, so the model's next request is a
# 400 (`…server_tool_use.input: Field required`); v1.6.2 (tagged
# stakgraph-gateway:v1.6.2) emitted headless `content_block_start` frames for
# web_fetch. So a ROUTED call never uses them — `createWebTools({ routed })`
# hands out aieo's Exa + HTTP shims, plain tool calls the gateway forwards
# untouched — and the smoke test passes on every build. Probe a gateway's
# native handling directly, with strut's tools but no strut server (a few
# times: a search the model routes through code execution keeps its query):
VK=… npx tsx scripts/gateway-stream.mts http://localhost:8181 sonnet websearch-tool
# Swap in another gateway build without rebuilding it:
GATEWAY_IMAGE=stakgraph-gateway:v1.6.2 docker compose -f docker-compose.yml \
  -f docker-compose.gateway.yml up -d --no-deps --no-build gateway

# Debugging the gateway path:
#  - dashboard http://localhost:8181 (admin / bifrost-dev-password);
#    `docker compose -f docker-compose.yml -f docker-compose.gateway.yml logs -f gateway`
#    (PreLLMHook provider=… model=… lines, macaroon shadow-mode WARNs)
#  - a VK: curl -u admin:bifrost-dev-password localhost:8181/api/governance/virtual-keys \
#      -H content-type:application/json -d '{"name":"dev","provider_configs":[{"provider":"anthropic",
#      "weight":1,"key_ids":["*"],"allowed_models":["*"]}]}'   (deny-by-default: both lists)
#    Allow one provider per model family: governance load-balances a model over
#    every allowed provider serving it, and via openrouter claude loses web_fetch.
#  - delegations: curl -H "authorization: Bearer strut-dev-key" localhost:3000/llm/delegations
#  - raw frames, no AI SDK: scripts/gateway-raw-sse.sh <base> <body.json>
#    (VK=… for the gateway's /anthropic, ANTHROPIC_API_KEY direct)
#  - through aieo + strut's real tools, printing part counts or the full
#    error (a TypeValidationError names the bad frame; an APICallError the
#    rejected request): npx tsx scripts/gateway-stream.mts <baseUrl|direct> \
#      <model> <text|tool|thinking|editor|websearch|webfetch|websearch-tool|webfetch-tool>
#    (VK=… for a gateway; the `-tool` cases make a SECOND request carrying the
#    native tool's block in history — the request-path round trip)
```

### Previewing an app against a live strut (`scripts/preview-app.mjs`)

To try a change to `strut/views`, the kit or an app on a swarm's real runs
before it is merged and deployed (merge → stakgraph → the swarms' nightly
update is a day a round), run that app on THIS checkout with the swarm's
data:

```bash
yarn install    # once per checkout: its prepare builds the kit's vendor layer and the UI
LAB_KEY=<the swarm's API key> node scripts/preview-app.mjs \
  --lab https://<swarm>.sphinx.chat:3355/lab --app openlaw-benchmarks \
  --allow openlaw/runs,openlaw/list-tasks,openlaw/task-details --watch
# → open http://localhost:4317/?app=openlaw-benchmarks
```

It downloads the app's source (its active version; `--version vN`), boots a
local strut from this checkout (127.0.0.1:3317, a workspace under
`<tmp>/strut-preview/<app>/`, the filesystem backend, its log beside it),
adds a stand-in for each workflow the manifest grants, publishes the app,
and serves it through a proxy on 127.0.0.1:4317. The page, its build and
its own state (`app/*`) are local, so `strut/views` and the kit are this
checkout's. An app's `step_run` of a READ — the run reads, the graph reads,
`sheets/get-values`, and what `--allow` adds (the app's own read steps: name
only steps that write nothing) — goes to `POST <lab>/steps/<type>/run` with
LAB_KEY. Anything else (a launch, a write, an unlisted step) is refused in
the proxy and never reaches the swarm; nothing it reads is stored; LAB_KEY
is never passed to the local strut. Not checked: the app's grants (the
reads go out with the deployment key).

`--watch`: a change to the app's source (`--app-dir`, default
`<tmp>/strut-preview/<app>/app` — kept across runs, downloaded only when it
holds no app.yaml) republishes it; a change under `src/apps/views/src`
restarts the local strut (strut/views is seeded at boot); one under
`kit/src` rebuilds `kit/vendor` first (an app resolves `@strut/kit`
through the vendor layer, not kit/src). Every publish carries a
`preview-stamp.txt`, so it is always a new version and rebuilds. The proxy's
allow/refuse logic is tested in `scripts/preview-app.test.mjs`.

### Payments locally (`scripts/fake-sphinx-daemon.ts`)

A stand-in for the Sphinx treasury daemon (specs/LIGHTNING.md), so strut
takes payments IN and sends payouts OUT on a laptop or in an end-to-end
test, with no mixer and no real sats:

```bash
PORT=3461 TOKEN=demo PAY_TOKEN=demo-pay MESSAGE_TOKEN=demo-message SETTLE_AFTER_MS=3000 \
STRUT_URL=http://127.0.0.1:3000 STRUT_HOST_KEY=dev-host npm run dev:fake-daemon
LIGHTNING_DAEMON_URL=http://127.0.0.1:3461 LIGHTNING_DAEMON_TOKEN=demo \
LIGHTNING_DAEMON_PAY_TOKEN=demo-pay LIGHTNING_DAEMON_MESSAGE_TOKEN=demo-message \
STRUT_RATE_URL=http://127.0.0.1:3461/prices STRUT_HOST_KEYS=sphinx:dev-host \
STRUT_API_KEY=dev-key STRUT_WORKSPACE_BACKEND=fs npx tsx src/server.ts
```

- **In** (the receive token): `POST /invoice` makes a readable BOLT11 with
  a real preimage; it settles `SETTLE_AFTER_MS` after it was made, as if
  someone paid it (`0`: only by hand), or at once on `POST
  /settle/:payment_hash`. `GET /invoice/:hash`, `GET /payments`, `GET
  /balance` (`START_SATS`, default 100,000, plus what came in, less what went
  out).
- **Out** (the pay token alone, which must differ from the receive token, as
  the boot requires): `POST /pay` (an admin's Withdraw) and `POST /keysend` +
  `GET /keysend/:id` (a worker's payout), idempotent as the real daemon is.
  Each settles at once and debits the amount plus the LSP's fee floor
  (`lspFeeFloorMsat`), or fails `not enough balance`. `POST /next-payout
  { "state": "failed" | "pending" }` makes the next one fail, or stay pending
  until `POST /settle/:id` (a keysend's id, or a pay's payment hash).
- **Support's DMs** (plans/support-chat.md §7, as stakwork/sphinx#435 built
  them; the MESSAGE token alone, `MESSAGE_TOKEN`, default `demo-message`,
  set as `LIGHTNING_DAEMON_MESSAGE_TOKEN`): `GET /dms?after=`, `GET
  /dm/:id/file` (`413 too_large` over 25 MiB, `410 deleted`), `POST /dm`
  (`400 not_a_contact`, `400 too_long`; `file { data, type, name }`), `PUT
  /dm/photo` / `DELETE /dm/photo`, `POST /dm/:id/delete`, as
  stakwork/sphinx#436 answers them. Play a worker with `POST /worker-dm {
  pubkey?, alias?, text?, replyTo?, sats?, time?, file?: { name, type,
  base64 } | { name, type, size } }` (a new pubkey is a contact first),
  `POST /worker-contact { pubkey?, alias? }` (a key exchange alone: what
  fires the welcome), `POST /worker-delete/:id`; `POST /next-dm { "state":
  "failed" | "pending" }` makes the next send fail, or wait for `POST
  /settle/<id>`; `GET /worker-photo` and `GET /worker-file/:id` (open) say
  what a worker sees. Strut reads none of the feed itself: started with
  `STRUT_URL` and `STRUT_HOST_KEY` (strut's `STRUT_HOST_KEYS=sphinx:<it>`),
  the stand-in PUSHES each record, a worker's file with its bytes, to
  strut/staff's `support/receive` (plans/people-and-hosts.md §5, §7), one
  call at a time, again every second until strut answers a `2xx`. Then
  `?app=strut/staff&input=tab%3Dsupport`; the staff app acts as the admin a
  ticket names (`POST /auth/ticket { actor, role: "admin" }`, then the UI
  at `/?ticket=<it>`). src/apps/support.test.ts runs it all against a
  strut served on a port.
- **Strut's host** (plans/jamie-in-tribes.md §5.1): the stand-in links
  nobody. A person links their Sphinx account through Peel
  (plans/people-and-hosts.md §2.1; src/people-link.test.ts signs as Peel
  does), and a mention is played with curl (specs/API.md §13.4).
- **The rate**: `GET /prices` answers mempool's `{ time, USD }`
  (`USD_PER_BTC`, default 100,000, so $1 is 1,000 sats).
- In a test, `startFakeSphinxDaemon({ port: 0, … })` starts it in-process and
  answers `{ url, close }` (scripts/fake-sphinx-daemon.test.ts drives it with
  `SphinxDaemonProvider` and `SphinxDaemonPayer`).

What else a paid flow needs, each learned the hard way:

- **An owner before a price.** `PUT /public-view` refuses a runnable
  workflow that spends (a model call) and has no owner ("spends … no owner
  to pay for a stranger's run"). Set one first: `PUT /workflows/:name/owner
  { "owner": "<actor>" }`.
- **A public app is held.** Once `PUT /public-view` adds an app, a republish
  is only a draft (`live: false`). Make it live with `PUT /apps/:name/active
  { "version": "vN" }`, which takes a new release and its lock.
- **Worker payouts are off until an admin turns them on**: the Payouts tab in
  `strut/staff`, or `PUT /tasks/payouts/settings { "on": true, "minSats":
  1000, "workerDaySats": 1000000, "serverDaySats": 10000000 }` (all four;
  `inviteSats` beside them is an invite's default, 100 when left out).
- **Inviting a worker** (plans/human-steps.md §5.8): Invite a worker in
  `strut/staff` (its header, on every tab, or a type's page), or `POST
  /tasks/invites {}` (`{ "type": "<type>" }` for one kind of work), asks the
  stand-in's `POST /invite` (with the pay token; it debits the sats and its
  price, `INVITE_PRICE_SATS`, 10) and answers the join link, which opens
  Tasks. It needs Tasks in the public view (`no_worker_app` otherwise; the
  panel's Put Tasks online, or `POST /tasks/online`). The stand-in's invite is `ready`
  at once (`/next-payout` `pending` holds it `sending` until `POST
  /settle/:code`; `failed` fails it), `POST /use-invite/:code` marks it
  used, and `GET /invites` and `POST /invite/:code/cancel` answer as the
  daemon's do. Open the link's `/public/join` in a desktop browser for the
  QR code, or with an Android user agent for Peel's `intent://`.
- **A worker withdraws only to the Sphinx address their session carries**
  (docs/tasks.md, "Withdraw"; else `no_address`). A `sphinx` sign-in keeps
  it (`keptSphinxAddress`, src/visitors.ts): `POST /visitors/session
  { challenge, method: "sphinx", key, sig, address }`, kept only when the
  address's pubkey is the key that signed. Peel sends it; a test can make
  its own: a secp256k1 key signs `GET /visitors/challenge`'s challenge as a
  Lightning signed message (`lnSign` in src/visitors.test.ts) and posts
  `address: "<its 33-byte key, hex>_<any 33-byte key>_<any scid>"`, which
  the stand-in keysends to. The public view must offer `sphinx` (the default
  once an app is public) with the default root `visitorKey`: a domain's
  child key keeps no address. The challenge is signed with `STRUT_API_KEY`
  or `STRUT_SECRET_KEY`, so set one.

## Files

What each file and folder in this area is, in the order of the tree.

### `package.json`

engine deps (hono, zod, ai sdk)

### `Dockerfile`

standalone server image: node + media/document CLIs + agent venv + uv, fs backend on a bare `docker run`

### `docker-compose.yml`

the standalone compose: the PUBLISHED image (ghcr.io/stakwork/strut:${STRUT_IMAGE_TAG:-latest}, pushed from main by .github/workflows/publish-image.yml) on the graph backend + a PINNED Neo4j (`neo4j:${STRUT_NEO4J_TAG:-5.26.32}`, the 5.x LTS patch the old floating `neo4j:5` tag named, so its volumes open; never moved by an image update) + the browser (`${STRUT_BROWSER_TAG:-1.64.1}`) (named volumes for neo4j data, /data/workspace, /data/models, uv cache) — nothing built. A box that follows a release CHANNEL sets `STRUT_IMAGE_TAG=stable` and `STRUT_BROWSER_TAG=stable`: `.github/workflows/promote-image.yml` (run by hand with a commit on main) copies that commit's image to the channel tag by digest and moves strut-browser's tag of the same name to the Playwright version the commit pins

### `docker-compose.build.yml`

overlay: strut built from this checkout (`build: .`, `strut:local`) — for working on strut itself; docker-compose.gateway.yml builds it too

### `deploy/index/`

a package INDEX alone (plans/marketplace.md §7, §13), run from this folder (`.env` beside it, from env.example): docker-compose.yml — the published strut image with the index role (`STRUT_INDEX=1`, fs backend, `STRUT_INDEX_URLS` from `STRUT_INDEX_HOST`) + Pkarr's own relay image (`synonymsoft/pkarr-relay`, its DHT node on UDP 6881) behind Caddy for TLS, two hostnames, compose project `strut-index`; no Neo4j, no browser, no lab — the box that holds the index key every strut's defaults name. Caddyfile (one site per hostname; SSE flushed), pkarr-relay.toml (cache on its volume, rate limits `behind_proxy` since only Caddy reaches its HTTP side)

### `deploy/voice/`

a VOICE DEMO (plans/private-voice.md), run from this folder like deploy/index: the published strut image on Ladybug + sphinx-voice's 1:1 mode (`node dist/one-to-one.js`, connecting out to the central LiveKit) behind Caddy for TLS, compose project `strut-voice`, and Maple's inference proxy (`maple`, internal only: strut gets `MAPLE_BASE_URL` and an optional `MAPLE_API_KEY`, for `VOICE_MODEL=maple/gemma4-31b` once the strut image has aieo's `maple` provider); host-config.json names the orchestrator Jamie. README.md: an AMD SEV-SNP EC2 box, the models warmed, Peel's development Talk home, the attestation report — and the call audio end-to-end encrypted (a key Peel makes per call, the voice service and Peel join the room with it), and what the demo is not (no attested image, the model call leaves the box)

### `deploy/app/`

a SERVED APP (plans/app-repos.md §4.5), run from this folder like deploy/index: the published strut image on Ladybug (one volume, `/data`) with `STRUT_SERVE` (+ `STRUT_SERVE_URL` for a `pk:` ref, `STRUT_SERVE_TOKEN_SECRET` for a private repo) naming the package — a repository's branch, `git+https://…@main`, by default, behind Caddy for TLS on one host (`STRUT_APP_HOST`), compose project `strut-app`; every line of `.env` reaches strut (`env_file`), so the model keys, the wallet and the package's `requires.secrets` values go there. README.md: a package's `serve.yaml`, a repository as its home or publishing one from a strut (`serve` on `POST /packages/publish`), the box, `GET /serve`, `/?shell=1`, and following new commits (the push webhook at `/serve/sync`) and releases

### `tsconfig.json`

strict, Node16 module, types: ["node"]
