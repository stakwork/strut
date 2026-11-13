/**
 * What anyone may RUN on this strut server (plans/paid-runs.md §2): the
 * rules over the Public view record's `runnable` list that need the server
 * — the workspace, the registry, the wallet — beside its shape
 * (`runnableShapeProblem`, src/public-surface.ts).
 *
 * - `runnableProblem` — why an item may not be saved as runnable, naming
 *   it. `PUT /public-view` asks it of every item; the launch (work item 3)
 *   and a priced launch (item 5) ask nothing more of the record.
 * - `closureCan` — what a workflow's closure can do (`spends` / `acts` /
 *   `code`, src/packages/detail.ts's flags over a live closure): what the
 *   dialog shows when "anyone can run it" is turned on.
 * - `runnableReserve` — the most a run could be charged (decision 21).
 * - `recentCosts` — what an item's runs here cost, from run summaries: what
 *   the dialog sets a markup and a cap against.
 * - `listRunnable` — `GET /public`'s `runnable`: what a caller needs to
 *   decide and to call.
 *
 * Nothing here launches a run.
 */
import type { Flow, Step, StepRegistry } from "./core.js";
import type { WorkspaceStore } from "./workspace.js";
import type { RunStore } from "./store.js";
import { flowClosure, globToRegExp, type FlowClosure } from "./closure.js";
import { isSealedStep, sealedInClosure, sealedStepPatterns } from "./sealed.js";
import { PAID_OR_SHELL } from "./apps/tools.js";
import { SPENDING_STEPS, type PackageCan } from "./packages/detail.js";
import { configSecretField } from "./reach.js";
import { stepSchemas } from "./ai/schemaHelpers.js";
import { baseType } from "./step-ref.js";
import { isFree, microsToUsd, priceOf, RECENT_DAYS, reserveFor, usdToMicros, type LedgerStore, type Micros } from "./payments/ledger.js";
import { runnableLabel, type PublicRunnable, type PublicSurface } from "./public-surface.js";

export interface RunnableDeps {
  workspace: Pick<WorkspaceStore, "getWorkflow" | "getWorkflowVersion" | "getWorkflowMetadata">;
  /** The live registry (it changes at every rebuild). */
  registry: () => StepRegistry;
  /** Where each registry step came from (`core` | `lib` | `custom`). */
  stepSources: () => Record<string, string>;
  /** A wallet is set: strut's (`payments.json`) or the host's own
   *  `services.lightning`. */
  wallet: () => boolean;
  /** The one principal a host bills every public run to
   *  (`createStrut({ publicRuns: { principal } })`, §6). */
  principal?: string;
  sealedPatterns?: readonly string[];
}

/** The runner's container steps: a stranger's config would choose the
 *  workflow or the steps they run. A workflow that holds one is runnable. */
const CONTAINER_STEPS: ReadonlySet<string> = new Set(["subflow", "loop", "foreach", "if"]);

/** Steps that park the run (src/park.ts): a public run cannot wait, so one
 *  would only fail `park_refused:` (plans/human-steps.md §3). */
const PARKING_STEPS: ReadonlySet<string> = new Set(["human"]);
const parksWhy = "waits for a person, and a public run cannot wait (park_refused:)";

/** The ledger's subject for an item: `workflow:<name>` or `step:<type>`. */
export const runnableSubject = (r: Pick<PublicRunnable, "kind" | "name">): string => `${r.kind}:${r.name}`;

/** The most a run of `item` could be charged: base + markup × its per-run
 *  cap (decision 21). Without a cap only the base: a markup needs one. */
export function runnableReserve(item: PublicRunnable): Micros {
  return reserveFor(priceOf(item), usdToMicros(item.capUsd ?? 0));
}

/** Is `item` priced (a base or a markup above zero)? */
export const isPriced = (item: PublicRunnable): boolean => !isFree(priceOf(item));

/** How many runs of an item with a daily cap and no per-run cap fit in the
 *  daily cap at once: each may spend that share of it. A run in flight
 *  counts against the daily cap at its own cap (§7), so with a run's cap
 *  left at "what is left of the day" one would run at a time. The dialog
 *  says the same number (web/src/public-view.ts, held equal by its test). */
export const DAILY_CAP_SHARE = 10;

