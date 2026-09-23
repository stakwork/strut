import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMeta } from "../chat-store.js";
import {
  callbackOrigin,
  createTurnCallbacks,
  finalAssistantText,
  parseCallback,
  type TurnCallbackPayload,
} from "./turn-callback.js";

const URL_ = "https://hive.example/api/webhook/strut/chat?token=s3cret";

function setup(over: { meta?: Partial<ChatMeta> | null; responses?: Array<number | Error>; maxAutoTurns?: number } = {}) {
  const posts: Array<{ url: string; payload: TurnCallbackPayload }> = [];
  const state = { live: new Set<string>() };
  const responses = [...(over.responses ?? [])];
  const meta: ChatMeta | null =
    over.meta === null
      ? null
      : { id: "c1", status: "done", createdAt: "", updatedAt: "", currentTurn: 0, callback: { url: URL_ }, ...over.meta };
  const callbacks = createTurnCallbacks({
    chatStore: { getMeta: async () => meta },
    isLive: (id) => state.live.has(id),
    maxAutoTurns: over.maxAutoTurns ?? 10,
    retryDelaysMs: [1, 1],
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, payload: JSON.parse(init.body as string) });
      const next = responses.shift() ?? 200;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    }) as typeof fetch,
  });
  /** Let detached posts (and their 1ms retries) drain. */
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const end = (turn = 0, extra: Partial<Parameters<typeof callbacks.turnEnded>[0]> = {}) =>
    callbacks.turnEnded({ chatId: "c1", turn, status: "done", trigger: "human", text: "hi", ...extra });
  return { callbacks, posts, state, flush, end };
}

describe("turn callbacks", () => {
  it("a chat with no callback posts nothing", async () => {
    const { callbacks, posts, flush, end } = setup({ meta: { callback: undefined } });
    const release = callbacks.expect("c1");
    await end();
    release();
    await flush();
    assert.equal(posts.length, 0);
  });

  it("an idle turn end is settled, and carries the turn's outcome", async () => {
    const { posts, flush, end } = setup();
    await end(3, { trigger: "notification", text: "all green" });
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, URL_);
    assert.deepEqual(posts[0]!.payload, {
      event: "turn.end",
      chatId: "c1",
      turn: 3,
      status: "done",
      trigger: "notification",
      text: "all green",
      settled: true,
      parked: false,
    });
  });

  it("an expected wake-up outstanding → settled: false; the turn it launches reports settled", async () => {
    const { callbacks, posts, state, flush, end } = setup();
    const delivered = callbacks.expect("c1"); // run_workflow detached
    await end(0);
    // The run settles and its notification launches turn 1 BEFORE the release.
    state.live.add("c1");
    delivered();
    await flush();
    assert.deepEqual(posts.map((p) => [p.payload.event, p.payload.settled]), [["turn.end", false]]);
    state.live.delete("c1"); // turn 1 ends: the notifier clears liveness before it reports
    await end(1, { trigger: "notification" });
    await flush();
    assert.deepEqual(posts.map((p) => [p.payload.event, p.payload.turn, p.payload.settled]), [
      ["turn.end", 0, false],
      ["turn.end", 1, true],
    ]);
  });

  it("a wake-up that resolves WITHOUT a turn sends `settled` — once, and only after a settled: false", async () => {
    const { callbacks, posts, flush, end } = setup();
    const a = callbacks.expect("c1");
    const b = callbacks.expect("c1");
    await end(2);
    a();
    await flush();
    assert.equal(posts.length, 1, "one wake-up is still outstanding");
    b();
    b(); // idempotent
    await flush();
    assert.deepEqual(posts[1]!.payload, { event: "settled", chatId: "c1", turn: 2, status: "done", settled: true, parked: false });
    assert.equal(posts.length, 2);

    // Nothing was ever reported unsettled → a release is silent.
    callbacks.expect("c1")();
    await flush();
    assert.equal(posts.length, 2);
  });

  it("queued notifications already launched the next turn → this one is not settled, and that one reports", async () => {
    const { posts, state, flush, end } = setup();
    state.live.add("c1"); // the notifier's drain started turn 1 before turn 0 reported
    await end(0);
    state.live.delete("c1");
    await end(1, { trigger: "notification" });
    await flush();
    assert.deepEqual(posts.map((p) => [p.payload.turn, p.payload.settled]), [[0, false], [1, true]]);
  });

  it("reports the auto-turn cap as parked", async () => {
    const { posts, flush, end } = setup({ meta: { autoTurns: 3 }, maxAutoTurns: 3 });
    await end();
    await flush();
    assert.equal(posts[0]!.payload.parked, true);
  });

  it("retries a failed delivery, keeps a chat's posts in order, and gives up on a 4xx", async () => {
    const { callbacks, posts, flush, end } = setup({ responses: [new Error("ECONNREFUSED"), 503, 200, 401] });
    const release = callbacks.expect("c1");
    await end(0);
    release();
    await flush();
    assert.deepEqual(posts.map((p) => p.payload.event), ["turn.end", "turn.end", "turn.end", "settled"]);
    assert.equal(posts.length, 4, "the 401 is not retried");
  });

  it("an error turn carries its message", async () => {
    const { posts, flush, end } = setup({ meta: { status: "error" } });
    await end(0, { status: "error", text: undefined, error: { message: "no key" } });
    await flush();
    assert.equal(posts[0]!.payload.status, "error");
    assert.deepEqual(posts[0]!.payload.error, { message: "no key" });
  });
});

describe("turn callback helpers", () => {
  it("parseCallback accepts http(s) URLs only", () => {
    assert.deepEqual(parseCallback({ url: URL_ }), { url: URL_ });
    for (const bad of [null, {}, { url: 5 }, { url: "" }, { url: "not a url" }, { url: "file:///etc/passwd" }]) {
      assert.throws(() => parseCallback(bad));
    }
  });

  it("an open elicitation rides on turn.end, and the turn is settled", async () => {
    const { posts, flush, end } = setup();
    const elicitation = { elicitationId: "e1", mode: "url" as const, message: "to post alerts", name: "SLACK_BOT_TOKEN", url: "?chat=c1&elicit=e1" };
    await end(2, { text: "The builder needs the secret SLACK_BOT_TOKEN: to post alerts", elicitation });
    await flush();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]!.payload.elicitation, elicitation);
    assert.equal(posts[0]!.payload.settled, true);
    assert.equal(posts[0]!.payload.text, "The builder needs the secret SLACK_BOT_TOKEN: to post alerts");
  });

  it("callbackOrigin drops the path and the signed query", () => {
    assert.equal(callbackOrigin(URL_), "https://hive.example");
    assert.equal(callbackOrigin("nope"), "(invalid url)");
  });

  it("finalAssistantText reads the last assistant message that has text", () => {
    assert.equal(
      finalAssistantText([
        { role: "assistant", content: [{ type: "text", text: "first" }, { type: "tool-call", toolName: "x" }] },
        { role: "tool", content: [{ type: "tool-result" }] },
        { role: "assistant", content: [{ type: "text", text: "the " }, { type: "text", text: "answer" }] },
        { role: "assistant", content: [{ type: "tool-call", toolName: "y" }] },
      ]),
      "the answer",
    );
    assert.equal(finalAssistantText([{ role: "assistant", content: "plain" }]), "plain");
    assert.equal(finalAssistantText([{ role: "user", content: "hi" }]), undefined);
    assert.equal(finalAssistantText(undefined), undefined);
  });
});
