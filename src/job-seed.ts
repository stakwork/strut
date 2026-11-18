import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { JobGrant } from "./packages/format.js";
import { listInstalledPackages, type InstalledDeps } from "./packages/installed.js";
import type { WorkspaceStore } from "./workspace.js";

/**
 * The `job` workflow — the one workflow strut SHIPS (plans/jobs.md §5).
 *
 * Everything else about jobs is already strut core: the directory and its
 * holds (`jobs.ts`), the index and the thread fold, the `job/*` steps,
 * `POST …/run { job }`, the Jobs sidebar. This is the workflow those exist
 * to serve — `job/dir → checkouts → agent (session: the job) → pack`, every
 * step strut's own — seeded into the workspace when `createStrut` boots,
 * through a content-hash publish (`publishWorkflowByContent`,
 * `source: "seed"`), and a seed always matches git: every boot makes the
 * committed template (with the host's delta) the active version — a new
 * text publishes the next `vN`, a text seen before (a delta taken back out,
 * a template reverted) is made active again, and a workspace-side edit (the
 * UI, the chat builder, a promotion) lasts until the next boot, kept in the
 * history. Exactly ONE seeder per name: a host that wants more on the job
 * agent passes its DELTA here rather than publishing on top — two seeders
 * over one name would swap the active version at every boot.
 *
 * The delta (`createStrut({ job })`) is the twin of `chatSystem`: strut
 * owns how a job turn works, the host owns what its deployment adds —
 * grants appended to `params.tools` (the lab's `pod/*`), a section appended
 * to `params.system` after strut's (what the deployment adds — which
 * workspace this strut belongs to, who its peers are). The merged text is
 * what is hashed and published, so a host
 * changing its delta publishes a new version exactly as a seed edit does.
 * `params.tools` is a flat grant list, never a filter: a type this registry
 * lacks is skipped with a warning at run time, a glob matching nothing
 * warns, so the same YAML runs where a grant's steps are absent — the agent
 * simply lacks those tools.
 *
 * An installed PACKAGE adds to the same delta (plans/followed-repos.md §3):
 * what its manifest's `job:` names, resolved over its own steps when it was
 * read (src/packages/format.ts) — the types into `params.tools`, the
 * `approve` ones into `params.approve` too — after the host's, deduplicated
 * and sorted, so the text and its version do not depend on install order.
 * createStrut seeds again after every package write, so an install grants
 * and an uninstall takes the grant away without a reboot.
 */
export interface JobSeedOptions {
  /** Registry step types, or globs (`pod/*`), granted to the job agent ON
   *  TOP of strut's list — appended to `params.tools`. */
  tools?: string[];
  /** Step types among the grants that need the person's approval
   *  (plans/proposals.md): appended to `params.approve`, the agent step's
   *  gate — a call records a proposal instead of running the step. */
  approve?: string[];
  /** A section appended to the agent's system prompt after strut's — the
   *  deployment's own instructions. Which workflow does which kind of work
   *  is not one: that is the `Job` Concept's children, which the workflow
   *  puts after the prompt (`context/concept`). */
  system?: string;
  /** The model the agent runs on, in place of the template's. `null`: none
   *  pinned, so it runs on the deployment's connected model
   *  (`STRUT_DEFAULT_MODEL`), which a desktop host changes at run time. */
  model?: string | null;
  /** `false` deletes the template's top-level `peer:` — a deployment that
   *  will not have other struts launch the workflow. `builder` carries
   *  `peer: true` (plans/builder-job.md §4), `orchestrator` `peer: person`
   *  (plans/chained-orchestrators.md §2); on `job` there is nothing to
   *  delete. A delta can only CLOSE a workflow to peers, never open one:
   *  opening is the template's statement. */
  peer?: false;
}

export const JOB_WORKFLOW = "job";
export const JOB_CATEGORY = "job";

/** The description `list_workflows` / the sidebar show for it. */
export const JOB_DESCRIPTION =
  "A job turn: an agent working in the job's directory with a thread that remembers every earlier turn (job/dir → agent with session: {{ input.session || $job }} → pack). " +
  "Launch it with `job` on the launch — POST /workflows/job/run { job, input: { prompt }, callback } — and the same job again to revise the same files; without a job it is a one-shot in the run's artifact directory. " +
  "Input: { prompt, workspace? (the slug of the workspace this strut server belongs to — the agent's message starts with it; another workspace is a peer, @<slug>), session? (the agent's thread: the job id unless given), repos? (repository URLs checked out into the job's directory, kept turn to turn) }. " +
  "Output: { text, artifacts: [{ id, kind?, title, label?, summary?, path | url | content }], ask?: { message }, cost, session }; the callback carries `artifacts` resolved to links. " +
  "params.tools (registry steps granted on top of the agent's built-ins: graph reads; meta/list-workflows, get-workflow, run-workflow, get-run; strut/run-workflow — a workflow on a peer; job/list, get, read — earlier jobs) and params.system are the evolvable surface; the host adds its own through createStrut({ job }).";

