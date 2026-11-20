/**
 * Sats IN by hand (plans/paid-runs.md §8, §9): an admin pays an invoice from
 * their own wallet into this server's, so it has sats to buy credit at other
 * struts with (`remote/buy-credit`, §10) before it has sold anything. The
 * Earnings tab's **Add sats**.
 *
 * - The invoice is made by the wallet's RECEIVE side (`makeInvoice`), the
 *   same one a buyer's 402 uses; nothing here can pay.
 * - It is kept ON FILE (`<dataDir>/payments/deposits.json`) until it settles
 *   or expires, so one paid after the page closed, or across a restart, is
 *   still recorded: `check()` reads every one each minute.
 * - Once settled it is one row in the ledger's `deposits`, by payment hash
 *   (what SETTLED, and who asked). Never credit, never earnings: only the
 *   books check counts it, as sats the wallet should hold.
 * - One read per payment hash at a time: a second caller joins the first.
 * - An invoice the wallet no longer knows (another wallet was set since) is
 *   forgotten; one the wallet cannot be asked about is read again, and
 *   forgotten a day past its expiry.
 * - Whose door it is (full scope only) is the route's; this is the work.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isLightningError, type InvoiceLookup, type LightningCapability } from "./lightning.js";
import type { Deposit, LedgerStore } from "./ledger.js";

/** The invoices asked for and not yet settled or expired, under the data directory. */
export const DEPOSITS_FILE = join("payments", "deposits.json");
/** How often `start()` reads them again. */
export const DEPOSIT_CHECK_MS = 60_000;
/** How long an invoice for a deposit stays payable. */
export const DEPOSIT_EXPIRY_SECS = 60 * 60;
/** The most one deposit asks: 0.1 bitcoin. */
export const DEPOSIT_MAX_SATS = 10_000_000;
/** An invoice the wallet cannot be asked about is forgotten this long past its expiry. */
export const DEPOSIT_FORGET_AFTER_MS = 24 * 60 * 60_000;
/** What the invoice says it is for. */
export const DEPOSIT_DESCRIPTION = "Sats added to this strut server's wallet";

/** An invoice for a deposit, asked for and not yet settled or expired. */
export interface PendingDeposit {
  paymentHash: string;
  invoice: string;
  /** What it asks. */
  msat: number;
  actor?: string;
  /** Epoch ms, when it was asked for. */
  at: number;
  /** Epoch ms, when its invoice expires. */
  expiresAt: number;
  /** Epoch ms, when it was last read. */
  checkedAt?: number;
  /** Why the last read said nothing more. */
  lastError?: string;
}

export interface DepositAnswer {
  state: "pending" | "settled" | "expired";
  paymentHash: string;
  /** What the invoice asks. */
  msat: number;
  /** ISO 8601, when the invoice expires. */
  expires: string;
  /** While pending: the invoice to pay. */
  invoice?: string;
  /** Once settled: the ledger's row (what settled, and when). */
  deposit?: Deposit;
  /** Pending: why the wallet could not be asked just now. */
  error?: string;
}

export type DepositErrorCode = "no_wallet" | "bad_amount" | "not_found" | "wallet_unavailable" | "wallet_refused";

/** A refusal: the route answers `status` with `{ error, code }`. */
export class DepositError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly code: DepositErrorCode,
    message: string,
  ) {
    super(message.startsWith(`${code}: `) ? message : `${code}: ${message}`);
    this.name = "DepositError";
  }
}

export interface DepositsDeps {
  /** The wallet's receive side now, or null with no wallet. */
  lightning: () => LightningCapability | null;
  ledger: () => Promise<LedgerStore>;
  /** Where the pending ones are kept; none → memory. */
  file?: string;
  now?: () => number;
}

