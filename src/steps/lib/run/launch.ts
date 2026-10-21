import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { requireRuns } from "./_shared.js";

export default defineStep({
  type: "run/launch",
  description:
    "Launch a run of a workflow DETACHED — like POST /workflows/:name/run: returns { runId } at once, never waits. Follow it with run/get { wait } or run/events. " +
    "The actor is the caller (billed as if they pressed Run); from an app the run records origin: \"app\" and the app. " +
    "`params` may narrow what the workflow's agents are granted, never widen it. `job` launches under a job (`title` names it). " +
    "`key` dedupes in flight: a run of this workflow launched under the same key and still running is returned as { runId, existing: true } instead of a second launch — a double click, a re-mounted component, a retried request all land on one run.",
  input: z.object({
    workflow: z.string().describe("The workflow name."),
    input: z.any().optional().describe("The run's input, a JSON object matching the workflow's input: block."),
    params: z.record(z.string(), z.any()).optional().describe("Overrides for the workflow's params knobs — a narrower grant at most."),
    job: z.string().optional().describe("Launch under this job (plans/jobs.md)."),
    title: z.string().optional().describe("With `job`: the job's title."),
    key: z.string().optional().describe("Dedupe key: an in-flight run of this workflow under the same key is returned instead of launching another."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    return requireRuns(ctx.services).launch(cfg, {
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
      ...(ctx.app ? { app: ctx.app } : {}),
      ...(ctx.mcp?.length ? { mcp: ctx.mcp } : {}),
    });
  },
});
