/**
 * EARNINGS' HTTP door (plans/paid-runs.md §8): what the Earnings tab, the
 * Public view's runnable rows, the Workflow flyout, a package's page and the
 * run overview read, and Withdraw. FULL SCOPE only — the deployment key or
 * an admin's session: the gate refuses a member's session every route and a
 * peer or a person token every write; these refuse a peer's read too.
 *
 * - `GET /earnings?from=&to=&by=item|day|package|total&prefix=&wallet=1`:
 *   earned, cost, margin, calls, failed, outstanding, received, withdrawn and
 *   the withdrawals still out (earnings.ts), from the ledger's rollups;
 *   `wallet=1` adds the wallet's balance beside what the books say it holds.
 * - `GET /earnings/entries?kind=&runId=&token=&before=&limit=`: the ledger's
 *   entries newest first — of one kind, one run (the run overview's
 *   "Charged"), or one credit token (with its balance).
 * - `POST /earnings/withdraw { invoice, msat, maxFeeMsat? }`: pay a BOLT11
 *   invoice out of the wallet through the payer (withdrawals.ts). `msat` is
 *   what the person confirmed. The answer is the payment's state and fee, or
 *   the wallet's refusal as it came (`{ error, code, walletCode? }`).
 * - `POST /earnings/withdrawals/:paymentHash/read`: read one that is still
 *   out, now, by its payment hash, through the payer it went out through.
 * - `POST /earnings/withdrawals/:paymentHash/resolve { action: "paid" |
 *   "drop", feeMsat? }`: a person settles one by hand — a stale one the
 *   wallet will never answer for (the Sphinx mixer keeps a debit it never
 *   resolves), or one that went through a wallet no longer set.
 */

import type { Context, Hono } from "hono";
import { checkEarningsQuery, readEarnings, type EarningsDeps } from "./earnings.js";
import { microsToUsd, type EntryKind, type LedgerEntry, type LedgerStore } from "./ledger.js";
import { WithdrawError, type Withdrawals } from "./withdrawals.js";

const KINDS: readonly EntryKind[] = ["payment", "hold", "charge", "carry", "expiry", "withdrawal"];

export interface EarningsRoutesDeps {
  isFull: (c: Context) => Promise<boolean>;
  /** Who asked: a withdrawal's `actor`. */
  actorOf: (c: Context) => Promise<string | undefined>;
  earnings: EarningsDeps;
  /** The ledger to read, or null when none was ever opened. */
  ledger: () => Promise<LedgerStore | null>;
  withdrawals: Withdrawals;
}

/** An entry as the routes answer it: dollars, not micro-dollars. */
export function entryView(e: LedgerEntry): Record<string, unknown> {
  const { usd, cost, ...rest } = e;
  return { ...rest, ...(usd !== undefined ? { usd: microsToUsd(usd) } : {}), ...(cost !== undefined ? { cost: microsToUsd(cost) } : {}) };
}

