# The wallet contract — what an app's page and its host say about a Lightning wallet

For whoever implements a side of it:
- the kit (an app's `useWallet`, its `window.webln`);
- a host's `WalletHost`: strut's UI, Hive's `strut-app-frame`, a standalone app
  host;
- Peel's native wallet bridge.

The design and its reasons are plans/app-payments.md; this page is the contract.

The normative types and checks are `kit/src/wallet/protocol.ts`
(`@strut/kit/wallet`). The conformance vectors are `kit/src/wallet/vectors.json`
(`@strut/kit/wallet/vectors.json`, §7). Where this page and the module disagree,
the module wins and this page is a bug.

**In one line:** NIP-47 (NWC) over the MCP Apps bridge, with route hints on
keysend, a `state` on every payment, a `payment_failed` notification, a
`USER_REJECTED` error, and `connect`.

## 1. Transport

The app's page talks to its host over ext-apps' bridge (`App` ↔ `AppBridge`,
JSON-RPC over `postMessage`), the one it already uses for `tools/call`. Nothing
is hand-rolled; ids, timeouts and errors are the SDK's.

- **Discovery.** A host that offers a wallet answers `ui/initialize` with
  `hostCapabilities.experimental["strut/wallet"]`:

  ```json
  { "version": 1, "methods": ["connect", "get_info", "pay_keysend", "..."],
    "notifications": ["payment_received", "payment_sent", "payment_failed"],
    "wallet": "sphinx", "connected": false }
  ```

  - `methods` and `notifications` are what the host's wallet can do.
  - `wallet` names the provider: `sphinx`, `nwc`, `webln`, or a host's own name.
  - `connected` says whether this app already holds a connection.
  - A host with no wallet leaves the key out, and the page has no wallet.
- **Requests.** Each method is a JSON-RPC request named
  `strut/wallet/<method>` (`walletRequestMethod`), with NWC's params object. The
  host registers one handler per method
  (`AppBridge.setRequestHandler("strut/wallet/pay_keysend", …)`) and never
  forwards these to the MCP server.
- **Notifications.** The host pushes
  `strut/wallet/notification { notification_type, notification }` to the page
  (§4.4).
- **A native host** (Peel) is reached through its web view's main frame, which
  is strut's UI relaying what the app's frame sent it (§1.1).

### 1.1 The native bridge

A host whose wallet is native shows strut's UI in a web view (`?app=…&solo=1`).
Inside it, the app's sandboxed frame talks to strut's UI over the MCP Apps
bridge, as everywhere. strut's UI then relays to the native host
(`kit/src/wallet/relay.ts`, wired in `web/src/app-host.ts`). Nothing is decided
in the page: the connections, budgets, sheets and the wallet are the native
host's.

```
app frame ──strut/wallet/*──▶ strut's UI (AppBridge + relay) ──postMessage──▶ native handler (Peel)
app frame ◀─strut/wallet/notification── strut's UI ◀──window.strutWallet.notify(…)── native host
```

**UI → native.** strut's UI calls
`window.webkit.messageHandlers.strutWallet.postMessage(message)`
(`NATIVE_WALLET_HANDLER`). The handler is a `WKScriptMessageHandlerWithReply`:
one promise per message, always RESOLVED with a `NativeWalletReply` —
`{ result }`, or `{ error: { code, message, data: { code } } }` (§4.1). A
rejected promise means the native host did not answer, and the page reads it as
`INTERNAL`. The message is a `NativeWalletMessage`:

```
{ v: 1, op: "capability", app }                     → { result: WalletCapability }  (what this app is offered)
{ v: 1, op: "call", method, params, app }           → { result: <MethodResults[method]> } | { error }

app: { name, version, peer?, title, request }       // NativeWalletApp: the version hosted, its title,
                                                    // and its app.yaml `wallet:` request (null: none)
```

- **Capability first.** strut's UI sends `capability` once per frame, before the
  bridge exists, because the offer rides in `ui/initialize`. An answer that is
  not a `WalletCapability` of this version, a refusal, or nothing within 5 s
  means no wallet for the page.
- **Only apps that ask.** strut's UI offers a wallet only to an app whose version
  requests one. It reads the request from the version's `dist/build.json`
  (`wallet`, beside `title`), with the version's file token, here and through a
  peer's read-through.
- **`call` params are already through `checkParams`.** The native host checks
  them again. On the iPhone the main frame is the org's code, not Peel's, so
  nothing from the page is trusted there.
- **A method the capability does not list** is answered `NOT_IMPLEMENTED` in the
  page, and never sent.
- **The page's calls wait up to 10 minutes for a sheet** (`connect`, the pay
  methods) and 60 s for the rest (`SHEET_TIMEOUT_MS`, `CALL_TIMEOUT_MS`).

