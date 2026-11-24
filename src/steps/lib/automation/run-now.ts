import { defineStep } from "../../../core.js";
import { z } from "zod";
import { approvedOnce, cardGrant, find, idInput, requireAutomations, unescaped, unwrap } from "./_shared.js";

/** Run an automation now, off its schedule, once the person allows it. */
export default defineStep({
  type: "automation/run-now",
  description:
    "Run an automation now, off its schedule; its result arrives as its scheduled runs' do. The person is asked first. Refused while its last run is still going.",
  input: idInput,
  output: z.any(),
  async run(cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    const current = await find(cap, cfg.id);
    const prompt = unescaped(String((current.input as { prompt?: unknown }).prompt ?? ""));
    return approvedOnce(ctx, cap, { action: `Run “${current.name}” now`, content: prompt }, async () => {
      // One run, or for a schedule for each person one each.
      const fired = unwrap(await cap.api.fire(cap.workflow, current.id));
      return { started: { id: current.id, name: current.name, ...("runId" in fired ? { runId: fired.runId } : { runIds: fired.runIds }) } };
    }, cardGrant(cap, undefined, current.id, current.name));
  },
});
