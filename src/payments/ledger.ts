/**
 * The paid-runs LEDGER (plans/paid-runs.md §5): what a buyer's credit token
 * holds and what every public run was charged. One SQLite file on
 * `node:sqlite` (`ledger-sqlite.ts`, `<dataDir>/payments/ledger.db`) and a
 * memory twin for tests (`ledger-memory.ts`), behind `LedgerStore`.
 *
 * Money is DOLLARS kept as whole MICRO-dollars (decision 22). Sats appear
 * only where the wallet does, in msat, on a `payment` and a `withdrawal`. A
 * token keeps the rate it was bought at, for showing its balance in sats.
 *
 * Three tables:
 * - `tokens`, one row per credit token. `paid` is credit IN (its payment, and
 *   what it inherited), `spent` credit OUT (charges, and what it handed on
 *   or lost to expiry), `held` the reserves of its runs in flight; `free` is
 *   paid − spent − held. On a live token `spent` is what it was charged.
 * - `entries`, append-only, never updated: `payment`, `hold`, `charge`,
 *   `carry`, `expiry`, `withdrawal`. `usd` is the entry's amount (≥ 0), but
 *   on a `carry`, whose sign says which way it went: − on the token it left,
 *   + on the token it reached, `ref` the other token.
 * - `daily`, one row per UTC day and subject: calls, failed, earned, cost.
 *   Every earnings read is a sum over it, never over `entries`.
 *
 * And `deposits`, one row per payment hash: sats an admin paid into the
 * wallet by hand (Earnings' Add sats, `src/payments/deposits.ts`). Never
 * credit on a token, never earnings: only the books check counts them, as
 * money the wallet should hold. A table of its own, added beside the rest
 * (`create table if not exists`), so a ledger file from before it opens
 * unchanged and a strut from before it still opens a file that has it.
 *
 * And WORKER PAY (plans/human-steps.md §8.1), three tables of their own
 * added the same way: what an accepted answer of a paid task type earned
 * its worker, in SATS (msat), never dollars. `pay` is one row per answer
 * (its lease), written once and changed only by a take-back, once; `payees`
 * one row per worker, what they were credited, taken back and withdrawn;
 * `pay_daily` one row per UTC day and task type, what every read of pay
 * over time sums. An earning is HELD until its `releases` and withdrawable
 * from then — computed on every read, never swept. Worker pay never enters
 * `daily`: there "earned" is what this server sold.
 *
 * A SUBJECT is `workflow:<name>`, `step:<type>`, or `expired` (credit that
 * reached its year unused, earned by the seller). A package's earnings are
 * the subjects under its prefix.
 *
 * The PRICING RULE is here too, pure (decision 8): charge = base + markup ×
 * cost, and the reserve a run needs is base + markup × its cap (decision
 * 21). Items 3, 5 and 6 share this one copy.
 */
import { join } from "node:path";
import { packagePrefixOf } from "../package-lookup.js";

/** Whole micro-dollars. */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;
/** Credit lasts a year from its purchase (decision 18). */
export const CREDIT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** The subject credit that reached its year unused is earned under. */
export const EXPIRED_SUBJECT = "expired";
/** A token's entries are read a page at a time, newest first. */
export const ENTRIES_PAGE = 50;
export const ENTRIES_PAGE_MAX = 500;
/** What `recent` sums: the last 30 days (§2, decision 25). */
export const RECENT_DAYS = 30;

// ── Units ───────────────────────────────────────────────────────────────

/** Dollars → whole micro-dollars. Refuses a negative or non-finite amount. */
export function usdToMicros(usd: number): Micros {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`not an amount of dollars: ${usd}`);
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: Micros): number {
  return micros / MICROS_PER_USD;
}

// ── The pricing rule ────────────────────────────────────────────────────

/** An item's price: a base per run or call, and a markup on what it cost. */
export interface Price {
  base: Micros;
  /** Times what the run cost; 1 charges exactly the cost. */
  markup: number;
}

export const FREE: Price = { base: 0, markup: 0 };

/** The Public view record's dollars (`PublicRunnable.base`, `.markup`) as a Price. */
export function priceOf(o: { base?: number; markup?: number }): Price {
  const markup = o.markup ?? 0;
  if (!Number.isFinite(markup) || markup < 0) throw new RangeError(`not a markup: ${markup}`);
  return { base: usdToMicros(o.base ?? 0), markup };
}

