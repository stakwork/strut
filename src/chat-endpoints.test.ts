import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { MemoryChatStore, type ChatEvent, type ChatMeta } from "./chat-store.js";
import { MemorySecretStore } from "./secret-store.js";
import { secretUrl, type ElicitationRecord } from "./ai/elicitation.js";
import http from "node:http";

/**
 * HTTP plumbing for the detached chat endpoints. We inject a `MemoryChatStore`
 * and pre-seed it so we exercise the routes WITHOUT launching the real LLM
 * agent (the turn runner is covered indirectly; the model itself needs a key
 * + network). `POST /chat`'s happy path persists synchronously before the
 * detached turn fires, so we can assert that bit deterministically.
 */

describe("chat endpoints", () => {
  let tempDir: string;
  let chatStore: MemoryChatStore;

  async function makeStrut(extra: Partial<Parameters<typeof createStrut>[0]> = {}) {
    return createStrut({
      workspace: new WorkspaceManager(tempDir),
      store: new MemoryRunStore(),
      chatStore,
      serveUi: false,
      ...extra,
    });
  }

  // Provider keys must be absent by default: the detached turn a POST
  // launches then fails at once (no key → chat.error) instead of reaching
  // the network. Tests that need a key point ANTHROPIC_BASE_URL at a local
  // server that answers 400, which the SDK does not retry.
  const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-chat-ep-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    chatStore = new MemoryChatStore();
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  /** A stand-in provider that rejects every call immediately (400). */
  async function deadProvider(): Promise<{ port: number; close: () => void }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as { port: number }).port, close: () => server.close() };
  }

  /** Wait for a chat's detached turn to settle. */
  async function settled(chatId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const m = await chatStore.getMeta(chatId);
      if (m && m.status !== "live") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`chat ${chatId} never settled`);
  }

  it("POST /chat rejects a missing message", async () => {
    const strut = await makeStrut();
    const res = await strut.app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("POST /chat with an unknown chatId is a 404", async () => {
    const strut = await makeStrut();
    const res = await strut.app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "nope", message: "hi" }),
    });
    assert.equal(res.status, 404);
  });

  it("POST /chat creates a session + persists the user message synchronously", async () => {
    const strut = await makeStrut();
    const res = await strut.app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "build me a workflow" }),
    });
    assert.equal(res.status, 202);
    const { chatId, turn } = (await res.json()) as { chatId: string; turn: number };
    assert.ok(chatId);
    assert.equal(turn, 0);

    // The subject message is appended before the (detached) turn launches.
    const messages = await chatStore.loadMessages(chatId);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content, "build me a workflow");

    // currentTurn is set synchronously and isn't moved by the background turn.
    const meta = await chatStore.getMeta(chatId);
    assert.equal(meta!.currentTurn, 0);
  });

  it("POST /chat stamps who started the chat; later speakers move `actor` but never `createdBy`", async () => {
    const strut = await makeStrut({ resolveActor: (c) => c.req.header("x-test-actor") || undefined });
    const post = (body: object, actor?: string) =>
      strut.app.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(actor ? { "x-test-actor": actor } : {}) },
        body: JSON.stringify(body),
      });

    // Started without an actor: nobody is stamped yet.
    const { chatId: orphan } = (await (await post({ message: "hello" })).json()) as { chatId: string };
    assert.equal((await chatStore.getMeta(orphan))!.createdBy, undefined);
    await settled(orphan);

    // Started with one: that actor, for good.
    const { chatId } = (await (await post({ message: "start" }, "alice-1")).json()) as { chatId: string };
    let meta = (await chatStore.getMeta(chatId))!;
    assert.equal(meta.createdBy, "alice-1");
    assert.equal(meta.actor, "alice-1");
    await settled(chatId);

    // Someone else speaks: they are the actor now; alice still started it.
    assert.equal((await post({ chatId, message: "me too" }, "bob-2")).status, 202);
    meta = (await chatStore.getMeta(chatId))!;
    assert.equal(meta.createdBy, "alice-1");
    assert.equal(meta.actor, "bob-2");
    await settled(chatId);

    // The first identified speaker adopts an unstamped chat (chats that
    // predate the stamp), and the list carries the stamp.
    assert.equal((await post({ chatId: orphan, message: "again" }, "carol-3")).status, 202);
    assert.equal((await chatStore.getMeta(orphan))!.createdBy, "carol-3");
    await settled(orphan);
    const list = (await (await strut.app.request("/chats")).json()) as { id: string; createdBy?: string }[];
    assert.deepEqual(
      Object.fromEntries(list.map((c) => [c.id, c.createdBy])),
      { [orphan]: "carol-3", [chatId]: "alice-1" },
    );
  });

  it("GET /chat/:id returns the transcript + meta; 404 when missing", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1", title: "t" });
    await chatStore.appendMessages("c1", [{ role: "user", content: "x" }]);

    const ok = await strut.app.request("/chat/c1");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { meta: any; messages: any[] };
    assert.equal(body.meta.id, "c1");
    assert.equal(body.messages.length, 1);

    const missing = await strut.app.request("/chat/missing");
    assert.equal(missing.status, 404);
  });

  it("GET /chat/:id/meta returns the meta alone (the idle poll's door); 404 when missing", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1", title: "t" });
    await chatStore.appendMessages("c1", [{ role: "user", content: "x" }]);

    const ok = await strut.app.request("/chat/c1/meta");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { id: string; currentTurn: number; messages?: unknown };
    assert.equal(body.id, "c1");
    assert.equal(body.currentTurn, -1);
    assert.equal(body.messages, undefined);

    assert.equal((await strut.app.request("/chat/missing/meta")).status, 404);
  });

  it("responses are gzipped for a client that accepts it — the SSE stream never", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1" });
    await chatStore.appendMessages("c1", [{ role: "user", content: "x".repeat(5000) }]);
    await chatStore.setMeta("c1", { status: "done", currentTurn: 0 });
    await chatStore.appendEvent("c1", { ts: new Date().toISOString(), chatId: "c1", turn: 0, type: "chat.end" });

    const gz = await strut.app.request("/chat/c1", { headers: { "accept-encoding": "gzip" } });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    const inflated = new Response(gz.body!.pipeThrough(new DecompressionStream("gzip")));
    const body = (await inflated.json()) as { messages: unknown[] };
    assert.equal(body.messages.length, 1);

    const plain = await strut.app.request("/chat/c1");
    assert.equal(plain.headers.get("content-encoding"), null);

    const sse = await strut.app.request("/chat/c1/stream?turn=0", { headers: { "accept-encoding": "gzip" } });
    assert.equal(sse.headers.get("content-encoding"), null);
    assert.match(await sse.text(), /event: done/);
  });

  it("GET /chats lists sessions", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "a" });
    await chatStore.createChat({ id: "b" });
    const res = await strut.app.request("/chats");
    const list = (await res.json()) as { id: string }[];
    assert.equal(list.length, 2);
  });

  it("GET /chat/:id/stream replays a completed turn then sends done", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1" });
    await chatStore.setMeta("c1", { status: "done", currentTurn: 0 });
    const ev = (type: ChatEvent["type"], extra: Partial<ChatEvent> = {}): ChatEvent => ({
      ts: new Date().toISOString(),
      chatId: "c1",
      turn: 0,
      type,
      ...extra,
    });
    await chatStore.appendEvent("c1", ev("text-delta", { delta: "hello" }));
    await chatStore.appendEvent("c1", ev("chat.end"));

    const res = await strut.app.request("/chat/c1/stream?turn=0");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("hello"), text);
    assert.ok(text.includes("event: done"), text);
  });

  it("GET /chat/:id/progress/:toolCallId returns a finished call's tool-progress outputs", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1" });
    await chatStore.setMeta("c1", { status: "done", currentTurn: 1 });
    const ev = (turn: number, type: ChatEvent["type"], extra: Partial<ChatEvent> = {}): ChatEvent => ({
      ts: new Date().toISOString(),
      chatId: "c1",
      turn,
      type,
      ...extra,
    });
    await chatStore.appendEvent("c1", ev(0, "tool-progress", { toolCallId: "w1", output: { n: 1 } }));
    await chatStore.appendEvent("c1", ev(0, "tool-progress", { toolCallId: "w1", output: { n: 2 } }));
    await chatStore.appendEvent("c1", ev(0, "tool-output", { toolCallId: "w1", output: { status: "done" } }));
    await chatStore.appendEvent("c1", ev(0, "chat.end"));
    await chatStore.appendEvent("c1", ev(1, "text-delta", { delta: "later" }));
    await chatStore.appendEvent("c1", ev(1, "chat.end"));

    const body = (await (await strut.app.request("/chat/c1/progress/w1")).json()) as { outputs: unknown[] };
    assert.deepEqual(body.outputs, [{ n: 1 }, { n: 2 }]);
    const none = (await (await strut.app.request("/chat/c1/progress/nope")).json()) as { outputs: unknown[] };
    assert.deepEqual(none.outputs, []);
    assert.equal((await strut.app.request("/chat/zz/progress/w1")).status, 404);
  });

  it("POST /chat is a 409 while that chat has a turn in progress", async () => {
    const strut = await makeStrut();
    const post = (body: object) =>
      strut.app.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await post({ message: "start" });
    assert.equal(first.status, 202);
    const { chatId } = (await first.json()) as { chatId: string };

    // The turn launched by the first POST is live in-process (it will fail
    // shortly for lack of an API key, but liveness is claimed synchronously).
    const second = await post({ chatId, message: "again" });
    assert.equal(second.status, 409);

    // A different chat is unaffected — chats run concurrently.
    const other = await post({ message: "elsewhere" });
    assert.equal(other.status, 202);
  });

  it("a chat left live by a dead process is reconciled to error on read", async () => {
    // Simulate a crash mid-turn: meta says live, events.jsonl has no
    // terminal for the turn, and nothing is running in this process.
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1" });
    await chatStore.setMeta("c1", { status: "live", currentTurn: 0 });
    await chatStore.appendEvent("c1", {
      ts: new Date().toISOString(),
      chatId: "c1",
      turn: 0,
      type: "text-delta",
      delta: "partial",
    });

    const get = await strut.app.request("/chat/c1");
    const { meta } = (await get.json()) as { meta: { status: string } };
    assert.equal(meta.status, "error");

    // The tail now terminates (would hang forever without the synthesized
    // chat.error) and reports the reconciled status.
    const res = await strut.app.request("/chat/c1/stream?turn=0");
    const text = await res.text();
    assert.ok(text.includes("chat.error"), text);
    assert.ok(text.includes('"status":"error"'), text);

    const list = (await (await strut.app.request("/chats")).json()) as { status: string }[];
    assert.equal(list[0]!.status, "error");
  });

  it("GET /chat/:id/stream for a not-yet-started turn sends done immediately", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1" }); // currentTurn -1
    const res = await strut.app.request("/chat/c1/stream?turn=3");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("event: done"), text);
  });

  it("GET /chat/:id/stream is a 404 for an unknown chat", async () => {
    const strut = await makeStrut();
    const res = await strut.app.request("/chat/missing/stream");
    assert.equal(res.status, 404);
  });

  // ── model picker ─────────────────────────────────────────────────────

  it("GET /llm/models lists the catalog with availability and never key values", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anthropic-secret-value";
    const strut = await makeStrut();
    const res = await strut.app.request("/llm/models");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      default: string;
      models: { alias: string; name: string; available: boolean; default: boolean }[];
      keyNames: Record<string, string>;
    };
    assert.equal(body.default, "anthropic/claude-sonnet-5-5");
    const by = (alias: string) => body.models.find((m) => m.alias === alias)!;
    assert.equal(by("sonnet").name, "anthropic/claude-sonnet-5-5");
    assert.equal(by("sonnet").available, true);
    assert.equal(by("gpt").available, false);
    assert.equal(body.keyNames["openai"], "OPENAI_API_KEY");
    assert.ok(!JSON.stringify(body).includes("secret-value"));
  });

  it("GET /llm/models sees a key in the secret store", async () => {
    const strut = await makeStrut();
    const put = await strut.app.request("/secrets/OPENROUTER_API_KEY", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "or-secret-value" }),
    });
    assert.ok(put.ok, `PUT /secrets: ${put.status}`);
    const body = (await (await strut.app.request("/llm/models")).json()) as {
      models: { alias: string; available: boolean }[];
    };
    assert.equal(body.models.find((m) => m.alias === "kimi")!.available, true);
    assert.equal(body.models.find((m) => m.alias === "sonnet")!.available, false);
    assert.ok(!JSON.stringify(body).includes("secret-value"));
  });

  it("POST /chat with a model whose provider has no key is a 400 and creates nothing", async () => {
    const strut = await makeStrut();
    const post = (body: object) =>
      strut.app.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const noKey = await post({ message: "hi", model: "openai/gpt-5" });
    assert.equal(noKey.status, 400);
    assert.match(((await noKey.json()) as { error: string }).error, /OPENAI_API_KEY/);

    // The no-prefix OpenRouter trap is caught here too, with the fix.
    const trap = await post({ message: "hi", model: "moonshotai/kimi-k2.6" });
    assert.equal(trap.status, 400);
    assert.match(((await trap.json()) as { error: string }).error, /openrouter\/moonshotai\/kimi-k2\.6/);

    const blank = await post({ message: "hi", model: "  " });
    assert.equal(blank.status, 400);

    assert.equal((await chatStore.listChats()).length, 0);
  });

  it("POST /chat records the picked model canonically and keeps it on later turns", async () => {
    const dead = await deadProvider();
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${dead.port}`;
    try {
      const strut = await makeStrut();
      const post = (body: object) =>
        strut.app.request("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      // Each turn settles (on the provider's 400) BEFORE its assertion: a
      // failed assertion must not leave a turn in flight when `finally`
      // closes the provider, or it retries ECONNREFUSED for ~6s and buries
      // the assertion under the retry trace.

      // An alias is accepted and stored in canonical form.
      const first = await post({ message: "start", model: "opus" });
      assert.equal(first.status, 202);
      const { chatId } = (await first.json()) as { chatId: string };
      await settled(chatId);
      assert.equal((await chatStore.getMeta(chatId))!.model, "anthropic/claude-opus-5-5");

      // No pick on the next turn → the chat keeps its model.
      assert.equal((await post({ chatId, message: "again" })).status, 202);
      await settled(chatId);
      assert.equal((await chatStore.getMeta(chatId))!.model, "anthropic/claude-opus-5-5");

      // A new pick on an existing chat switches it.
      assert.equal((await post({ chatId, message: "switch", model: "anthropic/claude-haiku-4-5" })).status, 202);
      await settled(chatId);
      assert.equal((await chatStore.getMeta(chatId))!.model, "anthropic/claude-haiku-4-5");

      // No pick at all → the deployment default, canonical.
      const fresh = await post({ message: "default" });
      const { chatId: id2 } = (await fresh.json()) as { chatId: string };
      await settled(id2);
      assert.equal((await chatStore.getMeta(id2))!.model, "claude-sonnet-5-5");
    } finally {
      dead.close();
    }
  });

  it("a turn on a chat whose model has no key ends in chat.error naming the secret", async () => {
    const strut = await makeStrut();
    await chatStore.createChat({ id: "c1", model: "openai/gpt-5" });
    const res = await strut.app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "c1", message: "go" }),
    });
    assert.equal(res.status, 202);
    await settled("c1");
    const text = await (await strut.app.request("/chat/c1/stream?turn=0")).text();
    assert.ok(text.includes("chat.error"), text);
    assert.ok(text.includes("OPENAI_API_KEY"), text);
  });
  /** A stand-in host: collects the callbacks a chat posts. */
  async function callbackHost(): Promise<{ url: string; posts: any[]; close: () => void }> {
    const posts: any[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push({ path: req.url, body: JSON.parse(body) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/hook?token=s3cret`, posts, close: () => server.close() };
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cond(), "condition never held");
  }

  it("POST /chat { callback } posts each turn end to the host, and never returns the URL", async () => {
    const strut = await makeStrut();
    const host = await callbackHost();
    try {
      const post = (body: unknown) =>
        strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      const res = await post({ message: "build it", callback: { url: host.url } });
      assert.equal(res.status, 202);
      const { chatId, callback } = (await res.json()) as { chatId: string; callback?: boolean };
      assert.equal(callback, true, "the host's proof this server honors callbacks");

      // No provider key → the turn fails at once; the host hears about it.
      await until(() => host.posts.length === 1);
      assert.equal(host.posts[0].path, "/hook?token=s3cret");
      const { error, ...payload } = host.posts[0].body;
      assert.deepEqual(payload, { event: "turn.end", chatId, turn: 0, status: "error", trigger: "human", settled: true, parked: false });
      assert.match(error.message, /ANTHROPIC_API_KEY/);

      // The URL is a credential: reads return its origin only.
      const origin = new URL(host.url).origin;
      const one = (await (await strut.app.request(`/chat/${chatId}`)).json()) as { meta: { callback: unknown } };
      assert.deepEqual(one.meta.callback, { origin });
      const list = (await (await strut.app.request("/chats")).json()) as Array<{ callback: unknown }>;
      assert.deepEqual(list[0]!.callback, { origin });
      assert.equal((await chatStore.getMeta(chatId))!.callback!.url, host.url);

      // It stays on the chat: a later turn without the field still posts…
      await settled(chatId);
      const again = await post({ chatId, message: "again" });
      assert.equal(((await again.json()) as { callback?: boolean }).callback, true);
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1].body.turn, 1);

      // …until it is cleared.
      await settled(chatId);
      const cleared = await post({ chatId, message: "quietly", callback: null });
      assert.equal(((await cleared.json()) as { callback?: boolean }).callback, undefined);
      await settled(chatId);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(host.posts.length, 2);
      assert.equal((await chatStore.getMeta(chatId))!.callback, undefined);
    } finally {
      host.close();
    }
  });

  it("a chat turn on anthropic asks for automatic prompt caching", async () => {
    // A stand-in provider: record the request, refuse it (400, not retried).
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const strut = await makeStrut();
      const res = await strut.app.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      const { chatId } = (await res.json()) as { chatId: string };
      await settled(chatId);
      assert.equal(bodies.length, 1);
      assert.deepEqual(bodies[0].cache_control, { type: "ephemeral" });
    } finally {
      server.close();
    }
  });

  it("chatSystem: the host's section rides in the system prompt, which is rendered once per chat and replayed verbatim", async () => {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const systemOf = (body: any): string => (typeof body.system === "string" ? body.system : body.system.map((b: { text: string }) => b.text).join(""));
    try {
      const seen: unknown[] = [];
      let section = "HOST-SECTION: what this deployment builds";
      const strut = await makeStrut({
        chatSystem: (ctx) => {
          seen.push(ctx);
          return section;
        },
      });
      const post = async (body: unknown) =>
        (await (await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as { chatId: string };

      const { chatId } = await post({ message: "hi" });
      await settled(chatId);
      assert.deepEqual(seen, [{ chatId, turn: 0 }]);
      const system = systemOf(bodies[0]);
      assert.ok(system.includes("HOST-SECTION: what this deployment builds"));
      assert.ok(system.indexOf("HOST-SECTION") < system.indexOf("Available steps:"), "strut's steps tree stays last");
      assert.equal(await chatStore.getSystem(chatId), system);

      // The host's section changes between turns: this chat's prompt does
      // not (the hook is not even asked), a new chat's does.
      section = "HOST-SECTION v2";
      await post({ chatId, message: "again" });
      await settled(chatId);
      assert.equal(seen.length, 1);
      assert.equal(systemOf(bodies[1]), system);
      const other = await post({ message: "new chat" });
      await settled(other.chatId);
      assert.ok(systemOf(bodies[2]).includes("HOST-SECTION v2"));
    } finally {
      server.close();
    }
  });

  it("chatSystem: a throwing hook never fails the turn", async () => {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const systemOf = (body: any): string => (typeof body.system === "string" ? body.system : JSON.stringify(body.system));
    try {
      const strut = await makeStrut({
        chatSystem: () => {
          throw new Error("graph is down");
        },
      });
      const res = await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
      const { chatId } = (await res.json()) as { chatId: string };
      await settled(chatId);
      // The model is still called, on strut's prompt alone.
      assert.equal(bodies.length, 1);
      assert.ok(!systemOf(bodies[0]).includes("HOST-SECTION"));
      assert.ok(systemOf(bodies[0]).includes("Available steps:"));
    } finally {
      server.close();
    }
  });

  it("POST /chat with a bad callback is a 400 and creates nothing", async () => {
    const strut = await makeStrut();
    for (const callback of [{}, { url: "nope" }, { url: "ftp://host/x" }, "https://host/x"]) {
      const res = await strut.app.request("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", callback }),
      });
      assert.equal(res.status, 400, JSON.stringify(callback));
    }
    assert.deepEqual(await chatStore.listChats(), []);
  });
  // ── compaction (plans/compaction.md §5) ──────────────────────────────

  /** A stand-in Anthropic endpoint that answers from a script, one reply per
   *  request, and records the request bodies. `input` is the input_tokens it
   *  reports — how a test puts the conversation past the compaction mark. */
  async function scripted(
    replies: Array<{ tool?: [string, string, unknown]; text?: string; input?: number }>,
    bodies: any[],
  ): Promise<{ port: number; close: () => void }> {
    const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    let call = 0;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        const r = replies[call++];
        if (!r) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `unexpected request #${call}` } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          sse({
            type: "message_start",
            message: {
              id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5",
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: r.input ?? 100, output_tokens: 1 },
            },
          }),
        );
        if (r.tool) {
          const [id, name, input] = r.tool;
          res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }));
          res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }));
          res.write(sse({ type: "content_block_stop", index: 0 }));
          res.write(sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }));
        } else {
          res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text ?? "" } }));
          res.write(sse({ type: "content_block_stop", index: 0 }));
          res.write(sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }));
        }
        res.write(sse({ type: "message_stop" }));
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as { port: number }).port, close: () => server.close() };
  }

  it("compaction: a turn past the mark folds its history into a [compaction] message and goes on from it; the next turn replays from there", async () => {
    const bodies: any[] = [];
    const s = await scripted(
      [
        { tool: ["toolu_1", "list_steps", { path: "steps" }], input: 950_000 }, // past the mark on a 1M window
        { text: "HANDOFF: the user asked which steps exist; list_steps was called; answer next." }, // the summarizer
        { text: "All set." }, // the turn goes on from the summary
        { text: "Still here." }, // the next turn
      ],
      bodies,
    );
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const strut = await makeStrut();
      const post = async (body: unknown) =>
        (await (await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as { chatId: string };
      const { chatId } = await post({ message: "what steps are there?" });
      await settled(chatId);
      assert.equal(bodies.length, 3, JSON.stringify(bodies.map((b) => b.messages.length)));
      const [first, summarizer, after] = bodies;

      // The summarizer's request: the turn's own prefix — system, tools,
      // cache_control, tool_choice — the conversation with the tool result
      // IN, then the instruction (one user message on the wire).
      assert.deepEqual(summarizer.system, first.system);
      assert.deepEqual(summarizer.tools, first.tools);
      assert.deepEqual(summarizer.cache_control, first.cache_control);
      assert.deepEqual(summarizer.tool_choice, first.tool_choice);
      const closing = JSON.stringify(summarizer.messages.at(-1));
      assert.ok(closing.includes("tool_result"), "the tool round is closed before the summary");
      assert.ok(closing.indexOf("tool_result") < closing.indexOf("respond with text only."));
      assert.equal(summarizer.max_tokens, 8000);

      // The continuation begins at the summary, and nothing earlier is sent.
      assert.equal(after.messages.length, 1);
      const compaction = JSON.stringify(after.messages[0]);
      assert.match(compaction, /\[compaction\] Compacted 3 messages \(~95\d+ tokens\)/);
      assert.ok(compaction.includes("HANDOFF:"));
      assert.ok(!compaction.includes("what steps are there?"));

      // The record is whole, the boundary is on the chat, the meter got its floor.
      const messages = await chatStore.loadMessages(chatId);
      assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "user", "assistant"]);
      assert.ok(String(messages[3]!.content).startsWith("[compaction]"));
      const meta = (await chatStore.getMeta(chatId))!;
      assert.equal(meta.replayFrom, 3);
      assert.equal(meta.context!.limit, 1_000_000);
      assert.ok(meta.context!.used < 1000, `context after the turn: ${meta.context!.used}`);
      const events: any[] = [];
      for await (const e of chatStore.tailEvents(chatId, 0)) events.push(e);
      const compact = events.find((e) => e.type === "chat.compact");
      assert.equal(compact.compact.messages, 3);
      assert.ok(compact.compact.usage.outputTokens > 0);
      assert.deepEqual(compact.context, { used: compact.compact.usage.outputTokens, limit: 1_000_000 });
      assert.equal(events.at(-1).type, "chat.end");

      // GET /chat/:id still serves everything.
      const whole = (await (await strut.app.request(`/chat/${chatId}`)).json()) as { messages: unknown[] };
      assert.equal(whole.messages.length, 5);

      // The next turn replays from the boundary: the compaction message, the
      // answer after it, the new message — nothing before.
      await post({ chatId, message: "and now?" });
      await settled(chatId);
      assert.equal(bodies.length, 4);
      assert.deepEqual(bodies[3].messages.map((m: any) => m.role), ["user", "assistant", "user"]);
      assert.ok(JSON.stringify(bodies[3].messages[0]).includes("[compaction]"));
      assert.ok(!JSON.stringify(bodies[3].messages).includes("what steps are there?"));
    } finally {
      s.close();
    }
  });

  it("compaction: a summarizer that fails is a warning — the turn goes on uncompacted and ends normally", async () => {
    const bodies: any[] = [];
    const s = await scripted(
      [
        { tool: ["toolu_1", "list_steps", { path: "steps" }], input: 950_000 },
        // the summarizer: no reply scripted → the stand-in answers 400
      ],
      bodies,
    );
    // The third request (the uncompacted continuation) also gets the 400:
    // the turn ends in chat.error on the provider's words, as any refused
    // request does — but the failed SUMMARY is not what fails it.
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const strut = await makeStrut();
      const res = await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
      const { chatId } = (await res.json()) as { chatId: string };
      await settled(chatId);
      assert.equal(bodies.length, 3);
      // The continuation carried the whole conversation, not a summary.
      assert.ok(JSON.stringify(bodies[2].messages).includes("hi"));
      assert.ok(!JSON.stringify(bodies[2].messages).includes("[compaction]"));
      const meta = (await chatStore.getMeta(chatId))!;
      assert.equal(meta.replayFrom, undefined);
      assert.equal(meta.status, "error");
      const messages = await chatStore.loadMessages(chatId);
      assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool"]);
    } finally {
      s.close();
    }
  });

  // ── stop (POST /chat/:id/cancel) ─────────────────────────────────────

  /** A stand-in provider that streams the start of a reply, then hangs — a
   *  turn on it stays live until stopped. */
  async function stuckProvider(): Promise<{ port: number; close: () => void }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", {
        message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello, part" } });
      // …and never finishes.
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: (server.address() as { port: number }).port,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it("POST /chat/:id/cancel is a 404 for an unknown chat and a 409 for an idle one", async () => {
    const strut = await makeStrut();
    assert.equal((await strut.app.request("/chat/missing/cancel", { method: "POST" })).status, 404);
    await chatStore.createChat({ id: "c1" });
    assert.equal((await strut.app.request("/chat/c1/cancel", { method: "POST" })).status, 409);
  });

  it("POST /chat/:id/cancel stops a live turn, keeps what streamed, and frees the chat", async () => {
    const stuck = await stuckProvider();
    const host = await callbackHost();
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${stuck.port}`;
    try {
      const strut = await makeStrut();
      const post = (body: unknown) =>
        strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const cancel = (id: string) => strut.app.request(`/chat/${id}/cancel`, { method: "POST" });

      const res = await post({ message: "go", callback: { url: host.url } });
      assert.equal(res.status, 202);
      const { chatId } = (await res.json()) as { chatId: string };

      // The partial reply has streamed into the log; the turn is still live.
      await until(() => (chatStore.events.get(chatId) ?? []).some((e) => e.type === "text-delta"));
      assert.equal((await chatStore.getMeta(chatId))!.status, "live");

      assert.equal((await cancel(chatId)).status, 200);
      await settled(chatId);
      assert.equal((await chatStore.getMeta(chatId))!.status, "done");

      // The turn ended as chat.end { stopped } — an attached tail finishes normally.
      const text = await (await strut.app.request(`/chat/${chatId}/stream?turn=0`)).text();
      assert.ok(text.includes('"type":"chat.end"') && text.includes('"stopped":true'), text);
      assert.ok(!text.includes("chat.error"), text);

      // The transcript holds exactly what streamed before the stop.
      const messages = await chatStore.loadMessages(chatId);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]!.role, "assistant");
      assert.deepEqual(messages[1]!.content, [{ type: "text", text: "Hello, part" }]);

      // The host hears a done-but-stopped turn, with the partial text…
      await until(() => host.posts.length === 1);
      const { body } = host.posts[0];
      assert.equal(body.status, "done");
      assert.equal(body.stopped, true);
      assert.equal(body.text, "Hello, part");

      // …and the chat is free for the next message. Stopping that one before
      // the model is even called ends it just as cleanly, with nothing added.
      assert.equal((await post({ chatId, message: "again" })).status, 202);
      assert.equal((await cancel(chatId)).status, 200);
      await settled(chatId);
      assert.equal((await chatStore.getMeta(chatId))!.status, "done");
      assert.equal((await chatStore.loadMessages(chatId)).length, 3);
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1].body.stopped, true);
      assert.equal(host.posts[1].body.text, undefined);
    } finally {
      stuck.close();
      host.close();
    }
  });

  // ── Elicitation (plans/elicitation.md) ───────────────────────────────

  const JSON_ = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const FORM: ElicitationRecord = {
    elicitationId: "e-form",
    toolCallId: "t1",
    turn: 0,
    createdAt: "2026-09-22T00:00:00.000Z",
    message: "Which repo?",
    mode: "form",
    requestedSchema: { type: "object", properties: { repo: { type: "string" }, env: { type: "string", enum: ["staging", "production"] } }, required: ["repo"] },
  };
  const SECRET: ElicitationRecord = {
    elicitationId: "e-secret",
    toolCallId: "t2",
    turn: 0,
    createdAt: "2026-09-22T00:00:00.000Z",
    message: "to post alerts",
    mode: "url",
    name: "SLACK_BOT_TOKEN",
    url: "?chat=c&elicit=e-secret",
    exists: false,
  };

  /** A chat parked on an open question, one finished turn behind it. */
  async function askedChat(record: ElicitationRecord, extra: Partial<ChatMeta> = {}): Promise<string> {
    const id = `c-${randomUUID().slice(0, 8)}`;
    await chatStore.createChat({ id });
    await chatStore.appendMessages(id, [{ role: "user", content: "hi" }]);
    await chatStore.setMeta(id, { status: "done", currentTurn: 0, elicitation: record, ...extra });
    return id;
  }
  const lastMessage = async (id: string) => (await chatStore.loadMessages(id)).at(-1)!.content;

  it("answering a form closes the question, records the answer, and launches a human turn", async () => {
    const strut = await makeStrut();
    const id = await askedChat(FORM, { autoTurns: 4 });
    const res = await strut.app.request(`/chat/${id}/elicitations/e-form`, JSON_({ action: "accept", content: { repo: "stakwork/strut", env: "staging" } }));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { chatId: id, turn: 1 });
    const meta = (await chatStore.getMeta(id))!;
    assert.equal(meta.elicitation, undefined);
    assert.equal(meta.currentTurn, 1);
    assert.equal(meta.autoTurns, 0, "a person answered");
    assert.equal(await lastMessage(id), '[elicitation-response] e-form accept\n{"repo":"stakwork/strut","env":"staging"}');
    await settled(id);
    // The question is closed: a second answer is a 404.
    assert.equal((await strut.app.request(`/chat/${id}/elicitations/e-form`, JSON_({ action: "decline" }))).status, 404);
  });

  it("an answer is checked — the action, the content by field, and which door a secret takes — and a refused one leaves the question open", async () => {
    const strut = await makeStrut();
    const form = await askedChat(FORM);
    const secret = await askedChat(SECRET);
    const answer = (id: string, eid: string, body: unknown) => strut.app.request(`/chat/${id}/elicitations/${eid}`, JSON_(body));
    const error = async (res: Response) => ((await res.json()) as { error: string }).error;

    let res = await answer(form, "e-form", { action: "nope" });
    assert.equal(res.status, 400);
    res = await answer(form, "e-form", { action: "accept", content: { env: "staging" } });
    assert.equal(res.status, 400);
    assert.match(await error(res), /content\.repo: is required/);
    res = await answer(form, "e-form", { action: "accept", content: { repo: "a/b", env: "dev" } });
    assert.equal(res.status, 400);
    assert.match(await error(res), /content\.env: must be one of staging \| production/);
    assert.equal((await answer(form, "e-other", { action: "cancel" })).status, 404);
    assert.equal((await answer("nope", "e-form", { action: "cancel" })).status, 404);
    // A secret is never accepted through the form door…
    res = await answer(secret, "e-secret", { action: "accept" });
    assert.equal(res.status, 400);
    assert.match(await error(res), /\/secret/);
    // …and a form never through the secret door.
    res = await strut.app.request(`/chat/${form}/elicitations/e-form/secret`, JSON_({ value: "x" }));
    assert.equal(res.status, 400);
    assert.equal((await strut.app.request(`/chat/${secret}/elicitations/e-secret/secret`, JSON_({}))).status, 400);

    assert.equal((await chatStore.getMeta(form))!.elicitation?.elicitationId, "e-form");
    assert.equal((await chatStore.getMeta(secret))!.elicitation?.elicitationId, "e-secret");
    assert.equal((await chatStore.getMeta(form))!.currentTurn, 0, "nothing launched");
  });

  it("declining a secret records the NAME and stores nothing", async () => {
    const secrets = new MemorySecretStore();
    const strut = await makeStrut({ secretStore: secrets });
    const id = await askedChat(SECRET);
    const res = await strut.app.request(`/chat/${id}/elicitations/e-secret`, JSON_({ action: "decline" }));
    assert.equal(res.status, 202);
    assert.equal(await lastMessage(id), "[elicitation-response] e-secret decline — secret SLACK_BOT_TOKEN not stored");
    assert.equal(await secrets.get("SLACK_BOT_TOKEN"), undefined);
    await settled(id);
  });

  it("a secret goes into the store under the recorded name — and nowhere else: transcript, events, meta, callbacks, logs, responses", async () => {
    const secrets = new MemorySecretStore();
    const strut = await makeStrut({ secretStore: secrets });
    const host = await callbackHost();
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    try {
      // A dispatched chat with a callback; its first turn fails at once (no key).
      const first = await strut.app.request("/chat", JSON_({ message: "post to slack", callback: { url: host.url } }));
      const { chatId } = (await first.json()) as { chatId: string };
      await settled(chatId);
      await until(() => host.posts.length === 1);
      await chatStore.setMeta(chatId, { elicitation: { ...SECRET, url: secretUrl(chatId, "e-secret") } });

      const SENTINEL = "xoxb-sentinel-9f8e7d6c5b4a";
      const res = await strut.app.request(`/chat/${chatId}/elicitations/e-secret/secret`, JSON_({ value: SENTINEL }));
      assert.equal(res.status, 202);
      const responseBody = await res.text();
      assert.equal(await secrets.get("SLACK_BOT_TOKEN"), SENTINEL);
      assert.equal(await lastMessage(chatId), "[elicitation-response] e-secret accept — secret SLACK_BOT_TOKEN stored (value not shown)");
      await settled(chatId);
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1].body.trigger, "human");
      assert.equal(host.posts[1].body.elicitation, undefined);
      assert.equal(host.posts[1].body.settled, true);

      const everything = [
        responseBody,
        JSON.stringify(await chatStore.loadMessages(chatId)),
        JSON.stringify(chatStore.events.get(chatId) ?? []),
        JSON.stringify(await chatStore.getMeta(chatId)),
        JSON.stringify(host.posts),
        await (await strut.app.request(`/chat/${chatId}`)).text(),
        await (await strut.app.request("/chats")).text(),
        await (await strut.app.request(`/chat/${chatId}/stream?turn=1`)).text(),
        logs.join("\n"),
      ].join("\n");
      assert.ok(!everything.includes(SENTINEL), "the secret value leaked");
      assert.ok(everything.includes("SLACK_BOT_TOKEN"), "the name is what everything carries");
    } finally {
      Object.assign(console, orig);
      host.close();
    }
  });

  it("the answer endpoints are gated by STRUT_API_KEY, and the actor is recorded — never checked against the chat's", async () => {
    const saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = "k";
    try {
      const strut = await makeStrut();
      const id = await askedChat(FORM, { actor: "bob-7" });
      assert.equal((await strut.app.request(`/chat/${id}/elicitations/e-form`, JSON_({ action: "cancel" }))).status, 401);
      const res = await strut.app.request(`/chat/${id}/elicitations/e-form`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer k", "x-strut-actor": "alice-42" },
        body: JSON.stringify({ action: "cancel" }),
      });
      assert.equal(res.status, 202);
      assert.equal(await lastMessage(id), "[elicitation-response] e-form cancel by alice-42");
      await settled(id);
    } finally {
      if (saved === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = saved;
    }
  });

  it("a typed message closes the open question", async () => {
    const strut = await makeStrut();
    const id = await askedChat(FORM);
    assert.equal((await strut.app.request("/chat", JSON_({ chatId: id, message: "forget it, use the default" }))).status, 202);
    assert.equal((await chatStore.getMeta(id))!.elicitation, undefined);
    await settled(id);
    assert.equal((await strut.app.request(`/chat/${id}/elicitations/e-form`, JSON_({ action: "accept", content: { repo: "a/b" } }))).status, 404);
  });

  it("an answer during a live turn queues (no 409) and the follow-up launches as a human turn", async () => {
    const stuck = await stuckProvider();
    const host = await callbackHost();
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${stuck.port}`;
    try {
      const strut = await makeStrut();
      const res = await strut.app.request("/chat", JSON_({ message: "go", callback: { url: host.url } }));
      const { chatId } = (await res.json()) as { chatId: string };
      await until(() => (chatStore.events.get(chatId) ?? []).some((e) => e.type === "text-delta"));
      // A question left open by an earlier turn, while this (notification-style) turn runs.
      await chatStore.setMeta(chatId, { elicitation: FORM });

      const answer = await strut.app.request(`/chat/${chatId}/elicitations/e-form`, JSON_({ action: "accept", content: { repo: "a/b" } }));
      assert.equal(answer.status, 202);
      assert.deepEqual(await answer.json(), { chatId, queued: true });
      assert.equal((await chatStore.getMeta(chatId))!.elicitation, undefined, "closed at once");

      // End the live turn: the drain launches the follow-up as a human turn.
      await strut.app.request(`/chat/${chatId}/cancel`, { method: "POST" });
      await until(() => host.posts.length === 1);
      assert.equal(host.posts[0].body.settled, false, "the follow-up is already live");
      assert.equal(host.posts[0].body.elicitation, undefined);
      for (let i = 0; i < 200 && (await chatStore.getMeta(chatId))!.currentTurn < 1; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal((await chatStore.getMeta(chatId))!.currentTurn, 1, "the drain launched the follow-up");
      assert.equal((await chatStore.loadMessages(chatId)).some((m) => m.content === '[elicitation-response] e-form accept\n{"repo":"a/b"}'), true);
      await strut.app.request(`/chat/${chatId}/cancel`, { method: "POST" });
      await settled(chatId);
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1].body.trigger, "human");
      assert.equal(host.posts[1].body.turn, 1);
    } finally {
      stuck.close();
      host.close();
    }
  });

  /** A stand-in provider whose FIRST reply is one tool call and every later
   *  reply plain text — so a loop that does not stop on the ask shows up as
   *  a second request. Records each request body; call N reports N×1000
   *  input tokens. */
  async function toolCallProvider(name: string, input: object): Promise<{ port: number; calls: () => number; bodies: any[]; close: () => void }> {
    let calls = 0;
    const bodies: any[] = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      bodies.push(JSON.parse(raw));
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", {
        message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: calls * 1000, output_tokens: 1 } },
      });
      if (calls === 1) {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "went on" } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
      }
      ev("message_stop", {});
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as { port: number }).port, calls: () => calls, bodies, close: () => server.close() };
  }

  it("a tool result is capped where it is made: the model's own turn reads the capped bytes and every later turn replays them unchanged", async () => {
    const fake = await toolCallProvider("bash", { command: "head -c 5000 /dev/zero | tr '\\0' x" });
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${fake.port}`;
    const prevCap = process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"];
    process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"] = "2000";
    try {
      const strut = await makeStrut();
      const { chatId } = (await (await strut.app.request("/chat", JSON_({ message: "look" }))).json()) as { chatId: string };
      await settled(chatId);
      assert.equal(fake.calls(), 2, "tool call, then the reply");

      // The turn that ran the tool already read the capped result…
      const sent = JSON.stringify(fake.bodies[1].messages);
      assert.ok(sent.includes("[TRUNCATED: 5000 chars, cut to 2000]"), sent.slice(0, 400));
      assert.ok(!sent.includes("x".repeat(2001)));
      // …and the transcript holds exactly that.
      const tool = (await chatStore.loadMessages(chatId)).find((m) => m.role === "tool") as any;
      assert.equal(tool.content[0].output.value.output.length, 2000);

      // The next turn replays the history byte-identical — system prompt included.
      await strut.app.request("/chat", JSON_({ chatId, message: "again" }));
      await settled(chatId);
      assert.equal(fake.calls(), 3);
      const before = fake.bodies[1].messages;
      assert.equal(JSON.stringify(fake.bodies[2].messages.slice(0, before.length)), JSON.stringify(before));
      assert.deepEqual(fake.bodies[2].system, fake.bodies[0].system);
    } finally {
      if (prevCap === undefined) delete process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"];
      else process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"] = prevCap;
      fake.close();
    }
  });

  it("every step records how full the context is: on its step.finish event and on the chat", async () => {
    const fake = await toolCallProvider("bash", { command: "echo hi" });
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${fake.port}`;
    try {
      const strut = await makeStrut();
      const { chatId } = (await (await strut.app.request("/chat", JSON_({ message: "look" }))).json()) as { chatId: string };
      await settled(chatId);
      // Step 1: 1000 in + 5 out; step 2: 2000 in + 2 out. claude-sonnet-5's window is 1M.
      const steps = chatStore.events.get(chatId)!.filter((e) => e.type === "step.finish");
      assert.deepEqual(steps.map((e) => e.context), [{ used: 1005, limit: 1_000_000 }, { used: 2002, limit: 1_000_000 }]);
      const got = (await (await strut.app.request(`/chat/${chatId}`)).json()) as { meta: ChatMeta };
      assert.deepEqual(got.meta.context, { used: 2002, limit: 1_000_000 });
    } finally {
      fake.close();
    }
  });

  it("a turn that calls ask_user ends on it: the question is on the chat, the host hears it as a field and as text", async () => {
    const requestedSchema = { type: "object", properties: { repo: { type: "string", title: "Repository" }, env: { type: "string", enum: ["staging", "production"] } }, required: ["repo"] };
    const fake = await toolCallProvider("ask_user", { message: "Which repo?", requestedSchema });
    const host = await callbackHost();
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${fake.port}`;
    try {
      const strut = await makeStrut();
      const res = await strut.app.request("/chat", JSON_({ message: "deploy it", callback: { url: host.url } }));
      const { chatId } = (await res.json()) as { chatId: string };
      await settled(chatId);
      const meta = (await chatStore.getMeta(chatId))!;
      assert.equal(meta.status, "done");
      const open = meta.elicitation!;
      assert.equal(open.mode, "form");
      assert.equal(open.message, "Which repo?");
      assert.equal(open.toolCallId, "toolu_1");
      assert.equal(open.turn, 0);
      assert.match(open.elicitationId, /^[A-Za-z0-9_-]{22}$/);
      assert.deepEqual(open.mode === "form" && open.requestedSchema, requestedSchema);

      // The turn stopped on the ask: one provider request, and the transcript
      // holds the complete call with its result.
      assert.equal(fake.calls(), 1);
      const transcript = JSON.stringify(await chatStore.loadMessages(chatId));
      assert.ok(transcript.includes('"status":"asked"'), transcript);
      assert.ok(transcript.includes(open.elicitationId));

      await until(() => host.posts.length === 1);
      const { body } = host.posts[0];
      assert.equal(body.settled, true);
      assert.deepEqual(body.elicitation, { elicitationId: open.elicitationId, mode: "form", message: "Which repo?", requestedSchema });
      assert.equal(body.text, 'Which repo?\n- repo "Repository" (string, required)\n- env (staging | production)');

      // The flyout's poll sees it too.
      const got = (await (await strut.app.request(`/chat/${chatId}`)).json()) as { meta: ChatMeta };
      assert.equal(got.meta.elicitation?.elicitationId, open.elicitationId);
    } finally {
      fake.close();
      host.close();
    }
  });

  it("a turn that calls request_secret ends on it with a relative link, and the link's answer stores the value", async () => {
    const secrets = new MemorySecretStore();
    const fake = await toolCallProvider("request_secret", { name: "SLACK_BOT_TOKEN", reason: "to post alerts" });
    const host = await callbackHost();
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${fake.port}`;
    try {
      const strut = await makeStrut({ secretStore: secrets });
      const res = await strut.app.request("/chat", JSON_({ message: "post to slack", callback: { url: host.url } }));
      const { chatId } = (await res.json()) as { chatId: string };
      await settled(chatId);
      const open = (await chatStore.getMeta(chatId))!.elicitation!;
      assert.equal(open.mode, "url");
      assert.equal(fake.calls(), 1);
      if (open.mode !== "url") throw new Error("unreachable");
      assert.equal(open.name, "SLACK_BOT_TOKEN");
      assert.equal(open.exists, false);
      assert.equal(open.url, `?chat=${chatId}&elicit=${open.elicitationId}`);

      await until(() => host.posts.length === 1);
      const { body } = host.posts[0];
      assert.deepEqual(body.elicitation, { elicitationId: open.elicitationId, mode: "url", message: "to post alerts", name: "SLACK_BOT_TOKEN", url: open.url });
      assert.ok((body.text as string).startsWith("The builder needs the secret SLACK_BOT_TOKEN: to post alerts"), body.text);

      // The page the link opens posts the value; it lands under the recorded name.
      const done = await strut.app.request(`/chat/${chatId}/elicitations/${open.elicitationId}/secret`, JSON_({ value: "xoxb-1" }));
      assert.equal(done.status, 202);
      assert.equal(await secrets.get("SLACK_BOT_TOKEN"), "xoxb-1");
      assert.equal(await lastMessage(chatId), `[elicitation-response] ${open.elicitationId} accept — secret SLACK_BOT_TOKEN stored (value not shown)`);
      await settled(chatId);
      // The follow-up turn asked nothing (the fake's second reply is text): the host hears no elicitation.
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1].body.elicitation, undefined);
      assert.equal(host.posts[1].body.text, "went on");
    } finally {
      fake.close();
      host.close();
    }
  });

  it("a refused ask (a credential-looking field) does not end the turn: the model reads the error and goes on", async () => {
    const fake = await toolCallProvider("ask_user", { message: "Token?", requestedSchema: { type: "object", properties: { apiKey: { type: "string" } } } });
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${fake.port}`;
    try {
      const strut = await makeStrut();
      const res = await strut.app.request("/chat", JSON_({ message: "connect" }));
      const { chatId } = (await res.json()) as { chatId: string };
      await settled(chatId);
      assert.equal((await chatStore.getMeta(chatId))!.elicitation, undefined);
      assert.equal(fake.calls(), 2, "the loop went on to a second model call");
      const transcript = JSON.stringify(await chatStore.loadMessages(chatId));
      assert.ok(transcript.includes("looks like a credential"), transcript);
      assert.ok(transcript.includes("went on"));
    } finally {
      fake.close();
    }
  });

});
