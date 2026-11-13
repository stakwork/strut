GOAL: AS SIMPLE AS POSSIBLE!

# strut

Minimal workflow engine with HTTP API and web UI. See `specs/SPEC.md` for
the full design spec (sections 1-15). This file covers how to work
on the codebase.

Companion specs: `specs/EVAL_SPEC.md` — how a run gets scored (the measurement
substrate). `specs/EVOLVE_SPEC.md` — what varies between measured runs: the three
self-evolution layers (prompts / environment / structure), what promotes to a
versioned artifact, and what must never evolve. `specs/ENV_SPEC.md` — the
tools a workflow can call: a versioned manifest, the user-space prefix it is
synced into under `dataDir`, and how the builder adds a binary on a running
server without a rebuild (proposed).

## How this file works

Every session in this repo loads this file, so it holds only what every
change needs: what strut is, where each area lives, the rules that hold
everywhere, and the checklists. Each area's detail (what every file does,
how each feature works, and why) is in `docs/<area>.md`. Read the area's doc
before you change code in it. `grep -n '<file or name>' docs/*.md` finds any
file's entry or any feature by name.

When you change an area, update its doc in `docs/`, not this file. This file
changes only when an area is added, renamed or removed, or a rule that holds
everywhere changes. Keep it under 30 KB. It reached 629 KB (about 200k
tokens, carried by every request) before it was split on 2026-11-12.

## Areas

Paths are under `src/` unless they say otherwise; `x/*` is the step
namespace `src/steps/lib/x/`.

