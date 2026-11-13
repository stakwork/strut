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
  is strut's UI relaying what the app's frame sent it (§1.1). strut's UI also
  asks it, on its OWN account, to pay for a visitor's credit and to sign a
  visitor in (§1.2).

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
- **The relay sets no timeout of its own** on the native call: the page's
  timeouts are the only ones in strut. So the native host answers every call,
  and takes down a sheet nobody answered BEFORE the page's 10 minutes run out
  (Peel: at 9), answering `RESTRICTED`. Otherwise a yes given after the page
  stopped waiting would pay for a page that no longer hears the answer.

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

### 1.2 The host's own purchase: a visitor's credit, one tap

A VISITOR's page is a public app: this strut server's, or another strut
server's that strut's UI hosts (specs/API.md §17.6, §17.9). It may launch a
priced workflow. The HOST pays for the credit that launch needs, never the
page. In a native host's web view, strut's UI asks the native wallet to pay
before it shows the invoice as a QR code: one tap on the native host's own
sheet.

This is not an app's call:
- it carries no app connection;
- no app budget counts it;
- it is no `strut/wallet/*` method.

The page never sees it. Each purchase is the person's tap.

```
app frame ──step_run run/launch──▶ strut's UI ──POST /public/mcp──▶ the seller (a strut server)
                                        │◀── { payment_required: { macaroon, invoice, usd, sats, … } }
                                        │ checks the challenge (below)
                                        ├──{ op: "host_capability" }──▶ native host
                                        ├──{ op: "buy_credit", purchase }──▶ native host ── its sheet, the person taps, it pays
                                        │◀── { result: Payment } with the preimage
                                        │ sha256(preimage) == payment_hash → credential <macaroon>:<preimage>
                                        └──POST /public/mcp again, Authorization: L402 <credential> ──▶ the seller
```

**The messages.** They go through the same handler as §1.1
(`window.webkit.messageHandlers.strutWallet`), with the same reply rule:
always resolved, `{ result }` or `{ error }`. They are `HostWalletMessage`
in `protocol.ts`:

```
{ v: 1, op: "host_capability" }                         → { result: { version: 1, ops: ["buy_credit", "buy_credit_status", "buy_credit_cancel", "sign_in"], wallet?: "Peel" } }
{ v: 1, op: "buy_credit", purchase: CreditPurchase }    → { result: Payment } | { error }   (a pay method's answer, §3, §4.1)
{ v: 1, op: "buy_credit_status", payment_hash }         → { result: Payment } | { error }   (where that purchase stands now)
{ v: 1, op: "buy_credit_cancel", payment_hash }         → { result: {} }
{ v: 1, op: "sign_in", seller, app, challenge }         → { result: { key, sig } } | { error }   (below, "Signing a visitor in")
```

**`host_capability`** is asked ONCE per page, as a visitor's page connects,
so no sheet waits on it.
- `ops` names what the native host takes: `buy_credit`, and optionally
  `buy_credit_status` and `buy_credit_cancel`; `sign_in` when its wallet
  signs a visitor in. strut's UI leaves out an op it does not know (a newer
  native host's), never reading the whole answer as none
  (`hostWalletCapabilityOf`; the `host_capabilities` vectors, §7).
- `wallet` is its name for a person ("Peel", at most 40 characters): what
  strut's sheet calls it ("Confirm in Peel", "Pay with Peel").
- Any other answer, or none within 5 s (`WALLET_PROBE_MS`), means no
  one-tap purchase, only the QR code. An older native host is read this way.

**`buy_credit`'s purchase** (`CreditPurchase`, checked by
`creditPurchaseProblems`):

| Field | |
|---|---|
| `invoice` | BOLT11, lower case, naming its amount |
| `payment_hash` | hex 64: the invoice's |
| `amount` | msat: the invoice's amount, `sats × 1000`. **This is the price.** |
| `sats` | the same in sats |
| `usd` | the CREDIT the seller says the payment buys, in dollars: the seller's own figure, never the price |
| `rate?` | `{ usd_per_btc, at, source }`, the rate the seller says it quoted at: the seller's too |
| `description` | the seller's words for what it sells. The sheet quotes them as the seller's |
| `expires_at` | unix seconds: when the invoice ends |
| `seller` | the strut server the credit is bought on, as its base URL: `https://…`, or `http://` on loopback. It has no credentials, query or fragment (`isSellerUrl`) |
| `app` | `{ name, version, title }`: the public app whose page asked, as the seller serves it |
| `workflow` | the workflow the launch is for |
| `credit` | `{ carries, reason?, remaining_usd? }`: the new token inherits the credit held (`carries`); why the held credit did not do (`short`, `expired`, `replaced`); what it still has |

