/**
 * WITHDRAW (plans/paid-runs.md §8, decision 19): a person pays a BOLT11
 * invoice out of the server's wallet through the payer (payer.ts), and the
 * books gain one `withdrawal` entry once it settles.
 *
 * - `msat` is what the person CONFIRMED: an invoice for any other amount is
 *   refused, so what was shown is what is paid.
 * - The fee cap defaults to the Sphinx LSP's own limit (`defaultMaxFeeMsat`).
 * - A payment the wallet answers `pending` is kept ON FILE
 *   (`<dataDir>/payments/withdrawals.json`) and read again — by the person's
 *   retry, and every minute by `check()` — until it settles (then recorded)
 *   or fails (then dropped). The ledger keeps one withdrawal per payment
 *   hash, so a payment read settled twice, or retried, is recorded once.
 * - Whose door it is (full scope only) is the route's; this is the work.
 *
 * Kept from unattended re-sending: the daemon has no read for a payment, so
 * its `status` POSTs the invoice again, which PAYS one the daemon never saw.
 * A daemon payment whose pay call never answered is therefore read in the
 * background only once its invoice has expired (the daemon then refuses to
 * send it anew, and answers what it knows); before that, only the person's
 * own retry reads it.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Bolt11Error, decodeBolt11 } from "./bolt11.js";
import { LightningError, isLightningError } from "./lightning.js";
import type { LedgerEntry, LedgerStore } from "./ledger.js";
import { defaultMaxFeeMsat, type Payer, type PayResult, type PaymentState } from "./payer.js";

/** The pending withdrawals, under the data directory. */
export const WITHDRAWALS_FILE = join("payments", "withdrawals.json");
/** How often `start()` reads the pending ones again. */
export const WITHDRAW_CHECK_MS = 60_000;

/** A payment that went out (or may have) and has not settled or failed. */
export interface PendingWithdrawal {
  paymentHash: string;
  invoice: string;
  msat: number;
  maxFeeMsat: number;
  actor?: string;
  /** Epoch ms, when it was asked for. */
  at: number;
  /** Unix seconds, when its invoice expires. */
  expiresAt: number;
  /** The wallet answered (`pending`): it is out. False: the pay call never
   *  answered, so it may or may not have gone. */
  answered: boolean;
  /** Epoch ms, when it was last read. */
  checkedAt?: number;
}

export interface WithdrawAnswer {
  state: PaymentState;
  paymentHash: string;
  msat: number;
  feeMsat: number;
  maxFeeMsat: number;
  preimage?: string;
  /** `failed`: the wallet's words. */
  error?: string;
  /** Once settled: the ledger's entry. */
  entry?: LedgerEntry;
  /** It was paid and recorded before this call: nothing was sent. */
  existing?: true;
}

export type WithdrawErrorCode =
  | "not_an_invoice"
  | "no_amount"
  | "amount_mismatch"
  | "expired"
  | "bad_fee"
  | "no_pay_credential"
  | LightningError["code"];

/** A refusal: the route answers `status` with `{ error, code, walletCode? }`. */
export class WithdrawError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code: WithdrawErrorCode,
    message: string,
    readonly walletCode?: string,
  ) {
    super(message.startsWith(`${code}: `) ? message : `${code}: ${message}`);
    this.name = "WithdrawError";
  }
}

export interface WithdrawalsDeps {
  /** The payer now, or null with no pay credential. */
  payer: () => Promise<Payer | null>;
  ledger: () => Promise<LedgerStore>;
  /** Where the pending ones are kept; none → memory. */
  file?: string;
  /** Dollars per bitcoin now, for the books; undefined when unknown. */
  usdPerBtc?: () => Promise<number | undefined>;
  now?: () => number;
}

export interface Withdrawals {
  withdraw(o: { invoice: string; msat: number; maxFeeMsat?: number; actor?: string }): Promise<WithdrawAnswer>;
  /** What is out and not yet settled or failed, newest first. */
  pending(): Promise<PendingWithdrawal[]>;
  /** Read every pending payment it may read unattended; record the settled,
   *  drop the failed. What it read, in order. */
  check(): Promise<Array<{ paymentHash: string; state: PaymentState | "unread"; error?: string }>>;
  /** Run `check()` every `ms` (and once now) while the process lives. */
  start(ms?: number): void;
  stop(): void;
}

