# Support: a chat between workers and a Stadeum's staff

> **Status (2026-11-18): ruled; item 1 built (#719), item 2 built (#720,
> stacked on #719); rebuilt as an app on #737 (`plans/people-and-hosts.md`
> §4, §5, item 5).** Support is now `strut/staff`'s own SQLite, tools and
> one workflow: the daemon pushes each DM to `support/receive`, so strut no
> longer polls (ruling 16 is replaced) and has no `/support` routes; the
> staff heads-up (§6) is dropped for now; what Support as built kept was
> not copied. The sections below describe Support as first built; where
> they speak of the follower, the routes, the task store's tables or
> `<dataDir>/support/`, read `plans/people-and-hosts.md` §5.
>
> - **Written against:** strut `main` @425a9d06, stakwork/sphinx `master`
>   @c1f55f11, peel-android @efbcccd and peel @78deb6e.
> - **The Rulings** are Evan's, from two conversations on 2026-11-16: 1–7,
>   then 8–12 and the change to 4 after a review of the plan.
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
| 4 | Staff names | **None.** Every reply comes from "Support", and admins have no display name. Strut records which admin sent each reply, and shows it nowhere |
| 5 | Writing first | **Support may message workers first.** Staff can send a **welcome** directly |
| 6 | The staff's side | **A full chat UI in `strut/staff`**: workers' pictures, photos and files both ways, replies |
| 7 | Auto-welcome | Sent automatically to a new worker **only once an admin has saved a welcome message**. Strut ships no default text |
| 8 | Which new contacts are welcomed automatically | Only those whose `contact` record is **newer than the moment the welcome was saved**. Earlier ones, the backlog included, are welcomed only by a staff click (§5) |
| 9 | An invite's row on Workers | Unchanged: it shows no "welcomed" state, so an invite needs no link to the worker who used it |
| 10 | A file from a worker | Up to **25 MB**. A larger one shows as a line saying it was too large |
| 11 | An NWC wallet | **No Support.** Support needs the Sphinx daemon |
| 12 | A message the worker deleted | Hidden, as "Message deleted". Strut keeps its row, flagged |
| 13 | Workers' pictures | **Later** (§11). Item 1 shows initials |
| 14 | Sending the welcome | **Automatic only**, once an admin has saved it. No Send welcome button, no "Send to all", no `{name}` |
| 15 | Writing first to a worker who isn't a contact (one who came by a Share link) | **Later** (§11). Item 1 writes only to existing contacts |
| 16 | How new messages arrive | **Polled.** Strut polls the daemon every few seconds, and the page refetches every few seconds. No held connections |

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
  status, and every reply from "Support";
- the worker's work and pay beside the thread.

The treasury daemon carries the messages through a new DM-only token, which
strut keeps away from the services bag, as it keeps the pay token. Strut
keeps the conversations, with what Sphinx can't hold: which admin replied,
unread state, the welcome.

One welcome message, sent automatically once an admin has written it, is also
how every existing worker's "treasury" contact becomes "Support".

## 1. What the daemon gives today

**Every message is kept.**
- The account writes every message it sees, 1:1 included, to
  `<home>/messages.jsonl` (`wasm/chat/src/log.ts`).
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
  rename the worker's contact to "Ana". Every reply is from "Support"
  (ruling 4).
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
| Conversations | Each worker's initials, name, last line, time, unread dot; unread first; search | `alias` on each peer | The store; search over names and text | 1 |
| Live thread | A worker's message shows within a few seconds | `GET /dms?after=` | The follower polls it every few seconds; the page refetches the thread and the list every few seconds (ruling 16) | 1 |
| Text from staff | Composer: Enter sends, Shift+Enter adds a line | `POST /dm`, idempotent by `id` | The row stored before the send; Retry resends the same `id` | 1 |
| Who replied | Every reply is from "Support", on both sides (ruling 4) | — | `by` on the message, the admin's actor, kept for the record and not shown | 1 |
| Replies | Reply on a message, with the quote above the composer | `reply` on `POST /dm`; `replyTo` in the feed | Quote display | 1 |
| Sent status | Clock while sending, ✓ once the LSP has it, ! with Retry if it failed | `status` on the account's own sends | Shown on the bubble | 1 |
| Photos and files from workers | Images inline (tap for full size), voice notes playable, other files as a named download | `GET /dm/:id/file` | Fetched on arrival, up to 25 MB (ruling 10), kept under `dataDir`, read through `staff/support-file`. The 4 MB cap is on what a page sends, not on what it gets back | 1 |

