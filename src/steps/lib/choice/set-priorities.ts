import { z } from "zod";
import { defineStep } from "../../../core.js";
import { CORNERS, CORNER_NODE, PRESETS, checkGoodMin, checkWeight, type Corner } from "./_fgc.js";
import { backendOf, ensureCorners, writeEdge } from "./_corners.js";

export default defineStep({
  type: "choice/set-priorities",
  description:
    "Write a phase's Fast/Good/Cheap priorities: PRIORITISES { weight 0..1 } edges from a HiveInitiative, HiveMilestone or InitiativeFeature to the workspace Fast/Good/Cheap singletons " +
    "(created when missing), plus an optional good_min (-1..1) on the Good edge. Re-running updates the edge in place. " +
    "Give explicit weights, or name a preset: stage1 'prove it' (Fast 1, Cheap 1, Good 0.3, good_min -0.5), stage2 'reliable' (Good 1, Fast 0.6, Cheap 0.4), stage3 'scale' (Good 1, Cheap 0.8, Fast 0.3). " +
    "No preset is ever applied unless named. A graph write: when an agent calls it, it is a proposal a person approves.",
  input: z.object({
    scope_ref_id: z.string().describe("ref_id of the HiveInitiative / HiveMilestone / InitiativeFeature."),
    preset: z.enum(["stage1", "stage2", "stage3"]).optional(),
    weights: z.object({ fast: z.number().optional(), good: z.number().optional(), cheap: z.number().optional() }).optional(),
    good_min: z.number().optional().describe("Good floor stored on the PRIORITISES edge to Good."),
    namespace: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const preset = cfg.preset ? PRESETS[cfg.preset] : undefined;
    const weights: Partial<Record<Corner, number>> = { ...(preset?.weights ?? {}), ...(cfg.weights ?? {}) };
    const good_min = cfg.good_min ?? preset?.good_min;
    const entries = CORNERS.filter((c) => weights[c] !== undefined);
    if (entries.length === 0) return "choice/set-priorities invalid input — pass a preset or at least one weight";
    for (const c of entries) {
      const e = checkWeight(weights[c], `weights.${c}`);
      if (e) return `choice/set-priorities invalid input — ${e}`;
    }
    const gm = checkGoodMin(good_min);
    if (gm) return `choice/set-priorities invalid input — ${gm}`;
    if (good_min !== undefined && weights.good === undefined) return "choice/set-priorities invalid input — good_min needs a Good weight (it rides on the edge to Good)";
    try {
      const b = await backendOf(ctx);
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      const { refs, created } = await ensureCorners(b, namespace, entries);
      const written: Array<{ corner: string; weight: number; good_min?: number; edge_ref_id: string; created: boolean }> = [];
      for (const c of entries) {
        const edge_data: Record<string, unknown> = { weight: weights[c] };
        if (c === "good" && good_min !== undefined) edge_data.good_min = good_min;
        const e = await writeEdge(b, { edge_type: "PRIORITISES", source_ref_id: cfg.scope_ref_id, target_ref_id: refs[c]!, edge_data, weight: weights[c] });
        written.push({ corner: CORNER_NODE[c].type, weight: weights[c]!, ...(c === "good" && good_min !== undefined ? { good_min } : {}), edge_ref_id: e.ref_id, created: e.created });
      }
      return { status: "Success", preset: cfg.preset ?? null, written, corners_created: created.map((c) => CORNER_NODE[c].type) };
    } catch (e) {
      return `choice/set-priorities failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
