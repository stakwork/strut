# aieo in strut: one source for the model layer

> **Status (2026-11-05): proposed, revised.** The first draft (2026-10-24,
> aieo 0.2.5) was never ruled on. This revision is written against strut
> `main` @7eb40d3 and stakgraph `main` @b8f16c5b (aieo 0.2.7, with Maple
> and Numes). It changes two leans and fixes one step:
> - **mcp imports `strut/aieo`**, not the npm package (§5);
> - **publishing moves to a workflow**, with no token (§3);
> - **the history import** follows both of aieo's paths and rewrites PR
>   references (step 1).
>
> What drives it now is Stadeum. Its models plan (stakwork/stadeum#7,
> `docs/models.md`) makes strut's catalog, with aieo inside, what Stadeum
> reads through `GET /llm/models`. Its strut-side items 2 and 4 wait on
> this move (§6).
>
> Rows the owner asked for on 2026-10-24 are marked **asked**. The rest
> are *proposed*.

## Problem

aieo is strut's model layer: aliases, model resolution, keys, the web
tools, prices, output caps, Maple and Numes. Every chat turn, `agent`
step, `llm` step and evaluation gets its model from `aieo.resolveModel`
(`src/llm.ts:102`). It lives in stakgraph (`mcp/src/aieo`: 12 modules,
3,405 lines and five test files), so a model change strut needs takes
four steps:
1. an aieo PR in stakgraph;
2. a publish by hand;
3. a strut bump: `yarn.lock` edited by hand, plus the strut tests that
   pin aliases (`src/llm.test.ts:76-77`);
4. mcp's strut pin.

Three more facts that neither repo shows:

- **strut runs a different aieo in each place.**
  - Standalone, it runs the npm release in `yarn.lock` (`aieo@^0.2.7`,
    `yarn.lock:921`).
  - Inside mcp, `node_modules/aieo` is a workspace link to `src/aieo`
    (`mcp/package.json:7-14`). There is no `node_modules/strut/node_modules/aieo`.
    So the lab's strut runs `mcp/src/aieo/dist`, built by mcp's
    Dockerfile (`:182-183`) at whatever commit mcp is on, published or
    not.
  - mcp's own code compiles the same source a second time, through
    relative imports in 52 files. The mcp process holds two copies.
- **aieo's own env reads see nothing under strut.** aieo reads through
  `env` (`aieo env.ts`): `process.env`, unless a host calls `useEnv`.
  The default server empties `process.env` at boot, and strut never calls
  `useEnv`. So `LLM_GATEWAY_URL`, `LLM_HTTP_TIMEOUT_*`, `MAX_OUTPUT_TOKENS`,
  `LLM_PROVIDER` and aieo's env fallback for keys are all unset there.
  Keys still resolve, because strut hands aieo `getSecret`. mcp calls
  `useEnv(env)` (`mcp/src/index.ts:58,101`), but only on its compiled
  copy, not on the `dist` its strut loads.
- **aieo's bundled SDK parses strut's streams.** tsup inlines
  `@ai-sdk/anthropic`, `google`, `openai` and `provider-utils`
  (`aieo tsup.config.js`, `noExternal`). `dist/index.js` is 1.5 MB;
  anthropic is inlined at line 4383, google at 16312 and openai at 31119.
  `xai` and `openrouter` stay external dependencies.
  - strut's own `@ai-sdk/anthropic` (`^4.0.57`, locked at 4.0.60,
    `yarn.lock:13-14`) only builds the agent's text-editor tool.
  - So a streaming fix is an aieo release, and the parser is 4.0.71,
    aieo's pin.

## Today: who uses aieo

