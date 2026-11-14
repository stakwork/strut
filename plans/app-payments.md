# Payments in apps — a wallet any host can give an app

Ruled 2026-11-04: R1, R2, R3 and R5 accepted; R4 (Peel as an NWC wallet service)
later (§11). Ruled 2026-11-10: R6, signing in through the connection, the root
key by default (§4.4, rewritten); R7, a stranger's public app opens directly on
the iPhone, keyed by origin (§5.3). How a strut app (plans/apps.md) gets a
Lightning wallet:
- in Peel, where the person's Sphinx account is;
- in any other host — strut's UI, Hive, a full-screen app host of its own — with
  whatever wallet the person brings there.

The aim is one app-facing interface, copied from what the Lightning ecosystem
already uses, that any host can back with any wallet that does similar things.

Sources:
- sphinx-bridge and the five old hosts that implemented it;
- Sphinx v2: the core, the mixer, Peel's engine and its web views;
- the specs and their real use: NIP-47 and the NWC extensions, WebLN, Bitcoin
  Connect's connectors, the Alby SDK, LNbits, phoenixd, Breez Spark, bLIP-10 and
  the Podcasting 2.0 value block, L402, x402, MCP Apps;
- GitHub usage counts for the methods.

They are summarized in §10.

## Problem

An app is model-written code in a sandboxed frame: an opaque origin,
`connect-src 'none'`, no storage, no popups. It reaches the world through
`step_run`, and through what its host offers over ext-apps' `AppBridge`. Every host
frames it the same way:
- strut's UI, in a browser tab and inside Peel (Mac: the UI Peel ships, from its
  local strut; iPhone: the org's UI, straight from the swarm);
- Hive, embedded and full-screen.

**No wallet reaches the frame.** Alby's content scripts never match an
`about:srcdoc` frame. NWC and LNURL need a socket or a fetch. Bitcoin Connect fails
on every connector. So the wallet has to be the HOST's, and the app has to ask the
host for it.

What apps ask for is more than paying an invoice:
- **keysend:** Sphinx's own payment, and how Podcasting 2.0 streams and boosts;
- **invoices made into the person's wallet;**
- **following a payment that settles later;**
- **budgets,** so streaming sats is not a prompt a minute;
- **paying a Lightning Address.**

## Design in one paragraph

**The app speaks NWC to its host; the host speaks to a wallet.**
- **The interface.** The frame-facing interface IS NIP-47's method set: the same
  names, msat amounts and result objects. It is sent as JSON-RPC over the bridge
  the page already uses, rather than as encrypted events over a relay. strut adds
  three things the standards lack and Sphinx needs: route hints on keysend, a
  `state` on every payment (Sphinx settles asynchronously, so a payment can be
  pending for hours), and `payment_failed`.
- **The kit.** It exposes this as `useWallet()`, and as a full `window.webln`, so
  WebLN code and libraries work unchanged.
