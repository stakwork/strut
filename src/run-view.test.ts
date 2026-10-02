import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent, RunEventType, RunSummary } from "./core.js";
import { buildRunView, foldRun, splitPath, type Gap, type NodeView, type RunView } from "./run-view.js";

/** A log builder with monotonic timestamps. */
function log() {
  let t = Date.parse("2026-10-02T00:00:00Z");
  const events: RunEvent[] = [];
  const ev = (type: RunEventType, path: string, extra: Partial<RunEvent> = {}) => {
    events.push({ ts: new Date((t += 10)).toISOString(), runId: "r", path, type, ...extra });
    return api;
  };
  const api = {
    events,
    start: (path: string, stepType?: string, extra: Partial<RunEvent> = {}) => ev("step.start", path, { stepType, ...extra }),
    end: (path: string, stepType?: string, extra: Partial<RunEvent> = {}) => ev("step.end", path, { stepType, durationMs: 10, ...extra }),
    error: (path: string, stepType: string | undefined, message: string, extra: Partial<RunEvent> = {}) =>
      ev("step.error", path, { stepType, error: { message, stack: `Error: ${message}\n    at x` }, ...extra }),
    ev,
  };
  return api;
}

const summaryOf = (status: RunSummary["status"], extra: Partial<RunSummary> = {}): RunSummary => ({
  runId: "r",
  workflow: "wf",
  startedAt: "2026-10-02T00:00:00Z",
  finishedAt: "2026-10-02T00:01:00Z",
  durationMs: 60_000,
  status,
  input: { q: 1 },
  ...extra,
});

const view = (events: RunEvent[], summary: RunSummary | null, opts = {}) => buildRunView("wf", "r", events, summary, opts) as RunView;
const nodes = (steps: (NodeView | Gap)[]) => steps.filter((s): s is NodeView => "id" in s);
const gaps = (steps: (NodeView | Gap)[]) => steps.filter((s): s is Gap => "omitted" in s);

/** A run whose one agent made `calls` tool calls, call `failAt` (1-based) erroring. */
function agentRun(calls: number, failAt = -1) {
  const l = log();
  const tools = ["bash", "str_replace_based_edit_tool", "fulltext_search", "web_fetch"];
  l.ev("run.start", "wf", { input: { repo: "x" } });
  l.start("wf/agent", "agent", { input: { prompt: "fix it" } });
  for (let i = 1; i <= calls; i++) {
    const tool = tools[i % tools.length]!;
    const path = `wf/agent/${String(i).padStart(3, "0")}-${tool}`;
    l.start(path, `tool:${tool}`, { input: { cmd: `step ${i}` } });
    if (i === failAt) l.error(path, `tool:${tool}`, "command not found");
    else l.end(path, `tool:${tool}`, { output: "y".repeat(1600) });
  }
  l.end("wf/agent", "agent", { output: { result: "done" }, durationMs: 5000 });
  l.ev("run.end", "wf", { output: { result: "done" } });
  return l.events;
}

