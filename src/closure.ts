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
 * A grant read from params alone (`agentTools: "{{ params.tools }}"`, or
 * `params.a || params.b`) is read off every params object the flow may run
 * under — its own defaults, and what a `subflow` step hands a child — since
 * a launch may only narrow it (`grantWidenedBy`). Any other templated grant
 * (`"{{ input.tools }}"`), a `subflow` whose `workflow` (or `version`) is a
 * template, or a child that does not resolve makes the closure
 * UNRESOLVABLE: what was collected is then a lower bound, and each consumer
 * takes its own conservative reading. A reached child that declares
 * `sealed: true` is marked, so `src/sealed.ts` can refuse a flow that
 * subflows a grading harness.
 */
import type { Flow, Step, StepRegistry } from "./core.js";
import { hasTemplates } from "./expr.js";
import { baseType } from "./step-ref.js";
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
  /** Step types named anywhere in the closure (built-in and custom alike),
   *  pins stripped: `clip/shout@v1` reaches `clip/shout`. */
  types: Set<string>;
  /** `agentTools` entries granted anywhere in the closure, verbatim. */
  agentTools: Set<string>;
  /** Child workflows reached through `subflow`, in discovery order; `sealed`
   *  when the child's YAML says so (`src/sealed.ts`). */
  workflows: Array<{ workflow: string; version?: string; sealed?: true }>;
  /** False = a lower bound (see module doc). */
  resolvable: boolean;
  /** Templated grants the closure could not read (`"{{ input.tools }}"`):
   *  what they hand an agent is known only once the run starts. */
  unreadGrants: string[];
  /** Some grant was read off params, which a person's own launch may widen. */
  paramGrants: boolean;
}

/** `onStep` sees every step the closure walks, the children's included —
 *  for a reader that needs more than the types (src/reach.ts: the secret
 *  names in a step's config). */
