import { z } from "zod";
import { defineStep } from "../../../core.js";
import { CORNERS, CORNER_NODE, checkRatedOn } from "./_fgc.js";
import { backendOf, ensureCorners, writeEdge } from "./_corners.js";

export default defineStep({
  type: "choice/rate-option",
  description:
    "Rate a brainstorm Option on Fast/Good/Cheap: writes Option -RATED_ON { score }-> Fast|Good|Cheap, one edge per corner given, each score -1..1 and ABSOLUTE (not relative to other options). " +
    "Corner singletons (fast_id='fast', good_id='good', cheap_id='cheap') are created when missing. Ratings are always read from the Option side. " +
    "A graph write: when an agent calls it, it is a proposal a person approves.",
  input: z.object({
    option_ref_id: z.string(),
    rated_on: z.object({ fast: z.number().optional(), good: z.number().optional(), cheap: z.number().optional() }),
    namespace: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const err = checkRatedOn(cfg.rated_on);
    if (err) return `choice/rate-option invalid input — ${err}`;
    const entries = CORNERS.filter((c) => cfg.rated_on[c] !== undefined);
    if (entries.length === 0) return "choice/rate-option invalid input — rated_on needs at least one of fast, good, cheap";
    try {
      const b = await backendOf(ctx);
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      const { refs, created } = await ensureCorners(b, namespace, entries);
      const written = [];
      for (const c of entries) {
        const score = cfg.rated_on[c]!;
        const e = await writeEdge(b, { edge_type: "RATED_ON", source_ref_id: cfg.option_ref_id, target_ref_id: refs[c]!, edge_data: { score } });
        written.push({ corner: CORNER_NODE[c].type, score, edge_ref_id: e.ref_id, created: e.created });
      }
      return { status: "Success", written, corners_created: created.map((c) => CORNER_NODE[c].type) };
    } catch (e) {
      return `choice/rate-option failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
