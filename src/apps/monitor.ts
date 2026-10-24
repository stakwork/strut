/**
 * What an app costs the server (the MONITOR): every `step_run` a page makes
 * (src/apps/tools.ts) is counted here, per app — so a person sees an app
 * that hammers the backend before it hurts, and the builder, which reads
 * the same report through `app/get`, sees what to fix.
 *
 * Counted: calls, failures (a refusal or the step's own error), the bytes
 * of the results, the server time — per minute, per version, by step type,
 * reported for the last hour and the last day. Judged: five patterns, each
 * a WARNING with what was seen at its worst and what to do instead —
 *
 *   fanout   one page calling one step type for many different configs in
 *            a burst: a loop over results, a call per item, where one step
 *            (or workflow) could gather what the view needs in one call
 *   repeat   the same call, config and all, many times a minute: polling
 *            too fast, or one query per component
 *   volume   more calls in a minute or an hour than any view needs
 *   bytes    more result data in a minute than any view shows
 *   failing  one call failing over and over: a retry loop
 *
 * — counted in tumbling windows (O(1) a call; a burst across a boundary is
 * still caught by whichever side holds most of it). A warning belongs to the
 * VERSION that caused it: a fix published (and live) starts clean, and the
 * UI's dot reads the live version's alone. A page and its viewer are one
 * caller: a burst is counted per (version, viewer, type), so thirty people
 * opening one dashboard is not a loop; the volume rules count the version's
 * calls whoever made them.
 *
 * KEPT ON DISK, so a restart loses next to nothing: with a `root` (the apps
 * root under dataDir) every app gets `<app>/.usage/<YYYY-MM-DD>.jsonl` (UTC;
 * a dot folder, so no nested app name can be it), one line per minute and
 * version — `{ at, version, types: { "<type>": [calls, errors, bytes, ms] } }`,
 * a minute's counts possibly over a few lines, summed on read — and one
 * `{ warning }` line, the whole warning, written the moment it fires in a
 * window and again when its peak moved. Writes go out every `flushEveryMs`
 * (15 s) and on `close()`: what a crash loses is the last few seconds of
 * counts and the short windows' progress (10 s, 1 min), never a warning.
 * The first touch of an app reads its last day back — the minute and hour
 * volume counts rebuilt from it — and files older than `keepDays` (30) are
 * deleted. The write load follows the minutes an app is used, never its
 * calls. Without a root, memory only (a test, a host with no dataDir).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { appDir } from "./files.js";

export type AppCallStatus = "ok" | "refused" | "error";

/** One `step_run`, as the door saw it. */
export interface AppCall {
  app: string;
  version: string;
  /** The bare step type. */
  type: string;
  config?: unknown;
  /** The connection's actor; absent on an open dev strut. */
  viewer?: string;
  status: AppCallStatus;
  ms: number;
  /** The result's JSON length; 0 for a call that did not succeed. */
  bytes: number;
  /** A refusal's or a failure's message. */
  error?: string;
}

export type AppWarningKind = "fanout" | "repeat" | "volume" | "bytes" | "failing";

export interface AppWarning {
  kind: AppWarningKind;
  version: string;
  /** The step type, for every kind but volume and bytes. */
  type?: string;
  /** The window it is counted in. */
  window: "10s" | "1m" | "1h";
  /** The most seen in one window: calls, or bytes for `bytes`. */
  peak: number;
  /** fanout: the most different configs in one window. */
  distinct?: number;
  /** How often it fired: once a window for each caller it caught. */
  times: number;
  firstAt: string;
  lastAt: string;
  /** What happened, one line. */
  message: string;
  /** What to do instead, written for whoever fixes the app. */
  fix: string;
  /** fanout / failing: the last such call's config, cut to 300 chars. */
  example?: string;
  /** failing: the last error. */
  error?: string;
}

export interface AppUsageTotals {
  calls: number;
  errors: number;
  bytes: number;
  ms: number;
}

/** `GET /apps/:name/usage`. */
export interface AppUsage {
  app: string;
  /** The oldest minute the report holds; absent before the first call. */
  since?: string;
  lastCallAt?: string;
  /** The last 60 minutes, and the last 24 hours. */
  hour: AppUsageTotals;
  day: AppUsageTotals;
  /** One entry per minute of the last hour, oldest first. */
  minutes: Array<{ at: string; calls: number; errors: number; bytes: number }>;
  /** The last 24 hours by step type, busiest first. */
  types: Array<AppUsageTotals & { type: string }>;
  /** The last 24 hours' warnings, every version, newest first. */
  warnings: AppWarning[];
}

