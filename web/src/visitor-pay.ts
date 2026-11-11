// ── A visitor's page, paid for by its HOST (plans/paid-runs.md §10) ─────────
//
// A public app's page (`?app=<name>&solo=1&public=1`) may launch a workflow
// it grants that a person made runnable. A free one just launches. A
// priced one with no credit answers the page's `tools/call` with `{
// payment_required: { macaroon, invoice, usd, sats, … } }`, and the HOST —
// this page, never the frame — pays it: a sheet with the invoice, `POST
// /public/credit/claim` with the macaroon until it settles (§4.4), the
// credential kept by the host, and the page's ORIGINAL call sent
// again with it as the request's `Authorization: L402 <macaroon>:<preimage>`.
// The page sees a launch that took a moment longer; a model-written page
// never holds a bearer token that is money (§10). Later launches reuse the
// credential until it runs short; the next 402's macaroon carries what is
// left over (§4.5), so paying it again replaces the credential.
//
// The host also names the VISIT (`x-strut-visit`, a random secret minted
// once per tab): the runs launched under it are the ones the page reads
// back (src/public-surface.ts `visitorRuns`).
//
// What the host holds — the visit, the credential, credentials paid for and
// not yet sent, and every invoice it showed until that invoice ends — lives
// in the host page's `sessionStorage` (strut's origin, never a frame's), so
// a reload in the tab keeps the visit's runs readable and its credit
// spendable. An invoice is claimed until it settles or ends whether or not
// its sheet is still open (`createClaimKeeper`): a phone that pays after the
// visitor pressed Cancel still buys credit, which the next launch spends.
//
// Pure, with no import from web/node_modules, so the root test run covers
// it (visitor-pay.test.ts); ./app-host wires it to the bridge.

/** The header a visitor's host names its visit with (src/public-surface.ts). */
export const VISIT_HEADER = "x-strut-visit";

/** A priced launch's answer (src/public-surface.ts `visitorLaunchResult`;
 *  the kit's `PaymentRequired`). */
export interface PaymentRequired {
  macaroon: string;
  invoice: string;
  usd: number;
  sats: number;
  rate?: { usdPerBtc: number; at: string; source: string };
  description?: string;
  expires?: string;
  /** What the presented credit still held, when it ran short. */
  remaining_usd?: number;
  /** Why a token was not enough: `short`, `expired`, `replaced`. */
  reason?: string;
  /** The new macaroon inherits the presented token's free credit (§4.5):
   *  once paid it REPLACES that credential. */
  carries?: boolean;
}