export function isFree(price: Price): boolean {
  return price.base === 0 && price.markup === 0;
}

/** How a run ended, as `RunSummary.status` says it. */
export type RunOutcome = "success" | "error" | "cancelled";

/**
 * The most a run could be charged: base + markup × its cap (decision 21).
 * Rounded as `chargeFor` rounds, so a run whose cost stays within its cap
 * is never charged more than its reserve.
 */
export function reserveFor(price: Price, cap: Micros): Micros {
  return price.base + Math.round(price.markup * nonNegative(cap));
}

/**
 * What a run is charged (decision 8): base + markup × cost. A run that
 * FAILED is charged its cost, with no markup and no base, and never more
 * than its reserve (decision 24); one that succeeded or was cancelled, the
 * rule. What the token cannot cover is the ledger's to clamp, not this.
 */
export function chargeFor(price: Price, cost: Micros, outcome: RunOutcome, reserve?: Micros): Micros {
  const c = nonNegative(cost);
  if (outcome === "error") return reserve === undefined ? c : Math.min(c, nonNegative(reserve));
  return price.base + Math.round(price.markup * c);
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── The store ───────────────────────────────────────────────────────────

export interface TokenBalance {
  id: string;
  paymentHash: string;
  /** Credit in: its payment, and what it inherited. */
  paid: Micros;
  /** Credit out: charges, and what it handed on or lost to expiry. */
  spent: Micros;
  /** The reserves of its runs in flight. */
  held: Micros;
  /** paid − spent − held: what a launch may set aside. */
  free: Micros;
  /** Dollars per bitcoin it was bought at. */
  rate: number;
  /** What its invoice settled for. */
  msat: number;
  /** Epoch ms. */
  created: number;
  expires: number;
  /** When the expiry sweep closed it. */
  closed?: number;
  /** The token its credit moved to (§4.5); a token with one is refused. */
  successor?: string;
}

export type EntryKind = "payment" | "hold" | "charge" | "carry" | "expiry" | "withdrawal";

export interface LedgerEntry {
  seq: number;
  /** Epoch ms. */
  at: number;
  kind: EntryKind;
  token?: string;
  /** payment: credited. hold: the reserve. charge: what was charged.
   *  carry: moved (− out, + in). expiry: what was left. withdrawal: the
   *  dollars at the moment, when given. */
  usd?: Micros;
  /** payment: settled. withdrawal: paid out. */
  msat?: number;
  subject?: string;
  runId?: string;
  /** A launch's retry key (hold). */
  key?: string;
  /** payment and withdrawal: the payment hash. carry: the other token. */
  ref?: string;
  /** charge: what the run cost. */
  cost?: Micros;
  /** charge: how the run ended. */
  outcome?: RunOutcome;
  /** withdrawal: the routing fee. */
  feeMsat?: number;
  /** withdrawal: who asked. */
  actor?: string;
}

/** A token's first use (§4.3 step 4): the wallet said its invoice settled. */
export interface FirstUseInput {
  id: string;
  paymentHash: string;
  /** What the invoice asked: `strut_sats` × 1000. */
  askedMsat: number;
  /** What the wallet says was settled. */
  settledMsat: number;
  /** `strut_credit`: what the asked sats buy, the locked quote. */
  credit: Micros;
  /** Dollars per bitcoin of the quote. */
  rate: number;
  /** `strut_valid_until`, epoch ms. */
  expires: number;
  /** `strut_carry`: the token whose free credit this one inherits (§4.5). */
  carryFrom?: string;
  at?: number;
}

export interface FirstUseResult {
  token: TokenBalance;
  /** false: the token was already in the ledger; nothing was written. */
  created: boolean;
  /** What its payment bought. */
  credited: Micros;
  /** What it inherited. */
  carried: Micros;
}

export interface HoldInput {
  token: string;
  reserve: Micros;
  subject: string;
  /** Minted before the launch, so the hold names its run. */
  runId: string;
  /** A retry key: the same token and key return the first hold (and so
   *  does the same token and run id). */
  key?: string;
  at?: number;
}

export type HoldRefusal = "unknown" | "closed" | "expired" | "carried" | "short";

export type HoldResult =
  | { ok: true; seq: number; runId: string; reserve: Micros; subject: string; existing: boolean }
  | { ok: false; reason: HoldRefusal; free: Micros; successor?: string };

export interface ChargeInput {
  runId: string;
  subject: string;
  /** None: a free run, charged nothing and counted in `daily`. */
  token?: string;
  /** What the run cost. */
  cost: Micros;
  outcome: RunOutcome;
  price: Price;
  at?: number;
}

export interface ChargeResult {
  seq: number;
  /** What the token was charged. */
  charged: Micros;
  /** What the rule asked; `due − charged` is the seller's. */
  due: Micros;
  /** The reserve the charge freed; 0 for a free run. */
  reserve: Micros;
  /** false: this run was already charged; nothing was written. */
  existing: boolean;
  /** Freed credit that moved to the token's successor. */
  carried?: { to: string; usd: Micros };
  /** Freed credit lost to the token's expiry. */
  expired?: Micros;
}

export interface OpenHold {
  seq: number;
  at: number;
  token: string;
  runId: string;
  subject: string;
  reserve: Micros;
  key?: string;
}

/** What a payment OUT of the wallet was for: a person's withdrawal, or
 *  credit this strut bought from another (item 9, `remote/buy-credit`). The
 *  books check counts every one; Earnings shows each apart. */
export type SendPurpose = "withdrawal" | "purchase";
export const SEND_PURPOSES: readonly SendPurpose[] = ["withdrawal", "purchase"];

export interface WithdrawalInput {
  msat: number;
  /** The fee the wallet was charged. */
  feeMsat?: number;
  paymentHash: string;
  actor?: string;
  /** What it was for (kept in the entry's `subject`); `withdrawal` when left out. */
  purpose?: SendPurpose;
  /** The dollars at the moment, for the books. */
  usd?: Micros;
  at?: number;
}

/** Sats an admin paid into the wallet (§9's books): one per payment hash. */
export interface DepositInput {
  /** What settled. */
  msat: number;
  paymentHash: string;
  /** Who asked for the invoice. */
  actor?: string;
  /** When it settled, epoch ms. */
  at?: number;
}

export interface Deposit {
  /** Epoch ms, when it settled. */
  at: number;
  msat: number;
  paymentHash: string;
  actor?: string;
}

export interface DepositedRow {
  day: string;
  count: number;
  msat: number;
}

export interface EntryListQuery {
  kind?: EntryKind;
  runId?: string;
  /** A seq: entries before it. */
  before?: number;
  limit?: number;
}

export interface EarningsRow {
  /** A subject, a day (`YYYY-MM-DD`), a package prefix, or `total`. */
  key: string;
  calls: number;
  failed: number;
  earned: Micros;
  cost: Micros;
}

/** Inclusive UTC days, `YYYY-MM-DD`. */
export interface DayRange {
  from?: string;
  to?: string;
}

export interface EarningsQuery extends DayRange {
  by: "item" | "day" | "package" | "total";
  /** Only the subjects under this package prefix (`acme/voxel`). */
  prefix?: string;
  /** Only these subjects (`workflow:<name>`, `step:<type>`): a package
   *  published here, whose items carry their bare local names. */
  subjects?: readonly string[];
}

export interface ReceivedRow {
  day: string;
  count: number;
  msat: number;
  usd: Micros;
}

export interface WithdrawnRow {
  day: string;
  purpose: SendPurpose;
  count: number;
  msat: number;
  feeMsat: number;
}

export interface Outstanding {
  /** Open tokens. */
  tokens: number;
  /** Paid for and not yet charged: still owed as service. */
  usd: Micros;
  /** Of which set aside for runs in flight. */
  held: Micros;
}

export interface Recent {
  days: number;
  runs: number;
  failed: number;
  earned: Micros;
  /** earned ÷ runs, rounded; 0 with no runs. */
  average: Micros;
}

export interface SweepResult {
  closed: number;
  expired: Micros;
}

/** One accepted answer's earning (plans/human-steps.md §8.1), as booked:
 *  `pay(…)` writes it once per lease. */
export interface PayInput {
  /** The lease the answer was given under: the key. */
  lease: string;
  task: string;
  worker: string;
  /** The task type. */
  type: string;
  /** What the answer earns, the lease's stamp: whole msat > 0. */
  msat: number;
  /** When the answer was accepted, epoch ms. */
  at: number;
  /** When it can be withdrawn: `at` plus the type's hold. */
  releases: number;
  /** The run that asked; empty for a task with none (item 4's tests). */
  workflow?: string;
  runId?: string;
  path?: string;
}

export interface Earning {
  lease: string;
  task: string;
  worker: string;
  type: string;
  msat: number;
  at: number;
  releases: number;
  workflow: string;
  runId: string;
  path: string;
  /** When it was taken back, why and by whom; it no longer counts. */
  takenBack?: number;
  takenBackWhy?: string;
  takenBackBy?: string;
}

export interface PayResult {
  earning: Earning;
  /** false: the lease was booked already; nothing was written. */
  existing: boolean;
}

export interface TakeBackInput {
  lease: string;
  why: string;
  by?: string;
  at?: number;
}

/** A take-back's outcome for one earning: `taken` (now, or already — the
 *  earning says when), `released` (past its hold: the worker's) or `none`
 *  (the lease earned nothing here). */
export interface TakeBackResult {
  lease: string;
  result: "taken" | "released" | "none";
  earning?: Earning;
}

/** What a worker is owed here (plans/human-steps.md §8.1, "The balance"). */
export interface PayeeBalance {
  /** Earned, less taken back, less withdrawn. */
  totalMsat: number;
  /** Of which still in its hold. */
  heldMsat: number;
  /** total − held: what a withdrawal (item 5b) may take. */
  withdrawableMsat: number;
  /** The soonest a held earning releases, epoch ms. */
  nextReleaseAt?: number;
}

export const ZERO_BALANCE: Readonly<PayeeBalance> = Object.freeze({ totalMsat: 0, heldMsat: 0, withdrawableMsat: 0 });

/** What every worker is owed together (plans/human-steps.md §8.1, "The
 *  books"): the sum of each payee's balance at `now`. */
export interface WorkersOwed {
  /** Earned, less taken back, less withdrawn, over every worker. */
  owedMsat: number;
  /** Of which still in its hold. */
  heldMsat: number;
  /** owed − held. */
  withdrawableMsat: number;
  /** Workers with a balance (owed > 0). */
  payees: number;
}

export const ZERO_OWED: Readonly<WorkersOwed> = Object.freeze({ owedMsat: 0, heldMsat: 0, withdrawableMsat: 0, payees: 0 });

/** `pay_daily`: one UTC day and task type. A take-back counts on the row
 *  of the day its answer was accepted: of that day's answers, those taken
 *  back since. */
export interface PayDailyRow {
  day: string;
  type: string;
  answers: number;
  msat: number;
  takenBackAnswers: number;
  takenBackMsat: number;
}

export interface LedgerStore {
  /** Writes the token and its payment in one transaction, committed with
   *  `synchronous=full`; inherits from `carryFrom`. A token already here
   *  answers `created: false`. */
  firstUse(input: FirstUseInput): Promise<FirstUseResult>;
  /** Sets the reserve aside, or says why not; never overdraws. */
  hold(input: HoldInput): Promise<HoldResult>;
  /** Frees the hold and charges the run by the rule, at most what the token
   *  holds; moves or expires what that freed when the token is carried or
   *  closed. A run already charged answers `existing: true`. */
  charge(input: ChargeInput): Promise<ChargeResult>;
  /** Closes every open token past its expiry; what was left is earned under
   *  `expired`. */
  sweep(o?: { now?: number }): Promise<SweepResult>;
  /** A payment out of the wallet, once it settled: one entry per payment
   *  hash. The same hash again writes nothing and answers the first entry. */
  withdrawal(input: WithdrawalInput): Promise<LedgerEntry>;
  /** The withdrawal recorded for a payment hash, if one is. */
  withdrawalOf(paymentHash: string): Promise<LedgerEntry | undefined>;
  /** Sats paid into the wallet by hand, once they settled: one row per
   *  payment hash. The same hash again writes nothing and answers the first. */
  deposit(input: DepositInput): Promise<Deposit>;
  /** The deposit recorded for a payment hash, if one is. */
  depositOf(paymentHash: string): Promise<Deposit | undefined>;
  /** Deposits by day. */
  deposited(range?: DayRange): Promise<DepositedRow[]>;

  token(id: string): Promise<TokenBalance | undefined>;
  /** A token's entries, newest first: `ENTRIES_PAGE` of them, before `before`. */
  entries(token: string, o?: { limit?: number; before?: number }): Promise<LedgerEntry[]>;
  /** The hold a launch's `key` names on `token` for `subject`, while its run
   *  is not charged: a key dedupes a launch in flight, never one that ended
   *  or never ran, and never another item's. */
  findHold(token: string, subject: string, key: string): Promise<OpenHold | undefined>;
  /** A run's charge, once it was charged: what the launcher's view shows. */
  chargeOf(runId: string, subject: string): Promise<LedgerEntry | undefined>;
  /** Holds no charge has freed yet, for the boot reconcile. */
  openHolds(): Promise<OpenHold[]>;
  earnings(q: EarningsQuery): Promise<EarningsRow[]>;
  /** Payments in, by day. */
  received(range?: DayRange): Promise<ReceivedRow[]>;
  withdrawn(range?: DayRange): Promise<WithdrawnRow[]>;
  outstanding(): Promise<Outstanding>;
  /** A subject's last `RECENT_DAYS` days: runs, and the average charge. */
  recent(subject: string, o?: { now?: number; days?: number }): Promise<Recent>;
  /** A subject's row for one day (today by default): the daily cap reads `cost`. */
  today(subject: string, o?: { now?: number }): Promise<EarningsRow>;
  /** Entries newest first, a page at a time (`ENTRIES_PAGE` before
   *  `before`): of one kind, or of one run. The Earnings tab's lists. */
  list(o?: EntryListQuery): Promise<LedgerEntry[]>;
  /** Every entry in order, a page at a time: for an audit or an export.
   *  Nothing on a request path reads it. */
  scan(o?: { after?: number; limit?: number }): Promise<LedgerEntry[]>;

  // Worker pay (plans/human-steps.md §8.1).
  /** Books an accepted answer's earning: the `pay` row, the payee's and the
   *  day's, in one transaction committed with `synchronous=full`. The same
   *  lease again writes nothing and answers the first row. */
  pay(input: PayInput): Promise<PayResult>;
  /** The earning a lease booked, if any. */
  payOf(lease: string): Promise<Earning | undefined>;
  /** The earnings these tasks' answers booked, by task then worker. */
  payFor(tasks: readonly string[]): Promise<Earning[]>;
  /** Takes an earning back while it is held: one guarded statement, with
   *  the payee's and the day's rows, committed with `synchronous=full`. One
   *  past its hold is `released` (the worker's); one taken back already is
   *  `taken` and changes nothing. */
  takeBack(input: TakeBackInput): Promise<TakeBackResult>;
  /** What one worker is owed, held and withdrawable at `now`. */
  payeeBalance(worker: string, o?: { now?: number }): Promise<PayeeBalance>;
  /** The same for several workers in one grouped read; a worker with
   *  nothing earned is left out. */
  payeeBalances(workers: readonly string[], o?: { now?: number }): Promise<Record<string, PayeeBalance>>;
  /** `pay_daily` by day and task type. */
  payDaily(range?: DayRange): Promise<PayDailyRow[]>;
  /** What every worker is owed at `now`, held and withdrawable: one row per
   *  payee and the held range of each on its index. */
  owedToWorkers(o?: { now?: number }): Promise<WorkersOwed>;
  /** Folds the WAL into the file. */
  close(): Promise<void>;
}

export class LedgerError extends Error {
  constructor(
    readonly code: "unknown_token" | "no_hold" | "payment_reused" | "subject_mismatch",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LedgerError";
  }
}

/** `<dataDir>/payments/ledger.db`. */
export function ledgerPath(dataDir: string): string {
  return join(dataDir, "payments", "ledger.db");
}

/**
 * The ledger on `node:sqlite` at `<dataDir>/payments/ledger.db`, its folder
 * owner-only. `node:sqlite` is imported here, on first use, never at boot.
 */
export async function openLedger(o: { dataDir: string } | { file: string }): Promise<LedgerStore> {
  const { SqliteLedgerStore } = await import("./ledger-sqlite.js");
  return SqliteLedgerStore.open("file" in o ? o.file : ledgerPath(o.dataDir));
}

// ── Shared by the implementations ───────────────────────────────────────

/** The UTC day of an epoch-ms instant. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The epoch ms a UTC day starts at. */
export function dayStart(day: string): number {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(t)) throw new RangeError(`not a day (YYYY-MM-DD): ${day}`);
  return t;
}

