import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "./capabilities.js";
import searchPosts from "./steps/lib/x/search-posts.js";
import mentions from "./steps/lib/x/mentions.js";

// ── Fake ctx ────────────────────────────────────────────────────────────────
//
// X steps go through ctx.services.http (raw REST). We stub it with a response
// map keyed by the API path (after /2). A route is one reply, or an array of
// replies consumed one per call (for pagination / retry), and every call is
// recorded so we can assert what was sent.

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface Call {
  path: string;
  query: Record<string, string | number | boolean>;
  auth?: string;
}

function makeCtx(
  routes: Record<string, Reply | Reply[]>,
  opts: { secrets?: Record<string, string> } = {},
) {
  const calls: Call[] = [];
  const http = async (
    url: string,
    o: {
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean>;
    } = {},
  ): Promise<HttpResponse> => {
    const path = url.replace("https://api.x.com/2", "");
    calls.push({ path, query: o.query ?? {}, auth: o.headers?.authorization });
    const route = routes[path];
    const reply = Array.isArray(route) ? route.shift() : route;
    if (!reply) return { status: 404, ok: false, headers: {}, body: { title: "Not Found" } };
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: reply.headers ?? {},
      body: reply.body,
    };
  };
  const ctx = {
    runId: "t",
    path: "t",
    scope: {},
    input: {},
    emit: async () => {},
    services: {
      http,
      secrets: { get: async (n: string) => opts.secrets?.[n] },
    },
  } as never;
  return { ctx, calls };
}

const SEARCH = "/tweets/search/recent";

/** A raw X v2 post as the API returns it. */
function rawPost(id: string, extra: Record<string, unknown> = {}) {
  return { id, text: `post ${id}`, author_id: "u1", ...extra };
}

/** `n` raw posts with descending ids starting at `from` (X is newest-first). */
function rawPosts(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => rawPost(String(from - i)));
}

const ALICE = { id: "u1", username: "alice", name: "Alice A" };

const searchCfg = (over: Record<string, unknown> = {}) =>
  ({ query: "strut", limit: 25, excludeRetweets: true, token: "tok", ...over }) as never;

// ── search-posts ─────────────────────────────────────────────────────────────

