import { z } from "zod";
import { defineStep } from "../../../core.js";
import { checkScore, normalizeAgainst } from "./_fgc.js";
import { backendOf, writeEdge } from "./_corners.js";

export default defineStep({
  type: "choice/score-effect",
  description:
    "Give a brainstorm Effect a signed, absolute `score` (-1..1; optional — impact and direction are kept) and/or link it to the Requirements it is AGAINST: Effect -AGAINST-> Requirement. " +
    "A Requirement that does not exist is skipped silently, and named in `skipped` in the result. " +
    "A graph write: when an agent calls it, it is a proposal a person approves.",
  input: z.object({
    effect_ref_id: z.string(),
    score: z.number().optional(),
    against: z.array(z.string()).optional().describe("Requirement ref_ids or requirement_ids."),
    namespace: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const se = checkScore(cfg.score);
    if (se) return `choice/score-effect invalid input — ${se}`;
    const { ids, error } = normalizeAgainst(cfg.against);
    if (error) return `choice/score-effect invalid input — ${error}`;
    if (cfg.score === undefined && ids.length === 0) return "choice/score-effect invalid input — pass a score and/or against";
    try {
      const b = await backendOf(ctx);
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      if (cfg.score !== undefined) await b.nodes.update(cfg.effect_ref_id, { set: { score: cfg.score }, remove: [] });
      const linked: string[] = [];
      const skipped: string[] = [];
      for (const id of ids) {
        const node =
          (await b.reader.getNode(id).catch(() => null)) ??
          (await b.reader.getNodeByKey("Requirement", `requirement-${id}`, namespace).catch(() => null));
        if (!node?.ref_id || (node.node_type && node.node_type !== "Requirement")) {
          skipped.push(id);
          continue;
        }
        await writeEdge(b, { edge_type: "AGAINST", source_ref_id: cfg.effect_ref_id, target_ref_id: node.ref_id });
        linked.push(node.ref_id);
      }
      return {
        status: "Success",
        ...(cfg.score !== undefined ? { score: cfg.score } : {}),
        linked,
        skipped,
        ...(skipped.length ? { note: `Requirement not found, skipped: ${skipped.join(", ")}` } : {}),
      };
    } catch (e) {
      return `choice/score-effect failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
