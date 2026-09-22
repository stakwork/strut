/**
 * Automations, the STATEFUL half (plans/automations.md §4–§6): the policy
 * layer behind both doors (HTTP routes + chat tools) and the in-process tick
 * loop that fires what is due. The grammar and the calendar math are
 * `automations.ts`; this file only stores, schedules and launches.
 *
 * Nothing here is persisted but the definitions themselves (workflow
 * metadata). `nextRunAt` lives in memory and is always computed from the
 * current time, so a restart neither stampedes nor double-fires, and a run
 * missed while the process was down is simply skipped. Everything about past
 * runs — the `last` cursor, "is the previous run still going" — is read from
 * the run store, where a scheduled run carries its automation's id.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  NO_LAST_RUN,
  automationDraftSchema,
  automationPatchSchema,
  checkInputTemplates,
  describeTrigger,
  nextFire,
  nextFires,
  normalizeTrigger,
  resolveAutomationInput,
  triggerSchema,
  type Automation,
  type LastRun,
  type Trigger,
  type TriggerDraft,
} from "./automations.js";
import type { Flow } from "./core.js";
import type { RunStore } from "./store.js";
import type { WorkspaceStore } from "./workspace.js";
import { principalRequired } from "./auth.js";

export interface AutomationsDeps {
  workspace: WorkspaceStore;
  store: RunStore;
  /** Launch a run detached, stamped as this automation's; returns its id. */
  launch: (flow: Flow, input: Record<string, unknown>, automation: { id: string }) => string;
  /** Is this run executing in THIS process right now? */
  isInFlight: (workflow: string, runId: string) => boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Tick period. Default 15 s. */
  tickMs?: number;
}

/** An automation as both doors show it: the record plus what is derived. */
export interface AutomationView extends Automation {
  workflow: string;
  /** The trigger as one plain sentence. */
  summary: string;
  /** ISO instant of the next fire; null when paused or never again. */
  nextRunAt: string | null;
  /** This automation's latest run, any status. */
  lastRun: { runId: string; status: "running" | "success" | "error" | "cancelled"; startedAt: string } | null;
  /** Its previous run is still executing — a fire now would be skipped. */
  running: boolean;
  /** Why the latest fire launched nothing (memory only; lost on restart). */
  lastFireError?: string;
}

export type AutomationsResult<T> = ({ ok: true } & T) | { error: string };
type Saved = AutomationsResult<{ automation: AutomationView; next: string[] }>;

export interface Automations {
  /** Every automation, or one workflow's. */
  list(workflow?: string): Promise<AutomationView[]>;
  create(workflow: string, draft: unknown): Promise<Saved>;
  update(workflow: string, id: string, patch: unknown): Promise<Saved>;
  remove(workflow: string, id: string): Promise<AutomationsResult<{ id: string }>>;
  /** A trigger's sentence and next five fires, writing nothing. */
  preview(trigger: unknown): AutomationsResult<{ summary: string; next: string[] }>;
  /** "Run now": the scheduler's fire path, off-schedule. */
  fire(workflow: string, id: string): Promise<AutomationsResult<{ runId: string }>>;
  /** Drop a workflow's schedules from the tick loop (the workflow is being
   *  deleted; its metadata goes with it). */
  forget(workflow: string): void;
  /** Begin ticking (idempotent). The timer is unref'd. */
  start(): void;
  stop(): void;
  /** One pass over what is due — the timer's body, callable from tests. */
  tick(): Promise<void>;
}

/** How many of a workflow's newest runs a lookup reads before giving up. */
const SCAN_LIMIT = 100;

interface Entry {
  workflow: string;
  automation: Automation;
  nextRunAt: Date | null;
}

interface RunFacts {
  last: LastRun;
  lastRun: AutomationView["lastRun"];
  inFlight: string | null;
}

