import { z } from "zod";
import { objectFields } from "../../../proposal-card.js";
import type { CardField } from "../../../core.js";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes, namesOf } from "./_shared.js";
import { fromGit, refusal } from "./_concept-page.js";
import { stepFailed } from "../../../public-call.js";
export default defineStep({
  type: "graph/edit-node",
  description:
    "Update an EXISTING node in the knowledge graph by ref_id (writes live to the graph). " +
    "PARTIAL update: properties in node_data are merged over the node's current properties " +
    "(the merged result is validated against the type's schema) — properties you omit are left untouched. " +
    "Use properties_to_be_deleted to remove optional properties entirely (required ones cannot be removed). " +
    "Change part of a long text (a Concept's docs) with `edits`, quoting the text you change, never by sending the whole text again: " +
    "a Concept that already has docs refuses new docs in node_data. " +
    "A Concept whose text comes from git is never changed in the graph: the change becomes a proposal to write its file, or is skipped; the answer's `note` says which. " +
    "Get the ref_id from graph_graph_search, and inspect the node with graph_graph_get first so you know its " +
    "current state before changing it. " +
    "Changing a node's TYPE is not supported (the Strut type set is closed) — create a new node instead. " +
    "If the update would change the node's identity key to collide with another node, the write " +
    "fails with 'Node already exists in the graph'.",
  input: z.object({
    ref_id: z.string().describe("The ref_id of the node to update (from graph_graph_search/graph_graph_get)."),
    node_data: z
      .record(z.string(), z.any())
      .optional()
      .describe('Properties to set/overwrite, e.g. {"description": "..."}. Merged over the node\'s existing properties.'),
    properties_to_be_deleted: z
      .array(z.string())
      .optional()
      .describe("Property names to REMOVE from the node (optional attributes only)."),
    edits: z
      .array(
        z.object({
          property: z.string().optional().describe("The text property to change. Default `docs`."),
          old: z.string().describe("The text as it is now, quoted exactly; it must occur once in the property (quote more around it if it repeats)."),
          new: z.string().describe("What it becomes. To add a line, quote the line before it as `old` and give it again with the new line after it."),
        }),
      )
      .optional()
      .describe("Exact-match changes to the node's text, applied in order: change the lines you mean to and leave the rest as it is."),
    node_type: z
      .string()
      .optional()
      .describe("Not supported by this graph backend — passing it returns an error. Kept for input parity with jarvis/edit-node."),
    type_to_be_deleted: z
      .array(z.string())
      .optional()
      .describe("Not supported by this graph backend. Kept for input parity with jarvis/edit-node."),
    namespace: z
      .string()
      .optional()
      .describe("Namespace (data partition) the node lives in. Not an access-control boundary."),
  }),
  output: z.any(),
  async describe(cfg, ctx) {
    const names = await namesOf(ctx, [cfg.ref_id]);
    const fields: CardField[] = objectFields(cfg.node_data ?? {});
    for (const e of cfg.edits ?? []) fields.push({ label: `Change ${e.property || "docs"}`, value: `${lines("- ", e.old)}\n${lines("+ ", e.new)}`, kind: "code" });
    if (cfg.properties_to_be_deleted?.length) fields.push({ label: "Delete keys", value: cfg.properties_to_be_deleted.join(", "), danger: true });
    return { title: `Edit node ${names.get(cfg.ref_id) ?? cfg.ref_id}`, fields };
  },
  // Under review: an edit that would be refused, or of a page from git, is
  // answered now, never proposed (StepDef.answerGated).
  async answerGated(cfg, ctx) {
    const c = ctx as StepContext<StrutCapabilities>;
    return (await refusal(cfg, c)) ?? fromGit(cfg, c);
  },
  async run(cfg, ctx) {
    const hasSet = cfg.node_data && Object.keys(cfg.node_data).length > 0;
    const hasDelete = cfg.properties_to_be_deleted && cfg.properties_to_be_deleted.length > 0;
    const hasEdits = !!cfg.edits?.length;
    if (cfg.node_type || (cfg.type_to_be_deleted && cfg.type_to_be_deleted.length > 0)) {
      return "graph/edit-node: changing a node's type is not supported by this graph backend (closed Strut type set) — create a new node of the right type instead";
    }
    if (!hasSet && !hasDelete && !hasEdits) {
      return "graph/edit-node invalid input — pass at least one change: node_data (properties to set), edits or properties_to_be_deleted";
    }
    try {
      const c = ctx as StepContext<StrutCapabilities>;
      const own = (await refusal(cfg, c)) ?? (await fromGit(cfg, c));
      if (typeof own === "string") return stepFailed(own);
      if (own !== undefined) return own;
      const b = await graphCtx(c);
      await b.nodes.update(cfg.ref_id, { set: cfg.node_data ?? {}, remove: cfg.properties_to_be_deleted ?? [], ...(hasEdits ? { edits: cfg.edits } : {}) });
      // Compact confirmation — deliberately NOT the full updated node.
      // graph_graph_get to verify.
      return withAccessedNodes(
        {
          status: "Success",
          ref_id: cfg.ref_id,
          ...(hasSet || hasEdits ? { updated: [...new Set([...Object.keys(cfg.node_data ?? {}), ...(cfg.edits ?? []).map((e) => e.property || "docs")])] } : {}),
          ...(hasDelete ? { deleted: cfg.properties_to_be_deleted } : {}),
        },
        await describeNodes(b, [cfg.ref_id]),
      );
    } catch (e) {
      return errText("graph/edit-node", e);
    }
  },
});

/** Each line of `text` behind `mark`, for the card's diff. */
function lines(mark: string, text: string): string {
  return text.split("\n").map((l) => mark + l).join("\n");
}