describe("x/search-posts", () => {
  it("returns posts with resolved authors, markdown and id cursors", async () => {
    const { ctx, calls } = makeCtx({
      [SEARCH]: {
        body: {
          data: [
            rawPost("1002", {
              text: "second",
              created_at: "2026-09-19T10:00:00.000Z",
              conversation_id: "1001",
              lang: "en",
              referenced_tweets: [{ type: "replied_to", id: "1001" }],
              public_metrics: { like_count: 3, retweet_count: 2, reply_count: 1, quote_count: 0 },
            }),
            rawPost("1001", { text: "first" }),
          ],
          includes: { users: [ALICE] },
          meta: { result_count: 2 },
        },
      },
    });
    const out = await searchPosts.run(searchCfg(), ctx);

    assert.equal(out.posts.length, 2);
    assert.deepEqual(out.posts[0], {
      id: "1002",
      url: "https://x.com/alice/status/1002",
      text: "second",
      author: "alice",
      authorName: "Alice A",
      authorId: "u1",
      createdAt: "2026-09-19T10:00:00.000Z",
      kind: "reply",
      conversationId: "1001",
      lang: "en",
      metrics: { likes: 3, reposts: 2, replies: 1, quotes: 0 },
    });
    assert.equal(out.posts[1]!.kind, "post");
    assert.equal(out.newestId, "1002");
    assert.equal(out.oldestId, "1001");
    assert.equal(out.hasMore, false);
    assert.match(out.markdown, /# X posts matching \(strut\) -is:retweet \(2 posts\)/);
    assert.match(out.markdown, /\*\*@alice\*\* \(Alice A\) — 2026-09-19T10:00:00.000Z · reply · 3 likes/);
    assert.match(out.markdown, /> second\nhttps:\/\/x\.com\/alice\/status\/1002/);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.auth, "Bearer tok");
    assert.equal(calls[0]!.query.query, "(strut) -is:retweet");
    assert.equal(calls[0]!.query.max_results, 25);
    assert.equal(calls[0]!.query.expansions, "author_id");
    assert.match(String(calls[0]!.query["tweet.fields"]), /note_tweet/);
  });

  it("paginates until limit, then trims and reports hasMore", async () => {
    const { ctx, calls } = makeCtx({
      [SEARCH]: [
        { body: { data: rawPosts(5000, 100), meta: { next_token: "p2" } } },
        { body: { data: rawPosts(4900, 100), meta: { next_token: "p3" } } },
      ],
    });
    const out = await searchPosts.run(searchCfg({ limit: 150 }), ctx);

    assert.equal(out.posts.length, 150);
    assert.equal(out.hasMore, true);
    assert.equal(out.newestId, "5000");
    assert.equal(out.oldestId, "4851");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.query.max_results, 100);
    assert.equal(calls[0]!.query.next_token, undefined);
    // second page asks only for the remainder
    assert.equal(calls[1]!.query.max_results, 50);
    assert.equal(calls[1]!.query.next_token, "p2");
  });

  it("requests X's 10-post page minimum for a smaller limit, then trims", async () => {
    const { ctx, calls } = makeCtx({
      [SEARCH]: { body: { data: rawPosts(2000, 10), meta: {} } },
    });
    const out = await searchPosts.run(searchCfg({ limit: 3 }), ctx);

    assert.equal(calls[0]!.query.max_results, 10);
    assert.deepEqual(out.posts.map((p) => p.id), ["2000", "1999", "1998"]);
    assert.equal(out.oldestId, "1998");
    assert.equal(out.hasMore, true);
  });

  it("leaves the query alone when excludeRetweets is off or is:retweet is already used", async () => {
    const reply = { body: { data: [], meta: {} } };
    const a = makeCtx({ [SEARCH]: reply });
    await searchPosts.run(searchCfg({ query: "a OR b", excludeRetweets: false }), a.ctx);
    assert.equal(a.calls[0]!.query.query, "a OR b");

    const b = makeCtx({ [SEARCH]: reply });
    await searchPosts.run(searchCfg({ query: "strut is:retweet" }), b.ctx);
    assert.equal(b.calls[0]!.query.query, "strut is:retweet");

    // OR queries are grouped so the filter applies to every branch
    const c = makeCtx({ [SEARCH]: reply });
    await searchPosts.run(searchCfg({ query: "a OR b" }), c.ctx);
    assert.equal(c.calls[0]!.query.query, "(a OR b) -is:retweet");
  });

  it("maps window inputs to X params and drops empty strings", async () => {
    const { ctx, calls } = makeCtx({ [SEARCH]: { body: { data: [], meta: {} } } });
    await searchPosts.run(
      searchCfg({ sinceId: "", untilId: "900", startTime: "2026-09-18T00:00:00Z" }),
      ctx,
    );
    assert.equal("since_id" in calls[0]!.query, false);
    assert.equal(calls[0]!.query.until_id, "900");
    assert.equal(calls[0]!.query.start_time, "2026-09-18T00:00:00Z");
  });

  it("holds newestId at sinceId when nothing new arrived", async () => {
    const { ctx, calls } = makeCtx({
      [SEARCH]: { body: { meta: { result_count: 0 } } },
    });
    const out = await searchPosts.run(searchCfg({ sinceId: "777" }), ctx);
    assert.equal(calls[0]!.query.since_id, "777");
    assert.deepEqual(out.posts, []);
    assert.equal(out.newestId, "777");
    assert.equal(out.oldestId, null);
    assert.equal(out.hasMore, false);
  });

  it("retries without a since_id that fell out of the 7-day window", async () => {
    const { ctx, calls } = makeCtx({
      [SEARCH]: [
        {
          status: 400,
          body: {
            title: "Invalid Request",
            detail: "One or more parameters to your request was invalid.",
            errors: [
              {
                message: "'since_id' must be a tweet id created after 2026-09-12T17:01Z.",
                parameters: { since_id: ["20"] },
              },
            ],
          },
        },
        { body: { data: [rawPost("3000")], meta: {} } },
      ],
    });
    const out = await searchPosts.run(searchCfg({ sinceId: "20" }), ctx);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.query.since_id, "20");
    assert.equal("since_id" in calls[1]!.query, false);
    assert.equal(out.newestId, "3000");
  });

  it("surfaces other 400s with X's specific message", async () => {
    const { ctx } = makeCtx({
      [SEARCH]: {
        status: 400,
        body: {
          title: "Invalid Request",
          detail: "One or more parameters to your request was invalid.",
          errors: [{ message: "Invalid 'start_time':'nope'.", parameters: { start_time: ["nope"] } }],
        },
      },
    });
    await assert.rejects(
      () => searchPosts.run(searchCfg({ startTime: "nope" }), ctx),
      /X GET \/tweets\/search\/recent failed: Invalid 'start_time':'nope'\. \(HTTP 400\)/,
    );
  });

  it("prefers the full note_tweet text and falls back when the author is unresolved", async () => {
    const { ctx } = makeCtx({
      [SEARCH]: {
        body: {
          data: [
            rawPost("1", { text: "cut off…", note_tweet: { text: "the whole long post" } }),
            rawPost("2", { author_id: "u404", referenced_tweets: [{ type: "quoted", id: "9" }] }),
          ],
          includes: { users: [ALICE] },
          meta: {},
        },
      },
    });
    const out = await searchPosts.run(searchCfg(), ctx);
    assert.equal(out.posts[0]!.text, "the whole long post");
    assert.equal(out.posts[1]!.author, "u404");
    assert.equal(out.posts[1]!.authorName, null);
    assert.equal(out.posts[1]!.url, "https://x.com/i/status/2");
    assert.equal(out.posts[1]!.kind, "quote");
  });

  it("maps client-not-enrolled to an actionable error", async () => {
    const { ctx } = makeCtx({
      [SEARCH]: {
        status: 403,
        body: { title: "Client Forbidden", reason: "client-not-enrolled", detail: "…" },
      },
    });
    await assert.rejects(
      () => searchPosts.run(searchCfg(), ctx),
      /isn't attached to a Project.*\(HTTP 403\)/s,
    );
  });

  it("reports when a rate limit resets", async () => {
    const { ctx } = makeCtx({
      [SEARCH]: {
        status: 429,
        headers: { "x-rate-limit-reset": "1789837920" },
        body: { title: "Too Many Requests" },
      },
    });
    await assert.rejects(
      () => searchPosts.run(searchCfg(), ctx),
      /rate limited by X — resets at 2026-09-19T\d\d:\d\d:\d\d\.000Z \(HTTP 429\)/,
    );
  });

  it("distinguishes an exhausted usage cap from a rate limit", async () => {
    const { ctx } = makeCtx({
      [SEARCH]: {
        status: 429,
        body: { title: "UsageCapExceeded", detail: "Usage cap exceeded: Monthly product cap" },
      },
    });
    await assert.rejects(() => searchPosts.run(searchCfg(), ctx), /post-read cap is exhausted.*Monthly product cap/);
  });

  it("maps 401 to an invalid-token error", async () => {
    const { ctx } = makeCtx({ [SEARCH]: { status: 401, body: { title: "Unauthorized" } } });
    await assert.rejects(() => searchPosts.run(searchCfg(), ctx), /invalid or revoked X token/);
  });

  it("reads the token from the X_TOKEN secret and tolerates a Bearer prefix", async () => {
    const { ctx, calls } = makeCtx(
      { [SEARCH]: { body: { data: [], meta: {} } } },
      { secrets: { X_TOKEN: "Bearer AAAAsecret" } },
    );
    // an unset `{{ input.token }}` resolves to "" and must fall through
    await searchPosts.run(searchCfg({ token: "" }), ctx);
    assert.equal(calls[0]!.auth, "Bearer AAAAsecret");
  });

  it("errors clearly when no token is available", async () => {
    const { ctx } = makeCtx({});
    await assert.rejects(() => searchPosts.run(searchCfg({ token: undefined }), ctx), /No X token/);
  });
});