- **The host.** Each host runs the same small `WalletHost`: consent as per-app
  CONNECTIONS (NWC-08's request fields: methods, a renewing budget, an expiry),
  budgets enforced where the money is, the host's own sheets, and the call routed
  to a PROVIDER:
  - `SphinxProvider`: Peel natively.
  - `NwcProvider`: any NWC wallet, passed through nearly 1:1.
  - `WebLnProvider`: an extension, or Bitcoin Connect's connectors.
- **The server.** The app's own server side uses the same interface,
  `ctx.services.lightning`, to receive: invoices, lookups, notifications.

One interface, three adapters, and every host and every NWC-capable wallet fits.

## 1. Layers

```
 app frame        kit: useWallet()  ·  window.webln (WebLN, sats)
   │                 └─▶ strut/wallet/<nwc_method>   JSON-RPC over ext-apps' AppBridge (msat, NWC shapes)
   ▼
 host page        WalletHost — connections (consent + budget + expiry), sheets, rate limits,
 (strut UI,         isolation (each app sees only its own payments), notifications to the frame
  Hive, any         │
  standalone        ├─▶ SphinxProvider   Peel: a WKScriptMessageHandlerWithReply → the engine
  host)             │                    (in Peel the WalletHost itself is native: §5)
                    ├─▶ NwcProvider      any NWC wallet: Alby Hub, Coinos, Primal, Zeus, LNbits,
                    │                    Cashu.me, Rizful, Flash… (@getalby/sdk NWCClient)
                    └─▶ WebLnProvider    an extension's window.webln in the TOP page, or a
                                         Bitcoin Connect connector (LNC, LNbits, …)

 app's workflows  ctx.services.lightning — the SAME interface, server-side, receive methods:
                  NwcProvider, SphinxDaemonProvider (the org's Jamie account), later LND/CLN/phoenixd
```

The wire is NWC because NWC is already the abstraction every wallet backend is
adapted to:
- Alby Hub fronts LDK, LND, CLN, phoenixd and Cashu with it.
- nwc.dev lists more than a dozen wallets.
- Damus, Primal, Amethyst, Fountain and Castamatic consume it.
- Alby's `NostrWebLNProvider` is the WebLN-over-NWC mapping, already written.

A host that adds a new wallet writes one provider. An app never changes.

## 2. The methods

All on the bridge as `strut/wallet/<method>`, NWC's params and results, msat.
Advertised at `ui/initialize` as:

```
hostCapabilities.experimental["strut/wallet"] = {
  methods: [...], notifications: ["payment_received", "payment_sent", "payment_failed"],
  wallet: "sphinx" | "nwc" | "webln", connected: true | false
}
```

ext-apps 2.0.3 has an `experimental` slot on both sides for exactly this, and a
custom `AppBridge.setRequestHandler("strut/wallet/pay_keysend", …)`; ids, timeouts
and errors are the SDK's. `methods` is what the provider can do; what this APP may
do is its connection's (§4).

How often apps call each method (GitHub code search, 2026-11-04; noisy, but the
order is clear):

| | WebLN | NWC |
|---|---|---|
| pay an invoice | `webln.sendPayment` 604 | `pay_invoice` 2776 |
| make an invoice | `webln.makeInvoice` 184 | `make_invoice` 1920 |
| notifications | — | `payment_received` 1126 |
| lookup / list | `webln.lookupInvoice` 8 | `lookup_invoice` 918, `list_transactions` 834 |
| keysend | `webln.keysend` 72 | `pay_keysend` 443 |
| budget | — | `get_budget` 193 |
| sign | `webln.signMessage` 56 | — |

Keysend is a minority overall, but it is concentrated in Podcasting 2.0 and
Sphinx-style apps, which is us.

### 2.1 The set

**Core: every host offers these.**

| Method | Params | Result |
|---|---|---|
| `get_info` | — | `{ alias?, network, methods, notifications, budget? }` — no `pubkey` unless the connection grants it (§4) |
| `pay_invoice` | `{ invoice, amount?, metadata? }` | **a payment** (§2.2) |
| `pay_keysend` | `{ pubkey, amount, tlv_records?: [{ type, value /*hex*/ }], route_hints?, preimage?, metadata? }` | **a payment** |
| `make_invoice` | `{ amount, description?, description_hash?, expiry?, metadata? }` | NWC's transaction object |
| `lookup_payment` | `{ transaction_id } \| { payment_hash } \| { invoice }` | NWC-09's envelope, with a `keysend` payment type added (§2.3) |
| `get_budget` | — | NWC-13's `{ used_budget, total_budget, renews_at?, renewal_period }`, or `{}` |
| notification `payment_received` / `payment_sent` / `payment_failed` | — | NWC-02's payload + `transaction_id` |

`lookup_invoice` is kept as an alias of `lookup_payment`, since NWC core has it.

**Optional: a host offers each if its provider can, and the app requests it.**

| Method | Why |
|---|---|
| `get_balance` → `{ balance }` | NWC core. Privacy: granted explicitly, never by default. |
| `list_transactions` (NWC-05 params and result) | ALWAYS scoped to the app's own payments, like NWC-08's `isolated`. An app never sees the person's other history. |
| `pay_lightning_address { address \| lnurl, amount, comment?, payer_data?, metadata? }` → a payment | The host resolves LNURL (LUD-06/16, LUD-12 comments, LUD-18 payer data), because the frame cannot fetch. This is what WebLN's `lnurl()` does in the extension; NWC leaves it to the client. |
| `pay { payment, amount?, max_fee?, payer_note?, metadata? }` (NWC-321: a BIP-321 URI, bolt11, `lno=`) | BOLT12 offers, later, without a new method. |
| `make_hold_invoice` / `settle_hold_invoice` / `cancel_hold_invoice` (NWC-03) | Escrow and bets. Later. |
| `sign_message` | Never. An app does not choose what the wallet signs. Signing in is the HOST's request, not an app's method (§4.4). |

Left out: `multi_pay_invoice` and `multi_pay_keysend`, which NIP-47 dropped in
2026-02 (nips#2210) for lack of use. A split is N `pay_keysend` calls.

### 2.2 A payment: the state every result carries

Every pay method returns once the wallet has ACCEPTED the payment, never when it
settles:

```
{ transaction_id, state: "pending" | "settled" | "failed", payment_hash,
  amount, fees_paid?, preimage?, created_at, settled_at?, failure_reason? }
```

This is NWC-321's `pay` result and Breez's `Pending`/`Completed`/`Failed`, applied
to every pay method. NWC core's `pay_invoice` and `pay_keysend` instead block
until a preimage. For Sphinx that would be wrong: a keysend to someone offline
waits at the LSP until they return, which may be hours (§3).

The rules:
- **`preimage` only once `settled`.** With keysend the SENDER makes the preimage,
  so before settlement it proves nothing (NWC-09 says the same).
- **`settled` only on the provider's word.** NAP-VALUE's rule: never report failure
  as success.
- **A pending payment counts against the budget,** as Peel already holds pending
  sends out of what is spendable. A failed one is refunded to the budget.
- **Settlement arrives as a notification,** `payment_sent` or `payment_failed`
  with the `transaction_id`, pushed to the frame as an MCP notification
  (`strut/wallet/notification`), and can be read with `lookup_payment`.

How a host maps a provider that blocks (NWC core, WebLN): it awaits the
provider's answer for up to a short window (Alby's `NWCClient` uses 60 s).
- If the answer comes in time, the payment is `settled` or `failed`.
- If not, it is `pending`, with `transaction_id = payment_hash`, and the host
  goes on watching it (`lookup_invoice`, `payment_sent`) and notifies the frame
  when it lands.

The app sees one shape whatever the wallet.

### 2.3 What strut adds to NWC, and asks upstream

These are the three gaps no standard fills, all of which Sphinx needs:

1. **Route hints on keysend.** Neither WebLN `keysend` nor NWC `pay_keysend` takes
   one.
   - Ours: `route_hints: [[{ pubkey, short_channel_id, fee_base_msat?, fee_proportional_millionths?, cltv_expiry_delta? }]]`,
     BOLT11's `r` shape.
   - The kit also accepts a Sphinx address `"<pubkey>_<lsp_pubkey>_<scid>"` as the
     `pubkey`, and splits it into the pubkey and a one-hop hint.
   - A provider that cannot route with hints answers `NOT_IMPLEMENTED`.
2. **`state` on keysend, and a `keysend` payment type for NWC-09's
   `lookup_payment`:** `details { payment_hash, pubkey, preimage?, tlv_records? }`.
3. **`payment_failed`,** beside NWC-02's `payment_received` and `payment_sent`. An
   async payment that never settles has to be told.

Each is a candidate NWC extension once it works here.

**Errors.** NWC's codes in `error.data.code`: `PAYMENT_FAILED`,
`INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED`, `RESTRICTED`, `UNAUTHORIZED`,
`NOT_IMPLEMENTED`, `RATE_LIMITED`, `NOT_FOUND`, `INTERNAL`, `OTHER`. strut adds
**`USER_REJECTED`**: the person said no. NWC has no such code, because a wallet
service never sees the person; WebLN's `RejectionError` is that case.

### 2.4 The kit

- **`useWallet()`** returns
  `{ available, connected, info, connect(request?), payInvoice, payKeysend, makeInvoice, lookupPayment, getBudget, getBalance?, listTransactions?, payLightningAddress?, on(type, fn) }`,
  with NWC's param names in msat and `sats()` / `msat()` helpers. It rejects with
  `WalletError { code }`.
- **`useTransaction(id)`** follows one payment live: a notification, else
  `lookup_payment` while it is pending and the page is visible.
- **`window.webln` inside the frame,** installed by the bootstrap when the host
  offers a wallet. It is the full WebLN surface Alby's extension has, mapped the
  way Alby's `NostrWebLNProvider` maps it (sats in, msat on the wire):

  | WebLN | Maps to |
  |---|---|
  | `enable()` | `connect()` |
  | `getInfo` | `get_info` |
  | `sendPayment` | `pay_invoice` |
  | `sendPaymentAsync` | `pay_invoice`, not awaited |
  | `keysend({ destination, amount, customRecords })` | `pay_keysend`, UTF-8 records to hex |
  | `makeInvoice` | `make_invoice` |
  | `lookupInvoice` | `lookup_payment` |
  | `getBalance` | `get_balance` |
  | `lnurl` | `pay_lightning_address` |

  `signMessage` always throws `UnsupportedMethodError`: an app never chooses
  what the wallet signs. Signing in is `useVisitor()` (§4.4).
  - **A WebLN payment never rejects while it may still settle.** That would invite
    a retry and a double payment.
  - `sendPayment` resolves `{ preimage }` when settled. If still pending after the
    window, it resolves `{ preimage: null, pending: true, transactionId }`.
  - `keysend` resolves with the sender's preimage, as WebLN apps expect, and the
    payment's real state is on `useTransaction`.
  - Models write `window.webln` code unprompted, and Bitcoin Connect's
    `requestProvider()` and `@getalby/lightning-tools` (`sendBoostagram`,
    `fetch402`) find it.
- **`useCheckout()`** (§6) and **`useValueBlock()`** (§7).
- **The build's source check** learns one warning: importing `sphinx-bridge`,
  `@getalby/bitcoin-connect` or `@getalby/sdk` names `useWallet`, since none of them
  reaches a wallet from the frame.

## 3. Sphinx: keysend and async settlement

What Peel's provider has to carry, read in the code:

- **A Sphinx address** is `<pubkey>_<lsp_pubkey>_<scid>`, and its route hint is the
  part after the first underscore, `<lsp_pubkey>_<scid>` (`parse_route_hint`). A
  legacy hint `<pk>:<scid>` is accepted and never paid async
  (`parse_route_hint_legacy_ok`, `sphinx/src/bindings/utils.rs`).
- **Keysend is a real Lightning keysend**
  (`keysend(seed, time, to, state, amt_msat, data?, route_hint?)`,
  `sphinx/src/bindings/mod.rs`).
  - It is built as a spontaneous payment by LDK
    (`RecipientOnionFields::spontaneous_empty`), so it pays any node, not only
    Sphinx accounts.
  - Its `data` rides in ONE custom TLV record, type **13377331**, as base64
    (`SPHINX_TLV_KEY`, `sphinx/src/onion_payment.rs`). Sphinx v1's relay used
    133773310.
  - The core takes no other records, so bLIP-10's 7629169 cannot be sent today
    (§7).
- **Async settlement.** With a non-legacy route hint the payment is async
  (`do_async`):
  - The payer's LSP keeps the payment onion, tagged, and an onion message asks the
    payee's LSP to ping them.
  - When the payee comes online and answers, the payer's LSP sends the payment.
  - Neither LSP learns both ends (`sphinx/docs/async_payments.md`), though on one
    mixer the code does learn both (plans/private-voice.md §5 traced it).
- **The mixer answers `PENDING`, `COMPLETE` or `FAILED`,** with the preimage on
  `COMPLETE`, both for a transfer between two accounts on the mixer
  (`move_funds` → `shift_balance`, `mixer/src/send.rs`) and for a CLN payment
  (`mixer/src/ln.rs`). A local payee who is away leaves the onion stored, and the
  answer is `PENDING`. That is our §2.2 `state`, as it is.
- **Peel already treats pending as normal.**
  - `Storage.spendableMsat` is the balance less what still waits for people to
    come online.
  - `reconcileInBackground` settles or fails our open sends from the server's
    history, back 30 days.
  - What it lacks for apps: it keeps no preimage (`SentStatus` decodes `tag`,
    `status`, `message`, `error` and drops `preimage`, `Engine.swift:1761`); it
    sends sats only to a contact, by message (`sendPayment(to:)`: type 5), and
    never calls the core's raw `keysend`; and it emits no per-payment event a
    notification could hang on.
- **Invoices.**
  - `make_invoice` in Peel is the mixer-made invoice (`Sphinxrs.requestInvoice`),
    which settles while Peel is closed. That suits an app, since the payer may pay
    any time.
  - Paying one goes through `payInvoice` with its refusals: expired, own, already
    paid, over spendable.
  - The mixer waits only 4,200 ms for a preimage on an HTLC
    (`mixer/src/interceptor.rs`), so anything held for long (a call, a stream) is
    PREPAID, never a held HTLC.

## 4. Consent: per-app connections

**What the ecosystem does, and so what we do:** an app asks once for a
CONNECTION — methods, a budget that renews, an expiry — the person grants it,
perhaps with less, and payments inside it need no prompt. This is:
- NWC-08's client-initiated connection request;
- Alby Hub's app connections;
- Alby's per-site allowances;
- sphinx-bridge's `enable()` budget;
- NAP-VALUE's allowance bound to app identity.

Streaming sats every minute (§7) is impossible without it. The difference from
sphinx-bridge is that the HOST keeps and enforces it, never the app (§9).

### 4.1 The request, declared in `app.yaml`

```yaml
wallet:                                  # NWC-08's request fields, msat
  request_methods: [pay_keysend, pay_invoice, make_invoice, lookup_payment, get_budget]
  optional_request_methods: [get_balance, list_transactions]
  notification_types: [payment_received, payment_sent, payment_failed]
  max_amount: 5000000                    # 5,000 sats per period, fees included
  renewal_period: weekly                 # never | daily | weekly | monthly | yearly
  expires_at: null
```

- The manifest checks it at build (manifest.ts: a method or notification it does
  not know is an error), and the publish keeps it on the version.
- It is a REQUEST, not a grant. The meta surface may publish one; the PERSON
  grants it.
- The app's page and listing show it: "asks to spend up to 5,000 sats a week".
- A version that asks for more than the connection holds asks the person again.
- An app with no `wallet:` block gets no wallet: every call is `RESTRICTED`, and
  the capability says so.

### 4.2 The connection

- **When it is asked.** At the first wallet call, or `webln.enable()`, or
  `connect()`, and only after the person acted in the page.
- **What the sheet shows.** The host draws it, outside the frame:
  - the app's VERIFIED identity — the title, icon and `name@vN` of the version it
    is hosting, and on whose strut — never a name the app sent (NWC-08: `name`
    and `icon` are unverified);
  - the methods;
  - the budget and renewal, which the person may lower;
  - the expiry;
  - whether to ask over budget, or refuse.
- **What is kept.** A connection record in the HOST, keyed by (viewer, seller,
  app name). The seller is the strut server whose app it is, which the app's
  identity names (`NativeWalletApp.seller`, specs/WALLET.md §1.1; R8): a
  stranger's app named like a trusted one never holds that one's connection.
  On the iPhone the org or the origin Peel loaded stands in for it (§5.3). It
  is kept in:
  - Peel's preferences on the person's devices;
  - a browser host's own storage, or Hive's server for a Hive user;
  - never the app's state or strut's.
- **What it covers.** Every call within it runs without a sheet: a toast, and the
  payment in the host's history labelled with the app.
  - A pending payment counts.
  - A failed one is refunded.
  - Over budget: a payment sheet (§4.3), or `QUOTA_EXCEEDED` if the person chose
    "refuse".
  - A method outside the connection: `RESTRICTED`.
- **Revoking.** The person can revoke, lower or raise it in the host's settings:
  Peel's Connected apps, strut UI's Wallet settings. `get_budget` reads it.
- **Isolation.** `list_transactions`, `lookup_payment` and notifications see only
  payments made or invoices made through this connection. The host tags each one.
  This is NWC-08's `isolated`, without a sub-wallet.

### 4.3 One payment over budget

The host's sheet, as Peel's `PayInvoicePane` already draws it:
- the amount in large type;
- To: the contact's name when Peel knows the payee (an org's Jamie account is
  one), else the key "not a contact";
