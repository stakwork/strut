/**
 * The ledger in memory: `ledger-sqlite.ts`'s twin for tests and in-memory
 * deployments, passing the same conformance suite (ledger.test.ts). Every
 * method checks before it changes anything and never awaits in between, so
 * each is one step, as a transaction is on the file.
 */
import {
  chargeFor,
  creditFor,
  dayOf,
  int,
  LedgerError,
  msRange,
  pageLimit,
  positiveInt,
  rollUp,
  ENTRIES_PAGE,
  ENTRIES_PAGE_MAX,
  EXPIRED_SUBJECT,
  RECENT_DAYS,
  type ChargeInput,
  type ChargeResult,
  type DayRange,
  type EarningsQuery,
  type EarningsRow,
  type EntryKind,
  type FirstUseInput,
  type FirstUseResult,
  type HoldInput,
  type HoldResult,
  type LedgerEntry,
  type LedgerStore,
  type Micros,
  type OpenHold,
  type Outstanding,
  type ReceivedRow,
  type Recent,
  type SweepResult,
  type TokenBalance,
  type WithdrawalInput,
  type WithdrawnRow,
} from "./ledger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHAIN_MAX = 64;

type TokenRow = Omit<TokenBalance, "free">;
type DailyRow = EarningsRow & { day: string; subject: string };

const k = (...parts: Array<string | undefined>) => parts.map((p) => p ?? "").join("\0");

export class MemoryLedgerStore implements LedgerStore {
  private readonly tokens = new Map<string, TokenRow>();
  private readonly byHash = new Map<string, string>();
  private readonly log: LedgerEntry[] = [];
  private readonly byToken = new Map<string, LedgerEntry[]>();
  private readonly holdByKey = new Map<string, LedgerEntry>();
  private readonly holdByRun = new Map<string, LedgerEntry>();
  private readonly chargeByRun = new Map<string, LedgerEntry>();
  private readonly days = new Map<string, DailyRow>();

  // ── writes ────────────────────────────────────────────────────────────

  async firstUse(input: FirstUseInput): Promise<FirstUseResult> {
    const at = input.at ?? Date.now();
    need("id", input.id);
    need("paymentHash", input.paymentHash);
    int("expires", input.expires);
    if (!Number.isFinite(input.rate) || input.rate <= 0) throw new RangeError(`rate must be dollars per bitcoin > 0: ${input.rate}`);
    const credited = creditFor(input);
    const known = this.tokens.get(input.id);
    if (known) return { token: balance(known), created: false, credited: 0, carried: 0 };
    const other = this.byHash.get(input.paymentHash);
    if (other) throw new LedgerError("payment_reused", `payment ${input.paymentHash} already bought token ${other}`);
    const t: TokenRow = {
      id: input.id,
      paymentHash: input.paymentHash,
      paid: credited,
      spent: 0,
      held: 0,
      rate: input.rate,
      msat: input.settledMsat,
      created: at,
      expires: input.expires,
    };
    this.tokens.set(t.id, t);
    this.byHash.set(t.paymentHash, t.id);
    this.entry(at, "payment", { token: t.id, usd: credited, msat: input.settledMsat, ref: input.paymentHash });
    let carried = 0;
    if (input.carryFrom && input.carryFrom !== input.id) {
      const from = this.tokens.get(input.carryFrom);
      if (from && from.closed === undefined && from.successor === undefined && from.expires > at) {
        carried = this.move(at, from, t, freeOf(from));
      }
    }
    return { token: balance(t), created: true, credited, carried };
  }

