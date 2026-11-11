// ── A visitor's page, paid for by its HOST (plans/paid-runs.md §10) ─────────
//
// A public app's page (`?app=<name>&solo=1&public=1`) may launch a workflow
// it grants that a person made runnable. A free one just launches. A
// priced one with no credit answers the page's `tools/call` with `{
// payment_required: { macaroon, invoice, usd, sats, … } }`, and the HOST —
// this page, never the frame — pays it: a sheet with the invoice, `POST
// /public/credit/claim` with the macaroon until it settles (§4.4), the
// credential kept in this page's memory, and the page's ORIGINAL call sent
// again with it as the request's `Authorization: L402 <macaroon>:<preimage>`.
// The page sees a launch that took a moment longer; a model-written page
// never holds a bearer token that is money (§10). Later launches reuse the
// credential until it runs short; the next 402's macaroon carries what is
// left over (§4.5), so paying it again replaces the credential.
//
// The host also names the VISIT (`x-strut-visit`, a random secret minted
// once per page load): the runs launched under it are the ones the page
// reads back (src/public-surface.ts `visitorRuns`).
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

/** A failed call that refused the CREDENTIAL itself (the server does not
 *  know it, or it no longer verifies): drop it and ask again without. */
export function refusesCredential(result: CallResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.map((c) => (typeof c.text === "string" ? c.text : "")).join(" ") ?? "";
  return text.includes("invalid_token");
}

/** The answer a page gets when its visitor closed the sheet: a plain error. */
export function cancelledResult(workflow: string): CallResult {
  const error = `payment_cancelled: the run of ${workflow || "this workflow"} was not paid for, so it did not start`;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** What the host holds for a page load: the visit and, once paid, the
 *  credential — in memory only. */
export interface VisitorPurse {
  visit: string;
  /** `<macaroon>:<preimage>`, sent as `Authorization: L402 …`. */
  credential?: string;
}

/** The headers every `/public/mcp` request of the visit carries. */
export function visitorHeaders(purse: VisitorPurse): Record<string, string> {
  return { [VISIT_HEADER]: purse.visit, ...(purse.credential ? { authorization: `L402 ${purse.credential}` } : {}) };
}

/** What the payer decided: the credential (paid), `again` (the invoice
 *  expired: ask for a new one), or null (the visitor cancelled). */
export type PayOutcome = string | "again" | null;

/** How many 402s one call may meet before it gives up: a top-up that is
 *  short again, an expired invoice asked for again. */
export const PAY_ROUNDS = 4;

/**
 * The page's `tools/call`, paid for when it must: sent as it is; a launch
 * answered `payment_required` is shown to the visitor (`pay`), and once
 * paid sent again with the credential the purse now holds (`call` reads the
 * purse for its headers). A credential the server refuses is dropped and
 * the call made again without it. Anything that is not a launch passes
 * through untouched.
 */
export async function callPaying(
  params: CallParams,
  deps: {
    call: (params: CallParams) => Promise<CallResult>;
    purse: VisitorPurse;
    pay: (p: PaymentRequired, workflow: string) => Promise<PayOutcome>;
  },
): Promise<CallResult> {
  let result = await deps.call(params);
  const launch = launchOf(params);
  if (!launch) return result;
  for (let round = 0; round < PAY_ROUNDS; round++) {
    if (deps.purse.credential && refusesCredential(result)) {
      delete deps.purse.credential;
      result = await deps.call(params);
      continue;
    }
    const p = paymentRequiredIn(result);
    if (!p) return result;
    const paid = await deps.pay(p, launch.workflow);
    if (paid === null) return cancelledResult(launch.workflow);
    if (paid !== "again") deps.purse.credential = paid;
    result = await deps.call(params);
  }
  return result;
}

/** One sheet at a time for a page load's purse: a second priced launch
 *  that met a 402 while the visitor was paying for the first waits for that
 *  one, and then — when a credential was bought meanwhile — is sent again
 *  with it (`again`) instead of asking the visitor twice. */
export function payInTurn(purse: VisitorPurse): (pay: (p: PaymentRequired, workflow: string) => Promise<PayOutcome>, p: PaymentRequired, workflow: string) => Promise<PayOutcome> {
  let turn: Promise<unknown> = Promise.resolve();
  return (pay, p, workflow) => {
    const before = purse.credential;
    const mine = turn.then(() => (purse.credential !== before ? ("again" as const) : pay(p, workflow)));
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
  return "What the run does not use stays as credit for later runs here, while this page is open.";
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
