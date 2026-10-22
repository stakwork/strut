/**
 * Reach — what code the AI published may touch (stakwork/peel
 * docs/connectors-and-authoring.md §6). Opt-in: a host that sets
 * `builder.reach` (createStrut, or STRUT_HOST_CONFIG) gets it; without one
 * nothing here runs and every workflow and step behaves as before.
 *
 * Any strut code can read any secret by name: a step's `secrets.get`, an
 * `agent` / `exec` step's `secretsEnv`, a `git/*` step's `tokenSecret`. That
 * is fine for code a person wrote. For code the meta surface published
 * (stamped `publisher: ai`) the host names an ALLOW list instead:
 *
 *   - `tools`: step types (globs, as `agentTools` takes them) a workflow the
 *     AI publishes may run or grant to its agents. Control flow and the model
 *     steps (`ALWAYS_IN_REACH`) and steps the AI itself published are always
 *     in reach: the latter run under the secret scope below.
 *   - `builtins`: the agent built-ins its agents may hold (`toolFilter`
 *     entries: `web_search`, `web_fetch`, `bash`, …) and `exec`, the step
 *     that runs a process.
 *   - `secrets`: the only secret names its code may read.
 *
 * Checked twice. At PUBLISH (`reachRefusal`, from the meta surface's
 * publish): a workflow whose closure names a step, a built-in or a secret
 * outside reach is refused, and so is one whose reach cannot be read off
 * its definition (a templated grant, subflow or secret name). At RUN
 * (`withinReach`, from the runner, an agent's tool call and a proposal's
 * apply): a step the AI published sees a `secrets` capability that answers
 * only reach's names, and a step running inside a workflow the AI published
 * (`ctx.aiAuthored`) may not name a secret outside reach in its config —
 * which also covers what a model passes a granted tool.
 *
 * strut's own reads are untouched: the `agent` and `llm` steps still read
 * the model key through the run's secrets. Not isolation: a step is code in
 * this process (AGENTS.md "Secrets").
 */
import { z } from "zod";
import type { AnyStepDef, Flow, Step, StepContext, StepRegistry } from "./core.js";
import type { SecretsCapability } from "./capabilities.js";
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
  secrets: readonly string[];
  /** Was this workflow published by the meta surface (`publisher: ai`)? */
  aiWorkflow(name: string): Promise<boolean>;
  /** Was this step type published by the meta surface? */
  aiStep(type: string): boolean;
}

export function reachPolicyOf(services: unknown): ReachPolicy | undefined {
  return (services as { reach?: ReachPolicy } | null | undefined)?.reach;
}

/** A secrets capability that answers only `allowed`; any other name throws,
 *  so a step that asks for one fails saying why. Re-binding to a principal
 *  keeps the scope. */
export function scopeSecrets(secrets: SecretsCapability | undefined, allowed: readonly string[], who: string): SecretsCapability {
  const ok = new Set(allowed);
  const scoped = (inner: SecretsCapability | undefined): SecretsCapability => ({
    async get(name: string) {
      if (!ok.has(name)) throw new Error(outOfReach(who, name));
      return inner?.get(name);
    },
    ...(inner?.forPrincipal ? { forPrincipal: (p: string) => scoped(inner.forPrincipal!(p)) } : {}),
  });
  return scoped(secrets);
}

function outOfReach(who: string, name: string): string {
  return `"${who}" may not read the secret "${name}": code the AI published reads only the secrets in the host's builder.reach.secrets`;
}

/** The secret NAMES a step's config hands it: `secretsEnv` entries and a
 *  `tokenSecret`. With `defaults`, a `tokenSecret` the config leaves out is
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

/**
 * The step's context with reach applied, or the same context when no reach
 * applies. Throws when a step inside a workflow the AI published names a
 * secret outside reach in its config.
 */
