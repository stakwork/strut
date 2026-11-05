import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CONVERSATION_LIST_MAX } from "../../../conversations.js";
import { requireConversations } from "./_shared.js";

export default defineStep({
  type: "conversation/list",
  effect: "read",
  description:
    "The person's conversations with the assistant, newest first: the ones they took a turn in, the ones under their own id, and the shared ones they opened. " +
    "Each row: id (the session), title, updatedAt, turns, the last turn's status, unread, running, shared, archived. `next` pages on (pass it as `before`). " +
    "`viewer` is the actor the list is for: a new conversation of theirs is `<viewer>/<id>`.",
  input: z.object({
    q: z.string().optional().describe("Every word in the title."),
    archived: z.boolean().optional().describe("The archived ones alone (default: the rest)."),
    limit: z.number().int().positive().max(CONVERSATION_LIST_MAX).optional().describe(`Rows, at most ${CONVERSATION_LIST_MAX} (default 50).`),
    before: z.string().optional().describe("The `next` of the page before."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { conversations, viewer } = requireConversations(ctx);
    // Who the list is for: the namespace a page mints a new conversation in
    // (`<viewer>/…`), which only the server knows.
    const out = await conversations.list(cfg, viewer);
    return viewer.actor ? { ...out, viewer: viewer.actor } : out;
  },
});
