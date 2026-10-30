import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { INSTALL_IS_A_PERSONS_ACT } from "../../../packages/indexes.js";

/**
 * Packages someone already built (plans/marketplace.md §7, §8): the indexes
 * this strut follows and what its peers have installed, over
 * `ctx.services.packages` (src/packages/indexes.ts). Reads only — installing
 * is a person's yes: package/install proposes one (a card they approve), or
 * they install by name from the Packages dialog. package/get reads a hit's
 * whole page, package/concepts the Concept tree.
 */
export default defineStep({
  type: "package/search",
  effect: "read",
  description:
    "Search for PACKAGES — workflows, steps, apps and Concepts someone already built and published — before writing an integration yourself. " +
    "Every word of `query` must match a package's name, description or publisher. Returns { packages, peers, errors }: " +
    "`packages` from the indexes this strut follows, each { package, publisher, version, digest, description?, license?, requires?, index, detail? } — `detail` is what the release HOLDS, read off its archive: `apps` (each with its title and `can`), the counts of `workflows`, `steps` and `concepts`, the `secrets` it needs, `can: { spends, acts, code }` (whether running it reaches a model call, a step that acts on the world, or code — a reading of its files, not a check) and whether it has a `readme`; package/get reads the whole page. " +
    "`peers` the packages the other struts on file have installed, each { peer, package, version?, digest? }; " +
    "`errors` an index or peer that could not be read. " +
    INSTALL_IS_A_PERSONS_ACT,
  input: z.object({
    query: z.string().describe("Words to match, e.g. \"linear issues\"; empty lists everything."),
    limit: z.number().int().min(1).max(200).default(30),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx.services?.packages;
    if (!cap) throw new Error("package/search needs strut's package indexes (ctx.services.packages); the standard strut server provides them.");
    return cap.search(cfg.query, { limit: cfg.limit });
  },
});
