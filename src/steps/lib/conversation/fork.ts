import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { EVERYONE_DESCRIPTION, requireConversations } from "./_shared.js";

export default defineStep({
  type: "conversation/fork",
  effect: "write",
  description:
    "A new conversation that starts where this one is: its messages copied, so the assistant remembers everything said so far, and its turns shown above. " +
    "The person's alone, under their id. Returns its row (`id` is the new session). `everyone`: an admin forks anyone's, to continue it as their own.",
  input: z.object({
    session: z.string().describe("The conversation to fork."),
    id: z.string().optional().describe("The new session's id (default `<you>/<random>`)."),
    everyone: z.boolean().optional().describe(EVERYONE_DESCRIPTION),
  }),
  output: z.any(),
  async run({ everyone, ...q }, ctx: StepContext) {
    const { conversations, viewer } = requireConversations(ctx, { type: "conversation/fork", everyone: !!everyone });
    return conversations.fork(q, viewer);
  },
});
