# The server's wallet — what strut expects of it

`plans/paid-runs.md` §9. A server that sells runs RECEIVES sats in a wallet
it does not hold the keys to: the Sphinx daemon (the TREASURY, a second
`sphinx-daemon` container with its own seed, in no tribe) or any NWC
wallet. Strut makes invoices there, looks them up, lists what came in and
reads the balance — `ctx.services.lightning`, `src/payments/lightning.ts`.
Nothing it holds for that can pay: a PAY credential is stored apart
(`payments.json`) for the PAYER (`src/payments/payer.ts`, below), the one
thing in strut that sends sats out, which is never on the services bag.

This file is the contract each provider is built against:

- **The Sphinx daemon** (`src/payments/sphinx-daemon.ts`): four routes,
  and `POST /pay`, `POST /keysend`, `GET /keysend/:id` and
  `POST /keysend/:id/cancel` for the payer, built in the sphinx repo
  (`wasm/daemon/src/http.ts`, stakwork/sphinx#428; the keysend routes,
  stakwork/sphinx#431), and the three INVITE routes for a new worker
  (`POST /invite`, `GET /invites`, `POST /invite/:code/cancel`; "Invites"
  below), being built in the sphinx repo as strut's side lands.
  `src/payments/sphinx-daemon.test.ts` and `payer.test.ts` drive stand-ins
  that answer exactly this. And SUPPORT's three DM routes, with a token of
  their own ("Support's DMs" below, plans/support-chat.md §7;
  stakwork/sphinx#435); `scripts/fake-sphinx-daemon.ts` answers them.
- **NWC** (`src/payments/nwc.ts`): NIP-47 as it is; what strut sends and
  reads is listed below.
- **The payer** (`src/payments/payer.ts`): `POST /pay` on the daemon, as
  stakwork/sphinx#428 built it, and NIP-47's `pay_invoice`. Called by two
  doors only: `POST /earnings/withdraw` and an accepted `remote/buy-credit`.

## The capability

```ts
interface LightningCapability {
  makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<{ invoice: string; payment_hash: string; expires: string }>;
  lookup(payment_hash: string): Promise<{ state: "pending" | "settled" | "expired"; msat?: number; settled_at?: string; preimage?: string }>;
  received(o: { since?: string; limit?: number }): Promise<Array<{ payment_hash: string; msat: number; at: string }>>;
  balance(): Promise<{ msat: number }>;
}
```

Times are ISO 8601. `lookup`'s `msat` is what SETTLED, which a short
payment makes less than the invoice asked (§4.3 credits it in proportion).
`received` is settled payments only, oldest first, settled at or after
`since`, at most `limit` (100 by default, 1 000 at most). `expirySecs` is 1
to 86 400. A description is at most 639 bytes.

A failure is a `LightningError` whose `code` a caller acts on, and whose
message starts with it:

| `code` | Means |
| --- | --- |
| `wallet_unavailable` | Not reached, no answer in time, or failed on its side (5xx). A buyer is answered 503, never 402 (§4.3) |
| `wallet_unauthorized` | The wallet refused the credential, or the connection does not allow the method |
| `wallet_refused` | The wallet refused the request (4xx), in its own words |
| `invoice_unknown` | No invoice with that payment hash |
| `wallet_bad_answer` | An answer that is not the shape below (a preimage that does not hash to the payment hash included) |
| `bad_request` | The call itself was wrong; nothing was sent |

## The Sphinx daemon

Base URL: `LIGHTNING_DAEMON_URL` (or the Wallet form's `url`), http(s), no
credential, query or fragment in it; paths are appended. Every request
carries `Authorization: Bearer <receive token>` (`LIGHTNING_DAEMON_TOKEN`)
and `accept: application/json`; a body is JSON. Every error answer is the
daemon's usual `{ "error": "<sentence>", "code": "<code>" }` with a 4xx or
5xx status. Each call has 10 s.

### The receive token

A token beside the admin token (§9 item 5) that opens these four routes and
nothing else. The PAY token opens them and `POST /pay` (below).
Strut never holds the admin token: it cannot post, join or leave as the
account. A wrong or missing token is `401`; a token that may not call a
route is `403`. Strut reads both as `wallet_unauthorized`.

### `POST /invoice` — make an invoice

Today the route takes `{ sats }` and answers `{ invoice, sats }`, and an
invoice always lasts an hour. Strut sends:

```json
{ "sats": 10250, "description": "acme/voxel/character: credit for one run", "expiry": 600 }
```

| Field | |
| --- | --- |
| `sats` | whole sats, above 0 (as today). Strut sends only whole sats: an msat amount that is not one is refused before a request |
| `description` | optional, the invoice's `d` field, at most 639 bytes |
| `expiry` | optional, seconds, 1 to 86 400; the invoice's `x` field. Absent: an hour, as today |

It answers `200`:

```json
{ "invoice": "lnbc102500n1…", "sats": 10250,
  "payment_hash": "3f1c…64 hex", "expires_at": 1793001608 }
```

| Field | |
| --- | --- |
| `invoice` | BOLT11, as today |
| `sats` | as today |
| `payment_hash` | **new.** 64 hex characters, the invoice's payment hash |
| `expires_at` | **new.** Unix seconds when the invoice expires (its timestamp + expiry) |

An answer with no `payment_hash` or `expires_at` is today's daemon: strut
reports it as `wallet_bad_answer`, naming this file.

### `GET /invoice/:payment_hash` — one invoice

**New.** `:payment_hash` is 64 lowercase hex. The session already emits
`settled`; `wasm/bot`'s `check_invoice` reads the same core
(`auto.get_settled_payment_hash`). Answers `200`:

```json
{ "payment_hash": "3f1c…", "state": "pending", "expires_at": 1793001608 }
{ "payment_hash": "3f1c…", "state": "expired", "expires_at": 1793001608 }
{ "payment_hash": "3f1c…", "state": "settled", "msat": 10250000,
  "settled_at": 1793001200, "preimage": "9a2b…64 hex", "expires_at": 1793001608 }
```

| Field | |
| --- | --- |
| `payment_hash` | the invoice's; strut refuses an answer for another one |
| `state` | `pending` (not paid, not expired), `settled`, or `expired` (past `expires_at`, never paid) |
| `msat` | settled only: what SETTLED, which a short payment makes less than the invoice. A number; a decimal string (the core's `amt_msat`) is read too |
| `settled_at` | settled only: unix seconds |
| `preimage` | settled only: 64 hex. Strut refuses one that does not hash (sha256) to `payment_hash` |
| `expires_at` | unix seconds; optional |

An invoice the account never made is `404` with `{ "error": "no invoice …",
"code": "not_found" }` — `invoice_unknown`. The error must not begin `no
route `: that is how strut tells a daemon without this route (today's
`404 { error: "no route GET /invoice/…" }`, read as `wallet_refused`) from an
unknown invoice.

### `GET /payments?since=&limit=` — what came in

**New.** For the reconcile (§5, "Later") and a seller's received-by-day.

| Query | |
| --- | --- |
| `since` | optional, unix seconds: payments settled at or after it |
| `limit` | optional, how many at most |

Answers `200`, settled payments only, in any order (strut sorts them):

```json
{ "payments": [ { "payment_hash": "3f1c…", "msat": 10250000, "settled_at": 1793001200 } ] }
```

### `GET /balance` — the account's balance

**New.** Today the balance is on `GET /me` (`sats`), with the admin token.
Answers `200`:

```json
{ "msat": 1250000 }
```

### A short payment

§9 item 4: the core refuses a payment that carries less than its invoice
(stakwork/sphinx#428), so a settled `msat` is never below what the invoice
asked. Strut credits what SETTLED either way.

### `POST /pay` — pay an invoice (the payer)

With the PAY token (`LIGHTNING_DAEMON_PAY_TOKEN`); the receive token is
`403 { code: "forbidden" }`. As stakwork/sphinx#428 built it:

```json
{ "invoice": "lnbc…", "max_fee_msat": 50000 }
```

answers `200`:

```json
{ "payment_hash": "<hex>", "state": "settled", "fee_msat": 1200, "preimage": "<hex>" }
```

- **It waits up to 60 s** for the LSP, then answers `"state": "pending"`.
  The payer's call allows 75 s (`DAEMON_PAY_TIMEOUT_MS`).
- **Idempotent per payment hash.** POSTing the same invoice again reads
  where it stands: a pending one waits again, a settled one answers as
  before, and only a FAILED one is paid again. There is no `GET` for a
  payment, so this is how the payer reads a pending one (`status`).
- **`failed` carries `error`**, the LSP's words (`"not enough balance"`).
  `fee_msat` is 0 unless settled; `preimage` only when it hashes to the
  payment hash (the payer checks again and drops one that does not).
- **`fee_msat` is the ROUTE's fee, not always the one taken.** The mixer
  (`mixer/src/send.rs`, `openpay`) debits the amount, pays, and then
  debits the fee; when what is left is less than the fee, that debit fails
  and is only logged, while the daemon still reports the routing fee. So
  the payer reads `GET /balance` before a fresh pay and books the fee only
  when the balance less the amount covered it (`routingFeeMsat` carries
  the reported one). The whole balance can therefore be withdrawn.
- **A pending payment may never resolve.** When CLN does not answer within
  the mixer's budget, `openpay` answers PENDING, keeps the debit and never
  refunds it, and the daemon ignores a PENDING send, so every re-POST
  waits 60 s and answers `pending` again. Strut stops polling one an hour
  past its invoice's expiry and lets a person record it or drop it
  (specs/API.md §19).
- **The fee cap.** The LSP pays with CLN `pay`'s defaults — a routing fee
  of at most 0.5% of the amount, or 5 sats when that is more — and takes no
  cap of the daemon's. A `max_fee_msat` below that limit is refused before
  anything is sent, `400 { code: "max_fee_too_low" }` naming the limit; at
  or above it, the fee never exceeds `max_fee_msat`. A 10 000-sat
  withdrawal needs at least 50 000 msat. Strut's default cap is that limit
  (`lspFeeFloorMsat`, `src/payments/fee.ts`), which is also the most the
  LSP charges.
- **Refusals before sending**, all `400`: `bad_request` (not an invoice, or
  one with no amount), `own_invoice` (the account's own), `expired`,
  `max_fee_too_low`. The payer throws them as `wallet_refused` with the
  daemon's code as `walletCode`, and Withdraw answers them as they came.

### `POST /keysend` — send an amount to a Sphinx address (the payer)

With the PAY token, beside `POST /pay` (plans/human-steps.md §8.2): a worker's
payout is an amount sent to their account, not an invoice they made.

```json
{ "id": "<64 hex>", "address": "<pubkey>_<lsp_pubkey>_<scid>", "msat": 5000000, "max_fee_msat": 25000 }
```

answers `200`:

```json
{ "id": "<64 hex>", "state": "settled", "payment_hash": "<hex>", "fee_msat": 0, "preimage": "<hex>" }
```

`{ id, state, payment_hash?, fee_msat, preimage?, error? }`, the shape of
`POST /pay`'s answer plus the `id`.

- **`id` is the caller's key,** 64 hex. The same `id` again answers that
  payment as it stands and never sends again, a failed one included: a new
  try is a new `id`. This is what makes it idempotent. The LSP cannot dedupe
  a keysend as it dedupes an invoice by its hash, so the daemon writes
  `{ id, tag, address, msat }` to its ledger BEFORE it publishes, as `pay`
  writes the hash.
- **`address` is a Sphinx address.** The daemon pays it with the core's
  `keysend(…, to: pubkey, amt_msat, data: none, route_hint)`, which sends
  async through the hint (specs/WALLET.md §6).
- **`max_fee_msat`** must be at least the LSP's own limit for `msat`
  (`max_fee_too_low`), as for `POST /pay`.
- **It waits up to `PAY_WAIT_MS`** (60 s), then answers with the `state` it
  has (`pending` while unanswered). A late answer is read with the GET
  below.
- **Refused before anything is sent**, `400 { code }`: `bad_request`,
  `own_address` (the account's own), `max_fee_too_low`. Anything else that
  failed is `state: "failed"` with `error`.
- **The fee** is what the LSP charged, as for `POST /pay`. Within one mixer
  that is none.

### `GET /keysend/:id` — one keysend

Answers the same shape and never sends. `404 { code: "not_found" }` for an
`id` the daemon never took, and never a `no route …` 404: that is how strut
tells a daemon without these routes (`no_keysend`) from an `id` it does not
know.

**The one way to pay twice** is a daemon that lost its ledger: it reads an
`id` it sent as never taken, and strut then fails the payout and gives the
reserve back. Back the daemon's ledger up with its state.

A `pending` answer may carry `reason`: what the daemon knows of why it is
not settled or failed yet (`lsp_unconfirmed: …`, `cancel_too_late: …`,
`cancel_unconfirmed: …`). `pending` means unknown, never failed. strut
keeps the reason of a read or a cancel as the send's `lastError`; a send's
own answer, which goes to the worker, leaves it out.

### `POST /keysend/:id/cancel` — cancel a keysend the LSP still holds

With the PAY token, no body. strut calls it for a payout still `pending` a
day after it was sent (plans/human-steps.md §8.2, ruling 11). It never
sends. It asks the LSP to cancel the keysend and waits up to 10 s for its
word, then answers the keysend as it stands, with `cancelled`:

```json
{ "id": "<64 hex>", "state": "failed", "payment_hash": "<hex>", "fee_msat": 0, "error": "cancelled: the payer cancelled it before it was paid", "cancelled": true }
{ "id": "<64 hex>", "state": "pending", "payment_hash": "<hex>", "fee_msat": 0, "reason": "cancel_too_late: …", "cancelled": false }
```

- **Cancelled** is `failed` with an `error` that starts `cancelled:`. The
  LSP removed the payment in the write that marked it cancelled, so nothing
  was paid and nothing can be. It is the one end of a pending keysend that
  strut takes as certain: the payout fails and the reserve goes back to the
  worker with nobody's yes.
- **Too late** (the LSP had taken it for paying) and **no answer** stay
  `pending`, with `reason`. The daemon keeps the cancel in its ledger and
  asks it again every minute until the keysend ends, so strut asks once and
  reads with the GET from then on.
- **An ended keysend** is answered as it stands. An `id` the daemon never
  took is `404 { code: "not_found" }`, read as `failed`, as on the GET.
- **`409 { code: "not_cancellable" }`**: a keysend the daemon did not send
  async, which the LSP does not hold.
- **A `404 no route …`** is a daemon that keysends but predates the cancel
  (`no_keysend_cancel`). With either of these two the payout stays stale,
  and a person records it as paid or drops it.
- **The LSP must know the cancel** (the mixer's `cancelpay`,
  stakwork/sphinx#433). One that does not gives no answer: the keysend
  stays `pending` with `cancel_unconfirmed`, and a person decides.

### Invites — a new worker's Sphinx account (the payer)

plans/human-steps.md §5.8. Staff invite a new worker with one link; the
daemon makes the Sphinx invite, paying the mixer for it, so these take the
PAY token (or the admin token, which strut never holds), never the receive
token (`403`). Only the staff's `/tasks/invites` routes call them, through
the payer (`invite`, `invites`, `cancelInvite`), with 20 s each. Fields may
be added; none is renamed or removed.

```
POST /invite { "sats": 100 }
→ { "code": "<the invite's code>", "link": "sphinx.chat://?action=i&d=…&c=…", "sats": 100, "status": "sending", "createdAt": 1794787200 }

GET /invites
→ { "invites": [ { "code", "link", "sats", "status", "createdAt" }, … ] }

POST /invite/:code/cancel
→ { "code": "<code>", "status": "cancelled" }
```

- **`sats`** is the new account's starting balance. The mixer's invite price
  is paid on top of it, from the daemon's balance.
- **`status`** is one of `sending` (the daemon is paying the mixer for it),
  `ready` (it can be used), `failed` (that payment failed), `used` (a new
  account took it) or `cancelled`.
- **`link`** is the core's `invite_qr` (`sphinx/src/ping/invite.rs`):
  `sphinx.chat://?action=i&d=<URL-safe base64 of the code's 32 bytes and the
  mixer's host>`, with `c=` (the inviter) and `t=` (a tribe) when there are
  any. Strut takes `sphinx.chat://?` off and puts the rest after `#` in its
  join link, then adds `a=`, a section only the link carries; the core's
  `parse_invite_qr` ignores a section it does not know.
- **`code`** rides in the cancel's path: letters, digits, `-` and `_`, 1 to
  128 of them (hex today).
- **`createdAt`** is unix seconds; strut also reads ms and ISO.
- **A `404 { code: "not_found" }`** on the cancel is a code the daemon does
  not know (`unknown_invite` to staff). A `404 no route …` on any of the
  three is a daemon from before them (`no_invites`).

### Support's DMs — the MESSAGE token

plans/support-chat.md §7, built in stakwork/sphinx#435
(`wasm/daemon/src/dms.ts`). Workers write to the treasury's account, named
"Support" (`DAEMON_ALIAS`), from Peel; staff answer from strut
(specs/API.md §22, "Support"). The daemon gives strut its 1:1 messages
through a FOURTH token, `DAEMON_MESSAGE_TOKEN` — strut's
`LIGHTNING_DAEMON_MESSAGE_TOKEN`, `messageToken` on the wallet, kept as the
pay token is and refused when it equals the receive or the pay token. It
opens the three routes below and nothing else: not tribes, join, leave,
invoices, pay, keysend, invites or the admin routes. The only sats it can
spend are what a DM to an existing contact costs: 0, or 1 sat a part while
their key is unconfirmed. It never meets a new contact. Only strut's
follower and its `/support` routes call them (`src/support/support.ts`).
Fields may be added; none is renamed or removed.

```
GET /dms?after=<seq>&limit=100
→ { "dms": [ { "seq": 12, "id": "<sphinx id>", "time": "2026-11-16T10:00:00.250Z", "fromMe": false,
               "peer": { "pubkey": "02…", "address": "02…_03…_123", "alias": "Ana" },
               "kind": "message", "text": "When is it paid?", "replyTo": null, "sats": 0,
               "deleted": false, "mediaType": null, "fileName": null }, … ] }

GET /dm/:id/file
→ the decrypted bytes; content-type the file's type; content-disposition the sender's name

POST /dm { "id": "<strut's, 64 hex>", "to": "<the contact's pubkey>", "text": "…", "reply": "<sphinx id>" }
→ the send's item, as the feed shows it: { "seq": 31, "id": "<sphinx id>", "clientId": "<strut's>", …, "status": "sent" }
```

- **`GET /dms`**: 1:1 records, sent and received, OLDEST FIRST, `seq` above
  `after` (0 by default), at most `limit` (1 to 1,000; 100 by default).
  `seq` is the feed's own, kept by the daemon in `<home>/dms.jsonl` (the
  server's `index` is missing on the account's own sends, so it cannot be
  the cursor); its first start numbers the log's backlog (`messages.jsonl`),
  oldest first. **A record that changes comes again under a new, higher
  `seq`**: a send's `status` moving, a message its sender deleted. Strut
  keeps one row per record — its own send by `clientId`, anything else by
  `id` — and its cursor per daemon URL. It reads every 3 s, and the next
  page at once while one comes back full. 10 s each.
- **The fields**: `seq`; `id`, the Sphinx id — null only on a send that
  failed before anything went out; `clientId`, only on a send made through
  `POST /dm` (the `id` strut gave); `time` (ISO; strut also reads unix
  seconds and ms); `fromMe`; `peer { pubkey, address, alias }` (`pubkey` 66
  hex, the contact's key, which is also the key Peel signs in with);
  `kind`: `message`, `file`, `payment`, or `contact` (a key exchange someone
  sent the account, as a worker's Peel does when joining with an invite;
  what marks the invite `used`); `text` (null on a contact); `replyTo` (the
  quoted message's id, or null); `sats` (on every record: a payment's
  amount, a send's cost); `deleted`; `mediaType` and `fileName` on a file
  (`fileName` is made from the type, `image.jpg`, `file.pdf`: a Sphinx file
  message carries no name); `status` on every message the account sent —
  `sending` until the LSP has it (the LSP's PENDING, holding a sat for
  someone offline, counts as `sent`), then `sent`, or `failed` — and
  `error` on a failed one. Never a file's key. Strut skips a record of
  another kind, or with no pubkey.
- **`GET /dm/:id/file`**: a file a contact sent, downloaded from the memes
  server and decrypted as for a tribe mention, without shrinking, within
  180 s; the sender's own name in `content-disposition` (RFC 6266), which
  strut keeps over the feed's. At most 25 MiB. Strut fetches each file when
  it arrives (a media token expires), beside its reads of the feed, never
  holding them, with 200 s. Refusals: `413 too_large` (strut's "too large"
  line, ruling 10, never asked again), `404 not_found`, `410 deleted`, `403
  host_not_allowed` (the daemon opens no files, `DAEMON_MEMES_HOSTS`), `422
  unreadable` — each for good — and `502 memes_failed`, which strut tries
  again on its next 4 reads.
- **`POST /dm`**: a text to an existing contact, by pubkey — never a tribe,
  never someone the account has not met. `id` is 1 to 128 printable
  characters (strut sends 64 hex); `reply` quotes a message by its id. The
  answer is the send's item as the feed shows it, once the LSP has spoken
  or about 10 s have passed (then `sending`): strut waits 30 s. **The same
  `id` answers the send as it stands and never sends it twice** — across
  restarts too — **except a `failed` one, which is tried again with the
  text it first had**: that is strut's Retry. A send whose publish threw
  partway stays `sending` (the daemon asks the LSP by its parts' tags every
  minute), so it is never sent twice. Refusals: `400 bad_request`, `400
  not_a_contact`, `400 too_long` (the content and quoted id as the
  message's JSON over 32 KiB, which strut refuses before it keeps
  anything), `503 not_connected` (no LSP: nothing was sent). Strut keeps a
  refused send `failed` with the daemon's `code: error`, and Retry.
- **The alias**: a changed `DAEMON_ALIAS` replaces the account's stored
  alias at start, so every message after carries the new name, which is
  what renames the contact in Peel.

## NWC (NIP-47)

`LIGHTNING_NWC_URL` (or the Wallet form's `url`):
`nostr+walletconnect://<wallet pubkey>?relay=<wss url>&secret=<hex>`. A
relay must be `wss://` (`ws://` only on this machine). The whole URL is a
credential. Give a connection that does NOT allow `pay_invoice`: strut
needs `make_invoice`, `lookup_invoice`, `list_transactions` and
`get_balance` (a pay connection, `LIGHTNING_NWC_PAY_URL`, is kept apart for
the payer).

**The payer's connection** (`LIGHTNING_NWC_PAY_URL`) is called with
`pay_invoice { invoice }` — NIP-47 takes no fee cap, so the wallet's own
limit applies and the fee (`fees_paid`) is reported after — and
`lookup_invoice { payment_hash }` to read a payment that did not answer
(on the receive connection when the pay one does not allow it). A settled
payment is proven by a `preimage` that hashes to the invoice's payment
hash; `PAYMENT_FAILED` is `failed` with the wallet's words; any other error
(`INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED`) is a refusal before sending. A
request on the relay with no answer in 60 s is `pending`, read again with
`lookup_invoice`. A `pay_invoice` that answered without a preimage that
proves it, and a lookup the wallet has no record of, are `pending` too:
never "nothing was paid", which would invite paying it again.

One call opens a socket to the first relay that answers, reads the
wallet's info event (kind 13194, the methods it allows and its `encryption`
tag; believed for ten minutes), subscribes to the answer, publishes the
request (kind 23194, signed with the connection's secret, `p`-tagged to the
wallet), waits for the answer (kind 23195 from the wallet's pubkey,
`e`-tagged to the request), checks its id and signature, and closes. NIP-44
v2 when the info event's `encryption` tag lists `nip44_v2` (the request
then carries `["encryption", "nip44_v2"]`), else NIP-04. Each call has 15 s.

| Capability | NWC request | Read from the result |
| --- | --- | --- |
| `makeInvoice` | `make_invoice { amount: msat, description?, expiry? }` | `invoice`, `payment_hash`, `expires_at` (else `created_at` + expiry, an hour by default) |
| `lookup` | `lookup_invoice { payment_hash }` | `state` (NWC-09); a wallet without it is settled by `settled_at`, expired by `expires_at`. Settled: `amount`, `settled_at`, `preimage` (checked against the hash) |
| `received` | `list_transactions { type: "incoming", unpaid: false, from?, limit? }` | settled incoming transactions: `payment_hash`, `amount`, `settled_at` |
| `balance` | `get_balance {}` | `balance` (msat) |

A method the info event does not list is refused before a request
(`wallet_unauthorized`). The wallet's error codes map as: `UNAUTHORIZED`,
`RESTRICTED` → `wallet_unauthorized`; `NOT_FOUND` → `invoice_unknown`;
`RATE_LIMITED`, `INTERNAL` → `wallet_unavailable`; every other →
`wallet_refused`. No relay answering, or no answer in time, is
`wallet_unavailable`.

## The exchange rate

`src/payments/rate.ts`, decision 26. A source answers `{ usdPerBtc, at,
source }`. The default reads `GET https://mempool.space/api/v1/prices`,
`{ "time": <unix seconds>, "USD": <dollars per BTC>, … }`, through strut's
own http capability; `STRUT_RATE_URL` names any endpoint of that shape;
`createStrut({ payments: { rate } })` takes a host's function. A reading is
kept for a minute (a burst is one request); with the source down, the last
reading serves while it is under ten minutes old (since strut read it), and
then a read throws `rate_unavailable: …`. No fixed fallback. Read through
`strut.payments.rate.read()`; never on the services bag.
