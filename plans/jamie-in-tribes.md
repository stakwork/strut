# Jamie in tribes: the Sphinx daemon as a strut host

> **Status (2026-11-20): items 1 (host keys and linked accounts) and 2
> (`delivered` on a wake turn's `run.end`) built on #737, item 1 with
> `people-and-hosts.md` §2's accounts; items 3 (two names) and 4 (the
> strut host mode) built on stakwork/sphinx#439 and stakwork/sphinx#440.
> Decision 1 is overruled (2026-11-18): a person links through Peel,
> `people-and-hosts.md` §2.1. Decision 2 is overruled twice on 2026-11-20:
> first no owner check, then no DM at all. A tribe is linked with one tap
> in Peel, as with Hive: a **linked place** in strut (§4, §5.4), which the
> daemon follows. So item 4 changes its linking before it merges, and
> items 6 (strut's places) and 7 (Peel's row for a box) are new. Item 5
> (Stadeum) waits for them.**
>
> - **Written against:** strut `main` @53364a3d, stakwork/sphinx `master`
>   @f5baba75, stakwork/hive `master` @64260e485 (what is built today),
>   stakwork/stadeum `main` @89d65ed.
> - **The Rulings** are Evan's, from one conversation on 2026-11-17.
> - **The decisions in §9** are this plan's defaults. Evan may overrule them.
> - **Companion to:**
>   - hive `docs/plans/jamie-in-tribes.md`: how `@jamie` works today, with
>     Hive as the host. Every behavior below that says "as today" is there;
>   - `org-home-swarm.md` §4.2: "Jamie per home". This plan is how a home
>     (a Stadeum box) gets it;
>   - `support-chat.md`: the same account's DMs, named "Support";
>   - `specs/LIGHTNING.md`: what strut expects of the treasury daemon.
>
> **Keeping this plan current.** Each PR that builds an item edits this file:
> its row in §10 says it is built and names the PR. Wherever a section says
> something other than what was built, the PR marks it **Built differently
> (#N):**, with what was built and why.

## Rulings (2026-11-17)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | Which Sphinx account answers in a Stadeum's tribes | **The treasury**, the box's one daemon. It is "Support" in 1:1 chats and "Jamie" in tribes |
| 2 | Where the tribes service lives | **Strut**, not stadeum-ui |
| 3 | Bespoke `/tribes/*` routes in strut | **No.** Strut is generic. The daemon uses strut's existing workflow and run APIs |
| 4 | Who calls whom | **The daemon calls strut** (a webhook, in effect), not strut polling the daemon |
| 5 | Who the host is | **The daemon.** Not stadeum-ui, not a strut module |
| 6 | Spending on tribes | **A cap**: a daily budget the daemon spends in tribes (§7, §9 decision 6) |
| 7 | A `run.end` that never reaches the daemon | **The daemon recovers it** from the conversation (§6.2) |
| 8 | Whether a host's turn is an admin's | **Never.** It proposes nothing only an admin accepts, and its decision accepts none (§5.1) |
| 9 | Answering a tribe conversation from the Jamie app | **No: read-only there.** Continue here forks it into the person's own conversation (§5.1, "Host sessions") |

## Problem

`@jamie` in a Sphinx tribe works today because Hive is the host. One central
Jamie daemon sits in every linked tribe of every org. It hands each mention
to Hive (`POST /api/tribes/messages`). Hive finds the org, the person and
the thread, launches the org's orchestrator, and puts the reply in an outbox
the daemon long-polls (hive `docs/plans/jamie-in-tribes.md`).

A Stadeum box has no Hive. Its treasury is a daemon on an account of its
own, but it runs with `DAEMON_REPLY=none`: it answers no mention and joins
no tribe (stadeum `docs/stack-spec.md`, "treasury"). Hive's tribes service is
about 1,500 lines (`org-home-swarm.md` §4.2). Porting it to strut or to
stadeum-ui would rebuild Hive in the middle.

Most of those 1,500 lines are now strut's own: conversations, the wake, a
job's deliverables, proposals (`jamie-app.md` §1, §2). The rest (threads,
busy, folding, the outbox) is about the tribe, and the daemon already does
most of it.

## Design in one paragraph

The treasury daemon becomes a **host** of strut, as Hive was, as
sphinx-voice is for calls. A host knows who is speaking and where. It
launches each turn through strut's ordinary API, as that person, and carries
the answer back. A mention becomes `POST /workflows/orchestrator/run` with a
session, `wake: true` and a `callback` pointing at the daemon; the reply,
and every later wake reply, arrives on that callback and is posted in the
tribe. Strut gains no tribe code. It gains four generic things any host
could use (a Slack bot, an email gateway): a **host key** narrower than the
deployment key, **linked accounts** (a key on a medium, bound to a person:
*who*), **linked places** (a spot on a medium a person asks a host to
answer in: *where*), and the job's deliverables on a wake turn's
`run.end`. The daemon gains a second way to be a service's client,
`strut`, beside Hive's.

## 1. What a host is

A program that brings people to strut. Strut has no accounts and no chat
surface of its own beyond its web UI. A host:

1. **Knows who.** It tells strut whom a request is for.
2. **Owns the place.** It tells strut what the place is like, in
   `context.line` ("on a call, keep it short").
3. **Launches turns** on a conversation, with `wake: true` and a `callback`.
4. **Carries the answer back** to where the person is.

