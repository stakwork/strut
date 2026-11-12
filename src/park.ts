/**
 * Parked runs (plans/human-steps.md §2; RUN_CONTROL_SPEC §5.6): a run that
 * waits for something outside it — a person's answer, later a timer — LEAVES
 * memory instead of holding a promise open, and is resumed from its journal
 * when what it waits for happens.
 *
 * A step parks with `ctx.park(on)`: it throws a `ParkedError` naming what it
 * waits on, `<prefix>:<id>` (`task:4f2c…`). The runner treats that as neither
 * an error nor a cancel: the step emits `step.parked`, its dependents stop
 * with it, other branches run to their end, and the run finalizes as
 * `waiting` (`run.waiting`, a summary with `waitingOn`). Whoever a step parks
 * on is a SOURCE, registered under its prefix (`strut.parking.register`); a
 * source WAKES the run when what it waits on settles, and the run is resumed
 * under its own id: the journal replays every finished step and each parked
 * step runs again and finds its answer.
 *
 * What is here: the error, the format of `on`, the index of waiting runs,
 * and `createParking`, the wake's bookkeeping over seams createStrut fills
 * (is the run live, may it wake now, launch the resume). Nothing here reads
 * a run log.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What a step parks on: `<prefix>:<id>`, the prefix lowercase letters. */
export const PARK_ON_RE = /^([a-z]+):(\S[^\n]*)$/;
const ON_MAX = 256;

/** The prefix of a park target, or null when it is not one. */
export function parkPrefix(on: string): string | null {
  if (typeof on !== "string" || on.length > ON_MAX) return null;
  return PARK_ON_RE.exec(on)?.[1] ?? null;
}

/** Thrown by `ctx.park(on)`: the step, and everything that depends on it,
 *  waits for `on`. Never an error: no retry, no `onError`, no `step.error`.
 *  A flow whose branches parked throws one carrying every target. Detected
 *  structurally (`isParkedError`), like `CancelledError`. */
export class ParkedError extends Error {
  readonly isStrutParked = true;
  readonly on: string[];
  constructor(on: string[]) {
    super(`waiting on ${on.join(", ")}`);
    this.name = "ParkedError";
    this.on = [...new Set(on)];
  }
}

export function isParkedError(err: unknown): err is ParkedError {
  return err != null && typeof err === "object" && (err as { isStrutParked?: unknown }).isStrutParked === true;
}

/** Every target of several parked branches, as one error. */
export function mergeParked(errs: unknown[]): ParkedError {
  return new ParkedError(errs.flatMap((e) => (isParkedError(e) ? e.on : [])));
}

/** What the runner asks before a step parks (`ctx.park`): is there a source
 *  for this target here? On the services bag as `parking`, set by
 *  createStrut. Without it nothing would ever wake the run, so a park fails
 *  the step instead. */
export interface ParkingCapability {
  accepts(on: string): boolean;
}

/** Whoever a step parks on: told when the run it woke is cancelled, asked
 *  whether a target already settled (after a park, at a source's
 *  registration). */
export interface ParkSource {
  settled(on: string): Promise<boolean>;
  cancelled?(on: string, run: { workflow: string; runId: string }): Promise<void>;
}

/** What `register` hands a source: the way it wakes a run. Fire and
 *  forget: the wake is coalesced, deferred while the run is live or the
 *  server drains, and dropped for a run that no longer waits. */
export interface ParkWaker {
  wake(workflow: string, runId: string): void;
}

/** One run that parked and has not ended since: what a source's
 *  registration reads to wake what settled while nobody was listening (a
 *  restart between a settle and its wake). */
export interface WaitingRun {
  workflow: string;
  runId: string;
  on: string[];
  at: string;
}

/** The waiting runs, kept until each really ends. One file per run under
 *  `<dataDir>/parking/` (a whole-file rewrite per park would grow with the
 *  number waiting), or memory. */
export interface WaitingIndex {
  put(run: WaitingRun): Promise<void>;
  remove(workflow: string, runId: string): Promise<void>;
  list(): Promise<WaitingRun[]>;
}

const keyOf = (workflow: string, runId: string) => `${workflow}\n${runId}`;

