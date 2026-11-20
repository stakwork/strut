import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { staffCall, seg } from "./_door.js";

/** `staff/send-round`: Send a round, from Workers. */
export default defineStep({
  type: "staff/send-round",
  effect: "write",
  description:
    "Send a round of a ROUND type (POST /tasks/types/:name/round): its workflow is launched as the admin, with input — the items ticked, under the input's name staff/round-items gives ({ shops: [ … ] }) — or with none, its defaults sending every item. Its human step makes one task for each item. " +
    "Answers { runId, workflow }. Only strut's own staff app, shown to an admin.",
  input: z.object({
    type: z.string().min(1),
    input: z.record(z.string(), z.any()).optional().describe("The round's input: the items to send under the input's name; left out, every item."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return staffCall(ctx, "staff/send-round", "POST", `/tasks/types/${seg(cfg.type)}/round`, cfg.input ? { input: cfg.input } : {});
  },
});
