/**
 * The FENCE (plans/marketplace.md §3.5): a step whose version came from a
 * package — its `upstream`, which a fork carries forward — reads only the
 * secrets its package declared (`requires.secrets`). The registry hands out
 * the step wrapped (`fenceStep`, at build and for a pinned version), so
 * every way a step runs — a workflow, an agent's tool call, `run_step`, a
 * check, a proposal's apply — passes its `ctx.services.secrets` through the
 * fence, and a name outside the list fails naming the package.
 *
 * Steps only: a bought WORKFLOW is YAML whose `secretsEnv` names a person
 * reads in the install ask; a bought step is code that could ask for any
 * name at run time. Not isolation — the step still has `shell` and `http` —
 * but what the ask said the code may read is then what it can read.
 */
import type { AnyStepDef, StepContext } from "../core.js";
import type { SecretsCapability } from "../capabilities.js";
import type { Upstream, WorkspaceStore } from "../workspace.js";

export type Fence = Pick<Upstream, "package" | "secrets">;

/** The fence of every custom step whose ACTIVE version came from a package,
 *  by type — what `buildRegistry` wraps. */
export async function workspaceFences(workspace: Pick<WorkspaceStore, "listSteps">): Promise<Record<string, Fence>> {
  const out: Record<string, Fence> = {};
  for (const s of await workspace.listSteps()) if (s.upstream) out[s.type] = { package: s.upstream.package, secrets: s.upstream.secrets ?? [] };
  return out;
}

/** `secrets` as a step from `fence.package` may read it. */
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
  if (secrets.forPrincipal) {
    const bind = secrets.forPrincipal.bind(secrets);
    view.forPrincipal = (principal) => fencedSecrets(bind(principal), type, fence);
  }
  return view;
}

/** The step, running behind its package's fence. */
export function fenceStep(def: AnyStepDef, fence: Fence): AnyStepDef {
  return {
    ...def,
    run: (cfg, ctx) => def.run(cfg, fencedContext(ctx, def.type, fence)),
  };
}

function fencedContext(ctx: StepContext<any> | undefined, type: string, fence: Fence): StepContext<any> {
  const services = ctx?.services as { secrets?: SecretsCapability } | undefined;
  if (!ctx || !services?.secrets) return ctx as StepContext<any>;
  return { ...ctx, services: { ...services, secrets: fencedSecrets(services.secrets, type, fence) } };
}