  async hold(input: HoldInput): Promise<HoldResult> {
    const at = input.at ?? Date.now();
    positiveInt("reserve", input.reserve);
    need("subject", input.subject);
    need("runId", input.runId);
    if (input.key !== undefined) {
      const first = this.holdByKey.get(k(input.token, input.key));
      if (first) return { ok: true, existing: true, seq: first.seq, runId: first.runId!, reserve: first.usd!, subject: first.subject! };
    }
    const same = this.holdByRun.get(k(input.token, input.runId));
    if (same) return { ok: true, existing: true, seq: same.seq, runId: same.runId!, reserve: same.usd!, subject: same.subject! };
    const t = this.tokens.get(input.token);
    if (!t) return { ok: false, reason: "unknown", free: 0 };
    const free = freeOf(t);
    if (t.successor !== undefined) return { ok: false, reason: "carried", free: Math.max(0, free), successor: t.successor };
    if (t.closed !== undefined) return { ok: false, reason: "closed", free: Math.max(0, free) };
    if (t.expires <= at) return { ok: false, reason: "expired", free: Math.max(0, free) };
    if (free < input.reserve) return { ok: false, reason: "short", free: Math.max(0, free) };
    t.held += input.reserve;
    const e = this.entry(at, "hold", { token: t.id, usd: input.reserve, subject: input.subject, runId: input.runId, key: input.key });
    if (input.key !== undefined) this.holdByKey.set(k(t.id, input.key), e);
    this.holdByRun.set(k(t.id, input.runId), e);
    return { ok: true, existing: false, seq: e.seq, runId: input.runId, reserve: input.reserve, subject: input.subject };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const at = input.at ?? Date.now();
    need("runId", input.runId);
    need("subject", input.subject);
    const cost = int("cost", input.cost);
    const failed = input.outcome === "error" ? 1 : 0;
    if (input.token === undefined) {
      const due = chargeFor(input.price, cost, input.outcome);
      const key = k("", input.runId, input.subject);
      const done = this.chargeByRun.get(key);
      if (done) return { seq: done.seq, charged: 0, due, reserve: 0, existing: true };
      const e = this.entry(at, "charge", { usd: 0, subject: input.subject, runId: input.runId, cost, outcome: input.outcome });
      this.chargeByRun.set(key, e);
      this.daily(at, input.subject, 1, failed, 0, cost);
      return { seq: e.seq, charged: 0, due, reserve: 0, existing: false };
    }
    const token = input.token;
    const hold = this.holdByRun.get(k(token, input.runId));
    if (!hold) {
      if (!this.tokens.has(token)) throw new LedgerError("unknown_token", `no token ${token}`);
      throw new LedgerError("no_hold", `token ${token} holds nothing for run ${input.runId}`);
    }
    if (hold.subject !== input.subject) {
      throw new LedgerError("subject_mismatch", `run ${input.runId} was held for ${hold.subject}, charged as ${input.subject}`);
    }
    const reserve = hold.usd!;
    const done = this.chargeByRun.get(k(token, input.runId));
    if (done) {
      const due = chargeFor(input.price, done.cost!, done.outcome!, reserve);
      return { seq: done.seq, charged: done.usd!, due, reserve, existing: true };
    }
    const t = this.tokens.get(token)!;
    const available = Math.max(0, t.paid - t.spent - (t.held - reserve));
    const due = chargeFor(input.price, cost, input.outcome, reserve);
    const charged = Math.min(due, available);
    t.held -= reserve;
    t.spent += charged;
    const e = this.entry(at, "charge", { token, usd: charged, subject: input.subject, runId: input.runId, cost, outcome: input.outcome });
    this.chargeByRun.set(k(token, input.runId), e);
    this.daily(at, input.subject, 1, failed, charged, cost);
    const result: ChargeResult = { seq: e.seq, charged, due, reserve, existing: false };
    const left = freeOf(t);
    if (left > 0 && t.successor !== undefined) {
      const end = this.chainEnd(t.successor);
      if (end && end.closed === undefined) result.carried = { to: end.id, usd: this.move(at, t, end, left) };
      else result.expired = this.expire(at, t, left);
    } else if (left > 0 && t.closed !== undefined) {
      result.expired = this.expire(at, t, left);
    }
    return result;
  }

  async sweep(o: { now?: number } = {}): Promise<SweepResult> {
    const now = o.now ?? Date.now();
    let closed = 0;
    let expired = 0;
    for (const t of this.tokens.values()) {
      if (t.closed !== undefined || t.expires > now) continue;
      expired += this.expire(now, t, Math.max(0, freeOf(t)), now);
      closed++;
    }
    return { closed, expired };
  }

