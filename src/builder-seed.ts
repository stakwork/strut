import type { WorkspaceStore } from "./workspace.js";
import { templateWithDelta, type JobSeedOptions } from "./job-seed.js";
import { BUILD_APP_ARTIFACT, BUILD_VERIFIED, builderRules, JOB_TOOLS } from "./ai/prompts.js";
import type { BuilderReach } from "./reach.js";

/**
 * The `builder` workflow — the third workflow strut ships (plans/builder-job.md),
 * seeded at boot exactly as `job` and `orchestrator` are (src/job-seed.ts:
 * content-hash publish, `source: "seed"`, always the committed template,
 * one seeder per name). One turn of a WORKFLOW BUILD, as a job: `job/dir` →
 * `context/concept` on `Workflow Builder` → `agent` on the job's session
 * with the `meta/*` authoring twins, the `app/*` steps and `git/checkout` (a
 * repository to learn from, into the job's directory) as its tools and
 * the web tools plus the EDITOR family (view, create, str_replace, insert;
 * a tree listing; a grep — plans/apps.md §8, never bash) as its built-ins
 * → `pack` in the job's reply shape. A workflow lives on one strut, so a
 * build runs on the strut it belongs to (here, or a peer through its
 * `input.peer` branch), while code is checked out wherever a job runs:
 * `job` never carries these tools, the orchestrator starts a builder job
 * for a build, and a job agent that meets one runs this workflow itself
 * (the `Job` page's docs). The missing shell is focus, not a boundary
 * (builder.yaml's header).
 *
 * Its system prompt is the builder chat's rules — strut's workflow dialect,
 * the tools section and the procedure — rendered from the same source in
 * the twins' names (`builderRules(JOB_TOOLS)`, src/ai/prompts.ts) into the
 * template's marker line before the host's delta is appended, so the hash
 * covers it: a change to the rules publishes the next version at the next
 * boot, as a template edit does.
 *
 * `peer: true` in the template: another strut may launch it as published
 * (plans/federation.md §3) — a build on `@acme-web` is this workflow on
 * that strut, reached from here through its own `input.peer` branch. The
 * header comment in builder.yaml is the statement that key makes; a
 * deployment that will not have it drops the key through the delta
 * (`peer: false`).
 *
 * Generic: it knows no host. A host adds its tools, its approvals and a
 * prompt section through `createStrut({ builder: { tools, approve, system,
 * model, peer } })` — the same delta `job` takes — and the bundled server
 * reads it from the file `STRUT_HOST_CONFIG` names (src/server.ts).
 */
export type BuilderSeedOptions = JobSeedOptions & {
  /** Not part of the template: what a workflow the meta surface publishes
   *  may reach, and no step code (src/reach.ts). */
  reach?: BuilderReach;
};

export const BUILDER_WORKFLOW = "builder";
export const BUILDER_CATEGORY = "job";

/** The description `list_workflows` / the sidebar show for it. */
export const BUILDER_DESCRIPTION =
  "A workflow-building turn, as a job: an agent with the meta/* authoring twins (list/get/search steps and workflows, create/edit a step, validate, publish, edit by find-and-replace, roll back, categorize, run, run a step with a cassette, read, resume, cancel and pause runs, claims) and the app/* steps (scaffold, build and publish an APP — a front-end project over workflows), with the web tools and the text editor (never bash) as its built-ins, in a thread that remembers every earlier turn (agent with session: {{ input.session || $job }}), with the Workflow Builder page — what this server builds — in its prompt. " +
  "Launch it with `job` on the launch — POST /workflows/builder/run { job, input: { prompt }, callback } — and the same job again to go on with the same build. " +
  "Input: { prompt, workspace? (this strut server's slug), session? (the thread: the job id unless given), peer? (a peer's id: the build happens on THAT server's builder, under this job id — this run waits on it) }. " +
  "Output: { text, artifacts, ask?: { message }, cost, session, peer? }, job's shape. " +
  "Open to peers (`peer: true`): another strut server launches it as published. params.tools (meta/*, app/*, the graph reads, job/list, get, read, git/checkout — a repository to learn from, checked out into the job's directory), params.builtins (the web tools, the editor family) and params.system are the evolvable surface; the host adds its own through createStrut({ builder }).";

const BUILDER_YAML = new URL("./workflows/builder.yaml", import.meta.url);

/** The line of builder.yaml's `params.system` that the seed replaces with
 *  strut's rules for building — the dialect, the tools and the procedure,
 *  in the meta/* names (`builderRules(JOB_TOOLS)`, src/ai/prompts.ts): the
 *  one source the builder chat's prompt is rendered from too
 *  (plans/builder-job.md §1). The YAML keeps what is the JOB's — who the
 *  agent is, the kinds, the reply — around it. */
export const BUILDER_RULES_MARKER = "<<strut: the builder's rules>>";

/** Each marker of builder.yaml's `params.system` and the text of
 *  src/ai/prompts.ts the seed puts there: the rules, then what a build
 *  owes beyond them, which the `Workflow Language` page says from the
 *  same source (plans/one-job-agent.md §2). */
const FILLS: ReadonlyArray<readonly [marker: string, text: () => string]> = [
  [BUILDER_RULES_MARKER, () => builderRules(JOB_TOOLS)],
  ["<<strut: a build is verified>>", () => BUILD_VERIFIED],
  ["<<strut: a published app>>", () => BUILD_APP_ARTIFACT],
];

function withRules(system: string): string {
  for (const [marker, text] of FILLS) {
    if (!system.includes(marker)) throw new Error(`builder.yaml: params.system has no "${marker}" for strut's text`);
    system = system.replace(marker, text);
  }
  return system;
}

/** The `builder` template with strut's rules rendered in and the host's
 *  delta applied. */
export async function builderWorkflowYaml(opts?: BuilderSeedOptions): Promise<string> {
  return templateWithDelta(BUILDER_YAML, opts, withRules);
}

/** Seed `builder` into the workspace: the boot step `createStrut` runs. */
export async function seedBuilderWorkflow(workspace: WorkspaceStore, opts?: BuilderSeedOptions): Promise<{ version: string; changed: boolean }> {
  const text = await builderWorkflowYaml(opts);
  return workspace.publishWorkflowByContent(BUILDER_WORKFLOW, text, BUILDER_DESCRIPTION, BUILDER_CATEGORY, undefined, { source: "seed" });
}
