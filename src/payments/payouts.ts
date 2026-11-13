/**
 * PAYOUTS (plans/human-steps.md §8.2, item 5b): the payer's THIRD door. A
 * worker withdraws what passed its hold: their page asks for an amount
 * (`task/withdraw { msat }`), and strut keysends it to the Sphinx address
 * their sign-in gave, with nobody's yes per payment, inside the switch, the
 * solvency check, the ledger's reserve, the minimum, the day's caps and one
 * payout on its way per worker. Each withdrawal is one payment.
 *
 * `pay` checks, in this order, before anything is reserved:
 *
 * 1. The address is the worker's own: one the session carries, whose pubkey
 *    is the actor's key (`secp:<x-only>`) — `no_address`. The page never
 *    names it; the door hands it from the session.
 * 2. The switch is on, and the wallet can keysend: a pay credential, a payer
 *    with the keysend route — `payouts_off`, `no_pay_credential`,
 *    `no_keysend`.
 * 3. Solvency: the wallet's balance (waited on at most 5 s) holds at least
 *    what every worker is owed, held and withdrawable, this payout included —
 *    `wallet_short`; a balance that cannot be read refuses
 *    (`wallet_unavailable`). A short wallet refuses every worker alike.
 * 4. The ledger's reserve (`reservePayout`), one guarded transaction: the
 *    switch again, the minimum, one payout on its way, `msat + maxFeeMsat`
 *    in what is withdrawable now, the worker's and the server's day.
 *
 * Then the keysend goes through `withdrawals.keysend`, as an admin's send
 * goes through `withdraw`: kept on file, read, resolved, and booked through
 * the ledger's hooks. The worker pays the routing fee, at most its cap
 * (`defaultMaxFeeMsat`), so a payout leaves the wallet's cover as it was.
 *
 * Never on a services bag: createStrut hands it to the task service
 * (`deps.payouts`), whose worker's `withdraw` counts the call against the
 * worker's budget, and to the staff's `/tasks/payouts` routes.
 */

import { randomBytes } from "node:crypto";
import { defaultMaxFeeMsat } from "./fee.js";
import type { LightningCapability } from "./lightning.js";
import {
  DEFAULT_PAYOUT_SETTINGS,
  payoutMaxMsat,
  type LedgerStore,
  type PayeeBalance,
  type Payout,
  type PayoutListQuery,
  type PayoutRefusal,
  type PayoutSettings,
  type PayoutSettingsInput,
} from "./ledger.js";
import type { Payer } from "./payer.js";
import { KEYSEND_STALE_MS, WithdrawError, type WithdrawAnswer, type Withdrawals } from "./withdrawals.js";

/** How long the solvency check waits for the wallet's balance. */
export const PAYOUT_BALANCE_MS = 5_000;
/** A payout `out` in the ledger this long, on no pending list, was never
 *  sent: the process stopped between its reserve and its send. */
export const ORPHAN_AFTER_MS = 60_000;

/** Why `task/withdraw` refused, as a code its page reads. */
export type PayoutErrorCode =
  | "bad_request"
  | "no_address"
  | "no_pay_credential"
  | "no_keysend"
  | "wallet_short"
  | "wallet_unavailable"
  | "unknown_payout"
  | "not_here"
  | PayoutRefusal;

/** The payout on its way, as the worker and the staff see it. */
export interface PayoutOut {
  key: string;
  msat: number;
  maxFeeMsat: number;
  at: number;
  /** Still pending a day after it was sent: it waits for staff. */
  stale: boolean;
}

/** A refusal: `code: sentence`, as a step's error is read. `maxMsat` is the
 *  most the worker could ask now, where that helps; `out` the payout on its
 *  way (`payout_out`). */
export class PayoutError extends Error {
  constructor(
    readonly code: PayoutErrorCode,
    message: string,
    readonly detail: { maxMsat?: number; out?: PayoutOut } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "PayoutError";
  }
}

/** What `task/me` answers as `payout` (plans/human-steps.md §8.2). */
export interface PayoutView {
  /** Withdrawing is open here now — what strut knows without asking the
   *  wallet: the switch, a pay credential that can keysend, an address in
   *  the session, strut's own task store. */
  on: boolean;
  why?: "off" | "no_wallet" | "no_keysend" | "no_address" | "not_here";
  minMsat: number;
  /** This worker's day cap left. */
  dayLeftMsat: number;
  /** The most one withdrawal may ask now; 0 when under `minMsat`, while a
   *  payout is out, or while withdrawing is not open. */
  maxMsat: number;
  out?: PayoutOut;
}

/** What `task/withdraw` answers: `settled`, `pending` (on its way: `task/me`
 *  shows it) or `failed` (its reserve back), with the fee the worker was
 *  charged (0 until settled) and its cap. */
