import { NOT_ATTRIBUTES, renderConceptPage } from "../../../concept-seed.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { workflowOf, type StepContext } from "../../../core.js";
import { applyTextEdits, type TextEdit } from "../../../graph/text-edits.js";
import { proposerOf } from "../knowledge/_shared.js";
import { graphCtx } from "./_shared.js";

/**
 * The rules every writer of a Concept page follows, whoever calls
 * `graph/edit-node` (the dream through `knowledge/edit-page`, the assistant,
 * an app): plans/dream-memory.md.
 *
 *  - A page's `docs` is changed with `edits`, never by sending the whole
 *    text again: a line the writer failed to copy is lost (`refusal`).
 *  - A page whose text comes from git is never changed in the graph
 *    (plans/concept-evals.md item e, rulings 5 and 8: src/concept-sources.ts).
 *    Where strut has a checkout for it the change becomes a
 *    `knowledge/write-pages` proposal that writes its file there, and
 *    elsewhere it is skipped; the answer says which (`fromGit`). On a Concept
 *    branch every page is a copy and ordinary: the merge applies the rule.
 */
export interface EditCfg {
  ref_id: string;
  node_data?: Record<string, unknown>;
  properties_to_be_deleted?: string[];
  edits?: TextEdit[];
  node_type?: string;
  type_to_be_deleted?: string[];
}

/** Why this edit is refused before it is made or proposed, or undefined. */
export async function refusal(cfg: EditCfg, ctx: StepContext<StrutCapabilities>): Promise<string | undefined> {
  const edits = cfg.edits ?? [];
  const both = edits.map((e) => e.property || "docs").find((p) => cfg.node_data && p in cfg.node_data);
  if (both) return `graph/edit-node: ${both} is in both node_data and edits; change it one way`;
  if (!edits.length && typeof cfg.node_data?.["docs"] !== "string") return undefined;
  const b = await graphCtx(ctx);
  const node = await b.reader.getNode(cfg.ref_id).catch(() => null);
  if (!node) return undefined; // the write names it
  const docs = node.properties["docs"];
  if (node.node_type === "Concept" && typeof cfg.node_data?.["docs"] === "string" && typeof docs === "string" && docs.trim()) {
    return `graph/edit-node: ${node.name ?? cfg.ref_id} already has docs. Change them with \`edits\`, quoting only the lines you change (old) and what they become (new); never send the whole text again.`;
  }
  try {
    if (edits.length) applyTextEdits(node.properties, edits);
  } catch (e) {
    return `graph/edit-node: ${e instanceof Error ? e.message : String(e)}`;
  }
  return undefined;
}

/** The answer for a page from git, or undefined for any other node. */
export async function fromGit(cfg: EditCfg, ctx: StepContext<StrutCapabilities>): Promise<Record<string, unknown> | string | undefined> {
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
  let edited: Record<string, string> = {};
  try {
    if (cfg.edits?.length) edited = applyTextEdits({ ...attributes, docs }, cfg.edits);
  } catch (e) {
    return `graph/edit-node: ${e instanceof Error ? e.message : String(e)}`;
  }
  for (const [k, v] of Object.entries({ ...edited, ...(cfg.node_data ?? {}) })) {
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
