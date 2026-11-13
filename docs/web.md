# The web UI

The Preact UI under `web/`: the shell, the canvas, flyouts, the app host and the store front.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Stack

| Concern | Choice |
| --- | --- |
| Web UI      | Preact + Vite + system-canvas-react. Vanilla CSS, no Tailwind              |

## Key concepts

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

## Files

What each file and folder in this area is, in the order of the tree.

### `web/package.json`

preact, system-canvas, vite

### `web/vite.config.ts`

preact preset, dev proxy to :3000 (/workflows, /steps, /chat, /llm, /health)

### `web/src/main.tsx`

entry: renders <App/>

### `web/src/app.tsx`

shell: sidebar, topbar, canvas, events panel, dialog/flyout orchestration. `&solo=1` renders one thing ALONE, nothing of strut's around it, for a native host's web view (Peel): `?app=` an app's page (AppHost), or `?artifact=<path>` one served file in the viewer — a job's file or a run's artifact, here or behind `/peers/<id>` hops (`isServedFilePath`; any other path says it is not a file strut serves); `artifact` without `solo` is ignored; `?store=1` the store front (Store.tsx). `App` picks the solo page or the `Shell`, so nothing of the shell's (its loads, the `/runs/active` poll) runs behind one. `?install=<name>[&index=&index_url=]` (the store's link, store-links.ts) opens the Publish dialog's Packages tab, Find, on that package, the index followed first when this strut does not yet; the params are dropped from the URL once the dialog closes

### `web/src/api.ts`

typed fetch wrapper for all API endpoints (+ run SSE tail; chat: sendChat/streamChat/getChat reattach)

### `web/src/flow-to-canvas.ts`

Flow → CanvasData; one theme category per palette entry; childRefForStep/stepWorkflow (container nav)

### `web/src/helpers.ts`

normalizeSteps, formatJson, etc.

### `web/src/step-colors.ts`

the step palette: PALETTE + paletteKey(type) — the ONE place a step's color is decided; the canvas nodes and the run overview's bars both read it

### `web/src/actor.ts`

displayActor: an actor id's first `-` segment for the UI (storage keeps the whole id)

### `web/src/page.ts`

pickPage: which page the UI shows from the address and the session (`api.pageSession`, `GET /auth/session`) — a SERVED box's app alone as a visitor's page whatever the address (`<meta name="strut-serve">`, `ServedBox`; `?shell=1` with the key or a session goes on, nothing deployed yet is `unserved`; plans/app-repos.md §4.2), the store front, ANOTHER strut server's public app alone (`?app=<name>&from=<base>`, ./remote-app; `refused` with why for a `from` it does not open), an app or a file alone, a MEMBER's apps list (plans/member-rights.md), or the shell; memberApps orders that list (pure; tested)

### `web/src/context-meter.ts`

the chat header's "351k / 1M": formatTokens + contextMeter (warns from 80%) over `ChatMeta.context` (pure; tested)

### `web/src/attachments.ts`

the chat composer's files read for `POST /chat` (a PNG/JPEG past 1568 px scaled down first; the server's limits checked early)

### `web/src/automation-form.ts`

the Automations editor's flat form state ⇄ trigger draft (pure; no calendar math — the server owns that)

### `web/src/earnings.ts`

Earnings' pure parts (plans/paid-runs.md §8; tested): fmtUsd / fmtSats, subjectLabel, the ranges, priceLine, withdrawBlocked (why Withdraw is off), maxWithdrawMsat, readWithdrawInvoice (the invoice read with src/payments/bolt11.ts and its fee cap from fee.ts — what the person confirms is what the route checks; the network left to the wallet; `shortOfWorkers` given what workers are owed), withdrawRefusal (a refusal said for a person), and what workers are owed (plans/human-steps.md §8.1: showsWorkers — none on a strut that never paid one — workersOwedSub, workersAcceptedLine, workersDayMsat, coverLine, shortOfWorkersWarning)

### `web/src/store-links.ts`

the STORE FRONT's pure parts (plans/marketplace.md §7; tested): parseStoreView / storeQuery (what `?store=1&pkg=|concept=|q=` names), the DEEP LINK out of the store — `installLink(strut, { pkg, index: { key, url } })` → `<strut>/?install=<name>&index=<key>&index_url=<catalog url>`, `parseInstallLink` (the shell's side), `indexIdOf` (the id a strut files a followed index under: its host), `normalizeStrutUrl` — and the folds the page draws from the open reads: `appsOf` (the hits' apps first, by title), `conceptRoots` (the tree's roots with how much sits under each), `conceptChildren` (the pages under each page, by name: what the tree opens a level at a time), `canWords`

### `web/src/store-run.ts`

the store's RUN FORM, its pure parts (plans/paid-runs.md §10 "The store"; tested): `priceWords` / `priceBadge` / `priceNotes` (free, fixed, metered, both; the reserve; what recent runs were charged), `runFields` (a workflow's `input:` block as the Run popover draws it — run-inputs.ts `bindingsFromInputBlock` — or a step's input JSON Schema), `inputOf` (the values as an input: empty left out, numbers and JSON read, a required one asked for), `httpCallResult` (a publisher's HTTP answer in the shape `callPaying` reads: 2xx its body, 402 `{ payment_required }`, else an error with its code and `Retry-After`), `newLaunchKey` (one per press), the runs a tab launched (`loadRuns` / `rememberRun`, `RUNS_KEPT`), `runFileUrl` (a run's file on its publisher, the run token as `?t=`), the sessionStorage keys per publisher

### `web/src/store-purse.ts`

what a page holds per publisher's server (browser glue over ./visitor-pay and ./store-run) — the store's Run form, and a remote public app hosted here (./remote-app), which share it in one page: `storePurse(base)` — the purse (credential, spares, invoices shown) and the runs launched there in this page's `sessionStorage` (`strut.store.purse:<base>`, `strut.store.runs:<base>`), one claim keeper per server resumed at load (`api.liveClaim`), one sheet at a time (`payInTurn`); `payWith` — show a challenge's sheet with its invoice claimed from that moment, a top-up replacing the credential it carries from

### `web/src/package-release.ts`

the Packages tab's pure parts (plans/packages-ux.md): pickerGroups (the workflows a package may take, by category — an installed package's, a seed's and a service's left out), sidebarGroups / nameInGroup / installedTitle (the sidebar's groups: an installed package's workflows a group of its own, drawn from `GET /packages` and never written — its segment as the label, its version beside it, each workflow by its name inside the package), comesAlong (what a dry build carries beyond the picks, the picks it leaves to the host, and `needs` — its `leftToInstaller`, shown once as "Needs on the installing strut"), picksFromRelease (what a release held, as the names here; a Concept the release carried alone, `alone` on its items, picked alone again), packageLabel, nextVersion (the last number up by one), PACKAGE_NAME, PACKAGE_SEGMENT (tested)

