# Support: a chat between workers and a Stadeum's staff

> **Status (2026-11-16): ruled, nothing built.**
>
> - **Written against:** strut `main` @425a9d06, stakwork/sphinx `master`
>   @c1f55f11, peel-android @efbcccd and peel @78deb6e.
> - **The Rulings** are Evan's, from one conversation.
> - **The decisions in §6** are this plan's defaults. Evan may overrule them.
> - **Companion to:**
>   - `human-steps.md`: §5.8, inviting a worker; §8.2, payouts; §9, the staff
>     app;
>   - `specs/LIGHTNING.md`: what strut expects of the treasury daemon.
>
> **Keeping this plan current.** Each PR that builds an item edits this file:
> its row in §10 says it is built and names the PR. Wherever a section says
> something other than what was built, the PR marks it **Built differently
> (#N):**, with what was built and why.

## Rulings (2026-11-16)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | The worker's door | **A Sphinx DM** to the treasury daemon, the contact an invite already gives every new worker (`human-steps.md` §5.8). Workers use Peel's own chat |
| 2 | The contact's name | Plain **"Support"**, on every box. Replaces "`treasury` on every box", ruled in stakwork/stadeum's `plans/treasury.md` on 2026-11-12 |
| 3 | A daemon token that reads and sends DMs | **Acceptable** |
| 4 | Staff names | Workers see the name of the staff member who replied, **on every reply** |
| 5 | Writing first | **Support may message workers first.** Staff can send a **welcome** directly |
| 6 | The staff's side | **A full chat UI in `strut/staff`**: workers' pictures, photos and files both ways, replies |
| 7 | Auto-welcome | Sent automatically to a new worker **only once an admin has saved a welcome message**. Strut ships no default text |

## Problem

A worker who joins through an invite gets one Sphinx contact: the Stadeum's
treasury daemon, named "treasury". Workers write to it. Nobody reads what
they write:
- the daemon keeps the messages in its log;
- it passes on only tribe mentions;
- the treasury runs with no service.

The staff have no way to reach a worker either. They have no channel to say
"your photos are blurry", "you're paid", or "welcome".

## Design in one paragraph

Workers chat with "Support" in Peel, as with any contact. Staff chat back
from a **Support** tab in `strut/staff` that looks and behaves like a
messenger:
- a list of conversations with each worker's picture, name, last line and
  unread count;
- a live thread with photos and files both ways, quoted replies, sent
  status, and the staff member's name on each reply;
- the worker's work and pay beside the thread.

The treasury daemon carries the messages through a new DM-only token, which
strut keeps away from the services bag, as it keeps the pay token. Strut
keeps the conversations, with what Sphinx can't hold: who replied, unread
state, staff names, the welcome.

One welcome message, sent automatically once an admin has written it, is also
how every existing worker's "treasury" contact becomes "Support".

## 1. What the daemon gives today

**Every message is kept.**
- The account writes every message it sees, 1:1 included, to
  `<home>/log.jsonl` (`wasm/chat/src/log.ts`).
- A sender goes into the address book as a person, with their address
  (`learn`, `wasm/chat/src/inbox.ts`).

**Nobody reads it.**
- The daemon hands a service only tribe mentions: `skipReason` returns `""`
  for a record with no tribe.
- The treasury runs with `DAEMON_REPLY=none` and no service.

**The admin token can already reach DMs.**
- `GET /messages` returns every record, but with no cursor, no person filter,
  and 500 at most.
- `POST /send { to, text, reply?, metadata? }` sends to a person by alias,
  address or pubkey. It is not idempotent.
- Strut never holds the admin token (`specs/LIGHTNING.md`).

**What the design rests on:**
- **What a DM costs** (`wasm/chat/src/amounts.ts`):
  - 0 sats to a confirmed contact;
  - 1 sat per part while their key is unconfirmed;
  - 3 sats to meet a new contact.
- **The sender's name and picture travel on every message.**
  - The core's `send` takes `my_alias` and `my_img` per message
    (`wasm/src/auto.rs`).
  - sphinx-chat always sends `img: ""`. Its `Party` keeps alias, pubkey and
    address, never a photo.
- **A worker's picture is a public URL.** Peel uploads it to the memes
  server's `/public/<muid>` and sends it as `img` on every message, payment
  and key exchange (peel-android phase 25).
- **Receiving a file is solved; sending one is not.**
  - The daemon already downloads and decrypts a memes file for a tribe
    mention (`media.ts`).
  - Sending one takes four steps, which Peel does: encrypt with RNCryptor v3
    under a fresh key, upload to memes `/file`, sign a media token, send a
    type-6 message.
  - sphinx-chat has no upload.
  - The wasm core doesn't export `make_media_token`: it is in
    `sphinx/src/bindings/media.rs`, not in `wasm/src`.
- **A media token expires.** The worker's key signs it, naming a host, a muid
  and an expiry. So strut fetches a worker's file when it arrives, not when
  someone first opens it.
- **A page's call to strut is capped at 4 MB** by the MCP transport, which
  leaves about 2.9 MB as base64 (`human-steps.md` §5.6.6).

## 2. The rename

**Where "treasury" comes from.**
- The host sets the daemon's alias. Stadeum sets `DAEMON_ALIAS: treasury`.
- The daemon reads it only when it creates the account; an existing account
  keeps the name it was made with (`wasm/daemon/src/index.ts`).
- The invite's `c=` carries the same name. `c=` is base64 of the daemon's
  pubkey (33 bytes), the LSP's pubkey (33), the scid (8) and the alias
  (`invite_qr`, `sphinx/src/ping/invite.rs`).

**What Peel shows.**
- At signup, Peel adds the inviter under `c=`'s alias.
- After that, both Peels rename a direct contact from the newest message that
  carries a non-empty alias:
  - Android: `Storage.upsertContact`;
  - iOS: `Storage+Writes`, `COALESCE(NULLIF(excluded.alias,''), alias)`.
- So the account's alias is the name that sticks.

**Two consequences.**
- **The alias never changes per message.** A reply sent under "Ana" would
  rename the worker's contact to "Ana". The staff member's name goes in the
  text instead (§3).
- **The rename reaches an existing worker with the next message they get.**
  The welcome is that message (§5).

**Two Stadeums mean two "Support" contacts.** A worker in two Stadeums sees
two contacts named "Support". Support's own picture tells them apart (§3,
item 2).