**Built differently (#719):** what a page gets back is capped too: a
step's result is at most 5 MB (`STEP_RUN_RESULT_MAX_CHARS`, src/apps/tools.ts).
So `staff/support-file` hands a file over in 3 MB pieces (`offset`, `next`),
which the page joins.
| Deleted by the worker | "Message deleted" | `deleted` in the feed (sphinx-chat already applies type 17) | Flag the row and hide it (ruling 12) | 1 |
| Sats from a worker | "Sent you 100 sats" as a line | Payment records in the feed | A line; not in the books | 1 |
| The worker beside the thread | Status, types held, lease now, answers this week, owed and paid, invite used, note; links to their page and tasks | — | `staff/worker` and `earnings/read`, already there | 1 |

**Built differently (#719):** the worker beside the thread shows what they
are owed (earned, held, withdrawable, from `staff/worker`) and links to
their payouts, not a paid total, and no "invite used": an invite keeps no
link to the worker who used it (ruling 9), so which one they used is not
known. It shows on a wide screen (1024 px and over); on a phone the thread
links to their page.
| Task links | A task id in a message is a link to the task | — | Detected when drawn | 1 |
| The welcome | §5 | `contact` records in the feed | The text in settings; sent automatically | 1 |
| Photos and files from staff | Attach, paste or drop. Images shrunk to 1,600 px in the page; other files up to 2.5 MB | Encrypt, upload, sign, send a type-6 message | Composer attachments | 2 |
| Support's picture | Set in Support settings | Upload to memes `/public`; `img` on every send | Settings | 2 |
| Delete a staff message | Delete, for both sides | Send a type-17 delete | Menu | 2 |
| Payout lines | "Paid you 1,200 sats" after a payout settles | — | Written when the payout settles (`human-steps.md` §8.2) | 2 |
| Done and assigned | Mark a conversation done; assign it; filter by mine or unassigned | — | Fields on the conversation | 2 |
| Staff heads-up | §6 | — | — | 2 |

**Built differently (#720):**
- **Photos and files from staff** as the row says: a photo is shrunk in the
  page to 1,600 px and sent as a JPEG (a GIF or SVG goes as a file); strut
  keeps its copy under `<dataDir>/support/files/`, which Retry sends again.
  The 2.5 MB stays, though #700 raised the app door's cap since
  (`APP_DOOR_BODY_MAX_BYTES`, about 20 MB): one paste of a phone's PDF
  could carry more, if that is wanted.
- **Support's picture** is shrunk to 512 px in the page; strut keeps a copy
  (`<dataDir>/support/photo`) to show it in settings, since the page cannot
  load the memes URL (above).
- **Delete** is a trash button on Support's own messages, asked in place
  (an app frame has no modals), not a menu. A failed send never went (the
  daemon deletes none, stakwork/sphinx#436): it is deleted in strut alone.
- **Payout lines** go to the worker as a DM from Support, so Peel shows
  them; the staff's thread labels them "Payout". Only to a worker who is a
  contact (ruling 15), once per payout (its id made from the payout's key).
  The hook is the withdrawals' `paid`, after `payoutSettled`.
- **Assigned** means taken: Take it and Let go, no picking another admin,
  since admins have no names (ruling 4). The routes keep the actor and
  answer `assigned: "me" | "other"`. The list opens on Open, beside Mine,
  Unassigned and Done.
- **The heads-up**: strut keeps no admin's Sphinx address, so it goes to
  each admin SUPPORT KNOWS: an actor who marked a conversation seen,
  replied or took one, and is itself the key of one of Support's contacts
  (`secp:` + a conversation's pubkey), so `POST /dm` reaches them (ruling
  15). An admin a host signs in under another actor gets the tab's count
  alone. An admin's own messages to Support are not counted as waiting.
  No switch.

**Not built, on purpose:**
- tips or boosts from staff: money leaves only through Payouts and the payer;
- calls, invoices, tribes and Sphinx threads.

**Typing indicators and the worker's read state:** nothing in the core
carries them.

### Where the pictures come from (later, ruling 13)

Not in item 1; kept here for when it is built. Staff see workers' pictures from **strut's own cache**. This is the same in
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
- Fields: the peer's alias; `seenAt` (shared by the staff); `welcomedAt`; and in item 2, `status` (open or done) and
  `assignee`. **Built (#720):** two columns on `support_conversations`,
  added to a file item 1 made.
- Someone who has the contact but isn't a worker here still gets a
  conversation, marked "Not a worker here".

**A message**
- Keyed by the Sphinx id, and by `clientId` for strut's own sends.
- Fields: direction, text, `by` (the admin's actor, never shown),
  `replyTo`, kind, `sats`, `deleted`, the file's type, name and path, and
  the send's status.

**Settings**
- The welcome text: empty until an admin writes one, and when it was last
  saved (ruling 8).
- Payout lines on or off.
- Support's picture: the URL the daemon answered (**built, #720**; the
  bytes in `<dataDir>/support/photo`).

**Also stored**
- The follower's cursor.

**Where files live.** Files go under `dataDir/support/`. They are
backed up with the box, beside the task store.

**Retention.** Kept as long as the worker is on the box (§6).

## 5. The welcome

**What it is.**
- One plain text in Support settings.
- **It starts empty.** The field shows an example only as a placeholder, such
  as "Welcome! This is Support. Ask us anything about your tasks or pay
  here."
- It goes out under "Support", as every reply does.

**When it is sent: automatically, and only then** (ruling 14).
- The daemon's feed reports a new contact: an incoming key exchange, which
  already marks the invite `used`. Strut then sends the welcome.
- Only for a `contact` record newer than when the welcome was saved
  (ruling 8). An older one, such as the backlog's on the first follow, gets
  none. So nothing goes out in bulk.
- Each worker at most once (`welcomedAt`).
- Saving the text again doesn't move that time. Clearing it turns
  auto-welcome off, and the next save starts it again from then.
- An invite's row on Workers shows nothing new (ruling 9).

**How it ties to the rename.** A worker's "treasury" contact becomes
"Support" with the first message they get after the host renames the
alias: the welcome for a new worker, a staff reply for an existing one.
Only a few test accounts have joined so far, so no bulk send is needed.

## 6. Decisions (defaults; Evan may overrule)

- **Staff heads-up.**
  - Item 1: the unread count on the tab, and `GET /support/unread` for a
    host's navigation.
  - Item 2: when a worker's message has waited unread for 5 minutes, Support
    DMs each admin whose Sphinx address strut knows: "3 messages waiting in
    Support". It carries no content and goes at most once an hour per admin.
  - Admins without an address get the count only.
  - **Built differently (#720):** "whose Sphinx address strut knows" is
    an admin whose actor is a Support contact's key and who has used
    Support (§3's notes): strut keeps no admin's address. `POST /dm`
    reaches existing contacts alone (ruling 15).
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
- **Unread** is per conversation and shared by the staff ("Seen 10:02").
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
- **The only sats it can spend** are what a DM to an existing contact
  costs: 0, or 1 sat a part while their key is unconfirmed. It never meets
  a new contact in item 1 (ruling 15).

### Item 1's routes

**Why a new route at all.** The only read today is `GET /messages`, which
takes the admin token strut never holds, has no cursor, returns 500 records
at most and mixes in every tribe. Strut needs a cursor, so it reads each DM
once and survives a restart. It doesn't need a held connection: it polls
every few seconds (ruling 16), soon enough to fetch a file before its media
token expires and to send the welcome.

**`GET /dms?after=<seq>&limit=`**
- 1:1 records, sent and received, oldest first, under a sequence number of
  the daemon's own. The server's `index` is missing on the account's own
  sends, so it can't be the cursor.
- **Built differently (stakwork/sphinx#435, strut #719):** the answer is
  `{ dms: [...] }`; `after` defaults to 0, `limit` is 1 to 1,000 (100 by
  default). A record that changes (a send's `status` moving, a message
  deleted) comes again under a new, higher `seq`, so strut UPSERTS: its own
  sends by `clientId`, everything else by `id`, and keeps its cursor per
  daemon URL. `id` is null only on a send that failed before anything went
  out; `clientId` is only on sends made through `POST /dm`; `status`
  (`sending`, `sent` or `failed`) is on every message the account sent, and
  `error` on a failed one. `fileName` is made from the type (`image.jpg`,
  `file.pdf`): a Sphinx file message carries no name, so strut takes the
  sender's from `GET /dm/:id/file`'s `content-disposition`. The feed's
  numbers live in the daemon's `<home>/dms.jsonl`, over the log
  (`messages.jsonl`). specs/LIGHTNING.md, "Support's DMs".
- Fields: `seq`, `id`, `clientId` (on the account's own sends), `time`,
  `fromMe`, `peer { pubkey, address, alias }`, `kind` (`message`,
  `file`, `payment` or `contact`, a new contact's key exchange), `text`,
  `replyTo`, `sats`, `deleted`, `mediaType`, `fileName`, `status` (own
  sends).
- Never a file's key.

**`GET /dm/:id/file`**
- The decrypted bytes, with their type, via `media.ts`'s download, without
  shrinking. 25 MB at most (ruling 10); a larger file is refused with a
  code strut can show. **Built differently (stakwork/sphinx#435, strut
  #719):** 25 MiB; that refusal is `413 too_large`, shown as ruling 10's
  "too large" line (strut also stops reading past 25 MiB). The others:
  `404 not_found`, `410 deleted`, `403 host_not_allowed`, `422 unreadable`
  (strut gives up at once) and `502 memes_failed` (strut tries again). The
  daemon downloads a DM's file within 180 s, so strut fetches files beside
  its reads of the feed, never holding them.
- The memes hosts allowed as for tribes.

**`POST /dm { id, to, text, reply? }`**
- `to` is the pubkey of an existing contact; never a tribe, never someone
  it hasn't met (ruling 15).
- The same `id` returns the first send's answer and never sends twice.
- **Built differently (stakwork/sphinx#435, strut #719):** a send that
  FAILED is tried again under the same `id`, with the text it first had:
  that is strut's Retry. A send whose publish failed partway stays
  `sending`, never `failed`, so it is never sent twice. The answer is the
  send's item as the feed shows it, with its `seq`, after up to about 10 s
  for the LSP (then `sending`; the LSP's PENDING counts as `sent`). `id` is
  1 to 128 printable characters (strut sends 64 hex). Refusals: `400
  not_a_contact`, `400 too_long` (over 32 KiB as the message's JSON, which
  strut refuses before it keeps anything), `503 not_connected`.

**Also:**
- A changed `DAEMON_ALIAS` replaces the stored alias at start.

### Item 2's routes

- `make_media_token` exported from the wasm core.
- RNCryptor v3 encryption, ported from Peel's `MediaCrypto`.
- Uploads to memes `/file` and `/public`.
- `POST /dm` with a file.
- Support's photo sent as `img` on every message.
- `POST /dm/:id/delete`.

**Built differently (stakwork/sphinx#436, strut #720):**
- `POST /dm { id, to, text?, reply?, file?: { data, type, name? } }`: 25
  MiB (`413 too_large`); a file's fields count 1 KiB toward the 32 KiB
  `too_long`, which strut counts too. The daemon keeps NO bytes: a failed
  file send is tried again only with `file` again (strut's Retry sends it
  from its own copy), and `GET /dm/:id/file` refuses the account's own
  files (strut never asks: it keeps its copy). An upload the memes server
  refuses ends the send `failed`.
- `PUT /dm/photo { data, type }` → `{ url }`: jpeg, png, gif or webp, the
  bytes of that type, 5 MiB, not resized (strut's page sends a 512 px
  JPEG). `DELETE /dm/photo` → `{ url: null }`. The `img` goes on messages
  sent through sphinx-chat's `sendText` (not on keysend payouts).
- `POST /dm/:id/delete`: messages and files alone; it answers the item
  `deleted: true`, which the feed repeats under a new `seq`. `409
  not_deletable` for a failed send (strut deletes its own copy alone, as
  it never went) and for a send not settled after a restart (shown as
  "try again in a moment"); `403 not_own`, `404 not_found`, `503
  not_connected`, `502 send_failed`.
- specs/LIGHTNING.md, "Support's DMs".

## 8. What a host does

A host that runs the treasury (Stadeum, in `stack/stadeum.yml`):
- gives the daemon `DAEMON_MESSAGE_TOKEN`, and strut the same value as
  `LIGHTNING_DAEMON_MESSAGE_TOKEN`;
- sets `DAEMON_ALIAS: Support`;
- may show `GET /support/unread` in its navigation.

Without the token, or with an NWC wallet (ruling 11), the `/support` routes
answer `not_available`, and the staff app shows no Support tab. The page
decides in `shownOf` (`src/apps/staff/src/lib/view.ts`), as it already does
for the Tests tab.

Strut keeps `LIGHTNING_DAEMON_MESSAGE_TOKEN` as it keeps the pay token:
- as `messageToken` on a `sphinx` wallet in `payments.json`, set from the
  environment or by `PUT /earnings/wallet`, as `payToken` is
  (`checkWalletUpdate`, `src/payments/settings.ts`); never on the services
  bag and never readable by a step;
- equal to the receive or pay token, it is refused (`checkCredentials`), so
  a bad environment fails the boot;
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

Each is its own PR against `main`, never stacked. **Built differently:**
item 2 (#720) is stacked on #719, which Evan allowed for this effort.

| Item | What | Needs | State |
| --- | --- | --- | --- |
| 1 | **A usable full chat.** The token kept in `payments.json`; the follower, polling; the store (§4); files under `dataDir`; the automatic welcome. Routes, full scope only: `GET /support` (`?q=`), `GET /support/unread`, `GET` and `POST /support/:worker`, `POST /support/:worker/seen`, `GET /support/:worker/files/:id`, `GET` and `PUT /support/settings`. A `staff/support-*` step for each. The Support tab with every item-1 row of §3, Message on a worker's page, and Support settings (the welcome text). `specs/API.md`, `specs/LIGHTNING.md`, `docs/` | The daemon's item-1 routes (§7) | Built (#719), against the stand-in daemon; the daemon's routes are stakwork/sphinx's |
| 2 | **Staff send files; the desk scales.** Attachments in the composer, Support's picture, Delete, payout lines, done and assigned, the heads-up to admins. Routes: `PUT /support/:worker`, `POST /support/:worker/delete`, `PUT` and `DELETE /support/photo`; `file` on `POST /support/:worker`, `payoutLines` on `PUT /support/settings`, `filter` on `GET /support`. Steps `staff/support-update`, `-delete`, `-photo` | 1; the daemon's item-2 routes | Built (#720, stacked on #719), against the stand-in daemon matched to stakwork/sphinx#436 |

A stand-in for the new routes goes into `scripts/fake-sphinx-daemon.ts`,
which already answers the wallet, keysend and invite routes. That way item 1
is built and tested before the daemon's side has merged.

## 11. Later

Cut from item 1 to keep it simple (2026-11-16). Each is a PR of its own
when it is wanted.

- **Workers' pictures** (ruling 13): the daemon keeps each contact's newest
  `photo_url` and puts `photo` on `peer`; strut fetches, shrinks and caches
  it, and the page gets it through `GET /support/avatar/:worker`. The design
  is in §3, "Where the pictures come from".
- **Writing first to Share-link workers** (ruling 15): strut stores the
  Sphinx address a worker's sign-in carries (`address` on the worker row);
  `POST /dm` takes an address and meets a new contact first, for about
  4 sats; the message token gets a cap on new contacts per hour. The
  welcome then needs a way to reach them, since no key exchange arrives to
  trigger it.
- **Sending the welcome by hand** (ruling 14): Send welcome on a
  conversation, "Send to all" for those not welcomed, `{name}`.

## 12. Rejected

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
