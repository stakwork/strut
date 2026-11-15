/**
 * Run retention: the `retain:` workflow field, `STRUT_RUN_RETENTION`, and the
 * sweep that evicts finished runs' logs (docs/engine.md "Retention").
 *
 * `retain: 1h` keeps a finished run's log for a window; `retain: { runs: 20 }`
 * keeps the newest 20 finished runs'. Past that a run's `events.jsonl` and
 * run directory go and its summary stays, flagged `logEvicted`. Never touched:
 * running or waiting runs, runs with claim evidence, runs whose artifacts
 * another run references, and anything outside the workflow keys.
 *
 * A run with no summary is either in flight or died with its process (heap
 * crash, OOM: the 1 GB logs). It is evicted as `crashed` only when it is not
 * live, boot's auto-resume has settled (a run it is about to relaunch must
 * not look dead), its log was last WRITTEN longer ago than the window (the
 * count form: `CRASHED_STALE_MS`), and a human did not leave it paused.
 */
import type { RunSummary } from "./core.js";
import type { RunStore } from "./store.js";

/** With a count (`{ runs: N }`) there is no window, so a summary-less run
 *  counts as crashed only once its log has been silent this long. */
export const CRASHED_STALE_MS = 3_600_000;
/** How much of a log's end is read to find a human's pause. */
const TAIL_BYTES = 64 * 1024;

export type Retention = { windowMs: number } | { runs: number };

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse a retention: `"30m"` / `"1h"` / `"7d"` (a window), `{ runs: N }`, or —
 *  for the env var only (`allowBare`) — `"20"` / `"runs:20"` (a count). */
export function parseRetention(value: unknown, opts: { allowBare?: boolean } = {}): Retention | { error: string } {
  const bad = { error: "retention is a duration like 30m, 1h or 7d, or a run count { runs: N } (N a positive integer)" };
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    const d = /^(\d+)([smhdw])$/.exec(s);
    if (d) {
      const windowMs = Number(d[1]) * UNITS[d[2]!]!;
      return windowMs > 0 ? { windowMs } : bad;
    }
    if (opts.allowBare) {
      const n = /^(?:runs:\s*)?(\d+)$/.exec(s);
      if (n) return Number(n[1]) > 0 ? { runs: Number(n[1]) } : bad;
    }
    return bad;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const runs = (value as { runs?: unknown }).runs;
    if (keys.length === 1 && typeof runs === "number" && Number.isInteger(runs) && runs > 0) return { runs };
  }
  return bad;
}

/** Throws a message naming `retain:` when the value is not a retention. */
export function checkRetain(value: unknown): Retention {
  const r = parseRetention(value);
  if ("error" in r) throw new Error(`Workflow YAML has an invalid \`retain:\` key — ${r.error}.`);
  return r;
}

/** Render a retention as the text the UI and env var use (`1h`, `runs:20`). */
export function formatRetention(r: Retention): string {
  if ("runs" in r) return `runs:${r.runs}`;
  for (const u of ["w", "d", "h", "m", "s"] as const) if (r.windowMs % UNITS[u]! === 0) return `${r.windowMs / UNITS[u]!}${u}`;
  return `${r.windowMs}ms`;
}

export interface RetentionDeps {
  store: RunStore;
  workspace: { listWorkflows(): Promise<Array<{ name: string }>>; getWorkflow(name: string): Promise<{ retain?: Retention }> };
  /** The fleet default (`STRUT_RUN_RETENTION`), for workflows with no `retain`. */
  fallback?: Retention;
  /** True when claim evidence points at the run. Absent: no claims layer. */
  hasClaims?: (workflow: string, runId: string) => Promise<boolean>;
  /** True while the run is in this process's active set. Absent: nothing is live. */
  isLive?: (workflow: string, runId: string) => boolean;
  /** Settles once boot's auto-resume scan has run; a sweep waits for it, so
   *  a cut-off run about to be resumed is never taken for a crashed one. */
  resumeSettled?: Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
}

export interface Retainer {
  /** Sweep now; resolves to the number of runs evicted. */
  sweep(): Promise<number>;
  /** Sweep at once, then hourly. Timers are unref'd. */
  start(): void;
  stop(): void;
}

