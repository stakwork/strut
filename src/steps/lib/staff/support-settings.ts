import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/support-settings` (plans/support-chat.md §5): the welcome. */
export default defineStep({
  type: "staff/support-settings",
  effect: "read",
  description:
    "Support's settings (GET /support/settings): { settings: { welcome, since?, savedAt?, savedBy? } } — the automatic welcome's text (\"\": none is sent) and since when a new contact gets it. Only strut's own staff app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-settings", "GET", "/support/settings");
  },
});
