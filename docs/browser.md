# The browser

The browser service behind the `browser/*` steps and the browser image.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| Browser     | `playwright-core` (pinned to images/browser's Playwright) driving a Playwright server, a CDP Chrome or a local Chrome, behind `ctx.services.browser`; `sharp` for the screenshot downscale (in the darwin desktop package its addon + libvips sit in `native/` like the others, `relocateSharp`). Both lazy-loaded |

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

## Files

What each file and folder in this area is, in the order of the tree.

### `images/browser/`

a second image, nothing of strut's in it: a Playwright SERVER (`playwright run-server`, the package baked in, tini, non-root) for hosts whose steps drive a browser over a websocket. `.github/workflows/publish-browser.yml` pushes it to ghcr.io/stakwork/strut-browser when this directory changes on main, tagged with the Playwright version its Dockerfile pins — the connecting host's `playwright-core` must be on the same major.minor (strut's own, package.json, is pinned to it). The compose file's `browser` service

### `src/steps/lib/browser/`

browser/* — one Playwright call per step, each a thin wrapper over one verb of `ctx.services.browser` (src/browser/service.ts): open, goto, back, close; snapshot (the accessibility tree, interactive elements tagged [ref=eN]), text, evaluate, observe (console / page errors, failed requests, 4xx/5xx since the last call); click, fill, type, press, keydown / keyup (a key HELD until let go of — no settle, so the time between is the hold; a declared list lets go of what it left held), select, hover, scroll, wait — by `ref` from the last snapshot (reset by any navigation) or a Playwright `selector`; screenshot (shots/NNN.png under the run's artifacts, or the job's directory on a job run; the 0.6× copy rides to a model via withMedia); capture (open → a declared list `{ do: <verb>, … }` → settle → shoot); verify (the same list + `expect`, answering in the check contract — the page failing is a result, the instrument failing throws) and walkthrough (verify with a frame per captioned step: walkthroughs/NNN/ + walkthrough.json); state (the storage state to state.json, for a human to paste under Secrets and load with open's `storageStateSecret`); keep + open/close `{ session }` (a page the JOB keeps across runs, held on the job as `browser:<session>` with browser/close as its release step); tap (clicks at fractions of an element's box — a person's taps on its crop); captcha-ask (the challenge's crop + the manifest hive's captcha card reads, shots/captcha-<round>.{png,json}, written in code) and captcha-state (a round's state on that manifest). Grantable as `agentTools: ["browser/*"]`; the job seed grants verify + walkthrough

### `src/browser/`

the browser behind `ctx.services.browser` (the browser/* steps): service.ts — `BrowserService`, ONE lazy Playwright connection and a context + page per run keyed by runId, closed by createStrut's run-end teardown (`dispose`); three backends from env (`fromEnv`): a Playwright SERVER (`BROWSER_WS_URL` + `BROWSER_WS_PATH`, images/browser), a real Chrome over CDP (`BROWSER_CDP_URL`: one page per run in the profile's own context — no viewport, storage state or state export), else a local headless Chrome; a per-call timeout whose loser closes the context, a per-run budget; a check (verify, walkthrough) in a session of its OWN, signed out, as the verify pass will replay it; a KEPT page (`job:<job>/<session>`) the job holds across runs — runs attach to it, `dispose` only detaches, an idle timer instead of the budget, at most `BROWSER_SESSIONS_MAX`, not over CDP. captcha.ts (the captcha manifest, to hive's parser), settle.ts (network idle → fonts → two frames, each bounded), shot.ts (where a PNG lands — the run's artifacts or the job's directory, `job.update` to a listening host — and the 0.6× model copy via sharp), walkthrough.ts (the recording directory + manifest), verdict.ts (verify's verdict, pure), deny.ts (`BROWSER_URL_DENY`: schemes, CIDRs, hosts — checked before a navigation and on the landed URL), seed.ts (seeds the four browser workflows at boot, `browserWorkflows: false` opts out). `npm run test:browser` runs service.live.test.ts against a real server
