/**
 * PUBLIC RUNS (plans/paid-runs.md §3, §6, §7; work item 3, free runs): the
 * policy behind `POST /public/workflows/:name/run` — what a launch is
 * admitted against, what a run in flight counts for, and what is charged
 * when it ends. The route is `src/public-routes.ts`'s, the launch
 * createStrut's (`launchDetached` with `origin: "public"`).
 *
 * - **The caps** (`admit`, §3 step 3): the server's limit on public runs in
 *   flight, then the item's `dailyCapUsd` — today's `daily.cost` for the
 *   item in the ledger, plus the cap of each of its runs in flight, reaching
 *   it refuses the launch (§7). Admission is SERIAL: the check and counting
 *   the new run are one step, so twenty launches in one second stay inside
 *   the cap. A `key` the same caller sent for a run still in flight returns
 *   that run, before any cap.
 * - **The run's cap** (§7): the smallest of the item's per-run cap — its
 *   `capUsd`, else a tenth of its daily cap (`perRunCapUsd`), so ten runs
 *   fit in the day's cap at once rather than one — the workflow's own (its
 *   `maxRunCostUsd`, else the deployment's, as `resolveRunCap` reads it) and
 *   what is left of the daily cap. It rides on the launch as
 *   `RunOptions.maxCostUsd` to `llmAuth`.
 * - **The charge** (`ended`, §5): when the run ends — success, error,
 *   cancelled, or finished by a durable resume after a restart — the ledger
 *   records it with no token, a charge of nothing that counts its cost in
 *   `daily`, which the daily cap reads. The ledger is idempotent on the run,
 *   so a second call writes nothing.
 * - **What outlives a restart.** Each admitted run is written to
 *   `<dataDir>/payments/public-runs.json` before it launches and taken off
 *   once it is charged. At boot (`load`) every run on file counts as in
 *   flight; once auto-resume has relaunched what it will, `reconcile`
 *   charges the rest: a run that ended (its summary, or its log's end), and
 *   one cut off that nothing resumed, at what its log says it cost. A run
 *   that never wrote `run.start` is dropped: nothing ran.
 *
 * - **A priced run** (item 5, §5): after the caps, `admission.hold` puts
 *   the credit token and the price of that moment on the run's entry, on
 *   file, and THEN sets the reserve aside in the ledger, under the run id
 *   the caps minted — so a hold always names a run on file or one the boot
 *   finds in the ledger. A hold refused, or a launch that fails after it,
 *   lets the admission go and frees the hold (a charge of nothing). The
 *   run's end charges the token by the rule (`chargeFor`, the ledger's):
 *   base + markup × cost, a failed run its cost, and never more than its
 *   reserve: what a run spent past it is the seller's.
 * - **Holds outlive a restart.** `reconcile(live, { holds: true })` also
 *   reads the ledger's open holds: one whose run is not on file (its file
 *   was lost) and not live is charged from its run's log, at the item's
 *   price now; one whose run never started is freed.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunEvent } from "./core.js";
import type { RunStore } from "./store.js";
import { generateRunId } from "./store.js";
import { summaryFromLog } from "./runner.js";
import { FREE, LedgerError, microsToUsd, usdToMicros, type HoldResult, type LedgerStore, type Micros, type Price, type RunOutcome } from "./payments/ledger.js";
import { perRunCapUsd, runnableSubject } from "./public-runnable.js";
import type { PublicRunnable } from "./public-surface.js";

/** The most a launch body may be (§3 step 2). */
export const PUBLIC_RUN_BODY_MAX_BYTES = 256 * 1024;
/** Launches one visitor address may make in a minute: a smaller allowance
 *  than the reads' (`PUBLIC_REQUESTS_PER_MINUTE`, 1200). */
export const PUBLIC_LAUNCHES_PER_MINUTE = 60;
/** Public runs in flight on this server at once, by default
 *  (`STRUT_PUBLIC_RUNS_MAX`, `createStrut({ publicRuns: { maxInFlight } })`). */
