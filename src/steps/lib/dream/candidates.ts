import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { claimGraph } from "./_graph.js";

/** The most moments one dream sorts, and the most candidates each is shown. */
const MOMENTS_MAX = 30;
const CLAIMS_EACH = 5;
const PAGES_EACH = 4;
const LINES_EACH = 3;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * For each moment a dream found, the few claims and pages it could belong to (plans/dream.md): what a model is
 * then shown to sort it, in place of every claim and the whole tree. Code picks them, by the words they share
 * with the moment (`concept-claims.ts` `nearest`) and by the pages the assistant opened in that turn; a model
 * only judges the handful.
 */
export default defineStep({
  type: "dream/candidates",
  effect: "read",
  description:
    "For each moment a dream found ({ session, turn, excerpt, statement, kind, lasting }), the few claims and pages of a tree it could belong to: " +
    "{ count, items: [{ i, session, turn, at, excerpt, statement, kind, lasting, opened, claims: [{ id, title, text, concept, corrected, group? }], pages: [{ ref_id, name, description?, lines, opened? }] }], " +
    "facts, facts_count, text, facts_text }. A moment of kind `fact` goes to `facts`: a fact is memory's, not a page's. A moment whose turn is not among `turns` is dropped. " +
    "`text` is the items as the sorting prompt reads them. Candidates are picked by shared words and by the pages the turn's run opened; nothing here is a decision.",
  input: z.object({
    root: z.string().optional().default("Personal").describe("The tree: its root Concept's name."),
    moments: z.array(z.any()).optional().default([]).describe("What the dream found, as its finding step returned it."),
    turns: z.array(z.any()).optional().default([]).describe("The turns the moments are from, as dream/turns returned them."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/candidates: this run may not read "${namespace}"`);
    const { listClaims, treePages, nearest } = await import("../../../graph/concept-claims.js");
    const claims = await listClaims(g, namespace, cfg.root);
    const pages = await treePages(g, namespace, cfg.root);
    const root = pages[0];
    const items: any[] = [];
    const facts: any[] = [];
    for (const m of cfg.moments.slice(0, MOMENTS_MAX)) {
      const turn = cfg.turns.find((t: any) => t.session === m?.session && t.turn === m?.turn);
      if (!turn || typeof m.statement !== "string" || !m.statement.trim() || typeof m.excerpt !== "string") continue;
      const base = {
        session: turn.session, turn: turn.turn, at: turn.at, run: turn.run, ...(turn.said_by ? { said_by: turn.said_by } : {}),
        excerpt: m.excerpt, statement: m.statement.trim(), kind: m.kind, lasting: m.lasting === true,
      };
      if (m.kind === "fact") {
        facts.push(base);
        continue;
      }
      const opened: string[] = Array.isArray(turn.opened) ? turn.opened : [];
      const near = nearest(base.statement, pages.filter((p) => p.depth > 0), (p) => `${p.name} ${p.description ?? ""} ${p.docs ?? ""}`, PAGES_EACH);
      const wasOpened = pages.filter((p) => p.depth > 0 && opened.includes(p.name));
      const shown = [...new Map([...wasOpened, ...near, ...(root ? [root] : [])].map((p) => [p.ref_id, p])).values()];
      items.push({
        i: items.length, ...base, opened_known: Array.isArray(turn.opened), opened,
        claims: nearest(base.statement, claims, (c) => `${c.title} ${c.text}`, CLAIMS_EACH).map((c) => ({
          id: c.id, title: c.title, text: c.text, concept: c.concept, corrected: c.corrected, ...(c.children ? { group: true } : {}),
        })),
        pages: shown.map((p) => ({
          ref_id: p.ref_id, name: p.name, ...(p.description ? { description: cut(p.description, 200) } : {}),
          lines: p.depth === 0 ? [] : nearest(base.statement, (p.docs ?? "").split("\n").map((l) => l.trim()).filter(Boolean), (l) => l, LINES_EACH).map((l) => cut(l, 300)),
          ...(opened.includes(p.name) ? { opened: true } : {}), ...(p.depth === 0 ? { root: true } : {}),
        })),
      });
    }
    const text = items
      .map((it) =>
        [
          `MOMENT ${it.i} [session ${it.session} · turn ${it.turn}]${it.lasting ? " (said to last)" : ""}`,
          `  said: "${cut(it.excerpt, 400)}"`,
          `  meaning: ${it.statement}`,
          `  pages the assistant opened in that turn: ${it.opened_known ? it.opened.join(", ") || "none" : "not known"}`,
          `  claims it could belong to:${it.claims.length ? "" : " none"}`,
          ...it.claims.map((c: any) => `    - ${c.id} "${c.text}" (on ${c.concept}, corrected ${c.corrected}×${c.group ? ", a group" : ""})`),
          `  pages it could belong on:`,
          ...it.pages.map((p: any) => `    - ${p.ref_id} "${p.name}"${p.root ? " (the root: only when no page fits)" : ""}${p.opened ? " (opened)" : ""}${p.lines.length ? `; nearest lines: ${p.lines.map((l: string) => `"${l}"`).join(" | ")}` : p.root ? "" : "; no line near it"}`),
        ].join("\n"),
      )
      .join("\n\n");
    const factsText = facts.map((f, i) => `FACT ${i} [session ${f.session} · turn ${f.turn}]\n  said: "${cut(f.excerpt, 400)}"\n  meaning: ${f.statement}`).join("\n\n");
    return { count: items.length, items, facts, facts_count: facts.length, text, facts_text: factsText };
  },
});