- the memo or the keysend's message;
- the expiry, and "Fee: Added on top";
- under a header naming the app, with its `metadata.comment` quoted as the app's
  words.

The amount is always DECODED by the host from the invoice or the keysend params,
never taken from the app's words. Confirmation is two-step (`PaymentAttempt`;
`TouchPayButton`'s 700 ms wake on the iPhone). Over budget, Peel ignores its
"confirm over N sats" threshold and always asks.

### 4.4 Identity: signing in through the connection

*Rewritten 2026-11-10 (R6, §11). The 2026-11-04 text kept signing for later,
under a per-app linking key only, "never the identity key". This replaces it.*

**When a signature is needed.**
- **Not when the host knows the viewer.** Peel on the person's own strut or a
  paired org, Hive, and strut's UI with a session all know who is looking. Every
  `step_run` runs as the viewer (`ctx.actor`), so no signature is needed.
- **When the app is a public one** on a box the host is not signed in to: a
  served app at its own domain, or a strut's public view (`plans/app-repos.md`
  §5). There the viewer is a visitor. Signing in is signing strut's visitor
  challenge with a key (app-repos §5.2), and the key the person already has is
  their wallet: Peel.

**Signing in is part of the connection.**
- **One grant more.** The connection (§4.2) gains a sign-in grant beside its
  methods and budget. An app that wants both gets ONE sheet: who you are, and
  what it may spend.
