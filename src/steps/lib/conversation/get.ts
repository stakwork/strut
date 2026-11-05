import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CONVERSATION_TURNS_MAX, CONVERSATION_WAIT_MAX_MS } from "../../../conversations.js";
import { requireConversations } from "./_shared.js";

export default defineStep({
  type: "conversation/get",
  effect: "read",
  description:
    "One conversation's TURNS, newest first: each the person's words (`prompt`) or a wake (`wake`: the job run it woke on), the reply (`text`, `ask`, `artifacts`), " +
    "its `status` (a live state while in flight), the proposals it made and the jobs it started. `next` pages back (pass it as `before`). " +
    `\`wait\` holds the call up to that many ms (at most ${CONVERSATION_WAIT_MAX_MS}) until the conversation changes past \`since\` (the \`rev\` you have) — a turn lands or settles.`,
  input: z.object({
    session: z.string().describe("The conversation's id (its session)."),
    limit: z.number().int().positive().max(CONVERSATION_TURNS_MAX).optional().describe(`Turns, at most ${CONVERSATION_TURNS_MAX} (default 20).`),
    before: z.number().int().nonnegative().optional().describe("Turns before this turn number (`next`)."),
    wait: z.number().int().nonnegative().max(CONVERSATION_WAIT_MAX_MS).optional().describe("Hold up to this many ms until it changes."),
    since: z.number().int().nonnegative().optional().describe("The `rev` you have; default the current one."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { conversations, viewer } = requireConversations(ctx);
    const view = await conversations.get(cfg, viewer);
    if (!view) throw new Error(`No conversation "${cfg.session}" (or not yours to read)`);
    return view;
  },
});
