# @strut/kit

The app kit (`plans/apps.md` §3): what a strut APP — an interactive front end
the builder writes on top of workflows, rendered by any MCP Apps host in a
sandboxed frame — is built against, and what it runs on.

One source, two builds:

| Build | What | For |
| --- | --- | --- |
| **vendor** (`vendor/`) | A frozen MODULE TREE (kit 0.2): every module the dependency set (§3.1) reaches, the shadcn components at `@/components/ui/*` and the kit's own sources compiled, copied into `files/` as the packages ship them, with each import's resolution and each module's side-effect flag in `modules.json` — so the app build tree-shakes every app from the original modules, and the page has one React, one react-query, one radix, one zod because every import of each resolves to one file. A family of modules may be importable by PATH (`SUBPATHS` in scripts/manifest.ts: three's addons as `three/addons/<path>.js`, and as `three/examples/jsm/…` with or without `.js`), one entry per module. Beside it `import-map.json` (specifier → the module it starts from, what the app build's `appResolver` consults, §2.1), the bundled stylesheet entries, `candidates.json` (every component's Tailwind classes, for `@strut/kit/node`'s `compileStyles`) and `manifest.json` (the versions). | The app build (`src/apps/build.ts`) |
| **package entries** (`dist/`) | `@strut/kit` (the hooks, the provider, the client and host contracts, the folds and the run graph's layout), `@strut/kit/folds` (the folds alone: no React, no dependency — what `web/` imports), `@strut/kit/bootstrap`, and `@strut/kit/node` (the app build's server side), as ESM with `.d.ts`; React, react-dom and react-query are optional peers, never installed by a strut that pins the kit. | The app build (`@strut/kit/node`) and the types. A library build for a HOST's own React pages is deferred (§12): a host that wants strut's views renders an app importing `strut/views` |

Neither lands in strut's own `node_modules`, which carries no React: the
kit's dependencies install into `kit/node_modules`. `vendor/` is built by
strut's own `npm run build` (its `build:kit` step, `scripts/build-kit.mjs`:
this directory's frozen install, then `build:vendor`), so `prepare`, the
Docker image and the desktop package all carry it — AGENTS.md "Running" says
where each finds it. The kit may later be published as a package strut pins
exactly (open question 4); `src/apps/kit.ts` looks for `@strut/kit` first. Per the kit split (plans/apps.md §3, 2026-10-21) the kit is **the
stack and the bridge, nothing else**: strut's own components are `strut/views`,
an app other apps import (§3.3, `src/apps/views/`), and the pure folds are
`src/folds/` here.

## Build

From a clean checkout:

```bash
cd kit && yarn install --frozen-lockfile --ignore-scripts && yarn build
```

`yarn build` is `build:vendor` (esbuild → `vendor/`, ~2 s) then `build:lib`
(esbuild + `tsc --emitDeclarationOnly` → `dist/`). Both directories are
gitignored and listed in `files`, so `npm pack` ships them.

How the vendor layer is frozen, and why: kit 0.1 shipped one pre-bundled,
minified chunk per specifier, and an app build cannot tree-shake inside one
— module boundaries and every package's `sideEffects` were gone, so an app
that imported three icons carried all of lucide (649 KB) and `Slot` brought
every radix primitive; a small app was 1.2 MB, the 1c benchmark app 2.48 MB.
Now one esbuild pass (production, platform browser) resolves every import
once and records it; the app build hands esbuild those modules with the
recorded `sideEffects` (esbuild reads `package.json` for neither
`sideEffects` nor `type` when a plugin names the path, so a `type: module`
package's `.js` is frozen as `.mjs` to keep its interop), and CommonJS
packages are interoped from source — no facades. The app build also rewrites
`import { z } from "zod"` to `import * as z` (esbuild keeps every member of a
re-exported namespace, all zod's locales included), scans only the kit
modules it bundled for Tailwind classes, and minifies the stylesheet. A small
app is now ~0.6 MB (react-dom 210 KB, the MCP Apps SDK and its zod schemas
~250 KB of it). Maps and 3D are in the set since 0.2: an app that does not
import them carries none of them.

Tests run with the repo's `npm test` (its glob takes `kit/src`) or
`yarn test` here; either needs this directory's install. The vendor test builds
the whole layer into a temp dir and checks every import-map entry is a module
of the tree, every recorded link points into it, each shared module (React,
react-query, zod, radix's dismissable layer, react-router) is in it once,
the `sideEffects` and `type` rules, and that the recorded versions are
`package.json`'s exact pins. `npx tsc -p tsconfig.views.json` type-checks
`strut/views` (`../src/apps/views`) against the kit.

## What is in it

- **`src/client.ts`** — `StrutClient { run(type, config?, input?) }`, the one
  call every hook makes: `tools/call` of `step_run` with the app's file token as
  its `app` argument (§5, §7.2). `unwrapToolResult` reads `structuredContent`,
  else the text part as JSON; an `isError` result is a `StrutError`.
- **`src/host.ts`** — the host behind the page: `BridgeHost` over the MCP Apps
  `App` (theme, display mode, locale, time zone, `tool-input`, `ui/message`,
  `ui/open-link`), `createStaticHost` for a page with no bridge.
- **`src/provider.ts`** — `<StrutProvider client host? queryClient?>`: what an
  app is mounted under; a host's page wraps kit components in it with its own
  client.
- **`src/hooks.ts`** — §3.2, each naming a step: `useRuns` / `useRun` /
  `useRunEvents` (`run/list`, `run/get` with `wait`, `run/events`; `live` =
  refetch while anything shown is in flight — the log read once, then only
  what was appended, `run/events { skip }`, paged past its 5 000-event cap,
  every `intervalMs`), `useTranscript` (`run/transcript`: an agent's session
  by step path — the log's `transcript` link, which a page cannot follow) and
  `useTranscripts` (several, one call at a time, kept), `useRunFile(workflow,
  runId, path)` (`run/files`: one file a run made, text or base64, read once)
  and `useRunFileUrl` (that file as a `blob:` URL for `<img>`, a model loader
  or `fetch`, let go of on unmount; `runFileBlob(file)` outside a component;
  a binary file up to about 3.7 MB, the call's 5 MB cap), `useWorkProducts(workflow,
  runId, { live })` → `{ products, events }` (the run's work products folded
  from `run/events` — `foldWorkProducts` — appearing as steps declare them,
  plans/work-products.md), `useLaunch(workflow, { job? })` →
  `{ launch(input, params?, key?, files?), pending }` — a MUTATION with no
  query form, so nothing launches on mount or on a poll (§5.1); `job` is one
  of the app's jobs, `files` the run's attachments — `useUpload(job)` →
  `{ upload(file), remove(path) }` (`job/upload`, `job/delete-upload`: files
  into the app's job, §12; `fileData` turns a `File` into what a step
  takes), `useCancel`, `useWorkflow` (`run/workflow`), `useStep(type)` →
  `run(config, input)`, `useToolInput`, `useAppLink`, `useHost` (theme,
  display mode, `sendMessage`, `openLink`; in a strut server's public view
  `public: true` and `runnable`, the granted workflows a VISITOR may start —
  read off the document's `strut-public-view` and `strut-public-runnable`
  metas. A priced one's host pays before the launch returns
  (`plans/paid-runs.md` §10, specs/API.md §17.6): a host that cannot pay
  leaves a `{ payment_required }` result, which `useLaunch` throws as a
  `payment_required: …` error, never a launch; `paymentRequiredOf` reads one),
  `useAppState(key, initial)` → `[value, set, { loaded, error }]` (`app/state`:
  what this viewer's page remembers across visits — the page has no browser
  storage; writes go out within `APP_STATE_WRITE_MS`, every key set meanwhile
  in one call). The LIVE
  FEEDS (`plans/live-feeds.md`), one call held on the server at a time and
  none while the page is hidden: `useJobUpdates(job)` → `{ updates,
  latest(kind) }` (`job/updates`: a job's shots, frames, holds, verdicts,
  status lines and graph writes as they happen) and `useGraphChanges(types)`
  → `{ rev, changes }` (`graph/changes` from now: put `rev` in the
  dependencies of the reads that show those types). Grant the step in
  `grants.steps`. SQL and automation hooks are later work items.
- **`src/channel-hooks.ts`** — `useChannel(name, { onMessage?, enabled? })`
  → `{ available, ready, client, members, states, events, error, send(data,
  { key? }) }`: live messages between the people on the app
  (`plans/app-channels.md`) — a game's moves, cursors, a lobby. The page's
  HOST holds the socket; strut stamps every sender (`from.actor`,
  `from.client`); a message with a `key` is a state that replaces only this
  page's last one of that key, one without is an event. Every component
  naming a channel shares one join and one state; `onMessage` gets each new
  message (`mine` for this page's own) without a re-render. `available` is
  false in a host that carries no channels. `newChannel()` mints an
  unguessable name for a private game; `appLink(app, { channel })` is the
  invite. Nothing is kept: what must last goes through a workflow or the
  graph. No grant: the host's ticket names the app.
- **`src/channels/`** (`@strut/kit/channels`) — the contract under it, no
  React: the `strut/channels/{join,leave,send}` requests and the
  `strut/channels/frame` notification on the bridge, the frames strut sends,
  `applyChannelFrame` (the fold every page keeps), the page's client
  (`createBridgeChannels`, which the bootstrap builds) and `relayChannels`,
  what a BROWSER HOST runs per framed app: one socket to strut's `GET
  /channels` opened with a ticket on the first join, frames relayed both
  ways, a drop told to the page as `{ op: "status", connected: false }` and
  the socket brought back with its client id and each channel's cursor.
- **`src/wallet-hooks.ts`** — `useWallet()` → `{ available, wallet,
  connected, info, connect, payKeysend, payInvoice, makeInvoice,
  lookupPayment, lookupInvoice, getBudget, getBalance, listTransactions,
  payLightningAddress, on }`: the viewer's Lightning wallet through the host
  (`specs/WALLET.md`), for an app whose `app.yaml` has a `wallet:` request.
  Amounts are msat. A call made with no connection yet connects first, once.
  Pay from a click, since the host opens a sheet only right after the
  person acted. `available` is false in a host with no wallet (anything but
  Peel today). `useTransaction(payment)` → `{ state, preimage, feesPaid,
  settledAt, failureReason }` follows a payment from `pending` to `settled`
  or `failed`, on the host's notifications, looking it up every
  `TRANSACTION_POLL_MS` while the page is visible. A Sphinx keysend can stay
  pending for days, and a settled payment may carry no preimage. No grant:
  the person's connection is the grant.
- **`src/wallet/`** (`@strut/kit/wallet`) — the contract under it, no React:
  the `strut/wallet/*` methods and their checks (`checkParams`,
  `resultProblems`, `notificationProblems`), `WalletError`, `verifyPreimage`,
  `satsToMsat`, the Sphinx address split, the conformance vectors
  (`@strut/kit/wallet/vectors.json`), the page's client
  (`createBridgeWallet`, which the bootstrap builds, with `window.webln` over
  it), and the relay a native host's main frame runs (`relayNativeWallet`).
- **`src/links.ts`** — `appLink(name, input?)`: a deep link to an app,
  `?app=<name>&input=<input as a query string>` (plans/apps.md §7.1). A host
  follows it and hands `input` back as `tool-input`, flat strings.
- **`src/bootstrap.ts`** (`@strut/kit/bootstrap`) — §2.4: connects the MCP Apps
  client (`@modelcontextprotocol/ext-apps`, never a hand-rolled postMessage),
  which sends `ui/initialize`; applies the host context to the document; reads
  the file token off `<meta name="strut-app-token">` (written by the file route
  as the document is served, never at build); mounts
  `<StrutProvider><ErrorBoundary><App/></ErrorBoundary></StrutProvider>`;
  reports its size (`ui/notifications/size-changed`); turns render failures and
  `window.onerror` into `app/report-error { message, stack?, componentStack? }`,
  once per distinct error. First, when its module is evaluated (before the
  app's own modules), it gives a page whose `localStorage` / `sessionStorage`
  throws — every host frames it with an opaque origin — an in-memory one
  (`installMemoryStorage`), so a library that persists by default works for
  the page's life instead of breaking it.
- **`src/folds/`** — the folds (plans/apps.md §3), pure and dependency-free,
  one copy for strut's UI, `strut/views` and any app: `run-overview.ts`
  (`foldRunOverview`: status, cost, model calls, the timeline rows — `tree`
  every level, `split` each iteration — each with its tokens),
  `run-health.ts` (`foldRunHealth`: failures, retries, onError fallbacks,
  skips and branches, what was cut off, tool failures by tool, log stats),
  `document.ts` (`sanitizeHtml`: a parsed DOM walked against a pinned tag
  and attribute allowlist into a plain tree a view draws element by element;
  `findHighlightRanges` / `highlightPieces`, with `indexOf`, never a RegExp
  built from the terms), `agent-trace.ts` (`foldAgentTrace`: a run's agents
  as a nested cascade — sessions, their turns in fixed slots, the rows
  `strut/views`' AgentTrace draws; ported from hive's Traces view),
  `walk/` (a graph walk hop by hop: `findWalks` reads a `graph/walk`
  step's hop events, or an agent's own graph calls — a listing, then the
  nodes it read next, one or several at once — as one hop-event shape;
  `foldWalkTrail` makes the trail `strut/views`' WalkView draws,
  `foldWalkGraph` the graph strut's
  chat draws, `walkBeats` / `walkFrame` the walk at any beat of a replay),
  `replay.ts` (a replay's clock: where a viewer starts, how long each beat
  stays — the run's own pace, a readable least, a speed — and what play,
  pause, a scrub and Live do; RunGraph and WalkView share it),
  `transcript.ts` (`transcriptToEntries`), `accessed-nodes.ts`
  (`foldAccessedNodes`), `artifact-view.ts` (`artifactKind`,
  `parseWalkthrough`, …), `work-products.ts` (`foldWorkProducts`: the
  artifacts a run's steps and output declared, latest per id, the output
  winning; `productView`, `isGoogleSheet`, `parseTimeline`, `sourcesOf`),
  `concept-diff.ts` (`foldConceptDiff`: two states of the Concept tree's
  pages — from the history, a proposal laid over a page, an unsaved edit —
  as the tree with each page added, removed, renamed, moved or edited;
  `lineDiff` / `foldDiffLines`, the docs line by line), and
  `run-graph/` — the run graph's model ported
  from hive with its tests (the projection of a run's log into graph calls,
  replay, lineage, walk, peer refs, node text; `layout.ts` needs d3, so it is
  exported from `@strut/kit` and not from `@strut/kit/folds`; its `fold`
  keeps a cell to a few dozen nodes, the rest in "+N" nodes, `clusters`;
  its `stack` draws a loop's iterations in one box, `stacked` lanes).
- **`src/styles/base.css`** — Tailwind, shadcn's tokens, and the mapping of
  MCP Apps `hostContext.styles.variables` onto them: every token is
  `var(--color-…, <shadcn default>)`, read off the inline variables the
  bootstrap writes on `<html>`. `--font-sans`, `--font-mono` and `--shadow-*`
  need no mapping: the host's names are Tailwind's, and an inline value wins.
  Dark is `[data-theme="dark"]` (the bridge) or `.dark` (a host page).
- **`src/components/ui/*`**, `src/lib/utils.ts`, `src/hooks/use-mobile.ts` —
  shadcn/ui as the CLI writes it (`components.json`; `yarn shadcn` re-pulls
  every component), with `cn` at `@/lib/utils` and the Toaster reading the
  document theme instead of next-themes. Carousel, combobox, input-otp and
  message-scroller are left out: each brought a library outside the set.
- **`src/node.ts`** (`@strut/kit/node`) — the server's side: `readImportMap`,
  `readCandidates`, `readManifest`, `compileStyles` (the base stylesheet + an
  app's CSS over the candidates, with Tailwind's `@import "tailwindcss"`
  resolved from the kit's own `tailwindcss`), `scanCandidates`.
- **`scripts/manifest.ts`** — the dependency set as import-map entries, the
  CSS entries, and two aliases models write by reflex: `framer-motion` →
  `motion/react`, `react-router-dom` → `react-router`.

## Bumping

Versions are exact. A new library, or a bump, is a new kit version: edit
`package.json`, `yarn install`, `yarn build`, run the tests, bump `version`.
Re-pulling shadcn (`yarn shadcn`) rewrites `src/components/ui/*`; re-apply the
`cn` import and the Toaster's theme hook, and check `package.json` — the CLI
adds what a component needs with a caret.
