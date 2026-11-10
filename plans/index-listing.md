# Self-serve listing: a publisher asks an index for its name

> **Status (2026-11-10): BUILT, all four work items in one PR** (the owner
> asked for the full plan; one PR, since items 2–4 build on item 1 and PRs
> are never stacked). Written 2026-11-09 after a read of strut `main`
> @1ba36b7, filling in what `plans/marketplace.md` step 7 left as
> "self-serve by a signed request later", on §7 (the index) and §13 (keys
> and cards). The open questions were taken as recommended. Code:
> `src/packages/listing.ts` (the request card), `index-requests.ts` (the
> index's desk), `publisher-listings.ts` (the publisher's asks), the routes
> in `createStrut.ts`, `web/src/components/IndexPanel.tsx` and the Packages
> tab's lines. Choices beyond the text:
> - A host pattern with no port matches the scheme's default port only;
>   `*.domain` matches exactly one label in front.
> - A removal names no `base` (nothing else of it is read).
> - A `base` must be a public name: no IP literal, no single-label or
>   `.local` / `.internal` / `.lan` name, since an open route makes the
>   index fetch it (an index that allows http, a LAN's, takes them).
> - The index remembers a key's last `seq` only while it could still pass
>   as fresh (10 minutes), so the file stays small under a flood of keys.
> - A request is the whole state wanted: an edit replaces the row's
>   description and homepage, and its `urls` become the one catalog URL.
>   `live` absent leaves a live row alone.
> - An approval reads the catalog again but does not ask the request to be
>   fresh: the operator may decide days later.
> - The publisher keeps the index's last answer; "Listed" is read off the
>   index's signed card on every `GET /publisher/listings`, never off that
>   record.
> - `deploy/index` sets `STRUT_INDEX_AUTO_HOSTS` to the swarms by default;
>   a plain-http base is for code only (`index: { allowHttp }`, the tests).
> - The shell asks `GET /index/requests` once and, on an index, every
>   minute, for the Index tab's dot.

## Problem

An index row binds a NAME to a KEY: `openlaw → <public key>, served at
<urls>`. Every bare-name install trusts that row the first time it meets
the name, then pins the key (`src/packages/indexes.ts`, `upstream.key`).
So listing is curation, and today only the index's operator does it:
`PUT /index/:prefix`, full scope (`src/createStrut.ts:4084`), one curl
with index.stakwork.ai's API key per publisher. openlaw1 published
`openlaw/legal-desk` 0.1.0 publicly on 2026-11-09, and it reaches the
store only when Evan runs that curl. A Stadeum box that publishes would
have to ask him by email.

A second gap: after a release, a publisher pings its PEERS
(`pingSubscribers`, `createStrut.ts:3943`), and the route it pings,
`/packages/subscriptions/sync`, needs a peer's credential (the gate,
`:1797`). A publisher never holds a credential for the index, so the index
learns of a release at its next 10-minute poll.

| Strut has | Strut lacks |
| --- | --- |
| The publisher's PUBLIC key, which seals its public catalog (`src/packages/publisher.ts`) | A way to sign anything else with it |
| The card form: RFC 8785, a fingerprint, Ed25519 under a domain prefix, an increasing `seq` (`src/packages/card.ts`) | A card a publisher sends TO an index |
| An index whose rows are sealed into a card and crawled (`src/packages/index.ts`); open reads and one open POST, `/index/mcp` (`createStrut.ts:1784-1786`) | An open door for a publisher to ask for a row, and a queue for the asks a person must decide |
| `setRow` / `removeRow`, which seal and crawl (`index.ts:583`) | Anything that tells the operator someone is waiting |

## The idea

A publisher strut sends the index a **listing request**: a small card
sealed by its PUBLIC key that says "list me as `openlaw`, my server is at
`https://openlaw1.sphinx.chat:3355/lab`". The index checks the seal, then
reads the public catalog at that address and checks it is sealed by the
same key and holds a package under the name. If the address is on a host
the operator trusts (a Stakwork swarm), the row is written at once.
Otherwise the request waits in a queue, and the operator approves it on
the index's own page. Once listed, the same key edits its own row the same
way, and pings the index after each release on an open route.

**The index card does not change, and no strut that installs packages
changes.** Only the index and the publishing strut learn something new.

## Decided

