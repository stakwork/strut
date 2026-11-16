import { NOT_ATTRIBUTES, renderConceptPage } from "../../../concept-seed.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { defineStep, workflowOf, type StepContext } from "../../../core.js";
import editNode from "../graph/edit-node.js";
import { proposerOf, requireTree } from "./_shared.js";

/**
 * The dream's way to CHANGE a page of the tree it tends: `graph/edit-node`
 * (the same input, so a person reviewing the tree sees the same change),
 * with the rule for a page whose text comes from git (plans/concept-evals.md
 * item e, rulings 5 and 8: src/concept-sources.ts). Such a page is never
 * changed in the graph: where strut has a checkout for it the change becomes
 * a `knowledge/write-pages` proposal that writes its file there, and
 * elsewhere it is skipped; the answer says which. The rule holds whatever
 * the review says: a gated call on such a page is answered the same way
 * (`answerGated`), never proposed as an edit of the graph. On a Concept
 * branch every page is a copy and ordinary: the merge applies the rule.
 */
type Cfg = Parameters<typeof editNode.run>[0];

/** The answer for a page from git, or undefined for an ordinary page. */
async function fromGit(cfg: Cfg, ctx: StepContext<StrutCapabilities>): Promise<Record<string, unknown> | undefined> {
  const sources = ctx.services?.conceptSources;
  if (ctx.branch || !sources || cfg.node_type || cfg.type_to_be_deleted?.length) return undefined;
  const source = await sources.fromGitByRef(cfg.ref_id);
  if (!source) return undefined;
  const now = await sources.pageOf(source.name);
  if (!now) return undefined;
  const at = `${source.set}${source.file}`;
  const skipped = (why: string) => ({
    status: "skipped",
    page: source.name,
    source: at,
    note: `Nothing changed: the text of ${source.name} comes from git (${at}), and ${why}. Say so in the lesson's change, and do not change this page another way.`,
  });
  if (typeof cfg.node_data?.["name"] === "string" && cfg.node_data["name"] !== source.name) return skipped("a page from git keeps its name");
  // The page as it would read with the edit: what its file is to hold.
  const attributes: Record<string, unknown> = { ...now.page.attributes };
  let docs = now.page.docs;
  for (const [k, v] of Object.entries(cfg.node_data ?? {})) {
    if (k === "docs") docs = typeof v === "string" && v.trim() ? v.trim() : undefined;
    else if (NOT_ATTRIBUTES.has(k)) continue;
    else if (v === null || v === undefined || v === "") delete attributes[k];
    else attributes[k] = v;
  }
  for (const k of cfg.properties_to_be_deleted ?? []) {
    if (k === "docs") docs = undefined;
    else delete attributes[k];
  }
  const text = renderConceptPage({ name: source.name, attributes, parents: now.page.parents, ...(docs ? { docs } : {}) });
  if (text === now.text) return { status: "unchanged", page: source.name, note: "The page already reads so: nothing to change." };
  const made = await sources.propose([{ source, text }], { by: proposerOf(ctx), cause: `${workflowOf(ctx) || "a"} run ${ctx.proposal?.by.runId ?? ctx.runId}` });
  const proposed = made.proposed[0];
  if (proposed) {
    return {
      status: "pending",
      proposal: proposed.proposal,
      url: proposed.url,
      checkout: proposed.checkout,
      page: source.name,
      note: `The text of ${source.name} comes from git (${at}): the change was not made in the graph. It waits for a person's yes as a proposal that writes the page's file into ${proposed.checkout === "strut" ? "strut's checkout" : `the repo of ${proposed.checkout}`}. Say so in the lesson's change; do not make the same call again.`,
    };
  }
  return skipped(made.skipped[0]?.why ?? "this strut has no checkout to write it to");
}

export default defineStep({
  type: "knowledge/edit-page",
  effect: "write",
  // The tree is tended by the workflow that holds the Knowledge door, never in passing (src/sealed.ts).
  sealed: true,
  description:
    "Change ONE page of the tree you tend, by its ref_id (from knowledge_page): `node_data: { docs }` is the WHOLE new text, so copy the page's docs and change only what you mean to; " +
    "`node_data: { description }` is its one line; `properties_to_be_deleted` removes an attribute. " +
    "A page whose text comes from git (one strut or a package ships) is never changed here: where this strut can write its file, the change becomes a proposal a person accepts (`status: pending`), " +
    "otherwise it is skipped (`status: skipped`); either way the answer's `note` says so, and the lesson's change should too.",
  input: editNode.input,
  output: editNode.output,
  ...(editNode.describe ? { describe: editNode.describe } : {}),
  async answerGated(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, "knowledge/edit-page");
    return fromGit(cfg, ctx);
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    requireTree(ctx, "knowledge/edit-page");
    return (await fromGit(cfg, ctx)) ?? editNode.run(cfg, ctx);
  },
});
