import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StoredMessage } from "./chat-store.js";
import { buildChatView, foldChatTurns } from "./chat-view.js";
import { formatRunNotification } from "./ai/notifier.js";
import { COMPACTION_PREFIX } from "./compaction.js";
import { ATTACHMENT_PREFIX } from "./ai/attachments.js";

// The chat fold (src/chat-view.ts): stored model messages → turns with the
// caller's text, the builder's answer and what it DID, folded from the tool
// calls by name over the builder tools' own result shapes.

const user = (text: string): StoredMessage => ({ role: "user", content: text });
const assistant = (text: string, ...calls: Array<{ id: string; name: string; input: unknown }>): StoredMessage => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map((c) => ({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: c.input })),
  ],
});
const results = (...rs: Array<{ id: string; name: string; value: unknown; error?: boolean }>): StoredMessage => ({
  role: "tool",
  content: rs.map((r) => ({ type: "tool-result", toolCallId: r.id, toolName: r.name, output: { type: r.error ? "error-json" : "json", value: r.value } })),
});

/** A turn that publishes a workflow, runs it, and answers. */
const BUILD: StoredMessage[] = [
  user("Make me a daily report workflow"),
  assistant("Let me look.", { id: "c1", name: "list_steps", input: { path: "steps" } }),
  results({ id: "c1", name: "list_steps", value: { entries: ["core/", "lib/"] } }),
  assistant("", { id: "c2", name: "create_workflow", input: { name: "daily-report", yaml: "name: daily-report\nsteps: []" } }),
  results({ id: "c2", name: "create_workflow", value: { ok: true, name: "daily-report", version: "v1", ui: "https://s.example/?wf=daily-report" } }),
  assistant("", { id: "c3", name: "run_workflow", input: { name: "daily-report", input: {} } }),
  results({
    id: "c3",
    name: "run_workflow",
    value: { runId: "1700", status: "success", output: { report: "x".repeat(500) }, durationMs: 12, artifacts: [{ id: "report", title: "Report", url: "https://s.example/artifacts/1700/report.md?t=abc" }], ui: "https://s.example/?wf=daily-report&run=1700" },
  }),
  assistant("", { id: "c4", name: "set_automation", input: { workflow: "daily-report", trigger: { kind: "day", at: "09:00" } } }),
  results({ id: "c4", name: "set_automation", value: { ok: true, automation: { id: "a1", workflow: "daily-report", summary: "Every day at 09:00" }, next: ["2026-10-20T09:00:00Z", "2026-10-21T09:00:00Z"] } }),
  assistant("Published daily-report v1, ran it once (the report is at https://s.example/artifacts/1700/report.md?t=abc) and scheduled it every day at 09:00."),
];

describe("foldChatTurns", () => {
  it("one turn per caller message: its text, the builder's final text, and what the tool calls did", () => {
    const [t, ...rest] = foldChatTurns(BUILD);
    assert.equal(rest.length, 0);
    assert.equal(t!.at, 0);
    assert.equal(t!.you, "Make me a daily report workflow");
    assert.match(t!.text!, /^Published daily-report v1/);
    assert.equal(t!.toolCalls, 4);
    assert.deepEqual(t!.did, {
      workflows: [{ name: "daily-report", version: "v1", action: "created", ui: "https://s.example/?wf=daily-report" }],
      runs: [{ workflow: "daily-report", runId: "1700", status: "success", artifacts: [{ id: "report", title: "Report", url: "https://s.example/artifacts/1700/report.md?t=abc" }], ui: "https://s.example/?wf=daily-report&run=1700" }],
      automations: [{ workflow: "daily-report", id: "a1", summary: "Every day at 09:00", next: "2026-10-20T09:00:00Z", action: "set" }],
    });
    // The read-only call left nothing in `did`; the calls are kept for `detail`.
    assert.equal(t!.tools!.length, 4);
    assert.equal(t!.tools![0]!.name, "list_steps");
    assert.deepEqual(t!.tools![0]!.result, { entries: ["core/", "lib/"] });
  });

  it("a server notice starts a turn of its own, named by its first line; queued notices share one; a compaction marks the turn", () => {
    const notice = formatRunNotification({ workflow: "daily-report", runId: "1800", status: "success", durationMs: 90_000, output: { big: "y".repeat(5000) } });
    const msgs: StoredMessage[] = [
      ...BUILD,
      user(notice),
      user(formatRunNotification({ workflow: "daily-report", runId: "1801", status: "error", error: { message: "boom" } })),
      assistant("Run 1800 finished; 1801 failed with boom, looking.", { id: "c5", name: "get_run", input: { name: "daily-report", runId: "1801" } }),
      results({ id: "c5", name: "get_run", value: { status: "error" } }),
      user(`${COMPACTION_PREFIX} summary of everything so far`),
      assistant("The failure was a missing secret."),
      user("ok, fix it"),
      assistant("", { id: "c6", name: "edit_workflow", input: { name: "daily-report", edits: [] } }),
      results({ id: "c6", name: "edit_workflow", value: { ok: true, name: "daily-report", version: "v2", changed: true } }),
      assistant("Fixed in v2."),
    ];
    const turns = foldChatTurns(msgs);
    assert.equal(turns.length, 3);
    const woke = turns[1]!;
    assert.equal(woke.you, undefined);
    assert.deepEqual(woke.notices, [
      '[run-notification] Workflow "daily-report" run 1800 finished: success in 1m 30s.',
      '[run-notification] Workflow "daily-report" run 1801 finished: error.',
    ]);
    assert.equal(woke.text, "The failure was a missing secret.", "the LAST text of the turn");
    assert.equal(woke.compacted, true);
    assert.equal(woke.did?.runs, undefined, "a read is not an effect");
    const fix = turns[2]!;
    assert.equal(fix.you, "ok, fix it");
    assert.deepEqual(fix.did, { workflows: [{ name: "daily-report", version: "v2", action: "edited" }] });
  });

  it("a detached run then its result: one entry, the later status winning; a failed tool is marked; a question is recorded; attachments by name", () => {
    const msgs: StoredMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this" },
          { type: "text", text: `${ATTACHMENT_PREFIX} shot.png (image/png, 12 kB) — saved at /data/uploads/c/shot.png` },
          { type: "file", mediaType: "image/png", data: "AAAA" },
        ],
      },
      assistant("", { id: "r1", name: "run_workflow", input: { name: "slow", input: {} } }),
      results({ id: "r1", name: "run_workflow", value: { status: "running", detached: true, runId: "1900", workflow: "slow" } }),
      assistant("", { id: "r2", name: "get_run", input: { name: "slow", runId: "1900", wait: 30000 } }),
      results({ id: "r2", name: "get_run", value: { status: "success" } }),
      assistant("", { id: "r3", name: "run_workflow", input: { name: "missing", input: {} } }),
      results({ id: "r3", name: "run_workflow", value: { ok: false, error: "Workflow not found: missing" }, error: true }),
      assistant("", { id: "r4", name: "ask_user", input: { message: "Which repo?", requestedSchema: { type: "object", properties: { repo: { type: "string" } } } } }),
      results({ id: "r4", name: "ask_user", value: { elicitationId: "e1", status: "asked" } }),
    ];
    const [t] = foldChatTurns(msgs);
    assert.equal(t!.you, "Analyze this\nattached: shot.png (image/png, 12 kB)");
    assert.deepEqual(t!.did?.runs, [{ workflow: "slow", runId: "1900", status: "running" }], "no runId on the failed launch, so no entry");
    assert.equal(t!.tools![2]!.isError, true);
    assert.deepEqual(t!.asked, { mode: "form", message: "Which repo?", fields: ["repo"] });
    assert.equal(t!.text, undefined);
  });
});

