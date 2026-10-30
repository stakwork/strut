import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { INSTALL_IS_A_PERSONS_ACT } from "../../../packages/indexes.js";

/**
 * The store's CONCEPT TREE (plans/marketplace.md §7, the store front): the
 * Concept pages the listed packages carry, folded across every package by
 * the index (`GET /index/concepts[/:name]`), read through
 * `ctx.services.packages.concepts` / `.concept` (src/packages/indexes.ts).
 * One step for the two reads: the tree (or a search of it), or one page.
 */
export default defineStep({
  type: "package/concepts",
  effect: "read",
  description:
    "Browse the CONCEPT TREE of the package store — the knowledge pages packages carry (`concepts/<Name>.md`: a description, a parent, docs), folded across every package the followed indexes list into one tree. " +
    "With no `name`: the entries, each { name, description?, parent?, packages: [{ package, version }], index } — every word of `query` must match a name or description; empty lists the whole tree. " +
    "With `name`: that page — the entry plus `docs` (the first package's text), `children` (the pages naming it as parent) and `parents` (nearest first) — or { error } when no listed package carries it. " +
    "Use it to find which package teaches a subject, and to read a page before using the package that carries it (package/get reads the package). " +
    INSTALL_IS_A_PERSONS_ACT,
  input: z.object({
    query: z.string().optional().describe("Words to match in a page's name or description; omit (or empty) for the whole tree."),
    name: z.string().optional().describe("A Concept page's exact name, for its docs, children and parents."),
    index: z.string().optional().describe("One followed index alone (its id)."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx.services?.packages;
    if (!cap?.concepts || !cap.concept) throw new Error("package/concepts needs strut's package indexes (ctx.services.packages); the standard strut server provides them.");
    const opts = cfg.index ? { index: cfg.index } : {};
    if (cfg.name) {
      const page = await cap.concept(cfg.name, opts);
      return page ?? { error: `concept_not_found: no listed package carries a Concept page named "${cfg.name}"` };
    }
    return cap.concepts(cfg.query ?? "", opts);
  },
});