- **How the app asks.** It calls the kit's `useVisitor().signIn()` (app-repos
  §5.2), and strut's UI does the rest:
  - fetches the seller's visitor challenge;
  - asks the native host with a HOST request,
    `{ v: 1, op: "sign_in", seller, app, challenge }`.

  That request sits beside #625's `buy_credit` in `specs/WALLET.md` §1.2:
  the same handler, listed by `host_capability`, never a `strut/wallet/*`
  method. An app never sees the request or a key.
- **Where the session is kept.** The seller's visitor token is kept by
  strut's UI per seller, as #625 keeps its purse: the seller's cookie is
  third-party on a page another strut hosts.
- **What Peel's sheet adds:**
  - the seller's origin: on the Mac as the person's own strut UI names it;
    on the iPhone from Peel's own record of the page it opened (§5.3);
  - "Sign in as **you**", the person's Sphinx account;
  - or "as **a new identity for this app**", the sub-account below.

  An app that requires a sub-account (`visitorKey: domain`, app-repos §5.2)
  shows only the second.
- **After the first sign-in.** A sign-in to the same origin within the
  connection runs without a sheet, with a toast, as a payment within its
  budget does. Revoking the connection ends both.

**What is signed: only strut's challenge, bound to the seller's domain.**
- **The challenge,** `strut-visitor.<claims>.<hmac>` (app-repos §5.2), names
  its `host`.
- **Peel checks it.** It reads that claim and signs only when it equals the
  seller:
  - **on the Mac,** the `seller` the person's own strut UI names (#625's
    remote mode, which Peel trusts as its main frame);
  - **on the iPhone,** the origin Peel itself loaded, whatever the page
    claims (§5.3, R7).
- **A box gets a signature over its own login only.** That closes
  sphinx-bridge's worst hole (§9, one app minting another app's login) by
  binding the signature to a domain, not by keeping the identity key out of it.
- **No general `sign_message`.** `sign_in` signs a strut challenge or
  nothing: an app never chooses the message.
- **The connection is keyed by** (seller, app) on the Mac, and by origin on
  the iPhone. Either way, a page cannot sign in, or spend, as another.

**Which key.**
- **By default, the root key.** The person's Sphinx node key, the one their
  payments come from. The same person is the same visitor on every app: a
  portable profile, and one apps can link.
