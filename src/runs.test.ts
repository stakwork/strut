import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "./core.js";
import { RUN_FILE_MAX_BYTES, capEvents, capTranscript, fileResult, listEntryOf, matchesRunFilter, mediaTypeOf, sinceMs } from "./runs.js";

/**
 * The pure parts of the runs capability (src/runs.ts): the list filter,
 * the event cap, the file result, the transcript cap. The capability itself
 * — list / get / events / launch / cancel / workflow / files / transcript
 * over a strut — is driven through `step_run` in src/apps/tools.test.ts;
 * `transcript { full }` on a session thread in src/sessions.test.ts.
 */

const ev = (type: RunEvent["type"], path = "wf", extra: Partial<RunEvent> = {}): RunEvent => ({ ts: "2026-10-21T00:00:00.000Z", runId: "1", path, type, ...extra });

describe("runs — the pure parts", () => {
  it("since reads ISO or ms; the filter matches status, automation, job and since (startedAt, else the run id's moment)", () => {
    assert.equal(sinceMs(undefined), undefined);
    assert.equal(sinceMs(""), undefined);
    assert.equal(sinceMs("garbage"), undefined);
    assert.equal(sinceMs(1700000000000), 1700000000000);
    assert.equal(sinceMs("1700000000000"), 1700000000000);
    assert.equal(sinceMs("2026-10-21T00:00:00.000Z"), Date.parse("2026-10-21T00:00:00.000Z"));
    const run = { runId: "1761000000000", status: "success", startedAt: "2026-10-21T00:00:00.000Z", automation: { id: "a1" }, job: "j1" };
    assert.ok(matchesRunFilter(run, {}));
    assert.ok(matchesRunFilter(run, { status: "success", automation: "a1", job: "j1" }));
    assert.ok(!matchesRunFilter(run, { status: "error" }));
    assert.ok(!matchesRunFilter(run, { automation: "a2" }));
    assert.ok(!matchesRunFilter(run, { job: "j2" }));
    assert.ok(matchesRunFilter(run, { since: "2026-10-20T00:00:00Z" }));
    assert.ok(!matchesRunFilter(run, { since: "2026-10-22T00:00:00Z" }));
    // A live row has no startedAt: the id is its moment.
    assert.ok(matchesRunFilter({ runId: "1761000000000", status: "running" }, { since: 1760999999999 }));
    assert.ok(!matchesRunFilter({ runId: "1761000000000", status: "running" }, { since: 1761000000001 }));
    assert.ok(matchesRunFilter({ runId: "abc", status: "running" }, { since: 1761000000001 }), "an id that is not a moment is not filtered out");
  });

  it("a list row is the summary without its payloads", () => {
    const row = listEntryOf({ runId: "1", workflow: "w", startedAt: "s", finishedAt: "f", durationMs: 1, status: "success", input: { a: 1 }, output: { b: 2 }, stepCounts: { x: 1 }, actor: "me", app: { name: "a", version: "v1" } });
    assert.deepEqual(row, { runId: "1", workflow: "w", startedAt: "s", finishedAt: "f", durationMs: 1, status: "success", actor: "me", app: { name: "a", version: "v1" } });
  });

  it("the event cap keeps the head and the last event, skips what the caller has, and slims long fields", () => {
    const events = [ev("run.start"), ...Array.from({ length: 10 }, (_, i) => ev("step.end", `wf/s${i}`, { output: { i } })), ev("run.end")];
    const capped = capEvents(events, 0, 5);
    assert.equal(capped.length, 5);
    assert.equal(capped[0]!.type, "run.start");
    assert.equal(capped.at(-1)!.type, "run.end", "the terminal event survives the cut");
    assert.equal(capped[3]!.path, "wf/s2");
    const skipped = capEvents(events, 11);
    assert.deepEqual(skipped.map((e) => e.type), ["run.end"]);
    assert.deepEqual(capEvents(events, 100), []);
    const long = capEvents([ev("step.end", "wf/s", { output: { text: "x".repeat(70_000) } })]);
    assert.equal((long[0]!.output as { text: string }).text, "[70000 chars not logged]");
    assert.equal(capEvents(events).length, events.length, "under the cap: whole");
  });

  it("a file comes back as text or base64, typed by extension, cut at the cap", () => {
    assert.equal(mediaTypeOf("a/b/report.md"), "text/markdown");
    assert.equal(mediaTypeOf("shots/001.PNG"), "image/png");
    assert.equal(mediaTypeOf("noext"), "application/octet-stream");
    const text = fileResult("notes.txt", Buffer.from("hello"));
    assert.deepEqual(text, { path: "notes.txt", mediaType: "text/plain", bytes: 5, text: "hello" });
    const bin = fileResult("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    assert.equal(bin.base64, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString("base64"));
    assert.equal(bin.text, undefined);
    const cut = fileResult("big.txt", Buffer.alloc(RUN_FILE_MAX_BYTES + 10, 0x61));
    assert.equal(cut.truncated, true);
    assert.equal(cut.text!.length, RUN_FILE_MAX_BYTES);
    assert.equal(cut.bytes, RUN_FILE_MAX_BYTES + 10);
  });

  it("a transcript comes back whole under the cap; over it, long strings are cut to head and tail, tighter until it fits", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "cat big" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "a".repeat(50_000) + "TAIL" } }] },
      { role: "assistant", content: "done" },
    ];
    const whole = capTranscript(msgs, 1_000_000);
    assert.equal(whole.messages, msgs, "under the cap: the same messages");
    assert.equal(whole.truncated, undefined);

    const chars = JSON.stringify(msgs).length;
    const cut = capTranscript(msgs, 40_000);
    assert.deepEqual(cut.truncated, { chars, strings: 1, stringMax: 16_384 }, "64k did not fit, 16k does");
    assert.ok(JSON.stringify(cut.messages).length <= 40_000);
    const value = (cut.messages[3]!.content as any)[0].output.value as string;
    assert.ok(value.startsWith("a".repeat(8192)) && value.endsWith("TAIL"), "head and tail kept");
    assert.match(value, /…\[33620 chars cut\]…/);
    assert.equal(cut.messages[4]!.content, "done", "short strings untouched");
    assert.equal((msgs[3]!.content as any)[0].output.value.length, 50_004, "the input is not mutated");
  });

  it("when cut strings are not enough, the middle is left out: the system prompt and the task stay, the newest that fit, never a tool result without its call", () => {
    const msgs: Array<{ role: string; content: unknown }> = [{ role: "system", content: "sys" }, { role: "user", content: "the task" }];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "bash", input: { command: `step ${i}` } }] });
      msgs.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "bash", output: { type: "text", value: "x".repeat(3_000) } }] });
    }
    msgs.push({ role: "assistant", content: "the answer" });
    const out = capTranscript(msgs, 30_000);
    assert.ok(JSON.stringify(out.messages).length <= 30_000);
    assert.deepEqual(out.messages.slice(0, 2), msgs.slice(0, 2), "the head stays");
    assert.equal(out.messages.at(-1)!.content, "the answer", "the newest stays");
    assert.equal(out.messages[2]!.role, "assistant", "the kept tail never starts on a tool result");
    const t = out.truncated!;
    assert.equal(t.stringMax, 4_096);
    assert.equal(t.strings, 0, "no string was over 4k");
    assert.equal(t.messages!.at, 2);
    assert.equal(out.messages.length, msgs.length - t.messages!.count);
    assert.ok(t.messages!.count > 0 && t.messages!.count % 2 === 0, "whole call + result pairs left out");
  });
});
