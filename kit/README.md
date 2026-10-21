# @strut/kit

The app kit (`plans/apps.md` §3): what a strut APP — an interactive front end
the builder writes on top of workflows, rendered by any MCP Apps host in a
sandboxed frame — is built against, and what it runs on.

One source, two builds:

| Build | What | For |
| --- | --- | --- |
| **vendor** (`vendor/`) | One frozen browser bundle per specifier in the dependency set (§3.1), the shadcn components at `@/components/ui/*`, and the kit itself, from ONE esbuild call with code splitting — so the page has one React, one react-query, one radix, one zod. Beside them `import-map.json` (specifier → file, what the app build's `appResolver` consults, §2.1), `candidates.json` (the components' Tailwind classes, for the app build's compile, §2.2) and `manifest.json` (the versions). | The app build (`src/apps/build.ts`, work item 1b) |
| **library** (`dist/`) | The hooks, the provider, the client and host contracts, and the bootstrap, as ESM with React, react-dom and react-query as peers. | A host's own pages (hive imports it); the app build's Node side (`@strut/kit/node`) |

Both are artifacts of the kit's build, never of strut's `npm install`: strut's
own `node_modules` carries no React. The kit is built once per kit release and
published as a package strut pins exactly (open question 4, decided by
proceeding).

## Build

From a clean checkout:

```bash
cd kit && yarn install --frozen-lockfile --ignore-scripts && yarn build
```

`yarn build` is `build:vendor` (esbuild → `vendor/`, ~1 s) then `build:lib`
(esbuild + `tsc --emitDeclarationOnly` → `dist/`). Both directories are
gitignored and listed in `files`, so `npm pack` ships them.

Tests run with the repo's `npm test` (they are in the root `test` list) or
`yarn test` here; either needs this directory's install. The vendor test builds
the whole layer into a temp dir and checks every import-map entry exists, that
each shared module (React, react-query, zod, radix's dismissable layer,
react-router) is in exactly one output, and that the recorded versions are
`package.json`'s exact pins.

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
  refetch while anything shown is in flight), `useLaunch(workflow)` →
  `{ launch(input, params?, key?), pending }` — a MUTATION with no query form,
  so nothing launches on mount or on a poll (§5.1) — `useCancel`,
  `useWorkflow` (`run/workflow`), `useStep(type)` → `run(config, input)`,
  `useToolInput`, `useHost`. Graph, SQL, automation and job hooks are later
  work items.
- **`src/bootstrap.ts`** (`@strut/kit/bootstrap`) — §2.4: connects the MCP Apps
  client (`@modelcontextprotocol/ext-apps`, never a hand-rolled postMessage),
  which sends `ui/initialize`; applies the host context to the document; reads
  the file token off `<meta name="strut-app-token">` (written by the file route
  as the document is served, never at build); mounts
  `<StrutProvider><ErrorBoundary><App/></ErrorBoundary></StrutProvider>`;
  reports its size (`ui/notifications/size-changed`); turns render failures and
  `window.onerror` into `app/report-error { message, stack?, componentStack? }`,
  once per distinct error.
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
