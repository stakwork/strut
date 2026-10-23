/**
 * An app's LOCK (plans/app-releases.md §2): the versions a release runs —
 * every workflow its page version grants, every subflow they reach and every
 * custom step type the closure reaches, as they are at the moment a person
 * makes the version live — and what the closure could not see. Read off the
 * workspace with `flowClosure` (src/closure.ts), the same walk the sealed
 * check and `run.start.stepHashes` use. Pure over the store: nothing here
 * writes.
 */
import { closureIncludes, flowClosure, type FlowClosure } from "../closure.js";
import type { Step } from "../core.js";
import { hasTemplates } from "../expr.js";
import type { AppLock, WorkspaceStore } from "../workspace.js";
import type { AppManifest } from "./manifest.js";

/** Steps that start other runs: those run whatever is current
 *  (plans/app-releases.md, ruled question 3), so a lock that reaches one
 *  says so. */
export const LAUNCHING_STEPS: readonly string[] = ["meta/run-workflow", "run/launch", "job/start", "job/continue", "strut/run-workflow"];

/** A locked version that has moved on since (`behind`), or is gone (`current: null`). */
export interface LockDrift {
  kind: "workflow" | "step";
  name: string;
  locked: string;
  current: string | null;
}

type LockStore = Pick<WorkspaceStore, "getWorkflow" | "getWorkflowVersion" | "getWorkflowMetadata" | "getActiveStepHashes" | "listStepVersions">;

/** The lock for a page version's manifest, taken now. */
export async function takeLock(manifest: AppManifest, workspace: LockStore): Promise<AppLock> {
  const workflows: AppLock["workflows"] = {};
  const floating = new Set<string>();
  const merged: FlowClosure = { types: new Set(), agentTools: new Set(), workflows: [], resolvable: true, unreadGrants: [], paramGrants: false };

  const lockWorkflow = async (name: string): Promise<boolean> => {
    if (workflows[name]) return true;
    const meta = await workspace.getWorkflowMetadata(name).catch(() => null);
    if (!meta?.versions[meta.active]) {
      floating.add(`workflow "${name}" does not exist`);
      return false;
    }
    const hash = meta.versions[meta.active]!.hash;
    workflows[name] = { version: meta.active, ...(hash ? { hash } : {}) };
    return true;
  };

  // A subflow whose name or version is a template is chosen at run time.
  const onStep = (s: Step) => {
    if (s.type !== "subflow") return;
    const cfg = (s.config ?? {}) as Record<string, unknown>;
    const templated = (v: unknown) => typeof v === "string" && hasTemplates(v);
    if (templated(cfg["workflow"]) || templated(cfg["version"])) floating.add(`subflow step "${s.id}" chooses its workflow at run time`);
  };

  for (const name of [...new Set(manifest.grants.workflows)].sort()) {
    if (!(await lockWorkflow(name))) continue;
    const flow = await workspace.getWorkflow(name);
    const closure = await flowClosure(flow, workspace, onStep);
    for (const t of closure.types) merged.types.add(t);
    for (const g of closure.agentTools) merged.agentTools.add(g);
    for (const g of closure.unreadGrants) floating.add(`agent grant "${g}" is read at run time`);
    if (!closure.resolvable) merged.resolvable = false;
    // A subflow the YAML pins (`version:`) runs that version already.
    for (const child of closure.workflows) if (!child.version) await lockWorkflow(child.workflow);
  }

  // Custom steps: every one the closure reaches — all of them when the
  // closure could not be read, the rule `run.start.stepHashes` follows.
  const steps: AppLock["steps"] = {};
  for (const [type, hash] of Object.entries(await workspace.getActiveStepHashes())) {
    if (merged.resolvable && !closureIncludes(merged, type)) continue;
    const { active } = await workspace.listStepVersions(type);
    steps[type] = { version: active, hash };
  }
  if (!merged.resolvable) floating.add("part of the closure could not be read, so every custom step is locked and some workflows may not be");
  for (const t of LAUNCHING_STEPS) if (closureIncludes(merged, t)) floating.add(`"${t}" starts other runs, which run current versions`);

  return { workflows, steps, ...(floating.size ? { floating: [...floating].sort() } : {}) };
}

/** What a lock names that has moved on since, or is gone. */
export async function lockDrift(lock: AppLock, workspace: LockStore): Promise<LockDrift[]> {
  const out: LockDrift[] = [];
  for (const [name, at] of Object.entries(lock.workflows)) {
    const meta = await workspace.getWorkflowMetadata(name).catch(() => null);
    const current = meta?.active ?? null;
    if (current !== at.version) out.push({ kind: "workflow", name, locked: at.version, current });
  }
  for (const [name, at] of Object.entries(lock.steps)) {
    const current = (await workspace.listStepVersions(name).catch(() => null))?.active ?? null;
    if (current !== at.version) out.push({ kind: "step", name, locked: at.version, current });
  }
  return out;
}

/** The locked versions that no longer exist — a release that names one
 *  cannot be made live again (plans/app-releases.md §3.4). */
export async function lockProblems(lock: AppLock, workspace: LockStore): Promise<string[]> {
  const out: string[] = [];
  for (const [name, at] of Object.entries(lock.workflows)) {
    const meta = await workspace.getWorkflowMetadata(name).catch(() => null);
    if (!meta?.versions[at.version]) out.push(`workflow ${name}@${at.version} no longer exists`);
  }
  for (const [name, at] of Object.entries(lock.steps)) {
    const v = await workspace.listStepVersions(name).catch(() => null);
    if (!v?.versions.includes(at.version)) out.push(`step ${name}@${at.version} no longer exists`);
  }
  return out;
}