| Area | Doc | Where |
| --- | --- | --- |
| The engine: workflows, steps, runs, run control, the services bag, artifacts, shell | [docs/engine.md](docs/engine.md) | `core.ts`, `runner.ts`, `expr.ts`, `journal.ts`, `run-control.ts`, `park.ts`, `store.ts`, `workspace.ts`, `closure.ts`, `runs.ts`, `run-view.ts`, `provenance.ts`, `capabilities.ts`, `extensions.ts`, `shell.ts`, `steps/core/`, `steps/registry.ts`, `run/*` |
| The server: `createStrut()`, callbacks, rooms, the drain, the events sink, MCP servers, peers | [docs/server.md](docs/server.md) | `createStrut.ts`, `server.ts`, `callback.ts`, `rooms.ts`, `drain.ts`, `events-sink.ts`, `mcp-servers.ts`, `mcp-registry.ts`, `peers.ts`, `strut/*`, `specs/` |
| Auth, secrets and the env boundary | [docs/security.md](docs/security.md) | `auth.ts`, `secret-store.ts`, `actor-secrets.ts`, `env.ts`, `step-lint.ts`, `secret/*` |
| Models: aieo, LLM calls, media, the Mothership | [docs/models.md](docs/models.md) | `aieo/`, `llm.ts`, `media.ts`, `media-seed.ts`, `mothership.ts`, `llm/*`; the npm package in `aieo/` at the root |
| The `agent` step and agent sessions | [docs/agent-step.md](docs/agent-step.md) | `steps/core/agent.ts`, `session-store.ts`, `acp/*` |
| The AI workflow builder (chat and `builder` job) | [docs/builder.md](docs/builder.md) | `ai/`, `chat-store.ts`, `chat-view.ts`, `compaction.ts`, `builder-seed.ts`, `meta/*` |
| Jobs, conversations, wakes, live feeds, proposals, seeded workflows | [docs/jobs.md](docs/jobs.md) | `jobs.ts`, `job-*.ts`, `wake.ts`, `conversations.ts`, `live-feed.ts`, `proposals.ts`, `proposal-feed.ts`, `artifact-refs.ts`, `orchestrator-seed.ts`, `system-workflows.ts`, `workflows/`, `job/*`, `conversation/*`, `proposal/*` |
| Automations (schedules) | [docs/automations.md](docs/automations.md) | `automations.ts`, `scheduler.ts`, `automations-routes.ts`, `automation/*` |
| Claims, sealing, Concepts, the dream, history | [docs/knowledge.md](docs/knowledge.md) | `claims-*.ts`, `verify.ts`, `ledger.ts`, `sealed.ts`, `knowledge.ts`, `history.ts`, `concept-seed.ts`, `concepts/`, `graph/claims*.ts`, `knowledge/*`, `dream/*`, `history/*`, `context/*` |
| The graph layer: Neo4j and LadybugDB | [docs/graph.md](docs/graph.md) | `graph/`, `graph-writes.ts`, `graph/*`, `memory/*` |
| Apps, the kit, channels | [docs/apps.md](docs/apps.md) | `apps/`, `channels.ts`, `channels-peer.ts`, `brand.ts`, `app/*`, `channel/*`; `kit/` at the root |
| Packages, indexes, the store, serve mode | [docs/packages.md](docs/packages.md) | `packages/`, `package-lookup.ts`, `tar.ts`, `package/*` |
| The public view, visitors, public runs and tools | [docs/public.md](docs/public.md) | `public-surface.ts`, `public-routes.ts`, `public-runs.ts`, `public-tools.ts`, `public-agents.ts`, `public-call.ts`, `public-runnable.ts`, `public-view.ts`, `visitors.ts`, `visitor-address.ts`, `guarded-http.ts` |
| Payments: credit, the wallet, earnings, buying from another strut | [docs/payments.md](docs/payments.md) | `payments/`, `l402.ts`, `public-credit.ts`, `remote.ts`, `run-cap.ts`, `earnings/*`, `remote/*` |
| Human steps and the task store | [docs/tasks.md](docs/tasks.md) | `tasks/`, the `human` core step, `task/*` |
| Speech, dictation, voice | [docs/audio.md](docs/audio.md) | `audio/`, `voice.ts`, `dictation/*`; `fixer/` at the root |
| Private AI | [docs/privacy.md](docs/privacy.md) | `privacy/`, `privacy/*` |
| The browser | [docs/browser.md](docs/browser.md) | `browser/`, `browser/*`; `images/browser/` at the root |
| Lib steps that are integrations, and lib step credentials | [docs/steps.md](docs/steps.md) | `steps/lib/`: `git/*`, `http/*`, `docx/*`, `sheets/*` |
| The web UI | [docs/web.md](docs/web.md) | `web/` at the root |
| Running, testing, Docker, deploying | [docs/running.md](docs/running.md) | `package.json`, `Dockerfile`, `docker-compose*.yml`, `deploy/` at the root |
| Environment variables | [docs/environment.md](docs/environment.md) | every variable strut reads |
| Moving strut between hosts, home sync | [docs/moving.md](docs/moving.md) | `move/`, `moved.ts`, `home-sync.ts` |

## Stack

| Concern | Choice |
| --- | --- |
| Engine | TypeScript (Node 22+), Zod for schemas, custom expression evaluator |
| HTTP | Hono + @hono/node-server |
| Persistence | One interface per layer (`WorkspaceStore`, `RunStore`, `ChatStore`, `SecretStore`, `SessionStore`) with File + Memory impls. The workspace is on Neo4j by default, one LadybugDB file, or plain files. Local blobs live under an explicit `dataDir` |
| Web UI | Preact + Vite + system-canvas-react. Vanilla CSS, no Tailwind |
| Tests | Node native test runner (`node:test`) via tsx |
| LLM | Vercel AI SDK over aieo, strut's own source in `src/aieo/`, lazy-loaded. `ai`, `zod` and `@ai-sdk/anthropic` are peerDependencies (see "One copy per process" below) |
| Browser | `playwright-core`, pinned to images/browser's Playwright, and `sharp`, both lazy-loaded |
| Embedded graph | `@ladybugdb/core` (LadybugDB), an optionalDependency with a native addon, loaded on first use |

## Layout

