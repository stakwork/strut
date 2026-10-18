import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAutomations, schedule, triggerSchema, unwrap } from "./_shared.js";

/** strut's own words for a schedule and its next fires, saving nothing. */
export default defineStep({
  type: "automation/preview",
  description: "strut's own words for a schedule and its next runs, saving nothing: { summary, next }. Check a schedule with it before proposing one.",
  input: z.object({ trigger: triggerSchema }),
  output: z.object({ summary: z.string(), next: z.array(z.string()) }),
  async run(cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    const { summary, next } = unwrap(cap.api.preview(cfg.trigger));
    return { summary: schedule(summary, next, cfg.trigger.tz), next };
  },
});
