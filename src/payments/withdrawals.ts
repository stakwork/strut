/**
 * Sats OUT through the payer (plans/paid-runs.md §8, decision 19): a
 * person's WITHDRAWAL, and the hook item 9 fills for credit this strut BUYS
 * (`purpose: "purchase"`). Every send that settles is one `withdrawal`
 * entry in the books (its `subject` the purpose), so the books check counts
 * them all.
 *
 * - `msat` is what the person CONFIRMED: an invoice for any other amount is
 *   refused, so what was shown is what is paid.
 * - The fee cap defaults to the Sphinx LSP's own limit (`defaultMaxFeeMsat`).
 *   The fee booked is the one the wallet was charged (payer.ts).
 * - ONE pay or read per payment hash at a time (`inflight`): a second call
 *   — a double click, "Ask again", the minute's check — joins the one in
 *   flight. A caller is answered within `answerWithinMs` (25 s, under a
 *   proxy's 60 s): a wallet that has not answered by then is `pending`,
 *   `reading: true`, and the read goes on and records what it finds.
 * - A payment not settled or failed is kept ON FILE
 *   (`<dataDir>/payments/withdrawals.json`) before it is sent, with the
 *   payer it went through, and read again only through that payer: another
 *   wallet does not know it. It is recorded once when it settles, dropped
 *   when it fails or is refused before it went. A refused credential never
 *   drops one: it may have gone.
 * - Every minute `check()` reads what it may (never two checks at once).
 *   Past its invoice's expiry plus `STALE_AFTER_EXPIRY_MS` a payment is
 *   STALE: no more polling — the Sphinx mixer keeps the debit of a payment
 *   the LSP never answered and never refunds it (mixer/src/send.rs
 *   `openpay`), so the daemon answers `pending` forever. A person then
 *   records it as paid or drops it (`resolve`), or reads it once more.
 * - Kept from unattended re-sending: the daemon has no read for a payment,
 *   so its `status` POSTs the invoice again, which PAYS one the daemon never
 *   saw. A daemon payment whose pay call never answered is therefore read in
 *   the background only once its invoice has expired (the daemon then
 *   refuses to send it anew, and answers what it knows).
 * - Whose door it is (full scope only) is the route's; this is the work.
 *
 * A WORKER'S PAYOUT (plans/human-steps.md §8.2) is a third kind of send:
 * a `keysend` of an amount to the worker's Sphinx address, keyed by the
 * payout's key (64 hex, made before it is sent: the daemon's idempotency
 * key, this file's key and the `withdrawal` entry's `ref`). Only payouts.ts
 * starts one, after the ledger reserved it. It is kept, read and resolved as
 * an invoice's send is, with two hooks into the ledger: settled →
 * `payoutSettled` (the entry, the payout `paid`, the reserve onto
 * `withdrawn`); failed, refused before it went, never taken (`GET
 * /keysend/:id` 404) or dropped by a person → `payoutFailed` (the reserve
 * back to the worker). A keysend is read with `keysendStatus`, which never
 * sends, so the minute's check reads every one; it is stale a day after it
 * was sent (`KEYSEND_STALE_MS`), having no expiry to count from.
 *
 * RULING 7 (plans/human-steps.md §8.2): every send that is not a worker's —
 * an admin's Withdraw, an accepted `remote/buy-credit` — is refused when the
 * amount and its whole fee cap would leave the wallet holding less than what
 * workers are owed (`short_of_workers`), or when workers are owed and the
 * balance cannot be read (`balance_unknown`). A retry of one already out
 * only reads it, and checks nothing.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Bolt11Error, decodeBolt11 } from "./bolt11.js";
import { LightningError, isLightningError } from "./lightning.js";
import type { LedgerEntry, LedgerStore, SendPurpose } from "./ledger.js";
import { defaultMaxFeeMsat, NO_KEYSEND, type KeysendResult, type Payer, type PayResult, type PaymentState } from "./payer.js";
import { shortOfWorkers } from "./withdraw-reading.js";

/** The pending sends, under the data directory. */
export const WITHDRAWALS_FILE = join("payments", "withdrawals.json");
/** How often `start()` reads the pending ones again. */
export const WITHDRAW_CHECK_MS = 60_000;
/** How long a caller waits for the wallet before it is answered `pending`. */
export const ANSWER_WITHIN_MS = 25_000;
/** Past its invoice's expiry by this much, a payment is stale. */
export const STALE_AFTER_EXPIRY_MS = 60 * 60_000;
/** A keysend still pending this long after it was sent is stale
 *  (plans/human-steps.md §8.2): it has no expiry to count from. */