/** The most one run of `item` may spend, in dollars, before the workflow's
 *  own cap and what is left of the day are taken into account: its
 *  `capUsd`, else a `DAILY_CAP_SHARE`th of its daily cap; none when it sets
 *  neither. */
export function perRunCapUsd(item: Pick<PublicRunnable, "capUsd" | "dailyCapUsd">): number | undefined {
  if (item.capUsd !== undefined) return item.capUsd;
  return item.dailyCapUsd !== undefined ? item.dailyCapUsd / DAILY_CAP_SHARE : undefined;
}

/** Built-ins an `agent` step gets with no `toolFilter`; `bash` among them is
 *  a shell for whoever wrote the agent's input. */
function agentHasShell(cfg: Record<string, unknown> | undefined): boolean {
  const filter = cfg?.["toolFilter"];
  if (!Array.isArray(filter) || filter.length === 0) return true;
  return filter.some((b) => typeof b !== "string" || b.includes("{{") || b === "bash");
}

/** A workflow's closure with every step it walks. */
async function closureOf(flow: Flow, name: string, deps: Pick<RunnableDeps, "workspace" | "registry">): Promise<{ closure: FlowClosure; steps: Step[] }> {
  const registry = deps.registry();
  const steps: Step[] = [];
  const closure = await flowClosure(flow, deps.workspace, (s) => steps.push(s), { name, stepExists: (t) => t in registry });
  return { closure, steps };
}

/**
 * What a closure can do, as the store's chips say it (src/packages/detail.ts):
 * `spends` — an `agent`, `llm`, `image` or `acp/prompt` step; `acts` — a step that
 * declares `effect: "write"`; `code` — `exec`, a custom step (TypeScript in
 * this process), or an agent with `bash` (every built-in, when its
 * `toolFilter` names none). `agentTools` grants count, a glob over today's
 * registry; a grant or a subflow read only when the run starts may be
 * anything, so all three.
 */
export function closureCan(closure: FlowClosure, steps: readonly Step[], registry: StepRegistry, sources: Record<string, string>): PackageCan {
  const can: PackageCan = { spends: false, acts: false, code: false };
  const mark = (t: string) => {
    if (SPENDING_STEPS.has(t)) can.spends = true;
    if (t === "exec" || sources[t] === "custom") can.code = true;
    if (registry[t]?.effect === "write") can.acts = true;
  };
  for (const t of closure.types) mark(t);
  for (const g of closure.agentTools) {
    const t = baseType(g);
    if (!t.includes("*")) {
      mark(t);
      continue;
    }
    const re = globToRegExp(t);
    for (const k of Object.keys(registry)) if (re.test(k)) mark(k);
  }
  for (const s of steps) if (baseType(s.type) === "agent" && agentHasShell(s.config as Record<string, unknown> | undefined)) can.code = true;
  if (!closure.resolvable) can.spends = can.acts = can.code = true;
  return can;
}

/** What one item's closure can do, or null when it is not on this server. */
export async function runnableCan(item: Pick<PublicRunnable, "kind" | "name">, deps: Pick<RunnableDeps, "workspace" | "registry" | "stepSources">): Promise<PackageCan | null> {
  const registry = deps.registry();
  if (item.kind === "step") {
    const def = registry[item.name];
    if (!def) return null;
    return { spends: SPENDING_STEPS.has(item.name), acts: def.effect === "write", code: item.name === "exec" || deps.stepSources()[item.name] === "custom" };
  }
  let flow: Flow;
  try {
    flow = await deps.workspace.getWorkflow(item.name);
  } catch {
    return null;
  }
  const { closure, steps } = await closureOf(flow, item.name, deps);
  return closureCan(closure, steps, registry, deps.stepSources());
}

/**
 * Why a step may not be run by anyone, or undefined: not one that spends or
 * runs a shell (the app door's list, and every step that calls a model:
 * the workflow is the unit of spend), not one of the runner's containers,
 * not one that parks (`human`), not sealed (the meta surface, the graders), not one whose config names a
 * secret (the caller would pick which secret it reads), and on this server.
 * Asked at the save, and again at every call (src/public-tools.ts): the
 * registry changes after a save.
 */
