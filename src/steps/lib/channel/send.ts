import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { channelDoor, senderCode } from "./_shared.js";

/**
 * One message to an app's channel (plans/app-channels.md §5), from code the
 * app runs: a referee that sends the board, a workflow that announces the
 * winner, an AI player. Stamped with the code as sender — the workflow's
 * name, or the type of the step the page called — and the actor who set it
 * off. With `key` it is a state, replacing this code's last one of that key;
 * no page can replace it.
 */
export default defineStep({
  type: "channel/send",
  description:
    "Send one message to a channel of the app this code runs for (only with ctx.app: in a step the app's page called, or a workflow the app launched). " +
    "Stamped with the code as sender (the workflow's name, or the step the page called) — `key` makes it a state that replaces this code's last one of that key (a board, a score), no key an event (a move, an announcement). " +
    "Every page in the channel gets it at once; nothing is kept past the channel's last 256 messages.",
  input: z.object({
    channel: z.string().describe("The channel's name, as the app's pages join it (`lobby`, or a name newChannel or channel/derive made)."),
    data: z.any().describe("The message: JSON, at most 8 KB."),
    key: z.string().optional().describe("Makes it a STATE: replaces this code's last message with the same key."),
  }),
  output: z.object({ cursor: z.string() }),
  effect: "write",
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { app, channels } = channelDoor("channel/send", ctx);
    return channels.send(app, { ...(ctx.actor ? { actor: ctx.actor } : {}), code: senderCode(ctx) }, cfg.channel, [
      { data: cfg.data, ...(cfg.key !== undefined ? { key: cfg.key } : {}) },
    ]);
  },
});