export const PUBLIC_RUNS_MAX_IN_FLIGHT = 10;
/** A launch's retry `key`, at most. */
export const PUBLIC_RUN_KEY_MAX = 200;
/** The most a launcher's read holds with `?wait=` (seconds). */
export const PUBLIC_RUN_WAIT_MAX_S = 55;
/** Where the runs not yet charged are kept, under `<dataDir>/payments/`. */
export const PUBLIC_RUNS_FILE = "public-runs.json";

/** A public run admitted and not yet charged. */
export interface PublicRunEntry {
  workflow: string;
  runId: string;
  /** The ledger's subject: `workflow:<name>`. */
  subject: string;
  /** The run's cap, micro-dollars — what the daily cap counts it at while
   *  it is in flight. Absent on a run that had none. */
  cap?: Micros;
  /** Epoch ms it was admitted. */
  at: number;
  /** A priced run's credit token (its id), and the price and reserve at its
   *  launch: what its end charges, whatever the record says by then. */
  token?: string;
  price?: Price;
  reserve?: Micros;
}

export type Admission =
  | {
      ok: true;
      runId: string;
      /** The run's own cap in dollars (`RunOptions.maxCostUsd`); absent
       *  when nothing caps it here (no item cap, no workflow cap passed). */
      capUsd?: number;
      /** A refusal after the caps (the price's 402) lets it go; after a
       *  hold, frees it too. */
      release(): void;
      /** A priced run (§5): the token and the price on the entry, on file,
       *  then the reserve set aside under this run's id. A refusal lets the
       *  admission go; so does a hold that names another run (the same
       *  token and `key` as an earlier launch: `existing`, its run). Throws
       *  when the ledger or the file cannot be written, the admission let go. */
      hold(o: { token: string; price: Price; reserve: Micros; key?: string }): Promise<HoldResult>;
    }
  /** The same caller's `key` names a run still in flight. */
  | { ok: "existing"; runId: string }
  | { ok: false; status: 429 | 503; error: string; retryAfter: number };

export interface PublicRunsOptions {
  ledger: () => Promise<LedgerStore>;
  store: Pick<RunStore, "getRunSummary" | "getRunEvents">;
  /** The file the runs not yet charged are kept in; none = memory (a memory
   *  run store, whose runs do not outlive the process either). */
  file?: string;
  /** An item's price now, by its subject: what a priced run whose entry was
   *  lost is charged at. Without it, or for an item gone, nothing but the
   *  rule's cost part of a failed run. */
  price?: (subject: string) => Promise<Price | undefined>;
  maxInFlight?: number;
  now?: () => number;
  /** When a run's charge failed at its end, the waits before it is tried
   *  again, the last repeated until it goes through (`SETTLE_RETRY_MS`). */
  settleRetryMs?: readonly number[];
}

/** A charge that failed at a run's end (the ledger busy past its timeout, a
 *  store read that threw) is tried again after these waits, the last one
 *  repeated, rather than left until the next boot: until then the run holds
 *  its cap against the daily cap, a slot of the server's in-flight limit
 *  and its token's reserve, and its launcher never sees it end. */
export const SETTLE_RETRY_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];

