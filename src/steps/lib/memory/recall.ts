import { z } from "zod";
import { defineStep } from "../../../core.js";
import { memoryDb } from "./_db.js";
import { factDescription, memoryStopWords, scoreMemory } from "./_search.js";

// Plain word matching over names and fact text, ranked by how many words hit.
// Fine at personal scale; Ladybug's full-text and vector indexes replace it later.
export default defineStep({
  type: "memory/recall",
  description:
    "Retired for agents: read memory with graph/graph-search, graph/graph-get, graph/graph-neighbors and graph/get-ontology (the host binds the graph tools to memory). Search long-term memory. Returns small results: ref_id, name, node_type, a short description, and an edges count. " +
    "Facts come back as their sentence. Call memory/get on a ref_id for the full node. " +
    "For anything about the user themselves, memory/get with user: true returns everything known about them.",
  input: z.object({
    q: z.string().describe("Plain words, e.g. 'Kate cooking' or 'my name'."),
    type: z.string().optional().describe("Comma-separated filter: entity types (Person, Topic, …) and/or 'Fact'."),
    limit: z.number().optional().default(10),
    include_expired: z.boolean().optional().default(false).describe("Also return facts no longer held: superseded or ended."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    let stop: Set<string>;
    try {
      stop = await memoryStopWords(ctx);
    } catch (e) {
      return { error: (e as Error).message };
    }
    const query = await memoryDb(ctx);
    const types = cfg.type ? new Set(cfg.type.split(",").map((t) => t.trim())) : undefined;
    const scored = await scoreMemory(query, {
      q: cfg.q,
      stop,
      entities: !types || [...types].some((t) => t !== "Fact"),
      entityTypes: types,
      facts: !types || types.has("Fact"),
      includeExpired: cfg.include_expired,
    });
    return scored.slice(0, Math.max(1, cfg.limit)).map((h) =>
      h.kind === "entity"
        ? { ref_id: h.row.ref_id, name: h.row.name, node_type: h.row.type, description: h.row.summary ?? "", edges: { FACTS: Number(h.row.facts) } }
        // Dates only when known; a fact no longer held is marked past.
        : { ref_id: h.row.ref_id, name: h.row.text, node_type: "Fact", description: factDescription(h.row), edges: {} },
    );
  },
});