export const KEYSEND_STALE_MS = 24 * 60 * 60_000;

/** A payment that went out (or may have) and has not settled or failed. */
export interface PendingWithdrawal {
  /** The invoice's payment hash; a keysend's, the payout's key. */
  paymentHash: string;
  /** Absent (or `invoice`): an invoice paid. `keysend`: a worker's payout
   *  to `address` (plans/human-steps.md §8.2). */
  kind?: "invoice" | "keysend";
  /** An invoice's BOLT11. */
  invoice?: string;
  /** A keysend's Sphinx address. */
  address?: string;
  msat: number;
  maxFeeMsat: number;
  actor?: string;
  /** What it is for (item 9's purchases are `purchase`). */
  purpose: SendPurpose;
  /** The payer it went through (`Payer.id`): read only through that one. */
  payer: string;
  /** Epoch ms, when it was asked for. */
  at: number;
  /** Unix seconds: when its invoice expires; a keysend, which has none, when
   *  it goes stale (`KEYSEND_STALE_MS` after it was sent). */
  expiresAt: number;
  /** The wallet answered (`pending`): it is out. False: the pay call never
   *  answered, so it may or may not have gone. */
  answered: boolean;
  /** Epoch ms, when it was last read. */
  checkedAt?: number;
  /** Why the last read said nothing more. */
  lastError?: string;
  /** What the payer read before it was sent (the fee booked). */
  balanceBeforeMsat?: number;
}

/** A pending payment as a route shows it. */
export interface PendingView extends Omit<PendingWithdrawal, "invoice" | "balanceBeforeMsat"> {
  /** Past its invoice's expiry plus a margin: no more polling — record it
   *  or drop it. */
  stale: boolean;
  /** A read or pay of it is in flight now. */
  reading: boolean;
  /** It went through a payer that is not the current one. */
  otherWallet: boolean;
}

export interface WithdrawAnswer {
  state: PaymentState;
  paymentHash: string;
  msat: number;
  feeMsat: number;
  /** The routing fee the wallet reported, when it was not what it charged. */
  routingFeeMsat?: number;
  maxFeeMsat: number;
  preimage?: string;
  /** `failed`: the wallet's words; `pending`: why it is not known yet. */
  error?: string;
  /** Once settled: the ledger's entry. */
  entry?: LedgerEntry;
  /** It was paid and recorded before this call: nothing was sent. */
  existing?: true;
  /** `pending`: the wallet had not answered in time; the read goes on. */
  reading?: true;
}

export type WithdrawErrorCode =
  | "short_of_workers"
  | "balance_unknown"
  | "no_keysend"
  | "worker_send"
  | "not_an_invoice"
  | "no_amount"
  | "amount_mismatch"
  | "expired"
  | "bad_fee"
  | "no_pay_credential"
  | "other_wallet"
  | "not_pending"
  | "reading"
  | LightningError["code"];

/** A refusal: the route answers `status` with `{ error, code, walletCode? }`. */
export class WithdrawError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
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
  /** How long a caller waits for the wallet (tests: less). */
  answerWithinMs?: number;
  /** Ruling 7 (plans/human-steps.md §8.2): what workers are owed now, held
   *  and withdrawable (0 with no ledger)… */
  owedToWorkers?: () => Promise<number>;
  /** …and the wallet's balance now, or undefined when it cannot be read: a
   *  send that is not a worker's is refused when it would leave the wallet
   *  short of what is owed. Left out: no check. */
  balance?: () => Promise<number | undefined>;
  /** Run first in every check: payouts.ts's sweep of a payout reserved and
   *  never sent. */
  sweep?: () => Promise<unknown>;
}