## 3. The staff's chat

A seventh tab, **Support**, in `strut/staff`:
- an unread count on the tab;
- a deep link, `tab=support&worker=<actor>`;
- **Message** on a worker's page in Workers, which opens their conversation.

A host frames it as it frames the rest, and may show the count in its own
navigation (`GET /support/unread`).

The layout copies `strut/jamie`: conversations on the left, the thread on
the right. On a phone, the list opens a thread and Back returns to the list.

| Feature | What the staff see | Daemon needs (§7) | Strut needs | Item |
| --- | --- | --- | --- | --- |
| Conversations | Each worker's picture, name, last line, time, unread dot; unread first; search | `alias` and `photo` on each peer | The store; search over names and text | 1 |
| Workers' pictures | The worker's Peel photo, else their initials | Each contact's newest `photo_url`, the URL only | Fetched, shrunk and cached (below) | 1 |
| Live thread | A worker's message shows within a second or two | `GET /dms?after=&wait=25` | The follower; `staff/support-feed { after, wait }`, held as `task/next { wait }` is | 1 |
| Text from staff | Composer: Enter sends, Shift+Enter adds a line | `POST /dm`, idempotent by `id` | The row stored before the send; Retry resends the same `id` | 1 |
| Staff name | Each reply shows who sent it in the thread | — | The worker sees a bold first line, `**Ana**`, then the text. Both Peels render `**bold**` (MessageMarkup). Each admin's display name is in Support settings, defaulting to their sign-in name | 1 |
| Replies | Reply on a message, with the quote above the composer | `reply` on `POST /dm`; `replyTo` in the feed | Quote display | 1 |
| Sent status | Clock while sending, ✓ once the LSP has it, ! with Retry if it failed | `status` on the account's own sends | Shown on the bubble | 1 |
| Photos and files from workers | Images inline (tap for full size), voice notes playable, other files as a named download | `GET /dm/:id/file` | Fetched on arrival, kept under `dataDir`, read through `staff/support-file` | 1 |
| Deleted by the worker | "Message deleted" | `deleted` in the feed (sphinx-chat already applies type 17) | Hide the text | 1 |
| Sats from a worker | "Sent you 100 sats" as a line | Payment records in the feed | A line; not in the books | 1 |
| The worker beside the thread | Status, types held, lease now, answers this week, owed and paid, invite used, note; links to their page and tasks | — | `staff/worker` and `earnings/read`, already there | 1 |
| Task links | A task id in a message is a link to the task | — | Detected when drawn | 1 |
| The welcome | §5 | Send to an address with no contact yet (sphinx-chat's `meetPerson`) | The text in settings, three places to send it, and the worker's address stored | 1 |
| Photos and files from staff | Attach, paste or drop. Images shrunk to 1,600 px in the page; other files up to 2.5 MB | Encrypt, upload, sign, send a type-6 message | Composer attachments | 2 |
| Support's picture | Set in Support settings | Upload to memes `/public`; `img` on every send | Settings | 2 |
| Delete a staff message | Delete, for both sides | Send a type-17 delete | Menu | 2 |
| Payout lines | "Paid you 1,200 sats" after a payout settles | — | Written when the payout settles (`human-steps.md` §8.2) | 2 |
| Done and assigned | Mark a conversation done; assign it; filter by mine or unassigned | — | Fields on the conversation | 2 |
| Staff heads-up | §6 | — | — | 2 |

**Not built, on purpose:**
- tips or boosts from staff: money leaves only through Payouts and the payer;
- calls, invoices, tribes and Sphinx threads.

**Typing indicators and the worker's read state:** nothing in the core
carries them.

### Where the pictures come from

Staff see workers' pictures from **strut's own cache**. This is the same in
strut's UI, in a host's frame, and on a phone.

1. **Peel puts the photo's public URL on every message.**
2. **The daemon keeps the URL, never the image.** sphinx-chat already reads
   each sender, but throws the photo away. It gains `photo` per contact, the
   newest seen, and the feed carries it.
3. **Strut fetches the image once per URL:**
   - only from an allowed memes host: `memes.sphinx.chat`, or a list like
     the daemon's `DAEMON_MEMES_HOSTS`;
   - shrunk to 128 px with `sharp`, loaded lazily as strut already does;
   - kept as `dataDir/support/avatars/<sha256 of the URL>.jpg`.

   A new photo has a new muid and so a new URL. The cache never needs
   invalidating.
4. **The page gets it as data.** `staff/support-avatar { worker }` returns a
   `data:` URL of a few KB, and react-query keeps it. The conversation list
   returns the small ones inline.

**Why the page doesn't load the memes URL itself:**
- **It can't reach the host.** An app document's CSP is
  `img-src data: blob:` plus the app's `csp.resourceDomains`
  (`src/apps/build.ts`, `cspFor`). The memes host differs by swarm.
- **The URL is the worker's claim.** Any https URL would make each admin's
  browser fetch it: a tracking pixel that reveals when staff opened the chat,
  and from where. Strut fetches from allowed hosts only, from the server.

Support's own picture (item 2) goes the other way: staff upload it in Support
settings, the daemon puts it on memes `/public`, and Peel shows it like any
contact's picture.

## 4. The store

Tables in the task store's SQLite (`src/tasks/`, the file strut already owns
for tasks and workers).

