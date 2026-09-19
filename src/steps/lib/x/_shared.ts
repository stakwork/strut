// Shared helpers for the x/* lib steps. Leading-underscore file → imported by
// siblings, skipped by registry discovery (see AGENTS.md). Like slack/*, these
// go through ctx.services.http (raw REST — no SDK needed, fully recordable).
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

const X_API = "https://api.x.com/2";

/** X caps a page at 100 posts on both search and the mentions timeline. */
const PAGE_MAX = 100;
/** Backstop against a run of empty pages that still carry a next_token. */
const MAX_PAGES = 20;

type Ctx = StepContext<StrutCapabilities>;
type Query = Record<string, string | number | boolean>;

/** Fields requested on every post fetch — enough to resolve author handles,
 *  classify replies/quotes, and recover long posts (`note_tweet`), whose
 *  `text` otherwise arrives truncated at 280 chars. */
const POST_FIELDS: Query = {
  "tweet.fields":
    "created_at,public_metrics,conversation_id,lang,referenced_tweets,note_tweet",
  expansions: "author_id",
  "user.fields": "username,name",
};

export const xPostSchema = z.object({
  id: z.string(),
  url: z.string(),
  text: z.string(),
  author: z.string(),
  authorName: z.string().nullable(),
  authorId: z.string(),
  createdAt: z.string().nullable(),
  kind: z.enum(["post", "reply", "quote", "repost"]),
  conversationId: z.string().nullable(),
  lang: z.string().nullable(),
  metrics: z.object({
    likes: z.number(),
    reposts: z.number(),
    replies: z.number(),
    quotes: z.number(),
  }),
});

export type XPost = z.infer<typeof xPostSchema>;

/** A non-2xx from the X API. Carries the status + parsed body so callers can
 *  branch on specific failures (see the stale `since_id` retry in fetchPosts). */
export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/** Resolve an X bearer token: explicit config wins, else the X_TOKEN secret
 *  (UI-managed store → env). Throws an actionable error if neither. */
export async function xToken(
  explicit: string | undefined,
  ctx: Ctx,
): Promise<string> {
  // `||` not `??`: a `{{ input.token }}` template that resolves to "" should
  // still fall through to the secret.
  const raw = explicit || (await ctx?.services?.secrets?.get("X_TOKEN"));
  // Tolerate a pasted "Bearer …" — xCall adds the header prefix itself.
  const token = raw?.trim().replace(/^Bearer\s+/i, "");
  if (!token) {
    throw new Error(
      "No X token. Pass `token` in config or add an X_TOKEN secret (the app-only Bearer Token from the X developer portal).",
    );
  }
  return token;
}

/** GET an X API v2 path and return its JSON payload. Non-2xx responses throw
 *  an {@link XApiError} with an actionable message. */
export async function xCall(
  ctx: Ctx,
  path: string,
  token: string,
  query: Query = {},
): Promise<Record<string, unknown>> {
  const http = ctx?.services?.http;
  if (!http) throw new Error("x steps require ctx.services.http");

  const res = await http(`${X_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    query,
  });

  const body =
    res.body && typeof res.body === "object"
      ? (res.body as Record<string, unknown>)
      : {};
  if (!res.ok) throw describeXError(res.status, body, res.headers, path);
  return body;
}

/** Map an X API failure to an actionable error. Unknown failures pass X's own
 *  title/detail through verbatim so nothing is swallowed. */
export function describeXError(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  path: string,
): XApiError {
  const title = typeof body.title === "string" ? body.title : "";
  const detail = typeof body.detail === "string" ? body.detail : "";
  const first = (body.errors as { message?: string }[] | undefined)?.[0];

  let hint: string;
  if (status === 401) {
    hint =
      "invalid or revoked X token — check X_TOKEN (the app-only Bearer Token from the developer portal)";
  } else if (body.reason === "client-not-enrolled") {
    hint =
      "the X app isn't attached to a Project with API v2 access — attach it (or create a new app inside a Project) in the developer portal, then regenerate the bearer token";
  } else if (title === "Unsupported Authentication") {
    hint =
      "this endpoint needs a user-context token, but X_TOKEN is an app-only bearer token";
  } else if (title === "UsageCapExceeded") {
    hint = `the X plan's post-read cap is exhausted (${detail || "usage cap exceeded"})`;
  } else if (status === 429) {
    const reset = Number(headers["x-rate-limit-reset"]);
    const when = Number.isFinite(reset) && reset > 0
      ? ` — resets at ${new Date(reset * 1000).toISOString()}`
      : "";
    hint = `rate limited by X${when}`;
  } else {
    // errors[0].message is the specific one ("'since_id' must be …"); detail
    // is often just "One or more parameters to your request was invalid."
    hint = first?.message || detail || title || "request failed";
  }
  return new XApiError(`X GET ${path} failed: ${hint} (HTTP ${status})`, status, body);
}

/** Fetch up to `limit` posts from a paginated post endpoint (newest first).
 *
 *  `pageMin` is the endpoint's smallest allowed `max_results` (10 for search,
 *  5 for mentions): a `limit` below it still requests a full minimum page and
 *  trims. `hasMore` is true when X reported a further page OR posts were
 *  trimmed — either way, older posts exist past the last one returned. */