- **A sub-account.** A child key derived from the 12 words' BIP39 seed and
  the origin by exact LUD-05 (stakwork/sphinx-rs#106, v0.8.43), used when
  the person picks it or the app requires it. The visitor is then
  unlinkable across apps. A Sphinx account with no words (an agent's) signs
  in with its root key only.
  - The child key only signs in; payments still come from the account.
  - Whether a payment tells its payee who paid is the payment's business. A
    sub-account keeps the LOGIN unlinkable, nothing more.

**The signature and the actor.**
- **The signature.** Sphinx signs with the node secret (`sign_bytes` /
  `sign_base64` in sphinx-rs: a Lightning signed message, recoverable ECDSA
  over secp256k1). Strut checks it with one more verifier beside app-repos
  §5.2's four, `ln-message`.
- **The actor** is `secp:<x-only pubkey>`, so the same key signing in through
  any other method is the same person.
- **The method** is `sphinx` in `serve.yaml` and the public view (app-repos
  §5.3, 6), named for the identity, not the wallet: Peel is its first host,
  and any later Sphinx wallet signs the same challenge the same way.
- **`get_info` still leaves out `pubkey`.** An app learns who signed in from
  `useVisitor()`, never from the wallet.

**Other hosts, later.**
- A browser host's wallet that can sign does the same through §5.2's
  providers: WebLN's `signMessage` (the Alby extension), or NWC where a
  wallet offers signing.
- The passkey Sphinx wallet (app-repos §5.4) is `sphinx`'s next host. The
  in-page wasm wallet is a method of its own, `sphinx-wasm`: it makes a new
  account per domain rather than signing as the person's.

## 5. The hosts

### 5.1 `WalletHost`, one piece of code

A host-side module, `@strut/kit/wallet-host` (the kit's host library that
plans/apps.md §12 defers, starting here). It holds:
- the `strut/wallet/*` handlers for an `AppBridge`;
- the connection store interface;
- budget accounting (atomic with the payment, refunded on failure);
- the sheets as callbacks the host renders;
- the notification fan-out to frames;
- the providers.

strut's UI, Hive's `strut-app-frame` (embedded and full-screen) and any standalone
host each construct one with their own storage and sheets. Adding a host is
wiring, not a protocol.

### 5.2 A browser host: strut's UI, Hive, a standalone app host

The person picks their wallet once, in the host:
- **Bitcoin Connect's modal** as the picker: the Alby extension, Alby Hub (NWC-08,
  a popup), a generic NWC URL, LNbits, Coinos, Cashu.me, Flash, Rizful, LNC. It is
  lazy-loaded on the first wallet call (about 150 kB gzipped).
- **"Connect Peel"** once Peel speaks NWC (§5.4).

The result is a provider:
- NWC-based connectors are `NwcProvider`, nearly 1:1 with our wire.
- The extension and the non-NWC connectors (LNC, LNbits) are `WebLnProvider`,
  which offers only what that wallet advertises: LNC has no `makeInvoice`, LNbits
  no keysend, and `get_info.methods` says so to the app.
- Notifications come from `NWCClient.subscribeNotifications`. WebLN has none, so
  the host follows what it started through lookups.

strut's UI page sets no CSP, so its relay websocket works; a host that sets one
adds the relay to `connect-src`. Two budgets stack: the host's per-app connection,
and the wallet's own (an NWC connection's `max_amount`), which is a second line
the host does not control.

Hive can also keep a user's NWC connection on its server, so their apps have a
wallet on any device. That is Hive's choice; the wire is the same.

The seller rides in the app's identity (`NativeWalletApp.seller`, R8): this
server's base, or a stranger's public app's `from`. A browser host keys its
connections by it, as Peel does.

### 5.3 Peel

In Peel the money is in the engine, so the WalletHost is NATIVE (Swift): its
connections live in Peel's preferences, its sheets are Peel's, its budget is
decremented in the same transaction as the payment (`commitAndPublish`). strut's
UI, as Peel's main frame, is a pass-through:
- It sees `window.webkit.messageHandlers.strutWallet` and forwards every
  `strut/wallet/*` request to it, with the app it is hosting
  (`{ name, version, peer, seller }`).
- The seller rides in that identity (R8): Peel's own strut for the
  person's and an org's apps, the `from` of a stranger's public app. Peel
  holds it to its own record of the address it opened, keys the connection
  by it, and names it on the connect sheet.
- The reply comes back through `WKScriptMessageHandlerWithReply`'s promise: no
  global callback, no id juggling.

Peel's side:

- **Its first JS-to-native handler,** reversing `docs/phases/05-parity.md` ("No
  `sphinx` bridge in v1"). This is the ruling R1 asks for.
  - Answered only when `frameInfo.isMainFrame` is true and the origin is the one
    Peel loaded: the Mac's `MemoryServer`, or the org's base URL on the iPhone.
  - WebKit hands `messageHandlers` to every frame, the app's srcdoc frame
    included. Home Assistant's iOS app moved its bridge to the main frame for this
    reason, and none of the old Sphinx hosts checked it (§9).
- **Who is asking.**
  - On the Mac the main frame is code Peel ships, and the local strut knows which
    peer's app it hosts, so a connection is keyed by (org, app).
  - On the iPhone the main frame is the org's own code, which could name any of
    its apps. So there a connection is keyed by ORG, with the app named as the
    org's page reported it. The sheet names the org from Peel's own record of the
    page it opened, so an org can never pose as another.
- **The engine,** with four changes:
  1. Keep the preimage: `SentStatus.preimage`, stored on the record.
  2. `keysend(to:amountMsat:routeHint:tlv:)` to ANY address, over the core's raw
     `keysend`, with `checkPayment`'s balance and pending accounting.
  3. A per-payment state stream (pending → settled or failed) from what
     `reconcileInBackground` and the live `sent_status` already learn, which the
     notifications hang on.
  4. A connection tag on each payment and invoice, for isolation and history.
- **"Only after the person acted."** A connection request, or an over-budget
  payment, opens a sheet only after a click or tap in the web view
  (`personActed`: native events no script can make). Calls inside a connection
  need no gesture, which is what lets a stream run.
- **The iPhone pays only in the foreground,** with the engine connected. An app on
  screen is.
- **A stranger's public app: a box Peel is not paired with** (§4.4). It is
  hosted one way on the Mac and another on the iPhone (R7).
  - **On the Mac: #625's remote mode.** Peel opens
    `<its local strut>/?app=<name>&public=1&from=<seller>`.
    - The main frame is still Peel's local strut UI, at `MemoryServer`'s
      origin, so the handler's rules do not change.
    - Only the sandboxed frame is the stranger's, and the UI names the
      seller.
    - Connections are keyed by (seller, app).
  - **On the iPhone: direct open.** There is no local strut there to host
    the page, so Peel loads the served app's own URL (a link, or
    `peel://open?url=…`), and that box's own code is the main frame. This
    is R5's rule for orgs applied to any origin:
    - **The handler answers that origin,** as the third it answers beside
      the Mac's `MemoryServer` and an org's base URL.
    - **Every connection is keyed by that ORIGIN.**
    - **Every sheet names it from Peel's own record** of what it opened.
    - **Peel ignores what the page claims about itself:** the `seller` in
      a `buy_credit` purchase, an app's name or version.
    - **Peel decodes every invoice itself,** as `specs/WALLET.md` §1.2
      (#625) already requires.
  - **What a stranger's main frame can still do:** draw what it likes and
    ask often. It cannot move money or sign without Peel's sheet, and the
    gesture rule (sheets only after a tap) bounds the asking. It is what
    any site gets from a browser wallet extension.
  - **Later: the same mode on both.** Once Peel bundles strut's UI on the
    iPhone (§12, 8), the iPhone uses remote mode too. Remote mode runs
    nothing on the hosting strut (`web/src/remote-app.ts`), so the bundle
    is strut's static UI files, not a server.

### 5.4 Peel as an NWC wallet service (later, and the biggest reach)

Peel could serve its Sphinx account over NWC. It would publish a 13194 info event
and answer 23194 requests on a relay, with each NWC connection being one of the
connections above. Then:
- **Any browser host** gets "Connect Peel" through NWC-08 (a QR code, or a
  `nostr+walletauth://` link Peel opens). An app in Hive on a laptop pays from the
  person's phone or Mac, with no extension and no Sphinx web code.
- **Every NWC app in the ecosystem** — Damus, Primal, Amethyst, Fountain — can use
  a Sphinx wallet, with async keysend underneath.

It costs a relay connection while Peel runs, and an NWC key per connection. The
Mac is usually on; the phone answers only in the foreground. That is also where
the routing-hints extension (§2.3) gets used outside strut.

## 6. The receive side: `ctx.services.lightning`

The app's server side uses the same interface, with an app's grants limited to
receiving:
- **`NwcProvider`:** a connection URL as a deployment secret
  (`LIGHTNING_NWC_URL`), scoped in the wallet to `make_invoice`,
  `lookup_invoice` and notifications. It is server-side, so the socket is fine,
  and it needs no Sphinx change.
- **`SphinxDaemonProvider`:** the org's own Sphinx account, Jamie's, which the org
  home runs (plans/org-home-swarm.md §4.2). `POST /invoice` exists. It needs
  `GET /invoice/:hash`, and incoming keysends with their TLV records reported to
  the service. A member paying from Peel is then a `shift_balance` on the same
  mixer, settled at once.
- **Later:** LND, CLN and phoenixd (its HTTP API has invoices, offers, LNURL and
  webhooks).

Steps an app may grant:
- **`lightning/invoice { amount, description }`** writes an ORDER record (actor,
  app, amount, description) under `<dataDir>/lightning/`, kept like an app's
  writes (`keptFromApp`).
- **`lightning/verify { payment_hash, preimage? }`** is true only for an invoice
  THIS deployment issued.
  - With a preimage it checks `sha256(preimage) == payment_hash`, offline. Without
    one it asks the provider.
  - It is idempotent: the order holds `settled_at` and `delivered`.
- **`lightning/received { since? }`**: the payments the deployment received, with
  their TLV records — keysend boosts to the org, say. It is the
  `payment_received` feed, for a leaderboard or a tip wall.

None can move a sat out. A deployment wallet that spends is §8's, behind a person.

**`useCheckout({ amount, description, deliver })`**, in the kit, does the whole
loop:
1. `lightning/invoice`.
2. `payInvoice` through the host.
3. Launch `deliver` with `{ payment_hash, preimage }`. Its first step is
   `lightning/verify`, so the run IS the order.

With no wallet in the host it shows a QR code and polls `lightning/verify`: the
person pays from Peel on their phone, or from any wallet. Telegram's `openInvoice`
and Bitcoin Connect's `launchPaymentModal` share this shape: the truth comes from
the server, never the page.

## 7. Value for value: streaming and boosts

Podcasting 2.0's value block, which Sphinx co-authored (value spec v1.4, 2021),
and what Sphinx did, are why keysend and budgets are in the core set.

**`useValueBlock(feed, { satsPerMinute })`** in the kit:
1. Reads `<podcast:value>` recipients and splits, the `fee="true"` splits off the
   top.
2. Computes each minute's amounts, sent batched (`seconds_back`).
3. For each recipient:
   - `node` → `pay_keysend` with bLIP-10's record **7629169** (UTF-8 JSON: `guid`,
     `itemID`, `ts`, `action: "stream" | "boost"`, `app_name`, `sender_name`,
     `message`, `value_msat_total`, …) plus the recipient's `customKey` /
     `customValue` as its own TLV;
   - `lnaddress` → `pay_lightning_address`, or its keysend details at
     `/.well-known/keysend/<user>`.
