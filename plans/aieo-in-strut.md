# aieo in strut: one source for the model layer

> **Status (2026-11-05): ruled** (Evan, the same day; see "Rulings").
> The first draft (2026-10-24, aieo 0.2.5) was never ruled on. This
> version is written against strut `main` @7eb40d3 and stakgraph `main`
> @b8f16c5b (aieo 0.2.7, with Maple and Numes).
>
> What drives it now is Stadeum. Its models plan (stakwork/stadeum#7,
> `docs/models.md`) makes strut's catalog, with aieo inside, what Stadeum
> reads through `GET /llm/models`. Its strut-side items 2 and 4 wait on
> this move (§7).

## What aieo is

aieo is not model picking. Which models an org allows, its default and a
person's pick belong to the models plan. aieo is the layer under it: it
turns whatever name was picked into a call that works.

- **Name to working client.** `resolve.ts` and most of `provider.ts`:
  - reads aliases, ids and `provider/id` names, and catches the
    OpenRouter name that lacks its prefix;
  - finds the key and its extra headers (`anthropic-workspace-id`);
  - builds each provider's client around its quirks. For example, Sonnet
    and Opus 5.5 reject `thinking: disabled`, Maple only accepts some
    reasoning-effort values, and OpenRouter and xAI need a prefix put back
    when routed through a gateway.
- **Limits and per-provider settings:** output caps net of the thinking
  budget, context windows, and the thinking or reasoning options each
  provider takes.
- **Web tools** (`search.ts`, `fetch.ts`; a third of the code):
  Anthropic's native tools, or Exa plus an HTTP fetch that refuses
  private addresses, and the citation helpers.
- **Usage and cost:** token accounting and a cost estimate.
- **Helpers for other repos:** `callModel` and a conversation store
  (staklink), and the `generateText` / `generateObject` wrappers (mcp).

Its value is that each provider quirk is written once and tested once,
for every caller. Strut is now where most calls run, so strut is where
it belongs.

## Problem

aieo lives in stakgraph (`mcp/src/aieo`: 12 modules, 3,405 lines and five
test files). So a model change strut needs takes four steps:
1. an aieo PR in stakgraph;
2. a publish by hand;
3. a strut bump: `yarn.lock` edited by hand, plus the strut tests that
   pin aliases (`src/llm.test.ts:76-77`);
4. mcp's strut pin.

Four more facts that neither repo shows:

- **strut runs a different aieo in each place.**
  - Standalone, it runs the npm release in `yarn.lock` (`aieo@^0.2.7`,
    `yarn.lock:921`).
  - Inside mcp, `node_modules/aieo` is a workspace link to `src/aieo`
    (`mcp/package.json:7-14`), and there is no nested
    `node_modules/strut/node_modules/aieo`. So the lab's strut runs
    `mcp/src/aieo/dist`, built by mcp's Dockerfile (`:182-183`) at
    whatever commit mcp is on.
  - mcp's own code compiles the same source a second time, through
    relative imports in 52 files. The mcp process holds two copies.
- **aieo's own env reads see nothing under strut.** aieo reads through
  `env` (`aieo env.ts`): `process.env`, unless a host calls `useEnv`.
  - The default server empties `process.env` at boot, and strut never
    calls `useEnv`.
  - So `LLM_GATEWAY_URL`, `LLM_HTTP_TIMEOUT_*`, `MAX_OUTPUT_TOKENS`,
    `LLM_PROVIDER` and aieo's env fallback for keys are all unset there.
  - Keys still resolve, because strut hands aieo `getSecret`.
  - mcp calls `useEnv(env)` (`mcp/src/index.ts:58,101`), but only on its
    compiled copy.
- **aieo's bundled SDK parses strut's streams.** tsup inlines
  `@ai-sdk/anthropic`, `google`, `openai` and `provider-utils`
  (`aieo tsup.config.js`, `noExternal`). `xai` and `openrouter` are
  exact-pinned dependencies instead.
  - strut's own `@ai-sdk/anthropic` (`^4.0.57`, locked at 4.0.60,
    `yarn.lock:13-14`) only builds the agent's text-editor tool.
  - So a streaming fix is an aieo release.
