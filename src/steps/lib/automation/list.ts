import { z } from "zod";
import { defineStep } from "../../../core.js";
import { brief, requireAutomations } from "./_shared.js";

/** The automations an agent made (its workflow's only), as it reads them. */
export default defineStep({
  type: "automation/list",
  description:
    "Your automations — prompts run on their own on a schedule, or once for a reminder: { automations: [{ id, name, summary (the schedule in words), enabled (false = paused), nextRunAt, lastRun, running, prompt }] }. " +
    "Find one here before changing it.",
  input: z.object({}),
  output: z.object({ automations: z.array(z.any()) }),
  async run(_cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    return { automations: (await cap.api.list(cap.workflow)).map(brief) };
  },
});
