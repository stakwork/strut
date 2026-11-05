import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { derivedChannelName } from "../../../auth.js";

/**
 * A channel name only the app's own code can work out (plans/app-channels.md
 * §6) — what a GATEKEEPER step hands to the players it lets in, after its
 * own rules (a roster, the host's say-so). The same app and scope always give
 * the same name, and nothing is stored, so a page with graph reads finds it
 * nowhere; put an epoch in the scope (`game-7:2`) and move it to shut out
 * someone who had the old name. Refused from a page: a page that could call
 * it could derive any room.
 */
export default defineStep({
  type: "channel/derive",
  description:
    "A channel name only this app's code can work out: HMAC under a key per app, of `scope` — the same scope always the same name, 128 bits, nothing stored. Only with ctx.app, and never from a page directly: " +
    "a gatekeeper step the app grants calls it once its own rules let a player in, and returns the name. Put an epoch in the scope (`game-7:2`) and move it to shut out someone who had the old name.",
  input: z.object({
    scope: z.string().min(1).max(256).describe("What the room is for, as the app's code names it: a game id, plus an epoch to rotate it."),
  }),
  output: z.object({ channel: z.string() }),
  effect: "read",
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.app) {
      throw new Error("channel/derive: a channel is an app's — this step runs in a step the app's page called or a workflow the app launched (ctx.app), never on its own");
    }
    return { channel: derivedChannelName(ctx.app.name, cfg.scope) };
  },
});
