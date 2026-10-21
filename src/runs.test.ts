import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "./core.js";
import { RUN_FILE_MAX_BYTES, capEvents, fileResult, listEntryOf, matchesRunFilter, mediaTypeOf, sinceMs } from "./runs.js";

/**
 * The pure parts of the runs capability (src/runs.ts): the list filter,
 * the event cap, the file result. The capability itself — list / get /
 * events / launch / cancel / workflow / files over a strut — is driven
 * through `step_run` in src/apps/tools.test.ts.
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
});
