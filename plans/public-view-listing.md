# Listing a public view with no package

> **Status (2026-11-11): RULED, not built.** The owner took all seven
> open questions as recommended (below), so every "proposed" in this plan
> is decided. Written after a read of strut `main` @e2c44d57, on
> `plans/index-listing.md` (self-serve listing, BUILT 2026-11-10) and
> `plans/public-surface.md` §8 (live rows). A new file rather than a
> section of `index-listing.md`: that plan is marked built, and this one
> is not.

## Problem

A strut server can share two things through a package index:

- **Packages**, the signed copies in its public catalog, sealed by its
  PUBLIC key. A publisher row on the index card binds a name to that key.
- **Its public view**: the live `/public` reads, including the workflows
  and steps anyone may run, free or for sats (`plans/paid-runs.md`). A live
  row in the card's `live` map points the store at the server's base.

Self-serve listing lets a server ask for both with one signed request
(`live: true`). But a server whose only public thing is its view cannot
ask at all:

| Step | Where | Why it fails with no public package |
| --- | --- | --- |
| Seal the request with the public key | `sealListing`, `src/packages/publisher.ts:170` | The key is minted only by **Make public** on a package channel (`makePublic`, `:145`). Before that: `publisher_not_public: … make a package public first` |
| The index proves the base holds the key | `readCatalog`, `src/packages/index-requests.ts:223` | It reads `<base>/packages/catalog?public=1`, which answers 404 "made nothing public yet" (`src/createStrut.ts:4564`) |
| The index checks the name is used | the same read | It wants a package under `<prefix>/` |
| The UI offers the ask | `ListingLines`, `web/src/components/PackagesPanel.tsx:214` | The line is hidden until a public key exists (`:224`), and it lives in the Packages tab, which a server with no package has no reason to open |

The one path that works is the index OPERATOR adding a live row by hand,
with no key: `PUT /index/live/:prefix { url }`.

**openlaw-1 itself is not blocked.** index.stakwork.ai's card (read
2026-11-11) lists `openlaw` with openlaw-1's public key (`rjjisx4jww…`,
from `openlaw/legal-desk`) and no live row, and openlaw-1's `/lab/public`
shows `public-echo` as runnable for free. In its Packages tab, **Change**
on the index line with **Also show this server's public view in the
store** ticked is the row's own key editing its row on the same host, so
it is listed at once (`index-listing.md` §5, §7). That needs openlaw-1's
strut to include self-serve listing. This plan is for the next server:
one that shows a free workflow and has published nothing.

| Strut has | Strut lacks |
| --- | --- |
| The public key, minted by **Make public** | A way to mint it without a package |
| The public catalog, sealed by that key, served at `?public=1` | One to serve before any package is public |
| A desk that proves the base holds the key by reading that catalog | A check that the NAME is used other than "it holds a package" |
| Keyed rows with every per-key rule: `seq`, the auto lane, same host, takeover, moves, the ping, "Listed" | Those rules for a live row, which has no key |
| A ping by key that re-reads that prefix's live row too (`crawl({ prefix })`, `src/packages/index.ts:744`) | A ping when the public VIEW changes: today only a catalog change pings |

## The idea

The first listing request mints the public key, and the server seals an
**empty public catalog** with it. The index reads that catalog exactly as
it does today: it proves the server at the base holds the key, whether the
catalog lists packages or not. When it lists none under the name, a
non-empty public view counts as the name being used, but only if the
request asks for the view (`live: true`). What gets written is an ordinary
keyed row whose catalog is empty, plus the live row at the base.

No new card kind, no new route, and the index card keeps its shape. Every
per-key rule in `index-listing.md` holds as written, because the row is a
keyed row. When the server later makes a package public, the row it
already has starts listing it, with no second request.

## Decided

