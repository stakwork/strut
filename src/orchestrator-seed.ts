import type { WorkspaceStore } from "./workspace.js";
import { templateWithDelta, type JobSeedOptions } from "./job-seed.js";
import { idProblem } from "./session-store.js";

/**
 * The `orchestrator` workflow — a workflow strut ships, seeded at
 * boot exactly as `job` is (src/job-seed.ts: content-hash publish,
 * `source: "seed"`, always the committed template, one seeder per name). One
 * turn of a long conversation: `job/dir` (no job → the run's artifact
 * folder) → `context/concept` (the `Job` Concept's children — the kinds
 * of work a job can do here, the kinds alone — for the end of the prompt)
 * → `agent` on the caller's `session` (one per conversation, compacted in
 * place, its prompt its first turn's), no built-ins, strut's job steps as
 * tools → `pack` in job's reply shape. No memory: a host that keeps one per
 * person grants memory/* itself. The turn is the
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
  "params.tools (job/start, continue, list, get, read, strut/list-peers, strut/run-workflow) and params.system are the evolvable surface; the host adds its own through createStrut({ orchestrator }).";

const ORCHESTRATOR_YAML = new URL("./workflows/orchestrator.yaml", import.meta.url);

/** The `orchestrator` template with the host's delta applied. */
export async function orchestratorWorkflowYaml(opts?: OrchestratorSeedOptions): Promise<string> {
  return templateWithDelta(ORCHESTRATOR_YAML, opts);
}

/**
 * The host section a PERSON's own strut appends to the orchestrator — a
 * laptop's, the desktop app's (plans/chained-orchestrators.md §1, item 4).
 * There the peers are the person's ORGS, one record per org, that org's
 * central strut, and a turn decides only where a request belongs: this
 * machine, or which org. An org's request goes to that org's own
 * orchestrator on this conversation's thread with it
 * (`<person>/<conversation>`: a session the org opens as the person's own
 * for their credential — one thread per LOCAL conversation on each org it
 * talks to, beside the ones the person's host there keeps, never one
 * shared by every conversation; the desktop app names the conversation in
 * each turn's `context.line`, since this section is static text) with
 * `room: true`, so what its jobs
 * deliver later reaches the person's room there; its reply is relayed,
 * never retold. `person` is the person's actor id as the orgs know it —
 * the `sub` of the tokens the pairing got. The desktop app writes the text
 * as `STRUT_HOST_CONFIG`'s `orchestrator.system` (or passes it to
 * `createStrut({ orchestrator: { system } })`).
 */
export function personalOrchestratorSystem(person: string): string {
  const problem = idProblem(person);
  if (problem) throw new Error(`person "${person}" ${problem}: it is the first segment of a session id`);
  return `This strut is on the person's own machine. Its peers are the person's ORGS: each one is an org's own strut (strut/list-peers names them and what each holds), with that org's assistant, its jobs, people, workflows and code. Jobs here run on this machine, against the person's own files and checkouts. What you remember is the person's own, across their orgs; each org's assistant keeps its own.

So the first thing a request needs is WHERE it belongs. Work on this machine — the person's own files, checkouts and notes — is yours, as above. Anything about an org — its work, its people, its workflows or apps, its code — belongs to that org: hand the message to its assistant, strut/run-workflow { peer: <org>, workflow: "orchestrator", input: { prompt, session: "${person}/<conversation>" }, room: true }. The prompt is the person's message, with what you know that it needs; the session is THIS conversation's thread with that org — \`<conversation>\` is the conversation id named at the start of the turn's message — so its assistant remembers what this conversation said to it, and nothing another conversation said. When the person names an org (\`@<org>\`, or its label or what it holds, as the turn's message lists them), that is the org; when you cannot tell which org, ask which, naming the ones there are.

Relay the org's answer: its \`text\` is your \`text\`, word for word; its \`ask\` is your \`ask\`; its \`artifacts\` are your \`artifacts\`, as they came. Never retell it. What its jobs deliver later reaches the person on its own; do not wait for it or check on it.
`;
}

/** Seed `orchestrator` into the workspace: the boot step `createStrut` runs. */
export async function seedOrchestratorWorkflow(workspace: WorkspaceStore, opts?: OrchestratorSeedOptions): Promise<{ version: string; changed: boolean }> {
  const text = await orchestratorWorkflowYaml(opts);
  return workspace.publishWorkflowByContent(ORCHESTRATOR_WORKFLOW, text, ORCHESTRATOR_DESCRIPTION, ORCHESTRATOR_CATEGORY, undefined, { source: "seed" });
}