export function stepRunnableProblem(type: string, registry: StepRegistry, patterns: readonly string[] = sealedStepPatterns()): string | undefined {
  const label = runnableLabel({ kind: "step", name: type });
  if (PAID_OR_SHELL.includes(type) || SPENDING_STEPS.has(type)) return `${label} spends or runs a shell — a stranger runs it inside a workflow, which is the unit of spend: make the workflow runnable`;
  if (CONTAINER_STEPS.has(type)) return `${label} runs other steps, which a stranger's config would choose — make a workflow that holds it runnable`;
  if (PARKING_STEPS.has(type)) return `${label} ${parksWhy}`;
  if (isSealedStep(type, registry, patterns)) return `${label} is sealed: the meta surface and the graders are never run from outside`;
  const def = registry[type];
  if (!def) return `no step "${type}" on this strut server`;
  const field = configSecretField(def);
  if (field) return `${label} takes a secret's name in its config (${field}): a stranger would choose which secret it reads — make a workflow that holds it runnable, with the name written in`;
  return undefined;
}

/**
 * Why `item` may not be saved as runnable, naming it, or undefined
 * (plans/paid-runs.md §2, "Checked at the save"). The record's shape is
 * `runnableShapeProblem`'s; this asks the server:
 * - it exists and is not sealed, and a workflow's closure reaches nothing
 *   sealed (a grader, the meta surface);
 * - a step is not one that spends or runs a shell (the app door's list:
 *   the workflow is the unit of spend), nor one of the runner's containers;
 * - neither a step nor a workflow's closure parks (`human`): a public run
 *   cannot wait, so every run would fail `park_refused:`;
 * - a workflow declares `input:` (a stranger's payload is checked against
 *   it, and a form is drawn from it);
 * - a markup has a per-run cap, and a priced item a wallet;
 * - a workflow that spends has someone to pay for it — its owner, or the
 *   host's public principal — and, free, a daily cap.
 */
export async function runnableProblem(item: PublicRunnable, deps: RunnableDeps): Promise<string | undefined> {
  const label = runnableLabel(item);
  const registry = deps.registry();
  const patterns = deps.sealedPatterns ?? sealedStepPatterns();
  const price = priceOf(item);
  const priceProblem = (): string | undefined => {
    if (price.markup > 0 && item.capUsd === undefined) return `${label}: a markup needs a per-run cap (capUsd) — a run sets aside base + markup × the cap before it starts`;
    if (!isFree(price) && !deps.wallet()) return `${label} is priced, and this server has no wallet to be paid into — set one under Earnings, or make it free`;
    return undefined;
  };

  if (item.kind === "step") return stepRunnableProblem(item.name, registry, patterns) ?? priceProblem();

  let flow: Flow;
  try {
    flow = await deps.workspace.getWorkflow(item.name);
  } catch {
    return `no workflow "${item.name}" on this strut server`;
  }
  if (flow.sealed) return `${label} is sealed: a grading harness is never run from outside`;
  const { closure, steps } = await closureOf(flow, item.name, deps);
  const reached = sealedInClosure(closure, registry, patterns);
  if (reached) return `${label} reaches the sealed ${reached}`;
  const parks = [...closure.types].find((t) => PARKING_STEPS.has(t));
  if (parks) return `${label} reaches step "${parks}", which ${parksWhy}`;
  if (flow.inputBlock == null) return `${label} declares no input: block — a stranger's payload is checked against it, and the Run form is drawn from it`;
  const priced = priceProblem();
  if (priced) return priced;
  if (closureCan(closure, steps, registry, deps.stepSources()).spends) {
    const meta = await deps.workspace.getWorkflowMetadata(item.name);
    if (!meta?.owner && !deps.principal) {
      return `${label} spends (a model call) and has no owner to pay for a stranger's run — claim it with the owner chip, or have the host name one principal for public runs`;
    }
    if (isFree(price) && item.dailyCapUsd === undefined) return `${label} is free and spends: set a daily cap (dailyCapUsd), the most its owner carries in a day`;
  }
  return undefined;
}

/** Every problem in a record's `runnable` list, in its order. */
export async function runnableProblems(surface: Pick<PublicSurface, "runnable">, deps: RunnableDeps): Promise<string[]> {
  const out: string[] = [];
  for (const item of surface.runnable) {
    const p = await runnableProblem(item, deps);
    if (p) out.push(p);
  }
  return out;
}

// ── What its runs here cost ──────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** `recentCosts` reads at most this many summaries, the newest. */
export const RECENT_COSTS_MAX_RUNS = 200;

