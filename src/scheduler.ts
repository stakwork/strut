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
 *
 * A package's schedules (`schedules:` in its strut.yaml) are automations
 * too, marked with their package and made exactly by
 * `syncPackageSchedules`: when one runs, its name and its input are the
 * package's, and on or off is the admin's. `runsAs` names whom a fire runs
 * as.
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
  noRunsToCome,
  automationCallbackSecret,
  normalizeTrigger,
  packageAutomationId,
  resolveAutomationInput,
  triggerSchema,
  type Automation,
  type LastRun,
  type Trigger,
  type TriggerDraft,
} from "./automations.js";
import { callbackOrigin } from "./callback.js";
import type { Flow } from "./core.js";
import type { SecretStore } from "./secret-store.js";
import type { RunStore } from "./store.js";
import { workflowDisabled, type WorkspaceStore } from "./workspace.js";
import { principalRequired } from "./auth.js";

export interface AutomationsDeps {
  workspace: WorkspaceStore;
  store: RunStore;
  /** Launch a run detached, stamped as this automation's; returns its id.
   *  `callback` is the automation's, when it has one: `run.end` goes there.
   *  `principal` is whom the run acts as and bills (`runsAs`); absent, the
   *  launch's own default (the workflow's owner, createStrut `principalFor`). */
  launch: (flow: Flow, input: Record<string, unknown>, automation: { id: string }, callback?: { url: string }, principal?: string) => string;
  /** Where an automation's callback URL is kept — a credential, never in
   *  the workflow metadata, and a store of its own (`AUTOMATION_CALLBACKS_FILE`),
   *  never the deployment's secrets, which every step can read. Without it,
   *  an automation cannot take one. */
  secrets?: Pick<SecretStore, "get" | "set" | "delete">;
  /** Is this run executing in THIS process right now? */
  isInFlight: (workflow: string, runId: string) => boolean;
  /** The refusal while the deployment drains (src/drain.ts): fires are
   *  held, like a disabled workflow's — nothing launches, nothing is
   *  recorded as a failure. */
  draining?: () => string | undefined;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Tick period. Default 15 s. */
  tickMs?: number;
}

/** An automation as both doors show it: the record plus what is derived. */
export interface AutomationView extends Automation {
  workflow: string;
  /** The workflow's category — "system" marks a built-in (src/system-workflows.ts). */
  category?: string;
  /** The trigger as one plain sentence. */
  summary: string;
  /** ISO instant of the next fire; null when paused or never again. */
  nextRunAt: string | null;
  /** This automation's latest run, any status. */
  lastRun: { runId: string; status: "running" | "success" | "error" | "cancelled" | "waiting"; startedAt: string } | null;
  /** Its previous run is still executing — a fire now would be skipped. */
  running: boolean;
  /** Why the latest fire launched nothing (memory only; lost on restart). */
  lastFireError?: string;
}

export type AutomationsResult<T> = ({ ok: true } & T) | { error: string };
type Saved = AutomationsResult<{ automation: AutomationView; next: string[] }>;

/** A schedule a package ships (`schedules:` in its strut.yaml,
 *  src/packages/schedules.ts): an automation's draft on a workflow of the
 *  package, named for the package. */
export interface ShippedSchedule {
  package: string;
  name: string;
  workflow: string;
  trigger: TriggerDraft;
  input: Record<string, unknown>;
}

/** What a sync did, each as `<workflow>: <name>`. */
export interface ScheduleSync {
  made: string[];
  changed: string[];
  dropped: string[];
  warnings: string[];
}

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
  /** Drop a workflow's schedules from the tick loop and their callback
   *  secrets (the workflow is being deleted; its metadata goes with it). */
  forget(workflow: string): Promise<void>;
  /** Make the automations packages ship exactly `shipped`: one each, on its
   *  workflow, its id `packageAutomationId(package, name)`. What is missing
   *  is made (on), a changed trigger, input or name is followed, and an
   *  automation of a package that no longer ships it is dropped; on or off
   *  stays as the admin left it. A package in `keep` (its manifest could not
   *  be read) keeps what it has. Never touches an automation no package
   *  made. */
  syncPackageSchedules(shipped: ShippedSchedule[], keep?: string[]): Promise<ScheduleSync>;
  /** Begin ticking (idempotent). The timer is unref'd. */
  start(): void;
  stop(): void;
  /** One pass over what is due — the timer's body, callable from tests. */
  tick(): Promise<void>;
}

