import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { FEED_MAX_WAIT_MS } from "../../../live-feed.js";
import { PROPOSAL_FEED_READ_MAX, type ProposalFeed } from "../../../proposal-feed.js";

/**
 * What happened to proposals after a cursor (plans/live-feeds.md, "Proposal feed"), as a
 * step: what an app's page watches instead of polling `proposal/list`.
 * `GET /proposals/changes` is the same read. Under `ctx.app` the viewer's
 * own proposals only, as `proposal/list` shows them.
 */
export default defineStep({
  type: "proposal/changes",
  description:
    "Proposal events after a cursor: { cursor, reset?, more?, events: [{ event: created|decided|applied|failed, id, status, kind: tool|step, title, summary?, actor?, at }] }, oldest first. " +
    "Never the tool's input: read one proposal by id (proposal/get) when an event concerns you. Hand `cursor` back; `cursor: \"now\"` reads only what happens from here. " +
    "`wait` (ms) holds the call while nothing is new. `reset` means the cursor could not be honored (restart, or the feed dropped events): list the proposals again.",
  effect: "read",
  input: z.object({
    cursor: z.string().optional().describe('The cursor the last read returned, or "now". Omit to read everything kept.'),
    wait: z.number().int().min(0).max(FEED_MAX_WAIT_MS).optional().describe(`Hold up to this many ms while nothing is new (at most ${FEED_MAX_WAIT_MS}).`),
    limit: z.number().int().positive().max(PROPOSAL_FEED_READ_MAX).optional(),
  }),
  output: z.object({
    cursor: z.string(),
    reset: z.literal(true).optional(),
    more: z.literal(true).optional(),
    events: z.array(z.any()),
  }),
  async run(cfg, ctx: StepContext) {
    const feed = (ctx.services as { proposalChanges?: ProposalFeed } | undefined)?.proposalChanges;
    if (!feed) throw new Error("proposal/changes needs a strut server (ctx.services.proposalChanges); the standard strut server provides it.");
    return feed.read({ scope: ctx.app ? "peer:person" : "full", actor: ctx.actor, cursor: cfg.cursor, wait: cfg.wait, limit: cfg.limit });
  },
});