// ── mentions ─────────────────────────────────────────────────────────────────

const mentionsCfg = (over: Record<string, unknown> = {}) =>
  ({ username: "@stakwork", limit: 25, token: "tok", ...over }) as never;

describe("x/mentions", () => {
  it("resolves the handle to an id and reads its mentions timeline", async () => {
    const { ctx, calls } = makeCtx({
      "/users/by/username/stakwork": { body: { data: { id: "42", username: "Stakwork" } } },
      "/users/42/mentions": {
        body: {
          data: [rawPost("801", { text: "@Stakwork nice" })],
          includes: { users: [ALICE] },
          meta: { result_count: 1 },
        },
      },
    });
    const out = await mentions.run(mentionsCfg({ sinceId: "700" }), ctx);

    assert.equal(out.userId, "42");
    assert.equal(out.username, "Stakwork");
    assert.equal(out.posts[0]!.author, "alice");
    assert.equal(out.newestId, "801");
    assert.match(out.markdown, /# X mentions of @Stakwork \(1 posts\)/);

    // the leading @ is stripped for the lookup
    assert.deepEqual(calls.map((c) => c.path), ["/users/by/username/stakwork", "/users/42/mentions"]);
    assert.equal(calls[1]!.query.since_id, "700");
    assert.equal(calls[1]!.query.max_results, 25);
    assert.equal("query" in calls[1]!.query, false);
  });

  it("pages with pagination_token and honours the 5-post page minimum", async () => {
    const { ctx, calls } = makeCtx({
      "/users/by/username/stakwork": { body: { data: { id: "42", username: "stakwork" } } },
      "/users/42/mentions": [
        { body: { data: rawPosts(900, 100), meta: { next_token: "m2" } } },
        { body: { data: rawPosts(800, 5), meta: {} } },
      ],
    });
    const out = await mentions.run(mentionsCfg({ limit: 102 }), ctx);

    assert.equal(out.posts.length, 102);
    assert.equal(out.hasMore, true);
    assert.equal(calls[1]!.query.max_results, 100);
    assert.equal(calls[2]!.query.max_results, 5);
    assert.equal(calls[2]!.query.pagination_token, "m2");
  });

  it("errors clearly when the account doesn't exist", async () => {
    const { ctx, calls } = makeCtx({
      "/users/by/username/nobody_here": {
        body: {
          errors: [{ title: "Not Found Error", detail: "Could not find user with username: [nobody_here]." }],
        },
      },
    });
    await assert.rejects(
      () => mentions.run(mentionsCfg({ username: "nobody_here" }), ctx),
      /X user @nobody_here not found — Could not find user/,
    );
    assert.equal(calls.length, 1);
  });

  it("rejects a malformed handle at validation", () => {
    assert.equal(mentions.input.safeParse({ username: "not a handle" }).success, false);
    assert.equal(mentions.input.safeParse({ username: "@stakwork" }).success, true);
  });
});
