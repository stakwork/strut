import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Ctx, browserOf, timeoutMs } from "./_shared.js";

export default defineStep({
  type: "browser/keydown",
  description:
    "Hold a key DOWN until browser/keyup lets it go — what browser/press cannot do: run right while you jump, hold Shift while you click. One keydown event, as when a person first presses the key (no auto-repeat): a page reading the keys held each frame (a game) sees it held. One key a call (ArrowRight, Space, Shift, a, …); hold two with two calls. No settle afterwards, so the time until the keyup is the hold — e.g. keydown ArrowRight, browser/wait { ms: 500 }, keyup ArrowRight. In a declared list (browser/capture, verify, walkthrough) a key still held when the list ends, or when a step fails, is let go of; here it stays down until its keyup or the page closes. Returns { ok, held }: the keys down now.",
  input: z.object({ key: z.string().describe("one Playwright key name, e.g. ArrowRight, Space, Shift, a — no chord"), timeoutMs }),
  output: z.object({ ok: z.literal(true), held: z.array(z.string()) }),
  async run(cfg, ctx: Ctx) {
    return browserOf(ctx).keydown(ctx.runId, cfg);
  },
});