- **strut's costs are not what the gateway bills.**
  - aieo has a per-model price only for Maple and Numes; every other
    model gets its provider's flat rate (`TOKEN_PRICING`,
    `provider.ts:1130`).
  - strut never passes the cost a provider reports (`actualCost`;
    `src/steps/core/agent.ts:1734`, `src/steps/core/llm.ts:79`).
  - The gateway prices from bifrost's datasheet (§6). Run costs and the
    verify budget are therefore off, as the table in §6 shows.

## Today: who uses aieo

| Consumer | How | Where | Mostly uses |
| --- | --- | --- | --- |
| strut | npm `^0.2.7`, lazy `import("aieo")` | `package.json:34`. `src/llm.ts:17,102,358,402,431`, `src/pricing.ts:13`, `src/steps/core/llm.ts:77`, `src/steps/core/agent.ts:1377`, `src/pricing.test.ts:51`, `scripts/gateway-stream.mts:39` | resolving names, keys, aliases, web tools, cost |
| mcp | yarn workspace + relative source imports | 52 files import `…/aieo/src/{index,usage,provider,stream}.js`, `src/gitsee/agent/explore.ts:7` among them. One `from "aieo"` (`src/lab/eval/steps/reflect.ts:2`). `loadModelPricing` at `src/index.ts:29`, `useEnv` at `:58,101`. Built at `Dockerfile:148,182-183` and in `e2e-standalone.yml:104-110` and `e2e-test.yml:99-105` | usage accounting, `resolveLLMConfig`, `getProviderOptions` |
| hive | npm `^0.2.4`, locked 0.2.4 | `package.json:112`; six files, behind `src/lib/ai/provider.ts` | `getModel`, `getProviderOptions`, keys, web tools |
| staklink | npm `^0.2.4`, locked 0.2.4 | `package.json:127`; ten files | `callModel`, `ModelMessage`, the conversation store |
| sphinx-voice | npm `^0.1.31` (`ai` 6) | `package.json:43` | the old line; it stays there |

Peel, stadeum and the gateway import nothing from aieo.

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
| **asked** | The npm package `aieo` keeps its name, API and bundle, and is published from here by hand |
| **ruled** | mcp moves to the npm package (§5) |
| **ruled** | Prices and limits come from bifrost's datasheet as data, not from tables in code. The flat per-provider rate stays as the last fallback (§6) |
| **ruled** | aieo's git history comes along only if that is easy (step 1) |
| *proposed* | The package is `aieo/` (manifest, build config, README). Its source is `src/aieo/` (§1) |
| *proposed* | strut imports the provider SDKs itself, at aieo's exact pins (§2) |
| *later* | strut points aieo at the boot snapshot (§2): not in the move, since swarms set `LLM_PROVIDER` |

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

**Why not a full package beside `kit/` and `fixer/`?** Those two are
packages of their own to keep their dependencies OUT of strut's install
(React; node-llama-cpp). aieo is the opposite case: its dependencies are
strut's runtime dependencies.

**Why the source sits under `src/`.** Every way strut runs takes `src/`
and nothing else:
- `tsx` in the tests (CI installs with `--ignore-scripts`);
- `tsc` (`rootDir: ./src`) in `build:engine`, which the image runs
  (`Dockerfile:104-106`);
- the desktop stage, which copies `build/` plus the closure of
  `package.json`'s dependencies (`scripts/package-desktop.mjs:456-457`);
