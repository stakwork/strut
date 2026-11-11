import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { OUTCOMES, isCorrection } from "../../../graph/concept-claims.js";
import { claimGraph, writerOf } from "./_graph.js";

/**
 * Writes what a dream's sorting decided (plans/dream.md): each moment as evidence on the claim it belongs to, or
 * on a new one about the Concept it belongs on. The model said which; this checks it against the tree and writes.
 * A decision naming a claim or a Concept that is not this tree's is not written.
 */
export default defineStep({
  type: "dream/record",
  effect: "write",
  description:
    "Write a dream's sorting: for each decision { i, claim? | text + concept, title?, outcome, denies?, why? } the moment `i` (of dream/candidates' items) becomes evidence " +
    "on the existing claim `claim`, or on a new claim `text` about the Concept `concept` (a ref_id of the tree; the root when left out). " +
    "Returns { recorded, touched: [claim ids], records: [{ i, claim, created, recorded, outcome, check? }], skipped: [{ i, why }] }. " +
    "A correction whose moment carries a `prompt` (a request that stands on its own) gives its claim a check, when the claim has none: `check` is its id. " +
    "A claim or Concept that is not this tree's is skipped, never guessed. The same moment recorded twice writes nothing.",
  input: z.object({
    root: z.string().optional().default("Personal"),
    items: z.array(z.any()).optional().default([]).describe("The moments, as dream/candidates returned them."),
    decisions: z.array(z.any()).optional().default([]).describe("The sorting: one per moment."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/record: this run may not read "${namespace}"`);
    const { listClaims, treeConcepts, recordSaid, writeCheck } = await import("../../../graph/concept-claims.js");
    const known = new Set((await listClaims(g, namespace, cfg.root)).map((c) => c.id));
    const concepts = await treeConcepts(g, namespace, cfg.root);
    const rootRef = concepts[0]?.ref_id;
    const inTree = new Set(concepts.map((p) => p.ref_id));
    const by = writerOf(ctx, cfg.created_by);
    const records: any[] = [];
    const skipped: any[] = [];
    const touched: string[] = [];
    for (const d of cfg.decisions) {
      const it = cfg.items.find((x: any) => x.i === d?.i);
      if (!it) {
        skipped.push({ i: d?.i, why: "no such moment" });
        continue;
      }
      if (!(OUTCOMES as readonly string[]).includes(d.outcome)) {
        skipped.push({ i: it.i, why: `"${String(d.outcome)}" is not an outcome` });
        continue;
      }
      const existing = typeof d.claim === "string" && known.has(d.claim) ? d.claim : undefined;
      if (typeof d.claim === "string" && d.claim && !existing && !d.text) {
        skipped.push({ i: it.i, why: `no claim "${d.claim}" in this tree` });
        continue;
      }
      const concept = typeof d.concept === "string" && inTree.has(d.concept) ? d.concept : rootRef;
      if (!existing && (!d.text || !concept)) {
        skipped.push({ i: it.i, why: "a new claim needs its sentence, and the tree a root" });
        continue;
      }
      const at = Date.parse(it.at);
      try {
        const w = await recordSaid(g, {
          ...(existing ? { claim: existing } : { text: String(d.text), ...(d.title ? { title: String(d.title) } : {}), about: concept! }),
          source: "conversation", session: it.session, turn: it.turn, ...(it.run ? { run: it.run } : {}), ...(it.said_by ? { said_by: it.said_by } : {}),
          excerpt: it.excerpt, ...(d.why ? { why: String(d.why) } : {}), ...(d.denies === true ? { denies: true } : {}), ...(it.lasting ? { lasting: true } : {}),
          outcome: d.outcome, observed_at: Number.isFinite(at) ? at : Date.now(), ...(ctx?.runId ? { dream: ctx.runId } : {}),
          namespace, ...(by ? { created_by: by } : {}),
        });
        known.add(w.claim);
        if (!touched.includes(w.claim)) touched.push(w.claim);
        // A correction is what a check is written from: the request that led to it, asked again. One check a claim.
        const check = isCorrection(d.outcome) && typeof it.prompt === "string" && it.prompt.trim()
          ? await writeCheck(g, { claim: w.claim, prompt: it.prompt, namespace, ...(by ? { created_by: by } : {}) })
          : null;
        records.push({ i: it.i, claim: w.claim, created: w.created, recorded: w.recorded, outcome: d.outcome, ...(check ? { check } : {}) });
      } catch (e) {
        skipped.push({ i: it.i, why: e instanceof Error ? e.message : String(e) });
      }
    }
    return { recorded: records.filter((r) => r.recorded).length, touched, records, skipped };
  },
});
