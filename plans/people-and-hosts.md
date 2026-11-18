# People and hosts: one identity, names, and Support as an app

> **Status (2026-11-18): ruled in outline; every item built on #737: 1
> (names), 2 (host keys and accounts), 3 (a host calls an app's tools), 4
> (an app's own SQLite) and 5 (Support rebuilt as an app: no polling, no
> `/support` routes, no heads-up). Item 6 (Peel links to a box, ruling 9)
> is proposed.**
>
> - **Written against:** strut `main` @2681b6f9, stakwork/sphinx `master`
>   @cb1026fe, stakwork/stadeum @ab997cc (`fix/ops-pull-retry`), hive
>   `master` @554793fa1.
> - **The Rulings** are from one conversation with Evan on 2026-11-17. 1–3
>   are his own points. 4–6 were proposed in that conversation and he
>   accepted them. 7, 8 and 9 are his, from 2026-11-18.
> - **The decisions in §8** are this plan's defaults. Evan may overrule them.
> - **Companion to:**
>   - `jamie-in-tribes.md`: host keys (§5.1) and linked accounts (§5.2).
>     This plan builds on both and changes two things (§2);
>   - `apps.md`: §4.4 and item 3, an app's own SQLite, built on #737 as item
    4 here;
>   - `support-chat.md`: Support as built (#719, #720), which §5 rebuilds
>     without keeping its data (ruling 7). Ruling 3 here replaces its ruling
>     16 ("polled");
>   - `human-steps.md`: the task store, which stays as it is (§6).
>
> **Keeping this plan current.** Each PR that builds an item edits this file:
> its row in §10 says it is built and names the PR. Wherever a section says
> something other than what was built, the PR marks it **Built differently
> (#N):**, with what was built and why.

## Rulings (2026-11-17; 7, 8 and 9 on 2026-11-18)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | Identity | **Standardize and simplify it: more generic, less specific.** One record of a person in strut, whoever the host is |
| 2 | What staff read | **A name.** A key (`secp:…`) in the Workers tab is wrong: a worker is a Sphinx user and has a name |
| 3 | How the daemon reaches strut | **It calls strut's generic endpoints** (tools and workflows). Strut gains no Support-shaped route and stops polling the daemon for messages |
| 4 | Tasks and workers | **Stay in the engine.** Support is rebuilt as an app: the worked example of a whole application in the app format |
| 5 | Support's backend | **No service of its own.** Tools and workflows over the app's own SQLite |
| 6 | A message arriving | **A direct tool call**, not a workflow run |
| 7 | What the rebuild keeps of Support as built | **Nothing: no migration, no backward compatibility.** Support holds only Evan's test messages on prod. Rebuilding it now, before anyone uses it, is what makes that possible |
| 8 | The staff heads-up (`support-chat.md` §6) | **Dropped from the rebuild.** Revisit later (§11) |
| 9 | How a person links their Sphinx account | **Through Peel, the way Peel links to Hive. The daemon has no part.** "We dont need to support old Sphinx apps. Peel is the new way forward", and Peel may gain features for it. Replaces `jamie-in-tribes.md` decision 1, a code DM'd to the daemon (§2.1) |

## Problem

**Every host names people its own way, and strut keeps no name.**

| Host | The actor it sends | The name it keeps | What strut gets |
| --- | --- | --- | --- |
| Hive | `<github login>-<user id>` | name, email, Sphinx pubkey and alias | the actor |
| Stadeum | `<email's local part>-<20 hex>` | name, email, role | the actor and the role |
| Strut's public apps (a worker) | `secp:<x-only key>`, from a signed challenge | none | — |

- The UI shows the text before the first `-` (`web/src/actor.ts`). For a key
  that is the key.
- The staff app shows the first line of the staff's own note, else
  `secp:3fa2…91c` (`whoOf`, `src/apps/staff/src/lib/view.ts`).
- The worker's Sphinx name arrives on every DM. Strut keeps it in Support's
  table (`support_conversations.alias`) and only the Support tab reads it.
- A worker who came by a Share link and never wrote to Support has no name
  anywhere: Peel's `sign_in` answers `{ key, sig, address? }`.

**One Sphinx key is spelled four ways and mapped to a person three times.**

- Spellings: `secp:<64 hex>` (the actor), `<66 hex>` (Support, the daemon),
  `<66 hex>_<lsp>_<scid>` (the address a payout goes to), and `sphinx:<66
  hex>` (the tribes plan's account).
- Mappings: Hive's `User.lightningPubkey`, Support's table, and the tribes
  plan's `linked-accounts.json`. Stadeum has none.
- So a Stadeum admin is `alice-3f9a…` in the browser and `secp:…` in Peel,
  and nothing joins them. The heads-up already works around it: it reaches
  only an admin whose actor happens to be a Support contact's key
  (`support-chat.md` §3).

**The same daemon talks to strut in two opposite ways.**

| | DMs (Support, built) | Tribes (`jamie-in-tribes.md`, planned) |
| --- | --- | --- |
| Who calls | strut polls `GET /dms?after=` every 3 s | the daemon calls strut |
| The person | `secp:` made from the pubkey | `sphinx:<pubkey>` looked up |
| The credential | strut holds a token that reads every DM | the daemon holds a host key |

**Support is an app only at its page.** Its backend is a server module
(`src/support/`, about 1,500 lines: the poller, three tables in the task
store's file, twelve `/support` routes). The eleven `staff/support-*` steps
are one line each over those routes.

## Design in one paragraph

Strut keeps **one small record per person**: their name, and the accounts
they hold on other media. Whoever learns a name writes it there, and every
UI reads it through one function. A **host** (the tribes plan's word: a
program that brings people to strut) gains one more thing it may do: call an
app's **tools** directly, as the person who spoke. The Sphinx daemon uses
that to hand each DM to Support, so strut stops polling. **Support** becomes
what an app is meant to be: its tables in the app's own SQLite, its page
reading them with SQL, six small tools for what touches the outside world,
and one workflow for what is sent without a page. The task store does not
move.

## 1. People

**The store.** `<dataDir>/people.db`, SQLite, with a memory twin for tests.

**Built differently (#737):** no memory twin. Tests, and a strut whose run
store is in memory, open the same store on `:memory:` (`src/people.ts`,
as `src/tasks/db.ts` does): one code path, nothing to keep in step. The
file is made on the first name, never on a read.

| Table | Columns |
| --- | --- |
| `people` | `actor` (the key), `name`, `name_by` (`host` or `self`), `name_at` |
| `accounts` | `kind`, `key` (together the key), `actor`, `address?`, `name?`, `host?`, `at` (§2) |

**Who writes a name.**

| Who says it | How | Kept as |
| --- | --- | --- |
| A host signing a person in | `name` on `POST /auth/ticket { actor, role?, name? }` | `host` |
| A person signing in to a public app | `name` on `POST /visitors/session`. Peel's `sign_in` answer gains `alias` (specs/WALLET.md §1.2) and strut's UI passes it on | `self` |
| A host passing on what someone wrote | `x-strut-account-name` beside `x-strut-account` (§3), percent-encoded | `self`, on the account |

- One line, 80 characters, trimmed.
- A name a host gave is never replaced by one a person gave themself. Among
  those, the newest wins.
- A name is for showing. Nothing checks it, and two people may share one.
- Nothing is copied from Support's table (ruling 7). Until §5 is built, a
  worker's name comes from Peel's sign-in alone.

**Built differently (#737):** an account's name is also written when it is
linked: `POST /hosts/link` takes `name` (and `address`), what the DM that
carried the code says of its sender (`jamie-in-tribes.md` §3). Without it the
fallback below would have nothing to read until item 3 brings
`x-strut-account-name`. Kept on the account as the holder wrote it, the
newest link's first.

**Built differently (#737):** `x-strut-account-name` keeps the name on the
account only when the account is linked: the `accounts` table holds links,
and an account nobody linked has no row. For one nobody linked it is kept
as the name of the key's own actor (a Sphinx key's `secp:`, §2), as `self`,
which is who that account is. Either way it is read where §1 says, and
never replaces a name a host gave. It is read on every host route, not only
on `POST /mcp`; malformed or without `x-strut-account` it is a `400`.

**Who reads one.** `nameOf(actor)`: the person's name, else the name on an
account that is theirs, else nothing.

- `GET /people?actor=…&actor=…` → `{ people: { "<actor>": { name? } } }`, 200
  actors at most, full scope.
- The step `people/names { actors }` for an app's page (the kit's
  `useNames`). A visitor gets their own name alone.
- No other answer changes. Runs, tasks and conversations keep the actor, and
  a page asks for the names of a list once.

**What shows.** The name. With none, what shows today: the text before the
first `-`, or a key shortened. The whole actor stays in the tooltip. In the
staff app the staff's own note still comes first (§8, decision 5).

## 2. Accounts

An **account** is a key on a medium: `sphinx:<66 hex>`, the pubkey as the
daemon and the address spell it. That is the one spelling of an account. The
actor a bare key gets stays `secp:<x-only>`: the ledger, tasks and grants
hold it, and a Nostr or LNURL key gives the same actor.

`actorOf(account)`:

1. linked to a person → that person;
2. else a `sphinx` account → `secp:<the key without its first byte>`, marked
   **unlinked**;
3. else nobody (`403 not_linked`).

**What this changes in `jamie-in-tribes.md`:**

- **One store.** Linked accounts are the `accounts` table, not
  `linked-accounts.json`.
- **Linking is Peel's** (§2.1, ruling 9), not a code DM'd to the daemon.
- **An unlinked key is its own person**, at a visitor's level. A workflow a
  host launches still needs a linked person, so a tribe behaves as that plan
  says. The rule matters only where an app says `unlinked: true` (§3).

**What it replaces:**

- Support's `actorOfPubkey` and its `actor` column.

The address on a worker's session (`Session.sphinxAddress`) stays where it
is. It is proved at sign-in and is what a payout goes to.

### 2.1 Linking Peel to a box

A member links Peel from the page they are already signed in to, and Peel
proves its key by signing. The key is the lasting credential: there is no
device flow and no device record.

1. **The challenge.** In the box's Jamie app, Connect → **Link Peel**. The
   `account/link` step mints a link challenge,
   `strut-link.<base64url { host, actor, name?, nonce, exp }>.<hmac>`.
   - It is signed like strut's other tokens, lasts ten minutes, works once,
     and names the person who asked.
   - Connect shows it as a QR and as an **Open in Peel** link,
     `peel://strut/link?url=<strut's origin>&challenge=<…>`. The scheme is
     Peel's to choose.
   - Connect lists the person's links as it does now, refetching while it
     waits.
2. **Peel signs.** Peel reads `host` and `name` from the challenge and asks
   "Link Peel to `<host>` as `<name>`?". On yes, it signs the challenge's
   bytes as a Lightning signed message with its account key (child 0), as
   its visitor `sign_in` does, and calls `POST /people/link { challenge, key,
   sig, name?, address? }`. The call carries no other credential.
3. **Strut links.**
   - It checks the challenge: its HMAC, `host`, expiry, and that it is
     unused.
   - It checks that `sig` recovers `key`, with the `ln-message` check
     `POST /visitors/session` already uses.
   - It links `sphinx:<key>` to the challenge's `actor` and keeps the name
     and address on the account.
   - A key linked to someone else is a `409`.
   - It answers `{ actor, name?, token, exp }`.
4. **The token.** A person token (`strut-person`, the scope `peer:person`)
   whose claims also name the account. It lasts seven days.
   - On every request strut checks that the account is still linked to
     that actor, so removing the link in Connect ends the token at once.
   - Peel renews it by signing again: `GET /people/challenge` (`host`,
     `nonce`, 60 s), then `POST /people/token { challenge, key, sig }`. A
     linked key gets a new token; an unlinked one gets `403 not_linked`.
5. **Peel keeps the box** beside Hive's link: its URL, actor, name and
   token, with several links allowed and not one. It opens the box's apps
   with the token the way it opens an org's (Bearer on the first load,
   handed to `sessionStorage`), and renews daily.

Afterwards:
- A tribe mention from that key runs as the member (`actorOf`).
- The box's apps open in Peel as the member.
- Ruling 8's heads-up, when it comes back, knows each admin's Sphinx
  account.

**Why not Hive's device flow** (`chained-orchestrators.md` §4). On a box it
would need a pairing table, a polling route, an approve page, a credential
store, a second signature format (Hive's signed timestamp) and a peers
route, all for a single strut. Starting where the member is already signed
in removes the polling and the store, and Peel's key stands in for the
credential. It is built in strut, not Stadeum, so any strut can link Peel
this way: the path off Hive.

**What it replaces from item 2:**
- `POST /hosts/link` and its place among the host key's routes;
- the in-memory `link-` codes;
- the Connect panel's code, the daemon's address and the `hosts` warning;
- the stand-in daemon's linking and its `GET /me`.

`accounts`, `actorOf`, `account/links`, `account/unlink` and
`GET /hosts/links/:key` stay. The daemon still checks a tribe's owner with
that last route (`jamie-in-tribes.md` §4).

## 3. A host calls an app's tools

The tribes plan's host key launches workflows. It gains one more door:
`POST /mcp`, the door every page uses, with the one tool `step_run`.

**The app says which host may call what:**

```yaml
# app.yaml
hosts:
  sphinx:                        # the host key's name (STRUT_HOST_KEYS)
    steps: [support/receive]     # the tools it may call, as this app
    unlinked: true               # an account nobody linked may be the caller
```

- **The call:** `step_run { app: "strut/staff", type, config }`. A host has
  no page, so it names the app by name and gets its active version.
- **Who it runs as:** `actorOf(x-strut-account)`. `ctx.app` is the app.
  `ctx.host` is `{ name, account, unlinked }`.
- **What it can reach:** the shared bag alone. No admin door, no worker's
  calls, no way to send (§4).
- **Who may write `hosts:`:** a person's publish and strut's own seeded
  apps, never a model-written manifest (as `peer: true`).
- **It is synchronous.** The answer is the tool's result, so a `2xx` means
  the tool finished. That is what a host means by "taken".
- **Size:** up to 36 MB for a host, enough for a 25 MiB file as base64.
- **No run is kept** unless the tool asks.

Nothing here is about Sphinx or Support. An email gateway would be
`hosts: { email: { steps: [tickets/receive] } }`.

**Built differently (#737):**

- **The HTTP status says how the step ended.** strut's MCP door answers a
  tool's failure as a `200` with `isError`, so for a host it answers one
  JSON body (never a stream) and sets the status: `200` when the step
  finished, `403` refused, `500` the step failed, `400` a call the tool
  could not take, `413` over the size. That is how "a `2xx` means the tool
  finished" holds (specs/API.md §13.5).
- **A listed step is also held to what no caller of an app's tools does**:
  no paid or shell step, nothing sealed, `run/*` only on `grants.workflows`,
  a graph write only on a declared type, as for a page. `hosts:` replaces
  the page's `grants.steps`, not those checks.
- **A model's publish that names `hosts:` is refused**, as one naming
  `peer:` is. So a builder's new version of a person's app with `hosts:`
  must drop it, and closes the app to those hosts until a person publishes
  one with it again.
- **"Unless the tool asks"** is the usual rule: the door keeps nothing,
  and a step with an active claim keeps its run as it does anywhere.
- **`ctx.host` is the call's alone**: nothing records it, and a run the
  step launches does not carry it.
- **Size:** 36 MiB (`HOST_CALL_BODY_MAX_BYTES`).

## 4. Sending through Sphinx

Strut still holds the message token, to send. It no longer reads with it.

- **One capability**, `sphinx`, beside the payer: `send`, `delete`,
  `setPhoto`, over the daemon's `POST /dm`, `POST /dm/:id/delete` and
  `PUT`/`DELETE /dm/photo`.
- **Whose bag it is on:** a call from a first-party page shown to an admin
  (the bag the staff's door is already on), and a run that page's app
  launched or scheduled. Nowhere else: not the shared bag, not an agent's
  tools, not a host's call.
- **A payout's line** ("Paid you 1,200 sats") is the engine's own: the
  withdrawals' `paid` hook calls the capability. It needs no app.

**Built differently (#737):** (src/payments/sphinx-dm.ts; createStrut
`sendsAsSupport`)

- **"A run that page's app launched" is told by the run's app**: a run
  whose `app` is a `strut/` app at a version strut seeded with `admin:
  true` in its manifest carries `sphinx`, whoever launched it.
  `support-outbox` is started by `support/receive`, the host's call of
  `strut/staff`'s tool, not by the page, so the page's own flags
  (`AppRef.firstParty`, `admin`) cannot be what decides. A resume keeps
  the run's app, and so the capability. `strut/staff` grants no workflow,
  so its page launches nothing itself.
- **The payout line keeps its switch and its label.** The hook reads
  `strut/staff`'s own database (`payout_lines`, and the worker's
  conversation for their pubkey) and keeps the line in the thread as
  `by: "payout"`, as Support as built did. Its id is made from the
  payout's key, so a second call sends nothing.

## 5. Support as an app

Support stays a tab of `strut/staff`.

| Piece | Today | As an app |
| --- | --- | --- |
| The data | Three tables in the task store's file; files under `<dataDir>/support/` | The app's SQLite (`db/001-support.sql`): conversations, messages, files, settings |
| A worker's message | Strut polls the daemon every 3 s | The daemon calls `support/receive` |
| What the page reads | Read steps over the routes; the list and the thread refetched every 3 s | SQL from the page, refetched when the app's channel says something changed |
| What the page writes to its own tables (seen, done, taken, settings) | Routes | SQL from the page |
| A reply, a deletion, Support's picture | Routes | Tools |
| The welcome | The poller's tick | One workflow |
| The heads-up to admins | The poller's tick | None (ruling 8) |

**The tools** (one file each, in `src/steps/lib/support/`):

| Tool | Called by | What it does |
| --- | --- | --- |
| `support/receive { records }` | the host | Keeps a batch of the daemon's DM records, in order, in one transaction: the conversation, the message (a new one, or a change to one: a send's status, a deletion), a file's bytes, the sender's name (§1). Marks a welcome due. Tells the channel. A record already kept changes nothing, so a retry is safe |
| `support/send { worker, text?, replyTo?, file?, retry? }` | the page, the workflow | Keeps the message as `sending`, sends it, keeps `sent` or `failed` |
| `support/send-due` | the workflow | Sends each welcome that is due |
| `support/delete { key }` | the page | Deletes one of Support's own messages for both sides |
| `support/file { id, offset? }` | the page | A file, in 3 MB pieces |
| `support/set-photo` | the page | Support's picture |

**The workflow.** `support-outbox` is one step, `support/send-due`.
`support/receive` starts it when it marked a welcome due, one run at a time.
There is no schedule:

- a run a restart cut off resumes at boot (`STRUT_AUTO_RESUME`, on by
  default);
- a welcome still due goes with the next run.

**The page.** It reads with `sqlite/query`: the list, unread counts, a
thread, search. It listens on the app's channel and refetches on a message,
and every 30 s besides, since a channel keeps nothing. It matches a staff
note against the workers list it already loads.

**Nothing moves** (ruling 7). Strut drops the three old tables from the task
store's file and deletes `<dataDir>/support/`, at boot, with no copy.

**No stand-in.** The poller goes in the same PR. On a box whose daemon does
not push yet, Support receives nothing (§7).

**What goes away:** `src/support/`, the twelve `/support` routes, the eleven
`staff/support-*` steps, both 3 s polls, the heads-up, and reading DMs with
the token.

**Built differently (#737):** (src/steps/lib/support/, src/apps/staff/db/,
src/apps/staff/src/lib/support.ts; specs/API.md §22 "Support")

- **One contact a call.** A host's call runs as the one account
  `x-strut-account` names, so `support/receive { records }` takes ONE
  contact's records (the account's; a record about another contact is
  skipped and named). The stand-in daemon sends one record a call; the
  daemon may batch one contact's consecutive records. So the sender's
  name is the call's `x-strut-account-name` (item 3) and `support/receive`
  writes no name: the list reads names through `people/names`, and search
  matches them in the page.
- **A bad record is skipped, never the call**, and named in the answer
  (`{ kept, skipped }`): a `500` would make the daemon send it forever and
  hold every DM after it.
- **The daemon's `seq` is kept per message**, and an older record never
  undoes a newer one: a push of a send's `failed` can arrive after a Retry
  made it `sending` again, or after the send's own answer.
- **`support/file { key, offset? }`** names the message by strut's key,
  not its Sphinx id: Support's own files are kept too, and have no id
  until the daemon gives one.
- **Retry** also sends one stuck `sending` a minute with no id. Support as
  built marked such sends `failed` when its store opened after a restart;
  nothing opens now, and the daemon sends one id once.
- **The welcome's `since`** is kept by a trigger on `settings`, so the page
  writes only the text. `support/receive` starts the outbox while ANY
  welcome is due, not only one it marked, and `support/send-due` reads
  again until none is, so a welcome that came due as a run ended goes.
- **The page knows its viewer through `:actor`** (`plans/apps.md` §4.4): a
  `sqlite/*` statement naming it gets the caller's actor, which is how
  "Take it" writes and "Mine" reads. It shows the tab when the wallet is a
  Sphinx daemon with its message token (`earnings/read { wallet }`'s
  `messages`) or Support has a conversation.
- **Kept runs** (`sqlite/exec` from a page is kept): they are under the
  `step:sqlite/exec` store key, which no runs list shows, and the page
  writes "seen" only when a conversation has something unread, so it is
  one run per batch read, not per open. Done, taken and settings are rare
  and their run says which admin did it (Support as built kept
  `seen_by`, `savedBy`).
- **Dropped with the follower**: the `earlier` marker on the backlog (it
  was "before Support first followed the daemon"; nothing follows now).
- **The old tables** go when the task store's file is opened, which its
  sweep does at boot; `<dataDir>/support/` is removed at boot without
  holding it up.

## 6. What stays in the engine

**The task store, workers, pay and payouts do not move.**

- The engine depends on them: the `human` step parks a run on the task
  store and is woken by it.
- They hold rules about money: one lease per worker, pay once, holds,
  solvency before a payout. An app's page may run any SQL on its own tables
  because the worst it can do is damage them (`apps.md` §4.4). That cannot
  be true of a store that pays people.
- From a page they are already tools: `strut/staff` calls nothing but
  `step_run`.

The Workers tab gains names (§1) and nothing else.

## 7. What each caller does

Not work in this repo. Each one turns something on. Support is the one that
needs it: once item 5 lands, a worker's message reaches strut only when the
daemon pushes it.

| Caller | What it does | What that turns on |
| --- | --- | --- |
| The Sphinx daemon | In its strut mode (`jamie-in-tribes.md` item 4), also hands strut each record of its DM feed: in order, one call at a time, a file's bytes with it, again until a `2xx`. It keeps how far strut has taken | Support receiving messages |
| Stadeum | Sends `name` on the ticket. Sets `STRUT_HOST_KEYS` and the daemon's strut URL and key | Names for members and admins; the daemon as a host |
| Peel | `sign_in` answers `alias`. Opens a link challenge from its QR or link, asks, signs it and keeps the box's link and token; opens the box's apps with that token and renews it (§2.1) | A name for a worker who never wrote to Support; a member's Sphinx account linked; the box's apps in Peel |
| Hive | Nothing | Its actors show as today |

## 8. Decisions (defaults; Evan may overrule)

| # | Question | Default | Why |
| --- | --- | --- | --- |
| 1 | A Sphinx key nobody linked | Its own person, `secp:…`, at a visitor's level | A worker's DM runs as the worker with no linking step, under the actor the worker app already gave them |
| 2 | How staff read Support | SQL from the page, no read tools | `apps.md` allows it, the app is an admin's, and there is nothing to write or keep in step |
| 3 | Where people are kept | A SQLite file of their own | Workers can number in the thousands and a name changes often: a JSON file written whole fits neither. Not the graph: no schema entries, as the tribes plan chose |
| 4 | Two names for one person | The host's wins | The box's own sign-in knows who its members are |
| 5 | The staff's note | Its first line still shows first in the staff app | Staff typed it on purpose, and nothing has to migrate |
| 6 | How a host names an app | By name, at the active version | A host has no served page to take an app token from |
| 7 | Who sends a reply | Strut calls the daemon | A send's status has to come back. The daemon collecting replies would add a second queue |
| 8 | Where Support's files are kept | Rows in the app's database | No new store for an app's files, and the export carries them. If they grow large, an app's files directory is a later primitive |
| 9 | Support's place | A tab of `strut/staff` | The thread sits beside the worker's work and pay |
| 10 | The welcome | One workflow, started by a message | Auto-resume covers a restart, so nothing needs a clock |
| 11 | Names in other answers | None. The UI asks `people/names` | One read path. No run, task or conversation answer changes shape |
| 12 | How Peel links to a box | The member's signed-in page shows a challenge, and Peel signs it (§2.1). No device flow | The member is already signed in where the challenge appears, and Peel's key proves itself. Nothing to poll, approve elsewhere or store |
| 13 | Peel's credential for a box | A seven-day person token that names the account, renewed by signing | The key is what lasts. A token tied to the link ends the moment the link is removed |
| 14 | How a tribe is linked | Unchanged: its owner DMs the tribe's link to the account (`jamie-in-tribes.md` §4), from Peel | The DM proves ownership, and the daemon, which must join, is the one that sees it. Through Peel's token instead, as Hive does, strut would need a new way to tell the daemon to join |

## 9. Security

| Who or what | What it can do |
| --- | --- |
| A name | Nothing. It is shown, never checked. The staff app keeps the short key beside a name |
| A host key | Call the tools an app names for it, as the account it names. A stolen one can put false messages into Support. It cannot send, read a secret or reach the task store |
| An unlinked key | Reach only a tool whose app says `unlinked: true` |
| A link challenge | Link one key to the person whose session minted it, within ten minutes, once. Only that person's own session mints one naming them, and only the key's holder can sign it. Peel shows the box and the name before it signs, so nobody can get your key linked to their account without you seeing it |
| Peel's token for a box | Act as the member, as any person token does, until it expires or the link is removed |
| The message token | Send as Support. Strut no longer reads DMs with it. The capability is on fewer bags than a secret would be (§4) |
| An admin's page | Read every column of Support's tables, who replied included. `support-chat.md` ruling 4 holds in what the page shows |

## 10. Work items

The items land together on #737, against `main` (Evan, 2026-11-18), never
stacked.

| Item | What | Needs | State |
| --- | --- | --- | --- |
| 1 | **People: names** (§1). `people.db` and its memory twin, `nameOf`, `name` on the ticket and on a visitor's sign-in, `GET /people`, `people/names`, the kit's `useNames`. Names in strut's UI and in `strut/staff` (the Workers tab first). `specs/API.md`, `specs/WALLET.md`, `docs/security.md` | — | **Built (#737).** No memory twin (§1) |
| 2 | **Host keys and accounts** (§2): `jamie-in-tribes.md` item 1, with the accounts in `people.db` and the unlinked rule. One PR builds this row and that one | 1 | **Built (#737).** `accounts` in `people.db`, `actorOf`, the name on an account (§1); the rest as `jamie-in-tribes.md` item 1 says, with its own marks |
| 3 | **A host calls an app's tools** (§3): `hosts:` in `app.yaml`, the host's door on `POST /mcp`, `ctx.host`, `x-strut-account-name`. `specs/API.md`, `docs/apps.md`, `docs/security.md` | 2 | **Built (#737).** The status says how the step ended, the page's call-time refusals still hold, a model's `hosts:` is refused (§3); an unlinked account's name is its key's actor's (§1) |
| 4 | **An app's own SQLite**: `apps.md` item 3 as written, and a seeded app's migrations applied at boot | — | **Built (#737).** As `apps.md` §4.4 marks: no job's app half (job apps are retired), the build tries the migrations, a preview applies them, the kit's `useSql`. A seeded app's `db/*.sql` are applied at every boot, from its live version's directory, once the seeds are in. For item 5: `strut/staff` grants `sqlite: true` and ships `db/001-support.sql`; `support/receive`, called by the host with `ctx.app` set, opens the file with `ctx.services.appDb.open(ctx.app.name)` and keeps a batch in one transaction (`runBatch`, or its own `BEGIN`…`COMMIT` on that connection, never across an `await`) |
| 5 | **Support as an app** (§4, §5): the `sphinx` capability, the six tools, the app's schema (`db/001-support.sql`), the page on SQL and the channel, `support-outbox`. `src/support/` (the poller and the heads-up with it), its routes and tables, and the `staff/support-*` steps go, with no copy (ruling 7). `docs/tasks.md`, `specs/API.md`, `specs/LIGHTNING.md` | 3, 4 | **Built (#737).** One contact's records a call, a bad record skipped, the daemon's `seq` kept, `support/file` by key, the page's viewer as `:actor`, "seen" only when unread (§5); `sphinx` on a run by its app (§4). The stand-in daemon pushes |

| 6 | **Peel links to a box** (§2.1, ruling 9): `account/link` minting the link challenge; `POST /people/link`, `GET /people/challenge` and `POST /people/token`; person tokens that name an account, checked against the link on every request; Connect's QR and Open in Peel. `POST /hosts/link`, the `link-` codes, Connect's code and daemon address, and the stand-in daemon's linking and `GET /me` go. `specs/API.md`, `docs/security.md`, `docs/apps.md` | 2 | — |

`scripts/fake-sphinx-daemon.ts` gains the push, so item 5 is tested before
the daemon's side has merged. Peel's side of item 6 (§7) is Peel's own PR.

## 11. Later

- **The staff heads-up** (ruling 8): a DM to admins when a worker's message
  waits unread. `support-chat.md` §6 has how it works today. Linking (§2)
  gives it what it lacked: an admin's own Sphinx account.
- **A name set by an admin** in the staff app, in place of the note's first
  line.
- **A worker's picture**: the daemon keeps the newest photo URL per contact
  (`support-chat.md` ruling 13); it would ride the same record as the name.
- **A generic `sphinx/dm-send` tool**, when a second app needs to send.
- **Jamie answers a worker first**, with staff as the escalation: a
  workflow `support/receive` launches. A choice about how workers are
  treated, not about plumbing.
- **A host other than a key holder naming people** (`x-strut-actor` beside
  the deployment key): a name header there, if a host needs it.