Hive (web chat, tribes, calls), stadeum-ui (sign-in) and sphinx-voice (calls)
are hosts today. Peel and mcp's lab embed strut with `createStrut()`: a
host of the other kind, in-process. The daemon is the first kind.

## 2. A mention, end to end

The daemon already turns a tribe message into a mention (`wasm/daemon`
README, "The service"): `id`, `tribe`, `alias`, `owner`, `sender` (when the
owner marked the account to see senders), `text`, `recent`, `thread`,
`replyTo`, `earlier` (a burst folded while a turn ran), `attachments`. What
it does with one changes:

1. **Who.** The speaker's key (`sender`) if strut knows it as a person's
   (§3); else the tribe's **linker**, the person who linked it (§4).
2. **Which conversation.** The mention's `thread`, when it names one; else a
   new one. The thread key IS the strut session id: `host/<name>/<12 hex>`
   (§5.1). The daemon already keeps a post's thread across restarts, and
   keeps the id it minted for a mention with the mention, so a retry
   continues the same conversation.
3. **Busy.** The daemon marks a session busy from its launch until that
   run's `run.end`. A mention to a busy session is held and folded, as
   today. A turn that fails `session_busy:` (a wake turn held the session)
   is the same: held, offered again at the session's next `run.end` (the
   wake turn's comes to the same callback, §6). A `run.end` that never
   comes does not leave the session busy (§6.2).