export interface PublicRuns {
  /** The caps step: the in-flight limit and the item's daily cap, serial.
   *  An admitted run is counted, minted an id and on file before this
   *  answers. `scope` is who the `key` belongs to (the visitor's address). */
  admit(item: PublicRunnable, o: { workflowCapUsd?: number; key?: string; scope?: string }): Promise<Admission>;
  /** A public run in flight again: a durable resume of one, with the credit
   *  token its `run.start` names. */
  track(workflow: string, runId: string, capUsd?: number, token?: string): Promise<void>;
  /** The run ended: charge it, then let it go. Never throws. */
  ended(workflow: string, runId: string): Promise<void>;
  /** Admitted and not yet charged. */
  pending(workflow: string, runId: string): boolean;
  /** What the run was charged, once it was: micro-dollars. */
  charged(workflow: string, runId: string): Promise<Micros | undefined>;
  /** How many public runs this server counts in flight. */
  inFlight(): number;
  /** Boot: every run on file counts as in flight until `reconcile`. */
  load(): Promise<void>;
  /** Boot, after auto-resume: charge every run on file that is not live —
   *  and, with `holds`, every open hold in the ledger whose run is neither
   *  on file nor live. */
  reconcile(
    live: (workflow: string, runId: string) => boolean,
    o?: { holds?: boolean },
  ): Promise<Array<{ workflow: string; runId: string; action: "charged" | "dropped" | "failed" | "live" }>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const keyOf = (workflow: string, runId: string) => `${workflow}\0${runId}`;

/** Seconds until the next UTC day, when a spent daily cap is free again. */
export function secondsToUtcMidnight(now: number): number {
  return Math.max(1, Math.ceil((Math.floor(now / DAY_MS + 1) * DAY_MS - now) / 1000));
}

const usd = (micros: Micros) => `$${microsToUsd(micros).toFixed(2)}`;
const isTerminal = (e: RunEvent) => e.type === "run.end" || e.type === "run.error" || e.type === "run.cancelled";

/**
 * Whether the daily cap has room for one more run, and the run's cap if so
 * (§7). `full` is the cap the run would have with the day out of the
 * picture: the item's per-run cap and the workflow's, the smaller. Runs in
 * flight count at their caps (`held`).
 *
 * - While what is left of the day holds a FULL cap, a run gets one — never a
 *   sliver that the gateway would stop partway, the buyer paying for a run
 *   that could not finish.
 * - Past that, the last of the day goes to one run at a time, its cap what
 *   is left: with nothing of the item in flight and something left, a run is
 *   admitted with that.
 * - Otherwise a 429: `spent` when the day's cost alone reached the cap.
 */
export function dailyRoom(o: { daily: Micros; today: Micros; held: Micros; inFlight: number; full: Micros }):
  | { ok: true; cap: Micros }
  | { ok: false; spent: boolean } {
  const left = o.daily - o.today - o.held;
  if (o.today >= o.daily) return { ok: false, spent: true };
  if (left >= o.full) return { ok: true, cap: o.full };
  if (o.inFlight === 0 && left > 0) return { ok: true, cap: left };
  return { ok: false, spent: false };
}

export function createPublicRuns(o: PublicRunsOptions): PublicRuns {
  const now = o.now ?? Date.now;
  const max = o.maxInFlight ?? PUBLIC_RUNS_MAX_IN_FLIGHT;
  /** Counted in flight: admitted, resumed, or on file at boot. */
  const flights = new Map<string, PublicRunEntry>();
  /** On file: admitted and not yet charged. */
  const onFile = new Map<string, PublicRunEntry>();
  /** `<workflow>\0<scope>\0<key>` → the run it launched, while in flight. */
  const keys = new Map<string, string>();

  // The file is rewritten whole (it holds the runs in flight, a handful) on
  // one chain, through a scratch file and a rename.
  let writes: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    if (!o.file) return Promise.resolve();
    const file = o.file;
    const body = JSON.stringify([...onFile.values()]) + "\n";
    const next = writes.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, file);
    });
    writes = next.catch(() => undefined);
    return next;
  };

  // Admission is one step at a time: the check and counting the run.
  let serial: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = serial.then(fn, fn);
    serial = p.catch(() => undefined);
    return p;
  };

  const forget = (k: string) => {
    flights.delete(k);
    for (const [kk, id] of keys) if (keyOf(kk.slice(0, kk.indexOf("\0")), id) === k) keys.delete(kk);
  };

  const admit: PublicRuns["admit"] = (item, a) =>
    oneAtATime(async (): Promise<Admission> => {
      const subject = runnableSubject(item);
      const keyed = a.key !== undefined ? `${item.name}\0${a.scope ?? ""}\0${a.key}` : undefined;
      if (keyed) {
        const prior = keys.get(keyed);
        if (prior && flights.has(keyOf(item.name, prior))) return { ok: "existing", runId: prior };
      }
      if (flights.size >= max) {
        return { ok: false, status: 429, error: `too many public runs in flight on this server (${max}) — try again when one ends`, retryAfter: 30 };
      }
      const caps: Micros[] = [];
      const own = perRunCapUsd(item);
      if (own !== undefined) caps.push(usdToMicros(own));
      if (a.workflowCapUsd !== undefined) caps.push(usdToMicros(a.workflowCapUsd));
      if (item.dailyCapUsd !== undefined) {
        const daily = usdToMicros(item.dailyCapUsd);
        let today: Micros;
        try {
          today = (await (await o.ledger()).today(subject, { now: now() })).cost;
        } catch (err) {
          console.error(`[public-runs] reading today's spend of ${subject} failed:`, err);
          return { ok: false, status: 503, error: "the ledger cannot be read just now — try again shortly", retryAfter: 30 };
        }
        // A run in flight counts at its cap. Every run admitted under a daily
        // cap has one (`perRunCapUsd`); an entry on file without one, at the
        // whole cap.
        let held = 0;
        let inFlight = 0;
        for (const f of flights.values()) {
          if (f.subject !== subject) continue;
          held += f.cap ?? daily;
          inFlight++;
        }
        const room = dailyRoom({ daily, today, held, inFlight, full: caps.length ? Math.min(...caps) : daily });
        if (!room.ok) {
          return {
            ok: false,
            status: 429,
            error: room.spent
              ? `${item.kind} "${item.name}" has spent its daily cap (${usd(daily)}) — try again tomorrow (UTC)`
              : `${item.kind} "${item.name}" has its daily cap (${usd(daily)}) set aside for runs in flight — try again when one ends`,
            retryAfter: room.spent ? secondsToUtcMidnight(now()) : 60,
          };
        }
        caps.push(room.cap);
      }
      const cap = caps.length ? Math.max(1, Math.min(...caps)) : undefined;
      const runId = generateRunId();
      const entry: PublicRunEntry = { workflow: item.name, runId, subject, ...(cap !== undefined ? { cap } : {}), at: now() };
      const k = keyOf(item.name, runId);
      flights.set(k, entry);
      if (keyed) keys.set(keyed, runId);
      onFile.set(k, entry);
      let released = false;
      let held: string | undefined;
      const release = () => {
        if (released) return;
        released = true;
        forget(k);
        onFile.delete(k);
        void save().catch(() => undefined);
        // A hold whose run will not launch is freed: a charge of nothing.
        if (held) void freeHold(held, runId, subject);
      };
      try {
        await save();
      } catch (err) {
        console.error(`[public-runs] recording ${item.name}/${runId} failed:`, err);
        release();
        return { ok: false, status: 503, error: "this server cannot record a public run just now — try again shortly", retryAfter: 30 };
      }
      const hold = async (h: { token: string; price: Price; reserve: Micros; key?: string }): Promise<HoldResult> => {
        if (released) throw new Error(`public run ${item.name}/${runId} was let go before its hold`);
        // On file first, so a hold always names a run the boot can find.
        entry.token = h.token;
        entry.price = h.price;
        entry.reserve = h.reserve;
        let res: HoldResult;
        try {
          await save();
          res = await (await o.ledger()).hold({ token: h.token, reserve: h.reserve, subject, runId, ...(h.key !== undefined ? { key: h.key } : {}), at: now() });
        } catch (err) {
          release();
          throw err;
        }
        if (res.ok && res.runId === runId && !res.existing) held = h.token;
        else release();
        return res;
      };
      return { ok: true, runId, ...(cap !== undefined ? { capUsd: microsToUsd(cap) } : {}), release, hold };
    });

  const track: PublicRuns["track"] = async (workflow, runId, capUsd, token) => {
    const k = keyOf(workflow, runId);
    const known = flights.get(k) ?? onFile.get(k);
    const entry: PublicRunEntry = known ?? {
      workflow,
      runId,
      subject: runnableSubject({ kind: "workflow", name: workflow }),
      ...(capUsd !== undefined ? { cap: usdToMicros(capUsd) } : {}),
      at: now(),
      ...(token ? { token } : {}),
    };
    flights.set(k, entry);
    if (!onFile.has(k)) {
      onFile.set(k, entry);
      await save().catch((err) => console.error(`[public-runs] recording ${workflow}/${runId} failed:`, err));
    }
  };

  /** What a run cost and how it ended: its summary, else its log (a log
   *  that never ended is charged as an error, at what it spent so far).
   *  Null when it never wrote `run.start`: nothing ran. */
  const outcomeOf = async (workflow: string, runId: string): Promise<{ outcome: RunOutcome; cost: number } | null> => {
    const summary = await o.store.getRunSummary(workflow, runId);
    if (summary) return { outcome: summary.status, cost: summary.totals?.cost ?? 0 };
    const events = await o.store.getRunEvents(workflow, runId);
    if (!events.some((e) => e.type === "run.start")) return null;
    const last = events[events.length - 1]!;
    const outcome: RunOutcome = !isTerminal(last) ? "error" : last.type === "run.end" ? "success" : last.type === "run.cancelled" ? "cancelled" : "error";
    return { outcome, cost: summaryFromLog(workflow, runId, events, outcome).totals?.cost ?? 0 };
  };

  /** Free a hold whose run never ran or never launched: a charge of
   *  nothing (`error` at no cost — the rule's `min(cost, reserve)`), which
   *  `daily` counts as a failed call. Never throws. */
  async function freeHold(token: string, runId: string, subject: string): Promise<void> {
    try {
      await (await o.ledger()).charge({ token, runId, subject, cost: 0, outcome: "error", price: FREE, at: now() });
    } catch (err) {
      if (err instanceof LedgerError && err.code === "no_hold") return;
      console.error(`[public-runs] freeing the hold of ${subject} run ${runId} failed (the boot reconcile frees it):`, err);
    }
  }

  /** Charge the run and let it go: `charged`, `dropped` (it never ran; a
   *  hold set aside for it is freed), or `failed` — left counted and on
   *  file, for the next boot. `held` is a hold the ledger knows of a run
   *  that is not on file. */
  const settle = async (workflow: string, runId: string, held?: { token: string; subject: string }): Promise<"charged" | "dropped" | "failed"> => {
    const k = keyOf(workflow, runId);
    const entry = flights.get(k) ?? onFile.get(k);
    const subject = entry?.subject ?? held?.subject ?? runnableSubject({ kind: "workflow", name: workflow });
    let action: "charged" | "dropped";
    try {
      // A run known here has its token on its entry (none: a free run). One
      // whose entry was lost names it on its `run.start`.
      const token = entry ? entry.token : (held?.token ?? (await o.store.getRunEvents(workflow, runId)).find((e) => e.type === "run.start")?.credit);
      const got = await outcomeOf(workflow, runId);
      action = got ? "charged" : "dropped";
      if (got) {
        const cost = Number.isFinite(got.cost) && got.cost > 0 ? usdToMicros(got.cost) : 0;
        // A priced run's price is the one at its launch; an entry lost, the
        // item's now.
        const price = token ? (entry?.price ?? (await o.price?.(subject)) ?? FREE) : FREE;
        try {
          await (await o.ledger()).charge({ runId, subject, cost, outcome: got.outcome, price, ...(token ? { token } : {}), at: now() });
        } catch (err) {
          // The launch wrote the token on file and the hold never followed
          // (a crash between them): nothing was set aside, nothing to charge.
          if (!(err instanceof LedgerError && err.code === "no_hold")) throw err;
          console.warn(`[public-runs] ${workflow}/${runId}: no hold on its token to charge`);
        }
      } else if (token) await freeHold(token, runId, subject);
    } catch (err) {
      console.error(`[public-runs] charging ${workflow}/${runId} failed:`, err);
      return "failed";
    }
    if (onFile.delete(k)) await save().catch((err) => console.error(`[public-runs] forgetting ${workflow}/${runId} failed:`, err));
    forget(k);
    return action;
  };

  const retryWaits = o.settleRetryMs ?? SETTLE_RETRY_MS;
  const settleLater = (workflow: string, runId: string, attempt: number) => {
    const wait = retryWaits[Math.min(attempt, retryWaits.length - 1)] ?? 600_000;
    const timer = setTimeout(() => {
      const k = keyOf(workflow, runId);
      // Settled meanwhile (a later `ended`, the boot reconcile): nothing to do.
      if (!flights.has(k) && !onFile.has(k)) return;
      void settle(workflow, runId).then((action) => {
        if (action === "failed") settleLater(workflow, runId, attempt + 1);
      });
    }, wait);
    timer.unref?.();
  };

  const ended: PublicRuns["ended"] = async (workflow, runId) => {
    if ((await settle(workflow, runId)) === "failed") settleLater(workflow, runId, 0);
  };

  const load: PublicRuns["load"] = async () => {
    if (!o.file) return;
    let raw: string;
    try {
      raw = await readFile(o.file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    // A file that does not read (cut short by a power loss) must not stop
    // the server from booting: it is moved aside and named. The ledger's open
    // holds are still charged by the reconcile; a free run it held goes
    // uncounted in its day.
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      list = undefined;
    }
    if (!Array.isArray(list)) {
      const aside = `${o.file}.unreadable-${now()}`;
      await rename(o.file, aside).catch(() => undefined);
      console.error(`[public-runs] ${o.file} is not a list of public runs — moved aside to ${aside}; the ledger's open holds are still reconciled`);
      return;
    }
    for (const e of list as PublicRunEntry[]) {
      if (!e || typeof e.workflow !== "string" || typeof e.runId !== "string" || typeof e.subject !== "string") continue;
      const k = keyOf(e.workflow, e.runId);
      onFile.set(k, e);
      flights.set(k, e);
    }
  };

  const reconcile: PublicRuns["reconcile"] = async (live, r = {}) => {
    const out: Array<{ workflow: string; runId: string; action: "charged" | "dropped" | "failed" | "live" }> = [];
    for (const e of [...onFile.values()]) {
      const action = live(e.workflow, e.runId) ? "live" : await settle(e.workflow, e.runId);
      out.push({ workflow: e.workflow, runId: e.runId, action });
    }
    if (!r.holds) return out;
    // The ledger's open holds of runs this file does not hold: charged from
    // their logs (§5, "Holds outlive a restart"). A workflow's only: a
    // priced tool's call holds while it runs, and src/public-tools.ts frees
    // one a dead process left.
    for (const h of await (await o.ledger()).openHolds()) {
      if (!h.subject.startsWith("workflow:")) continue;
      const workflow = h.subject.slice("workflow:".length);
      if (flights.has(keyOf(workflow, h.runId)) || onFile.has(keyOf(workflow, h.runId))) continue;
      const action = live(workflow, h.runId) ? "live" : await settle(workflow, h.runId, { token: h.token, subject: h.subject });
      out.push({ workflow, runId: h.runId, action });
    }
    return out;
  };

  return {
    admit,
    track,
    ended,
    pending: (workflow, runId) => onFile.has(keyOf(workflow, runId)),
    charged: async (workflow, runId) => (await (await o.ledger()).chargeOf(runId, runnableSubject({ kind: "workflow", name: workflow })))?.usd,
    inFlight: () => flights.size,
    load,
    reconcile,
  };
}

/** `STRUT_PUBLIC_RUNS_MAX`: unset or empty is the default; anything but a
 *  whole number of runs, 1 or more, fails the boot. */
export function publicRunsMaxFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return PUBLIC_RUNS_MAX_IN_FLIGHT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`STRUT_PUBLIC_RUNS_MAX must be a whole number of runs, 1 or more — got ${JSON.stringify(raw)}`);
  return n;
}

/** `<dataDir>/payments/public-runs.json`. */
export function publicRunsPath(dataDir: string): string {
  return join(dataDir, "payments", PUBLIC_RUNS_FILE);
}