| Consumer | How | Where |
| --- | --- | --- |
| strut | npm `^0.2.7`, lazy `import("aieo")` | `package.json:34`. `src/llm.ts:17,102,358,402,431`, `src/pricing.ts:13`, `src/steps/core/llm.ts:77`, `src/steps/core/agent.ts:1377`, `src/pricing.test.ts:51`, `scripts/gateway-stream.mts:39` |
| mcp | yarn workspace + relative source imports | 52 files import `…/aieo/src/{index,usage,provider,stream}.js`, `src/gitsee/agent/explore.ts:7` among them. One `from "aieo"` (`src/lab/eval/steps/reflect.ts:2`). `loadModelPricing` at `src/index.ts:29`, `useEnv` at `:58,101`. Built at `Dockerfile:148,182-183` and in `e2e-standalone.yml:104-110` and `e2e-test.yml:99-105` |
| hive | npm `^0.2.4`, locked 0.2.4 | `package.json:112`. Six files, behind `src/lib/ai/provider.ts` |
| staklink | npm `^0.2.4`, locked 0.2.4 | `package.json:127`. Ten files: `callModel`, `ModelMessage`, `getProviderForModel` |
| sphinx-voice | npm `^0.1.31` (`ai` 6) | `package.json:43`. The old line; it stays there |
| stakgraph docs | npm `0.1.30` | `mcp/docs/test-mcp/package.json`, a sample |
| gitsee 1.0.18 (npm) | depends on `aieo` 0.1.29 | `mcp/yarn.lock:3226`; unaffected |

Peel, stadeum and the gateway import nothing from aieo; strut's
`scripts/gateway-*` are the gateway's only aieo users.

How aieo ships today:
- It is published by hand from stakgraph (npm maintainer `fognet`).
- There is no prepublish script, and the package ships `dist` only.
- No stakgraph workflow runs its tests: the e2e workflows install and
  build it, nothing more.

Checked for this plan:
- aieo 0.2.7's source type-checks under strut's own `tsconfig.json`
  (`Node16`): no errors.
- Its five test files pass under strut's runner (`tsx --test`) against
  strut's install: 5 of 5, in 0.8 s.

## Decided

| | |
|-|-|
| **asked** | aieo's source moves into this repo, and strut imports it, never the npm package |
| **asked** | The npm package `aieo` keeps its name and API, and is published from here for Hive and staklink |
| **asked** | mcp stops importing `../aieo/src/…` |
| *proposed* | The package is `aieo/` (manifest, build config, README). Its source is `src/aieo/` (§1) |
| *proposed* | The provider SDKs become strut's own dependencies, at aieo's exact pins. The inlined copies go (§2) |
| *proposed* | strut points aieo at the boot snapshot before aieo loads (§2) |
| *proposed* | mcp imports `strut/aieo`, a subpath export of strut's compiled copy (§5) |
| *proposed* | A workflow publishes the npm package on a version bump, through npm trusted publishing (§3) |
| *proposed* | aieo's git history comes with it (step 1) |

## 1. Layout

```
strut/
├── aieo/                # the npm package `aieo`: what is published, nothing strut runs
│   ├── package.json     # name, version, repository; dependencies = strut's pins; peers ai + zod
│   ├── tsup.config.js   # entry ../src/aieo/index.ts; noExternal as today
│   ├── README.md
│   └── scripts/         # the live probes (stakgraph's src/test/try-*.ts), run by hand
└── src/aieo/            # the source: provider.ts, resolve.ts, search.ts, fetch.ts, usage.ts, env.ts, …
    └── *.test.ts        # the five suites, beside their sources
```

**Why not `aieo/` as a full package beside `kit/` and `fixer/`?** Those
two are packages of their own to keep their dependencies OUT of strut's
install: React, and node-llama-cpp. aieo is the opposite case: its
dependencies are strut's runtime dependencies.

**Why the source sits under `src/`.** Every way strut runs takes `src/`
and nothing else:
- `tsx` in the tests (CI installs with `--ignore-scripts`);
- `tsc` (`rootDir: ./src`) in `build:engine`, which the image runs
  (`Dockerfile:104-106`);
- the desktop stage, which copies `build/` plus the closure of
  `package.json`'s dependencies (`scripts/package-desktop.mjs:456-457`);
- the `build/` a git-dependency install packs for mcp (`files`).

Under `src/aieo/`, aieo needs no change to any of them. Anywhere else, it
needs one of three things:
- a linked package (its `dist/` built before every test run, and missing
  from the git-dependency pack);
