import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg, pathSegs } from "./_door.js";

/** `staff/test-file` (plans/human-steps.md §9.3): Put one of a test's listed files. */
export default defineStep({
  type: "staff/test-file",
  effect: "write",
  description: "Put one of a test's listed files (PUT /tasks/tests/:id/files/<path>), its bytes as base64; the test is ready, and served, once every listed file is there. Refused once the test was served. Answers { test }. Only strut's own staff app, shown to an admin.",
  input: z.object({ id: z.string().min(1), path: z.string().min(1), base64: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/test-file", "PUT", `/tasks/tests/${seg(cfg.id)}/files/${pathSegs(cfg.path)}`, new Uint8Array(Buffer.from(cfg.base64, "base64")));
  },
});
