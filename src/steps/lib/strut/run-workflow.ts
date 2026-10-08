import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { cancelOnPeer, launchOnPeer, tailPeerRun, type PeersCapability } from "../../../peers.js";

const EXAMPLE = `- id: ask
  type: strut/run-workflow
  config:
    peer: acme-web
    workflow: explore
    input:
      question: "{{ input.question }}"`;

/**
 * Dispatch-through (plans/federation.md §2.2): run a workflow on ANOTHER
 * strut — a peer this one has on file (`GET /peers`) — and wait for its
 * result. The run executes there: its secrets, files, artifacts and
 * billing are the peer's, for the forwarded principal. The wait is the
 * peer's SSE tail, reattached after a dropped connection, so the caller
 * only ever needs to reach the peer (a desktop strut behind NAT can call a
 * cloud one). Cancelling this run cancels the peer's.
 */
export default defineStep({
  type: "strut/run-workflow",
  description:
    `Run a workflow on ANOTHER strut (a PEER this one has on file — GET /peers; in a prompt, @<id>) and return its result: { peer, workflow, runId, status, output?, error?, durationMs }. ` +
    `The run executes on the peer, under the peer's secrets and billing for this run's principal (forwarded as x-strut-actor); its files and artifacts stay there (an artifact path in its output is the peer's). ` +
    `Waits on the peer's event stream, reattaching if the connection drops; cancelling this run cancels the peer's. wait: false returns { peer, workflow, runId, status: "running" } at once and leaves the run going. ` +
    `A refused launch fails this step with the peer's message (job_busy:, an unknown workflow); an unknown peer fails peer_unknown:. ` +
    `\`job\` names a job on the PEER to launch under — this run's own job is never forwarded (no shared directory across struts). Nothing returned is thrown: a child that failed is status "error" with its message.\n\n${EXAMPLE}`,
  input: z.object({
    peer: z.string().describe("The peer's id, as GET /peers lists it (hive registers workspaces by slug: @acme-web → acme-web)"),
    workflow: z.string().describe("The workflow to run ON THE PEER (its name there)"),
    input: z.any().optional().describe("The run's input, a JSON object. Use {} if none."),
    params: z
      .record(z.string(), z.any())
      .optional()
      .describe("Overrides for the workflow's `params` knobs on the peer, shallow-merged over its defaults."),
    version: z.string().optional().describe("A specific version on the peer. Defaults to its active version."),
    job: z
      .string()
      .optional()
      .describe("Launch under this JOB on the peer (its files, thread and holds live there). Explicit only — this run's own job is never forwarded."),
    wait: z.boolean().default(true).describe("false → return the handle at once; the peer's run goes on without this step."),
  }),
  output: z.object({
    peer: z.string(),
    workflow: z.string(),
    runId: z.string(),
    status: z.enum(["success", "error", "cancelled", "running"]),
    output: z.any().optional(),
    error: z.object({ message: z.string() }).optional(),
    durationMs: z.number().optional(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities & { peers?: PeersCapability }>) {
    const peers = ctx.services?.peers;
    if (!peers) {
      throw new Error(
        "strut/run-workflow needs the peers capability (ctx.services.peers) — the standard strut server provides it; a bare runWorkflow bag does not",
      );
    }
    const startedAt = Date.now();
    const handle = await launchOnPeer(peers, {
      peer: cfg.peer,
      workflow: cfg.workflow,
      ...(cfg.version ? { version: cfg.version } : {}),
      input: cfg.input ?? {},
      ...(cfg.params ? { params: cfg.params } : {}),
      ...(cfg.job ? { job: cfg.job } : {}),
      // Billed like this run (the principal rule) — exactly what
      // meta/run-workflow forwards within one process.
      ...(ctx.principal ? { actor: ctx.principal } : {}),
    });
    if (!cfg.wait) return { ...handle, status: "running" as const };

    // Cancel: run control is cooperative and the peer's run is one unit, so
    // watch the state while tailing — the exec step's treatment of its
    // child process: tell the peer to cancel, drop the tail, then let
    // checkpoint() raise the canonical CancelledError. Pause is left alone.
    const ac = new AbortController();
    const control = ctx.control;
    let settled = false;
    const watch = control
      ? setInterval(() => {
          if (control.state === "cancelling" && !ac.signal.aborted) {
            void cancelOnPeer(peers, handle);
            ac.abort();
          }
        }, 200)
      : undefined;
    // A run that ends for any other reason while the peer's is still going
    // (this step thrown out by an unreachable peer, a sibling's failure
    // ending the run) takes the peer's run with it.
    ctx.onRunEnd?.(async () => {
      if (!settled) await cancelOnPeer(peers, handle);
    });
    try {
      const result = await tailPeerRun(peers, handle, { signal: ac.signal });
      settled = true;
      return {
        ...handle,
        status: result.status,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: { message: result.error.message } } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      if (ac.signal.aborted && control) {
        settled = true; // the cancel was delivered above
        await control.checkpoint();
      }
      throw err;
    } finally {
      if (watch) clearInterval(watch);
    }
  },
});
