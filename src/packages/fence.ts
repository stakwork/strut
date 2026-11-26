/**
 * The FENCE (plans/marketplace.md §3.5): a step whose version came from a
 * package — its `upstream`, which a fork carries forward — reads only the
 * secrets its package declared (`requires.secrets` and `requires.optional`).
 * The registry hands out the step wrapped (`fenceStep`, at build and for a
 * pinned version), so every way a step runs — a workflow, an agent's tool
 * call, `run_step`, a check, a proposal's apply — passes its
 * `ctx.services.secrets` through the fence, and a name outside the list
 * fails naming the package. Every function of the step is wrapped, not only
 * `run` (`STEP_FUNCTIONS`): the card it writes for a person, its own answer
 * to a gated call and a replay's `onReplay` read behind the same fence.
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
 * Git tokens the same way (stadeum plans/software.md §5, item 9): a
 * package's step holds `secrets.git(url)`, the run's token for a
 * repository's host, only when its package says `requires.git: true`, which
 * an install shows. Without it the step never sees a token, yet strut's own
 * git steps it calls with its ctx still use the run's: the view answers
 * them (`keepGitTokens`), and they send the token to its host alone.
 *
 * Its node files the same way (src/node-files.ts, plans/package-seams.md
 * §1): `nodeFiles` writes its package's folder on a node, and no other.
 *
 * Steps only: a bought WORKFLOW is YAML whose `secretsEnv` names a person
 * reads in the install ask; a bought step is code that could ask for any
 * name at run time. Not isolation — the step still has `shell` and `http` —
 * but what the ask said the code may read is then what it can read.
 */
import type { AnyStepDef, StepContext } from "../core.js";
import { gitTokens, keepGitTokens, secretScopesOf, type HttpCapability, type SecretScope, type SecretsCapability, type ShellCapability } from "../capabilities.js";
import type { AuthoringCapability } from "../authoring.js";
import type { JobsCapability } from "../jobs.js";
import type { PeersCapability } from "../peers.js";
import type { PlacesCapability } from "../people.js";
import type { ProposalsCapability } from "../proposals.js";
import type { RunsCapability } from "../runs.js";
import type { Upstream, WorkspaceStore } from "../workspace.js";
import { nodeFilesAs, type NodeFilesCapability } from "../node-files.js";

export type Fence = Pick<Upstream, "package" | "secrets" | "git" | "provides">;

/** The fence of every custom step whose ACTIVE version came from a package,
 *  by type — what `buildRegistry` wraps. */
export async function workspaceFences(workspace: Pick<WorkspaceStore, "listSteps">): Promise<Record<string, Fence>> {
  const out: Record<string, Fence> = {};
  for (const s of await workspace.listSteps()) {
    if (s.upstream) {
      const { package: pkg, secrets, git, provides } = s.upstream;
      out[s.type] = { package: pkg, secrets: secrets ?? [], ...(git ? { git } : {}), ...(provides ? { provides } : {}) };
    }
  }
  return out;
}

/** `secrets` as a step from `fence.package` may read it — and manage what
 *  the package provides. */
export function fencedSecrets(
  secrets: SecretsCapability,
  type: string,
  fence: Fence,
  via: { shell?: ShellCapability; http?: HttpCapability } = {},
): SecretsCapability {
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
  // The run's token for a repository's host: the step's own only when its
  // package says so; strut's git steps it calls read it either way, and
  // hand it only through the run's own shell and http.
  if (fence.git) view.git = gitTokens(secrets);
  keepGitTokens(view, secrets, via);
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

/** Every function of a step's definition that is handed the run's context
 *  (`AnyStepDef`, src/core.ts): its run, the card it writes for a person,
 *  its own answer to a gated call, what a replay puts back. A test reads
 *  core.ts and fails when one is added there and not here. */
export const STEP_FUNCTIONS = ["run", "describe", "answerGated", "onReplay"] as const;

/** The step, every function of it running behind its package's fence. */
export function fenceStep(def: AnyStepDef, fence: Fence): AnyStepDef {
  const out: Record<string, unknown> = { ...def };
  for (const name of STEP_FUNCTIONS) {
    const fn = def[name] as ((cfg: unknown, ctx: StepContext<any>, ...rest: unknown[]) => unknown) | undefined;
    if (fn) out[name] = (cfg: unknown, ctx: StepContext<any>, ...rest: unknown[]) => fn.call(def, cfg, fencedContext(ctx, def.type, fence), ...rest);
  }
  return out as unknown as AnyStepDef;
}

/** The fence refused this (`secret_fenced:`, `run_as_fenced:`, any
 *  `…_fenced:`): an error a caller that is otherwise best effort passes on,
 *  so it is never hidden. */
export function fenceRefused(err: unknown): boolean {
  return err instanceof Error && /^[a-z_]+_fenced:/.test(err.message);
}

/** Each fenced bag → the run's own it was made from (`unfencedServicesOf`). */
const UNFENCED = new WeakMap<object, object>();

/** The run's own bag behind a package step's fenced one: for strut's own
 *  seams that call ANOTHER package's step on the caller's behalf
 *  (`git/repositories`, `git/pull-request`), which run it behind its own
 *  fence, never the caller's. A bag that is no fence's is answered as it is.
 *  Never handed to a step. */
export function unfencedServicesOf<T>(services: T): T {
  if (services == null || typeof services !== "object") return services;
  return (UNFENCED.get(services as object) as T | undefined) ?? services;
}

function fencedContext(ctx: StepContext<any> | undefined, type: string, fence: Fence): StepContext<any> {
  const services = ctx?.services as (Record<string, unknown> & { secrets?: SecretsCapability }) | undefined;
  if (!ctx || !services || typeof services !== "object") return ctx as StepContext<any>;
  const fenced = fencedServices(services, ctx, type, fence);
  UNFENCED.set(fenced, unfencedServicesOf(services));
  return { ...ctx, services: fenced };
}

function fencedServices(services: Record<string, unknown> & { secrets?: SecretsCapability }, ctx: StepContext<any>, type: string, fence: Fence): Record<string, unknown> {
  // Not a package step's: a blank of the deployment's to fill, the
  // scheduler's API (a package's schedules are its `schedules:`), trials
  // (an admin's page starts them), and the `on:` dispatch, which names a
  // person (a package's `on:` is its manifest's; its writes are heard
  // through the run's graph view, which holds it already).
  const { secretBlanks: _blanks, automations: _automations, trials: _trials, onWrites: _onWrites, ...rest } = services;
  return {
    ...rest,
    ...(services.secrets
      ? {
          secrets: fencedSecrets(services.secrets, type, fence, {
            ...(services["shell"] ? { shell: services["shell"] as ShellCapability } : {}),
            ...(services["http"] ? { http: services["http"] as HttpCapability } : {}),
          }),
        }
      : {}),
    ...heldToItsRun(services, ctx, type, fence),
    // Its node files are its package's folder (src/node-files.ts).
    ...(services["nodeFiles"] ? { nodeFiles: nodeFilesAs(services["nodeFiles"] as NodeFilesCapability, fence.package) } : {}),
  };
}

/**
 * `cap` as a package's step holds it: a FRESH object with `methods` in
 * place of its own (`undefined`: left out), and every other method of
 * `cap`'s — its own and its prototypes' — forwarding to it, with every
 * other value copied. `cap` itself is nowhere a step reaches: not its
 * prototype (a plain object's), not a property, not behind a forwarder (a
 * closure). A value that is `cap` again is left out.
 */
function held<T extends object>(cap: T, methods: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (let o: object | null = cap; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === "constructor" || k in out || k in methods) continue;
      const v: unknown = Reflect.get(cap, k);
      if (typeof v === "function") out[k] = (...args: unknown[]) => Reflect.apply(v as (...a: unknown[]) => unknown, cap, args);
      else if (v !== cap) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(methods)) if (v !== undefined) out[k] = v;
  return Object.freeze(out) as T;
}

