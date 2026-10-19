import { z } from "zod";
import { defineStep } from "../../../core.js";
import { approvedOnce, brief, cardGrant, comingFires, find, grantField, nameField, promptField, requireAutomations, runInput, schedule, triggerSchema, unescaped, unwrap } from "./_shared.js";

/** Change an automation's name, prompt, schedule or grant, or pause or
 *  resume it, once the person allows it. The card names the automation,
 *  so a new grant replaces what the host holds under its id, and a change
 *  with none shows what it already may do. */
export default defineStep({
  type: "automation/update",
  description:
    "Change an automation's name, prompt or schedule, or pause (enabled: false) or resume it. Only what you pass changes. The person is asked first. " +
    "Returns { changed } or, when they have not allowed it, { changed: false, … }.",
  input: z.object({
    id: z.string().min(1).describe("The automation's id, from automation/list."),
    name: nameField.optional(),
    prompt: promptField.optional(),
    trigger: triggerSchema.optional(),
    enabled: z.boolean().optional().describe("false pauses it; true resumes it."),
    grant: grantField,
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    const current = await find(cap, cfg.id);
    const grant = cfg.grant && cardGrant(cap, cfg.grant, current.id, cfg.name ?? current.name);
    const details: string[] = [];
    if (cfg.name !== undefined && cfg.name !== current.name) details.push(`Name: “${cfg.name}”`);
    if (cfg.trigger) {
      const { summary, next } = comingFires(unwrap(cap.api.preview(cfg.trigger)));
      details.push(`Runs: ${schedule(summary, next, cfg.trigger.tz)}`);
    }
    if (cfg.name !== undefined && cfg.name.toLowerCase() !== current.name.toLowerCase()) {
      const taken = (await cap.api.list(cap.workflow)).find((a) => a.name.toLowerCase() === cfg.name!.toLowerCase());
      if (taken) throw new Error(`An automation named "${taken.name}" exists already (id ${taken.id}): pick another name.`);
    }
    let action: string;
    if (cfg.enabled === false && current.enabled) action = `Pause “${current.name}”`;
    else if (cfg.enabled === true && !current.enabled) action = `Resume “${current.name}”`;
    else if (details.length || cfg.prompt !== undefined || grant) action = `Change “${current.name}”`;
    else return { changed: false, error: "Nothing to change." };
    // A new prompt is the card's content, shown whole.
    return approvedOnce(ctx, cap, { action, ...(cfg.prompt !== undefined ? { content: cfg.prompt } : {}), details }, async () => {
      const prompt = cfg.prompt ?? unescaped(String((current.input as { prompt?: unknown }).prompt ?? ""));
      const saved = unwrap(
        await cap.api.update(cap.workflow, current.id, {
          ...(cfg.name !== undefined ? { name: cfg.name } : {}),
          ...(cfg.trigger ? { trigger: cfg.trigger } : {}),
          ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
          // The name and prompt travel together in the run's input.
          ...(cfg.name !== undefined || cfg.prompt !== undefined ? { input: runInput(cfg.name ?? current.name, prompt) } : {}),
        }),
      );
      return { changed: brief(saved.automation) };
    }, grant ?? cardGrant(cap, undefined, current.id, cfg.name ?? current.name));
  },
});