export class MemoryWaitingIndex implements WaitingIndex {
  private runs = new Map<string, WaitingRun>();
  async put(run: WaitingRun): Promise<void> {
    this.runs.set(keyOf(run.workflow, run.runId), { ...run, on: [...run.on] });
  }
  async remove(workflow: string, runId: string): Promise<void> {
    this.runs.delete(keyOf(workflow, runId));
  }
  async list(): Promise<WaitingRun[]> {
    return [...this.runs.values()].map((r) => ({ ...r, on: [...r.on] }));
  }
}

export class FileWaitingIndex implements WaitingIndex {
  private readonly dir: string;
  /** The keys on file, read once: a run that never parked costs no file
   *  operation when it ends. */
  private known: Promise<Set<string>> | undefined;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "parking");
  }
  private file(workflow: string, runId: string): string {
    return join(this.dir, `${createHash("sha256").update(keyOf(workflow, runId)).digest("hex").slice(0, 40)}.json`);
  }
  private keys(): Promise<Set<string>> {
    this.known ??= this.list().then((runs) => new Set(runs.map((r) => keyOf(r.workflow, r.runId))));
    return this.known;
  }
  async put(run: WaitingRun): Promise<void> {
    const keys = await this.keys();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(run.workflow, run.runId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(run), { mode: 0o600 });
    await rename(tmp, file);
    keys.add(keyOf(run.workflow, run.runId));
  }
  async remove(workflow: string, runId: string): Promise<void> {
    const keys = await this.keys();
    if (!keys.delete(keyOf(workflow, runId))) return;
    await rm(this.file(workflow, runId), { force: true });
  }
  async list(): Promise<WaitingRun[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: WaitingRun[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await readFile(join(this.dir, name), "utf8")) as WaitingRun;
        if (typeof run.workflow === "string" && typeof run.runId === "string" && Array.isArray(run.on)) out.push(run);
      } catch {
        // A torn or foreign file: not a waiting run.
      }
    }
    return out;
  }
}

/** What the parking bookkeeping needs of the server. */
export interface ParkingDeps {
  index: WaitingIndex;
  /** How long a wake waits for others of the same run, in ms (one resume
   *  for a burst). */
  delayMs: number;
  /** Executing in this process (has a controller). A wake then waits for
   *  the run to park again or end. */
  isLive(workflow: string, runId: string): boolean;
  /** Null when a run may be resumed now; else why not (a drain). Held
   *  wakes go when `flush` is called. */
  holdReason(): string | null;
  /** Resume the run from its journal, marked as a wake — if it still waits
   *  (`waiting: false`: cancelled, ended, resumed by hand). `refused`: it
   *  waits, and could not be resumed now (a log past the resume cap, a
   *  disabled workflow, a drain that began). */
  wake(workflow: string, runId: string): Promise<{ woken: true } | { waiting: false } | { refused: string }>;
}

export interface Parking extends ParkingCapability {
  /** A source's way in: its prefix and the waker it wakes runs with. On
   *  registration every run waiting on that prefix is checked against it,
   *  so a settle the server never woke for (a restart in between) wakes
   *  now. A prefix registers once. */
  register(prefix: string, source: ParkSource): ParkWaker;
  /** The runner's end of a park (`RunEndInfo.parked`): kept in the index,
   *  then each target asked whether it settled already (no lost wake). */
  parked(workflow: string, runId: string, on: string[]): Promise<void>;
  /** The run's controller let go: a wake held while it was live goes now. */
  released(workflow: string, runId: string): void;
  /** The run really ended (success, error, cancel): out of the index. */
  ended(workflow: string, runId: string): Promise<void>;
  /** A waiting run was cancelled: each target's source is told, and the run
   *  leaves the index. */
  cancelled(workflow: string, runId: string, on: string[]): Promise<void>;
  /** Try every held wake again (the drain lifted). */
  flush(): void;
  /** Settles when every wake scheduled so far has run (tests). */
  idle(): Promise<void>;
  close(): void;
}

