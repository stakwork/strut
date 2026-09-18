import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireAuthoring } from "./_shared.js";

export default defineStep({
  type: "meta/edit-claim",
  description:
    "Reword a claim. Claims are immutable, so this creates a SUCCESSOR that supersedes it and returns the successor's id: attachments and checks carry over, old evidence stays on the old node, and the successor starts `unknown` until a run is verified again. Publisher-scoped like the rest of meta/*: it acts only on claims and checks stamped 'ai' and on subjects this surface published, and a check may never reach a harness-only step (gaia/*, harvey/*, eval/*, meta/*) — by name, inside a subflow, or granted to an agent.",
  input: z.object({ id: z.string().describe("Claim id (from meta/list-claims)"), text: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    return requireAuthoring(ctx.services).editClaim(cfg.id, cfg.text);
  },
});
