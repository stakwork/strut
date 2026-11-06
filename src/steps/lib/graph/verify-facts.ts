import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText } from "./_shared.js";
import type { LadybugBackend } from "../../../graph/backend.js";

export default defineStep({
  type: "graph/verify-facts",
  effect: "write",
  description:
    "Check memory's facts against the evidence they should keep producing (plans/memory-truth-layer.md, \"Expectations\"), on a LadybugDB graph. " +
    "For each kind of fact whose edge type `expects` evidence, each current fact due a check runs it — a step given the fact, as the verify pass runs a check — " +
    "and what it finds is kept as evidence: the expected activity there, or missing. A check that cannot see its source, or fails, keeps nothing. " +
    "Then each fact a read would ask about gets one open question, so the agent does not ask it twice; the user's answer closes it. " +
    "Run it on a schedule (an automation); it never changes a fact, only the evidence behind it.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      if (b.kind !== "ladybug") return "graph/verify-facts failed — WRONG_TYPE: facts and their checks are on a LadybugDB graph only";
      const registry = (ctx as StepContext<StrutCapabilities>).registry;
      // Lazy: the runner loads the registry's steps; the pass, the Ladybug claims module.
      const [{ verifyFacts }, { runSingleStep }] = await Promise.all([import("../../../graph/memory-verify.js"), import("../../../run-step.js")]);
      return await verifyFacts(b as LadybugBackend, async (step, input, config) => {
        if (!registry) return { status: "error" };
        const run = await runSingleStep(step, registry, (ctx as StepContext<StrutCapabilities>).services, { input, config, origin: "verify" });
        return { status: run.status, ...(run.output !== undefined ? { output: run.output } : {}) };
      });
    } catch (e) {
      return errText("graph/verify-facts", e);
    }
  },
});
