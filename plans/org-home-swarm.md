# Org home: an org's content on its own swarm

> **Update (2026-11-05): the home is a Stadeum box, and Hive goes away.**
> [stakwork/stadeum](https://github.com/stakwork/stadeum) wraps strut the
> way Hive does today: sign-in, members, the org's signing key and each
> person's delegation, the box's updates, backups and TLS. Hive is not part
> of it. Once the Jamie chat runs fully in strut (`jamie-app.md`), Hive is
> retired, not kept as a front. Until then it only has to keep working.
> §0 is that direction and what strut owes it. It replaces the
> hive.sphinx.chat front of §1 and §3.1–3.2, the mcp lab as the home's
> server code, and the sequencing of §6. §4's tribes and Jamie per home are
> not yet placed in Stadeum's order. The rest stands, with the changes
> marked where they are.
>
> **Status (2026-11-01): the direction agreed in one design conversation
> with the owner; the implementation and the order are open, for the
> team.** Rows in "Decided" marked **agreed** are the owner's, from that
> conversation; rows and sections marked *proposed* are mine and open.
> Nothing is built. Whether this ships all at once or as two plans (tribes
> and Jamie first, then the Hive UX) is the first open question (§6).
> Read against strut `main` @f7b3875, hive `origin/master` @933e83af1,
> sphinx `origin/master` @91466814 (sovereign tribes,
> [stakwork/sphinx#416](https://github.com/stakwork/sphinx/pull/416), and
> tribe sender identity,
> [stakwork/sphinx#419](https://github.com/stakwork/sphinx/pull/419), both
> merged) and sphinx-swarm `origin/master` @8d144fa6. Companions:
> `org-gateway.md` (one Bifrost per org, on its default swarm; this plan
> moves the keys behind it there too), `chained-orchestrators.md`
> (pairing, person tokens, rooms), `apps.md` (strut apps, §7 hosts),
> `federation.md` (peers). The tribes halves as built are sphinx's
> `docs/sovereign-tribes.md` and hive's `docs/plans/jamie-in-tribes.md`.

## Problem

Who can read an org's content today, besides the org:

| Content | Where it lives | Who else can read it |
|---|---|---|
| Group chat in a tribe | the tribe server, which decrypts every message to find mentions and re-signs it with the tribe key (sphinx `docs/sovereign-tribes.md` §1) | Stakwork's shared tribe server |
| What Jamie hears in a tribe | the Jamie daemon: ONE account in every linked tribe of every org, and with `DAEMON_LOG=on` everything said there | the central daemon's box, and Hive, its service (`DAEMON_SERVICE_URL`) |
| Jamie conversations, tribe ones included | Hive's Postgres, `SharedConversation.messages` (`prisma/schema.prisma`); strut on the swarm also keeps each orchestrator session | Hive |
| Canvas, initiatives | Hive's Postgres, `Canvas.data` and `Initiative` | Hive |
| Repo access | GitHub App user tokens and their refresh tokens in Hive's Postgres, pushed to each swarm's strut as the actor's `GITHUB_TOKEN` (`src/services/strut-actor-secret.ts`) | Hive |
| Spend authority | the org's macaroon signing key, custodial in Hive's Postgres (`src/services/bifrost/macaroon-org-keys.ts`, whose own comment plans to move it off the platform) | Hive |
| Realtime | Pusher (`PUSHER_*` in `env.example`) | Pusher |

The org already has a box of its own: its default swarm, the second-brain
stack (`sphinx-swarm/src/secondbrain.rs`), which runs its graph, its
Bifrost, and its strut inside mcp's lab (the `repo2graph` image,
`src/images/repo2graph.rs`). Everything in the table is about the org and
can live there. The long-term goal is a self-hosted swarm; a swarm
Stakwork runs, where Stakwork has root, is an accepted step on the way.

## Decided

| Question | Decision |
|---|---|
| Goal | **agreed.** An org's content lives on the org's own swarm, its **home**. Stakwork-hosted swarms, where Stakwork has root, are a step; self-hosted is the goal. |
| Central | **Superseded (2026-11-05):** a Stadeum box stands alone, with no runtime call to Hive, mcp or sphinx-swarm (Stadeum's rule 9). What, if anything, stays central (a directory for Peel's pairing, provisioning) is open, §0. *Was:* **agreed.** Only what must be central stays central. Realtime is not (rooms, or a service on the swarm, instead of Pusher). Bifrost keys are not: the Bifrost is the org's. The org's multi-swarm logic (which swarm is its default, its other swarms as peers) is not. What remains is §1, *proposed*. |
| GitHub | **agreed.** One GitHub App for everyone. No org admin ever creates an app; every step stays as smooth as today. *2026-11-05:* in Stadeum this is GitHub sign-in handing each person's token to strut as their `GITHUB_TOKEN` (its step 7, low priority). How a self-hosted box uses the one App is open (§1.1). |
| URL and UX | **Superseded (2026-11-05):** stadeum-ui is the shell, at the org's own host (a custom domain is Stadeum's step 6), and frames strut's own app host page signed in as the person. Hive is retired once the Jamie chat runs in strut. Canvas, initiatives and the Jamie chat still become strut apps. *Was:* **agreed.** hive.sphinx.chat stays the one URL and the UX stays mostly as it is; the org's pages are served into it as frames from the org's home. |
| Tribes | **agreed.** A tribe server and the Jamie daemon run on each org's home. |
| Tribe conversations | **agreed.** They appear in Hive, at every step. *2026-11-05:* until Hive goes; after, in the Jamie app (§4.3). |
| Home code | **Superseded (2026-11-05):** members, sign-in and key custody live in stadeum-ui, which reaches strut only through its HTTP API; strut runs from its own image, not inside mcp's lab (Stadeum's step 2). Strut still gains only generic seams (§0, §3.3). Where the Jamie daemon's service goes is open (§4.2). *Was:* **agreed.** Org-level server code on the home lives in mcp's lab host, beside `labAuth` and `/mint-token`. |
| Old data | **agreed.** An org's existing Hive data moves to its home, and Hive's copy is deleted (§5). |
| Where this lives | **agreed.** This file, one cross-repo plan. |
| Order | **Stadeum's (2026-11-05)**, §0. *Was:* **open** (§6): all at once, or two plans. |

