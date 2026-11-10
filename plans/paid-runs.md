# Public and paid runs — a workflow or a tool anyone can run, free or for sats

> **Status (2026-11-10): proposed; nothing built.** From one design
> conversation with the owner. Rows in "Decided" marked **ruled** are his
> words; rows marked *agreed* are proposals of mine he accepted ("I agree
> with these leans", "ok fine"); every other row is *proposed*. Written
> against strut `main` @8a276d21. The Sphinx daemon (`sphinx/wasm/daemon`)
> and the LLM gateway (`stakgraph/gateway`) were read in code that day, not
> run; §7 and §9 say which facts are theirs. Companion to
> `public-surface.md` (the Public view: this adds RUNNING to it, its §11
> "public launches"), `marketplace.md` (§6: "later, in its own plan — paid
> execution" is this plan), `app-payments.md` (§6, the receive side, which
> this builds first; §8, "paid routines"),
> `p2p-distribution-research.md` (Option E, the research behind the rail)
> and `mothership-cost-control.md` (the cap a run gets).
>
> **Revised the same day:** the first draft gave strut a run budget of its
> own, for a seller with no gateway. *Ruled:* the gateway runs everywhere,
> so that is dropped (decision 17, §7). What is left of it is one value:
> a public run's cap, handed to the Mothership.
>
> **Ruled after that, the same day:** credit lasts a year (decision 18),
> and withdrawals get a button in the UI (decision 19; §8, and the payer
> in §9).

## Problem

A publisher can share a thing two ways today. A PACKAGE is a copy: the
buyer installs it and runs it on their own server. The PUBLIC VIEW is a
live read: anyone sees the workflow, tool, Concept tree or app, and nothing
a visitor does starts a run (`visitorRefusal`, `src/public-surface.ts:600`).

Nothing sits between them: **using a thing without having it.**

- A public graph holds a live feed of CVEs. Other servers want to query
  it, or run a workflow on it, to find what is vulnerable on their own
  system. The value is the data, which is never copied.
- A workflow takes a prompt, calls paid model APIs, slices the result with
  agents and browser steps, and returns a rigged, animated game character.
  It costs real money per run and depends on the publisher's keys and
  environment.

Four things are missing: a launch door for a stranger, a price, a way to
receive sats, and a way to bound and measure what a stranger's run costs.

## Decided

| # | Decision | Who |
|---|---|---|
| 1 | A publisher can open a workflow or a tool to anyone, free or paid, paid over Lightning with L402 so any Lightning wallet can pay. | **ruled** (the ask) |
| 2 | **Credit token.** A payment buys credit on a bearer L402 token; each run or call debits it. Pay-per-run is a token holding credit for one run. No accounts, no identities. | **ruled** ("(B) credit token makes sense!") |
| 3 | The price is in the Public view record: not in the YAML, not in the package. Changing it publishes no version. | *agreed* |
| 4 | The workflow's owner pays the model spend of a public run, as for an automation. | *agreed* |
| 5 | A public run launches the workflow AS PUBLISHED, under the peer launch rules: no `params`, a namespace of its own, opened only by a person. | *agreed* |
| 6 | Free is the same door with price 0 and a daily cap. | *agreed* |
| 7 | Receivers: the Sphinx daemon first, NWC second. | *agreed* |
| 8 | Fixed prices in sats first; metered pricing later. | *agreed* |
| 9 | Sats land in a TREASURY account apart from Jamie's: a second daemon container of the same image. Several accounts in one daemon is not built. | *agreed* ("ok fine") |
| 10 | The Sphinx daemon gains whatever this needs. | **ruled** ("we can add any features we need to the daemon") |
| 11 | Runnable is separate from readable: an item can be run by anyone without its definition or its runs being in the Public view. The launcher reads its own result. | proposed |
| 12 | Strut bills from its own run log. The gateway's cap is the brake, not the meter. | proposed |
| 13 | The ledger is one SQLite file on `node:sqlite`. Every earnings screen reads a rollup, never the payment rows. | proposed |
| 14 | Strut never holds sats and never sends sats back. A fixed-price run that fails is credited back on the token. | proposed |
| 15 | A public TOOL runs with a read-only services view. Anything that needs more is a workflow. | proposed |
| 16 | An agent never pays by itself. Buying credit is a proposal an admin accepts; spending credit already bought needs no ask. | proposed |
| 17 | A seller runs behind the gateway, which is what stops a run at its cap. Strut gets no run budget of its own. | **ruled** ("the plan is to run the gateway everywhere"), revising the first draft |
| 18 | Credit lasts a year from its purchase. What is unused then stays with the seller (decision 14: strut sends nothing back). | **ruled** ("yes credits lasting a year is good") |
| 19 | Withdrawing sats has a button in strut's UI, in the Earnings tab. | **ruled** ("yes a withdraw button in the UI is good") |
| 20 | The wallet's credentials live in a file no step can read, and the one that can pay is apart from the one that receives. | proposed |

## Design in one paragraph

A person adds a workflow or a step to the Public view's RUNNABLE list with
a price in sats (0 is free) and a daily cap. Anyone may then `POST
/public/workflows/<name>/run`. A free item launches. A paid one answers
`402` with an L402 challenge: a macaroon and a BOLT11 invoice made by the
server's wallet. The caller pays with any Lightning wallet and retries with
`Authorization: L402 <macaroon>:<preimage>`. The first time strut sees a
token it asks the wallet what was settled and writes that amount as CREDIT
in a ledger; every run or call debits the price, and a token with too
little credit gets a fresh `402`. The run is the workflow as published,
billed to its owner, capped, in a `public/` namespace; the launch answers
with a run token that opens that run's result and nothing else. The ledger
is one SQLite file: tokens, an append-only log of entries, and a daily
rollup that every earnings number is read from. Sats go to the wallet, never
to strut.

## 1. What exists

| Piece | Where | State |
|---|---|---|
| Paid execution | `marketplace.md` §6 | Deferred to this plan |
| An L402 challenge on a launch route | `p2p-distribution-research.md`, Option E | Researched, not designed |
| `price:` on a workflow, `payment_required` | `app-payments.md` §8 | Three sentences under "Later" |
| The receive side: `ctx.services.lightning`, `lightning/*` steps, `useCheckout` | `app-payments.md` §6 | Designed, not built |
| Free public launches | `public-surface.md` §11 | Not in v1 |
| The Public view, `/public/*`, visitor apps, `POST /public/mcp`, live rows in the index and the store | `src/public-surface.ts`, `src/public-routes.ts` | Built, read-only |
| A launch "as published" for an outsider | `peerLaunchBody`, `src/createStrut.ts:6153`; `bindPeer`, `src/runner.ts:235` | Built, for a peer holding a key |
| The app wallet's PAY side | `kit/src/wallet/`, Peel | Built |
| A run's spend | `RunSummary.totals`, `tallyUsage`, `src/store.ts:418` | Built |
| A per-run cap | `resolveRunCap`, `src/mothership.ts:193` | Built, enforced only through the gateway |
| Scoped HMAC tokens | `fileToken`, `publicAppIdentity`, `src/auth.ts:221,287` | Built |

## 2. The record: what anyone can run

The Public view record (`<dataDir>/public.json`, written only by `PUT
/public-view`, `src/public-surface.ts`) gains one list beside `workflows`,
`steps`, `apps`:

```ts
interface PublicRunnable {
  kind: "workflow" | "step";
  name: string;                 // a workflow name or a step type
  price: number;                // sats per run or call; 0 = free
  dailyCapUsd?: number;         // the model spend its owner carries per UTC day
  results?: "output" | "run";   // a workflow's launcher reads: its output, or the whole run
}
// PublicSurface.runnable: PublicRunnable[]
```

- **Its own list, not a field of `workflows`.** `workflows` says whose
  DEFINITION anyone reads, and `runs: true` whose runs. `runnable` says
  what anyone may START. They are independent: the CVE feed's workflow is
  runnable and its YAML is not shown. `steps` stays a list of names.
- **What `GET /public` adds:** `runnable: [{ kind, name, description,
  price, results, input }]`, `input` being the workflow's `input:` block
  or the step's input JSON Schema. A caller needs nothing else to call it.
- **`results`** (workflows): `output`, the default, shows the launcher the
  status, the output, the declared artifacts and what was debited. `run`
  also opens the events, transcripts and files, as a public run shows them
  (`publicEvent`, `publicSummary`). A seller's prompts are in its
  transcripts, so `output` is the default.
- **Checked at the save**, each refusal naming the item:
  - the workflow or step exists and is not sealed (`src/sealed.ts`);
  - a workflow declares `input:` (a stranger's payload is validated, and a
    form can be drawn);
  - a workflow whose closure `spends` has an owner, or the host set a
    public principal (§6), and when it is free, a `dailyCapUsd`;
  - a step is not `agent`, `llm`, `exec`, `acp/prompt` or a `meta/*` step,
    the list the app door already refuses: the workflow is the unit of
    spend;
  - a paid item needs a wallet (`ctx.services.lightning`, §9).
- **The dialog** (the Publish dialog's Public view tab): each workflow and
  step row gets **Anyone can run it**: off, free, or paid with a price,
  beside the daily cap. Turning it on shows what the closure can do, the
  fold the tab already uses (`publicViewNeeds`, `src/public-view.ts`; the
  `spends` / `acts` / `code` chips of `src/packages/detail.ts`), and a
  workflow that `acts` or runs `code` needs a tick: "strangers will run
  this on your server with their input".
- **A person's act.** No step and no builder tool writes the record, as
  today. The author vouches for everything the workflow reaches given any
  input, as with `peer: true`. This is not a sandbox.

## 3. The door

All under `/public`. The gate opens that prefix's READS by path whatever
its mode (`PUBLIC_PATH`, `src/public-routes.ts:71`); each new POST is
opened by name, as `POST /public/mcp` is, and the route sweeps in
`createStrut.test.ts` gain them. An item not in `runnable` answers 404: a
route nobody opened does not exist.

| Route | Does |
|---|---|
| `POST /public/workflows/:name/run` | `{ input?, key? }` and nothing else. 202 `{ runId, token, credit? }` |
| `GET /public/workflows/:name/runs/:runId` | With the run token (`?t=` or Bearer): the launcher's view. `?wait=55` holds while the run is in flight |
| `POST /public/workflows/:name/runs/:runId/cancel` | With the run token |
| `POST /public/steps/:type/run` | `{ config }`. 200 `{ output, credit? }` |
| `GET /public/credit` | With the credit token: paid, spent, remaining, expiry, the newest 50 entries |
| `POST /public/credit` | `{ sats }`: a challenge for that much credit, for a buyer who wants more than one run's worth |
| `POST /public/credit/claim` | With the macaroon alone: `pending`, `settled` (with the preimage) or `expired` (§4.4) |

A launch, in order. Each step answers before the next costs anything:

1. The per-address budget (`visitorAddress`, a smaller allowance than the
   reads' 1200 a minute) and the drain (503).
2. The body: `input` and `key` only, at most 256 KB, validated against the
   `input:` block. A bad one is 400 and charges nothing. No `params`, no
   `job`, no `callback` (a stranger's URL is not fetched), no attachments.
3. The caps: the item's `dailyCapUsd` (§7) and the server's limit on
   public runs in flight. Over either is 429 with `Retry-After`.
4. The price. Zero: go on. Otherwise the credit token: none, or one with
   too little credit, answers 402 (§4); a good one is debited (§5).
5. `launchDetached` with `origin: "public"`, the run's cap (§7), and the
   token's id on `run.start`.

`key` makes a retry safe: the same token and `key` return the same run and
debit nothing more.

**The run token.** The 202's `token` is an HMAC over `public-run:<workflow>/<runId>`,
signed like `publicAppIdentity`, so it opens that run's `/public` reads
and no private route. Free and paid runs alike get one. The credit token
is money; the run token is a receipt, safe to put in a link.

**What the launcher reads.** The existing run routes
(`/public/workflows/:name/runs/:runId[/events|/files/…]`) answer the run
token for a run that is not otherwise public, to the extent `results`
allows: with `output`, the summary route and the declared artifacts' files
only.

## 4. The token

### 4.1 The challenge

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"

{ "error": "payment_required", "sats": 2000, "invoice": "lnbc…",
  "macaroon": "<base64>", "description": "acme/voxel/character: 1 run",
  "expires": "2026-11-10T19:00:00Z", "remaining_msat": 0 }
```

The body repeats the header for a caller that reads JSON. The retry is
`Authorization: L402 <base64 macaroon>:<hex preimage>`; `LSAT` is accepted
as the scheme's old name. Nothing is stored for a challenge: the macaroon
carries what strut needs, so a flood of unpaid 402s costs strut no rows.
Invoice minting has its own per-address allowance, since each one costs
the wallet a record until it expires.

### 4.2 The macaroon

- **Format:** libmacaroons v2 binary, base64, so any macaroon library
  reads it and adds a caveat. It is not gatekey's format (the Mothership's
  macaroons are signed JSON). `src/l402.ts` is the encoder, the decoder
  and the HMAC chain, with no dependency, tested against a reference
  library.
- **Identifier** (L402's, 66 bytes): version `0` (2 bytes), the invoice's
  payment hash (32), a random token id (32).
- **Root key:** `HMAC-SHA256(L402_ROOT, token id)`. `L402_ROOT` is 32
  random bytes minted when the first paid item is saved, kept in an
  encrypted file of its own, `payments.json`, beside `peers.json`
  (`FileSecretStore` with a filename). Derived, so nothing is stored per
  token. It must be backed up with the ledger: without it no outstanding
  token verifies.
- **Caveats**, in L402's naming:

| Caveat | Set by | Means |
|---|---|---|
| `services=strut:0` | strut | L402's service line |
| `strut_sats=<n>` | strut | What the invoice was for |
| `strut_valid_until=<unix>` | strut; a holder may shorten it | When the credit ends: a year after the purchase (decision 18) |
| `strut_capabilities=<kind>:<name>,…` | a holder | Only these items |
| `strut_max_price_sats=<n>` | a holder | No single debit above this |

  A holder narrows a token by appending caveats before handing it to a
  sub-agent; no call to strut is needed. A repeated caveat must narrow. A
  caveat strut does not know REFUSES the token: a restriction it cannot
  read must not be dropped. (L402's own text skips unknown caveats; this
  is stricter on purpose.) A cap on a narrowed token's TOTAL spend needs a
  counter per signature and is later (§12).

### 4.3 Checking a token

1. Decode; derive the root key from the token id; recompute the chain.
2. `sha256(preimage)` equals the payment hash in the identifier.
3. Every caveat holds for this request.
4. The ledger knows the token id, or this is its FIRST USE: strut asks the
   wallet for the invoice by payment hash (§9), which must be settled, and
   writes the token with the amount SETTLED as its credit, in one
   transaction with a `payment` entry. The wallet is asked once per token.

Step 4 is why the preimage alone is not enough. On the Sphinx core, as
read in code, an account settles any payment whose hash matches a stored
preimage without comparing the amount to the invoice. Crediting the
settled amount is right whether or not the core is changed to refuse a
short payment. A wallet that cannot be reached answers 503, never 402.

### 4.4 A payer with no preimage

A person who pays a QR code from a phone wallet never gives the page the
preimage. The page holds the macaroon from the challenge and polls `POST
/public/credit/claim` with it; once the wallet reports the invoice
settled, the answer carries the preimage, and the page has an ordinary
L402 credential. The macaroon went only to whoever asked for the
challenge, so holding it is being that caller.

### 4.5 When credit runs out

A token with less credit than the price gets a fresh 402: a new macaroon
and invoice for the price, as L402 clients expect (they replace the token
they cached). In v1 what was left on the old token stays there, usable for
anything cheaper. With fixed prices and one run per purchase there is
nothing left over; metered pricing (§12) adds carry-over, where the new
token inherits the old one's balance.

## 5. The ledger

`<dataDir>/payments/ledger.db`, an owner-only folder, on `node:sqlite`
(built into Node; the engine `apps.md` §4.4 picked; `engines` rises to
`>=22.13`). Behind one `LedgerStore` interface with a memory twin for
tests, as every store has.

Two things of very different size are kept apart. A thousand buyers
calling hourly make about 9 million debits a year and some 12,000
payments.

| Table | One row per | Size | Read by |
|---|---|---|---|
| `tokens` | Token: `id`, `payment_hash`, `paid`, `spent`, `held`, `created`, `expires`, `closed` | Thousands | Every paid call |
| `entries` | `payment`, `debit`, `void`, `cost`, `expiry`, `withdrawal`, later `hold` / `release`: `seq`, `at`, `token`, `msat`, `subject`, `run_id`, `key`, `ref` (a payment hash), `cost_usd`. Never updated | Millions | A buyer's receipt, audits |
| `daily` | Day and subject: `calls`, `failed`, `earned`, `cost_usd` | Days × items | Every earnings screen |

- **Amounts are msat**, as in the wallet contract (`specs/WALLET.md`). The
  record's `price` and the dialog are in sats.
- **A subject** is `workflow:<name>` or `step:<type>`. A package's
  earnings are the subjects under its prefix.
- **A debit is one transaction:** `update tokens set spent = spent + ?
  where id = ? and paid - spent - held >= ?`, an insert into `entries`, an
  upsert into `daily`. The guarded update makes the check and the debit
  one step: a token cannot be overspent. A free run is a debit of 0 with
  no token, so `daily` counts it and its cost.
- **Retries:** a unique index on `(token, key)`. The same `key` finds the
  first debit and its run.
- **A failed fixed-price run is credited back** (decision 14): a `void`
  entry returns the price to the token and `daily.failed` counts it. A run
  the launcher cancelled is not credited back. The model spend of failed
  runs still counts toward the daily cap, which bounds a caller who makes
  runs fail on purpose.
- **Cost** arrives at the run's end (`onRunEnd`): a `cost` entry and
  `daily.cost_usd`, from `RunSummary.totals`.
- **Expiry** (decision 18). A token past `expires` is refused. A sweep, at
  boot and once a day, closes it and writes an `expiry` entry for what was
  left, counted as earned under the subject `expired`, so outstanding
  credit never includes credit nobody can spend.
- **Earnings never scan `entries`.** By item, by package, by day and in
  total are sums over `daily`. Received-by-day reads the `payment`
  entries through a partial index; they are few.
- **Durability.** WAL. Debits commit with `synchronous=normal`: a power
  cut can lose the last few without corrupting the file, and a lost debit
  costs the seller a sat. A `payment` commits with `synchronous=full`.
  The file is closed (the WAL folded) on shutdown, so `strut move` and a
  backup carry one file.
- **Measured** (2026-11-10, a laptop SSD, Node 24.22): one million debit
  transactions over 20,000 tokens ran at 44 µs each into a 143 MB file;
  earnings by item, by day and in total each answered in under 1 ms, a
  token's newest 50 entries in 0.1 ms.
- **Later:** `entries` older than a year exported and deleted by month
  (`daily` keeps the sums), and a periodic check that the ledger's
  payments match what the wallet says it received.

Not the proposals pattern (a file per record: millions of files and a scan
at boot), not daily JSONL with balances in memory (snapshots, per-token
reads and crash recovery by hand), not the graph (millions of payment
nodes through search, the embedding pass and Ladybug's one write queue).

## 6. The run

- **As published.** The active version, no `params`, no settings: what
  `peerLaunchBody` enforces for a peer.
- **`origin: "public"`** on `run.start` and the summary, with the token's
  id when there is one. A public run is verified like any other (claims).
- **Who pays the model.** No actor, so the principal is the workflow's
  owner, the automation rule. A host may name one principal for every
  public run (`createStrut({ publicRuns: { principal } })`), so strangers'
  runs draw on a budget of their own (§11).
- **Its namespace** (`bindPublic`, the twin of `bindPeer`): every agent
  session the run opens is `public/<token id>/<id>`, or `public/<runId>/<id>`
  for a free run, so a name a stranger chooses never opens a local thread
  or another caller's. No `job` in v1: a workflow that asks `job/dir` gets
  the run's own directory, a one-shot.
- **A tool** (`POST /public/steps/:type/run`): the config is checked
  against the step's schema, the token debited, and the step run through
  `runStep` with a bag that is an ALLOWLIST, the visitor's (`public-surface.md`
  §5), with one difference: the graph READER is the whole graph's, not the
  Public view's filter. No writers, no shell, no jobs, no sessions. What
  the tool returns is what the publisher sells; it sees the graph so that
  the graph need not be public. A throw voids the debit. A result over
  5 MB is an error, as on the app door. Not kept as a run; the ledger
  entry is its record.

## 7. Cost: the meter and the brake

"Exactly how much was spent" has two answers, and they are different
systems.

- **The meter is strut's run log.** Each `step.end` carries what its model
  calls cost (`withUsage`, lifted by the runner), and `RunSummary.totals`
  is their sum: durable, per run, what the run overview already shows. The
  ledger's `cost_usd` is this number.
- **The gateway is the brake.** As read in `stakgraph/gateway`: the cap is
  checked before each call against spend so far (`CheckCaps`), so a run
  overshoots by at most one call per concurrent agent; the counter is
  written after the call and a failed write is dropped; counters expire
  after idle days and are keyed by the bare run id; reading one back needs
  the gateway's admin token. Good for stopping a run, wrong for billing
  one.
- **Spend that is not a model call** (a paid API a step calls) counts only
  when the step marks its output with `withUsage`. The `Workflow Builder`
  page says so for a step that will be sold.

**The run's cap.** The gateway enforces it; strut adds no spend
enforcement of its own (decision 17: a seller runs behind the gateway).

- A public run's cap is the smaller of the workflow's `maxRunCostUsd` and
  what is left of the item's `dailyCapUsd`.
- It rides on the launch (`RunOptions.maxCostUsd`) to `llmAuth`
  (`LlmAuthContext`). Today the Mothership reads only the workflow's own
  cap (`resolveRunCap`, `src/mothership.ts:193`); with this the run's link
  carries the smaller number, and the gateway refuses the call that would
  start past it. That is the one change to the cost path.
- A run can pass its cap by at most one call per concurrent agent, the
  gateway's own behaviour. A price leaves room for it.
- On a strut with no Mothership (a developer's checkout) a run's cap is
  not enforced, as for any run there today. The dialog says so beside the
  toggle; it does not refuse. The daily cap still holds, since it is
  checked at the launch.

**The daily cap.** A launch is refused when today's `daily.cost_usd` for
the item, plus the cap of each of its runs in flight, reaches
`dailyCapUsd`. Counting runs in flight at their cap is conservative, and
it is what keeps twenty launches in one second inside the cap.

## 8. Earnings

Four numbers, all shown:

- **Received:** sats paid in.
- **Earned:** credit that runs and calls have used.
- **Outstanding credit:** received less earned, prepaid and still owed as
  service. Credit that reached its year unused moves to earned.
- **Withdrawn:** sats sent out of the wallet through strut.

| Level | Where | Shows |
|---|---|---|
| Run | The run overview, beside Cost | Sats debited, model cost |
| Workflow or tool | Its row in the Public view tab; the Workflow flyout | Price, calls, failed, earned, cost |
| Package | Its page in the Packages tab | The same, summed over its prefix, on this server |
| Server | A third tab in the Publish dialog, **Earnings** | The wallet's balance with **Withdraw** beside it, received, earned, outstanding, withdrawn, by day and by item |

- `GET /earnings?from=&to=&by=item|day|package` and `GET
  /earnings/entries`, full scope. `earnings/read`, a read step, for Jamie
  ("what did we earn this week?"); under `ctx.app` only a first-party
  page's.
- Sats and dollars sit side by side. v1 converts neither: a margin is a
  rate, and the rate arrives with metering (§12).
- **A package's number is this server's.** A copy installed elsewhere
  earns for that server. Nothing flows back to its publisher, as the
  no-DRM ruling has it (`marketplace.md` §6).

**Withdraw** (decision 19). A button beside the wallet's balance in the
Earnings tab.

- The dialog takes a BOLT11 invoice, shows the amount it asks for, and
  asks before paying. `POST /earnings/withdraw { invoice, msat }` pays it
  through the payer (§9). `msat` is what the person confirmed; an invoice
  for any other amount is refused, so what was shown is what is paid. The
  answer is the payment's state and its fee, or the wallet's refusal as it
  came.
- **Full scope only:** the key or an admin's session. The gate already
  refuses a member's session, a person token and a peer; no step, builder
  tool or app page reaches it.
- **In the books.** Each one is a `withdrawal` entry: who, the amount, the
  fee, the payment hash. Received less withdrawn is what the wallet should
  hold, which the reconcile checks.
- **Not limited to what is earned.** The sats are the seller's when they
  arrive; what a buyer is owed is service. The dialog shows the
  outstanding credit beside the balance.
- **Disabled, saying why,** when the wallet cannot pay (no pay
  credential, §9).
- Later: paying a Lightning address, and a sweep on a schedule.

## 9. The wallet

`ctx.services.lightning`, the receive half of `app-payments.md` §6, built
here first:

```ts
interface LightningCapability {
  makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<{ invoice: string; payment_hash: string; expires: string }>;
  lookup(payment_hash: string): Promise<{ state: "pending" | "settled" | "expired"; msat?: number; settled_at?: string; preimage?: string }>;
  received(o: { since?: string; limit?: number }): Promise<Array<{ payment_hash: string; msat: number; at: string }>>;
  balance(): Promise<{ msat: number }>;
}
```

Nothing on it moves a sat out. The steps an app may grant
(`lightning/invoice`, `lightning/verify`, `lightning/received`) stay
`app-payments.md`'s item, over this capability.

- **`SphinxDaemonProvider`** (the daemon's URL and its receive token).
  First.
- **`NwcProvider`** (a connection URL). Second: a seller with Alby Hub,
  LNbits or any NWC wallet.
- A fake, for tests: invoices it settles on command.

**Where the sats are.** In the wallet: with the daemon, the treasury
account's balance on the Sphinx mixer (custodial); with NWC, the connected
wallet. Strut keeps the books. Getting them out is the Withdraw button
(§8), or the wallet's own UI.

**Where the wallet's credentials live** (decision 20). In `payments.json`,
the encrypted file that holds `L402_ROOT`, and never in the secret store.
A step reads every deployment secret by name (`ctx.services.secrets`), and
a credential that can pay must be readable by nothing, the rule a peer's
token follows (`peers.json`). They are set two ways:

- from the environment at boot: `LIGHTNING_DAEMON_URL`,
  `LIGHTNING_DAEMON_TOKEN`, `LIGHTNING_DAEMON_PAY_TOKEN`, or
  `LIGHTNING_NWC_URL`, `LIGHTNING_NWC_PAY_URL` (the env scrub keeps them
  from steps);
- in the Earnings tab's Wallet form: `PUT /earnings/wallet`, full scope.
  `GET` answers which provider is set and whether it can pay, never a
  credential.

`app-payments.md` §6 put the NWC URL in the secret store. A receive-only
connection is harmless there; one file for both is simpler, and is what a
pay credential needs.

**The payer.** Paying is not on the capability. createStrut holds one
payer, built from the PAY credential when there is one, and exactly two
doors call it: `POST /earnings/withdraw` (§8) and an accepted
`remote/buy-credit` proposal (§10). With no pay credential both say so,
and nothing else changes: a server can sell without being able to pay.

**The treasury daemon** (decisions 9 and 10; work in the sphinx repo, not
this one). A second container of `ghcr.io/stakwork/sphinx-daemon` with its
own seed and `DAEMON_REPLY=none`, in no tribe. What it needs, as read in
`wasm/daemon/src/http.ts` and the core:

1. `POST /invoice` takes `description` and `expiry`, and answers
   `payment_hash` and `expires_at` beside `invoice`. Today it answers
   `{ invoice, sats }`.
2. `GET /invoice/:payment_hash`: `pending`, `settled` or `expired`, the
   amount settled, when, and the preimage. The session already emits
   `settled`; the daemon does not listen to it. `wasm/bot` has
   `check_invoice` on the same core.
3. `GET /payments?since=`: what came in, for the reconcile.
4. The core refuses a payment that carries less than its invoice.
5. Two scoped tokens beside the admin token: a RECEIVE token (invoices,
   lookups, the payments list, the balance) and a PAY token (those and
   `POST /pay`). Strut never holds the admin token, so it cannot post or
   join as the account.
6. `POST /pay { invoice, max_fee_msat? }`, with the pay token, answering
   `{ payment_hash, state, fee_msat, preimage? }`: withdrawals (§8) and a
   buyer's side (§10).

Facts that hold as they are: its invoices are ordinary BOLT11 with a route
hint through the LSP, payable from any wallet; the account must answer
within about four seconds of a payment arriving, so the daemon is always
on; an invoice lasts an hour.

## 10. Buyers

- **Any L402 client.** The 402, the invoice, the retry, the run token.
  Nothing strut-specific.
- **An agent over MCP.** `POST /public/mcp` (`src/createStrut.ts:7896`)
  gains `list_public` (with prices and inputs), `run_workflow`,
  `call_tool`, `get_run` and `get_credit`. An unpaid call's RESULT is `{
  payment_required: { macaroon, invoice, sats, description, expires } }`;
  the agent pays with whatever wallet it has and calls again with
  `payment: "<macaroon>:<preimage>"`. The connection's own `Authorization:
  L402` header works too. `GET /llms.txt` lists what can be run and its
  price.
- **The store.** `GET /public` carries `runnable`, the index's live crawl
  reads it, and a live item's page shows the price and a **Run** form
  drawn from its input. Paying shows a QR code and polls `claim`.
- **Another strut** (the CVE case: an hourly automation).
  - `remote/list { url }`, `remote/run-workflow`, `remote/call`: steps
    that call a stranger's public door, with no peer record. They present
    the credit this strut holds for that origin, kept in an encrypted file,
    `entitlements.json` (the file `marketplace.md` §6 reserves).
  - With no credit, or too little, the step fails saying what the seller
    asks. It never pays.
  - `remote/buy-credit { url, sats }` runs only as a proposal a person
    accepted, and that person an admin (`approver: "admin"`, as
    `package/install`). Its card reads the seller's `/public`: who, what
    it sells, the price. On accept strut pays through the payer (§9),
    which is not on the services bag, and keeps the token.
  - After that, agents and automations spend within the credit with no
    ask (decision 16).
- **A visitor's app page.** `run/launch` on a runnable workflow the app
  grants stops being refused for a visitor. The HOST pays and holds the
  credit token (strut's UI, Peel), never the frame: a model-written page
  must not hold a bearer token that is money. The page sees a launch that
  took a moment longer.

## 11. What a host does

Outside this repo; nothing here waits on it.

- **A Stadeum box:** a `treasury` daemon in its stack, the two settings
  above on strut, and a Mothership delegation for one service principal
  (say `public-runs`) passed as `publicRuns.principal`, so strangers' runs
  do not draw on a person's spending limit. That principal's gateway
  budget is then a second daily cap. Its Spending page can show earnings
  beside spend from `GET /earnings`.
- **A swarm:** the same daemon beside mcp; the host gate already passes
  `/public` by path.
- **A laptop:** nothing reaches it, so it sells nothing. It buys.

## 12. Not in v1

- **Metered pricing.** `meter: { markup, hold }` in place of a price: a
  launch holds credit, the run's cap is the hold, and the end debits the
  run's cost times the markup. It needs `hold` / `release` entries, a
  sats-per-dollar rate fixed on the token at purchase, and carry-over (a
  new token inherits the balance of the one presented when it was asked
  for, by a `strut_carry` caveat).
- **A total budget on a narrowed token** (`strut_budget_sats`): one more
  table, keyed by signature.
- **The buyer pays the model.** A presented Mothership macaroon on the
  launch (`presented-delegations.md`), so the seller charges only for what
  is its own.
- **Paying for a package.** The same token, debited on the archive route
  with a `package:` subject (`marketplace.md`, open question 3).
- **Other envelopes.** x402 and MPP are another header on the same 402.
- **Jobs and threads for a buyer:** a paid conversation that continues
  across runs.
- Hold invoices, sats sent back, BOLT12, callbacks to a stranger's URL,
  attachments on a public launch, several accounts in one daemon, a
  royalty from an installed copy's runs.

## Work items

Strut only, each a PR. Free runs ship with no Lightning.

1. **The ledger.** `LedgerStore` on `node:sqlite` and in memory; the
   conformance suite; `engines >= 22.13`.
2. **The record and the dialog.** `runnable` in `public.json`, its checks,
   `GET /public`, the row control with its cascade.
3. **Free public runs.** The launch route, `origin: "public"`,
   `bindPublic`, the run token, the launcher's reads, cancel, the daily
   cap, and the run's cap handed to `llmAuth` (§7). This is
   `public-surface.md` §11.
4. **The wallet.** `ctx.services.lightning`, the daemon provider, the
   fake, its settings in `payments.json`; then NWC.
5. **Paid workflows.** `src/l402.ts`, `payments.json`, the challenge, the
   check, `claim`, the credit routes, debit and void.
6. **Paid tools.** `POST /public/steps/:type/run` and its bag.
7. **Earnings.** The routes, the step, the four places they show; the
   payer, `POST /earnings/withdraw` and the Withdraw button.
8. **Agents and the store.** The `/public/mcp` tools, `llms.txt`, prices
   in the index's live items, the store's Run form.
9. **A strut that buys.** `remote/*`, `entitlements.json`, the buy-credit
   proposal, the payer.
10. **A visitor's app page.** The host pays.
11. **Metering.** §12's first item.

## Validation

- A workflow added as free with a $5 daily cap: an anonymous `POST` runs
  it; its run reads back with the run token and with nothing else; the
  private run routes refuse the token; the launch after the cap is spent
  is 429.
- A body carrying `params` is 400. A sealed workflow cannot be saved as
  runnable. A workflow with no `input:` cannot.
- A paid workflow: the first call is 402 with a macaroon and an invoice;
  paying the fake wallet and retrying is 202; the same token again is 402
  once its credit is spent; a second token never spends the first's.
- A token whose invoice settled for less than its price is credited what
  was settled and answers 402 for the rest.
- The same `key` twice debits once and returns one run.
- A paid run that ends in error is credited back; one the launcher
  cancelled is not.
- A macaroon with an appended `strut_capabilities` runs only those items;
  one with a caveat strut does not know is refused; a forged signature is
  refused.
- `claim` answers `pending` until the fake wallet settles, then the
  preimage, which then works as a credential.
- A public run's Mothership link carries the smaller of the workflow's cap
  and what is left of the daily cap, checked with gatekey's own verifier
  as `src/mothership.test.ts` does; through the compose gateway
  (`npm run test:gateway`) a run past that cap is refused by the gateway.
- Twenty launches at once against a cap that fits three: three run.
- A tool call cannot write the graph, start a job or open a session, and
  reads a node the Public view does not show.
- Earnings by item, package and day equal the sums of the entries; a
  million entries leave the Earnings tab's reads under a few
  milliseconds.
- A restart loses no credit; a copy of the data folder with
  `payments.json` and `ledger.db` honors every token.
- A token past its year is refused, and its unused credit shows as earned.
- Withdraw: an admin's session pays an invoice and the ledger gains a
  `withdrawal`; a member's session is refused; an invoice whose amount is
  not the one confirmed is refused; with no pay credential the button is
  disabled and the route says why.
- No step reads a wallet credential: `secrets.get` of each `LIGHTNING_*`
  name answers nothing, and nothing on the services bag pays.
- Live, with real sats: a treasury daemon, one paid run from Peel, one
  from a wallet that is not Sphinx.

## Open questions

1. **How long credit lasts.** *Answered (ruled): a year* (decision 18).
2. **Crediting back a failed run.** Decision 14 trusts the daily cap to
   bound abuse. The alternative is a per-item choice, credit back or keep.
3. **The rate** metering needs: a setting the operator keeps, or a price
   feed read through `ctx.services.http`.
4. **Withdrawals.** *Answered (ruled): a button in the Earnings tab*
   (decision 19, §8). Still open: paying a Lightning address, and whether
   a sweep on a schedule belongs in strut or in the daemon.
5. **The desktop package.** Whether its Node has `node:sqlite` without a
   flag. A laptop only buys, so the ledger could simply be absent there.
6. **Showing "ran and paid" in public.** A count of paid runs per item on
   `/public` is a trust signal that is costly to fake
   (`p2p-distribution-research.md`); it also tells competitors a
   publisher's volume.
7. **Where a visitor's credit lives between visits:** the host page's
   storage, per origin, or nowhere (a visit's worth).