export interface Withdrawals {
  /** Pay an invoice out (a person's withdrawal; item 9's purchase). */
  withdraw(o: { invoice: string; msat: number; maxFeeMsat?: number; actor?: string; purpose?: SendPurpose }): Promise<WithdrawAnswer>;
  /** A worker's payout (plans/human-steps.md §8.2): keysend `msat` to
   *  `address` once, keyed by the payout's `key`. Only payouts.ts calls it,
   *  after the ledger reserved the payout; a refusal before it was sent
   *  fails the payout (its reserve back) and throws. */
  keysend(o: { key: string; address: string; msat: number; maxFeeMsat: number; actor: string }): Promise<WithdrawAnswer>;
  /** Read one pending payment now, by its payment hash. */
  read(paymentHash: string): Promise<WithdrawAnswer>;
  /** A person settles a pending one by hand: `paid` records it (with the
   *  fee they say, else 0), `drop` forgets it. Refused while it is read. */
  resolve(paymentHash: string, o: { action: "paid" | "drop"; feeMsat?: number; actor?: string }): Promise<{ action: "paid" | "drop"; entry?: LedgerEntry }>;
  /** What is out and not yet settled or failed, newest first. */
  pending(): Promise<PendingView[]>;
  /** Read every pending payment it may read unattended; record the settled,
   *  drop the failed. What it read, in order; nothing while one runs. */
  check(): Promise<Array<{ paymentHash: string; state: PaymentState | "unread"; error?: string }>>;
  /** Run `check()` every `ms` (and once now) while the process lives. */
  start(ms?: number): void;
  stop(): void;
}