/** MCP's `tools/call` params and result, the parts read here. */
export interface CallParams {
  name: string;
  arguments?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface CallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/** A visit's secret: 32 characters of base64url from 24 random bytes. */
export function newVisit(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The page's call, when it is a launch: `step_run` of `run/launch`, with
 *  the workflow it names. */
export function launchOf(params: CallParams): { workflow: string } | undefined {
  const args = params.arguments;
  if (params.name !== "step_run" || !args || args["type"] !== "run/launch") return undefined;
  const config = args["config"] as Record<string, unknown> | undefined;
  return { workflow: typeof config?.["workflow"] === "string" ? config["workflow"] : "" };
}

/** The tool result's output: `structuredContent`, else its text as JSON. */
function outputOf(result: CallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The `payment_required` a launch answered with, else undefined. */
export function paymentRequiredIn(result: CallResult): PaymentRequired | undefined {
  if (result.isError) return undefined;
  const p = (outputOf(result) as { payment_required?: unknown } | undefined)?.payment_required as PaymentRequired | undefined;
  return p && typeof p === "object" && typeof p.macaroon === "string" && typeof p.invoice === "string" ? p : undefined;
}

/** A failed call that is the DOOR refusing the credential itself (the
 *  server does not know it, or it no longer verifies — a 401 before anything
 *  ran): drop it and ask again without. Only the door's own refusal: a
 *  result that says its code and status is read by them (`code:
 *  "invalid_token"`, `status: 401`), else its error must BEGIN with
 *  `invalid_token:`, as the launcher's refusal does. A step's own failure
 *  that merely mentions the words (an OAuth error, charged) never drops the
 *  credential, and is never sent again. */
export function refusesCredential(result: CallResult): boolean {
  if (!result.isError) return false;
  const s = result.structuredContent as { code?: unknown; status?: unknown } | undefined;
  if (s && typeof s === "object" && ("code" in s || "status" in s)) return s.code === "invalid_token" && s.status === 401;
  const text = result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text ?? "";
  let error = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") error = parsed.error;
  } catch {
    // Plain text.
  }
  return /^invalid_token:/.test(error.trim());
}

/** The answer a page gets when its visitor closed the sheet: a plain error. */
export function cancelledResult(workflow: string): CallResult {
  const error = `payment_cancelled: the run of ${workflow || "this workflow"} was not paid for, so it did not start`;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** What the host holds for a visit, kept in the host page's
 *  `sessionStorage` so a reload in the tab keeps it. */
export interface VisitorPurse {
  visit: string;
  /** `<macaroon>:<preimage>`, sent as `Authorization: L402 …`. */
  credential?: string;
  /** Credentials paid for and not sent yet — an invoice paid after its
   *  sheet was closed — tried before the visitor is asked again. */
  spare: string[];
  /** Every invoice the host showed and has not seen settle: claimed until it
   *  ends (`createClaimKeeper`). */
  pending: PendingClaim[];
}

/** An invoice the host showed: its macaroon, when it ends, and the
 *  credential it was minted to inherit from (`carries`), which it replaces. */
export interface PendingClaim {
  macaroon: string;
  expires?: string;
  carriesFrom?: string;
}

export function newPurse(visit: string = newVisit()): VisitorPurse {
  return { visit, spare: [], pending: [] };
}

const VISIT_SHAPE = /^[A-Za-z0-9_-]{22,128}$/;

/** The purse `storage` keeps under `key`, or a new one. Anything that is not
 *  a purse — or a storage that throws (a private window) — is a new one. */
export function loadPurse(storage: Pick<Storage, "getItem"> | undefined, key: string): VisitorPurse {
  try {
    const raw = storage?.getItem(key);
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    if (v && typeof v["visit"] === "string" && VISIT_SHAPE.test(v["visit"])) {
      const strings = (x: unknown) => (Array.isArray(x) ? x.filter((c): c is string => typeof c === "string") : []);
      const pending = Array.isArray(v["pending"])
        ? (v["pending"] as unknown[]).filter((e): e is PendingClaim => !!e && typeof (e as PendingClaim).macaroon === "string")
        : [];
      return { visit: v["visit"], ...(typeof v["credential"] === "string" ? { credential: v["credential"] } : {}), spare: strings(v["spare"]), pending };
    }
  } catch {
    // Unreadable: a new visit.
  }
  return newPurse();
}

/** Keep the purse for a reload in this tab; a storage that throws keeps it
 *  in memory alone. */
export function savePurse(storage: Pick<Storage, "setItem"> | undefined, key: string, purse: VisitorPurse): void {
  try {
    storage?.setItem(key, JSON.stringify(purse));
  } catch {
    // Full or refused: the page load still holds it.
  }
}

/** The headers every `/public/mcp` request of the visit carries. */
export function visitorHeaders(purse: VisitorPurse): Record<string, string> {
  return { [VISIT_HEADER]: purse.visit, ...(purse.credential ? { authorization: `L402 ${purse.credential}` } : {}) };
}

/** An invoice the visitor paid, into the purse: the credential to send when
 *  there is none, or when it was minted to carry from the one sent (§4.5:
 *  its first use moved that one's credit to it); else a spare. */
export function creditSettled(purse: VisitorPurse, entry: PendingClaim, credential: string): void {
  purse.pending = purse.pending.filter((e) => e.macaroon !== entry.macaroon);
  if (purse.credential === credential || purse.spare.includes(credential)) return;
  if (!purse.credential || (entry.carriesFrom !== undefined && entry.carriesFrom === purse.credential)) purse.credential = credential;
  else purse.spare.push(credential);
}

/** What the payer decided: the credential (paid), `again` (send the call
 *  again: the invoice expired, or credit arrived meanwhile), null (the
 *  visitor cancelled), or `{ error }` — the host would not pay this one (a
 *  challenge that does not check out, ./challenge), which the page gets as
 *  its call's error. */
export type PayOutcome = string | "again" | null | { error: string };

/** The answer a page gets when its host refused to pay: a plain error. */
export function refusedResult(error: string): CallResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** How many answers one call may act on before it gives up: spares tried,
 *  an expired invoice asked for again, a refused credential dropped. A call
 *  PAYS at most once, whatever the server answers after. */
export const PAY_ROUNDS = 6;

/** The server asked for another payment after this call paid one: nothing
 *  more is paid, and what was paid stays as credit. */
export function paidAgainResult(workflow: string): CallResult {
  const error = `payment_required: the server asked to be paid again after this payment, so nothing more was paid — your payment is kept as credit on this server: run ${workflow || "it"} again to spend it`;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** A failed launch after the visitor paid in this call (the server's runs
 *  in flight filled while they paid, the drain, the day's cap): the error,
 *  and that the payment is kept as credit. */
export function keptCreditResult(result: CallResult): CallResult {
  const text = result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text ?? "";
  let error = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") error = parsed.error;
  } catch {
    // Plain text.
  }
  const kept = `${error || "the run did not start"} — your payment is kept as credit on this server: run it again in a moment, and it is spent then`;
  return { ...result, isError: true, content: [{ type: "text", text: JSON.stringify({ error: kept }) }] };
}

/**
 * The page's `tools/call`, paid for when it must: sent as it is; a launch
 * answered `payment_required` first tries a credential paid for earlier and
 * not sent yet (`spare`), else is shown to the visitor (`pay`), and once paid
 * sent again with the credential the purse then holds (`call` reads the purse
 * for its headers). A credential the server refuses is dropped and the call
 * made again without it. A launch that fails after the visitor paid says the
 * payment is kept. Anything that is not a launch passes through untouched.
 */
export async function callPaying(
  params: CallParams,
  deps: {
    call: (params: CallParams) => Promise<CallResult>;
    purse: VisitorPurse;
    pay: (p: PaymentRequired, workflow: string) => Promise<PayOutcome>;
    /** The purse changed: keep it (`savePurse`). */
    save?: () => void;
    /** The call IS a launch of this workflow, whatever its params say: a
     *  caller that launches over plain HTTP (the store's Run form), its
     *  answers read into a CallResult (`httpCallResult`, ./store-run). */
    launch?: { workflow: string };
  },
): Promise<CallResult> {
  const { purse } = deps;
  const save = deps.save ?? (() => {});
  let result = await deps.call(params);
  const launch = deps.launch ?? launchOf(params);
  if (!launch) return result;
  const tried = new Set<string>(purse.credential ? [purse.credential] : []);
  let paid = false;
  const settle = (r: CallResult) => (paid && r.isError && !paymentRequiredIn(r) ? keptCreditResult(r) : r);
  for (let round = 0; round < PAY_ROUNDS; round++) {
    if (purse.credential && refusesCredential(result)) {
      delete purse.credential;
      save();
      result = await deps.call(params);
      continue;
    }
    const p = paymentRequiredIn(result);
    if (!p) return settle(result);
    // Paid once in this call: a server that asks again is never paid again
    // here (a hostile one could ask after every payment).
    if (paid) return paidAgainResult(launch.workflow);
    const spare = purse.spare.find((c) => !tried.has(c));
    if (spare) {
      purse.spare = purse.spare.filter((c) => c !== spare);
      // What is left on a short one stays for later (its remainder), once.
      if (purse.credential && p.reason === "short" && (p.remaining_usd ?? 0) > 0) purse.spare.push(purse.credential);
      purse.credential = spare;
      tried.add(spare);
      save();
      result = await deps.call(params);
      continue;
    }
    const outcome = await deps.pay(p, launch.workflow);
    if (outcome === null) return cancelledResult(launch.workflow);
    if (typeof outcome === "object") return refusedResult(outcome.error);
    if (outcome !== "again") {
      // This call asked for it: it is the one to send now.
      purse.spare = purse.spare.filter((c) => c !== outcome);
      purse.credential = outcome;
      tried.add(outcome);
      paid = true;
      save();
    }
    result = await deps.call(params);
  }
  return settle(result);
}

/** One sheet at a time for a purse: a second priced launch that met a 402
 *  while the visitor was paying for the first waits for that one, and then
 *  — when credit arrived meanwhile — is sent again (`again`) instead of
 *  asking the visitor twice. */
export function payInTurn(purse: VisitorPurse): (pay: (p: PaymentRequired, workflow: string) => Promise<PayOutcome>, p: PaymentRequired, workflow: string) => Promise<PayOutcome> {
  let turn: Promise<unknown> = Promise.resolve();
  return (pay, p, workflow) => {
    const before = purse.credential;
    const spares = purse.spare.length;
    const mine = turn.then(() => (purse.credential !== before || purse.spare.length > spares ? ("again" as const) : pay(p, workflow)));
    turn = mine.catch(() => undefined);
    return mine;
  };
}

/** One answer of `POST /public/credit/claim`, or the refusal it came to. */
export type ClaimAnswer =
  | { state: "pending" }
  | { state: "expired" }
  | { state: "settled"; credential: string }
  | { error: string; retryAfter?: number };

/** Ask `claim` until the invoice settles or expires, every `intervalMs`
 *  (longer when the server says to wait); null when `signal` aborts. */
export async function waitForClaim(
  claim: () => Promise<ClaimAnswer>,
  o: { signal: AbortSignal; intervalMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<{ state: "settled"; credential: string } | { state: "expired" } | null> {
  const sleep = o.sleep ?? ((ms, signal) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }));
  const every = o.intervalMs ?? 2000;
  while (!o.signal.aborted) {
    let wait = every;
    try {
      const a = await claim();
      if (o.signal.aborted) return null;
      if ("state" in a && a.state === "settled") return a;
      if ("state" in a && a.state === "expired") return a;
      if ("error" in a && a.retryAfter) wait = Math.max(every, a.retryAfter * 1000);
    } catch {
      // A dropped request: ask again.
    }
    await sleep(wait, o.signal);
  }
  return null;
}

/** How long past its end an invoice is still asked about once: a payment
 *  made at the last moment settles a little later. */
export const CLAIM_GRACE_MS = 30_000;

/** How an invoice the host showed ended. */
export type ClaimEnd = { state: "settled"; credential: string } | { state: "expired" };

export interface ClaimKeeper {
  /** Claim this invoice until it settles or ends, whether or not a sheet
   *  still shows it; a settled one goes into the purse (`creditSettled`).
   *  The same macaroon twice is one watch. */
  watch(entry: PendingClaim): Promise<ClaimEnd>;
  /** Watch every invoice the purse still holds (after a reload). */
  resume(): void;
}

/** The host's claims, apart from any sheet (§4.4): an invoice shown is
 *  claimed every `intervalMs` until it settles — its credential into the
 *  purse — or it ends. Each change is saved. */
export function createClaimKeeper(o: {
  purse: VisitorPurse;
  claim: (macaroon: string) => Promise<ClaimAnswer>;
  save: () => void;
  now?: () => number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ClaimKeeper {
  const now = o.now ?? Date.now;
  const every = o.intervalMs ?? 3000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const watching = new Map<string, Promise<ClaimEnd>>();
  const over = (e: PendingClaim) => {
    const t = e.expires ? Date.parse(e.expires) : NaN;
    return Number.isFinite(t) && now() > t + CLAIM_GRACE_MS;
  };
  const drop = (e: PendingClaim) => {
    o.purse.pending = o.purse.pending.filter((x) => x.macaroon !== e.macaroon);
    o.save();
  };
  const watch = (entry: PendingClaim): Promise<ClaimEnd> => {
    const known = watching.get(entry.macaroon);
    if (known) return known;
    if (!o.purse.pending.some((e) => e.macaroon === entry.macaroon)) {
      o.purse.pending.push(entry);
      o.save();
    }
    const run = (async (): Promise<ClaimEnd> => {
      for (;;) {
        const last = over(entry);
        let wait = every;
        try {
          const a = await o.claim(entry.macaroon);
          if ("state" in a && a.state === "settled") {
            creditSettled(o.purse, entry, a.credential);
            o.save();
            return a;
          }
          if ("state" in a && a.state === "expired") {
            drop(entry);
            return a;
          }
          if ("error" in a && a.retryAfter) wait = Math.max(every, a.retryAfter * 1000);
        } catch {
          // A dropped request: ask again.
        }
        if (last) {
          drop(entry);
          return { state: "expired" };
        }
        await sleep(wait);
      }
    })();
    watching.set(entry.macaroon, run);
    void run.finally(() => watching.delete(entry.macaroon));
    return run;
  };
  return {
    watch,
    resume() {
      for (const e of [...o.purse.pending]) void watch(e);
    },
  };
}

/** The claim route's answer read: its JSON, and `Retry-After` on a refusal. */
export function claimAnswerOf(status: number, body: unknown, retryAfter: string | null): ClaimAnswer {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200 && (b["state"] === "pending" || b["state"] === "expired")) return { state: b["state"] };
  if (status === 200 && b["state"] === "settled" && typeof b["credential"] === "string") return { state: "settled", credential: b["credential"] };
  const after = retryAfter ? Number(retryAfter) : NaN;
  return { error: typeof b["error"] === "string" ? b["error"] : `claim answered ${status}`, ...(Number.isFinite(after) ? { retryAfter: after } : {}) };
}

/** Dollars as a person reads them: cents, or more places under a cent;
 *  thousands separated. `whole` leaves the cents off (a bitcoin's price). */
export function formatUsd(usd: number, o: { whole?: boolean } = {}): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, "")}`;
  const digits = o.whole ? 0 : 2;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** What the sheet says about the credit the visitor already has: what a
 *  run does not use stays, and, when the credit ran short, that this tops
 *  it up. */
export function creditLine(p: Pick<PaymentRequired, "reason" | "remaining_usd">): string {
  if (p.reason === "short" && (p.remaining_usd ?? 0) > 0) {
    return `Your credit has ${formatUsd(p.remaining_usd!)} left; this tops it up, and what a run does not use stays yours for later runs here.`;
  }
  if (p.reason === "short") return "Your credit here is spent; this buys more, and what a run does not use stays yours for later runs here.";
  return "What the run does not use stays as credit for later runs here, in this tab, even after a reload.";
}

/** A rate this host trusts — its own strut's (`GET /rate`), never the
 *  seller's quote: what a stranger's invoice is priced at in dollars. */
export interface TrustedRate {
  usdPerBtc: number;
  source: string;
}

/** What the sheet says a payment costs: the SATS the invoice asks are the
 *  price (./challenge held them equal to the invoice); dollars only at a
 *  rate this host trusts; the server's own dollar figure only as the CREDIT
 *  it says the payment buys — and a warning when that credit is worth less
 *  than nine tenths of what is paid, at the trusted rate. */
export interface PriceView {
  sats: string;
  usd?: string;
  credit: string;
  warning?: string;
}

export function priceView(p: Pick<PaymentRequired, "sats" | "usd">, rate: TrustedRate | null | undefined, seller?: string): PriceView {
  const worth = rate && rate.usdPerBtc > 0 ? (p.sats / 1e8) * rate.usdPerBtc : undefined;
  const credit = `Buys ${formatUsd(p.usd)} of credit${seller ? ` on ${seller}` : ""}, by the server's own figure.`;
  return {
    sats: formatSats(p.sats),
    ...(worth !== undefined ? { usd: `≈ ${formatUsd(worth)} at ${rate!.source}` } : {}),
    credit,
    ...(worth !== undefined && worth > 0 && p.usd < worth * 0.9
      ? { warning: `The server credits ${formatUsd(p.usd)} for a payment worth ${formatUsd(worth)} at ${rate!.source}'s rate.` }
      : {}),
  };
}

/** Sats with thousands separated. */
export function formatSats(sats: number): string {
  return `${Math.round(sats).toLocaleString("en-US")} sats`;
}

/** What a wallet's camera reads: BOLT11 upper-cased under the `lightning:`
 *  scheme, which a QR code holds in its denser alphanumeric mode. */
export function invoiceQrText(invoice: string): string {
  return `LIGHTNING:${invoice.toUpperCase()}`;
}

/** Whole seconds until `expires`, never below 0; undefined with none. */
export function secondsLeft(expires: string | undefined, now = Date.now()): number | undefined {
  if (!expires) return undefined;
  const t = Date.parse(expires);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : undefined;
}