### `web/src/icons.tsx`

inline SVG icons

### `web/src/storage.ts`

crash-safe localStorage wrapper (UI prefs, session state)

### `web/src/step-depends.ts`

dependsForSave: what the step editor saves as `depends` — a checked list, `[]` when the step had an explicit `depends` and nothing is checked (a parallel step stays parallel; unchecking every dep means none), omitted when it never had one (still implicitly sequential)

### `web/src/peer-flag.ts`

the topbar's "Open to peers" toggle over a workflow's top-level `peer:` (a local edit Publish writes, like params): readPeer / applyPeer (off = the key removed) / togglePeer — turning a published `peer: person` off and on again restores `person`, never widens it to `true` (pure; tested)

### `web/src/step-attempt.ts`

latestAttempt: a step's events from its last `step.start` / `step.skipped` on — a resume continues the same log, so a re-run step's earlier `step.error` is still in it; the canvas status and the run flyout read only the latest attempt (pure; tested)

### `web/src/(folds)`

run-overview, transcript, accessed-nodes and artifact-view are the KIT's (`kit/src/folds/`), imported as `@strut/kit/folds` — vite.config.ts aliases it onto the source, tsconfig `paths` (web's and the root's, for the tsx test run) the same

### `web/src/walk-graph.ts`

foldWalk: graph_walk's progress outputs → nodes/edges/current/next — the kit's `foldWalkProgress` (kit/src/folds/walk/graph.ts) under the names the chat uses; tested against the real walk

### `web/src/elicitation.ts`

the builder's open question (meta.elicitation, ACP's flat schema) → FieldDesc[] for ConfigField + form helpers (pure; tested) — over the kit's one copy, `@strut/kit/folds` answer-form.ts, which strut/views' TaskForm draws a task's answer with too

### `web/src/embed.ts`

deep links when iframed (Hive): replaceUrl() posts ?wf/run/v/chat/job/app/input to the host named by ?embed_origin

### `web/src/visitor-pay.ts`

a VISITOR's page paid for by its HOST (plans/paid-runs.md §10, specs/API.md §17.6), pure and tested: the PURSE (`VisitorPurse`: the visit, the credential sent, `spare` credentials paid for and not sent, `pending` invoices shown and not settled; `loadPurse` / `savePurse` over a Storage, `creditSettled`), `newVisit` (the tab's visit secret, sent as `x-strut-visit`), `visitorHeaders`, `createClaimKeeper` (every invoice shown claimed until it settles or ends — `CLAIM_GRACE_MS` past it — whether or not its sheet is open, a settled one into the purse; `resume` after a reload), `keptCreditResult` (a paid launch the server then refused: the error, and that the payment is kept), `launchOf` / `paymentRequiredIn` / `refusesCredential`, `callPaying` (the page's `tools/call` as it is — or, with `launch: { workflow }`, any call the caller says is a launch: the store's Run form over plain HTTP; a `run/launch` answered `payment_required` first sent again with a spare, else handed to the host's payer and sent again with the credential the purse then holds — `Authorization: L402 <macaroon>:<preimage>` on the request, never in the call; cancelled → a plain `payment_cancelled` error; a payer's `{ error }` (a challenge that does not check out, ./challenge) → that error, nothing paid; a credential the DOOR refused dropped and the call sent once more — `refusesCredential`: a result's `code: invalid_token` with `status: 401`, else an error that BEGINS `invalid_token:`; never a step's failure whose text mentions it, which keeps the credential and is never sent again), `payInTurn` (one sheet at a time: a second priced launch waits, then goes again with what the first bought), `waitForClaim` / `claimAnswerOf` (`POST /public/credit/claim` until settled or expired), the sheet's words (`formatUsd`, `formatSats`, `creditLine`, `invoiceQrText`, `secondsLeft`)

### `web/src/visitor-signin.ts`

a VISITOR's sign-in, the host page's side (plans/app-repos.md §5.3): the providers — `key` (a non-extractable WebCrypto P-256 key made at the first sign-in, kept as the CryptoKeyPair in this site's IndexedDB), `nostr` (`window.nostr` signs a NIP-98 event for `POST /visitors/session`), `lnurl` (the code, then asked every 2 s until the wallet signed), `sphinx` (`signInWithSphinx`: the seller's challenge, one `sign_in` through ./native-pay `signInAsk`, then `method: "sphinx"` with the wallet's `address` when it kept one: `readSignInReply` keeps it only when its pubkey is `key`) — every one against the SELLER, this server or another one whose public app this page hosts (`from`, ./remote-app), `usableMethods` (what this browser can do; `sphinx` only with a native host that signs in), the session's token kept in this site's localStorage PER SELLER (`strut.visitorSession:<base>`) and sent as `Authorization: Bearer` (`x-strut-visitor` on `/public/mcp`, beside a credit token; another server's never with the UI header nor a cookie), `visitorInfo` (`GET /visitors`), `visitorChannelTicket`, `signOutVisitor`

### `web/src/app-host.ts`

