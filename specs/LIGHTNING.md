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
  and `POST /pay` for the payer, built in the sphinx repo
  (`wasm/daemon/src/http.ts`, stakwork/sphinx#428).
  `src/payments/sphinx-daemon.test.ts` and `payer.test.ts` drive stand-ins
  that answer exactly this.
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
`lookup_invoice`; a payment the wallet has no record of never went out.

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
