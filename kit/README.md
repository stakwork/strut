# @strut/kit

The app kit (`plans/apps.md` §3): what a strut APP — an interactive front end
the builder writes on top of workflows, rendered by any MCP Apps host in a
sandboxed frame — is built against, and what it runs on.

One source, two builds:

| Build | What | For |
| --- | --- | --- |
| **vendor** (`vendor/`) | A frozen MODULE TREE (kit 0.2): every module the dependency set (§3.1) reaches, the shadcn components at `@/components/ui/*` and the kit's own sources compiled, copied into `files/` as the packages ship them, with each import's resolution and each module's side-effect flag in `modules.json` — so the app build tree-shakes every app from the original modules, and the page has one React, one react-query, one radix, one zod because every import of each resolves to one file. Beside it `import-map.json` (specifier → the module it starts from, what the app build's `appResolver` consults, §2.1), the bundled stylesheet entries, `candidates.json` (every component's Tailwind classes, for `@strut/kit/node`'s `compileStyles`) and `manifest.json` (the versions). | The app build (`src/apps/build.ts`) |
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

Tests run with the repo's `npm test` (they are in the root `test` list) or
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
  refetch while anything shown is in flight), `useTranscript` (`run/transcript`:
  an agent's session by step path — the log's `transcript` link, which a page
  cannot follow), `useLaunch(workflow)` →
  `{ launch(input, params?, key?), pending }` — a MUTATION with no query form,
  so nothing launches on mount or on a poll (§5.1) — `useCancel`,
  `useWorkflow` (`run/workflow`), `useStep(type)` → `run(config, input)`,
  `useToolInput`, `useAppLink`, `useHost`. Graph, SQL, automation and job
  hooks are later work items.
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
  once per distinct error.
- **`src/folds/`** — the folds (plans/apps.md §3), pure and dependency-free,
  one copy for strut's UI, `strut/views` and any app: `run-overview.ts`
  (`foldRunOverview`: status, cost, model calls, the timeline rows),
  `transcript.ts` (`transcriptToEntries`), `accessed-nodes.ts`
  (`foldAccessedNodes`), `artifact-view.ts` (`artifactKind`,
  `parseWalkthrough`, …), and `run-graph/` — the run graph's model ported
  from hive with its tests (the projection of a run's log into graph calls,
  replay, lineage, walk, peer refs, node text; `layout.ts` needs d3, so it is
  exported from `@strut/kit` and not from `@strut/kit/folds`).
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