/**
 * The capabilities that start a run, or say whom one is for, as a package's
 * step holds them: for the person of ITS run — the actor and principal the
 * runner gave this step — whatever it passes. `runs.launch` takes the run's
 * own caller; `authoring.runWorkflow`, `resumeRun` and `controlRun`,
 * `jobs.launch` and `proposals.propose` take the run's actor and principal;
 * `jobs.followUp` takes the run itself, whose person strut reads, and
 * looks only with the package's own steps;
 * a request to a peer carries the run's principal as `x-strut-actor`, or
 * none; a post in a place (`places.post`, `places.list`) is the run's
 * principal's. A run that acts for nobody launches none from it (`runs.launch`,
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
    out["runs"] = held(runs, {
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
    out["authoring"] = held(authoring, {
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
  if (jobs?.launch || jobs?.followUp) {
    const launch = jobs.launch?.bind(jobs);
    const followUp = jobs.followUp?.bind(jobs);
    out["jobs"] = held(jobs, {
      ...(launch
        ? {
            launch: (opts: Parameters<typeof launch>[0]) => {
              someone();
              const { actor: _a, principal: _p, ...rest } = opts;
              return launch({ ...rest, ...person });
            },
          }
        : {}),
      // A follow-up looks as the person of the run that asks
      // (plans/job-follow-ups.md): this step's own run and job, and with
      // one of its package's own steps.
      ...(followUp
        ? {
            followUp: (ask: Parameters<typeof followUp>[0]) => {
              if (!ctx.job) throw new Error(`follow_up_fenced: ${type} came from the package ${fence.package}, and its run has no job to follow up`);
              if (!ask.look?.type?.startsWith(`${fence.package}/`)) {
                throw new Error(`follow_up_fenced: ${type} came from the package ${fence.package}, whose follow-ups look with its own steps, not ${ask.look?.type}`);
              }
              return followUp({ ...ask, job: ctx.job, runId: ctx.runId });
            },
          }
        : {}),
    });
  }
  const proposals = services["proposals"] as ProposalsCapability | undefined;
  if (proposals?.propose) {
    out["proposals"] = held(proposals, {
      propose: (p: Parameters<ProposalsCapability["propose"]>[0]) => {
        const { actor: _a, principal: _p, ...by } = p.by;
        return proposals.propose({ ...p, by: { ...by, ...person } });
      },
      decide: undefined,
    });
  }
  const peers = services["peers"] as PeersCapability | undefined;
  if (peers?.fetch) {
    out["peers"] = held(peers, {
      fetch: (...[id, path, init]: Parameters<PeersCapability["fetch"]>) => {
        const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).filter(([k]) => k.toLowerCase() !== "x-strut-actor"));
        return peers.fetch(id, path, { ...init, headers: { ...headers, ...(principal ? { "x-strut-actor": principal } : {}) } });
      },
    });
  }
  // Posts in places (plans/place-posts.md): as its run's person alone.
  const places = services["places"] as PlacesCapability | undefined;
  if (places?.post) {
    out["places"] = held(places, {
      post: (post: Parameters<PlacesCapability["post"]>[0]) => places.post(post, principal),
      list: () => places.list(principal),
    });
  }
  return out;
}
