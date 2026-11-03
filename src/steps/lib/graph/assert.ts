import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes } from "./_shared.js";

const EXAMPLE = `- id: moved
  type: graph/assert
  config:
    source_ref_id: "{{ kate.ref_id }}"
    edge_type: LIVES_IN
    target_ref_id: "{{ lisbon.ref_id }}"
    text: Kate lives in Lisbon
    valid_at: "2026-09"
    source: "{{ message.ref_id }}"`;

export default defineStep({
  type: "graph/assert",
  description:
    "State a FACT between two nodes as a temporal edge: true from `valid_at`, until `invalid_at` (writes live to the graph; a LadybugDB graph only). " +
    "The edge type must be one the ontology marks temporal; graph/create-triplet refuses those. " +
    "Asserting what the graph already holds RE-CONFIRMS it: `source` is added once, a missing date is filled, nothing else changes (the same source again changes nothing). " +
    "On a one-value edge type (cardinality one, e.g. LIVES_IN) a different target ENDS the current edge and creates the new one — unless `valid_at` is before the current one began: " +
    "then the new one is HISTORY, ended when the current one began, and the current one stays. An `invalid_at` already past records something no longer true. " +
    "Dates are ISO ('2026-09-14'), a year-month ('2026-09') or a year ('2026'), only when the words say.\n\n" +
    EXAMPLE,
  input: z.object({
    source_ref_id: z.string().describe("The node the fact is about (its subject)."),
    edge_type: z.string().describe("The temporal relationship type, e.g. 'LIVES_IN' (uppercased)."),
    target_ref_id: z.string().describe("The node it relates the subject to."),
    text: z.string().describe("The fact as one plain sentence, e.g. 'Kate lives in Lisbon'."),
    valid_at: z.string().optional().describe("When it became true, only if known."),
    invalid_at: z.string().optional().describe("When it stopped being true, only if known."),
    source: z.string().optional().describe("ref_id of the node it was learned from (a message, an episode)."),
    namespace: z.string().optional().describe("The edge's namespace (default: its subject's)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      // Lazy, like graphCtx: the graph modules load neo4j-driver (`_shared.ts`).
      const { assertEdge } = await import("../../../graph/temporal.js");
      const edge = cfg.edge_type.toUpperCase().replace(/ /g, "_");
      const r = await assertEdge(b, b.schemas, {
        edge,
        source_ref_id: cfg.source_ref_id,
        target_ref_id: cfg.target_ref_id,
        text: cfg.text,
        ...(cfg.valid_at ? { valid_at: cfg.valid_at } : {}),
        ...(cfg.invalid_at ? { invalid_at: cfg.invalid_at } : {}),
        ...(cfg.source ? { source: cfg.source } : {}),
        ...(cfg.namespace ? { namespace: cfg.namespace } : {}),
        ...(ctx?.actor ? { created_by: ctx.actor } : {}),
      }, { ...(b.embedder ? { embedder: b.embedder } : {}) });
      return withAccessedNodes(
        {
          status: r.action === "unchanged" ? "Warning" : "Success",
          edge_ref_id: r.ref_id,
          edge_type: edge,
          action: r.action,
          ...(r.superseded.length ? { superseded: r.superseded } : {}),
          ...(r.ended ? { ended: true } : {}),
          ...(r.filled ? { filled: r.filled } : {}),
        },
        await describeNodes(b, [cfg.source_ref_id, cfg.target_ref_id]),
      );
    } catch (e) {
      return errText("graph/assert", e);
    }
  },
});
