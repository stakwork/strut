import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import {
  xToken,
  fetchPosts,
  formatPosts,
  idRange,
  windowQuery,
  xPostSchema,
} from "./_shared.js";

const EXAMPLE = `- id: posts
  type: x/search-posts
  config:
    query: '"lightning network" OR #bitcoin lang:en'
    limit: 25
    sinceId: "{{ input.sinceId }}"`;

export default defineStep({
  type: "x/search-posts",
  description: `Search X (Twitter) posts from the last 7 days by topic, hashtag, author or mention using X's search query syntax; returns markdown for LLM consumption (newest first, author handles resolved) with the raw posts alongside. Auth: token, else the X_TOKEN secret (an app-only bearer token; the X app must sit in a Project with API v2 access). X meters post reads — keep limit modest. To poll incrementally, feed newestId back in as sinceId on the next run (it holds its value when nothing new arrived). hasMore means more matches exist beyond limit — page older with untilId: oldestId. For an account's mentions further back than 7 days use x/mentions.\n\n${EXAMPLE}`,
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'X search query: keywords (ANDed), "exact phrase", #hashtag, @mention, from:handle, to:handle, lang:en, -is:reply, has:links, OR, (grouping), -negation',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .default(25)
      .describe("max posts to return (fetched in pages of up to 100; every post read counts against the X plan)"),
    excludeRetweets: z
      .boolean()
      .default(true)
      .describe("append -is:retweet (retweets duplicate the original post and arrive truncated); ignored when the query already uses is:retweet"),
    sinceId: z.string().optional().describe("only posts newer than this post id (a previous run's newestId)"),
    untilId: z.string().optional().describe("only posts older than this post id (a previous run's oldestId)"),
    startTime: z.string().optional().describe("only posts at/after this ISO 8601 time (within the last 7 days)"),
    endTime: z.string().optional().describe("only posts before this ISO 8601 time"),
    token: z.string().optional().describe("app-only bearer token; omit to use the X_TOKEN secret"),
  }),
  output: z.object({
    markdown: z.string(),
    query: z.string(),
    posts: z.array(xPostSchema),
    newestId: z.string().nullable(),
    oldestId: z.string().nullable(),
    hasMore: z.boolean(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const token = await xToken(cfg.token, ctx);

    // Parenthesize before appending: AND binds tighter than OR in X's query
    // syntax, so `a OR b -is:retweet` would only filter the `b` branch.
    const query =
      cfg.excludeRetweets && !/\bis:retweet\b/.test(cfg.query)
        ? `(${cfg.query}) -is:retweet`
        : cfg.query;

    const { posts, hasMore } = await fetchPosts(
      ctx,
      "/tweets/search/recent",
      token,
      { query, ...windowQuery(cfg) },
      { limit: cfg.limit, pageMin: 10, pageParam: "next_token" },
    );

    const { newestId, oldestId } = idRange(posts);
    return {
      markdown: formatPosts(`X posts matching ${query}`, posts),
      query,
      posts,
      // Hold the cursor when nothing new arrived, so feeding newestId back as
      // sinceId is always safe.
      newestId: newestId ?? (cfg.sinceId || null),
      oldestId,
      hasMore,
    };
  },
});
