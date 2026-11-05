import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireConversations } from "./_shared.js";

export default defineStep({
  type: "conversation/fork",
  effect: "write",
  description:
    "A new conversation that starts where this one is: its messages copied, so the assistant remembers everything said so far, and its turns shown above. " +
    "The person's alone, under their id. Returns its row (`id` is the new session).",
  input: z.object({
    session: z.string().describe("The conversation to fork."),
    id: z.string().optional().describe("The new session's id (default `<you>/<random>`)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { conversations, viewer } = requireConversations(ctx);
    return conversations.fork(cfg, viewer);
  },
});
