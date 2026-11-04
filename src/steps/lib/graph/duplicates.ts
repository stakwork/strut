import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText } from "./_shared.js";

// Deterministic candidates for a tidy pass: it proposes, a model (or a
// person) decides with graph/graph-get and graph/merge. The rules are
// `duplicatePairs` (src/graph/merge.ts), which graph/merge holds the
// janitor to.
export default defineStep({
  type: "graph/duplicates",
  description:
    "List nodes that may be one thing saved twice, strongest first, each pair with why it matched: the same name or other name " +
    "(alt_names) on two nodes of one type, a person with the user's full name, or one name the short form of the other ('Kate' and " +
    "'Katie Moss'). Candidates only, never a decision: read both with graph/graph-get before graph/merge; two people can share a name. " +
    "Nodes of entity types in one namespace (default: the workspace's). A LadybugDB graph only.",
  input: z.object({
    namespace: z.string().optional().describe("The namespace to look in (default: the workspace's)."),
    limit: z.number().int().optional().default(20).describe("Most pairs to return (default 20)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const { duplicatePairs } = await import("../../../graph/merge.js");
      const namespace = await b.reader.resolveNamespace(cfg.namespace);
      const pairs = await duplicatePairs(b, namespace);
      return pairs.slice(0, Math.max(1, cfg.limit)).map(({ a, b: other, reason, score }) => ({ a, b: other, reason, score }));
    } catch (e) {
      return errText("graph/duplicates", e);
    }
  },
});
