# An app as a repo — build it in strut, keep it in git, serve it at a domain

> **Status (2026-11-10): proposed; its open questions RULED the same day**
> ("Rulings", at the end, folded into the sections they touch). From one
> design conversation with the owner. Rows in "Decided" marked **owner**
> are the owner's words; every other row is *proposed*. Written against
> strut `main` @8f231964.
>
> **Work item 1 BUILT (stakwork/strut#617, merged 2026-11-10):**
> - `serve.yaml` (`src/packages/serve.ts`);
> - `STRUT_SERVE` over a name, `pk:` and `file:`, installed through the
>   distro's door and followed on the subscriptions' poll and ping;
> - `/` as the app (`pickPage`, title, favicon, `og:`), `/?shell=1`;
> - `GET /serve`, and `PUT /public-view` refused on a served box;
> - `deploy/app/`;
> - `serve` on a package build, so a strut can publish a servable release
>   (API only: the Packages tab has no field for it yet).
>
> Choices beyond the text, from the PR:
> - `serve.yaml` is required when serving.
> - Its `app` must be an app of the package.
> - The public view it writes is the whole record.
> - A deploy that fails after the install leaves the package's items
>   updated but the app and the public view as they were.
> - Changing `STRUT_SERVE` to another package leaves the earlier one
>   installed.
> - `og:image` is served at `GET /serve/image`.
> - The favicon is a `data:` URL in the page.
>
> **Work item 2 BUILT (stakwork/strut#621, open at writing):**
> - the `git+` source (`src/packages/git-source.ts`) over `git/checkout`'s
>   bare cache: a branch, tag or commit, and `#path`;
> - the token from a named secret (`tokenSecret`, default `GITHUB_TOKEN`),
>   sent only to the origins a person named;
> - the commit recorded as `upstream.commit`;
> - every install door taking it: `POST /packages/install`,
>   `STRUT_PACKAGES`, `requires.packages`;
> - `STRUT_SERVE` over `git+`, with `STRUT_SERVE_TOKEN_SECRET`;
> - `STRUT_SERVE_POLL_MINUTES` (default 5), for `git+` refs only;
> - `POST /serve/sync`: open, at most one fetch a minute, and a ping inside
>   the minute schedules one fetch when it ends, so no push is lost;
> - the commit on `GET /serve`.
>
> Choices beyond the text, from the PR:
> - `@<ref>` is optional: without it, the remote's default branch.
> - A ref resolves as a branch first, then a tag, then a commit.
> - A requirement on another host is read without the token, so a package
>   cannot send it elsewhere; a private requirement there fails.
> - A moved commit whose digest did not move deploys nothing (a change to
>   `.github/`, say).
>
> **Work item 4 BUILT (stakwork/strut#624, open at writing):**
> - the challenge (`GET /visitors/challenge`), `POST`/`DELETE
>   /visitors/session`, `GET /visitors`, role and scope `visitor` with its
>   route sweep, and `fullSession` made an allowlist (admin or the key
>   login) so a new role opens nothing;
> - the verifier seam (`src/visitors.ts`): `ecdsa-p256`, `ecdsa-secp256k1`
>   and `bip340` built, `webauthn` named;
> - four methods: `key` (a WebCrypto key in IndexedDB), `ticket`
>   (`POST /auth/ticket { role: "visitor" }`), `lnurl` (LUD-04 by QR) and
>   `nostr` (NIP-07 + NIP-98, root key only);
> - §5.1's rules on `POST /public/mcp`, per-actor daily limits with a
>   per-address budget on top;
> - `serve.yaml`'s `signIn`, `visitorKey` and `limits`, written as the
>   public view's `visitors`;
> - the kit's `useVisitor()` over `@strut/kit/visitor`, and the host page's
>   sign-in sheet.
>
> Choices beyond the text, from the PR:
> - A visitor's session lives in a cookie of its own (`strut_visitor`), so
>   signing in on a box never replaces the operator's console session on
>   the same origin; it lasts 30 days.
> - On `POST /public/mcp`, where `Authorization` carries a credit token, the
>   host page sends the visitor's token as `x-strut-visitor`.
> - Reads stay the anonymous visitor's, widened by the visitor's own data:
>   its state, its runs, and the nodes of the app's declared types.
> - A visitor's direct launch takes `input` and `key` alone: no job,
>   conversation, files or params. A visitor cannot cancel a run.
> - `ticket` needs no entry in `signIn`: minting one already takes the key.
> - Limits: 1 000 writes and 100 launches a visitor a day by default; ten
>   times that per address, fixed; counted in memory.
> - A non-served strut names its methods in the Publish dialog's Public
>   view tab (a Sign-in section), which writes `PUT /public-view`'s
>   `visitors`.
> - Signing in drops what the page set before and the server refused; an app
>   sets it again once signed in.
>
> Companion to:
> - `marketplace.md`: the package format (§1), the `git+` source and the
>   export to git (§5, step 3, not built), the distro's door (§12);
> - `public-surface.md`: the visitor's page (§5) and custom domains (§9);
> - `paid-runs.md`: public and priced runs, the L402 credit token;
> - `app-payments.md`: the wallet contract an app speaks and the browser
>   host's providers (§5.2, not built);
> - `member-rights.md`: roles on a session;
> - `apps.md`: what an app is and may call.

## Problem

A person builds a game in their strut: an app (`apps/<name>/`, TSX built
against the kit) over a few workflows and steps. Today it can be:
- used on that strut;
- shown to anyone through that strut's public view;
- copied to another strut as a package.

What it cannot be:
- **A normal git repo.** Others can't clone it, open a PR against it, or
  review a diff of it on GitHub, GitLab or Forgejo.
- **Its own website.** It can't sit at `moonlander.game` with nothing of
  strut's around it, redeployed when `main` moves.
- **A place with players.** A public visitor is anonymous and read-only
  today. A game needs to know who scored what, give each player their own
  saved state, open a multiplayer room, and take their sats.

The owner's ask, in their words: *"someone should be able to make a repo
that IS a strut app — the backend being workflows/steps while the frontend
being the app — and it's a normal git repo … deployed at a domain name JUST
as that code … the strut hono server is some kind of bootloader that loads
up the app as itself in a frame with no other UI at all."* On visitors:
*"we'll have lots of implementations for visitors."*

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | What is the repo's format? | **A package.** `marketplace.md` §1's layout at the repo's root (or under `#path`): `strut.yaml`, `workflows/`, `steps/`, `apps/`, `concepts/`, `graph/`. Top-level files (a README, a LICENSE) and dotfiles (`.github/`, `.gitignore`) are already allowed and read past. No new format, and no build step outside strut. | **owner** (the repo IS a strut app); the format is proposed |
| 2 | Where does "serve this app" live? | **A top-level `serve.yaml`**, not a key in `strut.yaml`. The manifest is strict, so an older strut would refuse a package carrying a new key. A top-level file is in the digest and read past, which is the same reason a workflow's `category` rides in its own YAML. | proposed |
| 3 | What is a deployed app? | **A normal strut with `STRUT_SERVE=<ref>`.** It installs the ref through the distro's door, follows it, and shows the app at `/` with nothing of strut's around it. Everything else stays behind the key. | **owner** (bootloader, no other UI); the mechanism is proposed |
| 4 | Who decides what a served box shows? | **The repo.** `serve.yaml` writes the box's public view at every deploy, and `PUT /public-view` there is refused with a message naming the file. A seed always matches git. | proposed |
| 5 | Does the frame stay with no UI around it? | **Yes.** It is the wall between model-written app code and what the host page holds: a visitor's session, a wallet. | proposed |
| 6 | Who merges? | **Git, never strut.** The author's strut keeps a real git checkout. Strut writes its items into the checkout as a commit and installs trees from it; a merge and its conflicts happen in git. | proposed |
| 7 | Who pushes? | **A person, or an accepted proposal.** A push publishes to a remote, an outward act like `package/install`. | proposed |
| 8 | How do visitors sign in? | **One seam, many sign-ins.** A sign-in is a signature over strut's challenge by a key. Strut keeps a handful of verifiers; where the key lives (a browser, a wallet, an extension, a passkey, a phone) is the client's business and can grow without strut changing. | **owner** (many implementations); the seam is proposed |
| 9 | What does a signed-in visitor get? | **The served app's grants, as itself, minus spending.** Its own `app/state`, channels, graph writes on the app's declared types, and launches of granted workflows that spend nothing. Anything that spends goes through the public run door (priced, or free under a daily cap). | proposed |
| 10 | How do players pay? | **L402 priced runs first** (built; any wallet, by QR). Then browser wallet providers behind the wallet contract apps already speak (`strut/wallet/*`). A wallet that holds a key can also be the sign-in. | proposed |
| 11 | What does a served box run on? | **One container on the Ladybug backend**, one volume, Caddy in front for TLS (`deploy/app/`, beside `deploy/index/`). | proposed |

## Design in one paragraph

**The repo is a package; the server is strut; `/` is the app.**
- **The repo.** A git repo with the package layout at its root is an app's
  whole source: workflows and steps for the back end, `apps/<name>/` for the
  front end, plus one file, `serve.yaml`, saying which app `/` shows and
  what visitors may run, at what price.
- **The author's side.** The author's strut opens the repo: a git checkout,
  installed into the workspace. The author and the builder edit the
  installed items as they edit anything else. **Commit** writes them back
  into the checkout and pushes a branch or a PR; **Pull** runs `git pull`
  and installs the result.
- **The served side.** A box started with
  `STRUT_SERVE=git+https://github.com/acme/moonlander@main` installs that
  ref with no ask, follows the branch (a poll, and a webhook ping), applies
  `serve.yaml`, and answers `/` with the app framed alone.
- **Visitors.** A visitor may stay anonymous (today's public visitor) or
  sign in by signing strut's challenge with a key, and is then that key's
  actor on this box: their own state, their own room, their own rows.
- **Money.** Priced workflows take L402 credit, which already works from any
  phone wallet. Wallets in the browser (an extension, NWC, a Sphinx wallet
  in wasm, a passkey-unlocked Sphinx wallet at one origin) plug in behind
  the wallet contract the app already speaks.

## 1. What exists

| Piece | Where | State |
| --- | --- | --- |
| The package layout, digest = tree hash | `src/packages/format.ts` | built; a README, a LICENSE and dotfiles are read past |
| `file:` and `pk:` sources | `src/packages/cache.ts`, `pk.ts` | built |
| `git+` source | `marketplace.md` §5 | planned; `resolvePackage` refuses it (`cache.ts:147`) |
| `git/checkout`, `git/diff`, `git/push`, `github/create-pr` | `src/steps/lib/git/`, `github/` | built; any http(s) host and `file://` (`parseRepo`) |
| The distro's door: install with no ask, fast-forward untouched items, keep forks beside | `src/packages/install.ts` | built |
| Following a publisher's catalog, ping to sync | `src/packages/subscriptions.ts` | built, `pk:` only |
| Packages at first boot | `src/packages/boot.ts`, `STRUT_PACKAGES` | built; refs are names, `pk:`, `file:` |
| One app alone, for a visitor: `?app=<n>&solo=1&public=1` | `web/src/page.ts`, `SoloApp.tsx`, `src/public-routes.ts` | built |
| A visitor's door: `POST /public/mcp`, `visitorRefusal` | `src/public-surface.ts` | built; reads only, no `app/state`, no channels — until signed in (§5, `src/visitors.ts`) |
| Public and priced runs, the L402 credit token, the ledger | `src/public-runs.ts`, `src/public-credit.ts`, `src/l402.ts`, `src/payments/` | built |
| Roles on a session (admin, member), sign-in tickets | `src/auth.ts`, `MEMBER_ROUTES` in `createStrut.ts` | built |
| The app wallet contract, the relay to a native host | `kit/src/wallet/`, `specs/WALLET.md` | built; a browser host has no provider yet |
| Custom domains at the origin | `public-surface.md` §9 | proposed, deferred |

Most of this plan is wiring between pieces that exist. The new pieces are:
- `serve.yaml` and serve mode;
- the `git+` resolver;
- the round trip (Open repo, Commit, Pull);
- the visitor seam;
- browser wallet providers.

## 2. The repo

```
moonlander/
  strut.yaml            # package: acme/moonlander, version, requires
  serve.yaml            # what / shows, what visitors may run
  README.md  LICENSE    # read past: in the digest, not items
  .github/              # dotfiles: not in the digest
  apps/
    game/               # app.yaml, src/, public/ — the front end
  workflows/
    score.yaml          # the back end, named package-first
    ghost.yaml
  steps/
    physics/replay.ts
  concepts/
    moonlander.md
  graph/
    Run.yaml            # a graph type the app writes
```

- **Names.** Installed, items are `acme/moonlander/score` and so on. Inside
  the package a bare name is the package's own item first
  (`src/package-lookup.ts`), so `score.yaml` and the app's grants say
  `score`.
- **A repo with other things in it.** `marketplace.md` §5's ref takes a
  path: `git+https://github.com/acme/site@main#strut`. A repo that also
  holds a marketing site, a mobile client or deploy scripts keeps the
  package under one folder. A top-level folder the format does not know
  is still refused at the root, so a newer strut's package fails whole
  instead of installing half.
- **Nothing to build.** The app builds against the serving strut's kit at
  install time: no `node_modules`, no Vite, no lockfile in the repo. The
  strut image's tag pins that kit (§4.6).

### 2.1 `serve.yaml`

```yaml
app: game                     # apps/game is what / shows
title: Moon Lander            # <title>, og:title (default: the app's title)
description: Land softly. Beat your ghost.
image: apps/game/public/og.png  # og:image, a file in the package
reads: [score-board]          # what an anonymous visitor's page may call
runnable:                     # paid-runs.md §2's record, names package-first
  - { kind: workflow, name: ghost, base: 0.002, markup: 1.3, capUsd: 0.05, dailyCapUsd: 5 }
concepts: [Moon Lander]       # Concept roots in the public view
signIn: [key, lnurl, nostr]   # §5.3's methods this box accepts (default: none)
visitorKey: domain            # a child key per domain (default: root — §5.2)
limits: { writesPerDay: 500 } # per-visitor limits over strut's defaults (§5.1)
```

- **Applied at every deploy.** It writes the box's public view record
  (`public.json`): the app, held at the version just installed, its
  `reads`, the `runnable` items and the Concept roots. Names are resolved
  package-first and written whole (`acme/moonlander/ghost`).
- **Checked like a person's `PUT /public-view`** (`runnableProblems`,
  `surfaceProblem`). A `serve.yaml` that fails the check fails the deploy:
  the box keeps serving the previous one and says why (§4.4).
- **What stays the deployment's.** Prices are the repo's; the wallet
  (`LIGHTNING_*`), the model keys and `requires.secrets`' values are the
  deployment's env, as for any strut.

## 3. The author's side: working on a repo from a strut

The author builds in their strut: the builder chat, Jamie, the `builder`
job. That workspace names things bare (`score`), while an install names
them under the package (`acme/moonlander/score`). An export followed by
pulling a contributor's PR back would therefore make a second copy of
everything. So the author's strut works **on** the repo, the way an editor
works on a checkout: the installed items are the ones being edited.

### 3.1 Open a repo

`POST /packages/repos { url, ref?, path?, tokenSecret? }`, the Packages tab's
**Open repo**:
1. **Clone.** `git/checkout`'s bare cache, then a KEPT working copy at
   `<dataDir>/packages/work/<publisher>/<name>/` on the ref's branch.
2. **Install.** Read the package, then install it through a third door,
   `repo`. It behaves like the person's door: every item of the set is
   checked before the first write, and missing secrets are reported. Each
   version records `upstream: { package, digest, source: "git+…", commit }`.
3. **Track.** The repo is on file (`<dataDir>/packages/repos.json`): URL,
   branch, path, the commit last installed, the token secret's NAME.

**Create repo** is the same thing started from a strut. Pick workflows,
apps and Concepts as the package publisher does today; the build writes
the files into a new checkout; strut pushes them to an empty remote the
person names, then opens it as above. The bare originals stay where they
are. The dialog offers to retire them, since from now on the package's
copies are the ones being edited.

### 3.2 Edit

Nothing new. The builder edits an installed item through the authoring
tools: since #606 the `meta/*` twins publish over any workflow. The edit is
a fork in `marketplace.md` §4's sense (the active version is no longer the
package's). The app is edited in its directory and republished, as today.

### 3.3 Commit

**Commit** (`POST /packages/repos/:id/commit { message, branch?, pr? }`, a
person's act or an accepted `package/commit` proposal):
1. **Write.** `packageFiles(deps, <every item under the prefix>)` writes
   the package's current state into the working copy: each item's active
   version, the apps' sources, the Concept pages, the types.
2. **Show.** `git/diff` shows what changed, file by file.
3. **Commit and push.** With the actor's GitHub identity (`git/push`): a
   new branch and a PR (`github/create-pr`), or straight to the followed
   branch when the person says so.
4. **Re-stamp.** Each pushed item's active version gets
   `upstream.commit = <the new commit>`, so it is no longer a fork: the
   package wrote it.

### 3.4 Pull

**Pull** (`POST /packages/repos/:id/pull`):
1. **Commit locally first.** Uncommitted edits in the workspace are
   written into the working copy as a local commit (3.3's steps 1, 3, 4
   with no push), so nothing is lost and git has both sides.
2. **`git pull`.** Git merges. A conflict stops here: the working copy
   holds git's conflict markers, and the answer names the files. The
   person, or the builder as a job with the working copy as its directory
   (`git/checkout`'s `workdir`), resolves them and commits.
3. **Apply.** The merged tree is installed through the `repo` door. Every
   item now matches the checkout, so nothing stays a fork.

A contributor's PR merged on GitHub reaches the author's strut by Pull, and
every served box by its next sync (§4.3).

### 3.5 Relation to the history

`history.git` (`plans/concept-history.md`) is one machine's record of
everything it held: a whole-workspace package, committed on every heard
write, never pushed. An app repo is one package, shared, committed when a
person says so. They don't touch: a commit here is a workspace write the
history hears like any other.

## 4. The served side

### 4.1 Boot

`STRUT_SERVE=git+https://github.com/acme/moonlander@main` (or `pk:…` with
`STRUT_SERVE_URL`, or `file:/path`; any ref the install takes). The
`createStrut({ serve: { ref, url?, tokenSecret? } })` option is the same
thing for a host. At boot:

1. **Install.** Resolve the ref (`git+`: a fetch into the bare cache, the
   tree at the branch's commit under `#path`, read and hashed like any
   package), then install it through the **distro's door**: no ask,
   untouched items fast-forwarded, the package the distro's. Its
   `requires.packages` come first, as for any install.
2. **Apply `serve.yaml`** (§2.1).
3. **Seed nothing extra.** `strut/jamie` and `strut/knowledge` are not
   seeded (`jamie: false`, `knowledge: false`), since a served box has no
   members to use them. `strut/views` still is (an app may import it).

`STRUT_PACKAGES` and `STRUT_SERVE` may both be set. The first installs
what the box should have; the second names the app it is.

### 4.2 `/`

- **The page.** `GET /` and `GET /index.html` are served with
  `<meta name="strut-serve" content="<app>">`, plus `<title>`, the
  favicon (the app's manifest icon) and the `og:` tags from `serve.yaml`.
  `pickPage` (web/src/page.ts) reads the meta and renders the solo visitor
  page for that app at `/`, with no query string: the same page as
  `?app=<n>&solo=1&public=1` today.
- **Deep links.** The app's own `?input=` still works: a shared link opens
  the game where it says.
- **No other UI for visitors.** The shell, the store and the key prompt are
  not drawn. With the key (a session, `?key=`), `/?shell=1` opens strut's
  own UI: the operator's console for runs, logs and secrets (ruled 1).
- **Open routes.** `/public/*` and the visitor's MCP door, as on any strut
  with a public view. Every other route keeps its credential.
- **Many hosts, one app.** Whatever `Host` a request carries, `/` is the
  app. `public-surface.md` §9 (a host name picks one of several public
  apps) is the many-apps version of the same page; a served box is the
  case where every host maps to one app.

### 4.3 Following the branch

- **Poll.** `STRUT_SERVE_POLL_MINUTES` (default 5): `git fetch` the ref.
  When the branch's commit moved and the package's digest changed, install
  and apply as at boot.
- **Ping.** `POST /serve/sync`, open to anyone, at most once a minute: the
  same fetch, now. Point a GitHub, GitLab or Forgejo push webhook at it.
  It needs no secret, because all it can do is make strut read the ref it
  already follows (`subscriptions.ts`' ping works the same way for `pk:`).
- **A `pk:` ref** is followed exactly as a subscription is.

A deploy is ordinary package work: a version per changed item, `source:
"distro"`, and a commit in the history. A rollback is a revert on the
branch.

### 4.4 Status

`GET /serve` (full scope): the ref, the commit and digest serving, the last
fetch, the last deploy, and the last error. An error is a deploy that
failed to resolve, install or apply; the previous one keeps serving. Logged
at every deploy in one line.

### 4.5 `deploy/app/`

Beside `deploy/index/`: the published strut image and Caddy, compose
project `strut-app`, an `.env` from `env.example` holding:
- `STRUT_SERVE`, the domain, `STRUT_API_KEY`, `STRUT_SECRET_KEY`;
- the model keys and `requires.secrets`' values;
- the wallet (`LIGHTNING_*`) when the repo sells anything.

`STRUT_WORKSPACE_BACKEND=ladybug`, one volume. Point an A record at the
box and Caddy gets the certificate. Nothing in it is specific to a box:
the same image runs on Fly, Railway or a home server.

### 4.6 The strut version

The kit an app builds against is the strut's. The image tag pins it
(`STRUT_IMAGE_TAG=<sha>`, or a release channel). A repo does not say which
strut it needs (ruled 8): strut's version is a commit today, with nothing
to compare against. Revisit once strut has release numbers.

### 4.7 A private repo

A served box may follow a private repo (ruled 9): `STRUT_SERVE`'s
`tokenSecret` names the secret it reads with, as `git/checkout` does. The
app is public and the source stays private, like any closed-source site.
Nothing else changes.

## 5. Visitors

Today a visitor of a public app is anonymous:
- **Reads.** The app's `reads` and the public view's graph reads.
- **Runs.** Public and priced runs through `/public/workflows/:name/run`.
- **Refused.** `app/state` (the kit keeps a refused write on the page for
  the visit), channels (`relayChannels` runs for a signed-in viewer only)
  and every write.

That is right for a reader and too little for a player. This section adds
a **signed-in visitor**: a person known only by a key, on this box. Served
boxes need it first, but it is the same for any strut's public apps.

### 5.1 What a signed-in visitor gets

A session, the existing signed cookie (`auth.ts`), with `role: "visitor"`
(a third role beside admin and member) and an actor the sign-in names
(§5.2). Its scope `visitor` opens:
- the public apps' pages and files (as `/public/apps/*`);
- `POST /public/mcp` as itself, with the app's grants checked as for a
  member's `step_run`, under these rules:
  - **Reads** the app grants: yes.
  - **`app/state`:** yes, its own (one file per actor, as for anyone).
  - **Channels:** yes. `POST /apps/:name/channel-ticket` names its actor,
    so `useChannel` works on a visitor's page.
  - **Graph writes:** only on the types the app declares (`data.graph`), as
    today for any app. Each is a kept run with the actor, so a leaderboard
    row says who.
  - **`run/launch`:** a granted workflow whose closure spends nothing
    (`closureCan(…).spends` false) launches as the visitor. One that
    spends launches only as a `runnable` item, through the public run
    door: priced, or free under its daily cap. The visitor never spends
    the operator's model budget past what `serve.yaml` priced or capped.
  - **Refused, as for any app page:** `job/start`, authoring, `llm` /
    `agent` / `exec`.
- **Nothing else.** Not Jamie, not another app, not a private read. A
  visitor is not a member: a member's Jamie reaches the builder.

**Limits** (ruled 5). Writes and launches are budgeted per actor, with
defaults in strut that `serve.yaml`'s `limits` may change. An anonymous
key costs nothing to make, so per-actor counts alone don't hold: the
per-address budget (`visitorAddress`) stays on top whatever `limits`
says, the monitor (`src/apps/monitor.ts`) warns on fan-out, and anything
that costs money is priced or capped.

### 5.2 The seam: a signature over strut's challenge

The server side is small and fixed:

1. **Challenge.** `GET /visitors/challenge` → `{ challenge, methods,
   visitorKey }`. The challenge is `strut-visitor.<claims>.<hmac>`: claims
   `{ host, visitorKey, nonce, exp }` (60 s), signed like a sign-in
   ticket, so it is stateless. It is good once (redeemed nonces kept until
   they expire, as tickets' `jti`). `methods` is `serve.yaml`'s `signIn`,
   or the public view's; `visitorKey` is `serve.yaml`'s, `root` unless
   the app asks for `domain`.
2. **Sign.** The client signs the challenge with a key, by one of §5.3's
   methods: the root key, or the domain's child key when the challenge
   says `domain`.
3. **Verify.** `POST /visitors/session { challenge, method, key, sig, … }`
   checks the signature with the method's verifier. On success it sets the
   session cookie with actor `<scheme>:<public key>`, and also returns
   `{ actor, token, exp }`. `DELETE` signs out.
4. **When the cookie can't be kept** (ruled 4). When the store or Hive
   shows the app inside its own page, the box is a third party there and
   the browser drops its cookie. So strut's host page keeps the returned
   token in the browser's storage for this site, which a browser keeps
   apart per framing site, and sends it as `Authorization: Bearer` when
   no cookie is sent. The framing host does nothing. The token is the
   cookie's value, signed the same way, and works as one.

**Verifiers.** A method names one of a few:

| Verifier | Checks | Used by |
| --- | --- | --- |
| `bip340` | a Schnorr signature over the challenge's sha256 by an x-only secp256k1 key (`@noble/curves`, already a dependency) | a Sphinx key, a Nostr key, a browser-made secp256k1 key |
| `ecdsa-secp256k1` | LNURL-auth's DER signature over `k1` by a linking key | any Lightning wallet that does LNURL-auth |
| `ecdsa-p256` | a raw P-256 signature by a WebCrypto key | a non-extractable browser key |
| `webauthn` | an assertion (authenticator data, client data, signature) against a credential the box registered at first use | a passkey with no wallet behind it |

**Actor ids.** One per key, not per method:
- `secp:<x-only hex>` for any secp256k1 key, so the same key signing
  through wasm, through an extension or from Peel is one person;
- `p256:<hex>` for a browser key;
- `passkey:<credential id hash>` for a passkey.

**One root key by default; a child key per domain when the app asks**
(ruled 3).
- **Default, `visitorKey: root`.** A provider that holds a root key signs
  with it, so the same person is the same actor on every box. That gives
  a portable profile, and it means games can tell it's the same player.
- **Opt-in, `visitorKey: domain`.** The provider signs with a child key
  derived one-way from the challenge's `host`, so the visitor is a
  different actor on this domain and no other domain can tie the two
  together. The derivation is LNURL-auth's (LUD-05: a BIP-32 path from an
  HMAC of the domain), so every provider that holds a root key gets the
  same child for the same domain.
- **Methods that are per domain anyway:** the anonymous browser key and a
  passkey alone live in the domain's storage or under its RP ID, and
  LNURL-auth's linking key is per domain by its spec, whatever the box
  asks.
- **Methods that cannot derive:** a Nostr extension signs with its one
  key, so it is not offered where the app asks for `domain`.

**Where implementations live.** A method that needs no new verifier is
client code only: a provider in the host page (`web/src/`), the same
place the wallet providers go. Adding a sign-in is adding a provider. The
app never sees the key: the kit gets `useVisitor()` → `{ actor?, signIn(),
signOut() }`, and the host page draws the sign-in sheet.

### 5.3 Sign-ins

Each is a provider in the host page. They are listed roughly in the order
they could be built.

1. **An anonymous browser key** (`key`). A non-extractable P-256 key made
   with WebCrypto on first sign-in, kept in the domain's IndexedDB. One
   tap, nothing to install. Lost with the browser's
   data, and one per device. Right for a high score.
2. **A host vouches** (`ticket`). When the app is framed by a host that
   knows the person (Peel, Hive, the store), the host's server mints a
   sign-in ticket as today (`POST /auth/ticket`, role `visitor`).
3. **LNURL-auth** (`lnurl`). The sheet shows a QR code; any Lightning
   wallet on a phone signs it. This is the same wallet that pays an L402
   QR, so a player who paid can be the player who signed in. Its linking
   key is per domain by design.
4. **A Nostr extension** (`nostr`). `window.nostr` in the top page (NIP-07)
   signs a NIP-98 HTTP-auth event for `POST /visitors/session`, its
   `payload` tag the hash of the body that carries the challenge, verified
   by `bip340`. Root key only (§5.2).
5. **Sphinx in wasm, on this origin** (`sphinx`). The Sphinx v2 core as
   wasm (`sphinx/wasm`, `wasm-pack --target web`; `sphinx-chat` runs the
   same core in Node) loaded by the host page. The visitor gets a Sphinx
   account in a second, and its key signs the challenge. It is a wallet
   too (§6). The keys live in this domain's storage, so they are as safe
   as whoever serves the domain, and each domain is a separate wallet.
6. **A Sphinx wallet at one origin, unlocked by a passkey**
   (`sphinx-passkey`). One wallet across every app domain and the person's
   phone, with no install. §5.4.
7. **Peel by QR** (`peel`). The sheet shows a QR code; Peel scans it and
   signs with the person's Sphinx key. The same pairing can open an NWC
   connection to Peel's wallet (`app-payments.md` §5.4).
8. **A passkey alone** (`passkey`). WebAuthn with this domain as the RP ID
   and no wallet behind it: identity that survives clearing the browser and
   syncs to the person's phone.

### 5.4 A Sphinx wallet at one origin, unlocked by a passkey

The idea: **instant, cross-origin Sphinx, with the keys following the
person to their phone.**

- **One origin: `wallet.sphinx.chat`** (ruled 6), run by Sphinx as the
  default every app shares. The page is static, plus a small store of
  ciphertexts. It is open source, so a deployment may run its own and
  name it.
- **Not Peel's wallet** (ruled 7). The browser wallet is less secure than
  Peel and is a Sphinx account of its own, never the person's Peel
  account. A person who holds sats in it can sweep them to Peel, or skip
  it and connect Peel over NWC (§5.3, 7). Signing in with it and signing
  in with Peel are two actors.
- **First use, from any app's domain.** The host page opens the wallet in
  a popup, which is first-party there, so its storage and passkeys work.
  The person creates a passkey (Face ID) with the PRF extension. The page:
  - makes a Sphinx seed in wasm;
  - derives a key from the PRF output (HKDF);
  - encrypts the seed with it;
  - stores the ciphertext under the credential id, locally and on the
    wallet origin's server.

  The seed in the clear never leaves that page.
- **Every later domain.** The same popup asks for the passkey, PRF gives
  the same output, and the same wallet opens. The host page and the popup
  talk by `postMessage`:
  - sign strut's challenge: with the wallet's root key, so the same person
    on every box, or with the domain's child key where the app asks
    (§5.2);
  - pay, make an invoice: the wallet contract's methods.

  Per-app connections and budgets (`app-payments.md` §4) are enforced in
  the wallet page, so a compromised app domain can't drain past what the
  person allowed it.
- **The phone.** Passkeys sync through iCloud Keychain and Google Password
  Manager, so the same passkey on the phone gives the same PRF output and
  opens the same ciphertext in the phone's browser. Nothing is "sent" to
  the phone; the sync is the transport.
- **Why a popup, not one passkey across domains.** WebAuthn's Related
  Origin Requests lets several domains use one RP ID, but browsers cap the
  list at five registrable-domain labels: fine for one company's ccTLDs,
  useless for any app's domain. A cross-origin iframe instead of the popup
  would mean no popup, but its storage is partitioned per top site, so it
  would have to fetch the ciphertext every time. Worth trying as the
  smoother variant.
- **What can go wrong.**
  - The passkey is the only unlock. Lose it, or use a password manager
    that does not carry PRF, and the seed is gone. So the wallet offers a
    seed backup, or a sweep to Peel, the first time it holds sats.
  - PRF support is broad now (iCloud Keychain on Safari 18 and Chrome,
    Google Password Manager, Firefox on macOS) but not universal. A
    cross-device QR flow has been reported to return no PRF in Safari, and
    Windows Hello's support is reported inconsistently.
  - Whoever serves the wallet origin serves the code that sees the seed:
    the same trust as any web wallet. It can be self-hosted and pinned.

  Sources: [web.dev, Related Origin Requests](https://web.dev/articles/webauthn-related-origin-requests),
  [passkeys.dev, related origins](https://passkeys.dev/docs/advanced/related-origins/),
  [Corbado, passkeys and PRF](https://www.corbado.com/blog/passkeys-prf-webauthn),
  [Apple forums, PRF in Safari's cross-device flow](https://developer.apple.com/forums/thread/774112),
  [lilting.ch, on deriving encryption keys from PRF](https://lilting.ch/en/articles/passkeys-prf-extension-encryption-risk).
- **Scope.** This wallet is mostly not strut's code. The page and its
  store belong with Sphinx (the `sphinx` repo's wasm). Strut's part is
  one host-page provider that opens it and speaks `postMessage`. It gets
  a plan of its own once someone builds it.

## 6. Payments

1. **Priced runs: built, and enough to sell plays.** A `runnable` item in
   `serve.yaml` with a price makes a launch answer 402 with an invoice. A
   phone wallet pays the QR, `POST /public/credit/claim` returns the
   token, and the run goes. Revenue lands in the box's wallet
   (`LIGHTNING_*`). No wallet in the browser and no extension needed.
2. **A wallet in the page,** for what an app does itself: a tip, a
   keysend to another player, a boost. The app already speaks
   `strut/wallet/*` to its host (`kit/src/wallet/`). In Peel the host is
   native and the sats are Peel's (built). On a plain browser page, the
   host page needs providers:
   - **Bitcoin Connect**: the Alby extension's `window.webln` in the top
     page (an extension cannot reach a srcdoc frame), or any NWC wallet.
     This is `app-payments.md` §5.2, not built.
   - **Sphinx in wasm on this origin** (§5.3, 5).
   - **The passkey Sphinx wallet** (§5.4).
   - **Peel over NWC** (`app-payments.md` §5.4).
3. **A key can be both.** A provider that holds a key (Sphinx in either
   form, Peel, an extension with `window.nostr`) also offers sign-in. One
   tap gives the visitor an identity and a wallet, and their actor is
   their payment key.

**Write once, works in both places.** A game written once pays with the
person's Sphinx sats inside Peel, and with whatever wallet the visitor
brings on its own domain. The app does not change.

## 7. What not to do

- **No new format, and no build in the repo.** A repo carrying
  `package.json`, Vite or `node_modules` for the app is a second
  toolchain to keep in step with the kit; the serving strut builds.
- **Strut does not merge.** Merging belongs to git; the alternative is
  re-inventing it per item kind.
- **No keys held for visitors on the server.** A visitor's key is
  theirs: a browser's, a wallet's, a passkey's. Strut verifies signatures
  and keeps sessions, never a custodial wallet.
- **Never the wallet in the app's frame.** The host page holds it; the app
  asks. That is why the frame stays (Decided 5).
- **A signed-in visitor is not a member.**
- **No Related Origin Requests for a cross-domain wallet** (§5.4).

## Work items

In order (ruled 2). Each one is useful alone. If the first real game needs
players before it needs git, visitors (4) moves up to second.

1. **Serve mode over the refs that exist.** *BUILT, stakwork/strut#617.*
   `serve.yaml` (format, check,
   apply), `STRUT_SERVE` over `pk:` and `file:`, the distro's door,
   following a `pk:` ref as a subscription, `/` as the app (the meta,
   `pickPage`, title, favicon, `og:`), `/?shell=1`, `GET /serve`,
   `deploy/app/`. With this alone a creator publishes a release from their
   strut and a box serves it at a domain.
2. **The `git+` source.** *BUILT, stakwork/strut#621.* The resolver over
   `git/checkout`'s bare cache,
   `#path`, the commit recorded in `upstream`, `STRUT_SERVE` and
   `STRUT_PACKAGES` taking `git+`, the poll and `POST /serve/sync`.
3. **The round trip.** Open repo, Create repo, Commit, Pull, the `repo`
   door, `package/commit` as a proposal, the Packages tab's rows for a
   repo.
4. **Signed-in visitors.** *BUILT, stakwork/strut#624.* The challenge, `POST /visitors/session`, role
   and scope `visitor`, §5.1's rules in `step_run`, per-actor budgets, the
   kit's `useVisitor()`, the host page's sheet. The first methods are the
   anonymous key and a host's ticket, then LNURL-auth and Nostr.
5. **Browser wallets.** Bitcoin Connect (`app-payments.md` §5.2), then
   Sphinx in wasm on the origin, each also a sign-in where it holds a key.
6. **The passkey Sphinx wallet at `wallet.sphinx.chat`.** A plan of its
   own, mostly in `sphinx`; strut's part is the provider.

## Validation

- **Serve, offline.** A fixture repo (`git init` in a temp dir: the `hello`
  app, a workflow, a `serve.yaml`) and a strut booted with
  `STRUT_SERVE=git+file://…`:
  - `GET /` carries the meta;
  - the app's document opens as a visitor;
  - an anonymous read answers;
  - a commit to the fixture and `POST /serve/sync` serve the new version;
  - a bad `serve.yaml` keeps the old one and `GET /serve` says why.
- **Round trip, offline.** Open the fixture repo, edit a workflow through
  `meta/edit-workflow`, Commit to a local bare remote; the file changed
  and the item is no longer a fork. Commit a conflicting change on the
  remote, then Pull: the conflict is named and nothing is installed.
- **Visitors, offline.**
  - Two keys sign in; each has its own `app/state` and is a different
    actor on a written row.
  - A spending workflow launched outside `runnable` is refused.
  - A replayed challenge is refused.
  - One root key signs in as the same actor on two hosts, and, with
    `visitorKey: domain`, as two actors.
  - A session sent as a bearer token, with no cookie, works as the cookie
    does.
  - A visitor session is 403 on every route outside its scope (a sweep,
    like the member's).
- **Live.** `deploy/app/` on a small VPS with a real domain and a game
  from the `game` starter: Caddy's certificate, a push to `main` deployed
  by the webhook, a phone paying a priced run by QR, a second phone in the
  same channel room.

## Rulings (2026-11-10)

The plan's open questions, ruled by the owner the same day. Each is folded
into the section it touches.

1. **The shell on a served box:** `/?shell=1` opens strut's console for
   whoever holds the key; visitors never see it (§4.2).
2. **The order:** as "Work items" lists it, serve mode first. Visitors move
   up to second if the first real game needs players before git.
3. **One visitor key or one per domain:** one root key by default, so a
   person is the same actor on every box. An app may opt in to a child
   key for its domain with `visitorKey: domain` (§5.2).
4. **A visitor inside a frame:** the sign-in also returns the session as a
   token, which strut's host page keeps and sends as a bearer when the
   browser drops the third-party cookie (§5.2, step 4).
5. **Per-visitor limits:** defaults in strut, which `serve.yaml`'s `limits`
   may change; the per-address budget always stays on top (§5.1).
6. **The passkey wallet's origin:** `wallet.sphinx.chat`, run by Sphinx; a
   deployment may run its own (§5.4).
7. **One Sphinx account in the browser and in Peel:** no. The browser
   wallet is less secure and is its own account, never Peel's; it can
   sweep to Peel (§5.4).
8. **A repo naming the strut it needs:** not now; the image tag pins strut
   (§4.6).
9. **A private repo served publicly:** allowed, nothing special; the box
   reads it with a token secret (§4.7).
