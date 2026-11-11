import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, checkRunner } from "./_shared.js";
import type { LadybugBackend } from "../../../graph/backend.js";
import { stepFailed } from "../../../public-call.js";

export default defineStep({
  type: "graph/verify-facts",
  effect: "write",
  description:
    "Check memory's facts now (plans/memory-checks.md), on a LadybugDB graph: each current fact whose kind has a check and is due it — or every " +
    "one, with `force` — runs the check, and what it finds is kept as evidence. Reads already run checks that are due; this is for running them " +
    "on demand. It never changes a fact, only the evidence behind it.",
  input: z.object({ force: z.boolean().optional().describe("Check every fact with a check, due or not.") }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      if (b.kind !== "ladybug") return stepFailed("graph/verify-facts failed — WRONG_TYPE: facts and their checks are on a LadybugDB graph only");
      const runStep = checkRunner(ctx as StepContext<StrutCapabilities>);
      if (!runStep) return stepFailed("graph/verify-facts failed — it runs checks through the step runner, which this run does not have");
      const { verifyFacts } = await import("../../../graph/memory-checks.js");
      return await verifyFacts(b as LadybugBackend, runStep, { ...(cfg.force ? { force: true } : {}) });
    } catch (e) {
      return errText("graph/verify-facts", e);
    }
  },
});