| Question | Decision (proposed) |
| --- | --- |
| The request | A third kind of card, `listing`, sealed by the publisher's PUBLIC key under the domain `strut-listing\n` (§1) |
| Where it goes | `POST /index/requests` on the index, open to anyone like `/index/mcp` (§1) |
| Who sends it | The publishing strut's server, on a person's click: **List on index.stakwork.ai** in the Packages tab (§1) |
| What it names | The server's BASE (an origin and at most one path segment), never a catalog URL. The index reads `<base>/packages/catalog?public=1` and nothing else (§1) |
| Listed with no person | A request whose base is on a host in the index's auto list (`STRUT_INDEX_AUTO_HOSTS`), for a free name, from a key and a host that hold no row yet. index.stakwork.ai lists `*.sphinx.chat:3355`, the swarms (§2) |
| Everyone else | The queue. The operator approves or refuses in a new **Index** tab of the Publish dialog, shown only on an index strut (§3) |
| Edits | The row's own key edits its row without a person, unless the edit moves it to another host (§5) |
| Another key asks for a held name | The queue, marked as a takeover. Installed copies keep their pinned key (§5) |
| Names | One key per prefix (the card already holds that). One name per publisher strut. A short reserved list. A name must hold a package (§4) |
| The ping | `POST /index/ping { key }`, open and rate-limited. The publisher pings every index it listed on (§6) |
| Live rows | The same request, with `live: true`. The live URL is always the base (§7) |

## 1. The request

The publisher strut sends one JSON object, written in its RFC 8785 form
like every card (shown indented here):

```json
{
  "v": 1,
  "index": "<the index's key, z32>",
  "prefix": "openlaw",
  "key": "<the publisher's PUBLIC key, z32>",
  "base": "https://openlaw1.sphinx.chat:3355/lab",
  "description": "Legal research and drafting on CourtListener",
  "url": "https://openlaw.example",
  "seq": 1794268800000000,
  "sig": "<128 hex>"
}
```

| Member | Rule |
| --- | --- |
| `index` | The key of the index it is sent to. A request made for one index never works on another |
| `prefix` | The publisher's name (`PublisherInfo.name`), `[a-z][a-z0-9-]*` |
| `key` | The PUBLIC key, the one the row will name. Never the fleet key |
| `base` | Where the server is reached: `https` only, an origin plus at most one path segment (a mount such as `/lab`), no query, no fragment |
| `description`, `url` | Optional, as on a row today. `description` up to 280 characters |
| `remove` | Optional, `true`: take the row away. Nothing else is read |
| `seq` | Microseconds since the epoch at signing, the card's clock |
| `sig` | Ed25519 by `key` over `strut-listing\n` + the fingerprint, as a catalog is sealed (`card.ts`, `sealCard`) |

**Why a base and not catalog URLs.** A trusted host also serves files
that someone other than its operator chose. A member of an org can list a
job's files and get a `?t=` link (`/jobs/:id/files`), and that file could
hold a catalog sealed by any key. If the request named a URL, such a link
on `openlaw1.sphinx.chat` would pass as that swarm's catalog. The index
builds the one URL itself, `<base>/packages/catalog?public=1`. The path
ends in strut's catalog route, which serves only the public catalog store
with that query (`publicPackageRead`, `src/auth.ts:721`), and the query is
exactly `public=1`, so a link that opens with a token can never pass as a
catalog. The one-segment rule keeps the base a server's root or its mount.
A publisher whose catalog lives elsewhere (a GitHub release, a laptop
upload) goes through the operator's door, as today (Later).

**Why no nonce.** The request is fresh when `seq` is within ten minutes of
the index's clock, and new when it is greater than the last `seq` the
index accepted from that key (one small file per key, the card's own
rule). A replay fails one of the two. A store of nonces would add state
and no extra guarantee.

**Who sends it.** The publisher strut's server holds the public key's
seed, and the browser never does. A new route, `POST /publisher/listings
{ index, base, description?, url? }` (full scope: a person's act, like
publishing), names one of the indexes this strut follows
(`/packages/indexes`). It:

1. refuses without a public key (`publisher_not_public:`, made by the
   first **Make public**) or without a publisher name;
2. takes `index` from the followed record's key. That key was pasted or
   built in, never read off the network;
3. seals the request and POSTs it to the index strut beside the followed
   card URL (`https://index.stakwork.ai/index/catalog` →
   `https://index.stakwork.ai/index/requests`);
