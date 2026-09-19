import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import {
  xToken,
  xCall,
  fetchPosts,
  formatPosts,
  idRange,
  windowQuery,
  xPostSchema,
} from "./_shared.js";

const EXAMPLE = `- id: mentions
  type: x/mentions
  config:
    username: stakwork
    limit: 25
    sinceId: "{{ input.sinceId }}"`;

export default defineStep({
  type: "x/mentions",
  description: `Fetch the posts that mention an X (Twitter) account — its mentions timeline, which reaches further back than x/search-posts' 7-day window (X keeps roughly the latest 800). Returns markdown for LLM consumption (newest first, author handles resolved) with the raw posts alongside. Auth: token, else the X_TOKEN secret (an app-only bearer token; the X app must sit in a Project with API v2 access). X meters post reads — keep limit modest. To poll incrementally, feed newestId back in as sinceId on the next run (it holds its value when nothing new arrived). hasMore means older mentions exist beyond limit — page older with untilId: oldestId.\n\n${EXAMPLE}`,
  input: z.object({
    username: z
      .string()
      .regex(/^@?[A-Za-z0-9_]{1,15}$/, "an X handle: 1–15 letters, digits or underscores")
      .describe("the mentioned account's handle, with or without the @"),
    limit: z
      .number()
      .int()
      .positive()
      .max(800)
      .default(25)
      .describe("max posts to return (fetched in pages of up to 100; every post read counts against the X plan)"),
    sinceId: z.string().optional().describe("only posts newer than this post id (a previous run's newestId)"),
    untilId: z.string().optional().describe("only posts older than this post id (a previous run's oldestId)"),
    startTime: z.string().optional().describe("only posts at/after this ISO 8601 time"),
    endTime: z.string().optional().describe("only posts before this ISO 8601 time"),
    token: z.string().optional().describe("app-only bearer token; omit to use the X_TOKEN secret"),
  }),
  output: z.object({
    markdown: z.string(),
    username: z.string(),
    userId: z.string(),
    posts: z.array(xPostSchema),
    newestId: z.string().nullable(),
    oldestId: z.string().nullable(),
    hasMore: z.boolean(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const token = await xToken(cfg.token, ctx);
    const handle = cfg.username.replace(/^@/, "");

    // The timeline is keyed by numeric user id. A well-formed handle that
    // doesn't exist comes back 200 with `errors` and no `data`.
    const lookup = await xCall(ctx, `/users/by/username/${handle}`, token);
    const user = lookup.data as { id?: string; username?: string } | undefined;
    if (!user?.id) {
      const why = (lookup.errors as { detail?: string }[] | undefined)?.[0]?.detail;
      throw new Error(`X user @${handle} not found${why ? ` — ${why}` : ""}`);
    }

    const { posts, hasMore } = await fetchPosts(
      ctx,
      `/users/${user.id}/mentions`,
      token,
      windowQuery(cfg),
      { limit: cfg.limit, pageMin: 5, pageParam: "pagination_token" },
    );

    const username = user.username ?? handle;
    const { newestId, oldestId } = idRange(posts);
    return {
      markdown: formatPosts(`X mentions of @${username}`, posts),
      username,
      userId: user.id,
      posts,
      // Hold the cursor when nothing new arrived, so feeding newestId back as
      // sinceId is always safe.
      newestId: newestId ?? (cfg.sinceId || null),
      oldestId,
      hasMore,
    };
  },
});