/** What `app/get` carries: the report without the per-minute series. */
export type AppUsageBrief = Omit<AppUsage, "minutes">;

/** The thresholds, one place. A kit-built page polls a live query every
 *  2 s (30 identical calls a minute), so `repeat` starts well above it. */
export const APP_MONITOR_LIMITS = {
  fanout: { windowMs: 10_000, calls: 50, distinct: 25 },
  repeat: { windowMs: 60_000, calls: 120 },
  volume: { minute: 600, hour: 5_000 },
  bytes: { minute: 50 * 1024 * 1024 },
  failing: { windowMs: 60_000, calls: 20 },
  /** How long a warning or a minute's counts are reported. */
  keepMs: 24 * 60 * 60_000,
} as const;

/** The usage folder inside an app's folder. */
export const USAGE_DIR = ".usage";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** calls, errors, bytes, ms — a type's counts in a minute line. */
type Tuple = [number, number, number, number];

interface Minute {
  t: number;
  version: string;
  totals: AppUsageTotals;
  types: Map<string, AppUsageTotals>;
  /** Counted since the last write. */
  pending: Map<string, AppUsageTotals>;
}
interface Burst {
  calls: number;
  configs: Set<string>;
  example: string;
  fired?: string;
}
interface Counted {
  calls: number;
  fired?: string;
}
interface Failing extends Counted {
  error: string;
  example: string;
}
interface Window<T> {
  t: number;
  keys: Map<string, T>;
}
interface Seen {
  kind: AppWarningKind;
  version: string;
  type?: string;
  window: AppWarning["window"];
  peak: number;
  distinct?: number;
  times: number;
  firstAt: number;
  lastAt: number;
  example?: string;
  error?: string;
}
/** A warning as a line holds it: Seen with ISO times. */
type SeenLine = Omit<Seen, "firstAt" | "lastAt"> & { firstAt: string; lastAt: string };
interface AppState {
  minutes: Minute[];
  byKey: Map<string, Minute>;
  lastCallAt?: number;
  tenSec: Window<Burst>;
  minute: Window<Counted | Failing> & { bytes: Map<string, Counted & { bytes: number }> };
  hour: Window<Counted>;
  warnings: Map<string, Seen>;
  /** Warnings to write at the next flush. */
  dirty: Set<string>;
  /** The UTC day this app's old files were last pruned on. */
  prunedOn?: string;
}

