/**
 * Reach — what the AI may publish (stakwork/peel
 * docs/connectors-and-authoring.md §6). Opt-in: a host that sets
 * `builder.reach` (createStrut, or STRUT_HOST_CONFIG) gets it; without one
 * nothing here runs and every workflow and step behaves as before.
 *
 * Any strut code can read any secret by name: a step's `secrets.get`, an
 * `agent` / `exec` step's `secretsEnv`, a `git/*` step's `tokenSecret`. That
 * is fine for code a person wrote. For what the meta surface publishes
 * (stamped `publisher: ai`) the host names an ALLOW list instead:
 *
 *   - `tools`: step types (globs, as `agentTools` takes them) a workflow the
 *     AI publishes may run or grant to its agents. Control flow and the model
 *     steps (`ALWAYS_IN_REACH`) are always in reach.
 *   - `builtins`: the agent built-ins its agents may hold (`toolFilter`
 *     entries: `web_search`, `web_fetch`, `bash`, …) and `exec`, the step
 *     that runs a process.
 *   - `secrets`: the only secret names its steps' configs may name.
 *
 * Under a reach the AI publishes no step CODE (authoring.ts refuses it): a
 * step is TypeScript in this process, and reaches every door on the bag and
 * every secret whatever a scope says (AGENTS.md "Secrets"). What it may
 * author is a workflow, and what a workflow can say is all this checks:
 * which steps run, with which built-ins, naming which secrets.
 *
 * One rule (`stepProblems`), checked twice. At PUBLISH (`reachRefusal`):
 * every step the closure walks and every grant, and a closure that cannot be
 * read in full (a templated grant or subflow) is refused. At RUN
 * (`withinReach`, from the runner, an agent's tool call and a proposal's
 * apply), inside a workflow the AI published (`ctx.aiAuthored`): each step
 * as resolved — which covers what a model passes a granted tool, a workflow
 * stamped `ai` before its host set a reach, and a person's subflow that
 * changed after the AI published over it.
 *
 * strut's own reads are untouched: the `agent` and `llm` steps still read
 * the model key through the run's secrets.
 */
import { z } from "zod";
import type { AnyStepDef, Flow, Step, StepContext, StepRegistry } from "./core.js";
import { flowClosure, globToRegExp } from "./closure.js";
import { hasTemplates } from "./expr.js";
import { baseType } from "./step-ref.js";
import type { SubflowResolver } from "./runner.js";

/** The host's allow list for what the AI publishes (`builder.reach`). */
export interface BuilderReach {
  tools?: string[];
  builtins?: string[];
  secrets?: string[];
}

/** Steps every workflow may use whatever its reach: control flow, and the
 *  steps that reach nothing but the model. */
export const ALWAYS_IN_REACH: ReadonlySet<string> = new Set(["loop", "foreach", "if", "subflow", "log", "pack", "wait", "llm", "agent"]);

/** What the runner needs at run time, on the services bag as `reach`
 *  (createStrut puts it there when the host set `builder.reach`). */
export interface ReachPolicy {
  reach: Readonly<BuilderReach>;
  /** Was this workflow published by the meta surface (`publisher: ai`)? */
  aiWorkflow(name: string): Promise<boolean>;
}

export function reachPolicyOf(services: unknown): ReachPolicy | undefined {
  return (services as { reach?: ReachPolicy } | null | undefined)?.reach;
}

/** The secret NAMES a step's config hands it: `secretsEnv` entries and a
 *  `tokenSecret`. With `def`, a `tokenSecret` the config leaves out is
 *  the schema's default (`git/*`: GITHUB_TOKEN); a parsed config has it already. */
export function secretNamesIn(cfg: unknown, def?: AnyStepDef): unknown[] {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const out: unknown[] = [];
  const env = c["secretsEnv"];
  if (Array.isArray(env)) out.push(...env);
  else if (env !== undefined) out.push(env);
  for (const field of SECRET_NAME_FIELDS) {
    let name = c[field];
    if (name === undefined && def?.input instanceof z.ZodObject) {
      const schema = (def.input.shape as Record<string, z.ZodTypeAny>)[field];
      if (schema) name = schema.safeParse(undefined).data;
    }
    if (name !== undefined) out.push(name);
  }
  // `http/verify`'s `secrets`: header → a template whose {NAME}s are secrets.
  const headers = c["secrets"];
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) out.push(headers);
    else {
      for (const t of Object.values(headers)) {
        if (typeof t !== "string") out.push(t);
        else for (const m of t.matchAll(/\{([^{}]*)\}/g)) out.push(m[1]);
      }
    }
  }
  return out;
}

