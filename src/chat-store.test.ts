import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  FileChatStore,
  MemoryChatStore,
  capToolOutput,
  truncateToolMessages,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  toolResultMaxCharsFromEnv,
  isChatTerminal,
  generateChatId,
  type ChatEvent,
} from "./chat-store.js";

const ev = (
  chatId: string,
  turn: number,
  type: ChatEvent["type"],
  extra: Partial<ChatEvent> = {},
): ChatEvent => ({
  ts: new Date().toISOString(),
  chatId,
  turn,
  type,
  ...extra,
});

// ── MemoryChatStore ────────────────────────────────────────────────────────

describe("MemoryChatStore", () => {
  it("creates a chat with status live and currentTurn -1", async () => {
    const store = new MemoryChatStore();
    const meta = await store.createChat({ id: "c1", title: "hi" });
    assert.equal(meta.status, "live");
    assert.equal(meta.currentTurn, -1);
    assert.equal(meta.title, "hi");
    assert.deepEqual(await store.getMeta("c1"), meta);
  });

  it("appends + loads messages losslessly", async () => {
    const store = new MemoryChatStore();
    await store.createChat({ id: "c1" });
    await store.appendMessages("c1", [{ role: "user", content: "a" }]);
    await store.appendMessages("c1", [{ role: "assistant", content: "b" }]);
    assert.deepEqual(await store.loadMessages("c1"), [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  it("setMeta patches + bumps updatedAt; returns null for missing chat", async () => {
    const store = new MemoryChatStore();
    await store.createChat({ id: "c1" });
    const next = await store.setMeta("c1", { status: "done", currentTurn: 0 });
    assert.equal(next?.status, "done");
    assert.equal(next?.currentTurn, 0);
    assert.equal(await store.setMeta("missing", { status: "done" }), null);
  });

  it("tailEvents yields only the requested turn and stops at its terminal", async () => {
    const store = new MemoryChatStore();
    await store.createChat({ id: "c1" });
    await store.appendEvent("c1", ev("c1", 0, "text-delta", { delta: "x" }));
    await store.appendEvent("c1", ev("c1", 0, "chat.end"));
    await store.appendEvent("c1", ev("c1", 1, "text-delta", { delta: "y" }));
    await store.appendEvent("c1", ev("c1", 1, "chat.end"));

    const turn1: ChatEvent[] = [];
    for await (const e of store.tailEvents("c1", 1)) turn1.push(e);
    assert.deepEqual(turn1.map((e) => e.type), ["text-delta", "chat.end"]);
    assert.equal(turn1[0]!.delta, "y");
  });

  it("listChats sorts newest-updated first", async () => {
    const store = new MemoryChatStore();
    await store.createChat({ id: "a" });
    await new Promise((r) => setTimeout(r, 5));
    await store.createChat({ id: "b" });
    await store.setMeta("a", { status: "done" }); // touches updatedAt
    const list = await store.listChats();
    assert.equal(list[0]!.id, "a");
  });
});

// ── FileChatStore ──────────────────────────────────────────────────────────

describe("FileChatStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-chat-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists meta.json + messages.jsonl + events.jsonl under chats/<id>/", async () => {
    const store = new FileChatStore(tempDir);
    await store.createChat({ id: "c1", title: "t", model: "m" });
    await store.appendMessages("c1", [{ role: "user", content: "hello" }]);
    await store.appendEvent("c1", ev("c1", 0, "text-delta", { delta: "hi" }));

    const meta = JSON.parse(
      await readFile(join(tempDir, "chats", "c1", "meta.json"), "utf-8"),
    );
    assert.equal(meta.id, "c1");
    assert.equal(meta.model, "m");

    const msgs = await readFile(join(tempDir, "chats", "c1", "messages.jsonl"), "utf-8");
    assert.equal(msgs.trim().split("\n").length, 1);

    const events = await readFile(join(tempDir, "chats", "c1", "events.jsonl"), "utf-8");
    assert.ok(events.includes('"text-delta"'));
  });

  it("loadMessages survives a fresh store instance (durable)", async () => {
    const a = new FileChatStore(tempDir);
    await a.createChat({ id: "c1" });
    await a.appendMessages("c1", [{ role: "user", content: "x" }]);

    const b = new FileChatStore(tempDir);
    assert.deepEqual(await b.loadMessages("c1"), [{ role: "user", content: "x" }]);
  });

  it("tailEvents drains a completed turn then returns", async () => {
    const store = new FileChatStore(tempDir);
    await store.createChat({ id: "c1" });
    await store.appendEvent("c1", ev("c1", 0, "text-delta", { delta: "a" }));
    await store.appendEvent("c1", ev("c1", 0, "tool-input", { toolName: "x" }));
    await store.appendEvent("c1", ev("c1", 0, "chat.end"));

    const seen: ChatEvent[] = [];
    for await (const e of store.tailEvents("c1", 0, { intervalMs: 10 })) seen.push(e);
    assert.deepEqual(seen.map((e) => e.type), ["text-delta", "tool-input", "chat.end"]);
  });

  it("tailEvents replays a multi-turn log but stops at the requested turn's terminal", async () => {
    const store = new FileChatStore(tempDir);
    await store.createChat({ id: "c1" });
    await store.appendEvent("c1", ev("c1", 0, "text-delta", { delta: "0" }));
    await store.appendEvent("c1", ev("c1", 0, "chat.end"));
    await store.appendEvent("c1", ev("c1", 1, "text-delta", { delta: "1" }));
    await store.appendEvent("c1", ev("c1", 1, "chat.end"));

    const seen: ChatEvent[] = [];
    for await (const e of store.tailEvents("c1", 1, { intervalMs: 10 })) seen.push(e);
    assert.deepEqual(seen.map((e) => e.delta), ["1", undefined]);
    assert.deepEqual(seen.map((e) => e.type), ["text-delta", "chat.end"]);
  });

  it("tailEvents follows a live turn until its terminal (detached reattach)", async () => {
    const store = new FileChatStore(tempDir);
    await store.createChat({ id: "c1" });
    await store.appendEvent("c1", ev("c1", 0, "text-delta", { delta: "start" }));

    const seen: ChatEvent[] = [];
    const consume = (async () => {
      for await (const e of store.tailEvents("c1", 0, { intervalMs: 10 })) seen.push(e);
    })();

    await new Promise((r) => setTimeout(r, 30));
    await store.appendEvent("c1", ev("c1", 0, "tool-input", { toolName: "run_workflow" }));
    await new Promise((r) => setTimeout(r, 30));
    await store.appendEvent("c1", ev("c1", 0, "chat.end"));

    await consume;
    assert.deepEqual(seen.map((e) => e.type), ["text-delta", "tool-input", "chat.end"]);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

describe("capToolOutput", () => {
  /** The rows of a query nobody limited: each string short, the whole huge. */
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ref: randomUUID(), name: `finding ${i}`, status: "open", nBoxes: i % 7, cwe: null }));
  const runResult = (n: number) => ({
    type: "json",
    value: { runId: "1793613172155", status: "success", output: { rows: [{ rows: rows(n), total: n }] }, claims: [], verify: "pending" },
  });

  it("cuts a long string to the cap, marker included", () => {
    const out = capToolOutput({ type: "text", value: "x".repeat(5000) }, 1000);
    assert.equal(out.value.length, 1000);
    assert.ok(out.value.endsWith("[TRUNCATED: 5000 chars, cut to 1000]"), out.value.slice(-60));
  });

  it("caps the result as a whole: what the model reads of it fits, structure kept", () => {
    const out = capToolOutput({ type: "json", value: { log: "x".repeat(5000), ok: true, n: 3, list: ["short"] } }, 1000);
    assert.ok(JSON.stringify(out.value).length <= 1000, String(JSON.stringify(out.value).length));
    assert.match(out.value.log, /\[TRUNCATED: 5000 chars, cut to \d+\]$/);
    assert.deepEqual({ ...out.value, log: "" }, { log: "", ok: true, n: 3, list: ["short"] });
  });

  it("cuts thousands of short rows to their first and last, the rest of the result whole (swarm38, 2026-11-02)", () => {
    const value = runResult(5622);
    assert.ok(JSON.stringify(value.value).length > 400_000, "over the cap as a whole, every string short");
    const out = capToolOutput(value, 50_000);
    assert.ok(JSON.stringify(out.value).length <= 50_000, String(JSON.stringify(out.value).length));
    const kept = out.value.output.rows[0]!.rows as Array<Record<string, unknown>>;
    const at = kept.findIndex((r) => "omitted" in r);
    const gap = kept[at] as { omitted: number; from: number; to: number };
    assert.deepEqual(gap, { omitted: 5622 - (kept.length - 1), from: at, to: at + gap.omitted - 1 });
    const objects = kept.filter((r) => !("omitted" in r));
    assert.ok(objects.length > 50, `rows kept: ${objects.length}`);
    assert.deepEqual(objects[0], value.value.output.rows[0]!.rows[0], "the first row, whole");
    assert.deepEqual(objects.at(-1), value.value.output.rows[0]!.rows.at(-1), "the last row, whole");
    // Everything beside the rows is as the tool returned it.
    assert.deepEqual({ ...out.value, output: null }, { ...value.value, output: null });
    assert.equal(out.value.output.rows[0]!.total, 5622);
    // An array that fits is not cut.
    const small = runResult(20);
    assert.deepEqual(capToolOutput(small, 50_000), small);
  });

  it("a result that keeps no structure in the cap is the head of its JSON, as text", () => {
    const value = { type: "json", value: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`key${i}`, i])) };
    const out = capToolOutput(value, 1000) as unknown as { type: string; value: string };
    assert.equal(out.type, "text");
    assert.equal(out.value.length, 1000);
    assert.ok(out.value.startsWith('{"key0":0,"key1":1'));
    assert.match(out.value, /\[TRUNCATED: \d+ chars, cut to 1000\]$/);
  });

  it("is idempotent: a capped result passes a second time byte-identical", () => {
    const once = capToolOutput({ type: "text", value: "y".repeat(80_000) }, 50_000);
    assert.equal(JSON.stringify(capToolOutput(once, 50_000)), JSON.stringify(once));
    const rowsOnce = capToolOutput(runResult(3000), 20_000);
    assert.equal(JSON.stringify(capToolOutput(rowsOnce, 20_000)), JSON.stringify(rowsOnce));
    // A cap shorter than the marker still holds the cap (and stays idempotent).
    const tiny = capToolOutput("z".repeat(100), 10);
    assert.equal(tiny, "z".repeat(10));
    assert.equal(capToolOutput(tiny, 10), tiny);
  });

  it("leaves binary parts whole and uncounted, and never cuts a content result's parts", () => {
    const file = { type: "file-data", data: "A".repeat(5000), mediaType: "image/png" };
    const out = capToolOutput({ type: "content", value: [{ type: "text", text: "t".repeat(5000) }, file] }, 1000);
    assert.equal(out.value.length, 2);
    assert.equal(out.value[0]!.text!.length, 1000);
    assert.equal(out.value[1], file);
  });
});

