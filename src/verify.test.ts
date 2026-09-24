/**
 * The verify pass's pure parts (plans/claims.md §4): what a run observed,
 * what a check run says, when a check fires, what it cost. The pass itself
 * runs against a live graph in `src/graph/verify.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "./core.js";
import type { EvidenceRow } from "./graph/claims.js";
import { mapCheckResult, policyFires, reportedCost, sampleFires, subjectsOfRun } from "./verify.js";

let tick = 0;
const ev = (type: RunEvent["type"], path: string, extra: Partial<RunEvent> = {}): RunEvent => ({
  ts: new Date(Date.UTC(2026, 8, 17, 12, 0, tick++)).toISOString(),
  runId: "r1",
  path,
  type,
  ...extra,
});

describe("subjectsOfRun", () => {
  it("a step is its step.start.input + step.end.output, at the version recorded on run.start", () => {
    const events = [
      ev("run.start", "wf", { input: { url: "u" }, params: { lang: "en" }, workflowHash: "wfhash", stepHashes: { "clip/fetch": "aaa" }, cassette: "replay" }),
      ev("step.start", "wf/fetch", { stepType: "clip/fetch", input: { url: "u", langs: ["en"] } }),
      ev("step.end", "wf/fetch", { stepType: "clip/fetch", output: { captions: 1 } }),
      ev("step.start", "wf/note", { stepType: "log", input: { message: "hi" } }),
      ev("step.end", "wf/note", { stepType: "log", output: "hi" }),
      ev("run.end", "wf", { output: { ok: true } }),
    ];
    const [fetch, note, wf] = subjectsOfRun("wf", events);
    assert.deepEqual(fetch, {
      subject: { kind: "step", type: "clip/fetch" },
      version: "aaa",
      path: "wf/fetch",
      at: events[2]!.ts,
      check: { runId: "r1", cassette: "replay", input: { url: "u", langs: ["en"] }, path: "wf/fetch", output: { captions: 1 } },
    });
    assert.deepEqual([note!.subject, note!.version], [{ kind: "step", type: "log" }, undefined], "a built-in has no recorded version → never evidence");
    assert.deepEqual(wf, {
      subject: { kind: "workflow", name: "wf" },
      version: "wfhash",
      path: "wf",
      at: events[5]!.ts,
      check: { runId: "r1", cassette: "replay", input: { url: "u" }, params: { lang: "en" }, path: "wf", output: { ok: true } },
    });
  });

  it("a pinned step's subject version is its step.start.stepVersion, not the active hash on run.start", () => {
    const events = [
      ev("run.start", "wf", { stepHashes: { "clip/fetch": "active" } }),
      ev("step.start", "wf/old", { stepType: "clip/fetch", input: {}, stepVersion: { version: "v1", hash: "pinned" } }),
      ev("step.end", "wf/old", { stepType: "clip/fetch", output: 1 }),
      ev("step.start", "wf/now", { stepType: "clip/fetch", input: {} }),
      ev("step.end", "wf/now", { stepType: "clip/fetch", output: 2 }),
      ev("run.end", "wf", { output: null }),
    ];
    const [old, now] = subjectsOfRun("wf", events);
    assert.deepEqual([old!.subject, old!.version], [{ kind: "step", type: "clip/fetch" }, "pinned"]);
    assert.deepEqual([now!.subject, now!.version], [{ kind: "step", type: "clip/fetch" }, "active"]);
  });

  it("a foreach yields one subject per iteration; containers and agent tool calls yield none", () => {
    const events = [
      ev("run.start", "wf", { stepHashes: { "clip/cut": "ccc" } }),
      ev("step.start", "wf/each", { stepType: "foreach", input: [1, 2] }),
      ev("step.start", "wf/each#0", { stepType: "clip/cut", input: { i: 0 }, iteration: 0 }),
      ev("step.end", "wf/each#0", { stepType: "clip/cut", output: "a" }),
      ev("step.start", "wf/each#1", { stepType: "clip/cut", input: { i: 1 }, iteration: 1 }),
      ev("step.end", "wf/each#1", { stepType: "clip/cut", output: "b" }),
      ev("step.end", "wf/each", { stepType: "foreach", output: ["a", "b"] }),
      ev("step.start", "wf/plan/001-clip_cut", { stepType: "tool:clip_cut", input: {} }),
      ev("step.end", "wf/plan/001-clip_cut", { stepType: "tool:clip_cut", output: "truncated…" }),
      ev("run.end", "wf", { output: 1 }),
    ];
    const steps = subjectsOfRun("wf", events).filter((o) => o.subject.kind === "step");
    assert.deepEqual(steps.map((o) => [o.path, o.check.output, o.version]), [["wf/each#0", "a", "ccc"], ["wf/each#1", "b", "ccc"]]);
  });

  it("an errored step yields { input, error } with no output; a replayed step yields nothing", () => {
    const events = [
      ev("run.start", "wf", { stepHashes: { "clip/fetch": "aaa" } }),
      ev("step.replayed", "wf/cached", { stepType: "clip/fetch", output: "old" }),
      ev("step.start", "wf/fetch", { stepType: "clip/fetch", input: { url: "private" } }),
      ev("step.error", "wf/fetch", { stepType: "clip/fetch", error: { message: "video is private" } }),
      ev("run.error", "wf", { error: { message: "video is private" } }),
    ];
    const [fetch, wf] = subjectsOfRun("wf", events);
    assert.deepEqual(fetch!.check, { runId: "r1", input: { url: "private" }, path: "wf/fetch", error: { message: "video is private" } });
    assert.ok(!("output" in fetch!.check));
    assert.deepEqual([wf!.subject, wf!.check.error], [{ kind: "workflow", name: "wf" }, { message: "video is private" }]);
    assert.equal(subjectsOfRun("wf", events).length, 2);
  });

  it("a subflow step is an execution of the CHILD workflow, at the nested path and the hash recorded when it ran", () => {
    const events = [
      ev("run.start", "gaia-run", { workflowHash: "outer", stepHashes: { "gaia/answer": "sss" } }),
      ev("step.start", "gaia-run/produce", { stepType: "subflow", input: { q: "?" }, subflow: { workflow: "gaia-produce", hash: "inner" } }),
      ev("step.start", "gaia-run/produce/answer", { stepType: "gaia/answer", input: { q: "?" } }),
      ev("step.end", "gaia-run/produce/answer", { stepType: "gaia/answer", output: { answer: "42" } }),
      ev("step.end", "gaia-run/produce", { stepType: "subflow", output: { answer: "42" } }),
      ev("step.start", "gaia-run/legacy", { stepType: "subflow", input: {} }),
      ev("step.end", "gaia-run/legacy", { stepType: "subflow", output: 1 }),
      ev("run.end", "gaia-run", { output: { answer: "42" } }),
    ];
    const subjects = subjectsOfRun("gaia-run", events);
    assert.deepEqual(
      subjects.map((o) => [o.subject.kind, o.subject.kind === "step" ? o.subject.type : o.subject.name, o.path, o.version]),
      [
        ["step", "gaia/answer", "gaia-run/produce/answer", "sss"],
        ["workflow", "gaia-produce", "gaia-run/produce", "inner"],
        ["workflow", "gaia-run", "gaia-run", "outer"],
      ],
      "a subflow with no recorded child (a run from before this change) yields nothing",
    );
    assert.deepEqual(subjects[1]!.check.input, { q: "?" });
  });

  it("a resume reloads steps: later executions carry run.resumed's hashes; a single-step bucket has no workflow subject", () => {
    const events = [
      ev("run.start", "wf", { workflowHash: "w", stepHashes: { "clip/a": "v1" } }),
      ev("step.start", "wf/one", { stepType: "clip/a", input: 1 }),
      ev("step.end", "wf/one", { stepType: "clip/a", output: 1 }),
      ev("run.error", "wf", { error: { message: "crash" } }),
      ev("run.resumed", "wf", { stepHashes: { "clip/a": "v2" } }),
      ev("step.replayed", "wf/one", { stepType: "clip/a", output: 1 }),
      ev("step.start", "wf/two", { stepType: "clip/a", input: 2 }),
      ev("step.end", "wf/two", { stepType: "clip/a", output: 2 }),
      ev("run.end", "wf", { output: 2 }),
    ];
    const subjects = subjectsOfRun("wf", events);
    assert.deepEqual(subjects.filter((o) => o.subject.kind === "step").map((o) => [o.path, o.version]), [["wf/one", "v1"], ["wf/two", "v2"]]);
    assert.deepEqual(subjects.at(-1)!.check.output, 2, "the workflow subject reads the LAST terminal event");

    const single = [
      ev("run.start", "__run_step__", { stepHashes: { "clip/a": "v1" } }),
      ev("step.start", "__run_step__/step", { stepType: "clip/a", input: {} }),
      ev("step.end", "__run_step__/step", { stepType: "clip/a", output: 1 }),
      ev("run.end", "__run_step__", { output: 1 }),
    ];
    assert.deepEqual(subjectsOfRun("step:clip/a", single).map((o) => o.subject), [{ kind: "step", type: "clip/a" }]);
    assert.deepEqual(subjectsOfRun("wf", []), []);
  });
});

describe("mapCheckResult — the check contract", () => {
  const ok = (output: unknown) => ({ status: "success" as const, output });

  it("{ supports, content, locator? } — directly, under `object` (agent + schema), or under `json` (exec parseJson)", () => {
    assert.deepEqual(mapCheckResult("clip/judge", ok({ supports: true, content: "found at 12s", locator: { start_time: 12, end_time: 31 } })), {
      kind: "evidence", supports: true, content: "found at 12s", locator: { start_time: 12, end_time: 31 },
    });
    assert.deepEqual(mapCheckResult("agent", ok({ result: "…", object: { supports: false, content: "trailing period" }, cost: 0.01 })), { kind: "evidence", supports: false, content: "trailing period" });
    assert.deepEqual(mapCheckResult("exec", ok({ code: 0, stdout: "{}", stderr: "", json: { supports: true, content: "ok" } })), { kind: "evidence", supports: true, content: "ok" });
    assert.deepEqual(mapCheckResult("subflow", ok({ supports: true, content: { score: 0.93 } })), { kind: "evidence", supports: true, content: '{"score":0.93}' }, "non-string content is kept, as JSON");
  });

  it("a bare exec maps from its exit code; JSON on stdout wins when it is a verdict", () => {
    assert.deepEqual(mapCheckResult("exec", ok({ code: 0, stdout: "duration ok\n", stderr: "" })), { kind: "evidence", supports: true, content: "duration ok" });
    assert.deepEqual(mapCheckResult("exec", ok({ code: 1, stdout: "", stderr: "end 120 > duration 95\n" })), { kind: "evidence", supports: false, content: "end 120 > duration 95" });
    assert.deepEqual(mapCheckResult("exec", ok({ code: 0, stdout: "", stderr: "" })), { kind: "evidence", supports: true, content: "exit 0" });
    assert.deepEqual(mapCheckResult("exec", ok({ code: 3, stdout: '{"supports": true, "content": "stdout verdict"}', stderr: "" })), { kind: "evidence", supports: true, content: "stdout verdict" });
    assert.deepEqual(mapCheckResult("exec", ok({ code: 0, stdout: '{"segments": []}', stderr: "" })), { kind: "evidence", supports: true, content: '{"segments": []}' }, "JSON that is not a verdict is just output");
    // Shape, not type: a `subflow` check whose child ENDS in an exec reads the same way.
    assert.deepEqual(mapCheckResult("subflow", ok({ code: 0, stdout: '{"supports": false, "content": "quote not found"}\n', stderr: "", cwd: "/x", durationMs: 3, truncated: false })), { kind: "evidence", supports: false, content: "quote not found" });
    assert.deepEqual(mapCheckResult("subflow", ok({ code: 2, stdout: "", stderr: "mismatch", cwd: "/x" })), { kind: "evidence", supports: false, content: "mismatch" });
  });

  it("a check that CANNOT run is never a verdict: nothing is written, the claim stays unknown", () => {
    assert.deepEqual(mapCheckResult("exec", ok({ code: 127, stdout: "", stderr: "ffprobe: command not found" })), { kind: "cannot-run", reason: "exit 127: ffprobe: command not found" });
    assert.equal(mapCheckResult("exec", ok({ code: 126, stdout: "", stderr: "" })).kind, "cannot-run");
    assert.deepEqual(mapCheckResult("exec", ok({ code: null, stdout: "", stderr: "" })), { kind: "cannot-run", reason: "the check process was killed" });
    assert.deepEqual(mapCheckResult("clip/judge", { status: "error", error: { message: "app never booted" } }), { kind: "cannot-run", reason: "app never booted" });
    assert.equal(mapCheckResult("clip/judge", { status: "cancelled" }).kind, "cannot-run");
    assert.deepEqual(mapCheckResult("llm", ok({ text: "looks fine to me" })), { kind: "cannot-run", reason: "the check returned no { supports, content }" });
    assert.equal(mapCheckResult("clip/judge", ok({ supports: "yes", content: "x" })).kind, "cannot-run", "supports must be a boolean");
  });

  it("content is one bounded string", () => {
    const long = mapCheckResult("x", ok({ supports: true, content: "a".repeat(5000) }));
    assert.ok(long.kind === "evidence" && long.content.length === 500 && long.content.endsWith("…"));
    const tailed = mapCheckResult("exec", ok({ code: 1, stdout: "", stderr: `${"noise ".repeat(500)}THE REAL ERROR` }));
    assert.ok(tailed.kind === "evidence" && tailed.content.length === 500 && tailed.content.endsWith("THE REAL ERROR"), "an exec's TAIL is what says why");
  });
});

describe("policy", () => {
  const NOW = Date.UTC(2026, 8, 17);
  const collected = (over: Partial<EvidenceRow> & { checkVersion?: string; daysAgo?: number } = {}): EvidenceRow => ({
    ref_id: "r", id: "e", name: "n", claim_id: "c", check_id: "k", evidence_status: "collected", strength: 1,
    observed_at: Math.trunc(NOW / 1000) - (over.daysAgo ?? 0) * 86_400,
    about: { kind: "step", name: "clip/a", content_hash: "v2" },
    source: { ref_id: "run", run_id: "r0", context: { checkVersion: over.checkVersion ?? "exec" } },
    ...over,
  });
  const fires = (policy: string | undefined, evidence: EvidenceRow[], over: Partial<Parameters<typeof policyFires>[0]> = {}, check: Record<string, unknown> = {}) =>
    policyFires({ check: { id: "k", policy, ...check }, evidence, version: "v2", checkVersion: "exec", runId: "r1", path: "wf/a", explicit: false, now: NOW, ...over });

  it("always fires on every run; manual only when asked", () => {
    assert.equal(fires("always", [collected()]), true);
    assert.equal(fires(undefined, [collected()]), true, "no policy = always");
    assert.equal(fires("manual", []), false);
    assert.equal(fires("manual", [], { explicit: true }), true);
  });

  it("on_change: no evidence, a new subject version, a republished check, or stale evidence — read from THAT check's evidence", () => {
    assert.equal(fires("on_change", []), true, "never checked");
    assert.equal(fires("on_change", [collected()]), false, "same version, same instrument, fresh");
    assert.equal(fires("on_change", [collected()], { version: "v3" }), true, "the subject moved on");
    assert.equal(fires("on_change", [collected({ checkVersion: "fuzzy@h1" })], { checkVersion: "fuzzy@h2" }), true, "the check's own code changed under a frozen node");
    assert.equal(fires("on_change", [collected({ daysAgo: 8 })]), true, "older than the default 7 days — environment drift");
    assert.equal(fires("on_change", [collected({ daysAgo: 8 })], {}, { freshness_days: 30 }), false);
    assert.equal(fires("on_change", [collected({ daysAgo: 2 })], {}, { freshness_days: 1 }), true);
    // The NEWEST evidence decides, whatever order it arrives in.
    assert.equal(fires("on_change", [collected({ daysAgo: 20, about: { kind: "step", name: "clip/a", content_hash: "v1" } }), collected()]), false);
    assert.equal(fires("weekly", [collected()]), false, "an unknown policy reads as the careful one");
  });

  it("sample is a fraction of runs, and deterministic per (check, run, path) so a re-verify samples the same way", () => {
    assert.equal(sampleFires("k", "r1", "p", 1), true);
    assert.equal(sampleFires("k", "r1", "p", 0), false);
    const hits = Array.from({ length: 2000 }, (_, i) => sampleFires("k", `run-${i}`, "p", 0.25)).filter(Boolean).length;
    assert.ok(hits > 400 && hits < 600, `~25% of runs, got ${hits}/2000`);
    for (const id of ["a", "b", "c"]) assert.equal(sampleFires("k", id, "p", 0.5), sampleFires("k", id, "p", 0.5));
    assert.equal(fires("sample", [], {}, { sample_rate: 1 }), true);
    assert.equal(fires("sample", [], {}, {}), false, "no rate = never");
  });
});

describe("reportedCost", () => {
  it("sums `cost` from step outputs — not from containers (a subflow's output IS its last step's) or tool calls", () => {
    const events = [
      ev("run.start", "__run_step__"),
      ev("step.end", "__run_step__/step/judge", { stepType: "agent", output: { object: { supports: true }, cost: 0.4 } }),
      ev("step.end", "__run_step__/step/judge/001-web", { stepType: "tool:web_search", output: { cost: 9 } }),
      ev("step.end", "__run_step__/step/note", { stepType: "log", output: "no cost here" }),
      ev("step.end", "__run_step__/step", { stepType: "subflow", output: { object: { supports: true }, cost: 0.4 } }),
      ev("step.end", "__run_step__/x", { stepType: "clip/judge", output: { cost: "free" } }),
    ];
    assert.equal(reportedCost(events), 0.4);
    assert.equal(reportedCost([]), 0);
  });
});