describe("run-view: the fold", () => {
  it("splits a path into the tree's segments, an iteration under its container", () => {
    assert.deepEqual(splitPath("wf/each#3/a"), ["wf", "each", "#3", "a"]);
    assert.deepEqual(splitPath("wf/agent/042-bash"), ["wf", "agent", "042-bash"]);
    assert.deepEqual(splitPath("wf"), ["wf"]);
  });

  it("folds the runner's path grammar: steps, subflow children, iterations, tool calls, onError", () => {
    const l = log();
    l.ev("run.start", "wf");
    l.start("wf/fetch", "http").end("wf/fetch", "http", { output: { ok: true } });
    l.start("wf/each", "foreach", { input: [1, 2] });
    l.start("wf/each#0", "subflow", { iteration: 0 }).start("wf/each#0/a", "log").end("wf/each#0/a", "log").end("wf/each#0", "subflow", { iteration: 0 });
    l.start("wf/each#1", "subflow", { iteration: 1 }).start("wf/each#1/a", "log").error("wf/each#1/a", "log", "boom").error("wf/each#1", "subflow", "boom");
    l.error("wf/each", "foreach", "boom");
    l.ev("run.error", "wf", { error: { message: "boom" } });
    const root = foldRun(l.events);
    assert.equal(root.path, "wf");
    assert.equal(root.status, "error");
    assert.deepEqual([...root.children.keys()], ["fetch", "each"]);
    const each = root.children.get("each")!;
    assert.deepEqual([...each.children.keys()], ["#0", "#1"]);
    assert.equal(each.children.get("#1")!.path, "wf/each#1");
    assert.equal(each.children.get("#1")!.children.get("a")!.path, "wf/each#1/a");
    assert.equal(each.children.get("#1")!.iteration, 1);
    assert.equal(each.children.get("#0")!.status, "success");
    assert.equal(each.children.get("#1")!.children.get("a")!.status, "error");
  });

  it("counts retries, and a step whose onError fallback succeeded is recovered", () => {
    const l = log();
    l.ev("run.start", "wf");
    l.start("wf/flaky", "http").ev("step.retry", "wf/flaky", { stepType: "http", iteration: 1 }).start("wf/flaky", "http").end("wf/flaky", "http");
    l.start("wf/risky", "http").start("wf/risky/onError", "log").end("wf/risky/onError", "log", { output: "fallback" });
    l.ev("run.end", "wf");
    const root = foldRun(l.events);
    assert.equal(root.children.get("flaky")!.retries, 1);
    assert.equal(root.children.get("flaky")!.status, "success");
    assert.equal(root.children.get("risky")!.status, "recovered");
  });

  it("a step still open is running while the run is, incomplete once the run is over", () => {
    const l = log();
    l.ev("run.start", "wf");
    l.start("wf/slow", "agent");
    assert.equal(foldRun(l.events).children.get("slow")!.status, "running");
    const cut = view(l.events, summaryOf("cancelled"));
    assert.equal(nodes(cut.steps)[0]!.status, "incomplete", "the summary says the run is over");
    assert.equal(cut.status, "cancelled");
    l.ev("run.cancelled", "wf");
    assert.equal(foldRun(l.events).children.get("slow")!.status, "incomplete");
  });
});

