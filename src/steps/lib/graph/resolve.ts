import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText } from "./_shared.js";

export default defineStep({
  type: "graph/resolve",
  description:
    "Find the ONE existing node something is, before creating it: resolve every person, place, activity or other thing you are about to write about " +
    "before graph/create-node or graph/assert, so nothing is saved twice. Give what you know — its type, its key, " +
    "`node_data` as you would write it (its key fields, identifiers such as a Person's email, its name), " +
    "a `name`, or `aliases`. Tries, in order, the key, the type's identifiers, the exact name (case-blind), " +
    "then the node's other names (`alt_names`); the first that finds anything decides. " +
    "Returns `{ node_type, namespaces, match, ambiguous, candidates }`: `match` is the node when exactly one was found " +
    "(`matched_by` says how). When several were found `ambiguous` is true and they are the `candidates` — do not pick " +
    "one by name alone; two people can share a name. When nothing was found, `candidates` are nodes the search ranks " +
    "close (`matched_by: search`); create a new node only if none of them is the thing. " +
    "Leave `node_type` out when you are not sure of it: every entity type is searched, and each node comes back with its `node_type`. " +
    "With a type and nothing found, `elsewhere` lists nodes of other types with that name: use one of them rather than making a second. " +
    "The user themself is never resolved or created again: graph/graph-get with `owner: true` returns them. " +
    "When something gets another name, add it to its `alt_names` (graph/edit-node) so this finds it by that name too. " +
    "Reads only `namespaces` (default: the workspace's). A LadybugDB graph only.",
  input: z.object({
    node_type: z.string().optional().describe("The node type, e.g. 'Person'. Leave out to look across every entity type."),
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
      const { resolveAcross, resolveNode } = await import("../../../graph/resolve.js");
      const asked = {
        ...(cfg.key !== undefined ? { key: cfg.key } : {}),
        ...(cfg.node_data ? { data: cfg.node_data } : {}),
        ...(cfg.name !== undefined ? { name: cfg.name } : {}),
        ...(cfg.aliases ? { aliases: cfg.aliases } : {}),
        ...(cfg.namespaces ? { namespaces: cfg.namespaces } : {}),
        ...(cfg.limit !== undefined ? { limit: cfg.limit } : {}),
      };
      const typed = cfg.node_type?.trim() ? await resolveNode(b, { ...asked, type: cfg.node_type }) : undefined;
      // A typed miss: the same name under another entity type is the thing filed elsewhere.
      // Only when there is a name to look for: a miss asked by key or identifier alone has no `elsewhere`.
      const dataName = cfg.node_data?.["name"];
      const named = !!(cfg.name?.trim() || (typeof dataName === "string" && dataName.trim()) || cfg.aliases?.some((a) => a.trim()));
      const across = !typed ? await resolveAcross(b, asked) : !typed.match && !typed.ambiguous && named ? await resolveAcross(b, asked) : undefined;
      const others = across && typed ? (across.match ? [across.match] : across.ambiguous ? across.candidates : []).filter((n) => n.node_type !== typed.node_type) : [];
      const r = typed ? { ...typed, ...(others.length ? { elsewhere: others } : {}) } : across!;
      return r.match ? withAccessedNodes(r, [{ ref_id: r.match.ref_id, node_type: r.match.node_type, ...(r.match.title ? { name: r.match.title } : {}) }]) : r;
    } catch (e) {
      return errText("graph/resolve", e);
    }
  },
});
