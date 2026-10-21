import type { WorkspaceStore } from "./workspace.js";
import { templateWithDelta, type JobSeedOptions } from "./job-seed.js";

/**
 * The `builder` workflow — the third workflow strut ships (plans/builder-job.md),
 * seeded at boot exactly as `job` and `orchestrator` are (src/job-seed.ts:
 * content-hash publish, `reactivateKnown: false`, `source: "seed"`, one
 * seeder per name). One turn of a WORKFLOW BUILD, as a job: `job/dir` →
 * `context/concept` on `Workflow Builder` → `agent` on the job's session
 * with the `meta/*` authoring twins as its tools and the web tools as its
 * only built-ins → `pack` in the job's reply shape. Building workflows is
 * a separate kind of work from a code job (ruled 2026-10-20): `job` never
 * carries these tools, and the orchestrator starts a builder job for them.
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
export type BuilderSeedOptions = JobSeedOptions;

export const BUILDER_WORKFLOW = "builder";
export const BUILDER_CATEGORY = "job";

/** The description `list_workflows` / the sidebar show for it. */
export const BUILDER_DESCRIPTION =
  "A workflow-building turn, as a job: an agent with the meta/* authoring twins (list/get/search steps and workflows, create/edit a step, validate, publish, run, run a step with a cassette, read runs, claims) and the web tools as its only built-ins, in a thread that remembers every earlier turn (agent with session: {{ input.session || $job }}), with the Workflow Builder page — what this workspace builds — in its prompt. " +
  "Launch it with `job` on the launch — POST /workflows/builder/run { job, input: { prompt }, callback } — and the same job again to go on with the same build. " +
  "Input: { prompt, workspace? (this strut's workspace slug), session? (the thread: the job id unless given), peer? (a peer's id: the build happens on THAT strut's builder, under this job id — this run waits on it) }. " +
  "Output: { text, artifacts, ask?: { message }, cost, session, peer? }, job's shape. " +
  "Open to peers (`peer: true`): another strut launches it as published. params.tools (meta/*, the graph reads, job/list, get, read), params.builtins and params.system are the evolvable surface; the host adds its own through createStrut({ builder }).";

const BUILDER_YAML = new URL("./workflows/builder.yaml", import.meta.url);

/** The `builder` template with the host's delta applied. */
export async function builderWorkflowYaml(opts?: BuilderSeedOptions): Promise<string> {
  return templateWithDelta(BUILDER_YAML, opts);
}

/** Seed `builder` into the workspace: the boot step `createStrut` runs. */
export async function seedBuilderWorkflow(workspace: WorkspaceStore, opts?: BuilderSeedOptions): Promise<{ version: string; changed: boolean }> {
  const text = await builderWorkflowYaml(opts);
  return workspace.publishWorkflowByContent(BUILDER_WORKFLOW, text, BUILDER_DESCRIPTION, BUILDER_CATEGORY, undefined, { reactivateKnown: false, source: "seed" });
}
