import { z } from "zod";
import { defineStep } from "../../../core.js";
import { memoryDb } from "./_db.js";
import { searchMemory, stopWords } from "./_search.js";

export default defineStep({
  type: "memory/recall",
  description:
    "Search long-term memory. Returns small results: ref_id, name, node_type, a short description, and an edges count. " +
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
      stop = await stopWords(ctx);
    } catch (e) {
      return { error: (e as Error).message };
    }
    const query = await memoryDb(ctx);
    const types = cfg.type ? new Set(cfg.type.split(",").map((t) => t.trim())) : undefined;
    const hits = await searchMemory(query, { q: cfg.q, types, stop, includeExpired: cfg.include_expired });
    return hits.slice(0, Math.max(1, cfg.limit)).map(({ ref_id, name, node_type, description, facts }) => ({
      ref_id, name, node_type, description, edges: facts === undefined ? {} : { FACTS: facts },
    }));
  },
});
