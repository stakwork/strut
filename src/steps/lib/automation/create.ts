import { z } from "zod";
import { defineStep } from "../../../core.js";
import { approvedOnce, automationId, brief, cardGrant, comingFires, grantField, nameField, promptField, requireAutomations, runInput, schedule, triggerSchema, unwrap } from "./_shared.js";

/**
 * Set up an automation on the steps' workflow, once the person allows it
 * (the host's approval step, shown strut's words for the schedule). It
 * reports where the turn that made it does: its fires' `run.end` go to
 * that run's callback. With a `grant` (a host that takes one), the same
 * card shows it under the automation's id, minted here so the card can
 * name it; the id is what the host keeps the grant under, and what each
 * fire's steps read back as `ctx.automation`.
 */
export default defineStep({
  type: "automation/create",
  description:
    "Set up an automation: a prompt run on its own on a schedule, or once for a reminder. The person is asked first and sees the schedule in words; " +
    "nothing exists until they allow it. Returns { created } or, when they have not allowed it, { changed: false, … }.",
  input: z.object({ name: nameField, prompt: promptField, trigger: triggerSchema, grant: grantField }),
  output: z.any(),
  async run(cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    const existing = (await cap.api.list(cap.workflow)).find((a) => a.name.toLowerCase() === cfg.name.toLowerCase());
    if (existing) throw new Error(`An automation named "${existing.name}" exists already (id ${existing.id}): change it with automation/update, or pick another name.`);
    const id = automationId(ctx);
    const grant = cfg.grant && cardGrant(cap, cfg.grant, id, cfg.name);
    const { summary, next } = comingFires(unwrap(cap.api.preview(cfg.trigger)));
    const intent = { action: `Create the automation “${cfg.name}”`, content: cfg.prompt, details: [`Runs: ${schedule(summary, next, cfg.trigger.tz)}`] };
    return approvedOnce(ctx, cap, intent, async () => {
      const callback = await cap.callbackOf(ctx.runId);
      const saved = unwrap(
        await cap.api.create(cap.workflow, { id, name: cfg.name, trigger: cfg.trigger, input: runInput(cfg.name, cfg.prompt), enabled: true, ...(callback ? { callback } : {}) }),
      );
      return { created: brief(saved.automation) };
    }, grant);
  },
});