export async function fetchPosts(
  ctx: Ctx,
  path: string,
  token: string,
  query: Query,
  opts: { limit: number; pageMin: number; pageParam: string },
): Promise<{ posts: XPost[]; hasMore: boolean }> {
  let q: Query = { ...POST_FIELDS, ...query };
  const posts: XPost[] = [];
  let next: string | undefined;

  for (let page = 0; page < MAX_PAGES && posts.length < opts.limit; page++) {
    const pageQuery = (): Query => ({
      ...q,
      max_results: Math.min(
        PAGE_MAX,
        Math.max(opts.pageMin, opts.limit - posts.length),
      ),
      ...(next ? { [opts.pageParam]: next } : {}),
    });

    let data: Record<string, unknown>;
    try {
      data = await xCall(ctx, path, token, pageQuery());
    } catch (err) {
      if (!("since_id" in q) || !isStaleSinceId(err)) throw err;
      // Recent search rejects a since_id older than its 7-day window. Every
      // post still in the window is newer than that id, so dropping it
      // returns exactly the set the caller asked for.
      const { since_id: _stale, ...rest } = q;
      q = rest;
      data = await xCall(ctx, path, token, pageQuery());
    }

    posts.push(...toPosts(data));
    next = (data.meta as { next_token?: string } | undefined)?.next_token;
    if (!next) break;
  }

  const trimmed = posts.length > opts.limit;
  return { posts: posts.slice(0, opts.limit), hasMore: trimmed || !!next };
}

function isStaleSinceId(err: unknown): boolean {
  if (!(err instanceof XApiError) || err.status !== 400) return false;
  const errors = err.body.errors as
    | { parameters?: Record<string, unknown> }[]
    | undefined;
  return !!errors?.some((e) => e.parameters && "since_id" in e.parameters);
}

/** Flatten an X v2 page (`data` + `includes.users`) into self-contained posts. */
function toPosts(page: Record<string, unknown>): XPost[] {
  const includes = page.includes as
    | { users?: { id: string; username?: string; name?: string }[] }
    | undefined;
  const users = new Map((includes?.users ?? []).map((u) => [u.id, u]));
  const data = (page.data as Record<string, unknown>[] | undefined) ?? [];

  return data.map((t) => {
    const id = String(t.id ?? "");
    const authorId = String(t.author_id ?? "");
    const user = users.get(authorId);
    const note = t.note_tweet as { text?: string } | undefined;
    const m = (t.public_metrics ?? {}) as Record<string, number | undefined>;
    return {
      id,
      // /i/status/<id> resolves without the handle, for unresolved authors.
      url: `https://x.com/${user?.username ?? "i"}/status/${id}`,
      text: note?.text ?? (t.text as string) ?? "",
      author: user?.username ?? authorId,
      authorName: user?.name ?? null,
      authorId,
      createdAt: (t.created_at as string) ?? null,
      kind: kindOf(t.referenced_tweets as { type?: string }[] | undefined),
      conversationId: (t.conversation_id as string) ?? null,
      lang: (t.lang as string) ?? null,
      metrics: {
        likes: m.like_count ?? 0,
        reposts: m.retweet_count ?? 0,
        replies: m.reply_count ?? 0,
        quotes: m.quote_count ?? 0,
      },
    };
  });
}

function kindOf(refs: { type?: string }[] | undefined): XPost["kind"] {
  const types = new Set((refs ?? []).map((r) => r.type));
  if (types.has("retweeted")) return "repost";
  if (types.has("replied_to")) return "reply";
  if (types.has("quoted")) return "quote";
  return "post";
}

/** Newest/oldest post id of a result set — the cursors for `sinceId` (poll
 *  forward) and `untilId` (page back). Ids are snowflakes: numeric strings that
 *  order by length, then lexically. */
export function idRange(posts: XPost[]): {
  newestId: string | null;
  oldestId: string | null;
} {
  const ids = posts.map((p) => p.id).sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return { newestId: ids[ids.length - 1] ?? null, oldestId: ids[0] ?? null };
}

/** Shared time/id window inputs → X query params. Empty strings (an unset
 *  `{{ input.sinceId }}` on a first run) are dropped. */
export function windowQuery(cfg: {
  sinceId?: string;
  untilId?: string;
  startTime?: string;
  endTime?: string;
}): Query {
  return {
    ...(cfg.sinceId ? { since_id: cfg.sinceId } : {}),
    ...(cfg.untilId ? { until_id: cfg.untilId } : {}),
    ...(cfg.startTime ? { start_time: cfg.startTime } : {}),
    ...(cfg.endTime ? { end_time: cfg.endTime } : {}),
  };
}

export function formatPosts(title: string, posts: XPost[]): string {
  const lines = [`# ${title} (${posts.length} posts)`];
  for (const p of posts) {
    const name = p.authorName ? ` (${p.authorName})` : "";
    const kind = p.kind === "post" ? "" : ` · ${p.kind}`;
    const { likes, reposts, replies } = p.metrics;
    lines.push(
      `\n**@${p.author}**${name} — ${p.createdAt ?? "unknown time"}${kind} · ${likes} likes · ${reposts} reposts · ${replies} replies`,
    );
    lines.push(`> ${p.text.replace(/\n/g, "\n> ")}`);
    lines.push(p.url);
  }
  return lines.join("\n");
}
