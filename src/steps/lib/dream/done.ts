import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { advanceState, dataDirOf } from "./_state.js";

export default defineStep({
  type: "dream/done",
  effect: "write",
  // The dream's own bookkeeping, beside dream/turns.
  sealed: true,
  description:
    "Mark conversation turns as read by the dream: `cursor` is what dream/turns returned. The next dream/turns starts after them. A mark only moves forward. " +
    "Call it once the turns are dealt with; a dream that fails before it reads them again.",
  input: z.object({
    tree: z.string().optional().default("Personal").describe("The tree whose dream read them, as dream/turns was given it."),
    cursor: z.record(z.string(), z.number().int().nonnegative()).describe("Conversation id → the last turn read, as dream/turns gave it."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const state = await advanceState(dataDirOf(ctx, "dream/done"), cfg.tree, cfg.cursor, new Date());
    return { conversations: Object.keys(cfg.cursor).length, at: state.at };
  },
});