describe("run-view: the view", () => {
  it("lists the top level with everything below rolled up — an agent's calls are a histogram", () => {
    const v = view(agentRun(1000, 500), summaryOf("success", { output: { result: "done" } }));
    assert.equal(v.status, "success");
    assert.equal(v.steps.length, 1);
    const agent = nodes(v.steps)[0]!;
    assert.equal(agent.id, "agent");
    assert.equal(agent.status, "success");
    assert.equal(agent.durationMs, 5000);
    assert.equal(agent.input, undefined, "no payloads on a listed node by default");
    assert.deepEqual(agent.children!.status, { success: 999, error: 1 });
    assert.equal(agent.children!.count, 1000);
    assert.equal(agent.children!.nodes, undefined, "one level deep: no separate descendant count");
    assert.equal(agent.children!.byType!["tool:bash"]!.n, 250);
    assert.equal(agent.children!.byType!["tool:bash"]!.errors, 1);
    assert.deepEqual(agent.children!.last, ["996-bash", "997-str_replace_based_edit_tool", "998-fulltext_search", "999-web_fetch", "1000-bash"]);
    const size = JSON.stringify(v).length;
    assert.ok(size < 3000, `the root view of a 1000-call run is ${size} chars`);
    assert.equal(v.hint, undefined, "nothing was cut");
  });

  it("errors come first, the deepest only, the run's failure chain on top, each with the siblings before it", () => {
    const l = log();
    l.ev("run.start", "wf");
    l.start("wf/agent", "agent");
    l.start("wf/agent/001-bash", "tool:bash").end("wf/agent/001-bash", "tool:bash", { durationMs: 7 });
    l.start("wf/agent/002-bash", "tool:bash").error("wf/agent/002-bash", "tool:bash", "exit 1");
    l.start("wf/agent/003-bash", "tool:bash").end("wf/agent/003-bash", "tool:bash");
    l.end("wf/agent", "agent", { output: "ok" });
    l.start("wf/deploy", "subflow");
    l.start("wf/deploy/push", "git/push").error("wf/deploy/push", "git/push", "push_rejected: no");
    l.error("wf/deploy", "subflow", "push_rejected: no");
    l.ev("run.error", "wf", { error: { message: "push_rejected: no" } });
    const v = view(l.events, summaryOf("error", { error: { message: "push_rejected: no" } }));
    assert.deepEqual(
      v.errors!.map((e) => e.path),
      ["wf/deploy/push", "wf/agent/002-bash"],
      "the propagated wf/deploy is not listed; the chain error leads",
    );
    assert.deepEqual(v.errors![1]!.before, [{ id: "001-bash", stepType: "tool:bash", status: "success", durationMs: 7 }]);
    assert.equal(v.errors![0]!.before, undefined, "first in its container: nothing before it");
    assert.equal(v.summary.error, "push_rejected: no");
    assert.deepEqual(
      nodes(v.steps).map((s) => [s.id, s.status]),
      [
        ["agent", "success"],
        ["deploy", "error"],
      ],
    );
  });

  it("zooms with `path`: the node is the focus with payloads and stack, its children listed", () => {
    const events = agentRun(5, 3);
    const v = view(events, summaryOf("success"), { path: "wf/agent" });
    assert.equal(v.focus!.path, "wf/agent");
    assert.deepEqual(v.focus!.input, { prompt: "fix it" });
    assert.deepEqual(v.focus!.output, { result: "done" });
    assert.equal(v.focus!.children!.count, 5);
    assert.deepEqual(
      nodes(v.steps).map((s) => s.id),
      ["001-str_replace_based_edit_tool", "002-fulltext_search", "003-web_fetch", "004-bash", "005-str_replace_based_edit_tool"],
    );
    assert.equal(nodes(v.steps)[0]!.output, undefined, "listed children carry no payloads by default");

    const leaf = view(events, summaryOf("success"), { path: "wf/agent/003-web_fetch" });
    assert.equal(leaf.focus!.status, "error");
    assert.equal(leaf.focus!.error, "command not found");
    assert.match(leaf.focus!.stack!, /^Error: command not found/);
    assert.deepEqual(leaf.focus!.input, { cmd: "step 3" });
    assert.deepEqual(leaf.steps, []);

    const top = view(events, summaryOf("success"), { path: "wf" });
    assert.equal(top.focus, undefined, "the root path is the default view");
  });

  it("an unknown path names the top-level paths", () => {
    const r = buildRunView("wf", "r", agentRun(2), summaryOf("success"), { path: "wf/nope" });
    assert.match((r as { error: string }).error, /No events at path "wf\/nope".*Top-level paths: wf\/agent/);
  });

  it("fullEvents puts payload previews on every listed node, cut to the level's cap", () => {
    const v = view(agentRun(3), summaryOf("success"), { path: "wf/agent", fullEvents: true });
    const first = nodes(v.steps)[0]!;
    assert.deepEqual(first.input, { cmd: "step 1" });
    assert.ok(typeof first.output === "string" && first.output.endsWith("…[cut: 1600 chars]"), "cut at the listed cap, the total named");
    assert.equal(first.output.length, 1500 + "…[cut: 1600 chars]".length);
    assert.ok(v.hint, "a cut preview says how to see more");
  });

  it("a long list keeps its head, its tail and every error, with gaps between", () => {
    const v = view(agentRun(1000, 500), summaryOf("success"), { path: "wf/agent" });
    const listed = nodes(v.steps);
    assert.equal(listed.length, 41, "20 head + 20 tail + the one error");
    assert.equal(listed[0]!.id, "001-str_replace_based_edit_tool");
    assert.equal(listed[20]!.id, "500-bash");
    assert.equal(listed[20]!.status, "error");
    assert.equal(listed[40]!.id, "1000-bash");
    const g = gaps(v.steps);
    assert.equal(g.length, 2);
    assert.equal(g[0]!.omitted + g[1]!.omitted, 959);
    assert.deepEqual(g[0], { omitted: 479, from: "021-str_replace_based_edit_tool", to: "499-web_fetch" });
    assert.ok(v.hint);
    assert.ok(JSON.stringify(v).length < 20_000);
  });

  it("tightens lists and previews to the budget and says so", () => {
    const events = agentRun(1000, 500);
    const loose = view(events, summaryOf("success"), { path: "wf/agent" });
    const tight = view(events, summaryOf("success"), { path: "wf/agent", maxChars: 2500 });
    assert.ok(JSON.stringify(tight).length < JSON.stringify(loose).length);
    assert.ok(nodes(tight.steps).length < nodes(loose.steps).length);
    assert.ok(nodes(tight.steps).some((s) => s.id === "500-bash"), "an error is never dropped from the list");
    assert.match(tight.hint!, /tightened to fit 2500 chars/);
    assert.match(loose.hint!, /^Some previews or lists are cut/);
  });

  it("caps the errors list and reports the total", () => {
    const l = log();
    l.ev("run.start", "wf");
    l.start("wf/each", "foreach");
    for (let i = 0; i < 30; i++) l.start(`wf/each#${i}`, "http", { iteration: i }).error(`wf/each#${i}`, "http", `boom ${i}`, { iteration: i });
    l.error("wf/each", "foreach", "boom");
    l.ev("run.error", "wf", { error: { message: "boom" } });
    const v = view(l.events, summaryOf("error"));
    assert.equal(v.errors!.length, 15);
    assert.equal(v.errorCount, 30);
    assert.equal(v.errors![0]!.path, "wf/each#0");
    assert.deepEqual(nodes(v.steps)[0]!.children!.status, { error: 30 });
    assert.ok(v.hint);
  });

  it("previews the summary's input and output", () => {
    const v = view(agentRun(1), summaryOf("success", { output: { text: "z".repeat(5000) }, actor: "ann", job: "j1" }));
    assert.deepEqual(v.summary.input, { q: 1 });
    assert.ok(typeof v.summary.output === "string" && v.summary.output.endsWith("…[cut: 5011 chars]"));
    assert.equal(v.summary.actor, "ann");
    assert.equal(v.summary.job, "j1");
    const full = view(agentRun(1), summaryOf("success", { output: { text: "z".repeat(5000) } }), { fullEvents: true });
    assert.deepEqual(full.summary.output, { text: "z".repeat(5000) }, "fullEvents raises the summary cap");
  });

  it("a run with no summary yet is partial, with what the log knows", () => {
    const l = log();
    l.ev("run.start", "wf", { input: { a: 1 } });
    l.start("wf/a", "http");
    const v = view(l.events, null);
    assert.equal(v.status, "running");
    assert.equal(v.summary.partial, true);
    assert.deepEqual(v.summary.input, { a: 1 });
    assert.ok(v.summary.lastEventAt);
    assert.equal(nodes(v.steps)[0]!.status, "running");
    assert.ok(nodes(v.steps)[0]!.elapsedMs! >= 0);
  });

  it("never carries an agent transcript at any zoom", () => {
    const l = log();
    l.ev("run.start", "wf");
    l.start("wf/agent", "agent").end("wf/agent", "agent", { output: "ok", messages: [{ role: "user", content: "secret-transcript" }] } as Partial<RunEvent>);
    l.ev("run.end", "wf");
    for (const opts of [{}, { fullEvents: true }, { path: "wf/agent", fullEvents: true }]) {
      assert.ok(!JSON.stringify(view(l.events, summaryOf("success"), opts)).includes("secret-transcript"));
    }
  });
});