/** The epoch-ms half-open range `[from, to)` of an inclusive day range. */
export function msRange(range: DayRange = {}): [number, number] {
  const from = range.from ? dayStart(range.from) : 0;
  const to = range.to ? dayStart(range.to) + 24 * 60 * 60 * 1000 : Number.MAX_SAFE_INTEGER;
  return [from, to];
}

/** The name in a subject: `workflow:acme/x` → `acme/x`. */
export function subjectName(subject: string): string {
  const i = subject.indexOf(":");
  return i < 0 ? subject : subject.slice(i + 1);
}

/** Whether a subject lies under a package prefix. */
export function underPrefix(subject: string, prefix: string): boolean {
  return subjectName(subject).startsWith(`${prefix}/`) && subject.includes(":");
}

/** What a payment buys: the quote in proportion to what was SETTLED of
 *  what was asked (§4.3 step 4), never more than the quote. */
export function creditFor(input: Pick<FirstUseInput, "askedMsat" | "settledMsat" | "credit">): Micros {
  const asked = positiveInt("askedMsat", input.askedMsat);
  const settled = positiveInt("settledMsat", input.settledMsat);
  const credit = int("credit", input.credit);
  if (settled >= asked) return credit;
  return Math.floor((credit * settled) / asked);
}

/** Rolls rows of `daily` into the rows `earnings` answers. */
export function rollUp(rows: Array<EarningsRow & { day: string; subject: string }>, q: EarningsQuery): EarningsRow[] {
  const out = new Map<string, EarningsRow>();
  for (const r of rows) {
    if (q.prefix && !underPrefix(r.subject, q.prefix)) continue;
    if (q.subjects && !q.subjects.includes(r.subject)) continue;
    let key: string | undefined;
    if (q.by === "item") key = r.subject;
    else if (q.by === "day") key = r.day;
    else if (q.by === "total") key = "total";
    else key = r.subject.includes(":") ? packagePrefixOf(subjectName(r.subject)) : undefined;
    if (!key) continue;
    const row = out.get(key) ?? { key, calls: 0, failed: 0, earned: 0, cost: 0 };
    row.calls += r.calls;
    row.failed += r.failed;
    row.earned += r.earned;
    row.cost += r.cost;
    out.set(key, row);
  }
  if (q.by === "total" && !out.size) return [{ key: "total", calls: 0, failed: 0, earned: 0, cost: 0 }];
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A `pay(…)` input checked, as the row it writes. */
export function earningOf(input: PayInput): Earning {
  for (const k of ["lease", "task", "worker", "type"] as const) {
    if (typeof input[k] !== "string" || !input[k]) throw new RangeError(`${k} is required`);
  }
  positiveInt("msat", input.msat);
  int("at", input.at);
  int("releases", input.releases);
  if (input.releases <= input.at) throw new RangeError(`releases must come after at: ${input.releases} ≤ ${input.at}`);
  return {
    lease: input.lease,
    task: input.task,
    worker: input.worker,
    type: input.type,
    msat: input.msat,
    at: input.at,
    releases: input.releases,
    workflow: input.workflow ?? "",
    runId: input.runId ?? "",
    path: input.path ?? "",
  };
}

/** A payee's balance from its totals and what of it is held. */
export function payeeBalanceOf(o: { accepted: number; takenBack: number; withdrawn: number; held: number; nextReleaseAt?: number }): PayeeBalance {
  const totalMsat = Math.max(0, o.accepted - o.takenBack - o.withdrawn);
  const heldMsat = Math.min(totalMsat, Math.max(0, o.held));
  return { totalMsat, heldMsat, withdrawableMsat: totalMsat - heldMsat, ...(o.nextReleaseAt !== undefined ? { nextReleaseAt: o.nextReleaseAt } : {}) };
}

export function int(name: string, v: number): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a whole number ≥ 0: ${v}`);
  return v;
}

export function positiveInt(name: string, v: number): number {
  if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`${name} must be a whole number > 0: ${v}`);
  return v;
}

export function pageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}