export function createWithdrawals(deps: WithdrawalsDeps): Withdrawals {
  const now = deps.now ?? Date.now;
  const answerWithin = deps.answerWithinMs ?? ANSWER_WITHIN_MS;
  let memory: PendingWithdrawal[] | null = null;
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<unknown> | null = null;
  // One write of the pending file at a time, and one pay or read per
  // payment hash: a second caller joins the one in flight.
  let writes: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<WithdrawAnswer>>();

  const load = async (): Promise<PendingWithdrawal[]> => {
    if (memory) return memory;
    if (!deps.file || !existsSync(deps.file)) return (memory = []);
    try {
      const parsed = JSON.parse(await readFile(deps.file, "utf8")) as unknown;
      memory = Array.isArray(parsed)
        ? (parsed as PendingWithdrawal[])
            .filter((p) => p && typeof p.paymentHash === "string" && (typeof p.invoice === "string" || (p.kind === "keysend" && typeof p.address === "string")))
            .map((p) => ({ ...p, purpose: p.purpose ?? "withdrawal", payer: p.payer ?? "" }))
        : [];
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
  const find = async (hash: string) => (await load()).find((x) => x.paymentHash === hash);
  const upsert = async (p: PendingWithdrawal) => save([...(await load()).filter((x) => x.paymentHash !== p.paymentHash), p]);
  const drop = async (hash: string) => {
    const list = await load();
    if (list.some((x) => x.paymentHash === hash)) await save(list.filter((x) => x.paymentHash !== hash));
  };
  const isStale = (p: PendingWithdrawal) => now() > p.expiresAt * 1000 + (p.kind === "keysend" ? 0 : STALE_AFTER_EXPIRY_MS);

  const usdOf = async (msat: number): Promise<number | undefined> => {
    try {
      const rate = await deps.usdPerBtc?.();
      return rate ? Math.round((msat / 1000 / 100_000_000) * rate * 1_000_000) : undefined;
    } catch {
      return undefined;
    }
  };

  /** A send that settled, into the books — a payout through its hook
   *  (`payoutSettled`: its entry, `paid`, its reserve onto `withdrawn`) —
   *  then off the pending list. */
  const record = async (p: PendingWithdrawal, feeMsat: number, o: { walletHash?: string; by?: string } = {}) => {
    const usd = await usdOf(p.msat);
    const ledger = await deps.ledger();
    const entry =
      p.purpose === "worker"
        ? (
            await ledger.payoutSettled({
              key: p.paymentHash,
              feeMsat,
              ...(o.walletHash ? { paymentHash: o.walletHash } : {}),
              ...(usd !== undefined ? { usd } : {}),
              ...(o.by ? { by: o.by } : {}),
              at: now(),
            })
          ).entry
        : await ledger.withdrawal({
            msat: p.msat,
            feeMsat,
            paymentHash: p.paymentHash,
            purpose: p.purpose,
            ...(p.actor ? { actor: p.actor } : {}),
            ...(usd !== undefined ? { usd } : {}),
            at: now(),
          });
    await drop(p.paymentHash);
    return entry;
  };
  /** A send that failed or never went, off the pending list — a payout
   *  through its hook first (`payoutFailed`: its reserve back). */
  const fail = async (p: PendingWithdrawal, why: string, by?: string) => {
    if (p.purpose === "worker") await (await deps.ledger()).payoutFailed({ key: p.paymentHash, why, ...(by ? { by } : {}), at: now() });
    await drop(p.paymentHash);
  };

  /** What the wallet said, into the books and the pending list. */
  const settle = async (p: PendingWithdrawal, r: PayResult & { walletHash?: string }): Promise<WithdrawAnswer> => {
    const answer: WithdrawAnswer = {
      state: r.state,
      paymentHash: p.paymentHash,
      msat: p.msat,
      feeMsat: r.feeMsat,
      ...(r.routingFeeMsat !== undefined ? { routingFeeMsat: r.routingFeeMsat } : {}),
      maxFeeMsat: p.maxFeeMsat,
      ...(r.preimage ? { preimage: r.preimage } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
    if (r.state === "settled") {
      const entry = await record(p, r.feeMsat, r.walletHash ? { walletHash: r.walletHash } : {});
      return { ...answer, feeMsat: entry.feeMsat ?? r.feeMsat, entry };
    }
    if (r.state === "failed") {
      await fail(p, r.error ?? "the payment failed");
      return answer;
    }
    const { lastError: _gone, ...rest } = p;
    await upsert({
      ...rest,
      answered: true,
      checkedAt: now(),
      ...(r.error ? { lastError: r.error } : {}),
      ...(r.balanceBeforeMsat !== undefined && p.balanceBeforeMsat === undefined ? { balanceBeforeMsat: r.balanceBeforeMsat } : {}),
    });
    return answer;
  };

  /** A wallet error. Refused before it was sent (`wallet_refused`,
   *  `bad_request`, on a payment the wallet never answered): dropped.
   *  Anything else — no answer, an answer strut cannot read, a refused
   *  credential — may have gone: it stays, and the error is said. */
  const failedCall = async (p: PendingWithdrawal, err: unknown, reading = false): Promise<never> => {
    if (!isLightningError(err)) throw err;
    // A keysend is read with a GET that never sends: a refusal of the read
    // says nothing about the payment.
    const neverSent = !p.answered && !(reading && p.kind === "keysend") && (err.code === "wallet_refused" || err.code === "bad_request");
    if (neverSent) await fail(p, err.message);
    else await upsert({ ...p, checkedAt: now(), lastError: err.message });
    if (err.walletCode === NO_KEYSEND) throw new WithdrawError(409, "no_keysend", err.message, err.walletCode);
    const status = err.code === "wallet_unavailable" ? 503 : err.code === "wallet_unauthorized" || err.code === "wallet_bad_answer" ? 502 : 400;
    throw new WithdrawError(status, err.code, err.message, err.walletCode);
  };
  /** A keysend's answer as a payment's: keyed by the payout's key, the
   *  wallet's payment hash beside it. */
  const keysendAsPay = (p: PendingWithdrawal, r: KeysendResult): PayResult & { walletHash?: string } => ({
    paymentHash: p.paymentHash,
    state: r.state,
    feeMsat: r.feeMsat,
    ...(r.preimage ? { preimage: r.preimage } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.paymentHash ? { walletHash: r.paymentHash } : {}),
  });

  /** Run `op` for `hash` unless one is in flight, whose promise is joined. */
  const once = (hash: string, op: () => Promise<WithdrawAnswer>): Promise<WithdrawAnswer> => {
    const cur = inflight.get(hash);
    if (cur) return cur;
    const p = op().finally(() => {
      if (inflight.get(hash) === p) inflight.delete(hash);
    });
    void p.catch(() => {}); // a caller answered `pending` before it ended is gone
    inflight.set(hash, p);
    return p;
  };
  /** A caller's answer: the operation's, or `pending` when the wallet has
   *  not answered within `answerWithin` (the operation goes on). */
  const answer = async (hash: string, op: Promise<WithdrawAnswer>, p: PendingWithdrawal): Promise<WithdrawAnswer> => {
    let timer: NodeJS.Timeout | undefined;
    // Referenced, unlike the minute's check: a caller is waiting on it (an
    // HTTP request, a step), and it is cleared the moment the answer comes.
    // Unreferenced, a process with nothing else on its loop — a test runner
    // on Node 22 — would end with the caller still waiting.
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), answerWithin);
    });
    try {
      const r = await Promise.race([op, late]);
      if (r !== "late") return r;
      return { state: "pending", paymentHash: hash, msat: p.msat, feeMsat: 0, maxFeeMsat: p.maxFeeMsat, reading: true, error: "the wallet has not answered yet: it is still being read" };
    } finally {
      clearTimeout(timer);
    }
  };

  const readOp = (payer: Payer, p: PendingWithdrawal) => async () => {
    try {
      if (p.kind === "keysend") {
        if (!payer.keysendStatus) throw new LightningError("wallet_refused", `${payer.id} cannot read a keysend`, NO_KEYSEND);
        return await settle(p, keysendAsPay(p, await payer.keysendStatus({ id: p.paymentHash })));
      }
      return await settle(p, await payer.status({ invoice: p.invoice ?? "", paymentHash: p.paymentHash, maxFeeMsat: p.maxFeeMsat, ...(p.balanceBeforeMsat !== undefined ? { balanceBeforeMsat: p.balanceBeforeMsat } : {}) }));
    } catch (err) {
      return failedCall(p, err, true);
    }
  };
  const otherWallet = (p: PendingWithdrawal, payer: Payer) =>
    new WithdrawError(409, "other_wallet", `this payment went out through another wallet (${p.payer || "an earlier one"}), not ${payer.id}: set that wallet back to read it, or record it as paid or drop it`);

  const api: Withdrawals = {
    async withdraw(o) {
      if (o.purpose === "worker") throw new WithdrawError(400, "worker_send", "a worker's payout is a keysend from their own withdrawal (task/withdraw), never an invoice");
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
      const hash = inv.paymentHash;

      // Before the books: a server that cannot pay never opens a ledger here.
      const payer = await deps.payer();
      if (!payer) {
        throw new WithdrawError(409, "no_pay_credential", "the wallet has no pay credential: add the daemon's pay token, or an NWC connection that may pay, under Earnings → Wallet");
      }
      const flying = inflight.get(hash);
      const had = await find(hash);
      if (flying && had) return answer(hash, flying, had);
      const recorded = await (await deps.ledger()).withdrawalOf(hash);
      if (recorded) {
        return { state: "settled", paymentHash: hash, msat: recorded.msat ?? inv.msat, feeMsat: recorded.feeMsat ?? 0, maxFeeMsat, entry: recorded, existing: true };
      }
      if (had) {
        // A retry of one that is out: read where it stands, through its payer.
        if (had.payer && had.payer !== payer.id) throw otherWallet(had, payer);
        const p = { ...had, maxFeeMsat, ...(o.actor && !had.actor ? { actor: o.actor } : {}) };
        return answer(hash, once(hash, readOp(payer, p)), p);
      }
      if (inv.expiresAt * 1000 <= now()) throw new WithdrawError(400, "expired", `the invoice expired at ${new Date(inv.expiresAt * 1000).toISOString()}: ask for a new one`);
      // Ruling 7: not with sats that are workers'. A send in flight is out of
      // the balance already (a wallet keeps the debit).
      const owed = deps.owedToWorkers ? await deps.owedToWorkers() : 0;
      if (owed > 0 && deps.balance) {
        const balance = await deps.balance();
        if (balance === undefined) {
          throw new WithdrawError(409, "balance_unknown", `workers are owed ${owed} msat here and the wallet's balance cannot be read now: nothing is sent while it is not known to cover them`);
        }
        const short = shortOfWorkers({ balanceMsat: balance, msat: inv.msat, maxFeeMsat, owedMsat: owed });
        if (short) {
          throw new WithdrawError(409, "short_of_workers", `paying ${inv.msat} msat (and a fee of up to ${maxFeeMsat}) would leave ${short.afterMsat} msat, ${short.shortMsat} msat short of the ${short.owedMsat} msat workers are owed`);
        }
      }
      // On file before it goes: a crash mid-pay leaves it to be read.
      const p: PendingWithdrawal = {
        paymentHash: hash,
        invoice: inv.invoice,
        msat: inv.msat,
        maxFeeMsat,
        ...(o.actor ? { actor: o.actor } : {}),
        purpose: o.purpose ?? "withdrawal",
        payer: payer.id,
        at: now(),
        expiresAt: inv.expiresAt,
        answered: false,
      };
      await upsert(p);
      const op = once(hash, async () => {
        try {
          const r = await payer.pay({ invoice: inv.invoice, maxFeeMsat });
          return await settle(r.balanceBeforeMsat !== undefined ? { ...p, balanceBeforeMsat: r.balanceBeforeMsat } : p, r);
        } catch (err) {
          return failedCall(p, err);
        }
      });
      return answer(hash, op, p);
    },

    async keysend(o) {
      const key = o.key;
      const p: PendingWithdrawal = {
        paymentHash: key,
        kind: "keysend",
        address: o.address,
        msat: o.msat,
        maxFeeMsat: o.maxFeeMsat,
        actor: o.actor,
        purpose: "worker",
        payer: "",
        at: now(),
        expiresAt: Math.floor((now() + KEYSEND_STALE_MS) / 1000),
        answered: false,
      };
      const payer = await deps.payer();
      if (!payer || !payer.keysend) {
        // Refused before it was on file: nothing went, the reserve goes back.
        const [code, why] = !payer
          ? (["no_pay_credential", "the wallet has no pay credential: add the daemon's pay token under Earnings → Wallet"] as const)
          : (["no_keysend", `${payer.id} cannot keysend to a Sphinx address (an NWC wallet takes no route hints): the Stadeum's wallet is the Sphinx daemon`] as const);
        await fail(p, why);
        throw new WithdrawError(409, code, why);
      }
      const keysend = payer.keysend.bind(payer);
      const sending = { ...p, payer: payer.id };
      // On file before it goes: a crash mid-send leaves it to be read.
      await upsert(sending);
      const op = once(key, async () => {
        try {
          return await settle(sending, keysendAsPay(sending, await keysend({ id: key, address: o.address, msat: o.msat, maxFeeMsat: o.maxFeeMsat })));
        } catch (err) {
          return failedCall(sending, err);
        }
      });
      return answer(key, op, sending);
    },

    async read(paymentHash) {
      const hash = paymentHash.toLowerCase();
      const p = await find(hash);
      if (!p) {
        const recorded = await (await deps.ledger()).withdrawalOf(hash);
        if (recorded) return { state: "settled", paymentHash: hash, msat: recorded.msat ?? 0, feeMsat: recorded.feeMsat ?? 0, maxFeeMsat: 0, entry: recorded, existing: true };
        throw new WithdrawError(404, "not_pending", `no payment ${hash} is out`);
      }
      const flying = inflight.get(hash);
      if (flying) return answer(hash, flying, p);
      const payer = await deps.payer();
      if (!payer) throw new WithdrawError(409, "no_pay_credential", "the wallet has no pay credential: it cannot be read");
      if (p.payer && p.payer !== payer.id) throw otherWallet(p, payer);
      return answer(hash, once(hash, readOp(payer, p)), p);
    },

    async resolve(paymentHash, o) {
      const hash = paymentHash.toLowerCase();
      const p = await find(hash);
      if (!p) throw new WithdrawError(404, "not_pending", `no payment ${hash} is out`);
      if (inflight.has(hash)) throw new WithdrawError(409, "reading", "it is being read now: wait for the read, then decide");
      if (o.action === "drop") {
        await fail(p, `dropped by ${o.actor ?? "a person"}: recorded as never received`, o.actor);
        return { action: "drop" };
      }
      const fee = o.feeMsat ?? 0;
      if (!Number.isSafeInteger(fee) || fee < 0) throw new WithdrawError(400, "bad_fee", "feeMsat must be a whole number of msat, 0 or more");
      const entry = await record({ ...p, ...(p.actor ? {} : o.actor ? { actor: o.actor } : {}) }, fee, o.actor ? { by: o.actor } : {});
      return { action: "paid", entry };
    },

    async pending() {
      const payer = await deps.payer().catch(() => null);
      return [...(await load())]
        .sort((a, b) => b.at - a.at)
        .map(({ invoice: _i, balanceBeforeMsat: _b, ...p }) => ({
          ...p,
          stale: isStale(p as PendingWithdrawal),
          reading: inflight.has(p.paymentHash),
          otherWallet: !!payer && !!p.payer && p.payer !== payer.id,
        }));
    },

    check() {
      if (checking) return Promise.resolve([]);
      const run = (async () => {
        if (deps.sweep) await deps.sweep().catch((err) => console.warn(`[payments] the payouts' sweep failed: ${err instanceof Error ? err.message : String(err)}`));
        const list = await load();
        if (!list.length) return [];
        const payer = await deps.payer();
        if (!payer) return list.map((p) => ({ paymentHash: p.paymentHash, state: "unread" as const, error: "no pay credential" }));
        const out: Array<{ paymentHash: string; state: PaymentState | "unread"; error?: string }> = [];
        for (const p of [...list]) {
          const unread = (error: string) => out.push({ paymentHash: p.paymentHash, state: "unread", error });
          if (inflight.has(p.paymentHash)) {
            unread("being read now");
            continue;
          }
          if (p.payer && p.payer !== payer.id) {
            unread("it went out through another wallet");
            continue;
          }
          if (isStale(p)) {
            unread(p.kind === "keysend" ? "stale: still pending a day after it was sent; record it as paid or drop it" : "stale: past its invoice's expiry; record it as paid or drop it");
            continue;
          }
          // A keysend is read with a GET that never sends: always.
          const unattended = p.kind === "keysend" || p.answered || payer.provider !== "sphinx" || p.expiresAt * 1000 <= now();
          if (!unattended) {
            unread("its pay call never answered: read it by asking again, or wait for the invoice to expire");
            continue;
          }
          try {
            const a = await once(p.paymentHash, readOp(payer, p));
            out.push({ paymentHash: p.paymentHash, state: a.state, ...(a.error ? { error: a.error } : {}) });
          } catch (err) {
            const dropped = !(await find(p.paymentHash));
            out.push({ paymentHash: p.paymentHash, state: dropped ? "failed" : "unread", error: err instanceof Error ? err.message : String(err) });
          }
        }
        return out;
      })();
      checking = run.finally(() => {
        checking = null;
      });
      return run;
    },

    start(ms = WITHDRAW_CHECK_MS) {
      if (timer) return;
      const tick = () => {
        // A check still reading (the daemon waits up to 60 s a payment) is
        // not overlapped: `check()` answers nothing while one runs.
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