- the `build/` a git-dependency install packs (`files`).

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
- **One loader, `loadAieo()` in `src/llm.ts`.** Every call site imports
  `./aieo/index.js` through it.
  - **It does not hand aieo the boot snapshot in the move.** Swarms set
    `LLM_PROVIDER` on mcp's container (`sphinx-swarm
    src/images/repo2graph.rs:121-123`). Today strut's copy never sees it,
    because it loads after the scrub. Handing it `bootEnv()` would move a
    swarm's model-less calls to that provider.
  - So closing the env gap is its own later change: a `useEnv(bootEnv())`
    in `loadAieo()`, before the index loads, since `provider.ts` reads
    `LLM_GATEWAY_URL` at load.
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
    `fetch.ts:579`) hand zod schemas to the host's `ai`; the other four
    hand over a `LanguageModel`.
  - `@ai-sdk/anthropic` stays a peer and a devDependency, raised to
    `^4.0.71`. From now on it builds the models too, from the host's
    one copy (mcp pins 4.0.71).
  - `ai` and `zod` stay peers. `aieo` leaves strut's dependencies.
- **What changes in behavior.** Streams are parsed by the host's
  `@ai-sdk/anthropic` (≥ 4.0.71) instead of aieo's inlined 4.0.71. It is
  the same version but a different copy, so the gateway smoke test runs
  before this merges (AGENTS.md, "When changing how LLM calls or tools
  are built"). From then on, a bump of `@ai-sdk/anthropic` in strut is
  what changes the parser.

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
  - `npm run build:aieo` runs `npx -p tsup@8.5.1 -p typescript@5.9.3
    tsup` in `aieo/` and writes `aieo/dist/` (gitignored). The config is a
    plain object, since it cannot import `tsup` from npx's cache.
  - It is not a devDependency: the image keeps strut's dev dependencies,
    and tsup would add its own esbuild and rollup to it.
  - The inlined SDKs come from strut's install, so the copies bundled
    are the ones strut's tests ran.
- **The bundle stays**, as today. It does not change strut, which
  imports the source and pins the SDKs in its own `package.json`.
  - *For it:*
    - A consumer moves every provider SDK by bumping aieo alone.
    - It gets the exact combination aieo's tests ran.
    - Its own `@ai-sdk/*` versions never conflict with aieo's.
    - `xai` and `openrouter` are exact-pinned dependencies rather than
      inlined, so bumping aieo moves them too.
  - *Against it:*
    - A consumer with its own provider SDKs runs a second copy (1.5 MB).
    - A provider fix reaches it only through an aieo release.
- **CI** builds the package on every PR (one step in `tests.yml`) and
  imports the bundle once, so a release never finds a broken build.
- **Publishing stays by hand.** To release:
  1. `yarn install --frozen-lockfile` at strut's root: the bundle inlines
     the SDKs installed there, and `aieo/check-install.mjs` refuses a
     build whose install is not the pinned one (0.2.8 was built from a
     stale checkout and inlined `@ai-sdk/anthropic` 4.0.60);
  2. bump `aieo/package.json`;
  3. `npm run build:aieo`;
  4. `npm publish ./aieo`.
- **strut has no aieo version.** It runs the source at its own commit,
  and nothing strut does waits on a release. A version moves only when
  mcp, Hive or staklink need a change.

## 4. Tests

- **The move.** The five suites (`provider`, `resolve`, `search`,
  `fetch`, `gateway`) move to `src/aieo/<name>.test.ts`.
  - Only their relative imports change (`../resolve.js` →
    `./resolve.js`).
  - `npm test` is a glob, so they join it with no list to edit.
- **How they run.**
  - They are scripts that count results and `process.exit(1)` on a
    failure, which `node --test` reports as a failed file.
  - They run offline: the fetch suite injects its DNS lookup, the search
    and resolve suites stub `fetch`, and resolve uses a local server.
  - Each file gets its own process, which their env clearing at the top
    relies on.
  - Moving them to `describe` / `it` is later work.
- **New:** the pin test from §3 (`src/aieo/pins.test.ts`).
- **For the first time, aieo's tests run in CI** on every PR.

## 5. mcp: the npm package

stakgraph's half, one PR after 0.2.8 is published.

- **The package.** Delete `mcp/src/aieo` and add `"aieo": "^0.2.8"` to
  `mcp/package.json`. Drop `src/aieo` from `workspaces`, and the
  `**/gitsee*/aieo` nohoist with it.
- **The imports.**
  - The relative imports in 52 files (`gitsee/agent/explore.ts:7` among
    them) become `from "aieo"`. `reflect.ts:2` already is.
  - They reach four modules, and the package's index re-exports all four
    (`export *`), so nothing else changes.
- **Declare `@ai-sdk/openai`** in mcp. `lab/eval/steps/score.ts:92` and
  `reflect.ts:142` import it, and today it arrives only as the
  workspace's dependency.
- **Remove:**
  - `Dockerfile:148` and `:182-183`;
  - the two e2e workflows' aieo steps;
  - `tsconfig.json`'s `src/aieo/src/test/**/*` exclude.
- **strut.** Bump the strut pin to step 1's merge. The lab's strut then
  runs its own aieo, with its own loader (§2), instead of mcp's.
- **Still two copies.** mcp's process holds the npm copy, which mcp's
  `useEnv(env)` and `loadModelPricing()` reach, and strut's compiled
  copy. That is what it holds today, and it is fine for something being
  retired.

## 6. Prices and limits from bifrost's datasheet

**Built** (`feature/aieo-datasheet`), with the two changes marked
*as built* below. One strut PR after the move. aieo stops hand-keeping prices and limits
and reads them from the file the gateway bills from.

**The datasheet.**
- Where: `https://getbifrost.ai/datasheet`, 3.3 MB, 5,831 entries.
- Who uses it: the gateway fetches it daily to price every call
  (`gateway/internal/pricing/pricing.go`), and bifrost prices its logs
  from it.
