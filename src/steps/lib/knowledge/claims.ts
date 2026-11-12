import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireKnowledge } from "./_shared.js";

export default defineStep({
  type: "knowledge/claims",
  effect: "read",
  description:
    "Every Concept that carries claims, with them: { concepts: [{ concept, ref_id, claims: [{ id, text, status, speaker, latest }] }] }, by name. " +
    "What a keeper of the tree scans for the rules that do not hold (status refuted or stale) without opening every page; knowledge/page reads one page whole.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext) {
    return { concepts: await requireKnowledge(ctx, "knowledge/claims").claims() };
  },
});
