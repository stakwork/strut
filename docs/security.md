# Auth, secrets and the env boundary

Who may call what (the key, sessions, peer and person tokens, members, visitors), the secret stores, and the boundary that keeps the environment away from steps.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

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
  that too — and the POSTs by name (`PUBLIC_POST`, exported from the
  package with `PUBLIC_PATH` for a host gate in front of strut): a
  visitor's page calling its app (`/public/mcp`), anyone's launch of a
  workflow a person made runnable (`/public/workflows/:name/run`,
  plans/paid-runs.md §3), that launcher's cancel (`…/runs/:runId/cancel`,
  its run token), anyone's call of a runnable step
  (`/public/steps/:type/run`, §6), and buying and claiming credit
  (`/public/credit`, `/public/credit/claim`). A key or session sent with
  them is ignored. And `GET /llms.txt`: the index role's page, else the
  public view's (`src/public-agents.ts`), a `404` when nothing is public.
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
  reaches the builder through Jamie. But installing a package is an
  ADMIN's act whatever the door: `package/install` is `approver: "admin"`
  (see "Proposals"), so a member's Jamie neither proposes nor accepts one.
  "Is this session the key's equal" is an ALLOWLIST (`fullSession`: the
  key login's, no role, or an admin's) — never "not a member" — so a role
  strut adds later opens nothing by default.