| Question | Decision |
| --- | --- |
| When the public key is minted with no package | At the first listing request, `POST /publisher/listings` (§1) |
| What the server serves before a package is public | An empty public catalog sealed by the public key, written when the key is minted (§1) |
| What proves the base holds the key | That catalog, read as today: one URL, no redirect, 4 MB (§2) |
| What proves the name is used | A package under the name, OR `live: true` and a `<base>/public` that shows something (§2) |
| How it sits on the card | A keyed `publishers` row whose catalog is empty, plus `live[prefix]`. No new member (§3) |
| The desk's rules | Unchanged. One refinement: a server the operator hand-listed as a live row at the same URL claims it at once (§4) |
| A later package under the same name | Nothing to ask: the ping crawls the row and the package shows (§4) |
| Where in the UI | A section **In the store** in the Public view tab, the same component as the Packages tab's line (§5) |
| Pinging a view change | `PUT /public-view` pings every index the server asked (§6) |
| Agents | `/llms.txt` and the index's MCP tools learn live items, as a separate work item (§6) |

## 1. The public key without a package

`Publisher` gains `ensurePublic()`: it mints the public seed when there is
none and marks no channel. `makePublic(channel)` keeps minting through the
same code. `POST /publisher/listings` (full scope, a person's act) calls it
and then, when `publicCatalogs.current()` is empty, seals
`{ v: 1, seq: <now>, packages: {} }` with the public key and stores it,
one write at a time with the other catalog writes (`oneAtATime`).

- `publisher_not_public:` leaves the listing route. `publisher_no_name:`
  stays: the Public view tab asks for the name inline (§5).
  `publisher_unsafe_key:` stays (a file store with `STRUT_SECRET_KEY` unset
  mints nothing), 409.
- `GET /packages/catalog?public=1` then serves the empty catalog instead of
  404. A `pk:` install against it fails with `package_not_published`, as
  for any name a catalog does not list.
- What it shows the world: the public key, and that the server publishes
  nothing publicly. The fleet catalog stays private: `projectPublic`
  carries only public channels, so a fleet-only package never reaches the
  public catalog.
- A later **Make public** keeps the key. The next public catalog is sealed
  after the empty one, its `seq` higher, and `pingPublic` pings the index
  (`createStrut.ts:4604`). The fleet catalog names the public key from the
  next seal on, as it does for any public key.

Alternatives:

- **At the first public-view save.** Every server that shows anything gets
  a key it may never use, and `PUT /public-view` starts writing the
  publisher file.
- **By an explicit act** ("Make this server's identity public"). One more
  button that means nothing to a person.
- **Serve nothing before a package** (404 as today), and prove the key
  another way (§2's alternatives).

## 2. What the index checks

Steps 1–5 of `index-listing.md` §1 do not change: shape, the index's key,
`seq`, the seal, the name. Step 6 splits in two.

**6a. The base holds the key.** `<base>/packages/catalog?public=1` reads as
a card sealed by `key`: one URL the index builds, no redirect, read no
further than 4 MB, 30 s. This is the same read as today. An empty catalog
proves the key as well as a full one.

**6b. The name is used.** Either:

- the catalog lists a package under `<prefix>/` (today's rule); or
- the request says `live: true`, and `<base>/public` shows at least one
  thing the store would show: an app, a workflow, a step, a Concept root,
  or an item anyone may run. Node types alone do not count. Same base, one
  URL, no redirect, 4 MB, 15 s (the live crawl's timeout).

Otherwise `listing_no_catalog:`, naming both reads: "lists no package
under `openlaw/`, and its public view at `<base>/public` shows nothing" (or
"…and the request does not ask for its public view"). A waiting request
keeps `view: { apps, workflows, steps, concepts, runnable }` beside
`catalog`, so the operator's Index tab can say "public view: 1 workflow, 1
runnable" where it lists package names today. `approve` reads both again.

**Why a stranger cannot list someone else's server.** An attacker who
holds key K asks for the victim's base B. B's public catalog is sealed by
B's own key, not K, so step 6a fails before `/public` is read. B serves a
catalog sealed by K only if whoever runs B put it there. The URL is built
by the index and ends in the catalog route with exactly `public=1`, so a
job file opened with `?t=` on the same host never passes as the catalog
(`index-listing.md` §1, "Why a base"). `/public` is unsigned. It is read
only for "is the name used", never for "whose server is this".

Alternatives:

- **`GET /public` answers the public key** (a `key` member). One read
  instead of two, but an unsigned echo becomes a second kind of key proof
  in the desk, and every public view carries the member.
- **A signed statement on a new route** (a `listing`-kind card naming the
  base). A route and a card shape for what the empty catalog already is.
- **A challenge**: the index asks the base to sign a nonce. A new open POST
  on every server, and a round trip.
- **No "used" check**: any key may hold a name with an empty view. That is
  squatting, which `index-listing.md` §4 rules out.

## 3. The row on the card

The desk writes what `rowOf` writes today:

- `publishers[prefix] = { key, urls: ["<base>/packages/catalog?public=1"], description?, url? }`
- `live[prefix] = { url: base, description? }` (what `live: true` writes
  today)

What follows:

- **Older readers.** No member is added to the card. `indexShapeProblem`
  checks `publishers` rows and ignores `live`, so a strut of any age reads
  the card as before.
- **`seq` and per-key rules.** All unchanged: the request's `seq` per
  public key, the public catalog's `seq` per public key, and the index
  card's `seq` per index key.
- **The crawl.** It reads the empty catalog (0 packages, no error) and the
  live view. Search, package pages and `/llms.txt` have nothing under the
  row. The store's live sections show its items.
- **Installs.** A bare `openlaw/x` resolved through the row fails with
  `package_not_published`, as for any name the catalog lacks.
- **The ping.** `POST /index/ping { key }` already crawls every row naming
  the key with `crawl({ prefix })`, and that reads the prefix's live row
  too (the `!filter.key` branch, `index.ts:744`). The keyed row is the only
  change that lets a server ping its live view. A live row with no key is
  never pinged, only polled.

Alternatives:

- **`live` alone, with a `key` member on the live row.** Older readers
  would ignore the member. But every desk rule (second name, same host,
  takeover, move, remove, the ping, "Listed") and the crawl would need a
  second branch that reads keys off `live`, and a later package would need
  a second request to add the `publishers` row.
- **A new map (`views`).** The same work, plus another member every reader
  skips.

## 4. The desk's rules

The row is a keyed row, so `index-listing.md` §2–§5 apply as written:

| Rule | For a view-only listing |
| --- | --- |
| Auto lane (`STRUT_INDEX_AUTO_HOSTS`) | Listed at once on an auto host, for a free name, from a key and a host that hold no row. One name per swarm, as for packages |
| Reserved names | Refused |
| Same host, second name | Waits |
| Move (the row's key, another host) | Waits |
| Takeover (another key holds the name) | Waits, marked |
| A refusal | Answered for 30 days, as today |
| `remove` | Drops the row and the live row (`remove` already drops `live[prefix]`) |
| `live: false` on a row whose catalog holds no package | Refused with `listing_no_catalog`, saying to take the row off instead. A request is the whole state wanted, and nothing would be left to list |

**The operator's no-key live rows** (`PUT /index/live/:prefix`). Today a
request for such a name waits as `live row`, and approving it lists the
key and moves the live row to the base. The refinement (ruled 2026-11-11): when the
request's base is that live row's URL (both normalized), the server the
operator already listed is the one asking. It is listed at once and logged
as `claimed`, as if it were the row's own key editing its row. A request
from any other base still waits as `live row`. index.stakwork.ai has no
live row today, so this matters only to an operator who listed a view by
hand first.

**Later, the same server publishes a package publicly.** There is nothing
to ask. **Make public** moves the public catalog, `pingPublic` pings every
index the server asked, the index crawls the row, and the package is
listed under the name. The name cannot differ, because `POST
/packages/publish` refuses a package outside the publisher's name. The live
row stays until the server sends `live: false`.

**The other way round**, a server listed for packages adding its view,
already works: the Packages tab's **Change** with the live box ticked
(`index-listing.md` §7). That is openlaw-1's path today.

## 5. In the UI

**The Public view tab** gains a section, **In the store**, with one line
per followed index. It is the same component as the Packages tab's
`ListingLines`, in a view mode:

- It shows once the SAVED view shows something, before any public key
  exists. With nothing saved: "Save something here first: an index lists a
  view that shows something."
- The form: the name, only when the publisher has none ("The name the store
  shows this server under. Packages published from here later go under it
  too. Set once."), this server's address (prefilled, as today), the
  description and the homepage. There is no live box: showing the view is
  what this tab is for.
- **Show on index.stakwork.ai** sends `PUT /publisher { name }` when needed,
  then `POST /publisher/listings { …, live: true }`.
- States, read off the index's signed card as the Packages tab reads them:
  - **Shown**: our name, our public key, and `live[name].url` is our base.
  - **Listed, view not shown**: the row is ours, with no live row (a server
    listed for packages). The button is **Show the public view too**.
  - **Waiting for approval**, with why (`WAIT_WORDS`).
  - **Refused: <reason>**.
  - **Name held by another key**.
- Taking it off depends on what else the row lists. If the public catalog
  holds a package, the button is **Stop showing** (`live: false`, the row
  stays for the packages). If it holds none, the button is **Take off**
  (`remove`).

**The Packages tab** does not change, except that its **Listed** badge says
"· public view shown" when the live row is there.

`GET /publisher/listings` adds `live?: IndexLiveRow` to each line (the
card's live row under our name), and the Public view tab reads it.

Alternatives:

- **The Packages tab only**, where the line is today. A server with no
  package has no reason to open it, and the line hides there until a
  public key exists.
- **The Public view tab only.** The Packages tab's tick stays useful for a
  server that has both, and removing it would break the flow built on
  2026-11-10.

## 6. What else changes

- **The ping on a view change.** After a save, `PUT /public-view`
  (`createStrut.ts:3536`) calls `listings.ping(publicKey)`, so a newly
  runnable workflow reaches the store within seconds instead of at the
  10-minute crawl. The index side already re-reads a keyed prefix's live
  row on a ping (§3), and the desk's one-crawl-a-minute fold applies. A
  served box (`STRUT_SERVE`) does the same after a deploy that changed its
  view.
- **The store.** Nothing changes for live items: the store reads
  `card.live[prefix]` and `/index/live`. One small change: the Browse page's
  Publishers section lists a view-only row with its key and no packages.
  Such a line says "public view only" and links to the row's live items.
- **`/llms.txt` and the index's MCP tools.** Today neither shows any live
  row (`src/packages/index-tools.ts` reads packages and Concept pages
  only). That gap belongs to live rows in general, not to this plan, but
  it decides whether an agent finds `public-echo`. Proposed:
  - `/llms.txt` gains `## Live`: each item anyone may run there, with its
    publisher, price, and the server's own `/llms.txt`, which already says
    how to run and pay (`src/public-agents.ts`).
  - A fourth MCP tool, `search_live { query? }`, over `index.live(q)`.
  - This is its own work item (below).
- **`specs/API.md`.**
  - §16: `POST /publisher/listings` mints the key, no longer answers 409
    `publisher_not_public`, and needs `live: true` when the server has no
    public package.
  - §16: `GET /publisher/listings` lines gain `live`.
  - §16: `GET /packages/catalog?public=1` serves an empty catalog once a
    public key exists.
  - §16: `POST /index/requests` gets step 6b and `view` on a waiting
    request.
  - §17: `PUT /public-view` pings.
- **Docs.** AGENTS.md's lines for `listing.ts`, `index-requests.ts`,
  `publisher-listings.ts` and `PublicViewPanel.tsx`, and a pointer in
  `index-listing.md` §7.

## Tests

- **The publisher** (createStrut over a stub index):
  - `POST /publisher/listings` with no public key mints it and seals an
    empty public catalog, and `GET /packages/catalog?public=1` serves that
    catalog sealed by the key.
  - On a file store with `STRUT_SECRET_KEY` unset, it is refused with
    `publisher_unsafe_key`.
  - A later **Make public** keeps the key and moves the public `seq` on. A
    fleet-only package never appears in the public catalog.
- **The desk** (`index-requests`, over a stub fetch):
  - `live: true`, an empty catalog and a view with one runnable workflow,
    on an auto host: listed, with a keyed row and a live row.
  - The same with an empty view: `listing_no_catalog` naming `/public`.
  - No `live` and an empty catalog: `listing_no_catalog`, as today.
  - A catalog at the base sealed by another key: refused, with no `/public`
    read. This is the "stranger cannot list someone else's server" case.
  - A redirect on `/public` is refused.
  - `live: false` on a row with no package is refused and says to use
    `remove`.
  - Second name, same host, takeover and move each wait, as today, with an
    empty catalog.
  - An operator's no-key live row at the request's base is claimed at once.
    One at another URL waits as `live row`.
  - Approve reads both again.
- **The crawl.** A keyed row with an empty catalog crawls cleanly (0
  packages). A ping by its key re-reads its live row.
- **A later package.** The server makes a package public, the ping
  arrives, and the index lists it under the row with no new request.
- **An older reader.** A card with a view-only row reads through `readCard`
  (no new member).
- **The view ping.** `PUT /public-view` pings the indexes the server asked,
  and only those.
- **The UI.** The Public view tab's line before a key exists, the name
  asked inline, and the Shown, Waiting and Refused states read off the
  card.

## Work items

1. **A view-only server lists itself.** `ensurePublic` and the empty
   catalog, the desk's step 6b with `view` on a waiting request, the
   claimed live row, `live` on a listing line, the ping after `PUT
   /public-view`, the Public view tab's **In the store**, the Index tab
   showing a view-only request's view, the store's "public view only"
   publisher line, `specs/API.md`, AGENTS.md. One PR: the pieces only help
   together. A swarm gets it with mcp's next strut pin bump.
2. **Agents find live items.** `## Live` in the index's `/llms.txt` and
   `search_live` on `/index/mcp`. Independent of item 1: it also covers
   rows the operator listed by hand.

## Later

- **An idle rule that knows views.** `index-listing.md`'s "Later" drops a
  row that "holds no package under its name". As written, that would drop
  every view-only row. When it is built, a row counts as used while its
  catalog holds a package OR its live view shows something, and a
  view-only row whose view has shown nothing for 30 days is dropped.
- **Signed views.** Each live item is what its server says now, over TLS
  (`public-surface.md` §8). Signing a view would make a live item as
  checkable as a release, at the cost of a sealed `/public`.
- **A server the index cannot reach** (a desktop strut behind NAT) still
  cannot list, for a view as for packages.

## Rulings (2026-11-11)

All seven taken as recommended.

1. **Mint the public key at the first listing request, and seal an empty
   public catalog with it.** *Ruled: yes.* Only a person's ask mints
   it, and the empty catalog is the proof step 6 already reads.
2. **The key is proven by that catalog, read as today; the name counts as
   used if it holds a package OR the request asks `live: true` and
   `/public` shows something.** *Ruled: yes.* It adds nothing new to
   prove and keeps the anti-squatting rule.
3. **A view-only listing is an ordinary keyed row with an empty catalog,
   plus the live row.** *Ruled: yes.* No card change, and every
   per-key rule holds.
4. **An operator's no-key live row at the request's own base is claimed at
   once.** *Ruled: yes.* The alternative is today's rule: wait as
   `live row`.
5. **`live: false` on a row with no package is refused, pointing to
   `remove`.** *Ruled: yes.*
6. **The UI is a section, In the store, in the Public view tab, sharing the
   Packages tab's component, with the name asked inline (it also becomes
   the package prefix).** *Ruled: yes.*
7. **`/llms.txt` and the MCP tools learn live items as a separate work
   item.** *Ruled: yes, after item 1.*
