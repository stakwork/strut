import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CONVERSATION_LIST_MAX } from "../../../conversations.js";
import { EVERYONE_DESCRIPTION, adminPageCall, requireConversations } from "./_shared.js";

export default defineStep({
  type: "conversation/list",
  effect: "read",
  description:
    "The person's conversations with the assistant, newest first: the ones they took a turn in, the ones under their own id, and the shared ones they opened. " +
    "Each row: id (the session), title, updatedAt, turns, the last turn's status, unread, running, shared, archived, startedBy. `next` pages on (pass it as `before`). " +
    "`viewer` is the actor the list is for: a new conversation of theirs is `<viewer>/<id>`. `admin: true` when strut's own page is shown to an admin, who may ask for `everyone`: " +
    "every conversation on this strut, whoever's, archived or not, `q` matching its title, who started it or its host.",
  input: z.object({
    q: z.string().optional().describe("Every word in the title (with `everyone`: in the title, who started it or its host)."),
    archived: z.boolean().optional().describe("The archived ones alone (default: the rest). The person's own: ignored with `everyone`."),
    limit: z.number().int().positive().max(CONVERSATION_LIST_MAX).optional().describe(`Rows, at most ${CONVERSATION_LIST_MAX} (default 50).`),
    before: z.string().optional().describe("The `next` of the page before."),
    everyone: z.boolean().optional().describe(EVERYONE_DESCRIPTION),
  }),
  output: z.any(),
  async run({ everyone, ...q }, ctx: StepContext) {
    const { conversations, viewer } = requireConversations(ctx, { type: "conversation/list", everyone: !!everyone });
    // Who the list is for: the namespace a page mints a new conversation in
    // (`<viewer>/…`), which only the server knows; and whether the page may
    // show its admin everyone's.
    const out = await conversations.list(q, viewer);
    return { ...out, ...(viewer.actor ? { viewer: viewer.actor } : {}), ...(adminPageCall(ctx) ? { admin: true } : {}) };
  },
});