export function createWithdrawals(deps: WithdrawalsDeps): Withdrawals {
  const now = deps.now ?? Date.now;
  let memory: PendingWithdrawal[] | null = null;
  let timer: NodeJS.Timeout | undefined;
  // One write of the pending file at a time, and one pay or read per
  // payment hash: two clicks on one invoice pay it once.
  let writes: Promise<unknown> = Promise.resolve();
  const locks = new Map<string, Promise<unknown>>();

  const load = async (): Promise<PendingWithdrawal[]> => {
    if (memory) return memory;
    if (!deps.file || !existsSync(deps.file)) return (memory = []);
    try {
      const parsed = JSON.parse(await readFile(deps.file, "utf8")) as unknown;
      memory = Array.isArray(parsed) ? (parsed as PendingWithdrawal[]).filter((p) => p && typeof p.paymentHash === "string" && typeof p.invoice === "string") : [];
    } catch (err) {
      console.warn(`[payments] ${deps.file} could not be read (${err instanceof Error ? err.message : String(err)}); no pending withdrawals are known`);
      memory = [];
    }
    return memory;
  };
  const save = (list: PendingWithdrawal[]): Promise<void> => {
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
  const upsert = async (p: PendingWithdrawal) => save([...(await load()).filter((x) => x.paymentHash !== p.paymentHash), p]);
  const drop = async (hash: string) => {
    const list = await load();
    if (list.some((x) => x.paymentHash === hash)) await save(list.filter((x) => x.paymentHash !== hash));
  };

  const withLock = <T>(hash: string, fn: () => Promise<T>): Promise<T> => {
    const prior = locks.get(hash) ?? Promise.resolve();
    const run = prior.then(fn);
    // What the next caller waits on: settled either way, never a rejection.
    const held: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(hash, held);
    void held.then(() => {
      if (locks.get(hash) === held) locks.delete(hash);
    });
    return run;
  };

  const usdOf = async (msat: number): Promise<number | undefined> => {
    try {
      const rate = await deps.usdPerBtc?.();
      return rate ? Math.round((msat / 1000 / 100_000_000) * rate * 1_000_000) : undefined;
    } catch {
      return undefined;
    }
  };

  /** What the wallet said, into the books and the pending list. */
  const settle = async (p: PendingWithdrawal, r: PayResult): Promise<WithdrawAnswer> => {
    const answer: WithdrawAnswer = {
      state: r.state,
      paymentHash: p.paymentHash,
      msat: p.msat,
      feeMsat: r.feeMsat,
      maxFeeMsat: p.maxFeeMsat,
      ...(r.preimage ? { preimage: r.preimage } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
    if (r.state === "settled") {
      const usd = await usdOf(p.msat);
      const entry = await (await deps.ledger()).withdrawal({
        msat: p.msat,
        feeMsat: r.feeMsat,
        paymentHash: p.paymentHash,
        ...(p.actor ? { actor: p.actor } : {}),
        ...(usd !== undefined ? { usd } : {}),
        at: now(),
      });
      await drop(p.paymentHash);
      return { ...answer, feeMsat: entry.feeMsat ?? r.feeMsat, entry };
    }
    if (r.state === "failed") {
      await drop(p.paymentHash);
      return answer;
    }
    await upsert({ ...p, answered: true, checkedAt: now() });
    return answer;
  };

  /** A wallet error: before anything was sent, the payment is dropped; when
   *  it may have gone (no answer, or one strut cannot read), it stays. */
  const failedCall = async (p: PendingWithdrawal, err: unknown): Promise<never> => {
    if (!isLightningError(err)) throw err;
    const mayHaveGone = err.code === "wallet_unavailable" || err.code === "wallet_bad_answer";
    if (mayHaveGone) await upsert({ ...p, checkedAt: now() });
    else await drop(p.paymentHash);
    const status = err.code === "wallet_unavailable" ? 503 : err.code === "wallet_unauthorized" || err.code === "wallet_bad_answer" ? 502 : 400;
    throw new WithdrawError(status, err.code, err.message, err.walletCode);
  };

  const api: Withdrawals = {
    async withdraw(o) {
      let inv;
      try {
        inv = decodeBolt11(o.invoice);
      } catch (err) {
        throw new WithdrawError(400, "not_an_invoice", err instanceof Bolt11Error ? err.message : "not a BOLT11 invoice");
      }
      if (inv.msat === undefined) throw new WithdrawError(400, "no_amount", "the invoice names no amount: ask for one that does, so what you confirm is what is paid");
      if (!Number.isSafeInteger(o.msat) || o.msat <= 0) throw new WithdrawError(400, "amount_mismatch", "msat (the amount you confirmed) is required, in msat");
      if (inv.msat !== o.msat) {
        throw new WithdrawError(400, "amount_mismatch", `the invoice asks for ${inv.msat} msat, not the ${o.msat} msat confirmed`);
      }
      const maxFeeMsat = o.maxFeeMsat ?? defaultMaxFeeMsat(inv.msat);
      if (!Number.isSafeInteger(maxFeeMsat) || maxFeeMsat < 0) throw new WithdrawError(400, "bad_fee", "maxFeeMsat must be a whole number of msat, 0 or more");

      return withLock(inv.paymentHash, async () => {
        // Before the books: a server that cannot pay never opens a ledger here.
        const payer = await deps.payer();
        if (!payer) {
          throw new WithdrawError(409, "no_pay_credential", "the wallet has no pay credential: add the daemon's pay token, or an NWC connection that may pay, under Earnings → Wallet");
        }
        const recorded = await (await deps.ledger()).withdrawalOf(inv.paymentHash);
        if (recorded) {
          return { state: "settled", paymentHash: inv.paymentHash, msat: recorded.msat ?? inv.msat!, feeMsat: recorded.feeMsat ?? 0, maxFeeMsat, entry: recorded, existing: true };
        }
        const had = (await load()).find((p) => p.paymentHash === inv.paymentHash);
        if (had) {
          // A retry of one that is out: read where it stands.
          const p = { ...had, maxFeeMsat, ...(o.actor && !had.actor ? { actor: o.actor } : {}) };
          try {
            return await settle(p, await payer.status({ invoice: p.invoice, paymentHash: p.paymentHash, maxFeeMsat }));
          } catch (err) {
            return failedCall(p, err);
          }
        }
        if (inv.expiresAt * 1000 <= now()) throw new WithdrawError(400, "expired", `the invoice expired at ${new Date(inv.expiresAt * 1000).toISOString()}: ask for a new one`);
        // On file before it goes: a crash mid-pay leaves it to be read.
        const p: PendingWithdrawal = {
          paymentHash: inv.paymentHash,
          invoice: inv.invoice,
          msat: inv.msat!,
          maxFeeMsat,
          ...(o.actor ? { actor: o.actor } : {}),
          at: now(),
          expiresAt: inv.expiresAt,
          answered: false,
        };
        await upsert(p);
        try {
          return await settle(p, await payer.pay({ invoice: p.invoice, maxFeeMsat }));
        } catch (err) {
          return failedCall(p, err);
        }
      });
    },

    async pending() {
      return [...(await load())].sort((a, b) => b.at - a.at);
    },

    async check() {
      const list = await load();
      if (!list.length) return [];
      const payer = await deps.payer();
      if (!payer) return list.map((p) => ({ paymentHash: p.paymentHash, state: "unread" as const, error: "no pay credential" }));
      const out: Array<{ paymentHash: string; state: PaymentState | "unread"; error?: string }> = [];
      for (const p of list) {
        const unattended = p.answered || payer.provider !== "sphinx" || p.expiresAt * 1000 <= now();
        if (!unattended) {
          out.push({ paymentHash: p.paymentHash, state: "unread", error: "its pay call never answered: read it by asking again, or wait for the invoice to expire" });
          continue;
        }
        try {
          const a = await withLock(p.paymentHash, async () => {
            const current = (await load()).find((x) => x.paymentHash === p.paymentHash);
            if (!current) return null;
            return settle(current, await payer.status({ invoice: current.invoice, paymentHash: current.paymentHash, maxFeeMsat: current.maxFeeMsat }));
          });
          if (a) out.push({ paymentHash: p.paymentHash, state: a.state, ...(a.error ? { error: a.error } : {}) });
        } catch (err) {
          // Refused now (the daemon: expired, never sent): it never went out.
          if (isLightningError(err) && err.code === "wallet_refused") {
            await drop(p.paymentHash);
            out.push({ paymentHash: p.paymentHash, state: "failed", error: err.message });
          } else {
            out.push({ paymentHash: p.paymentHash, state: "unread", error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      return out;
    },

    start(ms = WITHDRAW_CHECK_MS) {
      if (timer) return;
      const tick = () => {
        void api.check().catch((err) => console.warn(`[payments] reading pending withdrawals failed: ${err instanceof Error ? err.message : String(err)}`));
      };
      timer = setInterval(tick, ms);
      timer.unref?.();
      tick();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return api;
}