/** What an item's runs on this server cost over a window, in dollars, read
 *  from run summaries (`RunSummary.totals`) — never the ledger, which holds
 *  public runs only. `runs` counts every run in the window; `measured` the
 *  finished ones read (the newest `RECENT_COSTS_MAX_RUNS`), which `average`
 *  and `highest` are over. */
export interface RecentCosts {
  days: number;
  runs: number;
  measured: number;
  average: number;
  highest: number;
}

/**
 * `key` is the run store's: a workflow's name, or `step:<type>` — a step's
 * KEPT runs (`run_step` with claims or `keep`, an app's writes). A step
 * called inside a workflow is counted in that workflow's runs, not here.
 * Run ids are the epoch ms they started at.
 */
export async function recentCosts(
  store: Pick<RunStore, "listRuns" | "getRunSummary">,
  key: string,
  o: { now?: number; days?: number; limit?: number } = {},
): Promise<RecentCosts> {
  const days = o.days ?? RECENT_DAYS;
  const since = (o.now ?? Date.now()) - days * DAY_MS;
  const ids = (await store.listRuns(key)).filter((id) => parseInt(id, 10) >= since);
  let measured = 0;
  let total = 0;
  let highest = 0;
  for (const id of ids.slice(0, o.limit ?? RECENT_COSTS_MAX_RUNS)) {
    const s = await store.getRunSummary(key, id).catch(() => null);
    if (!s) continue;
    const cost = s.totals?.cost ?? 0;
    measured += 1;
    total += cost;
    if (cost > highest) highest = cost;
  }
  return { days, runs: ids.length, measured, average: measured ? total / measured : 0, highest };
}

// ── GET /public ──────────────────────────────────────────────────────────

/** One runnable item as anyone reads it (decision 25): what it costs to
 *  start, what recent runs were charged, and what to send. */
export interface ListedRunnable {
  kind: PublicRunnable["kind"];
  name: string;
  description?: string;
  /** Dollars per run or call. */
  base: number;
  /** Times what the run cost. */
  markup: number;
  /** The most one run may spend, in dollars; null when the item sets none. */
  capUsd: number | null;
  /** The credit a run needs to start, in dollars: base + markup × capUsd. */
  reserve: number;
  results: "output" | "run";
  /** A workflow's `input:` block; a step's input JSON Schema. */
  input: unknown;
  /** The ledger's last `RECENT_DAYS` days for the item: runs, and the
   *  average charge in dollars. */
  recent: { days: number; runs: number; average: number };
}

/** `GET /public`'s `runnable`: every item still on this server and not
 *  sealed, in the record's order. Its definition is never shown here
 *  (decision 11). The ledger is opened only when there is an item. */
export async function listRunnable(
  surface: Pick<PublicSurface, "runnable">,
  deps: Pick<RunnableDeps, "workspace" | "registry" | "sealedPatterns"> & {
    workflowDescription: (name: string) => Promise<string | undefined>;
    ledger: () => Promise<LedgerStore>;
  },
): Promise<ListedRunnable[]> {
  if (!surface.runnable.length) return [];
  const registry = deps.registry();
  const patterns = deps.sealedPatterns ?? sealedStepPatterns();
  const ledger = await deps.ledger();
  const out: ListedRunnable[] = [];
  for (const item of surface.runnable) {
    let description: string | undefined;
    let input: unknown;
    if (item.kind === "workflow") {
      const flow = await deps.workspace.getWorkflow(item.name).catch(() => null);
      if (!flow || flow.sealed) continue;
      description = await deps.workflowDescription(item.name);
      input = flow.inputBlock ?? null;
    } else {
      const def = registry[item.name];
      if (!def || isSealedStep(item.name, registry, patterns)) continue;
      description = def.description;
      input = stepSchemas(def).input;
    }
    const recent = await ledger.recent(runnableSubject(item));
    out.push({
      kind: item.kind,
      name: item.name,
      ...(description ? { description } : {}),
      base: item.base ?? 0,
      markup: item.markup ?? 0,
      capUsd: item.capUsd ?? null,
      reserve: microsToUsd(runnableReserve(item)),
      results: item.results ?? "output",
      input,
      recent: { days: recent.days, runs: recent.runs, average: microsToUsd(recent.average) },
    });
  }
  return out;
}