describe("buildChatView", () => {
  it("effects by default, tool previews on request, whole calls with full; the cursor is the log's length", () => {
    const effects = buildChatView(BUILD);
    assert.equal(effects.cursor, BUILD.length);
    assert.equal(effects.turns[0]!.tools, undefined);
    assert.equal(effects.turns[0]!.toolCalls, 4);
    assert.match(effects.hint!, /detail: "tools"/);

    const tools = buildChatView(BUILD, { detail: "tools" });
    const run = tools.turns[0]!.tools![2]!;
    assert.equal(run.name, "run_workflow");
    assert.deepEqual(run.input, JSON.stringify({ name: "daily-report", input: {} }));
    assert.ok(String(run.result).length <= 320 && String(run.result).includes("chars]"), String(run.result));

    const full = buildChatView(BUILD, { detail: "full" });
    assert.deepEqual(full.turns[0]!.tools![2]!.input, { name: "daily-report", input: {} });
    assert.equal(full.hint, undefined);
  });

  it("since reads from a cursor; limit keeps the newest turns and says what it left out", () => {
    const msgs: StoredMessage[] = [];
    for (let i = 0; i < 5; i++) msgs.push(user(`q${i}`), assistant(`a${i}`));
    const all = buildChatView(msgs);
    assert.deepEqual(all.turns.map((t) => t.you), ["q0", "q1", "q2", "q3", "q4"]);
    assert.deepEqual(all.turns.map((t) => t.at), [0, 2, 4, 6, 8]);

    const tail = buildChatView(msgs, { since: 6 });
    assert.deepEqual(tail.turns.map((t) => t.you), ["q3", "q4"]);
    assert.equal(tail.cursor, 10);

    const two = buildChatView(msgs, { limit: 2 });
    assert.deepEqual(two.turns.map((t) => t.you), ["q3", "q4"]);
    assert.equal(two.omitted, 3);
    assert.match(two.hint!, /3 earlier turns left out: read with since: 0, limit: 3 to see up to message 6/);
  });

  it("the budget cuts the text first, then drops the oldest turns", () => {
    const msgs: StoredMessage[] = [];
    for (let i = 0; i < 4; i++) msgs.push(user(`q${i}`), assistant(`${i}`.repeat(4000)));
    const view = buildChatView(msgs, { maxChars: 3_500 });
    assert.ok(JSON.stringify({ turns: view.turns }).length <= 3_500);
    assert.equal(view.turns[view.turns.length - 1]!.you, "q3", "the newest turn stays");
    assert.match(view.turns[view.turns.length - 1]!.text!, /\[cut, 4000 chars\]$/);
    assert.ok(view.omitted! >= 1);
    assert.match(view.hint!, /over the budget/);
  });
});