const JOB_YAML = new URL("./workflows/job.yaml", import.meta.url);

/** A committed template with the host's delta applied — the text that is
 *  hashed and published. Pure over the file: no workspace. Shared with the
 *  `orchestrator` and `builder` seeds, whose delta is the same. `fill`
 *  renders strut's own text into the template's `params.system` BEFORE the
 *  host's section is appended (the builder's rules, src/builder-seed.ts),
 *  so the hash covers it. */
export async function templateWithDelta(template: URL, opts?: JobSeedOptions, fill?: (system: string) => string): Promise<string> {
  const doc = yaml.load(await readFile(template, "utf-8")) as { peer?: boolean | "person"; params: { tools: string[]; approve?: string[]; system: string; model?: string } };
  if (fill) doc.params.system = fill(doc.params.system);
  if (opts?.peer === false) delete doc.peer;
  // A tool the template already grants is not listed twice (a host that
  // granted graph/graph-get before the orchestrator did).
  if (opts?.tools?.length) doc.params.tools.push(...opts.tools.filter((t) => !doc.params.tools.includes(t)));
  if (opts?.approve?.length) (doc.params.approve ??= []).push(...opts.approve);
  if (opts?.model === null) delete doc.params.model;
  else if (opts?.model) doc.params.model = opts.model;
  if (opts?.system?.trim()) doc.params.system = `${doc.params.system.trimEnd()}\n\n${opts.system.trim()}\n`;
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

/** The `job` template with the host's delta applied. */
export async function jobWorkflowYaml(opts?: JobSeedOptions): Promise<string> {
  return templateWithDelta(JOB_YAML, opts);
}

/**
 * What the installed packages give the job agent: each one's `job:`, read
 * from the package cache by the digest installed (nothing prunes it). A
 * package grants while something of it is still its own here — a
 * workflow, step or app whose active version it wrote: an uninstall that
 * keeps a fork leaves only forks (and the helpers they import), which are
 * this box's own work and grant nothing. A package the cache lacks, or
 * cannot read, grants nothing, with a warning.
 */
export async function packageJobGrants(deps: InstalledDeps): Promise<JobGrant> {
  const tools = new Set<string>();
  const approve = new Set<string>();
  for (const p of await listInstalledPackages(deps)) {
    if (!p.digest || !p.items.some((i) => i.kind !== "concept" && !i.helper && !i.modified)) continue;
    let job: JobGrant | undefined;
    try {
      const info = await deps.cache.get(p.digest);
      if (!info) throw new Error(`the package cache holds no ${p.digest}`);
      job = info.job;
    } catch (err) {
      console.warn(`[job] ${p.package}: what it gives the job agent is not granted —`, err instanceof Error ? err.message : err);
    }
    for (const t of job?.tools ?? []) tools.add(t);
    for (const t of job?.approve ?? []) approve.add(t);
  }
  return { tools: [...tools].sort(), approve: [...approve].sort() };
}

/** The host's delta with the packages' grants after its own. */
export function withJobGrants(opts: JobSeedOptions | undefined, grants: JobGrant): JobSeedOptions {
  if (!grants.tools.length) return { ...opts };
  return {
    ...opts,
    tools: [...new Set([...(opts?.tools ?? []), ...grants.tools])],
    ...(opts?.approve?.length || grants.approve.length ? { approve: [...new Set([...(opts?.approve ?? []), ...grants.approve])] } : {}),
  };
}

/** Seed `job` into the workspace: the boot step `createStrut` runs. */
export async function seedJobWorkflow(workspace: WorkspaceStore, opts?: JobSeedOptions): Promise<{ version: string; changed: boolean }> {
  const text = await jobWorkflowYaml(opts);
  return workspace.publishWorkflowByContent(JOB_WORKFLOW, text, JOB_DESCRIPTION, JOB_CATEGORY, undefined, { source: "seed" });
}