4. Streams only inside the connection's renewing budget, never a prompt a minute,
   and stops with `QUOTA_EXCEEDED`.

Boosts are the same, with `action: "boost"` and a `message`. Amethyst does exactly
this over NWC `pay_keysend`, and Podverse and Podcast Index's web UI over WebLN
`keysend`.

**The Sphinx gap.** Sphinx v1 and v2 sent their podcast metadata in Sphinx's own
record (v2: `{ feedID, itemID, ts, uuid }` in 13377331), not 7629169, so other
apps' receivers never read a Sphinx boost as a boostagram. The core's `keysend`
takes one `data` blob. It needs a list of `(type, value)` records, a small change
in `encode_tlv`, so a Sphinx payment can carry 7629169 for the world and 13377331
for Sphinx at once. Until then, `SphinxProvider` answers `NOT_IMPLEMENTED` to
records other than 13377331.

## 8. Later: paid routines and agents paying

- **Paid routines.** `price:` on a workflow; an unpaid `run/launch` answers
  `payment_required { invoice, macaroon }`; the kit pays through the host and
  retries with `L402 <macaroon>:<preimage>`; strut verifies offline. This is the
  same token plans/p2p-distribution-research.md puts on a `peer: true` launch, and
  the voice top-up. x402's Lightning `exact` scheme is the same exchange in
  another envelope. Designed in `plans/paid-runs.md` (2026-11-10,
  proposed), with two changes: the price is in the Public view record, not
  the YAML, and the token holds credit that each run debits. That plan
  builds §6's `ctx.services.lightning` first.
- **Agents paying.**
  - On the desktop strut: a sealed `sphinx/pay` device step through the bridge Peel
    runs, carded every time (`ToolIntent.cost`), plus an `http/fetch-402` step on
    Alby's `fetch402` shape.
  - On an org strut: a device-applied proposal, where on accept Peel pays and
    posts the result.
  - Both reuse §2.2's payment and §6's verification.

## 9. What sphinx-bridge got wrong, and the rule that replaces it

All of these were read in the code of the library (0.3.2) and of the hosts that
implemented it: sphinx-ios v1/v2, sphinx-mac-v2, sphinx-kotlin, sphinx-android-v2,
the KMP desktop, Electron.