- What each entry has: `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost`, `cache_creation_input_token_cost`,
  `max_input_tokens` and `max_output_tokens`.
- Coverage: it holds all nine of aieo's named models; Google's are under
  `gemini/`. It has no Maple or Numes rows.

Fetched 2026-11-05:

| Model | aieo's price | Datasheet price |
| --- | --- | --- |
| claude-sonnet-5-5 | $3/$15 | $2/$10 |
| claude-opus-5-5 | $3/$15 | $4/$20 |
| claude-haiku-4-5 | $3/$15 | $1/$5 |
| gpt-5.6-luna | $2.50/$10 | $0.20/$1.20 |
| grok-4.7 | $3/$15 | $2/$6 |

**aieo** (so every consumer gets it with one call):
- **`loadModelCatalog({ cachePath, url? })`** replaces
  `loadModelPricing()` (OpenRouter's price list), which stays as an alias
  so mcp's call keeps working.
- **The same lifecycle as the gateway's:**
  - load the copy at `cachePath`, if any;
  - fetch now and every 24 hours;
  - on success, swap the table and persist it (tmp + rename);
  - on failure, log and keep the last good one.
- **Lookup follows the gateway's rule** (`pricing.go:182`): the model as
  given, then `<provider>/<model>`, then the name with its prefix
  stripped.
  - aieo's provider `google` maps to bifrost's `gemini`; the others share
    names.
  - The cases are copied from `pricing_test.go`.
- **Where a cost comes from**, in order:
  1. the cost the provider reported (`actualCost`);
  2. `MAPLE_MODELS` / `NUMES_MODELS`;
  3. the datasheet;
  4. the provider's flat rate, kept as it is.
  - *As built:* Maple's and Numes' own tables come BEFORE the datasheet,
    as the gateway's runtime price rows do. The key rule's last-segment
    form would otherwise price a free Numes model, or an unlisted Maple
    one, at another vendor's rate. Maple never reads the datasheet. A
    Numes model reads it as the OpenRouter slug it is, which is how an
    unlisted one was priced before (`loadModelPricing`'s OpenRouter list).
  - Maple and Numes keep their own windows and output caps too.
- **Context window:** the datasheet's `max_input_tokens`, else aieo's
  table, as today.
- **Output cap:** the lower of `max_output_tokens` and aieo's
  per-provider cap. Then the thinking-budget rule applies, as today.

**strut:**
- At boot, it calls `loadModelCatalog({ cachePath:
  <dataDir>/models/datasheet.json })`, detached. The first minutes of a
  fresh install price from the tables.
- `agent` and `llm` price each model call on its own: the provider's
  reported cost when there is one, else that call's tokens.
  - *As built:* only OpenRouter's reaches strut, as
    `providerMetadata.openrouter.usage.cost`. Numes returns `usage.cost`
    too, but the OpenAI chat client aieo calls it with keeps only the
    usage fields it knows, so it never reaches `usage.raw`. A Numes call
    is priced from Numes' table: its free models are 0.
- `STRUT_MODEL_CATALOG`: `off` loads nothing, an http(s) URL is a mirror.
- `startModelCatalog(dataDir)` is on the barrel for a host that embeds
  createStrut. mcp calls it for its strut's copy in a one-line stakgraph
  change.

**What it buys:**
- On routed calls, strut's run costs and verify budget match the
  gateway's bill.
- A new model's price, window and output cap arrive without an aieo
  release.

**Later:** the flat rates stay as the last fallback. Most of
`MODEL_CONTEXT_LIMITS` can go once the datasheet path has run for a
while. Maple's and Numes' tables stay until bifrost's datasheet or the
gateway's runtime price rows (the models plan's item 5) carry them; the
price rows Stadeum pushes for them come from those same tables.

## 7. What the move unblocks

The models plan's strut items become one strut PR each, with their
tests, and no release.

- **Item 2, the catalog: landed (strut#542).** `/llm/models` lists the
  aliases, Maple's and Numes' models, and whatever `STRUT_MODELS` names,
  each with its window. It shows a price only for Maple and Numes, because
  aieo has no other per-model rate. Once §6 lands, `listModelOptions`
  (`src/llm.ts`) reads prices and windows through its lookup, with the
  same fields.
- **Item 4, routed OpenAI-compatible providers.** Built. A name aieo does
  not know runs only when the host lists it in `STRUT_MODELS`, so the
  no-prefix trap keeps its error everywhere else.
  - Maple, Numes and any admin-added name go to the gateway's
    `/openai/v1` as `<provider>/<id>`. OpenRouter and xAI already do this
    (`provider.ts:965,982`).
  - A routed name aieo does not know stops being
    `Unknown LLM provider` (`resolve.ts:129`). Then a new
    OpenAI-compatible provider on a Stadeum box is configuration only.
  - strut drops its `BASE_URL_ENV` special case (`src/llm.ts:108-116`).
  - Without a gateway (Peel, the voice demo), a new provider still needs
    aieo code.

## 8. What does not change

- **Hive** (`^0.2.4`) and **staklink** (`^0.2.4`, inside pods) take the
  next version from npm, as they do now. The package's name, API and
  bundle stay; only `repository` moves. Hive is going away and needs
  nothing here.
- **sphinx-voice** stays on 0.1.x.
- **gatekey and the gateway** stay in stakgraph. strut reaches the
  gateway only through `llmAuth`.

## Step order

Each step is one PR, and every consumer keeps working after each.

1. **strut: bring aieo in.**
   - **History, only if easy.** On a fresh stakgraph clone, run `git
     filter-repo` (`uvx git-filter-repo`; it is not installed here):
     - keep both of aieo's paths: `mcp/aieo` from 2025-05-09, renamed to
       `mcp/src/aieo` on 2025-08-26 (c6a40b29);
     - rename them to `aieo/`;
     - rewrite `(#123)` in 40 commit messages to
       `(stakwork/stakgraph#123)`, so GitHub does not link strut's PRs;
     - merge the resulting 106 commits here with
       `--allow-unrelated-histories`, and land the PR with a merge
       commit.
     - If any of that fights back, use one commit that names stakgraph's
       last aieo commit (`2debbd5a`) instead.
   - **The move.** One commit moves `aieo/src/*` to `src/aieo/`, the
     suites beside them, and the probes to `aieo/scripts/`.
   - **The code.** §2, §3's manifest, build, pin test and CI step, and
     §4.
   - **AGENTS.md.**
     - the Stack row ("provider SDKs are aieo's");
     - Layout;
     - "One copy per process" (strut now imports provider SDKs);
     - the first lines of "When changing how LLM calls or tools are
       built".
   - **The freeze.** From this merge on, aieo changes land here, and
     stakgraph's copy is frozen. Anything that lands there anyway is
     ported before step 3.
   - *Validation:*
     - `npm test` and `tsc`;
     - `npm run test:gateway` (the parser is now the host's copy);
     - `npm run package:desktop -- --smoke` (new dependencies staged);
     - the image build.
2. **Publish aieo 0.2.8 from `aieo/`** (by hand). *Validation, before
   it:*
   - the bundle exports the same names as 0.2.7;
   - it inlines the same provider versions (the `VERSION` strings in
     `dist/index.js`).
3. **stakgraph: mcp on the npm package** (§5), with mcp's strut pin
   bumped to step 1's merge. *Validation:*
   - mcp's `tsc` and tests, and the e2e workflows;
   - then `/lab/health` and one agent run on a scratch mcp.
4. **strut: prices and limits from the datasheet** (§6). Publish 0.2.10
   when mcp, Hive or staklink want it. (0.2.8 inlined a stale
   `@ai-sdk/anthropic`; 0.2.9 is 0.2.7 republished from strut.)
5. **The models plan's strut items** (stadeum#7 items 2 and 4, §7), on
   `src/aieo/`.

## Rulings

Evan, 2026-11-05:

1. **mcp uses the npm package**, not an export of strut's copy.
2. **Git history:** keep it only if it is easy.
3. **Publishing stays by hand** for now.
4. **The npm package keeps bundling** the provider SDKs: a consumer
   updates them by bumping aieo alone.
5. **Prices and limits are aligned with bifrost's datasheet** as data,
   not as tables in code.
6. **A model priced nowhere keeps its provider's flat rate**, as today.