## 0. The home is a Stadeum box (2026-11-05)

Stadeum (`stakwork/stadeum`, its `AGENTS.md`) is one compose stack on a
box in the org's own cloud: strut, Neo4j, the gateway (Bifrost + Redis),
stadeum-ui, an `ops` service for updates and backups, Caddy for TLS, and
a one-shot `bootstrap` that makes the org's signing key. Its rule: Stadeum
is the box, strut is the product. Stadeum owns only what strut must not:
who people are, the org's signing key and each person's delegation, and
the box itself. Everything a kind of team uses is a strut app or package.
It reaches strut only through strut's HTTP API, and it never draws an app.

Who owns each piece:

| Piece | Owner |
|---|---|
| Sign-in (Microsoft Entra ID, Google), members, invites, roles | stadeum-ui |
| The org's signing key, each person's virtual key and delegation, renewed every 6 hours | stadeum-ui (the Mothership code ported from Hive), pushed to strut as `PUT /llm/delegations/:actor` |
| A person's GitHub token | stadeum-ui's GitHub sign-in (its step 7), pushed as the person's `GITHUB_TOKEN` actor secret |
| The Jamie chat, canvas, initiatives, the graph | strut apps, framed by stadeum-ui from strut's `GET /apps`; `strut/jamie` first |
| Image updates, backups | `ops`, around strut's drain |
| TLS, a custom domain | Caddy |

What Stadeum needs from strut, in its order:

