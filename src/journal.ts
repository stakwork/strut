/**
 * Resume journal (RUN_CONTROL_SPEC §5) — the event log already contains
 * everything a resume needs: every completed step's `step.end` carries its
 * `output`, keyed by a deterministic `path`. This module turns a run's
 * events into the `{ path → output }` journal `runWorkflow` replays from,
 * and implements the `from` invalidation ("re-run from this step", §5.2).
 */

import type { AppRef, Flow, RunAttachment, RunEvent, StartedBy, Step, WakeMark } from "./core.js";
import type { SubflowResolver } from "./runner.js";

/** Completed units: last `step.end` per path wins — a resumed log may carry
 *  a pre-failure entry AND a post-resume re-execution for the same path. */
export function buildJournal(events: RunEvent[]): Record<string, unknown> {
  const journal: Record<string, unknown> = {};
  for (const event of events) {
    if (event.type === "step.end") journal[event.path] = event.output;
  }
  return journal;
}

/** The run's original input and params, from `run.start` — a durable
 *  resume re-invokes with exactly these — and the workflow version it runs
 *  on now (`executedWorkflowHash`). */
export function readRunStart(
  events: RunEvent[],
): {
  input: unknown;
  workflowHash?: string;
  params?: Record<string, unknown>;
  paramOverrides?: Record<string, Record<string, unknown>>;
  /** Set for a nested run (§5.3: boot-time auto-resume resumes roots only). */
  parentRunId?: string;
  /** Set for a scheduled run — a resume keeps the stamp, so the summary it
   *  finally writes still names its automation (plans/automations.md §3). */
  automation?: { id: string };
  /** Who launched and who pays — a resume re-uses the recorded principal
   *  rather than re-deriving it (the owner may have changed since). */
  actor?: string;
  principal?: string;
  /** The job the run was launched under (plans/jobs.md §1) — kept by a resume. */
  job?: string;
  /** Who launched it, when not a person or an API call — a peer's run stays
   *  the peer's to control after a resume (plans/federation.md §3). */
  origin?: RunEvent["origin"];
  /** A peer's run a person's credential launched — a resume keeps it, so
   *  the run opens the same person's sessions (plans/chained-orchestrators.md §2). */
  peerPerson?: true;
  /** The conversation a person's turn continues — a resume opens it again
   *  (plans/jamie-app.md §2.2). */
  continues?: string;
  /** The files the launch attached, saved under the run's artifacts — a
   *  resume hands them to its steps again. */
  attachments?: RunAttachment[];
  /** The app a page's launch ran for (`origin: "app"`) — a resume keeps it,
   *  so the run's agent sessions stay under the app's namespace. */
  app?: AppRef;
  /** The turn that started a job run — a resume keeps it, so the run's
   *  `run.end` still names it (CALLBACKS.md §2). */
  startedBy?: StartedBy;
  /** The conversation a host's launch named — a resume keeps it, so the
   *  job run's end still wakes it (src/wake.ts). */
  conversation?: string;
  /** The host asked for strut's wake — a resume keeps it. */
  wakeAsked?: true;
  /** A wake turn's mark — a resume keeps it, so its end is still heard. */
  wake?: WakeMark;
  /** A public run's own cost cap (plans/paid-runs.md §7) — a resume keeps
   *  it, so the Mothership's link carries the same cap. */
  maxCostUsd?: number;
  /** A priced public run's credit token id (§6) — a resume keeps it: the
   *  same sessions' namespace, the same token charged at the end. */
  credit?: string;
  /** A public run a visitor's app page launched (§10): the visit's hash —
   *  a resume keeps it, so the visit still reads its run. */
  visitor?: string;
} | null {
  const start = events.find((e) => e.type === "run.start");
  if (!start) return null;
  return {
    input: start.input,
    workflowHash: executedWorkflowHash(events),
    params: start.params,
    paramOverrides: start.paramOverrides,
    parentRunId: start.parentRunId,
    automation: start.automation,
    actor: start.actor,
    principal: start.principal,
    job: start.job,
    origin: start.origin,
    ...(start.peerPerson ? { peerPerson: true as const } : {}),
    ...(start.continues ? { continues: start.continues } : {}),
    attachments: start.attachments,
    ...(typeof start.maxCostUsd === "number" ? { maxCostUsd: start.maxCostUsd } : {}),
    ...(typeof start.credit === "string" ? { credit: start.credit } : {}),
    ...(typeof start.visitor === "string" ? { visitor: start.visitor } : {}),
    ...(start.app ? { app: start.app } : {}),
    ...(start.startedBy ? { startedBy: start.startedBy } : {}),
    ...(start.conversation ? { conversation: start.conversation } : {}),
    ...(start.wakeAsked ? { wakeAsked: true as const } : {}),
    ...(start.wake ? { wake: start.wake } : {}),
  };
}