const zero = (): AppUsageTotals => ({ calls: 0, errors: 0, bytes: 0, ms: 0 });
const add = (into: AppUsageTotals, c: AppUsageTotals) => {
  into.calls += c.calls;
  into.errors += c.errors;
  into.bytes += c.bytes;
  into.ms += c.ms;
};
const addType = (map: Map<string, AppUsageTotals>, type: string, c: AppUsageTotals) => {
  let into = map.get(type);
  if (!into) map.set(type, (into = zero()));
  add(into, c);
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const configText = (config: unknown): string => {
  try {
    return JSON.stringify(config ?? {}) ?? "{}";
  } catch {
    return String(config);
  }
};
const iso = (ms: number) => new Date(ms).toISOString();
/** The UTC day a moment falls on: the file it is written to. */
const dayOf = (ms: number) => iso(ms).slice(0, 10);
const warningKey = (w: Pick<Seen, "kind" | "version" | "type" | "window">) => [w.kind, w.version, w.type ?? "", w.window].join("\0");

/** A size for a person: 1.2 MB, 340 KB, 12 B. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** What a warning says and what to do — rendered from what was seen, so it
 *  is the same words in the UI, the route and the builder's `app/get`. */
function words(w: Seen): { message: string; fix: string } {
  const L = APP_MONITOR_LIMITS;
  switch (w.kind) {
    case "fanout":
      return {
        message: `${w.type} called ${w.peak} times in 10 s from one page, with ${w.distinct} different configs — a loop that makes one call per item`,
        fix: `Gather what the view needs in one call: a step or a workflow that returns it all (granted in app.yaml), instead of a ${w.type} per item.`,
      };
    case "repeat":
      return {
        message: `the same ${w.type} call, config and all, ${w.peak} times in a minute from one page (the limit is ${L.repeat.calls})`,
        fix: "Poll less often (the kit's live hooks refetch every 2 s), or share one query between components instead of one each.",
      };
    case "volume":
      return w.window === "1h"
        ? { message: `${w.peak} calls in an hour (the limit is ${L.volume.hour})`, fix: "See which step types are busiest: fetch less often, or gather a view's data in fewer calls." }
        : { message: `${w.peak} calls in a minute (the limit is ${L.volume.minute})`, fix: "See which step types are busiest: fetch less often, or gather a view's data in fewer calls." };
    case "bytes":
      return {
        message: `${formatBytes(w.peak)} of results in a minute (the limit is ${formatBytes(L.bytes.minute)})`,
        fix: "Ask for less — a limit, run/events' skip, one file rather than all — or have a step compute the summary the page shows.",
      };
    case "failing":
      return {
        message: `${w.type} failed ${w.peak} times in a minute${w.error ? `: ${cut(w.error, 200)}` : ""}`,
        fix: "A failing call is being retried in a loop: fix the call (a refusal names the grant it needs), or stop retrying it.",
      };
  }
}

export interface AppMonitor {
  record(call: AppCall): void;
  /** The whole report; an app never called has empty counts. */
  report(app: string): AppUsage;
  /** `report` without the per-minute series: what `app/get` carries. */
  brief(app: string): AppUsageBrief;
  /** The last day's warnings on one version: the UI's dot. */
  warningCount(app: string, version: string): number;
  /** Drop an app's counts, its files too (the app was deleted). */
  forget(app: string): void;
  /** Write everything counted since the last write, and wait for it. */
  flush(): Promise<void>;
  /** Stop the timer and flush. */
  close(): Promise<void>;
}

export interface AppMonitorOptions {
  /** The apps root (`appsRoot(dataDir)`): where each app's `.usage/` goes.
   *  Absent, nothing is kept past the process. */
  root?: string;
  now?: () => number;
  /** How often counts are written; 0 = only on `flush()` / `close()`. */
  flushEveryMs?: number;
  /** How many days of files an app keeps. */
  keepDays?: number;
}

export function createAppMonitor(opts: AppMonitorOptions = {}): AppMonitor {
  const now = opts.now ?? Date.now;
  const root = opts.root;
  const keepDays = opts.keepDays ?? 30;
  const apps = new Map<string, AppState>();
  const L = APP_MONITOR_LIMITS;

  // ── The files ──────────────────────────────────────────────────────────
  // Every write goes through one chain, in order; a failed write is one
  // warning per app and never a failed call.
  let chain: Promise<void> = Promise.resolve();
  const warned = new Set<string>();
  const usageDir = (app: string) => join(appDir(root!, app), USAGE_DIR);
  const enqueue = (app: string, job: () => Promise<void>) => {
    chain = chain.then(job).catch((err: unknown) => {
      if (warned.has(app)) return;
      warned.add(app);
      console.warn(`[apps] usage of ${app} could not be written: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  /** Delete the files older than `keepDays`, once a day per app. */
  const prune = (app: string, s: AppState, at: number) => {
    const today = dayOf(at);
    if (!root || s.prunedOn === today) return;
    s.prunedOn = today;
    const oldest = dayOf(at - keepDays * DAY);
    enqueue(app, async () => {
      const names = await readdir(usageDir(app)).catch(() => [] as string[]);
      for (const f of names) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < oldest) await unlink(join(usageDir(app), f)).catch(() => {});
    });
  };
  /** Append lines, each to the file of its own day. */
  const write = (app: string, lines: Array<{ at: number; line: unknown }>) => {
    if (!root || !lines.length) return;
    const byDay = new Map<string, string[]>();
    for (const { at, line } of lines) {
      const day = dayOf(at);
      const list = byDay.get(day) ?? [];
      list.push(JSON.stringify(line));
      byDay.set(day, list);
    }
    enqueue(app, async () => {
      await mkdir(usageDir(app), { recursive: true });
      for (const [day, list] of byDay) await appendFile(join(usageDir(app), `${day}.jsonl`), `${list.join("\n")}\n`);
    });
  };
  const warningLine = (w: Seen): { at: number; line: { warning: SeenLine } } => ({
    at: w.lastAt,
    line: { warning: { ...w, firstAt: iso(w.firstAt), lastAt: iso(w.lastAt) } },
  });

  // ── An app's state, read back from its files on first touch ────────────
  const blank = (): AppState => ({
    minutes: [],
    byKey: new Map(),
    tenSec: { t: -1, keys: new Map() },
    minute: { t: -1, keys: new Map(), bytes: new Map() },
    hour: { t: -1, keys: new Map() },
    warnings: new Map(),
    dirty: new Set(),
  });

  const minuteOf = (s: AppState, t: number, version: string): Minute => {
    const key = `${t}\0${version}`;
    let m = s.byKey.get(key);
    if (!m) {
      m = { t, version, totals: zero(), types: new Map(), pending: new Map() };
      s.byKey.set(key, m);
      s.minutes.push(m);
    }
    return m;
  };

  const load = (app: string, s: AppState, at: number) => {
    const since = at - L.keepMs;
    for (const day of [dayOf(at - DAY), dayOf(at)]) {
      const file = join(usageDir(app), `${day}.jsonl`);
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const raw of text.split("\n")) {
        if (!raw) continue;
        let line: { at?: string; version?: string; types?: Record<string, Tuple>; warning?: SeenLine };
        try {
          line = JSON.parse(raw);
        } catch {
          continue; // a line cut off by a crash
        }
        if (line.warning) {
          const w = line.warning;
          const seen: Seen = { ...w, firstAt: Date.parse(w.firstAt), lastAt: Date.parse(w.lastAt) };
          if (seen.lastAt > since) s.warnings.set(warningKey(seen), seen);
          continue;
        }
        const t = line.at ? Date.parse(line.at) : NaN;
        if (!(t > since) || !line.version || !line.types) continue;
        const m = minuteOf(s, t, line.version);
        for (const [type, tuple] of Object.entries(line.types)) {
          if (!Array.isArray(tuple)) continue;
          const [calls = 0, errors = 0, bytes = 0, ms = 0] = tuple;
          const c = { calls, errors, bytes, ms };
          add(m.totals, c);
          addType(m.types, type, c);
        }
        s.lastCallAt = Math.max(s.lastCallAt ?? 0, t);
      }
    }
    s.minutes.sort((a, b) => a.t - b.t);
    // The volume rules' windows go on from what the files hold.
    const minuteT = Math.floor(at / MINUTE) * MINUTE;
    const hourT = Math.floor(at / HOUR) * HOUR;
    s.minute.t = minuteT;
    s.hour.t = hourT;
    const firedSince = (key: string, from: number) => ((s.warnings.get(key)?.lastAt ?? -1) >= from ? key : undefined);
    for (const m of s.minutes) {
      if (m.t === minuteT) {
        const c = s.minute.bytes.get(m.version) ?? { calls: 0, bytes: 0 };
        c.calls += m.totals.calls;
        c.bytes += m.totals.bytes;
        const vol = firedSince(warningKey({ kind: "volume", version: m.version, window: "1m" }), minuteT);
        if (vol) c.fired = vol;
        s.minute.bytes.set(m.version, c);
        const bytes = firedSince(warningKey({ kind: "bytes", version: m.version, window: "1m" }), minuteT);
        if (bytes) s.minute.keys.set(`bytes\0${m.version}`, { calls: 0, fired: bytes });
      }
      if (m.t >= hourT) {
        const c = s.hour.keys.get(m.version) ?? { calls: 0 };
        c.calls += m.totals.calls;
        const vol = firedSince(warningKey({ kind: "volume", version: m.version, window: "1h" }), hourT);
        if (vol) c.fired = vol;
        s.hour.keys.set(m.version, c);
      }
    }
  };

  const stateOf = (app: string, at: number): AppState => {
    let s = apps.get(app);
    if (!s) {
      s = blank();
      apps.set(app, s);
      if (root) {
        load(app, s, at);
        prune(app, s, at);
      }
    }
    return s;
  };

  /** Drop what is older than the report window (the files keep it). */
  const age = (s: AppState, at: number) => {
    while (s.minutes.length && s.minutes[0]!.t <= at - L.keepMs && !s.minutes[0]!.pending.size) {
      const m = s.minutes.shift()!;
      s.byKey.delete(`${m.t}\0${m.version}`);
    }
    for (const [k, w] of s.warnings) if (w.lastAt <= at - L.keepMs && !s.dirty.has(k)) s.warnings.delete(k);
  };

  /** A window's counts, reset when the window rolls over. */
  const roll = <T>(w: Window<T>, at: number, size: number) => {
    const t = Math.floor(at / size) * size;
    if (w.t !== t) {
      w.t = t;
      w.keys.clear();
      return true;
    }
    return false;
  };

  /** A warning seen in a window: the first sighting in the window counts a
   *  `time` and is written at once; every one after only raises the peak,
   *  written at the next flush. */
  const sight = (app: string, s: AppState, at: number, counter: { fired?: string }, w: Omit<Seen, "times" | "firstAt" | "lastAt">) => {
    const key = warningKey(w);
    let seen = s.warnings.get(key);
    const fresh = counter.fired !== key;
    if (!seen) s.warnings.set(key, (seen = { ...w, times: 1, firstAt: at, lastAt: at }));
    else {
      if (fresh) seen.times += 1;
      seen.peak = Math.max(seen.peak, w.peak);
      if (w.distinct !== undefined) seen.distinct = Math.max(seen.distinct ?? 0, w.distinct);
      seen.lastAt = at;
      if (w.example !== undefined) seen.example = w.example;
      if (w.error !== undefined) seen.error = w.error;
    }
    counter.fired = key;
    if (fresh) {
      s.dirty.delete(key);
      write(app, [warningLine(seen)]);
    } else s.dirty.add(key);
  };

  const flushApp = (app: string, s: AppState) => {
    const lines: Array<{ at: number; line: unknown }> = [];
    for (const m of s.minutes) {
      if (!m.pending.size) continue;
      const types: Record<string, Tuple> = {};
      for (const [type, c] of m.pending) types[type] = [c.calls, c.errors, c.bytes, c.ms];
      lines.push({ at: m.t, line: { at: iso(m.t), version: m.version, types } });
      m.pending = new Map();
    }
    for (const key of s.dirty) {
      const w = s.warnings.get(key);
      if (w) lines.push(warningLine(w));
    }
    s.dirty.clear();
    write(app, lines);
  };

  const flush = async () => {
    for (const [app, s] of apps) flushApp(app, s);
    await chain;
  };

  const flushEvery = opts.flushEveryMs ?? 15_000;
  const timer = root && flushEvery > 0 ? setInterval(() => void flush(), flushEvery) : undefined;
  timer?.unref?.();

  const report = (app: string): AppUsage => {
    const at = now();
    const s = stateOf(app, at);
    age(s, at);
    const hour = zero();
    const day = zero();
    const byMinute = new Map<number, AppUsageTotals>();
    const types = new Map<string, AppUsageTotals>();
    const hourFrom = Math.floor(at / MINUTE) * MINUTE - 59 * MINUTE;
    for (const m of s.minutes) {
      if (m.t <= at - L.keepMs) continue;
      add(day, m.totals);
      for (const [type, c] of m.types) addType(types, type, c);
      if (m.t >= hourFrom) {
        add(hour, m.totals);
        const into = byMinute.get(m.t) ?? zero();
        add(into, m.totals);
        byMinute.set(m.t, into);
      }
    }
    const minutes: AppUsage["minutes"] = [];
    for (let t = hourFrom; t <= hourFrom + 59 * MINUTE; t += MINUTE) {
      const m = byMinute.get(t);
      minutes.push({ at: iso(t), calls: m?.calls ?? 0, errors: m?.errors ?? 0, bytes: m?.bytes ?? 0 });
    }
    const warnings = [...s.warnings.values()]
      .filter((w) => w.lastAt > at - L.keepMs)
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((w): AppWarning => ({
        kind: w.kind,
        version: w.version,
        ...(w.type ? { type: w.type } : {}),
        window: w.window,
        peak: w.peak,
        ...(w.distinct !== undefined ? { distinct: w.distinct } : {}),
        times: w.times,
        firstAt: iso(w.firstAt),
        lastAt: iso(w.lastAt),
        ...words(w),
        ...(w.example !== undefined ? { example: w.example } : {}),
        ...(w.error ? { error: w.error } : {}),
      }));
    const oldest = s.minutes.find((m) => m.t > at - L.keepMs);
    return {
      app,
      ...(oldest ? { since: iso(oldest.t) } : {}),
      ...(s.lastCallAt !== undefined ? { lastCallAt: iso(s.lastCallAt) } : {}),
      hour,
      day,
      minutes,
      types: [...types].map(([type, t]) => ({ type, ...t })).sort((a, b) => b.calls - a.calls || a.type.localeCompare(b.type)),
      warnings,
    };
  };

  return {
    record(call) {
      const at = now();
      const s = stateOf(call.app, at);
      s.lastCallAt = at;
      const failed = call.status !== "ok" ? 1 : 0;
      const totals: AppUsageTotals = { calls: 1, errors: failed, bytes: call.bytes, ms: call.ms };

      // The counts.
      const m = minuteOf(s, Math.floor(at / MINUTE) * MINUTE, call.version);
      add(m.totals, totals);
      addType(m.types, call.type, totals);
      addType(m.pending, call.type, totals);
      age(s, at);
      prune(call.app, s, at);

      // The rules.
      const v = call.version;
      const caller = [v, call.viewer ?? "", call.type].join("\0");
      const text = configText(call.config);
      const hash = createHash("sha1").update(text).digest("base64url");

      roll(s.tenSec, at, L.fanout.windowMs);
      let burst = s.tenSec.keys.get(caller);
      if (!burst) s.tenSec.keys.set(caller, (burst = { calls: 0, configs: new Set(), example: "" }));
      burst.calls += 1;
      if (burst.configs.size < L.fanout.distinct * 40) burst.configs.add(hash);
      burst.example = cut(text, 300);
      if (burst.calls >= L.fanout.calls && burst.configs.size >= L.fanout.distinct) {
        sight(call.app, s, at, burst, { kind: "fanout", version: v, type: call.type, window: "10s", peak: burst.calls, distinct: burst.configs.size, example: burst.example });
      }

      if (roll(s.minute, at, MINUTE)) s.minute.bytes.clear();
      const same = `same\0${caller}\0${hash}`;
      const repeat = s.minute.keys.get(same) ?? { calls: 0 };
      s.minute.keys.set(same, repeat);
      repeat.calls += 1;
      if (repeat.calls >= L.repeat.calls) sight(call.app, s, at, repeat, { kind: "repeat", version: v, type: call.type, window: "1m", peak: repeat.calls });

      if (failed) {
        const key = `fail\0${caller}`;
        const f = (s.minute.keys.get(key) as Failing | undefined) ?? { calls: 0, error: "", example: "" };
        s.minute.keys.set(key, f);
        f.calls += 1;
        f.error = call.error ?? "";
        f.example = cut(text, 300);
        if (f.calls >= L.failing.calls) {
          sight(call.app, s, at, f, { kind: "failing", version: v, type: call.type, window: "1m", peak: f.calls, example: f.example, ...(f.error ? { error: cut(f.error, 500) } : {}) });
        }
      }

      const perMinute = s.minute.bytes.get(v) ?? { calls: 0, bytes: 0 };
      s.minute.bytes.set(v, perMinute);
      perMinute.calls += 1;
      perMinute.bytes += call.bytes;
      if (perMinute.calls >= L.volume.minute) sight(call.app, s, at, perMinute, { kind: "volume", version: v, window: "1m", peak: perMinute.calls });
      // Bytes: a counter of its own, so its first sighting in the window is
      // counted apart from the volume rule's.
      const bytesKey = `bytes\0${v}`;
      const b = (s.minute.keys.get(bytesKey) as Counted | undefined) ?? { calls: 0 };
      s.minute.keys.set(bytesKey, b);
      if (perMinute.bytes >= L.bytes.minute) sight(call.app, s, at, b, { kind: "bytes", version: v, window: "1m", peak: perMinute.bytes });

      roll(s.hour, at, HOUR);
      const perHour = s.hour.keys.get(v) ?? { calls: 0 };
      s.hour.keys.set(v, perHour);
      perHour.calls += 1;
      if (perHour.calls >= L.volume.hour) sight(call.app, s, at, perHour, { kind: "volume", version: v, window: "1h", peak: perHour.calls });
    },

    report,

    brief(app) {
      const { minutes: _minutes, ...rest } = report(app);
      return rest;
    },

    warningCount(app, version) {
      const at = now();
      const s = stateOf(app, at);
      let n = 0;
      for (const w of s.warnings.values()) if (w.version === version && w.lastAt > at - L.keepMs) n += 1;
      return n;
    },

    forget(app) {
      apps.delete(app);
      if (root) enqueue(app, () => rm(usageDir(app), { recursive: true, force: true }));
    },

    flush,

    async close() {
      if (timer) clearInterval(timer);
      await flush();
    },
  };
}