| sphinx-bridge | Here |
|---|---|
| No request ids; one global `window.sphinxMessage` per call, so concurrent calls swapped answers | JSON-RPC over ext-apps, plus `WithReply` promises to native |
| No handshake; an unknown type hung forever | `experimental["strut/wallet"]`, `get_info.methods`, `NOT_IMPLEMENTED` |
| No origin check: `"*"`, handlers open to every frame, navigation inherited the bridge | The frame reaches only its host's relay; Peel answers its main frame at its own origin |
| The app was unidentified (the tribe's `app_url`) | The host's verified identity of the version it hosts; on the iPhone, the org |
| The budget was in the app's JS for years; iOS stored an app-supplied `amount`; Android never decremented; no refunds | The connection lives in the host, decremented with the payment, refunded on failure, shown and revocable |
| `SIGN` signed anything with the identity key, silently | Signs only strut's login challenge, bound to the seller's domain, inside a connection the person granted. The root key by default, a per-app key when the person or the app chooses (§4.4) |
| `PAYMENT` returned no preimage; Android claimed success before settling; iOS's LSAT lost tokens after 7 s | §2.2: a state, the preimage on settle, never failure as success |
| One LSAT bag for all apps, the issuer self-declared | No tokens in the wallet; L402 is the server's (§8) |
| A dismissed prompt sent nothing back | `USER_REJECTED` |
| Keysend with no state or proof | `pay_keysend` with route hints, a state and notifications (§2.3) |

## 10. The standards, and what each is for here

- **NIP-47 / NWC** (core cut 2026-08-01; extensions in nostr-wallet-connect/nwc):
  our wire's names, shapes, units, errors, notifications (02), hold invoices (03),
  keysend (04), lists (05), metadata (06), connection requests (08), payment
  lookup (09), budgets (13), `pay` (321). Also the browser and server provider.
  Alby Hub's connection page uses `budget_renewal` where NWC-08 says
  `renewal_period`; we use the spec's name.
- **WebLN** (webln.guide, `@webbtc/webln-types` 3.0): the frame's familiar surface,
  and the extension provider. It blocks until a preimage, and `sendPaymentAsync`
  gives no handle, which §2.2's mapping covers.
- **Bitcoin Connect** (3.12, alpha): the wallet picker in a browser host. Its NWC
  connectors are `NostrWebLNProvider`; LNC and LNbits advertise less.
- **Alby SDK** (`@getalby/sdk` 9): `NWCClient` (60 s reply timeout,
  `subscribeNotifications`) and the WebLN→NWC mapping we copy.
  `@getalby/lightning-tools`: Lightning Address, `sendBoostagram`, `fetch402`.
- **Backends seen through NWC or directly:**
  - LNbits: hold invoices, LNURL, websocket.
  - phoenixd: synchronous pay, offers, LNURL, webhooks.
  - Breez Spark: `Pending`/`Completed`/`Failed` events, LNURL, no keysend.
  - Cashu: no keysend.
  - Keysend is the method the fewest backends have. Hence `NOT_IMPLEMENTED`, and
    `get_info.methods` telling the app.
- **LNURL:**
  - LUD-06/16/12/18 behind `pay_lightning_address`, and LUD-21 to verify.
  - LUD-05's per-domain derivation for a sub-account (§4.4).
  - LUD-04 auth is one of a visitor's sign-ins (`plans/app-repos.md` §5.3),
    not the wallet's.
- **bLIP-10 + the value block:** §7.
- **L402, x402, MPP:** server and agent concerns (§8).
- **MCP Apps:** no payment capability. `experimental` plus a namespaced method is
  the sanctioned way.
  - OpenAI's `window.openai.requestCheckout` is the closest precedent for a frame
    asking its host to pay.
  - SEP-2007 (x402 in MCP) was closed without merging.
  - The draft's framing rule (`allow-scripts allow-same-origin` on a separate
    origin) is laxer than strut's opaque frame, which is why nothing in-page
    reaches a wallet.
- **Prior art for consent:**
  - Alby allowances, Alby Hub connections, NWC-08 and NAP-VALUE: budgets per app
    identity.
  - Telegram Mini Apps and WeChat: a native sheet per payment, the server's word
    as truth.
  - Fedi: injected WebLN, per call.
  - Every one draws its sheet from data the host can inspect.

## 11. Rulings (2026-11-04), and open questions

- **R1, accepted. Peel gets a JS-to-native wallet bridge,** `strutWallet`: main
  frame only, its own origin, connections and sheets native. This reverses
  05-parity's "No `sphinx` bridge in v1".
- **R2, accepted. The wire is NWC,** with strut's three additions (route hints,
  payment `state`, `payment_failed`) and `USER_REJECTED`. Every pay returns on
  acceptance, with a state.
- **R3, accepted. Consent is a per-app connection with a renewing budget,**
  declared in `app.yaml`, granted in the host, with no prompt inside it. Over
  budget: a sheet or a refusal, the person's choice.
- **R4, later. Peel as an NWC wallet service** (§5.4) comes after the in-Peel
  bridge.
- **R5, accepted. The iPhone ships with the Mac.** Its connections are keyed by
  org, since its main frame is the org's code (§5.3).
- **R6, ruled 2026-11-10. Signing in rides the connection** (§4.4, rewritten).
  - **The ask.** A public app asks Peel to sign the person in, and the
    connection grants it, on the same sheet as the budget.
  - **The key.** The person's root Sphinx key by default, or a sub-account
    key per app when they or the app choose.
  - **The guard.** Only strut's challenge is signed, bound to the seller's
    domain (on the iPhone, the origin Peel loaded).
  - **What it replaces:** the 2026-11-04 "per-app linking key, never the
    identity key".
  - **Why.** The owner's words: "We already have a wallet! It's called
    Peel!" It matches `plans/app-repos.md`'s ruling 3 (one root key by
    default).
- **R7, ruled 2026-11-10. On the iPhone a stranger's public app opens
  directly** (§5.3).
  - **What it means.** Peel loads the served box's own URL and keys every
    connection and sheet by the origin it loaded, as R5 does for orgs.
  - **Why.** #625's remote mode needs a strut UI of the person's own to host
    the page, and the iPhone has none. The Mac keeps remote mode.
  - **Later.** Bundling strut's UI in Peel on the iPhone (§12, 8) would let
    it use remote mode too.
