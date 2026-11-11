import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { claimGraph, writerOf } from "./_graph.js";

/** The most Concept writes one dream makes. */
const EDITS_MAX = 10;
const linesOf = (docs: string) => docs.split("\n");
const same = (a: string, b: string) => a.trim() === b.trim();

interface Change {
  claim: string;
  title: string;
  concept: { ref_id?: string; name: string };
  kind: "changed" | "added";
  removed: string[];
  added: string[];
  why?: string;
  /** The proposal that holds it, when changes wait for a person. */
  proposed?: string;
}

/**
 * Makes the Concept edits a dream's fixing step wrote (plans/dream.md), in code: one line added to, or replaced on,
 * a Concept of the tree, or a new Concept under the root. The model wrote the line; this checks the edit is for a
 * claim that is due, on a Concept it may touch, and that a replaced line is really there, then writes it and notes
 * the fix on the claim. With `review` every edit is a proposal a person decides, and nothing is written.
 */
export default defineStep({
  type: "dream/apply",
  effect: "write",
  description:
    "Apply a dream's fixes: each edit { claim, action: add | replace | add_concept | none, concept?, old_line?, new_line?, concept_name?, first?, why? } for a claim dream/due returned. " +
    "`add` puts `new_line` on `concept` (first when `first`); `replace` swaps `old_line`, which must be on the Concept as written; `add_concept` makes a Concept `concept_name` under the root holding `new_line`. " +
    "The root's own text is never edited, a Concept is never rewritten, and at most 10 edits are made. With `review` each edit is a proposal and nothing is written. " +
    "Returns { changes: [{ claim, title, concept: { ref_id, name }, kind, removed, added, why?, proposed? }], skipped: [{ claim, why }] }.",
  input: z.object({
    root: z.string().optional().default("Personal"),
    review: z.boolean().optional().default(false).describe("Every edit waits for a person's yes, as a proposal."),
    items: z.array(z.any()).optional().default([]).describe("The claims that are due, as dream/due returned them."),
    edits: z.array(z.any()).optional().default([]).describe("The edits, one per claim."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/apply: this run may not read "${namespace}"`);
    const { treeConcepts, recordFix } = await import("../../../graph/concept-claims.js");
    const by = writerOf(ctx, cfg.created_by);
    const proposals = (ctx.services as { proposals?: { propose(p: unknown): Promise<{ id: string }> } } | undefined)?.proposals;
    if (cfg.review && !proposals) throw new Error("dream/apply: `review` needs strut's proposals (ctx.services.proposals)");
    const who = { workflow: ctx.workflow ?? "dream", runId: ctx.runId, path: ctx.path };
    const changes: Change[] = [];
    const skipped: Array<{ claim: string; why: string }> = [];
    let made = 0;
    for (const e of cfg.edits) {
      const it = cfg.items.find((x: any) => x.claim === e?.claim);
      const skip = (why: string) => skipped.push({ claim: String(e?.claim ?? ""), why });
      if (!it) {
        skip("not a claim that is due");
        continue;
      }
      if (e.action === "none" || !e.action) {
        skip(e.why ? String(e.why) : "left alone");
        continue;
      }
      const line = typeof e.new_line === "string" ? e.new_line.trim().replace(/\s*\n\s*/g, " ") : "";
      if (!line) {
        skip("no line to write");
        continue;
      }
      if (made >= EDITS_MAX) {
        skip(`the dream's limit of ${EDITS_MAX} edits is reached`);
        continue;
      }
      // The tree as it stands now: an earlier edit of this run is seen.
      const concepts = await treeConcepts(g, namespace, cfg.root);
      const root = concepts[0];
      if (!root) {
        skip(`no tree "${cfg.root}"`);
        continue;
      }
      const note = { claim: it.claim as string, title: String(it.title || it.text), ...(e.why ? { why: String(e.why) } : {}) };
      if (e.action === "add_concept") {
        const name = typeof e.concept_name === "string" ? e.concept_name.trim() : "";
        if (!name || concepts.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
          skip(name ? `a Concept "${name}" is already in the tree: add the line to it` : "a new Concept needs a name");
          continue;
        }
        if (cfg.review) {
          const p = await proposals!.propose({
            step: "graph/create-triplet", title: `Add concept: ${name}`, rationale: `${note.title}: ${line}`, by: who,
            input: { source_ref_id: root.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name, docs: line } },
          });
          changes.push({ ...note, concept: { name }, kind: "added", removed: [], added: [line], proposed: p.id });
        } else {
          const node = await g.nodes.write({ type: "Concept", data: { name, docs: line }, ...(by ? { created_by: by } : {}) }, "create", namespace ? { namespace } : {});
          await g.edges.write({ edge: "PARENT_OF", source_ref_id: root.ref_id, target_ref_id: node.ref_id, ...(namespace ? { namespace } : {}), ...(by ? { created_by: by } : {}) });
          await recordFix(g, { claim: it.claim, concept: node.ref_id, line, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
          changes.push({ ...note, concept: { ref_id: node.ref_id, name }, kind: "added", removed: [], added: [line] });
        }
        made++;
        continue;
      }
      const concept = concepts.find((p) => p.ref_id === e.concept);
      if (!concept || concept.depth === 0) {
        skip(concept ? "the root's own text is left alone" : "not a Concept of this tree");
        continue;
      }
      const allowed = it.concept?.ref_id === concept.ref_id || (it.concepts ?? []).some((p: any) => p.ref_id === concept.ref_id);
      if (!allowed) {
        skip(`"${concept.name}" is not a Concept this claim may be written on`);
        continue;
      }
      const lines = linesOf(concept.docs ?? "");
      if (lines.some((l) => same(l, line))) {
        skip("the Concept already says it");
        continue;
      }
      let removed: string[] = [];
      let next: string[];
      if (e.action === "replace") {
        const at = lines.findIndex((l) => typeof e.old_line === "string" && e.old_line.trim() && same(l, e.old_line));
        if (at < 0) {
          skip("the line to replace is not on the Concept as written");
          continue;
        }
        removed = [lines[at]!.trim()];
        next = [...lines.slice(0, at), ...lines.slice(at + 1)];
        next.splice(e.first ? 0 : at, 0, line);
      } else if (e.action === "add") {
        next = e.first ? [line, ...lines] : [...lines.filter((l, i) => i < lines.length - 1 || l.trim()), line];
      } else {
        skip(`"${String(e.action)}" is not an edit`);
        continue;
      }
      const docs = next.join("\n").replace(/^\n+/, "");
      if (cfg.review) {
        const p = await proposals!.propose({
          step: "graph/edit-node", title: `Edit concept: ${concept.name}`, rationale: `${note.title}: ${line}`, by: who,
          input: { ref_id: concept.ref_id, node_data: { docs } },
        });
        changes.push({ ...note, concept: { ref_id: concept.ref_id, name: concept.name }, kind: "changed", removed, added: [line], proposed: p.id });
      } else {
        await g.nodes.update(concept.ref_id, { set: { docs }, remove: [] });
        await recordFix(g, { claim: it.claim, concept: concept.ref_id, line, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
        changes.push({ ...note, concept: { ref_id: concept.ref_id, name: concept.name }, kind: "changed", removed, added: [line] });
      }
      made++;
    }
    return { changes, skipped };
  },
});