**Native → UI.** The native host pushes each notification by evaluating
`window.strutWallet.notify(message)` (`NATIVE_WALLET_GLOBAL`) in the main frame,
with a `NativeWalletNotify` — an object, or the same as a JSON string:

```
{ v: 1, app: { name, peer? }, notification: WalletNotification }
```

strut's UI routes it to the frame hosting that app (`nativeAppKey`:
`<peer>/<name>`). One that names no hosted app, is not a notification, or is of a
type the capability does not list is dropped.

**Who may call the handler.** The handler answers ONLY when
`frameInfo.isMainFrame` is true and the frame's security origin is the one the
host loaded:
- the Mac's local strut, `http://127.0.0.1:<port>`;
- the org's base URL, on the iPhone.

WebKit exposes `messageHandlers` to every frame, the app's sandboxed frame
included, so the check is what keeps the app from talking to the native host
directly.

**What the native host trusts.** On the Mac the main frame is strut's UI as Peel
ships it, so its `app` is the app hosted. On the iPhone it is the org's strut
UI, which can name any app of that org. There Peel keys connections by org
(§5.2), and the sheet names the org from Peel's own record of the page it
opened.

## 2. Methods

Amounts are **msat**, times **unix seconds**, and byte strings **lower-case
hex**.

| Method | Params (`MethodParams`) | Result (`MethodResults`) | Needs |
|---|---|---|---|
| `connect` | `{}` | `{ connection: GrantedConnection }` | — (§5) |
| `get_info` | `{}` | `WalletInfo`: `alias?`, `network`, `methods` (THIS app's: `connect`, `get_info` and what its connection grants), `notifications`; `pubkey` only if granted | — |
| `pay_invoice` | `{ invoice, amount?, metadata? }` | `Payment` | connection |
| `pay_keysend` | `{ pubkey, amount, tlv_records?, route_hints?, preimage?, metadata? }` | `Payment` | connection |
| `make_invoice` | `{ amount, description?, description_hash?, expiry?, metadata? }` | `Transaction` (incoming) | connection |
| `lookup_payment` | exactly one of `{ transaction_id }`, `{ payment_hash }`, `{ invoice }` | `PaymentLookup` (NWC-09, plus `payment_type: "keysend"`) | connection |
| `lookup_invoice` | exactly one of `{ payment_hash }`, `{ invoice }` | `Transaction` (NWC core) | connection |
| `get_budget` | `{}` | NWC-13's `{ used_budget, total_budget, renews_at?, renewal_period }`, or `{}` | connection |
| `get_balance` *(optional)* | `{}` | `{ balance }` | connection |
| `list_transactions` *(optional)* | NWC-05's `{ from?, until?, limit? (1–100), offset?, unpaid?, type? }` | `{ transactions, total_count? }`: this connection's only | connection |
| `pay_lightning_address` *(optional)* | exactly one of `{ address }`, `{ lnurl }`, plus `{ amount, comment?, payer_data?, metadata? }` | `Payment` | connection |

Notes on the params:
- **`pay_keysend`'s `pubkey`** may be a Sphinx address
  `<pubkey>_<lsp_pubkey>_<scid>`. The check splits it into the pubkey and a
  one-hop `route_hints` (`parseSphinxAddress`); giving both is `BAD_REQUEST`.
- **`route_hints`** is BOLT11's `r` field:
  `[[{ pubkey, short_channel_id, fee_base_msat?, fee_proportional_millionths?, cltv_expiry_delta? }]]`.
  `short_channel_id` is a decimal u64 or `<block>x<tx>x<output>`.
- **`tlv_records`** take types of 65536 and up, never 5482373484 (keysend's
  preimage, which the wallet sets), each at most once.
- **`metadata`** is NWC-06's, at most 4096 characters as JSON. `comment` in it is
  what the payment sheet quotes as the app's words.

**`checkParams(method, params)` is every side's check.** It answers the params
normalized (hex and invoices lower case, a `lightning:` prefix dropped, a Sphinx
address split, unknown keys dropped) or a `BAD_REQUEST`. A host runs it BEFORE
anything else: before the connection, the budget, a sheet or the wallet.

The check reads SHAPES. Before a host shows or pays an invoice it DECODES it
itself — amount, payee, description, expiry — and never takes an amount from the
app. `checkParams` already refuses (`BAD_REQUEST`) an invoice that names no
amount when no `amount` param is given, and an `amount` for an invoice that names
its own. Under budget, the amount the host counts is the decoded one.

## 3. A payment

Every pay method returns once the wallet has **accepted** the payment, never only
when it settles:

```
Payment { transaction_id, state: "pending" | "settled" | "failed", payment_hash,
          amount, fees_paid?, preimage?, created_at, settled_at?, failure_reason? }
```

- **`preimage` only once `settled`, and always when `settled`.** A keysend's
  preimage is made by the sender, so before settlement it proves nothing.
- **`settled` only on the wallet's word.** Never report a failure as success, and
  never a payment that may still settle as failed. A payment whose fate the host
  does not know stays `pending`.
- **`failure_reason` only on `failed`.**
- **`transaction_id`** is the host's: unique per connection, stable across
  lookups and notifications.

**A wallet that blocks until settlement** (NWC core's `pay_invoice` /
`pay_keysend`, WebLN's `sendPayment`): the host awaits it for at most 60 seconds
(Alby's `NWCClient` uses 60).
- If it answers in time, the payment is `settled` or `failed`.
- If not, it is `pending` with `transaction_id = payment_hash`, and the host
  keeps watching it (`lookup_invoice`, `payment_sent`) and notifies the page
  when it lands.

The page sees one shape whatever the wallet.

## 4. Errors and notifications

### 4.1 Errors

A refusal is a JSON-RPC error with the wallet code in `data.code`
(`walletErrorBody`):

```json
{ "code": -32000, "message": "Over this app's budget", "data": { "code": "QUOTA_EXCEEDED" } }
```

`BAD_REQUEST` uses `-32602` (Invalid params); every other code uses `-32000`. The
message is for a person, in the host's words.

| Code | When |
|---|---|
| `BAD_REQUEST` | `checkParams` refused it |
| `UNAUTHORIZED` | no connection (never made, revoked, expired): call `connect` |
| `RESTRICTED` | the connection does not grant the method; or a sheet was needed and the person had not acted (§5.4); or the person told the host to stop hearing this app |
| `USER_REJECTED` | the person declined a sheet (strut's addition; NWC has no such code) |
| `QUOTA_EXCEEDED` | over budget, and the person chose "refuse" |
| `RATE_LIMITED` | a sheet is already open for this page |
| `INSUFFICIENT_BALANCE`, `PAYMENT_FAILED`, `NOT_FOUND`, `NOT_IMPLEMENTED`, `INTERNAL`, `OTHER` | as NWC, from the wallet or the host |

`NOT_IMPLEMENTED` is also how a wallet says it cannot honour a param it was
given: route hints, a TLV record type it cannot send, a `preimage`.

### 4.2 Notifications

```
{ notification_type: "payment_received" | "payment_sent" | "payment_failed",
  notification: Transaction & { transaction_id, failure_reason? } }
```

- `payment_sent` carries a settled outgoing transaction with its preimage.
- `payment_failed` carries a failed outgoing one.
- `payment_received` carries an incoming one, for an invoice made through this
  connection.

The host sends only the types the connection holds, and only for this
connection's own transactions. A pay call's answer reaches the page before its
notification.

## 5. Connections

### 5.1 The request

An app asks in its `app.yaml`. These are NWC-08's request fields, checked at
build (`src/apps/manifest.ts`, `connectionRequestProblems`):

```yaml
wallet:
  request_methods: [pay_keysend, get_budget]          # all granted, or declined
  optional_request_methods: [pay_lightning_address]   # any subset
  notification_types: [payment_sent, payment_failed]
  max_amount: 5000000                                  # msat per period, fees included
  renewal_period: weekly                               # never | daily | weekly | monthly | yearly; needs max_amount
  expires_at: null                                     # unix seconds
```

- It is a REQUEST. The page never sends one; the host reads it from the version
  it hosts.
- An app with no `wallet:` block is never connected: `connect` answers
  `RESTRICTED`.

### 5.2 `connect`

The host shows the CONNECT sheet:
- the app's verified identity: the title, icon and `name@vN` of the version it
  hosts, and on whose strut — never a name the page sent;
- the methods;
- the budget and its renewal, which the person may lower;
- the expiry;
- what to do over budget: **ask** (the default) or **refuse**.

On approve, the host keeps a connection record and answers
`{ connection: GrantedConnection }`. On decline it answers `USER_REJECTED`.

`connect` with a connection already held answers it without a sheet, unless the
version asks for more than it holds, in which case the sheet shows again.

Where the record is kept, keyed by (viewer, host strut or org, app name):
- Peel's preferences;
- a browser host's own storage;
- Hive's server.

**On the iPhone, Peel keys by (viewer, org).** There the main frame is the
org's code, which can name any of its apps.

### 5.3 The budget

- **`used_budget`** counts every outgoing payment of this connection in the
  current period:
  - `amount` while it is pending;
  - `amount + fees_paid` once settled;
  - nothing once it failed — a refund.
  - The check and the count are one atomic step.
- **A payment is over budget** when `used_budget + amount > max_amount`, or when
  the connection has no `max_amount`. A connection with no `max_amount` asks for
  every payment.
- **Over budget:**
  - "ask": the PAYMENT sheet, showing the decoded amount, the payee (the contact's
    name when the host knows it), the memo or keysend message, the expiry, the
    fee note, and the app's `metadata.comment` quoted as the app's.
    - Approve: it is paid and counted.
    - Decline: `USER_REJECTED`, and nothing is counted.
  - "refuse": `QUOTA_EXCEEDED`, and the wallet is never asked.
- **Renewal.** A `renewal_period` resets `used_budget` at `renews_at`, counted from
  the connection's creation. `never` never resets.
- **Revoking.** The person can revoke the connection, or lower or raise its
  budget, in the host's settings, at any time.

### 5.4 Sheets need the person

A host never opens a sheet (connect or payment) on its own:
- A native host refuses, with `RESTRICTED`, a call that would open one unless the
  person clicked or tapped in the web view within the last few seconds. It reads
  the platform's native events, which no script can make.
- One sheet at a time per page; another call that needs one is `RATE_LIMITED`.
- Calls inside the budget need no gesture, which is what lets a stream run.

### 5.5 Isolation

`list_transactions`, `lookup_payment`, `lookup_invoice` and notifications see only
payments made, and invoices made, through this connection. The host tags each
one. A lookup of anything else is `NOT_FOUND`.

## 6. Providers: what each wallet maps to

- **NWC:** passed through nearly 1:1. `pay_keysend`'s `route_hints` have no NWC
  field: a hint the wallet cannot take is `NOT_IMPLEMENTED`. Blocking calls
  follow §3. Notifications come from NWC-02.
- **WebLN:**
  - `sendPayment` → `pay_invoice`, `keysend` → `pay_keysend` (records as UTF-8
    strings), `makeInvoice` → `make_invoice` (sats), `lookupInvoice` →
    `lookup_invoice`, `getBalance` → `get_balance`, `lnurl` →
    `pay_lightning_address`.
  - `get_info.methods` lists only what that provider's `getInfo().methods` says.
  - It has no notifications: the host follows what it started through lookups.
  - **Inside the app's frame**, the kit's `window.webln` (`kit/src/wallet/webln.ts`)
    maps WebLN onto this contract the same way. It is installed by the
    bootstrap only when the host offers a wallet. A `sendPayment` or `keysend`
    that may still settle never rejects (a rejection invites a second payment):
    it resolves `{ preimage }` once settled, else after 60 s
    `{ preimage: null, pending: true, transactionId }`.
- **Sphinx (Peel):**
  - **Address.** A Sphinx address is `<pubkey>_<lsp_pubkey>_<scid>`. Its route
    hint is `<lsp_pubkey>_<scid>` (`sphinxRouteHint`), the format the core pays
    ASYNC; a legacy `:` hint never is.
  - **Keysend** is the core's
    `keysend(seed, time, to, state, amt_msat, data?, route_hint?)`. `data` rides
    in TLV **13377331** (`SPHINX_TLV_TYPE`), base64. Until the core takes a list of
    records, any other record type is `NOT_IMPLEMENTED`.
  - **States.** The mixer's `PENDING` / `COMPLETE` (with the preimage) / `FAILED`
    are `pending` / `settled` / `failed`. A payee who is away leaves the payment
    `pending` at the LSP until they return. Peel's reconciliation settles or fails
    it later, and the page hears it as `payment_sent` or `payment_failed`.
  - **Invoices.** `make_invoice` is the mixer-made invoice, which settles while
    Peel is closed.

## 7. Conformance vectors

`vectors.json` holds six lists. Every implementation runs all of them in its own
tests. The kit's runner is `kit/src/wallet/protocol.test.ts`.

| List | Each entry | Passing means |
|---|---|---|
| `params` | `{ name, method, params, expect: { params } \| { error: "BAD_REQUEST" } }` | `checkParams` answers exactly `expect.params`, or refuses |
| `results` | `{ name, method, result, valid }` | an answer of this shape is (or is not) one the contract allows (`resultProblems`) |
| `notifications` | `{ name, notification, valid }` | the same (`notificationProblems`) |
| `connection_requests` | `{ name, request, valid }` | an `app.yaml` `wallet:` block is (or is not) accepted |
| `preimages` | `{ preimage, payment_hash, valid }` | `sha256(preimage) == payment_hash` |
| `scenarios` | a host's behaviour, below | the host does what each step says |

**A scenario** starts from:
- `connection`: `{ methods, notification_types, max_amount?, renewal_period?, over_budget, used_budget }`;
- or `null` and a `request`, the app's `wallet:` block.

Each step is either a **call** or a **wallet event**.

A **call**: `{ call: { method, params? }, decoded?, sheet, person?, wallet, expect }`.
- `decoded`: what the host's invoice decoder reads (`{ amount }`), for
  `pay_invoice`.
- `sheet`: which sheet the host must show: `"connect"`, `"payment"`, or `null`
  for none.
- `person`: what the person does on it, `"approve"` or `"decline"`.
- `wallet`: the scripted wallet's answer, `{ result }` or `{ error }`; `null`
  means the host must NOT call the wallet at all.
- `expect`: the host's answer, `{ result }` or `{ error: <code> }`.

A **wallet event**: `{ wallet_event: <notification>, expect: { notification } }`.
- `expect.notification` is what the host must push to the page, or `null` for
  nothing.

A host replays a scenario with its own storage, a scripted wallet and a scripted
person. The person is assumed to have just acted (§5.4).

## 8. Changing the contract

A method, param, code or rule changes in `protocol.ts`, `vectors.json` and this
page in one change. Whatever can break an existing host or app raises
`WALLET_PROTOCOL_VERSION`, which the capability carries.

The additions to NWC are candidates for NWC extensions once they have been used:
keysend route hints, a payment `state`, `payment_failed`, and the `keysend`
payment type for `lookup_payment`.
