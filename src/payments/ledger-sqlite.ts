/**
 * The ledger on `node:sqlite` (plans/paid-runs.md §5): one file, WAL, its
 * folder owner-only. Holds and charges commit with `synchronous=normal` (a
 * power cut may lose the last few, never the file), a payment and a
 * withdrawal with `synchronous=full`. Every write is one `BEGIN IMMEDIATE`
 * transaction, so a second strut process on the same file waits its turn
 * instead of failing. `close()` folds the WAL into the file, so a move or a
 * backup carries one file. The semantics are `ledger.ts`'s; the memory twin
 * (`ledger-memory.ts`) passes the same suite.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  chargeFor,
  creditFor,
  dayOf,
  earningOf,
  int,
  LedgerError,
  msRange,
  pageLimit,
  positiveInt,
  payeeBalanceOf,
  rollUp,
  ENTRIES_PAGE,
  ENTRIES_PAGE_MAX,
  EXPIRED_SUBJECT,
  RECENT_DAYS,
  ZERO_BALANCE,
  type ChargeInput,
  type ChargeResult,
  type DayRange,
  type Deposit,
  type DepositedRow,
  type DepositInput,
  type EarningsQuery,
  type Earning,
  type EarningsRow,
  type EntryKind,
  type EntryListQuery,
  type FirstUseInput,
  type FirstUseResult,
  type HoldInput,
  type HoldResult,
  type LedgerEntry,
  type LedgerStore,
  type Micros,
  type OpenHold,
  type Outstanding,
  type PayDailyRow,
  type PayeeBalance,
  type WorkersOwed,
  type PayInput,
  type PayResult,
  type ReceivedRow,
  type Recent,
  type RunOutcome,
  type SendPurpose,
  type SweepResult,
  type TakeBackInput,
  type TakeBackResult,
  type TokenBalance,
  type WithdrawalInput,
  type WithdrawnRow,
} from "./ledger.js";

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far a successor chain is followed (A → B → C …). */
const CHAIN_MAX = 64;

const SCHEMA = `
create table if not exists tokens (
  id text primary key,
  payment_hash text not null unique,
  paid integer not null,
  spent integer not null default 0,
  held integer not null default 0,
  rate real not null,
  msat integer not null,
  created integer not null,
  expires integer not null,
  closed integer,
  successor text
) strict;
create index if not exists tokens_open on tokens(expires) where closed is null;
create index if not exists tokens_holding on tokens(id) where held > 0;

create table if not exists entries (
  seq integer primary key autoincrement,
  at integer not null,
  kind text not null check (kind in ('payment', 'hold', 'charge', 'carry', 'expiry', 'withdrawal')),
  token text,
  usd integer,
  msat integer,
  subject text,
  run_id text,
  key text,
  ref text,
  cost integer,
  outcome text,
  fee_msat integer,
  actor text
) strict;
create index if not exists entries_token on entries(token, seq) where token is not null;
-- A key names a hold while its run is in flight; once charged, the same key
-- may hold again (a re-run of the same input), so it is not unique.
drop index if exists entries_token_key;
create index if not exists entries_token_keyed on entries(token, key, seq) where key is not null;
create index if not exists entries_run on entries(run_id) where run_id is not null;
create index if not exists entries_payments on entries(at) where kind = 'payment';
create index if not exists entries_withdrawals on entries(at) where kind = 'withdrawal';
create unique index if not exists entries_withdrawal_hash on entries(ref) where kind = 'withdrawal';
create trigger if not exists entries_append_only before update on entries
  begin select raise(abort, 'ledger entries are append-only'); end;

create table if not exists daily (
  day text not null,
  subject text not null,
  calls integer not null default 0,
  failed integer not null default 0,
  earned integer not null default 0,
  cost integer not null default 0,
  primary key (day, subject)
) strict, without rowid;
create index if not exists daily_subject on daily(subject, day);

-- Sats an admin paid into the wallet by hand: the books count them, nothing
-- else does. A table of its own, so no ledger file needs a migration.
create table if not exists deposits (
  payment_hash text primary key,
  at integer not null,
  msat integer not null,
  actor text
) strict;
create index if not exists deposits_at on deposits(at);

-- Worker pay (plans/human-steps.md §8.1): what accepted answers earned, in
-- msat. Tables of their own, so no ledger file needs a migration. A pay row
-- is written once per lease and changed only by its take-back, once.
create table if not exists pay (
  lease text primary key,
  task text not null,
  worker text not null,
  type text not null,
  msat integer not null check (msat > 0),
  at integer not null,
  releases integer not null,
  workflow text not null,
  run_id text not null,
  path text not null,
  taken_back integer,
  taken_back_why text,
  taken_back_by text,
  unique (task, worker)
) strict;
create index if not exists pay_held_worker on pay(worker, releases) where taken_back is null;
create index if not exists pay_held on pay(releases) where taken_back is null;
create index if not exists pay_run on pay(run_id);
create trigger if not exists pay_take_back_once before update on pay
  when old.taken_back is not null or new.taken_back is null
    or new.lease is not old.lease or new.task is not old.task or new.worker is not old.worker or new.type is not old.type
    or new.msat is not old.msat or new.at is not old.at or new.releases is not old.releases
    or new.workflow is not old.workflow or new.run_id is not old.run_id or new.path is not old.path
  begin select raise(abort, 'a pay row changes only by its take-back, once'); end;
create trigger if not exists pay_kept before delete on pay
  begin select raise(abort, 'pay rows are kept'); end;

create table if not exists payees (
  worker text primary key,
  accepted integer not null default 0,
  taken_back integer not null default 0,
  withdrawn integer not null default 0,
  answers integer not null default 0,
  first_at integer not null,
  last_at integer not null
) strict;

create table if not exists pay_daily (
  day text not null,
  type text not null,
  answers integer not null default 0,
  msat integer not null default 0,
  taken_back_answers integer not null default 0,
  taken_back_msat integer not null default 0,
  primary key (day, type)
) strict, without rowid;
`;

