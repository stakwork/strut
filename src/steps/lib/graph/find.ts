import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, workspaceGraph } from "./_shared.js";

const EXAMPLE = `- id: unpaid
  type: graph/find
  config:
    node_type: Invoice
    where:
      status: unpaid
      due: { lt: "{{ today }}" }
    orderBy: due
    limit: 100`;

export default defineStep({
  type: "graph/find",
  description:
    "The nodes of ONE type whose properties match, ordered and paged — a property query, not a search: " +
    "`where` maps a field to a value (equal; null = not set) or to operators, all of which must hold: " +
    "gt, gte, lt, lte (a string or a number), in (a list), contains (a substring of a string field, case-blind). " +
    "Fields are the type's attributes (graph/get-ontology-type lists them), `ref_id` and `date_added_to_graph`. " +
    "`orderBy` names a field (default: newest first), `desc` reverses it; `limit` is 1–500 (default 50), and when there " +
    "are more the result carries a `cursor` to pass back for the next page; `count: true` adds `total`, every match. " +
    "Dates an app declares are ISO strings and compare as text. Returns `{ node_type, nodes: [{ ref_id, node_type, name?, properties }], returned, cursor?, total? }`. " +
    "For words or meaning use graph/graph-search; for one node, graph/graph-get.\n\n" +
    EXAMPLE,
  input: z.object({
    node_type: z.string().describe("The type to read, e.g. 'Invoice'."),
    where: z
      .record(z.string(), z.any())
      .optional()
      .describe("field → value, or field → { gt | gte | lt | lte | in | contains }. All must hold."),
    orderBy: z.string().optional().describe("The field to order by. Default: date_added_to_graph, newest first."),
    desc: z.boolean().optional().describe("Order descending."),
    limit: z.number().int().optional().describe("Nodes per page, 1–500 (default 50)."),
    cursor: z.string().optional().describe("The `cursor` the previous page returned."),
    count: z.boolean().optional().describe("Also count every match (`total`)."),
    namespace: z.string().optional().describe("The data partition to read (default: the workspace's)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = workspaceGraph(await graphCtx(ctx as StepContext<StrutCapabilities>), "graph/find");
      const { findNodes } = await import("../../../graph/find.js");
      // No provenance marker: a list is not what the caller named.
      return await findNodes(b, cfg);
    } catch (e) {
      return errText("graph/find", e);
    }
  },
});
