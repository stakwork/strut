import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { claimGraph } from "./_graph.js";

/** How alike two claims must be, by shared words, to be offered as the same kind. Low: a model decides. */
const NEAR_AT = 0.15;
/** The most claims this dream did not touch that are looked at again for a group. */
const OTHERS_MAX = 12;

/**
 * For each claim a dream touched that is in no group, the few other claims it might be the same kind as
 * (plans/dream.md): what a model is shown to decide a grouping, in place of every claim. A claim already under
 * a group is offered as its group.
 */
export default defineStep({
  type: "dream/neighbours",
  effect: "read",
  description:
    "For each of `claims` (ids) that is in no group, the few other claims of the tree it might be the same kind as: " +
    "{ count, items: [{ claim: { id, text, concept }, near: [{ id, text, concept, group? }] }], text }. A neighbour already under a group is offered as that group. " +
    "The open claims in no group that are not among `claims` are looked at too (up to 12), so an older claim finds a neighbour that came later. " +
    "Picked by shared words; nothing here is a decision. A claim with no neighbour is left out.",
  input: z.object({
    root: z.string().optional().default("Personal"),
    claims: z.array(z.string()).optional().default([]).describe("The claims to find neighbours for: the ones this dream touched."),
    k: z.number().int().positive().max(8).optional().default(4).describe("Most neighbours per claim (default 4)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/neighbours: this run may not read "${namespace}"`);
    const { listClaims, wordsOf, alike } = await import("../../../graph/concept-claims.js");
    const all = await listClaims(g, namespace, cfg.root);
    const by = new Map(all.map((c) => [c.id, c]));
    const words = (c: { title: string; text: string }) => wordsOf(`${c.title} ${c.text}`);
    const items: any[] = [];
    const paired = new Set<string>();
    // The claims this dream touched, then the open ones in no group it did not (the most corrected first, capped):
    // a claim recorded before it had a neighbour is offered again once it has one.
    const others = all.filter((c) => !c.parent && !c.children && c.open > 0 && !cfg.claims.includes(c.id)).slice(0, OTHERS_MAX).map((c) => c.id);
    for (const id of [...cfg.claims, ...others]) {
      const c = by.get(id);
      if (!c || c.parent || c.children) continue;
      const mine = words(c);
      const near = all
        .filter((o) => o.id !== c.id)
        .map((o) => ({ o, s: alike(mine, words(o)) }))
        .filter((r) => r.s >= NEAR_AT)
        .sort((a, b) => b.s - a.s)
        // A claim in a group stands for its group: that is what this one would join.
        .map((r) => (r.o.parent ? by.get(r.o.parent) ?? r.o : r.o))
        .filter((o, i, list) => o.id !== c.id && list.findIndex((x) => x.id === o.id) === i)
        .filter((o) => !paired.has(`${o.id}|${c.id}`))
        .slice(0, cfg.k);
      if (!near.length) continue;
      for (const o of near) paired.add(`${c.id}|${o.id}`);
      items.push({ claim: { id: c.id, text: c.text, concept: c.concept }, near: near.map((o) => ({ id: o.id, text: o.text, concept: o.concept, ...(o.children ? { group: true } : {}) })) });
    }
    const text = items
      .map((it) => [`CLAIM ${it.claim.id} "${it.claim.text}" (on ${it.claim.concept})`, ...it.near.map((o: any) => `  near: ${o.id} "${o.text}" (on ${o.concept}${o.group ? ", a group" : ""})`)].join("\n"))
      .join("\n\n");
    return { count: items.length, items, text };
  },
});
