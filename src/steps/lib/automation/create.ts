import { z } from "zod";
import { defineStep } from "../../../core.js";
import { approvedOnce, brief, nameField, promptField, requireAutomations, runInput, schedule, triggerSchema, unwrap } from "./_shared.js";

/**
 * Set up an automation on the steps' workflow, once the person allows it
 * (the host's approval step, shown strut's words for the schedule). It
 * reports where the turn that made it does: its fires' `run.end` go to
 * that run's callback.
 */
export default defineStep({
  type: "automation/create",
  description:
    "Set up an automation: a prompt run on its own on a schedule, or once for a reminder. The person is asked first and sees the schedule in words; " +
    "nothing exists until they allow it. Returns { created } or, when they have not allowed it, { changed: false, … }.",
  input: z.object({ name: nameField, prompt: promptField, trigger: triggerSchema }),
  output: z.any(),
  async run(cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    const existing = (await cap.api.list(cap.workflow)).find((a) => a.name.toLowerCase() === cfg.name.toLowerCase());
    if (existing) throw new Error(`An automation named "${existing.name}" exists already (id ${existing.id}): change it with automation/update, or pick another name.`);
    const { summary, next } = unwrap(cap.api.preview(cfg.trigger));
    return approvedOnce(ctx, cap, { action: `Create the automation “${cfg.name}”`, content: cfg.prompt, details: [`Runs: ${schedule(summary, next, cfg.trigger.tz)}`] }, async () => {
      const callback = await cap.callbackOf(ctx.runId);
      const saved = unwrap(
        await cap.api.create(cap.workflow, { name: cfg.name, trigger: cfg.trigger, input: runInput(cfg.name, cfg.prompt), enabled: true, ...(callback ? { callback } : {}) }),
      );
      return { created: brief(saved.automation) };
    });
  },
});