- **Visitors — a public app's players** (plans/app-repos.md §5;
  specs/API.md §13.2; src/visitors.ts). A public app's visitor may sign in
  by SIGNING strut's challenge with a key and is then that key's actor
  here (`p256:<key>`, `secp:<key>`), or a host vouches with `POST
  /auth/ticket { actor, role: "visitor" }`. In Peel the key is the
  person's Sphinx account (`sphinx`, a Lightning signed message, the
  `ln-message` verifier): strut's UI asks the native wallet with
  specs/WALLET.md §1.2's `sign_in`, which signs only a strut challenge
  for the seller's host. The methods a server takes are
  its public view's `visitors.signIn` (on a served box, `serve.yaml`'s
  `signIn`); none named, `sphinx` once an app is public, and `signIn: []`
  none. `GET /visitors/challenge` → `{
  challenge, methods, visitorKey }` (`strut-visitor.<claims>.<hmac>`, a
  minute, good once, bound to the host), `POST /visitors/session {
  challenge, method, … }` → the visitor's cookie and `{ actor, token, exp }`,
  `DELETE` signs out; all open to anyone, as signing in must be. A
  visitor's session is role `visitor`, scope `visitor`, in its OWN cookie
  (`strut_visitor`: never the operator's on the same origin), lives 30 days,
  and its token is also accepted as `Authorization: Bearer` (a page framed
  by another site, where the browser drops the cookie — ruled 4) or
  `x-strut-visitor` (beside a credit token on `/public/mcp`). A `sphinx`
  sign-in may carry the account's Sphinx `address`: kept in the session's
  signed claims (`Session.sphinxAddress`, claim `address`, refreshed by each
  sign-in) only when its pubkey is the `key` that signed (`keptSphinxAddress`,
  src/visitors.ts); else dropped, and the sign-in holds. A visitor is
  NOT a member: past what is open to anyone (the public apps' pages and
  files, `POST /public/mcp`, `/visitors/*`) the gate passes `GET
  /auth/session` and its public app's `POST /apps/:name/channel-ticket`, and
  everything else is 403 — Jamie, `/mcp`, `/apps`, a host's later routes;
  `createStrut.test.ts` ("a visitor's session") sweeps them as cookie and
  as bearer. On `POST /public/mcp` a signed-in visitor's page gets §5.1:
  its own `app/state`, channels, graph writes and `graph/find` on the
  app's declared types (kept as runs with its actor), and `run/launch` of
  a granted workflow that spends nothing, as itself — a spending one only
  as `runnable`; per-actor daily limits (`serve.yaml`'s `limits` over
  strut's defaults) and a per-address budget on top.
- **Scope — what another strut may do** (plans/federation.md §3). Past the
  credential, the gate asks `createStrut({ resolveScope(c) })` — the twin of
  `resolveActor`, the host's call (mcp maps its JWT's scope) — whether the
  request is `full` or `peer` (or `member` or `visitor`, above). The default (`scopeFromKey`) says `peer` for
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

- **The wallet's credentials are not secrets a step reads**
  (plans/paid-runs.md decision 20; `src/payments/settings.ts`). The server's
  wallet (`LIGHTNING_*`, `PUT /earnings/wallet`) lives in `payments.json`,
  its own encrypted file, never `secrets.json`. Every name the
  `HIDDEN_FROM_STEPS_PREFIXES` cover (`env.ts`: `LIGHTNING_`, any case),
  and `STRUT_SECRET_KEY` (`HIDDEN_FROM_STEPS_NAMES`: it decrypts that file),
  answers nothing through `ctx.services.secrets` — from the env snapshot,
  the deployment's store or an actor's — and createStrut wraps a host's
  own `secrets` the same way (`hideSecrets`); `PUT /secrets` and an app's
  `secret/add` refuse one. What a step gets is `ctx.services.lightning`,
  the receive side, which cannot pay.

- **Credit bought at another strut is not a secret a step reads either**
  (plans/paid-runs.md §10; `src/remote.ts`). The L402 token this strut
  holds at each seller lives in `entitlements.json`, an encrypted file of
  its own beside `payments.json` (the file `plans/marketplace.md` §6
  reserves), under `ENTITLEMENT_` names the secrets capability answers
  nothing for. The `remote/*` steps present it through
  `ctx.services.remote`, which never returns it; `GET /remote/credit` (full
  scope) says what is held where, never the token. Buying is an admin's
  accepted `remote/buy-credit` proposal, paid through the payer.

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
  time for every step inside a version of a workflow the AI wrote (the
  version that runs, `aiWroteVersion`: a seed put back at boot, or a
  person's own later version, is not held; the AI's version run by name or
  by a pinned subflow is) or a `meta/run-step` run (`ctx.aiAuthored`, kept
  by a subflow, inherited by an agent's tool calls and a proposal's apply),
  as resolved — what a model passes a tool, a version the AI wrote before
  the host set a reach, a person's subflow changed since — and the
  launcher's MCP servers are
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

## Files

What each file and folder in this area is, in the order of the tree.

### `src/auth.ts`

the pieces of createStrut's one gate in front of EVERY route, reads included — carriesApiKey (Bearer or `?key=`) + requireApiKey (the per-route twin) + warnIfUnconfigured (STRUT_API_KEY shared secret) + the PEER KEY (STRUT_PEER_KEY: carriesPeerKey, scopeFromKey — the default `resolveScope`; a `peer` request reads, launches a `peer: true` workflow, controls a run a peer launched, and the gate 403s the rest) + the PERSON TOKEN (personToken / verifyPersonToken / personOf: the peer key attenuated to one actor, `strut-person.<claims>.<hmac>` signed like a session, Bearer only, minted by `POST /peers/tokens` — scope `peer:person`, `isPeerScope`: a peer whose actor is its credential's own, which alone launches a `peer: person` workflow, opens its actor's own sessions and gets an app's `step_run` alone on `POST /mcp`; plans/chained-orchestrators.md §2, plans/apps.md §7.4) + actorFromHeader, the default `resolveActor` (x-strut-actor, honored only with the key; a person token's actor wins) + the FILE TOKEN (fileToken / fileScopeOf / carriesFileToken): the key attenuated to one run's or job's files, an HMAC the listing mints, what an artifact link carries as `?t=` so the key is never in a URL a served page can read. The app IDENTITY a served document carries: `appIdentity` (`app:<name>@<vN>.<token>`), read back by `appOfIdentity` → `ctx.app`. The CHANNEL TICKET (`channelTicket` / `channelTicketOf`, plans/app-channels.md §2): `strut-channel.<claims>.<hmac>` naming the viewer, the app and its version for a minute, the one credential that opens `GET /channels` — a browser host's upgrade, which carries no header (unsigned, and taken at its word, with no secret to sign under) + the VISITOR's session (plans/app-repos.md §5): role `visitor`, scope `visitor`, in a cookie of its own (`strut_visitor`, so a visitor's sign-in never replaces the operator's console session on one origin) and accepted as `Authorization: Bearer <token>` or `x-strut-visitor` (a page framed by another site keeps the token, ruled 4) — `visitorOf`, `startVisitorSession`; and the visitor's CHALLENGE (`strut-visitor.<claims>.<hmac>`, `{ host, visitorKey, nonce, exp }`, a minute, good once: `visitorChallenge` / `redeemVisitorChallenge`). `fullSession` — "is this session the key's equal" — is an ALLOWLIST (no role, or `admin`), so a member's, a visitor's or a role strut does not know opens nothing

### `src/secret-store.ts`

SecretStore iface + FileSecretStore (AES-256-GCM, STRUT_SECRET_KEY; optional filename for a second file) + MemorySecretStore — backs ctx.services.secrets + /secrets endpoints

### `src/actor-secrets.ts`

per-ACTOR secrets (plans/code-change.md §3.2): ActorSecretStore over any SecretStore (`A_<hex(actor)>_<NAME>` keys; a third encrypted file, actor-secrets.json), behind PUT/DELETE /actors/:actor/secrets/:name + GET /actors/:actor/secrets. The runner binds a run's `secrets` to its principal (`SecretsCapability.forPrincipal`), so `secrets.get(NAME)` resolves the actor's value first — never in /secrets or list_secrets

### `src/env.ts`

the ENV BOUNDARY: `bootEnv()` is the one way strut's own code reads the environment (env.test.ts fails on a `process.env[…]` read anywhere else under src/), and `scrubProcessEnv()` — called by the default server's entry (`startServer`: server.ts, desktop.js), never by createStrut — copies the env into that snapshot and empties `process.env` down to `KEEP_ENV` (the shell allowlist + what Node reads lazily + what Windows needs to spawn), so a step's `process.env.X`, or a child it spawns with `process.env`, finds nothing while `ctx.services.secrets` still resolves a key the deployment set in env. `STRUT_ENV_SCRUB=0` / `STRUT_ENV_KEEP`. A host that embeds strut calls it itself once its steps read through ctx.services

### `src/step-lint.ts`

the static check on a custom step's SOURCE — imports of child_process / fs / net / http (RISKY_MODULES), a `process.env` read, the global `fetch`, opening the graph itself (`openGraphBackend` and its siblings — the deployment's shared connection; a step that closed it took swarm38's graph down, 2026-10-28) — each with what to use instead. The builder's create_step / edit_step (+ meta/* twins) REFUSE on a finding (authoring.ts); `POST /steps` publishes and answers with `warnings`; the registry WARNS when it loads a workspace step from disk, whoever put it there (registry.ts `warnPastServices`, once per file version; static, so it holds under tsx, which loads a workspace `.ts` as CommonJS past any ESM resolve hook) — the place a later strut refuses to load it

### `src/steps/lib/secret/`

secret/add { name, value } (plans/member-rights.md "Adding a secret"): a secret a PERSON types into strut's own app — the builder's reply names it in `ask.secret`, Jamie's SecretBox stores it — FILLING A BLANK through `ctx.services.secretBlanks` (src/secret-store.ts `secretBlanks`, set by createStrut when strut owns the store): refused (`secret_set:`) when the name has a value in the store or the environment, so a member never replaces the team's model or GitHub key; never lists, reads, changes or deletes one. Answers `{ name }` alone. Runs only as a first-party page's own call (a one-step run, for its viewer), never an agent's tool or a model-written page's; its `value` is `redact`ed from the run's events (`StepDef.redact`, runner.ts), so no log, sink or kept run holds it
