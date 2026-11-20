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
 * a member's call never sets the deployment's. The view has no
 * `forPrincipal`: the runner binds the bag to the run's person before the
 * step runs, and a package's step works for that person alone — it never
 * reads or manages another person's value by re-binding.
 *
 * And it starts work only as ITS run's person (stadeum plans/software.md §5,
 * item 15: a package never names a person). Each capability that starts a
 * run, or says whom one is for, is handed to it held to the actor and
 * principal the runner gave this step, whatever it passes
 * (`heldToItsRun`), and what only a person or the server does is not on
 * its bag at all.
 *
 * Steps only: a bought WORKFLOW is YAML whose `secretsEnv` names a person
 * reads in the install ask; a bought step is code that could ask for any
 * name at run time. Not isolation — the step still has `shell` and `http` —
 * but what the ask said the code may read is then what it can read.
 */
import type { AnyStepDef, StepContext } from "../core.js";
import { secretScopesOf, type SecretScope, type SecretsCapability } from "../capabilities.js";
import type { AuthoringCapability } from "../authoring.js";
import type { JobsCapability } from "../jobs.js";
import type { PeersCapability } from "../peers.js";
import type { ProposalsCapability } from "../proposals.js";
import type { RunsCapability } from "../runs.js";
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
  // No `forPrincipal`: the runner binds a run's bag before the step runs,
  // and a package's step works for that person alone. Re-bound, it could
  // read another person's value or manage their own.
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
  const services = ctx?.services as (Record<string, unknown> & { secrets?: SecretsCapability }) | undefined;
  if (!ctx || !services || typeof services !== "object") return ctx as StepContext<any>;
  // Not a package step's: a blank of the deployment's to fill, the
  // scheduler's API (a package's schedules are its `schedules:`), and
  // trials (an admin's page starts them).
  const { secretBlanks: _blanks, automations: _automations, trials: _trials, ...rest } = services;
  return {
    ...ctx,
    services: {
      ...rest,
      ...(services.secrets ? { secrets: fencedSecrets(services.secrets, type, fence) } : {}),
      ...heldToItsRun(services, ctx, type, fence),
    },
  };
}

/** `cap` with `methods` in place of its own; the rest as it is. */
const over = <T extends object>(cap: T, methods: Record<string, unknown>): T => Object.freeze(Object.assign(Object.create(cap) as T, methods));

/**
 * The capabilities that start a run, or say whom one is for, as a package's
 * step holds them: for the person of ITS run — the actor and principal the
 * runner gave this step — whatever it passes. `runs.launch` takes the run's
 * own caller; `authoring.runWorkflow`, `resumeRun` and `controlRun`,
 * `jobs.launch` and `proposals.propose` take the run's actor and principal;
 * a request to a peer carries the run's principal as `x-strut-actor`, or
 * none. A run that acts for nobody launches none from it (`runs.launch`,
 * `jobs.launch`): with no person, a launch runs as the launched workflow's
 * owner (`principalFor`). A nested run (`runWorkflow`) has no such
 * fallback, so it runs as nobody, as its parent does. Deciding a proposal
 * is a person's (`decide` is not there): its apply runs as its proposer.
 */
function heldToItsRun(services: Record<string, unknown>, ctx: StepContext<any>, type: string, fence: Fence): Record<string, unknown> {
  const { actor, principal } = ctx;
  const person = { ...(actor ? { actor } : {}), ...(principal ? { principal } : {}) };
  const someone = () => {
    if (!principal) throw new Error(`run_as_fenced: ${type} came from the package ${fence.package}, whose steps start a run only as their own run's person — and this run acts for nobody`);
  };
  const out: Record<string, unknown> = {};
  const runs = services["runs"] as RunsCapability | undefined;
  if (runs?.launch) {
    out["runs"] = over(runs, {
      launch: (q: Parameters<RunsCapability["launch"]>[0]) => {
        someone();
        return runs.launch(q, {
          ...person,
          ...(ctx.app ? { app: ctx.app } : {}),
          ...(ctx.mcp?.length ? { mcp: ctx.mcp } : {}),
          ...(ctx.branch ? { branch: ctx.branch } : {}),
          ...(ctx.trial ? { trial: ctx.trial } : {}),
        });
      },
    });
  }
  const authoring = services["authoring"] as AuthoringCapability | undefined;
  if (authoring?.runWorkflow) {
    out["authoring"] = over(authoring, {
      runWorkflow: (...[name, input, params, version, opts]: Parameters<AuthoringCapability["runWorkflow"]>) => {
        const { actor: _a, principal: _p, ...rest } = opts ?? {};
        return authoring.runWorkflow(name, input, params, version, { ...rest, ...person });
      },
      resumeRun: (...[name, runId, body]: Parameters<AuthoringCapability["resumeRun"]>) => authoring.resumeRun(name, runId, body, principal ? { principal } : {}),
      controlRun: (...[name, runId, action, caller]: Parameters<AuthoringCapability["controlRun"]>) =>
        authoring.controlRun(name, runId, action, { ...(caller?.force ? { force: true } : {}), ...(principal ? { principal } : {}) }),
    });
  }
  const jobs = services["jobs"] as JobsCapability | undefined;
  if (jobs?.launch) {
    const launch = jobs.launch.bind(jobs);
    out["jobs"] = over(jobs, {
      launch: (opts: Parameters<typeof launch>[0]) => {
        someone();
        const { actor: _a, principal: _p, ...rest } = opts;
        return launch({ ...rest, ...person });
      },
    });
  }
  const proposals = services["proposals"] as ProposalsCapability | undefined;
  if (proposals?.propose) {
    out["proposals"] = over(proposals, {
      propose: (p: Parameters<ProposalsCapability["propose"]>[0]) => {
        const { actor: _a, principal: _p, ...by } = p.by;
        return proposals.propose({ ...p, by: { ...by, ...person } });
      },
      decide: undefined,
    });
  }
  const peers = services["peers"] as PeersCapability | undefined;
  if (peers?.fetch) {
    out["peers"] = over(peers, {
      fetch: (...[id, path, init]: Parameters<PeersCapability["fetch"]>) => {
        const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).filter(([k]) => k.toLowerCase() !== "x-strut-actor"));
        return peers.fetch(id, path, { ...init, headers: { ...headers, ...(principal ? { "x-strut-actor": principal } : {}) } });
      },
    });
  }
  return out;
}