```
strut/
├── specs/            # design specs: SPEC.md first; API.md is every HTTP endpoint
├── plans/            # one plan per feature; a record once it is built
├── docs/             # the area references this file indexes
├── src/              # the engine and the server (see Areas)
│   ├── steps/core/   # built-in core steps, statically imported
│   ├── steps/lib/    # lib steps, <namespace>/<name>.ts, found at registry build
│   ├── workflows/    # the workflows strut seeds at boot
│   ├── concepts/     # the Concept pages strut seeds at boot
│   └── apps/         # the app build and the apps strut seeds
├── web/              # the UI
├── kit/              # @strut/kit, what apps build against (a package of its own)
├── aieo/             # the npm package aieo, built from src/aieo/
├── fixer/            # node-llama-cpp for dictation's fixer (a package of its own)
├── images/browser/   # the Playwright server image
├── deploy/           # the index, voice and app deployments
└── scripts/          # dev, packaging and test scripts
```

## Running

```bash
npm install
npm test                    # every *.test.ts under src/, kit/src/ and web/src/; live suites skip themselves (~1 min)
npm run dev                 # the server on :3000, its workspace in Neo4j
STRUT_WORKSPACE_BACKEND=ladybug npm run dev   # one LadybugDB file instead (`fs`: plain files)
cd web && npm install && npm run dev          # the UI with HMR on :5173, proxying the API to :3000
```

The graph suites run against a throwaway Neo4j, which they wipe:

```bash
docker run -d --name strut-neo4j-test -p 7688:7687 -e NEO4J_AUTH=neo4j/struttest neo4j:5.19.0
STRUT_TEST_NEO4J_URI=bolt://localhost:7688 STRUT_TEST_NEO4J_PASSWORD=struttest npm run test:graph
```

Everything else (speech, the browser, the gateway, the kit, Docker, previewing
an app against a live strut) is in [docs/running.md](docs/running.md). Every
environment variable is in [docs/environment.md](docs/environment.md).

## Core ideas

Each is explained in its area's doc; these hold in every change.

- **Workflows are YAML**, the one format. Quote every template: write
  `pull_number: "{{ input.x }}"`, because an unquoted `{{` is a YAML flow
  mapping. A publish refuses the broken form. ([engine](docs/engine.md))
- **`input` is the run's subject and `params` are its tunable defaults.** A
  step waits for the steps in its `depends`; with no `depends` it follows the
  step before it, and `depends: []` runs it at once. ([engine](docs/engine.md))
- **Steps reach the world only through `ctx.services`**: `http`, `secrets`,
  `artifacts`, `shell` and the rest. A step never reads `process.env` and
  never spawns a child itself. ([engine](docs/engine.md),
  [security](docs/security.md))
- **Runs launch detached.** A client watches one by tailing its append-only
  event log, which is the record of the run. ([engine](docs/engine.md))
- **No public endpoints.** With `STRUT_API_KEY` set, one gate covers every
  route. Only the UI's files, `GET /health` and `/public/*` (what a person put
  in the public view) answer without it. ([security](docs/security.md),
  [public](docs/public.md))
- **History sent to a model is append-only.** Never rewrite an earlier
  message: the prompt cache and signed thinking depend on the bytes.
  ([builder](docs/builder.md), [agent step](docs/agent-step.md))
- **Seeds always match git.** What strut ships (workflows, Concept pages,
  apps) is published by content hash at every boot.
  ([jobs](docs/jobs.md))

## Conventions

- **A new workspace/graph field needs a schema entry.** The graph node
  writer rejects any attribute not declared on its type in
  `src/graph/strut-schemas.ts` (`<Type>.<attr>: attribute is not declared
  on the schema`). The file and memory stores accept anything, so
  `npm test` stays green and the break only shows on the graph backend —
  the default server. When a `WorkspaceStore` method (or the projector)
  writes a new property: declare it on the schema (optional `?` type —
  the boot seed only ever ADDS keys, so a deployed graph picks it up on
  restart), add a case to `src/test-util/workspace-conformance.ts`, and
  run `npm run test:graph`.