/** Config fields that hold ONE secret's name (`git/*`, `browser/open`). With
 *  `secretsEnv` and `http/verify`'s `secrets`, every way a step's config
 *  names a secret today; a new one is added here. */
const SECRET_NAME_FIELDS = ["tokenSecret", "storageStateSecret"] as const;

/** May a workflow the AI published run `type` (bare)? `exec` is a built-in;
 *  control flow and the model steps are always in. */
export function stepInReach(type: string, reach: BuilderReach): boolean {
  if (type === "exec") return (reach.builtins ?? []).includes("exec");
  return ALWAYS_IN_REACH.has(type) || (reach.tools ?? []).some((p) => globToRegExp(p).test(type));
}

/**
 * What one step (bare type + config) reaches outside reach, as phrases for
 * an error — empty when nothing. The rule publish and run share. `def`
 * supplies the defaults a config leaves out (a parsed config has them);
 * `id` names the step in the phrases.
 */
export function stepProblems(type: string, cfg: unknown, reach: BuilderReach, def?: AnyStepDef, id?: string): string[] {
  const at = id ? ` (step "${id}")` : "";
  const builtins = reach.builtins ?? [];
  const c = (cfg ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!stepInReach(type, reach)) problems.push(type === "exec" ? `the built-in "exec"` : `the step "${type}"`);
  if (type === "agent" && !builtins.includes("*")) {
    const filter = c["toolFilter"];
    if (!Array.isArray(filter) || filter.length === 0) {
      problems.push(`an agent with every built-in${at}: list the ones it needs in toolFilter`);
    } else {
      for (const b of filter) {
        if (typeof b !== "string" || hasTemplates(b)) problems.push(`a templated toolFilter${at}`);
        else if (b !== "none" && !builtins.includes(b)) problems.push(`the built-in "${b}"`);
      }
    }
  }
  for (const name of secretNamesIn(c, def)) {
    if (typeof name !== "string" || hasTemplates(name)) problems.push(`a secret named by a template${at}`);
    else if (!(reach.secrets ?? []).includes(name)) problems.push(`the secret "${name}"`);
  }
  return problems;
}

/**
 * The step's context, held to reach when it runs inside a workflow the AI
 * published (`ctx.aiAuthored`): throws when the step, as resolved, reaches
 * outside it, and drops the launcher's MCP servers. Any other step's
 * context comes back as it was.
 */
export function withinReach<T extends StepContext<unknown>>(type: string, cfg: unknown, ctx: T): T {
  const policy = ctx.aiAuthored ? reachPolicyOf(ctx.services) : undefined;
  if (!policy) return ctx;
  const problems = stepProblems(baseType(type), cfg, policy.reach);
  if (problems.length) {
    throw new Error(`"${type}" runs inside a workflow the AI published and reaches ${[...new Set(problems)].join(", ")}, outside what this strut lets the AI run (builder.reach)`);
  }
  // The launcher's MCP servers are not in reach: an AI frame never holds them.
  return ctx.mcp ? { ...ctx, mcp: undefined } : ctx;
}

/**
 * Why a workflow the AI wants to publish is outside reach, as a sentence
 * for the error, or null when it is inside.
 */
export async function reachRefusal(
  flow: Pick<Flow, "steps">,
  reach: BuilderReach,
  registry: StepRegistry,
  workspace?: SubflowResolver,
): Promise<string | null> {
  const inTools = (type: string) => (reach.tools ?? []).some((p) => globToRegExp(p).test(type));

  const problems: string[] = [];
  const steps: Step[] = [];
  const closure = await flowClosure(flow, workspace, (s) => steps.push(s));
  if (!closure.resolvable) {
    problems.push("its closure cannot be read in full (a templated subflow or agentTools, or a subflow that does not resolve)");
  }
  for (const s of steps) {
    const type = baseType(s.type);
    problems.push(...stepProblems(type, s.config, reach, registry[type], s.id));
  }
  for (const grant of closure.agentTools) {
    const base = baseType(grant);
    if (!grant.includes("*")) {
      if (!stepInReach(base, reach)) problems.push(base === "exec" ? `the built-in "exec" (agentTools)` : `the grant "${grant}"`);
      continue;
    }
    // A glob is in reach when a reach pattern covers it as written, or when
    // everything it reaches today is.
    if (inTools(grant)) continue;
    const re = globToRegExp(grant);
    const reached = Object.keys(registry).filter((t) => re.test(t));
    const outside = reached.find((t) => !stepInReach(t, reach));
    if (!reached.length || outside) problems.push(`the grant "${grant}"${outside ? ` (reaches "${outside}")` : ""}`);
  }
  if (!problems.length) return null;
  return `it reaches ${[...new Set(problems)].join(", ")}, outside what this strut lets the AI publish (builder.reach)`;
}