export async function flowClosure(
  flow: Pick<Flow, "steps"> & { params?: Flow["params"] },
  workspace?: SubflowResolver,
  onStep?: (step: Step) => void,
): Promise<FlowClosure> {
  const out: FlowClosure = { types: new Set(), agentTools: new Set(), workflows: [], resolvable: true, unreadGrants: [], paramGrants: false };
  const seen = new Set<string>();
  const unread = (t: string) => {
    out.resolvable = false;
    out.unreadGrants.push(t);
  };
  // A grant from params: the strings every key it reads holds, in every
  // params object the frame may run under. `null` = a subflow handed params
  // the closure cannot read.
  const grant = (t: string, params: Array<Record<string, unknown> | null>) => {
    const keys = paramsGrantKeys(t);
    if (!keys || params.includes(null)) return unread(t);
    out.paramGrants = true;
    for (const p of params) {
      for (const k of keys) {
        for (const g of stringsIn(p?.[k])) {
          if (hasTemplates(g)) unread(g);
          else out.agentTools.add(g);
        }
      }
    }
  };

  const visitFlow = async (steps: readonly Step[], params: Array<Record<string, unknown> | null>): Promise<void> => {
    const children: Array<{ workflow: string; version?: string; params?: unknown }> = [];
    walkSteps(steps, (s) => {
      onStep?.(s);
      out.types.add(baseType(s.type));
      const cfg = (s.config ?? {}) as Record<string, unknown>;
      const tools = cfg["agentTools"];
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (typeof t === "string" && !hasTemplates(t)) out.agentTools.add(t);
          else if (typeof t === "string") grant(t, params);
          else out.resolvable = false;
        }
      } else if (typeof tools === "string") grant(tools, params);
      else if (tools !== undefined && tools !== null) out.resolvable = false;
      if (s.type !== "subflow") return;
      const wf = cfg["workflow"];
      const version = cfg["version"];
      const literal = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !hasTemplates(v);
      if (!literal(wf) || (version !== undefined && version !== null && !literal(version))) out.resolvable = false;
      else children.push({ workflow: wf, ...(literal(version) ? { version } : {}), params: cfg["params"] });
    });
    for (const c of children) {
      // The same child under other params is another reading of its grants.
      const key = `${c.workflow}@${c.version ?? ""}${c.params === undefined ? "" : JSON.stringify(c.params)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let entry = out.workflows.find((w) => w.workflow === c.workflow && w.version === c.version);
      if (!entry) out.workflows.push((entry = { workflow: c.workflow, ...(c.version ? { version: c.version } : {}) }));
      try {
        if (!workspace) throw new Error("no workspace");
        const child = c.version ? await workspace.getWorkflowVersion(c.workflow, c.version) : await workspace.getWorkflow(c.workflow);
        if (child.sealed) entry.sealed = true;
        // A subflow step's own `params` override the child's for that call
        // (a templated value in a key a grant reads is caught in `grant`).
        const handed = c.params === undefined ? [] : isPlainObject(c.params) ? [c.params] : [null];
        await visitFlow(child.steps, [child.params ?? {}, ...handed]);
      } catch {
        out.resolvable = false;
      }
    }
  };

  await visitFlow(flow.steps, [flow.params ?? {}]);
  return out;
}

/** The params keys a grant template reads when it reads nothing else: one
 *  `{{ }}` that is a chain of `params.<key>` joined by `||` or `??`. Null for
 *  anything else — `"{{ input.tools }}"`, `"{{ params.ns }}/*"`, a `map` — whose
 *  grants cannot be read before the run. */
function paramsGrantKeys(t: string): string[] | null {
  const m = /^\{\{\s*(params\.[A-Za-z_$][\w$]*(?:\s*(?:\|\||\?\?)\s*params\.[A-Za-z_$][\w$]*)*)\s*\}\}$/.exec(t);
  return m ? [...m[1]!.matchAll(/params\.([A-Za-z_$][\w$]*)/g)].map((k) => k[1]!) : null;
}

/** Every string in a value, however it is shaped. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The params keys a flow's own `agentTools` read (`agentTools: "{{ params.tools }}"`,
 *  or an entry like `"{{ params.ns }}/*"`): the knobs that are GRANTS. Its own
 *  steps only — a subflow's params are the child's. */
export function grantParams(flow: Pick<Flow, "steps">): Set<string> {
  return paramsReadBy(flow, "agentTools");
}

/** The params keys a flow's own `approve` lists read (`approve: "{{ params.approve }}"`):
 *  the knobs that GATE — what an agent may only do once a person says yes. */
export function approveParams(flow: Pick<Flow, "steps">): Set<string> {
  return paramsReadBy(flow, "approve");
}

function paramsReadBy(flow: Pick<Flow, "steps">, field: "agentTools" | "approve"): Set<string> {
  const keys = new Set<string>();
  walkSteps(flow.steps, (s) => {
    const tools = (s.config as Record<string, unknown> | undefined)?.[field];
    for (const t of Array.isArray(tools) ? tools : [tools]) {
      if (typeof t !== "string") continue;
      for (const m of t.matchAll(/params\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]!);
    }
  });
  return keys;
}

/** The registry step types a grant value reaches: each string (a type, a
 *  pinned ref, a glob) in it, however it is shaped; a word that names no
 *  step reaches nothing. */
function grantedTypes(value: unknown, registry: StepRegistry): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const base = baseType(v);
      if (registry[base]) out.add(base);
      else if (v.includes("*")) for (const t of Object.keys(registry)) if (globToRegExp(v).test(t)) out.add(t);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return out;
}

/**
 * The first step a run's `params` override would grant that the flow's own
 * params do not, as a phrase for an error, or null. Only the keys the flow's
 * `agentTools` read are grants (`grantParams`); every other key is a knob
 * (a prompt, a threshold) and may say anything. Both sides are expanded
 * through the registry, so `browser/*` narrowed to `browser/screenshot` is
 * fine and `gaia/*` over nothing is not. A launcher may narrow what a
 * flow's agents hold, never widen it — or a child of a job would hold
 * tools its parent was never given, sealed or not. Nor may it take a step
 * out of what the flow's agents must ask before running (`approve`).
 */
export function grantWidenedBy(flow: Pick<Flow, "steps" | "params">, override: Record<string, unknown>, registry: StepRegistry): string | null {
  for (const key of grantParams(flow)) {
    if (!(key in override)) continue;
    const own = grantedTypes(flow.params?.[key], registry);
    for (const type of grantedTypes(override[key], registry)) {
      if (!own.has(type)) return `"${type}" (params.${key})`;
    }
  }
  // And the gate only grows: an override of a key an `approve` list reads
  // keeps every step the flow's own approve keys gate (all of them, so
  // `"{{ params.gates || params.approve }}"` cannot be emptied through
  // `gates`). Else a launcher — a builder through meta/run-workflow — runs
  // the seeded builder with `approve: []` and publishes with no proposal.
  const approveKeys = [...approveParams(flow)];
  const gated = new Set(approveKeys.flatMap((k) => [...grantedTypes(flow.params?.[k], registry)]));
  for (const key of approveKeys) {
    if (!(key in override)) continue;
    const kept = grantedTypes(override[key], registry);
    for (const type of gated) {
      if (!kept.has(type)) return `"${type}" taken out of approval (params.${key}: approve may only grow)`;
    }
  }
  return null;
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
      if (!closure.resolvable || closure.paramGrants || closureIncludes(closure, type)) out[type] = hash;
    }
    return Object.keys(out).length ? out : undefined;
  } catch (err) {
    console.error(`[closure] could not read step hashes — the run will carry none:`, err);
    return undefined;
  }
}
