import { defineStep } from "../../../core.js";
import { z } from "zod";
import { approvedOnce, cardGrant, find, idInput, requireAutomations, unwrap } from "./_shared.js";

/** Delete an automation for good, once the person allows it. On a host
 *  that takes grants the card names the automation, so the host lets go of
 *  what it allowed it. */
export default defineStep({
  type: "automation/delete",
  description: "Delete an automation for good. The person is asked first. To stop it for a while, pause it with automation/update { enabled: false }.",
  input: idInput,
  output: z.any(),
  async run(cfg, ctx) {
    const cap = requireAutomations(ctx.services);
    const current = await find(cap, cfg.id);
    return approvedOnce(ctx, cap, { action: `Delete “${current.name}”`, details: [`Runs: ${current.summary}`] }, async () => {
      unwrap(await cap.api.remove(cap.workflow, current.id));
      return { deleted: { id: current.id, name: current.name } };
    }, cardGrant(cap, undefined, current.id, current.name));
  },
});