- a second build that every path runs first;
- `rootDir: "."`, which moves `build/index.js` under every consumer.

The one cost is a package whose source sits outside its folder.

## 2. strut imports the source

- **The imports.** Every `import("aieo")` above becomes the source.
  `import()` stays dynamic, so the provider SDKs load on the first model
  call, never at registry build (the lib step convention).
- **One loader, `loadAieo()` in `src/llm.ts`.**
  - It imports `./aieo/env.js`, calls `useEnv(bootEnv())`, then imports
    `./aieo/index.js`. Every call site goes through it.
  - The order matters: `provider.ts` reads `LLM_GATEWAY_URL` when it
    loads.
  - This closes the env gap wherever strut runs. No stack sets those
    variables for strut today: stadeum's `stack/` and strut's compose
    files do not, so nothing changes in behavior.
- **The env boundary.** `src/aieo/env.ts` keeps `process.env` as its
  default, because Hive and staklink call no `useEnv`. `env.test.ts`'s
  read check skips that one file, as it skips `src/env.ts`.
- **Dependencies.**
  - `@ai-sdk/google` 4.0.74, `@ai-sdk/openai` 4.0.69, `@ai-sdk/xai`
    5.0.2 and `@openrouter/ai-sdk-provider` 3.0.0 become strut
    `dependencies` at aieo 0.2.7's exact pins. They are also what
    strut's `yarn.lock` resolves today.
  - Exact, because a git-dependency host (mcp) resolves strut's
    dependencies with its own lockfile, not strut's.
  - They are plain dependencies, not peers. Only anthropic's
    provider-defined tools (web_search, web_fetch: `aieo search.ts:275`,
    `fetch.ts:579`) hand zod schemas to the host's `ai`. The other four
    hand over a `LanguageModel`.
  - `@ai-sdk/anthropic` stays a peer and a devDependency, raised to
    `^4.0.71`. From now on it builds the models too, from the host's one
    copy (mcp pins 4.0.71). `ai` and `zod` stay peers, as they are now.
  - `aieo` leaves strut's dependencies.