4. keeps the answer in `<dataDir>/packages/listings.json` (plain JSON,
   nothing secret): index id, prefix, base, status, reason, time.

`DELETE /publisher/listings/:index` sends `remove: true`.

**In the UI.** The Packages tab's head shows the public key once there is
one (`PackagesPanel.tsx:173`). Beside it goes one line per followed
index: **List on index.stakwork.ai**. The button opens a small form: the
base, prefilled with the address the page is served at (`location.origin`
+ the mount), the description, and the homepage. The line then reads
**Listed**, **Waiting for approval** or **Refused: <reason>**. "Listed" is
read off the index card that `indexes.ts` already reads: our prefix with
our public key. So an approval shows up without the index calling back.

**What the index checks, cheapest first** (nothing is fetched until the
first five pass):

1. The body is under 8 KB, in its one canonical form, `v: 1`, and every
   member has its shape (`listing_invalid:`).
2. `index` is this index's key (`listing_invalid:`). An index with no key
   yet answers `503 index_no_key:`. Its first row is the operator's, which
   mints the key.
3. `seq` is fresh, and greater than the last from `key`
   (`listing_rollback:`).
4. The seal verifies against `key` (`listing_invalid:`).
5. `prefix` is not reserved (`listing_reserved:`) and was not refused for
   this key in the last 30 days (`listing_refused: <the reason>`).
6. Unless `remove`: `<base>/packages/catalog?public=1` reads as a card
   sealed by `key` (`fetchCatalog`, `src/packages/pk.ts`), and lists at
   least one package under `prefix` (`listing_no_catalog:`, naming the URL
   and what it answered). One catalog read: the existing 4 MB cap and 30 s
   timeout apply. No archive is fetched until the row exists.
7. The decision (§2, §5).

**Answers:** `200 { status: "listed", row }`, `200 { status: "removed" }`,
`202 { status: "pending", id }`, or an error with its code, `400`, `403`,
`409`, `422` and `429`, as above. Re-sending is how a publisher asks
again. A request for the same prefix from the same key replaces the one
waiting, and the answer says where it stands.

## 2. Who is listed without a person

The index can prove two things: the sender holds the key, and the server
at the base publishes with that key over TLS. It cannot prove a right to
the NAME. That is a judgment, and "without a person" means the operator
made it in advance for a class of publishers.

| Candidate | What it trusts | For a swarm | For a Stadeum box | Cost |
| --- | --- | --- | --- | --- |
| **An auto list of hosts** | The operator vouches for a host pattern: everything under it is accountable to them | Yes: swarms are `*.sphinx.chat:3355` | Only if Stakwork ever hosts boxes under its own domain | One setting on the index |
| An allowlist of keys | The operator knew the key beforehand | The key exists only after Make public, so someone still has to tell the operator | Same | Today's curl, minus the URL |
| A voucher (Hive, a host provider) signing `{ prefix, key }` | The voucher's key | Hive knows each swarm's workspace, but Hive is going away | A provider of hosted boxes could vouch | A key and a signing route on the voucher, a trust list on the index |
| A domain proof (a TXT record, a `/.well-known/` file) | Whoever controls a domain | Not needed: the TLS fetch already proves the host | A box on its own domain could prove it, but a domain does not say which NAME it should get | DNS reads, and a rule from domain to name |
| First come, first served | Nothing | Yes | Yes | Squatting, cured only by delisting |

**Start with the auto list of hosts.** The index's operator sets
`STRUT_INDEX_AUTO_HOSTS`, a JSON list of `host[:port]` patterns (one `*`
label at the front), to `["*.sphinx.chat:3355"]` on index.stakwork.ai: the
port the swarms' lab listens on, so no other service under sphinx.chat
qualifies. A request is listed at once when:

- the base's host matches a pattern;
- no row holds the prefix;
- no row names the key, and none names the base's host. Each swarm runs
  one strut with one public key, so one swarm gets one name with no
  person. A second name, or a second key on the same host, waits for the
  operator.

`["*"]` is first come, first served for everyone, and `[]` (the default)
sends everything to the queue. So the same setting covers "fully open to
certain publishers" and "fully open", and the operator widens it when a
squat would cost less than the queue does.

