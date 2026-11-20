/**
 * The FENCE (plans/marketplace.md §3.5): a step whose version came from a
 * package — its `upstream`, which a fork carries forward — reads only the
 * secrets its package declared (`requires.secrets` and `requires.optional`).
 * The registry hands out the step wrapped (`fenceStep`, at build and for a
 * pinned version), so every way a step runs — a workflow, an agent's tool
 * call, `run_step`, a check, a proposal's apply — passes its
 * `ctx.services.secrets` through the fence, and a name outside the list
 * fails naming the package.
 *
 * It also hands the step the secrets its package PROVIDES
 * (`provides.secrets`), and those alone, to manage: `secrets.own`, the run's
 * person's own values apart from the deployment's, wherever the run has a
 * principal; and `secrets.deployment`, the deployment's, only on a call from
 * the package's OWN `admin: true` app shown to an admin (the app door binds
 * that call's `secrets`, `adminSecrets` in src/capabilities.ts). Both come
 * from strut's own capability, out of a step's sight (`secretScopesOf`), so
 * no other step has them. And it takes `secretBlanks` off the step's bag: a
 * package's step writes a secret through its own scopes, or not at all, so
 * a member's call never sets the deployment's.
 *
 * Steps only: a bought WORKFLOW is YAML whose `secretsEnv` names a person
 * reads in the install ask; a bought step is code that could ask for any
 * name at run time. Not isolation — the step still has `shell` and `http` —
 * but what the ask said the code may read is then what it can read.
 */
import type { AnyStepDef, StepContext } from "../core.js";
import { secretScopesOf, type SecretScope, type SecretsCapability } from "../capabilities.js";
import type { Upstream, WorkspaceStore } from "../workspace.js";

export type Fence = Pick<Upstream, "package" | "secrets" | "provides">;

/** The fence of every custom step whose ACTIVE version came from a package,
 *  by type — what `buildRegistry` wraps. */
export async function workspaceFences(workspace: Pick<WorkspaceStore, "listSteps">): Promise<Record<string, Fence>> {
  const out: Record<string, Fence> = {};
  for (const s of await workspace.listSteps()) {
    if (s.upstream) out[s.type] = { package: s.upstream.package, secrets: s.upstream.secrets ?? [], ...(s.upstream.provides ? { provides: s.upstream.provides } : {}) };
  }
  return out;
}

/** `secrets` as a step from `fence.package` may read it — and manage what
 *  the package provides. */
export function fencedSecrets(secrets: SecretsCapability, type: string, fence: Fence): SecretsCapability {
  const allowed = new Set(fence.secrets);
  const view: SecretsCapability = {
    async get(name: string) {
      if (!allowed.has(name)) {
        const declared = fence.secrets.length ? `declares only ${fence.secrets.join(", ")}` : "declares no secrets";
        throw new Error(`secret_fenced: ${type} came from the package ${fence.package}, which ${declared} — it may not read ${name}`);
      }
      return secrets.get(name);
    },
  };
  const provided = fence.provides?.secrets ?? [];
  const scopes = provided.length ? secretScopesOf(secrets) : undefined;
  if (scopes?.own) view.own = fencedScope(scopes.own, type, fence, "the person's own");
  if (scopes?.deployment && scopes.admin === fence.package) view.deployment = fencedScope(scopes.deployment, type, fence, "the deployment's");
  if (secrets.forPrincipal) {
    const bind = secrets.forPrincipal.bind(secrets);
    view.forPrincipal = (principal) => fencedSecrets(bind(principal), type, fence);
  }
  return view;
}

/** One scope held to the names the package provides. */
function fencedScope(scope: SecretScope, type: string, fence: Fence, whose: string): SecretScope {
  const provided = fence.provides?.secrets ?? [];
  const named = (name: string, verb: string): string => {
    if (!provided.includes(name)) throw new Error(`secret_fenced: ${type} came from the package ${fence.package}, which provides only ${provided.join(", ")} — it may not ${verb} ${whose} ${name}`);
    return name;
  };
  return Object.freeze({
    get: async (name: string) => scope.get(named(name, "read")),
    set: async (name: string, value: string) => scope.set(named(name, "set"), value),
    delete: async (name: string) => scope.delete(named(name, "delete")),
  });
}

/** The step, running behind its package's fence. */
export function fenceStep(def: AnyStepDef, fence: Fence): AnyStepDef {
  return {
    ...def,
    run: (cfg, ctx) => def.run(cfg, fencedContext(ctx, def.type, fence)),
  };
}

function fencedContext(ctx: StepContext<any> | undefined, type: string, fence: Fence): StepContext<any> {
  const services = ctx?.services as { secrets?: SecretsCapability; secretBlanks?: unknown } | undefined;
  if (!ctx || !services || (!services.secrets && !services.secretBlanks)) return ctx as StepContext<any>;
  const { secretBlanks: _blanks, ...rest } = services;
  return { ...ctx, services: { ...rest, ...(services.secrets ? { secrets: fencedSecrets(services.secrets, type, fence) } : {}) } };
}