It never carries the macaroon or a credential. The native host pays an
invoice; strut's UI keeps the credit.

**What strut's UI checked before asking** (`web/src/challenge.ts`), so a
seller's junk is never shown nor paid:
- the invoice is BOLT11 and asks for an amount;
- it has not ended;
- the macaroon is an L402 one whose identifier names the SAME payment hash;
- its `strut_sats` is the challenge's `sats`, which is the invoice's amount;
- its `strut_credit` is the challenge's `usd`.

The seller writes both of the last two, so they agree with each other, not
with the world: a seller may ask 200 000 sats "for $0.02 of credit". The
price is therefore the sats, everywhere. strut's own sheet headlines the
sats. It shows dollars only at the hosting strut's own rate (`GET /rate`,
specs/API.md §17.9), and the seller's dollars only as the credit, flagged
when that credit is worth under nine tenths of what is paid.

**What the native host does:**
1. Answers only the main frame it trusts (§1.1's rule).
2. Runs `creditPurchaseProblems`, and decodes the invoice ITSELF. The amount
   must be `amount`, the payment hash `payment_hash`, and it must not have
   ended. Anything else is `BAD_REQUEST`.
3. Applies §5.4's gesture rule: `RESTRICTED` unless the person tapped in the
   web view within the last few seconds. strut's UI asks as soon as the page
   launches, so a launch with no tap behind it is refused. Then strut's own
   sheet shows **Pay with ⟨wallet⟩**, whose press is a fresh tap, and sends
   `buy_credit` again.
4. Shows its own sheet:
   - the seller by its host;
   - the app's title, "on <seller>";
   - the workflow;
   - **the price: the decoded amount in sats**, and in dollars only at the
     native host's OWN rate;
   - the seller's `usd` only as what the seller says the payment buys
     ("buys $0.50 of credit, by the server's own figure"), never as the
     price. A figure worth far less than the sats paid (more than 10% under,
     at the native host's rate) is flagged;
   - the description, quoted as the seller's;
   - that this buys CREDIT on that server, which later runs in this page
     spend: what a run does not use stays.

   No budget pays it silently: every purchase asks.
5. **Answers as soon as the person acts**, never only when the payment
   ends:
   - on a tap, as soon as the payment is SENT: `pending`, or `settled` with
     the preimage if it settled at once;
   - on a decline, `USER_REJECTED`;
   - `failed` only for a payment that can no longer settle (no route, the
     HTLC failed back).

   strut's UI then shows the invoice NO MORE. A seller holding the first
   payment knows its preimage, and could settle a second one paid from
   another wallet.
6. Answers `buy_credit_status` with where that payment stands now: `pending`,
   `settled` with the preimage, or `failed` (then the payment can no longer
   settle, and strut's sheet offers the invoice again). It answers
   `NOT_FOUND` for a hash it never paid. strut's sheet asks every 3 s while a
   payment is pending.
7. **Never pays one payment hash twice.** A second `buy_credit` for a hash it
   paid, or is paying, answers that payment's state with no sheet.
8. Answers before `expires_at`. A sheet still up when the invoice ends is
   taken down and answered `RESTRICTED`.
9. On `buy_credit_cancel` for a sheet still up (no tap yet): takes it down
   and answers the purchase `USER_REJECTED`. For a payment already sent, it
   does nothing: that purchase's answer stands. The host sends the cancel
   when it stopped waiting: the person chose the QR code, the page went
   away, or the invoice ended.
10. Recommended, for a stranger's page (specs/API.md §17.9): refuse any
   navigation of a subframe away from `about:srcdoc` or `about:blank`. strut's
   UI holds the stranger's frame to a CSP that sends nothing anywhere, but a
   frame may still navigate itself, which only the web view can stop.

**What strut's UI does with the answer** (`readCreditReply`; the
`credit_replies` vectors, §7):

| Answer | Outcome |
|---|---|
| a payment of this invoice, `settled`, and `sha256(preimage) == payment_hash` | **paid**: the credential is `<macaroon>:<preimage>`, kept by strut's UI; the page's call is sent again with it |
| a payment of this invoice, `pending`, or `settled` without a preimage that proves it | **pending**: the person tapped and the payment was sent. The sheet shows no invoice from here on; it waits on the claim and on `buy_credit_status`. After 60 s it says the server may be holding the payment, and Close leaves the credit to be claimed |
| an error (a decline, a refusal), a payment of this invoice that `failed`, anything that is not a payment of this invoice, no answer before the invoice ends | **fallback**: nothing was sent. The QR code, with why, and **Pay with ⟨wallet⟩** |

If the person chose the QR code while the native host had not answered,
and its answer then says the payment was sent, the sheet takes the QR code
down and waits on that payment.

The claim runs whatever the outcome. From the moment the challenge is
shown, strut's UI claims the invoice (`POST <seller>/public/credit/claim`)
until the invoice's DECODED end, and a reload resumes it. So a payment the
native host made, whose answer was lost or came late, still buys the credit.

A call pays at most once: a seller that answers `payment_required` again
after a payment is not paid again. The page is told its payment is kept as
credit.

#### Signing a visitor in: `sign_in`

A visitor's page may ask its host to sign the visitor in
(`useVisitor().signIn()`, plans/app-repos.md §5). When the seller offers the
`sphinx` method and the native host's wallet holds the person's Sphinx
account, strut's UI asks the native host to sign the SELLER's visitor
challenge (plans/app-payments.md §4.4). The person is then the same visitor
on every app: `secp:<their key>`. Like `buy_credit`, it is the host's own
op: no app connection carries it, and the page never sees the request, the
challenge or a key.

```
app frame ──strut/visitor/sign-in──▶ strut's UI ──GET <seller>/visitors/challenge──▶ the seller
                                        │◀── { challenge, methods: [… "sphinx" …], visitorKey }
                                        │ checks the request (below)
                                        ├──{ v: 1, op: "sign_in", seller, app, challenge }──▶ native host ── its sheet, the person signs in
                                        │◀── { result: { key, sig, address? } }
                                        └──POST <seller>/visitors/session { challenge, method: "sphinx", key, sig, address? } ──▶ the seller
                                        │◀── { actor: "secp:…", token, exp }   kept by strut's UI, per seller
```

**The request** (`SignInRequest`, checked by `signInRequestProblems`; the
`sign_in_requests` vectors, §7):

| Field | |
|---|---|
| `seller` | the strut server the visitor signs in to, as its base URL (`isSellerUrl`, as a purchase's) |
| `app` | `{ name, version, title }`: the public app whose page asked, as the seller serves it |
| `challenge` | the seller's `GET /visitors/challenge`: `strut-visitor.<claims>.<hmac>`, claims `{ host, visitorKey, nonce, exp }` as base64url JSON (`visitorChallengeClaims`), `exp` in unix MILLISECONDS. The HMAC is the seller's to check |

**The answer** (`SignInAnswer`, read by `readSignInReply`; the
`sign_in_replies` vectors, §7): `{ result: { key, sig, address? } }` —
- `key`: the compressed secp256k1 key that signed, 33 bytes;
- `sig`: a Lightning signed message over the challenge's UTF-8 bytes, 65
  bytes `[31 + recovery id] ‖ r ‖ s`, a recoverable ECDSA signature over
  `sha256(sha256("Lightning Signed Message:" ‖ challenge))`. That is what
  sphinx-rs's `sign_bytes` answers (`Sphinxrs.signBytes`), and the
  `sign_in_signatures` vectors (§7) are its real output;
- `address` (optional): the account's own Sphinx address,
  `<pubkey>_<lsp_pubkey>_<scid>`, from `myContactInfo`. Peel sends it only
  when it signs with the ROOT key; with a domain's child key (LUD-05) it
  sends none. The seller keeps it to keysend the person a payout
  (plans/human-steps.md §8.2). Its pubkey is the root sign-in key: Sphinx's
  `get_my_contact_info` builds the address from
  `make_signer(seed, Some(0), …).get_node_pubkey()`, and the root sign-in
  key is `pubkey_from_seed(idx: 0)`, which reads the same key (the
  `sign_in_addresses` vectors, §7, pin it). `readSignInReply` keeps the
  address only when it parses (`parseSphinxAddress`) and its pubkey is
  `key`, and drops it otherwise; strut's UI posts it as `address`, and the
  seller checks the same again. Peel still signs nothing new.

Or `{ error }` (§4.1): `USER_REJECTED` when the person declined,
`RESTRICTED` for no tap (below) or a sheet still up when the challenge
ended, `BAD_REQUEST` for a request the native host refused.

**What strut's UI checked before asking** (`web/src/native-pay.ts`
`signInAsk`), so a seller's junk is never put to the wallet:
`signInRequestProblems` — above all, that the challenge is a strut visitor
challenge minted for the seller's host and has not ended.

**What the native host does:**
1. Answers only the main frame it trusts (§1.1's rule): on the Mac, its own
   strut UI hosting a stranger's app (specs/API.md §17.9); on the iPhone, a
   served box it opened directly, at the origin it loaded
   (plans/app-payments.md §5.3, R7).
2. Runs `signInRequestProblems`, and holds the challenge's `host` to the
   seller — on the iPhone, to the host name of the ORIGIN IT LOADED,
   whatever `seller` and `app` say. The seller's host name is the URL's,
   lower case, with no port and no IPv6 brackets (`sellerHost`). A challenge
   for any other host is `BAD_REQUEST` and is never signed: one box never
   gets a signature that logs in to another.
3. Signs ONLY a strut visitor challenge: never a message a page chose.
   There is no `sign_message` method (§2), and an app's
   `window.webln.signMessage` throws `UnsupportedMethodError`.
4. Applies §5.4's gesture rule: `RESTRICTED` unless the person tapped in the
   web view within the last few seconds. strut's UI asks as soon as the page
   calls `signIn()`, which a page does on a press; otherwise strut's own
   sheet shows **Sign in with ⟨wallet⟩**, whose press is a fresh tap, and
   sends `sign_in` again.
5. Shows its own sheet, unless the person's connection with this page
   already grants sign-in for this seller (then a toast):
   - the seller by its host;
   - the app's title, "on <seller>";
   - **Sign in as you**: the person's root Sphinx key (account 0: the key
     `Sphinxrs.pubkeyFromSeed(idx: 0)` names), the same visitor on every
     app;
   - or **as a new identity for this app**: the domain's child key for the
     challenge's `host` (LUD-05's derivation), unlinkable across apps.
     When the challenge's `visitorKey` is `domain`, only this one. Which
     key it is, is the native host's; strut only checks the signature.
6. Answers as soon as the person acts: `{ key, sig }`, or `USER_REJECTED`.
7. Answers before the challenge's `exp`. A sheet still up then is taken
   down and answered `RESTRICTED`: the seller refuses a challenge past its
   minute, and strut's UI stops waiting there.

**What strut's UI does with the answer:**

| Answer | Outcome |
|---|---|
| `{ key, sig }` | **signed**: `POST <seller>/visitors/session { challenge, method: "sphinx", key, sig }`; the seller's `ln-message` verifier recovers the key from the signature and holds it to `key`. The session (`{ actor, token, exp }`) is kept by strut's UI under the seller, and its token rides on every later call of that seller's page (`x-strut-visitor` on `/public/mcp`) |
| `USER_REJECTED` | not signed in; strut's sheet offers the seller's other methods, if any |
| anything else | strut's sheet, with why, and **Sign in with ⟨wallet⟩** |

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

- **`preimage` only once `settled`.** A keysend's preimage is made by the
  sender, so before settlement it proves nothing.
- **A pay method's answer that says `settled` carries the preimage.** A host
  that knows the payment settled but has no preimage answers `pending`, and the
  page hears the settlement as a lookup or a notification.
- **A lookup, a listed transaction or a notification may say `settled` with no
  preimage.** Some wallets learn that a payment settled without learning its
  preimage. Sphinx is one: the mixer's tag records and its payment history carry
  none, so a payment that settled while Peel was not listening has none. A page
  that needs PROOF checks the preimage (`verifyPreimage`), not the state.
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

- `payment_sent` carries a settled outgoing transaction, with its preimage when
  the host has it (§3).
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
- Peel: a table on the device, not its synced preferences, because the budget
  is counted in the same database write as the payment;
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
    in TLV **13377331** (`SPHINX_TLV_TYPE`), which the core sends as the base64
    text of `data`.
    - **That record's value.** As for every record, its `value` is the hex of the
      bytes on the wire. On the wire this record is base64 text, so its value
      must be the hex of base64 text. The host decodes it and hands the core the
      bytes; any other value is `NOT_IMPLEMENTED`.
    - **Other record types** are `NOT_IMPLEMENTED` until the core takes a list of
      records.
    - **Route hints.** The core takes only `<lsp_pubkey>_<scid>`, so a hop's fee
      and CLTV fields are ignored.
  - **States.** The mixer's `PENDING` / `COMPLETE` (with the preimage) / `FAILED`
    are `pending` / `settled` / `failed`. A payee who is away leaves the payment
    `pending` at the LSP until they return. Peel's reconciliation settles or fails
    it later, and the page hears it as `payment_sent` or `payment_failed`.
    - A settlement Peel learns later, from the mixer's tag records or its history,
      carries no preimage (§3).
  - **Fees.** The core's send status does not say what was paid. `fees_paid`
    comes from the payment history row (plus the 1-sat ping of an async
    keysend), and is absent until Peel has read that row.
  - **Invoices.** `make_invoice` is the mixer-made invoice, which settles while
    Peel is closed.

## 7. Conformance vectors

`vectors.json` holds thirteen lists. Every implementation runs all of them in its own
tests. The kit's runner is `kit/src/wallet/protocol.test.ts`.

| List | Each entry | Passing means |
|---|---|---|
| `params` | `{ name, method, params, expect: { params } \| { error: "BAD_REQUEST" } }` | `checkParams` answers exactly `expect.params`, or refuses |
| `results` | `{ name, method, result, valid }` | an answer of this shape is (or is not) one the contract allows (`resultProblems`) |
| `notifications` | `{ name, notification, valid }` | the same (`notificationProblems`) |
| `connection_requests` | `{ name, request, valid }` | an `app.yaml` `wallet:` block is (or is not) accepted |
| `preimages` | `{ preimage, payment_hash, valid }` | `sha256(preimage) == payment_hash` |
| `host_capabilities` | `{ name, capability, expect }` | `hostWalletCapabilityOf` reads a native host's `host_capability` answer as `expect`: an op it does not know left out, `null` for no capability (§1.2) |
| `credit_purchases` | `{ name, purchase, valid }` | a `buy_credit` purchase is (or is not) one the contract allows (`creditPurchaseProblems`, §1.2): shapes and arithmetic, the native host's own decode on top |
| `credit_replies` | `{ name, payment_hash, reply, outcome, preimage?, code? }` | strut's UI reads the native host's answer to `buy_credit` (or `buy_credit_status`) as `outcome`: `paid` with `preimage`; `pending`, a payment sent, after which the invoice is not shown again; or `fallback` with `code`, nothing sent (`readCreditReply`). A native host checks that its own answers come to what it means |
| `sign_in_requests` | `{ name, now, request, valid }` | a `sign_in` request is (or is not) one the native host may sign at `now` (ms) (`signInRequestProblems`, §1.2): above all, the challenge is a strut visitor challenge for the SELLER's host. A native host refuses every invalid one |
| `sign_in_replies` | `{ name, reply, outcome, key?, sig?, address?, code? }` | strut's UI reads the native host's answer to `sign_in` as `outcome`: `signed` with `key` and `sig` (lower-case hex) and `address` only when the answer's address parses and its pubkey is `key` (one whose pubkey is another's is dropped), or `refused` with `code` (`readSignInReply`). A native host checks that its own answers come to what it means |
| `sign_in_signatures` | `{ name, signer?, message, key, sig, actor }` | Lightning signed messages over strut challenges, made by Sphinx's own signer (sphinx-rs `sign_bytes` / `pubkey_from_seed`, `scripts/ln-message-fixtures`): with `signer` (`{ seed, idx, network }`), `sig` is exactly what that signer makes of `message` and `key` its key — a native host's signing reproduces both; strut's `ln-message` verifier (src/visitors.ts) names `actor`, or refuses (`null`): a tampered message, another key, a changed recovery byte, no recovery byte, an uncompressed key |
| `sign_in_addresses` | `{ name, signer, key, address }` | one seed's Sphinx address (sphinx `get_my_contact_info`) and its root sign-in key (`pubkey_from_seed`, `idx: 0`, as in `sign_in_signatures`) agree: `address`'s pubkey is `key`. Every implementation that makes the answer checks its own address against it. `source` says what is real: the pubkey is `pubkey_from_seed(idx: 0)` of the seed (as in `sign_in_signatures`, `scripts/ln-message-fixtures`); the route hint `<lsp_pubkey>_<scid>` is illustrative, to be regenerated from sphinx `get_my_contact_info` when Peel implements it |
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
