import type { WorkspaceStore } from "./workspace.js";
import { templateWithDelta, type JobSeedOptions } from "./job-seed.js";

/**
 * The `orchestrator` workflow — a workflow strut ships, seeded at
 * boot exactly as `job` is (src/job-seed.ts: content-hash publish,
 * `reactivateKnown: false`, `source: "seed"`, one seeder per name). One
 * turn of a long conversation: `job/dir` (no job → the run's artifact
 * folder) → `context/concept` (the `Job` Concept's children — the kinds
 * of work a job can do here, the kinds alone — for the end of the prompt)
 * → `agent` on the caller's `session` (one per conversation, compacted in
 * place, its prompt its first turn's), no built-ins, strut's memory and
 * job steps as tools → `pack` in job's reply shape. The turn is the
 * conversation, the work is a job's: it answers from what is already
 * known, asks what a request needs answered first, may run a lookup the
 * deployment grants to orient, and starts or continues jobs DETACHED
 * (job/start, job/continue), whose `run.end` goes to the turn's own
 * callback.
 *
 * Generic: it knows no host. A host adds its tools and a prompt section
 * through `createStrut({ orchestrator: { tools, system } })` — the same
 * delta `job` takes, appended the same way — and the bundled server reads
 * it from the file `STRUT_HOST_CONFIG` names (src/server.ts). Peel is the
 * first host: it adds sphinx/*, calendar/* and its automation steps.
 */
export type OrchestratorSeedOptions = JobSeedOptions;

export const ORCHESTRATOR_WORKFLOW = "orchestrator";
export const ORCHESTRATOR_CATEGORY = "orchestrator";

/** The description `list_workflows` / the sidebar show for it. */
export const ORCHESTRATOR_DESCRIPTION =
  "A conversation turn: an agent with no coding tools that remembers the conversation (agent with session: {{ input.session }}), answers from what is already known, asks what a request needs answered first, and starts or continues JOBS detached for anything to be found out or made (job/start, job/continue) — the job's run.end goes to this turn's callback. The kinds of work a job can do here (the Job Concept's children) close its prompt. " +
  "Launch it once per message — POST /workflows/orchestrator/run { input: { prompt, session }, callback }; without a session it is a one-shot. " +
  "Input: { prompt, session? (the conversation's thread), context?: { line } (put before the prompt: the time, the person's time zone) }. " +
  "Output: { text, artifacts, ask?: { message }, cost, session }, job's shape. " +
  "params.tools (memory/*, job/start, continue, list, get, read, strut/list-peers, strut/run-workflow) and params.system are the evolvable surface; the host adds its own through createStrut({ orchestrator }).";

const ORCHESTRATOR_YAML = new URL("./workflows/orchestrator.yaml", import.meta.url);

/** The `orchestrator` template with the host's delta applied. */
export async function orchestratorWorkflowYaml(opts?: OrchestratorSeedOptions): Promise<string> {
  return templateWithDelta(ORCHESTRATOR_YAML, opts);
}

/** Seed `orchestrator` into the workspace: the boot step `createStrut` runs. */
export async function seedOrchestratorWorkflow(workspace: WorkspaceStore, opts?: OrchestratorSeedOptions): Promise<{ version: string; changed: boolean }> {
  const text = await orchestratorWorkflowYaml(opts);
  return workspace.publishWorkflowByContent(ORCHESTRATOR_WORKFLOW, text, ORCHESTRATOR_DESCRIPTION, ORCHESTRATOR_CATEGORY, undefined, { reactivateKnown: false, source: "seed" });
}