export function withinReach<T extends StepContext<unknown>>(type: string, cfg: unknown, ctx: T): T {
  const policy = reachPolicyOf(ctx.services);
  if (!policy) return ctx;
  let out = ctx;
  if (ctx.aiAuthored) {
    for (const name of secretNamesIn(cfg)) {
      if (typeof name !== "string" || !policy.secrets.includes(name)) {
        throw new Error(`${outOfReach(type, String(name))} — this step runs inside a workflow the AI published`);
      }
    }
    // The launcher's MCP servers are not in reach: an AI frame never holds them.
    if (ctx.mcp) out = { ...out, mcp: undefined };
  }
  if (!policy.aiStep(baseType(type))) return out;
  // The AI's own step code: secrets scoped, and none of the doors that run
  // other steps with the run's whole bag (authoring's runs, a job's held
  // release), nor the policy itself.
  const { authoring: _a, jobs: _j, reach: _r, ...services } = ctx.services as Record<string, unknown>;
  return { ...out, services: { ...services, secrets: scopeSecrets(services["secrets"] as SecretsCapability | undefined, policy.secrets, type) } };
}

/** May code the AI wrote run `type` (bare)? `exec` is a built-in; control
 *  flow, the model steps and the AI's own steps are always in. */
export function stepInReach(type: string, reach: BuilderReach, aiStep: (type: string) => boolean): boolean {
  if (type === "exec") return (reach.builtins ?? []).includes("exec");
  return ALWAYS_IN_REACH.has(type) || aiStep(type) || (reach.tools ?? []).some((p) => globToRegExp(p).test(type));
}

/**
 * Why a workflow the AI wants to publish is outside reach, as a sentence
 * for the error, or null when it is inside.
 */
export async function reachRefusal(
  flow: Pick<Flow, "steps">,
  reach: BuilderReach,
  registry: StepRegistry,
  aiStep: (type: string) => boolean,
  workspace?: SubflowResolver,
): Promise<string | null> {
  const builtins = new Set(reach.builtins ?? []);
  const secrets = new Set(reach.secrets ?? []);
  const inTools = (type: string) => (reach.tools ?? []).some((p) => globToRegExp(p).test(type));
  const inReach = (type: string) => stepInReach(type, reach, aiStep);

  const problems: string[] = [];
  const steps: Step[] = [];
  const closure = await flowClosure(flow, workspace, (s) => steps.push(s));
  if (!closure.resolvable) {
    problems.push("its closure cannot be read in full (a templated subflow or agentTools, or a subflow that does not resolve)");
  }
  for (const type of closure.types) {
    if (!inReach(type)) problems.push(type === "exec" ? `the built-in "exec"` : `the step "${type}"`);
  }
  for (const grant of closure.agentTools) {
    const base = baseType(grant);
    if (!grant.includes("*")) {
      if (!inReach(base)) problems.push(base === "exec" ? `the built-in "exec" (agentTools)` : `the grant "${grant}"`);
      continue;
    }
    // A glob is in reach when a reach pattern covers it as written, or when
    // everything it reaches today is (steps the AI published, say).
    if (inTools(grant)) continue;
    const re = globToRegExp(grant);
    const reached = Object.keys(registry).filter((t) => re.test(t));
    const outside = reached.find((t) => !inReach(t));
    if (!reached.length || outside) problems.push(`the grant "${grant}"${outside ? ` (reaches "${outside}")` : ""}`);
  }
  for (const s of steps) {
    const cfg = (s.config ?? {}) as Record<string, unknown>;
    if (s.type === "agent") {
      const filter = cfg["toolFilter"];
      if (!Array.isArray(filter) || filter.length === 0) {
        if (!builtins.has("*")) problems.push(`an agent with every built-in (step "${s.id}": list the ones it needs in toolFilter)`);
      } else {
        for (const b of filter) {
          if (typeof b !== "string" || hasTemplates(b)) problems.push(`a templated toolFilter (step "${s.id}")`);
          else if (b !== "none" && !builtins.has(b) && !builtins.has("*")) problems.push(`the built-in "${b}"`);
        }
      }
    }
    for (const name of secretNamesIn(cfg, registry[baseType(s.type)])) {
      if (typeof name !== "string" || hasTemplates(name)) problems.push(`a secret named by a template (step "${s.id}")`);
      else if (!secrets.has(name)) problems.push(`the secret "${name}"`);
    }
  }
  if (!problems.length) return null;
  const unique = [...new Set(problems)];
  return `it reaches ${unique.join(", ")}, outside what this strut lets the AI publish (builder.reach)`;
}