/** The workflow version a run executes NOW: the hash its newest durable
 *  `run.resumed` recorded — a resume may move a run onto another version
 *  (`changedSteps`) — else `run.start`'s. */
export function executedWorkflowHash(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "run.resumed" && !e.live && e.workflowHash) return e.workflowHash;
    if (e.type === "run.start") return e.workflowHash;
  }
  return undefined;
}

/** JSON with object keys sorted, so two loads of the same YAML compare
 *  equal whatever order their keys came in. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** A step's dependencies as the runner reads them: `depends`, else the
 *  step before it. */
function effectiveDeps(steps: Step[], i: number): string[] {
  const s = steps[i]!;
  if (s.depends != null) return Array.isArray(s.depends) ? s.depends : [s.depends];
  return i > 0 ? [steps[i - 1]!.id] : [];
}

/** The top-level steps of `next` that would not do what they did in `prev`:
 *  new, or changed in any part of their definition — type, config,
 *  dependencies (implicit ones included, so a reorder counts), `when`,
 *  options — or reading a `params` default that changed. A change of the
 *  workflow's `settings` changes every step. What a resume onto another
 *  version re-runs, with everything downstream (`invalidateSteps`); the
 *  rest replays. A subflow's child is not compared: it runs whatever
 *  version it names, as on any resume. */
export function changedSteps(prev: Flow, next: Flow): string[] {
  if (stable(prev.settings ?? {}) !== stable(next.settings ?? {})) return next.steps.map((s) => s.id);
  const before = new Map(prev.steps.map((s, i) => [s.id, stable({ ...s, depends: effectiveDeps(prev.steps, i) })]));
  const prevParams = prev.params ?? {};
  const nextParams = next.params ?? {};
  const params = [...new Set([...Object.keys(prevParams), ...Object.keys(nextParams)])].filter(
    (k) => stable(prevParams[k]) !== stable(nextParams[k]),
  );
  const escape = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const readsChanged = params.length
    ? new RegExp(
        // `params.k`, `params["k"]` (its quotes escaped in the JSON), or
        // `params` whole: `{{ params }}`, `toJson(params)`.
        `\\bparams\\s*(?:\\.\\s*(?:${params.map(escape).join("|")})\\b|\\[\\s*\\\\?["'](?:${params.map(escape).join("|")})\\\\?["']\\s*\\]|(?=\\}\\}|\\)))`,
      )
    : null;
  const changed: string[] = [];
  next.steps.forEach((s, i) => {
    const now = stable({ ...s, depends: effectiveDeps(next.steps, i) });
    if (before.get(s.id) !== now || readsChanged?.test(now)) changed.push(s.id);
  });
  return changed;
}

/** Drop every top-level step in `ids`, and everything downstream of each in
 *  `flow`, from the journal — so they re-run while the rest replays. */
export function invalidateSteps(
  journal: Record<string, unknown>,
  ids: string[],
  flow: Flow,
): { journal: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = { ...journal };
  const dropped = new Set<string>();
  const targets = new Set(ids);
  for (const id of ids) for (const dep of transitiveDependents(flow.steps, id)) targets.add(dep);
  for (const id of targets) {
    const prefix = `${flow.name}/${id}`;
    for (const key of Object.keys(kept)) {
      if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}#`)) {
        delete kept[key];
        dropped.add(key);
      }
    }
  }
  return { journal: kept, dropped: [...dropped].sort() };
}

export interface InvalidateResult {
  journal: Record<string, unknown>;
  /** Journal keys dropped (forced to re-execute), sorted. */
  dropped: string[];
  /** Levels where dependent-computation was impossible (dynamic subflow
   *  name, missing resolver) — the target subtree is still dropped, but
   *  same-level dependents of that container may replay stale outputs. */
  warnings: string[];
}

/**
 * §5.2 `from`: forced invalidation. Drop `from`'s own subtree, its ancestor
 * container entries (so containers re-execute and re-reach it), the later
 * iterations of any enclosing `loop` (sequential — they consumed its
 * output), and the transitive dependents of every step on the ancestor
 * chain at its own flow level. Everything left in the journal replays.
 */