A Stadeum box on its own domain (`strut.acme.com`) waits in the queue,
which is right while few of them publish. When Stadeum hosts boxes under a
domain of its own, that pattern joins the list.

**What each check proves:**

| Check | Proves |
| --- | --- |
| The seal by `key` | The sender holds the publisher's public key |
| `index`, fresh and increasing `seq` | The request was made for this index, now, and is not a replay |
| `<base>/packages/catalog?public=1` over TLS, sealed by `key` | The server at that host publishes with that key |
| A package under the prefix in it | The name is used, not held for later |
| The host in the auto list | The operator vouches for that host's operator |
| Nothing | A right to the name. That is the operator's call, in advance (the list) or in the queue |

## 3. The queue and the operator's page

A request that is not listed at once is kept as
`<dataDir>/packages/catalogs/index/requests/pending/<id>.json`. The id is
the request's fingerprint. The file holds the request as sent and what the
index read: the catalog's `seq` and digest, the package names under the
prefix, the base's host, and why it waits:

- `host` — not in the auto list;
- `second name` — the key already holds a row;
- `same host` — the host already holds a row;
- `move` — an edit to another host (§5);
- `takeover` — another key holds the name (§5).

One request waits per (prefix, key). Every decision is appended to
`requests/log.jsonl` (time, prefix, key, host, outcome, who decided, why),
which is what a dispute starts from.

**The operator's routes** (full scope):

- `GET /index/requests` lists the waiting requests and the refusals of
  the last 30 days.
- `POST /index/requests/:id/approve` reads the catalog again and calls
  `setRow`. On a takeover, that replaces the key.
- `POST /index/requests/:id/refuse { reason }` keeps the reason for 30
  days. A re-send in that time gets it back.

**The page.** The index strut serves the store to visitors, and the shell
to whoever holds its key. The Publish dialog already has two tabs about
what this server shows the world (Packages, Public view). It gains a third,
**Index**, rendered only when the index role is on:

- **Waiting**: one row per request — the name, the key (short), the host,
  the description, the packages its catalog holds, and the reason it
  waits, a takeover in red — with **Approve** and **Refuse** (a reason box).