- **A graph write goes through `tx()`, never `query()`.** On a LadybugDB
  file `query` runs on the read connection, outside the writes' queue: a
  write there passes alone and fails ("Only one write transaction at a
  time") beside any open write transaction, such as a run's end
  projection after every run (2026-10-26: the workspace store's
  ACTIVE_VERSION swaps). Inside a `tx`, hand the transaction to the
  writers (`edges.write(input, tx)`): `tx()` does not nest.

- **Vanilla CSS** with custom properties. Two files only:
  `base.css` (palette + reset) and `components.css` (all
  component classes). No JS styles, no CSS-in-JS, no Tailwind.
  Same pattern as `gateway/internal/adminapi/ui/`.

- **`system-canvas`** for flow visualization **and editing**. The
  canvas is `editable={true}` when not viewing a run. Each step
  type is a theme **category** (`step-http`, `step-log`, etc.)
  with a `header` slot showing the uppercase type and a run-status
  slot (checkmark = success, X = error, dot = running, clock =
  pending) — `topRight` for leaves, `bottomRight` for container
  nodes (whose `topRight` carries the ref arrow). Container
  categories also add a `body` text slot (the workflow name, small,
  left-aligned, ellipsized) and set `refCorner: "topRight"`. Nodes
  carry `customData: { stepId, stepIndex, status, stepType }`.
  Interactive features: drag-to-connect creates `depends` edges,
  the "+" FAB opens a searchable Add Step dialog (core/lib/custom),
  delete key removes nodes/edges. `panMode="trackpad"` for
  Figma-style two-finger-scroll panning.

- **`system-canvas` is a sibling library** (its own repo, published to
  npm in lockstep as `system-canvas` + `system-canvas-react`). strut consumes the **published** version
  (`web/package.json`). Features strut relies on: `node.ref` +
  `externalNavigation` (ref click fires `onNavigate` only, no
  internal drill), per-node/category `refCorner`, category `slots`.
  To land a lib change: edit the lib, `npm run build`, push to
  `main` (auto-release bumps the patch), then `npm install
  system-canvas@<v> system-canvas-react@<v>` in `web/` and rebuild.
  (For local iteration you can copy the built `dist/` into
  `web/node_modules/...`, but a fresh `npm install` overwrites it.)

- **Add Step dialog** opens from the canvas FAB button. Fetches
  all available step types from the `/steps` API, groups them
  by source (core / library / custom), and supports type-ahead
  search. Selecting a type adds the step with `depends: []` and
  opens the flyout for configuration.

- **Tests** use `node:test` + `assert/strict`. `npm test` runs every
  `*.test.ts` under `src/`, `kit/src/` and `web/src/` (a glob, so a new file
  needs no registering); a test that needs what CI's unit job lacks (Neo4j, a
  model download, a browser) skips itself unless its env var is set and has a
  script of its own (`test:graph`, `test:stt`, …). Each test file
  creates its own helper step definitions (echo, value, fail,
  counter, flakey). `MemoryRunStore` for unit tests,
  `FileRunStore` with tmp dirs for integration tests.

- **Step definitions** use `defineStep()` which returns the def
  as-is (identity function for type inference). `AnyStepDef` is
  the type-erased version used in the runtime registry.

## When adding a new core step

1. Create `src/steps/core/<name>.ts` with a `defineStep()` default export.
2. Import it in `src/steps/registry.ts` and add to `CORE_STEPS`.
3. If it's control flow, add to `SELF_RESOLVING_STEPS` in `runner.ts`
   and handle it in `dispatchStep`.
4. Add a color entry in `PALETTE` in `web/src/step-colors.ts`
   (categories are auto-generated from this map via `buildCategories()`;
   the Add Step dialog discovers types via the `/steps` API).
5. Write tests in the appropriate test file.
6. Run `npm test` and `cd web && npx tsc --noEmit && npx vite build`.

## When adding a lib step (domain integration)

Lib steps (`src/steps/lib/<namespace>/<name>.ts`) are engine-shipped
domain integrations (github, slack, google-docs, dropbox, …). They're
auto-discovered by `buildRegistry()`/`createRegistry()` — no manual
registration — but they follow a strict **dependency convention** so
adding a hundred adapters doesn't bloat every consumer's startup.

### Lib step dependency convention

**Rule: schema + metadata at module top level; heavy SDKs `await import()`-ed
INSIDE `run()`.**

