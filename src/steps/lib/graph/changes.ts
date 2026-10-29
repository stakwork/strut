import { z } from "zod";
import { defineStep } from "../../../core.js";
import { FEED_MAX_WAIT_MS } from "../../../live-feed.js";
import { GRAPH_FEED_READ_MAX, type GraphChangeFeed } from "../../../graph-writes.js";

/**
 * The graph writes made through strut after a cursor (plans/live-feeds.md
 * §3), as a step: what a page that shows part of the graph watches so it
 * reads again when that part changes — whoever wrote it, a job's run, a
 * teammate's edit, a scheduled workflow. Ids, types and time only: the
 * reader reads what changed through the reads it already has.
 * `GET /graph/changes` is the same read.
 */
export default defineStep({
  type: "graph/changes",
  description:
    `Graph writes made through strut after a cursor: { cursor, reset?, more?, changes: [{ kind: node|edge, op: created|updated|deleted, ref_id, at, node_type?, edge_type?, source?, target?, types? }] } — ` +
    `the latest write per node or edge, in the order they happened. \`types\` keeps nodes of those types and edges with an end of one. ` +
    `Hand \`cursor\` back as \`since\`; \`since: "now"\` reads only what is written from here. \`wait\` (ms) holds the call while nothing is new. ` +
    `\`reset\` means the cursor could not be honored (the server restarted): read again what you show. ` +
    `Writes by another process (an ingest, jarvis, a host writing the database itself) are not here.`,
  effect: "read",
  input: z.object({
    types: z.array(z.string()).optional().describe("Only nodes of these types, and edges with an end of one."),
    since: z.string().optional().describe('The cursor the last read returned, or "now". Omit to read everything kept.'),
    wait: z.number().int().min(0).max(FEED_MAX_WAIT_MS).optional().describe(`Hold up to this many ms while nothing is new (at most ${FEED_MAX_WAIT_MS}).`),
    limit: z.number().int().positive().max(GRAPH_FEED_READ_MAX).optional(),
  }),
  output: z.object({
    cursor: z.string(),
    reset: z.literal(true).optional(),
    more: z.literal(true).optional(),
    changes: z.array(z.any()),
  }),
  async run(cfg, ctx) {
    const feed = (ctx?.services as { graphChanges?: GraphChangeFeed } | undefined)?.graphChanges;
    if (!feed) throw new Error("graph/changes needs a strut with a graph (ctx.services.graphChanges); this one has none.");
    return feed.read({ ...(cfg.types?.length ? { types: cfg.types } : {}), since: cfg.since, wait: cfg.wait, limit: cfg.limit });
  },
});
