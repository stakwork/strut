/**
 * EARNINGS as a person reads them (plans/paid-runs.md §8, decision 27): what
 * `GET /earnings` answers and the `earnings/read` step returns, one copy.
 *
 * Earned and cost are DOLLARS, so a margin is their difference. Every number
 * comes from the ledger's rollups (`daily`, and the payment and withdrawal
 * entries through their partial indexes), never from scanning entries:
 * earned, cost, margin, calls and failed by item, day, package or in total;
 * outstanding credit; received, added and withdrawn by day. With `wallet`,
 * the wallet's balance in sats and at the rate of the moment, beside what the
 * books say it should hold: everything received and added by hand, less
 * everything withdrawn and the fees those paid.
 *
 * A package's number is this server's. For a package PUBLISHED here, its
 * items carry their bare local names (plans/packages-ux.md), so it is the sum
 * over the subjects its newest release holds; for one INSTALLED here, the
 * subjects under its prefix (`deps.packageSubjects` decides which).
 *
 * What WORKERS are owed (plans/human-steps.md §8.1, "The books"): a debt in
 * sats beside the credit owed as service, which is in dollars. Read from the
 * ledger's `payees` and `pay_daily`, in the unscoped view only. With the
 * wallet, its COVER: the balance less what workers are owed, below 0 when
 * the wallet is short. No sats move for it, so the books check
 * (`expectedMsat`) does not change.
 */

import type { LightningCapability } from "./lightning.js";
import type { LedgerStore, Micros, PayDailyRow } from "./ledger.js";
import { microsToUsd, ZERO_OWED } from "./ledger.js";
import type { WalletInfo } from "./settings.js";
import type { PendingView } from "./withdrawals.js";

export type EarningsBy = "item" | "day" | "package" | "total";
export const EARNINGS_BY: readonly EarningsBy[] = ["item", "day", "package", "total"];

export interface EarningsQuery {
  /** Inclusive UTC days, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  by?: EarningsBy;
  /** Only the subjects under this package prefix (`acme/voxel`). */
  prefix?: string;
  /** One package's items, whichever way it is here: published (the
   *  subjects its newest release holds) or installed (its prefix). */
  package?: string;
  /** Read the wallet's balance too (a call to the wallet). */
  wallet?: boolean;
}

/** An item's price in the Public view record, in dollars. */
export interface PriceView {
  base: number;
  markup: number;
  capUsd?: number;
  dailyCapUsd?: number;
}

export interface EarningsRowView {
  /** A subject (`workflow:<name>`, `step:<type>`, `expired`), a day, a
   *  package prefix, or `total`. */
  key: string;
  calls: number;
  failed: number;
  /** Dollars. */
  earned: number;
  cost: number;
  margin: number;
  /** An item runnable now: its price. */
  price?: PriceView;
}

export interface WalletView extends WalletInfo {
  /** What the wallet says it holds now. */
  balance?: { msat: number; sats: number; usd?: number };
  /** The rate the balance is shown at, dollars per bitcoin. */
  rate?: number;
  /** Why the balance could not be read. */
  error?: string;
  /** What the books say the wallet should hold: received and added by hand
   *  (deposits), less every send (withdrawals and purchases) and its fees,
   *  less what is still out (`pendingMsat`), all time. More in the wallet is money that came some
   *  other way (or a paid invoice whose token was never used); less is money
   *  that left it some other way. */
  expectedMsat: number;
  /** Sends still out (pending), counted as gone: a wallet keeps the debit. */
  pendingMsat: number;
  /** balance − expected, when the balance was read. */
  differenceMsat?: number;
  /** What workers are owed now, held and withdrawable both
   *  (plans/human-steps.md §8.1): sats this wallet must hold for them. */
  owedToWorkersMsat: number;
  /** balance − owed to workers, when the balance was read: below 0, the
   *  wallet is short of what workers are owed. */
  coverMsat?: number;
}

/** What workers are owed for accepted answers (plans/human-steps.md §8.1):
 *  sats, never dollars. */
export interface WorkersView {
  /** Now, not ranged: earned, less taken back, less withdrawn. */
  owedMsat: number;
  /** Of which still in its hold. */
  heldMsat: number;
  /** owed − held: what workers may withdraw (item 5b). */
  withdrawableMsat: number;
  /** Workers with a balance. */
  payees: number;
  /** Answers accepted in the range, and the sats they earned — a later
   *  take-back included — by UTC day, each day with what of it was taken
   *  back since. */
  accepted: { answers: number; msat: number; days: Array<{ day: string; answers: number; msat: number; takenBackAnswers: number; takenBackMsat: number }> };
  /** Of the range's answers, those taken back. */
  takenBack: { answers: number; msat: number };
}