- **What changes in behavior.** Streams are parsed by the host's
  `@ai-sdk/anthropic` (≥ 4.0.71) instead of aieo's inlined 4.0.71. It is
  the same version, but a different copy, so the gateway smoke test runs
  before this merges (AGENTS.md, "When changing how LLM calls or tools
  are built").
  - From then on, a bump of `@ai-sdk/anthropic` in strut is what changes
    the parser.

## 3. The package, published from here

- **`aieo/package.json`.**
  - `name: aieo`; `version` 0.2.7 at the move, 0.2.8 at the first
    release from here; `repository: stakwork/strut` with
    `directory: aieo`; `files: ["dist"]`.
  - The five provider SDKs as `dependencies`, at the same exact pins as
    strut's `package.json`. `ai` and `zod` as peers.
  - A test fails when a pin there differs from strut's, so the package
    ships what strut's tests ran.
- **The build.**
  - `npm run build:aieo` runs `npx tsup@8.5.1` in `aieo/` and writes
    `aieo/dist/` (gitignored).
  - It is not a devDependency: the image keeps strut's dev dependencies,
    and tsup would add its own esbuild and rollup to it.
  - The inlined SDKs come from strut's install, so the copies bundled are
    the ones strut's tests ran.
  - Hive and staklink get the same bundle shape as today.
- **CI** builds the package on every PR (one step in `tests.yml`) and
  imports the bundle once, so a release never finds a broken build.
- **Publishing.** A new `.github/workflows/publish-aieo.yml`, the
  `publish-browser.yml` pattern.
  - When it runs: on a push to `main` that changes `aieo/package.json`
    to a version npm does not have.
  - What it runs: aieo's suites, `build:aieo`, then
    `npm publish ./aieo --provenance`.
  - npm trusted publishing (OIDC) means no token is stored here. The
    owner sets it up once on npmjs.com: for package `aieo`, trust
    `stakwork/strut` with workflow `publish-aieo.yml`.
- **strut has no aieo version.** It runs the source at its own commit,
  and nothing strut does waits on a release. A version moves only when
  Hive or staklink need a change.

## 4. Tests

- **The move.** The five suites (`provider`, `resolve`, `search`,
  `fetch`, `gateway`) move to `src/aieo/<name>.test.ts`. Only their
  relative imports change (`../resolve.js` → `./resolve.js`).
  `npm test` is a glob, so they join it with no list to edit.
- **How they run.** They are scripts that count results and
  `process.exit(1)` on a failure, which `node --test` reports as a failed
  file. They run offline: the fetch suite injects its DNS lookup, the
  search and resolve suites stub `fetch`, and resolve uses a local
  server. Each file gets its
  own process, which their env clearing at the top relies on. Moving them
  to `describe` / `it` is later work.
- **New.**
  - One `llm.test.ts` case for the loader: a value in the boot snapshot
    (`MAX_OUTPUT_TOKENS`) still reaches aieo after the scrub.
  - The pin test from §3.
- **For the first time, aieo's tests run in CI** on every PR.

## 5. mcp: `strut/aieo`

stakgraph's half, in one PR.

- **The export.** strut adds `"./aieo": { types, import }` →
  `build/aieo/index.{d.ts,js}` to `exports` (step 1). mcp's
  `tsconfig.json` is `Node16`, so subpath types resolve.
- **The imports.** The relative imports in 52 files
  (`gitsee/agent/explore.ts:7` among them) and `reflect.ts:2`'s type
  import become `from "strut/aieo"`. They reach four modules, and the
  index re-exports all four (`export *`), so nothing else changes.
- **One copy per process.** strut's loader and mcp both load
  `node_modules/strut/build/aieo/index.js`. So mcp's `useEnv(env)` and
  strut's resolver share one instance, for the first time.
  - One behavior change follows. mcp's `loadModelPricing()`
    (`src/index.ts:29`) then prices the lab strut's calls too.
    OpenRouter models move from the flat provider rate to OpenRouter's
    own price.
- **No release in mcp's path.** mcp already bumps its strut pin
  (`package.json:86`), and an aieo change arrives with that bump.
- **Remove.**
  - `mcp/src/aieo`;
  - the `src/aieo` workspace and the `**/gitsee*/aieo` nohoist;
  - `Dockerfile:148` and `:182-183`;
  - the two e2e workflows' aieo steps;
  - `tsconfig.json`'s `src/aieo/src/test/**/*` exclude.
- **Declare `@ai-sdk/openai`** in mcp. `lab/eval/steps/score.ts:92` and
  `reflect.ts:142` import it, and today it arrives only as the
  workspace's dependency.

**Why not npm, the first draft's lean?** A published `aieo` in mcp keeps
two copies in one process: strut's compiled one and npm's, which bundles
its own SDKs and has its own env source. It also puts a release back in
mcp's path, the step this move removes. mcp is on its way out for
Stadeum but still runs every Hive swarm, so the cheaper path matters.

## 6. What the move unblocks

The models plan's strut items become one strut PR each, with their
tests, and no release.

- **Item 2, the catalog.** `/llm/models` must list every model aieo
  knows, with its price and context window.
  - What aieo lists today: `listModels()` lists aliases only
    (`aieo resolve.ts:58-72`).
  - Maple's 7 and Numes' 8 models carry a price and a window
    (`provider.ts:246,354`).
  - The other providers' models have a window
    (`MODEL_CONTEXT_LIMITS`, `:1042`), but a price only per provider
    (`TOKEN_PRICING`, `:1130`), so Opus is priced as Sonnet.
  - A per-model price exists only after `loadModelPricing()` (`:1179`),
    a live OpenRouter fetch that strut never calls.
  - So item 2 needs a per-model price table and a catalog export in
    aieo. The gateway's price rows (item 6) are pushed from the same
    table.
- **Item 4, routed OpenAI-compatible providers.**
  - Maple, Numes and any admin-added name go to the gateway's
    `/openai/v1` as `<provider>/<id>`. OpenRouter and xAI already do
    this (`provider.ts:965,982`).
  - A routed name aieo does not know stops being
    `Unknown LLM provider` (`resolve.ts:129`).
  - strut drops its `BASE_URL_ENV` special case (`src/llm.ts:108-116`).

## 7. What does not change

- **Hive** (`^0.2.4`) and **staklink** (`^0.2.4`, inside pods) take the
  next version from npm, as they do now. The package's name, API and
  bundle stay the same; only `repository` moves. Hive is going away, and
  needs nothing here.
- **sphinx-voice** stays on 0.1.x.
- **gatekey and the gateway** stay in stakgraph. strut reaches the
  gateway only through `llmAuth`.

## Step order

Each step is one PR, and every consumer keeps working after each.

1. **strut: bring aieo in.**
   - **History.** On a fresh stakgraph clone, run `git filter-repo`
     (`uvx git-filter-repo`; it is not installed here):
     - keep both of aieo's paths: `mcp/aieo` from 2025-05-09, renamed to
       `mcp/src/aieo` on 2025-08-26 (c6a40b29);
     - rename them to `aieo/`;
     - rewrite `(#123)` in 40 commit messages to
       `(stakwork/stakgraph#123)`, so GitHub does not link strut's PRs.
     - That leaves 106 commits, merged here with
       `--allow-unrelated-histories`.
     - `git subtree split` follows one prefix and cannot rewrite
       messages, so it would lose the first 3.5 months.
     - The PR merges with a merge commit, never a squash.
   - **The move.** One commit moves `aieo/src/*` to `src/aieo/`, the
     suites beside them, and the probes to `aieo/scripts/`.
   - **The code.** §2, §3's manifest, build, pin test and CI step, §4,
     and the `./aieo` export.
   - **AGENTS.md.** The Stack row ("provider SDKs are aieo's"), Layout,
     "One copy per process" (strut now imports provider SDKs), and the
     first lines of "When changing how LLM calls or tools are built".
   - **The freeze.** From this merge on, aieo changes land here, and
     stakgraph's copy is frozen. Anything that lands there anyway is
     ported before step 2.
   - **mcp, Hive, staklink:** untouched. mcp still pins an older strut.
   - *Validation:*
     - `npm test` and `tsc`;
     - `npm run test:gateway` (the parser is now the host's copy);
     - `npm run package:desktop -- --smoke` (new dependencies staged);
     - the image build.
2. **stakgraph: mcp on `strut/aieo`** (§5), with mcp's strut pin bumped
   to step 1's merge. *Validation:*
   - mcp's `tsc` and tests, and the e2e workflows;
   - then `/lab/health` and one agent run on a scratch mcp.
3. **strut: `publish-aieo.yml`.** It can land any time after step 1. The
   owner sets up trusted publishing first. The first run publishes
   nothing (0.2.7 is on npm). The first release is whatever bump Hive or
   staklink next need. *Validation, before that release:*
   - the bundle exports the same names as 0.2.7;
   - it inlines the same provider versions (the `VERSION` strings in
     `dist/index.js`).
4. **The models plan's strut items** (stadeum#7 items 2 and 4, §6), each
   on `src/aieo/`.

## Open questions

1. **Publishing.** *Lean: the workflow (§3).* It needs the owner on
   npmjs.com once. The other way is by hand, as today:
   `npm run build:aieo && npm publish ./aieo`.
2. **History.** *Lean: keep it* (step 1). The other way is one import
   commit that names stakgraph's last aieo commit (`2debbd5a`). That is
   cheaper, but blame on `provider.ts`'s 1,400 lines stops at the move.
3. **mcp: `strut/aieo` or npm.** *Lean: `strut/aieo`* (§5). It reverses
   the first draft's lean. It also reads the 2026-10-24 ask, "mcp imports
   the package", as strut's compiled copy rather than npm's.
4. **The npm bundle.** *Lean: keep inlining* anthropic, google and
   openai for Hive and staklink, as today. Dropping it would make their
   own `@ai-sdk/*` versions parse their streams; that is their call,
   later.
