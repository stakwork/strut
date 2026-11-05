import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireConversations } from "./_shared.js";

export default defineStep({
  type: "conversation/update",
  effect: "write",
  description:
    "Change a conversation: `title` renames it for everyone (`\"\"` gives back its first message), `shared` makes it readable to any person on this strut, " +
    "`archived` and `seen` are the person's own. Returns the person's row for it.",
  input: z.object({
    session: z.string().describe("The conversation's id."),
    title: z.string().optional(),
    archived: z.boolean().optional(),
    seen: z.boolean().optional().describe("true: read it now (unread clears)."),
    shared: z.boolean().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { conversations, viewer } = requireConversations(ctx);
    return conversations.update(cfg, viewer);
  },
});
