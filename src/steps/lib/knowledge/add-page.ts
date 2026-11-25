import type { StrutCapabilities } from "../../../capabilities.js";
import { defineStep, type StepContext } from "../../../core.js";
import createTriplet from "../graph/create-triplet.js";
import { requireTree } from "./_shared.js";

/**
 * The way to ADD a page to the Concept tree — the dream's, which tends it,
 * and since 2026-11-25 the person's assistant's and a job's, each as a
 * proposal the person accepts: `graph/create-triplet`
 * (the same input, so a person reviewing the tree sees the same page under
 * its parent), with the rule for a page whose text comes from git
 * (plans/concept-evals.md item e, src/concept-sources.ts). A new page is
 * ordinary, whatever its parent. But a triplet that names an existing page
 * inline is merged onto it, and one that links an existing page under a
 * parent changes that page's parents: on a page from git, either is refused
 * here, and the answer says to change it with `knowledge/edit-page`, which
 * holds the rule. On a Concept branch every page is ordinary.
 */
type Cfg = Parameters<typeof createTriplet.run>[0];

/** The refusal for a triplet that would change a page from git, or undefined. */
async function touchesGit(cfg: Cfg, ctx: StepContext<StrutCapabilities>): Promise<Record<string, unknown> | undefined> {
  const sources = ctx.services?.conceptSources;
  if (ctx.branch || !sources) return undefined;
  const isConcept = (t: unknown) => typeof t === "string" && t.trim().toLowerCase() === "concept";
  const named = [cfg.source_data, cfg.target_data]
    .map((d, i) => (d && isConcept(i === 0 ? cfg.source_type : cfg.target_type) && typeof d["name"] === "string" ? (d["name"] as string) : undefined))
    .filter((n): n is string => !!n);
  const hit = (await sources.fromGit(named)).values().next().value ?? (cfg.target_ref_id ? await sources.fromGitByRef(cfg.target_ref_id) : null);
  if (!hit) return undefined;
  return {
    status: "refused",
    page: hit.name,
    note: `Nothing written: the text of ${hit.name} comes from git (${hit.set}${hit.file}), and this call would change it. Add a page under a NEW name, or change ${hit.name} with knowledge_edit_page, which says what happens to the change.`,
  };
}

export default defineStep({
  type: "knowledge/add-page",
  effect: "write",
  sealed: true,
  description:
    "Add ONE new page to the Concept tree, under its parent: source_ref_id the parent's (as knowledge_page or graph_graph_get gave it), edge_type PARENT_OF, target_type Concept, target_data { name, description, docs }. " +
    "A new page is yours whatever its parent. A call that would change a page whose text comes from git (naming it, or moving it under another parent) is refused: change such a page with knowledge_edit_page.",
  input: createTriplet.input,
  output: createTriplet.output,
  ...(createTriplet.describe ? { describe: createTriplet.describe } : {}),
  async answerGated(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, "knowledge/add-page");
    return touchesGit(cfg, ctx);
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, "knowledge/add-page");
    return (await touchesGit(cfg, ctx)) ?? createTriplet.run(cfg, ctx);
  },
});
