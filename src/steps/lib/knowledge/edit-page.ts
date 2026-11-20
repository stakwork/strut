import type { StrutCapabilities } from "../../../capabilities.js";
import { defineStep, type StepContext } from "../../../core.js";
import editNode from "../graph/edit-node.js";
import { requireTree } from "./_shared.js";

/**
 * The dream's way to CHANGE a page of the tree it tends: `graph/edit-node`
 * itself (the same input, so a person reviewing the tree sees the same
 * change), sealed and refused to a caller that may not read the tree. The
 * rules for a Concept page (`edits`, never the whole docs again; a page from
 * git becomes a proposal or is skipped) are `graph/edit-node`'s, so every
 * writer follows them (graph/_concept-page.ts).
 */
export default defineStep({
  type: "knowledge/edit-page",
  effect: "write",
  // The tree is tended by the workflow that holds the Knowledge door, never in passing (src/sealed.ts).
  sealed: true,
  description:
    "Change ONE page of the tree you tend, by its ref_id (from knowledge_page). Change its docs with `edits`: each quotes the text as it is (`old`, found exactly once) and what it becomes (`new`), so the rest of the page stays as it was; " +
    "a page that already has docs refuses new docs in node_data. `node_data: { description }` is its one line; `properties_to_be_deleted` removes an attribute. " +
    "A page whose text comes from git (one strut or a package ships) is never changed here: where this strut can write its file, the change becomes a proposal a person accepts (`status: pending`), " +
    "otherwise it is skipped (`status: skipped`); either way the answer's `note` says so, and the lesson's change should too.",
  input: editNode.input,
  output: editNode.output,
  ...(editNode.describe ? { describe: editNode.describe } : {}),
  async answerGated(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, "knowledge/edit-page");
    return editNode.answerGated!(cfg, ctx);
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, "knowledge/edit-page");
    return editNode.run(cfg, ctx);
  },
});