export interface EarningsView {
  from?: string;
  to?: string;
  by: EarningsBy;
  prefix?: string;
  /** `package=`: how its items were found — the newest release published
   *  here (`release`, its version), or its prefix (`prefix`). */
  package?: { name: string; via: "release" | "prefix"; version?: string };
  totals: Omit<EarningsRowView, "key" | "price">;
  rows: EarningsRowView[];
  /** Paid for and not yet charged: still owed as service. Now, not ranged. */
  outstanding: { tokens: number; usd: number; held: number };
  /** What workers are owed (plans/human-steps.md §8.1). Not in a view
   *  scoped to a package or a prefix: it is the wallet's, not a package's. */
  workers?: WorkersView;
  /** Sats paid in, in the range, with the dollars they were credited as. */
  received: { count: number; msat: number; usd: number; days: Array<{ day: string; count: number; msat: number; usd: number }> };
  /** Sats an admin added to the wallet by hand (Add sats), in the range:
   *  never credit, never earnings. */
  deposited: { count: number; msat: number; days: Array<{ day: string; count: number; msat: number }> };
  /** Sats a person withdrew through strut, in the range. */
  withdrawn: { count: number; msat: number; feeMsat: number; days: Array<{ day: string; count: number; msat: number; feeMsat: number }> };
  /** Sats this strut paid other struts for credit (item 9), in the range. */
  purchases: { count: number; msat: number; feeMsat: number };
  /** Sends out and not yet settled or failed. */
  pending: PendingView[];
  wallet?: WalletView;
}

export interface EarningsDeps {
  /** The ledger, or null when this strut never opened one (it sold nothing):
   *  every number is then 0, and no file is made. */
  ledger: () => Promise<LedgerStore | null>;
  /** Runnable items now, for each row's price. */
  runnable?: () => Promise<Array<{ kind: "workflow" | "step"; name: string; base?: number; markup?: number; capUsd?: number; dailyCapUsd?: number }>>;
  pending?: () => Promise<PendingView[]>;
  /** A package's subjects: those its newest release published here holds,
   *  or null when it was not published here (then its prefix is read). */
  packageSubjects?: (pkg: string) => Promise<{ subjects: string[]; version: string } | null>;
  /** What `GET /earnings/wallet` answers. */
  walletInfo?: () => Promise<WalletInfo>;
  lightning?: () => LightningCapability | null;
  /** Dollars per bitcoin now. */
  usdPerBtc?: () => Promise<number>;
  /** Records the deposits that settled since they were last read, before
   *  the books are read beside the wallet (`deposits.check()`). */
  settleDeposits?: () => Promise<unknown>;
  /** How long the balance is waited on. */
  balanceMs?: number;
  /** The clock a worker's earning is held by: the task store's. */
  now?: () => number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Checks a query from a route or a step: throws a sentence. */
export function checkEarningsQuery(q: Record<string, unknown>): EarningsQuery {
  const out: EarningsQuery = {};
  for (const k of ["from", "to"] as const) {
    const v = q[k];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`${k} must be a UTC day, YYYY-MM-DD`);
    out[k] = v;
  }
  if (out.from && out.to && out.from > out.to) throw new Error("from is after to");
  const by = q["by"];
  if (by !== undefined && by !== "") {
    if (!EARNINGS_BY.includes(by as EarningsBy)) throw new Error(`by must be one of ${EARNINGS_BY.join(", ")}`);
    out.by = by as EarningsBy;
  }
  for (const k of ["prefix", "package"] as const) {
    const v = q[k];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || !/^[^\s:]+\/[^\s:]+$/.test(v) || v.endsWith("/")) throw new Error(`${k} is a package: publisher/name`);
    out[k] = v;
  }
  if (out.prefix && out.package) throw new Error("give prefix or package, not both");
  if (q["wallet"] === true || q["wallet"] === "1" || q["wallet"] === "true") out.wallet = true;
  return out;
}

/** The day `days` days back from `now`, counting today: `daysBack(7)` is the
 *  first of the last seven days. */
export function daysBack(days: number, now = Date.now()): string {
  const n = Math.max(1, Math.floor(days));
  return new Date(now - (n - 1) * 86_400_000).toISOString().slice(0, 10);
}

const usd = (m: Micros) => microsToUsd(m);
const subjectOf = (r: { kind: "workflow" | "step"; name: string }) => `${r.kind}:${r.name}`;