const issues = (err: z.ZodError) => err.issues.map((i) => `${i.path.join(".") || "automation"}: ${i.message}`).join("; ");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createAutomations(deps: AutomationsDeps): Automations {
  const { workspace, store } = deps;
  const clock = deps.now ?? (() => new Date());
  const key = (workflow: string, id: string) => `${workflow}\n${id}`;

  /** Enabled automations only — a paused one has no entry. */
  const entries = new Map<string, Entry>();
  const fireErrors = new Map<string, string>();
  const bornAt = clock();
  let loaded = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  // ── Schedule state ───────────────────────────────────────────────────────

  /** (Re)build one workflow's entries. An unchanged trigger keeps its
   *  `nextRunAt`, so an edit elsewhere never swallows a fire that is due. */
  function setEntries(workflow: string, automations: Automation[], after: Date = clock()): void {
    const keep = new Set<string>();
    for (const automation of automations) {
      if (!automation.enabled) continue;
      const k = key(workflow, automation.id);
      keep.add(k);
      const prev = entries.get(k);
      const same = prev && JSON.stringify(prev.automation.trigger) === JSON.stringify(automation.trigger);
      entries.set(k, { workflow, automation, nextRunAt: same ? prev.nextRunAt : nextFire(automation.trigger, after) });
    }
    for (const [k, e] of entries) if (e.workflow === workflow && !keep.has(k)) entries.delete(k);
  }

  /** The first load schedules from when this process was BORN, not from
   *  whenever the first tick happened to run: a fire due in the seconds
   *  between boot and that tick is late, never lost. */
  async function loadAll(): Promise<void> {
    const workflows = await workspace.listWorkflows();
    const names = new Set(workflows.map((w) => w.name));
    for (const w of workflows) setEntries(w.name, w.automations ?? [], bornAt);
    for (const [k, e] of entries) if (!names.has(e.workflow)) entries.delete(k);
    loaded = true;
  }

  // ── Run facts, from the run store ────────────────────────────────────────

  /** `run.start` never changes: remember which automation (if any) an
   *  unfinished run belongs to instead of re-reading its log every time. */
  const stamps = new Map<string, { id: string | null; startedAt: string }>();
  async function stampOf(workflow: string, runId: string): Promise<{ id: string | null; startedAt: string }> {
    const k = `${workflow}/${runId}`;
    let stamp = stamps.get(k);
    if (!stamp) {
      const start = (await store.getRunEvents(workflow, runId)).find((e) => e.type === "run.start");
      stamp = { id: start?.automation?.id ?? null, startedAt: start?.ts ?? "" };
      if (stamps.size > 500) stamps.clear();
      stamps.set(k, stamp);
    }
    return stamp;
  }

  /** One newest-first pass over a workflow's runs, for several automations
   *  at once: each one's latest run, latest SUCCESS (the `last` cursor), and
   *  any run of its that is still executing. */
  async function runFacts(workflow: string, ids: string[]): Promise<Map<string, RunFacts>> {
    const facts = new Map<string, RunFacts>(ids.map((id) => [id, { last: NO_LAST_RUN, lastRun: null, inFlight: null }]));
    const settled = new Set<string>();
    if (ids.length === 0) return facts;
    for (const runId of (await store.listRuns(workflow)).slice(0, SCAN_LIMIT)) {
      if (settled.size === ids.length) break;
      const summary = await store.getRunSummary(workflow, runId);
      if (!summary) {
        // No summary = executing here, or dead (stale). Only a live one counts.
        if (!deps.isInFlight(workflow, runId)) continue;
        const stamp = await stampOf(workflow, runId);
        const f = stamp.id ? facts.get(stamp.id) : undefined;
        if (!f) continue;
        f.inFlight ??= runId;
        f.lastRun ??= { runId, status: "running", startedAt: stamp.startedAt };
        continue;
      }
      const f = summary.automation ? facts.get(summary.automation.id) : undefined;
      if (!f || settled.has(summary.automation!.id)) continue;
      f.lastRun ??= { runId, status: summary.status, startedAt: summary.startedAt };
      if (summary.status === "success") {
        f.last = { runId, startedAt: summary.startedAt, finishedAt: summary.finishedAt, output: summary.output ?? {} };
        settled.add(summary.automation!.id);
      }
    }
    return facts;
  }

  // ── Firing ───────────────────────────────────────────────────────────────

  /** Launch one automation's run. `at` is the instant the input sees as
   *  `now`. The ONE overlap rule: no fire while the previous run is still
   *  going — two overlapping runs would read the same `last` cursor and
   *  process the same window twice. */
  async function fireOne(workflow: string, automation: Automation, at: Date): Promise<AutomationsResult<{ runId: string }>> {
    const k = key(workflow, automation.id);
    try {
      const facts = (await runFacts(workflow, [automation.id])).get(automation.id)!;
      if (facts.inFlight) return { error: `skipped: the previous run (${facts.inFlight}) is still in flight` };
      // Nobody to bill → nothing launches (surfaces as `lastFireError`), rather
      // than a run that dies at its first LLM step.
      const unowned = await ownerGate(workflow, true);
      if (unowned) throw new Error(unowned);
      const flow = await workspace.getWorkflow(workflow);
      const input = resolveAutomationInput(automation, at, facts.last);
      const runId = deps.launch(flow, input, { id: automation.id });
      fireErrors.delete(k);
      return { ok: true, runId };
    } catch (err) {
      // Nothing launched, so there is no run to show the failure on.
      fireErrors.set(k, message(err));
      console.error(`[automations] "${automation.name}" (${workflow}) launched nothing:`, message(err));
      return { error: message(err) };
    }
  }

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      if (!loaded) await loadAll();
      const now = clock();
      for (const entry of [...entries.values()]) {
        if (!entry.nextRunAt || entry.nextRunAt > now) continue;
        const due = entry.nextRunAt;
        // Advance FIRST: a crash between the two loses one run, never doubles one.
        entry.nextRunAt = nextFire(entry.automation.trigger, now);
        const result = await fireOne(entry.workflow, entry.automation, due);
        if ("error" in result && result.error.startsWith("skipped:")) {
          console.warn(`[automations] "${entry.automation.name}" (${entry.workflow}) ${result.error}`);
        }
      }
    } catch (err) {
      console.error("[automations] tick failed:", message(err));
    } finally {
      ticking = false;
    }
  }

  // ── Views ────────────────────────────────────────────────────────────────

  function view(workflow: string, automation: Automation, facts: RunFacts | undefined): AutomationView {
    const k = key(workflow, automation.id);
    // Before the first load there is no entry yet: compute rather than show "never".
    const next = entries.get(k)?.nextRunAt ?? (automation.enabled && !loaded ? nextFire(automation.trigger, clock()) : null);
    const fireError = fireErrors.get(k);
    return {
      ...automation,
      workflow,
      summary: describeTrigger(automation.trigger),
      nextRunAt: next ? next.toISOString() : null,
      lastRun: facts?.lastRun ?? null,
      running: !!facts?.inFlight,
      ...(fireError ? { lastFireError: fireError } : {}),
    };
  }

  async function viewsOf(workflow: string, automations: Automation[]): Promise<AutomationView[]> {
    const facts = await runFacts(workflow, automations.map((a) => a.id));
    return automations.map((a) => view(workflow, a, facts.get(a.id)));
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  /** Every mutation is a read-modify-write of one short list: run them one
   *  at a time so two racing requests cannot lose an edit. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function stored(workflow: string): Promise<Automation[] | null> {
    const meta = await workspace.getWorkflowMetadata(workflow);
    return meta ? (meta.automations ?? []) : null;
  }

  /** An automation is the one launch with nobody present: its runs are billed
   *  to the workflow's OWNER (plans/mothership-cost-control.md §2). Where the
   *  deployment requires someone to bill, an enabled automation on an ownerless
   *  workflow is refused here — the message, or null when it may proceed. */
  async function ownerGate(workflow: string, enabled: boolean): Promise<string | null> {
    if (!enabled || !principalRequired()) return null;
    const meta = await workspace.getWorkflowMetadata(workflow);
    if (!meta || meta.owner) return null;
    return `workflow "${workflow}" has no owner — its scheduled runs would have nobody to bill. Claim the workflow (or transfer it) first.`;
  }

  async function save(workflow: string, list: Automation[], changed: Automation): Promise<Saved> {
    await workspace.setWorkflowAutomations(workflow, list);
    fireErrors.delete(key(workflow, changed.id));
    setEntries(workflow, list);
    const [automation] = await viewsOf(workflow, [changed]);
    return { ok: true, automation: automation!, next: nextFires(changed.trigger, clock()).map((d) => d.toISOString()) };
  }

  /** An interval edited without an explicit anchor keeps its rhythm. */
  function triggerFrom(draft: TriggerDraft, existing?: Trigger): Trigger {
    const anchored =
      draft.every === "interval" && draft.anchor === undefined && existing?.every === "interval"
        ? { ...draft, anchor: existing.anchor }
        : draft;
    return normalizeTrigger(anchored, clock());
  }

  return {
    forget: (workflow) => setEntries(workflow, []),

    async list(workflow) {
      if (workflow !== undefined) {
        const list = await stored(workflow);
        return list ? viewsOf(workflow, list) : [];
      }
      const out: AutomationView[] = [];
      for (const w of await workspace.listWorkflows()) {
        if (w.automations?.length) out.push(...(await viewsOf(w.name, w.automations)));
      }
      return out;
    },

    create: (workflow, draft) =>
      serial(async () => {
        const parsed = automationDraftSchema.safeParse(draft);
        if (!parsed.success) return { error: issues(parsed.error) };
        const problems = checkInputTemplates(parsed.data.input ?? {});
        if (problems.length) return { error: problems.join("; ") };
        const list = await stored(workflow);
        if (!list) return { error: `Workflow "${workflow}" not found` };
        const unowned = await ownerGate(workflow, parsed.data.enabled ?? true);
        if (unowned) return { error: unowned };
        const automation: Automation = {
          id: `a-${randomUUID().slice(0, 8)}`,
          name: parsed.data.name,
          enabled: parsed.data.enabled ?? true,
          trigger: triggerFrom(parsed.data.trigger),
          input: parsed.data.input ?? {},
        };
        return save(workflow, [...list, automation], automation);
      }),

    update: (workflow, id, patch) =>
      serial(async () => {
        const parsed = automationPatchSchema.safeParse(patch);
        if (!parsed.success) return { error: issues(parsed.error) };
        const problems = checkInputTemplates(parsed.data.input ?? {});
        if (problems.length) return { error: problems.join("; ") };
        const list = await stored(workflow);
        if (!list) return { error: `Workflow "${workflow}" not found` };
        const current = list.find((a) => a.id === id);
        if (!current) return { error: `Automation "${id}" not found on workflow "${workflow}"` };
        const p = parsed.data;
        const unowned = await ownerGate(workflow, p.enabled ?? current.enabled);
        if (unowned) return { error: unowned };
        const automation: Automation = {
          id,
          name: p.name ?? current.name,
          enabled: p.enabled ?? current.enabled,
          trigger: p.trigger ? triggerFrom(p.trigger, current.trigger) : current.trigger,
          input: p.input ?? current.input,
        };
        return save(workflow, list.map((a) => (a.id === id ? automation : a)), automation);
      }),

    remove: (workflow, id) =>
      serial(async () => {
        const list = await stored(workflow);
        if (!list) return { error: `Workflow "${workflow}" not found` };
        if (!list.some((a) => a.id === id)) return { error: `Automation "${id}" not found on workflow "${workflow}"` };
        const rest = list.filter((a) => a.id !== id);
        await workspace.setWorkflowAutomations(workflow, rest);
        fireErrors.delete(key(workflow, id));
        setEntries(workflow, rest);
        return { ok: true, id };
      }),

    preview(trigger) {
      const parsed = triggerSchema.safeParse(trigger);
      if (!parsed.success) return { error: issues(parsed.error) };
      const normalized = normalizeTrigger(parsed.data, clock());
      return { ok: true, summary: describeTrigger(normalized), next: nextFires(normalized, clock()).map((d) => d.toISOString()) };
    },

    async fire(workflow, id) {
      const automation = (await stored(workflow))?.find((a) => a.id === id);
      if (!automation) return { error: `Automation "${id}" not found on workflow "${workflow}"` };
      return fireOne(workflow, automation, clock());
    },

    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), deps.tickMs ?? 15_000);
      // Never hold open a host that constructs strut and exits (tests, CLIs).
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    tick,
  };
}