**A conversation**
- Keyed by the worker's Sphinx pubkey. The actor is `secp:` plus the pubkey
  without its first byte: Peel signs in with the root key, which is also its
  contact key (`src/visitors.ts`).
- Fields: the peer's alias, photo URL and avatar file; `seenAt` and `seenBy`
  (shared by the staff); `welcomedAt`; and in item 2, `status` (open or
  done) and `assignee`.
- Someone who has the contact but isn't a worker here still gets a
  conversation, marked "Not a worker here".

**A message**
- Keyed by the Sphinx id, and by `clientId` for strut's own sends.
- Fields: direction, text (staff text kept without the name line), `by` (the
  admin's actor), `replyTo`, kind, `sats`, `deleted`, the file's type, name
  and path, and the send's status.

**Settings**
- The welcome text: empty until an admin writes one.
- Each admin's display name.
- Payout lines on or off.

**Also stored**
- The follower's cursor.
- On the worker row, `address`: the Sphinx address their session carries at
  sign-in. Withdraw already reads it from the session; Support needs it to
  write first.

**Where files live.** Files and avatars go under `dataDir/support/`. They are
backed up with the box, beside the task store.

**Retention.** Kept as long as the worker is on the box (§6).

## 5. The welcome

**What it is.**
- One text in Support settings, with `{name}` (the worker's Sphinx alias).
- **It starts empty.** The field shows an example only as a placeholder, such
  as "Hi {name}, welcome! This is Support. Ask us anything about your tasks or
  pay here."
- Until an admin saves one, there is nothing to send, and every Send welcome
  button says to write it first.
- It goes out under "Support" with no staff name: it is from the desk, not a
  person.

**Where it is sent from:**
1. **Automatically, when an invited worker joins, once a welcome is saved.**
   - The daemon's feed reports a new contact: an incoming key exchange, which
     already marks the invite `used`. Strut then sends the welcome.
   - Before a welcome is saved, nothing goes out automatically, and the
     invite's row on Workers says "Joined · not welcomed". After it, "Joined
     · welcomed".
   - Clearing the text turns it off again.
2. **A worker's page, or an empty conversation:**
   - **Send welcome** sends it immediately, with no draft;
   - a composer option inserts the text so staff can edit it first.
3. **The Workers list:**
   - tick workers, then **Send welcome**;
   - a banner offers it once for everyone not yet welcomed: "12 workers
     haven't been welcomed. Send to all".

**The limits.**
- Nothing goes out in bulk without a staff click.
- Each worker is welcomed automatically at most once. Staff may send it again
  by hand.

**How it ties to the rename.** The welcome is the first message most
existing workers get from "Support", so it renames their "treasury" contact.
The rollout is: the host renames the alias, an admin writes the welcome, and
an admin presses "Send to all" once. It costs nothing to a worker who
already has the contact.

**Workers with no contact yet** came through Share, not an invite. Strut
writes to the address their sign-in carried, stored since item 1. The
welcome makes "Support" a new contact in their Peel, for about 4 sats.

## 6. Decisions (defaults; Evan may overrule)

- **Staff heads-up.**
  - Item 1: the unread count on the tab, and `GET /support/unread` for a
    host's navigation.
  - Item 2: when a worker's message has waited unread for 5 minutes, Support
    DMs each admin whose Sphinx address strut knows: "3 messages waiting in
    Support". It carries no content and goes at most once an hour per admin.
  - Admins without an address get the count only.
- **Payouts in the thread:** one line from Support when a payout settles. On
  by default, with a switch in settings.
- **Retention.**
  - Kept as long as the worker is on the box; nothing is deleted
    automatically.
  - A banned worker's conversation stays, and staff may still write to say
    why.
  - Deletion on request is later. It would delete strut's copy only: the
    daemon's log and the worker's phone keep theirs.
- **Who reads.**
  - Admins only, like the rest of `strut/staff` (`human-steps.md` §9.12).
    No support role of its own until a client asks.
  - Agents never: the token is never on the services bag.
- **Unread** is per conversation and shared by the staff ("Seen by Ana,
  10:02").
- **The backlog.** The first follow reads from the start of the daemon's
  log, so what workers already wrote to "treasury" shows up, marked as
  earlier.

## 7. What strut needs from the daemon

This is built in stakwork/sphinx (`wasm/daemon`) and becomes a section of
`specs/LIGHTNING.md`, as the wallet's routes are.

### The message token

- `DAEMON_MESSAGE_TOKEN`, a fourth token, different from the other three.
- **It opens only** the routes below.
- **It doesn't open** tribes, join, leave, invoices, pay, keysend, invites or
  the admin routes.
- **The only sats it can spend** are what a DM itself costs. A cap on new
  contacts per hour bounds that.

### Item 1's routes

**`GET /dms?after=<seq>&limit=&wait=25`**
- 1:1 records, sent and received, oldest first, under a sequence number of
  the daemon's own. The server's `index` is missing on the account's own
  sends, so it can't be the cursor.
- Fields: `seq`, `id`, `clientId` (on the account's own sends), `time`,
  `fromMe`, `peer { pubkey, address, alias, photo }`, `kind` (`message`,
  `file`, `payment` or `contact`, a new contact's key exchange), `text`,
  `replyTo`, `sats`, `deleted`, `mediaType`, `fileName`, `status` (own
  sends).
- Never a file's key.

**`GET /dm/:id/file`**
- The decrypted bytes, with their type, via `media.ts`'s download, without
  shrinking.
- The memes hosts allowed as for tribes.

**`POST /dm { id, to, text, reply? }`**
- `to` is an address, or the pubkey of a known person; never a tribe.
- A new contact is met first.
- The same `id` returns the first send's answer and never sends twice.

**Also:**
- sphinx-chat keeps each contact's newest `photo_url`.
- A changed `DAEMON_ALIAS` replaces the stored alias at start.

### Item 2's routes

- `make_media_token` exported from the wasm core.
- RNCryptor v3 encryption, ported from Peel's `MediaCrypto`.
- Uploads to memes `/file` and `/public`.
- `POST /dm` with a file.
- Support's photo sent as `img` on every message.
- `POST /dm/:id/delete`.

## 8. What a host does

A host that runs the treasury (Stadeum, in `stack/stadeum.yml`):
- gives the daemon `DAEMON_MESSAGE_TOKEN`, and strut the same value as
  `LIGHTNING_DAEMON_MESSAGE_TOKEN`;
- sets `DAEMON_ALIAS: Support`;
- may show `GET /support/unread` in its navigation.

Without the token, the `/support` routes answer `not_available`, and the
staff app shows no Support tab. The page decides in `shownOf`
(`src/apps/staff/src/lib/view.ts`), as it already does for the Tests tab.

Strut keeps `LIGHTNING_DAEMON_MESSAGE_TOKEN` as it keeps the pay token:
- in `payments.json`, never on the services bag and never readable by a
  step;
- equal to another token, it fails the boot;
- only the follower and the `/support` routes use it.

## 9. Who can read

| Who | Can |
| --- | --- |
| The worker | Their own conversation, in Peel |
| Admins | Every conversation, in `strut/staff`. The `/support` routes are full scope only |
| Members, visitors, other workers, agents | Nothing |
| Anyone with the treasury volume or its backups | Everything: the seed decrypts every DM, as it already controls the money |
| Anyone with the message token | Read every DM, and write to anyone as Support (ruling 3) |
| The mixer | Who wrote to whom and when, as for any Sphinx DM; not the content |

## 10. Work items

Each is its own PR against `main`, never stacked.

| Item | What | Needs | State |
| --- | --- | --- | --- |
| 1 | **A usable full chat.** The token kept in `payments.json`; the follower; the store (§4); files and avatars under `dataDir`; the worker's `address` stored at sign-in; the welcome and its auto-send. Routes, full scope only: `GET /support` (`?q=`), `GET /support/unread`, `GET /support/feed?after=&wait=`, `GET` and `POST /support/:worker`, `POST /support/:worker/seen`, `POST /support/:worker/welcome`, `GET /support/:worker/files/:id`, `GET /support/avatar/:worker`, `GET` and `PUT /support/settings`. A `staff/support-*` step for each. The Support tab with every item-1 row of §3, Message on a worker's page, the welcome in its three places, and Support settings. `specs/API.md`, `specs/LIGHTNING.md`, `docs/` | The daemon's item-1 routes (§7) | Not started |
| 2 | **Staff send files; the desk scales.** Attachments in the composer, Support's picture, Delete, payout lines, done and assigned, the heads-up to admins | 1; the daemon's item-2 routes | Not started |

A stand-in for the new routes goes into `scripts/fake-sphinx-daemon.ts`,
which already answers the wallet, keysend and invite routes. That way item 1
is built and tested before the daemon's side has merged.

## 11. Rejected

- **A thread inside the worker app, over HTTP.**
  - For: it reaches browser and iPhone workers, and the page knows the task.
  - Against: no push, and the invite's contact stays a dead end.
  - The store is keyed by the worker's key, so it can be added later as a
    second door onto the same conversations, if browser workers need it.
- **Staff answer from their own Peel**, through a staff tribe the daemon
  relays into. Workers' words would pass through the tribe server, each post
  costs sats, and strut would have no record.
- **A separate Support account.** It keeps money and messages apart, but
  needs a second daemon and seed on every box, breaks the treasury's `used`
  status for invites, and existing workers' contact is the treasury. Not
  needed once ruling 3 accepted the token.
- **A per-invite alias in `c=`.** The daemon's first message would rename the
  contact back to the account's alias (§2).