export interface PayoutAnswer {
  state: "settled" | "pending" | "failed";
  key: string;
  msat: number;
  feeMsat: number;
  maxFeeMsat: number;
  error?: string;
}

/** One payout as the staff list it. */
export type PayoutListed = Payout & { stale: boolean };

export interface PayoutsList {
  settings: PayoutSettings;
  /** Today's (UTC) payouts against the server's cap. */
  today: { day: string; paidMsat: number; outMsat: number; count: number; serverLeftMsat: number };
  payouts: PayoutListed[];
}

export interface PayoutsDeps {
  /** The ledger, made when it is not there (a reserve, a save). */
  ledger(): Promise<LedgerStore>;
  /** The ledger only where one is: a read makes no file. */
  ledgerIfAny(): Promise<LedgerStore | null>;
  withdrawals: Pick<Withdrawals, "keysend" | "read" | "resolve" | "pending">;
  /** The payer now, or null with no pay credential. */
  payer(): Promise<Payer | null>;
  /** The wallet's receive side: its balance, for the solvency check. */
  lightning(): LightningCapability | null;
  /** The clock earnings are held by (the task store's). */
  now?(): number;
  balanceMs?: number;
  /** A payout's key: 32 random bytes in hex (a test's: its own). */
  key?(): string;
}

export interface Payouts {
  /** A worker's withdrawal: the checks, the reserve, the keysend. Throws a
   *  `PayoutError` for a refusal. */
  pay(actor: string, o: { address?: string; msat: number }): Promise<PayoutAnswer>;
  /** `task/me`'s `payout`, from the balance it already read. */
  view(actor: string, o: { address?: string; balance: PayeeBalance }): Promise<PayoutView>;
  settings(): Promise<PayoutSettings>;
  saveSettings(input: Omit<PayoutSettingsInput, "by" | "at">, by?: string): Promise<PayoutSettings>;
  /** `GET /tasks/payouts`: the settings, today's use, the payouts newest
   *  first (`stale`: the payouts still out a day after they were sent). */
  list(q?: Omit<PayoutListQuery, "state"> & { state?: PayoutListQuery["state"] | "stale" }): Promise<PayoutsList>;
  /** A payout read now through the payer (`withdrawals.read`), and the row after. */
  read(key: string): Promise<{ payout: PayoutListed; answer: WithdrawAnswer }>;
  /** A stale payout resolved by a person (`withdrawals.resolve`): `paid`
   *  settles it with the fee they give (else 0), `drop` fails it and gives
   *  its reserve back. */
  resolve(key: string, o: { action: "paid" | "drop"; feeMsat?: number }, by?: string): Promise<{ payout: PayoutListed; action: "paid" | "drop" }>;
  /** Fails every payout `out` in the ledger for `ORPHAN_AFTER_MS` that is on
   *  no pending list: reserved, never sent. The minute's check runs it. */
  sweep(): Promise<number>;
}

const SPHINX_ADDRESS = /^(0[23][0-9a-f]{64})_(0[23][0-9a-f]{64})_(\d+)$/;

/** A Sphinx address's pubkey (33 bytes, hex), or undefined when it is not
 *  one: `<pubkey>_<lsp_pubkey>_<scid>`, as `parseSphinxAddress`
 *  (kit/src/wallet/protocol.ts) reads it. */
export function sphinxAddressPubkey(address: string): string | undefined {
  return SPHINX_ADDRESS.exec(address.trim().toLowerCase())?.[1];
}

/** Whether `address` is `actor`'s own: its pubkey is the key the actor
 *  signed in with (`secp:<x-only>`, the root key's). Only that key can claim
 *  a keysend to it; the route hint only says how to reach it. */
export function addressIsActors(actor: string, address: string | undefined): boolean {
  if (!address) return false;
  const pubkey = sphinxAddressPubkey(address);
  const m = /^secp:([0-9a-f]{64})$/.exec(actor);
  return !!pubkey && !!m && pubkey.slice(2) === m[1];
}

const sats = (msat: number) => `${(msat / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} sats`;