const NO_SECRETS = "callback: this strut server has no secret store to keep its URL in";

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
  /** Automations a fire is launching now: one at a time each. */
  const firing = new Set<string>();
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
   *  unfinished run belongs to instead of re-reading its log every time.
   *  Only once it is written: a launch lists the run (its callback, beside
   *  the log) before then, and `fire` answers before then too. */
  const stamps = new Map<string, { id: string | null; startedAt: string }>();
  async function stampOf(workflow: string, runId: string): Promise<{ id: string | null; startedAt: string }> {
    const k = `${workflow}/${runId}`;
    let stamp = stamps.get(k);
    if (!stamp) {
      const start = (await store.getRunEvents(workflow, runId)).find((e) => e.type === "run.start");
      stamp = { id: start?.automation?.id ?? null, startedAt: start?.ts ?? "" };
      if (!start) return stamp;
      if (stamps.size > 500) stamps.clear();
      stamps.set(k, stamp);
    }
    return stamp;
  }

  /** Runs a fire launched whose `run.start` is not written yet: a launch
   *  answers first and stamps the run after. Kept until the stamp can be
   *  read or the run is over, so a read or a fire in that gap sees the run
   *  as its automation's, in flight. */
  const launched = new Map<string, { workflow: string; runId: string; id: string; startedAt: string }>();

  /** One newest-first pass over a workflow's runs, for several automations
   *  at once: each one's latest run, latest SUCCESS (the `last` cursor), and
   *  any run of its that is still executing. */
  async function runFacts(workflow: string, ids: string[]): Promise<Map<string, RunFacts>> {
    const facts = new Map<string, RunFacts>(ids.map((id) => [id, { last: NO_LAST_RUN, lastRun: null, inFlight: null }]));
    const settled = new Set<string>();
    if (ids.length === 0) return facts;
    // The newest run of its automation, whatever the scan below finds.
    for (const [k, run] of launched) {
      if (!deps.isInFlight(run.workflow, run.runId) || (await stampOf(run.workflow, run.runId)).id !== null) {
        launched.delete(k);
        continue;
      }
      const f = run.workflow === workflow ? facts.get(run.id) : undefined;
      if (!f) continue;
      f.inFlight = run.runId;
      f.lastRun = { runId: run.runId, status: "running", startedAt: run.startedAt };
    }
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
    // Two fires at once (a tick and a Run now) would both pass the check below.
    if (firing.has(k)) return { error: "skipped: a fire of it is already launching" };
    firing.add(k);
    try {
      // A disabled workflow holds its schedules: nothing launches and nothing
      // is recorded as a failure, so it reads as paused, not broken.
      const disabled = await workflowDisabled(workspace, workflow);
      if (disabled) return { error: disabled };
      const draining = deps.draining?.();
      if (draining) return { error: draining };
      const facts = (await runFacts(workflow, [automation.id])).get(automation.id)!;
      if (facts.inFlight) return { error: `skipped: the previous run (${facts.inFlight}) is still in flight` };
      // Nobody to bill → nothing launches (surfaces as `lastFireError`), rather
      // than a run that dies at its first LLM step.
      const unowned = await ownerGate(workflow, true);
      if (unowned) throw new Error(unowned);
      const person = await runsAs(workflow, automation);
      if ("error" in person) throw new Error(person.error);
      const flow = await workspace.getWorkflow(workflow);
      const input = resolveAutomationInput(automation, at, facts.last);
      const callback = await callbackOf(automation);
      const runId = deps.launch(flow, input, { id: automation.id }, callback, person.principal);
      launched.set(`${workflow}/${runId}`, { workflow, runId, id: automation.id, startedAt: clock().toISOString() });
      fireErrors.delete(k);
      return { ok: true, runId };
    } catch (err) {
      // Nothing launched, so there is no run to show the failure on.
      fireErrors.set(k, message(err));
      console.error(`[automations] "${automation.name}" (${workflow}) launched nothing:`, message(err));
      return { error: message(err) };
    } finally {
      firing.delete(k);
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

  function view(workflow: string, automation: Automation, facts: RunFacts | undefined, category?: string): AutomationView {
    const k = key(workflow, automation.id);
    // Before the first load there is no entry yet: compute rather than show "never".
    const next = entries.get(k)?.nextRunAt ?? (automation.enabled && !loaded ? nextFire(automation.trigger, clock()) : null);
    const fireError = fireErrors.get(k);
    return {
      ...automation,
      workflow,
      ...(category ? { category } : {}),
      summary: describeTrigger(automation.trigger),
      nextRunAt: next ? next.toISOString() : null,
      lastRun: facts?.lastRun ?? null,
      running: !!facts?.inFlight,
      ...(fireError ? { lastFireError: fireError } : {}),
    };
  }

  async function viewsOf(workflow: string, automations: Automation[], category?: string): Promise<AutomationView[]> {
    const facts = await runFacts(workflow, automations.map((a) => a.id));
    return automations.map((a) => view(workflow, a, facts.get(a.id), category));
  }

  // ── Callbacks ────────────────────────────────────────────────────────────

  /** The URL a fire posts `run.end` to. One whose secret has gone fires
   *  without it, loudly: the run still happens and is on record. */
  async function callbackOf(automation: Automation): Promise<{ url: string } | undefined> {
    if (!automation.callback) return undefined;
    const url = await deps.secrets?.get(automationCallbackSecret(automation.id));
    if (url) return { url };
    console.warn(`[automations] "${automation.name}": its callback URL is not in the secret store; this fire posts no run.end.`);
    return undefined;
  }

  /** Store a draft's callback (`{ url }`), or clear it (`null`); the record
   *  keeps the origin. `undefined` leaves `current` as it is. */
  async function saveCallback(id: string, cb: { url: string } | null | undefined, current?: Automation["callback"]): Promise<Automation["callback"]> {
    if (cb === undefined) return current;
    const name = automationCallbackSecret(id);
    if (cb === null) {
      if (current) await deps.secrets?.delete(name);
      return undefined;
    }
    await deps.secrets!.set(name, cb.url);
    return { origin: callbackOrigin(cb.url) };
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

  /**
   * Whom a fire runs as: its principal, whose secrets it reads and who pays.
   * THE PLACE A PERSON IS NAMED for a schedule nobody launches (stadeum
   * plans/software.md §5, item 15: unattended work runs as a person).
   *
   * Today: an automation a person made through a door gives no principal,
   * so the launch takes the workflow's owner, else none (createStrut
   * `principalFor`). A PACKAGE's schedule was made by nobody, so it runs as
   * its workflow's owner — whoever installed the package through a
   * person's door — and with no owner (the distro's install, a boot
   * install, an install with no actor) it launches nothing and says why,
   * rather than run as nobody on the deployment's secrets.
   */
  async function runsAs(workflow: string, automation: Automation): Promise<{ principal?: string } | { error: string }> {
    if (!automation.package) return {};
    const owner = (await workspace.getWorkflowMetadata(workflow))?.owner;
    if (owner) return { principal: owner };
    return {
      error:
        `nobody to run as: "${automation.name}" is the package ${automation.package}'s schedule, which runs as a person — ` +
        `the workflow's owner, whoever installed the package — and "${workflow}" has no owner. ` +
        `Claim it (POST /actor/claim) or give it one (PUT /workflows/:name/owner), and it runs as them.`,
    };
  }

  /** A package's schedule: what only its releases change. */
  const packageOwns = (a: Automation) =>
    `"${a.name}" is the package ${a.package}'s schedule: when it runs, its name and its input follow the package's releases. ` +
    `Pause or resume it here; for another rhythm or input, pause it and add an automation of your own.`;

  /** The automation a package's schedule is: `existing`'s on or off, and an
   *  interval's anchor while its rhythm is the same, kept. */
  function shippedAutomation(s: ShippedSchedule, existing?: Automation): Automation {
    return {
      id: packageAutomationId(s.package, s.name),
      name: s.name,
      enabled: existing?.enabled ?? true,
      trigger: triggerFrom(s.trigger, existing?.trigger),
      input: s.input,
      package: s.package,
    };
  }

  async function save(workflow: string, list: Automation[], changed: Automation, category: string | undefined): Promise<Saved> {
    await workspace.setWorkflowAutomations(workflow, list);
    fireErrors.delete(key(workflow, changed.id));
    setEntries(workflow, list);
    const [automation] = await viewsOf(workflow, [changed], category);
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
    async forget(workflow) {
      setEntries(workflow, []);
      const list = (await workspace.getWorkflowMetadata(workflow).catch(() => null))?.automations ?? [];
      for (const a of list) await saveCallback(a.id, null, a.callback);
    },

    syncPackageSchedules: (shipped, keep = []) =>
      serial(async () => {
        const out: ScheduleSync = { made: [], changed: [], dropped: [], warnings: [] };
        const workflows = await workspace.listWorkflows();
        const here = new Set(workflows.map((w) => w.name));
        /** id → the schedule shipped under it, on a workflow that is here. */
        const want = new Map<string, ShippedSchedule>();
        for (const s of shipped) {
          if (here.has(s.workflow)) want.set(packageAutomationId(s.package, s.name), s);
          else out.warnings.push(`${s.package}'s schedule "${s.name}" is not made: its workflow ${s.workflow} is not here`);
        }
        for (const w of workflows) {
          const list = w.automations ?? [];
          const next: Automation[] = [];
          const placed = new Set<string>();
          let dirty = false;
          for (const a of list) {
            const s = want.get(a.id);
            if (!a.package) {
              // An automation no package made, under a shipped id: left alone.
              if (s?.workflow === w.name) {
                out.warnings.push(`${s.package}'s schedule "${s.name}" is not made: ${w.name} has an automation of its own under its id ${a.id}`);
                placed.add(a.id);
              }
              next.push(a);
              continue;
            }
            if (keep.includes(a.package)) {
              next.push(a);
              continue;
            }
            // No longer shipped, shipped on another workflow, or here twice: dropped.
            if (!s || s.workflow !== w.name || s.package !== a.package || placed.has(a.id)) {
              dirty = true;
              fireErrors.delete(key(w.name, a.id));
              out.dropped.push(`${w.name}: ${a.name}`);
              continue;
            }
            const followed = shippedAutomation(s, a);
            if (JSON.stringify(followed) !== JSON.stringify(a)) {
              dirty = true;
              out.changed.push(`${w.name}: ${followed.name}`);
            }
            next.push(followed);
            placed.add(a.id);
          }
          for (const [id, s] of want) {
            if (s.workflow !== w.name || placed.has(id)) continue;
            const made = shippedAutomation(s);
            next.push(made);
            dirty = true;
            out.made.push(`${w.name}: ${made.name}`);
          }
          if (!dirty) continue;
          await workspace.setWorkflowAutomations(w.name, next);
          setEntries(w.name, next);
        }
        return out;
      }),

    async list(workflow) {
      if (workflow !== undefined) {
        const meta = await workspace.getWorkflowMetadata(workflow);
        return meta ? viewsOf(workflow, meta.automations ?? [], meta.category) : [];
      }
      const out: AutomationView[] = [];
      for (const w of await workspace.listWorkflows()) {
        if (w.automations?.length) out.push(...(await viewsOf(w.name, w.automations, w.category)));
      }
      return out;
    },

    create: (workflow, draft) =>
      serial(async () => {
        const parsed = automationDraftSchema.safeParse(draft);
        if (!parsed.success) return { error: issues(parsed.error) };
        const problems = checkInputTemplates(parsed.data.input ?? {});
        if (problems.length) return { error: problems.join("; ") };
        const meta = await workspace.getWorkflowMetadata(workflow);
        if (!meta) return { error: `Workflow "${workflow}" not found` };
        const list = meta.automations ?? [];
        const unowned = await ownerGate(workflow, parsed.data.enabled ?? true);
        if (unowned) return { error: unowned };
        if (parsed.data.callback && !deps.secrets) return { error: NO_SECRETS };
        const id = parsed.data.id ?? `a-${randomUUID().slice(0, 8)}`;
        if (list.some((a) => a.id === id)) return { error: `Automation "${id}" exists already on workflow "${workflow}"` };
        const trigger = triggerFrom(parsed.data.trigger);
        if (!nextFires(trigger, clock()).length) return { error: noRunsToCome(describeTrigger(trigger)) };
        const callback = await saveCallback(id, parsed.data.callback ?? undefined);
        const automation: Automation = {
          id,
          name: parsed.data.name,
          enabled: parsed.data.enabled ?? true,
          trigger,
          input: parsed.data.input ?? {},
          ...(callback ? { callback } : {}),
        };
        return save(workflow, [...list, automation], automation, meta.category);
      }),

    update: (workflow, id, patch) =>
      serial(async () => {
        const parsed = automationPatchSchema.safeParse(patch);
        if (!parsed.success) return { error: issues(parsed.error) };
        const problems = checkInputTemplates(parsed.data.input ?? {});
        if (problems.length) return { error: problems.join("; ") };
        const meta = await workspace.getWorkflowMetadata(workflow);
        if (!meta) return { error: `Workflow "${workflow}" not found` };
        const list = meta.automations ?? [];
        const current = list.find((a) => a.id === id);
        if (!current) return { error: `Automation "${id}" not found on workflow "${workflow}"` };
        const p = parsed.data;
        const trigger = p.trigger ? triggerFrom(p.trigger, current.trigger) : current.trigger;
        // A package's schedule takes on or off alone.
        if (
          current.package &&
          ((p.name ?? current.name) !== current.name ||
            JSON.stringify(p.input ?? current.input) !== JSON.stringify(current.input) ||
            JSON.stringify(trigger) !== JSON.stringify(current.trigger) ||
            p.callback)
        ) {
          return { error: packageOwns(current) };
        }
        const unowned = await ownerGate(workflow, p.enabled ?? current.enabled);
        if (unowned) return { error: unowned };
        if (p.callback && !deps.secrets) return { error: NO_SECRETS };
        // `callback`: absent keeps it, null clears it.
        if (p.trigger && !nextFires(trigger, clock()).length) return { error: noRunsToCome(describeTrigger(trigger)) };
        const callback = await saveCallback(id, p.callback, current.callback);
        const automation: Automation = {
          id,
          name: p.name ?? current.name,
          enabled: p.enabled ?? current.enabled,
          trigger,
          input: p.input ?? current.input,
          ...(callback ? { callback } : {}),
          ...(current.package ? { package: current.package } : {}),
        };
        return save(workflow, list.map((a) => (a.id === id ? automation : a)), automation, meta.category);
      }),

    remove: (workflow, id) =>
      serial(async () => {
        const meta = await workspace.getWorkflowMetadata(workflow);
        if (!meta) return { error: `Workflow "${workflow}" not found` };
        const list = meta.automations ?? [];
        const target = list.find((a) => a.id === id);
        if (!target) return { error: `Automation "${id}" not found on workflow "${workflow}"` };
        // A release would only make it again: pausing is how it stops.
        if (target.package) {
          return { error: `"${target.name}" is the package ${target.package}'s schedule, made again at each release: pause it, or uninstall the package.` };
        }
        const rest = list.filter((a) => a.id !== id);
        await workspace.setWorkflowAutomations(workflow, rest);
        await saveCallback(id, null, list.find((a) => a.id === id)?.callback);
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
      const automation = (await workspace.getWorkflowMetadata(workflow))?.automations?.find((a) => a.id === id);
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
