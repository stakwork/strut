import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachResult, groupStatus, transcriptText, transcriptToEntries } from "./transcript.js";

// Stored AI SDK model messages, as `GET /chat/:id` and a run's
// `…/transcripts/<path>?full=1` serve them.
const messages = [
  { role: "system", content: "You are the job agent." },
  { role: "user", content: "Plan it." },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Looking." },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
      { type: "tool-call", toolCallId: "c2", toolName: "bash", input: { command: "cat plan.md" } },
      { type: "tool-call", toolCallId: "c3", toolName: "graph_graph_get", input: { name: "Job" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "c1", output: { type: "text", value: "plan.md" } },
      { type: "tool-result", toolCallId: "c2", output: { type: "error-text", value: "no such file" } },
      { type: "tool-result", toolCallId: "c3", output: { type: "json", value: { name: "Job" } } },
    ],
  },
  { role: "assistant", content: "Done." },
  // Turn 1 of the thread.
  { role: "user", content: "[run-notification] run 1 of wf ended: success" },
  { role: "assistant", content: [{ type: "text", text: "Noted." }] },
];

describe("transcript", () => {
  it("folds messages into bubbles and tool chips, results attached to their calls, the system prompt left out", () => {
    const entries = transcriptToEntries(messages);
    assert.deepEqual(
      entries.map((e) => (e.kind === "tool" ? ["tool", e.groups.map((g) => [g.name, g.calls.length])] : [e.kind, e.content.slice(0, 12)])),
      [["user", "Plan it."], ["text", "Looking."], ["tool", [["bash", 2], ["graph_graph_get", 1]]], ["text", "Done."], ["notice", "[run-notific"], ["text", "Noted."]],
    );
    const tool = entries[2]!;
    assert.equal(tool.kind, "tool");
    if (tool.kind !== "tool") return;
    assert.deepEqual(tool.groups[0]!.calls.map((c) => c.result), [{ output: "plan.md", isError: false }, { output: "no such file", isError: true }]);
    assert.equal(groupStatus(tool.groups[0]!, false), "error");
    assert.equal(groupStatus(tool.groups[1]!, false), "ok");
    assert.equal(groupStatus({ name: "x", calls: [{ name: "x", input: {} }] }, true), "pending");
    assert.equal(groupStatus({ name: "x", calls: [{ name: "x", input: {} }] }, false), "unknown");
  });

  it("marks go before the message at their index — a thread's turn boundaries — and past the end", () => {
    const entries = transcriptToEntries(messages, [
      { at: 5, label: "turn 1", detail: "run 2 · $0.10" },
      { at: 1, label: "turn 0" },
      { at: 99, label: "turn 2" },
    ]);
    assert.deepEqual(
      entries.map((e) => (e.kind === "mark" ? `mark:${e.label}${e.detail ? `:${e.detail}` : ""}` : e.kind)),
      ["mark:turn 0", "user", "text", "tool", "text", "mark:turn 1:run 2 · $0.10", "notice", "text", "mark:turn 2"],
    );
    assert.match(transcriptText(entries), /---\nturn 1 · run 2 · \$0\.10/);
  });

  it("a user message's attachments become chips — the image with its picture — apart from the typed text", () => {
    const content = [
      { type: "text", text: "build this" },
      { type: "text", text: "[attachment] shot (1).png (image/png, 70 B) — saved at /d/uploads/c/shot (1).png" },
      { type: "file", data: "AAAA", mediaType: "image/png", filename: "shot (1).png" },
      { type: "text", text: "[attachment] spec.docx (application/msword, 3 KB) — saved at /d/uploads/c/spec.docx\n\nClip Spec" },
    ];
    const [entry] = transcriptToEntries([{ role: "user", content }]);
    assert.deepEqual(entry, {
      kind: "user",
      content: "build this",
      attachments: [
        { name: "shot (1).png", mediaType: "image/png", size: "70 B", src: "data:image/png;base64,AAAA" },
        { name: "spec.docx", mediaType: "application/msword", size: "3 KB" },
      ],
    });
    assert.equal(
      transcriptText([entry!]),
      "### User\nbuild this\n[attachment] shot (1).png (image/png, 70 B)\n[attachment] spec.docx (application/msword, 3 KB)",
    );
    // Files alone: still a user bubble, never a notice.
    assert.deepEqual(transcriptToEntries([{ role: "user", content: content.slice(3) }])[0]?.kind, "user");
  });

  it("attachResult finds the call from the end and leaves other entries alone", () => {
    const entries = transcriptToEntries(messages.slice(0, 3));
    const { entries: next, call } = attachResult(entries, "c3", { output: 1, isError: false });
    assert.equal(call?.name, "graph_graph_get");
    assert.notEqual(next, entries, "a new array");
    assert.equal(next[0], entries[0], "untouched entries kept");
    assert.deepEqual(attachResult(entries, "nope", { output: 1, isError: false }), { entries, call: null });
  });
});