| Stadeum step | Strut | Status |
|---|---|---|
| 1. A per-person sign-in for strut's framed UI, the standalone twin of mcp's `/mint-token` | a strut PR (§3.2's question, answered for Stadeum: stadeum-ui hands the frame a short-lived credential for the person) | not started |
| 2. Strut's own image in place of repo2graph; a pinned stock Neo4j | the image (`ghcr.io/stakwork/strut`), `STRUT_NEO4J_TAG` | built, stakwork/strut#527 |
| 3. Updates: follow `strut:stable`, drain, restart, roll back | `PUT /drain`, `GET /drain` until `idle`; the `stable` channel (`promote-image.yml`) | built, stakwork/strut#527 |
| 4. Backups around the same drain | the drain | built |
| 5. Apps from strut's `GET /apps`, Jamie first | `strut/jamie` (`jamie-app.md` §5) | built, stakwork/strut#501, #528 |
| 7. GitHub tokens | actor secrets (`PUT /actors/:actor/secrets/GITHUB_TOKEN`) | built |
| 8. Calls | sphinx-voice beside strut (`deploy/voice`, `POST /voice/calls`) | built for one-to-one calls |

Two things this plan proposed that Stadeum replaces: hive.sphinx.chat as
the shell (§1.5, §3.1), and the sign-in statement a home exchanges for its
own token (§1.3): a Stadeum box signs people in itself. What is open:

- **Tribes and the Jamie daemon** (§4): not in Stadeum's order yet. The
  daemon's service (Hive's tribes routes today) needs a home: strut
  (a workflow or a few routes) or stadeum-ui. By Stadeum's rule 1, strut,
  unless it needs the org key.
- **The directory and Peel's pairing** (§1.2): how Peel finds a person's
  org boxes once Hive's device flow is gone.
- **Provisioning and payment** (§1.4): a box in the org's own cloud needs
  none of Stakwork's; a box Stakwork runs for an org still does.
- **The data in Hive** (§5): it moves before Hive is retired.
- **Pods**: a job that must run the app claims a pod from Hive's pool
  manager today. On a Stadeum org they come from a pod box of the org's
  own, beside the Stadeum box, where idle pods sleep: `pods.md`.

## The shape in one paragraph

*Superseded (2026-11-05) by §0; kept for the history of the idea.*

hive.sphinx.chat becomes a thin front. It signs people in, knows which org
lives at which host, relays the one GitHub App's callbacks, provisions and
bills, and draws the shell (sidebar, org switcher) around a frame. The
frame is the org's own strut page, served from the org's home, which hosts
the org's apps: the Jamie chat, the canvas, initiatives, the graph.
Everything the org says and makes is stored on the home and read from it
by the browser directly, so hive.sphinx.chat learns which org a person
opened and nothing of what is in it. The home also runs the org's tribe
server and its own Jamie, whose turns run on the strut beside it.

## 1. What stays central (proposed)

*2026-11-05: a Stadeum box signs people in and holds its own keys (§0);
§1.2 and §1.4 are still open, §1.3 and §1.5 are replaced.*

### 1.1 The GitHub App relay

Hive has two GitHub registrations: a sign-in OAuth app (`GITHUB_CLIENT_ID`,
`src/lib/auth/nextauth.ts`) and the GitHub App (`GITHUB_APP_SLUG`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `src/config/env.ts`).
Repo access uses the App's user tokens. *Corrected 2026-11-05:* this
App's user tokens do not expire. Hive has refresh code
(`refreshAndUpdateAccessTokens`, `src/lib/githubApp.ts`), but nothing
calls it. Hive holds no app private key and mints no
installation tokens.

An app has a fixed address: GitHub takes up to ten callback URLs per app,
with no wildcards, and one webhook URL. Per-org hostnames cannot each be
registered, so the one address stays, as a relay that stores nothing:

- **Callbacks** (install and authorize,
  `src/app/api/github/app/callback/route.ts`; sign-in). The `state` Hive
  already signs (HMAC under `NEXTAUTH_SECRET`, bound to the user,
  `src/lib/auth/github-app-state.ts`) carries the org's home host. The
  relay checks the host is in the directory (§1.2) and redirects the
  browser there with `code` and `state` as they came. The home exchanges
  the code.