```ts
import { z } from "zod";                       // ✅ light, already a core dep
import { defineStep } from "../../../core.js"; // ✅ engine
// ❌ NEVER: import { Octokit } from "@octokit/rest";  (top-level heavy SDK)

export default defineStep({
  type: "github/fetch-pr",
  description: "...",
  input: z.object({ /* ... */ }),   // top level — needed by /steps + UI
  output: z.object({ /* ... */ }),
  async run(cfg) {
    const { Octokit } = await import("@octokit/rest"); // ✅ lazy, first-use only
    const octokit = new Octokit(/* ... */);
    // ...
  },
});
```

**Why.** `loadStepsFrom(LIB_DIR)` does `await import()` on *every* lib
file at registry-build time (which `createStrut()` does eagerly at
construction). A **top-level** `import` of an SDK therefore loads that
SDK at startup for **every** consumer — even ones that never use the
step. Moving the SDK import into `run()` keeps registry-build cheap (only
schema + metadata execute), so the SDK only loads the first time its step
actually runs. This is the "monolith, lazy-loaded" model (same shape as
n8n's node catalog): all adapter code ships in strut, but unused SDKs are
never *loaded* — though they are still *installed* in `node_modules`
(an in-tree integration's deps are unavoidably listed in
`strut/package.json`). If install footprint ever becomes the problem,
split heavy adapters into companion packages registered via
`createRegistry([...])`; the lazy-in-`run()` pattern is forward-compatible
with that move.

**Checklist for a new lib step:**
1. Create `src/steps/lib/<namespace>/<name>.ts` with a `defineStep()`
   default export. Use a `<namespace>/<name>` type (e.g. `slack/post-message`).
2. Keep ALL `import`s at the top light (zod, core, sibling `_helpers`).
   `await import()` every third-party SDK inside `run()`.
3. Add the SDK to `strut/package.json` dependencies.
4. Read credentials via `cfg.<field> ?? await ctx?.services?.secrets?.get("NAME")`
   (type `ctx` as `StepContext<StrutCapabilities>`) — never `process.env`
   directly. See "Lib step credentials". Declare the credential secrets it can
   read in `secrets: [...]` (any one suffices; no optional settings) and whether it acts (`effect: "write"`) or only fetches
   (`effect: "read"`): `GET /steps` lists both, and a host builds its
   connector list and its `approve:` defaults from them.
5. Shared helpers go in a leading-underscore file (`lib/<ns>/_shared.ts`) —
   imported by siblings, skipped by registry discovery.
6. Map the type or its namespace to a `PALETTE` entry in `web/src/step-colors.ts` if you want a
   distinct node color (optional; the Add Step dialog discovers the type
   regardless via `/steps`).
7. Write tests; run `npm test` and `cd web && npx tsc --noEmit && npx vite build`.

## When changing how LLM calls or tools are built

`npm test` is offline: it never streams from a real provider, and never goes
through the gateway prod uses. So a change to what reaches the model
(tools on the `agent` step or the chat builder, especially provider-native
ones like `web_fetch`/`web_search` or the text editor; `llm.ts` / `src/aieo/`
(and a bump of a provider SDK, which now parses strut's streams); `llmAuth` / Mothership headers; provider or model routing) can pass
every test and still break in prod. Bifrost re-renders
non-Claude-Code streams, and a malformed frame kills a chat turn. Validate
such a change end to end:

1. `docker compose -f docker-compose.yml -f docker-compose.gateway.yml up --build`
2. `STRUT_TEST_GATEWAY=1 npm run test:gateway`: add a check to
   `scripts/gateway-smoke.ts` that exercises the new tool (a chat turn or a
   workflow run that calls it) instead of only running the existing ones. A
   provider-executed tool must also survive the REQUEST path: have the turn
   call another tool afterwards, so the next request carries the tool's
   block through the gateway (`websearch-tool` in `gateway-stream.mts` is the
   shape; a routed strut avoids the native pair for exactly this reason).
3. When a stream fails, narrow it down without strut in the way:
   `scripts/gateway-stream.mts` (aieo + strut's real tools, prints the full
   TypeValidationError), then `scripts/gateway-raw-sse.sh` (raw frames), each
   `direct` vs through the gateway, to tell a strut bug from a gateway bug.

See "Running" for the commands, the debug affordances, and the VK
provider-routing gotcha.

## When adding an API endpoint

1. Add the route in `src/createStrut.ts` (inside the `createStrut()`
   factory, where all routes are mounted). Watch route ordering —
   specific paths like `/workflows/:name/flow` must come BEFORE
   catch-all params like `/workflows/:name/:version`.
2. Add the typed function in `web/src/api.ts`.
3. Wire it into `web/src/app.tsx`.
4. Document it in `specs/API.md` — request and response shapes, from the
   types, not retyped.
5. The Vite dev proxy in `web/vite.config.ts` only proxies known
   prefixes (`/workflows`, `/steps`, `/secrets`, `/sessions`, `/peers`, `/brand`, `/graph`, `/chat`, `/llm`, `/health`, `/jobs`, `/apps`, `/packages`, `/publisher`, `/tasks`, `/mcp` — the app host's MCP client, SSE answers). Runs are
   under `/workflows/` and chat reattach under `/chat/` so they're
   already proxied. SSE responses get `cache-control: no-cache` +
   `x-accel-buffering: no` injected by the shared `sseConfigure` —
   wired onto both `/workflows` and `/chat` (the two SSE prefixes).
   Add new prefixes if needed.
6. Every response is compressed for a client that accepts it
   (`hono/compress`, right after the logger — a transcript is megabytes of
   JSON). SSE is excluded by its content type, so a streaming route needs
   `text/event-stream` and nothing else; a test in `chat-endpoints.test.ts`
   pins both.

## When modifying the web UI

- Edit `web/src/styles/components.css` for styling — never use JS
  style objects.
- The shell layout is a CSS grid:
  `grid-template-areas: "sidebar topbar" / "sidebar canvas" / "sidebar events"`.
- The flyout is `position: fixed` on the right, no backdrop (so
  canvas clicks pass through for node-to-node transitions).
- Rebuild with `cd web && npm run build` before testing against the
  engine server.
- strut is also embedded by **mcp** (stakwork/stakgraph) under `/lab`. mcp
  pins this repo as a git dependency
  (`git+https://github.com/stakwork/strut.git#<commit>`); its `yarn install`
  runs the `prepare` script here (engine `tsc` + `web/` vite build), so a
  change only reaches `/lab` once mcp bumps the pinned commit. To develop
  both at once: `yarn link` here, `yarn link strut` in `mcp/`, then rebuild
  (`npm run build`, `npm run build:web`) and restart mcp after each change.
- **One copy per process.** `zod`, `ai` and `@ai-sdk/anthropic` are
  `peerDependencies` (+ `devDependencies` for this checkout) — never
  `dependencies`. Their objects cross the strut↔host boundary: a tool
  `inputSchema` built here is converted by the HOST's `ai` with the HOST's
  zod, and zod's JSON-schema internals only work within one copy. A caret
  `dependencies` entry once resolved to a newer zod nested under
  `node_modules/strut/` in mcp, and every chat turn died with `Cannot read
  properties of undefined (reading 'push')` from zod's `recordProcessor`.
  As peers they resolve to the host's single copy (npm installs peers
  itself — the desktop stage; a yarn v1 host lists them — mcp does) and
  the host bumps versions in one place. `@ai-sdk/anthropic` builds
  strut's Anthropic models (src/aieo) and the anthropic provider-defined
  tools (the agent's text editor, the native web tools), whose zod schemas
  the host's `ai` converts. The other provider SDKs (google, openai, xai,
  openrouter) hand the host only a `LanguageModel`, so they are ordinary
  `dependencies`, pinned EXACTLY at the versions the npm package `aieo`
  bundles (`src/aieo/pins.test.ts`): a git-dependency host resolves them
  with its own lockfile, not strut's. Same rule for anything new that
  hands zod schemas or AI SDK objects across the boundary.