- **Listed**: one row per card row — the key, the URLs, the last crawl and
  its error — with **Delist**. **Add by hand** is today's `PUT
  /index/:prefix`.

A dot on the **Publish** button while something waits is the only
notification in v1. The operator is one person, and requests are rare.

## 4. Names

- **One key per prefix.** The card already maps a prefix to one row.
- **One name per publisher strut.** A publisher has one `name`, and its
  packages are named under it (`plans/packages-ux.md` §2). A key that
  wants a second name asks with a second request, which waits for the
  operator. The operator may still list one key under several names by
  hand.
- **Reserved names.** A built-in list for what strut and Stakwork already
  mean: `strut` (strut's own app namespace), `stakwork`, `sphinx`, `hive`,
  `stadeum`, `peel`, `jamie`, `index`, `official`, `admin`. Plus
  `STRUT_INDEX_RESERVED`, a JSON list. A request for a reserved name is
  refused. Only the operator's door lists one.
- **Squatting.** A name must hold a published package. The auto lane is
  one name per swarm, and a swarm is a known Stakwork customer. The
  operator delists anything. That is enough while the auto list is swarms
  only. Opening the list to everyone needs an idle rule (Later).
- **Disputes.** The operator decides, out of band, using the log. The
  outcome is a delisting or a new key on the row. Neither touches a strut
  that already installed (§5).
- **Renames.** A rename is a new name: a request for the new prefix (it
  waits, since the key holds a row), then `remove` for the old one. An
  installed `old/x` never becomes `new/x`. Every item of an installed
  package is named under its prefix, so to installers a renamed package is
  a new package.

## 5. After listing

| Change | How | A person? |
| --- | --- | --- |
| Description, homepage, a new path on the same host | A request from the row's key | No |
| The base moves to another host (a swarm's host changes) | A request from the row's key | **Yes**: the queue, as `move`. With automatic moves, a stolen key alone could point new installs at the thief's server. Without them, a thief also needs the publisher's host |
| Delisting | A request from the row's key with `remove: true`, or **Delist** on the operator's page | No |
| A new key (the old one lost) | A request from the new key | **Yes**: the queue, as `takeover`. A lost key cannot sign a hand-over |
| A compromised key | The operator delists the row, or approves the publisher's new key | Yes |

**What a strut that already installed does when the row's key changes:
nothing.** Each install pinned the key and the catalog URL it resolved
(`upstream.key`, `upstream.source.url`, `pk.ts`). None of that is read
from the index again.

- Installing the same name again from a person's door now resolves to the
  new key. A different digest is refused (`package_update_not_built:`,
  `src/packages/install.ts:537`). Once marketplace §4's person update is
  built, it compares the row with `upstream.key` and asks, naming both
  keys (§13, "Key loss and rotation").
- A subscription follows its own key, never the index.
- Only NEW installs follow the new row.

**A compromised key** can seal catalogs that every strut pinned to it
reads as its publisher's. An update asks a person (marketplace §8), but
that person cannot tell. Delisting stops new installs and takes the pages
out of the store. A warning on installed copies needs a revocation member
on the card that readers check (Later).

## 6. The ping

**On the index.** `POST /index/ping { key }`, open to anyone like
`/index/requests`. It crawls the rows that name `key` — at most one crawl
per row a minute, a ping inside that minute folded into one more crawl at
its end, the way `syncAll` folds pings (`src/packages/subscriptions.ts`).
A ping carries nothing: the index reads the catalog from the row's own
URLs, checked against the row's key. So a forged ping costs one catalog
read a minute at most. The peer-credential ping on
`/packages/subscriptions/sync` stays as it is.

**On the publisher.** `pingPublic` (`createStrut.ts:3933`) already runs
when the public catalog changes. It also POSTs `{ key }` to
`<index>/index/ping` for every index in `listings.json`. So listing sets
up the ping, and a release shows up in the store within seconds. The
10-minute poll stays as the fallback.

## 7. Live rows

A live row (`plans/public-surface.md` §8) has no key of its own. It says
where a server's public view is, and the store FRAMES apps from it — more
trust than a catalog, which is data checked against a key. So a live row
comes only with a keyed row:

- `live: true` on the same request asks for `live[prefix] = { url: base }`.
  It is decided with the row: listed at once in the auto lane, queued
  otherwise. `live: false` removes it.
- The URL is always the base, the server that just proved it holds the
  key. A request never names it separately.

The operator's `PUT /index/live/:prefix` stays for a server with no key.

## 8. Abuse and limits

| Concern | Limit |
| --- | --- |
| Request and ping floods | A per-address budget on the two open POSTs (`visitorAddress`, `src/public-routes.ts`): 10 a minute each |
| Expensive requests | The seal and the name are checked before any fetch. One catalog read per request, 4 MB and 30 s. No archive until listed |
| A full queue | 200 waiting requests in all, 3 per host. Past that, `429 listing_busy:`. A request waits at most 30 days |
| The same ask again | A refusal is returned for 30 days without a fetch |
| Crawl load | Unchanged: every row every 10 minutes, plus pings at most once a minute per row. A thousand rows is under two catalog reads a second |
| Archive size | Unchanged: `MAX_ARCHIVE_BYTES` (64 MB), `MAX_UNPACKED_BYTES`, `MAX_ARCHIVE_FILES` (`src/packages/archive.ts`). Only each package's newest release is read, once per digest. A listed publisher that abuses this is delisted |

## Tests

- **The request** (`index.test.ts`, over a stub fetch): a non-canonical
  body, a bad seal, another index's key, a stale `seq` and one not after
  the last, a reserved name, a base with two path segments or a query, a
  catalog sealed by another key, and a catalog with no package under the
  prefix are each refused with their code, and the five cheap checks fail
  with no fetch.
- **The auto lane**: a base on an auto host is listed. A second prefix
  from the same key waits. A second key on the same host waits. A host
  not on the list waits.
- **The URL is built**: a sealed catalog served as a job file with `?t=`
  on an auto host never lists, whatever base is sent.
- **Edits**: a new description on the same host is applied. A move to
  another host waits. `remove` delists.
- **The queue**: a takeover waits, marked. Approve replaces the key. A
  refuse is answered on the next send.
- **The ping**: open with the role on, it crawls only the rows naming the
  key, at most once a minute per row.
- **The gate sweep**: the two POSTs open only with the role on. The
  operator's routes are behind the key.
- **The seal** (`card.test.ts`): a fixed listing request with its
  fingerprint and seal, for another implementation to check against.
- **The publisher**: it signs with the PUBLIC key under
  `strut-listing\n`, refuses before **Make public**, records the answer,
  and pings every listed index after a release.

## Work items (one PR each)

Before item 2 helps anyone, index.stakwork.ai needs its key and strut's
default must name it. Its first row (openlaw, by hand) mints the key, and
`DEFAULT_PACKAGE_INDEXES` (`indexes.ts:51`) is a one-line PR of its own
after that. A strut can also follow the index by hand meanwhile.

1. **Index: the request and the open ping.** The `listing` card kind
   (`card.ts`), `POST /index/requests`, `POST /index/ping`, the queue on
   disk with its log, the operator's three routes, the auto lane
   (`STRUT_INDEX_AUTO_HOSTS`), reserved names (`STRUT_INDEX_RESERVED`),
   the gate, the budgets, `deploy/index/env.example`, `specs/API.md` §16
   and AGENTS.md's env table. Then set `STRUT_INDEX_AUTO_HOSTS` on
   index.stakwork.ai.
2. **Publisher: ask and ping.** `POST`/`DELETE /publisher/listings`,
   `listings.json`, `pingPublic` pinging listed indexes, and the Packages
   tab's **List on …** line. With items 1 and 2, a swarm lists itself, and
   a Stadeum box's request waits for a curl to the approve route. A swarm
   gets item 2 with mcp's next strut pin bump.
3. **Index: the operator's tab.** The Publish dialog's **Index** tab
   (waiting, listed, add by hand) and the dot on **Publish**.
4. **Live rows through the request.** `live` on the request, applied with
   the row.

## Later

- **A hand-over** signed by the old key, so a planned key change needs no
  person.
- **A catalog served elsewhere** (GitHub Releases, a laptop's upload): a
  request with `urls`, which needs some other proof for the host — a
  domain record, or the operator.
- **A domain proof** (`_strut.<domain>` TXT, or a `/.well-known/` file),
  for a Stadeum box on its own domain, once a rule from a domain to a
  name is worth having.
- **A voucher key** (a provider of hosted boxes) signing `{ prefix, key }`,
  trusted by the index like an auto host.
- **First come, first served for everyone** (`["*"]`), with an idle rule:
  a row whose catalog has not read for 30 days, or holds no package under
  its name, is dropped.
- **Revocation**: `revoked: { <key>: { at, reason } }` on the index card,
  which a newer reader warns about before installing or updating from
  that key. Older readers ignore the member.
- **A notify URL** for waiting requests (a tribe, a webhook).
- **Provenance in the store**: "listed automatically, served from
  openlaw1.sphinx.chat", and "this name changed keys on …".
- **Conditional reads** (ETag) on the crawl, and a byte budget per
  publisher.
- **Pkarr** (marketplace step 6b): once a key's record says where its
  catalog is, a request needs no base.

## Open questions

1. **The auto lane is a host pattern, `*.sphinx.chat:3355`.** Is that the
   class you meant by "certain publishers"? *Recommended: yes.* It costs
   nothing on the swarms, gives one name per swarm, and every swarm has a
   known owner. Stadeum boxes queue until Stadeum hosts some under its own
   domain.
2. **A request names a base, not catalog URLs.** That leaves a publisher
   whose catalog sits on GitHub Releases to the operator. *Recommended:
   yes for v1.* It is what makes the auto lane safe (§1).
3. **Edits from the row's key apply at once, but a move to another host
   waits.** *Recommended: yes.* Otherwise a stolen key alone redirects new
   installs.
4. **Another key asking for a held name is queued, not refused.**
   *Recommended: queue.* It is the only way back for a publisher who lost
   its key, and the operator sees it marked.
5. **The reserved list.** *Recommended:* `strut`, `stakwork`, `sphinx`,
   `hive`, `stadeum`, `peel`, `jamie`, `index`, `official`, `admin`, plus
   `STRUT_INDEX_RESERVED`.
6. **A name must hold a published package before it is listed.**
   *Recommended: yes.* It stops reserving names, and **Make public**,
   which mints the key that signs, comes first anyway.
7. **The operator's page is a third tab of the Publish dialog,** shown
   only on an index, with a dot as the only notification. *Recommended:
   yes.* A separate page or a webhook is more to build for one operator.
8. **Live rows ride on the same request (item 4).** *Recommended: yes*,
   with the base as the only URL.
