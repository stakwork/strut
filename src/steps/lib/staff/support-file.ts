import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { seg, staffCall } from "./_door.js";

/** `staff/support-file` (plans/support-chat.md §3): a worker's file. */
export default defineStep({
  type: "staff/support-file",
  effect: "read",
  description:
    "A file a worker sent Support (GET /support/:worker/files/:id), by its message's Sphinx id: { id, name?, mediaType, bytes, base64 }. no_file while it is fetched, or when it was too large (over 25 MB) or deleted. Only strut's own staff app, shown to an admin.",
  input: z.object({ worker: z.string().min(1), id: z.string().min(1) }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/support-file", "GET", `/support/${seg(cfg.worker)}/files/${seg(cfg.id)}`);
  },
});