  async withdrawal(input: WithdrawalInput): Promise<LedgerEntry> {
    const at = input.at ?? Date.now();
    positiveInt("msat", input.msat);
    need("paymentHash", input.paymentHash);
    if (input.feeMsat !== undefined) int("feeMsat", input.feeMsat);
    if (input.usd !== undefined) int("usd", input.usd);
    return { ...this.entry(at, "withdrawal", { msat: input.msat, feeMsat: input.feeMsat, ref: input.paymentHash, actor: input.actor, usd: input.usd }) };
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async token(id: string): Promise<TokenBalance | undefined> {
    const t = this.tokens.get(id);
    return t ? balance(t) : undefined;
  }

  async entries(token: string, o: { limit?: number; before?: number } = {}): Promise<LedgerEntry[]> {
    const limit = pageLimit(o.limit, ENTRIES_PAGE, ENTRIES_PAGE_MAX);
    const before = o.before ?? Number.MAX_SAFE_INTEGER;
    const out: LedgerEntry[] = [];
    const list = this.byToken.get(token) ?? [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) if (list[i].seq < before) out.push({ ...list[i] });
    return out;
  }

  async findHold(token: string, key: string): Promise<OpenHold | undefined> {
    const e = this.holdByKey.get(k(token, key));
    return e ? holdOf(e) : undefined;
  }

  async openHolds(): Promise<OpenHold[]> {
    const out: OpenHold[] = [];
    for (const t of this.tokens.values()) {
      if (t.held <= 0) continue;
      for (const e of this.byToken.get(t.id) ?? []) {
        if (e.kind === "hold" && !this.chargeByRun.has(k(t.id, e.runId))) out.push(holdOf(e));
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async earnings(q: EarningsQuery): Promise<EarningsRow[]> {
    const from = q.from ?? "0000-00-00";
    const to = q.to ?? "9999-99-99";
    return rollUp([...this.days.values()].filter((r) => r.day >= from && r.day <= to), q);
  }

  async received(range?: DayRange): Promise<ReceivedRow[]> {
    const [from, to] = msRange(range);
    const out = new Map<string, ReceivedRow>();
    for (const e of this.log) {
      if (e.kind !== "payment" || e.at < from || e.at >= to) continue;
      const day = dayOf(e.at);
      const r = out.get(day) ?? { day, count: 0, msat: 0, usd: 0 };
      r.count++;
      r.msat += e.msat ?? 0;
      r.usd += e.usd ?? 0;
      out.set(day, r);
    }
    return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  async withdrawn(range?: DayRange): Promise<WithdrawnRow[]> {
    const [from, to] = msRange(range);
    const out = new Map<string, WithdrawnRow>();
    for (const e of this.log) {
      if (e.kind !== "withdrawal" || e.at < from || e.at >= to) continue;
      const day = dayOf(e.at);
      const r = out.get(day) ?? { day, count: 0, msat: 0, feeMsat: 0 };
      r.count++;
      r.msat += e.msat ?? 0;
      r.feeMsat += e.feeMsat ?? 0;
      out.set(day, r);
    }
    return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  async outstanding(): Promise<Outstanding> {
    const o: Outstanding = { tokens: 0, usd: 0, held: 0 };
    for (const t of this.tokens.values()) {
      if (t.closed !== undefined) continue;
      if (t.successor === undefined) o.tokens++;
      o.usd += t.paid - t.spent;
      o.held += t.held;
    }
    return o;
  }

  async recent(subject: string, o: { now?: number; days?: number } = {}): Promise<Recent> {
    const now = o.now ?? Date.now();
    const days = Math.max(1, Math.floor(o.days ?? RECENT_DAYS));
    const from = dayOf(now - (days - 1) * DAY_MS);
    const to = dayOf(now);
    let runs = 0;
    let failed = 0;
    let earned = 0;
    for (const r of this.days.values()) {
      if (r.subject !== subject || r.day < from || r.day > to) continue;
      runs += r.calls;
      failed += r.failed;
      earned += r.earned;
    }
    return { days, runs, failed, earned, average: runs ? Math.round(earned / runs) : 0 };
  }

  async today(subject: string, o: { now?: number } = {}): Promise<EarningsRow> {
    const r = this.days.get(k(dayOf(o.now ?? Date.now()), subject));
    return { key: subject, calls: r?.calls ?? 0, failed: r?.failed ?? 0, earned: r?.earned ?? 0, cost: r?.cost ?? 0 };
  }

  async scan(o: { after?: number; limit?: number } = {}): Promise<LedgerEntry[]> {
    const after = o.after ?? 0;
    const limit = pageLimit(o.limit, 1000, 10_000);
    return this.log.slice(after, after + limit).map((e) => ({ ...e }));
  }

  async close(): Promise<void> {}

  // ── the steps of a write ───────────────────────────────────────────────

  private entry(at: number, kind: EntryKind, fields: Partial<LedgerEntry>): LedgerEntry {
    const e: LedgerEntry = { seq: this.log.length + 1, at, kind };
    for (const [name, v] of Object.entries(fields)) if (v !== undefined) (e as unknown as Record<string, unknown>)[name] = v;
    this.log.push(e);
    if (e.token !== undefined) {
      const list = this.byToken.get(e.token) ?? [];
      list.push(e);
      this.byToken.set(e.token, list);
    }
    return e;
  }

  private move(at: number, from: TokenRow, to: TokenRow, usd: Micros): Micros {
    const moved = Math.max(0, usd);
    from.spent += moved;
    from.successor = to.id;
    to.paid += moved;
    this.entry(at, "carry", { token: from.id, usd: -moved || 0, ref: to.id });
    this.entry(at, "carry", { token: to.id, usd: moved, ref: from.id });
    return moved;
  }

  private expire(at: number, t: TokenRow, usd: Micros, closeAt?: number): Micros {
    if (closeAt !== undefined) t.closed = closeAt;
    t.spent += usd;
    this.entry(at, "expiry", { token: t.id, usd, subject: EXPIRED_SUBJECT });
    this.daily(at, EXPIRED_SUBJECT, 0, 0, usd, 0);
    return usd;
  }

  private daily(at: number, subject: string, calls: number, failed: number, earned: Micros, cost: Micros): void {
    const day = dayOf(at);
    const key = k(day, subject);
    const r = this.days.get(key) ?? { key: subject, day, subject, calls: 0, failed: 0, earned: 0, cost: 0 };
    r.calls += calls;
    r.failed += failed;
    r.earned += earned;
    r.cost += cost;
    this.days.set(key, r);
  }

  private chainEnd(id: string): TokenRow | undefined {
    let t = this.tokens.get(id);
    for (let hops = 0; t && t.successor !== undefined && hops < CHAIN_MAX; hops++) t = this.tokens.get(t.successor);
    return t;
  }
}

function need(name: string, v: string | undefined): void {
  if (typeof v !== "string" || !v) throw new RangeError(`${name} is required`);
}

function freeOf(t: TokenRow): number {
  return t.paid - t.spent - t.held;
}

function balance(t: TokenRow): TokenBalance {
  const b: TokenBalance = {
    id: t.id,
    paymentHash: t.paymentHash,
    paid: t.paid,
    spent: t.spent,
    held: t.held,
    free: freeOf(t),
    rate: t.rate,
    msat: t.msat,
    created: t.created,
    expires: t.expires,
  };
  if (t.closed !== undefined) b.closed = t.closed;
  if (t.successor !== undefined) b.successor = t.successor;
  return b;
}

function holdOf(e: LedgerEntry): OpenHold {
  const h: OpenHold = { seq: e.seq, at: e.at, token: e.token!, runId: e.runId!, subject: e.subject!, reserve: e.usd! };
  if (e.key !== undefined) h.key = e.key;
  return h;
}
