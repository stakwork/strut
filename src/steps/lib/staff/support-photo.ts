import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall } from "./_door.js";

/** `staff/support-photo` (plans/support-chat.md §3, item 2): Support's picture. */
export default defineStep({
  type: "staff/support-photo",
  effect: "write",
  description:
    "Set Support's picture (PUT /support/photo), the one workers see on every message from Support: photo { base64, type } (image/jpeg, png, webp or gif, at most 1 MiB); null clears it (DELETE /support/photo). Answers { settings }. Only strut's own staff app, shown to an admin.",
  input: z.object({ photo: z.object({ base64: z.string().min(1), type: z.string().min(1) }).nullable() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return cfg.photo ? staffCall(ctx, "staff/support-photo", "PUT", "/support/photo", cfg.photo) : staffCall(ctx, "staff/support-photo", "DELETE", "/support/photo");
  },
});
