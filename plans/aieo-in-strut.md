# aieo in strut: one source for the model layer

> **Status (2026-10-24): proposed.** The owner asked for this shape in
> one conversation: aieo as its own package in this repo, strut importing
> its source, the npm package published from here for Hive and staklink,
> mcp switching its relative imports to the package. Those rows are
> marked **asked**; the rest are mine, marked *proposed*. One proposed
> row bends the ask: the package is `aieo/`, but its source sits under
> `src/aieo/` (§1 says why). Written against strut `main` @bf07091 and
> stakgraph `main` @dbeddb41 (aieo 0.2.5). This is the first piece of
> stakgraph to move into strut, and the one strut's code depends on;
> `marketplace.md` §12 (the lab as a distro) is the rest.

## Problem

aieo is strut's model layer. Every chat turn, `agent` and `llm` step and
evaluation gets its model from `aieo.resolveModel` (`src/llm.ts`). aieo
also owns the aliases, the key lookup, the web tools, pricing and the
output caps, and strut's tests pin all of them. It lives in stakgraph
(`mcp/src/aieo`: 3,084 lines and five test files), so a change strut
needs takes four steps. The Anthropic workspace header, 2026-10-23/24:

1. a strut PR that works around it (strut#311 put the header in strut's
   own `resolveModel`);