- **The App's webhook** (`src/app/api/github/app/webhook/route.ts`:
  installation changes, `github_app_authorization` revoked). Forwarded to
  the home of the account it names.
- **Repo webhooks** need nothing: they are per-repo hooks whose URL Hive
  builds (`src/lib/url.ts`), so they point at the home directly.

**The client secret.** Whoever exchanges a code or refreshes a token needs
it. On swarms Stakwork runs, it sits on each home: Stakwork's app on
Stakwork's machines, so no new party holds it. A self-hosted home cannot
hold it; for those, the relay would do the exchange and the refresh on its
behalf, once the first self-hosted home exists.

### 1.2 The directory

GitHub org → its home's hostname, any hostname the org wants. Written when
the home is provisioned; read by the relay, by the front page ("your
orgs") and by Peel's pairing (§2). A small table, or DNS.

### 1.3 Sign-in

Single sign-on across orgs is what makes one URL smooth. The person signs
in once at hive.sphinx.chat, with GitHub (through the relay) or Sphinx.
hive.sphinx.chat then signs a short statement (this is GitHub user X,
Sphinx key Y) that each home trusts by hive.sphinx.chat's public key,
checks against its own members, and answers with a token of its own
(§3.2). Central holds no swarm's key. Today it holds every one: Hive signs
person tokens with each swarm's API key (`signPersonPeerToken`,
`src/services/strut-device-peers.ts`,
[stakwork/hive#5674](https://github.com/stakwork/hive/pull/5674)) and
calls each swarm with it.

### 1.4 Provisioning and payment

Creating swarms (sphinx-swarm's super, which also pushes the provider keys
into each swarm's `bifrost` and `repo2graph`,
`src/bin/super/service/child_swarm/get_llm_keys.rs`), pods (the pool
manager, `POOL_MANAGER_BASE_URL`), and charging the org. This is
Stakwork's infrastructure, not the org's content.

### 1.5 The shell

hive.sphinx.chat's own pages: sign-in, the org switcher, the sidebar,
notifications across orgs, and the frame (§3).

## 2. What moves to the home (proposed)

*2026-11-05: where the table says "the lab", read stadeum-ui for members,
GitHub tokens and spend authority (§0), and strut for the rest.*

| Piece | Today, in Hive | On the home |
|---|---|---|
| Members | `User`, `WorkspaceMember`, `SourceControlOrg` | the lab: who is in the org (from GitHub), and their Sphinx keys (Peel already reports one at pairing, `src/app/api/strut-devices/sphinx/route.ts`) |
| Jamie chat | `SharedConversation` rows; the turn launched on the default swarm's strut | a strut app over the orchestrator (`useAssistant`, `kit/src/hooks.ts`), its conversations on the home |
| Canvas, initiatives | `Canvas.data`, `Initiative` | strut apps, their data on the home (where exactly is open) |
| Graph | already the swarm's | a strut app (`strut/views`: `NodeGraph`, `RunGraph`) |
| GitHub tokens | Hive exchanges, stores and refreshes them, and pushes `GITHUB_TOKEN` per actor | the lab exchanges (from the relay's redirect), stores and refreshes; strut's actor secrets are unchanged |
| Spend authority | Hive: the org's macaroon key, users' keys, VKs on the org's Bifrost, delegations pushed to each strut | the lab, next to the Bifrost it already sits beside (`org-gateway.md`), fanning delegations out to the org's other swarms |
| The org's other swarms | Hive picks the org-default swarm (`src/services/strut-target.ts`, `POLICY`) and pushes peer records | the home is the default by definition and pushes peer records to the others (`src/peers.ts`) |
| Realtime | Pusher | strut rooms (`src/rooms.ts`) and live feeds (`src/live-feed.ts`) |
| Device pairing | Hive's device flow returns each org's `{ baseUrl, token }` ([stakwork/hive#5602](https://github.com/stakwork/hive/pull/5602)) | Peel signs in once, finds the person's orgs in the directory and pairs with each home directly; each home mints its own token |
| Tribes | Hive's tribes service (§4.2) | the lab |

## 3. Serving the UX into hive.sphinx.chat

### 3.1 The frame is the org's strut page

*2026-11-05: the same frame, with stadeum-ui as the page that frames it in
place of hive.sphinx.chat (§0). Stadeum's rule 2 settles the choice
below: it never draws an app.*

There are two ways to put an app on hive.sphinx.chat:

- **Hive's page hosts the app.** This is what Hive does for strut apps
  today, through its servers:
  `src/app/api/orgs/[githubLogin]/strut/apps/document/route.ts` fetches
  the document and `…/strut/apps/mcp/route.ts` relays every tool call,
  both with the swarm's API key. Every call and result passes through
  Hive. Moving the relay into the browser would need CORS on strut's
  `/mcp`, which has none today (only the artifact file route answers
  `access-control-allow-origin: *`, `src/createStrut.ts`), and Hive's own
  JavaScript would still read every result.
- **Hive's page frames the org's strut page**:
  `https://<home>/?app=jamie&solo=1`. Strut's own UI is then the app host
  (`web/src/app-host.ts`, `web/src/components/SoloApp.tsx`) and talks only
  to its own origin; the parent page cannot read a cross-origin frame.
  Both halves exist: the solo page is what Peel's web view opens, and Hive
  already frames strut's whole UI on `/org/[githubLogin]/strut`
  (`…/strut/embed-url/route.ts`). *Proposed: this one.*

### 3.2 Signing in to the frame

*2026-11-05: this is Stadeum's step 1, a strut PR not yet started (§0).*

Strut's browser session is an HttpOnly `SameSite=Lax` cookie
(`src/auth.ts`), which a browser never sends to a cross-site frame. So the
shell hands the frame a token for that org: the home's own, minted against
the sign-in statement (§1.3), passed by `postMessage`, never in the URL. A
person token (`peer:person`, `src/auth.ts`) already opens what the solo
page needs: reads, and `step_run` alone on `/mcp`. Whether a member of the
org gets a scope of its own (a member is not a peer) is open.

### 3.3 What a strut app cannot do yet

Generic strut seams, each an item of its own:

- ~~**Proposals in an app turn.**~~ Built for strut's own apps
  (`jamie-app.md` §3.1): a first-party page's turns keep their gated tools,
  and the viewer decides their own proposals (`proposal/decide`). A
  model-written app's turns still leave them out.
- **MCP servers.** A page's call carries no caller MCP servers, and an
  app turn leaves out registered MCP tools that need approval
  (`src/steps/core/agent.ts`). If the Jamie chat should reach the org's
  MCP servers (Hive's org settings keep a list,
  `_components/McpServersSettings.tsx`), that needs a way in.
- **Push into the frame.** A framed app holds no socket. It long-polls
  `job/updates` and `graph/changes`, at most a call a second
  (`src/live-feed.ts`). That is enough for chat and job cards, and thin
  for a canvas several people edit at once (presence, cursors). The host
  page could push into the frame over the MCP Apps bridge.
- **The frame ↔ shell contract.** Deep links, "open this job", unread
  counts for the shell's sidebar. `web/src/embed.ts` already posts deep
  links to the page that embeds strut.

Porting the canvas and initiatives is real work beyond these seams; the
kit already carries React Flow and d3.

## 4. Tribes and Jamie on the home

### 4.1 The tribe server

stakwork/sphinx#416 made a tribe server able to run away from a broker of
its own: tribe records signed by the tribe's key, `tribeV3` links that
carry the record, owner commands as onions (`TribeCmd = 36` /
`TribeRes = 37`) instead of plaintext JSON on the broker, and a mixer
registry for listed tribes. On the home:

- **sphinx-swarm.** The tribes image needs a linked broker today:
  `make_config` fails with `Tribes: No Broker` and takes that broker's
  `SEED` (`src/images/tribes.rs:62`, `:92`). A second-brain stack has no
  broker. The image gains an external broker, as the `bot` image in the
  same stack already has (`set_external_broker("broker.v2.sphinx.chat")`,
  `src/secondbrain.rs:176`), and a seed of its own. Every tribe key is a
  child of that seed, so it goes in the swarm's backups (today
  `backup_services` is boltwall and neo4j, `src/secondbrain.rs:51`). Not
  yet run anywhere: "a swarm with a tribe server behind an external
  broker" (`docs/sovereign-tribes.md` §8).
- **Only tribes created on it move.** A tribe's key is a child of its
  server's seed, so existing tribes stay on the shared server, where the
  home's Jamie still answers (§4.2). For new tribes to land on the home,
  Peel needs to create a tribe on a server it names by pubkey and route
  hint, with #416's onion `Create`; the home's strut can hand both over.
- On its own, with no Jamie, this already keeps a tribe's messages off
  Stakwork's shared server.

### 4.2 Jamie per home

The daemon (`sphinx/wasm/daemon`, `ghcr.io/stakwork/sphinx-daemon`, amd64
and arm64) is an ordinary member account. It makes every call itself, so
it runs anywhere with outbound internet. Each home runs its own: its own
account, alias "Jamie", sats, and a `/data` volume holding its seed (backed
up). It sits only in that org's tribes; today one prod Jamie sits in every
linked tribe of every org.

Its service, the calls the daemon makes (`POST /messages`,
`GET /outbox?wait`, `POST /outbox/ack`, `POST /log`, and `POST /left`
when it was removed from a tribe; `wasm/daemon/README.md`, "The
service"), is Hive's tribes service today:
about 1,500 lines (`src/app/api/tribes/messages/route.ts`,
`src/lib/tribes/tribeOutbox.ts`, `tribeDecisions.ts`, `tribeLog.ts`,
`src/app/api/strut-devices/tribes/route.ts`) and the `TribeLink`,
`TribeThread` and `TribeMention` tables. It moves to the lab
(`DAEMON_SERVICE_URL` = the home). What it does there, as Hive does it
now:

- one conversation (one orchestrator session) per Jamie thread; a burst
  folded into one turn (`earlier`); busy per conversation;
- the turn runs **as the member who spoke** when the tribe names the
  sender (sphinx#419: the owner marks Jamie with `ShowSenders`, and the
  server sends Jamie a `SentBy = 38` message with the sender's key) and
  that key is a member's; otherwise as the person who linked the tribe
  ([stakwork/hive#5688](https://github.com/stakwork/hive/pull/5688));
- each such member needs a delegation on the home; the lab holds the
  org's keys (§2), so it mints one;
- files as attachments; a proposal decided by a reply; a job's wake reply
  with its deliverables; linking a tribe (Peel → the home, with the token
  it already holds for that org) and the join it queues.

Some of it gets simpler on the home: one org per Jamie, so no lookup of
which org a tribe belongs to; the log goes straight to the lab (today
daemon → Hive `/api/tribes/log` → the lab's `tribe-messages` workflow); a
decision goes straight to strut's proposals; wake replies come from
strut's own job callbacks.

### 4.3 Tribe conversations in Hive

**Agreed:** they appear in Hive at every step. Once the Jamie chat is a
strut app on the home (§2, §3), they do: they are conversations on the
home, shown in the framed app under hive.sphinx.chat. The app's list
includes the tribe conversations the viewer may see (today, the linker's:
"The conversation is the linker's either way", `messages/route.ts`).

Before the Jamie app exists, they appear in Hive only if Hive keeps a
copy: the lab posts each tribe turn to Hive, as Hive's own route writes it
now. That keeps Hive reading tribe conversations until the app lands. It
is the cost of shipping tribes first (§6, B).

## 5. Migration

**Agreed:** an org's data moves to its home, and Hive deletes its copy.
Per org, once the home runs what replaces each piece:

| Hive's data | Moves to |
|---|---|
| `SharedConversation` (the org's Jamie conversations, tribe ones included) | the Jamie app's conversations on the home |
| `Canvas`, `Initiative` | the canvas and initiatives apps |
| `TribeLink`, `TribeThread`, `TribeMention` | the lab's tribes service; the home's Jamie joins the linked tribes and the central Jamie leaves them |
| GitHub refresh tokens | the lab, or each person authorizes once more |
| the org's macaroon key, users' keys, VK records | the lab |

What Hive keeps is what the shell needs: an org's name and its home's
host, never its content.

## 6. Ways to sequence it (open)

*Superseded (2026-11-05) by Stadeum's order (§0).*

One coupling decides the order: tribes on the home need the Jamie app, or
a copy in Hive, to keep tribe conversations in Hive (§4.3). Nothing else in
§4 needs §1–§3.

- **A. All at once.** Central shrinks, the home takes members, keys and
  tokens, the apps replace Hive's pages, tribes move, data migrates. One
  cutover per org.
- **B. Two plans.** First, the tribe server and Jamie on the home, their
  service in the lab, with Hive keeping a copy of tribe conversations
  meanwhile and pushing the lab what it needs until members and keys move
  home: who a Sphinx key is, and a delegation per member. Then the Hive
  UX, which ends the copy.
- **C. The Jamie app and tribes first, the rest after.** The Jamie chat as
  a strut app framed in Hive (Hive still signing the frame's token until
  §1.3 is built), and tribes on the home in the same step, so no copy is
  needed. Canvas, initiatives, GitHub, keys and the central shrink follow.

## 7. What changes, per repo

| Repo | Changes |
|---|---|
| sphinx-swarm | the tribes image with an external broker and its own seed; the daemon image; both in the second-brain stack and its backups |
| sphinx | nothing required (#416 and #419 are built); the end-to-end runs `docs/sovereign-tribes.md` §8 lists as not yet run |
| stadeum | *2026-11-05:* the box: sign-in, members, key custody and delegations, GitHub sign-in, updates, backups, TLS (§0) |
| stakgraph (mcp's lab) | *2026-11-05: none for a Stadeum box,* which runs strut's own image. Was: the home code |
| strut | the seams of §3.3; the per-person sign-in for the framed UI (§0, Stadeum's step 1); the Jamie, canvas and initiatives apps |
| Hive | *2026-11-05:* kept working until the Jamie app replaces it, then retired; the export of its data first. Was: the relay, the directory, the sign-in statement, the shell framing the home |
| Peel | pairing through the directory; linking a tribe at the home; creating a tribe on the home's tribe server (#416's onion commands) |

## Open questions

1. ~~The order, A, B or C (§6)~~: Stadeum's (§0).
2. Where canvas and initiatives data lives on the home: graph nodes
   (`apps.md` §4) or an app's own store (SQLite, `apps.md` work item 3,
   not built).
3. A member scope for the frame (§3.2), or the person token as it is:
   now Stadeum's step 1.
4. Keep the sign-in OAuth app, or sign in through the GitHub App's own
   user authorization (§1.1).
5. Which tribe conversations a person sees in the Jamie app: the linker's
   (as today), each sender's own turns, or the whole org's.
6. The directory: a table at hive.sphinx.chat, or DNS (§1.2). With Hive
   gone, how Peel finds a person's boxes.
9. Where the Jamie daemon's service lives on a Stadeum box: strut or
   stadeum-ui (§0, §4.2).
7. For a self-hosted home, when the relay starts exchanging and
   refreshing GitHub tokens on its behalf (§1.1).
8. The migration's mechanics: an export Hive pushes, or one the lab pulls
   with a one-off grant (§5).