strut's UI as an MCP Apps HOST (plans/apps.md §7.3): ext-apps' `AppBridge` over a `PostMessageTransport` on the frame's window, wired to the MCP SDK's `Client` + `StreamableHTTPClientTransport` at `/mcp` with the UI's credential (`apiHeaders`: the session cookie or the key, `x-strut-ui: 1`) — the bridge relays the page's `tools/call` by itself, as it is. `ui/message` → the builder chat (`appMessage` names the app), `ui/open-link` → for a strut deep link (`strutLink`: same origin and mount, `?wf/run/job/app/input/artifact`) the host's `onNavigate` — which in the canvas area and alone opens a served file or another app in the SIDE PANEL (`panelTarget`, components/AppWithPanel.tsx, plans/jamie-app.md §4) — and a new tab otherwise, `?input=` → `ui/notifications/tool-input` after the page's `initialized` and again in place when it changes (`appToolInput`; a link to the page on screen resends it, `namesApp`; a peer's page's `?app=<name>` is `@<peer>/<name>` and its `?artifact=<path>` `/peers/<peer><path>`, `peerAppLink`), a theme change → `host-context-changed`. Nothing hand-rolled. app-links.ts holds the pure parts (`strutLink`, `appMessage`, the app link helpers, `panelTarget` — which links open in the side panel) and their test (app-host.test.ts): the root test run installs no web/node_modules, so a web test may import nothing that needs them For an app it shows to a signed-in viewer (not a visitor's page) it also CARRIES CHANNELS (plans/app-channels.md §3; a peer's app's ticket names the peer, and the strut relays the socket there, §4): `experimental["strut/channels"]` in `ui/initialize`, and the kit's `relayChannels` with a ticket from `POST /apps/:name/channel-ticket` and a `WebSocket` to `/channels` (`api.channelTicket`, `api.channelSocketUrl`), closed cleanly with the frame. For a VISITOR's page the relay names the visit and pays (plans/paid-runs.md §10): one purse per tab in this page's `sessionStorage` (`strut.visitor:<base>`, never a frame's), its headers on every `/public/mcp` request (the transport's `fetch`); one `createClaimKeeper` that claims every invoice shown until it settles or ends, sheet or no sheet; once connected, `bridge.oncalltool` is `callPaying` over the client, its payer the host's `onPayment` (AppHost's sheet, handed the keeper's promise), and while a launch waits on it `notifications/progress` for the page's `progressToken` every 15 s, so the frame's 60 s request timeout never fires. Before the payer sees a challenge it is CHECKED (./challenge: junk is the page's error, nothing shown nor paid), its invoice claimed from that moment, and in a native host's web view the host's wallet asked first (./native-pay `walletAsk`, specs/WALLET.md §1.2). A visitor's page of ANOTHER strut server (`from`, ./remote-app, specs/API.md §17.9): the relay posts to `<from>/public/mcp`, its purse is that server's (./store-purse `storePurse(from)`, never this server's `strut.visitor:` one), its claims go there, its `ui/open-link` is read against that server's UI (`remoteHere`) and a link to another app there is hosted here too (`remoteAppLink`), and `ui/initialize` reports the clipboard alone (`strangerMcpPermissions`). Every page's `ui/open-link` opens `http(s)` and `mailto` alone (never a `javascript:` URL). The claim keeper watches an invoice until its DECODED end; a call pays at most once (./visitor-pay `paidAgainResult`).

### `web/src/challenge.ts`

a priced launch's CHALLENGE checked before it is shown or paid (specs/API.md §17.6 step 3), pure and tested against src/l402.ts's minter, Go's fixtures and src/payments/bolt11.ts: `readMacaroon` (libmacaroons v2 binary in the page — no Buffer, no node:crypto — its L402 identifier's payment hash and token id, its first-party caveats; a third-party caveat refused), `checkChallenge` (the invoice BOLT11 with an amount and not ended, the macaroon naming the same payment hash, `strut_sats` = `sats` = the invoice's, `strut_credit` = `usd`; else a sentence: "the server's payment request does not check out: …, so nothing was paid"). The seller writes `usd` and `strut_credit` both, so the PRICE is the sats (../visitor-pay `priceView`: dollars only at the hosting strut's `GET /rate`, the seller's dollars only as credit, flagged under 90% of what is paid)

### `web/src/native-pay.ts`

a visitor's credit paid with ONE TAP in a native host (Peel; specs/WALLET.md §1.2), pure and tested: `createHostWalletProbe` (`host_capability` asked ONCE per page — again only for another handler — warmed as a visitor's relay connects, so no sheet waits on it; a native host that buys credit or signs a visitor in), `creditPurchaseOf` (the checked invoice, the seller's figures, the seller, app and workflow — never the macaroon), `walletWaitMs` (until the invoice ends, at most 10 min), `walletAsk` (undefined with no native host or one that does not buy credit: the QR code from the start; else the sheet's `WalletAsk` — its name, `pay` = one `buy_credit` with a late answer handed on, `status` = `buy_credit_status`: paid → `<macaroon>:<preimage>` once the preimage proves it; pending → the person tapped and the payment was SENT, so the invoice is never shown again; fallback → nothing sent), `fallbackNote`, `PAYING_LONG_MS`, `STATUS_EVERY_MS`; and SIGNING A VISITOR IN with the same native host (`sign_in`, plans/app-payments.md §4.4): `signInAsk` (undefined with no native host that signs in: `sphinx` not offered; else `{ name, sign(challenge) }` — the request checked as the native host checks it, a challenge for another host than the seller never put to the wallet, one `sign_in` waited on until the challenge ends), `signInNote`

### `web/src/remote-app.ts`

