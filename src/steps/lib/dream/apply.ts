import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { claimGraph, writerOf } from "./_graph.js";

/** The most page writes one dream makes. */
const EDITS_MAX = 10;
const linesOf = (docs: string) => docs.split("\n");
const same = (a: string, b: string) => a.trim() === b.trim();

interface Change {
  claim: string;
  title: string;
  page: { ref_id?: string; name: string };
  kind: "changed" | "added";
  removed: string[];
  added: string[];
  why?: string;
  /** The proposal that holds it, when changes wait for a person. */
  proposed?: string;
}

/**
 * Makes the page edits a dream's fixing step wrote (plans/dream.md), in code: one line added to, or replaced on,
 * a page of the tree, or a new page under the root. The model wrote the line; this checks the edit is for a
 * claim that is due, on a page it may touch, and that a replaced line is really there, then writes it and notes
 * the fix on the claim. With `review` every edit is a proposal a person decides, and nothing is written.
 */
export default defineStep({
  type: "dream/apply",
  effect: "write",
  description:
    "Apply a dream's fixes: each edit { claim, action: add | replace | add_page | none, page?, old_line?, new_line?, page_name?, first?, why? } for a claim dream/due returned. " +
    "`add` puts `new_line` on `page` (first when `first`); `replace` swaps `old_line`, which must be on the page as written; `add_page` makes a page `page_name` under the root holding `new_line`. " +
    "The root's own text is never edited, a page is never rewritten, and at most 10 edits are made. With `review` each edit is a proposal and nothing is written. " +
    "Returns { changes: [{ claim, title, page: { ref_id, name }, kind, removed, added, why?, proposed? }], skipped: [{ claim, why }] }.",
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
    const { treePages, recordFix } = await import("../../../graph/concept-claims.js");
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
      const pages = await treePages(g, namespace, cfg.root);
      const root = pages[0];
      if (!root) {
        skip(`no tree "${cfg.root}"`);
        continue;
      }
      const note = { claim: it.claim as string, title: String(it.title || it.text), ...(e.why ? { why: String(e.why) } : {}) };
      if (e.action === "add_page") {
        const name = typeof e.page_name === "string" ? e.page_name.trim() : "";
        if (!name || pages.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
          skip(name ? `a page "${name}" is already in the tree: add the line to it` : "a new page needs a name");
          continue;
        }
        if (cfg.review) {
          const p = await proposals!.propose({
            step: "graph/create-triplet", title: `Add page: ${name}`, rationale: `${note.title}: ${line}`, by: who,
            input: { source_ref_id: root.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name, docs: line } },
          });
          changes.push({ ...note, page: { name }, kind: "added", removed: [], added: [line], proposed: p.id });
        } else {
          const node = await g.nodes.write({ type: "Concept", data: { name, docs: line }, ...(by ? { created_by: by } : {}) }, "create", namespace ? { namespace } : {});
          await g.edges.write({ edge: "PARENT_OF", source_ref_id: root.ref_id, target_ref_id: node.ref_id, ...(namespace ? { namespace } : {}), ...(by ? { created_by: by } : {}) });
          await recordFix(g, { claim: it.claim, page: node.ref_id, line, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
          changes.push({ ...note, page: { ref_id: node.ref_id, name }, kind: "added", removed: [], added: [line] });
        }
        made++;
        continue;
      }
      const page = pages.find((p) => p.ref_id === e.page);
      if (!page || page.depth === 0) {
        skip(page ? "the root's own text is left alone" : "not a page of this tree");
        continue;
      }
      const allowed = it.page?.ref_id === page.ref_id || (it.pages ?? []).some((p: any) => p.ref_id === page.ref_id);
      if (!allowed) {
        skip(`"${page.name}" is not a page this claim may be written on`);
        continue;
      }
      const lines = linesOf(page.docs ?? "");
      if (lines.some((l) => same(l, line))) {
        skip("the page already says it");
        continue;
      }
      let removed: string[] = [];
      let next: string[];
      if (e.action === "replace") {
        const at = lines.findIndex((l) => typeof e.old_line === "string" && e.old_line.trim() && same(l, e.old_line));
        if (at < 0) {
          skip("the line to replace is not on the page as written");
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
          step: "graph/edit-node", title: `Edit page: ${page.name}`, rationale: `${note.title}: ${line}`, by: who,
          input: { ref_id: page.ref_id, node_data: { docs } },
        });
        changes.push({ ...note, page: { ref_id: page.ref_id, name: page.name }, kind: "changed", removed, added: [line], proposed: p.id });
      } else {
        await g.nodes.update(page.ref_id, { set: { docs }, remove: [] });
        await recordFix(g, { claim: it.claim, page: page.ref_id, line, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
        changes.push({ ...note, page: { ref_id: page.ref_id, name: page.name }, kind: "changed", removed, added: [line] });
      }
      made++;
    }
    return { changes, skipped };
  },
});