4. **Launch.** As the person, with the host key (§5.1):

   ```json
   POST /workflows/orchestrator/run
   Authorization: Bearer <the host key's token>
   x-strut-account: sphinx:<66 hex>
   {
     "input": {
       "prompt": "Alice: @jamie what did we decide about the launch?",
       "session": "host/sphinx/3f9a0c21b7e4",
       "context": { "line": "…", "where": "…" }
     },
     "wake": true,
     "callback": { "url": "http://treasury:8095/strut/end?m=<mention id>&token=…" },
     "attachments": [{ "name": "recent.txt", "data": "…" }, { "name": "image.jpg", "mediaType": "image/jpeg", "data": "…" }]
   }
   ```

   - `prompt`: `"<alias>: <text>"`, one line per message of a burst, the
     newest last, as Hive writes it.
   - `context.line`: the tribe line Hive writes today (hive#5681): the
     tribe, who asked and whom the turn runs as, that the reply is posted
     where not everyone is in this org, and that it is read on a phone, so
     short, with what matters first. `context.where`: the same place,
     without who asked, for the wake (`CALLBACKS.md` §9).
   - `recent` as a text attachment, as Hive does. The daemon's attachments
     are already strut's shape (`{ name, mediaType, data }`); one it could
     not open (`error`) is named in the prompt, as Hive names it.
5. **Taken.** A `202` is `taken`. A `5xx` or no answer is a retry; any other
   `4xx` is refused and dropped, with one line in the tribe when it is the
   linker's access that is gone.

   **Built differently (stakwork/sphinx#440):** a `429` is a retry too, as
   the daemon's Hive mode takes one. The room goes as `recent.txt` beside
   at most nine files (strut's ten). A turn strut has no record of, ten
   minutes after its `202`, frees its conversation (§6.2).

## 3. Who a turn runs as

As today (hive#5688): the speaker, when the tribe names them and they are a
person here; otherwise the linker. A burst runs as its newest message's
speaker.

**Linked accounts** (strut, generic). A person binds an account on a medium
to themselves: `sphinx:<pubkey>` → their actor. Strut keeps the binding. A
host names the speaker by the account (`x-strut-account`), and strut runs the
request as the bound person. An account nobody bound is a `403`
(`not_linked`): the daemon falls back to the linker.

**Replaced (2026-11-18).** Evan overruled decision 1 ("Peel is the new way
forward"). A person links through Peel: the box's Connect panel shows a
challenge, and Peel signs it (`people-and-hosts.md` §2.1, ruling 9). The
daemon has no part. What follows is the DM flow as #737 built it first.
`people-and-hosts.md` item 6 removed it on #737: `POST /hosts/link`, the
`link-` codes, `account/link-code`, Connect's code and the daemon's `GET
/me` are gone, here and in §5.1 and §5.2. `GET /hosts/links/:key` stayed
for §4's DM; with linked places nothing calls it, and item 6 removes it.

**How a person links their Sphinx account** (proposed, §9 decision 1). In
the Jamie app, **Connect Sphinx** shows a one-time code and the account's
Sphinx address as a QR. The person sends the code to that account by DM,
from any Sphinx app. The DM is signed by their account, so the daemon knows
the key. The daemon hands the code and the key to strut
(`POST /hosts/link { code, key }`), and answers the DM: "Linked to your
account on <box>." The host vouches for the key, as it already vouches for
who spoke in a tribe.

- The code: short, single use, ten minutes, bound to the person who asked.
- The Jamie app lists the person's linked accounts and removes one.

**Built differently (#737):** `POST /hosts/link { code, key, name?,
address? }`: the daemon also passes the sender's alias (the account's own
name, which strut shows for a person with none of their own,
`people-and-hosts.md` §1) and their address. The code is `link-` and eight
letters and digits, so the daemon tells it from a Support message; a new one
replaces the person's last. `GET /hosts/links/:key` answers the link
(`{ account, actor, name?, … }`) or `404 not_linked:`.
- A Peel sign-in (strut's `ln-message` verifier, which already checks a
  Sphinx signature) could bind a key with no DM. It needs Peel to open the
  box, which nothing does yet (`org-home-swarm.md` §1.2).

## 4. Linking a tribe

**One tap in Peel, as with Hive** (Evan, 2026-11-20; §9 decision 2). A
tribe's owner opens the tribe's details in Peel and turns Jamie on for
their box. Nobody types or pastes anything.

1. **The row.** Peel's tribe details have a Jamie row today, shown to the
   tribe's owner, listing the Hive orgs Peel is paired with
   (stakwork/peel#456). It also lists each box Peel is linked to
   (`people-and-hosts.md` §2.1, stakwork/peel#574) whose strut has a Sphinx
   host ready (`GET /people/places`, §5.4).
2. **On.** Peel calls the box's strut with the person token it holds there:
   `POST /people/places { host: "sphinx", key: <the tribe's pubkey>, link:
   <the tribe's link>, name: <the tribe's name> }`. The tribe is now a
   **linked place**, and the person is its **linker**. Strut answers with
   the host's `account`: the box's own Sphinx key.
3. **The join.** Strut nudges the daemon, which reads its places and joins
   the tribe, or asks to join a private one (§5.4, §7).
4. **The approval.** Peel approves that member request itself, by the
   `account` it was given, as it approves Hive's Jamie today.

**Off** is `DELETE /people/places/sphinx/<key>`: the daemon leaves the
tribe. When the owner removes the account from the tribe in Sphinx, the
daemon deletes the place (`DELETE /hosts/places/:key`), and Peel's row reads
off.

**Who may link.** Any person linked to the box. Strut checks nothing about
the tribe's owner: a turn as the linker has only the linker's own access,
never an admin's (ruling 8), the daily budget caps spending (§7), and a
private tribe's owner approves the join. Peel offers the row to the owner,
as it does for Hive. A tribe stays its linker's: another person's link is
`409 place_linked:`.

**Why through strut.** The daemon is the host, so it keeps the tribes it is
in. But a person cannot reach it: it has no published port, and nothing but
strut calls it (§8). Peel already reaches the box's strut as the person. So
strut keeps the list, generic as linked accounts are, and the daemon
follows it. Strut still has no tribe code: a place is a host's name, a key,
a link and a linker.

**Replaced (2026-11-20).** The plan first had the owner DM the tribe's link
to the account, and the daemon check the owner by the tribe's record. Evan
then ruled out the owner check (the record carries `owner_alias` alone,
never the owner's key, and the check guarded nothing above), and
stakwork/sphinx#440 built the DM with any linked person as the linker,
`leave <link>`, and the first linker kept in `strut.json`. Then Evan asked
for Hive's one tap. A person pasting a link into Support's chat is no UX,
and the DMs landed in the staff's inbox (decision 10). #440's DM handling
is replaced by places before it merges (item 4).

The tribe names who spoke only once the owner marks the account to see
senders (`ShowSenders`, sphinx `docs/tribe-sender-identity.md`). Until then
every turn runs as the linker. sphinx-chat's `show-senders` does it today;
a Peel button is later (§11).

## 5. What strut gains (generic)

### 5.1 Host keys

Today only the deployment key launches a conversation turn with `wake` and
`conversation` and runs it as any person; a peer's or a person token's
launch is a relay, never woken (`CALLBACKS.md` §9). A host that reads
messages from strangers and holds money should not hold the deployment key.

A **host key** (proposed config: `STRUT_HOST_KEYS="sphinx:<token>"`, a name
and a token per host; the name is also the kind of account it vouches for):

- **Acts only as a linked person.** The host's token rides as
  `Authorization: Bearer`, as every key does. Every request that acts as
  someone names an account of the host's kind in `x-strut-account`
  (`sphinx:<66 hex>`); strut resolves it to the bound person.
  Unbound: `403 not_linked`. No `x-strut-actor`.
- **Never an admin** (ruling 8). Strut knows a person's role only from a
  session someone signed in with (`plans/member-rights.md`). A host only
  vouches for who spoke, and until a tribe shows senders every speaker
  there runs as the linker, who may be an admin. So:
  - a turn whose `run.start` says `origin: "host"` is known not to be an
    admin's: `personIsAdmin` (`createStrut.ts`) answers false for it, as
    it does for `origin: "peer"`, and so for the jobs and wakes it starts.
    A step only an admin accepts (`approver: "admin"`: installing a
    package) proposes nothing there and fails with `admin_required:`, and
    Jamie answers in the tribe that an admin does that in the Jamie app;
  - a decision made with the host key is not an admin's (its scope is not
    `full`): it accepts no proposal only an admin may accept.

  Everything else a member may ask Jamie for works in a tribe as in the
  app.
- **May:** launch a conversation workflow (one with `params.wake`) on a
  session under its own namespace, `host/<name>/…`, with `wake`,
  `callback` and `attachments`; read those conversations
  (`GET /conversations/item?id=`); decide a proposal made in one of them, as the
  person (`POST /proposals/:id/decide`); say who and where it is
  (`PUT /hosts/me`), and read and delete its places (`GET /hosts/places`,
  `DELETE /hosts/places/:key`, §5.4).
- **May not:** anything else. No workflow reads, no publishing, no secrets,
  no other session.
- **Its runs are not relays:** strut wakes them. `run.start` records
  `origin: "host"` and `host: "<name>"`.

**Host sessions.** A conversation under `host/<name>/` is listed for each
person who took a turn in it, as any conversation is (`API.md` §9.1), so
tribe conversations appear in the Jamie app (`org-home-swarm.md`, "Tribe
conversations"). Several speakers share one, because the host, not a
person, opened it.

**Only its host takes a turn in it** (ruling 9). Today a person may continue
any conversation they took a turn in. Here that would split the thread: a
turn from the Jamie app is answered in the app alone, and since the app's
launch sets no callback, the wake still uses the latest tribe turn's
(`wake.ts` `anchorOf`), so the reply about a job asked for in the app is
posted in the tribe. So:

- `continuesFor` (`createStrut.ts`) refuses an id under `host/<name>/` to
  anyone but host `<name>`'s key: `conversation_hosted:` (a `403`, or the
  step's error from the app's `run/launch`). The check on a job turn's
  `conversation` does the same. The deployment key still launches on any
  id, as now.
- `ConversationListItem` gains `host?: string`, the `<name>` of the id.
- The Jamie app shows such a conversation without a message box: a line
  ("In a Sphinx tribe: reply there") and **Continue here**, which forks it
  (`conversation/fork`, built): a new conversation under the person's own
  id, its turns copied so Jamie remembers them, listed for them alone. Jobs
  started in the tribe still wake the tribe's conversation.

Posting an app turn in the tribe was rejected: members would see Jamie
answer a message nobody posted there.

### 5.2 Linked accounts

The store: `{ kind, key, actor, host, at }`, one person per account. It is
one JSON file under `dataDir` (`linked-accounts.json`), read into memory at
boot and written whole on each change (temporary file, then rename), as the
wake queue's files are: a link is rare, and every host request reads it.
It is not on the workspace graph, so it needs no schema entries.

**Built differently (#737):** as `people-and-hosts.md` §2 has it, the store
is the `accounts` table in `<dataDir>/people.db` (`src/people.ts`), beside
the names: `kind, key, actor, address?, name?, host?, at`. A Sphinx key
nobody linked is `secp:<x-only>` there, marked unlinked; a host's launch or
decision still needs a linked person (`403 not_linked`). A code
lives in memory only: a restart drops one still waiting, and the person
asks for another. What reaches the store:

- steps for apps: `account/link-code` (a code for the viewer),
  `account/links`, `account/unlink`. The Jamie app's Connect panel calls
  them. As `conversation/*` are, they are refused to every app's page but
  strut's own (first-party), so a public app's visitor links nothing;

  **Built differently (#737):** narrower, as `secret/add` is: only as a
  first-party page's OWN call, for its viewer, never an agent's tool. A
  code is worth the person it was made for, and in a tribe that does not
  show its senders every turn runs as the linker: a Jamie that could mint
  one would let any member link their key as the linker. `account/link-code`
  answers `{ code, expiresAt, hosts, to? }`: `hosts`, the hosts with a key
  here (none: the panel says linking is not set up), and `to`, the account
  to DM with its address as a QR;
- the host's two routes above.

The Connect panel shows the account's Sphinx address, which strut reads
from the daemon's `GET /me`. The message token Support already holds opens
it, answering `{ address, pubkey, alias }` alone; the balance and the LSP
stay the admin token's (§9 decision 8).

### 5.3 A wake turn's deliverables on its `run.end`

A wake turn's own run holds none of the job's work, so its `run.end` has
the reply and no files. Hive had to add them itself (hive#5669,
`withJobDeliverables`). Strut already reads them for its conversation index
(`delivered`, `API.md` §9.1). The wake turn's `run.end` carries the same
`delivered`. Every host gets it.

### 5.4 Linked places

A linked account says *who*. A **linked place** says *where*: a spot on a
medium (a tribe, a Slack channel, a mailing list) where a person asks a
host to answer, as them. Strut keeps the list, and the host joins and
leaves to match it. To strut a place is opaque: a host's name, a key, a
link the host knows how to join, and the person who linked it.

**The store**, in `<dataDir>/people.db` beside `accounts`:

- `places`: `host, key, link, name?, account, at`, one row per
  `(host, key)`. `account` is the linker's linked account
  (`sphinx:<66 hex>`), the one their person token names (`API.md` §13.6).
  A host deals in accounts, never actors: it launches a turn as the
  linker with `x-strut-account`, and DMs the linker at that key (§7's
  budget). A place goes with its account: unlinking the account
  (`account/unlink`) deletes the places it linked.
- `hosts`: `name, account, hook, at`, what each host said of itself.

```ts
interface Place {
  host: string;     // the host's name: "sphinx"
  key: string;      // the place on the medium: a tribe's pubkey
  link: string;     // how the host joins it: the tribe's link
  name?: string;    // what the person saw it called
  account: string;  // the linker: "sphinx:<66 hex>"
  at: number;       // when it was linked (ms)
}
```

**A person's routes**, with the person token Peel holds for a box:

- `GET /people/places` → `{ hosts: [{ host, account }], places: Place[] }`:
  the hosts ready to take a place (a host key here, and the host has said
  who it is), and the person's own places.
- `POST /people/places { host, key, link, name? }` → `200 { place,
  account }`, `account` being the host's own. The same person again
  refreshes `link` and `name`. Another person's place is `409
  place_linked:`. A host that isn't ready is `404 no_host:`. Strut only
  bounds the strings; the host refuses a link it can't join (below).
- `DELETE /people/places/:host/:key` → `{ removed }`, the person's own.

**A host's routes**, with its host key (§5.1):

- `PUT /hosts/me { account, hook }`: its own account on its medium (the
  box's Sphinx key, which strut hands Peel), and where strut tells it that
  its places changed. The daemon sends it at every start.
- `GET /hosts/places` → `{ places: Place[] }`: its places, every linker's.
- `DELETE /hosts/places/:key` → `{ removed }`: a place it no longer
  answers in (removed from the tribe, or a link it couldn't join).

**The nudge.** On every change to a host's places (a link, a removal, an
account's unlink), strut POSTs `{ event: "places" }` to the host's `hook`,
as it posts a callback (`postCallback`: retried briefly, then dropped). It
names no place. The host reads `GET /hosts/places` and makes what it is in
match. A lost nudge costs a delay, never a place: the host also reads the
list at start and every 10 minutes (§7).

**Other hosts.** A Slack host could keep its channels in the same table,
but it would write them itself: adding a bot to a channel is Slack's own
`/invite`, and Slack's join event names who invited it. That needs a
host's route to add a place, which nothing here needs yet.

**Built differently (#787):**
- `GET /hosts/places` gives each place `linkerName`, the linker's name as
  strut shows it (`API.md` §13.3). The daemon needs it for its lines and a
  turn's `context.line`, since a linker who linked through Peel is seldom
  among the account's contacts (stakwork/sphinx#440).
- The linker's account must be of the host's kind (a `sphinx` place, a
  `sphinx` account): it is what the host launches a turn as.
- `GET /people/places` names the one host ready for the token's kind of
  account. A token naming no account (`POST /peers/tokens`'s) is `403`.
- A refresh nudges the host only when the link or the linker's account
  changed; a new name alone does not.
- `PUT /hosts/me` answers `{ name, account, at }`, never the hook, which
  carries the host's own token.

## 6. The reply

The callback's `run.end` (`CALLBACKS.md` §2):

- **`output.text`** is posted in the tribe, threaded under the mention the
  callback names (`m=`), as today. Exactly `[silent]` posts nothing. A long
  one is chunked as today.
- **A failed turn** posts one line ("I couldn't finish that: …"), as today;
  a `session_busy:` failure is held instead (§2).
- **Deliverables** (`artifacts`, and `delivered` on a wake): a link line for
  each that has an address of its own (a pull request). Everything else is
  one line, a link to the conversation in the Jamie app, for members of the
  box. `metadata.strut` carries references only, at most 2 KB, as today, so
  Peel can draw cards once it opens a box (§11).
- **A wake reply** comes to the callback of the conversation's latest
  turn that has one, whoever took it (`CALLBACKS.md` §9, `src/wake.ts`
  `anchorOf`), so it threads under that turn's mention. Hive threads it
  under the mention that started the job; the two differ only when a newer
  mention came in between.

**Built differently (stakwork/sphinx#440):** the link into the Jamie app
needs the box's address, which the daemon learns from `DAEMON_JAMIE_URL`
(the Jamie app's page, `https://box/`); it adds `?input=session=<id>` as
the kit's `shareLink` does. Without it, the line names the files with no
link. The reply's text and its deliverable lines go as one post, so the
budget's whole-or-nothing covers them together (§7); each proposal is a
post of its own. A job's own `run.end` (it carries the turn's callback)
posts nothing when its `wake` is `"launched"`, and its words otherwise.
`metadata.strut` is `{ conversation, run, artifacts? }` on a reply and
`{ conversation, proposals }` on a proposal's post.

### 6.1 A proposal

As today (hive plan, "A proposal"), with the daemon doing what Hive did:

- `run.end`'s `proposals` (pending) are posted as "Waiting for <alias> to
  approve: <title>", with a stub in `metadata.strut.proposals`.
- A reply to that post with an accept or reject word decides it, when its
  speaker is the person the turn ran as: `POST /proposals/:id/decide` as
  them. On a turn that ran as the linker, the tribe's owner decides (the
  owner is the linker). The outcome is posted in the thread. Anyone else
  gets "<alias>'s to decide." Any other reply is a turn.
- None waits on an admin: a host's turn proposes nothing only an admin
  accepts (§5.1, "Never an admin").
- A decision made in the Jamie app is not announced in the tribe (§11).

**Built differently (stakwork/sphinx#440):** with no owner check (§4),
the linker need not be the owner, and in a tribe that does NOT show senders
the daemon can't tell the linker's reply from anyone else's: only the
owner's posts are marked. There the post says the proposal waits for the
linker in the Jamie app (`Waiting for <linker> to approve in the Jamie app:
<title>`), and an accept or reject reply in the tribe decides nothing (it is
answered `<linker> approves this in the Jamie app.`). In a tribe that shows
senders (`SentBy`), deciding by reply works as above: the person the turn
ran as decides, by the key the tribe names, whoever the turn ran as. An
accept or reject word counts only as the whole reply, an `@mention` aside (`yes`, `ok`,
`approve`, `go ahead`, `👍`; `no`, `reject`, `cancel`, `👎` …): "yes, but
change the title" is a turn. A reply folded with others that waited is a
turn too.

### 6.2 A `run.end` that never comes

The callback is not the only way a turn's end reaches the daemon. Strut
retries a callback for about half a minute, and loses one that is in flight
when strut restarts (`CALLBACKS.md`, "Good to know"). The daemon may also
be down when one comes, during a redeploy. Otherwise the session would
stay busy for ever, and a wake reply sent then would never be posted.

- **What the daemon keeps.** For each conversation, the last turn it
  handled (the `turn` number of `GET /conversations/item`), and for each
  turn it launched, the `runId` from its `202` and the mention it answers.
- **When it reads.** A turn it launched that has no `run.end` after 10
  minutes, and again every 10 minutes while the turn still runs. At its
  start, every conversation it handled a turn in during the last 7 days.
- **What it reads.** `GET /conversations/item?id=<session>`, which the
  host key may read (§5.1). Every turn after the last one handled that has
  ended (`success`, `error`, `cancelled`, or `stale`, which counts as
  failed) is handled as its callback would have been, oldest first: `text`
  (`[silent]` posts nothing), `error`, `artifacts` and `delivered`,
  `proposals`. A turn the daemon launched threads under its own mention. A
  wake turn threads under the mention of the latest turn the daemon
  launched before it, as its callback would have. Then the session is free.
- **A late callback** for a turn already handled is dropped. Each post is
  done once, by `runId`, whichever way it came.

## 7. What the daemon gains

In stakwork/sphinx `wasm/daemon`. The daemon's `Service` interface
(`src/service.ts`: `mention`, `outbox`, `ack`, `log`, `left`) already
separates the tribe from the service. Strut is a second implementation
beside `HttpService` (Hive):

| `Service` | `HttpService` (Hive) | `StrutService` |
| --- | --- | --- |
| `mention` | `POST <url>/messages` | §2: resolve who, launch the turn, mark the session busy |
| `outbox` | `GET <url>/outbox?wait=` | the daemon's own queue, filled by callbacks (§6), conversation reads (§6.2) and its places (§4) |
| `ack` | `POST <url>/outbox/ack` | local |
| `log` | `POST <url>/log` | off (§11) |
| `left` | `POST <url>/left` | deletes the place (`DELETE /hosts/places/:key`) |

And:

- **`DAEMON_REPLY=strut`**, with `DAEMON_STRUT_URL`, `DAEMON_STRUT_KEY` (the
  host key) and `DAEMON_CALLBACK_URL` (how strut reaches the daemon).
- **The callback route**, `POST /strut/end`, opened by a callback token of
  its own and nothing else.
- **Its places** (§4, §5.4). At every start it tells strut who and where
  it is: `PUT /hosts/me { account, hook }`, the hook being `POST
  /strut/places` under `DAEMON_CALLBACK_URL`, opened by the callback
  token as `/strut/end` is. It reads `GET /hosts/places` at start, on each
  nudge and every 10 minutes, and makes its tribes match:
  - it joins each place it isn't in, or asks to join a private one (a
    request still waiting isn't sent again);
  - it leaves each tribe it joined for a place that is gone;
  - a link it can't join, it deletes (`DELETE /hosts/places/:key`).

  The linker of each tribe is the place's `account`. The daemon acts on
  no DM: every DM is Support's, as now.

  **Built differently (stakwork/sphinx#440):**
  - `PUT /hosts/me` is tried again each minute until strut answers.
  - The nudge is answered `200` at once, and the reconcile follows. A
    nudge during a reconcile runs one more after it.
  - "A link it can't join" is any of:
    - a link to another tribe than the place's key;
    - a tribe record its server can't give (sphinx-chat's own refusal);
    - three failed joins in a row;
    - a request the tribe's owner turned down after the daemon asked for
      that place.

    A join over today's budget is not a failure: it is tried again the
    next day, and the linker is told.
  - "A tribe it joined for a place" includes one it was already in when the
    place appeared: it follows that place, and leaves when it goes.
  - What the daemon keeps is strut's list as last read, and the tribes it
    follows places in (`strut.json`).
  - A place carries the linker's key, never their name. So the linker's
    name comes from the account's contacts. A linker who isn't a contact
    is "the person who linked this tribe" in lines and in a turn's
    `context.line`.
  - The budget's DM goes to a linker who is a contact. Otherwise it is
    logged: a DM never pays to meet someone (`POST /dm`'s rule).
- **A daily budget for tribes** (ruling 6), `DAEMON_TRIBE_SATS_PER_DAY`
  (default 1,000): the most the account spends in all tribes together in a
  UTC day, counting join prices and every part of every post. A tribe's
  owner sets its prices, may change them at any time, and is paid what its
  members pay. sphinx-chat pays the price as it is at the send, price plus
  escrow on every part, with no ceiling (`wasm/chat/src/commands.ts`
  "the tribe's own price, as it is now", `amounts.ts` `tribeSats`). So
  without a budget, a linked owner could raise the price and move the
  treasury to themselves, one reply at a time: a 3 KB reply is 11 parts.
  The budget is for all tribes together, not one per tribe, because a new
  tribe costs nothing to make.
  - Before each join or post, the daemon prices it at the tribe's price as
    it is then: the join price, or the price per part times the parts. One
    that would pass the day's budget is not made. A reply is posted whole
    or not at all.
  - It takes no mention in a tribe while the budget left cannot pay one
    part there, so no turn runs whose reply cannot be posted.
  - Whenever it stops something in a tribe, it tells the linker by DM,
    once a day per tribe, that Jamie answers there again after midnight
    UTC.
- **Bigger files.** Its cap of four files and 3 MB was Vercel's body limit
  for Hive. Strut takes ten, 15 MB together (`API.md`, `attachments`).
- **One account, two names.** The core already takes the alias and photo on
  every send (`wasm/src/auto.rs` `send(…, my_alias, my_img, …, is_tribe)`);
  sphinx-chat passes the account's own (`wasm/chat/src/commands.ts`, the
  send and the join). It picks them by kind instead: `DAEMON_TRIBE_ALIAS`
  and a tribe photo for tribes, the account's alias and photo (Support's)
  for DMs. `DAEMON_MENTION=jamie`. The tribe server keeps each member's
  alias per tribe; a contact is renamed only by a DM, and tribe posts
  arrive under the tribe's key, so a worker in a tribe still sees "Support"
  in their contacts.
- **Hive's mode stays** until Hive goes: the central Jamie keeps serving the
  orgs linked through Hive.

**Built differently (stakwork/sphinx#439, stakwork/sphinx#440):**

- The tribe photo is `DAEMON_TRIBE_PHOTO`, a public link to an image; with
  `DAEMON_TRIBE_ALIAS` and no photo, tribe posts carry none. The mention
  follows `DAEMON_TRIBE_ALIAS` unless `DAEMON_MENTION` says otherwise.
  sphinx-chat picks the name by kind in `Session.selfFor`.
- The callback token is `DAEMON_CALLBACK_TOKEN`, made once and kept in
  the account folder like the treasury's other tokens; it rides in the
  callback URL (`?token=`), since strut sets no header on a callback.
- The budget prices through a `spend` hook on sphinx-chat's `sendText`,
  `joinTribe` and `leaveTribe`: the whole price, every part, before
  anything is published. A leave it can't pay is not sent, but the
  account marks the tribe left and stops answering there (the tribe server
  keeps a member that leaves).
- `DAEMON_LOG=on` with `DAEMON_REPLY=strut` is a config error (§9
  decision 7). What the mode keeps is `strut.json` in the account folder;
  a held launch's files live in memory only.

## 8. On a Stadeum box

No stadeum-ui change. In stakwork/stadeum:

- `scripts/init-env.sh` makes the host key, as it makes the treasury's
  three tokens. Strut gets `STRUT_HOST_KEYS=sphinx:<it>`; the treasury gets
  `DAEMON_REPLY=strut`, `DAEMON_STRUT_URL=http://strut:3000`,
  `DAEMON_STRUT_KEY`, `DAEMON_CALLBACK_URL=http://treasury:8095`,
  `DAEMON_TRIBE_ALIAS=Jamie`, `DAEMON_MENTION=jamie`. Since items 3 and 4
  were built: `DAEMON_JAMIE_URL` (the box's address, for the links into
  the Jamie app, §6) and, for Jamie's face in tribes, `DAEMON_TRIBE_PHOTO`.
- `docs/stack-spec.md`, the treasury: "it answers no mention and joins no
  tribe" becomes what it now does, and `AGENTS.md`'s row adds that it calls
  strut. Its rules hold: no published port, and nothing but strut calls it
  (strut's callbacks).
- **Money.** Every tribe charges its join price and its price per message,
  and every reply costs at least 1 sat. That comes from the treasury's
  balance, the money paid runs earn, up to the daily budget (§7, §9
  decision 6). The default needs no line in `.env`; a box that wants
  another sets `DAEMON_TRIBE_SATS_PER_DAY`.

## 9. Decisions (defaults; Evan may overrule)

| # | Question | Default | Why |
| --- | --- | --- | --- |
| 1 | How a person links their Sphinx account | **Overruled (Evan, 2026-11-18):** through Peel, which signs a challenge from the box's Connect panel (`people-and-hosts.md` §2.1, ruling 9). Was: a code sent to the account by DM (§3) | "We dont need to support old Sphinx apps. Peel is the new way forward" |
| 2 | How a tribe is linked | **Overruled (Evan, 2026-11-20):** one tap in Peel, as with Hive: a linked place in strut, which the daemon follows; no owner check (§4, §5.4). Was: the owner DMs the tribe's link to the account; then, briefly, any linked person's DM | Hive's UX: nobody pastes a link into Support's chat. The daemon has no door a person reaches, and Peel already reaches the box's strut. The owner check guarded nothing a linker's turn could reach (ruling 8, the budget), and the tribe record carries no owner key |
| 3 | Whose namespace a tribe conversation is in | The host's, `host/<name>/…` | A thread has several speakers; none of them opened it |
| 4 | A speaker strut doesn't know | Runs as the linker, the line saying so | As today (hive#5688). A public tribe is public (ruled for Hive 2026-10-30) |
| 5 | Deliverables in a tribe | Text, links with their own address, one link into the Jamie app | Peel cannot open a box's files yet |
| 6 | Spending on tribes (ruled: a cap) | One budget for all tribes together, 1,000 sats a UTC day, join prices included (§7). The balance is on Earnings | A tribe's owner sets its prices and is paid them; without a cap a linked owner could drain the treasury. One budget, not one per tribe, because a new tribe costs nothing to make. In a 1-sat tribe, 1,000 sats is 1,000 parts: a short reply is one part, a 3 KB reply 11 |
| 7 | The message log (`DAEMON_LOG`) | Off | Hive's log goes to a placeholder workflow; nothing reads it yet |
| 8 | How strut learns the account's address | **Dropped (2026-11-18).** Only the DM link showed it. Peel's link needs no address, and stakwork/sphinx#438 no longer opens `GET /me` to the message token | — |
| 9 | Where the host key comes from | `STRUT_HOST_KEYS`, from `.env` | The treasury's tokens are wired this way already |
| 10 | The DMs the daemon acts on (a tribe link, `leave`) in Support's inbox | **Dropped (2026-11-20).** The daemon acts on no DM: a tribe is linked in Peel (§4) | — |

## 10. Work items

Each is its own PR against its repo's default branch, never stacked.

| Item | Repo | What | Needs | State |
| --- | --- | --- | --- | --- |
| 1 | strut | **Host keys and linked accounts** (§5.1, §5.2): `STRUT_HOST_KEYS`, the `host` scope and `x-strut-account`, `host/<name>/` sessions (`conversation_hosted:`, `host` on the list item), a host's turn never an admin's, `linked-accounts.json`, `POST /hosts/link`, `GET /hosts/links/:key`, the `account/*` steps, the Jamie app's Connect panel and its read-only tribe conversations with Continue here. `specs/API.md`, `docs/security.md`, `docs/environment.md` | — | **Built (#737)**, with `people-and-hosts.md` item 2: the accounts in `people.db` (§5.2), `name` and `address` on the link (§3), the `account/*` steps a page's own calls (§5.2). `scripts/fake-sphinx-daemon.ts` answers `GET /me` and hands a DM'd code to `POST /hosts/link`. The DM link is replaced by Peel's (`people-and-hosts.md` item 6) |
| 2 | strut | **`delivered` on a wake turn's `run.end`** (§5.3). `specs/CALLBACKS.md` | — | **Built (#737)**, as written: `postRunCallback` reads it with the conversation index's own `deliveredBy` (`conversations.delivered`), so a room gets it too; absent when the job runs delivered nothing |
| 3 | sphinx | **Two names** (§7): alias and photo per kind, `DAEMON_TRIBE_ALIAS` | — | **Built (stakwork/sphinx#439)**: `DAEMON_TRIBE_ALIAS` and `DAEMON_TRIBE_PHOTO` (a link); the mention follows the tribe name (§7) |
| 4 | sphinx | **The strut host mode** (§7): `StrutService`, the callback route, recovering a lost `run.end` (§6.2), the daily budget, following its places (§4), proposals by reply | 1, 6 (a stand-in strut in its tests until they merge) | **Built (stakwork/sphinx#440)**, with a stand-in strut in its tests (`test/strutkit.ts`, which stands in for item 6's `PUT /hosts/me`, `GET` and `DELETE /hosts/places` and the nudge too). It follows its places (§7). Its DM linking is gone. Differences in §2, §6, §6.1, §7 |
| 5 | stadeum | **Turn it on** (§8) | 1, 3, 4, 6 released; 7 for the tap | — |
| 6 | strut | **Linked places** (§5.4): the `places` and `hosts` tables in `people.db`; `GET`, `POST` and `DELETE /people/places` for a person token; `PUT /hosts/me`, `GET /hosts/places` and `DELETE /hosts/places/:key` for a host key; the nudge; a place going with its linker's account; `GET /hosts/links/:key` removed (nothing calls it). `specs/API.md` §13.4 and §13.6, `docs/security.md`, a host-door test | 1 | **Built (#787)**: `src/people.ts` (`linkPlace`, `hostPlaces`, `onPlaces`), the routes in `createStrut.ts`, `src/places.test.ts`. Each place the host reads carries `linkerName` (§5.4) |
| 7 | peel, peel-android | **The Jamie row for a box** (§4): beside Hive's orgs, each linked box whose strut has a Sphinx host ready; on: `POST /people/places`, then approve the member request by the answered `account`; off: `DELETE` | 6 | — |

A stand-in for strut's host routes goes into the daemon's tests, so item 4
is built before items 1 and 6 merge, as `scripts/fake-sphinx-daemon.ts` did
for Support.

## 11. Later

- **Peel:** marking the account to see senders from the same Jamie row
  (sphinx-chat's `show-senders` does it today), so each linked speaker's
  turn runs as them; drawing `metadata.strut` cards from a box.
- **The Jamie app** lists a person's places and removes one, beside their
  linked accounts on Connect. Until then, Peel's row and the tribe itself
  are where a place is removed.
- **The log:** the daemon launches a workflow the box names, a batch at a
  time, as the linker. Strut ships none: it seeds only what every
  workspace needs.
- **Decisions made elsewhere** announced in the tribe: the daemon follows
  `GET /proposals/changes`.
- **Moving an org off Hive:** a tribe with both Jamies answers twice. The
  owner removes the central one ("No Jamie" in Peel) before linking the
  box's.

## 12. Rejected

- **`/tribes/*` routes in strut** (the daemon's Hive contract, implemented
  in strut). Tribe code in a generic engine (ruling 3).
- **Strut polls the daemon**, as Support does. The daemon already pushes;
  polling adds a loop and a tribe token in strut (ruling 4).
- **stadeum-ui as the host.** It would rebuild Hive between the daemon and
  strut, and Stadeum's rule 1 keeps conversations, runs and jobs out of it
  (ruling 5).
- **A workflow as the service.** Running a turn as another person is a
  host's power: a workflow that could would be an escalation. And the
  daemon's contract answers at once (busy, refused); a run answers later.
- **The deployment key in the treasury.** The daemon reads messages from
  strangers and holds money (§5.1).
- **Linking a tribe by DM** to the account (built first on
  stakwork/sphinx#440, §4). A person had to know to paste a tribe's link
  into Support's chat, and each such DM landed in the staff's inbox. Peel's
  tap through strut is Hive's one tap.
- **Strut telling the daemon a place itself** (the nudge carrying the
  place, or a join command). The nudge names nothing, and the daemon
  reads the whole list, so a lost or repeated nudge changes nothing, and
  strut never says "join".