export async function invalidateFrom(
  journal: Record<string, unknown>,
  from: string,
  entryFlow: Flow,
  resolver?: SubflowResolver,
): Promise<InvalidateResult> {
  const kept: Record<string, unknown> = { ...journal };
  const dropped = new Set<string>();
  const warnings: string[] = [];

  const dropExact = (key: string) => {
    if (key in kept) {
      delete kept[key];
      dropped.add(key);
    }
  };
  const dropSubtree = (prefix: string) => {
    for (const key of Object.keys(kept)) {
      if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}#`)) {
        delete kept[key];
        dropped.add(key);
      }
    }
  };

  const prefix = `${entryFlow.name}/`;
  if (!from.startsWith(prefix)) {
    throw new Error(
      `from path "${from}" is not under workflow "${entryFlow.name}"`,
    );
  }
  const segments = from.slice(prefix.length).split("/");

  // Walk the ancestor chain level by level. At each level we know the flow's
  // steps, so we can compute same-level transitive dependents; descending
  // requires resolving the container's child flow (subflow → its workflow;
  // foreach/loop → their body, which may itself be a subflow).
  let flow: Flow | null = entryFlow;
  let pathPrefix = entryFlow.name; // path up to (excluding) the current segment

  for (let level = 0; level < segments.length; level++) {
    const segment = segments[level]!;
    const hash = segment.indexOf("#");
    const stepId = hash >= 0 ? segment.slice(0, hash) : segment;
    const iteration = hash >= 0 ? Number(segment.slice(hash + 1)) : undefined;
    const segmentPath = `${pathPrefix}/${segment}`;
    const stepPath = `${pathPrefix}/${stepId}`;
    const isLast = level === segments.length - 1;

    if (!flow) {
      warnings.push(
        `could not resolve the flow at "${pathPrefix}" — dependents of "${segment}" at that level may replay stale outputs`,
      );
      // Still drop the target subtree + remaining ancestor entries coarsely.
      dropExact(stepPath);
      if (!isLast) {
        dropExact(segmentPath);
        pathPrefix = segmentPath;
        continue;
      }
      dropSubtree(segmentPath);
      break;
    }

    const step = flow.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(
        `from path "${from}": step "${stepId}" not found in workflow "${flow.name}"`,
      );
    }

    // Same-level transitive dependents of this ancestor: they consumed its
    // output, so they re-execute.
    for (const dep of transitiveDependents(flow.steps, stepId)) {
      dropSubtree(`${pathPrefix}/${dep}`);
    }

    // Enclosing `loop` iterations are SEQUENTIAL: later iterations consumed
    // this one's `$current`, so invalidating #i invalidates every #j > i.
    // (`foreach` iterations are independent — siblings replay.)
    if (iteration !== undefined && step.type === "loop") {
      for (const key of Object.keys(kept)) {
        const m = keyIteration(key, stepPath);
        if (m !== null && m > iteration) dropSubtree(`${stepPath}#${m}`);
      }
    }

    if (isLast) {
      // The target itself: subtree (exact + iterations + descendants).
      dropSubtree(segmentPath);
      if (iteration !== undefined) dropExact(stepPath); // container entry too
      break;
    }

    // An ancestor container: drop its own completed entries (whole-step and,
    // when the path descends through an iteration, that iteration's entry) so
    // it re-executes down to the target — sibling iterations stay journaled.
    dropExact(stepPath);
    if (iteration !== undefined) dropExact(segmentPath);

    flow = await childFlowOf(step, resolver);
    pathPrefix = segmentPath;
  }

  return { journal: kept, dropped: [...dropped].sort(), warnings };
}

/** `#i` of `key` when it is exactly `<stepPath>#<i>` or a descendant of it. */
function keyIteration(key: string, stepPath: string): number | null {
  if (!key.startsWith(`${stepPath}#`)) return null;
  const rest = key.slice(stepPath.length + 1);
  const end = rest.search(/[/#]/);
  const n = Number(end === -1 ? rest : rest.slice(0, end));
  return Number.isInteger(n) ? n : null;
}

/** Transitive dependents of `stepId` under the runner's dependency
 *  semantics: explicit `depends`, or implicit previous-step. */
export function transitiveDependents(steps: Step[], stepId: string): Set<string> {
  const depsOf = new Map<string, string[]>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    depsOf.set(
      s.id,
      s.depends != null
        ? Array.isArray(s.depends)
          ? s.depends
          : [s.depends]
        : i > 0
          ? [steps[i - 1]!.id]
          : [],
    );
  }
  const dependents = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of steps) {
      if (dependents.has(s.id) || s.id === stepId) continue;
      const deps = depsOf.get(s.id)!;
      if (deps.some((d) => d === stepId || dependents.has(d))) {
        dependents.add(s.id);
        grew = true;
      }
    }
  }
  return dependents;
}

/** Resolve the flow a path descends INTO through `step`: a subflow's target
 *  workflow, or a foreach/loop whose body is a subflow. Only statically
 *  named targets resolve (no `{{ }}`); anything else → null (the caller
 *  records a warning and degrades to coarse dropping). */
async function childFlowOf(
  step: Step,
  resolver?: SubflowResolver,
): Promise<Flow | null> {
  let target = step;
  if (step.type === "foreach" || step.type === "loop") {
    const body = step.config["body"] as Step | undefined;
    if (!body || body.type !== "subflow") return null;
    target = body;
  }
  if (target.type !== "subflow" || !resolver) return null;
  const name = target.config["workflow"];
  const version = target.config["version"];
  if (typeof name !== "string" || name.includes("{{")) return null;
  try {
    return typeof version === "string" && !version.includes("{{")
      ? await resolver.getWorkflowVersion(name, version)
      : await resolver.getWorkflow(name);
  } catch {
    return null;
  }
}