export function earningsRoutes(app: Hono, deps: EarningsRoutesDeps): void {
  const refuse = async (c: Context) =>
    (await deps.isFull(c)) ? null : c.json({ error: "forbidden: earnings are an admin's: the deployment key or an admin's session" }, 403);

  app.get("/earnings", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    let q;
    try {
      q = checkEarningsQuery(c.req.query());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(await readEarnings(deps.earnings, q));
  });

  app.get("/earnings/entries", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const kind = c.req.query("kind") || undefined;
    if (kind && !KINDS.includes(kind as EntryKind)) return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
    const num = (k: string) => {
      const v = c.req.query(k);
      return v === undefined || v === "" ? undefined : Number(v);
    };
    const before = num("before");
    const limit = num("limit");
    for (const [k, v] of [["before", before], ["limit", limit]] as const) {
      if (v !== undefined && (!Number.isSafeInteger(v) || v <= 0)) return c.json({ error: `${k} must be a whole number above 0` }, 400);
    }
    const runId = c.req.query("runId") || undefined;
    const token = c.req.query("token") || undefined;
    const ledger = await deps.ledger();
    if (!ledger) return c.json({ entries: [], ...(token ? { token: null } : {}) });
    if (token) {
      const [balance, entries] = await Promise.all([ledger.token(token), ledger.entries(token, { ...(before ? { before } : {}), ...(limit ? { limit } : {}) })]);
      if (!balance) return c.json({ error: `no credit token ${token}` }, 404);
      const usd = (m: number) => microsToUsd(m);
      return c.json({
        token: { ...balance, paid: usd(balance.paid), spent: usd(balance.spent), held: usd(balance.held), free: usd(balance.free) },
        entries: entries.filter((e) => !kind || e.kind === kind).map(entryView),
      });
    }
    const entries = await ledger.list({ ...(kind ? { kind: kind as EntryKind } : {}), ...(runId ? { runId } : {}), ...(before ? { before } : {}), ...(limit ? { limit } : {}) });
    return c.json({ entries: entries.map(entryView) });
  });

  const refusal = (c: Context, err: unknown) => {
    if (err instanceof WithdrawError) return c.json({ error: err.message, code: err.code, ...(err.walletCode ? { walletCode: err.walletCode } : {}) }, err.status);
    throw err;
  };
  const answerOf = (a: Awaited<ReturnType<Withdrawals["withdraw"]>>) => {
    const { entry, ...rest } = a;
    return { ...rest, ...(entry ? { entry: entryView(entry) } : {}) };
  };
  const HASH = /^[0-9a-fA-F]{64}$/;

  app.post("/earnings/withdrawals/:paymentHash/read", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const hash = c.req.param("paymentHash");
    if (!HASH.test(hash)) return c.json({ error: "paymentHash is 64 hex characters", code: "bad_request" }, 400);
    try {
      return c.json(answerOf(await deps.withdrawals.read(hash)));
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/earnings/withdrawals/:paymentHash/resolve", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const hash = c.req.param("paymentHash");
    if (!HASH.test(hash)) return c.json({ error: "paymentHash is 64 hex characters", code: "bad_request" }, 400);
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const action = body?.["action"];
    if (action !== "paid" && action !== "drop") return c.json({ error: 'action is "paid" (record it in the books) or "drop" (forget it)', code: "bad_request" }, 400);
    if (body?.["feeMsat"] !== undefined && (action !== "paid" || typeof body["feeMsat"] !== "number")) return c.json({ error: "feeMsat is a number of msat, with action paid", code: "bad_request" }, 400);
    const actor = await deps.actorOf(c);
    try {
      const r = await deps.withdrawals.resolve(hash, { action, ...(body?.["feeMsat"] !== undefined ? { feeMsat: body["feeMsat"] as number } : {}), ...(actor ? { actor } : {}) });
      return c.json({ action: r.action, ...(r.entry ? { entry: entryView(r.entry) } : {}) });
    } catch (err) {
      return refusal(c, err);
    }
  });

  app.post("/earnings/withdraw", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "the body is { invoice, msat, maxFeeMsat? }", code: "bad_request" }, 400);
    const extra = Object.keys(body).filter((k) => !["invoice", "msat", "maxFeeMsat"].includes(k));
    if (extra.length) return c.json({ error: `withdraw takes invoice, msat and maxFeeMsat; not ${extra.join(", ")}`, code: "bad_request" }, 400);
    if (typeof body["invoice"] !== "string" || !body["invoice"].trim()) return c.json({ error: "invoice (BOLT11) is required", code: "bad_request" }, 400);
    if (typeof body["msat"] !== "number") return c.json({ error: "msat, the amount you confirmed, is required", code: "bad_request" }, 400);
    if (body["maxFeeMsat"] !== undefined && typeof body["maxFeeMsat"] !== "number") return c.json({ error: "maxFeeMsat must be a number of msat", code: "bad_request" }, 400);
    const actor = await deps.actorOf(c);
    try {
      return c.json(
        answerOf(
          await deps.withdrawals.withdraw({
            invoice: body["invoice"],
            msat: body["msat"],
            ...(body["maxFeeMsat"] !== undefined ? { maxFeeMsat: body["maxFeeMsat"] as number } : {}),
            ...(actor ? { actor } : {}),
          }),
        ),
      );
    } catch (err) {
      return refusal(c, err);
    }
  });
}
