import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Ctx, browserOf, timeoutMs } from "./_shared.js";

export default defineStep({
  type: "browser/keyup",
  description:
    "Let go of a key browser/keydown holds: one keyup event, no settle afterwards (the time since the keydown is the hold). Returns { ok, held }: the keys still down.",
  input: z.object({ key: z.string().describe("the key browser/keydown holds, e.g. ArrowRight"), timeoutMs }),
  output: z.object({ ok: z.literal(true), held: z.array(z.string()) }),
  async run(cfg, ctx: Ctx) {
    return browserOf(ctx).keyup(ctx.runId, cfg);
  },
});
