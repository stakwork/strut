import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { channelDoor } from "./_shared.js";

/**
 * What came to an app's channel (plans/app-channels.md §5), for code the app
 * runs — an AI player's agent reading the room, a referee waiting for the
 * next move. Without `since`, everything the channel keeps (every sender's
 * states and the recent events); with it, what came after, waiting up to
 * `wait` ms while there is nothing new. `members` is who has it open.
 */
export default defineStep({
  type: "channel/read",
  description:
    "Read a channel of the app this code runs for (only with ctx.app). Without `since`: every sender's current state and the recent events; with `since` (the last answer's cursor): what came after, " +
    "waiting up to `wait` ms (at most 55 000) while nothing new. Returns { cursor, reset?, more?, messages, members } — each message stamped by strut ({ from: { actor?, client? | code? }, key?, data, at }), members who has the channel open.",
  input: z.object({
    channel: z.string().describe("The channel's name."),
    since: z.string().optional().describe("The cursor of the last read: only what came after."),
    wait: z.number().int().min(0).max(55_000).optional().describe("Hold up to this many ms while there is nothing new."),
    limit: z.number().int().min(1).optional().describe("At most this many messages; `more` when there are others."),
  }),
  output: z.object({
    cursor: z.string(),
    reset: z.literal(true).optional(),
    more: z.literal(true).optional(),
    messages: z.array(z.any()),
    members: z.array(z.object({ actor: z.string().optional(), client: z.string(), since: z.number() })),
  }),
  effect: "read",
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { app, channels } = channelDoor("channel/read", ctx);
    return channels.read(app, cfg.channel, {
      ...(cfg.since !== undefined ? { since: cfg.since } : {}),
      ...(cfg.wait !== undefined ? { wait: cfg.wait } : {}),
      ...(cfg.limit !== undefined ? { limit: cfg.limit } : {}),
    });
  },
});