export interface Deposits {
  /** An invoice for `sats` into this server's wallet. */
  ask(o: { sats: number; actor?: string }): Promise<DepositAnswer>;
  /** Read one now, by its payment hash; record it once settled. */
  read(paymentHash: string): Promise<DepositAnswer>;
  /** The invoices still payable or not yet read since they settled, newest first. */
  pending(): Promise<Array<Omit<PendingDeposit, "invoice">>>;
  /** Read every pending one; record the settled, forget the expired. */
  check(): Promise<Array<{ paymentHash: string; state: DepositAnswer["state"] | "unread"; error?: string }>>;
  /** Run `check()` every `ms` while the process lives. */
  start(ms?: number): void;
  stop(): void;
}

/** A whole number of sats from 1 to `DEPOSIT_MAX_SATS`, or a sentence why not. */
export function depositAmountProblem(sats: unknown): string | undefined {
  if (typeof sats !== "number" || !Number.isSafeInteger(sats) || sats <= 0) return "sats is a whole number of sats above 0";
  if (sats > DEPOSIT_MAX_SATS) return `sats is at most ${DEPOSIT_MAX_SATS.toLocaleString("en-US")} (0.1 bitcoin) a deposit`;
  return undefined;
}

export function createDeposits(deps: DepositsDeps): Deposits {
  const now = deps.now ?? Date.now;
  let memory: PendingDeposit[] | null = null;
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<unknown> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<DepositAnswer>>();

  const load = async (): Promise<PendingDeposit[]> => {
    if (memory) return memory;
    if (!deps.file || !existsSync(deps.file)) return (memory = []);
    try {
      const parsed = JSON.parse(await readFile(deps.file, "utf8")) as unknown;
      memory = Array.isArray(parsed) ? (parsed as PendingDeposit[]).filter((p) => p && typeof p.paymentHash === "string" && typeof p.invoice === "string") : [];
    } catch (err) {
      console.warn(`[payments] ${deps.file} could not be read (${err instanceof Error ? err.message : String(err)}); no pending deposits are known`);
      memory = [];
    }
    return memory;
  };
  const save = (list: PendingDeposit[]): Promise<void> => {
    memory = list;
    if (!deps.file) return Promise.resolve();
    const file = deps.file;
    const next = writes.then(async () => {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(memory, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    });
    writes = next.catch(() => {});
    return next;
  };
  const forget = async (hash: string) => save((await load()).filter((p) => p.paymentHash !== hash));
  const update = async (hash: string, patch: Partial<PendingDeposit>) =>
    save((await load()).map((p) => (p.paymentHash === hash ? { ...p, ...patch } : p)));

  const answerOf = (p: Pick<PendingDeposit, "paymentHash" | "msat" | "expiresAt">, state: DepositAnswer["state"], extra: Partial<DepositAnswer> = {}): DepositAnswer => ({
    state,
    paymentHash: p.paymentHash,
    msat: p.msat,
    expires: new Date(p.expiresAt).toISOString(),
    ...extra,
  });

  const walletRefusal = (err: unknown, what: string): DepositError => {
    const message = err instanceof Error ? err.message : String(err);
    if (isLightningError(err) && err.code === "wallet_unavailable") return new DepositError(503, "wallet_unavailable", `the wallet cannot be asked just now (${what}): ${message}`);
    return new DepositError(502, "wallet_refused", `the wallet refused ${what}: ${message}`);
  };

  const readOnce = async (hash: string): Promise<DepositAnswer> => {
    const ledger = await deps.ledger();
    const p = (await load()).find((x) => x.paymentHash === hash);
    if (!p) {
      const known = await ledger.depositOf(hash);
      if (!known) throw new DepositError(404, "not_found", `no deposit ${hash}: it was never asked for here, or it expired unpaid`);
      return { state: "settled", paymentHash: hash, msat: known.msat, expires: new Date(known.at).toISOString(), deposit: known };
    }
    const lightning = deps.lightning();
    if (!lightning) return answerOf(p, "pending", { invoice: p.invoice, error: "no wallet is set to ask" });
    let found: InvoiceLookup;
    try {
      found = await lightning.lookup(hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isLightningError(err) && err.code === "invoice_unknown") {
        await forget(hash);
        throw new DepositError(404, "not_found", `the wallet does not know ${hash} (another wallet was set since it was asked for): forgotten`);
      }
      if (now() > p.expiresAt + DEPOSIT_FORGET_AFTER_MS) {
        await forget(hash);
        console.warn(`[payments] deposit ${hash} forgotten a day past its expiry; the wallet could not be asked: ${message}`);
        return answerOf(p, "expired", { error: message });
      }
      await update(hash, { checkedAt: now(), lastError: message });
      return answerOf(p, "pending", { invoice: p.invoice, error: message });
    }
    if (found.state === "settled") {
      const settledAt = found.settled_at ? Date.parse(found.settled_at) : NaN;
      const deposit = await ledger.deposit({
        msat: found.msat && found.msat > 0 ? found.msat : p.msat,
        paymentHash: hash,
        ...(p.actor ? { actor: p.actor } : {}),
        at: Number.isFinite(settledAt) ? settledAt : now(),
      });
      await forget(hash);
      return answerOf(p, "settled", { deposit });
    }
    if (found.state === "expired") {
      await forget(hash);
      return answerOf(p, "expired");
    }
    await update(hash, { checkedAt: now() });
    return answerOf(p, "pending", { invoice: p.invoice });
  };

  const read = (hash: string): Promise<DepositAnswer> => {
    const going = inflight.get(hash);
    if (going) return going;
    const run = readOnce(hash).finally(() => inflight.delete(hash));
    inflight.set(hash, run);
    return run;
  };

  const service: Deposits = {
    async ask(o) {
      const problem = depositAmountProblem(o.sats);
      if (problem) throw new DepositError(400, "bad_amount", problem);
      const lightning = deps.lightning();
      if (!lightning) throw new DepositError(409, "no_wallet", "this server has no wallet to receive into: set one under Earnings → Wallet first");
      const msat = o.sats * 1000;
      let inv;
      try {
        inv = await lightning.makeInvoice({ msat, description: DEPOSIT_DESCRIPTION, expirySecs: DEPOSIT_EXPIRY_SECS });
      } catch (err) {
        throw walletRefusal(err, "an invoice");
      }
      const at = now();
      const expires = Date.parse(inv.expires);
      const p: PendingDeposit = {
        paymentHash: inv.payment_hash,
        invoice: inv.invoice,
        msat,
        ...(o.actor ? { actor: o.actor } : {}),
        at,
        expiresAt: Number.isFinite(expires) ? expires : at + DEPOSIT_EXPIRY_SECS * 1000,
      };
      await save([...(await load()).filter((x) => x.paymentHash !== p.paymentHash), p]);
      return answerOf(p, "pending", { invoice: p.invoice });
    },

    read,

    async pending() {
      return [...(await load())].sort((a, b) => b.at - a.at).map(({ invoice: _i, ...rest }) => rest);
    },

    async check() {
      if (checking) return [];
      const run = (async () => {
        const out: Array<{ paymentHash: string; state: DepositAnswer["state"] | "unread"; error?: string }> = [];
        for (const p of [...(await load())]) {
          try {
            const a = await read(p.paymentHash);
            out.push({ paymentHash: p.paymentHash, state: a.state, ...(a.error ? { error: a.error } : {}) });
          } catch (err) {
            out.push({ paymentHash: p.paymentHash, state: "unread", error: err instanceof Error ? err.message : String(err) });
          }
        }
        return out;
      })();
      checking = run;
      try {
        return await run;
      } finally {
        checking = null;
      }
    },

    start(ms = DEPOSIT_CHECK_MS) {
      if (timer) return;
      timer = setInterval(() => void service.check().catch(() => {}), ms);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return service;
}