describe("truncateToolMessages", () => {
  const big = "x".repeat(5000);
  const answer = { role: "assistant", content: [{ type: "text", text: "done" }] };

  it("a result the model has read: its long strings cut as before, nothing else", () => {
    const out = truncateToolMessages(
      [
        { role: "assistant", content: [{ type: "text", text: big }] },
        { role: "tool", content: [{ type: "tool-result", output: { type: "json", value: { log: big, ok: true } } }] },
        answer,
      ],
      4000,
    );
    // Assistant message untouched (only role:"tool" is trimmed).
    assert.equal((out[0]!.content as any)[0].text.length, 5000);
    // Tool result truncated + marked, to the string cap exactly.
    const toolText = (out[1]!.content as any)[0].output.value.log as string;
    assert.equal(toolText.length, 4000);
    assert.ok(toolText.includes("[TRUNCATED"));
    // A no-op on a history whose results were capped at the source.
    assert.deepEqual(truncateToolMessages(out, 4000), out);
  });

  it("a result read as a whole over the cap is replayed as recorded: the prompt's prefix is bound to it", () => {
    const value = { rows: Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}` })) };
    const msgs = [{ role: "tool", content: [{ type: "tool-result", toolName: "run_workflow", output: { type: "json", value } }] }, answer];
    assert.deepEqual(truncateToolMessages(msgs, 4000), msgs);
  });

  it("a result no assistant message came after gets the whole cap, so a turn can be sent again", () => {
    const value = { rows: Array.from({ length: 500 }, (_, i) => ({ id: `row-${i}` })) };
    const msgs = [
      answer,
      { role: "tool", content: [{ type: "tool-result", toolName: "run_workflow", output: { type: "json", value } }] },
      { role: "user", content: "[verify-notification] …" },
      { role: "user", content: "status?" },
    ];
    const out = truncateToolMessages(msgs, 4000);
    const capped = (out[1]!.content as any)[0].output.value;
    assert.ok(JSON.stringify(capped).length <= 4000, String(JSON.stringify(capped).length));
    assert.ok(capped.rows.some((r: object) => "omitted" in r), "the rows cut, a gap in place of the rest");
    assert.deepEqual(out.slice(2), msgs.slice(2));
    assert.deepEqual(truncateToolMessages(out, 4000), out, "and once capped, it stays");
  });

  it("leaves short tool content unchanged", () => {
    const msgs = [{ role: "tool", content: [{ type: "tool-result", output: "ok" }] }];
    assert.deepEqual(truncateToolMessages(msgs, 4000), msgs);
  });

  it("never re-cuts a document read (get_workflow / get_step): it was cut to the window, not this number", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolName: "get_workflow", toolCallId: "a", output: { type: "json", value: { yaml: big } } },
          { type: "tool-result", toolName: "list_runs", toolCallId: "b", output: { type: "json", value: { log: big } } },
        ],
      },
    ];
    const out = truncateToolMessages(msgs, 4000);
    const [doc, other] = out[0]!.content as any[];
    assert.equal(doc.output.value.yaml.length, 5000);
    assert.ok(JSON.stringify(other.output.value).length <= 4000);
    assert.ok(other.output.value.log.includes("[TRUNCATED"));
  });

  it("defaults to 50k chars and can be disabled with 0", () => {
    const big = "x".repeat(60_000);
    const msgs = [{ role: "tool", content: [{ type: "tool-result", output: big }] }];
    assert.equal(DEFAULT_TOOL_RESULT_MAX_CHARS, 50_000);
    assert.ok(((truncateToolMessages(msgs)[0]!.content as any)[0].output as string).includes("[TRUNCATED"));
    assert.deepEqual(truncateToolMessages(msgs, 0), msgs);
  });

  it("reads the cap from STRUT_CHAT_TOOL_RESULT_MAX_CHARS", () => {
    const prev = process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"];
    try {
      process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"] = "10";
      assert.equal(toolResultMaxCharsFromEnv(), 10);
      process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"] = "garbage";
      assert.equal(toolResultMaxCharsFromEnv(), DEFAULT_TOOL_RESULT_MAX_CHARS);
      delete process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"];
      assert.equal(toolResultMaxCharsFromEnv(), DEFAULT_TOOL_RESULT_MAX_CHARS);
    } finally {
      if (prev === undefined) delete process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"];
      else process.env["STRUT_CHAT_TOOL_RESULT_MAX_CHARS"] = prev;
    }
  });
});

describe("isChatTerminal / generateChatId", () => {
  it("flags chat.end and chat.error as terminal", () => {
    assert.equal(isChatTerminal(ev("c", 0, "chat.end")), true);
    assert.equal(isChatTerminal(ev("c", 0, "chat.error")), true);
    assert.equal(isChatTerminal(ev("c", 0, "text-delta")), false);
  });

  it("generates unique-ish sortable ids", () => {
    const a = generateChatId();
    const b = generateChatId();
    assert.notEqual(a, b);
    assert.match(a, /^[a-z0-9]+-[a-z0-9]+$/);
  });
});
