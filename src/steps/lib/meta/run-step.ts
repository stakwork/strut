import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { nameInPackage, nameInsidePackage } from "../../../package-lookup.js";
import { baseType } from "../../../step-ref.js";
import { requireAuthoring } from "./_shared.js";

/** Why `type` may not run here: the agent calling this tool asks a person
 *  before running it (`ctx.gated`, its `approve`), so it is that tool's to
 *  propose. Compared on the bare type (a pin is the same step), named from
 *  the agent's package as its tools are. Null when nothing gates it. */
function gatedRefusal(type: string, ctx: Pick<StepContext, "gated" | "package">): string | null {
  if (!ctx.gated?.size) return null;
  const gated = new Set([...ctx.gated].map(baseType));
  const named = nameInPackage(ctx.package, baseType(type), (t) => gated.has(t));
  if (!gated.has(named)) return null;
  const tool = nameInsidePackage(ctx.package, named).replace(/[^a-zA-Z0-9_]/g, "_");
  return `Nothing was run — "${type}" asks the person before it runs here, so meta/run-step does not run it. Call it as your tool ${tool}: that proposes the call, and it runs when they accept.`;
}

export default defineStep({
  type: "meta/run-step",
  description:
    "Run a SINGLE step in isolation with a given config + input and return its output + events — the inner loop for authoring: meta/create-step → meta/run-step → meta/edit-step → meta/run-step until the output is right. A sealed step (a grader) is refused, and so is a step one of your tools PROPOSES rather than runs: call that tool instead. Set cassette:'record' to run live AND capture the step's external service calls to a reusable fixture (secrets scrubbed); then cassette:'replay' to iterate OFFLINE against it — deterministic, no rate limits, no cost, no side effects. Sees steps published earlier in this same run (the registry is re-read fresh). Returns { runId, status, output?, error?, events, recorded?, kept? } — `kept` is the run-store key when the run was persisted.",
  input: z.object({
    type: z.string().describe("Step type to run, e.g. 'candidates/my-fetcher' or 'http'."),
    config: z
      .record(z.string(), z.any())
      .optional()
      .describe("The step's config (same shape as in a workflow). Templates like {{ input.* }} / {{ params.* }} are resolved."),
    input: z.any().optional().describe("Workflow input object, referenced in config via {{ input.* }}."),
    params: z.record(z.string(), z.any()).optional().describe("Params knobs, referenced via {{ params.* }}."),
    cassette: z
      .enum(["record", "replay"])
      .optional()
      .describe("record: run live + capture external calls to a fixture. replay: serve them from the fixture (offline). Omit for a plain live run."),
    cassetteName: z
      .string()
      .optional()
      .describe("Fixture name (defaults to the step type). Use distinct names to keep multiple scenarios per step."),
    keep: z.boolean().optional().describe('Persist this run under the run-store key `step:<type>` (read it back with list_runs / get_run on that key). Runs of a step that has claims are kept automatically — they can become evidence; set this to keep a run of a step that has none.'),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const refused = gatedRefusal(cfg.type, ctx);
    if (refused) return { error: refused };
    return requireAuthoring(ctx.services).runStep(cfg.type, {
      config: cfg.config,
      input: cfg.input,
      params: cfg.params,
      cassette: cfg.cassette,
      cassetteName: cfg.cassetteName,
      keep: cfg.keep,
      // As this run's own tool call would: under this run, as its person,
      // on its job, so a proposal the step makes shows where theirs do.
      parentRunId: ctx.runId,
      ...(ctx.job ? { job: ctx.job } : {}),
      ...(ctx.budgetJob ? { budgetJob: ctx.budgetJob } : {}),
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
      // A run on a Concept branch runs the step on it (src/branches.ts).
      ...(ctx.branch ? { branch: ctx.branch } : {}),
      // A trial's step run is a trial (src/trials.ts).
      ...(ctx.trial ? { trial: ctx.trial } : {}),
    });
  },
});
