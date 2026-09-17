/**
 * What a flow can EXECUTE, decided from its definition rather than its top
 * level: the step types it names through `loop` / `foreach` bodies and
 * `onError` handlers, the workflows its `subflow` steps reach (resolved
 * through the workspace, transitively), and the step types it grants to
 * agents as tools (`agentTools`, globs unexpanded).
 *
 * Two consumers (plans/claims.md): a launch records the content hash of
 * every workspace step in the closure on `run.start.stepHashes` (§3), and a
 * `subflow` check is opaque by type, so whether it is paid, `observed`, or
 * reaches a grader is read off its closure (§4).
 *
 * A `subflow` whose `workflow` (or `version`) is a template, a child that
 * does not resolve, or a templated `agentTools` makes the closure
 * UNRESOLVABLE: what was collected is then a lower bound, and each consumer
 * takes its own conservative reading.
 */
import type { Flow, Step } from "./core.js";
import { hasTemplates } from "./expr.js";
import type { SubflowResolver } from "./runner.js";

const BODY_STEPS = new Set(["loop", "foreach"]);

/** Every step in a list, descending `loop` / `foreach` bodies and `onError`
 *  handlers — the order `validate.ts` reports types in. */
export function walkSteps(steps: readonly Step[], fn: (step: Step) => void): void {
  const visit = (s: Step | undefined) => {
    if (!s || typeof s !== "object" || typeof s.type !== "string") return;
    fn(s);
    const body = (s.config as Record<string, unknown> | undefined)?.["body"] as Step | undefined;
    if (BODY_STEPS.has(s.type)) visit(body);
    visit(s.options?.onError);
  };
  steps.forEach(visit);
}

/** Compile a glob pattern (`*` = any run of characters) to an anchored
 *  RegExp — the `agentTools` grammar (`"jarvis/*"`). */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
  return new RegExp(`^${escaped}$`);
}

export interface FlowClosure {
  /** Step types named anywhere in the closure (built-in and custom alike). */
  types: Set<string>;
  /** `agentTools` entries granted anywhere in the closure, verbatim. */
  agentTools: Set<string>;
  /** Child workflows reached through `subflow`, in discovery order. */
  workflows: Array<{ workflow: string; version?: string }>;
  /** False = a lower bound (see module doc). */
  resolvable: boolean;
}

export async function flowClosure(flow: Pick<Flow, "steps">, workspace?: SubflowResolver): Promise<FlowClosure> {
  const out: FlowClosure = { types: new Set(), agentTools: new Set(), workflows: [], resolvable: true };
  const seen = new Set<string>();

  const visitFlow = async (steps: readonly Step[]): Promise<void> => {
    const children: Array<{ workflow: string; version?: string }> = [];
    walkSteps(steps, (s) => {
      out.types.add(s.type);
      const cfg = (s.config ?? {}) as Record<string, unknown>;
      const tools = cfg["agentTools"];
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (typeof t === "string" && !hasTemplates(t)) out.agentTools.add(t);
          else out.resolvable = false;
        }
      } else if (tools !== undefined && tools !== null) out.resolvable = false;
      if (s.type !== "subflow") return;
      const wf = cfg["workflow"];
      const version = cfg["version"];
      const literal = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !hasTemplates(v);
      if (!literal(wf) || (version !== undefined && version !== null && !literal(version))) out.resolvable = false;
      else children.push({ workflow: wf, ...(literal(version) ? { version } : {}) });
    });
    for (const c of children) {
      const key = `${c.workflow}@${c.version ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.workflows.push(c);
      try {
        if (!workspace) throw new Error("no workspace");
        const child = c.version ? await workspace.getWorkflowVersion(c.workflow, c.version) : await workspace.getWorkflow(c.workflow);
        await visitFlow(child.steps);
      } catch {
        out.resolvable = false;
      }
    }
  };

  await visitFlow(flow.steps);
  return out;
}

/** Does the closure reach `type` — by name, or through an `agentTools` grant? */
export function closureIncludes(closure: FlowClosure, type: string): boolean {
  if (closure.types.has(type)) return true;
  for (const grant of closure.agentTools) {
    if (grant === type || (grant.includes("*") && globToRegExp(grant).test(type))) return true;
  }
  return false;
}

/**
 * `run.start.stepHashes` for a launch: the active content hash of every
 * workspace (custom) step the flow can execute. An unresolvable closure
 * records EVERY active hash — a superset is still a true record of what
 * was active at launch, a subset would lose the version of a step that ran.
 * Undefined when the workspace has no custom steps in reach (built-in steps
 * have no versions), or when it cannot be read — a run must still launch.
 */
export async function stepHashesFor(
  workspace: (SubflowResolver & { getActiveStepHashes(): Promise<Record<string, string>> }) | undefined,
  flow: Pick<Flow, "steps">,
): Promise<Record<string, string> | undefined> {
  if (!workspace) return undefined;
  try {
    const active = await workspace.getActiveStepHashes();
    if (Object.keys(active).length === 0) return undefined;
    const closure = await flowClosure(flow, workspace);
    const out: Record<string, string> = {};
    for (const [type, hash] of Object.entries(active)) {
      if (!closure.resolvable || closureIncludes(closure, type)) out[type] = hash;
    }
    return Object.keys(out).length ? out : undefined;
  } catch (err) {
    console.error(`[closure] could not read step hashes — the run will carry none:`, err);
    return undefined;
  }
}
