/**
 * Run retention: the `retain:` workflow field, `STRUT_RUN_RETENTION`, and the
 * sweep that evicts finished runs' logs (docs/engine.md "Retention").
 *
 * `retain: 1h` keeps a finished run's log for a window; `retain: { runs: 20 }`
 * keeps the newest 20 finished runs'. Past that a run's `events.jsonl` and
 * run directory go and its summary stays, flagged `logEvicted`. Never touched:
 * running or waiting runs, runs with claim evidence, runs whose artifacts
 * another run references, and anything outside the workflow keys.
 */
import type { RunStore } from "./store.js";

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

  async function sweepOnce(): Promise<number> {
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
        const s = await deps.store.getRunSummary(name, id);
        // No summary: in flight. `waiting`: parked. Neither is ever touched.
        if (!s || s.status === "waiting") continue;
        finished++;
        if (s.logEvicted) continue;
        const due = "runs" in policy ? finished > policy.runs : now() - Date.parse(s.finishedAt) > policy.windowMs;
        if (!due) continue;
        if ((s as { kept?: boolean }).kept) continue;
        if ([...(refs.get(id) ?? [])].some((by) => by !== id)) continue;
        if (await deps.hasClaims?.(name, id).catch(() => true)) continue;
        await deps.store.evictRun(name, id, new Date(now()).toISOString());
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
