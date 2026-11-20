import { z } from "zod";
import type { StrutCapabilities } from "../../../capabilities.js";
import { defineStep, type StepContext } from "../../../core.js";

/**
 * The apply of a proposal to change Concept pages whose text comes from git
 * (plans/concept-evals.md item e, rulings 6 and 7; src/concept-sources.ts):
 * the pages' files written into their CHECKOUT — strut's own (dev mode,
 * `STRUT_DEV_CONCEPTS=1`) or a package opened here as a repo — in the form
 * their seeder or install reads, then reloaded from there. A merge and the
 * dream make these proposals; nothing calls the step directly: it runs ONLY
 * as a proposal a person accepted (`ctx.proposal`), and the door behind it
 * (`ctx.services.conceptSources.write`) checks the accepted record on disk
 * for this very input, so a forged context writes nothing. An ADMIN's yes
 * (`approver: "admin"`): it writes files on this strut's machine.
 */
export default defineStep({
  type: "knowledge/write-pages",
  effect: "write",
  sealed: true,
  approver: "admin",
  description:
    "Write Concept pages whose text comes from git into the checkout they come from — strut's own (dev mode) or a package opened here as a repo — and reload them from there. " +
    "Runs only as a proposal a person accepted: a merge of a Concept branch and the dream propose it; a direct call is refused.",
  input: z.object({
    checkout: z.string().min(1).describe("`strut` (strut's own pages, dev mode) or the package, `publisher/name`, opened here as a repo."),
    pages: z
      .array(
        z.object({
          name: z.string().min(1),
          set: z.string().min(1).describe("The set the page is stamped from, by its prefix."),
          file: z.string().min(1).describe("Its file in that set."),
          text: z.string().optional().describe("The page as it should be (a page file); absent: the page is removed."),
        }),
      )
      .min(1),
    cause: z.string().describe("What made the change: a merge, a dream's run."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) {
      throw new Error(
        "knowledge/write-pages runs only as a proposal a person accepted: it writes files into a checkout on this strut's machine, and a person decides that. " +
          "A merge of a Concept branch and the dream propose it.",
      );
    }
    const sources = ctx.services?.conceptSources;
    if (!sources) throw new Error("knowledge/write-pages needs ctx.services.conceptSources: a graph workspace on the standard strut server");
    return sources.write(cfg, { proposal: ctx.proposal.id, ...(ctx.actor ? { actor: ctx.actor } : {}) });
  },
});
