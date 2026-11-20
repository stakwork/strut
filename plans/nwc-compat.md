# Apps and standard NWC

> **Status (2026-11-13): an idea for later, not scheduled.** Nothing here is
> ruled. Companion to `plans/app-payments.md` (the wallet in apps) and
> `specs/WALLET.md` (its contract).

## Why

An app's page reaches the person's wallet through `strut/wallet/*`: NIP-47
(NWC)'s method names, params and results, carried over the MCP Apps bridge to
the host, which holds the wallet. That keeps wallet secrets out of
model-written app code. It also means an app written for ordinary NWC, or for
a browser extension like Alby, does not run in strut unchanged. It would be
good if it did: build an NWC app, and it works in strut, in Peel and in a
browser.

## Where strut differs from plain NWC today

| | Plain NWC | strut |
| --- | --- | --- |
| Transport | Nostr relays, with a `nostr+walletconnect://` secret the app holds | The MCP Apps bridge to the host. The app holds no secret, and its CSP blocks relay sockets |
| Consent | The connection string's `max_amount` | A per-app connection with a budget, granted on the host's sheet (`connect`) |
| Additions | | Route hints on keysend, a `state` on every payment, `payment_failed`, `USER_REJECTED` |
| `get_info` | Includes the wallet's `pubkey` | Leaves it out. Since #690 the kit's relay also strips it |
| Where it works | Anywhere | Only in Peel's web view: there is no browser host yet |

## Possible steps (any order, each optional)

1. **`pubkey` in `get_info`.** The only cost is that a per-app sign-in
   identity no longer stays separate from the person's real Sphinx key in an
   app they connected a wallet to. Signing as someone stays impossible, since
   pages still cannot sign arbitrary data. If adopted, remove #690's guard and
   re-rule `app-payments.md` §4.4.
2. **An NWC client shim in the kit.** The API of the common NWC client (Alby
   SDK's `NWCClient`: `getInfo`, `payInvoice`, `payKeysend`, `makeInvoice`,
   `lookupInvoice`, `listTransactions`, `getBalance`, notifications) on top of
   the bridge, so code written against it builds unchanged. `window.webln`
   already covers WebLN apps.
3. **A browser host.** `app-payments.md` §12 item 2: `WalletHost` with
   `NwcProvider` and `WebLnProvider` in strut's UI, Bitcoin Connect as the
   picker, so a plain browser's page gets the person's NWC wallet or Alby
   extension.
4. **Upstream the additions.** Propose route hints, payment `state` and
   `payment_failed` to NIP-47, so strut's wire is NWC plus standard
   extensions.
5. **Peel as an NWC wallet service** (`app-payments.md` §5.4), so any NWC app
   anywhere can use a Peel account.

## Open

- Whether an app should ever hold a real NWC connection string (e.g. a
  server-side workflow paying from its own wallet), or always go through a host.
- How far budgets and per-app isolation survive once a browser extension is
  the wallet: an extension has its own prompts and no notion of strut's apps.
