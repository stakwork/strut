import { z } from "zod";
import { coerceJsonArg, defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { remoteOf, SPENDS_HELD_CREDIT, withCharge } from "./_shared.js";

/**
 * Call a TOOL another strut server sells (plans/paid-runs.md §6, §10):
 * `POST <seller>/public/steps/:type/run { config }`, the credit held there
 * presented. One call, answered when it returns. The seller's door takes
 * no key, so it is never sent again: a call that failed THERE (and was
 * charged) is `failed_charged:`, one whose answer was lost `may_have_run:`
 * — neither says "try again". What the seller charged is this step's cost
 * (`withCharge`). Refused in a stranger's run or a peer's (decision 16).
 */
export default defineStep({
  type: "remote/call",
  effect: "write",
  description:
    "Call a TOOL (a step) another strut server sells to run, with its config, and get its output. " +
    "Find what it sells and each tool's input with remote/list first. Returns { seller, type, output, credit? } — `credit` on a priced call: what was charged and what is left there. " +
    SPENDS_HELD_CREDIT,
  input: z.object({
    url: z.string().describe("The seller: a strut server's base URL, https (what remote/list was given)."),
    type: z.string().min(1).describe("The step type, as remote/list names it."),
    config: z.preprocess(coerceJsonArg, z.record(z.string(), z.unknown())).optional().describe("The step's config, as its `input` schema in remote/list asks."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const out = await remoteOf(ctx, "remote/call").call(cfg.url, cfg.type, cfg.config ?? {}, { ...(ctx.control ? { control: ctx.control } : {}) });
    return withCharge(out, out.credit?.charged_usd);
  },
});
