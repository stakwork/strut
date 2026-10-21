import { z } from "zod";
import { defineStep } from "../../../core.js";
import { CORNERS, SCOPES, checkRatedOn, checkGoodMin, recommend, type Priorities } from "./_fgc.js";
import { backendOf } from "./_corners.js";

const scope = z.record(z.string(), z.union([z.number(), z.object({ weight: z.number().optional(), good_min: z.number().optional() })]));

export default defineStep({
  type: "choice/recommend",
  description:
    "Rank brainstorm Options by Fast/Good/Cheap fit (pure computation; reads the graph only when ref_ids are given, writes nothing). " +
    "total = Σ over fast/good/cheap of weight × the option's score (absolute, -1..1). Weights come from the NEAREST PRIORITISES per corner (feature > milestone > initiative; none → 0). " +
    "Options whose Good score is below good_min (nearest PRIORITISES→Good good_min, else the `good_min` input, else -0.5) are listed but excluded. " +
    "Returns { weights, good_min, ranked: [{ id, total, contributions, excluded, warnings }], recommended, warnings } — the 'only two of three corners > 0.5' check is a warning, never enforced. " +
    "Pass options inline ({ id, rated }) or option_ref_ids (read from their RATED_ON edges); pass priorities inline or feature/milestone/initiative ref_ids (read from their PRIORITISES edges).",
  input: z.object({
    options: z.array(z.object({ id: z.string(), rated: z.record(z.string(), z.number().nullable()).optional() })).optional(),
    option_ref_ids: z.array(z.string()).optional().describe("Options to read from the graph: Option -RATED_ON{score}-> Fast|Good|Cheap."),
    priorities: z.object({ feature: scope.nullish(), milestone: scope.nullish(), initiative: scope.nullish() }).optional(),
    feature_ref_id: z.string().optional(),
    milestone_ref_id: z.string().optional(),
    initiative_ref_id: z.string().optional(),
    good_min: z.number().optional().describe("Fallback Good floor (-1..1) when no PRIORITISES edge carries one. Default -0.5."),
    namespace: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const gm = checkGoodMin(cfg.good_min);
    if (gm) return `choice/recommend invalid input — ${gm}`;
    for (const o of cfg.options ?? []) {
      const e = checkRatedOn(o.rated);
      if (e) return `choice/recommend invalid input — option ${o.id}: ${e}`;
    }
    const options = [...(cfg.options ?? [])];
    const priorities: Priorities = { ...(cfg.priorities ?? {}) } as Priorities;
    const scopeRefs = { feature: cfg.feature_ref_id, milestone: cfg.milestone_ref_id, initiative: cfg.initiative_ref_id };
    const needsGraph = (cfg.option_ref_ids?.length ?? 0) > 0 || Object.values(scopeRefs).some(Boolean);
    if (needsGraph) {
      try {
        const b = await backendOf(ctx);
        const typeOf = new Map<string, string>(); // corner node ref → corner
        const corner = async (ref: string) => {
          if (!typeOf.has(ref)) typeOf.set(ref, ((await b.reader.getNode(ref))?.node_type ?? "").toLowerCase());
          return typeOf.get(ref)!;
        };
        for (const s of SCOPES) {
          const ref = scopeRefs[s];
          if (!ref) continue;
          const { edges } = await b.reader.neighbors(ref, { edge_types: ["PRIORITISES"], direction: "forward", namespace: cfg.namespace });
          const p: Record<string, { weight: number; good_min?: number }> = {};
          for (const e of edges) {
            const c = await corner(e.target);
            if (!(CORNERS as readonly string[]).includes(c)) continue;
            const props = e.properties ?? {};
            const weight = typeof props.weight === "number" ? props.weight : e.weight;
            if (typeof weight === "number") p[c] = { weight, ...(typeof props.good_min === "number" ? { good_min: props.good_min } : {}) };
          }
          priorities[s] = { ...(priorities[s] ?? {}), ...p };
        }
        for (const ref of cfg.option_ref_ids ?? []) {
          const { edges } = await b.reader.neighbors(ref, { edge_types: ["RATED_ON"], direction: "forward", namespace: cfg.namespace });
          const rated: Record<string, number> = {};
          for (const e of edges) {
            const c = await corner(e.target);
            const score = (e.properties ?? {}).score;
            if ((CORNERS as readonly string[]).includes(c) && typeof score === "number") rated[c] = score;
          }
          options.push({ id: ref, rated });
        }
      } catch (e) {
        return `choice/recommend failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return recommend({ options: options as any, priorities, good_min: cfg.good_min });
  },
});