- **R8, ruled 2026-11-13. A visitor's page gets the wallet connection,**
  this server's public apps and other servers' alike, keyed by seller (§4.2,
  §5.2, §5.3).
  - **What it means.** A public app's page whose version requests a wallet
    is offered the person's wallet in Peel's web view, as a member's page
    is. Its request comes from the public read (`GET /public/apps/:name`:
    the build's `wallet`, nothing else of the build). A stranger's page
    (#625's remote mode) still gets nothing else its version declares.
  - **The key.** The app's identity names its `seller`, always: this
    server's base, or `from`. Every connection is keyed by (viewer, seller,
    app name), so a stranger's app with a trusted app's name never reuses
    its connection or budget. Peel's sheet names the seller, as
    `buy_credit`'s does.
  - **Why.** §12 item 9's first test ends with a tip through the
    connection, and a visitor's page had no wallet to tip with
    (`AppHost.tsx` offered it only when `!visitor`, 32d09ae5).
  - **Not changed.** `get_info` still leaves out `pubkey`; strut's relay
    now drops it too, whatever the native host answers.

Open questions:
- **Keysend via the core to a non-Sphinx node.** Is the route through the LSP's
  synced graph enough, or does it need `concat_route` through a router
  (`sphinx/docs/routing.md`)?
- **Preimages after a reconnect.** Does a payment whose status arrives through
  `get_tags` carry its preimage, as a live `sent_status` does?
- **The org's payee.** Who receives for an org's apps: Jamie's account, or a
  treasury account per org? The mixer's ledger is custodial.
- **Refunds** are the deployment spending. v1 records what is owed.
- **`lightning:` links.** Peel registers only `peel://` (Mac). The QR fallback's
  "Open in wallet" wants `lightning:`.

## 12. Work items

1. **The wire and the kit:** `strut/wallet/*` types, `useWallet`, `useTransaction`,
   `WalletError`, the `window.webln` shim, `wallet:` in `app.yaml` (manifest.ts),
   and bootstrap tests against a fake host.
2. **`WalletHost` + `NwcProvider` + `WebLnProvider`** in `@strut/kit/wallet-host`,
   wired into strut's UI (`connectAppHost`): connections in its storage, sheets as
   modals, Bitcoin Connect as the picker. Add the methods to plans/apps.md §7.4's
   host contract.
3. **Peel:**
   - The engine's four changes: preimage, raw keysend with route hints, a payment
     state stream, connection tags.
   - The native WalletHost: the `strutWallet` handler, the connection sheet,
     Connected apps in settings, the over-budget `PayInvoicePane`.
   - Mac and iPhone together (R5): on the iPhone, `OrgWebView` and
     connections keyed by org.
4. **The Sphinx core:** `keysend` with a list of TLV records; and sphinx-daemon's
   `GET /invoice/:hash` plus incoming-keysend reports.
5. **Receive:** `ctx.services.lightning` (NWC, then the daemon); `lightning/invoice`,
   `lightning/verify`, `lightning/received`; `useCheckout`.
6. **The `App` Concept page:** how a builder asks for a wallet (`wallet:`), a
   checkout, a tip jar, a value block. Written as postures: verify on the server;
   ask for the least.
7. **Hive's `strut-app-frame`** constructs a WalletHost (embedded and full-screen).
8. **Later:** Peel on iOS bundling strut's UI (served through a custom URL
   scheme, its API calls sent to the org with the person token), so the main
   frame is Peel's code on the iPhone too and connections can be keyed per app
   (ruled 2026-11-04: by org for now); Peel as an NWC wallet service; `useValueBlock`; `pay` (321) and
   BOLT12; hold invoices; paid routines; agents paying; the three extensions
   proposed to NWC upstream.
9. **Signing in through Peel (§4.4, R6, R7).** Builds on #625 (remote public
   apps, `buy_credit`). The first test: a public app on a box Peel is not
   paired with. On the Mac it opens through #625's remote link, on the
   iPhone directly. The person signs in through the connection, writes a
   row as themselves, then tips through the same connection.
   - **strut:** *BUILT, stakwork/strut#645.*
     - the `sign_in` host request beside `buy_credit` in `specs/WALLET.md`
       §1.2, listed by `host_capability`, with vectors beside #625's
       credit vectors, which Peel copies (`sign_in_requests`,
       `sign_in_replies`, and `sign_in_signatures` made by Sphinx's own
       signer, `scripts/ln-message-fixtures`);
     - strut's UI sending it for `useVisitor().signIn()`, and keeping the
       seller's visitor token per seller — in #625's remote mode (the
       seller is `from`; the sign-in routes answer CORS `*`) and on a
       direct open (the seller is the page's own origin);
     - the `ln-message` verifier beside app-repos §5.2's four;
     - `sphinx` among `serve.yaml`'s and the public view's sign-in methods
       (app-repos §5.3, 6: one method for every Sphinx wallet, Peel its
       first host).
   - **Peel:** *BUILT, stakwork/peel#551* (with #625's `buy_credit`), on
     sphinx-rs v0.8.44, which holds stakwork/sphinx-rs#106's LUD-05 signing.
     - the sign-in grant on the connection sheet ("you" or "a new identity
       for this app");
     - signing with the node key, or the LUD-05 child key;
     - the challenge's `host` checked against the seller: the one its own
       strut UI names on the Mac, the origin it loaded on the iPhone;
     - on the iPhone, direct open of a stranger's served app, with the
       handler answering that origin and every connection and sheet keyed
       by it, the page's own claims ignored (§5.3).
   - **Tried, 2026-11-12:** a person's everyday Peel on the Mac (Peel's
     main, strut 9d74d29) opened a public app on a local served box it is
     not paired with (`serve.yaml` with `signIn: [sphinx]`), through #625's
     remote link. The sign-in sheet came up, the person signed in, and the
     app saw them as `secp:<key>`.
   - **Not tried yet:**
     - the iPhone's direct open: no iPhone build on v0.8.44 yet (its iOS
       bindings are not built);
     - the rest of the first test on a real box: a row written as the
       visitor, then a tip and a credit purchase through the connection.
10. **A visitor's page pays through the connection (R8).** What item 9's tip
    needs: a public app's page, this server's or another's, holds a wallet
    connection keyed by its seller.
    - **strut:** *stakwork/strut#690.*
      - `GET /public/apps/:name` (and so another server's read, through
        `from`) carries the version's `wallet` from its `dist/build.json`;
      - `NativeWalletApp.seller`, always present, checked by
        `nativeWalletAppProblems`, with the `native_apps` vectors, which
        Peel copies;
      - `AppHost.tsx` offers the native wallet to a visitor's page whose
        version requests one, a stranger's included (its other declared
        permissions still dropped);
      - the relay drops `pubkey` from `get_info`.
    - **Peel** (stakwork/peel, a separate change):
      - reads `seller` in `WalletApp` and runs the `native_apps` vectors;
      - holds it to its own record of what it opened: its own strut's
        origin for an app there, the `from` it opened for a stranger's
        (`WalletScope.remote`); on the iPhone, ignores it (keyed by org or
        origin, §5.3);
      - keys every connection by seller (`remote:` already is) and names
        the seller on the connect sheet and in Connected apps, as
        `buy_credit`'s sheet does.
    - **Not tried yet:** a tip from a stranger's page on the Mac, and from
      a served box opened directly on the iPhone.