/** The wallet's balance in msat, or undefined when it cannot be read in time. */
export async function walletBalanceMsat(lightning: LightningCapability | null, ms: number): Promise<number | undefined> {
  if (!lightning) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const b = await Promise.race([
      lightning.balance(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer")), ms);
      }),
    ]);
    return Number.isSafeInteger(b?.msat) && b.msat >= 0 ? b.msat : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function createPayouts(deps: PayoutsDeps): Payouts {
  const now = deps.now ?? Date.now;
  const balanceMs = deps.balanceMs ?? PAYOUT_BALANCE_MS;
  const newKey = deps.key ?? (() => randomBytes(32).toString("hex"));
  const stale = (p: Pick<Payout, "state" | "at">) => p.state === "out" && now() - p.at > KEYSEND_STALE_MS;
  const listed = (p: Payout): PayoutListed => ({ ...p, stale: stale(p) });
  const outOf = (p: Payout): PayoutOut => ({ key: p.key, msat: p.msat, maxFeeMsat: p.maxFeeMsat, at: p.at, stale: stale(p) });
  const settings = async () => {
    const l = await deps.ledgerIfAny();
    return l ? l.payoutSettings() : { ...DEFAULT_PAYOUT_SETTINGS };
  };

  const refusal = (reason: PayoutRefusal, o: { msat: number; maxFeeMsat: number; maxMsat: number; settings: PayoutSettings; out?: Payout }): PayoutError => {
    const max = o.maxMsat > 0 ? ` You may ask for at most ${sats(o.maxMsat)} now (maxMsat ${o.maxMsat}).` : "";
    const out = o.out ? outOf(o.out) : undefined;
    const said: Record<PayoutRefusal, string> = {
      payouts_off: "withdrawing is turned off on this server",
      below_minimum: `the least one withdrawal may ask is ${sats(o.settings.minSats * 1000)}.${max}`,
      payout_out: `your withdrawal of ${sats(out?.msat ?? 0)} (payout ${out?.key ?? "?"}) is still on its way: one at a time${out?.stale ? "; it waits for staff to look at it" : ""}`,
      over_balance: `${sats(o.msat)} and a fee of up to ${sats(o.maxFeeMsat)} is more than you may withdraw now.${max}`,
      over_worker_day: `that is over what one worker may withdraw in a day here.${max}`,
      over_server_day: `that is over what this server pays workers in a day.${max}`,
    };
    return new PayoutError(reason, said[reason], { ...(reason !== "payout_out" && reason !== "payouts_off" ? { maxMsat: o.maxMsat } : {}), ...(out ? { out } : {}) });
  };

  const answerOf = (a: WithdrawAnswer, o: { key: string; msat: number; maxFeeMsat: number }): PayoutAnswer => ({
    state: a.state,
    key: o.key,
    msat: o.msat,
    feeMsat: a.state === "settled" ? Math.min(a.feeMsat, o.maxFeeMsat) : 0,
    maxFeeMsat: o.maxFeeMsat,
    ...(a.error && a.state !== "settled" ? { error: a.error } : {}),
  });

  const api: Payouts = {
    async pay(actor, o) {
      const msat = o?.msat;
      if (!Number.isSafeInteger(msat) || msat <= 0) throw new PayoutError("bad_request", "msat, what you receive, is a whole number of msat above 0");
      // 1. Where it goes: the session's address, the actor's own.
      if (!addressIsActors(actor, o.address)) {
        throw new PayoutError(
          "no_address",
          o.address
            ? "the Sphinx address your sign-in gave is not your sign-in key's: sign in again with your Sphinx account"
            : "your sign-in gave no Sphinx address to pay: sign in with Peel (your Sphinx account) to withdraw",
        );
      }
      const address = o.address!.trim().toLowerCase();
      // 2. The switch, and a wallet that can keysend.
      if (!(await settings()).on) throw new PayoutError("payouts_off", "withdrawing is turned off on this server");
      const payer = await deps.payer();
      if (!payer) throw new PayoutError("no_pay_credential", "this server's wallet has no pay credential: it cannot pay out");
      if (!payer.keysend) throw new PayoutError("no_keysend", "this server's wallet cannot pay a Sphinx address (an NWC wallet takes no route hints)");
      // 3. Solvency: the wallet holds what every worker is owed.
      const ledger = await deps.ledger();
      const at = now();
      const balance = await walletBalanceMsat(deps.lightning(), balanceMs);
      if (balance === undefined) throw new PayoutError("wallet_unavailable", "this server's wallet did not say what it holds: nothing is paid while that is not known");
      const owed = await ledger.owedToWorkers({ now: at });
      if (balance < owed.owedMsat) {
        throw new PayoutError("wallet_short", "this server's wallet holds less than its workers are owed: withdrawals wait until it is topped up");
      }
      // 4. The reserve: the switch again, the minimum, one on its way, the
      // balance, the day's caps — and the payout is out of the balance.
      const maxFeeMsat = defaultMaxFeeMsat(msat);
      const key = newKey();
      const r = await ledger.reservePayout({ key, worker: actor, address, msat, maxFeeMsat, at });
      if (!r.ok) throw refusal(r.reason, { msat, maxFeeMsat, maxMsat: r.maxMsat, settings: r.settings, ...(r.out ? { out: r.out } : {}) });
      try {
        return answerOf(await deps.withdrawals.keysend({ key, address, msat, maxFeeMsat, actor }), { key, msat, maxFeeMsat });
      } catch (err) {
        if (!(err instanceof WithdrawError)) throw err;
        if (err.code === "no_keysend" || err.code === "no_pay_credential") throw new PayoutError(err.code, err.message.replace(/^[a-z_]+: /, ""));
        // Refused before it went: failed, its reserve back. Anything else may
        // have gone: on its way until the minute's check reads it.
        const p = await ledger.payoutOf(key);
        return { state: p?.state === "out" ? "pending" : "failed", key, msat, feeMsat: 0, maxFeeMsat, error: err.message };
      }
    },

    async view(actor, o) {
      const ledger = await deps.ledgerIfAny();
      const s = ledger ? await ledger.payoutSettings() : { ...DEFAULT_PAYOUT_SETTINGS };
      const at = now();
      const [open, today] = ledger
        ? await Promise.all([ledger.payouts({ worker: actor, state: "out", limit: 1 }), ledger.payoutsToday({ now: at, worker: actor })])
        : [[], { paidMsat: 0, outMsat: 0, workerMsat: 0 }];
      const out = open[0] ? outOf(open[0]) : undefined;
      const minMsat = s.minSats * 1000;
      const dayLeftMsat = Math.max(0, s.workerDaySats * 1000 - (today.workerMsat ?? 0));
      const serverLeftMsat = Math.max(0, s.serverDaySats * 1000 - today.paidMsat - today.outMsat);
      const payer = await deps.payer().catch(() => null);
      const why: PayoutView["why"] = !addressIsActors(actor, o.address) ? "no_address" : !s.on ? "off" : !payer ? "no_wallet" : !payer.keysend ? "no_keysend" : undefined;
      const maxMsat = !why && !out ? payoutMaxMsat({ withdrawableMsat: o.balance.withdrawableMsat, workerLeftMsat: dayLeftMsat, serverLeftMsat, minMsat }) : 0;
      return { on: !why, ...(why ? { why } : {}), minMsat, dayLeftMsat, maxMsat, ...(out ? { out } : {}) };
    },

    settings,

    async saveSettings(input, by) {
      return (await deps.ledger()).setPayoutSettings({ on: input.on, minSats: input.minSats, workerDaySats: input.workerDaySats, serverDaySats: input.serverDaySats, ...(by ? { by } : {}), at: now() });
    },

    async list(q = {}) {
      const ledger = await deps.ledgerIfAny();
      const s = ledger ? await ledger.payoutSettings() : { ...DEFAULT_PAYOUT_SETTINGS };
      const t = ledger ? await ledger.payoutsToday({ now: now() }) : { day: new Date(now()).toISOString().slice(0, 10), paidMsat: 0, outMsat: 0, count: 0 };
      const today = { day: t.day, paidMsat: t.paidMsat, outMsat: t.outMsat, count: t.count, serverLeftMsat: Math.max(0, s.serverDaySats * 1000 - t.paidMsat - t.outMsat) };
      if (!ledger) return { settings: s, today, payouts: [] };
      const { state, ...rest } = q;
      let payouts: Payout[];
      if (state === "stale") {
        // Every stale one is out: the out list, a page at a time, filtered.
        payouts = (await ledger.payouts({ ...rest, state: "out", limit: 500 })).filter((p) => stale(p)).slice(0, rest.limit ?? 50);
      } else {
        payouts = await ledger.payouts({ ...rest, ...(state ? { state } : {}) });
      }
      return { settings: s, today, payouts: payouts.map(listed) };
    },

    async read(key) {
      const ledger = await deps.ledgerIfAny();
      const p = ledger ? await ledger.payoutOf(key) : undefined;
      if (!ledger || !p) throw new PayoutError("unknown_payout", `no payout ${key}`);
      const answer = await deps.withdrawals.read(key);
      return { payout: listed((await ledger.payoutOf(key))!), answer };
    },

    async resolve(key, o, by) {
      const ledger = await deps.ledgerIfAny();
      const p = ledger ? await ledger.payoutOf(key) : undefined;
      if (!ledger || !p) throw new PayoutError("unknown_payout", `no payout ${key}`);
      const r = await deps.withdrawals.resolve(key, { action: o.action, ...(o.feeMsat !== undefined ? { feeMsat: o.feeMsat } : {}), ...(by ? { actor: by } : {}) });
      return { payout: listed((await ledger.payoutOf(key))!), action: r.action };
    },

    async sweep() {
      const ledger = await deps.ledgerIfAny();
      if (!ledger) return 0;
      const out = await ledger.payouts({ state: "out", limit: 500 });
      if (!out.length) return 0;
      const pending = new Set((await deps.withdrawals.pending()).map((p) => p.paymentHash));
      let failed = 0;
      for (const p of out) {
        if (pending.has(p.key) || now() - p.at < ORPHAN_AFTER_MS) continue;
        await ledger.payoutFailed({ key: p.key, why: "never sent: the server stopped between the reserve and the send", at: now() });
        failed++;
      }
      return failed;
    },
  };
  return api;
}