type Row = Record<string, unknown>;

const warned = new Set<string>();

export class SqliteLedgerStore implements LedgerStore {
  private readonly s: Record<string, StatementSync>;
  private closed = false;

  /** Opens (and makes) the file; its folder is created owner-only. */
  static open(file: string): SqliteLedgerStore {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else if ((statSync(dir).mode & 0o077) !== 0 && !warned.has(dir)) {
      warned.add(dir);
      console.warn(`[ledger] ${dir} is readable by other users; the ledger expects an owner-only folder (chmod 700)`);
    }
    const fresh = !existsSync(file);
    const store = new SqliteLedgerStore(new DatabaseSync(file), file);
    if (fresh) chmodSync(file, 0o600);
    return store;
  }

  private constructor(
    private readonly db: DatabaseSync,
    readonly file: string,
  ) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 10000");
    const version = (db.prepare("PRAGMA user_version").get() as Row).user_version as number;
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new Error(`${file}: ledger schema ${version} is newer than this strut's (${SCHEMA_VERSION})`);
    }
    db.exec(SCHEMA);
    if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      token: p("select * from tokens where id = ?"),
      tokenByHash: p("select id from tokens where payment_hash = ?"),
      insertToken: p(
        "insert into tokens (id, payment_hash, paid, spent, held, rate, msat, created, expires) values (?, ?, ?, 0, 0, ?, ?, ?, ?)",
      ),
      carryOut: p("update tokens set spent = spent + ?, successor = ? where id = ?"),
      carryIn: p("update tokens set paid = paid + ? where id = ?"),
      spend: p("update tokens set spent = spent + ? where id = ?"),
      hold: p(
        `update tokens set held = held + ?
          where id = ? and closed is null and successor is null and expires > ? and paid - spent - held >= ?`,
      ),
      release: p("update tokens set held = held - ?, spent = spent + ? where id = ?"),
      close: p("update tokens set closed = ?, spent = spent + ? where id = ?"),
      dueTokens: p("select * from tokens where closed is null and expires <= ?"),
      insertEntry: p(
        `insert into entries (at, kind, token, usd, msat, subject, run_id, key, ref, cost, outcome, fee_msat, actor)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      entry: p("select * from entries where seq = ?"),
      // The newest hold `key` names on a token for a subject while its run is
      // not charged: a key dedupes a launch in flight, never one that ended or
      // never ran (freed by a charge of nothing), and never another item's.
      holdByKey: p(
        `select h.* from entries h where h.token = ? and h.subject = ? and h.key = ? and h.kind = 'hold'
            and not exists (select 1 from entries c where c.run_id = h.run_id and c.kind = 'charge' and c.token = h.token)
          order by h.seq desc limit 1`,
      ),
      holdByRun: p("select * from entries where run_id = ? and kind = 'hold' and token = ?"),
      chargeByRun: p("select * from entries where run_id = ? and kind = 'charge' and token = ?"),
      freeChargeByRun: p("select * from entries where run_id = ? and kind = 'charge' and token is null and subject = ?"),
      chargeOf: p("select * from entries where run_id = ? and kind = 'charge' and subject = ? order by seq limit 1"),
      tokenEntries: p("select * from entries where token = ? and seq < ? order by seq desc limit ?"),
      openHolds: p(
        // CROSS JOIN keeps the tokens first: only those holding now, never a
        // scan of every hold ever made.
        `select h.* from tokens t cross join entries h on h.token = t.id and h.kind = 'hold'
          where t.held > 0
            and not exists (select 1 from entries c where c.run_id = h.run_id and c.kind = 'charge' and c.token = h.token)
          order by h.seq`,
      ),
      daily: p(
        `insert into daily (day, subject, calls, failed, earned, cost) values (?, ?, ?, ?, ?, ?)
         on conflict (day, subject) do update set
           calls = calls + excluded.calls, failed = failed + excluded.failed,
           earned = earned + excluded.earned, cost = cost + excluded.cost`,
      ),
      day: p("select calls, failed, earned, cost from daily where day = ? and subject = ?"),
      span: p(
        `select coalesce(sum(calls), 0) calls, coalesce(sum(failed), 0) failed, coalesce(sum(earned), 0) earned
           from daily where subject = ? and day >= ? and day <= ?`,
      ),
      received: p(
        `select date(at / 1000, 'unixepoch') day, count(*) count, sum(msat) msat, sum(usd) usd
           from entries where kind = 'payment' and at >= ? and at < ? group by day order by day`,
      ),
      withdrawn: p(
        `select date(at / 1000, 'unixepoch') day, coalesce(subject, 'withdrawal') purpose, count(*) count, sum(msat) msat, coalesce(sum(fee_msat), 0) fee_msat
           from entries where kind = 'withdrawal' and at >= ? and at < ? group by day, purpose order by day, purpose`,
      ),
      outstanding: p(
        `select coalesce(sum(case when successor is null then 1 else 0 end), 0) tokens,
                coalesce(sum(paid - spent), 0) usd, coalesce(sum(held), 0) held
           from tokens where closed is null`,
      ),
      scan: p("select * from entries where seq > ? order by seq limit ?"),
      withdrawalOf: p("select * from entries where kind = 'withdrawal' and ref = ?"),
      insertDeposit: p("insert or ignore into deposits (payment_hash, at, msat, actor) values (?, ?, ?, ?)"),
      depositOf: p("select * from deposits where payment_hash = ?"),
      deposited: p(
        `select date(at / 1000, 'unixepoch') day, count(*) count, sum(msat) msat
           from deposits where at >= ? and at < ? group by day order by day`,
      ),
      listAll: p("select * from entries where seq < ? order by seq desc limit ?"),
      listKind: p("select * from entries where kind = ? and seq < ? order by seq desc limit ?"),
      listRun: p("select * from entries where run_id = ? and seq < ? order by seq desc limit ?"),
      payOf: p("select * from pay where lease = ?"),
      payFor: p("select * from pay where task in (select value from json_each(?)) order by task, worker"),
      insertPay: p(
        `insert into pay (lease, task, worker, type, msat, at, releases, workflow, run_id, path)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      payee: p(
        `insert into payees (worker, accepted, answers, first_at, last_at) values (?1, ?2, 1, ?3, ?3)
         on conflict (worker) do update set accepted = accepted + excluded.accepted, answers = answers + 1,
           first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)`,
      ),
      payDay: p(
        `insert into pay_daily (day, type, answers, msat) values (?, ?, 1, ?)
         on conflict (day, type) do update set answers = answers + 1, msat = msat + excluded.msat`,
      ),
      // The one guarded write of a take-back: held, and not taken back yet.
      takeBack: p(
        `update pay set taken_back = ?1, taken_back_why = ?2, taken_back_by = ?3
          where lease = ?4 and taken_back is null and releases > ?1`,
      ),
      payeeTakenBack: p("update payees set taken_back = taken_back + ? where worker = ?"),
      payDayTakenBack: p("update pay_daily set taken_back_answers = taken_back_answers + 1, taken_back_msat = taken_back_msat + ? where day = ? and type = ?"),
      payeeRow: p("select * from payees where worker = ?"),
      held: p(
        `select coalesce(sum(msat), 0) held, min(releases) next from pay
          where worker = ? and taken_back is null and releases > ?`,
      ),
      payeeRows: p("select * from payees where worker in (select value from json_each(?))"),
      heldBy: p(
        `select worker, coalesce(sum(msat), 0) held, min(releases) next from pay
          where worker in (select value from json_each(?1)) and taken_back is null and releases > ?2
          group by worker`,
      ),
      payDaily: p("select * from pay_daily where day >= ? and day <= ? order by day, type"),
      // Every payee with a balance, each with what of it is held: the payee's
      // row, and its held range on `pay_held_worker`. Held is never more
      // than the balance (payeeBalanceOf's rule).
      owed: p(
        `select count(*) payees, coalesce(sum(total), 0) owed, coalesce(sum(min(total, held)), 0) held from (
           select p.accepted - p.taken_back - p.withdrawn total,
                  coalesce((select sum(msat) from pay where worker = p.worker and taken_back is null and releases > ?), 0) held
             from payees p)
          where total > 0`,
      ),
    };
  }

  // ── writes ────────────────────────────────────────────────────────────

  async firstUse(input: FirstUseInput): Promise<FirstUseResult> {
    const at = input.at ?? Date.now();
    need("id", input.id);
    need("paymentHash", input.paymentHash);
    int("expires", input.expires);
    if (!Number.isFinite(input.rate) || input.rate <= 0) throw new RangeError(`rate must be dollars per bitcoin > 0: ${input.rate}`);
    const credited = creditFor(input);
    return this.tx(() => {
      const known = this.s.token.get(input.id) as Row | undefined;
      if (known) return { token: tokenOf(known), created: false, credited: 0, carried: 0 };
      const other = this.s.tokenByHash.get(input.paymentHash) as Row | undefined;
      if (other) throw new LedgerError("payment_reused", `payment ${input.paymentHash} already bought token ${other.id}`);
      this.s.insertToken.run(input.id, input.paymentHash, credited, input.rate, input.settledMsat, at, input.expires);
      this.entry(at, "payment", { token: input.id, usd: credited, msat: input.settledMsat, ref: input.paymentHash });
      let carried = 0;
      if (input.carryFrom && input.carryFrom !== input.id) {
        const from = this.s.token.get(input.carryFrom) as Row | undefined;
        if (from && from.closed === null && from.successor === null && (from.expires as number) > at) {
          carried = this.move(at, tokenOf(from), input.id, freeOf(from));
        }
      }
      return { token: tokenOf(this.s.token.get(input.id) as Row), created: true, credited, carried };
    }, true);
  }

  async hold(input: HoldInput): Promise<HoldResult> {
    const at = input.at ?? Date.now();
    positiveInt("reserve", input.reserve);
    need("subject", input.subject);
    need("runId", input.runId);
    return this.tx<HoldResult>(() => {
      if (input.key !== undefined) {
        const first = this.s.holdByKey.get(input.token, input.subject, input.key) as Row | undefined;
        if (first) return { ok: true, existing: true, seq: first.seq as number, runId: first.run_id as string, reserve: first.usd as number, subject: first.subject as string };
      }
      const same = this.s.holdByRun.get(input.runId, input.token) as Row | undefined;
      if (same) return { ok: true, existing: true, seq: same.seq as number, runId: same.run_id as string, reserve: same.usd as number, subject: same.subject as string };
      const changed = this.s.hold.run(input.reserve, input.token, at, input.reserve).changes;
      if (Number(changed) === 1) {
        const seq = this.entry(at, "hold", { token: input.token, usd: input.reserve, subject: input.subject, runId: input.runId, key: input.key });
        return { ok: true, existing: false, seq, runId: input.runId, reserve: input.reserve, subject: input.subject };
      }
      const t = this.s.token.get(input.token) as Row | undefined;
      if (!t) return { ok: false, reason: "unknown", free: 0 };
      const free = Math.max(0, freeOf(t));
      if (t.successor !== null) return { ok: false, reason: "carried", free, successor: t.successor as string };
      if (t.closed !== null) return { ok: false, reason: "closed", free };
      if ((t.expires as number) <= at) return { ok: false, reason: "expired", free };
      return { ok: false, reason: "short", free };
    });
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const at = input.at ?? Date.now();
    need("runId", input.runId);
    need("subject", input.subject);
    const cost = int("cost", input.cost);
    const failed = input.outcome === "error" ? 1 : 0;
    if (input.token === undefined) {
      return this.tx(() => {
        const due = chargeFor(input.price, cost, input.outcome);
        const done = this.s.freeChargeByRun.get(input.runId, input.subject) as Row | undefined;
        if (done) return { seq: done.seq as number, charged: 0, due, reserve: 0, existing: true };
        const seq = this.entry(at, "charge", { usd: 0, subject: input.subject, runId: input.runId, cost, outcome: input.outcome });
        this.s.daily.run(dayOf(at), input.subject, 1, failed, 0, cost);
        return { seq, charged: 0, due, reserve: 0, existing: false };
      });
    }
    const token = input.token;
    return this.tx(() => {
      const hold = this.s.holdByRun.get(input.runId, token) as Row | undefined;
      if (!hold) {
        if (!this.s.token.get(token)) throw new LedgerError("unknown_token", `no token ${token}`);
        throw new LedgerError("no_hold", `token ${token} holds nothing for run ${input.runId}`);
      }
      if (hold.subject !== input.subject) {
        throw new LedgerError("subject_mismatch", `run ${input.runId} was held for ${hold.subject}, charged as ${input.subject}`);
      }
      const reserve = hold.usd as number;
      const done = this.s.chargeByRun.get(input.runId, token) as Row | undefined;
      if (done) {
        const due = chargeFor(input.price, done.cost as number, done.outcome as RunOutcome, reserve);
        return { seq: done.seq as number, charged: done.usd as number, due, reserve, existing: true };
      }
      const t = this.s.token.get(token) as Row;
      const available = Math.max(0, (t.paid as number) - (t.spent as number) - ((t.held as number) - reserve));
      const due = chargeFor(input.price, cost, input.outcome, reserve);
      // Never more than the hold: the reserve is the most a run could be
      // charged (decision 21); what a run spent past it is the seller's.
      const charged = Math.min(due, reserve, available);
      this.s.release.run(reserve, charged, token);
      const seq = this.entry(at, "charge", { token, usd: charged, subject: input.subject, runId: input.runId, cost, outcome: input.outcome });
      this.s.daily.run(dayOf(at), input.subject, 1, failed, charged, cost);
      const result: ChargeResult = { seq, charged, due, reserve, existing: false };
      // What the charge freed on a token that was carried on goes to its
      // live successor (§4.5); on a closed token it expires.
      const after = this.s.token.get(token) as Row;
      const left = freeOf(after);
      if (left > 0 && after.successor !== null) {
        const end = this.chainEnd(after.successor as string);
        if (end && end.closed === null) result.carried = { to: end.id as string, usd: this.move(at, tokenOf(after), end.id as string, left) };
        else result.expired = this.expire(at, token, left);
      } else if (left > 0 && after.closed !== null) {
        result.expired = this.expire(at, token, left);
      }
      return result;
    });
  }

  async sweep(o: { now?: number } = {}): Promise<SweepResult> {
    const now = o.now ?? Date.now();
    return this.tx(() => {
      let closed = 0;
      let expired = 0;
      for (const t of this.s.dueTokens.all(now) as Row[]) {
        expired += this.expire(now, t.id as string, Math.max(0, freeOf(t)), now);
        closed++;
      }
      return { closed, expired };
    });
  }

  async withdrawal(input: WithdrawalInput): Promise<LedgerEntry> {
    const at = input.at ?? Date.now();
    positiveInt("msat", input.msat);
    need("paymentHash", input.paymentHash);
    if (input.feeMsat !== undefined) int("feeMsat", input.feeMsat);
    if (input.usd !== undefined) int("usd", input.usd);
    return this.tx(() => {
      const known = this.s.withdrawalOf.get(input.paymentHash) as Row | undefined;
      if (known) return entryOf(known);
      const seq = this.entry(at, "withdrawal", { msat: input.msat, feeMsat: input.feeMsat, ref: input.paymentHash, actor: input.actor, usd: input.usd, subject: input.purpose ?? "withdrawal" });
      return entryOf(this.s.entry.get(seq) as Row);
    }, true);
  }

  async withdrawalOf(paymentHash: string): Promise<LedgerEntry | undefined> {
    const row = this.live().s.withdrawalOf.get(paymentHash) as Row | undefined;
    return row ? entryOf(row) : undefined;
  }

  async deposit(input: DepositInput): Promise<Deposit> {
    const at = input.at ?? Date.now();
    positiveInt("msat", input.msat);
    need("paymentHash", input.paymentHash);
    int("at", at);
    return this.tx(() => {
      this.s.insertDeposit.run(input.paymentHash, at, input.msat, input.actor ?? null);
      return depositOf(this.s.depositOf.get(input.paymentHash) as Row);
    }, true);
  }

  async depositOf(paymentHash: string): Promise<Deposit | undefined> {
    const row = this.live().s.depositOf.get(paymentHash) as Row | undefined;
    return row ? depositOf(row) : undefined;
  }

  async deposited(range?: DayRange): Promise<DepositedRow[]> {
    const [from, to] = msRange(range);
    return (this.live().s.deposited.all(from, to) as Row[]).map((r) => ({ day: r.day as string, count: r.count as number, msat: r.msat as number }));
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async token(id: string): Promise<TokenBalance | undefined> {
    const row = this.live().s.token.get(id) as Row | undefined;
    return row ? tokenOf(row) : undefined;
  }

  async entries(token: string, o: { limit?: number; before?: number } = {}): Promise<LedgerEntry[]> {
    const limit = pageLimit(o.limit, ENTRIES_PAGE, ENTRIES_PAGE_MAX);
    return (this.live().s.tokenEntries.all(token, o.before ?? Number.MAX_SAFE_INTEGER, limit) as Row[]).map(entryOf);
  }

  async findHold(token: string, subject: string, key: string): Promise<OpenHold | undefined> {
    const row = this.live().s.holdByKey.get(token, subject, key) as Row | undefined;
    return row ? holdOf(row) : undefined;
  }

  async openHolds(): Promise<OpenHold[]> {
    return (this.live().s.openHolds.all() as Row[]).map(holdOf);
  }

  async chargeOf(runId: string, subject: string): Promise<LedgerEntry | undefined> {
    const row = this.live().s.chargeOf.get(runId, subject) as Row | undefined;
    return row ? entryOf(row) : undefined;
  }

  async earnings(q: EarningsQuery): Promise<EarningsRow[]> {
    const where: string[] = ["day >= ?", "day <= ?"];
    const args: string[] = [q.from ?? "0000-00-00", q.to ?? "9999-99-99"];
    if (q.prefix) {
      // Byte order: every subject under `workflow:<prefix>/` sorts before
      // `workflow:<prefix>0` ('/' + 1).
      where.push("((subject >= ? and subject < ?) or (subject >= ? and subject < ?))");
      args.push(`workflow:${q.prefix}/`, `workflow:${q.prefix}0`, `step:${q.prefix}/`, `step:${q.prefix}0`);
    }
    if (q.subjects) {
      if (!q.subjects.length) where.push("0");
      else {
        where.push(`subject in (${q.subjects.map(() => "?").join(", ")})`);
        args.push(...q.subjects);
      }
    }
    const sums = "sum(calls) calls, sum(failed) failed, sum(earned) earned, sum(cost) cost";
    const filter = `where ${where.join(" and ")}`;
    const db = this.live().db;
    if (q.by === "total") {
      const r = db.prepare(`select 'total' key, ${sums} from daily ${filter}`).get(...args) as Row;
      return [rowOf({ ...r, calls: r.calls ?? 0, failed: r.failed ?? 0, earned: r.earned ?? 0, cost: r.cost ?? 0 })];
    }
    if (q.by === "package") {
      const rows = db.prepare(`select subject, '' day, ${sums} from daily ${filter} group by subject`).all(...args) as Row[];
      return rollUp(rows.map((r) => ({ ...rowOf({ ...r, key: r.subject }), day: "", subject: r.subject as string })), q);
    }
    const col = q.by === "day" ? "day" : "subject";
    return (db.prepare(`select ${col} key, ${sums} from daily ${filter} group by ${col} order by ${col}`).all(...args) as Row[]).map(rowOf);
  }

  async received(range?: DayRange): Promise<ReceivedRow[]> {
    const [from, to] = msRange(range);
    return (this.live().s.received.all(from, to) as Row[]).map((r) => ({
      day: r.day as string,
      count: r.count as number,
      msat: r.msat as number,
      usd: r.usd as number,
    }));
  }

  async withdrawn(range?: DayRange): Promise<WithdrawnRow[]> {
    const [from, to] = msRange(range);
    return (this.live().s.withdrawn.all(from, to) as Row[]).map((r) => ({
      day: r.day as string,
      purpose: r.purpose as SendPurpose,
      count: r.count as number,
      msat: r.msat as number,
      feeMsat: r.fee_msat as number,
    }));
  }

  async outstanding(): Promise<Outstanding> {
    const r = this.live().s.outstanding.get() as Row;
    return { tokens: r.tokens as number, usd: r.usd as number, held: r.held as number };
  }

  async recent(subject: string, o: { now?: number; days?: number } = {}): Promise<Recent> {
    const now = o.now ?? Date.now();
    const days = Math.max(1, Math.floor(o.days ?? RECENT_DAYS));
    const r = this.live().s.span.get(subject, dayOf(now - (days - 1) * DAY_MS), dayOf(now)) as Row;
    const runs = r.calls as number;
    const earned = r.earned as number;
    return { days, runs, failed: r.failed as number, earned, average: runs ? Math.round(earned / runs) : 0 };
  }

  async today(subject: string, o: { now?: number } = {}): Promise<EarningsRow> {
    const r = this.live().s.day.get(dayOf(o.now ?? Date.now()), subject) as Row | undefined;
    return r ? rowOf({ ...r, key: subject }) : { key: subject, calls: 0, failed: 0, earned: 0, cost: 0 };
  }

  async list(o: EntryListQuery = {}): Promise<LedgerEntry[]> {
    const limit = pageLimit(o.limit, ENTRIES_PAGE, ENTRIES_PAGE_MAX);
    const before = o.before ?? Number.MAX_SAFE_INTEGER;
    const s = this.live().s;
    const rows = o.runId ? s.listRun.all(o.runId, before, limit) : o.kind ? s.listKind.all(o.kind, before, limit) : s.listAll.all(before, limit);
    return (rows as Row[]).filter((r) => !o.kind || r.kind === o.kind).map(entryOf);
  }

  async scan(o: { after?: number; limit?: number } = {}): Promise<LedgerEntry[]> {
    return (this.live().s.scan.all(o.after ?? 0, pageLimit(o.limit, 1000, 10_000)) as Row[]).map(entryOf);
  }

  // ── worker pay (plans/human-steps.md §8.1) ──────────────────────────

  async pay(input: PayInput): Promise<PayResult> {
    const e = earningOf(input);
    return this.tx(() => {
      const known = this.s.payOf.get(e.lease) as Row | undefined;
      if (known) return { earning: earningRow(known), existing: true };
      this.s.insertPay.run(e.lease, e.task, e.worker, e.type, e.msat, e.at, e.releases, e.workflow, e.runId, e.path);
      this.s.payee.run(e.worker, e.msat, e.at);
      this.s.payDay.run(dayOf(e.at), e.type, e.msat);
      return { earning: e, existing: false };
    }, true);
  }

  async payOf(lease: string): Promise<Earning | undefined> {
    const row = this.live().s.payOf.get(lease) as Row | undefined;
    return row ? earningRow(row) : undefined;
  }

  async payFor(tasks: readonly string[]): Promise<Earning[]> {
    if (!tasks.length) return [];
    return (this.live().s.payFor.all(JSON.stringify(tasks)) as Row[]).map(earningRow);
  }

  async takeBack(input: TakeBackInput): Promise<TakeBackResult> {
    const at = input.at ?? Date.now();
    need("lease", input.lease);
    need("why", input.why);
    int("at", at);
    return this.tx<TakeBackResult>(() => {
      const row = this.s.payOf.get(input.lease) as Row | undefined;
      if (!row) return { lease: input.lease, result: "none" };
      if (Number(this.s.takeBack.run(at, input.why, input.by ?? null, input.lease).changes) === 1) {
        this.s.payeeTakenBack.run(row.msat as number, row.worker as string);
        this.s.payDayTakenBack.run(row.msat as number, dayOf(row.at as number), row.type as string);
        return { lease: input.lease, result: "taken", earning: earningRow(this.s.payOf.get(input.lease) as Row) };
      }
      const earning = earningRow(row);
      return { lease: input.lease, result: earning.takenBack !== undefined ? "taken" : "released", earning };
    }, true);
  }

  async payeeBalance(worker: string, o: { now?: number } = {}): Promise<PayeeBalance> {
    const s = this.live().s;
    const p = s.payeeRow.get(worker) as Row | undefined;
    if (!p) return { ...ZERO_BALANCE };
    const h = s.held.get(worker, o.now ?? Date.now()) as Row;
    return balanceRow(p, h);
  }

  async payeeBalances(workers: readonly string[], o: { now?: number } = {}): Promise<Record<string, PayeeBalance>> {
    if (!workers.length) return {};
    const s = this.live().s;
    const list = JSON.stringify(workers);
    const held = new Map((s.heldBy.all(list, o.now ?? Date.now()) as Row[]).map((r) => [r.worker as string, r]));
    const out: Record<string, PayeeBalance> = {};
    for (const p of s.payeeRows.all(list) as Row[]) out[p.worker as string] = balanceRow(p, held.get(p.worker as string));
    return out;
  }

  async payDaily(range: DayRange = {}): Promise<PayDailyRow[]> {
    return (this.live().s.payDaily.all(range.from ?? "0000-00-00", range.to ?? "9999-99-99") as Row[]).map((r) => ({
      day: r.day as string,
      type: r.type as string,
      answers: r.answers as number,
      msat: r.msat as number,
      takenBackAnswers: r.taken_back_answers as number,
      takenBackMsat: r.taken_back_msat as number,
    }));
  }

  async owedToWorkers(o: { now?: number } = {}): Promise<WorkersOwed> {
    const r = this.live().s.owed.get(o.now ?? Date.now()) as Row;
    const owedMsat = Number(r.owed ?? 0);
    const heldMsat = Number(r.held ?? 0);
    return { owedMsat, heldMsat, withdrawableMsat: owedMsat - heldMsat, payees: Number(r.payees ?? 0) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  // ── inside a transaction ───────────────────────────────────────────────

  private tx<T>(fn: () => T, full = false): T {
    const db = this.live().db;
    if (full) db.exec("PRAGMA synchronous = FULL");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // no transaction left to roll back
        }
        throw e;
      }
    } finally {
      if (full) db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  private entry(
    at: number,
    kind: EntryKind,
    e: Partial<Pick<LedgerEntry, "token" | "usd" | "msat" | "subject" | "runId" | "key" | "ref" | "cost" | "outcome" | "feeMsat" | "actor">>,
  ): number {
    const r = this.s.insertEntry.run(
      at,
      kind,
      e.token ?? null,
      e.usd ?? null,
      e.msat ?? null,
      e.subject ?? null,
      e.runId ?? null,
      e.key ?? null,
      e.ref ?? null,
      e.cost ?? null,
      e.outcome ?? null,
      e.feeMsat ?? null,
      e.actor ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  /** Moves `usd` of free credit from one token to another: a `carry`
   *  entry on each, the successor recorded on the one it left. */
  private move(at: number, from: TokenBalance, to: string, usd: Micros): Micros {
    const moved = Math.max(0, usd);
    this.s.carryOut.run(moved, to, from.id);
    this.s.carryIn.run(moved, to);
    this.entry(at, "carry", { token: from.id, usd: -moved || 0, ref: to });
    this.entry(at, "carry", { token: to, usd: moved, ref: from.id });
    return moved;
  }

  /** What is left on a token goes to the seller, under `expired`; with
   *  `closeAt`, the token is closed too. */
  private expire(at: number, token: string, usd: Micros, closeAt?: number): Micros {
    if (closeAt !== undefined) this.s.close.run(closeAt, usd, token);
    else this.s.spend.run(usd, token);
    this.entry(at, "expiry", { token, usd, subject: EXPIRED_SUBJECT });
    this.s.daily.run(dayOf(at), EXPIRED_SUBJECT, 0, 0, usd, 0);
    return usd;
  }

  private chainEnd(id: string): Row | undefined {
    let row = this.s.token.get(id) as Row | undefined;
    for (let hops = 0; row && row.successor !== null && hops < CHAIN_MAX; hops++) {
      row = this.s.token.get(row.successor as string) as Row | undefined;
    }
    return row;
  }

  private live(): this {
    if (this.closed) throw new Error(`ledger ${this.file} is closed`);
    return this;
  }
}

function need(name: string, v: string | undefined): void {
  if (typeof v !== "string" || !v) throw new RangeError(`${name} is required`);
}

function freeOf(t: Row): number {
  return (t.paid as number) - (t.spent as number) - (t.held as number);
}

function tokenOf(r: Row): TokenBalance {
  const t: TokenBalance = {
    id: r.id as string,
    paymentHash: r.payment_hash as string,
    paid: r.paid as number,
    spent: r.spent as number,
    held: r.held as number,
    free: freeOf(r),
    rate: r.rate as number,
    msat: r.msat as number,
    created: r.created as number,
    expires: r.expires as number,
  };
  if (r.closed !== null) t.closed = r.closed as number;
  if (r.successor !== null) t.successor = r.successor as string;
  return t;
}

const ENTRY_FIELDS: Array<[string, keyof LedgerEntry]> = [
  ["token", "token"],
  ["usd", "usd"],
  ["msat", "msat"],
  ["subject", "subject"],
  ["run_id", "runId"],
  ["key", "key"],
  ["ref", "ref"],
  ["cost", "cost"],
  ["outcome", "outcome"],
  ["fee_msat", "feeMsat"],
  ["actor", "actor"],
];

function entryOf(r: Row): LedgerEntry {
  const e: Record<string, unknown> = { seq: r.seq, at: r.at, kind: r.kind };
  for (const [col, field] of ENTRY_FIELDS) if (r[col] !== null && r[col] !== undefined) e[field] = r[col];
  return e as unknown as LedgerEntry;
}

function depositOf(r: Row): Deposit {
  const d: Deposit = { at: r.at as number, msat: r.msat as number, paymentHash: r.payment_hash as string };
  if (r.actor !== null) d.actor = r.actor as string;
  return d;
}

function holdOf(r: Row): OpenHold {
  const h: OpenHold = {
    seq: r.seq as number,
    at: r.at as number,
    token: r.token as string,
    runId: r.run_id as string,
    subject: r.subject as string,
    reserve: r.usd as number,
  };
  if (r.key !== null) h.key = r.key as string;
  return h;
}

function earningRow(r: Row): Earning {
  const e: Earning = {
    lease: r.lease as string,
    task: r.task as string,
    worker: r.worker as string,
    type: r.type as string,
    msat: r.msat as number,
    at: r.at as number,
    releases: r.releases as number,
    workflow: r.workflow as string,
    runId: r.run_id as string,
    path: r.path as string,
  };
  if (r.taken_back !== null && r.taken_back !== undefined) e.takenBack = r.taken_back as number;
  if (r.taken_back_why !== null && r.taken_back_why !== undefined) e.takenBackWhy = r.taken_back_why as string;
  if (r.taken_back_by !== null && r.taken_back_by !== undefined) e.takenBackBy = r.taken_back_by as string;
  return e;
}

/** A payee's row and the sum of its held earnings (absent: none held). */
function balanceRow(p: Row, h: Row | undefined): PayeeBalance {
  const next = h?.next;
  return payeeBalanceOf({
    accepted: p.accepted as number,
    takenBack: p.taken_back as number,
    withdrawn: p.withdrawn as number,
    held: Number(h?.held ?? 0),
    ...(next !== null && next !== undefined ? { nextReleaseAt: next as number } : {}),
  });
}

function rowOf(r: Row): EarningsRow {
  return {
    key: r.key as string,
    calls: Number(r.calls ?? 0),
    failed: Number(r.failed ?? 0),
    earned: Number(r.earned ?? 0),
    cost: Number(r.cost ?? 0),
  };
}