/** Run ids named by `artifacts/<runId>` in a summary's input/output, with who names them. */
async function artifactReferences(store: RunStore, workflows: string[]): Promise<Map<string, Set<string>>> {
  const refs = new Map<string, Set<string>>();
  for (const wf of workflows) {
    for (const id of await store.listRuns(wf)) {
      const s = await store.getRunSummary(wf, id);
      if (!s) continue;
      const text = JSON.stringify([s.input ?? null, s.output ?? null]);
      for (const m of text.matchAll(/artifacts\/([^/"\\\s?]+)/g)) {
        const set = refs.get(m[1]!) ?? new Set<string>();
        set.add(id);
        refs.set(m[1]!, set);
      }
    }
  }
  return refs;
}

export function createRetention(deps: RetentionDeps): Retainer {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<number> | null = null;

  /** The summary to leave for a summary-less run that died, or null when it
   *  is live, recent, paused by a human, or unreadable. */
  async function crashedSummary(workflow: string, runId: string, policy: Retention): Promise<RunSummary | null> {
    if (deps.isLive?.(workflow, runId)) return null;
    const written = await deps.store.runWrittenAt(workflow, runId);
    if (written === null) return null;
    const staleMs = "runs" in policy ? CRASHED_STALE_MS : policy.windowMs;
    if (now() - written <= staleMs) return null;
    const marker = (await deps.store.readLogTail(workflow, runId, TAIL_BYTES))
      .reverse()
      .find((e) => e.type === "run.paused" || e.type === "run.resumed" || e.type === "run.cancelling");
    if (marker?.type === "run.paused") return null; // a human paused it: resume it by hand
    const start = (await deps.store.getRunStart(workflow, runId)) as { ts?: string; parentRunId?: string } | null;
    const startedMs = start?.ts ? Date.parse(start.ts) : Number(runId);
    const startedAt = new Date(Number.isFinite(startedMs) ? startedMs : written).toISOString();
    return {
      runId,
      workflow,
      status: "error",
      crashed: true,
      startedAt,
      finishedAt: new Date(written).toISOString(),
      durationMs: Math.max(0, written - Date.parse(startedAt)),
      input: null,
      error: { message: "run died with its process (no summary); log evicted by retention" },
      ...(start?.parentRunId ? { parentRunId: start.parentRunId } : {}),
    };
  }

  async function sweepOnce(): Promise<number> {
    await deps.resumeSettled;
    const names = (await deps.workspace.listWorkflows()).map((w) => w.name);
    const policies = new Map<string, Retention>();
    for (const name of names) {
      const retain = await deps.workspace.getWorkflow(name).then((f) => f.retain, () => undefined);
      const policy = retain ?? deps.fallback;
      if (policy) policies.set(name, policy);
    }
    if (!policies.size) return 0;
    const refs = await artifactReferences(deps.store, names);
    let evicted = 0;
    for (const [name, policy] of policies) {
      let finished = 0;
      for (const id of await deps.store.listRuns(name)) {
        let s = await deps.store.getRunSummary(name, id);
        // `waiting`: parked, never touched.
        if (s?.status === "waiting") continue;
        let crashed = false;
        if (!s) {
          // In flight, or died with its process: only a crashed run counts.
          const dead = await crashedSummary(name, id, policy).catch(() => null);
          if (!dead) continue;
          s = dead;
          crashed = true;
        }
        finished++;
        if (s.logEvicted) continue;
        const due = "runs" in policy ? finished > policy.runs : now() - Date.parse(s.finishedAt) > policy.windowMs;
        if (!due) continue;
        if ((s as { kept?: boolean }).kept) continue;
        if ([...(refs.get(id) ?? [])].some((by) => by !== id)) continue;
        if (await deps.hasClaims?.(name, id).catch(() => true)) continue;
        await deps.store.evictRun(name, id, new Date(now()).toISOString(), crashed ? s : undefined);
        evicted++;
      }
    }
    return evicted;
  }

  const sweep = () => (running ??= sweepOnce().finally(() => (running = null)));

  return {
    sweep,
    start() {
      if (timer) return;
      const run = () => void sweep().catch((err) => console.warn("[retention] sweep failed:", err));
      run();
      timer = setInterval(run, deps.intervalMs ?? 3_600_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