2. the real change in stakgraph (stakgraph#1813);
3. a publish by hand (0.2.5);
4. a strut bump: a hand-edited `yarn.lock` entry, plus whatever strut
   test the change moves (`agent.test.ts` lists the secrets a call reads,
   and the workspace was a new one).

Three more things neither repo shows:

- **strut runs a different aieo in each place.** Standalone, it runs the
  npm release in `yarn.lock`. Inside mcp, `node_modules/aieo` is a
  workspace link to `mcp/src/aieo`, so the lab's strut runs
  `mcp/src/aieo/dist` at whatever commit mcp is on, published or not.
  mcp's own code compiles the same source a second time through its
  relative imports, so that process already holds two copies.
- **aieo's own env reads see nothing under strut.** aieo reads the
  environment through its `env` (`env.ts`): `process.env`, unless a host
  calls `useEnv`. The default server empties `process.env` at boot
  (`scrubProcessEnv`, `src/env.ts`) and strut never calls `useEnv`. So
  `LLM_GATEWAY_URL`, `LLM_HTTP_TIMEOUT_MS`, `LLM_HTTP_TIMEOUT_RETRIES`,
  `MAX_OUTPUT_TOKENS`, `LLM_PROVIDER` and aieo's env fallback for keys
  are unset there. Keys still resolve, because strut hands aieo
  `getSecret` (the secret store, then the boot snapshot). mcp does call
  `useEnv(env)` (`mcp/src/index.ts:101`), but on its compiled copy, not
  on the `dist` its strut loads.
- **The SDK that parses strut's streams is aieo's bundled copy.** tsup
  inlines `@ai-sdk/anthropic`, `google`, `openai` and `provider-utils`
  (`noExternal`). The `@ai-sdk/anthropic` strut lists only builds the
  agent's text-editor tool, so a streaming fix is an aieo release.

## Decided

| | |
|-|-|
| **asked** | aieo's source moves into this repo, and strut imports it, never the npm package |
| **asked** | The npm package `aieo` keeps its name and API and is published from here, for Hive and staklink |
| **asked** | mcp imports the package instead of `../aieo/src/…` |
| *proposed* | The package lives at `aieo/` (manifest, build config, README); its source at `src/aieo/` (§1) |
| *proposed* | The provider SDKs become strut's own dependencies, at aieo's exact pins (§2) |
| *proposed* | strut points aieo at the boot snapshot before aieo loads (§2) |
| *proposed* | aieo's git history comes with it (step 1; open question 1) |

## 1. Layout

```
strut/
├── aieo/                   # the npm package `aieo`: what is published, nothing strut runs
│   ├── package.json        # name, version, repository, dependencies (exact pins = strut's), peers ai + zod
│   ├── tsup.config.js      # entry ../src/aieo/index.ts; noExternal as today
│   ├── README.md
│   └── scripts/            # the live probes (stakgraph's src/test/try-*.ts), run by hand
└── src/aieo/               # the source: provider.ts, resolve.ts, search.ts, fetch.ts, usage.ts, env.ts, …
    └── *.test.ts           # the five suites, beside the sources
```

**Why the source sits under `src/`, not `aieo/src/`.** Every way strut
runs takes what is under `src/` and nothing else:

- `tsx` in the tests (CI installs with `--ignore-scripts`, so nothing is
  built first);
- `tsc` (`rootDir: ./src`) in `build:engine`, and so the Docker image;
- the desktop stage, which copies `build/`;
- the `build/` a git-dependency install packs for mcp.

Source outside `src/` needs one of three things, and each breaks
something:

- **A linked package** (`"aieo": "link:./aieo"`). Node then finds it
  through `node_modules`, but the desktop stage resolves dependencies
  without the repo, and a git-dependency install packs without
  `aieo/`. Its `main` is also a `dist/` that someone has to build before
  strut's tests can import it.
- **A second build** that every one of those paths runs first, emitting
  where `build/` expects it.
- **`rootDir: "."`**, which moves `build/index.js` to
  `build/src/index.js` under every consumer.

Under `src/aieo/` it is one more directory strut already compiles, tests
and ships. The cost is a package whose source is outside its folder:
`tsup` takes `../src/aieo/index.ts` as its entry. aieo's relative imports
already carry `.js`, so `Node16` resolution compiles them as they are.

The code only mcp and staklink call (`store.ts`'s `ConversationStorage`,
`prompt.ts`, `stream.ts`'s `callModel`) moves too: it is the package's
API.

## 2. strut imports the source

- **The imports.** Every `import("aieo")` becomes the source:
  `src/llm.ts` (four calls and a type import), `src/steps/core/llm.ts`,
  `src/steps/core/agent.ts`, `src/pricing.ts`'s type import, and
  `scripts/gateway-stream.mts`. A dynamic `import()` stays dynamic: the
  provider SDKs load on the first model call, never at registry build
  (the lib step convention).
- **One loader**, `loadAieo()` in `src/llm.ts`. It imports
  `./aieo/env.js`, calls `useEnv(bootEnv())`, then imports
  `./aieo/index.js`, and every call site goes through it. The order
  matters because `provider.ts` reads `LLM_GATEWAY_URL` when it loads.
  This closes the env gap for strut's copy wherever strut runs, the lab
  included.
- **The env boundary.** `src/aieo/env.ts` keeps `process.env` as its
  default, since Hive and staklink call nothing. `env.test.ts`'s read
  check skips that one file, as it skips `src/env.ts`.
- **Dependencies.** `@ai-sdk/google` 4.0.74, `@ai-sdk/openai` 4.0.69,
  `@ai-sdk/xai` 5.0.2 and `@openrouter/ai-sdk-provider` 3.0.0 become
  strut `dependencies` at aieo 0.2.5's exact pins, which are also what
  strut's `yarn.lock` resolves for them today. The desktop stage installs
  without a lockfile, so only an exact pin keeps it on the version CI
  ran. `@ai-sdk/anthropic` stays a peer and devDependency, raised to
  `^4.0.71` (the version aieo bundles): it now builds strut's Anthropic
  models too, from the host's single copy (mcp pins 4.0.71). `aieo`
  leaves strut's dependencies.
- **Behavior: no change intended.** Today's streams are parsed by aieo's
  bundled `@ai-sdk/anthropic` 4.0.71; afterwards by the host's, held at
  `^4.0.71`. That is a different copy of the parser, so the gateway
  smoke test runs before this merges (AGENTS.md, "When changing how LLM
  calls or tools are built").

## 3. The package, published from here

- **`aieo/package.json`.** `name: aieo`, `version` (next 0.2.6),
  `repository: stakwork/strut`, `type: module`, `files: ["dist"]`. The
  same five provider SDKs as `dependencies`, at the same exact pins as
  strut's `package.json`. `peerDependencies` `ai` and `zod`, as today. A
  test fails when a pin there differs from strut's, so the package ships
  what strut's tests ran.
- **The build.** `tsup` is a strut devDependency; `aieo/` has no install
  and no lockfile of its own. `npm run build:aieo` runs tsup in `aieo/`,
  which reads that manifest for what stays external, and writes
  `aieo/dist/` (gitignored). The inlined SDKs come from strut's install:
  esbuild walks up from `src/aieo/` to strut's `node_modules`, so the
  copies bundled are the ones strut runs.
- **CI** builds the package on every PR (one step in `tests.yml`) and
  imports the bundle once, so a publish never finds a broken build.
- **Publishing stays a person's act**, as it is now: bump
  `aieo/package.json`, `npm run build:aieo`, `npm publish ./aieo`.
  Versions are aieo's own, for its npm consumers. strut has no aieo
  version: it runs the source at its own commit.

## 4. Tests

- **The move.** aieo's five suites (`provider`, `resolve`, `search`,
  `fetch`, `gateway`) move beside their sources as
  `src/aieo/<name>.test.ts`. Only their relative imports change
  (`../resolve.js` → `./resolve.js`), and they join the `test` list in
  `package.json`.
- **How they run.** They are scripts that count results and
  `process.exit(1)` on a failure, which `node --test` reports as a failed
  file. They run offline: the fetch suite injects its DNS lookup, and the
  search suite stubs `fetch`. `node --test` gives each file its own
  process, which their top-of-file env clearing relies on.
- **New.** One `llm.test.ts` case for the loader: a value in the boot
  snapshot (`MAX_OUTPUT_TOKENS`) still reaches aieo after the scrub.

## 5. mcp

stakgraph's half, one PR after the first publish from here:

- **The package.** Delete `mcp/src/aieo` and add `"aieo": "^0.2.6"` to
  `mcp/package.json`. Drop `src/aieo` from `workspaces`, and the
  `**/gitsee*/aieo` nohoist with it.
- **The imports.** The relative ones become `from "aieo"`, across about
  50 files. They reach four modules
  (`src/aieo/src/{index,usage,provider,stream}.js`), and the package's
  index re-exports all four (`export *`), so nothing else changes.
  `gitsee/agent/explore.ts`'s one import changes too.
- **The env.** `useEnv(env)` (`src/index.ts:101`) now reaches the copy
  mcp's code uses.
- **The build.** These go: the Dockerfile's `COPY
  ./src/aieo/package.json` and `RUN cd src/aieo && yarn build`, the two
  e2e workflows' "Install dependencies in src/aieo" and "Build aieo"
  steps, and `tsconfig.json`'s `src/aieo/src/test/**/*` exclude.
- **strut.** Bump strut to step 1's merge. The lab's strut then runs its
  own aieo, not mcp's.

The process still holds two copies, as it does today: mcp's npm copy and
strut's compiled one, now both pointed at the same env. Open question 2
is how to make that one.

## 6. What does not change

- **Hive** (`aieo@^0.2.4`; five files: the provider list, key checks,
  gateway URLs, citations, the web tools) and **staklink** (`^0.2.4`;
  `callModel`, `ModelMessage` and `getProviderForModel` in ten files,
  inside pods) take the next version from npm, the way they take one
  now. The package's name, API and bundle stay the same; only its
  `repository` moves. `sphinx-voice` is on 0.1.31 and stays there.
- **gatekey and the gateway** stay in stakgraph. gatekey's TypeScript
  mirrors the Go verifier beside it (`gateway/auth/`), and strut reaches
  the gateway only through `llmAuth`.

## Step order

1. **strut: bring aieo in.**
   - **History.** `git subtree split --prefix=mcp/src/aieo` in stakgraph
     (84 commits), then `git subtree add --prefix=aieo` here.
   - **The move.** One commit moves `aieo/src/*` to `src/aieo/`, the
     suites beside them and the probes under `aieo/scripts/`.
   - **The code.** §2 (the loader, the imports, the dependencies,
     `env.test.ts`), §3 (`aieo/package.json`, the build, the pin test,
     the CI step) and §4.
   - **AGENTS.md.** The Stack row ("provider SDKs are aieo's"), Layout
     (`src/aieo/`, `aieo/`), "One copy per process" (strut now imports
     provider SDKs), and the first lines of "When changing how LLM calls
     or tools are built".
   - **The freeze.** From this merge on, an aieo change lands here, and
     stakgraph's copy is frozen. Anything that lands there anyway is
     ported before step 3.
   - *Validation:* `npm test` (strut's suites plus aieo's five), `tsc`,
     `npm run test:gateway` (the stream parser is now strut's copy),
     `npm run package:desktop -- --smoke` (new dependencies staged), and
     the image build.
2. **Publish aieo 0.2.6 from `aieo/`** (a person runs `npm publish`).
   *Validation, before it:* the bundle exports the same names as 0.2.5,
   and inlines the same provider versions (the `VERSION` strings in
   `dist/index.js`).
3. **stakgraph: mcp on the package** (§5). *Validation:* mcp's `tsc`
   and tests, the e2e workflows, then `/lab/health` and one agent run on
   a scratch mcp.
4. **Hive and staklink: nothing.** Their next aieo bump takes a version
   published from here.

## Open questions

1. **History.** *Lean: keep it* (`git subtree`, step 1). It is 84
   commits, and `git log --follow` works across the move. The other way
   is one import commit that names stakgraph's last aieo commit
   (`dbeddb41`).
2. **mcp from npm, or from strut.** mcp already depends on strut, through
   a git pin it bumps often. strut could export its compiled copy
   (`"./aieo": "./build/aieo/index.js"`) and mcp would import
   `strut/aieo`. That gives one copy per process and no npm release for
   mcp to wait on, and it is the direction the distro goes. The ask says
   the package, and it leaves strut's exports alone. *Lean: npm now;
   revisit when mcp's remaining code moves.*
3. **Publishing by workflow.** *Lean: by hand, as today.* A
   `publish-aieo.yml` that runs on a version change in
   `aieo/package.json` (the `publish-browser.yml` pattern) would need an
   npm token in this repo's secrets.
4. **The suites under `node:test`.** *Lean: later.* They run as they
   are.
