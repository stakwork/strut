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
  And the sign-ins, where what a request carries is the credential: a
  visitor's (`/visitors/*`, below) and Peel's link to a box (`GET
  /people/challenge`, `POST /people/link`, `POST /people/token`: a challenge
  strut signed and a key's signature over it, "Peel links to a box" below).
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
  through the person's session. And (3) a WebSocket upgrade — no
  preflight, no custom header, and a same-site page's handshake carries
  the cookie — spends none of this origin's cookies when it comes from a
  page of another origin (`foreignUpgrade`: the browser's `Sec-Fetch-Site`
  is anything but `same-origin`, or, with no fetch metadata, `Origin`
  names another host than the one asked for — `x-forwarded-host`, else
  `host`): `upgrade` (`/rooms`, `/channels`) and the dictation socket
  drop the `cookie` header first, so a neighbour box's page cannot join
  the person's room, send in an app's channels as them, or dictate into
  their audio session; a channel ticket, a key or a person token still
  opens them from anywhere. `createStrut.test.ts` ("a session") runs
  the whole flow; the route sweeps leave out the two open login routes.
  **A host signs one person in** (auth.ts "Sign-in tickets", specs/API.md
  §13.1) — the standalone twin of mcp's `/mint-token` JWT handed to
  `/lab/?key=`: the host's SERVER mints `POST /auth/ticket { actor, role?, name? }`
  (full scope; the actor the host's to name, checked like `/peers/tokens`'
  — 120 chars, no line break; `role` `admin` | `member`, a member when left
  out, anything else 400; `name` kept as the host's name for the person,
  "People" below) → `{ ticket, expiresAt }`,
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
  **Who may frame it** (auth.ts "The host that frames it"). Same-site is
  not the host's alone: hosted boxes all live under one domain
  (`<box>.stakwork.ai`), so another customer's box is same-site too, and
  the cookie reaches a frame it makes. So a strut with a key tells the
  BROWSER who may frame its UI: every page of it is served with
  `Content-Security-Policy: frame-ancestors 'self' <host>` (and
  `cache-control: no-store`), `<host>` the one origin strut has evidence
  for — the `embed_origin` beside a LIVE ticket on the page's address
  (`trustedEmbedOrigin`: signed here, in its minute, not yet traded; a
  ticket is what only a host holding the key can make), else the one the
  browser's session keeps: the page trades the ticket with that origin
  (`POST /auth/session { ticket, embed_origin }`, `bareOrigin`: an http(s)
  origin and nothing more), and the session carries it signed
  (`Session.embedOrigin`, claim `embed`), so a reload — the cookie, no
  ticket — is framed by the same host. With neither, `'self'` alone: a
  page that only NAMES a host (a neighbour framing strut, a crafted link)
  is refused by the browser, signed in or not. The same origin is written
  into the page as `<meta name="strut-embed-origin">` (empty for none),
  the only origin the page posts its location to and takes `embed_page`
  on, so `strut/page` (specs/API.md §14.3) is a host's own page and an app
  can take it as it is. Not restricted: a visitor's page of a public app
  (`?app=…&solo=1&public=1`, a served box's pages, a custom domain's),
  which an index's store frames from another server and which shows
  nothing of a signed-in person's (it still gets the meta). A strut with
  no key (dev mode, or behind a host's gate — mcp's `/lab` for Hive,
  where strut has no sessions and no tickets) sends no header and no meta,
  as before: the gate in front decides who loads the page, location
  reports go to `?embed_origin` as given, and no page gets `strut/page`
  from a framing host. A session made before this carries no host, so a
  host's frame reloaded on its own (no new ticket) is refused until the
  host's page is reloaded; one origin per session, so a person framed by
  two hosts of one strut keeps the last.
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
  /apps/:name/channel-ticket`, `GET /artifacts/:runId[/…]`, `GET
  /jobs/:id/files[/…]` and `GET /jobs/:id/urls` (a job's hold address,
  which the side panel frames). Everything else is 403, reads and a host's later
  routes included; `createStrut.test.ts` ("a member's session") sweeps
  them and counts the allowed. The UI asks `GET /auth/session` before it
  renders (`api.pageSession`) and picks the page (`web/src/page.ts`
  `pickPage`): a member gets their apps (`MemberApps.tsx`, Jamie first,
  each `?app=<name>&solo=1`), never the shell. Not a sandbox: a member
  reaches the builder through Jamie. But installing a package is an
  ADMIN's act whatever the door: `package/install` is `approver: "admin"`
  (see "Proposals"), so a member's Jamie neither proposes nor accepts one.
  Reading CONVERSATIONS: a person reads their own and the shared ones; an
  ADMIN reads every one (ruled 2026-11-19, plans/jamie-app.md §2.3):
  `everyone` on `GET /conversations`, `/conversations/item` and `POST
  /conversations/fork` for full scope alone (403 to a person token, a host,
  a peer), and on `conversation/list|get|fork` only from strut's own page
  shown to an admin, in its own call (`adminPageCall`; refused to a
  member's page, a model-written one, a workflow, an agent's tool, a run
  the page launched and a step run from inside one, `ctx.nested`). Reading is not a turn: no viewer added, nobody's
  seen moved, and a turn in another person's conversation stays
  `conversation_not_yours:`. Jamie tells every viewer that admins can read
  conversations.
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
  src/visitors.ts); else dropped, and the sign-in holds. A sign-in may also
  carry `name` (strut's UI sends the alias Peel's `sign_in` answers), kept
  as the visitor's own ("People" below). A visitor is
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
- **People — a name per person** (plans/people-and-hosts.md §1;
  specs/API.md §13.3; `src/people.ts`). One row per actor in
  `<dataDir>/people.db` (`node:sqlite`, imported on the first name; a read
  opens no file that is not there; `:memory:` where the run store is in
  memory — no separate memory class): `people (actor, name, name_by, name_at)`.
  Written by a host's ticket (`name_by = 'host'`) and a visitor's own
  sign-in (`'self'`), through `setName` alone, which `cleanName`s it (one
  line, at most 80 characters, trimmed) and never lets a `self` name
  replace a `host` one (one upsert's `WHERE`); within a kind the newest
  wins. Read through `names(actors)` (`nameOf` for one), at most 200 at
  a time: `GET /people` (full scope; a peer is 403 in the route) and the
  `people/names` step, which reads `services.people` — `peopleReader`,
  names and no write, on the shared bag; `ownName(people, actor)` on a
  signed-in visitor's `/public/mcp` bag (their own name alone), and nothing
  on an anonymous one's (each actor answers with none). `signedInRefusal`
  lets a signed-in visitor call it where the app grants it. A name is
  shown, never checked: nothing authorizes by it, and no other answer
  carries one (runs, tasks and conversations keep the actor). With no name
  of their own, a person's name is the one on an account linked to them
  (the newest link's; "Host keys" below).
- **Host keys and linked accounts** (plans/jamie-in-tribes.md §5.1, §5.2;
  plans/people-and-hosts.md §2; specs/API.md §13.4). A HOST is a program
  that brings people to strut — the Sphinx daemon on a box — and should not
  hold the deployment key: it reads messages from strangers and holds money.
  `STRUT_HOST_KEYS="sphinx:<token>"` (auth.ts "Host keys", `hostKeys` /
  `hostOf`; Bearer only, read per request, a bad entry skipped with one
  warning) gives each host a token; a request carrying one is scope `host`
  (`scopeFromKey`, and createStrut's `resolveScope` before a host hook, as a
  member's session is). The gate passes it `HOST_ROUTES` alone — `POST
  /workflows/:name/run`, `GET /conversations/item`, `POST
  /proposals/:id/decide`, `PUT /hosts/me`, `GET /hosts/places` and `DELETE
  /hosts/places/:key` ("Linked places" below), and `POST /mcp` (below) —
  and 403s every other route, reads included
  (`createStrut.test.ts` "a host key" sweeps them). The gate also reads its `x-strut-account: <kind>:<key>`
  (the host's own kind, else 400) and asks `people.actorOf` once
  (`hostCalls`); `resolveActor` answers that person only when the account
  is LINKED, never an `x-strut-actor`. A launch or a decision needs a linked
  person (`hostPerson`: 400 with no account, `403 not_linked:` for one
  nobody linked). A launch is a turn of a conversation workflow on the
  host's own `host/<name>/…` session, as published (`hostLaunchRefusal`):
  `run.start` says `origin: "host"` and `host`, the runner opens its agents'
  sessions under `host/<name>/` (`bindHost`), a resume keeps both, and
  strut wakes it (`announcesWake`; wake.ts's `relay` is peers' and apps'
  alone). **Never an admin's** (ruling 8): `personIsAdmin` answers false for
  `origin: "host"` and so for the jobs and wakes it starts, and
  `decideProposal` takes `host` like a person token — only the proposal's
  own person decides, `admin` false; the decide route first holds the
  proposal to a conversation under the host's namespace. A host's
  conversation is continued by it alone: `continuesFor` and the app door's
  job-turn check refuse `host/…` with `conversation_hosted:`, and the
  conversation index gives such an id no owner (an actor named `host` owns
  nothing). ACCOUNTS live in `people.db`'s `accounts (kind, key, actor,
  address, name, host, at)`, one person per account (a link replaces
  another's: whoever holds the key says whose it is). `actorOf(account)`:
  the linked person; else, for a `sphinx` key, `secp:<the key without its
  first byte>` marked unlinked (its own person, at a visitor's level — a
  host's launch still refuses it); else nobody. A host links nothing: a
  person links their Sphinx account through Peel ("Peel links to a box"
  below).
- **Peel links to a box** (plans/people-and-hosts.md §2.1, ruling 9;
  specs/API.md §13.6). The person, signed in here, opens Connect in the
  Jamie app, whose `account/link` mints a LINK CHALLENGE naming them
  (auth.ts "Link challenges": `strut-link.<claims>.<hmac>`, `{ host, actor,
  name?, nonce, exp }`, ten minutes, good once — its nonce remembered in
  memory until `exp`, as a visitor's challenge's). Connect shows it as a QR
  and `peel://strut/link?url=<strut's base>&challenge=<…>`. Peel signs the
  challenge's bytes with its Sphinx key as a Lightning signed message (the
  `ln-message` verifier `POST /visitors/session` uses) and posts it: `POST
  /people/link { challenge, key, sig, name?, address? }` checks the HMAC,
  `host` (the host name in strut's address as the request reached it,
  `STRUT_PUBLIC_URL` first), expiry and the signature, spends the challenge
  only then (one someone only saw cannot be burned), links `sphinx:<key>`
  to the challenge's actor (`409 linked_elsewhere:` when the key is another
  person's; a challenge naming nobody is refused) and answers `{ actor,
  name?, token, exp }`. The TOKEN is a person token (scope `peer:person`,
  what any person token may do) whose claims also name the account
  (`PersonToken.account`), for `LINKED_TOKEN_DAYS` (7). **The gate checks
  it on every request:** a person token that names an account holds only
  while that account is linked to its actor (`people.linkOf`), so
  `account/unlink` ends it at once (401). Peel renews by signing again:
  `GET /people/challenge` (`{ host, nonce }`, a minute) then `POST
  /people/token { challenge, key, sig }` — a linked key gets a new token,
  an unlinked one `403 not_linked:`. **These three routes are open** (the
  exception to "no public endpoints", beside `/visitors/*`): the challenge
  and the signature are the credential, a link challenge names a person
  only their own signed-in page could mint, and Peel shows the box and the
  name before it signs. They are budgeted per address as the visitors'
  routes are (`overVisitorBudget`), and a body is at most 8 KB
  (`bodyLimit`, 413). The `account/*` steps (`src/steps/lib/account/`) run
  only as a first-party page's own call for its viewer (`requireAccounts`,
  as `secret/add`): a challenge is worth the person it names, and in a
  tribe that shows no senders every turn runs as its linker, so no agent
  may mint one. `ctx.services.accounts` (`accountsCapability`) is their
  door; the app door hands each request one bound to strut's address as
  that request reached it (createStrut `requestServices`), and the shared
  bag's has `STRUT_PUBLIC_URL` alone (none: `account/link` fails).
- **Linked places** (plans/jamie-in-tribes.md §4, §5.4; specs/API.md
  §13.4, §13.6; `src/people.ts`). A PLACE is where a person asks a host to
  answer, as them: a tribe, to the Sphinx daemon. `people.db`'s `places
  (host, key, link, name, account, at)`, one linker per `(host, key)`, the
  linker being the account their Peel token names (`<kind>:<key>`, the host's
  own kind). Strut keeps the list and knows nothing of tribes; the host
  joins and leaves to match it. A person's routes take the token Peel holds
  for a box (`placeLinker`: a person token NAMING an account, which the
  gate already holds to its link; any other credential is 403): `GET
  /people/places` (the host ready for that kind, and their places), `POST
  /people/places` (another person's place is `409 place_linked:`, a host
  with no key or that hasn't said who it is `404 no_host:`), `DELETE
  /people/places/:host/:key` (their own). The gate lets a person token POST
  and DELETE these, past a peer's routes. A host's routes: `PUT /hosts/me {
  account, hook }` (`hosts (name, account, hook, at)`: its own account,
  handed to Peel to approve its join of a private tribe, and an http(s)
  hook), `GET /hosts/places` (every linker's, with `linkerName`, the
  linker's name as strut shows it), `DELETE /hosts/places/:key`. Each change
  to a host's places (a link that moves, a removal, an account's unlink,
  which takes its places with it) calls `createPeople`'s `onPlaces`, which
  POSTs `{ event: "places" }` to the hook as a callback is posted
  (`postCallback`: retried briefly, then dropped). The nudge names nothing:
  the host reads its whole list, so a lost or repeated one changes nothing.
  Strut checks no tribe's owner: a turn as the linker has the linker's
  access alone, never an admin's.
- **Posts in a place** (plans/place-posts.md; specs/API.md §13.4, "Posts
  in a place"; `src/people.ts` `placesCapability`, `src/steps/lib/place/`).
  A WORKFLOW posts in a linked place with `place/post { host, key, text,
  reply?, id? }`, over `ctx.services.places` (on the shared bag). The run's
  person (`ctx.principal`: who launched it, else the workflow's owner, as
  `runsAs` names it for an automation) must hold a linked account of the
  host's kind — anyone linked to the box, in any place linked there, not
  only its linker (ruling 1); else `not_linked:`. The place must be one of
  the host's here (`no_place:`), the host ready (`no_host:`). Strut then
  POSTs `{ event: "post", id, key, text, reply?, run, workflow }` to the
  host's hook and returns its answer, `{ id, sats?, again? }`; it reads
  `host` and `key` for these checks alone and knows nothing of the medium.
  The id is 32 hex, a hash of the run's workflow and the `id` given, or of
  the run and the step's path, and the host posts one id once, so the
  capability's own tries (no answer, a `429`, a `5xx` but `502`: three,
  then `host_unreachable:`), a workflow's `retry:` and a resume post once.
  A host's refusal fails at once with its code (`not_joined:`,
  `bad_reply:`, `send_failed:` for a `502`); a `2xx` with no id is a host
  from before posts (`host_cannot_post:`). Errors name the hook's origin,
  never its URL, which carries the host's token. ONLY A WORKFLOW'S STEP
  posts (ruling 2): `place/post` refuses unless `workflowStep(ctx)`
  (run-step.ts) — never an agent's tool call (`ctx.agentTool`), a
  single-step run (`step_run`, `meta/run-step`, `POST /steps/:type/run`)
  or a proposal's apply (`ctx.proposal`): `workflow_only:`. A workflow an
  agent wrote is a workflow, and posts; a host that wants otherwise leaves
  `place/*` out of `builder.reach`. `place/list` (a read) names the places
  of each host whose kind of account the person holds, `{ host, key,
  name? }`, never a link or a linker. A package's step holds both for its
  run's principal (`heldToItsRun`). No cap: each post pays the place's
  price from the treasury (ruling 3).
- **A host calls an app's tools** (plans/people-and-hosts.md §3, §9;
  docs/apps.md has the door). On `POST /mcp` a host key gets `step_run`
  alone, and only the steps an app's `hosts:` lists for that key's name —
  a field a model's publish may never write (`refusedGrants`). It runs as
  the account `x-strut-account` names (none: 400; an account with no
  person, such as an unlinked non-Sphinx one: `403 not_linked`), and a
  Sphinx key nobody linked — its own `secp:` actor — only where the app's
  entry says `unlinked: true`. What it reaches is the shared bag: no admin
  door (`adminBag` is never built for it, `AppRef.admin` and `firstParty`
  are never set), no worker's calls (`workerServices` is not given), and
  nothing that pays or sends — the payer is on no bag, and the `sphinx`
  capability (plans/people-and-hosts.md §4) is not on the shared one. So a stolen host key can
  put false records into what an app keeps; it cannot send, read a secret
  or reach the task store. The same paid-or-shell and sealed refusals as a
  page's hold. **`x-strut-account-name`** (percent-encoded, beside
  `x-strut-account`, on any host route): the name the speaker goes by
  there, as they wrote it — kept on the account when it is linked (read
  beneath the person's own name), else as the key's own actor's name, by
  `self`, never over a host's (`people.setAccountName`). Malformed, or with
  no account, it is a 400.
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
  through `job/*` is a local run with local names, and an agent it grants
  `bash` is a shell for the peer. A run it starts through the authoring
  surface (meta/run-step's, meta/run-workflow's) stays the peer's: the
  runner hands it the caller's origin (`bindAuthoring`, `RunCaller`), so
  its sessions open under `peer/` as the caller's own tool call's do. The
  same holds for a host's, a public and an app's run: a nested run gets
  what its caller's tool call gets, never more, and with an app it is
  never a page's own call (`ctx.nested`, run-step.ts `pageCall`).
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
  workflow's YAML says about peers). It may also POST `/voice/calls` and
  `/voice/calls/ticket`, and GET `/voice/calls`
  (`src/voice.ts`, plans/private-voice.md §4.1): the body forwarded as it
  came to the voice service beside strut, as its actor, the answer back as
  it came, nothing of either logged or kept (the deployment key with
  `x-strut-actor` may too; the plain peer key may not, a GET included). Its `job` is still
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
  secret"). A job (`builder`, `job`) or the assistant itself (`orchestrator`,
  where the app's context line says it has the box) names a secret it needs
  in its reply's `ask.secret`; strut's own app shows a password box under the
  question and stores the value with `secret/add` — a name with no value in
  the store or the environment, never one that has one — then sends the job,
  or the conversation, `[secret] NAME stored`. Members and admins alike; nobody needs the
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

- **A person's secret that refreshes itself** (`src/actor-secrets.ts`;
  stadeum plans/software.md §5 item 8, plans/gmail.md §2). An OAuth access
  token, Google's, lasts about an hour. The connect seam writes it with
  `PUT /actors/:actor/secrets/:name { value, expires_in, refresh_token,
  provider }` (specs/API.md §8.2). The three extras sit in a second entry
  of the same file, `AR_<hex(actor)>_<NAME>`, which `list` does not show
  and no reader is handed. When a read finds the value within five minutes
  of its end, the store first calls `POST
  ${CONNECT_URL}/api/connect/${provider}/refresh` with `CONNECT_TOKEN`,
  keeps the new pair, and hands over the new value (`connectRefresher`).
  - **Every reader at once.** The refresh is in the actor store's `get`,
    which every read of a person's value goes through: a step's
    `secrets.get`, a package step's `secrets.own`, `secretsEnv`, git by
    host. None names a provider or sees a refresh token.
  - **One at a time.** Writes and refreshes of one (actor, name) take turns,
    and readers that come during a refresh wait for its answer. A provider
    that rotates refresh tokens (GitLab, Microsoft) invalidates the old
    pair, so two runs spending one would cost the person their connection.
    The turn is per process, which is all strut runs on one data dir.
  - **Refused** (`400`): the store deletes the secret and logs the
    provider's error code, never a token. The reader finds it missing and
    says to connect again.
  - **Not refreshed this time** (`401`, `404`, a `5xx`, no answer in 15 s):
    the secret stays, and that read throws `secret_refresh:`. It never
    falls back to the deployment's value of the same name.
  - **Off** without `CONNECT_URL` and `CONNECT_TOKEN`: a value is handed
    over as it is. `CONNECT_TOKEN` is hidden from steps
    (`hiddenFromSteps`, env.ts), like `STRUT_SECRET_KEY`.
  - A plain `{ value }`, from the route, `secrets.own.set` or
    `secret/add`, drops any refresh kept before.

- **A package's steps manage the secrets it provides** (`provides.secrets`
  in `strut.yaml`; src/packages/fence.ts, `own` / `deployment` in
  src/capabilities.ts). Reads stay one merged lookup for every step. Beside
  it a package's step gets two scopes, each `{ get, set, delete }` and each
  held to the names its package provides (`secret_fenced:` for any other):
  `secrets.own`, the run's principal's own actor secrets apart from the
  deployment's — wherever the run has a principal, so a page's call for its
  viewer, a workflow run as its person, the job agent's tool call — and
  `secrets.deployment`, the deployment's store (a read falls back to the
  environment, as `get` does), only on a call from the package's own
  `admin: true` app whose connection holds full scope. The app door decides
  that (`packageAdminOf`, src/apps/tools.ts) from what it already knows — the
  connection's scope (`AppRef.admin`) and the app version's `upstream` — and
  binds that ONE call's `secrets` (`adminSecrets`); a run the page launches
  takes the shared bag, so it has none. The writers hang off strut's own
  capability in a module-private map (`secretScopesOf`), never on an object
  a step reads, and are not exported from strut's index: a step of strut's
  own or the workspace's has no scope, and a package's step has no
  `secretBlanks` either, so a member's call never sets a deployment secret
  whatever the step does. Nor does its `secrets` have `forPrincipal`: a
  package's step works for the run's person alone and never re-binds to
  read another person's value or manage their `own` (a nested or launched
  run is bound to its own person by the runner). Names and values follow the routes' rules
  (`secret_name:`, hidden names included; `secret_empty:`). Strut never logs
  or returns a value; a step that takes one lists the field in `redact`.
  Uninstalling the package leaves the values. Not isolation — a step has
  `shell` — but the door it is given says what it may do.

- **Work nobody launched runs as a person** (stadeum plans/software.md §5,
  item 15; the owner's rule of 2026-11-20: there is no box token, every
  token is a person's). `runsAs` (src/workspace.ts) names that person for
  every such run: the OWNER of the workflow it runs, with their secrets and
  on their bill, and nobody else — whoever brought it in as a person (their
  install, their subscription, their publish) or whom an admin gave it to.
  A package never names a person: no manifest key, step or request does,
  and an admin changes who with the owner routes that exist. With no owner
  a package's work launches nothing and says what to do (docs/automations.md).
  A subscription a person makes is theirs (`actor`, the `PUT`'s; never a
  field of the body): it installs as them, and its git branch is read with
  their OWN value of the secret that serves its host alone — a deployment value of the same name is
  never sent for a person (src/packages/subscriptions.ts `own`). One nobody
  made reads the deployment's value, as before, and its work has no owner.
  A package's STEP starts work only as its own run's person
  (`heldToItsRun`, src/packages/fence.ts): `runs.launch` takes the run's own
  caller, `authoring.runWorkflow` / `resumeRun` / `controlRun`,
  `jobs.launch` and `proposals.propose` take the run's actor and principal
  whatever the step passed, a request to a peer carries the run's principal
  as `x-strut-actor` (or none), and in a run for nobody a launch is
  refused (`run_as_fenced:`), since it would run as the launched
  workflow's owner. Its bag has no `proposals.decide` (a person decides,
  and the apply runs as the proposer), no `automations` (the scheduler's
  API: `fire` would run any workflow as its owner) and no `trials`. Each
  capability it holds is a FRESH object (`held`): the methods it does not hold
  forward to the original by closure, and the original is on no prototype and
  in no property a step reaches (a test walks the bag). Strut's
  own steps pass the run's person anyway; what is still open: a run that
  acts for nobody which launches another workflow (a `run/launch` in YAML,
  an app page's call with no viewer) runs it as that workflow's owner, the
  principal rule's fallback (`principalFor`).

- **Git credentials by host** (src/git-hosts.ts; stadeum plans/software.md
  §5, item 9). Which secret holds the token for a repository is the box's
  map, by HOST: strut's own entry, `github.com` → `GITHUB_TOKEN` (what its
  git steps and `git+` sources always read), and each installed package's
  `provides.git: [{ host, secret }]` (a package that still holds its own
  items, as `job`'s grants are read; made again after every package write,
  `syncGitHosts` in createStrut). One host, one secret: an install that
  would serve a host with another (github.com's included) is
  `package_conflict:`; the same one again is welcome. The lookup is the
  URL's — `https://<host>/…`, or `http://` to this machine
  (`localhost`, `127.0.0.1`, `[::1]`) — and its token is the run's value of
  that secret, read as `get` reads it: the person's own, then the
  deployment's (`secrets.git(url)`, on every capability strut builds and on
  a host's once createStrut wraps it). A host no secret serves, a `file:`
  repository and plain http to another machine get none. Every git caller
  uses it: `git/checkout`, `git/push`, `git/remote-head`, `git+` installs,
  subscriptions (a person's: their OWN value of that secret alone), serve
  mode, `STRUT_PACKAGES` and the repo door. Nobody names the secret any
  more: `tokenSecret` is gone (2026-11-20) — a door refuses it, and an old
  one in `STRUT_PACKAGES` or `STRUT_SERVE_TOKEN_SECRET` is left unread so a
  box still boots. Before it, every one of them read `tokenSecret`
  (GITHUB_TOKEN unless named) whatever the URL, and git's helper answered
  any host: a workflow, an agent's tool call or a package could send the
  person's GitHub token — or any secret, by naming it — to a host of its
  choosing. Git is held to it too: the inline credential helper
  (src/steps/lib/git/_shared.ts) answers only when git asks for the
  token's own host (`STRUT_GIT_HOST`), so a redirect elsewhere gets
  nothing. And git gets no credential but the run's, token or not
  (`credentialArgs`, `gitEnv`): the helper list is reset on every command
  (a machine's `osxkeychain`, as Xcode's system gitconfig sets it, a
  `store`, or one a repository's config names), no askpass program
  (`GIT_ASKPASS=""`), no system config and a `HOME` with nothing in it
  (`/dev/null`: no `~/.gitconfig`, `~/.git-credentials` or `~/.netrc`,
  which git's curl reads on its own), and no ssh
  (`protocol.ssh.allow=never`: a URL rewrite would log in with the
  machine's key). Before, a run with no token for a host fell through to
  all of these and acted as the machine's user; now a private repository
  with no token fails. ONE exception, a person's own machine: with
  `STRUT_GIT_LOCAL=1` (`createStrut({ git: { local: true } })`; off by
  default, and the desktop launcher, `scripts/desktop.js`, which Peel
  runs, turns it on), a run with no token for the repository's host keeps
  that machine's git as its person set it up — its helpers, config,
  `~/.netrc`, askpass and ssh, as before this rule (`machine` in
  `credentialArgs` / `gitEnv`, from `gitLocalOf` on strut's own capability,
  which no step can set). There git may also stop on the machine's own
  prompts, a keychain dialog on a Mac, and the step waits for its person
  until its timeout, as `git` in a terminal would; with nothing saved it
  fails at once. With a token the token wins there too, for its host
  alone, and nothing of the machine's goes beside it. Never inferred
  from the operating system or a hostname: a server never uses its
  machine's credentials unless someone turned this on. `git/push` asks GitHub who the token is (`GET /user`, the
  commit's author) only with GitHub's own token — the one
  `https://github.com` gets — and a token for another host is never sent
  there. A PACKAGE's step holds `secrets.git` only when its package says
  `requires.git: true`, which the store page and `GET /packages` show; it
  then reads the run's token for any host the box serves, and still reads
  by name only what it declares. Without it the step never sees a token,
  yet strut's git steps it calls with its own ctx use the run's: the
  fence keeps a module-private reader on its view (`keepGitTokens`,
  `gitTokens` in src/capabilities.ts, not exported from strut's index),
  beside the run's own `shell` and `http` (`gitVia`), and those steps send
  the token to its host alone, through those alone — a shell or http the
  step puts in the ctx it calls them with never carries it.

- **A package's grant of strut's steps** (stadeum plans/software.md §5,
  item 16). A package's `strut.yaml` `job:` may name strut's own steps for
  the `job` workflow's agent, one by one (`job: { tools: [repositories,
  git/push] }`: a name the package does not ship is strut's; a glob is
  over its own steps alone). The host's own grant (`createStrut({ job:
  { tools } })`, `STRUT_HOST_CONFIG`) is held to nothing: any type or
  glob, an unknown one skipped at run time. Strut keeps a step from an
  agent at the CALL: one that is a page's alone (`ctx.app`: the admin
  doors, `proposal/decide`), one that refuses `ctx.agentTool`
  (`task/reply`) and one that parks (`human`) refuse an agent's call
  whoever granted it. A package's grant is narrower, held to
  `strutGrantProblem` (src/job-seed.ts) at the install (`bad_package:
  strut.yaml: job.tools: <why>`) and again at every seed against the
  registry in force: strut's own step (core or lib — never a workspace's or
  another package's), not sealed (src/sealed.ts: the meta surface and the
  graders — which of those the agent holds is strut's own template's to
  say), its config naming no secret (`configSecretField`: the model would
  choose which secret it reads — `exec`, `agent`, `browser/open`,
  `http/verify`), and declaring its `effect` (what `GET /steps` lists for a
  host's connector list and `approve:` defaults, and what the store shows
  the admin). `git/push` (`effect: write`) and `github/create-pr` pass.
  The admin sees it before installing: the store's Tools section lists
  strut's steps as "strut's step" with acts/reads, `package/install`'s card
  says "strut's git/push (acts)", a search hit counts them. A granted
  step runs as the job's PERSON, like every tool the agent calls: with the
  run's ctx, its `secrets` bound to the run's principal. `git/push` takes
  the token for origin's host (`secrets.git`: that person's own value of
  the secret that serves the host, then the deployment's, never another
  person's) and sends it to that host alone; `github/create-pr` reads
  `GITHUB_TOKEN` the same way. A grant only adds: a tool is granted once
  whoever names it, an uninstall keeps another package's grant of it, and
  it asks first when any grant says so. Why the job agent had
  `git/checkout` and not `git/push`: checkout is a READ as the person (a
  private repository found mid-turn, 104fd643); a push is a WRITE as the
  person, and the line was plans/code-change.md §2's — the agent's bash
  structurally cannot push (no credential in the checkout), and landing is
  deterministic after the person approved the diff, no model between the
  approval and the pull request. A package's grant crosses it on the
  admin's install, shown as such: with `approve: [git/push]` each push is
  the person's yes, the gated `git/push` plans/proposals.md foresaw;
  without it the pull request it opens is the person's review (the
  `Code Change` page's small change). `git/push` holds two lines itself,
  for every caller (a workflow's author wired `path` and `branch`; a
  model types them, and an accepted proposal carries what it typed):
  it never pushes origin's DEFAULT branch, asked of the remote at the
  push (`ls-remote --symref origin HEAD`, as `git/remote-head` asks, with
  the same token) — `push_rejected: <branch> is origin's default branch`
  — and it pushes only a working copy `git/checkout` made for this run or
  its job: an absolute `path` whose top level, every symlink resolved,
  is under the run's own directory (an accepted proposal's: the run that
  proposed it) or the job's, `<dataDir>/jobs/<job>`, and whose repository
  is one of checkout's caches, `<dataDir>/repos/` (`notOwnWorkingCopy`).
  Another job's checkout, a path out through `..` or a link, a repository
  made by hand in the job's directory, a relative path (which resolved
  against the server's own working directory) and any other repository on
  the disk are refused before git touches it. It cannot force: the
  refspec is `HEAD:refs/heads/<branch>`, so a push that is not a
  fast-forward is `push_rejected:`. Not isolation: the agent's bash
  reaches the disk; these hold what a caller hands the step.

- **A person's SSH key is used, never held** (src/ssh-agent.ts,
  `ssh/keygen`). A job someone lets into a server logs in with ONE key per
  person: `ssh/keygen` makes it in code and stores the private half as the
  run principal's actor secret `SSH_KEY` (`secretBlanks.fill` with an
  actor: that person's blank, never overwritten; the server's blank when
  the run has no principal), answering with the public half alone. The
  agent step's `sshKeys` serves it to `bash` through an SSH agent in
  strut's own process (`SSH_AUTH_SOCK`), so the key is in no file, no
  child's environment, no prompt and no event. What is left: while a run
  lasts, its shell (and, with no sandbox between jobs, another job's shell
  on the same box) can SIGN with it, so a prompt-injected job can reach
  the person's servers; it can never copy the key out. Revoking is taking
  the public half out of `authorized_keys`, or deleting the actor secret.

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
  the receive side, which cannot pay. The run archive's settings
  (`STRUT_ARCHIVE_S3_*`: a bucket and a key pair that reads every archived
  run log) are hidden by the same prefix list; only the server's object
  store (`src/object-store.ts`) uses them, handed to the S3 client directly
  and never put in `process.env`, so no child inherits them.

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
  `{NAME}` header templates, or one named by a template; a `git/*` step
  names none, reading the run's token for its repository's host as a
  `github/*` step reads GITHUB_TOKEN, so `tools` decides it); `meta/run-step`
  refuses a step outside it. (Apart from any reach, `meta/run-step` also
  refuses a step the calling agent asks a person before running, its
  `approve`: docs/agent-step.md, plans/one-job-agent.md §6. A job holds
  both since that plan.) The same rule (`stepProblems`) holds at RUN
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

the pieces of createStrut's one gate in front of EVERY route, reads included — carriesApiKey (Bearer or `?key=`) + requireApiKey (the per-route twin) + warnIfUnconfigured (STRUT_API_KEY shared secret) + the PEER KEY (STRUT_PEER_KEY: carriesPeerKey, scopeFromKey — the default `resolveScope`; a `peer` request reads, launches a `peer: true` workflow, controls a run a peer launched, and the gate 403s the rest) + the PERSON TOKEN (personToken / verifyPersonToken / personOf: the peer key attenuated to one actor, `strut-person.<claims>.<hmac>` signed like a session, Bearer only, minted by `POST /peers/tokens` — scope `peer:person`, `isPeerScope`: a peer whose actor is its credential's own, which alone launches a `peer: person` workflow, opens its actor's own sessions and gets an app's `step_run` alone on `POST /mcp`; plans/chained-orchestrators.md §2, plans/apps.md §7.4) + actorFromHeader, the default `resolveActor` (x-strut-actor, honored only with the key; a person token's actor wins) + the FILE TOKEN (fileToken / fileScopeOf / carriesFileToken): the key attenuated to one run's or job's files, an HMAC the listing mints, what an artifact link carries as `?t=` so the key is never in a URL a served page can read. The app IDENTITY a served document carries: `appIdentity` (`app:<name>@<vN>.<token>`), read back by `appOfIdentity` → `ctx.app`. The INVITE TOKEN (`inviteToken` / `inviteOf`, plans/human-steps.md §5.8): `strut-invite.<claims>.<hmac>` naming a Sphinx invite's code and the worker app, what an invite link opens that app with — it gives the one worker who comes with it the app's invite-only task types, while the daemon still has the invite. The CHANNEL TICKET (`channelTicket` / `channelTicketOf`, plans/app-channels.md §2): `strut-channel.<claims>.<hmac>` naming the viewer, the app and its version for a minute, the one credential that opens `GET /channels` — a browser host's upgrade, which carries no header (unsigned, and taken at its word, with no secret to sign under) + the VISITOR's session (plans/app-repos.md §5): role `visitor`, scope `visitor`, in a cookie of its own (`strut_visitor`, so a visitor's sign-in never replaces the operator's console session on one origin) and accepted as `Authorization: Bearer <token>` or `x-strut-visitor` (a page framed by another site keeps the token, ruled 4) — `visitorOf`, `startVisitorSession`; and the visitor's CHALLENGE (`strut-visitor.<claims>.<hmac>`, `{ host, visitorKey, nonce, exp }`, a minute, good once: `visitorChallenge` / `redeemVisitorChallenge`). The LINK CHALLENGE (`linkChallenge` / `readLinkChallenge` / `redeemLinkChallenge`, plans/people-and-hosts.md §2.1): `strut-link.<claims>.<hmac>`, `{ host, actor?, name?, nonce, exp }`, what Peel signs to link its key (ten minutes, naming a person) or renew its token (a minute, naming nobody); the token it buys is a person token whose `account` claim the gate checks against the link on every request. `fullSession` — "is this session the key's equal" — is an ALLOWLIST (no role, or `admin`), so a member's, a visitor's or a role strut does not know opens nothing. The HOST KEYS (`hostKeys` / `hostOf`, `STRUT_HOST_KEYS`, plans/jamie-in-tribes.md §5.1): a program that brings people to strut, scope `host`

### `src/secret-store.ts`

SecretStore iface + FileSecretStore (AES-256-GCM, STRUT_SECRET_KEY; optional filename for a second file) + MemorySecretStore — backs ctx.services.secrets + /secrets endpoints

### `src/git-hosts.ts`

GIT CREDENTIALS BY HOST (stadeum plans/software.md §5, item 9): `STRUT_GIT_HOSTS` (strut's own `github.com` → `GITHUB_TOKEN`), `tokenHost(url)` (the host a URL's token would serve: https, or http to this machine; else none), `gitSecretOf(hosts)` (the lookup, URL → secret NAME), `boxGitHosts(packages)` (strut's own entry, then each package's `provides.git`), `gitHostProblems` (a host two holders serve with different secrets, or name different forge steps for: what an install refuses). The map reaches steps as `secrets.git(url)` (src/capabilities.ts `hideSecrets`); "Git credentials by host" above. An entry also names its host's FORGE STEPS (plans/package-seams.md §4): `repositories` and `pull_request`, full step types — strut's own entry `github.com` → `pull_request: github/create-pr` — read through `forgeStepsOf(hosts, host)` (the first holder's per field) by `git/repositories` and `git/pull-request` (docs/steps.md); the box's map itself is on the bag as `gitHosts.hosts()`, made again with the secrets' map after every package write

### `src/actor-secrets.ts`

per-ACTOR secrets (plans/code-change.md §3.2): ActorSecretStore over any SecretStore (`A_<hex(actor)>_<NAME>` keys; a third encrypted file, actor-secrets.json), behind PUT/DELETE /actors/:actor/secrets/:name + GET /actors/:actor/secrets. The runner binds a run's `secrets` to its principal (`SecretsCapability.forPrincipal`), so `secrets.get(NAME)` resolves the actor's value first — never in /secrets or list_secrets. A value pushed with `expires_in`, `refresh_token` and `provider` refreshes itself: `get` renews it through the connect seam (`connectRefresher`, `CONNECT_URL` + `CONNECT_TOKEN`) when it is within five minutes of its end, one refresh at a time per (actor, name); the refresh is kept under `AR_<hex(actor)>_<NAME>`, never listed or read

### `src/env.ts`

the ENV BOUNDARY: `bootEnv()` is the one way strut's own code reads the environment (env.test.ts fails on a `process.env[…]` read anywhere else under src/), and `scrubProcessEnv()` — called by the default server's entry (`startServer`: server.ts, desktop.js), never by createStrut — copies the env into that snapshot and empties `process.env` down to `KEEP_ENV` (the shell allowlist + what Node reads lazily + what Windows needs to spawn), so a step's `process.env.X`, or a child it spawns with `process.env`, finds nothing while `ctx.services.secrets` still resolves a key the deployment set in env. `STRUT_ENV_SCRUB=0` / `STRUT_ENV_KEEP`. A host that embeds strut calls it itself once its steps read through ctx.services

### `src/step-lint.ts`

the static check on a custom step's SOURCE — imports of child_process / fs / net / http (RISKY_MODULES), a `process.env` read, the global `fetch`, opening the graph itself (`openGraphBackend` and its siblings — the deployment's shared connection; a step that closed it took swarm38's graph down, 2026-10-28) — each with what to use instead. The builder's create_step / edit_step (+ meta/* twins) REFUSE on a finding (authoring.ts); `POST /steps` publishes and answers with `warnings`; the registry WARNS when it loads a workspace step from disk, whoever put it there (registry.ts `warnPastServices`, once per file version; static, so it holds under tsx, which loads a workspace `.ts` as CommonJS past any ESM resolve hook) — the place a later strut refuses to load it. `servicesPastVisitor`: the `ctx.services.<name>` a source reaches (dotted, `?.`, `["…"]`, destructured) that a VISITOR's call never carries — `VISITOR_SERVICES`, the keys of createStrut's `visitorBag` / `signedInBag` on `/public/mcp`, kept in step by hand — for an app build's warning on a granted custom step (docs/apps.md, apps.ts `pastVisitor`)

### `src/steps/lib/account/`

`account/link`, `account/links`, `account/unlink` (plans/people-and-hosts.md §2.1): the viewer's linked accounts and the link challenge that links one (`{ challenge, exp, link, qr }`: Peel's `peel://strut/link?url=&challenge=` link, and it as a QR), over `ctx.services.accounts` (src/people.ts `accountsCapability`). `_shared.ts`'s `requireAccounts`: only a FIRST-PARTY page's own call for its viewer (`RUN_STEP_FLOW`), never an agent's tool or another app's — the Jamie app's Connect panel

### `src/steps/lib/secret/`

secret/add { name, value } (plans/member-rights.md "Adding a secret"): a secret a PERSON types into strut's own app — a job's or the assistant's reply names it in `ask.secret` (`replyOf`, src/wake.ts, puts the name on the conversation's turn), Jamie's SecretBox stores it — FILLING A BLANK through `ctx.services.secretBlanks` (src/secret-store.ts `secretBlanks`, set by createStrut when strut owns the store): refused (`secret_set:`) when the name has a value in the store or the environment, so a member never replaces the team's model or GitHub key; never lists, reads, changes or deletes one. `fill(name, value, actor)` fills that ACTOR's blank instead (refused only when the actor has a value of their own; `secret_actor:` on a server with no actor store) — `ssh/keygen`'s door, never `secret/add`'s. Answers `{ name }` alone. Runs only as a first-party page's own call (a one-step run, for its viewer), never an agent's tool or a model-written page's; its `value` is `redact`ed from the run's events (`StepDef.redact`, runner.ts), so no log, sink or kept run holds it