ANOTHER strut server's public app with this UI as its host (specs/API.md §17.9), pure and tested: `remoteBase` (the `from` a link names, read as a seller's — https, or http to this machine; no credentials), `remoteAppHref` (`<strut>/?app=<name>&public=1&from=<base>&solo=1`), `remoteHere` (where the page's links lead: its own server's UI), `remoteAppLink` (a remote page's link to ANOTHER app on its server, hosted here too, never by the server's own UI), `APP_CSP` (the build's `cspFor()`, held equal by the test) and `strangerDocument` (that CSP written ahead of whatever the server sent; a frame may still navigate itself, so no place for a secret)

### `web/src/use-artifact-url.ts`

useFileScope: a served path's SCOPE listing (`GET /artifacts/:runId` / `/jobs/:id/files` / `/apps/:name/:version/files` → its files + file token), one fetch per scope for the page's life (`api.fileScope`); useArtifactUrl: the tokened URL over it; useFileBlob: a served file's bytes as an object URL, read with the UI's credential (`api.fetchArtifactBlob`) — how a PEER's file shows, since no token minted here opens the read-through and the key never rides in a `src`

### `web/src/components/AddStepDialog.tsx`

searchable Add Step picker (core / lib / custom)

### `web/src/components/AccessedNodes.tsx`

the run flyout's Nodes section: type chips (Concept by default, sticky), one row per node, a click opens its content in place (GET /graph/nodes/:ref_id)

### `web/src/components/ArtifactViewer.tsx`

the eye beside an artifact link (ValueFields): a modal showing the file RENDERED — markdown via Markdown.tsx, media inline, pdf/html in a frame (html sandboxed), text in a pre, a DIRECTORY as one level of folders and files, a WALKTHROUGH (`walkthrough.json`, `parseWalkthrough`) as frames to scrub — portaled onto <body>. It MOVES within the scope: a markdown link to a sibling (resolveArtifactLink) and a directory row open in place, a back arrow over the trail; a link out of the scope stays a link. A PEER's file (`/peers/<id>/…`, `isPeerPath`) is fetched with the UI's credential and shown from its bytes — media and a PDF from an object URL (`useFileBlob`, the PDF's typed `application/pdf`), markdown images through `FileImg` (Markdown's `img` hook), HTML as the `srcdoc` of `sandbox=""` (runs nothing) — and a file nothing renders DOWNLOADS (`api.downloadArtifact`) — for a peer's file and this strut's alike, beside the head's Download, which every file gets (a local one also keeps "Open in new tab"); no URL it builds for a peer carries a token or the key. `solo`: the head and body in normal flow, no backdrop — alone in the window with nothing to close (`?artifact=…&solo=1`), or in an app's side panel with `onClose` (AppWithPanel.tsx). An app the caller names (a published one, its document the path) renders through AppHost, not as HTML

### `web/src/components/WorkflowFlyout.tsx`

the selected workflow's own flyout, one tab each — Params / Claims / Automate / Versions (only the tabs that apply) — with "Delete workflow" in the footer, and under the tabs the APPS whose grants name the workflow (a chip each opens the app). The topbar's single **Workflow** button (claims dot riding along)

### `web/src/components/AppHost.tsx`

an app's page, hosted (a VISITOR's page signs the visitor in on `useVisitor().signIn()`: in Peel's web view the person's Sphinx account first, its own sheet the sign-in (`sign_in`, ../native-pay `signInAsk`); one tap with this browser's key when that is all there is; else SignInSheet.tsx over the frame — a button per method, **Sign in with ⟨wallet⟩** first, LNURL-auth's QR; on another server's page, `app.from`, the visitor signs in THERE, the session kept here per seller; channels once signed in where the public view offers sign-in, this server's page only) (plans/apps.md §7.3): the version's files listed (`useFileScope` mints the token), `dist/index.html` fetched under it (the server writes the app's identity into it), the TEXT framed as the srcdoc of `<iframe sandbox="allow-scripts allow-downloads allow-forms">` — an opaque origin, never `allow-same-origin`, no src with a credential; `allow-forms` so a `<form onSubmit>` fires its handler (the CSP's `form-action 'none'` still refuses the submission); never a `blob:` URL, whose document has its creator's `location.origin` and the whole URL as its pathname, which kills a validator in the MCP SDK's bundle at module time — with the relay (../app-host) connected over the frame's window BEFORE the document loads. The canvas area when an app is selected (the sidebar's Apps section, `?app=`), or the whole window with `&solo=1` (SoloApp.tsx) — in both inside AppWithPanel.tsx, so a file or another app the page links to opens beside it — an app of this strut there under a version chip (`panelChip`, app-versions.ts) listing its versions to VIEW in place, never to make live; the topbar shows its title, a chip with the live version and the drafts waiting (`v8 · live · 3 drafts`) that opens AppVersionsFlyout.tsx, a **Tab** toggle beside it (`PUT /apps/:name/pin`: shown as a tab in the hosts that list this workspace's apps; the sidebar's Apps list puts pinned apps first, marked `tab`) and **Edit with the builder** (the chat with the app named); a page's `ui/message` is sent on the builder chat; an `app_publish` in the chat reloads the frame. `app` is a workspace app `{ name, version }`. A visitor's priced launch shows PaymentSheet.tsx OVER the frame (never in it): the price in dollars and sats, what it is for, the invoice as a QR code (`qrcode-generator`) with Copy, waiting on the relay's claim (which outlives the sheet: a phone that pays after Cancel still buys credit), Cancel, a new invoice when one expired; the credential goes to the relay, which sends the page's call again. The sheet's price is the invoice's SATS, dollars beside them only at this strut's own rate (`api.trustedRate`, `GET /rate`), the server's dollar figure only as credit with a warning when it is worth under 90% of what is paid (../visitor-pay `priceView`). In a native host's web view (Peel) the sheet asks the host's wallet first ("Confirm the payment in Peel", with **Show the invoice** for a wallet that does not answer); once the wallet SENT the payment (pending, or settled unproven) the invoice is never shown again — a hostile seller could settle a second payment — and the sheet waits on the claim and the wallet's `buy_credit_status` (every 3 s; a failure brings the invoice back), saying after 60 s that a server may hold it, its Close telling the page the credit is kept; a wallet that sent nothing leaves the QR code with why and **Pay with ⟨wallet⟩**, a fresh tap (../native-pay). A late answer that the payment was sent takes a QR code already shown down. `app.from`: ANOTHER strut server's public app (specs/API.md §17.9) — refused with a sentence naming it when the server's `GET /public` lacks `host.remote` (`api.remoteHostable`), its info and document read from that server, its document framed as a STRANGER's: `strangerDocument` (this UI's CSP ahead of it) and `strangerFrameAttributes` (no microphone, nothing its version declares, no download, no fullscreen: the frame runs on this strut's origin), and the sheet naming the seller

### `web/src/components/SignInSheet.tsx`

the visitor's sign-in sheet over a public app's frame (plans/app-repos.md §5.3): the methods the server and this browser can do, **Sign in with ⟨wallet⟩** (the native wallet's `sign_in`: a press is the fresh tap it asks for), LNURL-auth as a QR code waiting for the wallet, Close answering the page that nobody signed in

### `web/src/components/AppScreenshots.tsx`

the Versions flyout's Screenshots section: the newest version's list (`GET /apps/:name/screenshots`), each a thumbnail with a caption, moved or removed; **Take a screenshot** (Desktop or Phone, `POST …/take`: this server's browser looks at the app) and **Upload…** (PNG, JPEG, WebP, GIF, ≤ 2 MB); **Save as a new version** (`PUT …/screenshots`, a draft while the app is held); its pure parts in web/src/app-screenshots.ts (tested)

### `web/src/components/AppVersionsFlyout.tsx`

an app's Versions (plans/app-releases.md), the topbar's version chip: the mode ("Every publish goes live" / "Hold a version"), the live version (since when, by whom), one row per version newest first — live, was live, draft (web/src/app-versions.ts, tested) — with View (this browser only: the frame shows it under a banner with Make live and Back to live), Make live, or Restore for a version that was live (its newest release); every change asks first; release ids only in History. No workflow version numbers: the lock's `behind` and `floating` are not shown until runs keep to the lock (work item 2)

### `web/src/components/AppUsageFlyout.tsx`

an app's Usage (`GET /apps/:name/usage`, src/apps/monitor.ts), the topbar's **Usage** button beside the app's version chip: the live version's warnings first (each with its fix and, for an app here, **Ask the builder to fix it** — a chat draft the person sends), calls per minute over the hour, the day by step type, earlier versions' warnings dim; refreshed every 10 s while open. The warning dot (`.usage-dot`) sits on the app's sidebar row, the Apps title and the Usage button while `GET /apps` carries `warnings`; the shell re-reads this strut's apps every 30 s for it

### `web/src/components/Store.tsx`

the STORE FRONT (`?store=1`, plans/marketplace.md §7; specs/API.md §14.3): an index strut's public page, rendered ALONE in place of the shell for anyone with no credential, over the open reads alone (`api.storeCatalog` / `storeSearch` / `storePackage` / `storeConcepts` / `storeConcept`: a plain fetch, never the key) — Browse (a hero with the index's counts; the apps across the hits first, each a package's face off `detail` — its first screenshot as a square on the card's left, "+N" for the rest, the initials when it has none; the packages; the Concept roots as cards; the publishers off the signed card; the one line that adds the store to an MCP client; a footer saying it is all derived; a search, `/` to focus it, returns the matching packages and Concept pages), a package's page (read with `?docs=0`; its counts as a strip that jumps to each part; apps — one with screenshots as a gallery, one large with arrows, ← → and a strip of thumbnails under it, its caption, the app's facts beside; one without as a card; the workflows as rows that open to their inputs, steps and agent tools, with what each reaches — the `spends` / `acts` / `code` chips, `CanChips`; its steps, titled Tools as the shell's sidebar titles them, with secrets and lint; the Concepts as a TREE, `ConceptTree`: the roots with their counts, a branch opened in place and its children drawn only then, a filter over every page through `src/search.ts` — never one flat list, a package carries hundreds; the README; the aside: needs, the publisher's key, releases and channels), the Concept pages as a wiki (the same tree as the index; a page's docs, its children as rows 24 at a time, in which packages). Its own scale and a darker palette: components.css redefines the shell's palette variables on `.store`, so the shared `.btn`, `.badge` and `.md-view` follow. Nothing installs here: **Install into your strut** is `installLink` into the visitor's own strut ("Your strut", kept in localStorage; else asked, the name to paste beside it). On a strut without the role: "Not a store". LIVE items (plans/public-surface.md §8): the index's live rows (`PUT /index/live/:prefix { url }`, the card's `live` map beside `publishers`, read at the row and every crawl; `GET /index/live`) show as **Live apps** and **Live workflows and steps** on Browse, each a page read from its publisher's `/public` in the visitor's browser (an app framed from `?app=&solo=1&public=1` with "Open full page" and, when the publisher's `GET /public` says `host.remote`, **Open in your strut** — `remoteAppHref` into the visitor's own strut, "Your strut" as Install keeps it, so that strut's UI hosts the app and pays for its runs, specs/API.md §17.9; a workflow's inputs, steps and recent runs; a step's fields and source), and a Concept only a live view holds reads its docs from there. A live workflow or step anyone may RUN (plans/paid-runs.md §10 "The store"; its price badge on Browse off the index's `run`) gets, read fresh from its publisher's `/public` `runnable` (a runnable-only item's definition 404s and is said not to be public), a PRICE card (`priceWords`, the reserve, what recent runs were charged) and a **Run** (or **Call**) form drawn from its input (`RunPanel`, ConfigField over web/src/store-run.ts `runFields`): the launch goes to the publisher from the visitor's browser with no credential of anyone's, one `key` per press sent again with every retry (after a payment, after a dropped request — a call is never sent twice); a 402 shows PaymentSheet.tsx and the paying loop is ../visitor-pay's `callPaying` over the HTTP answers (`httpCallResult`, whose errors carry their `code` and `status`, so only the door's own 401 `invalid_token` drops the credential — never a step's failure that mentions it, which is never sent again); the credit and every invoice shown live per publisher in this page's `sessionStorage` (web/src/store-purse.ts), claimed until it settles or ends whether or not the sheet is open; the runs this tab launched are read back with their run tokens until they end (`RunView`: status, output, files, what it was charged; a run that ended with its charge pending says so, `runEnded`), and the credit line refreshes then; the credit lives in the tab, and **Your credit lives in this tab** shows the credential on request (Copy) and takes one pasted back (checked with `GET /public/credit`) — never in a URL

### `web/src/components/AppRail.tsx`

the COLLAPSED sidebar (the toggle beside "strut", `sidebarCollapsed` in localStorage): one tile per app — two letters, a hue from its key, pinned first, the usage dot — its title in a tooltip fixed to the window; a click opens the app. The sections stay mounted, hidden, so each keeps its scroll

### `web/src/components/AppWithPanel.tsx`

an app's page with a SIDE PANEL beside it (plans/jamie-app.md §4, §4.1): what the app cannot show in its own document (`frame-src 'none'`, `run/files` 2 MB) it hands over as a strut deep link through `ui/open-link`, and this host opens `?artifact=<served path>` (`isServedFilePath`: a job's files, a run's artifacts, a peer's read-through) through ArtifactViewer (`solo` + `onClose`) and `?app=<key>` (another app, a peer's too) through AppHost under a title bar, instead of navigating away — the page keeps its frame and its state. `panelTarget` (app-links.ts) decides; a new link replaces the panel's content (an app's new input in place), ✕ closes it, its left edge resizes it (`WidthResizer`, `--app-panel-width` on `.app-split`, `strut.appPanelWidth` in localStorage), and in a container under 760 px it lies over the page (a container query). The panel's own app links the same way. A link to the page itself, a workflow, a run or a job goes to the caller's `onNavigate` as before. Not in the address bar: a reload closes it. No panel for a visitor's page. Used by the canvas-area host (app.tsx) and SoloApp.tsx, not by the job timeline's or the viewer's app

### `web/src/components/MemberApps.tsx`

a MEMBER's page (plans/member-rights.md): the apps here (`GET /apps`, strut/views left out, strut/jamie first, then pinned, then by title), each opening alone as `?app=<name>&solo=1` — what a member who opens strut directly gets instead of the shell

### `web/src/components/SoloApp.tsx`

`?app=<key>&solo=1`: the page ALONE, nothing of strut's around it, for a native host's web view (plans/apps.md §7.4) — `App` renders it in place of the shell, so it reads only the listing the app is in (`GET /apps`, or that one peer's `GET /peers/<id>/apps`; `parseAppKey`) and the app's files: no workflows, step types, other peers or `/runs/active` poll. A key ending in `@vN` (`bench@v3`, an import's pin) shows that version instead of the live one — a held app's draft, for `app/look`; one ending in `@preview-<hex>` an unpublished build `app/look { path }` hosts, no listing read (the lookup is `useListedApp`, web/src/use-listed-app.ts, which the side panel shares). `&theme=light` (or `dark`): the theme it hands the app (`soloTheme`, app-links.ts), for a host whose own page is light; dark without it. No `ui/message`; a link to itself is its input in place (the address bar follows), a file or another app opens in the SIDE PANEL inside this one page (AppWithPanel.tsx) — how Hive and Peel, which frame this page, show what the app cannot frame — and anything else a new tab. `&public=1`: a VISITOR's page (plans/public-surface.md §5) — `GET /public/apps/<name>` and its document, AppHost's `visitor` relaying to `POST /public/mcp` with no credential of the UI's — its visit, and the credit a priced launch's sheet bought (plans/paid-runs.md §10); what the store frames from a publisher's server. `&public=1&from=<base>` (./page: `solo` implied, for anyone; a `from` it does not open is a page saying why, never this strut's app of the same name): ANOTHER strut server's public app, read from that server with this UI as its host — what Peel opens for a stranger's page, so the wallet bridge sits beside Peel's own UI and never a stranger's copy of it (specs/API.md §17.9)

### `web/src/components/IndexPanel.tsx`

the Publish dialog's **Index** tab, only on an index strut (plans/index-listing.md §3): the listing requests WAITING for the operator — name, key, host, what its catalog holds, why it waits (a takeover in red) — with Approve and Refuse (a reason the publisher reads), the LISTED rows with their last read and Delist, and Add by hand (`PUT /index/:prefix`). The shell asks `GET /index/requests` once (a 404: no index, no tab) and, on an index, every minute: a dot on the tab and the Publish button while any wait

### `web/src/components/EarningsPanel.tsx`

the Publish dialog's **Earnings** tab (plans/paid-runs.md §8): the wallet's balance in sats and at the rate, **Add sats** (DepositDialog.tsx; disabled with no wallet that receives) and **Withdraw** beside it (disabled, saying why, without a pay credential: `withdrawBlocked`), the credit still owed as service, once any worker was paid **Owed to workers** (sats at the rate, held and withdrawable, plans/human-steps.md §8.1) and under the balance whether it covers that (red when short), the books' check (received + added − withdrawn − fees against the balance), the sends on their way (each with **Read it now**, and **Record as paid** / **Drop** once stale or sent through a wallet no longer set); a range (7 / 30 / 90 days, all time); earned, cost, margin, received and withdrawn tiles; by item (with each price) and by day (an Added column when any sats were added by hand, a Workers column — sats accepted less taken back — once any worker was paid); **Buying** (BuyingSection.tsx: `GET /remote/credit?balance=1`, per server the credit left, held, bought, when it ends, a purchase still being paid with Drop — `DELETE /remote/purchases` — and the remote runs waiting; buying itself stays an accepted `remote/buy-credit` proposal); the wallet's settings at the bottom (`GET`/`PUT /earnings/wallet`: provider, receive and pay credentials, Remove). `GET /earnings` twice (by item with the wallet, by day)

### `web/src/components/DepositDialog.tsx`

**Add sats**, over the Publish dialog: an amount (presets, dollars at the rate), `POST /earnings/deposit`, then the invoice as the payment sheet's QR (`qrSvg`, a `lightning:` link) with Copy and Open wallet, read every 2 s (`…/deposits/:hash/read`) until it settles (Added: N sats, and the tab reloads) or expires; closing it loses nothing — the server keeps reading the invoice

### `web/src/components/WithdrawDialog.tsx`

Withdraw, over the Publish dialog: a BOLT11 invoice pasted and READ with the server's own reader (src/payments/bolt11.ts via web/src/earnings.ts `readWithdrawInvoice`) — the amount it asks in sats and dollars, its description, its expiry, its network when not mainnet (the wallet judges it), the fee cap (the LSP's limit; the NWC wallet's own), a warning past the most that can go out (`maxWithdrawMsat`: the whole balance with the Sphinx provider, less the fee with NWC), and one when the amount and its fee cap out would leave the wallet short of what workers are owed (`shortOfWorkers`, plans/human-steps.md §8.1 ruling 7: a warning, never a refusal) — beside the balance, the credit owed as service and, once any worker was paid, what workers are owed; **Review**, then "Pay N sats … ? It cannot be taken back."; `POST /earnings/withdraw` with the amount shown; the answer as paid (fee, payment hash), sent-not-settled (Ask again), failed (the wallet's words, Try again), or refused (`withdrawRefusal`)

### `web/src/components/EarningsLine.tsx`

one item's earnings in a line — price, runs, failed, earned, cost, margin — and `useEarnings(q)` (`GET /earnings`, null when this credential may not read it): the Public view's runnable row ("Here, all time"), the Workflow flyout (under the tabs, "Sold"), a package's page in the Packages tab ("Earnings here": `package=`, the items its newest release holds by their names here, summed, then each), and each installed package's row ("Sold here", one `by=package` read)

### `web/src/components/PublishDialog.tsx`

the topbar's **Publish**: one dialog, three tabs (four on an index: **Index**, IndexPanel.tsx) — **Packages** (PackagesPanel.tsx, the copies other struts install), **Public view** (PublicViewPanel.tsx, what anyone reads here live) and **Earnings** (EarningsPanel.tsx, what anyone's runs were charged and the wallet). A tab mounts when first shown and stays mounted, so a Public view draft survives a look at Packages (the tab carries a dot while it has one); one height for both, the tab's body scrolling between the tabs and Close; the button opens on the tab used last (`publishTab` in localStorage), `?install=` on Packages

### `web/src/components/PublicViewPanel.tsx`

the Publish dialog's **Public view** tab (plans/public-surface.md §2, decisions 19–20): what anyone can read on this server, live and read-only — **In the store** first (ListingLines.tsx in its view mode: one line per followed index, **Show on <index>**, the name asked when unset, Shown / Waiting / Refused, Stop showing or Take off; plans/public-view-listing.md §5) — the record (`GET`/`PUT /public-view`) as rows per kind (an app with its reads, "Open as a visitor" and its link; a workflow or a step as a row of three boxes — its definition, its runs (a workflow's; ticking them ticks the definition), and **anyone can run it** (plans/paid-runs.md §2), which opens its price: base, markup, per-run cap, daily cap, what the launcher reads, the reserve it derives, the closure's `spends` / `acts` / `code` chips and what its runs here cost over 30 days (`GET /public-view/runnable`), the save's checks said first, and for something that acts or runs code a tick before Save; Concept roots), a SIGN-IN section (plans/app-repos.md §5: the methods a visitor may sign in with, a key per domain, each visitor's daily writes and launches — the record's `visitors`), an Add bar whose app or workflow asks `GET /public-view/needs` and shows the cascade pre-checked, every line with what it exposes, Save (a bar held at the bottom of the tab while there are unsaved changes) writing the whole list and saying which apps it held; its pure parts in web/src/public-view.ts (tested)

### `web/src/components/ParamsPanel.tsx`

the Params tab: edit the workflow's `params` (edits → Publish, a new version)

### `web/src/components/VersionsPanel.tsx`

the Versions tab: every version newest-first with its run counts (GET /workflows/:name/versions, attributed by the run's recorded workflowHash) + View / Make active (rollback via PUT /workflows/:name/active — publishes nothing) + a YAML toggle per version: the file as published (GET /workflows/:name/:version, fetched on first open), read-only in SourceCode; a version that came from a package says so — "installed from" (or, an edit carrying it forward, "forked from") `<package> <version>`, off `upstream` in GET /workflows/:name

### `web/src/components/PackagesPanel.tsx`

the Publish dialog's **Packages** tab (plans/packages-ux.md): where packages live — names stay bare where they are made and the sidebar knows nothing of packages. Its head is the PUBLISHER — the name, set once (`PUT /publisher { name }`, the first segment of every package published here; nobody types it again) beside the key — and, once there is a public key, one line per followed index: **List on <index>** (a form: this server's address, prefilled from the page, description, homepage, also its public view), then **Listed** (read off the index's signed card; "· public view shown" with the live row), **Waiting for approval** with Withdraw, or **Refused**, and Change / Take off (`/publisher/listings`, plans/index-listing.md) — ListingLines.tsx, shared with the Public view tab. **Here**: the packages this strut published (the catalog's), one row each with the newest version, and **New package** (one segment, under the publisher). A row opens the PACKAGE PAGE: every workflow here by category with a checkbox (`pickerGroups`: an installed package's, a seed's and a service's left out; a filter past eight), apps, Concepts (a typeahead, on a graph; each chip "with its pages" or "alone", `conceptsAlone`); the boxes start as the newest release left them (`GET /packages/:publisher/:name/items`); **Comes along** reads a dry build of the picks (`POST /packages/build { dryRun: true }`: the subflows, steps and apps it carries, the picks the host keeps, what the installing strut must already have, the secrets it needs, or the refusal); version after the newest release, channel (`stable`), description, the peers the publish will ping, **Publish** → `POST /packages/publish`, its answer or the refusal verbatim, then the releases newest first with what each channel holds — a channel moved to any release (a rollback), the package taken out, or **Make public** (the channel `public` marked and moved: the release listed in the public catalog, sealed by the publisher's second key, for anyone; a public channel's badge says so, and the head shows the public key beside the fleet key). Below, read only: what it FOLLOWS and has INSTALLED (with `door`). Never from a workflow's flyout. A person's act — no builder or `meta/*` tool publishes

### `web/src/components/AutomationsPanel.tsx`

the Automate tab: list (toggle / Run now / last run) + editor (repeat form, live "next runs" preview from the server, inputs with fire-time tokens)

### `web/src/components/ChatFlyout.tsx`

AI workflow-builder chat (detached launch + reattach; chatId in localStorage; renders the open question's form; the context meter in its header)

### `web/src/components/Transcript.tsx`

the entries renderer (bubbles, tool chips, notices, marks) the chat flyout and the thread view share

### `web/src/components/JobTimeline.tsx`

the selected job in the canvas area (plans/jobs-sidebar.md §3): header + totals, deliverables (cards → ArtifactViewer / a link / inline content; a peer-tagged one `{ peer, via?, job, path }` badged `@<peer>` and opened in the viewer through the peer's read-through — `linkOf` maps it with `peerArtifactPath`, `/peers/<peer>[/peers/<via>]/jobs/<job>/files/<path>`, and never takes a strut-relative url of the peer's as local; RunOverview's artifact list shares `linkOf`), the thread TREE (a thread row with totals; its turns with time, run link, tools, duration, cost, context, artifact chips marked current/superseded; spawned threads nested), every node the job's agents touched (AccessedNodes over the fold). A turn's run id opens that run on the canvas with the flyout on its step; `transcript` opens ThreadFlyout. A `kind: "app"` deliverable — a workspace app by name and version (the builder's; `api.hostableApp`) — opens in place under the cards — the first one by default — in JobAppPanel.tsx: AppHost under a bar with Reload, Expand (the viewer) and "Under Apps"

### `web/src/components/ThreadFlyout.tsx`

one thread read back, read-only (§4): the turn's `?full=1` transcript rendered by Transcript with a mark at each turn's `offset`, the system prompt collapsed on top, no input box

### `web/src/components/ElicitationForm.tsx`

the builder's question at the end of the transcript: a form (Submit / Decline / ✕) or, for a secret, a password field posting to the /secret endpoint — the page a host's link opens (?chat=&elicit=)

### `web/src/components/ConfigField.tsx`

field renderer driven by Zod-derived FieldDesc (+ the node-name typeahead for a field with `nodeType`, via graph-search)

### `web/src/components/CreateDialog.tsx`

new-workflow dialog

### `web/src/components/EventsPanel.tsx`

bottom run-events panel: the log, and beside it an `aside` column (RunOverview)

### `web/src/components/RunOverview.tsx`

the run at a glance, right of the event log: status + job chip, Cost and Model calls tiles (a public run's **Charged** beside Cost: its charge and the reserve it held, `GET /earnings/entries?runId=`, plans/paid-runs.md §8), the spend split by who spent it, the run's time, the files the launch ATTACHED (`run.start.attachments`, folded by run-overview: each opens in the viewer, or downloads when nothing renders it, with a download button beside it), the declared artifacts (`GET …/runs/:runId/artifacts`, the viewer) + its file listing, the timeline (hover card: time range, cost, calls; a click opens the step's flyout or the child run), then Claims (`GET /workflows/:name/evidence?runId=`) and the output, folded

### `web/src/components/EventsResizer.tsx`

drag handle for events panel height

### `web/src/components/Markdown.tsx`

tiny markdown renderer for chat output (headers, lists, fenced code, quotes, pipe tables, inline marks); `resolveLink` (the viewer's) turns a link whose target the caller can show into an in-place open, and is the only way an image renders — nothing but the scope's own files is loaded

### `web/src/components/RunInputPopover.tsx`

input-payload editor when triggering a run

### `web/src/components/SecretsDialog.tsx`

manage deployment secrets (write-only values; names+meta listed)

### `web/src/components/SourceCode.tsx`

read-only, syntax-highlighted source: a step's TypeScript (Lezer's TS parser) or a workflow version's YAML (`language: "yaml"`, the lang-yaml parser already bundled for YamlEditor) → `tok-*` spans colored in components.css — the Source toggle in the step editor + Step Info flyouts, the YAML toggle in the Versions tab

### `web/src/components/StepEditFlyout.tsx`

edit step (id / type / config / depends / options)

### `web/src/components/StepRunFlyout.tsx`

view a step's run I/O (leaf: input/output; container: aggregate summary); a parked step's "Waiting on" through WaitingOn, as the run overview's

### `web/src/components/WaitingOn.tsx`

what a waiting run (RunOverview's "Waiting on") or a parked step (StepRunFlyout) waits on: each `task:<id>` a button opening `strut/staff` on that task (`selectApp("strut/staff", "task=<id>")`, plans/human-steps.md §9.1) for a viewer it is listed to — `staffListed`, app.tsx's `GET /apps` holding it, so an admin; anyone else, or any other source, reads the text

### `web/src/waiting.ts`

WaitingOn's pure part (tested, waiting.test.ts): `waitingParts(on, staffListed)` — each part, and for a `task:<id>` with the app listed the app and its input (`task=<id>`); `STAFF_APP`

### `web/src/components/WalkView.tsx`

a graph_walk call in the chat: paced hop playback (live) / final state + replay (history), node detail, open run

### `web/src/components/WalkGraph.tsx`

d3-force graph of a walk (ported from hive): ONE simulation for the component's life, nodes kept by id, joins not rebuilds

### `web/src/components/FlyoutResizer.tsx`

drag handle on a panel's left edge: `WidthResizer` (a width property on a holder element, kept in localStorage; frames take no pointer events during a drag) — `FlyoutResizer` the flyout's (`--flyout-width` on `.shell`), AppWithPanel the side panel's

### `web/src/styles/base.css`

palette (CSS vars on :root), reset, type

### `web/src/styles/components.css`

shell grid, sidebar, flyout, dialog, events, chat, badges
