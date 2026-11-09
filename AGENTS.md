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

## Stack

| Concern     | Choice                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Engine      | TypeScript (Node 22+), Zod for schemas, custom expression evaluator        |
| HTTP        | Hono + @hono/node-server                                                   |
| Persistence | One interface per layer — `WorkspaceStore` (workflows/steps), `RunStore` (runs), `ChatStore`, `SecretStore`, `SessionStore` (agent sessions) — with File + Memory impls; local blobs (artifacts/cassettes/shell scratch) live under an explicit `dataDir` |
| Web UI      | Preact + Vite + system-canvas-react. Vanilla CSS, no Tailwind              |
| Tests       | Node native test runner (`node:test`) via tsx                              |
| LLM step    | Vercel AI SDK (`ai`) over an aieo-resolved model — lazy-loaded. `ai`, `zod`, `@ai-sdk/anthropic` are **peerDependencies** (see "One copy per process" below); the other provider SDKs (google, openai, xai, openrouter) are strut's own dependencies, pinned exactly. aieo, the provider layer, is strut's own source (`src/aieo/`) |
| Browser     | `playwright-core` (pinned to images/browser's Playwright) driving a Playwright server, a CDP Chrome or a local Chrome, behind `ctx.services.browser`; `sharp` for the screenshot downscale (in the darwin desktop package its addon + libvips sit in `native/` like the others, `relocateSharp`). Both lazy-loaded |
| AI builder  | Vercel AI SDK `ToolLoopAgent` over any aieo provider (model picker in the flyout, per-chat `ChatMeta.model`); detached + persisted, reattach via `/chat/:id/stream` SSE |
| Embedded graph | `@ladybugdb/core` (LadybugDB, the Kuzu fork), an **optionalDependency** with a native addon: for the `memory/*` lib steps (`<dataDir>/memory/graph.lbug`, or `STRUT_MEMORY_DB`), workspace custom steps that keep a local graph, and the Ladybug graph backend (plans/ladybug-backend.md, BUILT 2026-10-14: the graph layer strut owns — the workspace store, runs and jobs, claims, Concepts — on one file under `dataDir`, `STRUT_WORKSPACE_BACKEND=ladybug`, the desktop package's default — `src/graph/ladybug/`, wired by `src/graph/wiring.ts`; an existing filesystem workspace is imported into the file at that boot, `src/graph/fs-import.ts`). `memory/_db.ts` and `graph/ladybug/db.ts` `await import()` it on first use (the graph handle falls back to the platform package, so an install with scripts blocked still loads); registry build never loads it, and without it a memory step fails with an install hint. In the darwin desktop package (addon + bundled OpenSSL + the `vector` and `fts` extensions in `native/`, plans §2.3) only built-in `build/` steps reach it: a workspace custom step outside the bundle resolves `strut`/`vein` through strut-resolve-hook.ts and nothing else |

## Layout

```
strut/
├── specs/                 # design specs — read SPEC.md first; EVAL_, EVOLVE_, RUN_CONTROL_ companions; API.md is the client how-to for the HTTP API (every endpoint, response shapes, a worked run); CALLBACKS.md the one for `POST …/run { callback }`; DESKTOP.md the desktop app's how-to for the chain to a person's orgs (pairing records, rooms, the wake turn, deliverables through the read-through); WALLET.md the wallet contract an app's page and its host speak (NWC over the MCP Apps bridge, plans/app-payments.md), normative in `@strut/kit/wallet`
├── package.json           # engine deps (hono, zod, ai sdk)
├── Dockerfile             # standalone server image: node + media/document CLIs + agent venv + uv, fs backend on a bare `docker run`
├── docker-compose.yml     # the standalone compose: the PUBLISHED image (ghcr.io/stakwork/strut:${STRUT_IMAGE_TAG:-latest}, pushed from main by .github/workflows/publish-image.yml) on the graph backend + a PINNED Neo4j (`neo4j:${STRUT_NEO4J_TAG:-5.26.32}`, the 5.x LTS patch the old floating `neo4j:5` tag named, so its volumes open; never moved by an image update) + the browser (`${STRUT_BROWSER_TAG:-1.63.0}`) (named volumes for neo4j data, /data/workspace, /data/models, uv cache) — nothing built. A box that follows a release CHANNEL sets `STRUT_IMAGE_TAG=stable` and `STRUT_BROWSER_TAG=stable`: `.github/workflows/promote-image.yml` (run by hand with a commit on main) copies that commit's image to the channel tag by digest and moves strut-browser's tag of the same name to the Playwright version the commit pins
├── docker-compose.build.yml # overlay: strut built from this checkout (`build: .`, `strut:local`) — for working on strut itself; docker-compose.gateway.yml builds it too
├── deploy/index/          # a package INDEX alone (plans/marketplace.md §7, §13), run from this folder (`.env` beside it, from env.example): docker-compose.yml — the published strut image with the index role (`STRUT_INDEX=1`, fs backend, `STRUT_INDEX_URLS` from `STRUT_INDEX_HOST`) + Pkarr's own relay image (`synonymsoft/pkarr-relay`, its DHT node on UDP 6881) behind Caddy for TLS, two hostnames, compose project `strut-index`; no Neo4j, no browser, no lab — the box that holds the index key every strut's defaults name. Caddyfile (one site per hostname; SSE flushed), pkarr-relay.toml (cache on its volume, rate limits `behind_proxy` since only Caddy reaches its HTTP side)
├── deploy/voice/          # a VOICE DEMO (plans/private-voice.md), run from this folder like deploy/index: the published strut image on Ladybug + sphinx-voice's 1:1 mode (`node dist/one-to-one.js`, connecting out to the central LiveKit) behind Caddy for TLS, compose project `strut-voice`, and Maple's inference proxy (`maple`, internal only: strut gets `MAPLE_BASE_URL` and an optional `MAPLE_API_KEY`, for `VOICE_MODEL=maple/gemma4-31b` once the strut image has aieo's `maple` provider); host-config.json names the orchestrator Jamie. README.md: an AMD SEV-SNP EC2 box, the models warmed, Peel's development Talk home, the attestation report — and the call audio end-to-end encrypted (a key Peel makes per call, the voice service and Peel join the room with it), and what the demo is not (no attested image, the model call leaves the box)
├── images/browser/        # a second image, nothing of strut's in it: a Playwright SERVER (`playwright run-server`, the package baked in, tini, non-root) for hosts whose steps drive a browser over a websocket. `.github/workflows/publish-browser.yml` pushes it to ghcr.io/stakwork/strut-browser when this directory changes on main, tagged with the Playwright version its Dockerfile pins — the connecting host's `playwright-core` must be on the same major.minor (strut's own, package.json, is pinned to it). The compose file's `browser` service
├── kit/                   # `@strut/kit` (plans/apps.md §3), a package of its own (kit/package.json, kit/yarn.lock; `kit/README.md`): what a strut APP — an interactive front end the builder writes over workflows, rendered by an MCP Apps host in a sandboxed frame — is built against and runs on. The FROZEN VENDOR LAYER the app build resolves against (`scripts/build-vendor.ts` → `vendor/`, kit 0.2): a MODULE TREE — every module the fixed dependency set reaches (React 19, shadcn/ui at `@/components/ui/*` + `@/lib/utils`, radix, lucide, recharts, d3, React Flow, three + @react-three/fiber, leaflet + react-leaflet, motion — `framer-motion` aliased to it — react-router, zustand, react-query, tanstack table/virtual, dnd-kit, date-fns, lodash, zod, react-hook-form, papaparse, mathjs, simple-statistics, fuse.js, react-markdown) and the kit's own TypeScript compiled, copied as the packages ship them into `files/` (every `node_modules` segment `_m`, npm never packs one; a `type: module` package's `.js` written `.mjs`), each import's resolution and the package's `sideEffects` recorded in `modules.json` — esbuild reads neither `sideEffects` nor `type` for a plugin's path — so each app tree-shakes from the original modules (an app that imports three icons carries three, not lucide's 1 600; plans/apps.md §2.5) and one React per page holds by construction. Beside it `import-map.json` (specifier → the module it starts from, what §2.1's `appResolver` consults), the bundled `.css` entries, `candidates.json` (every component's Tailwind classes, `@strut/kit/node`'s) and `manifest.json` (the exact versions). The FOLDS (`src/folds/`, below) are the kit's too. `src/styles/base.css`: Tailwind, shadcn's tokens, and MCP Apps `hostContext.styles.variables` mapped onto them with fallbacks (`--background: var(--color-background-primary, …)`). `src/bootstrap.ts` (§2.4): first, at module evaluation (before the app's own modules), a `localStorage` / `sessionStorage` that throws — the frame's origin is opaque — is replaced by an in-memory one (`installMemoryStorage`), so a library that persists by default works for the page's life; then the MCP Apps client from `@modelcontextprotocol/ext-apps` (never a hand-rolled postMessage) sends `ui/initialize`, the host context is applied to the document, the file token is read off `<meta name="strut-app-token">` (written as the document is SERVED, §7.2), `<StrutProvider><ErrorBoundary><App/>` mounts, size goes out as `ui/notifications/size-changed`, and a render failure or `window.onerror` becomes ONE `app/report-error { message, stack?, componentStack? }` per distinct error. `StrutClient { run(type, config?, input?) }` = `tools/call` of `step_run` with the token as its `app` argument; a host's own page supplies the client instead. The §3.2 hooks on react-query, each naming a `run/*` step: `useRuns` / `useRun` / `useRunEvents` (`run/list`, `run/get { wait }`, `run/events`; `live` = refetch while anything shown is in flight — the events read once, then only what was appended, `skip`, paged past `RUN_EVENTS_MAX`, every `intervalMs`), `useTranscripts` (several agents' transcripts, one call at a time, kept), `useTranscript(workflow, runId, path, { full? })` (`run/transcript`: the agent session a `step.end`'s `transcript` link names, which a page cannot follow), `useLaunch(workflow, { job? })` → `{ launch(input, params?, key?, files?), pending }` — a MUTATION with no query form, so nothing launches on mount or a poll (§5.1); `job` one of the app's jobs, `files` the run's attachments — `useUpload(job)` (`job/upload` / `job/delete-upload`, `fileData` for a `File`), `useCancel`, `useWorkflow`, `useStep(type)`, `useToolInput`, `useAppLink` (`appLink(name, input)`, src/links.ts: a DEEP LINK to an app, `?app=<name>&input=<the app's own query>`, which a host follows and hands back as `tool-input`, flat strings — plans/apps.md §7.1), `useHost`, `useAppState(key, initial)` (`app/state`: what THIS viewer's page remembers across visits — a tab, a filter, a draft — like `useState`; the page has no browser storage, so strut keeps it; writes batched, one call per 500 ms at most), `useApp` (which app the page is, off its identity — `appOfToken`: `{ name, version }`), and the LIVE FEEDS (plans/live-feeds.md): `useJobUpdates(job)` (`job/updates`: one call held on the server at a time, none while the page is hidden; `latest("status")`) and `useGraphChanges(types)` (`graph/changes` from `now`: a `rev` a page puts in the dependencies of its reads). `useChannel(name)` (plans/app-channels.md): live messages between the app's viewers — states and events, `members`, `send` — over a socket the HOST holds; `@strut/kit/channels` is the contract (`strut/channels/*` on the bridge, `experimental["strut/channels"]` in `ui/initialize`) and `relayChannels`, what a browser host runs per framed app. `useAssistant().jobs` reads the orchestrator's `tool:job_start` / `tool:job_continue` calls, their output the JSON text the log keeps (SQL and automation hooks are later items). `dist/` is the library build (React, react-dom, react-query as peers) for a host's own pages, `@strut/kit/folds` (the folds alone, no React), `@strut/kit/wallet` (the wallet contract alone, `kit/src/wallet/`: the `strut/wallet/*` methods — NWC's names, params, results and msat, plus keysend route hints, a `pending | settled | failed` state on every payment, `payment_failed`, `USER_REJECTED` and `connect` — `checkParams` every side runs first, `resultProblems` / `notificationProblems`, `verifyPreimage`, the Sphinx address split; its conformance vectors `@strut/kit/wallet/vectors.json`, which every host and Peel run; and its plumbing: the app's `createBridgeWallet` over the page's `App` (what the kit's `useWallet` / `useTransaction` and the bootstrap's `window.webln` are over — installed only when the host's `ui/initialize` offers `experimental["strut/wallet"]`), and the RELAY strut's UI runs as a native host's main frame (Peel's web view: `web/src/app-host.ts` asks `window.webkit.messageHandlers.strutWallet` what it offers an app whose version's `dist/build.json` requests a wallet, forwards each `strut/wallet/*` call with the app's identity, and routes `window.strutWallet.notify(…)` back to the frame); specs/WALLET.md) and `@strut/kit/node` (the import map, candidates and `compileStyles` for the app build). `tsconfig.views.json` type-checks `strut/views` against the kit (`npx tsc -p kit/tsconfig.views.json`). `vendor/` is built by strut's own `npm run build` (`build:kit`, scripts/build-kit.mjs — and so by `prepare`) with the kit's dependencies in kit/node_modules, so strut's own node_modules carries no React (see "Running" for where each deployment finds it); its tests run in the root `npm test` and need `yarn --cwd kit install` first (CI does)
│   └── src/folds/         # the FOLDS (plans/apps.md §3): pure functions from what strut serves to what a view draws, ONE copy, exported from `@strut/kit` and alone as `@strut/kit/folds` (no React, no dependency) — `web/` imports them through a Vite alias + tsconfig `paths` onto this source, `strut/views` and any app through the kit. run-overview.ts (foldRunOverview: a run's events → the run at a glance (`{ tree, split }`: every row at its true depth, a foreach's iterations as rows of their own; each row's own tokens) — status, duration, cost / model calls / tokens / tool calls from each `step.end`'s `withUsage` fields, the failing step, and the TIMELINE rows: one per top-level step, a foreach's iterations folded in ×N, under each what it started — an agent, a sub-agent, an llm call, a child run with its `runId`; `TokenUsage` is its), transcript.ts (stored model messages → display entries: user / text / tool groups with results by toolCallId / notice — `NOTICE_PREFIXES`, which web's notice.ts parses — / `mark`), accessed-nodes.ts (foldAccessedNodes: the graph nodes one step read or wrote, with the calls that touched each), run-health.ts (foldRunHealth: the deepest failures, retries and how they ended, onError fallbacks, skipped steps and `if` branches, steps cut off by the run's end, failed tool calls by tool, log stats), document.ts (sanitizeHtml: a DOM — the browser's DOMParser, which runs nothing — walked against a pinned tag/attribute allowlist into a plain `SafeNode` tree; scripts, styles, frames, forms, SVG, MathML dropped with their content, unknown elements unwrapped, links http(s)/mailto only, images only an inline `data:image/…`; findHighlightRanges / highlightPieces with `indexOf`), agent-trace.ts (foldAgentTrace: a run's agents as a nested cascade, ported from hive's Traces view — each `agent` step a session, an `agent` tool call a sub-agent under its caller, turns in fixed slots, a call that named nodes drawn as them (read or written, `accessOf`), the reasoning before each call from the agent's transcript by `toolCallId`, top-level agents batched by overlap in time), walk/ (a run's graph WALKS, one hop-event shape whoever took them — source.ts: `findWalks` reads a `graph/walk` step's `walk:hop` events as they are and builds the same shape from an agent's own graph tool calls: a call whose output LISTS nodes (graph-get's `children`, graph-neighbors, graph-search's hits) opens a choice, the next call that reported reading nodes closes it, every node it read chosen — one, or several at once (`graph_get_batched`) — and a read nothing listed is a hop of its own from the node the walk was on, or the walk's seeds when it was on none; the listed nodes come from the log's 1.5 KB output preview, complete entries of a cut one, and from the agent's transcript once it ended, `toolResultsByCall`; trail.ts: `foldWalkTrail`, a step per hop with the nodes chosen and every candidate considered — chosen, kept, dropped, considering — the path, `jump`; graph.ts: `foldWalkGraph` / `foldWalkProgress`, the force graph's nodes and edges, moved from web/src/walk-graph.ts; replay.ts: `walkBeats` (each hop event a beat, with its time and what a person reads), `walkFrame` (the trail after k beats), `walkHopStop` (a step is one hop)), replay.ts (a REPLAY's clock, pure, for any view that plays a run back from its log: `replayStart` — in flight the hops so far, following; finished its end, or its start with `replay` — `replayWait` / `replayDelay`, the run's own gap between beats held between a readable least and a cut-short idle stretch, divided by the speed, a follower faster when behind (`replayCatchUp`), never skipping one; `replayAdvance`, `replayPlay`, `replayPause`, `replaySeek`, `replayLive`), artifact-view.ts (artifactKind, the served-path scopes, resolveArtifactLink, findArtifacts, parseWalkthrough), work-products.ts (foldWorkProducts: the `artifacts` a run's steps declared while it went — a step's output, an agent's `object`, a tool call's lifted `step.end.artifacts` — and the run's output, latest per id, the output winning, the first step to declare one its maker; productView (a sheet or table → SheetView's source) / parseTimeline / sourcesOf; plans/work-products.md). run-graph/: the RUN GRAPH's model ported from hive (src/lib/strut-run-graph) with its tests — project.ts (a run's log → the calls that touched the graph, over the accessed-nodes marker, the names a step reported kept; `projectWithLaunches` → the run each launching call started), replay.ts (branch tree, scope, replay frames, child calls spliced in), walk.ts (hops), lineage.ts (PARENT_OF), peer-ref.ts (`@peer:ref`), node-text.ts, and layout.ts (d3-force: lanes per stage, cells per iteration, lineage as rings, a cell's parts left to right in the order the run first reached them; with `fold` a cell keeps a parent's most-touched children and its loose nodes of a type up to a cap, a budget shared over its parents, and folds the rest into one "+N" node (`clusters`) — decided by the run alone, so a highlight, a selection or the replay never moves anything; a 3,000-node run lays out under 3,000 × 1,500 px — exported from `@strut/kit` only, since it needs d3); `_expect.ts` runs hive's vitest suites under node:test unchanged. All tested by the root `npm test`
├── fixer/                 # node-llama-cpp for dictation's fixer (src/audio/fixer.ts), a package of its own (fixer/package.json, fixer/yarn.lock) so no install of strut carries it — its CUDA and Vulkan builds are ~740 MB on Linux — and only the desktop package does (scripts/package-desktop.mjs stages it at fixer/; `--no-fixer` leaves it out). `index.js` re-exports it for the fixer's worker, which imports that file by path (`fixerRuntime`); `check.ts` holds the real package to the shape fixer-engine.ts types by hand (`npm run check:fixer`, run by the desktop job). Install: `yarn --cwd fixer install --frozen-lockfile --ignore-scripts`, never from `prepare` (mcp runs it). Without it there is no fixer: dictation/models lists none, dictation/use refuses one, transcription and learning take the no-fixer path
├── aieo/                  # the npm package `aieo` (plans/aieo-in-strut.md), built from `src/aieo/` for the repos that still take it from npm (Hive, staklink, mcp): package.json (its version, the provider SDK pins — `src/aieo/pins.test.ts` holds them equal to strut's), tsup.config.js (entry ../src/aieo/index.ts; anthropic, google, openai and provider-utils inlined, as aieo always shipped), tsconfig.json for the build, scripts/ (the live probes: `npm --prefix aieo run try-numes`, keys from strut's `.env`). Nothing strut runs. `npm run build:aieo` → `aieo/dist/` (gitignored; tsup via npx, never a strut dependency), after `aieo/check-install.mjs` refuses an install whose inlined SDKs are not the pinned ones (0.2.8 shipped @ai-sdk/anthropic 4.0.60 from a stale checkout); published by hand: `yarn install --frozen-lockfile`, bump `aieo/package.json`, `npm run build:aieo`, `npm publish ./aieo`. strut itself has no aieo version: it runs `src/aieo/` at its own commit
├── tsconfig.json          # strict, Node16 module, types: ["node"]
├── src/
│   ├── core.ts            # flow(), step(), defineStep(), services bag, all types; the five output markers — withAccessedNodes / withMessages / withMedia / withStop / withUsage (readers accessedNodesOf / messagesOf / mediaOf / stopOf / usageOf): non-enumerable, so invisible to {{ }}, JSON, the event log and run.json. withUsage (what a step's model calls spent) is TAKEN off the output by whoever lifts it onto `step.end` as `modelCalls` / `usage` / `cost` (`takeUsage`), so a pack or subflow handing the same object on never reports it twice; `RunSummary.totals` is their sum (`tallyUsage`, store.ts)
│   ├── expr.ts            # {{ }} template evaluator (recursive descent, one pass; `? :`, `&&`, `||`, `??` short-circuit — the part ruled out is parsed under a `skip` depth and never evaluated; `?.`; whitelisted array methods + arrow lambdas; every read-off-nothing error names the fix)
│   ├── search.ts          # searchSteps / searchWorkflows: the one matcher behind the sidebar filters, the Add Step picker and `GET /workflows?q=` — every word must hit the name (or the category / description), name hits rank first. The web UI imports it from here
│   ├── input-block.ts     # the optional YAML `input:` block → the flow's Zod input schema; kept as Flow.inputBlock for GET …/flow + the Run form
│   ├── step-ref.ts        # `type: name@vN` — a PINNED custom-step version (parseStepRef / baseType); a bare type runs the active version. Events keep the bare `stepType`; the pin rides on `step.start.stepVersion`
│   ├── package-lookup.ts  # PACKAGE-FIRST lookup (plans/packages-ux.md §2): inside a package a bare name is the package's own item first (`<pkg>/<name>` when it exists), else the name as written — node's lookup, so nothing in a package is rewritten. An item's package is its name's prefix (`packagePrefixOf`, 3+ segments; workspace.ts re-exports it). Asked by the runner (`stepOfFrame` for a step's type, `workflowOfFrame` for a subflow's target — the frame's package is its OWN workflow's, `Exec.package`; events record the step and child that ran), the agent (`expandAgentTools(names, registry, ctx.package)`: a glob matches the package's and the strut's, the package's copy winning per name; a package's step is shown to the model by its name inside the package), the `run/*` steps and `meta/run-workflow` (`ctx.resolveWorkflow`), the app door (`runSingleStep` / `runStep` in the app's package), the app build (a package app's imports and granted workflows), an app release's lock, the closure walk (`flowClosure(…, scope)`: `run.start.stepHashes`, the ledger's subjects) and the install's checks (a check's step written as the package's). `ctx.package` + `ctx.resolveWorkflow` are the runner's to set
│   ├── runner.ts          # execution engine: DAG (topological), retry, onError, control flow, journal replay; each run's view of the services bag (`bindPrincipal`, `bindPeer`, `bindApp`, and `bindGraph` from graph-writes.ts, flushed at the run's end)
│   ├── output-cap.ts      # the step OUTPUT cap (`STRUT_STEP_OUTPUT_MAX_BYTES`, 8 MB as JSON): `outputTooBig` — the error the runner throws for a step, loop or foreach iteration output over it and `wrapToolsWithEmit` for a tool result, naming the size, the cap and the artifacts convention; `fmtBytes` / `positiveBytes`, shared with the resume log cap (`STRUT_RESUME_MAX_LOG_BYTES`, createStrut.ts)
│   ├── run-control.ts     # RunController: cooperative cancel/pause/resume for run TREES (RUN_CONTROL_SPEC.md); isAncestorRun reads the tree through a step's `ctx.control` (what lets a child run share its parent's job directory)
│   ├── escaped-errors.ts  # an error a step lets ESCAPE (a callback's throw, a promise it never awaits) fails that step instead of ending the process: `guardEscapes` runs a step's `run()` (and each tool-step an agent calls) in an AsyncLocalStorage scope, `installEscapeGuard` (createStrut, `escapeGuard: false` to opt out) adds the process's uncaughtException / unhandledRejection handlers that find the scope and fail it; an escape no step owns is logged, the server keeps serving (RUN_CONTROL_SPEC §5.5)
│   ├── journal.ts         # resume journal: step.end outputs → {path→output}; `from` invalidation; `changedSteps` / `invalidateSteps` — a resume onto another version re-runs what changed (§5.4); `executedWorkflowHash` — the version a run executes now (the newest durable `run.resumed`'s, else `run.start`'s)
│   ├── store.ts           # RunStore interface (writes + reads + tail) + FileRunStore + MemoryRunStore + tailJsonl / tailFromPolling. Keys are workflow names, plus two non-workflow buckets no workflow listing can see: `step:<type>` → steps/<type>/runs/ (kept run_step runs), `check:<id>` → checks/<id>/runs/ (paid check runs)
│   ├── claims-authoring.ts # the policy layer behind BOTH claim doors (chat tools + meta/* twins): check-spec validation + write-time defaults (presumed-paid → on_change; on a JOB subject `manual`, `sample` refused), the additive `claims` publish arg, publisher scoping (fixed point 1; a job is nobody's template, so any author may claim about it, and on a job an `ai` author may add a check to a PERSON's claim — plans/job-claims.md §1, ruled), the sealed check over the check closure (fixed point 2; sealed.ts), `ensureJobNode` before a claim about a job is written
│   ├── claims-schemas.ts  # zod shapes + model-facing docs for subjects / check specs / the `claims` arg, shared by ai/tools.ts and the meta/* claim steps
│   ├── sealed.ts          # what the meta surface may never touch (EVOLVE_SPEC §6): DEFAULT_SEALED_STEPS (`eval/*`, `meta/*`) + STRUT_SEALED, a step def's `sealed: true` (the graders — their namespace also holds the producer's door), a workflow's top-level `sealed: true` (content: Flow.sealed, rides in the version hash). isSealedStep / sealedInClosure (a grant the closure cannot read before the run counts as reaching one) — read by authoring.ts (run / run-history / verify / run-step refused by name, a publish refused by closure), claims-authoring.ts and verify.ts (an ai-stamped check's closure, fixed point 2)
│   ├── verify.ts          # the verify pass (plans/claims.md §4): subjectsOfRun (a run's event log → observed subjects + the version each executed), mapCheckResult (the check contract; a check that cannot run writes NOTHING), policyFires (always / on_change / sample / manual), budget (presumed-paid skipped at a cap; reported cost persisted under `check:<id>` and counted), planned slots for external checks, addEvidence, verifyPublish. Triggered from `services.onRunEnd` for every top-level run and after a kept run_step; check runs (`origin: "verify"`) are never verified
│   ├── ledger.ts          # the ledger (plans/claims.md §5): buildLedger (claims per subject with computed status + each check's lastVerify: pending | ran | skipped | planned), subjectsOfFlow (what a launch can execute), the [verify-notification] text. The forcing function — the model reads its contract in a tool RESULT, not an instruction
│   ├── claims-routes.ts   # the Claims panel's HTTP door: GET /claims?kind=&name= (contract + computed status + latest evidence + open slots; `{ enabled: false }` on a filesystem workspace), GET /workflows/:name/evidence (the run view: every verdict on a workflow's runs — its claims and its steps' — keyed by the run, `limit` counts runs; mounted before the `/:version` catch-all), POST/PATCH/DELETE /claims[/:id], /claims/:id/{attach,detach,checks,evidence}, PATCH/DELETE /checks/:id. Mutations behind requireApiKey; the actor is a PERSON (unscoped, stamped `person`; evidence `asserted`, `by: person`)
│   ├── automations.ts     # automations, the PURE half (plans/automations.md): the record, the closed trigger grammar (zod; interval / day / week / month / once — no cron), normalizeTrigger (fills tz + the interval anchor), nextFire / nextFires (Intl-only zone math, DST-safe), describeTrigger (the human sentence), and the fire-time input scope (`now` / `today` / `last`; checkInputTemplates, resolveAutomationInput)
│   ├── scheduler.ts       # automations, the STATEFUL half: createAutomations(deps) — the policy layer behind BOTH doors (list / create / update / remove / preview / fire) + the in-process tick loop. `nextRunAt` is memory-only (computed from now → missed runs are skipped, never replayed); the `last` cursor and "previous run still in flight" are read from the run store. `strut.automations`
│   ├── automations-routes.ts # the Automations flyout's HTTP door: GET /automations[?workflow=], POST /automations/preview, POST/PATCH/DELETE /workflows/:name/automations[/:id], POST …/:id/fire (Run now). Mutations + fire behind requireApiKey
│   ├── closure.ts         # what a flow can EXECUTE: walkSteps (loop/foreach bodies, onError), flowClosure (nested subflows via the workspace, agentTools grants — one read from params alone, `"{{ params.tools }}"`, is read off every params the frame may run under: its own defaults and what a subflow step hands it; any other templated grant is UNREAD, and the sealed check refuses it; templated/missing child → unresolvable), stepHashesFor → run.start.stepHashes; grantParams / grantWidenedBy — the params keys a flow's `agentTools` read are GRANTS, and a launch's `params` override (meta/run-workflow) may narrow them, never widen them, and the keys an `approve` list reads only GROW (every step the flow's own approve keys gate stays gated — a builder may not relaunch `builder` with `approve: []`): both sides expanded through the registry, every other key a knob
│   ├── step-stats.ts      # GET /steps/:type/stats — the Step Info flyout's Usage: workflows whose active version can run the type (direct, or via subflow) + execution counts summed from their runs' `RunSummary.stepCounts` (written at finalize; older summaries backfilled from the log on first read) and the `step:<type>` bucket
│   ├── run-step.ts        # runSingleStep (one step, in memory, optional cassette) + runStep — the run_step surfaces: records stepHashes, then persists the run under `step:<type>` only when the step has claims or `keep: true` (plans/claims.md §3). `RunStepOptions.app` (the app door's stamp, plans/apps.md §5) → `ctx.app` for the step and `app` + `actor` on a kept run's summary
│   ├── runs.ts            # RUNS as a capability (plans/apps.md §5): the contract (`RunsCapability`: list / get { wait } / events { skip } / launch { key } / cancel / workflow / files / transcript { full }) the `run/*` lib steps are thin over, built by createStrut into `ctx.services.runs` over the same layers the run routes call (the store, the controllers, `launchDetached`, `controlLiveRun`, `artifactRefs`, `readTranscript` — the transcript route's own read), and `provenance` (optional on the interface: an embedder's own may lack it) over the RAW log; here the pure parts — the list filter (`matchesRunFilter`: status, since, automation, job), the event cap (`capEvents`: 5 000, the head + the terminal event, `slimEvent`), the file result (`fileResult`: text or base64, 2 MB), the transcript cap (`capTranscript`: 2 MB of JSON — long strings cut to head + tail at 64k, then 16k, then 4k chars, then the middle left out after the system prompt and the task, never a tool result without its call; `truncated` says what went). Every method refuses a sealed workflow by name: a model's door, like the meta/* twins
│   ├── provenance.ts      # the SPOT CHECK's engine (plans/spot-check.md): `buildProvenance(events, subject)` — where one thing a run made came from, read off its RAW log (tool inputs whole on `step.start`, tool outputs whole in the agents' transcripts on their `step.end`, by `toolCallId`). A subject is a `value` as shown plus, when known, an address: `cell` (a sheet range; `spreadsheet`), `node` (a ref_id), `file`. The answer is its MOMENTS, oldest first, each a tool call or step: `wrote` (into a cell — a sheet write's ranges laid out cell by cell from the top-left, so a block anchored at one cell counts — a file the editor wrote, a node a graph write named, a writing step), `used` (in a command, a query, a prompt, a step's config), `read` (out of a call, a step, the run's input); `exact` by address, else by content (`needleOf`: a number in any spelling — `$54,853` finds `54853.4413`, a percentage its ratio — a passage by up to three windows of it, quotes / dashes / a source file's escapes normalized; a value under three significant digits or six characters is followed by address only). A `wrote` or `used` call carries the agent's words before it (`why`), a write the three calls before it (`before`); a cell's formula gives `refs` + `literals`, a passage the cells it cites (`refs`) and the numbers it states (`figures`), a snippet the cells it cites (`cites`) — each a subject of its own. At most 60 moments, every exact one kept. Pure; `RunsCapability.provenance` and `run/provenance` serve it
│   ├── run-view.ts        # the run VIEW the builder reads (get_run + meta/get-run, via readRun in authoring.ts): foldRun (the event log → the step tree, by path: `wf/sub/child`, `wf/each#3`, `wf/agent/042-bash`, `wf/step/onError`) + buildRunView — ONE level open (`path` picks which; that node is `focus` with its payloads), everything below rolled up (count / status histogram / by step type / last ids), the deepest errors first with the siblings before each, long lists kept head + tail + errors with `{ omitted }` gaps, previews, and a char budget (20k) that tightens in fixed levels and says so in `hint`. Size follows the DAG, never the execution; a transcript is never in it
│   ├── chat-view.ts       # the chat VIEW an external agent reads (the assistant MCP door), the chat twin of run-view.ts: `messages.jsonl` folded into TURNS — the caller's message (or the server notice that woke the builder), the builder's final text, and `did`: what the turn CHANGED, folded from the tool calls by tool NAME over the builder tools' own result shapes (workflows published, steps, runs launched with their artifacts — a detached run and its result one entry — schedules set, the question asked), never from prose. `since` is a message-index cursor, `limit` keeps the newest turns, `detail` adds the calls (previews, or whole), a 20k budget cuts text then the oldest turns and says so. Pure; tested
│   ├── chat-store.ts      # ChatStore interface + FileChatStore + MemoryChatStore (chats/<id>/: meta.json + system.md + messages.jsonl + events.jsonl) + capToolOutput (the builder's tool-result cap) + truncateToolMessages (the same cap on replay)
│   ├── compaction.ts      # compaction (plans/compaction.md): the mark (`STRUT_COMPACT_AT`, `overMark`), the window-derived result cap (`resultCapChars`), the summarizer call (`summarize`: the loop's own system + tools without `execute` + provider options, the conversation, one instruction, streamed) and the `[compaction]` message the chat and the `agent` step APPEND as the boundary a replay starts from — history is never edited
│   ├── workspace.ts       # WorkspaceStore interface + FileWorkspaceStore (alias WorkspaceManager): versioning, _metadata.json, YAML loading; `snapshot()` / `moveAside()` — the file store's half of the one-shot fs → graph import (graph/fs-import.ts). A workflow name may carry `/` (`acme/linear/sync`, `validateWorkflowName`): nested folders on disk, one URL segment encoded (`%2F`) on the wire, and the whole root of every event path (`acme/linear/sync/fetch`) — a step reads it as `ctx.workflow` (`workflowOf`, core.ts), a fold from the run's `run.*` event, never `path.split("/")[0]`. `Upstream` (plans/marketplace.md §3) on workflow, step and app versions, carried forward by every publish over the name; `activate: false` records a version without moving the active pointer; a publish of a NEW workflow or step name under an INSTALLED package's prefix is refused unless it carries that package's `upstream` (`refuseUnderInstalledPackage`: only the install adds a name there; an edit is a fork). `deleteWorkflow` on files removes the workflow's own files, never its `runs/` (the run store's)
│   ├── storage-conformance.test.ts  # the storage boundary's spec: one suite per layer, run over every impl
│   ├── createStrut.ts      # createStrut() factory: Hono HTTP API + detached run launch + SSE run reattach (tail) + detached /chat (launch+reattach) + static serving; injectable registry/store/chatStore/services
│   ├── server.ts          # thin wrapper over createStrut() (getApp/startServer) — the default server, on the backend `STRUT_WORKSPACE_BACKEND` names (graph/wiring.ts): Neo4j by default, `ladybug` one LadybugDB file + the fs import (a failed import boots the fs workspace, loudly), `fs` the file stores. Boots itself ONLY when it is the process entry (argv[1]'s realpath == its own file: `tsx src/server.ts`, `node build/server.js`, a symlink to either) — a host whose own entry is called `server.js` and imports the barrel never starts it (server.test.ts spawns that host)
│   ├── mcp-servers.ts     # the CALLER's MCP servers (`POST …/run { mcp }`): parseMcpServers (the launch field, Hive's `McpServerConfig` shape: name, url, token?, headers?, toolFilter?; HTTP only), mcpOrigins (what `run.start` records), connectMcpTools (the agent step's client: the SDK's Streamable HTTP client, lazy, one per server for the step; `<server>_<tool>` in name order, a server that fails skipped with a warning, a failed call an `Error:` text, results capped, images as `withMedia`)
│   ├── mcp-registry.ts    # MCP servers REGISTERED once (`/mcp-servers` routes, `<dataDir>/mcp-servers.json`, `ctx.services.mcpRegistry`): values by secret NAME (`tokenSecret`, `headerSecrets`), resolved through the run's secrets — the actor's first; an agent's `agentTools: [mcp/<server>/<tool>]` (globs) connects them; a tool not marked `readOnlyHint` nor `ungated`, or named in `approve:`, records a proposal whose apply (`mcpStepDef`, decide's `stepFor`) calls it once. A per-launch `mcp` is untouched (specs/API.md §11.3)
│   ├── callback.ts        # host callbacks, shared by `POST …/run { callback }` and `POST /chat { callback }`: parseCallback (http(s) only), callbackOrigin (the loggable part), postCallback (one JSON POST, a few retries, never throws, never awaited by the work it reports on); a run's callbacks may name a ROOM instead (`{ room: true }` → `room:<actor>` kept where a URL is kept, `parseLaunchCallback` / `roomTarget` / `roomActorOf`; `postCallback` hands it to its `room` deliverer)
│   ├── rooms.ts           # ROOMS (plans/chained-orchestrators.md §3): the callback contract over a socket the CLIENT holds open — a room per ACTOR, every open socket gets each `run.end` / `job.update`, none open → a bounded in-memory queue (1 000) flushed in order on the next join, a 30 s ping; `roomsFor(dataDir)` (one registry per data directory: the job callbacks' deliverer finds it from the job's root). createStrut's `GET /rooms` + `strut.upgrade(req, socket, head, { basePath })` run the upgrade through the app's own gate and hooks (`env.incoming` = the Node request, as on HTTP), so a standalone strut (`listen()` hooks it) and a host that owns the server (mcp routes `/lab/rooms`) decide the room the same way; only a `full` or `peer:person` request with an actor joins
│   ├── drain.ts           # the DRAIN (`GET`/`PUT`/`DELETE /drain`, specs/API.md §8.1): what an updater or a backup turns on before restarting the process — every new ROOT run is refused with a `draining:` error (createStrut's `trackRun`, where every launch path registers, throws `DrainingError` for a run with no live parent; the HTTP launch routes, `POST /chat` and elicitation answers answer 503 + `Retry-After` first; a step run over HTTP that declares `effect: "read"` still answers), a schedule's fire is held, a wake turn stays queued on disk (launched when the drain lifts or at boot), and what is running finishes — a run a run in flight launches still starts. `idle` = no run executing (a paused one is not waited on) and no builder chat turn running. In memory: a restart starts undrained; `minutes` lifts it by itself
│   ├── events-sink.ts     # the EVENTS SINK (`STRUT_EVENTS_SINK`, `createStrut({ eventsSink: { url } })`): every run's events, whoever launched it, batched and POSTed to ONE URL the deployment names as `{ event: "run.events", events }` — telemetry for a server that draws what strut is doing. The ENVELOPE only (`slimRunEvent`, an allowlist: `SINK_FIELDS` + `error.message` + the run's `workflow`): type, when, which run and step, how long, what it spent, which version — never `input`, `output`, `messages`, `params`, `nodes` or a stack; a listener that needs more reads the run by id with the key. Hung on the services bag as `onRunEvent`, the twin of `onRunEnd` the runner calls at every emit (after a host's own). Batched (~1 s or 100), one POST in flight so batches land in order, retried briefly then DROPPED, the oldest dropped when the queue passes 10k — the log is the record; nothing in a run waits on it. A URL that is not http(s) fails the boot
│   ├── voice.ts           # `POST /voice/calls` (plans/private-voice.md §4.1): a person's call set-up handed to the voice service beside strut (`STRUT_VOICE_URL` + `STRUT_VOICE_TOKEN`, `createStrut({ voice })`) — the body unchanged (≤ 16 KB, 413 over), the person as `x-strut-actor`, the shared token as the bearer, its status and body back unchanged; a person token or the deployment key with an actor, 503 unconfigured or unanswered (15 s). A route, not a workflow: the body and answer hold the call key and room tokens, so nothing of either is logged or kept. `warmSpeech`, from `listen()` when a voice service is set: the recognizer `/audio/transcribe` picks (over silence) and Kokoro (one word), downloaded and loaded in the background so a call's first turn waits for neither
│   ├── jobs.ts            # the job directory (plans/jobs.md): `<dataDir>/jobs/<encoded id>/` + its record beside it (usedAt, the repos checked out into it), held by one run at a time (`job_busy:`; a child run launched by `meta/run-workflow` shares it — its controller descends from the holder's), the idle sweep (holds released, repositories removed, files kept), HOLDS (plans/jobs.md §6: `ctx.services.jobs.hold/release/holds` — what a tool claimed that outlives the run, a pod, recorded with the registry step that lets it go; `releaseWith` runs it under a minimal context from the sweep and from `DELETE /jobs/:id` → `deleteJob`), `withLock` (the in-process keyed mutex the git steps share), the file listing/path guard the `/jobs/:id/files` routes use, `JOB_WORKFLOWS` + `turnOf` (the job-shaped workflows a job's turns may run — `job`, `builder` — and the job's newest such run: what `job/continue` launches and `GET /jobs/:id` reports as `workflow`), and LIVE UPDATES (plans/live-artifacts.md: `setJobCallback` keeps a launch's `jobCallback` in `jobs/.callbacks/`, never in the record; `notifyJob` / `ctx.services.jobs.notify` POST `job.update` there, ordered per job and coalesced per thing; holds and the verify pass announce themselves, a hold's update naming the job's turn in flight through the `runOf` seam; the jobs a run starts through `job/start` / `job/continue` INHERIT the launching run's `jobCallback` — kept beside its log by `RunStore.setRunJobCallback`, so a jobless orchestrator turn carries one for the jobs it starts, CALLBACKS.md §5); every update is also KEPT, callback or not, in a per-job feed (`readJobUpdates`, src/live-feed.ts, 200 things a job, in memory) that `ctx.services.jobs.updates`, the `job/updates` step and `GET /jobs/:id/updates` read — how an app's page, which cannot be called, follows its jobs (plans/live-feeds.md §1)
│   ├── live-feed.ts       # `LiveFeed` (plans/live-feeds.md): the newest state of each thing, in the order things last changed, for a reader that asks "what changed since my cursor?" — `<epoch>.<seq>` cursors (another process's, or one past what the feed dropped, reads everything with `reset: true`; `"now"` is the feed's position), `wait` held on a promise (≤ 55 s) and answered a second after the first new thing (`FEED_GATHER_MS`), so a reader asking again on each answer makes at most a call a second. In memory: a feed is a notification, never the record. `evictable` picks what goes first when it is full, `remove` takes things out with no change, `readNow` answers in the same tick. Used by a job's updates (jobs.ts), the graph change feed (graph-writes.ts) and channels
│   ├── channels.ts        # CHANNELS (plans/app-channels.md; items 1–7 and 9 built: the service, and its socket in createStrut — `POST /apps/:name/channel-ticket` mints a browser host's ticket (auth.ts `channelTicket`), `GET /channels` upgrades through `strut.upgrade` like `/rooms` with `?ticket=` or a header credential + `?app=<name>@<vN>`, `?client=` to come back, `strut.channels`; the page's side is the kit's `useChannel` over `@strut/kit/channels`, whose `relayChannels` a browser host runs — strut's UI first, web/src/app-host.ts; the code's side the `channel/*` steps, over `ctx.services.channels`; a peer's app's socket piped to the peer, src/channels-peer.ts): live messages between the people on an app. `createChannels()` → `connect(app, { actor, transport, rejoin? })` for a host's socket (frames `join` / `leave` / `send` in, `joined` / `message` / `presence` / `error` out; `ChannelTransport` is what it needs of a socket, nothing here knows WebSockets), `send` / `read` for code the app runs (stamped `code`, the step type or workflow name), `tick` (pending leaves, pings every `CHANNEL_PING_MS`, idle channels). One `LiveFeed` per `(app name, channel)` — every version shares it, a preview (`preview-<hex>`) has its own. Strut stamps every sender; a keyed message replaces only its sender's own state, events never, and events go first when the 256 are full; presence from the sockets (`joined`, `left`, a dead socket keeps its client id `CHANNEL_REJOIN_MS` for its host to come back, a clean close or a leave drops the leaver's states). Limits as `CHANNEL_*` constants, each refusal naming its own. Nothing kept: a restart empties every channel
│   ├── channels-peer.ts   # the PEER RELAY for channels (plans/app-channels.md §4): a page here showing an app that lives on a PEER (`?app=@<peer>/<name>`, Peel's org apps) opens its socket HERE with a ticket that names the peer (`POST /apps/:name/channel-ticket { version, peer }`); `pipeChannelToPeer` opens the peer's `GET /channels?app=<name>@<vN>` with the peer record's token in `Authorization` (a person token, so the peer stamps the person) and its `ca` / `servername`, and pipes frames both ways — a clean close passed on as clean, anything else ends the other side abruptly so the peer keeps the place, `?client=` carried, the page's side pinged here, a refusal of the peer's an `error` frame and a 1011. One hop; the token and the peer's URL never reach the page
│   ├── graph-writes.ts    # GRAPH WRITES, HEARD (plans/live-feeds.md §2, §3): `bindGraph` — the runner's per-run view of `services.graph`, its `nodes` / `edges` writers wrapped (a Proxy per mutating call: write, writeMany, update, softDelete, deleteNode; edges write, writeMany, update, delete, move) so each write is noted when it returns; a step calling `graph/*` steps through `ctx.registry` passes the same ctx and is heard too. `graphReporter` gathers a run's writes, types what it can (the run's own writes, then `reader.getNode`, ≤ 50 a send), drops strut's own types (`isQuietType`: `Strut*`, Claim / Check / Evidence, Thing, Schema), and sends a second after the last write (≤ 5 s after the first, and at the run's end): `job.update { kind: "graph", id: <runId>, state: "written", detail: { writes, types, refs } }` to the run's job — cumulative, so the outbox's coalescing loses nothing; Hive re-reads a canvas card's trees on it — and every write to the deployment's `GraphChangeFeed` (`services.graphChanges`, 5 000 writes), which `graph/changes` and `GET /graph/changes` read (ids, types, time). A proposal's apply is heard the same way (`id: proposal:<id>`). Not heard: raw Cypher, another process's writes
│   ├── proposal-feed.ts   # the PROPOSAL FEED (plans/live-feeds.md, "Proposal feed"): a LiveFeed of proposal EVENTS — `created`, `decided`, `applied`, `failed`, the event read off the record's status — one per change, never folded, 1 000 kept, the envelope only (id, status, kind, title + summary cut at 200, actor, time; never the input). createStrut makes ONE and pushes every record the proposals' `changed` hook is told of, beside the `StrutProposal` projection, so proposals.ts knows nothing of it; read by `GET /proposals/changes` and `proposal/changes` (`ctx.services.proposalChanges`), scoped by `visibleTo` like the list
│   ├── proposals.ts       # PROPOSALS (plans/proposals.md): a tool call a person approves before it runs. A step's `describe(cfg, ctx)` (§7, built 2026-10-29) runs at proposal time, best effort, and its `title` / `summary` go on the record for the card (`package/install` reads the package's page off the index). The `agent` step's `approve:` list (beside `agentTools`) gates registry steps: a call to one records a proposal — `<dataDir>/proposals/<id>.json`, moved to `proposals/archive/` once decided (rejected, applied, failed): the step type, the input the step's schema parsed, the model's `rationale` (added to the gated tool's schema), who proposed it (run, path, job, session, actor, principal) — journaled at `<agent path>#<call>` so a resumed turn finds it, and returns `{ proposal, status: pending }` to the model, which goes on. `decideProposal` is the person's door (`POST /proposals/:id/decide { action: accept | reject, input?, reason? }`): accept APPLIES the step in code — the recorded input with the person's edits merged and re-parsed by the step's schema (a bad merge is 400, still pending), under a minimal context (`releaseWith`'s shape: the bag with secrets bound to the proposer's principal, the registry, the job, the decider as `ctx.actor`, the run's MCP servers best effort), the result or the error on the record; reject records the reason; a decided one answers 409 with the record, a `failed` apply may be accepted again. Every list (`listProposals`: `GET /proposals`, a run's, `run.end`, a conversation's turns, the session's `[proposal-result]` lines, `after`) filters an IN-MEMORY INDEX — each record less its payloads, `by` whole, loaded once per process by one pass over both folders and kept current by every write — so only the matches are read; what a request may see (`visibleTo`) is decided on the index too, before `limit`. `run.end` carries `proposals: [brief]` from the records, `GET …/runs/:runId/proposals` the same; a job run's host gets `job.update { kind: "proposal", state }` at each change; `ctx.services.proposals` is the record's writer and reads (the `proposal/list` + `proposal/get` steps). The proposing SESSION is told on its next turn, in code: `[proposal-result]` lines before the prompt, stamped `reportedAt` once the turn commits — never a turn of its own. No proposal types: the step is the contract `requireApproval(type, ctx)`: a step that reaches past this strut (`strut/run-workflow`) refuses unless it runs as an accepted proposal (`ctx.proposal`) whenever a host delta's `approve:` names it — so the builder's `remote` branch (`job/start { peer }`, `meta/run-workflow` with `input.peer`) and `meta/run-step` cannot reach a peer around the gate; no host gate, no change.
│   ├── job-index.ts       # the job INDEX (plans/job-index.md), the read side of jobs.ts: createJobIndex({ dataDir, store, sessions, sealed }) → list (every job newest-used first, each with `workflow` — the newest turn's, `turnOf` — when it has one, `q` through src/search.ts over the title + current deliverables, `workflow` keeps the jobs with a recorded run of it — the sidebar's filter; `actor` the jobs that actor launched a run of — the record's `actors`, `GET /jobs?mine=1`, the sidebar's user icon) / get (runs with status from the run store, threads from the session store — a turn line's `job`, or a thread named after the job — holds, files, and the ARTIFACT FOLD: the successful top-level runs' `artifacts[]` newest first, the first of each id winning, resolved like …/runs/:runId/artifacts — so a turn that ran on a peer (the `builder`'s `remote` branch) folds the peer's deliverables tagged, never `not found`; a sealed workflow's run shows its status and nothing more) / read (one file: text head+tail-capped, an image as bytes for withMedia). createStrut builds it into `ctx.services.jobs` beside the record's writes; `GET /jobs[/:id]` and the job/* steps are thin over it; the projector builds `StrutJob` from `get`
│   ├── job-subject.ts     # what a JOB check reads (plans/job-claims.md §3) — PURE: buildJobSubject(view, { runId, dir, output? }) → `JobCheckSubject`, the job's STATE from the index's view (dir, repos, the artifact fold, holds, `urls`, the turn's output, the latest reply) as the check step's run input, so a check's config says `url: "{{ input.urls.pod }}/settings"` or `cwd: "{{ input.dir }}"`. The verify pass builds it once per pass (`jobInputOf`) for every check on a job subject — in place of the step subject's log-derived input
│   ├── job-threads.ts     # the job's THREADS (plans/jobs-sidebar.md §1): foldJobThreads — every agent execution in a job's runs' logs (a `step.end` carrying `messages`, or an attempt of the core `agent` step) grouped by session into threads, each turn with its run, usage, cost, the thread's context after it (from the session's turn line), tool-call count, transcript link (`?full=1` for a session turn), the run's declared artifacts (on its last top-level turn), and under it what it SPAWNED: a sub-agent by path, a child run by `parentRunId` (hung on the tool call whose output names its run id), a `strut/run-workflow` peer run (one whose output names its session there joins that thread, `@<peer>/<session>`, so a build on a peer is one thread); a step the gate skipped is no turn; a run with no agent is one turn of `stepType: "run"`. Pure; `GET /jobs/:id` serves it as `threads` (`?threads=0` / `?nodes=1` / `?limit=`), the web's Jobs sidebar renders it
│   ├── job-seed.ts        # the ONE workflow strut ships, `job` (plans/jobs.md §5): seedJobWorkflow — createStrut publishes src/workflows/job.yaml at boot by content hash (`publishWorkflowByContent`, `source: "seed"`; a seed always matches git: a new text publishes + activates the next version, a text seen before — a delta taken back out, a template reverted — is made active again, and a workspace edit lasts until the next boot), with the HOST's delta applied first — `createStrut({ job: { tools, system } })`, the twin of `chatSystem`: grants appended to `params.tools` (the lab's `pod/*`), a section appended to `params.system` after strut's (what the deployment adds — which workspace, which peers); the merged text is the hash. Exactly one seeder per name. `job: false` seeds nothing
│   ├── orchestrator-seed.ts # another workflow strut ships, `orchestrator`: seeded exactly as `job` (templateWithDelta from job-seed.ts), with the same host delta — `createStrut({ orchestrator: { tools, system } })` (Peel adds sphinx/*, calendar/*, its automation steps; the lab adds its graph reads, gated writes and its lookups, `explore` + `logs`). `orchestrator: false` seeds nothing. `personalOrchestratorSystem(person)` is the section a PERSON's own strut (a laptop, the desktop app) appends (plans/chained-orchestrators.md §1): its peers are the person's orgs, a turn decides where a request belongs (this machine, or which org), hands an org's to that org's `orchestrator` through `strut/run-workflow { …, input: { prompt, session: "<person>/<org>" }, room: true }` and relays the reply word for word
│   ├── wake.ts            # ONE WAKE (plans/jamie-app.md §1): a job turn (`JOB_WORKFLOWS`) that ends naming a conversation here — job/start's `startedBy.session`, or a host launch's `conversation` (`POST …/run { conversation }`, full scope) — or a host's `POST /conversations/wake { session, source, end }` (a job on ANOTHER strut, its run.end from that strut's room) runs ONE more turn of the conversation's workflow on its session: `input: { prompt, session, context }`, the prompt the workflow's own `params.wake` filled by `wakePrompt` (an `{each}…{/each}` section per job: its reply inline, capped at 6 000 chars, between markers it cannot close; its question; how to continue — job/continue, or the go-ahead to `@<source>`'s assistant; `{silent}` = `[silent]`), the context's `line` the time now in the person's latest turn's `timeZone`, then its `where` (`wakeContext`; a person's turn reads `line` alone, so a host keeps its medium there too), that turn's `params.model`, the job run's actor and principal, the callbacks of the person's latest turn that has them. `jobEnded` → `launched | capped | none`, decided BEFORE the job's run.end goes out (it carries `wake`). Gates: once per job run (`seen`); queued while the session is held or a run launched on it is in flight, every waiting end ONE turn; `max` wake turns since the person's last (turn lines' `wake: true`) → capped; the host did not ask (opt-in per launch: `POST …/run { wake: true }` on the person's turn that started the job — a job a wake turn started, the person's latest — or on the host's own launch of the job beside `conversation`; recorded as `run.start.wakeAsked`; the door is a host asking) → none; a relay (a turn of `origin` peer or app — a person token's) → none; a workflow with no `params.wake` → none. Durable: `<dataDir>/wakes/<session>.json` before launch, cleared when the turn ends (a `session_busy:` failure requeues), `reconcile` at boot after the runs scan (`STRUT_AUTO_RESUME`). The wake turn's `run.start` and run.end carry `wake: { job, runId, peer?, also? }` (`WakeMark`, core.ts; `ctx.wake`, so the agent's turn line says `wake: true`); the 202 of a launch of a `params.wake` workflow on a session says `wake: true`. `createStrut({ orchestrator: { wake: false, wakeMax } })`, STRUT_HOST_CONFIG's `orchestrator`. Pure parts tested in wake.test.ts
│   ├── conversations.ts   # CONVERSATIONS (plans/jamie-app.md §2): the assistant's chats as a person reads them, for a host and strut's own app alike. A conversation is a session whose turns run a workflow with `params.wake` (`isConversationFlow`; never under `peer/` or `app/`); its TURNS are its runs read back (`input.prompt` or a wake's mark, the reply's `text` / `ask` / artifacts resolved, on a wake what the job run it woke on delivered (`delivered`, read from that run), the proposals it made, the jobs it started or continued — `turnJobs`, the kit's `assistantJobs` logic, each with the workflow the launch returned — its status while in flight; a settled turn read once per process). Several people may share one (ruled 2026-11-04): listed for whoever took a turn (actor, else principal), the actor its id is under (`<actor>/…`) and whoever opened it while `shared` (readable to any actor here). Files under `<dataDir>/conversations/` on every backend: `sessions/<id>.json` (title — the first message, Hive's `@<workspace>` line left out, `titleOf` — renamed, shared, forkedFrom, viewers, its turns as run ids with who, when and status, the jobs its turns started or continued — read from each turn's log when it ends, a record from before them filled in the background at its next list — `rev`), `shared.json` (the shared ones' ids: every actor's list shows them, `team: true`, until they open one), `viewers/<actor>.json` (a person's list: each row the record's facts copied, plus their own archived + seenAt, so a list reads one file), `built.json`. Written by createStrut's launcher when a turn LAUNCHES (before its run starts) and ENDS (`launched` / `ended`; the end from the run's terminal event, `RunOptions.onEvent`, before the summary is written) — a failed turn commits nothing to the session, and still shows. A session from before the index is built from its turn lines (`SessionStore.turns`): when read, and all at once at the first list. `get { wait, since }` holds until `rev` moves; fork copies the source's session turn by turn (`appendTurn` per line: the agent remembers) under `<actor>/<hex>`. `ctx.services.conversations`; the `conversation/*` steps and `GET /conversations`, `GET /conversations/item?id=`, `POST /conversations/update`, `POST /conversations/fork` (specs/API.md §9.1) are thin over it. In the graph a conversation is a `StrutChat` of `kind: assistant`, projected from its record with each turn's run (`record` / `conversationRecords`, the projector's reader; never built there)
│   ├── builder-seed.ts    # the third, `builder` (plans/builder-job.md): a WORKFLOW BUILD as a job — the meta/* authoring twins, app/* and git/checkout (a repository to learn from, into the job's directory: the prompt names the job id for its `workdir`) as the agent's tools, the web tools and the editor family as its built-ins (never bash), the `Workflow Builder` page in its prompt, the job's reply shape; its system prompt is the builder CHAT's rules — the dialect, the tools section and the procedure, in the twins' names (`builderRules(JOB_TOOLS)`, ai/prompts.ts) — rendered into builder.yaml's `<<strut: the builder's rules>>` line before the host's delta is appended (`templateWithDelta`'s `fill`), so the hash covers it and a rules change publishes the next version at boot; `peer: true` in the template, so another strut may launch it as published (the orchestrator's door to building on `@acme-web`). Same seeding, same delta — `createStrut({ builder: { tools, approve, system, model, peer } })`, `peer: false` the one addition (a delta may CLOSE a workflow to peers, never open one). A workflow lives on one strut (its graph, secrets, services), so a build runs on the strut it belongs to, while code is checked out wherever a job runs: `job` never carries these tools, and a job agent that meets a build runs `builder` itself through meta/run-workflow (the `Job` page's docs). No bash on it is focus, not a sandbox — it can publish and run an `exec` step or run any unsealed workflow — so `peer: true` says a forwarded person may run code there (builder.yaml's header). `builder: false` seeds nothing
│   ├── concept-seed.ts    # Concept files → `Concept` nodes on either engine: seedConcepts(graph, sets) — a set is a folder of pages + a stamp prefix, a page in either FORM (`parseConceptFile`, plans/concept-history.md §2.1): the old `<Name>.md` (named by its file; front matter `description`, one `parent`) — strut's own pages, every package published before — or the new one, told apart by `name` in the front matter (named by it whatever the file; then every attribute, then `parents`, every parent by name; `renderConceptPage` writes it, what a package build puts under the node key; `NOT_ATTRIBUTES`, what the graph or a seeder stamps or derives, never an attribute), body = docs either way; an attribute the graph's `Concept` does not declare is left out, one log line (`declaredAttributes`); each page reconciled by `unique_source_id = <prefix><file>@<hash>` (create; keep when the node holds the file's text; update when the file changed — or when the node's docs or an attribute the page sets were edited in the graph: a seed always matches git, so every boot puts them back; a deleted page of ours restored; someone else's or unstamped skipped; `legacyPrefixes` = an earlier seeder's stamps counted as ours), a `PARENT_OF` from each parent (a page of another call or already in the graph), an undeclared `PARENT_OF` between two pages the call owns removed — so a package's page under strut's `Job` keeps its edge through strut's every boot, `retired` files soft-deleted while they carry their stamp (`retireConcepts`). A set with `keepEdited` (a package's, src/packages/install.ts) keeps a page of its own whose text was edited in the graph — the outcome says `edited` — takes a deleted node under a page's name, and counts a stamp of any of its files as its own (a page a release moved to another file — the old form rebuilt under its key — is written again). Engine calls only (refByKey / readRaw / the writers / liveEdgesOf), no Cypher. createStrut seeds STRUT_CONCEPTS at boot on a graph (`concepts: false` seeds none); a host seeds its own sets with the same call afterwards and anchors pages from the outcomes it returns
│   ├── concepts/          # the Concept pages strut SHIPS (copied into build/ by `npm run build`): `Workflow Builder` (what the builder's prompt reads; byte-identical to the page the stakgraph lab seeded first, whose stamps `lab/builder/concepts/` + `lab/job/concepts/` count as strut's) and `Job` (what the job workflow puts in its agent's prompt, `context/concept`) — roots, workspace-general; each deployment grows the tree under them — ONE TREE PER AGENT: `Job` is the job agent's and `Workflow Builder` the builder's, and the orchestrator reads the kinds under BOTH (`docs: false`) as its two lists, so a kind the builder builds is listed under `Workflow Builder`, never under `Job` (`Workflow Build`, the builder's entry under `Job` while the orchestrator read `Job` alone, is `retired` in `STRUT_CONCEPTS` and soft-deleted at boot; `Job`'s own docs tell a job agent that meets a workflow or an app that lives in a workspace to run `builder` through meta/run-workflow) — and `App` UNDER `Workflow Builder`: the builders' manual (layout, kit, hooks, grants, routines; hand a published app over BY NAME, `{ kind: "app", app }`). `Job App`, the job side of an app, is `retired` too (2026-10-22): a page over a job's own results is an HTML file in its directory, an app is the builder's, and `Job`'s docs say to pass the builder's app deliverable on
│   ├── artifact-refs.ts   # deliverables (plans/jobs.md §3): a run output's `artifacts: [{ id, kind?, title, path | url | content, render?, from? }]` resolved to links for the `run.end` callback and GET …/runs/:runId/artifacts — `path` → `/jobs/<job>/files/…` (a job run) or `/artifacts/<runId>/…`; `kind` from the extension when omitted (the host's renderer names). `kind: "app"` is strut's own, two forms: `app: "<name>"` (+ `version?`) is an app PUBLISHED in the workspace — the builder's deliverable (2026-10-22) — resolved to the version's document (`/apps/<name>/<vN>/files/dist/index.html`, the active version unless named; `appVersion` → `apps.versionDir` + `dist/build.json`) with `app: { name, version, hash, builtAt }` beside the url, `no such app: …` otherwise; a `path` is no app — an entry with an error saying to hand it over by name (a JOB's app directory is retired, plans/chained-orchestrators.md §6). An entry tagged `peer` (another strut's — strut/run-workflow tags them, plans/builder-job.md §3) is left as it came: its `path` (in `job`'s directory THERE) and `url` the peer's, no link made here, no `not found` — the reader resolves it against the peer by id (the handle rule, plans/federation.md §2.2). The WORK-PRODUCT kinds (plans/work-products.md): `sheet`, `table`, `timeline`, `docx`, `redline` (`.docx` → docx, `.csv`/`.tsv`/`.xlsx` → table), `render` (a file a page draws in the thing's place, resolved like `path`, left out when missing), `from` (the graph ref_ids it was made from → `StrutArtifact -[:DERIVED_FROM]->` each node the graph holds, projector.ts); `liftedArtifacts` — what a tool's result declared, put on its `step.end` by `wrapToolsWithEmit`
│   ├── auth.ts            # the pieces of createStrut's one gate in front of EVERY route, reads included — carriesApiKey (Bearer or `?key=`) + requireApiKey (the per-route twin) + warnIfUnconfigured (STRUT_API_KEY shared secret) + the PEER KEY (STRUT_PEER_KEY: carriesPeerKey, scopeFromKey — the default `resolveScope`; a `peer` request reads, launches a `peer: true` workflow, controls a run a peer launched, and the gate 403s the rest) + the PERSON TOKEN (personToken / verifyPersonToken / personOf: the peer key attenuated to one actor, `strut-person.<claims>.<hmac>` signed like a session, Bearer only, minted by `POST /peers/tokens` — scope `peer:person`, `isPeerScope`: a peer whose actor is its credential's own, which alone launches a `peer: person` workflow, opens its actor's own sessions and gets an app's `step_run` alone on `POST /mcp`; plans/chained-orchestrators.md §2, plans/apps.md §7.4) + actorFromHeader, the default `resolveActor` (x-strut-actor, honored only with the key; a person token's actor wins) + the FILE TOKEN (fileToken / fileScopeOf / carriesFileToken): the key attenuated to one run's or job's files, an HMAC the listing mints, what an artifact link carries as `?t=` so the key is never in a URL a served page can read. The app IDENTITY a served document carries: `appIdentity` (`app:<name>@<vN>.<token>`), read back by `appOfIdentity` → `ctx.app`. The CHANNEL TICKET (`channelTicket` / `channelTicketOf`, plans/app-channels.md §2): `strut-channel.<claims>.<hmac>` naming the viewer, the app and its version for a minute, the one credential that opens `GET /channels` — a browser host's upgrade, which carries no header (unsigned, and taken at its word, with no secret to sign under)
│   ├── public-surface.ts  # the PUBLIC SURFACE — the PUBLIC VIEW in the UI, never a "publish" (plans/public-surface.md §2, §4): what a PERSON chose to show anyone, live and read-only — Concept roots (the subtree under each by PARENT_OF), workflows (`runs: true` adds their runs, input whole), steps (with the `_` helpers their relative imports reach, `stepHelpers`), node types, apps (`reads`, `domains`: the app half is item 2). One record, `<dataDir>/public.json` (`readSurface` / `writeSurface` / `surfaceProblem` / `normalizeSurface`), written only by `PUT /public-view` (full scope; no step or builder tool). `createPublicSurface` is what the routes read through: the public Concept trees (walked live from each root, reused 30 s), each public run's named nodes (`step.end.nodes`, kept per finished run in `<dataDir>/public/run-nodes/`), `visible(ref_id, type)` (§4: under a public root, named by a public run, or of a public type), and `reader()`, a GraphReader that answers only with visible nodes and edges between two of them (`publicReader`; the namespace registry refused). `publicEvent` / `publicSummary`: a run as a visitor reads it — no actor, principal, job, `startedBy`, callback or MCP origin; a session as a `/public` transcript link. A visitor's `step_run` (§5): `visitorRefusal` (an app in the view at the version it serves; run reads on public workflows, with runs; `VISITOR_GRAPH_READS` through the filtered reader; the app's `reads`; launching, jobs, `app/*` and graph writes refused), `visitorRuns` (the runs capability held to reads, records scrubbed, deliverable links under `/public`, a job run's files closed)
│   ├── public-routes.ts   # the `/public/*` routes (decision 13, ruled): a route family of its own, answered from the surface alone WHATEVER the gate's mode, so a host gate in front of an unkeyed strut passes the prefix by path and nothing else opens; a route nobody mounted there does not exist there. Paths mirror the private reads (`/public/workflows/:name/flow`, `…/runs/:runId/events`, `/public/steps/:type/source`, `/public/concepts/:name`, `/public/graph/nodes/:ref_id`), shapes minus who and where; `/public/apps[/:name[/document]]` the public apps, each at the version the view serves, the document carrying a VISITOR's identity (`publicAppIdentity`, auth.ts: signed over `public-app:`, so it opens `POST /public/mcp` and nothing else) and `<meta name="strut-public-view">` (the kit's `useHost().public`). CORS `*` + preflight, a per-address budget for reads and the visitor door (`PUBLIC_REQUESTS_PER_MINUTE`, `visitorAddress`), `PUBLIC_PATH` (what the gate opens). `POST /public/mcp` itself is createStrut's: `buildAppTools` with `visitor` (the public identity, `visitorRefusal` after the grants, nothing kept) over a bag of reads alone — `http`, `secrets`, the graph's filtered reader, `visitorRuns`. The person's door is `/public-view` (GET / PUT, `needs`), behind the key; an app it adds is HELD at its version. specs/API.md §17
│   ├── public-view.ts     # what adding an app or a workflow to the public view brings along (`publicViewNeeds`, `GET /public-view/needs`; decision 20): an app's granted workflows with runs, the custom steps their closures run, its granted reads (pre-checked when `effect: "read"`), the Concept roots its workflows read through `context/concept` (a literal or `{{ params.X }}`; a name from the input is `perRun`), each line with what it shows anyone — the Publish dialog's Public view tab (web/src/components/PublicViewPanel.tsx) pre-checks it, the person unticks, Save writes the whole list
│   ├── brand.ts           # the BRAND (specs/API.md §14.12): what every app here is shown in — `{ color?, colorDark?, radius?, font? }` in `<dataDir>/brand.json`, `PUT /brand` (full scope, replaces it whole) and `GET /brand` (any credential), both answering `{ brand, styles }`: `brandStyles` turns it into MCP Apps STANDARD style variables per theme (`--color-background-inverse` + `--color-text-inverse` picked for contrast + `--color-ring-primary`, `--border-radius-md`, `--font-sans`), which strut's app host sends in every page's host context (web/src/app-host.ts `hostContextFor`) and the kit's base.css already reads before its defaults — so no app is rebuilt. Standard names only: the MCP Apps client refuses a context carrying one the spec does not list (`--primary`, `--chart-1`)
│   ├── secret-store.ts    # SecretStore iface + FileSecretStore (AES-256-GCM, STRUT_SECRET_KEY; optional filename for a second file) + MemorySecretStore — backs ctx.services.secrets + /secrets endpoints
│   ├── session-store.ts   # agent sessions (plans/agent-sessions.md): SessionStore iface + FileSessionStore (sessions/<encoded id>/: system.md + messages.jsonl + turns.jsonl — a turn line is the commit; `turns(id)` reads the lines alone) + MemorySessionStore, idProblem (the id format, shared with git/checkout's `workdir`), and `sessionsCapability` — `ctx.services.sessions`, whose `open` takes the session's in-process lock (`session_busy:`)
│   ├── peers.ts           # PEERS (plans/federation.md §2.2, §3): the other struts this one may call — `{ id, baseUrl, token, label? }` in a fourth encrypted file, peers.json (`P_<hex(id)>`), behind PUT/DELETE/GET /peers (GET: ids, labels, base URLs — never a token) + `STRUT_PEERS` / `createStrut({ peers })`, the paste door for a strut nobody pushes to. `ctx.services.peers` names a peer and makes a request with its token injected (readable by nothing; what a step can do through it is the token's scope on the peer). The client the step and the builder's `peer` tools share: launchOnPeer (POST …/run, `x-strut-actor: ctx.principal`), tailPeerRun (the peer's SSE tail, reattached with `?skip=N` after a drop — reader-initiated, so a strut behind NAT can call a cloud one), cancelOnPeer, runOnPeer, listPeerWorkflows / readPeerWorkflow
│   ├── actor-secrets.ts   # per-ACTOR secrets (plans/code-change.md §3.2): ActorSecretStore over any SecretStore (`A_<hex(actor)>_<NAME>` keys; a third encrypted file, actor-secrets.json), behind PUT/DELETE /actors/:actor/secrets/:name + GET /actors/:actor/secrets. The runner binds a run's `secrets` to its principal (`SecretsCapability.forPrincipal`), so `secrets.get(NAME)` resolves the actor's value first — never in /secrets or list_secrets
│   ├── capabilities.ts    # the standard services bag steps build on: http (fetch-like, plain result), secrets, artifacts (per-run files), shell (subprocesses), jobs (a job's holds, jobs.ts) — every one recordable by cassette.ts + secret-safe
│   ├── extensions.ts      # the GENERIC extension points a feature registers into (no feature words in it; privacy/boundary.test.ts enforces that): `registerModelWrapper` (`resolveModel` hands every model it builds to `applyModelWrappers(model, { provider, modelId, baseUrl?, routed, ctx?, session? })` — `stepAuth(ctx, session)` carries the step's context and agent session through), `registerToolWrapper` (the agent step's `wrapToolsWithEmit` calls `applyToolWrappers(tools, ctx)` first, so every tool set — built-ins, web tools, MCP, agentTools — passes through it), `registerSetting({ key, schema, normalize? })` and `resolveSettings` / `validateSettings`: a setting is set at four levels, highest wins per key and whole — step `options.settings` > run (`POST …/run { settings }`, `RunOptions.settings`) > workflow YAML top-level `settings:` (`Flow.settings`) > deployment (the `STRUT_HOST_CONFIG` file's `settings`, `createStrut({ settings })`, on the services bag) — and arrives as `ctx.settings`; a subflow inherits its caller's workflow level and the subflow step's options (they win per key over the child's own), a foreach's or loop's `options.settings` reach its body; validate.ts checks a workflow's block. Nothing registered: every function returns what it was given. The one feature on it today is privacy (src/privacy/register.ts, imported once by createStrut): the `privacy` setting, `off | hosted | strict | { mode, mask?, detect?: { llm } }`, off by default — see "Private AI" below and specs/PRIVACY_SPEC.md §10
│   ├── env.ts             # the ENV BOUNDARY: `bootEnv()` is the one way strut's own code reads the environment (env.test.ts fails on a `process.env[…]` read anywhere else under src/), and `scrubProcessEnv()` — called by the default server's entry (`startServer`: server.ts, desktop.js), never by createStrut — copies the env into that snapshot and empties `process.env` down to `KEEP_ENV` (the shell allowlist + what Node reads lazily + what Windows needs to spawn), so a step's `process.env.X`, or a child it spawns with `process.env`, finds nothing while `ctx.services.secrets` still resolves a key the deployment set in env. `STRUT_ENV_SCRUB=0` / `STRUT_ENV_KEEP`. A host that embeds strut calls it itself once its steps read through ctx.services
│   ├── step-lint.ts       # the static check on a custom step's SOURCE — imports of child_process / fs / net / http (RISKY_MODULES), a `process.env` read, the global `fetch`, opening the graph itself (`openGraphBackend` and its siblings — the deployment's shared connection; a step that closed it took swarm38's graph down, 2026-10-28) — each with what to use instead. The builder's create_step / edit_step (+ meta/* twins) REFUSE on a finding (authoring.ts); `POST /steps` publishes and answers with `warnings`; the registry WARNS when it loads a workspace step from disk, whoever put it there (registry.ts `warnPastServices`, once per file version; static, so it holds under tsx, which loads a workspace `.ts` as CommonJS past any ESM resolve hook) — the place a later strut refuses to load it
│   ├── model-worker.ts    # a local model in a WORKER THREAD: `ModelWorker` builds an object in the worker from a named factory (`{ module, factory, options }`; entry model-worker-entry.ts) and answers `call(method, args, transfer?)` — calls start in order, buffers in `transfer` move instead of copying, the worker starts on the first call and again after it dies, and holds the process open only while a call is in flight. onnxruntime and sherpa decode synchronously, so a model on the main thread stalls every request; the embedder (`WorkerEmbedder`), the dictation recognizers (audio/decoder.ts), the speech synthesizer (audio/synthesizer.ts) and the privacy NER and LLM detector (privacy/ner.ts, llm.ts) run on it. A worker sees the environment as the env scrub left it, so a model's settings (its cache dir) are read on the main thread and passed in `options`
│   ├── shell.ts           # every child process strut spawns: env scrubbing (allowlist, never process.env), runCmd/runShell (agent + builder bash tools), runProcess (the shell capability / exec step: exit code, stdin, abort → process-group kill, head+tail output cap)
│   ├── aieo/              # aieo, the model layer (moved from stakwork/stakgraph's mcp/src/aieo, history kept): model names → a working AI SDK client (resolve.ts: aliases, `provider/id`, the OpenRouter prefix trap; provider.ts: keys and their companion headers, each provider's client and quirks — thinking rules, Maple's reasoning efforts, gateway paths — output caps, context windows, prices, `computeSessionCost`; the MODEL CATALOG, bifrost's datasheet as data — `loadModelCatalog`, the gateway's key rule, `getModelPrice`, consulted after Maple's and Numes' own tables and before the hand-kept ones; `STRUT_MODEL_CATALOG`), the web tools (search.ts: native Anthropic or Exa; fetch.ts: native or a guarded HTTP fetch, citations), usage, and the helpers its npm users call (`callModel`, `ConversationStorage`). Strut imports it only through `loadAieo()` (llm.ts), lazily: its index loads every provider SDK. Its own env reads go through `env.ts` (`useEnv`), the one file env.test.ts lets read `process.env`. Its five suites sit beside the sources; the npm package is `aieo/` at the root
│   ├── llm.ts             # resolveModel()/listModelOptions()/loadAieo(): strut's glue over aieo's resolve.ts (src/aieo/) — the chat, agent + llm steps resolve model NAME → provider/id/LanguageModel/output cap here; keys via ctx.services.secrets (store → env); backs GET /llm/models. Also the `llmAuth` seam (plans/mothership-cost-control.md §1): a host hook that returns {apiKey, baseUrl, headers} per call, consulted before the client is built; `stepAuth(ctx)` builds a step's call context
│   ├── mothership.ts      # OPT-IN Mothership cost control (plans/mothership-cost-control.md §3): createMothership({ dataDir }) → { llmAuth, mount }. Hive pushes one standing macaroon per user (PUT /llm/delegations/:actor); strut appends keyless HMAC links per run and per step (gatekey `attenuate`) so the gateway bills user × workflow × step and caps the run. Delegations live in a second encrypted file (mothership.json), never on the services bag. Core never imports it
│   ├── index.ts           # barrel export — createStrut (primary entry), createRegistry, coreRegistry, all types
│   ├── yaml.ts            # dumpYaml / loadYaml: js-yaml with strut's own dump options (lineWidth 120, no anchors), on the barrel beside `z` — for a seeded custom step, which resolves `strut` and no other package
│   ├── tar.ts             # tar / untar: a plain ustar archive of regular files (names past 100 bytes split into ustar's prefix, refused past it; the reader refuses a non-file entry, a name twice, a cut archive) — a memory snapshot and a package archive
│   ├── workflows/         # the workflows strut SHIPS (YAML, copied into build/ by `npm run build`): job.yaml — job/dir → checkouts (git/checkout into the job dir) → the `Job` page → the KIND's page (`input.kind`, a page under `Job`: rendered at the head of every turn's PROMPT, so the agent starts from the kind's convention instead of having to open it; nothing without one) → agent (session: the job, structured { text, artifacts, ask? }; git/checkout among its tools, so a repository it finds it needs mid-turn — a private one too — is checked out into the job dir with the person's token, which bash never holds) → pack; every step strut's own. orchestrator.yaml — one turn of a long conversation: job/dir (no job → the run's artifact dir) → context/concept twice (the CHILDREN of `Job` — the kinds of work a job does here — and of `Workflow Builder` — the kinds of thing the builder builds — `docs: false`, no `tool`, for the end of the prompt, so the turn routes a request by kind: a job's passed as `kind` on job/start, a build's named in the brief) → agent (session: input.session, one per conversation, compacted in place; its prompt is the first turn's; toolFilter [none], job/start, continue, list, get, read + strut/list-peers + strut/run-workflow (a peer's workflow, inside the turn) as tools, job's reply shape) → pack; `peer: person` (another strut launches it only through a person's credential, on that person's own session — plans/chained-orchestrators.md §2). The turn is the conversation, the work is a job's: it answers from what is already KNOWN, ASKS what a request needs answered first, may run a LOOKUP the deployment grants (a workflow that returns an answer, here or on a peer) to ORIENT — its answer the reply only when it is the whole answer, else a job's brief — and starts jobs detached for anything to be found out or made (one sentence: to build, change, test or debug a workflow, or an app that lives in a workspace, start the job with `workflow: builder`, `peer` when it belongs on another strut — `builder` a field value, never a noun the person hears; one more line: talk to the person in their words, never the names of tools, workflows or the lists — the rule itself rides on job/start's schema, and what the builder builds here is the second list). params.tools + params.system + params.wake (the prompt of the turn strut runs when a job a turn started ends, src/wake.ts) are the evolvable surface; `context: { line, where?, timeZone? }`: `line` heads the prompt; `where` (the medium alone) and `timeZone` are read by the wake only, which puts the time and `where` in its own `line`. builder.yaml — a workflow BUILD as a job (plans/builder-job.md): job/dir → context/concept on `Workflow Builder` → if (`input.peer`) → agent (session: the job; toolFilter = params.builtins, the web tools and the editor family; agentTools = meta/* + app/* + the graph reads + job/list, get, read + git/checkout; system = the chat builder's rules in the twins' names around the job's own text; job's reply shape) | strut/run-workflow (the PEER's `builder` under this job id — the build happens there, this run waits and reattaches) → pack (+ `peer`); `peer: true`. private-ask.yaml (privacy/anonymize → llm → privacy/deanonymize; an llm error destroys the vault and is the run's error), browser-capture.yaml / browser-explore.yaml / browser-captcha.yaml / browser-watch.yaml — the browser workflows (src/browser/seed.ts): one declared browser/capture call (its `claims:` block checks the PNG on disk), an agent whose tools are `browser/*` (on a captcha it keeps the page for the job and stops, `captcha: { session }`), one round of a captcha a PERSON solves on that kept page (crop + manifest to ask; tap / type the answer, verify, look — never solved by the agent), a scheduled region reader that diffs against `last`
│   ├── apps/              # APPS (plans/apps.md, work items 1b + 1c + 6; a JOB's app, work item 2, is retired — plans/chained-orchestrators.md §6). a front-end project the builder writes over workflows. views/ + views-seed.ts (6): `strut/views`, below, seeded at boot by tree hash (`seedBundledApp`: an app strut ships, built once per machine per (sources, kit, imported apps), its document rebuilt in place when an app it imports moved). jamie/ + jamie-seed.ts (plans/jamie-app.md §5): `strut/jamie`, below, seeded after strut/views; `strut/assistant`, its name before, removed at boot. tools.ts (1c): `buildAppTools` → `step_run { type, config?, input?, app }`, the ONE tool a page calls, served APP-ONLY on both MCP doors (`APP_TOOL_META`: `_meta.ui.visibility: ["app"]`), and ALONE to a person token on `/mcp` — how a person's own strut hosts an app that lives here (plans/apps.md §7.4: the read-through serves the app's list, listing and document and `POST /peers/:id/mcp` relays its calls; strut's UI lists peers' apps as `?app=@<peer>/<name>`) — `app` is the page's identity (`appOfIdentity`, auth.ts); the grant checks before dispatch (`grantRefusal`: run/* only on `grants.workflows`, any other type only when `grants.steps` names it, `llm` / `agent` / `exec` / `acp/prompt` and a sealed step refused whatever the manifest says, `sqlite/*` / `automation/*` not yet, the authoring writes and `job/start` / `job/continue` never; a `job` in any config the APP's — `scopeAppJobs`: the page's `library` kept as `app/<name>/library`, `job/list` held to that prefix — so `run/launch { job }` runs a workflow in the app's own job and `job/upload` puts a file there (plans/apps.md §12); `graphWriteRefusal`: a graph write only on a declared type — the config's type for a create, the node read for an edit or delete by ref_id, literals only, an edge by its endpoints, never a type strut keeps whatever the manifest says); dispatch through `runStep` as the viewer with `ctx.app` set, a write KEPT (`keptFromApp`: the graph writes, app/report-error), a result over 5 MB an error. A FIRST-PARTY page (`firstPartyApp`, plans/jamie-app.md §3: a `strut/` app at a version strut seeded, shown to a viewer with an actor, never a visitor) gets `ctx.app.firstParty` — carried by every run it launches — and acts with its viewer's rights: a sealed workflow with no grant, the viewer's runs of it whoever launched them, and every turn of a conversation the viewer may read — one they are in, or a shared one (`openFlow` / `ownRun`); its runs open the viewer's own sessions as they are (`appSessionId`) and a conversation the viewer took a turn in or a shared one (`continues`, plans/jamie-app.md §2.2), keep their agents' gated tools, start the person's own jobs and ask for strut's wake; `conversation/*` and `proposal/decide` (specs/API.md §14.10). — a directory with `app.yaml`, `src/`, `public/`, `db/` — a directory with `app.yaml`, `src/`, `public/`, `db/` — built against the KIT into one self-contained document. manifest.ts: the zod shape of `app.yaml` (title, icon, `entry`, `grants` { workflows, steps, sqlite, automations }, `data.graph` types (+ `key`, the key spec, default `[name]`; `search`, the index) and edges with the `string | number | boolean | date | json` + `?` grammar — `csp.resourceDomains` — `wallet`, the Lightning wallet connection the app REQUESTS of the person's host: NWC-08's fields, its lists copied from `@strut/kit/wallet` and held equal by build.test.ts, granted only by the person in the host, specs/WALLET.md §5), errors a model reads. graph-types.ts (work item 4, on Neo4j and a LadybugDB file alike): every build checks `data.graph` against the graph (`checkAppGraph`: a type strut keeps — `Strut*`, `Thing`, `Concept`, `Claim` / `Check` / `Evidence`, `reservedAppType` — refused; an attribute held as another type, another key, a required attribute left out, a build error; no graph (the fs workspace), the app does not build; on Ladybug an attribute another type, or another of the app's types, holds as another column type fails the build) and a publish registers it BEFORE the version (`registerAppGraph`: `createNodeSchema` per type, add-only, then each edge's schema; the result's `graph`); `number` → `float`, `date` and `json` → `string` (ISO text, JSON text). build.ts: `buildApp(dir, deps)` (lazy-imported, like a lib step's SDK): esbuild over the kit's import map through `appResolver` — relative imports inside the directory, `@/…` the app's `src/` then the kit (shadcn's model), a bare specifier the vendor file, one naming an INSTALLED APP (`strut/views`, `hive/ui@v3`) that app's `src/` compiled into THIS bundle (§3.4; a cycle refused naming the chain), anything else an error naming the set and the kits; `http(s):` refused; never `node_modules` — the source checks (`dangerouslySetInnerHTML` / `eval` / `new Function` refused, a global `fetch` / `XMLHttpRequest` / `WebSocket` a warning naming the hook, imported apps' sources included), Tailwind 4 `compile()` over the kit's base stylesheet + every `.css` in the directory + the candidates scanned from every bundled source, assets inlined, the §9 CSP, ONE `<style>` + ONE module script (the kit's bootstrap + the bundle) and an EMPTY `<meta name="strut-app-token">` the file route fills when it serves (`withToken`) — `dist/index.html` + `dist/build.json` (kit, builtAt, the tree hash, each imported app's name, version, hash, the manifest's `title` and its `wallet` request); deterministic. kit.ts: where the kit is (`@strut/kit` when pinned, else the repo's `kit/`; its `vendor/` must be BUILT — `npm run build:kit`). files.ts: the version directories under `<dataDir>/apps/<name>/<vN>/` (name segments as folders; `validateAppName`: workflow-style segments, `/` a package prefix, no `vN` segment, `@` the pin; `reservedAppName`: `strut/` is strut's, so `apps.publish`, its preview, `POST /apps` and a package install refuse it to anything but the seed), the file-route guard, the copies. objects.ts: an app's HISTORY — each version's source files once, by sha256, in `<app>/.objects/`, and its tree (path → sha256) in `<app>/.trees/<vN>.json`, so a version that changes one file adds one file; the version directory is a cache over it (`APP_VERSIONS_KEPT`: the active version + the newest 5 keep theirs). apps.ts: `createApps` → `ctx.services.apps`, what the `/apps` routes and the `app/*` steps are thin over — list / get (`stale`, `missing`, `inertGrants`) / build / publish (BUILDS FIRST, a failing build publishes nothing; `surface: "ai"` refuses `llm`, `agent`, `exec` and anything sealed in the grants; `"person"` grants anything; a HELD app's publish is a draft, `live: false`) / checkout / init / promote / setLive / releases (plans/app-releases.md). grants.ts: a PERSON's grants of SEALED workflows to an app, by its name (`<dataDir>/app-grants.json`; "The assistant in an app"). releases.ts: an app's LOCK — `takeLock` (every workflow the version grants, the subflows they reach, the custom steps the closure reaches, as active now, and `floating`: what it cannot see), `lockDrift` (`behind`), `lockProblems` (a release whose lock names something gone). monitor.ts: what an app's pages cost the server — every `step_run` of a known app counted per app, per minute, per version, by step type (calls, failures, result bytes, server time; reported for the hour and the day) and judged by five rules in tumbling windows (`APP_MONITOR_LIMITS`: `fanout` — one viewer, one type, many configs in 10 s, a call per item; `repeat` — the same call polled faster than a kit hook; `volume`; `bytes`; `failing`), each WARNING kept a day on the VERSION that caused it, with `message` + `fix` written for the builder: `GET /apps/:name/usage` (read through for a peer's app), `warnings` (the active version's count) on `GET /apps`, `usage` on `app/get`; the UI's dot + Usage flyout. KEPT ON DISK, `<app>/.usage/<YYYY-MM-DD>.jsonl` (UTC; a dot folder, so no nested app name collides): one line per minute and version (`{ at, version, types: { "<type>": [calls, errors, bytes, ms] } }`, a minute possibly over a few lines, summed on read) and a `{ warning }` line written the moment a warning fires; written every 15 s and on `strut.close()`, read back on an app's first touch (the minute and hour volume counts rebuilt), 30 days of files kept — a crash loses the last seconds of counts, never a warning. templates/: `app/init`'s starters (`default`: a shadcn sidebar, react-router, an empty `db/`), copied into build/ by `npm run build`; `__fixtures__/hello`: the app the build tests drive
│   │   ├── jamie/         # `strut/jamie` (plans/jamie-app.md §5): JAMIE, the person's assistant, as a first-party app (src/apps/tools.ts `firstPartyApp`: it acts as its viewer) — Hive's org-page chat ported onto steps. app.yaml (grants: orchestrator, job, builder; conversation/list, get, update; llm/models; graph/find; job/get, updates, verify, evidence; proposal/get, decide; sheets/get-values; github/pr-status, merge-pr; secret/add), src/App.tsx (the chat list beside the thread; opens on a new conversation, never the last one; a row or `?input=session%3D<id>` opens an earlier one; the thread always shows: wide, the list is docked and folds away, remembered per viewer; narrow — a phone, or a host's side panel open beside the page — it is a drawer over the thread), src/hooks.ts (`conversation/list` read every 5 s; a conversation followed with `conversation/get { wait, since }`, a call a second at most, none while hidden; `run/launch` of `orchestrator` with `input: { prompt, session, context }`, `params.model`, `attachments`; `run/cancel` is Stop; `llm/models`; `graph/find` on `Concept` for "/"), lib/ (pure, tested by src/apps/jamie.test.ts: chat.ts — the context line (Hive's `orchestratorContextLine` + `WHERE`), day groups, `<viewer>/<12 hex>` ids, what a refused send means (`session_busy:` the busy notice, `conversation_not_yours:` another person's conversation that is no longer shared — plans/jamie-app.md §2.2), "/" trigger and insert; artifacts.ts — where a deliverable shows: what strut/views draws (markdown, text, sanitized HTML, image, CSV table, walkthrough, a Google Sheet) inline through `run/files` / `sheets/get-values`, the rest (a PDF, video, app, a peer's file via `peerArtifactPath`) handed to the host as `?artifact=<served path>` / `?app=<key>` (`ui/open-link`; the host's side panel, plans/jamie-app.md §4); jobs.ts — a job turn's pill, the live strip's line and tally, a claim's pill and open slot, a captcha's manifest, taps and `[captcha-answer]` turn, a build's `ask.secret` and its `[secret] NAME stored` turn; pr.ts — which artifact is a pull request (`kind: pull_request` with a GitHub link), its pill, its checks in a line, when Merge is offered, Fix's prompt), components/ (ChatList: a "Shared" group of the team's shared chats first, then by day, search, show more, rename inline, archive/restore, share or stop sharing, unread and working dots, a pull-request count; under each row its jobs — the newest, the rest behind "N more", a pulse while one runs — a click opens the conversation at that job's card (`focusJob`); Thread: turns oldest first — the person's words and files or a wake line (only for a job with no card in the thread), the working card, the reply as markdown, the question, on a wake what the job delivered (`delivered`), then JobCard, ProposalCard, ArtifactCard per what the turn holds — the reply's copy of a delivered thing, or an entry that opens nothing, left out (lib/artifacts.ts `turnDeliverables`), one card per pull request in a thread (its newest mention; `ThreadPrs`), Copy on a reply (`CopyButton`: the clipboard API, else `execCommand`); Attachments: a person's files under their message — an image a thumbnail that opens large, a text file to read in place, the rest by name — through `run/files` on the turn's run (lib/attachments.ts); Composer: files by clip/drop/paste checked against the server's caps, the model picker remembered per viewer, the "/" menu, Send becoming Stop; JobCard: `run/get` live — on the workflow the turn recorded, else the job's record's (`jobRunWorkflow`) — `job/get`, `useJobUpdates` while it runs, its reply, deliverables, ClaimsPanel (`job/verify` detached, `job/evidence` on a claim waiting on a look) and CaptchaCard (the crop through `run/files`, tiles or points or text, Skip; sent as a job turn naming the conversation) and SecretBox (a build's `ask.secret`: a password box under the question for the person who started the job, until the job takes another turn and never for a build on a peer — `secret/add`, then a `[secret] NAME stored` job turn naming the conversation), its pull requests in sight collapsed; PullRequestCard: `github/pr-status` with the viewer's token, again every 30 s while open — state, branches, checks failed first, the description folded — Merge (`github/merge-pr` at the head the viewer saw) and, on failed checks, Fix (a job turn naming the conversation); ProposalCard: the card's fields, `proposal/get` live, `proposal/decide` with the card's own button words). Excluded from the root tsc; `npx tsc -p kit/tsconfig.jamie.json` checks it against the kit and strut/views
│   │   ├── knowledge/     # `strut/knowledge` (plans/knowledge-app.md; specs/API.md §14.13): the organisation's Concept tree as a first-party app, read-only — in place of Hive's org graph view. app.yaml (grants: graph/find, graph-edges, graph-get-batched, graph-neighbors, graph-search; nothing else), src/App.tsx (the outline left with NodeSearch on `Concept` at its top, the GRAPH in the middle — NodeGraph on PARENT_OF only, round the concept picked there, each node's chip expanding or collapsing its neighbours — and the concept a click picks in a panel right, ✕ to close; narrow, the graph, the outline and the concept take the page in turn; `?input=concept%3D<ref_id>` opens one and each selection is sent back as `ui/open-link` to the app, so the host's address bar follows; the open rows remembered per viewer, `useAppState`), lib/tree.ts (pure, tested by src/apps/knowledge.test.ts: Hive's workbench model — roots have PARENT_OF children and no parent, biggest first; the unplaced; a row per path, so a concept with two parents is a row under each; the path through the first parent; cycle-safe), lib/read.ts (`graph/find` pages of 200, then `graph/graph-edges` 1,000 at a time with every Concept as `among`; capped at 5,000 Concepts), components/ (Tree: rows with Hive's amber dot — filled when there are docs — the selected row and its path lit, ↑ ↓ ← → ↵; Detail: path, description, docs through DocumentView, parents and children as chips, repo and file). Excluded from the root tsc; `npx tsc -p kit/tsconfig.knowledge.json` checks it
│   │   ├── views/         # `strut/views` (plans/apps.md §3.3, §3.4): strut's components for its OWN concepts as an app other apps import — `import { RunTimeline, RunGraph, LaunchForm } from "strut/views"` compiles these sources into the importer's document, tree-shaken (the build marks an installed app's modules side-effect free and appends a kit stylesheet only when its importer is in the document), and they run on the IMPORTER's grants. app.yaml (no grants), src/index.ts (every export), src/App.tsx (the GALLERY: each component over fixtures, through a fixture client answering the steps they call). RunStatus, RunList (`run/list`), RunTimeline (the run-overview fold), Transcript (the transcript fold, over messages you pass or read from a run's agent step — `{ workflow, runId, path, full? }` through `run/transcript`, its cut said under it), LaunchForm (a routine's face, §5.1: the `input:` block from `run/workflow`, `useLaunch` with a dedupe key — workflow + input by default — the run it joined, the last run's status, cancel), ArtifactView (`run/files`: markdown, an HTML page and text through DocumentView, images, video, audio, the walkthrough scrubber; a PDF opens in strut — the document may not frame), DocumentView + SafeHtml (an HTML page drawn from `sanitizeHtml`'s tree with `createElement`, markdown, text — `terms` highlighted, the first scrolled to; a link opens through the host), RunHealth (`foldRunHealth`), WorkProducts (`useWorkProducts`: a run's work products as a shelf that fills while it goes — a card per product with its maker and what it draws on, opened in the viewer its kind reads in, a sheet or table through SheetView, `renderers` per kind; fixtures/matter.ts the gallery's legal matter), NodeCard / NodeSearch / NodeGraph (React Flow, straight border-to-border edges — FloatingEdge — each node's chip expanding its neighbours or collapsing what that expansion placed, a click `onSelect`, `selected` marked, the host's theme; `graph/graph-get-batched`, `graph-search`, `graph-neighbors` — lib/graph-steps.ts + lib/graph.ts), RunGraph (components/run-graph/: hive's component with lineage, replay and branch tree; a run screen's MASTER VIEW — `highlight` (a lens's ref_ids) dims the rest where it is, `onSelectNode` + a controlled `selected` let a lens's panel answer a click and select a node, `details={false}` leaves the node panel to the app, `calls={false}` starts the call list closed behind a toggle (the lens layout); it OPENS zoomed so a lane is 62% of the canvas's height (`LANES_SHARE`, at most 2×), at the run's start or a highlight's middle; PLAY is `play="steady"` by default — the canvas's clock pans across the lanes at one on-screen speed (`PLAY_PX_PER_S` × the speed), each call shown as the pan, led by `PLAY_LEAD` of the view's width, reaches its place in its lane (`marks`: the lane's calls spread over its width, never left of the call before), `play="timed"` the run's own pace; a scrub or step pans once to the call's LANE; a drag stops the following, Play / back / forward resume it (`refollow`), the locate button toggles it; one button cycles the calls shown (all → reads → writes); `onReplay` hands on the current call's time and `clock` (lib/replay-clock.ts `createReplayClock`) the play's time frame by frame, for an AgentTrace's `cursor` / `clock`; a highlight is FITTED (with room around it, never past the run's edge; a button returns to the whole run); at scale the layout folds what a cell cannot draw into "+N" nodes a click opens around them (40 at a time, laid over the layout so nothing moves) and STACKS a loop of more than three iterations into one box marked "×N" — the current call's iteration while a replay steps, a click lays them side by side — names only what is hovered, selected, the step's own few, highlighted, or folded (from zoom 0.6) — each beside its node inside its cell, over no other name and no node (labels.ts `placeLabels`, pure and tested: eight positions round the node, so one by a cell's right edge leans left; text measured in the page's font; a 16- or 10-character cut where the 30-character one, `clipName`, fits nowhere), drawn above every node, whole in the node's tooltip; highlighted names that fit nowhere are said as one "+N highlighted" (else "+N") per group close together, listing them on hover, beside the group or further down its cell, the group's last-placed names giving their room back when even that fits nowhere — and paints what stands out on top; the replay bar on top and one fixed caption row (a "partial" badge whose popover says what the graph did not answer, with Ask again), the legend one row under the graph, so a scrub never changes its size; its DATA PATH in the page — reader.ts: calls from `run/events`, nodes from graph-get-batched 50 a call, four in flight, up to 5,000, edges and lineage from `graph/graph-edges`, a call per 1,000 nodes (an app that has not granted it: a graph-neighbors per node, bounded), incremental for a live run; a child run through its launching call's `runId`; a peer-tagged ref badged, never read), AgentTrace (components/agent-trace/: `foldAgentTrace` over `run/events` read incrementally, live every 10 s; each FINISHED agent's transcript read once through `useTranscripts` for its reasoning; 34px rows over SVG lanes with fork and merge curves; a node opened through graph-get-batched and the run graph's NodeReader; non-Concept nodes, two or more in a row, folded into one row ("collapse all" folds them, "expand all" opens them); `cursor` (a replay's time) lights the rows at it and `clock` scrolls each agent's heading — a batch's, for agents side by side — to the top `HEAD_LEAD_MS` before it starts; "Download HTML" = the markup and the page's stylesheet as one file, snapshot.ts), SheetView (a spreadsheet work product drawn in the page — a Google Sheet through `sheets/get-values { grid: true }`, a CSV/TSV/JSON table through `run/files`, or `rows` — read again every 3 s while its `workflow` + `runId` is in flight (or `live`, or on `refresh`), the cells and rows each read changed lit; sticky header row and first column, numbers right, formulas in a bar and with fx, a tab strip, `sources` (a cell's A1 or a row's key → ref_ids) as corner marks opening NodeCards, "Open in Google Sheets" through the host; its pure parts in lib/sheet.ts, tested by src/apps/views-sheet.test.ts; `onSpotCheck` puts a Spot check button in the formula bar for the selected cell). SpotCheck (components/SpotCheck.tsx, plans/spot-check.md: where one thing a run made came from, over `run/provenance` — the moments oldest first, first seen and last write marked, the agent's words before each write and the calls just before it, a formula's cells, typed-in numbers, a passage's figures and a write's cited cells each a click into a spot check of its own, a back arrow; its words in lib/provenance.ts, tested by src/apps/views-spotcheck.test.ts; DocumentView's `onSpotCheck` offers it for selected text). WalkView (components/walk/: a graph walk as it plays out — `findWalks` + `walkFrame` over `run/events`, live every 3 s; the trail of chosen nodes, each hop's other candidates behind "+N considered" (five shown, then "+N more"), the newest pulsing; every label one line, cut at `NAME_CHARS` (30, lib/format.ts `clipName`), the whole name in its tooltip and the drawer; live and replay one view on the kit's replay clock (`useReplay`, lib/replay.ts): joined in flight it shows the hops so far and follows, faster when behind, never skipping a beat; a finished walk replays from its log alone at the pace it ran (`replay` opens it playing from the start); ReplayBar's controls ABOVE the walk, which is laid out whole with the hops shown drawn in place (each row over an invisible copy of its whole-walk form; the tree's breadcrumb one line, first › … › current), so scrubbing never changes the view's height; a click opens the node in a drawer by it — beside the walk, which reflows to its left, when the walk is wide enough, else across it over a veil, so nothing is half under it (its text through the node reader's `NodeReaderBody`; ✕, Esc or a press outside closes it) — or hands it to `onOpenNode` and opens none; `mode="tree"` a d3 tidy tree of everything discovered, laid out once from the whole walk — a node's children past five (the path's and the kept ones always shown) folded into one "+N more" node a click opens; only the path, the selected or hovered node and the "+N" nodes labelled, the rest dots — its columns as wide as their measured labels, fitted to the width (never past 1:1), dragged to pan, pinched / ⌘-wheeled or buttoned to zoom; sized by its container, never the viewport; `path` picks one of several walks, the latest by default; a finished agent's transcript read once for what its previews cut). ReplayBar (components/ReplayBar.tsx): the replay controls RunGraph and WalkView share — a step back, play/pause, a step on, a slider, the speed (`REPLAY_SPEEDS`), Live on a run in flight once a person stepped away; presentational, the view owns the cursor. No ClaimsBadge: the workflow ledger is only `meta/list-claims`, sealed. views-seed.ts: `seedViewsApp` — known tree hash → made active again if it is not (a seed always matches git), nothing more; else built ONCE per machine per (sources, kit) into `<tmp>/strut-views/`, copied into the version directory (strut's own sources: trusted as built), skipped without a built kit; `createStrut({ views: false })` seeds none. Excluded from the root tsc; `kit/tsconfig.views.json` checks it
│   ├── packages/          # PACKAGES (plans/marketplace.md): the bytes, the build, and the install from `file:` and `pk:` (steps 1–2 and the HTTP-first half of 6, apps included; `git+` and a person's update are later items). format.ts: a package is a directory, `strut.yaml` (zod, strict: `package: publisher/name` lowercase, `version`, `description?`, `requires { secrets, binaries, runtimes, packages: [{ package, digest, source }] }`) and `workflows/<path>.yaml`, `steps/<path>.ts` (`_` files helpers, `<name>.claims.yaml` beside a step), `concepts/<file>.md` (a Concept page, named by the `name` in its front matter whatever its file — the new form, which a build writes as `concepts/<key>.md` with every attribute and every parent — or, in the old form, by its file), `apps/<name>/` (with app.yaml), `graph/<Type>.yaml` (a graph type, item kind `type`, named by its type; graph-types.ts); `readPackage(dir)` → `{ manifest, digest, files, items }`, each item named `<package>/<path>` (a Concept by its page name), refusing with `bad_package:` an unknown top-level folder, a file a folder does not hold, a name the step/app rules refuse, two Concept pages with one name, a symlink, a package with no items. The DIGEST is `sha256:` + `hashTree` (src/version.ts, `treeHash`'s function) over every file but dotfiles, `node_modules/` and each app's `dist/` + `data.db` (`packageExcluded`), `strut.yaml` included — so an app inside hashes as its version hash does. cache.ts: `<dataDir>/packages/sha256-<hex>/`, one directory per digest, written once through a scratch directory that is re-read and hashed before the rename (`PackageCache`: `get` re-hashes, `putDir`, `putArchive`); `resolvePackage(ref, { cache, digest?, base?, url?, fetch? })` — `file:` copies a directory in, `pk:` goes through pk.ts, `git+` refuses as not built. pk.ts: the `pk:<key>/<publisher>/<name>[@digest]` SOURCE (§5, §13, HTTP-first 2026-10-28) — the publisher's catalog fetched from `url` (where it is served today: a strut's `/packages/catalog?public=1`, or an uploaded file; later an index row's or the key's Pkarr record, neither changing a check) and read as a card against the KEY, its `seq` against the last accepted from that key on this strut (`<dataDir>/packages/index/<key>.json`), the release (the pin, which the catalog must list — `package_not_published` — else the newest not yanked), its archive by digest from the route beside the catalog (`releaseUrls`: the catalog's own query rides along) then the release's `urls`, and every required package the catalog lists, so the install finds them cached; the install pins `upstream.key` and `upstream.source.url`. archive.ts: the archive is a .tar.gz of the files (src/tar.ts), transport only — `unpackArchive` refuses a path that leaves the directory or one the digest never covers, caps size and count; `fetchArchive({ urls, digest, cache, package?, headers? })` returns the cached digest or fetches from the first URL whose archive unpacks to it, passing over the rest and naming each (never a query) — the last hop of the later `pk:` resolver. `GET /packages/:publisher/:name/archive?digest=` (createStrut) serves any package the cache holds, behind the gate. install.ts: `installPackage(deps, ref, { digest?, actor? })` — the package and, FIRST, every `requires.packages` pin not installed here at that digest (the cache, else the pin's source, a relative `file:` from the requiring package's directory); ALL OR NOTHING: every name and file of the set checked before the first write (a local item under the prefix, a sealed namespace, a Concept under someone else's stamp or with a parent nowhere, an attribute the graph's `Concept` does not declare a warning, a workflow naming a step / grant / subflow neither here nor in the set or whose `name:` is not its path, a claims file that does not parse), each app copied out of the cache and BUILT against this strut's kit with the set's workflows and apps in reach; then steps (`source: "install"`, `upstream`, the actor), one registry rebuild and a load check (a step that does not load, or whose `defineStep` type is not its path, takes back everything written), workflows (owned by the actor), apps through `ctx.services.apps`' publish (a person's, each after the set's apps it imports — so what an app publish does, an install does), Concepts through `seedConcepts` stamped `pkg/<package>/` with `keepEdited`, then the claims with the package as speaker and the publish checks (a claim that will not record is a warning, never a take-back). The same digest again installs what is missing; another digest through a person's door is `package_update_not_built:` (it asks first, not built). The DISTRO's door (`strut.packages.install(ref, { door: "distro" })`, in process only, plans/marketplace.md §12) applies a release with no ask and UPDATES item by item (§4's table): an item whose active version the package wrote (`source: install | distro` + `upstream`) is fast-forwarded, a fork gets the release's version beside it (`activate: false`, `diverged`), an item the release drops is retired when untouched and kept when forked, an edited Concept is left out of the seeder's set; a required package at a new digest is updated first; versions record `source: "distro"` and the package is then the distro's (`package_distro_owned:` at a person's door). Every step an install makes active is TRIAL-LOADED from `<cache>/.install/<rand>/trial/` before the first write (`stepFileType`, registry.ts), since no store deletes one version; a later failure re-points an updated item at its previous version. The fold's `installed` is the active version when the package wrote it, else the newest the package wrote, and the package's digest is its newest installed version's. Missing secrets, binaries and runtimes are reported, never refused. graph-types.ts: a package's GRAPH TYPES — `graph/<Type>.yaml` in `graph/create-schema`'s grammar plus `edges: [[EDGE, Target]]`; `exportTypes` (the build's `types: [...]`: each named type read off the ontology, its parents up to Thing / strut's / the seed's / a required package's, and the edges among them from the ontology's rules AND the edges the graph holds — a Jarvis allowlisted edge travels as a rule; an edge to a type left out is a warning; its key the attributes after the key spec's type prefix, whoever declared it — jarvis's `Content` and `Legal` inherit Thing's `thing-name` and export keyed by `name`), `checkPackageTypes` (in the install's check pass: grammar, parents and edge ends in the set or the graph, `checkAgainstGraph` — apps/graph-types.ts, shared with `data.graph`), `registerPackageTypes` (before any other write, parents first, add-only through `registerTypes`; never taken back or uninstalled). Edge rules carry no temporal / cardinality / aliases yet. build.ts: `buildPackage` (`POST /packages/build`) — the named workflows' closures, each named app's grants and the apps it imports (off its `dist/build.json`), helpers, Concepts (each a new-form page under its node key, `concepts/<key>.md`: every attribute the schema declares, every live parent; a parent outside the package a warning unless strut's or a required package's), step claims and `requires`, into the cache; an app as its version's sources, checked against its version hash; what the closure reaches that strut does not seed on every server — a host's seed, a service's item — is `leftToInstaller` on the answer and a warning (strut's own seeds, read off `src/workflows/`, stay silent); a carried workflow's category as a top-level `category:` line in its YAML, which the install sets (not in the strict `strut.yaml`, so an older strut still reads the package); `conceptsAlone` carries a page without the pages under it; in every carried page's docs and description each carried workflow name and custom step type is written as packaged (whole tokens; a one-word name only as a whole code span), and one the package does not carry is a warning. `uninstallPackage`: every item still as installed goes (never runs), untouched Concepts retired, forks, edited pages and helpers a forked step may import kept and listed — and a page with a page under it that stays (this strut's own under the package's root, an edited one), with every page above it (`heldPages`, install.ts; a release that drops pages keeps them the same way). installed.ts: the FOLD — `listInstalledPackages` from the workflow, step and app version records (`source: "install"` + `upstream`, under the package's prefix) and the `pkg/` Concept stamps, `modified` = a fork (or a page's text against its file in the cache); no store. fence.ts: `fenceStep` — a step whose active (or pinned) version carries an `upstream` reads only its package's `secrets` (`secret_fenced:` otherwise), wrapped by `buildRegistry({ fences })` from `workspaceFences` (`StepListEntry.upstream`) and by `resolveStep` for a pin, so every way a step runs is fenced. `GET /packages`, `POST /packages/install { ref, digest?, url?, index? }` (a bare `publisher/name` ref resolves through the indexes this strut follows, below), `DELETE /packages/:publisher/:name` (createStrut, one write at a time). indexes.ts: the indexes this strut FOLLOWS (§7, step 7's client half) — `{ id, key, urls, label? }` in `<dataDir>/packages/indexes.json` (public data, plain JSON), put on file at boot from `STRUT_PACKAGE_INDEXES` (else `DEFAULT_PACKAGE_INDEXES`) and `createStrut({ packageIndexes })`; `resolveName` reads each card through `fetchCatalog(…, { kind: "index" })` (the per-key `seq` rule), first card listing the prefix wins, and the install goes on as `pk:<row key>/<name>` with the row's `urls` tried in order — so the key the SIGNED card named is what is pinned; `search` reads each index strut's derived `/index/packages` and every peer's `GET /packages` (never installed as it came: a hit installs by its name); `get(name, { index? })` one package's page from the first followed index whose card lists its publisher (a miss over memoized cards re-reads them once), `concepts(q)` / `concept(name)` the Concept tree across the followed indexes (one entry per name, the first index's) and one page — the derived pages, read through the index's open routes. Routes `GET`/`PUT`/`DELETE /packages/indexes[/:id]`, `GET /packages/search`; `ctx.services.packages` (`PackagesCapability`: the four reads, and `install`, package/install's door behind an ACCEPTED proposal — never a read that installs) for the `package/*` steps (steps/lib/package/: search, get, concepts; install asks), which the builder chat gets as `package_search` / `package_get` / `package_concepts` and the `builder`, `job` and `orchestrator` seeds grant, and for the assistant door's `search_packages` / `get_package` (ai/assistant-tools.ts). `briefPackagePage` is the page as a MODEL reads it (README cut at `README_BRIEF_CHARS`, Concept docs left out) and `INSTALL_IS_A_PERSONS_ACT` the sentence every agent-facing door ends with. card.ts: the catalog CARD (§13) — RFC 8785 JSON (`canonicalJson`; integers within ±(2^53 − 1) only, a float is `catalog_invalid`), the z-base-32 key, `sealCard` (Ed25519 over `strut-catalog\n` + the fingerprint, the sha256 of the card without `sig`) and `readCard`, a reader's checks in order: one byte form, the EXPECTED key, `v: 1`, the seal, `seq` against the last accepted (`catalog_rollback` / `catalog_conflict`); `releaseFor` (a channel's release, else the newest not yanked); `card.test.ts` holds the test vector. publisher.ts: this strut as a PUBLISHER (§13, §12.1) — TWO Ed25519 seeds in an encrypted file of its own, `publisher.json` beside `peers.json` (minting refused on a file store with `STRUT_SECRET_KEY` unset): the FLEET key, minted first, seals the fleet catalog under `<dataDir>/packages/catalogs/` (`sha256-<hex>.json` + `current`) — the whole picture, every release and channel, what a subscription follows; the PUBLIC key, minted at the first **Make public** (`makePublic(channel)`, the record's `publicChannels`), seals the public catalog under `catalogs/public/` — `projectPublic`: the public channels and every release one holds or has held, carried forward (what was published stays published) — since a card's `seq` rule is per key. The fleet card names the public key (`public`); the public card never names the fleet key. `publishRelease` (a release newest first, the channel moved, `public: true` marking it first) and `moveChannel` (`public: false` on a public channel refused, `catalog_channel_public`; a release going public that requires a package no public channel holds refused, `catalog_private_requirement`, before anything is written). `host: self`: a release lists no `urls`, its archive is the route beside the catalog. No Pkarr record yet. `GET`/`POST /publisher`, `POST /packages/publish` (build + release), `GET /packages/catalog[?digest=]` (`?public=1`: the public one, no credential — `publicPackageRead`, auth.ts, and the archive route serves a public digest the same way; a host's gate hands such a read through like `?t=`), `PUT /packages/channels/:channel`, `POST /publisher/tokens` (a subscriber's read token, auth.ts). index.ts: the package INDEX role (§7, step 7; `createStrut({ index })`, `STRUT_INDEX=1`) — the index key (`INDEX` in `publisher.json`, minted at the first row), the rows (`setRow` / `removeRow`: prefix → `{ key, urls, description?, url? }`, `indexRowProblem`) sealed as an INDEX card (`card.ts`: `kind: "index"`, domain `strut-index\n`, `publishers` where a catalog has `packages`, `urls` where this index is served) under `<dataDir>/packages/catalogs/index/`, the CRAWL (each row's public catalog through pk.ts's `fetchCatalog` from the row's `urls` in order, the accepted card and state under `catalogs/index/crawl/`; at the row, on the publisher's ping — `POST /packages/subscriptions/sync { key }` with the PUBLIC key, which a publish or channel move sends to every peer when the public catalog changed, `pingPublic` — and on the subscriptions' poll), `search` (`src/search.ts` over package name + description + publisher; each package at its newest release not yanked, with the row's key and urls — what a `pk:` install needs — and `detail`, the release's archive as read) and `package` (releases, public channels, `readAt`, `detail` / `detailError`); the DERIVED PAGES (the store front, 2026-10-29): after a catalog is accepted, each package's newest release not yanked is fetched by digest (`fetchArchive` over `releaseUrls`, into the index's cache — the mirror §7 allows) and read by detail.ts into `crawl/pages/<prefix>/<name>.json`, kept by digest (read once; a fetch that fails is recorded and tried again next crawl, never the catalog's failure), `derived` on the crawl state; `concepts(q)` / `concept(name)` fold every page's Concept pages into one tree (the first package by name gives description, parents and docs; every package is listed; children — a page under each of its parents — and the ancestors along each one's first parent resolved across packages; a page derived before the new form kept one `parent`, read as its parents). Routes: `GET /index` (any credential), `PUT`/`DELETE /index/:prefix`, `PUT`/`DELETE /index/live/:prefix` (a LIVE row, plans/public-surface.md §8: where a publisher server's public view is served — its own `live` map on the card, beside `publishers`, so an older reader reads the card as before — read at the row and every crawl into `crawl/live/<prefix>.json`; its trees folded into `/index/concepts`), `POST /index/crawl` (full scope); `GET /index/catalog`, `GET /index/packages[?q=]`, `GET /index/packages/:publisher/:name`, `GET /index/concepts[?q=]`, `GET /index/concepts/:name`, `GET /index/live[?q=]` OPEN to anyone (the gate's `INDEX_READ`, only with the role on), and so are `GET /llms.txt` (index-tools.ts `llmsTxt`) and ONE POST, `/index/mcp` (`INDEX_MCP`); with the UI served, `GET /` with no credential is a 302 to `./?store=1`, the store front (web/src/components/Store.tsx). Derived and unsigned past the card: an install re-verifies against the publisher. index-tools.ts: the store for an AGENT (2026-10-29) — `buildIndexTools(index, { store? })`, three READ tools over the index's own functions, served to anyone on `POST /index/mcp` through `toolsetServer` / `createMcpDoor` (ai/mcp.ts; part of the role, whatever `enableMcp` says of the keyed doors): `search_packages { query?, limit? }` (the hits with `detail`), `get_package { package }` (the page as a model reads it, `briefPackagePage`), `get_concept { name?, query? }` (the tree, or one page) — each with its `store` link when the index serves the UI and `install`, the sentence that a PERSON installs and where; `indexInstructions` says what the index is, that everything is derived and an install re-verifies against the publisher, and how a person installs — so any MCP-capable agent adds the store with one line (`claude mcp add --transport http strut-store https://<index>/index/mcp`); and `llmsTxt` — `GET /llms.txt` at the index's root (llmstxt.org), the same store as ONE markdown page for an agent that fetches URLs: the blockquote (what the index is, derived, a person installs), the `claude mcp add` line, `## Reads` (the open routes), `## Packages` (every listed package with what its archive holds), `## Concepts` (every page), `## Optional` (the store page) — each entry a link to its JSON page here; the Store page's footer links it. detail.ts: `derivePackageDetail(cached, { stepInfo })` — what a release HOLDS, read off its directory with nothing loaded or run (the store's package page): the apps' manifests (title, icon, grants, `can` from the workflows they grant), each workflow's YAML (`description:`, the `input:` block, the closure's types with a package subflow folded in package-first, `agentTools` — `{{ params.X }}` read off the params' defaults — the `claims:` count, `peer` / `sealed`, the secrets `secretNamesIn` finds plus a lib step's one declared secret and the package steps'), each step's source by regex (`description`, `effect`, declared `secrets`, every `secrets.get("NAME")`) with `lintStepSource`'s findings, the Concept pages (`parseConceptFile`), the root README (capped); `can: { spends (agent / llm / acp), acts (a step declaring effect: write — this strut's registry through `stepInfo`, or the package step's source), code (exec or a package step) }`; `summarizeDetail` is the hit's short form. A READING, never a check — the install re-reads everything. subscriptions.ts: this strut FOLLOWING another's catalog (§12.1) — `{ key, url, channel?, token? }` in an encrypted file of its own, `subscriptions.json` (the operator's full-scope `PUT /packages/subscriptions/:id`), its state beside the cache (`<dataDir>/packages/subscriptions/`: the catalog accepted, the release applied); a SYNC (at the `PUT`, at boot, every `STRUT_DISTRO_POLL_MINUTES`, on the publisher's ping `POST /packages/subscriptions/sync`, which a PEER may send) checks the catalog against the key and the last `seq`, fetches every archive the channel holds by digest, installs the set as ONE install through the distro's door (`installPackages`), source ref `subscription:<id>`, and uninstalls what the channel dropped; `GET /packages/subscriptions` is the fleet's view (applied release, `diverged` items). A publisher pings every peer on file after a publish or a channel move
│   ├── steps/
│   │   ├── core/          # 11 built-in steps: http, exec, log, if, loop, foreach, subflow, llm, agent, wait, pack (static import)
│   │   ├── lib/           # built-in domain integrations (github/fetch-pr, github/create-pr — open a PR or return the open one for that head, github/pr-status — a PR's state and checks now, github/merge-pr — a person's merge only: strut's own page or an accepted proposal, at the head they saw, ...) — file dynamic-imported at build; heavy SDKs lazy-imported in run() (see "Lib step dependency convention")
│   │   │   ├── dictation/ # dictation/models, dictation/use { speech?, fixer? (null: none) }, dictation/remove-model { id } (refused for an active model or the default speech model): the dictation model picker over `ctx.services.stt.dictation` (src/audio/dictation-models.ts), each answering `{ models: [{ id, kind, name, summary, recommended, bytes, description, state, progress?, downloaded?, selected, active, removable, error? }] }`; dictation/enable { ref_id, on } turns dictation off/on for one entity (the `dictation` attribute memory/lexicon reads)
│   │   │   ├── llm/       # llm/models: the model catalog `GET /llm/models` serves (every model aieo knows, each `available` when the host's `STRUT_MODELS` lists it or, with no list, when its provider has a key here; the deployment's default) over `ctx.services.llmModels`, the one list both read — what strut's own assistant app's model picker reads (plans/jamie-app.md §5). Not the `llm` core step: it calls no model
│   │   │   ├── privacy/   # privacy/anonymize, deanonymize, destroy over src/privacy: typed outputs, `warnings` instead of silent drops, ner fail-closed, vault "file" needs the secret. Run files record step inputs and outputs, so original text is in them in plaintext (the handle-only convention in the spec is the mitigation)
│   │   │   ├── package/   # the package STORE's reads (plans/marketplace.md §7, §8), thin over `ctx.services.packages` (src/packages/indexes.ts) — every one `effect: "read"`, and every description says installing is the PERSON's decision — proposed with package/install where it is held, else their Publish dialog's Packages tab or the store's Install link (`INSTALL_IS_A_PERSONS_ACT`). package/search { query, limit? } (the followed indexes' hits — each with its `detail`, the release's archive as the index read it: apps, counts, secrets, `can` — and the peers' installs); package/get { package, index?, full? } (one package's page from the index whose card lists its publisher, as a MODEL reads it — `briefPackagePage`: the README cut at 12k, the Concept pages' docs left out — or whole with `full`; throws `package_not_listed` / `package_not_found` / `package_index_none`); package/concepts { query?, name?, index? } (the Concept tree across the followed indexes, or one page with its docs, children and parents). Granted BY NAME — never `package/*` — to the builder chat (`BUILDER_REGISTRY_TOOLS`: `package_search`, `package_get`, `package_concepts`) and to the `builder`, `job` and `orchestrator` seeds, so "is there a package for that?" is answered inside a turn; the assistant MCP door's `search_packages` / `get_package` and the index's own `POST /index/mcp` (src/packages/index-tools.ts) are the same reads for an agent outside. package/install { package, index?, digest?, url? }: an AGENT asks, a PERSON accepts (plans/marketplace.md §8, ruled 2026-10-29) — runs ONLY as a proposal a person accepted (`ctx.proposal`, as app/grant), its `describe` reads the package off the index for the card (publisher + key, which index lists it, digest, license, what it brings, what it can spend / act / run, the secrets it needs — or that no followed index lists it), and the door behind it (`services.packages.install`, createStrut) checks the ACCEPTED record on disk for that very ref before calling the in-process install, so no step, authored or installed, pulls code without a yes. Granted and listed in `approve:` by the orchestrator, builder and job seeds; the builder CHAT has no proposals, so no install there (the person has the Publish dialog's Packages tab)
│   │   │   ├── strut/     # strut/list-peers: `self` (this workspace, when set) and the peers on file as an agent chooses one — { self?, peers: [{ id, label?, description?, repos? }] } (what the host said each workspace holds), never a token or URL. strut/run-workflow: dispatch-through (plans/federation.md §2.2) — run a workflow on a PEER and return { peer, workflow, runId, status, output?, error?, durationMs }; waits on the peer's tail, cancel of this run cancels the peer's, `wait: false` returns the handle, `job` is explicit (never this run's own: no shared directory across struts); grantable to an agent as `agentTools: ["strut/*"]`. Three things ride on the tail it reads anyway: the peer run's `step.end.nodes` are folded onto THIS step's `step.end`, each tagged `peer: <id>` (a ref is only meaningful against the graph that recorded it — the projector skips a tagged ref, the flyout badges it, nothing here opens it); each entry of the peer output's `artifacts` comes back tagged `peer` + `job` — the job the peer's `run.start` recorded (`peer/<job>` on its peer key), so a `path` stays the peer's and artifact-refs.ts leaves it alone (an entry already tagged — the peer got it from a third strut — is re-tagged as the NEXT HOP, `{ peer: <this peer>, via: <the third>, job: <the third's> }`, opened through the peer's read-through, plans/chained-orchestrators.md §5; in the plain output, so the builder's pack carries it); and the handle is journaled at launch as a synthetic `step.end` at `<path>#launch` (no stepType) so a resumed caller REATTACHES to the same peer run instead of launching a second one — the child did not die with the caller. A peer run that died there and was not resumed is `peer_run_stale:` (its tail ends with `done { status: "stale" }`, retried with backoff first)
│   │   │   ├── channel/   # channel/send { channel, data, key? }, channel/read { channel, since?, wait?, limit? }, channel/derive { scope } (plans/app-channels.md §5, §6): an app's CHANNELS for code the app runs — a step its page called, a workflow it launched (`ctx.app`; refused without it, and refused from a page, `NOT_A_PAGES` in src/apps/tools.ts: a page uses `useChannel`). A message is stamped with the code as sender (`senderCode`: the workflow's name, or in a step run the type the page called, read back from the registry), so a referee's `key: board` state is its own whichever player set it off and no page replaces it; `channel/read` waits like `job/updates` (an AI player); `channel/derive` is `HMAC(per-app key, scope)` (auth.ts `derivedChannelName`), a room name a gatekeeper step hands to the players its own rules let in
│   │   │   ├── app/       # app/list, app/get { name, version? } | { path, job? } (an app directory you are working on, with `stale`), app/init { path, template? }, app/checkout { name, version?, path }, app/build { path }, app/publish { name, path, job? } — the authoring loop (plans/apps.md §8: a directory, the editor, build, read the errors, publish), thin over `ctx.services.apps` (src/apps/apps.ts). app/pin { name, pinned? }: the app as a TAB — the record's `pinned` flag (`setAppPinned`, never a version's; `PUT /apps/:name/pin` is a person's door), on `GET /apps`, for a host that lists this workspace's apps (hive's sidebar for the workspace this strut is the swarm of); only when the person asks, and never from a page. A path is relative to the JOB's directory (or the run's artifact dir; the chat builder, under no run, the server's data directory — its scratch) and may not leave it; `job` names another job's. app/publish stamps `publisher: "ai"` under the meta surface's rules (§9): no `llm` / `agent` / `exec` and nothing sealed in the grants — a person's `POST /apps` may, and so may the builder once a person granted the app that sealed workflow (app/grant { name, workflow }: runs ONLY as a proposal a person accepted, `ctx.proposal`, recording the grant on the app's name — src/apps/grants.ts; see "The assistant in an app"). Grantable as `agentTools: ["app/*"]` — the builder's grant (`buildTools` through `buildRegistryTools`; the `builder` seed's `params.tools`). app/look { name, version? | path?, job?, input?, steps?, wait?, fullPage?, viewport? }: an app as a person sees it — with `path` the directory being worked on, built and hosted as a PREVIEW (`apps.preview`: the publish's checks, no version recorded, `preview-<12 hex>` where a `vN` goes in the file route, the identity, `step_run`'s manifest lookup and the solo host's key; in memory an hour; uncounted by the monitor), so a fix-and-look loop publishes once (before it, every look was a publish: a held app collected a draft per round, 2026-10-28); else a published version — strut's own UI hosting it alone (`?app=<name>@<vN>&solo=1`) in a browser session of its own, every request the page makes answered by strut IN PROCESS as the run's person (BrowserService `lookAtApp`: the UI loaded from `STRUT_ORIGIN`, `https://strut.invalid`, through `page.route`; createStrut hands the service `app.fetch` on a request marked with `inProcessRequest`, auth.ts — the key's rights and its own actor, ahead of any host hook), so the browser needs no address for strut and holds no key, and an app's CHANNEL socket (`wss://strut.invalid/channels`, which `page.route` never sees) is answered in process too — `page.routeWebSocket` → `answerChannelSocket`, admitted through the same `/channels` route as an upgrade (`channelSocketInProcess`), so a multiplayer app looks connected (plans/app-channels.md item 7), and the app's calls go through the real host and `step_run`. `input` is what a deep link carries (`&input=…`, as the kit's `appLink` writes it): the app opens where that link takes a person. `steps` then runs a declared list in the app's FRAME — `LOOK_VERBS` (click, fill, type, press, select, hover, scroll, wait; not goto / back, which leave the app, nor evaluate / text), each target a selector, through the same `drive` as `browser/capture`, the session's `scope` the app's frame so `locate` and `wait { text }` look inside it; a `wait` with no `timeoutMs` gives up after `VERIFY_WAIT_MS`. A step that fails is a result, `stopped` (as in `verify`), shot where the page got to. Returns the shot (shown to a model, `withMedia`), `rendered`, `hostError`, `stopped`, the page's text (8k), its console / page / request errors (the host's refusals by design left out: the MCP client's 405, the boot's `GET /auth/session` 404) and the `appErrors` its boundary reported during the look; fails before a page opens on an app or version that is not there, or a list a look cannot run (`checkLookSteps`). Needs the UI served (`serveUi`) and the MCP door on. The builders hold it through `app/*`, and the `App` page says to look at the directory and publish once it shows what was asked. An app's directory is never the job's (or run's) directory itself (`resolveAppPath` refuses it; `app/get` may read it): the version is the folder's tree, and a job's `shots/`, checkouts and notes would make every publish new. app/state { set? }: the PAGE's storage (src/apps/state.ts) — a framed page has an opaque origin, so no `localStorage`, IndexedDB or cookies, and the origin it would get otherwise is its host's, credential and all — one JSON object per (app, viewer) at `<dataDir>/apps/<name>/.state/<sha256 of the actor>.json` (a strut with no actor keeps one for everyone), `{}` reads it, `set` merges keys (`null` removes one), `{ state }` back; 256 KB a viewer; refused without `ctx.app`; every version and preview shares it; always granted, never kept as a run; dropped when the app is deleted; the kit's `useAppState` is over it. app/report-error { message, stack?, componentStack? }: the PAGE's door for its failures (the kit's error boundary calls it through `step_run`, always granted), KEPT under `step:app/report-error` with the app and the actor on its summary and the report on its output — `app/get` reads the app's last 50 back (`appErrors`), no error file of its own
│   │   │   ├── acp/       # acp/prompt: one turn of a LOCAL coding agent over the Agent Client Protocol (JSON-RPC 2.0, one line per message, on the child's stdio; _client.ts, no SDK) — `agent` is a preset (claude and codex through their pinned @agentclientprotocol adapters via npx, goose acp, gemini --experimental-acp, opencode acp) or any ACP command line; the agent brings its own login, model and tools, and the client advertises no fs or terminal. `session` is strut's name for the thread, mapped to the agent's own session id in <dataDir>/acp/sessions/<id>.json and resumed with session/load (its replayed history is ignored); another agent on the same name starts fresh. `mode` plan | edit | auto: set as the agent's own session mode when it offers a matching id, AND enforced on every session/request_permission by tool kind (plan: read/search/think/fetch; edit: + edit/delete/move; auto: all) — refusals come back as `denied` plus an `ask`, so a host can rerun the turn with more room; a refused switch_mode (an agent leaving plan mode) keeps its `plan`, and the ask leads with it. Each tool call is a step.start/step.end (step.error when it failed) at <path>/NNN-<kind> with stepType tool:<kind> and the ACP toolCallId (step.end's output is { title, input, output } — the final title and input, which adapters fill in after the call starts); each stretch of prose a `message` pair. Output { text, session?, stopReason, artifacts (files its edit calls changed, relative to cwd), denied, ask?, toolCalls, cost? (this turn's, from the cumulative usage_update total kept with the session) }. Cancel sends session/cancel. The `job` workflow runs it in place of `agent` when the launch names `input.agent`
│   │   │   ├── context/   # context/concept: a Concept as an agent's context — the page's docs (capped at 6k) and the name + description of each Concept under it (PARENT_OF), read through graph/graph-get and rendered as a system-prompt section, framed as the workspace's notes, with how to open a child page (`tool`: the agent's name for graph-get; `""` for an agent with none). `docs: false` renders the kinds under the page ALONE — for an agent that routes BY them rather than follows a page's convention; nothing under the page is `""`. The builder's default `chatSystem` is this step on `Workflow Builder`; the `job` workflow puts `{{ concepts.text }}` after `params.system` on `Job`, the `orchestrator` the kinds alone under `Job` and under `Workflow Builder` (`docs: false`, `tool: ""`). `{ text: "" }` without a wired graph or the page — never a failed run, never a Neo4j-from-env fallback. Not under `graph/`, so a `graph/*` grant does not hand it to an agent
│   │   │   ├── job/       # job/dir: the run's JOB directory (jobs.ts) for an agent's cwd — `<dataDir>/jobs/<job>/`, the same path every run launched with that `job`; a run with no job gets its own artifact dir, so a job workflow is also a one-shot; `hold: false` hands it out without holding it, for a run that only reads (several of a job's readers at once — a convention, not a sandbox). job/upload / job/delete-upload: one file into / out of the job's `uploads/` (`saveJobUpload`, jobs.ts: never overwritten, a taken name numbered, the job made when there is none, no hold) — an app page's upload (plans/apps.md §12), never kept as a run from the app door since its input is the bytes. job/updates: the job's LIVE UPDATES after a cursor, held up to `wait` (`ctx.services.jobs.updates`, plans/live-feeds.md §1) — an app page's way to follow its jobs, granted like any read; job/status { title, detail? }: one line of what the run is doing now, `job.update { kind: "status", id: <runId> }` to the run's job (nothing without one). job/list, job/get, job/read: the job INDEX (job-index.ts) as steps — find an earlier job by words, read what it produced and the thread to continue, open one of its files (an image is SHOWN to the model via withMedia) — thin over `ctx.services.jobs`, the same reads `GET /jobs[/:id]` serves. job/start, job/continue: hand work to a job-shaped workflow DETACHED — `job`, or `builder` with `workflow: builder` (the authoring hands — workflows, and the apps that live in a workspace; `peer` for a build on another strut, plans/builder-job.md §2; the closed set is `JOB_WORKFLOWS`, jobs.ts, and the rule is on the field's own description, beside the `Workflow Builder` kinds the orchestrator reads) — and return `{ job, runId, callback, workflow }` at once — `workflow` the one the job's run is, the record's for a continue (an orchestrator's start_job / continue_job, as Jamie does in Hive); the job's run records the TURN that started it — `startedBy: { workflow, runId, session? }`, the launching root run and the conversation its launch named, on its `run.start`, the job record's run line and its `run.end` (CALLBACKS.md §2) — so a host hearing every job of a person on one room socket finds the conversation — unlike meta/run-workflow, which waits, so the calling turn ends and its session is free; through `ctx.services.jobs.launch` (createStrut, over launchDetached): the job's `run.end` goes to the LAUNCHING run's own callback (the run store's, never a URL the model wrote), `job_busy:` while a run of the job is in flight, start mints the id and takes a `title` and the request's `kind` (a page under `Job`, which job.yaml opens every turn with; continue carries the last turn's unless it names another) (`peer` with `workflow: job`, `kind` with `workflow: builder`, or `repos` with `builder`, refused), continue refuses a job not on file and names only the job — the launcher follows the record (`turnOf`: the workflow the newest turn ran, that turn's `input.peer` carried along), so a builder job on a peer stays one; and both fill `input.workspace` from this strut's `self` record when the launch has none, so the agent's first line names its workspace as a host's own launch does. job/verify { job, claims?, detach? } and job/evidence { job, claim, runId, supports, content, slot? }: a PERSON's acts on a job's claims — what `POST /jobs/:id/verify` and `POST /claims/:id/evidence { job }` do, over `ctx.services.jobs.verify` / `.evidence` (set by createStrut where the claims layer is on) — for strut's own app's claims card: only as a first-party page's own call (never an agent's tool; an agent has meta/verify-job), on a job the viewer launched a run of (the record's `actors`)
│   │   │   ├── automation/ # automation/list, preview, create, update, delete, run-now: an agent's own door onto the automations (scheduler.ts), through `ctx.services.automations` — scoped to the ONE workflow the host names (`createStrut({ automation: { workflow, approve } })`, STRUT_HOST_CONFIG's `automation`), never another workflow's schedules; the run is handed `{ name, prompt, since: "{{ last.finishedAt }}", now: "{{ now }}" }` (the person's `{{`/`}}` kept apart by a zero-width space). The acting four first run the host's APPROVAL step (`{ intent: { action, content?, details? } }` → `{ approved }`, or a withStop output that the step passes up, ending the turn with nothing changed), refuse without one, and journal what they did so a resume never acts twice. A host whose approval step grants more than the prompt (`automation.grants`: Peel's posting as the person) gets a `grant` on create and update: strut never reads it, hands it to the approval step with the automation's ID and name (the id minted BEFORE the card, `automationId`, the same for the same call, given to `create`), and the host keeps what it allowed under that id; a change, run-now or delete card names the automation the same way (the host lets a deleted one's grant go). At each fire the runner hands every step `ctx.automation` (set by the scheduler's launch alone — a `POST …/run` or `meta/run-workflow` body cannot), which is where a host step acting on the grant names the automation; nothing rides in the input. An automation made from a turn inherits the root run's callback, as job/start does
│   │   │   ├── meta/set-automation.ts # the builder job's schedule for a workflow it published: only on one stamped `publisher: ai`, and only as a proposal a person accepted (`ctx.proposal`, set by the apply alone) — a tool call, DAG step, meta/run-step or subflow is refused, so the host lists it in the builder's `approve:`; a proposal of it waits (`StepDef.after`, 409 on an early accept) for a pending `meta/publish-workflow` of the same workflow. Create, change, pause, remove by id; its fires report where the proposing run does, else nowhere until the host points them
│   │   │   ├── conversation/ # conversation/list { q?, archived?, limit?, before? }, conversation/get { session, limit?, before?, wait?, since? }, conversation/update { session, title?, archived?, seen?, shared? }, conversation/fork { session, id? }: the conversation index (src/conversations.ts) as steps, the viewer the step's actor — thin over `ctx.services.conversations`; conversation/list also answers `viewer`, the actor the list is for (where a page mints `<viewer>/<id>`). Refused under `ctx.app`, except a first-party page's (strut's own app, plans/jamie-app.md §3), which reads them as its viewer's person token
│   │   │   ├── secret/    # secret/add { name, value } (plans/member-rights.md "Adding a secret"): a secret a PERSON types into strut's own app — the builder's reply names it in `ask.secret`, Jamie's SecretBox stores it — FILLING A BLANK through `ctx.services.secretBlanks` (src/secret-store.ts `secretBlanks`, set by createStrut when strut owns the store): refused (`secret_set:`) when the name has a value in the store or the environment, so a member never replaces the team's model or GitHub key; never lists, reads, changes or deletes one. Answers `{ name }` alone. Runs only as a first-party page's own call (a one-step run, for its viewer), never an agent's tool or a model-written page's; its `value` is `redact`ed from the run's events (`StepDef.redact`, runner.ts), so no log, sink or kept run holds it
│   │   │   ├── proposal/  # proposal/list, proposal/get: the proposals on file as an agent reads them (what waits on the person, what they decided) — thin over `ctx.services.proposals`; under `ctx.app`, the list is the viewer's own. proposal/changes { cursor?, wait?, limit? }: the PROPOSAL FEED (src/proposal-feed.ts) after a cursor, held up to `wait` — what happened, never the input; `GET /proposals/changes` is the same read; under `ctx.app` the viewer's own. proposal/decide { id, action, input?, reason? }: a PERSON's decision, for strut's own app (plans/jamie-app.md §3) — runs only as a first-party page's own call (a one-step run, never an agent's tool), the viewer's own proposals, through the capability's `decide` (the decide route's code)
│   │   │   ├── run/       # run/list, get, events, transcript, launch, cancel, workflow, files, provenance (plans/apps.md §5; provenance: plans/spot-check.md): runs as STEPS, unsealed — the kit's hooks name them, an APP reaches them through `step_run` on its `grants.workflows`, an agent through `agentTools: ["run/*"]` — thin over `ctx.services.runs` (src/runs.ts). run/launch is `launchDetached` (`{ runId }` at once; `attachments` as `POST …/run` takes them, saved under the run's artifacts; `params` may narrow a grant, never widen it — `grantWidenedBy`; `key` dedupes in flight: the run still live under the same key comes back `{ runId, existing: true }`; under `ctx.app` the run records `origin: "app"` + `app` and hands `ctx.app` to its steps; `conversation` — the conversation a JOB turn belongs to, so strut wakes it — from strut's own app only, one its viewer may continue (`mayContinue`), else `conversation_not_yours:`), run/get holds up to `wait` (55 s) while the run is in flight, run/files reads one file (the job's directory for a job run, else the artifacts), text or base64, run/transcript one agent's session by step path (what `run/events`' `transcript` link names; `full` a session turn's thread), capped; run/provenance a SPOT CHECK — where a value, a cell, a node or a file's text came from in the run (src/provenance.ts) — the later Cause agent's door as much as a page's
│   │   │   ├── browser/   # browser/* — one Playwright call per step, each a thin wrapper over one verb of `ctx.services.browser` (src/browser/service.ts): open, goto, back, close; snapshot (the accessibility tree, interactive elements tagged [ref=eN]), text, evaluate, observe (console / page errors, failed requests, 4xx/5xx since the last call); click, fill, type, press, select, hover, scroll, wait — by `ref` from the last snapshot (reset by any navigation) or a Playwright `selector`; screenshot (shots/NNN.png under the run's artifacts, or the job's directory on a job run; the 0.6× copy rides to a model via withMedia); capture (open → a declared list `{ do: <verb>, … }` → settle → shoot); verify (the same list + `expect`, answering in the check contract — the page failing is a result, the instrument failing throws) and walkthrough (verify with a frame per captioned step: walkthroughs/NNN/ + walkthrough.json); state (the storage state to state.json, for a human to paste under Secrets and load with open's `storageStateSecret`); keep + open/close `{ session }` (a page the JOB keeps across runs, held on the job as `browser:<session>` with browser/close as its release step); tap (clicks at fractions of an element's box — a person's taps on its crop); captcha-ask (the challenge's crop + the manifest hive's captcha card reads, shots/captcha-<round>.{png,json}, written in code) and captcha-state (a round's state on that manifest). Grantable as `agentTools: ["browser/*"]`; the job seed grants verify + walkthrough
│   │   │   ├── http/      # http/verify: the ENDPOINT instrument (plans/job-claims.md §4) — one request over `ctx.services.http`, the check contract back: `{ supports, content, locator: { url }, status, ms, failed }`, so a check is one line of config and `mapCheckResult` needs nothing new. No `expect`: a 2xx supports; `expect` names a status (or several), response headers (substring, names case-insensitive), `contains` substrings, `json` dot paths → deep-equal, `maxMs`. The endpoint failing is a RESULT (a wrong status, 500 included, `supports: false` with `failed` naming each); the instrument failing — refused, DNS, timeout — THROWS, which the pass maps to cannot-run and writes nothing. `secrets: { Authorization: "Bearer {API_TOKEN}" }` maps a header to a value template whose `{NAME}` placeholders (single braces: the `{{ }}` engine never sees them) resolve through the secrets capability in code; a missing one throws, the values are masked out of `content` and `failed`. Grantable to the job agent, so what it saw mid-turn is what the pass records
│   │   │   ├── git/       # git/checkout (a fresh isolated working copy per run: credential-free bare cache under <dataDir>/repos — the remote's branches fetched into `origin/*`, so a branch an agent makes in a working copy is its own and no other run's `fetch --prune` deletes it; a cache from before that, a `clone --bare` mirror, is moved over at its next checkout — + a detached worktree INSIDE THE RUN'S OWN DIRECTORY — <artifacts>/<runId>/<repo>, the dir job/dir hands a run with no job, so `cwd: "{{ dir.path }}"` holds the repositories with or without a job; <dataDir>/worktrees/<runId> only on a bare bag with no artifacts capability — removed by ctx.onRunEnd — or, with `workdir`, a KEPT one inside a job's directory, <dataDir>/jobs/<name>/<repo>, reused by the next run that names it, one run at a time (`job_busy:`), the repository removed when the job is idle; the token reaches git through the child env + an inline credential helper ONLY), git/diff (stage all, one unified diff, caps, gitleaks when on PATH), git/apply (a unified diff on stdin, --index --check then --index, `patch_conflict:` when it no longer applies, sha256 of the bytes as given) and git/push (commit the index as the token's GitHub identity — GET /user via ctx.services.http — push HEAD to a new branch, never --force; `push_rejected:` / `no_push_permission:`). The landing primitives (plans/code-change.md §6): the error codes are a contract hive classifies on. _shared.ts: the git runner over ctx.services.shell, parseRepo, one lock per cache
│   │   │   ├── memory/    # memory/remember, recall, get, ontology, forget, merge, export, import, lexicon, attributes: an agent's long-term memory on embedded LadybugDB (_db.ts: lazy handle, schema, migrations, `memoryWrite`; _ontology.ts: the Ontology rows — entity types + predicates, aliases, cardinality one/many, unknown terms kept `proposed` — and `vocabulary()`, the one place steps read behaviour from, cached per database until a write to the Ontology commits: a type's `parent` (single, child wins), `naming`, `role: user` (singleton matching, the default speaker, refused by forget/merge), `role: dictation` (the type dictation makes a new word as: memory/lexicon's `lingo_type`), a predicate's `role: alias` (its fact text names the subject) and `role: mishearing` (heard_as: how dictation mishears the subject, the wrong text in `Fact.value` and the written form it stands for in `Fact.form`, NULL for the name — never an alias, so nothing resolves, recalls by name or pairs on it); _ontology-seed.ts: the seeded terms, add-only plus a NULL-only backfill; _lang-en.ts: language data, `STRUT_MEMORY_LANG`). No step names a type or predicate: memory-ontology.test.ts fails on one in a string literal. Graphiti-style Episode → Entity ← Fact with world time (valid/invalid, NULL unless the words gave one) and record time (created/expired): a fact is superseded, never overwritten, and one whose end has passed is stored past (a current fact that began before the one held is history); an episode has a `speaker` (default the user, NULL when the user has no entity yet; first person means the speaker); remember, merge and forget are one transaction each on a write connection of their own (`memoryWrite`); forget is a soft delete with a reason; merge leaves the duplicate as an ALIAS_OF. lexicon is dictation's vocabulary in one read (Peel's): each live entity's cased written forms (its name and its name facts' values), its mishearings, `dictation_off` (attributes.dictation, written by attributes, which sets or clears entity attribute keys) and ranking inputs, plus the mishearings forgotten with reason `undone` so they are not learned again. export / import (_snapshot.ts) move the whole graph between struts: export, in the writes' queue (`memoryExclusive`), CHECKPOINTs and writes one .tar.gz (manifest.json + EXPORT DATABASE's Parquet) to `<memory folder>/snapshots/`, kept until the next export; import loads one into an EMPTY graph only (no Entity, Fact or Episode rows), and a failure part-way leaves it empty. Owner-only folder
│   │   │   ├── dictation/ # dictation for any client (plans/native-dictation-client.md §7a). The vocabulary: add (by hand), remove (a mishearing, or a lingo-type word with all of its), undo (forget reason undone). correction: { typed, edited } → { learned: [{ heard, written, undo }] }: what the user's edit of dictation's text teaches — audio/lingo.ts `mishearings`, judged by the user's fixer model (nothing learned with none installed, or one that takes longer than the timeout once loaded) — each mishearing written through memory/remember as the pair alone (never the sentence) on the entity that writes it or a new word of the lingo type; undone pairs and dictation_off words never. The models: models, use, remove-model over `stt.dictation` (_models.ts). _shared.ts: `readLexicon` (what /audio/transcribe reads) and `learn`
│   │   │   ├── docx/      # docx/to-html and docx/redline: Word files in JavaScript, no pandoc and no npm dependency (_zip.ts: ZIP over node:zlib, the src/tar.ts precedent; _xml.ts: an XML tree that serializes back as it read, so untouched parts of `document.xml` stay as Word wrote them; _docx.ts: the package's parts by relationship, and where a step's file lives — this run's files, the job's directory on a job run else its artifacts, or another's by served link; writes only into this run's own). to-html (_html.ts): headings (style or outline level), Word's own list numbers as text ("12.3", "(b)") so a citation matches, bullets as nested `<ul>`, tables with merged cells, links, inline marks; tracked changes as `<ins>`/`<del>` with `datetime`, `title` and `data-author` (DocumentView keeps the first two, kit/src/folds/document.ts) and as `changes`; comments, footnotes and endnotes as numbered notes `[n]` listed at the end and as `notes` (a comment's anchor is its range's text, changes accepted); `text` is the document with every change accepted; `out` writes the HTML as a page. redline (_redline.ts): each edit's `find` matched in a body paragraph's shown text across runs, links and content controls (exact, then with curly quotes / dashes / no-break spaces read as plain), `paragraph` picks among matches, `all` takes every one; the difference from `replace` goes in by whole words (numbers whole, the brackets and signs stuck to a replaced word with it, changes a wordless gap apart joined) as `w:del` + `w:ins` (author, date, each its own id; deleted runs keep their formatting, the insertion takes the first one's); `reason` + `sources` become one Word comment over the whole match (made, related and typed when the file has none), its marks outside anyone else's revision. Refused, with the reason and the paragraphs seen: not found (or a near miss in case or spacing), ambiguous, text inside a tracked change already there or a field's result, a span over a picture or note reference — nothing of that edit is written. docx.test.ts builds its .docx fixtures in code and reads a redline back through pandoc when it is installed
│   │   │   ├── sheets/    # sheets/create-spreadsheet, update-values, batch-update-values, get-values, add-sheet, import-spreadsheet: Google Sheets over raw REST through `ctx.services.http` (moved from the mcp lab's seed, 2026-10-16). get-values' `grid: true` is ONE `spreadsheets.get` (title, tabs, and per cell display text, value and formula; an empty range = the first tab whole) — what strut/views' SheetView polls, under Google's 60 reads a minute. _shared.ts signs the service-account JWT (spreadsheets + drive scopes) from GOOGLE_SERVICE_ACCOUNT_JSON, the gdrive/* steps' secret, and a new spreadsheet goes into GOOGLE_DRIVE_FOLDER_ID when set. An API error is a string the agent reads; only missing or invalid credentials throw, worded as "unavailable here, go on without them". Grant with `agentTools: ["sheets/*"]`
│   │   │   └── graph/     # graph/* knowledge-graph steps over src/graph (the strut-native twins of the mcp lab's jarvis/* steps — same names, inputs, outputs, except graph-search: its hits also carry a code node's `file`, `start`, `end` (0-based lines, as stakgraph stores them), and it takes `exclude` (path parts or file-name globs to leave out) — plus nine strut-only ones: changes, the graph writes made through strut after a cursor (`ctx.services.graphChanges`, src/graph-writes.ts — ids, types, time; `types`, `since`, `wait`; plans/live-feeds.md §3); query, ONE read-only Cypher query as a workflow step (`readQuery`, src/graph/query.ts — the chat's `graph_query`; rows keyed by column, strings whole, `maxRows` ≤ 1000 with `truncated`, a write or a failed query FAILS the step; never served to an app page, which reads by type with `find`; the `builder` seed grants it, since with no raw read the job wrote custom steps that opened the graph themselves); delete-edge removes one edge (by `edge_ref_id`, or source + type + target, the locator edit-edge takes), delete-node soft-deletes a node of ANY type in the namespace with its edges (the node writer's `deleteNode`; `softDelete` keeps its strut-domain guard) — the two writes hive's `graphEdgeDelete` / `graphNodeDelete` proposals needed (plans/proposals.md §6b), create-schema registers/extends a node type, edit-edge patches an edge's properties, move-node re-homes a node (the one edge that places it — any type, either direction — is muted and written again to the new place, one transaction, cycles refused; graph reads skip muted edges, as jarvis's do), walk gathers context for a goal hop by hop with a decision model (jev via experimental_evaluate, or a wrapped LLM) judging relevance/next/enough — plans/graph-walk.md — find, the nodes of ONE type whose properties match (`src/graph/find.ts`: `where` field → value or `gt`/`gte`/`lt`/`lte`/`in`/`contains`, `orderBy`, `limit` ≤ 500 + a `cursor`, `count`; fields are the type's schema attributes, `ref_id`, `created_at` (`date_added_to_graph` accepted as its old name), so nothing the caller writes reaches the statement; one dialect-helper statement on both engines; no provenance — a list is not what the caller named; plans/apps.md §4.3) — and two strut-only INPUTS on graph-get: node_type + name, an exact lookup by key for types keyed by name, never a search; and `children: <EDGE_TYPE>`, which adds the nodes it points to along that edge as { ref_id, node_type, name, description } sorted by name — a node and its table of contents in one call; and `required: true`, for a workflow that cannot go on without the node: every failure the step returns as a string for a model — not found, an unknown type, a malformed lookup — is thrown instead); _shared.ts's `graphCtx` takes `ctx.services.graph` — the backend the server wired, a Neo4j or the desktop's Ladybug file — and only without one opens a Neo4j from env; graph-steps.test.ts is a live end-to-end test
│   │   └── registry.ts    # auto-discovery: buildRegistry() core (static) + lib (dynamic) + workspace custom/ (dynamic); createRegistry() for in-code steps
│   ├── ai/                # AI workflow-builder backend (used by POST /chat)
│   │   ├── index.ts       # barrel export
│   │   ├── prompts.ts     # SYSTEM prompt + buildSystem(deps) (pre-seeds steps tree); AiDeps carries `services` + `secrets` (read-only names). The builder's RULES — strut's workflow dialect, the "Tools" section, the procedure — are ONE text rendered from a role → tool-name map (`BuilderTools`, plans/builder-job.md §1): `CHAT_TOOLS` for the chat, byte-identical to the prompt it always had (prompts.test.ts pins it against `fixtures/chat-system*.txt` — it heads every chat's cached prefix), `JOB_TOOLS` (the meta/* twins, app/*, the graph reads; `chat: false` — no listing, no detach, no `edits`, no bash, ask in the reply) for the builder job, which builder-seed.ts renders through `builderRules`
│   │   ├── builder-system.ts # the DEFAULT `chatSystem` on a graph: the `Workflow Builder` Concept's docs + the kinds under it (`PARENT_OF`), rendered by the `context/concept` step (framed as the workspace's notes, docs capped at 6k); a host's own hook replaces it
│   │   ├── tools.ts       # buildTools(deps): list_steps, search_steps, get_step,
│   │   │                  #                   list_secrets (NAMES only), create_step, edit_step,
│   │   │                  #                   list_workflows (query?/limit?: slim entries — name/description/category/activeVersion — cut at 100 with `total` + a `hint` the model reads; the sidebar's matcher, src/search.ts) / get_workflow (one metadata read; both shared with the meta/* twins through authoring.ts),
│   │   │                  #                   create_workflow / edit_workflow (the full YAML, or `edits`: exact-string replacements over the active version, each matching once — a one-line change to a 50k workflow without resending it; edit_step takes the same), run_workflow (threads ctx.services),
│   │   │                  #                   graph_query (read-only Cypher; only when deps.graph is wired),
│   │   │                  #                   graph_get (the graph/graph-get STEP as a chat tool — its schema, its run(); one node by ref_id or type + name, with `children`; same gate),
│   │   │                  #                   graph_walk (graph/walk as a chat tool; same gate),
│   │   │                  #                   list_runs / get_run (a run as a TREE — src/run-view.ts) / search_runs (grep across recent runs' logs → (runId, path, snippet); then get_run on a hit's path),
│   │   │                  #                   set_active_version (rollback), cancel_run/pause_run/resume_run (when deps.controlRun is wired; resume_run also HEALS a dead run onto the active version with deps.resumeRun),
│   │   │                  #                   validate_workflow (static YAML check, no publish — src/validate.ts),
│   │   │                  #                   list_automations / set_automation / delete_automation (schedules; when deps.automations is wired),
│   │   │                  #                   ask_user / request_secret (the builder asks the user — plans/elicitation.md; when deps.openElicitation is wired)
│   │   ├── walk-tool.ts   # graph_walk (OFF for now: `GRAPH_WALK_TOOL_ENABLED` in prompts.ts): an async-generator tool bridging runWalk's per-hop ctx.emit to preliminary results (→ `tool-progress` chat events, GET /chat/:id/progress/:toolCallId for history); toModelOutput hands the model only { goal, stopped, decider, nodes }
│   │   ├── turn-callback.ts # POST /chat { callback }: every turn end POSTs to the host with `settled` (expect() tokens for detached runs + verify passes) — how a host app dispatches the builder without tailing
│   │   ├── attachments.ts # files on a chat message (`POST /chat { attachments }`): validated + capped, saved under `<dataDir>/uploads/<chatId>/`, turned into the user message's parts — an image or a PDF as a `file` part the model sees, text and Word (.docx/.doc via `word-extractor`, lazy) as inline text, anything else announced with its path for bash. A run's (`POST …/run { attachments }`) the same, saved under the run's artifacts (`saveRunAttachments` / `loadRunAttachments`) and put on its agents' prompts
│   │   ├── mcp.ts         # strut over MCP (stateless Streamable HTTP, one SDK `Server` per request, the SDK lazy-imported): `toolsetServer` adapts ANY AI SDK ToolSet GENERICALLY, so no tool exists twice — tools/list from each tool's `asSchema` JSON Schema, tools/call = validate → execute → drain a generator (earlier yields → `notifications/progress`) → `toModelOutput` (where the cap lives) → content (+ `structuredContent`; `isError` on a `{ error }` result) — and `createMcpDoor` is the per-request transport. Three doors in createStrut: `POST /mcp` = the ASSISTANT set (assistant-tools.ts; `assistantInstructions`, ten lines), `POST /mcp/builder` = the BUILDER set (`builderServer`: `buildTools(deps)` + `builderInstructions` = BUILDER_PROCEDURE + the UI's URL + its `?secrets=1` deep link, since ask_user / request_secret are not offered there, + the full `buildSystem` — the host's `chatSystem` section included, resolved at each prompts/get with chat id `mcp` — as the `workflow-builder` prompt); with the chat off `/mcp` serves the builder set; `POST /index/mcp` = the INDEX role's STORE set (packages/index-tools.ts: three reads over the index's derived pages, open to anyone). createStrut's `builderDeps` is what both doors and the chat turn share; the doors add `publicUrl` + `artifactRefs` (artifact links absolute with their `?t=` file token, `ui` deep links) and a polling detach hint (get_run's `wait`). specs/API.md §11
│   │   ├── assistant-tools.ts # the ASSISTANT tool set, `POST /mcp`'s default: NINE tools for an external agent (Claude Code, Hermes) that has forty other tools and should not learn strut's YAML — `ask_workflow_builder` (a message to the builder, new chat or continuation; holds up to `wait` and returns the turn's `text` + `did` from chat-view.ts, `status` done | working | asked (the open question, a secret's link for the caller's USER) | parked | error, `settled`), `read_workflow_builder_chat` (turns since a cursor), `list_workflow_builder_chats` (find a chat again; `mine` by the connection's `x-strut-actor`), `list_workflows` (+ schedules, last run), `list_runs` (+ each run's artifacts as links), `get_run` (the basics; an output field over 2k chars HELD BACK as `{ $omitted }` until named in `fields`; `files: true` lists the run's files with links; no step tree — the builder debugs), `run_workflow` (the builder's own, output trimmed the same way), `search_packages` (the package STORE over `ctx.services.packages`: the followed indexes' hits with their `detail`, the peers' installs) and `get_package` (one package's page as a model reads it, `briefPackagePage`, with `ui` = `<base>/?install=<name>`, the person's Publish dialog on its Packages tab, on the name) — the two say a PERSON installs, and where. No model behind any but the first. `AssistantChatDoor` is createStrut's way in: `sendChatMessage` (POST /chat's core, shared), the notifier's liveness, the turn callbacks' `isSettled`; a chat started here is stamped `ChatMeta.publicUrl`, so the builder's tool results in it carry absolute links and its reply text copies them
│   │   ├── elicitation.ts # the builder asks the user (plans/elicitation.md), the PURE half: ACP's flat schema subset + validator (model schema, submitted content), the secret-looking-field guard, crypto-random ids, `stepAsked` (the chat's stop condition), the `[elicitation-response]` formatter, the question as callback text
│   │   ├── stepHelpers.ts # lsSteps / searchSteps / readStepSource (filesystem-style browser)
│   │   └── schemaHelpers.ts # zodToFields: Zod → FieldDesc[] (the UI config form); stepSchemas: Zod → JSON Schema (get_step's input/output for the builder)
│   ├── browser/           # the browser behind `ctx.services.browser` (the browser/* steps): service.ts — `BrowserService`, ONE lazy Playwright connection and a context + page per run keyed by runId, closed by createStrut's run-end teardown (`dispose`); three backends from env (`fromEnv`): a Playwright SERVER (`BROWSER_WS_URL` + `BROWSER_WS_PATH`, images/browser), a real Chrome over CDP (`BROWSER_CDP_URL`: one page per run in the profile's own context — no viewport, storage state or state export), else a local headless Chrome; a per-call timeout whose loser closes the context, a per-run budget; a check (verify, walkthrough) in a session of its OWN, signed out, as the verify pass will replay it; a KEPT page (`job:<job>/<session>`) the job holds across runs — runs attach to it, `dispose` only detaches, an idle timer instead of the budget, at most `BROWSER_SESSIONS_MAX`, not over CDP. captcha.ts (the captcha manifest, to hive's parser), settle.ts (network idle → fonts → two frames, each bounded), shot.ts (where a PNG lands — the run's artifacts or the job's directory, `job.update` to a listening host — and the 0.6× model copy via sharp), walkthrough.ts (the recording directory + manifest), verdict.ts (verify's verdict, pure), deny.ts (`BROWSER_URL_DENY`: schemes, CIDRs, hosts — checked before a navigation and on the landed URL), seed.ts (seeds the four browser workflows at boot, `browserWorkflows: false` opts out). `npm run test:browser` runs service.live.test.ts against a real server
│   ├── privacy/           # Private AI (specs/PRIVACY_SPEC.md): PSEUDONYMIZATION before a hosted model, for any consumer (Hive, Peel) alike. rules.ts (RULES_LEGACY / RULES_NEW / RULES_HEUR, regexes tuned: copy exactly), gazetteer.ts (ORG/LOC data, STOP), detect.ts (ruleSpans, denySpans, `resolve` with a sorted-interval index, typeFix, `Stage` + `detectAll`: the plug-in seam for a later clue stage), ner.ts (transformers.js token-classification, one pipeline per thread, run in a worker thread by default — `workerNer` over `ModelWorker`, its cache dir and offline flag read on the main thread — `NerEngine` = the test seam, pure `groupAndAlign` / `nerPostprocess`), llm.ts (optional, off by default, its own worker — `workerLlm` — `LlmEngine` seam), pseudonymize.ts, restore.ts, vault.ts (memory Map | AES-256-GCM files under `<dataDir>/privacy/vault`, handles ONLY `pvm_`/`pvf_` + 24 hex, AAD id:exp), keys.ts (`KeyProvider`: the ONLY reader of STRUT_ANONYMIZATION_VAULT_KEY), models.ts, chunk.ts, types.ts, seed.ts (`private-ask`, `createStrut({ privacyWorkflows: false })` opts out), index.ts (`anonymizeTexts` / `deanonymizeText`, `ctx.services.privacy` = injection seam for engines, keys, vaultDir). `fixtures/recall.jsonl` + `privacy.live.test.ts` (`npm run test:privacy`, opt-in)
│   ├── audio/             # speech-to-text over sherpa-onnx (plans/local-desktop-and-stt.md §4), and text-to-speech the other way (plans/private-voice.md §3.3). Streaming dictation is the product surface; workflows learn AROUND it (hotword lists, "dream cycles" §4.8), no STT step in v1
│   │   ├── stt.ts         # createStt(): models (download.ts), the dictation picks (`stt.dictation`) and the fixer they pick (`stt.fixer`, fixer.ts), hotword lists, streams (PCM in → partial/final out; `push` / `end` are async, a round trip to the recognizer thread) and their session log, two-recognizer mode (fast greedy partials + hotword-capable finals), batch transcribe (the caller's `model`, else the user's installed speech pick, else `STRUT_STT_MODEL`; an `offline` model — Parakeet — decodes the whole clip in one pass and cannot stream); the recognizers run in a WORKER THREAD (decoder.ts over `ModelWorker`); sherpa is an optionalDependency, lazy-imported in the worker; an injected `engine` (tests) runs in process, `engineModule` swaps the worker's
│   │   ├── decoder.ts     # what runs in the recognizer thread: the sherpa engine surface (OnlineRecognizer, and OfflineRecognizer for an offline model), one recognizer per (model, hotwords hash, score, endpoint rules), each stream's decode loop (partials, endpoints, finals, words), and `transcribe`'s whole pass over a WAV — a recognizer's streams must live on the thread that built it, so building and decoding are both here
│   │   ├── tts.ts         # createTts(): text-to-speech, the speaking half of a voice conversation — Kokoro (`TTS_MODELS`, downloaded on first use by download.ts into STRUT_MODEL_DIR/tts/<id>) and `speak(text, { voice?, speed?, model?, signal? })` → `{ sampleRate, voice, audio }`, `audio` mono 16-bit PCM a piece per sentence as it is generated; a bad request is a `SpeakRequestError` before any model loads; the model runs in a WORKER THREAD of its own (synthesizer.ts over `ModelWorker`), never queued behind a dictation decode; aborting the signal, or leaving the loop, stops the speech; sherpa is the same lazy optionalDependency; an injected `engine` (tests) runs in process, `engineModule` swaps the worker's
│   │   ├── synthesizer.ts # what runs in the speech thread: sherpa's OfflineTts (built once per model, `lang: en-us` so espeak-ng reads the text and no lexicon is loaded, `maxNumSentences: 1`, up to four intra-op threads) and one generation at a time, each pulled by the main thread a sentence per `next` call from `generateAsync`'s `onProgress`. A stop is heard by sherpa only when a sentence ends, after it began the next: up to two sentences are generated for nothing
│   │   ├── models.ts      # catalogs: STT_MODELS (id → release URL + sha256 + chunk latency + hotwords? + offline?; STRUT_MODEL_DIR/stt/<id>), FIXER_MODELS (Qwen3 0.6B / 1.7B GGUF Q4_K_M on llama.cpp, each with its learn margin; the 1.7B is the default to offer; STRUT_MODEL_DIR/fixer/<id>), and DICTATION_MODELS — what a user picks from: Kroko + Parakeet TDT 0.6B v2 (offline) as speech, the fixers (plans/dictation-models.md); TTS_MODELS (Kokoro v1.0 fp32, its voice table by speaker id, `af_heart` the default; the int8 export was half the speed on CPU; STRUT_MODEL_DIR/tts/<id>)
│   │   ├── download.ts    # the ONE model downloader: fetch, sha256, extract a .tar.bz2 (`tar xjf`) or keep a single file, `.ok` marks it installed; concurrent installs of one dir share a download
│   │   ├── dictation-models.ts # the user's picks (speech, fixer or none) in <dataDir>/audio/dictation.json, each model's state (available / downloading with progress / installed); a pick not on disk downloads in the background and is used once installed; the dictation/models, use, remove-model steps are thin over it
│   │   ├── hotwords.ts    # contextual biasing: list format, synthesized bpe.vocab from tokens.txt (REQUIRED with modelingUnit "bpe" — unset = cjkchar = silent no-op), named lists under <dataDir>/audio/hotwords
│   │   ├── sessions.ts    # <dataDir>/audio/sessions/<id>.jsonl: finals + user corrections (the dream cycle's training data)
│   │   ├── ws.ts          # GET /audio/stream WebSocket (raw `ws` on the Node server — @hono/node-ws doesn't support node-server 2.x); Bearer or ?key=; a socket's stream calls (open, every push, end) run one after another, so audio reaches the recognizer in order
│   │   ├── lingo.ts       # dictation's vocabulary pipeline, pure over a `Lexicon` and a `Fixer` (plans/dictation-models.md): code finds and builds, the model only scores. `recall` (1–3-word spans fuzzy/sound-alike against every entry's heard and written forms; an exact past mishearing beats the same letters beats near, then the shortest span), `rewrite` (a candidate kept when the sentence with the word scores likelier than as heard, in its own capitals too; fillers and doubled words by rule with an exception list; a taken-back phrase when the fixer names `{ wrong, cue }` and code finds it before the cue; edits carry their offset), `heardOnly` (no fixer: exact learned mishearings only), `mishearings` (a word-level diff, each change of ≤ 4 words a side that `soundsAlike` asked yes/no; never an undone pair or an off word), memory/remember's input for a learn (`learnInput`, `undoIds`)
│   │   ├── fixer.ts       # `DictationFixer`: the user's picked fixer (`DictationModels.fixerModel`) in a ModelWorker of its own, loaded on first call, swapped when the pick changes, unloaded after 5 minutes idle; `within` + FIX_TIMEOUT_MS (1.5 s) for the callers' fallback; `fixerRuntime`: node-llama-cpp's way in, fixer/index.js when fixer/ is installed (the desktop package, a checkout that ran its install), else null — no fixer here
│   │   ├── fixer-engine.ts # what the fixer's worker runs: the judge / take-back prompts (Qwen3 ChatML, thinking off) and node-llama-cpp (Metal, GGUF; imported by the path the worker is handed, the part it calls typed here as `LlamaLib`, which fixer/check.ts checks against the real package) — `judge` (log P(yes) − log P(no), one forward pass), `score` (log-likelihood after "Dictated by someone who often mentions X"), `retract`; one sequence per task so each fixed prefix stays cached; imports only types from strut so the worker loads it alone
│   │   ├── dictation-eval/ # cases.jsonl (learn + fix cases, synthetic) and run.ts — `npm run eval:dictation`, opt-in: the real pipeline and DictationFixer against the GGUFs in ./.models/gguf (gitignored), with fixer/ installed; precision, recall, p50/p95, load time
│   │   └── routes.ts      # /audio/models (+ SSE download), /audio/transcribe (WAV body; `text` with the vocabulary applied by the fixer, read per call from memory/lexicon, `heard` + `changes` when it changed, `fixer` the model used or null — none, or slower than 1.5 s: fillers and doubled words by rule, exact learned mishearings of two or more words only; `?lingo=0` skips it), /audio/hotwords/:name, /audio/sessions/:id (+ corrections); `speakRoutes`: GET /audio/speak (the TTS models, their voices, `installed`), POST /audio/speak ({ text, voice?, speed?, model? } → `audio/pcm` s16le mono at `x-sample-rate`, streamed a sentence at a time; JSON errors only before the first sentence; a hang-up aborts the speech)
│   ├── graph/             # the graph layer on TWO engines behind one set of seams (plans/ladybug-backend.md §4): Neo4j over bolt, jarvis-compatible and no jarvis in the loop (plans/jarvis-graph-compat.md), and a LadybugDB file (`ladybug/`) holding only what strut owns. Opt-in via openGraphBackend
│   │   ├── engine.ts      # the seams: `GraphEngine` (kind, namespace, query, tx, the nine `Dialect` helpers — node / isType / typeOf / edgeType / live / edgeLive / int / lower / project, no tenth) + `NodeEngine` / `EdgeEngine` / `SchemaSource` (+ `ClosedRegistry`, a source that is code), the statements the writers and the resolver cannot write neutrally. Pure code above the seams is shared; a `GraphBackend` IS a `GraphEngine`
│   │   ├── neo4j-engine.ts # the Neo4j implementation: today's Cypher moved behind the seams as it was (the UNWIND-MERGE template, the IS_ALIAS rewrite, shortestPath, the `:Schema` meta-graph reads and writes); wraps Integers from the schema, so `int()` lives nowhere else. `asEngine(bolt)` for a bare Bolt
│   │   ├── ladybug/       # the LadybugDB engine (plans/ladybug-backend.md, ruling 6 as amended 2026-10-28: a DYNAMIC ontology, plans/memory-in-workspace-graph.md PR A): ontology.ts — the ontology IN the file, as on Neo4j: a type is a `Schema` row of the `Node` table (`node_type: 'Schema'`, its fields columns, its key spec the row's `key_spec`, its declared attributes one JSON column `attributes`), its parent and every allowed `S -[E]-> T` an edge of the ontology's own rel table `SCHEMA_EDGE` between two Schema rows — a parent link marked `is_parent` (read only by the ancestor walk), a rule unmarked with `edge_type` E (read only by the edge-rule lookups), apart from the data's rel tables so a read of an edge type never meets the ontology; `*` the wildcard; a declared attribute adds its column (`ALTER TABLE Node ADD`, one name one column type everywhere — a clash is refused), a new edge type its rel table, both in the caller's transaction; `LadybugCatalog` caches the file's columns and rel tables per handle (dropped on every schema write; a write that names one it lacks reads it again on its own transaction); `seedOntology` seeds registry.ts at open, once per seed version (stamped `ladybug_ontology_seed:<hash>` in `Migration`): planned whole before any DDL (a seed type a runtime type got to first — a clashing column, a name or alias — is skipped and warned, never a failed open), seed types set back to the seed's keys (runtime attributes kept), edge rules add-only. A Schema row is no node: `getNode`, neighbors, counts, `softDelete` and the edge writers' ref_id lookups leave the ontology out. registry.ts — the SEED in code: the nineteen types a new file holds (the ten Strut types the store and projector need, Claim / Check / Evidence, Concept — with exactly the attributes strut reads and writes, no Thing vestiges, no per-stem vectors), the twenty-two edge types (the Concept tree as `PARENT_OF`, parent → child, as jarvis keeps it and every reader walks it; `CHILD_OF` too; `DERIVED_FROM`, what a work product was made from), Concept's `unique_source_id` (a seeded page's stamp), `nodeColumns()` (the columns a new file is made with: generic, Schema fields, one per seed attribute; the module refuses to load on a type conflict), `ontologySeed()` (Thing, then the seed types as flat Schema maps, the edges, the stamp); db.ts — the handle: one Database per absolute path on globalThis, owner-only folder, the addon or its platform package (CI's --ignore-scripts), `vector` + `fts` REQUIRED to open (`STRUT_LADYBUG_EXTENSION_DIR`, else the pinned copies: extensions.ts — sha256 per platform for the installed core, Ladybug's own builds taken from its extension-repo image at a digest and held on a stakwork/strut release, downloaded and verified into the model cache through src/audio/download.ts; no pin for the core or platform → `INSTALL`, with a warning), the DDL (one `Node` table, `ALTER ADD` per column so a new seed attribute lands on restart; one rel table per edge; `Migration`), two indexes, the ontology seed, a write queue whose `withWrite` refuses every statement after a failure (the engine rolls back and the next would auto-commit), `readOnly()` = a connection of its own whose every statement runs in `BEGIN TRANSACTION READ ONLY` (NOT a second read-only `Database`: one reserves `MAX_DB_SIZE` of address space per open — 1 TB; at the addon's default 8 TB a process fits eight to ten, and `close()` never returns it), rows made plain (INT64 → number, a struct's nulls and `_label`/`_id` dropped); engine.ts — the dialect (`(n:Node {node_type: 'T'})`, `deleted_at IS NULL`, `label(r)`, CAST), nodes (pre-read `(node_type, key)` → CREATE the misses in one UNWIND, SET the hits; soft delete = `deleted_at` then the edges in three statements), edges (per-row MERGE on `edge_key`, typed columns only — an unknown edge property is an error, no alias rewrite, no flags, `SHORTEST` for the cycle check; an edge type needs its rel table), and the schema source = `LadybugSchemas` over ontology.ts (`holdsStrutTypes`: the resolver reads Strut types from the rows, not strut-schemas.ts; no jarvis allowlist); reader.ts — `LadybugReader`, the read surface over the one table: lookups, `namesLike`, neighbors and counts (two directed statements, `importance` order in TS), schemas from the Schema rows (the root Thing left out), columns from the catalog, and `search` = `QUERY_FTS_INDEX` (all words required, any-word fallback, no fuzzy) + `QUERY_VECTOR_INDEX` (`1 - distance`), both filtered after their top-k so every filter over-fetches both halves, into the shared fusion. One namespace; a domain is the types whose Schema names it; hidden = `deleted_at`, no per-field vectors; Schema rows are never hits. No migrations, no pass
│   │   ├── bolt.ts        # neo4j-driver wrapper (`Neo4jConfig`); int() for Integer writes (plain JS numbers write as FLOAT)
│   │   ├── deletion.ts    # the one delete model (shared with jarvis), as NEO4J fragments: NODE_LIVE / EDGE_LIVE filters, EDGE_IN_SCOPE (both ends :Data_Bank in $ns), nowMs, DELETE_NODE_TAIL (stamp deleted_at ms + is_deleted, hard-delete in-scope edges). Edges are never muted
│   │   ├── strut-schemas.ts# the 14 Strut node types (StrutApp + StrutAppVersion, plans/apps.md §1.3; StrutJob: exact_key on the job id, indexed title + summary, plans/job-index.md §6; StrutArtifact the newest: one per (job, artifact id), exact_key, the fold's newest version, `HAS_ARTIFACT` from its job and `DELIVERED` from each run whose output declared it; StrutProposal the newest: one per proposal, exact_key, a projection of its record — `IN_RUN` the run that made it, `ACCESSED` each node its apply wrote, `proposal_status` never `status`, plans/proposals.md §2) + 26-row edge registry (label registry in plans/generic-storage.md; `IN_CHAT` from a builder chat's `StrutTurn` and from an assistant conversation's `StrutAgentSession`, one `StrutChat` type for both, its `kind` saying which); author-time checks. The four WORKSPACE types (StrutWorkflow/-Version, StrutStep/-Version) are `exact_key`: their node_key tokens are the HEX of the exact name (`strutstep-706f642f74657374` for `pod/test`), not jarvis's sanitized form, which strips every non-alphanumeric and made `pod/test` and `pod_test` ONE node (swarm38, 2026-10-07); the run/chat types keep jarvis's composition. The flag never reaches the Schema node
│   │   ├── schema-seed.ts # idempotent domain registration through `SchemaSource`: Thing root, Schema nodes, CHILD_OF, the migration stamp; the constraints and vector/fulltext indexes are Neo4j DDL (`engine.bolt`). On a graph with no jarvis `About` node it also creates `strut_search_text_index`, the one keyword index the reader uses there, and `createNodeSchema` then makes no per-domain fulltext index. Also the seed types (seed-types.ts), each created through `createNodeSchema` only when no Schema has its name, and each of their edge rules only where the graph does not already allow that edge — so a graph jarvis seeded keeps its own rows and gets none of ours. Returns `mode: "file"` at once on a store that seeds its own Strut types (Ladybug)
│   │   ├── seed-types.ts  # the types BOTH engines seed beside the Strut ones (plans/ontology.md): Claim, Check, Evidence (the claim layer) and Concept, under jarvis's names and key specs with the attributes strut writes and reads, their 16 edge rules, and their Neo4j domains (Epistemic, General). Ladybug's registry.ts seeds them at open, schema-seed.ts on Neo4j; every other type is created at runtime
│   │   ├── node-writer.ts # §6 validation gate + node_key composition (jarvis's sanitizer, verbatim; hex tokens for an `exact_key` type — `keyToken`) + Data_Bank + the create/upsert/restore/update semantics; issues no Cypher — `NodeEngine` does (`neo4j-engine.ts`, `ladybug/engine.ts`); softDelete (Domain_strut only) + retirePlannedEvidence
│   │   ├── edge-writer.ts # the edge rules (closed Strut registry for Strut sources, the resolver's edge schemas for the rest — jarvis's edge allowlist only on a graph jarvis shares, one holding jarvis's `About` node; elsewhere every edge needs a rule, plans/ontology.md ruling 1), stamps, update() = jarvis PATCH /v2/edges/:ref_id (stamps protected), move() with its cycle check; issues no Cypher — `EdgeEngine` does (on Neo4j: MERGE by edge_key with the IS_ALIAS rewrite, ON CREATE only, a legacy muted edge made live)
│   │   ├── schema-crud.ts # createNodeSchema(): register a non-Strut node type like jarvis POST /v2/schema (parent, attribute grammar, node_key, CHILD_OF, constraint) or add-only extend an existing one, on both engines (on Ladybug a new attribute is a new column); on Ladybug a name or `aliases` entry that is already another type's name or alias is refused, and a `managed_by` type only takes its owner (plans/memory-in-workspace-graph.md decision 9; `SchemaSource.typesNamed`, Ladybug's — Neo4j keeps jarvis's rules)
│   │   ├── claims.ts      # the truth layer (plans/claims.md): Claim/Check/Evidence contract (ids, check subject + result shapes), claimStatus() — status computed on read per (claim, subject) — and ClaimsReader, whose reads are written with the backend's dialect helpers (one reader for Neo4j and a Ladybug file; the evidence joins are four statements joined in TS, never an OPTIONAL MATCH; a filter is in the text only when asked for, never a null param) — ClaimsReader (claimsFor/checksFor/evidenceFor/statusFor; deleted nodes + legacy muted edges invisible). `strut.claims` is null unless the workspace is graph-backed
│   │   ├── claims-writer.ts # ClaimsWriter: the claim graph's invariants — ≥1 check per claim, edits SUPERSEDE (successor claim carries ABOUT + checks; successor check takes over TESTS), retire = timestamp, detach = deleted edge, last check / last subject refused
│   │   ├── exact-key-migration.ts # one-shot boot re-key of existing StrutWorkflow/-Version/StrutStep/-Version nodes from the sanitized name to the exact (hex) key — ledger-stamped, idempotent, every namespace, soft-deleted nodes included; ref_ids, edges and the Schema nodes untouched
│   │   ├── embeddings.ts  # local all-MiniLM-L6-v2 via transformers.js, tokenized like sentence-transformers (256 incl. specials), 2 intra-op threads; + the EMBEDDING PASS (plans/semantic-search.md §1): a timer in the serving process that keeps `Data_Bank` + `text_embeddings` + the domain label current on EVERY node of a Schema-marked type, whoever wrote it (stakgraph's ingest, jarvis, an import) — stale = the stored text ≠ the writer's composition from the Schema's `index` fields, or no vector — strips the no-embed types (`embed: false`: `Turn` via its Schema, `StrutToolCall` / `StrutTurn` in code), pages by `node_key` (an index seek per page, never a scan), works 15 s a minute (the budget checked between batches of 100 rows), sweeps hourly (code types first), embeds NEWCOMERS by `date_added_to_graph` between sweeps (marked labels only, a `>=` cursor: stakgraph stamps a whole ingest batch alike). Its inference runs in a WORKER THREAD (`WorkerEmbedder`, over `ModelWorker` — src/model-worker.ts): onnxruntime-node's `run()` is synchronous, and on the serving process's main thread every forward pass stalled every request (swarm38, 2026-10-11: mcp's `/lab/health` 0.34 s → 1.74 s during a tick); the writer and search keep the in-process model. `GET /graph/embeddings` is its status; `STRUT_GRAPH_EMBEDDINGS=off` turns it off with the embedder
│   │   ├── search.ts      # the read surface — `GraphReader` the INTERFACE every consumer reads through (`backend.reader`), `Neo4jReader` jarvis's read paths over bolt, the ranking shared with `ladybug/reader.ts`: hybrid search (RRF + title boost + usage tiebreak; a question of 4+ words fuses the keyword half at half weight, quoted spans and words the analyzer would split are phrases — `fusionWeights`, `queryParts`), get/neighbors/counts, ontology, namespaces. Routing (`routeIndexes`): the keyword half of a graph strut alone holds (no jarvis `About` node) reads ONE fulltext index over every node's composed search text (`strut_search_text_index` on `Data_Bank`, created by schema-seed.ts), its `type` and `domains` a WHERE after the index with the same over-fetch as vectors — so a runtime type is keyword-searchable on its declared `index` fields whichever type came first in its domain, as on a Ladybug file (plans/ontology.md item 4); a graph jarvis shares keeps jarvis's per-domain attribute indexes, which also cover fields outside a type's own `index` (a Function's `body`). A typed search reads the requested types' DOMAIN vector (and, on a jarvis graph, fulltext) indexes with an over-fetch (`overfetch`: k from cap×10 by ×4 to 2,000 — the database cannot filter a vector query, so `type` is a WHERE after the nearest-k cut), an untyped one the global `text_embeddings_vector_index`. `exclude` leaves results out by their `file` (`excludeRegex`: a path part matches whole `/` segments, a pattern with `*` or `?` the file name, case-insensitive; a node with no `file` stays) — one `=~` in the same WHERE, so a search with it over-fetches both halves, the keyword one's `limit` like a vector `k`. `linked` keeps results with a live edge of a type to a live node of a type (`parseLinks` → `linkedClause`: `EDGE>Type` leaves the result, `EDGE<Type` arrives at it, any one passes, the type resolved like `type`'s) — one `EXISTS` per entry in that WHERE, over-fetching the same way
│   │   ├── backend.ts     # openGraphBackend(cfg): `GraphConfig` is `Neo4jConfig | LadybugConfig` (`{ kind: "ladybug", path, namespace: "default" }`), overloaded per kind, cached per config. Neo4j: runs the migrations and the seeds on first open (strut bundles no jarvis library: plans/ontology.md), then STARTS the embedding pass (nothing waits on it; `close()` stops it). Ladybug: the handle's open IS the schema (DDL + the ontology seed) — no migrations, no pass; `reader` is the `LadybugReader` over its FTS + HNSW indexes, the writer embeds inline
│   │   ├── wiring.ts      # the default server's workspace from env: `workspaceBackendFromEnv` (`STRUT_WORKSPACE_BACKEND`: neo4j | ladybug | fs), `graphWorkspaceFromEnv` (Neo4j: NEO4J_*), `ladybugWorkspaceFromEnv` (the file at `STRUT_GRAPH_DB`, default `<dataDir>/graph/graph.lbug`, its own owner-only folder like memory's; then the fs import), `graphMaterializeDir` (`steps/_graph`)
│   │   ├── fs-import.ts   # the one-shot fs → graph import (plans/ladybug-backend.md §6 item 4, §7.1), a boot step: `FileWorkspaceStore.snapshot()` published through the GraphWorkspaceStore — every workflow version under its own label with description + provenance, then active / category / publisher / owner / cap / automations; every step version in label order, then the active one — and only once it all went through, the files moved to `<dataDir>/fs-workspace.imported-<ts>/` (the run store's `workflows/<name>/runs/` stay) and the `Migration` ledger stamped. Content-addressed, so a rerun is a no-op; a label holding OTHER content in the graph is `fs_import_conflict:`; a non-active version today's lint refuses is skipped and named; version `createdAt` is the import's moment
│   │   ├── query.ts       # readQuery(): read-only raw Cypher for the chat builder's graph_query and the `graph/query` step — keyword pre-check (writes, apoc, and Ladybug's COPY / LOAD / INSTALL / ATTACH / IMPORT / EXPORT + the index procedures) + the engine's own read-only mode (a READ tx on Neo4j; on Ladybug `LadybugHandle.readOnly`, a READ ONLY transaction on a connection of its own), streamed row cap, query timeout, strings/vectors compacted. The tool description and the prompt's "Graph backend" line say how nodes are laid out on each (`graphConventions`, ai/prompts.ts)
│   │   ├── test-util.ts   # `testBackends()`: the list every behavioral graph suite iterates — a Ladybug temp file (skipped with the reason when the addon or the extensions are missing, or with `STRUT_TEST_LADYBUG=off`) and Neo4j when `STRUT_TEST_NEO4J_URI` is set (wiped between cases: a throwaway container only); `open({ embedder })` hands the writer and the reader one embedder; `seedConceptSchema` lets a suite write Concepts on either engine (the one Schema row on Neo4j); `rawNode` / `rawEdge` / `setNodeProps` / `edgeCount` / `nodeCount` / `anyNode` / `typeFrom` / `rawWrite` give a test the same picture on both engines; `wipeGraph` + the canonical snapshot
│   │   ├── __fixtures__/  # TEST FIXTURES only, left out of the build (tsconfig): jarvis's ontology library (jarvis-ontology.ts, a dump at migration 125) and its seeder (jarvis-seed.ts), for the suites that model a graph jarvis shares; no module outside a test imports them (jarvis-free-boot.test.ts checks)
│   │   └── fixtures/      # Python-produced MiniLM golden vectors + jarvis sanitize_node_key parity cases
│   └── *.test.ts          # ~1700 unit tests across 97 files — the workspace-store conformance, node-writer, edge-writer, schema-resolver, claims, claims-authoring, verify, projector, search (the reader) and names suites among them, on a Ladybug file (+ the live graph tests under src/graph/ and steps/lib/graph/ against Neo4j, opt-in)
└── web/
    ├── package.json       # preact, system-canvas, vite
    ├── vite.config.ts     # preact preset, dev proxy to :3000 (/workflows, /steps, /chat, /llm, /health)
    ├── index.html
    └── src/
        ├── main.tsx       # entry: renders <App/>
        ├── app.tsx        # shell: sidebar, topbar, canvas, events panel, dialog/flyout orchestration. `&solo=1` renders one thing ALONE, nothing of strut's around it, for a native host's web view (Peel): `?app=` an app's page (AppHost), or `?artifact=<path>` one served file in the viewer — a job's file or a run's artifact, here or behind `/peers/<id>` hops (`isServedFilePath`; any other path says it is not a file strut serves); `artifact` without `solo` is ignored; `?store=1` the store front (Store.tsx). `App` picks the solo page or the `Shell`, so nothing of the shell's (its loads, the `/runs/active` poll) runs behind one. `?install=<name>[&index=&index_url=]` (the store's link, store-links.ts) opens the Publish dialog's Packages tab, Find, on that package, the index followed first when this strut does not yet; the params are dropped from the URL once the dialog closes
        ├── api.ts         # typed fetch wrapper for all API endpoints (+ run SSE tail; chat: sendChat/streamChat/getChat reattach)
        ├── flow-to-canvas.ts  # Flow → CanvasData; one theme category per palette entry; childRefForStep/stepWorkflow (container nav)
        ├── helpers.ts     # normalizeSteps, formatJson, etc.
        ├── step-colors.ts # the step palette: PALETTE + paletteKey(type) — the ONE place a step's color is decided; the canvas nodes and the run overview's bars both read it
        ├── actor.ts       # displayActor: an actor id's first `-` segment for the UI (storage keeps the whole id)
        ├── page.ts        # pickPage: which page the UI shows from the address and the session (`api.pageSession`, `GET /auth/session`) — the store front, an app or a file alone, a MEMBER's apps list (plans/member-rights.md), or the shell; memberApps orders that list (pure; tested)
        ├── context-meter.ts # the chat header's "351k / 1M": formatTokens + contextMeter (warns from 80%) over `ChatMeta.context` (pure; tested)
        ├── attachments.ts # the chat composer's files read for `POST /chat` (a PNG/JPEG past 1568 px scaled down first; the server's limits checked early)
        ├── automation-form.ts # the Automations editor's flat form state ⇄ trigger draft (pure; no calendar math — the server owns that)
        ├── store-links.ts # the STORE FRONT's pure parts (plans/marketplace.md §7; tested): parseStoreView / storeQuery (what `?store=1&pkg=|concept=|q=` names), the DEEP LINK out of the store — `installLink(strut, { pkg, index: { key, url } })` → `<strut>/?install=<name>&index=<key>&index_url=<catalog url>`, `parseInstallLink` (the shell's side), `indexIdOf` (the id a strut files a followed index under: its host), `normalizeStrutUrl` — and the folds the page draws from the open reads: `appsOf` (the hits' apps first, by title), `conceptRoots` (the tree's roots with how much sits under each), `canWords`
        ├── package-release.ts # the Packages tab's pure parts (plans/packages-ux.md): pickerGroups (the workflows a package may take, by category — an installed package's, a seed's and a service's left out), sidebarGroups / nameInGroup / installedTitle (the sidebar's groups: an installed package's workflows a group of its own, drawn from `GET /packages` and never written — its segment as the label, its version beside it, each workflow by its name inside the package), comesAlong (what a dry build carries beyond the picks, the picks it leaves to the host, and `needs` — its `leftToInstaller`, shown once as "Needs on the installing strut"), picksFromRelease (what a release held, as the names here; a Concept the release carried alone, `alone` on its items, picked alone again), packageLabel, nextVersion (the last number up by one), PACKAGE_NAME, PACKAGE_SEGMENT (tested)
        ├── icons.tsx      # inline SVG icons
        ├── storage.ts     # crash-safe localStorage wrapper (UI prefs, session state)
        ├── step-depends.ts # dependsForSave: what the step editor saves as `depends` — a checked list, `[]` when the step had an explicit `depends` and nothing is checked (a parallel step stays parallel; unchecking every dep means none), omitted when it never had one (still implicitly sequential)
        ├── peer-flag.ts   # the topbar's "Open to peers" toggle over a workflow's top-level `peer:` (a local edit Publish writes, like params): readPeer / applyPeer (off = the key removed) / togglePeer — turning a published `peer: person` off and on again restores `person`, never widens it to `true` (pure; tested)
        ├── step-attempt.ts # latestAttempt: a step's events from its last `step.start` / `step.skipped` on — a resume continues the same log, so a re-run step's earlier `step.error` is still in it; the canvas status and the run flyout read only the latest attempt (pure; tested)
        ├── (folds)        # run-overview, transcript, accessed-nodes and artifact-view are the KIT's (`kit/src/folds/`), imported as `@strut/kit/folds` — vite.config.ts aliases it onto the source, tsconfig `paths` (web's and the root's, for the tsx test run) the same
        ├── walk-graph.ts  # foldWalk: graph_walk's progress outputs → nodes/edges/current/next — the kit's `foldWalkProgress` (kit/src/folds/walk/graph.ts) under the names the chat uses; tested against the real walk
        ├── elicitation.ts # the builder's open question (meta.elicitation, ACP's flat schema) → FieldDesc[] for ConfigField + form helpers (pure; tested)
        ├── embed.ts       # deep links when iframed (Hive): replaceUrl() posts ?wf/run/v/chat/job/app/input to the host named by ?embed_origin
        ├── app-host.ts    # strut's UI as an MCP Apps HOST (plans/apps.md §7.3): ext-apps' `AppBridge` over a `PostMessageTransport` on the frame's window, wired to the MCP SDK's `Client` + `StreamableHTTPClientTransport` at `/mcp` with the UI's credential (`apiHeaders`: the session cookie or the key, `x-strut-ui: 1`) — the bridge relays the page's `tools/call` by itself, as it is. `ui/message` → the builder chat (`appMessage` names the app), `ui/open-link` → for a strut deep link (`strutLink`: same origin and mount, `?wf/run/job/app/input/artifact`) the host's `onNavigate` — which in the canvas area and alone opens a served file or another app in the SIDE PANEL (`panelTarget`, components/AppWithPanel.tsx, plans/jamie-app.md §4) — and a new tab otherwise, `?input=` → `ui/notifications/tool-input` after the page's `initialized` and again in place when it changes (`appToolInput`; a link to the page on screen resends it, `namesApp`; a peer's page's `?app=<name>` is `@<peer>/<name>` and its `?artifact=<path>` `/peers/<peer><path>`, `peerAppLink`), a theme change → `host-context-changed`. Nothing hand-rolled. app-links.ts holds the pure parts (`strutLink`, `appMessage`, the app link helpers, `panelTarget` — which links open in the side panel) and their test (app-host.test.ts): the root test run installs no web/node_modules, so a web test may import nothing that needs them For an app it shows to a signed-in viewer (not a visitor's page) it also CARRIES CHANNELS (plans/app-channels.md §3; a peer's app's ticket names the peer, and the strut relays the socket there, §4): `experimental["strut/channels"]` in `ui/initialize`, and the kit's `relayChannels` with a ticket from `POST /apps/:name/channel-ticket` and a `WebSocket` to `/channels` (`api.channelTicket`, `api.channelSocketUrl`), closed cleanly with the frame.
        ├── use-artifact-url.ts # useFileScope: a served path's SCOPE listing (`GET /artifacts/:runId` / `/jobs/:id/files` / `/apps/:name/:version/files` → its files + file token), one fetch per scope for the page's life (`api.fileScope`); useArtifactUrl: the tokened URL over it; useFileBlob: a served file's bytes as an object URL, read with the UI's credential (`api.fetchArtifactBlob`) — how a PEER's file shows, since no token minted here opens the read-through and the key never rides in a `src`
        ├── components/
        │   ├── AddStepDialog.tsx     # searchable Add Step picker (core / lib / custom)
        │   ├── AccessedNodes.tsx     # the run flyout's Nodes section: type chips (Concept by default, sticky), one row per node, a click opens its content in place (GET /graph/nodes/:ref_id)
        │   ├── ArtifactViewer.tsx    # the eye beside an artifact link (ValueFields): a modal showing the file RENDERED — markdown via Markdown.tsx, media inline, pdf/html in a frame (html sandboxed), text in a pre, a DIRECTORY as one level of folders and files, a WALKTHROUGH (`walkthrough.json`, `parseWalkthrough`) as frames to scrub — portaled onto <body>. It MOVES within the scope: a markdown link to a sibling (resolveArtifactLink) and a directory row open in place, a back arrow over the trail; a link out of the scope stays a link. A PEER's file (`/peers/<id>/…`, `isPeerPath`) is fetched with the UI's credential and shown from its bytes — media and a PDF from an object URL (`useFileBlob`, the PDF's typed `application/pdf`), markdown images through `FileImg` (Markdown's `img` hook), HTML as the `srcdoc` of `sandbox=""` (runs nothing) — and a file nothing renders DOWNLOADS (`api.downloadArtifact`) — for a peer's file and this strut's alike, beside the head's Download, which every file gets (a local one also keeps "Open in new tab"); no URL it builds for a peer carries a token or the key. `solo`: the head and body in normal flow, no backdrop — alone in the window with nothing to close (`?artifact=…&solo=1`), or in an app's side panel with `onClose` (AppWithPanel.tsx). An app the caller names (a published one, its document the path) renders through AppHost, not as HTML
        │   ├── WorkflowFlyout.tsx    # the selected workflow's own flyout, one tab each — Params / Claims / Automate / Versions (only the tabs that apply) — with "Delete workflow" in the footer, and under the tabs the APPS whose grants name the workflow (a chip each opens the app). The topbar's single **Workflow** button (claims dot riding along)
        │   ├── AppHost.tsx           # an app's page, hosted (plans/apps.md §7.3): the version's files listed (`useFileScope` mints the token), `dist/index.html` fetched under it (the server writes the app's identity into it), the TEXT framed as the srcdoc of `<iframe sandbox="allow-scripts">` — an opaque origin, never `allow-same-origin`, no src with a credential; never a `blob:` URL, whose document has its creator's `location.origin` and the whole URL as its pathname, which kills a validator in the MCP SDK's bundle at module time — with the relay (../app-host) connected over the frame's window BEFORE the document loads. The canvas area when an app is selected (the sidebar's Apps section, `?app=`), or the whole window with `&solo=1` (SoloApp.tsx) — in both inside AppWithPanel.tsx, so a file or another app the page links to opens beside it — an app of this strut there under a version chip (`panelChip`, app-versions.ts) listing its versions to VIEW in place, never to make live; the topbar shows its title, a chip with the live version and the drafts waiting (`v8 · live · 3 drafts`) that opens AppVersionsFlyout.tsx, a **Tab** toggle beside it (`PUT /apps/:name/pin`: shown as a tab in the hosts that list this workspace's apps; the sidebar's Apps list puts pinned apps first, marked `tab`) and **Edit with the builder** (the chat with the app named); a page's `ui/message` is sent on the builder chat; an `app_publish` in the chat reloads the frame. `app` is a workspace app `{ name, version }`
        │   ├── AppVersionsFlyout.tsx # an app's Versions (plans/app-releases.md), the topbar's version chip: the mode ("Every publish goes live" / "Hold a version"), the live version (since when, by whom), one row per version newest first — live, was live, draft (web/src/app-versions.ts, tested) — with View (this browser only: the frame shows it under a banner with Make live and Back to live), Make live, or Restore for a version that was live (its newest release); every change asks first; release ids only in History. No workflow version numbers: the lock's `behind` and `floating` are not shown until runs keep to the lock (work item 2)
        │   ├── AppUsageFlyout.tsx    # an app's Usage (`GET /apps/:name/usage`, src/apps/monitor.ts), the topbar's **Usage** button beside the app's version chip: the live version's warnings first (each with its fix and, for an app here, **Ask the builder to fix it** — a chat draft the person sends), calls per minute over the hour, the day by step type, earlier versions' warnings dim; refreshed every 10 s while open. The warning dot (`.usage-dot`) sits on the app's sidebar row, the Apps title and the Usage button while `GET /apps` carries `warnings`; the shell re-reads this strut's apps every 30 s for it
        │   ├── Store.tsx             # the STORE FRONT (`?store=1`, plans/marketplace.md §7; specs/API.md §14.3): an index strut's public page, rendered ALONE in place of the shell for anyone with no credential, over the open reads alone (`api.storeCatalog` / `storeSearch` / `storePackage` / `storeConcepts` / `storeConcept`: a plain fetch, never the key) — Browse (the apps across the hits first, each a package's face off `detail`; the packages; the Concept roots; the publishers off the signed card; a footer saying it is all derived), a package's page (apps, the workflows table with inputs and what each reaches — the `spends` / `acts` / `code` chips, `CanChips` — the steps with secrets and lint, the Concepts, the README; the aside: needs, the publisher's key, releases and channels), the Concept pages as a wiki (tree, docs, children, in which packages). Nothing installs here: **Install into your strut** is `installLink` into the visitor's own strut ("Your strut", kept in localStorage; else asked, the name to paste beside it). On a strut without the role: "Not a store". LIVE items (plans/public-surface.md §8): the index's live rows (`PUT /index/live/:prefix { url }`, the card's `live` map beside `publishers`, read at the row and every crawl; `GET /index/live`) show as **Live apps** and **Live workflows and steps** on Browse, each a page read from its publisher's `/public` in the visitor's browser (an app framed from `?app=&solo=1&public=1` with "Open full page"; a workflow's inputs, steps and recent runs; a step's fields and source), and a Concept only a live view holds reads its docs from there
        │   ├── AppRail.tsx           # the COLLAPSED sidebar (the toggle beside "strut", `sidebarCollapsed` in localStorage): one tile per app — two letters, a hue from its key, pinned first, the usage dot — its title in a tooltip fixed to the window; a click opens the app. The sections stay mounted, hidden, so each keeps its scroll
        │   ├── AppWithPanel.tsx      # an app's page with a SIDE PANEL beside it (plans/jamie-app.md §4, §4.1): what the app cannot show in its own document (`frame-src 'none'`, `run/files` 2 MB) it hands over as a strut deep link through `ui/open-link`, and this host opens `?artifact=<served path>` (`isServedFilePath`: a job's files, a run's artifacts, a peer's read-through) through ArtifactViewer (`solo` + `onClose`) and `?app=<key>` (another app, a peer's too) through AppHost under a title bar, instead of navigating away — the page keeps its frame and its state. `panelTarget` (app-links.ts) decides; a new link replaces the panel's content (an app's new input in place), ✕ closes it, its left edge resizes it (`WidthResizer`, `--app-panel-width` on `.app-split`, `strut.appPanelWidth` in localStorage), and in a container under 760 px it lies over the page (a container query). The panel's own app links the same way. A link to the page itself, a workflow, a run or a job goes to the caller's `onNavigate` as before. Not in the address bar: a reload closes it. No panel for a visitor's page. Used by the canvas-area host (app.tsx) and SoloApp.tsx, not by the job timeline's or the viewer's app
        │   ├── MemberApps.tsx        # a MEMBER's page (plans/member-rights.md): the apps here (`GET /apps`, strut/views left out, strut/jamie first, then pinned, then by title), each opening alone as `?app=<name>&solo=1` — what a member who opens strut directly gets instead of the shell
        │   ├── SoloApp.tsx           # `?app=<key>&solo=1`: the page ALONE, nothing of strut's around it, for a native host's web view (plans/apps.md §7.4) — `App` renders it in place of the shell, so it reads only the listing the app is in (`GET /apps`, or that one peer's `GET /peers/<id>/apps`; `parseAppKey`) and the app's files: no workflows, step types, other peers or `/runs/active` poll. A key ending in `@vN` (`bench@v3`, an import's pin) shows that version instead of the live one — a held app's draft, for `app/look`; one ending in `@preview-<hex>` an unpublished build `app/look { path }` hosts, no listing read (the lookup is `useListedApp`, web/src/use-listed-app.ts, which the side panel shares). `&theme=light` (or `dark`): the theme it hands the app (`soloTheme`, app-links.ts), for a host whose own page is light; dark without it. No `ui/message`; a link to itself is its input in place (the address bar follows), a file or another app opens in the SIDE PANEL inside this one page (AppWithPanel.tsx) — how Hive and Peel, which frame this page, show what the app cannot frame — and anything else a new tab. `&public=1`: a VISITOR's page (plans/public-surface.md §5) — `GET /public/apps/<name>` and its document, AppHost's `visitor` relaying to `POST /public/mcp` with no credential; what the store frames from a publisher's server
        │   ├── PublishDialog.tsx     # the topbar's **Publish**: one dialog, two tabs — **Packages** (PackagesPanel.tsx, the copies other struts install) and **Public view** (PublicViewPanel.tsx, what anyone reads here live). A tab mounts when first shown and stays mounted, so a Public view draft survives a look at Packages (the tab carries a dot while it has one); one height for both, the tab's body scrolling between the tabs and Close; the button opens on the tab used last (`publishTab` in localStorage), `?install=` on Packages
        │   ├── PublicViewPanel.tsx   # the Publish dialog's **Public view** tab (plans/public-surface.md §2, decisions 19–20): what anyone can read on this server, live and read-only — the record (`GET`/`PUT /public-view`) as rows per kind (an app with its reads, "Open as a visitor" and its link; a workflow with a "with its runs" box; steps; Concept roots), an Add bar whose app or workflow asks `GET /public-view/needs` and shows the cascade pre-checked, every line with what it exposes, Save (a bar held at the bottom of the tab while there are unsaved changes) writing the whole list and saying which apps it held; its pure parts in web/src/public-view.ts (tested)
        │   ├── ParamsPanel.tsx       # the Params tab: edit the workflow's `params` (edits → Publish, a new version)
        │   ├── VersionsPanel.tsx     # the Versions tab: every version newest-first with its run counts (GET /workflows/:name/versions, attributed by the run's recorded workflowHash) + View / Make active (rollback via PUT /workflows/:name/active — publishes nothing) + a YAML toggle per version: the file as published (GET /workflows/:name/:version, fetched on first open), read-only in SourceCode; a version that came from a package says so — "installed from" (or, an edit carrying it forward, "forked from") `<package> <version>`, off `upstream` in GET /workflows/:name
        │   ├── PackagesPanel.tsx     # the Publish dialog's **Packages** tab (plans/packages-ux.md): where packages live — names stay bare where they are made and the sidebar knows nothing of packages. Its head is the PUBLISHER — the name, set once (`PUT /publisher { name }`, the first segment of every package published here; nobody types it again) beside the key. **Here**: the packages this strut published (the catalog's), one row each with the newest version, and **New package** (one segment, under the publisher). A row opens the PACKAGE PAGE: every workflow here by category with a checkbox (`pickerGroups`: an installed package's, a seed's and a service's left out; a filter past eight), apps, Concepts (a typeahead, on a graph; each chip "with its pages" or "alone", `conceptsAlone`); the boxes start as the newest release left them (`GET /packages/:publisher/:name/items`); **Comes along** reads a dry build of the picks (`POST /packages/build { dryRun: true }`: the subflows, steps and apps it carries, the picks the host keeps, what the installing strut must already have, the secrets it needs, or the refusal); version after the newest release, channel (`stable`), description, the peers the publish will ping, **Publish** → `POST /packages/publish`, its answer or the refusal verbatim, then the releases newest first with what each channel holds — a channel moved to any release (a rollback), the package taken out, or **Make public** (the channel `public` marked and moved: the release listed in the public catalog, sealed by the publisher's second key, for anyone; a public channel's badge says so, and the head shows the public key beside the fleet key). Below, read only: what it FOLLOWS and has INSTALLED (with `door`). Never from a workflow's flyout. A person's act — no builder or `meta/*` tool publishes
        │   ├── AutomationsPanel.tsx  # the Automate tab: list (toggle / Run now / last run) + editor (repeat form, live "next runs" preview from the server, inputs with fire-time tokens)
        │   ├── ChatFlyout.tsx        # AI workflow-builder chat (detached launch + reattach; chatId in localStorage; renders the open question's form; the context meter in its header)
        │   ├── Transcript.tsx        # the entries renderer (bubbles, tool chips, notices, marks) the chat flyout and the thread view share
        │   ├── JobTimeline.tsx       # the selected job in the canvas area (plans/jobs-sidebar.md §3): header + totals, deliverables (cards → ArtifactViewer / a link / inline content; a peer-tagged one `{ peer, via?, job, path }` badged `@<peer>` and opened in the viewer through the peer's read-through — `linkOf` maps it with `peerArtifactPath`, `/peers/<peer>[/peers/<via>]/jobs/<job>/files/<path>`, and never takes a strut-relative url of the peer's as local; RunOverview's artifact list shares `linkOf`), the thread TREE (a thread row with totals; its turns with time, run link, tools, duration, cost, context, artifact chips marked current/superseded; spawned threads nested), every node the job's agents touched (AccessedNodes over the fold). A turn's run id opens that run on the canvas with the flyout on its step; `transcript` opens ThreadFlyout. A `kind: "app"` deliverable — a workspace app by name and version (the builder's; `api.hostableApp`) — opens in place under the cards — the first one by default — in JobAppPanel.tsx: AppHost under a bar with Reload, Expand (the viewer) and "Under Apps"
        │   ├── ThreadFlyout.tsx      # one thread read back, read-only (§4): the turn's `?full=1` transcript rendered by Transcript with a mark at each turn's `offset`, the system prompt collapsed on top, no input box
        │   ├── ElicitationForm.tsx   # the builder's question at the end of the transcript: a form (Submit / Decline / ✕) or, for a secret, a password field posting to the /secret endpoint — the page a host's link opens (?chat=&elicit=)
        │   ├── ConfigField.tsx       # field renderer driven by Zod-derived FieldDesc (+ the node-name typeahead for a field with `nodeType`, via graph-search)
        │   ├── CreateDialog.tsx      # new-workflow dialog
        │   ├── EventsPanel.tsx       # bottom run-events panel: the log, and beside it an `aside` column (RunOverview)
        │   ├── RunOverview.tsx       # the run at a glance, right of the event log: status + job chip, Cost and Model calls tiles, the spend split by who spent it, the run's time, the files the launch ATTACHED (`run.start.attachments`, folded by run-overview: each opens in the viewer, or downloads when nothing renders it, with a download button beside it), the declared artifacts (`GET …/runs/:runId/artifacts`, the viewer) + its file listing, the timeline (hover card: time range, cost, calls; a click opens the step's flyout or the child run), then Claims (`GET /workflows/:name/evidence?runId=`) and the output, folded
        │   ├── EventsResizer.tsx     # drag handle for events panel height
        │   ├── Markdown.tsx          # tiny markdown renderer for chat output (headers, lists, fenced code, quotes, pipe tables, inline marks); `resolveLink` (the viewer's) turns a link whose target the caller can show into an in-place open, and is the only way an image renders — nothing but the scope's own files is loaded
        │   ├── RunInputPopover.tsx   # input-payload editor when triggering a run
        │   ├── SecretsDialog.tsx     # manage deployment secrets (write-only values; names+meta listed)
        │   ├── SourceCode.tsx        # read-only, syntax-highlighted source: a step's TypeScript (Lezer's TS parser) or a workflow version's YAML (`language: "yaml"`, the lang-yaml parser already bundled for YamlEditor) → `tok-*` spans colored in components.css — the Source toggle in the step editor + Step Info flyouts, the YAML toggle in the Versions tab
        │   ├── StepEditFlyout.tsx    # edit step (id / type / config / depends / options)
        │   ├── StepRunFlyout.tsx     # view a step's run I/O (leaf: input/output; container: aggregate summary)
        │   ├── WalkView.tsx          # a graph_walk call in the chat: paced hop playback (live) / final state + replay (history), node detail, open run
        │   ├── WalkGraph.tsx         # d3-force graph of a walk (ported from hive): ONE simulation for the component's life, nodes kept by id, joins not rebuilds
        │   └── FlyoutResizer.tsx     # drag handle on a panel's left edge: `WidthResizer` (a width property on a holder element, kept in localStorage; frames take no pointer events during a drag) — `FlyoutResizer` the flyout's (`--flyout-width` on `.shell`), AppWithPanel the side panel's
        └── styles/
            ├── base.css       # palette (CSS vars on :root), reset, type
            └── components.css # shell grid, sidebar, flyout, dialog, events, chat, badges
```

## Running

```bash
# Engine
cd strut
npm install
npm test                    # ~1800 tests, ~1 min
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
docker run --rm -d -p 3300:3000 -e BROWSER_WS_PATH=devpath ghcr.io/stakwork/strut-browser:1.63.0
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

## Environment

| Variable            | Default        | Description                          |
| ------------------- | -------------- | ------------------------------------ |
| `STRUT_WORKSPACE`    | `./workspace`  | Persistent volume for workflows/runs |
| `STRUT_WORKSPACE_BACKEND` | (graph: Neo4j) | Where workflows and steps live (`src/graph/wiring.ts`): unset / `graph` / `neo4j` = Neo4j (`NEO4J_*`, a boot dependency); `ladybug` = one LadybugDB file under the data dir (plans/ladybug-backend.md; `STRUT_GRAPH_DB`) — the desktop package's default, and a filesystem workspace found under that `dataDir` is imported into the file at that boot (`src/graph/fs-import.ts`; a failed import boots the fs workspace instead, loudly, and tries again next boot); `fs` = the filesystem workspace, no graph (no claims). Runs, chats, secrets and artifacts stay under `STRUT_WORKSPACE` on every backend. `GET /health` (keyed) reports `workspace: { backend, path? }`. |
| `STRUT_GRAPH_DB`     | `<dataDir>/graph/graph.lbug` | The Ladybug graph backend's file (`STRUT_WORKSPACE_BACKEND=ladybug`). Its folder is created owner-only (0700), like the memory steps' `<dataDir>/memory/graph.lbug` — two files in v1 (plans/ladybug-backend.md §7.2). |
| `STRUT_PORT`         | `3000`         | HTTP server port. `0` lets the OS pick; `listen()` resolves to the bound port and prints `{"event":"ready","port":N,"host":…}` on stdout for a host process to parse. |
| `STRUT_HOST`         | (all interfaces) | Bind address. A desktop host passes `127.0.0.1` to keep a local strut off the LAN. |
| `STRUT_WEB_DIST`     | `<module>/../web/dist` | Where the built UI is served from, for packagers that relocate it. |
| `STRUT_PUBLIC_URL`   | (the request's origin) | The base URL a caller OUTSIDE the UI is handed links on — the MCP door's artifact links (absolute, with the `?t=` read token) and `ui` deep links (`createStrut({ publicUrl })`). Unset: each request's own origin, `x-forwarded-proto` / `x-forwarded-host` honored. |
| `STRUT_EXIT_ON_STDIN_EOF` | (unset) | `1` = `desktop.js` exits when its stdin closes. A host spawns strut with a stdin pipe it never writes to; the kernel closes it when the host dies, crash or force quit included, so strut never outlives its app. Launcher only (`scripts/desktop.js`), not `build/server.js`. |
| `STRUT_API_KEY`      | (unset)        | Deployment-scoped shared secret. See "Auth" below. |
| `STRUT_MCP_LOCAL`    | (unset)        | `1` lets `PUT /mcp-servers/:name` register a server on loopback or link-local (a dev MCP server on this machine). Off by default: a registered server is sent a secret, and 169.254/16 is a cloud's metadata service. |
| `STRUT_HOST_CONFIG`  | (unset)        | A JSON file with the host's delta for the workflows strut ships, `{ job?, orchestrator?, builder? }`, each `{ tools?: string[], approve?: string[], system?: string, model?: string | null }` (`null`: no pinned model, so it runs on the connected one, `STRUT_DEFAULT_MODEL`; `builder` also takes `peer: false`, closing it to other struts — a file may only close, never open — and `reach: { tools?, builtins?, secrets? }`, what the AI may publish: see "Secrets"; `orchestrator` also takes `wake: false` — strut does not wake a conversation when its job ends, for a host that still does — and `wakeMax`, the wake turns in a row, 4 by default: src/wake.ts), `jamie?: false` — no `strut/jamie`, strut's own assistant app (plans/jamie-app.md §5) — `knowledge?: false` — no `strut/knowledge`, the Concept tree (plans/knowledge-app.md) — and `automation?: { workflow, approve?, grants? }` for the automation/* steps — what `createStrut({ job, orchestrator, builder, automation })` takes, for a host that runs the bundled server (`build/server.js`, `desktop.js`) instead of embedding strut. Peel writes it at launch. A file that cannot be read or parsed fails the boot. |
| `STRUT_SESSION_HOURS` | `12`          | How long a browser SESSION lasts (`POST /auth/session`, see "Auth"): the key traded for an HttpOnly cookie signed under `STRUT_API_KEY` (else `STRUT_SECRET_KEY`), so the page never holds the key. Stateless, like a file token: rotating the signing secret ends every session. |
| `STRUT_PEER_KEY`     | (unset)        | The key ANOTHER strut holds for this one (plans/federation.md §3): presented like `STRUT_API_KEY`, but a request carrying it is `peer`-scoped — every read, a launch of a workflow whose YAML says `peer: true` (as published: no `params`), and cancel / pause / resume of a run a peer launched; anything else is 403. Unset, it opens nothing. A PERSON token (`POST /peers/tokens`) is the same key attenuated to one actor. See "Auth" below. |
| `STRUT_SECRET_KEY`   | (unset)        | Encryption key for the secret store (AES-256-GCM). Unset → a default dev key + one-time warning (obfuscated, not secure). See "Secrets". |
| `STRUT_RUN_MAX_COST_USD` | `100`      | Per-run LLM spend cap in dollars when the workflow sets no `maxRunCostUsd` — enforced only through the Mothership (see "Mothership cost control"). Must be a positive number: `0` would read as "uncapped" to the gateway, so a bad value is an error, never a fallback. |
| `STRUT_MOTHERSHIP` | (unset) | `1` = the default server (`src/server.ts`) builds `createMothership({ dataDir })`, passes its `llmAuth` to `createStrut` and mounts `/llm/delegations` — every LLM call of an actor with a delegation goes through the gateway. See "Mothership cost control". |
| `STRUT_MOTHERSHIP_REQUIRED` | (unset) | `1` = every LLM call must have someone to bill: a call with no principal, or no delegation on file for it, is a step error instead of a direct provider call, and an enabled automation on an ownerless workflow is refused when scheduled and when it fires (`lastFireError`). Set it wherever the Mothership is mounted. |
| `STRUT_LLM_PROVIDER` | (inferred from model, else `anthropic`) | Default LLM provider for agent/llm steps (anthropic\|openai\|google\|openrouter\|xai, via aieo) |
| `STRUT_LLM_MODEL`    | (per-provider) | Override model name                  |
| `STRUT_CHAT_MODEL`   | `claude-sonnet-5-5` | Default model for the AI-builder chat — any aieo name (alias, id, or `provider/id`; OpenRouter as `openrouter/org/model`), read once at boot. `STRUT_DEFAULT_MODEL` comes before it, and the flyout's picker overrides both per chat |
| `STRUT_DEFAULT_MODEL` | (unset)       | The deployment's default model, which a host changes at run time (Peel's connected model, stadeum's org default): the secret store, then env, read per call. An `agent` step with no `model` runs on it (a system workflow fails without it); the builder chat's turns with no pick run on it before `STRUT_CHAT_MODEL`; `GET /llm/models` reports it as `default` |
| `STRUT_MODELS`       | (unset)        | The models people may pick, as the host lists them: a JSON array of model names, canonical `provider/id` (`["anthropic/claude-opus-5-5","numes/z-ai/glm-5.3"]`), the secret store then env, read per call. Set, `GET /llm/models` (and the `llm/models` step Jamie's picker reads) marks exactly those `available` — a listed name aieo has no row for (an OpenRouter id, a provider aieo does not know) is added — and the builder's prompt names them instead of asking for a provider key. Unset, or not such an array (a warning), a model is available when its provider has a key here. Strut only shows the list: a host that sets it enforces it at its gateway (stadeum narrows each person's virtual key). One thing it decides: a listed name on a provider aieo does not know (`acme/llama-4`, stadeum's "Other") is an OpenAI-compatible provider the host's gateway holds, so strut runs it through a Mothership grant (`acme/llama-4` on the gateway's `/openai/v1`) and never directly; an unlisted such name is aieo's error, which says how to write a hosted model |
| `STRUT_CHAT_MAX_STEPS` | `100`        | Max agent tool-call iterations per chat turn |
| `STRUT_CHAT_RUN_WAIT_MS` | `60000`    | How long the chat's `run_workflow` waits before a run auto-detaches (dispatch mode) |
| `STRUT_CHAT_TOOL_RESULT_MAX_CHARS` | `50000` | CEILING on one of the builder's tool RESULTS — each string in it, and the result as a whole, as the model reads it (a query's thousands of short rows are cut to their first and last, a `{ omitted, from, to }` gap between: `capToolOutput`) — applied where the result is made — the model reads the capped result in the turn that ran the tool, and later turns replay the same bytes (history stays append-only, so the prompt cache holds). The uncapped output is in the chat's `events.jsonl`. The cap in force is this bounded by the window's headroom below the compaction mark (`STRUT_COMPACT_AT`): 50k on a 1M window, 16k on 200k. `0` removes the ceiling; the window's cap still applies while compaction is on. The builder's DOCUMENT reads — `get_workflow`, `get_step` (`DOCUMENT_TOOLS`, `chat-store.ts`), what `edit_workflow` / `edit_step` work from — are bound by the window's headroom alone, never this ceiling (176k on a 1M window), and are never re-cut on replay. |
| `STRUT_CHAT_MAX_AUTO_TURNS` | `10`    | Max consecutive notification-triggered chat turns before the chat parks (runaway guard) |
| `STRUT_COMPACT_AT` | `0.9` | Compaction (plans/compaction.md): the share of the model's window past which the builder chat and the `agent` step fold everything the model has seen into its own summary and go on from it — one APPENDED `[compaction]` user message and a replay boundary (`ChatMeta.replayFrom`; `replayFrom` on an agent session's turn line). Nothing is edited: the whole history stays, the read endpoints serve it, and the prompt cache and prefix-bound thinking blocks hold. Also sizes the per-result caps: one `bash` / `view` / builder-tool / agent tool-step result may be at most `((1 − at) × window − 12k) × 2` chars (the 12k reserves the summary and one generation), under each surface's own ceiling. `1` disables it: the provider's limit and `session_full:` are the backstops. |
| `STRUT_MODEL_CATALOG` | (bifrost's datasheet) | Where model prices, context windows and output caps come from: bifrost's datasheet (`https://getbifrost.ai/datasheet`), the file the LLM gateway prices every call from. The default server loads it at boot (`startModelCatalog`, src/llm.ts → aieo `loadModelCatalog`), keeps the last good copy at `<dataDir>/models/datasheet.json`, and fetches it again every 24 h; a failed fetch keeps that copy, and with none aieo's own tables answer. A cost is what the provider reported for the call (OpenRouter's provider metadata), else the call's tokens at the model's price: Maple's or Numes' table, then the datasheet, then the provider's flat rate. `off` loads nothing; an http(s) URL is fetched instead (a mirror). A host that embeds createStrut calls `startModelCatalog(dataDir)` itself |
| `EXA_API_KEY`        | (unset)        | Exa key for `web_search` on non-anthropic providers (agent step + AI builder), and on EVERY provider when the call is routed through the Mothership gateway (`createWebTools` `routed` — Bifrost cannot round-trip Anthropic's server-executed tools); anthropic called directly uses its native tool. Without it a routed call has `web_fetch` only. Store or env, like provider keys |
| `MAPLE_API_KEY` / `MAPLE_BASE_URL` | (unset) / `http://localhost:8080/v1` | The `maple` provider (src/aieo): open models in Maple's attested enclaves (maple.ai), named `maple/<id>` — `maple/gemma4-31b`, `maple/gpt-oss-120b`, `maple/kimi-k3`; a bare id never picks Maple, `maple` alone is gemma4-31b. Calls go to Maple's OpenAI-compatible proxy, which the deployment runs itself (`ghcr.io/mapleprivacylabs/maple-proxy`, `MAPLE_HOST=0.0.0.0` in a container); the base URL is the full one, `/v1` included. Both store or env, like provider keys. Like every provider, `resolveModel` asks `llmAuth`: with a Mothership grant the call goes through the gateway's OpenAI-compatible route as `maple/<id>` (the gateway holds Maple as a custom provider and calls the proxy), billed and capped per person, and neither setting is read; with no grant, to this proxy with this key, billed by Maple; under `STRUT_MOTHERSHIP_REQUIRED=1` a call nobody can be billed for is refused. aieo sends each model the `reasoning_effort` it takes (gpt-oss: `none` → `low`; GLM: `medium` → `high`); on gemma4-31b `reasoning: none` is no thinking |
| `NUMES_API_KEY` / `NUMES_BASE_URL` | (unset) / `https://api.numes.ai/api/v1` | The `numes` provider (src/aieo): Numes (numes.ai), a marketplace of inference providers behind one OpenAI-compatible API, named `numes/<author>/<model>` with OpenRouter's slugs — `numes/z-ai/glm-5.3`, `numes/nvidia/nemotron-3-ultra-550b-a55b`; `numes` alone is z-ai/glm-5.3. Its open-weight models listed in aieo's `NUMES_MODELS` are FREE (priced 0); any other Numes model costs real credit, priced at OpenRouter's rate for the slug or Numes' dearest. Both store or env, like provider keys. Through the Mothership like maple: with a grant, the gateway's OpenAI-compatible route as `numes/<author>/<model>`, billed and capped per person; with none, Numes' API with this key, billed by Numes and capped only by the key's own limit there. Numes maps any `reasoning_effort` to what the serving model takes |
| `STRUT_SCHEDULER`   | `1`            | The automations tick loop (plans/automations.md): fires scheduled workflows from inside this process, every 15 s. `0` disables it (or `createStrut({ scheduler: false })`) for a host that owns the clock and calls `strut.automations.fire` — automations can still be stored, previewed and run on demand. Single-process by design: two strut processes over one workspace would each fire. |
| `STRUT_WORKDIR_TTL_DAYS` | `7` | How long a job (`job/dir`, `git/checkout` with `workdir`) may sit unused before its REPOSITORIES are removed — its other files are kept, and a job with nothing left goes with its record. Swept by the next `job/dir` or kept checkout — no timer. `0` keeps them forever. |
| `STRUT_DISTRO_POLL_MINUTES` | `10` | How often each package SUBSCRIPTION reads its publisher's catalog and applies what is new (plans/marketplace.md §12.1, `src/packages/subscriptions.ts`); `0` = at boot only. A publisher also pings its peers after each publish, so a release usually lands at once. `createStrut({ subscriptionPoll })` (`false`: never by itself). |
| `STRUT_PEERS` | (unset) | Peers to put on file at boot (plans/federation.md §3): a JSON array of `{ id, baseUrl, token, label?, description?, repos?, ca?, servername? }` (`ca`: a PEM CA, for that peer's requests the only one trusted, `GET /peers` shows `ca: true`; `servername`: with `ca`, the name its certificate is issued for when that is not the URL's host, checked in place of the host) — the paste door for a strut a host cannot push to (a desktop strut behind NAT). Each replaces the record of the same id; `PUT /peers/:id` is the same door over HTTP. A bad entry fails the boot. |
| `STRUT_INDEX` | (unset) | `1`: the package INDEX role (plans/marketplace.md §7, `src/packages/index.ts`; `createStrut({ index })`) — this strut is the phone book: `PUT /index/:prefix` lists a publisher (its public key, where its public catalog is served), the rows are sealed into an index card served to anyone at `GET /index/catalog`, and the strut follows every listed publisher's public catalog, reads each package's newest archive into a derived page (`src/packages/detail.ts`), and serves `GET /index/packages?q=`, `GET /index/packages/:publisher/:name` and `GET /index/concepts[/:name]`, open to anyone — plus `GET /llms.txt`, the store as a markdown page for an agent that fetches URLs, and `POST /index/mcp`, the same reads as MCP tools — and, with the UI served, the STORE FRONT: a visitor at `/` with no credential is sent to `?store=1` (web/src/components/Store.tsx), the operator's shell staying a `?key=` or a session away. The index key is minted at the first row, in `publisher.json`. Off by default. |
| `STRUT_INDEX_URLS` | (unset) | With the index role: a JSON list of URLs where this index's catalog is served, written into every card as `urls`, so a reader that has it follows a move. |
| `STRUT_PACKAGE_INDEXES` | (the built-in defaults: none yet) | The package INDEXES this strut follows (plans/marketplace.md §7, `src/packages/indexes.ts`): a JSON list of `{ id, key, urls, label? }` — the index key and where its card is served (an index strut's `/index/catalog`) — put on file at boot, each replacing the record of its id (`PUT /packages/indexes/:id` is the same door; `createStrut({ packageIndexes })`). A bare name (`POST /packages/install { ref: "acme/linear" }`) installs through their signed cards; `/packages/search`, the `package/*` steps and the assistant door's package tools read them. Unset: `DEFAULT_PACKAGE_INDEXES`, empty until Stakwork's index is deployed; `[]` follows none. A bad value fails the boot. |
| `STRUT_PACKAGES` | (unset) | Packages installed at FIRST BOOT (`src/packages/boot.ts`): a JSON list of `{ ref, url?, digest? }`, what `POST /packages/install` takes — a bare `publisher/name` (through the followed indexes, `STRUT_PACKAGE_INDEXES`), `pk:<key>/<publisher>/<name>` with `url` (the publisher's public catalog, `…/packages/catalog?public=1`; what works with no index deployed), or `file:/path`. Once the boot is done, each listed package NOT installed here is installed through the person's door, one at a time, in order, in the background; one already here, at any digest, is left alone — never an update (a person updates, or a subscription does). A failed install (a catalog that does not answer) is a warning naming the package and the reason, never the boot's failure, and the next boot tries again; missing secrets are logged. A package of graph types alone leaves no version record, so it is installed again every boot, harmlessly (types are add-only). `createStrut({ packages })` adds to the list; `strut.packages.booted` settles with each outcome. Unset or `[]`: nothing. A bad value fails the boot. |
| `STRUT_HOME_SYNC` | (unset) | `box`: serve `POST /home/pull` and `POST /home/push` to a person's credential (`src/home-sync.ts`; `createStrut({ homeSync: "box" })`), so a strut that keeps a read copy of this memory syncs with it; `copy`: seed `home-sync`, the workflow that copy runs. See "Home sync". Off by default: on, the whole memory goes to any person token this strut minted. |
| `STRUT_SELF` | (unset) | This strut's OWN workspace, a JSON object `{ id?, label?, description?, repos? }` (no baseUrl/token — nothing is dispatched to self), so agents know which repos are here; `strut/list-peers` and the builder's `list_peers` report it as `self`. `createStrut({ self })` wins over the env; `PUT /self` is the same door. Not a peer: stored under its own key in `peers.json`. A bad value fails the boot. |
| `STRUT_VOICE_URL` | (unset) | The voice service beside this strut (`src/voice.ts`, plans/private-voice.md §4.1): `POST /voice/calls` forwards a person's call set-up, body unchanged, to `<url>/calls` with `x-strut-actor: <the person>`, and answers its status and body unchanged; nothing of either is logged or kept. Unset: the route is a 503. `createStrut({ voice: { url, token } })` wins over the env; `false` turns it off. Not http(s), or set without `STRUT_VOICE_TOKEN`, fails the boot. Set, `listen()` downloads and loads the speech models a call uses (the recognizer and Kokoro, ~400 MB the first time) in the background. |
| `STRUT_VOICE_TOKEN` | (unset) | The secret strut and the voice service share, sent as `authorization: Bearer` on every forwarded call, so nothing else on the host starts a call as a person. Required with `STRUT_VOICE_URL`. |
| `STRUT_EVENTS_SINK` | (unset) | One http(s) URL every run's events are POSTed to, batched, as `{ event: "run.events", events: [...] }` (`src/events-sink.ts`; `createStrut({ eventsSink: { url } })` is the same door for a host that embeds strut) — telemetry for a server that draws what strut is doing, set once for the deployment, whoever launches the run. Each event is the ENVELOPE only: `workflow`, `runId`, `path`, `type`, `stepType`, `durationMs`, `modelCalls` / `usage` / `cost`, the version fields, `actor` / `job` / `origin` / `parentRunId`, an error's `message` — never a step's `input`, `output`, transcript or params. Deliveries are retried briefly and then dropped; a listener that missed a batch backfills from `GET /workflows/:name/runs/:runId/events`. The URL is a credential: it is logged by origin only. Not http(s) fails the boot. |
| `STRUT_AUTO_RESUME` | `1` (persistent run store) | Boot-time auto-resume of runs cut off by a crash/restart (RUN_CONTROL_SPEC §5.3): on whenever the run store outlives the process — anything but `MemoryRunStore`, whatever the workspace's kind, so the lab's graph workspace + `FileRunStore` counts — every root run with a log but no summary that the last death cut off (its last event at or after the previous process's start, kept in `<dataDir>/boot.json`; with no record, the newest root run per workflow), unless paused/cancelling, older than 7 days, or already resumed 5 times (an unpause of a live run, `run.resumed { live: true }`, is not counted). A run whose log already ended gets its summary written and its `run.end` callback posted. The builder's CHATS the same way, gated on the chat store's kind: a chat left `live` by the dead process gets its turn finalized and a `[restart-notification]` wake-up turn (see "Chat is a detached background job"). `0` disables both. A run whose log is over `STRUT_RESUME_MAX_LOG_BYTES` is skipped by its size, unread; one whose log nothing wrote since the previous process started is passed over by its mtime (`RunStore.logWrittenAt`), summary and log unread, so a boot reads only the runs the last process touched. |
| `STRUT_RESUME_MAX_LOG_BYTES` | `67108864` (64 MB) | The largest run log a durable resume will READ — boot-time auto-resume and `POST …/resume` alike (`createStrut({ resumeMaxLogBytes })`). A run's log is read whole to replay its journal, and a run whose steps returned hundreds of megabytes writes one the serving process cannot hold (swarm38, 2026-10-30: a 139 MB log replayed at every boot crashed the process each time, until the 5-resume cap). Over it, auto-resume skips the run with one line — `[auto-resume] <wf>/<run>: skipped — run log is 139.0 MB (…), over the 64.0 MB (…) resume cap (STRUT_RESUME_MAX_LOG_BYTES) — not loaded` — and `POST …/resume` answers 413 with the same message; the log is never loaded. The size is `RunStore.logSize`, a `stat` on files. |
| `STRUT_STEP_OUTPUT_MAX_BYTES` | `8388608` (8 MB) | The largest output a step may return, as JSON (`src/output-cap.ts`). Over it the step FAILS — a normal step error, so retry and onError apply, and `step.error` names the size, the cap and the convention under "Artifacts" below: large data goes in a file under `ctx.services.artifacts`, its relative path in the output. The same cap holds for a loop or foreach iteration's output (the container step fails) and for what an agent's tool returns (`wrapToolsWithEmit`): the call fails and the error text is the model's tool result. An output is recorded on `step.end`, held in the run's scope for the whole run and read back whole by the journal replay, the run view, the projector and the verify pass — what filled swarm38's heap. The markers (`withMessages`, `withMedia`) are not counted. |
| `NEO4J_URI` / `NEO4J_HOST` | (unset) / `localhost:7687` | Graph backend connection — same names and defaults as mcp's own Neo4j client: `NEO4J_URI` wins, else `bolt://<NEO4J_HOST>`; `NEO4J_USER`/`NEO4J_PASSWORD` default `neo4j`/`testtest`; optional `NEO4J_DATABASE`. The `graph/*` lib steps read these via the secrets capability (secret store → env) and need nothing configured for a local Neo4j; `openGraphBackendFromEnv` stays opt-in (null when neither is set). |
| `STRUT_GRAPH_NAMESPACE` | `default`   | jarvis namespace every Strut node is written into |
| `STRUT_GRAPH_EMBEDDINGS` | (on)       | `off` disables the local MiniLM embedder and the embedding pass (vectors stay NULL; search is fulltext-only) |
| `STRUT_MEMORY_DB` | `<dataDir>/memory/graph.lbug` | The `memory/*` steps' LadybugDB file (secret store → env). A folder they create is owner-only (0700); an existing one open to other users gets a warning. With neither this nor a dataDir, the steps fail. |
| `STRUT_LADYBUG_EXTENSION_DIR` | (unset → the pinned copies) | Where the Ladybug graph backend finds the `vector` and `fts` extensions it REQUIRES to open (plans/ladybug-backend.md ruling 4): a folder holding `libvector.lbug_extension` + `libfts.lbug_extension`, flat or in `vector/` + `fts/`. Unset, strut downloads its PINNED copies — the bytes `src/graph/ladybug/extensions.ts` records by sha256 for the installed core and this platform, from the stakwork/strut release named there — into `<STRUT_MODEL_DIR>/ladybug/`, verified, once. Never Ladybug's `INSTALL` where there is a pin: extension.ladybugdb.com rebuilds the files under the same version (2026-10-20: 0.21.2 could no longer load its `0.21.0` ones, and the CDN's edges served old or new by machine). A core or platform without a pin falls back to `INSTALL`, with a warning. The desktop package carries the same pinned bytes in `native/` (versioned with the Ladybug CORE — `0.21.0` for `@ladybugdb/core` 0.21.2 — `scripts/package-desktop.mjs`) and `desktop.js` points this at it; the Docker image carries them in `/usr/src/strut/native` and sets this to it (`scripts/image-ladybug-extensions.mjs`, checked at build with no network). |
| `STRUT_LADYBUG_EXTENSION_URL` | (the release in `extensions.ts`) | A mirror of strut's pinned Ladybug extensions: a base URL serving `<platform>-lib<name>.lbug_extension` (`osx_arm64-libfts.lbug_extension`). The bytes are checked against the pins either way. |
| `STRUT_LADYBUG_MAX_DB_SIZE` | `64G` | The address space each Ladybug graph (the workspace's and memory's) reserves when it opens, and the largest its file may grow to: bytes or a binary unit (`16G`, `512MiB`), a power of two of at least 8 MiB (`src/graph/ladybug/max-size.ts`). Reserved, not used, and kept until the process exits. It was 1 TiB, which an arm64 kernel with 39-bit addresses (Raspberry Pi OS: 512 GiB a process) cannot map. Not kept in the file: a graph opens under any size at least as big as the file, so one made on a Mac opens on a Pi. A bad value fails the open. |
| `STRUT_MEMORY_LANG` | `en` | The `memory/*` steps' language data (`memory/_lang-<lang>.ts`): stop words today. English only; another value makes memory/recall fail and say so. |
| `STRUT_VERIFY_BUDGET_USD` | `10` | Verify-pass spend cap PER VERIFIED RUN: once the pass's checks have reported this much, remaining checks presumed paid (an `agent`/`llm` step anywhere in the check closure, or an unresolvable one) are skipped (`lastVerify: { skipped: "budget" }`) and the claim stays `unknown` — never `supported`. Checks that report no cost never count. |
| `STRUT_VERIFY_BUDGET_USD_PER_DAY` | `100` | The same cap PER SUBJECT PER (UTC) DAY, computed from the run store alone: the cost of today's runs under `check:<id>` tagged with that subject. A harness that verifies many candidates raises it, or sets its paid checks to `manual`. |
| `STRUT_SEALED` | (none) | Comma-separated step-type globs sealed in addition to the defaults (`eval/*`, `meta/*`) — `src/sealed.ts`. A sealed step (by namespace, or `sealed: true` on its def — the lab's graders) or workflow (`sealed: true` in its YAML — a grading harness) is what the meta surface may never run, read the runs of, verify, or reach from a publish, and what an `ai`-stamped check may never reach — by name, through a subflow, or via an `agentTools` grant (plans/claims.md §4.1, fixed point 2). |
| `STRUT_ENV_SCRUB` | `1` (the default server) | `startServer` (server.ts, desktop.js) empties `process.env` down to `KEEP_ENV` after taking the boot snapshot every read of strut's own goes through (`src/env.ts`): the deployment's keys stop being readable by a step or a child spawned with `process.env`, while `ctx.services.secrets` still resolves them from the snapshot. `0` leaves the env as it is. Nothing happens in a host that embeds `createStrut` unless it calls `scrubProcessEnv()` itself. Known limit: on Linux `/proc/<pid>/environ` keeps the exec-time env readable by the same user. |
| `STRUT_ENV_KEEP` | (none) | Comma-separated names kept in `process.env` through the scrub, for a library strut loads that reads the env itself (a proxy, a browsers path). Widens the server's env only — a child still gets `minimalEnv`. |
| `STRUT_ANONYMIZATION_VAULT_KEY` | (unset) | Secret (store → env) that encrypts `privacy/*` file vaults (`vault: "file"` fails without it); read only by `src/privacy/keys.ts`. Use a deployment-level secret. |
| `STRUT_PRIVACY_OFFLINE` | (unset) | `1` forbids downloading the privacy NER / LLM models (`<model dir>/privacy/<id>`); a missing model fails closed. |
| `STRUT_PRIVACY_TRANSCRIPTS` | (memory) | `file` keeps the privacy wrapper's masked session history across a restart in `<dataDir>/privacy/transcripts` (its token map in the encrypted vault — needs `STRUT_ANONYMIZATION_VAULT_KEY`, else memory). `STRUT_PRIVACY_TRANSCRIPT_TTL_HOURS` (24) is how long either keeps an idle session. |
| `STRUT_MODEL_DIR`    | `~/.cache/strut-models` | Local model files: MiniLM's ONNX cache, STT models under `stt/<id>/`, TTS models under `tts/<id>/`, dictation fixer models under `fixer/<id>/`. `STRUT_MODEL_CACHE` is the older alias. |
| `STRUT_STT_MODEL`    | `zipformer-en-kroko` | Finals recognizer for `/audio/stream` + `/audio/transcribe` (hotword-capable). For `/audio/transcribe` the user's installed speech pick (`dictation/use`) wins over it |
| `STRUT_STT_PARTIAL_MODEL` | `nemo-fast-conformer-en-80ms` | Fast greedy recognizer whose output is shown as live partials; `off` for single-recognizer streams |
| `BROWSER_WS_URL`     | (unset)        | The browser/* steps' Playwright server, `ws://host:port` (images/browser; the compose file sets `ws://browser:3000`). Unset with no `BROWSER_CDP_URL`: a local headless Chrome. Setting both is refused. |
| `BROWSER_WS_PATH`    | (unset)        | The server's secret endpoint path — the browser container's one door; it refuses to start without one. |
| `BROWSER_CDP_URL`    | (unset)        | A real Chrome started with `--remote-debugging-port` on a dedicated, logged-in profile instead: one page per run in the profile's own context (runs share its cookies; `viewport`, `storageStateSecret` and `browser/state` are refused). |
| `BROWSER_EXECUTABLE` / `BROWSER_CHANNEL` | (unset) / `chrome` | Local launch only: a browser binary, else a branded channel (the machine's own Chrome, no download). |
| `BROWSER_VIEWPORT`   | `1280x800`     | Default viewport for `browser/open`, `WIDTHxHEIGHT`. |
| `BROWSER_STEP_TIMEOUT_MS` | `10000`   | Per-call cap; a call that overruns it (plus settle's slack) closes the run's context. |
| `BROWSER_RUN_BUDGET_MS` | `600000`    | Per-run browser budget, spent from the run's first page; `browser/wait`'s default cap is what is left of it. |
| `BROWSER_SESSION_IDLE_MS` | `720000`  | A page the JOB keeps (`browser/keep`, `browser/open { session }`) closes after this long without a call, and the job's hold on it goes. In place of the run budget. |
| `BROWSER_SESSIONS_MAX` | `4`          | At most this many kept pages at once; a `keep` or `open { session }` past it is refused. |
| `BROWSER_URL_DENY`   | `file:,169.254.0.0/16,fd00::/8` | What a navigation may never reach: URL schemes, IPv4/IPv6 CIDRs (IP literals only — no DNS) and exact hostnames, comma-separated; checked before a navigation and on the landed URL. What the browser container can reach otherwise, a page can. |

## Auth

`STRUT_API_KEY` is a **deployment-scoped shared secret**. Set it on every
container in the compose (strut and any service that registers steps).

- **Unset (dev mode):** every endpoint is unauthenticated. Strut logs a
  one-time warning at boot so the lax posture is visible. A host that
  authenticates requests itself (mcp's `labAuth` in front of `/lab`) runs
  strut this way.
- **Set (production):** **there are no public endpoints.** One gate in
  `createStrut` sits in front of every route — reads, runs, publishes, chat,
  artifacts, transcripts, and any route a host mounts on `strut.app` later —
  and requires `Authorization: Bearer <STRUT_API_KEY>` (or `?key=`, for what
  a browser loads without headers). Anything else returns `401`. Two things
  are served without it: the UI's own files (`/`, `/index.html`,
  `/assets/*`, `/favicon.ico` — no data, and the page a person pastes the key
  into) and `GET /health`, which answers a probe `{ ok: true }` and nothing
  else (`dataDir` + `stepCount` only with the key). A new route needs
  nothing: `createStrut.test.ts` ("the API key gate") sweeps `app.routes`
  and fails on any that answers without the key. The one family it leaves
  out is `GET /public/*` (`src/public-routes.ts`, plans/public-surface.md):
  what a PERSON put in the public view with `PUT /public-view` (behind the key), served
  from that record alone, and nothing while it is empty — the sweep checks
  that too.
  The web UI attaches the key to every request once it has one: a host
  that spawns strut hands it over as `?key=` on the first page load (stored
  in `sessionStorage`, stripped from the URL), or a user pastes it under
  Settings → Connection (`localStorage`) — which the UI opens by itself on
  the first `401`. The dictation WebSocket sends it as `?key=`, since a
  browser can't set headers on an upgrade; the request log prints `key=…`,
  never the value. An artifact link — an `<img>`, a frame, a new tab —
  carries a **file token** instead (`fileToken`, `auth.ts`): the key
  attenuated to that one run's (or job's) files, reads only, signed by the
  API key (else `STRUT_SECRET_KEY`), minted by the listing (`GET
  /artifacts/:runId` → `token`) and accepted as `?t=` on that scope by the
  same gate (`carriesFileToken`); a `?t=` strut cannot vouch for is refused
  by the file routes even with the gate open, which is what lets a host's
  gate (mcp's `/lab`) hand such reads through. A served page can read its
  own URL, so the key itself must never be in one; the token is worth the
  files the page already shows.
  A subscriber's CATALOG token (`strut-catalog.…`, `POST /publisher/tokens`,
  plans/marketplace.md §12.1) opens two reads the same way, as `?t=`: the
  catalog this strut published and the archives it names. The PUBLIC
  catalog and the archives it names open to anyone as `?public=1`
  (`publicPackageRead`): the routes serve nothing but what that card lists.
- **Sessions — the browser without the key** (`auth.ts` "Sessions"). A
  strut whose UI faces the internet with no host in front should not keep
  the deployment key in a browser's storage: one long-lived bearer secret,
  no expiry, no revocation. Settings → Connection → **Sign in** posts it
  ONCE to `POST /auth/session { key, actor? }` — the login, the one route a
  stranger may POST (a wrong key is a 401 after half a second) — and gets
  back an HttpOnly, `SameSite=Lax`, `Secure`-on-https cookie holding `{
  actor?, exp }` signed under the file token's secret (`STRUT_API_KEY`,
  else `STRUT_SECRET_KEY`): stateless, no store, `STRUT_SESSION_HOURS`
  (12) long, and rotating the secret ends every session. The gate takes
  the cookie as the key (`carriesApiKey`, scope `full` — never more than
  the key: `/health` tells it everything, `/secrets` answers it), and the
  default `resolveActor` stamps the cookie's actor on what it launches and
  publishes — who signed in, with `x-strut-actor` beside it ignored.
  `GET /auth/session` says who is signed in; `DELETE /auth/session`
  clears the cookie (the token stays valid until its expiry; no browser
  holds it). The UI then sends no bearer header at all — `api.ts` keeps a
  marker of the session (who, until when) in `localStorage`, and a `401`
  with it set means the session ran out. `?key=` from a host and the
  pasted key ("Keep key in this browser") work as before; the dictation
  WebSocket's upgrade reads the cookie. **CSRF:** the browser attaches the
  cookie to every request to this origin, so a page elsewhere must not be
  able to spend it. `SameSite=Lax` keeps it off every cross-site
  subresource request and form POST; two rules hold beyond that (for a
  browser without SameSite, and for an untrusted page served from strut's
  own origin): a request that is not a read is honored only with
  `x-strut-ui: 1`, the header the UI sends on every call and no cross-site
  form can set; and a FILE read (`/artifacts/:runId…`, `/jobs/:id/files…`,
  a peer's through `/peers/<id>/…`) never opens on the cookie alone — the
  UI reads a peer's with the header, and its listing fetch carries the
  header and mints the `?t=` token every link carries, so a sandboxed
  artifact page (an opaque origin) cannot reach another run's files
  through the person's session. `createStrut.test.ts` ("a session") runs
  the whole flow; the route sweeps leave out the two open login routes.
  **A host signs one person in** (auth.ts "Sign-in tickets", specs/API.md
  §13.1) — the standalone twin of mcp's `/mint-token` JWT handed to
  `/lab/?key=`: the host's SERVER mints `POST /auth/ticket { actor, role? }`
  (full scope; the actor the host's to name, checked like `/peers/tokens`'
  — 120 chars, no line break; `role` `admin` | `member`, a member when left
  out, anything else 400) → `{ ticket, expiresAt }`,
  `strut-ticket.<claims>.<hmac>` with `{ actor, role, exp, jti }` signed like a
  session, 60 s, good ONCE (redeemed `jti`s kept in memory until they
  expire), and frames `<strut>/?ticket=…`. The UI trades it at `POST
  /auth/session { ticket }` before any other request (`api.ts`
  `ticketSignIn`; main.tsx renders nothing until it is answered), takes
  `ticket` off the address bar keeping every other param as written
  (`web/src/ticket.ts`), and is that person's session — the same cookie
  the key login sets. The ticket wins over a key or session the browser
  held; refused, or once that session ends, the page says to reload from
  the host, never the key prompt. **Same site only:** `SameSite=Lax` (kept)
  sends the cookie to a framed page only when strut and its framer are
  same-site — `strut.acme.com` in `acme.com`; framed by another site, no
  cookie is stored and the next request is a 401.
  **Admins run the box, members use apps** (plans/member-rights.md;
  specs/API.md §13.1 "Admins and members"). The session keeps the
  ticket's `role` (`GET /auth/session` says it; the key login has none).
  An admin's session is the key's equal, as before. A MEMBER's is not:
  `carriesApiKey` / `apiKeyMatches` do not count it (so no route's own
  key check and not the dictation socket), its scope is `member`
  (`scopeFromKey`; createStrut's `memberOnly` decides it before a host's
  `resolveScope`), and the gate passes it only `MEMBER_ROUTES` — what
  strut's page calls to show an app alone: `GET /auth/session`, `GET
  /apps`, `/apps/:name/versions`, `/apps/:name/:version/files[/…]`, `GET
  /brand`, `/mcp` (`step_run` alone, as `personAppHandler` serves a
  person token; GET / DELETE its 405), `POST
  /apps/:name/channel-ticket`, `GET /artifacts/:runId[/…]` and `GET
  /jobs/:id/files[/…]`. Everything else is 403, reads and a host's later
  routes included; `createStrut.test.ts` ("a member's session") sweeps
  them and counts the allowed. The UI asks `GET /auth/session` before it
  renders (`api.pageSession`) and picks the page (`web/src/page.ts`
  `pickPage`): a member gets their apps (`MemberApps.tsx`, Jamie first,
  each `?app=<name>&solo=1`), never the shell. Not a sandbox: a member
  reaches the builder through Jamie.
- **Scope — what another strut may do** (plans/federation.md §3). Past the
  credential, the gate asks `createStrut({ resolveScope(c) })` — the twin of
  `resolveActor`, the host's call (mcp maps its JWT's scope) — whether the
  request is `full` or `peer` (or `member`, above). The default (`scopeFromKey`) says `peer` for
  a request carrying `STRUT_PEER_KEY`, the key a peer record on another
  strut holds for this one. A `peer` may read every route (`GET`/`HEAD`;
  `requireApiKey` lets the peer key read too), launch a run (`POST
  /workflows/:name[/:version]/run` — stamped `origin: "peer"` on
  `run.start`, its `x-strut-actor` honored) and cancel / pause / resume a
  run a peer launched — the control routes read the stamp, or for a run
  just launched, a mark on its controller. Anything else is `403`, a route
  a host mounts later included; `createStrut.test.ts` sweeps the routes
  with the peer key like it does without one. **What a peer may launch**
  (2026-10-20; before it, any workflow, with any `params`): only a workflow
  whose YAML says `peer: true` at the top (`Flow.peer`, content in the
  version hash like `sealed:`; the version launched must say it, and a
  peer's durable resume runs only into one that does), AS PUBLISHED — a
  peer launch carrying `params`, `paramOverrides`, `runId` or `settings`
  is `403`, because an override is how a peer would hand `explore`'s
  agent `bash` (or turn off the author's `privacy` setting)
  — and in a namespace of its own (`PEER_NAMESPACE`, `peer/`,
  session-store.ts): its `job` is kept as `peer/<job>` (createStrut's
  `peerLaunchBody`), and every agent session its run opens as
  `peer/<id>` (runner.ts `bindPeer`, a per-run `sessions` view like
  `bindPrincipal`'s), so a name a peer chooses never opens a local job's
  directory, files and holds, or a local thread — the job agent's is its
  job id. The meta surface may not publish `peer: true` (a person opens a
  workflow to other struts). `peer: true` is the AUTHOR vouching for
  everything the workflow can reach given any input: a run it launches
  (`meta/run-workflow`, `job/*`) is a local run with local names, and an
  agent it grants `bash` is a shell for the peer.
  **A person's credential** (plans/chained-orchestrators.md §2, ruled
  2026-10-22): the peer key's actor is a header any strut sets, so strut
  could not tell a person from a strut. A third scope, `peer:person`, is a
  peer request whose actor is its CREDENTIAL's own subject: a person token
  (`POST /peers/tokens`, auth.ts — the peer key attenuated to one actor,
  signed like a session, Bearer only) by default, or whatever the host's
  `resolveScope` maps (mcp: a `lab:peer` JWT with a `sub`). It may do what
  a `peer` may (`isPeerScope`), and three things more: launch a workflow
  whose YAML says `peer: person` (a keyword, never a user name — the
  `orchestrator` says it: through `job/start` it starts a job with bash,
  which a person may do through their host anyway and a strut must not),
  open its actor's own sessions as they are (`<actor>`, `<actor>/…`:
  `peerSessionId`, session-store.ts, in `bindPeer` and the projector; the
  run records `peerPerson: true` on `run.start`, and only the same
  person's credential resumes it) and any CONVERSATION it took a turn in,
  or a shared one, under whatever id it has (plans/jamie-app.md §2.2:
  `continuesFor` asks the index at launch, the run records `continues:
  <id>`; another person's is a 403, `conversation_not_yours:`), join its actor's room
  (plans/chained-orchestrators.md §3), and POST `/mcp`, where it gets an
  app's `step_run` and nothing else, run as its actor under the app's
  grants (plans/apps.md §7.4: a person's own strut hosting a peer's app;
  a run the page launches is the app's, `origin: "app"`, whatever the
  workflow's YAML says about peers). It may also POST `/voice/calls`
  (`src/voice.ts`, plans/private-voice.md §4.1): the body forwarded as it
  came to the voice service beside strut, as its actor, the answer back as
  it came, nothing of either logged or kept (the deployment key with
  `x-strut-actor` may too; the plain peer key may not). Its `job` is still
  `peer/<job>`.

The same secret authenticates **both directions** within a deployment:

1. Mcp → strut: registers steps with `Authorization: Bearer $STRUT_API_KEY`.
2. Step files inside strut → mcp: read `process.env.STRUT_API_KEY` and send
   it on callbacks to `mcp/gitree/cmd` (mcp validates the same value).

This is sufficient when both services live in the same trust domain
(same compose, same private network). Per-publisher keys can be added
later without breaking this contract — they'd be additive env vars
(`STRUT_API_KEY_<NAMESPACE>`) checked in addition to the shared key.

## Secrets

Steps reach credentials through one boundary — `ctx.services.secrets.get("NAME")`
— never `process.env` directly. That boundary is backed by a **deployment-scoped
secret store** (`src/secret-store.ts`) so credentials can be managed from the UI
instead of baked into env at deploy time.

- **The boundary is enforced, in stages** (`src/env.ts`, `src/step-lint.ts`,
  `src/steps/registry.ts`). A step is TypeScript in the server process,
  so "never `process.env`" was a convention until 2026-10-19: any step — in-tree,
  custom, or installed — could read the server's env (STRUT_SECRET_KEY, the
  key to every encrypted store, among it) or spawn a child with it. Now (1)
  strut's own code reads the env only through `bootEnv()` (a test fails on
  any other `process.env[…]` read under src/), and the default server's entry
  scrubs `process.env` down to the shell allowlist at boot — the snapshot
  behind `bootEnv()` still feeds the secrets capability's env fallback, so a
  key set in env resolves as before, and a step or its child sees nothing
  (`STRUT_ENV_SCRUB`, `STRUT_ENV_KEEP`); (2) the builder's `create_step` /
  `edit_step` refuse a source that imports `child_process` / `fs` / `net` /
  `http`, reads `process.env` or calls the global `fetch`, naming the line and
  the `ctx.services` door to use, `POST /steps` publishes it with `warnings`,
  and the registry warns at load time for any workspace step on disk that
  does, whoever put it there — warn-only, the place a later strut refuses. A host that embeds
  strut (mcp's lab, whose gitsee/harvey steps still read env and spawn) is
  untouched until it calls `scrubProcessEnv()` itself. Not isolation: a step
  that legitimately holds a value can still send it anywhere; a credential
  by NAME on the `http` capability is the later piece.

- **Store:** `SecretStore` interface (parallel to `RunStore`/`ChatStore`).
  Default `FileSecretStore` persists `<workspace>/secrets.json`, **encrypted at
  rest** (AES-256-GCM, key derived from `STRUT_SECRET_KEY`). `MemorySecretStore`
  for tests / in-memory deployments. The default `secrets` capability reads the
  store first, then falls back to `process.env` (so existing env-provided keys
  keep working). Injectable via `createStrut({ secretStore })`.

- **Scope is deployment-global**, NOT per-user — matching the `STRUT_API_KEY`
  single-trust-domain model. (Per-user secrets would need an identity model strut
  doesn't have.)

- **Endpoints** (gated by `STRUT_API_KEY`, permissive in dev): `GET /secrets`
  returns **names + metadata only — never values** (write-only credentials);
  `PUT /secrets/:name { value }` creates/overwrites; `DELETE /secrets/:name`.
  If the consumer injects their own `services.secrets`, these return **501**
  (strut doesn't own that store).

- **UI:** the topbar **Secrets** button opens `SecretsDialog` — list (names +
  "updated" date), add (name + value, value can be multi-line e.g. a
  service-account JSON), delete. The stored value is never sent back to the
  browser.

- **`STRUT_SECRET_KEY`:** set it in production. Unset → values are encrypted with
  a fixed dev key and a one-time warning logs (obfuscation, not real security).

- **A person fills a blank from Jamie** (plans/member-rights.md "Adding a
  secret"). The builder JOB names a secret it needs in its reply's
  `ask.secret`; strut's own app shows a password box under the question and
  stores the value with `secret/add` — a name with no value in the store or
  the environment, never one that has one — then sends the job
  `[secret] NAME stored`. Members and admins alike; nobody needs the
  console for it. The value reaches no model, run log, transcript or
  answer (`StepDef.redact`).

- **AI builder access:** the chat agent has a read-only `list_secrets` tool
  (names + metadata only — never values) so it can reference existing
  credentials when authoring steps and prompt the user to add missing ones. It
  has no write access; adding/removing secrets stays a human action.

- **Actor secrets — a PERSON's credential, not the deployment's**
  (`src/actor-secrets.ts`, plans/code-change.md §3.2). A host that knows who
  a run is for (hive: the user's GitHub token) pushes it per actor —
  `PUT /actors/:actor/secrets/:name { value }`, `DELETE …`, `GET
  /actors/:actor/secrets` (names + timestamps; all behind `requireApiKey`,
  501 when `secrets` was injected) — into a THIRD encrypted file,
  `actor-secrets.json`, beside `secrets.json` (the default follows the
  deployment secret store's kind, not the workspace's, so a graph-backed
  host with file secrets keeps them across restarts; `createStrut({
  actorSecretStore })` overrides). Steps see nothing new: the runner binds the run's
  `ctx.services.secrets` to its **principal** once per run
  (`SecretsCapability.forPrincipal`; a shallow per-run view, the shared bag
  is never mutated), so `secrets.get("GITHUB_TOKEN")` resolves that actor's
  value first, then the deployment's, then env — for the `secretsEnv` of
  `agent`/`exec`, every lib step's `cfg.token ?? secrets.get(NAME)`, and
  cassette scrubbing alike. An automation runs as the owner and reads the
  owner's; the builder's runs read the chat actor's; an `agentTools` step
  reads the run's. Never listed by `GET /secrets`, the Secrets dialog or
  `list_secrets`. A run's `input` is persisted on `run.start`, so this is
  how a per-user credential reaches a workflow without ever being in it.

- **Reach — what the AI may publish** (`src/reach.ts`, stakwork/peel
  `docs/connectors-and-authoring.md` §6). Opt-in: a host sets
  `createStrut({ builder: { reach: { tools, builtins, secrets } } })` (or
  `builder.reach` in STRUT_HOST_CONFIG); without one nothing changes. With
  one, the meta surface publishes WORKFLOWS only — `create_step` /
  `edit_step` are refused, since step code runs in this process past any
  scope — and refuses a workflow whose closure names a step outside `tools`
  (globs; control flow, `agent` and `llm` are always in), `exec` or an agent
  built-in outside `builtins` (an agent must list its built-ins in
  `toolFilter`), or a secret outside `secrets` (`secretsEnv`, a
  `tokenSecret` or `storageStateSecret` — a default too — `http/verify`'s
  `{NAME}` header templates, or one named by a template); `meta/run-step`
  refuses a step outside it. The same rule (`stepProblems`) holds at RUN
  time for every step inside a workflow the AI published or a
  `meta/run-step` run (`ctx.aiAuthored`, kept by a subflow, inherited by an
  agent's tool calls and a proposal's apply), as resolved — what a model
  passes a tool, a workflow stamped `ai` before the host set a reach, a
  person's subflow changed since — and the launcher's MCP servers are
  dropped there. The model key the `agent` / `llm` steps read is strut's
  own and unaffected. A step in `tools` that launches a run (`run/launch`,
  `job/start`) hands that run out of reach: the host decides. A new config
  field that names a secret goes in `secretNamesIn`. Not covered: the chat
  builder (HTTP, the API key's holder), whose `create_workflow` publishes
  unstamped.

- **No OAuth.** This is a paste-a-key / service-account store by design. For
  Google Drive, paste a **service-account JSON** as `GOOGLE_SERVICE_ACCOUNT_JSON`
  (no expiry, no refresh) — far simpler than an OAuth flow for a server-side
  engine. If interactive per-end-user OAuth is ever needed, the **host app**
  (mcp) should own the OAuth dance and deposit/refresh tokens *into* this store;
  strut's `secrets` capability stays generic and provider-agnostic.

## Moving a data folder

A stopped strut's data folder can be copied to another host (Peel moving
the brain to a home server and back; peel `docs/always-on.md`). The new
host must get the same `STRUT_SECRET_KEY`: the encrypted files copy as
they are. Whoever copies it leaves `moved.json` at the folder's root, and
the default server's next boot (`src/server.ts`, before any store opens)
applies it and removes it (`src/moved.ts`):

```json
{
  "from": "/Users/tom/Library/Application Support/Peel/Strut/workspace",
  "bridge": {
    "from": { "url": "http://127.0.0.1:54321", "token": "<old token>" },
    "to":   { "url": "http://127.0.0.1:8090",  "token": "<new token>" }
  },
  "secrets": { "PEEL_BRIDGE_PORT": "8090", "PEEL_BRIDGE_TOKEN": "<new token>" }
}
```

Every field is optional. `from` (the folder's absolute path on the old
host): the upload and run-attachment paths (`<from>/uploads/…`,
`<from>/artifacts/…`) in `chats/*/messages.jsonl` and
`sessions/*/messages.jsonl` move onto this folder's path; run history is
left alone. `bridge`: every stored callback
that starts with `from.url` — automations' run.end URLs
(`automation-callbacks.json`), runs' `callback.json` / `job-callback.json`
/ `mcp.json`, `jobs/.callbacks/` — moves onto `to.url`, with `from.token`
in it becoming `to.token`; leave it out when the new host's bridge is not
up yet and the host points them itself (Peel does at every bridge start).
`secrets`: set (a string) or delete (`null`) deployment secrets through the
secret store. Rebuilt or machine-bound parts are dropped (`DROP` in
moved.ts: `steps/_graph*`, graph and memory snapshots and backups,
`audio/tmp`, `audio/dictation.json`, `repos`, `worktrees`,
`privacy/vault`, `acp/sessions`, temp and corrupt files,
`fs-workspace.imported-*`), and so are each job's checkouts — worktrees of
the dropped `repos/`, found by the job record's `repos` — which the record
then forgets; the job's own files (a plan, screenshots, deliverables)
stay. Every step is idempotent and the file goes only
once all of it is done, so a boot cut short does the move again. A
`moved.json` that does not parse fails the boot.

## Moving strut to another host

`strut move` (`src/move/`) copies a STOPPED strut to another host and back:
its data folder, its host config, named sidecars (opaque folders another
program owns, e.g. Peel's bridge) and env values, sealed with a pairing
code. The same code runs on both ends. A client stops its own processes
and runs it beside the server, never inside it:

| Where | How a client runs it |
|---|---|
| desktop package | `node desktop.js move …` (Peel; desktop.js's defaults apply, `--data` defaults to STRUT_WORKSPACE) |
| image or checkout | `node build/move/cli.js …` (an empty box's setup service: `… serve`) |

```
strut move check <link>
strut move send  <link> [folders] [--bridge <url>]
strut move serve        [folders] [--bridge <url>] [--set-secret N=V]... [--send-back]
                        [--listen [host:]port] [--host <h[:port]>] [--link <prefix>] [--name <n>]
strut move fetch <link> [folders] [--bridge <url>] [--set-secret N=V]...

folders: --data <dir> --host-config <file> --sidecar <name>=<path>... --env <file>
         --sidecar-env <name>=<file>... --state <dir>
```

- **Folders** are read when packing and written when unpacking, so both
  ends name theirs the same way. `--env` holds strut's own values
  (`KEY=value`; when sending, `<name>.KEY` is a sidecar's); strut's host
  settings (`STRUT_API_KEY`, ports, paths) never move. Received env files are
  written as `KEY='value'` (a shell or Compose `env_file` reads them), last,
  after the folders are in place. Not `--env-file`: node takes that flag
  for itself even after the script name. A host's sidecars must be the
  move's exactly, or the move is refused.
- **`serve`** on an empty data folder shows a page (link, code, QR) and
  takes one move, then exits 0 (`{"event":"received"}`); with `--send-back`
  it packs this host's folders under a fresh code, serves them until the
  other end confirms, sets them aside in `<data's parent>/sent-<time>/`
  and exits (`"sent"`). With strut already here and no `--send-back` it
  exits at once (`"already-here"`). The receive code is kept in `--state`
  (default `<data's parent>/.move`) until a move lands.
- **`moved.json` on arrival** (see "Moving a data folder"): `from` is the
  manifest's data path, `bridge` is the manifest's callbacks → this host's
  `--bridge` (its token in `STRUT_MOVE_BRIDGE_TOKEN`), `secrets` are the
  `--set-secret` values with `{bridge.url}`, `{bridge.port}`,
  `{bridge.token}` filled in. Peel: `--set-secret PEEL_BRIDGE_PORT={bridge.port}
  --set-secret PEEL_BRIDGE_TOKEN={bridge.token}`. On the sending side a
  `moved.json` not yet applied is applied before packing, and the
  workspace graph's WAL is folded into its file (opened and closed with
  this host's extensions): Ladybug logs each `LOAD EXTENSION` with its
  absolute path in the WAL and replays it on open, so a graph that travels
  with a WAL fails on any host without that path. `build/server.js` closes
  the graph on SIGTERM for the same reason, as desktop.js does.
- **Arrival is all or nothing**: the move is unpacked into `--state`,
  checked, then put in place; a step that fails (a folder it cannot
  write) takes back the ones before it, and `serve` keeps waiting. An
  empty target folder is filled rather than replaced, so it may be a mount
  point.
- **`check`** refuses another move format, another strut (`STRUT_VERSION`:
  the commit, which the image (`publish-image.yml`) and the desktop package
  (`desktop.json`'s `strut`) both stamp; a plain checkout reports
  package.json's version, so set it there to move to or from one) or
  another Ladybug core, and a wrong code. `send` and `fetch` check first.
- **The link**: plain `http://<host>/?code=<code>` (the page), or
  `<prefix>?host=<host>&code=<code>` with `--link <prefix>`
  (`STRUT_MOVE_LINK`; Peel: `peel://home-setup`). `--host` /
  `STRUT_MOVE_HOST` is the address it names; else the request's, or the
  first LAN address. `--listen` / `STRUT_MOVE_LISTEN` defaults to 8090.
- **stdout** is one JSON line per result (`ready` with `link`, `code`,
  `port`; `checked`; `sent`; `fetched`; `received`; `error`); words and the
  QR go to stderr. Exit 0 done, 1 refused or failed, 2 usage.
- **A peer record after the move**: `send --peer-actor <actor>` asks for
  one (the upload's `x-strut-move-peer` header); a `serve` given
  `--peer-url` (`STRUT_MOVE_PEER_URL`, e.g. `https://{host}:8443`, `{host}`
  the address the move came in on) answers the upload with `peer: { baseUrl,
  token, actor, exp, ca?, servername? }`, and the `sent` line carries it. The token is a
  person token (see "Auth") for that actor, living `--peer-days` (365),
  signed as the arriving strut signs: serve's `STRUT_API_KEY`, else its
  `STRUT_SECRET_KEY`, else the secret key the move carried. So run serve
  with the box strut's own `STRUT_API_KEY`. `ca` is `--peer-ca`'s PEM
  (`STRUT_MOVE_PEER_CA`), left out when the file is missing; with it,
  `servername` is `--peer-servername` (`STRUT_MOVE_PEER_SERVERNAME`), the
  name the box's certificate is issued for (a fixed name, so it stays valid
  when the box's address changes). The sender puts it on file with
  `PUT /peers/<id> { baseUrl, token, ca, servername }`. A host with no
  `--peer-url` answers `peer: { error }`.

HTTP (plain, home network only, everything that matters sealed):

| Request | Mode | |
|---|---|---|
| `GET /move/info` | both | `{ mode: "receive" \| "send-back", format: 1, strut, graph, ready? }` |
| `POST /move/check` | both | `{ salt: <32 hex>, token: <64 hex> }`, token = HKDF(code, salt, `strut move v1 check`): 200, or 401 |
| `PUT /move` | receive | the sealed move: 200 once in place; 401 wrong code; 400 not a move, bad archive, sidecars that don't match; 409 busy or already here |
| `GET /move` | send-back | the sealed move (`Range: bytes=a-[b]` resumes) |
| `POST /move/received` | send-back | `Authorization: Bearer <HKDF(code, the move's salt, "strut move v1 received")>`: 200 and this host's copy is set aside |

**The format.** Sealed: `STRUTMOV`, version `0x01`, a 16-byte salt, the
chunk size (u32 BE, 1 MiB written, 64 KiB–16 MiB read), then AES-256-GCM
chunks under HKDF-SHA256(code, salt, `strut move v1`); chunk *i*'s
nonce is `[final,0,0,0] ‖ i` (u64 BE), its AAD the header, written as
ciphertext ‖ tag; the last chunk is final. The code is 20 Crockford base32
characters (shown `XXXX-XXXX-…`, typed with dashes or not). The
construction is peel's first draft's; the constants are strut's, and the
test vector in `src/move/move.test.ts` is what a client's implementation
checks itself against.
Inside, a gzip-compressed ustar of regular files (`src/tar.ts`):
`move.json` (`{ format: "strut-move", version: 1, strut, graph, created,
from, hostConfig, sidecars, callbacks? }`), `env.json` (`{ strut, sidecars:
{ <name>: {…} } }`), `host-config.json`, `data/…` (minus `leftBehindIn` in
moved.ts: what arrival drops, temp files, jobs' checkouts) and
`sidecars/<name>[/…]`. Empty folders do not move.

## Home sync

Two normal struts share one memory: a home box (the one writer) and a
strut that keeps a read copy of it (a Mac's, for dictation; peel
`docs/always-on.md`). The copy pushes what it changed, then pulls, with a
person token (`strut move` hands one over, above). The box runs with
`STRUT_HOME_SYNC=box`, which opens two routes to a person's credential
only: the plain peer key and the deployment key are refused, and so is a
request with no credential on a box with no `STRUT_API_KEY`:

| Route | Body | Reply |
|---|---|---|
| `POST /home/push` | one key per kind of change; today `{ dictation? }`, `dictation/changes-since`'s `changes` (at most 10 000) | `{ dictation: { applied: [{ op, heard?, written, result }] } }` |
| `POST /home/pull` | `{ hash? }`, the `content_hash` of the copy the caller holds | `{ unchanged: true, content_hash }`, else `memory/export`'s inline reply (`data`, `content_hash`, …) for `memory/import { replace: true }` |

On a box whose memory is the graph (`memory: "graph"`), `/home/pull` carries
dictation's vocabulary alone: `{ content_hash, dictation }`,
`dictation/changes-since`'s changes since the copy's last pull, which
`home/sync` on a graph copy replays with `dictation/apply-changes`. Its
`content_hash` is a cursor (`graph-dictation:<until>`) that the copy sends
back as `hash`; any other hash pulls the whole vocabulary, which the copy
skips as known. What it replays is pushed back once, and the box skips it as
known. The rest of the graph is not pulled, and a graph copy refuses a
whole-memory snapshot (`src/steps/lib/home/_graph-pull.ts`).

Routes, not workflows: a run's input and output stay in the run store,
which every peer scope may read, so a whole-memory export there would
outlive the pull and reach other credentials. A route answers its caller
(`cache-control: no-store`) and keeps nothing.

- **`dictation/changes-since { since? }`** reads the changes from the graph
  itself, no outbox: mishearing facts `created_by: "dictation"` (and terms,
  dictation-type entities with none) created from `since` up to `until`,
  and those forgotten with reason `undone` in that span. Each is keyed by
  its pair (`heard`, `written`, and `name` when `written` is another form
  of that entity), never a ref_id. It returns `until`, the next call's
  `since`, and reads in the writes' queue: a write stamps its time before
  it commits, so a read beside one would miss it for good. A learn later
  undone says so (`undone: true`); one later forgotten for another reason
  (`dictation/remove`) is left out.
- **`dictation/apply-changes { changes }`** replays them in order through
  `dictation/add` (which takes `name` and `term` for this) and
  `dictation/undo`, matching an undo by its pair (the entity, when
  dictation made it and the pair is all that is known of it). Idempotent:
  `known`, `already undone`, `not found` and `not dictation's` are reported,
  not errors. A learn marked `undone` of a pair already undone here is
  `already undone` and writes nothing: learned again it would be undone
  again, a new entity each time the batch is sent. One not marked (added
  again by hand after an undo) is learned.
- **The copy's side: `home-sync { peer? }`**, seeded by
  `STRUT_HOME_SYNC=copy`; one step, `home/sync`, so neither the changes nor
  the memory pass through a run's journal (its output is a summary:
  `{ pushed, pulled, hash, counts?, backup?, kept }`). The home is a peer
  on file (default `home`) whose token is a person token. It reads the
  last sync (`home/state`: `since`, `hash`, kept in
  `<dataDir>/home-sync.json`), sends `dictation/changes-since`'s changes to
  `/home/push`, then asks `/home/pull` with its hash; a changed memory is
  loaded with `memory/import`'s replace (backed up, put back on failure).
  Only then does it record the new hash and `since`: the push's `until`,
  or, when it pulled, the `until` of its read inside the import's lock
  (below), so the home's copies of what it pushed, stamped when the home
  applied them, are not pushed back by the next sync.
  A sync that fails (away from home, a push refused) records nothing; the
  next one pushes the same changes again (idempotent) and catches up. Run
  it on a timer, on wake, after a correction.
- **Dictation while it syncs**: `home/sync` reads the push's changes in
  the writes' queue, as `dictation/changes-since` does. Then, inside the
  memory lock (`memoryExclusive`, which `memory/import` holds too), it
  reads what dictation changed from the push's `until` on from the old
  graph (kept in `home-sync.json` as `pending` until replayed), replaces the graph,
  and replays those changes onto the new one (`kept`), so the next push
  carries them. A write that arrives meanwhile waits for the lock; a
  transcription that reads the vocabulary mid-import gets no rewrite for
  that utterance (audio/routes.ts falls back to the plain text).
- **A new kind** (one that exists, not before): a `<kind>/changes-since`
  and `<kind>/apply-changes` pair, a key on `/home/push`, and its changes
  read and sent in `home/sync`.

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
topbar's cap chip) is the run's cap when routed; nothing else reads it.

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
workspace: ask an admin". Every provider asks the hook, Maple and Numes
included (`src/llm.ts` `resolveModel`): aieo sends a grant's call to the
gateway's route for that provider, and Maple, Numes and a provider only
the gateway has (`modelProvider`) ride its OpenAI-compatible route as
`<provider>/<id>`.
A routed call (`ResolvedModel.routed`: the grant carried a `baseUrl`) never
uses Anthropic's server-executed web tools — `createWebTools` hands out
aieo's Exa + HTTP shims instead, because Bifrost drops `server_tool_use.input`
on the request path (2026-09-24, swarm38: every builder turn that searched
and then called a tool died with `…server_tool_use.input: Field required`).
So a swarm behind the gateway needs `EXA_API_KEY` for `web_search`; without
it the builder and the agent step have `web_fetch` only.

## Lib step credentials

Lib steps read credentials through the secrets capability, with explicit step
config taking precedence:

```ts
const token = cfg.token ?? (await ctx?.services?.secrets?.get("GITHUB_TOKEN"));
```

- **`cfg.<field>` wins** (a workflow can pass a token via `{{ input.x }}`),
  otherwise fall through to the managed secret store / env.
- Type `ctx` as `StepContext<StrutCapabilities>` (import both from the relative
  `core.js` / `capabilities.js`) so `ctx.services.secrets` is typed. Use
  optional chaining — a bare `runWorkflow` without a services bag has no
  `secrets`.
- This also gets the step **cassette scrubbing for free**: every value read
  through `secrets.get()` is scrubbed from recorded fixtures.
- `github/fetch-pr` / `github/create-pr` (`GITHUB_TOKEN`) and `gdrive/export-file`
  (`GOOGLE_ACCESS_TOKEN` or `GOOGLE_SERVICE_ACCOUNT_JSON`) are the reference
  examples. The `git/*` steps take it one step further: no `token` config at
  all, only `tokenSecret` (a NAME, default `GITHUB_TOKEN`) — a step's config
  is recorded on `step.start`, so only a name may ride in a workflow.
- The `sheets/*` steps read `cfg.serviceAccount ?? secrets.get("GOOGLE_SERVICE_ACCOUNT_JSON")`
  (the gdrive/* secret) and `cfg.driveFolderId ?? secrets.get("GOOGLE_DRIVE_FOLDER_ID")`.
  Their missing- or invalid-credential error is written for the CALLING AGENT:
  sheets are unavailable here, do not search for keys, go on without them.
  Never "paste the key into env": that wording sent an agent searching the
  filesystem for service-account JSON.

## Artifacts (per-run files)

`ctx.services.artifacts` (`ArtifactsCapability`, `capabilities.ts`) is per-run
file storage for the files a run produces that later steps — and humans —
reference. Backed by `fileArtifactsCapability` rooted at
`<workspace>/artifacts/<runId>/`, auto-injected by `createStrut` (a consumer
services bag can override it, same as `http`/`secrets`).

- **Convention:** a step writes a file (`write(ctx.runId, relPath, content)`)
  and puts the RELATIVE path in its output; downstream steps resolve it via
  `read`/`dir`. Enforced from 2026-10-30: a step output over
  `STRUT_STEP_OUTPUT_MAX_BYTES` (8 MB as JSON) fails the step with this
  convention in its error (`src/output-cap.ts`). Point an `agent` step's `cwd` at `dir(ctx.runId)` and the
  built-in file tools (`str_replace_based_edit_tool`, `bash`) see the same
  files — that's how agents in a workflow hand files to each other.
- **Isolation:** paths are guarded per run — a relPath cannot escape its
  run's directory (so one run can't reach another's files). Invalid runIds
  (path separators, `..`) are rejected.
- **Retention:** artifacts survive the run (they're part of its record);
  `onRunEnd` does not touch them.
- **HTTP:** `GET /artifacts/:runId` lists (recursive relative paths) and
  mints the run's **file token** (`token`, when there is a secret to sign
  it: `STRUT_API_KEY`, else `STRUT_SECRET_KEY` — never its dev default);
  `GET /artifacts/:runId/<path>` serves the file (minimal content-type map).
  Read-only — steps are the only writers. Behind the key like every route,
  or behind the token: a read of the listing or any file under it with
  `?t=<token>` opens (`carriesFileToken` in the gate), which is what the
  UI's links carry — a browser cannot set a header on an `<a>`, an `<img>`
  or a frame, and the key must never ride in a URL a served page can read.
  The token is an HMAC of the scope under the secret (`fileToken`,
  `auth.ts`): no store, rotates with it, worth exactly that run's files. The
  UI fetches it once per run (`web/src/use-artifact-url.ts`); when the
  listing minted none (a strut with no secret behind a host's gate that
  takes its credential as `?key=`) the link carries the key as it used to.
  `/jobs/:id/files` is the same for a job. **A `?t=` strut cannot vouch for
  is refused by every file route whatever the gate's mode**
  (`carriesBadFileToken`), so a host gate in front of an open strut (mcp's
  `/lab`, which derives `STRUT_SECRET_KEY` from its `API_TOKEN`) hands a
  token-bearing file read straight through and strut judges it.
- **An artifact is untrusted content on strut's own origin** — a step or an
  agent wrote it, and the UI keeps the API key in that origin's storage. So
  the file route answers with `Content-Security-Policy: sandbox` and
  `X-Content-Type-Options: nosniff` (`artifactHeaders` in `createStrut.ts`):
  opened as a document — the "Open in new tab" link, a pasted URL, a frame
  — it gets an opaque origin, so it cannot read the UI's storage, navigate
  the top window, open a popup, submit a form, or send its URL as a
  referrer. An `.html` file read by its file token also gets
  `allow-scripts` (the viewer's frame is `sandbox="allow-scripts"` too), so
  a page an agent built runs — a script can read its own URL, and all it
  finds there is that token. Read any other way — the key as `?key=`, a
  host's own credential in the URL — it runs no script: strut cannot know
  what else that URL holds. Never add `allow-same-origin`: that would hand
  the page the storage.
  Everything else runs no script (an `.svg` opened as a document could).
  Sandboxed unless exempt, so a type added to the map is covered; the one
  exemption is `video/*` and `audio/*`, which cannot script and whose
  player, in a tab of its own, cannot load the file from an opaque origin.
  `Access-Control-Allow-Origin: *` on the file route lets a page `fetch` a
  sibling file (its data) from its opaque origin — the token gates the read,
  not the origin. The header only applies to a document, not to an `<img>`
  / `<video>` / `fetch`.

## Shell (subprocesses)

`ctx.services.shell` (`ShellCapability`, `capabilities.ts`) runs a program and
returns a plain `{ code, signal, stdout, stderr, truncated, timedOut,
durationMs }`. It is the sanctioned way for a step to shell out — the `exec`
core step is a thin wrapper, and a custom step wrapping a CLI should call it
rather than `child_process` (same reasons as `http`: cassette-recordable,
and the child env is scrubbed by construction).

- **`exec` step:** `cmd` + `args`, no shell (templated values are never
  re-parsed; `cmd: bash, args: ["-c", …]` for a pipeline). `script` writes
  inline source into the working dir and appends its path — `cmd: uv,
  args: [run]` + a PEP 723 header is how a workflow runs Python with
  dependencies installed on the fly (uv caches the env; no Dockerfile edit).
  `cwd` defaults to the run's artifact dir so files flow between exec/agent
  steps by relative path. `stdin` pipes a string or JSON in; `parseJson`
  parses stdout. Non-zero exit throws (retry/onError apply) unless
  `allowFailure`.
- **Secrets:** `secretsEnv` (same contract as the agent step's) resolves
  names via `ctx.services.secrets` into the child env only, and masks the
  values out of stdout/stderr. Missing names throw — a deterministic step
  can't degrade gracefully the way an agent can.
- **Cancel:** the step polls `ctx.control.state` while the child runs and
  SIGTERMs the process group (SIGKILL 2s later) when the run starts
  cancelling, then `checkpoint()` raises the canonical `CancelledError`.
  Timeout (default 10 min) is SIGKILL. A process the command left running
  in its group (a server it put in the background) is killed when the run
  ends (`runProcess`'s `onLeftover` → `ctx.onRunEnd` → `killGroups`).
- **Output:** each stream is capped (default 500k chars) keeping head + tail,
  so a JSON result and the error that ended a build both survive; the child
  is NOT killed for being chatty. Big results belong in artifact files.
- **Environment ≠ step:** what's on PATH (python, ffmpeg, yt-dlp) is the
  deployment's business — the Dockerfile / `env.manifest` (EVOLVE_SPEC §4)
  on servers, the host's PATH on desktop. The step just spawns.

## Browser

`ctx.services.browser` (`BrowserService`, `src/browser/service.ts`) is the
browser the `browser/*` lib steps drive — every Playwright call is one step,
the same steps are an agent's tools (`agentTools: ["browser/*"]`), and
`browser-capture` / `browser-explore` / `browser-watch` (seeded at boot,
`src/browser/seed.ts`) show the declared and the explored way through a site;
`browser-captcha` is the fourth.

- **Built by `createStrut`** from `BROWSER_*` (`BrowserService.fromEnv()`)
  unless the services bag already has a `browser` — a host's own wins, and
  its teardown is the host's. Building touches nothing: the first step that
  opens a page connects. A bad value is a boot warning (the steps then fail
  naming the missing service), never a failed boot.
- **Per run:** one context + page per `runId` (a subflow and an agent's tool
  calls share the run's), closed by the run-end teardown (`dispose`, chained
  into `services.onRunEnd`); `strut.close()` drops the connection.
- **Kept pages — the job's, not a run's:** `browser/keep { session }` moves
  the run's page onto its job, `browser/open { session }` opens it again in
  a later run (`resumed: true`, where it was; `url` only on a new page). A
  run attached to one reaches it with every verb, and its end only lets go.
  The job holds it (`browser:<session>`, released by `browser/close {
  session }` when the job is deleted or swept); it closes after
  `BROWSER_SESSION_IDLE_MS` idle or a call timing out, the hold going with
  it. What a person must act on between turns lives here.
- **Captchas a PERSON solves** (hive's captcha card): browser-explore keeps
  the page and stops; the job runs `browser-captcha { session }`, which
  crops the challenge and writes `shots/captcha-<round>.json` beside its
  crop in code (`src/browser/captcha.ts`, to hive's `parseCaptchaManifest`:
  a bare image name, the page's host as `site`); the job lists it as
  `{ id: "captcha", kind: "captcha", path }` and ends its turn with `ask`.
  The answer comes back as `[captcha-answer] { round, site, taps | text |
  skip }` (taps: fractions of the crop) → `browser-captcha { session,
  answer }` taps it (`browser/tap`, the same element) and verifies →
  solved → `browser-explore { session }` goes on. Never solved by a model.
- **Version lock:** `playwright-core` is pinned to images/browser's
  `PLAYWRIGHT_VERSION`; the server refuses a client on another
  major.minor. Bump the Dockerfile, the package and the compose tag together.
- **An app, through strut's own host** (`lookAtApp`, the `app/look` step):
  strut's UI loaded from `STRUT_ORIGIN` (`https://strut.invalid`, never
  resolved) with every request answered by `app.fetch` in this process
  (`serveStrut`, wired by createStrut when it serves the UI), marked
  in-process with the run's actor — so it works over a Playwright server,
  a CDP Chrome or a local one alike, with no route from the browser to
  strut and no credential in it. A session of its own, closed after.
- **Credentials:** a logged-in session is a Playwright storage state saved
  under Secrets (`browser/state` writes one for a human to paste) and loaded
  by `browser/open { storageStateSecret }` — the value never reaches a model.
- **Screenshots** land under the run's artifacts, or the job's directory on a
  job run (so a host can read a child run's shot by the job), and each tells
  a listening host (`jobCallback`) as it lands. `sharp` makes the 0.6× copy
  a model is shown; the record keeps the full frame.

## Key concepts

- **`createStrut()` is the primary entry point** (`src/createStrut.ts`).
  It builds a configured instance — Hono `app`, `workspace`, `store`,
  `services`, plus `run()`/`listen()`/`rebuildRegistry()` helpers — and
  mounts every route (`/workflows`, `/steps`, `/secrets`, `/chat` +
  `/chats`, `/health`, static UI). Everything is injectable via
  `StrutOptions`: pass your own `workspace` (any `WorkspaceStore`),
  `registry` (disables step discovery + publishing), `store` (e.g.
  `MemoryRunStore`), `chatStore`, `secretStore`, `services` bag,
  `dataDir`, or toggle `serveUi`/`enableChat`.
  **Storage boundary:** nothing outside `workspace.ts` reads a workspace
  directory. `WorkspaceStore` exposes custom step code two ways —
  `getStepSource(type)` (text, all tiers) and `materializeCustomSteps()`
  (an importable dir for `buildRegistry`). The inherently-local things —
  run artifacts, step cassettes, the chat builder's shell cwd + scratch/ —
  hang off `dataDir` (default: the file workspace's root, so a
  file-backed deployment keeps one directory). Unspecified store defaults
  follow the workspace's kind (file → file stores under `dataDir`; any
  other impl → memory); an explicitly passed store always wins, and no
  capability is gated on a concrete class. `storage-conformance.test.ts`
  is the boundary's spec — a new backend passes by running it.
  **Graph backend:** `GraphWorkspaceStore` (`src/graph/workspace-store.ts`;
  `Neo4jWorkspaceStore` is its first name, kept as an alias) over any
  `GraphBackend` — Neo4j, or a LadybugDB file (plans/ladybug-backend.md) —
  keeps workflows/steps as `StrutWorkflow`/`StrutWorkflowVersion`/`StrutStep`/
  `StrutStepVersion` nodes (content-addressed versions; soft deletes;
  `USES_STEP`/`DEPENDS_ON` edges) through a dozen pattern-level statements
  written with the backend's dialect helpers, and passes the same
  conformance suite on both (`npm test` on a Ladybug file, `npm run
  test:graph` live on Neo4j). It is the default server's workspace
  (`src/graph/wiring.ts`; connection from `NEO4J_URI` / `NEO4J_HOST` /
  `NEO4J_USER` / `NEO4J_PASSWORD`, defaulting to localhost:7687 / neo4j /
  testtest like the mcp host — so Neo4j is a boot dependency);
  `STRUT_WORKSPACE_BACKEND=ladybug` puts it on one LadybugDB file instead
  (`<dataDir>/graph/graph.lbug`, `STRUT_GRAPH_DB`; `ladybugWorkspaceFromEnv`)
  — the desktop package's default — and a filesystem workspace found under
  the same `dataDir` is imported into the file at that boot
  (`src/graph/fs-import.ts`: every version under its label with its
  metadata, the files then moved to `fs-workspace.imported-<ts>/`, the run
  records left where they are; a failed import boots the fs workspace,
  loudly, and tries again next boot); `STRUT_WORKSPACE_BACKEND=fs` opts back
  into the file workspace. The backend behind the workspace (or
  `createStrut({ graph })`) is `ctx.services.graph`, what the `graph/*`
  steps read and write through. Runs/chats stay in
  their stores; `src/graph/projector.ts` (or the `graph/project` step)
  projects them into `StrutRun`/`StrutAgentSession`/`StrutToolCall`/
  `StrutChat`/`StrutTurn` with `EXECUTED`/`IN_RUN`/`IN_SESSION`/`SPAWNED`/
  `IN_CHAT` edges — summaries + `log_ref` pointers, never payloads, but
  for a CONVERSATION TURN's words, kept whole (`TEXT_MAX_CHARS`, 50k; past
  it the start and the end) and first in the node's search text, so
  keyword search reads what was said and the embedding its first 256
  tokens: a `StrutTurn`'s `user_text` / `assistant_text` (every text of
  the turn's steps, never its thinking), and on a `StrutAgentSession` with
  a `session_id` its `message` (the agent step's `message` config — the
  person's words when the prompt wraps them in more, which the
  orchestrator, job and builder seeds set to `{{ input.prompt }}` — else
  the prompt) and `reply` (a structured reply's `text`, else the result);
  a one-shot agent keeps previews, and no node keeps tool traffic, a
  system prompt or an attachment. Search hits carry the preview
  (`description_key`); `graph/graph-get` reads the whole text;
  idempotent upserts; on a Ladybug file the projector writes `StrutRun`,
  `StrutJob`, `StrutArtifact` and `StrutProposal` with `EXECUTED` / `IN_JOB` /
  `HAS_ARTIFACT` / `DELIVERED` / `IN_RUN` / `ACCESSED` and skips the rest, and its statements are the dialect's. **Every top-level run is projected when it ends**
  (`createStrut`, from the `services.onRunEnd` hook the verify pass rides;
  claims on or off; detached, so a graph that is slow or down never holds
  a teardown) — check runs (`origin: "verify"`) and `run_step` runs
  excepted; a kept step run still reaches the graph only with evidence.
  The verify pass does not project it again: `runRef` joins the projection
  in flight (`projectRunOnce` is single-flighted per run), else takes the
  settled node the graph holds. **So is every builder chat, when one of
  its turns ends** (`projectChatOnce`, from `launchChatTurn`'s `finally`,
  and again when a detached run it launched settles; one at a time per
  chat, a call during a projection queuing one more): its `StrutChat`, a
  `StrutTurn` per user message, `SPAWNED` to each run it launched — the
  run's projection in flight is waited for. Neo4j only (a Ladybug file
  holds no chat types), and no `ACCESSED`: a chat's tool calls are not
  nodes. **An assistant conversation is the same `StrutChat`** (`kind:
  assistant`; a builder chat's is `builder`): a run that is a turn of one
  (the conversation index's record, `src/conversations.ts`) upserts it from
  the record — title, last status, turn count, who first spoke — and its
  agent session is `IN_CHAT` it, so a conversation is one node whichever
  way strut held it; its turns are the `StrutAgentSession`s, their words
  whole. Neo4j only, for the same reason. Runs cut off before their end, and chats older than this, are
  the `graph/project` step's. **Provenance convention:** a graph-touching step
  marks its output with `withAccessedNodes(output, [{ ref_id, node_type? }])`
  (`core.ts`; a non-enumerable marker — invisible to the model, `{{ }}`
  expressions, and JSON). `wrapToolsWithEmit` lifts it onto the tool call's
  `step.end` event as `nodes`, untruncated — the runner does the same for a
  graph step the workflow itself ran, and a step that launched another run
  reports that run's nodes as its own (`meta/run-workflow` from the child's
  log, `strut/run-workflow` from the peer's tail, peer-tagged;
  `foldAccessedNodes`) — and the projector writes one
  `ACCESSED` edge per ref the graph holds (`StrutToolCall → any node`; a
  workflow step's `nodes` are in the log only). Every
  `graph/*` (and mcp `jarvis/*`) node-touching step does this; a step that
  reports nothing gets no edges — never inferred from prose. **What is
  reported is what the caller NAMED** — fetched by ref or key, expanded,
  created, edited, moved — with its `node_type` and `name` (`describeNodes`
  in `graph/_shared.ts` reads them for a write that only had the ref).
  Never what came back as a list: `graph-search` reports nothing,
  `graph-neighbors` the expanded node only, `graph-edges` nothing (the
  edges among nodes the caller already holds), `graph-get` never its
  `children`, a `walk` hop the node it expanded and what it kept. The run
  flyout lists them per step (`kit/src/folds/accessed-nodes.ts` folds an agent's
  tool calls; filtered to `Concept` by default) and opens one in place
  through `GET /graph/nodes/:ref_id`. The same
  marker mechanism carries an agent step's transcript: `withMessages(output,
  session)` → `step.end.messages` (lifted by the runner for steps and by
  `wrapToolsWithEmit` for tool calls; `messagesOf` reads it).
  `server.ts` is a thin wrapper (`getApp`/`startServer`) over
  `createStrut()` — graph workspace by default, file stores for the rest.

- **`services` bag** is a consumer-defined capabilities object exposed to
  every step via `ctx.services` (typed by `defineStep`, untyped at
  runtime). Inject env-specific implementations (Neo4j vs in-memory,
  real vs fake LLM) without touching workflows or the registry. Threaded
  through `createStrut({ services })` / `strut.run(wf, input, { services })`
  / `runWorkflow(flow, input, registry, { services })`.
  - **`services.onRunEnd(runId)`** — an OPTIONAL generic per-run teardown
    hook the runner calls in a `finally` around `executeFlow` in
    `runWorkflow` (so it fires on success AND error, for every run path,
    once per top-level run; a throw in it can't mask the run result). Lets a
    services bag dispose per-run resources keyed by `runId` (e.g. mcp `/lab`'s
    gitsee browser + booted docker stack). A hard `SIGKILL` still skips it
    (in-process `finally`), so that case stays out-of-band.
  - **`services.onRunEvent(workflow, event)`** — the per-EVENT twin: an
    OPTIONAL bag hook the runner awaits at every emit, after the event is
    in the log, for a listener set once for the deployment — createStrut's
    events sink (`src/events-sink.ts`, `STRUT_EVENTS_SINK`) chains onto a
    host's own. Guarded: a listener that throws is logged, never the run's
    failure. A host's own listener gets the FULL event (transcripts
    included — it is in-process); what leaves the process is the sink's
    envelope.
  - **`ctx.onRunEnd(fn)`** — the same hook for a STEP (plans/code-change.md
    §3.1): a run-scoped disposer list (`Exec.disposers`, one per run, shared
    by subflow frames and an agent's tool-call steps), drained newest-first
    in that same `finally`, each guarded, BEFORE the bag's `onRunEnd`. For a
    lib/custom step that allocates something that must not outlive the run
    and cannot reach the consumer's bag — `git/checkout` removes its worktree
    with it. Absent outside the runner, like `registry`.
  - **`services.dataDir`** — the deployment's data dir on the standard bag
    (set by `createStrut`), for steps that keep local blobs of their own
    beside artifacts and cassettes (`git/*`'s cache + worktrees). A bare
    in-code bag may lack it; steps fall back to the OS temp dir.

- **`ctx.registry`** — the step registry, populated by the runner in
  `dispatchStep`. Lets a step that orchestrates OTHER steps look them up by
  type without being promoted to a runner-handled container step — the seam
  the `agent` step uses for `agentTools` ("tools are steps"). Optional (absent
  outside the runner, e.g. unit tests); read-only by convention.

- **`createRegistry(steps)`** builds a registry from in-code step defs
  layered on core + lib (no filesystem custom/ discovery) — the
  library-usage counterpart to `buildRegistry(customDir)`. User
  steps may shadow core/lib steps (with a warning); duplicates throw.
  Like `buildRegistry`, it imports every lib step *file* at build time
  (cheap: schema + metadata only) — heavy SDK deps load lazily in `run()`
  per the "Lib step dependency convention".

- **Workflows are YAML**. One format everywhere — no `.ts` workflows,
  no JSON workflows. The API accepts either a `steps` array (server
  serializes to YAML) or a raw `yaml` string. Files are stored as
  `<version>.yaml` in the workflow directory. `js-yaml` for parsing.

- **`params` = the experiment surface.** A workflow may declare a
  top-level `params:` block of tunable default knobs (prompts,
  thresholds, sample sizes). Step configs reference them via
  `{{ params.* }}`, parsed in `workspace.ts:loadFlowYaml` and seeded
  into runner scope as `{ ...flow.params, ...runOverride }` (see
  `executeFlow` in `runner.ts`). A `{{ params.x }}` inside another
  param's value is resolved once at load, from the defaults
  (`resolveParamSelfReferences`); one naming a param the workflow does
  not declare is left as written, so a prompt param can teach the
  syntax. Deliberately distinct from `input`:
  `input` is the run *subject* (validated, no defaults), `params` is
  *how* it's processed (all defaults, sparsely overridden per run via
  `POST /run { params }` / `runWorkflow({ params })`). Override
  precedence: step Zod `.default()` < `params` default < per-run
  override. Subflows use their own `params`; the parent override does
  not propagate — a `subflow` step's own `params` config overrides the
  child's defaults for that call (a run's keyed `paramOverrides[child]`
  still wins). This is what lets overnight experiments sweep 100
  prompt variants as 100 **runs** (logged in `run.json`) rather than
  100 workflow versions — promote a winner by editing the `params`
  default and publishing one new version.

- **`input:` = the declared run payload (optional).** A YAML workflow may
  declare a top-level `input:` block — `name: { type: string|number|boolean|json,
  required?, default?, description? }`, required unless it has a `default` or
  says `required: false` (`src/input-block.ts`). `flowFromYaml` turns it into
  the flow's Zod `input` schema (the runner already validates against it
  before any step runs; unknown keys are dropped) and keeps it on
  `Flow.inputBlock`, which `GET /workflows/:name/flow` returns as `input` and
  the Run popover builds its form from. Absent: `z.any()` as before, and the
  popover infers the form from `{{ input.* }}` references (`web/src/run-inputs.ts`).
  Either way the steps' schemas are consulted for one more thing: an input
  that `graph/graph-get` resolves BY NAME (`name: "{{ input.x }}"` with a
  `node_type` that is a literal or a `{{ params.X }}` the params answer) is a
  node name, and ConfigField offers a typeahead over `GET /graph/names?type=&q=`
  for that type (`GraphReader.namesLike`: a case-insensitive name-contains
  read, prefix matches first — not the fulltext search, whose whole-word +
  fuzzy matching answers "Med" with "Medical", never "Medicine";
  `nodeLookups` / `applyLookups`; `FieldDesc.nodeType`). The step
  declares which field is a name and which sibling holds the type —
  `.meta({ lookup: { typeField: "node_type" } })`, passed through
  `zodToFields` as `FieldDesc.lookup` — the YAML declares nothing, and the
  UI picks the read it calls, never the workflow. Free text stays.
  A bad block fails the publish (`assertValidWorkflowYaml`, every backend), so
  it never hides a workflow behind a load error.

- **DAG execution via `depends`**. Steps have an optional `depends`
  field (`string | string[]`). If set, the step waits for those
  dependencies before running. If omitted, the step implicitly
  depends on the previous step in the array (sequential by default).
  `depends: []` means no dependencies — the step runs immediately
  in parallel with others. The runner launches all steps via
  `Promise.all`, each waiting on its own deps internally.

- **No `parallel` step type**. Parallelism is expressed purely via
  `depends`. Two steps with the same `depends` run concurrently.
  A downstream step with `depends: ["a", "b"]` waits for both.

- **Control flow steps** (`if`, `loop`, `subflow`) are intercepted
  by the runner before registry lookup. Their config is NOT
  pre-resolved by `executeStep` — they manage their own template
  resolution (see `SELF_RESOLVING_STEPS` set in `runner.ts`). This
  is because `loop`'s `until` references `$current` which doesn't
  exist until iteration time.

- **Expression evaluator** (`expr.ts`) is a one-pass recursive
  descent parser that evaluates as it parses. `? :`, `&&`, `||` and `??`
  SHORT-CIRCUIT as in JS: the part the operator rules out is parsed under a
  `skip` depth — syntax still checked, nothing looked up, read, indexed or
  called — so `xs.length > 0 ? xs[0].n : 0` holds on an empty list (before
  2026-11-09 both branches ran, and a builder's workflow failed its last
  step on exactly that). The static validator checks a skipped part's roots
  like any other. No function calls in v1.

- **The global regex issue**: `TEMPLATE_RE` is a module-level
  `/g` regex. `resolveTemplate` uses a non-regex check
  (`indexOf("{{")`) for the single-expression fast path to avoid
  the greedy backtracking bug with multi-segment templates.

- **Templates must be quoted in YAML.** A value starting with `{{`
  is parsed by YAML as a flow-mapping, so `pull_number: {{ input.x }}`
  silently becomes an object (`{ "[object Object]": null }`) → the step
  fails with a baffling "expected number, received object". Always write
  `pull_number: "{{ input.x }}"`. A sole `"{{ expr }}"` still preserves
  the value's real type (number stays number). `publishWorkflow`
  **lints for this** (`workspace.ts:assertValidWorkflowYaml`, detects the
  parsed `[object Object]` corruption signature — so it doesn't
  false-positive on `{{ }}` inside block-scalar message bodies) and throws
  an actionable error instead of writing a broken workflow. The AI builder's
  system prompt also carries the quoting rule.

- **AI tool args may arrive as JSON strings.** LLMs sometimes pass an
  object-valued tool arg (e.g. `run_workflow`'s `input`) as a JSON
  *string*; the template engine then sees a string and `{{ input.* }}`
  resolves to `undefined`. `buildTools` (`ai/tools.ts:coerceJsonArg`)
  defensively `JSON.parse`s string args that look like objects/arrays for
  `run_workflow` + `run_step` (`input`/`params`/`config`).

- **`_metadata.json`** in each workflow dir tracks versions and the
  active version. In `steps/custom/_metadata.json` it tracks
  per-step `{ active, versions, publisher? }` keyed by full
  slash-name (e.g. `"gitree/save-feature"`), where `versions` maps
  each version id (`v1`, `v2`, …) to `{ createdAt, description?, hash }`.
  The engine can run without these files but the UI needs them.

- **Custom steps are versioned** (like workflows). `publishStep`
  is keyed by content hash (`src/version.ts`) but labeled with
  sequential `vN` ids: identical content re-activates the existing
  version (no-op if already active; `{ reactivateKnown: false }` skips
  the re-activation, for a caller that wants a UI/API edit kept — strut's
  boot seeders never pass it: a seed always matches git), changed content
  publishes the next `vN`. The active version's source is materialized at
  `steps/custom/<name>.ts` (what the registry loads); every version
  is archived under `steps/_history/<name>/<vid>.ts` for rollback.
  Endpoints: `GET /steps/:type/versions`, `GET /steps/:type/version/:version`,
  `PUT /steps/:type/active`. Versioning is disabled when the registry
  is injected at construction time.

- **A workflow runs a step's ACTIVE version unless it pins one**
  (`src/step-ref.ts`). `type: clip/shout` follows the active pointer, so
  `edit_step` / `PUT /steps/:type/active` changes every workflow that
  names it on their next run — and rolling a WORKFLOW version back never
  rolls a step back. `type: clip/shout@v1` holds that workflow at v1 (custom
  steps only; the `vN` label, never a hash; `@` is reserved in step names).
  The registry stays a flat record of active defs: `resolveStep(registry,
  ref)` loads a pin through the loader `buildRegistry(customDir, {
  loadVersion })` hangs on the registry (`WorkspaceStore.materializeStepVersion`
  — the version written BESIDE the active steps, `<ns>/_<leaf>@<vN>.<hash>.ts`
  in `steps/custom/` or the graph's scratch dir, `materializePinnedStep`, so
  its relative imports resolve as the active version's: a pin holds the
  step's own file, and a helper it imports is the helper's ACTIVE version),
  cached per registry (a version is immutable), and a pin the registry
  cannot honor THROWS before the step starts — never a silent fallback to
  active. Every lookup site goes through it (runner, `agentTools` grants,
  `run_step`, `get_step`, `/steps/:type/schema` + `/source` — so the step
  editor's form is the pinned shape). Events carry the bare `stepType`
  (stats, claims, colors are pin-blind); the executed version is
  `step.start.stepVersion: { version, hash }`, the twin of
  `step.start.subflow`, which verify prefers over `run.start.stepHashes`
  (still "what was active at launch"). `closure.types` strips pins. **UI:**
  a pinned node shows a pin in its bottom-right corner (`renderPinIndicator`,
  header = the bare type); the step editor (`StepEditFlyout`) has a
  **Version** select for custom steps — *Active (vN)* writes a bare type,
  *vN — pinned* writes `type@vN` for THIS workflow's step only (a workflow
  edit → Publish), with a note when the pin differs from the active version.

- **Custom steps are loaded as `.ts` via dynamic `import()`**
  (`registry.ts:loadStepFile`), so the **host process must run with a
  TypeScript-capable loader** — fine in dev (`tsx`), but a plain
  `node build/index.js` can't import `.ts`. Hosts that serve
  filesystem custom steps in production must register a loader (mcp runs
  `node --import tsx build/index.js`). Consumers using only core/lib or an
  in-code `createRegistry([...])` don't need this. A step file is imported
  under `?hash=` — of its source and of every file it reaches by relative
  imports (`hashedUrl`, src/strut-resolve-hook.ts), the hash the resolve hook
  also puts on each of those imports — so a republished step or helper
  reaches every step that imports it at the next registry build, with no
  restart, and an unchanged file keeps its module.

- **Step registration is filesystem-based.** External services
  register steps by `POST /steps { name, code, description?, publisher? }`.
  Names may be nested (`"gitree/save-feature"` writes
  `steps/custom/gitree/save-feature.ts`) and helper files use a
  leading `_` (`"gitree/_shared"`) — these are saved and importable
  by sibling steps but skipped by registry discovery. A service
  cleans up on shutdown via `DELETE /steps?publisher=X`, which
  removes every step it owns and prunes empty namespace dirs.
  Namespaces are pure naming convention (just slashes in the name) —
  no ownership enforcement, last writer wins.

- **`buildRegistry()` returns `{ registry, sources }`.** The
  `sources` map records where each step was loaded from
  (`"core" | "lib" | "custom"`). Always use this map instead of
  guessing from the name — a custom step like `gitree/save-feature`
  has a slash but is `custom`, not `lib`. The `/steps` endpoint
  uses this map.

- **Runs are stored per-workflow** under
  `workflows/<name>/runs/<runId>/`. Run IDs are millisecond
  timestamps (not UUIDs) for natural sort order and easy
  pagination. Listing runs for a workflow is a single `readdir`;
  `GET /workflows/:name/runs` serves them a PAGE at a time (`?limit=`, 50
  by default, after `?before=<runId>`; `runsPage` in `src/runs.ts`) and
  reads only that page's summaries — a swarm's workflow has thousands. The
  sidebar loads one page and a **Load more** row; a refresh re-reads the
  newest page and keeps the older ones below it.

- **Runs launch detached; viewing is reattach-by-tail** (the
  background-job model, `EVAL_SPEC.md` §8). `POST /workflows/:name/run`
  (and `/:version/run`) does **not** stream — it kicks off
  `runWorkflow` **without awaiting it in the request** (`launchDetached`
  in `createStrut.ts`) and returns `{ runId }` (202) immediately. The
  run executes server-side and persists every event to the
  append-only `events.jsonl`; its liveness is decoupled from any
  connection (closing the client, proxy timeouts, etc. can't kill it).
  To watch a run — live **or** after it finished — open
  `GET /workflows/:name/runs/:runId/stream` (SSE). That endpoint calls
  `RunStore.tailEvents`; the file store **tails the events file**: replay
  from byte offset 0 → EOF (history), then follow appends (polling
  `intervalMs`, default 250ms) until the terminal event
  (`run.end`/`run.error`) — or, for a STALE run (no terminal event, no
  controller in this process: cut off by a crash, not resumed), closes
  at EOF (`TailOpts.live`) instead of following forever — then sends a final `done` carrying the
  RunResult. Because the append-only log is the ordered source of
  truth, the history→live join is **race-free** (read to EOF, follow
  from EOF — no sequence numbers, no dedupe), and **one code path
  serves completed and in-flight runs**. Pass an `AbortSignal` (wired
  to `stream.onAbort` on client disconnect) to stop the tail early.
  `?skip=N` (`TailOpts.skip`) leaves out the first N events — what the
  client already read from `GET …/events`, one gzipped response. SSE is
  never compressed and each event is its own frame, so the web UI's run
  select fetches the log first (one render) and tails from its length; a
  big finished run used to replay through the tail, one re-render and
  layout per network chunk (swarm38, 2026-10-03).
  `RunStore` is the FULL contract (append/finalize + listRuns/
  getRunSummary/getRunEvents/tailEvents/lastRunAt): no endpoint
  capability-gates on the concrete class. A backend without a native
  tail delegates `tailEvents` to `tailFromPolling` (re-read + index
  cursor) — `MemoryRunStore` does, so memory-mode strut has run history,
  SSE reattach, durable resume, and promotions. **Crash caveat:** in-flight *execution* is in-memory, so a
  crash mid-run loses the remaining work (the log up to the crash
  survives); true resume is a later add. The web UI's
  `api.runWorkflow` hides the two steps — it POSTs to launch, then
  `streamRun(name, runId)` reattaches to the tail — so callers see the
  same `(onEvent, → RunResult)` interface as before.

- **Run callbacks — a host hears the result without tailing**
  (`src/callback.ts`; createStrut's `postRunCallback`). `POST
  /workflows/:name/run { …, callback: { url } }` (and the `/:version/run`
  twin) validates the URL — http(s), else 400 and nothing launches — and
  the 202 carries `callback: true`, the host's proof this server honors
  it. When the run settles strut POSTs, once, `{ event: "run.end",
  workflow, runId, status: "success" | "error" | "cancelled", output?,
  error?: { message }, transcripts?: [{ step, stepType, url }], durationMs }`
  — each agent session as a LINK (`GET …/runs/:runId/transcripts/<step
  path>` serves its bare `messages` array), never inline — detached from the run's teardown,
  with the chat callback's delivery rules (a few retries; a 4xx is the
  host refusing it). The URL is the host's credential: `run.start` and
  `run.resumed` record `callback: { origin }` only, so no read endpoint
  (events, stream, summary) can leak it; the URL itself is kept by the run
  store beside the log (`RunStore.setRunCallback` / `getRunCallback` —
  `callback.json` on files — served by nothing), so a durable resume, by
  hand or boot-time auto-resume (§5.3), posts `run.end` the way the launch
  would have (before 2026-10-01 a restart dropped it, and hive learned of a
  resumed run only through its reconcile cron, up to 10 minutes later),
  and a run whose log ended but whose summary the dead process never
  wrote posts it when boot writes the summary. A restart still drops a
  post in flight; the host's fallback is `GET
  /workflows/:name/runs/:runId`. The web UI never sends one.
  **Rooms** (`src/rooms.ts`, plans/chained-orchestrators.md §3): for a host
  that cannot be called (a laptop behind NAT), `callback` and `jobCallback`
  take `{ room: true }` — the launching actor's room, a WebSocket the
  client holds open on `GET /rooms` — kept as `room:<actor>` wherever a URL
  is kept, so the store, a resume and the jobs' inheritance carry it
  unchanged; `run.start` records `callback: { room: true }`. Only a
  request whose actor strut can vouch for asks for or joins one (`full`
  with an actor, or `peer:person`); the shared peer key's actor is a
  header any strut sets. Not durable: a room with no socket open queues
  the newest 1 000 in memory. `strut/run-workflow { room: true }` asks a
  peer for one (`specs/CALLBACKS.md` §8).

- **The caller's MCP servers — a host's way back into itself**
  (`src/mcp-servers.ts`). The pull-direction twin of `callback`: `POST
  …/run { mcp: [{ name, url, token?, headers?, toolFilter? }] }` (Hive's
  `McpServerConfig`, field for field; HTTP only — a caller names a URL,
  never a process for strut to start) hands this run's agents the caller's
  tools — Hive its org's MCP, any other caller its own. Kept exactly as the
  callback is: validated before anything launches (400), the 202 carries
  `mcp: true`, `run.start` / `run.resumed` record `mcp: [{ name, origin }]`
  only, and the entries — credentials included — are kept by the run store
  beside the log (`RunStore.setRunMcp` / `getRunMcp`, `mcp.json` on files,
  owner-only), served by nothing, so a durable resume reconnects. Every step
  sees them as `ctx.mcp` (beside `ctx.job`); the `agent` step's `mcp`
  (default `true`) turns them into tools, and `job/start` / `job/continue`
  / `meta/run-workflow` hand them on to the runs they launch, so a job
  started from a Hive turn reaches the same Hive. `strut/run-workflow`
  never forwards them: they are this caller's, for this strut. An agent
  with `mcp: false` keeps to its own tools and hands its tools a `ctx`
  without them — its sub-agents and the jobs it starts get none. A token
  that expires mid-run (Hive's are 4 h JWTs) makes the call an `Error:`
  text; the host mints for the run's length.

- **Run control** (`RUN_CONTROL_SPEC.md`, `src/run-control.ts` +
  `src/journal.ts`). Every launch site registers a `RunController`
  (createStrut's `trackRun` — superseding the old `activeRuns` set); nested
  launches attach to the parent's controller via `parentRunId` (set by
  meta/run-workflow + the lab's optimizer from `ctx.runId`), so
  cancel/pause apply to WHOLE SUBTREES. All control is cooperative: the
  runner awaits `checkpoint()` between DAG steps / loop+foreach iterations /
  retry attempts; the agent step checkpoints between tool calls
  (`prepareStep`); code steps with long loops opt in via
  `ctx.control?.checkpoint()`. Endpoints:
  `POST /workflows/:name/runs/:runId/{cancel,pause,resume}`. Cancel
  finalizes honestly as `status: "cancelled"` (never the error path).
  Durable resume replays the journal (`step.end` outputs keyed by path →
  `step.replayed` events, zero cost) and re-executes from the first
  incomplete path — valid for stale (crashed), error, and cancelled runs;
  a successful run needs `from: <stepPath>` ("re-run from here", which
  drops the target + transitive dependents + later loop iterations).
  `run.start` records the workflow content hash (resume refuses a changed
  DAG unless forced) and per-run params. `{ version: "active" | "vN" }`
  resumes onto that version instead (§5.4): the top-level steps that
  changed re-run with everything downstream, the rest replays, and
  `run.resumed` records the new `workflowHash` + `changed` — the run's
  version from then on (`executedWorkflowHash`). The UI's Resume and
  Re-run from here, the builder's `resume_run` and `meta/resume-run` (a
  run of an unsealed workflow billed to the calling run's principal) send
  `"active"`; boot's auto-resume never moves a run. One function behind
  all of them (`resumeRun` in createStrut). Nothing leaves a run stale
  short of the process dying (§5.5): an error a step lets escape fails
  that step (`src/escaped-errors.ts`), and a throw past the runner's own
  handling or a failed launch settles the run as an error
  (`settleUnfinishedRun`, runner.ts). Iterative code steps consume
  `ctx.journal` to resume completed iterations (harvey/evolve-loop does).
  A durable resume drops the attempt's `run.json` first
  (`RunStore.clearRunSummary`), so a summary always means the latest
  attempt finished and a resumed run reads as live everywhere. A log over
  `STRUT_RESUME_MAX_LOG_BYTES` (64 MB) is never read: the boot scan skips
  it by its size, `POST …/resume` answers 413.

- **`RunStore.append/finalize`** take `(workflow, runId, ...)`
  — the workflow name is the first param. `MemoryRunStore` keys
  by `"workflow/runId"` internally; use `store.getEvents(wf, id)`
  and `store.getSummary(wf, id)` in tests.

- **Flyout has two modes**: when no run is selected, clicking a
  canvas node opens the step editor (edit id, type, config). When
  a run is selected, it opens run results (input, output, error,
  duration). No backdrop — flyout stays open when clicking between
  nodes for smooth transitions. Clicking is always **inspect**;
  entering a container's children is the **arrow's** job (below).

- **Container nodes & navigation** (`flow-to-canvas.ts` +
  `app.tsx`). `subflow`/`foreach`/`loop` steps that target a child
  workflow (`stepWorkflow()` resolves a name — a subflow's
  `config.workflow`, or a foreach/loop whose `body` is a subflow)
  get a navigable **ref arrow** (`childRefForStep` sets
  `node.ref = "wf:<name>"`; `refCorner: "topRight"` so it clears the
  left-aligned name label). The arrow means different things by mode
  (we use system-canvas's `externalNavigation` so a ref click only
  fires `onNavigate`, never the lib's internal drill):
  - **Edit view** → **go-to-definition**: `handleNavigate` switches
    the selected workflow (the target is a standalone, separately
    editable workflow — not an inline sub-canvas).
  - **Run view** → **drill into this run's nested execution**: a
    read-only sub-canvas built from the child's steps + the run's
    events **re-keyed** to the nested path prefix. Subflows execute
    inline under one `runId` with hierarchical event paths
    (`wf/subflowId/childId`, `wf/foreachId#i/...`), so
    `viewEvents` strips the `<prefix>/` and re-prefixes with the
    child workflow name — the existing path-based status overlay +
    flyout lookups then work unchanged at any depth. A `runDrill`
    frame stack + breadcrumb bar handles back-navigation. foreach/
    loop frames carry an **iteration count + selected `iter`**
    (`framePrefix` appends `#<iter>`), surfaced as a dropdown in the
    drill bar (`countIterations` derives N from the events).
  - **Container I/O is the "summary"**: a leaf's flyout shows its
    `input → output`; a container's shows its aggregate (subflow:
    child input → child result; foreach: items array → results
    array). The runner emits these as the container's `step.start`
    input (`subflow` → `config.input`, `foreach` → resolved
    `items`); `loop` has no natural input.

- **`canvas` and `flyoutEvents` are derived** (`useMemo`) from a
  **view context** — root (`selectedWf` + `localSteps` + `events`)
  or the deepest `runDrill` child (its workflow + steps + re-keyed
  events). There is no imperative `rebuildCanvas`; setting
  `localSteps`/`events`/`runDrill` recomputes the canvas. A
  `running` flag drives the pending-status overlay during a live
  streamed run (events are still empty at run start).

- **AI workflow builder** (`src/ai/` + `POST /chat`). A
  `ToolLoopAgent` (Vercel AI SDK, any aieo provider — see "Model picker"
  below) that can browse step
  types (`list_steps`, `search_steps`, `get_step`), author/revise
  custom steps (`create_step`, `edit_step`), publish workflows
  (`create_workflow`), and test them (`run_workflow`). `run_workflow`
  threads `ctx.services` (via `AiDeps.services`), so the agent can
  run workflows whose steps reach external systems (Neo4j, the lab's
  `optimizer`, …) — not just service-free core/lib ones. The system
  prompt is built by `buildSystem(deps)` (pre-seeds the steps tree) on
  a chat's FIRST turn and replayed verbatim after — see "History is
  append-only" below. Its rules (the dialect, the "Tools" section, the
  procedure) are the same text the `builder` JOB's prompt is — rendered
  from one role → tool-name map in `src/ai/prompts.ts`, with the chat's
  names for the chat and the `meta/*` names for the job — so the two
  never drift; the chat's rendering is pinned byte for byte by
  `src/ai/prompts.test.ts`.

- **`chatSystem` — the host's section of the builder's prompt**
  (`createStrut({ chatSystem })` → `AiDeps.hostSystem`). Strut's prompt
  knows how to build workflows, never WHAT a deployment builds: a domain
  convention (what a "janitor" is, which seeded workflow runs one) belongs
  to the host, not in `BASE_SYSTEM`. The hook is called once per CHAT,
  when its first turn renders the prompt, with `{ chatId, turn, actor? }`,
  and its text is appended verbatim after
  strut's rules (and the claims section), before the models line and the
  steps tree — which stays last. The prompt is then frozen for the chat
  (it heads the cached prefix), so an edit to the host's section reaches
  new chats only. Default on a graph (`src/ai/builder-system.ts`): the
  `Workflow Builder` Concept's page and the kinds under it, the page strut
  seeds at boot (`src/concept-seed.ts`); a host's hook replaces it.
  Nothing returned, or a throw (one warn line) → the prompt is strut's
  alone; a turn never fails on it. The text has SYSTEM authority over a
  builder that can publish steps and run bash, so the host owns where it
  comes from and how long it is.

- **`list_secrets` tool** (`AiDeps.secrets`). The agent can list the
  **names** of available credentials (never values — it's the same
  names-only view as `GET /secrets`) so when it authors a step it
  references an existing secret name in `ctx.services.secrets.get("NAME")`
  rather than guessing, and tells the user which secret to add when one
  is missing. Deliberately **read-only**: the agent has no
  set/delete — writing a value through the model would defeat the
  write-only design, and adding a secret is a human action. Wired only
  when strut owns the secret store (absent when the consumer injected
  their own `services.secrets`; the tool then returns an error).

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
  Maple and Numes model — each with its `contextLimit`, its `pricing` (USD
  per million tokens) only where strut knows the model's own rate (today
  Maple's and Numes'; aieo's flat per-provider rate is not a price, and
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

- **Chat is a detached background job** (`src/chat-store.ts`), NOT a
  connection-bound stream — the same launch+reattach model as runs
  (§8). `POST /chat { chatId?, message, model? }` appends the user message,
  launches the turn server-side **without awaiting it** (a
  `launchChatTurn` mirroring `launchDetached`), and returns
  `{ chatId, turn }` (202). The turn consumes the agent's `fullStream`
  and persists each part; close the browser and it keeps running.
  Watch/reattach via `GET /chat/:id/stream` (SSE tail), load the
  transcript via `GET /chat/:id`, list sessions via `GET /chats`.
  `POST /chat/:id/cancel` stops the live turn (the flyout's stop square,
  shown only while the chat is working): the agent stream is aborted, what
  streamed so far is persisted — a tool call cut off before its result gets
  a stopped result, so the next turn never re-feeds a dangling call — and
  the turn ends `chat.end { stopped: true }`, status `done` (the turn
  callback carries `stopped: true` too). Queued notifications still drain.
  Each chat lives in `chats/<id>/` with the deliberate **two-file
  split** (borrowed from `mcp/src/repo/session.ts`): `messages.jsonl`
  is the **replayable** conversation, exactly as the model saw it
  (re-fed to the agent next turn + rendered as transcript — whole
  `ModelMessage`s, never deltas — written as each STEP of a turn ends, so a
  turn cut off by a restart leaves whole steps behind, never a call without
  its result); `events.jsonl` is the fine-grained **observability** stream
  the SSE tail follows (text deltas, tool calls/results, step/turn
  boundaries — never re-sent to the model); `meta.json` tracks
  `{ status, currentTurn, … }`. A chat is long-lived across turns, so
  the launch+tail unit is a **turn**: each turn's events carry
  `turn: N` and end with `chat.end`/`chat.error`, and `tailEvents`
  replays a multi-turn log but stops at the requested turn's terminal
  (race-free, like the run tail). The shared tail engine is
  `tailJsonl` in `store.ts` (used by both `FileRunStore.tailEvents`
  and `FileChatStore`).
  **History is append-only — the prompt cache depends on it.** What a
  turn sends is the previous request plus new messages, byte for byte:
  a rewritten earlier message misses Anthropic's cache from that point
  on (the WHOLE conversation once the change sits beyond its 20-block
  lookback, since the chat has one automatic breakpoint), and on models
  that bind thinking blocks to the prefix (Opus 5.5, Fable 5.1)
  invalidates every later block — a 400 on accounts enforced for it. So
  (1) tool results are capped WHERE THEY ARE MADE: `capToolResults`
  (`ai/tools.ts`) wraps every builder tool's `toModelOutput` with
  `capToolOutput` (each string, then the whole result as the model reads
  it — long arrays kept head + tail with a `{ omitted, from, to }` gap,
  strings cut shorter, by the largest factor that fits; idempotent; env
  `STRUT_CHAT_TOOL_RESULT_MAX_CHARS`, default 50000, `0` disables), so
  the model reads the capped result in its own turn and `messages.jsonl`
  records exactly that (the uncapped output is in `events.jsonl`);
  `truncateToolMessages` applies the cap on replay: to a result the model
  READ (an assistant message came after it) only its strings, a no-op
  except for histories recorded before the cap moved; to a result nothing
  came after (its request refused) the whole cap, since nothing is bound
  to its bytes — the way out for a chat whose last result was over the
  window (swarm38, 2026-11-02: 5,622 rows in one `run_workflow`, every
  later turn `prompt is too long`). The two DOCUMENT reads
  (`get_workflow`, `get_step` — `DOCUMENT_TOOLS`) get the window's headroom
  with no ceiling at the source (`AiDeps.documentMaxChars`) and are skipped
  on replay: a 50k workflow is read whole, and `edit_workflow` /
  `edit_step` take `edits` (exact-string replacements) so even a cut one
  is editable without being resent. (2) The system prompt is
  rendered on a chat's first turn and stored (`ChatStore.getSystem` /
  `setSystem`, `chats/<id>/system.md`), then replayed verbatim: a step
  published mid-chat never re-renders the steps tree, and the model
  reads what changed through `list_steps` / `search_steps`. (3) When the
  window fills the turn COMPACTS instead of editing (plans/compaction.md
  §5; `src/compaction.ts`): after a step whose model call passed the mark
  (`STRUT_COMPACT_AT`, 0.9) — its tool results in, so never inside a tool
  round — the turn has the same model summarize everything it has seen,
  in one streamed call under the turn's own system prompt, tool
  definitions (without their `execute`) and cache options — the prefix the
  thinking blocks are bound to; a summarizer that dropped the tools would
  fail the preserved-thinking check and miss the whole cache — appends
  the summary as a `[compaction]` user message, sets `ChatMeta.replayFrom`
  to its index, emits `chat.compact` (the meter's floor rides on it), and
  goes on from the summary alone when the model was mid-task; a finished
  turn leaves the summary for the next one. Every later turn replays
  `messages.jsonl` from `replayFrom` (`POST /chat` and the notifier's
  wake-up both slice there). The file only grows, `GET /chat/:id` serves
  it whole, and the flyout shows the boundary as a collapsed card
  ("Compacted 612k tokens of history") that opens to the summary. A
  summarizer that fails, or stops short of `finishReason: stop`, is a
  warning: the turn goes on uncompacted and the next step boundary tries
  again.
  **Context meter:** each `step.finish` event carries `context: { used,
  limit }` — that model call's input (cached reads included) plus its
  output, against aieo's window for the model (`ResolvedModel.contextLimit`)
  — also written to `ChatMeta.context`; the flyout header shows it as
  `351k / 1M`, amber from 80% (`web/src/context-meter.ts`).
  `chatMaxSteps` (env `STRUT_CHAT_MAX_STEPS`, default 100) bounds the
  per-turn agent loop. The browser (`web/src/api.ts`: `sendChat` +
  `streamChat` + `getChat`) persists the active `chatId` in
  localStorage and reattaches to a still-live turn on reopen.
  **A restart mid-turn** (`reconcileStaleChat` + `autoResumeStaleChats` in
  createStrut — the chat twin of run auto-resume, the same
  `STRUT_AUTO_RESUME` gate on the CHAT store's kind): a chat left `live` by
  the dead process is reconciled on first sight — the boot scan 3 s after
  construction, or whichever read finds it first. Its dead turn gets
  `chat.error` (`chat.end` when that turn had asked the user: the question
  stays open, nothing else was lost), and with auto-resume on a
  `[restart-notification]` (`formatRestartNotification`, ai/notifier.ts) is
  appended that says what the event log knows and the transcript does not —
  the tool calls with no result yet, the detached runs that will never
  notify — and the chat is woken through the notifier like a run
  notification: counted against the auto-turn cap, so a turn that crashes
  the server every time parks after 10 restarts; appended but not launched
  past 7 days idle. `POST /chat` appends the notice and lets the typed
  message's turn follow. The host hears the dead turn's `turn.end` (no
  `trigger`; `settled: false` while the wake-up turn runs). Off: marked
  `error` on first read, nothing appended. The UI shows the notice as a
  "Server restarted" card.

- **Attachments — files on a builder message** (`src/ai/attachments.ts`).
  `POST /chat { attachments: [{ name, mediaType?, data }] }` (`data` base64
  or a data URL; the message may then be empty) — at most 10, 10 MB each, 5
  MB an image, 15 MB together, refused with a 400 before anything is
  persisted. Each file is written to `<dataDir>/uploads/<chatId>/` (never
  over an earlier one of the same name) and becomes parts of the user
  message after the typed text: an `[attachment] <name> (<type>, <size>) —
  saved at <absolute path>` line, then the image or PDF as a `file` part (the
  model sees it; verified direct and through the gateway), or the text
  inline — anything UTF-8, or a .docx / .doc's extracted text, cut at 200k
  chars — or nothing more (the builder reads it with bash). The bytes stay in
  `messages.jsonl` like any content, so they are replayed every turn until a
  compaction: hence the caps (Anthropic refuses a request over 32 MB). The
  flyout attaches by the paperclip, a drop on the flyout or a pasted
  screenshot, and shows the files as chips (`transcript.ts` `userContent`).
  **A run takes them too** — `POST …/run { attachments }`, the same shape
  and caps, a launch-level field beside `mcp` (a host's message to the
  orchestrator, the person's files with it).
  Saved under the run's ARTIFACTS as `attachments/<name>` before the first
  event (`saveRunAttachments`; a repeated name numbered), recorded on
  `run.start` as `attachments: [{ name, mediaType, size, path }]` — never
  the bytes, so a resume reads them back from there — and handed to every
  step as `ctx.attachments`. Every `agent` step of the run puts them on its
  prompt as the parts above (`attachments`, default true; a sub-agent never
  gets them — its prompt is its caller's words); in a session they are that
  turn's message, replayed like the chat's, and the turn line records them
  (`SessionTurn.attachments`). `job/start` / `job/continue` take
  `attachments: [name]`: the files the job needs — this turn's, or, from an
  agent with a `session`, one an EARLIER turn of its thread carried (the
  agent hands its tools those too, newest turn first, each with the `runId`
  that holds it; a name attached twice is the newest), so a file the
  person attached before answering a question still goes with the job.
  Read back from the artifacts of the run each came with and launched with
  the job's run, which keeps its own copies — the job does not see the
  conversation. A name no turn had is refused with the ones the
  conversation has. Refused for a builder job on a peer
  (strut/run-workflow carries no files).
- **Private AI — pseudonymization** (`specs/PRIVACY_SPEC.md`; `src/privacy/`,
  `privacy/*` steps, the seeded `private-ask`). Detect (deny > rule > heur >
  ner > llm, `Stage` pipeline) → typed numbered tokens → vault under a handle
  (`pvm_<24 hex>` in-process, `pvf_<24 hex>` encrypted file; no key-in-handle
  mode). The key is looked up in ONE place, `keys.ts`'s `KeyProvider`. NER runs
  in a worker thread of this process (`workerNer` over `ModelWorker`; the LLM
  detector in one of its own) and fails closed; a dropped span is a `warnings` entry, never
  silent, and no warning or log carries original text. The runner records step
  inputs/outputs, so raw text passed to a step is in run files: callers that
  must avoid that anonymize in their own step run and pass only masked text +
  handle on. `privacy_level` is reserved (only `off`).
  **The model wrapper** (specs/PRIVACY_SPEC.md §10; opt-in via the `privacy`
  setting of src/extensions.ts, off by default): an AI SDK middleware
  (`middleware.ts`) masks what a hosted provider is sent and restores what
  comes back, for every model `resolveModel()` builds — no workflow, step or
  tool changes. Each message part is masked ONCE and its masked form stored
  (`session.ts`, `transcript.ts` memory / `transcript-file.ts` under
  `<dataDir>/privacy/transcripts` with `STRUT_PRIVACY_TRANSCRIPTS=file` and a
  vault key; TTL `STRUT_PRIVACY_TRANSCRIPT_TTL_HOURS`); the model's own output is
  stored RAW and stamped (`providerMetadata.strutPrivacy`, `stamp.ts`) so later
  calls resend it byte for byte — the prompt cache and signed thinking need it.
  Tool-call inputs are restored before the tool runs (`tool-restore.ts`;
  `privacy: "keep"` on a step def opts a tool out); `tool-guard.ts` refuses an
  invented placeholder for a side-effecting tool (`tool-policy.ts`, `sideEffects:
  true` / `effect: "write"` on a def). `policy.ts` + `refine/` hold the per-type
  mask list (DATE, TIME, URL, LOC visible by default; URL and DATE refined).
  Everything privacy needs from core comes through `src/privacy/host.ts`, the
  only file there that imports from outside the folder; `privacy/boundary.test.ts`
  fails on any other import across the line, on a core file other than
  createStrut.ts / index.ts reaching into privacy/, and on the word in core code.
- **Claims, checks, evidence — the truth layer** (`plans/claims.md`; graph
  workspaces only, on by default there — on `STRUT_WORKSPACE_BACKEND=fs`,
  or with `STRUT_CLAIMS=0` / `createStrut({ claims: false })`, no claim
  tool is offered, `strut.claims` / `strut.verifier` are null, and nothing
  below runs. `createStrut` decides this once and threads the
  `ClaimsAuthoring | null` to every consumer; nothing else reads
  `workspace.graph`). A `Claim` states how a step or workflow should BEHAVE, a `Check`
  is an instrument that tests it (a registry step run over the subject, or
  an external check answered through a planned slot), `Evidence` is what
  one check observed on one run — all three are jarvis types, written
  through the ordinary node/edge writers. Status (`supported | refuted |
  stale | unknown`) is COMPUTED ON READ per (claim, subject) by
  `claimStatus()` and never stored. Authoring: the `claims` arg on the
  publish tools + `add_claim` / `edit_claim` / … and their `meta/*` twins
  (`src/claims-authoring.ts`), or a top-level **`claims:` block in the
  workflow YAML** — the arg's shape, in the file, shape-checked at every
  publish like `input:` (`readClaimsBlock`), merged with the arg by text,
  applied by every door (chat tools, `meta/publish-workflow`, `POST
  /workflows[/:name]`). It is how a SEEDED template carries its contract:
  `createStrut` records every workflow's active block at boot
  (`reconcileWorkflowClaims`, idempotent; speaker = the workflow's
  `publisher`, else `yaml`) and `strut.reconcileClaims()` re-runs it, so a
  seeder that writes YAML straight into the store needs no claims code. The
  block is content: it rides in the version hash, and a claim retired in
  the UI comes back at the next boot until the YAML drops it. Evidence: every top-level run is verified,
  detached, by `src/verify.ts`, hooked where `services.onRunEnd` fires;
  check runs carry `origin: "verify"` and are never verified. The builder
  reads its contract in tool RESULTS (`src/ledger.ts`): run results list
  the claims `pending`, and a `[verify-notification]` (or the run's
  `[run-notification]`, when the pass settles within 5 s —
  `src/ai/verify-waker.ts`) starts the next turn with each claim's status.
  Versions are recorded, never inferred: `run.start.stepHashes` /
  `workflowHash`, and a subflow step's `step.start.subflow` — no record, no
  evidence.
  **A JOB is the third subject kind** (`plans/job-claims.md`; `{ kind:
  "job", name: <id> }` on every door): a claim about the WORK — "the
  settings page renders" — not the template. Its node is `StrutJob`
  (upserted from the record by `ensureJobNode` when the first claim is
  written, since the projector only writes it at run end) and its version
  is the TURN: evidence is `ABOUT` the turn's `StrutRun` (the projector
  stamps `job` on it), the active version is the job's newest top-level run
  on the record (`activeTurnOf`; `ClaimsReader` takes a `jobs` dep for it),
  so a later turn makes the ledger `stale` and `claimStatus()` reads as it
  does — except that a job's stream has one measurement per pass, never a
  foreach's several. Fixed point 1 has one exception here, ruled: on a job
  an `ai` author may hang its instrument on a PERSON's claim (the person's
  external check stays beside it; edit / retire / detach stay scoped).
  Checks on a job default to `manual` whatever the step
  (`sample` refused): the work is verified when it is said to be ready —
  `meta/verify-job` (door one, the agent mid-turn, with THIS run as the
  version, accepted in flight) or `POST /jobs/:id/verify` (door two, a
  person, the newest turn) — through `verifier.verifyJob`, which skips a
  turn that is no longer the newest as `superseded` (a job check reads the
  LIVE app; nothing about a job is backfilled) and APPENDS on a re-verify
  of the same turn (evidence path `job:<id>#<n>`; the automatic pass writes
  `#0` and stays idempotent). A job check's input is the job's state from
  the index (`buildJobSubject`: `{{ input.urls.pod }}`, `{{ input.dir }}`),
  its run carries the job (`RunStepOptions.job`: a screenshot lands in the
  job's files; `origin: verify` keeps it off the job's run list, no hold)
  and is kept under `check:<id>` when its evidence points into those files.
  The ledger rides on `GET /jobs/:id` (`claims`), `GET /jobs/:id/claims`
  and `job/get` through `JobsCapability.claims`; a person's Supports /
  Refutes is `POST /claims/:id/evidence { job, runId }`. The `job` seed
  grants the claim tools and `http/verify`, and its prompt says: author the
  claims when the ask is understood, verify before saying done.

- **Sealed — what the meta surface may never touch** (`src/sealed.ts`;
  EVOLVE_SPEC §6). The `meta/*` steps publish only over names they stamped
  `ai` — a person hands one of theirs over with `PUT
  /workflows/:name/publisher { publisher: "ai" }` (the Workflow flyout's
  "Let the builder edit this"; never a seed, a sealed or `peer:` workflow,
  or another publisher's; `null` takes it back; a publish never moves the
  stamp) — but RUN, read the runs of, and verify any workflow except a sealed
  one — `sealed: true` at the top of its YAML, a grading harness whose run
  log records what its graders were handed — and run any step except a
  sealed one: the sealed namespaces (`eval/*`, `meta/*`, plus
  `STRUT_SEALED`) or `sealed: true` on its def (the lab's graders seal
  themselves; `gaia/*` is not sealed whole because `gaia/get-task` is the
  producer's door). A publish whose closure reaches one — the step by type,
  the workflow through a subflow, a grader in an `agentTools` grant — is
  refused, as is a candidate that seals itself or a step authored into a
  sealed namespace. So the job agent runs a seeded `pod-pr` through
  `meta/run-workflow`, and an evolve candidate still cannot run, read, or
  subflow its grader. Evidence is unchanged: only an unstamped harness
  records `observed`. The web editor's Publish carries `sealed:` (and
  `claims:`, `promotes:`) through from the version being edited.

- **Automations — run a workflow on a schedule** (`plans/automations.md`;
  `src/automations.ts` pure, `src/scheduler.ts` stateful). An automation is
  `{ id, name, enabled, trigger, input, callback? }`, stored as **workflow-level
  metadata beside `category`** (`WorkflowMetadata.automations`:
  `_metadata.json` on the filesystem, one JSON-string `automations`
  property on the `StrutWorkflow` node in the graph;
  `WorkspaceStore.setWorkflowAutomations`). It is NOT in the versioned
  YAML: adding, editing or pausing a schedule publishes no version, so it
  never re-fires `on_change` checks and a rollback never changes a
  schedule. The trigger is a **closed grammar** — never cron: `interval`
  (anchored: fires are `anchor + k·minutes`, `on` / `between` filter it),
  `day`, `week`, `month` (`day` 1–28 | `"last"` | nth weekday), `once`. A
  schedule the grammar cannot express is fixed by adding a shape. ONE
  implementation of the calendar math (`nextFire`) drives the form's
  preview (`POST /automations/preview`), the chat tool's result and the
  tick loop. **Nothing but the definition is persisted**: `nextRunAt` is
  memory-only and always computed from the current time (the first load
  from process start), so a restart neither stampedes nor double-fires and
  a run missed while the process was down is skipped; the tick advances
  `nextRunAt` BEFORE launching. A fire goes through `launchDetached` like
  `POST /run`, stamped `origin: "schedule"` + `automation: { id }` on
  `run.start` AND on the `RunSummary` — scheduled runs are verified like
  any other. An automation's `callback: { url }` (opt-in, set over HTTP
  only — the chat tool never sees it) is handed to every fire, so its
  `run.end` reaches the host like a `POST /run { callback }` launch's. The
  URL is a credential, so it lives in a fifth encrypted file beside
  `secrets.json` — `automation-callbacks.json` (`AUTOMATION_CALLBACKS_FILE`),
  keyed by the automation id — never in the deployment's secrets, which
  every step reads through `ctx.services.secrets` and `GET /secrets` lists;
  the record keeps `callback: { origin }` — no read of workflow metadata (the
  routes, the graph node) can serve it. Removing the automation, clearing
  the callback (`null`) or deleting the workflow deletes the entry. **Dynamic inputs**: `input` is resolved per fire against
  `{ now, today, last }`, `last` being this automation's latest SUCCESSFUL
  run (a newest-first scan of summaries, ≤100) — so a failed run never
  advances a cursor. `last` is never null (before the first success its
  `output` is `{}`) and a top-level key resolving to `undefined` is
  dropped. One fixed overlap rule, not a setting: a fire is skipped while
  that automation's previous run is still in flight (read from the run
  store, so it holds across a restart) — two overlapping runs would read
  the same cursor. Both doors are thin: the routes and the chat tools
  (`set_automation`'s RESULT carries `summary` + `next`, so the model
  confirms from computed facts) call the same `createAutomations` layer.
  UI is per-workflow: the topbar **Workflow** button opens `WorkflowFlyout`
  (the Automate tab is `AutomationsPanel`); scheduled workflows and scheduled
  runs carry a clock badge in the sidebar.

- **Deleting a workflow** (`DELETE /workflows/:name`, gated; the Workflow
  flyout's footer). Three layers, in order: `automations.forget` drops its
  schedules from the tick loop, `RunStore.deleteRuns` removes its run
  records, `WorkspaceStore.deleteWorkflow` removes every version + metadata
  (`rm -rf` of the workflow directory on files; soft-delete on the graph —
  nodes stamped `deleted_at`, their edges hard-deleted — with schedules /
  owner / cap / category cleared FIRST — the node writer restores a
  soft-deleted node on a key match, so a later publish under the same name
  must come back clean; it comes back with only the edges the publish writes). 409 while one of its runs is in flight;
  the run artifacts under `artifacts/<runId>/` are not touched.

- **Dispatch-mode `run_workflow` + run notifications**
  (`src/ai/notifier.ts`, `plans/dispatch-run-notifications.md`). The chat
  agent's `run_workflow` tool races the run against a wait window
  (`chatRunWaitMs`, env `STRUT_CHAT_RUN_WAIT_MS`, default 60s): a fast run
  returns synchronously as before; a run that outlives the window converts
  to DETACHED — the tool returns a `{ status: "running", detached: true,
  runId }` stub (a well-formed tool RESULT, so `messages.jsonl` never has a
  dangling tool call), the run is tracked in `activeRuns`, and when it
  settles the notifier WAKES the chat: it appends a slim user-role
  `[run-notification]` message (status, duration, truncated output — the
  agent has `get_run` for the rest) and launches the next turn through the
  same `launchChatTurn` path a human message uses. Notifications arriving
  while a turn is live queue and drain into ONE wake-up turn (via
  `launchChatTurn`'s `finally` → `notifier.turnEnded`). Liveness is an
  in-process set (not `meta.status` — stale after a crash; pending
  notifications die with the process — the `[restart-notification]` that
  wakes the chat after the restart names the runs that will never report). Runaway
  guard: `ChatMeta.autoTurns` counts consecutive machine-triggered turns
  since the last human message (`POST /chat` resets it); at
  `chatMaxAutoTurns` (env `STRUT_CHAT_MAX_AUTO_TURNS`, default 10) the chat
  PARKS — notifications still append to the transcript but no turn
  launches until a human replies. The seam is `AiDeps.detach` (absent →
  the tool awaits to completion, unchanged for tests/embedders). The tool
  is an async generator: its first yield, `{ status: "running", workflow,
  runId }`, is a preliminary result (a `tool-progress` chat event) the
  flyout opens the run on at LAUNCH, so the sidebar and canvas follow it
  live; only the last yield reaches the model (a direct `execute` caller
  drains it). The flyout polls `GET /chat/:id/meta` (~4s, idle+open only, one in flight; the transcript is loaded when the turn advanced) to notice
  server-initiated turns and renders `[run-notification]` /
  `[verify-notification]` messages as a collapsed notice card, not a user
  bubble (`web/src/notice.ts` parses the model-facing text —
  `notice.test.ts` runs it against the server's own formatters, so a
  format change there fails a test; `NoticeView` opens it level by level:
  card → claim → evidence + checks → raw message. Unparseable → the old
  dashed text notice).

- **Turn-end callbacks — how a HOST dispatches the builder**
  (`src/ai/turn-callback.ts`; the URL check + poster are `src/callback.ts`,
  shared with run callbacks). A turn takes seconds or hours, and one
  dispatch can produce SEVERAL turns (the detached-run / verify wake-ups
  above), so a host app does not tail or poll: `POST /chat { …, callback:
  { url } }` stores the URL on `ChatMeta.callback` — on the CHAT, so
  notification-triggered turns post too; `callback: null` clears it — and
  the 202 carries `callback: true` (the host's proof this server honors
  the field; an older one ignores it and would never call back). Every turn
  end POSTs `{ event: "turn.end", chatId, turn, status, trigger: "human" |
  "notification", text?, error?, settled, parked, elicitation? }` from `launchChatTurn`'s
  `finally`, AFTER the notifier's drain — so the chat is no longer live when
  the host hears (it may reply at once without a 409), unless queued
  notifications already launched the next turn. `settled: false` = something
  this process knows of will (or may) start another turn: an `expect()`
  token is outstanding (a detached run until its notification is delivered;
  a watched verify pass until its verdict is delivered, folded into the
  run's notification, or found to be nothing) or the next turn is already
  live. When the last token resolves WITHOUT a turn (a quiet verify pass; a
  notification that parked at the auto-turn cap) an `{ event: "settled" }`
  post follows — a host told `settled: false` always hears `settled: true`.
  `parked` = the auto-turn cap is reached. Posts are chained per chat
  (ordered), retried a few times, detached from the turn; state is
  in-process, the notifier's crash posture (a restart drops it — the host's
  fallback is `GET /chat/:id`). The URL is the credential (the host signs
  it): logs and read endpoints (`GET /chat/:id`, `/chats`) carry its origin
  only.

- **Elicitation — the builder asks the user, and secrets never touch a
  model** (`plans/elicitation.md`; `src/ai/elicitation.ts` pure, the rest
  in `ai/tools.ts` + `createStrut.ts`). Shapes are ACP's elicitation RFD:
  `mode: form | url`, `message`, a FLAT `requestedSchema` (string / number /
  integer / boolean, enum | oneOf selects, array-of-enum multi-selects — no
  nested objects), `action: accept | decline | cancel`, `content`,
  `elicitationId`. Two chat tools: `ask_user({ message, requestedSchema })`
  is form mode; `request_secret({ name, reason })` is URL mode for ONE
  secret — the server builds a RELATIVE link to its own page
  (`?chat=<id>&elicit=<eid>`), and the model, transcript, events, callback
  and logs only ever carry the NAME (`ask_user` refuses a field whose name
  or title looks like a credential). A select's options are what the model
  OFFERED, never a constraint: the form always ends a single or multi
  select with "Other…" (a text box; `FieldDesc.other`, set only by the
  question mapper, so a step's Zod enum stays strict), `validateContent`
  takes any string there, and the prompt tells the model the value is the
  user's own answer. The prompt also says a `decline` is not a pick: say
  what is needed in one line and stop — before this a user whose answer
  was not among the options hit Decline and watched the model choose for
  them (2026-10-12). **Transport:** the tool records the
  question on `ChatMeta.elicitation` (ONE per chat; a new ask replaces it,
  the replaced id comes back; persisted, so it survives a restart) and
  returns `{ elicitationId, status: "asked" }`; the agent's `stopWhen` ends
  the turn on a tool RESULT that asked (`stepAsked` — a refused ask does not
  end the turn, so the model can retry), a complete call with its result.
  The answer arrives as the next turn's user message,
  `[elicitation-response] <id> accept|decline|cancel [by <actor>]` (+ the
  content as JSON, or `— secret NAME stored (value not shown)`), through
  `POST /chat/:id/elicitations/:eid { action, content? }` or
  `…/:eid/secret { value }` (the name comes from the server's record, never
  the request; both behind `requireApiKey`; 404 once the question is
  closed). Both hand the message to `notifier.deliver(…, { human: true })`:
  `autoTurns` resets, the turn launches as `human`, or QUEUES behind a live
  one — so a form never sees a 409 (`POST /chat` keeps its 409, and closes
  the open question). Who answered is RECORDED (`by`), never checked against
  the chat's actor: the secret store is deployment-global, so the
  deployment's auth in front of the UI is the binding, as for `PUT
  /secrets`; the id is crypto-random because with the key unset the link is
  the authorization to write one named secret. **Hosts:** `turn.end`
  carries `elicitation` whenever a question is open, and when THIS turn
  asked it `text` IS the question — a host that only reads text still sees
  it and a prose reply through `POST /chat` answers it. **UI:** the flyout
  renders `meta.elicitation` as `ElicitationForm` (fields via
  `web/src/elicitation.ts` → `ConfigField`, which gained a `multi` kind
  and the `other` text box);
  the response renders as a notice card (`notice.ts`); `elicit` joins the
  embed deep-link params, set while open and dropped once closed. Tests: the
  pure module, the notifier's human path, the endpoints, a sentinel-secret
  no-leak test over transcript/events/meta/callbacks/logs/responses, and a
  fake provider proving the turn stops on an ask and goes on after a
  refused one (`chat-endpoints.test.ts`).

- **Agent sessions — a finished agent can be given another prompt**
  (`plans/agent-sessions.md`; `src/session-store.ts`, the `agent` step,
  `git/checkout`). `session: <id>` on an `agent` step makes it CONTINUE a
  thread: it opens the session (`ctx.services.sessions.open`, which takes
  the session's in-process lock — a second turn fails `session_busy:`),
  sends the thread's system prompt and messages followed by this turn's
  prompt, and on success appends the turn; a failed or cancelled turn
  appends nothing. The lock is also let go when the run ends, so a turn a
  force-cancel abandoned (run-control.ts `raceForce`) never holds the thread
  past its run; should it wake later, its commit is refused
  (`session_released:`). The id is a flat, GLOBAL string the CALLER supplies
  (usually `"{{ input.session }}"`, a uuid) — no run-level field, no chain
  of runs: any run of any workflow naming it joins, so the unit stays one
  run per turn. Which agents of a workflow remember is per step: several
  agents take different ids (`"{{ input.session }}/review"`; a slash is
  part of the name, not a hierarchy), an agent without `session` starts
  cold. The id format is strict (`idProblem`) because a multi-segment
  template renders a missing value as `""` — `/review` would otherwise be
  one thread shared by every run that forgot an id.
  **The record** is a second store (`SessionStore`, File + Memory; the
  default follows the CHAT store's kind): `system.md` written by turn 0 and
  never again, append-only `messages.jsonl`, and `turns.jsonl`, one line per
  successful turn (who, which run and step, provider, model, `offset` /
  `count`, usage, the context after it) — the turn line is the commit. The
  run log records the TURN (`step.end.messages` = the system prompt + this
  turn), so logs grow linearly; `GET …/transcripts/<path>?full=1` stitches
  the thread to that turn from the store. The step's output gains
  `session: { id, turn, offset }`.
  **History is append-only**, the chat's rule: the system prompt is frozen
  by the first turn (a later step's `system` is ignored, one warn line) and
  the messages are replayed as stored, so every request begins with the
  previous one byte for byte. `retain` replaces what a
  compaction's summary is told to keep (`AGENT_RETAIN`: files, commands) with
  the caller's own references. Tools, output mode and `maxSteps` are the
  current step's. Whether calls are routed through the gateway is fixed
  by the first turn (`session_mismatch:`); the model and the provider may
  change — each provider's converter drops thinking it cannot verify —
  unless the replayed thread holds another provider's server-run tool calls
  (Anthropic's web tools, direct only; `session_mismatch:` too). A thread the
  last turn left past the compaction mark (`STRUT_COMPACT_AT`, 0.9 of the
  resolved model's window) is summarized AT OPEN: the `[compaction]`
  message leads this turn, the committed line's `replayFrom` points at it,
  and the next turn replays `messages.slice(replayFrom)` — the thread is
  still whole on disk (plans/compaction.md §3). The same happens BETWEEN
  STEPS when a turn itself crosses the mark: the loop stops after the step
  (its tool results in), summarizes the request so far under its own
  system, tools and provider options, pushes the summary onto the record
  and continues from it alone, with one nested `compaction` event beside
  the tool calls (`<agentPath>/NNN-compaction`) and `compactions: n` on the
  output. One `bash` / `view` result, and what the model reads of one
  `agentTools` step's (`capToolOutput`: each string, then the whole), is
  capped at the window's headroom below the mark (`BASH_MAX_CHARS` is the
  ceiling). With compaction off (`STRUT_COMPACT_AT=1`) a thread over 90%
  is refused before any model call (`session_full:`). An `agent` called as
  a TOOL cannot take a session: the model would be choosing the id.
  **The files** follow through `workdir` on `git/checkout`, a name of its
  own (usually the job, `"{{ $job }}"`): the working copy lives inside
  that job's directory, `<dataDir>/jobs/<name>/<repo>` — the same path
  every run, the transcript is full of it — is left as the last run left
  it (`reused: true`; `ref` only applies when it is created), is held by
  one RUN at a time (`job_busy:`; a child run launched by
  `meta/run-workflow` shares it), and is removed once the job is idle
  for `STRUT_WORKDIR_TTL_DAYS` by the next kept checkout or `job/dir`.
  **Run control:** a journaled session step replays its output on resume
  and never reaches the store; "re-run from here" on one is a NEW turn — a
  thread is never rewound. **In the graph** the projector stamps each
  `StrutAgentSession` — one execution, so one TURN — with `session_id`
  (from `step.start`'s resolved config: a failed turn is grouped too) and
  `session_turn` (from the output: committed turns only), so "which nodes
  did this thread touch" is one query over `session_id` → `IN_SESSION` →
  `ACCESSED`, and keeps the turn's `message` and `reply` whole, so what
  was said in a thread is searchable. Endpoints (`/sessions`, all behind the key,
  reads included; the id is a query parameter): list, one session's turn
  log, its messages, delete (409 while held). Tests:
  `storage-conformance.test.ts` (the store), `steps/core/agent-session.test.ts`
  (what a turn puts on the wire, against a stand-in provider),
  `sessions.test.ts` (runs over HTTP + the routes), `git.test.ts` (kept
  working copies).

- **One wake — a conversation hears its job's reply** (`plans/jamie-app.md`
  §1; `src/wake.ts`). A job turn that ends naming a conversation on this
  strut (job/start's `startedBy.session`, a host launch's `conversation`, or
  `POST /conversations/wake` for a job on another strut) runs one more turn
  of the conversation's workflow, its prompt the template's `params.wake`:
  Hive's web chat, a tribe, a call and Peel's DM all get the same wake, so
  no host keeps its own. The job's run.end says `wake: "launched" | "capped"
  | "none"`; the wake turn's says `wake: { job, runId }`; the 202 of a
  conversation launch says `wake: true`, which is how a host knows to stop
  waking itself (§7). Specs: `CALLBACKS.md` §9, `API.md` §3.
- **Jobs — one directory and one memory across many runs**
  (`plans/jobs.md`; `src/jobs.ts`, `src/artifact-refs.ts`, `steps/lib/job/dir.ts`).
  A host hands strut work as a *job*: `POST …/run { job: "<id>" }` — a
  flat, global id the CALLER mints (the session-id format), beside `input`
  and `callback`, never in `input`. It is recorded on `run.start` and the
  summary, handed to every step as `ctx.job`, seen by templates as
  `{{ $job }}` (always a key in scope — `undefined` on a plain run, so
  `session: "{{ $job }}"` is a cold agent then, not an error), and kept by a
  durable resume. `job/dir` returns `<dataDir>/jobs/<id>/`, the SAME
  directory for every run of the job, held by one run at a time
  (`job_busy:`; a child run launched by `meta/run-workflow` shares it — the
  child carries the job, and `holdJob` walks `ctx.control`'s parent chain),
  and the generalization of yesterday's `workdir`:
  `git/checkout { workdir: "{{ $job }}" }` checks repositories out INTO it,
  the idle sweep removes those and keeps the job's own files. So a job
  workflow is `job/dir → agent (cwd: the dir, session: "{{ $job }}") →
  pack`, and turn twelve opens the `plan.md` turn three wrote with a
  transcript that remembers writing it; without a job the same YAML is a
  one-shot in the run's artifact dir. **Deliverables** are declared in
  the run's OUTPUT, `artifacts: [{ id, kind?, title, path | url | content }]`
  (`specs/CALLBACKS.md` §4): the `run.end` callback (and `GET
  …/runs/:runId/artifacts`) carries them resolved — `path` →
  `/jobs/<id>/files/<path>` (served like `/artifacts`, sandboxed) or
  `/artifacts/<runId>/<path>`, `kind` from the extension when omitted, an
  `error` when a file is not there — while `output` stays as packed. The
  same `id` on a later run is a newer version of the same thing; one live
  file behind one link is the contract (no snapshots). The job agent is the one
  WORKFLOW strut SHIPS, `job` (`src/workflows/job.yaml`, seeded at boot by
  `createStrut` through `src/job-seed.ts` — moved out of the mcp lab's seed
  on 2026-10-13: every job primitive was already strut's, and a standalone
  strut had a Jobs sidebar with nothing to run in it); its `params.tools`
  grow on the swarm, and a host appends its own grants and prompt section
  through `createStrut({ job: { tools, system } })` — the lab adds `pod/*`,
  a desktop strut adds nothing. A `context/concept` step reads the `Job`
  Concept (seeded by strut, `src/concepts/Job.md`; `params.concept`) and the
  kinds under it into the end of the agent's system prompt, the way the
  builder's prompt reads `Workflow Builder`, so the agent sees them before
  it acts and opens the matching page: which workflow does which kind of
  work is its children, graph data, never prompt text. The thread keeps its
  first turn's prompt, so a job keeps the list it began with. The host's
  side (mint an id, launch, store the refs, proxy a link) is closed by design.
  **Holds** (§6): a tool that claims something that must outlive the run —
  a pod — records it on the job through `ctx.services.jobs.hold(job, { id,
  kind, release: { type, input } })`, naming the registry step that lets it
  go; the tool that releases it calls `release`. Strut runs the release
  steps (a bare type's active version, under a minimal context: the bag,
  the registry, the job) when the job is deleted — `DELETE /jobs/:id`,
  which then removes repositories, directory and record; 409 while a run
  holds it, 500 and nothing removed when a hold will not release — and
  from the idle sweep, which lets holds go before it removes repositories
  (a hold that fails stays for the next sweep; a bare run with no registry
  leaves jobs with holds alone). Strut knows nothing about pods: a hold is
  an id, a kind and a way to be released.
  **The index** (plans/job-index.md; `src/job-index.ts`): a job you can
  name, find and read back. `POST …/run { job, title }` names it — the
  title is a launch-level field like `job` and `callback`, never in `input`
  (the workflow's `input:` block would strip it, and strut must write it
  onto the record without knowing the workflow); the RUNNER records every
  run launched under a job as one line on its record, at `run.start`,
  through `ctx.services.jobs.recordRun` (children with `parentRunId`;
  a resume records nothing), so a job's record is the job's history and the
  sweep keeps one that has runs. A session's turn line records the `job` it
  was made under (`SessionInfo.jobs`). `GET /jobs?q=` and `GET /jobs/:id`
  read it all back — runs with status, threads, holds, files, and the
  job's CURRENT deliverables folded from its runs' outputs (the "same id =
  newer version" rule of §3 made real: newest run first, first id wins,
  nothing stored) — and `job/list` / `job/get` / `job/read` are the same
  reads as steps the job seed grants, so a turn can find an earlier job by
  words, see what it produced, look at a screenshot it took, and learn the
  thread id to continue. On a graph workspace the projector stamps `job` on
  `StrutRun` / `StrutAgentSession` and upserts one `StrutJob` node per job
  (title + a summary of its deliverables and latest reply; `IN_JOB` from
  each run) in the run-end hook, so `graph/graph-search` finds a job by
  meaning. Each current deliverable is a `StrutArtifact` too (one per job
  and artifact id, the fold's newest version: `HAS_ARTIFACT` from the job,
  `DELIVERED` from each run whose output declared it; another strut
  server's deliverable and one with an `error` are left out). Not
  yet: `job` on chats, a jobs sidebar, continuing ANOTHER job's thread from
  inside a turn (its files are in the other directory; `session_busy:`).
  **An app reaches a job BY NAME** (2026-10-22): the `builder` publishes
  it and lists `{ id, kind: "app", title, app: "<name>", version? }` in
  its reply, resolved to the version's document with `app: { name,
  version, hash, builtAt }` (artifact-refs.ts); a job that ran the builder
  passes the entry on, and a page over the job's OWN results is an HTML
  file in its directory. The `Job App` kind and the job seed's `app/init`,
  `app/build`, `app/get` are retired — three doors to an app confused the
  orchestrator; the job-app RUNTIME went after it (a directory's own
  identity and narrowed token, the implicit own-job grant, "Publish as an
  app" — plans/chained-orchestrators.md §6): a `{ kind: "app", path }`
  entry is an error saying to hand the app over by name.

- **Live feeds — what a job and the graph are doing, for a reader that
  cannot be called** (`plans/live-feeds.md`; `src/live-feed.ts`,
  `src/graph-writes.ts`). A host hears a job on its `jobCallback`; an app's
  page can open no connection and has none. So every `job.update` is also
  KEPT (per job, the newest state of each thing, in memory) and read with a
  cursor that may WAIT — `job/updates` / `GET /jobs/:id/updates`, kit
  `useJobUpdates` — and every graph write a run makes through strut's
  writers is HEARD: `bindGraph` wraps the run's `services.graph` writers,
  the run's job gets `job.update { kind: "graph" }` (cumulative, a second
  after the last write and at the run's end — which is what makes Hive's
  canvas re-read the cards a brainstorm just wrote, not when the job ends),
  and the deployment's `graphChanges` feed keeps ids, types and time for
  `graph/changes` / `GET /graph/changes` / kit `useGraphChanges`, whoever
  wrote. A run says what it is doing with `job/status { title }` (`kind:
  "status"`, one line per run). Cursors are `<epoch>.<seq>`: a restart
  empties the feeds and the next read says `reset: true` — a feed is a
  notification, never the record. Not heard: raw Cypher, another process's
  writes.
- **Jobs sidebar — the operator's view of a job** (`plans/jobs-sidebar.md`;
  `src/job-threads.ts`, `web/src/components/JobTimeline.tsx`). The first-class
  item in a job is a THREAD, not a run: `GET /jobs/:id` folds every agent
  execution in the job's runs' logs — a `step.end` carrying `messages`, or an
  attempt of the core `agent` step — into threads by session id (a cold agent
  is a thread of one), each turn pointing at its run and step path with its
  usage, cost, context, tool calls, transcript link and the artifacts the run
  declared, and under it what it spawned (a sub-agent by path, a child run by
  `parentRunId`, a `strut/run-workflow` peer run). Nothing in it names a
  workflow or a step id, so the seed can rename `work` and the view holds. An
  agent strut did not run (the pod's goose) is a tool call until its step
  marks its output with `withMessages`; then it is a row like any sub-agent.
  The UI: the sidebar's history panel — ONE slot below Workflows, **Runs |
  Jobs** in its title row, the two lists sliding between them, the mode
  remembered in localStorage (`historyMode`), both scoped to the selected
  workflow (`GET /jobs?q=&workflow=`) — the timeline in the canvas area when
  a job is selected (the workflow stays selected underneath as that filter,
  so the list you clicked in never reshuffles; `timelineOpen` = a job and no
  run, and the topbar is the job's then; a run opened from it keeps the job
  for the breadcrumb, `?job=` deep-links), a read-only thread view in the
  flyout (the chat's renderer, lifted into `Transcript.tsx` /
  `transcript.ts`), and a job chip on a run's row. No send box: a host
  launches turns.
- **Proposals — a tool call a person approves before it runs**
  (`plans/proposals.md`; `src/proposals.ts`, the `agent` step's `approve:`).
  Jamie's `propose_*` tools, generalized: there are no proposal TYPES. An
  `agent` step names registry steps in `approve:` beside `agentTools`
  (globs as there; `params.approve` on the `job` and `orchestrator` seeds,
  filled by the host's delta — `createStrut({ orchestrator: { approve } })`,
  `STRUT_HOST_CONFIG`'s `approve`). A gated tool keeps its name and schema
  (plus `rationale`), but a call does not run the step: the gate parses the
  input with the step's own schema (a bad one is refused to the model as a
  direct call would be), writes the record to `<dataDir>/proposals/<id>.json`,
  journals the call at `<agent path>#<call>` (a resumed turn gets the same
  proposal), tells the job's host (`job.update { kind: "proposal" }`) and
  returns `{ proposal, status: "pending", url }` — the turn goes on (no
  `withStop`; ending the turn stays the automation steps' and Peel's device
  requests' way, for a decision awaited inside the turn). The same step is
  an immediate write in a janitor automation and a proposal in a chat; the
  WORKFLOW decides, never the model. A person decides at `POST
  /proposals/:id/decide { action: accept | reject, input?, reason? }` —
  hive's card, strut's own run overview and job timeline, a host's route —
  and on accept strut runs the step then and there with the recorded input
  (the person's edits merged one level and re-parsed by the step's schema;
  400 and still pending when they do not fit) under a minimal context
  (`releaseWith`'s: the bag with `secrets` bound to the proposing run's
  principal, the registry, the job, the decider as `ctx.actor`, the run's
  MCP servers best effort), recording `result: { output | error }`; reject
  records the reason and runs nothing. A decided proposal is final (409 with
  the record — a double click does nothing twice); a `failed` apply may be
  accepted again. Never a model turn: the proposing SESSION is told on its
  next turn, in code — one `[proposal-result] <id> applied|rejected|failed ·
  <step> "<title>"` line per decision before the prompt, stamped
  `reportedAt` when the turn commits. `run.end` carries `proposals:
  [{ id, step, title, status, url, rationale? }]` beside `artifacts`, from
  the records (`GET …/runs/:runId/proposals` is the same list; `GET
  /proposals?job=&session=&runId=&status=`, `GET /proposals/:id` the
  records — a person token (`peer:person`) lists only the proposals of its
  own threads (`by.conversation`, else `by.session`, is `<actor>` or
  `<actor>/…`: a proposal shows where it was made, so a Hive chat's is
  answered in Hive and never listed to the person's device), decides only
  its own, and reads any by id, as it already reads every run's log and a
  job's files, plans/proposal-links.md; the plain `peer` none); the
  `proposal/list` + `proposal/get` steps are the agent's reads; `proposal/decide` is strut's own app's door (first-party only). The host's
  card renders by `step` — `graph/create-node`'s input is what hive's
  `graphNodeCreate` card draws — and a generic one from the
  step's schema (`GET /steps/:type/schema`). V1 gates the graph and Concept
  writes (`graph/create-node`, `edit-node`, `create-triplet`,
  `create-batch-triplet`, `move-node`, `delete-edge`, `delete-node`; a
  Concept is a node of type `Concept`); hive-owned rows (initiatives,
  milestones, prompts) come later as lab `hive/*` steps with nothing new
  here. Not yet: MCP tools behind the gate (the apply would need the
  launch's credential), a step's `describe` hook for a card's preview,
  `approveWait` (a decision awaited inside the turn), expiry, grouping
  (`after`). **In the graph** each proposal is a `StrutProposal`
  (`projectProposalOnce`, graph/projector.ts): a projection of the record,
  written when the call is made, again when its run ends (`IN_RUN` the
  run) and at each decision and apply (`ACCESSED` to each node the apply
  wrote that the graph holds) — the title, step, rationale, who and what
  was decided, never the input or the result. The record stays what every
  list reads; the node is for what points at a proposal and for search
  (`graph-search { types: ["StrutProposal"] }` finds one by why it was
  made). `graph/project` backfills the proposals of the runs it projects.
- **Apps — a front-end project over workflows** (`plans/apps.md`;
  `src/apps/`, `src/steps/lib/app/`, the `/apps` routes; work item 1b of
  the plan — the object, the build, the steps, the routes). An app is a
  DIRECTORY: `app.yaml` (the manifest — title, `grants` { workflows, steps,
  sqlite, automations }, the graph types it declares, `csp.resourceDomains`),
  `src/` (TSX, its own shadcn overrides, CSS), `public/`, `db/`. The BUILD
  (`buildApp`, lazy-imported) bundles the entry against the KIT — `kit/`,
  `@strut/kit`: a frozen vendor layer of React, Tailwind, shadcn and the
  popular chart, motion and data libraries, the MCP Apps bootstrap, the
  hooks (`kit/README.md`) — into ONE self-contained document,
  `dist/index.html`, beside `dist/build.json`; never `node_modules`, never
  fetched at runtime. The resolver's rules are the contract a model learns
  from its errors: a relative import stays inside the directory, `@/…` is
  the app's `src/` then the kit's, a bare specifier is the kit's or an
  INSTALLED APP's `src/` compiled in (`strut/views`, `hive/ui@v3` — a kit is
  an app other apps import, §3.4; a cycle is an error naming the chain),
  anything else an error naming the set and the kits. `dangerouslySetInnerHTML`,
  `eval` and `new Function` are refused; a global `fetch` is a WARNING
  naming the hook (the document's CSP has `connect-src 'none'`: the page
  reaches strut only through its bridge). **Versions are TREE HASHES**
  (`treeHash`, `src/version.ts`: `<path>\0<sha256>\n` per file, sorted;
  `dist/` and `data.db` left out, the kit never in it — the same function
  `marketplace.md` uses for a package digest): `publishApp` follows
  `publishStep` — identical content re-activates (`reactivateKnown`
  honored), else the next `vN`; `upstream` rides on a version and is
  carried forward by a publish over the name. **The store holds pointers,
  the files live under `dataDir`** on every backend: `apps/<name>/_metadata.json`
  on files; `StrutApp` + `StrutAppVersion` (`exact_key`, `VERSION_OF`,
  `ACTIVE_VERSION`, `USES_WORKFLOW` → the workflows the grants name) on the
  graph, manifest and hash and never a file; `materializeAppVersion` is the
  directory's path, `<dataDir>/apps/<name>/<vN>/`, `dist/` included — a graph
  copied without its dataDir loses them as it loses artifacts, and
  `app/get` says `missing`. That directory is a CACHE over the version's
  history (`src/apps/objects.ts`, 2026-10-23): a publish records each source
  file once by its sha256 plus the version's tree; the active version and
  the newest five keep their directory, an older one is restored and rebuilt
  (~2 s) the first time it is read (`ensure` in apps.ts — every read goes
  through it) and a rollback to one that no longer builds is refused; the
  boot's `apps.compact()` records versions published before it. The
  document is served with an `ETag` (`private, no-cache`), so a host's
  `If-None-Match` is a 304 while the version is unchanged. The fs → graph import carries the pointers; the
  directories stay. **A publish builds first** (`createApps`,
  `ctx.services.apps`): a failing build publishes nothing. **Follow latest
  or hold a release** (plans/app-releases.md, 2026-10-23): by default every
  publish is what people open; `PUT /apps/:name/active { version }` makes a
  RELEASE — the version plus a LOCK on every workflow it grants, the
  subflows they reach and the custom steps the closure reaches, taken then
  (src/apps/releases.ts) — and holds the app at it: `active` is the live
  release's version, a publish is a DRAFT (`live: false`, the builder hands
  it over with its `version`), `{ release }` rolls back, `{ version:
  "latest" }` follows again; `AppMetadata.releases` / `live` (`StrutApp`'s
  JSON `releases` and `live` on the graph), a release's version never
  evicted, a seeded app never held. PINNING HOLDS: `PUT /apps/:name/pin`
  (and `app/pin`) on an app that follows latest makes a release of the
  version it shows; unpinning leaves the hold. Runs keeping to the lock is the plan's
  work item 2. **The file route
  is the app's identity**: `GET /apps/:name/:version/files[/<path>]` is
  served exactly as a run's artifacts are — the listing mints the app's FILE
  TOKEN (scope `app:<name>@<vN>`, `fileScopeOf` in auth.ts), a file opens
  with `?t=`, and `dist/index.html` read by token carries the token written
  into `<meta name="strut-app-token">` (the kit's bootstrap reads it and
  sends it as `step_run`'s `app` argument, 1c) under `CSP: sandbox
  allow-scripts`; read by the key it carries no meta and runs no script, so
  no document ever reads a credential off its URL. **Who may grant what**
  (§9): `app/publish` — the meta surface, stamped `publisher: "ai"` —
  refuses `llm`, `agent` and `exec` in `grants.steps` (the workflow is the
  unit of spend), a sealed step and a sealed workflow; `POST /apps` is a
  person's door and may grant anything, the `peer: true` precedent.
  **The backend and the hosts (work item 1c).** The page's identity is
  what the served document carries: `app:<name>@<vN>.<token>` — the scope
  and the file token minted for it (`appIdentity` / `appOfIdentity`,
  auth.ts; on a strut with no secret to sign one, the scope alone, dev
  mode's open posture) — and the kit sends it as `step_run`'s `app`. **One
  tool, `step_run`** (`src/apps/tools.ts`, `buildAppTools`), served APP-ONLY
  on BOTH MCP doors (`toolsetServer`'s per-tool `_meta`, `ui.visibility:
  ["app"]`; `builderServer({ tools, meta })`): every host relays a frame's
  `tools/call` there as it is, and strut checks the call against that
  app's manifest — `run/*` only on `grants.workflows`, any other type only
  when `grants.steps` names it, `llm` / `agent` / `exec` / `acp/prompt` and
  a sealed step refused at CALL time whatever the manifest says (the
  workflow is the unit of spend), a graph write refused on a type
  `data.graph` does not declare, or one strut keeps (the node read first
  for an edit or delete by `ref_id`, so a Concept is never rewritten),
  `sqlite/*` /
  `automation/*` / `job/start` "not available yet" — then runs it through
  `runStep` as the viewer (the connection's actor, who also pays) with
  **`ctx.app = { name, version }`** set (`RunStepOptions.app`; the twin of
  `ctx.job`: on `StepContext`, `RunOptions`, `run.start` and the summary,
  beside `origin: "app"`; never from a launch body). A write — a graph
  write, `app/report-error` — is a KEPT run under `step:<type>` with the
  actor and `app` on its summary; a read is not. **The `run/*` steps**
  (`src/steps/lib/run/`, over `ctx.services.runs`, src/runs.ts) are runs as
  steps, unsealed: what the kit's hooks name, grantable to an agent; a run
  `run/launch` starts for an app records `origin: "app"` + `app` and its
  steps see `ctx.app`; `key` dedupes in flight; `run/transcript` reads an
  agent's session by step path — the run log hands one out as a link, and
  a page cannot fetch. **Strut's UI is a host**
  (`web/src/app-host.ts`, `components/AppHost.tsx`): an Apps section at the
  bottom of the sidebar, below Tools (collapsible; one of the two open at a
  time), the page in the canvas area (`?app=`), the document fetched by
  token and framed as srcdoc under `sandbox="allow-scripts"`, ext-apps'
  `AppBridge` over the MCP SDK's client at `/mcp` with the UI's credential,
  `ui/message` → the builder chat, `ui/open-link` → the SPA, the version
  chip and its Versions flyout as the rollback, **Edit with the builder**, an app chip on the
  runs an app launched, the Workflow flyout's "Used by" chips. **The
  builder** gets the `app/*` steps as named tools (`buildTools` through
  `buildRegistryTools`, grant `app/*` — beside the package store's three
  reads, `package/search`, `package/get`, `package/concepts`, by name; app
  paths resolve against the data directory under no run) and the text editor (`str_replace_based_edit_tool`
  over `textEdit`, sandboxed to the data directory, offered with `shell`);
  the `builder` seed's `params.tools` gains `app/*` and `params.builtins`
  the editor family (`str_replace_based_edit_tool`, `repo_overview`,
  `fulltext_search`), still no bash; the `App` Concept page
  (`src/concepts/App.md`, under `Workflow Builder`) is the builders'
  prompt (and tells the builder to hand a published app over by name,
  `{ kind: "app", app }`, never as a directory); the `Job App` page under
  `Job` is retired (2026-10-22). **`strut/views` (work item 6):** strut's own components are an
  app, seeded at boot by tree hash (`src/apps/views-seed.ts`, `views:
  false`), that an app imports by name — `import { RunTimeline, RunGraph,
  LaunchForm } from "strut/views"` — compiled into its document, tree-shaken,
  running on ITS grants; the folds they draw are the kit's
  (`kit/src/folds/`, `@strut/kit/folds`, which `web/` imports too). The kit's
  vendor layer is a frozen MODULE TREE since kit 0.2, so every app
  tree-shakes from the original modules: a small app is ~0.6 MB, the 1c
  benchmark app 0.96 MB (it was 2.48). **`strut/jamie`** (plans/jamie-app.md
  §5): Jamie, the person's assistant — Hive's org-page chat ported onto
  steps — seeded after strut/views (whose components it imports),
  first-party (`jamie: false` seeds none; `strut/assistant`, its name
  before, is removed at boot); the conversation list and thread over
  `conversation/*` (each row with its jobs and their pull requests), turns
  over `run/launch` of `orchestrator`, the `llm/models` picker, job,
  proposal and pull-request cards (live checks, Merge, Fix), deliverables
  inline or handed to the host (`?artifact=`, `?app=`). **`strut/knowledge`**
  (plans/knowledge-app.md): the Concept tree, in place of Hive's org graph
  view — seeded after strut/views, first-party (`knowledge: false` seeds
  none); an outline over `graph/find` + `graph/graph-edges` beside the graph
  (`NodeGraph`, the main view), the concept a click picks in a panel with
  its docs as markdown, read-only; `NodeSearch`, and
  `?input=concept%3D<ref_id>`. **Job apps (work item 2)** are retired, runtime and all
  (plans/chained-orchestrators.md §6). **Graph types (work item 4), on
  Neo4j only:** an app's `data.graph` is checked against the graph at
  every build and registered at publish, before the version, add-only
  (`src/apps/graph-types.ts`); a LadybugDB file keeps its closed registry,
  so there (and with no graph) such an app does not build; a page reads a
  list of them with `graph/find`. Later items: SQLite (3), MCP resources
  and `app_<name>` tools (5), automations under `ctx.app` (7), packages (8).
- **The assistant in an app — `orchestrator` granted by a person**
  (`src/apps/grants.ts`). An app whose chat should be the person's
  assistant (start jobs, follow them) grants the sealed `orchestrator`
  workflow and uses the kit's `useAssistant()`. The friction is at
  CREATION, none at use: a sealed workflow is never a model's to grant
  (`app/publish` refuses it, its error telling the builder to report the
  need), so the orchestrator — whose template holds `app/grant` in
  `params.tools` AND `params.approve` — asks for it as a PROPOSAL, the card
  Hive's Jamie chat and Peel's DM already draw, and strut records the grant
  on the person's yes (`app/grant` refuses without `ctx.proposal`). A
  person's own `POST /apps` naming a sealed workflow, a package install
  among them, records the grant too; `GET/POST/DELETE /apps/:name/grants`
  is the person's door. The grant is on the app's NAME (it may come before
  the first publish; deleting the app drops it). With it, the `run/*`
  doors (`ctx.services.runs`, `openFlow` in createStrut) open the workflow
  to that app's pages SCOPED: a page reaches only the runs the app launched
  for the same viewer (`ownRun`; a sealed workflow's runs are its people's
  conversations), its launch `key` is its own. A run an app launched
  (`ctx.app`) opens its agent sessions under `app/<name>/<viewer>/`
  (`appSessionId`, runner.ts `bindApp`; the run's own job id as it is), so
  a page never opens the viewer's host conversation or another viewer's;
  `job/start` mints and `job/continue` scopes job ids under `app/<name>/`,
  where the page reads them; the agent leaves out every tool its `approve:`
  gates (nothing shows an app turn's proposals, and a page must not decide
  them); no MCP rides along (a page's call carries none). Revoking the
  grant stops the calls; the published versions keep naming it.

- **Peers — calling a workflow on another strut** (`plans/federation.md`
  §2.2, §3; `src/peers.ts`, `src/steps/lib/strut/run-workflow.ts`). A strut
  knows nothing about other struts; a host may tell it its OWN workspace (`self`: `PUT /self`, `STRUT_SELF`, `createStrut({ self })` — `{ id?, label?, description?, repos? }`, kept apart from the peers). A **peer** is a
  record someone put here — `PUT /peers/:id { baseUrl, token, label?, description?, repos? }`
  (hive pushes one per workspace swarm, id = the workspace slug, what a
  person types as `@slug`) or `STRUT_PEERS` / `createStrut({ peers })` on a
  strut nobody can push to — kept in a fourth encrypted file, `peers.json`.
  `GET /peers` lists ids, labels and base URLs; a token has no read route. `GET`/`PUT`/`DELETE /self` is this strut's own record, never in `/peers`.
  Steps get `ctx.services.peers`: name a peer, make a request, the token
  injected inside; the builder gets `list_peers` and `peer` on
  `list_workflows` / `get_workflow` / `run_workflow`. **`strut/run-workflow`**
  launches `POST {peer}/workflows/:name/run` with this run's principal as
  `x-strut-actor` — so the peer bills that person from its own delegation
  and binds `secrets` to them; nothing crosses — and waits on the peer's
  SSE tail, reattaching with `?skip=N` after a dropped connection. The tail
  is reader-initiated by design: a desktop strut behind NAT can call a cloud
  one, while a callback would need a route back. Cancelling the caller's
  run POSTs cancel to the peer; `wait: false` returns the handle;
  `job` is explicit and never this run's own (no shared directory across
  struts — the peer's job is a different job of the same name, kept there
  as `peer/<job>`). The peer runs only a workflow whose YAML says `peer:
  true`, as published (no `params`). The output
  is the peer's result; each entry of its `artifacts` comes back tagged `{
  peer, job }` (the job as the peer holds it) and is never resolved here —
  `run.end` carries it as it came, the Jobs view badges it and opens it
  through the read-through below, the host resolves it against the peer
  (`specs/CALLBACKS.md` §4). A refused
  launch fails the step with the peer's message (not open to peers,
  `job_busy:`); an id not on
  file is `peer_unknown:`; a peer that stays unreachable is
  `peer_unreachable:`. The token to give a peer record is the peer's
  `STRUT_PEER_KEY` (see "Auth": read, launch, control what it launched),
  never its deployment key. **Read-through, the files slice**
  (plans/chained-orchestrators.md §5): `GET /peers/:id/jobs/:job/files[/…]`
  and `/peers/:id/artifacts/:runId[/…]` fetch that peer's job files and run
  artifacts with this strut's token for it — and `peers/<id>/` before
  either goes one more hop, each with its own token — so an entry tagged
  `{ peer, via, job }` opens from a strut with no record for `via`. And a
  peer's APPS (plans/apps.md §7.4): `GET /peers/:id/apps` and
  `/peers/:id/apps/:name/:version/files[/…]` (the document's `ETag` and a
  host's `If-None-Match` pass through), plus `POST /peers/:id/mcp`, which
  relays an app page's tools/call — with a person token on file, the peer
  answers with `step_run` alone, as that person — so strut's UI hosts a
  peer's app as `?app=@<peer>/<name>`. The UI's viewer reads a peer's file
  with its own credential and shows the bytes (no file token here opens
  the read-through), and `?artifact=/peers/<id>/jobs/<job>/files/<file>&solo=1`
  shows one alone — what Peel opens for an org's deliverable (specs/API.md
  §14.3, "One file alone"). Those paths only; served under this
  strut's artifact headers (no scripts: the peer's file is untrusted
  content on this origin; a host frames a document's text); `?key=` never
  forwarded. Not yet: the rest of read-through (a peer's runs and
  workflows), a Peers dialog.
- **`agent` core step** (`src/steps/core/agent.ts`). A general
  tool-using agent loop (AI SDK `ToolLoopAgent`) — distinct from the
  workflow-*builder* chat above. It explores a working dir (`cwd`)
  with built-in general tools (`repo_overview` — adaptive, token-capped
  dir tree with build/dep/migration dirs collapsed; `fulltext_search`;
  `bash`; `str_replace_based_edit_tool` — view/create/str_replace/insert
  files, sandboxed to `cwd` (the anthropic provider-defined text-editor
  tool, with a generic-`tool()` fallback for other providers; pure handler
  `textEdit()` is unit-tested offline); + `web_search` + `web_fetch` on
  every provider (aieo: native on anthropic; elsewhere — and everywhere when
  routed through a gateway — an Exa-backed search that needs `EXA_API_KEY`
  and a guarded HTTP fetch — no key); +
  `file_summary`, an AST structural summary that's only registered when the
  `stakgraph` CLI is on PATH), filterable via `toolFilter`, and returns one
  of three shapes: a
  `final_answer` tool's
  text (set `finalAnswer` to its description), a STRUCTURED object (set
  `schema` to a JSON Schema: it becomes the `final_answer` tool's INPUT, and
  the step returns the object it was called with — never the SDK's
  `Output.object` grammar over the loop, which forbids all free text and
  made Sonnet 5.5 mark time with `true` / `echo done` tool calls until the
  step cap; the grammar is used only for the forced final-answer turn — one
  request on the loop's own `system` and `tools`, their `execute` removed,
  the model told not to call them: under preserved thinking a replayed
  thinking block is bound to system + tools + the messages before it, and
  the tools head the prompt cache, so the salvage turn must not drop them),
  or the final assistant text. A no-op loop guard runs in every mode: after
  three consecutive steps that are one identical tool call with an
  identical result, the next step offers only `final_answer` (no tools in
  text mode). Provider-direct via aieo
  (anthropic|openai|google|openrouter|xai — inferred from the model
  name, which may be an alias like `sonnet`/`grok` or slash format like
  `openrouter/moonshotai/kimi-k2.6`), lazy-loaded; needs the provider
  key in env + `git`/`rg` on PATH. Returns
  `{ result, object?, steps, usage, cost }` (+ `session` when it continued
  one — see "Agent sessions"). `reasoning` (the AI SDK's provider-neutral
  setting; anthropic maps it to `effort`) defaults to `medium` — anthropic's
  own default is `high`, and a long agent's time is mostly thinking (swarm38,
  2026-10-07: a research job spent 26 of its 27 minutes generating, ~170k of
  203k output tokens thinking). Every model call of the step sends it —
  loop, nudge, forced answer, summarizer — so they share one cache. The full session — system
  prompt, task prompt (with the cwd preamble the model saw), every
  generated turn, as AI SDK model messages — is ALWAYS recorded on the
  step's `step.end` event as `messages` (`buildSession` + `withMessages`,
  the marker the runner lifts; a sub-agent's rides on its tool-call
  `step.end` the same way), so every agent transcript is in the run log:
  over HTTP, `GET …/runs/:runId/events` (and the SSE `/stream`) replace
  it with a `transcript` link, `GET …/runs/:runId/transcripts/<step path>`,
  which serves the bare `messages` array — sessions run to megabytes, and
  the UI's reattach replays the whole log. It is NOT in the output — templates, a parent
  agent's tool result and `run.json` stay slim — and the builder's
  `get_run` strips it. `returnMessages` (default false) additionally puts
  it in the output, for a fork/sub-agent that needs the transcript as
  data. Anything domain-
  specific lives in the CALLER's prompts, not the step (e.g. mcp's
  `/lab` `gitsee-explore-services` wires `clone → agent`).
  - **`agentTools` — "tools are steps"** (`buildRegistryTools`). Beyond the
    built-ins, a caller can expose any REGISTRY step-types as extra LLM tools
    via `agentTools: ["gitsee/boot", "gitsee/read-logs", …]`: each step's
    `input` schema becomes the tool schema and its `run` is the executor,
    invoked with the agent's `ctx` (so tool-steps reach `ctx.services`).
    Resolved through the runner-populated **`ctx.registry`** (see Key
    concepts) — keeps the AI-SDK loop in the step rather than promoting `agent`
    to a container step. Merged ON TOP of the built-ins (not subject to
    `toolFilter`); unknown types are skipped. This is what lets mcp's `/lab`
    `gitsee-setup-and-run` drive a QA harness (boot/browser/observe/assess) as
    the core `agent` instead of a forked loop.
    A tool-step the model must SEE — a `browser/screenshot` step's frame —
    marks its output with `withMedia(output, [{ mediaType, data }])` (the
    third marker, beside `withAccessedNodes` and `withMessages`; `mediaOf`
    reads it): `buildRegistryTools` sets the tool's `toModelOutput`
    (`registryToolModelOutput`), so the model gets the output as JSON text
    plus one file part per entry, while templates, the event log and
    `run.json` see only the plain output (non-enumerable; `maskDeep` carries
    it). The recorded session (`step.end.messages`, the transcript endpoint)
    keeps what the model saw, file parts included. What the model reads
    of any tool-step's result is capped where it is made, at the cap
    `bash` gets (`capToolOutput`, the builder's: each string, then the
    whole result, long arrays kept head + tail with a `{ omitted, from, to
    }` gap; file parts left whole): before 2026-11-02 nothing bounded it
    but the 8 MB output cap. On a chat-completions
    model (`openai.chat`: xai and google routed through the gateway) the
    AI SDK would send a tool result as one string, the image as base64 text,
    so `resolveModel` wraps that model to move the images to a user message
    right after the results (`moveToolResultImages`, `src/llm.ts`) — what
    is sent, never what is stored.
    Entries may be **glob patterns** (`expandAgentTools`): `"jarvis/*"` grants
    every registry step in that namespace (matches sorted, deduped; a pattern
    matching nothing warns). `"agent"` itself is grantable — that's the
    sub-agent primitive: recursion depth is controlled by whether the child's
    own `agentTools` list includes `"agent"` again, not by a numeric cap.
    The model writes a sub-agent's config, so it is held to its parent
    (`holdSubAgent`): an `agentTools` entry the parent does not hold is
    refused, and every step the parent asks before running (`approve`) that
    the sub-agent holds is added to the sub-agent's own `approve`.
    **A tool-step can end the turn**: an output marked `withStop(output)`
    (core.ts, the fourth marker — a device that has not answered, an
    approval waiting on a person) stops the loop after that tool round —
    never a nudge back into it — and one answer turn follows on the loop's
    own prefix with every tool inert (the forced final-answer turn's
    request, its own prompt), so the model says what it is waiting for and
    nothing more runs (a nudge's loop stops the same way; a stream severed
    after the stop is not resumed). A marker, not a field: the model sees
    the plain output, and a step's own `stop` field means nothing. A
    sub-agent's stop ends only its own turn. The output
    gains `stopped: { tool }`. With `toolFilter: ['none']` the step needs
    neither `git` nor `rg` (only the built-ins use them).
  - **The caller's MCP servers are tools too** (`mcp`, default `true`;
    `connectMcpTools`, src/mcp-servers.ts). A run launched with `POST …/run
    { mcp }` hands every agent step its caller's servers as `ctx.mcp`; the
    step connects one client per server when it starts (inside the same
    `try` as the web tools, closed in its `finally`), adds their tools as
    `<server>_<tool>` after everything else in name order (the tool list is
    part of the cached prefix), not subject to `toolFilter`, masked of the
    credentials (`wrapToolsWithMask`) and emitting a run event per call like
    any tool. A tool whose name another tool holds is skipped; a server that
    cannot be reached, refuses the credential or does not answer in 15 s is
    skipped with a warning — the turn goes on without it. A call that fails
    is an `Error:` text the model reads; a result is capped like `bash`'s,
    and an image rides as `withMedia`. `mcp: false` keeps an agent (a judge,
    a narrow researcher) and everything it launches through its tools off
    them.
  - **Every tool call emits a nested run event** (`wrapToolsWithEmit`, applied
    to built-ins AND `agentTools` with one shared counter): a
    `step.start`/`step.end` (or `step.error`) at `<agentPath>/NNN-<tool>` with
    `stepType: "tool:<name>"`, I/O truncated for the log. So the otherwise
    opaque agent loop is **visible in the events panel / run drill-down** —
    each iteration's tool calls show in order. No-op without a runner `ctx`
    (in-code/test); skips `final_answer` + provider-executed tools (no
    `execute`). `agent.run` now consumes `ctx` (registry + emit).
  - **A `bash` command is one unit of run control.** The tool runs the line
    through `runShellProcess` (`shell.ts`: `runProcess` under the platform
    shell — its own PROCESS GROUP) and watches `ctx.control.state` while it
    runs: a cancel SIGTERMs the group at once (SIGKILL 2 s later), the exec
    step's treatment, and the loop's next `prepareStep` checkpoint raises the
    `CancelledError`. `bashTimeoutMs` (default 5 min) SIGKILLs the group and
    the tool result names it; the tool description tells the model the
    budget, so a dev server or a browser behind `| tail` goes to the
    background. Before this a cancel waited out the command's 10-minute cap
    (2026-09-30, swarm38: a `chrome --screenshot … | tail` that never
    returned). What a command leaves running in its process group once it
    has returned is killed when the RUN ends (`runProcess` reports the group
    through `onLeftover` only when something is still in it; the step kills
    them from `ctx.onRunEnd`), so a backgrounded server or browser never
    outlives its run — on swarm38 (2026-10-01) the headless Chromes job runs
    left behind put the repo2graph container at 12 GB.
  - **A stream that ends in an error fails the step** (`streamFailure` +
    `streamError`). The step reads `result.stream`, never `consumeStream`:
    the SDK reports a request the provider REFUSED (a 400 on a later step)
    and a throw out of `prepareStep` (a cancel) as an `error` PART on a
    stream that then closes normally, and `steps` resolves with what was
    banked — which reads exactly like a model that stopped, so the step
    used to nudge, force a final answer and return one. A connection fault
    (`isTransientStreamError`) is still resumed from the banked
    conversation, up to 5 times. Anything else throws `AgentStreamError`,
    `agent failed after N step(s): <message> (HTTP <status>: <body>)` — in
    the MESSAGE, because a run log records nothing else of an error — and a
    cancel is rethrown as it is (`status: "cancelled"`). The nudge and the
    forced final answer are salvage and still give up quietly on a
    connection fault; a refusal or a cancel there fails the step too, since
    the next fallback would send the refused conversation again. With a
    `session`, nothing is committed.

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

- **`system-canvas` is a sibling library** at
  `/Users/evanfeenstra/code/sphinx2/system-canvas` (its own repo,
  published to npm in lockstep as `system-canvas` +
  `system-canvas-react`). strut consumes the **published** version
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
   prefixes (`/workflows`, `/steps`, `/secrets`, `/sessions`, `/peers`, `/brand`, `/graph`, `/chat`, `/llm`, `/health`, `/jobs`, `/apps`, `/packages`, `/publisher`, `/mcp` — the app host's MCP client, SSE answers). Runs are
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
