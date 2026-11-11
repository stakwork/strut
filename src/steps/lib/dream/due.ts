import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { claimGraph } from "./_graph.js";

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
/** The most of a page a fix is shown, and the most other pages it may choose among. */
const PAGE_MAX = 3000;
const PAGES_MAX = 12;

/**
 * Which claims are due a fix (plans/dream.md), decided by counting, never by a model: a claim, or a group taken
 * together, that has a correction since its last fix AND either was said to last or has been corrected twice.
 * One remark alone is due nothing. Each comes with what was said and the one page it belongs on.
 */
export default defineStep({
  type: "dream/due",
  effect: "read",
  description:
    "The claims of a tree that are due a fix, the most open corrections first: { count, items: [{ claim, title, text, lasting, corrected, open, children, said: [{ excerpt, outcome }], " +
    "page: { ref_id, name, docs, root? }, pages: [{ ref_id, name, description? }] }], text }. Due = at least one correction since its last fix, AND said to last or corrected twice " +
    "(a group's claims counted together; a claim under a group is fixed through its group). `page` is the page the claim is about; `pages` the tree's top pages, for a claim that sits on the root.",
  input: z.object({
    root: z.string().optional().default("Personal"),
    limit: z.number().int().positive().max(20).optional().default(5).describe("Most claims to fix in one dream (default 5)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/due: this run may not read "${namespace}"`);
    const { listClaims, treePages, isCorrection } = await import("../../../graph/concept-claims.js");
    const all = await listClaims(g, namespace, cfg.root);
    const by = new Map(all.map((c) => [c.id, c]));
    const pages = await treePages(g, namespace, cfg.root);
    const top = pages.filter((p) => p.depth === 1).slice(0, PAGES_MAX).map((p) => ({ ref_id: p.ref_id, name: p.name, ...(p.description ? { description: cut(p.description, 160) } : {}) }));
    const due = all
      .filter((c) => !c.parent && c.open > 0 && (c.lasting || c.corrected >= 2))
      .sort((a, b) => b.open - a.open || b.corrected - a.corrected)
      .slice(0, cfg.limit);
    const items = due.map((c) => {
      const kids = (c.children ?? []).map((id) => by.get(id)!).filter(Boolean);
      const said = [...c.evidence, ...kids.flatMap((k) => k.evidence)]
        .filter((e) => isCorrection(e.outcome))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 5)
        .map((e) => ({ excerpt: cut(e.excerpt, 300), outcome: e.outcome }));
      // Where its line is: the page its last fix wrote it on, else the page the claim is about.
      const page = pages.find((p) => p.ref_id === c.fixes[0]?.page) ?? pages.find((p) => p.ref_id === c.about);
      return {
        claim: c.id, title: c.title, text: c.text, lasting: !!c.lasting, corrected: c.corrected, open: c.open, children: kids.map((k) => k.text), said,
        page: page ? { ref_id: page.ref_id, name: page.name, docs: cut(page.docs ?? "", PAGE_MAX), ...(page.depth === 0 ? { root: true } : {}) } : null,
        pages: top,
        fixes: c.fixes.slice(0, 2).map((f) => f.line),
      };
    });
    const text = items
      .map((it) =>
        [
          `CLAIM ${it.claim} "${it.text}"${it.lasting ? " (said to last)" : ""}: corrected ${it.corrected}×, ${it.open} since its last fix`,
          ...(it.children.length ? [`  a group of: ${it.children.map((t: string) => `"${t}"`).join("; ")}`] : []),
          ...it.said.map((s: any) => `  said (${s.outcome}): "${s.excerpt}"`),
          ...(it.fixes.length ? [`  already written for it, and it came back: ${it.fixes.map((l: string) => `"${l}"`).join(" | ")}`] : []),
          it.page?.root || !it.page
            ? `  it sits on the root, which is left alone. Pages it could go on: ${it.pages.map((p: any) => `${p.ref_id} "${p.name}"`).join("; ") || "none yet"}`
            : `  its page ${it.page.ref_id} "${it.page.name}" reads:\n${(it.page.docs || "(empty)").split("\n").map((l: string) => `    | ${l}`).join("\n")}`,
        ].join("\n"),
      )
      .join("\n\n");
    return { count: items.length, items, text };
  },
});
