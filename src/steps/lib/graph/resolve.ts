import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText } from "./_shared.js";

export default defineStep({
  type: "graph/resolve",
  description:
    "Find the ONE existing node a thing is, before creating it: give its type and what you know — its key, " +
    "`node_data` as you would write it (its key fields, identifiers such as a Person's email, its name), " +
    "a `name`, or `aliases`. Tries, in order, the key, the type's identifiers, the exact name (case-blind), " +
    "then the node's other names (`alt_names`); the first that finds anything decides. " +
    "Returns `{ node_type, namespaces, match, ambiguous, candidates }`: `match` is the node when exactly one was found " +
    "(`matched_by` says how). When several were found `ambiguous` is true and they are the `candidates` — do not pick " +
    "one by name alone; two people can share a name. When nothing was found, `candidates` are nodes the search ranks " +
    "close (`matched_by: search`); create a new node only if none of them is the thing. " +
    "Reads only `namespaces` (default: the workspace's). A LadybugDB graph only.",
  input: z.object({
    node_type: z.string().describe("The node type, e.g. 'Person'."),
    key: z.string().optional().describe("The node's stored key, if you have it."),
    node_data: z.record(z.string(), z.any()).optional().describe('Fields you know, as you would write them, e.g. {"name": "Ada", "email": "ada@example.com"}.'),
    name: z.string().optional().describe("Its name. Default: the title node_data gives."),
    aliases: z.array(z.string()).optional().describe("Other names it may go by."),
    namespaces: z.array(z.string()).optional().describe("The data partitions to look in (default: the workspace's)."),
    limit: z.number().int().optional().describe("Most candidates to return, 1–50 (default 5)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const { resolveNode } = await import("../../../graph/resolve.js");
      const r = await resolveNode(b, {
        type: cfg.node_type,
        ...(cfg.key !== undefined ? { key: cfg.key } : {}),
        ...(cfg.node_data ? { data: cfg.node_data } : {}),
        ...(cfg.name !== undefined ? { name: cfg.name } : {}),
        ...(cfg.aliases ? { aliases: cfg.aliases } : {}),
        ...(cfg.namespaces ? { namespaces: cfg.namespaces } : {}),
        ...(cfg.limit !== undefined ? { limit: cfg.limit } : {}),
      });
      return r.match ? withAccessedNodes(r, [{ ref_id: r.match.ref_id, node_type: r.match.node_type, ...(r.match.title ? { name: r.match.title } : {}) }]) : r;
    } catch (e) {
      return errText("graph/resolve", e);
    }
  },
});