export function createParking(deps: ParkingDeps): Parking {
  const sources = new Map<string, ParkSource>();
  /** Runs owed a wake, by key, with their names. */
  const owed = new Map<string, { workflow: string; runId: string }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  };

  const schedule = (key: string) => {
    if (closed || timers.has(key) || !owed.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      void track(fire(key));
    }, deps.delayMs);
    timer.unref?.();
    timers.set(key, timer);
  };

  const fire = async (key: string): Promise<void> => {
    const run = owed.get(key);
    if (!run) return;
    // Live: kept, and tried again when it parks or lets go (`released`).
    if (deps.isLive(run.workflow, run.runId)) return;
    // Draining: kept, and tried again when the drain lifts (`flush`).
    if (deps.holdReason()) return;
    owed.delete(key);
    try {
      const r = await deps.wake(run.workflow, run.runId);
      if ("waiting" in r) {
        // Nothing to wake, and it waits no more.
        if (!deps.isLive(run.workflow, run.runId)) await deps.index.remove(run.workflow, run.runId);
      } else if ("refused" in r) {
        // Still waiting: a drain that began keeps the wake for `flush`; any
        // other refusal stands until the next wake (a source's
        // registration at the next boot tries again).
        if (deps.holdReason() && !owed.has(key)) owed.set(key, run);
        else console.warn(`[parking] ${run.workflow}/${run.runId}: not woken — ${r.refused}`);
      }
    } catch (err) {
      console.error(`[parking] ${run.workflow}/${run.runId}: the wake failed:`, err);
    }
  };

  const owe = (workflow: string, runId: string) => {
    const key = keyOf(workflow, runId);
    owed.set(key, { workflow, runId });
    schedule(key);
  };

  /** Ask each target's source whether it settled; owe the run a wake if
   *  one did. */
  const check = async (workflow: string, runId: string, on: string[]) => {
    for (const target of on) {
      const source = sources.get(parkPrefix(target) ?? "");
      if (!source) continue;
      let done = false;
      try {
        done = await source.settled(target);
      } catch (err) {
        console.error(`[parking] ${workflow}/${runId}: asking whether ${target} settled failed:`, err);
      }
      if (done) {
        owe(workflow, runId);
        return;
      }
    }
  };

  return {
    accepts: (on) => {
      const prefix = parkPrefix(on);
      return prefix !== null && sources.has(prefix);
    },
    register(prefix, source) {
      if (!/^[a-z]+$/.test(prefix)) throw new Error(`parking: a prefix is lowercase letters, not "${prefix}"`);
      if (sources.has(prefix)) throw new Error(`parking: "${prefix}" is registered already`);
      sources.set(prefix, source);
      // Catch up: what settled while no source listened.
      void track(
        (async () => {
          for (const run of await deps.index.list()) {
            const mine = run.on.filter((t) => parkPrefix(t) === prefix);
            if (mine.length) await check(run.workflow, run.runId, mine);
          }
        })().catch((err) => console.error(`[parking] catching up "${prefix}" failed:`, err)),
      );
      return { wake: (workflow, runId) => owe(workflow, runId) };
    },
    async parked(workflow, runId, on) {
      await deps.index.put({ workflow, runId, on, at: new Date().toISOString() });
      await track(check(workflow, runId, on));
    },
    released(workflow, runId) {
      schedule(keyOf(workflow, runId));
    },
    async ended(workflow, runId) {
      const key = keyOf(workflow, runId);
      owed.delete(key);
      await deps.index.remove(workflow, runId);
    },
    async cancelled(workflow, runId, on) {
      owed.delete(keyOf(workflow, runId));
      for (const target of on) {
        const source = sources.get(parkPrefix(target) ?? "");
        try {
          await source?.cancelled?.(target, { workflow, runId });
        } catch (err) {
          console.error(`[parking] ${workflow}/${runId}: telling the source of ${target} it was cancelled failed:`, err);
        }
      }
      await deps.index.remove(workflow, runId);
    },
    flush() {
      for (const key of owed.keys()) schedule(key);
    },
    async idle() {
      for (;;) {
        if (timers.size) {
          await new Promise((r) => setTimeout(r, Math.max(5, deps.delayMs)));
          continue;
        }
        if (!inFlight.size) return;
        await Promise.allSettled([...inFlight]);
      }
    },
    close() {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