async function readBalance(lightning: LightningCapability | null | undefined, ms: number): Promise<{ msat: number } | { error: string }> {
  if (!lightning) return { error: "no wallet is set" };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lightning.balance(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`wallet_unavailable: no answer in ${ms / 1000} s`)), ms);
      }),
    ]);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** By item, every item runnable now has a row, a new one with nothing yet,
 *  so its price shows beside the rest. */
function withRunnable<R extends { key: string; calls: number; failed: number; earned: Micros; cost: Micros }>(
  rows: R[],
  runnable: Array<{ kind: "workflow" | "step"; name: string }>,
  prefix?: string,
  subjects?: readonly string[],
): Array<R | { key: string; calls: number; failed: number; earned: Micros; cost: Micros }> {
  const have = new Set(rows.map((r) => r.key));
  const missing = runnable
    .filter((r) => !have.has(subjectOf(r)) && (!prefix || r.name.startsWith(`${prefix}/`)) && (!subjects || subjects.includes(subjectOf(r))))
    .map((r) => ({ key: subjectOf(r), calls: 0, failed: 0, earned: 0, cost: 0 }));
  return [...rows, ...missing].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function readEarnings(deps: EarningsDeps, q: EarningsQuery = {}): Promise<EarningsView> {
  const by = q.by ?? "item";
  const range = { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) };
  const ledger = await deps.ledger();
  // A package: its release's subjects when it was published here, else its prefix.
  const published = q.package && deps.packageSubjects ? await deps.packageSubjects(q.package) : null;
  const prefix = q.prefix ?? (q.package && !published ? q.package : undefined);
  const subjects = published?.subjects;
  const scoped = !!(prefix || subjects);
  const filter = { ...(prefix ? { prefix } : {}), ...(subjects ? { subjects } : {}) };
  if (q.wallet && deps.settleDeposits) await deps.settleDeposits().catch(() => {});
  const now = deps.now?.() ?? Date.now();
  const [rows, total, outstanding, received, sends, runnable, pending, deposited, payDays, owed] = await Promise.all([
    ledger ? ledger.earnings({ by, ...range, ...filter }) : Promise.resolve([]),
    ledger ? ledger.earnings({ by: "total", ...range, ...filter }) : Promise.resolve([]),
    ledger ? ledger.outstanding() : Promise.resolve({ tokens: 0, usd: 0, held: 0 }),
    ledger && !scoped ? ledger.received(range) : Promise.resolve([]),
    ledger && !scoped ? ledger.withdrawn(range) : Promise.resolve([]),
    deps.runnable ? deps.runnable().catch(() => []) : Promise.resolve([]),
    deps.pending && !scoped ? deps.pending() : Promise.resolve([]),
    ledger && !scoped ? ledger.deposited(range) : Promise.resolve([]),
    ledger && !scoped ? ledger.payDaily(range) : Promise.resolve([]),
    // What workers are owed is the whole wallet's: read for the unscoped
    // view, and for the wallet's cover whatever the scope.
    ledger && (!scoped || q.wallet) ? ledger.owedToWorkers({ now }) : Promise.resolve({ ...ZERO_OWED }),
  ]);
  const withdrawn = sends.filter((r) => r.purpose === "withdrawal");
  const purchased = sends.filter((r) => r.purpose === "purchase");
  const prices = new Map(runnable.map((r) => [subjectOf(r), r]));
  const view = (r: { key: string; calls: number; failed: number; earned: Micros; cost: Micros }) => ({
    calls: r.calls,
    failed: r.failed,
    earned: usd(r.earned),
    cost: usd(r.cost),
    margin: usd(r.earned - r.cost),
  });
  const t = total[0] ?? { key: "total", calls: 0, failed: 0, earned: 0, cost: 0 };
  const out: EarningsView = {
    ...range,
    by,
    ...(q.prefix ? { prefix: q.prefix } : {}),
    ...(q.package ? { package: { name: q.package, via: published ? ("release" as const) : ("prefix" as const), ...(published ? { version: published.version } : {}) } } : {}),
    totals: view(t),
    rows: (by === "item" ? withRunnable(rows, runnable, prefix, subjects) : rows).map((r) => {
      const p = by === "item" ? prices.get(r.key) : undefined;
      return {
        key: r.key,
        ...view(r),
        ...(p ? { price: { base: p.base ?? 0, markup: p.markup ?? 0, ...(p.capUsd !== undefined ? { capUsd: p.capUsd } : {}), ...(p.dailyCapUsd !== undefined ? { dailyCapUsd: p.dailyCapUsd } : {}) } } : {}),
      };
    }),
    outstanding: { tokens: outstanding.tokens, usd: usd(outstanding.usd), held: usd(outstanding.held) },
    ...(scoped ? {} : { workers: workersView(owed, payDays) }),
    received: {
      count: received.reduce((n, r) => n + r.count, 0),
      msat: received.reduce((n, r) => n + r.msat, 0),
      usd: usd(received.reduce((n, r) => n + r.usd, 0)),
      days: received.map((r) => ({ day: r.day, count: r.count, msat: r.msat, usd: usd(r.usd) })),
    },
    deposited: {
      count: deposited.reduce((n, r) => n + r.count, 0),
      msat: deposited.reduce((n, r) => n + r.msat, 0),
      days: deposited,
    },
    withdrawn: {
      count: withdrawn.reduce((n, r) => n + r.count, 0),
      msat: withdrawn.reduce((n, r) => n + r.msat, 0),
      feeMsat: withdrawn.reduce((n, r) => n + r.feeMsat, 0),
      days: withdrawn.map(({ purpose: _p, ...d }) => d),
    },
    purchases: {
      count: purchased.reduce((n, r) => n + r.count, 0),
      msat: purchased.reduce((n, r) => n + r.msat, 0),
      feeMsat: purchased.reduce((n, r) => n + r.feeMsat, 0),
    },
    pending,
  };
  if (!q.wallet) return out;

  // The wallet, beside the books: everything received and added by hand,
  // less every send and its fees, and less what is still out, all time.
  const [info, lifeIn, lifeAdded, lifeOut, rate, balance, allPending] = await Promise.all([
    deps.walletInfo ? deps.walletInfo() : Promise.resolve({ provider: null, receive: false, pay: false } as WalletInfo),
    ledger ? ledger.received() : Promise.resolve([]),
    ledger ? ledger.deposited() : Promise.resolve([]),
    ledger ? ledger.withdrawn() : Promise.resolve([]),
    deps.usdPerBtc ? deps.usdPerBtc().catch(() => undefined) : Promise.resolve(undefined),
    readBalance(deps.lightning?.(), deps.balanceMs ?? 5_000),
    scoped && deps.pending ? deps.pending() : Promise.resolve(pending),
  ]);
  const pendingMsat = allPending.reduce((n, p) => n + p.msat, 0);
  const expectedMsat =
    lifeIn.reduce((n, r) => n + r.msat, 0) + lifeAdded.reduce((n, r) => n + r.msat, 0) - lifeOut.reduce((n, r) => n + r.msat + r.feeMsat, 0) - pendingMsat;
  const wallet: WalletView = { ...info, expectedMsat, pendingMsat, ...(rate ? { rate } : {}), owedToWorkersMsat: owed.owedMsat };
  if ("msat" in balance) {
    wallet.balance = { msat: balance.msat, sats: Math.floor(balance.msat / 1000), ...(rate ? { usd: Math.round((balance.msat / 1000 / 100_000_000) * rate * 100) / 100 } : {}) };
    wallet.differenceMsat = balance.msat - expectedMsat;
    wallet.coverMsat = balance.msat - owed.owedMsat;
  } else wallet.error = balance.error;
  return { ...out, wallet };
}

/** `pay_daily`'s rows in the range, by day (every task type summed), and
 *  what workers are owed now. */
function workersView(owed: { owedMsat: number; heldMsat: number; withdrawableMsat: number; payees: number }, rows: PayDailyRow[]): WorkersView {
  const days = new Map<string, WorkersView["accepted"]["days"][number]>();
  for (const r of rows) {
    const d = days.get(r.day) ?? { day: r.day, answers: 0, msat: 0, takenBackAnswers: 0, takenBackMsat: 0 };
    d.answers += r.answers;
    d.msat += r.msat;
    d.takenBackAnswers += r.takenBackAnswers;
    d.takenBackMsat += r.takenBackMsat;
    days.set(r.day, d);
  }
  const list = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const sum = (k: "answers" | "msat" | "takenBackAnswers" | "takenBackMsat") => list.reduce((n, d) => n + d[k], 0);
  return {
    owedMsat: owed.owedMsat,
    heldMsat: owed.heldMsat,
    withdrawableMsat: owed.withdrawableMsat,
    payees: owed.payees,
    accepted: { answers: sum("answers"), msat: sum("msat"), days: list },
    takenBack: { answers: sum("takenBackAnswers"), msat: sum("takenBackMsat") },
  };
}
